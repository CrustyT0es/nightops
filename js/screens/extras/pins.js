// Night Ops: the lobby's "Team pins" row (v1.4, PAGE-PLAY).
//   extraRow(ctx) -> { el, update(view) }   ctx = { app, host, setSetting(key, value), cmd(cmd) }
// The host: the switch (on by default). Not the host: the setting in words.
import { h, text } from '../../dom.js?v=179';
import { icon } from '../../ui/icons.js?v=179';
import { EXTRAS_UI } from '../../../shared/rules.js?v=179';

const ITEM = EXTRAS_UI.find((x) => x.key === 'pins') || {
  key: 'pins', label: 'Team pins', hint: 'Hunters and the driver can drop pins only their team sees.',
};
export const ON_LINE = 'Hunters can drop pins on the map: Hider seen, Go here, Driver: go here. Hiders never see them.';
export const OFF_LINE = 'No team pins this game.';
export const QUIET_LINE = 'A pin lasts 5 minutes. 3 at a time each.';

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

export const pinsOn = (view) => !!(view && view.settings && view.settings.pins !== false);
export const pinsLine = (view) => (pinsOn(view) ? ON_LINE : OFF_LINE);

// ---- the row ----------------------------------------------------------------------------------------------

export function extraRow(ctx = {}) {
  const host = !!ctx.host;
  const label = h('div.lobby-set-label.x-pin-label', icon('pin', 20), h('span', ITEM.label));
  let control;
  let sw = null;
  const line = h('p.x-pin-line', OFF_LINE);
  const quiet = h('p.x-pin-note.x-pin-quiet', { hidden: true }, QUIET_LINE);
  if (host) {
    sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': ITEM.label });
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      paint(on);
      try { ctx.setSetting && ctx.setSetting('pins', on); } catch (e) { console.error(e); }
    });
    control = sw;
  } else {
    control = h('span.lobby-set-value', 'Off');
  }
  const head = h('div.lobby-set.row.x-pin-head', { 'data-key': 'pins', 'data-anchor': '' }, label, control);
  const el = h('div.x-row.x-pin', head, h('p.x-pin-note', ITEM.hint), line, quiet);

  function paint(on) {
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    else text(control, on ? 'On' : 'Off');
    text(line, on ? ON_LINE : OFF_LINE);
    line.classList.toggle('on', on);
    quiet.hidden = !on;
  }

  function update(v) {
    if (!v) return;
    paint(pinsOn(v));
  }

  return { el, update };
}
