'use strict';
require('dotenv').config();
const fs = require('node:fs');
const { createHealthServer } = require('./http/health');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { openDatabase, audit } = require('./storage/db');
const { createProvider } = require('./providers');
const { Assistant } = require('./assistant');
const { createAi } = require('./ai');
const { acquireLease, renewLease, releaseLease, newInstanceId } = require('./storage/lease');
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

/**
 * On Render only a mounted disk survives restarts. A directory on the same filesystem device as `/` is ephemeral:
 * the database, WhatsApp session and media would silently vanish on the next deploy. Returns a warning string or null.
 */
function persistenceWarning(config, fsApi = fs) {
  if (!config.onRender || config.ephemeralOk) return null; // EPHEMERAL_OK=true: free hosting, acknowledged (reported at startup and in /status)
  try {
    const here = fsApi.statSync(config.dataDir).dev;
    const root = fsApi.statSync('/').dev;
    if (here === root) return `DATA_DIR (${config.dataDir}) is on the ephemeral filesystem, not a mounted disk: your database and WhatsApp login WILL BE LOST on the next deploy. Attach the persistent disk at /var/data (see docs/RENDER.md).`;
  } catch { return `Could not inspect DATA_DIR (${config.dataDir}) to confirm it is a persistent disk.`; }
  return null;
}

async function main() {
  silenceSignalNoise();
  let config;
  try { config = loadConfig(); } catch (e) { console.error(e.message); process.exit(1); }
  const logger = createLogger(config.logLevel);
  fs.mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });
  // Bind the web port FIRST so a host health check passes while the database and WhatsApp are still starting.
  let health = null;
  if (config.port) {
    health = createHealthServer({ port: config.port });
    try { logger.info({ port: await health.start() }, 'health endpoint listening on 0.0.0.0 (GET /health)'); }
    catch (e) { logger.error({ err: e.message }, 'could not start the health endpoint'); process.exit(1); }
  }
  if (config.ephemeralOk) logger.warn('EPHEMERAL_OK=true: storage is TEMPORARY. The database and WhatsApp login are lost on every restart; use /backup and expect to re-pair after restarts (docs/RENDER.md).');
  const diskWarning = persistenceWarning(config);
  if (diskWarning) logger.error(diskWarning);
  if (config.onRender && config.provider === 'mock') logger.warn('WHATSAPP_PROVIDER=mock on Render: nothing is sent or received. Set WHATSAPP_PROVIDER=baileys to run the real bot (docs/RENDER.md).');
  // A stray rejection from a library must not kill a healthy WhatsApp session; log the message only (never the object).
  process.on('unhandledRejection', (r) => logger.error({ err: String(r && r.message || r).slice(0, 200) }, 'unhandled promise rejection (ignored)'));
  process.on('uncaughtException', (e) => { logger.error({ err: String(e && e.message || e).slice(0, 200) }, 'uncaught exception; exiting so Render restarts the service'); process.exit(1); });

  const db = openDatabase(config.dbPath);
  const instanceId = newInstanceId();
  try { await acquireLease(db, instanceId); } catch (e) { console.error(e.message); process.exit(1); }
  let leaseLost = false;
  const lease = setInterval(() => {
    try { if (!renewLease(db, instanceId)) { leaseLost = true; logger.error('lost the instance lease to another process; shutting down to avoid double-posting'); shutdown('LEASE_LOST'); } } catch (e) { logger.warn({ err: e.message }, 'lease renewal failed'); }
  }, 15000); // deliberately NOT unref'd: this heartbeat also keeps the service alive (the mock provider holds no socket)
  const provider = createProvider(config, logger);
  const ai = createAi(config, logger);
  logger.info({ ai: ai.enabled ? `configured (${ai.model})` : `off: ${ai.reason}` }, 'AI helper');
  const assistant = new Assistant({ db, provider, config, logger, ai });
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
    clearInterval(lease); clearInterval(noiseTimer);
    try { if (health) await health.stop(); scheduler.stop(); campaigns.stop(); schedRunner.stop(); await provider.disconnect(); audit(db, 'system', 'shutdown', 'ok'); if (!leaseLost) releaseLease(db, instanceId); db.close(); } finally { process.exit(0); }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, SIGNAL_NOISE, persistenceWarning };
