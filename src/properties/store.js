'use strict';
const FIELDS = ['title', 'location', 'ptype', 'listing', 'price', 'bedrooms', 'bathrooms', 'land_size', 'features', 'facilities', 'documentation', 'contact', 'agent', 'description', 'caption'];

class PropertyStore {
  constructor(db, clock = () => new Date()) { this.db = db; this.clock = clock; }
  _now() { return this.clock().toISOString(); }
  _row(r) { return r ? { ...r } : null; }

  create(fields = {}, status = 'draft') {
    const now = this._now();
    this.db.exec('BEGIN');
    try {
      const cols = FIELDS.filter((f) => fields[f] !== undefined && fields[f] !== null);
      const sql = `INSERT INTO properties (ref,${cols.join(',')}${cols.length ? ',' : ''}status,received_at,updated_at) VALUES (?,${cols.map(() => '?').join(',')}${cols.length ? ',' : ''}?,?,?)`;
      const res = this.db.prepare(sql).run(`TMP-${Math.random().toString(36).slice(2)}`, ...cols.map((c) => fields[c]), status, now, now);
      const id = Number(res.lastInsertRowid);
      this.db.prepare('UPDATE properties SET ref = ? WHERE id = ?').run(`PROP-${String(id).padStart(3, '0')}`, id);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(id) { return this._row(this.db.prepare('SELECT * FROM properties WHERE id = ? AND deleted_at IS NULL').get(id)); }
  getByRef(ref) { return this._row(this.db.prepare('SELECT * FROM properties WHERE ref = ? AND deleted_at IS NULL').get(String(ref).toUpperCase())); }
  /** For reports about properties that were deleted later. */
  getAny(id) { return this._row(this.db.prepare('SELECT * FROM properties WHERE id = ?').get(id)); }
  update(id, fields) {
    const cols = Object.keys(fields).filter((k) => FIELDS.includes(k));
    if (!cols.length) return false;
    return Number(this.db.prepare(`UPDATE properties SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(...cols.map((c) => fields[c]), this._now(), id).changes) > 0;
  }
  setStatus(id, status) {
    return Number(this.db.prepare('UPDATE properties SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(status, this._now(), id).changes) > 0;
  }
  softDelete(id) { return Number(this.db.prepare('UPDATE properties SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(this._now(), this._now(), id).changes) > 0; }

  list({ text, maxPrice, minPrice, location, ptype, bedrooms, status } = {}) {
    let rows = this.db.prepare('SELECT * FROM properties WHERE deleted_at IS NULL ORDER BY id').all().map((r) => ({ ...r }));
    if (status) rows = rows.filter((r) => r.status === status);
    if (maxPrice) rows = rows.filter((r) => r.price !== null && r.price <= maxPrice);
    if (minPrice) rows = rows.filter((r) => r.price !== null && r.price >= minPrice);
    if (location) rows = rows.filter((r) => (r.location || '').toLowerCase().includes(location.toLowerCase()));
    if (ptype) rows = rows.filter((r) => r.ptype === ptype);
    if (bedrooms) rows = rows.filter((r) => r.bedrooms === bedrooms);
    if (text) {
      const words = text.toLowerCase().split(/\s+/).filter(Boolean);
      rows = rows.filter((r) => { const hay = `${r.ref} ${r.title || ''} ${r.location || ''} ${r.ptype || ''} ${r.description || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
    }
    return rows;
  }
  addPublication(propertyId, destination, outcome, detail = null) {
    this.db.prepare('INSERT INTO publications (property_id,destination,detail,outcome,at) VALUES (?,?,?,?,?)').run(propertyId, destination, detail, outcome, this._now());
  }
  publications(propertyId, limit = 5) { return this.db.prepare('SELECT * FROM publications WHERE property_id = ? ORDER BY id DESC LIMIT ?').all(propertyId, limit).map((r) => ({ ...r })); }
}
module.exports = { PropertyStore, FIELDS };
