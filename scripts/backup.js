'use strict';
// Consistent backup of business records: `npm run backup` (add --with-session to also include WhatsApp credentials).
// Uses SQLite VACUUM INTO, so it is safe while the assistant is running. Output is private (0700/0600).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function backup({ dataDir, dest, withSession = false }) {
  const dbPath = path.join(dataDir, 'assistant.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dest, `backup-${stamp}`);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try { db.exec(`VACUUM INTO '${path.join(out, 'assistant.sqlite').replace(/'/g, "''")}'`); } finally { db.close(); }
  const media = path.join(dataDir, 'media');
  if (fs.existsSync(media)) fs.cpSync(media, path.join(out, 'media'), { recursive: true, filter: (src) => !src.endsWith(`${path.sep}tmp`) && !src.endsWith('.part') });
  if (withSession && fs.existsSync(path.join(dataDir, 'auth_state'))) fs.cpSync(path.join(dataDir, 'auth_state'), path.join(out, 'auth_state'), { recursive: true });
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { fs.chmodSync(p, 0o700); walk(p); } else fs.chmodSync(p, 0o600); } };
  fs.chmodSync(out, 0o700); walk(out);
  return out;
}

if (require.main === module) {
  require('dotenv').config();
  // Same default as src/config.js. Backups go inside DATA_DIR so that on Render they land on the persistent disk, not the ephemeral app directory.
  const dataDir = path.resolve(process.env.DATA_DIR || (String(process.env.RENDER || '').toLowerCase() === 'true' ? '/var/data' : './data'));
  const out = backup({ dataDir, dest: path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups')), withSession: process.argv.includes('--with-session') });
  console.log(`Backup written to ${out}\nTo restore: stop the assistant, copy assistant.sqlite and media/ back into ${dataDir}, start it again.`);
}
module.exports = { backup };
