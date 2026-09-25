// Plant card: renders one PlantSummary (+ PlantDetail when loaded) following docs/ARCHITECTURE.md §0/§5/§6.
//   const card = renderCard(plant, detail|null, ctx);   container.append(card.el)
//   card.setDetail(detail) · card.setDetailError(onRetry) · card.setRoute(routeInfo) · card.destroy()
// ctx: { origin:{lat,lng}|null, mode, config, sort, onViewArea(plant), listMode:boolean }
// Never invents values: unknown → "Not provided" / "Not verified" / "Unknown".
import { t, getLang, formatNumber, formatDate } from '/js/i18n.js';
import { h, icon, bdi, formatDistance, formatDuration, prefersReducedMotion } from '/js/util.js';

const NP = () => t('search.value.notProvided');
const notProvided = () => h('span', { class: 'is-missing' }, NP());

/* ─────────── Pure helpers (also used by the list view) ─────────── */

export function plantName(p) {
  return p.name ? p.name : t('search.card.nameMissing');
}

export function statusInfo(p) {
  const s = p.status || {};
  switch (s.code) {
    case 'operational':
      if (s.verified) {
        const d = formatDate(p.lastVerifiedAt || s.updatedAt);
        return { tone: 'ok', icon: 'check', text: d ? t('search.status.verifiedOn', { date: d }) : t('search.status.verified') };
      }
      if (s.source === 'spreadsheet') return { tone: 'listed', icon: 'info', text: t('search.status.listedSpreadsheet') };
      return { tone: 'listed', icon: 'info', text: t('search.status.listedUnverified') };
    case 'temporarily_closed': {
      const d = formatDate(s.updatedAt);
      return { tone: 'warn', icon: 'alert', text: d ? t('search.status.tempClosedSince', { date: d }) : t('search.status.tempClosed') };
    }
    case 'permanently_closed':
      return { tone: 'closed', icon: 'closed', text: t('search.status.permClosed') };
    case 'decommissioned':
      return { tone: 'closed', icon: 'closed', text: t('search.status.decommissioned') };
    default:
      return { tone: 'unknown', icon: 'question', text: t('search.status.unknown') };
  }
}

export function statusShort(p) {
  const s = p.status || {};
  if (s.code === 'operational') return s.verified ? t('search.status.short.verified') : t('search.status.short.listed');
  if (s.code === 'temporarily_closed') return t('search.status.short.tempClosed');
  if (s.code === 'permanently_closed' || s.code === 'decommissioned') return t('search.status.short.closed');
  return t('search.status.short.unknown');
}

export function methodLabel(method) {
  if (method === 'route') return t('search.distance.route');
  if (method === 'area_centre') return t('search.distance.areaCentre');
  if (method === 'straight_line') return t('search.distance.straight');
  return null;
}

export function recommendationText(rec) {
  if (!rec) return null;
  if (getLang() === 'en' && rec.text) return rec.text;
  const parts = (rec.reasons || []).map((c) => t(`search.reason.${c}`)).filter((s) => !s.startsWith('search.reason.'));
  if (!parts.length) return rec.text || null;
  return t('search.reason.join', { list: parts.join(t('search.reason.sep')) });
}

