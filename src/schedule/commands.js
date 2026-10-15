'use strict';
const { actions } = require('../tasks/registry');
const { planLabel, pretty } = require('../tasks/registry-schedules');
const { parseTimeOfDay, parseDays, parseEndDate, hm } = require('../nlp/schedule');
const { isoDate } = require('./store');
const { audit } = require('../storage/db');
const { getSetting, setSetting } = require('../storage/settings');
const { getPause } = require('../tasks/pause');

const DEAD = ['sold', 'rented', 'unavailable', 'withdrawn'];
const period = (s) => { const h = Number(s.time_local.slice(0, 2)); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'; };

module.exports = {
  async proposeSchedule(it) {
    const plan = it.plan;
    if (plan.needTime) return 'What time should it post? e.g. "every morning at 8 AM" or "Monday to Saturday at 9 AM". Nothing was prepared.';
    if (plan.error === 'past') return 'That time has already passed today. Give me a later time or say "tomorrow". Nothing was prepared.';
    const caps = this.provider.capabilities();
    if (it.destination === 'status' && !caps.publishStatus) return 'The current WhatsApp provider cannot post Status updates, so I did nothing.';
    if (it.destination === 'groups' && !caps.groups) return 'The current WhatsApp provider cannot send to groups, so I did nothing.';
    const r = this._resolveProperty(it.text);
    if (!r.property) return this._refError(r);
    const p = r.property;
    if (DEAD.includes(p.status)) return `${p.ref} is ${p.status}, so I will not schedule posts for it. Nothing was prepared.`;
    let groupJids = null;
    if (it.destination === 'groups') {
      if (!this.groups.postingEnabled()) return 'Group posting is OFF, so I cannot schedule group posts. Turn it on with /groups enable. Nothing was prepared.';
      const approved = this.groups.approved();
      if (!approved.length) return 'No groups are approved for marketing yet (/groups). Nothing was prepared.';
      if (approved.length > this.config.maxGroupsPerCampaign) return `You have ${approved.length} approved groups; my per-advert limit is ${this.config.maxGroupsPerCampaign}. Nothing was prepared.`;
      groupJids = approved.map((a) => a.jid);
    } else if (!this.audience.count()) return 'There are no known Status recipients yet, so a Status post would be seen by nobody. See /audience to add some. Nothing was prepared.';
    const dup = this.schedules.forProperty(p.id).find((s) => ['active', 'paused'].includes(s.status) && s.destination === it.destination && s.time_local === plan.time && s.kind === plan.kind && !plan.immediate);
    if (dup) return `An identical schedule already exists: S-${dup.id}. Nothing was prepared.`;
    this._setActive(p.id);
    const { task, note } = this._newProposal({ kind: 'schedule_create', title: `${p.ref} ${it.destination}`, payload: { propertyId: p.id, destination: it.destination, plan, groupJids, assumptions: plan.assumptions || [] } });
    return note + this._renderDraft(task);
  },

  scheduleDraftEdit(it, proposal) {
    const t = it.text.toLowerCase();
    const plan = { ...proposal.payload.plan }; let changed = [];
    const tod = parseTimeOfDay(t); if (tod) { plan.time = hm(tod.h, tod.m); changed.push('time'); }
    const dd = parseDays(t);
    if (dd && plan.kind !== 'once') { plan.kind = new Set(dd.days).size === 7 ? 'daily' : 'days'; plan.days = plan.kind === 'daily' ? null : [...dd.days].sort((a, b) => a - b); changed.push('days'); }
    const end = parseEndDate(t, this.clock(), this.config.timezone); if (end) { plan.endDate = end; changed.push('end date'); }
    if (/\b(every ?day|daily)\b/.test(t) && plan.kind === 'days') { plan.kind = 'daily'; plan.days = null; changed.push('days'); }
    if (!changed.length) return 'I could not read a new time, days or end date. Draft unchanged.';
    this.store.updateProposal(proposal.id, { payload: { ...proposal.payload, plan, assumptions: tod && tod.assumption ? [tod.assumption] : [] }, expiresAt: new Date(this.clock().getTime() + this.config.proposalTtlMs).toISOString() });
    audit(this.db, 'owner', 'schedule.draft_edit', 'ok', `T-${proposal.id}`);
    return 'Updated.\n' + this._renderDraft(this.store.get(proposal.id));
  },

  _resolveSchedules(text, statuses = ['active', 'paused']) {
    const sm = text.match(/\bS-?(\d{1,5})\b/i);
    if (sm) { const s = this.schedules.get(Number(sm[1])); return s && statuses.includes(s.status) ? { schedules: [s] } : { error: 'none' }; }
    const all = this.schedules.list(statuses);
    if (!all.length) return { error: 'none' };
    let cands = all; let filtered = false;
    const tod = text.toLowerCase().match(/\b(morning|afternoon|evening|night)\b/);
    if (tod) { cands = cands.filter((s) => period(s) === tod[1]); filtered = true; }
    const pr = this._resolveProperty(text, { allowActive: false });
    if (pr.property) { cands = cands.filter((s) => s.property_id === pr.property.id); filtered = true; }
    else if (pr.error === 'ambiguous') return { error: 'ambiguous_property', matches: pr.matches };
    if (/\b(all|every)\b/i.test(text)) filtered = true;
    if (!cands.length) return { error: 'none' };
    if (filtered || cands.length === 1) return { schedules: cands };
    return { error: 'ambiguous', matches: cands };
  },
  _schedErr(r) {
    if (r.error === 'ambiguous') return `Which schedule?\n${r.matches.map((s) => this._schedLine(s)).join('\n')}\nSay e.g. "pause S-${r.matches[0].id}".`;
    if (r.error === 'ambiguous_property') return this._refError({ error: 'ambiguous', matches: r.matches });
    return 'I could not find a matching schedule. /schedule list shows them.';
  },
  _schedLine(s) {
    const p = this.properties.getAny(s.property_id); const last = this.schedules.lastRun(s.id);
    const next = s.status === 'active' && s.next_run_at ? `next ${this._fmt(new Date(s.next_run_at))}` : s.status === 'paused' ? `paused${s.pause_reason ? ` (${s.pause_reason})` : ''}` : s.status;
    return `S-${s.id} | ${p ? p.ref : '?'} -> ${s.destination === 'groups' ? 'groups' : 'Status'} | ${planLabel({ kind: s.kind, time: s.time_local, days: s.days, onceDate: s.once_date })} | ${next}${last ? ` | last: ${last.status}` : ''}`;
  },

  scheduleList({ day } = {}) {
    let list = this.schedules.list(['active', 'paused']);
    const g = getPause(this.db, this.clock());
    const head = g.paused ? 'GLOBAL PAUSE is ON: nothing will post until /resume.\n' : '';
    if (day) { const key = isoDate(day === 'today' ? this.clock() : new Date(this.clock().getTime() + 86400000), this.config.timezone); list = list.filter((s) => s.status === 'active' && this.schedules.occursOn(s, key)); }
    if (!list.length) return `${head}No schedules${day ? ` for ${day}` : ''}. Try: "post this property every morning at 8 AM".`;
    return `${head}*Schedules (${list.length})*\n${list.map((s) => this._schedLine(s)).join('\n')}`;
  },
  scheduleHistory(text) {
    const sm = text.match(/\bS-?(\d{1,5})\b/i);
    const runs = this.schedules.recentRuns(sm ? Number(sm[1]) : null, 8);
    if (!runs.length) return 'No runs recorded yet.';
    return `*Recent runs*\n${runs.map((r) => `S-${r.schedule_id} ${r.run_date} | ${r.status} | ${r.detail || ''}`).join('\n')}`;
  },

  schedulePause(text) {
    const r = this._resolveSchedules(text, ['active']);
    if (!r.schedules) return r.error === 'none' ? 'There is no active schedule matching that.' : this._schedErr(r);
    for (const s of r.schedules) this.schedules.pause(s.id, 'paused by you');
    audit(this.db, 'owner', 'schedule.pause', 'ok', r.schedules.map((s) => `S-${s.id}`).join(','));
    return `Paused ${r.schedules.map((s) => `S-${s.id}`).join(', ')}. They will not post until you resume them.`;
  },
  scheduleResume(text) {
    const r = this._resolveSchedules(text, ['paused']);
    const g = getPause(this.db, this.clock()).paused;
    if (!r.schedules) return `${r.error === 'none' ? 'No paused schedule matches that.' : this._schedErr(r)}${g ? ' (Global pause is still ON: send /resume.)' : ''}`;
    const done = []; const fail = [];
    for (const s of r.schedules) {
      const p = this.properties.get(s.property_id);
      if (!p || DEAD.includes(p.status)) { fail.push(`S-${s.id} (${p ? p.ref + ' is ' + p.status : 'property deleted'})`); continue; }
      if (this.schedules.resume(s.id)) done.push(`S-${s.id}`); else fail.push(`S-${s.id} (no future run)`);
    }
    audit(this.db, 'owner', 'schedule.resume', 'ok', done.join(','));
    return `${done.length ? `Resumed ${done.join(', ')}. ` : ''}${fail.length ? `Not resumed: ${fail.join('; ')}. ` : ''}${g ? 'Global pause is still ON: send /resume to lift it.' : ''}`.trim();
  },
  scheduleCancel(text) {
    const r = this._resolveSchedules(text, ['active', 'paused']);
    if (!r.schedules) return r.error === 'none' ? 'There is no schedule matching that.' : this._schedErr(r);
    for (const s of r.schedules) this.schedules.cancel(s.id);
    audit(this.db, 'owner', 'schedule.cancel', 'ok', r.schedules.map((s) => `S-${s.id}`).join(','));
    return `Cancelled ${r.schedules.map((s) => `S-${s.id}`).join(', ')}. This is permanent: a cancelled schedule never restarts by itself.`;
  },
  scheduleEditExisting(it) {
    const t = it.text.toLowerCase();
    const tod = parseTimeOfDay(t); const dd = parseDays(t); const end = parseEndDate(t, this.clock(), this.config.timezone);
    if (!tod && !dd && !end) return 'I could not read a new time. Nothing changed.';
    const r = this._resolveSchedules(it.text.replace(/\b(morning|afternoon|evening|night)\b(?=[^.]*\bto\b)/i, '$1'), ['active', 'paused']);
    if (!r.schedules) return r.error === 'none' ? 'I could not find which schedule to change. /schedule list shows them.' : this._schedErr(r);
    const out = [];
    for (const s of r.schedules) {
      this.schedules.edit(s.id, { time: tod ? hm(tod.h, tod.m) : undefined, days: dd && s.kind !== 'once' ? [...dd.days] : undefined, endDate: end || undefined });
      const n = this.schedules.get(s.id);
      out.push(`S-${s.id}: ${planLabel({ kind: n.kind, time: n.time_local, days: n.days, onceDate: n.once_date })}${n.status === 'active' && n.next_run_at ? `, next ${this._fmt(new Date(n.next_run_at))}` : ''}`);
    }
    audit(this.db, 'owner', 'schedule.edit', 'ok', r.schedules.map((s) => `S-${s.id}`).join(','));
    return `Updated.\n${out.join('\n')}${tod && tod.assumption ? `\nNote: ${tod.assumption}.` : ''}`;
  },

  scheduleCommand(args) {
    const a = args.trim(); const lower = a.toLowerCase();
    if (!a || lower === 'list') return this.scheduleList();
    const first = lower.split(/\s+/)[0]; const rest = a.slice(first.length).trim();
    if (first === 'pause') return this.schedulePause(rest || 'schedule');
    if (first === 'resume') return this.scheduleResume(rest || 'schedule');
    if (first === 'cancel') return rest ? this.scheduleCancel(rest) : 'Which schedule? /schedule cancel S-1';
    if (first === 'history') return this.scheduleHistory(rest);
    if (first === 'time') { const m = rest.match(/^(S-?\d+)\s+(.+)$/i); return m ? this.scheduleEditExisting({ text: `${m[1]} time to ${m[2]}` }) : 'Usage: /schedule time S-1 10:00am'; }
    return 'Usage: /schedule | /schedule list | /schedule pause|resume|cancel [S-1] | /schedule time S-1 10am | /schedule history';
  },

  routineCommand(args) {
    const a = args.trim().toLowerCase(); const cur = getSetting(this.db, 'routine') || { enabled: false, time: '07:30' };
    let m;
    if (a === 'on') { setSetting(this.db, 'routine', { ...cur, enabled: true }); return `Morning briefing ON, daily at ${pretty(cur.time)} (${this.config.timezone}). It only reports; posting runs on your schedules.`; }
    if (a === 'off') { setSetting(this.db, 'routine', { ...cur, enabled: false }); return 'Morning briefing OFF.'; }
    if ((m = a.match(/^time\s+(.+)$/))) {
      const tod = parseTimeOfDay(`at ${m[1]}`.replace(/^at (\d{1,2}:\d{2})$/, 'at $1')); if (!tod) return 'I could not read that time, e.g. /routine time 7:30am. Nothing changed.';
      setSetting(this.db, 'routine', { ...cur, time: hm(tod.h, tod.m) }); return `Briefing time set to ${pretty(hm(tod.h, tod.m))}.${cur.enabled ? '' : ' It is still OFF: /routine on'}`;
    }
    return `Morning briefing: ${cur.enabled ? 'ON' : 'OFF'} at ${pretty(cur.time)} (${this.config.timezone}). Commands: /routine on | off | time 7:30am`;
  },
};
