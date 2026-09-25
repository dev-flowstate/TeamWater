'use strict';
// Express application: security headers, static assets, API routers.
// Routers are owned by different workstreams (see docs/ARCHITECTURE.md → File ownership).
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { loadSession } = require('./lib/auth');
const { notFound, errorHandler } = require('./lib/http');

function originOf(urlTemplate) {
  try {
    const u = new URL(urlTemplate.replace(/\{s\}\./, 'a.').replace(/\{[a-z]+\}/g, '0'));
    // Tile templates with {s} subdomains → allow the wildcard parent.
    return /\{s\}\./.test(urlTemplate) ? `${u.protocol}//*.${u.host.split('.').slice(1).join('.')}` : u.origin;
  } catch {
    return '';
  }
}

function contentSecurityPolicy() {
  const google = config.map.provider === 'google';
  const g = google
    ? ['https://maps.googleapis.com', 'https://maps.gstatic.com', 'https://*.googleapis.com', 'https://*.gstatic.com', 'https://*.ggpht.com', 'https://*.google.com']
    : [];
  const tiles = config.map.provider === 'osm' ? [originOf(config.map.tileUrl)] : [];
  return [
    "default-src 'self'",
    `script-src 'self' ${g.join(' ')}`.trim(),
    `style-src 'self' 'unsafe-inline' ${google ? 'https://fonts.googleapis.com' : ''}`.trim(),
    `img-src 'self' data: blob: ${[...tiles, ...g].join(' ')}`.trim(),
    `connect-src 'self' ${g.join(' ')}`.trim(),
    `font-src 'self' ${google ? 'https://fonts.gstatic.com' : ''}`.trim(),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  const csp = contentSecurityPolicy();
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // ── API ──
  // No request logging of query strings: search coordinates are not retained.
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api/admin', loadSession);
  app.use('/api/admin', require('./routes/admin-auth'));
  app.use('/api/admin', require('./routes/admin-plants'));
  app.use('/api/admin', require('./routes/admin-imports'));
  app.use('/api/admin', require('./routes/admin-reports'));
  app.use('/api/admin', require('./routes/admin-system'));
  app.use('/api', require('./routes/public'));
  app.use('/api', require('./routes/reports'));
  app.use('/api', notFound);

  // ── Static assets ──
  const nm = (p) => path.join(config.root, 'node_modules', p);
  const staticOpts = { maxAge: config.isProduction ? '7d' : 0, fallthrough: true };
  app.use('/vendor/leaflet', express.static(nm('leaflet/dist'), staticOpts));
  app.use('/vendor/fontsource', express.static(nm('@fontsource'), staticOpts));
  app.use('/vendor/animejs', express.static(nm('animejs/dist/bundles'), staticOpts));
  app.use('/vendor/motion', express.static(nm('motion/dist'), staticOpts));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProduction ? '1h' : 0, extensions: ['html'] }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, contentSecurityPolicy };
