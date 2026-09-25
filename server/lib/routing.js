'use strict';
// Routing facade over the configured provider (config.routing.provider: 'osrm' | 'google' | 'none').
//   routeTo(from, plantRow, mode) → { available:true, provider, mode, distanceM, durationS, geometry }
//                                  | { available:false, reason, detail? }
//   table(from, plantRows, mode)  → { available:true, provider, mode, results:[{durationS, distanceM}] }
//                                  | { available:false, reason }
// Reasons (contract §6): 'no_exact_location' | 'provider_unavailable' | 'mode_unsupported' | 'disabled'.
// When a provider answers "no road connection" the reason is 'provider_unavailable' with detail 'no_route'.
// The destination is ALWAYS the plant's stored exact coordinate; area centroids are never routed to.
const config = require('../config');
const osrm = require('./providers/osrm');
const googleRoutes = require('./providers/google-routes');
const { exactPosition } = require('./plant-view');

const BASE_MODES = ['driving', 'walking', 'cycling'];

// Google Routes content may only be shown on a Google map (Google Maps Platform terms), and needs the
// server key; otherwise ROUTING_PROVIDER=google is treated as disabled.
const googleUsable = () => config.map.provider === 'google' && !!config.googleServerKey;

function impl() {
  const p = config.routing.provider;
  if (p === 'osrm') return osrm;
  if (p === 'google' && googleUsable()) return googleRoutes;
  return null;
}

/** Effective provider for /api/config: 'osrm' | 'google' | 'none'. */
const providerName = () => { const p = impl(); return p ? config.routing.provider : 'none'; };

/** Modes accepted by the API. `two_wheeler` only exists when Google Routes is the active provider. */
function validModes() {
  return impl() === googleRoutes ? [...BASE_MODES, 'two_wheeler'] : BASE_MODES;
}

/** Availability of a mode without contacting the provider. */
function availability(mode) {
  const provider = impl();
  if (!provider) return { available: false, reason: 'disabled' };
  if (!provider.supportsMode(mode)) return { available: false, reason: 'mode_unsupported' };
  return { available: true, reason: null };
}

/** For /api/config: { driving, walking, cycling[, two_wheeler] } → boolean. */
function modes() {
  const out = {};
  for (const m of validModes()) out[m] = availability(m).available;
  return out;
}

function mapError(err) {
  const r = err && err.reason;
  if (r === 'mode_unsupported' || r === 'disabled') return { reason: r };
  if (r === 'no_route') return { reason: 'provider_unavailable', detail: 'no_route' };
  return { reason: 'provider_unavailable' };
}

async function routeTo(from, plant, mode = 'driving') {
  const dest = exactPosition(plant);
  if (!dest) return { available: false, reason: 'no_exact_location' };
  const av = availability(mode);
  if (!av.available) return { available: false, reason: av.reason };
  try {
    const r = await impl().route(from, dest, mode);
    return { available: true, provider: config.routing.provider, mode, distanceM: r.distanceM, durationS: r.durationS, geometry: r.geometry };
  } catch (err) {
    return { available: false, ...mapError(err) };
  }
}

async function table(from, plants, mode = 'driving') {
  const av = availability(mode);
  if (!av.available) return { available: false, reason: av.reason };
  const dests = plants.map(exactPosition);
  if (dests.some((d) => !d)) return { available: false, reason: 'no_exact_location' };
  try {
    const results = await impl().table(from, dests, mode);
    return { available: true, provider: config.routing.provider, mode, results };
  } catch (err) {
    return { available: false, ...mapError(err) };
  }
}

module.exports = { BASE_MODES, providerName, validModes, availability, modes, routeTo, table };
