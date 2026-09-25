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

async function main() {
  loadKeys();
  const db = getDb();
  console.log('Database:', config.dbPath);

  // 1. Area gazetteer (approximate area positions + search aliases)
  const gaz = require('../server/lib/gazetteer');
  if (typeof gaz.syncAreasToDb === 'function') console.log('Gazetteer:', JSON.stringify(gaz.syncAreasToDb()));

  // 2. Source spreadsheet
  const srcDir = path.join(config.root, 'data', 'source');
  const file = process.env.SOURCE_XLSX || fs.readdirSync(srcDir).filter((f) => /\.xlsx$/i.test(f)).map((f) => path.join(srcDir, f))[0];
  const pipeline = require('../server/import/pipeline');
  if (file && typeof pipeline.importFromFile === 'function') {
    const summary = await pipeline.importFromFile({ filePath: file, actorLabel: 'setup' });
    console.log('Import summary:', JSON.stringify(summary));
  }

  // 3. Demonstration data (off by default)
  const demo = require('../server/lib/demo');
  if (typeof demo.syncDemoData === 'function') console.log('Demo data:', JSON.stringify(demo.syncDemoData(config.demoData)));

  // 4. Administrator
  const count = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  if (count === 0) {
    const r = createAdmin(process.env.ADMIN_USERNAME || 'admin', 'admin', process.env.ADMIN_PASSWORD || null);
    console.log(`Created administrator "${r.username}".`);
    if (r.generated) console.log(`Generated password (shown once, store it safely): ${r.password}`);
  }
  console.log('Setup complete.');
}

main().catch((err) => { console.error(err); process.exit(1); });
