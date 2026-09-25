// #/reports/:id — full moderation view of one report.
import {
  el, fill, icon, uid, field, notice, panel, loadingState, errorState, emptyState, errorText, userText, timeEl, setBusy,
  riskBadge, severityBadge, statusBadge, flaggedBadge, yesNo, demoBadge, riskReasonsList, plantOf, pick, truthy,
  formatDistance, formatLocalObserved, formatAge, humanize, labelFor, listOf,
  CATEGORY_LABELS, STATUS_LABELS, DECISIONS, ALLOWED_DECISIONS, EVENT_LABELS, RISK_NOTE, OFFICIAL_STATUS_NOTE,
} from './_util.js';

const REVEAL_VISIBLE_MS = 120000;
const MIN_REVEAL_REASON = 5; // server: str({ min: 5 })
const MIN_REASON = 3; // server: decision reason str({ min: 3 })
const CHECKLIST_NOTE = 'Checklist confirmed: no identifiable faces, no phone numbers or number plates, no private details.';

function normDetail(res) {
  const d = res && res.report ? { ...res, ...res.report } : { ...(res || {}) };
  return {
    raw: d,
    id: d.id,
    reference: pick(d, 'reference') || `#${d.id}`,
    plant: plantOf(d),
    category: d.category,
    severity: pick(d, 'severity') || 'normal',
    status: d.status,
    description: pick(d, 'description'),
    observedAt: pick(d, 'observedAt', 'observed_at'),
    createdAt: pick(d, 'createdAt', 'created_at'),
    updatedAt: pick(d, 'updatedAt', 'updated_at'),
    lang: pick(d, 'lang'),
    redactedAt: pick(d, 'redactedAt', 'redacted_at'),
    phoneVerified: truthy(pick(d, 'phoneVerified', 'phone_verified')),
    reviewQueue: truthy(pick(d, 'reviewQueue', 'review_queue')),
    riskLevel: pick(d, 'riskLevel', 'risk_level'),
    riskScore: pick(d, 'riskScore', 'risk_score'),
    riskReasons: pick(d, 'riskReasons', 'risk_reasons') || [],
    reporter: d.reporter || null,
    photos: Array.isArray(d.photos) ? d.photos : [],
    events: Array.isArray(d.events) ? d.events : [],
    proximityDistanceM: pick(d, 'proximityDistanceM', 'proximity_distance_m'),
    proximityShared: truthy(pick(d, 'proximityShared', 'proximity_shared')),
    proximityApproximate:
      truthy(pick(d, 'proximityApproximate', 'proximity_approximate')) ||
      ['area', 'area_centre', 'approximate'].includes(pick(d, 'proximityBasis', 'proximityPrecision', 'proximity_basis')) ||
      // The API does not store the basis; the risk engine's proximity reason says when it was the area centre.
      (pick(d, 'riskReasons', 'risk_reasons') || []).some((r) => /^proximity/.test(r.code || '') && /area centre|approximate/i.test(r.detail || '')),
    similarReports: pick(d, 'similarReports', 'similar_reports') || [],
    investigations: Array.isArray(d.investigations) ? d.investigations : [],
    allowedActions: Array.isArray(d.allowedActions) ? d.allowedActions : null,
    appeals: Array.isArray(d.appeals) ? d.appeals : [],
  };
}

