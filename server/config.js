'use strict';
// Central configuration. Every value can be overridden with an environment variable.
// Nothing secret is hard-coded: missing secrets are generated for local development only
// (see lib/crypto.js) and are REQUIRED when NODE_ENV=production.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data/runtime');

const config = {
  root: ROOT,
  env: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  port: num(env.PORT, 3000),
  trustProxy: bool(env.TRUST_PROXY, false),
  publicBaseUrl: env.PUBLIC_BASE_URL || '',

  dataDir: DATA_DIR,
  dbPath: env.DB_PATH ? path.resolve(ROOT, env.DB_PATH) : path.join(DATA_DIR, 'teamwater.sqlite'),
  uploadDir: env.UPLOAD_DIR ? path.resolve(ROOT, env.UPLOAD_DIR) : path.join(DATA_DIR, 'uploads'),
  secretsFile: path.join(DATA_DIR, 'dev-secrets.json'),

  // Secrets (hex, 32 bytes each). Generated for dev if absent; required in production.
  phoneEncKey: env.PHONE_ENC_KEY || '',
  hmacKey: env.HMAC_KEY || '',

  sessionHours: num(env.SESSION_HOURS, 12),

  // Base map (rendered in the visitor's browser). Pluggable:
  //   MAP_PROVIDER=osm    (default) Leaflet + tile URL below. No key required. OSM's tile policy allows
  //                       light interactive use with attribution; heavy traffic needs a paid/self-hosted
  //                       tile service (MapTiler, Stadia, Thunderforest, ...) — set MAP_TILE_URL/MAP_ATTRIBUTION.
  //   MAP_PROVIDER=google Google Maps JavaScript API (official, key + billing required).
  //                       GOOGLE_MAPS_BROWSER_KEY must be HTTP-referrer restricted.
  // Map data is never scraped or bulk-copied from any provider; plants are an overlay from our database.
  map: {
    provider: env.MAP_PROVIDER || 'osm', // 'osm' | 'google'
    providerName: env.MAP_PROVIDER_NAME || (env.MAP_PROVIDER === 'google' ? 'Google Maps' : 'OpenStreetMap'),
    tileUrl: env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      env.MAP_ATTRIBUTION ||
      '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: num(env.MAP_MAX_ZOOM, 19),
    googleBrowserKey: env.GOOGLE_MAPS_BROWSER_KEY || '',
    googleMapId: env.GOOGLE_MAPS_MAP_ID || '',
    // Faisalabad District approx. bounding box (S, W, N, E) used to bias search & frame the map.
    bounds: [
      [30.75, 72.6],
      [31.85, 73.65],
    ],
    center: [31.418, 73.079],
    defaultZoom: 11,
  },

  // Server-side key for Google Geocoding / Places / Routes (IP-restricted; never sent to browsers).
  googleServerKey: env.GOOGLE_MAPS_SERVER_KEY || '',

  // Geocoding (server-side proxy with caching; respects Nominatim usage policy: <=1 req/s, UA, cache).
  geocoder: {
    provider: env.GEOCODER_PROVIDER || 'nominatim', // 'nominatim' | 'google' | 'none'
    url: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    userAgent: env.GEOCODER_USER_AGENT || 'TeamWater-FaisalabadWaterFinder/0.1 (set GEOCODER_USER_AGENT with contact)',
    email: env.GEOCODER_EMAIL || '',
    timeoutMs: num(env.GEOCODER_TIMEOUT_MS, 5000),
  },

  // Routing. The public OSRM demo server is for light/demo use only (car profile only).
  routing: {
    provider: env.ROUTING_PROVIDER || 'osrm', // 'osrm' | 'google' | 'none'
    osrmUrl: env.OSRM_URL || 'https://router.project-osrm.org',
    // Optional separate OSRM instances per profile; unset = mode unavailable (falls back to straight line)
    osrmFootUrl: env.OSRM_FOOT_URL || '',
    osrmBikeUrl: env.OSRM_BIKE_URL || '',
    timeoutMs: num(env.ROUTING_TIMEOUT_MS, 5000),
  },

  // SMS phone verification. 'none' = disabled (reports still accepted, marked unverified).
  // 'console' = development only: codes are printed to the server log. Never use in production.
  sms: {
    provider: env.SMS_PROVIDER || 'none', // 'none' | 'console' | 'twilio'
    twilioSid: env.TWILIO_ACCOUNT_SID || '',
    twilioToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
  },

  uploads: {
    maxPhotoBytes: num(env.UPLOAD_MAX_PHOTO_MB, 5) * 1024 * 1024,
    maxPhotos: num(env.UPLOAD_MAX_PHOTOS, 3),
    maxDocBytes: num(env.UPLOAD_MAX_DOC_MB, 15) * 1024 * 1024,
    maxImportBytes: num(env.UPLOAD_MAX_IMPORT_MB, 20) * 1024 * 1024,
  },

  retention: {
    reportDays: num(env.RETENTION_REPORT_DAYS, 730), // report text/photos kept 2 years, then redacted
    contactDays: num(env.RETENTION_CONTACT_DAYS, 180), // phone numbers erased 180 days after last activity
    rateEventHours: num(env.RETENTION_RATE_EVENTS_HOURS, 72),
  },

  // Demonstration data: OFF by default. When on, clearly labelled demo plants are loaded
  // with is_demo=1 and every page shows a "Demonstration data" banner.
  demoData: bool(env.DEMO_DATA, false),

  timezone: 'Asia/Karachi',
};

module.exports = config;
