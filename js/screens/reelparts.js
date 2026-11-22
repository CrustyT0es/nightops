// Night Ops v1.4 (PAGE-REEL): the end screen's parts for the reel. over.js calls these from its marked blocks.
//
//   moviesCard({ app, onWatch(kind), onDownload(kind, reel), onReplay }) -> { el, set({ summary, clips, ring }), reel(kind) }
//   callMini(call, { summary, faces, onWatch, onShow }) -> element | null   a close call's still mini map + buttons
//   followRow({ players, faces, onPick }) -> { el, set(players, following) }
//   loadFaces(app) -> Map id -> HTMLImageElement (for canvases)
import { h, fill, text, face } from '../dom.js?v=157';
import { icon } from '../ui/icons.js?v=157';
import { scenes, miniMap } from '../scenes.js?v=157';
import { drawMiniMap } from '../movie.js?v=157';
import { fmtClock } from '../../shared/rules.js?v=157';

const imgCache = new Map(); // data URL -> img
export function loadFaces(app) {
  const out = new Map();
  const src = app && app.faces instanceof Map ? app.faces : new Map();
  for (const [id, url] of src) {
    if (typeof url !== 'string' || !url) continue;
    let img = imgCache.get(url);
    if (!img) { img = new Image(); img.decoding = 'async'; img.src = url; imgCache.set(url, img); }
    out.set(id, img);
  }
  return out;
}

export function lengthWords(ms) {
  return fmtClock(Math.max(0, Math.round(ms / 1000) * 1000));
}

export function moviesCard({ onWatch = () => {}, onDownload = () => {}, onReplay = null } = {}) {
  const reels = { highlights: null, whole: null };
  let sig = '';
  const row = (kind, name) => {
    const sub = h('span.over-movie-sub');
    const watch = h('button.btn.small.primary.over-movie-watch', { type: 'button', 'data-kind': kind }, icon('play', 16), h('span', 'Watch'));
    const down = h('button.btn.small.ghost.over-movie-down', { type: 'button', 'data-kind': kind, 'aria-label': `Download ${name}` }, h('span', 'Download'));
    watch.addEventListener('click', () => onWatch(kind, reels[kind]));
    down.addEventListener('click', () => onDownload(kind, reels[kind]));
    const el = h(`div.over-movie-row.k-${kind}`, h('div.over-movie-words', h('span.over-movie-name', name), sub), watch, down);
    return { el, sub };
  };
  const hi = row('highlights', 'Highlights');
  const wh = row('whole', 'The whole game');
  const replayBtn = onReplay
    ? h('button.btn.small.ghost.over-movie-replay', { type: 'button' }, icon('locate', 16), h('span', 'Replay map'))
    : null;
  if (replayBtn) replayBtn.addEventListener('click', () => onReplay());
  // v1.5: the PC's edit goes first in the card (setPro), and a summary-less round still shows it
  const proSlot = h('div.over-pro-slot', { hidden: true });
  let hasPro = false;
  const el = h('section.over-card.over-movies-card', { 'aria-labelledby': 'over-movies-title', hidden: true },
    h('div.over-card-head', h('h2#over-movies-title.label', 'Movies')),
    proSlot,
    h('div.over-movies', hi.el, wh.el, replayBtn));
  return {
    el,
    proSlot,
    setPro(node) {
      hasPro = !!node;
      fill(proSlot, node || []);
      proSlot.hidden = !node;
      if (node) el.hidden = false;
    },
    set({ summary, clips }) {
      if (!summary || !Number.isFinite(summary.endClock)) { el.hidden = !hasPro; return; }
      const s = `${summary.endClock}|${(clips || []).length}|${(clips || []).map((c) => c.id).join(',').length}|${(summary.radio || []).length}`;
      el.hidden = false;
      if (s === sig) return;
      sig = s;
      try {
        reels.highlights = scenes({ summary, clips, kind: 'highlights' });
        reels.whole = scenes({ summary, clips, kind: 'whole' });
      } catch (e) {
        console.error(e);
        el.hidden = true;
        return;
      }
      text(hi.sub, `${lengthWords(reels.highlights.ms)}, the best moments`);
      text(wh.sub, `${lengthWords(reels.whole.ms)}, start to end`);
    },
    reel: (kind) => reels[kind],
  };
}

export function callMini(call, { summary, faces, onWatch, onShow } = {}) {
  if (!call || !call.track || !call.gap) return null;
  const size = 112;
  const canvas = h('canvas', { width: String(size * 2), height: String(size * 2), role: 'img',
    'aria-label': `Map of the close call: ${Math.round(call.gap.m)} m at the closest` });
  const mm = miniMap(call, { w: size * 2, h: size * 2 });
  const draw = () => {
    try {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawMiniMap(ctx, mm, { still: true, faces, summary });
    } catch { /* a canvas-less test page */ }
  };
  draw();
  // faces arrive later: draw again once they've loaded
  if (faces) for (const img of faces.values()) if (img && !img.complete && img.addEventListener) img.addEventListener('load', draw, { once: true });
  const watch = h('button.btn.small.primary.cc-watch', { type: 'button' }, icon('play', 16), h('span', 'Watch'));
  watch.addEventListener('click', () => onWatch && onWatch(call));
  const show = onShow ? h('button.btn.small.ghost.cc-show', { type: 'button' }, h('span', 'Replay map')) : null;
  if (show) show.addEventListener('click', () => onShow(call));
  return h('div.cc-mini', canvas, h('div.cc-mini-acts', watch, show));
}

export function followRow({ onPick = () => {} } = {}) {
  const el = h('div.mapcam-follow', { role: 'group', 'aria-label': 'Follow someone', hidden: true });
  let list = [];
  let faces = () => new Map();
  const set = (players, following, meId = null, facesFn = null) => {
    if (facesFn) faces = facesFn;
    list = (players || []).slice().sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : 0));
    fill(el, list.map((p) => {
      const on = following === p.id;
      const b = h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false' },
        face({ name: p.name, src: faces().get(p.id) || null, team: p.startTeam || null, size: 34 }),
        h('span', p.id === meId ? 'Follow me' : p.name));
      b.addEventListener('click', () => onPick(on ? null : p.id));
      return b;
    }));
  };
  return { el, set };
}
