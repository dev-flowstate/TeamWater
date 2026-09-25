// Report UI — shared helpers for /report.html and /status.html, plus the
// "Corrections, appeals and deletion requests" form (POST /api/appeals) on /status.html#appeal.
// The Report UI owns three modules (report-form, status, appeal); the small shared kit lives here so
// neither page pulls in the other page's code. No framework, no Public UI modules: fetch + /js/i18n.js only.
import { initI18n, t, setLang, getLang, onLangChange, formatNumber } from '/js/i18n.js';

// ─────────────────────────── DOM helpers ───────────────────────────
export const $ = (sel, root = document) => root.querySelector(sel);

/** h('p', { class: 'x', text: 'hi', dir: 'ltr' }, child…) — never uses innerHTML for data. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Static, trusted SVG markup (icons only). */
export function svg(markup, cls = 'twr-ico') {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${markup}</svg>`;
  return wrap.firstChild;
}

// ─────────────────────────── Phone numbers ───────────────────────────
/** Mirror of server/lib/crypto.js normalizePhone: Pakistani mobile or landline → '+92…', else null. */
export function normalizePhone(input) {
  if (input === undefined || input === null) return null;
  let d = String(input).replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith('0')) d = '92' + d.slice(1);
  if (!d.startsWith('92')) return null;
  const national = d.slice(2);
  if (/^3\d{9}$/.test(national) || /^[1-9]\d{8,9}$/.test(national)) return '+92' + national;
  return null;
}

/** '+923001234567' → '0300-1234567' for display back to the person who typed it. */
export function displayPhone(e164) {
  const n = String(e164 || '').replace(/^\+92/, '0');
  return /^03\d{9}$/.test(n) ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
}

// ─────────────────────────── API ───────────────────────────
function retryAfterOf(data, headers) {
  const v = data?.error?.details?.retryAfterSec ?? data?.retryAfterSec ?? data?.error?.retryAfterSec ?? headers?.('Retry-After');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/** Normalises every outcome to { ok, status, data, error: {code,message,details}|null, retryAfterSec, network }. */
export function toResult(status, text, header) {
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const ok = status >= 200 && status < 300;
  const error = ok ? null : (data && data.error) || { code: `http_${status}`, message: '' };
  return { ok, status, data, error, retryAfterSec: ok ? null : retryAfterOf(data, header), network: false };
}

export async function api(path, { method = 'GET', json } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: json ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: json ? JSON.stringify(json) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, status: 0, data: null, error: { code: 'network', message: '' }, retryAfterSec: null, network: true };
  }
  const text = await res.text().catch(() => '');
  return toResult(res.status, text, (n) => res.headers.get(n));
}

const DEFAULT_CONFIG = {
  sms: { enabled: false },
  demoMode: false,
  reportCategories: ['closed_during_hours', 'no_water', 'broken_equipment', 'color_odor_taste', 'dirty_surroundings', 'incorrect_details', 'unexpected_charges', 'other'],
  limits: { maxPhotos: 3, maxPhotoMb: 5, descriptionMin: 10, descriptionMax: 2000 },
};

async function loadConfig() {
  const r = await api('/api/config');
  const c = r.ok && r.data ? r.data : {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    sms: { enabled: Boolean(c.sms && c.sms.enabled) },
    reportCategories: Array.isArray(c.reportCategories) && c.reportCategories.length ? c.reportCategories : DEFAULT_CONFIG.reportCategories,
    limits: { ...DEFAULT_CONFIG.limits, ...(c.limits || {}) },
    loaded: r.ok,
  };
}

// ─────────────────────────── Page boot: i18n + shared shell (with fallback) ───────────────────────────
function fallbackShell() {
  const header = document.getElementById('tw-header');
  const footer = document.getElementById('tw-footer');
  if (header && !header.childElementCount) {
    const langBtn = h('button', { type: 'button', class: 'twr-lang', id: 'twr-lang' });
    const paint = () => {
      langBtn.textContent = t('report.lang.switch');
      langBtn.setAttribute('lang', getLang() === 'ur' ? 'en' : 'ur');
      langBtn.setAttribute('aria-label', t('report.lang.switchLabel'));
    };
    langBtn.addEventListener('click', () => setLang(getLang() === 'ur' ? 'en' : 'ur'));
    paint();
    onLangChange(paint);
    header.classList.add('twr-fh');
    header.append(
      h('a', { class: 'twr-skip', href: '#main', 'data-i18n': 'report.skip', text: t('report.skip') }),
      h('div', { class: 'twr-fh-inner' },
        h('a', { class: 'twr-fh-logo', href: '/' },
          svg('<path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z"/><path d="M9 14.5a3 3 0 0 0 3 3"/>', 'twr-fh-drop'),
          h('span', { lang: 'en', dir: 'ltr', text: 'Team Water' })),
        h('nav', { class: 'twr-fh-nav', 'aria-label': 'Team Water' },
          h('a', { href: '/', 'data-i18n': 'report.nav.home', text: t('report.nav.home') }),
          h('a', { href: '/status.html', 'data-i18n': 'report.nav.status', text: t('report.nav.status') })),
        langBtn));
  }
  if (footer && !footer.childElementCount) {
    footer.classList.add('twr-ff');
    footer.append(h('div', { class: 'twr-ff-inner' },
      h('p', { 'data-i18n': 'report.footer.tagline', text: t('report.footer.tagline') }),
      h('nav', { class: 'twr-ff-nav', 'aria-label': 'Footer' },
        h('a', { href: '/about.html', 'data-i18n': 'report.footer.about', text: t('report.footer.about') }),
        h('a', { href: '/privacy.html', 'data-i18n': 'report.footer.privacy', text: t('report.footer.privacy') }),
        h('a', { href: '/status.html#appeal', 'data-i18n': 'report.footer.appeal', text: t('report.footer.appeal') }))));
  }
}

async function mountShell(active) {
  try {
    const mod = await import('/js/shell.js');
    if (typeof mod.renderShell !== 'function') throw new Error('renderShell missing');
    await mod.renderShell({ active });
    const header = document.getElementById('tw-header');
    if (!header || !header.childElementCount) throw new Error('shell rendered nothing');
    return true;
  } catch {
    fallbackShell();
    return false;
  }
}

/** The shared shell shows the site-wide demo banner; the fallback header needs its own. */
function demoBanner(cfg, shellOk) {
  if (!cfg.demoMode || shellOk || document.querySelector('.tw-demo-banner, [data-demo-banner]')) return;
  const banner = h('div', { class: 'twr-demo', role: 'note', 'data-demo-banner': '' },
    svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'),
    h('span', { 'data-i18n': 'report.demoBanner', text: t('report.demoBanner') }));
  document.getElementById('tw-header').after(banner);
}

/** Loads i18n (report namespace), config and the shared header/footer. Resolves with the config. */
export async function bootPage({ active, titleKey }) {
  const cfgP = loadConfig();
  await initI18n(['report']);
  const setTitle = () => { document.title = t(titleKey); };
  setTitle();
  onLangChange(setTitle);
  const [cfg, shellOk] = await Promise.all([cfgP, mountShell(active)]);
  demoBanner(cfg, shellOk);
  return cfg;
}

// ─────────────────────────── Errors: inline + summary ───────────────────────────
/** Shows/clears an inline error; wires aria-invalid + aria-describedby on each control. */
export function setFieldError(errorEl, controls, message) {
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
  for (const c of [].concat(controls || [])) {
    if (!c) continue;
    const ids = (c.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== errorEl.id);
    if (message) {
      c.setAttribute('aria-invalid', 'true');
      ids.unshift(errorEl.id);
    } else {
      c.removeAttribute('aria-invalid');
    }
    if (ids.length) c.setAttribute('aria-describedby', ids.join(' '));
    else c.removeAttribute('aria-describedby');
  }
  const wrap = errorEl.closest('.twr-field, .twr-card, .twr-check-row');
  if (wrap) wrap.classList.toggle('is-invalid', Boolean(message));
}

/** items: [{ target: HTMLElement to focus, text }] — renders links and moves focus to the summary. */
export function showSummary(box, items, { focus = true } = {}) {
  const list = box.querySelector('ul');
  list.replaceChildren(...items.map((it) => {
    const a = h('a', { href: it.target && it.target.id ? `#${it.target.id}` : '#', text: it.text });
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (!it.target) return;
      it.target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      it.target.focus({ preventScroll: true });
    });
    return h('li', {}, a);
  }));
  box.hidden = items.length === 0;
  if (items.length && focus) {
    box.focus({ preventScroll: true });
    box.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

export const prefersReducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─────────────────────────── Small utilities ───────────────────────────
export function formatDuration(sec) {
  const s = Math.max(1, Math.ceil(sec));
  if (s < 60) return t('report.time.sec', { n: s });
  if (s < 3600) return t('report.time.min', { n: Math.ceil(s / 60) });
  const hrs = Math.floor(s / 3600);
  return t('report.time.hr', { h: hrs, m: Math.ceil((s % 3600) / 60) });
}

/** Countdown that calls tick(remainingSec) every second and done() at zero. Returns a cancel function. */
export function countdown(sec, tick, done) {
  const end = Date.now() + sec * 1000;
  let timer = null;
  const step = () => {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0) { clearInterval(timer); done && done(); return; }
    tick(left);
  };
  step();
  timer = setInterval(step, 1000);
  return () => clearInterval(timer);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = h('textarea', { class: 'twr-sr', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const STATUSES = ['pending', 'under_review', 'needs_clarification', 'confirmed', 'resolved', 'rejected'];
const STATUS_ICONS = {
  pending: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  under_review: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  needs_clarification: '<path d="M4 5h16v11H9l-5 4z"/><path d="M10 9a2 2 0 1 1 2.5 1.9c-.4.2-.5.5-.5 1.1M12 14h.01"/>',
  confirmed: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  resolved: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  rejected: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
};
export function statusBadge(status) {
  const known = STATUSES.includes(status);
  return h('span', { class: `twr-badge twr-badge--${known ? status : 'pending'}` },
    svg(STATUS_ICONS[known ? status : 'pending']),
    h('span', { text: known ? t(`report.status.${status}`) : String(status || '') }));
}

export const REF_RE = /^TW-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
/** Tidies what people type or paste: 'tw 8k2m 4qxz' → 'TW-8K2M-4QXZ'. */
export function tidyRef(value, prefix = 'TW') {
  const raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const body = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (body.length === 8) return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
  return String(value || '').trim().toUpperCase();
}

export { t, getLang, onLangChange, formatNumber };

// ─────────────────────────── Appeal / correction / deletion form ───────────────────────────
const KINDS = ['correction', 'appeal', 'deletion_request'];
const KIND_ICONS = {
  correction: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  appeal: '<path d="M12 4v16M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0zM19 8l-2.5 6a3 3 0 0 0 5 0zM8 20h8"/>',
  deletion_request: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
};
const AP_MIN = 10;
const AP_MAX = 2000;
const PLANT_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/i;

/** Mounts the appeal form into #appeal. `prefill({ kind, reference })` lets the status page link into it. */
export function initAppeal() {
  const root = document.getElementById('appeal');
  if (!root) return { prefill() {} };
  const form = $('#appeal-form', root);
  const kindsBox = $('#ap-kinds', root);
  const f = {
    ref: $('#ap-ref', root), plant: $('#ap-plant', root), plantField: $('#ap-plant-field', root),
    phone: $('#ap-phone', root), message: $('#ap-message', root), msgHint: $('#ap-message-hint', root),
    submit: $('#ap-submit', root), submitLabel: $('#ap-submit-label', root), status: $('#ap-status', root),
    summary: $('#ap-summary', root), done: $('#ap-done', root), doneRef: $('#ap-done-ref', root),
  };
  const err = {
    kind: $('#ap-kind-error', root), ref: $('#ap-ref-error', root), plant: $('#ap-plant-error', root),
    phone: $('#ap-phone-error', root), message: $('#ap-message-error', root),
  };
  let errors = [];
  let sending = false;
  let cancelCooldown = null;

  kindsBox.replaceChildren(...KINDS.map((k) => h('label', { class: 'twr-choice twr-choice--wide' },
    h('input', { type: 'radio', name: 'kind', value: k, class: 'twr-sr', id: `ap-kind-${k}` }),
    h('span', { class: 'twr-choice-box' },
      h('span', { class: 'twr-choice-icon' }, svg(KIND_ICONS[k])),
      h('span', { class: 'twr-choice-text' },
        h('span', { class: 'twr-choice-title', 'data-i18n': `report.ap.kind.${k}`, text: t(`report.ap.kind.${k}`) }),
        h('span', { class: 'twr-choice-hint', 'data-i18n': `report.ap.kind.${k}.hint`, text: t(`report.ap.kind.${k}.hint`) }))))));
  const kindInputs = [...kindsBox.querySelectorAll('input')];
  const kind = () => (kindInputs.find((i) => i.checked) || {}).value || null;

  const syncKind = () => {
    const k = kind();
    f.plantField.hidden = k !== 'correction';
    f.msgHint.dataset.i18n = `report.ap.message.hint.${k || 'correction'}`;
    f.msgHint.textContent = t(f.msgHint.dataset.i18n);
    if (k !== 'correction') setFieldError(err.plant, f.plant, '');
  };
  kindInputs.forEach((i) => i.addEventListener('change', () => { syncKind(); if (errors.length) validate(false); }));
  syncKind();

  f.ref.addEventListener('blur', () => { if (f.ref.value.trim()) f.ref.value = tidyRef(f.ref.value); });

  function validate(focusSummary = true) {
    errors = [];
    const add = (key, target, errorEl, controls, vars) => errors.push({ key, target, errorEl, controls, vars });
    const k = kind();
    if (!k) add('report.ap.err.kind', kindInputs[0], err.kind, kindInputs);
    const ref = f.ref.value.trim() ? tidyRef(f.ref.value) : '';
    if (ref && !REF_RE.test(ref)) add('report.ap.err.ref', f.ref, err.ref, f.ref);
    if (k === 'correction' && !PLANT_RE.test(f.plant.value.trim())) add('report.ap.err.plant', f.plant, err.plant, f.plant);
    if (!f.phone.value.trim()) add('report.err.phone.required', f.phone, err.phone, f.phone);
    else if (!normalizePhone(f.phone.value)) add('report.err.phone.invalid', f.phone, err.phone, f.phone);
    const len = f.message.value.trim().length;
    if (len < AP_MIN) add('report.ap.err.message.short', f.message, err.message, f.message, { min: AP_MIN });
    else if (len > AP_MAX) add('report.ap.err.message.long', f.message, err.message, f.message, { max: AP_MAX });
    paint(focusSummary);
    return errors.length === 0;
  }

  function paint(focusSummary = false, extra = []) {
    for (const [name, el] of Object.entries(err)) {
      const e = errors.find((x) => x.errorEl === el);
      const controls = { kind: kindInputs, ref: f.ref, plant: f.plant, phone: f.phone, message: f.message }[name];
      setFieldError(el, controls, e ? t(e.key, e.vars) : '');
    }
    const items = errors.map((e) => ({ target: e.target, text: t(e.key, e.vars) }))
      .concat(extra.map((x) => ({ target: x.target || f.submit, text: x.text })));
    showSummary(f.summary, items, { focus: focusSummary });
  }

  let generalMsg = null; // { key, vars } for re-render on language change
  function showGeneral(key, vars, target) {
    generalMsg = { key, vars, target };
    paint(true, [{ text: t(key, vars), target }]);
  }

  form.addEventListener('input', () => { if (errors.length) validate(false); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    generalMsg = null;
    if (!validate(true)) return;
    const k = kind();
    const payload = {
      kind: k,
      phone: f.phone.value.trim(),
      message: f.message.value.trim(),
      ...(f.ref.value.trim() ? { reference: tidyRef(f.ref.value) } : {}),
      ...(k === 'correction' && f.plant.value.trim() ? { plantCode: f.plant.value.trim().toUpperCase() } : {}),
    };
    sending = true;
    f.submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    f.submitLabel.textContent = t('report.ap.sending');
    f.status.textContent = t('report.ap.sending');
    const r = await api('/api/appeals', { method: 'POST', json: payload });
    sending = false;
    form.removeAttribute('aria-busy');
    f.submit.disabled = false;
    f.submitLabel.textContent = t('report.ap.send');
    f.status.textContent = '';
    if (r.ok && r.data && r.data.reference) {
      f.doneRef.textContent = r.data.reference;
      form.hidden = true;
      f.done.hidden = false;
      f.done.focus();
      return;
    }
    handleError(r);
  });

  function handleError(r) {
    if (r.network) return showGeneral('report.err.network');
    if (r.status === 429) {
      const sec = r.retryAfterSec || 60;
      f.submit.disabled = true;
      if (cancelCooldown) cancelCooldown();
      cancelCooldown = countdown(sec, () => {}, () => { f.submit.disabled = false; });
      return showGeneral('report.ap.err.cooldown', { time: formatDuration(sec) });
    }
    const field = r.error && r.error.details && r.error.details.field;
    const map = {
      kind: ['report.ap.err.kind', kindInputs[0], err.kind, kindInputs],
      reference: [r.error.code === 'unknown_report' ? 'report.ap.err.notFound' : 'report.ap.err.ref', f.ref, err.ref, f.ref],
      plantCode: [r.error.code === 'unknown_plant' ? 'report.ap.err.notFound' : 'report.ap.err.plant', f.plant, err.plant, f.plant],
      phone: ['report.err.phone.invalid', f.phone, err.phone, f.phone],
      message: [f.message.value.trim().length < AP_MIN ? 'report.ap.err.message.short' : 'report.ap.err.message.long', f.message, err.message, f.message, { min: AP_MIN, max: AP_MAX }],
    };
    if (field && map[field]) {
      if (field === 'plantCode' && f.plantField.hidden) return showGeneral('report.ap.err.notFound');
      const [key, target, errorEl, controls, vars] = map[field];
      errors = [{ key, target, errorEl, controls, vars }];
      return paint(true);
    }
    if (r.status === 404) return showGeneral('report.ap.err.notFound');
    return showGeneral('report.err.generic');
  }

  $('#ap-copy', root).addEventListener('click', async () => {
    const ok = await copyText(f.doneRef.textContent);
    $('#ap-copy-status', root).textContent = t(ok ? 'report.done.copied' : 'report.done.copyFailed');
  });
  $('#ap-another', root).addEventListener('click', () => {
    form.reset();
    errors = [];
    paint(false);
    syncKind();
    f.done.hidden = true;
    form.hidden = false;
    kindInputs[0].focus();
  });

  onLangChange(() => {
    syncKind();
    if (generalMsg) paint(false, [{ text: t(generalMsg.key, generalMsg.vars), target: generalMsg.target }]);
    else if (errors.length) paint(false);
  });

  return {
    prefill({ kind: k, reference }) {
      if (k) { const input = kindInputs.find((i) => i.value === k); if (input) input.checked = true; }
      if (reference) f.ref.value = reference;
      syncKind();
    },
    focus() {
      const heading = $('#appeal-title', root);
      root.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      heading.focus({ preventScroll: true });
    },
  };
}
