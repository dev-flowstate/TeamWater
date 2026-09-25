// /report.html?plant=CODE — community problem report (docs/ARCHITECTURE.md §6 "Reports & ratings", §8).
// Plain ES module, no framework. Works fully by keyboard; every message is translated via /js/i18n.js.
import {
  h, svg, api, toResult, bootPage, setFieldError, showSummary, normalizePhone, displayPhone,
  formatDuration, countdown, copyText, statusBadge, prefersReducedMotion, t, getLang, onLangChange, formatNumber,
} from '/js/appeal.js';

const CAT_ICONS = {
  closed_during_hours: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/>',
  no_water: '<path d="M12 3.5s-5.5 6.5-5.5 10.5a5.5 5.5 0 0 0 11 0c0-4-5.5-10.5-5.5-10.5z"/><path d="M4 4l16 16"/>',
  broken_equipment: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L3.5 17.5l3 3 5.7-5.7a4 4 0 0 0 5.3-5.3l-2.4 2.4-2.6-.4-.4-2.6z"/>',
  color_odor_taste: '<path d="M6 3.5h12l-1.6 16.1a1.5 1.5 0 0 1-1.5 1.4H9.1a1.5 1.5 0 0 1-1.5-1.4z"/><path d="M6.8 10c1.8 1.2 3.5-1 5.2 0s3.4 1.2 5.2 0"/>',
  dirty_surroundings: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/>',
  incorrect_details: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><path d="M10 8a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1M12 13.5h.01"/>',
  unexpected_charges: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5h.01M17.5 14.5h.01"/>',
  other: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
};
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_EXT = /\.(jpe?g|png|webp)$/i;
const PHOTO_ERROR_CODES = new Set(['file_too_large', 'too_many_files', 'invalid_file_type', 'corrupt_file', 'upload_rejected', 'payload_too_large']);
const KARACHI_OFFSET_MS = 5 * 3600e3; // Asia/Karachi is UTC+5 all year (no DST).
const DAY = 86400e3;

const tr = (key, fallback, vars) => { const s = t(key, vars); return s === key ? fallback : s; };

let cfg;
const state = {
  plant: null,
  photos: [], // { id, file, url, failed }
  photoMsgs: [], // client-side rejections: [{ key, vars }]
  rating: null,
  location: null,
  verify: { phone: null, token: null, status: null, cancel: null },
  errors: [], // [{ key, vars, target, errorEl, controls }]
  general: null, // { key, vars, detail }
  attempted: false,
  sending: false,
  photoFailure: null, // null | 'photo' | 'size'
  cooldownCancel: null,
  plantState: null, // { kind, code }
};
let photoSeq = 0;

