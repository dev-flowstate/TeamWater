'use strict';
// Place search for the public UI and address geocoding for the importer.
//   search(q, { lang })            → contract §6 GET /api/geocode body
//   reverse(lat, lng, { lang })    → { label, source, precision } | { label: null }   (never cached/stored)
//   geocodeAddress(text, { town }) → { lat, lng, precision: 'exact'|'street'|'area', ambiguous, source, ref } | null
//
// Order: the local area gazetteer first (spreadsheet areas + aliases incl. Urdu / Roman Urdu), then the
// configured external provider (config.geocoder.provider: nominatim | google | none). External results
// outside the Faisalabad bounds are dropped. If the provider is down we say so (providers.external =
// 'unavailable') and still return gazetteer results — nothing is invented.
//
// The gazetteer module (owned by the Geo workstream) is feature-detected: search(q,{limit}),
// nearestArea(lat,lng,{maxKm}), isUsable(area). When a function is missing or throws we fall back to
// direct SQL over the `areas` table.
const config = require('../config');
const { getDb, parseJson } = require('./db');
const { normalizeSearch } = require('./text');
const { haversineM, inBounds, isValidLatLng } = require('./geo');
const { isAreaUsable } = require('./plant-view');
const nominatim = require('./providers/nominatim');
const googleGeocode = require('./providers/google-geocode');

const MIN_QUERY = 2;
const MAX_QUERY = 200;
const GAZ_LIMIT = 8;
const EXT_LIMIT = 8;
const MAX_RESULTS = 12;
const REVERSE_MAX_KM = 5;
const SAME_PLACE_M = 2000;

function gazetteer() {
  try { return require('./gazetteer'); } catch { return {}; }
}

function externalProvider() {
  const p = config.geocoder.provider;
  return p === 'nominatim' ? nominatim : p === 'google' ? googleGeocode : null;
}

const visibleDemoSql = () => (config.demoData ? '' : 'AND is_demo = 0');

/** Plant counts per area id and per town (open plants listed in the text list). */
function plantCounts() {
  const db = getDb();
  const base = `FROM plants WHERE status NOT IN ('permanently_closed','decommissioned') ${visibleDemoSql()}`;
  const byArea = new Map(db.prepare(`SELECT area_id, COUNT(*) AS n ${base} AND area_id IS NOT NULL GROUP BY area_id`).all().map((r) => [r.area_id, r.n]));
  const byTown = new Map(db.prepare(`SELECT town, COUNT(*) AS n ${base} AND town IS NOT NULL GROUP BY town`).all().map((r) => [normalizeSearch(r.town), r.n]));
  return { byArea, byTown };
}

function areaToResult(area, { matchedAlias = null, counts } = {}) {
  const usable = isAreaUsable(area);
  const kind = ['area', 'town', 'landmark'].includes(area.kind) ? area.kind : 'area';
  const plantCount = kind === 'town'
    ? (counts && counts.byTown.get(normalizeSearch(area.name))) || 0
    : (counts && counts.byArea.get(area.id)) || 0;
  return {
    id: `area:${area.id}`,
    label: area.name,
    sublabel: [kind === 'town' ? null : area.town, 'Faisalabad'].filter(Boolean).join(' · '),
    lat: usable ? area.latitude : null,
    lng: usable ? area.longitude : null,
    kind,
    precision: usable ? 'area' : 'unknown',
    source: 'gazetteer',
    bbox: null,
    matchedAlias,
    plantCount,
    areaId: area.id,
  };
}

function areaNames(area) {
  const aliases = parseJson(area.aliases_json, []);
  return [area.name, area.name_ur, ...(Array.isArray(aliases) ? aliases : [])].filter((s) => typeof s === 'string' && s.trim());
}

/** 3 exact, 2 prefix / word-prefix, 1 substring (either direction), 0 no textual match. */
function matchQuality(text, nq) {
  const t = normalizeSearch(text);
  if (!t || !nq) return 0;
  if (t === nq) return 3;
  if (t.startsWith(nq) || t.split(' ').some((w) => w.startsWith(nq))) return 2;
  if (t.includes(nq) || (t.length >= 3 && nq.includes(t))) return 1;
  return 0;
}

function resultQuality(r, nq) {
  return Math.max(matchQuality(r.label, nq), r.matchedAlias ? matchQuality(r.matchedAlias, nq) : 0);
}

