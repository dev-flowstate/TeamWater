// Google Maps JavaScript API implementation of the map adapter (MAP_PROVIDER=google).
// Loaded with the official async bootstrap (loading=async + importLibrary). Uses AdvancedMarkerElement
// when a Map ID is configured, otherwise the classic Marker. Any load/auth failure throws, and
// adapter.js falls back to Leaflet with a notice.
import { groupByArea, DEFAULT_BOUNDS } from '/js/map/adapter.js';

const COLORS = { cobalt: '#2240c4', teal: '#0a6d80', cyan: '#13a3bf', slate: '#4e6a7a' };
let loading = null;

function loadGoogle(key) {
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const cb = '__twGoogleMapsReady';
      const timer = setTimeout(() => reject(new Error('google_timeout')), 15000);
      window[cb] = () => { clearTimeout(timer); delete window[cb]; resolve(window.google.maps); };
      const s = document.createElement('script');
      const params = new URLSearchParams({ key, v: 'weekly', loading: 'async', callback: cb, language: document.documentElement.lang || 'en', region: 'PK' });
      s.src = `https://maps.googleapis.com/maps/api/js?${params}`;
      s.async = true;
      s.onerror = () => { clearTimeout(timer); reject(new Error('google_load_failed')); };
      document.head.append(s);
    }).catch((err) => { loading = null; throw err; });
  }
  return loading;
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  if (text !== undefined) s.textContent = text;
  return s;
}

