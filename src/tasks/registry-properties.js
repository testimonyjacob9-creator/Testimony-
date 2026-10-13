'use strict';
const propertyActions = {
  property_delete: {
    pausable: false,
    describe(ctx, task) {
      const p = ctx.properties.getAny(task.payload.propertyId);
      return { heading: `Draft: DELETE ${p ? p.ref : 'property'}`, pending: 'deleted', confirm: 'delete it', lines: [
        p ? `${p.title || p.ref} (${p.status}). Its photos/videos will be removed from disk.` : 'Property not found.',
        ctx.schedules ? `Active schedules for it (${ctx.schedules.forProperty(p.id).filter((s) => ['active', 'paused'].includes(s.status)).length}) will be cancelled.` : '',
      ].filter(Boolean) };
    },
    async onConfirm(ctx, task) {
      const p = ctx.properties.get(task.payload.propertyId);
      if (!p) throw new Error('That property no longer exists.');
      let cancelled = 0;
      if (ctx.schedules) cancelled = ctx.schedules.cancelForProperty(p.id);
      ctx.media.removeAll(p.id);
      ctx.properties.softDelete(p.id);
      ctx.store.finish(task.id, '{}');
      return `${p.ref} deleted${cancelled ? `; ${cancelled} schedule(s) cancelled` : ''}. Photos/videos removed.`;
    },
    async execute() { throw new Error('property_delete runs only via confirmation'); },
  },
};
module.exports = { propertyActions };
