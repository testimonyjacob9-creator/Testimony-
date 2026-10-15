'use strict';
const { GeminiClient } = require('./gemini');

/**
 * Returns { enabled, reason, client }. When AI is off (flag or missing key) enabled=false and every
 * deterministic feature keeps working. "Enabled" means configured, NOT verified: use client.health().
 */
function createAi(config, logger, deps = {}) {
  const a = config.ai;
  if (!a.enabled) return { enabled: false, reason: a.disabledReason, client: null, model: a.model };
  return { enabled: true, reason: null, client: new GeminiClient(a, { logger, ...deps }), model: a.model };
}
module.exports = { createAi };
