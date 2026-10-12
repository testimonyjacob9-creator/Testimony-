'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { BaileysProvider, normalizeMessage, backoffMs } = require('../src/providers/baileys');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/storage/db');
const { Assistant } = require('../src/assistant');

const OWNER = '2340000000001';

function fakeBaileys({ registered = true, userId = `${OWNER}:7@s.whatsapp.net`, lid = '555:7@lid' } = {}) {
  const fake = { sockets: [], sent: [], saveCredsCalls: 0 };
  fake.DisconnectReason = { loggedOut: 401, connectionReplaced: 440, badSession: 500, restartRequired: 515 };
  fake.useMultiFileAuthState = async (dir) => ({
    state: { creds: { registered } },
    saveCreds: async () => { fake.saveCredsCalls++; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'creds.json'), '{"fake":true}', { mode: 0o644 }); },
  });
  fake.fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 1] });
  fake.default = () => {
    const ev = new EventEmitter();
    const sock = {
      ev, user: { id: userId, lid }, ended: false, pairingFor: null,
      requestPairingCode: async (phone) => { sock.pairingFor = phone; return 'ABCD1234'; },
      sendMessage: async (jid, content) => { fake.sent.push({ jid, content }); return { key: { id: `wa-${fake.sent.length}` } }; },
      end: () => { sock.ended = true; },
    };
    fake.sockets.push(sock); return sock;
  };
  return fake;
}
const timers = () => { const t = { delays: [], fns: [], setTimeout: (fn, ms) => { t.delays.push(ms); t.fns.push(fn); return t.fns.length; }, clearTimeout() {} }; return t; };
const mkConfig = (mode, dir) => loadConfig({ OWNER_PHONE: `+${OWNER}`, WHATSAPP_PROVIDER: 'baileys', ACCOUNT_MODE: mode, BOT_PHONE: mode === 'separate' ? '2348099999999' : '', DATA_DIR: dir });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bail-'));
const tick = () => new Promise((r) => setImmediate(r));

async function open(mode = 'self', opts = {}) {
  const dir = tmp();
  const fake = fakeBaileys(opts.fake);
  const t = timers();
  const p = new BaileysProvider({ config: mkConfig(mode, dir), baileys: fake, timers: t });
  await p.connect();
  const sock = fake.sockets[0];
  if (opts.openNow !== false) { sock.ev.emit('connection.update', { connection: 'open' }); await tick(); }
  return { p, fake, sock, t, dir };
}

test('normalizeMessage: text, extended text, caption, groups, skips noise', () => {
  const self = { phone: OWNER, jid: `${OWNER}@s.whatsapp.net`, lid: '555@lid' };
  const base = (o) => ({ key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: 'a' }, messageTimestamp: 1760000000, ...o });
  const a = normalizeMessage(base({ message: { conversation: 'hi' } }), self);
  assert.equal(a.text, 'hi'); assert.equal(a.chatIsSelf, true); assert.equal(a.from, OWNER); assert.equal(a.timestamp, 1760000000000);
  assert.equal(normalizeMessage(base({ message: { extendedTextMessage: { text: 'yo' } } }), self).text, 'yo');
  assert.equal(normalizeMessage(base({ message: { imageMessage: { caption: 'cap' } } }), self).media.type, 'image');
  const g = normalizeMessage({ key: { remoteJid: '1@g.us', participant: `${OWNER}@s.whatsapp.net`, id: 'g' }, message: { conversation: 'x' } }, self);
  assert.equal(g.isGroup, true);
  assert.equal(normalizeMessage({ key: { remoteJid: 'status@broadcast', id: 's' }, message: { conversation: 'x' } }, self), null);
  assert.equal(normalizeMessage({ key: { remoteJid: '1@newsletter', id: 's' }, message: { conversation: 'x' } }, self), null);
  assert.equal(normalizeMessage(base({ message: { reactionMessage: {} } }), self), null);
});

