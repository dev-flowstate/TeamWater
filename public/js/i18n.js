// Shared i18n for all public pages (ES module).
//   import { initI18n, t, getLang, setLang, onLangChange, formatNumber, formatDate } from '/js/i18n.js';
//   await initI18n(['common', 'search']);     // loads /i18n/<ns>.<lang>.json for en + current lang
//   t('search.button')  t('results.position', { n: 2, total: 8 })   // {n} placeholders
// Keys are "<namespace>.<key>" where the JSON file for a namespace is a flat object of key → string.
// Missing Urdu strings fall back to English; missing English returns the key (visible in QA).
const SUPPORTED = ['en', 'ur'];
const RTL = new Set(['ur']);
const STORAGE_KEY = 'tw.lang';
const strings = { en: {}, ur: {} };
const loaded = new Set();
const listeners = new Set();
let lang = 'en';

function readStoredLang() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function storeLang(v) {
  try { localStorage.setItem(STORAGE_KEY, v); } catch { /* storage unavailable */ }
}

function detectLang() {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (SUPPORTED.includes(fromUrl)) return fromUrl;
  const stored = readStoredLang();
  if (SUPPORTED.includes(stored)) return stored;
  return (navigator.language || '').toLowerCase().startsWith('ur') ? 'ur' : 'en';
}

async function loadNamespace(ns, l) {
  const id = `${ns}.${l}`;
  if (loaded.has(id)) return;
  loaded.add(id);
  try {
    const res = await fetch(`/i18n/${ns}.${l}.json`, { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    for (const [k, v] of Object.entries(data)) strings[l][`${ns}.${k}`] = v;
  } catch { /* offline: fall back to English/keys */ }
}

function applyDocumentLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
}

let namespaces = [];
export async function initI18n(ns = ['common']) {
  namespaces = Array.from(new Set(['common', ...ns]));
  lang = detectLang();
  applyDocumentLang();
  await Promise.all(namespaces.flatMap((n) => [loadNamespace(n, 'en'), lang !== 'en' ? loadNamespace(n, lang) : null]));
  translateDom();
  return lang;
}

export function t(key, vars) {
  let s = strings[lang][key] ?? strings.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : formatValue(vars[k])));
  return s;
}

function formatValue(v) {
  return typeof v === 'number' ? formatNumber(v) : String(v);
}

export const getLang = () => lang;
export const isRtl = () => RTL.has(lang);

export async function setLang(next) {
  if (!SUPPORTED.includes(next) || next === lang) return;
  lang = next;
  storeLang(next);
  await Promise.all(namespaces.map((n) => loadNamespace(n, next)));
  applyDocumentLang();
  translateDom();
  for (const fn of listeners) fn(lang);
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Translate static markup: <span data-i18n="common.appName"></span>, data-i18n-attr="placeholder:search.placeholder;aria-label:search.label" */
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}

// Numbers: Western digits in both languages for clarity of plant IDs, phone numbers and distances.
export function formatNumber(n, opts = {}) {
  return new Intl.NumberFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', opts).format(n);
}

export function formatDate(iso, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', { timeZone: iso.length === 10 ? 'UTC' : 'Asia/Karachi', ...opts }).format(d);
}
