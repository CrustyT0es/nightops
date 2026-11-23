// Night Ops v1.4.8: the driver's turn-by-turn, the parts the server and the page share. Pure: no DOM, no I/O,
// no clock or randomness of its own (every time comes in as an argument), so both sides and the tests agree.
//
// A route (what the server's `route` action answers, and what the page draws and follows):
//   { v: 1, key: 'pickup:k1' | 'pin:p3' | 'hunters', by: 'valhalla' | 'osrm' | 'stub', made: epoch,
//     points: [[lng, lat], ...]          the road line, 2..NAV.POINTS_MOST points
//     distance: metres, time: seconds    the whole way
//     maneuvers: [ { type, instruction, street, distance, time, point, i } ]
//                                         type: one of TURN_TYPES; instruction: words to show ("Turn right onto
//                                         Queen Street"); street: the road it leads onto ('' when unnamed);
//                                         distance / time: from this maneuver to the next one; point: where it
//                                         is; i: its index in `points`
//     to: [lng, lat] }                    the place asked for (a pickup off the road is past the line's end)
// A destination ("where to"): { kind: 'pickup', id } | { kind: 'pin', id } | { kind: 'hunters' }. The point and
// the name come from the driver's own view (navTarget), which never holds a hider's spot (CONTRACT v1.4 G), so
// nothing about a route ever involves a hider.
import { isPoint, distanceM, toLocal, bearingDeg, compassWord } from './geo.js?v=175';
import { tidyText } from './rules.js?v=175';

export const NAV = Object.freeze({
  OFF_M: 40,               // the car this far from the route...
  OFF_MS: 10000,           // ...for this long: a new route (the server checks both on its own stored fixes)
  OFF_SEEN_MS: 8000,       // the server's "off since" keeps only while the page reports it at least this often
  ASK_OFF_MS: 5000,        // the page reports being off the route this often
  OFF_GLITCH_MS: 2000,     // the page waits this long before reporting (one bad fix isn't "off the route")
  REROUTE_GAP_MS: 20000,   // a game gets a new route for a place it already had one for at most this often...
  NEW_GAP_MS: 4000,        // ...and a route to a place it never had one for at most this often
  ROUTES_MOST: 60,         // routes asked of the routing servers in one round (then straight-line directions)
  MOVED_M: 75,             // the place moved this far from the route's end (a hunter walking): a new route
  ARRIVE_M: 30,            // this close to the place (or the route's end): arrived
  FIX_MS: 30000,           // the car's stored fix must be this fresh to route from it
  HUNTER_FIX_MS: 180000,   // a hunter's mark this old still counts for "the hunters"
  POINTS_MOST: 1500,       // points kept in a route (thinned past this)
  MANEUVERS_MOST: 120,     // maneuvers kept in a route
  WORDS_MOST: 140,         // letters in an instruction or a street name
});

// The turns the page has an arrow for. Anything else a routing server says becomes 'straight'.
export const TURN_TYPES = Object.freeze([
  'depart', 'straight', 'slight-right', 'right', 'sharp-right', 'uturn', 'sharp-left', 'left', 'slight-left',
  'keep-right', 'keep-left', 'merge', 'roundabout', 'arrive',
]);

const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---- destinations ----------------------------------------------------------------------------------------

export function destKey(to) {
  if (!to || typeof to !== 'object') return '';
  if (to.kind === 'hunters') return 'hunters';
  if ((to.kind === 'pickup' || to.kind === 'pin') && typeof to.id === 'string' && /^[a-z][0-9]{1,6}$/.test(to.id)) return `${to.kind}:${to.id}`;
  return '';
}

// A destination from what a phone sent: { kind, id? } or null.
export function cleanDest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = destKey(raw);
  if (!key) return null;
  return raw.kind === 'hunters' ? { kind: 'hunters' } : { kind: raw.kind, id: raw.id };
}

// The middle of points (a few hundred metres apart at most: plain averaging is fine).
function middleOf(points) {
  if (!points.length) return null;
  let x = 0;
  let y = 0;
  for (const p of points) { x += p[0]; y += p[1]; }
  return [round6(x / points.length), round6(y / points.length)];
}

