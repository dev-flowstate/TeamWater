'use strict';
// Area gazetteer (Geo workstream). Approximate positions + multilingual search aliases for the areas,
// towns/tehsils and landmarks named in the source spreadsheet. See docs/MAP_SOURCES.md for provenance.
//
//   loadGazetteer()                 → parsed + validated data/gazetteer/faisalabad.json (cached by mtime)
//   syncAreasToDb()                 → { inserted, updated, unchanged, skippedManual, total }
//                                     Upserts every entry into `areas` by area_key. Rows an administrator
//                                     edited (geocode_status='manual' or reviewed_at set) are never touched.
//   search(q, { limit = 8 })        → [{ id, kind, name, town, nameUr, lat, lng, radiusM, geocodeStatus,
//                                        usable, matchedAlias, score, plantCount,
//                                        label, sublabel, areaId, precision }]   (sorted by score, then name)
//                                     Matches name, name_ur and aliases after normalisation: exact, prefix,
//                                     token, substring and light fuzzy (Damerau-Levenshtein ≤1 for tokens of
//                                     4+ chars, ≤2 for 7+). Chak numbers work in any spelling: "224",
//                                     "chak 224", "224rb", "chak no. 224 R.B.", "چک ۲۲۴".
//                                     lat/lng/radiusM are null unless the row is usable (see isUsable), so an
//                                     'ambiguous' candidate position is never exposed to the public.
//   ensureArea(name, town)          → id of the `areas` row (creates kind 'area', status 'not_attempted')
//   nearestArea(lat, lng, { maxKm = 5, kinds }) → nearest usable row within maxKm, or null
//   isUsable(area)                  → true for geocode_status matched|manual with finite lat/lng
//                                     (accepts a DB row or a camelCase result object)
//   invalidate()                    → drop the in-memory caches (call after editing `areas` directly)
//
// Search runs on every debounced keystroke: the area list is cached in memory (≈50–100 rows) and is only
// rebuilt when invalidate() is called, after a sync/ensureArea, or when a cheap signature query over
// `areas` (row count, max id, max updated_at) shows another writer changed the table.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { getDb, tx, parseJson } = require('./db');
const { normalizeSearch, slug, areaKey } = require('./text');
const { nowIso } = require('./time');

const GAZETTEER_FILE = path.join(config.root, 'data', 'gazetteer', 'faisalabad.json');
const KINDS = ['area', 'town', 'landmark'];
const KIND_ORDER = { area: 0, town: 1, landmark: 2 };
const FILE_STATUSES = new Set(['matched', 'ambiguous', 'not_found', 'not_geocodable']);
const USABLE_STATUSES = new Set(['matched', 'manual']);
const NUMBER_WORDS = new Set(['no', 'number', 'num', 'nmbr', 'nbr', 'نمبر']);
const MAX_LIMIT = 50;

let fileCache = null; // { file, mtimeMs, data }
let index = null; // { db, sig, items }

