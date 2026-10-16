'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');
const { openDatabase } = require('../src/storage/db');
const { MediaStore } = require('../src/media/store');
const { loadConfig } = require('../src/config');

const SPEC = 'Three-bedroom apartment available in Ekpoma. ₦25 million. Good location.';
const text = (r) => r.replies.join('\n');
const G = (n, name) => ({ id: `${100 + n}@g.us`, name, size: 30 });
const bytes = (n, fill = 1) => Buffer.alloc(n, fill);
const photo = (buf, mime = 'image/jpeg', extra = {}) => ({ type: 'image', mime, size: buf.length, open: async function* () { yield buf.subarray(0, 4); yield buf.subarray(4); }, ...extra });
const video = (buf) => ({ type: 'video', mime: 'video/mp4', size: buf.length, open: async function* () { yield buf; } });
async function ready(o = {}) { const s = setup(o); await s.provider.connect(); return s; }
const mediaDir = (s) => s.config.mediaDir;
const approveAll = async (s, n = 1) => { s.provider.setGroups(Array.from({ length: n }, (_, i) => G(i + 1, `Group ${i + 1}`))); await s.send('/groups'); await s.send(`select groups ${Array.from({ length: n }, (_, i) => i + 1).join(',')}`); await s.send('yes'); await s.send('/groups enable'); await s.send('yes'); };

test('intake: spec example becomes a structured DRAFT, asks for what is missing, invents nothing', async () => {
  const s = await ready();
  const r = text(await s.send(SPEC));
  assert.match(r, /PROP-001 saved as a DRAFT/); assert.match(r, /3-bedroom apartment in Ekpoma/); assert.match(r, /₦25,000,000/);
  assert.match(r, /Still missing: sale or rent, contact number/);
  const p = s.assistant.properties.getByRef('PROP-001');
  assert.equal(p.status, 'draft'); assert.equal(p.bedrooms, 3); assert.equal(p.location, 'Ekpoma'); assert.equal(p.price, 25000000);
  for (const k of ['listing', 'contact', 'bathrooms', 'land_size', 'agent', 'documentation']) assert.equal(p[k], null, `${k} must stay empty`);
  assert.equal(s.provider.statuses.length, 0);
});

test('filling the missing details, then "done" makes it available (still not posted)', async () => {
  const s = await ready();
  await s.send(SPEC);
  assert.match(text(await s.send('set contact to 08031234567')), /Updated PROP-001 contact: 08031234567/);
  assert.match(text(await s.send('Change the listing to sale')), /listing: sale/);
  assert.match(text(await s.send('done')), /PROP-001 is now AVAILABLE \(still not posted anywhere\)/);
  assert.match(text(await s.send('done')), /already available/);
  assert.equal(s.assistant.properties.getByRef('PROP-001').status, 'available');
});

test('"done" with nothing in progress does nothing', async () => {
  const s = await ready();
  assert.match(text(await s.send('done')), /no property in progress/);
});

test('non-property chatter is not turned into a property', async () => {
  const s = await ready();
  await s.send('Remind me to call the bank tomorrow at 9am'); await s.send('no');
  await s.send('what a lovely day it is today my friend, thanks');
  assert.equal(s.assistant.properties.list({}).length, 0);
});

