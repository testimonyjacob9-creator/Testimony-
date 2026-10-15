'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { buildCaption } = require('../src/properties/caption');
const { extractItem, missingFields } = require('../src/properties/parse');

const c = (n) => ({ id: `23480000000${String(n).padStart(2, '0')}@s.whatsapp.net`, name: `C${n}` });
const bytes = (n, fill = 1) => Buffer.alloc(n, fill);
const photo = (buf) => ({ type: 'image', mime: 'image/jpeg', size: buf.length, open: async function* () { yield buf; } });
const text = (r) => r.replies.join('\n');
async function ready() { const s = setup(); await s.provider.connect(); s.provider.simulateContacts([c(1), c(2), c(3)]); return s; }
const sendItems = async (s, caps) => { let i = 0; for (const cap of caps) await s.send(cap, { media: photo(bytes(2000 + i * 13, 40 + ++i)) }); await s.assistant.flushMediaAck(); };

test('extractItem: keeps the owner\'s words, only a clearly stated price/phone is read', () => {
  assert.deepEqual(extractItem('4 unit ring curtain available'), { title: '4 unit ring curtain available' });
  assert.equal(extractItem('Washing machine ₦85,000 call 08031234567').price, 85000);
  assert.equal(extractItem('Washing machine ₦85,000 call 08031234567').contact, '08031234567');
  assert.equal(extractItem('Washing machine ₦85,000 call 08031234567').title, 'Washing machine');
  assert.equal(extractItem('Sofa set - 1.5 million').title, 'Sofa set');
  assert.equal(extractItem('2000 watts generator').price, undefined, 'a bare number is never taken as a price');
  assert.deepEqual(missingFields({ ptype: 'item', price: null, contact: null }), ['price', 'contact number']);
  assert.deepEqual(missingFields({ ptype: 'item', price: 5000, contact: '0803' }), []);
});

test('/contact saves a default number; each captioned photo becomes its own item with ONE combined reply', async () => {
  const s = await ready();
  assert.match(text(await s.send('/contact')), /No contact number is saved/);
  assert.match(text(await s.send('/contact abc')), /does not look like/);
  assert.match(text(await s.send('/contact 08031234567')), /Saved.*08031234567/);
  const before = s.provider.sent.length;
  await sendItems(s, ['4 unit ring curtain available', 'Washing machine ₦85,000', 'Standing fan ₦25,000']);
  const replies = s.provider.sent.slice(before).map((m) => m.text);
  assert.equal(replies.length, 1, 'one summary, not one message per photo');
  assert.match(replies[0], /Saved 3 item\(s\) as DRAFTS \(not posted anywhere\)/);
  assert.match(replies[0], /PROP-001 \| 4 unit ring curtain available \| price\? \| 1 photo/);
  assert.match(replies[0], /PROP-002 \| Washing machine \| ₦85,000 \| 1 photo/);
  assert.match(replies[0], /No price found for: PROP-001/);
  assert.doesNotMatch(replies[0], /No contact number on some items/, 'default contact applied');
  const p = s.assistant.properties.getByRef('PROP-001');
  assert.equal(p.ptype, 'item'); assert.equal(p.contact, '08031234567'); assert.equal(p.status, 'draft'); assert.equal(p.price, null);
  assert.equal(buildCaption(p, 'short'), '🛍 4 unit ring curtain available\n📞 08031234567');
  assert.match(buildCaption(s.assistant.properties.getByRef('PROP-002')), /💰 ₦85,000/);
  assert.equal(s.provider.statuses.length, 0, 'nothing posted');
});

test('done makes the whole batch available; "post these on my status now" is draft -> yes -> one queued post per item', async () => {
  const s = await ready();
  await s.send('/contact 08031234567');
  await sendItems(s, ['Standing fan ₦25,000', 'Wall clock ₦8,000']);
  assert.match(text(await s.send('done')), /2 item\(s\) are now AVAILABLE.*PROP-001, PROP-002/);
  const d = text(await s.send('post these on my status now'));
  assert.match(d, /Post items to Status/); assert.match(d, /PROP-001 Standing fan/); assert.match(d, /PROP-002 Wall clock/); assert.match(d, /3 known recipients/);
  assert.equal(s.provider.statuses.length, 0, 'draft only');
  assert.match(text(await s.send('yes')), /QUEUED \(PROP-001=S-1, PROP-002=S-2\)/);
  await s.sched.tick();
  assert.equal(s.provider.statuses.length, 2);
  const st = s.provider.statuses; assert.match(JSON.stringify(st[0].content), /Standing fan/); assert.match(JSON.stringify(st[1].content), /Wall clock/);
  const msgs = s.provider.sent.map((m) => m.text).join('\n');
  assert.match(msgs, /accepted by WhatsApp/); assert.doesNotMatch(msgs, /published to/i);
});

test('"post these" with nothing new, and an uncaptioned photo attaches to the last item', async () => {
  const s = await ready();
  assert.match(text(await s.send('post these on my status now')), /no items waiting to post/);
  await sendItems(s, ['Standing fan ₦25,000']);
  await s.send('', { media: photo(bytes(3000, 99)) }); await s.assistant.flushMediaAck();
  assert.equal(s.assistant.media.counts(1).images, 2);
  assert.equal(s.assistant.properties.list({}).length, 1);
});

test('real-estate captions still create PROPERTIES, not items; commands in captions never create items', async () => {
  const s = await ready();
  await s.send('Three-bedroom apartment available in Ekpoma. ₦25 million. Good location.', { media: photo(bytes(2000, 7)) });
  await s.assistant.flushMediaAck();
  assert.equal(s.assistant.properties.getByRef('PROP-001').ptype, 'apartment');
  await s.send('/status', { media: photo(bytes(2100, 8)) }); await s.assistant.flushMediaAck();
  assert.equal(s.assistant.properties.list({}).length, 1, '/ caption did not create an item');
});

test('post all items: only available items, capped at 10 per draft', async () => {
  const s = await ready();
  await sendItems(s, Array.from({ length: 12 }, (_, i) => `Item number ${i + 1} ₦${(i + 1) * 1000}`));
  await s.send('done');
  const d = text(await s.send('post all items on my status now'));
  assert.match(d, /only the first 10 are included; 2 more/);
});
