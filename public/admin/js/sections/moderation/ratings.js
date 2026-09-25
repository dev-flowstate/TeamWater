// #/ratings — experience ratings awaiting moderation.
import {
  el, agoText, fill, icon, field, selectEl, notice, pageHeader, loadingState, errorState, emptyState, errorText, userText, setBusy, pager,
  riskBadge, riskReasonsList, yesNo, plantOf, plantCell, pick, truthy, listOf, formatAge, stars, cleanQuery, humanize, safeDate,
} from './_util.js';

const state = { status: 'pending', page: 1 };

export default {
  id: 'ratings',
  title: 'Ratings',
  permission: 'reports:moderate',
  icon: 'star',
  async render(container, ctx) {
    let disposed = false;
    const live = el('p', { class: 'mod-sr', role: 'status', 'aria-live': 'polite' });
    const results = el('div', { class: 'mod-results' });
    const fStatus = selectEl([['pending', 'Pending'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['', 'Any status']], state.status, { name: 'status' });
    fStatus.addEventListener('change', () => { state.status = fStatus.value; state.page = 1; load(); });

    container.replaceChildren(el('div', { class: 'mod mod-ratings' },
      pageHeader('Ratings', 'Star ratings submitted by the public, waiting for review before they count.'),
      notice('info',
        el('p', {}, el('strong', {}, 'Ratings are experience ratings. '),
          'They are separate from complaint reports and from water testing, and they never indicate that water is safe. Only accepted ratings count toward a plant’s score.'),
        el('p', { class: 'mod-risknote' }, 'Risk indicators help prioritise review. They do not prove a rating is false. New reporters and reporters without a verified phone can be genuine.')),
      el('div', { class: 'mod-filters mod-filters--inline' }, field('Status', fStatus)),
      live,
      results));

    let seq = 0;
    async function load() {
      const mySeq = ++seq;
      results.replaceChildren(loadingState('Loading ratings…'));
      let res;
      try {
        res = await ctx.api('/ratings', { query: cleanQuery({ status: state.status, page: state.page }) });
      } catch (err) {
        if (disposed || mySeq !== seq) return;
        results.replaceChildren(errorState(err, load));
        return;
      }
      if (disposed || mySeq !== seq) return;
      const items = listOf(res);
      const total = Number(res && res.total) || items.length;
      live.textContent = items.length ? `${total} rating${total === 1 ? '' : 's'}.` : 'No ratings to show.';
      if (!items.length) {
        results.replaceChildren(emptyState(state.status === 'pending' ? 'No ratings are waiting for review.' : 'No ratings match this filter.'));
        return;
      }
      fill(results,
        el('ul', { class: 'mod-cards' }, items.map((r) => el('li', {}, ratingCard(r)))),
        pager({ page: state.page, pageSize: Number(res.pageSize) || 50, total, onChange: (p) => { state.page = p; load(); } }));
    }

    function ratingCard(r) {
      const status = r.status || 'pending';
      const reasons = pick(r, 'riskReasons', 'risk_reasons') || [];
      const reporter = r.reporter || null;
      const created = pick(r, 'createdAt', 'created_at');
      const card = el('article', { class: `mod-card mod-card--rating is-${status}`, 'aria-label': `Rating ${r.id}` },
        el('div', { class: 'mod-card__head' },
          stars(r.stars),
          el('span', { class: `mod-badge mod-rating-status mod-rating-status--${status}` }, humanize(status)),
          riskBadge(pick(r, 'riskLevel', 'risk_level'))),
        el('dl', { class: 'mod-dl mod-dl--compact' },
          el('dt', {}, 'Plant'), el('dd', {}, plantCell(ctx, plantOf(r))),
          el('dt', {}, 'Submitted'), el('dd', {}, el('time', { datetime: created || '', title: created ? safeDate(ctx, created) : '' }, created ? agoText(created) : 'Not provided')),
          reporter ? [
            el('dt', {}, 'Reporter'), el('dd', {},
              userText('span', pick(reporter, 'alias', 'publicAlias') || 'Unknown'),
              pick(reporter, 'verified', 'phoneVerified') !== undefined
                ? [' · ', yesNo(truthy(pick(reporter, 'verified', 'phoneVerified')), { yes: 'Phone verified', no: 'Phone not verified' })] : null,
              ctx.can('reporters:manage') && reporter.id !== undefined
                ? [' · ', el('a', { href: `#/reporters/${encodeURIComponent(reporter.id)}` }, 'History')] : null),
          ] : [el('dt', {}, 'Reporter'), el('dd', { class: 'mod-muted' }, 'No reporter record')]),
        el('details', { class: 'mod-details', open: reasons.length > 0 && reasons.length <= 3 },
          el('summary', {}, `Risk indicators (${reasons.length})`),
          riskReasonsList(reasons)));

      if (status !== 'pending') return card;

      const reason = el('input', { type: 'text', class: 'mod-input', maxlength: '500', name: 'reason', autocomplete: 'off' });
      const reasonField = field('Reason', reason, { required: true, hint: 'Internal. Recorded in the audit log.' });
      const accept = el('button', { type: 'button', class: 'mod-btn mod-btn--primary' }, icon('check'), 'Accept');
      const reject = el('button', { type: 'button', class: 'mod-btn mod-btn--danger' }, icon('x'), 'Reject');
      async function decide(action, btn) {
        const text = reason.value.trim();
        reasonField.setError('');
        if (text.length < 3) { reasonField.setError('Enter a reason (at least 3 characters).'); reason.focus(); return; }
        setBusy(btn, true);
        try {
          await ctx.api(`/ratings/${encodeURIComponent(r.id)}/decision`, { method: 'POST', json: { action, reason: text } });
          ctx.toast(action === 'accept' ? 'Rating accepted.' : 'Rating rejected.', 'success');
          await load();
          results.querySelector('.mod-cards .mod-input, .mod-empty')?.focus?.();
        } catch (err) {
          setBusy(btn, false);
          reasonField.setError(errorText(err));
        }
      }
      accept.addEventListener('click', () => decide('accept', accept));
      reject.addEventListener('click', () => decide('reject', reject));
      card.append(el('div', { class: 'mod-card__actions' }, reasonField, el('div', { class: 'mod-actions' }, accept, reject)));
      return card;
    }

    await load();
    return () => { disposed = true; };
  },
};
