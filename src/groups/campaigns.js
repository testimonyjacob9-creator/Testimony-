'use strict';
const crypto = require('node:crypto');
const { getPause } = require('../tasks/pause');
const { audit } = require('../storage/db');

const hashContent = (text) => crypto.createHash('sha256').update(String(text).trim().replace(/\s+/g, ' ')).digest('hex');

class CampaignStore {
  constructor(db, clock = () => new Date()) { this.db = db; this.clock = clock; }
  _now() { return this.clock().toISOString(); }

  /** Which of these groups already received this exact advert recently (duplicate protection)? */
  recentlySent(text, jids, windowMs, excludeCampaignId = -1) {
    if (!windowMs) return new Set();
    const cutoff = new Date(this.clock().getTime() - windowMs).toISOString();
    const rows = this.db.prepare(`SELECT DISTINCT s.group_jid FROM campaign_sends s JOIN campaigns c ON c.id = s.campaign_id
      WHERE c.content_hash = ? AND s.status = 'sent' AND s.attempted_at >= ? AND c.id != ?`).all(hashContent(text), cutoff, excludeCampaignId);
    const set = new Set(rows.map((r) => r.group_jid));
    return new Set(jids.filter((j) => set.has(j)));
  }

  create({ title, message, targets }) {
    this.db.exec('BEGIN');
    try {
      const res = this.db.prepare(`INSERT INTO campaigns (title,message,content_hash,status,created_at) VALUES (?,?,?,'sending',?)`)
        .run(title, message, hashContent(message), this._now());
      const id = Number(res.lastInsertRowid);
      const ins = this.db.prepare(`INSERT INTO campaign_sends (campaign_id,group_jid,group_name,status) VALUES (?,?,?,'pending')`);
      for (const t of targets) ins.run(id, t.jid, t.name);
      this.db.exec('COMMIT');
      return id;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(id) { const r = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id); return r ? { ...r } : null; }
  latest() { const r = this.db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 1').get(); return r ? { ...r } : null; }
  active() { return this.db.prepare(`SELECT * FROM campaigns WHERE status = 'sending' ORDER BY id`).all().map((r) => ({ ...r })); }
  sends(id) { return this.db.prepare('SELECT * FROM campaign_sends WHERE campaign_id = ? ORDER BY id').all(id).map((r) => ({ ...r })); }
  pendingSends(id) { return this.db.prepare(`SELECT * FROM campaign_sends WHERE campaign_id = ? AND status = 'pending' ORDER BY id`).all(id).map((r) => ({ ...r })); }
  /** Atomic claim: exactly one caller may send a given row. */
  claim(sendId) {
    return Number(this.db.prepare(`UPDATE campaign_sends SET status='sending', attempted_at=? WHERE id=? AND status='pending'`).run(this._now(), sendId).changes) === 1;
  }
  settle(sendId, status, detail = null, messageId = null) {
    this.db.prepare(`UPDATE campaign_sends SET status=?, detail=?, message_id=? WHERE id=? AND status IN ('sending','pending')`).run(status, detail, messageId, sendId);
  }
  /** Returns true only for the caller that actually finished the campaign (so the report is sent once). */
  finishIfComplete(id) {
    const left = this.db.prepare(`SELECT COUNT(*) AS n FROM campaign_sends WHERE campaign_id=? AND status IN ('pending','sending')`).get(id);
    if (Number(left.n) > 0) return false;
    return Number(this.db.prepare(`UPDATE campaigns SET status='done', finished_at=? WHERE id=? AND status='sending'`).run(this._now(), id).changes) === 1;
  }
  cancel(id) {
    const n = Number(this.db.prepare(`UPDATE campaign_sends SET status='cancelled', detail='cancelled by owner before sending' WHERE campaign_id=? AND status='pending'`).run(id).changes);
    this.db.prepare(`UPDATE campaigns SET status='cancelled', finished_at=? WHERE id=? AND status='sending'`).run(this._now(), id);
    return n;
  }
  /** After a crash: rows stuck in "sending" may or may not have gone out. Never resend; report honestly. */
  recoverInterrupted() {
    return Number(this.db.prepare(`UPDATE campaign_sends SET status='unknown', detail='interrupted by a restart; outcome unknown, check the group' WHERE status='sending'`).run().changes);
  }
}

const sleepReal = (ms) => new Promise((r) => (ms > 0 ? setTimeout(r, ms) : r()));

/**
 * Executes confirmed campaigns slowly and safely. Per destination, immediately before sending:
 *  allowlist -> still accessible (fresh listing) -> admins-only check -> duplicate check -> send.
 * A failure of one group never blocks the others (partial failure), and nothing is auto-retried
 * (a retry could double-post).
 */
class CampaignRunner {
  constructor({ ctx, intervalMs = 5000, sleep = sleepReal }) { Object.assign(this, { ctx, intervalMs, sleep, timer: null, busy: false }); }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch((e) => this.ctx.logger?.error({ err: e.message }, 'campaign tick failed')), this.intervalMs); this.timer.unref?.(); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return { skipped: 'busy' };
    this.busy = true;
    try {
      const { ctx } = this;
      if (ctx.provider.connectionState() !== 'connected') return { skipped: 'disconnected' };
      if (getPause(ctx.db, ctx.clock()).paused) return { skipped: 'paused' };
      const finished = [];
      for (const c of ctx.campaigns.active()) { if (await this._run(c)) finished.push(c.id); }
      return { finished };
    } finally { this.busy = false; }
  }

