// #/investigations — group related reports, record findings and a resolution.
import {
  el, icon, field, selectEl, notice, pageHeader, loadingState, errorState, emptyState, errorText, userText, setBusy,
  plantOf, pick, listOf, cleanQuery, humanize, statusBadge, timeEl,
} from './_util.js';

const state = { plantCode: '', status: '' };
const MIN_CLOSE = 10; // server: resolution >= 10 characters to close

const PLANT_STATUS_NOTE = 'Investigations record what was checked and found. They do not change a plant’s official status. To change status, record an administrator assessment on the plant page and reference the investigation there.';

function parseIds(text) {
  const parts = String(text || '').split(/[\s,;]+/).filter(Boolean);
  const ids = [];
  const bad = [];
  for (const p of parts) {
    const clean = p.replace(/^#/, '');
    if (/^\d+$/.test(clean)) ids.push(Number(clean));
    else bad.push(p);
  }
  return { ids: [...new Set(ids)], bad };
}

export default {
  id: 'investigations',
  title: 'Investigations',
  permission: 'investigations',
  icon: 'search',
  async render(container, ctx) {
    let disposed = false;
    const q = ctx.query || {};
    if (q.plantCode || q.plant) state.plantCode = String(q.plantCode || q.plant).toUpperCase();

    const live = el('p', { class: 'mod-sr', role: 'status', 'aria-live': 'polite' });
    const results = el('div', { class: 'mod-results' });

    // ── Filters ──
    const fPlant = el('input', { type: 'text', class: 'mod-input', value: state.plantCode, placeholder: 'e.g. FSD-WFP-0009', autocomplete: 'off', spellcheck: 'false', name: 'plantCode' });
    const fStatus = selectEl([['', 'Any status'], ['open', 'Open'], ['closed', 'Closed']], state.status, { name: 'status' });
    const filters = el('form', { class: 'mod-filters', 'aria-label': 'Filter investigations', novalidate: true },
      field('Plant code', fPlant), field('Status', fStatus),
      el('div', { class: 'mod-filters__actions' },
        el('button', { type: 'submit', class: 'mod-btn mod-btn--primary' }, icon('search'), 'Apply')));
    filters.addEventListener('submit', (e) => {
      e.preventDefault();
      state.plantCode = fPlant.value.trim().toUpperCase();
      state.status = fStatus.value;
      load();
    });

    // ── Create ──
    const cPlant = el('input', { type: 'text', class: 'mod-input', name: 'plantCode', autocomplete: 'off', spellcheck: 'false', value: state.plantCode });
    const cTitle = el('input', { type: 'text', class: 'mod-input', name: 'title', maxlength: '200' });
    const cReports = el('input', { type: 'text', class: 'mod-input', name: 'reportIds', inputmode: 'numeric', autocomplete: 'off' });
    const fPlantC = field('Plant code', cPlant, { required: true });
    const fTitleC = field('Title', cTitle, { required: true, hint: 'A short neutral description, for example “No water reported on several evenings”.' });
    const fReportsC = field('Linked report numbers', cReports, { hint: 'Optional. Report numbers separated by commas (the number at the end of a report’s address, e.g. 12, 15).' });
    const cFindings = el('textarea', { class: 'mod-input', name: 'findings', rows: '3', maxlength: '5000', dir: 'auto' });
    const fFindingsC = field('Initial findings', cFindings, { hint: 'Optional. Internal.' });
    const cSubmit = el('button', { type: 'submit', class: 'mod-btn mod-btn--primary' }, 'Open investigation');
    const cError = el('p', { class: 'mod-error-text', role: 'alert' });
    const createForm = el('form', { class: 'mod-form', novalidate: true }, fPlantC, fTitleC, fReportsC, fFindingsC, cError, el('div', { class: 'mod-actions' }, cSubmit));
    const createBox = el('details', { class: 'mod-panel mod-create' },
      el('summary', { class: 'mod-panel__title' }, 'Open a new investigation'), createForm);
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      [fPlantC, fTitleC, fReportsC].forEach((f) => f.setError(''));
      cError.textContent = '';
      const plantCode = cPlant.value.trim().toUpperCase();
      const title = cTitle.value.trim();
      const { ids, bad } = parseIds(cReports.value);
      let firstBad = null;
      if (!plantCode) { fPlantC.setError('Enter the plant code.'); firstBad ||= cPlant; }
      if (title.length < 3) { fTitleC.setError('Enter a title (at least 3 characters).'); firstBad ||= cTitle; }
      if (bad.length) { fReportsC.setError(`Not report numbers: ${bad.join(', ')}`); firstBad ||= cReports; }
      if (firstBad) { firstBad.focus(); return; }
      setBusy(cSubmit, true);
      try {
        await ctx.api('/investigations', { method: 'POST', json: { plantCode, title, reportIds: ids, findings: cFindings.value.trim() || null } });
        ctx.toast('Investigation opened.', 'success');
        createForm.reset();
        createBox.open = false;
        state.plantCode = plantCode;
        fPlant.value = plantCode;
        await load();
      } catch (err) {
        cError.textContent = errorText(err);
        const f = err && err.details && err.details.field;
        if (f === 'plantCode') fPlantC.setError(errorText(err));
        if (f === 'reportIds') fReportsC.setError(errorText(err));
      } finally {
        setBusy(cSubmit, false);
      }
    });

    container.replaceChildren(el('div', { class: 'mod mod-investigations' },
      pageHeader('Investigations', 'Follow up on related reports and record what was found.'),
      notice('warning', el('p', {}, PLANT_STATUS_NOTE)),
      filters,
      createBox,
      live,
      results));

    let seq = 0;
    async function load() {
      const mySeq = ++seq;
      results.replaceChildren(loadingState('Loading investigations…'));
      let res;
      try {
        res = await ctx.api('/investigations', { query: cleanQuery({ plantCode: state.plantCode, status: state.status }) });
      } catch (err) {
        if (disposed || mySeq !== seq) return;
        results.replaceChildren(errorState(err, load));
        return;
      }
      if (disposed || mySeq !== seq) return;
      const items = listOf(res).filter((i) => !state.status || (i.status || 'open') === state.status);
      live.textContent = items.length ? `${items.length} investigation${items.length === 1 ? '' : 's'}.` : 'No investigations match.';
      results.replaceChildren(items.length
        ? el('ul', { class: 'mod-cards mod-cards--wide' }, items.map((i) => el('li', {}, invCard(i))))
        : emptyState(state.plantCode ? `No investigations for ${state.plantCode}.` : 'No investigations yet.'));
    }

    function invCard(inv) {
      const status = inv.status || 'open';
      const plant = plantOf(inv);
      const reports = listOf(inv.reports).length ? listOf(inv.reports)
        : (pick(inv, 'reportIds', 'report_ids') || []).map((id) => ({ id }));
      const openedBy = inv.openedBy && typeof inv.openedBy === 'object' ? pick(inv.openedBy, 'displayName', 'username') : pick(inv, 'openedByName', 'openedBy');
      const closedBy = inv.closedBy && typeof inv.closedBy === 'object' ? pick(inv.closedBy, 'displayName', 'username') : pick(inv, 'closedByName', 'closedBy');

      const findings = el('textarea', { class: 'mod-input', rows: '4', maxlength: '5000', name: 'findings', dir: 'auto', value: pick(inv, 'findings') || '' });
      const resolution = el('textarea', { class: 'mod-input', rows: '3', maxlength: '5000', name: 'resolution', dir: 'auto', value: pick(inv, 'resolution') || '' });
      const fFind = field('Findings', findings, { hint: 'What was checked, when, and what was observed. Internal.' });
      const fRes = field('Resolution', resolution, { hint: `Required to close (at least ${MIN_CLOSE} characters). What happened as a result.` });
      const addIds = el('input', { type: 'text', class: 'mod-input', name: 'addReportIds', inputmode: 'numeric', autocomplete: 'off' });
      const fAdd = field('Link more reports', addIds, { hint: 'Optional. Report numbers for the same plant, separated by commas.' });
      const save = el('button', { type: 'submit', class: 'mod-btn' }, 'Save');
      const close = el('button', { type: 'button', class: 'mod-btn mod-btn--primary' }, icon('check'), 'Close investigation');
      const reopen = el('button', { type: 'button', class: 'mod-btn' }, 'Reopen');
      const formError = el('p', { class: 'mod-error-text', role: 'alert' });

      async function patch(body, btn, msg) {
        formError.textContent = '';
        fRes.setError('');
        fAdd.setError('');
        const { ids, bad } = parseIds(addIds.value);
        if (bad.length) { fAdd.setError(`Not report numbers: ${bad.join(', ')}`); addIds.focus(); return; }
        if (ids.length) body.addReportIds = ids;
        setBusy(btn, true);
        try {
          await ctx.api(`/investigations/${encodeURIComponent(inv.id)}`, { method: 'PATCH', json: body });
          ctx.toast(msg, 'success');
          await load();
        } catch (err) {
          setBusy(btn, false);
          formError.textContent = errorText(err);
          const f = err && err.details && err.details.field;
          if (f === 'resolution') fRes.setError(errorText(err));
          if (f === 'addReportIds') fAdd.setError(errorText(err));
        }
      }
      const form = el('form', { class: 'mod-form', novalidate: true }, fFind, fRes, fAdd, formError,
        el('div', { class: 'mod-actions' }, status === 'open' ? [save, close] : [save, reopen]));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        patch({ findings: findings.value.trim() || null, resolution: resolution.value.trim() || null }, save, 'Investigation saved.');
      });
      close.addEventListener('click', () => {
        if (resolution.value.trim().length < MIN_CLOSE) {
          fRes.setError(`Describe the outcome before closing (at least ${MIN_CLOSE} characters).`);
          resolution.focus();
          return;
        }
        patch({ findings: findings.value.trim() || null, resolution: resolution.value.trim(), status: 'closed' }, close, 'Investigation closed.');
      });
      reopen.addEventListener('click', () => patch({ status: 'open' }, reopen, 'Investigation reopened.'));

      return el('article', { class: `mod-card mod-card--inv is-${status}` },
        el('div', { class: 'mod-card__head' },
          el('h2', { class: 'mod-card__title' }, userText('span', inv.title || 'Untitled investigation')),
          el('span', { class: `mod-badge mod-inv-status mod-inv-status--${status}` }, status === 'open' ? icon('search') : icon('check'), humanize(status))),
        el('dl', { class: 'mod-dl mod-dl--compact' },
          el('dt', {}, 'Plant'), el('dd', {}, plant.code
            ? [el('a', { href: `#/plants/${encodeURIComponent(plant.code)}` }, plant.code),
              el('span', { class: 'mod-field__hint mod-block' }, 'Official status changes are recorded as an assessment on the plant page.')]
            : 'Not provided'),
          el('dt', {}, 'Opened'), el('dd', {}, timeEl(ctx, pick(inv, 'openedAt', 'opened_at')), openedBy ? [' by ', userText('span', openedBy)] : null),
          status === 'closed' ? [el('dt', {}, 'Closed'), el('dd', {}, timeEl(ctx, pick(inv, 'closedAt', 'closed_at')), closedBy ? [' by ', userText('span', closedBy)] : null)] : null,
          el('dt', {}, 'Linked reports'), el('dd', {}, reports.length
            ? el('ul', { class: 'mod-inline-list' }, reports.map((r) => el('li', {},
              el('a', { href: `#/reports/${encodeURIComponent(r.id)}`, class: 'mod-ref' }, pick(r, 'reference') || `#${r.id}`),
              r.status ? [' ', statusBadge(r.status)] : null)))
            : el('span', { class: 'mod-muted' }, 'None'))),
        form);
    }

    await load();
    return () => { disposed = true; };
  },
};
