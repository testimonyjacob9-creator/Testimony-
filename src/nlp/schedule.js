'use strict';
const { localParts } = require('./time');
const { isoDate, addDaysIso } = require('../schedule/store');

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const MON_RE = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const dayIdx = (w) => DAY_NAMES.indexOf(w.slice(0, 3).toLowerCase());
const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const pretty = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;

function parseTimeOfDay(t) {
  let m = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (m) {
    const hr = +m[1]; const mi = m[2] ? +m[2] : 0;
    if (hr < 1 || hr > 12 || mi > 59) return null;
    return { h: (hr % 12) + (m[3][0] === 'p' ? 12 : 0), m: mi, assumption: null };
  }
  if ((m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:minutes?|mins?|hours?|hrs?))/))) {
    const hr = +m[1]; const mi = m[2] ? +m[2] : 0;
    if (hr > 23 || mi > 59) return null;
    if (hr >= 13 || hr === 0 || hr === 12) return { h: hr, m: mi, assumption: null };
    const h = hr <= 6 ? hr + 12 : hr;
    return { h, m: mi, assumption: `No AM/PM given, assumed ${pretty(h, mi)}` };
  }
  if (/\bnoon\b/.test(t)) return { h: 12, m: 0, assumption: null };
  if ((m = t.match(/\b(morning|afternoon|evening|night|tonight)\b/))) {
    const h = { morning: 8, afternoon: 14, evening: 18, night: 20, tonight: 20 }[m[1]];
    return { h, m: 0, assumption: `No exact time given, assumed ${pretty(h, 0)}` };
  }
  return null;
}

function parseDays(t) {
  if (/\bweekdays?\b/.test(t)) return { days: [1, 2, 3, 4, 5], range: true };
  if (/\bweekends?\b/.test(t)) return { days: [6, 0], range: true };
  const r = t.match(new RegExp(`\\b${DAY_RE}s?\\s*(?:to|-|through|thru|till|until)\\s*${DAY_RE}s?\\b`));
  if (r) { const a = dayIdx(r[1]); const b = dayIdx(r[2]); const days = []; for (let i = a; ; i = (i + 1) % 7) { days.push(i); if (i === b) break; } return { days, range: true }; }
  const named = [...t.matchAll(new RegExp(`\\b${DAY_RE}s?\\b`, 'g'))].map((x) => dayIdx(x[1]));
  return named.length ? { days: [...new Set(named)], range: false } : null;
}

