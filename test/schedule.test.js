'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');
const { openDatabase } = require('../src/storage/db');
const { loadConfig } = require('../src/config');

const c = (n) => ({ id: `23480000000${String(n).padStart(2, '0')}@s.whatsapp.net`, name: `C${n}` });
const bytes = (n, fill = 1) => Buffer.alloc(n, fill);
const photo = (buf) => ({ type: 'image', mime: 'image/jpeg', size: buf.length, open: async function* () { yield buf; } });
const text = (r) => r.replies.join('\n');
const at = (s, iso) => { s.clock.t = new Date(iso); };
const last = (s) => s.provider.sent[s.provider.sent.length - 1].text;
const T0 = '2026-10-12T10:00:00Z'; // Mon 11:00 Lagos
const DUE = '2026-10-13T07:00:20Z'; // Tue 08:00:20 Lagos

async function ready(o = {}) { const s = setup(o); await s.provider.connect(); s.provider.simulateContacts([c(1), c(2), c(3)]); return s; }
async function prop(s, { media = 0, ref = 1, body } = {}) {
  await s.send(body || 'Three bedroom apartment for sale in Ekpoma. N25m. Call 08031234567');
  for (let i = 0; i < media; i++) await s.send('', { media: photo(bytes(2000 + i * 7, ref * 10 + i + 1)) });
  await s.send('done'); await s.assistant.flushMediaAck();
  return s.assistant.properties.getByRef(`PROP-${String(ref).padStart(3, '0')}`);
}
async function activate(s, phrase = 'Post PROP-001 every morning at 8 AM') { const d = text(await s.send(phrase)); const y = text(await s.send('yes')); return { d, y }; }
const sched = (s, id = 1) => s.assistant.schedules.get(id);

test('spec flow: send property + photos, say "Post this every morning at 8 AM": draft first, NOTHING scheduled until yes', async () => {
  const s = await ready();
  await s.send('Three bedroom apartment for sale in Ekpoma. N25m. Call 08031234567');
  await s.send('', { media: photo(bytes(2100, 1)) }); await s.send('', { media: photo(bytes(2200, 2)) });
  const d = text(await s.send('Post this every morning at 8 AM.'));
  assert.match(d, /Recurring posting schedule T-\d+\* \(NOT active yet\)/);
  assert.match(d, /Property: PROP-001 3-bedroom apartment in Ekpoma/);
  assert.match(d, /Time: 8:00 AM daily \(Africa\/Lagos\)/);
  assert.match(d, /Destination: WhatsApp Status \(3 known recipients\)/);
  assert.match(d, /Start date: tomorrow \(first run Tue 13 Oct, 8:00 am\)/i);
  assert.match(d, /End date: until you stop it/);
  assert.match(d, /Media: 2 photo\(s\), 0 video\(s\)/);
  assert.match(d, /Note: PROP-001 is a draft; activating will mark it available/);
  assert.match(d, /Reply \*yes\* to activate/);
  assert.equal(s.assistant.schedules.list().length, 0, 'nothing scheduled before confirmation');
  assert.equal(s.assistant.properties.getByRef('PROP-001').status, 'draft');
  const y = text(await s.send('yes'));
  assert.match(y, /Schedule S-1 is ACTIVE/); assert.match(y, /Nothing has been posted yet/);
  assert.equal(s.assistant.properties.getByRef('PROP-001').status, 'available');
  assert.equal(s.provider.statuses.length, 0);
});

test('declining or cancelling the draft creates no schedule', async () => {
  const s = await ready(); await prop(s);
  await s.send('Post PROP-001 every day at 7 PM');
  assert.match(text(await s.send('no')), /Discarded/);
  assert.equal(s.assistant.schedules.list(['active', 'paused', 'cancelled', 'completed']).length, 0);
});

test('phrases from the brief: video daily 7 PM, Monday to Saturday 9 AM, tomorrow morning, and "now"', async () => {
  const s = await ready(); await prop(s);
  assert.match(text(await s.send('Post this video every day at 7 PM')), /7:00 PM daily/);
  assert.match(text(await s.send('Post this property Monday to Saturday at 9 AM')), /9:00 AM, Monday to Saturday/);
  assert.match(text(await s.send('Post this house tomorrow morning')), /8:00 AM once, on 2026-10-13/);
  const n = text(await s.send('Post this property on my status now'));
  assert.match(n, /now \(one-time\)/); assert.match(n, /Reply \*yes\* to post now/);
});

