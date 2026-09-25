// #/appeals — corrections, appeals and deletion requests from the public.
import {
  el, agoText, fill, icon, field, selectEl, notice, pageHeader, loadingState, errorState, emptyState, errorText, userText, setBusy, pager,
  plantOf, pick, listOf, formatAge, cleanQuery, humanize, safeDate, truthy, timeEl,
} from './_util.js';

const KINDS = {
  correction: { label: 'Correction', hint: 'Someone says plant details are wrong.' },
  appeal: { label: 'Appeal', hint: 'A reporter disagrees with a moderation decision.' },
  deletion_request: { label: 'Deletion request', hint: 'A reporter asks for their data to be erased.' },
};
const STATUS = {
  open: 'Open', in_progress: 'In progress', accepted: 'Accepted', declined: 'Declined', completed: 'Completed',
};
// Server: declined and completed are final; an accepted request can still be completed (e.g. after the fix).
const CLOSED = ['declined', 'completed'];

const state = { status: 'open', kind: '', page: 1 };

function erasureList() {
  return el('div', { class: 'mod-erase' },
    el('p', {}, 'Completing this deletion request permanently erases:'),
    el('ul', {},
      el('li', {}, 'the reporter’s phone number (the encrypted copy and the last digits used for status look-ups),'),
      el('li', {}, 'the text of their reports (replaced with a redaction notice),'),
      el('li', {}, 'the photos attached to their reports.')),
    el('p', {}, 'Plant records, report statuses without personal content, and the audit trail are kept. This cannot be undone.'));
}

