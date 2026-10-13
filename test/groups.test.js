'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');
const { openDatabase } = require('../src/storage/db');

const G = (n, name, size = 50, extra = {}) => ({ id: `${100 + n}@g.us`, name, size, ...extra });
const NAMES = ['Ekpoma Properties', 'Benin Land Buyers', 'Lagos Realtors', 'Abuja Homes', 'Warri Business Club'];
const base = () => NAMES.map((n, i) => G(i + 1, n, 40 + i));
const AD = '3 bedroom apartment in Ekpoma, N25m. Call to inspect. Genuine title documents.';

async function ready(opts = {}) {
  const s = setup(opts.setup);
  await s.provider.connect();
  s.provider.setGroups(opts.groups || base());
  return s;
}
const text = (r) => r.replies.join('\n');
async function approve(s, nums) { await s.send('/groups'); await s.send(`select groups ${nums.join(', ')}`); return s.send('yes'); }
async function enable(s) { await s.send('/groups enable'); return s.send('yes'); }
const groupMsgs = (s) => s.provider.sent.filter((m) => m.jid.endsWith('@g.us'));

test('/groups lists groups with names and member counts, never raw IDs', async () => {
  const s = await ready();
  const t = text(await s.send('/groups'));
  assert.match(t, /1\. Abuja Homes \(43 members\)/);
  assert.match(t, /Ekpoma Properties/);
  assert.ok(!/@g\.us/.test(t), 'JIDs must not be exposed');
  assert.match(t, /does NOT authorise/);
});

test('empty group list is reported plainly, nothing fabricated', async () => {
  const s = await ready({ groups: [] });
  assert.match(text(await s.send('/groups')), /No groups found/);
});