// Where a destination is, from the DRIVER'S OWN VIEW only: { key, p, name, label, kind } or null when it isn't on
// their map (any more). Pickups (open or on the way) by id; pins of kind 'driver' (Driver: go here) or 'go' by id
// (never 'seen', which the driver's view doesn't hold either); "the hunters" = the middle of the other hunters'
// live marks (never the driver's own). Used by the server to check a request and by the page to follow it.
export function navTarget(view, to) {
  const key = destKey(to);
  if (!key || !view || typeof view !== 'object') return null;
  const me = view.me && typeof view.me === 'object' ? view.me : {};
  if (to.kind === 'pickup') {
    const list = view.drive && Array.isArray(view.drive.pickups) ? view.drive.pickups : [];
    const k = list.find((x) => x && x.id === to.id && (x.state === 'open' || x.state === 'coming'));
    if (!k || !isPoint(k.p)) return null;
    const name = String(k.name || 'Someone');
    return { key, kind: 'pickup', id: k.id, p: [k.p[0], k.p[1]], name, label: `${name}'s pickup`, state: k.state };
  }
  if (to.kind === 'pin') {
    const list = Array.isArray(view.pins) ? view.pins : [];
    const pin = list.find((x) => x && x.id === to.id && (x.kind === 'driver' || x.kind === 'go') && isPoint(x.p)
      && !(Number.isFinite(x.left) && x.left <= 0));
    if (!pin) return null;
    const name = String(pin.name || 'A hunter');
    return { key, kind: 'pin', id: pin.id, p: [pin.p[0], pin.p[1]], name, label: `${name}'s pin`, pinKind: pin.kind };
  }
  // the hunters
  const ids = new Set((Array.isArray(view.players) ? view.players : [])
    .filter((p) => p && p.team === 'hunter' && p.status === 'in' && !p.driver && p.id !== me.id).map((p) => p.id));
  const spots = (Array.isArray(view.marks) ? view.marks : [])
    .filter((m) => m && m.kind === 'hunter' && ids.has(m.id) && isPoint(m.p) && !(Number.isFinite(m.age) && m.age > NAV.HUNTER_FIX_MS))
    .map((m) => m.p);
  const p = middleOf(spots);
  if (!p) return null;
  return { key, kind: 'hunters', p, name: 'The hunters', label: 'the hunters', count: spots.length };
}

// ---- polylines (Google's encoding; Valhalla and OSRM both use it with 6 decimals) ------------------------

// -> [[lng, lat], ...] ([] for anything that isn't a polyline).
export function decodePolyline(str, precision = 6) {
  if (typeof str !== 'string' || !str || str.length > 400000) return [];
  const f = 10 ** precision;
  const out = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b;
    do {
      if (i >= str.length) return null;
      b = str.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };
  while (i < str.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) return [];
    lat += dLat;
    lng += dLng;
    const p = [round6(lng / f), round6(lat / f)];
    if (!isPoint(p)) return [];
    out.push(p);
  }
  return out;
}

