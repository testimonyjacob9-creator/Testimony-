'use strict';
/** Strict validation of what Gemini proposes. Anything outside this schema is rejected, never "repaired". */
const ACTIONS = ['reply', 'clarify', 'list_listings', 'query_listings', 'show_listing', 'set_status', 'edit_field', 'draft_ad',
  'schedule_create', 'schedule_pause', 'schedule_resume', 'schedule_cancel', 'schedule_list', 'briefing', 'none'];
const STATUSES = ['draft', 'available', 'reserved', 'sold', 'unavailable', 'withdrawn'];
const FIELDS = ['price', 'title', 'location', 'contact', 'description', 'bedrooms', 'bathrooms'];
const SORTS = ['price_asc', 'price_desc', 'newest', 'oldest'];
const REF = /^PROP-\d{1,5}$/;

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const nullable = (v) => v === null || v === undefined;

function validateProposal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'not an object' };
  const out = { action: raw.action };
  if (!ACTIONS.includes(raw.action)) return { ok: false, error: 'unknown action' };
  if (!nullable(raw.ref)) { if (!isStr(raw.ref, 12) || !REF.test(raw.ref.toUpperCase())) return { ok: false, error: 'bad ref' }; out.ref = raw.ref.toUpperCase(); } else out.ref = null;
  if (!nullable(raw.text)) { if (!isStr(raw.text, 600)) return { ok: false, error: 'bad text' }; out.text = raw.text.trim(); } else out.text = null;

  switch (raw.action) {
    case 'reply': case 'clarify':
      if (!out.text) return { ok: false, error: 'text required' };
      break;
    case 'show_listing':
      if (!out.ref) return { ok: false, error: 'ref required' };
      break;
    case 'list_listings':
      if (!nullable(raw.status)) { if (!STATUSES.includes(raw.status)) return { ok: false, error: 'bad status' }; out.status = raw.status; }
      break;
    case 'query_listings': {
      out.sort = raw.sort; if (!SORTS.includes(out.sort)) return { ok: false, error: 'bad sort' };
      out.limit = nullable(raw.limit) ? 5 : raw.limit; if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 10) return { ok: false, error: 'bad limit' };
      if (!nullable(raw.status)) { if (!STATUSES.includes(raw.status)) return { ok: false, error: 'bad status' }; out.status = raw.status; }
      break;
    }
    case 'set_status':
      if (!out.ref) return { ok: false, error: 'ref required' };
      if (!STATUSES.includes(raw.status) || raw.status === 'draft') return { ok: false, error: 'bad status' };
      out.status = raw.status; break;
    case 'edit_field':
      if (!out.ref) return { ok: false, error: 'ref required' };
      if (!FIELDS.includes(raw.field)) return { ok: false, error: 'bad field' };
      if (!isStr(raw.value, 500) || !String(raw.value).trim()) return { ok: false, error: 'bad value' };
      out.field = raw.field; out.value = raw.value.trim(); break;
    case 'draft_ad': {
      const ad = raw.ad || {};
      out.versions = nullable(ad.versions) ? 1 : ad.versions;
      if (!Number.isInteger(out.versions) || out.versions < 1 || out.versions > 3) return { ok: false, error: 'bad versions' };
      out.instruction = nullable(ad.instruction) ? '' : ad.instruction;
      if (!isStr(out.instruction, 200)) return { ok: false, error: 'bad instruction' };
      break;
    }
    case 'schedule_create': {
      const s = raw.schedule || {};
      if (!['daily', 'days', 'once'].includes(s.frequency)) return { ok: false, error: 'bad frequency' };
      if (!isStr(s.time, 5) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return { ok: false, error: 'bad time' };
      if (!['status', 'groups'].includes(s.destination || 'status')) return { ok: false, error: 'bad destination' };
      let days = null;
      if (s.frequency === 'days') { if (!Array.isArray(s.days) || !s.days.length || s.days.length > 7 || !s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { ok: false, error: 'bad days' }; days = [...new Set(s.days)]; }
      out.schedule = { frequency: s.frequency, time: s.time, days, destination: s.destination || 'status', tomorrow: s.tomorrow === true };
      break;
    }
    default: break;
  }
  return { ok: true, proposal: out };
}
module.exports = { validateProposal, ACTIONS, STATUSES, FIELDS };
