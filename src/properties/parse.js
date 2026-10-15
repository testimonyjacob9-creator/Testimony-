'use strict';
// Rule-based extraction. Only fields that the text actually states are returned; nothing is guessed.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PHONE = /(?:\+?234[\s-]?|\b0)([789][01]\d)[\s-]?(\d{3})[\s-]?(\d{4})\b/;
const PHONE_G = new RegExp(PHONE.source, 'g');
const TYPES = [
  ['duplex', /\bduplex(es)?\b/i], ['bungalow', /\bbungalows?\b/i], ['penthouse', /\bpenthouses?\b/i], ['villa', /\bvillas?\b/i],
  ['mansion', /\bmansions?\b/i], ['terrace', /\bterraces?\b/i], ['self-contained', /\bself[\s-]?contain(ed)?\b/i],
  ['apartment', /\bapartments?\b/i], ['flat', /\bflats?\b/i], ['house', /\bhouses?\b/i],
  ['shop', /\bshops?\b/i], ['office', /\boffices?\b/i], ['warehouse', /\bwarehouses?\b/i], ['hotel', /\bhotels?\b/i],
  ['room', /\b(single rooms?|room(?:s)? (?:and|&) parlou?r|rooms?)\b/i],
  ['land', /\b(land|plots?)\b/i],
];
const FEATURES = ['borehole', 'fenced', 'tiled', 'pop ceiling', 'ensuite', 'en-suite', 'security', 'parking', 'prepaid meter', 'gated', 'estate', 'swimming pool', 'gym', 'boys quarters', 'bq', 'wardrobes', 'kitchen cabinets', 'paved road', 'water supply', 'generator', 'cctv', 'balcony', 'solar'];
const DOCS = ['c of o', 'certificate of occupancy', 'deed of assignment', 'survey plan', "governor's consent", 'governors consent', 'r of o', 'gazette', 'excision', 'registered survey', 'building plan approval'];
const BAD_LOC = new Set(['call', 'contact', 'price', 'whatsapp', 'please', 'good', 'very', 'nice', 'the', 'a', 'an', 'it', 'this', 'our']);

const num = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : NUM_WORDS[String(w).toLowerCase()] ?? null);
const MULT = { k: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

/** "25 million", "N25m", "₦25,000,000", "30m" -> integer naira, or null. */
function parsePrice(text, { loose = false } = {}) {
  const t = String(text || '').replace(PHONE_G, ' ');
  let m = t.match(/(?:₦|\bNGN\s?|\bN(?=\s?\d)|#(?=\d))\s?(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|mil|m|thousand|k)?(?![a-z])/i);
  if (!m && loose) m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|mil|m|thousand|k)?(?![a-z])/i);
  if (!m) m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand)\b/i);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ''));
  const mult = m[2] ? MULT[m[2].toLowerCase()] : 1;
  const v = Math.round(base * mult);
  return v >= 1000 && v <= 1e11 ? v : null;
}

function extract(text) {
  const raw = String(text || '').trim();
  const out = {};
  let m;
  if ((m = raw.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:bed(?:room)?s?|br|bdrm|bd)\b/i))) out.bedrooms = num(m[1]);
  if ((m = raw.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:bath(?:room)?s?)\b/i))) out.bathrooms = num(m[1]);
  for (const [name, re] of TYPES) if (re.test(raw)) { out.ptype = name; break; }
  if (/\bfor\s+sale\b|\bselling\b|\bon sale\b/i.test(raw)) out.listing = 'sale';
  else if (/\bfor\s+rent\b|\bto\s+let\b|\brental\b|\bper\s+(year|annum|month)\b/i.test(raw)) out.listing = 'rent';
  else if (/\blease\b/i.test(raw)) out.listing = 'lease';
  const price = parsePrice(raw); if (price) out.price = price;
  if ((m = raw.match(/\b(?:in|at|around|along|near|within|off)\s+([A-Z][A-Za-z'’-]+(?:\s+(?:[A-Z][A-Za-z'’-]+|of|and)){0,2}(?:,\s*[A-Z][A-Za-z]+(?:\s+State)?)?)/)) && !BAD_LOC.has(m[1].split(/[\s,]/)[0].toLowerCase())) out.location = m[1].trim();
  if ((m = raw.match(/(\d+(?:\.\d+)?)\s*(plots?|sqm|sq\.?\s?m|square met(?:er|re)s?|hectares?|acres?)\b/i))) out.land_size = `${m[1]} ${m[2].toLowerCase()}`;
  if ((m = raw.match(PHONE))) out.contact = `0${m[1]}${m[2]}${m[3]}`;
  const low = raw.toLowerCase();
  const feats = FEATURES.filter((f) => new RegExp(`\\b${f.replace(/[-\s]/g, '[-\\s]?')}\\b`, 'i').test(low));
  if (feats.length) out.features = feats.join(', ');
  const docs = DOCS.filter((d) => low.includes(d));
  if (docs.length) out.documentation = docs.join(', ');
  return out;
}

/** A message that states a property type plus at least one concrete detail. */
function looksLikeProperty(text) {
  const raw = String(text || '');
  if (raw.length < 25) return false;
  const f = extract(raw);
  return !!f.ptype && !!(f.price || f.bedrooms || f.location || f.listing || f.land_size);
}

function titleFor(f, fallbackText) {
  if (f.ptype) {
    const bed = f.bedrooms ? `${f.bedrooms}-bedroom ` : '';
    const label = { land: 'land', 'self-contained': 'self-contained' }[f.ptype] || f.ptype;
    return `${bed}${label}${f.location ? ` in ${f.location}` : ''}`.replace(/^./, (c) => c.toUpperCase());
  }
  return String(fallbackText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
}

/** General item (not real estate): title = the owner's own caption words; only a clearly stated price/phone is extracted. */
function extractItem(caption) {
  const raw = String(caption || '').trim();
  const out = {};
  const price = parsePrice(raw); if (price) out.price = price;
  const m = raw.match(PHONE); if (m) out.contact = `0${m[1]}${m[2]}${m[3]}`;
  let title = raw.replace(PHONE_G, ' ');
  if (price) title = title.replace(/(?:₦|\bNGN\s?|\bN(?=\s?\d)|#(?=\d))\s?\d[\d,]*(?:\.\d+)?\s*(?:billion|bn|b|million|mil|m|thousand|k)?(?![a-z])|\d[\d,]*(?:\.\d+)?\s*(?:billion|million|thousand)\b/i, ' ');
  if (out.contact) title = title.replace(/\b(?:call|contact|whatsapp|phone|tel|text)(?:\s+(?:me|us|on))?[\s:.\-–|]*$/i, ' ');
  title = title.replace(/\s+/g, ' ').replace(/^[\s,;:.\-–|]+|[\s,;:.\-–|]+$/g, '').slice(0, 80);
  out.title = title || raw.slice(0, 80) || null;
  return out;
}

const REQUIRED = [['location', 'location'], ['price', 'price'], ['listing', 'sale or rent'], ['contact', 'contact number']];
const REQUIRED_ITEM = [['price', 'price'], ['contact', 'contact number']];
const missingFields = (p) => (p.ptype === 'item' ? REQUIRED_ITEM : REQUIRED).filter(([k]) => p[k] === null || p[k] === undefined || p[k] === '').map(([, label]) => label);

module.exports = { extractItem, extract, parsePrice, looksLikeProperty, titleFor, missingFields, PHONE };
