'use strict';
const { actions } = require('../tasks/registry');
const { summarize } = require('./campaigns');
const { audit } = require('../storage/db');
const { setSetting, getSetting, deleteSetting } = require('../storage/settings');
const { extractNumbers } = require('../nlp/intent');
const { buildCaption } = require('../properties/caption');

const PAGE = 10;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Methods mixed into Assistant.prototype. `this` is the Assistant. */
module.exports = {
  _newProposal({ kind, title, payload }) {
    const prev = this.store.activeProposal();
    let note = '';
    if (prev) { this.store.cancel(prev.id); note = `(Replaced your earlier draft T-${prev.id}.)\n`; }
    const id = this.store.create({ kind, title, status: 'proposed', payload, expiresAt: new Date(this.clock().getTime() + this.config.proposalTtlMs).toISOString() });
    audit(this.db, 'owner', `${kind}.propose`, 'ok', `T-${id}`);
    return { id, note, task: this.store.get(id) };
  },
  _renderDraft(task) {
    const d = actions[task.kind].describe(this.ctx, task);
    const mins = Math.round(this.config.proposalTtlMs / 60000);
    return `*${d.heading} T-${task.id}* (NOT ${d.pending} yet)\n${d.lines.join('\n')}\nReply *yes* to ${d.confirm}, or *no* to cancel with nothing changed. Draft expires in ${mins} min.`;
  },

  _renderGroupPage(rows, page, kind, note = '') {
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    const p = Math.min(Math.max(1, page), pages);
    const lines = rows.slice((p - 1) * PAGE, p * PAGE).map((g, i) =>
      `${(p - 1) * PAGE + i + 1}. ${g.name}${g.size ? ` (${g.size} members)` : ''}${g.can_send === 0 ? ' - admins-only posting' : ''}${g.tag ? ' - ' + g.tag : ''}`);
    const head = kind === 'discovery' ? `*Your groups* (${rows.length})` : `*Approved marketing groups* (${rows.length})`;
    const nav = pages > 1 ? `Page ${p}/${pages}. Say "next page" or /groups page ${Math.min(p + 1, pages)}.\n` : '';
    const foot = kind === 'discovery'
      ? `${nav}Authorise with: "select groups 1, 3 and 5". Seeing a group here does NOT authorise marketing to it.`
      : `${nav}Remove with "remove group 2" or by name. Group posting is ${this.groups.postingEnabled() ? 'ON' : 'OFF (enable with /groups enable)'}.`;
    return `${note}${head}\n${lines.join('\n')}\n${foot}`;
  },

  async groupsList(page = 1) {
    const r = await this.provider.listGroups();
    let rows; let note = '';
    if (r.ok) { this.groups.upsertDiscovered(r.groups); rows = this.groups.accessible(); }
    else {
      rows = this.groups.cachedAll();
      if (!rows.length) return `I couldn't fetch your groups right now (${r.error}) and have no saved list, so there is nothing to show. Check /status and try again.`;
      const seen = this.groups.lastSeenAt();
      note = `Could not refresh (${r.error}). This is the list saved ${seen ? this._fmt(seen) : 'earlier'}; membership is NOT confirmed right now.\n`;
    }
    if (!rows.length) { this.groups.saveView({ kind: 'discovery', jids: [], page: 1 }); return 'No groups found on this account. Nothing was changed.'; }
    rows = rows.map((g) => ({ ...g, tag: this.groups.isApproved(g.jid) ? 'approved' : '' }));
    this.groups.saveView({ kind: 'discovery', jids: rows.map((g) => g.jid), page });
    return this._renderGroupPage(rows, page, 'discovery', note);
  },

  async groupsPage(n) {
    const view = this.groups.getView();
    if (!view) return this.groupsList(n || 1);
    if (view.kind === 'selected') return this.groupsSelected(n || (view.page || 1) + 1);
    const rows = view.jids.map((j) => this.groups.find(j)).filter(Boolean).map((g) => ({ ...g, tag: this.groups.isApproved(g.jid) ? 'approved' : '' }));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    const page = Math.min(n || (view.page || 1) + 1, pages);
    this.groups.saveView({ ...view, page });
    return this._renderGroupPage(rows, page, 'discovery', 'Same list as before (numbers unchanged).\n');
  },

  _currentName(a) { const g = this.groups.find(a.jid); return g ? g.name : a.name_at_approval; },

  async groupsSelected(page = 1) {
    const approved = this.groups.approved();
    if (!approved.length) { this.groups.saveView({ kind: 'selected', jids: [], page: 1 }); return `No groups are approved for marketing yet. Send /groups, then e.g. "select groups 1 and 3". Group posting is ${this.groups.postingEnabled() ? 'ON' : 'OFF'}.`; }
    const r = await this.provider.listGroups();
    let live = null;
    if (r.ok) { this.groups.upsertDiscovered(r.groups); live = new Map(r.groups.map((g) => [g.id, g])); }
    const rows = approved.map((a) => {
      const g = live && live.get(a.jid);
      const name = g ? g.name : a.name_at_approval;
      let tag;
      if (!live) tag = `could not check (${r.error})`;
      else if (!g) tag = 'NOT ACCESSIBLE, will be skipped';
      else if (g.canSend === false) tag = 'admins-only posting, will be skipped';
      else tag = g.name !== a.name_at_approval ? `ok (renamed from "${a.name_at_approval}")` : 'ok';
      return { jid: a.jid, name, size: g ? g.size : null, can_send: g && g.canSend === false ? 0 : 1, tag };
    });
    this.groups.saveView({ kind: 'selected', jids: approved.map((a) => a.jid), page });
    return this._renderGroupPage(rows, page, 'selected');
  },

  proposeSelect(numbers) {
    const view = this.groups.getView();
    if (!view || view.kind !== 'discovery') return 'Send /groups first, so I know which list the numbers refer to.';
    if (!numbers.length) return 'Which groups? e.g. "select groups 1, 3 and 5" (numbers from the /groups list).';
    const bad = numbers.filter((n) => n < 1 || n > view.jids.length);
    if (bad.length) return `There is no group number ${bad.join(', ')} in the last list (1-${view.jids.length}). Nothing changed.`;
    const rows = numbers.map((n) => this.groups.find(view.jids[n - 1])).filter(Boolean);
    const fresh = rows.filter((g) => !this.groups.isApproved(g.jid));
    if (!fresh.length) return 'Those groups are already approved. Nothing to change.';
    const { task, note } = this._newProposal({ kind: 'group_select', title: `Approve ${fresh.length} group(s)`, payload: { add: fresh.map((g) => ({ jid: g.jid, name: g.name, size: g.size })) } });
    return note + this._renderDraft(task);
  },

  proposeRemove({ numbers = [], name = '' }) {
    const approved = this.groups.approved();
    if (!approved.length) return 'No groups are approved, so there is nothing to remove.';
    let picked = [];
    if (numbers.length) {
      const bad = numbers.filter((n) => n < 1 || n > approved.length);
      if (bad.length) return `There is no approved group number ${bad.join(', ')} (1-${approved.length}). Numbers refer to /groups selected. Nothing changed.`;
      picked = numbers.map((n) => approved[n - 1]);
    } else if (name) {
      const words = norm(name).split(' ').filter(Boolean);
      const matches = approved.filter((a) => { const hay = `${norm(this._currentName(a))} ${norm(a.name_at_approval)}`; return words.every((w) => hay.includes(w)); });
      if (!matches.length) return `No approved group matches "${name}". /groups selected shows the list.`;
      if (matches.length > 1) return `More than one approved group matches "${name}":\n${matches.map((m) => `${approved.indexOf(m) + 1}. ${this._currentName(m)}`).join('\n')}\nSay "remove group N".`;
      picked = matches;
    } else return 'Which group? e.g. "remove group 2" or "remove the Ekpoma Properties group" (numbers refer to /groups selected).';
    const { task, note } = this._newProposal({ kind: 'group_select', title: `Remove ${picked.length} group(s)`, payload: { remove: picked.map((a) => ({ jid: a.jid, name: this._currentName(a) })) } });
    return note + this._renderDraft(task);
  },

  proposeClear() {
    if (!this.groups.approved().length) return 'No groups are approved. Nothing to clear.';
    const { task, note } = this._newProposal({ kind: 'group_clear', title: 'Clear approved groups', payload: {} });
    return note + this._renderDraft(task);
  },

  proposeEnable() {
    if (this.groups.postingEnabled()) return 'Group posting is already ON.';
    const { task, note } = this._newProposal({ kind: 'group_enable', title: 'Enable group posting', payload: {} });
    return note + this._renderDraft(task);
  },
  disableGroupPosting() {
    this.groups.setPostingEnabled(false);
    audit(this.db, 'owner', 'group_posting.disable', 'ok');
    return 'Group posting is OFF. Any advert still sending will stop at its next step. Nothing already sent can be recalled.';
  },

  _approvedTargets(numbers) {
    const approved = this.groups.approved();
    const bad = numbers.filter((n) => n < 1 || n > approved.length);
    const targets = numbers.map((n) => approved[n - 1]).filter(Boolean).map((a) => ({ jid: a.jid, name: this._currentName(a), num: approved.indexOf(a) + 1 }));
    return { approved, bad, targets };
  },

  async proposeAdvert({ text, numbers = [], raw = '' }) {
    if (!this.provider.capabilities().groups) return 'The current WhatsApp provider cannot send to groups, so I did nothing.';
    if (!this.groups.postingEnabled()) return 'Group posting is OFF, so nothing was prepared for sending. Turn it on with /groups enable (needs your confirmation).';
    let body = (text || '').trim();
    let prop = null;
    if (!body) {
      if (/\bprop-?\s?\d+\b|\bproperty\s+\d+\b/i.test(raw)) {
        const r = this._resolveProperty(raw, { allowActive: false });
        if (!r.property) return this._refError(r);
        prop = r.property;
      } else {
        const cand = getSetting(this.db, 'candidate_content');
        if (cand && this.clock() - new Date(cand.at) < 30 * 60000) body = cand.text;
        else prop = this._activeProperty();
      }
    }
    if (prop) {
      if (prop.status === 'draft') return `${prop.ref} is still a draft. Say "done" to make it available first. Nothing was prepared.`;
      if (prop.status !== 'available') return `${prop.ref} is ${prop.status}, so I will not advertise it. Nothing was prepared.`;
      body = buildCaption(prop, 'long');
    }
    if (!body) return 'What should the advert say? Send it as: /advert <your text>, or name a saved property: "send PROP-001 to my approved groups".';
    const approved = this.groups.approved();
    if (!approved.length) return 'No groups are approved for marketing yet. Send /groups, then "select groups 1 and 3".';
    let targets;
    if (numbers.length) {
      const r = this._approvedTargets(numbers);
      if (r.bad.length) return `There is no approved group number ${r.bad.join(', ')} (1-${approved.length}). Numbers refer to /groups selected. Nothing was prepared.`;
      targets = r.targets;
    } else targets = approved.map((a, i) => ({ jid: a.jid, name: this._currentName(a), num: i + 1 }));
    if (targets.length > this.config.maxGroupsPerCampaign) return `That is ${targets.length} groups; my limit is ${this.config.maxGroupsPerCampaign} per advert to avoid spamming. Pick fewer, e.g. "only groups 1-${this.config.maxGroupsPerCampaign}".`;
    const { task, note } = this._newProposal({ kind: 'campaign', title: prop ? prop.ref : body.slice(0, 40), payload: { text: body, targets, propertyId: prop ? prop.id : null } });
    deleteSetting(this.db, 'candidate_content');
    return note + this._renderDraft(task);
  },

  retargetCampaign(it, proposal) {
    const { approved, bad } = this._approvedTargets(it.numbers);
    if (!it.numbers.length) return 'Which groups? e.g. "only groups 2 and 4". Numbers refer to /groups selected.';
    if (bad.length) return `There is no approved group number ${bad.join(', ')} (1-${approved.length}). Draft unchanged.`;
    const pick = it.numbers.map((n) => approved[n - 1]);
    const cur = proposal.payload.targets.map((t) => t.jid);
    let jids;
    if (it.mode === 'only') jids = pick.map((a) => a.jid);
    else if (it.mode === 'add') jids = [...new Set([...cur, ...pick.map((a) => a.jid)])];
    else jids = cur.filter((j) => !pick.some((a) => a.jid === j));
    if (!jids.length) return 'That would leave no destinations. Say "cancel" to discard the draft instead. Draft unchanged.';
    if (jids.length > this.config.maxGroupsPerCampaign) return `Limit is ${this.config.maxGroupsPerCampaign} groups per advert. Draft unchanged.`;
    const targets = jids.map((j) => { const a = approved.find((x) => x.jid === j); return { jid: j, name: this._currentName(a), num: approved.indexOf(a) + 1 }; });
    this.store.updateProposal(proposal.id, { payload: { ...proposal.payload, targets }, expiresAt: new Date(this.clock().getTime() + this.config.proposalTtlMs).toISOString() });
    audit(this.db, 'owner', 'campaign.retarget', 'ok', `T-${proposal.id}`);
    return 'Updated.\n' + this._renderDraft(this.store.get(proposal.id));
  },

  stopCampaign(proposal) {
    if (proposal && proposal.kind === 'campaign') { this.store.cancel(proposal.id); return 'Discarded the advert draft. Nothing was sent.'; }
    const act = this.campaigns.active();
    if (!act.length) return 'No advert is being sent right now.';
    const out = act.map((c) => { const n = this.campaigns.cancel(c.id); audit(this.db, 'owner', 'campaign.stop', 'ok', `C-${c.id}`); return `Stopped advert C-${c.id}: ${n} pending send(s) cancelled. Anything already sent cannot be recalled.\n${summarize(this.campaigns, this.campaigns.get(c.id))}`; });
    return out.join('\n');
  },

  advertStatus() {
    const c = this.campaigns.latest();
    if (!c) return 'No adverts have been started yet.';
    const pending = this.campaigns.pendingSends(c.id).length;
    return `${summarize(this.campaigns, c)}${c.status === 'sending' ? `\nStill sending: ${pending} pending.` : ''}`;
  },

  async groupsCommand(args) {
    const a = args.trim();
    const lower = a.toLowerCase();
    if (!a) return this.groupsList(1);
    let m;
    if ((m = lower.match(/^page\s+(\d+)$/))) return this.groupsPage(Number(m[1]));
    if (lower === 'selected' || lower === 'approved') return this.groupsSelected(1);
    if (lower === 'clear') return this.proposeClear();
    if (lower === 'enable') return this.proposeEnable();
    if (lower === 'disable') return this.disableGroupPosting();
    if (lower.startsWith('select')) return this.proposeSelect(extractNumbers(a.slice(6)));
    if (lower.startsWith('remove')) { const rest = a.slice(6).trim(); const nums = extractNumbers(rest); return this.proposeRemove({ numbers: nums, name: nums.length ? '' : rest }); }
    return 'Usage: /groups | /groups page N | /groups select 1 3 5 | /groups selected | /groups remove 2 | /groups clear | /groups enable | /groups disable';
  },

  async advertCommand(args) {
    const a = args.trim();
    if (!a || a.toLowerCase() === 'status') return a ? this.advertStatus() : this.advertStatus();
    if (a.toLowerCase() === 'stop') return this.stopCampaign(this.store.activeProposal());
    const pm = a.match(/^(?:([\d\s,\-and]+):\s*)?(prop-?\s?\d+)$/i);
    if (pm) return this.proposeAdvert({ text: '', numbers: pm[1] ? extractNumbers(pm[1]) : [], raw: pm[2] });
    const m = a.match(/^([\d\s,\-and]+):\s*([\s\S]+)$/i);
    if (m) return this.proposeAdvert({ text: m[2], numbers: extractNumbers(m[1]) });
    return this.proposeAdvert({ text: a, numbers: [] });
  },
};
