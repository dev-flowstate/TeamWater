'use strict';
// End-to-end runner. Seeds a throw-away database (real spreadsheet import + clearly labelled demo
// plants), starts the server, launches Chromium and runs every test/e2e/*.e2e.js module.
//
//   npm run test:e2e                 # all suites
//   npm run test:e2e -- public-ui    # suites whose filename contains "public-ui"
//
// Each suite exports: async function run({ browser, baseUrl, adminCredentials, moderatorCredentials, screenshotDir, log })
// and throws on failure. Screenshots are written to test-results/e2e/<suite>/.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const filter = process.argv[2] || '';

const adminCredentials = { username: 'e2e-admin', password: 'e2e-admin-password-123' };
const moderatorCredentials = { username: 'e2e-moderator', password: 'e2e-moderator-password-123' };

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-e2e-'));
  const port = Number(process.env.E2E_PORT || 3990);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    PORT: String(port),
    DEMO_DATA: '1',
    SMS_PROVIDER: 'console',
    GEOCODER_PROVIDER: process.env.GEOCODER_PROVIDER || 'none',
    ROUTING_PROVIDER: process.env.ROUTING_PROVIDER || 'none',
    ADMIN_USERNAME: adminCredentials.username,
    ADMIN_PASSWORD: adminCredentials.password,
  };
  const node = [process.execPath, '--disable-warning=ExperimentalWarning'];

  console.log('▶ seeding', dataDir);
  const setup = spawnSync(node[0], [node[1], 'scripts/setup.js'], { cwd: ROOT, env, encoding: 'utf8' });
  process.stdout.write(setup.stdout || '');
  if (setup.status !== 0) { process.stderr.write(setup.stderr || ''); throw new Error('setup failed'); }
  const mod = spawnSync(node[0], [node[1], 'scripts/create-admin.js', moderatorCredentials.username, 'moderator', moderatorCredentials.password], { cwd: ROOT, env, encoding: 'utf8' });
  if (mod.status !== 0) throw new Error('could not create moderator: ' + mod.stderr);

  console.log('▶ starting server on', port);
  const server = spawn(node[0], [node[1], 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const baseUrl = `http://127.0.0.1:${port}`;

  const { chromium } = require('playwright-core');
  let browser;
  const results = [];
  try {
    await waitFor(`${baseUrl}/api/config`);
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.e2e.js') && f.includes(filter)).sort();
    if (!suites.length) console.log('No suites matched', filter || '(all)');
    for (const file of suites) {
      const name = file.replace(/\.e2e\.js$/, '');
      const screenshotDir = path.join(ROOT, 'test-results', 'e2e', name);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const started = Date.now();
      const log = (...a) => console.log(`   [${name}]`, ...a);
      try {
        await require(path.join(__dirname, file)).run({ browser, baseUrl, adminCredentials, moderatorCredentials, screenshotDir, log });
        results.push({ name, ok: true, ms: Date.now() - started });
        console.log(`✔ ${name} (${Date.now() - started} ms)`);
      } catch (err) {
        results.push({ name, ok: false, ms: Date.now() - started, err });
        console.log(`✘ ${name}: ${err && err.stack ? err.stack : err}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    if (process.env.E2E_KEEP_DATA !== '1') fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} e2e suites passed`);
  if (failed.length && process.env.E2E_SERVER_LOG === '1') console.log('--- server log ---\n' + serverLog);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
