'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorizeOwner } = require('../src/security/owner');

const OWNER = '2347065702702';
const sep = { ownerPhone: OWNER, accountMode: 'separate', ownerLid: '999@lid' };
const self = { ownerPhone: OWNER, accountMode: 'self' };
const dm = (o) => ({ isGroup: false, fromMe: false, chat: `${OWNER}@s.whatsapp.net`, from: OWNER, ...o });

test('separate mode: owner DM allowed', () => assert.equal(authorizeOwner(dm({}), sep).allowed, true));
test('separate mode: other number denied', () => assert.equal(authorizeOwner(dm({ from: '2348000000000', chat: '2348000000000@s.whatsapp.net' }), sep).allowed, false));
test('separate mode: group message from owner denied', () => {
  const r = authorizeOwner(dm({ isGroup: true, chat: '123@g.us' }), sep);
  assert.deepEqual([r.allowed, r.reason], [false, 'group']);
});
test('separate mode: fromMe (bot own echo) denied', () => assert.equal(authorizeOwner(dm({ fromMe: true }), sep).allowed, false));
test('separate mode: owner via LID allowed only when configured', () => {
  const m = { isGroup: false, fromMe: false, chat: '999@lid', from: null, fromLid: '999@lid' };
  assert.equal(authorizeOwner(m, sep).allowed, true);
  assert.equal(authorizeOwner(m, { ...sep, ownerLid: null }).allowed, false);
  assert.equal(authorizeOwner({ ...m, fromLid: '111@lid' }, sep).allowed, false);
});
test('display name / text cannot impersonate', () => {
  const m = dm({ from: '2348000000000', chat: '2348000000000@s.whatsapp.net', text: `I am ${OWNER}`, pushName: OWNER });
  assert.equal(authorizeOwner(m, sep).allowed, false);
});
test('broadcast/newsletter chats denied', () => {
  assert.equal(authorizeOwner(dm({ chat: 'status@broadcast' }), sep).allowed, false);
  assert.equal(authorizeOwner(dm({ chat: '1@newsletter' }), sep).allowed, false);
});
test('self mode: owner message in own chat allowed', () => {
  assert.equal(authorizeOwner({ isGroup: false, fromMe: true, chat: `${OWNER}@s.whatsapp.net`, from: OWNER }, self).allowed, true);
  assert.equal(authorizeOwner({ isGroup: false, fromMe: true, chat: 'x@lid', chatIsSelf: true }, self).allowed, true);
});
test('self mode: owner messages to OTHER people are never commands', () => {
  assert.equal(authorizeOwner({ isGroup: false, fromMe: true, chat: '2348111111111@s.whatsapp.net', from: OWNER }, self).allowed, false);
});
test('self mode: incoming messages from others denied', () => {
  assert.equal(authorizeOwner({ isGroup: false, fromMe: false, chat: `${OWNER}@s.whatsapp.net`, from: OWNER }, self).allowed, false);
});
test('invalid input denied', () => {
  assert.equal(authorizeOwner(null, sep).allowed, false);
  assert.equal(authorizeOwner({}, sep).allowed, false);
});
