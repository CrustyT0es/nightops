// v1.4.4: the movie's street map. The reel's map panels (movie.js drawMap) and the close-call mini maps are drawn on
// a canvas with a web-mercator projection; under them goes a still picture of the street map (OpenFreeMap's dark
// style, the replay's own), made ONCE before playing or rendering by an offscreen MapLibre map and copied into a
// canvas. Each frame only drawImage()s it. No WebGL, no tiles, a slow network: no picture, and movie.js draws its
// grid as before. Nothing here may make the movie fail.
//
//   mercator([lng, lat]) -> [x, y] (world 0..1)      unmercator([x, y]) -> [lng, lat]
//   fitView(box, rect, pad) -> { k, cx, cy, toPx([lng, lat]), toPxM([x, y]), fromPx(px, py) } | null
//   viewsBounds(box, rects) -> [x0, y0, x1, y1] (mercator, the union of what each rect shows)
//   cameraFor(bounds, most) -> { w, h, center, zoom }
//   miniCamera(mini) -> { w, h, center, zoom } | null
//   prepareMaps(reel, { doc, win, load, waitMs, most }) -> store { ready, get(key), mini(scene), cover(bounds), done }
//   coverOf(pictures, bounds, sharp) -> the smallest picture holding bounds
//   boxKey(box)

import { fromLocal } from '../shared/geo.js?v=163';
import { miniMap } from './scenes.js?v=163';
import { tourBoxes } from './tour.js?v=163';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark'; // map.js's own (kept equal by a test)
export const MINI_SIZE = 600;

const RAD = Math.PI / 180;
const EARTH_C = 40075016.686;      // metres round the equator
export const TILE = 512;           // MapLibre's world is 512 * 2^zoom pixels wide
export const MAP_WAIT_MS = 12000;  // one picture's tiles must come within this
export const MAPS_MOST = 10;       // pictures per reel at most (the whole game's stretches share the big one past it)
export const TOUR_MAPS_MOST = 16; // big pictures at most, the director camera's tour views included (v1.4.6)
export const DETAIL = 2.5;        // a picture this many times wider than a view is still sharp enough for it
export const PAD = 20;             // movie.js leaves this much round a scene's box

