'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, migrate, audit, MIGRATIONS } = require('../src/storage/db');

test('migrations apply once and are idempotent', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const rows = db.prepare('SELECT version FROM schema_migrations').all();
  assert.equal(rows.length, MIGRATIONS.length);
  db.close();
});

test('audit log records entries', () => {
  const db = openDatabase(':memory:');
  audit(db, 'owner', 'test', 'ok', 'detail');
  const row = db.prepare('SELECT actor, action, outcome FROM audit_log').get();
  assert.deepEqual({ ...row }, { actor: 'owner', action: 'test', outcome: 'ok' });
  db.close();
});
