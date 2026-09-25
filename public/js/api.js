// Fetch wrapper for the Team Water JSON API.
//   import { getJSON, getConfig, ApiError, isAbort } from '/js/api.js';
//   const data = await getJSON('/api/search?lat=…', { signal, timeoutMs: 12000 });
// Errors: ApiError { code, message, status, details } — code is the server's error.code, or
// 'timeout' | 'network' | 'bad_response' for client-side failures. Aborts by the caller's signal
// re-throw a DOMException named 'AbortError' (check with isAbort(err)).

export class ApiError extends Error {
  constructor(code, message, status = 0, details = undefined) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const isAbort = (err) => err?.name === 'AbortError';

export async function getJSON(url, { signal, timeoutMs = 12000, headers } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers } });
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut) throw new ApiError('timeout', 'The request took too long.');
    throw new ApiError('network', err?.message || 'Network error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new ApiError(res.ok ? 'bad_response' : `http_${res.status}`, `Unexpected response (${res.status})`, res.status);
  }
  if (!res.ok || (body && body.error && typeof body.error === 'object')) {
    const e = body?.error || {};
    throw new ApiError(e.code || `http_${res.status}`, e.message || `Request failed (${res.status})`, res.status, e.details);
  }
  return body;
}

let configPromise = null;
/** /api/config, fetched once per page. Rejects with ApiError if unavailable (retry allowed). */
export function getConfig({ force = false } = {}) {
  if (!configPromise || force) {
    configPromise = getJSON('/api/config', { timeoutMs: 10000 }).catch((err) => { configPromise = null; throw err; });
  }
  return configPromise;
}
