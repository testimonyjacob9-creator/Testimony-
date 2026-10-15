'use strict';
const crypto = require('node:crypto');

/**
 * Single-instance guard. Two processes sharing one SQLite file would double-post and fight over the
 * WhatsApp session, so exactly one holds a short renewable lease stored in the database itself.
 * A crashed holder is detected by its lease going stale (no heartbeat).
 */
const KEY = 'instance_lease';
const newInstanceId = () => crypto.randomBytes(8).toString('hex');

function tryAcquire(db, id, now, ttlMs) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    let cur = null; try { cur = row ? JSON.parse(row.value) : null; } catch { cur = null; }
    const stale = !cur || cur.id === id || now.getTime() - new Date(cur.at).getTime() > ttlMs;
    if (stale) db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(KEY, JSON.stringify({ id, at: now.toISOString() }));
    db.exec('COMMIT');
    return stale ? { ok: true } : { ok: false, holder: cur };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

/** Waits (default 60 s) for an old instance to finish shutting down during a redeploy, then gives up. */
async function acquireLease(db, id, { clock = () => new Date(), ttlMs = 45000, waitMs = 60000, pollMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const started = Date.now();
  for (;;) {
    const r = tryAcquire(db, id, clock(), ttlMs);
    if (r.ok) return true;
    if (Date.now() - started >= waitMs) {
      const e = new Error('Another assistant instance is already running against this database. Running two would double-post. Stop it (or scale this service to exactly 1 instance) and retry.');
      e.code = 'LEASE_HELD'; throw e;
    }
    await sleep(pollMs);
  }
}
function renewLease(db, id, clock = () => new Date(), ttlMs = 45000) { const r = tryAcquire(db, id, clock(), ttlMs); return r.ok; }
function releaseLease(db, id) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  try { if (row && JSON.parse(row.value).id === id) db.prepare('DELETE FROM settings WHERE key = ?').run(KEY); } catch { /* ignore */ }
}
module.exports = { acquireLease, renewLease, releaseLease, newInstanceId, tryAcquire };
