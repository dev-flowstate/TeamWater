// #/reports — moderation queue for community problem reports.
import {
  el, fill, icon, field, selectEl, notice, pageHeader, loadingState, errorState, emptyState, pager, cleanQuery,
  riskBadge, severityBadge, statusBadge, flaggedBadge, yesNo, plantOf, plantCell, listOf, pick, truthy, formatAge,
  CATEGORY_LABELS, STATUS_LABELS, OPEN_STATUSES, RISK_NOTE, labelFor, visuallyHidden, safeDate,
} from './_util.js';

// The API sorts serious+open first, then newest; a large page lets the priority sort below work on real sets.
const PAGE_SIZE = 200;
// Filters survive navigation to a report and back (in-memory only; nothing persisted).
const state = { status: '', queue: false, severity: '', plantCode: '', from: '', to: '', sort: 'priority', page: 1 };

const SORTS = [
  ['priority', 'Priority: serious and flagged first, then oldest pending'],
  ['oldest', 'Oldest first'],
  ['newest', 'Newest first'],
];

function norm(item) {
  return {
    id: item.id,
    reference: pick(item, 'reference') || `#${item.id}`,
    plant: plantOf(item),
    category: item.category,
    severity: pick(item, 'severity') || 'normal',
    status: item.status,
    riskLevel: pick(item, 'riskLevel', 'risk_level'),
    riskScore: pick(item, 'riskScore', 'risk_score'),
    reviewQueue: truthy(pick(item, 'reviewQueue', 'review_queue')),
    phoneVerified: truthy(pick(item, 'phoneVerified', 'phone_verified')),
    photoCount: Number(pick(item, 'photoCount', 'photo_count') ?? 0),
    createdAt: pick(item, 'createdAt', 'created_at'),
    redacted: truthy(pick(item, 'redacted')),
  };
}

function priorityKey(r) {
  const open = OPEN_STATUSES.includes(r.status) ? 0 : 1;
  const serious = r.severity === 'serious' ? 0 : 1;
  const flagged = r.reviewQueue ? 0 : 1;
  const pending = r.status === 'pending' ? 0 : 1;
  return [open, serious, flagged, pending];
}

export function sortReports(items, mode) {
  const t = (r) => Date.parse(r.createdAt) || 0;
  const copy = items.slice();
  if (mode === 'newest') return copy.sort((a, b) => t(b) - t(a) || a.id - b.id);
  if (mode === 'oldest') return copy.sort((a, b) => t(a) - t(b) || a.id - b.id);
  return copy.sort((a, b) => {
    const ka = priorityKey(a), kb = priorityKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return t(a) - t(b) || a.id - b.id; // oldest first within a group
  });
}

/** Local date window check (YYYY-MM-DD inclusive) — applied in case the API ignores from/to. */
function inDateWindow(iso, from, to) {
  if (!from && !to) return true;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return true;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return (!from || local >= from) && (!to || local <= to);
}

