'use strict';
const { formatLocal } = require('../nlp/time');
const { isoDate } = require('../schedule/store');
const { buildCaption } = require('../properties/caption');
const { missingFields } = require('../properties/parse');

const DAYN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pretty = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
function daysLabel(days) {
  const d = [...days].sort((a, b) => a - b);
  if (d.join() === '1,2,3,4,5') return 'Monday to Friday';
  if (d.join() === '1,2,3,4,5,6') return 'Monday to Saturday';
  if (d.join() === '0,6') return 'weekends';
  return d.map((x) => DAYN[x]).join(', ');
}
function planLabel(plan) {
  if (plan.immediate) return 'now (one-time)';
  if (plan.kind === 'daily') return `${pretty(plan.time)} daily`;
  if (plan.kind === 'days') return `${pretty(plan.time)}, ${daysLabel(plan.days)}`;
  return `${pretty(plan.time)} once, on ${plan.onceDate}`;
}
const DEAD = ['sold', 'rented', 'unavailable'];

function duplicateOf(ctx, p, destination, plan) {
  return ctx.schedules.forProperty(p.id).find((s) => ['active', 'paused'].includes(s.status) && s.destination === destination && s.time_local === plan.time && s.kind === plan.kind && !plan.immediate);
}

const scheduleActions = {
  schedule_create: {
    pausable: false,
    describe(ctx, task) {
      const { propertyId, destination, plan, groupJids = [] } = task.payload;
      const p = ctx.properties.getAny(propertyId);
      const tz = ctx.config.timezone;
      const draft = { time_local: plan.time, kind: plan.kind, days: plan.days, once_date: plan.onceDate, start_date: plan.startDate, end_date: plan.endDate, timezone: tz };
      const first = plan.immediate ? ctx.clock() : ctx.schedules.computeNext(draft, ctx.clock());
      const today = isoDate(ctx.clock(), tz);
      const startWord = !first ? 'n/a' : plan.immediate ? 'now' : isoDate(first, tz) === today ? 'today' : isoDate(first, tz) === isoDate(new Date(ctx.clock().getTime() + 86400000), tz) ? 'tomorrow' : isoDate(first, tz);
      const media = ctx.media.counts(p.id);
      const lines = [
        `Property: ${p.ref} ${p.title || ''}`.trim(),
        `Time: ${planLabel(plan)} (${tz})`,
        destination === 'status' ? `Destination: WhatsApp Status (${ctx.audience.count()} known recipients)` : `Destination: your approved WhatsApp groups (${groupJids.length}), text only`,
        `Start date: ${startWord}${first && !plan.immediate ? ` (first run ${formatLocal(first, tz)})` : ''}`,
        `End date: ${plan.endDate || (plan.kind === 'once' || plan.immediate ? 'one-time' : 'until you stop it')}`,
        `Media: ${media.images || media.videos ? `${media.images} photo(s), ${media.videos} video(s)` : 'none (a text-only post)'}${destination === 'groups' ? ' (not sent to groups yet)' : ''}`,
        `Caption: ${buildCaption(p, destination === 'status' ? 'short' : 'long').split('\n').slice(0, 3).join(' | ')}`,
      ];
      const warn = [];
      if (p.status === 'draft') warn.push(`${p.ref} is a draft; activating will mark it available`);
      const miss = missingFields(p); if (miss.length) warn.push(`still missing: ${miss.join(', ')}`);
      for (const a of task.payload.assumptions || []) warn.push(a);
      if (destination === 'status') warn.push('WhatsApp privacy settings decide who sees a Status; I cannot confirm visibility');
      if (destination === 'groups' && plan.kind !== 'once' && !plan.immediate) warn.push('posting the same advert to groups often can annoy members; weekly is gentler');
      warn.forEach((w) => lines.push(`Note: ${w}.`));
      lines.push('Edit before activating: "change the time to 10 AM", "Monday to Saturday", "until 30 Nov".');
      return { heading: 'Recurring posting schedule', pending: 'active', confirm: plan.immediate ? 'post now' : 'activate it', lines };
    },
    async onConfirm(ctx, task) {
      const { propertyId, destination, plan, groupJids } = task.payload;
      const p = ctx.properties.get(propertyId);
      if (!p) throw new Error('That property no longer exists. Nothing was scheduled.');
      if (DEAD.includes(p.status)) throw new Error(`${p.ref} is now ${p.status}. Nothing was scheduled.`);
      const caps = ctx.provider.capabilities();
      if (destination === 'status') {
        if (!caps.publishStatus) throw new Error('The provider cannot post Status updates. Nothing was scheduled.');
        if (!ctx.audience.count()) throw new Error('There are no known Status recipients (see /audience). Nothing was scheduled.');
      } else {
        if (!caps.groups) throw new Error('The provider cannot send to groups. Nothing was scheduled.');
        if (!ctx.groups.postingEnabled()) throw new Error('Group posting is OFF. Nothing was scheduled.');
        const ok = (groupJids || []).filter((j) => ctx.groups.isApproved(j));
        if (!ok.length) throw new Error('None of those groups are approved any more. Nothing was scheduled.');
      }
      const dup = duplicateOf(ctx, p, destination, plan);
      if (dup) throw new Error(`An identical schedule (S-${dup.id}) already exists. Nothing new was scheduled.`);
      if (p.status === 'draft') ctx.properties.setStatus(p.id, 'available');
      const s = ctx.schedules.create({ propertyId: p.id, destination, kind: plan.kind, time: plan.time, days: plan.days, onceDate: plan.onceDate, startDate: plan.startDate, endDate: plan.endDate, timezone: ctx.config.timezone, groupJids: destination === 'groups' ? (groupJids || []).filter((j) => ctx.groups.isApproved(j)) : null, immediate: !!plan.immediate });
      ctx.store.finish(task.id, JSON.stringify({ scheduleId: s.id }));
      if (plan.immediate) return `Posting ${p.ref} to ${destination === 'status' ? 'Status' : 'your groups'} has been QUEUED (S-${s.id}); it starts within seconds. I will report the real result. Nothing is published until then.`;
      return `Schedule S-${s.id} is ACTIVE: ${p.ref} -> ${destination === 'status' ? 'Status' : 'groups'}, ${planLabel(plan)}. Next run: ${formatLocal(new Date(s.next_run_at), ctx.config.timezone)}. Nothing has been posted yet.`;
    },
    async execute() { throw new Error('schedule_create runs only via confirmation'); },
  },
};
module.exports = { scheduleActions, planLabel, pretty, daysLabel };
