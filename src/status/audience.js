'use strict';
const { getSetting, setSetting } = require('../storage/settings');
const { normalizePhone } = require('../config');

const PHONE_JID = /^(\d{5,20})(?::\d+)?@s\.whatsapp\.net$/;

/**
 * Status audience: the phone JIDs we will pass as `statusJidList`.
 * Only ever contains numbers learned from real provider events or entered by the owner. Never fabricated.
 * Contacts known only by an anonymous ID (@lid) cannot be targeted and are counted, not guessed.
 */
class AudienceStore {
  constructor(db, clock = () => new Date()) { this.db = db; this.clock = clock; }
  _now() { return this.clock().toISOString(); }

  ingest(list, source = 'sync') {
    const now = this._now();
    let added = 0;
    this.db.exec('BEGIN');
    try {
      const up = this.db.prepare(`INSERT INTO contacts (jid,name,source,excluded,first_seen,last_seen) VALUES (?,?,?,0,?,?)
        ON CONFLICT(jid) DO UPDATE SET last_seen = excluded.last_seen, name = COALESCE(excluded.name, contacts.name)`);
      const lid = this.db.prepare(`INSERT INTO contacts_lid_only (lid,last_seen) VALUES (?,?) ON CONFLICT(lid) DO UPDATE SET last_seen = excluded.last_seen`);
      for (const c of list || []) {
        const cand = [c.jid, c.id].find((x) => typeof x === 'string' && PHONE_JID.test(x));
        if (cand) {
          const jid = `${cand.match(PHONE_JID)[1]}@s.whatsapp.net`;
          const had = this.db.prepare('SELECT 1 FROM contacts WHERE jid = ?').get(jid);
          up.run(jid, c.name || c.notify || null, source, now, now);
          if (!had) added++;
        } else if (typeof c.id === 'string' && /@lid$/.test(c.id)) lid.run(c.id.replace(/:\d+@/, '@'), now);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return added;
  }

  mode() { return getSetting(this.db, 'audience.mode', 'all'); }
  setMode(m) { if (!['all', 'manual'].includes(m)) throw new Error('mode must be all or manual'); setSetting(this.db, 'audience.mode', m); }

  addManual(number) {
    const n = normalizePhone(number); if (!n) return null;
    const jid = `${n}@s.whatsapp.net`; const now = this._now();
    this.db.prepare(`INSERT INTO contacts (jid,name,source,excluded,first_seen,last_seen) VALUES (?,NULL,'manual',0,?,?)
      ON CONFLICT(jid) DO UPDATE SET source='manual', excluded=0, last_seen=excluded.last_seen`).run(jid, now, now);
    return jid;
  }
  /** Exclude from Status (kept in the table so a re-sync does not silently re-add them). */
  exclude(number) {
    const n = normalizePhone(number); if (!n) return null;
    const jid = `${n}@s.whatsapp.net`; const now = this._now();
    this.db.prepare(`INSERT INTO contacts (jid,name,source,excluded,first_seen,last_seen) VALUES (?,NULL,'manual',1,?,?)
      ON CONFLICT(jid) DO UPDATE SET excluded=1`).run(jid, now, now);
    return jid;
  }

  recipients(selfJid) {
    const rows = this.mode() === 'manual'
      ? this.db.prepare(`SELECT jid FROM contacts WHERE excluded = 0 AND source = 'manual'`).all()
      : this.db.prepare('SELECT jid FROM contacts WHERE excluded = 0').all();
    const set = new Set(rows.map((r) => r.jid));
    if (selfJid) set.add(selfJid); // so your other devices see your own status
    return [...set].sort();
  }
  /** Contacts only (without self), for honest "N recipients" reporting. */
  count() { return this.recipients(null).length; }
  stats() {
    const q = (sql) => Number(this.db.prepare(sql).get().n);
    return {
      mode: this.mode(),
      synced: q(`SELECT COUNT(*) n FROM contacts WHERE source='sync' AND excluded=0`),
      manual: q(`SELECT COUNT(*) n FROM contacts WHERE source='manual' AND excluded=0`),
      excluded: q('SELECT COUNT(*) n FROM contacts WHERE excluded=1'),
      lidOnly: q('SELECT COUNT(*) n FROM contacts_lid_only'),
      usable: this.count(),
    };
  }
}
module.exports = { AudienceStore };