export default {
  id: 'reports',
  title: 'Reports',
  permission: 'reports:read',
  icon: 'flag',
  async render(container, ctx) {
    let disposed = false;
    // A link such as #/reports?queue=1&severity=serious sets the filters (e.g. from the overview page).
    const q = ctx.query || {};
    if (['status', 'queue', 'severity', 'plantCode', 'from', 'to', 'sort'].some((k) => q[k] !== undefined)) {
      Object.assign(state, {
        status: STATUS_LABELS[q.status] ? q.status : '',
        queue: q.queue === '1' || q.queue === 'true',
        severity: ['serious', 'normal'].includes(q.severity) ? q.severity : '',
        plantCode: String(q.plantCode || '').trim().toUpperCase(),
        from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '',
        to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '',
        sort: SORTS.some(([k]) => k === q.sort) ? q.sort : 'priority',
        page: 1,
      });
    }
    const syncUrl = () => {
      if (typeof ctx.setQuery !== 'function' || disposed || (ctx.isCurrent && !ctx.isCurrent())) return;
      ctx.setQuery({
        status: state.status, queue: state.queue ? 1 : '', severity: state.severity, plantCode: state.plantCode,
        from: state.from, to: state.to, sort: state.sort === 'priority' ? '' : state.sort,
      });
    };
    const live = el('p', { class: 'mod-sr', 'aria-live': 'polite', role: 'status' });
    const results = el('div', { class: 'mod-results' });

    // ── Filters ──
    const fStatus = selectEl([['', 'Any status'], ...Object.entries(STATUS_LABELS)], state.status, { name: 'status' });
    const fQueue = el('input', { type: 'checkbox', name: 'queue', checked: state.queue, class: 'mod-check' });
    const fSeverity = selectEl([['', 'Any severity'], ['serious', 'Serious'], ['normal', 'Normal']], state.severity, { name: 'severity' });
    const fPlant = el('input', { type: 'text', name: 'plantCode', class: 'mod-input', value: state.plantCode, placeholder: 'e.g. FSD-WFP-0009', autocomplete: 'off', spellcheck: 'false' });
    const fFrom = el('input', { type: 'date', name: 'from', class: 'mod-input', value: state.from });
    const fTo = el('input', { type: 'date', name: 'to', class: 'mod-input', value: state.to });
    const fSort = selectEl(SORTS, state.sort, { name: 'sort' });

    const form = el('form', { class: 'mod-filters', 'aria-label': 'Filter reports', novalidate: true },
      field('Status', fStatus),
      el('div', { class: 'mod-field mod-field--check' },
        el('label', { class: 'mod-checklabel' }, fQueue, el('span', {}, icon('flag'), ' Flagged for review only'))),
      field('Severity', fSeverity),
      field('Plant code', fPlant),
      field('Submitted from', fFrom),
      field('Submitted to', fTo),
      field('Sort', fSort, { className: 'mod-field--wide' }),
      el('div', { class: 'mod-filters__actions' },
        el('button', { type: 'submit', class: 'mod-btn mod-btn--primary' }, icon('search'), 'Apply filters'),
        el('button', { type: 'button', class: 'mod-btn mod-btn--ghost', on: { click: reset } }, 'Reset')));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      readForm();
      state.page = 1;
      syncUrl();
      load();
    });
    // Sort only reorders what is loaded; apply immediately.
    fSort.addEventListener('change', () => { state.sort = fSort.value; syncUrl(); load(); });

    function readForm() {
      state.status = fStatus.value;
      state.queue = fQueue.checked;
      state.severity = fSeverity.value;
      state.plantCode = fPlant.value.trim().toUpperCase();
      state.from = fFrom.value;
      state.to = fTo.value;
      state.sort = fSort.value;
    }

    function reset() {
      Object.assign(state, { status: '', queue: false, severity: '', plantCode: '', from: '', to: '', sort: 'priority', page: 1 });
      fStatus.value = ''; fQueue.checked = false; fSeverity.value = ''; fPlant.value = ''; fFrom.value = ''; fTo.value = ''; fSort.value = 'priority';
      syncUrl();
      load();
    }

    container.replaceChildren(el('div', { class: 'mod mod-reports' },
      pageHeader('Reports', 'Community problem reports waiting for review. Reports are not findings until a moderator confirms them.'),
      notice('info', el('p', { class: 'mod-risknote' }, RISK_NOTE)),
      form,
      live,
      results));

    let seq = 0;
    async function load() {
      const mySeq = ++seq;
      results.replaceChildren(loadingState('Loading reports…'));
      let res;
      try {
        res = await ctx.api('/reports', {
          query: cleanQuery({
            status: state.status, queue: state.queue ? 1 : '', severity: state.severity, plantCode: state.plantCode,
            // The server filters by from/to and orders by priority/newest; 'oldest' is ordered client-side below.
            from: state.from, to: state.to,
            sort: state.sort === 'oldest' ? 'newest' : state.sort,
            page: state.page, pageSize: PAGE_SIZE,
          }),
        });
      } catch (err) {
        if (disposed || mySeq !== seq) return;
        results.replaceChildren(errorState(err, load));
        live.textContent = 'Could not load reports.';
        return;
      }
      if (disposed || mySeq !== seq) return;
      const all = listOf(res).map(norm);
      const items = sortReports(all.filter((r) => inDateWindow(r.createdAt, state.from, state.to)), state.sort);
      const total = Number(res && res.total) || all.length;
      const pageSize = Number(res && res.pageSize) || PAGE_SIZE;
      live.textContent = items.length ? `${total} report${total === 1 ? '' : 's'} found.` : 'No reports match these filters.';

      if (!items.length) {
        results.replaceChildren(emptyState('No reports match these filters.'));
        return;
      }
      fill(results,
        el('div', { class: 'mod-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Reports table (scrolls horizontally)' },
          table(items, total)),
        pager({ page: state.page, pageSize, total, onChange: (p) => { state.page = p; load(); } }));
    }

    function table(items, total) {
      const now = Date.now();
      return el('table', { class: 'mod-table mod-table--reports' },
        el('caption', {}, `${total} report${total === 1 ? '' : 's'}`,
          el('span', { class: 'mod-caption-note' }, ` — sorted by ${SORTS.find(([k]) => k === state.sort)[1].toLowerCase()}`)),
        el('thead', {}, el('tr', {},
          ['Reference', 'Plant', 'Category', 'Severity', 'Status', 'Risk', 'Phone verified', 'Photos', 'Age']
            .map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, items.map((r) => el('tr', { class: [r.reviewQueue && 'is-flagged', r.severity === 'serious' && 'is-serious'] },
          el('th', { scope: 'row' }, el('div', { class: 'mod-cell-ref' },
            el('a', { href: `#/reports/${encodeURIComponent(r.id)}`, class: 'mod-ref' }, r.reference),
            r.reviewQueue ? flaggedBadge() : null,
            r.redacted ? el('span', { class: 'mod-muted' }, 'Redacted') : null)),
          el('td', {}, plantCell(ctx, r.plant)),
          el('td', {}, labelFor(CATEGORY_LABELS, r.category)),
          el('td', {}, severityBadge(r.severity)),
          el('td', {}, statusBadge(r.status)),
          el('td', {}, riskBadge(r.riskLevel)),
          el('td', {}, yesNo(r.phoneVerified, { yes: 'Verified', no: 'Not verified' })),
          el('td', { class: 'mod-num' }, r.photoCount ? [icon('camera'), ` ${r.photoCount}`] : '0', visuallyHidden(r.photoCount === 1 ? ' photo' : ' photos')),
          el('td', { class: 'mod-num' }, el('time', { datetime: r.createdAt || '', title: r.createdAt ? safeDate(ctx, r.createdAt) : '' }, formatAge(r.createdAt, now)))))));
    }

    syncUrl(); // reflect remembered filters in the address bar
    await load();
    return () => { disposed = true; };
  },
};
