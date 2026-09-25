// Areas: gazetteer entries with geocode status/source/note and a map. Edit centre, radius, Urdu name and
// aliases with a reason (PATCH /areas/:id marks the area as manually reviewed). Ambiguous / not-found
// areas are highlighted. Area positions are APPROXIMATE and are drawn as circles, never as pins.
import {
  h, pick, maybeJson, listOf, pageHeader, card, dataTable, formField, setFieldError, showFormError, clearFormErrors, withBusy,
  loadingBlock, errorBlock, badge, notice, formatNumber, defList,
} from '../ui.js';
import { createBaseMap, round6, inDistrict } from '../map.js';

const STATUS = {
  matched: { label: 'Matched', tone: 'success' },
  manual: { label: 'Manual (reviewed)', tone: 'info' },
  ambiguous: { label: 'Ambiguous', tone: 'warn' },
  not_found: { label: 'Not found', tone: 'danger' },
  not_geocodable: { label: 'Not geocodable', tone: 'unknown' },
  not_attempted: { label: 'Not attempted', tone: 'neutral' },
};
const ATTENTION = new Set(['ambiguous', 'not_found', 'not_attempted']);
const COLOR = { matched: '#0a6d80', manual: '#2240c4', ambiguous: '#c4541f', not_found: '#b3261e' };

const A = {
  id: (a) => pick(a, 'id'),
  name: (a) => pick(a, 'name'),
  town: (a) => pick(a, 'town'),
  ur: (a) => pick(a, 'nameUr', 'name_ur'),
  aliases: (a) => { const v = maybeJson(pick(a, 'aliases', 'aliases_json', 'aliasesJson')); return Array.isArray(v) ? v : []; },
  lat: (a) => { const v = pick(a, 'latitude', 'lat'); return v === null || v === undefined || v === '' ? null : Number(v); },
  lng: (a) => { const v = pick(a, 'longitude', 'lng'); return v === null || v === undefined || v === '' ? null : Number(v); },
  radius: (a) => { const v = pick(a, 'radiusM', 'radius_m'); return v === null || v === undefined || v === '' ? null : Number(v); },
  status: (a) => pick(a, 'geocodeStatus', 'geocode_status') || 'not_attempted',
  source: (a) => pick(a, 'geocodeSource', 'geocode_source'),
  ref: (a) => pick(a, 'geocodeRef', 'geocode_ref'),
  note: (a) => pick(a, 'geocodeNote', 'geocode_note'),
  reviewed: (a) => pick(a, 'reviewedAt', 'reviewed_at'),
  count: (a) => pick(a, 'plantCount', 'plant_count', 'plants'),
};

