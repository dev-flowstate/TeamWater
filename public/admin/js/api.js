// Admin API client (shared by every admin section).
//
//   import { api, download, ApiError } from '/admin/js/api.js';
//   const data = await api('/plants', { query: { q: 'model', page: 2 } });          // GET /api/admin/plants?q=model&page=2
//   await api('/plants/FSD-WFP-0001', { method: 'PATCH', json: { name: 'X', reason: 'Checked on site' } });
//   await api('/plants/FSD-WFP-0001/tests', { method: 'POST', formData });         // multipart
//   await download('/export/plants.csv');                                           // saves the file
//
// * Paths are relative to /api/admin (a leading /api/admin is tolerated).
// * Non-GET requests carry the X-CSRF-Token header (token from login or GET /me; see setCsrfToken).
// * Errors are thrown as ApiError { status, code, message, details } parsed from {error:{code,message,details}}.
// * A 401 dispatches the window event 'tw-admin:unauthenticated' (the shell then shows the sign-in screen).
// * A 403 with code 'csrf' refreshes the token from GET /me and retries the request once.

const BASE = '/api/admin';
let csrfToken = null;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'error';
    this.details = details || null;
  }
}

export function setCsrfToken(token) { csrfToken = token || null; }
export function getCsrfToken() { return csrfToken; }

/** Build '/api/admin<path>?<query>' — query values that are null/undefined/'' are dropped; arrays repeat the key. */
export function buildUrl(path, query) {
  let p = String(path || '');
  if (p.startsWith(BASE)) p = p.slice(BASE.length);
  if (!p.startsWith('/')) p = '/' + p;
  let url = BASE + p;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  return url;
}

async function parseError(res) {
  let body = null;
  try {
    const type = res.headers.get('content-type') || '';
    body = type.includes('json') ? await res.json() : null;
  } catch { /* not JSON */ }
  const e = body && body.error ? body.error : {};
  const fallback = res.status === 404 ? 'This feature is not available on the server yet.'
    : res.status >= 500 ? 'Something went wrong on the server. Please try again.'
      : `Request failed (${res.status}).`;
  return new ApiError(res.status, e.code || (res.status === 404 ? 'not_found' : 'http_' + res.status), e.message || fallback, e.details);
}

function unauthenticated(err) {
  window.dispatchEvent(new CustomEvent('tw-admin:unauthenticated', { detail: { error: err } }));
}

async function refreshCsrf() {
  try {
    const res = await fetch(BASE + '/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const data = await res.json();
    setCsrfToken(data.csrfToken);
    return true;
  } catch {
    return false;
  }
}

async function send(path, { method = 'GET', json, formData, query, signal, accept = 'application/json' } = {}) {
  const m = String(method).toUpperCase();
  const headers = { Accept: accept };
  let body;
  if (formData !== undefined) body = formData; // browser sets the multipart boundary
  else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(m) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    return await fetch(buildUrl(path, query), { method: m, headers, body, credentials: 'same-origin', signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection and try again.');
  }
}

async function request(path, opts, retried = false) {
  const res = await send(path, opts);
  if (res.ok) return res;
  const err = await parseError(res);
  if (res.status === 403 && err.code === 'csrf' && !retried && (await refreshCsrf())) return request(path, opts, true);
  if (res.status === 401 && !opts.skipAuthEvent) unauthenticated(err);
  throw err;
}

/**
 * Call the admin API. Returns parsed JSON (or text for non-JSON responses, or null for 204).
 * @param {string} path  e.g. '/plants' (prefixed with /api/admin)
 * @param {{method?: string, json?: any, formData?: FormData, query?: object, signal?: AbortSignal}} [opts]
 */
export async function api(path, { method = 'GET', json, formData, query, signal, skipAuthEvent = false } = {}) {
  const res = await request(path, { method, json, formData, query, signal, skipAuthEvent });
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) return res.json();
  return res.text();
}

function filenameFrom(res, path) {
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (plain) return plain[1].trim();
  const last = String(path).split('?')[0].split('/').filter(Boolean).pop();
  return last || 'download';
}

/**
 * Download a file from the admin API (e.g. CSV exports) with the session cookie, then save it.
 * Resolves to { filename, size }. Throws ApiError on failure (message from the server when available).
 */
export async function download(path, { query, method = 'GET', json } = {}) {
  const res = await request(path, { method, query, json, accept: '*/*' });
  const blob = await res.blob();
  const filename = filenameFrom(res, path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { filename, size: blob.size };
}
