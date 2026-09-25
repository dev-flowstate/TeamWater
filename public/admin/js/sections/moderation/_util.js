// Shared helpers for the moderation sections (reports, ratings, appeals, investigations, reporters).
// Security: nothing here ever assigns API data to innerHTML. Every node is built with
// createElement + textContent, so reporter-supplied text can never become markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

let uidSeq = 0;
/** Unique DOM id for label/aria wiring. */
export function uid(prefix = 'mod') {
  uidSeq += 1;
  return `${prefix}-${uidSeq}`;
}

/**
 * Tiny DOM builder. Strings/numbers become text nodes (never parsed as HTML).
 *   el('a', { href: '#/x', class: 'mod-link' }, 'Open')
 *   el('button', { type: 'button', on: { click: fn } }, icon('check'), 'Save')
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'on') {
      for (const [evt, fn] of Object.entries(value)) node.addEventListener(evt, fn);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'class') {
      node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'value') {
      node.value = value;
    } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'required' || key === 'hidden' || key === 'open') {
      node[key] = Boolean(value);
      if (key !== 'checked' && key !== 'selected') node.toggleAttribute(key, Boolean(value));
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** replaceChildren that skips null/false (the DOM would otherwise print "null"). */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

/** Element for user-supplied text: always dir="auto" so Urdu and English both render correctly. */
export function userText(tag, text, attrs = {}) {
  return el(tag, { dir: 'auto', ...attrs }, text ?? '');
}

