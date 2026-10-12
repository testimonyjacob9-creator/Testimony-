'use strict';
// Talk to the assistant in your terminal using the MOCK provider. Sends nothing to WhatsApp.
//   npm run dev:chat
const readline = require('node:readline');
const { openDatabase } = require('../src/storage/db');
const { MockProvider } = require('../src/providers/mock');
const { Assistant } = require('../src/assistant');
const { Scheduler } = require('../src/scheduler');
const { loadConfig } = require('../src/config');

(async () => {
  const config = loadConfig({ OWNER_PHONE: '2340000000000', ACCOUNT_MODE: 'separate', DATA_DIR: './data/dev' });
  const db = openDatabase(config.dbPath);
  const provider = new MockProvider();
  const assistant = new Assistant({ db, provider, config });
  const scheduler = new Scheduler({ ctx: assistant.ctx, intervalMs: 2000 });
  let shown = 0;
  const flush = () => { for (; shown < provider.sent.length; shown++) console.log('\n' + provider.sent[shown].text + '\n'); };
  assistant.start(); await provider.connect(); scheduler.start();
  setInterval(flush, 500).unref();
  flush();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    await provider.simulateInbound({ from: config.ownerPhone, chat: `${config.ownerPhone}@s.whatsapp.net`, text: line, timestamp: Date.now() });
    flush(); rl.prompt();
  });
  rl.on('close', () => { scheduler.stop(); db.close(); process.exit(0); });
})();