export async function createGoogleMap(el, config, opts = {}) {
  const m = config.map;
  const labels = opts.labels || {};
  const authFailed = new Promise((_, reject) => { window.gm_authFailure = () => reject(new Error('google_auth_failed')); });
  authFailed.catch(() => {});
  const gm = await loadGoogle(m.googleBrowserKey);
  const { Map, Circle, Polyline } = await gm.importLibrary('maps');
  const markerLib = await gm.importLibrary('marker');
  const useAdvanced = !!m.googleMapId && !!markerLib.AdvancedMarkerElement;
  const [[s, w], [n, e]] = m.bounds || DEFAULT_BOUNDS;
  const padLat = (n - s) * 0.8;
  const padLng = (e - w) * 0.8;

  el.classList.add('tw-map');
  const map = new Map(el, {
    center: { lat: m.center?.[0] ?? (s + n) / 2, lng: m.center?.[1] ?? (w + e) / 2 },
    zoom: m.defaultZoom || 11,
    mapId: m.googleMapId || undefined,
    restriction: { latLngBounds: { south: s - padLat, west: w - padLng, north: n + padLat, east: e + padLng }, strictBounds: false },
    minZoom: 8,
    maxZoom: m.maxZoom || 20,
    keyboardShortcuts: true,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    clickableIcons: true,
  });
  // Surface an auth failure (bad key/referrer) that happens after the script loaded.
  const tileErrorCbs = new Set();
  let failed = false;
  authFailed.catch(() => { failed = true; for (const cb of tileErrorCbs) cb(); });

  function marker({ position, content, title, label, draggable = false, zIndex, icon }) {
    if (useAdvanced) {
      const mk = new markerLib.AdvancedMarkerElement({ map, position, content, title, gmpDraggable: draggable, zIndex });
      if (content) { content.setAttribute('role', 'button'); content.setAttribute('aria-label', title); }
      return { mk, remove: () => { mk.map = null; }, on: (ev, fn) => mk.addListener(ev === 'click' ? 'gmp-click' : ev, fn), el: () => content, pos: () => mk.position, z: (v) => { mk.zIndex = v; } };
    }
    const mk = new markerLib.Marker({ map, position, title, label, draggable, zIndex, icon, optimized: false });
    return { mk, remove: () => mk.setMap(null), on: (ev, fn) => mk.addListener(ev, fn), el: () => null, pos: () => mk.getPosition(), z: (v) => mk.setZIndex(v) };
  }
  const latOf = (p) => (typeof p.lat === 'function' ? p.lat() : p.lat);
  const lngOf = (p) => (typeof p.lng === 'function' ? p.lng() : p.lng);

  let origin = null;
  let accuracy = null;
  let plantItems = [];
  let exact = new window.Map();
  let areas = new window.Map();
  let plantToArea = new window.Map();
  let routeItems = [];
  let selected = null;
  let pickListener = null;

  const api = {
    kind: 'google',
    setOrigin(latlng, { accuracyM = null, draggable = false, onMove = null, label = labels.origin || '' } = {}) {
      origin?.remove(); origin = null;
      accuracy?.setMap(null); accuracy = null;
      if (!latlng) return;
      origin = marker({ position: latlng, content: span('tw-origin-dot tw-origin-dot--g'), title: label, draggable, zIndex: 1000,
        icon: { path: gm.SymbolPath.CIRCLE, scale: 9, fillColor: COLORS.cobalt, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } });
      if (accuracyM) accuracy = new Circle({ map, center: latlng, radius: accuracyM, strokeColor: COLORS.cobalt, strokeWeight: 1, fillColor: COLORS.cobalt, fillOpacity: 0.08, clickable: false });
      if (draggable && onMove) {
        origin.on('dragstart', () => { accuracy?.setMap(null); accuracy = null; });
        origin.on('dragend', () => { const p = origin.pos(); onMove({ lat: latOf(p), lng: lngOf(p) }); });
      }
    },
    setPlants({ exact: ex = [], area = [] } = {}) {
      for (const it of plantItems) it.remove();
      plantItems = []; exact = new window.Map(); areas = new window.Map(); plantToArea = new window.Map(); selected = null;
      for (const group of groupByArea(area)) {
        const a = group.area;
        const center = { lat: a.lat, lng: a.lng };
        const circle = new Circle({ map, center, radius: a.radiusM || 1000, strokeColor: COLORS.teal, strokeWeight: 2, fillColor: COLORS.cyan, fillOpacity: 0.12 });
        const content = span('tw-area-badge tw-area-badge--g');
        content.append(span('tw-area-badge-count', labels.areaCount ? labels.areaCount(group) : String(group.plants.length)), span('tw-area-badge-name', labels.areaShort ? labels.areaShort(group) : a.name));
        const title = labels.area ? labels.area(group) : a.name;
        const badge = marker({ position: center, content, title, label: { text: String(group.plants.length), color: '#ffffff', fontWeight: '700' },
          icon: { path: gm.SymbolPath.CIRCLE, scale: 15, fillColor: COLORS.teal, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
        const pick = () => opts.onSelect?.(group.plants[0].code, { via: 'map' });
        circle.addListener('click', pick);
        badge.on('click', pick);
        plantItems.push({ remove: () => circle.setMap(null) }, badge);
        areas.set(group.key, { circle, badge, content });
        for (const p of group.plants) plantToArea.set(p.code, group.key);
      }
      ex.forEach((p, i) => {
        if (p?.location?.lat === null || p?.location?.lat === undefined) return;
        const content = span('tw-pin tw-pin--g');
        content.append(span('tw-pin-num', String(p.rank ?? i + 1)));
        const title = labels.exact ? labels.exact(p) : p.code;
        const mk = marker({ position: { lat: p.location.lat, lng: p.location.lng }, content, title, label: String(p.rank ?? i + 1) });
        mk.on('click', () => opts.onSelect?.(p.code, { via: 'map' }));
        plantItems.push(mk);
        exact.set(p.code, mk);
      });
    },
    selectPlant(code, { pan = true } = {}) {
      if (selected?.el?.()) selected.el().classList.remove('is-selected');
      if (selected?.circle) { selected.circle.setOptions({ strokeWeight: 2, fillOpacity: 0.12, strokeColor: COLORS.teal }); selected.content?.classList.remove('is-selected'); }
      selected = null;
      if (!code) return;
      const mk = exact.get(code);
      if (mk) { mk.el()?.classList.add('is-selected'); mk.z(900); selected = mk; if (pan) map.panTo(mk.pos()); return; }
      const a = areas.get(plantToArea.get(code));
      if (a) { a.circle.setOptions({ strokeWeight: 3, fillOpacity: 0.22, strokeColor: COLORS.cobalt }); a.content?.classList.add('is-selected'); selected = a; if (pan) map.panTo(a.circle.getCenter()); }
    },
    focusArea(keyOrCode) {
      const a = areas.get(String(keyOrCode)) || areas.get(plantToArea.get(keyOrCode));
      if (a) map.fitBounds(a.circle.getBounds(), 30);
    },
    showRoute(geojson, { straightLineFrom = null, straightLineTo = null, label = labels.straightLine || '' } = {}) {
      for (const it of routeItems) it.setMap ? it.setMap(null) : it.remove();
      routeItems = [];
      if (geojson?.type === 'LineString' && geojson.coordinates?.length > 1) {
        const path = geojson.coordinates.map(([lng, lat]) => ({ lat, lng }));
        routeItems.push(new Polyline({ map, path, strokeColor: '#ffffff', strokeWeight: 9, strokeOpacity: 0.9, clickable: false }));
        routeItems.push(new Polyline({ map, path, strokeColor: COLORS.cobalt, strokeWeight: 5, strokeOpacity: 0.95, clickable: false }));
        return;
      }
      if (straightLineFrom && straightLineTo) {
        routeItems.push(new Polyline({ map, path: [straightLineFrom, straightLineTo], strokeOpacity: 0, clickable: false,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: COLORS.slate, scale: 3 }, offset: '0', repeat: '12px' }] }));
        if (label) {
          const mid = { lat: (straightLineFrom.lat + straightLineTo.lat) / 2, lng: (straightLineFrom.lng + straightLineTo.lng) / 2 };
          routeItems.push(marker({ position: mid, content: span('tw-straight-label', label), title: label,
            label: { text: label, color: '#0a1a33', fontSize: '12px' }, icon: { path: gm.SymbolPath.CIRCLE, scale: 0 } }));
        }
      }
    },
    fitToResults({ maxItems = 6 } = {}) {
      const b = new gm.LatLngBounds();
      let any = false;
      if (origin) { b.extend(origin.pos()); any = true; }
      let n = 0;
      for (const mk of exact.values()) { if (n++ >= maxItems) break; b.extend(mk.pos()); any = true; }
      n = 0;
      for (const a of areas.values()) { if (n++ >= Math.max(2, maxItems / 2)) break; b.union(a.circle.getBounds()); any = true; }
      if (any) map.fitBounds(b, 36);
    },
    setView(latlng, zoom) { map.setCenter(latlng); if (zoom) map.setZoom(zoom); },
    getCenter() { const c = map.getCenter(); return { lat: c.lat(), lng: c.lng() }; },
    enablePick(onPick) {
      api.disablePick();
      pickListener = map.addListener('click', (e) => { if (e.latLng) onPick({ lat: e.latLng.lat(), lng: e.latLng.lng() }); });
      el.classList.add('tw-map--picking');
    },
    disablePick() { pickListener?.remove(); pickListener = null; el.classList.remove('tw-map--picking'); },
    onTileError(cb) { if (failed) cb(); else tileErrorCbs.add(cb); return () => tileErrorCbs.delete(cb); },
    get tilesFailed() { return failed; },
    invalidateSize() { /* Google resizes automatically */ },
    destroy() { tileErrorCbs.clear(); api.disablePick(); for (const it of plantItems) it.remove(); origin?.remove(); el.replaceChildren(); el.classList.remove('tw-map', 'tw-map--picking'); },
    raw: map,
  };
  return api;
}
