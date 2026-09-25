// Users (users:manage): list, create (role + password ≥ 12 characters), change role, deactivate/reactivate.
import {
  h, pick, listOf, pageHeader, card, dataTable, formField, setFieldError, showFormError, clearFormErrors, withBusy,
  loadingBlock, errorBlock, badge, notice,
} from '../ui.js';

const ROLES = {
  admin: { label: 'Administrator', desc: 'Everything, including users, contact reveal and contact exports.' },
  editor: { label: 'Editor', desc: 'Plant data, imports, water tests, areas, duplicates, plant exports.' },
  moderator: { label: 'Moderator', desc: 'Reports, ratings, appeals, investigations, reporter status, report exports.' },
};
const U = {
  id: (u) => pick(u, 'id'),
  username: (u) => pick(u, 'username'),
  name: (u) => pick(u, 'displayName', 'display_name'),
  role: (u) => pick(u, 'role'),
  active: (u) => { const a = pick(u, 'active'); return a === undefined ? true : !!Number(a) || a === true; },
  created: (u) => pick(u, 'createdAt', 'created_at'),
  lastLogin: (u) => pick(u, 'lastLoginAt', 'last_login_at'),
};

export default {
  id: 'users',
  title: 'Users',
  permission: 'users:manage',
  icon: 'users',
  async render(el, ctx) {
    el.append(pageHeader({ title: 'Users', subtitle: 'Dashboard accounts and roles. Deactivated accounts cannot sign in; their history stays in the audit log.' }));
    const listBox = h('div', { 'aria-live': 'polite' }, loadingBlock('Loading users…'));
    el.append(card('Accounts', listBox), createCard(), card('Roles', h('ul', null, Object.values(ROLES).map((r) => h('li', null, h('strong', null, r.label), ` — ${r.desc}`)))));

    async function patch(u, body, success) {
      await ctx.api(`/users/${encodeURIComponent(U.id(u))}`, { method: 'PATCH', json: body });
      ctx.toast(success, 'success');
      await load();
    }

    function roleControl(u) {
      const self = String(U.id(u)) === String(ctx.user.id);
      const sel = h('select', { 'aria-label': `Role for ${U.username(u)}`, disabled: self || null }, Object.entries(ROLES).map(([v, r]) => h('option', { value: v }, r.label)));
      sel.value = U.role(u);
      const btn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: true, 'aria-label': `Save role for ${U.username(u)}` }, 'Save role');
      sel.addEventListener('change', () => { btn.disabled = sel.value === U.role(u); });
      btn.addEventListener('click', async () => {
        const { confirmed, reason } = await ctx.confirmDialog({
          title: `Change role for ${U.username(u)}?`,
          body: `${ROLES[U.role(u)]?.label || U.role(u)} → ${ROLES[sel.value].label}. ${ROLES[sel.value].desc}`,
          confirmLabel: 'Change role', requireReason: true,
        });
        if (!confirmed) { sel.value = U.role(u); btn.disabled = true; return; }
        try { await withBusy(btn, () => patch(u, { role: sel.value, reason }, `${U.username(u)} is now ${ROLES[sel.value].label.toLowerCase()}.`)); }
        catch (err) { ctx.toast(`Could not change role: ${err.message}`, 'error'); }
      });
      return h('div', { class: 'inline-control' }, sel, btn, self ? h('span', { class: 'hint', style: 'display:block' }, 'You cannot change your own role.') : null);
    }

    function activeControl(u) {
      const self = String(U.id(u)) === String(ctx.user.id);
      if (self) return h('span', { class: 'hint' }, 'This is you');
      const active = U.active(u);
      return h('button', {
        type: 'button', class: `btn ${active ? 'btn-danger-outline' : 'btn-secondary'} btn-sm`, 'aria-label': `${active ? 'Deactivate' : 'Reactivate'} ${U.username(u)}`,
        onClick: async (e) => {
          const btn = e.currentTarget;
          const { confirmed, reason } = await ctx.confirmDialog({
            title: `${active ? 'Deactivate' : 'Reactivate'} ${U.username(u)}?`,
            body: active ? 'They will be signed out and unable to sign in. Their audit history is kept.' : 'They will be able to sign in again with their existing password.',
            confirmLabel: active ? 'Deactivate' : 'Reactivate', requireReason: true, danger: active,
          });
          if (!confirmed) return;
          try { await withBusy(btn, () => patch(u, { active: !active, reason }, `${U.username(u)} ${active ? 'deactivated' : 'reactivated'}.`)); }
          catch (err) { ctx.toast(`Could not update ${U.username(u)}: ${err.message}`, 'error'); }
        },
      }, active ? 'Deactivate' : 'Reactivate');
    }

    async function load() {
      let data;
      try { data = await ctx.api('/users'); } catch (err) { listBox.replaceChildren(errorBlock(err, load)); return; }
      if (!ctx.isCurrent()) return;
      const users = listOf(data, 'users');
      listBox.replaceChildren(dataTable({
        caption: `Dashboard users (${users.length})`,
        rowAttrs: (u) => ({ class: U.active(u) ? null : 'muted' }),
        columns: [
          { key: 'username', label: 'Username', rowHeader: true, render: (u) => h('span', null, h('span', { class: 'mono' }, U.username(u)), U.name(u) ? h('span', { class: 'small muted', style: 'display:block', dir: 'auto' }, U.name(u)) : null) },
          { key: 'role', label: 'Role', render: (u) => roleControl(u) },
          { key: 'active', label: 'Status', render: (u) => (U.active(u) ? badge('Active', 'success') : badge('Deactivated', 'unknown')) },
          { key: 'last', label: 'Last sign-in', render: (u) => (U.lastLogin(u) ? ctx.formatDate(U.lastLogin(u)) : h('span', { class: 'np' }, 'Never')) },
          { key: 'created', label: 'Created', render: (u) => ctx.formatDate(U.created(u)) },
          { key: 'act', label: 'Access', className: 'actions', render: (u) => activeControl(u) },
        ],
        rows: users,
        empty: 'No users.',
      }));
    }

    function createCard() {
      const fUser = formField({ label: 'Username', name: 'username', required: true, hint: '3–50 letters, digits, dot, dash or underscore.', attrs: { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '50', pattern: '[A-Za-z0-9._-]{3,50}' } });
      const fName = formField({ label: 'Display name', name: 'displayName', attrs: { maxlength: '100', autocomplete: 'off' }, dir: 'auto' });
      const fRole = formField({ label: 'Role', name: 'role', type: 'select', required: true, value: 'editor', options: Object.entries(ROLES).map(([value, r]) => ({ value, label: r.label })) });
      const fPw = formField({ label: 'Password', name: 'password', type: 'password', required: true, hint: 'At least 12 characters. Share it with the person securely; they should change it.', attrs: { autocomplete: 'new-password', minlength: '12', maxlength: '200' } });
      const fPw2 = formField({ label: 'Repeat password', name: 'password2', type: 'password', required: true, attrs: { autocomplete: 'new-password', maxlength: '200' } });
      const form = h('form', { novalidate: true, 'aria-label': 'Create user' },
        h('div', { class: 'form-grid' }, fUser, fName, fRole, fPw, fPw2),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create user')));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearFormErrors(form);
        const username = fUser.control.value.trim();
        const pw = fPw.control.value;
        let bad = false;
        if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) { setFieldError(fUser.control, 'Use 3–50 letters, digits, dot, dash or underscore.'); bad = true; }
        if (pw.length < 12) { setFieldError(fPw.control, `The password must be at least 12 characters (currently ${pw.length}).`); bad = true; }
        if (pw !== fPw2.control.value) { setFieldError(fPw2.control, 'The passwords do not match.'); bad = true; }
        if (bad) { showFormError(form, 'Check the highlighted fields.', { focus: false }); form.querySelector('[aria-invalid="true"]')?.focus(); return; }
        const btn = form.querySelector('button[type=submit]');
        try {
          await withBusy(btn, () => ctx.api('/users', { method: 'POST', json: { username, displayName: fName.control.value.trim() || null, role: fRole.control.value, password: pw } }), 'Creating…');
          ctx.toast(`User ${username} created as ${ROLES[fRole.control.value].label.toLowerCase()}.`, 'success');
          form.reset();
          fRole.control.value = 'editor';
          await load();
        } catch (err) { showFormError(form, err); }
        finally { fPw.control.value = ''; fPw2.control.value = ''; }
      });
      return card('Create a user', notice('info', h('p', null, 'Give each person their own account and the smallest role they need. Every action is recorded against their username.')), form);
    }

    await load();
  },
};
