// Import wizard: upload .xlsx → choose sheet → map columns → preview (summary + rows by outcome, errors,
// warnings, change diff) → download validation errors CSV → commit (behind a confirmation) → final summary.
// Cancel at any point. Previous batches are listed below the wizard.
import {
  h, pick, maybeJson, listOf, pageHeader, card, dataTable, pager, formField, showFormError, clearFormErrors, withBusy,
  loadingBlock, errorBlock, badge, notice, formatNumber, keyLabel, uid, defList,
} from '../ui.js';

const STEPS = ['Upload file', 'Choose sheet', 'Map columns', 'Preview', 'Commit'];
const OUTCOMES = {
  new: { label: 'New', tone: 'success' },
  update: { label: 'Update', tone: 'info' },
  unchanged: { label: 'Unchanged', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'danger' },
  duplicate_review: { label: 'Duplicate review', tone: 'warn' },
};
const SUMMARY_CHIPS = [
  ['total', 'Total rows', ''], ['new', 'New', 'success'], ['update', 'Update', 'info'], ['unchanged', 'Unchanged', ''],
  ['rejected', 'Rejected', 'danger'], ['incomplete', 'Incomplete', 'warn'], ['duplicateReview', 'Duplicate review', 'warn'],
];
const BATCH_STATUS = { uploaded: ['Uploaded', 'neutral'], previewed: ['Previewed', 'info'], committed: ['Committed', 'success'], cancelled: ['Cancelled', 'unknown'], failed: ['Failed', 'danger'] };
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function summaryChips(summary, caption = 'Import summary') {
  const s = maybeJson(summary) || {};
  return h('ul', { class: 'chips', 'aria-label': caption }, SUMMARY_CHIPS.map(([k, label, tone]) => {
    const v = pick(s, k, k === 'duplicateReview' ? 'duplicate_review' : k);
    return h('li', { class: `chip${tone ? ` chip-${tone}` : ''}`, 'data-chip': k },
      h('span', { class: 'chip-value' }, v === undefined || v === null ? '—' : formatNumber(v)),
      h('span', { class: 'chip-label' }, label));
  }));
}

function messages(list, tone) {
  const arr = listOf(maybeJson(list) || []);
  if (!arr.length) return null;
  return h('ul', { class: 'msg-list' }, arr.map((m) => {
    const text = typeof m === 'string' ? m : pick(m, 'message', 'text') || pick(m, 'code') || JSON.stringify(m);
    const field = typeof m === 'object' ? pick(m, 'field', 'column') : null;
    return h('li', { class: tone === 'danger' ? 'field-error' : '' }, field ? h('strong', null, `${keyLabel(field)}: `) : null, h('span', { dir: 'auto' }, String(text)));
  }));
}

function changeList(changes) {
  const c = maybeJson(changes);
  if (!c || (typeof c === 'object' && !Object.keys(c).length)) return null;
  const items = Array.isArray(c)
    ? c.map((x) => [pick(x, 'field', 'key'), pick(x, 'before', 'from', 'old'), pick(x, 'after', 'to', 'new')])
    : Object.entries(c).map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? [k, pick(v, 'before', 'from', 'old'), pick(v, 'after', 'to', 'new')] : [k, undefined, v]));
  const show = (v) => (v === undefined ? '' : v === null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return h('ul', { class: 'msg-list' }, items.map(([k, b, a]) => h('li', null, h('strong', null, `${keyLabel(k)}: `),
    b !== undefined ? h('del', { dir: 'auto' }, show(b)) : null, b !== undefined ? ' → ' : null, h('ins', { dir: 'auto' }, show(a)))));
}

const R = {
  row: (r) => pick(r, 'rowNumber', 'row_number', 'row'),
  code: (r) => pick(r, 'plantCode', 'plant_code', 'normalized.plant_code', 'normalized.plantCode', 'code'),
  outcome: (r) => pick(r, 'outcome'),
  incomplete: (r) => !!pick(r, 'incomplete'),
  errors: (r) => pick(r, 'errors', 'errors_json'),
  warnings: (r) => pick(r, 'warnings', 'warnings_json'),
  changes: (r) => pick(r, 'changes', 'diff', 'changedFields'),
};

