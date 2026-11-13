// Night Ops: the lobby's "Save the walkie-talkie for the replay" row (v1.1, PAGE-RADIO).
//   extraRow(ctx) -> { el, update(view) }   ctx = { app, host, setSetting(key, value), cmd(cmd) }
// The host: the switch. Everyone, when it's on: "The hunters' walkie-talkie is saved for the end-of-game replay."
// Not the host: the setting in words.
import { h, text } from '../../dom.js';
import { icon } from '../../ui/icons.js';
import { EXTRAS_UI } from '../../../shared/rules.js';

const ITEM = EXTRAS_UI.find((x) => x.key === 'radioSave') || {
  key: 'radioSave', label: 'Save the walkie-talkie for the replay', hint: "The hunters' walkie-talkie is saved for the end-of-game replay.",
};
export const SAVED_LINE = "The hunters' walkie-talkie is saved for the end-of-game replay.";
export const NOT_SAVED_LINE = "The hunters' walkie-talkie isn't saved. Clips are deleted when the game ends.";

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

export function radioSaved(view) {
  const s = view && view.settings;
  return !(s && s.radioSave === false);
}

export function radioLine(view) {
  return radioSaved(view) ? SAVED_LINE : NOT_SAVED_LINE;
}

// ---- the row ----------------------------------------------------------------------------------------------

export function extraRow(ctx = {}) {
  const host = !!ctx.host;
  const label = h('div.lobby-set-label.x-radio-label', icon('mic', 20), h('span', ITEM.label));
  let control;
  let sw = null;
  if (host) {
    sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'true', 'aria-label': ITEM.label });
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      line.textContent = on ? SAVED_LINE : NOT_SAVED_LINE;
      try { ctx.setSetting && ctx.setSetting('radioSave', on); } catch (e) { console.error(e); }
    });
    control = sw;
  } else {
    control = h('span.lobby-set-value');
  }
  const line = h('p.x-radio-line', SAVED_LINE);
  const head = h('div.lobby-set.row.x-radio-head', { 'data-key': 'radioSave', 'data-anchor': '' }, label, control);
  const el = h('div.x-row.x-radio', head,
    h('p.x-radio-note', 'Hunters hold a button to talk to each other. Hiders never hear it.'),
    line);

  function update(v) {
    if (!v) return;
    const on = radioSaved(v);
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    else text(control, on ? 'Saved' : 'Not saved');
    text(line, on ? SAVED_LINE : NOT_SAVED_LINE);
    line.classList.toggle('on', on);
  }

  return { el, update };
}