test('fetch failure with no saved list: honest message, no invented groups', async () => {
  const s = await ready(); s.provider.listError = 'rate-overlimit';
  const t = text(await s.send('/groups'));
  assert.match(t, /couldn't fetch/); assert.match(t, /rate-overlimit/);
  assert.ok(!/Ekpoma/.test(t));
});

test('fetch failure after a good fetch: saved list is clearly labelled as unconfirmed', async () => {
  const s = await ready();
  await s.send('/groups'); s.provider.listError = 'boom';
  const t = text(await s.send('/groups'));
  assert.match(t, /Could not refresh/); assert.match(t, /NOT confirmed/); assert.match(t, /Ekpoma Properties/);
});

test('disconnected provider: no groups invented, failure audited, nothing crashes', async () => {
  const s = await ready(); await s.provider.disconnect();
  const r = await s.send('/groups');
  assert.equal(r.res.handled, true);
  assert.equal(r.replies.length, 0, 'cannot reply while disconnected');
  assert.ok(s.db.prepare("SELECT 1 FROM audit_log WHERE action='reply' AND outcome='failed'").get());
  await s.provider.connect();
  assert.match(text(await s.send('/groups')), /Ekpoma Properties/);
});

test('pagination: pages of 10, numbering continues, "next page" and /groups page N', async () => {
  const many = Array.from({ length: 25 }, (_, i) => G(i + 1, `Group ${String(i + 1).padStart(2, '0')}`));
  const s = await ready({ groups: many });
  const p1 = text(await s.send('/groups'));
  assert.match(p1, /Page 1\/3/); assert.match(p1, /10\. Group 10/); assert.ok(!/11\. /.test(p1));
  const p2 = text(await s.send('next page'));
  assert.match(p2, /11\. Group 11/); assert.match(p2, /20\. Group 20/); assert.match(p2, /Page 2\/3/);
  const p3 = text(await s.send('/groups page 3'));
  assert.match(p3, /25\. Group 25/);
  // numbers from any page address the same snapshot
  const d = text(await s.send('select groups 25'));
  assert.match(d, /\+ Group 25/);
});

test('discovering a group does NOT authorise it', async () => {
  const s = await ready();
  await s.send('/groups');
  assert.equal(s.assistant.groups.approved().length, 0);
  assert.match(text(await s.send('/groups selected')), /No groups are approved/);
});

test('natural-language selection: draft first, saved only after yes', async () => {
  const s = await ready();
  await s.send('/groups');
  const d = text(await s.send('Select groups 1, 3 and 5.'));
  assert.match(d, /NOT saved yet/);
  assert.match(d, /\+ Abuja Homes/); assert.match(d, /\+ Ekpoma Properties/); assert.match(d, /\+ Warri Business Club/);
  assert.equal(s.assistant.groups.approved().length, 0, 'nothing saved before confirmation');
  assert.match(text(await s.send('yes')), /3 groups are now approved/);
  assert.equal(s.assistant.groups.approved().length, 3);
  assert.equal(groupMsgs(s).length, 0, 'selecting must never message a group');
});

test('cancelling a selection leaves existing settings unchanged', async () => {
  const s = await ready();
  await approve(s, [1]);
  await s.send('select groups 2');
  assert.match(text(await s.send('no')), /Discarded/);
  assert.equal(s.assistant.groups.approved().length, 1);
});

test('invalid selection numbers change nothing', async () => {
  const s = await ready();
  await s.send('/groups');
  assert.match(text(await s.send('select groups 9')), /no group number 9/i);
  assert.equal(s.assistant.store.counts().proposed, undefined);
});

test('selecting without having listed groups first asks to run /groups', async () => {
  const s = await ready();
  assert.match(text(await s.send('select groups 1')), /Send \/groups first/);
});

test('deselect by name, by number, ambiguity and no-match', async () => {
  const s = await ready();
  await approve(s, [1, 2, 3, 4]);
  assert.match(text(await s.send('/groups selected')), /Approved marketing groups\* \(4\)/);
  const d = text(await s.send('Remove the Ekpoma Properties group.'));
  assert.match(d, /- Ekpoma Properties/);
  await s.send('yes');
  assert.equal(s.assistant.groups.approved().some((a) => a.name_at_approval === 'Ekpoma Properties'), false);
  assert.match(text(await s.send('remove the Atlantis group')), /No approved group matches/);
  s.provider.setGroups([G(1, 'Alpha Homes East'), G(2, 'Alpha Homes West')]);
  await s.send('/groups'); await s.send('select groups 1, 2'); await s.send('yes');
  assert.match(text(await s.send('remove the alpha homes group')), /More than one approved group/);
  const byNum = text(await s.send('/groups remove 1'));
  assert.match(byNum, /NOT saved yet/);
});

test('/groups clear needs confirmation', async () => {
  const s = await ready(); await approve(s, [1, 2]);
  assert.match(text(await s.send('/groups clear')), /clear ALL/);
  assert.equal(s.assistant.groups.approved().length, 2);
  await s.send('yes');
  assert.equal(s.assistant.groups.approved().length, 0);
});

test('selection and posting flag persist across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-'));
  const file = path.join(dir, 'a.sqlite');
  try {
    const a = await ready({ setup: { db: openDatabase(file) } });
    await approve(a, [1, 3]); await enable(a);
    const names = a.assistant.groups.approved().map((x) => x.jid);
    a.db.close();
    const b = await ready({ setup: { db: openDatabase(file) } });
    assert.deepEqual(b.assistant.groups.approved().map((x) => x.jid), names);
    assert.equal(b.assistant.groups.postingEnabled(), true);
    assert.match(text(await b.send('show my approved marketing groups')), /Approved marketing groups\* \(2\)/);
    b.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unauthorised users and group-originated commands cannot change the allowlist', async () => {
  const s = await ready();
  await s.send('/groups');
  const stranger = { from: '2348000000000', chat: '2348000000000@s.whatsapp.net' };
  assert.equal((await s.send('select groups 1', stranger)).res.handled, false);
  assert.equal((await s.send('yes', stranger)).res.handled, false);
  const fromGroup = { isGroup: true, chat: '101@g.us' };
  assert.equal((await s.send('/groups clear', fromGroup)).res.handled, false);
  assert.equal((await s.send('/groups enable', fromGroup)).res.handled, false);
  assert.equal(s.assistant.groups.approved().length, 0);
  assert.equal(s.assistant.groups.postingEnabled(), false);
});

