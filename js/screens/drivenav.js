// Night Ops v1.4.8: the driver's turn-by-turn, like a phone's maps app in driving mode. Part of the Driving layer
// (js/screens/drive.js mounts it): a highlighted route along the real roads, the next turn big at the top, spoken
// turns, and at the bottom the arrival time, the time and distance left and End. Hands-free: it starts by itself
// when a pickup or a "Driver: go here" pin appears (a pickup first), follows the car, asks for a new route when
// the car leaves it, and says "Arrived". Routes come from the Night Ops server (app.route), which asks the public
// routing servers; without one (no signal, a refusal) it falls back to v1.1's straight-line directions.
//
//   createNav(app, { map, voice, now }) -> nav
//     nav.card, nav.strip, nav.go, nav.safety   elements drive.js places (top card, bottom strip, Navigate, the line)
//     nav.update(view)        each view and each tick of drive.js (500 ms): picks the place, follows the car
//     nav.start(dest)         navigate to { kind: 'pickup'|'pin', id } or { kind: 'hunters' } (a Navigate button)
//     nav.end()               the End button: no more automatic starts for what's there now
//     nav.active()            a place is set;  nav.camera() -> { center, bearing, zoom, pitch } | null
//     nav.carMarks(marks)     the car's own mark at this phone's newest fix (smoother than the server's)
//     nav.pinLines(pins)      no straight line to a pickup the route already leads to
//     nav.openWhere()         the "Where to?" sheet: every place with a big Navigate, Open in Maps, End
//     nav.state()             for tests;  nav.destroy()
//
// The pure parts are exported for tests (tests/page-nav.test.mjs). Never anything about a hider: the places come
// from the driver's own view (web/shared/nav.js navTarget), which the server keeps free of them (CONTRACT v1.4 G).
import { h, text, cls, fill } from '../dom.js?v=180';
import { icon } from '../ui/icons.js?v=180';
import { openSheet } from '../ui/sheet.js?v=180';
import { fmtDistance } from '../../shared/rules.js?v=180';
import { isPoint, distanceM, bearingDeg, directionWords } from '../../shared/geo.js?v=180';
import {
  NAV, navTarget, cleanRoute, progress, splitAt, alongAt, turnWords,
} from '../../shared/nav.js?v=180';

export const SAFETY = 'Driver: eyes on the road. A passenger can use this phone.';
export const NO_ROUTE = 'No route right now';
export const MAPS_WARNING = "Night Ops stops sharing your location while it's in the background on iPhone.";
export const CALL_FAR_M = 400;            // "In 400 metres, turn right onto Queen Street."
export const CALL_NEAR_M = 100;           // "In 100 metres, turn right onto Queen Street."
export const NOW_LEAST_M = 25;            // "Turn right onto Queen Street." this close (more when going fast)
export const NOW_SECONDS = 3;             // ...or this many seconds before the turn
export const ARRIVED_HOLD_MS = 20000;     // a pin or the hunters: navigating ends this long after arriving
export const LEFT_AGAIN_M = 100;          // arrived, then this far away again: back to the route
export const FIX_FRESH_MS = 15000;        // this phone's own fix is used for the car while it's this fresh
export const RETRY_MS = 20000;            // no route: asked again this often
export const NO_ROUTE_RETRY_MS = 60000;   // the routing servers said there's no way there: asked again this often
export const PITCH = 50;                  // the map's tilt while navigating (the street map; the plain one stays flat)
export const CAMERA_EVERY_MS = 950;       // the map is moved at most this often (each move glides for ~1 s)
export const OFF_GIVE_UP_MS = 30000;      // off the route this long with no new one: straight-line directions instead
export const NO_FIX_RETRY_MS = 5000;      // the server didn't know where the car was yet: asked again this soon
export const SHORT_WAIT_MS = 10000;       // "not yet" for this long at most: keep "Finding a route" and ask again

// ---- words (pure) ------------------------------------------------------------------------------------------

// For the voice ("400 metres", "1.2 kilometres"): turns are said in round numbers (50 m steps from 100 m).
export function spokenRound(m) {
  if (!Number.isFinite(m)) return '';
  const r = m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
  if (r < 1000) return `${r} metres`;
  const km = m / 1000;
  const s = km.toFixed(km < 9.95 ? 1 : 0).replace(/\.0$/, '');
  return `${s} ${s === '1' ? 'kilometre' : 'kilometres'}`;
}

// "less than a minute", "1 minute", "12 minutes", "1 hour 5 minutes".
export function minutesWords(s) {
  if (!Number.isFinite(s) || s < 45) return 'less than a minute';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'}`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return `${hr} ${hr === 1 ? 'hour' : 'hours'}${rest ? ` ${rest} ${rest === 1 ? 'minute' : 'minutes'}` : ''}`;
}

