// Home search: place combobox (debounced /api/geocode, listbox semantics), "Use my location" (permission is
// requested only after the click, with the explanation shown first), and "Choose on map" (tap/click to pin,
// drag to adjust, or "Use map centre" from the keyboard).
//   initSearch({ config, onSubmit({ lat, lng, label }), onAreaList({ areaId, town, label }) })
// Geocoding: as-you-type requests hit only the local gazetteer (/api/geocode?q=). Only an explicit submit
// (Enter / the search button, with no suggestion chosen) adds &submit=1, which may query the external
// geocoder — Nominatim's usage policy forbids autocomplete against it.
import { t, getLang, onLangChange, formatNumber } from '/js/i18n.js';
import { getJSON, isAbort } from '/js/api.js';
import { h, $, icon, debounce, announce, formatDistance } from '/js/util.js';

const KIND_ICON = { area: 'map', town: 'map', landmark: 'flag', address: 'pin', place: 'pin' };

export function initSearch({ config, onSubmit, onAreaList }) {
  const form = $('#search-form');
  const input = $('#place-input');
  const combo = $('#place-combo');
  const pop = $('#place-pop');
  const listbox = $('#place-listbox');
  const popHead = $('#place-pop-head');
  const popFoot = $('#place-pop-foot');
  const live = $('#search-live');
  const clearBtn = $('#place-clear');
  const chosenEl = $('#chosen');
  const errorEl = $('#search-error');
  const btnLocate = $('#btn-locate');
  const btnPick = $('#btn-pick');
  const locStatus = $('#locate-status');
  const picker = $('#picker');
  const pickerMapEl = $('#picker-map');
  const pickerNotice = $('#picker-notice');
  const btnCenter = $('#btn-center');
  const areaPanel = $('#area-panel');

  let results = [];
  let active = -1;
  let ctrl = null;
  let chosen = null; // { lat, lng, label, precision, source, accuracyM }
  let lastQuery = '';
  let map = null;
  let mapPromise = null;
  let open = false;

  /* ─────────── Combobox ─────────── */

  function setOpen(v) {
    open = v;
    pop.hidden = !v;
    input.setAttribute('aria-expanded', String(v));
    if (!v) { active = -1; input.removeAttribute('aria-activedescendant'); }
  }

  function setActive(i) {
    const opts = listbox.querySelectorAll('[role=option]');
    if (!opts.length) return;
    active = (i + opts.length) % opts.length;
    opts.forEach((o, j) => o.setAttribute('aria-selected', String(j === active)));
    input.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
  }

  function optionEl(r, i) {
    const noPos = r.lat === null || r.lat === undefined || r.lng === null || r.lng === undefined;
    const meta = [];
    if (noPos) meta.push(h('span', { class: 'opt-tag tag-warn' }, t('search.combo.listOnly')));
    else if (r.precision === 'area') meta.push(h('span', { class: 'opt-tag' }, t('search.combo.approx')));
    if (Number.isFinite(r.plantCount)) meta.push(h('span', { class: 'opt-count' }, t('search.combo.plants', { n: formatNumber(r.plantCount) })));
    const sub = [r.sublabel ? h('bdi', {}, r.sublabel) : null];
    if (r.matchedAlias && r.matchedAlias !== r.label) sub.push(' · ', t('search.combo.matched', { alias: '' }), h('bdi', {}, r.matchedAlias));
    const li = h('li', { role: 'option', id: `place-opt-${i}`, class: 'opt', 'aria-selected': 'false', dataset: { index: String(i) } },
      h('span', { class: 'opt-icon', 'aria-hidden': 'true' }, icon(KIND_ICON[r.kind] || 'pin')),
      h('span', { class: 'opt-text' }, h('span', { class: 'opt-label' }, h('bdi', {}, r.label)), h('span', { class: 'opt-sub' }, sub)),
      h('span', { class: 'opt-meta' }, meta));
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    li.addEventListener('click', () => choose(i));
    return li;
  }

  function renderOptions(res, { didYouMean = false } = {}) {
    results = res.results || [];
    listbox.replaceChildren(...results.map(optionEl));
    popHead.hidden = !(didYouMean || res.ambiguous) || !results.length;
    popHead.textContent = t('search.combo.didYouMean');
    const foot = [];
    if (!results.length) {
      foot.push(h('p', { class: 'combo-empty', 'data-testid': 'combo-empty' }, icon('search'),
        h('span', {}, h('strong', {}, t('search.combo.noMatches', { q: res.query || lastQuery })), ' ', t('search.combo.noMatchesTip'))));
    }
    if (res.providers?.external === 'unavailable') foot.push(h('p', { class: 'combo-note' }, icon('info'), t('search.combo.externalDown')));
    else if (!didYouMean && results.length && res.providers?.external === 'skipped') foot.push(h('p', { class: 'combo-note' }, icon('info'), t('search.combo.submitHint')));
    popFoot.replaceChildren(...foot);
    popFoot.hidden = !foot.length;
    setOpen(true);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    announce(live, results.length ? t('search.combo.count', { n: formatNumber(results.length) }) : t('search.combo.noMatches', { q: res.query || lastQuery }));
  }

  function renderComboError() {
    results = [];
    listbox.replaceChildren();
    popHead.hidden = true;
    popFoot.replaceChildren(h('p', { class: 'combo-empty' }, icon('alert'), t('search.combo.error')));
    popFoot.hidden = false;
    setOpen(true);
    announce(live, t('search.combo.error'));
  }

  async function geocode(q, { submit = false } = {}) {
    ctrl?.abort();
    ctrl = new AbortController();
    lastQuery = q;
    const extra = submit ? '&submit=1' : '';
    return getJSON(`/api/geocode?q=${encodeURIComponent(q)}&lang=${getLang()}${extra}`, { signal: ctrl.signal, timeoutMs: submit ? 12000 : 8000 });
  }

  const suggest = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { setOpen(false); return; }
    try {
      const res = await geocode(q);
      if (input.value.trim() !== q) return;
      renderOptions(res);
    } catch (err) {
      if (!isAbort(err)) renderComboError();
    }
  }, 260);

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    if (chosen && chosen.source === 'geocode') setChosen(null);
    errorEl.replaceChildren();
    suggest();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open && results.length) setOpen(true); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (!open && results.length) setOpen(true); setActive(active - 1); }
    else if (e.key === 'Enter' && open && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); setOpen(false); } else if (input.value) { input.value = ''; clearBtn.hidden = true; } }
    else if (e.key === 'Home' && open && active >= 0) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && open && active >= 0) { e.preventDefault(); setActive(results.length - 1); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!combo.contains(document.activeElement)) setOpen(false); }, 120));
  input.addEventListener('focus', () => { if (results.length && input.value.trim() === lastQuery && !chosen) setOpen(true); });
  clearBtn.addEventListener('click', () => {
    input.value = ''; clearBtn.hidden = true; setOpen(false); results = [];
    if (chosen?.source === 'geocode') setChosen(null);
    input.focus();
  });
  document.addEventListener('click', (e) => { if (open && !combo.contains(e.target)) setOpen(false); });

  function choose(i) {
    const r = results[i];
    if (!r) return;
    setOpen(false);
    input.value = r.label;
    clearBtn.hidden = false;
    errorEl.replaceChildren();
    if (r.lat === null || r.lat === undefined || r.lng === null || r.lng === undefined) {
      setChosen(null);
      showAreaPanel(r);
      return;
    }
    hideAreaPanel();
    const label = r.sublabel ? `${r.label} — ${r.sublabel}` : r.label;
    setChosen({ lat: r.lat, lng: r.lng, label: r.precision === 'area' ? t('search.chosen.approxLabel', { label: r.label }) : label, display: label,
      precision: r.precision, source: 'geocode' });
    if (map) { map.setView({ lat: r.lat, lng: r.lng }, 14); placePin(); }
  }

  /* ─────────── Area with no recorded position ─────────── */

  function showAreaPanel(r) {
    areaPanel.hidden = false;
    const isTown = r.kind === 'town';
    const canList = isTown || (r.areaId !== null && r.areaId !== undefined);
    const n = Number.isFinite(r.plantCount) ? formatNumber(r.plantCount) : null;
    const listLabel = n !== null ? t(isTown ? 'search.areaPanel.listTownN' : 'search.areaPanel.listN', { n, area: r.label }) : t('search.areaPanel.list');
    areaPanel.replaceChildren(
      h('div', { class: 'notice notice-info', 'data-testid': 'area-no-position' }, icon('info'),
        h('div', {},
          h('p', { class: 'notice-title' }, t('search.areaPanel.title', { area: r.label })),
          h('p', {}, t('search.areaPanel.text')),
          h('div', { class: 'notice-actions' },
            canList
              ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-testid': 'area-list-btn',
                on: { click: () => onAreaList?.(isTown ? { town: r.label, label: r.label } : { areaId: r.areaId, label: r.label }) } }, icon('list'), listLabel)
              : null,
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => openPicker() } }, icon('map'), t('search.pick.button'))))));
  }
  function hideAreaPanel() { areaPanel.hidden = true; areaPanel.replaceChildren(); }

  /* ─────────── Chosen location ─────────── */

  function setChosen(c) {
    chosen = c;
    if (!c) { chosenEl.hidden = true; chosenEl.replaceChildren(); return; }
    const acc = c.accuracyM ? t('search.locate.accuracy', { dist: formatDistance(c.accuracyM) }) : null;
    chosenEl.hidden = false;
    chosenEl.replaceChildren(
      icon('pin', 'chosen-icon'),
      h('div', { class: 'chosen-text' },
        h('p', { class: 'chosen-kicker' }, t(`search.chosen.from.${c.source}`)),
        h('p', { class: 'chosen-label', 'data-testid': 'chosen-label' }, h('bdi', {}, c.display || c.label)),
        acc || c.precision === 'area' ? h('p', { class: 'chosen-note' }, [acc, c.precision === 'area' ? t('search.chosen.areaNote') : null].filter(Boolean).join(' · ')) : null),
      h('button', { type: 'button', class: 'btn-icon', 'aria-label': t('search.chosen.clear'), on: { click: () => { setChosen(null); map?.setOrigin(null); } } }, icon('close')));
  }

  async function labelFor(lat, lng, source) {
    const fallback = t('search.chosen.pinned', { lat: formatNumber(lat, { maximumFractionDigits: 4 }), lng: formatNumber(lng, { maximumFractionDigits: 4 }) });
    try {
      const r = await getJSON(`/api/reverse?lat=${lat}&lng=${lng}`, { timeoutMs: 5000 });
      return r?.label || fallback;
    } catch {
      return fallback;
    }
    // (source kept for future labels)
  }

  async function setPoint(lat, lng, source, extra = {}) {
    const base = { lat, lng, source, precision: 'point', ...extra };
    setChosen({ ...base, label: t('search.chosen.finding'), display: t('search.chosen.finding') });
    const label = await labelFor(lat, lng, source);
    if (chosen && chosen.lat === lat && chosen.lng === lng) setChosen({ ...base, label, display: label });
  }

  /* ─────────── Use my location ─────────── */

  function locStatusMsg(kind, text, actions) {
    locStatus.className = `status-msg is-${kind}`;
    locStatus.replaceChildren(icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'locate'), h('span', {}, text), actions || null);
  }

  btnLocate.addEventListener('click', () => {
    errorEl.replaceChildren();
    if (!('geolocation' in navigator)) { locStatusMsg('error', t('search.locate.unsupported')); return; }
    if (!window.isSecureContext) { locStatusMsg('error', t('search.locate.insecure')); return; }
    btnLocate.setAttribute('aria-busy', 'true');
    btnLocate.disabled = true;
    locStatusMsg('info', t('search.locate.finding'));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      btnLocate.disabled = false;
      btnLocate.removeAttribute('aria-busy');
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      const accuracyM = Math.round(accuracy || 0) || null;
      locStatusMsg('ok', `${t('search.locate.found')} ${accuracyM ? t('search.locate.accuracy', { dist: formatDistance(accuracyM) }) : ''} ${t('search.locate.adjust')}`.trim());
      hideAreaPanel();
      input.value = '';
      clearBtn.hidden = true;
      await openPicker({ lat, lng, accuracyM });
      setPoint(lat, lng, 'gps', { accuracyM });
    }, (err) => {
      btnLocate.disabled = false;
      btnLocate.removeAttribute('aria-busy');
      const key = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
      locStatusMsg('error', t(`search.locate.${key}`), h('span', { class: 'status-actions' },
        h('button', { type: 'button', class: 'btn btn-link', on: { click: () => input.focus() } }, t('search.locate.typeInstead')),
        h('button', { type: 'button', class: 'btn btn-link', on: { click: () => openPicker() } }, t('search.pick.button'))));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });

  /* ─────────── Choose on map ─────────── */

  function placePin({ accuracyM = null } = {}) {
    if (!map || !chosen) return;
    map.setOrigin({ lat: chosen.lat, lng: chosen.lng }, {
      accuracyM, draggable: true, label: t('search.map.origin'),
      onMove: ({ lat, lng }) => { setPoint(lat, lng, 'map'); announce(live, t('search.pick.moved')); },
    });
  }

  async function openPicker(at = null) {
    picker.hidden = false;
    btnPick.setAttribute('aria-expanded', 'true');
    hideAreaPanelIfChosen();
    if (!mapPromise) {
      pickerNotice.hidden = true;
      pickerMapEl.setAttribute('aria-label', t('search.pick.mapLabel'));
      mapPromise = import('/js/map/adapter.js')
        .then(({ createMap }) => createMap(pickerMapEl, config, { labels: { origin: t('search.map.origin') }, onNotice: () => {} }))
        .then((m) => {
          map = m;
          m.onTileError(() => { pickerNotice.hidden = false; pickerNotice.replaceChildren(icon('alert'), h('span', {}, t('search.pick.tiles'))); });
          m.enablePick(({ lat, lng }) => {
            setPoint(lat, lng, 'map');
            placePin();
            announce(live, t('search.pick.placed'));
          });
          return m;
        })
        .catch((err) => {
          console.warn('[search] picker map failed', err);
          mapPromise = null;
          pickerNotice.hidden = false;
          pickerNotice.replaceChildren(icon('alert'), h('span', {}, t('search.pick.failed')));
          return null;
        });
    }
    const m = await mapPromise;
    if (!m) return;
    m.invalidateSize();
    if (at) {
      m.setView({ lat: at.lat, lng: at.lng }, at.accuracyM && at.accuracyM > 2000 ? 12 : 15);
      chosen = { lat: at.lat, lng: at.lng, source: 'gps' };
      placePin({ accuracyM: at.accuracyM });
    } else if (chosen) {
      m.setView({ lat: chosen.lat, lng: chosen.lng }, 14);
      placePin();
    }
  }
  function hideAreaPanelIfChosen() { if (chosen) hideAreaPanel(); }

  btnPick.addEventListener('click', () => {
    if (!picker.hidden) {
      picker.hidden = true;
      btnPick.setAttribute('aria-expanded', 'false');
      return;
    }
    openPicker().then(() => pickerMapEl.focus?.());
  });
  btnCenter.addEventListener('click', async () => {
    const m = map || (await mapPromise);
    if (!m) return;
    const c = m.getCenter();
    await setPoint(c.lat, c.lng, 'map');
    placePin();
    announce(live, t('search.pick.placed'));
  });

  /* ─────────── Submit ─────────── */

  function showError(text) {
    errorEl.replaceChildren(h('p', { class: 'form-error', 'data-testid': 'search-error' }, icon('alert'), h('span', {}, text)));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (chosen && Number.isFinite(chosen.lat) && chosen.label !== t('search.chosen.finding')) {
      onSubmit({ lat: chosen.lat, lng: chosen.lng, label: chosen.label });
      return;
    }
    const q = input.value.trim();
    if (!q) { showError(t('search.form.needLocation')); input.focus(); return; }
    suggest.cancel();
    try {
      const res = await geocode(q, { submit: true });
      const rs = res.results || [];
      if (!rs.length) { renderOptions(res); input.focus(); return; }
      if (rs.length === 1 && !res.ambiguous) {
        results = rs;
        choose(0);
        if (chosen) onSubmit({ lat: chosen.lat, lng: chosen.lng, label: chosen.label });
        return;
      }
      // Several candidates: never guess — ask "Did you mean…".
      renderOptions(res, { didYouMean: true });
      input.focus();
    } catch (err) {
      if (!isAbort(err)) showError(t('search.form.geocodeDown'));
    }
  });

  onLangChange(() => {
    if (chosen) setChosen(chosen);
    if (open) renderOptions({ results, query: lastQuery });
  });

  return {
    reset() { setOpen(false); },
    focus() { input.focus(); },
    prefill(state) {
      if (state?.label && state.lat !== null) {
        chosen = { lat: state.lat, lng: state.lng, label: state.label, display: state.label, source: 'previous' };
        setChosen(chosen);
      }
    },
  };
}
