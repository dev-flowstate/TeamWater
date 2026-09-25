'use strict';
// Administrator authentication, roles and CSRF.
//
// Roles → permissions (see PERMISSIONS). Use in routers:
//   const { requirePermission, can } = require('../lib/auth');
//   router.patch('/plants/:id', requirePermission('plants:write'), handler)
//   if (can(req.user, 'contact:reveal')) { ... }
//
// requirePermission() → 401 if not signed in, 403 if the role lacks the permission, and for
// non-GET/HEAD requests also enforces the CSRF header `X-CSRF-Token` (token from login or GET /api/admin/me).
const { getDb } = require('./db');
const { nowIso } = require('./time');
const { randomToken, sha256 } = require('./crypto');
const { HttpError } = require('./http');
const config = require('../config');

const COOKIE = 'tw_admin';

const PERMISSIONS = {
  admin: ['*'],
  editor: [
    'plants:read', 'plants:write', 'plants:status', 'imports', 'tests:write', 'areas:write',
    'duplicates', 'export:plants', 'audit:read', 'stats',
  ],
  moderator: [
    'plants:read', 'plants:status', 'reports:read', 'reports:moderate', 'reporters:manage', 'appeals',
    'investigations', 'export:reports', 'audit:read', 'stats',
  ],
};
// Admin-only (never granted to other roles): 'users:manage', 'contact:reveal', 'export:contacts', 'maintenance'

function can(user, permission) {
  if (!user) return false;
  const perms = PERMISSIONS[user.role] || [];
  return perms.includes('*') || perms.includes(permission);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  return [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    config.isProduction ? 'Secure' : '',
    `Max-Age=${maxAgeSec}`,
  ].filter(Boolean).join('; ');
}

function createSession(res, user) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = nowIso();
  const expires = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  const db = getDb();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO admin_sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), user.id, csrf, now, expires);
  db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(now, user.id);
  res.setHeader('Set-Cookie', cookieString(token, config.sessionHours * 3600));
  return csrf;
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) getDb().prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookieString('', 0));
}

/** Middleware: attaches req.user = { id, username, role, displayName } and req.csrfToken if a valid session exists. */
function loadSession(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = getDb()
      .prepare(`SELECT s.csrf_token, s.expires_at, u.id, u.username, u.role, u.display_name, u.active
                FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.token_hash = ?`)
      .get(sha256(token));
    if (row && row.active && row.expires_at > nowIso()) {
      req.user = { id: row.id, username: row.username, role: row.role, displayName: row.display_name };
      req.csrfToken = row.csrf_token;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please sign in.'));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const header = req.get('X-CSRF-Token');
    if (!header || header !== req.csrfToken) return next(new HttpError(403, 'csrf', 'Security token missing or expired. Reload the page.'));
  }
  next();
}

function requirePermission(permission) {
  return (req, res, next) =>
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if (!can(req.user, permission)) return next(new HttpError(403, 'forbidden', 'Your role does not allow this action.'));
      next();
    });
}

module.exports = { PERMISSIONS, can, loadSession, requireAuth, requirePermission, createSession, destroySession, parseCookies, COOKIE };
