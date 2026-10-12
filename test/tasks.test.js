'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/storage/db');
const { TaskStore } = require('../src/tasks/store');
const { loadConfig } = require('../src/config');

const clock = { t: new Date('2026-10-12T10:00:00Z') };
const mk = () => new TaskStore(openDatabase(':memory:'), () => new Date(clock.t));

test('proposal -> schedule -> claim exactly once', () => {
  const s = mk();
  const id = s.create({ kind: 'reminder', title: 'x', status: 'proposed', runAt: '2026-10-12T09:00:00.000Z', expiresAt: '2026-10-12T11:00:00.000Z' });
  assert.equal(s.schedule(id), true);
  assert.equal(s.schedule(id), false);
  assert.equal(s.dueTasks().length, 1);
  assert.equal(s.claim(id), true);
  assert.equal(s.claim(id), false);
});
test('proposals expire', () => {
  const s = mk();
  s.create({ kind: 'reminder', title: 'x', status: 'proposed', expiresAt: '2026-10-12T10:30:00.000Z' });
  assert.ok(s.activeProposal());
  clock.t = new Date('2026-10-12T10:31:00Z');
  assert.equal(s.activeProposal(), null);
  clock.t = new Date('2026-10-12T10:00:00Z');
});
test('recoverRunning requeues crashed tasks', () => {
  const s = mk();
  const id = s.create({ kind: 'reminder', title: 'x', status: 'scheduled', runAt: '2026-10-12T09:00:00.000Z' });
  s.claim(id);
  assert.equal(s.recoverRunning(), 1);
  assert.equal(s.get(id).status, 'scheduled');
});
test('config: baileys requires explicit account mode; self/separate rules', () => {
  const base = { OWNER_PHONE: '+2340000000001', DATA_DIR: '/tmp/x' };
  assert.equal(loadConfig(base).ownerPhone, '2340000000001');
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PROVIDER: 'baileys' }), /ACCOUNT_MODE/);
  assert.equal(loadConfig({ ...base, WHATSAPP_PROVIDER: 'baileys', ACCOUNT_MODE: 'self' }).botPhone, '2340000000001');
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PROVIDER: 'baileys', ACCOUNT_MODE: 'separate' }), /BOT_PHONE/);
  assert.throws(() => loadConfig({ ...base, ACCOUNT_MODE: 'separate', BOT_PHONE: '2340000000001' }), /differ/);
});
