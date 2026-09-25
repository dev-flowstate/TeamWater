'use strict';
// OpenStreetMap Nominatim geocoder (server-side proxy only; browsers never call Nominatim directly).
// Usage policy (https://operations.osmfoundation.org/policies/nominatim/) is respected:
//   * an identifying User-Agent (config.geocoder.userAgent) and `email` when configured;
//   * a GLOBAL queue limiting this process to at most 1 request per second;
//   * forward results are cached in `geocode_cache` for 30 days, keyed by the normalised query TEXT
//     (never by user coordinates); reverse lookups are NOT cached (they would record user positions);
//   * no autocomplete: the UI must only call /api/geocode on submit.
// Forward search is bounded to the Faisalabad viewbox and `countrycodes=pk`.
// All results are ODbL data: © OpenStreetMap contributors (the UI shows the attribution).
const config = require('../../config');
const { getDb } = require('../db');
const { nowIso } = require('../time');
const { normalizeSearch } = require('../text');
const { ProviderError, CircuitBreaker, fetchJson } = require('./common');

const NAME = 'nominatim';
const CACHE_DAYS = 30;
const breaker = new CircuitBreaker(NAME);

// ── Global 1 request/second queue (process-wide) ──
const queue = { chain: Promise.resolve(), last: 0, pending: 0, minIntervalMs: 1000, maxPending: 5 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function schedule(fn) {
  if (queue.pending >= queue.maxPending) {
    return Promise.reject(new ProviderError('unavailable', 'Nominatim queue is full', { provider: NAME }));
  }
  queue.pending++;
  const run = queue.chain.then(async () => {
    const wait = queue.last + queue.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      queue.last = Date.now();
    }
  });
  queue.chain = run.catch(() => {});
  return run.finally(() => { queue.pending--; });
}

const acceptLanguage = (lang) => (lang === 'ur' ? 'ur,en' : 'en');

function headers(lang) {
  return { 'User-Agent': config.geocoder.userAgent, Accept: 'application/json', 'Accept-Language': acceptLanguage(lang) };
}

function baseParams(lang) {
  const p = new URLSearchParams({ format: 'jsonv2', 'accept-language': acceptLanguage(lang) });
  if (config.geocoder.email) p.set('email', config.geocoder.email);
  return p;
}

const endpoint = (path) => `${String(config.geocoder.url).replace(/\/+$/, '')}${path}`;

// ── Result mapping (Nominatim jsonv2 → contract geocode result) ──
const LANDMARK_CATEGORIES = new Set(['amenity', 'shop', 'tourism', 'leisure', 'office', 'historic', 'railway', 'aeroway',
  'man_made', 'healthcare', 'craft', 'club', 'emergency', 'building', 'education']);
const TOWN_TYPES = new Set(['city', 'town', 'municipality', 'county', 'state_district', 'district']);
const AREA_TYPES = new Set(['suburb', 'neighbourhood', 'quarter', 'village', 'hamlet', 'city_district', 'borough',
  'residential', 'isolated_dwelling', 'locality', 'allotments', 'farm', 'square', 'city_block', 'plot']);

function classify(r) {
  const type = r.addresstype || r.type;
  const category = r.category || r.class;
  if (type === 'house' || type === 'building' || (r.address && r.address.house_number)) return { kind: 'address', precision: 'exact' };
  if (category === 'highway' || type === 'road') return { kind: 'address', precision: 'street' };
  if (TOWN_TYPES.has(type)) return { kind: 'town', precision: 'area' };
  if (AREA_TYPES.has(type) || category === 'place' || category === 'boundary' || category === 'landuse') return { kind: 'place', precision: 'area' };
  if (LANDMARK_CATEGORIES.has(category)) return { kind: 'landmark', precision: 'exact' };
  return { kind: 'place', precision: 'unknown' };
}

