// Tiny stroke icon set (24×24). Decorative: always aria-hidden.
const PATHS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  droplet: 'M12 2.8s-6.5 7.1-6.5 11.4a6.5 6.5 0 0 0 13 0C18.5 9.9 12 2.8 12 2.8z',
  alert: 'M12 7.5v6M12 16.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  map: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zm0 0v14m6-12v14',
  upload: 'M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  copy: 'M9 9h11v11H9zM5 15H4V5a1 1 0 0 1 1-1h10v1',
  users: 'M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.9M15.5 4.1a3.5 3.5 0 0 1 0 6.8',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  flag: 'M5 21V4m0 0h12l-2.5 4L17 12H5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z',
  scale: 'M12 4v16M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zm14 0l-3 6a3 3 0 0 0 6 0zM8 20h8',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3l-4.3-4.3',
  signout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l4-4-4-4M14 12H4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  pin: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  dot: 'M12 12h.01',
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 20, className = 'icon' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', PATHS[name] || PATHS.dot);
  svg.appendChild(path);
  return svg;
}