test('daily execution in Africa/Lagos: posts at 08:00 local, records the run, advances to the next day, never claims more than WhatsApp accepted', async () => {
  const s = await ready(); await prop(s, { media: 2 }); await activate(s);
  assert.equal(sched(s).next_run_at, '2026-10-13T07:00:00.000Z');
  assert.deepEqual(await s.sched.tick(), { results: [] }, 'not due yet');
  assert.equal(s.provider.statuses.length, 0);
  at(s, DUE);
  const before = s.provider.sent.length;
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 2, 'one Status per photo');
  assert.ok(s.provider.statuses[0].content.imagePath.includes('PROP-001'));
  assert.match(s.provider.statuses[0].content.caption, /3-bedroom apartment in Ekpoma/);
  assert.equal(s.provider.statuses[1].content.caption, undefined, 'caption only on the first item');
  assert.ok(s.provider.statuses.every((x) => x.content.recipients.length === 4 && x.content.recipients.includes('2340000000001@s.whatsapp.net')), 'contacts + own number');
  const report = s.provider.sent[before].text;
  assert.match(report, /Good morning! Your 8:00 AM routine has finished/);
  assert.match(report, /PROP-001 \(3-bedroom apartment in Ekpoma\): Status - accepted by WhatsApp for 3 recipient\(s\), 2\/2 item\(s\)\. I cannot confirm who actually saw it/);
  assert.match(report, /Group promotion: not scheduled/);
  assert.match(report, /Next run: Wed 14 Oct, 8:00 am/i);
  assert.ok(!/published/i.test(report), 'never says "published"');
  assert.equal(sched(s).next_run_at, '2026-10-14T07:00:00.000Z');
  const run = s.assistant.schedules.lastRun(1);
  assert.equal(run.status, 'success'); assert.equal(run.run_date, '2026-10-13');
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 2, 'no second post');
  assert.match(text(await s.send('show PROP-001')), /Posted: status x1/);
});

test('text-only property posts a text Status', async () => {
  const s = await ready(); await prop(s); await activate(s);
  at(s, DUE); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 1);
  assert.match(s.provider.statuses[0].content.text, /Ekpoma/);
});

test('schedules and runs survive a restart and then execute on time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-')); const file = path.join(dir, 'a.sqlite'); const data = path.join(dir, 'd');
  try {
    const a = await ready({ db: openDatabase(file), env: { DATA_DIR: data } });
    await prop(a, { media: 1 }); await activate(a); a.db.close();
    const b = setup({ db: openDatabase(file), env: { DATA_DIR: data } }); await b.provider.connect(); b.provider.simulateContacts([c(1), c(2)]);
    assert.match(text(await b.send('/schedule list')), /S-1 \| PROP-001 -> Status \| 8:00 AM daily/);
    at(b, DUE); await b.sched.tick();
    assert.equal(b.provider.statuses.length, 1);
    b.db.close();
    const c2 = setup({ db: openDatabase(file), env: { DATA_DIR: data }, start: '2026-10-13T07:01:00Z' }); await c2.provider.connect(); c2.provider.simulateContacts([c(1)]);
    await c2.sched.tick();
    assert.equal(c2.provider.statuses.length, 0, 'already ran today: not repeated after a restart');
    c2.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause, resume, cancel by natural language; resume never replays the missed time; cancelled never restarts', async () => {
  const s = await ready(); await prop(s); await activate(s);
  assert.match(text(await s.send('Pause the morning posts')), /Paused S-1/);
  assert.equal(sched(s).status, 'paused');
  at(s, DUE); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0, 'paused: nothing posted');
  assert.match(text(await s.send('Resume the schedule')), /Resumed S-1/);
  assert.equal(sched(s).status, 'active');
  assert.ok(new Date(sched(s).next_run_at) > s.clock.t, 'next run is in the future, no catch-up');
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0);
  assert.match(text(await s.send('/schedule cancel S-1')), /Cancelled S-1.*never restarts/);
  assert.match(text(await s.send('Resume the schedule')), /No paused schedule/);
  assert.match(text(await s.send('/schedule resume S-1')), /No paused schedule/);
  at(s, '2026-10-30T07:00:30Z'); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0, 'cancelled job stays dead');
  assert.equal(sched(s).status, 'cancelled');
});

