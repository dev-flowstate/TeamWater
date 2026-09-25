'use strict';
// Public API (no account). docs/ARCHITECTURE.md §6.
//   GET /api/config          GET /api/geocode?q=&lang=      GET /api/reverse?lat=&lng=
//   GET /api/search?...      GET /api/plants?area=|town=&q= GET /api/plants/:code
//   GET /api/route?from=lat,lng&to=CODE&mode=               GET /api/files/:id (published test reports only)
// PRIVACY: search/reverse/route coordinates are used to answer the request and are never logged or stored.
// Rate limits use a keyed, daily-rotating hash of the IP (lib/crypto.hashSubject), never the raw IP.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { getDb } = require('../lib/db');
const { HttpError, validate, str, num, int, oneOf, bool, paginate } = require('../lib/http');
const { hashSubject } = require('../lib/crypto');
const { rateCheck, rateRecord } = require('../lib/ratelimit');
const { parseLatLng, isValidLatLng } = require('../lib/geo');
const geocoder = require('../lib/geocoder');
const routing = require('../lib/routing');
const ranking = require('../lib/ranking');
const { toSummary, toDetail, loadAggregates, areaFor, exactPosition, isAreaUsable } = require('../lib/plant-view');

const router = express.Router();

const REPORT_CATEGORIES = ['closed_during_hours', 'no_water', 'broken_equipment', 'color_odor_taste', 'dirty_surroundings', 'incorrect_details', 'unexpected_charges', 'other'];
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const FILE_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const FILE_EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

const RATE = {
  geo: { bucket: 'public:geo', windowMs: 60e3, max: 60 },
  route: { bucket: 'public:route', windowMs: 60e3, max: 60 },
  search: { bucket: 'public:search', windowMs: 60e3, max: 120 },
};

function rateLimit(kind) {
  const { bucket, windowMs, max } = RATE[kind];
  return (req, res, next) => {
    const subject = hashSubject(req.ip);
    const r = rateCheck(bucket, subject, { windowMs, max });
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      return next(new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.', { retryAfterSec: r.retryAfterSec }));
    }
    rateRecord(bucket, subject);
    next();
  };
}

const demoVisible = () => config.demoData;
const demoSql = (alias = 'p') => (config.demoData ? '' : `AND ${alias}.is_demo = 0`);

function findPlant(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
  const row = getDb().prepare('SELECT * FROM plants WHERE plant_code = ?').get(code);
  if (!row || (row.is_demo === 1 && !demoVisible())) return null;
  return row;
}

// ── GET /api/config ──
function stats() {
  const db = getDb();
  const rows = db.prepare(`SELECT p.coord_status, p.latitude, p.longitude, p.area_id FROM plants p WHERE 1 = 1 ${demoSql()}`).all();
  const areas = new Map(db.prepare('SELECT * FROM areas').all().map((a) => [a.id, a]));
  let exact = 0, area = 0, none = 0;
  for (const r of rows) {
    if (exactPosition(r)) exact++;
    else if (isAreaUsable(areas.get(r.area_id))) area++;
    else none++;
  }
  const batch = db.prepare("SELECT source_filename, committed_at FROM import_batches WHERE status = 'committed' ORDER BY committed_at DESC, id DESC LIMIT 1").get();
  return {
    plantsTotal: rows.length, plantsExact: exact, plantsArea: area, plantsNoLocation: none,
    lastImportAt: batch ? batch.committed_at : null, sourceFile: batch ? batch.source_filename : null,
  };
}

function smsEnabled() {
  try {
    const sms = require('../lib/sms');
    if (typeof sms.isEnabled === 'function') return !!sms.isEnabled();
    if (typeof sms.enabled === 'boolean') return sms.enabled;
  } catch { /* module not present yet */ }
  const p = config.sms.provider;
  if (p === 'twilio') return !!(config.sms.twilioSid && config.sms.twilioToken && config.sms.twilioFrom);
  return p === 'console' && !config.isProduction;
}

