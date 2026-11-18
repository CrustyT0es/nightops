// Night Ops: the lobby's "Save the walkie-talkie for the replay" row (v1.1, PAGE-RADIO).
//   extraRow(ctx) -> { el, update(view) }   ctx = { app, host, setSetting(key, value), cmd(cmd) }
// The host: the switch. Everyone, when it's on: "The hunters' walkie-talkie is saved for the end-of-game replay."
// Not the host: the setting in words.
import { h, text } from '../../dom.js?v=152';
import { icon } from '../../ui/icons.js?v=152';
import { EXTRAS_UI } from '../../../shared/rules.js?v=152';

const ITEM = EXTRAS_UI.find((x) => x.key === 'radioSave') || {
  key: 'radioSave', label: 'Save the walkie-talkie for the replay', hint: "The hunters' walkie-talkie is saved for the end-of-game replay.",
};
export const SAVED_LINE = "The hunters' walkie-talkie is saved for the end-of-game replay.";
export const NOT_SAVED_LINE = "The hunters' walkie-talkie isn't saved. Clips are deleted when the game ends.";
// v1.2 PAGE-RADIO: with "Walkie-talkie for hiders too" on, the lines name both teams
export const SAVED_BOTH = "The walkie-talkie is saved for the end-of-game replay, both teams.";
export const NOT_SAVED_BOTH = "The walkie-talkie isn't saved. Both teams' clips are deleted when the game ends.";
export const NOTE = 'Hunters hold a button to talk to each other. Hiders never hear it.';
export const NOTE_BOTH = 'Each team holds a button to talk to its own side. The other team never hears it.';
export const bothTeams = (view) => !!(view && view.settings && view.settings.radioHiders);
// v1.2 end PAGE-RADIO

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

export function radioSaved(view) {
  const s = view && view.settings;
  return !(s && s.radioSave === false);
}

export function radioLine(view) {
  if (bothTeams(view)) return radioSaved(view) ? SAVED_BOTH : NOT_SAVED_BOTH; // v1.2 PAGE-RADIO
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
      line.textContent = radioLine({ settings: { radioSave: on, radioHiders: both } }); // v1.2 PAGE-RADIO
      try { ctx.setSetting && ctx.setSetting('radioSave', on); } catch (e) { console.error(e); }
    });
    control = sw;
  } else {
    control = h('span.lobby-set-value');
  }
  const line = h('p.x-radio-line', SAVED_LINE);
  const head = h('div.lobby-set.row.x-radio-head', { 'data-key': 'radioSave', 'data-anchor': '' }, label, control);
  const note = h('p.x-radio-note', NOTE); // v1.2 PAGE-RADIO: named, its words follow radioHiders
  let both = false;
  const el = h('div.x-row.x-radio', head, note, line);

  function update(v) {
    if (!v) return;
    const on = radioSaved(v);
    both = bothTeams(v); // v1.2 PAGE-RADIO
    text(note, both ? NOTE_BOTH : NOTE);
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    else text(control, on ? 'Saved' : 'Not saved');
    text(line, radioLine(v));
    line.classList.toggle('on', on);
  }

  return { el, update };
}
