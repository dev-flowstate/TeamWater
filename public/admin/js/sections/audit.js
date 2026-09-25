// Audit log: filter by entity type, id, actor and action; paginated; expandable before/after diffs.
import { h, pick, listOf, pageHeader, card, formField, pager, loadingBlock, errorBlock, formatNumber } from '../ui.js';
import { auditTable } from '../audit-view.js';

const ENTITY_TYPES = ['plant', 'area', 'water_test', 'import_batch', 'duplicate', 'admin_user', 'report', 'reporter', 'rating', 'appeal', 'investigation', 'photo', 'export', 'maintenance'];
const ACTIONS = ['plant.*', 'plant.update', 'plant.create', 'plant.coordinates.set', 'plant.coordinates.clear', 'plant.status', 'plant.verify', 'plant.test.create', 'plant.test.delete', 'plant.source.add', 'area.update', 'import.*', 'import.upload', 'import.commit', 'import.cancel', 'duplicate.*', 'admin.login', 'admin_user.*', 'report.*', 'contact.reveal', 'export.*'];

export default {
  id: 'audit',
  title: 'Audit log',
  permission: 'audit:read',
  icon: 'list',
  async render(el, ctx) {
    const q = ctx.query || {};
    const st = { entityType: q.entityType || '', entityId: q.entityId || '', actor: q.actor || '', action: q.action || '', page: Math.max(1, parseInt(q.page, 10) || 1) };
    el.append(pageHeader({ title: 'Audit log', subtitle: 'Every administrative change, who made it, when, and why. Contact details are never stored here.' }));

    const listId = (id, values) => h('datalist', { id }, values.map((v) => h('option', { value: v })));
    const fType = formField({ label: 'Entity type', name: 'entityType', value: st.entityType, hint: 'e.g. plant, area, import_batch', attrs: { list: 'audit-types', autocomplete: 'off' } });
    const fId = formField({ label: 'Entity ID', name: 'entityId', value: st.entityId, hint: 'Exact, e.g. FSD-WFP-0001', attrs: { autocomplete: 'off' } });
    const fActor = formField({ label: 'Actor (username)', name: 'actor', value: st.actor, hint: 'Exact username, e.g. admin or setup', attrs: { autocomplete: 'off' } });
    const fAction = formField({ label: 'Action', name: 'action', value: st.action, hint: 'Exact, or end with * for a prefix (plant.*)', attrs: { list: 'audit-actions', autocomplete: 'off' } });
    const form = h('form', { class: 'toolbar', role: 'search', 'aria-label': 'Filter audit log' },
      fType, fId, fActor, fAction, listId('audit-types', ENTITY_TYPES), listId('audit-actions', ACTIONS),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Filter'),
      h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => { for (const f of [fType, fId, fActor, fAction]) f.control.value = ''; submit(); } }, 'Clear'));
    const status = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    const box = h('div');
    el.append(form, status, card(null, box));

    function submit() {
      st.entityType = fType.control.value.trim();
      st.entityId = fId.control.value.trim();
      st.actor = fActor.control.value.trim();
      st.action = fAction.control.value.trim();
      st.page = 1;
      load();
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

    let seq = 0;
    async function load() {
      const mine = ++seq;
      ctx.setQuery({ entityType: st.entityType, entityId: st.entityId, actor: st.actor, action: st.action, page: st.page > 1 ? st.page : '' });
      box.setAttribute('aria-busy', 'true');
      if (!box.firstChild) box.append(loadingBlock('Loading audit entries…'));
      let data;
      try { data = await ctx.api('/audit', { query: { entityType: st.entityType, entityId: st.entityId, actor: st.actor, action: st.action, page: st.page } }); } catch (err) {
        if (mine !== seq) return;
        box.removeAttribute('aria-busy');
        box.replaceChildren(errorBlock(err, load));
        return;
      }
      if (mine !== seq || !ctx.isCurrent()) return;
      const items = listOf(data, 'entries');
      const total = Number(pick(data, 'total') ?? items.length);
      const pageSize = Number(pick(data, 'pageSize') || Math.max(items.length, 50));
      const page = Number(pick(data, 'page') || st.page);
      const filtered = st.entityType || st.entityId || st.actor || st.action;
      status.textContent = `${formatNumber(total)} entr${total === 1 ? 'y' : 'ies'}${filtered ? ' match the filters' : ''}.`;
      box.removeAttribute('aria-busy');
      box.replaceChildren(
        auditTable(items, { caption: `Audit entries — ${formatNumber(total)}${total > pageSize ? `, page ${page}` : ''}`, empty: filtered ? 'No entries match these filters.' : 'No audit entries yet.' }),
        pager({ page, pageSize, total, label: 'Audit log pages', onChange: (p) => { st.page = p; load(); el.querySelector('h1')?.scrollIntoView({ block: 'start' }); } }));
    }
    await load();
  },
};
