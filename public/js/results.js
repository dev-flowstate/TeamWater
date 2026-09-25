// Results view: location header, group/sort/mode/filter controls, map (lazy), text list, and one prominent
// plant card with next/previous navigation. The ranking is kept stable until location, filters, sort or mode change.
//   const r = mountResults(rootEl, { config, onChangeLocation });  r.update(readState());
import { t, getLang, isRtl, onLangChange, formatNumber } from '/js/i18n.js';
import { getJSON, isAbort } from '/js/api.js';
import { h, clear, icon, announce, formatDistance, prefersReducedMotion, nextArrow, prevArrow } from '/js/util.js';
import { writeState, sameQuery } from '/js/state.js';
import { renderCard, plantName, statusInfo, statusShort, methodLabel, recommendationText } from '/js/card.js';

const SEARCH_LIMIT = 50;

let animePromise = null;
function loadAnime() {
  if (prefersReducedMotion()) return Promise.resolve(null);
  if (!animePromise) animePromise = import('/vendor/animejs/anime.esm.min.js').catch(() => null);
  return animePromise;
}

export function mountResults(root, { config, onChangeLocation }) {
  const ctx = {
    state: null, data: null, mode: 'search', // 'search' | 'arealist'
    group: 'area', list: [], index: -1,
    label: null, labelKind: null,
    map: null, mapPromise: null, mapFailed: false, tileFailed: false, fitted: false,
    detail: new Map(), routes: new Map(), card: null,
    facets: { technology: new Set(), operatorType: new Set() },
    ctrl: null, routeCtrl: null, loadSeq: 0, error: null, loading: false,
    sheetExpanded: false, filtersOpen: false,
  };

  // Persistent nodes (survive re-renders and language changes)
  const mapEl = h('div', { class: 'results-map', id: 'results-map', role: 'region', 'data-testid': 'results-map' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true', id: 'results-live' });
  const cardBody = h('div', { class: 'card-stage' });
  const prevBtn = h('button', { type: 'button', class: 'arrow-btn arrow-prev', 'data-testid': 'card-prev' });
  const nextBtn = h('button', { type: 'button', class: 'arrow-btn arrow-next', 'data-testid': 'card-next' });
  const position = h('p', { class: 'card-position', 'data-testid': 'card-position' });
  const cardRegion = h('section', { class: 'plant-card', tabindex: '0', 'aria-keyshortcuts': 'ArrowLeft ArrowRight', 'data-testid': 'plant-card' },
    h('div', { class: 'card-nav' }, prevBtn, position, nextBtn), cardBody);

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  cardRegion.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    const forward = (e.key === 'ArrowRight') !== isRtl(); // mirrored in RTL: ← is "next" in Urdu
    step(forward ? 1 : -1, { keyboard: true });
  });

  root.replaceChildren();
  const shell = h('section', { class: 'results', 'aria-labelledby': 'results-title' });
  root.append(shell, live);

  /* ─────────── Rendering ─────────── */

  function segmented(name, legend, options, value, onChange) {
    const fs = h('fieldset', { class: 'seg', 'data-testid': `seg-${name}` }, h('legend', { class: 'sr-only' }, legend));
    for (const o of options) {
      const id = `seg-${name}-${o.value}`;
      const input = h('input', { type: 'radio', class: 'seg-input', name: `seg-${name}`, id, value: o.value, checked: o.value === value, disabled: o.disabled });
      input.addEventListener('change', () => { if (input.checked) onChange(o.value); });
      fs.append(input, h('label', { for: id, class: 'seg-label' }, o.icon ? icon(o.icon) : null, h('span', {}, o.label),
        o.count !== undefined ? h('span', { class: 'seg-count' }, formatNumber(o.count)) : null));
    }
    return fs;
  }

  function filtersActive() {
    const s = ctx.state || {};
    return !!(s.technology || s.operatorType || s.hideClosed);
  }

  function renderShellParts() {
    const s = ctx.state;
    const listMode = ctx.mode === 'arealist';
    const title = h('h1', { class: 'results-title', id: 'results-title', tabindex: '-1' }, ctx.label ? h('bdi', {}, ctx.label) : t('search.results.locating'));
    const where = h('div', { class: 'results-where' },
      h('p', { class: 'eyebrow' }, listMode ? t(s.town ? 'search.results.eyebrowTown' : 'search.results.eyebrowArea') : t('search.results.eyebrow')),
      title,
      h('p', { class: 'results-where-note' }, listMode ? t('search.results.areaListNote') : ctx.labelKind === 'approx' ? t('search.results.approxNote') : t('search.results.pointNote')),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-testid': 'change-location', on: { click: () => onChangeLocation?.() } }, icon('search'), t('search.results.change')));

    const controls = h('div', { class: 'results-controls' });
    if (ctx.data && !listMode) {
      const d = ctx.data;
      controls.append(
        h('div', { class: 'control' },
          h('span', { class: 'control-label', id: 'group-label' }, t('search.group.label')),
          segmented('group', t('search.group.label'), [
            { value: 'exact', label: t('search.group.exact'), count: d.exact.length, icon: 'pin' },
            { value: 'area', label: t('search.group.area'), count: d.area.length, icon: 'map' },
          ], ctx.group, (v) => setGroup(v))),
        h('div', { class: 'control' },
          h('span', { class: 'control-label' }, t('search.sort.label')),
          segmented('sort', t('search.sort.label'), [
            { value: 'nearest', label: t('search.sort.nearest') },
            { value: 'recommended', label: t('search.sort.recommended') },
          ], s.sort, (v) => navigate({ ...ctx.state, sort: v, plant: null }))),
        modeControl(),
        h('div', { class: 'control control-actions' },
          filterToggle(),
          segmented('view', t('search.view.label'), [
            { value: 'map', label: t('search.view.map'), icon: 'map', disabled: ctx.mapFailed },
            { value: 'list', label: t('search.view.list'), icon: 'list' },
          ], currentView(), (v) => navigate({ ...ctx.state, view: v }, { replace: true }))));
    }
    const head = h('div', { class: 'results-head' }, where, controls, ctx.data && !listMode ? filtersPanel() : null);
    return head;
  }

  function modeControl() {
    const routing = config?.routing || {};
    const modes = routing.modes || {};
    const off = !routing.provider || routing.provider === 'none';
    const allUnsupported = off || (!modes.driving && !modes.walking);
    const list = ['driving', 'walking', ...('two_wheeler' in modes ? ['two_wheeler'] : [])];
    const select = h('select', { id: 'mode-select', 'aria-describedby': 'mode-note', disabled: allUnsupported, 'data-testid': 'mode-select' },
      list.map((m) => h('option', { value: m, selected: ctx.state.mode === m, disabled: !allUnsupported && !modes[m] },
        t(`search.mode.${m}`) + (!allUnsupported && !modes[m] ? ` — ${t('search.mode.unavailableShort')}` : ''))));
    select.addEventListener('change', () => navigate({ ...ctx.state, mode: select.value, plant: null }));
    let note = '';
    const reason = ctx.data?.distance?.routingReason;
    if (off) note = t('search.mode.reason.disabled');
    else if (!modes.walking) note = t('search.mode.reason.walking');
    if (ctx.data?.distance && !ctx.data.distance.routingAvailable && reason === 'provider_unavailable') note = t('search.mode.reason.provider_unavailable');
    return h('div', { class: 'control control-mode' },
      h('label', { for: 'mode-select', class: 'control-label' }, t('search.mode.label')),
      h('div', { class: 'select-wrap' }, select, icon('chevronDown')),
      note ? h('p', { class: 'hint', id: 'mode-note' }, note) : h('span', { id: 'mode-note', hidden: true }));
  }

  function filterToggle() {
    const n = [ctx.state.technology, ctx.state.operatorType, ctx.state.hideClosed].filter(Boolean).length;
    const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm filter-btn', 'aria-expanded': String(ctx.filtersOpen), 'aria-controls': 'filters-panel', 'data-testid': 'filters-toggle' },
      icon('filter'), t('search.filters.button'), n ? h('span', { class: 'count-badge' }, formatNumber(n)) : null);
    btn.addEventListener('click', () => {
      ctx.filtersOpen = !ctx.filtersOpen;
      btn.setAttribute('aria-expanded', String(ctx.filtersOpen));
      const panel = document.getElementById('filters-panel');
      if (panel) panel.hidden = !ctx.filtersOpen;
    });
    return btn;
  }

  function filtersPanel() {
    const s = ctx.state;
    const opts = (set, cur) => {
      const vals = new Set(set);
      if (cur) vals.add(cur);
      return Array.from(vals).sort((a, b) => a.localeCompare(b));
    };
    const tech = h('select', { id: 'f-tech', 'data-testid': 'filter-technology' },
      h('option', { value: '' }, t('search.filters.any')),
      opts(ctx.facets.technology, s.technology).map((v) => h('option', { value: v, selected: v === s.technology }, v)));
    const op = h('select', { id: 'f-op', 'data-testid': 'filter-operator' },
      h('option', { value: '' }, t('search.filters.any')),
      opts(ctx.facets.operatorType, s.operatorType).map((v) => h('option', { value: v, selected: v === s.operatorType }, v)));
    const hide = h('input', { type: 'checkbox', id: 'f-hide', checked: s.hideClosed, 'data-testid': 'filter-hide-closed' });
    tech.addEventListener('change', () => navigate({ ...ctx.state, technology: tech.value || null, plant: null }));
    op.addEventListener('change', () => navigate({ ...ctx.state, operatorType: op.value || null, plant: null }));
    hide.addEventListener('change', () => navigate({ ...ctx.state, hideClosed: hide.checked, plant: null }));
    return h('div', { class: 'filters', id: 'filters-panel', hidden: !ctx.filtersOpen },
      h('div', { class: 'field' }, h('label', { for: 'f-tech' }, t('search.filters.technology')), h('div', { class: 'select-wrap' }, tech, icon('chevronDown'))),
      h('div', { class: 'field' }, h('label', { for: 'f-op' }, t('search.filters.operator')), h('div', { class: 'select-wrap' }, op, icon('chevronDown'))),
      h('div', { class: 'field field-check' }, hide, h('label', { for: 'f-hide' }, t('search.filters.hideClosed'))),
      filtersActive() ? h('button', { type: 'button', class: 'btn btn-link', on: { click: clearFilters } }, t('search.filters.clear')) : null,
      h('p', { class: 'hint' }, t('search.filters.note')));
  }

  function clearFilters() { navigate({ ...ctx.state, technology: null, operatorType: null, hideClosed: false, plant: null }); }

  function notices() {
    const out = [];
    const d = ctx.data;
    const stats = config?.stats;
    if (ctx.mode === 'search' && d) {
      // Server notice codes (null | origin_outside_coverage | no_exact_locations_recorded | no_exact_nearby).
      const code = d.notice || (!d.exact.length ? (stats && stats.plantsExact > 0 ? 'no_exact_nearby' : 'no_exact_locations_recorded') : null);
      if (code === 'origin_outside_coverage') {
        out.push(h('div', { class: 'notice notice-warn', 'data-testid': 'notice-outside' }, icon('alert'),
          h('div', {}, h('p', { class: 'notice-title' }, t('search.notice.outsideTitle')), h('p', {}, t('search.notice.outside')))));
      }
      if (!d.exact.length && code !== 'origin_outside_coverage') {
        const noCoords = code === 'no_exact_locations_recorded';
        out.push(h('div', { class: 'notice notice-info', 'data-testid': 'notice-no-exact' }, icon('info'),
          h('div', {}, h('p', { class: 'notice-title' }, noCoords ? t('search.notice.noCoordsTitle') : t('search.notice.noExactTitle')),
            h('p', {}, noCoords ? t('search.notice.noCoords') : t('search.notice.noExact')),
            h('a', { href: '/about.html#spreadsheet' }, t('search.notice.whyLink')))));
      } else if (ctx.group === 'area' && d.area.length) {
        out.push(h('div', { class: 'notice notice-info' }, icon('info'), h('p', {}, t('search.notice.areaGroup'))));
      }
      if (d.notice && !['origin_outside_coverage', 'no_exact_locations_recorded', 'no_exact_nearby'].includes(d.notice)) {
        out.push(h('div', { class: 'notice notice-info' }, icon('info'), h('p', {}, t('search.notice.generic'))));
      }
      if (d.excluded?.noLocation > 0) out.push(townBrowse(d));
    }
    if (ctx.mode === 'arealist' && ctx.data) {
      out.push(h('div', { class: 'notice notice-info', 'data-testid': 'notice-missing-coords' }, icon('info'),
        h('div', {}, h('p', { class: 'notice-title' }, t('search.notice.areaNoPosTitle')), h('p', {}, t(ctx.state.town ? 'search.notice.townNoPos' : 'search.notice.areaNoPos')))));
    }
    return out.length ? h('div', { class: 'results-notices' }, out) : null;
  }

  function currentView() {
    if (ctx.mode === 'arealist' || ctx.mapFailed) return 'list';
    return ctx.state?.view === 'list' ? 'list' : 'map';
  }

  function listRow(p, i) {
    const st = statusInfo(p);
    const selected = i === ctx.index;
    const dist = ctx.mode === 'search' && Number.isFinite(p.distanceM) ? formatDistance(p.distanceM) : null;
    const btn = h('button', { type: 'button', class: 'rrow', 'aria-current': selected ? 'true' : null, 'data-code': p.code, on: { click: () => { select(i, { via: 'list' }); revealCard(); } } },
      h('span', { class: 'rrow-rank', 'aria-hidden': 'true' }, formatNumber(i + 1)),
      h('span', { class: 'rrow-main' },
        h('span', { class: `rrow-name${p.name ? '' : ' is-missing'}` }, p.name ? h('bdi', {}, p.name) : t('search.card.nameMissing'), ' ', h('bdi', { class: 'mono rrow-code' }, p.code)),
        h('span', { class: 'rrow-sub' }, p.areaRaw ? h('bdi', {}, p.areaRaw) : t('search.value.notProvided'), p.town ? [' · ', h('bdi', {}, p.town)] : null),
        ctx.state.sort === 'recommended' && p.recommendation ? h('span', { class: 'rrow-rec' }, recommendationText(p.recommendation)) : null),
      h('span', { class: 'rrow-meta' },
        dist ? h('span', { class: 'rrow-dist' }, h('bdi', {}, dist)) : null,
        dist ? h('span', { class: 'rrow-method' }, methodLabel(p.distanceMethod)) : null,
        h('span', { class: `rrow-status tone-${st.tone}` }, icon(st.icon), statusShort(p)),
        p.isDemo ? h('span', { class: 'chip chip-demo chip-sm' }, t('common.demo.short')) : null));
    return h('li', {}, btn);
  }

  function listBlock() {
    const listMode = ctx.mode === 'arealist';
    const total = listMode ? ctx.data?.total ?? ctx.list.length : ctx.list.length;
    const more = listMode && ctx.list.length < total;
    return h('div', { class: 'results-list-wrap', 'data-testid': 'results-list' },
      h('h2', { class: 'list-title' }, listMode ? t(ctx.state.town ? 'search.list.titleTown' : 'search.list.titleArea', { n: formatNumber(total) }) : t('search.list.title', { n: formatNumber(ctx.list.length) })),
      h('p', { class: 'hint' }, listMode ? t('search.list.hintArea') : ctx.group === 'area' ? t('search.list.hintAreaGroup') : t('search.list.hint')),
      h('ol', { class: 'rlist' }, ctx.list.map(listRow)),
      more ? h('button', { type: 'button', class: 'btn btn-ghost list-more', 'data-testid': 'list-more', on: { click: loadMore } },
        t('search.list.more', { shown: formatNumber(ctx.list.length), total: formatNumber(total) })) : null);
  }

  /** Text-list links by town: the only way to reach plants whose area has no usable map position. */
  function townBrowse(d) {
    const towns = [];
    const seen = new Set();
    const add = (name) => { const k = (name || '').trim(); if (k && !seen.has(k.toLowerCase()) && !/^DEMO/.test(k)) { seen.add(k.toLowerCase()); towns.push(k); } };
    for (const p of [...d.area, ...d.exact]) add(p.town);
    return h('div', { class: 'notice notice-plain', 'data-testid': 'town-browse' }, icon('list'),
      h('div', {},
        h('p', {}, t('search.notice.noLocation', { n: formatNumber(d.excluded.noLocation) })),
        towns.length ? h('div', { class: 'town-chips' },
          h('span', { class: 'town-chips-label' }, t('search.notice.browseTown')),
          towns.slice(0, 8).map((town) => h('a', { class: 'town-chip', href: townHref(town), on: { click: (e) => { e.preventDefault(); openTown(town); } } }, h('bdi', {}, town)))) : null));
  }
  function townHref(town) {
    const q = new URLSearchParams({ town, label: town });
    const lang = new URLSearchParams(location.search).get('lang');
    if (lang) q.set('lang', lang);
    return `/?${q}`;
  }
  function openTown(town) {
    navigate({ lat: null, lng: null, area: null, town, label: town, sort: ctx.state.sort, mode: ctx.state.mode, view: 'list', plant: null, group: null, technology: null, operatorType: null, hideClosed: false });
    window.scrollTo({ top: 0 });
    document.getElementById('results-title')?.focus({ preventScroll: true });
  }

  async function loadMore() {
    const d = ctx.data;
    if (!d || ctx.mode !== 'arealist') return;
    const page = (d.page || 1) + 1;
    try {
      const r = await getJSON(listUrl(ctx.state, page), { timeoutMs: 15000 });
      d.items = d.items.concat(r.items || []);
      d.page = page;
      d.total = r.total ?? d.total;
      ctx.list = d.items;
      const keep = ctx.index;
      render();
      if (keep >= 0) select(keep, { via: 'init', announceIt: false });
      announce(live, t('search.list.loaded', { n: formatNumber(ctx.list.length), total: formatNumber(d.total) }));
    } catch {
      announce(live, t('search.card.detailError'));
    }
  }
  function listUrl(s, page = 1) {
    const q = new URLSearchParams({ pageSize: '100', page: String(page) });
    if (s.area) q.set('area', s.area);
    else if (s.town) q.set('town', s.town);
    return `/api/plants?${q}`;
  }

  function emptyState() {
    const d = ctx.data;
    const other = ctx.group === 'exact' ? 'area' : 'exact';
    const otherCount = d?.[other]?.length || 0;
    return h('div', { class: 'state-box', 'data-testid': 'state-empty' },
      icon('search', 'state-icon'),
      h('h2', {}, t('search.empty.title')),
      h('p', {}, filtersActive() ? t('search.empty.filtered') : otherCount ? t('search.empty.group') : t('search.empty.text')),
      h('div', { class: 'state-actions' },
        filtersActive() ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: clearFilters } }, t('search.filters.clear')) : null,
        otherCount ? h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => setGroup(other) } }, t(`search.empty.show.${other}`, { n: formatNumber(otherCount) })) : null,
        h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => onChangeLocation?.() } }, t('search.results.change'))));
  }

  function errorState(err) {
    const code = err?.code;
    const text = code === 'timeout' ? t('search.error.timeout') : code === 'network' ? t('search.error.network') : err?.status === 400 ? t('search.error.invalid') : t('search.error.down');
    return h('div', { class: 'state-box state-error', role: 'alert', 'data-testid': 'state-error' },
      icon('alert', 'state-icon'),
      h('h2', {}, t('search.error.title')),
      h('p', {}, text),
      h('p', { class: 'muted' }, t('search.error.noFake')),
      h('div', { class: 'state-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'retry', on: { click: () => load(ctx.state, { force: true }) } }, icon('refresh'), t('common.retry')),
        h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => onChangeLocation?.() } }, t('search.results.change'))));
  }

  function loadingState() {
    return h('div', { class: 'state-box state-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, t('search.results.loading')));
  }

  function render() {
    // The card node is persistent; keep focus if it had it.
    const hadFocus = cardRegion.contains(document.activeElement);
    const view = currentView();
    const parts = [renderShellParts()];
    if (ctx.error) {
      parts.push(errorState(ctx.error));
    } else if (ctx.loading && !ctx.data) {
      parts.push(loadingState());
    } else if (ctx.data) {
      const n = notices();
      if (n) parts.push(n);
      if (!ctx.list.length) {
        parts.push(emptyState());
      } else {
        const mapFailNotice = h('div', { class: 'map-notice', role: 'status', hidden: !(ctx.tileFailed || ctx.mapFailed), 'data-testid': 'map-notice' },
          icon('alert'), h('div', {},
            h('p', { class: 'notice-title' }, ctx.mapFailed ? t('search.map.failedTitle') : t('search.map.tilesTitle')),
            h('p', {}, ctx.mapFailed ? t('search.map.failed') : t('search.map.tiles')),
            !ctx.mapFailed && view === 'map' ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => navigate({ ...ctx.state, view: 'list' }, { replace: true }) } }, icon('list'), t('search.map.showList')) : null));
        const sheetBtn = h('button', { type: 'button', class: 'sheet-handle', 'aria-expanded': String(ctx.sheetExpanded), 'aria-controls': 'results-panel' },
          h('span', { class: 'sheet-grip', 'aria-hidden': 'true' }), h('span', {}, ctx.sheetExpanded ? t('search.sheet.collapse') : t('search.sheet.expand')));
        sheetBtn.addEventListener('click', () => {
          ctx.sheetExpanded = !ctx.sheetExpanded;
          body.classList.toggle('is-sheet-expanded', ctx.sheetExpanded);
          sheetBtn.setAttribute('aria-expanded', String(ctx.sheetExpanded));
          sheetBtn.lastChild.textContent = ctx.sheetExpanded ? t('search.sheet.collapse') : t('search.sheet.expand');
          setTimeout(() => ctx.map?.invalidateSize(), 260);
        });
        const mapWrap = h('div', { class: 'results-map-wrap', hidden: view !== 'map' }, mapEl, view === 'map' ? mapFailNotice : null);
        const panel = h('aside', { class: 'results-panel', id: 'results-panel', 'aria-label': t('search.card.panelLabel') }, view === 'map' ? sheetBtn : null, cardRegion);
        const body = h('div', { class: `results-body view-${view}${ctx.sheetExpanded ? ' is-sheet-expanded' : ''}` },
          mapWrap, view === 'list' ? h('div', { class: 'list-col' }, view === 'list' && (ctx.tileFailed || ctx.mapFailed) ? mapFailNotice : null, listBlock()) : null, panel);
        parts.push(body);
        if (view === 'map') {
          parts.push(h('details', { class: 'list-drawer' }, h('summary', {}, icon('list'), t('search.list.drawer', { n: formatNumber(ctx.list.length) })), listBlock()));
        }
      }
    }
    shell.replaceChildren(...parts.filter(Boolean));
    updateNav();
    cardRegion.setAttribute('aria-label', t('search.card.regionLabel'));
    cardRegion.setAttribute('aria-roledescription', t('search.card.roledesc'));
    if (hadFocus) cardRegion.focus({ preventScroll: true });
    if (currentView() === 'map' && ctx.list.length && ctx.mode === 'search') ensureMap().then(() => ctx.map?.invalidateSize());
  }

  /* ─────────── Navigation ─────────── */

  function updateNav() {
    const n = ctx.list.length;
    const i = ctx.index;
    prevBtn.replaceChildren(icon(prevArrow()), h('span', { class: 'arrow-text' }, t('search.card.prev')));
    nextBtn.replaceChildren(h('span', { class: 'arrow-text' }, t('search.card.next')), icon(nextArrow()));
    prevBtn.setAttribute('aria-label', t('search.card.prevLabel'));
    nextBtn.setAttribute('aria-label', t('search.card.nextLabel'));
    const atStart = i <= 0;
    const atEnd = i >= n - 1;
    prevBtn.disabled = atStart;
    nextBtn.disabled = atEnd;
    position.textContent = n ? t('search.card.position', { n: formatNumber(i + 1), total: formatNumber(n) }) : '';
    // Keep keyboard focus in the card region if the focused arrow just became disabled.
    if ((prevBtn.disabled && document.activeElement === prevBtn) || (nextBtn.disabled && document.activeElement === nextBtn)) cardRegion.focus({ preventScroll: true });
  }

  function step(delta, { keyboard = false } = {}) {
    const next = ctx.index + delta;
    if (next < 0 || next >= ctx.list.length) return;
    select(next, { direction: delta, via: keyboard ? 'keyboard' : 'arrow' });
  }

  function selectByCode(code, opts) {
    const i = ctx.list.findIndex((p) => p.code === code);
    if (i >= 0) { select(i, opts); if (opts?.via === 'map') revealCard(); }
  }

  function revealCard() {
    if (window.matchMedia('(max-width: 899px)').matches) cardRegion.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  async function animateIn(el, direction) {
    if (!direction || prefersReducedMotion()) return;
    const mod = await loadAnime();
    if (!mod?.animate || !el.isConnected) return;
    const dx = 28 * Math.sign(direction) * (isRtl() ? -1 : 1);
    try { mod.animate(el, { opacity: [0, 1], translateX: [dx, 0], duration: 280, ease: 'outCubic' }); } catch { /* cosmetic only */ }
  }

  function select(i, { direction = 0, via = 'init', announceIt = true } = {}) {
    if (i < 0 || i >= ctx.list.length) return;
    const p = ctx.list[i];
    ctx.index = i;
    ctx.card?.destroy();
    const card = renderCard(p, ctx.detail.get(p.code) || null, {
      origin: ctx.mode === 'search' ? { lat: ctx.state.lat, lng: ctx.state.lng } : null,
      mode: ctx.state.mode, config, sort: ctx.state.sort, listMode: ctx.mode === 'arealist',
      onViewArea: ctx.mode === 'search' ? viewArea : null,
    });
    ctx.card = card;
    cardBody.replaceChildren(card.el);
    animateIn(card.el, direction);
    updateNav();
    for (const row of shell.querySelectorAll('.rrow')) {
      if (row.dataset.code === p.code) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    ctx.map?.selectPlant(p.code, { pan: via !== 'map' });
    loadDetail(p);
    showRoute(p);
    prefetch(i + 1); prefetch(i - 1);
    ctx.state = { ...ctx.state, plant: p.code, group: ctx.mode === 'search' ? ctx.group : null };
    writeState(ctx.state, { replace: true });
    if (announceIt && via !== 'init') {
      const dist = ctx.mode === 'search' ? formatDistance(p.distanceM) : null;
      announce(live, t('search.card.announce', { n: formatNumber(i + 1), total: formatNumber(ctx.list.length), name: p.name || p.code }) + (dist ? ` · ${dist}` : ''));
    }
  }

  function viewArea(p) {
    if (currentView() !== 'map') navigate({ ...ctx.state, view: 'map' }, { replace: true });
    ensureMap().then((m) => {
      if (!m) return;
      m.focusArea(p.code);
      m.selectPlant(p.code, { pan: false });
      mapEl.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    });
  }

  async function loadDetail(p, { force = false } = {}) {
    if (ctx.detail.has(p.code) && !force) return;
    try {
      const det = await getJSON(`/api/plants/${encodeURIComponent(p.code)}`, { timeoutMs: 10000 });
      ctx.detail.set(p.code, det);
      if (ctx.list[ctx.index]?.code === p.code) ctx.card?.setDetail(det);
    } catch (err) {
      if (ctx.list[ctx.index]?.code === p.code) ctx.card?.setDetailError(() => loadDetail(p, { force: true }));
    }
  }
  function prefetch(i) {
    const p = ctx.list[i];
    if (!p || ctx.detail.has(p.code)) return;
    getJSON(`/api/plants/${encodeURIComponent(p.code)}`, { timeoutMs: 10000 }).then((d) => ctx.detail.set(p.code, d)).catch(() => {});
  }

  async function showRoute(p) {
    ctx.routeCtrl?.abort();
    ctx.map?.showRoute(null);
    if (ctx.mode !== 'search' || p.location?.precision !== 'exact') { ctx.card?.setRoute(null); return; }
    const origin = { lat: ctx.state.lat, lng: ctx.state.lng };
    const dest = { lat: p.location.lat, lng: p.location.lng };
    const mode = ctx.state.mode;
    const straight = (info) => {
      if (ctx.list[ctx.index]?.code !== p.code) return;
      ctx.map?.showRoute(null, { straightLineFrom: origin, straightLineTo: dest, label: t('search.route.straightLabel') });
      ctx.card?.setRoute(info);
    };
    const routing = config?.routing || {};
    if (!routing.provider || routing.provider === 'none') return straight({ available: false, reason: 'disabled' });
    if (routing.modes && routing.modes[mode] === false) return straight({ available: false, reason: 'mode_unsupported' });
    const key = `${p.code}|${mode}|${origin.lat},${origin.lng}`;
    let r = ctx.routes.get(key);
    if (!r) {
      ctx.card?.setRoute({ loading: true });
      const ctrl = new AbortController();
      ctx.routeCtrl = ctrl;
      try {
        r = await getJSON(`/api/route?from=${origin.lat},${origin.lng}&to=${encodeURIComponent(p.code)}&mode=${mode}`, { signal: ctrl.signal, timeoutMs: 12000 });
        ctx.routes.set(key, r);
      } catch (err) {
        if (isAbort(err)) return;
        return straight({ available: false, reason: 'provider_unavailable' });
      }
    }
    if (ctx.list[ctx.index]?.code !== p.code) return;
    if (r.available && r.geometry) {
      await ensureMapIfShown();
      ctx.map?.showRoute(r.geometry);
      ctx.card?.setRoute(r);
    } else straight(r);
  }

  /* ─────────── Map ─────────── */

  function mapLabels() {
    return {
      origin: t('search.map.origin'),
      straightLine: t('search.route.straightLabel'),
      exact: (p) => t('search.map.markerLabel', { rank: formatNumber(ctx.list.indexOf(p) + 1), name: p.name || p.code, dist: formatDistance(p.distanceM) || '' }),
      area: (g) => t(isPartial(g) ? 'search.map.areaLabelPartial' : 'search.map.areaLabel', { n: formatNumber(g.plants.length), area: g.area.name }),
      areaShort: (g) => g.area.name,
      areaCount: (g) => (isPartial(g) ? `${formatNumber(g.plants.length)}+` : formatNumber(g.plants.length)),
    };
  }

  /** The area list is capped at SEARCH_LIMIT; the last area group may then be incomplete ("24+"). */
  function isPartial(g) {
    const a = ctx.data?.area;
    if (!a || a.length < SEARCH_LIMIT || ctx.group !== 'area') return false;
    const last = a[a.length - 1]?.location?.area;
    return !!last && String(last.id ?? `${last.lat},${last.lng}`) === g.key;
  }

  function ensureMapIfShown() { return currentView() === 'map' ? ensureMap() : Promise.resolve(ctx.map); }

  function ensureMap() {
    if (ctx.map) return Promise.resolve(ctx.map);
    if (ctx.mapFailed) return Promise.resolve(null);
    if (!ctx.mapPromise) {
      mapEl.setAttribute('aria-label', t('search.map.label'));
      ctx.mapPromise = import('/js/map/adapter.js')
        .then(({ createMap }) => createMap(mapEl, config, {
          labels: mapLabels(),
          onSelect: (code, o) => selectByCode(code, o),
          onNotice: (code) => { if (code === 'google_failed') announce(live, t('search.map.googleFailed')); },
        }))
        .then((m) => {
          ctx.map = m;
          m.onTileError(() => {
            ctx.tileFailed = true;
            const n = shell.querySelector('.map-notice');
            if (n) {
              n.hidden = false;
            }
            announce(live, t('search.map.tilesTitle'));
          });
          syncMap(true);
          return m;
        })
        .catch((err) => {
          console.warn('[results] map failed', err);
          ctx.mapFailed = true;
          ctx.mapPromise = null;
          render();
          announce(live, t('search.map.failedTitle'));
          return null;
        });
    }
    return ctx.mapPromise;
  }

  function syncMap(fit = false) {
    const m = ctx.map;
    if (!m) return;
    m.setOrigin(ctx.mode === 'search' ? { lat: ctx.state.lat, lng: ctx.state.lng } : null, { label: t('search.map.origin') });
    m.setPlants(ctx.group === 'exact' ? { exact: ctx.list, area: [] } : { exact: [], area: ctx.list });
    if (fit || !ctx.fitted) { m.fitToResults(); ctx.fitted = true; }
    const p = ctx.list[ctx.index];
    if (p) { m.selectPlant(p.code, { pan: false }); showRoute(p); }
    else m.showRoute(null);
  }

  /* ─────────── Data ─────────── */

  function setGroup(g) {
    if (!ctx.data || g === ctx.group) return;
    ctx.group = g;
    ctx.list = ctx.data[g] || [];
    ctx.index = -1;
    ctx.state = { ...ctx.state, group: g, plant: null };
    writeState(ctx.state);
    render();
    if (ctx.list.length) select(0, { via: 'init' });
    syncMap(true);
    announce(live, t('search.group.announce', { group: t(`search.group.${g}`), n: formatNumber(ctx.list.length) }));
  }

  function navigate(next, { replace = false } = {}) {
    writeState(next, { replace });
    update(next);
  }

  async function resolveLabel(s) {
    if (s.label) { ctx.label = s.label; ctx.labelKind = /approx|تقریب|تخمینی/i.test(s.label) ? 'approx' : 'point'; return; }
    if (s.lat === null) { ctx.label = s.town || t('search.results.areaFallback'); ctx.labelKind = 'list'; return; }
    ctx.label = t('search.results.pinnedAt', { lat: formatNumber(s.lat, { maximumFractionDigits: 4 }), lng: formatNumber(s.lng, { maximumFractionDigits: 4 }) });
    ctx.labelKind = 'point';
    if (s.lat === null) return;
    try {
      const r = await getJSON(`/api/reverse?lat=${s.lat}&lng=${s.lng}`, { timeoutMs: 6000 });
      if (r?.label && ctx.state?.lat === s.lat && ctx.state?.lng === s.lng) {
        ctx.label = r.label;
        ctx.labelKind = r.precision === 'area' ? 'approx' : 'point';
        const title = document.getElementById('results-title');
        if (title) title.replaceChildren(h('bdi', {}, r.label));
      }
    } catch { /* keep the coordinate label */ }
  }

  async function fetchSearch(s, signal) {
    const q = new URLSearchParams({ lat: String(s.lat), lng: String(s.lng), sort: s.sort, mode: s.mode, limit: String(SEARCH_LIMIT) });
    if (s.technology) q.set('technology', s.technology);
    if (s.operatorType) q.set('operatorType', s.operatorType);
    if (s.hideClosed) q.set('hideTemporarilyClosed', '1');
    try {
      return await getJSON(`/api/search?${q}`, { signal, timeoutMs: 20000 });
    } catch (err) {
      // If the server caps `limit` lower than we asked, retry with its default.
      if (err?.status === 400 && err?.details?.field === 'limit') { q.delete('limit'); return getJSON(`/api/search?${q}`, { signal, timeoutMs: 20000 }); }
      throw err;
    }
  }

  async function load(s, { force = false } = {}) {
    ctx.ctrl?.abort();
    const ctrl = new AbortController();
    ctx.ctrl = ctrl;
    const seq = ++ctx.loadSeq;
    ctx.state = s;
    ctx.error = null;
    ctx.loading = true;
    ctx.mode = s.lat !== null ? 'search' : 'arealist';
    if (!force) { ctx.data = null; ctx.list = []; ctx.index = -1; ctx.fitted = false; }
    ctx.card?.destroy(); ctx.card = null; cardBody.replaceChildren();
    const labelP = resolveLabel(s);
    render();
    try {
      let data;
      if (ctx.mode === 'search') {
        data = await fetchSearch(s, ctrl.signal);
        data.exact = Array.isArray(data.exact) ? data.exact : [];
        data.area = Array.isArray(data.area) ? data.area : [];
      } else {
        const r = await getJSON(listUrl(s, 1), { signal: ctrl.signal, timeoutMs: 15000 });
        data = { items: r.items || [], total: r.total ?? (r.items || []).length, page: 1 };
      }
      if (seq !== ctx.loadSeq) return;
      ctx.data = data;
    } catch (err) {
      if (isAbort(err) || seq !== ctx.loadSeq) return;
      ctx.error = err;
      ctx.loading = false;
      render();
      return;
    }
    await Promise.race([labelP, new Promise((r) => setTimeout(r, 400))]);
    ctx.loading = false;
    const d = ctx.data;
    if (ctx.mode === 'search') {
      for (const p of [...d.exact, ...d.area]) {
        if (p.technology?.raw) ctx.facets.technology.add(p.technology.raw);
        if (p.operator?.type) ctx.facets.operatorType.add(p.operator.type);
      }
      // Default group: exact when available, otherwise area (true for the spreadsheet today).
      ctx.group = s.group && d[s.group]?.length ? s.group : d.exact.length ? 'exact' : 'area';
      ctx.list = d[ctx.group];
    } else {
      ctx.group = null;
      ctx.list = d.items;
    }
    const idx = s.plant ? ctx.list.findIndex((p) => p.code === s.plant) : -1;
    ctx.index = -1;
    render();
    if (ctx.list.length) select(idx >= 0 ? idx : 0, { via: 'init' });
    else writeState({ ...ctx.state, plant: null }, { replace: true });
    if (ctx.map) syncMap(true);
    const total = ctx.mode === 'search' ? d.exact.length + d.area.length : d.items.length;
    announce(live, total ? t('search.results.announce', { n: formatNumber(ctx.list.length) }) : t('search.empty.title'));
    loadAnime();
  }

  function update(s) {
    const prev = ctx.state;
    if (!prev || !sameQuery(prev, s)) {
      ctx.state = s;
      return load(s);
    }
    ctx.state = { ...ctx.state, view: s.view, group: s.group ?? ctx.state.group };
    if (ctx.data && ctx.mode === 'search' && s.group && s.group !== ctx.group && ctx.data[s.group]) {
      ctx.group = s.group;
      ctx.list = ctx.data[s.group];
      ctx.index = -1;
      render();
      const i = s.plant ? ctx.list.findIndex((p) => p.code === s.plant) : 0;
      if (ctx.list.length) select(Math.max(0, i), { via: 'init' });
      syncMap(true);
      return;
    }
    render();
    if (s.plant && ctx.list[ctx.index]?.code !== s.plant) {
      const i = ctx.list.findIndex((p) => p.code === s.plant);
      if (i >= 0) select(i, { via: 'init' });
    }
    if (ctx.map && currentView() === 'map') setTimeout(() => ctx.map?.invalidateSize(), 0);
  }

  const offLang = onLangChange(() => {
    if (!ctx.state) return;
    const p = ctx.list[ctx.index];
    render();
    if (p) select(ctx.index, { via: 'init' });
    if (ctx.map) syncMap(false);
  });

  return {
    update,
    focusTitle() { document.getElementById('results-title')?.focus({ preventScroll: false }); },
    destroy() {
      offLang();
      ctx.ctrl?.abort();
      ctx.card?.destroy();
      ctx.map?.destroy();
      ctx.map = null;
      ctx.mapPromise = null;
      clear(root);
    },
    get ctx() { return ctx; },
  };
}
