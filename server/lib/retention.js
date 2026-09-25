'use strict';
// Data-retention job (owned by the reports/moderation workstream). Called daily by server/index.js.
// Must: redact report text/photos past retention_until, erase reporter phone_enc after
// config.retention.contactDays of inactivity, purge old rate_events. Must be idempotent.
function runRetention() {
  return { skipped: true };
}

module.exports = { runRetention };
