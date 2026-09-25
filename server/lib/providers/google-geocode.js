'use strict';
// Google Geocoding API (server-side; uses GOOGLE_MAPS_SERVER_KEY, which is never sent to browsers).
// Requests are biased to Faisalabad (`bounds`), `region=pk`, `components=country:PK`, `language=ur|en`.
//
// CACHING / GOOGLE TERMS: the Google Maps Platform Terms restrict caching and storing of Content.
// We therefore NEVER persist Google results in `geocode_cache` (or anywhere else). The only cache is a
// small in-memory, per-process LRU with a 5-minute TTL, which absorbs repeated submissions of the same
// query by the same visitors and vanishes on restart. Reverse lookups are not cached at all.
// (If the importer stores a Google-derived coordinate, it must keep it `geocoded_pending` for admin
// review and replace it with an admin-verified pin — see Google's terms on lat/lng retention.)
const config = require('../../config');
const { normalizeSearch } = require('../text');
const { ProviderError, CircuitBreaker, fetchJson, TtlLru } = require('./common');

const NAME = 'google';
const breaker = new CircuitBreaker('google-geocode');
const memo = new TtlLru({ max: 200, ttlMs: 5 * 60_000 });

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

function requireKey() {
  if (!config.googleServerKey) throw new ProviderError('disabled', 'GOOGLE_MAPS_SERVER_KEY is not configured', { provider: NAME });
}

function classify(r) {
  const types = new Set(r.types || []);
  const lt = r.geometry && r.geometry.location_type;
  if (types.has('street_address') || types.has('premise') || types.has('subpremise')) return { kind: 'address', precision: 'exact' };
  if (types.has('route') || types.has('intersection')) return { kind: 'address', precision: 'street' };
  if (types.has('point_of_interest') || types.has('establishment')) return { kind: 'landmark', precision: lt === 'APPROXIMATE' ? 'area' : 'exact' };
  if (types.has('locality') || [...types].some((t) => t.startsWith('administrative_area_level'))) return { kind: 'town', precision: 'area' };
  if ([...types].some((t) => t.startsWith('sublocality')) || types.has('neighborhood')) return { kind: 'place', precision: 'area' };
  const byType = { ROOFTOP: 'exact', RANGE_INTERPOLATED: 'street', GEOMETRIC_CENTER: 'street', APPROXIMATE: 'area' };
  return { kind: 'place', precision: byType[lt] || 'unknown' };
}

function mapResult(r) {
  const loc = r.geometry && r.geometry.location;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  const parts = String(r.formatted_address || '').split(',').map((s) => s.trim()).filter(Boolean);
  const label = parts[0] || null;
  if (!label) return null;
  const sub = parts.slice(1).filter((p) => !/^(Pakistan|پاکستان)$/.test(p) && !/^\d{4,6}$/.test(p));
  const vp = r.geometry.viewport;
  const bbox = vp && vp.southwest && vp.northeast ? [[vp.southwest.lat, vp.southwest.lng], [vp.northeast.lat, vp.northeast.lng]] : null;
  return {
    id: `google:${r.place_id || label}`, label, sublabel: sub.slice(0, 3).join(' · ') || null,
    lat: loc.lat, lng: loc.lng, ...classify(r), source: NAME, bbox,
    matchedAlias: null, plantCount: null, areaId: null, ref: r.place_id ? `google:place/${r.place_id}` : null,
    partialMatch: !!r.partial_match,
  };
}

async function call(params) {
  requireKey();
  params.set('key', config.googleServerKey);
  const body = await breaker.run(async () => {
    const b = await fetchJson(`${ENDPOINT}?${params}`, { timeoutMs: config.geocoder.timeoutMs, provider: NAME });
    // ZERO_RESULTS is a valid, empty answer; any other non-OK status is an outage/misconfiguration.
    if (!b || (b.status !== 'OK' && b.status !== 'ZERO_RESULTS')) throw new ProviderError('unavailable', `Google geocoder status ${b && b.status}`, { provider: NAME });
    return b;
  });
  return body.status === 'ZERO_RESULTS' ? [] : body.results || [];
}

async function search(q, { lang = 'en', limit = 10 } = {}) {
  const key = `${lang === 'ur' ? 'ur' : 'en'}|${normalizeSearch(q)}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const [[s, w], [n, e]] = config.map.bounds;
  const params = new URLSearchParams({
    address: q, bounds: `${s},${w}|${n},${e}`, region: 'pk', components: 'country:PK', language: lang === 'ur' ? 'ur' : 'en',
  });
  const results = (await call(params)).map(mapResult).filter(Boolean).slice(0, limit);
  memo.set(key, results);
  return results;
}

async function reverse(lat, lng, { lang = 'en' } = {}) {
  const params = new URLSearchParams({ latlng: `${lat},${lng}`, language: lang === 'ur' ? 'ur' : 'en' });
  const results = await call(params);
  if (!results.length) return null;
  const comps = results[0].address_components || [];
  const find = (type) => (comps.find((c) => (c.types || []).includes(type)) || {}).long_name || null;
  const road = find('route');
  const locality = find('neighborhood') || find('sublocality_level_1') || find('sublocality') || null;
  const city = find('locality');
  const parts = [road, locality, road ? null : city].filter(Boolean);
  if (!parts.length) return null;
  return { label: `Near ${[...new Set(parts)].slice(0, 2).join(', ')} (approximate)`, precision: road ? 'street' : 'area', ref: null };
}

module.exports = { name: NAME, search, reverse, mapResult, _test: { breaker, memo, reset() { breaker.reset(); memo.clear(); } } };
