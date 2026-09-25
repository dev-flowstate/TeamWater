'use strict';
// Shared plumbing for external map providers (geocoding / routing).
//   - Every call has a timeout (AbortSignal) taken from config.
//   - Every provider has a circuit breaker: after ANY failure the provider is skipped for 60 s,
//     so a dead upstream costs one timeout per minute instead of one per visitor request.
//   - Failures surface as ProviderError(reason) — callers translate them into the explicit
//     `available:false` / `unavailable` states of the public contract. Nothing is ever faked.
// Privacy: request URLs may contain user coordinates, so they are NEVER logged here.

const BREAKER_COOLDOWN_MS = 60_000;

class ProviderError extends Error {
  /** reason: 'unavailable' | 'mode_unsupported' | 'disabled' | 'no_route' | 'busy' */
  constructor(reason, message, { provider = null, status = null } = {}) {
    super(message || reason);
    this.name = 'ProviderError';
    this.reason = reason;
    this.provider = provider;
    this.status = status;
  }
}

class CircuitBreaker {
  constructor(name, cooldownMs = BREAKER_COOLDOWN_MS) {
    this.name = name;
    this.cooldownMs = cooldownMs;
    this.openUntil = 0;
    this.lastError = null;
  }
  isOpen(now = Date.now()) { return now < this.openUntil; }
  fail(err) { this.openUntil = Date.now() + this.cooldownMs; this.lastError = err ? String(err.message || err).slice(0, 200) : null; }
  succeed() { this.openUntil = 0; this.lastError = null; }
  reset() { this.succeed(); }
  /** Runs fn() unless the breaker is open. Any thrown error (except explicit non-tripping ones) opens it. */
  async run(fn) {
    if (this.isOpen()) throw new ProviderError('unavailable', `${this.name} temporarily skipped after a recent failure`, { provider: this.name });
    try {
      const result = await fn();
      this.succeed();
      return result;
    } catch (err) {
      // Configuration-type answers (unsupported mode, no route between two points) are not provider outages.
      if (!(err instanceof ProviderError && (err.reason === 'mode_unsupported' || err.reason === 'no_route' || err.reason === 'disabled'))) this.fail(err);
      throw err instanceof ProviderError ? err : new ProviderError('unavailable', err && err.message, { provider: this.name });
    }
  }
}

/**
 * fetch() + JSON with a hard timeout. Throws ProviderError('unavailable') on network errors,
 * timeouts, non-2xx statuses and invalid JSON. `fetch` is looked up on globalThis at call time
 * so tests can stub it.
 */
async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 5000, provider = 'provider', accept4xxJson = false } = {}) {
  let res;
  try {
    res = await globalThis.fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new ProviderError('unavailable', timedOut ? `${provider} timed out` : `${provider} unreachable`, { provider });
  }
  let text;
  try {
    text = await res.text();
  } catch {
    throw new ProviderError('unavailable', `${provider} response could not be read`, { provider, status: res.status });
  }
  const clientError = res.status >= 400 && res.status < 500 && res.status !== 429;
  if (!res.ok && !(accept4xxJson && clientError)) throw new ProviderError('unavailable', `${provider} returned HTTP ${res.status}`, { provider, status: res.status });
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('unavailable', `${provider} returned invalid JSON`, { provider, status: res.status });
  }
}

/** Small in-memory LRU with TTL (per process; nothing persisted). */
class TtlLru {
  constructor({ max = 200, ttlMs = 5 * 60_000 } = {}) { this.max = max; this.ttlMs = ttlMs; this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, hit); // refresh recency
    return hit.value;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
}

module.exports = { BREAKER_COOLDOWN_MS, ProviderError, CircuitBreaker, fetchJson, TtlLru };
