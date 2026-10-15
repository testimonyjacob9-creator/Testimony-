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
  {
    version: 5,
    sql: `
      CREATE TABLE properties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT NOT NULL UNIQUE,
        title TEXT, location TEXT, ptype TEXT,
        listing TEXT CHECK (listing IS NULL OR listing IN ('sale','rent','lease')),
        price INTEGER, bedrooms INTEGER, bathrooms INTEGER, land_size TEXT,
        features TEXT, facilities TEXT, documentation TEXT, contact TEXT, agent TEXT,
        description TEXT, caption TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft','available','sold','rented','unavailable')),
        received_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE property_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        kind TEXT NOT NULL CHECK (kind IN ('image','video')),
        rel_path TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        original_name TEXT, position INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (property_id, sha256)
      );
      -- Where a listing actually went (accepted by WhatsApp), per destination.
      CREATE TABLE publications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        destination TEXT NOT NULL, detail TEXT, outcome TEXT NOT NULL, at TEXT NOT NULL
      );
      ALTER TABLE campaigns ADD COLUMN property_id INTEGER;`,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        destination TEXT NOT NULL CHECK (destination IN ('status','groups')),
        kind TEXT NOT NULL CHECK (kind IN ('daily','days','once')),
        time_local TEXT NOT NULL,
        days TEXT,
        once_date TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT,
        timezone TEXT NOT NULL,
        group_jids TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','paused','cancelled','completed')),
        pause_reason TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_sched_due ON schedules(status, next_run_at);
      -- One row per schedule per local date: the database itself prevents a duplicate run.
      CREATE TABLE schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id INTEGER NOT NULL REFERENCES schedules(id),
        run_date TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running','retry','success','queued','partial','failed','skipped','unknown')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        detail TEXT,
        recipients INTEGER,
        UNIQUE (schedule_id, run_date)
      );
      CREATE TABLE schedule_run_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES schedule_runs(id),
        position INTEGER NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','unknown','skipped')),
        detail TEXT,
        message_id TEXT,
        UNIQUE (run_id, position)
      );`,
  },
  {
    version: 7,
    // Universal listings: widen the status set (reserved, withdrawn) and add category-neutral columns.
    // SQLite cannot alter a CHECK constraint, so the table is rebuilt (documented SQLite procedure, FKs off).
    foreignKeysOff: true,
    sql: `
      CREATE TABLE properties_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT NOT NULL UNIQUE,
        title TEXT, location TEXT, ptype TEXT,
        listing TEXT CHECK (listing IS NULL OR listing IN ('sale','rent','lease')),
        price INTEGER, bedrooms INTEGER, bathrooms INTEGER, land_size TEXT,
        features TEXT, facilities TEXT, documentation TEXT, contact TEXT, agent TEXT,
        description TEXT, caption TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft','available','reserved','sold','rented','unavailable','withdrawn')),
        received_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        category TEXT, currency TEXT NOT NULL DEFAULT 'NGN', item_condition TEXT, quantity INTEGER, specs TEXT
      );
      INSERT INTO properties_new (id,ref,title,location,ptype,listing,price,bedrooms,bathrooms,land_size,features,facilities,documentation,contact,agent,description,caption,status,received_at,updated_at,deleted_at)
        SELECT id,ref,title,location,ptype,listing,price,bedrooms,bathrooms,land_size,features,facilities,documentation,contact,agent,description,caption,status,received_at,updated_at,deleted_at FROM properties;
      DROP TABLE properties;
      ALTER TABLE properties_new RENAME TO properties;
      UPDATE properties SET category = CASE WHEN ptype = 'item' THEN 'general' ELSE 'property' END WHERE category IS NULL;`,
  },
  {
    version: 8,
    sql: `
      -- Short, bounded conversation memory (what was said, what was resolved). Pruned by the application.
      CREATE TABLE conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner','assistant')),
        text TEXT NOT NULL,
        property_id INTEGER
      );
      CREATE INDEX idx_turns_at ON conversation_turns(id);`,
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
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF'); // must be set outside a transaction
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      if (m.foreignKeysOff) { const bad = db.prepare('PRAGMA foreign_key_check').all(); if (bad.length) throw new Error('migration left dangling foreign keys'); }
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON'); }
  }
}

function audit(db, actor, action, outcome, detail = null) {
  db.prepare('INSERT INTO audit_log (actor, action, outcome, detail) VALUES (?, ?, ?, ?)').run(actor, action, outcome, detail);
}

module.exports = { openDatabase, migrate, audit, MIGRATIONS };
