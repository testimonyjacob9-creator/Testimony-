'use strict';
require('dotenv').config();
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { openDatabase, audit } = require('./storage/db');
const { createProvider } = require('./providers');
const { Assistant } = require('./assistant');
const { Scheduler } = require('./scheduler');
const { CampaignRunner } = require('./groups/campaigns');
const { ScheduleRunner } = require('./schedule/runner');

/** libsignal prints session dumps (including key material) and decrypt errors via console.*; hide them, count them. */
const SIGNAL_NOISE = /^(Closing session|Opening session|Removing old closed session|Migrating session|Failed to decrypt message|Session error)/;
const signalStats = { suppressed: 0, decryptFailures: 0 };
function silenceSignalNoise() {
  for (const m of ['info', 'warn', 'error', 'log']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => {
      if (typeof a[0] === 'string' && SIGNAL_NOISE.test(a[0])) {
        signalStats.suppressed++;
        if (/^(Failed to decrypt|Session error)/.test(a[0])) signalStats.decryptFailures++;
        return;
      }
      orig(...a);
    };
  }
}

async function main() {
  silenceSignalNoise();
  let config;
  try { config = loadConfig(); } catch (e) { console.error(e.message); process.exit(1); }
  const logger = createLogger(config.logLevel);
  fs.mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });

  const db = openDatabase(config.dbPath);
  const provider = createProvider(config, logger);
  const assistant = new Assistant({ db, provider, config, logger });
  const scheduler = new Scheduler({ ctx: assistant.ctx });
  const campaigns = new CampaignRunner({ ctx: assistant.ctx });
  const schedRunner = new ScheduleRunner({ ctx: assistant.ctx });
  const noiseTimer = setInterval(() => {
    if (signalStats.decryptFailures) { logger.warn({ decryptFailures: signalStats.decryptFailures }, 'some incoming messages could not be decrypted (suppressed libsignal output)'); signalStats.decryptFailures = 0; }
  }, 20000); noiseTimer.unref();
  assistant.start();
  scheduler.start();
  campaigns.start();
  schedRunner.start();
  await provider.connect();
  audit(db, 'system', 'startup', 'ok');
  logger.info({ provider: config.provider, tz: config.timezone }, 'assistant started');

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return; stopping = true;
    logger.info({ sig }, 'shutting down');
    try { scheduler.stop(); campaigns.stop(); schedRunner.stop(); await provider.disconnect(); audit(db, 'system', 'shutdown', 'ok'); db.close(); } finally { process.exit(0); }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, SIGNAL_NOISE };
