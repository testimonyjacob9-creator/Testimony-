'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, OWNER } = require('./helpers');

const connected = async (o) => { const s = setup(o); await s.provider.connect(); s.sent0 = s.provider.sent.length; return s; };

test('unauthorized sender is ignored: no reply, nothing executed', async () => {
  const s = await connected();
  const r = await s.send('/pause', { from: '2348000000000', chat: '2348000000000@s.whatsapp.net' });
  assert.equal(r.res.handled, false);
  assert.equal(r.replies.length, 0);
  assert.equal(s.assistant.store.counts().scheduled, undefined);
  const audit = s.db.prepare('SELECT outcome FROM audit_log WHERE outcome = ?').get('rejected');
  assert.ok(audit);
  const p = await s.send('/status');
  assert.match(p.replies[0], /Automation: running/);
});

test('group messages (even from the owner number) are ignored', async () => {
  const s = await connected();
  const r = await s.send('/pause', { isGroup: true, chat: '123@g.us' });
  assert.equal(r.res.handled, false);
  assert.equal(r.replies.length, 0);
});

test('/help and /status respond', async () => {
  const s = await connected();
  assert.match((await s.send('/help')).replies[0], /\/pause/);
  const st = (await s.send('/status')).replies[0];
  assert.match(st, /Connection: connected/);
  assert.match(st, /Not built yet/);
});

test('reminder: propose -> confirm -> scheduled -> executes at due time', async () => {
  const s = await connected();
  const p = await s.send('Remind me to call the buyer at 4 PM');
  assert.match(p.replies[0], /NOT set yet/);
  assert.match(p.replies[0], /call the buyer/);
  assert.equal(s.assistant.store.counts().proposed, 1);
  assert.equal(s.assistant.store.counts().scheduled, undefined, 'nothing scheduled before confirmation');

  const c = await s.send('yes');
  assert.match(c.replies[0], /scheduled for/);
  assert.equal(s.assistant.store.counts().scheduled, 1);

  let tick = await s.scheduler.tick();
  assert.equal(tick.done, 0, 'not due yet');
  s.clock.t = new Date('2026-10-12T15:00:30Z');
  const before = s.provider.sent.length;
  tick = await s.scheduler.tick();
  assert.equal(tick.done, 1);
  assert.match(s.provider.sent[before].text, /Reminder: call the buyer/);
  assert.equal(s.assistant.store.counts().done, 1);
});

test('duplicate scheduler ticks execute a task only once', async () => {
  const s = await connected();
  await s.send('remind me to pay rent in 1 hour'); await s.send('yes');
  s.clock.t = new Date('2026-10-12T11:05:00Z');
  const before = s.provider.sent.length;
  await Promise.all([s.scheduler.tick(), s.scheduler.tick()]);
  await s.scheduler.tick();
  assert.equal(s.provider.sent.length - before, 1);
});

test('denying a draft discards it and executes nothing', async () => {
  const s = await connected();
  await s.send('remind me to x at 4pm');
  const d = await s.send('no');
  assert.match(d.replies[0], /Discarded/);
  assert.equal(s.assistant.store.listOpen().length, 0);
});

test('modify before confirming: new time replaces the draft time', async () => {
  const s = await connected();
  await s.send('remind me to call John at 4pm');
  const m = await s.send('make it 5 PM');
  assert.match(m.replies[0], /Updated/);
  assert.match(m.replies[0], /5:00 pm/i);
  await s.send('yes');
  const t = s.assistant.store.listOpen()[0];
  assert.equal(t.run_at, '2026-10-12T16:00:00.000Z');
});

test('missing information: asks, then completes the draft', async () => {
  const s = await connected();
  assert.match((await s.send('remind me to check payment')).replies[0], /When should I remind you/);
  assert.match((await s.send('tomorrow morning')).replies[0], /NOT set yet/);
  assert.match((await s.send('remind me at 3pm')).replies[0], /What should I remind you about/);
  assert.match((await s.send('call Ada')).replies[0], /call Ada/);
});

test('a new draft replaces an older unconfirmed one (only one pending approval)', async () => {
  const s = await connected();
  await s.send('remind me to A at 4pm');
  const r = await s.send('remind me to B at 5pm');
  assert.match(r.replies[0], /Replaced your earlier draft/);
  assert.equal(s.assistant.store.counts().proposed, 1);
});

test('draft expires; late "yes" does nothing', async () => {
  const s = await connected();
  await s.send('remind me to A at 4pm');
  s.clock.t = new Date(s.clock.t.getTime() + 31 * 60000);
  const r = await s.send('yes');
  assert.match(r.replies[0], /Nothing is waiting/);
  assert.equal(s.assistant.store.counts().scheduled, undefined);
});

