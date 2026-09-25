'use strict';
// Data-retention job (owned by the reports/moderation workstream). Called daily by server/index.js and by
// POST /api/admin/maintenance/retention. Idempotent: a second run immediately after the first changes nothing.
//   1. Reports past `retention_until` (created_at + config.retention.reportDays): text and reporter replies
//      redacted, photos deleted from disk and database, `redacted_at` set. Status and category are kept so
//      aggregate history stays meaningful.
//   2. Reporters inactive for config.retention.contactDays: encrypted phone number erased (the keyed hash and
//      last 4 digits stay so rate limits keep working and the reporter can still open their status page).
//   3. rate_events older than config.retention.rateEventHours purged.
//   4. Expired phone_verifications deleted.
// Returns counts only — never any personal data.
const config = require('../config');
const { getDb, tx } = require('./db');
const { audit } = require('./audit');
const { nowIso, addDays } = require('./time');
const images = require('./images');
const { redactReports } = require('./moderation');

const RETENTION_TEXT = '[redacted: retention period ended]';

function runRetention({ now = new Date() } = {}) {
  const nowStr = now.toISOString();
  const { paths, counts } = tx((db) => {
    const due = db.prepare('SELECT id FROM reports WHERE redacted_at IS NULL AND retention_until IS NOT NULL AND retention_until <= ?')
      .all(nowStr).map((r) => r.id);
    const red = redactReports(db, due, RETENTION_TEXT);

    const inactiveBefore = addDays(nowStr, -config.retention.contactDays);
    const contactsErased = Number(db.prepare(`UPDATE reporters SET phone_enc = NULL
                                              WHERE phone_enc IS NOT NULL AND COALESCE(last_seen_at, created_at) < ?`).run(inactiveBefore).changes);

    const rateCutoff = now.getTime() - config.retention.rateEventHours * 3600e3;
    const rateEventsPurged = Number(db.prepare('DELETE FROM rate_events WHERE created_at < ?').run(rateCutoff).changes);

    const verificationsDeleted = Number(db.prepare('DELETE FROM phone_verifications WHERE expires_at < ?').run(nowStr).changes);

    return {
      paths: red.paths,
      counts: { reportsRedacted: red.reportsRedacted, photosDeleted: red.photosDeleted, contactsErased, rateEventsPurged, verificationsDeleted },
    };
  });
  let filesRemoved = 0;
  for (const p of paths) if (images.deleteStoredFile(p)) filesRemoved++;
  const result = { ...counts, filesRemoved, ranAt: nowIso() };
  if (counts.reportsRedacted || counts.photosDeleted || counts.contactsErased) {
    audit(null, { action: 'retention.run', entityType: 'system', entityId: 'retention', after: counts, actorLabel: 'system' });
  }
  getDb().prepare("INSERT INTO meta (key, value) VALUES ('retention_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(result));
  return result;
}

module.exports = { runRetention, RETENTION_TEXT };
