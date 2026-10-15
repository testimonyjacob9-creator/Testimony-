'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setup } = require('./helpers');
const { openDatabase } = require('../src/storage/db');
const { backup } = require('../scripts/backup');

test('backup captures properties, schedules and media consistently, excludes WhatsApp credentials by default, and is private', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')); const data = path.join(dir, 'data');
  try {
    const s = setup({ db: openDatabase(path.join(data, 'assistant.sqlite')), env: { DATA_DIR: data } }); await s.provider.connect();
    s.provider.simulateContacts([{ id: '2348000000001@s.whatsapp.net' }]);
    await s.send('Three bedroom apartment for sale in Ekpoma. N25m. Call 08031234567');
    await s.send('', { media: { type: 'image', mime: 'image/jpeg', size: 3000, open: async function* () { yield Buffer.alloc(3000, 7); } } });
    await s.send('done'); await s.send('Post PROP-001 every morning at 8 AM'); await s.send('yes');
    fs.mkdirSync(path.join(data, 'auth_state'), { recursive: true }); fs.writeFileSync(path.join(data, 'auth_state', 'creds.json'), '{"secret":1}');
    const out = backup({ dataDir: data, dest: path.join(dir, 'backups') });
    const b = new DatabaseSync(path.join(out, 'assistant.sqlite'));
    assert.equal(b.prepare("SELECT ref FROM properties").get().ref, 'PROP-001');
    assert.equal(Number(b.prepare("SELECT COUNT(*) n FROM schedules WHERE status='active'").get().n), 1);
    b.close();
    const rel = s.assistant.media.forProperty(1)[0].rel_path;
    assert.equal(fs.statSync(path.join(out, 'media', rel)).size, 3000);
    assert.ok(!fs.existsSync(path.join(out, 'auth_state')), 'credentials excluded by default');
    assert.equal(fs.statSync(path.join(out, 'assistant.sqlite')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    const withS = backup({ dataDir: data, dest: path.join(dir, 'backups2'), withSession: true });
    assert.ok(fs.existsSync(path.join(withS, 'auth_state', 'creds.json')));
    s.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
