// Small DOM toolkit for the admin dashboard. Builds DOM with textContent only — never innerHTML with data.
//
//   import { h, dataTable, formField, badge, pick } from '/admin/js/ui.js';
//   h('button', { class: 'btn', type: 'button', onClick: () => … }, 'Save')
//   dataTable({ caption: 'Plants', columns: [{ key: 'code', label: 'Code', rowHeader: true }], rows })
//
// Attribute rules for h(): `class`, `text`, `dataset`, `style` (object or string), `onXxx` functions become
// event listeners (no inline handlers — CSP), `value`/`checked`/`selected`/`indeterminate` are set as
// properties after children are appended, true → empty attribute, false/null/undefined → omitted.

const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'defaultValue']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const later = [];
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (/^on[A-Z]/.test(k) && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) later.push([k, v]);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  for (const [k, v] of later) el[k] = v;
  return el;
}

export function append(parent, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function clear(el) { el.replaceChildren(); return el; }

/** Like el.replaceChildren() but skips null/false (native DOM would insert the text "null"). */
export function replace(el, ...children) { el.replaceChildren(); return append(el, children); }

let uidSeq = 0;
export const uid = (prefix = 'tw') => `${prefix}-${++uidSeq}`;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Formatting ──
const TZ = 'Asia/Karachi';
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

/** 'YYYY-MM-DD' → '1 May 2026'; ISO timestamp → '1 May 2026, 14:05 PKT'; empty → '—'. */
export function formatDate(iso) {
  if (iso === null || iso === undefined || iso === '') return '—';
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) ? s : dateFmt.format(d);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : `${dateTimeFmt.format(d)} PKT`;
}

export const formatNumber = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));

export function todayIso() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

/** 'coord_status' / 'coordStatus' → 'Coord status' */
export function keyLabel(key) {
  const s = String(key).replace(/_json$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_:-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const camel = (s) => String(s).replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
export const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * First defined value among keys (dotted paths allowed). Each key is also tried in camelCase and snake_case,
 * so pick(p, 'coord_status') matches both { coord_status } and { coordStatus }.
 */
export function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    for (const k of new Set([key, camel(key), snake(key)])) {
      const v = getPath(obj, k);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** Parse a value that may be a JSON string (e.g. before_json) or already an object. */
export function maybeJson(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try { return JSON.parse(t); } catch { return v; }
}

/** List responses may be an array or { items } / { rows } / { <name>: [] }. */
export function listOf(data, ...names) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const n of ['items', 'rows', ...names]) if (Array.isArray(data[n])) return data[n];
  return [];
}

/** Masks Pakistani mobile numbers and long digit runs that look like phone numbers (defence in depth). */
export function redactPhones(text) {
  return String(text ?? '')
    .replace(/(?:\+|00)?92[\s-]?3\d{2}[\s-]?\d{7}\b/g, '[phone hidden]')
    .replace(/\b03\d{2}[\s-]?\d{7}\b/g, '[phone hidden]');
}

/** Only http(s) and same-origin relative URLs are rendered as links. */
export function safeUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (/^\/(?!\/)/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

// ── Small components ──
export const notProvided = (text = 'Not provided') => h('span', { class: 'np' }, text);

/** Tones: neutral | info | success | warn | danger | unknown | demo | accent */
export const badge = (text, tone = 'neutral', attrs = {}) => h('span', { class: `badge badge-${tone}`, ...attrs }, text);

/** Render any value for display: null → "Not provided"; objects → compact JSON; user text with dir=auto. */
export function displayValue(v, { empty = 'Not provided' } = {}) {
  if (v === null || v === undefined || v === '') return notProvided(empty);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return h('code', { class: 'json-inline', dir: 'ltr' }, redactPhones(JSON.stringify(v)));
  return h('span', { dir: 'auto' }, String(v));
}

export function pageHeader({ title, subtitle, actions, eyebrow } = {}) {
  return h('header', { class: 'page-header' },
    h('div', { class: 'page-header-text' },
      eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null,
      h('h1', { tabindex: '-1', dir: 'auto' }, title),
      subtitle ? h('p', { class: 'page-sub' }, subtitle) : null),
    actions ? h('div', { class: 'page-actions' }, actions) : null);
}

export function card(title, ...children) {
  const id = uid('card');
  return h('section', { class: 'card', 'aria-labelledby': id },
    title ? h('h2', { id, class: 'card-title' }, title) : null,
    ...children);
}

export const loadingBlock = (text = 'Loading…') => h('p', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);

export function errorBlock(err, retry) {
  const msg = err && err.message ? err.message : 'Something went wrong.';
  return h('div', { class: 'notice notice-danger', role: 'alert' },
    h('p', null, h('strong', null, 'Could not load: '), msg),
    retry ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: retry }, 'Try again') : null);
}

