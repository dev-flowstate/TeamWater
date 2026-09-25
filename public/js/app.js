// Page entry for the public site (index, about, privacy). No inline scripts (CSP).
//   <body data-page="home|about|privacy">  <script type="module" src="/js/app.js"></script>
// Heavy modules (results, card, map, diagram, animation) are loaded on demand.
import { initI18n, t, formatNumber, formatDate, onLangChange } from '/js/i18n.js';
import { renderShell } from '/js/shell.js';
import { guardImages, h, icon } from '/js/util.js';

const page = document.body.dataset.page || 'home';

// Used only if /api/config is unreachable, so the map can still frame Faisalabad (no data is invented).
const FALLBACK_CONFIG = {
  map: { provider: 'osm', providerName: 'OpenStreetMap', tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19, bounds: [[30.75, 72.6], [31.85, 73.65]], center: [31.418, 73.079], defaultZoom: 11 },
  routing: { provider: 'none', modes: { driving: false, walking: false } },
  stats: null,
};

async function main() {
  await initI18n(page === 'home' ? ['search'] : ['about']);
  const shellP = renderShell({ active: page === 'home' ? 'find' : page });
  guardImages();
  const { config } = await shellP;
  if (page === 'home') return home(config);
  if (page === 'about') return about(config);
  return null;
}

/* ─────────── Home: search ⇄ results (URL state) ─────────── */

async function home(config) {
  const { readState, writeState, isResultsState, onStateChange } = await import('/js/state.js');
  const homeView = document.getElementById('home-view');
  const resultsView = document.getElementById('results-view');
  const cfg = config || FALLBACK_CONFIG;

  if (!config) {
    const banner = h('div', { class: 'notice notice-warn page-notice', role: 'alert', 'data-testid': 'config-error' }, icon('alert'),
      h('div', {}, h('p', { class: 'notice-title' }, t('search.error.title')), h('p', {}, t('search.error.configDown'))),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => location.reload() } }, icon('refresh'), t('common.retry')));
    document.getElementById('main').prepend(banner);
  }

  let results = null;
  const { initSearch } = await import('/js/search.js');
  const search = initSearch({
    config: cfg,
    onSubmit: ({ lat, lng, label }) => go({ lat, lng, label, area: null, town: null }),
    onAreaList: ({ areaId, town, label }) => go(town
      ? { lat: null, lng: null, area: null, town, label }
      : { lat: null, lng: null, area: String(areaId), town: null, label }),
  });

  function go(loc) {
    const cur = readState();
    const next = { ...cur, ...loc, plant: null, group: null, view: 'map' };
    writeState(next);
    route(next, { focus: true });
  }

  async function route(state, { focus = false } = {}) {
    if (isResultsState(state)) {
      homeView.hidden = true;
      resultsView.hidden = false;
      document.body.classList.add('is-results');
      if (!results) {
        const { mountResults } = await import('/js/results.js');
        results = mountResults(resultsView, {
          config: cfg,
          onChangeLocation: () => {
            const s = readState();
            writeState({ lat: null, lng: null, area: null, town: null, label: null, sort: s.sort, mode: s.mode, view: 'map' });
            route(readState(), { focus: true, fromResults: s });
          },
        });
      }
      await results.update(state);
      if (focus) { window.scrollTo({ top: 0 }); results.focusTitle(); }
    } else {
      resultsView.hidden = true;
      homeView.hidden = false;
      document.body.classList.remove('is-results');
      if (focus) { window.scrollTo({ top: 0 }); search.focus(); }
    }
    document.title = isResultsState(state) ? t('search.meta.titleResults') : t('search.meta.title');
  }

  onStateChange((s) => route(s));
  onLangChange(() => { document.title = isResultsState(readState()) ? t('search.meta.titleResults') : t('search.meta.title'); });
  await route(readState());
}

/* ─────────── About: live figures from /api/config ─────────── */

function about(config) {
  const fill = () => {
    const s = config?.stats;
    const m = config?.map;
    const set = (key, text) => document.querySelectorAll(`[data-stat="${key}"]`).forEach((el) => { el.textContent = text; });
    const na = t('about.stats.unavailable');
    set('plantsTotal', s ? formatNumber(s.plantsTotal) : na);
    set('plantsExact', s ? formatNumber(s.plantsExact) : na);
    set('plantsArea', s ? formatNumber(s.plantsArea) : na);
    set('plantsNoLocation', s ? formatNumber(s.plantsNoLocation) : na);
    set('sourceFile', s?.sourceFile || na);
    set('lastImportAt', s?.lastImportAt ? formatDate(s.lastImportAt, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : na);
    set('providerName', m?.providerName || na);
    set('coverageNote', m?.coverageNote || t('about.map.coverageDefault'));
    set('updatedNote', m?.updatedNote || t('about.map.updatedDefault'));
    const attr = document.querySelector('[data-stat="attribution"]');
    if (attr) {
      import('/js/util.js').then(({ safeAttribution }) => attr.replaceChildren(m?.attribution ? safeAttribution(m.attribution) : na));
    }
    const demo = document.getElementById('demo-note');
    if (demo) demo.hidden = !config?.demoMode;
  };
  fill();
  onLangChange(fill);
}

main().catch((err) => {
  console.error('[app] failed to start', err);
});
