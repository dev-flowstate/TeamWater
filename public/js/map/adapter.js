// Map adapter: one small interface over Leaflet (OpenStreetMap tiles) and the Google Maps JavaScript API.
//   const map = await createMap(el, config, { onSelect(code), onNotice(code), labels });
//   map.setOrigin({ lat, lng }, { accuracyM, draggable, onMove, label })
//   map.setPlants({ exact, area })          exact → accessible marker buttons; area → circles + count badges (never pins)
//   map.selectPlant(code)                   highlight marker / area circle and bring it into view
//   map.showRoute(geojson | null, { straightLineFrom, straightLineTo, label })
//   map.fitToResults()  map.focusArea(areaId)  map.enablePick(onPick)  map.disablePick()
//   map.getCenter() → { lat, lng }  map.onTileError(cb)  map.invalidateSize()  map.destroy()
// The library is loaded lazily on first call. Google falls back to Leaflet (with onNotice('google_failed')).
//
// labels (all optional, plain text):
//   exact(plant) → marker accessible name, area(group) → badge accessible name, areaShort(group) → badge text,
//   origin → "Your chosen location", straightLine → "Straight line — not a route"

export async function createMap(el, config, opts = {}) {
  const provider = config?.map?.provider;
  if (provider === 'google' && config.map.googleBrowserKey) {
    try {
      const { createGoogleMap } = await import('/js/map/google.js');
      return await createGoogleMap(el, config, opts);
    } catch (err) {
      console.warn('[map] Google Maps failed to load, falling back to Leaflet', err);
      opts.onNotice?.('google_failed');
      el.replaceChildren();
    }
  }
  const { createLeafletMap } = await import('/js/map/leaflet.js');
  return createLeafletMap(el, config, opts);
}

/** Group area-precision plants by their area (one circle + badge per area, in ranking order). */
export function groupByArea(areaPlants = []) {
  const groups = new Map();
  for (const p of areaPlants) {
    const a = p?.location?.area;
    if (!a || a.lat === null || a.lat === undefined || a.lng === null || a.lng === undefined) continue;
    const key = String(a.id ?? `${a.lat},${a.lng}`);
    if (!groups.has(key)) groups.set(key, { key, area: a, plants: [] });
    groups.get(key).plants.push(p);
  }
  return Array.from(groups.values());
}

export const DEFAULT_BOUNDS = [[30.75, 72.6], [31.85, 73.65]];
