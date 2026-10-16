'use strict';
const fs = require('node:fs');
const { exportSnapshot, validateSnapshot, currentVersion, tmpFile, MAX_BYTES } = require('./snapshot');
const { audit } = require('../storage/db');

/** Methods mixed into Assistant.prototype. `this` is the Assistant. Owner-only like every other command. */
module.exports = {
  /** /backup: sends the owner a copy of the SQLite data as a WhatsApp document, to the owner's own chat only. */
  async backupCommand() {
    if (!this.provider.capabilities().sendDocument) return 'This WhatsApp connection cannot send files, so I could not make a backup. Nothing was sent.';
    let file;
    try { file = exportSnapshot(this.db); } catch (e) { return `I could not prepare the backup (${String(e.message).slice(0, 80)}). Nothing was sent.`; }
    try {
      const stamp = this.clock().toISOString().slice(0, 10);
      const res = await this.provider.sendDocument(this.ownerJid, { path: file, fileName: `olives-backup-${stamp}.sqlite`, mimetype: 'application/x-sqlite3', caption: `${this.prefix} Olives backup ${stamp}` });
      if (!res.ok) { audit(this.db, 'owner', 'db.backup', 'failed', res.error || ''); return `I could not send the backup file (${res.error || 'unknown error'}). Nothing was backed up.`; }
      audit(this.db, 'owner', 'db.backup', 'ok', '');
      return 'Backup sent above. Keep that file somewhere safe: it holds your listings, schedules, settings and chat memory. It does NOT include photos/videos or the WhatsApp login. To restore it later, send the file back and write "restore" as the caption.';
    } finally { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  },

  /** A document captioned /restore from the verified owner: download, validate, then ask for confirmation. Nothing changes yet. */
  async backupRestoreUpload(msg, reply) {
    const media = msg.media;
    if (typeof media.open !== 'function') { await reply('The WhatsApp connection could not give me that file. Nothing was changed.'); return { handled: true }; }
    if (media.size && media.size > MAX_BYTES) { await reply('That file is too large to be an Olives backup. Nothing was changed.'); return { handled: true }; }
    const file = tmpFile('.sqlite'); let size = 0;
    try {
      const out = fs.createWriteStream(file, { mode: 0o600 });
      for await (const chunk of await media.open()) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('file too large');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
    } catch (e) { try { fs.unlinkSync(file); } catch { /* ignore */ } await reply(`I could not download that file (${String(e.message).slice(0, 60)}). Nothing was changed.`); return { handled: true }; }
    const v = validateSnapshot(file, currentVersion(this.db));
    if (!v.ok) { try { fs.unlinkSync(file); } catch { /* ignore */ } await reply(`I did not use that file: ${v.error}. Nothing was changed.`); return { handled: true }; }
    const { task, note } = this._newProposal({ kind: 'db_restore', title: 'Restore from backup', payload: { file, version: v.version, counts: v.counts } });
    await reply(note + this._renderDraft(task));
    return { handled: true };
  },
};
