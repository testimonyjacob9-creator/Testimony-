'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/storage/db');
const { acquireLease, renewLease, releaseLease, tryAcquire } = require('../src/storage/lease');

const root = path.join(__dirname, '..');
const yaml = fs.readFileSync(path.join(root, 'render.paid.yaml'), 'utf8');
const freeYaml = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
const pkg = require('../package.json');

test('render.paid.yaml: persistent disk, DATA_DIR on the disk, one instance, no secrets, real WhatsApp provider (not mock) in self mode', () => {
  const mount = yaml.match(/mountPath:\s*(\S+)/)[1];
  assert.equal(mount, '/var/data');
  assert.match(yaml, new RegExp(`key: DATA_DIR[^\\n]*\\n\\s+value: ${mount}`));
  assert.match(yaml, /numInstances:\s*1\b/);
  assert.match(yaml, /type: worker/);
  assert.match(yaml, /startCommand: npm start/);
  assert.match(yaml, /key: WHATSAPP_PROVIDER\s+value: baileys/);
  assert.doesNotMatch(yaml, /value: mock/);
  assert.match(yaml, /key: ACCOUNT_MODE\s+value: self/);
  for (const k of ['GEMINI_API_KEY', 'OWNER_PHONE']) assert.match(yaml, new RegExp(`key: ${k}[^\\n]*\\n\\s+sync: false`));
  assert.doesNotMatch(yaml, /AIza[0-9A-Za-z_-]{10,}/);
  const node = yaml.match(/key: NODE_VERSION\s+value: ([\d.]+)/)[1];
  const min = pkg.engines.node.match(/(\d+\.\d+\.\d+)/)[1].split('.').map(Number);
  const have = node.split('.').map(Number);
  assert.ok(have[0] > min[0] || (have[0] === min[0] && have[1] >= min[1]), 'NODE_VERSION satisfies engines');
});
test('render.yaml (free web service): web port health check, no disk, temporary storage acknowledged, real provider, no secrets', () => {
  assert.match(freeYaml, /type: web\b/); assert.match(freeYaml, /plan: free\b/); assert.match(freeYaml, /healthCheckPath: \/health/);
  assert.match(freeYaml, /numInstances:\s*1\b/); assert.doesNotMatch(freeYaml, /^\s*disk:/m);
  assert.match(freeYaml, /key: EPHEMERAL_OK[^\n]*\n\s+value: "true"/);
  assert.match(freeYaml, /key: WHATSAPP_PROVIDER\s+value: baileys/); assert.doesNotMatch(freeYaml, /value: mock/);
  for (const k of ['GEMINI_API_KEY', 'OWNER_PHONE']) assert.match(freeYaml, new RegExp(`key: ${k}[^\\n]*\\n\\s+sync: false`));
  assert.doesNotMatch(freeYaml, /AIza[0-9A-Za-z_-]{10,}/);
});
test('render env: DATA_DIR drives SQLite, WhatsApp session and media consistently', () => {
  const c = loadConfig({ OWNER_PHONE: '+2347065702702', DATA_DIR: '/var/data', GEMINI_API_KEY: 'k' });
  assert.equal(c.dbPath, '/var/data/assistant.sqlite'); assert.equal(c.authDir, '/var/data/auth_state'); assert.equal(c.mediaDir, '/var/data/media');
  assert.equal(c.ownerPhone, '2347065702702'); assert.equal(c.provider, 'mock'); // code default; the blueprints set baileys
  assert.equal(c.timezone, 'Africa/Lagos');
  assert.equal(c.ai.enabled, true);
});
test('secrets are not committed: .env ignored, example has an empty key, no key-like strings in tracked sources', () => {
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.env$/m);
  assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /^GEMINI_API_KEY=$/m);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(root).filter((x) => /\.(js|md|yaml|json|example)$/.test(x) && !x.endsWith('ai.test.js') && !x.endsWith('package-lock.json'))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /AIza[0-9A-Za-z_-]{30,}/, f);
  }
});

test('lease: one active instance; a second waits then fails; stale leases are taken over; release frees it', async () => {
  const db = openDatabase(':memory:'); let t = new Date('2026-10-12T10:00:00Z'); const clock = () => t;
  assert.equal(await acquireLease(db, 'A', { clock }), true);
  const sleep = async () => {};
  await assert.rejects(acquireLease(db, 'B', { clock, waitMs: 0, sleep }), (e) => e.code === 'LEASE_HELD');
  assert.equal(renewLease(db, 'A', clock), true); assert.equal(renewLease(db, 'B', clock), false);
  t = new Date(t.getTime() + 46000); // A stopped heartbeating (crash)
  assert.equal(tryAcquire(db, 'B', t, 45000).ok, true);
  assert.equal(renewLease(db, 'A', clock), false); // A has lost it and must stop
  releaseLease(db, 'A'); assert.equal(renewLease(db, 'B', clock), true); // A cannot release B's lease
  releaseLease(db, 'B'); assert.equal(await acquireLease(db, 'C', { clock, waitMs: 0, sleep }), true);
});
test('lease: a redeploy overlap succeeds once the old instance releases', async () => {
  const db = openDatabase(':memory:'); const clock = () => new Date();
  await acquireLease(db, 'OLD', { clock });
  let polls = 0;
  const sleep = async () => { if (++polls === 2) releaseLease(db, 'OLD'); };
  assert.equal(await acquireLease(db, 'NEW', { clock, waitMs: 5000, pollMs: 1, sleep }), true);
  assert.ok(polls >= 2);
});

test('process: starts in mock mode, STAYS running, and shuts down gracefully on SIGTERM (lease released, audit written)', async () => {
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-start-'));
  const child = spawn(process.execPath, [path.join(root, 'src/index.js')], { env: { PATH: process.env.PATH, OWNER_PHONE: '2347065702702', DATA_DIR: dir, LOG_LEVEL: 'info' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const started = Date.now();
  while (!/assistant started/.test(out) && Date.now() - started < 10000) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /assistant started/);
  assert.match(out, /off: GEMINI_API_KEY is not set/, 'missing key: starts safely and says AI is unavailable');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(child.exitCode, null, 'service must not exit by itself');
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  const db = new DatabaseSync(path.join(dir, 'assistant.sqlite'));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM settings WHERE key = 'instance_lease'").get().c, 0);
  assert.deepEqual(db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((r) => r.action), ['startup', 'shutdown']);
  db.close();
  assert.doesNotMatch(out, /GEMINI_API_KEY=|AIza/);
});
