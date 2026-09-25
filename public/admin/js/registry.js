// Section registry: ordered [hash pattern, lazy loader, nav metadata?].
// The first matching pattern wins; `:name` segments become ctx.params.name (URI-decoded).
// Nav metadata is only used to draw the sidebar before a module is loaded; once loaded, the module's own
// `permission` decides access (and hides the nav item if the user lacks it). Entries without `nav` metadata
// are detail pages reached from links. `parent` highlights a nav item for detail pages.
//
// Section module contract (every file under ./sections/):
//   export default { id, title, permission, icon?, render(container, ctx) → (cleanup fn | void | Promise) }
//   ctx = { api, download, user, permissions, can(permission), toast(message, 'info'|'success'|'error'),
//           navigate(hash), confirmDialog({ title, body, confirmLabel, requireReason, danger? }) → { confirmed, reason },
//           formatDate(iso), escapeHtml(s), params, query, setQuery(obj), isCurrent() }

export const routes = [
  ['#/overview', () => import('./sections/overview.js'), { nav: true, group: 'Data', title: 'Overview', permission: 'stats', icon: 'home' }],
  ['#/plants', () => import('./sections/plants.js'), { nav: true, group: 'Data', title: 'Plants', permission: 'plants:read', icon: 'droplet' }],
  ['#/plants/:code', () => import('./sections/plant-detail.js'), { parent: '#/plants' }],
  ['#/incomplete', () => import('./sections/incomplete.js'), { nav: true, group: 'Data', title: 'Incomplete records', permission: 'plants:read', icon: 'alert' }],
  ['#/areas', () => import('./sections/areas.js'), { nav: true, group: 'Data', title: 'Areas', permission: 'plants:read', icon: 'map' }],
  ['#/imports', () => import('./sections/imports.js'), { nav: true, group: 'Data', title: 'Imports', permission: 'imports', icon: 'upload' }],
  ['#/duplicates', () => import('./sections/duplicates.js'), { nav: true, group: 'Data', title: 'Duplicates', permission: 'duplicates', icon: 'copy' }],

  ['#/reports', () => import('./sections/moderation/reports.js'), { nav: true, group: 'Community', title: 'Reports', permission: 'reports:read', icon: 'flag' }],
  ['#/reports/:id', () => import('./sections/moderation/report-detail.js'), { parent: '#/reports' }],
  ['#/ratings', () => import('./sections/moderation/ratings.js'), { nav: true, group: 'Community', title: 'Ratings', permission: 'reports:moderate', icon: 'star' }],
  ['#/appeals', () => import('./sections/moderation/appeals.js'), { nav: true, group: 'Community', title: 'Appeals & corrections', permission: 'appeals', icon: 'scale' }],
  ['#/investigations', () => import('./sections/moderation/investigations.js'), { nav: true, group: 'Community', title: 'Investigations', permission: 'investigations', icon: 'search' }],
  ['#/reporters/:id', () => import('./sections/moderation/reporter.js'), { parent: '#/reports' }],

  ['#/users', () => import('./sections/users.js'), { nav: true, group: 'Administration', title: 'Users', permission: 'users:manage', icon: 'users' }],
  ['#/audit', () => import('./sections/audit.js'), { nav: true, group: 'Administration', title: 'Audit log', permission: 'audit:read', icon: 'list' }],
  ['#/exports', () => import('./sections/exports.js'), { nav: true, group: 'Administration', title: 'Exports', permission: ['export:plants', 'export:reports'], icon: 'download' }],
];

export const DEFAULT_ROUTE = '#/overview';