router.get('/config', (req, res) => {
  const google = config.map.provider === 'google';
  res.json({
    appName: 'Team Water',
    map: {
      provider: google ? 'google' : 'osm',
      providerName: config.map.providerName,
      tileUrl: google ? null : config.map.tileUrl,
      attribution: google ? null : config.map.attribution,
      maxZoom: config.map.maxZoom,
      // Only the HTTP-referrer-restricted BROWSER key, and only when Google is the map provider.
      ...(google ? { googleBrowserKey: config.map.googleBrowserKey, googleMapId: config.map.googleMapId } : {}),
      bounds: config.map.bounds,
      center: config.map.center,
      defaultZoom: config.map.defaultZoom,
      coverageNote: 'Streets, shops and landmarks come from the map provider and may be incomplete.',
      updatedNote: google
        ? "Map data comes from Google Maps and reflects the provider's current data."
        : "OpenStreetMap is continuously edited; tiles reflect the provider's current data.",
    },
    geocoder: { provider: ['nominatim', 'google'].includes(config.geocoder.provider) ? config.geocoder.provider : 'none' },
    routing: { provider: ['osrm', 'google'].includes(config.routing.provider) ? config.routing.provider : 'none', modes: routing.modes() },
    sms: { enabled: smsEnabled() },
    demoMode: !!config.demoData,
    stats: stats(),
    reportCategories: REPORT_CATEGORIES,
    limits: {
      maxPhotos: config.uploads.maxPhotos,
      maxPhotoMb: Math.round((config.uploads.maxPhotoBytes / (1024 * 1024)) * 10) / 10,
      descriptionMin: 10,
      descriptionMax: 2000,
    },
  });
});

// ── GET /api/geocode ──
router.get('/geocode', rateLimit('geo'), async (req, res) => {
  const v = validate(req.query, {
    q: str({ min: geocoder.MIN_QUERY, max: geocoder.MAX_QUERY }),
    lang: oneOf(['en', 'ur'], { optional: true }),
  });
  res.json(await geocoder.search(v.q, { lang: v.lang || 'en' }));
});

// ── GET /api/reverse ──
router.get('/reverse', rateLimit('geo'), async (req, res) => {
  const v = validate(req.query, {
    lat: num({ min: -90, max: 90 }),
    lng: num({ min: -180, max: 180 }),
    lang: oneOf(['en', 'ur'], { optional: true }),
  });
  res.json(await geocoder.reverse(v.lat, v.lng, { lang: v.lang || 'en' }));
});

// ── GET /api/search ──
router.get('/search', rateLimit('search'), async (req, res) => {
  const v = validate(req.query, {
    lat: num({ min: -90, max: 90 }),
    lng: num({ min: -180, max: 180 }),
    sort: oneOf(['nearest', 'recommended'], { optional: true }),
    mode: oneOf(routing.validModes(), { optional: true }),
    technology: str({ max: 200, optional: true }),
    operatorType: str({ max: 200, optional: true }),
    hideTemporarilyClosed: bool({ optional: true }),
    limit: int({ min: 1, max: ranking.MAX_LIMIT, optional: true }),
  });
  res.json(await ranking.search({
    lat: v.lat, lng: v.lng, sort: v.sort || 'nearest', mode: v.mode || 'driving',
    technology: v.technology, operatorType: v.operatorType, hideTemporarilyClosed: !!v.hideTemporarilyClosed,
    limit: v.limit || ranking.DEFAULT_LIMIT,
  }));
});

