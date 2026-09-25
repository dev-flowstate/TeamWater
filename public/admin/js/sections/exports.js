// Exports: plants CSV/JSON (export:plants), reports CSV (export:reports). A reports export that includes
// contact numbers is admin-only (export:contacts), requires a reason and is audited server-side.
import { h, pageHeader, card, formField, setFieldError, showFormError, clearFormErrors, withBusy, notice } from '../ui.js';

export default {
  id: 'exports',
  title: 'Exports',
  permission: ['export:plants', 'export:reports'],
  icon: 'download',
  async render(el, ctx) {
    el.append(pageHeader({ title: 'Exports', subtitle: 'Download data for analysis or backup. Exports reflect the database at the moment you download them.' }));

    const dl = async (btn, path, query) => {
      try {
        const r = await withBusy(btn, () => ctx.download(path, { query }), 'Preparing…');
        ctx.toast(`Downloaded ${r.filename}.`, 'success');
      } catch (err) { ctx.toast(`Export failed: ${err.message}`, 'error'); }
    };
    const button = (label, path, query, cls = 'btn-primary') => h('button', { type: 'button', class: `btn ${cls}`, onClick: (e) => dl(e.currentTarget, path, query) }, label);

    if (ctx.can('export:plants')) {
      el.append(card('Plants',
        h('p', null, 'All plant records with original source values, location precision, status source and verification dates. No private data.'),
        (() => {
          const demo = formField({ label: 'Include demonstration (DEMO-) plants', name: 'includeDemo', type: 'checkbox', hint: 'Off by default: demo plants are not real.' });
          const q = () => (demo.control.checked ? { includeDemo: 1 } : undefined);
          return h('div', null, demo, h('div', { class: 'form-actions' },
            h('button', { type: 'button', class: 'btn btn-primary', onClick: (e) => dl(e.currentTarget, '/export/plants.csv', q()) }, 'Download plants (CSV)'),
            h('button', { type: 'button', class: 'btn btn-secondary', onClick: (e) => dl(e.currentTarget, '/export/plants.json', q()) }, 'Download plants (JSON)')));
        })()));
    }
    if (ctx.can('export:reports')) {
      el.append(card('Community reports',
        h('p', null, 'Reports with plant, category, status and dates. Contact numbers are not included.'),
        h('div', { class: 'form-actions' }, button('Download reports (CSV)', '/export/reports.csv', { includeContact: 0 }))));
    }
    if (ctx.can('export:contacts')) {
      const fReason = formField({ label: 'Reason for exporting contact numbers', name: 'reason', type: 'textarea', rows: 2, required: true, dir: 'auto', hint: 'Required and recorded in the audit log with your username.' });
      const fAck = formField({ label: 'I understand this file contains personal phone numbers. I will store it securely, use it only for this purpose and delete it afterwards.', name: 'ack', type: 'checkbox', required: true });
      const form = h('form', { novalidate: true, 'aria-label': 'Export reports with contact numbers' }, fReason, fAck,
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-danger' }, 'Download reports with contact numbers (CSV)')));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        const reason = fReason.control.value.trim();
        let bad = false;
        if (reason.length < 10) { setFieldError(fReason.control, 'Give a specific reason (at least 10 characters).'); bad = true; }
        if (!fAck.control.checked) { setFieldError(fAck.control, 'Confirm that you will handle the file securely.'); bad = true; }
        if (bad) { showFormError(form, 'Complete the highlighted fields before exporting personal data.', { focus: false }); form.querySelector('[aria-invalid="true"]')?.focus(); return; }
        const { confirmed } = await ctx.confirmDialog({ title: 'Export personal contact numbers?', body: 'This download contains reporters’ phone numbers. The export is recorded in the audit log.', confirmLabel: 'Download', danger: true });
        if (!confirmed) return;
        await dl(form.querySelector('button[type=submit]'), '/export/reports.csv', { includeContact: 1, reason });
        fAck.control.checked = false;
      });
      el.append(card('Reports with contact numbers — administrators only',
        notice('danger', h('p', null, h('strong', null, 'Personal data. '), 'This export includes reporters’ phone numbers. Only export it when there is a specific, documented need (for example a deletion request or a follow-up investigation). Never share it by email or chat.')),
        form));
    }
    if (!ctx.can('export:plants') && !ctx.can('export:reports')) {
      el.append(notice('warn', h('p', null, 'Your role has no export permissions.')));
    }
  },
};
