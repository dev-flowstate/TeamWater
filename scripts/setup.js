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
