'use strict';
const { openDatabase } = require('../src/storage/db');
const { MockProvider } = require('../src/providers/mock');
const { Assistant } = require('../src/assistant');
const { Scheduler } = require('../src/scheduler');
const { CampaignRunner } = require('../src/groups/campaigns');
const { ScheduleRunner } = require('../src/schedule/runner');
const { loadConfig } = require('../src/config');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OWNER = '2340000000001';
let n = 0;

function setup({ db, mode = 'separate', start = '2026-10-12T10:00:00Z', provider, env = {}, ai = null } = {}) {
  const clock = { t: new Date(start) };
  const now = () => new Date(clock.t);
  const config = loadConfig({ OWNER_PHONE: `+${OWNER}`, ACCOUNT_MODE: mode, DATA_DIR: env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'asst-data-')), GROUP_SEND_DELAY_SECONDS: '0', MEDIA_ACK_DELAY_MS: '60000', ...env });
  const database = db || openDatabase(':memory:');
  const prov = provider || new MockProvider();
  if (prov.selfJidValue === null) prov.selfJidValue = `${OWNER}@s.whatsapp.net`;
  const assistant = new Assistant({ db: database, provider: prov, config, clock: now, ai });
  assistant.start();
  const scheduler = new Scheduler({ ctx: assistant.ctx, retryBaseMs: 1000 });
  const runner = new CampaignRunner({ ctx: assistant.ctx, sleep: async () => {} });
  const sched = new ScheduleRunner({ ctx: assistant.ctx });
  const send = async (text, over = {}) => {
    const before = prov.sent.length;
    const res = await assistant.handleInbound({
      id: `t${++n}`, from: OWNER, chat: `${OWNER}@s.whatsapp.net`, isGroup: false, fromMe: false,
      text, timestamp: clock.t.getTime(), ...over,
    });
    return { res, replies: prov.sent.slice(before).map((m) => m.text) };
  };
  return { clock, config, db: database, provider: prov, assistant, scheduler, runner, sched, send };
}
module.exports = { setup, OWNER };