test('"Stop posting the old apartment" resolves by words, asks when ambiguous', async () => {
  const s = await ready();
  await prop(s, { body: 'Old apartment for sale in Uromi. N9m. Call 08031234567' });
  await prop(s, { ref: 2, body: 'New apartment for sale in Auchi. N30m. Call 08031234567' });
  await activate(s, 'Post PROP-001 every morning at 8 AM'); await activate(s, 'Post PROP-002 every evening at 6 PM');
  const amb = text(await s.send('Stop posting the apartment'));
  assert.match(amb, /More than one property matches/);
  assert.match(text(await s.send('Stop posting the Uromi apartment')), /Paused S-1/);
  assert.equal(sched(s, 1).status, 'paused'); // reversible: "stop posting" pauses, only an explicit cancel is permanent
  assert.equal(sched(s, 2).status, 'active');
  assert.match(text(await s.send('Cancel S-1')), /Cancelled S-1/);
});

test('change the time: existing schedule by words, by id, and the draft before activation; ambiguity is asked', async () => {
  const s = await ready(); await prop(s); await activate(s);
  assert.match(text(await s.send('Change the posting time to 10 AM')), /S-1: 10:00 AM daily, next Tue 13 Oct, 10:00 am/i);
  assert.equal(sched(s).next_run_at, '2026-10-13T09:00:00.000Z');
  await s.send('Post PROP-001 every evening at 6 PM'); await s.send('yes');
  assert.match(text(await s.send('Change the posting time to 11 AM')), /Which schedule\?/);
  assert.match(text(await s.send('Move the evening status to 5 PM')), /S-2: 5:00 PM daily/);
  await s.send('/schedule cancel S-2');
  await s.send('Post PROP-001 every day at 3 PM');
  assert.match(text(await s.send('make it 4 PM')), /4:00 PM daily/);
  assert.match(text(await s.send('Monday to Saturday')), /4:00 PM, Monday to Saturday/);
  assert.match(text(await s.send('until 30 Nov')), /End date: 2026-11-30/);
  await s.send('yes');
  assert.equal(sched(s, 3).end_date, '2026-11-30');
});

test('global /pause holds posting; resuming inside the grace window posts, outside it the run is skipped as missed', async () => {
  const s = await ready(); await prop(s); await activate(s);
  at(s, DUE); await s.send('/pause');
  assert.deepEqual(await s.sched.tick(), { skipped: 'paused' });
  assert.equal(s.provider.statuses.length, 0);
  await s.send('/resume'); at(s, '2026-10-13T08:00:00Z'); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 1, 'within the grace window: posted');
  at(s, '2026-10-14T07:00:10Z'); await s.send('/pause'); at(s, '2026-10-14T11:00:00Z'); await s.send('/resume');
  const before = s.provider.statuses.length; await s.sched.tick();
  assert.equal(s.provider.statuses.length, before, 'too late: not posted');
  assert.match(last(s), /SKIPPED - missed: it was due at 8:00 AM.*did not post late/);
});

test('duplicate-run prevention: parallel ticks, repeated ticks, and a second runner over the same database', async () => {
  const s = await ready(); await prop(s, { media: 1 }); await activate(s);
  at(s, DUE);
  await Promise.all([s.sched.tick(), s.sched.tick(), s.sched.tick()]);
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 1);
  const { ScheduleRunner } = require('../src/schedule/runner');
  const other = new ScheduleRunner({ ctx: s.assistant.ctx });
  await other.tick();
  assert.equal(s.provider.statuses.length, 1);
  const sc = s.assistant.schedules; const row = sc.get(1);
  assert.equal(sc.claimRun(row, '2026-10-13', DUE, null, 'active'), null, 'the database refuses a second run for the same date');
});

test('missed run after downtime is skipped and reported, never posted late', async () => {
  const s = await ready(); await prop(s); await activate(s);
  at(s, '2026-10-13T12:30:00Z'); // 5.5h late
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0);
  assert.equal(s.assistant.schedules.lastRun(1).status, 'skipped');
  assert.match(last(s), /SKIPPED - missed/);
  assert.equal(sched(s).next_run_at, '2026-10-14T07:00:00.000Z');
});

test('provider disconnected at run time: nothing consumed, posts after reconnecting inside the grace window', async () => {
  const s = await ready(); await prop(s); await activate(s);
  at(s, DUE); await s.provider.disconnect();
  assert.deepEqual(await s.sched.tick(), { skipped: 'disconnected' });
  assert.equal(s.assistant.schedules.recentRuns().length, 0);
  await s.provider.connect(); at(s, '2026-10-13T07:30:00Z');
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 1);
});

