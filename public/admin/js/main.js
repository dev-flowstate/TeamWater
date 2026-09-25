// Admin dashboard shell: sign-in, session, navigation, hash router and the section context (ctx).
// See registry.js for the section module contract.
import { api, download, setCsrfToken, ApiError } from './api.js';
import { routes, DEFAULT_ROUTE } from './registry.js';
import { h, clear, formatDate, escapeHtml, loadingBlock, errorBlock, notice } from './ui.js';
import { confirmDialog } from './dialog.js';
import { toast } from './toast.js';
import { icon } from './icons.js';
import { getPublicConfig } from './config.js';

const $ = (id) => document.getElementById(id);
const ROLE_LABEL = { admin: 'Administrator', editor: 'Editor', moderator: 'Moderator' };

const state = {
  user: null,
  permissions: [],
  cleanup: null,
  navToken: 0,
  modulePerms: new Map(), // pattern → permission from the loaded module (authoritative)
};

// ── Permissions ──
function can(permission) {
  if (!permission) return true;
  if (Array.isArray(permission)) return permission.some((p) => can(p));
  return state.permissions.includes('*') || state.permissions.includes(permission);
}

// ── Router ──
const compiled = routes.map(([pattern, loader, meta = {}]) => {
  const names = [];
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/?]+)'; });
  return { pattern, loader, meta, names, re: new RegExp(`^${source}/?$`) };
});

function parseHash() {
  const hash = location.hash || '';
  if (!hash.startsWith('#/')) return null;
  const q = hash.indexOf('?');
  const path = q === -1 ? hash : hash.slice(0, q);
  const query = q === -1 ? {} : Object.fromEntries(new URLSearchParams(hash.slice(q + 1)));
  return { path, query };
}

function matchRoute(path) {
  for (const r of compiled) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; } });
      return { ...r, params };
    }
  }
  return null;
}

function navigate(hash) {
  let target = String(hash || DEFAULT_ROUTE);
  if (!target.startsWith('#')) target = '#' + target.replace(/^\/?/, '/');
  if (location.hash === target) route();
  else location.hash = target;
}

/** Update the hash query without re-rendering (for in-place filters). */
function setQuery(query, { replace = true } = {}) {
  const parsed = parseHash();
  if (!parsed) return;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '' && v !== false) qs.set(k, String(v));
  const s = qs.toString();
  const next = `${location.pathname}${location.search}${parsed.path}${s ? '?' + s : ''}`;
  if (replace) history.replaceState(history.state, '', next);
  else history.pushState(history.state, '', next);
}

function runCleanup() {
  const fn = state.cleanup;
  state.cleanup = null;
  if (typeof fn === 'function') { try { fn(); } catch (err) { console.error('[admin] cleanup failed', err); } }
}

function sectionMessage(title, text, tone = 'info') {
  return h('div', { class: 'section' },
    h('header', { class: 'page-header' }, h('div', { class: 'page-header-text' }, h('h1', { tabindex: '-1' }, title))),
    notice(tone, h('p', null, text)));
}

async function route() {
  if (!state.user) return;
  const parsed = parseHash();
  if (!parsed) { history.replaceState(history.state, '', `${location.pathname}${location.search}${firstAllowedRoute()}`); return route(); }
  const token = ++state.navToken;
  runCleanup();
  closeMenu();
  const main = $('main');
  const m = matchRoute(parsed.path);
  markNav(m);
  clear(main);
  if (!m) {
    document.title = 'Not found · Team Water Admin';
    main.append(sectionMessage('Page not found', 'There is no admin page at this address. Use the menu to choose a section.', 'warn'));
    return focusHeading(main);
  }
  main.append(loadingBlock());
  main.setAttribute('aria-busy', 'true');
  let mod;
  try {
    mod = await m.loader();
  } catch (err) {
    if (token !== state.navToken) return;
    console.warn('[admin] section failed to load', m.pattern, err);
    main.removeAttribute('aria-busy');
    clear(main);
    document.title = `${m.meta.title || 'Section'} · Team Water Admin`;
    main.append(sectionMessage(m.meta.title || 'Section unavailable', 'This section is not available yet.'));
    return focusHeading(main);
  }
  if (token !== state.navToken) return;
  const section = mod && mod.default;
  main.removeAttribute('aria-busy');
  clear(main);
  if (!section || typeof section.render !== 'function') {
    main.append(sectionMessage(m.meta.title || 'Section unavailable', 'This section is not available yet.'));
    return focusHeading(main);
  }
  if (section.permission !== undefined) state.modulePerms.set(m.pattern, section.permission);
  document.title = `${section.title || m.meta.title || 'Admin'} · Team Water Admin`;
  if (!can(section.permission)) {
    main.append(sectionMessage(section.title || 'No access', 'Your role does not have access to this section. Ask an administrator if you need it.', 'warn'));
    return focusHeading(main);
  }
  const container = h('div', { class: `section section-${section.id || 'x'}` });
  main.append(container);
  const ctx = makeCtx(m.params, parsed.query, token);
  try {
    const cleanup = await section.render(container, ctx);
    if (token !== state.navToken) { if (typeof cleanup === 'function') cleanup(); return; }
    if (typeof cleanup === 'function') state.cleanup = cleanup;
  } catch (err) {
    if (token !== state.navToken) return;
    console.error('[admin] render failed', err);
    if (!(err instanceof ApiError && err.status === 401)) {
      container.append(errorBlock(err, () => route()));
    }
  }
  focusHeading(container);
}

