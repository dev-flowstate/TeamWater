'use strict';
// One-shot setup: create the database, load the area gazetteer, import the source spreadsheet,
// optionally load clearly-labelled demo data, and make sure an administrator exists.
//   npm run setup
// Env: ADMIN_USERNAME / ADMIN_PASSWORD (optional), SOURCE_XLSX (default: data/source/*.xlsx), DEMO_DATA=1
const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const { getDb } = require('../server/lib/db');
const { loadKeys } = require('../server/lib/crypto');
const { createAdmin } = require('./create-admin');

// The site owner confirmed (outside the spreadsheet) that every plant in a file is operating and its
// data verified. Recorded as a dated verification with the owner as the source; admins can still
// change any plant's status afterwards with a documented assessment.
function applyOwnerConfirmation(db, file, { status = 'operational', verifiedAt, note }) {
  const { audit } = require('../server/lib/audit');
  const { nowIso } = require('../server/lib/time');
  const now = nowIso();
  const r = db.prepare(`UPDATE plants SET status = ?, status_source = 'admin_verified', status_updated_at = ?, status_note = ?,
      last_verified_at = ?, verification_note = ?,
      coord_status = CASE WHEN latitude IS NOT NULL AND coord_status = 'source' THEN 'verified' ELSE coord_status END,
      coord_source = CASE WHEN latitude IS NOT NULL AND coord_status = 'source' THEN 'spreadsheet (confirmed by site owner)' ELSE coord_source END,
      updated_at = ?
    WHERE source_file = ? AND (status_source IN ('none', 'spreadsheet') OR status <> ?)`)
    .run(status, verifiedAt, note, verifiedAt, note, now, file, status);
  if (r.changes) audit(null, { action: 'plant.owner_confirmation', entityType: 'source_file', entityId: file, after: { status, verifiedAt, plants: r.changes }, reason: note, actorLabel: 'site owner (via setup)' });
  return { updated: r.changes };
}

async function runSetup({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  loadKeys();
  const db = getDb();
  log('Database:', config.dbPath);

  // 1. Area gazetteer (approximate area positions + search aliases)
  const gaz = require('../server/lib/gazetteer');
  if (typeof gaz.syncAreasToDb === 'function') log('Gazetteer:', JSON.stringify(gaz.syncAreasToDb()));

  // 2. Source spreadsheet
  const srcDir = path.join(config.root, 'data', 'source');
  const file = process.env.SOURCE_XLSX || fs.readdirSync(srcDir).filter((f) => /\.xlsx$/i.test(f)).map((f) => path.join(srcDir, f))[0];
  const pipeline = require('../server/import/pipeline');
  if (file && typeof pipeline.importFromFile === 'function') {
    const summary = await pipeline.importFromFile({ filePath: file, actorLabel: 'setup' });
    log('Import summary:', JSON.stringify(summary));
  }

  // 2b. Additional owner-supplied files (see data/source/incoming/imports.json)
  const extraCfg = path.join(srcDir, 'incoming', 'imports.json');
  if (fs.existsSync(extraCfg) && typeof pipeline.importFromFile === 'function') {
    for (const item of JSON.parse(fs.readFileSync(extraCfg, 'utf8'))) {
      const summary = await pipeline.importFromFile({ filePath: path.join(srcDir, 'incoming', item.file), sheet: item.sheet, actorLabel: 'setup' });
      log(`Import summary (${item.file}):`, JSON.stringify({ new: summary.new, update: summary.update, rejected: summary.rejected }));
      if (item.ownerConfirmation) log('Owner confirmation:', JSON.stringify(applyOwnerConfirmation(db, item.file, item.ownerConfirmation)));
    }
  }

  // 3. Demonstration data (off by default)
  const demo = require('../server/lib/demo');
  if (typeof demo.syncDemoData === 'function') log('Demo data:', JSON.stringify(demo.syncDemoData(config.demoData)));

  // 4. Administrator
  const count = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  if (count === 0 && quiet && !process.env.ADMIN_PASSWORD) {
    console.warn('[setup] No ADMIN_PASSWORD set — admin account not created.');
  } else if (count === 0) {
    const r = createAdmin(process.env.ADMIN_USERNAME || 'admin', 'admin', process.env.ADMIN_PASSWORD || null);
    log(`Created administrator "${r.username}".`);
    if (r.generated) log(`Generated password (shown once, store it safely): ${r.password}`);
  }
  log('Setup complete.');
}

if (require.main === module) runSetup().catch((err) => { console.error(err); process.exit(1); });

module.exports = { runSetup };
