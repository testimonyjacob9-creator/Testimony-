'use strict';
// Free web-service mode: health endpoint, port config, backup/restore. All mocked or on temp files: no WhatsApp, no Gemini, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadConfig } = require('../src/config');
const { createHealthServer } = require('../src/http/health');
const { openDatabase } = require('../src/storage/db');
const { exportSnapshot, validateSnapshot, restoreInPlace } = require('../src/backup/snapshot');
const { Assistant } = require('../src/assistant');
const { MockProvider } = require('../src/providers/mock');
const { getPause } = require('../src/tasks/pause');

const OWNER = '2347065702702';
const req = (port, method, p) => new Promise((resolve, reject) => { const r = http.request({ port, host: '127.0.0.1', method, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers })); }); r.on('error', reject); r.end(); });

test('config: PORT is optional, validated, and enables nothing else', () => {
  assert.equal(loadConfig({ OWNER_PHONE: OWNER }).port, null);
  assert.equal(loadConfig({ OWNER_PHONE: OWNER, PORT: '10000' }).port, 10000);
  for (const bad of ['abc', '0', '70000', '1.5']) assert.throws(() => loadConfig({ OWNER_PHONE: OWNER, PORT: bad }), /PORT must be/);
  assert.equal(loadConfig({ OWNER_PHONE: OWNER, EPHEMERAL_OK: 'true' }).ephemeralOk, true);
  assert.equal(loadConfig({ OWNER_PHONE: OWNER }).ephemeralOk, false);
});

test('health: GET/HEAD /health return 200 with a constant body; everything else is refused; nothing sensitive is exposed', async () => {
  const h = createHealthServer({ port: 0, host: '127.0.0.1' }); const port = await h.start();
  try {
    const g = await req(port, 'GET', '/health');
    assert.equal(g.status, 200); assert.equal(g.body, '{"status":"ok"}'); assert.equal(g.headers['cache-control'], 'no-store');
    assert.equal((await req(port, 'GET', '/health?x=1')).status, 200);
    const hd = await req(port, 'HEAD', '/health'); assert.equal(hd.status, 200); assert.equal(hd.body, '');
    assert.equal((await req(port, 'GET', '/')).status, 404);
    assert.equal((await req(port, 'GET', '/data/auth_state/creds.json')).status, 404);
    assert.equal((await req(port, 'POST', '/health')).status, 405);
    assert.doesNotMatch(g.body, /\d{8,}|whatsapp|owner|key/i);
  } finally { await h.stop(); }
});

test('health: binds all interfaces by default (required by Render) and reports a port clash instead of hanging', async () => {
  const a = createHealthServer({ port: 0 }); const port = await a.start();
  assert.equal(a.server.address().address === '::' || a.server.address().address === '0.0.0.0', true);
  const b = createHealthServer({ port });
  await assert.rejects(b.start(), (e) => e.code === 'EADDRINUSE');
  await a.stop();
});

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-')); const db = openDatabase(path.join(dir, 'assistant.sqlite'));
  const provider = new MockProvider(); provider.selfJidValue = `${OWNER}@s.whatsapp.net`;
  const config = loadConfig({ OWNER_PHONE: OWNER, DATA_DIR: dir, EPHEMERAL_OK: 'true' });
  const a = new Assistant({ db, provider, config });
  a.start();
  return { dir, db, provider, a, ownerJid: a.ownerJid };
}

test('/backup sends the owner a valid SQLite document to their own chat only, and cleans up its temp file', async () => {
  const { db, provider, a } = world(); await provider.connect();
  db.prepare("INSERT INTO properties (ref, title, status, received_at, updated_at) VALUES ('PROP-900','Test flat','available', datetime('now'), datetime('now'))").run();
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('olives-')).length;
  const reply = await a.process('/backup');
  const doc = provider.sent.find((m) => m.document);
  assert.ok(doc, 'document sent'); assert.equal(doc.jid, a.ownerJid); assert.match(doc.document.fileName, /^olives-backup-\d{4}-\d{2}-\d{2}\.sqlite$/);
  assert.equal(doc.document.content.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.match(reply, /Backup sent/); assert.match(reply, /NOT include photos/);
  assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('olives-')).length, before, 'temp file removed');
});

test('/backup reports failure honestly when WhatsApp is not connected', async () => {
  const { provider, a } = world();
  const reply = await a.process('/backup');
  assert.match(reply, /could not send the backup/i); assert.equal(provider.sent.length, 0);
});

