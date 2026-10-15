'use strict';
// Production-hardening tests. Everything here is mocked: no network, no WhatsApp, no Gemini.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadConfig } = require('../src/config');
const { persistenceWarning } = require('../src/index');
const { GeminiClient, THINKING_HEADROOM } = require('../src/ai/gemini');
const { BaileysProvider } = require('../src/providers/baileys');
const { openDatabase } = require('../src/storage/db');
const { Assistant } = require('../src/assistant');

const OWNER = '2347065702702';
const tick = () => new Promise((r) => setImmediate(r));

test('config: on Render the data directory defaults to the persistent disk; locally it stays ./data; explicit DATA_DIR wins', () => {
  const onRender = loadConfig({ OWNER_PHONE: OWNER, RENDER: 'true' });
  assert.equal(onRender.dataDir, '/var/data'); assert.equal(onRender.dbPath, '/var/data/assistant.sqlite');
  assert.equal(onRender.authDir, '/var/data/auth_state'); assert.equal(onRender.mediaDir, '/var/data/media');
  assert.equal(onRender.onRender, true);
  assert.equal(loadConfig({ OWNER_PHONE: OWNER }).dataDir, path.resolve('./data'));
  assert.equal(loadConfig({ OWNER_PHONE: OWNER, RENDER: 'true', DATA_DIR: '/mnt/x' }).dataDir, '/mnt/x');
});

test('config: the two user-supplied variables are enough; defaults cover timezone, AI and model', () => {
  const c = loadConfig({ OWNER_PHONE: '+234 706 570 2702', GEMINI_API_KEY: 'k' });
  assert.equal(c.ownerPhone, OWNER); assert.equal(c.timezone, 'Africa/Lagos'); assert.equal(c.ai.enabled, true);
  assert.equal(c.ai.provider, 'gemini'); assert.equal(c.ai.model, 'gemini-3.8-flash'); assert.equal(c.logLevel, 'info');
});

test('persistenceWarning: flags a data dir on the ephemeral filesystem, accepts a mounted disk, is silent off Render', () => {
  const fsFor = (dataDev, rootDev) => ({ statSync: (p) => ({ dev: p === '/' ? rootDev : dataDev }) });
  const cfg = (over) => ({ onRender: true, dataDir: '/var/data', ...over });
  assert.match(persistenceWarning(cfg(), fsFor(1, 1)), /ephemeral/);
  assert.equal(persistenceWarning(cfg(), fsFor(2, 1)), null);
  assert.equal(persistenceWarning(cfg({ onRender: false }), fsFor(1, 1)), null);
  assert.match(persistenceWarning(cfg(), { statSync() { throw new Error('ENOENT'); } }), /Could not inspect/);
});

test('gemini: every request leaves headroom for model reasoning, so small caps cannot come back empty', async () => {
  let seen;
  const sdk = { GoogleGenAI: class { constructor() { this.models = { generateContent: async (req) => { seen = req; return { text: '{"ok":true}' }; } }; } } };
  const g = new GeminiClient({ apiKey: 'k', model: 'm', timeoutMs: 1000, dailyLimit: 5 }, { sdk });
  await g.generateJson({ prompt: 'x', maxTokens: 60 });
  assert.equal(seen.config.maxOutputTokens, 60 + THINKING_HEADROOM);
});

test('gemini: a call that never answers is aborted at the timeout and reported as AI_TIMEOUT', async () => {
  const sdk = { GoogleGenAI: class { constructor() { this.models = { generateContent: ({ config }) => new Promise((_, rej) => { config.abortSignal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; rej(e); }); }) }; } } };
  const g = new GeminiClient({ apiKey: 'secret-key-123', model: 'm', timeoutMs: 40, dailyLimit: 5 }, { sdk });
  await assert.rejects(g.generateText({ prompt: 'x' }), (e) => e.code === 'AI_TIMEOUT' && !String(e.message).includes('secret-key-123'));
  const h = await g.health();
  assert.equal(h.ok, false); assert.equal(h.code, 'AI_TIMEOUT');
});

