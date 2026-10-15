'use strict';
const naira = (n) => `₦${Number(n).toLocaleString('en-US')}`;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Captions are assembled ONLY from stored fields (nothing invented). A custom caption set by the
 * owner always wins. Styles: short (Status), standard, long (groups).
 */
function buildCaption(p, style = 'standard') {
  if (p.caption) return p.caption;
  if (p.ptype === 'item') {
    const I = [`🛍 ${p.title || 'Item'}`];
    if (p.price) I.push(`💰 ${naira(p.price)}`);
    if (p.contact) I.push(`📞 ${p.contact}`);
    return I.join('\n');
  }
  const L = [];
  const label = p.listing ? { sale: 'FOR SALE', rent: 'FOR RENT', lease: 'FOR LEASE' }[p.listing] : null;
  L.push(`🏡 ${p.title || 'Property'}${label ? ` - ${label}` : ''}`);
  if (p.location) L.push(`📍 ${p.location}`);
  if (p.price) L.push(`💰 ${naira(p.price)}`);
  if (style !== 'short') {
    const rooms = [p.bedrooms ? `${p.bedrooms} bedroom${p.bedrooms > 1 ? 's' : ''}` : null, p.bathrooms ? `${p.bathrooms} bathroom${p.bathrooms > 1 ? 's' : ''}` : null, p.land_size].filter(Boolean);
    if (rooms.length) L.push(`🛏 ${rooms.join(' | ')}`);
    if (p.features) L.push(`✨ ${style === 'long' ? cap(p.features) : cap(p.features.split(', ').slice(0, 3).join(', '))}`);
  }
  if (style === 'long') {
    if (p.facilities) L.push(`🔧 ${cap(p.facilities)}`);
    if (p.documentation) L.push(`📄 ${cap(p.documentation)}`);
    if (p.description) L.push('', p.description.length > 600 ? p.description.slice(0, 600) + '...' : p.description);
  }
  if (p.contact) L.push(`📞 ${p.contact}${p.agent ? ` (${p.agent})` : ''}`);
  L.push(`Ref: ${p.ref}`);
  return L.join('\n');
}
module.exports = { buildCaption, naira };