test('normalizeMessage: LID senders resolve to a phone only when WhatsApp supplies it', () => {
  const m = (extra) => ({ key: { remoteJid: '999@lid', id: 'l', fromMe: false, ...extra }, message: { conversation: 'x' } });
  assert.equal(normalizeMessage(m({ senderPn: `${OWNER}@s.whatsapp.net` }), {}).from, OWNER);
  const noPn = normalizeMessage(m({}), {});
  assert.equal(noPn.from, null); assert.equal(noPn.fromLid, '999@lid');
});

test('backoff grows and is capped', () => {
  assert.deepEqual([0, 1, 2, 3].map(backoffMs), [1000, 2000, 4000, 8000]);
  assert.equal(backoffMs(50), 60000);
});

test('self mode: linking the owner account -> connected', async () => {
  const { p } = await open('self');
  assert.equal(p.connectionState(), 'connected');
});

test('self mode: wrong account linked -> account_mismatch, disconnected, no reconnect', async () => {
  const { p, sock, t } = await open('self', { fake: { userId: '2348111111111:1@s.whatsapp.net' } });
  assert.equal(p.connectionState(), 'account_mismatch');
  assert.equal(sock.ended, true);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  assert.equal(t.fns.length, 0, 'must not reconnect after mismatch');
});

test('separate mode: bot account equal to the owner is rejected; different account accepted', async () => {
  const bad = await open('separate', { fake: { userId: `${OWNER}:1@s.whatsapp.net` } });
  assert.equal(bad.p.connectionState(), 'account_mismatch');
  const good = await open('separate', { fake: { userId: '2348099999999:1@s.whatsapp.net' } });
  assert.equal(good.p.connectionState(), 'connected');
});

test('temporary drop: reconnects with backoff; success resets the counter', async () => {
  const { p, sock, t, fake } = await open('self');
  const drop = () => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  drop(); assert.equal(p.connectionState(), 'reconnecting'); assert.equal(t.delays[0], 1000);
  await t.fns[0](); await tick();
  const sock2 = fake.sockets[1];
  assert.ok(sock2, 'new socket created');
  sock2.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  assert.equal(t.delays[1], 2000, 'backoff doubled');
  await t.fns[1](); await tick();
  fake.sockets[2].ev.emit('connection.update', { connection: 'open' }); await tick();
  assert.equal(p.connectionState(), 'connected');
  fake.sockets[2].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  assert.equal(t.delays[2], 1000, 'counter reset after a good connection');
});

test('logged out / replaced / bad session are terminal (no reconnect loop)', async () => {
  for (const [code, state] of [[401, 'logged_out'], [440, 'replaced'], [500, 'bad_session']]) {
    const { p, sock, t } = await open('self');
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
    assert.equal(p.connectionState(), state);
    assert.equal(t.fns.length, 0);
  }
});

test('first-time pairing uses the bot phone and prints the code to console only', async () => {
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  const loggerLines = [];
  try {
    const dir = tmp(); const fake = fakeBaileys({ registered: false });
    const p = new BaileysProvider({ config: mkConfig('self', dir), baileys: fake, timers: timers(), logger: { info: (...a) => loggerLines.push(a), warn: (...a) => loggerLines.push(a), error: (...a) => loggerLines.push(a) } });
    await p.connect();
    fake.sockets[0].ev.emit('connection.update', { qr: 'x' }); await tick(); await tick();
    fake.sockets[0].ev.emit('connection.update', { qr: 'x' }); await tick();
    assert.equal(fake.sockets[0].pairingFor, OWNER);
    assert.equal(p.connectionState(), 'awaiting_pairing');
  } finally { console.log = orig; }
  assert.equal(logs.filter((l) => /ABCD-1234/.test(l)).length, 1, 'requested once, shown on console');
  assert.ok(!JSON.stringify(loggerLines).includes('ABCD'), 'code never goes to the structured logger');
});

