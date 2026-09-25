'use strict';
// Vercel serverless entry. Vercel's filesystem is read-only except /tmp, and /tmp is per-instance
// and temporary, so on each cold start the database is rebuilt from the bundled spreadsheet and
// gazetteer. Search and browsing work fully; reports and admin edits last only as long as the
// instance. For durable data, run `npm start` on a host with a persistent disk (see README).
// Only /tmp is writable on Vercel, so ignore any DATA_DIR setting there.
process.env.DATA_DIR = process.env.VERCEL ? '/tmp/teamwater' : process.env.DATA_DIR || '/tmp/teamwater';

const { getDb } = require('../server/lib/db');
const { createApp } = require('../server/app');
const { runSetup } = require('../scripts/setup');

let ready = null;
function init() {
  const empty = getDb().prepare('SELECT COUNT(*) AS n FROM plants').get().n === 0;
  return empty ? runSetup({ quiet: true }) : Promise.resolve();
}

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
  return app(req, res);
};