export function directionsUrls(origin, plant, mode) {
  const lat = plant?.location?.lat;
  const lng = plant?.location?.lng;
  if (plant?.location?.precision !== 'exact' || lat === null || lat === undefined || lng === null || lng === undefined) return null;
  // Plant coordinates are used exactly as stored (String(number) — never rounded).
  const dest = `${String(lat)},${String(lng)}`;
  const travel = mode === 'walking' ? 'walking' : 'driving'; // Google Maps URLs have no two-wheeler mode
  let google = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=${travel}`;
  let osm = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_${travel === 'walking' ? 'foot' : 'car'}&route=`;
  if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) {
    google = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest}&travelmode=${travel}`;
    osm += `${origin.lat},${origin.lng}%3B${dest}`;
  } else {
    osm += `%3B${dest}`;
  }
  return { google, osm };
}

function capacityBlock(c) {
  if (!c || c.value === null || c.value === undefined) {
    return c?.raw ? h('span', {}, t('search.capacity.rawOnly'), ' ', bdi(c.raw, 'mono')) : notProvided();
  }
  const UNIT_KEY = { gallons_per_hour: 'main', gallons_per_day: 'mainGpd', litres_per_hour: 'mainLph', litres_per_day: 'mainLpd' };
  const unitKey = UNIT_KEY[c.unit];
  const isGallons = c.unit === 'gallons_per_hour' || c.unit === 'gallons_per_day';
  const known = c.gallonType === 'us' || c.gallonType === 'imperial';
  const gallon = !isGallons ? null : c.gallonType === 'us' ? t('search.capacity.gallonUs') : c.gallonType === 'imperial' ? t('search.capacity.gallonImperial') : t('search.capacity.gallonUnspecified');
  // Litres only when the gallon type is known (the server computes them; nothing is assumed here).
  let litres = null;
  if (isGallons && known && c.unit === 'gallons_per_hour' && Number.isFinite(c.litresPerHour)) litres = t('search.capacity.litres', { n: formatNumber(Math.round(c.litresPerHour)) });
  if (isGallons && known && c.unit === 'gallons_per_day' && Number.isFinite(c.litresPerDay)) litres = t('search.capacity.litresDay', { n: formatNumber(Math.round(c.litresPerDay)) });
  return h('div', { class: 'capacity' },
    h('p', { class: 'capacity-main' },
      h('strong', {}, unitKey ? t(`search.capacity.${unitKey}`, { n: formatNumber(c.value) }) : bdi(c.raw || String(c.value))),
      ' — ', gallon ? t('search.capacity.basis', { gallon }) : t('search.capacity.basisPlain')),
    litres ? h('p', { class: 'capacity-litres' }, litres) : null,
    h('p', { class: 'capacity-warn' }, icon('info'), h('strong', {}, t('search.capacity.notAllowance'))));
}

export function qualityInfo(p, detail) {
  const q = p.waterQuality || {};
  const date = formatDate(q.latestSampleDate);
  switch (q.state) {
    case 'met_limits': {
      const test = (detail?.waterTests || []).filter((x) => x.outcome === 'met_limits' && x.standard)
        .sort((a, b) => String(b.sampleDate).localeCompare(String(a.sampleDate)))[0];
      return { tone: 'ok', icon: 'check', title: date ? t('search.quality.met', { date }) : t('search.quality.metNoDate'), text: null,
        standard: test?.standard ? [test.standard.name, test.standard.version].filter(Boolean).join(' ') : null };
    }
    case 'issue_detected':
      return { tone: 'bad', icon: 'alert', title: date ? t('search.quality.issue', { date }) : t('search.quality.issueNoDate'), text: null };
    case 'results_available':
      return { tone: 'neutral', icon: 'file', title: t('search.quality.available'), text: date ? t('search.quality.latestSample', { date }) : null };
    default:
      return { tone: 'unknown', icon: 'question', title: t('search.quality.unknownTitle'), text: t('search.quality.unknown') };
  }
}

/* ─────────── Card ─────────── */

function fact(label, value, iconName) {
  return h('div', { class: 'fact' },
    h('dt', {}, iconName && icon(iconName), h('span', {}, label)),
    h('dd', {}, value === null || value === undefined || value === '' ? notProvided() : value));
}

function precisionChip(p) {
  const loc = p.location || {};
  if (loc.precision === 'exact') {
    return h('span', { class: 'chip chip-exact' }, icon('pin'), loc.coordStatus === 'verified' ? t('search.precision.exactVerified') : t('search.precision.exactSource'));
  }
  if (loc.precision === 'area') return h('span', { class: 'chip chip-area' }, icon('map'), t('search.precision.area'));
  return h('span', { class: 'chip chip-none' }, icon('question'), t('search.precision.none'));
}

function ratingBlock(r) {
  const count = r?.count || 0;
  const body = [];
  if (count < 3) {
    body.push(h('p', { class: 'rating-value is-few' }, t('search.rating.tooFew')));
    body.push(h('p', { class: 'rating-sub' }, count === 0 ? t('search.rating.none') : t('search.rating.soFar', { n: formatNumber(count) })));
  } else {
    const score = r.adjusted ?? r.average;
    const stars = h('span', { class: 'stars', 'aria-hidden': 'true' });
    for (let i = 1; i <= 5; i++) stars.append(icon('star', score >= i - 0.25 ? 'is-on' : ''));
    body.push(h('p', { class: 'rating-value' }, stars, h('span', {}, t('search.rating.score', { score: formatNumber(score, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }))));
    body.push(h('p', { class: 'rating-sub' }, t('search.rating.count', { n: formatNumber(count) }), ' · ', t('search.rating.adjusted')));
  }
  return h('section', { class: 'box box-rating', 'aria-labelledby': 'rating-h' },
    h('h3', { id: 'rating-h', class: 'box-title' }, icon('users'), t('search.rating.title')),
    h('p', { class: 'box-kicker' }, t('search.rating.notSafety')),
    ...body);
}

function qualityBlock(p, detail) {
  const q = qualityInfo(p, detail);
  const box = h('section', { class: `box box-quality tone-${q.tone}`, 'aria-labelledby': 'quality-h' },
    h('h3', { id: 'quality-h', class: 'box-title' }, icon('drop'), t('search.quality.title'), h('span', { class: 'tag' }, t('search.quality.historical'))),
    h('p', { class: 'quality-state', 'data-testid': 'quality-state' }, icon(q.icon), h('span', {}, h('strong', {}, q.title), q.text ? [' — ', q.text] : null)),
    q.standard ? h('p', { class: 'quality-standard' }, t('search.quality.standard'), ' ', bdi(q.standard)) : null,
    h('div', { dataset: { slot: 'tests' } }),
    h('p', { class: 'box-note' }, t('search.quality.disclaimer')));
  return box;
}

function testsList(detail) {
  const tests = detail?.waterTests || [];
  if (!tests.length) return null;
  const outcome = (o) => t(`search.quality.outcome.${o}`);
  return h('details', { class: 'tests' },
    h('summary', {}, t('search.quality.testsSummary', { n: formatNumber(tests.length) })),
    h('ul', { class: 'tests-list' }, tests.map((x) => h('li', {},
      h('p', {}, h('strong', {}, formatDate(x.sampleDate) || NP()), ' · ', outcome(x.outcome), x.laboratory ? [' · ', bdi(x.laboratory)] : null),
      x.standard ? h('p', { class: 'muted' }, t('search.quality.standard'), ' ', bdi([x.standard.name, x.standard.version].filter(Boolean).join(' '))) : null,
      x.results?.length ? h('table', { class: 'tests-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('search.quality.col.parameter')), h('th', { scope: 'col' }, t('search.quality.col.value')), h('th', { scope: 'col' }, t('search.quality.col.limit')), h('th', { scope: 'col' }, t('search.quality.col.within')))),
        h('tbody', {}, x.results.map((r) => h('tr', {},
          h('td', {}, bdi(r.parameter)), h('td', {}, bdi([r.valueText, r.unit].filter(Boolean).join(' ') || NP())), h('td', {}, r.limitText ? bdi(r.limitText) : NP()),
          h('td', {}, r.withinLimit === true ? t('search.quality.within.yes') : r.withinLimit === false ? t('search.quality.within.no') : t('search.quality.within.na')))))) : null,
      x.reportUrl && /^\/api\/files\/\d+$/.test(x.reportUrl) ? h('a', { href: x.reportUrl, rel: 'noopener', target: '_blank' }, icon('file'), t('search.quality.report')) : null))));
}

function reportsBlock(detail) {
  const r = detail?.reportsSummary;
  const items = [];
  if (!r) return null;
  for (const c of r.confirmedOpenIssues || []) {
    items.push(h('li', { class: 'report-confirmed' }, icon('alert'),
      h('span', {}, h('strong', {}, t('search.reports.confirmed', { category: t(`common.category.${c.category}`) })),
        c.confirmedAt ? [' — ', t('search.reports.confirmedOn', { date: formatDate(c.confirmedAt) })] : null,
        c.publicNote ? h('span', { class: 'report-note' }, bdi(c.publicNote)) : null)));
  }
  if (r.unverifiedOpen > 0) {
    items.push(h('li', { class: 'report-unverified' }, icon('info'),
      h('span', {}, t(r.unverifiedOpen === 1 ? 'search.reports.unverifiedOne' : 'search.reports.unverified', { n: formatNumber(r.unverifiedOpen) }),
        r.underReview > 0 ? [' ', t('search.reports.underReview', { n: formatNumber(r.underReview) })] : null,
        h('span', { class: 'report-note' }, t('search.reports.unverifiedNote')))));
  } else if (r.underReview > 0) {
    items.push(h('li', { class: 'report-unverified' }, icon('info'), h('span', {}, t('search.reports.underReviewOnly', { n: formatNumber(r.underReview) }))));
  }
  if (r.resolvedLast90d > 0) items.push(h('li', {}, icon('check'), h('span', {}, t('search.reports.resolved', { n: formatNumber(r.resolvedLast90d) }))));
  if (!items.length) items.push(h('li', {}, icon('check'), h('span', {}, t('search.reports.none'))));
  return h('ul', { class: 'reports-list' }, items);
}

function recordBlock(p, detail) {
  const kids = [];
  const tr = detail?.traceability;
  if (p.isDemo) kids.push(h('p', { class: 'record-demo' }, icon('demo'), t('search.record.demo')));
  if (tr) {
    kids.push(h('dl', { class: 'record-trace' },
      fact(t('search.record.file'), bdi(tr.sourceFile || NP())),
      fact(t('search.record.sheet'), tr.sheet ? bdi(tr.sheet) : null),
      fact(t('search.record.row'), tr.row !== null && tr.row !== undefined ? formatNumber(tr.row) : null),
      fact(t('search.record.imported'), formatDate(tr.importedAt))));
  } else if (detail && !p.isDemo) {
    kids.push(h('p', {}, t('search.record.noTrace')));
  }
  const issues = detail?.dataIssues || [];
  kids.push(h('h4', {}, t('search.record.issuesTitle')));
  kids.push(issues.length
    ? h('ul', { class: 'record-issues' }, issues.map((code) => {
      const text = t(`common.issue.${code}`);
      return h('li', {}, icon('flag'), h('span', {}, text.startsWith('common.issue.') ? bdi(code) : text));
    }))
    : h('p', { class: 'muted' }, t('search.record.noIssues')));
  const missing = detail?.missingFields || [];
  kids.push(h('h4', {}, t('search.record.missingTitle')));
  kids.push(missing.length
    ? h('ul', { class: 'record-missing' }, missing.map((k) => {
      const text = t(`common.field.${k}`);
      return h('li', {}, text.startsWith('common.field.') ? bdi(k) : text);
    }))
    : h('p', { class: 'muted' }, t('search.record.noMissing')));
  const sv = detail?.sourceValues && Object.entries(detail.sourceValues);
  if (sv && sv.length) {
    kids.push(h('h4', {}, t('search.record.valuesTitle')));
    kids.push(h('table', { class: 'record-values' },
      h('caption', { class: 'sr-only' }, t('search.record.valuesTitle')),
      h('tbody', {}, sv.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, bdi(k)), h('td', {}, v === null || v === '' ? NP() : bdi(String(v))))))));
  }
  const sources = detail?.sources || [];
  if (sources.length) {
    kids.push(h('h4', {}, t('search.record.sourcesTitle')));
    kids.push(h('ul', {}, sources.map((s) => h('li', {}, s.url && /^https?:\/\//.test(s.url) ? h('a', { href: s.url, rel: 'noopener', target: '_blank' }, bdi(s.title || s.url)) : bdi(s.title || NP())))));
  }
  return kids;
}

function stageFallback(slot, p) {
  const stages = p.technology?.stages || [];
  slot.replaceChildren(h('div', { class: 'diagram-fallback' },
    h('h3', { class: 'box-title' }, t('search.diagram.title')),
    h('ol', { class: 'stage-list' },
      h('li', { class: 'stage-intake' }, h('span', { class: 'stage-dot' }), h('span', {}, t('search.diagram.intake'), ' ', p.waterSource ? bdi(p.waterSource) : NP())),
      stages.map((s) => h('li', {}, h('span', { class: 'stage-dot' }), h('span', {}, t(`common.stage.${s}`))))),
    stages.length ? null : h('p', { class: 'muted' }, t('search.diagram.noStages', { raw: p.technology?.raw || NP() })),
    h('p', { class: 'muted' }, t('search.diagram.otherStages'))));
}

async function mountDiagram(slot, p) {
  try {
    const mod = await import('/js/diagram.js');
    if (typeof mod.renderPlantDiagram !== 'function') throw new Error('renderPlantDiagram missing');
    if (!slot.isConnected) return null;
    slot.replaceChildren();
    const inst = mod.renderPlantDiagram(slot, {
      stages: p.technology?.stages || [], waterSource: p.waterSource ?? null, technologyRaw: p.technology?.raw ?? null,
      lang: getLang(), animate: !prefersReducedMotion(),
    });
    return inst || null;
  } catch (err) {
    console.warn('[card] diagram unavailable, showing stage list', err);
    if (slot.isConnected) stageFallback(slot, p);
    return null;
  }
}

function hoursValue(p) {
  const oh = p.openingHours || {};
  if (!oh.text) return null;
  return h('span', {}, bdi(oh.text),
    oh.openNow === true ? h('span', { class: 'chip chip-ok chip-sm' }, t('search.hours.openNow')) : null,
    oh.openNow === false ? h('span', { class: 'chip chip-warn chip-sm' }, t('search.hours.closedNow')) : null);
}

export function renderCard(p, detail, ctx = {}) {
  const loc = p.location || {};
  const exact = loc.precision === 'exact';
  const st = statusInfo(p);
  const dirs = exact ? directionsUrls(ctx.origin, p, ctx.mode) : null;
  const d = detail || null;

  // Header
  const header = h('header', { class: 'card-head' },
    h('div', { class: 'card-chips' },
      p.isDemo ? h('span', { class: 'chip chip-demo' }, icon('demo'), t('common.demo.plant')) : null,
      precisionChip(p)),
    h('h2', { class: `card-name${p.name ? '' : ' is-missing'}`, id: 'card-name' }, p.name ? bdi(p.name) : t('search.card.nameMissing')),
    h('p', { class: 'card-code' }, t('search.card.plantId'), ' ', bdi(p.code, 'mono')),
    h('p', { class: 'card-area' }, icon('map'),
      h('span', {}, p.areaRaw ? bdi(p.areaRaw) : NP(), p.town ? [' · ', bdi(p.town)] : null)));

  // Distance
  let distance = null;
  if (!ctx.listMode && Number.isFinite(p.distanceM)) {
    distance = h('div', { class: 'card-distance' },
      h('p', { class: 'dist-value' }, bdi(formatDistance(p.distanceM))),
      h('p', { class: 'dist-method' }, methodLabel(p.distanceMethod) || ''),
      Number.isFinite(p.durationS)
        ? h('p', { class: 'dist-time' }, icon('clock'), t(ctx.mode === 'walking' ? 'search.distance.timeWalk' : ctx.mode === 'two_wheeler' ? 'search.distance.timeTwo' : 'search.distance.timeDrive', { time: formatDuration(p.durationS) }))
        : null);
  } else if (ctx.listMode) {
    distance = h('div', { class: 'card-distance is-none' }, h('p', { class: 'dist-method' }, t('search.distance.none')));
  }

  const rec = ctx.sort === 'recommended' && p.recommendation ? h('div', { class: 'card-rec' },
    h('p', { class: 'card-rec-title' }, icon('star'), t('search.rec.title')),
    h('p', {}, recommendationText(p.recommendation))) : null;

  const status = h('div', { class: `card-status tone-${st.tone}` }, icon(st.icon), h('p', {}, st.text));

  // Actions
  const whyId = `dir-why-${p.code}`;
  const actions = h('div', { class: 'card-actions' });
  if (dirs) {
    actions.append(
      h('a', { class: 'btn btn-primary', href: dirs.google, target: '_blank', rel: 'noopener', 'data-testid': 'directions' }, icon('route'), t('search.dir.google')),
      h('a', { class: 'btn btn-ghost', href: dirs.osm, target: '_blank', rel: 'noopener', 'data-testid': 'directions-osm' }, icon('external'), t('search.dir.osm')));
  } else {
    actions.append(h('button', { type: 'button', class: 'btn btn-primary', 'aria-disabled': 'true', 'aria-describedby': whyId, 'data-testid': 'directions' }, icon('route'), t('search.dir.google')));
    if (loc.precision === 'area' && ctx.onViewArea) {
      actions.append(h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => ctx.onViewArea(p) } }, icon('map'), t('search.dir.viewArea')));
    }
  }
  actions.append(h('a', { class: 'btn btn-ghost', href: `/report.html?plant=${encodeURIComponent(p.code)}&lang=${getLang()}` }, icon('flag'), t('search.card.report')));
  const dirWhy = dirs ? null : h('p', { class: 'card-why', id: whyId }, icon('info'),
    loc.precision === 'area' ? t('search.dir.areaOnly') : t('search.dir.noLocation'));
  const routeSlot = exact ? h('p', { class: 'card-route', dataset: { slot: 'route' }, 'aria-live': 'polite' }) : null;

  // Facts
  const facts = h('dl', { class: 'facts' },
    fact(t('search.fact.address'), p.address ? bdi(p.address) : null, 'pin'),
    fact(t('search.fact.landmark'), p.landmark ? bdi(p.landmark) : null, 'flag'),
    fact(t('search.fact.hours'), hoursValue(p), 'clock'),
    fact(t('search.fact.technology'), p.technology?.raw ? bdi(p.technology.raw) : null, 'filter'),
    fact(t('search.fact.source'), p.waterSource ? bdi(p.waterSource) : null, 'drop'),
    fact(t('search.fact.capacity'), capacityBlock(p.capacity), 'gauge'),
    fact(t('search.fact.limit'), p.collectionLimit ? bdi(String(p.collectionLimit)) : null, 'info'),
    fact(t('search.fact.operator'), p.operator?.type || p.operator?.name
      ? h('span', {}, p.operator?.name ? [bdi(p.operator.name), ' · '] : null, p.operator?.type ? bdi(p.operator.type) : null, p.operator?.name ? null : h('span', { class: 'muted' }, ' ', t('search.fact.operatorTypeOnly')))
      : null, 'users'),
    fact(t('search.fact.lastVerified'), p.lastVerifiedAt ? formatDate(p.lastVerifiedAt) : h('span', { class: 'is-missing' }, t('search.value.notVerified')), 'check'));
  const contactSlot = h('div', { dataset: { slot: 'contact' } });

  const reportsSec = h('section', { class: 'box box-reports', 'aria-labelledby': 'reports-h' },
    h('h3', { id: 'reports-h', class: 'box-title' }, icon('flag'), t('search.reports.title')),
    h('div', { dataset: { slot: 'reports' } }, h('p', { class: 'skeleton-line' }), h('p', { class: 'skeleton-line short' })));

  const diagramSlot = h('div', { class: 'card-diagram', dataset: { slot: 'diagram' } }, h('div', { class: 'skeleton-block' }));

  const recordDetails = h('details', { class: 'record' },
    h('summary', {}, icon('file'), t('search.record.title')),
    h('div', { class: 'record-body', dataset: { slot: 'record' } }, h('p', { class: 'muted' }, t('search.card.loadingDetails'))));

  const detailNote = h('div', { dataset: { slot: 'detail-note' } });

  const el = h('article', { class: `card-body${p.isDemo ? ' is-demo' : ''}`, 'aria-labelledby': 'card-name', dataset: { code: p.code } },
    header,
    h('div', { class: 'card-top' }, distance, status),
    rec,
    actions, dirWhy, routeSlot,
    detailNote,
    facts, contactSlot,
    h('div', { class: 'boxes' }, qualityBlock(p, d), ratingBlock(p.rating)),
    reportsSec,
    diagramSlot,
    recordDetails);

  let diagram = null;
  let destroyed = false;
  mountDiagram(diagramSlot, p).then((inst) => { if (destroyed) inst?.destroy?.(); else diagram = inst; });

  const api = {
    el,
    setDetail(det) {
      if (!det) return;
      const q = qualityBlock(p, det);
      const oldQ = el.querySelector('.box-quality');
      oldQ?.replaceWith(q);
      const tests = testsList(det);
      if (tests) q.querySelector('[data-slot=tests]').append(tests);
      el.querySelector('[data-slot=reports]').replaceChildren(reportsBlock(det) || h('p', { class: 'muted' }, NP()));
      el.querySelector('[data-slot=record]').replaceChildren(...recordBlock(p, det));
      const extra = [];
      if (det.operatorName) extra.push(fact(t('search.fact.operatorName'), bdi(det.operatorName), 'users'));
      if (det.neighborhood) extra.push(fact(t('search.fact.neighborhood'), bdi(det.neighborhood), 'map'));
      if (det.accessibility) extra.push(fact(t('search.fact.accessibility'), bdi(String(det.accessibility)), 'info'));
      if (det.publicPhone) extra.push(fact(t('search.fact.phone'), h('a', { href: `tel:${String(det.publicPhone).replace(/[^\d+]/g, '')}` }, bdi(det.publicPhone)), 'info'));
      if (det.publicContactNote) extra.push(fact(t('search.fact.contactNote'), bdi(det.publicContactNote), 'info'));
      el.querySelector('[data-slot=contact]').replaceChildren(extra.length ? h('dl', { class: 'facts facts-extra' }, extra) : '');
      el.querySelector('[data-slot=detail-note]').replaceChildren();
    },
    setDetailError(onRetry) {
      const note = h('div', { class: 'notice notice-warn' }, icon('alert'),
        h('p', {}, t('search.card.detailError')),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: onRetry } }, icon('refresh'), t('common.retry')));
      el.querySelector('[data-slot=detail-note]').replaceChildren(note);
      el.querySelector('[data-slot=reports]').replaceChildren(h('p', { class: 'muted' }, t('search.card.detailUnavailable')));
      el.querySelector('[data-slot=record]').replaceChildren(h('p', { class: 'muted' }, t('search.card.detailUnavailable')));
    },
    setRoute(info) {
      if (!routeSlot) return;
      routeSlot.className = 'card-route';
      if (!info) { routeSlot.replaceChildren(); return; }
      if (info.loading) { routeSlot.replaceChildren(icon('route'), h('span', {}, t('search.route.loading'))); return; }
      if (info.available) {
        routeSlot.classList.add('is-ok');
        routeSlot.replaceChildren(icon('route'), h('span', {}, t('search.route.ok', {
          dist: formatDistance(info.distanceM) || NP(),
          time: formatDuration(info.durationS) || NP(),
          mode: t(`search.mode.${['walking', 'two_wheeler'].includes(info.mode) ? info.mode : 'driving'}`),
        })));
        return;
      }
      routeSlot.classList.add('is-straight');
      const reason = info.detail === 'no_route' ? t('search.route.reason.no_route') : t(`search.route.reason.${info.reason || 'provider_unavailable'}`);
      routeSlot.replaceChildren(icon('info'), h('span', {}, h('strong', {}, t('search.route.straightLabel')), ' — ', reason));
    },
    destroy() {
      destroyed = true;
      try { diagram?.destroy?.(); } catch { /* ignore */ }
      diagram = null;
    },
  };
  if (d) api.setDetail(d);
  return api;
}
