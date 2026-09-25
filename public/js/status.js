// /status.html?ref=TW-XXXX-XXXX — report status lookup (reference + last 4 phone digits), clarification reply,
// and the corrections / appeals / deletion form (#appeal, implemented in appeal.js).
import {
  $, h, api, bootPage, setFieldError, showSummary, formatDuration, countdown, statusBadge, tidyRef, REF_RE,
  prefersReducedMotion, initAppeal, t, onLangChange,
} from '/js/appeal.js';
import { formatDate } from '/js/i18n.js';

const REPLY_MIN = 2;
const REPLY_MAX = 2000;

const el = {};
const state = {
  lookup: null, // { reference, last4 } of the last successful lookup
  data: null,
  errors: [], // [{ key, vars, target, errorEl, controls }]
  general: null,
  sending: false,
  cooldown: null,
  replySent: false,
  replyError: null,
  replyStatus: null,
};

function grab() {
  for (const id of ['lookup-form', 'lookup-summary', 'lookup-ref', 'lookup-ref-error', 'lookup-last4', 'lookup-last4-error',
    'lookup-submit', 'lookup-submit-label', 'lookup-spinner', 'lookup-status', 'result', 'result-title', 'result-badge', 'result-explain',
    'result-meta', 'result-timeline', 'result-appeal', 'result-appeal-link', 'reply', 'reply-form', 'reply-message', 'reply-error',
    'reply-submit', 'reply-submit-label', 'reply-status', 'reply-done']) {
    el[id.replace(/-([a-z0-9])/g, (m, c) => c.toUpperCase())] = document.getElementById(id);
  }
}

const when = (iso) => formatDate(iso, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) || '';
const tr = (key, fallback) => { const s = t(key); return s === key ? fallback : s; };

// ─────────── Lookup ───────────
function collect() {
  const errs = [];
  const ref = tidyRef(el.lookupRef.value);
  if (!REF_RE.test(ref)) errs.push({ key: 'report.st.err.ref', target: el.lookupRef, errorEl: el.lookupRefError, controls: el.lookupRef });
  if (!/^\d{4}$/.test(el.lookupLast4.value.trim())) errs.push({ key: 'report.st.err.last4', target: el.lookupLast4, errorEl: el.lookupLast4Error, controls: el.lookupLast4 });
  return errs;
}

function paintErrors(focus) {
  for (const [errorEl, controls] of [[el.lookupRefError, el.lookupRef], [el.lookupLast4Error, el.lookupLast4]]) {
    const e = state.errors.find((x) => x.errorEl === errorEl);
    setFieldError(errorEl, controls, e ? t(e.key, e.vars) : '');
  }
  const items = state.errors.map((e) => ({ target: e.target, text: t(e.key, e.vars) }));
  if (state.general) items.push({ target: state.general.target || el.lookupRef, text: t(state.general.key, state.general.vars) });
  showSummary(el.lookupSummary, items, { focus });
}

function setBusy(on) {
  state.sending = on;
  el.lookupSubmit.disabled = on || Boolean(state.cooldown);
  el.lookupSpinner.hidden = !on;
  el.lookupSubmitLabel.textContent = t(on ? 'report.st.looking' : 'report.st.lookup');
  el.lookupStatus.textContent = on ? t('report.st.looking') : '';
}

function startCooldown(sec) {
  if (state.cooldown) state.cooldown();
  el.lookupSubmit.disabled = true;
  state.cooldown = countdown(sec, (left) => {
    el.lookupSubmitLabel.textContent = t('report.verify.cooldownBtn', { time: formatDuration(left) });
  }, () => {
    state.cooldown = null;
    el.lookupSubmit.disabled = false;
    el.lookupSubmitLabel.textContent = t('report.st.lookup');
  });
}