test('group posting is OFF by default; enabling needs confirmation', async () => {
  const s = await ready(); await approve(s, [1]);
  assert.match(text(await s.send(`/advert ${AD}`)), /Group posting is OFF/);
  assert.match(text(await s.send('/groups enable')), /ENABLE group posting/);
  assert.equal(s.assistant.groups.postingEnabled(), false);
  await s.send('yes');
  assert.equal(s.assistant.groups.postingEnabled(), true);
});

test('advert: preview -> confirm -> paced send -> honest report', async () => {
  const s = await ready(); await approve(s, [1, 2, 3]); await enable(s);
  const d = text(await s.send(`/advert ${AD}`));
  assert.match(d, /Advert draft/); assert.match(d, /NOT sent yet/); assert.ok(d.includes(AD));
  assert.match(d, /1\. Abuja Homes|1\. /);
  assert.equal(groupMsgs(s).length, 0, 'nothing sent at draft time');
  const c = text(await s.send('yes'));
  assert.match(c, /STARTED \(not yet sent\)/);
  assert.equal(groupMsgs(s).length, 0, 'confirming starts the job; sending is done by the runner');
  const r = await s.runner.tick();
  assert.equal(r.finished.length, 1);
  assert.equal(groupMsgs(s).length, 3);
  assert.ok(groupMsgs(s).every((m) => m.text === AD));
  const report = s.provider.sent[s.provider.sent.length - 1].text;
  assert.match(report, /Accepted by WhatsApp: 3 of 3/);
  assert.match(report, /not proof anyone read it/);
  assert.ok(!/@g\.us/.test(report));
});

test('"Send this advertisement only to groups 2 and 4" targets approved-list numbers 2 and 4', async () => {
  const s = await ready(); await approve(s, [1, 2, 3, 4, 5]); await enable(s);
  const approved = s.assistant.groups.approved();
  const d = text(await s.send(`Send this advertisement only to groups 2 and 4: ${AD}`));
  assert.match(d, /Destinations \(2\)/);
  await s.send('yes'); await s.runner.tick();
  const sentTo = groupMsgs(s).map((m) => m.jid).sort();
  assert.deepEqual(sentTo, [approved[1].jid, approved[3].jid].sort());
});

test('change destinations before confirming: only / add / remove', async () => {
  const s = await ready(); await approve(s, [1, 2, 3]); await enable(s);
  await s.send(`/advert ${AD}`);
  assert.match(text(await s.send('only groups 1')), /Destinations \(1\)/);
  assert.match(text(await s.send('add group 3')), /Destinations \(2\)/);
  assert.match(text(await s.send('remove group 1')), /Destinations \(1\)/);
  assert.match(text(await s.send('remove group 3')), /no destinations/i);
  assert.match(text(await s.send('only groups 9')), /no approved group number 9/i);
});

test('cancelling before sending: nothing is created or sent', async () => {
  const s = await ready(); await approve(s, [1, 2]); await enable(s);
  await s.send(`/advert ${AD}`);
  assert.match(text(await s.send('no')), /Discarded/);
  assert.equal(s.assistant.campaigns.latest(), null);
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 0);
});

test('discovered-but-unapproved groups cannot receive adverts', async () => {
  const s = await ready(); await approve(s, [1]); await enable(s);
  assert.match(text(await s.send(`send this advertisement to groups 4: ${AD}`)), /no approved group number 4/i);
  // even a tampered/buggy queue row for an unapproved group is refused at send time
  const id = s.assistant.campaigns.create({ title: 't', message: AD, targets: [{ jid: '102@g.us', name: 'Not approved' }] });
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 0);
  assert.equal(s.assistant.campaigns.sends(id)[0].status, 'skipped');
  assert.match(s.assistant.campaigns.sends(id)[0].detail, /not on the approved/);
});

