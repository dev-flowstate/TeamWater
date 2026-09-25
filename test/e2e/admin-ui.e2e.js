'use strict';
// Admin UI (shell + data management) end-to-end checks. Run by test/e2e/run.js after `npm run setup`
// (real spreadsheet import, DEMO_DATA=1). Throws on the first failure.
//
// Covers: sign-in (with a failed attempt), overview counts vs GET /stats, plant FSD-WFP-0001 with its original
// source values, editing the name with a reason and finding it in the audit log, setting coordinates via the
// numeric inputs (then clearing them through the accessible dialog), a status change without an assessment
// being blocked client-side, the import wizard on the real spreadsheet through preview → errors CSV →
// commit (only when it is a no-op) or cancel, and sign-out.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLANT = 'FSD-WFP-0001';
const XLSX = path.resolve(__dirname, '..', '..', 'data', 'source', 'Filter_palnts_in_Faisalabad_1000_1.xlsx');

async function run({ browser, baseUrl, adminCredentials: { username, password }, screenshotDir, log = console.log }) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  let shotNo = 0;
  const shot = async (name) => {
    if (!screenshotDir) return;
    shotNo++;
    await page.screenshot({ path: path.join(screenshotDir, `${String(shotNo).padStart(2, '0')}-${name}.png`) });
  };
  const apiGet = (p) => page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'same-origin' });
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
  }, `/api/admin${p}`);
  const go = async (hash, readySelector) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    if (readySelector) await page.waitForSelector(readySelector, { timeout: 15000 });
  };

  try {
    // ── 1. Sign in ──
    log('sign-in');
    await page.goto(`${baseUrl}/admin/`);
    await page.waitForSelector('#login-form', { state: 'visible' });
    await page.click('#login-submit');
    await page.waitForSelector('#login-error:not([hidden])');
    assert.match(await page.textContent('#login-error'), /username and password/i, 'empty sign-in shows an error');
    await page.fill('#login-username', 'e2e-no-such-user');
    await page.fill('#login-password', 'definitely-wrong-password');
    await page.click('#login-submit');
    // 401 → "incorrect"; after repeated runs the per-username limiter may answer 429 → "Too many … attempts".
    await page.waitForFunction(() => /incorrect|too many/i.test(document.getElementById('login-error').textContent));
    if (/incorrect/i.test(await page.textContent('#login-error'))) {
      assert.equal(await page.getAttribute('#login-password', 'aria-invalid'), 'true', 'password marked invalid');
    }
    await shot('login-error');
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForSelector('#app-view:not([hidden])');
    assert.equal((await page.textContent('#session-name')).trim(), username, 'header shows the signed-in user');
    assert.ok((await page.textContent('#session-role')).trim().length > 0, 'header shows the role');
    assert.ok(await page.isVisible('#signout'), 'sign-out button visible');

    // ── 2. Overview counts ──
    log('overview');
    await go('#/overview', '[data-stat="total"] .stat-value');
    const stats = await apiGet('/stats');
    assert.equal(stats.status, 200);
    const tileNum = async (id) => Number((await page.textContent(`[data-stat="${id}"] .stat-value`)).replace(/[^0-9]/g, ''));
    assert.equal(await tileNum('total'), stats.body.plants.total, 'total tile matches /stats');
    assert.ok(stats.body.plants.total >= 1000, 'real spreadsheet imported');
    assert.equal(await tileNum('exact'), stats.body.plants.location.exact, 'exact-location tile matches /stats');
    assert.match(await page.textContent('.quick-links'), new RegExp(`${stats.body.plants.location.exact} of ${stats.body.plants.total.toLocaleString('en-US')}`), 'exact coordinates quick link');
    await shot('overview');

    // ── 3. Plant FSD-WFP-0001 with source values ──
    log('plant detail + source values');
    await go('#/plants', '.data-table tbody tr');
    await page.fill('input[name="q"]', PLANT);
    await page.click('form[aria-label="Filter plants"] button[type="submit"]');
    await page.waitForSelector(`.data-table a[href="#/plants/${PLANT}"]`);
    await page.click(`.data-table a[href="#/plants/${PLANT}"]`);
    await page.waitForSelector('.compare-table');
    assert.match(await page.textContent('#main h1'), new RegExp(PLANT));
    const detail = await apiGet(`/plants/${PLANT}`);
    const sv = detail.body.sourceValues;
    assert.ok(sv && sv['Plant ID'] === PLANT, 'API has source values');
    const compareText = await page.textContent('.compare-table');
    for (const header of ['Plant ID', 'Town/Tehsil', 'Area/Union Council', 'Operating Entity Type', 'Filtration Technology']) {
      assert.ok(compareText.includes(`“${header}”`), `source column "${header}" shown`);
      assert.ok(compareText.includes(String(sv[header])), `source value for "${header}" shown`);
    }
    await page.click('summary:has-text("Complete original row")');
    const verbatimRows = await page.$$eval('details.expander[open] table tbody tr', (rows) => rows.length);
    assert.equal(verbatimRows, Object.keys(sv).length, 'every original column listed verbatim');
    assert.match(await page.textContent('[data-card="pd-details"]'), /Faisalabad_1000_Water_Filtratio/, 'traceability shows sheet');
    await shot('plant-detail');

    // ── 4. Edit name with a reason → audit log ──
    log('edit name + audit');
    const newName = `E2E test name ${Date.now().toString(36)}`;
    const editForm = 'form[aria-label="Edit plant details"]';
    await page.fill(`${editForm} [name="name"]`, newName);
    await page.click(`${editForm} button[type="submit"]`);
    await page.waitForSelector(`${editForm} .form-error:not([hidden])`);
    assert.match(await page.textContent(`${editForm} .form-error`), /reason/i, 'a reason is required');
    await page.fill(`${editForm} [name="reason"]`, 'E2E: confirmed name on site visit');
    await page.click(`${editForm} button[type="submit"]`);
    await page.waitForFunction((n) => document.querySelector('#main h1')?.textContent.includes(n), newName, { timeout: 15000 });
    assert.match(await page.textContent('[data-card="pd-audit"]'), /plant\.update/, 'plant audit card lists the update');
    await go(`#/audit?entityType=plant&entityId=${PLANT}&action=plant.update`, '.audit-list tbody tr');
    const auditText = await page.textContent('.audit-list');
    assert.ok(auditText.includes('E2E: confirmed name on site visit'), 'audit log shows the reason');
    await page.click('.audit-list tbody tr:first-child summary');
    assert.ok((await page.textContent('.audit-list tbody tr:first-child details')).includes(newName), 'audit diff shows the new name');
    await shot('audit-log');

    // ── 5. Coordinates via numeric inputs ──
    log('coordinates');
    await go(`#/plants/${PLANT}?focus=location`, 'form[aria-label="Set plant coordinates"]');
    const coordForm = 'form[aria-label="Set plant coordinates"]';
    await page.fill(`${coordForm} [name="lat"]`, '31.418123');
    await page.fill(`${coordForm} [name="lng"]`, '73.079456');
    await page.fill(`${coordForm} [name="note"]`, 'E2E: pinned at entrance during site visit');
    await page.click(`${coordForm} button[type="submit"]`);
    await page.waitForFunction(() => /Verified by admin/.test(document.querySelector('[data-card="pd-location"]')?.textContent || ''), null, { timeout: 15000 });
    const located = await apiGet(`/plants/${PLANT}`);
    assert.equal(located.body.plant.coord_status, 'verified');
    assert.equal(located.body.plant.latitude, 31.418123);
    assert.equal(located.body.plant.longitude, 73.079456);
    assert.match(await page.textContent('[data-card="pd-location"]'), /31\.418123/);
    await shot('coordinates-set');
    // Clear them again through the dialog (Esc cancels first; then a reason is required).
    await page.click('[data-card="pd-location"] button:has-text("Clear coordinates")');
    await page.waitForSelector('dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    await page.click('[data-card="pd-location"] button:has-text("Clear coordinates")');
    await page.waitForSelector('dialog[open] textarea[name="reason"]');
    await page.click('dialog[open] button[type="submit"]');
    assert.equal(await page.getAttribute('dialog[open] textarea[name="reason"]', 'aria-invalid'), 'true', 'dialog requires a reason');
    await page.fill('dialog[open] textarea[name="reason"]', 'E2E: test position removed');
    await page.click('dialog[open] button[type="submit"]');
    await page.waitForFunction(() => /No exact location/.test(document.querySelector('[data-card="pd-location"]')?.textContent || ''), null, { timeout: 15000 });

    // ── 6. Status change without an assessment is blocked ──
    log('status change blocked');
    const statusPosts = [];
    const onReq = (r) => { if (r.method() === 'POST' && r.url().includes(`/plants/${PLANT}/status`)) statusPosts.push(r.url()); };
    page.on('request', onReq);
    const statusForm = 'form[aria-label="Change operational status"]';
    await page.selectOption(`${statusForm} [name="status"]`, 'temporarily_closed');
    await page.click(`${statusForm} button[type="submit"]`);
    await page.waitForSelector(`${statusForm} .form-error:not([hidden])`);
    assert.match(await page.textContent(`${statusForm} .form-error`), /assessment/i);
    await page.fill(`${statusForm} [name="assessment"]`, 'too short');
    await page.click(`${statusForm} button[type="submit"]`);
    await page.waitForFunction((sel) => /at least 20 characters/.test(document.querySelector(`${sel} .form-error`).textContent), statusForm);
    assert.equal(await page.getAttribute(`${statusForm} [name="assessment"]`, 'aria-invalid'), 'true');
    page.off('request', onReq);
    assert.equal(statusPosts.length, 0, 'no status request was sent');
    const afterStatus = await apiGet(`/plants/${PLANT}`);
    assert.equal(afterStatus.body.plant.status, detail.body.plant.status, 'status unchanged');
    await page.evaluate(() => document.querySelector('[data-card="pd-status"]').scrollIntoView());
    await shot('status-blocked');

    // Clean up: restore the original (empty) name.
    await go(`#/plants/${PLANT}?focus=edit`, 'form[aria-label="Edit plant details"]');
    await page.fill(`${editForm} [name="name"]`, detail.body.plant.name || '');
    await page.fill(`${editForm} [name="reason"]`, 'E2E: restore original name');
    await page.click(`${editForm} button[type="submit"]`);
    await page.waitForFunction((n) => !document.querySelector('#main h1')?.textContent.includes(n), newName, { timeout: 15000 });
    assert.equal((await apiGet(`/plants/${PLANT}`)).body.plant.name, detail.body.plant.name, 'original name restored');

    // ── 7. Import wizard on the real spreadsheet ──
    log('import wizard');
    await go('#/imports', 'form[aria-label="Upload spreadsheet"]');
    await page.setInputFiles('form[aria-label="Upload spreadsheet"] input[name="file"]', XLSX);
    await page.click('form[aria-label="Upload spreadsheet"] button[type="submit"]');
    await page.waitForSelector('form[aria-label="Choose sheet"]', { timeout: 30000 });
    assert.ok(await page.isChecked('form[aria-label="Choose sheet"] input[value="Faisalabad_1000_Water_Filtratio"]'), 'sheet pre-selected');
    await page.click('form[aria-label="Choose sheet"] button[type="submit"]');
    await page.waitForSelector('form[aria-label="Map columns"]');
    assert.equal(await page.inputValue('select[name="map:plant_code"]'), 'Plant ID', 'Plant ID mapping suggested');
    assert.equal(await page.inputValue('select[name="map:town"]'), 'Town/Tehsil');
    await shot('import-mapping');
    await page.click('form[aria-label="Map columns"] button[type="submit"]');
    await page.waitForSelector('[data-chip="total"]', { timeout: 60000 });
    const chip = async (k) => Number((await page.textContent(`[data-chip="${k}"] .chip-value`)).replace(/[^0-9]/g, ''));
    assert.equal(await chip('total'), 1000, 'preview covers every row');
    assert.equal(await chip('new'), 0, 'no new plants: the file was already imported');
    assert.equal(await chip('rejected'), 0);
    await page.waitForSelector('.wizard table tbody tr');
    await page.selectOption('.wizard select[name="outcome"]', 'unchanged');
    await page.waitForFunction(() => /Unchanged/.test(document.querySelector('.wizard caption')?.textContent || ''));
    await shot('import-preview');

    log('errors CSV');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download validation errors (CSV)")')]);
    assert.match(dl.suggestedFilename(), /\.csv$/);
    const csvPath = await dl.path();
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.ok(csv.split(/\r?\n/)[0].replace(/^﻿/, '').length > 0, 'CSV has a header row');

    const willChange = (await chip('update')) + (await chip('new'));
    if (willChange === 0) {
      log('commit (no-op re-import)');
      await page.click('button:has-text("Commit import")');
      await page.waitForSelector('dialog[open]');
      await page.click('dialog[open] button[type="submit"]');
      await page.waitForSelector('h3:has-text("Import complete")', { timeout: 60000 });
      const doneText = await page.textContent('.wizard');
      assert.ok(doneText.includes('Filter_palnts_in_Faisalabad_1000_1.xlsx'), 'summary shows the source file');
      assert.ok(doneText.includes('Faisalabad_1000_Water_Filtratio'), 'summary shows the sheet');
      assert.match(doneText, /Import date/);
    } else {
      log(`cancel (${willChange} rows would change)`);
      await page.click('.wizard button:has-text("Cancel import")');
      await page.waitForSelector('dialog[open]');
      await page.click('dialog[open] button[type="submit"]');
      await page.waitForSelector('form[aria-label="Upload spreadsheet"]');
    }
    await shot('import-done');

    // ── 8. Sign out ──
    log('sign-out');
    await page.click('#signout');
    await page.waitForSelector('#login-view:not([hidden])');
    assert.match(await page.textContent('#login-status'), /signed out/i);
    assert.equal(await page.isHidden('#app-view'), true);
    assert.equal((await apiGet('/me')).status, 401, 'session ended on the server');
    await shot('signed-out');

    assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
  } catch (err) {
    await shot('failure').catch(() => {});
    throw err;
  } finally {
    await context.close();
  }
}

module.exports = { run };
