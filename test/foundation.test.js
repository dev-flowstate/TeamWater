'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

test('foundation: auth, roles, CSRF, crypto', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('anonymous /me is 401', async () => {
    assert.equal((await s.fetch('/api/admin/me')).status, 401);
  });
  await t.test('login works and returns csrf', async () => {
    const admin = await s.login('admin');
    const me = await (await admin.fetch('/api/admin/me')).json();
    assert.equal(me.user.role, 'admin');
    assert.ok(me.csrfToken);
  });
  await t.test('wrong password rejected', async () => {
    const r = await s.fetch('/api/admin/login', { method: 'POST', json: { username: 'test-admin', password: 'nope-nope-nope' } });
    assert.equal(r.status, 401);
  });
  await t.test('logout requires CSRF', async () => {
    const admin = await s.login('editor');
    const r = await s.fetch('/api/admin/logout', { method: 'POST', headers: { Cookie: admin.cookie } });
    assert.equal(r.status, 403);
    assert.equal((await admin.fetch('/api/admin/logout', { method: 'POST' })).status, 200);
  });
  await t.test('phone crypto roundtrip + normalization', () => {
    const c = require('../server/lib/crypto');
    assert.equal(c.normalizePhone('0300-1234567'), '+923001234567');
    assert.equal(c.normalizePhone('+92 300 1234567'), '+923001234567');
    assert.equal(c.normalizePhone('12345'), null);
    const enc = c.encryptPhone('+923001234567');
    assert.notEqual(enc, '+923001234567');
    assert.equal(c.decryptPhone(enc), '+923001234567');
    assert.equal(c.hashPhone('+923001234567'), c.hashPhone('+923001234567'));
    assert.match(c.reference(), /^TW-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  });
  await t.test('security headers present', async () => {
    const r = await s.fetch('/api/admin/me');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});
