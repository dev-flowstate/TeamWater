'use strict';
// Attributable, timestamped audit trail for important changes.
//   audit(req, { action: 'plant.update', entityType: 'plant', entityId: plant.plant_code,
//                before, after, reason })
// `req` may be null for CLI/system actions (actor_label 'system' unless opts.actorLabel given).
// Never put raw phone numbers or other private contact data in before/after.
const { getDb } = require('./db');
const { nowIso } = require('./time');

function audit(req, { action, entityType, entityId = null, before = null, after = null, reason = null, actorLabel = null }) {
  const user = req && req.user;
  getDb()
    .prepare(`INSERT INTO audit_log (actor_user_id, actor_label, action, entity_type, entity_id, before_json, after_json, reason, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      user ? user.id : null,
      user ? user.username : actorLabel || 'system',
      action,
      entityType,
      entityId === null ? null : String(entityId),
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
      nowIso(),
    );
}

/** Returns only the keys whose values differ — keeps audit entries small and readable. */
function diff(before, after) {
  const b = {}, a = {};
  for (const k of Object.keys(after || {})) {
    const bv = before ? before[k] : undefined;
    if (JSON.stringify(bv) !== JSON.stringify(after[k])) { b[k] = bv === undefined ? null : bv; a[k] = after[k]; }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

module.exports = { audit, diff };
