'use strict';
const { parseWhen, atLocalDay, nextLocalMidnight } = require('./time');

const CONFIRM = /^(yes|y|yep|yeah|yup|confirm(ed)?|ok(ay)?|go ahead|do it|proceed|sure|post it|send it|approve(d)?)[.! ]*$/i;
const DENY = /^(no|n|nope|nah|discard|abort|never ?mind|forget it|don'?t|do not)[.! ]*$/i;
const RESUME = /\b(resume|unpause|start (posting|again)|continue posting)\b/i;
const PAUSE = /\b(pause|hold off|halt|suspend)\b|\b(stop|don'?t|do not|no)\b.*\b(post|posts|posting|scheduled|automation|anything|everything)\b/i;
const CANCEL = /^\s*(cancel|discard|delete|remove)\b/i;
const TASKS = /\b(tasks?|to-?dos?|pending|scheduled|reminders?|awaiting|approval)\b/i;
const TASKS_VERB = /\b(show|list|what|which|view|see|any|my|everything|display)\b/i;
const STATUS = /\b(are you (online|connected|working|alive|there)|bot status|your status|connection status|how are you doing)\b/i;
const HELP = /^\s*(help|menu|what can you do\??|commands)\s*[?!.]*$/i;
const UNSUPPORTED = [
  [/\b(propert(y|ies)|listing|caption|house|land|apartment)\b/i, 'Property management', 3],
  [/\b(status|story|post)\b/i, 'Status posting', 4],
  [/\b(group|groups|advert|campaign)\b/i, 'Group campaigns', 5],
  [/\b(buyer|seller|lead|client|follow ?up)\b/i, 'Lead management', 6],
];
const UNIT = { m: 60000, h: 3600000, d: 86400000 };

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
  for (const [re, feature, phase] of UNSUPPORTED) if (re.test(raw)) return { intent: 'unsupported', feature, phase };
  return { intent: 'unknown' };
}

module.exports = { interpret, parsePauseUntil };