export default {
  id: 'imports',
  title: 'Imports',
  permission: 'imports',
  icon: 'upload',
  async render(el, ctx) {
    const st = { step: 0, batch: null, sheet: null, mapping: null, updateExisting: true, preview: null, outcome: '', page: 1, done: null };
    el.append(pageHeader({ title: 'Imports', subtitle: 'Bring a spreadsheet into the database. Nothing changes until you commit, and original values are always kept verbatim.' }));
    const stepsEl = h('ol', { class: 'steps', 'aria-label': 'Import steps' });
    const wizard = h('div', { class: 'wizard' });
    const live = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
    const historyBox = h('div');
    el.append(card('Import a spreadsheet', stepsEl, live, wizard), historyBox);

    function drawSteps() {
      stepsEl.replaceChildren(...STEPS.map((label, i) => h('li', { class: i < st.step || (st.done && i === 4) ? 'done' : null, 'aria-current': i === st.step && !st.done ? 'step' : null }, label)));
    }
    function go(step, message) {
      st.step = step;
      drawSteps();
      const views = [uploadView, sheetView, mappingView, previewView, doneView];
      wizard.replaceChildren(views[step]());
      live.textContent = `Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}.${message ? ` ${message}` : ''}`;
      const hd = wizard.querySelector('h3');
      if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); }
    }
    function reset() { Object.assign(st, { step: 0, batch: null, sheet: null, mapping: null, preview: null, outcome: '', page: 1, done: null }); go(0); }

    async function cancelBatch() {
      if (!st.batch) { reset(); return; }
      const { confirmed } = await ctx.confirmDialog({ title: 'Cancel this import?', body: `Batch #${st.batch.batchId} (${st.batch.filename}) will be discarded. No plant records have been changed.`, confirmLabel: 'Cancel import', cancelLabel: 'Keep working', danger: true });
      if (!confirmed) return;
      try { await ctx.api(`/imports/${encodeURIComponent(st.batch.batchId)}/cancel`, { method: 'POST' }); ctx.toast('Import cancelled. Nothing was changed.', 'info'); }
      catch (err) { ctx.toast(`Could not cancel the batch on the server: ${err.message}`, 'error'); }
      reset();
      loadHistory();
    }
    const cancelBtn = () => h('button', { type: 'button', class: 'btn btn-danger-outline', onClick: cancelBatch }, 'Cancel import');

    // Step 1 — upload
    function uploadView() {
      const input = formField({ label: 'Spreadsheet file (.xlsx or .csv)', name: 'file', type: 'file', required: true, hint: 'Up to 20 MB. The first non-empty row of each sheet is read as the header row.', attrs: { accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv' } });
      const zone = h('div', { class: 'dropzone' }, h('p', null, 'Drag a file here, or choose one below.'), input);
      const form = h('form', { novalidate: true, 'aria-label': 'Upload spreadsheet' }, h('h3', null, 'Step 1 — Upload the spreadsheet'), zone,
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Upload and read file')));
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
      zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer.files.length) { input.control.files = e.dataTransfer.files; } });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        const file = input.control.files && input.control.files[0];
        if (!file) { showFormError(form, 'Choose a spreadsheet file first.', { focus: false }); input.control.focus(); return; }
        if (!/\.(xlsx|csv)$/i.test(file.name)) { showFormError(form, 'Only .xlsx workbooks and .csv files can be imported.'); return; }
        if (file.size > 20 * 1024 * 1024) { showFormError(form, 'The file is larger than 20 MB.'); return; }
        const fd = new FormData();
        fd.append('file', file, file.name);
        const btn = form.querySelector('button[type=submit]');
        try {
          const res = await withBusy(btn, () => ctx.api('/imports', { method: 'POST', formData: fd }), 'Reading file…');
          st.batch = { ...res, batchId: pick(res, 'batchId', 'id'), filename: pick(res, 'filename', 'sourceFilename') || file.name };
          const sheets = listOf(pick(res, 'sheets') || []);
          st.sheet = pick(res, 'suggestedMapping.sheet') || (sheets.find((s) => (pick(s, 'rowCount') || 0) > 0) || sheets[0] || {}).name;
          st.mapping = null;
          go(1, `${file.name} uploaded.`);
          loadHistory();
        } catch (err) { showFormError(form, err); }
      });
      return form;
    }

    // Step 2 — sheet
    function sheetView() {
      const sheets = listOf(pick(st.batch, 'sheets') || []);
      const name = uid('sheet');
      const form = h('form', { novalidate: true, 'aria-label': 'Choose sheet' },
        h('h3', null, 'Step 2 — Choose the sheet'),
        h('p', { class: 'muted' }, 'File: ', h('strong', null, st.batch.filename), ` · batch #${st.batch.batchId}`),
        h('fieldset', null, h('legend', null, 'Sheets in this file'),
          h('ul', { class: 'check-list' }, sheets.map((s) => {
            const id = uid('sh');
            return h('li', null, h('label', { for: id },
              h('input', { type: 'radio', id, name, value: s.name, checked: s.name === st.sheet }),
              h('span', null, h('strong', { dir: 'auto' }, s.name), ` — ${formatNumber(pick(s, 'rowCount') ?? 0)} data rows, ${listOf(pick(s, 'headers') || []).length} columns`)));
          }))),
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Continue to column mapping'),
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => go(0) }, 'Back'),
          cancelBtn()));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const chosen = form.querySelector(`input[name="${name}"]:checked`);
        if (!chosen) { showFormError(form, 'Choose a sheet.'); return; }
        if (chosen.value !== st.sheet) st.mapping = null;
        st.sheet = chosen.value;
        go(2);
      });
      return form;
    }

    // Step 3 — mapping
    function mappingView() {
      const sheet = listOf(pick(st.batch, 'sheets') || []).find((s) => s.name === st.sheet) || { headers: [] };
      const headers = listOf(pick(sheet, 'headers') || []);
      const targets = listOf(pick(st.batch, 'targetFields') || []);
      const suggested = pick(st.batch, 'suggestedMapping.sheet') === st.sheet ? (pick(st.batch, 'suggestedMapping.columns') || {}) : {};
      const initial = st.mapping || (() => {
        const m = {};
        for (const t of targets) {
          const s = suggested[t.key];
          m[t.key] = s && headers.includes(s) ? s : headers.find((hd) => norm(hd) === norm(t.label) || norm(hd) === norm(t.key)) || null;
        }
        for (const [k, v] of Object.entries(suggested)) if (k.startsWith('param:') && v && headers.includes(v)) m[k] = v;
        return m;
      })();
      const rows = [
        ...targets.map((t) => ({ key: t.key, label: t.label || keyLabel(t.key), required: !!t.required, description: t.description })),
        ...Object.keys(initial).filter((k) => k.startsWith('param:')).map((k) => ({ key: k, label: `Water-test parameter: ${k.slice(6)}`, required: false, description: 'Recorded as a water-test result when a test date is also mapped.' })),
      ];
      const selects = new Map();
      const table = dataTable({
        caption: `Column mapping for sheet “${st.sheet}”`,
        columns: [
          { key: 'target', label: 'Field in Team Water', rowHeader: true, render: (r) => h('span', null, h('span', null, r.label), r.required ? h('span', { class: 'req' }, ' * required') : null, r.description ? h('span', { class: 'hint', style: 'display:block' }, r.description) : null) },
          {
            key: 'col', label: 'Column in the file', render: (r) => {
              const id = uid('map');
              const sel = h('select', { id, name: `map:${r.key}`, 'aria-label': `Source column for ${r.label}${r.required ? ' (required)' : ''}`, required: r.required || null },
                h('option', { value: '' }, '— Not mapped —'), headers.map((hd) => h('option', { value: hd }, hd)));
              sel.value = initial[r.key] || '';
              selects.set(r.key, sel);
              return sel;
            },
          },
        ],
        rows,
      });
      const unmappedBox = h('p', { class: 'hint' });
      const refreshUnmapped = () => {
        const used = new Set([...selects.values()].map((s) => s.value).filter(Boolean));
        const un = headers.filter((hd) => !used.has(hd));
        unmappedBox.textContent = un.length ? `Columns not mapped (kept verbatim in the source values only): ${un.join(', ')}` : 'Every column is mapped.';
      };
      const upd = formField({ label: 'Update existing plants when the file has different values', name: 'updateExisting', type: 'checkbox', value: st.updateExisting, hint: 'Plants are matched by Plant ID. Administrator edits and verifications are never overwritten by the importer.' });
      const form = h('form', { novalidate: true, 'aria-label': 'Map columns' },
        h('h3', null, 'Step 3 — Map columns'),
        h('p', { class: 'muted' }, 'Suggested matches are pre-filled. Check each one; required fields are marked.'),
        table, unmappedBox, upd,
        h('div', { class: 'form-actions' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Preview import'),
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => { st.mapping = readMapping(); go(1); } }, 'Back'),
          cancelBtn()));
      function readMapping() { const m = {}; for (const [k, s] of selects) m[k] = s.value || null; return m; }
      form.addEventListener('change', refreshUnmapped);
      refreshUnmapped();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        form.querySelectorAll('select[aria-invalid]').forEach((s) => s.removeAttribute('aria-invalid'));
        const mapping = readMapping();
        const missing = rows.filter((r) => r.required && !mapping[r.key]);
        if (missing.length) {
          missing.forEach((r) => selects.get(r.key).setAttribute('aria-invalid', 'true'));
          showFormError(form, `Map the required field${missing.length > 1 ? 's' : ''}: ${missing.map((r) => r.label).join(', ')}.`, { focus: false });
          selects.get(missing[0].key).focus();
          return;
        }
        const seen = new Map();
        for (const [k, v] of Object.entries(mapping)) {
          if (!v) continue;
          if (seen.has(v)) {
            selects.get(k).setAttribute('aria-invalid', 'true');
            showFormError(form, `The column “${v}” is mapped to two fields (${rows.find((r) => r.key === seen.get(v))?.label} and ${rows.find((r) => r.key === k)?.label}). Map each column once.`, { focus: false });
            selects.get(k).focus();
            return;
          }
          seen.set(v, k);
        }
        st.mapping = mapping;
        st.updateExisting = upd.control.checked;
        const btn = form.querySelector('button[type=submit]');
        try {
          const res = await withBusy(btn, () => ctx.api(`/imports/${encodeURIComponent(st.batch.batchId)}/preview`, { method: 'POST', json: { sheet: st.sheet, mapping, options: { updateExisting: st.updateExisting } } }), 'Checking every row…');
          st.preview = res;
          st.outcome = '';
          st.page = 1;
          go(3, 'Preview ready.');
          loadHistory();
        } catch (err) { showFormError(form, err); }
      });
      return form;
    }

    // Step 4 — preview
    function previewView() {
      const summary = pick(st.preview, 'summary') || {};
      const n = (k) => Number(pick(summary, k) || 0);
      const rowsBox = h('div', { 'aria-live': 'polite' });
      const fOutcome = formField({ label: 'Show rows', name: 'outcome', type: 'select', value: st.outcome, options: [{ value: '', label: 'All outcomes' }, ...Object.entries(OUTCOMES).map(([value, o]) => ({ value, label: o.label }))] });
      fOutcome.control.addEventListener('change', () => { st.outcome = fOutcome.control.value; st.page = 1; loadRows(); });

      async function loadRows() {
        let items; let total; let pageSize = 50;
        const initial = listOf(pick(st.preview, 'rows') || []);
        rowsBox.setAttribute('aria-busy', 'true');
        try {
          const res = await ctx.api(`/imports/${encodeURIComponent(st.batch.batchId)}/rows`, { query: { outcome: st.outcome, page: st.page } });
          items = listOf(res, 'rows');
          total = Number(pick(res, 'total') ?? items.length);
          pageSize = Number(pick(res, 'pageSize') || Math.max(items.length, 50));
        } catch (err) {
          // Fall back to the rows returned with the preview.
          items = st.outcome ? initial.filter((r) => R.outcome(r) === st.outcome) : initial;
          total = items.length;
          pageSize = Math.max(total, 1);
          if (err.status !== 404) ctx.toast(`Could not load rows: ${err.message}`, 'error');
        }
        rowsBox.removeAttribute('aria-busy');
        if (!rowsBox.isConnected) return;
        rowsBox.replaceChildren(dataTable({
          caption: `Rows${st.outcome ? ` — ${OUTCOMES[st.outcome]?.label || st.outcome}` : ''} (${formatNumber(total)})`,
          rowAttrs: (r) => ({ class: R.outcome(r) === 'rejected' ? 'row-highlight' : null }),
          columns: [
            { key: 'row', label: 'Row', rowHeader: true, align: 'end', render: (r) => String(R.row(r) ?? '—') },
            { key: 'code', label: 'Plant ID', render: (r) => (R.code(r) ? h('span', { class: 'mono' }, String(R.code(r))) : h('span', { class: 'np' }, 'Missing')) },
            { key: 'outcome', label: 'Outcome', render: (r) => { const o = OUTCOMES[R.outcome(r)] || { label: R.outcome(r) || '—', tone: 'neutral' }; return h('span', { class: 'badges' }, badge(o.label, o.tone), R.incomplete(r) ? badge('Incomplete', 'warn') : null); } },
            { key: 'errors', label: 'Errors', render: (r) => messages(R.errors(r), 'danger') || h('span', { class: 'np' }, '—') },
            { key: 'warnings', label: 'Warnings', render: (r) => messages(R.warnings(r), 'warn') || h('span', { class: 'np' }, '—') },
            { key: 'changes', label: 'Changes', render: (r) => changeList(R.changes(r)) || h('span', { class: 'np' }, '—') },
          ],
          rows: items,
          empty: 'No rows with this outcome.',
        }), total > pageSize ? pager({ page: st.page, pageSize, total, label: 'Preview rows pages', onChange: (p) => { st.page = p; loadRows(); } }) : '');
      }

      const nothing = n('new') + n('update') === 0;
      const view = h('div', null,
        h('h3', null, 'Step 4 — Preview'),
        defList([['File', st.batch.filename], ['Sheet', st.sheet], ['Batch', `#${st.batch.batchId}`]]),
        summaryChips(summary, 'Preview summary'),
        n('rejected') ? notice('danger', h('p', null, `${formatNumber(n('rejected'))} row${n('rejected') === 1 ? '' : 's'} will be rejected and not imported. Download the validation errors to fix them in the file.`)) : null,
        n('duplicateReview') ? notice('warn', h('p', null, `${formatNumber(n('duplicateReview'))} row${n('duplicateReview') === 1 ? '' : 's'} will be held for duplicate review after commit.`)) : null,
        nothing ? notice('info', h('p', null, 'No plants will be created or updated: every accepted row matches the existing records.')) : null,
        h('div', { class: 'form-actions', style: 'margin-bottom:12px' },
          h('button', { type: 'button', class: 'btn btn-primary', onClick: commit }, 'Commit import…'),
          h('button', {
            type: 'button', class: 'btn btn-secondary', onClick: async (e) => {
              try { const r = await withBusy(e.currentTarget, () => ctx.download(`/imports/${encodeURIComponent(st.batch.batchId)}/errors.csv`), 'Preparing…'); ctx.toast(`Downloaded ${r.filename}.`, 'success'); } catch (err) { ctx.toast(`Could not download the errors CSV: ${err.message}`, 'error'); }
            },
          }, 'Download validation errors (CSV)'),
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => go(2) }, 'Back to mapping'),
          cancelBtn()),
        h('div', { class: 'toolbar' }, fOutcome),
        rowsBox);
      loadRows();
      return view;
    }

    async function commit() {
      const s = pick(st.preview, 'summary') || {};
      const n = (k) => Number(pick(s, k) || 0);
      const body = h('div', null,
        h('p', null, `This will import sheet “${st.sheet}” from ${st.batch.filename}:`),
        h('ul', null,
          h('li', null, `${formatNumber(n('new'))} new plant${n('new') === 1 ? '' : 's'}`),
          h('li', null, `${formatNumber(n('update'))} updated plant${n('update') === 1 ? '' : 's'}`),
          h('li', null, `${formatNumber(n('unchanged'))} unchanged`),
          h('li', null, `${formatNumber(n('rejected'))} rejected (not imported)`)),
        h('p', null, 'Every change is recorded in the audit log with this batch number.'));
      const { confirmed } = await ctx.confirmDialog({ title: 'Commit this import?', body, confirmLabel: 'Commit import' });
      if (!confirmed) return;
      try {
        const res = await ctx.api(`/imports/${encodeURIComponent(st.batch.batchId)}/commit`, { method: 'POST' });
        st.done = res || {};
        ctx.toast('Import committed.', 'success');
        go(4, 'Import committed.');
        loadHistory();
      } catch (err) { ctx.toast(`Commit failed: ${err.message}`, 'error'); }
    }

    // Step 5 — done
    function doneView() {
      const d = st.done || {};
      const summary = pick(d, 'summary') || pick(st.preview, 'summary') || {};
      return h('div', null,
        h('h3', null, 'Import complete'),
        notice('success', h('p', null, 'The spreadsheet has been imported. Original values are stored verbatim with each plant.')),
        defList([
          ['Source file', pick(d, 'filename', 'sourceFilename', 'source_filename') || st.batch.filename],
          ['Sheet', pick(d, 'sheet', 'sheetName', 'sheet_name') || st.sheet],
          ['Import date', ctx.formatDate(pick(d, 'committedAt', 'committed_at', 'importedAt') || new Date().toISOString())],
          ['Batch', `#${pick(d, 'batchId', 'id') || st.batch.batchId}`],
        ]),
        summaryChips(summary, 'Final import summary'),
        h('div', { class: 'form-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onClick: reset }, 'Start another import'),
          h('a', { class: 'btn btn-secondary', href: '#/incomplete' }, 'Review incomplete records'),
          ctx.can('duplicates') ? h('a', { class: 'btn btn-secondary', href: '#/duplicates' }, 'Review duplicates') : null));
    }

    // History
    async function loadHistory() {
      if (!historyBox.firstChild) historyBox.append(card('Previous imports', loadingBlock('Loading import history…')));
      let data;
      try { data = await ctx.api('/imports'); } catch (err) { historyBox.replaceChildren(card('Previous imports', errorBlock(err, loadHistory))); return; }
      if (!ctx.isCurrent()) return;
      const items = listOf(data, 'batches', 'imports');
      historyBox.replaceChildren(card('Previous imports', dataTable({
        caption: `Import batches (${items.length})`,
        columns: [
          { key: 'id', label: 'Batch', rowHeader: true, render: (b) => `#${pick(b, 'id', 'batchId')}` },
          { key: 'file', label: 'File & sheet', render: (b) => h('span', null, h('span', { dir: 'auto' }, pick(b, 'sourceFilename', 'source_filename', 'filename') || '—'), h('span', { class: 'small muted', style: 'display:block', dir: 'auto' }, pick(b, 'sheetName', 'sheet_name', 'sheet') || '')) },
          { key: 'status', label: 'Status', render: (b) => { const s = BATCH_STATUS[pick(b, 'status')] || [pick(b, 'status') || '—', 'neutral']; return badge(s[0], s[1]); } },
          {
            key: 'summary', label: 'Rows', render: (b) => {
              const s = maybeJson(pick(b, 'summary', 'summary_json')) || {};
              const parts = SUMMARY_CHIPS.filter(([k]) => k !== 'total').map(([k, label]) => [label, pick(s, k)]).filter(([, v]) => v);
              const total = pick(s, 'total');
              return total === undefined ? h('span', { class: 'np' }, '—') : h('span', { class: 'small' }, `${formatNumber(total)} rows`, parts.length ? `: ${parts.map(([l, v]) => `${formatNumber(v)} ${l.toLowerCase()}`).join(', ')}` : '');
            },
          },
          { key: 'created', label: 'Uploaded', render: (b) => { let by = pick(b, 'createdBy', 'created_by_name', 'createdByName', 'created_by'); if (by && typeof by === 'object') by = by.username; return h('span', { class: 'small' }, ctx.formatDate(pick(b, 'createdAt', 'created_at')), by ? h('span', { style: 'display:block' }, `by ${by}`) : null); } },
          { key: 'committed', label: 'Committed', render: (b) => (pick(b, 'committedAt', 'committed_at') ? ctx.formatDate(pick(b, 'committedAt', 'committed_at')) : h('span', { class: 'np' }, '—')) },
          {
            key: 'act', label: 'Errors', className: 'actions', render: (b) => h('button', {
              type: 'button', class: 'btn btn-secondary btn-sm', 'aria-label': `Download validation errors for batch ${pick(b, 'id', 'batchId')}`,
              onClick: async (e) => { try { await withBusy(e.currentTarget, () => ctx.download(`/imports/${encodeURIComponent(pick(b, 'id', 'batchId'))}/errors.csv`)); } catch (err) { ctx.toast(`Could not download: ${err.message}`, 'error'); } },
            }, 'CSV'),
          },
        ],
        rows: items,
        empty: 'No imports yet.',
      })));
    }

    go(0);
    // Don't steal focus on first render: the shell focuses the page heading.
    el.querySelector('h1')?.focus();
    await loadHistory();
  },
};
