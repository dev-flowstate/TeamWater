// Plants list: search + filters (town, location precision, status, needs review, demo) with pagination.
// Filters live in the hash query (#/plants?coord=missing&page=2) so links and reloads keep them.
import { h, pageHeader, formField, dataTable, pager, loadingBlock, errorBlock, listOf, pick, formatNumber, notProvided, badge } from '../ui.js';
import { plantCode, plantName, plantTown, plantArea, isDemo, needsReview, precisionBadge, statusBadge, demoBadge, plantLink, STATUS_LABEL } from '../plant-util.js';

const PAGE_SIZE = 50;

export default {
  id: 'plants',
  title: 'Plants',
  permission: 'plants:read',
  icon: 'droplet',
  async render(el, ctx) {
    const q = ctx.query || {};
    const state = {
      q: q.q || '', town: q.town || '', coord: q.coord || '', status: q.status || '',
      needsReview: q.needsReview === '1', demo: q.demo || '', page: Math.max(1, parseInt(q.page, 10) || 1),
    };

    el.append(pageHeader({ title: 'Plants', subtitle: 'Every plant record, as imported and as edited. Open a plant to see its original source values, fix its location or record evidence.' }));

    const fq = formField({ label: 'Search', name: 'q', type: 'search', value: state.q, hint: 'Plant ID, name or area', className: 'field-grow', attrs: { autocomplete: 'off' } });
    const ftown = formField({ label: 'Town / tehsil', name: 'town', type: 'select', value: state.town, options: [{ value: '', label: 'All towns' }, ...(state.town ? [state.town] : [])] });
    const fcoord = formField({
      label: 'Location precision', name: 'coord', type: 'select', value: state.coord, options: [
        { value: '', label: 'Any' }, { value: 'missing', label: 'No exact coordinates' }, { value: 'exact', label: 'Exact' },
        { value: 'area', label: 'Area only (approximate)' }, { value: 'pending', label: 'Geocoded, pending review' }],
    });
    const fstatus = formField({ label: 'Status', name: 'status', type: 'select', value: state.status, options: [{ value: '', label: 'Any' }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))] });
    const fdemo = formField({ label: 'Demo data', name: 'demo', type: 'select', value: state.demo, options: [{ value: '', label: 'Real and demo' }, { value: '0', label: 'Real plants only' }, { value: '1', label: 'Demo plants only' }] });
    const freview = formField({ label: 'Needs review only', name: 'needsReview', type: 'checkbox', value: state.needsReview });
    const form = h('form', { class: 'toolbar', role: 'search', 'aria-label': 'Filter plants' },
      fq, ftown, fcoord, fstatus, fdemo, freview,
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Apply'),
      h('button', { type: 'button', class: 'btn btn-secondary', onClick: reset }, 'Reset'));
    const status = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    const results = h('div');
    el.append(form, status, results);

    // Towns (from the area list; optional)
    ctx.api('/areas').then((data) => {
      const towns = [...new Set(listOf(data, 'areas').map((a) => pick(a, 'town')).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      const sel = ftown.control;
      const cur = state.town;
      sel.replaceChildren(h('option', { value: '' }, 'All towns'), ...towns.map((t) => h('option', { value: t }, t)));
      if (cur && !towns.includes(cur)) sel.append(h('option', { value: cur }, cur));
      sel.value = cur;
    }).catch(() => { /* keep the plain list */ });

    function readForm() {
      state.q = fq.control.value.trim();
      state.town = ftown.control.value;
      state.coord = fcoord.control.value;
      state.status = fstatus.control.value;
      state.demo = fdemo.control.value;
      state.needsReview = freview.control.checked;
    }
    function reset() {
      fq.control.value = ''; ftown.control.value = ''; fcoord.control.value = ''; fstatus.control.value = ''; fdemo.control.value = ''; freview.control.checked = false;
      readForm(); state.page = 1; load();
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); readForm(); state.page = 1; load(); });
    for (const c of [ftown.control, fcoord.control, fstatus.control, fdemo.control, freview.control]) {
      c.addEventListener('change', () => { readForm(); state.page = 1; load(); });
    }

    let seq = 0;
    async function load() {
      const mine = ++seq;
      ctx.setQuery({ q: state.q, town: state.town, coord: state.coord, status: state.status, needsReview: state.needsReview ? '1' : '', demo: state.demo, page: state.page > 1 ? state.page : '' });
      results.setAttribute('aria-busy', 'true');
      if (!results.firstChild) results.append(loadingBlock('Loading plants…'));
      let data;
      try {
        data = await ctx.api('/plants', { query: { q: state.q, town: state.town, coord: state.coord, status: state.status, needsReview: state.needsReview ? 1 : '', demo: state.demo, page: state.page, pageSize: PAGE_SIZE } });
      } catch (err) {
        if (mine !== seq) return;
        results.removeAttribute('aria-busy');
        results.replaceChildren(errorBlock(err, load));
        status.textContent = '';
        return;
      }
      if (mine !== seq || !ctx.isCurrent()) return;
      const items = listOf(data, 'plants');
      const total = Number(pick(data, 'total') ?? items.length);
      const pageSize = Number(pick(data, 'pageSize') || PAGE_SIZE);
      const page = Number(pick(data, 'page') || state.page);
      status.textContent = `${formatNumber(total)} plant${total === 1 ? '' : 's'} match.`;
      const table = dataTable({
        caption: `Plants — ${formatNumber(total)} result${total === 1 ? '' : 's'}${total > pageSize ? `, page ${page}` : ''}`,
        columns: [
          { key: 'code', label: 'Plant ID', rowHeader: true, render: (p) => h('span', { class: 'nowrap' }, plantLink(plantCode(p))) },
          { key: 'name', label: 'Name', render: (p) => (plantName(p) ? h('span', { dir: 'auto' }, plantName(p)) : notProvided()) },
          { key: 'town', label: 'Town / tehsil', render: (p) => h('span', { dir: 'auto' }, plantTown(p) || '—') },
          { key: 'area', label: 'Area (as recorded)', render: (p) => h('span', { dir: 'auto' }, plantArea(p) || '—') },
          { key: 'loc', label: 'Location', render: (p) => precisionBadge(p) },
          { key: 'status', label: 'Status', render: (p) => statusBadge(p) },
          {
            key: 'flags', label: 'Flags', render: (p) => h('span', { class: 'badges' },
              isDemo(p) ? demoBadge() : null,
              needsReview(p) ? badge('Needs review', 'warn') : null,
              !isDemo(p) && !needsReview(p) ? h('span', { class: 'np' }, '—') : null),
          },
        ],
        rows: items,
        empty: 'No plants match these filters.',
      });
      const nav = pager({ page, pageSize, total, label: 'Plants pages', onChange: (p) => { state.page = p; load(); el.querySelector('h1')?.scrollIntoView({ block: 'start' }); } });
      results.removeAttribute('aria-busy');
      results.replaceChildren(table, nav);
    }

    await load();
  },
};