export const notice = (tone, ...children) => h('div', { class: `notice notice-${tone}` }, ...children);

/**
 * Semantic data table.
 * columns: [{ key, label, render?(row) → Node|string, rowHeader?: bool, className?, align?: 'end' }]
 */
export function dataTable({ caption, captionHidden = false, columns, rows, empty = 'Nothing to show.', className = '', rowAttrs } = {}) {
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col', class: c.className || null }, c.label))));
  const body = h('tbody');
  if (!rows || rows.length === 0) {
    body.appendChild(h('tr', null, h('td', { colspan: String(columns.length), class: 'empty-cell' }, empty)));
  } else {
    for (const row of rows) {
      const tr = h('tr', rowAttrs ? rowAttrs(row) : null);
      for (const c of columns) {
        const content = c.render ? c.render(row) : displayValue(pick(row, c.key), { empty: '—' });
        tr.appendChild(h(c.rowHeader ? 'th' : 'td', { scope: c.rowHeader ? 'row' : null, class: [c.className, c.align === 'end' ? 'num' : null].filter(Boolean).join(' ') || null }, content));
      }
      body.appendChild(tr);
    }
  }
  const table = h('table', { class: `data-table ${className}`.trim() },
    caption ? h('caption', { class: captionHidden ? 'visually-hidden' : null }, caption) : null, thead, body);
  return h('div', { class: 'table-wrap', role: 'region', 'aria-label': typeof caption === 'string' ? caption : 'Table', tabindex: '0' }, table);
}

/** Pagination control. Calls onChange(page). */
export function pager({ page = 1, pageSize = 25, total = 0, onChange, label = 'Pagination' }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = (text, target, disabled, aria) => h('button', {
    type: 'button', class: 'btn btn-secondary btn-sm', disabled: disabled || null, 'aria-label': aria,
    onClick: () => onChange(target),
  }, text);
  return h('nav', { class: 'pager', 'aria-label': label },
    h('p', { class: 'pager-status' }, total === 0 ? 'No results' : `Showing ${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}`),
    h('div', { class: 'pager-buttons' },
      btn('« First', 1, page <= 1, 'First page'),
      btn('‹ Previous', page - 1, page <= 1, 'Previous page'),
      h('span', { class: 'pager-page' }, `Page ${page} of ${pages}`),
      btn('Next ›', page + 1, page >= pages, 'Next page'),
      btn('Last »', pages, page >= pages, 'Last page')));
}

/**
 * Labelled form control. Returns the wrapper; the control is wrapper.control.
 * type: text|number|date|email|url|password|textarea|select|checkbox|file|search
 */
export function formField({ label, name, type = 'text', value, required = false, hint, options, id, attrs = {}, rows = 3, dir, className = '' }) {
  const cid = id || uid(`f-${name || 'x'}`);
  const hintId = hint ? `${cid}-hint` : null;
  const errId = `${cid}-err`;
  const common = { id: cid, name, required: required || null, 'aria-describedby': [hintId, errId].filter(Boolean).join(' '), dir: dir || null, ...attrs };
  let control;
  if (type === 'textarea') control = h('textarea', { rows: String(rows), ...common, value: value ?? '' });
  else if (type === 'select') {
    control = h('select', common, (options || []).map((o) => {
      const opt = typeof o === 'object' ? o : { value: o, label: o };
      return h('option', { value: opt.value ?? '', disabled: opt.disabled || null }, opt.label ?? opt.value);
    }));
    if (value !== undefined && value !== null) control.value = String(value);
  } else if (type === 'checkbox') control = h('input', { type: 'checkbox', ...common, checked: !!value });
  else control = h('input', { type, ...common, value: value ?? '' });

  const labelEl = h('label', { for: cid, class: 'field-label' }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null, required ? h('span', { class: 'visually-hidden' }, ' (required)') : null);
  const wrap = type === 'checkbox'
    ? h('div', { class: `field field-check ${className}`.trim() }, control, labelEl, hint ? h('p', { id: hintId, class: 'hint' }, hint) : null, h('p', { id: errId, class: 'field-error', hidden: true }))
    : h('div', { class: `field ${className}`.trim() }, labelEl, hint ? h('p', { id: hintId, class: 'hint' }, hint) : null, control, h('p', { id: errId, class: 'field-error', hidden: true }));
  wrap.control = control;
  return wrap;
}

