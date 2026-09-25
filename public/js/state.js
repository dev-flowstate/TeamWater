// URL-backed state for the find/results page, so back/forward and shared links work.
//   ?lat=&lng=&label=&sort=nearest|recommended&mode=driving|walking&plant=CODE&group=exact|area
//    &view=map|list&technology=&operatorType=&hideClosed=1&area=<areaId>&lang=
// The search location lives only in the URL and memory — it is never stored by the site.

const DEFAULTS = { sort: 'nearest', mode: 'driving', view: 'map' };

const num = (v, min, max) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export function readState(search = location.search) {
  const p = new URLSearchParams(search);
  const lat = num(p.get('lat'), -90, 90);
  const lng = num(p.get('lng'), -180, 180);
  const hasPoint = lat !== null && lng !== null;
  return {
    lat: hasPoint ? lat : null,
    lng: hasPoint ? lng : null,
    label: (p.get('label') || '').slice(0, 160) || null,
    area: /^\d{1,9}$/.test(p.get('area') || '') ? p.get('area') : null,
    sort: p.get('sort') === 'recommended' ? 'recommended' : 'nearest',
    mode: ['driving', 'walking'].includes(p.get('mode')) ? p.get('mode') : 'driving',
    plant: /^[A-Za-z0-9-]{1,40}$/.test(p.get('plant') || '') ? p.get('plant') : null,
    group: ['exact', 'area'].includes(p.get('group')) ? p.get('group') : null,
    view: p.get('view') === 'list' ? 'list' : 'map',
    technology: (p.get('technology') || '').slice(0, 200) || null,
    operatorType: (p.get('operatorType') || '').slice(0, 200) || null,
    hideClosed: p.get('hideClosed') === '1',
    lang: p.get('lang') || null,
  };
}

/** True when the state describes a results view (a point, or an area text list). */
export const isResultsState = (s) => (s.lat !== null && s.lng !== null) || !!s.area;

/** Same result set? (ranking must stay stable while only the selected plant/view changes) */
export function sameQuery(a, b) {
  return a.lat === b.lat && a.lng === b.lng && a.area === b.area && a.sort === b.sort && a.mode === b.mode &&
    a.technology === b.technology && a.operatorType === b.operatorType && a.hideClosed === b.hideClosed;
}

export function toSearch(s) {
  const p = new URLSearchParams();
  if (s.lat !== null && s.lat !== undefined && s.lng !== null && s.lng !== undefined) {
    p.set('lat', String(round6(s.lat)));
    p.set('lng', String(round6(s.lng)));
  }
  if (s.area) p.set('area', s.area);
  if (s.label) p.set('label', s.label);
  if (s.sort && s.sort !== DEFAULTS.sort) p.set('sort', s.sort);
  if (s.mode && s.mode !== DEFAULTS.mode) p.set('mode', s.mode);
  if (s.group) p.set('group', s.group);
  if (s.view && s.view !== DEFAULTS.view) p.set('view', s.view);
  if (s.technology) p.set('technology', s.technology);
  if (s.operatorType) p.set('operatorType', s.operatorType);
  if (s.hideClosed) p.set('hideClosed', '1');
  if (s.plant) p.set('plant', s.plant);
  const lang = new URLSearchParams(location.search).get('lang');
  if (lang) p.set('lang', lang);
  const q = p.toString();
  return q ? `?${q}` : location.pathname;
}

// The user's own origin point (not a plant coordinate): 6 decimals ≈ 0.1 m keeps links tidy.
const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function writeState(s, { replace = false } = {}) {
  const url = toSearch(s);
  const current = location.search || location.pathname;
  if (url === current) return;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

export function onStateChange(fn) {
  const handler = () => fn(readState());
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}
