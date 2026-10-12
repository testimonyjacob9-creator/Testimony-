'use strict';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PERIODS = { morning: 8, afternoon: 14, evening: 18, night: 20 };

function tzParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), mi: g('minute'), s: g('second') };
}
function tzOffsetMs(date, tz) {
  const p = tzParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}
function localParts(date, tz) {
  const p = tzParts(date, tz);
  return { ...p, weekday: new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() };
}
function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = tzOffsetMs(new Date(guess), tz);
  let t = guess - off;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}
function atLocalDay(now, tz, dayOffset, h, mi = 0) {
  const p = localParts(now, tz);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + dayOffset));
  return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi, tz);
}
const nextLocalMidnight = (now, tz) => atLocalDay(now, tz, 1, 0, 0);

function formatLocal(date, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
}
function localDateKey(date, tz) { const p = localParts(date, tz); return `${p.y}-${p.m}-${p.d}`; }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function strip(text, matched) {
  let out = text;
  for (const frag of matched) out = out.replace(new RegExp(esc(frag), 'i'), ' ');
  out = out.replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = out; out = out.replace(/^(at|by|on|in|for|to|this)\b\s*/i, '').replace(/\s*\b(at|by|on|in|for|this)$/i, '').trim(); } while (out !== prev);
  return out.replace(/[,.\s]+$/, '');
}

/**
 * Parse a natural time expression in the given timezone.
 * Returns { date, assumptions[], rest } | { error:'past' } | null (no time found).
 */
function parseWhen(input, now, tz) {
  const text = String(input || '');
  const t = text.toLowerCase();
  const matched = [];
  const assumptions = [];
  let m = t.match(/\bin\s+(\d+|an?|one)\s*(minutes?|mins?|hours?|hrs?|days?)\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1;
    if (n <= 0 || n > 365) return null;
    const unit = m[2][0] === 'm' ? 60000 : m[2][0] === 'h' ? 3600000 : 86400000;
    return { date: new Date(now.getTime() + n * unit), assumptions, rest: strip(text, [m[0]]) };
  }

  let dayOffset = null; let weekdayTarget = null; let period = null;
  if ((m = t.match(/\btomorrow\b/))) { dayOffset = 1; matched.push(m[0]); }
  else if ((m = t.match(/\b(today|tonight)\b/))) { dayOffset = 0; matched.push(m[0]); if (m[1] === 'tonight') period = 'night'; }
  else if ((m = t.match(/\b(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) { weekdayTarget = DAYS.indexOf(m[1]); matched.push(m[0]); }
  if (!period && (m = t.match(/\b(?:in the |this )?(morning|afternoon|evening|night)\b/))) { period = m[1]; matched.push(m[0]); }

  let hour = null; let minute = 0; let meridiem = null;
  if ((m = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/))) {
    hour = parseInt(m[1], 10); minute = m[2] ? parseInt(m[2], 10) : 0; meridiem = m[3][0]; matched.push(m[0]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
  } else if ((m = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:minutes?|mins?|hours?|hrs?))/))) {
    hour = parseInt(m[1], 10); minute = m[2] ? parseInt(m[2], 10) : 0; matched.push(m[0]);
    if (hour > 23 || minute > 59) return null;
  } else if ((m = t.match(/\bnoon\b/))) { hour = 12; matched.push(m[0]); meridiem = 'p'; }

  if (hour === null && period === null && dayOffset === null && weekdayTarget === null) return null;

  const local = localParts(now, tz);
  const build = (offset, h, mi) => atLocalDay(now, tz, offset, h, mi);
  let h; let mi = minute;
  let ambiguousChoice = null;
  if (hour !== null) {
    if (meridiem) h = (hour % 12) + (meridiem === 'p' ? 12 : 0);
    else if (hour >= 13 || hour === 0 || hour === 12) h = hour;
    else if (period && period !== 'morning') h = hour + 12;
    else if (period === 'morning') h = hour;
    else if (dayOffset === null && weekdayTarget === null) ambiguousChoice = [hour, hour + 12];
    else h = hour >= 1 && hour <= 6 ? hour + 12 : hour;
  } else if (period) { h = PERIODS[period]; mi = 0; }
  else { h = 9; mi = 0; assumptions.push('No time given, assumed 9:00 AM'); }

  let offset = dayOffset ?? 0;
  if (weekdayTarget !== null) offset = (weekdayTarget - local.weekday + 7) % 7;

  if (ambiguousChoice) {
    const pick = ambiguousChoice.find((c) => build(0, c, mi) > now);
    if (pick !== undefined) h = pick; else { h = ambiguousChoice[0]; offset = 1; assumptions.push('Both readings have passed today, so I used tomorrow'); }
    const hh = h % 12 === 0 ? 12 : h % 12;
    assumptions.push(`No AM/PM given, assumed ${hh}:${String(mi).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`);
  }

  let date = build(offset, h, mi);
  if (date <= now) {
    if (weekdayTarget !== null && offset === 0) { date = build(7, h, mi); }
    else if (dayOffset === null && weekdayTarget === null) { date = build(offset + 1, h, mi); assumptions.push('That time has already passed today, so I used tomorrow'); }
    else return { error: 'past', rest: strip(text, matched) };
  }
  return { date, assumptions, rest: strip(text, matched) };
}

module.exports = { parseWhen, formatLocal, atLocalDay, nextLocalMidnight, localParts, zonedToUtc, localDateKey };