/** Fallback gazetteer search: direct SQL over `areas` + JS matching with the shared normaliser. */
function sqlGazetteerSearch(q, limit, counts) {
  const nq = normalizeSearch(q);
  if (!nq) return [];
  const hits = [];
  for (const area of getDb().prepare('SELECT * FROM areas').all()) {
    let best = 0, alias = null;
    for (const name of areaNames(area)) {
      const qual = matchQuality(name, nq);
      if (qual > best) { best = qual; alias = name === area.name ? null : name; }
    }
    if (best > 0) hits.push({ area, best, alias });
  }
  hits.sort((a, b) => b.best - a.best || Number(isAreaUsable(b.area)) - Number(isAreaUsable(a.area)) ||
    (a.area.name < b.area.name ? -1 : a.area.name > b.area.name ? 1 : a.area.id - b.area.id));
  return hits.slice(0, limit).map((h) => areaToResult(h.area, { matchedAlias: h.alias, counts }));
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerces whatever the gazetteer module returns into the contract result shape. */
function normalizeGazResult(r, counts) {
  if (!r || typeof r !== 'object') return null;
  const db = getDb();
  if (r.area && typeof r.area === 'object') {
    return areaToResult(r.area, { matchedAlias: r.matchedAlias ?? r.alias ?? null, counts });
  }
  if (r.label === undefined && (r.area_key !== undefined || r.geocode_status !== undefined)) {
    return areaToResult(r, { matchedAlias: r.matchedAlias ?? null, counts });
  }
  if (typeof r.label !== 'string' || !r.label) return null;
  const areaId = numOrNull(r.areaId ?? r.area_id);
  let lat = numOrNull(r.lat), lng = numOrNull(r.lng);
  let plantCount = numOrNull(r.plantCount);
  if (areaId !== null) {
    const area = db.prepare('SELECT * FROM areas WHERE id = ?').get(areaId);
    // Never expose a position the contract does not consider usable (matched|manual with lat/lng).
    if (!area || !isAreaUsable(area)) { lat = null; lng = null; }
    if (plantCount === null && area) plantCount = area.kind === 'town' ? counts.byTown.get(normalizeSearch(area.name)) || 0 : counts.byArea.get(area.id) || 0;
  }
  if (lat === null || lng === null || !isValidLatLng(lat, lng)) { lat = null; lng = null; }
  return {
    id: r.id != null ? String(r.id) : areaId !== null ? `area:${areaId}` : `gazetteer:${normalizeSearch(r.label)}`,
    label: r.label,
    sublabel: r.sublabel ?? null,
    lat, lng,
    kind: ['area', 'town', 'landmark', 'address', 'place'].includes(r.kind) ? r.kind : 'area',
    precision: lat === null ? 'unknown' : ['area', 'street', 'exact'].includes(r.precision) ? r.precision : 'area',
    source: 'gazetteer',
    bbox: r.bbox ?? null,
    matchedAlias: r.matchedAlias ?? null,
    plantCount: plantCount ?? 0,
    areaId,
  };
}

async function gazetteerSearch(q, { limit = GAZ_LIMIT, lang = 'en' } = {}) {
  const counts = plantCounts();
  const g = gazetteer();
  if (typeof g.search === 'function') {
    try {
      const res = await g.search(q, { limit, lang });
      const arr = Array.isArray(res) ? res : res && Array.isArray(res.results) ? res.results : null;
      if (arr) return arr.map((r) => normalizeGazResult(r, counts)).filter(Boolean).slice(0, limit);
    } catch (err) {
      console.error('[geocoder] gazetteer.search failed; using SQL fallback:', err && err.message);
    }
  }
  return sqlGazetteerSearch(q, limit, counts);
}

async function externalSearch(q, { lang = 'en', limit = EXT_LIMIT } = {}) {
  const impl = externalProvider();
  if (!impl) return { status: 'disabled', results: [] };
  try {
    const results = await impl.search(q, { lang, limit });
    return { status: 'ok', results: results.filter((r) => inBounds(r.lat, r.lng)).slice(0, limit), provider: impl.name };
  } catch (err) {
    return { status: err && err.reason === 'disabled' ? 'disabled' : 'unavailable', results: [] };
  }
}

function differentPlaces(a, b) {
  if (a.lat !== null && b.lat !== null && a.lng !== null && b.lng !== null) return haversineM(a.lat, a.lng, b.lat, b.lng) > SAME_PLACE_M;
  const idA = a.areaId ?? a.id, idB = b.areaId ?? b.id;
  return idA !== idB && normalizeSearch(a.sublabel || '') !== normalizeSearch(b.sublabel || '');
}

/** True when several comparably-good top results point at different places. */
function isAmbiguous(results, nq) {
  if (results.length < 2) return false;
  const scored = results.map((r) => ({ r, q: resultQuality(r, nq) }));
  const top = Math.max(...scored.map((s) => s.q));
  const cands = (top > 0 ? scored.filter((s) => s.q === top) : scored.slice(0, 3)).map((s) => s.r);
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) if (differentPlaces(cands[i], cands[j])) return true;
  }
  return false;
}

