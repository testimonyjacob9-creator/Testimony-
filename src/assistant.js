'use strict';
const { authorizeOwner } = require('./security/owner');
const { interpret } = require('./nlp/intent');
const { formatLocal, localDateKey } = require('./nlp/time');
const { TaskStore } = require('./tasks/store');
const { actions } = require('./tasks/registry');
const { getPause, setPause, clearPause } = require('./tasks/pause');
const { getSetting, setSetting, deleteSetting } = require('./storage/settings');
const { audit } = require('./storage/db');

const PREFIX = '🤖';
const STALE_MS = 10 * 60 * 1000;
const AWAIT_TTL_MS = 10 * 60 * 1000;

const HELP = `${PREFIX} *Commands*
/status - connection and automation state
/tasks - open tasks and drafts awaiting approval
/cancel - discard the current draft (/cancel T-5, /cancel all)
/pause [for 2 hours | until tomorrow] - pause scheduled automation
/resume - resume automation

*You can also just type*, e.g.
"Remind me to call the buyer at 4 PM"
"Show me tomorrow's tasks"
"Don't post anything today"

Every action is drafted first. Nothing runs until you reply *yes*.
Coming later: properties, status posts, groups, leads.`;

/** Provider-independent command layer. Depends only on the WhatsAppProvider interface. */
class Assistant {
  constructor({ db, provider, config, clock = () => new Date(), logger }) {
    this.db = db; this.provider = provider; this.config = config; this.clock = clock; this.logger = logger;
    this.store = new TaskStore(db, clock);
    this.ownerJid = `${config.ownerPhone}@s.whatsapp.net`;
    this.prefix = PREFIX;
    this.seen = new Set(); this.sentIds = new Set(); this.rejectLog = new Map();
    this.queue = Promise.resolve();
    this.startedAt = clock(); this.announced = false; this.restored = 0;
  }
  get ctx() { return { db: this.db, store: this.store, provider: this.provider, config: this.config, clock: this.clock, logger: this.logger, ownerJid: this.ownerJid, prefix: PREFIX }; }

  start() {
    this.restored = this.store.recoverRunning();
    // Never let a handler failure escape into the provider's event loop.
    this.provider.onMessage((m) => this.handleInbound(m).catch((e) => this.logger?.error({ err: e.message }, 'inbound handler failed')));
    this.provider.onConnectionChange((s) => this.onConnectionChange(s));
  }

  onConnectionChange(state) {
    this.logger?.info({ state }, 'connection state');
    if (state === 'connected' && !this.announced) {
      this.announced = true;
      const open = this.store.listOpen().length;
      const p = getPause(this.db, this.clock());
      const text = `${PREFIX} Assistant online. ${open} open task${open === 1 ? '' : 's'} restored${p.paused ? '; automation is PAUSED' : ''}. Send /help.`;
      this._send(this.ownerJid, text).catch(() => {});
    }
  }

  handleInbound(msg) {
    const run = this.queue.then(() => this._handle(msg));
    this.queue = run.catch(() => {});
    return run;
  }

  async _handle(msg) {
    const auth = authorizeOwner(msg, this.config);
    if (!auth.allowed) { this._noteRejected(msg, auth.reason); return { handled: false, reason: auth.reason }; }
    const text = (msg.text || '').trim();
    if (this.sentIds.has(msg.id) || text.startsWith(PREFIX)) return { handled: false, reason: 'own_message' };
    if (msg.id) { if (this.seen.has(msg.id)) return { handled: false, reason: 'duplicate' }; this._remember(this.seen, msg.id); }
    if (msg.timestamp && this.clock().getTime() - msg.timestamp > STALE_MS) {
      audit(this.db, 'owner', 'command', 'ignored_stale'); return { handled: false, reason: 'stale' };
    }
    if (!text) { await this._send(msg.chat, `${PREFIX} I can only read text commands right now. Media intake arrives in Phase 3.`); return { handled: true }; }
    let reply;
    try { reply = await this.process(text); }
    catch (e) {
      this.logger?.error({ err: e.message }, 'command failed');
      try { audit(this.db, 'owner', 'command', 'error', e.message.slice(0, 200)); } catch { /* storage may be the failure */ }
      reply = `Something went wrong and the request was NOT completed (${e.message}). Nothing was changed.`;
    }
    await this._send(msg.chat, reply.startsWith(PREFIX) ? reply : `${PREFIX} ${reply}`);
    return { handled: true };
  }

