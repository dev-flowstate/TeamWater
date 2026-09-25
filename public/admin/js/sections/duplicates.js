// Duplicate candidates: side-by-side comparison and a decision (merge / keep separate / dismiss) with a note.
import {
  h, pick, maybeJson, listOf, pageHeader, card, dataTable, formField, setFieldError, showFormError, clearFormErrors, withBusy,
  loadingBlock, errorBlock, badge, notice, formatNumber, keyLabel, uid, displayValue,
} from '../ui.js';
import { plantCode, plantName, statusCode, STATUS_LABEL, precisionOf, PRECISION, isDemo } from '../plant-util.js';

const FIELDS = [
  { label: 'Plant ID', get: (p) => plantCode(p), headers: ['Plant ID', 'Plant Code'] },
  { label: 'Name', get: (p) => plantName(p), headers: ['Name', 'Plant Name'] },
  { label: 'Town / tehsil', get: (p) => pick(p, 'town'), headers: ['Town/Tehsil', 'Town'] },
  { label: 'Area (as recorded)', get: (p) => pick(p, 'areaRaw', 'area_raw'), headers: ['Area/Union Council', 'Area'] },
  { label: 'Address', get: (p) => pick(p, 'address'), headers: ['Address'] },
  { label: 'Operator type', get: (p) => pick(p, 'operator.type', 'operator_type', 'operatorType'), headers: ['Operating Entity Type', 'Operator Type'] },
  { label: 'Water source', get: (p) => pick(p, 'waterSource', 'water_source'), headers: ['Water Source'] },
  { label: 'Technology', get: (p) => pick(p, 'technology.raw', 'technology_raw', 'technologyRaw'), headers: ['Filtration Technology', 'Technology'] },
  { label: 'Capacity', get: (p) => pick(p, 'capacity.raw', 'capacity_raw', 'capacityRaw'), headers: ['Capacity (Gallons Per Hour)', 'Capacity'] },
  { label: 'Status', get: (p) => { const c = statusCode(p); return c ? STATUS_LABEL[c] || c : null; }, headers: ['Operational Status', 'Status'] },
  { label: 'Location', get: (p) => { const pr = precisionOf(p); return pr ? PRECISION[pr]?.label || pr : null; } },
];
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const fromRaw = (raw, headers) => {
  if (!raw || !headers) return undefined;
  const k = Object.keys(raw).find((x) => headers.some((hd) => norm(hd) === norm(x)));
  return k === undefined ? undefined : raw[k];
};
const REASONS = {
  duplicate_plant_code: 'The same Plant ID appears more than once',
  same_area_same_capacity_technology: 'Same area, capacity and technology',
  near_identical: 'Near-identical records',
  nearby_position: 'Positions very close together',
};
const STATUS = { open: ['Open', 'warn'], merged: ['Merged', 'info'], kept_separate: ['Kept separate', 'success'], dismissed: ['Dismissed', 'unknown'] };

