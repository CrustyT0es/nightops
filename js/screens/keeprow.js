// Night Ops v1.4 (PAGE-RENDER): the end screen's keep row (in over.js's div.over-keep-slot). v1.5.2: every finished
// round is saved on Night Ops' server for 30 days by itself (no Keep button), so the row is one line saying so and
// where to find it again: Your games on the home screen. Shown on every end screen (players and spectators, with
// the camera or not), never on a past game opened from Your games (the home list says its date there).
//   keepRow({ app }) -> { el, update(view) }
import { h } from '../dom.js?v=157';

export const SAVED_LINE = 'Saved for 30 days. Open it any time from Your games on the home screen.';

export function keepRow() {
  const el = h('section.keep-row', { hidden: true, 'aria-label': 'Saved' }, h('p.keep-row-line', SAVED_LINE));
  return {
    el,
    update(view) {
      el.hidden = !(view && view.phase === 'over' && !view.past);
    },
  };
}
