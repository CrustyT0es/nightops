// Night Ops: the map. createMap(container, { interactive }) -> map.
//
// Two ways to draw it, one look:
//   'maplibre'  the street map (MapLibre GL + OpenFreeMap's dark style), when the phone can run it;
//   'plain'     a dark grid with the ring drawn as SVG (equirectangular around the ring's centre), when it can't:
//               no WebGL 2, MapLibre won't load or errors, or its style hasn't loaded within 8 s.
// The plain map shows at once and the street map takes over when it's ready (keeping the same view), so a game
// never waits for tiles. Once the plain map is the final choice it stays: no flipping back mid-game.
// Marks (faces, ping circles, labels), corner dots and replay heads are DOM/SVG over either map, placed with the
// map's own projection on every move, so both look the same.
//
//   map.setRing(ring, ringNow)              ringNow solid blue with the outside dimmed; the full ring dashed once shrunk
//   map.setMarks(marks, { faces, players, meId, onTap, tappable, paused })
//   map.setDraft(points | { kind: 'circle', center, radiusM } | null)     the ring editor's shape in progress
//   map.onTap(fn([lng, lat]) | null) -> off()
//   map.fit(boundsOrRingOrPoints, { padding, animate, maxZoom })
//   map.center(point, zoom?, { animate })
//   map.setRoutes(routes | null, clockSeconds, { players, faces })      the replay
//   map.mode() -> 'maplibre' | 'plain'     map.ready -> Promise<'maplibre' | 'plain'> (never rejects)
//   map.getCenter(), map.getZoom(), map.project(p), map.unproject([x, y]), map.resize(), map.destroy()
//   v1.2: map.setInsets({ top, right, bottom, left })   px hidden by a screen's bars: fit/center/fitAll keep to the rest
//         map.fitAll({ ring, marks, padding })          Fit everyone: the ring and every mark (with its circle)
//         map.zoomBy(step)                              +1 / -1 around the middle of what shows, animated
//         map.onMode(fn(mode)) -> off()                 the map swapped engines ('maplibre' | 'plain')
//   Faces that would overlap are grouped (clusterMarks): 2-3 spread round their middle with a stem to their spot,
//   4 or more merged into one face with a "+N" badge (a tap zooms in on them). Made again after setMarks and when
//   the zoom settles, never every frame.
//
// Marks are buttons only when setMarks gets an onTap handler (by default only hiders' marks: hunters tap them to
// tag); otherwise they're aria-hidden pictures and the screens give the words.
// CSS knobs a screen may set on its container: --map-inset-top, --map-inset-bottom (px) keep the map credits and
// the scale bar clear of the screen's own bars.

import { h, face as makeFace, text, listen } from './dom.js?v=145';
import { icon } from './ui/icons.js?v=145';
import {
  EARTH_M, isPoint, toLocal, fromLocal, ringCenter, ringOutline, ringBounds, boundsOf, ringAreaM2,
} from '../shared/geo.js?v=145';
import { TIMING, fmtDistance } from '../shared/rules.js?v=145';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
export const STYLE_WAIT_MS = 8000;   // the street map's style must load within this, or the plain map stays
export const SWAP_WAIT_MS = 2500;    // after the style loads, wait at most this for the first tiles before swapping
export const TILE_SIZE = 512;        // MapLibre's zoom: the world is 512 * 2^zoom px wide
export const MIN_AREA_PX = 28;       // a ping circle is never smaller than this radius
export const GLIDE_MS = 700;         // a mark that moved slides to its new spot this fast
export const DEFAULT_ZOOM = 16;      // about 350 m across a phone
export const MAX_ZOOM = 19;
export const PLAIN_MIN_ZOOM = 10;    // the plain map: about 20 km across a phone at most
export const FIT_MAX_ZOOM = 17.5;
export const MARK_SIZE = Object.freeze({ me: 48, other: 42, sos: 52 }); // v1.2: faces, px
export const ROUTE_FACE = 40;                 // the replay's moving faces
const CLUSTER_SETTLE_MS = 160;      // the zoom has stood still this long: group the faces again
const CLUSTER_ROUTES_MS = 500;      // the replay's faces are grouped again at most this often
const CONTEXT_WAIT_MS = 5000;        // a lost WebGL context must come back within this (while the page is shown)
const ROUTES_EVERY_MS = 100;         // the street map's replay lines are redrawn at most this often
const AGE_DRIFT_MS = 30000;          // between views, ages tick on by themselves, at most this far
const RAD = Math.PI / 180;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

function clampLat(lat) {
  return Math.max(-85, Math.min(85, Number.isFinite(lat) ? lat : 0));
}

// Metres on the ground -> screen pixels at this latitude and MapLibre zoom (Web Mercator, 512 px tiles).
// Uses geo.js's earth radius, so a circle drawn r metres wide matches points placed with geo.moveM.
export function metresToPixels(m, lat, zoom, tileSize = TILE_SIZE) {
  return (m * tileSize * 2 ** zoom) / (2 * Math.PI * EARTH_M * Math.cos(clampLat(lat) * RAD));
}

// The MapLibre zoom that shows pxPerMetre pixels per metre at this latitude (metresToPixels backwards).
export function zoomForScale(pxPerMetre, lat, tileSize = TILE_SIZE) {
  return Math.log2((pxPerMetre * 2 * Math.PI * EARTH_M * Math.cos(clampLat(lat) * RAD)) / tileSize);
}

// The plain map's projection: equirectangular around view.origin.
// view = { origin: [lng, lat], cx, cy (metres east/north of the origin at the middle of the screen),
//          scale (px per metre), width, height (px) }
export function plainProject(view, p) {
  const [x, y] = toLocal(view.origin, p);
  return [view.width / 2 + (x - view.cx) * view.scale, view.height / 2 - (y - view.cy) * view.scale];
}

export function plainUnproject(view, xy) {
  const x = view.cx + (xy[0] - view.width / 2) / view.scale;
  const y = view.cy - (xy[1] - view.height / 2) / view.scale;
  return fromLocal(view.origin, [x, y]);
}

// The plain view { cx, cy, scale } that shows bounds [[w, s], [e, n]] inside the padding box.
export function plainFit(view, bounds, pad, maxZoom = FIT_MAX_ZOOM, minZoom = PLAIN_MIN_ZOOM) {
  const [x0, y0] = toLocal(view.origin, bounds[0]);
  const [x1, y1] = toLocal(view.origin, bounds[1]);
  const bw = Math.abs(x1 - x0);
  const bh = Math.abs(y1 - y0);
  const aw = Math.max(1, view.width - pad.left - pad.right);
  const ah = Math.max(1, view.height - pad.top - pad.bottom);
  const lat = (bounds[0][1] + bounds[1][1]) / 2;
  let scale = Math.min(bw > 0 ? aw / bw : Infinity, bh > 0 ? ah / bh : Infinity);
  scale = Math.min(scale, metresToPixels(1, lat, maxZoom));
  scale = Math.max(scale, metresToPixels(1, lat, minZoom));
  return {
    cx: (x0 + x1) / 2 - (pad.left - pad.right) / (2 * scale),
    cy: (y0 + y1) / 2 + (pad.top - pad.bottom) / (2 * scale),
    scale,
  };
}

export const WORLD = Object.freeze([[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]);

// Twice the signed area of a ring of [x, y] points (positive = counter-clockwise with y up).
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

export function closed(pts) {
  if (!pts.length) return [];
  const out = pts.map((p) => [p[0], p[1]]);
  const a = out[0];
  const b = out[out.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) out.push([a[0], a[1]]);
  return out;
}

// GeoJSON Polygon: the whole world with the ring cut out, for dimming everything outside the ring.
// The outer edge goes counter-clockwise and the hole clockwise (MapLibre tells holes by their winding).
export function worldWithHole(ring) {
  const hole = closed(ringOutline(ring));
  if (signedArea(hole) > 0) hole.reverse();
  return { type: 'Polygon', coordinates: [WORLD.map((p) => [p[0], p[1]]), hole] };
}

// A route's points, cleaned: valid [lng, lat, clockSeconds] only, in time order.
export function cleanRoute(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (Array.isArray(p) && isPoint(p) && Number.isFinite(p[2])) out.push([p[0], p[1], p[2]]);
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i][2] < out[i - 1][2]) { out.sort((a, b) => a[2] - b[2]); break; }
  }
  return out;
}

// How much of a clean route is drawn at this clock: the first n whole points, then the head (where the player
// is at that moment, between two points). clock null = the whole route. Before the route starts: n 0, head null.
export function routeIndex(pts, clockSeconds) {
  if (!pts.length) return { n: 0, head: null };
  const last = pts[pts.length - 1];
  if (clockSeconds === null || clockSeconds === undefined || !Number.isFinite(clockSeconds)) {
    return { n: pts.length, head: [last[0], last[1]] };
  }
  if (clockSeconds < pts[0][2]) return { n: 0, head: null };
  if (clockSeconds >= last[2]) return { n: pts.length, head: [last[0], last[1]] };
  let lo = 0;
  let hi = pts.length - 1; // pts[lo][2] <= clock < pts[hi][2]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][2] <= clockSeconds) lo = mid; else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const span = b[2] - a[2];
  const f = span > 0 ? (clockSeconds - a[2]) / span : 0;
  return { n: lo + 1, head: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] };
}

// The route up to this clock as a line of [lng, lat] (ending at the head) plus the head itself.
export function routeAt(points, clockSeconds) {
  const pts = cleanRoute(points);
  const { n, head } = routeIndex(pts, clockSeconds);
  const line = pts.slice(0, n).map((p) => [p[0], p[1]]);
  if (head) {
    const end = line[line.length - 1];
    if (!end || end[0] !== head[0] || end[1] !== head[1]) line.push(head);
  }
  return { line, head };
}

// '1:52 ago', '1:02:05 ago', or 'now' under a second.
export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return 'now';
  const s = Math.floor(ms / 1000);
  const hr = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return hr ? `${hr}:${String(min).padStart(2, '0')}:${sec} ago` : `${min}:${sec} ago`;
}

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];

