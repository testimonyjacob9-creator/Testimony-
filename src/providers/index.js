'use strict';
const { MockProvider } = require('./mock');

function createProvider(config, logger) {
  if (config.provider === 'mock') return new MockProvider();
  if (config.provider === 'baileys') {
    const { BaileysProvider } = require('./baileys');
    return new BaileysProvider({ config, logger });
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}

module.exports = { createProvider };
