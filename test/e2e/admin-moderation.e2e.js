'use strict';
// E2E: moderation UI (reports queue, report detail, decisions, photo checklist, reveal-contact).
// Run by test/e2e/run.js against a real server started with DEMO_DATA=1 SMS_PROVIDER=console.
//
//   1. submits 2 reports for DEMO-0001 through POST /api/reports (multipart); the second repeats the first's
//      words (different case/punctuation) so the duplicate-text signal puts it in the review queue
//   2. moderator: queue shows both, "Flagged for review" filter, opens the flagged report, sees risk reasons
//   3. moderator: no "Reveal phone number" control (and the API refuses with 403)
//   4. moderator: records decisions with an internal reason + public note; the timeline updates
//   5. public status API shows the public note and never the internal reason
//   6. admin: reveal requires a reason (dialog blocks an empty reason; API returns 400 without one)
const assert = require('node:assert/strict');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// ── fixtures ──
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Small RGB PNG with a seeded pattern (unique bytes per run, so no duplicate-image signal from older runs). */
function makePng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (40 + x * 2 + seed) & 255; raw[o + 1] = (120 + y * 2) & 255; raw[o + 2] = (180 + ((x + y + seed) % 60)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** 'YYYY-MM-DDTHH:MM' in Asia/Karachi, `hoursAgo` hours before now. */
function karachiLocal(hoursAgo) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() - hoursAgo * 3600e3)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const randomMobile = () => `0300${String(crypto.randomInt(0, 1e7)).padStart(7, '0')}`;