// A tidy grid spacing in metres that is at least minPx pixels apart at this scale.
export function gridStep(pxPerMetre, minPx = 56) {
  for (const s of STEPS) if (s * pxPerMetre >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

export function fmtMetres(m) {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

// [[w, s], [e, n]] from a ring, a circle draft, bounds, a list of points or one point; null when there's nothing.
export function toBounds(x) {
  if (!x || typeof x !== 'object') return null;
  if (!Array.isArray(x)) {
    if (x.kind === 'circle') {
      return isPoint(x.center) && Number.isFinite(x.radiusM) && x.radiusM > 0 ? ringBounds(x) : null;
    }
    if (x.kind === 'polygon' && Array.isArray(x.points)) {
      const pts = x.points.filter(isPoint);
      return pts.length ? boundsOf(pts) : null;
    }
    return null;
  }
  if (isPoint(x)) return [[x[0], x[1]], [x[0], x[1]]];
  const pts = x.filter(isPoint);
  return pts.length ? boundsOf(pts) : null;
}

// Padding as { top, right, bottom, left }, shrunk so at least 30% of the map stays for the content.
export function padBox(padding, width, height) {
  const n = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const base = Number.isFinite(padding) ? Math.max(0, padding) : 40;
  const p = padding && typeof padding === 'object'
    ? { top: n(padding.top, 0), right: n(padding.right, 0), bottom: n(padding.bottom, 0), left: n(padding.left, 0) }
    : { top: base, right: base, bottom: base, left: base };
  const fitIn = (a, b, size) => {
    const room = Math.max(0, size * 0.7);
    if (a + b <= room || a + b === 0) return [a, b];
    const k = room / (a + b);
    return [a * k, b * k];
  };
  [p.left, p.right] = fitIn(p.left, p.right, width);
  [p.top, p.bottom] = fitIn(p.top, p.bottom, height);
  return p;
}

// Marks with the same id can show together (a hider's own spot and what the hunters saw; an SOS over a ping),
// so each mark lives in a slot: 'sos', 'seen' or 'main' (one of ping/radar/exposure/outside/offline/hunter...).
export function markSlot(kind) {
  return kind === 'sos' ? 'sos' : kind === 'seen' ? 'seen' : 'main';
}

export function markKey(mark, i) {
  const id = mark && mark.id !== undefined && mark.id !== null && mark.id !== '' ? String(mark.id) : `#${i}`;
  return `${markSlot(mark && mark.kind)}:${id}`;
}

// v1.2: faces closer than `near` px on screen are grouped (single link: a chain of close faces is one group).
// items [{ key, x, y, rank }] -> [{ keys, top, x, y, spread: [{ key, dx, dy }] | null, more }]
//   one face:        as it is (spread null, more 0)
//   2..spreadMost:   x, y = their middle; spread moves each face (dx, dy from its own spot) onto a `ring` px circle
//   more than that:  merged: x, y = the top face's spot (highest rank, then key), more = how many it stands for
// Pure and in a fixed order (keys sorted), so the same picture always gives the same groups.
//   alone: true      never grouped (an SOS face: it must never be hidden behind someone else's "+N")
export function clusterMarks(items, { near = 44, spreadMost = 3, ring = 30 } = {}) {
  const all = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.key !== undefined && Number.isFinite(it.x) && Number.isFinite(it.y));
  const alone = all.filter((it) => it.alone)
    .map((it) => ({ keys: [String(it.key)], top: String(it.key), x: it.x, y: it.y, spread: null, more: 0 }));
  const grouped = clusterGroups(all.filter((it) => !it.alone), { near, spreadMost, ring });
  return alone.length ? [...grouped, ...alone].sort((a, b) => (a.keys[0] < b.keys[0] ? -1 : a.keys[0] > b.keys[0] ? 1 : 0)) : grouped;
}

function clusterGroups(items, { near, spreadMost, ring }) {
  const list = items
    .map((it) => ({ key: String(it.key), x: it.x, y: it.y, rank: Number.isFinite(it.rank) ? it.rank : 0 }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const n = list.length;
  const parent = list.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const near2 = near * near;
  // Sorted by x, so only faces within `near` across are compared.
  const byX = list.map((_, i) => i).sort((a, b) => list[a].x - list[b].x);
  for (let a = 0; a < n; a++) {
    const A = list[byX[a]];
    for (let b = a + 1; b < n; b++) {
      const B = list[byX[b]];
      if (B.x - A.x >= near) break;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      if (dx * dx + dy * dy < near2) {
        const ra = find(byX[a]);
        const rb = find(byX[b]);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(list[i]);
  }
  const out = [];
  for (const g of [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k))) {
    const keys = g.map((it) => it.key);
    let top = g[0];
    for (const it of g) if (it.rank > top.rank) top = it;
    if (g.length === 1) {
      out.push({ keys, top: top.key, x: top.x, y: top.y, spread: null, more: 0 });
    } else if (g.length <= spreadMost) {
      const mx = g.reduce((s, it) => s + it.x, 0) / g.length;
      const my = g.reduce((s, it) => s + it.y, 0) / g.length;
      // Two side by side; three or more from the top round the clock.
      const start = g.length === 2 ? Math.PI : -Math.PI / 2;
      const spread = g.map((it, i) => {
        const a = start + (i * 2 * Math.PI) / g.length;
        const fx = mx + ring * Math.cos(a);
        const fy = my + ring * Math.sin(a);
        return { key: it.key, dx: Math.round((fx - it.x) * 10) / 10, dy: Math.round((fy - it.y) * 10) / 10 };
      });
      out.push({ keys, top: top.key, x: mx, y: my, spread, more: 0 });
    } else {
      out.push({ keys, top: top.key, x: top.x, y: top.y, spread: null, more: g.length - 1 });
    }
  }
  // A spread that would land a face on someone else's is merged instead (spreading never makes a new overlap).
  const byKey = new Map(list.map((it) => [it.key, it]));
  const facesOf = (g) => (g.spread
    ? g.spread.map((s) => ({ x: byKey.get(s.key).x + s.dx, y: byKey.get(s.key).y + s.dy }))
    : [{ x: g.x, y: g.y }]);
  for (const g of out) {
    if (!g.spread) continue;
    const mine = facesOf(g);
    const clash = out.some((o) => o !== g && facesOf(o).some((f) => mine.some((m) => (m.x - f.x) ** 2 + (m.y - f.y) ** 2 < near2)));
    if (!clash) continue;
    const top = byKey.get(g.top);
    g.spread = null;
    g.x = top.x;
    g.y = top.y;
    g.more = g.keys.length - 1;
  }
  return out;
}

// v1.2: where each face's labels (name, chip, age) go so they don't run into another's labels or face.
// items [{ key, x, y (the face's middle), half (half the face), below (px from the middle to where labels start when
// under the face), w, h (the labels' size), rank }] -> Map key -> 'below' | 'above' | 'right' | 'left' | 'hidden'.
// Higher ranks are placed first (and keep 'below' when they can); a label with no free place is hidden (the face
// stays, its words are in its button or the screen's lists); keep: true never hides (an SOS). Pure.
export function placeLabels(items, { gap = 4, pad = 2 } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.key !== undefined && Number.isFinite(it.x) && Number.isFinite(it.y))
    .map((it) => ({ ...it, key: String(it.key), half: Number(it.half) || 21, w: Math.max(0, Number(it.w) || 0), h: Math.max(0, Number(it.h) || 0), rank: Number(it.rank) || 0 }))
    .sort((a, b) => (b.rank - a.rank) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const faces = list.map((it) => ({ key: it.key, l: it.x - it.half, t: it.y - it.half, r: it.x + it.half, b: it.y + it.half }));
  const placed = [];
  const out = new Map();
  const hits = (a, b) => a.l < b.r - pad && b.l < a.r - pad && a.t < b.b - pad && b.t < a.b - pad;
  for (const it of list) {
    if (!it.w || !it.h) { out.set(it.key, 'below'); continue; }
    const below = Number.isFinite(it.below) ? it.below : it.half + gap;
    const spots = [
      ['below', { l: it.x - it.w / 2, t: it.y + below }],
      ['above', { l: it.x - it.w / 2, t: it.y - it.half - gap - it.h }],
      ['right', { l: it.x + it.half + gap, t: it.y - it.h / 2 }],
      ['left', { l: it.x - it.half - gap - it.w, t: it.y - it.h / 2 }],
    ];
    let at = 'hidden';
    if (it.keep) at = 'below'; // (an SOS's name always shows: first, and under its face if nothing is free)
    for (const [name, p] of spots) {
      const box = { l: p.l, t: p.t, r: p.l + it.w, b: p.t + it.h };
      if (placed.some((x) => hits(box, x))) continue;
      if (faces.some((f) => f.key !== it.key && hits(box, f))) continue;
      at = name;
      break;
    }
    if (at !== 'hidden') {
      const p = spots.find(([n]) => n === at)[1];
      placed.push({ l: p.l, t: p.t, r: p.l + it.w, b: p.t + it.h });
    }
    out.set(it.key, at);
  }
  return out;
}

// Which face stands for a merged group: you > SOS > live > offline > the newest ping > the rest.
// v1.3 PAGE-SETUP: a checkpoint slot's state at a clock (the replay's helper): open from `at` until `close`.
export function spotState(slot, clockMs) {
  if (!slot || !Number.isFinite(clockMs) || !Number.isFinite(slot.at)) return null;
  if (clockMs < slot.at) return null;
  return Number.isFinite(slot.close) && clockMs >= slot.close ? 'closed' : 'active';
}
// v1.3 end PAGE-SETUP

export function markRank(kind, { me = false, age = 0 } = {}) {
  if (me) return 100;
  if (kind === 'sos') return 90;
  if (kind === 'radar' || kind === 'exposure' || kind === 'outside' || kind === 'near' || kind === 'hunter' || kind === 'hider' || kind === 'self') return 60;
  if (kind === 'overstay') return 60; // v1.3 PAGE-PLAY: stayed at a checkpoint too long (live)
  if (kind === 'route') return 50;
  if (kind === 'offline') return 30;
  if (kind === 'ping') return 20 + Math.max(0, 9 - Math.min(9, (Number(age) || 0) / 60000));
  if (kind === 'seen') return 5;
  return 10;
}

// How each kind of mark looks.
const KINDS = {
  hunter: { team: 'hunter' },
  hider: { team: 'hider' },
  self: { team: 'viewer' },
  radar: { team: 'hider', pulse: true, chip: 'Live', chipKind: 'live' },
  exposure: { team: 'hider', exact: true, chip: 'Exposed', chipKind: 'warn' },
  outside: { team: 'hider', exact: true, chip: 'Outside', chipKind: 'warn' },
  offline: { team: 'hider', exact: true, chip: 'Offline', chipKind: 'muted', age: true },
  ping: { team: 'hider', area: 'ping', age: true },
  seen: { team: 'hider', area: 'seen', age: true },
  sos: { team: 'hunter', sos: true },
  near: { team: 'hider', pulse: true, chip: 'Near car', chipKind: 'live' }, // v1.1 PAGE-DRIVER: the parked driver's
  overstay: { team: 'hider', exact: true, chip: 'Checkpoint', chipKind: 'cp' }, // v1.3 PAGE-PLAY: live at a checkpoint
  other: { team: null },
};
const TAPPABLE = new Set(['hider', 'radar', 'exposure', 'outside', 'offline', 'ping', 'near']); // v1.1 PAGE-DRIVER: + near
TAPPABLE.add('overstay'); // v1.3 PAGE-PLAY

export function validRing(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind === 'circle') {
    return isPoint(r.center) && Number.isFinite(r.radiusM) && r.radiusM > 0
      ? { kind: 'circle', center: [r.center[0], r.center[1]], radiusM: r.radiusM } : null;
  }
  if (r.kind === 'polygon' && Array.isArray(r.points)) {
    const pts = r.points.filter(isPoint).map((p) => [p[0], p[1]]);
    return pts.length >= 3 ? { kind: 'polygon', points: pts } : null;
  }
  return null;
}

// The draft as drawable parts: fill (closed shape), line (the corners in order), close (last corner back to the
// first, dashed), corners (numbered dots) and center (a circle's centre).
export function draftParts(draft) {
  if (!draft) return null;
  if (!Array.isArray(draft) && draft.kind === 'circle') {
    const c = validRing(draft);
    if (!c) return null;
    const outline = closed(ringOutline(c, 72));
    return { fill: outline, line: outline, close: null, corners: [], center: c.center };
  }
  const pts = (Array.isArray(draft) ? draft : Array.isArray(draft.points) ? draft.points : [])
    .filter(isPoint).slice(0, 50).map((p) => [p[0], p[1]]);
  if (!pts.length) return null;
  return {
    fill: pts.length >= 3 ? closed(pts) : null,
    line: pts.length >= 2 ? pts : null,
    close: pts.length >= 3 ? [pts[pts.length - 1], pts[0]] : null,
    corners: pts,
    center: null,
  };
}

// ---- small DOM helpers ------------------------------------------------------------------------------------

function svgNode(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function show(el, on) {
  if (el.hidden === on) el.hidden = !on;
}

function setD(path, d) {
  if (path._d !== d) { path._d = d; path.setAttribute('d', d); }
}

function easeOut(f) { return 1 - (1 - f) ** 3; }
function easeInOut(f) { return f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2; }

function hasWebGL2() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext(); // phones only allow a few contexts: give this one back now
    return true;
  } catch {
    return false;
  }
}

function cssColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function readColors() {
  return {
    hider: cssColor('--hider', '#4ea8ff'),
    hunter: cssColor('--hunter', '#ff5a5a'),
    text: cssColor('--text', '#e6ebf2'),
    muted: cssColor('--muted', '#9aa6b8'),
  };
}

function lerpPoint(a, b, f) {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// ---- the plain map ----------------------------------------------------------------------------------------

class PlainMap {
  constructor(host, before, { interactive, onTap, onUserMove, onChange }) {
    this.kind = 'plain';
    this.interactive = interactive;
    this.onTapCb = onTap;
    this.onUserMove = onUserMove;
    this.onChange = onChange;
    this.reduced = false;
    this.tapMode = false;
    this.v = { origin: null, cx: 0, cy: 0, scale: 1, width: 0, height: 0 };
    this.camV = 1;
    this.drawnCam = 0;
    this.model = null;
    this.drawnModel = null;
    this.anim = null;
    this.ptrs = new Map();
    this.gesture = null;
    this.lastTap = null;
    this.offs = [];

    this.el = h('div.nmap-plain', interactive
      ? { tabindex: '0', role: 'region', 'aria-roledescription': 'map', 'aria-label': 'Map. Arrow keys move it, plus and minus zoom.' }
      : { 'aria-hidden': 'true' });
    if (!interactive) this.el.classList.add('static');
    this.svg = svgNode('svg', { class: 'nmap-svg', 'aria-hidden': 'true', focusable: 'false' });
    const path = (cls) => this.svg.appendChild(svgNode('path', { class: cls }));
    this.p = {
      minor: path('nmap-grid'),
      major: path('nmap-grid major'),
      inside: path('nmap-inside'),
      dim: path('nmap-dim'),
      routes: { hunter: path('nmap-route hunter'), hider: path('nmap-route hider'), other: path('nmap-route other') },
      full: path('nmap-ring-full'),
      glow: path('nmap-ring-glow'),
      edge: path('nmap-ring-edge'), // v1.2: a dark edge under the ring line, so it reads on light streets
      ring: path('nmap-ring'),
      dfill: path('nmap-draft-fill'),
      dline: path('nmap-draft-line'),
      dclose: path('nmap-draft-close'),
    };
    this.scaleBar = h('span.nmap-scale-bar');
    this.scaleText = h('span.nmap-scale-text');
    this.noteText = h('span.nmap-note-text', { hidden: true }, 'No street map');
    this.note = h('div.nmap-note', { 'aria-hidden': 'true', hidden: true },
      h('span.nmap-scale', this.scaleBar, this.scaleText), this.noteText);
    this.el.append(this.svg, this.note);
    host.insertBefore(this.el, before);
    if (interactive) this.bind();
  }

  hasPlace() { return !!this.v.origin; }
  busy() { return this.ptrs.size > 0 || !!this.anim; }

  changed() {
    this.camV++;
    this.onChange();
  }

  clampScale(scale, lat) {
    const lo = metresToPixels(1, lat, PLAIN_MIN_ZOOM);
    const hi = metresToPixels(1, lat, MAX_ZOOM);
    return Math.max(lo, Math.min(hi, scale));
  }

  // The projection's centre: the ring's centre (or the first point given). Moving it keeps the view in place.
  setOrigin(p) {
    if (!isPoint(p)) return;
    const v = this.v;
    if (!v.origin) {
      v.origin = [p[0], p[1]];
      v.cx = 0;
      v.cy = 0;
      v.scale = metresToPixels(1, p[1], DEFAULT_ZOOM);
      this.changed();
      return;
    }
    if (v.origin[0] === p[0] && v.origin[1] === p[1]) return;
    const c = this.getCenter();
    v.origin = [p[0], p[1]];
    [v.cx, v.cy] = toLocal(v.origin, c);
    this.anim = null;
    this.changed();
  }

  project(p) { return this.v.origin ? plainProject(this.v, p) : null; }
  unproject(xy) { return this.v.origin ? plainUnproject(this.v, xy) : null; }
  pxPerMetre() { return this.v.scale; }
  getCenter() { return this.v.origin ? fromLocal(this.v.origin, [this.v.cx, this.v.cy]) : null; }
  getZoom() {
    const c = this.getCenter();
    return c ? zoomForScale(this.v.scale, c[1]) : null;
  }

  resize(w, hgt) {
    if (this.v.width === w && this.v.height === hgt) return;
    this.v.width = w;
    this.v.height = hgt;
    this.changed();
  }

  setTapMode(on) { this.tapMode = !!on; }
  setFinal() { this.noteText.hidden = false; }

  setModel(model) {
    this.model = model;
    this.onChange();
  }

  target(cx, cy, scale, animate, ms = 450) {
    const v = this.v;
    if (!animate || this.reduced || !v.width) {
      this.anim = null;
      v.cx = cx; v.cy = cy; v.scale = scale;
      this.changed();
      return;
    }
    this.anim = { from: { cx: v.cx, cy: v.cy, scale: v.scale }, to: { cx, cy, scale }, t0: performance.now(), ms };
    this.onChange();
  }

  jumpTo({ center, zoom }, animate = false) {
    if (!isPoint(center)) return;
    if (!this.v.origin) this.setOrigin(center);
    const [cx, cy] = toLocal(this.v.origin, center);
    const scale = Number.isFinite(zoom) ? this.clampScale(metresToPixels(1, center[1], zoom), center[1]) : this.v.scale;
    this.target(cx, cy, scale, animate);
  }

  fitBounds(bounds, pad, { animate = false, maxZoom = FIT_MAX_ZOOM } = {}) {
    if (!this.v.origin) this.setOrigin([(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]);
    const t = plainFit(this.v, bounds, pad, maxZoom);
    this.target(t.cx, t.cy, t.scale, animate, 550);
  }

  // One frame: move a camera animation along, redraw what changed. True while still animating.
  frame(now) {
    const a = this.anim;
    if (a) {
      const f = Math.min(1, (now - a.t0) / a.ms);
      const e = easeInOut(f);
      const v = this.v;
      v.cx = a.from.cx + (a.to.cx - a.from.cx) * e;
      v.cy = a.from.cy + (a.to.cy - a.from.cy) * e;
      v.scale = Math.exp(Math.log(a.from.scale) + (Math.log(a.to.scale) - Math.log(a.from.scale)) * e);
      if (f >= 1) this.anim = null;
      this.camV++;
    }
    if (this.drawnCam !== this.camV || this.drawnModel !== this.model) this.draw();
    return !!this.anim;
  }

  pathOf(pts, close) {
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = plainProject(this.v, pts[i]);
      d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return close && d ? `${d}Z` : d;
  }

  draw() {
    this.drawnCam = this.camV;
    this.drawnModel = this.model;
    const v = this.v;
    const w = v.width;
    const hgt = v.height;
    const P = this.p;
    if (!w || !hgt) return;

    // The grid (it shows even before the map knows where it is).
    const step = gridStep(v.scale);
    const left = v.cx - w / 2 / v.scale;
    const right = v.cx + w / 2 / v.scale;
    const bottom = v.cy - hgt / 2 / v.scale;
    const top = v.cy + hgt / 2 / v.scale;
    let minor = '';
    let major = '';
    for (let k = Math.ceil(left / step); k * step <= right; k++) {
      const x = (Math.round(w / 2 + (k * step - v.cx) * v.scale) + 0.5).toFixed(1);
      const seg = `M${x} 0V${hgt}`;
      if (k % 5 === 0) major += seg; else minor += seg;
    }
    for (let k = Math.ceil(bottom / step); k * step <= top; k++) {
      const y = (Math.round(hgt / 2 - (k * step - v.cy) * v.scale) + 0.5).toFixed(1);
      const seg = `M0 ${y}H${w}`;
      if (k % 5 === 0) major += seg; else minor += seg;
    }
    setD(P.minor, minor);
    setD(P.major, major);

    const m = this.model || {};
    const placed = !!v.origin;
    if (this.note.hidden !== !placed) this.note.hidden = !placed;
    if (placed) {
      // A scale bar about 60-110 px long.
      const sm = gridStep(v.scale, 60);
      const px = Math.round(sm * v.scale);
      if (this.scaleBar._w !== px) { this.scaleBar._w = px; this.scaleBar.style.width = `${px}px`; }
      text(this.scaleText, fmtMetres(sm));
    }

    if (placed && m.nowOutline) {
      const hole = this.pathOf(m.nowOutline, true);
      setD(P.inside, hole);
      setD(P.dim, `M-60 -60H${w + 60}V${hgt + 60}H-60Z${hole}`);
      setD(P.glow, hole);
      setD(P.edge, hole);
      setD(P.ring, hole);
    } else {
      setD(P.inside, ''); setD(P.dim, ''); setD(P.glow, ''); setD(P.edge, ''); setD(P.ring, '');
    }
    setD(P.full, placed && m.fullOutline ? this.pathOf(m.fullOutline, true) : '');

    const d = placed ? m.draft : null;
    setD(P.dfill, d && d.fill ? this.pathOf(d.fill, true) : '');
    setD(P.dline, d && d.line ? this.pathOf(d.line, false) : '');
    setD(P.dclose, d && d.close ? this.pathOf(d.close, false) : '');

    const routes = { hunter: '', hider: '', other: '' };
    if (placed && m.routes) {
      for (const r of m.routes) {
        if (r.n + (r.head ? 1 : 0) < 2) continue;
        let s = '';
        for (let i = 0; i < r.n; i++) {
          const [x, y] = plainProject(v, r.pts[i]);
          s += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
        }
        if (r.head) {
          const [x, y] = plainProject(v, r.head);
          s += `L${x.toFixed(1)} ${y.toFixed(1)}`;
        }
        routes[r.team in routes ? r.team : 'other'] += s;
      }
    }
    setD(P.routes.hunter, routes.hunter);
    setD(P.routes.hider, routes.hider);
    setD(P.routes.other, routes.other);
  }

  // ---- gestures: drag to pan, pinch or wheel to zoom, tap, double tap, keys ----

  bind() {
    const el = this.el;
    this.offs.push(
      listen(el, 'pointerdown', (e) => this.down(e)),
      listen(el, 'pointermove', (e) => this.move(e)),
      listen(el, 'pointerup', (e) => this.up(e, false)),
      listen(el, 'pointercancel', (e) => this.up(e, true)),
      listen(el, 'lostpointercapture', (e) => this.up(e, true)),
      listen(el, 'wheel', (e) => this.wheel(e), { passive: false }),
      listen(el, 'keydown', (e) => this.key(e)),
      listen(el, 'gesturestart', (e) => e.preventDefault()), // iOS Safari: never zoom the page itself
      listen(el, 'dblclick', (e) => e.preventDefault()),
    );
  }

  local(e) {
    const r = this.rect || (this.rect = this.el.getBoundingClientRect());
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!this.ptrs.size) this.rect = this.el.getBoundingClientRect();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
    const pt = this.local(e);
    this.ptrs.set(e.pointerId, pt);
    this.anim = null;
    const v = this.v;
    if (this.ptrs.size === 1) {
      this.gesture = { kind: 'pan', sx: pt.x, sy: pt.y, last: { ...pt }, t0: e.timeStamp, moved: false, multi: false, mouse: e.pointerType === 'mouse' };
    } else if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.gesture = {
        kind: 'pinch',
        d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
        s0: v.scale,
        m: [v.cx + (mx - v.width / 2) / v.scale, v.cy - (my - v.height / 2) / v.scale],
        multi: true,
      };
    }
  }

  move(e) {
    const pt = this.ptrs.get(e.pointerId);
    const g = this.gesture;
    if (!pt || !g) return;
    const now = this.local(e);
    pt.x = now.x;
    pt.y = now.y;
    const v = this.v;
    if (g.kind === 'pan' && this.ptrs.size === 1) {
      if (!g.moved && Math.hypot(pt.x - g.sx, pt.y - g.sy) < (g.mouse ? 4 : 9)) return;
      g.moved = true;
      v.cx -= (pt.x - g.last.x) / v.scale;
      v.cy += (pt.y - g.last.y) / v.scale;
      g.last = { x: pt.x, y: pt.y };
      this.onUserMove();
      this.changed();
    } else if (g.kind === 'pinch' && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const lat = this.getCenter()?.[1] ?? 0;
      v.scale = this.clampScale((g.s0 * d) / g.d0, lat);
      v.cx = g.m[0] - (mx - v.width / 2) / v.scale;
      v.cy = g.m[1] + (my - v.height / 2) / v.scale;
      this.onUserMove();
      this.changed();
    }
  }

  up(e, cancelled) {
    if (!this.ptrs.has(e.pointerId)) return;
    const pt = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    const g = this.gesture;
    if (this.ptrs.size === 0) {
      this.gesture = null;
      if (!cancelled && g && g.kind === 'pan' && !g.moved && !g.multi && e.timeStamp - g.t0 < 700) this.tap(pt, e.timeStamp);
    } else if (this.ptrs.size === 1) {
      const [p] = [...this.ptrs.values()];
      this.gesture = { kind: 'pan', sx: p.x, sy: p.y, last: { x: p.x, y: p.y }, t0: e.timeStamp, moved: true, multi: true };
    }
  }

  tap(pt, t) {
    const ll = this.unproject([pt.x, pt.y]);
    if (!this.tapMode) {
      const last = this.lastTap;
      if (last && t - last.t < 320 && Math.hypot(pt.x - last.x, pt.y - last.y) < 30) {
        this.lastTap = null;
        this.zoomAround(2, pt.x, pt.y, true);
        return;
      }
      this.lastTap = { t, x: pt.x, y: pt.y };
    }
    if (ll) this.onTapCb(ll);
  }

  zoomAround(factor, x, y, animate) {
    const v = this.v;
    const lat = this.getCenter()?.[1] ?? 0;
    const scale = this.clampScale(v.scale * factor, lat);
    const mx = v.cx + (x - v.width / 2) / v.scale;
    const my = v.cy - (y - v.height / 2) / v.scale;
    this.onUserMove();
    this.target(mx - (x - v.width / 2) / scale, my + (y - v.height / 2) / scale, scale, animate, 250);
  }

  wheel(e) {
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= this.v.height || 600;
    const f = Math.max(0.5, Math.min(2, Math.exp(-dy * 0.0022)));
    this.anim = null;
    this.zoomAround(f, e.clientX - r.left, e.clientY - r.top, false);
  }

  key(e) {
    if (e.target !== this.el || e.altKey || e.ctrlKey || e.metaKey) return;
    const v = this.v;
    const step = 80;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = step;
    else if (e.key === 'ArrowRight') dx = -step;
    else if (e.key === 'ArrowUp') dy = step;
    else if (e.key === 'ArrowDown') dy = -step;
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomAround(1.6, v.width / 2, v.height / 2, true); return; }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomAround(1 / 1.6, v.width / 2, v.height / 2, true); return; }
    else return;
    e.preventDefault();
    this.onUserMove();
    this.target(v.cx - dx / v.scale, v.cy + dy / v.scale, v.scale, true, 200);
  }

  destroy() {
    for (const off of this.offs) off();
    this.offs = [];
    this.el.remove();
  }
}

// ---- the street map (MapLibre) ----------------------------------------------------------------------------

const EMPTY = { type: 'FeatureCollection', features: [] };

function feature(geometry, props) {
  return { type: 'Feature', properties: props, geometry };
}

function shapesData(m) {
  const f = [];
  if (m.ringNow) {
    f.push(feature(worldWithHole(m.ringNow), { part: 'dim' }));
    f.push(feature({ type: 'LineString', coordinates: closed(m.nowOutline) }, { part: 'ring' }));
  }
  if (m.fullOutline) f.push(feature({ type: 'LineString', coordinates: closed(m.fullOutline) }, { part: 'full' }));
  const d = m.draft;
  if (d) {
    if (d.fill) f.push(feature({ type: 'Polygon', coordinates: [d.fill] }, { part: 'dfill' }));
    if (d.line) f.push(feature({ type: 'LineString', coordinates: d.line }, { part: 'dline' }));
    if (d.close) f.push(feature({ type: 'LineString', coordinates: d.close }, { part: 'dclose' }));
  }
  return { type: 'FeatureCollection', features: f };
}

function routesData(m) {
  const f = [];
  for (const r of m.routes || []) {
    const coords = [];
    for (let i = 0; i < r.n; i++) coords.push([r.pts[i][0], r.pts[i][1]]);
    if (r.head) coords.push(r.head);
    if (coords.length >= 2) f.push(feature({ type: 'LineString', coordinates: coords }, { team: r.team }));
  }
  return { type: 'FeatureCollection', features: f };
}

class GlMap {
  constructor(lib, host, { interactive, onMove, onUserMove, onTap }) {
    this.kind = 'maplibre';
    this.interactive = interactive;
    this.styleReady = false;
    this.model = null;
    this.pushed = { shapes: null, routes: null, routesAt: 0 };
    // While it loads under the plain map it must not take the keyboard or a screen reader's attention.
    this.el = h('div.nmap-gl', { inert: true, 'aria-hidden': 'true' });
    host.prepend(this.el);
    const MapClass = lib.Map || (lib.default && lib.default.Map);
    if (typeof MapClass !== 'function') throw new Error('MapLibre has no Map');
    this.map = new MapClass({
      container: this.el,
      style: STYLE_URL,
      center: [0, 20],
      zoom: 1.5,
      interactive,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      keyboard: interactive,
      cooperativeGestures: false,
      doubleClickZoom: interactive,
      clickTolerance: 6,
      maxZoom: MAX_ZOOM,
      minZoom: 1,
      fadeDuration: 150,
    });
    const map = this.map;
    if (interactive) {
      try { map.touchZoomRotate.disableRotation(); } catch { /* older MapLibre */ }
      try { if (map.keyboard.disableRotation) map.keyboard.disableRotation(); } catch { /* older MapLibre */ }
    }
    map.on('move', () => onMove());
    map.on('resize', () => onMove());
    map.on('movestart', (e) => { if (e && e.originalEvent) onUserMove(); });
    map.on('click', (e) => { if (e && e.lngLat) onTap([e.lngLat.lng, e.lngLat.lat]); });
  }

  addLayers(colors) {
    const map = this.map;
    try { if (map.setProjection) map.setProjection({ type: 'mercator' }); } catch { /* fine */ }
    map.addSource('nightops-shapes', { type: 'geojson', data: EMPTY, tolerance: 0.2 });
    map.addSource('nightops-routes', { type: 'geojson', data: EMPTY, tolerance: 0.3 });
    const part = (p) => ['==', ['get', 'part'], p];
    const round = { 'line-join': 'round', 'line-cap': 'round' };
    map.addLayer({ id: 'nightops-dim', type: 'fill', source: 'nightops-shapes', filter: part('dim'), paint: { 'fill-color': '#000000', 'fill-opacity': 0.5 } });
    map.addLayer({
      id: 'nightops-routes', type: 'line', source: 'nightops-routes', layout: round,
      paint: { 'line-color': ['match', ['get', 'team'], 'hunter', colors.hunter, 'hider', colors.hider, colors.muted], 'line-width': 3, 'line-opacity': 0.9 },
    });
    map.addLayer({ id: 'nightops-full', type: 'line', source: 'nightops-shapes', filter: part('full'), layout: { 'line-join': 'round' }, paint: { 'line-color': colors.hider, 'line-width': 1.5, 'line-opacity': 0.55, 'line-dasharray': [3, 3] } });
    map.addLayer({ id: 'nightops-ring-glow', type: 'line', source: 'nightops-shapes', filter: part('ring'), layout: { 'line-join': 'round' }, paint: { 'line-color': colors.hider, 'line-width': 9, 'line-opacity': 0.18, 'line-blur': 4 } });
    map.addLayer({ id: 'nightops-ring-edge', type: 'line', source: 'nightops-shapes', filter: part('ring'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-width': 8, 'line-opacity': 0.55 } });
    map.addLayer({ id: 'nightops-ring', type: 'line', source: 'nightops-shapes', filter: part('ring'), layout: { 'line-join': 'round' }, paint: { 'line-color': colors.hider, 'line-width': 4 } });
    map.addLayer({ id: 'nightops-draft-fill', type: 'fill', source: 'nightops-shapes', filter: part('dfill'), paint: { 'fill-color': colors.hider, 'fill-opacity': 0.14 } });
    map.addLayer({ id: 'nightops-draft-line', type: 'line', source: 'nightops-shapes', filter: part('dline'), layout: round, paint: { 'line-color': colors.hider, 'line-width': 2.5 } });
    map.addLayer({ id: 'nightops-draft-close', type: 'line', source: 'nightops-shapes', filter: part('dclose'), layout: round, paint: { 'line-color': colors.hider, 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [1.5, 2] } });
    this.styleReady = true;
  }

  setModel(model) { this.model = model; }

  // Send what changed to MapLibre. True when routes are still waiting (they're sent at most every 100 ms).
  flush(now) {
    const m = this.model;
    if (!this.styleReady || !m) return false;
    const map = this.map;
    if (this.pushed.shapes !== m.shapesV) {
      this.pushed.shapes = m.shapesV;
      map.getSource('nightops-shapes')?.setData(shapesData(m));
    }
    if (this.pushed.routes !== m.routesV) {
      if (now - this.pushed.routesAt < ROUTES_EVERY_MS && m.routesThrottle) return true;
      this.pushed.routes = m.routesV;
      this.pushed.routesAt = now;
      map.getSource('nightops-routes')?.setData(routesData(m));
    }
    return false;
  }

  hasPlace() { return true; }
  project(p) {
    const pt = this.map.project(p);
    return [pt.x, pt.y];
  }
  unproject(xy) {
    const ll = this.map.unproject(xy);
    return [ll.lng, ll.lat];
  }
  pxPerMetre(lat) { return metresToPixels(1, lat, this.map.getZoom()); }
  getCenter() {
    const c = this.map.getCenter();
    return [c.lng, c.lat];
  }
  getZoom() { return this.map.getZoom(); }
  resize() { this.map.resize(); }
  setTapMode(on) {
    const dz = this.map.doubleClickZoom;
    if (!dz || !this.interactive) return;
    if (on) dz.disable(); else dz.enable();
  }
  jumpTo({ center, zoom }, animate = false) {
    if (!isPoint(center)) return;
    const opts = { center };
    if (Number.isFinite(zoom)) opts.zoom = Math.max(1, Math.min(MAX_ZOOM, zoom));
    if (animate) this.map.easeTo({ ...opts, duration: 500, essential: true });
    else this.map.jumpTo(opts);
  }
  fitBounds(bounds, pad, { animate = false, maxZoom = FIT_MAX_ZOOM } = {}) {
    this.map.fitBounds(bounds, { padding: pad, maxZoom, animate, duration: animate ? 600 : 0, essential: true });
  }
  destroy() {
    try { this.map.remove(); } catch { /* already gone */ }
    this.el.remove();
  }
}

// ---- the map controller -----------------------------------------------------------------------------------

export function createMap(container, { interactive = true } = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new Error('createMap needs a container element');

  const S = {
    destroyed: false,
    w: 0,
    h: 0,
    ring: null,
    ringNow: null,
    draft: null,
    routeLines: null,
    markOpts: {},
    people: null,
    ringSig: '',
    draftSig: '',
    tapFn: null,
    cameraSet: false,   // a screen or the player has placed the view: no more automatic placing
    autoLevel: 0,       // 1: placed on a mark, 2: placed on the ring or routes
    pendingCam: null,   // a fit/center waiting for the map to get a size
    shapesV: 0,
    routesV: 0,
    model: null,
    glSyncedAt: 0,
    glSyncedCam: -1,
    mode: 'plain',
    final: false,
    reduced: false,
    insets: { top: 0, right: 0, bottom: 0, left: 0 }, // v1.2: px hidden by the screen's own bars
    modeFns: new Set(),  // v1.2: onMode listeners
    clusterZ: null,      // the zoom the faces were last grouped at
    seenZ: null,         // the zoom the last frame was drawn at
    clusterTimer: 0,
    clusterAt: 0,
  };

  // Keep the container a positioning box for the map's layers.
  let madeRelative = false;
  try {
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
      madeRelative = true;
    }
  } catch { /* not in a document yet */ }

  const root = h('div.nmap', { 'data-mode': 'plain' });
  const areaSvg = svgNode('svg', { class: 'nmap-areas', 'aria-hidden': 'true', focusable: 'false' });
  const facesLayer = h('div.nmap-faces');
  const groupsLayer = h('div.nmap-groups'); // v1.2: the "+N" buttons of merged faces
  root.append(areaSvg, facesLayer, groupsLayer);
  container.appendChild(root);
  // v1.3 PAGE-SETUP: checkpoint spots go over the ring and the ping circles, under the faces
  const spotSvg = svgNode('svg', { class: 'nmap-spots', 'aria-hidden': 'true', focusable: 'false' });
  const spotLayer = h('div.nmap-spot-pins');
  root.insertBefore(spotSvg, facesLayer);
  root.insertBefore(spotLayer, facesLayer);
  // v1.3 end PAGE-SETUP
  // v1.4 PAGE-PLAY: team pins and the driver's pickup lines, over the ring, under the faces
  const pinSvg = svgNode('svg', { class: 'nmap-pinlines', 'aria-hidden': 'true', focusable: 'false' });
  const pinLayer = h('div.nmap-pins');
  root.insertBefore(pinSvg, facesLayer);
  root.insertBefore(pinLayer, facesLayer);
  // v1.4 end PAGE-PLAY

  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const cancel = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };
  const offs = [];

  // Reduced motion: no slides, no pulses (CSS does the pulses).
  let mql = null;
  try {
    mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    S.reduced = mql.matches;
    const onMql = () => { S.reduced = mql.matches; if (plain) plain.reduced = S.reduced; };
    if (mql.addEventListener) { mql.addEventListener('change', onMql); offs.push(() => mql.removeEventListener('change', onMql)); }
    else if (mql.addListener) { mql.addListener(onMql); offs.push(() => mql.removeListener(onMql)); }
  } catch { /* no matchMedia */ }

  let resolveReady;
  const ready = new Promise((res) => { resolveReady = res; });

  // ---- engines ----

  let gl = null;      // the street map, once made (while loading it sits hidden under the plain map)
  let plain = null;
  let active = null;

  function makePlain() {
    plain = new PlainMap(root, areaSvg, {
      interactive,
      onTap: (ll) => { if (active === plain) tapped(ll); },
      onUserMove: () => { S.cameraSet = true; userMoved(); }, // v1.4 PAGE-REEL: userMoved
      onChange: requestFrame,
    });
    plain.reduced = S.reduced;
    plain.setTapMode(!!S.tapFn);
    plain.resize(S.w, S.h);
    if (S.model) plain.setModel(S.model);
    return plain;
  }

  function tapped(ll) {
    if (S.tapFn && isPoint(ll)) S.tapFn([ll[0], ll[1]]);
  }

  // ---- size ----

  function measure() {
    const w = root.clientWidth;
    const hgt = root.clientHeight;
    sized(w, hgt);
  }

  function sized(w, hgt) {
    if (S.destroyed) return;
    const changed = w !== S.w || hgt !== S.h;
    S.w = w;
    S.h = hgt;
    if (plain) plain.resize(w, hgt);
    if (gl && changed) { try { gl.resize(); } catch { /* fine */ } }
    if (w > 0 && hgt > 0 && S.pendingCam) {
      const cmd = S.pendingCam;
      S.pendingCam = null;
      camera(cmd);
    }
    requestFrame();
  }

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      sized(Math.round(r.width), Math.round(r.height));
    });
    ro.observe(root);
  } else {
    offs.push(listen(window, 'resize', measure));
  }

  // ---- frames: read nothing, write once ----

  let raf = 0;
  function requestFrame() {
    if (!raf && !S.destroyed) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (S.destroyed) return;
    const now = performance.now();
    let again = false;
    if (plain && plain.frame(now)) again = true;
    if (gl && gl.flush(now)) again = true;
    if (gl && active === plain) syncHiddenGl(now);
    if (drawOverlay(now)) again = true;
    if (again) requestFrame();
  }

  // While the street map loads underneath, keep it looking where the plain map looks (so its tiles are ready).
  function syncHiddenGl(now) {
    if (!plain.hasPlace() || plain.camV === S.glSyncedCam || now - S.glSyncedAt < 250) return;
    S.glSyncedCam = plain.camV;
    S.glSyncedAt = now;
    try { gl.jumpTo({ center: plain.getCenter(), zoom: plain.getZoom() }); } catch { /* fine */ }
  }

  // ---- the street map: load, swap in, or give up ----

  function finish(mode) {
    if (S.final) return;
    S.final = true;
    S.mode = mode;
    root.dataset.mode = mode;
    if (mode === 'plain' && plain) plain.setFinal();
    resolveReady(mode);
    tellMode();
  }

  function tellMode() {
    for (const fn of [...S.modeFns]) { try { fn(S.mode); } catch (e) { console.error(e); } }
  }

  function dropGl() {
    if (!gl) return;
    const g = gl;
    gl = null;
    g.destroy();
  }

  function giveUp() {
    if (S.destroyed || S.final) return;
    dropGl();
    finish('plain');
  }

  async function startGl() {
    const deadline = later(giveUp, STYLE_WAIT_MS);
    if (!hasWebGL2()) { cancel(deadline); giveUp(); return; }
    let lib;
    try {
      lib = await import('../vendor/maplibre-gl.mjs?v=145');
    } catch {
      cancel(deadline);
      giveUp();
      return;
    }
    if (S.destroyed || S.final) return;
    try {
      gl = new GlMap(lib, root, {
        interactive,
        onMove: () => { if (active === gl) drawOverlay(performance.now()); },
        onUserMove: () => { if (active === gl) { S.cameraSet = true; userMoved(); } }, // v1.4 PAGE-REEL: userMoved
        onTap: (ll) => { if (active === gl) tapped(ll); },
      });
    } catch {
      cancel(deadline);
      gl = null;
      giveUp();
      return;
    }
    const map = gl.map;
    let styled = false;
    // Errors before the style loads (it can't be fetched, it's broken) mean no street map. Later ones are mostly a
    // tile that didn't come; the map keeps working without it, so they're swallowed (no console noise at night).
    map.on('error', () => { if (!styled) { cancel(deadline); giveUp(); } });
    map.once('style.load', () => {
      if (S.destroyed || S.final || !gl) return;
      styled = true;
      cancel(deadline);
      try {
        gl.addLayers(readColors());
        gl.setModel(S.model);
        gl.flush(performance.now());
      } catch {
        giveUp();
        return;
      }
      requestFrame();
      let swapped = false;
      const swap = () => {
        if (swapped || S.destroyed || S.final || !gl) return;
        if (plain && plain.busy()) { later(swap, 300); return; } // never pull the map from under a finger
        swapped = true;
        swapIn();
      };
      map.once('idle', swap);
      later(swap, SWAP_WAIT_MS);
    });
    watchContext(map);
  }

  function swapIn() {
    const hadFocus = plain && document.activeElement === plain.el;
    if (plain && plain.hasPlace()) {
      try { gl.jumpTo({ center: plain.getCenter(), zoom: plain.getZoom() }); } catch { /* fine */ }
    }
    try { gl.resize(); } catch { /* fine */ }
    gl.setTapMode(!!S.tapFn);
    gl.setModel(S.model);
    gl.el.removeAttribute('inert');
    gl.el.removeAttribute('aria-hidden');
    active = gl;
    if (plain) { plain.destroy(); plain = null; }
    finish('maplibre');
    gl.flush(performance.now());
    drawOverlay(performance.now());
    requestFrame();
    if (hadFocus) { try { gl.map.getCanvas().focus(); } catch { /* fine */ } }
  }

  // A lost WebGL context that doesn't come back (a phone short on memory) means the plain map from now on.
  function watchContext(map) {
    let lostTimer = 0;
    let lost = false;
    const arm = () => {
      cancel(lostTimer);
      lostTimer = later(() => {
        if (document.visibilityState === 'hidden') { arm(); return; }
        if (lost) fallBackToPlain();
      }, CONTEXT_WAIT_MS);
    };
    map.on('webglcontextlost', () => { lost = true; arm(); });
    map.on('webglcontextrestored', () => { lost = false; cancel(lostTimer); });
  }

  function fallBackToPlain() {
    if (S.destroyed || !gl) return;
    if (active !== gl) { giveUp(); return; }
    let center = null;
    let zoom = null;
    try { center = gl.getCenter(); zoom = gl.getZoom(); } catch { /* fine */ }
    makePlain();
    const main = S.ring || S.ringNow;
    plain.setOrigin(main ? ringCenter(main) : center);
    if (center) plain.jumpTo({ center, zoom });
    active = plain;
    dropGl();
    S.mode = 'plain';
    root.dataset.mode = 'plain';
    plain.setFinal();
    if (S.final) tellMode(); // (finish() tells it only the first time)
    finish('plain');
    requestFrame();
  }

  // ---- camera ----

  function camera(cmd) {
    if (!S.w || !S.h) { S.pendingCam = cmd; return; }
    const eng = active;
    const ins = S.insets;
    if (cmd.type === 'fit') {
      // v1.2: what the screen's bars hide is added to the padding, so the fit lands in what shows.
      const base = padBox(cmd.padding, S.w * 4, S.h * 4);
      const pad = padBox({
        top: base.top + ins.top, right: base.right + ins.right, bottom: base.bottom + ins.bottom, left: base.left + ins.left,
      }, S.w, S.h);
      const maxZoom = Number.isFinite(cmd.maxZoom) ? cmd.maxZoom : FIT_MAX_ZOOM;
      const b = cmd.bounds;
      if (eng === plain) {
        plain.fitBounds(b, pad, { animate: cmd.animate, maxZoom });
      } else {
        // A single point (or a tiny box) can't be "fitted": centre on it instead.
        if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) eng.jumpTo({ center: b[0], zoom: Math.min(maxZoom, DEFAULT_ZOOM) }, cmd.animate);
        else eng.fitBounds(b, pad, { animate: cmd.animate, maxZoom });
      }
    } else if (cmd.type === 'center') {
      eng.jumpTo({ center: shifted(cmd.point, cmd.zoom, eng), zoom: cmd.zoom }, cmd.animate);
    }
    requestFrame();
  }

  // v1.2: the map's centre that puts `point` in the middle of what the bars leave showing.
  function shifted(point, zoom, eng) {
    const ins = S.insets;
    const ox = (ins.left - ins.right) / 2;
    const oy = (ins.top - ins.bottom) / 2;
    if (!ox && !oy) return point;
    let z = Number.isFinite(zoom) ? zoom : null;
    if (z === null) { try { z = eng.hasPlace() ? eng.getZoom() : DEFAULT_ZOOM; } catch { z = DEFAULT_ZOOM; } }
    if (!Number.isFinite(z)) z = DEFAULT_ZOOM;
    const ppm = metresToPixels(1, point[1], z);
    if (!(ppm > 0)) return point;
    return fromLocal(point, [-ox / ppm, oy / ppm]);
  }

  // The middle of what shows, in px from the map's corner.
  function visibleMiddle() {
    const ins = S.insets;
    return [ins.left + Math.max(0, S.w - ins.left - ins.right) / 2, ins.top + Math.max(0, S.h - ins.top - ins.bottom) / 2];
  }

  function originFrom(p) {
    if (plain && !plain.hasPlace() && isPoint(p)) plain.setOrigin(p);
  }

  function autoPlace(cmd, level) {
    if (S.cameraSet || S.autoLevel >= level) return;
    S.autoLevel = level;
    camera({ ...cmd, animate: false });
  }

  // ---- shapes ----

  function rebuild({ shapes = false, routes = false, throttle = false } = {}) {
    const prev = S.model || {};
    const m = { ...prev };
    if (shapes) {
      const now = S.ringNow || S.ring;
      m.ringNow = now;
      m.nowOutline = now ? ringOutline(now) : null;
      m.fullOutline = S.ring && S.ringNow && ringAreaM2(S.ringNow) < ringAreaM2(S.ring) * 0.98 ? ringOutline(S.ring) : null;
      m.draft = draftParts(S.draft);
      m.shapesV = ++S.shapesV;
    }
    if (routes) {
      m.routes = S.routeLines;
      m.routesV = ++S.routesV;
      m.routesThrottle = throttle;
    }
    S.model = m;
    if (plain) plain.setModel(m);
    if (gl) gl.setModel(m);
    requestFrame();
  }

  // ---- overlay records: marks, replay heads, corner dots ----

  const recs = new Map();   // mark key -> rec
  const heads = new Map();  // player id -> rec
  let corners = [];         // corner dot elements, by index
  let centerDot = null;

  function place(rec, x, y) {
    const rx = Math.round(x * 10) / 10;
    const ry = Math.round(y * 10) / 10;
    if (rec.x === rx && rec.y === ry && rec.shown) return;
    rec.x = rx;
    rec.y = ry;
    if (!rec.shown) { rec.shown = true; rec.el.classList.remove('unplaced'); }
    rec.el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
  }

  function unplace(rec) {
    if (rec.shown === false) return;
    rec.shown = false;
    rec.el.classList.add('unplaced');
  }

  function posOf(rec, now) {
    const g = rec.glide;
    if (!g) return { p: rec.to, moving: false };
    const f = (now - g.t0) / g.ms;
    if (f >= 1) { rec.glide = null; return { p: rec.to, moving: false }; }
    return { p: lerpPoint(g.from, rec.to, easeOut(Math.max(0, f))), moving: true };
  }

  function drawRec(rec, now, eng) {
    const { p, moving } = posOf(rec, now);
    const xy = eng.project(p);
    if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) { unplace(rec); rec.rx = null; drawTether(rec, null); return moving; }
    // v1.2: a spread face sits off its spot (rec.off), with a thin stem back to it.
    rec.rx = xy[0];
    rec.ry = xy[1];
    const off = rec.off;
    place(rec, xy[0] + (off ? off.dx : 0), xy[1] + (off ? off.dy : 0));
    drawTether(rec, off ? xy : null);
    if (rec.circle) {
      const r = Math.max(MIN_AREA_PX, (rec.rM || 0) * eng.pxPerMetre(p[1]));
      const cx = Math.round(xy[0] * 10) / 10;
      const cy = Math.round(xy[1] * 10) / 10;
      const rr = Math.round(r * 10) / 10;
      const c = rec.circle;
      if (c._cx !== cx) { c._cx = cx; c.setAttribute('cx', cx); }
      if (c._cy !== cy) { c._cy = cy; c.setAttribute('cy', cy); }
      if (c._r !== rr) { c._r = rr; c.setAttribute('r', rr); }
      // "What they saw" sits above its circle, clear of the hider's own face and name in the middle.
      if (rec.kind === 'seen' && rec.labelR !== rr) {
        rec.labelR = rr;
        rec.labels.style.transform = `translate(-50%, ${-rr}px)`;
      }
    }
    return moving;
  }

  function drawOverlay(now) {
    const eng = active;
    if (!eng || S.destroyed) return false;
    let moving = false;
    for (const rec of recs.values()) if (drawRec(rec, now, eng)) moving = true;
    for (const rec of heads.values()) drawRec(rec, now, eng);
    drawSpots(eng); // v1.3 PAGE-SETUP
    drawPins(eng); // v1.4 PAGE-PLAY
    placeGroups();
    // v1.2: a new zoom (or size): group the faces again once it stands still.
    let z = null;
    try { z = eng.hasPlace() ? eng.getZoom() : null; } catch { z = null; }
    const zKey = Number.isFinite(z) ? `${Math.round(z * 50)}:${S.w}x${S.h}` : null;
    // (Re-armed only while the zoom keeps changing, so it fires once it stands still.)
    if (zKey !== null && zKey !== S.seenZ) {
      S.seenZ = zKey;
      if (zKey !== S.clusterZ) clusterSoon(CLUSTER_SETTLE_MS);
    }
    const d = S.model && S.model.draft;
    const pts = d ? d.corners : [];
    for (let i = 0; i < corners.length; i++) {
      const xy = pts[i] ? eng.project(pts[i]) : null;
      if (xy) place(corners[i], xy[0], xy[1]); else unplace(corners[i]);
    }
    if (centerDot) {
      const xy = d && d.center ? eng.project(d.center) : null;
      if (xy) place(centerDot, xy[0], xy[1]); else unplace(centerDot);
    }
    return moving;
  }

  // ---- v1.2: faces that would overlap ----

  const groupBtns = new Map(); // top rec key -> { el, n, rec, x, y }

  function drawTether(rec, real) {
    if (!real || !rec.off || !rec.shown) {
      if (rec.tether) { rec.tether.remove(); rec.tether = null; }
      return;
    }
    if (!rec.tether) {
      rec.tether = svgNode('g', { class: 'nmap-tether' });
      rec.tether.append(svgNode('line', {}), svgNode('circle', { r: 3.5 }));
      areaSvg.appendChild(rec.tether);
    }
    const [line, dot] = rec.tether.childNodes;
    const x1 = Math.round(real[0] * 10) / 10;
    const y1 = Math.round(real[1] * 10) / 10;
    const x2 = Math.round((real[0] + rec.off.dx) * 10) / 10;
    const y2 = Math.round((real[1] + rec.off.dy) * 10) / 10;
    const sig = `${x1},${y1},${x2},${y2}`;
    if (rec.tether._sig === sig) return;
    rec.tether._sig = sig;
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    dot.setAttribute('cx', x1); dot.setAttribute('cy', y1);
  }

  function placeGroups() {
    for (const g of groupBtns.values()) {
      const r = g.rec;
      if (!r.shown || !Number.isFinite(r.x)) { if (!g.el.hidden) g.el.hidden = true; continue; }
      if (g.el.hidden) g.el.hidden = false;
      // (An exact spot's face sits up on its stem: the button goes on the face, not the dot under it.)
      const y = r.y - (r.el && r.el.classList.contains('exact') ? 32 : 0);
      if (g.x === r.x && g.y === y) continue;
      g.x = r.x;
      g.y = y;
      g.el.style.transform = `translate3d(${r.x}px, ${y}px, 0)`;
    }
  }

  function clusterSoon(ms) {
    if (S.destroyed) return;
    cancel(S.clusterTimer);
    S.clusterTimer = later(() => { S.clusterTimer = 0; recluster(); }, ms);
  }

  // Groups every face on the map now (marks and the replay's heads), and shows it.
  function recluster() {
    const eng = active;
    if (!eng || S.destroyed) return;
    let z = null;
    try { z = eng.hasPlace() ? eng.getZoom() : null; } catch { z = null; }
    S.clusterZ = Number.isFinite(z) ? `${Math.round(z * 50)}:${S.w}x${S.h}` : null;
    S.clusterAt = performance.now();
    const all = new Map();
    const items = [];
    const add = (prefix, map) => {
      for (const [key, rec] of map) {
        const k = `${prefix}${key}`;
        all.set(k, rec);
        if (rec.leaving || !rec.shown || !Number.isFinite(rec.rx)) continue;
        // "What they saw" stays dim on its own circle, under the faces (it never moves or hides anyone).
        if (rec.kind === 'seen') continue;
        // An exact spot's face sits up on its stem: group it where the face is. An SOS is never grouped.
        const lift = rec.el.classList.contains('exact') ? 32 : 0;
        items.push({ key: k, x: rec.rx, y: rec.ry - lift, rank: rec.rank || 0, alone: rec.kind === 'sos' });
      }
    };
    add('m:', recs);
    add('r:', heads);
    const groups = clusterMarks(items, { near: 44, spreadMost: 3, ring: 30 });
    const placed = new Map(); // key -> { off, merged, hidden, keys }
    for (const g of groups) {
      if (g.spread) for (const s2 of g.spread) placed.set(s2.key, { off: { dx: s2.dx, dy: s2.dy }, merged: 0, hidden: false, keys: g.keys });
      else if (g.more) {
        for (const k of g.keys) placed.set(k, { off: null, merged: k === g.top ? g.more : 0, hidden: k !== g.top, keys: g.keys });
      }
    }
    const tops = new Set();
    for (const [k, rec] of all) {
      const p = placed.get(k) || { off: null, merged: 0, hidden: false, keys: null };
      const offSig = p.off ? `${p.off.dx},${p.off.dy}` : '';
      if ((rec.offSig || '') !== offSig) { rec.offSig = offSig; rec.off = p.off; }
      rec.merged = p.merged;
      rec.grouped = p.keys && p.merged ? p.keys.map((kk) => all.get(kk)).filter(Boolean) : null;
      if (rec.el.classList.contains('grouped') !== p.hidden) rec.el.classList.toggle('grouped', p.hidden);
      if (rec.el.classList.contains('spread') !== !!p.off) rec.el.classList.toggle('spread', !!p.off);
      writeTag(rec);
      if (p.merged) { tops.add(k); groupButton(k, rec); }
    }
    for (const [k, g] of groupBtns) if (!tops.has(k) || all.get(k) !== g.rec) { g.el.remove(); groupBtns.delete(k); }
    spaceLabels(all, placed);
    drawOverlay(performance.now());
  }

  // Each shown face's labels go where they don't run into another's (placeLabels), measured now (not each frame).
  function spaceLabels(all, placed) {
    const items = [];
    const recsOf = new Map();
    for (const [k, rec] of all) {
      if (!rec.labels) continue;
      const p = placed.get(k);
      const hiddenNow = rec.leaving || !rec.shown || !Number.isFinite(rec.rx) || rec.kind === 'seen' || (p && p.hidden);
      if (hiddenNow) { if (rec.labels.dataset.at && rec.labels.dataset.at !== 'below') rec.labels.dataset.at = 'below'; continue; }
      const lift = rec.el.classList.contains('exact') ? 32 : 0;
      const half = rec.kind === 'sos' ? 26 : rec.el.classList.contains('me') ? 24 : 21;
      const off = p && p.off ? p.off : { dx: 0, dy: 0 };
      let w = 0;
      let hh = 0;
      try { w = rec.labels.offsetWidth || 0; hh = rec.labels.offsetHeight || 0; } catch { /* not laid out */ }
      items.push({
        key: k, x: rec.rx + off.dx, y: rec.ry + off.dy - lift, half,
        below: lift ? lift + 10 : half + 4, w, h: hh, rank: rec.kind === 'sos' ? 1000 : (rec.rank || 0) + (rec.merged ? 1 : 0),
        keep: rec.kind === 'sos',
      });
      recsOf.set(k, rec);
    }
    const at = placeLabels(items);
    for (const [k, where] of at) {
      const rec = recsOf.get(k);
      if (rec && rec.labels.dataset.at !== where) rec.labels.dataset.at = where;
    }
  }

  function writeTag(rec) {
    const base = rec.baseTag || '';
    const words = rec.merged ? `${base || 'Someone'} +${rec.merged}` : base;
    text(rec.tagEl, words);
    show(rec.tagEl, !!words);
  }

  function groupButton(key, rec) {
    let g = groupBtns.get(key);
    if (!g) {
      const n = h('span.nmap-group-n');
      const el = h('button.nmap-group', { type: 'button' }, n);
      el.addEventListener('click', () => {
        const pts = (g.rec.grouped || []).map((r) => r.to).filter(isPoint);
        if (pts.length) fit(pts, { padding: 90, maxZoom: MAX_ZOOM - 0.5, animate: !S.reduced });
      });
      g = { el, n, rec, x: null, y: null };
      groupBtns.set(key, g);
      groupsLayer.appendChild(el);
    }
    g.rec = rec;
    cls2(g.el, 'me', rec.el.classList.contains('me') || rec.el.classList.contains('k-sos'));
    text(g.n, `+${rec.merged}`);
    const label = `${rec.baseTag || 'Someone'} and ${rec.merged} more here. Zoom in on them`;
    if (g.el.getAttribute('aria-label') !== label) g.el.setAttribute('aria-label', label);
  }

  function cls2(el, name, on) {
    if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
  }

  function faceSrc(faces, id) {
    if (!faces || id === undefined || id === null) return null;
    const v = typeof faces.get === 'function' ? faces.get(id) : faces[id];
    return typeof v === 'string' && v ? v : null;
  }

  function playersById(players) {
    const m = new Map();
    if (Array.isArray(players)) for (const p of players) if (p && p.id !== undefined) m.set(p.id, p);
    return m;
  }

  // What a mark shows: its name tag, chip, age, colour, size, and whether it's a button.
  function describe(mark, kind, people, opts) {
    const K = KINDS[kind];
    const person = people.get(mark.id);
    const name = String((person && person.name) || mark.label || '').trim();
    const me = kind === 'self' || (opts.meId !== undefined && opts.meId !== null && mark.id === opts.meId
      && (kind === 'hunter' || kind === 'hider'));
    let team = K.team;
    if (kind === 'self') {
      const viewer = people.get(opts.meId);
      team = viewer && viewer.team === 'hunter' ? 'hunter' : 'hider';
    }
    const age = Number.isFinite(mark.age) ? Math.max(0, mark.age) : 0;
    const stale = kind === 'hunter' && !me && age >= TIMING.OFFLINE_MS;
    let tag = name;
    if (kind === 'seen') tag = 'What they saw';
    else if (me) tag = 'You';
    else if (kind === 'sos') tag = name ? `SOS: ${name}` : 'SOS';
    const showsAge = !!K.age || stale;
    let tappable = false;
    if (typeof opts.onTap === 'function') {
      tappable = typeof opts.tappable === 'function' ? !!opts.tappable(mark) : TAPPABLE.has(kind) && !me;
    }
    let what = '';
    if (kind === 'ping') what = `pinged ${fmtAgo(age)}${mark.r > 0 ? `, within ${fmtDistance(mark.r)}` : ', exact spot'}`;
    else if (kind === 'radar') what = 'live on Radar';
    else if (kind === 'near') what = 'live, near the car'; // v1.1 PAGE-DRIVER
    else if (kind === 'exposure') what = 'exact spot from Exposure';
    else if (kind === 'outside') what = 'outside the ring, live';
    else if (kind === 'overstay') what = 'live, stayed at the checkpoint too long'; // v1.3 PAGE-PLAY
    else if (kind === 'offline') what = `offline, last seen ${fmtAgo(age)}`;
    else if (kind === 'seen') what = `what the hunters saw ${fmtAgo(age)}`;
    else if (kind === 'sos') what = 'needs help';
    else if (kind === 'hunter') what = me ? 'you, hunter' : 'hunter';
    else if (kind === 'hider' || kind === 'self') what = me ? 'you' : 'hider';
    return {
      kind,
      name,
      team,
      me,
      tag,
      chip: K.chip || '',
      chipKind: K.chipKind || '',
      showsAge,
      age,
      stale,
      size: kind === 'sos' ? MARK_SIZE.sos : me ? MARK_SIZE.me : MARK_SIZE.other,
      rank: markRank(kind, { me, age }),
      area: K.area || null,
      exact: !!K.exact,
      pulse: !!K.pulse,
      tappable,
      aria: `${name || 'Someone'}: ${what}${mark.driver ? ', driving the car' : ''}`, // v1.1 PAGE-DRIVER: the car
      driver: !!mark.driver, // v1.1 PAGE-DRIVER
    };
  }

  function makeRec(key, desc) {
    const rec = {
      key, el: null, hit: null, faceBox: null, labels: null, tagEl: null, chipEl: null, ageEl: null, circle: null,
      kind: desc.kind || '', labelR: null,
      to: null, glide: null, x: null, y: null, shown: null, leaving: 0, faceKey: '', tappable: desc.tappable,
      mark: null, ageBase: null, rM: 0,
      rank: desc.rank || 0, baseTag: '', off: null, offSig: '', merged: 0, grouped: null, tether: null, rx: null, ry: null, // v1.2
    };
    rec.faceBox = h('span.nmark-face');
    rec.hit = desc.tappable
      ? h('button.nmark-hit', { type: 'button', onclick: () => { const fn = S.markOpts.onTap; if (typeof fn === 'function' && rec.mark) fn(rec.mark); } }, rec.faceBox)
      : h('span.nmark-hit', rec.faceBox);
    rec.tagEl = h('span.nmark-tag');
    rec.chipEl = h('span.nmark-chip', { hidden: true });
    rec.ageEl = h('span.nmark-age', { hidden: true });
    rec.labels = h('span.nmark-labels', rec.tagEl, rec.chipEl, rec.ageEl);
    const body = h('span.nmark-body', h('span.nmark-dot'), h('span.nmark-stem'), rec.hit, rec.labels);
    rec.el = h('div.nmark.unplaced', desc.tappable ? null : { 'aria-hidden': 'true' }, body);
    rec.shown = false;
    facesLayer.appendChild(rec.el);
    return rec;
  }

  function dropRec(rec) {
    cancel(rec.leaving);
    rec.el.remove();
    if (rec.circle) rec.circle.remove();
    if (rec.tether) { rec.tether.remove(); rec.tether = null; } // v1.2
    for (const [k, g] of groupBtns) if (g.rec === rec) { g.el.remove(); groupBtns.delete(k); }
  }

  function leave(map, key, rec) {
    if (rec.leaving) return;
    if (S.reduced) { dropRec(rec); map.delete(key); return; }
    rec.el.classList.add('leaving');
    if (rec.circle) rec.circle.classList.add('leaving');
    rec.leaving = later(() => {
      rec.leaving = 0;
      dropRec(rec);
      if (map.get(key) === rec) map.delete(key);
    }, 240);
  }

  function revive(rec) {
    if (!rec.leaving) return;
    cancel(rec.leaving);
    rec.leaving = 0;
    rec.el.classList.remove('leaving');
    if (rec.circle) rec.circle.classList.remove('leaving');
  }

  function setFace(rec, desc, src) {
    const fk = `${desc.kind === 'sos' ? 'sos' : src || ''}|${desc.name}|${desc.team}|${desc.size}`;
    if (rec.faceKey === fk) return;
    rec.faceKey = fk;
    if (desc.kind === 'sos') {
      rec.faceBox.replaceChildren(h('span.nmark-sos', icon('sos', 26)));
    } else {
      rec.faceBox.replaceChildren(makeFace({ name: desc.name, src, team: desc.team, size: desc.size }));
    }
  }

  function updateRec(rec, mark, desc, now, opts) {
    rec.mark = mark;
    rec.kind = desc.kind;
    const cls = ['nmark', `k-${desc.kind}`, desc.team ? `t-${desc.team}` : 't-none'];
    if (desc.me) cls.push('me');
    if (desc.exact) cls.push('exact');
    if (desc.pulse) cls.push('pulse');
    if (desc.stale) cls.push('stale');
    if (desc.tappable) cls.push('tappable');
    if (desc.driver) cls.push('is-driver'); // v1.1 PAGE-DRIVER
    if (!rec.shown) cls.push('unplaced');
    if (rec.leaving) cls.push('leaving');
    if (rec.el.classList.contains('grouped')) cls.push('grouped'); // v1.2: kept until the faces are grouped again
    if (rec.off) cls.push('spread');
    rec.rank = desc.rank || 0;
    const className = cls.join(' ');
    if (rec.el.className !== className) rec.el.className = className;
    setFace(rec, desc, faceSrc(opts.faces, mark.id));
    // v1.1 PAGE-DRIVER: a car badge on the driver's face
    if (desc.driver && !rec.carEl) { rec.carEl = h('span.nmark-car', icon('car', 14)); rec.faceBox.after(rec.carEl); }
    if (rec.carEl) rec.carEl.hidden = !desc.driver;
    // v1.1 end PAGE-DRIVER
    rec.baseTag = desc.tag;
    writeTag(rec); // v1.2: "Ava +3" for a merged group
    text(rec.chipEl, desc.chip);
    show(rec.chipEl, !!desc.chip);
    if (rec.chipEl.dataset.kind !== desc.chipKind) rec.chipEl.dataset.kind = desc.chipKind;
    if (desc.tappable && rec.hit.getAttribute('aria-label') !== desc.aria) rec.hit.setAttribute('aria-label', desc.aria);

    // Ages tick on between views; a view that repeats the same age (the game is paused) stops them.
    if (desc.showsAge) {
      const prev = rec.ageBase;
      const frozen = !!opts.paused || (!!prev && prev.base === desc.age && desc.age > 0);
      rec.ageBase = { base: desc.age, at: now, frozen };
      show(rec.ageEl, true);
      writeAge(rec, now);
    } else {
      rec.ageBase = null;
      show(rec.ageEl, false);
    }

    // The ping / seen circle.
    if (desc.area) {
      if (!rec.circle) {
        rec.circle = svgNode('circle', { class: `narea ${desc.area}`, r: MIN_AREA_PX, cx: -999, cy: -999 });
        areaSvg.appendChild(rec.circle);
      }
      const want = `narea ${desc.area}${rec.leaving ? ' leaving' : ''}`;
      if (rec.circle.getAttribute('class') !== want) rec.circle.setAttribute('class', want);
      rec.rM = Number.isFinite(mark.r) && mark.r > 0 ? mark.r : 0;
    } else if (rec.circle) {
      rec.circle.remove();
      rec.circle = null;
    }

    // Slide to the new spot (unless it's a jump across the screen, or motion is reduced).
    const p = [mark.p[0], mark.p[1]];
    if (rec.to && (rec.to[0] !== p[0] || rec.to[1] !== p[1]) && !S.reduced && active) {
      const from = posOf(rec, now).p;
      const a = active.project(from);
      const b = active.project(p);
      const far = !a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.75 * Math.max(S.w, S.h, 1);
      rec.glide = far ? null : { from, t0: now, ms: GLIDE_MS };
    } else if (!rec.to) {
      rec.glide = null;
    }
    rec.to = p;
    if (active) drawRec(rec, now, active);
  }

  function writeAge(rec, now) {
    const a = rec.ageBase;
    if (!a) return;
    const ms = a.frozen ? a.base : a.base + Math.min(Math.max(0, now - a.at), AGE_DRIFT_MS);
    text(rec.ageEl, fmtAgo(ms));
  }

  let ticker = 0;
  function tick() {
    if (document.visibilityState === 'hidden') return;
    const now = performance.now();
    for (const rec of recs.values()) if (rec.ageBase) writeAge(rec, now);
  }
  function syncTicker() {
    let need = false;
    for (const rec of recs.values()) if (rec.ageBase && !rec.leaving) { need = true; break; }
    if (need && !ticker) ticker = setInterval(tick, 1000);
    else if (!need && ticker) { clearInterval(ticker); ticker = 0; }
  }

  // ---- public API ----

  function setRing(ring, ringNow) {
    if (S.destroyed) return;
    S.ring = validRing(ring);
    S.ringNow = validRing(ringNow);
    const main = S.ring || S.ringNow;
    const sig = JSON.stringify([S.ring, S.ringNow]);
    if (sig === S.ringSig) return;
    S.ringSig = sig;
    if (main && plain) {
      const c = ringCenter(main);
      if (isPoint(c)) plain.setOrigin(c);
    }
    rebuild({ shapes: true });
    if (main) autoPlace({ type: 'fit', bounds: ringBounds(main), padding: 32 }, 2);
  }

  function setMarks(marks, opts = {}) {
    if (S.destroyed) return;
    opts = opts && typeof opts === 'object' ? opts : {};
    S.markOpts = opts;
    const list = Array.isArray(marks) ? marks : [];
    const people = playersById(opts.players);
    if (people.size) S.people = people;
    const now = performance.now();
    const seen = new Set();
    let first = null;
    list.forEach((mark, i) => {
      if (!mark || typeof mark !== 'object' || !isPoint(mark.p)) return;
      const kind = Object.prototype.hasOwnProperty.call(KINDS, mark.kind) ? mark.kind : 'other';
      const key = markKey({ ...mark, kind }, i);
      if (seen.has(key)) return;
      seen.add(key);
      if (!first || (mark.id === opts.meId && opts.meId !== undefined)) first = mark.p;
      const desc = describe(mark, kind, people, opts);
      let rec = recs.get(key);
      if (rec && rec.tappable !== desc.tappable) { dropRec(rec); recs.delete(key); rec = null; }
      if (!rec) {
        rec = makeRec(key, desc);
        recs.set(key, rec);
      } else {
        revive(rec);
      }
      updateRec(rec, mark, desc, now, opts);
    });
    // z order by kind is CSS; DOM order follows the view's order so focus moves predictably.
    for (const [key, rec] of recs) if (!seen.has(key)) leave(recs, key, rec);
    syncTicker();
    clusterSoon(0); // v1.2: group the faces again (after this frame's placing)
    if (first) {
      originFrom(first);
      autoPlace({ type: 'center', point: first, zoom: DEFAULT_ZOOM }, 1);
    }
    requestFrame();
  }

  function setDraft(draft) {
    if (S.destroyed) return;
    S.draft = draft || null;
    let sig = '';
    try { sig = JSON.stringify(S.draft); } catch { sig = String(Math.random()); }
    if (sig === S.draftSig && S.model) return;
    S.draftSig = sig;
    rebuild({ shapes: true });
    const d = S.model.draft;
    const pts = d ? d.corners : [];
    if (d) originFrom(d.center || pts[0]);
    while (corners.length > pts.length) corners.pop().el.remove();
    while (corners.length < pts.length) {
      const n = corners.length + 1;
      const el = h('div.ncorner.unplaced', { 'aria-hidden': 'true' }, h('span', String(n)));
      if (n === 1) el.classList.add('first');
      facesLayer.appendChild(el);
      corners.push({ el, x: null, y: null, shown: false });
    }
    if (d && d.center) {
      if (!centerDot) {
        const el = h('div.ncorner.center.unplaced', { 'aria-hidden': 'true' }, h('span'));
        facesLayer.appendChild(el);
        centerDot = { el, x: null, y: null, shown: false };
      }
    } else if (centerDot) {
      centerDot.el.remove();
      centerDot = null;
    }
    if (active) drawOverlay(performance.now());
    requestFrame();
  }

  const routeCache = new WeakMap(); // routes object -> Map(id -> clean points)

  function setRoutes(routes, clockSeconds, opts = {}) {
    if (S.destroyed) return;
    opts = opts && typeof opts === 'object' ? opts : {};
    if (!routes || typeof routes !== 'object') {
      S.routeLines = null;
      for (const [id, rec] of heads) leave(heads, id, rec);
      rebuild({ routes: true });
      return;
    }
    let clean = routeCache.get(routes);
    if (!clean) {
      clean = new Map();
      for (const [id, pts] of Object.entries(routes)) {
        const c = cleanRoute(pts);
        if (c.length) clean.set(id, c);
      }
      routeCache.set(routes, clean);
    }
    const people = opts.players ? playersById(opts.players) : S.people || playersById(S.markOpts.players);
    const faces = opts.faces || S.markOpts.faces;
    const lines = [];
    const now = performance.now();
    const live = new Set();
    for (const [id, pts] of clean) {
      const person = people.get(id);
      const team = person ? person.startTeam || person.team || 'other' : 'other';
      const { n, head } = routeIndex(pts, clockSeconds);
      lines.push({ id, team, pts, n, head });
      if (!head) continue;
      live.add(id);
      let rec = heads.get(id);
      const name = String((person && person.name) || '').trim();
      const desc = { kind: 'route', name, team: team === 'hunter' || team === 'hider' ? team : 'out', size: ROUTE_FACE };
      if (!rec) {
        rec = makeRec(id, { tappable: false });
        heads.set(id, rec);
      } else {
        revive(rec);
      }
      // A hider goes red from the moment they're caught (caughtAt: game ms, from the round's results).
      const caught = person && Number.isFinite(person.caughtAt) && person.caughtAt <= clockSeconds * 1000 ? ' caught' : '';
      const className = `nmark k-route t-${desc.team}${caught}${rec.shown ? '' : ' unplaced'}`
        + `${rec.el.classList.contains('grouped') ? ' grouped' : ''}${rec.off ? ' spread' : ''}`; // v1.2
      if (rec.el.className !== className) rec.el.className = className;
      setFace(rec, desc, faceSrc(faces, id));
      rec.rank = markRank('route');
      rec.baseTag = name;
      writeTag(rec);
      rec.to = head;
      rec.glide = null;
    }
    for (const [id, rec] of heads) if (!live.has(id)) leave(heads, id, rec);
    S.routeLines = lines;
    rebuild({ routes: true, throttle: true });
    if (!S.ring && !S.ringNow) {
      const all = [];
      for (const pts of clean.values()) for (const p of pts) all.push(p);
      if (all.length) {
        originFrom(all[0]);
        autoPlace({ type: 'fit', bounds: boundsOf(all), padding: 40 }, 2);
      }
    }
    if (active) for (const rec of heads.values()) drawRec(rec, now, active);
    // v1.2: the replay's faces move every frame: grouped again at most every CLUSTER_ROUTES_MS
    if (!S.clusterTimer) clusterSoon(Math.max(0, CLUSTER_ROUTES_MS - (now - S.clusterAt)));
    requestFrame();
  }

  function onTap(fn) {
    if (S.destroyed) return () => {};
    S.tapFn = typeof fn === 'function' ? fn : null;
    if (plain) plain.setTapMode(!!S.tapFn);
    if (gl) gl.setTapMode(!!S.tapFn);
    const mine = S.tapFn;
    return () => {
      if (S.tapFn !== mine || S.destroyed) return;
      S.tapFn = null;
      if (plain) plain.setTapMode(false);
      if (gl) gl.setTapMode(false);
    };
  }

  function fit(what, opts = {}) {
    if (S.destroyed) return;
    opts = opts && typeof opts === 'object' ? opts : {};
    const bounds = toBounds(what);
    if (!bounds) return;
    originFrom([(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]);
    const animate = opts.animate !== undefined ? !!opts.animate : S.cameraSet && !S.reduced;
    S.cameraSet = true;
    camera({ type: 'fit', bounds, padding: opts.padding, maxZoom: opts.maxZoom, animate });
  }

  function center(point, zoom, opts = {}) {
    if (S.destroyed || !isPoint(point)) return;
    if (zoom && typeof zoom === 'object') { opts = zoom; zoom = undefined; }
    opts = opts && typeof opts === 'object' ? opts : {};
    originFrom(point);
    const animate = opts.animate !== undefined ? !!opts.animate : S.cameraSet && !S.reduced;
    S.cameraSet = true;
    camera({ type: 'center', point: [point[0], point[1]], zoom: Number.isFinite(zoom) ? zoom : undefined, animate });
  }

  // ---- v1.2: the big map's calls ----

  function setInsets(ins = {}) {
    if (S.destroyed) return;
    const n = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const next = { top: n(ins && ins.top), right: n(ins && ins.right), bottom: n(ins && ins.bottom), left: n(ins && ins.left) };
    const was = S.insets;
    if (was.top === next.top && was.right === next.right && was.bottom === next.bottom && was.left === next.left) return;
    S.insets = next;
    // The credits and the scale bar keep clear of the bars.
    root.style.setProperty('--map-inset-top', `${next.top}px`);
    root.style.setProperty('--map-inset-bottom', `${next.bottom}px`);
  }

  // The ring and every mark's spot (with its circle): what "Fit everyone" shows.
  function allBounds({ ring = null, marks = null } = {}) {
    const pts = [];
    const r = validRing(ring) || S.ringNow || S.ring;
    const rb = r ? ringBounds(r) : null;
    if (rb) pts.push(rb[0], rb[1]);
    const list = Array.isArray(marks) ? marks : [...recs.values()].filter((x) => !x.leaving && x.mark).map((x) => x.mark);
    for (const m of list) {
      if (!m || !isPoint(m.p)) continue;
      const rm = Number.isFinite(m.r) && m.r > 0 ? Math.min(m.r, 5000) : 0;
      if (rm) {
        const dLat = rm / 111320;
        const dLng = rm / (111320 * Math.max(0.05, Math.cos(m.p[1] * RAD)));
        pts.push([m.p[0] - dLng, m.p[1] - dLat], [m.p[0] + dLng, m.p[1] + dLat]);
      } else pts.push(m.p);
    }
    for (const rec of heads.values()) if (!rec.leaving && isPoint(rec.to)) pts.push(rec.to);
    return pts.length ? boundsOf(pts) : null;
  }

  function fitAll(opts = {}) {
    if (S.destroyed) return false;
    opts = opts && typeof opts === 'object' ? opts : {};
    const b = allBounds(opts);
    if (!b) return false;
    fit(b, { padding: Number.isFinite(opts.padding) ? opts.padding : 36, animate: opts.animate !== undefined ? opts.animate : !S.reduced, maxZoom: opts.maxZoom });
    return true;
  }

  function zoomBy(step) {
    if (S.destroyed || !Number.isFinite(step) || !step || !active || !active.hasPlace()) return;
    S.cameraSet = true;
    userMoved(); // v1.4 PAGE-REEL: the +/- buttons are the person's move
    const [mx, my] = visibleMiddle();
    if (active === plain) {
      plain.zoomAround(2 ** step, mx, my, !S.reduced);
    } else if (gl && active === gl) {
      try {
        const z = Math.max(1, Math.min(MAX_ZOOM, gl.getZoom() + step));
        gl.map.easeTo({ zoom: z, around: gl.map.unproject([mx, my]), duration: S.reduced ? 0 : 300, essential: true });
      } catch { /* fine */ }
    }
    requestFrame();
  }

  // v1.4 PAGE-REEL: map.onUserMove(fn) -> off(): a drag, pinch, wheel, double-tap, +/- or keys by the person
  const userFns = new Set();
  function userMoved() {
    for (const fn of [...userFns]) { try { fn(); } catch { /* a listener's problem */ } }
  }
  function onUserMove(fn) {
    if (S.destroyed || typeof fn !== 'function') return () => {};
    userFns.add(fn);
    return () => { userFns.delete(fn); };
  }
  // v1.4 end PAGE-REEL

  function onMode(fn) {
    if (S.destroyed || typeof fn !== 'function') return () => {};
    S.modeFns.add(fn);
    return () => { S.modeFns.delete(fn); };
  }

  function destroy() {
    if (S.destroyed) return;
    S.destroyed = true;
    S.modeFns.clear();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ticker) clearInterval(ticker);
    ticker = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    if (ro) ro.disconnect();
    for (const off of offs) off();
    dropGl();
    if (plain) plain.destroy();
    plain = null;
    active = null;
    root.remove();
    if (madeRelative) container.style.position = '';
    if (!S.final) { S.final = true; resolveReady(S.mode); }
  }

  // v1.3 PAGE-SETUP: checkpoint spots. setSpots(list) draws each as a circle in metres and a round numbered badge
  // (a suggestion: a small hollow pin, no circle); onSpotTap(fn(key)) makes the badges and pins buttons.
  const spotRecs = new Map(); // key -> { spot, circle, el, hit, badge, nameEl, x, y, shown }
  let spotTapFn = null;

  function spotLabelOn(spot) {
    return spot.label !== false && (spot.state === 'active' || spot.state === 'suggest' || spot.state === 'draft');
  }

  function spotAria(spot) {
    const name = spot.name || 'a spot';
    if (spot.state === 'suggest') return `Suggested: ${name}. Add it`;
    const words = { active: 'open now', soon: 'opening soon', done: 'done', closed: 'closed', draft: 'not saved yet' }[spot.state];
    return `Checkpoint ${spot.n}: ${name}${words ? `, ${words}` : ''}${spot.mine ? ', you did it' : ''}`;
  }

  function writeSpot(rec) {
    const sp = rec.spot;
    const tappable = !!spotTapFn;
    rec.el.className = `nspot s-${sp.state}${sp.mine ? ' mine' : ''}${tappable ? ' tap' : ''}${rec.shown ? '' : ' unplaced'}`;
    if (tappable) {
      rec.el.removeAttribute('aria-hidden');
      rec.hit.tabIndex = 0;
      rec.hit.setAttribute('aria-label', spotAria(sp));
    } else {
      rec.el.setAttribute('aria-hidden', 'true');
      rec.hit.tabIndex = -1;
      rec.hit.removeAttribute('aria-label');
    }
    const face = sp.state === 'suggest' ? '' : sp.mine ? 'tick' : String(sp.n);
    if (rec.face !== face) {
      rec.face = face;
      if (face === 'tick') rec.badge.replaceChildren(icon('check', 16));
      else rec.badge.textContent = face;
    }
    text(rec.nameEl, sp.name || '');
    rec.nameEl.hidden = !spotLabelOn(sp) || !sp.name;
    rec.circle.setAttribute('class', `nspot-zone s-${sp.state}`);
  }

  function setSpots(list) {
    if (S.destroyed) return;
    const seen = new Set();
    let i = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      i++;
      if (!raw || typeof raw !== 'object' || !isPoint(raw.p)) continue;
      const key = String(raw.key ?? `s${i}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const state = ['active', 'soon', 'done', 'closed', 'suggest', 'draft'].includes(raw.state) ? raw.state : 'soon';
      const r = Number.isFinite(raw.r) && raw.r > 0 ? Math.min(raw.r, 5000) : 0;
      const spot = {
        key, p: [raw.p[0], raw.p[1]], r, n: Number.isFinite(raw.n) ? raw.n : i, state,
        name: typeof raw.name === 'string' ? raw.name : '', mine: !!raw.mine, label: raw.label,
      };
      let rec = spotRecs.get(key);
      if (!rec) {
        const badge = h('span.nspot-badge');
        const nameEl = h('span.nspot-name');
        const hit = h('button.nspot-hit', { type: 'button', tabindex: '-1' }, badge);
        hit.addEventListener('click', (e) => {
          e.stopPropagation();
          if (spotTapFn) { try { spotTapFn(rec.spot.key); } catch (err) { console.error(err); } }
        });
        const el = h('div.nspot.unplaced', { 'aria-hidden': 'true' }, hit, nameEl);
        const circle = svgNode('circle', { class: 'nspot-zone', cx: -999, cy: -999, r: 0 });
        rec = { spot, circle, el, hit, badge, nameEl, face: null, x: null, y: null, shown: false };
        spotRecs.set(key, rec);
        spotSvg.appendChild(circle);
        spotLayer.appendChild(el);
      }
      rec.spot = spot;
      writeSpot(rec);
    }
    for (const [key, rec] of spotRecs) {
      if (seen.has(key)) continue;
      rec.el.remove();
      rec.circle.remove();
      spotRecs.delete(key);
    }
    // The badges in number order, so focus moves 1, 2, 3...; suggestions after them.
    const order = [...spotRecs.values()].sort((a, b) => (a.spot.state === 'suggest') - (b.spot.state === 'suggest') || a.spot.n - b.spot.n);
    // (Only when the order changed: moving an element starts its fade-in again.)
    const now = [...spotLayer.children];
    if (now.length !== order.length || order.some((rec, i) => now[i] !== rec.el)) {
      for (const rec of order) spotLayer.appendChild(rec.el);
    }
    if (active) drawSpots(active);
    requestFrame();
  }

  function drawSpots(eng) {
    for (const rec of spotRecs.values()) {
      const sp = rec.spot;
      const xy = eng.project(sp.p);
      if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) {
        if (rec.shown) { rec.shown = false; rec.el.classList.add('unplaced'); }
        rec.circle.setAttribute('r', '0');
        continue;
      }
      place(rec, xy[0], xy[1]);
      const rr = sp.state === 'suggest' ? 0 : Math.round(sp.r * eng.pxPerMetre(sp.p[1]) * 10) / 10;
      const cx = Math.round(xy[0] * 10) / 10;
      const cy = Math.round(xy[1] * 10) / 10;
      if (rec.circle._cx !== cx) { rec.circle._cx = cx; rec.circle.setAttribute('cx', cx); }
      if (rec.circle._cy !== cy) { rec.circle._cy = cy; rec.circle.setAttribute('cy', cy); }
      if (rec.circle._r !== rr) { rec.circle._r = rr; rec.circle.setAttribute('r', rr); }
    }
  }

  function onSpotTap(fn) {
    if (S.destroyed) return () => {};
    spotTapFn = typeof fn === 'function' ? fn : null;
    for (const rec of spotRecs.values()) writeSpot(rec);
    const mine = spotTapFn;
    return () => {
      if (spotTapFn !== mine || S.destroyed) return;
      spotTapFn = null;
      for (const rec of spotRecs.values()) writeSpot(rec);
    };
  }
  // v1.3 end PAGE-SETUP

  // v1.4 PAGE-PLAY: setPins([{ key, p, kind: 'seen'|'go'|'driver'|'pickup', label, sub, big, from, line }]) draws
  // each as a teardrop with its words; `from` (a point) adds a straight line to it with `line` ("300 m") halfway.
  // onPinTap(fn(key)) makes them buttons.
  const pinRecs = new Map();
  let pinTapFn = null;
  const PIN_KIND_LIST = ['seen', 'go', 'driver', 'pickup'];

  function writePin(rec) {
    const pn = rec.pin;
    rec.el.className = `npin k-${pn.kind}${pn.big ? ' big' : ''}${pinTapFn ? ' tap' : ''}${rec.shown ? '' : ' unplaced'}`;
    rec.hit.tabIndex = pinTapFn ? 0 : -1;
    rec.hit.setAttribute('aria-label', [pn.label, pn.sub].filter(Boolean).join(', ') || 'Pin');
    text(rec.labelEl, pn.label || '');
    text(rec.subEl, pn.sub || '');
    rec.subEl.hidden = !pn.sub;
    text(rec.lineText, pn.line || '');
  }

  function setPins(list) {
    if (S.destroyed) return;
    const seen = new Set();
    let i = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      i++;
      if (!raw || typeof raw !== 'object' || !isPoint(raw.p)) continue;
      const key = String(raw.key ?? `p${i}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const pin = {
        key, p: [raw.p[0], raw.p[1]], kind: PIN_KIND_LIST.includes(raw.kind) ? raw.kind : 'go',
        label: typeof raw.label === 'string' ? raw.label : '', sub: typeof raw.sub === 'string' ? raw.sub : '',
        big: !!raw.big, from: isPoint(raw.from) ? [raw.from[0], raw.from[1]] : null,
        line: typeof raw.line === 'string' ? raw.line : '',
      };
      let rec = pinRecs.get(key);
      if (!rec) {
        const head = h('span.npin-head', { 'aria-hidden': 'true' });
        const labelEl = h('span.npin-label');
        const subEl = h('span.npin-sub');
        const hit = h('button.npin-hit', { type: 'button', tabindex: '-1' }, head);
        hit.addEventListener('click', (e) => {
          e.stopPropagation();
          if (pinTapFn) { try { pinTapFn(rec.pin.key); } catch (err) { console.error(err); } }
        });
        const el = h('div.npin.unplaced', hit, h('span.npin-words', labelEl, subEl));
        const line = svgNode('line', { class: 'npin-line', x1: -999, y1: -999, x2: -999, y2: -999 });
        const lineText = h('span.npin-dist.unplaced');
        rec = { pin, el, hit, head, labelEl, subEl, line, lineText, x: null, y: null, shown: false, lt: { el: lineText, shown: false } };
        pinRecs.set(key, rec);
        pinSvg.appendChild(line);
        pinLayer.append(el, lineText);
      }
      rec.pin = pin;
      writePin(rec);
    }
    for (const [key, rec] of pinRecs) {
      if (seen.has(key)) continue;
      rec.el.remove();
      rec.line.remove();
      rec.lineText.remove();
      pinRecs.delete(key);
    }
    if (active) drawPins(active);
    requestFrame();
  }

  function drawPins(eng) {
    for (const rec of pinRecs.values()) {
      const pn = rec.pin;
      const xy = eng.project(pn.p);
      if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) {
        unplace(rec);
        unplace(rec.lt);
        rec.line.setAttribute('x1', -999);
        rec.line.setAttribute('x2', -999);
        continue;
      }
      place(rec, xy[0], xy[1]);
      const fxy = pn.from ? eng.project(pn.from) : null;
      if (fxy && Number.isFinite(fxy[0])) {
        rec.line.setAttribute('x1', Math.round(fxy[0]));
        rec.line.setAttribute('y1', Math.round(fxy[1]));
        rec.line.setAttribute('x2', Math.round(xy[0]));
        rec.line.setAttribute('y2', Math.round(xy[1]));
        if (pn.line) place(rec.lt, (fxy[0] + xy[0]) / 2, (fxy[1] + xy[1]) / 2); else unplace(rec.lt);
      } else {
        rec.line.setAttribute('x1', -999);
        rec.line.setAttribute('x2', -999);
        unplace(rec.lt);
      }
    }
  }

  function onPinTap(fn) {
    if (S.destroyed) return () => {};
    pinTapFn = typeof fn === 'function' ? fn : null;
    for (const rec of pinRecs.values()) writePin(rec);
    const mine = pinTapFn;
    return () => {
      if (pinTapFn !== mine || S.destroyed) return;
      pinTapFn = null;
      for (const rec of pinRecs.values()) writePin(rec);
    };
  }
  // v1.4 end PAGE-PLAY

  // ---- start ----

  makePlain();
  active = plain;
  measure();
  startGl();

  return {
    ready,
    mode: () => S.mode,
    setRing,
    setMarks,
    setDraft,
    onTap,
    fit,
    center,
    setRoutes,
    setSpots, onSpotTap, // v1.3 PAGE-SETUP
    setPins, onPinTap, // v1.4 PAGE-PLAY
    setInsets,
    fitAll,
    zoomBy,
    onMode,
    onUserMove, // v1.4 PAGE-REEL
    destroy,
    resize: () => { if (!S.destroyed) measure(); },
    getCenter: () => (active && active.hasPlace() ? active.getCenter() : null),
    getZoom: () => (active && active.hasPlace() ? active.getZoom() : null),
    project: (p) => (active && isPoint(p) ? active.project(p) : null),
    unproject: (xy) => (active && Array.isArray(xy) ? active.unproject(xy) : null),
    element: root,
  };
}
