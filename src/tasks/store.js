'use strict';

/** Persistent task store. All state transitions are single guarded UPDATEs (safe against double execution). */
class TaskStore {
  constructor(db, clock = () => new Date()) { this.db = db; this.clock = clock; }
  _now() { return this.clock().toISOString(); }
  _hydrate(r) { return r ? { ...r, payload: JSON.parse(r.payload || '{}') } : null; }

  create({ kind, title, payload = {}, status, runAt = null, expiresAt = null }) {
    const now = this._now();
    const res = this.db.prepare(`INSERT INTO tasks (kind,title,payload,status,run_at,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(kind, title, JSON.stringify(payload), status, runAt, expiresAt, now, now);
    return Number(res.lastInsertRowid);
  }
  get(id) { return this._hydrate(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)); }

  expireStale() {
    return Number(this.db.prepare(`UPDATE tasks SET status='expired', updated_at=? WHERE status='proposed' AND expires_at IS NOT NULL AND expires_at <= ?`)
      .run(this._now(), this._now()).changes);
  }
  activeProposal() {
    this.expireStale();
    return this._hydrate(this.db.prepare(`SELECT * FROM tasks WHERE status='proposed' ORDER BY id DESC LIMIT 1`).get());
  }
  updateProposal(id, { title, payload, runAt, expiresAt }) {
    const t = this.get(id); if (!t || t.status !== 'proposed') return false;
    return Number(this.db.prepare(`UPDATE tasks SET title=?, payload=?, run_at=?, expires_at=?, updated_at=? WHERE id=? AND status='proposed'`)
      .run(title ?? t.title, JSON.stringify(payload ?? t.payload), runAt ?? t.run_at, expiresAt ?? t.expires_at, this._now(), id).changes) > 0;
  }
  schedule(id) { return this._move(id, ['proposed'], 'scheduled'); }
  cancel(id) { return this._move(id, ['proposed', 'scheduled'], 'cancelled'); }
  finish(id, result = null) {
    return Number(this.db.prepare(`UPDATE tasks SET status='done', result=?, updated_at=? WHERE id=? AND status IN ('proposed','running')`)
      .run(result, this._now(), id).changes) > 0;
  }
  _move(id, from, to) {
    const ph = from.map(() => '?').join(',');
    return Number(this.db.prepare(`UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status IN (${ph})`).run(to, this._now(), id, ...from).changes) > 0;
  }
  cancelAllOpen(exceptId = -1) {
    return Number(this.db.prepare(`UPDATE tasks SET status='cancelled', updated_at=? WHERE status IN ('proposed','scheduled') AND id != ?`)
      .run(this._now(), exceptId).changes);
  }
  listOpen() {
    this.expireStale();
    return this.db.prepare(`SELECT * FROM tasks WHERE status IN ('proposed','scheduled') ORDER BY (run_at IS NULL), run_at, id`).all().map((r) => this._hydrate(r));
  }
  dueTasks(limit = 20) {
    return this.db.prepare(`SELECT * FROM tasks WHERE status='scheduled' AND run_at <= ? ORDER BY run_at, id LIMIT ?`).all(this._now(), limit).map((r) => this._hydrate(r));
  }
  /** Atomic claim: returns true for exactly one caller. */
  claim(id) {
    return Number(this.db.prepare(`UPDATE tasks SET status='running', attempts=attempts+1, updated_at=? WHERE id=? AND status='scheduled'`).run(this._now(), id).changes) === 1;
  }
  retryLater(id, runAtIso, error) {
    this.db.prepare(`UPDATE tasks SET status='scheduled', run_at=?, last_error=?, updated_at=? WHERE id=? AND status='running'`).run(runAtIso, error, this._now(), id);
  }
  release(id) { this.db.prepare(`UPDATE tasks SET status='scheduled', attempts=MAX(attempts-1,0), updated_at=? WHERE id=? AND status='running'`).run(this._now(), id); }
  fail(id, error) { this.db.prepare(`UPDATE tasks SET status='failed', last_error=?, updated_at=? WHERE id=? AND status='running'`).run(error, this._now(), id); }
  /** After a crash, tasks stuck in "running" are re-queued (at-least-once delivery). */
  recoverRunning() { return Number(this.db.prepare(`UPDATE tasks SET status='scheduled', updated_at=? WHERE status='running'`).run(this._now()).changes); }
  counts() {
    this.expireStale();
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}
module.exports = { TaskStore };