test('/tasks lists open work and drafts awaiting approval', async () => {
  const s = await connected();
  assert.match((await s.send('/tasks')).replies[0], /No open tasks/);
  await s.send('remind me to A at 4pm'); await s.send('yes');
  await s.send('remind me to B tomorrow at 9am');
  const t = (await s.send('show me my tasks')).replies[0];
  assert.match(t, /T-1 reminder: A/);
  assert.match(t, /AWAITING YOUR APPROVAL/);
  assert.match((await s.send('show me which messages are awaiting my approval')).replies[0], /T-2/);
  assert.match((await s.send("Show me tomorrow's tasks")).replies[0], /T-2/);
});

test('/cancel T-n and /cancel all (needs confirmation)', async () => {
  const s = await connected();
  await s.send('remind me to A at 4pm'); await s.send('yes');
  await s.send('remind me to B at 5pm'); await s.send('yes');
  assert.match((await s.send('/cancel T-1')).replies[0], /Cancelled T-1/);
  const c = await s.send('/cancel all');
  assert.match(c.replies[0], /Confirm bulk cancel/);
  assert.equal(s.assistant.store.listOpen().filter((t) => t.kind === 'reminder').length, 1, 'still open before yes');
  assert.match((await s.send('yes')).replies[0], /Cancelled 1 open task/);
  assert.equal(s.assistant.store.listOpen().length, 0);
});

test('/pause and /resume persist; natural language pause understood', async () => {
  const s = await connected();
  assert.match((await s.send("Don't post anything today")).replies[0], /PAUSED until/);
  assert.match((await s.send('/status')).replies[0], /PAUSED/);
  assert.match((await s.send('/resume')).replies[0], /resumed/);
  assert.match((await s.send('Stop all scheduled posts for now')).replies[0], /until you send \/resume/);
  assert.match((await s.send('/pause for 2 hours')).replies[0], /until/);
  s.clock.t = new Date(s.clock.t.getTime() + 3 * 3600000);
  assert.match((await s.send('/status')).replies[0], /Automation: running/, 'timed pause auto-expires');
});

test('unbuilt features are refused honestly, never faked', async () => {
  const s = await connected();
  const r = (await s.send('Post this property on my status now')).replies[0];
  assert.match(r, /can't do that yet/);
  assert.match(r, /Nothing was posted or sent/);
  assert.equal(s.provider.statuses.length, 0);
});

test('invalid / unknown input does nothing', async () => {
  const s = await connected();
  assert.match((await s.send('asdf qwer')).replies[0], /did nothing/);
  assert.match((await s.send('/bogus')).replies[0], /Unknown command/);
  assert.match((await s.send('yes')).replies[0], /Nothing is waiting/);
});

test('self mode: owner self-chat works, bot echo is not re-processed', async () => {
  const s = await connected({ mode: 'self' });
  const own = { fromMe: true, chat: `${OWNER}@s.whatsapp.net`, from: OWNER };
  const r = await s.send('/status', own);
  assert.equal(r.replies.length, 1);
  const echoId = s.provider.sent[s.provider.sent.length - 1].id;
  const baseline = s.provider.sent.length;
  const echo = await s.send(r.replies[0], { ...own, id: echoId });
  assert.equal(echo.res.handled, false);
  assert.equal(s.provider.sent.length, baseline, 'no reply loop');
  const echo2 = await s.send(r.replies[0], { ...own, id: 'unseen-id' });
  assert.equal(echo2.res.reason, 'own_message', 'bot-prefixed text is never treated as a command');
  assert.equal(s.provider.sent.length, baseline);
  const other = await s.send('/status', { fromMe: true, chat: '2348111111111@s.whatsapp.net' });
  assert.equal(other.res.handled, false);
});

test('duplicate delivery of the same message id is processed once', async () => {
  const s = await connected();
  await s.send('/status', { id: 'same' });
  const again = await s.send('/status', { id: 'same' });
  assert.equal(again.res.handled, false);
  assert.equal(again.replies.length, 0);
});

test('stale queued messages (e.g. from while offline) are not executed', async () => {
  const s = await connected();
  const r = await s.send('/pause', { timestamp: s.clock.t.getTime() - 30 * 60000 });
  assert.equal(r.res.reason, 'stale');
  assert.match((await s.send('/status')).replies[0], /Automation: running/);
});

test('media-only message gets an honest text-only reply', async () => {
  const s = await connected();
  const r = await s.send('', { media: { type: 'image' } });
  assert.match(r.replies[0], /only read text/);
});

test('announces once on first connection, with restored task count', async () => {
  const s = setup();
  await s.provider.connect();
  await s.provider.disconnect(); await s.provider.connect();
  const online = s.provider.sent.filter((m) => /Assistant online/.test(m.text));
  assert.equal(online.length, 1);
});