test('restore: upload -> draft with NO change yet -> "no" cancels -> "yes" replaces data, pauses automation, keeps a safety copy', async () => {
  const { dir, db, provider, a } = world(); await provider.connect();
  db.prepare("INSERT INTO properties (ref, title, status, received_at, updated_at) VALUES ('PROP-001','Old flat','available', datetime('now'), datetime('now'))").run();
  const snap = exportSnapshot(db); const bytes = fs.readFileSync(snap);
  db.prepare("DELETE FROM properties").run();
  db.prepare("INSERT INTO properties (ref, title, status, received_at, updated_at) VALUES ('PROP-777','Newer flat','available', datetime('now'), datetime('now'))").run();
  const upload = () => provider.simulateInbound({ from: OWNER, chat: a.ownerJid, text: '/restore', media: { type: 'document', mime: 'application/x-sqlite3', size: bytes.length, fileName: 'b.sqlite', open: async () => (async function* () { yield bytes; })() } });
  await upload();
  let last = provider.sent[provider.sent.length - 1].text;
  assert.match(last, /Restore from backup/); assert.match(last, /NOT restored yet/);
  assert.deepEqual(db.prepare('SELECT ref FROM properties').all().map((r) => r.ref), ['PROP-777'], 'nothing changed before confirmation');
  await a.process('no');
  assert.deepEqual(db.prepare('SELECT ref FROM properties').all().map((r) => r.ref), ['PROP-777']);
  await upload(); await a.process('yes');
  assert.deepEqual(db.prepare('SELECT ref FROM properties').all().map((r) => r.ref), ['PROP-001']);
  assert.equal(getPause(db, new Date()).paused, true, 'automation paused after restore');
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('pre-restore-')), 'safety copy kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM property_media').get().n, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('restore: non-owner uploads, junk files and corrupted files are rejected without touching data', async () => {
  const { db, provider, a } = world(); await provider.connect();
  db.prepare("INSERT INTO properties (ref, title, status, received_at, updated_at) VALUES ('PROP-001','Keep me','available', datetime('now'), datetime('now'))").run();
  const junk = Buffer.from('definitely not sqlite '.repeat(60));
  await provider.simulateInbound({ from: OWNER, chat: a.ownerJid, text: '/restore', media: { type: 'document', mime: 'text/plain', size: junk.length, open: async () => (async function* () { yield junk; })() } });
  assert.match(provider.sent[provider.sent.length - 1].text, /did not use that file/);
  const good = fs.readFileSync(exportSnapshot(db)); const bad = Buffer.from(good); for (let i = 4096; i < Math.min(bad.length, 8192); i++) bad[i] = 0xff;
  const v = validateSnapshot((() => { const f = path.join(os.tmpdir(), `olives-t-${Date.now()}.sqlite`); fs.writeFileSync(f, bad); return f; })(), 99);
  assert.equal(v.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 1);
  const before = provider.sent.length;
  await provider.simulateInbound({ from: '2348000000000', chat: '2348000000000@s.whatsapp.net', text: '/restore', media: { type: 'document', mime: 'application/x-sqlite3', size: good.length, open: async () => (async function* () { yield good; })() } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind='db_restore'").get().n, 0, 'a stranger cannot start a restore');
  assert.ok(provider.sent.length >= before);
});

test('restore: a failure part-way rolls everything back (current data is never half-replaced)', () => {
  const { db } = world();
  db.prepare("INSERT INTO properties (ref, title, status, received_at, updated_at) VALUES ('PROP-001','Current','available', datetime('now'), datetime('now'))").run();
  const snap = exportSnapshot(db);
  const { DatabaseSync } = require('node:sqlite'); const s = new DatabaseSync(snap);
  s.exec("PRAGMA foreign_keys = OFF; INSERT INTO schedules (id, property_id, destination, kind, time_local, start_date, timezone, status, created_at, updated_at) VALUES (999, 424242, 'status', 'daily', '08:00', '2026-10-16', 'Africa/Lagos', 'active', datetime('now'), datetime('now'))"); s.close(); // dangling reference
  db.prepare("INSERT INTO properties (ref, title, status, received_at, updated_at) VALUES ('PROP-002','Added later','available', datetime('now'), datetime('now'))").run();
  const r = restoreInPlace(db, snap);
  assert.equal(r.ok, false);
  assert.deepEqual(db.prepare('SELECT ref FROM properties ORDER BY id').all().map((x) => x.ref), ['PROP-001', 'PROP-002']);
});

test('/status says storage is temporary when EPHEMERAL_OK is set', async () => {
  const { a } = world();
  assert.match(await a.process('/status'), /Storage: TEMPORARY/);
});
