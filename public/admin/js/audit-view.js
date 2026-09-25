// Audit entries table with expandable before/after diffs (used by the audit log and plant detail).
import { h, pick, maybeJson, dataTable, diffTable, formatDate, redactPhones } from './ui.js';

export function auditFields(e) {
  let actor = pick(e, 'actorLabel', 'actor_label', 'actor', 'actorUsername', 'username');
  if (actor && typeof actor === 'object') actor = actor.username || actor.label || actor.displayName || JSON.stringify(actor);
  return {
    id: pick(e, 'id'),
    at: pick(e, 'createdAt', 'created_at', 'at', 'time'),
    actor: actor || 'system',
    action: pick(e, 'action') || '',
    entityType: pick(e, 'entityType', 'entity_type') || '',
    entityId: pick(e, 'entityId', 'entity_id'),
    reason: pick(e, 'reason'),
    before: maybeJson(pick(e, 'before', 'before_json', 'beforeJson')),
    after: maybeJson(pick(e, 'after', 'after_json', 'afterJson')),
  };
}

const hasContent = (v) => v !== null && v !== undefined && !(typeof v === 'object' && Object.keys(v).length === 0);

export function entityLink(type, id) {
  if (id === null || id === undefined || id === '') return h('span', null, type || '—');
  const label = `${type}:${id}`;
  if (type === 'plant' && /^[A-Za-z0-9_-]+$/.test(String(id))) return h('a', { href: `#/plants/${encodeURIComponent(id)}` }, label);
  if (type === 'report' && /^\d+$/.test(String(id))) return h('a', { href: `#/reports/${encodeURIComponent(id)}` }, label);
  if (type === 'reporter' && /^\d+$/.test(String(id))) return h('a', { href: `#/reporters/${encodeURIComponent(id)}` }, label);
  return h('span', { class: 'mono' }, label);
}

export function auditTable(entries, { caption = 'Audit entries', showEntity = true, empty = 'No audit entries.' } = {}) {
  const rows = entries.map(auditFields);
  const columns = [
    { key: 'at', label: 'When', render: (r) => h('span', { class: 'nowrap' }, formatDate(r.at)) },
    { key: 'actor', label: 'Who', render: (r) => h('span', { dir: 'auto' }, r.actor) },
    { key: 'action', label: 'Action', rowHeader: true, render: (r) => h('code', null, r.action) },
  ];
  if (showEntity) columns.push({ key: 'entity', label: 'Record', render: (r) => entityLink(r.entityType, r.entityId) });
  columns.push(
    { key: 'reason', label: 'Reason', render: (r) => (r.reason ? h('span', { dir: 'auto' }, redactPhones(r.reason)) : h('span', { class: 'np' }, '—')) },
    {
      key: 'changes', label: 'Changes', render: (r) => {
        if (!hasContent(r.before) && !hasContent(r.after)) return h('span', { class: 'np' }, 'No details');
        const keys = new Set([...Object.keys(r.before && typeof r.before === 'object' ? r.before : {}), ...Object.keys(r.after && typeof r.after === 'object' ? r.after : {})]);
        return h('details', { class: 'expander' },
          h('summary', null, `Show changes${keys.size ? ` (${keys.size} field${keys.size === 1 ? '' : 's'})` : ''}`),
          diffTable(r.before, r.after, { caption: `Changes for ${r.action}` }));
      },
    },
  );
  return h('div', { class: 'audit-list' }, dataTable({ caption, columns, rows, empty }));
}
