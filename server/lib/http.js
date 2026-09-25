'use strict';
// HTTP helpers shared by all routers.
//   throw new HttpError(400, 'invalid_input', 'Human message', { field: 'phone' })
//   router.get('/x', ah(async (req, res) => {...}))   // (Express 5 already forwards async errors; ah is harmless)
//   const v = validate(req.body, { name: str({ max: 200 }), stars: int({ min: 1, max: 5, optional: true }) })
// Error response shape (all APIs): { error: { code, message, details? } }

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Validators: each returns (value, field) => normalized value, or throws HttpError(400) ──
const fail = (field, msg) => { throw new HttpError(400, 'invalid_input', `${field}: ${msg}`, { field }); };
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function str({ max = 1000, min = 0, optional = false, trim = true, pattern } = {}) {
  return (v, f) => {
    if (isBlank(v)) { if (optional) return null; fail(f, 'is required'); }
    if (typeof v !== 'string' && typeof v !== 'number') fail(f, 'must be text');
    let s = String(v);
    if (trim) s = s.trim();
    // strip control chars except newline/tab
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (s.length < min) fail(f, `must be at least ${min} characters`);
    if (s.length > max) fail(f, `must be at most ${max} characters`);
    if (pattern && !pattern.test(s)) fail(f, 'has an invalid format');
    return s;
  };
}
function num({ min = -Infinity, max = Infinity, optional = false } = {}) {
  return (v, f) => {
    if (isBlank(v)) { if (optional) return null; fail(f, 'is required'); }
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) fail(f, 'must be a number');
    if (n < min || n > max) fail(f, `must be between ${min} and ${max}`);
    return n;
  };
}
function int(opts = {}) {
  const base = num(opts);
  return (v, f) => {
    const n = base(v, f);
    if (n !== null && !Number.isInteger(n)) fail(f, 'must be a whole number');
    return n;
  };
}
function oneOf(values, { optional = false } = {}) {
  return (v, f) => {
    if (isBlank(v)) { if (optional) return null; fail(f, 'is required'); }
    if (!values.includes(v)) fail(f, `must be one of: ${values.join(', ')}`);
    return v;
  };
}
function bool({ optional = false } = {}) {
  return (v, f) => {
    if (isBlank(v)) { if (optional) return null; fail(f, 'is required'); }
    if (v === true || v === 'true' || v === '1' || v === 1 || v === 'on') return true;
    if (v === false || v === 'false' || v === '0' || v === 0 || v === 'off') return false;
    fail(f, 'must be true or false');
  };
}
function date({ optional = false } = {}) {
  return (v, f) => {
    if (isBlank(v)) { if (optional) return null; fail(f, 'is required'); }
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) fail(f, 'must be a date YYYY-MM-DD');
    return s;
  };
}
function validate(input, schema) {
  const out = {};
  const src = input || {};
  for (const [field, check] of Object.entries(schema)) out[field] = check(src[field], field);
  return out;
}

function paginate(query, { defaultSize = 25, maxSize = 200 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(query.pageSize, 10) || defaultSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

function notFound(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.name === 'MulterError') {
    err = new HttpError(400, 'upload_rejected', err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message);
  }
  if (err && err.type === 'entity.too.large') err = new HttpError(413, 'payload_too_large', 'Request is too large');
  if (err && err.type === 'entity.parse.failed') err = new HttpError(400, 'invalid_json', 'Malformed JSON body');
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  res.status(status).json({
    error: {
      code: err instanceof HttpError ? err.code : 'server_error',
      message: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message,
      ...(err instanceof HttpError && err.details ? { details: err.details } : {}),
    },
  });
}

module.exports = { HttpError, ah, str, num, int, oneOf, bool, date, validate, paginate, notFound, errorHandler };