const VERBS = /^(Turn|Bear|Keep|Make|Merge|Continue|Head|Drive|Go|Take|Enter|Exit|Stay|At|Arrive|Your|You|Walk|Use)\b/;
// "Turn right onto Queen Street" -> "turn right onto Queen Street" (street names keep their capitals).
export function lowerFirst(s) {
  const t = String(s || '');
  return VERBS.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The next maneuver worth showing and saying (names changing, "straight", are skipped), from where the car is:
// { k, m, d (metres to it) } or null.
export function nextTurn(route, prog) {
  if (!route || !prog || !Array.isArray(route.maneuvers)) return null;
  const ms = route.maneuvers;
  let k = prog.next;
  if (k < 0) return null;
  while (k < ms.length - 1 && (ms[k].type === 'straight' || ms[k].type === 'depart')) k++;
  const m = ms[k];
  if (!m) return null;
  return { k, m, d: Math.max(0, alongAt(route, m.i) - prog.along) };
}

// ", then turn left" when the turn after this one comes within 100 m of it.
export function thenWords(route, k) {
  const ms = (route && route.maneuvers) || [];
  const m = ms[k];
  if (!m || m.type === 'arrive') return '';
  let j = k + 1;
  while (j < ms.length - 1 && ms[j].type === 'straight') j++;
  const n = ms[j];
  if (!n || n.type === 'straight' || n.type === 'depart') return '';
  const gap = alongAt(route, n.i) - alongAt(route, m.i);
  if (gap > CALL_NEAR_M) return '';
  return n.type === 'arrive' ? ', then you arrive' : `, then ${lowerFirst(turnWords(n.type))}`;
}

// What to say about the next turn now, or null: { words, mark: [keys to add to `said`] }. Each turn is said at
// about 400 m ("far"), 100 m ("near") and as it comes ("now"), each once; a later one is never followed by an
// earlier one. The end of the route is only said at 400 m: arriving is hasArrived's.
export function turnCall(route, prog, said, { speed = null, label = '' } = {}) {
  const nt = nextTurn(route, prog);
  if (!nt) return null;
  const { k, m, d } = nt;
  const nowM = Math.max(NOW_LEAST_M, Math.min(60, (Number.isFinite(speed) && speed > 0 ? speed : 8) * NOW_SECONDS));
  let stage = null;
  if (m.type === 'arrive') {
    if (d <= CALL_FAR_M && d > CALL_NEAR_M + 50) stage = 'far';
  } else if (d <= nowM) stage = 'now';
  else if (d <= CALL_NEAR_M + 20) stage = 'near';
  else if (d <= CALL_FAR_M && d > CALL_NEAR_M + 50) stage = 'far';
  if (!stage || said.has(`${k}:${stage}`)) return null;
  const order = ['far', 'near', 'now'];
  const mark = order.slice(0, order.indexOf(stage) + 1).map((st) => `${k}:${st}`);
  const instr = m.instruction || turnWords(m.type, m.street);
  let words;
  if (m.type === 'arrive') words = `In ${spokenRound(d)}, you'll arrive at ${label || 'the destination'}.`;
  else if (stage === 'now') words = `${cap(instr)}${thenWords(route, k)}.`;
  else words = `In ${spokenRound(d)}, ${lowerFirst(instr)}${stage === 'near' ? thenWords(route, k) : ''}.`;
  return { words, mark, stage, k };
}

// Without a route: "Sam's pickup: 100 metres east." at about 400 m and 100 m (v1.1's straight-line words).
export function straightCall(d, said, target, dir) {
  if (!Number.isFinite(d) || !target) return null;
  let stage = null;
  if (d <= CALL_NEAR_M + 20 && d > NAV.ARRIVE_M) stage = 'snear';
  else if (d <= CALL_FAR_M && d > CALL_NEAR_M + 50) stage = 'sfar';
  if (!stage || said.has(stage)) return null;
  const mark = stage === 'snear' ? ['sfar', 'snear'] : ['sfar'];
  return { words: `${cap(target.label)}: ${spokenRound(d)}${dir ? ` ${dir}` : ''}.`, mark };
}

// Arrived: the car within ARRIVE_M of the place, or of the route's end while on it.
export function hasArrived(prog, car, target) {
  if (isPoint(car) && target && isPoint(target.p) && distanceM(car, target.p) <= NAV.ARRIVE_M) return true;
  return !!prog && prog.left <= NAV.ARRIVE_M && prog.off <= NAV.OFF_M;
}

// The page's side of "off the route": more than OFF_M (or the fix's accuracy, if worse) away for OFF_GLITCH_MS,
// then reported to the server every ASK_OFF_MS (the server waits NAV.OFF_MS of reports before a new route).
export function createOffTracker() {
  let since = null;
  let lastReport = -Infinity;
  return {
    feed(off, acc, t) {
      const limit = Math.max(NAV.OFF_M, Number.isFinite(acc) ? Math.min(acc, 100) : 0);
      if (!(Number.isFinite(off) && off > limit)) {
        since = null;
        return { off: false, report: false, for: 0 };
      }
      if (since === null) since = t;
      const long = t - since >= NAV.OFF_GLITCH_MS;
      const report = long && t - lastReport >= NAV.ASK_OFF_MS;
      if (report) lastReport = t;
      return { off: long, report, for: t - since };
    },
    reset() {
      since = null;
      lastReport = -Infinity;
    },
  };
}

// The map's zoom for a speed: street level when slow, a little further out on a fast road.
export function zoomFor(kmh) {
  const v = Number.isFinite(kmh) ? kmh : 30;
  return Math.max(15.6, Math.min(17.6, 17.6 - Math.max(0, v - 25) * 0.035));
}

// ETA and what's left: { at (epoch), min, dist ('1.2 km') }.
export function etaParts(leftS, leftM, nowMs) {
  const s = Number.isFinite(leftS) ? Math.max(0, leftS) : 0;
  return { at: nowMs + s * 1000, min: Math.max(1, Math.round(s / 60)), dist: fmtDistance(Number.isFinite(leftM) ? leftM : 0) };
}

export function clockTime(epoch) {
  try {
    return new Date(epoch).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    const d = new Date(epoch);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// The maps app to hand over to: Apple Maps on an iPhone, Google Maps elsewhere.
export function mapsLink(p, { ios = false } = {}) {
  if (!isPoint(p)) return '';
  const ll = `${p[1].toFixed(6)},${p[0].toFixed(6)}`;
  return ios ? `https://maps.apple.com/?daddr=${ll}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
}

export function isIos(win = globalThis) {
  try {
    const n = win && win.navigator;
    const ua = String((n && n.userAgent) || '');
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(n && n.maxTouchPoints) > 1);
  } catch {
    return false;
  }
}

// ---- where to (pure) -------------------------------------------------------------------------------------

const RANK = { pickup: 0, driver: 1, go: 2, hunters: 2 };

// The places a navigation starts for by itself: open pickups (oldest first), then "Driver: go here" pins (newest
// first). [{ kind, id, key, rank }]
export function autoDests(view) {
  const out = [];
  const drive = view && view.drive;
  for (const k of drive && Array.isArray(drive.pickups) ? drive.pickups : []) {
    if (k && typeof k.id === 'string' && (k.state === 'open' || k.state === 'coming') && isPoint(k.p)) {
      out.push({ kind: 'pickup', id: k.id, key: `pickup:${k.id}`, rank: 0 });
    }
  }
  for (const p of view && Array.isArray(view.pins) ? view.pins : []) {
    if (p && typeof p.id === 'string' && p.kind === 'driver' && isPoint(p.p) && !(Number(p.left) <= 0)) {
      out.push({ kind: 'pin', id: p.id, key: `pin:${p.id}`, rank: 1 });
    }
  }
  return out;
}

// Every place the driver may navigate to now (the "Where to?" sheet): pickups, both kinds of pins a driver sees,
// and the other hunters. [{ dest, key, label, line }] (line: "300 m north-east" from the car).
export function destinations(view, from = null) {
  const list = [];
  const add = (dest, rank) => {
    const t = navTarget(view, dest);
    if (!t) return;
    const dw = isPoint(from) ? directionWords(from, t.p) : null;
    list.push({ dest: { ...dest, key: t.key, rank }, key: t.key, label: cap(t.label), line: dw ? (dw.m < 20 ? 'right here' : `${fmtDistance(dw.m)} ${dw.dir}`) : '' });
  };
  for (const k of (view && view.drive && view.drive.pickups) || []) if (k && typeof k.id === 'string') add({ kind: 'pickup', id: k.id }, 0);
  for (const p of (view && view.pins) || []) if (p && typeof p.id === 'string' && (p.kind === 'driver' || p.kind === 'go')) add({ kind: 'pin', id: p.id }, RANK[p.kind]);
  add({ kind: 'hunters' }, 2);
  return list;
}

// What to navigate to now: { start: dest | null (a place to start for, automatically), dropped (the current place
// is gone), present: [keys] }. A pickup goes first: one that appears takes over from a pin or the hunters; a new
// "Driver: go here" pin takes over from the hunters or a "Go here" pin; places the driver ended (`ended`) never
// start by themselves again; `seen` holds the places already there before (only new ones take over).
export function pickDest(view, { cur = null, ended = new Set(), seen = new Set() } = {}) {
  const all = autoDests(view);
  const present = all.map((c) => c.key);
  const cands = all.filter((c) => !ended.has(c.key));
  const dropped = !!cur && !navTarget(view, cur);
  const now = dropped ? null : cur;
  if (!now) return { start: cands[0] || null, dropped, present };
  const curRank = Number.isFinite(now.rank) ? now.rank : (RANK[now.kind] ?? 2);
  const fresh = cands.filter((c) => !seen.has(c.key) && c.rank < curRank);
  return { start: fresh.length ? fresh[0] : null, dropped: false, present };
}

// The car's own spot from the view (its hunter mark), or null.
function ownSpot(view) {
  const me = view && view.me;
  if (!me) return null;
  const m = ((view && view.marks) || []).find((x) => x && x.id === me.id && (x.kind === 'hunter' || x.kind === 'self'));
  return m && isPoint(m.p) ? m.p : null;
}

function isDriverView(view) {
  return !!view && view.phase === 'live' && !!view.me && !!view.me.driver && view.me.status === 'in' && !!view.drive && !!view.drive.me;
}

// ---- the card's look (pure) -------------------------------------------------------------------------------

// What the top card shows: null (hidden) or { kind: 'asking'|'turn'|'straight'|'arrived', icon, dist, line, note,
// rotate (deg, the straight-line arrow), then (an icon name), done (a pickup id: the Picked up button) }.
export function cardModel(st) {
  if (!st || !st.dest || st.status === 'idle') return null;
  const label = st.target ? cap(st.target.label) : 'the place';
  if (st.status === 'arrived') {
    return { kind: 'arrived', icon: 'arrive', dist: 'Arrived', line: label, note: '', done: st.dest.kind === 'pickup' ? st.dest.id : null };
  }
  if (st.status === 'asking') return { kind: 'asking', icon: 'straight', dist: 'Finding a route', line: `To ${st.target ? st.target.label : 'the place'}`, note: '' };
  if (st.status === 'straight') {
    const c = st.car && st.car.p;
    const p = st.target && st.target.p;
    const dw = isPoint(c) && isPoint(p) ? directionWords(c, p) : null;
    const b = isPoint(c) && isPoint(p) ? bearingDeg(c, p) : 0;
    return {
      kind: 'straight', icon: 'compass', rotate: Math.round(b - (Number(st.mapBearing) || 0)),
      dist: dw ? (dw.m < 20 ? 'Right here' : `${fmtDistance(dw.m)} ${dw.dir}`) : '',
      line: label, note: NO_ROUTE,
    };
  }
  const nt = nextTurn(st.route, st.prog);
  if (!nt) return { kind: 'turn', icon: 'straight', dist: '', line: label, note: st.rerouting ? 'Rerouting…' : '' };
  const { k, m, d } = nt;
  let then = null;
  const tw = thenWords(st.route, k);
  if (tw) {
    let j = k + 1;
    while (j < st.route.maneuvers.length - 1 && st.route.maneuvers[j].type === 'straight') j++;
    then = st.route.maneuvers[j] ? st.route.maneuvers[j].type : null;
  }
  return {
    kind: 'turn', icon: m.type,
    dist: d < 15 ? 'Now' : `In ${fmtDistance(d)}`,
    line: m.type === 'arrive' ? `Arrive at ${st.target ? st.target.label : 'the place'}` : cap(m.instruction || turnWords(m.type, m.street)),
    note: st.rerouting ? 'Rerouting…' : '',
    then,
  };
}

// ---- turn arrows (inline SVG, the app's icon style, sized big) ------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
const ARROWS = {
  straight: ['M12 21V4', 'M6 10l6-6 6 6'],
  depart: ['M12 21V4', 'M6 10l6-6 6 6'],
  right: ['M7 21v-8a4 4 0 0 1 4-4h9', 'M15 4l5 5-5 5'],
  left: ['M17 21v-8a4 4 0 0 0-4-4H4', 'M9 4 4 9l5 5'],
  'slight-right': ['M9 21v-7l8-8', 'M10 5h7v7'],
  'slight-left': ['M15 21v-7L7 6', 'M14 5H7v7'],
  'sharp-right': ['M8 21V5l10 10', 'M18 9v6h-6'],
  'sharp-left': ['M16 21V5L6 15', 'M6 9v6h6'],
  uturn: ['M16 21V10a4 4 0 0 0-8 0v8', 'M4 14l4 4 4-4'],
  'keep-right': ['M10 21v-7l6-6', 'M11 8h5v5', { d: 'M10 14 6 10V4', faint: true }],
  'keep-left': ['M14 21v-7L8 8', 'M13 8H8v5', { d: 'M14 14l4-4V4', faint: true }],
  merge: ['M12 21v-9', 'M7 21l5-9', { d: 'M17 21l-5-9', faint: true }, 'M8 7l4-4 4 4', 'M12 3v9'],
  roundabout: ['M12 21v-5', { circle: [12, 11, 4] }, 'M15 8l4-4', 'M14 4h5v5'],
  arrive: ['M7 21V4', 'M7 4h11l-2.5 4.5L18 13H7'],
  compass: [{ d: 'M12 3l6.5 17L12 16l-6.5 4L12 3z', fill: true }],
};

export function turnIcon(type, size = 64) {
  const svg = document.createElementNS(NS, 'svg');
  const set = (el, k, v) => el.setAttribute(k, String(v));
  set(svg, 'width', size);
  set(svg, 'height', size);
  set(svg, 'viewBox', '0 0 24 24');
  set(svg, 'fill', 'none');
  set(svg, 'stroke', 'currentColor');
  set(svg, 'stroke-width', '2.4');
  set(svg, 'stroke-linecap', 'round');
  set(svg, 'stroke-linejoin', 'round');
  set(svg, 'aria-hidden', 'true');
  set(svg, 'focusable', 'false');
  set(svg, 'class', `nav-turn t-${ARROWS[type] ? type : 'straight'}`);
  for (const part of ARROWS[type] || ARROWS.straight) {
    let el;
    if (typeof part === 'string') {
      el = document.createElementNS(NS, 'path');
      set(el, 'd', part);
    } else if (part.circle) {
      el = document.createElementNS(NS, 'circle');
      set(el, 'cx', part.circle[0]);
      set(el, 'cy', part.circle[1]);
      set(el, 'r', part.circle[2]);
    } else {
      el = document.createElementNS(NS, 'path');
      set(el, 'd', part.d);
      if (part.faint) set(el, 'stroke-opacity', '0.35');
      if (part.fill) { set(el, 'fill', 'currentColor'); set(el, 'stroke', 'none'); }
    }
    svg.appendChild(el);
  }
  return svg;
}

// ---- the controller ---------------------------------------------------------------------------------------

export function createNav(app, {
  map = null, voice = null, now = () => Date.now(), win = globalThis, onChange = null,
} = {}) {
  const S = {
    view: null, dest: null, target: null, route: null, status: 'idle', why: null, prog: null, prevAlong: null,
    said: new Set(), saidRoute: false, saidNoRoute: false, asking: false, nextAskAt: 0, moveAskAt: 0,
    ended: new Set(), seen: new Set(), arrivedAt: null, car: null, lastSpot: null, heading: null,
    rerouting: false, dead: false, drawnKey: '', cardKey: '',
  };
  const off = createOffTracker();
  const say = (words) => { try { if (voice && words) voice.say(words); } catch (e) { console.error(e); } };
  const changed = () => { if (onChange) { try { onChange(); } catch (e) { console.error(e); } } };

  // ---- the parts drive.js places ----
  const arrow = h('span.nav-arrow', { 'aria-hidden': 'true' });
  const pre = h('span.nav-in');
  const distNum = h('span.nav-num');
  const dist = h('strong.nav-dist', pre, distNum);
  const line = h('span.nav-line');
  const note = h('span.nav-note', { hidden: true });
  const thenEl = h('span.nav-then', { hidden: true });
  const doneBtn = h('button.btn.primary.nav-picked', { type: 'button', hidden: true }, 'Picked up');
  const card = h('div.nav-card', { hidden: true, role: 'group', 'aria-label': 'Next turn' },
    arrow, h('div.nav-words', dist, line, note), thenEl, doneBtn);
  const eta = h('span.nav-eta');
  const mins = h('span.nav-mins');
  const km = h('span.nav-km');
  const endBtn = h('button.btn.nav-end', { type: 'button', 'aria-label': 'End navigation' }, 'End');
  const destWords = h('span.nav-dest-words');
  const destBtn = h('button.nav-dest', { type: 'button', 'aria-haspopup': 'dialog' }, icon('flag', 16), destWords);
  const mapsBtn = h('button.nav-maps', { type: 'button', 'aria-haspopup': 'dialog' }, 'Open in Maps');
  const strip = h('div.nav-strip', { hidden: true },
    h('div.nav-strip-main', h('div.nav-stats', mins, km, eta), endBtn),
    h('div.nav-strip-sub', destBtn, mapsBtn));
  const go = h('button.btn.nav-go', { type: 'button', hidden: true, 'aria-haspopup': 'dialog' }, icon('car', 22), h('span', 'Navigate'));
  const safety = h('p.drive-safety', SAFETY);

  endBtn.addEventListener('click', () => end());
  destBtn.addEventListener('click', () => openWhere());
  go.addEventListener('click', () => openWhere());
  mapsBtn.addEventListener('click', () => openMaps());
  doneBtn.addEventListener('click', () => {
    const id = S.dest && S.dest.kind === 'pickup' ? S.dest.id : null;
    if (!id || doneBtn.getAttribute('aria-disabled') === 'true') return;
    doneBtn.setAttribute('aria-disabled', 'true');
    Promise.resolve(app.cmd({ type: 'pickup', do: 'done', pickupId: id })).catch(() => null)
      .then(() => doneBtn.removeAttribute('aria-disabled'));
  });

  // ---- following ----

  function carNow(view, t) {
    let fix = null;
    try { fix = typeof app.positionNow === 'function' ? app.positionNow() : null; } catch { fix = null; }
    if (fix && isPoint(fix.p) && Number.isFinite(fix.at) && Math.abs(t - fix.at) <= FIX_FRESH_MS) {
      return { p: [fix.p[0], fix.p[1]], acc: Number.isFinite(fix.acc) ? fix.acc : null, speed: Number.isFinite(fix.speed) ? fix.speed : null, own: true };
    }
    const p = ownSpot(view);
    const kmh = view && view.drive && Number.isFinite(view.drive.speedKmh) ? view.drive.speedKmh : null;
    return p ? { p, acc: null, speed: kmh === null ? null : kmh / 3.6, own: false } : null;
  }

  function clear() {
    S.dest = null;
    S.target = null;
    S.route = null;
    S.status = 'idle';
    S.prog = null;
    S.prevAlong = null;
    S.why = null;
    S.rerouting = false;
    S.arrivedAt = null;
    S.said = new Set();
    off.reset();
    drawRoute();
  }

  function begin(dest, { auto = false } = {}) {
    S.dest = { kind: dest.kind, id: dest.id, key: dest.key, rank: Number.isFinite(dest.rank) ? dest.rank : (RANK[dest.kind] ?? 2), auto };
    S.ended.delete(dest.key);
    S.target = S.view ? navTarget(S.view, S.dest) : null;
    S.route = null;
    S.status = 'asking';
    S.prog = null;
    S.prevAlong = null;
    S.why = null;
    S.rerouting = false;
    S.arrivedAt = null;
    S.said = new Set();
    S.saidRoute = false;
    S.saidNoRoute = false;
    S.nextAskAt = 0;
    S.moveAskAt = 0;
    off.reset();
    ask({ start: true });
  }

  async function ask({ start = false } = {}) {
    if (S.asking || !S.dest || S.dead) return;
    const dest = S.dest;
    S.asking = true;
    let res = null;
    try {
      res = await app.route(dest.kind === 'hunters' ? { kind: 'hunters' } : { kind: dest.kind, id: dest.id }, { start, heading: S.heading });
    } catch (e) {
      res = null;
    }
    S.asking = false;
    if (S.dead) return;
    if (S.dest !== dest) {
      // (Another place was picked while this one was being asked for: ask for that one now.)
      if (S.dest && S.status === 'asking') ask({ start: true });
      return;
    }
    took(res, now());
    render();
    changed();
  }

  function took(res, t) {
    const err = !res || typeof res.code === 'string';
    if (err) {
      const code = res && res.code;
      // (The server said no to this place: it never starts again by itself, so a refusal can't become a loop.)
      if (code === 'no_place' || code === 'not_driver' || code === 'not_live' || code === 'not_in_game' || code === 'gone'
        || code === 'kicked' || code === 'bad_request') {
        if (S.dest) S.ended.add(S.dest.key);
        clear();
        return;
      }
      noRoute(code === 'no_fix' ? 'no_fix' : 'unreachable', t, code === 'no_fix' ? NO_FIX_RETRY_MS : RETRY_MS);
      return;
    }
    const r = res.route ? cleanRoute(res.route) : null;
    if (r) {
      const fresh = !S.route || S.route.made !== r.made || S.route.key !== r.key || S.route.points.length !== r.points.length;
      if (fresh) {
        const was = !!S.route && S.status === 'route';
        S.route = r;
        S.said = new Set();
        S.prevAlong = null;
        S.prog = null;
        off.reset();
        if (was) say('Rerouting.');
      }
      if (S.status !== 'arrived') S.status = 'route';
      S.why = res.why || null;
      S.nextAskAt = t + (Number.isFinite(res.wait) ? res.wait : 0);
      S.rerouting = false;
      if (!S.saidRoute && S.target) {
        S.saidRoute = true;
        say(`Driving to ${S.target.label}. ${cap(spokenRound(r.distance))}, ${r.time < 45 ? 'under a minute' : `about ${minutesWords(r.time)}`}.`);
      }
      return;
    }
    const wait = Number.isFinite(res.wait) ? Math.max(3000, res.wait) : null;
    // (Only "not yet" for a moment: the game asked for another route a second ago. Still finding one.)
    if (!S.route && S.status === 'asking' && (res.why === 'wait' || res.why === 'busy') && wait !== null && wait <= SHORT_WAIT_MS) {
      S.why = res.why;
      S.nextAskAt = t + wait;
      return;
    }
    noRoute(res.why || 'unreachable', t, wait);
  }

  function noRoute(why, t, wait) {
    S.why = why;
    // (A route already in hand is kept: the server said "not yet" to a new one.)
    if (!S.route && S.status !== 'arrived') S.status = 'straight';
    S.nextAskAt = why === 'cap' ? Infinity : t + (wait !== null ? wait : why === 'no_route' ? NO_ROUTE_RETRY_MS : RETRY_MS);
    if (S.status === 'straight' && !S.saidNoRoute && S.target && S.car) {
      S.saidNoRoute = true;
      const dw = directionWords(S.car.p, S.target.p);
      say(`${NO_ROUTE}. ${cap(S.target.label)}: ${dw.m < 20 ? 'right here' : `${spokenRound(dw.m)} ${dw.dir}`}.`);
      // (What was just said isn't said again at the next mark.)
      if (dw.m <= CALL_FAR_M) S.said.add('sfar');
      if (dw.m <= CALL_NEAR_M + 20) S.said.add('snear');
    }
  }

  function arrive(t) {
    if (S.status === 'arrived') return;
    S.status = 'arrived';
    S.arrivedAt = t;
    S.rerouting = false;
    if (!S.said.has('arrived')) {
      S.said.add('arrived');
      say(`Arrived at ${S.target ? S.target.label : 'the place'}.`);
    }
  }

  function end({ auto = false } = {}) {
    if (S.dest) S.ended.add(S.dest.key);
    // The End button: nothing there now starts again by itself (new pickups and pins still do).
    if (!auto) for (const c of autoDests(S.view)) S.ended.add(c.key);
    clear();
    render();
    changed();
  }

  function update(view) {
    if (S.dead) return;
    S.view = view;
    if (!isDriverView(view)) {
      if (S.dest) clear();
      render();
      return;
    }
    const t = now();
    const pick = pickDest(view, { cur: S.dest, ended: S.ended, seen: S.seen });
    if (pick.dropped) clear();
    if (pick.start && (!S.dest || pick.start.key !== S.dest.key)) begin(pick.start, { auto: true });
    for (const k of pick.present) S.seen.add(k);
    if (!S.dest) {
      render();
      return;
    }
    S.target = navTarget(view, S.dest) || S.target;
    const c = carNow(view, t);
    S.car = c;
    if (!c || !S.target) {
      render();
      return;
    }
    follow(c, t);
    drawRoute();
    render();
  }

  function follow(c, t) {
    const tgt = S.target;
    if (S.status === 'route' && S.route) {
      const pr = progress(S.route, c.p, S.prevAlong);
      S.prog = pr;
      if (pr) S.prevAlong = pr.along;
      heading(c, pr);
      if (pr && hasArrived(pr, c.p, tgt)) {
        arrive(t);
        return;
      }
      if (!pr) return;
      const o = off.feed(pr.off, c.acc, t);
      S.rerouting = o.off;
      // (Off it for long, and no new route came: the old one only misleads. Straight-line directions until one does.)
      if (o.off && o.for >= OFF_GIVE_UP_MS && S.why && S.why !== 'off') {
        S.route = null;
        S.prog = null;
        S.rerouting = false;
        S.saidNoRoute = false;
        S.status = 'straight';
        off.reset();
        noRoute(S.why, t, Math.max(0, S.nextAskAt - t));
        return;
      }
      if (o.report && !S.asking) ask();
      else if (!S.asking && isPoint(S.route.to) && distanceM(S.route.to, tgt.p) > NAV.MOVED_M && t >= S.moveAskAt) {
        // (The place moved: a hunter walking, or "the hunters" moving on. The server decides if it's far enough.)
        S.moveAskAt = t + NAV.REROUTE_GAP_MS;
        ask();
      }
      if (!o.off) {
        const call = turnCall(S.route, pr, S.said, { speed: c.speed, label: tgt.label });
        if (call) {
          for (const k of call.mark) S.said.add(k);
          say(call.words);
        }
      }
      return;
    }
    heading(c, null);
    const d = distanceM(c.p, tgt.p);
    if (S.status === 'asking') {
      if (!S.asking && t >= S.nextAskAt) ask({ start: true });
      return;
    }
    if (S.status === 'straight') {
      if (d <= NAV.ARRIVE_M) {
        arrive(t);
        return;
      }
      const call = straightCall(d, S.said, tgt, directionWords(c.p, tgt.p).dir);
      if (call) {
        for (const k of call.mark) S.said.add(k);
        say(call.words);
      }
      if (!S.asking && t >= S.nextAskAt) ask();
      return;
    }
    if (S.status === 'arrived') {
      if (S.dest.kind !== 'pickup' && Number.isFinite(S.arrivedAt) && t - S.arrivedAt >= ARRIVED_HOLD_MS) {
        end({ auto: true });
        return;
      }
      if (d > LEFT_AGAIN_M) {
        S.status = S.route ? 'route' : 'straight';
        S.said.delete('arrived');
        S.arrivedAt = null;
      }
    }
  }

  // Which way the car points: along the road while on the route, else the way it last moved (8 m or more).
  function heading(c, pr) {
    if (pr && pr.off <= NAV.OFF_M && Number.isFinite(pr.heading)) S.heading = pr.heading;
    else if (S.lastSpot && distanceM(S.lastSpot, c.p) >= 8) S.heading = bearingDeg(S.lastSpot, c.p);
    if (!S.lastSpot || distanceM(S.lastSpot, c.p) >= 8) S.lastSpot = c.p;
  }

  function drawRoute() {
    if (!map || typeof map.setNavRoute !== 'function') return;
    const on = S.status === 'route' || (S.status === 'arrived' && !!S.route);
    const parts = on && S.route ? splitAt(S.route, S.prog) : null;
    const key = parts ? `${S.route.made}:${S.route.key}:${S.prog ? Math.round(S.prog.along / 2) : -1}` : '';
    if (key === S.drawnKey) return;
    S.drawnKey = key;
    try { map.setNavRoute(parts); } catch (e) { console.error(e); }
  }

  // ---- drawing the card and the strip ----

  function render() {
    if (S.dead) return;
    let mapBearing = 0;
    try { mapBearing = map && typeof map.navView === 'function' ? map.navView().bearing : 0; } catch { mapBearing = 0; }
    const model = cardModel({ ...S, mapBearing });
    const shown = !!model;
    if (card.hidden === shown) card.hidden = !shown;
    if (model) {
      const ck = `${model.kind}:${model.icon}:${model.then}`;
      if (ck !== S.cardKey) {
        S.cardKey = ck;
        fill(arrow, turnIcon(model.icon, 64));
        fill(thenEl, model.then ? [h('span.nav-then-word', 'Then'), turnIcon(model.then, 28)] : []);
        cls(card, 'is-arrived', model.kind === 'arrived');
        cls(card, 'is-straight', model.kind === 'straight');
        cls(card, 'is-asking', model.kind === 'asking');
      }
      if (model.kind === 'straight') arrow.style.setProperty('--turn', `${model.rotate || 0}deg`);
      // ("In 210 m": the "In " small, the distance big)
      const inWord = /^In /.test(model.dist) ? 'In ' : '';
      text(pre, inWord);
      text(distNum, inWord ? model.dist.slice(3) : model.dist);
      text(line, model.line);
      text(note, model.note);
      note.hidden = !model.note;
      thenEl.hidden = !model.then;
      doneBtn.hidden = !model.done;
      card.setAttribute('aria-label', [model.dist, model.line, model.note].filter(Boolean).join('. '));
    }
    // the strip
    const nav = !!S.dest;
    if (strip.hidden === nav) strip.hidden = !nav;
    if (nav) {
      let left = null;
      if (S.status === 'route' && S.prog) left = etaParts(S.prog.leftS, S.prog.left, now());
      else if (S.car && S.target) {
        const d = distanceM(S.car.p, S.target.p);
        left = { at: null, min: null, dist: fmtDistance(d) };
      }
      text(eta, left && left.at ? clockTime(left.at) : '');
      text(mins, left && left.min ? `${left.min} min` : S.status === 'arrived' ? 'Here' : '');
      text(km, left ? left.dist : '');
      text(destWords, S.target ? `To ${S.target.label}` : 'Where to?');
      mapsBtn.hidden = !(S.target && isPoint(S.target.p));
    }
    // Navigate (nothing on): only when there's somewhere to go and no pickup button already there
    const pk = S.view && S.view.drive && Array.isArray(S.view.drive.pickups) ? S.view.drive.pickups.filter((k) => k && (k.state === 'open' || k.state === 'coming')).length : 0;
    const goOn = !nav && isDriverView(S.view) && !pk;
    if (go.hidden === goOn) go.hidden = !goOn;
  }

  // ---- sheets ----

  function openWhere() {
    const view = S.view;
    if (!isDriverView(view)) return null;
    const list = destinations(view, S.car ? S.car.p : ownSpot(view));
    let sheet = null;
    const rows = list.map((d) => {
      const cur = !!S.dest && S.dest.key === d.key;
      const btn = h(`button.btn${cur ? '' : '.primary'}.nav-where-go`, { type: 'button', ...(cur ? { 'aria-disabled': 'true' } : {}), 'aria-label': cur ? `Navigating to ${d.label}` : `Navigate to ${d.label}` }, cur ? 'Navigating' : 'Navigate');
      btn.addEventListener('click', () => {
        if (cur) return;
        begin(d.dest, { auto: false });
        render();
        changed();
        if (sheet) sheet.close();
      });
      return h('div.nav-where-row', { 'data-key': d.key }, h('div.nav-where-words', h('strong', d.label), d.line ? h('span', d.line) : null), btn);
    });
    const body = [rows.length ? h('div.nav-where-list', rows) : h('p.nav-where-none', 'No pickups or pins yet. The hunters drop "Driver: go here" pins for you.')];
    if (S.dest) {
      const endIt = h('button.btn.wide.nav-where-end', { type: 'button' }, 'End navigation');
      endIt.addEventListener('click', () => { end(); if (sheet) sheet.close(); });
      body.push(endIt);
    }
    sheet = openSheet({ title: 'Where to?', className: 'nav-where-sheet', body, actions: [{ label: 'Close', kind: 'ghost' }] });
    return sheet;
  }

  function openMaps() {
    const p = S.target && S.target.p;
    if (!isPoint(p)) return null;
    const url = mapsLink(p, { ios: isIos(win) });
    const link = h('a.btn.primary.wide.nav-maps-go', { href: url, target: '_blank', rel: 'noopener noreferrer' }, isIos(win) ? 'Open Apple Maps' : 'Open Google Maps');
    let sheet = null;
    link.addEventListener('click', () => { if (sheet) setTimeout(() => sheet.close(), 0); });
    sheet = openSheet({
      title: 'Open in Maps?',
      className: 'nav-maps-sheet',
      body: [h('p.nav-maps-warn', icon('warn', 20), h('span', MAPS_WARNING)),
        h('p.nav-maps-line', `Come back to Night Ops when you get to ${S.target.label}.`), link],
      actions: [{ label: 'Stay here', kind: 'ghost' }],
    });
    return sheet;
  }

  return {
    card, strip, go, safety,
    update,
    start(dest) {
      const t = S.view && isDriverView(S.view) ? navTarget(S.view, dest) : null;
      if (!t) return false;
      if (S.dest && S.dest.key === t.key) return true;
      begin({ ...dest, key: t.key, rank: RANK[t.kind === 'pin' ? t.pinKind : t.kind] ?? 2 }, { auto: false });
      render();
      changed();
      return true;
    },
    end: () => end(),
    active: () => !!S.dest,
    navigating: (key) => !!S.dest && S.dest.key === key,
    camera() {
      if (!S.dest || !S.car) return null;
      const kmh = Number.isFinite(S.car.speed) ? S.car.speed * 3.6
        : S.view && S.view.drive && Number.isFinite(S.view.drive.speedKmh) ? S.view.drive.speedKmh : null;
      return { center: S.car.p, bearing: Number.isFinite(S.heading) ? S.heading : undefined, zoom: zoomFor(kmh), pitch: PITCH };
    },
    carMarks(marks) {
      const me = S.view && S.view.me;
      if (!S.dest || !S.car || !S.car.own || !me || !Array.isArray(marks)) return marks;
      return marks.map((m) => (m && m.id === me.id && (m.kind === 'hunter' || m.kind === 'self') ? { ...m, p: S.car.p, age: 0 } : m));
    },
    pinLines(pins) {
      if (!S.dest || S.dest.kind !== 'pickup' || !S.route || !Array.isArray(pins)) return pins;
      return pins.map((p) => (p && p.key === `pk:${S.dest.id}` ? { ...p, from: null, line: '' } : p));
    },
    openWhere,
    openMaps,
    state: () => S,
    destroy() {
      S.dead = true;
      try { if (map && typeof map.setNavRoute === 'function') map.setNavRoute(null); } catch { /* fine */ }
    },
  };
}
