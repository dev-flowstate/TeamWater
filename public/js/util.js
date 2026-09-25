// Small DOM + formatting helpers shared by the public pages (no dependencies except i18n).
//   import { h, icon, debounce, formatDistance } from '/js/util.js';
import { t, formatNumber, isRtl } from '/js/i18n.js';

/** Create an element. attrs: class, text, dataset{}, on{event: fn}, hidden, and any attribute (aria-*, role…).
 *  Children may be strings, nodes, arrays, null/false (skipped). Text is always set as text — never HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'hidden') el.hidden = !!v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function clear(el) { while (el && el.firstChild) el.firstChild.remove(); return el; }

/** Wrap text that may run in the opposite direction (codes, source values, numbers) so it can't scramble RTL text. */
export const bdi = (text, cls) => h('bdi', { class: cls }, text);

export function debounce(fn, ms = 250) {
  let timer;
  const d = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(timer);
  return d;
}

export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Distance in metres → "850 m" / "1.8 km" (Western digits, localised unit). */
export function formatDistance(m) {
  if (m === null || m === undefined || !Number.isFinite(m)) return null;
  if (m < 1000) return t('common.unit.m', { n: formatNumber(Math.max(10, Math.round(m / 10) * 10)) });
  const km = m < 10000 ? Math.round(m / 100) / 10 : Math.round(m / 1000);
  return t('common.unit.km', { n: formatNumber(km, { maximumFractionDigits: 1 }) });
}
/** Seconds → "about 12 min" / "about 1 h 5 min". */
export function formatDuration(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return null;
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return t('common.unit.min', { n: formatNumber(min) });
  return t('common.unit.hmin', { h: formatNumber(Math.floor(min / 60)), m: formatNumber(min % 60) });
}

/** Load a classic script once (CSP: same-origin only). */
const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scripts.delete(src); reject(new Error(`Failed to load ${src}`)); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}
const styles = new Map();
export function loadCss(href) {
  if (!styles.has(href)) {
    styles.set(href, new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = () => resolve(true);
      l.onerror = () => resolve(false); // unstyled is better than nothing
      document.head.append(l);
    }));
  }
  return styles.get(href);
}

/** Decorative/optional images: hide the <img> (and mark its container) if it fails, so no broken-image icon shows. */
export function guardImages(root = document) {
  for (const img of root.querySelectorAll('img[data-optional]')) {
    const fail = () => { img.hidden = true; img.closest('[data-img-slot]')?.classList.add('img-missing'); };
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fail();
    else img.addEventListener('error', fail, { once: true });
  }
}

/** Arrow direction for "next" in the current writing direction (next points left in Urdu). */
export const nextArrow = () => (isRtl() ? 'arrowLeft' : 'arrowRight');
export const prevArrow = () => (isRtl() ? 'arrowRight' : 'arrowLeft');

const ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  locate: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  map: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z"/><path d="M9 4v14M15 6v14"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15 12 21 12 21Z"/><circle cx="12" cy="10" r="2.4"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.5 9.5"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 10v4.2M12 17h.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.3-.9.8-.9 1.4v.6M12 16.8h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
  closed: '<circle cx="12" cy="12" r="9"/><path d="M7.5 12h9"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  drop: '<path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z"/>',
  star: '<path d="m12 3.8 2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8L12 3.8Z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  file: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5Z"/><path d="M14 3v5h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 3.5-5"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.2 3.2 0 0 1 0 6.3M18 14.2a6 6 0 0 1 3 5.8"/>',
  demo: '<path d="M9 3h6M10 3v6L4.5 19a1.3 1.3 0 0 0 1.1 2h12.8a1.3 1.3 0 0 0 1.1-2L14 9V3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
};
/** Inline SVG icon (decorative: aria-hidden). */
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.innerHTML = ICONS[name] || ICONS.info; // static, trusted markup
  return svg;
}

/** Visually hidden live region helper. */
export function announce(region, message) {
  if (!region) return;
  region.textContent = '';
  // Re-set on the next frame so repeated identical messages are still announced.
  requestAnimationFrame(() => { region.textContent = message; });
}

/** Keep only <a href="https://…"> (and text) from provider attribution HTML. */
export function safeAttribution(html) {
  const frag = document.createDocumentFragment();
  if (!html) return frag;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (node, out) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out.append(n.textContent);
      else if (n.nodeType === 1 && n.tagName === 'A' && /^https:\/\//i.test(n.getAttribute('href') || '')) {
        out.append(h('a', { href: n.getAttribute('href'), rel: 'noopener', target: '_blank' }, n.textContent));
      } else if (n.nodeType === 1) walk(n, out);
    }
  };
  walk(doc.body.firstChild, frag);
  return frag;
}