async function submitReport(baseUrl, { phone, description, category, photo }) {
  const fd = new FormData();
  fd.set('plantCode', 'DEMO-0001');
  fd.set('category', category);
  fd.set('description', description);
  fd.set('observedAt', karachiLocal(2));
  fd.set('phone', phone);
  fd.set('consent', 'true');
  fd.set('website', '');
  fd.set('lang', 'en');
  if (photo) fd.append('photos', new Blob([photo], { type: 'image/png' }), 'tap.png');
  const res = await fetch(`${baseUrl}/api/reports`, { method: 'POST', body: fd });
  const body = await res.json().catch(() => ({}));
  assert.equal(res.status, 201, `POST /api/reports → ${res.status} ${JSON.stringify(body)}`);
  assert.match(body.reference, /^TW-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return body.reference;
}

async function signIn(page, baseUrl, { username, password }) {
  await page.goto(`${baseUrl}/admin/`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#app-view').waitFor({ state: 'visible' });
}

/** Admin API call from inside the signed-in browser context (cookie + CSRF from /me). */
async function adminApi(page, method, apiPath, json) {
  return page.evaluate(async ({ method, apiPath, json }) => {
    const me = await (await fetch('/api/admin/me')).json();
    const res = await fetch(`/api/admin${apiPath}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken }, body: json === undefined ? undefined : JSON.stringify(json),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  }, { method, apiPath, json });
}

function watchPage(page, errors) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
}

async function run({ browser, baseUrl, adminCredentials, moderatorCredentials, screenshotDir, log }) {
  const shot = (page, name) => page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
  const token = crypto.randomBytes(3).toString('hex').toUpperCase();

  // ── 1. Two reports; the second repeats the first's words → duplicate-text signal → review queue ──
  const phoneA = randomMobile();
  const phoneB = randomMobile();
  const textA = `No water at the taps since early morning. Families waiting with empty cans near the gate, code ${token}.`;
  const textB = `no water at the taps since early morning!! families waiting with empty cans near the gate -- code ${token}`;
  const refA = await submitReport(baseUrl, { phone: phoneA, description: textA, category: 'no_water', photo: makePng(96, 72, crypto.randomInt(0, 200)) });
  const refB = await submitReport(baseUrl, { phone: phoneB, description: textB, category: 'no_water' });
  log('submitted', refA, refB);

  const errors = [];
  const modCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await modCtx.newPage();
  watchPage(page, errors);
  try {
    // ── 2. Moderator: queue ──
    await signIn(page, baseUrl, moderatorCredentials);
    await page.goto(`${baseUrl}/admin/#/reports`);
    const table = page.locator('table.mod-table--reports');
    await table.waitFor();
    await page.getByText('Risk indicators help prioritise review. They do not prove a report is false.').first().waitFor();
    const rowA = table.locator('tbody tr', { hasText: refA });
    const rowB = table.locator('tbody tr', { hasText: refB });
    await rowA.waitFor();
    await rowB.waitFor();
    assert.ok(await rowB.getByText('Flagged for review').isVisible(), 'duplicate report is flagged for review');
    assert.ok(await rowB.getByText(/high risk|medium risk/i).isVisible(), 'flagged report shows a risk level badge with text');
    await shot(page, '01-queue');

    await page.getByLabel(/Flagged for review only/).check();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await table.locator('tbody tr', { hasText: refB }).waitFor();
    assert.match(page.url(), /queue=1/, 'filters are kept in the address');
    await shot(page, '02-queue-flagged');

    // ── Open the flagged report; risk reasons + similar reports ──
    await table.getByRole('link', { name: refB }).click();
    await page.getByRole('heading', { level: 1, name: new RegExp(refB) }).waitFor();
    const riskPanel = page.locator('section.mod-panel', { has: page.getByRole('heading', { name: 'Risk indicators' }) });
    await riskPanel.locator('.mod-reasons__item').first().waitFor();
    const riskText = await riskPanel.innerText();
    assert.match(riskText, /duplicate text/i, `risk reasons list the duplicate-text signal: ${riskText}`);
    assert.match(riskText, /weight \+\d+/);
    assert.match(riskText, /do not prove a report is false/);
    const similar = page.locator('section.mod-panel', { has: page.getByRole('heading', { name: 'Similar reports' }) });
    await similar.getByRole('link', { name: refA }).waitFor();
    assert.match(await page.locator('.mod-desc').getAttribute('dir'), /auto/);
    assert.ok(await page.getByText('Not shared (not a negative signal)').isVisible());
    assert.ok(await page.getByText(/Confirming a report does not change the plant.s official status/).first().isVisible());

    // ── 3. No reveal for moderators ──
    assert.equal(await page.getByRole('button', { name: /reveal phone number/i }).count(), 0, 'moderator must not see the reveal control');
    const reportId = Number(new URL(page.url()).hash.split('/').pop());
    const denied = await adminApi(page, 'POST', `/reports/${reportId}/reveal-contact`, { reason: 'Trying as moderator' });
    assert.equal(denied.status, 403, 'moderator reveal is refused by the API');
    assert.ok(!JSON.stringify(denied.body).includes(phoneB.slice(-7)), 'no phone digits in the refusal');
    await shot(page, '03-detail-moderator');

    // ── 4. Decisions: start review, then confirm with a public note ──
    const decision = page.locator('form.mod-decision');
    await decision.getByLabel(/Start review/).check();
    await decision.getByRole('button', { name: 'Record decision' }).click();
    await decision.getByText(/Enter the internal reason/).waitFor(); // required reason is enforced and announced
    await decision.getByLabel(/Internal reason/).fill(`E2E internal ${token}: duplicate wording, checking with the attendant`);
    await decision.getByRole('button', { name: 'Record decision' }).click();
    const timeline = page.locator('ol.mod-timeline');
    await timeline.getByText(`E2E internal ${token}: duplicate wording`).waitFor();

    const secret = `E2E-SECRET-${token} attendant confirmed by phone, motor burnt`;
    const publicNote = `E2E public ${token}: we confirmed there was no water at this plant on that morning.`;
    const decision2 = page.locator('form.mod-decision');
    await decision2.getByLabel(/Confirm report/).check();
    await decision2.locator('.mod-notice--warning').filter({ hasText: /does not change the plant.s official status/ }).waitFor();
    await decision2.getByLabel(/Internal reason/).fill(secret);
    await decision2.getByLabel(/Public note/).fill(publicNote);
    assert.equal((await decision2.locator('.mod-preview__note').innerText()).trim(), publicNote, 'live preview shows the public note');
    await shot(page, '04-decision-form');
    await decision2.getByRole('button', { name: 'Record decision' }).click();
    await timeline.getByText(secret).waitFor();
    await timeline.getByText(publicNote).waitFor();
    const lastEvent = timeline.locator('li').last();
    assert.ok(await lastEvent.locator('.mod-tl__note--internal').getByText(secret).isVisible(), 'internal reason shown in the internal block');
    assert.ok(await lastEvent.locator('.mod-tl__note--public').getByText(publicNote).isVisible(), 'public note shown in the public block');
    await page.locator('.mod-head--detail .mod-status--confirmed').waitFor();
    await shot(page, '05-after-decision');

    // Photo checklist gating on report A (an explicit query replaces the remembered "flagged only" filter)
    await page.goto(`${baseUrl}/admin/#/reports?plantCode=DEMO-0001`);
    await table.getByRole('link', { name: refA }).click();
    await page.getByRole('heading', { level: 1, name: new RegExp(refA) }).waitFor();
    const photo = page.locator('figure.mod-photo').first();
    await photo.waitFor();
    assert.ok(await photo.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0), 'photo thumbnail loads through the admin photo URL');
    const makePublic = photo.getByRole('button', { name: /make public/i });
    assert.ok(await makePublic.isDisabled(), 'publishing is disabled until the checklist is complete');
    for (const box of await photo.getByRole('checkbox').all()) await box.check();
    assert.ok(await makePublic.isEnabled());
    await makePublic.click();
    await page.locator('figure.mod-photo .mod-pstatus.is-public').first().waitFor();
    await shot(page, '06-photo-public');

    // ── 5. Public status: public note visible, internal reason never ──
    const statusRes = await fetch(`${baseUrl}/api/reports/status?reference=${encodeURIComponent(refB)}&last4=${phoneB.slice(-4)}`);
    assert.equal(statusRes.status, 200);
    const statusText = await statusRes.text();
    const status = JSON.parse(statusText);
    assert.equal(status.status, 'confirmed');
    assert.ok(status.timeline.some((t) => t.publicNote === publicNote), 'public note is on the public timeline');
    assert.ok(!statusText.includes(`E2E-SECRET-${token}`), 'internal reason must not appear in the public status');
    assert.ok(!statusText.includes(`E2E internal ${token}`), 'internal reason must not appear in the public status');
    log('public status ok:', status.status);
  } finally {
    await modCtx.close();
  }

  // ── 6. Admin: reveal requires a reason ──
  const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const apage = await adminCtx.newPage();
  watchPage(apage, errors);
  try {
    await signIn(apage, baseUrl, adminCredentials);
    await apage.goto(`${baseUrl}/admin/#/reports?plantCode=DEMO-0001`);
    await apage.getByRole('link', { name: refB }).click();
    await apage.getByRole('heading', { level: 1, name: new RegExp(refB) }).waitFor();
    const reveal = apage.getByRole('button', { name: /reveal phone number/i });
    await reveal.waitFor();
    const reportId = Number(new URL(apage.url()).hash.split('/').pop());

    const noReason = await adminApi(apage, 'POST', `/reports/${reportId}/reveal-contact`, {});
    assert.equal(noReason.status, 400, 'API refuses a reveal without a reason');

    await reveal.click();
    const dialog = apage.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Reveal number' }).click();
    await dialog.getByRole('alert').filter({ hasText: /reason/i }).waitFor(); // empty reason blocked
    assert.ok(await dialog.isVisible(), 'dialog stays open without a reason');
    assert.equal(await apage.locator('.mod-revealed__phone').count(), 0, 'no number shown without a reason');
    await shot(apage, '07-reveal-needs-reason');
    await dialog.getByRole('textbox').fill('E2E: need to call the reporter about the confirmed outage');
    await dialog.getByRole('button', { name: 'Reveal number' }).click();
    const shown = apage.locator('.mod-revealed__phone');
    await shown.waitFor();
    assert.ok((await shown.innerText()).replace(/\D/g, '').endsWith(phoneB.slice(-4)), 'revealed number belongs to the reporter');
    await apage.getByRole('button', { name: 'Hide number' }).click();
    assert.equal(await shown.count(), 0, 'number can be hidden again');
    await shot(apage, '08-admin-detail-after-reveal');
  } finally {
    await adminCtx.close();
  }

  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
}

module.exports = { run };