// ─────────── Elements ───────────
const el = {};
function grab() {
  for (const id of ['report-form', 'plant-card', 'plant-body', 'plant-error', 'plant-error-title', 'plant-error-body', 'plant-retry',
    'error-summary', 'photo-failure', 'photo-failure-body', 'send-without-photos', 'category-options', 'category-error', 'safety-note',
    'observed-date', 'observed-time', 'observed-error', 'description', 'description-error', 'description-counter',
    'photos', 'photo-list', 'photo-add', 'photos-hint', 'photos-error', 'photo-status',
    'stars', 'rating-text', 'rating-clear', 'rating-error', 'share-location', 'loc-status', 'location-error',
    'phone', 'phone-error', 'consent', 'consent-error', 'website',
    'verify-box', 'verify-title', 'verify-explain', 'verify-disabled', 'verify-controls', 'verify-send', 'verify-send-row', 'verify-code-row',
    'verify-code', 'verify-confirm', 'code-error', 'verify-done', 'verify-dev', 'verify-status',
    'submit-btn', 'submit-label', 'submit-spinner', 'submit-progress', 'submit-progress-bar', 'submit-progress-text', 'submit-status',
    'confirmation', 'done-ref', 'done-copy', 'done-copy-status', 'done-status', 'done-notes', 'done-status-link', 'done-plant-link']) {
    el[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = document.getElementById(id);
  }
  el.form = el.reportForm;
}
const catInputs = () => [...el.categoryOptions.querySelectorAll('input[type=radio]')];
const starInputs = () => [...el.stars.querySelectorAll('input[type=radio]')];
const category = () => (catInputs().find((i) => i.checked) || {}).value || null;

// ─────────── Plant ───────────
async function loadPlant() {
  const code = (new URLSearchParams(location.search).get('plant') || '').trim();
  el.plantCard.setAttribute('aria-busy', 'true');
  if (!code) return showPlantError('missing', code);
  const r = await api(`/api/plants/${encodeURIComponent(code)}`);
  el.plantCard.removeAttribute('aria-busy');
  if (r.ok && r.data && r.data.code) {
    state.plant = r.data;
    renderPlant();
    el.form.hidden = false;
    el.plantError.hidden = true;
    return;
  }
  if (r.status === 404 || r.status === 400 || r.status === 422) return showPlantError('notFound', code);
  return showPlantError('error', code);
}

function showPlantError(kind, code) {
  state.plantState = { kind, code };
  el.plantCard.hidden = true;
  el.form.hidden = true;
  el.plantError.hidden = false;
  el.plantRetry.hidden = kind !== 'error';
  paintPlantError();
}
function paintPlantError() {
  if (!state.plantState) return;
  const { kind, code } = state.plantState;
  el.plantErrorTitle.textContent = t(`report.plant.${kind}.title`);
  el.plantErrorBody.textContent = t(`report.plant.${kind}.body`, { code: code || '' });
}

function renderPlant() {
  const p = state.plant;
  const np = () => h('span', { class: 'twr-np', text: t('report.notProvided') });
  const area = p.areaRaw || p.areaName;
  el.plantBody.replaceChildren(
    h('p', { class: 'twr-plant-title', dir: p.name ? 'auto' : 'ltr', text: p.name || p.code }),
    p.isDemo ? h('p', { class: 'twr-demo-tag' }, svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>'), h('span', { text: t('report.plant.demo') })) : null,
    h('dl', { class: 'twr-plant-dl' },
      h('div', {}, h('dt', { text: t('report.plant.name') }), h('dd', {}, p.name ? h('span', { dir: 'auto', text: p.name }) : np())),
      h('div', {}, h('dt', { text: t('report.plant.id') }), h('dd', {}, h('bdi', { class: 'twr-code', dir: 'ltr', text: p.code }))),
      h('div', {}, h('dt', { text: t('report.plant.area') }), h('dd', {}, area ? h('span', { dir: 'auto', text: area }) : np())),
      h('div', {}, h('dt', { text: t('report.plant.town') }), h('dd', {}, p.town ? h('span', { dir: 'auto', text: p.town }) : np()))),
    h('a', { class: 'twr-plant-back', href: `/?plant=${encodeURIComponent(p.code)}` },
      svg('<path d="M15 5l-7 7 7 7"/>', 'twr-ico twr-flip'), h('span', { text: t('report.plant.back') })));
}

// ─────────── Categories ───────────
function renderCategories() {
  el.categoryOptions.replaceChildren(...cfg.reportCategories.map((c) => h('label', { class: 'twr-choice' },
    h('input', { type: 'radio', name: 'category', value: c, class: 'twr-sr', id: `cat-${c}`, required: true }),
    h('span', { class: 'twr-choice-box' },
      h('span', { class: 'twr-choice-icon' }, svg(CAT_ICONS[c] || CAT_ICONS.other)),
      h('span', { class: 'twr-choice-title', text: tr(`report.cat.${c}`, c.replace(/_/g, ' ')) }),
      h('span', { class: 'twr-choice-check', 'aria-hidden': 'true' }, svg('<path d="M6 12.5l4 4L18 8"/>'))))));
  el.categoryOptions.addEventListener('change', () => {
    el.safetyNote.hidden = category() !== 'color_odor_taste';
    revalidate();
  });
}
function paintCategories() {
  for (const input of catInputs()) {
    input.closest('label').querySelector('.twr-choice-title').textContent = tr(`report.cat.${input.value}`, input.value.replace(/_/g, ' '));
  }
}

// ─────────── When ───────────
function karachiParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function initWhen() {
  const now = karachiParts(Date.now());
  el.observedDate.value = now.date;
  el.observedTime.value = now.time;
  el.observedDate.max = now.date;
  el.observedDate.min = karachiParts(Date.now() - 90 * DAY + 60e3).date;
}
function observedInstant() {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(el.observedDate.value);
  const n = /^(\d{2}):(\d{2})/.exec(el.observedTime.value);
  if (!m || !n) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +n[1], +n[2]) - KARACHI_OFFSET_MS;
}

// ─────────── Description ───────────
function paintCounter() {
  const n = el.description.value.trim().length;
  const { descriptionMin: min, descriptionMax: max } = cfg.limits;
  el.descriptionCounter.textContent = t(n < min ? 'report.desc.counterMin' : 'report.desc.counter', { n, max, min });
  el.descriptionCounter.classList.toggle('is-low', n > 0 && n < min);
  el.descriptionCounter.classList.toggle('is-high', n > max * 0.95);
}

// ─────────── Photos ───────────
const maxPhotos = () => Number(cfg.limits.maxPhotos) || 3;
const maxMb = () => Number(cfg.limits.maxPhotoMb) || 5;
function fileSize(bytes) {
  return bytes >= 1048576 ? `${formatNumber(bytes / 1048576, { maximumFractionDigits: 1 })} MB` : `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB`;
}
function isAllowedPhoto(file) {
  return PHOTO_TYPES.includes(file.type) || (!file.type && PHOTO_EXT.test(file.name));
}
function addFiles(files) {
  state.photoMsgs = [];
  for (const file of files) {
    if (state.photos.length >= maxPhotos()) { state.photoMsgs.push({ key: 'report.photos.err.count', vars: { max: maxPhotos() } }); break; }
    if (!isAllowedPhoto(file)) { state.photoMsgs.push({ key: 'report.photos.err.type', vars: { name: file.name } }); continue; }
    if (file.size > maxMb() * 1048576) { state.photoMsgs.push({ key: 'report.photos.err.size', vars: { name: file.name, mb: maxMb() } }); continue; }
    state.photos.push({ id: ++photoSeq, file, url: URL.createObjectURL(file), failed: false });
    announcePhoto('report.photos.added', { name: file.name });
  }
  el.photos.value = '';
  renderPhotos();
  if (state.photoMsgs.length) announcePhoto(state.photoMsgs[0].key, state.photoMsgs[0].vars);
}
function removePhoto(id) {
  const i = state.photos.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = state.photos.splice(i, 1);
  URL.revokeObjectURL(p.url);
  state.photoMsgs = [];
  announcePhoto('report.photos.removed', { name: p.file.name });
  if (state.photoFailure && !state.photos.some((x) => x.failed)) hidePhotoFailure();
  renderPhotos();
  const next = el.photoList.querySelectorAll('button')[Math.min(i, state.photos.length - 1)];
  (next || el.photos).focus();
}
function renderPhotos() {
  el.photoList.replaceChildren(...state.photos.map((p) => {
    const errId = `photo-err-${p.id}`;
    return h('li', { class: `twr-photo${p.failed ? ' is-failed' : ''}` },
      h('img', { src: p.url, alt: '', width: 72, height: 72, decoding: 'async' }),
      h('div', { class: 'twr-photo-meta' },
        h('span', { class: 'twr-photo-name', dir: 'auto', text: p.file.name }),
        h('span', { class: 'twr-photo-size', dir: 'ltr', text: fileSize(p.file.size) }),
        p.failed ? h('span', { class: 'twr-photo-err', id: errId }, svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>'), h('span', { text: t('report.photos.err.upload') })) : null),
      h('button', {
        type: 'button', class: 'twr-btn twr-btn--ghost twr-btn--sm', 'aria-label': t('report.photos.removeLabel', { name: p.file.name }),
        'aria-describedby': p.failed ? errId : null, onclick: () => removePhoto(p.id),
      }, svg('<path d="M6 6l12 12M18 6L6 18"/>'), h('span', { text: t('report.photos.remove') })));
  }));
  el.photoAdd.hidden = state.photos.length >= maxPhotos();
  el.photosHint.textContent = `${t('report.photos.hint', { max: maxPhotos(), mb: maxMb() })} · ${t('report.photos.count', { n: state.photos.length, max: maxPhotos() })}`;
  setFieldError(el.photosError, el.photos, state.photoMsgs.map((m) => t(m.key, m.vars)).join(' '));
}
let photoStatus = null;
function announcePhoto(key, vars) {
  photoStatus = { key, vars };
  el.photoStatus.textContent = t(key, vars);
}

function showPhotoFailure(kind, index) {
  state.photoFailure = kind;
  state.photos.forEach((p, i) => { p.failed = typeof index === 'number' ? i === index : true; });
  renderPhotos();
  paintPhotoFailure();
  el.photoFailure.hidden = false;
  el.photoFailure.focus({ preventScroll: true });
  el.photoFailure.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
function paintPhotoFailure() {
  el.photoFailureBody.textContent = t(state.photoFailure === 'size' ? 'report.photos.failed.tooLarge' : 'report.photos.failed.body');
}
function hidePhotoFailure() {
  state.photoFailure = null;
  el.photoFailure.hidden = true;
  state.photos.forEach((p) => { p.failed = false; });
}

// ─────────── Rating ───────────
function paintStars(preview = null) {
  const val = preview ?? state.rating ?? 0;
  starInputs().forEach((input, i) => {
    input.closest('label').classList.toggle('is-on', i < val);
    input.closest('label').classList.toggle('is-preview', preview !== null && i < preview);
  });
  el.ratingText.textContent = state.rating ? t(`report.rating.star${state.rating}`) : t('report.rating.none');
  el.ratingText.classList.toggle('is-empty', !state.rating);
  el.ratingClear.hidden = !state.rating;
}
function initRating() {
  el.stars.addEventListener('change', (e) => {
    state.rating = Number(e.target.value) || null;
    setFieldError(el.ratingError, starInputs(), '');
    paintStars();
  });
  starInputs().forEach((input, i) => {
    const label = input.closest('label');
    label.addEventListener('pointerenter', () => paintStars(i + 1));
    label.addEventListener('pointerleave', () => paintStars());
  });
  el.ratingClear.addEventListener('click', () => {
    starInputs().forEach((i) => { i.checked = false; });
    state.rating = null;
    paintStars();
    starInputs()[0].focus();
  });
  paintStars();
}

// ─────────── Location (opt-in) ───────────
let locStatus = null;
let locSeq = 0;
function setLocStatus(key, tone) {
  locStatus = key ? { key, tone } : null;
  el.locStatus.textContent = key ? t(key) : '';
  el.locStatus.dataset.tone = tone || '';
}
function initLocation() {
  el.shareLocation.addEventListener('change', () => {
    const token = ++locSeq;
    setFieldError(el.locationError, el.shareLocation, '');
    if (!el.shareLocation.checked) { state.location = null; setLocStatus('report.loc.off'); return; }
    if (!('geolocation' in navigator)) { el.shareLocation.checked = false; setLocStatus('report.loc.unsupported', 'warn'); return; }
    state.location = null;
    setLocStatus('report.loc.locating', 'busy');
    navigator.geolocation.getCurrentPosition((pos) => {
      if (token !== locSeq || !el.shareLocation.checked) return;
      state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setLocStatus('report.loc.ok', 'ok');
    }, (err) => {
      if (token !== locSeq) return;
      el.shareLocation.checked = false;
      state.location = null;
      setLocStatus(err && err.code === 1 ? 'report.loc.denied' : 'report.loc.unavailable', 'warn');
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 120000 });
  });
}

// ─────────── Phone verification ───────────
function setVerifyStatus(key, vars, tone) {
  state.verify.status = key ? { key, vars, tone } : null;
  el.verifyStatus.textContent = key ? t(key, vars) : '';
  el.verifyStatus.dataset.tone = tone || '';
}
function paintVerify() {
  const v = state.verify;
  if (v.status) el.verifyStatus.textContent = t(v.status.key, v.status.vars);
  if (!v.cancel) el.verifySend.textContent = t(el.verifyCodeRow.hidden ? 'report.verify.send' : 'report.verify.resend');
}
function showSmsDisabled() {
  el.verifyDisabled.hidden = false;
  el.verifyControls.hidden = true;
  el.verifyExplain.hidden = true;
  el.verifyTitle.hidden = true;
  setVerifyStatus(null);
}
function sendCooldown(sec) {
  if (state.verify.cancel) state.verify.cancel();
  el.verifySend.disabled = true;
  state.verify.cancel = countdown(sec, (left) => {
    el.verifySend.textContent = t('report.verify.cooldownBtn', { time: formatDuration(left) });
  }, () => {
    state.verify.cancel = null;
    el.verifySend.disabled = false;
    paintVerify();
  });
}
function initVerify() {
  if (!cfg.sms.enabled) return showSmsDisabled();
  el.verifyControls.hidden = false;

  el.verifySend.addEventListener('click', async () => {
    const e164 = normalizePhone(el.phone.value);
    if (!e164) {
      setFieldError(el.phoneError, el.phone, t(el.phone.value.trim() ? 'report.err.phone.invalid' : 'report.err.phone.required'));
      setVerifyStatus('report.verify.err.phone', null, 'error');
      el.phone.focus();
      return;
    }
    setFieldError(el.phoneError, el.phone, '');
    el.verifySend.disabled = true;
    el.verifySend.textContent = t('report.verify.sending');
    setVerifyStatus('report.verify.sending', null, 'busy');
    const r = await api('/api/verify/start', { method: 'POST', json: { phone: el.phone.value.trim(), lang: getLang() } });
    el.verifySend.disabled = false;
    if (r.ok && r.data && r.data.enabled === false) { cfg.sms.enabled = false; return showSmsDisabled(); }
    if (r.ok && r.data && r.data.sent) {
      state.verify.phone = e164;
      state.verify.token = null;
      el.verifyCodeRow.hidden = false;
      el.verifyCode.value = '';
      setFieldError(el.codeError, el.verifyCode, '');
      const min = Math.max(1, Math.round((Number(r.data.expiresInSec) || 600) / 60));
      setVerifyStatus('report.verify.sent', { phone: displayPhone(e164), min }, 'ok');
      el.verifyDev.hidden = !r.data.devCode;
      el.verifyDev.textContent = r.data.devCode ? t('report.verify.devCode', { code: r.data.devCode }) : '';
      paintVerify();
      el.verifyCode.focus();
      return;
    }
    paintVerify();
    if (r.status === 429) {
      const sec = r.retryAfterSec || 60;
      setVerifyStatus('report.verify.err.cooldown', { time: formatDuration(sec) }, 'error');
      return sendCooldown(sec);
    }
    if (r.status === 409) { cfg.sms.enabled = false; return showSmsDisabled(); }
    if (r.error && r.error.details && r.error.details.field === 'phone') {
      setFieldError(el.phoneError, el.phone, t('report.err.phone.invalid'));
      return setVerifyStatus('report.verify.err.phone', null, 'error');
    }
    setVerifyStatus(r.network ? 'report.err.network' : 'report.verify.err.send', null, 'error');
  });

  const confirm = async () => {
    const code = el.verifyCode.value.replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) {
      setFieldError(el.codeError, el.verifyCode, t('report.verify.err.codeFormat'));
      el.verifyCode.focus();
      return;
    }
    setFieldError(el.codeError, el.verifyCode, '');
    el.verifyConfirm.disabled = true;
    setVerifyStatus('report.verify.confirming', null, 'busy');
    const r = await api('/api/verify/confirm', { method: 'POST', json: { phone: el.phone.value.trim(), code } });
    el.verifyConfirm.disabled = false;
    if (r.ok && r.data && r.data.verified && r.data.token) {
      state.verify.token = r.data.token;
      state.verify.phone = normalizePhone(el.phone.value);
      el.verifyCodeRow.hidden = true;
      el.verifySendRow.hidden = true;
      el.verifyDev.hidden = true;
      el.verifyDone.hidden = false;
      setVerifyStatus('report.verify.doneLong', null, 'ok');
      el.consent.focus();
      return;
    }
    const code_ = r.error && r.error.code;
    if (code_ === 'too_many_attempts' || (r.status === 429 && code_ !== 'rate_limited')) {
      el.verifyCodeRow.hidden = true;
      el.verifyDev.hidden = true;
      setVerifyStatus('report.verify.err.attempts', null, 'error');
      paintVerify();
      sendCooldown(r.retryAfterSec || 60);
      return el.verifySend.focus();
    }
    if (r.status === 429) {
      const sec = r.retryAfterSec || 60;
      setVerifyStatus('report.verify.err.cooldown', { time: formatDuration(sec) }, 'error');
      return sendCooldown(sec);
    }
    if (code_ === 'code_expired') {
      el.verifyCodeRow.hidden = true;
      el.verifyDev.hidden = true;
      setVerifyStatus('report.verify.err.expired', null, 'error');
      paintVerify();
      return el.verifySend.focus();
    }
    if (r.status === 409) { cfg.sms.enabled = false; return showSmsDisabled(); }
    if (r.network) return setVerifyStatus('report.err.network', null, 'error');
    setFieldError(el.codeError, el.verifyCode, t('report.verify.err.code'));
    setVerifyStatus('report.verify.err.code', null, 'error');
    el.verifyCode.select();
    el.verifyCode.focus();
  };
  el.verifyConfirm.addEventListener('click', confirm);
  el.verifyCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
  el.verifyCode.addEventListener('input', () => {
    const digits = el.verifyCode.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== el.verifyCode.value) el.verifyCode.value = digits;
  });

  el.phone.addEventListener('input', () => {
    const v = state.verify;
    if (!v.phone) return;
    if (normalizePhone(el.phone.value) === v.phone) return;
    const wasVerified = Boolean(v.token);
    v.token = null;
    v.phone = null;
    el.verifyDone.hidden = true;
    el.verifySendRow.hidden = false;
    el.verifyCodeRow.hidden = true;
    el.verifyDev.hidden = true;
    paintVerify();
    setVerifyStatus(wasVerified ? 'report.verify.changed' : null, null, 'warn');
  });
}
function resetVerification(statusKey) {
  state.verify.token = null;
  state.verify.phone = null;
  el.verifyDone.hidden = true;
  el.verifySendRow.hidden = false;
  el.verifyCodeRow.hidden = true;
  paintVerify();
  if (statusKey) setVerifyStatus(statusKey, null, 'warn');
}

// ─────────── Validation ───────────
function collectErrors() {
  const errs = [];
  const add = (key, target, errorEl, controls, vars) => errs.push({ key, vars, target, errorEl, controls });
  const L = cfg.limits;
  if (!category()) add('report.err.category', catInputs()[0], el.categoryError, catInputs());
  const when = [el.observedDate, el.observedTime];
  if (!el.observedDate.value) add('report.err.date.required', el.observedDate, el.observedError, when);
  else if (!el.observedTime.value) add('report.err.time.required', el.observedTime, el.observedError, when);
  else {
    const ts = observedInstant();
    if (ts === null) add('report.err.date.required', el.observedDate, el.observedError, when);
    else if (ts > Date.now() + 60e3) add('report.err.observed.future', el.observedTime, el.observedError, when);
    else if (ts < Date.now() - 90 * DAY) add('report.err.observed.old', el.observedDate, el.observedError, when);
  }
  const len = el.description.value.trim().length;
  if (len < L.descriptionMin) add('report.err.description.short', el.description, el.descriptionError, el.description, { min: L.descriptionMin });
  else if (len > L.descriptionMax) add('report.err.description.long', el.description, el.descriptionError, el.description, { max: L.descriptionMax });
  if (!el.phone.value.trim()) add('report.err.phone.required', el.phone, el.phoneError, el.phone);
  else if (!normalizePhone(el.phone.value)) add('report.err.phone.invalid', el.phone, el.phoneError, el.phone);
  if (!el.consent.checked) add('report.err.consent', el.consent, el.consentError, el.consent);
  return errs;
}

const FIELD_SLOTS = () => [
  [el.categoryError, catInputs()], [el.observedError, [el.observedDate, el.observedTime]], [el.descriptionError, el.description],
  [el.phoneError, el.phone], [el.consentError, el.consent], [el.ratingError, starInputs()], [el.locationError, el.shareLocation],
];

function paintErrors(focus) {
  for (const [errorEl, controls] of FIELD_SLOTS()) {
    const e = state.errors.find((x) => x.errorEl === errorEl);
    setFieldError(errorEl, controls, e ? t(e.key, e.vars) : '');
  }
  const items = state.errors.map((e) => ({ target: e.target, text: t(e.key, e.vars) }));
  if (state.general) {
    const g = state.general;
    items.push({ target: g.target || el.submitBtn, text: t(g.key, g.vars) + (g.detail ? ` ${t('report.err.serverSaid', { msg: g.detail })}` : '') });
  }
  showSummary(el.errorSummary, items, { focus });
}

function revalidate() {
  if (!state.attempted) return;
  const keepServer = state.errors.filter((e) => e.server && !collectErrors().some((c) => c.errorEl === e.errorEl));
  state.errors = collectErrors().concat(keepServer.filter((e) => e.errorEl === el.ratingError || e.errorEl === el.locationError));
  paintErrors(false);
}

// ─────────── Submit ───────────
function xhrPost(url, body, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.timeout = 180000;
    xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); });
    xhr.addEventListener('load', () => resolve(toResult(xhr.status, xhr.responseText, (n) => xhr.getResponseHeader(n))));
    const fail = () => resolve({ ok: false, status: 0, data: null, error: { code: 'network', message: '' }, retryAfterSec: null, network: true });
    xhr.addEventListener('error', fail);
    xhr.addEventListener('timeout', fail);
    xhr.addEventListener('abort', fail);
    xhr.send(body);
  });
}