test('SOLD protection: marking sold pauses its schedules; nothing posts; resume is blocked until it is available again', async () => {
  const s = await ready(); await prop(s); await activate(s);
  assert.match(text(await s.send('mark PROP-001 as sold')), /SOLD\. 1 schedule\(s\) for it were PAUSED/);
  assert.equal(sched(s).status, 'paused');
  at(s, DUE); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0);
  assert.match(text(await s.send('Resume the schedule')), /Not resumed: S-1 \(PROP-001 is sold\)/);
  assert.match(text(await s.send('Post PROP-001 every day at 9 AM')), /is sold, so I will not schedule/);
  await s.send('PROP-001 is available');
  assert.match(text(await s.send('Resume the schedule')), /Resumed S-1/);
});

test('SOLD protection at run time even if the status changed behind the scheduler\'s back', async () => {
  const s = await ready(); await prop(s); await activate(s);
  s.assistant.properties.setStatus(1, 'rented');
  at(s, DUE); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0);
  assert.match(last(s), /SKIPPED - the property is rented; this schedule is now PAUSED/);
  assert.equal(sched(s).status, 'paused');
});

test('media availability: a deleted file stops the post, honestly, with nothing partially posted', async () => {
  const s = await ready(); await prop(s, { media: 2 }); await activate(s);
  const m = s.assistant.media.forProperty(1)[1]; fs.unlinkSync(s.assistant.media.absolutePath(m.rel_path));
  at(s, DUE); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0);
  assert.match(last(s), /FAILED - 1 media file\(s\) are missing on disk, so nothing was posted/);
  assert.equal(s.assistant.schedules.lastRun(1).status, 'failed');
});

test('provider failure: limited retry, then success reported; a retry never re-sends items already accepted', async () => {
  const s = await ready(); await prop(s, { media: 3 }); await activate(s);
  at(s, DUE);
  // first item ok, second fails
  const orig = s.provider.publishStatus.bind(s.provider); let n = 0;
  s.provider.publishStatus = async (p) => { n++; if (n === 2) return { ok: false, verified: false, error: 'upload failed' }; return orig(p); };
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 1);
  assert.match(last(s), /attempt failed \(attempt 1 failed \(upload failed\); 1\/3 item\(s\) done\)\. Retrying at 8:02 AM/);
  assert.equal(s.assistant.schedules.lastRun(1).status, 'retry');
  await s.sched.tick(); assert.equal(s.provider.statuses.length, 1, 'not retried before the delay');
  at(s, '2026-10-13T07:02:30Z'); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 3, 'only the 2 remaining items were sent');
  assert.match(last(s), /accepted by WhatsApp for 3 recipient\(s\), 3\/3 item\(s\)/);
  const refs = s.provider.statuses.map((x) => path.basename(x.content.imagePath)); assert.equal(new Set(refs).size, 3, 'no file posted twice');
});

test('persistent failure: attempts are limited, final FAILED report, schedule stays active for tomorrow', async () => {
  const s = await ready(); await prop(s); await activate(s);
  s.provider.statusErrors = ['boom', 'boom', 'boom'];
  at(s, DUE); await s.sched.tick();
  at(s, '2026-10-13T07:03:00Z'); await s.sched.tick();
  assert.match(last(s), /FAILED - 0\/1 item\(s\) accepted; last error: boom/);
  assert.equal(s.assistant.schedules.lastRun(1).status, 'failed'); assert.equal(s.assistant.schedules.lastRun(1).attempts, 2);
  assert.equal(s.provider.statuses.length, 0);
  assert.equal(sched(s).status, 'active'); assert.equal(sched(s).next_run_at, '2026-10-14T07:00:00.000Z');
  assert.ok(!(s.assistant.properties.publications(1).length), 'a failed run records no publication');
});

test('empty audience: proposing is refused; if it empties after activation the run fails honestly', async () => {
  const s = setup(); await s.provider.connect();
  await prop(s);
  assert.match(text(await s.send('Post PROP-001 every morning at 8 AM')), /no known Status recipients/);
  s.provider.simulateContacts([c(1)]);
  await s.send('Post PROP-001 every morning at 8 AM'); await s.send('yes');
  s.assistant.audience.exclude('2340000000001'); s.assistant.audience.exclude('2348000000001');
  s.db.prepare("UPDATE contacts SET excluded = 1").run();
  at(s, DUE); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 0);
  assert.match(last(s), /FAILED - there are no known Status recipients/);
});

