'use strict';
// External map providers (all server-side). See each module for its usage-policy notes.
const nominatim = require('./nominatim');
const googleGeocode = require('./google-geocode');
const osrm = require('./osrm');
const googleRoutes = require('./google-routes');
const { ProviderError, CircuitBreaker } = require('./common');

/** Test helper: clears circuit breakers, queues and in-memory caches of every provider. */
function resetAll() {
  for (const p of [nominatim, googleGeocode, osrm, googleRoutes]) p._test.reset();
}

module.exports = { nominatim, googleGeocode, osrm, googleRoutes, ProviderError, CircuitBreaker, resetAll };
