'use strict';
const { openDatabase } = require('../src/storage/db');
const { MockProvider } = require('../src/providers/mock');
const { Assistant } = require('../src/assistant');
const { Scheduler } = require('../src/scheduler');
const { loadConfig } = require('../src/config');

const OWNER = '2347065702702';
let n = 0;

function setup({ db, mode = 'separate', start = '2026-10-12T10:00:00Z', provider } = {}) {
  const clock = { t: new Date(start) };
  const now = () => new Date(clock.t);
  const config = loadConfig({ OWNER_PHONE: `+${OWNER}`, ACCOUNT_MODE: mode, DATA_DIR: '/tmp/assistant-test' });
  const database = db || openDatabase(':memory:');
  const prov = provider || new MockProvider();
  const assistant = new Assistant({ db: database, provider: prov, config, clock: now });
  assistant.start();
  const scheduler = new Scheduler({ ctx: assistant.ctx, retryBaseMs: 1000 });
  const send = async (text, over = {}) => {
    const before = prov.sent.length;
    const res = await assistant.handleInbound({
      id: `t${++n}`, from: OWNER, chat: `${OWNER}@s.whatsapp.net`, isGroup: false, fromMe: false,
      text, timestamp: clock.t.getTime(), ...over,
    });
    return { res, replies: prov.sent.slice(before).map((m) => m.text) };
  };
  return { clock, config, db: database, provider: prov, assistant, scheduler, send };
}
module.exports = { setup, OWNER };