const PUBLIC_FIELDS = ['id', 'label', 'sublabel', 'lat', 'lng', 'kind', 'precision', 'source', 'bbox', 'matchedAlias', 'plantCount', 'areaId'];
const publicResult = (r) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, r[k] === undefined ? null : r[k]]));

async function search(q, { lang = 'en' } = {}) {
  const query = String(q || '').trim().slice(0, MAX_QUERY);
  const nq = normalizeSearch(query);
  if (query.length < MIN_QUERY || !nq) {
    return { query, results: [], ambiguous: false, providers: { gazetteer: 'ok', external: externalProvider() ? 'ok' : 'disabled' } };
  }
  const [gaz, ext] = await Promise.all([
    gazetteerSearch(query, { limit: GAZ_LIMIT, lang }).then((results) => ({ status: 'ok', results }), () => ({ status: 'unavailable', results: [] })),
    externalSearch(query, { lang, limit: EXT_LIMIT }),
  ]);
  const merged = [...gaz.results];
  for (const r of ext.results) {
    const dup = gaz.results.some((g) => g.lat !== null && normalizeSearch(g.label) === normalizeSearch(r.label) && haversineM(g.lat, g.lng, r.lat, r.lng) <= 3000);
    if (!dup) merged.push(r);
  }
  const results = merged.slice(0, MAX_RESULTS);
  return {
    query,
    results: results.map(publicResult),
    ambiguous: isAmbiguous(results, nq),
    providers: { gazetteer: gaz.status, external: ext.status },
  };
}

/** Nearest usable area within maxKm: gazetteer.nearestArea when available, else SQL + haversine. */
async function nearestArea(lat, lng, { maxKm = REVERSE_MAX_KM } = {}) {
  const g = gazetteer();
  if (typeof g.nearestArea === 'function') {
    try {
      const r = await g.nearestArea(lat, lng, { maxKm });
      if (!r) return null;
      const area = r.area && typeof r.area === 'object' ? r.area : r;
      const name = area.name || area.label;
      if (name) return { name, id: area.id ?? null };
      return null;
    } catch (err) {
      console.error('[geocoder] gazetteer.nearestArea failed; using SQL fallback:', err && err.message);
    }
  }
  let best = null;
  for (const a of getDb().prepare("SELECT * FROM areas WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND geocode_status IN ('matched','manual')").all()) {
    if (!isAreaUsable(a)) continue;
    const d = haversineM(lat, lng, a.latitude, a.longitude);
    if (d <= maxKm * 1000 && (!best || d < best.d || (d === best.d && a.id < best.area.id))) best = { d, area: a };
  }
  return best ? { name: best.area.name, id: best.area.id } : null;
}

async function reverse(lat, lng, { lang = 'en' } = {}) {
  const impl = externalProvider();
  if (impl) {
    try {
      const r = await impl.reverse(lat, lng, { lang });
      if (r && r.label) return { label: r.label, source: impl.name, precision: r.precision === 'street' ? 'street' : 'area' };
    } catch { /* provider down → gazetteer fallback below */ }
  }
  const near = await nearestArea(lat, lng, { maxKm: REVERSE_MAX_KM });
  if (near) return { label: `Near ${near.name} (approximate)`, source: 'gazetteer', precision: 'area' };
  return { label: null };
}

/**
 * Importer helper: geocode a free-text address (optionally within a town). Returns null when nothing
 * usable was found OR the provider is unavailable (the importer then leaves coordinates missing).
 * City-level matches are discarded as too coarse. Results are candidates only — the importer must store
 * them as coord_status='geocoded_pending' for administrator review, never as exact positions.
 */
async function geocodeAddress(text, { town = null } = {}) {
  const t = String(text || '').trim();
  if (t.length < MIN_QUERY) return null;
  const q = [t, town, 'Faisalabad'].filter(Boolean).join(', ');
  const ext = await externalSearch(q, { lang: 'en', limit: 5 });
  const usable = ext.results.filter((r) => r.kind !== 'town');
  if (usable.length) {
    const best = usable[0];
    return {
      lat: best.lat, lng: best.lng,
      precision: best.precision === 'exact' || best.precision === 'street' ? best.precision : 'area',
      ambiguous: isAmbiguous(usable, normalizeSearch(t)),
      source: ext.provider,
      ref: best.ref || best.id || null,
    };
  }
  const gaz = (await gazetteerSearch(t, { limit: 5 })).filter((r) => r.lat !== null);
  if (gaz.length) {
    const best = gaz[0];
    return { lat: best.lat, lng: best.lng, precision: 'area', ambiguous: isAmbiguous(gaz, normalizeSearch(t)), source: 'gazetteer', ref: best.id };
  }
  return null;
}

module.exports = { MIN_QUERY, MAX_QUERY, search, reverse, geocodeAddress, nearestArea, isAmbiguous, matchQuality, sqlGazetteerSearch };
