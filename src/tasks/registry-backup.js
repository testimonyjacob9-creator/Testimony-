'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { exportSnapshot, restoreInPlace, validateSnapshot, currentVersion } = require('../backup/snapshot');
const { audit } = require('../storage/db');

const backupActions = {
  db_restore: {
    pausable: false,
    describe(ctx, task) {
      const c = task.payload.counts || {};
      return {
        heading: 'Restore from backup', pending: 'restored', confirm: 'REPLACE all current data with this backup',
        lines: [
          `The backup holds ${c.listings ?? '?'} listing(s) and ${c.schedules ?? '?'} schedule(s).`,
          'This replaces ALL current listings, schedules, drafts, settings and chat memory.',
          'A safety copy of the current data is made first (on a free host it lasts only until the next restart).',
          'Photos and videos are not in backups: restored listings have none until you re-send them.',
          'Automation will be PAUSED afterwards. Check /schedule, then send /resume.',
        ],
      };
    },
    async onConfirm(ctx, task) {
      const file = task.payload.file;
      if (!file || !fs.existsSync(file)) throw new Error('The uploaded backup is no longer available (the service may have restarted). Nothing was changed. Send the file again with the caption /restore.');
      const v = validateSnapshot(file, currentVersion(ctx.db));
      if (!v.ok) throw new Error(`Nothing was changed: ${v.error}.`);
      let safety = null;
      try { const dir = path.join(ctx.config.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); safety = exportSnapshot(ctx.db, path.join(dir, `pre-restore-${Date.now()}.sqlite`)); }
      catch (e) { throw new Error(`I could not make a safety copy first, so nothing was changed (${String(e.message).slice(0, 80)}).`); }
      const r = restoreInPlace(ctx.db, file);
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      if (!r.ok) throw new Error(r.error);
      audit(ctx.db, 'owner', 'db.restore', 'ok', `${r.counts.listings} listings`);
      return `Restored ${r.counts.listings} listing(s) and ${r.counts.schedules} schedule(s). A safety copy of what was here before is at ${path.basename(safety)}. Automation is PAUSED: review /schedule and /properties, then send /resume. Re-send any photos you need.`;
    },
    async execute() { throw new Error('db_restore runs only via confirmation'); },
  },
};
module.exports = { backupActions };