  async _run(c) {
    const { ctx } = this;
    if (!ctx.groups.postingEnabled()) {
      ctx.campaigns.cancel(c.id);
      await this._report(c.id, 'Group posting was switched off, so the remaining sends were cancelled.');
      return true;
    }
    const live = await ctx.provider.listGroups();
    if (!live.ok) return false; // cannot verify destinations: leave pending, try again next tick
    const liveMap = new Map(live.groups.map((g) => [g.id, g]));
    let sentOne = false;
    for (const row of ctx.campaigns.pendingSends(c.id)) {
      if (ctx.campaigns.get(c.id).status !== 'sending') break; // cancelled meanwhile
      if (getPause(ctx.db, ctx.clock()).paused) return false;
      if (!ctx.campaigns.claim(row.id)) continue;
      const settle = (s, d, m) => ctx.campaigns.settle(row.id, s, d, m);
      const g = liveMap.get(row.group_jid);
      if (!ctx.groups.isApproved(row.group_jid)) { settle('skipped', 'not on the approved marketing list'); continue; }
      if (!g) { settle('skipped', 'group is no longer accessible (left, removed, or deleted)'); continue; }
      if (g.canSend === false) { settle('skipped', 'only admins can post in this group'); continue; }
      if (ctx.campaigns.recentlySent(c.message, [row.group_jid], ctx.config.groupDedupeMs, c.id).has(row.group_jid)) { settle('skipped', 'this advert was already sent to this group recently'); continue; }
      if (sentOne) await this.sleep(ctx.config.groupSendDelayMs); // pacing between real sends
      let res;
      try { res = await ctx.provider.sendText(row.group_jid, c.message); } catch (e) { res = { ok: false, error: e.message }; }
      if (res.ok) { settle('sent', 'accepted by WhatsApp (delivery not confirmed)', res.id || null); sentOne = true; audit(ctx.db, 'campaign', 'group.send', 'ok', `C-${c.id}`); }
      else { settle('failed', String(res.error || 'send failed').slice(0, 200)); sentOne = true; audit(ctx.db, 'campaign', 'group.send', 'failed', `C-${c.id}`); }
    }
    if (ctx.campaigns.finishIfComplete(c.id)) { await this._report(c.id); return true; }
    return false;
  }

  async _report(id, extra) {
    const { ctx } = this;
    const c = ctx.campaigns.get(id);
    const text = `${ctx.prefix} ${summarize(ctx.campaigns, c)}${extra ? '\n' + extra : ''}`;
    try { await ctx.provider.sendText(ctx.ownerJid, text); } catch (e) { ctx.logger?.error({ err: e.message }, 'campaign report failed'); }
  }
}

function summarize(store, c) {
  const rows = store.sends(c.id);
  const by = (s) => rows.filter((r) => r.status === s);
  const names = (list) => list.map((r) => r.group_name).join(', ');
  const parts = [`*Advert C-${c.id}* ${c.status === 'cancelled' ? 'cancelled' : 'finished'}.`];
  parts.push(`Accepted by WhatsApp: ${by('sent').length} of ${rows.length}${by('sent').length ? ' (' + names(by('sent')) + ')' : ''}. This is server acceptance, not proof anyone read it.`);
  for (const [s, label] of [['failed', 'FAILED'], ['skipped', 'Skipped'], ['unknown', 'OUTCOME UNKNOWN'], ['cancelled', 'Cancelled']]) {
    for (const r of by(s)) parts.push(`${label}: ${r.group_name} - ${r.detail || ''}`);
  }
  return parts.join('\n');
}

module.exports = { CampaignStore, CampaignRunner, summarize, hashContent };
