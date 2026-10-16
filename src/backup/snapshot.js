'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setPause } = require('../tasks/pause');

const MAGIC = 'SQLite format 3\u0000';
const MAX_BYTES = 20 * 1024 * 1024;
// Never copied from a backup: the single-instance lease and migration bookkeeping belong to THIS process, and listing media files are not part of backups.
const ALWAYS_SKIP = new Set(['instance_lease', 'schema_migrations', 'sqlite_sequence']);
const MEDIA_TABLE = 'property_media';
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const tmpFile = (ext) => path.join(os.tmpdir(), `olives-${crypto.randomBytes(6).toString('hex')}${ext}`);

/** Consistent copy of the live database (VACUUM INTO). Contains business data only: never the WhatsApp login. */
function exportSnapshot(db, file = tmpFile('.sqlite')) {
  db.exec(`VACUUM INTO ${lit(file)}`); fs.chmodSync(file, 0o600); return file;
}

function currentVersion(db) { return db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v || 0; }

/** Validates a file BEFORE it can touch live data. Never throws. */
function validateSnapshot(file, maxVersion) {
  let st; try { st = fs.statSync(file); } catch { return { ok: false, error: 'the file is missing' }; }
  if (!st.isFile() || st.size < 512) return { ok: false, error: 'that is not a valid backup file' };
  if (st.size > MAX_BYTES) return { ok: false, error: 'that file is too large to be an Olives backup' };
  let src;
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd);
    if (b.toString('latin1') !== MAGIC) return { ok: false, error: 'that is not an SQLite backup file' };
    src = new DatabaseSync(file, { readOnly: true });
    const ic = src.prepare('PRAGMA integrity_check').get();
    if (!ic || Object.values(ic)[0] !== 'ok') return { ok: false, error: 'the backup file is damaged (integrity check failed)' };
    const names = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of ['schema_migrations', 'settings', 'tasks', 'properties']) if (!names.has(t)) return { ok: false, error: 'that file is not an Olives backup' };
    const version = src.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v || 0;
    if (!version) return { ok: false, error: 'that file is not an Olives backup' };
    if (maxVersion && version > maxVersion) return { ok: false, error: 'that backup comes from a newer version of Olives than the one running' };
    const count = (t) => (names.has(t) ? src.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n : 0);
    return { ok: true, version, counts: { listings: count('properties'), schedules: count('schedules') } };
  } catch (e) { return { ok: false, error: `could not read that file (${String(e.message).slice(0, 80)})` }; }
  finally { try { src && src.close(); } catch { /* ignore */ } }
}

/**
 * Replaces the live data with a validated backup, inside ONE transaction: any failure rolls back and the current data stays untouched.
 * Listing media rows (and anything depending on them) are cleared because backups carry no photo/video files.
 * Automation is left PAUSED so that old schedules cannot re-post anything the moment data is restored.
 */
function restoreInPlace(db, file) {
  const v = validateSnapshot(file, currentVersion(db));
  if (!v.ok) return v;
  let attached = false; let began = false;
  db.exec('PRAGMA foreign_keys = OFF'); // must be changed outside a transaction
  try {
    db.exec(`ATTACH DATABASE ${lit(file)} AS bk`); attached = true;
    const main = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const bk = new Set(db.prepare("SELECT name FROM bk.sqlite_master WHERE type='table'").all().map((r) => r.name));
    const skip = new Set([...ALWAYS_SKIP, MEDIA_TABLE]);
    const cleared = new Set([MEDIA_TABLE]);
    for (let changed = true; changed;) { // anything that references a skipped/cleared table is cleared too
      changed = false;
      for (const t of main) {
        if (skip.has(t)) continue;
        if (db.prepare(`PRAGMA main.foreign_key_list(${q(t)})`).all().some((fk) => cleared.has(fk.table))) { skip.add(t); cleared.add(t); changed = true; }
      }
    }
    db.exec('BEGIN IMMEDIATE'); began = true;
    for (const t of cleared) if (main.includes(t)) db.exec(`DELETE FROM main.${q(t)}`);
    for (const t of main) {
      if (skip.has(t) || !bk.has(t)) continue;
      const have = new Set(db.prepare(`PRAGMA bk.table_info(${q(t)})`).all().map((c) => c.name));
      const cols = db.prepare(`PRAGMA main.table_info(${q(t)})`).all().map((c) => c.name).filter((c) => have.has(c));
      if (!cols.length) continue;
      const list = cols.map(q).join(', ');
      db.exec(`DELETE FROM main.${q(t)}`);
      db.exec(`INSERT INTO main.${q(t)} (${list}) SELECT ${list} FROM bk.${q(t)}`);
    }
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error('the backup is internally inconsistent');
    setPause(db, null);
    db.exec('COMMIT'); began = false;
    return { ok: true, counts: v.counts };
  } catch (e) {
    if (began) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
    return { ok: false, error: `restore failed and nothing was changed (${String(e.message).slice(0, 100)})` };
  } finally {
    if (attached) { try { db.exec('DETACH DATABASE bk'); } catch { /* ignore */ } }
    db.exec('PRAGMA foreign_keys = ON');
  }
}

module.exports = { exportSnapshot, validateSnapshot, restoreInPlace, currentVersion, tmpFile, MAX_BYTES, MAGIC };
