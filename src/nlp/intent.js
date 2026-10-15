'use strict';
const { parseWhen, atLocalDay, nextLocalMidnight } = require('./time');
const { looksLikeProperty } = require('../properties/parse');
const { interpretSchedule } = require('./schedule');

const CONFIRM = /^(yes|y|yep|yeah|yup|confirm(ed)?|ok(ay)?|go ahead|do it|proceed|sure|post it|send it|approve(d)?)[.! ]*$/i;
const DENY = /^(no|n|nope|nah|discard|abort|never ?mind|forget it|don'?t|do not)[.! ]*$/i;
const RESUME = /\b(resume|unpause|start (posting|again)|continue posting)\b/i;
const PAUSE = /\b(pause|hold off|halt|suspend)\b|\b(stop|don'?t|do not|no)\b.*\b(post|posts|posting|scheduled|automation|anything|everything)\b/i;
const CANCEL = /^\s*(cancel|discard|delete|remove)\b/i;
const TASKS = /\b(tasks?|to-?dos?|pending|scheduled|reminders?|awaiting|approval)\b/i;
const TASKS_VERB = /\b(show|list|what|which|view|see|any|my|everything|display)\b/i;
const STATUS = /\b(are you (online|connected|working|alive|there)|bot status|your status|connection status|how are you doing)\b/i;
const HELP = /^\s*(help|menu|what can you do\??|commands)\s*[?!.]*$/i;
const G_SELECT = /\b(select|choose|approve|authori[sz]e)\b.*\bgroups?\b/i;
const G_REMOVE = /\b(remove|deselect|unselect|drop|delete)\b.*\bgroups?\b/i;
const G_SHOW_SEL = /\b(show|list|see|view|display)\b.*\b(approved|selected|marketing)\b.*\bgroups?\b|\b(approved|selected|marketing) groups\b/i;
const G_SHOW = /\b(show|list|see|view|display)\b.*\bgroups\b/i;
const G_NEXT = /\b(next page|more groups)\b/i;
const ADVERT = /\b(send|post|share|broadcast|promote)\b.*\b(advert(isement)?|ad|listing|promo(tion)?|message|this|prop-?\s?\d+|propert(?:y|ies))\b.*\b(to|in|on)\b.*\bgroups?\b/i;
const C_ONLY = /\bonly\b.*\bgroups?\b/i;
const C_ADD = /\b(add|include)\b.*\bgroups?\b/i;
const C_REMOVE = /\b(remove|exclude|skip|drop)\b.*\bgroups?\b/i;
const P_LIST = /\b(show|list|see|view|display)\b.*\bproperties\b|^\s*properties\s*$/i;
const P_SHOW = /\b(show|view|open|details?)\b.*(\b(?:apartment|flat|duplex|bungalow|house|land|plot|shop|office|room|villa|mansion)\b|\bprop-?\s?\d+\b|\bproperty\s+(?:number\s+)?\d+\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:property|one)\b)/i;
const P_STATUS = /\b(mark|set|flag)\b.*\b(sold|rented|unavailable|available|reserved|withdrawn)\b|\b(?:prop-?\s?\d+|property\s+\d+)\b.*\b(?:is|has been|was)\s+(?:now\s+)?(sold|rented|unavailable|available|reserved|withdrawn)\b/i;
const P_EDIT = /\b(?:change|update|set|edit)\b\s+(?:the\s+)?(?:(?:prop-?\s?\d+|property\s+\d+|this)\s+)?(price|title|location|contact|phone|bedrooms?|bathrooms?|description|caption|listing)\b(?:\s+of\s+[\w\s-]+?)?\s+(?:to|as)\s+([\s\S]+)$/i;
const P_DELETE = /\b(delete|remove|discard)\b.*\b(prop-?\s?\d+|property|draft)\b/i;
const P_DONE = /^\s*(done|save( it)?|that'?s all|finished|all done)\s*[.!]*$/i;
const P_CAPTION = /\bcaptions?\b/i;
const AUDIENCE = /\b(status audience|who (can|will) see my status|status recipients)\b/i;
const C_STOP = /\b(stop|cancel|abort)\b.*\b(campaign|advert(isement)?|sending|group posts?)\b/i;
const UNSUPPORTED = [
  
  [/\b(buyer|seller|lead|client|follow ?up)\b/i, 'Lead management', 6],
];
const UNIT = { m: 60000, h: 3600000, d: 86400000 };

/** "1, 3 and 5", "2-4", "#2" -> [1,3,5] etc. */
function extractNumbers(str) {
  const out = new Set();
  const range = /(\d{1,3})\s*(?:-|to)\s*(\d{1,3})/g;
  for (const m of str.matchAll(range)) { const a = +m[1]; const b = +m[2]; if (a <= b && b - a < 50) for (let i = a; i <= b; i++) out.add(i); }
  for (const m of str.replace(range, ' ').matchAll(/\b\d{1,3}\b/g)) out.add(+m[0]);
  return [...out].filter((n) => n > 0).sort((a, b) => a - b);
}
function nameQuery(raw) {
  return raw.replace(/\b(please|remove|deselect|unselect|drop|delete|the|my|group|groups|from|approved|marketing|list|selected|exclude|skip)\b/gi, ' ').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function splitAdvert(raw) {
  const idx = raw.search(/[:\n]/);
  return { head: idx >= 0 ? raw.slice(0, idx) : raw, text: idx >= 0 ? raw.slice(idx + 1).trim() : '' };
}

function parsePauseUntil(text, now, tz) {
  const t = text.toLowerCase();
  if (/\b(until|till)\s+tomorrow\b/.test(t)) return atLocalDay(now, tz, 1, 6, 0);
  if (/\b(today|rest of the day|tonight)\b/.test(t)) return nextLocalMidnight(now, tz);
  let m = t.match(/\bfor\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/);
  if (m) return new Date(now.getTime() + parseInt(m[1], 10) * UNIT[m[2][0]]);
  if (/\b(until|till)\b/.test(t)) { const w = parseWhen(t.replace(/^.*?\b(until|till)\b/, ''), now, tz); if (w && w.date) return w.date; }
  return null;
}

function reminderSlots(body, st, prior) {
  const when = parseWhen(body, st.now, st.tz);
  let title = prior && prior.title ? prior.title : null;
  let whenDate = prior && prior.whenIso ? new Date(prior.whenIso) : null;
  let problem = null;
  if (when && when.error === 'past') problem = 'past';
  else if (when) whenDate = when.date;
  if (!title) {
    const raw = (when ? when.rest : body) || '';
    title = raw.replace(/^(to|about|that)\s+/i, '').trim() || null;
  }
  return { intent: 'reminder_slots', title, when: whenDate, assumptions: (when && when.assumptions) || [], problem };
}

/** Pure text -> structured intent. No provider or database access. */
function interpret(text, st) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'empty' };
  if (raw.startsWith('/')) {
    const m = raw.match(/^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/);
    return m ? { intent: 'command', name: m[1].toLowerCase(), args: m[2].trim() } : { intent: 'unknown' };
  }
  if (CONFIRM.test(raw)) return { intent: 'confirm' };
  if (DENY.test(raw)) return { intent: 'deny' };
  const rm = raw.match(/\bremind me\b\s*(?:to\s+|about\s+|that\s+)?([\s\S]*)$/i);
  if (rm) return reminderSlots(rm[1], st, null);
  if (/\bchannels?\b/i.test(raw) && /\b(post|send|publish|share|schedule|promote)\b/i.test(raw)) return { intent: 'unsupported', custom: 'Posting to WhatsApp Channels is DISABLED: it has not been shown to work reliably with this WhatsApp library (see docs/DESTINATIONS.md). Nothing was posted or scheduled. I can post to your Status or your approved groups instead.' };
  const sch = interpretSchedule(raw, st);
  if (sch) return sch;
  if (st.proposalKind === 'campaign' && !splitAdvert(raw).text) {
    if (C_ONLY.test(raw)) return { intent: 'campaign_retarget', mode: 'only', numbers: extractNumbers(raw) };
    if (C_ADD.test(raw)) return { intent: 'campaign_retarget', mode: 'add', numbers: extractNumbers(raw) };
    if (C_REMOVE.test(raw)) return { intent: 'campaign_retarget', mode: 'remove', numbers: extractNumbers(raw) };
  }
  if (P_DONE.test(raw)) return { intent: 'property_done' };
  if (P_EDIT.test(raw)) { const m = raw.match(P_EDIT); return { intent: 'property_edit', field: m[1], value: m[2], text: raw.slice(0, raw.length - m[2].length) }; }
  if (P_STATUS.test(raw)) { const m = raw.match(/\b(sold|rented|unavailable|available|reserved|withdrawn)\b/i); return { intent: 'property_status', status: m[1].toLowerCase(), text: raw }; }
  if (P_DELETE.test(raw)) return { intent: 'property_delete', text: raw };
  if (P_CAPTION.test(raw)) { const t = raw.toLowerCase(); return { intent: 'caption', style: /\bshort\b/.test(t) ? 'short' : /\b(long|detailed)\b/.test(t) ? 'long' : 'all', text: raw }; }
  if (P_SHOW.test(raw)) return { intent: 'property_show', text: raw };
  if (P_LIST.test(raw)) return { intent: 'property_list', text: raw };
  if (st.hasActiveProperty && !looksLikeProperty(raw) && raw.length < 90 && /\b(contact|phone|whatsapp|call|number)\b/i.test(raw) && /(?:\+?234[\s-]?|\b0)[789][01]\d[\s-]?\d{3}[\s-]?\d{4}\b/.test(raw)) return { intent: 'property_contact', text: raw };
  if (AUDIENCE.test(raw)) return { intent: 'command', name: 'audience', args: '' };
  if (C_STOP.test(raw)) return { intent: 'campaign_stop' };
  if (ADVERT.test(raw)) { const { head, text } = splitAdvert(raw); return { intent: 'advert', text, numbers: extractNumbers(head.replace(/prop-?\s?\d+/ig, ' ')), raw }; }
  if (G_NEXT.test(raw)) return { intent: 'groups_page', delta: 1 };
  if (G_SELECT.test(raw)) return { intent: 'groups_select', numbers: extractNumbers(raw) };
  if (G_REMOVE.test(raw)) return { intent: 'groups_remove', numbers: extractNumbers(raw), name: nameQuery(raw) };
  if (G_SHOW_SEL.test(raw)) return { intent: 'groups_show', which: 'selected' };
  if (G_SHOW.test(raw)) return { intent: 'groups_show', which: 'discovery' };
  if (RESUME.test(raw)) return { intent: 'resume' };
  if (PAUSE.test(raw)) return { intent: 'pause', until: parsePauseUntil(raw, st.now, st.tz) };
  if (CANCEL.test(raw)) {
    const id = raw.match(/\b(?:t-?|task\s*#?|reminder\s*#?)(\d+)\b/i);
    return { intent: 'cancel', id: id ? Number(id[1]) : null, all: /\ball\b/i.test(raw) };
  }
  if (TASKS.test(raw) && TASKS_VERB.test(raw)) {
    const day = /\btomorrow\b/i.test(raw) ? 'tomorrow' : /\btoday\b/i.test(raw) ? 'today' : null;
    return { intent: 'tasks', day, approvalsOnly: /\b(awaiting|approval)\b/i.test(raw) };
  }
  if (STATUS.test(raw)) return { intent: 'status' };
  if (HELP.test(raw)) return { intent: 'help' };
  if (st.awaiting) return reminderSlots(raw, st, st.awaiting);
  if (st.proposalKind === 'reminder') {
    const w = parseWhen(raw, st.now, st.tz);
    if (w && w.error) return { intent: 'modify_time', problem: 'past' };
    if (w) return { intent: 'modify_time', when: w };
  }
  if (raw.length < 120 && /\b(buyer|seller|lead|client|prospect)\b/i.test(raw)) return { intent: 'unsupported', feature: 'Lead management', phase: 6 };
  // Long free text that is not phrased as an instruction is content (e.g. an advert), not a feature request.
  const looksLikeInstruction = /^\s*(please\s+)?(post|send|publish|share|schedule|promote|add|create|show)\b/i.test(raw);
  if (raw.length < 40 || looksLikeInstruction) {
    for (const [re, feature, phase] of UNSUPPORTED) if (re.test(raw)) return { intent: 'unsupported', feature, phase };
  }
  return { intent: 'unknown' };
}

module.exports = { interpret, parsePauseUntil, extractNumbers };
