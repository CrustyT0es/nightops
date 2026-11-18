// Night Ops: the lobby's "Walkie-talkie for hiders too" row (v1.2, PAGE-RADIO).
//   extraRow(ctx) -> { el, update(view) }   ctx = { app, host, setSetting(key, value), cmd(cmd) }
// The host: the switch (off by default). Everyone, when it's on: "Hiders have their own walkie-talkie. Hunters
// never hear it." Not the host: the setting in words.
import { h, text } from '../../dom.js?v=150';
import { icon } from '../../ui/icons.js?v=150';
import { EXTRAS_UI } from '../../../shared/rules.js?v=150';

const ITEM = EXTRAS_UI.find((x) => x.key === 'radioHiders') || {
  key: 'radioHiders', label: 'Walkie-talkie for hiders too', hint: 'Hiders get their own walkie-talkie. Each team only hears its own.',
};
export const ON_LINE = 'Hiders have their own walkie-talkie. Hunters never hear it.';
export const OFF_LINE = 'Only hunters have a walkie-talkie.';
export const QUIET_LINE = 'Hiders can turn on Quiet: messages wait until they tap Play.';

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

export const hidersRadio = (view) => !!(view && view.settings && view.settings.radioHiders);
export const hidersLine = (view) => (hidersRadio(view) ? ON_LINE : OFF_LINE);

// ---- the row ----------------------------------------------------------------------------------------------

export function extraRow(ctx = {}) {
  const host = !!ctx.host;
  const label = h('div.lobby-set-label.x-rh-label', icon('mic', 20), h('span', ITEM.label));
  let control;
  let sw = null;
  const line = h('p.x-rh-line', OFF_LINE);
  const quiet = h('p.x-rh-note.x-rh-quiet', { hidden: true }, QUIET_LINE);
  if (host) {
    sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': ITEM.label });
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      paint(on);
      try { ctx.setSetting && ctx.setSetting('radioHiders', on); } catch (e) { console.error(e); }
    });
    control = sw;
  } else {
    control = h('span.lobby-set-value', 'Off');
  }
  const head = h('div.lobby-set.row.x-rh-head', { 'data-key': 'radioHiders', 'data-anchor': '' }, label, control);
  const el = h('div.x-row.x-rh', head, h('p.x-rh-note', ITEM.hint), line, quiet);

  function paint(on) {
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    else text(control, on ? 'On' : 'Off');
    text(line, on ? ON_LINE : OFF_LINE);
    line.classList.toggle('on', on);
    quiet.hidden = !on;
  }

  function update(v) {
    if (!v) return;
    paint(hidersRadio(v));
  }

  return { el, update };
}