function fakeBaileys({ registered }) {
  const fake = { sockets: [], codes: 0 };
  fake.DisconnectReason = { loggedOut: 401, connectionReplaced: 440, badSession: 500, restartRequired: 515 };
  fake.useMultiFileAuthState = async () => ({ state: { creds: { registered } }, saveCreds: async () => {} });
  fake.fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 1] });
  fake.default = () => {
    const ev = new EventEmitter();
    const sock = { ev, user: { id: `${OWNER}:1@s.whatsapp.net` }, requestPairingCode: async () => { fake.codes++; return `CODE000${fake.codes}`; }, end() {}, sendMessage: async () => ({ key: { id: 'x' } }) };
    fake.sockets.push(sock); return sock;
  };
  return fake;
}
const mkProvider = (fake) => {
  const timers = { fns: [], setTimeout: (fn) => { timers.fns.push(fn); return timers.fns.length; }, clearTimeout() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));
  const config = loadConfig({ OWNER_PHONE: OWNER, WHATSAPP_PROVIDER: 'baileys', ACCOUNT_MODE: 'self', DATA_DIR: dir });
  return { p: new BaileysProvider({ config, baileys: fake, timers }), timers };
};
async function quietly(fn) { const orig = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = orig; } }

test('pairing: an already-registered session never asks for a pairing code', async () => {
  const fake = fakeBaileys({ registered: true }); const { p } = mkProvider(fake);
  await quietly(async () => { await p.connect(); fake.sockets[0].ev.emit('connection.update', { qr: 'x' }); await tick(); await tick(); });
  assert.equal(fake.codes, 0);
});

test('pairing: one code per connection attempt; a fresh attempt after a drop gets a fresh code; a pairing failure can be retried', async () => {
  const fake = fakeBaileys({ registered: false }); const { p, timers } = mkProvider(fake);
  await quietly(async () => {
    await p.connect();
    for (let i = 0; i < 3; i++) { fake.sockets[0].ev.emit('connection.update', { qr: 'x' }); await tick(); await tick(); }
    assert.equal(fake.codes, 1, 'repeated QR refreshes on one socket do not re-request');
    fake.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } }); await tick();
    await timers.fns[0](); await tick(); await tick();
    assert.equal(fake.sockets.length, 2);
    fake.sockets[1].ev.emit('connection.update', { qr: 'y' }); await tick(); await tick();
    assert.equal(fake.codes, 2, 'new attempt, new code');
  });
});

test('pairing: logged-out is terminal and leaves the stored credentials untouched', async () => {
  const fake = fakeBaileys({ registered: true }); const { p, timers } = mkProvider(fake);
  const authDir = p.config.authDir; fs.mkdirSync(authDir, { recursive: true }); fs.writeFileSync(path.join(authDir, 'creds.json'), '{"keep":true}');
  await p.connect();
  fake.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } }); await tick();
  assert.equal(p.connectionState(), 'logged_out'); assert.equal(timers.fns.length, 0, 'no reconnect loop');
  assert.equal(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8'), '{"keep":true}', 'never auto-deletes auth state');
});

test('memory and data persist on disk across a restart (same SQLite file, new Assistant)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-')); const dbPath = path.join(dir, 'assistant.sqlite');
  const config = loadConfig({ OWNER_PHONE: OWNER, DATA_DIR: dir });
  const noProvider = { onMessage() {}, onConnectionChange() {}, onContacts() {}, connectionState: () => 'connected', sendText: async () => ({ ok: true }) };
  let db = openDatabase(dbPath);
  let a = new Assistant({ db, provider: noProvider, config });
  a._recordTurn('owner', 'I sell phones and laptops in Benin'); db.close();
  db = openDatabase(dbPath); a = new Assistant({ db, provider: noProvider, config });
  assert.deepEqual(a._recentTurns(6).map((t) => t.text), ['I sell phones and laptops in Benin']);
  db.close();
});