  _noteRejected(msg, reason) {
    const key = `${msg && msg.from || msg && msg.fromLid || 'unknown'}:${reason}`;
    const last = this.rejectLog.get(key) || 0;
    if (Date.now() - last < 3600000) return;
    this.rejectLog.set(key, Date.now());
    if (this.rejectLog.size > 500) this.rejectLog.clear();
    const who = String(msg && (msg.from || msg.fromLid) || 'unknown');
    try { audit(this.db, `unauthorized:***${who.slice(-4)}`, 'command', 'rejected', reason); } catch { /* ignore */ }
    this.logger?.warn({ reason }, 'ignored message from non-owner');
  }
  _remember(set, id) { set.add(id); if (set.size > 1000) set.delete(set.values().next().value); }

  async _send(jid, text) {
    const res = await this.provider.sendText(jid, text);
    if (res.ok && res.id) this._remember(this.sentIds, res.id);
    if (!res.ok) {
      this.logger?.error({ error: res.error }, 'reply failed');
      try { audit(this.db, 'system', 'reply', 'failed', String(res.error).slice(0, 200)); } catch { /* ignore */ }
    }
    return res;
  }

  _conversation() {
    const c = getSetting(this.db, 'conversation');
    if (!c) return null;
    if (this.clock().getTime() - new Date(c.at).getTime() > AWAIT_TTL_MS) { deleteSetting(this.db, 'conversation'); return null; }
    return c.awaiting;
  }
  _setAwaiting(awaiting) { setSetting(this.db, 'conversation', { awaiting, at: this.clock().toISOString() }); }
  _clearAwaiting() { deleteSetting(this.db, 'conversation'); }
  _fmt(d) { return formatLocal(d, this.config.timezone); }

  async process(text) {
    const now = this.clock();
    const proposal = this.store.activeProposal();
    const awaiting = this._conversation();
    const it = interpret(text, { now, tz: this.config.timezone, awaiting, proposalKind: proposal && proposal.kind });
    switch (it.intent) {
      case 'command': return this.runCommand(it.name, it.args, now);
      case 'confirm': return this.confirm(proposal);
      case 'deny': return this.deny(proposal, awaiting);
      case 'reminder_slots': return this.reminderSlots(it, now);
      case 'modify_time': return this.modifyTime(it, proposal, now);
      case 'pause': return this.pause(it.until, now);
      case 'resume': return this.resume();
      case 'cancel': return this.cancel(it, proposal, now);
      case 'tasks': return this.tasks(it, now);
      case 'status': return this.status(now);
      case 'help': return HELP;
      case 'unsupported': return `I can't do that yet: ${it.feature} arrives in Phase ${it.phase}. Nothing was posted or sent. Right now I handle reminders, /tasks, /pause and /resume.`;
      case 'empty': return HELP;
      default: return `I didn't understand that, so I did nothing. Try "Remind me to ... at 4 PM", /tasks, or /help.`;
    }
  }