test('credentials directory is locked down (0700 dir, 0600 files)', async () => {
  const { p, sock, dir } = await open('self');
  sock.ev.emit('creds.update'); await tick(); await tick();
  const auth = path.join(dir, 'auth_state');
  assert.equal(fs.statSync(auth).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(auth, 'creds.json')).mode & 0o777, 0o600);
  assert.ok(p);
});

test('sendText: refuses when disconnected, builds JID, reports failures honestly', async () => {
  const { p, fake, sock } = await open('self', { openNow: false });
  assert.deepEqual(await p.sendText(OWNER, 'x'), { ok: false, verified: false, error: 'not connected' });
  sock.ev.emit('connection.update', { connection: 'open' }); await tick();
  const r = await p.sendText(OWNER, 'hello');
  assert.deepEqual(r, { ok: true, id: 'wa-1', verified: true });
  assert.equal(fake.sent[0].jid, `${OWNER}@s.whatsapp.net`);
  sock.sendMessage = async () => { throw new Error('rate-overlimit'); };
  assert.deepEqual(await p.sendText(OWNER, 'hello'), { ok: false, verified: false, error: 'rate-overlimit' });
});

test('unimplemented features are reported as unsupported, never faked', async () => {
  const { p } = await open('self');
  assert.equal(p.capabilities().publishStatus, false);
  assert.equal((await p.publishStatus({})).ok, false);
  assert.equal((await p.sendMedia('x', {})).ok, false);
});

test('upsert routing: live messages delivered, old appended history dropped, handler errors contained', async () => {
  const { p, sock } = await open('self');
  const got = [];
  p.onMessage(async (m) => { got.push(m.text); if (m.text === 'boom') throw new Error('x'); });
  const raw = (text, ts) => ({ key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: text }, message: { conversation: text }, messageTimestamp: ts });
  const now = Math.floor(Date.now() / 1000);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [raw('one', now), raw('boom', now), raw('two', now)] }); await tick(); await tick();
  sock.ev.emit('messages.upsert', { type: 'append', messages: [raw('old', now - 3600)] }); await tick();
  sock.ev.emit('messages.upsert', { type: 'prepend', messages: [raw('hist', now)] }); await tick();
  assert.deepEqual(got, ['one', 'boom', 'two']);
});

test('END-TO-END (fake socket): owner command in self-chat is answered; a stranger is ignored', async () => {
  const dir = tmp(); const fake = fakeBaileys(); const config = mkConfig('self', dir);
  const p = new BaileysProvider({ config, baileys: fake, timers: timers() });
  const db = openDatabase(':memory:');
  const a = new Assistant({ db, provider: p, config });
  a.start(); await p.connect();
  const sock = fake.sockets[0];
  sock.ev.emit('connection.update', { connection: 'open' }); await tick(); await tick();
  const announce = fake.sent.length;
  const now = Math.floor(Date.now() / 1000);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: `${OWNER}@s.whatsapp.net`, fromMe: true, id: 'c1' }, message: { conversation: '/status' }, messageTimestamp: now }] });
  await tick(); await tick(); await tick();
  assert.equal(fake.sent.length, announce + 1);
  assert.match(fake.sent[announce].content.text, /Assistant status/);
  assert.equal(fake.sent[announce].jid, `${OWNER}@s.whatsapp.net`);
  // stranger DMs the account: ignored, no reply
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '2348000000000@s.whatsapp.net', fromMe: false, id: 's1' }, message: { conversation: '/pause' }, messageTimestamp: now }] });
  await tick(); await tick(); await tick();
  assert.equal(fake.sent.length, announce + 1, 'no reply to stranger');
  // the owner typing in someone else\'s chat is not a command either
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '2348000000000@s.whatsapp.net', fromMe: true, id: 's2' }, message: { conversation: '/pause' }, messageTimestamp: now }] });
  await tick(); await tick(); await tick();
  assert.equal(fake.sent.length, announce + 1);
  assert.match((await a.process('/status')), /Automation: running/);
});