async function lookup({ focusResult = true, reference, last4 } = {}) {
  const ref = reference || tidyRef(el.lookupRef.value);
  const digits = last4 || el.lookupLast4.value.trim();
  setBusy(true);
  const r = await api(`/api/reports/status?reference=${encodeURIComponent(ref)}&last4=${encodeURIComponent(digits)}`);
  setBusy(false);
  if (r.ok && r.data && r.data.reference) {
    state.lookup = { reference: r.data.reference, last4: digits };
    state.data = r.data;
    state.errors = [];
    state.general = null;
    paintErrors(false);
    renderResult();
    el.result.hidden = false;
    if (focusResult) {
      el.result.focus({ preventScroll: true });
      el.result.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    try { history.replaceState(history.state, '', `${location.pathname}?ref=${encodeURIComponent(r.data.reference)}${location.hash}`); } catch { /* ignore */ }
    return r;
  }
  el.result.hidden = true;
  state.data = null;
  state.errors = [];
  const field = r.error && r.error.details && r.error.details.field;
  if (r.network) state.general = { key: 'report.err.network' };
  else if (r.status === 429) {
    const sec = r.retryAfterSec || 60;
    state.general = { key: 'report.st.err.cooldown', vars: { time: formatDuration(sec) } };
    startCooldown(sec);
  } else if (r.status === 404) state.general = { key: 'report.st.err.notFound', target: el.lookupRef };
  else if (field === 'reference') state.errors = [{ key: 'report.st.err.ref', target: el.lookupRef, errorEl: el.lookupRefError, controls: el.lookupRef }];
  else if (field === 'last4') state.errors = [{ key: 'report.st.err.last4', target: el.lookupLast4, errorEl: el.lookupLast4Error, controls: el.lookupLast4 }];
  else state.general = { key: 'report.err.generic' };
  paintErrors(true);
  return r;
}

// ─────────── Result ───────────
function renderResult() {
  const d = state.data;
  if (!d) return;
  el.resultTitle.textContent = t('report.st.result.ref', { ref: d.reference });
  el.resultBadge.replaceChildren(statusBadge(d.status));
  el.resultExplain.textContent = tr(`report.status.explain.${d.status}`, '');
  el.resultExplain.hidden = !el.resultExplain.textContent;
  el.resultExplain.style.borderInlineStartColor = `var(--tw-${{ needs_clarification: 'starfish', rejected: 'danger', resolved: 'success', confirmed: 'teal-500', under_review: 'cobalt-500' }[d.status] || 'slate-300'})`;

  const p = d.plant || {};
  const np = h('span', { class: 'twr-np', text: t('report.notProvided') });
  el.resultMeta.replaceChildren(
    h('div', {}, h('dt', { text: t('report.st.plant') }),
      h('dd', {}, p.name ? h('span', { dir: 'auto', text: p.name }) : np,
        h('span', { class: 'twr-sub' }, h('bdi', { dir: 'ltr', text: p.code || '' }),
          [p.areaRaw, p.town].filter(Boolean).length ? ` · ${[p.areaRaw, p.town].filter(Boolean).join(' · ')}` : ''))),
    h('div', {}, h('dt', { text: t('report.st.category') }), h('dd', { text: tr(`report.cat.${d.category}`, String(d.category || '').replace(/_/g, ' ')) })),
    h('div', {}, h('dt', { text: t('report.st.created') }), h('dd', { text: when(d.createdAt) })),
    h('div', {}, h('dt', { text: t('report.st.updated') }), h('dd', { text: when(d.updatedAt || d.createdAt) })));

  const items = Array.isArray(d.timeline) ? d.timeline : [];
  el.resultTimeline.replaceChildren(...(items.length ? items.map((ev) => h('li', {},
    h('div', { class: 'twr-tl-head' },
      h('span', { class: 'twr-tl-status', text: ev.status ? tr(`report.status.${ev.status}`, ev.status) : t('report.st.timeline.update') }),
      h('time', { class: 'twr-tl-date', datetime: ev.at || null, text: when(ev.at) })),
    ev.publicNote ? h('p', { class: 'twr-tl-note', dir: 'auto' },
      h('span', { class: 'twr-tl-note-label', text: t('report.st.note') }), String(ev.publicNote)) : null))
    : [h('li', { text: t('report.st.timeline.empty') })]));

  const canReply = Boolean(d.canReply) && d.status === 'needs_clarification';
  el.reply.hidden = !canReply;
  el.replyDone.hidden = !state.replySent;
  el.resultAppeal.hidden = !d.canAppeal;
  paintReply();
}

// ─────────── Clarification reply ───────────
function paintReply() {
  setFieldError(el.replyError, el.replyMessage, state.replyError ? t(state.replyError.key, state.replyError.vars) : '');
  el.replyStatus.textContent = state.replyStatus ? t(state.replyStatus.key, state.replyStatus.vars) : '';
  el.replyStatus.dataset.tone = state.replyStatus ? state.replyStatus.tone || '' : '';
}

async function sendReply() {
  if (!state.lookup) return;
  const message = el.replyMessage.value.trim();
  state.replyStatus = null;
  if (message.length < REPLY_MIN) state.replyError = { key: 'report.reply.err.short', vars: { min: REPLY_MIN } };
  else if (message.length > REPLY_MAX) state.replyError = { key: 'report.reply.err.long', vars: { max: REPLY_MAX } };
  else state.replyError = null;
  paintReply();
  if (state.replyError) { el.replyMessage.focus(); return; }
  el.replySubmit.disabled = true;
  el.replySubmitLabel.textContent = t('report.reply.sending');
  state.replyStatus = { key: 'report.reply.sending' };
  paintReply();
  const r = await api('/api/reports/reply', { method: 'POST', json: { ...state.lookup, message } });
  el.replySubmit.disabled = false;
  el.replySubmitLabel.textContent = t('report.reply.send');
  state.replyStatus = null;
  if (r.ok) {
    state.replySent = true;
    el.replyMessage.value = '';
    paintReply();
    await lookup({ focusResult: false, ...state.lookup });
    el.replyDone.hidden = false;
    el.replyDone.focus();
    return;
  }
  if (r.status === 409) {
    state.replyStatus = { key: 'report.reply.err.closed', tone: 'error' };
    paintReply();
    await lookup({ focusResult: false, ...state.lookup });
    return;
  }
  if (r.status === 429) state.replyStatus = { key: 'report.st.err.cooldown', vars: { time: formatDuration(r.retryAfterSec || 60) }, tone: 'error' };
  else if (r.error && r.error.details && r.error.details.field === 'message') state.replyError = { key: 'report.reply.err.short', vars: { min: REPLY_MIN } };
  else if (r.status === 404) state.replyStatus = { key: 'report.st.err.notFound', tone: 'error' };
  else state.replyStatus = { key: r.network ? 'report.err.network' : 'report.err.generic', tone: 'error' };
  paintReply();
  el.replyMessage.focus();
}

// ─────────── Boot ───────────
async function main() {
  await bootPage({ active: 'status', titleKey: 'report.st.docTitle' });
  grab();
  const appeal = initAppeal();

  const params = new URLSearchParams(location.search);
  const refParam = params.get('ref') || params.get('reference');
  if (refParam) el.lookupRef.value = tidyRef(refParam);

  el.lookupRef.addEventListener('blur', () => { if (el.lookupRef.value.trim()) el.lookupRef.value = tidyRef(el.lookupRef.value); });
  el.lookupLast4.addEventListener('input', () => {
    const digits = el.lookupLast4.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== el.lookupLast4.value) el.lookupLast4.value = digits;
  });
  el.lookupForm.addEventListener('input', () => {
    if (!state.errors.length) return;
    state.errors = collect();
    paintErrors(false);
  });
  el.lookupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.sending || state.cooldown) return;
    state.general = null;
    state.replySent = false;
    el.lookupRef.value = tidyRef(el.lookupRef.value);
    state.errors = collect();
    if (state.errors.length) { paintErrors(true); return; }
    lookup();
  });
  el.replyForm.addEventListener('submit', (e) => { e.preventDefault(); sendReply(); });
  el.resultAppealLink.addEventListener('click', (e) => {
    e.preventDefault();
    appeal.prefill({ kind: 'appeal', reference: state.data && state.data.reference });
    appeal.focus();
  });

  onLangChange(() => {
    if (state.errors.length || state.general) paintErrors(false);
    if (!state.sending && !state.cooldown) el.lookupSubmitLabel.textContent = t('report.st.lookup');
    renderResult();
    paintReply();
  });

  if (location.hash === '#appeal') appeal.focus();
  else if (refParam) el.lookupLast4.focus();
  document.documentElement.classList.add('twr-ready');
}

main();
