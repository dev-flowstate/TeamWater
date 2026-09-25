// Overview: counts from GET /stats plus quick links to the work that needs doing.
import { h, pick, pageHeader, card, formatNumber, formatDate, loadingBlock, errorBlock, dataTable, keyLabel } from '../ui.js';

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (!Array.isArray(v)) out.push([key, v]);
  }
  return out;
}

function stat(label, value, note, id) {
  return h('li', { class: 'stat', 'data-stat': id || null },
    h('span', { class: 'stat-value' }, value === null ? '—' : formatNumber(value)),
    h('span', { class: 'stat-label' }, label),
    note ? h('span', { class: 'stat-note' }, note) : null);
}

function quick(tone, text, linkText, href) {
  return h('li', { class: `quick-link quick-link-${tone}` },
    h('p', null, text),
    href ? h('a', { class: 'btn btn-secondary btn-sm', href }, linkText, h('span', { 'aria-hidden': 'true' }, ' →')) : null);
}

export default {
  id: 'overview',
  title: 'Overview',
  permission: 'stats',
  icon: 'home',
  async render(el, ctx) {
    el.append(pageHeader({ title: 'Overview', subtitle: 'Data completeness, review work and imports at a glance. Counts come straight from the database.' }));
    const body = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading counts…'));
    el.append(body);

    async function load() {
      body.replaceChildren(loadingBlock('Loading counts…'));
      let s;
      try { s = await ctx.api('/stats'); } catch (err) { body.replaceChildren(errorBlock(err, load)); return; }
      if (!ctx.isCurrent()) return;

      const total = num(pick(s, 'plants.total', 'plantsTotal', 'plants_total', 'totalPlants', 'plants.count'));
      const exact = num(pick(s, 'plants.location.exact', 'plants.exact', 'plantsExact', 'plants.exactLocation', 'plants.withExactLocation', 'exact'));
      const area = num(pick(s, 'plants.location.area', 'plants.area', 'plantsArea', 'plants.areaOnly'));
      const none = num(pick(s, 'plants.location.none', 'plants.noLocation', 'plantsNoLocation', 'plants.none'));
      const review = num(pick(s, 'plants.needsReview', 'plantsNeedsReview', 'needsReview'));
      const demo = num(pick(s, 'plants.demo', 'plantsDemo', 'demoPlants'));
      const tests = num(pick(s, 'waterTests.total', 'tests.total', 'waterTests', 'testsTotal'));
      const queue = num(pick(s, 'reports.reviewQueue', 'reports.queue', 'reviewQueue', 'reportsReviewQueue'));
      const pending = num(pick(s, 'reports.byStatus.pending', 'reports.pending', 'reportsPending'));
      const verified = num(pick(s, 'plants.verified', 'plantsVerified'));
      const geoPending = num(pick(s, 'plants.location.pendingReview'));
      const ratings = num(pick(s, 'ratings.byStatus.pending', 'ratings.pending', 'ratingsPending'));
      const appealsOpen = num(pick(s, 'appeals.byStatus.open', 'appeals.open', 'appealsOpen'));
      const appeals = appealsOpen === null ? null : appealsOpen + (num(pick(s, 'appeals.byStatus.in_progress')) || 0);
      const dups = num(pick(s, 'duplicates.open', 'duplicatesOpen', 'duplicates'));
      const areasReview = num(pick(s, 'areas.needsReview', 'areasNeedsReview', 'areas.unresolved')) ?? ((num(pick(s, 'areas.byGeocodeStatus.ambiguous')) || 0) + (num(pick(s, 'areas.byGeocodeStatus.not_found')) || 0) + (num(pick(s, 'areas.byGeocodeStatus.not_attempted')) || 0));
      const lastImport = pick(s, 'lastImport.at', 'imports.lastImportAt', 'lastImportAt', 'imports.lastCommittedAt', 'imports.last.committedAt');
      const sourceFile = pick(s, 'lastImport.sourceFile', 'imports.sourceFile', 'sourceFile', 'imports.last.sourceFilename', 'imports.last.filename');
      const batches = num(pick(s, 'imports.batches', 'imports.total', 'importBatches'));

      const tiles = h('ul', { class: 'stats-grid', 'aria-label': 'Key counts' },
        stat('Plants in database', total, demo ? `${formatNumber(demo)} demo` : null, 'total'),
        stat('Exact locations', exact, total !== null && exact !== null ? `${formatNumber(exact)} of ${formatNumber(total)}` : null, 'exact'),
        stat('Area-level only', area, 'approximate area centre', 'area'),
        stat('No location at all', none, 'text list only', 'none'),
        stat('Flagged for data review', review, null, 'review'),
        verified !== null ? stat('Verified by staff', verified, 'plants with a verification date', 'verified') : null,
        tests !== null ? stat('Water tests recorded', tests, null, 'tests') : null,
        queue !== null ? stat('Reports in review queue', queue, pending !== null ? `${formatNumber(pending)} pending` : null, 'queue') : null,
        dups !== null ? stat('Open duplicate candidates', dups, null, 'dups') : null);

      const links = h('ul', { class: 'quick-links' });
      if (total !== null && exact !== null) {
        links.append(quick(exact < total ? 'warn' : 'ok',
          h('span', null, h('strong', null, `${formatNumber(exact)} of ${formatNumber(total)}`), ' plants have exact coordinates. The rest can only be shown as area-level approximations.'),
          'Fix locations', ctx.can('plants:read') ? '#/incomplete' : null));
      }
      if (geoPending) links.append(quick('warn', h('span', null, h('strong', null, formatNumber(geoPending)), ' geocoded positions are waiting for review (not public until verified).'), 'Review positions', '#/plants?coord=pending'));
      if (review) links.append(quick('warn', h('span', null, h('strong', null, formatNumber(review)), ' plants are flagged for data review (inconsistent or implausible source values).'), 'Review flagged plants', '#/plants?needsReview=1'));
      if (queue !== null && ctx.can('reports:read')) links.append(quick(queue > 0 ? 'warn' : 'ok', h('span', null, h('strong', null, formatNumber(queue)), ` report${queue === 1 ? '' : 's'} waiting in the review queue.`), 'Open review queue', '#/reports?queue=1'));
      if (ratings && ctx.can('reports:moderate')) links.append(quick('info', h('span', null, h('strong', null, formatNumber(ratings)), ' ratings awaiting a decision.'), 'Review ratings', '#/ratings'));
      if (appeals && ctx.can('appeals')) links.append(quick('info', h('span', null, h('strong', null, formatNumber(appeals)), ' open appeals or correction requests.'), 'Open appeals', '#/appeals'));
      if (dups && ctx.can('duplicates')) links.append(quick('warn', h('span', null, h('strong', null, formatNumber(dups)), ' possible duplicate records need a decision.'), 'Resolve duplicates', '#/duplicates'));
      if (areasReview && ctx.can('plants:read')) links.append(quick('warn', h('span', null, h('strong', null, formatNumber(areasReview)), ' areas need location review (ambiguous, not found or not yet geocoded).'), 'Review areas', '#/areas'));
      if (ctx.can('imports')) {
        links.append(quick('info', lastImport
          ? h('span', null, 'Last import ', h('strong', null, formatDate(lastImport)), sourceFile ? h('span', null, ' from ', h('code', null, String(sourceFile))) : null, batches !== null ? ` · ${formatNumber(batches)} batch${batches === 1 ? '' : 'es'} in history` : '', '.')
          : 'No spreadsheet import has been recorded yet.', 'Imports', '#/imports'));
      }

      const all = flatten(s).filter(([, v]) => v === null || ['number', 'string', 'boolean'].includes(typeof v));
      const details = h('details', { class: 'expander' },
        h('summary', null, `All counts (${all.length})`),
        dataTable({
          caption: 'All statistics returned by the server',
          columns: [
            { key: 'k', label: 'Measure', rowHeader: true, render: (r) => keyLabel(r[0].replace(/\./g, ' › ')) },
            { key: 'v', label: 'Value', align: 'end', render: (r) => (typeof r[1] === 'number' ? formatNumber(r[1]) : /\d{4}-\d{2}-\d{2}T/.test(String(r[1])) ? formatDate(r[1]) : String(r[1] ?? '—')) },
          ],
          rows: all,
        }));

      body.replaceChildren(
        tiles,
        card('What needs attention', links.childElementCount ? links : h('p', { class: 'muted' }, 'Nothing needs attention right now.')),
        card('Details', details));
    }

    await load();
  },
};
