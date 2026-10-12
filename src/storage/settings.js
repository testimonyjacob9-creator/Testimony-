'use strict';
function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, JSON.stringify(value));
}
function deleteSetting(db, key) { db.prepare('DELETE FROM settings WHERE key = ?').run(key); }
module.exports = { getSetting, setSetting, deleteSetting };
