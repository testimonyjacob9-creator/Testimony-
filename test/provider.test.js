'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MockProvider } = require('../src/providers/mock');
const { createLogger } = require('../src/logger');

test('mock provider refuses to send while disconnected (honest failure)', async () => {
  const p = new MockProvider();
  const r = await p.sendText('x@s.whatsapp.net', 'hi');
  assert.equal(r.ok, false);
});

test('mock provider reports injected failures and never claims status verification', async () => {
  const p = new MockProvider();
  await p.connect();
  p.failNext = 'boom';
  assert.equal((await p.sendText('x', 'hi')).error, 'boom');
  const s = await p.publishStatus({ text: 'hello' });
  assert.equal(s.ok, true);
  assert.equal(s.verified, false);
});

test('logger redacts message content and secrets', () => {
  const lines = [];
  const log = createLogger('info', { write: (l) => lines.push(l) });
  log.info({ msg: { text: 'secret listing', token: 'abc' } }, 'inbound');
  assert.ok(!lines.join('').includes('secret listing'));
  assert.ok(!lines.join('').includes('abc'));
});
