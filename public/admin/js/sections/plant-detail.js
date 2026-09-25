// Plant detail (#/plants/:code): every field next to the ORIGINAL source values, traceability, editing with a
// reason, map pin / coordinates, status change with documented assessment, verification, water tests,
// sources, report counts and recent audit entries.
import {
  h, pick, maybeJson, listOf, pageHeader, card, defList, dataTable, formField, setFieldError, showFormError, clearFormErrors,
  withBusy, displayValue, notProvided, notice, badge, loadingBlock, errorBlock, formatNumber, todayIso, keyLabel,
  redactPhones, safeUrl, uid, replace, append,
} from '../ui.js';
import {
  plantCode, plantName, isDemo, needsReview, precisionBadge, statusBadge, demoBadge, statusCode, statusSource, coordStatus, latLng,
  STATUS_LABEL, STATUS_SOURCE_LABEL, COORD_LABEL, reviewReasons, issueLabel,
} from '../plant-util.js';
import { auditTable } from '../audit-view.js';
import { createPinMap, inDistrict, round6 } from '../map.js';

// ── Field catalogue ──
// `headers` are the source-file column names that hold the original value (first match wins, case-insensitive).
const COMPARE_FIELDS = [
  { label: 'Plant ID', value: (p) => pick(p, 'plant_code', 'code'), headers: ['Plant ID', 'Plant Code', 'ID'] },
  { label: 'Plant name', value: (p) => pick(p, 'name'), headers: ['Name', 'Plant Name', 'Site Name'] },
  { label: 'Town / tehsil', value: (p) => pick(p, 'town'), headers: ['Town/Tehsil', 'Town', 'Tehsil'] },
  { label: 'Area (as recorded)', value: (p) => pick(p, 'area_raw', 'areaRaw'), headers: ['Area/Union Council', 'Area', 'Union Council'] },
  { label: 'Area (parsed)', value: (p) => [pick(p, 'area_name', 'areaName'), pick(p, 'area_sector', 'areaSector')].filter(Boolean).join(' · ') || null },
  { label: 'Street address', value: (p) => pick(p, 'address'), headers: ['Address', 'Street Address'] },
  { label: 'Neighbourhood', value: (p) => pick(p, 'neighborhood'), headers: ['Neighborhood', 'Neighbourhood', 'Mohalla'] },
  { label: 'Landmark', value: (p) => pick(p, 'landmark'), headers: ['Landmark'] },
  { label: 'Coordinates', value: (p) => { const { lat, lng } = latLng(p); return lat !== null && lng !== null ? `${lat}, ${lng}` : null; }, headers: ['Latitude', 'Lat'], headers2: ['Longitude', 'Lng', 'Lon'] },
  { label: 'Operator type', value: (p) => pick(p, 'operator_type', 'operator.type', 'operatorType'), headers: ['Operating Entity Type', 'Operator Type'] },
  { label: 'Operator name', value: (p) => pick(p, 'operator_name', 'operator.name', 'operatorName'), headers: ['Operator', 'Operator Name'] },
  { label: 'Water source', value: (p) => pick(p, 'water_source', 'waterSource'), headers: ['Water Source', 'Source'] },
  { label: 'Filtration technology', value: (p) => pick(p, 'technology_raw', 'technology.raw', 'technologyRaw'), headers: ['Filtration Technology', 'Technology'] },
  { label: 'Treatment stages (derived)', value: (p) => { const s = maybeJson(pick(p, 'treatment_stages_json', 'technology.stages', 'treatmentStages')); return Array.isArray(s) ? (s.length ? s.join(', ') : 'None recorded') : null; } },
  { label: 'Capacity', value: (p) => pick(p, 'capacity_raw', 'capacity.raw', 'capacityRaw'), headers: ['Capacity (Gallons Per Hour)', 'Capacity'] },
  { label: 'Gallon type', value: (p) => pick(p, 'capacity_gallon_type', 'capacity.gallonType', 'capacityGallonType') },
  { label: 'Collection limit (per person)', value: (p) => pick(p, 'collection_limit_raw', 'collectionLimitRaw') ?? ([pick(p, 'collection_limit_value'), pick(p, 'collection_limit_unit'), pick(p, 'collection_limit_period')].filter((x) => x !== null && x !== undefined).join(' ') || null), headers: ['Collection Limit'] },
  { label: 'Opening hours', value: (p) => pick(p, 'opening_hours_text', 'openingHours.text', 'openingHoursText'), headers: ['Opening Hours', 'Hours', 'Timings'] },
  { label: 'Operational status', value: (p) => { const c = statusCode(p); const raw = pick(p, 'status_raw', 'status.raw', 'statusRaw'); return c ? `${STATUS_LABEL[c] || c}${raw ? ` (recorded: “${raw}”)` : ''}` : null; }, headers: ['Operational Status', 'Status'] },
  { label: 'Public contact number', value: (p) => (pick(p, 'public_phone', 'publicPhone') ? 'On file (hidden in the dashboard)' : null), headers: [], private: true },
  { label: 'Accessibility', value: (p) => pick(p, 'accessibility'), headers: ['Accessibility'] },
];

// Fields editable through PATCH /plants/:code (keys are the column names).
const EDIT_FIELDS = [
  { col: 'name', label: 'Plant name', max: 200 },
  { col: 'address', label: 'Street address', max: 300 },
  { col: 'neighborhood', label: 'Neighbourhood / mohalla', max: 200 },
  { col: 'landmark', label: 'Landmark', max: 200 },
  { col: 'operator_name', label: 'Operator name', max: 200, hint: 'The actual operating organisation. The source only records an operator type.' },
  { col: 'operator_type', label: 'Operator type (correction)', max: 200, hint: 'Corrects the recorded type. The original stays in the source values.' },
  { col: 'water_source', label: 'Water source (correction)', max: 200, hint: 'The original stays in the source values.' },
  { col: 'technology_raw', label: 'Filtration technology (correction)', max: 200, hint: 'Treatment stages are re-derived only for known technologies.' },
  { col: 'opening_hours_text', label: 'Opening hours', max: 300, hint: 'As confirmed, e.g. “Daily 08:00–20:00”.' },
  { col: 'collection_limit_raw', label: 'Collection limit as stated', max: 200, hint: 'e.g. “20 litres per visit”, as written by the operator or a notice.' },
  { col: 'collection_limit_value', label: 'Collection limit (per person)', type: 'number', attrs: { min: '0', step: 'any' }, hint: 'Leave empty if unknown. This is separate from production capacity.' },
  { col: 'collection_limit_unit', label: 'Collection limit unit', type: 'select', options: [{ value: '', label: 'Not set' }, { value: 'litres', label: 'Litres' }, { value: 'gallons', label: 'Gallons' }] },
  { col: 'collection_limit_period', label: 'Collection limit period', type: 'select', options: [{ value: '', label: 'Not set' }, { value: 'per_visit', label: 'Per visit' }, { value: 'per_day', label: 'Per day' }] },
  { col: 'capacity_gallon_type', label: 'Capacity gallon type', type: 'select', options: [{ value: 'unspecified', label: 'Not specified (no litre conversion)' }, { value: 'us', label: 'US gallons' }, { value: 'imperial', label: 'Imperial gallons' }, { value: 'not_applicable', label: 'Not applicable' }], hint: 'Only set when a document states the gallon type.' },
  { col: 'public_contact_note', label: 'Public contact note', max: 300 },
  { col: 'accessibility', label: 'Accessibility', type: 'textarea', max: 1000 },
  { col: 'needs_review', label: 'Flag this plant for data review', type: 'checkbox' },
];

