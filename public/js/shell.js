// Shared page shell: header (logo, nav, language toggle, demo banner) and footer (map attribution, About link).
//   import { renderShell } from '/js/shell.js';
//   await initI18n(['report']);                 // loads the 'common' namespace too — call this first
//   const { config } = await renderShell({ active: 'status' });   // 'find' | 'status' | 'about' | 'privacy' | null
// Needs <header id="tw-header"></header> and <footer id="tw-footer"></footer> in the page.
// Standalone: depends only on /js/i18n.js, /js/api.js and the 'common' i18n namespace (+ /css/app.css for styling).
import { t, getLang, setLang, onLangChange } from '/js/i18n.js';
import { getConfig } from '/js/api.js';

const NAV = [
  { key: 'find', href: '/', label: 'common.nav.find' },
  { key: 'status', href: '/status.html', label: 'common.nav.status' },
  { key: 'water', href: '/water-estimates.html', label: 'common.nav.water' },
  { key: 'about', href: '/about.html', label: 'common.nav.about' },
  { key: 'privacy', href: '/privacy.html', label: 'common.nav.privacy' },
];

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'i18n') { n.dataset.i18n = v; n.textContent = t(v); }
    else if (k === 'i18nAttr') {
      n.dataset.i18nAttr = v;
      for (const pair of v.split(';')) { const [a, key] = pair.split(':'); n.setAttribute(a, t(key)); }
    } else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
const svg = (inner, cls = 'icon') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.setAttribute('class', cls);
  s.innerHTML = inner; // static markup only
  return s;
};
const DROP = '<path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z"/>';

function optionalImg(src, cls, w, h) {
  const img = el('img', { src, alt: '', class: cls, width: w, height: h, decoding: 'async', loading: 'lazy' });
  img.addEventListener('error', () => { img.hidden = true; img.parentElement?.classList.add('img-missing'); }, { once: true });
  return img;
}

function brand() {
  const mark = el('span', { class: 'tw-brand-mark', 'aria-hidden': 'true' }, svg(DROP, 'tw-brand-fallback'));
  const logo = el('img', { src: '/img/logo.svg', alt: '', class: 'tw-brand-logo', width: 40, height: 40, decoding: 'async' });
  logo.addEventListener('error', () => { logo.hidden = true; mark.classList.add('img-missing'); }, { once: true });
  mark.append(logo);
  return el('a', { class: 'tw-brand', href: '/' },
    mark,
    el('span', { class: 'tw-brand-text' },
      el('span', { class: 'tw-brand-eyebrow', i18n: 'common.brand.eyebrow' }),
      el('span', { class: 'tw-brand-name', i18n: 'common.appName' })));
}

function updateLangUrl(lang) {
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('lang') || lang !== 'en') { u.searchParams.set('lang', lang); history.replaceState(history.state, '', u); }
  } catch { /* ignore */ }
}

function langToggle() {
  const group = el('div', { class: 'tw-lang', role: 'group', i18nAttr: 'aria-label:common.lang.label' });
  const mk = (code, label) => {
    const b = el('button', { type: 'button', lang: code, class: 'tw-lang-btn', 'aria-pressed': String(getLang() === code) }, label);
    b.addEventListener('click', async () => { updateLangUrl(code); await setLang(code); });
    return b;
  };
  group.append(mk('en', 'EN'), mk('ur', 'اردو'));
  onLangChange((l) => group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.lang === l))));
  return group;
}

function navList(active, id, cls) {
  return el('ul', { class: cls, id },
    NAV.map((n) => el('li', {}, el('a', { href: n.href, i18n: n.label, 'aria-current': n.key === active ? 'page' : null }))));
}

function sanitizeAttribution(html) {
  const frag = document.createDocumentFragment();
  if (!html) return frag;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) frag.append(n.textContent);
      else if (n.nodeType === 1 && n.tagName === 'A' && /^https:\/\//i.test(n.getAttribute('href') || '')) {
        frag.append(el('a', { href: n.getAttribute('href'), rel: 'noopener', target: '_blank' }, n.textContent));
      } else if (n.nodeType === 1) walk(n);
    }
  };
  walk(doc.body.firstChild);
  return frag;
}

let rendered = false;
export async function renderShell({ active = null } = {}) {
  const header = document.getElementById('tw-header');
  const footer = document.getElementById('tw-footer');
  if (rendered) return { config: await getConfig().catch(() => null) };
  rendered = true;

  if (header) {
    header.classList.add('tw-header');
    const menuBtn = el('button', { type: 'button', class: 'tw-menu-btn', 'aria-expanded': 'false', 'aria-controls': 'tw-nav-list' },
      svg('<path d="M4 7h16M4 12h16M4 17h16"/>'), el('span', { i18n: 'common.nav.menu' }));
    const nav = el('nav', { class: 'tw-nav', i18nAttr: 'aria-label:common.nav.label' }, menuBtn, navList(active, 'tw-nav-list', 'tw-nav-list'));
    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') !== 'true';
      menuBtn.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    });
    header.replaceChildren(
      el('a', { class: 'tw-skip', href: '#main', i18n: 'common.skip' }),
      el('div', { class: 'tw-header-bar' }, brand(), nav, langToggle()),
    );
  }

  const attribution = el('span', { class: 'tw-attribution' });
  const providerName = el('bdi', {}, 'OpenStreetMap');
  if (footer) {
    footer.classList.add('tw-footer');
    const gulls = el('span', { class: 'tw-footer-gulls', 'aria-hidden': 'true' }, optionalImg('/img/gulls.svg', '', 220, 90));
    footer.replaceChildren(
      el('div', { class: 'tw-footer-shore', 'aria-hidden': 'true' }),
      el('div', { class: 'tw-footer-inner' },
        el('div', { class: 'tw-footer-brand' },
          el('p', { class: 'tw-footer-name', i18n: 'common.appName' }),
          el('p', { class: 'tw-footer-tagline', i18n: 'common.footer.tagline' })),
        el('nav', { class: 'tw-footer-nav', i18nAttr: 'aria-label:common.footer.navLabel' }, navList(active, null, 'tw-footer-list')),
        el('div', { class: 'tw-footer-meta' },
          el('p', {}, el('span', { i18n: 'common.footer.baseMap' }), ' ', providerName, ' — ', attribution),
          el('p', {}, el('span', { i18n: 'common.footer.plantData' }), ' ', el('a', { href: '/about.html', i18n: 'common.footer.aboutLink' })),
          el('p', { class: 'tw-footer-small', i18n: 'common.footer.noAccount' }))),
      gulls,
    );
  }

  let config = null;
  try { config = await getConfig(); } catch { config = null; }
  if (config) {
    providerName.textContent = config.map?.providerName || 'OpenStreetMap';
    attribution.replaceChildren(sanitizeAttribution(config.map?.attribution));
    if (config.demoMode && header && !header.querySelector('.tw-demo-banner')) {
      header.prepend(el('div', { class: 'tw-demo-banner', role: 'note' },
        svg('<path d="M9 3h6M10 3v6L4.5 19a1.3 1.3 0 0 0 1.1 2h12.8a1.3 1.3 0 0 0 1.1-2L14 9V3"/>'),
        el('strong', { i18n: 'common.demo.title' }), ' ', el('span', { i18n: 'common.demo.text' })));
      document.documentElement.classList.add('tw-demo-mode');
    }
  } else {
    attribution.replaceChildren(document.createTextNode(t('common.footer.attributionUnavailable')));
    attribution.dataset.i18n = 'common.footer.attributionUnavailable';
  }
  return { config };
}
