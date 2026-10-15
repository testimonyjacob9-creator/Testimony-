'use strict';
const { extract, extractItem, parsePrice, looksLikeProperty, titleFor, missingFields, PHONE } = require('./parse');
const { buildCaption, naira } = require('./caption');
const { audit } = require('../storage/db');
const { getSetting, setSetting, deleteSetting } = require('../storage/settings');

const ACTIVE_MS = 2 * 3600000;
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const STOP = new Set(['the', 'a', 'an', 'my', 'this', 'that', 'it', 'property', 'properties', 'show', 'post', 'stop', 'posting', 'old', 'new', 'of', 'in', 'for', 'to', 'mark', 'as', 'delete', 'remove', 'and', 'please', 'prepare', 'captions', 'caption', 'different', 'three', 'set', 'change', 'update', 'edit', 'price', 'title', 'location', 'contact', 'phone', 'bedrooms', 'bedroom', 'bathrooms', 'bathroom', 'description', 'listing', 'sold', 'rented', 'unavailable', 'available', 'flag', 'also', 'with', 'from', 'are', 'was', 'has', 'been', 'now', 'number', 'details', 'view', 'open']);
const FIELD_ALIAS = { phone: 'contact', bedroom: 'bedrooms', bathroom: 'bathrooms' };

module.exports = {
  _setActive(id) { setSetting(this.db, 'active_property', { id, at: this.clock().toISOString() }); },
  _activeProperty() {
    const a = getSetting(this.db, 'active_property');
    if (!a || this.clock() - new Date(a.at) > ACTIVE_MS) return null;
    return this.properties.get(a.id);
  },
  _saveView(ids) { setSetting(this.db, 'property_view', { ids, at: this.clock().toISOString() }); },

  /** Resolve what the owner is referring to. Returns { property } | { error, matches? }. */
  _resolveProperty(text = '', { allowActive = true } = {}) {
    const t = String(text);
    let m = t.match(/\bprop-?\s?(\d{1,5})\b/i);
    if (m) { const p = this.properties.getByRef(`PROP-${String(Number(m[1])).padStart(3, '0')}`); return p ? { property: p } : { error: 'none' }; }
    if ((m = t.match(/\bproperty\s+(?:number\s+|no\.?\s*)?(\d{1,5})\b/i))) { const p = this.properties.get(Number(m[1])); return p ? { property: p } : { error: 'none' }; }
    if ((m = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:property|one)\b/i))) {
      const view = getSetting(this.db, 'property_view'); const id = view && view.ids[ORD[m[1].toLowerCase()] - 1];
      const p = id && this.properties.get(id); return p ? { property: p } : { error: 'none' };
    }
    const words = t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && !/^(prop|\d+)$/.test(w) && w.length > 2);
    const wantsThis = /\b(this|it|that)\b/i.test(t) || !words.length;
    if (wantsThis && allowActive) { const a = this._activeProperty(); if (a) return { property: a }; if (!words.length) return { error: 'none_active' }; }
    if (words.length) {
      const matches = this.properties.list({}).filter((p) => { const hay = `${p.title || ''} ${p.location || ''} ${p.ptype || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
      if (matches.length === 1) return { property: matches[0] };
      if (matches.length > 1) return { error: 'ambiguous', matches };
    }
    return { error: 'none' };
  },
  _refError(r) {
    if (r.error === 'ambiguous') return `More than one property matches:\n${r.matches.slice(0, 8).map((p) => `${p.ref} - ${p.title || '(untitled)'}${p.status !== 'available' ? ` (${p.status})` : ''}`).join('\n')}\nSay which one, e.g. "${r.matches[0].ref}".`;
    if (r.error === 'none_active') return 'Which property? Send its details first, or name it (e.g. PROP-001). /properties lists them.';
    return 'I could not find a matching property. /properties lists them.';
  },

  _line(p) {
    const c = this.media.counts(p.id);
    return `${p.ref} | ${p.title || '(no title yet)'} | ${p.price ? naira(p.price) : 'price?'} | ${p.status} | ${c.images} photo(s), ${c.videos} video(s)`;
  },

  // ---------- intake ----------
  _defaultContact() { const c = getSetting(this.db, 'default_contact'); return c && c.number ? c.number : null; },
  contactCommand(args) {
    const m = String(args || '').match(PHONE);
    if (!String(args || '').trim()) { const c = this._defaultContact(); return c ? `Your saved contact number is ${c}. It is added to new items and properties that do not state one. Change it with /contact <number>.` : 'No contact number is saved. Send /contact 08012345678 once and I will add it to new items and properties.'; }
    if (!m) return 'That does not look like a Nigerian phone number. Example: /contact 08012345678. Nothing was changed.';
    const number = `0${m[1]}${m[2]}${m[3]}`;
    setSetting(this.db, 'default_contact', { number, at: this.clock().toISOString() });
    audit(this.db, 'owner', 'contact.default', 'ok');
    return `Saved. New items and properties without their own number will use ${number}. Items already created are not changed.`;
  },
  _createItem(caption) {
    const f = extractItem(caption);
    const p = this.properties.create({ ptype: 'item', title: f.title, price: f.price, contact: f.contact || this._defaultContact() || undefined, description: caption.slice(0, 1500) }, 'draft');
    const b = getSetting(this.db, 'item_batch'); const now = this.clock();
    const fresh = b && now - new Date(b.at) < 30 * 60000;
    setSetting(this.db, 'item_batch', { ids: [...(fresh ? b.ids : []), p.id], at: now.toISOString() });
    audit(this.db, 'owner', 'item.create', 'ok', p.ref);
    return p;
  },
  _createFromText(text) {
    const f = extract(text); if (!f.contact && this._defaultContact()) f.contact = this._defaultContact();
    const p = this.properties.create({ ...f, title: titleFor(f, text), description: text.slice(0, 1500) }, 'draft');
    audit(this.db, 'owner', 'property.create', 'ok', p.ref);
    return p;
  },
  propertyIntake(text) {
    const f = extract(text);
    const active = this._activeProperty();
    let p;
    if (active && active.status === 'draft' && !active.description && !active.ptype) {
      this.properties.update(active.id, { ...f, title: titleFor(f, text), description: text.slice(0, 1500) });
      p = this.properties.get(active.id);
      audit(this.db, 'owner', 'property.fill', 'ok', p.ref);
    } else p = this._createFromText(text);
    this._setActive(p.id);
    return this._intakeReply(p);
  },
  _intakeReply(p) {
    const c = this.media.counts(p.id); const miss = missingFields(p);
    return `*${p.ref} saved as a DRAFT* (not posted anywhere)\n${p.title || '(no title yet)'}\nPrice: ${p.price ? naira(p.price) : 'not stated'} | Photos: ${c.images} | Videos: ${c.videos}${miss.length ? `\nStill missing: ${miss.join(', ')}` : ''}\nSend photos/videos now${miss.length ? ', give the missing details (e.g. "set contact to 08012345678")' : ''}, then say *done* to make it available. Nothing is posted until you confirm a post or schedule.`;
  },
  propertyDone() {
    const b = getSetting(this.db, 'item_batch');
    if (b && this.clock() - new Date(b.at) < 30 * 60000) {
      const drafts = b.ids.map((id) => this.properties.get(id)).filter((x) => x && x.status === 'draft');
      if (drafts.length) {
        for (const x of drafts) this.properties.setStatus(x.id, 'available');
        audit(this.db, 'owner', 'item.available', 'ok', String(drafts.length));
        return `${drafts.length} item(s) are now AVAILABLE (not posted anywhere): ${drafts.map((x) => x.ref).join(', ')}. To post them: "post these on my status now".`;
      }
    }
    const p = this._activeProperty();
    if (!p) return 'There is no property in progress. Send a description or photos first.';
    if (p.status !== 'draft') return `${p.ref} is already ${p.status}.`;
    this.properties.setStatus(p.id, 'available');
    audit(this.db, 'owner', 'property.available', 'ok', p.ref);
    const miss = missingFields(p);
    return `${p.ref} is now AVAILABLE (still not posted anywhere).${miss.length ? ` Note: still missing ${miss.join(', ')}.` : ''} To post it: "post this every morning at 8 AM".`;
  },
  propertyAddContact(text) {
    const p = this._activeProperty(); const m = text.match(PHONE);
    if (!p || !m) return null;
    const contact = `0${m[1]}${m[2]}${m[3]}`;
    this.properties.update(p.id, { contact });
    return `Contact for ${p.ref} set to ${contact}.`;
  },

  // ---------- media ----------
  async _handleMedia(msg) {
    const media = msg.media;
    const reply = (t) => this._send(msg.chat, `${this.prefix} ${t}`);
    if (!['image', 'video'].includes(media.type)) { await reply(`I can only store photos and videos for listings (not ${media.type}s yet). Nothing was saved.`); return { handled: true }; }
    const v = this.media.validate(media.mime, media.size);
    if (!v.ok) { await reply(`I did not save that file: ${v.error}.`); return { handled: true }; }
    if (typeof media.open !== 'function') { await reply('The WhatsApp provider could not give me that file, so it was NOT saved.'); return { handled: true }; }
    const caption = (msg.text || '').trim();
    let p; let created = false; let isItem = false;
    if (caption && looksLikeProperty(caption)) { p = this._createFromText(caption); created = true; }
    else if (caption.length >= 3 && !caption.startsWith('/') && !/^(done|yes|no)\b/i.test(caption)) { p = this._createItem(caption); created = true; isItem = true; }
    else p = this._activeProperty();
    if (!p) { p = this.properties.create({}, 'draft'); created = true; audit(this.db, 'owner', 'property.create', 'ok', p.ref); }
    let res;
    try { res = await this.media.save({ property: p, mime: media.mime, declaredSize: media.size, originalName: media.fileName, stream: await media.open() }); }
    catch (e) { res = { ok: false, error: e.message }; }
    if (!res.ok) {
      if (created && !this.media.forProperty(p.id).length && (!p.description || isItem)) this.properties.softDelete(p.id);
      await reply(`I could NOT save that file: ${res.error}.`);
      return { handled: true };
    }
    this._setActive(p.id);
    audit(this.db, 'owner', 'media.save', res.duplicate ? 'duplicate' : 'ok', p.ref);
    const acc = this.mediaAck.get(p.id) || { saved: 0, dupes: 0, chat: msg.chat, intro: null, item: p.ptype === 'item' };
    if (res.duplicate) acc.dupes++; else acc.saved++;
    if (created && caption && !isItem) acc.intro = this._intakeReply(this.properties.get(p.id));
    acc.chat = msg.chat; this.mediaAck.set(p.id, acc);
    if (!this.mediaAckTimer) { this.mediaAckTimer = setTimeout(() => { this.flushMediaAck().catch(() => {}); }, this.config.mediaAckDelayMs); this.mediaAckTimer.unref?.(); }
    return { handled: true };
  },
  /** One summary per burst of uploads instead of one message per photo. */
  async flushMediaAck() {
    if (this.mediaAckTimer) { clearTimeout(this.mediaAckTimer); this.mediaAckTimer = null; }
    const entries = [...this.mediaAck.entries()]; this.mediaAck.clear();
    const itemEntries = entries.filter(([, acc]) => acc.item);
    if (itemEntries.length) {
      const rows = itemEntries.map(([id]) => this.properties.get(id)).filter(Boolean);
      if (rows.length) {
        const noPrice = rows.filter((p) => !p.price).map((p) => p.ref); const noContact = rows.some((p) => !p.contact);
        const lines = rows.map((p) => `${p.ref} | ${p.title} | ${p.price ? naira(p.price) : 'price?'} | ${this.media.counts(p.id).images} photo(s), ${this.media.counts(p.id).videos} video(s)`);
        await this._send(itemEntries[0][1].chat, `${this.prefix} Saved ${rows.length} item(s) as DRAFTS (not posted anywhere):\n${lines.join('\n')}${noPrice.length ? `\nNo price found for: ${noPrice.join(', ')}. Add one like "Change the price of ${noPrice[0]} to ₦15,000", or put it in the caption (e.g. ₦15,000).` : ''}${noContact ? '\nNo contact number on some items: send /contact 08012345678 once, then new items will use it.' : ''}\nSay *done* to make all of these available, then "post these on my status now".`);
      }
    }
    for (const [id, acc] of entries.filter(([, a]) => !a.item)) {
      const p = this.properties.get(id); if (!p) continue;
      const c = this.media.counts(id);
      const msg = `${acc.intro ? acc.intro + '\n' : ''}Saved ${acc.saved} file(s) to ${p.ref}${acc.dupes ? ` (${acc.dupes} duplicate(s) ignored)` : ''}. It now has ${c.images} photo(s) and ${c.videos} video(s).${p.status === 'draft' && !acc.intro ? ' Say *done* when finished.' : ''}`;
      await this._send(acc.chat, `${this.prefix} ${msg}`);
    }
  },

  proposeStatusBatch(which) {
    const caps = this.provider.capabilities();
    if (!caps.publishStatus) return 'The current WhatsApp provider cannot post Status updates, so I did nothing.';
    if (!this.audience.count()) return 'There are no known Status recipients yet (see /audience). Nothing was prepared.';
    let ids;
    if (which === 'all') ids = this.properties.list({ status: 'available', ptype: 'item' }).map((x) => x.id);
    else { const b = getSetting(this.db, 'item_batch'); ids = b && this.clock() - new Date(b.at) < 2 * 3600000 ? b.ids : []; }
    const props = ids.map((id) => this.properties.get(id)).filter((x) => x && ['draft', 'available'].includes(x.status));
    if (!props.length) return 'There are no items waiting to post. Send photos with captions first (or say "post all items on my status now" for everything available). Nothing was prepared.';
    const MAX = 10; const chosen = props.slice(0, MAX);
    const { task, note } = this._newProposal({ kind: 'status_batch', title: `Post ${chosen.length} item(s) to Status`, payload: { propertyIds: chosen.map((x) => x.id), skipped: props.length - chosen.length } });
    return note + this._renderDraft(task);
  },

  // ---------- show / list / edit ----------
  _postedSummary(p) {
    const pubs = this.db.prepare(`SELECT destination, COUNT(*) AS n, MAX(at) AS last FROM publications WHERE property_id = ? AND outcome = 'accepted' GROUP BY destination`).all(p.id);
    return pubs.length ? pubs.map((x) => `${x.destination} x${x.n} (last ${this._fmt(new Date(x.last))})`).join('; ') : 'not posted yet';
  },
  propertyShow(p) {
    this._setActive(p.id);
    const c = this.media.counts(p.id); const miss = missingFields(p);
    const rows = [
      `*${p.ref}* - ${p.status.toUpperCase()}`, p.title || '(no title yet)',
      `Price: ${p.price ? naira(p.price) : '-'} | ${p.listing ? 'For ' + p.listing : 'sale/rent: -'} | ${p.ptype || 'type: -'}`,
      `Beds: ${p.bedrooms ?? '-'} | Baths: ${p.bathrooms ?? '-'} | Land: ${p.land_size || '-'}`,
      p.features ? `Features: ${p.features}` : null, p.documentation ? `Documents: ${p.documentation}` : null,
      `Contact: ${p.contact || '-'}${p.agent ? ` (${p.agent})` : ''}`, `Media: ${c.images} photo(s), ${c.videos} video(s)`,
      `Posted: ${this._postedSummary(p)}`, miss.length ? `Missing: ${miss.join(', ')}` : null,
    ].filter(Boolean);
    if (this.schedules) { const s = this.schedules.forProperty(p.id).filter((x) => ['active', 'paused'].includes(x.status)); if (s.length) rows.push(`Schedules: ${s.map((x) => `S-${x.id} ${x.status}`).join(', ')}`); }
    return rows.join('\n');
  },
  propertyList(filters = {}, page = 1) {
    const rows = this.properties.list(filters);
    if (!rows.length) return `No properties found${Object.keys(filters).length ? ' for that filter' : ''}. Send a description to add one.`;
    this._saveView(rows.map((r) => r.id));
    const pages = Math.ceil(rows.length / 10); const pg = Math.min(Math.max(1, page), pages);
    return `*Properties* (${rows.length})\n${rows.slice((pg - 1) * 10, pg * 10).map((p) => this._line(p)).join('\n')}${pages > 1 ? `\nPage ${pg}/${pages}: /properties page ${pg + 1}` : ''}\nOpen one: "show PROP-001" - or "the second property".`;
  },
  propertyStatusChange(p, status) {
    this.properties.setStatus(p.id, status);
    audit(this.db, 'owner', `property.${status}`, 'ok', p.ref);
    let extra = '';
    if (status !== 'available' && this.schedules) {
      const n = this.schedules.pauseForProperty(p.id, `${p.ref} is ${status}`);
      if (n) extra = ` ${n} schedule(s) for it were PAUSED and will not post it.`;
    }
    if (status === 'available' && this.schedules && this.schedules.forProperty(p.id).some((s) => s.status === 'paused')) extra = ' Its paused schedules stay paused until you resume them.';
    return `${p.ref} is now ${status.toUpperCase()}.${extra}`;
  },
  propertyEdit(p, fieldRaw, value) {
    const field = FIELD_ALIAS[String(fieldRaw).toLowerCase()] || String(fieldRaw).toLowerCase();
    const v = String(value).trim().replace(/[.\s]+$/, '');
    let parsed;
    if (field === 'price') { parsed = parsePrice(v, { loose: true }); if (!parsed) return `I could not read "${v}" as a price (e.g. 30 million, N30m, 30,000,000). Nothing changed.`; }
    else if (field === 'bedrooms' || field === 'bathrooms') { parsed = parseInt(v, 10); if (!(parsed >= 0 && parsed < 100)) return `"${v}" is not a valid number. Nothing changed.`; }
    else if (field === 'listing') { const l = v.toLowerCase().replace(/^for\s+/, ''); if (!['sale', 'rent', 'lease'].includes(l)) return 'Listing must be sale, rent or lease. Nothing changed.'; parsed = l; }
    else if (field === 'contact') { const m = v.match(PHONE); parsed = m ? `0${m[1]}${m[2]}${m[3]}` : v.slice(0, 60); }
    else if (['title', 'location', 'ptype', 'features', 'facilities', 'documentation', 'agent', 'description', 'caption', 'land_size'].includes(field)) parsed = v.slice(0, 1500);
    else return `I can edit: price, title, location, listing, bedrooms, bathrooms, contact, features, description, caption. Nothing changed.`;
    this.properties.update(p.id, { [field]: parsed });
    this._setActive(p.id);
    audit(this.db, 'owner', 'property.edit', 'ok', `${p.ref}:${field}`);
    return `Updated ${p.ref} ${field}: ${field === 'price' ? naira(parsed) : parsed}.`;
  },
  propertyDelete(p) {
    if (p.status === 'draft') {
      this.media.removeAll(p.id); this.properties.softDelete(p.id);
      audit(this.db, 'owner', 'property.delete', 'ok', p.ref);
      return `Draft ${p.ref} deleted.`;
    }
    const { task, note } = this._newProposal({ kind: 'property_delete', title: `Delete ${p.ref}`, payload: { propertyId: p.id } });
    return note + this._renderDraft(task);
  },
  captionReply(p, style) {
    const styles = style === 'all' ? [['Short (Status)', 'short'], ['Standard', 'standard'], ['Detailed (groups)', 'long']] : [[style, style]];
    return `Captions for ${p.ref} (built only from the saved details${p.caption ? '; your custom caption overrides all styles' : ''}):\n\n${styles.map(([label, s]) => `*${label}*\n${buildCaption(p, s)}`).join('\n\n')}`;
  },

  propertyCommand(args) {
    const a = args.trim(); const lower = a.toLowerCase();
    if (!a) return this.propertyList({});
    if (lower === 'done') return this.propertyDone();
    const first = lower.split(/\s+/)[0];
    const rest = a.slice(first.length).trim();
    if (['sold', 'rented', 'unavailable', 'available'].includes(first)) { const r = this._resolveProperty(rest); return r.property ? this.propertyStatusChange(r.property, first) : this._refError(r); }
    if (first === 'delete') { const r = this._resolveProperty(rest, { allowActive: false }); return r.property ? this.propertyDelete(r.property) : this._refError(r); }
    if (first === 'set') {
      const m = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
      if (!m) return 'Usage: /property set PROP-001 price 30m';
      const r = this._resolveProperty(m[1], { allowActive: false });
      return r.property ? this.propertyEdit(r.property, m[2], m[3]) : this._refError(r);
    }
    const r = this._resolveProperty(a);
    return r.property ? this.propertyShow(r.property) : this._refError(r);
  },
};

module.exports.parseFilters = function parseFilters(text) {
  const f = {}; const t = String(text);
  let m;
  if ((m = t.match(/\b(?:below|under|less than|max(?:imum)?|cheaper than)\s+([₦#N]?\s?[\d.,]+\s?(?:million|billion|thousand|m|k|b)?)/i))) { const v = parsePrice(m[1], { loose: true }); if (v) f.maxPrice = v; }
  if ((m = t.match(/\b(?:above|over|more than|at least|min(?:imum)?)\s+([₦#N]?\s?[\d.,]+\s?(?:million|billion|thousand|m|k|b)?)/i))) { const v = parsePrice(m[1], { loose: true }); if (v) f.minPrice = v; }
  if ((m = t.match(/\bin\s+([A-Za-z][A-Za-z'-]+)/i)) && !/^(stock|the|my|total|all)$/i.test(m[1])) f.location = m[1];
  if ((m = t.match(/\b(available|sold|rented|unavailable|draft)\b/i))) f.status = m[1].toLowerCase();
  const ex = extract(t.replace(/\bproperties\b/gi, ' ')); if (ex.ptype) f.ptype = ex.ptype; if (ex.bedrooms) f.bedrooms = ex.bedrooms;
  return f;
};