test('a crash during a post: interrupted item becomes "unknown", is never re-sent, and the owner is warned on restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch2-')); const file = path.join(dir, 'a.sqlite'); const data = path.join(dir, 'd');
  try {
    const a = await ready({ db: openDatabase(file), env: { DATA_DIR: data } });
    await prop(a, { media: 2 }); await activate(a);
    const sc = a.assistant.schedules; const row = sc.get(1);
    const run = sc.claimRun(row, '2026-10-13', '2026-10-13T07:00:00.000Z', '2026-10-14T07:00:00.000Z', 'active');
    sc.addItems(run.id, ['media:1', 'media:2']); const items = sc.items(run.id);
    sc.settleItem(items[0].id, 'sent', 'ok'); sc.claimItem(items[1].id); // crashed while sending #2
    a.db.close();
    const b = setup({ db: openDatabase(file), env: { DATA_DIR: data }, start: '2026-10-13T07:05:00Z' }); await b.provider.connect(); b.provider.simulateContacts([c(1)]);
    const r = b.assistant.schedules.getRun(run.id);
    assert.equal(r.status, 'unknown'); assert.match(r.detail, /will not repeat it/);
    assert.equal(b.assistant.schedules.items(run.id)[1].status, 'unknown');
    assert.ok(b.provider.sent.some((m) => /interrupted by the restart; their outcome is unknown/.test(m.text)));
    await b.sched.tick();
    assert.equal(b.provider.statuses.length, 0, 'nothing re-sent');
    b.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one-time schedule completes after it runs; "now" posts within the next tick', async () => {
  const s = await ready(); await prop(s);
  await s.send('Post PROP-001 tomorrow at 9 AM'); await s.send('yes');
  at(s, '2026-10-13T08:00:10Z'); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 1); assert.equal(sched(s).status, 'completed'); assert.equal(sched(s).next_run_at, null);
  await s.send('Post PROP-001 on my status now'); assert.match(text(await s.send('yes')), /QUEUED/);
  assert.equal(s.provider.statuses.length, 1, 'queued, not yet posted');
  await s.sched.tick(); assert.equal(s.provider.statuses.length, 2);
  assert.match(last(s), /accepted by WhatsApp/);
});

