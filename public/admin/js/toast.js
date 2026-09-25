// Toast notifications. Success/info go to a polite live region; errors to an assertive one.
//   toast('Saved', 'success');  toast('Could not save: …', 'error');
import { h } from './ui.js';

let polite;
let assertive;

function regions() {
  if (!polite) {
    const host = h('div', { class: 'toasts' });
    polite = h('div', { class: 'toast-stack', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    assertive = h('div', { class: 'toast-stack', 'aria-live': 'assertive', 'aria-relevant': 'additions' });
    host.append(polite, assertive);
    document.body.appendChild(host);
  }
  return { polite, assertive };
}

export function toast(message, type = 'info') {
  const { polite: p, assertive: a } = regions();
  const tone = ['success', 'error', 'info', 'warn'].includes(type) ? type : 'info';
  const label = { success: 'Done', error: 'Error', info: 'Note', warn: 'Warning' }[tone];
  const item = h('div', { class: `toast toast-${tone}` },
    h('p', { class: 'toast-msg' }, h('strong', null, `${label}: `), String(message ?? '')),
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss notification', onClick: () => item.remove() }, '×'));
  (tone === 'error' ? a : p).appendChild(item);
  // Keep at most three visible; the oldest go first.
  const all = [...p.children, ...a.children];
  for (const old of all.slice(0, Math.max(0, all.length - 3))) if (old !== item) old.remove();
  const ms = tone === 'error' ? 12000 : 6000;
  let timer = setTimeout(() => item.remove(), ms);
  item.addEventListener('mouseenter', () => clearTimeout(timer));
  item.addEventListener('focusin', () => clearTimeout(timer));
  item.addEventListener('mouseleave', () => { timer = setTimeout(() => item.remove(), ms); });
  return item;
}
