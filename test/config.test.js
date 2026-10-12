'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, normalizePhone } = require('../src/config');

test('normalizePhone strips formatting and rejects junk', () => {
  assert.equal(normalizePhone('+234 801 234 5678'), '2348012345678');
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('123'), null);
});

test('loadConfig requires OWNER_PHONE', () => {
  assert.throws(() => loadConfig({}), /OWNER_PHONE/);
});

test('loadConfig applies safe defaults', () => {
  const c = loadConfig({ OWNER_PHONE: '2348012345678', DATA_DIR: '/tmp/x' });
  assert.equal(c.timezone, 'Africa/Lagos');
  assert.equal(c.provider, 'mock');
  assert.equal(c.dashboardEnabled, false);
});

test('loadConfig rejects bad timezone, provider and weak dashboard token', () => {
  const base = { OWNER_PHONE: '2348012345678' };
  assert.throws(() => loadConfig({ ...base, TIMEZONE: 'Mars/Base' }), /TIMEZONE/);
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PROVIDER: 'x' }), /WHATSAPP_PROVIDER/);
  assert.throws(() => loadConfig({ ...base, DASHBOARD_ENABLED: 'true', DASHBOARD_TOKEN: 'short' }), /DASHBOARD_TOKEN/);
});
