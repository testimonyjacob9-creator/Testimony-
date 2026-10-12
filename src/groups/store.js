'use strict';
const { getSetting, setSetting } = require('../storage/settings');

/**
 * Group discovery cache (NOT authorization) and the marketing allowlist (explicit owner approval only).
 * Always keyed by the stable group JID, never by name.
 */
class GroupStore {
  constructor(db, clock = () => new Date()) { this.db = db; this.clock = clock; }
  _now() { return this.clock().toISOString(); }

  /** Record a fresh provider listing. Groups missing from it are marked inaccessible (kept for history). */
  upsertDiscovered(list) {
    const now = this._now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE groups SET accessible = 0').run();
      const up = this.db.prepare(`INSERT INTO groups (jid,name,size,can_send,accessible,first_seen,last_seen) VALUES (?,?,?,?,1,?,?)
        ON CONFLICT(jid) DO UPDATE SET name=excluded.name,size=excluded.size,can_send=excluded.can_send,accessible=1,last_seen=excluded.last_seen`);
      for (const g of list) up.run(g.id, g.name, g.size ?? null, g.canSend === null || g.canSend === undefined ? null : (g.canSend ? 1 : 0), now, now);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  _sorted(rows) { return rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.jid.localeCompare(b.jid)); }
  accessible() { return this._sorted(this.db.prepare('SELECT * FROM groups WHERE accessible = 1').all().map((r) => ({ ...r }))); }
  cachedAll() { return this._sorted(this.db.prepare('SELECT * FROM groups').all().map((r) => ({ ...r }))); }
  lastSeenAt() { const r = this.db.prepare('SELECT MAX(last_seen) AS t FROM groups').get(); return r && r.t ? new Date(r.t) : null; }
  find(jid) { const r = this.db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid); return r ? { ...r } : null; }

  approved() { return this.db.prepare('SELECT * FROM marketing_groups ORDER BY approved_at, jid').all().map((r) => ({ ...r })); }
  isApproved(jid) { return !!this.db.prepare('SELECT 1 FROM marketing_groups WHERE jid = ?').get(jid); }
  /** Apply an owner-confirmed change atomically. */
  applySelection({ add = [], remove = [] }) {
    const now = this._now();
    this.db.exec('BEGIN');
    try {
      const ins = this.db.prepare('INSERT OR IGNORE INTO marketing_groups (jid, name_at_approval, approved_at) VALUES (?,?,?)');
      for (const g of add) ins.run(g.jid, g.name, now);
      const del = this.db.prepare('DELETE FROM marketing_groups WHERE jid = ?');
      for (const jid of remove) del.run(jid);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  clearApproved() { return Number(this.db.prepare('DELETE FROM marketing_groups').run().changes); }

  postingEnabled() { return getSetting(this.db, 'groups.posting_enabled', false) === true; }
  setPostingEnabled(v) { setSetting(this.db, 'groups.posting_enabled', !!v); }
  saveView(view) { setSetting(this.db, 'groups.view', { ...view, at: this._now() }); }
  getView() { return getSetting(this.db, 'groups.view'); }
}
module.exports = { GroupStore };