  runCommand(name, args, now) {
    switch (name) {
      case 'help': case 'start': return HELP;
      case 'status': return this.status(now);
      case 'tasks': return this.tasks({}, now);
      case 'cancel': return this.cancel({ id: (args.match(/(\d+)/) || [])[1] ? Number(args.match(/(\d+)/)[1]) : null, all: /^all\b/i.test(args) }, this.store.activeProposal(), now);
      case 'pause': return this.pause(require('./nlp/intent').parsePauseUntil(args, now, this.config.timezone), now);
      case 'resume': return this.resume();
      case 'properties': return 'Property management arrives in Phase 3. Nothing is stored yet.';
      case 'schedule': return 'Daily schedules arrive in Phase 7. Reminders you set now are already persistent: see /tasks.';
      case 'settings': return 'Settings arrive in a later phase. Current: timezone ' + this.config.timezone + '.';
      default: return `Unknown command /${name}. Send /help.`;
    }
  }

  // ---- propose -> confirm -> execute ----
  reminderSlots(it, now) {
    if (it.problem === 'past') {
      this._setAwaiting({ title: it.title, whenIso: null });
      return `That time has already passed. When should I remind you? (e.g. "tomorrow 9 AM" or "in 2 hours")`;
    }
    if (!it.title) { this._setAwaiting({ title: null, whenIso: it.when ? it.when.toISOString() : null }); return 'What should I remind you about?'; }
    if (!it.when) { this._setAwaiting({ title: it.title, whenIso: null }); return `When should I remind you about "${it.title}"?`; }
    this._clearAwaiting();
    const prev = this.store.activeProposal();
    let note = '';
    if (prev) { this.store.cancel(prev.id); note = `(Replaced your earlier draft T-${prev.id}.)\n`; }
    const id = this.store.create({
      kind: 'reminder', title: it.title, status: 'proposed', runAt: it.when.toISOString(),
      payload: { text: it.title, assumptions: it.assumptions },
      expiresAt: new Date(now.getTime() + this.config.proposalTtlMs).toISOString(),
    });
    audit(this.db, 'owner', 'reminder.propose', 'ok', `T-${id}`);
    return note + this._draft(this.store.get(id), 'Reminder draft');
  }

  _draft(task, heading) {
    const mins = Math.round(this.config.proposalTtlMs / 60000);
    const notes = (task.payload.assumptions || []).map((a) => `Note: ${a}.`).join('\n');
    return `*${heading} T-${task.id}* (NOT set yet)\nWhat: ${task.title}\nWhen: ${this._fmt(new Date(task.run_at))} (${this.config.timezone})${notes ? '\n' + notes : ''}\nReply *yes* to set it, *no* to discard, or send a new time to change it. Draft expires in ${mins} min.`;
  }

  modifyTime(it, proposal, now) {
    if (it.problem === 'past') return 'That time has already passed. Send a later time and I will update the draft.';
    this.store.updateProposal(proposal.id, {
      runAt: it.when.date.toISOString(), payload: { ...proposal.payload, assumptions: it.when.assumptions },
      expiresAt: new Date(now.getTime() + this.config.proposalTtlMs).toISOString(),
    });
    audit(this.db, 'owner', 'reminder.modify', 'ok', `T-${proposal.id}`);
    return 'Updated.\n' + this._draft(this.store.get(proposal.id), 'Reminder draft');
  }

  async confirm(proposal) {
    if (!proposal) return `Nothing is waiting for your approval (drafts expire after ${Math.round(this.config.proposalTtlMs / 60000)} min).`;
    const action = actions[proposal.kind];
    if (!action) return `Draft T-${proposal.id} has an unknown type, so I did nothing.`;
    try {
      const msg = await action.onConfirm(this.ctx, proposal);
      audit(this.db, 'owner', `${proposal.kind}.confirm`, 'ok', `T-${proposal.id}`);
      return msg;
    } catch (e) { audit(this.db, 'owner', `${proposal.kind}.confirm`, 'failed', `T-${proposal.id}`); return `Could not complete that: ${e.message}`; }
  }

  deny(proposal, awaiting) {
    if (proposal) { this.store.cancel(proposal.id); audit(this.db, 'owner', `${proposal.kind}.discard`, 'ok', `T-${proposal.id}`); return `Discarded draft T-${proposal.id}. Nothing was scheduled or executed.`; }
    if (awaiting) { this._clearAwaiting(); return 'Okay, dropped it.'; }
    return 'Nothing is pending.';
  }

