'use strict';
// Google Routes API (server-side; GOOGLE_MAPS_SERVER_KEY is never sent to browsers).
//   computeRoutes      → one route with a GeoJSON LineString
//   computeRouteMatrix → one-origin travel table for re-ranking the nearest candidates
// Both calls send an explicit X-Goog-FieldMask (required by the API, and it keeps billing to the
// "Essentials" SKU fields we actually use). Results are not cached or persisted.
//
// Travel modes: driving → DRIVE, walking → WALK, cycling → BICYCLE, two_wheeler → TWO_WHEELER.
// TWO_WHEELER (motorcycles / scooters) is how a very large share of people in Pakistan travel, and
// Google supports it in Pakistan, so it is exposed as an extra mode when this provider is active.
// WALK / BICYCLE coverage can be limited; an empty answer is reported as `no_route`, never faked.
const config = require('../../config');
const { ProviderError, CircuitBreaker, fetchJson } = require('./common');

const NAME = 'google';
const breaker = new CircuitBreaker('google-routes');
const TRAVEL_MODE = { driving: 'DRIVE', walking: 'WALK', cycling: 'BICYCLE', two_wheeler: 'TWO_WHEELER' };
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

const supportsMode = (mode) => Object.hasOwn(TRAVEL_MODE, mode);

const waypoint = (p) => ({ location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } });

function parseDuration(d) {
  if (typeof d === 'number') return d;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d || ''));
  return m ? Number(m[1]) : null;
}

function modeFields(mode) {
  const travelMode = TRAVEL_MODE[mode];
  if (!travelMode) throw new ProviderError('mode_unsupported', `Unsupported mode ${mode}`, { provider: NAME });
  // routingPreference is only accepted for DRIVE and TWO_WHEELER.
  return travelMode === 'DRIVE' || travelMode === 'TWO_WHEELER' ? { travelMode, routingPreference: 'TRAFFIC_UNAWARE' } : { travelMode };
}

async function post(url, fieldMask, payload) {
  if (!config.googleServerKey) throw new ProviderError('disabled', 'GOOGLE_MAPS_SERVER_KEY is not configured', { provider: NAME });
  return breaker.run(() => fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.googleServerKey, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(payload),
    timeoutMs: config.routing.timeoutMs,
    provider: NAME,
  }));
}

async function route(from, to, mode = 'driving') {
  const body = await post(ROUTES_URL, 'routes.duration,routes.distanceMeters,routes.polyline.geoJsonLinestring', {
    origin: waypoint(from),
    destination: waypoint(to),
    ...modeFields(mode),
    polylineEncoding: 'GEO_JSON_LINESTRING',
    computeAlternativeRoutes: false,
    units: 'METRIC',
  });
  const r = body && Array.isArray(body.routes) ? body.routes[0] : null;
  const line = r && r.polyline && r.polyline.geoJsonLinestring;
  if (!r || !line || !Array.isArray(line.coordinates)) throw new ProviderError('no_route', 'Google returned no route', { provider: NAME });
  return { distanceM: r.distanceMeters ?? null, durationS: parseDuration(r.duration), geometry: { type: 'LineString', coordinates: line.coordinates } };
}

async function table(from, dests, mode = 'driving') {
  if (!dests.length) return [];
  const body = await post(MATRIX_URL, 'originIndex,destinationIndex,duration,distanceMeters,status,condition', {
    origins: [{ waypoint: waypoint(from) }],
    destinations: dests.map((d) => ({ waypoint: waypoint(d) })),
    ...modeFields(mode),
  });
  if (!Array.isArray(body)) throw new ProviderError('unavailable', 'Unexpected route matrix response', { provider: NAME });
  const out = dests.map(() => ({ durationS: null, distanceM: null }));
  for (const el of body) {
    // proto3 JSON omits zero values, so a missing index means 0.
    const i = el.destinationIndex ?? 0;
    if ((el.originIndex ?? 0) !== 0 || !out[i]) continue;
    if (el.condition && el.condition !== 'ROUTE_EXISTS') continue;
    if (el.status && el.status.code) continue;
    out[i] = { durationS: parseDuration(el.duration), distanceM: el.distanceMeters ?? null };
  }
  return out;
}

module.exports = { name: NAME, TRAVEL_MODE, supportsMode, route, table, parseDuration, _test: { breaker, reset() { breaker.reset(); } } };