export default {
  id: 'areas',
  title: 'Areas',
  permission: 'plants:read',
  icon: 'map',
  async render(el, ctx) {
    const canEdit = ctx.can('areas:write');
    let areas = [];
    let selectedId = ctx.query && ctx.query.id ? String(ctx.query.id) : null;
    let base = null;
    const layers = new Map();
    let handle = null;
    let editCircle = null;
    const filt = { q: '', status: (ctx.query && ctx.query.status) || '', town: '' };

    el.append(pageHeader({ title: 'Areas', subtitle: 'Area names from the spreadsheet and their approximate positions. Plants without an exact location are grouped by these areas, so check ambiguous and not-found entries first.' }));
    const fq = formField({ label: 'Search', name: 'q', type: 'search', className: 'field-grow', hint: 'Name, Urdu name, alias or town' });
    const fStatus = formField({ label: 'Geocode status', name: 'status', type: 'select', value: filt.status, options: [{ value: '', label: 'All' }, { value: 'attention', label: 'Needs attention' }, ...Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))] });
    const fTown = formField({ label: 'Town / tehsil', name: 'town', type: 'select', options: [{ value: '', label: 'All towns' }] });
    const toolbar = h('form', { class: 'toolbar', role: 'search', 'aria-label': 'Filter areas' }, fq, fStatus, fTown);
    const summary = h('div');
    const tableBox = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading areas…'));
    const mapEl = h('div', { class: 'map map-lg', role: 'application', 'aria-label': 'Map of area circles. Select an area in the table to edit it.' });
    const mapWrap = h('div', { class: 'map-wrap' }, mapEl);
    const editorBox = h('div');
    const placeholder = () => card('Edit an area', h('p', { class: 'muted' }, canEdit
      ? 'Choose “Edit” in the table below, or click a circle on the map. Areas that are ambiguous or not found are listed first and highlighted.'
      : 'Choose “Show” in the table below, or click a circle on the map, to see an area’s details.'));
    editorBox.append(placeholder());
    el.append(summary, h('div', { class: 'split' }, card('Map', h('p', { class: 'card-sub' }, 'Circles show approximate area extents (never plant positions). Dashed grey outline: Faisalabad district.'), mapWrap), editorBox), toolbar, tableBox);

    toolbar.addEventListener('submit', (e) => e.preventDefault());
    fq.control.addEventListener('input', () => { filt.q = fq.control.value.trim().toLowerCase(); drawTable(); });
    fStatus.control.addEventListener('change', () => { filt.status = fStatus.control.value; drawTable(); });
    fTown.control.addEventListener('change', () => { filt.town = fTown.control.value; drawTable(); });

    const visible = () => areas.filter((a) => {
      const st = A.status(a);
      if (filt.status === 'attention' && !ATTENTION.has(st)) return false;
      if (filt.status && filt.status !== 'attention' && st !== filt.status) return false;
      if (filt.town && A.town(a) !== filt.town) return false;
      if (filt.q) {
        const hay = [A.name(a), A.ur(a), A.town(a), ...A.aliases(a)].join(' ').toLowerCase();
        if (!hay.includes(filt.q)) return false;
      }
      return true;
    });

    function drawSummary() {
      const by = {};
      for (const a of areas) by[A.status(a)] = (by[A.status(a)] || 0) + 1;
      summary.replaceChildren(h('ul', { class: 'chips', 'aria-label': 'Areas by geocode status' },
        h('li', { class: 'chip' }, h('span', { class: 'chip-value' }, formatNumber(areas.length)), h('span', { class: 'chip-label' }, 'Areas')),
        Object.entries(STATUS).filter(([k]) => by[k]).map(([k, s]) => h('li', { class: `chip${ATTENTION.has(k) ? ' chip-warn' : ''}` }, h('span', { class: 'chip-value' }, formatNumber(by[k])), h('span', { class: 'chip-label' }, s.label)))));
    }

    function drawTable() {
      const rows = visible();
      tableBox.replaceChildren(dataTable({
        caption: `Areas (${formatNumber(rows.length)} of ${formatNumber(areas.length)})`,
        rowAttrs: (a) => ({ class: String(A.id(a)) === selectedId ? 'row-selected' : ATTENTION.has(A.status(a)) ? 'row-highlight' : null }),
        columns: [
          { key: 'name', label: 'Area', rowHeader: true, render: (a) => h('span', null, h('span', { dir: 'auto' }, A.name(a) || '—'), A.ur(a) ? h('span', { class: 'muted', lang: 'ur', dir: 'rtl', style: 'display:block' }, A.ur(a)) : null, A.aliases(a).length ? h('span', { class: 'small muted', style: 'display:block' }, 'Aliases: ', h('span', { dir: 'auto' }, A.aliases(a).join(', '))) : null) },
          { key: 'town', label: 'Town', render: (a) => A.town(a) || '—' },
          { key: 'status', label: 'Geocode status', render: (a) => { const s = STATUS[A.status(a)] || { label: A.status(a), tone: 'neutral' }; return badge(s.label, s.tone); } },
          { key: 'source', label: 'Source & note', render: (a) => h('span', { class: 'small' }, A.source(a) || h('span', { class: 'np' }, 'No source'), A.note(a) ? h('span', { style: 'display:block', dir: 'auto' }, A.note(a)) : null) },
          { key: 'pos', label: 'Centre / radius', render: (a) => (A.lat(a) !== null && A.lng(a) !== null ? h('span', { class: 'mono small' }, `${A.lat(a).toFixed(5)}, ${A.lng(a).toFixed(5)}`, h('br'), A.radius(a) ? `r ≈ ${formatNumber(Math.round(A.radius(a)))} m` : 'no radius') : h('span', { class: 'np' }, 'No position')) },
          { key: 'plants', label: 'Plants', align: 'end', render: (a) => (A.count(a) === undefined || A.count(a) === null ? '—' : formatNumber(A.count(a))) },
          { key: 'reviewed', label: 'Reviewed', render: (a) => (A.reviewed(a) ? ctx.formatDate(A.reviewed(a)) : h('span', { class: 'np' }, 'Not reviewed')) },
          { key: 'act', label: 'Action', className: 'actions', render: (a) => h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'aria-label': `${canEdit ? 'Edit' : 'Show'} ${A.name(a)} (${A.town(a) || ''})`, onClick: () => select(String(A.id(a)), true) }, canEdit ? 'Edit' : 'Show') },
        ],
        rows,
        empty: 'No areas match these filters.',
      }));
    }

    function drawMap() {
      if (!base) return;
      const { L, map } = base;
      layers.forEach((l) => l.remove());
      layers.clear();
      const pts = [];
      for (const a of areas) {
        const la = A.lat(a); const ln = A.lng(a);
        if (la === null || ln === null) continue;
        const color = COLOR[A.status(a)] || '#4e6a7a';
        const c = L.circle([la, ln], { radius: A.radius(a) || 800, color, weight: String(A.id(a)) === selectedId ? 4 : 2, fillOpacity: 0.12, dashArray: A.status(a) === 'manual' ? null : '5 5' })
          .addTo(map).bindTooltip(`${A.name(a)} (${A.town(a) || ''}) — ${(STATUS[A.status(a)] || {}).label || A.status(a)}`);
        c.on('click', () => select(String(A.id(a)), false));
        layers.set(String(A.id(a)), c);
        pts.push([la, ln]);
      }
      if (pts.length && !selectedId) map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
    }

    function clearEditLayers() { handle?.remove(); handle = null; editCircle?.remove(); editCircle = null; }

    function select(id, focusForm) {
      selectedId = id;
      ctx.setQuery({ status: filt.status, id });
      drawTable();
      layers.forEach((l, k) => l.setStyle({ weight: k === id ? 4 : 2 }));
      const a = areas.find((x) => String(A.id(x)) === id);
      clearEditLayers();
      if (!a) { editorBox.replaceChildren(placeholder()); return; }
      editorBox.replaceChildren(editor(a));
      if (base && A.lat(a) !== null) base.map.setView([A.lat(a), A.lng(a)], 14);
      if (focusForm) editorBox.querySelector('h2')?.setAttribute('tabindex', '-1');
      if (focusForm) { editorBox.scrollIntoView({ block: 'start' }); editorBox.querySelector('h2')?.focus({ preventScroll: true }); }
    }

    function editor(a) {
      const st = STATUS[A.status(a)] || { label: A.status(a), tone: 'neutral' };
      const info = defList([
        ['Status', badge(st.label, st.tone)],
        ['Source', A.source(a)],
        ['Provider reference', A.ref(a)],
        ['Note', A.note(a)],
        ['Plants', A.count(a) ?? null],
        ['Reviewed', A.reviewed(a) ? ctx.formatDate(A.reviewed(a)) : null],
      ]);
      const warn = ATTENTION.has(A.status(a)) ? notice('warn', h('p', null, A.status(a) === 'ambiguous'
        ? 'The geocoder found several places with this name. Check that the circle is on the right one before marking it reviewed.'
        : A.status(a) === 'not_found' ? 'No position was found. Set a centre only if you are confident where this area is.' : 'This area has not been geocoded.')) : null;
      const generic = A.status(a) === 'not_geocodable' ? notice('info', h('p', null, 'This is a generic label (not a place name). Leave the position empty unless a document identifies the place.')) : null;
      if (!canEdit) return card(`Area: ${A.name(a)}`, warn, generic, info);

      const fLat = formField({ label: 'Centre latitude', name: 'latitude', type: 'number', value: A.lat(a) ?? '', attrs: { step: 'any', min: '-90', max: '90', inputmode: 'decimal' } });
      const fLng = formField({ label: 'Centre longitude', name: 'longitude', type: 'number', value: A.lng(a) ?? '', attrs: { step: 'any', min: '-180', max: '180', inputmode: 'decimal' } });
      const fRad = formField({ label: 'Radius (metres)', name: 'radiusM', type: 'number', value: A.radius(a) ?? '', hint: 'Rough extent of the area.', attrs: { step: '50', min: '50', max: '20000', inputmode: 'numeric' } });
      const fUr = formField({ label: 'Urdu name', name: 'nameUr', value: A.ur(a) ?? '', hint: 'Search alias; not an official translation.', dir: 'rtl', attrs: { lang: 'ur', maxlength: '200' } });
      const fAl = formField({ label: 'Aliases (one per line)', name: 'aliases', type: 'textarea', rows: 3, value: A.aliases(a).join('\n'), hint: 'Spelling variants, Roman Urdu or Urdu. Used for search only.', dir: 'auto' });
      const fReason = formField({ label: 'Reason', name: 'reason', type: 'textarea', rows: 2, required: true, dir: 'auto', hint: 'Required. How you confirmed the position or names.' });
      const form = h('form', { novalidate: true, 'aria-label': `Edit area ${A.name(a)}` },
        h('div', { class: 'form-grid' }, fLat, fLng, fRad), fUr, fAl, fReason,
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save & mark reviewed'),
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => { selectedId = null; ctx.setQuery({ status: filt.status }); clearEditLayers(); editorBox.replaceChildren(placeholder()); drawTable(); } }, 'Close')),
        h('p', { class: 'hint' }, 'Tip: drag the round handle on the map, or click the map, to move the centre.'));

      // Live map editing
      const syncMap = () => {
        if (!base) return;
        const la = parseFloat(fLat.control.value); const ln = parseFloat(fLng.control.value);
        const r = parseFloat(fRad.control.value) || 800;
        if (!Number.isFinite(la) || !Number.isFinite(ln)) { clearEditLayers(); return; }
        const { L, map } = base;
        if (!editCircle) editCircle = L.circle([la, ln], { radius: r, color: '#2240c4', weight: 3, fillOpacity: 0.1 }).addTo(map);
        else { editCircle.setLatLng([la, ln]); editCircle.setRadius(r); }
        if (!handle) {
          handle = L.marker([la, ln], { draggable: true, keyboard: false, title: 'Area centre (drag to move)', icon: L.divIcon({ className: 'area-handle', iconSize: [22, 22] }) }).addTo(map);
          handle.on('drag', () => editCircle && editCircle.setLatLng(handle.getLatLng()));
          handle.on('dragend', () => { const p = handle.getLatLng(); fLat.control.value = String(round6(p.lat)); fLng.control.value = String(round6(p.lng)); });
        } else handle.setLatLng([la, ln]);
      };
      [fLat, fLng, fRad].forEach((f) => f.control.addEventListener('input', syncMap));
      const onMapClick = (e) => { if (!form.isConnected) { base.map.off('click', onMapClick); return; } fLat.control.value = String(round6(e.latlng.lat)); fLng.control.value = String(round6(e.latlng.lng)); syncMap(); };
      if (base) base.map.on('click', onMapClick);
      setTimeout(syncMap, 0);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        const latS = fLat.control.value.trim(); const lngS = fLng.control.value.trim(); const radS = fRad.control.value.trim();
        let bad = false;
        const la = latS === '' ? null : Number(latS); const ln = lngS === '' ? null : Number(lngS); const rad = radS === '' ? null : Number(radS);
        if ((la === null) !== (ln === null)) { setFieldError(la === null ? fLat.control : fLng.control, 'Give both latitude and longitude, or neither.'); bad = true; }
        if (la !== null && (!Number.isFinite(la) || la < -90 || la > 90)) { setFieldError(fLat.control, 'Latitude must be between -90 and 90.'); bad = true; }
        if (ln !== null && (!Number.isFinite(ln) || ln < -180 || ln > 180)) { setFieldError(fLng.control, 'Longitude must be between -180 and 180.'); bad = true; }
        if (rad !== null && (!Number.isFinite(rad) || rad <= 0)) { setFieldError(fRad.control, 'Radius must be a positive number of metres.'); bad = true; }
        const reason = fReason.control.value.trim();
        if (!reason) { setFieldError(fReason.control, 'Please give a reason.'); bad = true; }
        if (bad) { showFormError(form, 'Check the highlighted fields.', { focus: false }); form.querySelector('[aria-invalid="true"]')?.focus(); return; }
        if (la !== null && !inDistrict(la, ln)) {
          const { confirmed } = await ctx.confirmDialog({ title: 'Centre is outside Faisalabad district', body: 'Save this position anyway?', confirmLabel: 'Save anyway' });
          if (!confirmed) return;
        }
        const aliases = fAl.control.value.split('\n').map((s) => s.trim()).filter(Boolean);
        const body = { latitude: la === null ? null : round6(la), longitude: ln === null ? null : round6(ln), radiusM: rad, nameUr: fUr.control.value.trim() || null, aliases, reason };
        const btn = form.querySelector('button[type=submit]');
        try {
          await withBusy(btn, () => ctx.api(`/areas/${encodeURIComponent(A.id(a))}`, { method: 'PATCH', json: body }), 'Saving…');
          ctx.toast(`Area “${A.name(a)}” saved and marked as reviewed.`, 'success');
          await load();
          select(String(A.id(a)), true);
        } catch (err) { showFormError(form, err); }
      });

      return card(`Edit area: ${A.name(a)}${A.town(a) ? ` (${A.town(a)})` : ''}`, warn, generic, info, form);
    }

    async function load() {
      let data;
      try { data = await ctx.api('/areas'); } catch (err) { tableBox.replaceChildren(errorBlock(err, load)); return; }
      if (!ctx.isCurrent()) return;
      areas = listOf(data, 'areas').filter((a) => (pick(a, 'kind') || 'area') !== 'town' || true);
      areas.sort((x, y) => (ATTENTION.has(A.status(y)) - ATTENTION.has(A.status(x))) || String(A.town(x)).localeCompare(String(A.town(y))) || String(A.name(x)).localeCompare(String(A.name(y))));
      const towns = [...new Set(areas.map(A.town).filter(Boolean))].sort();
      const cur = fTown.control.value;
      fTown.control.replaceChildren(h('option', { value: '' }, 'All towns'), ...towns.map((t) => h('option', { value: t }, t)));
      fTown.control.value = cur;
      drawSummary();
      drawTable();
      drawMap();
    }

    await load();
    createBaseMap(mapEl).then((b) => {
      if (!ctx.isCurrent()) { b.destroy(); return; }
      base = b;
      drawMap();
      if (selectedId) select(selectedId, false);
    }).catch((err) => { mapWrap.replaceChildren(h('div', { class: 'map map-fallback' }, h('p', null, `The map could not be loaded (${err.message}). You can still edit positions with the fields.`))); if (selectedId) select(selectedId, false); });
    return () => { base?.destroy(); };
  },
};