  cancel(it, proposal, now) {
    if (it.all) {
      const open = this.store.listOpen();
      if (!open.length) return 'There are no open tasks to cancel.';
      const id = this.store.create({ kind: 'cancel_all', title: `Cancel all ${open.length} open tasks`, status: 'proposed', expiresAt: new Date(now.getTime() + this.config.proposalTtlMs).toISOString() });
      return `*Confirm bulk cancel T-${id}*: this will cancel ${open.length} open task(s). Reply *yes* to proceed or *no* to keep them.`;
    }
    if (it.id) {
      const ok = this.store.cancel(it.id);
      if (ok) audit(this.db, 'owner', 'task.cancel', 'ok', `T-${it.id}`);
      return ok ? `Cancelled T-${it.id}.` : `T-${it.id} is not open (it may have finished, failed or not exist). Check /tasks.`;
    }
    if (proposal) { this.store.cancel(proposal.id); return `Discarded draft T-${proposal.id}. Nothing was scheduled or executed.`; }
    if (this._conversation()) { this._clearAwaiting(); return 'Okay, dropped it.'; }
    return 'Nothing to cancel. Use /tasks to see tasks, /cancel T-5 for one, or /cancel all.';
  }

  tasks(it, now) {
    let list = this.store.listOpen();
    if (it.approvalsOnly) list = list.filter((t) => t.status === 'proposed');
    if (it.day) {
      const target = localDateKey(it.day === 'today' ? now : new Date(now.getTime() + 86400000), this.config.timezone);
      list = list.filter((t) => t.run_at && localDateKey(new Date(t.run_at), this.config.timezone) === target);
    }
    const p = getPause(this.db, now);
    const head = p.paused ? `Automation PAUSED${p.until ? ' until ' + this._fmt(p.until) : ''}.\n` : '';
    if (!list.length) return `${head}No ${it.approvalsOnly ? 'drafts awaiting approval' : 'open tasks'}${it.day ? ' for ' + it.day : ''}.`;
    const lines = list.map((t) => {
      const when = t.run_at ? this._fmt(new Date(t.run_at)) : 'n/a';
      const state = t.status === 'proposed' ? 'AWAITING YOUR APPROVAL' : 'scheduled';
      return `T-${t.id} ${t.kind}: ${t.title} | ${when} | ${state}`;
    });
    return `${head}*Open tasks (${list.length})*\n${lines.join('\n')}`;
  }

  pause(until, now) {
    setPause(this.db, until);
    audit(this.db, 'owner', 'pause', 'ok', until ? until.toISOString() : 'indefinite');
    return `Scheduled automation PAUSED ${until ? 'until ' + this._fmt(until) : 'until you send /resume'}. Reminders to you still arrive. Nothing already sent can be undone.`;
  }
  resume() {
    const was = getPause(this.db, this.clock()).paused;
    clearPause(this.db);
    audit(this.db, 'owner', 'resume', 'ok');
    return was ? 'Automation resumed.' : 'Automation was not paused.';
  }

  status(now) {
    const c = this.store.counts();
    const p = getPause(this.db, now);
    const up = Math.floor((now - this.startedAt) / 60000);
    return `*Assistant status*
Connection: ${this.provider.connectionState()} (mode: ${this.config.accountMode}, provider: ${this.config.provider})
Automation: ${p.paused ? 'PAUSED' + (p.until ? ' until ' + this._fmt(p.until) : '') : 'running'}
Awaiting your approval: ${c.proposed || 0}
Scheduled tasks: ${c.scheduled || 0}
Failed tasks: ${c.failed || 0}
Time: ${this._fmt(now)} (${this.config.timezone})
Uptime: ${Math.floor(up / 60)}h ${up % 60}m
Not built yet: properties, status posting, groups, leads`;
  }
}

module.exports = { Assistant, PREFIX };
