// Incomplete records (GET /incomplete): counts of missing information with lists and links to fix each plant.
import { h, pick, listOf, pageHeader, card, dataTable, pager, loadingBlock, errorBlock, formatNumber, notProvided, badge, keyLabel } from '../ui.js';
import { plantCode, plantName, plantTown, plantArea, precisionBadge, isDemo, demoBadge } from '../plant-util.js';

const KINDS = [
  { key: 'noExactLocation', label: 'No exact location', focus: 'location', fix: 'Fix location', browse: '#/plants?coord=missing', help: 'Not pinned by an administrator and no coordinates in the source. Shown only as area-level approximations.' },
  { key: 'noLocationAtAll', label: 'No location at all', focus: 'location', fix: 'Fix location', help: 'Neither an exact position nor a located area. Reachable only through text lists.' },
  { key: 'noName', label: 'No name', focus: 'edit', fix: 'Add name', help: 'The source spreadsheet has no plant names.' },
  { key: 'noHours', label: 'No opening hours', focus: 'edit', fix: 'Add hours', help: 'Opening hours are not recorded.' },
  { key: 'noTests', label: 'No water tests', focus: 'tests', fix: 'Add test', help: 'Water quality is shown as “Unknown”.' },
  { key: 'needsReview', label: 'Flagged for review', focus: 'details', fix: 'Review', browse: '#/plants?needsReview=1', help: 'Inconsistent or implausible source values.' },
];
const MISSING_LABEL = { coordinates: 'Coordinates', name: 'Name', address: 'Address', openingHours: 'Opening hours', collectionLimit: 'Collection limit', contact: 'Contact', accessibility: 'Accessibility', waterTests: 'Water tests', hours: 'Opening hours', location: 'Location' };

export default {
  id: 'incomplete',
  title: 'Incomplete records',
  permission: 'plants:read',
  icon: 'alert',
  async render(el, ctx) {
    let kind = KINDS.some((k) => k.key === (ctx.query && ctx.query.kind)) ? ctx.query.kind : 'noExactLocation';
    let page = Math.max(1, parseInt(ctx.query && ctx.query.page, 10) || 1);
    el.append(pageHeader({ title: 'Incomplete records', subtitle: 'What is missing from the plant records, and where to fix it. Nothing here is filled in automatically — unknown values stay “Not provided”.' }));
    const countsBox = h('div', null, loadingBlock('Loading counts…'));
    const listBox = h('div', { 'aria-live': 'polite' });
    el.append(countsBox, listBox);

    let counts = {};
    async function load() {
      ctx.setQuery({ kind, page: page > 1 ? page : '' });
      listBox.setAttribute('aria-busy', 'true');
      let data;
      try { data = await ctx.api('/incomplete', { query: { kind, type: kind, page } }); } catch (err) {
        listBox.removeAttribute('aria-busy');
        countsBox.replaceChildren(errorBlock(err, load));
        listBox.replaceChildren();
        return;
      }
      if (!ctx.isCurrent()) return;
      counts = pick(data, 'counts') || {};
      drawCounts();
      let items = pick(data, 'items');
      if (items && !Array.isArray(items) && typeof items === 'object') items = items[kind] || [];
      if (!Array.isArray(items)) items = listOf(data[kind] || data);
      const total = Number(pick(data, 'total') ?? items.length);
      const pageSize = Number(pick(data, 'pageSize') || items.length || 50);
      const k = KINDS.find((x) => x.key === kind);
      const table = dataTable({
        caption: `${k.label}: ${formatNumber(counts[kind] ?? total)} plant${(counts[kind] ?? total) === 1 ? '' : 's'}${items.length < (counts[kind] ?? total) ? ` (showing ${formatNumber(items.length)})` : ''}`,
        columns: [
          { key: 'code', label: 'Plant ID', rowHeader: true, render: (p) => h('a', { href: `#/plants/${encodeURIComponent(plantCode(p))}` }, plantCode(p)) },
          { key: 'name', label: 'Name', render: (p) => (plantName(p) ? h('span', { dir: 'auto' }, plantName(p)) : notProvided()) },
          { key: 'town', label: 'Town', render: (p) => plantTown(p) || '—' },
          { key: 'area', label: 'Area (as recorded)', render: (p) => h('span', { dir: 'auto' }, plantArea(p) || '—') },
          { key: 'loc', label: 'Location', render: (p) => h('span', { class: 'badges' }, precisionBadge(p), isDemo(p) ? demoBadge() : null) },
          { key: 'missing', label: 'Missing', render: (p) => { const m = pick(p, 'missing', 'missingFields', 'issues'); return Array.isArray(m) && m.length ? h('span', { class: 'badges' }, m.map((x) => badge(MISSING_LABEL[x] || keyLabel(x), 'unknown'))) : '—'; } },
          { key: 'fix', label: 'Action', render: (p) => h('a', { class: 'btn btn-secondary btn-sm', href: `#/plants/${encodeURIComponent(plantCode(p))}?focus=${k.focus}`, 'aria-label': `${k.fix} for ${plantCode(p)}` }, k.fix) },
        ],
        rows: items,
        empty: `No plants in “${k.label}”.`,
      });
      listBox.removeAttribute('aria-busy');
      listBox.replaceChildren(card(k.label,
        h('p', { class: 'card-sub' }, k.help, k.browse ? h('span', null, ' ', h('a', { href: k.browse }, 'Filter the plants list'), '.') : null),
        table,
        total > pageSize ? pager({ page, pageSize, total, onChange: (p) => { page = p; load(); } }) : null));
    }

    function drawCounts() {
      const list = h('ul', { class: 'stats-grid', 'aria-label': 'Missing information counts' }, KINDS.map((k) => {
        const n = counts[k.key];
        return h('li', { class: 'stat' },
          h('span', { class: 'stat-value' }, n === undefined ? '—' : formatNumber(n)),
          h('span', { class: 'stat-label' }, k.label),
          h('button', {
            type: 'button', class: `btn ${k.key === kind ? 'btn-primary' : 'btn-secondary'} btn-sm`, style: 'margin-top:8px',
            'aria-pressed': k.key === kind ? 'true' : 'false', onClick: () => { kind = k.key; page = 1; load(); },
          }, k.key === kind ? 'Showing' : 'Show list'));
      }));
      countsBox.replaceChildren(list);
    }

    await load();
  },
};
