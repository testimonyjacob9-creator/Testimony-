'use strict';
const { getSetting, setSetting, deleteSetting } = require('../storage/settings');

/** Global automation pause. Persisted, auto-expires. Never blocks owner reminders. */
function getPause(db, now) {
  const p = getSetting(db, 'pause');
  if (!p || !p.paused) return { paused: false, until: null };
  if (p.until && new Date(p.until) <= now) { deleteSetting(db, 'pause'); return { paused: false, until: null }; }
  return { paused: true, until: p.until ? new Date(p.until) : null };
}
function setPause(db, untilDate) { setSetting(db, 'pause', { paused: true, until: untilDate ? untilDate.toISOString() : null }); }
function clearPause(db) { deleteSetting(db, 'pause'); }

module.exports = { getPause, setPause, clearPause };
