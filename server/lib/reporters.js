'use strict';
// Community reporters (people who send reports/ratings). Phone numbers are private:
//   * phone_hash  — keyed HMAC (lib/crypto.hashPhone), the lookup key; cannot be reversed without the server key
//   * phone_enc   — AES-256-GCM ciphertext; only the `admin` role may decrypt it, with a reason, audited
//   * phone_last4 — used only to let the reporter open their own status page
// Public display uses `public_alias` ("Community member 4821"): random, non-sequential, unrelated to the number.
// Never put a phone number into a response, log line, audit payload or default export.
const crypto = require('node:crypto');
const { getDb } = require('./db');
const { hashPhone, encryptPhone, decryptPhone, maskPhone } = require('./crypto');
const { nowIso, addDays } = require('./time');

function newAlias(db = getDb()) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const digits = attempt < 6 ? 4 : 6;
    const alias = `Community member ${crypto.randomInt(10 ** (digits - 1), 10 ** digits)}`;
    if (!db.prepare('SELECT 1 FROM reporters WHERE public_alias = ?').get(alias)) return alias;
  }
  return `Community member ${crypto.randomInt(1e7, 1e8)}`;
}

const findByPhone = (e164) => getDb().prepare('SELECT * FROM reporters WHERE phone_hash = ?').get(hashPhone(e164)) || null;
const findById = (id) => getDb().prepare('SELECT * FROM reporters WHERE id = ?').get(id) || null;

/**
 * Create or refresh the reporter for a normalised phone number (called when the person submits with consent).
 * Re-stores the encrypted number if a retention job had erased it. Returns the row plus `isNew`.
 */
function upsertReporter(e164, { verified = false } = {}) {
  const db = getDb();
  const phoneHash = hashPhone(e164);
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM reporters WHERE phone_hash = ?').get(phoneHash);
  if (existing) {
    db.prepare(`UPDATE reporters SET phone_enc = ?, phone_last4 = ?, last_seen_at = ?,
                phone_verified_at = CASE WHEN ? THEN ? ELSE phone_verified_at END WHERE id = ?`)
      .run(encryptPhone(e164), e164.slice(-4), now, verified ? 1 : 0, now, existing.id);
    return { ...findById(existing.id), isNew: false };
  }
  const r = db.prepare(`INSERT INTO reporters (phone_hash, phone_enc, phone_last4, phone_verified_at, public_alias, created_at, last_seen_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(phoneHash, encryptPhone(e164), e164.slice(-4), verified ? now : null, newAlias(db), now, now);
  return { ...findById(Number(r.lastInsertRowid)), isNew: true };
}

function touch(reporterId) {
  getDb().prepare('UPDATE reporters SET last_seen_at = ? WHERE id = ?').run(nowIso(), reporterId);
}

/** Recompute decision counters from the reports themselves, so re-opened decisions stay consistent. */
function recount(reporterId) {
  if (!reporterId) return;
  getDb().prepare(`UPDATE reporters SET
      confirmed_reports = (SELECT COUNT(*) FROM reports WHERE reporter_id = ?1 AND status IN ('confirmed', 'resolved')),
      rejected_reports  = (SELECT COUNT(*) FROM reports WHERE reporter_id = ?1 AND status = 'rejected')
    WHERE id = ?1`).run(reporterId);
}

function reports30d(reporterId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at >= ?')
    .get(reporterId, addDays(nowIso(), -30)).n;
}

/** Moderator-facing summary. Masked phone only (last two digits) — never the number. */
function adminView(row) {
  if (!row) return null;
  return {
    id: row.id,
    alias: row.public_alias,
    phoneMasked: row.phone_last4 ? maskPhone(row.phone_last4) : null,
    contactAvailable: Boolean(row.phone_enc),
    verified: Boolean(row.phone_verified_at),
    verifiedAt: row.phone_verified_at || null,
    confirmedReports: row.confirmed_reports,
    rejectedReports: row.rejected_reports,
    status: row.status,
    statusReason: row.status_reason || null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || null,
    reports30d: reports30d(row.id),
  };
}

/** Decrypt a reporter's number. Callers MUST check `contact:reveal` and audit the reveal with a reason. */
function revealPhone(row) {
  return row && row.phone_enc ? decryptPhone(row.phone_enc) : null;
}

module.exports = { newAlias, findByPhone, findById, upsertReporter, touch, recount, reports30d, adminView, revealPhone };