export default {
  id: 'duplicates',
  title: 'Duplicates',
  permission: 'duplicates',
  icon: 'copy',
  async render(el, ctx) {
    let status = (ctx.query && ctx.query.status) || 'open';
    el.append(pageHeader({ title: 'Duplicates', subtitle: 'Possible duplicate records found during import. Compare them side by side and record a decision with a note.' }));
    const fStatus = formField({ label: 'Show', name: 'status', type: 'select', value: status, options: Object.entries(STATUS).map(([value, [label]]) => ({ value, label })) });
    fStatus.control.addEventListener('change', () => { status = fStatus.control.value; ctx.setQuery({ status }); load(); });
    const list = h('div', { 'aria-live': 'polite' });
    el.append(h('form', { class: 'toolbar', 'aria-label': 'Filter duplicates', onSubmit: (e) => e.preventDefault() }, fStatus), list);

    const cache = new Map();
    async function plantByCode(code) {
      if (!code) return null;
      if (!cache.has(code)) cache.set(code, ctx.api(`/plants/${encodeURIComponent(code)}`).then((d) => (d && d.plant ? { ...d, ...d.plant } : d)).catch(() => null));
      return cache.get(code);
    }

    async function sides(c) {
      let left = pick(c, 'plant', 'a', 'left');
      let right = pick(c, 'otherPlant', 'other_plant', 'other', 'b', 'right');
      const raw = maybeJson(pick(c, 'importRow.raw', 'import_row.raw', 'importRow.values', 'raw', 'rawRow', 'importRow.raw_json'));
      if (!left || typeof left !== 'object') left = await plantByCode(pick(c, 'plantCode', 'plant_code'));
      if (!right || typeof right !== 'object') right = await plantByCode(pick(c, 'otherPlantCode', 'other_plant_code'));
      return { left, right, raw: raw && typeof raw === 'object' ? raw : null, row: pick(c, 'importRow.rowNumber', 'importRow.row_number', 'rowNumber', 'row_number') };
    }

    async function candidateCard(c) {
      const id = pick(c, 'id');
      const { left, right, raw, row } = await sides(c);
      const rightLabel = right ? `Record B: ${plantCode(right) || '—'}` : raw ? `Import row${row ? ` ${row}` : ''} (not imported)` : 'Record B';
      const leftLabel = left ? `Record A: ${plantCode(left) || '—'}` : 'Record A';
      const rows = FIELDS.map((f) => {
        const a = left ? f.get(left) : undefined;
        const b = right ? f.get(right) : raw ? fromRaw(raw, f.headers) : undefined;
        return { f, a, b, differs: String(a ?? '') !== String(b ?? '') };
      });
      const table = dataTable({
        caption: `Comparison for duplicate candidate #${id}`,
        className: 'compare-table',
        rowAttrs: (r) => ({ class: r.differs ? 'differs' : null }),
        columns: [
          { key: 'f', label: 'Field', rowHeader: true, render: (r) => h('span', null, r.f.label, r.differs ? h('span', { class: 'visually-hidden' }, ' (values differ)') : null) },
          { key: 'a', label: leftLabel, render: (r) => (r.a === undefined ? h('span', { class: 'np' }, '—') : displayValue(r.a)) },
          { key: 'b', label: rightLabel, render: (r) => (r.b === undefined ? h('span', { class: 'np' }, '—') : displayValue(r.b)) },
        ],
        rows,
      });
      const reason = pick(c, 'reason');
      const score = pick(c, 'score');
      const st = STATUS[pick(c, 'status')] || [pick(c, 'status') || '—', 'neutral'];
      const links = h('p', { class: 'small' },
        left && plantCode(left) ? h('a', { href: `#/plants/${encodeURIComponent(plantCode(left))}` }, `Open ${plantCode(left)}`) : null,
        right && plantCode(right) ? [' · ', h('a', { href: `#/plants/${encodeURIComponent(plantCode(right))}` }, `Open ${plantCode(right)}`)] : null);

      let form = null;
      if (pick(c, 'status') === 'open' || !pick(c, 'status')) {
        const name = uid('dup-action');
        const opts = [
          ['keep_separate', 'Keep separate', 'They are different plants. Both records stay.'],
          ['merge', 'Merge', 'They are the same plant. Record B (or the import row) is merged into record A.'],
          ['dismiss', 'Dismiss', 'Not a real duplicate signal (e.g. coincidence). No change to either record.'],
        ];
        const fNote = formField({ label: 'Decision note', name: 'note', type: 'textarea', rows: 2, required: true, dir: 'auto', hint: 'Required. Explain how you decided. Recorded in the audit log.' });
        form = h('form', { novalidate: true, 'aria-label': `Resolve duplicate candidate ${id}` },
          h('fieldset', null, h('legend', null, 'Decision'),
            h('ul', { class: 'check-list' }, opts.map(([v, l, d]) => {
              const rid = uid('r');
              return h('li', null, h('label', { for: rid }, h('input', { type: 'radio', id: rid, name, value: v }), h('span', null, h('strong', null, l), ` — ${d}`)));
            }))),
          fNote,
          h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Record decision')));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          clearFormErrors(form);
          const action = form.querySelector(`input[name="${name}"]:checked`)?.value;
          const note = fNote.control.value.trim();
          if (!action) { showFormError(form, 'Choose a decision.'); form.querySelector(`input[name="${name}"]`).focus(); return; }
          if (!note) { setFieldError(fNote.control, 'A note is required.'); showFormError(form, 'Explain your decision in the note.', { focus: false }); fNote.control.focus(); return; }
          if (action === 'merge') {
            const { confirmed } = await ctx.confirmDialog({ title: 'Merge these records?', body: 'Merging combines the two records. It is recorded in the audit log but cannot be undone from the dashboard.', confirmLabel: 'Merge records', danger: true });
            if (!confirmed) return;
          }
          const btn = form.querySelector('button[type=submit]');
          try {
            await withBusy(btn, () => ctx.api(`/duplicates/${encodeURIComponent(id)}/resolve`, { method: 'POST', json: { action, note } }), 'Saving…');
            ctx.toast(`Duplicate candidate #${id}: ${keyLabel(action).toLowerCase()}.`, 'success');
            load();
          } catch (err) { showFormError(form, err); }
        });
      } else {
        const note = pick(c, 'resolutionNote', 'resolution_note');
        form = h('p', null, h('strong', null, 'Resolution note: '), note ? h('span', { dir: 'auto' }, note) : h('span', { class: 'np' }, '—'), pick(c, 'resolvedAt', 'resolved_at') ? ` (${ctx.formatDate(pick(c, 'resolvedAt', 'resolved_at'))})` : '');
      }
      const node = card(`Candidate #${id}`,
        h('p', { class: 'badges' }, badge(st[0], st[1]), reason ? badge(REASONS[reason] || keyLabel(reason), 'neutral') : null, score !== undefined && score !== null ? badge(`Similarity ${Math.round(Number(score) * 100)}%`, 'accent') : null,
          (left && isDemo(left)) || (right && isDemo(right)) ? badge('Includes demo data', 'demo') : null),
        table, links, form);
      node.classList.add('dup-card');
      return node;
    }

    async function load() {
      list.replaceChildren(loadingBlock('Loading duplicate candidates…'));
      let data;
      try { data = await ctx.api('/duplicates', { query: { status } }); } catch (err) { list.replaceChildren(errorBlock(err, load)); return; }
      if (!ctx.isCurrent()) return;
      const items = listOf(data, 'duplicates', 'candidates');
      if (!items.length) { list.replaceChildren(notice('success', h('p', null, status === 'open' ? 'No open duplicate candidates. Nothing to review.' : `No candidates with status “${STATUS[status]?.[0] || status}”.`))); return; }
      const cards = await Promise.all(items.map(candidateCard));
      if (!ctx.isCurrent()) return;
      list.replaceChildren(h('p', { class: 'muted', role: 'status' }, `${formatNumber(items.length)} candidate${items.length === 1 ? '' : 's'}.`), ...cards);
    }
    await load();
  },
};
