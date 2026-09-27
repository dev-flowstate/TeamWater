'use strict';
// Vercel serverless entry. Vercel's filesystem is read-only except /tmp, and /tmp is per-instance and temporary.
// Without Firebase, each cold start rebuilds the database from the bundled spreadsheets and gazetteer, so reports
// and admin edits last only as long as the instance. With FIREBASE_DATABASE_URL and FIREBASE_SERVICE_ACCOUNT set
// (server/lib/persist.js), the database and uploads are restored on start, kept in step across instances, and
// saved after every successful change.
// Only /tmp is writable on Vercel, so ignore any DATA_DIR setting there.
process.env.DATA_DIR = process.env.VERCEL ? '/tmp/teamwater' : process.env.DATA_DIR || '/tmp/teamwater';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../server/config');
const { getDb } = require('../server/lib/db');
const { createApp } = require('../server/app');
const { runSetup } = require('../scripts/setup');
const persist = require('../server/lib/persist');

// Fingerprint of the bundled data; setup re-runs on a restored database only when it changes (a new deploy).
function dataVersion() {
  const files = [path.join(config.root, 'data', 'gazetteer', 'faisalabad.json')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(xlsx|csv|json)$/i.test(e.name)) files.push(abs);
    }
  };
  walk(path.join(config.root, 'data', 'source'));
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) h.update(path.relative(config.root, f)).update(fs.readFileSync(f));
  return h.digest('hex');
}

let ready = null;
async function init() {
  const restored = persist.enabled() ? await persist.restore() : false;
  const db = getDb();
  const version = dataVersion();
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'data_version'").get();
  const empty = db.prepare('SELECT COUNT(*) AS n FROM plants').get().n === 0;
  if (empty || (restored && (!stored || stored.value !== version))) {
    await runSetup({ quiet: true });
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('data_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(version);
    if (persist.enabled()) await persist.save();
  }
}

// Hot public reads that never depend on reports or admin edits skip the cross-instance check.
const NO_SYNC = /^\/api\/(config|search|geocode|reverse|route)(\/|\?|$)|^\/api\/plants(\?|$)/;
const needsSync = (req) => req.url.startsWith('/api/') && !(req.method === 'GET' && NO_SYNC.test(req.url));

const app = createApp();

module.exports = async (req, res) => {
  try {
    ready = ready || init();
    await ready;
  } catch (err) {
    ready = null;
    console.error('[vercel] setup failed', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: { code: 'starting', message: 'The service is starting. Please retry in a moment.' } }));
  }
  if (!persist.enabled() || !needsSync(req)) return app(req, res);

  const release = await persist.lock();
  const timer = setTimeout(release, 30e3); // never hold the lock if a request hangs
  try { await persist.sync(); } catch (err) { console.error('[persist] sync failed', err); }
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const end = res.end;
  res.end = function endAfterSave(...args) {
    const finish = () => { clearTimeout(timer); end.apply(res, args); release(); };
    if (mutating && res.statusCode < 400) persist.save().catch((err) => console.error('[persist] save failed', err)).finally(finish);
    else finish();
    return res;
  };
  return app(req, res);
};
