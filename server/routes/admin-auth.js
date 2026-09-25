'use strict';
// POST /api/admin/login   { username, password } → { user, csrfToken, permissions }
// POST /api/admin/logout
// GET  /api/admin/me      → { user, csrfToken, permissions }
const express = require('express');
const { getDb } = require('../lib/db');
const { verifyPassword, hashSubject } = require('../lib/crypto');
const { createSession, destroySession, requireAuth, PERMISSIONS } = require('../lib/auth');
const { HttpError, validate, str } = require('../lib/http');
const { rateCheck, rateRecord } = require('../lib/ratelimit');
const { audit } = require('../lib/audit');

const router = express.Router();

const userView = (u) => ({ id: u.id, username: u.username, role: u.role, displayName: u.displayName ?? u.display_name ?? null });
const permsFor = (role) => PERMISSIONS[role] || [];

router.post('/login', (req, res) => {
  const { username, password } = validate(req.body, { username: str({ max: 100 }), password: str({ max: 200, trim: false }) });
  const subject = hashSubject(`${req.ip}|${username.toLowerCase()}`);
  const limit = rateCheck('admin:login-fail', subject, { windowMs: 15 * 60e3, max: 5 });
  if (!limit.allowed) throw new HttpError(429, 'rate_limited', 'Too many failed sign-in attempts. Try again later.', { retryAfterSec: limit.retryAfterSec });

  const user = getDb().prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    rateRecord('admin:login-fail', subject);
    throw new HttpError(401, 'invalid_credentials', 'Username or password is incorrect.');
  }
  const csrfToken = createSession(res, user);
  req.user = userView(user);
  audit(req, { action: 'admin.login', entityType: 'admin_user', entityId: user.id });
  res.json({ user: userView(user), csrfToken, permissions: permsFor(user.role) });
});

router.post('/logout', requireAuth, (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
  res.json({ user: userView(req.user), csrfToken: req.csrfToken, permissions: permsFor(req.user.role) });
});

module.exports = router;
