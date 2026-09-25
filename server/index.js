'use strict';
const config = require('./config');
const { getDb } = require('./lib/db');
const { loadKeys } = require('./lib/crypto');
const { createApp } = require('./app');
const { runRetention } = require('./lib/retention');

loadKeys(); // fail fast if production secrets are missing
getDb(); // opens + applies schema

// Demo plants exist only while DEMO_DATA=1; turning it off removes them on the next start.
const demo = require('./lib/demo');
if (typeof demo.syncDemoData === 'function') console.log('[demo]', JSON.stringify(demo.syncDemoData(config.demoData)));

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Team Water listening on http://localhost:${config.port} (${config.env})`);
  if (config.demoData) console.log('DEMO_DATA is ON — demonstration plants are visible and labelled.');
});

const DAY = 24 * 3600e3;
const retention = () => {
  try { console.log('[retention]', JSON.stringify(runRetention())); } catch (err) { console.error('[retention] failed', err); }
};
setTimeout(retention, 30e3).unref();
setInterval(retention, DAY).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

module.exports = server;