test('photos and videos are stored privately on disk with relative paths; a burst gets ONE acknowledgement', async () => {
  const s = await ready();
  await s.send(SPEC);
  const before = s.provider.sent.length;
  await s.send('', { media: photo(bytes(2000, 1)) });
  await s.send('', { media: photo(bytes(2000, 2), 'image/png') });
  await s.send('', { media: video(bytes(5000, 3)) });
  assert.equal(s.provider.sent.length, before, 'no per-file chatter');
  await s.assistant.flushMediaAck();
  assert.equal(s.provider.sent.length, before + 1);
  assert.match(s.provider.sent[before].text, /Saved 3 file\(s\) to PROP-001.*2 photo\(s\) and 1 video\(s\)/);
  const rows = s.assistant.media.forProperty(1);
  assert.equal(rows.length, 3);
  for (const m of rows) {
    assert.ok(!/^https?:|^\//.test(m.rel_path), 'relative path, never a URL or absolute path');
    const abs = s.assistant.media.absolutePath(m.rel_path);
    assert.equal(fs.statSync(abs).size, m.size);
    assert.equal(fs.statSync(abs).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(mediaDir(s)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(mediaDir(s), 'tmp')), [], 'no temp files left behind');
});

test('duplicate uploads are ignored and reported', async () => {
  const s = await ready(); await s.send(SPEC);
  await s.send('', { media: photo(bytes(3000, 9)) }); await s.send('', { media: photo(bytes(3000, 9)) });
  await s.assistant.flushMediaAck();
  assert.equal(s.assistant.media.forProperty(1).length, 1);
  assert.match(s.provider.sent[s.provider.sent.length - 1].text, /1 duplicate\(s\) ignored/);
});

test('unsupported types, oversize declarations and mid-download overflow are refused; temp files cleaned', async () => {
  const s = await ready({ env: { MAX_MEDIA_MB: '1' } }); await s.send(SPEC);
  assert.match(text(await s.send('', { media: photo(bytes(100), 'image/gif') })), /unsupported file type/);
  assert.match(text(await s.send('', { media: { type: 'audio', mime: 'audio/ogg', size: 10 } })), /only store photos and videos/);
  assert.match(text(await s.send('', { media: photo(bytes(100), 'image/jpeg', { size: 5 * 1048576 }) })), /too large/);
  const liar = { type: 'video', mime: 'video/mp4', size: 100, open: async function* () { yield bytes(700000); yield bytes(700000); } };
  assert.match(text(await s.send('', { media: liar })), /could NOT save.*exceeded/);
  assert.equal(s.assistant.media.forProperty(1).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(mediaDir(s), 'tmp')), []);
});

test('download failure is reported honestly and leaves no junk property behind', async () => {
  const s = await ready();
  const broken = { type: 'image', mime: 'image/jpeg', size: 100, open: async function* () { throw new Error('download timed out'); } };
  assert.match(text(await s.send('', { media: broken })), /could NOT save that file: download timed out/);
  assert.equal(s.assistant.properties.list({}).length, 0);
  const noOpen = { type: 'image', mime: 'image/jpeg', size: 100 };
  assert.match(text(await s.send('', { media: noOpen })), /NOT saved/);
});

test('photos first, then the description fills the SAME draft', async () => {
  const s = await ready();
  await s.send('', { media: photo(bytes(2500, 4)) });
  assert.equal(s.assistant.properties.list({}).length, 1);
  await s.send(SPEC);
  assert.equal(s.assistant.properties.list({}).length, 1, 'no second draft');
  const p = s.assistant.properties.getByRef('PROP-001');
  assert.equal(p.location, 'Ekpoma'); assert.equal(s.assistant.media.forProperty(1).length, 1);
});

test('a photo whose caption is a property description creates the property with the photo', async () => {
  const s = await ready();
  await s.send(SPEC, { media: photo(bytes(2600, 5)) });
  await s.assistant.flushMediaAck();
  assert.match(s.provider.sent[s.provider.sent.length - 1].text, /PROP-001 saved as a DRAFT[\s\S]*Saved 1 file/);
  assert.equal(s.assistant.media.forProperty(1).length, 1);
});

test('media and properties persist across restart; a deleted file is detected before use', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-'));
  const file = path.join(dir, 'a.sqlite'); const dataDir = path.join(dir, 'data');
  try {
    const a = await ready({ db: openDatabase(file), env: { DATA_DIR: dataDir } });
    await a.send(SPEC); await a.send('', { media: photo(bytes(2800, 6)) }); await a.send('', { media: video(bytes(6000, 7)) });
    a.db.close();
    const b = await ready({ db: openDatabase(file), env: { DATA_DIR: dataDir } });
    assert.equal(b.assistant.properties.getByRef('PROP-001').price, 25000000);
    assert.deepEqual(b.assistant.media.check(1), { ok: true, missing: [] });
    const m = b.assistant.media.forProperty(1)[0];
    fs.unlinkSync(b.assistant.media.absolutePath(m.rel_path));
    const chk = b.assistant.media.check(1);
    assert.equal(chk.ok, false); assert.deepEqual(chk.missing, [m.rel_path]);
    b.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('media store refuses paths that escape the media directory', async () => {
  const s = await ready();
  assert.throws(() => s.assistant.media.absolutePath('../../etc/passwd'), /invalid media path/);
  assert.throws(() => s.assistant.media.absolutePath('/etc/passwd'), /invalid media path/);
});

test('strangers and group chats cannot upload media or create properties', async () => {
  const s = await ready();
  const stranger = { from: '2348111111111', chat: '2348111111111@s.whatsapp.net' };
  assert.equal((await s.send('', { ...stranger, media: photo(bytes(2000)) })).res.handled, false);
  assert.equal((await s.send(SPEC, stranger)).res.handled, false);
  assert.equal((await s.send(SPEC, { isGroup: true, chat: '1@g.us' })).res.handled, false);
  assert.equal(s.assistant.properties.list({}).length, 0);
  assert.deepEqual(fs.readdirSync(mediaDir(s)).filter((f) => f !== 'tmp'), []);
});

async function three(s) {
  await s.send('Two bedroom flat for rent in Ekpoma. N1.2 million. Call 08031112222'); await s.send('done');
  await s.send('Four bedroom duplex for sale in Benin City. N85 million. Call 08033334444'); await s.send('done');
  await s.send('Three bedroom apartment for sale in Ekpoma, N18m. Call 08035556666'); await s.send('done');
}

test('list, filters, show, ordinals and ambiguity', async () => {
  const s = await ready(); await three(s);
  const all = text(await s.send('/properties'));
  assert.match(all, /Properties\* \(3\)/); assert.match(all, /PROP-002 \| 4-bedroom duplex in Benin City/);
  const cheap = text(await s.send('show properties below 20 million'));
  assert.match(cheap, /PROP-001/); assert.match(cheap, /PROP-003/); assert.ok(!/PROP-002/.test(cheap));
  const ekp = text(await s.send('show properties in Ekpoma'));
  assert.ok(!/PROP-002/.test(ekp));
  await s.send('/properties');
  assert.match(text(await s.send('show the second property')), /\*PROP-002\*/);
  assert.match(text(await s.send('show PROP-003')), /Price: ₦18,000,000/);
  assert.match(text(await s.send('show properties')), /Properties/);
  const amb = text(await s.send('mark the apartment as sold')); // only one apartment -> unambiguous
  assert.match(amb, /PROP-003 is now SOLD/);
  s.assistant.properties.create({ title: 'Old apartment in Uromi', location: 'Uromi', ptype: 'apartment' }, 'available');
  s.assistant.properties.create({ title: 'New apartment in Auchi', location: 'Auchi', ptype: 'apartment' }, 'available');
  const ask = text(await s.send('show the old apartment and also apartment'));
  assert.ok(/More than one property matches|PROP-004/.test(ask));
  assert.match(text(await s.send('show PROP-099')), /could not find/);
});

test('edit, status changes, delete rules', async () => {
  const s = await ready(); await three(s);
  assert.match(text(await s.send('Change the price of PROP-001 to 1.5 million')), /price: ₦1,500,000/);
  assert.match(text(await s.send('/property set PROP-001 bedrooms 3')), /bedrooms: 3/);
  assert.match(text(await s.send('/property set PROP-001 price banana')), /could not read/);
  assert.match(text(await s.send('/property set PROP-001 listing swap')), /sale, rent or lease/);
  assert.match(text(await s.send('mark PROP-002 as sold')), /SOLD/);
  assert.match(text(await s.send('PROP-002 is available')), /AVAILABLE/);
  const d = text(await s.send('delete PROP-001'));
  assert.match(d, /DELETE PROP-001/); assert.ok(s.assistant.properties.getByRef('PROP-001'), 'not deleted before confirmation');
  assert.match(text(await s.send('yes')), /PROP-001 deleted/);
  assert.equal(s.assistant.properties.getByRef('PROP-001'), null);
  s.assistant.properties.create({ title: 'tmp' }, 'draft');
  assert.match(text(await s.send('delete PROP-004')), /Draft PROP-004 deleted/);
  const p5 = s.assistant.properties.create({}, 'draft');
  assert.notEqual(p5.ref, 'PROP-001', 'references are never reused');
});

test('deleting a property removes its media from disk', async () => {
  const s = await ready(); await s.send(SPEC); await s.send('', { media: photo(bytes(2000, 8)) }); await s.send('done');
  const rel = s.assistant.media.forProperty(1)[0].rel_path; const abs = s.assistant.media.absolutePath(rel);
  assert.ok(fs.existsSync(abs));
  await s.send('delete PROP-001'); await s.send('yes');
  assert.ok(!fs.existsSync(abs));
});

test('captions use only stored fields and a custom caption overrides', async () => {
  const s = await ready(); await s.send(SPEC);
  const c = text(await s.send('Prepare three different captions for this property'));
  assert.match(c, /\*Short \(Status\)\*/); assert.match(c, /\*Standard\*/); assert.match(c, /\*Detailed \(groups\)\*/);
  assert.match(c, /📍 Ekpoma/); assert.match(c, /₦25,000,000/);
  assert.ok(!/📞/.test(c), 'no contact line when contact unknown');
  assert.ok(!/bathroom/i.test(c), 'no invented bathrooms');
  assert.ok(!/FOR SALE|FOR RENT/.test(c), 'no invented sale/rent label');
  await s.send('/property set PROP-001 caption Lovely home, call now!');
  assert.match(text(await s.send('/caption PROP-001 short')), /Lovely home, call now!/);
});

test('property-linked group advert: draft refused, then text caption (no media saved), availability re-checked, publication recorded', async () => {
  const s = await ready(); await approveAll(s, 2);
  await s.send('Three bedroom apartment for sale in Ekpoma. N25m. Call 08031234567');
  assert.match(text(await s.send('send this to my approved groups')), /still a draft/);
  await s.send('done');
  const d = text(await s.send('send PROP-001 to my approved groups'));
  assert.match(d, /Advert draft/); assert.match(d, /Linked property: PROP-001/); assert.match(d, /if it has no media, only the text is sent/);
  await s.send('yes');
  await s.runner.tick();
  const sent = s.provider.sent.filter((m) => m.jid.endsWith('@g.us'));
  assert.equal(sent.length, 2); assert.match(sent[0].text, /₦25,000,000/); assert.match(sent[0].text, /Ref: PROP-001/);
  assert.match(text(await s.send('show PROP-001')), /Posted: group x2/);
});

test('sold property is never advertised, even if sold after the draft was confirmed', async () => {
  const s = await ready(); await approveAll(s, 2);
  await s.send('Three bedroom apartment for sale in Ekpoma. N25m. Call 08031234567'); await s.send('done');
  await s.send('send PROP-001 to my approved groups'); await s.send('yes');
  await s.send('mark PROP-001 as sold');
  await s.runner.tick();
  assert.equal(s.provider.sent.filter((m) => m.jid.endsWith('@g.us')).length, 0);
  assert.match(s.provider.sent[s.provider.sent.length - 1].text, /no longer available/);
  assert.match(text(await s.send('send PROP-001 to my approved groups')), /is sold, so I will not advertise it/);
});

test('properties persist across restart and references stay stable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop2-')); const file = path.join(dir, 'a.sqlite');
  try {
    const a = await ready({ db: openDatabase(file), env: { DATA_DIR: path.join(dir, 'd') } });
    await three(a); a.db.close();
    const b = await ready({ db: openDatabase(file), env: { DATA_DIR: path.join(dir, 'd') } });
    assert.match(text(await b.send('/properties')), /Properties\* \(3\)/);
    await b.send('Single room for rent in Auchi. N200k. Call 08037778888');
    assert.ok(b.assistant.properties.getByRef('PROP-004'));
    b.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function advertWithPhoto(s) {
  await s.send(SPEC); await s.send('', { media: photo(bytes(3000)) }); await s.send('done');
  await s.send('send PROP-001 to my approved groups');
  return s.send('yes');
}
const groupSent = (s) => s.provider.sent.filter((m) => m.jid.endsWith('@g.us'));

test('group advert with a saved photo: the photo goes out with the advert text as its caption (no text-only copy)', async () => {
  const s = await ready(); await approveAll(s, 2);
  const draft = text(await s.send(SPEC)); assert.ok(draft);
  await s.send('', { media: photo(bytes(3000)) }); await s.send('done');
  assert.match(text(await s.send('send PROP-001 to my approved groups')), /first photo/);
  await s.send('yes'); await s.runner.tick();
  const sent = groupSent(s);
  assert.equal(sent.length, 2);
  for (const m of sent) { assert.ok(m.media && m.media.imagePath, 'photo sent'); assert.match(m.media.caption, /Ref: PROP-001/); assert.equal(m.text, undefined, 'no text-only duplicate'); }
  assert.match(text(await s.send('show PROP-001')), /Posted: group x2/);
});

test('group advert: a missing photo file or a provider that cannot send photos FAILS that send instead of silently posting text', async () => {
  const s = await ready(); await approveAll(s, 2);
  await advertWithPhoto(s);
  const m = s.assistant.media.forProperty(1)[0];
  require('node:fs').unlinkSync(s.assistant.media.absolutePath(m.rel_path));
  await s.runner.tick();
  assert.equal(groupSent(s).length, 0, 'nothing posted');
  assert.match(s.provider.sent[s.provider.sent.length - 1].text, /photo file is missing/i);

  const t = await ready(); await approveAll(t, 2);
  const caps = t.provider.capabilities.bind(t.provider); t.provider.capabilities = () => ({ ...caps(), sendMedia: false });
  await advertWithPhoto(t); await t.runner.tick();
  assert.equal(groupSent(t).length, 0);
  assert.match(t.provider.sent[t.provider.sent.length - 1].text, /cannot send photos/i);
});

test('group advert: a caption over the WhatsApp limit sends the photo, then the full text; a failed photo sends no text', async () => {
  const s = await ready();
  const file = require('node:path').join(require('node:os').tmpdir(), `cap-${Date.now()}.jpg`); require('node:fs').writeFileSync(file, bytes(3000));
  const media = { kind: 'image', path: file }; const msg = 'Long advert text. '.repeat(70);
  const res = await s.runner._deliver('101@g.us', { message: msg }, media);
  assert.equal(res.ok, true);
  const sent = groupSent(s);
  assert.equal(sent.length, 2); assert.ok(sent[0].media && !sent[0].media.caption); assert.equal(sent[1].text, msg);
  s.provider.failNext = 'simulated photo failure';
  const bad = await s.runner._deliver('102@g.us', { message: msg }, media);
  assert.equal(bad.ok, false); assert.equal(groupSent(s).length, 2, 'no text after a failed photo');
});
