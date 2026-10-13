'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setup } = require('./helpers');
const { openDatabase } = require('../src/storage/db');
const { AudienceStore } = require('../src/status/audience');
const { BaileysProvider } = require('../src/providers/baileys');
const { loadConfig } = require('../src/config');

const c = (n) => ({ id: `23480000000${String(n).padStart(2, '0')}@s.whatsapp.net`, name: `Contact ${n}` });
const text = (r) => r.replies.join('\n');

test('ingest keeps phone contacts, counts anonymous-ID contacts, ignores groups and junk', () => {
  const a = new AudienceStore(openDatabase(':memory:'));
  a.ingest([c(1), c(2), { id: '999@lid' }, { id: '123@g.us' }, { id: 'status@broadcast' }, { id: '2348000000003:5@s.whatsapp.net' }, { id: 'x' }]);
  const st = a.stats();
  assert.equal(st.synced, 3); assert.equal(st.lidOnly, 1);
  assert.deepEqual(a.recipients(null), ['2348000000001@s.whatsapp.net', '2348000000002@s.whatsapp.net', '2348000000003@s.whatsapp.net']);
  assert.ok(a.recipients(null).every((j) => /^\d+@s\.whatsapp\.net$/.test(j)));
});

test('a contact with a phone and an anonymous ID is usable via the phone', () => {
  const a = new AudienceStore(openDatabase(':memory:'));
  a.ingest([{ id: '555@lid', lid: '555@lid', jid: '2348000000009@s.whatsapp.net' }]);
  assert.equal(a.count(), 1);
});

test('exclusions survive a re-sync; manual additions work; self is always added to recipients', () => {
  const a = new AudienceStore(openDatabase(':memory:'));
  a.ingest([c(1), c(2)]);
  a.exclude('2348000000001');
  a.ingest([c(1), c(2)]);
  assert.equal(a.count(), 1);
  assert.equal(a.addManual('+234 800 000 0077'), '2348000000077@s.whatsapp.net');
  assert.equal(a.addManual('abc'), null);
  assert.equal(a.count(), 2);
  assert.ok(a.recipients('me@s.whatsapp.net').includes('me@s.whatsapp.net'));
});

test('manual mode uses only manual entries', () => {
  const a = new AudienceStore(openDatabase(':memory:'));
  a.ingest([c(1), c(2)]); a.addManual('2348000000077');
  a.setMode('manual');
  assert.deepEqual(a.recipients(null), ['2348000000077@s.whatsapp.net']);
  assert.throws(() => a.setMode('everyone'));
});

test('provider contact events flow into the audience store', async () => {
  const s = setup(); await s.provider.connect();
  s.provider.simulateContacts([c(1), c(2), { id: '777@lid' }]);
  assert.equal(s.assistant.audience.stats().synced, 2);
  assert.equal(s.assistant.audience.stats().lidOnly, 1);
});

test('/audience reports counts and limits but never lists phone numbers', async () => {
  const s = setup(); await s.provider.connect();
  s.provider.simulateContacts([c(1), c(2)]);
  const t = text(await s.send('/audience'));
  assert.match(t, /Usable recipients: 2/); assert.match(t, /may be incomplete/); assert.match(t, /cannot confirm who actually sees/);
  assert.match(t, /privacy as: contacts/);
  assert.ok(!/2348000000/.test(t), 'no contact numbers in chat');
});

test('/audience when empty says posting is blocked; privacy read failure is stated, not guessed', async () => {
  const s = setup(); await s.provider.connect();
  s.provider.statusPrivacy = { ok: false, error: 'not connected' };
  const t = text(await s.send('/audience'));
  assert.match(t, /EMPTY/); assert.match(t, /unknown \(not connected\)/);
});

test('/audience add/remove/mode and natural-language trigger', async () => {
  const s = setup(); await s.provider.connect();
  assert.match(text(await s.send('/audience add 2348000000050, 2348000000051 bad')), /Added 2 number\(s\); 1 invalid/);
  assert.match(text(await s.send('/audience remove 2348000000050')), /Excluded 1/);
  assert.equal(s.assistant.audience.count(), 1);
  assert.match(text(await s.send('/audience mode manual')), /Audience mode: manual/);
  assert.match(text(await s.send('who will see my status?')), /Status audience/);
});

test('non-owner cannot alter the audience', async () => {
  const s = setup(); await s.provider.connect();
  const r = await s.send('/audience add 2348000000050', { from: '2348111111111', chat: '2348111111111@s.whatsapp.net' });
  assert.equal(r.res.handled, false);
  assert.equal(s.assistant.audience.count(), 0);
});

test('audience persists across restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-')); const f = path.join(dir, 'a.sqlite');
  try {
    const a = new AudienceStore(openDatabase(f)); a.ingest([c(1)]); a.addManual('2348000000077'); a.exclude('2348000000001'); a.setMode('all'); a.db.close();
    const b = new AudienceStore(openDatabase(f));
    assert.equal(b.count(), 1); assert.equal(b.stats().excluded, 1); b.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Baileys events (contacts.upsert, contacts.update, messaging-history.set) feed contacts; privacy mode read via fetchPrivacySettings', async () => {
  const OWNER = '2340000000001';
  const sockets = [];
  const fake = { DisconnectReason: {}, useMultiFileAuthState: async () => ({ state: { creds: { registered: true } }, saveCreds: async () => {} }), fetchLatestBaileysVersion: async () => ({ version: [1, 1, 1] }),
    default: () => { const ev = new EventEmitter(); const sock = { ev, user: { id: `${OWNER}:1@s.whatsapp.net` }, fetchPrivacySettings: async () => ({ status: 'contact_blacklist' }), end() {} }; sockets.push(sock); return sock; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  const cfg = loadConfig({ OWNER_PHONE: OWNER, WHATSAPP_PROVIDER: 'baileys', ACCOUNT_MODE: 'self', DATA_DIR: dir });
  const p = new BaileysProvider({ config: cfg, baileys: fake, timers: { setTimeout() {}, clearTimeout() {} } });
  const got = []; p.onContacts((l) => got.push(...l));
  await p.connect();
  sockets[0].ev.emit('connection.update', { connection: 'open' }); await new Promise((r) => setImmediate(r));
  sockets[0].ev.emit('contacts.upsert', [c(1)]);
  sockets[0].ev.emit('contacts.update', [{ id: c(2).id, notify: 'x' }]);
  sockets[0].ev.emit('messaging-history.set', { contacts: [c(3)], chats: [], messages: [] });
  sockets[0].ev.emit('messaging-history.set', { chats: [] });
  assert.equal(got.length, 3);
  assert.deepEqual(await p.getStatusPrivacy(), { ok: true, mode: 'contact_blacklist' });
  sockets[0].fetchPrivacySettings = async () => { throw new Error('boom'); };
  assert.deepEqual(await p.getStatusPrivacy(), { ok: false, error: 'boom' });
  fs.rmSync(dir, { recursive: true, force: true });
});
