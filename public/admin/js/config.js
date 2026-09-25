// Public site configuration (GET /api/config), fetched once. Resolves to null if unavailable —
// callers must cope (e.g. the map shows a "map tiles unavailable" notice).
let pending = null;

export function getPublicConfig() {
  if (!pending) {
    pending = fetch('/api/config', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }
  return pending;
}

export const FALLBACK_MAP = {
  center: [31.418, 73.079],
  defaultZoom: 11,
  bounds: [[30.75, 72.6], [31.85, 73.65]],
  maxZoom: 19,
  tileUrl: null,
  attribution: '',
};