function validIso(y, mo, d) { const dt = new Date(Date.UTC(y, mo - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null; }
function parseEndDate(t, now, tz) {
  const lead = '(?:until|till|through|ending(?: on)?|ends?(?: on)?)';
  const today = isoDate(now, tz); const year = +today.slice(0, 4);
  let m = t.match(new RegExp(`\\b${lead}\\s+(\\d{4})-(\\d{2})-(\\d{2})\\b`));
  if (m) return validIso(+m[1], +m[2], +m[3]);
  const pick = (d, mon, y) => { const mo = MON_RE.split('|').indexOf(mon.slice(0, 3)) + 1; let iso = validIso(y ? +y : year, mo, +d); if (iso && !y && iso < today) iso = validIso(year + 1, mo, +d); return iso; };
  if ((m = t.match(new RegExp(`\\b${lead}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON_RE})[a-z]*(?:\\s+(\\d{4}))?`)))) return pick(m[1], m[2], m[3]);
  if ((m = t.match(new RegExp(`\\b${lead}\\s+(${MON_RE})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`)))) return pick(m[2], m[1], m[3]);
  if ((m = t.match(/\bfor\s+(?:the\s+next\s+)?(\d+)\s+(day|week|month)s?\b/))) return addDaysIso(today, +m[1] * { day: 1, week: 7, month: 30 }[m[2]]);
  return null;
}

/** Parse a scheduling phrase. Never guesses silently: assumptions are returned and shown in the draft. */
function parseSchedulePhrase(text, now, tz) {
  const t = String(text).toLowerCase();
  const today = isoDate(now, tz); const lp = localParts(now, tz);
  if (/\b(now|right away|immediately)\b/.test(t) && !/\b(every|each|daily)\b/.test(t)) {
    return { immediate: true, kind: 'once', time: hm(lp.h, lp.mi), onceDate: today, startDate: today, endDate: null, days: null, assumptions: [] };
  }
  const tod = parseTimeOfDay(t); const dd = parseDays(t);
  const end = parseEndDate(t, now, tz);
  const recurring = /\b(every|each|daily|everyday|weekdays?|weekends?)\b/.test(t) || (dd && (dd.range || dd.days.length > 1));
  if (!tod) return { needTime: true };
  const assumptions = tod.assumption ? [tod.assumption] : [];
  const time = hm(tod.h, tod.m);
  if (recurring) {
    const days = dd ? dd.days : null;
    const full = days && new Set(days).size === 7;
    return { kind: days && !full ? 'days' : 'daily', days: days && !full ? [...days].sort((a, b) => a - b) : null, time, startDate: today, endDate: end, onceDate: null, assumptions };
  }
  const passed = lp.h * 60 + lp.mi >= tod.h * 60 + tod.m;
  let onceDate = today;
  const explicit = /\b(tomorrow)\b/.test(t) ? 'tomorrow' : /\b(today|tonight)\b/.test(t) ? 'today' : null;
  if (explicit === 'tomorrow') onceDate = addDaysIso(today, 1);
  else if (explicit === 'today') { if (passed) return { error: 'past' }; }
  else if (dd && dd.days.length === 1) { let delta = (dd.days[0] - lp.weekday + 7) % 7; if (delta === 0 && passed) delta = 7; onceDate = addDaysIso(today, delta); }
  else if (passed) { onceDate = addDaysIso(today, 1); assumptions.push('That time has already passed today, so I used tomorrow'); }
  return { kind: 'once', time, onceDate, startDate: onceDate, endDate: null, days: null, assumptions };
}

const hasWord = (t, re) => re.test(t);
/** Text -> schedule-related intent or null. Pure. */
function interpretSchedule(raw, st) {
  const t = raw.toLowerCase();
  if (/\bremind me\b/.test(t)) return null;
  const sid = /\bS-?\d{1,5}\b/i.test(raw);
  const scope = /\b(morning|afternoon|evening|night|schedules?|prop-?\s?\d+|property|apartment|flat|house|duplex|land|bungalow|room)\b/;
  const tod = parseTimeOfDay(t);
  const days = parseDays(t);
  const end = parseEndDate(t, st.now, st.tz);

  if (/\b(cancel|stop|delete|remove|end)\b[^.]*\b(schedules?|recurring)\b/.test(t) || (sid && /\b(cancel|stop|delete|remove)\b/.test(t))
    || /\bstop posting\b\s+(?!all\b|anything\b|everything\b|scheduled\b|for\b)\S/.test(t)
    || /\bcancel\b[^.]*\b(morning|afternoon|evening|night)\b[^.]*\b(posts?|status)\b/.test(t)) return { intent: 'schedule_cancel', text: raw };
  if (/\bpause\b/.test(t) && (sid || scope.test(t))) return { intent: 'schedule_pause', text: raw };
  if (/\b(resume|unpause|restart)\b/.test(t) && (sid || /\b(morning|afternoon|evening|night|schedules?|prop-?\s?\d+|property|posts?|apartment|house)\b/.test(t))) return { intent: 'schedule_resume', text: raw };
  if (/\b(show|list|view|display|what('| i)?s)\b/.test(t) && /\b(schedules?|scheduled posts?|recurring posts?)\b/.test(t)) return { intent: 'schedule_list', text: raw, day: /\btomorrow\b/.test(t) ? 'tomorrow' : /\btoday\b/.test(t) ? 'today' : null };

  const editVerb = /\b(change|move|set|make|reschedule|shift|update|edit)\b/.test(t);
  const looksLikeNewPost = /\b(post|publish|share|put up|run|send|promote|advertise)\b/.test(t) && /\b(status|this|that|it|prop-?\s?\d+|propert(?:y|ies)|video|photos?|listing|house|apartment|land|flat|duplex|groups?)\b/.test(t);
  if (st.proposalKind === 'schedule_create' && !looksLikeNewPost && (tod || days || end) && !/\b(show|list|what|which|cancel|pause|resume)\b/.test(t) && (editVerb || t.split(/\s+/).length <= 10)) return { intent: 'schedule_edit', draft: true, text: raw };
  if (editVerb && tod && (sid || /\b(time|schedule|posting|posts?|status|morning|afternoon|evening)\b/.test(t))) return { intent: 'schedule_edit', draft: false, text: raw };

  const postVerb = /\b(post|publish|share|put up|run|send|promote|advertise)\b/.test(t);
  const neg = /\b(stop|don'?t|do not|cancel|pause|never)\b/.test(t);
  const freq = /\b(every|each|daily|everyday|weekdays?|weekends?)\b/.test(t) || days;
  const nowWord = /\b(now|right away|immediately)\b/.test(t);
  const colon = raw.replace(/\d:\d\d/g, '').split(/[:\n]/);
  const explicitText = colon.length > 1 && colon.slice(1).join(' ').trim().length > 20;
  const noun = /\b(status|this|that|it|prop-?\s?\d+|propert(?:y|ies)|video|photos?|listing|house|apartment|land|flat|duplex|groups?)\b/.test(t);
  if (postVerb && !neg && !explicitText && noun && (freq || tod || nowWord || /\b(tomorrow|today|tonight)\b/.test(t))) {
    return { intent: 'schedule_create', text: raw, destination: /\bgroups?\b/.test(t) ? 'groups' : 'status', plan: parseSchedulePhrase(raw, st.now, st.tz) };
  }
  return null;
}

module.exports = { interpretSchedule, parseSchedulePhrase, parseTimeOfDay, parseDays, parseEndDate, pretty, hm };
