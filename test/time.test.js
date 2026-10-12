'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWhen, nextLocalMidnight } = require('../src/nlp/time');

const TZ = 'Africa/Lagos';
const NOW = new Date('2026-10-12T10:00:00Z'); // Mon 11:00 Lagos
const iso = (r) => r.date.toISOString();

test('explicit PM today', () => assert.equal(iso(parseWhen('call John at 4 PM', NOW, TZ)), '2026-10-12T15:00:00.000Z'));
test('tomorrow morning', () => assert.equal(iso(parseWhen('tomorrow morning', NOW, TZ)), '2026-10-13T07:00:00.000Z'));
test('passed time rolls to tomorrow with assumption', () => {
  const r = parseWhen('at 9 AM', NOW, TZ);
  assert.equal(iso(r), '2026-10-13T08:00:00.000Z');
  assert.ok(r.assumptions.length);
});
test('relative duration', () => assert.equal(iso(parseWhen('in 2 hours', NOW, TZ)), '2026-10-12T12:00:00.000Z'));
test('tomorrow alone assumes 9AM and says so', () => {
  const r = parseWhen('tomorrow', NOW, TZ);
  assert.equal(iso(r), '2026-10-13T08:00:00.000Z');
  assert.match(r.assumptions[0], /9:00 AM/);
});
test('ambiguous "at 4" picks next occurrence and flags it', () => {
  const r = parseWhen('at 4', NOW, TZ);
  assert.equal(iso(r), '2026-10-12T15:00:00.000Z');
  assert.match(r.assumptions.join(' '), /assumed 4:00 PM/);
});
test('weekday', () => assert.equal(iso(parseWhen('friday at 10am', NOW, TZ)), '2026-10-16T09:00:00.000Z'));
test('explicit today in the past is an error, not a guess', () => assert.equal(parseWhen('today at 9am', NOW, TZ).error, 'past'));
test('no time expression -> null', () => assert.equal(parseWhen('call the buyer', NOW, TZ), null));
test('title remainder is extracted', () => assert.equal(parseWhen('contact this buyer at 4 PM', NOW, TZ).rest, 'contact this buyer'));
test('next local midnight (Lagos is UTC+1)', () => assert.equal(nextLocalMidnight(NOW, TZ).toISOString(), '2026-10-12T23:00:00.000Z'));
