'use strict';
// Report UI end-to-end: /report.html (validation, photo + rating, SMS verification, confirmation),
// /status.html (lookup with last 4 digits, wrong digits), Urdu RTL layout, mobile + desktop screenshots.
// Run: npm run test:e2e -- report-ui   (server runs with DEMO_DATA=1 SMS_PROVIDER=console)
const path = require('node:path');
const zlib = require('node:zlib');

const assert = (cond, msg) => { if (!cond) throw new Error(`report-ui: ${msg}`); };

/** Builds a valid little PNG (w×h, RGB gradient) with correct CRCs — no image libraries needed. */
function makePng(w = 24, h = 16) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 30 + x * 8; raw[o + 1] = 90 + y * 6; raw[o + 2] = 200;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function newPage(browser, viewport, errors) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'Asia/Karachi' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(15000);
  return { context, page };
}

async function noHorizontalScroll(page, label) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert(sw <= iw + 1, `${label}: page scrolls horizontally (${sw} > ${iw})`);
}

async function run({ browser, baseUrl, screenshotDir, log = console.log }) {
  const shot = (page, name, fullPage = true) => page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage });
  const errors = [];
  const phoneDigits = String(Math.floor(1000000 + Math.random() * 8999999));
  const phone = `0300-${phoneDigits}`;
  const last4 = phoneDigits.slice(-4);
  const wrongLast4 = last4 === '0000' ? '1111' : '0000';

  // ───────── Desktop, English: validation ─────────
  const desk = await newPage(browser, { width: 1280, height: 900 }, errors);
  let page = desk.page;
  await page.goto(`${baseUrl}/report.html?plant=DEMO-0001&lang=en`);
  await page.waitForSelector('#report-form:not([hidden])');
  await page.waitForSelector('#category-options input[value="no_water"]', { state: 'attached' });
  assert((await page.textContent('#plant-body')).includes('DEMO-0001'), 'plant card shows the plant ID');
  const obs = await page.evaluate(() => ({ d: document.getElementById('observed-date').value, t: document.getElementById('observed-time').value }));
  assert(/^\d{4}-\d{2}-\d{2}$/.test(obs.d) && /^\d{2}:\d{2}$/.test(obs.t), 'observed date/time default to now');
  assert(await page.getAttribute('#website', 'tabindex') === '-1', 'honeypot is out of the tab order');
  await shot(page, 'desktop-en-form');

  await page.click('#submit-btn');
  await page.waitForSelector('#error-summary:not([hidden])');
  assert(await page.evaluate(() => document.activeElement && document.activeElement.id === 'error-summary'), 'focus moves to the error summary');
  const summary = await page.$$eval('#error-summary li a', (as) => as.map((a) => a.textContent));
  log('validation errors:', summary.join(' | '));
  assert(summary.length >= 4, `expected ≥4 errors (category, description, phone, consent), got ${summary.length}`);
  for (const id of ['description', 'phone', 'consent']) {
    assert(await page.getAttribute(`#${id}`, 'aria-invalid') === 'true', `#${id} has aria-invalid`);
    assert((await page.getAttribute(`#${id}`, 'aria-describedby') || '').includes(`${id}-error`), `#${id} is described by its error`);
  }
  await shot(page, 'desktop-en-errors', false);
  await page.click('#error-summary li:first-child a');
  assert(await page.evaluate(() => document.activeElement.name === 'category'), 'summary link focuses the category radio group');

  // Bad phone + non-image file → client-side errors.
  await page.fill('#phone', '12345');
  await page.setInputFiles('#photos', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForSelector('#photos-error:not([hidden])');
  assert((await page.textContent('#photos-error')).includes('notes.txt'), 'rejected file is named in the photo error');
  assert(await page.$$eval('#photo-list li', (l) => l.length) === 0, 'rejected file is not added');

  // ───────── Fill in a valid report ─────────
  await page.check('#cat-no_water', { force: true });
  await page.fill('#description', 'E2E: the taps were dry around noon and the attendant said the pump had failed.');
  await page.fill('#phone', phone);
  await page.check('#consent', { force: true });
  await page.check('#stars input[value="4"]', { force: true });
  assert((await page.textContent('#rating-text')).includes('4'), 'rating label reflects 4 stars');
  await page.setInputFiles('#photos', { name: 'tap.png', mimeType: 'image/png', buffer: makePng() });
  await page.waitForSelector('#photo-list li img');
  assert(await page.$$eval('#photo-list li', (l) => l.length) === 1, 'one photo preview shown');
  assert((await page.textContent('#photo-status')).includes('tap.png'), 'photo addition announced in live region');

  // Phone verification (console SMS returns devCode outside production).
  const smsEnabled = await page.isVisible('#verify-send');
  if (smsEnabled) {
    const [startRes] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/verify/start')), page.click('#verify-send')]);
    const start = await startRes.json();
    assert(start.sent, 'verification code sent');
    await page.waitForSelector('#verify-code-row:not([hidden])');
    if (start.devCode) {
      await page.fill('#verify-code', start.devCode === '000000' ? '111111' : '000000');
      await page.click('#verify-confirm');
      await page.waitForSelector('#code-error:not([hidden])');
      log('wrong code rejected:', (await page.textContent('#code-error')).trim());
      await page.fill('#verify-code', start.devCode);
      await page.click('#verify-confirm');
      await page.waitForSelector('#verify-done:not([hidden])');
      log('phone verified');
    }
  } else {
    assert(await page.isVisible('#verify-disabled'), 'SMS-disabled explanation shown');
  }
  await page.fill('#observed-date', '2099-01-01');
  await page.click('#submit-btn');
  await page.waitForSelector('#observed-error:not([hidden])');
  assert(/future/i.test(await page.textContent('#observed-error')), 'future observation date rejected');
  await page.fill('#observed-date', obs.d);
  await shot(page, 'desktop-en-filled');

  const [reportRes] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/reports') && r.request().method() === 'POST'),
    page.click('#submit-btn'),
  ]);
  const report = await reportRes.json();
  assert(reportRes.status() === 201, `report accepted (got ${reportRes.status()}: ${JSON.stringify(report)})`);
  await page.waitForSelector('#confirmation:not([hidden])');
  const reference = (await page.textContent('#done-ref')).trim();
  assert(/^TW-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(reference), `reference shown (${reference})`);
  assert(report.ratingRecorded === true, 'rating recorded separately');
  assert(report.photoCount === undefined || report.photoCount === 1, 'photo stored');
  assert(await page.evaluate(() => document.activeElement.id === 'confirmation'), 'focus moves to the confirmation');
  assert((await page.textContent('#done-status')).includes('Pending review'), 'confirmation shows Pending review');
  assert((await page.getAttribute('#done-status-link', 'href')).includes(reference), 'status link carries the reference');
  log('report reference', reference, 'verified:', report.phoneVerified);
  await shot(page, 'desktop-en-confirmation');

  // ───────── Status lookup ─────────
  await page.goto(`${baseUrl}/status.html?ref=${reference}&lang=en`);
  await page.waitForSelector('#lookup-form');
  assert(await page.inputValue('#lookup-ref') === reference, 'reference prefilled from ?ref=');
  await page.fill('#lookup-last4', wrongLast4);
  await page.click('#lookup-submit');
  await page.waitForSelector('#lookup-summary:not([hidden])');
  assert(/couldn't find/i.test(await page.textContent('#lookup-summary')), 'wrong last4 fails with a clear message');
  assert(await page.isHidden('#result'), 'no result for wrong last4');
  await shot(page, 'desktop-en-status-wrong', false);
  await page.fill('#lookup-last4', last4);
  await page.click('#lookup-submit');
  await page.waitForSelector('#result:not([hidden])');
  assert((await page.textContent('#result-badge')).includes('Pending review'), 'status badge shows Pending review');
  assert((await page.textContent('#result-meta')).includes('DEMO-0001'), 'status shows the plant');
  assert((await page.textContent('#result-meta')).includes('No water available'), 'status shows the category');
  assert(await page.$$eval('#result-timeline li', (l) => l.length) >= 1, 'timeline has entries');
  await shot(page, 'desktop-en-status');
  await desk.context.close();

  // ───────── Mobile, English ─────────
  const mob = await newPage(browser, { width: 390, height: 844 }, errors);
  page = mob.page;
  await page.goto(`${baseUrl}/report.html?plant=DEMO-0002&lang=en`);
  await page.waitForSelector('#report-form:not([hidden])');
  await noHorizontalScroll(page, 'mobile report (en)');
  const tooSmall = await page.$$eval('#report-form button:not([hidden]), #report-form .twr-choice-box, .twr-star', (els) => els
    .filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()).filter((r) => r.height < 44 || r.width < 44).length);
  assert(tooSmall === 0, `${tooSmall} touch targets are smaller than 44px`);
  await shot(page, 'mobile-en-form');
  await page.goto(`${baseUrl}/report.html?plant=NOPE-9999&lang=en`);
  await page.waitForSelector('#plant-error:not([hidden])');
  assert(await page.isVisible('#plant-error a[href="/"]'), 'unknown plant shows a link back to search');
  await shot(page, 'mobile-en-unknown-plant', false);
  await mob.context.close();

  // ───────── Mobile, Urdu (RTL) ─────────
  const ur = await newPage(browser, { width: 390, height: 844 }, errors);
  page = ur.page;
  await page.goto(`${baseUrl}/report.html?plant=DEMO-0001&lang=ur`);
  await page.waitForSelector('#report-form:not([hidden])');
  const doc = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang, title: document.getElementById('page-title').textContent }));
  assert(doc.dir === 'rtl' && doc.lang === 'ur', 'Urdu sets dir=rtl and lang=ur');
  assert(/[؀-ۿ]/.test(doc.title), 'page heading is in Urdu');
  assert(await page.getAttribute('#phone', 'dir') === 'ltr', 'phone input stays LTR in Urdu');
  const rtlOrder = await page.evaluate(() => {
    const legend = document.querySelector('#category-group legend');
    const step = legend.querySelector('.twr-step').getBoundingClientRect();
    const text = legend.querySelector('[data-i18n]').getBoundingClientRect();
    return step.left > text.left;
  });
  assert(rtlOrder, 'RTL: step number sits to the right of its heading');
  assert(!/[۰-۹٠-٩]/.test(await page.textContent('#description-counter')), 'Western digits in Urdu');
  await noHorizontalScroll(page, 'mobile report (ur)');
  await shot(page, 'mobile-ur-form');
  await page.click('#submit-btn');
  await page.waitForSelector('#error-summary:not([hidden])');
  assert(/[؀-ۿ]/.test(await page.textContent('#error-summary')), 'errors are in Urdu');
  await shot(page, 'mobile-ur-errors', false);
  await page.goto(`${baseUrl}/status.html?ref=${reference}&lang=ur`);
  await page.fill('#lookup-last4', last4);
  await page.click('#lookup-submit');
  await page.waitForSelector('#result:not([hidden])');
  await noHorizontalScroll(page, 'mobile status (ur)');
  await shot(page, 'mobile-ur-status');
  await ur.context.close();

  // ───────── Desktop, Urdu: appeal form ─────────
  const urDesk = await newPage(browser, { width: 1280, height: 900 }, errors);
  page = urDesk.page;
  await page.goto(`${baseUrl}/status.html?lang=ur#appeal`);
  await page.waitForSelector('#ap-kinds input', { state: 'attached' });
  await page.click('label:has(#ap-kind-correction)');
  assert(await page.isChecked('#ap-kind-correction'), 'appeal kind selectable by its card');
  await page.waitForSelector('#ap-plant-field:not([hidden])');
  await page.fill('#ap-plant', 'DEMO-0001');
  await page.fill('#ap-phone', phone);
  await page.fill('#ap-message', 'E2E: the listed area for this demo plant looks wrong.');
  await page.click('#ap-submit');
  await page.waitForSelector('#ap-done:not([hidden])');
  assert(/^AP-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test((await page.textContent('#ap-done-ref')).trim()), 'appeal reference shown');
  await shot(page, 'desktop-ur-appeal');
  await urDesk.context.close();

  assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
  log('all report UI checks passed');
}

module.exports = { run };