test('inaccessible saved group is skipped and reported; others still get the advert', async () => {
  const s = await ready(); await approve(s, [1, 2, 3]); await enable(s);
  const gone = s.assistant.groups.approved()[1];
  s.provider.setGroups(base().filter((g) => g.id !== gone.jid));
  assert.match(text(await s.send('/groups selected')), /NOT ACCESSIBLE/);
  await s.send(`/advert ${AD}`); await s.send('yes'); await s.runner.tick();
  assert.equal(groupMsgs(s).length, 2);
  assert.ok(!groupMsgs(s).some((m) => m.jid === gone.jid));
  const report = s.provider.sent[s.provider.sent.length - 1].text;
  assert.match(report, /Accepted by WhatsApp: 2 of 3/); assert.match(report, /no longer accessible/);
});

test('a group whose identifier changed is not messaged under the old name', async () => {
  const s = await ready(); await approve(s, [1]); await enable(s);
  const old = s.assistant.groups.approved()[0];
  s.provider.setGroups(base().map((g) => (g.id === old.jid ? { ...g, id: '999@g.us' } : g)));
  await s.send(`/advert ${AD}`); await s.send('yes'); await s.runner.tick();
  assert.equal(groupMsgs(s).length, 0, 'same name, different id: must NOT be sent');
});

test('renamed group is shown with its new name but still targeted by its stable id', async () => {
  const s = await ready(); await approve(s, [1]);
  const a = s.assistant.groups.approved()[0];
  s.provider.setGroups(base().map((g) => (g.id === a.jid ? { ...g, name: 'Renamed Group' } : g)));
  assert.match(text(await s.send('/groups selected')), /Renamed Group.*renamed from/);
});

test('partial failure: failed group reported honestly, others delivered, no auto-retry', async () => {
  const s = await ready(); await approve(s, [1, 2, 3]); await enable(s);
  const bad = s.assistant.groups.approved()[1];
  s.provider.failJids.add(bad.jid);
  await s.send(`/advert ${AD}`); await s.send('yes');
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 2);
  const report = s.provider.sent[s.provider.sent.length - 1].text;
  assert.match(report, /Accepted by WhatsApp: 2 of 3/); assert.match(report, /FAILED: .* - simulated send failure/);
  const before = s.provider.sent.length;
  await s.runner.tick(); await s.runner.tick();
  assert.equal(s.provider.sent.length, before, 'no retries, no second report');
});

test('duplicate protection: same advert is not re-sent to a group within the window', async () => {
  const s = await ready(); await approve(s, [1, 2]); await enable(s);
  await s.send(`/advert ${AD}`); await s.send('yes'); await s.runner.tick();
  const first = groupMsgs(s).length;
  const d = text(await s.send(`/advert ${AD}`));
  assert.match(d, /will be SKIPPED/);
  await s.send('yes'); await s.runner.tick();
  assert.equal(groupMsgs(s).length, first, 'no duplicates sent');
  assert.match(s.provider.sent[s.provider.sent.length - 1].text, /already sent to this group recently/);
});

test('restart mid-send: interrupted row becomes "unknown", is NEVER re-sent, and the owner is warned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-'));
  const file = path.join(dir, 'a.sqlite');
  try {
    const a = await ready({ setup: { db: openDatabase(file) } });
    await approve(a, [1, 2]); await enable(a);
    await a.send(`/advert ${AD}`); await a.send('yes');
    const c = a.assistant.campaigns.latest();
    const [first] = a.assistant.campaigns.sends(c.id);
    a.assistant.campaigns.claim(first.id); // crashed right after claiming
    a.db.close();
    const b = setup({ db: openDatabase(file) }); await b.provider.connect(); b.provider.setGroups(base());
    assert.equal(b.assistant.campaigns.sends(c.id)[0].status, 'unknown');
    assert.ok(b.provider.sent.some((m) => /interrupted by the restart/.test(m.text)));
    await b.runner.tick();
    const sentTo = b.provider.sent.filter((m) => m.jid.endsWith('@g.us')).map((m) => m.jid);
    assert.ok(!sentTo.includes(first.group_jid), 'interrupted destination must not be re-sent');
    assert.equal(sentTo.length, 1);
    assert.match(b.provider.sent[b.provider.sent.length - 1].text, /OUTCOME UNKNOWN/);
    b.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('global /pause holds adverts; /resume lets them continue', async () => {
  const s = await ready(); await approve(s, [1]); await enable(s);
  await s.send(`/advert ${AD}`); await s.send('yes');
  await s.send('/pause');
  assert.deepEqual(await s.runner.tick(), { skipped: 'paused' });
  assert.equal(groupMsgs(s).length, 0);
  await s.send('/resume');
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 1);
});

