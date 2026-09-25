// #/reporters/:id — one community reporter: history, counts and account status.
import {
  el, fill, icon, uid, field, notice, panel, pageHeader, loadingState, errorState, emptyState, errorText, userText, timeEl, setBusy,
  statusBadge, severityBadge, riskBadge, flaggedBadge, stars, yesNo, plantOf, plantCell, pick, truthy, humanize, labelFor, listOf, formatAge,
  CATEGORY_LABELS, safeDate,
} from './_util.js';

const STATUSES = {
  active: { label: 'Active', hint: 'No restriction. Reports are reviewed normally.' },
  restricted: { label: 'Restricted', hint: 'Reports are still accepted and are marked for closer review.' },
  blocked: { label: 'Blocked', hint: 'Reports are still stored for review, but the number is treated as blocked.' },
};

export default {
  id: 'reporter',
  title: 'Reporter',
  permission: 'reporters:manage',
  icon: 'user',
  async render(container, ctx) {
    const id = ctx.params && ctx.params.id;
    let disposed = false;
    const root = el('div', { class: 'mod mod-reporter' });
    container.replaceChildren(root);

    async function load(focusHeading = false) {
      root.replaceChildren(loadingState('Loading reporter…'));
      let res;
      try {
        res = await ctx.api(`/reporters/${encodeURIComponent(id)}`);
      } catch (err) {
        if (disposed) return;
        root.replaceChildren(back(), errorState(err, () => load()));
        return;
      }
      if (disposed) return;
      const r = (res && res.reporter) || res || {};
      const reports = listOf(res && (res.reports || res.history));
      const ratings = listOf(res && res.ratings);
      fill(root, back(),
        pageHeader(`Reporter: ${pick(r, 'alias', 'publicAlias') || `#${id}`}`, 'Reporter identity is private. Only a masked phone number is shown here.'),
        el('div', { class: 'mod-reporter__top' }, summaryPanel(r), statusPanel(r)),
        historyPanel(reports),
        ratings.length ? ratingsPanel(ratings) : null);
      if (focusHeading) root.querySelector('h1')?.focus();
    }

    function back() {
      return el('p', { class: 'mod-back' }, el('a', { href: '#/reports' }, icon('back'), 'All reports'));
    }

    function summaryPanel(r) {
      return panel('Summary',
        el('dl', { class: 'mod-dl mod-dl--compact' },
          el('dt', {}, 'Alias'), el('dd', {}, userText('span', pick(r, 'alias', 'publicAlias') || 'Not provided')),
          el('dt', {}, 'Phone'), el('dd', { dir: 'ltr', class: 'mod-mono' }, pick(r, 'phoneMasked', 'phone_masked') || 'Erased'),
          el('dt', {}, 'Verified'), el('dd', {}, yesNo(truthy(pick(r, 'verified', 'phoneVerified')))),
          el('dt', {}, 'Confirmed reports'), el('dd', { class: 'mod-num' }, String(pick(r, 'confirmedReports', 'confirmed_reports') ?? 0)),
          el('dt', {}, 'Rejected reports'), el('dd', { class: 'mod-num' }, String(pick(r, 'rejectedReports', 'rejected_reports') ?? 0)),
          el('dt', {}, 'Reports in last 30 days'), el('dd', { class: 'mod-num' }, String(pick(r, 'reports30d', 'reports_30d') ?? 0)),
          el('dt', {}, 'First seen'), el('dd', {}, timeEl(ctx, pick(r, 'createdAt', 'created_at'))),
          el('dt', {}, 'Last activity'), el('dd', {}, timeEl(ctx, pick(r, 'lastSeenAt', 'last_seen_at'))),
          el('dt', {}, 'Status'), el('dd', {}, el('span', { class: `mod-badge mod-rstatus mod-rstatus--${r.status || 'active'}` }, humanize(r.status || 'active'))),
          pick(r, 'statusReason', 'status_reason') ? [el('dt', {}, 'Status reason'), el('dd', {}, userText('span', pick(r, 'statusReason', 'status_reason')))] : null));
    }

    function historyPanel(reports) {
      if (!reports.length) return panel('Report history', emptyState('No reports from this reporter.'));
      const now = Date.now();
      return panel('Report history',
        el('div', { class: 'mod-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Report history (scrolls horizontally)' },
          el('table', { class: 'mod-table' },
            el('caption', { class: 'mod-sr' }, 'Reports submitted by this reporter'),
            el('thead', {}, el('tr', {}, ['Reference', 'Plant', 'Category', 'Severity', 'Status', 'Risk', 'Age'].map((h) => el('th', { scope: 'col' }, h)))),
            el('tbody', {}, reports.map((rep) => {
              const created = pick(rep, 'createdAt', 'created_at');
              return el('tr', {},
                el('th', { scope: 'row' }, el('a', { href: `#/reports/${encodeURIComponent(rep.id)}`, class: 'mod-ref' }, pick(rep, 'reference') || `#${rep.id}`)),
                el('td', {}, plantCell(ctx, plantOf(rep))),
                el('td', {}, labelFor(CATEGORY_LABELS, rep.category)),
                el('td', {}, severityBadge(pick(rep, 'severity') || 'normal')),
                el('td', {}, statusBadge(rep.status)),
                el('td', {}, pick(rep, 'riskLevel', 'risk_level') ? riskBadge(pick(rep, 'riskLevel', 'risk_level'))
                  : el('span', { class: 'mod-num' }, `Score ${pick(rep, 'riskScore', 'risk_score') ?? '\u2014'}`),
                truthy(pick(rep, 'reviewQueue', 'review_queue')) ? [' ', flaggedBadge()] : null),
                el('td', { class: 'mod-num' }, el('time', { datetime: created || '', title: created ? safeDate(ctx, created) : '' }, formatAge(created, now))));
            })))));
    }

    function ratingsPanel(ratings) {
      return panel('Ratings from this reporter',
        el('div', { class: 'mod-tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Ratings (scrolls horizontally)' },
          el('table', { class: 'mod-table' },
            el('caption', { class: 'mod-sr' }, 'Experience ratings submitted by this reporter'),
            el('thead', {}, el('tr', {}, ['Plant', 'Stars', 'Status', 'Submitted'].map((h) => el('th', { scope: 'col' }, h)))),
            el('tbody', {}, ratings.map((g) => el('tr', {},
              el('th', { scope: 'row' }, plantCell(ctx, plantOf(g))),
              el('td', {}, stars(g.stars)),
              el('td', {}, humanize(g.status)),
              el('td', {}, timeEl(ctx, pick(g, 'createdAt', 'created_at')))))))));
    }

    function statusPanel(r) {
      const current = r.status || 'active';
      const name = uid('rstatus');
      const radios = Object.keys(STATUSES).map((s) => el('input', { type: 'radio', name, value: s, class: 'mod-radio', checked: s === current }));
      const reason = el('textarea', { class: 'mod-input', rows: '3', maxlength: '1000', name: 'reason' });
      const reasonField = field('Reason', reason, { required: true, hint: 'Recorded in the audit log. Reference the confirmed abuse (for example report references).' });
      const submit = el('button', { type: 'submit', class: 'mod-btn mod-btn--primary' }, 'Change status');
      const formError = el('p', { class: 'mod-error-text', role: 'alert' });
      const form = el('form', { class: 'mod-form', novalidate: true },
        notice('warning', el('p', {}, 'Restrict or block only when justified by confirmed abuse. Reports from blocked numbers are still stored for review.')),
        el('fieldset', { class: 'mod-radios' },
          el('legend', {}, 'Reporter status'),
          radios.map((radio) => el('label', { class: 'mod-radiolabel' }, radio,
            el('span', {}, el('strong', {}, STATUSES[radio.value].label), el('span', { class: 'mod-field__hint' }, STATUSES[radio.value].hint))))),
        reasonField,
        formError,
        el('div', { class: 'mod-actions' }, submit));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = radios.find((x) => x.checked)?.value;
        const text = reason.value.trim();
        reasonField.setError('');
        formError.textContent = '';
        if (status === current) { formError.textContent = `The reporter is already ${STATUSES[status].label.toLowerCase()}.`; return; }
        if (text.length < 3) { reasonField.setError('Enter the reason for this change (at least 3 characters).'); reason.focus(); return; }
        setBusy(submit, true);
        try {
          await ctx.api(`/reporters/${encodeURIComponent(id)}/status`, { method: 'POST', json: { status, reason: text } });
          ctx.toast(`Reporter status changed to ${STATUSES[status].label.toLowerCase()}.`, 'success');
          await load(true);
        } catch (err) {
          setBusy(submit, false);
          formError.textContent = errorText(err);
        }
      });
      return panel('Account status', form);
    }

    await load();
    return () => { disposed = true; };
  },
};
