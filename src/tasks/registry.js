'use strict';
const { formatLocal } = require('../nlp/time');

/**
 * Task kinds. Each kind declares whether it is `pausable` (blocked by /pause) and how to
 * confirm/execute. New business functions (status posts, group campaigns) register here.
 * Execute functions must THROW on failure so the scheduler can retry and report honestly.
 */
const actions = {
  reminder: {
    pausable: false,
    async onConfirm(ctx, task) {
      if (!ctx.store.schedule(task.id)) throw new Error('That draft is no longer pending.');
      const late = new Date(task.run_at) <= ctx.clock();
      return late
        ? `Reminder T-${task.id} scheduled. That time has already passed, so I'll send it right away.`
        : `Reminder T-${task.id} scheduled for ${formatLocal(new Date(task.run_at), ctx.config.timezone)}. I'll message you then.`;
    },
    async execute(ctx, task) {
      const overdueMin = Math.round((ctx.clock() - new Date(task.run_at)) / 60000);
      const late = overdueMin >= 5 ? ` (delayed ${overdueMin} min)` : '';
      const res = await ctx.provider.sendText(ctx.ownerJid, `${ctx.prefix} Reminder${late}: ${task.payload.text}`);
      if (!res.ok) { const e = new Error(res.error || 'send failed'); if (res.error === 'not connected') e.code = 'NOT_CONNECTED'; throw e; }
      return { messageId: res.id || null, accepted: true };
    },
  },
  cancel_all: {
    pausable: false,
    async onConfirm(ctx, task) {
      const n = ctx.store.cancelAllOpen(task.id);
      ctx.store.finish(task.id, JSON.stringify({ cancelled: n }));
      return `Cancelled ${n} open task${n === 1 ? '' : 's'}.`;
    },
    async execute() { throw new Error('cancel_all runs only via confirmation'); },
  },
};

Object.assign(actions, require('./registry-groups').groupActions);
Object.assign(actions, require('./registry-properties').propertyActions);
Object.assign(actions, require('./registry-schedules').scheduleActions);
Object.assign(actions, require('./registry-ai').aiActions);

module.exports = { actions };
