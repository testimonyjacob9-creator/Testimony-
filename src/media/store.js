'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME = {
  'image/jpeg': ['image', 'jpg'], 'image/png': ['image', 'png'], 'image/webp': ['image', 'webp'],
  'video/mp4': ['video', 'mp4'], 'video/3gpp': ['video', '3gp'], 'video/quicktime': ['video', 'mov'],
};

/**
 * Private on-disk media for property listings. Files live under DATA_DIR/media (0700 dir, 0600 files),
 * are never served over HTTP, and are referenced by relative path. Temporary download URLs are never stored.
 * Downloads are streamed to a temp file with a hard size cap and cleaned up on any failure.
 */
class MediaStore {
  constructor({ db, config, clock = () => new Date() }) {
    this.db = db; this.dir = config.mediaDir; this.max = config.maxMediaBytes; this.clock = clock;
    this.tmp = path.join(this.dir, 'tmp');
    fs.mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); fs.chmodSync(this.tmp, 0o700); } catch { /* best effort */ }
    this.cleanTmp();
  }
  cleanTmp() { for (const f of fs.readdirSync(this.tmp)) { try { fs.unlinkSync(path.join(this.tmp, f)); } catch { /* ignore */ } } }

  validate(mime, declaredSize) {
    const m = MIME[String(mime || '').toLowerCase().split(';')[0]];
    if (!m) return { ok: false, error: `unsupported file type (${mime || 'unknown'}). I can store JPEG/PNG/WebP photos and MP4/3GP/MOV videos.` };
    if (declaredSize && declaredSize > this.max) return { ok: false, error: `file is too large (${Math.round(declaredSize / 1048576)} MB; the limit is ${Math.round(this.max / 1048576)} MB)` };
    return { ok: true, kind: m[0], ext: m[1] };
  }

  /** stream: async iterable of Buffers. Returns { ok, media? , duplicate?, error? }. */
  async save({ property, mime, declaredSize, originalName, stream }) {
    const v = this.validate(mime, declaredSize);
    if (!v.ok) return v;
    const tmpPath = path.join(this.tmp, `${crypto.randomBytes(8).toString('hex')}.part`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let fd;
    try {
      fd = fs.openSync(tmpPath, 'w', 0o600);
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > this.max) throw Object.assign(new Error(`file exceeded the ${Math.round(this.max / 1048576)} MB limit while downloading`), { code: 'TOO_BIG' });
        hash.update(chunk); fs.writeSync(fd, chunk);
      }
      fs.closeSync(fd); fd = null;
      if (size === 0) throw new Error('downloaded file was empty');
      const sha = hash.digest('hex');
      const dup = this.db.prepare('SELECT id FROM property_media WHERE property_id = ? AND sha256 = ?').get(property.id, sha);
      if (dup) { fs.unlinkSync(tmpPath); return { ok: true, duplicate: true }; }
      const rel = path.posix.join(property.ref, `${sha.slice(0, 12)}.${v.ext}`);
      const abs = this.absolutePath(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
      fs.renameSync(tmpPath, abs); fs.chmodSync(abs, 0o600);
      const pos = Number(this.db.prepare('SELECT COALESCE(MAX(position),0)+1 AS n FROM property_media WHERE property_id = ?').get(property.id).n);
      const res = this.db.prepare(`INSERT INTO property_media (property_id,kind,rel_path,mime,size,sha256,original_name,position,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(property.id, v.kind, rel, mime.split(';')[0].toLowerCase(), size, sha, originalName || null, pos, this.clock().toISOString());
      return { ok: true, media: { id: Number(res.lastInsertRowid), kind: v.kind, rel_path: rel, size, position: pos } };
    } catch (e) {
      try { if (fd) fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, error: e.message };
    }
  }

  /** Resolve a stored relative path, refusing anything that escapes the media directory. */
  absolutePath(rel) {
    const abs = path.resolve(this.dir, rel);
    if (!abs.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('invalid media path');
    return abs;
  }
  forProperty(id) { return this.db.prepare('SELECT * FROM property_media WHERE property_id = ? ORDER BY position').all(id).map((r) => ({ ...r })); }
  counts(id) { const m = this.forProperty(id); return { images: m.filter((x) => x.kind === 'image').length, videos: m.filter((x) => x.kind === 'video').length }; }
  /** Are all referenced files still on disk with the recorded size? (checked again right before posting) */
  check(id) {
    const missing = [];
    for (const m of this.forProperty(id)) {
      try { const st = fs.statSync(this.absolutePath(m.rel_path)); if (st.size !== m.size) missing.push(m.rel_path); } catch { missing.push(m.rel_path); }
    }
    return { ok: missing.length === 0, missing };
  }
  removeAll(id) {
    for (const m of this.forProperty(id)) { try { fs.unlinkSync(this.absolutePath(m.rel_path)); } catch { /* ignore */ } }
    this.db.prepare('DELETE FROM property_media WHERE property_id = ?').run(id);
  }
}
module.exports = { MediaStore, MIME };