function splitDisplayName(r) {
  const parts = String(r.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  const label = (r.name && String(r.name).trim()) || parts[0] || null;
  const rest = parts.filter((p, i) => !(i === 0 && p === label) && p !== 'Pakistan' && p !== 'پاکستان' && !/^\d{4,6}$/.test(p));
  const seen = new Set();
  const uniq = rest.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return { label, sublabel: uniq.slice(0, 3).join(' · ') || null };
}

function mapPlace(r) {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const { label, sublabel } = splitDisplayName(r);
  if (!label) return null;
  const bb = Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null; // [minlat, maxlat, minlon, maxlon]
  const bbox = bb && bb.length === 4 && bb.every(Number.isFinite) ? [[bb[0], bb[2]], [bb[1], bb[3]]] : null;
  return {
    id: r.osm_type && r.osm_id ? `osm:${r.osm_type}/${r.osm_id}` : `nominatim:${r.place_id}`,
    label, sublabel, lat, lng, ...classify(r),
    source: NAME, bbox, matchedAlias: null, plantCount: null, areaId: null,
    ref: r.osm_type && r.osm_id ? `osm:${r.osm_type}/${r.osm_id}` : null,
    importance: Number.isFinite(Number(r.importance)) ? Number(r.importance) : null,
  };
}

// ── Cache (forward only) ──
const cacheKey = (q, lang) => `${NAME}|${lang === 'ur' ? 'ur' : 'en'}|${normalizeSearch(q)}`;

function cacheGet(key) {
  const row = getDb().prepare('SELECT response_json, created_at FROM geocode_cache WHERE query_key = ? AND provider = ?').get(key, NAME);
  if (!row) return null;
  if (Date.parse(row.created_at) < Date.now() - CACHE_DAYS * 86400e3) return null;
  try { return JSON.parse(row.response_json); } catch { return null; }
}

function cachePut(key, results) {
  const db = getDb();
  db.prepare(`INSERT INTO geocode_cache (query_key, provider, response_json, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(query_key) DO UPDATE SET provider = excluded.provider, response_json = excluded.response_json, created_at = excluded.created_at`)
    .run(key, NAME, JSON.stringify(results), nowIso());
  // Opportunistic expiry of stale entries.
  if (Math.random() < 0.05) {
    db.prepare('DELETE FROM geocode_cache WHERE provider = ? AND created_at < ?').run(NAME, new Date(Date.now() - CACHE_DAYS * 86400e3).toISOString());
  }
}

/** Forward search bounded to Faisalabad. Returns mapped results (may be []). Throws ProviderError when unavailable. */
async function search(q, { lang = 'en', limit = 10 } = {}) {
  const key = cacheKey(q, lang);
  const cached = cacheGet(key);
  if (cached) return cached;
  if (breaker.isOpen()) throw new ProviderError('unavailable', 'Nominatim temporarily skipped', { provider: NAME });

  const [[s, w], [n, e]] = config.map.bounds;
  const params = baseParams(lang);
  params.set('q', q);
  params.set('addressdetails', '1');
  params.set('limit', String(Math.min(Math.max(1, limit), 20)));
  params.set('countrycodes', 'pk');
  params.set('viewbox', `${w},${n},${e},${s}`); // x1,y1,x2,y2 = left,top,right,bottom
  params.set('bounded', '1');

  const body = await schedule(() => breaker.run(() =>
    fetchJson(`${endpoint('/search')}?${params}`, { headers: headers(lang), timeoutMs: config.geocoder.timeoutMs, provider: NAME })));
  if (!Array.isArray(body)) throw new ProviderError('unavailable', 'Unexpected Nominatim response', { provider: NAME });
  const results = body.map(mapPlace).filter(Boolean);
  cachePut(key, results);
  return results;
}

/** Reverse lookup. NOT cached, coordinates not stored or logged. Returns { label, precision, ref } or null. */
async function reverse(lat, lng, { lang = 'en' } = {}) {
  if (breaker.isOpen()) throw new ProviderError('unavailable', 'Nominatim temporarily skipped', { provider: NAME });
  const params = baseParams(lang);
  params.set('lat', String(lat));
  params.set('lon', String(lng));
  params.set('zoom', '17');
  params.set('addressdetails', '1');
  const body = await schedule(() => breaker.run(() =>
    fetchJson(`${endpoint('/reverse')}?${params}`, { headers: headers(lang), timeoutMs: config.geocoder.timeoutMs, provider: NAME })));
  if (!body || body.error || !body.address) return null;
  const a = body.address;
  const road = a.road || a.pedestrian || a.footway || null;
  const locality = a.neighbourhood || a.suburb || a.quarter || a.residential || a.village || a.hamlet || null;
  const city = a.city || a.town || a.municipality || null;
  const parts = [road, locality, road ? null : city].filter(Boolean);
  if (!parts.length) return null;
  return {
    label: `Near ${[...new Set(parts)].slice(0, 2).join(', ')} (approximate)`,
    precision: road ? 'street' : 'area',
    ref: body.osm_type && body.osm_id ? `osm:${body.osm_type}/${body.osm_id}` : null,
  };
}

module.exports = {
  name: NAME, search, reverse, mapPlace, cacheKey,
  _test: { queue, breaker, reset() { breaker.reset(); queue.last = 0; queue.pending = 0; queue.chain = Promise.resolve(); } },
};
