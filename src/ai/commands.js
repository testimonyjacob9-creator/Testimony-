'use strict';
const { SYSTEM, AD_SYSTEM, buildPrompt, adPrompt } = require('./interpreter');
const { validateProposal } = require('./schema');
const { interpretSchedule } = require('../nlp/schedule');
const { localParts } = require('../nlp/time');
const { isoDate } = require('../schedule/store');
const { naira } = require('../properties/caption');
const { getSetting } = require('../storage/settings');
const { audit } = require('../storage/db');

const GREETING = /^\s*(good\s+(morning|afternoon|evening)|hi|hello|hey|howdy)\b[\s,!.]*(olives)?[\s!.?]*$/i;
const DAYNAME = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const FORBIDDEN = /\b(discounts?|warrant(?:y|ies)|guarantee[ds]?|limited (?:stock|offer|time|units)|only \d+ (?:left|remaining)|free delivery|hurry|last chance|\d+\s?% off|negotiable)\b/i;

const hourOf = (now, tz) => localParts(now, tz).h;
function h12(hhmm) { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }
const digitsJoined = (s) => String(s).replace(/(\d)[\s-](?=\d)/g, '$1');

/** Numbers/claims in generated copy must come from the saved record. Returns a reason string or null. */
function adViolation(facts, price, text) {
  const allowed = new Set((digitsJoined(facts).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => x.replace(/,/g, '')));
  const copy = digitsJoined(text);
  for (const tok of copy.match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const n = tok.replace(/,/g, '');
    if (n.replace('.', '').length >= 3 && !allowed.has(n)) return `number ${tok} is not in your saved details`;
  }
  for (const m of copy.matchAll(/(\d+(?:\.\d+)?)\s*(m|million|k|thousand)\b/gi)) {
    const v = Number(m[1]) * (/^m/i.test(m[2]) ? 1e6 : 1e3);
    if (!price || Math.abs(v - price) > 1) return `amount ${m[0]} does not match the saved price`;
  }
  const f = text.match(FORBIDDEN);
  if (f && !new RegExp(f[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(facts)) return `"${f[0]}" is not stated in your saved details`;
  return null;
}

const AI_ERRORS = {
  AI_AUTH: "My AI helper rejected the Gemini API key, so I could not interpret that. Check GEMINI_API_KEY in the Render environment. Listings and reminders still work.",
  AI_MODEL: 'The configured Gemini model name is not recognised. Check GEMINI_MODEL. Listings and reminders still work.',
  AI_RATE: 'The AI service is rate-limited or out of quota right now, so I did not act on that. Try again in a few minutes; basic commands still work.',
  AI_BUDGET: 'I reached today\'s AI request limit, so I did not act on that. Basic commands still work; the limit resets tomorrow.',
  AI_TIMEOUT: 'My AI helper is being slow right now, so I did nothing. Please send that again in a moment.',
};
const aiFailText = (e) => AI_ERRORS[e.code] || 'I could not reach my AI helper just now, so I did nothing. Listings and reminders still work.';

module.exports = {
  // ---------- bounded conversation memory (SQLite) ----------
  _recordTurn(role, text, propertyId = null) {
    try {
      this.db.prepare('INSERT INTO conversation_turns (at, role, text, property_id) VALUES (?,?,?,?)').run(this.clock().toISOString(), role, String(text).replace(/^🤖\s*/, '').slice(0, 400), propertyId);
      this.db.prepare('DELETE FROM conversation_turns WHERE id <= (SELECT MAX(id) FROM conversation_turns) - 40').run();
    } catch (e) { this.logger?.warn({ err: e.message }, 'could not record conversation turn'); }
  },
  _recentTurns(n = 6) {
    const cutoff = new Date(this.clock().getTime() - 6 * 3600000).toISOString();
    return this.db.prepare('SELECT role, text FROM conversation_turns WHERE at >= ? ORDER BY id DESC LIMIT ?').all(cutoff, n).reverse().map((r) => ({ ...r }));
  },

  greeting(text, now) {
    if (!GREETING.test(text)) return null;
    const h = hourOf(now, this.config.timezone);
    return `Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}! What are we working on today?`;
  },

  // ---------- AI interpretation ----------
  async aiInterpret(text, now) {
    if (!this.ai || !this.ai.enabled) return null;
    const active = this._activeProperty();
    const all = this.properties.list({});
    const recent = all.slice(-15);
    if (active && !recent.some((p) => p.id === active.id)) recent.push(active);
    const view = getSetting(this.db, 'property_view');
    const lastOrder = (view && view.ids ? view.ids.slice(0, 8) : []).map((id) => (this.properties.get(id) || {}).ref).filter(Boolean);
    const schedules = this.schedules.list(['active', 'paused']).slice(0, 8).map((s) => ({ ...s, ref: (this.properties.getAny(s.property_id) || {}).ref || '?' }));
    const pending = this.store.activeProposal();
    const prompt = buildPrompt({ message: text, now: this._fmt(now), tz: this.config.timezone, listings: recent, active, lastOrder, schedules, pendingKind: pending && pending.kind, turns: this._recentTurns(6) });
    let raw;
    try { raw = await this.ai.client.generateJson({ system: SYSTEM, prompt, maxTokens: 500, temperature: 0.2 }); }
    catch (e) { audit(this.db, 'owner', 'ai.interpret', 'failed', e.code || 'error'); return { text: aiFailText(e) }; }
    const v = validateProposal(raw);
    if (!v.ok) { audit(this.db, 'owner', 'ai.interpret', 'invalid', v.error); return { text: 'I was not sure what you meant, so I did nothing. Could you say it a little differently?' }; }
    audit(this.db, 'owner', 'ai.interpret', 'ok', v.proposal.action);
    const reply = await this._aiExecute(v.proposal, now);
    return reply === null ? null : { text: reply };
  },

  _aiRef(ref) { const p = ref ? this.properties.getByRef(ref) : null; return p || null; },
  _aiTarget(pr) { return this._aiRef(pr.ref) || (pr.ref ? null : this._activeProperty()); },

  async _aiExecute(pr, now) {
    switch (pr.action) {
      case 'none': return null;
      case 'clarify': return pr.text;
      case 'reply': return /[₦$]|\d{2,}/.test(pr.text) ? 'Could you rephrase that? I only give figures straight from your records.' : pr.text;
      case 'briefing': return this.businessBriefing(now);
      case 'list_listings': return this.propertyList(pr.status ? { status: pr.status } : {});
      case 'query_listings': return this.listingQuery(pr);
      case 'show_listing': { const p = this._aiRef(pr.ref); return p ? this.propertyShow(p) : `I could not find ${pr.ref}. /properties lists your listings.`; }
      case 'set_status': case 'edit_field': {
        const p = this._aiRef(pr.ref);
        if (!p) return `I could not find ${pr.ref}, so nothing was changed.`;
        const op = pr.action === 'set_status' ? { op: 'set_status', status: pr.status } : { op: 'edit_field', field: pr.field, value: pr.value };
        const { task, note } = this._newProposal({ kind: 'ai_action', title: `${p.ref} ${pr.action}`, payload: { propertyId: p.id, ...op } });
        return note + this._renderDraft(task);
      }
      case 'draft_ad': {
        const p = this._aiTarget(pr);
        if (!p) return 'Which listing is the advert for? Name it (e.g. PROP-001) or send its details first.';
        return this.proposeAiAdvert(p, pr);
      }
      case 'schedule_create': {
        const p = this._aiRef(pr.ref);
        if (!p) return pr.ref ? `I could not find ${pr.ref}. Nothing was prepared.` : 'Which listing should I post? Name it (e.g. PROP-001). Nothing was prepared.';
        const s = pr.schedule;
        const when = s.frequency === 'daily' ? 'every day' : s.frequency === 'days' ? `every ${s.days.map((d) => DAYNAME[d]).join(' and ')}` : (s.tomorrow ? 'tomorrow' : 'today');
        const phrase = `post ${p.ref} ${when} at ${h12(s.time)} ${s.destination === 'groups' ? 'to my groups' : 'on my status'}`;
        const it = interpretSchedule(phrase, { now, tz: this.config.timezone, proposalKind: null });
        if (!it || it.intent !== 'schedule_create') return 'I could not turn that into a posting schedule, so nothing was prepared. Try: "post PROP-001 every morning at 8 AM".';
        return this.proposeSchedule(it);
      }
      case 'schedule_pause': return this.schedulePause(pr.ref || 'schedule');
      case 'schedule_resume': return this.scheduleResume(pr.ref || 'schedule');
      case 'schedule_cancel': {
        const r = this._resolveSchedules(pr.ref || 'schedule', ['active', 'paused']);
        if (!r.schedules) return r.error === 'none' ? 'There is no schedule matching that.' : this._schedErr(r);
        const { task, note } = this._newProposal({ kind: 'ai_action', title: 'Cancel schedule', payload: { op: 'schedule_cancel', scheduleIds: r.schedules.map((s) => s.id) } });
        return note + this._renderDraft(task);
      }
      case 'schedule_list': return this.scheduleList({});
      default: return null;
    }
  },

  // ---------- data-backed answers (no AI wording of numbers) ----------
  listingQuery({ sort, limit, status }) {
    let rows = this.properties.list(status ? { status } : {});
    if (sort.startsWith('price')) rows = rows.filter((r) => r.price !== null);
    rows.sort((a, b) => (sort === 'price_asc' ? a.price - b.price : sort === 'price_desc' ? b.price - a.price : sort === 'oldest' ? a.id - b.id : b.id - a.id));
    if (!rows.length) return 'No listings match that.';
    rows = rows.slice(0, limit); this._saveView(rows.map((r) => r.id));
    const label = { price_asc: 'Lowest priced', price_desc: 'Highest priced', newest: 'Newest', oldest: 'Oldest' }[sort];
    return `*${label}${status ? ` (${status})` : ''}*\n${rows.map((p) => this._line(p)).join('\n')}`;
  },
  businessBriefing(now = this.clock()) {
    const tz = this.config.timezone; const h = hourOf(now, tz);
    const count = (st) => this.properties.list({ status: st }).length;
    const today = isoDate(now, tz);
    const active = this.schedules.list(['active']); const paused = this.schedules.list(['paused']);
    const todays = active.filter((s) => this.schedules.occursOn(s, today)).length;
    const next = active.filter((s) => s.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
    return [`Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}! Here's your business update.`, '',
      `Available listings: ${count('available')}`, `Drafts needing attention: ${count('draft')}`,
      `Reserved: ${count('reserved')}`, `Posts scheduled today: ${todays}`, `Paused schedules: ${paused.length}`, '',
      next ? `Your next post is ${this._fmt(new Date(next.next_run_at))}.` : 'No posts are scheduled.'].join('\n');
  },

  // ---------- advert generation ----------
  _adFacts(p) {
    const L = []; const add = (k, v) => { if (v !== null && v !== undefined && String(v).trim() !== '') L.push(`${k}: ${v}`); };
    add('Title', p.title); add('Category', p.category || p.ptype); add('Type', p.ptype); add('Listing', p.listing);
    add('Price', p.price ? `${naira(p.price)} (${p.price})` : null); add('Location', p.location);
    add('Bedrooms', p.bedrooms); add('Bathrooms', p.bathrooms); add('Land size', p.land_size);
    add('Features', p.features); add('Facilities', p.facilities); add('Documentation', p.documentation);
    add('Condition', p.item_condition); add('Quantity', p.quantity); add('Specifications', p.specs);
    add('Details', p.description ? p.description.slice(0, 600) : null); add('Contact', p.contact);
    return L.join('\n');
  },
  async proposeAiAdvert(p, ad) {
    if (!this.ai || !this.ai.enabled) return `My AI helper is not switched on, so I cannot rewrite adverts yet (${this.ai ? this.ai.reason : 'not configured'}). Here are the standard captions:\n\n${this.captionReply(p, 'all')}`;
    const facts = this._adFacts(p);
    let out;
    try { out = await this.ai.client.generateJson({ system: AD_SYSTEM, prompt: adPrompt(facts, ad.versions, ad.instruction), maxTokens: 900, temperature: 0.7 }); }
    catch (e) { audit(this.db, 'owner', 'ai.advert', 'failed', e.code || 'error'); return `${aiFailText(e)} The caption for ${p.ref} was not changed.`; }
    const raw = out && Array.isArray(out.versions) ? out.versions : [];
    const good = []; let why = null;
    for (const v of raw.slice(0, 3)) {
      if (typeof v !== 'string' || v.trim().length < 20 || v.length > 900) { why = why || 'a version was empty or too long'; continue; }
      const bad = adViolation(facts, p.price, v); if (bad) { why = why || bad; continue; }
      good.push(v.trim());
    }
    if (!good.length) { audit(this.db, 'owner', 'ai.advert', 'rejected', why || 'no usable version'); return `I could not write a version that stuck to your saved details (${why || 'no usable version'}), so ${p.ref}'s caption was NOT changed. You can still use /caption ${p.ref}.`; }
    const { task, note } = this._newProposal({ kind: 'ai_caption', title: `${p.ref} advert`, payload: { propertyId: p.id, versions: good, choice: 0 } });
    return note + this._renderDraft(task);
  },
  aiCaptionChoose(n, proposal) {
    const versions = proposal.payload.versions;
    if (!(n >= 1 && n <= versions.length)) return `Pick a number between 1 and ${versions.length}.`;
    this.store.updateProposal(proposal.id, { payload: { ...proposal.payload, choice: n - 1 }, expiresAt: new Date(this.clock().getTime() + this.config.proposalTtlMs).toISOString() });
    return 'Switched.\n' + this._renderDraft(this.store.get(proposal.id));
  },

  // ---------- /ai ----------
  async aiCommand(args) {
    const a = String(args || '').trim().toLowerCase();
    if (!this.ai || !this.ai.enabled) return `AI is OFF: ${this.ai ? this.ai.reason : 'not configured'}. Basic commands work normally. Set GEMINI_API_KEY (and leave AI_ENABLED unset or true) to switch it on.`;
    const st = this.ai.client.status();
    if (a === 'check') {
      const h = await this.ai.client.health();
      audit(this.db, 'owner', 'ai.health', h.ok ? 'ok' : (h.code || 'failed'));
      return h.ok ? `AI check passed: Gemini (${h.model}) answered in ${h.latencyMs} ms.` : `AI check FAILED (${h.code}): ${h.message}. Basic commands still work.`;
    }
    return `AI is configured (Gemini, model ${st.model}). That does not prove it works: say "check the AI" to test it for real.\nRequests today: ${st.requestsToday}/${st.dailyLimit}${st.lastOk ? `\nLast successful call: ${this._fmt(new Date(st.lastOk))}` : ''}${st.lastError ? `\nLast error: ${st.lastError.code}` : ''}`;
  },
};
module.exports.adViolation = adViolation;