test('disabling group posting mid-campaign cancels the remaining sends', async () => {
  const s = await ready(); await approve(s, [1, 2]); await enable(s);
  await s.send(`/advert ${AD}`); await s.send('yes');
  await s.send('/groups disable');
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 0);
  assert.match(s.provider.sent[s.provider.sent.length - 1].text, /switched off/);
});

test('"stop the advert" cancels unsent destinations only', async () => {
  const s = await ready(); await approve(s, [1, 2, 3]); await enable(s);
  await s.send(`/advert ${AD}`); await s.send('yes');
  const r = text(await s.send('stop the advert'));
  assert.match(r, /3 pending send\(s\) cancelled/);
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 0);
});

test('provider disconnected: campaign waits, nothing is marked sent', async () => {
  const s = await ready(); await approve(s, [1]); await enable(s);
  await s.send(`/advert ${AD}`); await s.send('yes');
  await s.provider.disconnect();
  assert.deepEqual(await s.runner.tick(), { skipped: 'disconnected' });
  assert.equal(s.assistant.campaigns.sends(s.assistant.campaigns.latest().id)[0].status, 'pending');
});

test('listing failure at send time: destinations cannot be verified, so nothing is sent', async () => {
  const s = await ready(); await approve(s, [1]); await enable(s);
  await s.send(`/advert ${AD}`); await s.send('yes');
  s.provider.listError = 'boom';
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 0);
  s.provider.listError = null;
  await s.runner.tick();
  assert.equal(groupMsgs(s).length, 1);
});

test('admins-only groups where the account cannot post are skipped, not attempted', async () => {
  const s = await ready({ groups: [G(1, 'Announcements', 99, { canSend: false }), G(2, 'Open Group')] });
  await approve(s, [1, 2]); await enable(s);
  await s.send(`/advert ${AD}`); await s.send('yes'); await s.runner.tick();
  assert.equal(groupMsgs(s).length, 1);
  assert.match(s.provider.sent[s.provider.sent.length - 1].text, /only admins can post/);
});

test('per-advert group limit protects against spamming', async () => {
  const many = Array.from({ length: 6 }, (_, i) => G(i + 1, `Group ${i + 1}`));
  const s = await ready({ groups: many, setup: { env: { MAX_GROUPS_PER_CAMPAIGN: '3' } } });
  await approve(s, [1, 2, 3, 4, 5, 6]); await enable(s);
  assert.match(text(await s.send(`/advert ${AD}`)), /my limit is 3/);
  assert.match(text(await s.send(`/advert 1-3: ${AD}`)), /Destinations \(3\)/);
});

test('non-property text sent earlier can be used as the advert ("send this to my approved groups")', async () => {
  const s = await ready(); await approve(s, [1]); await enable(s);
  const note = 'Our annual landlords and tenants meeting holds this Saturday at 10am, everyone is invited please.';
  assert.match(text(await s.send(note)), /kept it for 30 min/);
  const d = text(await s.send('send this to my approved groups'));
  assert.match(d, /Advert draft/); assert.ok(d.includes(note));
});

test('provider without group support: refuses honestly', async () => {
  const s = await ready(); await approve(s, [1]); await enable(s);
  s.provider.capabilities = () => ({ groups: false });
  assert.match(text(await s.send(`/advert ${AD}`)), /cannot send to groups/);
});

test('a long property description becomes a property draft (not refused, not advertised)', async () => {
  const s = await ready();
  const r = text(await s.send('Spacious 3 bedroom house with land and a borehole in Ekpoma. Price N25m, genuine documents.'));
  assert.ok(!/can't do that yet/.test(r));
  assert.match(r, /PROP-001 saved as a DRAFT/);
  assert.equal(groupMsgs(s).length, 0);
});
