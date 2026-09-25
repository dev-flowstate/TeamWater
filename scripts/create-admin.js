'use strict';
// Create or reset an administrator account.
//   npm run admin:create -- <username> <role: admin|editor|moderator> [password]
// If no password is given, a strong random one is generated and printed once.
const { getDb } = require('../server/lib/db');
const { hashPassword, randomToken } = require('../server/lib/crypto');
const { nowIso } = require('../server/lib/time');
const { audit } = require('../server/lib/audit');

function createAdmin(username, role = 'admin', password = null, { displayName = null } = {}) {
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username || '')) throw new Error('Username must be 3–50 letters, digits, dot, dash or underscore.');
  if (!['admin', 'editor', 'moderator'].includes(role)) throw new Error('Role must be admin, editor or moderator.');
  const pw = password || randomToken(15);
  if (pw.length < 12) throw new Error('Password must be at least 12 characters.');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE admin_users SET password_hash = ?, role = ?, active = 1 WHERE id = ?').run(hashPassword(pw), role, existing.id);
    audit(null, { action: 'admin_user.reset', entityType: 'admin_user', entityId: existing.id, after: { username, role }, actorLabel: 'cli' });
  } else {
    const r = db.prepare('INSERT INTO admin_users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, displayName, hashPassword(pw), role, nowIso());
    audit(null, { action: 'admin_user.create', entityType: 'admin_user', entityId: r.lastInsertRowid, after: { username, role }, actorLabel: 'cli' });
  }
  return { username, role, password: pw, generated: !password };
}

if (require.main === module) {
  const [username, role = 'admin', password] = process.argv.slice(2);
  try {
    const r = createAdmin(username, role, password);
    console.log(`Admin account ready: ${r.username} (${r.role})`);
    if (r.generated) console.log(`Generated password (shown once): ${r.password}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { createAdmin };
