'use strict';
require('dotenv').config();
const fs = require('node:fs');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { openDatabase, audit } = require('./storage/db');
const { createProvider } = require('./providers');

async function main() {
  let config;
  try { config = loadConfig(); } catch (e) { console.error(e.message); process.exit(1); }
  const logger = createLogger(config.logLevel);
  fs.mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });

  const db = openDatabase(config.dbPath);
  const provider = createProvider(config);
  provider.onConnectionChange((s) => logger.info({ state: s }, 'connection state'));
  await provider.connect();
  audit(db, 'system', 'startup', 'ok');
  logger.info({ provider: config.provider, tz: config.timezone }, 'assistant started (Phase 1 foundation)');

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return; stopping = true;
    logger.info({ sig }, 'shutting down');
    try { await provider.disconnect(); audit(db, 'system', 'shutdown', 'ok'); db.close(); } finally { process.exit(0); }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
