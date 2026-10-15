'use strict';
const { localParts, zonedToUtc } = require('../nlp/time');

const isoDate = (date, tz) => { const p = localParts(date, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const addDaysIso = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Persistent schedules, per-date runs (UNIQUE guard) and per-item results. */
class ScheduleStore {
  constructor(db, clock = () => new Date()) { this.db = db; this.clock = clock; }
  _now() { return this.clock().toISOString(); }
  _s(r) { return r ? { ...r, days: r.days ? r.days.split(',').map(Number) : null, group_jids: r.group_jids ? JSON.parse(r.group_jids) : null } : null; }

  /** First occurrence strictly after `from` (a Date), honouring start/end dates, weekday set, one-off date. */
  computeNext(s, from) {
    const [hh, mm] = s.time_local.split(':').map(Number);
    const fp = localParts(from, s.timezone);
    let base = Date.UTC(fp.y, fp.m - 1, fp.d);
    const start = Date.parse(`${s.start_date}T00:00:00Z`);
    if (base < start) base = start;
    for (let i = 0; i < 400; i++) {
      const d = new Date(base + i * 86400000);
      const key = d.toISOString().slice(0, 10);
      if (s.end_date && key > s.end_date) return null;
      if (s.kind === 'once') { if (key > s.once_date) return null; if (key !== s.once_date) continue; }
      if (s.kind === 'days' && !s.days.includes(d.getUTCDay())) continue;
      const utc = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm, s.timezone);
      if (utc > from) return utc;
    }
    return null;
  }
  occursOn(s, key) {
    if (s.start_date > key || (s.end_date && key > s.end_date)) return false;
    if (s.kind === 'once') return s.once_date === key;
    if (s.kind === 'days') return s.days.includes(new Date(`${key}T00:00:00Z`).getUTCDay());
    return true;
  }

  create({ propertyId, destination, kind, time, days = null, onceDate = null, startDate, endDate = null, timezone, groupJids = null, immediate = false }) {
    const now = this.clock();
    const draft = { time_local: time, kind, days, once_date: onceDate, start_date: startDate, end_date: endDate, timezone };
    const next = immediate ? now : this.computeNext(draft, now);
    if (!next) throw new Error('that schedule has no future run');
    const res = this.db.prepare(`INSERT INTO schedules (property_id,destination,kind,time_local,days,once_date,start_date,end_date,timezone,group_jids,status,next_run_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`).run(propertyId, destination, kind, time, days ? days.join(',') : null, onceDate, startDate, endDate, timezone, groupJids ? JSON.stringify(groupJids) : null, next.toISOString(), now.toISOString(), now.toISOString());
    return this.get(Number(res.lastInsertRowid));
  }
  get(id) { return this._s(this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)); }
  list(statuses = ['active', 'paused']) {
    const ph = statuses.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM schedules WHERE status IN (${ph}) ORDER BY time_local, id`).all(...statuses).map((r) => this._s(r));
  }
  forProperty(pid) { return this.db.prepare('SELECT * FROM schedules WHERE property_id = ? ORDER BY id').all(pid).map((r) => this._s(r)); }
  _set(id, fields) {
    const cols = Object.keys(fields);
    this.db.prepare(`UPDATE schedules SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), this._now(), id);
  }
  pause(id, reason = 'paused by owner') {
    return Number(this.db.prepare(`UPDATE schedules SET status='paused', pause_reason=?, updated_at=? WHERE id=? AND status='active'`).run(reason, this._now(), id).changes) > 0;
  }
  /** Only a PAUSED schedule can resume; cancelled/completed are terminal so nothing silently reactivates. */
  resume(id) {
    const s = this.get(id); if (!s || s.status !== 'paused') return false;
    const next = this.computeNext(s, this.clock());
    if (!next) { this._set(id, { status: 'completed', next_run_at: null, pause_reason: null }); return false; }
    this._set(id, { status: 'active', pause_reason: null, next_run_at: next.toISOString() });
    return true;
  }
  cancel(id) {
    return Number(this.db.prepare(`UPDATE schedules SET status='cancelled', next_run_at=NULL, pause_reason=NULL, updated_at=? WHERE id=? AND status IN ('active','paused')`).run(this._now(), id).changes) > 0;
  }
  pauseForProperty(pid, reason) {
    return Number(this.db.prepare(`UPDATE schedules SET status='paused', pause_reason=?, updated_at=? WHERE property_id=? AND status='active'`).run(reason, this._now(), pid).changes);
  }
  cancelForProperty(pid) {
    return Number(this.db.prepare(`UPDATE schedules SET status='cancelled', next_run_at=NULL, updated_at=? WHERE property_id=? AND status IN ('active','paused')`).run(this._now(), pid).changes);
  }
  edit(id, { time, days, endDate }) {
    const s = this.get(id); if (!s || !['active', 'paused'].includes(s.status)) return false;
    const n = { ...s };
    if (time) n.time_local = time;
    if (days) { n.days = days; n.kind = 'days'; }
    if (endDate !== undefined) n.end_date = endDate;
    const next = s.status === 'active' ? this.computeNext(n, this.clock()) : null;
    this._set(id, { time_local: n.time_local, kind: n.kind, days: n.days ? n.days.join(',') : null, end_date: n.end_date, ...(s.status === 'active' ? { next_run_at: next ? next.toISOString() : null } : {}) });
    return true;
  }
  dueSchedules(nowIso) { return this.db.prepare(`SELECT * FROM schedules WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`).all(nowIso).map((r) => this._s(r)); }

  /**
   * Atomically record the run for this (schedule, local date) AND advance the schedule.
   * Returns the new run row, or null if a run for that date already exists (=> never execute twice).
   */
  claimRun(s, runDate, scheduledFor, nextAt, finalStatus) {
    this.db.exec('BEGIN');
    try {
      const res = this.db.prepare(`INSERT OR IGNORE INTO schedule_runs (schedule_id,run_date,scheduled_for,started_at,status,attempts) VALUES (?,?,?,?,'running',0)`)
        .run(s.id, runDate, scheduledFor, this._now());
      this._set(s.id, { next_run_at: nextAt, status: finalStatus });
      this.db.exec('COMMIT');
      return Number(res.changes) === 1 ? this.getRun(Number(res.lastInsertRowid)) : null;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getRun(id) { const r = this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id); return r ? { ...r } : null; }
  updateRun(id, f) {
    const cols = Object.keys(f);
    this.db.prepare(`UPDATE schedule_runs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => f[c]), id);
  }
  activeRun(scheduleId) { const r = this.db.prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? AND status IN ('running','retry') ORDER BY id DESC LIMIT 1`).get(scheduleId); return r ? { ...r } : null; }
  retryableRuns(nowIso) { return this.db.prepare(`SELECT * FROM schedule_runs WHERE status='retry' AND next_attempt_at <= ? ORDER BY id`).all(nowIso).map((r) => ({ ...r })); }
  recentRuns(scheduleId = null, limit = 8) {
    const rows = scheduleId
      ? this.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?').all(scheduleId, limit)
      : this.db.prepare('SELECT * FROM schedule_runs ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ ...r }));
  }
  lastRun(scheduleId) { return this.recentRuns(scheduleId, 1)[0] || null; }

  addItems(runId, refs) { const ins = this.db.prepare(`INSERT OR IGNORE INTO schedule_run_items (run_id,position,ref,status) VALUES (?,?,?,'pending')`); refs.forEach((r, i) => ins.run(runId, i + 1, r)); }
  items(runId) { return this.db.prepare('SELECT * FROM schedule_run_items WHERE run_id = ? ORDER BY position').all(runId).map((r) => ({ ...r })); }
  claimItem(id) { return Number(this.db.prepare(`UPDATE schedule_run_items SET status='sending' WHERE id=? AND status IN ('pending','failed')`).run(id).changes) === 1; }
  settleItem(id, status, detail = null, messageId = null) { this.db.prepare(`UPDATE schedule_run_items SET status=?, detail=?, message_id=? WHERE id=?`).run(status, detail, messageId, id); }

  /** After a crash: anything "sending" may or may not have posted. Never repeat it; report it honestly. */
  recoverInterrupted() {
    const stuck = this.db.prepare(`SELECT DISTINCT run_id FROM schedule_run_items WHERE status='sending'`).all().map((r) => r.run_id);
    const orphan = this.db.prepare(`SELECT id FROM schedule_runs WHERE status='running'`).all().map((r) => r.id);
    const runs = [...new Set([...stuck, ...orphan])];
    for (const id of runs) {
      this.db.prepare(`UPDATE schedule_run_items SET status='unknown', detail='interrupted by a restart; outcome unknown, check your Status' WHERE run_id=? AND status='sending'`).run(id);
      this.db.prepare(`UPDATE schedule_run_items SET status='skipped', detail='not attempted: the run was interrupted' WHERE run_id=? AND status='pending'`).run(id);
      this.db.prepare(`UPDATE schedule_runs SET status='unknown', finished_at=?, detail='interrupted by a restart; outcome unknown. Check your Status manually; I will not repeat it.' WHERE id=?`).run(this._now(), id);
    }
    return runs.length;
  }
}
module.exports = { ScheduleStore, isoDate, addDaysIso };
