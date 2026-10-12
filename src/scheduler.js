'use strict';
const { actions } = require('./tasks/registry');
const { getPause } = require('./tasks/pause');
const { audit } = require('./storage/db');

/**
 * Persistent scheduler: polls SQLite for due tasks, so restarts lose nothing.
 * - Disconnected provider: tasks stay scheduled (no attempt is burned).
 * - Retries are limited; after maxAttempts the task is marked failed and the owner is told.
 * - Guarded claim() prevents the same task executing twice.
 */
class Scheduler {
  constructor({ ctx, intervalMs = 15000, maxAttempts = 3, retryBaseMs = 30000 }) {
    Object.assign(this, { ctx, intervalMs, maxAttempts, retryBaseMs, timer: null, busy: false });
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch((e) => this.ctx.logger?.error({ err: e.message }, 'tick failed')), this.intervalMs); this.timer.unref?.(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    const out = { done: 0, failed: 0, retried: 0 };
    try {
      const { ctx } = this;
      if (ctx.provider.connectionState() !== 'connected') return { skipped: 'disconnected' };
      const paused = getPause(ctx.db, ctx.clock()).paused;
      for (const task of ctx.store.dueTasks()) {
        const action = actions[task.kind];
        if (action && paused && action.pausable) continue;
        if (!ctx.store.claim(task.id)) continue;
        try {
          if (!action) throw new Error(`unknown task kind: ${task.kind}`);
          const result = await action.execute(ctx, task);
          ctx.store.finish(task.id, JSON.stringify(result || {}));
          audit(ctx.db, 'scheduler', `${task.kind}.execute`, 'ok', `T-${task.id}`);
          out.done++;
        } catch (e) {
          if (e.code === 'NOT_CONNECTED') { ctx.store.release(task.id); return { ...out, skipped: 'disconnected' }; }
          const attempts = task.attempts + 1;
          if (attempts >= this.maxAttempts || !action) {
            ctx.store.fail(task.id, e.message);
            audit(ctx.db, 'scheduler', `${task.kind}.execute`, 'failed', `T-${task.id}`);
            out.failed++;
            await this._notifyFailure(task, e.message);
          } else {
            ctx.store.retryLater(task.id, new Date(ctx.clock().getTime() + this.retryBaseMs * attempts).toISOString(), e.message);
            out.retried++;
          }
        }
      }
      return out;
    } finally { this.busy = false; }
  }

  async _notifyFailure(task, message) {
    const { ctx } = this;
    try { await ctx.provider.sendText(ctx.ownerJid, `${ctx.prefix} Task T-${task.id} (${task.kind}) FAILED after ${this.maxAttempts} attempts: ${message}. It was not completed.`); }
    catch (e) { ctx.logger?.error({ err: e.message }, 'could not notify owner of failure'); }
  }
}
module.exports = { Scheduler };
