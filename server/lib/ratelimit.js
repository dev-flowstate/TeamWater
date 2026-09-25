'use strict';
// DB-backed sliding-window rate limiting. Subjects are hashed by the caller (lib/crypto.hashSubject).
//   const r = rateCheck('report:ip', subjectHash, { windowMs: 3600e3, max: 5 });
//   if (!r.allowed) throw new HttpError(429, 'rate_limited', '...', { retryAfterSec: r.retryAfterSec });
//   rateRecord('report:ip', subjectHash);   // record after a successful action
//   rateCount('report:burst:plant:12', 'all', 3600e3)  // counts for burst detection
const { getDb } = require('./db');

function rateCount(bucket, subject, windowMs) {
  const since = Date.now() - windowMs;
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND subject = ? AND created_at > ?')
    .get(bucket, subject, since).n;
}

function rateCheck(bucket, subject, { windowMs, max }) {
  const since = Date.now() - windowMs;
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM rate_events WHERE bucket = ? AND subject = ? AND created_at > ?')
    .get(bucket, subject, since);
  if (row.n < max) return { allowed: true, remaining: max - row.n - 1, retryAfterSec: 0 };
  return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((row.oldest + windowMs - Date.now()) / 1000)) };
}

function rateRecord(bucket, subject) {
  getDb().prepare('INSERT INTO rate_events (bucket, subject, created_at) VALUES (?, ?, ?)').run(bucket, subject, Date.now());
}

function ratePurge(olderThanMs) {
  getDb().prepare('DELETE FROM rate_events WHERE created_at < ?').run(Date.now() - olderThanMs);
}

module.exports = { rateCheck, rateRecord, rateCount, ratePurge };
