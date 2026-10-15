'use strict';
const { actions } = require('../tasks/registry');
const { getPause } = require('../tasks/pause');
const { getSetting, setSetting } = require('../storage/settings');
const { audit } = require('../storage/db');
const { buildCaption } = require('../properties/caption');
const { formatLocal, zonedToUtc } = require('../nlp/time');
const { isoDate } = require('./store');

const timeOnly = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d).toUpperCase();

/**
 * Executes schedules. Guarantees:
 *  - A run is recorded (UNIQUE per schedule+date) in the same transaction that advances the schedule, so a
 *    restart or a second tick can never run the same date twice.
 *  - Each Status item is claimed before it is sent; interrupted items become "unknown" and are never re-sent.
 *  - Runs too late (beyond the grace period) are skipped and reported, never posted late.
 *  - The property must still be "available" at run time; media files must still exist.
 *  - Success is only ever "accepted by WhatsApp"; Status visibility cannot be verified.
 */
class ScheduleRunner {
  constructor({ ctx, intervalMs = 15000 }) { Object.assign(this, { ctx, intervalMs, timer: null, busy: false }); }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch((e) => this.ctx.logger?.error({ err: e.message }, 'schedule tick failed')), this.intervalMs); this.timer.unref?.(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    try {
      const { ctx } = this;
      if (ctx.provider.connectionState() !== 'connected') return { skipped: 'disconnected' };
      const now = ctx.clock();
      await this._maybeBriefing(now);
      if (getPause(ctx.db, now).paused) return { skipped: 'paused' };
      const results = [];
      for (const run of ctx.schedules.retryableRuns(now.toISOString())) {
        const s = ctx.schedules.get(run.schedule_id);
        if (s) results.push(await this._attempt(s, run, now));
      }
      for (const s of ctx.schedules.dueSchedules(now.toISOString())) { const r = await this._due(s, now); if (r) results.push(r); }
      if (results.length) await this._report(results, now);
      return { results: results.map((r) => ({ schedule: r.schedule.id, outcome: r.outcome })) };
    } finally { this.busy = false; }
  }

  async _due(s, now) {
    const { ctx } = this;
    const scheduledFor = new Date(s.next_run_at);
    const runDate = isoDate(scheduledFor, s.timezone);
    const late = now - scheduledFor;
    const missed = late > ctx.config.missedRunGraceMs;
    const next = s.kind === 'once' ? null : ctx.schedules.computeNext(s, missed ? now : scheduledFor);
    const run = ctx.schedules.claimRun(s, runDate, scheduledFor.toISOString(), next ? next.toISOString() : null, next ? 'active' : 'completed');
    if (!run) return null;
    const prop = ctx.properties.get(s.property_id);
    const finish = (status, detail) => { ctx.schedules.updateRun(run.id, { status, detail, finished_at: now.toISOString() }); return { schedule: s, property: prop, run: { ...run, status, detail }, outcome: status, detail }; };
    if (missed) return finish('skipped', `missed: it was due at ${timeOnly(scheduledFor, s.timezone)} but the assistant was offline/paused ${Math.round(late / 60000)} min (limit ${Math.round(ctx.config.missedRunGraceMs / 60000)} min), so I did not post late`);
    if (ctx.schedules.db.prepare(`SELECT 1 FROM schedule_runs WHERE schedule_id=? AND status IN ('running','retry') AND id != ?`).get(s.id, run.id)) return finish('skipped', 'the previous run is still in progress');
    if (!prop || prop.status !== 'available') {
      if (prop) ctx.schedules.pause(s.id, `${prop.ref} is ${prop.status}`);
      return finish('skipped', `the property is ${prop ? prop.status : 'deleted'}${prop ? '; this schedule is now PAUSED' : ''}`);
    }
    return this._attempt(s, run, now, prop);
  }

  async _attempt(s, run, now, propIn) {
    const { ctx } = this;
    const prop = propIn || ctx.properties.get(s.property_id);
    const fin = (status, detail, extra = {}) => { ctx.schedules.updateRun(run.id, { status, detail, finished_at: status === 'retry' ? null : now.toISOString(), ...extra }); return { schedule: s, property: prop, run: { ...run, status, detail }, outcome: status, detail }; };
    if (!prop || prop.status !== 'available') return fin('skipped', `the property is ${prop ? prop.status : 'deleted'}, so I did not post`);
    const attempts = run.attempts + 1;
    ctx.schedules.updateRun(run.id, { attempts, status: 'running' });
    run = { ...run, attempts };
    return s.destination === 'groups' ? this._execGroups(s, run, prop, fin) : this._execStatus(s, run, prop, now, fin);
  }

  async _execGroups(s, run, prop, fin) {
    const { ctx } = this;
    if (!ctx.groups.postingEnabled()) return fin('skipped', 'group posting is OFF');
    const approved = new Set(ctx.groups.approved().map((a) => a.jid));
    const jids = (s.group_jids || []).filter((j) => approved.has(j));
    if (!jids.length) return fin('skipped', 'none of the saved groups are approved any more');
    const targets = jids.map((j) => ({ jid: j, name: (ctx.groups.find(j) || {}).name || (ctx.groups.approved().find((a) => a.jid === j) || {}).name_at_approval || 'group' }));
    const id = ctx.campaigns.create({ title: prop.ref, message: buildCaption(prop, 'long'), targets, propertyId: prop.id, salt: `sched:${s.id}:${run.run_date}` });
    return fin('queued', `queued as advert C-${id} for ${targets.length} group(s); the real results will be reported separately`);
  }

  async _execStatus(s, run, prop, now, fin) {
    const { ctx } = this;
    const contacts = ctx.audience.count();
    if (!contacts) return fin('failed', 'there are no known Status recipients (audience is empty), so nothing was posted');
    const chk = ctx.media.check(prop.id);
    if (!chk.ok) return fin('failed', `${chk.missing.length} media file(s) are missing on disk, so nothing was posted`);
    let items = ctx.schedules.items(run.id);
    if (!items.length) {
      const media = ctx.media.forProperty(prop.id);
      ctx.schedules.addItems(run.id, media.length ? media.map((m) => `media:${m.id}`) : ['text']);
      items = ctx.schedules.items(run.id);
    }
    const recipients = ctx.audience.recipients(ctx.provider.selfJid());
    const caption = buildCaption(prop, 'short');
    const mediaRows = new Map(ctx.media.forProperty(prop.id).map((m) => [`media:${m.id}`, m]));
    let lastError = null;
    for (const item of items) {
      if (['sent', 'unknown', 'skipped'].includes(item.status)) continue;
      if (!ctx.schedules.claimItem(item.id)) continue;
      let payload;
      if (item.ref === 'text') payload = { text: caption, recipients };
      else {
        const m = mediaRows.get(item.ref);
        if (!m) { ctx.schedules.settleItem(item.id, 'failed', 'media record no longer exists'); lastError = 'media record no longer exists'; break; }
        payload = { [m.kind === 'image' ? 'imagePath' : 'videoPath']: ctx.media.absolutePath(m.rel_path), ...(item.position === 1 ? { caption } : {}), recipients };
      }
      let res; try { res = await ctx.provider.publishStatus(payload); } catch (e) { res = { ok: false, error: e.message }; }
      if (res.ok) ctx.schedules.settleItem(item.id, 'sent', 'accepted by WhatsApp (visibility not confirmed)', res.id || null);
      else { ctx.schedules.settleItem(item.id, 'failed', String(res.error).slice(0, 200)); lastError = String(res.error).slice(0, 200); break; }
    }
    const after = ctx.schedules.items(run.id);
    const sent = after.filter((i) => i.status === 'sent').length;
    const total = after.length;
    const base = { recipients: contacts };
    let out;
    if (sent === total) out = fin('success', `${sent}/${total} item(s) accepted by WhatsApp for ${contacts} recipient(s); visibility not confirmed`, base);
    else if (run.attempts < ctx.config.scheduleMaxAttempts) out = fin('retry', `attempt ${run.attempts} failed (${lastError}); ${sent}/${total} item(s) done`, { ...base, next_attempt_at: new Date(now.getTime() + ctx.config.scheduleRetryDelayMs).toISOString() });
    else out = fin(sent ? 'partial' : 'failed', `${sent}/${total} item(s) accepted; last error: ${lastError}`, base);
    if (sent && out.outcome !== 'retry') ctx.properties.addPublication(prop.id, 'status', 'accepted', `${contacts} recipients, ${sent}/${total} item(s)`);
    audit(ctx.db, 'schedule', 'status.run', out.outcome, `S-${s.id}`);
    out.sent = sent; out.total = total; out.recipients = contacts;
    return out;
  }

  async _report(results, now) {
    const { ctx } = this; const tz = ctx.config.timezone;
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(now));
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const first = new Date(results[0].run.scheduled_for);
    const onlyRetry = results.every((r) => r.outcome === 'retry');
    const lines = [onlyRetry ? 'Heads-up on a posting run:' : `${greet}! Your ${timeOnly(first, tz)} routine has finished.`, ''];
    for (const r of results) {
      const p = r.property; const name = p ? `${p.ref} (${p.title || 'untitled'})` : `Schedule S-${r.schedule.id}`;
      const dest = r.schedule.destination === 'groups' ? 'Groups' : 'Status';
      if (r.outcome === 'success') lines.push(`${name}: ${dest} - accepted by WhatsApp for ${r.recipients} recipient(s), ${r.sent}/${r.total} item(s). I cannot confirm who actually saw it.`);
      else if (r.outcome === 'queued') lines.push(`${name}: ${dest} - ${r.detail}.`);
      else if (r.outcome === 'partial') lines.push(`${name}: PARTIAL - ${r.detail}.`);
      else if (r.outcome === 'retry') lines.push(`${name}: attempt failed (${r.detail}). Retrying at ${timeOnly(new Date(now.getTime() + ctx.config.scheduleRetryDelayMs), tz)}.`);
      else if (r.outcome === 'skipped') lines.push(`${name}: SKIPPED - ${r.detail}.`);
      else lines.push(`${name}: FAILED - ${r.detail}.`);
    }
    if (!results.some((r) => r.schedule.destination === 'groups') && !ctx.schedules.list(['active']).some((s) => s.destination === 'groups')) lines.push('Group promotion: not scheduled.');
    const next = ctx.schedules.list(['active']).filter((s) => s.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
    lines.push(next ? `Next run: ${formatLocal(new Date(next.next_run_at), tz)}.` : 'Next run: nothing is scheduled.');
    const res = await ctx.provider.sendText(ctx.ownerJid, `${ctx.prefix} ${lines.join('\n')}`);
    if (!res.ok) { ctx.logger?.error({ error: res.error }, 'could not send the run report'); try { audit(ctx.db, 'schedule', 'report', 'failed', String(res.error).slice(0, 120)); } catch { /* ignore */ } }
  }

  async _maybeBriefing(now) {
    const { ctx } = this; const cfg = getSetting(ctx.db, 'routine');
    if (!cfg || !cfg.enabled) return;
    const tz = ctx.config.timezone; const today = isoDate(now, tz);
    if (getSetting(ctx.db, 'routine.last') === today) return;
    const [hh, mm] = cfg.time.split(':').map(Number);
    const [y, mo, d] = today.split('-').map(Number);
    const at = zonedToUtc(y, mo, d, hh, mm, tz);
    if (now < at || now - at > 3 * 3600000) return;
    setSetting(ctx.db, 'routine.last', today); // at most once per day, even if sending fails
    const res = await ctx.provider.sendText(ctx.ownerJid, `${ctx.prefix} ${this.briefingText(now)}`);
    if (!res.ok) ctx.logger?.error({ error: res.error }, 'briefing failed to send');
  }

  briefingText(now) {
    const { ctx } = this; const tz = ctx.config.timezone; const today = isoDate(now, tz);
    const lines = [`Good morning! Today is ${formatLocal(now, tz).split(',')[0]}.`];
    const todays = ctx.schedules.list(['active']).filter((s) => ctx.schedules.occursOn(s, today));
    if (todays.length) { lines.push('Scheduled today:'); for (const s of todays) { const p = ctx.properties.get(s.property_id); const [h, m] = s.time_local.split(':').map(Number); lines.push(`- ${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}  ${p ? p.ref : '?'} -> ${s.destination === 'groups' ? 'groups' : 'Status'}`); } }
    else lines.push('Nothing is scheduled to post today.');
    const warn = [];
    for (const s of ctx.schedules.list(['paused'])) warn.push(`S-${s.id} is paused (${s.pause_reason || 'by you'})`);
    if (ctx.audience.count() === 0) warn.push('Status audience is EMPTY, Status posts will fail (/audience)');
    if (getPause(ctx.db, now).paused) warn.push('global automation pause is ON');
    const drafts = ctx.store.counts().proposed || 0; if (drafts) warn.push(`${drafts} draft(s) awaiting your approval`);
    if (warn.length) lines.push('Heads-up: ' + warn.join('; ') + '.');
    lines.push(`Available properties: ${ctx.properties.list({ status: 'available' }).length}.`);
    return lines.join('\n');
  }
}
module.exports = { ScheduleRunner };