const SECTIONS = [
  ['pd-details', 'Record & source'], ['pd-edit', 'Edit'], ['pd-location', 'Location'], ['pd-status', 'Status'],
  ['pd-verify', 'Verification'], ['pd-tests', 'Water tests'], ['pd-sources', 'Sources'], ['pd-reports', 'Reports'], ['pd-audit', 'Audit'],
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const PHONE_HEADER = /phone|mobile|contact|tel|helpline/i;

function sourceLookup(sourceValues, headers) {
  if (!sourceValues || !headers || !headers.length) return undefined;
  const keys = Object.keys(sourceValues);
  for (const want of headers) {
    const k = keys.find((x) => norm(x) === norm(want));
    if (k !== undefined) return { header: k, value: sourceValues[k] };
  }
  return undefined;
}

function sourceCell(sv, f) {
  if (f.private) return h('span', { class: 'np' }, '—');
  const a = sourceLookup(sv, f.headers);
  const b = f.headers2 ? sourceLookup(sv, f.headers2) : undefined;
  if (!a && !b) return h('span', { class: 'np' }, sv ? 'Not in source' : 'No source row');
  const parts = [a, b].filter(Boolean);
  return h('span', { class: 'compare-source' }, parts.map((x, i) => [
    i ? h('br') : null,
    blank(x.value) ? h('span', { class: 'np' }, '(empty)') : h('span', { dir: 'auto' }, redactPhones(String(x.value))),
    h('span', { class: 'source-note' }, ` — “${x.header}”`),
  ]));
}

const testField = (t, ...k) => pick(t, ...k);

export default {
  id: 'plant-detail',
  title: 'Plant',
  permission: 'plants:read',
  icon: 'droplet',
  async render(el, ctx) {
    const code = ctx.params.code;
    const maps = [];
    const destroyMaps = () => { while (maps.length) { try { maps.pop()(); } catch { /* ignore */ } } };
    let data = null;
    let plant = null;
    let areaInfo = null;
    const root = h('div');
    el.append(h('p', { class: 'breadcrumb' }, h('a', { href: '#/plants' }, '← All plants')), root);

    async function fetchPlant() {
      data = await ctx.api(`/plants/${encodeURIComponent(code)}`);
      plant = data && data.plant && typeof data.plant === 'object' ? { ...data, ...data.plant } : data;
      const loc = pick(data, 'summary.location');
      if (loc && !pick(plant, 'location')) plant.location = loc;
      areaInfo = pick(plant, 'area', 'location.area');
      if ((!areaInfo || typeof areaInfo !== 'object') && pick(plant, 'area_id', 'areaId')) {
        try {
          const areas = listOf(await ctx.api('/areas'), 'areas');
          const a = areas.find((x) => String(pick(x, 'id')) === String(pick(plant, 'area_id', 'areaId')));
          if (a) areaInfo = a;
        } catch { /* optional */ }
      }
    }

    async function refresh(focusId) {
      try { await fetchPlant(); } catch (err) { ctx.toast(`Saved, but the page could not be refreshed: ${err.message}`, 'error'); return; }
      if (!ctx.isCurrent()) return;
      draw();
      if (focusId) {
        const target = document.getElementById(focusId);
        if (target) { target.scrollIntoView({ block: 'start' }); target.querySelector('h2')?.setAttribute('tabindex', '-1'); target.querySelector('h2')?.focus({ preventScroll: true }); }
      }
    }

    function draw() {
      destroyMaps();
      const title = `${code}${plantName(plant) ? ` — ${plantName(plant)}` : ''}`;
      document.title = `${code} · Team Water Admin`;
      const head = pageHeader({
        eyebrow: 'Plant record',
        title,
        subtitle: [pick(plant, 'area_raw', 'areaRaw'), pick(plant, 'town')].filter(Boolean).join(' · ') || null,
      });
      const badges = h('div', { class: 'plant-head badges', 'aria-label': 'Record flags' },
        isDemo(plant) ? demoBadge() : null, precisionBadge(plant), statusBadge(plant),
        needsReview(plant) ? badge('Needs data review', 'warn') : null,
        plantName(plant) ? null : badge('Name not provided', 'unknown'));
      head.querySelector('.page-header-text').append(badges);

      const nav = h('ul', { class: 'local-nav', 'aria-label': 'Jump to' }, SECTIONS.map(([id, label]) => h('li', null, h('button', {
        type: 'button', onClick: () => { const c = document.getElementById(id); if (!c) return; c.scrollIntoView({ block: 'start' }); const hd = c.querySelector('h2'); hd?.setAttribute('tabindex', '-1'); hd?.focus({ preventScroll: true }); },
      }, label))));

      replace(root,
        head,
        isDemo(plant) ? notice('demo', h('p', null, h('strong', null, 'DEMO — not a real plant. '), 'This record exists only because demonstration data is switched on.')) : null,
        nav,
        detailsCard(),
        ctx.can('plants:write') ? editCard() : null,
        locationCard(),
        statusCard(),
        verifyCard(),
        testsCard(),
        sourcesCard(),
        reportsCard(),
        auditCard(),
      );
      for (const [id] of SECTIONS) { const c = root.querySelector(`[data-card="${id}"]`); if (c) c.id = id; }
    }

    const withId = (node, id) => { node.dataset.card = id; return node; };

    // ── Record & source values ──
    function detailsCard() {
      const sv = maybeJson(pick(data, 'sourceValues', 'source_values', 'plant.source_values_json')) || maybeJson(pick(plant, 'source_values_json', 'sourceValuesJson'));
      const tr = pick(data, 'traceability') || {};
      const batchId = pick(tr, 'batchId', 'importBatchId') ?? pick(plant, 'import_batch_id', 'importBatchId');
      const trace = defList([
        ['Source file', pick(tr, 'sourceFile', 'source_file') ?? pick(plant, 'source_file', 'sourceFile')],
        ['Sheet', pick(tr, 'sheet', 'sourceSheet') ?? pick(plant, 'source_sheet', 'sourceSheet')],
        ['Row', pick(tr, 'row', 'sourceRow') ?? pick(plant, 'source_row', 'sourceRow')],
        ['Import batch', batchId !== undefined && batchId !== null ? h('a', { href: '#/imports' }, `Batch #${batchId}`) : null],
        ['Imported at', ctx.formatDate(pick(tr, 'importedAt', 'imported_at') ?? pick(plant, 'imported_at', 'importedAt'))],
        ['Record updated', ctx.formatDate(pick(plant, 'updated_at', 'updatedAt'))],
      ]);
      const reasons = reviewReasons(plant);
      const compare = dataTable({
        caption: 'Current values compared with the original source values (read-only)',
        className: 'compare-table',
        columns: [
          { key: 'label', label: 'Field', rowHeader: true, render: (f) => f.label },
          { key: 'cur', label: 'Current value', render: (f) => displayValue(f.value(plant)) },
          { key: 'src', label: 'Original source value', render: (f) => sourceCell(sv, f) },
        ],
        rows: COMPARE_FIELDS,
      });
      const verbatim = sv && typeof sv === 'object'
        ? h('details', { class: 'expander' },
          h('summary', null, `Complete original row, verbatim (${Object.keys(sv).length} columns)`),
          dataTable({
            caption: 'Original source row (verbatim, read-only)',
            columns: [
              { key: 'k', label: 'Column header', rowHeader: true, render: (r) => h('span', { dir: 'auto' }, r[0]) },
              { key: 'v', label: 'Value as recorded', render: (r) => (PHONE_HEADER.test(r[0]) && !blank(r[1]) ? h('span', { class: 'np' }, 'Contact number (hidden)') : blank(r[1]) ? h('span', { class: 'np' }, '(empty)') : h('span', { dir: 'auto' }, redactPhones(String(r[1])))) },
            ],
            rows: Object.entries(sv),
          }))
        : notice('info', h('p', null, 'This record has no original source row (created in the dashboard or demo data).'));
      return withId(card('Record & original source values',
        h('p', { class: 'card-sub' }, 'The spreadsheet is the source. Original values are kept verbatim and never changed by edits.'),
        h('div', { class: 'split' },
          h('div', null, h('h3', null, 'Traceability'), trace),
          h('div', null, h('h3', null, 'Data issues'),
            reasons.length ? h('ul', { class: 'badges', style: 'list-style:none;padding:0;margin:0' }, reasons.map((r) => h('li', null, badge(issueLabel(r), 'warn', { title: r })))) : h('p', { class: 'np' }, 'None recorded'))),
        h('h3', null, 'Field by field'),
        compare,
        verbatim), 'pd-details');
    }

    // ── Edit ──
    function editCard() {
      const controls = new Map();
      const grid = h('div', { class: 'form-grid' });
      for (const f of EDIT_FIELDS) {
        const cur = pick(plant, f.col);
        const w = formField({
          label: f.label, name: f.col, type: f.type || 'text', hint: f.hint, options: f.options,
          value: f.type === 'checkbox' ? !!Number(cur) || cur === true : cur ?? (f.type === 'select' ? '' : ''),
          attrs: { ...(f.max ? { maxlength: String(f.max) } : {}), ...(f.attrs || {}) },
          dir: !f.type || f.type === 'textarea' ? 'auto' : null,
          className: f.type === 'textarea' ? 'span-all' : '',
        });
        controls.set(f.col, w.control);
        grid.append(w);
      }
      // Public phone: write-only (phone numbers are never displayed in the dashboard).
      const hasPhone = !blank(pick(plant, 'public_phone', 'publicPhone'));
      const phone = formField({ label: 'Replace public contact number', name: 'public_phone', type: 'tel', hint: `The plant's own published number only — never a reporter's. ${hasPhone ? 'A number is on file (not shown here).' : 'No number on file.'} Leave empty to keep it unchanged.`, attrs: { autocomplete: 'off', inputmode: 'tel', maxlength: '30' } });
      const phoneRemove = hasPhone ? formField({ label: 'Remove the public contact number', name: 'public_phone_remove', type: 'checkbox' }) : null;
      append(grid, [phone, phoneRemove]);
      const reason = formField({ label: 'Reason for this change', name: 'reason', type: 'textarea', required: true, rows: 2, hint: 'Required. Say how you know (site visit, operator, document). Recorded in the audit log.', dir: 'auto', className: 'span-all' });
      grid.append(reason);
      const form = h('form', { novalidate: true, 'aria-label': 'Edit plant details' }, grid,
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes'),
          h('span', { class: 'hint' }, 'Only changed fields are sent.')));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        const changes = {};
        for (const f of EDIT_FIELDS) {
          const c = controls.get(f.col);
          const cur = pick(plant, f.col);
          if (f.type === 'checkbox') {
            const now = c.checked;
            if (now !== (!!Number(cur) || cur === true)) changes[f.col] = now;
          } else if (f.type === 'number') {
            const v = c.value.trim() === '' ? null : Number(c.value);
            if (v !== null && !Number.isFinite(v)) { setFieldError(c, 'Enter a number.'); showFormError(form, 'Enter a valid number.', { focus: false }); c.focus(); return; }
            if (v !== (cur === null || cur === undefined || cur === '' ? null : Number(cur))) changes[f.col] = v;
          } else {
            const v = c.value.trim() === '' ? null : c.value.trim();
            if (v !== (blank(cur) ? null : String(cur))) changes[f.col] = v;
          }
        }
        const newPhone = phone.control.value.trim();
        if (phoneRemove && phoneRemove.control.checked) changes.public_phone = null;
        else if (newPhone) {
          if (!/^[+0-9][0-9\s-]{6,24}$/.test(newPhone)) { setFieldError(phone.control, 'Enter digits, spaces, dashes and an optional leading +.'); showFormError(form, 'The contact number format is not valid.', { focus: false }); phone.control.focus(); return; }
          changes.public_phone = newPhone;
        }
        if (Object.keys(changes).length === 0) { showFormError(form, 'Nothing has changed — edit a field before saving.'); return; }
        const r = reason.control.value.trim();
        if (r.length < 3) { setFieldError(reason.control, 'Please give a reason for this change (at least 3 characters).'); showFormError(form, 'A reason is required for every change.', { focus: false }); reason.control.focus(); return; }
        const btn = form.querySelector('button[type=submit]');
        try {
          await withBusy(btn, () => ctx.api(`/plants/${encodeURIComponent(code)}`, { method: 'PATCH', json: { ...changes, reason: r } }), 'Saving…');
          ctx.toast(`Saved ${Object.keys(changes).length} change${Object.keys(changes).length === 1 ? '' : 's'} to ${code}.`, 'success');
          await refresh('pd-edit');
        } catch (err) { showFormError(form, err); }
      });
      return withId(card('Edit details', h('p', { class: 'card-sub' }, 'Corrections and additions confirmed by staff. Source values stay unchanged above. Location, status and verification have their own forms below.'), form), 'pd-edit');
    }

    // ── Location ──
    function locationCard() {
      const { lat, lng } = latLng(plant);
      const cs = coordStatus(plant);
      const has = lat !== null && lng !== null;
      const areaLat = areaInfo ? Number(pick(areaInfo, 'lat', 'latitude')) : NaN;
      const areaLng = areaInfo ? Number(pick(areaInfo, 'lng', 'longitude')) : NaN;
      const areaName = areaInfo ? pick(areaInfo, 'name') : null;
      const info = defList([
        ['Location status', cs ? badge(COORD_LABEL[cs] || cs, cs === 'verified' ? 'success' : cs === 'missing' ? 'unknown' : 'warn') : null],
        ['Latitude', has ? h('span', { class: 'mono' }, String(lat)) : null],
        ['Longitude', has ? h('span', { class: 'mono' }, String(lng)) : null],
        ['Position source', pick(plant, 'coord_source', 'coordSource')],
        ['Position note', pick(plant, 'coord_note', 'coordNote')],
        ['Approximate area', areaName ? h('span', { dir: 'auto' }, `${areaName}${Number.isFinite(areaLat) ? ' (area centre known — approximate only)' : ' (no area position)'}`) : null],
      ]);
      const mapEl = h('div', { class: 'map', role: 'application', 'aria-label': 'Map: drag the pin or click to place it. The latitude and longitude fields below do the same.' });
      const mapWrap = h('div', { class: 'map-wrap' }, mapEl);

      const fLat = formField({ label: 'Latitude', name: 'lat', type: 'number', value: has ? lat : '', required: true, hint: 'Decimal degrees, about 31.4 in Faisalabad.', attrs: { step: 'any', min: '-90', max: '90', inputmode: 'decimal' } });
      const fLng = formField({ label: 'Longitude', name: 'lng', type: 'number', value: has ? lng : '', required: true, hint: 'Decimal degrees, about 73.1 in Faisalabad.', attrs: { step: 'any', min: '-180', max: '180', inputmode: 'decimal' } });
      const fNote = formField({ label: 'How was this position confirmed?', name: 'note', type: 'textarea', rows: 2, required: true, hint: 'Required, e.g. “Pinned during site visit on 3 Sep, entrance gate”. Recorded in the audit log.', dir: 'auto', className: 'span-all' });
      const form = h('form', { novalidate: true, 'aria-label': 'Set plant coordinates' },
        h('div', { class: 'form-grid' }, fLat, fLng, fNote),
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save verified position'),
          has ? h('button', { type: 'button', class: 'btn btn-danger-outline', onClick: clearCoords }, 'Clear coordinates') : null));

      let pin = null;
      const syncFromInputs = () => {
        const la = parseFloat(fLat.control.value); const ln = parseFloat(fLng.control.value);
        if (pin && Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) pin.set(la, ln);
      };
      fLat.control.addEventListener('change', syncFromInputs);
      fLng.control.addEventListener('change', syncFromInputs);

      createPinMap(mapEl, {
        lat: has ? lat : null, lng: has ? lng : null,
        context: Number.isFinite(areaLat) && Number.isFinite(areaLng) ? { lat: areaLat, lng: areaLng, radiusM: Number(pick(areaInfo, 'radiusM', 'radius_m')) || 1000, label: `Approximate area: ${areaName || ''}` } : null,
        onChange: (la, ln) => { fLat.control.value = String(la); fLng.control.value = String(ln); setFieldError(fLat.control, null); setFieldError(fLng.control, null); },
        draggable: ctx.can('plants:write'),
      }).then((m) => { if (!ctx.isCurrent() || !mapEl.isConnected) { m.destroy(); return; } pin = m; maps.push(() => m.destroy()); })
        .catch((err) => { mapWrap.replaceChildren(h('div', { class: 'map map-fallback' }, h('p', null, `The map could not be loaded (${err.message}). Use the latitude and longitude fields.`))); });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        const la = Number(fLat.control.value); const ln = Number(fLng.control.value);
        let bad = false;
        if (fLat.control.value.trim() === '' || !Number.isFinite(la) || la < -90 || la > 90) { setFieldError(fLat.control, 'Enter a latitude between -90 and 90.'); bad = true; }
        if (fLng.control.value.trim() === '' || !Number.isFinite(ln) || ln < -180 || ln > 180) { setFieldError(fLng.control, 'Enter a longitude between -180 and 180.'); bad = true; }
        const note = fNote.control.value.trim();
        if (note.length < 3) { setFieldError(fNote.control, 'Say how the position was confirmed (at least 3 characters).'); bad = true; }
        if (bad) { showFormError(form, 'Check the highlighted fields.', { focus: false }); form.querySelector('[aria-invalid="true"]')?.focus(); return; }
        if (!inDistrict(la, ln)) {
          const msg = inDistrict(ln, la)
            ? 'These values look swapped: latitude should be about 31 and longitude about 73 in Faisalabad.'
            : 'This position is outside the Faisalabad service area. Check the numbers or move the pin.';
          setFieldError(fLat.control, msg);
          showFormError(form, msg, { focus: false });
          fLat.control.focus();
          return;
        }
        const btn = form.querySelector('button[type=submit]');
        try {
          await withBusy(btn, () => ctx.api(`/plants/${encodeURIComponent(code)}/coordinates`, { method: 'POST', json: { lat: round6(la), lng: round6(ln), note, reason: note } }), 'Saving…');
          ctx.toast(`Position saved and marked as verified for ${code}.`, 'success');
          await refresh('pd-location');
        } catch (err) { showFormError(form, err); }
      });

      async function clearCoords() {
        const { confirmed, reason } = await ctx.confirmDialog({
          title: 'Clear coordinates?',
          body: 'The plant will no longer have an exact location. It will only appear in area-level results (if its area is located) or in text lists.',
          confirmLabel: 'Clear coordinates', requireReason: true, danger: true,
        });
        if (!confirmed) return;
        try {
          await ctx.api(`/plants/${encodeURIComponent(code)}/coordinates`, { method: 'POST', json: { clear: true, reason } });
          ctx.toast(`Coordinates cleared for ${code}.`, 'success');
          await refresh('pd-location');
        } catch (err) { ctx.toast(`Could not clear coordinates: ${err.message}`, 'error'); }
      }

      return withId(card('Location',
        h('p', { class: 'card-sub' }, 'Only an administrator-confirmed position (or one supplied by the source file) counts as an exact location. Area centres are approximate and drawn as circles, never as the plant position.'),
        cs === 'geocoded_pending' ? notice('warn', h('p', null, 'This position came from a geocoder and is not public yet. Check it on the map; saving confirms it as verified.')) : null,
        h('div', { class: 'split-wide' },
          h('div', null, mapWrap),
          h('div', null, info)),
        ctx.can('plants:write') ? h('div', null, h('h3', null, 'Set position'), form) : null), 'pd-location');
    }

    // ── Status ──
    function statusCard() {
      const code0 = statusCode(plant);
      const src = statusSource(plant);
      const info = defList([
        ['Current status', statusBadge(plant)],
        ['Recorded value', pick(plant, 'status_raw', 'status.raw', 'statusRaw')],
        ['Status source', src ? STATUS_SOURCE_LABEL[src] || src : null],
        ['Status updated', pick(plant, 'status_updated_at', 'status.updatedAt', 'statusUpdatedAt') ? ctx.formatDate(pick(plant, 'status_updated_at', 'status.updatedAt', 'statusUpdatedAt')) : h('span', { class: 'np' }, 'Undated')],
        ['Status note', pick(plant, 'status_note', 'statusNote')],
      ]);
      const history = listOf(pick(data, 'statusHistory', 'status_history') || []);
      const historyTable = dataTable({
        caption: 'Status history',
        columns: [
          { key: 'at', label: 'When', render: (r) => h('span', { class: 'nowrap' }, ctx.formatDate(pick(r, 'createdAt', 'created_at', 'at'))) },
          { key: 'change', label: 'Change', rowHeader: true, render: (r) => { const o = pick(r, 'oldStatus', 'old_status', 'from'); const n = pick(r, 'newStatus', 'new_status', 'to', 'status'); return h('span', null, STATUS_LABEL[o] || o || '—', ' → ', h('strong', null, STATUS_LABEL[n] || n || '—')); } },
          { key: 'assessment', label: 'Assessment', render: (r) => h('span', { dir: 'auto' }, redactPhones(pick(r, 'assessment') || '')) },
          { key: 'evidence', label: 'Evidence', render: (r) => { const ids = maybeJson(pick(r, 'evidenceReportIds', 'evidence_report_ids_json', 'evidence')); const inv = pick(r, 'investigationId', 'investigation_id'); const parts = []; if (Array.isArray(ids) && ids.length) parts.push(`Reports: ${ids.join(', ')}`); if (inv) parts.push(`Investigation #${inv}`); return parts.length ? parts.join(' · ') : h('span', { class: 'np' }, '—'); } },
          { key: 'by', label: 'By', render: (r) => { let a = pick(r, 'actor', 'actorLabel', 'actor_label', 'actorUsername', 'actor_username'); if (a && typeof a === 'object') a = a.username; return a || '—'; } },
        ],
        rows: history,
        empty: 'No status changes recorded. The status shown comes from the source data.',
      });

      let form = null;
      if (ctx.can('plants:status')) {
        const fStatus = formField({ label: 'New status', name: 'status', type: 'select', required: true, value: code0 || 'unknown', options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) });
        const fAssess = formField({ label: 'Documented assessment', name: 'assessment', type: 'textarea', rows: 4, required: true, dir: 'auto', hint: 'At least 20 characters. What was checked, when, and by whom. Unverified reports alone are not enough to change a status.', attrs: { minlength: '20', maxlength: '4000' } });
        const counter = h('p', { class: 'counter', 'aria-live': 'off' }, '0 / 20 characters minimum');
        fAssess.control.addEventListener('input', () => {
          const n = fAssess.control.value.trim().length;
          counter.textContent = `${n} / 20 characters minimum`;
          counter.classList.toggle('counter-bad', n > 0 && n < 20);
          if (n >= 20) setFieldError(fAssess.control, null);
        });
        const fVerified = formField({ label: 'I confirmed this status directly (site visit or the operator) — mark it as verified', name: 'verified', type: 'checkbox' });
        const evidenceBox = h('fieldset', null, h('legend', null, 'Evidence (optional)'), loadingBlock('Loading related reports…'));
        const invBox = h('div');
        const formEl = h('form', { novalidate: true, 'aria-label': 'Change operational status' },
          h('div', { class: 'form-grid' }, fStatus),
          fAssess, counter, evidenceBox, invBox, fVerified,
          h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Record status change')));
        form = formEl;

        let evidenceMode = 'manual';
        let manualInput = null;
        const renderManual = (msg) => {
          evidenceMode = 'manual';
          const f = formField({ label: 'Evidence report IDs', name: 'evidenceReportIds', hint: msg || 'Comma-separated numeric report IDs, if any.', attrs: { inputmode: 'numeric', autocomplete: 'off' } });
          manualInput = f.control;
          evidenceBox.replaceChildren(h('legend', null, 'Evidence (optional)'), f);
        };
        if (ctx.can('reports:read')) {
          ctx.api('/reports', { query: { plantCode: code, pageSize: 100 } }).then((res) => {
            if (!formEl.isConnected) return;
            const items = listOf(res, 'reports');
            if (!items.length) { renderManual('No reports have been filed for this plant. You can still enter report IDs.'); return; }
            evidenceMode = 'list';
            evidenceBox.replaceChildren(h('legend', null, 'Evidence reports (optional)'),
              h('p', { class: 'hint' }, 'Tick the reports this assessment relies on.'),
              h('ul', { class: 'check-list' }, items.map((r) => {
                const id = pick(r, 'id');
                const cid = uid('ev');
                return h('li', null, h('label', { for: cid },
                  h('input', { type: 'checkbox', id: cid, name: 'evidence', value: String(id) }),
                  h('span', null, h('strong', { class: 'mono' }, pick(r, 'reference') || `#${id}`), ' · ', keyLabel(pick(r, 'category') || ''), ' · ',
                    badge(keyLabel(pick(r, 'status') || ''), 'neutral'), ' · ', ctx.formatDate(pick(r, 'createdAt', 'created_at')))));
              })));
          }).catch(() => renderManual('Reports could not be loaded. Enter comma-separated report IDs, if any.'));
        } else renderManual();
        if (ctx.can('investigations')) {
          ctx.api('/investigations', { query: { plantCode: code } }).then((res) => {
            const items = listOf(res, 'investigations');
            if (!items.length || !formEl.isConnected) return;
            invBox.replaceChildren(formField({ label: 'Linked investigation (optional)', name: 'investigationId', type: 'select', options: [{ value: '', label: 'None' }, ...items.map((i) => ({ value: String(pick(i, 'id')), label: `#${pick(i, 'id')} — ${pick(i, 'title') || ''} (${pick(i, 'status') || ''})` }))] }));
          }).catch(() => { /* optional */ });
        }

        formEl.addEventListener('submit', async (e) => {
          e.preventDefault();
          clearFormErrors(formEl);
          const assessment = fAssess.control.value.trim();
          if (assessment.length < 20) {
            const msg = assessment.length === 0 ? 'A documented assessment is required to change a status.' : `The assessment must be at least 20 characters (currently ${assessment.length}).`;
            setFieldError(fAssess.control, msg);
            showFormError(formEl, msg, { focus: false });
            fAssess.control.focus();
            return;
          }
          let ids = [];
          if (evidenceMode === 'list') ids = [...formEl.querySelectorAll('input[name=evidence]:checked')].map((c) => Number(c.value));
          else if (manualInput && manualInput.value.trim()) {
            const parts = manualInput.value.split(/[\s,]+/).filter(Boolean);
            if (parts.some((x) => !/^\d+$/.test(x))) { setFieldError(manualInput, 'Use numeric report IDs separated by commas.'); showFormError(formEl, 'Evidence report IDs must be numbers.', { focus: false }); manualInput.focus(); return; }
            ids = parts.map(Number);
          }
          const invSel = formEl.querySelector('select[name=investigationId]');
          const body = { status: fStatus.control.value, assessment, verified: fVerified.control.checked };
          if (ids.length) body.evidenceReportIds = ids;
          if (invSel && invSel.value) body.investigationId = Number(invSel.value);
          if (['permanently_closed', 'decommissioned'].includes(body.status)) {
            const { confirmed } = await ctx.confirmDialog({ title: `Mark as ${STATUS_LABEL[body.status].toLowerCase()}?`, body: 'The plant will be removed from normal public results.', confirmLabel: 'Change status', danger: true });
            if (!confirmed) return;
          }
          const btn = formEl.querySelector('button[type=submit]');
          try {
            await withBusy(btn, () => ctx.api(`/plants/${encodeURIComponent(code)}/status`, { method: 'POST', json: body }), 'Saving…');
            ctx.toast(`Status of ${code} changed to ${STATUS_LABEL[body.status]}.`, 'success');
            await refresh('pd-status');
          } catch (err) { showFormError(formEl, err); }
        });
      }
      return withId(card('Operational status',
        h('p', { class: 'card-sub' }, 'Reports are not findings. A status change needs your documented assessment and is kept in the history below.'),
        h('div', { class: 'split' }, h('div', null, info), form ? h('div', null, h('h3', { style: 'margin-top:0' }, 'Change status'), form) : null),
        h('h3', null, 'History'), historyTable), 'pd-status');
    }

    // ── Verification ──
    function verifyCard() {
      const last = pick(plant, 'last_verified_at', 'lastVerifiedAt');
      const info = defList([
        ['Last verified', last ? ctx.formatDate(last) : h('span', { class: 'np' }, 'Not verified')],
        ['Verified by', (() => { const v = pick(plant, 'last_verified_by_name', 'lastVerifiedByName', 'last_verified_by', 'lastVerifiedBy'); return v === null || v === undefined ? null : typeof v === 'number' ? `User #${v}` : v; })()],
        ['Verification note', pick(plant, 'verification_note', 'verificationNote')],
      ]);
      let form = null;
      if (ctx.can('plants:write')) {
        const fDate = formField({ label: 'Date verified', name: 'verifiedAt', type: 'date', required: true, value: todayIso(), attrs: { max: todayIso() } });
        const fNote = formField({ label: 'What was verified?', name: 'note', type: 'textarea', rows: 2, required: true, dir: 'auto', hint: 'Required, e.g. “Visited; plant open, details match record”.' });
        form = h('form', { novalidate: true, 'aria-label': 'Record verification' }, h('div', { class: 'form-grid' }, fDate), fNote,
          h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Record verification')));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          clearFormErrors(form);
          const d = fDate.control.value;
          const note = fNote.control.value.trim();
          let bad = false;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { setFieldError(fDate.control, 'Choose a date.'); bad = true; } else if (d > todayIso()) { setFieldError(fDate.control, 'The date cannot be in the future.'); bad = true; }
          if (note.length < 3) { setFieldError(fNote.control, 'Describe what was verified (at least 3 characters).'); bad = true; }
          if (bad) { showFormError(form, 'Check the highlighted fields.', { focus: false }); form.querySelector('[aria-invalid="true"]')?.focus(); return; }
          const btn = form.querySelector('button[type=submit]');
          try {
            await withBusy(btn, () => ctx.api(`/plants/${encodeURIComponent(code)}/verify`, { method: 'POST', json: { verifiedAt: d, note } }), 'Saving…');
            ctx.toast(`Verification recorded for ${code}.`, 'success');
            await refresh('pd-verify');
          } catch (err) { showFormError(form, err); }
        });
      }
      return withId(card('Verification', h('div', { class: 'split' }, h('div', null, info), form ? h('div', null, form) : null)), 'pd-verify');
    }

    // ── Water tests ──
    function testsCard() {
      const tests = listOf(pick(data, 'waterTests', 'water_tests', 'tests') || []);
      const list = dataTable({
        caption: `Water tests (${tests.length})`,
        columns: [
          { key: 'date', label: 'Sample date', rowHeader: true, render: (t) => ctx.formatDate(testField(t, 'sampleDate', 'sample_date')) },
          { key: 'lab', label: 'Laboratory', render: (t) => displayValue(testField(t, 'laboratory')) },
          { key: 'std', label: 'Standard', render: (t) => { const s = testField(t, 'standard'); const name = s && typeof s === 'object' ? s.name : testField(t, 'standardName', 'standard_name'); const ver = s && typeof s === 'object' ? s.version : testField(t, 'standardVersion', 'standard_version'); return name ? `${name}${ver ? ` (${ver})` : ''}` : h('span', { class: 'np' }, 'None'); } },
          { key: 'outcome', label: 'Outcome', render: (t) => { const o = testField(t, 'outcome'); return badge({ met_limits: 'Met limits', issue_detected: 'Issue detected', not_assessed: 'Not assessed' }[o] || o || '—', { met_limits: 'success', issue_detected: 'danger' }[o] || 'unknown'); } },
          {
            key: 'results', label: 'Results', render: (t) => {
              const rs = listOf(maybeJson(testField(t, 'results')) || []);
              if (!rs.length) return h('span', { class: 'np' }, 'None');
              return h('details', { class: 'expander' }, h('summary', null, `${rs.length} parameter${rs.length === 1 ? '' : 's'}`),
                dataTable({
                  caption: 'Parameters', captionHidden: true,
                  columns: [
                    { key: 'p', label: 'Parameter', rowHeader: true, render: (r) => pick(r, 'parameter') },
                    { key: 'v', label: 'Value', render: (r) => `${pick(r, 'valueText', 'value_text') ?? ''}${pick(r, 'unit') ? ` ${pick(r, 'unit')}` : ''}` },
                    { key: 'l', label: 'Limit', render: (r) => pick(r, 'limitText', 'limit_text') || '—' },
                    { key: 'w', label: 'Within limit', render: (r) => { const w = pick(r, 'withinLimit', 'within_limit'); return w === true || w === 1 ? 'Yes' : w === false || w === 0 ? 'No' : 'Not assessed'; } },
                  ],
                  rows: rs,
                }));
            },
          },
          { key: 'report', label: 'Report file', render: (t) => { const u = safeUrl(testField(t, 'reportUrl', 'report_url')); const fid = testField(t, 'reportFileId', 'report_file_id'); return u ? h('a', { href: u, target: '_blank', rel: 'noopener' }, 'Open') : fid ? `File #${fid}` : h('span', { class: 'np' }, 'None'); } },
          {
            key: 'actions', label: 'Actions', className: 'actions', render: (t) => (ctx.can('tests:write') ? h('button', {
              type: 'button', class: 'btn btn-danger-outline btn-sm', 'aria-label': `Delete water test from ${testField(t, 'sampleDate', 'sample_date')}`,
              onClick: async () => {
                const { confirmed, reason } = await ctx.confirmDialog({ title: 'Delete this water test?', body: `Sample date ${ctx.formatDate(testField(t, 'sampleDate', 'sample_date'))}. The test will no longer count as evidence.`, confirmLabel: 'Delete test', requireReason: true, danger: true });
                if (!confirmed) return;
                try {
                  await ctx.api(`/tests/${encodeURIComponent(testField(t, 'id'))}`, { method: 'DELETE', json: { reason } });
                  ctx.toast('Water test deleted.', 'success');
                  await refresh('pd-tests');
                } catch (err) { ctx.toast(`Could not delete the test: ${err.message}`, 'error'); }
              },
            }, 'Delete') : '—'),
          },
        ],
        rows: tests,
        empty: 'No water tests recorded. Water quality is shown publicly as “Unknown”.',
      });
      return withId(card('Water tests', h('p', { class: 'card-sub' }, 'Laboratory evidence only. Community ratings never count as water-quality evidence.'), list,
        ctx.can('tests:write') ? testForm() : null), 'pd-tests');
    }

    function testForm() {
      const fDate = formField({ label: 'Sample date', name: 'sampleDate', type: 'date', required: true, attrs: { max: todayIso() } });
      const fLab = formField({ label: 'Laboratory / organisation', name: 'laboratory', required: true, attrs: { maxlength: '200' }, dir: 'auto' });
      const fSrc = formField({ label: 'Where the sample was taken', name: 'sourceDescription', hint: 'e.g. “Tap at dispensing point”.', attrs: { maxlength: '300' }, dir: 'auto' });
      const fStd = formField({ label: 'Standard name', name: 'standardName', hint: 'Required for “met limits” or “issue detected”, e.g. “PSQCA PS 4639” or “WHO GDWQ”.', attrs: { maxlength: '200' } });
      const fStdV = formField({ label: 'Standard version', name: 'standardVersion', attrs: { maxlength: '100' } });
      const fStdS = formField({ label: 'Standard source (citation or URL)', name: 'standardSource', attrs: { maxlength: '500' } });
      const outcomeName = uid('outcome');
      const outcomes = [['not_assessed', 'Not assessed'], ['met_limits', 'Met limits'], ['issue_detected', 'Issue detected']];
      const outcomeSet = h('fieldset', null, h('legend', null, 'Outcome'),
        h('div', { class: 'radio-row' }, outcomes.map(([v, l], i) => h('label', null, h('input', { type: 'radio', name: 'outcome', value: v, checked: i === 0, 'data-group': outcomeName }), l))));
      const ruleStd = h('li', null, '“Met limits”, “Issue detected”, or any parameter marked within/outside a limit, need a named standard.');
      const ruleAll = h('li', null, '“Met limits” needs at least one parameter and every parameter marked “within limit: yes”.');
      const rules = h('ul', { class: 'rules', 'aria-live': 'polite' }, ruleStd, ruleAll);

      const tbody = h('tbody');
      const paramTable = h('div', { class: 'table-wrap', role: 'region', 'aria-label': 'Parameters', tabindex: '0' },
        h('table', { class: 'data-table param-table' },
          h('caption', null, 'Parameters'),
          h('thead', null, h('tr', null, ['Parameter *', 'Value (as written) *', 'Number', 'Unit', 'Limit (as written)', 'Within limit', ''].map((t) => h('th', { scope: 'col' }, t)))),
          tbody));
      let rowSeq = 0;
      const addRow = (focus = false) => {
        const n = ++rowSeq;
        const input = (name, label, attrs = {}) => h('input', { type: 'text', name, 'aria-label': `${label}, row ${n}`, ...attrs });
        const within = h('select', { name: 'withinLimit', 'aria-label': `Within limit, row ${n}` },
          h('option', { value: '' }, 'Not assessed'), h('option', { value: 'yes' }, 'Yes'), h('option', { value: 'no' }, 'No'));
        const tr = h('tr', { class: 'param-row' },
          h('td', null, input('parameter', 'Parameter', { maxlength: '100', placeholder: 'e.g. pH' })),
          h('td', null, input('valueText', 'Value as written', { maxlength: '100', placeholder: 'e.g. 7.4 or Absent' })),
          h('td', null, input('valueNum', 'Numeric value', { type: 'number', step: 'any', inputmode: 'decimal' })),
          h('td', null, input('unit', 'Unit', { maxlength: '40', placeholder: 'mg/L' })),
          h('td', null, input('limitText', 'Limit as written', { maxlength: '100', placeholder: '6.5–8.5' })),
          h('td', null, within),
          h('td', null, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Remove row ${n}`, onClick: () => { tr.remove(); updateRules(); } }, 'Remove')));
        within.addEventListener('change', updateRules);
        tbody.append(tr);
        if (focus) tr.querySelector('input').focus();
      };
      addRow();
      const fFile = formField({ label: 'Lab report (PDF, JPEG or PNG, up to 15 MB)', name: 'report', type: 'file', attrs: { accept: 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png' } });
      const fNotes = formField({ label: 'Notes', name: 'notes', type: 'textarea', rows: 2, dir: 'auto' });
      const fReason = formField({ label: 'Reason for recording this test', name: 'reason', type: 'textarea', rows: 2, required: true, dir: 'auto', hint: 'Required, e.g. “Lab certificate received from WASA on 2 Sep”. Recorded in the audit log.' });

      const form = h('form', { novalidate: true, 'aria-label': 'Add water test', class: 'test-form' },
        h('h3', null, 'Add a water test'),
        h('div', { class: 'form-grid' }, fDate, fLab, fSrc),
        h('div', { class: 'form-grid' }, fStd, fStdV, fStdS),
        outcomeSet, rules,
        paramTable,
        h('div', { class: 'form-actions', style: 'margin-top:0;margin-bottom:12px' }, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => addRow(true) }, '+ Add parameter')),
        h('div', { class: 'form-grid' }, fFile), fNotes, fReason,
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save water test')));

      const outcome = () => form.querySelector('input[name=outcome]:checked')?.value || 'not_assessed';
      const readRows = () => [...tbody.querySelectorAll('tr.param-row')].map((tr) => {
        const v = (n) => tr.querySelector(`[name=${n}]`).value.trim();
        return { tr, parameter: v('parameter'), valueText: v('valueText'), valueNum: v('valueNum'), unit: v('unit'), limitText: v('limitText'), within: v('withinLimit') };
      }).filter((r) => r.parameter || r.valueText || r.valueNum || r.unit || r.limitText || r.within);
      function updateRules() {
        const o = outcome();
        const needStd = o !== 'not_assessed' || readRows().some((r) => r.within);
        const stdOk = !!fStd.control.value.trim();
        ruleStd.className = needStd ? (stdOk ? 'rule-ok' : 'rule-bad') : '';
        const rows = readRows();
        const allOk = rows.length > 0 && rows.every((r) => r.within === 'yes');
        ruleAll.className = o === 'met_limits' ? (allOk ? 'rule-ok' : 'rule-bad') : '';
      }
      form.addEventListener('change', updateRules);
      fStd.control.addEventListener('input', updateRules);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        form.querySelectorAll('.param-row [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
        const problems = [];
        const d = fDate.control.value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { setFieldError(fDate.control, 'Choose the sample date.'); problems.push('Sample date is required.'); }
        else if (d > todayIso()) { setFieldError(fDate.control, 'The sample date cannot be in the future.'); problems.push('Sample date is in the future.'); }
        const o = outcome();
        const std = fStd.control.value.trim();
        const rows = readRows();
        if (!fLab.control.value.trim()) { setFieldError(fLab.control, 'Name the laboratory or organisation.'); problems.push('The laboratory is required.'); }
        if (o !== 'not_assessed' && !std) { setFieldError(fStd.control, 'Name the standard used for this outcome.'); problems.push('A standard is required for this outcome.'); }
        else if (!std && rows.some((r) => r.within)) { setFieldError(fStd.control, 'Name the standard the limits come from.'); problems.push('A standard is required when a parameter is marked within or outside a limit.'); }
        const testReason = fReason.control.value.trim();
        if (testReason.length < 3) { setFieldError(fReason.control, 'Give a reason (at least 3 characters).'); problems.push('A reason is required.'); }
        for (const r of rows) {
          if (!r.parameter) { r.tr.querySelector('[name=parameter]').setAttribute('aria-invalid', 'true'); problems.push('Every parameter row needs a parameter name.'); }
          if (!r.valueText) { r.tr.querySelector('[name=valueText]').setAttribute('aria-invalid', 'true'); problems.push('Every parameter row needs a value (as written).'); }
          if (r.valueNum && !Number.isFinite(Number(r.valueNum))) { r.tr.querySelector('[name=valueNum]').setAttribute('aria-invalid', 'true'); problems.push('Numeric values must be numbers.'); }
        }
        if (o === 'met_limits') {
          if (!rows.length) problems.push('“Met limits” needs at least one parameter.');
          else if (!rows.every((r) => r.within === 'yes')) problems.push('“Met limits” needs every parameter marked “within limit: yes”.');
        }
        const file = fFile.control.files && fFile.control.files[0];
        if (file) {
          const okType = ['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) || /\.(pdf|jpe?g|png)$/i.test(file.name);
          if (!okType) { setFieldError(fFile.control, 'Use a PDF, JPEG or PNG file.'); problems.push('The report must be a PDF, JPEG or PNG.'); }
          if (file.size > 15 * 1024 * 1024) { setFieldError(fFile.control, 'The file is larger than 15 MB.'); problems.push('The report file is too large.'); }
        }
        updateRules();
        if (problems.length) {
          showFormError(form, [...new Set(problems)].join(' '), { focus: false });
          (form.querySelector('[aria-invalid="true"]') || form.querySelector('.form-error')).focus();
          return;
        }
        const fd = new FormData();
        fd.append('sampleDate', d);
        for (const [k, c] of [['laboratory', fLab], ['sourceDescription', fSrc], ['standardName', fStd], ['standardVersion', fStdV], ['standardSource', fStdS], ['notes', fNotes]]) {
          if (c.control.value.trim()) fd.append(k, c.control.value.trim());
        }
        fd.append('outcome', o);
        fd.append('reason', testReason);
        fd.append('results', JSON.stringify(rows.map((r) => {
          const out = { parameter: r.parameter, valueText: r.valueText, withinLimit: r.within === 'yes' ? true : r.within === 'no' ? false : null };
          if (r.valueNum) out.valueNum = Number(r.valueNum);
          if (r.unit) out.unit = r.unit;
          if (r.limitText) out.limitText = r.limitText;
          return out;
        })));
        if (file) fd.append('report', file, file.name);
        const btn = form.querySelector('button[type=submit]');
        try {
          await withBusy(btn, () => ctx.api(`/plants/${encodeURIComponent(code)}/tests`, { method: 'POST', formData: fd }), 'Uploading…');
          ctx.toast('Water test saved.', 'success');
          await refresh('pd-tests');
        } catch (err) { showFormError(form, err); }
      });
      updateRules();
      return form;
    }

    // ── Sources ──
    function sourcesCard() {
      const sources = listOf(pick(data, 'sources', 'plant_sources') || []);
      const table = dataTable({
        caption: `Sources (${sources.length})`,
        columns: [
          { key: 'title', label: 'Title', rowHeader: true, render: (s) => h('span', { dir: 'auto' }, pick(s, 'title') || '—') },
          { key: 'url', label: 'Link', render: (s) => { const u = safeUrl(pick(s, 'url')); return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u.length > 60 ? u.slice(0, 57) + '…' : u) : pick(s, 'url') ? h('span', { class: 'mono' }, String(pick(s, 'url'))) : h('span', { class: 'np' }, '—'); } },
          { key: 'note', label: 'Note', render: (s) => displayValue(pick(s, 'note'), { empty: '—' }) },
          { key: 'added', label: 'Added', render: (s) => { let by = pick(s, 'addedBy', 'added_by_name', 'added_by'); if (by && typeof by === 'object') by = by.username; return `${ctx.formatDate(pick(s, 'createdAt', 'created_at'))}${by ? ` · ${by}` : ''}`; } },
        ],
        rows: sources,
        empty: 'No sources recorded besides the import file.',
      });
      let form = null;
      if (ctx.can('plants:write')) {
        const fTitle = formField({ label: 'Title', name: 'title', required: true, attrs: { maxlength: '200' }, dir: 'auto' });
        const fUrl = formField({ label: 'URL', name: 'url', type: 'url', hint: 'http or https only.', attrs: { maxlength: '1000', placeholder: 'https://' } });
        const fNote = formField({ label: 'Note', name: 'note', attrs: { maxlength: '500' }, dir: 'auto' });
        const fSReason = formField({ label: 'Reason', name: 'reason', required: true, attrs: { maxlength: '1000' }, dir: 'auto', hint: 'Required. Why this source supports the record.' });
        form = h('form', { novalidate: true, 'aria-label': 'Add a source' }, h('h3', null, 'Add a source'), h('div', { class: 'form-grid' }, fTitle, fUrl, fNote, fSReason),
          h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add source')));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          clearFormErrors(form);
          const title = fTitle.control.value.trim();
          const url = fUrl.control.value.trim();
          let bad = false;
          if (!title) { setFieldError(fTitle.control, 'Enter a title.'); bad = true; }
          const sReason = fSReason.control.value.trim();
          if (sReason.length < 3) { setFieldError(fSReason.control, 'Give a reason (at least 3 characters).'); bad = true; }
          if (url && !/^https?:\/\//i.test(url)) { setFieldError(fUrl.control, 'Use a full http:// or https:// address.'); bad = true; }
          else if (url && !safeUrl(url)) { setFieldError(fUrl.control, 'This is not a valid web address.'); bad = true; }
          if (bad) { showFormError(form, 'Check the highlighted fields.', { focus: false }); form.querySelector('[aria-invalid="true"]')?.focus(); return; }
          const body = { title, reason: sReason };
          if (url) body.url = url;
          if (fNote.control.value.trim()) body.note = fNote.control.value.trim();
          const btn = form.querySelector('button[type=submit]');
          try {
            await withBusy(btn, () => ctx.api(`/plants/${encodeURIComponent(code)}/sources`, { method: 'POST', json: body }), 'Adding…');
            ctx.toast('Source added.', 'success');
            await refresh('pd-sources');
          } catch (err) { showFormError(form, err); }
        });
      }
      return withId(card('Sources', table, form), 'pd-sources');
    }

    // ── Reports (counts only) ──
    function reportsCard() {
      const rc = pick(data, 'reportCounts', 'report_counts', 'reports', 'reportsSummary');
      let content;
      if (rc && typeof rc === 'object' && !Array.isArray(rc)) {
        const entries = [];
        for (const [k, v] of Object.entries(rc)) {
          if (typeof v === 'number') entries.push([k, v]);
          else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'number') entries.push([k2, v2]);
        }
        content = entries.length
          ? h('ul', { class: 'chips' }, entries.map(([k, v]) => h('li', { class: 'chip' }, h('span', { class: 'chip-value' }, formatNumber(v)), h('span', { class: 'chip-label' }, keyLabel(k)))))
          : h('p', { class: 'np' }, 'No report counts available.');
      } else if (typeof rc === 'number') content = h('p', null, `${formatNumber(rc)} reports`);
      else content = h('p', { class: 'np' }, 'No report counts available.');
      return withId(card('Community reports',
        h('p', { class: 'card-sub' }, 'Unverified reports never change the official status by themselves.'),
        content,
        ctx.can('reports:read') ? h('p', null, h('a', { class: 'btn btn-secondary btn-sm', href: `#/reports?plantCode=${encodeURIComponent(code)}` }, 'Open reports for this plant')) : null), 'pd-reports');
    }

    // ── Audit ──
    function auditCard() {
      const entries = listOf(pick(data, 'audit', 'auditEntries', 'recentAudit', 'audit_log') || []);
      return withId(card('Recent audit entries',
        auditTable(entries, { caption: `Last ${entries.length} audit entr${entries.length === 1 ? 'y' : 'ies'} for ${code}`, showEntity: false, empty: 'No changes recorded for this plant yet.' }),
        ctx.can('audit:read') ? h('p', null, h('a', { href: `#/audit?entityType=plant&entityId=${encodeURIComponent(code)}` }, 'Open the full audit log for this plant')) : null), 'pd-audit');
    }

    root.append(loadingBlock(`Loading ${code}…`));
    try {
      await fetchPlant();
    } catch (err) {
      if (err.status === 404 && err.code === 'not_found') {
        root.replaceChildren(pageHeader({ title: code }), notice('warn', h('p', null, `No plant with ID ${code} was found (or the plant endpoint is not available yet). `), h('p', null, h('a', { href: '#/plants' }, 'Back to all plants'))));
        return destroyMaps;
      }
      throw err;
    }
    if (!ctx.isCurrent()) return destroyMaps;
    draw();
    const focus = ctx.query && ctx.query.focus;
    if (focus) {
      const target = document.getElementById(`pd-${focus}`);
      if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 50);
    }
    return destroyMaps;
  },
};
