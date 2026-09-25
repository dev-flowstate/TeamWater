'use strict';
// OSRM routing (server-side proxy).
//   driving  → config.routing.osrmUrl     (the public demo server is car-only and for light use)
//   walking  → config.routing.osrmFootUrl (only if configured; otherwise mode_unsupported)
//   cycling  → config.routing.osrmBikeUrl (only if configured; otherwise mode_unsupported)
// We never pretend: an unsupported mode is reported as `mode_unsupported`, an unreachable server as
// `unavailable` (with a 60 s circuit breaker per OSRM instance), and "no road connection" as `no_route`.
// Coordinates travel in the request URL only; they are not logged or stored.
const config = require('../../config');
const { ProviderError, CircuitBreaker, fetchJson } = require('./common');

const NAME = 'osrm';
// osrm-routed ignores the profile segment (the profile is fixed at osrm-extract time); these are the conventional names.
const PROFILE = { driving: 'driving', walking: 'foot', cycling: 'bike' };
const breakers = new Map();

function baseUrl(mode) {
  const r = config.routing;
  const url = mode === 'driving' ? r.osrmUrl : mode === 'walking' ? r.osrmFootUrl : mode === 'cycling' ? r.osrmBikeUrl : '';
  return url ? String(url).replace(/\/+$/, '') : '';
}

const supportsMode = (mode) => !!baseUrl(mode);

function breakerFor(url) {
  if (!breakers.has(url)) breakers.set(url, new CircuitBreaker(`osrm:${url}`));
  return breakers.get(url);
}

const coord = (p) => `${Number(p.lng)},${Number(p.lat)}`;

async function call(mode, path, query) {
  const base = baseUrl(mode);
  if (!base) throw new ProviderError('mode_unsupported', `No OSRM server configured for ${mode}`, { provider: NAME });
  const breaker = breakerFor(base);
  return breaker.run(async () => {
    const body = await fetchJson(`${base}${path}?${query}`, { timeoutMs: config.routing.timeoutMs, provider: NAME, accept4xxJson: true });
    if (body && body.code === 'Ok') return body;
    if (body && (body.code === 'NoRoute' || body.code === 'NoSegment' || body.code === 'NoTable')) {
      throw new ProviderError('no_route', `OSRM: ${body.code}`, { provider: NAME });
    }
    throw new ProviderError('unavailable', `OSRM error ${body && body.code}`, { provider: NAME });
  });
}

/** Route between two points. Returns { distanceM, durationS, geometry: GeoJSON LineString }. */
async function route(from, to, mode = 'driving') {
  const q = new URLSearchParams({ overview: 'full', geometries: 'geojson', alternatives: 'false', steps: 'false' });
  const body = await call(mode, `/route/v1/${PROFILE[mode] || 'driving'}/${coord(from)};${coord(to)}`, q);
  const r = Array.isArray(body.routes) ? body.routes[0] : null;
  if (!r || !r.geometry || r.geometry.type !== 'LineString') throw new ProviderError('no_route', 'OSRM returned no route', { provider: NAME });
  return { distanceM: r.distance, durationS: r.duration, geometry: { type: 'LineString', coordinates: r.geometry.coordinates } };
}

/** One-to-many travel table. Returns an array aligned with `dests`: { durationS, distanceM } (null when unreachable). */
async function table(from, dests, mode = 'driving') {
  if (!dests.length) return [];
  const coords = [from, ...dests].map(coord).join(';');
  const q = new URLSearchParams({
    sources: '0',
    destinations: dests.map((_, i) => i + 1).join(';'),
    annotations: 'duration,distance',
  });
  const body = await call(mode, `/table/v1/${PROFILE[mode] || 'driving'}/${coords}`, q);
  const durations = (body.durations && body.durations[0]) || [];
  const distances = (body.distances && body.distances[0]) || [];
  return dests.map((_, i) => ({
    durationS: Number.isFinite(durations[i]) ? durations[i] : null,
    distanceM: Number.isFinite(distances[i]) ? distances[i] : null,
  }));
}

module.exports = { name: NAME, supportsMode, route, table, _test: { breakers, reset() { breakers.clear(); } } };
