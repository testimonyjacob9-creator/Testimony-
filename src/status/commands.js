'use strict';
const { audit } = require('../storage/db');
const { normalizePhone } = require('../config');

module.exports = {
  async audienceReport() {
    const s = this.audience.stats();
    const priv = await this.provider.getStatusPrivacy();
    return `*Status audience*
Mode: ${s.mode === 'all' ? 'all known contacts + manual additions' : 'manual list only'}
Usable recipients: ${s.usable} (${s.synced} learned from WhatsApp sync, ${s.manual} added by you, ${s.excluded} excluded)
Not targetable: ${s.lidOnly} contact(s) WhatsApp identifies only by an anonymous ID.
WhatsApp reports your Status privacy as: ${priv.ok ? priv.mode : 'unknown (' + priv.error + ')'}.
Limits: the list only contains contacts WhatsApp actually sent to this linked device, so it may be incomplete. I cannot read your "except..." / "only share with..." lists, and I cannot confirm who actually sees a post.
${s.usable === 0 ? 'The list is EMPTY, so Status posting is blocked until you add numbers: /audience add 2348012345678\n' : ''}Commands: /audience add <number> | /audience remove <number> | /audience mode all|manual`;
  },
  async audienceCommand(args) {
    const a = args.trim(); const lower = a.toLowerCase();
    if (!a) return this.audienceReport();
    let m;
    if ((m = lower.match(/^add\s+(.+)$/))) {
      const nums = m[1].split(/[\s,]+/).filter(Boolean);
      const ok = nums.map((n) => this.audience.addManual(n)).filter(Boolean);
      audit(this.db, 'owner', 'audience.add', 'ok', `${ok.length} number(s)`);
      return `Added ${ok.length} number(s)${ok.length < nums.length ? `; ${nums.length - ok.length} invalid (use international format, digits only)` : ''}. Usable recipients: ${this.audience.count()}.`;
    }
    if ((m = lower.match(/^remove\s+(.+)$/))) {
      const nums = m[1].split(/[\s,]+/).filter(Boolean);
      const ok = nums.map((n) => this.audience.exclude(n)).filter(Boolean);
      audit(this.db, 'owner', 'audience.exclude', 'ok', `${ok.length} number(s)`);
      return `Excluded ${ok.length} number(s) from Status. Usable recipients: ${this.audience.count()}.`;
    }
    if ((m = lower.match(/^mode\s+(all|manual)$/))) {
      this.audience.setMode(m[1]);
      audit(this.db, 'owner', 'audience.mode', 'ok', m[1]);
      return `Audience mode: ${m[1]}. Usable recipients: ${this.audience.count()}.`;
    }
    return 'Usage: /audience | /audience add <number> | /audience remove <number> | /audience mode all|manual';
  },
};
