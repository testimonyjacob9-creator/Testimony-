'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');
const { openDatabase } = require('../src/storage/db');

test('restart: pending draft and scheduled task survive and still work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-'));
  const file = path.join(dir, 'a.sqlite');
  return (async () => {
    const a = setup({ db: openDatabase(file) });
    await a.provider.connect();
    await a.send('remind me to call Ada at 4pm'); await a.send('yes');
    await a.send('remind me to draft only tomorrow 9am');
    a.db.close();

    // "restart": brand-new process objects over the same file
    const b = setup({ db: openDatabase(file) });
    await b.provider.connect();
    const t = (await b.send('/tasks')).replies[0];
    assert.match(t, /call Ada/);
    assert.match(t, /draft only/);
    assert.match((await b.send('yes')).replies[0], /scheduled for/, 'pending approval survived restart');
    b.clock.t = new Date('2026-10-13T08:30:00Z');
    const before = b.provider.sent.length;
    const r = await b.scheduler.tick();
    assert.equal(r.done, 2);
    assert.equal(b.provider.sent.length - before, 2);
    b.db.close();
  })().finally(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('overdue after downtime: sent late with an honest delay note', async () => {
  const s = setup(); await s.provider.connect();
  await s.send('remind me to renew licence at 4pm'); await s.send('yes');
  s.clock.t = new Date('2026-10-12T18:00:00Z');
  const before = s.provider.sent.length;
  await s.scheduler.tick();
  assert.match(s.provider.sent[before].text, /delayed \d+ min/);
});

test('crash mid-run: running task is re-queued on startup', async () => {
  const s = setup(); await s.provider.connect();
  await s.send('remind me to x in 1 hour'); await s.send('yes');
  const id = s.assistant.store.listOpen()[0].id;
  s.assistant.store.claim(id); // simulate crash after claim
  const s2 = setup({ db: s.db }); // restart
  assert.equal(s2.assistant.store.get(id).status, 'scheduled');
});

test('WhatsApp disconnected: task stays scheduled, no attempt burned, runs after reconnect', async () => {
  const s = setup(); await s.provider.connect();
  await s.send('remind me to x in 1 hour'); await s.send('yes');
  await s.provider.disconnect();
  s.clock.t = new Date('2026-10-12T12:00:00Z');
  assert.deepEqual(await s.scheduler.tick(), { skipped: 'disconnected' });
  const id = s.assistant.store.listOpen()[0].id;
  assert.equal(s.assistant.store.get(id).status, 'scheduled');
  assert.equal(s.assistant.store.get(id).attempts, 0);
  await s.provider.connect();
  assert.equal((await s.scheduler.tick()).done, 1);
});

test('provider failure: limited retries, then FAILED and owner notified; never reported as done', async () => {
  const s = setup(); await s.provider.connect();
  await s.send('remind me to x in 1 hour'); await s.send('yes');
  const id = s.assistant.store.listOpen()[0].id;
  s.clock.t = new Date('2026-10-12T11:30:00Z');
  const origSend = s.provider.sendText.bind(s.provider);
  let failing = true;
  s.provider.sendText = async (jid, text) => (failing && /Reminder/.test(text) ? { ok: false, verified: false, error: 'boom' } : origSend(jid, text));
  let r = await s.scheduler.tick(); assert.equal(r.retried, 1);
  s.clock.t = new Date(s.clock.t.getTime() + 5000);
  r = await s.scheduler.tick(); assert.equal(r.retried, 1);
  s.clock.t = new Date(s.clock.t.getTime() + 10000);
  r = await s.scheduler.tick(); assert.equal(r.failed, 1);
  const task = s.assistant.store.get(id);
  assert.equal(task.status, 'failed');
  assert.equal(task.attempts, 3);
  assert.ok(s.provider.sent.some((m) => /FAILED after 3 attempts/.test(m.text) && /not completed/.test(m.text)));
  assert.match((await s.send('/status')).replies[0], /Failed tasks: 1/);
});

test('reply send failure is audited, not silently swallowed', async () => {
  const s = setup(); await s.provider.connect();
  s.provider.failNext = 'network down';
  await s.send('/status');
  const row = s.db.prepare("SELECT outcome FROM audit_log WHERE action='reply'").get();
  assert.equal(row.outcome, 'failed');
});

test('storage unavailable: owner is told it was NOT done; handler never rejects (no process crash)', async () => {
  const s = setup(); await s.provider.connect();
  s.db.close();
  const before = s.provider.sent.length;
  await s.provider.simulateInbound({ from: '2347065702702', chat: '2347065702702@s.whatsapp.net', text: 'remind me to x at 4pm', timestamp: s.clock.t.getTime() });
  assert.equal(s.provider.sent.length - before, 1);
  assert.match(s.provider.sent[before].text, /NOT completed/);
});