let slowTimer = null;
function setSending(on) {
  state.sending = on;
  el.submitBtn.disabled = on;
  el.sendWithoutPhotos.disabled = on;
  el.form.setAttribute('aria-busy', on ? 'true' : 'false');
  el.submitSpinner.hidden = !on;
  el.submitLabel.textContent = t(on ? 'report.submitting' : 'report.submit');
  el.submitProgress.hidden = !on;
  el.submitStatus.textContent = on ? t('report.submitting') : '';
  clearTimeout(slowTimer);
  if (on) {
    setProgress(0);
    slowTimer = setTimeout(() => { if (state.sending) el.submitStatus.textContent = t('report.slow'); }, 8000);
  }
}
function setProgress(fraction) {
  const pct = Math.min(100, Math.round(fraction * 100));
  el.submitProgressBar.value = pct;
  el.submitProgressText.textContent = t('report.progress', { pct });
}

async function submit({ withoutPhotos = false } = {}) {
  if (state.sending || !state.plant) return;
  state.attempted = true;
  state.general = null;
  state.errors = collectErrors();
  if (state.errors.length) { paintErrors(true); return; }
  paintErrors(false);

  const fd = new FormData();
  fd.append('plantCode', state.plant.code);
  fd.append('category', category());
  fd.append('description', el.description.value.trim());
  fd.append('observedAt', `${el.observedDate.value}T${el.observedTime.value.slice(0, 5)}`);
  fd.append('phone', el.phone.value.trim());
  fd.append('consent', 'true');
  if (state.rating) fd.append('rating', String(state.rating));
  if (state.location && el.shareLocation.checked) {
    fd.append('shareProximity', 'true');
    fd.append('proximityLat', String(state.location.lat));
    fd.append('proximityLng', String(state.location.lng));
  }
  if (state.verify.token && state.verify.phone === normalizePhone(el.phone.value)) fd.append('verificationToken', state.verify.token);
  fd.append('lang', getLang());
  fd.append('website', el.website.value);
  if (withoutPhotos) {
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    hidePhotoFailure();
    renderPhotos();
  }
  for (const p of state.photos) fd.append('photos', p.file, p.file.name);

  setSending(true);
  const r = await xhrPost('/api/reports', fd, setProgress);
  setSending(false);
  if (r.ok && r.data && r.data.reference) return showConfirmation(r.data);
  handleSubmitError(r);
}

