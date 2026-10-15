'use strict';
// Usage: npm run ai:check   (reads .env or the real environment; prints no secrets)
require('dotenv').config();
const { loadConfig } = require('../src/config');
const { createAi } = require('../src/ai');
(async () => {
  let config;
  try { config = loadConfig({ ...process.env, OWNER_PHONE: '2340000000000' }); } catch (e) { console.error(e.message); process.exit(2); }
  const ai = createAi(config);
  if (!ai.enabled) { console.log(`AI is OFF: ${ai.reason}.`); process.exit(1); }
  const h = await ai.client.health();
  console.log(h.ok ? `AI OK: model ${h.model} answered in ${h.latencyMs} ms.` : `AI NOT USABLE (${h.code}): ${h.message}. Model: ${h.model}.`);
  process.exit(h.ok ? 0 : 1);
})();
