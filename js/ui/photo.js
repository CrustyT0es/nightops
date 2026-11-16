// Night Ops v1.3 (PAGE-PLAY): a photo shown big in a sheet.
//   openPhoto({ src, title, line, actions }) -> sheet ({ el, body, close() })
//     The picture fills the sheet's width (at most 70% of the screen's height), its alt text the title; `line` a
//     sentence under it; `actions` as openSheet's (the host's "Don't count", for one). No src: "No photo yet."
import { h } from '../dom.js?v=147';
import { openSheet } from './sheet.js?v=147';

export function openPhoto({ src = '', title = 'Photo', line = '', actions = [] } = {}) {
  const ok = typeof src === 'string' && /^(data:image\/|blob:)/.test(src);
  const pic = ok
    ? h('img.photo-big', { src, alt: String(title || 'Photo'), draggable: 'false' })
    : h('p.photo-none', 'No photo yet.');
  const body = h('div.photo-wrap', h('div.photo-frame', pic), line ? h('p.photo-line', String(line)) : null);
  return openSheet({ title: String(title || 'Photo'), body, actions, className: 'photo-sheet' });
}