// ── GET /api/plants (text list) ──
router.get('/plants', (req, res) => {
  const v = validate(req.query, {
    area: int({ min: 1, optional: true }),
    town: str({ max: 200, optional: true }),
    q: str({ max: 200, optional: true }),
    includeClosed: bool({ optional: true }),
  });
  const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 25, maxSize: 100 });
  const where = ['1 = 1'];
  const params = [];
  if (!config.demoData) where.push('p.is_demo = 0');
  if (!v.includeClosed) where.push("p.status NOT IN ('permanently_closed','decommissioned')");
  if (v.area !== null) { where.push('p.area_id = ?'); params.push(v.area); }
  if (v.town !== null) { where.push('p.town = ? COLLATE NOCASE'); params.push(v.town); }
  if (v.q !== null) {
    const like = `%${v.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(p.plant_code LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.area_raw LIKE ? ESCAPE '\\' OR p.town LIKE ? ESCAPE '\\'
                 OR p.address LIKE ? ESCAPE '\\' OR p.landmark LIKE ? ESCAPE '\\' OR p.neighborhood LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like, like, like);
  }
  const db = getDb();
  const sqlWhere = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM plants p WHERE ${sqlWhere}`).get(...params).n;
  const rows = db.prepare(`SELECT p.* FROM plants p WHERE ${sqlWhere} ORDER BY p.plant_code LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const areas = new Map(db.prepare('SELECT * FROM areas WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...new Set(rows.map((r) => r.area_id).filter(Boolean))])).map((a) => [a.id, a]));
  const aggregates = loadAggregates(rows.map((r) => r.id));
  const now = new Date();
  res.json({
    items: rows.map((r) => toSummary(r, areas.get(r.area_id) || null, { aggregates, now })),
    total, page, pageSize,
  });
});

// ── GET /api/plants/:code ──
router.get('/plants/:code', (req, res) => {
  const row = findPlant(req.params.code);
  if (!row) throw new HttpError(404, 'not_found', 'Plant not found.');
  res.json(toDetail(row, areaFor(row)));
});

// ── GET /api/route ──
router.get('/route', rateLimit('route'), async (req, res) => {
  const v = validate(req.query, {
    from: str({ max: 80 }),
    to: str({ max: 40, pattern: CODE_RE }),
    mode: oneOf(routing.validModes(), { optional: true }),
  });
  const from = parseLatLng(v.from);
  if (!from || !isValidLatLng(from.lat, from.lng)) throw new HttpError(400, 'invalid_input', 'from: must be "lat,lng" in decimal degrees', { field: 'from' });
  const plant = findPlant(v.to);
  if (!plant) throw new HttpError(404, 'not_found', 'Plant not found.');
  // Destination = the plant's STORED exact coordinates, looked up here (never taken from the client).
  res.json(await routing.routeTo(from, plant, v.mode || 'driving'));
});

// ── GET /api/files/:id (published water-test reports only) ──
router.get('/files/:id', (req, res, next) => {
  const id = /^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null;
  if (!id) throw new HttpError(404, 'not_found', 'File not found.');
  const f = getDb().prepare(`
    SELECT f.* FROM files f
    WHERE f.id = ? AND f.kind = 'test_report'
      AND EXISTS (SELECT 1 FROM water_tests t JOIN plants p ON p.id = t.plant_id
                  WHERE t.report_file_id = f.id AND t.published = 1 ${demoSql()})`).get(id);
  if (!f || !FILE_MIME.has(f.mime)) throw new HttpError(404, 'not_found', 'File not found.');
  const root = path.resolve(config.uploadDir);
  const abs = path.resolve(root, f.storage_path);
  if (!abs.startsWith(root + path.sep)) throw new HttpError(404, 'not_found', 'File not found.');
  let stat;
  try { stat = fs.statSync(abs); } catch { throw new HttpError(404, 'not_found', 'File not found.'); }
  if (!stat.isFile()) throw new HttpError(404, 'not_found', 'File not found.');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="water-test-report-${f.id}.${FILE_EXT[f.mime]}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  const stream = fs.createReadStream(abs);
  stream.on('error', (err) => (res.headersSent ? res.destroy(err) : next(new HttpError(404, 'not_found', 'File not found.'))));
  stream.pipe(res);
});

module.exports = router;
