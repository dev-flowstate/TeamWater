'use strict';
// Find positions and landmarks for the public plants and write data/source/incoming/enrichment.json, which
// `npm run setup` applies (it never calls the network itself).
//   node scripts/enrich-locations.js          needs internet; takes a few minutes; commit the JSON afterwards
//
// Positions, only for plants with none (plants whose source position was rejected as out of bounds are skipped):
//   1. A plus code in the plant's own record (e.g. "F37X+R62, Green Town") is decoded offline. Precise, not approximate.
//   2. Otherwise OpenStreetMap Nominatim is searched with the address / link text / name / chak number. Only a
//      village-, neighbourhood- or place-level match inside the district counts; a whole town, city or road does not.
//      These are flagged approximate and labelled so on the site.
//   Positions found by an earlier run (the existing enrichment.json) are reused; pass --refresh to search again.
// Addresses, only for plants with none: a reverse lookup of the plant's position on OpenStreetMap, e.g.
//   "Jhang Road, Partab Nagar, Faisalabad"; "Near …" for searched positions. A tehsil or city alone is not used.
// Landmarks, only for plants with none:
//   1. "Near X" in the plant's own name or address.
//   2. Otherwise the nearest named school, mosque, hospital, park, fuel station … on OpenStreetMap within 1 km of
//      the position, e.g. "Govt. High School (about 120 m away)".
// OpenStreetMap data © OpenStreetMap contributors, ODbL. Google Maps is not used (its terms forbid storing its data).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUTPUT = path.join(__dirname, '..', 'data', 'source', 'incoming', 'enrichment.json');
const OLC_ALPHABET = '23456789CFGHJMPQRVWX';
const OLC_RES = [20, 1, 0.05, 0.0025, 0.000125];
const PLUS_CODE_RE = /\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;
const LANDMARK_RADIUS_M = 1000;
// Nominatim match types that are too coarse to stand for a plant's position.
const TOO_COARSE = new Set(['country', 'state', 'state_district', 'region', 'province', 'county', 'district', 'municipality', 'city', 'town', 'road']);

/** Decode a full Open Location Code (8+ digits before '+') to its centre. */
function decodePlusCode(code) {
  const c = code.toUpperCase().replace('+', '');
  let lat = -90, lng = -180, latSize = 0, lngSize = 0;
  for (let i = 0; i < Math.min(10, c.length); i += 2) {
    const r = OLC_RES[i / 2];
    lat += OLC_ALPHABET.indexOf(c[i]) * r;
    lng += OLC_ALPHABET.indexOf(c[i + 1]) * r;
    latSize = lngSize = r;
  }
  for (const ch of c.slice(10)) {
    const d = OLC_ALPHABET.indexOf(ch);
    latSize /= 5; lngSize /= 4;
    lat += Math.floor(d / 4) * latSize;
    lng += (d % 4) * lngSize;
  }
  return { lat: lat + latSize / 2, lng: lng + lngSize / 2 };
}

/** Recover a short plus code ("F37X+R62") to the full code nearest the reference point, and decode it. */
function recoverPlusCode(short, refLat, refLng) {
  const code = short.toUpperCase();
  const padding = 8 - code.indexOf('+');
  if (padding <= 0) return decodePlusCode(code);
  let prefix = '', la = refLat + 90, ln = refLng + 180;
  for (let i = 0; i < padding / 2; i++) {
    const r = OLC_RES[i];
    prefix += OLC_ALPHABET[Math.floor(la / r)] + OLC_ALPHABET[Math.floor(ln / r)];
    la %= r; ln %= r;
  }
  const p = decodePlusCode(prefix + code);
  const res = 20 ** (2 - padding / 2), half = res / 2;
  if (refLat + half < p.lat) p.lat -= res; else if (refLat - half > p.lat) p.lat += res;
  if (refLng + half < p.lng) p.lng -= res; else if (refLng - half > p.lng) p.lng += res;
  return p;
}