export default {
  id: 'report-detail',
  title: 'Report',
  permission: 'reports:read',
  icon: 'flag',
  async render(container, ctx) {
    const id = ctx.params && ctx.params.id;
    let disposed = false;
    const timers = new Set();
    const canModerate = ctx.can('reports:moderate');

    const root = el('div', { class: 'mod mod-detail' });
    container.replaceChildren(root);

    // Slots that are re-rendered after a decision or photo moderation.
    const slots = {
      header: el('div'), photos: el('div'), timeline: el('div'), decision: el('div'), reporterStats: el('div'),
    };
    let current = null;

    async function fetchDetail() {
      return normDetail(await ctx.api(`/reports/${encodeURIComponent(id)}`));
    }

    async function initial() {
      root.replaceChildren(loadingState('Loading report…'));
      try {
        current = await fetchDetail();
      } catch (err) {
        if (disposed) return;
        root.replaceChildren(backLink(), errorState(err, initial));
        return;
      }
      if (disposed) return;
      build(current);
    }

    async function refresh({ focus } = {}) {
      try {
        current = await fetchDetail();
      } catch (err) {
        ctx.toast(`Could not refresh the report: ${errorText(err)}`, 'error');
        return;
      }
      if (disposed) return;
      renderHeader(current);
      renderPhotos(current);
      renderTimeline(current);
      renderDecision(current);
      renderReporterStats(current);
      if (focus && slots[focus]) {
        const h = slots[focus].querySelector('h2, h3');
        if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
      }
    }

    function backLink() {
      return el('p', { class: 'mod-back' }, el('a', { href: '#/reports' }, icon('back'), 'All reports'));
    }

    function build(d) {
      renderHeader(d);
      renderPhotos(d);
      renderTimeline(d);
      renderDecision(d);
      renderReporterStats(d);
      root.replaceChildren(
        backLink(),
        slots.header,
        el('div', { class: 'mod-detail__grid' },
          el('div', { class: 'mod-detail__main' },
            reportPanel(d),
            slots.photos,
            slots.timeline,
            slots.decision),
          el('aside', { class: 'mod-detail__side', 'aria-label': 'Review context' },
            riskPanel(d),
            proximityPanel(d),
            similarPanel(d),
            reporterPanel(d),
            investigationPanel(d))));
    }

    // ── Header ──
    function renderHeader(d) {
      slots.header.replaceChildren(el('header', { class: 'mod-head mod-head--detail' },
        el('div', { class: 'mod-head__text' },
          el('h1', { class: 'mod-title', tabindex: '-1' }, 'Report ', el('span', { class: 'mod-ref' }, d.reference)),
          el('div', { class: 'mod-badges' },
            statusBadge(d.status), severityBadge(d.severity), riskBadge(d.riskLevel), d.reviewQueue ? flaggedBadge() : null,
            d.plant.isDemo ? demoBadge() : null))));
    }

    // ── Report body ──
    function reportPanel(d) {
      const plantLink = d.plant.code
        ? el('a', { href: `#/plants/${encodeURIComponent(d.plant.code)}` }, d.plant.code)
        : el('span', {}, 'Unknown plant');
      return panel('Report',
        el('dl', { class: 'mod-dl' },
          dt('Plant'), el('dd', {}, plantLink,
            d.plant.name ? [' — ', userText('span', d.plant.name)] : null,
            d.plant.areaRaw || d.plant.town ? el('span', { class: 'mod-muted' }, ` (${[d.plant.areaRaw, d.plant.town].filter(Boolean).join(', ')})`) : null),
          dt('Category'), el('dd', {}, labelFor(CATEGORY_LABELS, d.category)),
          dt('Severity'), el('dd', {}, severityBadge(d.severity)),
          dt('Observed'), el('dd', {}, formatLocalObserved(d.observedAt)),
          dt('Submitted'), el('dd', {}, timeEl(ctx, d.createdAt), el('span', { class: 'mod-muted' }, ` (${formatAge(d.createdAt)} ago)`)),
          dt('Phone verified'), el('dd', {}, yesNo(d.phoneVerified, { yes: 'Verified by SMS code', no: 'Not verified' }))),
        el('h3', { class: 'mod-subhead' }, 'Description'),
        d.redactedAt
          ? notice('info', el('p', {}, 'The report text was redacted on ', timeEl(ctx, d.redactedAt), '.'))
          : userText('blockquote', d.description || 'No description', { class: 'mod-desc', lang: d.lang || null }),
        notice('warning', el('p', {}, OFFICIAL_STATUS_NOTE, ' ',
          d.plant.code ? el('a', { href: `#/plants/${encodeURIComponent(d.plant.code)}` }, `Open plant ${d.plant.code}`) : null)));
    }

    // ── Risk ──
    function riskPanel(d) {
      return panel('Risk indicators',
        el('p', { class: 'mod-risk-summary' }, riskBadge(d.riskLevel),
          d.riskScore !== undefined && d.riskScore !== null ? el('span', { class: 'mod-muted' }, ` Score ${d.riskScore}`) : null),
        riskReasonsList(d.riskReasons),
        el('p', { class: 'mod-risknote mod-risknote--small' }, RISK_NOTE));
    }

    // ── Proximity ──
    function proximityPanel(d) {
      const dist = formatDistance(d.proximityDistanceM);
      let body;
      if (dist) {
        body = [
          el('p', { class: 'mod-proximity' }, icon('pin'), el('span', {}, `Shared location: ${dist} from plant`)),
          d.proximityApproximate
            ? el('p', { class: 'mod-muted' }, 'Approximate: measured to the area centre because this plant has no exact location.')
            : null,
        ];
      } else if (d.proximityShared) {
        body = el('p', { class: 'mod-proximity' }, icon('pin'), 'Location shared, but the plant has no known position, so no distance was calculated.');
      } else {
        body = el('p', { class: 'mod-proximity mod-proximity--none' }, icon('pin'), 'Not shared (not a negative signal)');
      }
      return panel('Location', body,
        el('p', { class: 'mod-field__hint' }, 'Only the distance is stored. The reporter’s coordinates are never kept.'));
    }

    // ── Similar reports ──
    function similarPanel(d) {
      const items = listOf(d.similarReports);
      if (!items.length) return panel('Similar reports', emptyState('No similar reports found.'));
      return panel('Similar reports',
        el('ul', { class: 'mod-similar' }, items.map((s) => {
          let sim = Number(pick(s, 'similarity', 'score'));
          if (Number.isFinite(sim) && sim <= 1) sim *= 100;
          const sp = plantOf(s);
          return el('li', { class: 'mod-similar__item' },
            el('a', { href: `#/reports/${encodeURIComponent(s.id)}`, class: 'mod-ref' }, pick(s, 'reference') || `#${s.id}`),
            Number.isFinite(sim) ? el('span', { class: 'mod-similar__score' }, `${Math.round(sim)}% similar`) : null,
            s.status ? statusBadge(s.status) : null,
            el('span', { class: 'mod-muted' },
              [sp.code && sp.code !== d.plant.code ? sp.code : null, s.category ? labelFor(CATEGORY_LABELS, s.category) : null,
                pick(s, 'createdAt', 'created_at') ? `${formatAge(pick(s, 'createdAt', 'created_at'))} ago` : null].filter(Boolean).join(' · ')));
        })),
        el('p', { class: 'mod-field__hint' }, 'Similar text can mean a coordinated campaign, or several people seeing the same real problem.'));
    }

    // ── Reporter ──
    function renderReporterStats(d) {
      const r = d.reporter;
      if (!r) {
        slots.reporterStats.replaceChildren(emptyState('No reporter record (it may have been erased after a deletion request).'));
        return;
      }
      const rid = pick(r, 'id');
      fill(slots.reporterStats,
        el('dl', { class: 'mod-dl mod-dl--compact' },
          dt('Alias'), el('dd', {}, userText('span', pick(r, 'alias', 'publicAlias') || 'Not provided')),
          dt('Phone'), el('dd', { dir: 'ltr', class: 'mod-mono' }, pick(r, 'phoneMasked', 'phone_masked') || 'Erased'),
          dt('Verified'), el('dd', {}, yesNo(truthy(pick(r, 'verified', 'phoneVerified')), { yes: 'Yes', no: 'No' })),
          dt('Confirmed reports'), el('dd', { class: 'mod-num' }, String(pick(r, 'confirmedReports', 'confirmed_reports') ?? 0)),
          dt('Rejected reports'), el('dd', { class: 'mod-num' }, String(pick(r, 'rejectedReports', 'rejected_reports') ?? 0)),
          dt('Reports in last 30 days'), el('dd', { class: 'mod-num' }, String(pick(r, 'reports30d', 'reports_30d') ?? 0)),
          dt('Status'), el('dd', {}, el('span', { class: `mod-badge mod-rstatus mod-rstatus--${r.status || 'active'}` }, humanize(r.status || 'active')))),
        rid !== undefined && ctx.can('reporters:manage')
          ? el('p', {}, el('a', { href: `#/reporters/${encodeURIComponent(rid)}` }, icon('user'), 'Reporter history and status'))
          : null);
    }

    function reporterPanel(d) {
      const stored = d.reporter && pick(d.reporter, 'contactAvailable') !== false;
      return panel('Reporter', slots.reporterStats,
        stored ? revealArea() : null,
        d.reporter && !stored && ctx.can('contact:reveal')
          ? el('p', { class: 'mod-field__hint' }, 'The phone number is no longer stored (erased by retention or at the reporter’s request).') : null);
    }

    /** Admin-only: reveal the phone number for this view only. Never stored, cached or logged client-side. */
    function revealArea() {
      if (!ctx.can('contact:reveal')) return null;
      const area = el('div', { class: 'mod-reveal' });
      const hint = el('p', { class: 'mod-field__hint' }, icon('lock'),
        ' Administrators only. Revealing is logged in the audit trail with your name, the time and your reason. The number is shown only in this view and is not saved.');
      const btn = el('button', { type: 'button', class: 'mod-btn mod-btn--warn', 'data-action': 'reveal-contact' }, icon('phone'), 'Reveal phone number');
      btn.addEventListener('click', async () => {
        const answer = await ctx.confirmDialog({
          title: 'Reveal phone number?',
          body: 'Only reveal a number when you need to contact this reporter about this report. This action is logged with your name, the time and your reason.',
          confirmLabel: 'Reveal number',
          requireReason: true,
          minReasonLength: MIN_REVEAL_REASON,
          reasonLabel: 'Reason for revealing (recorded in the audit log)',
        });
        if (!answer || !answer.confirmed) return;
        const reason = String(answer.reason || '').trim();
        if (reason.length < MIN_REVEAL_REASON) {
          ctx.toast(`A reason of at least ${MIN_REVEAL_REASON} characters is required to reveal a phone number.`, 'error');
          return;
        }
        setBusy(btn, true);
        try {
          const res = await ctx.api(`/reports/${encodeURIComponent(id)}/reveal-contact`, { method: 'POST', json: { reason } });
          if (disposed) return;
          showNumber(res && res.phone);
        } catch (err) {
          ctx.toast(`Could not reveal the number: ${errorText(err)}`, 'error');
        } finally {
          setBusy(btn, false);
        }
      });

      function showNumber(phone) {
        if (!phone) {
          area.replaceChildren(hint, btn, el('p', { class: 'mod-muted', role: 'status' }, 'No phone number is stored for this reporter (it may have been erased).'));
          return;
        }
        const hide = el('button', { type: 'button', class: 'mod-btn mod-btn--ghost' }, icon('eyeOff'), 'Hide number');
        const out = el('div', { class: 'mod-revealed', role: 'status' },
          el('p', { class: 'mod-revealed__label' }, 'Phone number (logged reveal):'),
          el('output', { class: 'mod-revealed__phone', dir: 'ltr' }, phone),
          el('p', { class: 'mod-field__hint' }, 'Do not copy this number into notes or other systems. It hides automatically after 2 minutes.'),
          hide);
        const clear = () => { out.remove(); btn.hidden = false; };
        hide.addEventListener('click', () => { clear(); btn.focus(); });
        const t = setTimeout(() => { timers.delete(t); clear(); }, REVEAL_VISIBLE_MS);
        timers.add(t);
        btn.hidden = true;
        area.append(out);
        hide.focus();
      }

      area.append(hint, btn);
      return area;
    }

    // ── Photos ──
    function renderPhotos(d) {
      if (!d.photos.length) {
        slots.photos.replaceChildren(panel('Photos', emptyState('No photos were submitted with this report.')));
        return;
      }
      slots.photos.replaceChildren(panel('Photos',
        el('p', { class: 'mod-field__hint' }, 'Photos stay private until they are approved and explicitly made public. Location metadata was removed at upload.'),
        el('ul', { class: 'mod-photos' }, d.photos.map((p, i) => el('li', {}, photoCard(d, p, i))))));
    }

    function photoCard(d, p, i) {
      const pid = p.id;
      const status = pick(p, 'moderationStatus', 'moderation_status', 'status') || 'pending';
      const isPublic = truthy(pick(p, 'public', 'isPublic'));
      const src = `/api/admin/photos/${encodeURIComponent(pid)}`;
      const statusText = status === 'approved' ? (isPublic ? 'Approved · public' : 'Approved · not public')
        : status === 'rejected' ? 'Rejected · not public' : 'Awaiting moderation · not public';

      const card = el('figure', { class: `mod-photo mod-photo--${status}` },
        el('a', { href: src, target: '_blank', rel: 'noopener', class: 'mod-photo__link' },
          el('img', { src, alt: `Photo ${i + 1} submitted with report ${d.reference}`, loading: 'lazy', decoding: 'async', class: 'mod-photo__img' })),
        el('figcaption', { class: 'mod-photo__cap' },
          el('span', { class: `mod-badge mod-pstatus mod-pstatus--${status}${isPublic ? ' is-public' : ''}` },
            icon(isPublic ? 'eye' : 'lock'), statusText),
          pick(p, 'moderationNote', 'moderation_note', 'note')
            ? userText('span', `Note: ${pick(p, 'moderationNote', 'moderation_note', 'note')}`, { class: 'mod-muted' }) : null));

      if (!canModerate) return card;

      const labels = ['No identifiable faces', 'No phone numbers or vehicle number plates', 'No private details (names, addresses, documents)'];
      const checks = labels.map(() => el('input', { type: 'checkbox', class: 'mod-check' }));
      const note = el('input', { type: 'text', class: 'mod-input', maxlength: '500', autocomplete: 'off' });
      const noteField = field('Moderation note', note, { hint: 'Internal. Required when rejecting. When publishing, the completed checklist is recorded with it.' });

      const btnApprove = el('button', { type: 'button', class: 'mod-btn' }, icon('check'), 'Approve (keep private)');
      const btnPublic = el('button', { type: 'button', class: 'mod-btn mod-btn--primary' }, icon('eye'),
        status === 'approved' ? 'Make public' : 'Approve and make public');
      const btnPrivate = el('button', { type: 'button', class: 'mod-btn' }, icon('eyeOff'), 'Remove from public view');
      const btnReject = el('button', { type: 'button', class: 'mod-btn mod-btn--danger' }, icon('x'), 'Reject');
      const checklistId = uid('chk');
      const gateMsg = el('p', { class: 'mod-field__hint', id: checklistId }, 'Tick every item to make this photo public.');

      const syncGate = () => {
        const ok = checks.every((c) => c.checked);
        btnPublic.disabled = !ok;
        gateMsg.textContent = ok ? 'Checklist complete.' : 'Tick every item to make this photo public.';
      };
      checks.forEach((c) => c.addEventListener('change', syncGate));
      btnPublic.setAttribute('aria-describedby', checklistId);
      syncGate();

      async function moderate(action, pub, btn) {
        const text = note.value.trim();
        if (action === 'reject' && !text) {
          noteField.setError('Add a short note explaining why the photo is rejected.');
          note.focus();
          return;
        }
        noteField.setError('');
        // Publishing requires a note (server rule): record that the checklist was completed.
        const sendNote = pub ? (text ? `${text} — ${CHECKLIST_NOTE}` : CHECKLIST_NOTE) : text || null;
        setBusy(btn, true);
        try {
          await ctx.api(`/photos/${encodeURIComponent(pid)}/moderate`, { method: 'POST', json: { action, public: pub, note: sendNote } });
          ctx.toast(action === 'reject' ? 'Photo rejected.' : pub ? 'Photo approved and made public.' : 'Photo approved (not public).', 'success');
          await refresh({ focus: 'photos' });
        } catch (err) {
          setBusy(btn, false);
          noteField.setError(errorText(err));
        }
      }
      btnApprove.addEventListener('click', () => moderate('approve', false, btnApprove));
      btnPublic.addEventListener('click', () => moderate('approve', true, btnPublic));
      btnPrivate.addEventListener('click', () => moderate('approve', false, btnPrivate));
      btnReject.addEventListener('click', () => moderate('reject', false, btnReject));

      const buttons = [];
      if (status !== 'approved') buttons.push(btnApprove);
      if (!(status === 'approved' && isPublic)) buttons.push(btnPublic);
      if (status === 'approved' && isPublic) buttons.push(btnPrivate);
      if (status !== 'rejected') buttons.push(btnReject);

      card.append(el('div', { class: 'mod-photo__mod' },
        el('fieldset', { class: 'mod-checklist' },
          el('legend', {}, 'Moderation checklist'),
          checks.map((c, k) => el('label', { class: 'mod-checklabel' }, c, el('span', {}, labels[k])))),
        gateMsg,
        noteField,
        el('div', { class: 'mod-actions' }, buttons)));
      return card;
    }

    // ── Timeline ──
    function renderTimeline(d) {
      const when = (e) => pick(e, 'at', 'createdAt', 'created_at');
      const events = d.events.slice().sort((a, b) => (Date.parse(when(a)) || 0) - (Date.parse(when(b)) || 0) || (a.id || 0) - (b.id || 0));
      const legend = el('p', { class: 'mod-tl-legend' },
        el('span', { class: 'mod-tl-key mod-tl-key--internal' }, icon('lock'), 'Internal reason: staff only'),
        el('span', { class: 'mod-tl-key mod-tl-key--public' }, icon('eye'), 'Public note: shown to the reporter'));
      if (!events.length) {
        slots.timeline.replaceChildren(panel('Timeline', emptyState('No events yet.')));
        return;
      }
      slots.timeline.replaceChildren(panel('Timeline', legend,
        el('ol', { class: 'mod-timeline', 'aria-live': 'polite' }, events.map((e) => {
          const from = pick(e, 'fromStatus', 'from_status');
          const to = pick(e, 'toStatus', 'to_status');
          const actor = e.actor && typeof e.actor === 'object'
            ? pick(e.actor, 'displayName', 'username', 'label')
            : pick(e, 'actor', 'actorLabel', 'actorName', 'actor_label');
          const isReply = e.action === 'reporter_reply';
          // The API stores a reporter's reply in `reason` (never public); show it as the reporter's words.
          const message = pick(e, 'message', 'text') ?? (isReply ? pick(e, 'reason') : undefined);
          const reason = isReply ? null : pick(e, 'reason');
          const publicNote = pick(e, 'publicNote', 'public_note');
          const at = when(e);
          const reasonLabel = actor ? 'Internal reason (staff only)' : 'Internal note (staff only)';
          return el('li', { class: `mod-tl mod-tl--${e.action || 'event'}` },
            el('div', { class: 'mod-tl__head' },
              el('strong', { class: 'mod-tl__action' }, labelFor(EVENT_LABELS, e.action)),
              from || to ? el('span', { class: 'mod-tl__change' },
                from ? labelFor(STATUS_LABELS, from) : '', from && to ? ' → ' : '', to ? labelFor(STATUS_LABELS, to) : '') : null,
              el('span', { class: 'mod-tl__meta' },
                actor ? userText('span', actor) : el('span', {}, e.action === 'reporter_reply' ? 'Reporter' : 'System'),
                ' · ', timeEl(ctx, at))),
            message ? el('div', { class: 'mod-tl__note mod-tl__note--reporter' },
              el('span', { class: 'mod-tl__label' }, icon('user'), 'Reporter’s reply (not public)'), userText('p', message)) : null,
            reason ? el('div', { class: 'mod-tl__note mod-tl__note--internal' },
              el('span', { class: 'mod-tl__label' }, icon('lock'), reasonLabel), userText('p', reason)) : null,
            publicNote ? el('div', { class: 'mod-tl__note mod-tl__note--public' },
              el('span', { class: 'mod-tl__label' }, icon('eye'), 'Public note (shown to reporter)'), userText('p', publicNote)) : null);
        }))));
    }

    // ── Decision ──
    function renderDecision(d) {
      if (!canModerate) {
        slots.decision.replaceChildren(panel('Decision', emptyState('Your role can view reports but not record decisions.')));
        return;
      }
      const allowed = (d.allowedActions || ALLOWED_DECISIONS[d.status] || []).filter((a) => DECISIONS[a]);
      if (!allowed.length) {
        slots.decision.replaceChildren(panel('Decision',
          emptyState(`No further decisions are available for a report that is ${labelFor(STATUS_LABELS, d.status).toLowerCase()}.`)));
        return;
      }
      const name = uid('action');
      const radios = allowed.map((a, i) => el('input', { type: 'radio', name, value: a, class: 'mod-radio', checked: i === 0 }));
      const reason = el('textarea', { class: 'mod-input', rows: '3', maxlength: '2000', name: 'reason' });
      const publicNote = el('textarea', { class: 'mod-input', rows: '3', maxlength: '1000', name: 'publicNote', dir: 'auto' });
      const reasonField = field('Internal reason', reason, { required: true, hint: 'Staff only. Explain the evidence behind this decision. Recorded in the audit log.' });
      const noteField = field('Public note (optional)', publicNote, {
        hint: 'Shown to the reporter on the status page. Do not include personal details, other reporters’ information or internal reasoning.',
      });
      const confirmWarn = notice('warning', el('p', {}, OFFICIAL_STATUS_NOTE, ' ',
        d.plant.code ? el('a', { href: `#/plants/${encodeURIComponent(d.plant.code)}` }, 'Go to the plant page') : null));
      const previewStatus = el('span');
      const previewNote = el('p', { class: 'mod-preview__note', dir: 'auto' });
      const preview = el('div', { class: 'mod-preview', 'aria-live': 'polite' },
        el('p', { class: 'mod-preview__label' }, icon('eye'), 'Preview: what the reporter will see'),
        el('p', { class: 'mod-preview__status' }, 'Status: ', previewStatus),
        previewNote);
      const submit = el('button', { type: 'submit', class: 'mod-btn mod-btn--primary' }, icon('check'), 'Record decision');
      const formError = el('p', { class: 'mod-error-text', role: 'alert' });

      const selected = () => (radios.find((r) => r.checked) || radios[0]).value;
      function sync() {
        const a = selected();
        previewStatus.replaceChildren(statusBadge(DECISIONS[a].to));
        const text = publicNote.value.trim();
        previewNote.textContent = text || 'No public note. The reporter will see only the new status.';
        previewNote.classList.toggle('is-empty', !text);
        confirmWarn.hidden = a !== 'confirm';
        noteField.querySelector('.mod-field__label').firstChild.textContent =
          a === 'request_clarification' ? 'Public note: your question for the reporter' : 'Public note (optional)';
      }
      radios.forEach((r) => r.addEventListener('change', sync));
      publicNote.addEventListener('input', sync);

      const form = el('form', { class: 'mod-decision', novalidate: true },
        el('fieldset', { class: 'mod-radios' },
          el('legend', {}, `Action (current status: ${labelFor(STATUS_LABELS, d.status)})`),
          allowed.map((a, i) => el('label', { class: 'mod-radiolabel' }, radios[i],
            el('span', {}, el('strong', {}, DECISIONS[a].label), el('span', { class: 'mod-field__hint' }, DECISIONS[a].hint))))),
        confirmWarn,
        reasonField,
        noteField,
        preview,
        formError,
        el('div', { class: 'mod-actions' }, submit));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const action = selected();
        const r = reason.value.trim();
        const n = publicNote.value.trim();
        reasonField.setError('');
        noteField.setError('');
        formError.textContent = '';
        if (r.length < MIN_REASON) {
          reasonField.setError(`Enter the internal reason for this decision (at least ${MIN_REASON} characters).`);
          reason.focus();
          return;
        }
        if (action === 'request_clarification' && !n) {
          noteField.setError('Write the question for the reporter. They can only answer what they can see.');
          publicNote.focus();
          return;
        }
        setBusy(submit, true);
        try {
          await ctx.api(`/reports/${encodeURIComponent(id)}/decision`, { method: 'POST', json: { action, reason: r, publicNote: n || null } });
          ctx.toast(`Decision recorded: ${DECISIONS[action].label}.`, 'success');
          await refresh({ focus: 'timeline' });
        } catch (err) {
          setBusy(submit, false);
          formError.textContent = errorText(err);
          if (err && err.status === 409) { // someone else changed the status meanwhile
            ctx.toast(`${errorText(err)} The report has been reloaded.`, 'error');
            await refresh();
            return;
          }
          const f = err && err.details && err.details.field;
          if (f === 'reason') reasonField.setError(errorText(err));
          if (f === 'publicNote') noteField.setError(errorText(err));
        }
      });
      sync();
      slots.decision.replaceChildren(panel('Decision', form));
    }

    // ── Investigation ──
    function investigationPanel(d) {
      if (!ctx.can('investigations')) return null;
      const linked = listOf(d.investigations);
      const title = el('input', {
        type: 'text', class: 'mod-input', maxlength: '200',
        value: `${labelFor(CATEGORY_LABELS, d.category)} at ${d.plant.code || 'plant'} (${d.reference})`,
      });
      const titleField = field('Investigation title', title, { required: true });
      const btn = el('button', { type: 'submit', class: 'mod-btn' }, icon('search'), 'Open investigation from this report');
      const result = el('div', { role: 'status' });
      const form = el('form', { class: 'mod-inv-form', novalidate: true }, titleField, el('div', { class: 'mod-actions' }, btn), result);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const t = title.value.trim();
        if (t.length < 3) { titleField.setError('Enter a title (at least 3 characters).'); title.focus(); return; }
        if (!d.plant.code) { titleField.setError('This report has no plant code.'); return; }
        titleField.setError('');
        setBusy(btn, true);
        try {
          const res = await ctx.api('/investigations', { method: 'POST', json: { plantCode: d.plant.code, title: t, reportIds: [Number(d.id)] } });
          const inv = (res && (res.investigation || res)) || {};
          ctx.toast('Investigation opened.', 'success');
          result.replaceChildren(el('p', {}, icon('check'), ` Investigation ${inv.id ? `#${inv.id} ` : ''}opened. `,
            el('a', { href: '#/investigations' }, 'View investigations')));
        } catch (err) {
          titleField.setError(errorText(err));
        } finally {
          setBusy(btn, false);
        }
      });
      const appeals = listOf(d.appeals);
      return panel('Investigation',
        appeals.length && ctx.can('appeals')
          ? el('p', {}, el('a', { href: '#/appeals' }, `${appeals.length} appeal or request${appeals.length === 1 ? '' : 's'} linked to this report`), ': ',
            appeals.map((a, i) => [i ? ', ' : '', el('span', { class: 'mod-ref' }, a.reference || `#${a.id}`), ` (${humanize(a.status)})`]))
          : null,
        linked.length
          ? el('ul', { class: 'mod-list' }, linked.map((inv) => el('li', {},
            el('a', { href: '#/investigations' }, `#${inv.id} `, userText('span', inv.title || 'Untitled')), ' ',
            el('span', { class: 'mod-badge' }, humanize(inv.status || 'open')))))
          : null,
        el('p', { class: 'mod-field__hint' }, 'Use an investigation to gather related reports and record findings. Changing a plant’s official status is done on the plant page with an assessment.'),
        form);
    }

    await initial();
    return () => {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      root.replaceChildren(); // drops any revealed number from the DOM immediately
    };
  },
};

function dt(text) {
  return el('dt', {}, text);
}