// ── Icons (inline SVG built via DOM APIs — no markup strings) ──
const ICONS = {
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7.5h.01' }]],
  low: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.7 2.7L16.5 9.5' }]],
  medium: [['path', { d: 'M12 3.5L21.5 20h-19z' }], ['path', { d: 'M12 10v4.5M12 17.2h.01' }]],
  high: [['path', { d: 'M8 3h8l5 5v8l-5 5H8l-5-5V8z' }], ['path', { d: 'M12 7.5v6M12 16.8h.01' }]],
  flag: [['path', { d: 'M5 21V4' }], ['path', { d: 'M5 4h12l-2.5 4.5L17 13H5' }]],
  serious: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v6.5M12 16.6h.01' }]],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
  eye: [['path', { d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [['path', { d: 'M3 3l18 18' }], ['path', { d: 'M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 4.4-1' }]],
  phone: [['path', { d: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
  camera: [['path', { d: 'M4 8h3l2-3h6l2 3h3v11H4z' }], ['circle', { cx: 12, cy: 13, r: 3.5 }]],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]],
  pin: [['path', { d: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z' }], ['circle', { cx: 12, cy: 9.5, r: 2.5 }]],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4' }]],
  back: [['path', { d: 'M15 5l-7 7 7 7' }]],
  star: [['path', { d: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z' }]],
  file: [['path', { d: 'M6 3h8l4 4v14H6z' }], ['path', { d: 'M14 3v4h4' }]],
  link: [['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1' }], ['path', { d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }]],
};

export function icon(name, { label } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'mod-icon');
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of ICONS[name] || ICONS.info) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    svg.append(child);
  }
  return svg;
}

// ── Vocabulary ──
export const CATEGORY_LABELS = {
  closed_during_hours: 'Closed during opening hours',
  no_water: 'No water available',
  broken_equipment: 'Broken equipment',
  color_odor_taste: 'Colour, odour or taste',
  dirty_surroundings: 'Dirty surroundings',
  incorrect_details: 'Incorrect plant details',
  unexpected_charges: 'Unexpected charges',
  other: 'Other',
};

export const STATUS_LABELS = {
  pending: 'Pending',
  under_review: 'Under review',
  needs_clarification: 'Needs clarification',
  confirmed: 'Confirmed',
  resolved: 'Resolved',
  rejected: 'Rejected',
};

export const OPEN_STATUSES = ['pending', 'under_review', 'needs_clarification'];

/** Moderator decision actions (POST /reports/:id/decision). */
export const DECISIONS = {
  start_review: { label: 'Start review', to: 'under_review', hint: 'Mark that someone is looking into this report.' },
  request_clarification: { label: 'Request clarification', to: 'needs_clarification', hint: 'Ask the reporter for more detail. Put the question in the public note.' },
  confirm: { label: 'Confirm report', to: 'confirmed', hint: 'The problem described has been confirmed. This does not change the plant’s official status.' },
  resolve: { label: 'Mark resolved', to: 'resolved', hint: 'The confirmed problem has been fixed or no longer applies.' },
  reject: { label: 'Reject report', to: 'rejected', hint: 'The report could not be substantiated or breaks the reporting rules.' },
};

/** Actions offered from each status when the API does not send `allowedActions`. */
export const ALLOWED_DECISIONS = {
  pending: ['start_review', 'request_clarification', 'confirm', 'reject'],
  under_review: ['request_clarification', 'confirm', 'reject'],
  needs_clarification: ['start_review', 'confirm', 'reject'],
  confirmed: ['resolve'],
  resolved: [],
  rejected: [],
};

export const EVENT_LABELS = {
  submitted: 'Report submitted',
  auto_flagged: 'Automatically flagged for review',
  status_change: 'Status changed',
  note: 'Internal note',
  clarification_requested: 'Clarification requested',
  reporter_reply: 'Reporter replied',
  appeal: 'Appeal received',
  photo_moderated: 'Photo moderated',
  contact_revealed: 'Phone number revealed',
  investigation_opened: 'Investigation opened',
  redacted: 'Report redacted',
};

export const RISK_NOTE =
  'Risk indicators help prioritise review. They do not prove a report is false. New reporters, reporters without photos and reporters who did not share location can all be genuine.';

export const OFFICIAL_STATUS_NOTE =
  'Confirming a report does not change the plant’s official status. To change status, record an administrator assessment on the plant page.';

export const labelFor = (map, key) => map[key] || humanize(key);

export function humanize(key) {
  if (key === null || key === undefined || key === '') return 'Not provided';
  const s = String(key).replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Data access helpers (tolerate camelCase / snake_case while the API settles) ──
export function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/** Normalise the `plant` field of a report/rating/investigation into { code, name, town, areaRaw }. */
export function plantOf(item) {
  const p = item && item.plant;
  if (p && typeof p === 'object') {
    return {
      code: pick(p, 'code', 'plantCode', 'plant_code') ?? null,
      name: pick(p, 'name') ?? null,
      town: pick(p, 'town') ?? null,
      areaRaw: pick(p, 'areaRaw', 'area_raw', 'areaName') ?? null,
      isDemo: Boolean(pick(p, 'isDemo', 'is_demo')),
    };
  }
  return {
    code: (typeof p === 'string' ? p : pick(item, 'plantCode', 'plant_code')) ?? null,
    name: pick(item, 'plantName') ?? null,
    town: pick(item, 'plantTown', 'town') ?? null,
    areaRaw: pick(item, 'plantAreaRaw', 'areaRaw') ?? null,
    isDemo: false,
  };
}

export const listOf = (res) => (Array.isArray(res) ? res : (res && (res.items || res.results || res.data)) || []);
export const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

// ── Formatting ──
export function formatAge(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Unknown';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} d`;
  return `${Math.floor(days / 30)} mo`;
}

export function formatDistance(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return null;
  if (n < 1000) return `${Math.round(n)} m`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} km`;
}

/** observedAt is 'YYYY-MM-DDTHH:MM' in Pakistan local time (no zone) — show as recorded, not re-zoned. */
export function formatLocalObserved(s) {
  if (!s) return 'Not provided';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(s));
  return m ? `${m[1]} ${m[2]} (Pakistan time, approximate)` : String(s);
}

export function safeDate(ctx, iso) {
  if (!iso) return 'Not provided';
  try {
    return ctx.formatDate ? ctx.formatDate(iso) : new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

/** <time> element with a readable label and the machine value. */
export function timeEl(ctx, iso, { age = false } = {}) {
  if (!iso) return el('span', { class: 'mod-muted' }, 'Not provided');
  return el('time', { datetime: iso, title: safeDate(ctx, iso) }, age ? formatAge(iso) : safeDate(ctx, iso));
}

// ── Badges (always icon + text; colour is never the only signal) ──
const RISK = {
  low: { icon: 'low', text: 'Low risk' },
  medium: { icon: 'medium', text: 'Medium risk' },
  high: { icon: 'high', text: 'High risk' },
};

export function riskBadge(level) {
  const r = RISK[level];
  if (!r) return el('span', { class: 'mod-badge mod-badge--neutral' }, icon('info'), 'Not scored');
  return el('span', { class: `mod-badge mod-risk mod-risk--${level}` }, icon(r.icon), r.text);
}

export function severityBadge(sev) {
  if (sev === 'serious') return el('span', { class: 'mod-badge mod-sev mod-sev--serious' }, icon('serious'), 'Serious');
  return el('span', { class: 'mod-badge mod-sev mod-sev--normal' }, 'Normal');
}

export function statusBadge(status) {
  return el('span', { class: `mod-badge mod-status mod-status--${status || 'unknown'}` }, labelFor(STATUS_LABELS, status));
}

export function flaggedBadge() {
  return el('span', { class: 'mod-badge mod-flag' }, icon('flag'), 'Flagged for review');
}

export function yesNo(value, { yes = 'Yes', no = 'No' } = {}) {
  return value
    ? el('span', { class: 'mod-yn mod-yn--yes' }, icon('check'), yes)
    : el('span', { class: 'mod-yn mod-yn--no' }, icon('x'), no);
}

export function demoBadge() {
  return el('span', { class: 'mod-badge mod-demo' }, 'DEMO — not a real plant');
}

// ── Layout pieces ──
export function pageHeader(title, subtitle, ...extra) {
  return el('header', { class: 'mod-head' },
    el('div', { class: 'mod-head__text' },
      el('h1', { class: 'mod-title', tabindex: '-1' }, title),
      subtitle ? el('p', { class: 'mod-subtitle' }, subtitle) : null),
    extra.length ? el('div', { class: 'mod-head__extra' }, extra) : null);
}

export function notice(kind, ...children) {
  const ic = kind === 'warning' ? 'medium' : kind === 'danger' ? 'high' : 'info';
  return el('div', { class: `mod-notice mod-notice--${kind}` }, icon(ic), el('div', { class: 'mod-notice__body' }, children));
}

export function panel(title, ...children) {
  const id = uid('panel');
  return el('section', { class: 'mod-panel', 'aria-labelledby': id },
    el('h2', { class: 'mod-panel__title', id }, title),
    children);
}

export function loadingState(text = 'Loading…') {
  return el('p', { class: 'mod-loading', role: 'status' }, el('span', { class: 'mod-spinner', 'aria-hidden': 'true' }), text);
}

export function emptyState(text) {
  return el('p', { class: 'mod-empty' }, text);
}

export function errorText(err) {
  if (!err) return 'Something went wrong.';
  if (err.status === 403) return err.message || 'Your role does not allow this action.';
  if (err.status === 401) return 'Your session has ended. Please sign in again.';
  if (err.status === 404) return err.message || 'Not found.';
  const field = err.details && err.details.field ? ` (field: ${err.details.field})` : '';
  return `${err.message || 'Request failed.'}${field}`;
}

/** Announced error block (role=alert) with an optional retry button. */
export function errorState(err, retry) {
  return el('div', { class: 'mod-error', role: 'alert' },
    el('p', {}, el('strong', {}, 'Could not load. '), errorText(err)),
    retry ? el('button', { type: 'button', class: 'mod-btn mod-btn--ghost', on: { click: retry } }, 'Try again') : null);
}

/** Label + control + optional hint + error slot, wired with for/aria-describedby. */
export function field(labelText, control, { hint, required = false, className } = {}) {
  const id = control.id || uid('f');
  control.id = id;
  const hintId = hint ? `${id}-hint` : null;
  const errId = `${id}-err`;
  control.setAttribute('aria-describedby', [hintId, errId].filter(Boolean).join(' '));
  if (required) {
    control.required = true;
    control.setAttribute('aria-required', 'true');
  }
  const errNode = el('p', { class: 'mod-field__error', id: errId, role: 'alert' });
  const wrap = el('div', { class: ['mod-field', className] },
    el('label', { for: id, class: 'mod-field__label' }, labelText, required ? el('span', { class: 'mod-req' }, ' (required)') : null),
    control,
    hint ? el('p', { class: 'mod-field__hint', id: hintId }, hint) : null,
    errNode);
  wrap.setError = (msg) => {
    errNode.textContent = msg || '';
    if (msg) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  };
  return wrap;
}

export function selectEl(options, value, attrs = {}) {
  return el('select', { class: 'mod-input', ...attrs },
    options.map(([v, text]) => el('option', { value: v, selected: String(v) === String(value ?? '') }, text)));
}

export function setBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.dataset.label || button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyText) button.lastChild.textContent = busyText;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (busyText && button.dataset.label) button.lastChild.textContent = button.dataset.label;
  }
}

/** Strip empty values so the API never receives `status=` etc. */
export function cleanQuery(q) {
  const out = {};
  for (const [k, v] of Object.entries(q || {})) if (v !== undefined && v !== null && v !== '' && v !== false) out[k] = v;
  return out;
}

/** Star string with a text equivalent: '★★★☆☆' + '3 of 5'. */
export function stars(n) {
  const v = Math.max(0, Math.min(5, Number(n) || 0));
  return el('span', { class: 'mod-stars' },
    el('span', { 'aria-hidden': 'true', class: 'mod-stars__glyphs' }, '★'.repeat(v) + '☆'.repeat(5 - v)),
    el('span', { class: 'mod-stars__text' }, `${v} of 5`));
}

/** Risk reasons list: [{ code, detail, weight }]. */
export function riskReasonsList(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (!list.length) return emptyState('No risk indicators were recorded.');
  return el('ul', { class: 'mod-reasons' },
    list.map((r) => el('li', { class: 'mod-reasons__item' },
      el('span', { class: 'mod-reasons__code' }, humanize(r.code)),
      r.detail ? userText('span', r.detail, { class: 'mod-reasons__detail' }) : null,
      r.weight !== undefined && r.weight !== null
        ? el('span', { class: 'mod-reasons__weight', title: 'Contribution to the risk score' }, `weight ${r.weight > 0 ? '+' : ''}${r.weight}`)
        : null)));
}

/** Plant cell: code (link to the plant page when allowed) + town/area. */
export function plantCell(ctx, plant, { link = true } = {}) {
  const code = plant.code || 'Unknown plant';
  const canLink = link && plant.code && (!ctx.can || ctx.can('plants:read'));
  return el('span', { class: 'mod-plant' },
    canLink ? el('a', { href: `#/plants/${encodeURIComponent(plant.code)}`, class: 'mod-plant__code' }, code) : el('span', { class: 'mod-plant__code' }, code),
    plant.name ? userText('span', plant.name, { class: 'mod-plant__name' }) : null,
    plant.town || plant.areaRaw ? el('span', { class: 'mod-plant__place' }, [plant.areaRaw, plant.town].filter(Boolean).join(' · ')) : null,
    plant.isDemo ? demoBadge() : null);
}

/** Visible pager: « Previous | Page x of y | Next ». */
export function pager({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil((Number(total) || 0) / (pageSize || 1)));
  if (pages <= 1) return null;
  return el('nav', { class: 'mod-pager', 'aria-label': 'Pagination' },
    el('button', { type: 'button', class: 'mod-btn mod-btn--ghost', disabled: page <= 1, on: { click: () => onChange(page - 1) } }, 'Previous'),
    el('span', { class: 'mod-pager__label' }, `Page ${page} of ${pages}`),
    el('button', { type: 'button', class: 'mod-btn mod-btn--ghost', disabled: page >= pages, on: { click: () => onChange(page + 1) } }, 'Next'));
}

export function visuallyHidden(text) {
  return el('span', { class: 'mod-sr' }, text);
}
