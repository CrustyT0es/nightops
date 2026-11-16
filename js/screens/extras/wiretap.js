// Night Ops: the lobby's Wiretap row (v1.4, PAGE-PLAY). Shown only while the host has the Wiretap power on.
//   extraRow(ctx) -> { el, update(view) }   ctx = { app, host, setSetting(key, value), cmd(cmd) }
// Everyone: "I'm OK with Wiretap" (asks for the microphone once), and who has said OK.
import { h, text } from '../../dom.js?v=147';
import { icon } from '../../ui/icons.js?v=147';

export const TAP_LINE = "Hunters can hear 15 seconds of your microphone, once a game. You'll see a red dot while it listens.";
export const OK_LABEL = "I'm OK with Wiretap";
export const OK_DONE = "You said OK. Tap to take it back.";
export const NOT_YET = 'Only hiders who say OK can be listened to.';

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

export const wiretapOn = (view) => {
  const pw = view && view.settings && view.settings.powers;
  if (pw && typeof pw.wiretap === 'boolean') return pw.wiretap; // the host's pick, also before it's saved
  return !!(view && view.tapOk && view.tapOk.on);
};
export const saidOk = (view) => !!(view && view.tapOk && view.tapOk.ok);
export function okNames(view) {
  const ids = (view && view.tapOk && Array.isArray(view.tapOk.okIds)) ? view.tapOk.okIds : [];
  return ((view && view.players) || []).filter((p) => p && ids.includes(p.id)).map((p) => String(p.name || 'Someone'));
}
export function okLine(view) {
  const names = okNames(view);
  if (!names.length) return NOT_YET;
  return `Said OK: ${names.join(', ')}.`;
}

// ---- the row ----------------------------------------------------------------------------------------------

export function extraRow(ctx = {}) {
  const app = ctx.app;
  const btnWords = h('span', OK_LABEL);
  const btn = h('button.btn.wide.x-wt-ok', { type: 'button', 'aria-pressed': 'false' }, icon('mic', 20), btnWords);
  const who = h('p.x-wt-who', NOT_YET);
  const el = h('div.x-row.x-wt', { hidden: true, 'data-key': 'wiretap' },
    h('div.lobby-set-label.x-wt-label', icon('mic', 20), h('span', 'Wiretap')),
    h('p.x-wt-note', TAP_LINE), btn, who);
  let busy = false;
  let now = false;

  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.setAttribute('aria-disabled', 'true');
    const next = !now;
    try {
      if (next && app && typeof app.mic === 'function') {
        // Asked once now (from this tap), so the hider's phone can record later without a prompt.
        try {
          const m = await app.mic();
          if (m && !m.shared && m.stream) for (const t of m.stream.getTracks()) t.stop();
        } catch (e) { console.error(e); }
      }
      await (ctx.cmd ? ctx.cmd({ type: 'tapok', ok: next }) : null);
    } finally {
      busy = false;
      btn.removeAttribute('aria-disabled');
    }
  });

  function update(v) {
    if (!v) return;
    el.hidden = !wiretapOn(v);
    now = saidOk(v);
    btn.setAttribute('aria-pressed', now ? 'true' : 'false');
    btn.classList.toggle('on', now);
    text(btnWords, now ? OK_DONE : OK_LABEL);
    text(who, okLine(v));
  }

  return { el, update };
}