function handleSubmitError(r) {
  const err = r.error || {};
  const details = err.details || {};
  const field = details.field;
  if (r.network) { state.general = { key: 'report.err.network' }; return paintErrors(true); }
  if (r.status === 429) {
    const sec = r.retryAfterSec || 60;
    state.general = { key: 'report.err.cooldown', vars: { time: formatDuration(sec) } };
    if (state.cooldownCancel) state.cooldownCancel();
    el.submitBtn.disabled = true;
    state.cooldownCancel = countdown(sec, (left) => {
      el.submitLabel.textContent = t('report.verify.cooldownBtn', { time: formatDuration(left) });
    }, () => {
      state.cooldownCancel = null;
      el.submitBtn.disabled = false;
      el.submitLabel.textContent = t('report.submit');
    });
    return paintErrors(true);
  }
  if (state.photos.length && (r.status === 413 || field === 'photos' || PHOTO_ERROR_CODES.has(err.code))) {
    const kind = r.status === 413 || err.code === 'payload_too_large' || err.code === 'too_many_files' ? 'size' : 'photo';
    showSummary(el.errorSummary, [], { focus: false });
    return showPhotoFailure(kind, typeof details.index === 'number' ? details.index : undefined);
  }
  const L = cfg.limits;
  const msg = String(err.message || '');
  const slot = {
    category: ['report.err.category', catInputs()[0], el.categoryError, catInputs()],
    description: [el.description.value.trim().length > L.descriptionMax ? 'report.err.description.long' : 'report.err.description.short', el.description, el.descriptionError, el.description, { min: L.descriptionMin, max: L.descriptionMax }],
    observedAt: [/future/i.test(msg) ? 'report.err.observed.future' : /day/i.test(msg) ? 'report.err.observed.old' : 'report.err.date.required', el.observedDate, el.observedError, [el.observedDate, el.observedTime]],
    phone: ['report.err.phone.invalid', el.phone, el.phoneError, el.phone],
    consent: ['report.err.consent', el.consent, el.consentError, el.consent],
    rating: ['report.err.rating', starInputs()[0], el.ratingError, starInputs()],
    shareProximity: ['report.err.location', el.shareLocation, el.locationError, el.shareLocation],
    proximityLat: ['report.err.location', el.shareLocation, el.locationError, el.shareLocation],
    proximityLng: ['report.err.location', el.shareLocation, el.locationError, el.shareLocation],
  }[field];
  if (slot) {
    const [key, target, errorEl, controls, vars] = slot;
    state.errors = [{ key, vars, target, errorEl, controls, server: true }];
    return paintErrors(true);
  }
  if (field === 'verificationToken') {
    resetVerification('report.err.verification');
    state.general = { key: 'report.err.verification', target: el.verifySend };
    return paintErrors(true);
  }
  if (field === 'plantCode' || err.code === 'unknown_plant') { state.general = { key: 'report.err.plantGone' }; return paintErrors(true); }
  state.general = { key: r.status >= 500 || !r.status ? 'report.err.generic' : 'report.err.rejected' };
  return paintErrors(true);
}

