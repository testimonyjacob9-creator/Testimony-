'use strict';
const { naira } = require('../properties/caption');

const aiActions = {
  ai_caption: {
    pausable: false,
    describe(ctx, task) {
      const { propertyId, versions, choice } = task.payload;
      const p = ctx.properties.getAny(propertyId);
      const lines = [`Listing: ${p ? `${p.ref} ${p.title || ''}`.trim() : 'not found'}`];
      versions.forEach((v, i) => lines.push(`${i === choice ? '>> ' : ''}*Option ${i + 1}*${i === choice ? ' (selected)' : ''}\n${v}`));
      lines.push('Written only from your saved details; your listing record is not changed. Nothing is posted.');
      if (versions.length > 1) lines.push('Say "use 2" to pick another option.');
      return { heading: 'New advert caption', pending: 'saved', confirm: `save option ${choice + 1} as this listing's caption`, lines };
    },
    async onConfirm(ctx, task) {
      const p = ctx.properties.get(task.payload.propertyId);
      if (!p) throw new Error('That listing no longer exists. Nothing was saved.');
      ctx.properties.update(p.id, { caption: task.payload.versions[task.payload.choice] });
      ctx.store.finish(task.id, '{}');
      return `Saved as the caption for ${p.ref}. Future posts of it will use this text (nothing was posted now).`;
    },
    async execute() { throw new Error('ai_caption runs only via confirmation'); },
  },
  ai_action: {
    pausable: false,
    describe(ctx, task) {
      const t = task.payload;
      if (t.op === 'schedule_cancel') {
        const ss = (t.scheduleIds || []).map((id) => ctx.schedules.get(id)).filter(Boolean);
        return { heading: 'Cancel schedule', pending: 'cancelled', confirm: 'cancel it permanently', lines: ss.map((s) => `S-${s.id} (${(ctx.properties.getAny(s.property_id) || {}).ref || '?'}) at ${s.time_local}`) };
      }
      const p = ctx.properties.getAny(t.propertyId);
      const who = p ? `${p.ref} ${p.title || ''}`.trim() : 'listing';
      if (t.op === 'set_status') return { heading: `Mark ${p ? p.ref : 'listing'} ${t.status}`, pending: 'changed', confirm: 'apply it', lines: [who, `Status: ${p ? p.status : '?'} -> ${t.status}`, t.status === 'available' ? 'Its paused schedules stay paused.' : 'Any posting schedules for it will be paused.'] };
      return { heading: `Edit ${p ? p.ref : 'listing'}`, pending: 'changed', confirm: 'apply it', lines: [who, `${t.field}: ${p && p[t.field] !== null && p[t.field] !== undefined ? (t.field === 'price' ? naira(p.price) : p[t.field]) : '(empty)'} -> ${t.value}`] };
    },
    async onConfirm(ctx, task) {
      const t = task.payload; const a = ctx.assistant;
      let msg;
      if (t.op === 'schedule_cancel') {
        msg = a.scheduleCancel((t.scheduleIds || []).map((id) => `S-${id}`).join(' '));
      } else {
        const p = ctx.properties.get(t.propertyId);
        if (!p) throw new Error('That listing no longer exists. Nothing was changed.');
        msg = t.op === 'set_status' ? a.propertyStatusChange(p, t.status) : a.propertyEdit(p, t.field, t.value);
      }
      ctx.store.finish(task.id, '{}');
      return msg;
    },
    async execute() { throw new Error('ai_action runs only via confirmation'); },
  },
};
module.exports = { aiActions };