// ───────────────────────── Gazetteer file ─────────────────────────

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inConfiguredBounds(lat, lng) {
  const [[s, w], [n, e]] = config.map.bounds;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

/** area_key for a gazetteer entry: areas → areaKey(name, town); towns → 'town:<slug>'; landmarks → 'landmark:<slug>'. */
function entryKey(entry) {
  if (entry.kind === 'landmark') return `landmark:${slug(entry.name)}`;
  if (entry.kind === 'town') return areaKey(entry.name, null);
  return areaKey(entry.name, entry.town);
}

function validateEntries(data, file) {
  const problems = [];
  if (!data || !Array.isArray(data.entries)) throw new Error(`Gazetteer ${file}: "entries" array missing`);
  const keys = new Set();
  data.entries.forEach((e, i) => {
    const at = `entries[${i}] (${e && e.name})`;
    if (!e || typeof e !== 'object') return problems.push(`${at}: not an object`);
    if (!KINDS.includes(e.kind)) problems.push(`${at}: bad kind ${e.kind}`);
    if (typeof e.name !== 'string' || !e.name.trim() || !slug(e.name)) problems.push(`${at}: name must contain Latin letters or digits`);
    if (e.kind === 'area' && (typeof e.town !== 'string' || !e.town.trim())) problems.push(`${at}: area needs a town`);
    if (!FILE_STATUSES.has(e.geocodeStatus)) problems.push(`${at}: bad geocodeStatus ${e.geocodeStatus}`);
    const hasLat = e.lat !== null && e.lat !== undefined;
    const hasLng = e.lng !== null && e.lng !== undefined;
    if (hasLat !== hasLng) problems.push(`${at}: lat and lng must both be set or both be null`);
    if (hasLat && (!isFiniteNum(e.lat) || !isFiniteNum(e.lng) || !inConfiguredBounds(e.lat, e.lng))) problems.push(`${at}: position outside the configured bounds`);
    if (e.geocodeStatus === 'matched' && !hasLat) problems.push(`${at}: matched entries need lat/lng`);
    if ((e.geocodeStatus === 'not_found' || e.geocodeStatus === 'not_geocodable') && hasLat) problems.push(`${at}: ${e.geocodeStatus} entries must not carry a position`);
    if (e.radiusM !== null && e.radiusM !== undefined && !(isFiniteNum(e.radiusM) && e.radiusM > 0)) problems.push(`${at}: radiusM must be a positive number or null`);
    if (e.aliases !== undefined && (!Array.isArray(e.aliases) || e.aliases.some((a) => typeof a !== 'string'))) problems.push(`${at}: aliases must be strings`);
    const key = entryKey(e);
    if (keys.has(key)) problems.push(`${at}: duplicate key ${key}`);
    keys.add(key);
  });
  if (problems.length) throw new Error(`Gazetteer ${file} is invalid:\n  ${problems.join('\n  ')}`);
}

/** Reads, validates and caches the gazetteer JSON (re-read when the file changes). */
function loadGazetteer({ file = GAZETTEER_FILE, reload = false } = {}) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (!reload && fileCache && fileCache.file === file && fileCache.mtimeMs === mtimeMs) return fileCache.data;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateEntries(data, file);
  fileCache = { file, mtimeMs, data };
  return data;
}

// ───────────────────────── Sync into `areas` ─────────────────────────

const SYNC_COLUMNS = ['kind', 'name', 'town', 'name_ur', 'aliases_json', 'latitude', 'longitude', 'radius_m',
  'geocode_status', 'geocode_source', 'geocode_ref', 'geocode_note'];

function entryToColumns(e) {
  const nz = (v) => (v === undefined || v === '' ? null : v);
  return {
    kind: e.kind,
    name: e.name.trim(),
    town: e.kind === 'area' ? e.town.trim() : nz(e.town ? e.town.trim() : null),
    name_ur: nz(e.nameUr),
    aliases_json: JSON.stringify(Array.isArray(e.aliases) ? e.aliases : []),
    latitude: nz(e.lat),
    longitude: nz(e.lng),
    radius_m: nz(e.radiusM),
    geocode_status: e.geocodeStatus,
    geocode_source: nz(e.geocodeSource),
    geocode_ref: nz(e.geocodeRef),
    geocode_note: nz(e.geocodeNote),
  };
}

/**
 * Upserts every gazetteer entry into `areas` by area_key. Never overwrites administrator edits
 * (geocode_status='manual' or reviewed_at set). Rows not in the gazetteer (e.g. created by the
 * importer through ensureArea) are left alone.
 */
function syncAreasToDb({ file = GAZETTEER_FILE } = {}) {
  const data = loadGazetteer({ file });
  const db = getDb();
  const now = nowIso();
  const stats = { inserted: 0, updated: 0, unchanged: 0, skippedManual: 0, total: data.entries.length };
  tx(() => {
    const select = db.prepare('SELECT * FROM areas WHERE area_key = ?');
    const insert = db.prepare(`INSERT INTO areas (area_key, ${SYNC_COLUMNS.join(', ')}, updated_at) VALUES (?, ${SYNC_COLUMNS.map(() => '?').join(', ')}, ?)`);
    const update = db.prepare(`UPDATE areas SET ${SYNC_COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
      WHERE id = ? AND geocode_status <> 'manual' AND reviewed_at IS NULL`);
    for (const entry of data.entries) {
      const key = entryKey(entry);
      const cols = entryToColumns(entry);
      const values = SYNC_COLUMNS.map((c) => cols[c]);
      const row = select.get(key);
      if (!row) {
        insert.run(key, ...values, now);
        stats.inserted++;
      } else if (row.geocode_status === 'manual' || row.reviewed_at) {
        stats.skippedManual++;
      } else if (SYNC_COLUMNS.every((c) => row[c] === cols[c])) {
        stats.unchanged++;
      } else {
        update.run(...values, now, row.id);
        stats.updated++;
      }
    }
  });
  invalidate();
  return stats;
}