function focusHeading(root) {
  const target = root.querySelector('h1') || $('main');
  if (target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target?.focus({ preventScroll: false });
}

function makeCtx(params, query, token) {
  return {
    api,
    download,
    user: state.user,
    permissions: [...state.permissions],
    can,
    toast,
    navigate,
    confirmDialog,
    formatDate,
    escapeHtml,
    params,
    query,
    setQuery,
    isCurrent: () => token === state.navToken,
  };
}

function firstAllowedRoute() {
  const def = compiled.find((r) => r.pattern === DEFAULT_ROUTE);
  if (def && can(effectivePermission(def))) return DEFAULT_ROUTE;
  const first = compiled.find((r) => r.meta.nav && can(effectivePermission(r)));
  return first ? first.pattern : DEFAULT_ROUTE;
}

const effectivePermission = (r) => (state.modulePerms.has(r.pattern) ? state.modulePerms.get(r.pattern) : r.meta.permission);

// ── Navigation ──
function buildNav() {
  const nav = $('sidenav');
  clear(nav);
  const groups = new Map();
  for (const r of compiled) {
    if (!r.meta.nav) continue;
    if (!groups.has(r.meta.group)) groups.set(r.meta.group, []);
    groups.get(r.meta.group).push(r);
  }
  let gi = 0;
  for (const [group, items] of groups) {
    const gid = `nav-group-${gi++}`;
    const list = h('ul', { class: 'nav-list', 'aria-labelledby': gid });
    for (const r of items) {
      const li = h('li', { class: 'nav-item', dataset: { pattern: r.pattern }, hidden: !can(r.meta.permission) || null },
        h('a', { class: 'nav-link', href: r.pattern }, icon(r.meta.icon || 'dot'), h('span', { class: 'nav-label' }, r.meta.title)));
      list.appendChild(li);
    }
    const section = h('div', { class: 'nav-group' }, h('h2', { class: 'nav-group-title', id: gid }, group), list);
    nav.appendChild(section);
  }
  refreshNavGroups();
  // Load nav modules in the background so each module's own title/permission is authoritative.
  for (const r of compiled) {
    if (!r.meta.nav) continue;
    r.loader().then((mod) => {
      const s = mod && mod.default;
      if (!s) return;
      const li = nav.querySelector(`[data-pattern="${CSS.escape(r.pattern)}"]`);
      if (!li) return;
      if (s.permission !== undefined) { state.modulePerms.set(r.pattern, s.permission); li.hidden = !can(s.permission); }
      if (s.title) li.querySelector('.nav-label').textContent = s.title;
      refreshNavGroups();
    }).catch(() => { /* not built yet: the item stays and shows "not available yet" when opened */ });
  }
}

function refreshNavGroups() {
  document.querySelectorAll('#sidenav .nav-group').forEach((g) => {
    g.hidden = !g.querySelector('.nav-item:not([hidden])');
  });
}

function markNav(m) {
  const active = m ? (m.meta.parent || m.pattern) : null;
  document.querySelectorAll('#sidenav .nav-link').forEach((a) => {
    if (a.getAttribute('href') === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function openMenu() {
  document.body.classList.add('nav-open');
  $('menu-toggle').setAttribute('aria-expanded', 'true');
  $('sidenav').querySelector('.nav-link:not([hidden])')?.focus();
}
function closeMenu() {
  if (!document.body.classList.contains('nav-open')) return;
  document.body.classList.remove('nav-open');
  $('menu-toggle').setAttribute('aria-expanded', 'false');
}

// ── Session ──
function applySession(data) {
  state.user = data.user;
  state.permissions = Array.isArray(data.permissions) ? data.permissions : [];
  state.modulePerms.clear();
  setCsrfToken(data.csrfToken);
  $('session-name').textContent = data.user.displayName || data.user.username;
  $('session-role').textContent = ROLE_LABEL[data.user.role] || data.user.role;
}

function showApp() {
  $('boot').hidden = true;
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  document.body.classList.remove('is-booting', 'is-login');
  buildNav();
  route();
}

function showLogin(message) {
  runCleanup();
  state.navToken++;
  state.user = null;
  state.permissions = [];
  setCsrfToken(null);
  clear($('main'));
  clear($('sidenav'));
  closeMenu();
  $('boot').hidden = true;
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  document.body.classList.remove('is-booting');
  document.body.classList.add('is-login');
  document.title = 'Sign in · Team Water Admin';
  const status = $('login-status');
  status.textContent = message || '';
  status.hidden = !message;
  const err = $('login-error');
  err.hidden = true;
  err.textContent = '';
  $('login-password').value = '';
  const user = $('login-username');
  (user.value ? $('login-password') : user).focus();
}

function setLoginFieldError(input, message) {
  const e = $(`${input.id}-err`);
  if (message) { input.setAttribute('aria-invalid', 'true'); e.textContent = message; e.hidden = false; }
  else { input.removeAttribute('aria-invalid'); e.textContent = ''; e.hidden = true; }
}

async function onLogin(event) {
  event.preventDefault();
  const username = $('login-username');
  const password = $('login-password');
  const err = $('login-error');
  const button = $('login-submit');
  err.hidden = true;
  setLoginFieldError(username, username.value.trim() ? null : 'Enter your username.');
  setLoginFieldError(password, password.value ? null : 'Enter your password.');
  if (!username.value.trim() || !password.value) {
    err.textContent = 'Enter your username and password.';
    err.hidden = false;
    (username.value.trim() ? password : username).focus();
    return;
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Signing in…';
  try {
    const data = await api('/login', { method: 'POST', json: { username: username.value.trim(), password: password.value }, skipAuthEvent: true });
    password.value = '';
    $('login-status').hidden = true;
    applySession(data);
    showApp();
  } catch (e) {
    let message;
    if (e.status === 429) {
      const secs = Number(e.details && e.details.retryAfterSec) || 0;
      const mins = Math.max(1, Math.ceil(secs / 60));
      message = `Too many failed sign-in attempts. For security, sign-in is paused — try again in ${secs ? `about ${mins} minute${mins === 1 ? '' : 's'}` : 'a few minutes'}.`;
    } else if (e.status === 401) {
      message = 'Username or password is incorrect.';
    } else {
      message = e.message || 'Sign-in failed. Please try again.';
    }
    err.textContent = message;
    err.hidden = false;
    password.value = '';
    if (e.status === 401) { setLoginFieldError(password, 'Check your password and try again.'); password.focus(); }
    else err.focus();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Sign in';
  }
}

async function onSignOut() {
  const btn = $('signout');
  btn.disabled = true;
  try { await api('/logout', { method: 'POST', skipAuthEvent: true }); } catch { /* session may already be gone */ }
  btn.disabled = false;
  showLogin('You have signed out.');
}

// ── Boot ──
async function boot() {
  $('login-form').addEventListener('submit', onLogin);
  $('signout').addEventListener('click', onSignOut);
  $('menu-toggle').addEventListener('click', () => (document.body.classList.contains('nav-open') ? closeMenu() : openMenu()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open') && !document.querySelector('dialog[open]')) { closeMenu(); $('menu-toggle').focus(); }
  });
  $('skip-link').addEventListener('click', (e) => { e.preventDefault(); const t = $('app-view').hidden ? $('login-title') : $('main'); t.focus(); });
  window.addEventListener('hashchange', () => { if (state.user) route(); });
  window.addEventListener('tw-admin:unauthenticated', () => {
    if (state.user) showLogin('Your session has ended. Please sign in again.');
  });

  getPublicConfig().then((cfg) => { if (cfg && cfg.demoMode) $('demo-banner').hidden = false; });

  try {
    const me = await api('/me', { skipAuthEvent: true });
    applySession(me);
    showApp();
  } catch (e) {
    showLogin(e.status && e.status !== 401 ? `Could not check your session: ${e.message}` : '');
  }
}

boot();
