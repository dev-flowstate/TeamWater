// Accessible confirmation dialog built on <dialog>.
//   const { confirmed, reason } = await confirmDialog({ title: 'Delete test?', body: 'This cannot be undone.',
//                                                       confirmLabel: 'Delete', requireReason: true, danger: true });
// * Modal (showModal), Tab/Shift+Tab are trapped inside, Esc cancels, focus returns to the opener.
// * requireReason adds a required textarea; confirming with an empty (or too short) reason shows an
//   announced error instead of closing.
import { h, uid } from './ui.js';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function confirmDialog({
  title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  requireReason = false, reasonLabel = 'Reason (recorded in the audit log)', reasonHint = '', minReasonLength = 1,
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const titleId = uid('dlg-title');
    const bodyId = uid('dlg-body');
    const reasonId = uid('dlg-reason');
    const errId = uid('dlg-err');

    const reason = requireReason
      ? h('textarea', { id: reasonId, name: 'reason', rows: '3', required: true, dir: 'auto', 'aria-describedby': `${reasonId}-hint ${errId}` })
      : null;
    const err = h('p', { id: errId, class: 'field-error', role: 'alert', hidden: true });
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-secondary', value: 'cancel' }, cancelLabel);
    const okBtn = h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, value: 'confirm' }, confirmLabel);

    const bodyNode = body instanceof Node ? body : h('p', null, String(body || ''));
    const form = h('form', { class: 'dialog-form', method: 'dialog', novalidate: true },
      h('h2', { id: titleId, class: 'dialog-title' }, title),
      h('div', { id: bodyId, class: 'dialog-body' }, bodyNode),
      requireReason ? h('div', { class: 'field' },
        h('label', { for: reasonId, class: 'field-label' }, reasonLabel, h('span', { class: 'req', 'aria-hidden': 'true' }, ' *'), h('span', { class: 'visually-hidden' }, ' (required)')),
        h('p', { id: `${reasonId}-hint`, class: 'hint' }, reasonHint || (minReasonLength > 1 ? `At least ${minReasonLength} characters.` : 'Required.')),
        reason) : null,
      err,
      h('div', { class: 'dialog-actions' }, cancelBtn, okBtn));

    const dlg = h('dialog', { class: `tw-dialog${danger ? ' tw-dialog-danger' : ''}`, 'aria-labelledby': titleId, 'aria-describedby': bodyId }, form);
    document.body.appendChild(dlg);

    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      const value = { confirmed, reason: reason ? reason.value.trim() : '' };
      if (dlg.open) dlg.close();
      dlg.remove();
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
      resolve(value);
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (reason) {
        const v = reason.value.trim();
        if (v.length < minReasonLength) {
          err.textContent = v.length === 0 ? 'Please enter a reason.' : `The reason must be at least ${minReasonLength} characters.`;
          err.hidden = false;
          reason.setAttribute('aria-invalid', 'true');
          reason.focus();
          return;
        }
      }
      finish(true);
    });
    cancelBtn.addEventListener('click', () => finish(false));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); }); // Esc
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    reason?.addEventListener('input', () => { if (reason.value.trim().length >= minReasonLength) { err.hidden = true; reason.removeAttribute('aria-invalid'); } });

    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    (reason || (danger ? cancelBtn : okBtn)).focus();
  });
}