// ───────────────────────── Text matching ─────────────────────────

const toAsciiDigits = (s) => s
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/**
 * Search form of a string: normalizeSearch + no combining marks (ā → a, آ → ا), ASCII digits,
 * letters and digits split ("224rb" → "224 rb"), "no"/"number"/"نمبر" before a number dropped,
 * and runs of single letters joined ("r b" → "rb", "g m abad" → "gm abad").
 */
function canon(text) {
  let s = toAsciiDigits(String(text || '').normalize('NFKD').replace(/\p{M}/gu, ''));
  s = normalizeSearch(s).replace(/(\p{N})(\p{L})/gu, '$1 $2').replace(/(\p{L})(\p{N})/gu, '$1 $2');
  let tokens = s.split(' ').filter(Boolean).map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
  tokens = tokens.filter((t, i) => !(NUMBER_WORDS.has(t) && /^\d+$/.test(tokens[i + 1] || '')));
  const merged = [];
  let prevSingle = false;
  for (const t of tokens) {
    const single = t.length === 1 && /\p{L}/u.test(t);
    if (single && prevSingle) merged[merged.length - 1] += t;
    else merged.push(t);
    prevSingle = single;
  }
  return { str: merged.join(' '), tokens: merged, compact: merged.join('') };
}

const isNumberToken = (t) => /^\d+$/.test(t);
const fuzzLimit = (len) => (len >= 7 ? 2 : len >= 4 ? 1 : 0);

/** Optimal-string-alignment Damerau-Levenshtein distance; returns max+1 as soon as it must exceed max. */
function dlDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const A = Array.from(a), B = Array.from(b);
  let prev2 = null;
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[B.length];
}

/**
 * Every query token must match a candidate token: exactly, as a prefix (last query token only, i.e. the
 * word being typed), or within the fuzzy limit (text tokens only — numbers must match exactly).
 * Returns { edits, coverage } or null.
 */
function tokenMatch(q, c) {
  let edits = 0, chars = 0;
  for (let i = 0; i < q.tokens.length; i++) {
    const qt = q.tokens[i];
    const last = i === q.tokens.length - 1;
    const qNum = isNumberToken(qt);
    let best = null;
    for (const ct of c.tokens) {
      if (ct === qt || (last && ct.startsWith(qt) && (!qNum || isNumberToken(ct)))) { best = 0; break; }
      if (qNum || isNumberToken(ct)) continue;
      const lim = fuzzLimit(Array.from(qt).length);
      if (!lim) continue;
      let d = dlDistance(qt, ct, lim);
      if (last && ct.length > qt.length) d = Math.min(d, dlDistance(qt, ct.slice(0, qt.length), lim));
      if (d <= lim && (best === null || d < best)) best = d;
    }
    if (best === null) return null;
    edits += best;
    chars += qt.length;
  }
  return { edits, coverage: Math.min(1, chars / Math.max(1, c.compact.length)) };
}

/** 0 = no match; otherwise higher is better (exact 100 … fuzzy ≈30). */
function scoreCandidate(q, c) {
  if (c.str === q.str) return 100;
  if (c.compact === q.compact) return 96;
  if (c.str.startsWith(q.str)) return 80 + (10 * q.str.length) / c.str.length;
  if (q.compact.length >= 2 && c.compact.startsWith(q.compact)) return 76 + (4 * q.compact.length) / c.compact.length;
  const tm = tokenMatch(q, c);
  if (tm && tm.edits === 0) return 65 + 10 * tm.coverage;
  if (q.str.length >= 3 && c.str.includes(q.str)) return 55 + (5 * q.str.length) / c.str.length;
  if (q.compact.length >= 4 && c.compact.includes(q.compact)) return 52;
  if (tm) return 45 - 5 * tm.edits + 5 * tm.coverage;
  // Whole-word fuzzy only for one-word queries ("nishatabd" → "nishat abad"); in multi-word queries a
  // one-letter difference is often meaningful ("saline zone a" must not match "saline zone b").
  const lim = q.tokens.length === 1 ? fuzzLimit(Array.from(q.compact).length) : 0;
  if (lim && !/\d/.test(q.compact)) {
    const d = dlDistance(q.compact, c.compact, lim);
    if (d <= lim) return 42 - 5 * d;
  }
  return 0;
}

