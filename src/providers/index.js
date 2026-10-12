'use strict';
const { MockProvider } = require('./mock');

function createProvider(config) {
  if (config.provider === 'mock') return new MockProvider();
  if (config.provider === 'baileys') {
    throw new Error('The Baileys provider is added in Phase 2. Use WHATSAPP_PROVIDER=mock for now.');
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}

module.exports = { createProvider };