export default {
  id: 'appeals',
  title: 'Appeals & corrections',
  permission: 'appeals',
  icon: 'scale',
  async render(container, ctx) {
    let disposed = false;
    const live = el('p', { class: 'mod-sr', role: 'status', 'aria-live': 'polite' });
    const results = el('div', { class: 'mod-results' });
    const fStatus = selectEl([['open', 'Open'], ['in_progress', 'In progress'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['completed', 'Completed'], ['', 'Any status']], state.status, { name: 'status' });
    const fKind = selectEl([['', 'All kinds'], ...Object.entries(KINDS).map(([k, v]) => [k, v.label])], state.kind, { name: 'kind' });
    fStatus.addEventListener('change', () => { state.status = fStatus.value; state.page = 1; load(); });
    fKind.addEventListener('change', () => { state.kind = fKind.value; state.page = 1; load(); });

    container.replaceChildren(el('div', { class: 'mod mod-appeals' },
      pageHeader('Appeals & corrections', 'Requests from the public to correct plant details, appeal a decision, or delete their data.'),
      el('div', { class: 'mod-filters mod-filters--inline' }, field('Status', fStatus), field('Kind', fKind)),
      live,
      results));

    let seq = 0;
    async function load() {
      const mySeq = ++seq;
      results.replaceChildren(loadingState('Loading requests…'));
      let res;
      try {
        res = await ctx.api('/appeals', { query: cleanQuery({ status: state.status, kind: state.kind, page: state.page }) });
      } catch (err) {
        if (disposed || mySeq !== seq) return;
        results.replaceChildren(errorState(err, load));
        return;
      }
      if (disposed || mySeq !== seq) return;
      // Kind filter is also applied here in case the API ignores it.
      const items = listOf(res).filter((a) => !state.kind || a.kind === state.kind);
      const total = state.kind ? items.length : Number(res && res.total) || items.length;
      live.textContent = items.length ? `${total} request${total === 1 ? '' : 's'}.` : 'No requests match these filters.';
      if (!items.length) {
        results.replaceChildren(emptyState('No requests match these filters.'));
        return;
      }
      fill(results,
        el('ul', { class: 'mod-cards' }, items.map((a) => el('li', {}, appealCard(a)))),
        state.kind ? null : pager({ page: state.page, pageSize: Number(res.pageSize) || 50, total, onChange: (p) => { state.page = p; load(); } }));
    }

    function appealCard(a) {
      const kind = KINDS[a.kind] || { label: humanize(a.kind), hint: '' };
      const status = a.status || 'open';
      const created = pick(a, 'createdAt', 'created_at');
      const reportId = pick(a, 'reportId', 'report_id') ?? (a.report ? a.report.id : undefined);
      const reportRef = pick(a, 'reportReference', 'report_reference') ?? (a.report ? a.report.reference : undefined);
      const plant = plantOf(a);
      const resolution = pick(a, 'resolution');
      const isDeletion = a.kind === 'deletion_request';
      const reporter = a.reporter || null;
      const matched = a.matchedReporter !== undefined ? truthy(a.matchedReporter) : Boolean(reporter);
      const resolvedBy = pick(a, 'resolvedBy', 'resolved_by');
      const resolvedAt = pick(a, 'resolvedAt', 'resolved_at');

      const card = el('article', { class: `mod-card mod-card--appeal is-${status}${isDeletion ? ' is-deletion' : ''}` },
        el('div', { class: 'mod-card__head' },
          el('span', { class: `mod-badge mod-kind mod-kind--${a.kind}` }, isDeletion ? icon('lock') : icon('file'), kind.label),
          el('span', { class: 'mod-ref' }, pick(a, 'reference') || `#${a.id}`),
          el('span', { class: `mod-badge mod-astatus mod-astatus--${status}` }, STATUS[status] || humanize(status)),
          el('span', { class: 'mod-muted' }, el('time', { datetime: created || '', title: created ? safeDate(ctx, created) : '' }, created ? agoText(created) : ''))),
        el('dl', { class: 'mod-dl mod-dl--compact' },
          reportId !== undefined && reportId !== null
            ? [el('dt', {}, 'Report'), el('dd', {}, el('a', { href: `#/reports/${encodeURIComponent(reportId)}`, class: 'mod-ref' }, reportRef || `#${reportId}`))]
            : reportRef ? [el('dt', {}, 'Report'), el('dd', { class: 'mod-ref' }, reportRef)] : null,
          plant.code ? [el('dt', {}, 'Plant'), el('dd', {}, el('a', { href: `#/plants/${encodeURIComponent(plant.code)}` }, plant.code))] : null,
          [el('dt', {}, 'Reporter'), el('dd', {}, reporter
            ? [userText('span', pick(reporter, 'alias') || `#${reporter.id}`),
              ctx.can('reporters:manage') && reporter.id !== undefined ? [' \u00b7 ', el('a', { href: `#/reporters/${encodeURIComponent(reporter.id)}` }, 'History')] : null]
            : el('span', { class: 'mod-muted' }, 'No stored reporter matched the phone number given'))],
          resolvedAt ? [el('dt', {}, 'Resolved'), el('dd', {}, timeEl(ctx, resolvedAt), resolvedBy ? [' by ', userText('span', resolvedBy)] : null)] : null),
        el('h3', { class: 'mod-subhead' }, 'Message'),
        userText('blockquote', pick(a, 'message') || '', { class: 'mod-desc' }),
        resolution ? [el('h3', { class: 'mod-subhead' }, 'Resolution'), userText('p', resolution, { class: 'mod-resolution' })] : null);

      if (CLOSED.includes(status)) return card;

      const statusSel = selectEl(
        ['in_progress', 'accepted', 'declined', 'completed'].filter((s) => s !== status).map((s) => [s, STATUS[s]]),
        isDeletion ? 'completed' : 'accepted', { name: 'status' });
      const text = el('textarea', { class: 'mod-input', rows: '3', maxlength: '2000', name: 'resolution', dir: 'auto' });
      const textField = field('Resolution', text, {
        required: true,
        hint: a.kind === 'correction'
          ? 'Describe what was checked and changed. Edit the plant record itself on the plant page.'
          : 'This may be shown to the person who made the request. Do not include other people’s details.',
      });
      const submit = el('button', { type: 'submit', class: 'mod-btn mod-btn--primary' }, 'Save resolution');
      const formError = el('p', { class: 'mod-error-text', role: 'alert' });
      const erasureWarn = isDeletion
        ? (matched ? notice('danger', erasureList())
          : notice('info', el('p', {}, 'No stored reporter matched the phone number in this request, so completing it will not erase anything. Say so in the resolution.')))
        : null;
      const syncWarn = () => {
        if (!erasureWarn) return;
        erasureWarn.hidden = statusSel.value !== 'completed';
        submit.classList.toggle('mod-btn--danger', statusSel.value === 'completed');
        submit.classList.toggle('mod-btn--primary', statusSel.value !== 'completed');
        submit.lastChild.textContent = statusSel.value === 'completed' ? 'Complete and erase data' : 'Save resolution';
      };
      statusSel.addEventListener('change', syncWarn);

      const form = el('form', { class: 'mod-form mod-card__actions', novalidate: true },
        field('New status', statusSel), erasureWarn, textField, formError, el('div', { class: 'mod-actions' }, submit));
      syncWarn();

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newStatus = statusSel.value;
        const resolutionText = text.value.trim();
        textField.setError('');
        formError.textContent = '';
        if (resolutionText.length < 3) { textField.setError('Describe the resolution (at least 3 characters).'); text.focus(); return; }
        if (isDeletion && newStatus === 'completed' && matched) {
          const answer = await ctx.confirmDialog({
            title: 'Erase this reporter’s data permanently?',
            body: erasureList(),
            confirmLabel: 'Erase data permanently',
            danger: true,
          });
          if (!answer || !answer.confirmed) return;
        }
        setBusy(submit, true);
        try {
          const out = await ctx.api(`/appeals/${encodeURIComponent(a.id)}/resolve`, { method: 'POST', json: { status: newStatus, resolution: resolutionText } });
          if (out && out.notice) ctx.toast(out.notice, 'info');
          ctx.toast(out && out.erasure ? 'Deletion completed. The phone number was erased and the reports were redacted.' : `Request marked ${STATUS[newStatus].toLowerCase()}.`, 'success');
          await load();
        } catch (err) {
          setBusy(submit, false);
          formError.textContent = errorText(err);
        }
      });
      card.append(form);
      return card;
    }

    await load();
    return () => { disposed = true; };
  },
};