// ───────────────────────── In-memory area index ─────────────────────────

function buildItem(row) {
  const texts = [{ text: row.name, via: 'name' }];
  if (row.name_ur) texts.push({ text: row.name_ur, via: 'name_ur' });
  const aliases = parseJson(row.aliases_json, []);
  for (const a of Array.isArray(aliases) ? aliases : []) if (typeof a === 'string' && a.trim()) texts.push({ text: a, via: 'alias' });
  const cands = [];
  const seen = new Set();
  for (const t of texts) {
    const c = canon(t.text);
    if (!c.str || seen.has(c.str)) continue;
    seen.add(c.str);
    cands.push({ ...t, ...c });
  }
  return { row, usable: isUsable(row), cands };
}

function tableSignature(db) {
  const s = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS maxId, COALESCE(MAX(updated_at), '') AS maxUpd FROM areas").get();
  return `${s.n}|${s.maxId}|${s.maxUpd}`;
}

function getIndex() {
  const db = getDb();
  const sig = tableSignature(db);
  if (index && index.db === db && index.sig === sig) return index;
  const rows = db.prepare(`SELECT id, area_key, kind, name, town, name_ur, aliases_json, latitude, longitude, radius_m,
      geocode_status, reviewed_at FROM areas ORDER BY id`).all();
  index = { db, sig, items: rows.map(buildItem) };
  return index;
}

function invalidate() {
  index = null;
  fileCache = null;
}

// ───────────────────────── Public API ─────────────────────────

function isUsable(area) {
  if (!area || typeof area !== 'object') return false;
  const status = area.geocode_status !== undefined ? area.geocode_status : area.geocodeStatus;
  const lat = area.latitude !== undefined && area.latitude !== null ? area.latitude : area.lat;
  const lng = area.longitude !== undefined && area.longitude !== null ? area.longitude : area.lng;
  return USABLE_STATUSES.has(status) && isFiniteNum(lat) && isFiniteNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function compareText(a, b) {
  const x = String(a || '').toLowerCase(), y = String(b || '').toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

function plantCounts(db, items) {
  const demo = config.demoData ? '' : ' AND is_demo = 0';
  const counts = new Map();
  const areaIds = items.filter((it) => it.row.kind !== 'town').map((it) => it.row.id);
  if (areaIds.length) {
    const rows = db.prepare(`SELECT area_id, COUNT(*) AS n FROM plants WHERE area_id IN (${areaIds.map(() => '?').join(',')})${demo} GROUP BY area_id`).all(...areaIds);
    for (const r of rows) counts.set(r.area_id, r.n);
  }
  const byTown = db.prepare(`SELECT COUNT(*) AS n FROM plants WHERE town = ? COLLATE NOCASE${demo}`);
  for (const it of items) if (it.row.kind === 'town') counts.set(it.row.id, byTown.get(it.row.name).n);
  return counts;
}

function sublabelFor(row) {
  if (row.kind === 'area') return [row.town, 'Faisalabad'].filter(Boolean).join(' · ');
  if (row.kind === 'town') return normalizeSearch(row.name) === 'faisalabad' ? 'Punjab, Pakistan' : 'Faisalabad District';
  return 'Faisalabad';
}

function toResult(it, cand, score, plantCount) {
  const r = it.row;
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    town: r.town,
    nameUr: r.name_ur,
    lat: it.usable ? r.latitude : null,
    lng: it.usable ? r.longitude : null,
    radiusM: it.usable ? r.radius_m : null,
    geocodeStatus: r.geocode_status,
    usable: it.usable,
    matchedAlias: cand.via === 'name' ? null : cand.text,
    score: Math.round(score * 100) / 100,
    plantCount,
    // Convenience fields for the Core API geocoder (contract §6 result shape).
    label: r.name,
    sublabel: sublabelFor(r),
    areaId: r.id,
    precision: it.usable ? 'area' : 'unknown',
  };
}

/**
 * Searches all `areas` rows (areas, towns, landmarks). Landmarks without a usable position are skipped
 * unless includeUnlocatedLandmarks is set (areas/towns without a position are still returned so the UI
 * can offer "Show plants listed in this area").
 */
function search(q, { limit = 8, kinds = null, includeUnlocatedLandmarks = false } = {}) {
  const query = canon(String(q || '').slice(0, 200));
  if (!query.str) return [];
  const max = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 8));
  const idx = getIndex();
  const hits = [];
  for (const it of idx.items) {
    if (kinds && !kinds.includes(it.row.kind)) continue;
    if (it.row.kind === 'landmark' && !it.usable && !includeUnlocatedLandmarks) continue;
    let best = null;
    for (const c of it.cands) {
      const s = scoreCandidate(query, c);
      if (!s) continue;
      const score = s + (c.via === 'name' ? 0.5 : 0);
      if (!best || score > best.score) best = { score, cand: c };
    }
    if (best) hits.push({ it, ...best });
  }
  hits.sort((a, b) => b.score - a.score
    || compareText(a.it.row.name, b.it.row.name)
    || KIND_ORDER[a.it.row.kind] - KIND_ORDER[b.it.row.kind]
    || compareText(a.it.row.town, b.it.row.town)
    || a.it.row.id - b.it.row.id);
  const top = hits.slice(0, max);
  const counts = plantCounts(idx.db, top.map((h) => h.it));
  return top.map((h) => toResult(h.it, h.cand, h.score, counts.get(h.it.row.id) || 0));
}