/** Mark a control invalid with a message (announced via the form's alert region). */
export function setFieldError(control, message) {
  const errEl = control && control.id ? document.getElementById(`${control.id}-err`) : null;
  if (!control) return;
  if (message) {
    control.setAttribute('aria-invalid', 'true');
    if (errEl) { errEl.textContent = message; errEl.hidden = false; }
  } else {
    control.removeAttribute('aria-invalid');
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
  }
}

export function clearFormErrors(form) {
  form.querySelectorAll('[aria-invalid="true"]').forEach((c) => setFieldError(c, null));
  const box = form.querySelector(':scope > .form-error');
  if (box) { box.hidden = true; box.textContent = ''; }
}

/** Show an error for a form: summary at the top (role=alert) and the offending field, if the server named one. */
export function showFormError(form, err, { focus = true } = {}) {
  let box = form.querySelector(':scope > .form-error');
  if (!box) {
    box = h('div', { class: 'form-error', role: 'alert', tabindex: '-1' });
    form.prepend(box);
  }
  const message = typeof err === 'string' ? err : (err && err.message) || 'Something went wrong.';
  box.textContent = message;
  box.hidden = false;
  const field = err && err.details && err.details.field;
  const control = field ? form.querySelector(`[name="${CSS.escape(field)}"]`) : null;
  if (control) {
    setFieldError(control, message);
    if (focus) control.focus();
  } else if (focus) box.focus();
}

/** Run an async action with a button in a busy state. Returns the action's result (or rethrows). */
export async function withBusy(button, fn, busyText) {
  const old = button ? button.textContent : null;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); if (busyText) button.textContent = busyText; }
  try { return await fn(); }
  finally {
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); if (busyText) button.textContent = old; }
  }
}

/** Definition list from [[label, value], …]; values go through displayValue unless they are Nodes. */
export function defList(pairs, className = '') {
  return h('dl', { class: `deflist ${className}`.trim() }, pairs.filter(Boolean).map(([k, v]) => [
    h('dt', null, k),
    h('dd', null, v instanceof Node ? v : displayValue(v)),
  ]));
}

/** Before/after comparison table for audit entries and change diffs. */
export function diffTable(before, after, { caption = 'Changes' } = {}) {
  const b = maybeJson(before);
  const a = maybeJson(after);
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(b) && !isObj(a)) {
    return h('div', { class: 'diff-raw' },
      h('p', null, h('strong', null, 'Before: '), h('code', { dir: 'ltr' }, redactPhones(b === null || b === undefined ? '—' : JSON.stringify(b)))),
      h('p', null, h('strong', null, 'After: '), h('code', { dir: 'ltr' }, redactPhones(a === null || a === undefined ? '—' : JSON.stringify(a)))));
  }
  const keys = [...new Set([...Object.keys(isObj(b) ? b : {}), ...Object.keys(isObj(a) ? a : {})])];
  const show = (v) => (v === undefined ? h('span', { class: 'np' }, '—') : v === null ? h('span', { class: 'np' }, 'null')
    : h('code', { dir: 'auto', class: 'json-inline' }, redactPhones(typeof v === 'string' ? v : JSON.stringify(v, null, 1))));
  return dataTable({
    caption, captionHidden: true, className: 'diff-table',
    columns: [
      { key: 'k', label: 'Field', rowHeader: true, render: (r) => r.k },
      { key: 'b', label: 'Before', render: (r) => show(r.b) },
      { key: 'a', label: 'After', render: (r) => show(r.a) },
    ],
    rows: keys.map((k) => ({ k, b: isObj(b) ? b[k] : undefined, a: isObj(a) ? a[k] : undefined })),
    empty: 'No field-level details recorded.',
  });
}

/** Debounce helper for search inputs. */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Parse the query part of the current hash: '#/plants?town=X' → { town: 'X' } */
export function hashQuery() {
  const i = location.hash.indexOf('?');
  return i === -1 ? {} : Object.fromEntries(new URLSearchParams(location.hash.slice(i + 1)));
}

/** Build a hash with query: hashWith('#/plants', { q: 'x', page: 2 }) → '#/plants?q=x&page=2' */
export function hashWith(base, query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '' && v !== false) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}