test('selected days skip the others; an end date stops the schedule', async () => {
  const s = await ready(); await prop(s);
  await s.send('Post PROP-001 Monday to Saturday at 9 AM until 17 Oct'); await s.send('yes');
  const times = []; 
  for (const d of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']) { at(s, `${d}T08:00:30Z`); const before = s.provider.statuses.length; await s.sched.tick(); times.push(s.provider.statuses.length - before); }
  assert.deepEqual(times, [1, 1, 1, 1, 1]);
  assert.equal(sched(s).status, 'completed', 'ended on 17 Oct');
  at(s, '2026-10-19T08:00:30Z'); await s.sched.tick();
  assert.equal(s.provider.statuses.length, 5);
});

test('Sunday is skipped for Monday-to-Saturday', async () => {
  const s = await ready(); await prop(s);
  await s.send('Post PROP-001 Monday to Saturday at 9 AM'); await s.send('yes');
  assert.equal(sched(s).next_run_at, '2026-10-13T08:00:00.000Z');
  const st = s.assistant.schedules;
  assert.equal(st.computeNext(sched(s), new Date('2026-10-17T08:30:00Z')).toISOString(), '2026-10-19T08:00:00.000Z');
});

test('identical schedules are refused; honest note when AM/PM is assumed', async () => {
  const s = await ready(); await prop(s); await activate(s);
  assert.match(text(await s.send('Post PROP-001 every morning at 8 AM')), /identical schedule already exists: S-1/);
  assert.match(text(await s.send('Post PROP-001 every day at 7')), /No AM\/PM given, assumed 7:00 AM/);
});

test('two schedules due together produce ONE combined report', async () => {
  const s = await ready(); await prop(s); await prop(s, { ref: 2, body: 'Two bedroom flat for rent in Auchi. N1.2m. Call 08031234567' });
  await activate(s, 'Post PROP-001 every morning at 8 AM'); await activate(s, 'Post PROP-002 every morning at 8 AM');
  s.assistant.properties.setStatus(2, 'sold');
  at(s, DUE); const before = s.provider.sent.length;
  await s.sched.tick();
  assert.equal(s.provider.sent.length - before, 1);
  assert.match(last(s), /PROP-001 .*accepted by WhatsApp/); assert.match(last(s), /PROP-002 .*SKIPPED/);
});

test('Channels are refused outright and never become a Status schedule', async () => {
  const s = await ready(); await prop(s);
  const r = text(await s.send('Post this property to my WhatsApp channel every day at 9 AM'));
  assert.match(r, /Channels is DISABLED/); assert.equal(s.assistant.schedules.list().length, 0);
  assert.equal(s.assistant.store.counts().proposed, undefined);
});

test('scheduled GROUP posts: need group posting enabled; run queues a campaign, never claims delivery; daily repeats are allowed; sold stops it', async () => {
  const s = await ready(); await prop(s);
  s.provider.setGroups([{ id: '101@g.us', name: 'Ekpoma Realtors', size: 40 }, { id: '102@g.us', name: 'Benin Buyers', size: 80 }]);
  assert.match(text(await s.send('Send this listing to my approved property groups at 9 AM')), /Group posting is OFF/);
  await s.send('/groups'); await s.send('select groups 1, 2'); await s.send('yes'); await s.send('/groups enable'); await s.send('yes');
  const d = text(await s.send('Send PROP-001 to my approved groups every day at 9 AM'));
  assert.match(d, /Destination: your approved WhatsApp groups \(2\), text only/); assert.match(d, /can annoy members/);
  await s.send('yes');
  at(s, '2026-10-13T08:00:10Z'); const before = s.provider.sent.length;
  await s.sched.tick();
  assert.match(s.provider.sent[before].text, /Groups - queued as advert C-1 for 2 group\(s\); the real results will be reported separately/);
  assert.ok(!/published|posted/i.test(s.provider.sent[before].text.split('\n')[2] || ''));
  assert.equal(s.provider.sent.filter((m) => m.jid.endsWith('@g.us')).length, 0, 'queued only; the group sender does the sending');
  await s.runner.tick();
  assert.equal(s.provider.sent.filter((m) => m.jid.endsWith('@g.us')).length, 2);
  at(s, '2026-10-14T08:00:10Z'); await s.sched.tick(); await s.runner.tick();
  assert.equal(s.provider.sent.filter((m) => m.jid.endsWith('@g.us')).length, 4, 'tomorrow\'s scheduled advert is sent again');
  await s.send('mark PROP-001 as sold');
  at(s, '2026-10-15T08:00:10Z'); await s.sched.tick(); await s.runner.tick();
  assert.equal(s.provider.sent.filter((m) => m.jid.endsWith('@g.us')).length, 4);
});

test('group schedule is skipped if group posting is switched off or the groups were un-approved', async () => {
  const s = await ready(); await prop(s);
  s.provider.setGroups([{ id: '101@g.us', name: 'Ekpoma Realtors', size: 40 }]);
  await s.send('/groups'); await s.send('select groups 1'); await s.send('yes'); await s.send('/groups enable'); await s.send('yes');
  await s.send('Send PROP-001 to my approved groups every day at 9 AM'); await s.send('yes');
  await s.send('/groups disable'); at(s, '2026-10-13T08:00:10Z'); await s.sched.tick();
  assert.match(last(s), /SKIPPED - group posting is OFF/);
  await s.send('/groups enable'); await s.send('yes'); await s.send('/groups clear'); await s.send('yes');
  at(s, '2026-10-14T08:00:10Z'); await s.sched.tick();
  assert.match(last(s), /SKIPPED - none of the saved groups are approved any more/);
  assert.equal(s.provider.sent.filter((m) => m.jid.endsWith('@g.us')).length, 0);
});

test('morning briefing: opt-in, once per day, inside a 3h window, lists today and warns; survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brf-')); const file = path.join(dir, 'a.sqlite'); const data = path.join(dir, 'd');
  try {
    const a = await ready({ db: openDatabase(file), env: { DATA_DIR: data } });
    await prop(a); await activate(a);
    assert.match(text(await a.send('/routine')), /OFF at 7:30 AM/);
    await a.send('/routine on');
    at(a, '2026-10-13T06:00:00Z'); let before = a.provider.sent.length; await a.sched.tick();
    assert.equal(a.provider.sent.length, before, '07:00 Lagos: before the briefing time');
    at(a, '2026-10-13T06:35:00Z'); await a.sched.tick();
    const b1 = last(a);
    assert.match(b1, /Good morning! Today is Tue 13 Oct/); assert.match(b1, /Scheduled today:\n- 8:00 AM {2}PROP-001 -> Status/); assert.match(b1, /Available properties: 1/);
    before = a.provider.sent.length; await a.sched.tick();
    assert.equal(a.provider.sent.length, before, 'only once per day');
    a.db.close();
    const b = setup({ db: openDatabase(file), env: { DATA_DIR: data }, start: '2026-10-13T06:50:00Z' }); await b.provider.connect(); b.provider.simulateContacts([c(1)]);
    before = b.provider.sent.length; await b.sched.tick();
    assert.equal(b.provider.sent.length, before, 'not repeated after a restart the same day');
    at(b, '2026-10-14T12:00:00Z'); await b.sched.tick(); assert.ok(!b.provider.sent.slice(before).some((m) => /Good morning! Today is/.test(m.text)), 'outside the 3h window');
    b.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('briefing warns about paused schedules, empty audience and global pause, and is still sent while paused', async () => {
  const s = setup(); await s.provider.connect(); await prop(s);
  s.provider.simulateContacts([c(1)]); await activate(s); await s.send('/schedule pause S-1');
  s.db.prepare('UPDATE contacts SET excluded = 1').run();
  await s.send('/pause'); await s.send('/routine on'); await s.send('/routine time 7:30am');
  at(s, '2026-10-13T06:40:00Z'); await s.sched.tick();
  assert.match(last(s), /Heads-up: S-1 is paused \(paused by you\); Status audience is EMPTY.*global automation pause is ON/);
});

test('"Show me everything scheduled for tomorrow" includes recurring posts; /schedule list and history work', async () => {
  const s = await ready(); await prop(s); await activate(s);
  assert.match(text(await s.send("Show me everything scheduled for tomorrow")), /Scheduled posts \(1\)[\s\S]*S-1 \| PROP-001/);
  assert.match(text(await s.send('/schedule')), /Schedules \(1\)/);
  at(s, DUE); await s.sched.tick();
  assert.match(text(await s.send('/schedule history')), /S-1 2026-10-13 \| success/);
});

test('only the owner can create, pause or cancel schedules', async () => {
  const s = await ready(); await prop(s); await activate(s);
  const stranger = { from: '2348111111111', chat: '2348111111111@s.whatsapp.net' };
  for (const m of ['/schedule cancel S-1', 'Pause the morning posts', 'Post PROP-001 every day at 5 PM', 'yes']) assert.equal((await s.send(m, stranger)).res.handled, false);
  assert.equal((await s.send('/schedule cancel S-1', { isGroup: true, chat: '1@g.us' })).res.handled, false);
  assert.equal(sched(s).status, 'active'); assert.equal(s.assistant.schedules.list().length, 1);
});

test('scheduling is refused when the provider cannot do it, and for properties that do not exist', async () => {
  const s = await ready(); await prop(s);
  s.provider.capabilities = () => ({ publishStatus: false, groups: true });
  assert.match(text(await s.send('Post PROP-001 every morning at 8 AM')), /cannot post Status updates/);
  s.provider.capabilities = () => ({ publishStatus: true, groups: true });
  assert.match(text(await s.send('Post PROP-099 every morning at 8 AM')), /could not find a matching property/);
  assert.match(text(await s.send('Post PROP-001 every morning')), /Draft|NOT active/);
});

test('config: new schedule settings are validated', () => {
  const base = { OWNER_PHONE: '2340000000001' };
  assert.equal(loadConfig(base).scheduleMaxAttempts, 2);
  assert.throws(() => loadConfig({ ...base, SCHEDULE_MAX_ATTEMPTS: '0' }), /SCHEDULE_MAX_ATTEMPTS/);
  assert.throws(() => loadConfig({ ...base, SCHEDULE_RETRY_DELAY_SECONDS: '99999' }), /SCHEDULE_RETRY_DELAY_SECONDS/);
  assert.throws(() => loadConfig({ ...base, MISSED_RUN_GRACE_MINUTES: '-1' }), /MISSED_RUN_GRACE_MINUTES/);
});