export function mercator(p) {
  const lat = Math.max(-85.05, Math.min(85.05, p[1]));
  const s = Math.sin(lat * RAD);
  return [(p[0] + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

export function unmercator(m) {
  const lng = m[0] * 360 - 180;
  const lat = (2 * Math.atan(Math.exp((0.5 - m[1]) * 2 * Math.PI)) - Math.PI / 2) / RAD;
  return [lng, lat];
}

export function boxKey(box) {
  return box ? box.flat().map((n) => Number(n).toFixed(6)).join(',') : '';
}

// The scene's box fitted into rect (leaving pad round it), in mercator: so a picture made by MapLibre for the same
// view lines up with the dots exactly.
export function fitView(box, rect, pad = PAD) {
  if (!box || !rect) return null;
  const [[w, s], [e, n]] = box;
  if (![w, s, e, n].every(Number.isFinite)) return null;
  const a = mercator([w, n]), b = mercator([e, s]);
  const spanX = Math.max(1e-12, b[0] - a[0]), spanY = Math.max(1e-12, b[1] - a[1]);
  const k = Math.min(Math.max(1, rect.w - pad * 2) / spanX, Math.max(1, rect.h - pad * 2) / spanY);
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const toPxM = (m) => [rect.x + rect.w / 2 + (m[0] - cx) * k, rect.y + rect.h / 2 + (m[1] - cy) * k];
  return { k, cx, cy, toPxM, toPx: (p) => toPxM(mercator(p)), fromPx: (px, py) => [cx + (px - rect.x - rect.w / 2) / k, cy + (py - rect.y - rect.h / 2) / k] };
}

export function viewsBounds(box, rects) {
  let b = null;
  for (const r of rects) {
    const v = fitView(box, r);
    if (!v) continue;
    const [x0, y0] = v.fromPx(r.x, r.y), [x1, y1] = v.fromPx(r.x + r.w, r.y + r.h);
    b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
  }
  return b;
}

// The offscreen map's size and camera for a mercator area: the longer side `most` pixels.
export function cameraFor(bounds, most = 1280) {
  const bw = bounds[2] - bounds[0], bh = bounds[3] - bounds[1];
  if (!(bw > 0) || !(bh > 0)) return null;
  const w = bw >= bh ? most : Math.max(64, Math.round((most * bw) / bh));
  const h = bh > bw ? most : Math.max(64, Math.round((most * bh) / bw));
  const zoom = Math.log2(w / bw / TILE);
  return { w, h, zoom, center: unmercator([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]) };
}

// A close-call mini map's picture: its own box in metres round its origin (scenes.js miniMap's geo).
export function miniCamera(mini) {
  if (!mini || !mini.box || !mini.geo || !Array.isArray(mini.origin)) return null;
  const { w, h, pxPerM } = mini.box;
  if (!(w > 0 && h > 0 && pxPerM > 0)) return null;
  const center = fromLocal(mini.origin, [mini.geo.cx, mini.geo.cy]);
  const mpp = 1 / pxPerM;
  const zoom = Math.log2((EARTH_C * Math.cos(center[1] * RAD)) / (mpp * TILE));
  return { w: Math.round(w), h: Math.round(h), zoom, center };
}

// The map panels a scene can have (movie.js: the full frame, under the cameras, and the minimap's fallback).
export function rectsFor(W, H, camH) {
  return [{ x: 0, y: 0, w: W, h: H }, { x: 0, y: camH, w: W, h: H - camH }, { x: 0, y: 380, w: W, h: H - 380 }];
}

// the smallest of these pictures ({ bounds }) holding b; `sharp`: only one at most DETAIL times b's width
export function coverOf(list, b, sharp = false) {
  let best = null;
  const e = 1e-12;
  for (const p of list) {
    const q = p && p.bounds;
    if (!q || q[0] > b[0] + e || q[1] > b[1] + e || q[2] < b[2] - e || q[3] < b[3] - e) continue;
    if (sharp && (q[2] - q[0]) > (b[2] - b[0]) * DETAIL) continue;
    if (!best || (q[2] - q[0]) * (q[3] - q[1]) < (best.bounds[2] - best.bounds[0]) * (best.bounds[3] - best.bounds[1])) best = p;
  }
  return best;
}

async function snap(lib, cam, { doc, waitMs }) {
  const MapClass = lib.Map || (lib.default && lib.default.Map);
  if (typeof MapClass !== 'function') return null;
  const el = doc.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `position:fixed;left:-${cam.w + 50}px;top:0;width:${cam.w}px;height:${cam.h}px;pointer-events:none;opacity:0`;
  doc.body.append(el);
  let map = null;
  try {
    map = new MapClass({ container: el, style: STYLE_URL, center: cam.center, zoom: cam.zoom, interactive: false,
      attributionControl: false, preserveDrawingBuffer: true, pixelRatio: 1, fadeDuration: 0 });
    const ok = await new Promise((res) => {
      let styled = false;
      const timer = setTimeout(() => res(false), waitMs);
      map.on('error', () => { if (!styled) { clearTimeout(timer); res(false); } });
      map.once('style.load', () => { styled = true; });
      map.once('idle', () => { clearTimeout(timer); res(styled || (map.isStyleLoaded && map.isStyleLoaded())); });
    });
    if (!ok) return null;
    const src = map.getCanvas();
    const out = doc.createElement('canvas');
    out.width = cam.w; out.height = cam.h;
    const c = out.getContext('2d');
    if (!c) return null;
    c.drawImage(src, 0, 0, cam.w, cam.h);
    return out;
  } catch { return null; } finally {
    try { if (map) map.remove(); } catch { /* fine */ }
    el.remove();
  }
}

// -> a store movie.js reads (`maps` in drawFrame). Pictures come in one by one; until one's there the grid shows.
export function prepareMaps(reel, { doc = globalThis.document, win = globalThis.window, load = null, waitMs = MAP_WAIT_MS,
  most = MAPS_MOST, W = 720, H = 1280, camH = Math.round(1280 * 0.62) } = {}) {
  const big = new Map(), minis = new WeakMap();
  const store = {
    get: (key) => big.get(key) || null,
    any: () => big.get('*') || null,
    mini: (scene) => minis.get(scene) || null,
    // the most detailed picture holding all of these mercator bounds (a tour view between its pictures)
    cover: (b) => coverOf([...new Set(big.values())], b),
    done: Promise.resolve(false),
  };
  if (!reel || !Array.isArray(reel.scenes) || !doc || !doc.body || typeof doc.createElement !== 'function') return store;
  const jobs = [];
  const seen = new Set();
  const rects = rectsFor(W, H, camH);
  // the whole game's box first (every scene can fall back to it), then each scene's own
  const boxes = reel.scenes.map((s) => s && s.map && s.map.box).filter(Boolean);
  boxes.sort((a, b) => (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]) - (a[1][0] - a[0][0]) * (a[1][1] - a[0][1]));
  for (const box of boxes) {
    const key = boxKey(box);
    if (seen.has(key) || jobs.length >= most) continue;
    seen.add(key);
    const bounds = viewsBounds(box, rects);
    const cam = bounds && cameraFor(bounds);
    if (cam) jobs.push({ key, bounds, cam, first: jobs.length === 0 });
  }
  for (const s of reel.scenes) {
    if (!s || !s.mini || jobs.length >= most + 4) continue;
    let mm = null;
    try { mm = miniMap(s.mini, { w: MINI_SIZE, h: MINI_SIZE }); } catch { mm = null; }
    const cam = miniCamera(mm);
    if (cam) jobs.push({ scene: s, cam });
  }
  // v1.4.6: the tour views, unless a picture already made covers one in enough detail
  let bigN = jobs.filter((j) => !j.scene).length;
  for (const s of reel.scenes) {
    for (const box of tourBoxes(s)) {
      if (bigN >= Math.max(most, TOUR_MAPS_MOST)) break;
      const key = boxKey(box);
      if (seen.has(key)) continue;
      const bounds = viewsBounds(box, [rects[0]]);
      if (!bounds) continue;
      if (coverOf(jobs.filter((j) => !j.scene), bounds, true)) continue;
      const cam = cameraFor(bounds);
      if (!cam) continue;
      seen.add(key);
      jobs.push({ key, bounds, cam, first: false, tour: true });
      bigN += 1;
    }
  }
  if (!jobs.length) return store;
  store.done = (async () => {
    let lib = null;
    try {
      const gl = doc.createElement('canvas');
      if (!load && !(gl.getContext && gl.getContext('webgl2'))) return false;
      lib = load ? await load() : await import('../vendor/maplibre-gl.mjs?v=163');
    } catch { return false; }
    let any = false;
    for (const j of jobs) {
      const pic = await snap(lib, j.cam, { doc, win, waitMs });
      if (!pic) { if (!any) return false; continue; } // the first failing: tiles aren't coming, stop trying
      any = true;
      if (j.scene) minis.set(j.scene, pic);
      else { const v = { img: pic, bounds: j.bounds }; big.set(j.key, v); if (j.first) big.set('*', v); }
    }
    return any;
  })().catch(() => false);
  return store;
}
