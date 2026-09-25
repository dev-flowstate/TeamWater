'use strict';
// Geometry helpers (WGS84 decimal degrees). Pure functions — no I/O, no logging.
//   haversineM(lat1, lng1, lat2, lng2)   -> great-circle distance in metres
//   inBounds(lat, lng[, bounds])          -> inside config.map.bounds ([[S,W],[N,E]])
//   parseLatLng('31.41,73.07')            -> { lat, lng } or null (validates ranges)
//   bboxAround(lat, lng, radiusM)         -> { minLat, maxLat, minLng, maxLng } (SQL prefilter)
// Coordinates are never rounded here; callers must not log them (privacy: search origins are not retained).
const config = require('../config');

const EARTH_RADIUS_M = 6371008.8; // mean Earth radius (IUGG)
const toRad = (d) => (d * Math.PI) / 180;

function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function isValidLatLng(lat, lng) {
  return isFiniteNum(lat) && isFiniteNum(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function inBounds(lat, lng, bounds = config.map.bounds) {
  if (!isValidLatLng(lat, lng)) return false;
  const [[s, w], [n, e]] = bounds;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/** Parse one coordinate component strictly (no exponents, no hex, no trailing junk). */
function parseCoord(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!NUM_RE.test(s) || s.length > 32) return null;
  return Number(s);
}

/** Parses "lat,lng" (as used by /api/route?from=). Returns { lat, lng } or null. */
function parseLatLng(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split(',');
  if (parts.length !== 2) return null;
  const lat = parseCoord(parts[0]);
  const lng = parseCoord(parts[1]);
  if (lat === null || lng === null || !isValidLatLng(lat, lng)) return null;
  return { lat, lng };
}

/** Bounding box that contains every point within radiusM of (lat, lng). Used as a cheap SQL prefilter. */
function bboxAround(lat, lng, radiusM) {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.max(0.01, Math.cos(toRad(lat)));
  const dLng = dLat / cosLat;
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

module.exports = { EARTH_RADIUS_M, haversineM, isValidLatLng, inBounds, parseCoord, parseLatLng, bboxAround };
