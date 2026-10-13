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
  {
    version: 2,
    sql: `
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('proposed','scheduled','running','done','failed','cancelled','expired')),
        run_at TEXT,
        expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_due ON tasks(status, run_at);`,
  },
  {
    version: 3,
    sql: `
      -- Discovery cache: what the account could see. NOT an authorization list.
      CREATE TABLE groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER,
        can_send INTEGER,
        accessible INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      -- Marketing allowlist: only explicit owner approval puts a group here.
      CREATE TABLE marketing_groups (
        jid TEXT PRIMARY KEY,
        name_at_approval TEXT NOT NULL,
        approved_at TEXT NOT NULL
      );
      CREATE TABLE campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sending','done','cancelled')),
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE campaign_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        group_jid TEXT NOT NULL,
        group_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','skipped','unknown','cancelled')),
        detail TEXT,
        message_id TEXT,
        attempted_at TEXT,
        UNIQUE (campaign_id, group_jid)
      );
      CREATE INDEX idx_sends_pending ON campaign_sends(status, campaign_id);`,
  },
  {
    version: 4,
    sql: `
      -- Status audience candidates, learned ONLY from real provider events or manual entry.
      CREATE TABLE contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        source TEXT NOT NULL CHECK (source IN ('sync','manual')),
        excluded INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      -- Contacts WhatsApp identifies only by an anonymous ID: cannot be targeted, counted for honesty.
      CREATE TABLE contacts_lid_only (lid TEXT PRIMARY KEY, last_seen TEXT NOT NULL);`,
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
