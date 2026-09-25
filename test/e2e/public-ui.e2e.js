'use strict';
// Public UI end-to-end check. Run against a server started with DEMO_DATA=1 after `npm run setup`.
// exports run({ browser, baseUrl, screenshotDir, log }) — throws on failure.
const path = require('node:path');

async function run({ browser, baseUrl, screenshotDir, log = console.log }) {
  const assert = (c, m) => { if (!c) throw new Error(`public-ui: ${m}`); };
  const shot = (page, n) => screenshotDir && page.screenshot({ path: path.join(screenshotDir, `public-${n}.png`), fullPage: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // Home + typed area search (gazetteer area with a position).
  await page.goto(`${baseUrl}/?lang=en`);
  assert((await page.textContent('h1')).includes('Find a water filtration plant near you.'), 'hero heading');
  await page.fill('[data-testid=place-input]', 'Jaranwala');
  await page.waitForSelector('[role=option]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.click('[data-testid=btn-search]');
  await page.waitForSelector('[data-testid=card-position]');
  log('typed search → results OK');

  // Map pick → results with demo exact plants.
  await page.goto(`${baseUrl}/?lang=en`);
  await page.click('[data-testid=btn-pick]');
  await page.waitForSelector('.leaflet-container');
  await page.click('[data-testid=btn-center]');
  await page.waitForSelector('[data-testid=chosen-label]');
  await page.click('[data-testid=btn-search]');
  await page.waitForSelector('[data-testid=card-position]');
  await page.click('#seg-group-exact + label').catch(() => {});
  await page.waitForFunction(() => /Plant 1 of \d+/.test(document.querySelector('[data-testid=card-position]').textContent));
  const pos = () => page.textContent('[data-testid=card-position]');
  const code = () => page.getAttribute('.card-body', 'data-code');
  const total = Number((await pos()).match(/of (\d+)/)[1]);
  assert(total >= 2, 'need at least 2 exact demo plants');
  assert(await page.isDisabled('[data-testid=card-prev]'), 'prev disabled at start');
  const first = await code();
  await page.click('[data-testid=card-next]');
  assert((await pos()).startsWith('Plant 2 of'), 'next advances position');
  assert((await code()) !== first, 'card changed');
  await page.click('[data-testid=card-prev]');
  assert((await code()) === first, 'prev restores');
  await page.focus('[data-testid=plant-card]');
  await page.keyboard.press('ArrowRight');
  assert((await pos()).startsWith('Plant 2 of'), 'keyboard right');
  await page.keyboard.press('ArrowLeft');
  assert((await pos()).startsWith('Plant 1 of'), 'keyboard left');
  for (let i = 1; i < total; i++) await page.keyboard.press('ArrowRight');
  assert(await page.isDisabled('[data-testid=card-next]'), 'next disabled at end');
  log('arrows OK');

  // Directions use exact stored coordinates; missing water quality shows Unknown.
  let checkedUnknown = false;
  for (let i = 0; i < total; i++) {
    const c = await code();
    const detail = await (await page.request.get(`${baseUrl}/api/plants/${c}`)).json();
    const href = await page.getAttribute('a[data-testid=directions]', 'href');
    assert(href.includes(`destination=${detail.location.lat},${detail.location.lng}`), `directions coords for ${c}`);
    if (detail.waterQuality.state === 'unknown') {
      assert((await page.textContent('[data-testid=quality-state]')).includes('Unknown'), 'Unknown water quality');
      checkedUnknown = true;
    }
    if (i < total - 1) await page.click('[data-testid=card-prev]');
  }
  assert(checkedUnknown, 'found a plant without water tests');
  await shot(page, 'results-desktop');
  log('directions + Unknown OK');

  // Urdu RTL + mobile.
  const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await m.newPage();
  await mp.goto(`${baseUrl}/?lang=ur`);
  await mp.waitForFunction(() => document.documentElement.dir === 'rtl');
  await shot(mp, 'home-mobile-ur');
  await mp.goto(page.url().replace('lang=en', 'lang=ur'));
  await mp.waitForSelector('[data-testid=card-position]');
  await shot(mp, 'results-mobile-ur');
  await m.close();
  await ctx.close();
  log('Urdu RTL + mobile OK');
}

module.exports = { run };
