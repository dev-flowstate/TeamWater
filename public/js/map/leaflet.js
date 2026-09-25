// Leaflet implementation of the map adapter (see adapter.js for the interface).
import { loadScript, loadCss } from '/js/util.js';
import { groupByArea, DEFAULT_BOUNDS } from '/js/map/adapter.js';

let leafletPromise = null;
export function loadLeaflet() {
  if (!leafletPromise) {
    leafletPromise = Promise.all([loadCss('/vendor/leaflet/leaflet.css'), loadScript('/vendor/leaflet/leaflet.js')])
      .then(() => {
        if (!window.L) throw new Error('leaflet_missing');
        return window.L;
      })
      .catch((err) => { leafletPromise = null; throw err; });
  }
  return leafletPromise;
}

const COLORS = { cobalt: '#2240c4', navy: '#0a1a33', teal: '#0a6d80', cyan: '#13a3bf', slate: '#4e6a7a', starfish: '#c4541f' };

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  if (text !== undefined) s.textContent = text;
  return s;
}

export async function createLeafletMap(el, config, opts = {}) {
  const L = await loadLeaflet();
  const m = config?.map || {};
  const labels = opts.labels || {};
  const bounds = L.latLngBounds(m.bounds || DEFAULT_BOUNDS);
  el.classList.add('tw-map');

  const map = L.map(el, {
    keyboard: true,
    zoomControl: true,
    minZoom: 8,
    maxZoom: m.maxZoom || 19,
    // Navigable across Faisalabad and its surroundings; padded and elastic rather than hard-locked.
    maxBounds: bounds.pad(0.8),
    maxBoundsViscosity: 0.3,
    zoomSnap: 0.5,
    tapTolerance: 20,
  });
  map.setView(m.center || bounds.getCenter(), m.defaultZoom || 11);
  if (map.attributionControl) map.attributionControl.setPrefix('<a href="https://leafletjs.com" rel="noopener">Leaflet</a>');

  // ── Tiles + failure detection ──
  const tileErrorCbs = new Set();
  let tileFailed = false;
  let tilesLoaded = 0;
  let tileErrors = 0;
  const failTiles = () => {
    if (tileFailed || tilesLoaded > 0) return;
    tileFailed = true;
    el.classList.add('tw-map--no-tiles');
    for (const cb of tileErrorCbs) { try { cb(); } catch { /* ignore */ } }
  };
  if (m.tileUrl) {
    const tiles = L.tileLayer(m.tileUrl, { attribution: m.attribution || '', maxZoom: m.maxZoom || 19 });
    tiles.on('tileload', () => { tilesLoaded++; });
    tiles.on('tileerror', () => { tileErrors++; if (tileErrors >= 3) failTiles(); });
    tiles.addTo(map);
  } else {
    setTimeout(failTiles, 0);
  }
  const watchdog = setTimeout(failTiles, 9000);

  // ── Layers ──
  const plantLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  let originMarker = null;
  let accuracyCircle = null;
  let exactMarkers = new Map(); // code → marker
  let areaLayers = new Map(); // areaKey → { circle, badge, group }
  let plantToArea = new Map(); // code → areaKey
  let selected = null;
  let pickHandler = null;

  function markerAria(marker, label) {
    const node = marker.getElement();
    if (!node) return;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', label);
    node.removeAttribute('title');
  }

  const api = {
    kind: 'leaflet',
    setOrigin(latlng, { accuracyM = null, draggable = false, onMove = null, label = labels.origin || '' } = {}) {
      if (originMarker) { originMarker.remove(); originMarker = null; }
      if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; }
      if (!latlng) return;
      const icon = L.divIcon({ className: 'tw-origin', html: span('tw-origin-dot'), iconSize: [30, 30], iconAnchor: [15, 15] });
      originMarker = L.marker([latlng.lat, latlng.lng], { icon, draggable, keyboard: true, title: label, alt: label, zIndexOffset: 1000, autoPan: true });
      originMarker.addTo(map);
      markerAria(originMarker, label);
      if (accuracyM && accuracyM > 0) {
        accuracyCircle = L.circle([latlng.lat, latlng.lng], { radius: accuracyM, color: COLORS.cobalt, weight: 1, fillColor: COLORS.cobalt, fillOpacity: 0.08, interactive: false }).addTo(map);
      }
      if (draggable && onMove) {
        originMarker.on('dragstart', () => { if (accuracyCircle) { accuracyCircle.remove(); accuracyCircle = null; } });
        originMarker.on('dragend', () => { const p = originMarker.getLatLng(); onMove({ lat: p.lat, lng: p.lng }); });
      }
    },

    setPlants({ exact = [], area = [] } = {}) {
      plantLayer.clearLayers();
      exactMarkers = new Map();
      areaLayers = new Map();
      plantToArea = new Map();
      selected = null;

      // Area groups first so exact pins sit above circles.
      for (const group of groupByArea(area)) {
        const { area: a, plants } = group;
        const circle = L.circle([a.lat, a.lng], {
          radius: a.radiusM || 1000, color: COLORS.teal, weight: 2, dashArray: '6 6', fillColor: COLORS.cyan, fillOpacity: 0.12, className: 'tw-area-circle',
        }).addTo(plantLayer);
        const badgeEl = span('tw-area-badge');
        badgeEl.append(span('tw-area-badge-count', String(plants.length)), span('tw-area-badge-name', labels.areaShort ? labels.areaShort(group) : a.name));
        const aria = labels.area ? labels.area(group) : `${plants.length} — ${a.name}`;
        const badge = L.marker([a.lat, a.lng], {
          icon: L.divIcon({ className: 'tw-area-badge-wrap', html: badgeEl, iconSize: null }),
          keyboard: true, title: aria, alt: aria, riseOnHover: true,
        }).addTo(plantLayer);
        markerAria(badge, aria);
        const pick = () => opts.onSelect?.(plants[0].code, { via: 'map' });
        circle.on('click', pick);
        badge.on('click', pick);
        areaLayers.set(group.key, { circle, badge, group });
        for (const p of plants) plantToArea.set(p.code, group.key);
      }

      exact.forEach((p, i) => {
        const lat = p?.location?.lat;
        const lng = p?.location?.lng;
        if (lat === null || lat === undefined || lng === null || lng === undefined) return;
        const pin = span('tw-pin');
        pin.append(span('tw-pin-num', String(p.rank ?? i + 1)));
        if (p.isDemo) pin.classList.add('is-demo');
        if (p.status?.code === 'temporarily_closed') pin.classList.add('is-closed');
        const label = labels.exact ? labels.exact(p) : p.code;
        const marker = L.marker([lat, lng], {
          icon: L.divIcon({ className: 'tw-pin-wrap', html: pin, iconSize: [38, 46], iconAnchor: [19, 44] }),
          keyboard: true, title: label, alt: label, riseOnHover: true,
        }).addTo(plantLayer);
        markerAria(marker, label);
        marker.on('click', () => opts.onSelect?.(p.code, { via: 'map' }));
        exactMarkers.set(p.code, marker);
      });
    },

    selectPlant(code, { pan = true } = {}) {
      if (selected) {
        selected.getElement?.()?.classList.remove('is-selected');
        if (selected.__area) {
          selected.__area.circle.setStyle({ weight: 2, fillOpacity: 0.12, color: COLORS.teal });
          selected.__area.badge.getElement()?.classList.remove('is-selected');
        }
        selected = null;
      }
      if (!code) return;
      const marker = exactMarkers.get(code);
      if (marker) {
        marker.getElement()?.classList.add('is-selected');
        marker.setZIndexOffset(800);
        selected = marker;
        if (pan && !map.getBounds().pad(-0.15).contains(marker.getLatLng())) map.panTo(marker.getLatLng());
        return;
      }
      const key = plantToArea.get(code);
      const al = key && areaLayers.get(key);
      if (al) {
        al.circle.setStyle({ weight: 3, fillOpacity: 0.22, color: COLORS.cobalt });
        al.badge.getElement()?.classList.add('is-selected');
        selected = { __area: al };
        if (pan && !map.getBounds().contains(al.circle.getLatLng())) map.panTo(al.circle.getLatLng());
      }
    },

    focusArea(areaKeyOrCode) {
      const key = areaLayers.has(String(areaKeyOrCode)) ? String(areaKeyOrCode) : plantToArea.get(areaKeyOrCode);
      const al = key && areaLayers.get(key);
      if (al) map.fitBounds(al.circle.getBounds(), { padding: [30, 30], maxZoom: 15 });
    },

    showRoute(geojson, { straightLineFrom = null, straightLineTo = null, label = labels.straightLine || '' } = {}) {
      routeLayer.clearLayers();
      if (geojson && geojson.type === 'LineString' && Array.isArray(geojson.coordinates) && geojson.coordinates.length > 1) {
        const pts = geojson.coordinates.map(([lng, lat]) => [lat, lng]);
        L.polyline(pts, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
        L.polyline(pts, { color: COLORS.cobalt, weight: 5, opacity: 0.95, interactive: false, className: 'tw-route' }).addTo(routeLayer);
        return;
      }
      if (straightLineFrom && straightLineTo) {
        const a = [straightLineFrom.lat, straightLineFrom.lng];
        const b = [straightLineTo.lat, straightLineTo.lng];
        const line = L.polyline([a, b], { color: COLORS.slate, weight: 3, dashArray: '2 9', lineCap: 'round', interactive: false, className: 'tw-straight' }).addTo(routeLayer);
        if (label) line.bindTooltip(label, { permanent: true, direction: 'center', className: 'tw-straight-label' }).openTooltip();
      }
    },

    fitToResults({ maxItems = 6 } = {}) {
      const b = L.latLngBounds([]);
      if (originMarker) b.extend(originMarker.getLatLng());
      let n = 0;
      for (const mk of exactMarkers.values()) { if (n++ >= maxItems) break; b.extend(mk.getLatLng()); }
      n = 0;
      for (const al of areaLayers.values()) { if (n++ >= Math.max(2, maxItems / 2)) break; b.extend(al.circle.getBounds()); }
      if (b.isValid()) map.fitBounds(b, { padding: [36, 36], maxZoom: 15 });
    },

    setView(latlng, zoom) { map.setView([latlng.lat, latlng.lng], zoom ?? map.getZoom()); },
    getCenter() { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },

    enablePick(onPick) {
      api.disablePick();
      pickHandler = (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
      map.on('click', pickHandler);
      el.classList.add('tw-map--picking');
    },
    disablePick() {
      if (pickHandler) map.off('click', pickHandler);
      pickHandler = null;
      el.classList.remove('tw-map--picking');
    },

    onTileError(cb) {
      if (tileFailed) cb();
      else tileErrorCbs.add(cb);
      return () => tileErrorCbs.delete(cb);
    },
    get tilesFailed() { return tileFailed; },
    invalidateSize() { map.invalidateSize(); },
    destroy() {
      clearTimeout(watchdog);
      tileErrorCbs.clear();
      map.remove();
      el.classList.remove('tw-map', 'tw-map--no-tiles', 'tw-map--picking');
    },
    raw: map,
  };
  return api;
}
