// Night Ops v1.4 (PAGE-RENDER): the end screen's keep row (in over.js's div.over-keep-slot), for games without
// the camera (with the camera the clips card has the same button). Says where a kept game goes: Your games.
//   keepRow({ app }) -> { el, update(view) }
import { h, text } from '../dom.js?v=148';
import { icon } from '../ui/icons.js?v=148';
import { keptWords } from './camparts.js?v=148';

export const KEEP_WHERE = "Kept on Night Ops' server for 30 days. Open it any time from Your games on the home screen. Downloads save to your phone (iPhone: the Files app, or Photos with Share > Save Video).";
export const GOES_WHERE = 'Not kept: it goes a day after the game. Open it from Your games on the home screen until then.';

export function keepRow({ app }) {
  const line = h('p.keep-row-line');
  const where = h('p.keep-row-where.home-hint', KEEP_WHERE);
  const btn = h('button.btn.ghost.wide.keep-row-btn', { type: 'button' }, icon('pin', 20), h('span', 'Keep this game'));
  const el = h('section.keep-row', { hidden: true, 'aria-label': 'Keep this game' }, line, btn, where);
  const S = { view: null, kept: null, busy: false };
  btn.addEventListener('click', async () => {
    if (S.busy) return;
    S.busy = true; btn.disabled = true;
    try {
      const r = await app.video('cam-keep', { keep: !Number.isFinite(S.kept) });
      S.kept = Number.isFinite(r && r.kept) ? r.kept : null;
      if (r && Array.isArray(r.released) && r.released.length) app.banner(`Game ${r.released.join(', ')} isn't kept any more, to make room.`, 'info', 6000);
    } catch (e) {
      app.banner(e && e.message ? e.message : "That didn't work. Try again.", 'warn', 5000);
    }
    S.busy = false; btn.disabled = false;
    paint();
  });
  function paint() {
    const v = S.view;
    const show = !!(v && v.phase === 'over' && !v.cam && !v.past && !v.watcher);
    el.hidden = !show;
    if (!show) return;
    const host = !!(v.me && v.me.host);
    const kept = Number.isFinite(S.kept);
    btn.hidden = !host;
    text(btn.querySelector('span'), kept ? "Don't keep it" : 'Keep this game');
    text(line, kept ? keptWords(S.kept) : (host ? 'Keep the replay and the map for later?' : ''));
    line.hidden = !kept && !host;
    text(where, kept || host ? KEEP_WHERE : GOES_WHERE);
  }
  return {
    el,
    update(view) {
      S.view = view;
      if (view && !S.busy) S.kept = Number.isFinite(view.kept) ? view.kept : (view.cam && Number.isFinite(view.cam.kept) ? view.cam.kept : S.kept);
      paint();
    },
  };
}