export function encodePolyline(points, precision = 6) {
  const f = 10 ** precision;
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const put = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const p of points || []) {
    const lat = Math.round(p[1] * f);
    const lng = Math.round(p[0] * f);
    put(lat - pLat);
    put(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

// ---- words -----------------------------------------------------------------------------------------------

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

// A line of a routing server's (or a person's) words, made safe to show and say: plain letters, no control
// characters, at most NAV.WORDS_MOST letters, no full stop at the end.
export function cleanWords(s) {
  if (typeof s !== 'string') return '';
  const t = tidyText(s.slice(0, 1000));
  return Array.from(t).slice(0, NAV.WORDS_MOST).join('').replace(/[.\s]+$/, '');
}

// Our own words for a turn, when a routing server gives none: "Turn right onto Queen Street".
export function turnWords(type, street = '', { exit = 0, dir = '' } = {}) {
  const onto = street ? ` onto ${street}` : '';
  switch (type) {
    case 'depart': return `Head${dir ? ` ${dir}` : ''}${street ? ` on ${street}` : ''}`;
    case 'arrive': return 'Arrive at the destination';
    case 'right': return `Turn right${onto}`;
    case 'left': return `Turn left${onto}`;
    case 'slight-right': return `Bear right${onto}`;
    case 'slight-left': return `Bear left${onto}`;
    case 'sharp-right': return `Turn sharp right${onto}`;
    case 'sharp-left': return `Turn sharp left${onto}`;
    case 'uturn': return `Make a U-turn${onto}`;
    case 'keep-right': return `Keep right${onto}`;
    case 'keep-left': return `Keep left${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'roundabout': return exit > 0 && exit <= ORDINALS.length
      ? `At the roundabout, take the ${ORDINALS[exit - 1]} exit${onto}` : `Go round the roundabout${onto}`;
    default: return street ? `Continue onto ${street}` : 'Continue';
  }
}

// ---- a route made safe (both sides use it: the server before answering, the page on what it got) --------

function numberOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Index into points of the point nearest p, searching from `from` on (maneuvers come in order).
function nearestIndex(points, p, from = 0) {
  let best = from;
  let bestD = Infinity;
  for (let i = Math.max(0, from); i < points.length; i++) {
    const d = Math.abs(points[i][0] - p[0]) + Math.abs(points[i][1] - p[1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Fewer points where they add nothing (closer than 2 m to the last kept one), and at most NAV.POINTS_MOST,
// keeping every maneuver's point. -> { points, map } (map: old index -> new index).
export function thinPoints(points, keep = []) {
  const must = new Set(keep.filter((i) => Number.isInteger(i)));
  must.add(0);
  must.add(points.length - 1);
  let kept = [];
  let last = null;
  for (let i = 0; i < points.length; i++) {
    if (must.has(i) || !last || distanceM(last, points[i]) >= 2) {
      kept.push(i);
      last = points[i];
    }
  }
  if (kept.length > NAV.POINTS_MOST) {
    const step = Math.ceil(kept.length / (NAV.POINTS_MOST - Math.min(must.size, NAV.POINTS_MOST / 2)));
    kept = kept.filter((i, n) => must.has(i) || n % step === 0);
  }
  const map = new Map();
  let j = 0;
  for (let i = 0; i < points.length; i++) {
    while (j < kept.length - 1 && kept[j + 1] <= i) j++;
    map.set(i, j);
  }
  return { points: kept.map((i) => [round6(points[i][0]), round6(points[i][1])]), map };
}

// A route as the rest of Night Ops may trust it, or null. Points must be real places; maneuvers get a known type,
// clean words, an index into the points and a point; the totals are numbers.
export function cleanRoute(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.points)) return null;
  let points = raw.points.filter((p) => isPoint(p)).map((p) => [round6(p[0]), round6(p[1])]);
  if (points.length < 2) return null;
  const rawMs = Array.isArray(raw.maneuvers) ? raw.maneuvers.slice(0, NAV.MANEUVERS_MOST * 4) : [];
  let from = 0;
  let ms = [];
  for (const m of rawMs) {
    if (!m || typeof m !== 'object') continue;
    const type = TURN_TYPES.includes(m.type) ? m.type : 'straight';
    let i = Number.isInteger(m.i) && m.i >= 0 && m.i < points.length ? m.i : null;
    if (i === null) i = isPoint(m.point) ? nearestIndex(points, m.point, from) : from;
    if (i < from) i = from;
    from = i;
    const street = cleanWords(m.street);
    const instruction = cleanWords(m.instruction) || turnWords(type, street);
    ms.push({
      type, instruction, street,
      distance: Math.round(numberOr(m.distance, 0)), time: Math.round(numberOr(m.time, 0)),
      point: points[i], i,
    });
  }
  // (At most MANEUVERS_MOST: the "straight" ones go first, they're only names changing.)
  if (ms.length > NAV.MANEUVERS_MOST) {
    const turns = ms.filter((m) => m.type !== 'straight');
    ms = (turns.length > NAV.MANEUVERS_MOST ? turns.slice(0, NAV.MANEUVERS_MOST - 1).concat(turns.slice(-1)) : turns);
  }
  if (points.length > NAV.POINTS_MOST) {
    const t = thinPoints(points, ms.map((m) => m.i));
    points = t.points;
    ms = ms.map((m) => ({ ...m, i: t.map.get(m.i), point: points[t.map.get(m.i)] }));
  }
  if (!ms.length || ms[ms.length - 1].type !== 'arrive') {
    ms.push({ type: 'arrive', instruction: turnWords('arrive'), street: '', distance: 0, time: 0, point: points[points.length - 1], i: points.length - 1 });
  }
  const along = pathLength(points);
  const out = {
    v: 1,
    key: typeof raw.key === 'string' ? raw.key.slice(0, 40) : '',
    by: ['valhalla', 'osrm', 'stub'].includes(raw.by) ? raw.by : 'valhalla',
    made: numberOr(raw.made, 0),
    points,
    distance: Math.round(numberOr(raw.distance, along)),
    time: Math.round(numberOr(raw.time, along / 8)),
    maneuvers: ms,
    to: isPoint(raw.to) ? [round6(raw.to[0]), round6(raw.to[1])] : points[points.length - 1],
  };
  return out;
}

function pathLength(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += distanceM(points[i - 1], points[i]);
  return m;
}

// ---- where the car is on a route ---------------------------------------------------------------------------

const CUM = new WeakMap(); // route.points -> metres from the start to each point

function cumOf(route) {
  let c = CUM.get(route.points);
  if (!c) {
    c = new Float64Array(route.points.length);
    for (let i = 1; i < route.points.length; i++) c[i] = c[i - 1] + distanceM(route.points[i - 1], route.points[i]);
    CUM.set(route.points, c);
  }
  return c;
}

// Metres from the route's start to its point i.
export function alongAt(route, i) {
  const c = cumOf(route);
  return c[Math.max(0, Math.min(c.length - 1, i))];
}

// Where p is on the route:
//   { along (m from the start), off (m from the line), seg (segment index), at (the nearest point on the line),
//     heading (the road's bearing there), next (index of the next maneuver, -1 when none), toNext (m),
//     left (m to the end), leftS (s to the end) }
// prevAlong (the last answer's along) keeps it going forward where a road passes the same place twice.
export function progress(route, p, prevAlong = null) {
  if (!route || !Array.isArray(route.points) || route.points.length < 2 || !isPoint(p)) return null;
  const pts = route.points;
  const cum = cumOf(route);
  const segs = [];
  let best = Infinity;
  let a = toLocal(p, pts[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const b = toLocal(p, pts[i + 1]);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(a[0] * dx + a[1] * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = a[0] + dx * t;
    const y = a[1] + dy * t;
    const d = Math.hypot(x, y);
    segs.push({ i, t, d });
    if (d < best) best = d;
    a = b;
  }
  // Of the segments nearly as close as the closest, the one that carries on from where the car was.
  let pick = null;
  const near = segs.filter((s) => s.d <= best + 10);
  if (Number.isFinite(prevAlong)) {
    const ahead = near.map((s) => ({ s, along: cum[s.i] + (cum[s.i + 1] - cum[s.i]) * s.t }))
      .filter((x) => x.along >= prevAlong - 30)
      .sort((x, y) => x.along - y.along);
    if (ahead.length) pick = ahead[0].s;
  }
  if (!pick) pick = near.reduce((x, y) => (y.d < x.d ? y : x), near[0]);
  const segLen = cum[pick.i + 1] - cum[pick.i];
  const along = cum[pick.i] + segLen * pick.t;
  const A = pts[pick.i];
  const B = pts[pick.i + 1];
  const at = [round6(A[0] + (B[0] - A[0]) * pick.t), round6(A[1] + (B[1] - A[1]) * pick.t)];
  const total = cum[cum.length - 1];
  const ms = Array.isArray(route.maneuvers) ? route.maneuvers : [];
  let next = -1;
  for (let k = 0; k < ms.length; k++) {
    if (ms[k].type === 'depart') continue;
    if (cum[ms[k].i] > along + 2) { next = k; break; }
  }
  if (next < 0 && ms.length && ms[ms.length - 1].type === 'arrive' && total - along <= 2) next = ms.length - 1;
  const toNext = next >= 0 ? Math.max(0, cum[ms[next].i] - along) : 0;
  const left = Math.max(0, total - along);
  return {
    along, off: pick.d, seg: pick.i, at,
    heading: segLen > 0.5 ? bearingDeg(A, B) : null,
    next, toNext, left,
    leftS: timeLeft(route, cum, along, next, left),
  };
}

// Seconds to the end: the rest of the maneuver the car is in (by its share of the way) plus every later one's
// time; without times, the whole route's time by distance.
function timeLeft(route, cum, along, next, left) {
  const ms = route.maneuvers || [];
  const total = cum[cum.length - 1];
  const hasTimes = ms.some((m) => m.time > 0);
  if (!hasTimes || next < 0) return total > 0 ? Math.round((route.time || 0) * (left / total)) : 0;
  const cur = next - 1;
  let s = 0;
  if (cur >= 0) {
    const span = cum[ms[next].i] - cum[ms[cur].i];
    const rest = cum[ms[next].i] - along;
    s += span > 0 ? (ms[cur].time || 0) * Math.max(0, Math.min(1, rest / span)) : 0;
  }
  for (let k = next; k < ms.length; k++) s += ms[k].time || 0;
  return Math.round(s);
}

// The route's line split where the car is: { done: [[lng, lat]...], ahead: [...] } (each >= 2 points, or empty).
export function splitAt(route, prog) {
  if (!route || !prog) return { done: [], ahead: route ? route.points.slice() : [] };
  const pts = route.points;
  const done = pts.slice(0, prog.seg + 1).concat([prog.at]);
  const ahead = [prog.at].concat(pts.slice(prog.seg + 1));
  return { done: done.length >= 2 ? done : [], ahead: ahead.length >= 2 ? ahead : [] };
}

// ---- a made-up route (the dev server's stand-in for the routing servers, and the dev preview) -------------

// An L-shaped route: along one "street" north or south, then a turn onto another east or west. Points every
// ~40 m so it draws like a road. Never asks anything of anyone.
export function stubRoute(from, to, { key = '', made = 0 } = {}) {
  if (!isPoint(from) || !isPoint(to)) return null;
  const corner = [from[0], to[1]];
  const legA = distanceM(from, corner);
  const legB = distanceM(corner, to);
  const pts = [];
  const line = (a, b) => {
    const n = Math.max(1, Math.ceil(distanceM(a, b) / 40));
    for (let k = pts.length ? 1 : 0; k <= n; k++) pts.push([round6(a[0] + (b[0] - a[0]) * (k / n)), round6(a[1] + (b[1] - a[1]) * (k / n))]);
  };
  const ms = [];
  const speed = 8.5; // m/s, about 30 km/h
  if (legA < 5 || legB < 5) {
    line(from, to);
    const d = distanceM(from, to);
    ms.push({ type: 'depart', instruction: turnWords('depart', 'Stub Street', { dir: compassWord(bearingDeg(from, to)) }), street: 'Stub Street', distance: d, time: d / speed, point: pts[0], i: 0 });
  } else {
    line(from, corner);
    const ci = pts.length - 1;
    line(corner, to);
    const h1 = bearingDeg(from, corner);
    const h2 = bearingDeg(corner, to);
    const turn = ((h2 - h1 + 540) % 360) - 180; // > 0: right
    const type = turn > 0 ? 'right' : 'left';
    ms.push({ type: 'depart', instruction: turnWords('depart', 'Stub Street', { dir: compassWord(h1) }), street: 'Stub Street', distance: legA, time: legA / speed, point: pts[0], i: 0 });
    ms.push({ type, instruction: turnWords(type, 'Test Avenue'), street: 'Test Avenue', distance: legB, time: legB / speed, point: pts[ci], i: ci });
  }
  ms.push({ type: 'arrive', instruction: turnWords('arrive'), street: '', distance: 0, time: 0, point: pts[pts.length - 1], i: pts.length - 1 });
  const distance = pathLength(pts);
  return cleanRoute({ key, by: 'stub', made, points: pts, distance, time: distance / speed, maneuvers: ms, to });
}