/** Returns the id of the area row for (name, town), creating it with geocode_status 'not_attempted' if missing. */
function ensureArea(name, town) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('ensureArea: name is required');
  const t = town === null || town === undefined ? null : String(town).replace(/\s+/g, ' ').trim() || null;
  let key;
  if (!slug(n)) {
    // areaKey() needs Latin letters/digits; keep non-Latin names distinct instead of collapsing them.
    key = `x-${Buffer.from(normalizeSearch(n), 'utf8').toString('hex').slice(0, 64)}|${t ? slug(t) || 'x' : ''}`;
  } else {
    key = t ? areaKey(n, t) : `${slug(n)}|`;
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM areas WHERE area_key = ?').get(key);
  if (existing) return existing.id;
  db.prepare(`INSERT INTO areas (area_key, kind, name, town, aliases_json, geocode_status, updated_at)
    VALUES (?, 'area', ?, ?, '[]', 'not_attempted', ?) ON CONFLICT(area_key) DO NOTHING`).run(key, n, t, nowIso());
  index = null;
  return db.prepare('SELECT id FROM areas WHERE area_key = ?').get(key).id;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Nearest usable (matched|manual) row within maxKm of the point, or null. Ties prefer areas, then
 * landmarks, then towns, then the lower id. `kinds` restricts the candidate kinds (default: all).
 */
function nearestArea(lat, lng, { maxKm = 5, kinds = null } = {}) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  const limitM = Number(maxKm) * 1000;
  let best = null;
  for (const it of getIndex().items) {
    if (!it.usable) continue;
    const r = it.row;
    if (kinds && !kinds.includes(r.kind)) continue;
    const d = haversineM(la, ln, r.latitude, r.longitude);
    if (!(d <= limitM)) continue;
    if (!best || d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && (KIND_ORDER[r.kind] - KIND_ORDER[best.r.kind] || r.id - best.r.id) < 0)) best = { d, r };
  }
  if (!best) return null;
  const r = best.r;
  return {
    id: r.id, kind: r.kind, name: r.name, town: r.town, nameUr: r.name_ur,
    lat: r.latitude, lng: r.longitude, radiusM: r.radius_m, geocodeStatus: r.geocode_status,
    distanceM: Math.round(best.d),
    withinRadius: isFiniteNum(r.radius_m) ? best.d <= r.radius_m : null,
  };
}

module.exports = {
  GAZETTEER_FILE,
  loadGazetteer,
  syncAreasToDb,
  search,
  ensureArea,
  nearestArea,
  isUsable,
  invalidate,
  entryKey,
  _internal: { canon, dlDistance, scoreCandidate },
};
