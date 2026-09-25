// Leaflet helpers for the admin dashboard (Leaflet is loaded on demand from /vendor/leaflet/).
//   const pin = await createPinMap(el, { lat, lng, onChange: (lat, lng) => … });   pin.set(lat, lng); pin.destroy();
//   const base = await createBaseMap(el);   base.map / base.L / base.destroy()
// Tiles come from GET /api/config → map.tileUrl. If the tile server is unreachable (e.g. no network) or not
// configured, a visible notice explains that positions still work without the background map.
import { getPublicConfig, FALLBACK_MAP } from './config.js';
import { h } from './ui.js';

let leafletPromise = null;

export function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-leaflet-css]')) {
        document.head.appendChild(h('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css', 'data-leaflet-css': '' }));
      }
      const s = document.createElement('script');
      s.src = '/vendor/leaflet/leaflet.js';
      s.async = true;
      s.addEventListener('load', () => (window.L ? resolve(window.L) : reject(new Error('The map library did not initialise.'))));
      s.addEventListener('error', () => reject(new Error('The map library could not be loaded.')));
      document.head.appendChild(s);
    }).catch((err) => { leafletPromise = null; throw err; });
  }
  return leafletPromise;
}

export const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;

export function inDistrict(lat, lng, bounds = FALLBACK_MAP.bounds) {
  const [[s, w], [n, e]] = bounds;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

/** Base map with tiles (when available), the district outline and a failure notice. */
export async function createBaseMap(el, { center, zoom } = {}) {
  const [L, cfg] = await Promise.all([loadLeaflet(), getPublicConfig()]);
  const mc = { ...FALLBACK_MAP, ...((cfg && cfg.map) || {}) };
  L.Icon.Default.imagePath = '/vendor/leaflet/images/';
  el.classList.add('map');
  const map = L.map(el, {
    center: center || mc.center,
    zoom: zoom || mc.defaultZoom,
    maxZoom: mc.maxZoom || 19,
    scrollWheelZoom: false,
    keyboard: true,
  });
  map.attributionControl.setPrefix(false);
  L.control.scale({ imperial: false }).addTo(map);
  // District outline keeps the map readable when the background tiles are missing.
  L.rectangle(mc.bounds || FALLBACK_MAP.bounds, { color: '#4e6a7a', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);

  const wrap = el.parentElement;
  let noticeEl = null;
  const showNotice = (text) => {
    if (noticeEl || !wrap) return;
    noticeEl = h('p', { class: 'map-notice', role: 'status' }, text);
    wrap.appendChild(noticeEl);
  };

  let timer = null;
  const tileUrl = mc.provider === 'google' ? null : mc.tileUrl;
  if (tileUrl) {
    let loaded = false;
    let errors = 0;
    const layer = L.tileLayer(tileUrl, { maxZoom: mc.maxZoom || 19, attribution: mc.attribution || '' });
    layer.on('tileload', () => { loaded = true; });
    layer.on('tileerror', () => {
      errors++;
      if (!loaded && errors >= 2) showNotice('Background map unavailable: the map tile server could not be reached. Positions, pins and the coordinate fields still work.');
    });
    layer.addTo(map);
    timer = setTimeout(() => { if (!loaded) showNotice('Background map is not loading (the tile server may be unreachable). Positions, pins and the coordinate fields still work.'); }, 6000);
  } else {
    showNotice(mc.provider === 'google'
      ? 'The public site uses Google Maps; the admin map shows positions without a background map.'
      : 'Background map not available (map configuration could not be loaded). Positions still work.');
  }
  setTimeout(() => map.invalidateSize(), 0);

  return {
    L, map, config: mc,
    destroy() { clearTimeout(timer); try { map.remove(); } catch { /* already removed */ } noticeEl?.remove(); },
  };
}

/**
 * Map with one draggable pin. Clicking the map moves the pin. onChange(lat, lng) fires after drag/click.
 * `context` may be { lat, lng, radiusM, label } to draw an approximate area circle (never a pin).
 */
export async function createPinMap(el, { lat = null, lng = null, onChange, context = null, draggable = true } = {}) {
  const has = Number.isFinite(lat) && Number.isFinite(lng);
  const ctxHas = context && Number.isFinite(context.lat) && Number.isFinite(context.lng);
  const base = await createBaseMap(el, {
    center: has ? [lat, lng] : ctxHas ? [context.lat, context.lng] : undefined,
    zoom: has ? 16 : ctxHas ? 14 : undefined,
  });
  const { L, map } = base;
  if (ctxHas) {
    L.circle([context.lat, context.lng], { radius: context.radiusM || 800, color: '#0a6d80', weight: 2, dashArray: '6 6', fillOpacity: 0.08, interactive: false })
      .addTo(map)
      .bindTooltip(context.label || 'Approximate area (not the plant position)', { direction: 'top' });
  }
  let marker = null;
  const place = (la, ln, { pan = true } = {}) => {
    if (!marker) {
      marker = L.marker([la, ln], { draggable, keyboard: true, title: 'Plant position', alt: 'Plant position pin' }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); onChange && onChange(round6(p.lat), round6(p.lng)); });
    } else marker.setLatLng([la, ln]);
    if (pan) map.panTo([la, ln]);
  };
  if (has) place(lat, lng, { pan: false });
  if (draggable) {
    map.on('click', (e) => { place(e.latlng.lat, e.latlng.lng, { pan: false }); onChange && onChange(round6(e.latlng.lat), round6(e.latlng.lng)); });
  }
  return {
    ...base,
    set(la, ln) { if (Number.isFinite(la) && Number.isFinite(ln)) place(la, ln); },
    clear() { if (marker) { marker.remove(); marker = null; } },
  };
}
