'use strict';
// Group-marketing task kinds. Merged into the main registry. Every kind here requires owner confirmation.
const groupActions = {
  group_select: {
    pausable: false,
    describe(ctx, task) {
      const { add = [], remove = [] } = task.payload;
      const lines = [];
      if (add.length) { lines.push('Authorise for marketing:'); add.forEach((g) => lines.push(`+ ${g.name}${g.size ? ` (${g.size} members)` : ''}`)); }
      if (remove.length) { lines.push('Remove from marketing:'); remove.forEach((g) => lines.push(`- ${g.name}`)); }
      const now = ctx.groups.approved().length;
      lines.push(`Approved groups: ${now} now, ${now + add.length - remove.length} after saving.`);
      return { heading: 'Draft: change approved marketing groups', pending: 'saved', confirm: 'save', lines };
    },
    async onConfirm(ctx, task) {
      const { add = [], remove = [] } = task.payload;
      ctx.groups.applySelection({ add, remove: remove.map((g) => g.jid) });
      ctx.store.finish(task.id, JSON.stringify({ added: add.length, removed: remove.length }));
      const total = ctx.groups.approved().length;
      return `Saved. ${add.length} added, ${remove.length} removed. ${total} group${total === 1 ? ' is' : 's are'} now approved for marketing. Nothing was sent to any group.`;
    },
    async execute() { throw new Error('group_select runs only via confirmation'); },
  },
  group_clear: {
    pausable: false,
    describe(ctx) {
      return { heading: 'Draft: clear ALL approved marketing groups', pending: 'cleared', confirm: 'clear them',
        lines: [`This removes all ${ctx.groups.approved().length} approved groups. Group posting stays ${ctx.groups.postingEnabled() ? 'ON but has no destinations' : 'OFF'}.`] };
    },
    async onConfirm(ctx, task) { const n = ctx.groups.clearApproved(); ctx.store.finish(task.id, JSON.stringify({ cleared: n })); return `Cleared ${n} approved group${n === 1 ? '' : 's'}.`; },
    async execute() { throw new Error('group_clear runs only via confirmation'); },
  },
  group_enable: {
    pausable: false,
    describe(ctx) {
      return { heading: 'Draft: ENABLE group posting', pending: 'enabled', confirm: 'enable it', lines: [
        'Adverts may then be sent to your approved marketing groups. Each advert still needs your confirmation first.',
        `Limits: one group every ${Math.round(ctx.config.groupSendDelayMs / 1000)}s, max ${ctx.config.maxGroupsPerCampaign} groups per advert, same advert not repeated to a group within ${Math.round(ctx.config.groupDedupeMs / 3600000)}h.`,
        'Mass-posting can get a WhatsApp number restricted. Only post where it is welcome.',
      ] };
    },
    async onConfirm(ctx, task) { ctx.groups.setPostingEnabled(true); ctx.store.finish(task.id, '{}'); return 'Group posting is now ON. Nothing is sent without your confirmation of each advert.'; },
    async execute() { throw new Error('group_enable runs only via confirmation'); },
  },
  campaign: {
    pausable: true,
    describe(ctx, task) {
      const { text, targets } = task.payload;
      const dup = ctx.campaigns.recentlySent(text, targets.map((t) => t.jid), ctx.config.groupDedupeMs);
      const secs = Math.round(ctx.config.groupSendDelayMs / 1000);
      const lines = ['Message:', '---', text.length > 900 ? text.slice(0, 900) + ' [...]' : text, '---', `Destinations (${targets.length}):`];
      targets.forEach((t) => lines.push(`${t.num}. ${t.name}${dup.has(t.jid) ? '  (got this advert recently: will be SKIPPED)' : ''}`));
      if (task.payload.propertyId) lines.push('Linked property: ' + (ctx.properties.getAny(task.payload.propertyId) || {}).ref + '. Its first photo (or video, if it has no photo) is sent with this text as the caption; if it has no media, only the text is sent. The property is re-checked as available before every send.');
      lines.push(`Pace: one group every ${secs}s (about ${Math.max(1, Math.round(((targets.length - 1) * secs) / 60))} min). Each group is re-checked right before sending.`);
      lines.push('Change destinations: "only groups 2 and 4", "add group 3", "remove group 3". Numbers = /groups selected.');
      return { heading: 'Advert draft', pending: 'sent', confirm: 'start sending', lines };
    },
    async onConfirm(ctx, task) {
      if (!ctx.groups.postingEnabled()) throw new Error('Group posting is OFF. Nothing was sent.');
      const targets = task.payload.targets.filter((t) => ctx.groups.isApproved(t.jid));
      const dropped = task.payload.targets.length - targets.length;
      if (!targets.length) throw new Error('None of those groups are approved any more. Nothing was sent.');
      const id = ctx.campaigns.create({ title: task.title, message: task.payload.text, targets, propertyId: task.payload.propertyId || null });
      ctx.store.finish(task.id, JSON.stringify({ campaignId: id }));
      const secs = Math.round(ctx.config.groupSendDelayMs / 1000);
      return `Advert C-${id} STARTED (not yet sent): ${targets.length} group${targets.length === 1 ? '' : 's'}, one every ${secs}s${dropped ? `; ${dropped} dropped because they are no longer approved` : ''}. I'll report the real results when it finishes. Say "stop the advert" to cancel what hasn't been sent.`;
    },
    async execute() { throw new Error('campaigns run via the campaign runner'); },
  },
};
module.exports = { groupActions };
