// Night Ops v1.6.2: the 3D mystery chest, one model everywhere (the opening, the map, the fly-in, Static's show).
// chest(size) -> element. size: 'map' (on the map, ~44 px), 'fly' (flying into your phone), 'show' (the show's
// scenes), or nothing (the opening's own, full size). A base and a hinged lid, each six shaded faces with gold trim,
// a "?" lock; it turns slowly. Its styles are css/loot.css (.mc-*, .chest).
import { h } from './dom.js?v=181';

export function chestModel() {
  const prism = (cls, kids = {}) => h(`div.mc-${cls}`, ...['front', 'back', 'left', 'right', 'top', 'bottom']
    .map((k) => h(`span.mc-f.mc-${k}`, h('i.mc-trim'), kids[k] || null)));
  return h('div.mc-spin',
    prism('base', { front: h('b.mc-lock', '?') }),
    h('div.mc-hinge', prism('lid', { top: h('i.mc-band') })),
    h('div.mc-light'));
}

export function chest(size = '') {
  return h(`div.chest${size ? `.chest-${size}` : ''}`, { 'aria-hidden': 'true' }, h('div.chest-scale', chestModel()));
}