// ─────────── Confirmation ───────────
let doneData = null;
function showConfirmation(data) {
  doneData = data;
  if (state.cooldownCancel) state.cooldownCancel();
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  el.doneRef.textContent = data.reference;
  const statusUrl = typeof data.statusUrl === 'string' && data.statusUrl.startsWith('/status.html')
    ? data.statusUrl : `/status.html?ref=${encodeURIComponent(data.reference)}`;
  el.doneStatusLink.href = statusUrl;
  el.donePlantLink.href = `/?plant=${encodeURIComponent(state.plant.code)}`;
  paintConfirmation();
  el.form.hidden = true;
  el.confirmation.hidden = false;
  document.querySelector('.twr-hero .twr-lede').hidden = true;
  el.confirmation.focus({ preventScroll: true });
  el.confirmation.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
function paintConfirmation() {
  if (!doneData) return;
  el.doneStatus.replaceChildren(statusBadge(doneData.status || 'pending'),
    h('span', { class: 'twr-done-explain', text: t(`report.status.explain.${doneData.status || 'pending'}`) }));
  const notes = [doneData.phoneVerified
    ? { icon: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>', key: 'report.done.verified', tone: 'ok' }
    : { icon: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', key: 'report.done.unverified', tone: 'muted' }];
  if (state.rating) {
    notes.push(doneData.ratingRecorded
      ? { icon: '<path d="M12 3.2l2.7 5.5 6 .9-4.4 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.4-4.2 6-.9z"/>', key: 'report.done.rating', tone: 'ok' }
      : { icon: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', key: 'report.done.ratingNot', tone: 'muted' });
  }
  el.doneNotes.replaceChildren(...notes.map((n) => h('li', { class: `twr-done-note twr-done-note--${n.tone}` }, svg(n.icon), h('span', { text: t(n.key) }))));
}

// ─────────── Language changes ───────────
function repaintAll() {
  paintCategories();
  if (state.plant) renderPlant();
  paintPlantError();
  paintCounter();
  renderPhotos();
  if (photoStatus) el.photoStatus.textContent = '';
  if (state.photoFailure) paintPhotoFailure();
  paintStars();
  if (locStatus) el.locStatus.textContent = t(locStatus.key);
  paintVerify();
  if (!el.verifyDev.hidden) el.verifyDev.textContent = el.verifyDev.textContent.replace(/^.*?(\d{6}).*$/, (m, c) => t('report.verify.devCode', { code: c }));
  if (!state.sending && !state.cooldownCancel) el.submitLabel.textContent = t('report.submit');
  if (state.errors.length || state.general) paintErrors(false);
  paintConfirmation();
}

// ─────────── Boot ───────────
async function main() {
  cfg = await bootPage({ active: null, titleKey: 'report.docTitle' });
  grab();
  renderCategories();
  initWhen();
  el.description.maxLength = cfg.limits.descriptionMax;
  paintCounter();
  renderPhotos();
  initRating();
  initLocation();
  initVerify();

  el.description.addEventListener('input', () => { paintCounter(); revalidate(); });
  for (const input of [el.observedDate, el.observedTime, el.phone]) input.addEventListener('input', revalidate);
  el.consent.addEventListener('change', revalidate);
  el.photos.addEventListener('change', () => addFiles([...el.photos.files]));
  el.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  el.sendWithoutPhotos.addEventListener('click', () => submit({ withoutPhotos: true }));
  el.plantRetry.addEventListener('click', () => {
    el.plantError.hidden = true;
    el.plantCard.hidden = false;
    loadPlant();
  });
  el.doneCopy.addEventListener('click', async () => {
    const ok = await copyText(el.doneRef.textContent);
    el.doneCopyStatus.textContent = t(ok ? 'report.done.copied' : 'report.done.copyFailed');
    el.doneCopyStatus.dataset.tone = ok ? 'ok' : 'warn';
  });
  onLangChange(repaintAll);
  await loadPlant();
  document.documentElement.classList.add('twr-ready');
}

main();