/** "RO Plant Near Government MC Primary School Ameen Abad" → "Government MC Primary School Ameen Abad". */
function nearLandmark(...texts) {
  for (const t of texts) {
    const m = String(t || '').match(/\bnear\s+([^,]+)/i);
    if (m && m[1].trim().length >= 3) return m[1].trim().replace(/\s+/g, ' ');
  }
  return null;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// A search hit must name the place, not just resemble it: Nominatim fuzzy-matches "Chak 224 RB" to "Chak 234 GB".
const GENERIC = new Set(['road', 'rd', 'street', 'st', 'block', 'no', 'near', 'govt', 'government', 'the', 'and', 'of', 'park', 'colony',
  'town', 'chowk', 'chok', 'bazar', 'market', 'masjid', 'mosque', 'school', 'college', 'hospital', 'darbar', 'abad', 'city', 'faisalabad',
  'punjab', 'pakistan', 'district', 'tehsil', 'ward', 'new', 'old', 'high', 'boys', 'girls', 'elementary', 'primary', 'model', 'main',
  'plant', 'plants', 'water', 'filter', 'filtration', 'ro', 'chak', 'rb', 'gb', 'jb']);
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
const chakOf = (s) => { const m = String(s || '').match(/\b(\d{1,3})\s*-?\s*(RB|GB|JB)\b/i); return m ? { n: Number(m[1]), suffix: m[2].toUpperCase() } : null; };

/** Does a Nominatim hit plausibly name this plant's place? */
// Another district counts only when the plant names it (e.g. Chiniot); "Tariq Abad" is also a village in Toba Tek Singh.
function districtOk(hit, text) {
  const district = String(hit.display_name || '').match(/([A-Za-z .'-]+) District/);
  return !district || squash(district[1]) === 'faisalabad' || squash(text).includes(squash(district[1]).slice(0, 4));
}

function hitMatches(hit, plantText) {
  if (!districtOk(hit, plantText)) return false;
  const first = hit.name || String(hit.display_name || '').split(',')[0];
  if (squash(first).length >= 5 && squash(plantText).includes(squash(first))) return true;
  const chak = chakOf(plantText);
  if (chak) return new RegExp(`\\b0*${chak.n}\\s*-?\\s*${chak.suffix}\\b`, 'i').test(hit.display_name || '');
  const plantWords = new Set(words(plantText));
  return words(first).some((w) => plantWords.has(w));
}

/**
 * Hand-picked queries: every distinctive word and number of the query must appear in the hit, so "Peoples Colony
 * No 2" does not accept "Peoples Colony No.01" and "Qasim Abad" does not accept "Qasim CNG".
 */
const QUERY_GENERIC = new Set([...GENERIC].filter((w) => w !== 'abad'));
const queryTokens = (s) => String(s || '').toLowerCase().replace(/(?<![0-9])0+(?=[0-9])/g, '').split(/[^a-z0-9]+/)
  .filter((w) => /^\d+$/.test(w) || (w.length >= 3 && !QUERY_GENERIC.has(w)));
function curatedHitMatches(hit, query, plantText) {
  if (!districtOk(hit, `${query} ${plantText}`)) return false;
  const have = new Set(queryTokens(hit.display_name));
  return queryTokens(query).every((w) => have.has(w));
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-enrich-'));
  process.env.GEOCODER_PROVIDER = 'none';
  const config = require('../server/config');
  const { getDb, closeDb } = require('../server/lib/db');
  const { inBounds } = require('../server/import/normalize');
  const { publicPlantSql } = require('../server/lib/plant-view');
  await require('./setup').runSetup({ quiet: true, enrichment: false });

  const ua = config.geocoder.userAgent;
  const plants = getDb().prepare(`SELECT * FROM plants p WHERE ${publicPlantSql('p')} ORDER BY plant_code`).all();
  const out = {};
  const put = (code, v) => { out[code] = { ...out[code], ...v }; };
  const previous = !process.argv.includes('--refresh') && fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')).plants : {};
  const [refLat, refLng] = config.map.center;

  // ── Positions ──
  let lastCall = 0;
  async function nominatim(q) {
    await sleep(Math.max(0, lastCall + 1100 - Date.now()));
    lastCall = Date.now();
    const [[s, w], [n, e]] = config.map.bounds;
    const url = `${config.geocoder.url}/search?${new URLSearchParams({ q, format: 'jsonv2', limit: '3', countrycodes: 'pk', viewbox: `${w},${n},${e},${s}`, bounded: '1' })}`;
    const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`Nominatim ${res.status} for "${q}"`);
    return res.json();
  }
  const linkPlace = (p) => {
    const url = JSON.parse(p.source_values_json || '{}')['GOOGLE LOCATION'] || '';
    const m = url.match(/maps\/place\/([^/@]+)/);
    const text = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
    return text && !/^faisalabad, punjab$/i.test(text) ? text : null;
  };
  // Hand-picked queries come first and must match their own words; automatic ones must match the plant's text.
  const curated = JSON.parse(fs.readFileSync(path.join(path.dirname(OUTPUT), 'enrichment-queries.json'), 'utf8'));
  const queriesFor = (p) => {
    const plantText = [p.name, p.address, linkPlace(p)].filter(Boolean).join(' ');
    const q = [p.address, linkPlace(p), p.name];
    const chak = chakOf(p.name);
    if (chak) q.push(`Chak ${chak.n} ${chak.suffix}`, `${chak.n} ${chak.suffix}`);
    return [
      ...(curated[p.plant_code] || []).map((text) => ({ text, ok: (h) => curatedHitMatches(h, text, plantText) })),
      ...[...new Set(q.filter(Boolean).map((s) => s.trim()))].map((text) => ({ text, ok: (h) => hitMatches(h, plantText) })),
    ];
  };

  const missing = plants.filter((p) => p.coord_status === 'missing' && p.latitude === null
    && !/coordinates_out_of_bounds|coordinates_possibly_swapped/.test(p.review_reasons_json || ''));
  console.log(`${missing.length} public plants have no position.`);
  for (const p of missing) {
    const prev = previous[p.plant_code];
    if (prev && prev.lat !== undefined) {
      put(p.plant_code, { lat: prev.lat, lng: prev.lng, approximate: prev.approximate, coordSource: prev.coordSource });
      continue;
    }
    const texts = [p.address, linkPlace(p), p.name].filter(Boolean);
    const plus = texts.map((t) => t.match(PLUS_CODE_RE)).find(Boolean);
    if (plus) {
      const pos = recoverPlusCode(plus[1], refLat, refLng);
      if (inBounds(pos.lat, pos.lng)) {
        put(p.plant_code, { lat: round6(pos.lat), lng: round6(pos.lng), approximate: false, coordSource: `Plus code ${plus[1].toUpperCase()} in the source record` });
        continue;
      }
    }
    for (const { text: q, ok } of queriesFor(p)) {
      let hits;
      try { hits = await nominatim(q); } catch (err) { console.warn(String(err.message)); continue; }
      const hit = hits.find((h) => !TOO_COARSE.has(h.addresstype) && inBounds(Number(h.lat), Number(h.lon)) && ok(h));
      if (hit) {
        put(p.plant_code, {
          lat: round6(Number(hit.lat)), lng: round6(Number(hit.lon)), approximate: true,
          coordSource: `OpenStreetMap Nominatim search for "${q}" matched "${hit.display_name}" (${hit.addresstype})`,
        });
        break;
      }
    }
    console.log(`${p.plant_code}: ${out[p.plant_code]?.coordSource || 'not found'}`);
  }

  // ── Addresses (reverse lookup of each position) ──
  const positionOf = (p) => (p.latitude !== null ? { lat: p.latitude, lng: p.longitude, approximate: false }
    : out[p.plant_code]?.lat !== undefined ? out[p.plant_code] : null);
  const formatAddress = (a = {}) => {
    const road = a.road ? [a.house_number, a.road].filter(Boolean).join(' ') : null;
    const local = a.neighbourhood || a.quarter || a.residential || a.suburb || a.hamlet;
    if (!road && !local) return null; // a tehsil or city alone is not an address
    const place = (a.village || a.town || a.city || a.city_district || '').replace(/\s+(City|Saddar)?\s*Tehsil$/i, '') || null;
    const seen = new Set();
    return [road, local, place].filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).join(', ');
  };
  for (const p of plants) {
    if (p.address) continue;
    const pos = positionOf(p);
    if (!pos) continue;
    await sleep(Math.max(0, lastCall + 1100 - Date.now()));
    lastCall = Date.now();
    const url = `${config.geocoder.url}/reverse?${new URLSearchParams({ lat: String(pos.lat), lon: String(pos.lng), format: 'jsonv2', zoom: '17', addressdetails: '1' })}`;
    const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'en' } }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const text = formatAddress(r?.address);
    if (text) put(p.plant_code, { address: pos.approximate ? `Near ${text}` : text });
  }
  console.log(`${Object.values(out).filter((v) => v.address).length} addresses from OpenStreetMap.`);

  // ── Landmarks ──
  const [[s, w], [n, e]] = config.map.bounds;
  const bbox = `${s - 0.15},${w - 0.4},${n + 0.15},${e + 0.15}`;
  const query = `[out:json][timeout:180];(
    nwr["name"]["amenity"~"^(school|college|university|hospital|clinic|place_of_worship|bank|police|post_office|marketplace|community_centre|townhall|library|bus_station|fuel)$"](${bbox});
    nwr["name"]["leisure"~"^(park|stadium)$"](${bbox});
    nwr["name"]["shop"="mall"](${bbox});
  );out center tags;`;
  let res;
  for (const [i, host] of ['overpass-api.de', 'overpass.kumi.systems', 'overpass-api.de'].entries()) {
    if (i) await sleep(15000);
    res = await fetch(`https://${host}/api/interpreter`, {
      method: 'POST', headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`,
    }).catch((err) => ({ ok: false, status: err.message }));
    if (res.ok) break;
    console.warn(`Overpass (${host}) failed: ${res.status}`);
  }
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const latin = (s) => (s && /[A-Za-z]/.test(s) ? s : null);
  const pois = (await res.json()).elements.map((el) => ({
    name: latin(el.tags['name:en']) || latin(el.tags.name) || el.tags.name,
    lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon,
  })).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng));
  console.log(`${pois.length} named places from OpenStreetMap.`);

  for (const p of plants) {
    if (p.landmark) continue;
    const near = nearLandmark(p.name, p.address);
    if (near) { put(p.plant_code, { landmark: near }); continue; }
    const pos = positionOf(p);
    if (!pos || pos.approximate) continue;
    let best = null;
    for (const x of pois) {
      if (Math.abs(x.lat - pos.lat) > 0.01 || Math.abs(x.lng - pos.lng) > 0.012) continue;
      const d = haversineM(pos.lat, pos.lng, x.lat, x.lng);
      if (d <= LANDMARK_RADIUS_M && (!best || d < best.d)) best = { ...x, d };
    }
    if (best) put(p.plant_code, { landmark: `${best.name} (about ${Math.max(10, Math.round(best.d / 10) * 10)} m away)` });
  }

  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  fs.writeFileSync(OUTPUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    attribution: 'Positions found by search, addresses and landmarks: © OpenStreetMap contributors, ODbL. Plus codes: from the source records.',
    plants: sorted,
  }, null, 2) + '\n');
  const vals = Object.values(sorted);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}: ${vals.filter((v) => v.lat !== undefined && !v.approximate).length} plus-code positions, `
    + `${vals.filter((v) => v.approximate).length} approximate positions, ${vals.filter((v) => v.address).length} addresses, ${vals.filter((v) => v.landmark).length} landmarks.`);
  closeDb();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { decodePlusCode, recoverPlusCode, nearLandmark, hitMatches, curatedHitMatches, OUTPUT };
