'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Versioned, append-only migrations. Later phases add entries; never edit old ones.
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT
      );`,
  },
];

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

function audit(db, actor, action, outcome, detail = null) {
  db.prepare('INSERT INTO audit_log (actor, action, outcome, detail) VALUES (?, ?, ?, ?)').run(actor, action, outcome, detail);
}

module.exports = { openDatabase, migrate, audit, MIGRATIONS };
