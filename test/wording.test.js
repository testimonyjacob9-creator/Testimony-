'use strict';
// Plain-language wording: no slash commands needed. All mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { interpret } = require('../src/nlp/intent');
const { parsePrice } = require('../src/properties/parse');
const { loadConfig } = require('../src/config');
const { setup } = require('./helpers');

const it = (t, st = {}) => interpret(t, { now: new Date('2026-10-16T08:00:00+01:00'), tz: 'Africa/Lagos', hasActiveProperty: false, ...st });

test('plain phrases map to the same commands the slash forms run', () => {
  assert.deepEqual(it('Turn on group posting'), { intent: 'command', name: 'groups', args: 'enable' });
  assert.deepEqual(it('please switch off group posting'), { intent: 'command', name: 'groups', args: 'disable' });
  assert.deepEqual(it('Back up my data'), { intent: 'command', name: 'backup', args: '' });
  assert.deepEqual(it('send me a backup'), { intent: 'command', name: 'backup', args: '' });
  assert.deepEqual(it('check the AI'), { intent: 'command', name: 'ai', args: 'check' });
  assert.deepEqual(it('My contact number is 0801 234 5678'), { intent: 'command', name: 'contact', args: '08012345678' });
  assert.deepEqual(it('use 08012345678 as my contact'), { intent: 'command', name: 'contact', args: '08012345678' });
  assert.equal(it('save this property').intent, 'property_saved');
});

test('"price 70k each" is read as a price (a price word right before the number); bare numbers still are not', () => {
  assert.equal(parsePrice('Mouka Koko going for promo price 70k each'), 70000);
  assert.equal(parsePrice('Sharp speaker, price: 210k'), 210000);
  assert.equal(parsePrice('Clean use 12 pm 128gb nothing changed 78% 380k'), null, 'no price word and no currency: stay unsure');
  assert.equal(parsePrice('price 3 bedrooms'), null);
});

test('the AI wait defaults to 40 s and is still configurable', () => {
  assert.equal(loadConfig({ OWNER_PHONE: '2340000000000', GEMINI_API_KEY: 'k' }).ai.timeoutMs, 40000);
  assert.equal(loadConfig({ OWNER_PHONE: '2340000000000', GEMINI_API_KEY: 'k', AI_TIMEOUT_MS: '60000' }).ai.timeoutMs, 60000);
});

test('replies speak plainly: help leads with everyday phrases, hints do not demand slash commands', async () => {
  const s = setup(); await s.provider.connect();
  const help = (await s.send('help')).replies.join('\n');
  assert.match(help, /in your own words/i); assert.match(help, /Turn on group posting/);
  assert.ok(help.indexOf('Remind me') < help.indexOf('/status'), 'examples come before shortcuts');
  const off = (await s.send('post this property every morning on groups')).replies.join('\n');
  assert.doesNotMatch(off, /\/groups enable/);
});

test('"turn on group posting" starts the normal confirmation; nothing is enabled until "yes"', async () => {
  const s = setup(); await s.provider.connect();
  const r = (await s.send('turn on group posting')).replies.join('\n');
  assert.match(r, /yes/i);
  assert.equal(s.assistant.groups.postingEnabled(), false);
  await s.send('yes');
  assert.equal(s.assistant.groups.postingEnabled(), true);
});
