// Night Ops: the game's settings, presets and timing rules, shared by the page and the server.
import { ringAcrossM } from './geo.js';

export const LIMITS = {
  players: 20,      // most people in one game
  name: 20,         // letters in a name
  chat: 200,        // letters in a chat message
  faceBytes: 16000, // a selfie's data: URL (a real 160 px selfie is 5-10 KB; server/schema.sql allows 20000)
  ringCorners: 20,
};

export const TIMING = {
  RADAR_WARN_MS: 15000,        // hiders are warned this long before Radar goes live
  RADAR_LIVE_MS: 60000,        // Radar shows every hider live for this long
  EXPOSURE_SHOW_MS: 10000,     // an Exposure snapshot stays on the hunters' map this long
  HUNTER_POWER_GAP_MS: 300000, // Radar and Exposure can't be used within 5 min of each other
  SPRINT_MS: 120000,           // Sprint lasts 2 min
  DECOY_MIN_M: 200,
  DECOY_MAX_M: 400,
  OUTSIDE_SHOW_MS: 30000,      // outside the ring this long: hunters see you live
  OUTSIDE_CATCH_MS: 120000,    // outside the ring this long: you're caught
  OFFLINE_MS: 60000,           // no location for this long: "offline"
  OFFLINE_SHOW_MS: 180000,     // offline this long (a hider): hunters see the last known spot
  TAG_AUTO_MS: 60000,          // a tag nobody answers counts this long after the hider's phone got it
  CLOSE_CALL_M: 15,            // a hunter this close without a catch is a close call
  TRAIL_EVERY_MS: 10000,       // one route point per player this often (for the replay)
  SYNC_MS: 3000,               // the page asks for news this often
  CLOSING_RADIUS: 0.5,         // ping circles shrink to this share in the closing minutes
};

export const MODES = {
  classic: { label: 'Classic', line: 'A third hunt, the rest hide. Caught hiders join the hunters.' },
  infection: { label: 'Infection', line: 'One hunter to start. Everyone caught joins them.' },
};

export const POWERS = {
  jammer: { team: 'hider', name: 'Jammer', idle: 'Skip the next ping', desc: 'You skip the next ping. Blocks Radar too, if it is on in time.' },
  decoy: { team: 'hider', name: 'Decoy', idle: 'Fake ping 300 m off', desc: 'Your next ping shows up 200-400 m away, somewhere else in the ring.' },
  sprint: { team: 'hider', name: 'Sprint', idle: 'Hide your trail 2 min', desc: 'For 2 minutes, pings show where you were when you started it.' },
  radar: { team: 'hunter', name: 'Radar', idle: 'Everyone live, 1 min', desc: 'Every hider shows up live for 1 minute. They get a 15-second warning.' },
  exposure: { team: 'hunter', name: 'Exposure', idle: 'Exact spots, no warning', desc: 'An exact dot for every hider, right now. No warning.' },
};
export const HIDER_POWERS = ['jammer', 'decoy', 'sprint'];
export const HUNTER_POWERS = ['radar', 'exposure'];

export const DEFAULTS = Object.freeze({
  mode: 'classic',
  hunters: 0,              // 0 = a third of the players (Infection: 1)
  durationMin: 45,         // the hunt, after the head start
  headStartMin: 5,
  pingEveryMin: 5,
  pingWarnSec: 30,         // hiders are warned this long before a ping (0 = no warning)
  pingAccuracyM: 100,      // ping circle radius (0 = an exact dot)
  closingMin: 10,          // the last minutes: faster pings, smaller circles (0 = none)
  closingPingEveryMin: 2,
  shrink: true,            // the ring shrinks during the closing minutes
  finalSizePct: 50,        // ...down to this share of its size
  caught: 'join',          // caught hiders 'join' the hunters, or are 'out' (they watch)
  powers: Object.freeze({ jammer: true, decoy: true, sprint: true, radar: true, exposure: true }),
  custom: Object.freeze([]), // settings the host changed by hand (recommendations leave them alone)
});

export const PRESETS = {
  quick: { label: 'Quick', line: '20 min, pings every 3', settings: { durationMin: 20, headStartMin: 3, pingEveryMin: 3, closingMin: 5, closingPingEveryMin: 1 } },
  standard: { label: 'Standard', line: '45 min, pings every 5', settings: { durationMin: 45, headStartMin: 5, pingEveryMin: 5, closingMin: 10, closingPingEveryMin: 2 } },
  long: { label: 'Long', line: '90 min, pings every 7', settings: { durationMin: 90, headStartMin: 10, pingEveryMin: 7, closingMin: 15, closingPingEveryMin: 3 } },
};

// What the lobby's settings list shows, in order. kind: 'options' (pick one of `options`),
// 'stepper' (min..max by step), 'switch'. `show(settings)` false = hidden for now.
export const SETTINGS_UI = [
  { key: 'durationMin', label: 'Game time', kind: 'stepper', min: 10, max: 120, step: 5, unit: 'min' },
  { key: 'headStartMin', label: 'Head start', kind: 'stepper', min: 1, max: 10, step: 1, unit: 'min' },
  { key: 'pingEveryMin', label: 'Ping every', kind: 'stepper', min: 1, max: 10, step: 1, unit: 'min' },
  { key: 'pingWarnSec', label: 'Warning before a ping', kind: 'options', options: [[0, 'Off'], [15, '15 s'], [30, '30 s'], [60, '1 min']] },
  { key: 'pingAccuracyM', label: 'Ping accuracy', kind: 'options', options: [[0, 'Exact'], [50, '50 m'], [100, '100 m'], [200, '200 m']] },
  { key: 'closingMin', label: 'Closing in (last minutes)', kind: 'stepper', min: 0, max: 30, step: 5, unit: 'min', zero: 'Off' },
  { key: 'closingPingEveryMin', label: 'Ping every, closing in', kind: 'stepper', min: 1, max: 5, step: 1, unit: 'min', show: (s) => s.closingMin > 0 },
  { key: 'shrink', label: 'Ring shrinks while closing in', kind: 'switch', show: (s) => s.closingMin > 0 },
  { key: 'finalSizePct', label: 'Final ring size', kind: 'stepper', min: 20, max: 90, step: 10, unit: '%', show: (s) => s.closingMin > 0 && s.shrink },
  { key: 'caught', label: 'Caught hiders', kind: 'options', options: [['join', 'Become hunters'], ['out', 'Sit out and watch']], show: (s) => s.mode === 'classic' },
];

const INTS = {
  hunters: [0, LIMITS.players - 1, 1],
  durationMin: [10, 120, 5],
  headStartMin: [1, 10, 1],
  pingEveryMin: [1, 10, 1],
  closingMin: [0, 30, 5],
  closingPingEveryMin: [1, 5, 1],
  finalSizePct: [20, 90, 10],
};
const CHOICES = {
  mode: Object.keys(MODES),
  pingWarnSec: [0, 15, 30, 60],
  pingAccuracyM: [0, 50, 100, 200],
  caught: ['join', 'out'],
};

function snap(v, [min, max, step]) {
  // Only numbers and number-like strings: Number(null), Number('') and Number(true) are 0 or 1, not a choice.
  if (typeof v === 'string' ? v.trim() === '' : typeof v !== 'number') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  const c = Math.max(min, Math.min(max, n));
  return min + Math.round((c - min) / step) * step;
}

// Returns a full, valid settings object: base with every valid field of input applied.
// Unknown keys and bad values are dropped (base's value kept).
export function cleanSettings(input, base = DEFAULTS) {
  const out = {
    ...base,
    powers: { ...DEFAULTS.powers, ...(base.powers || {}) },
    custom: [...(base.custom || [])],
  };
  if (!input || typeof input !== 'object') return fixUp(out);
  for (const [key, range] of Object.entries(INTS)) {
    if (key in input) { const v = snap(input[key], range); if (v !== null) out[key] = v; }
  }
  for (const [key, list] of Object.entries(CHOICES)) {
    if (key in input && list.includes(input[key])) out[key] = input[key];
  }
  if ('shrink' in input && typeof input.shrink === 'boolean') out.shrink = input.shrink;
  if (input.powers && typeof input.powers === 'object') {
    for (const p of Object.keys(POWERS)) {
      if (typeof input.powers[p] === 'boolean') out.powers[p] = input.powers[p];
    }
  }
  if (Array.isArray(input.custom)) {
    // An own key, not `in`: 'toString' or 'constructor' are "in" every object.
    const own = (k) => Object.prototype.hasOwnProperty.call(DEFAULTS, k);
    out.custom = [...new Set(input.custom.filter((k) => typeof k === 'string' && own(k) && k !== 'custom'))];
  }
  return fixUp(out);
}

function fixUp(s) {
  if (s.closingMin >= s.durationMin) s.closingMin = Math.max(0, Math.floor((s.durationMin - 5) / 5) * 5);
  // Closing in means faster pings: never slower than the usual ones.
  if (s.closingPingEveryMin > s.pingEveryMin) s.closingPingEveryMin = Math.max(1, s.pingEveryMin);
  return s;
}

// How many hunters (the driver included) for n players.
export function huntersFor(settings, n) {
  if (n < 2) return 0;
  if (settings.mode === 'infection') return 1;
  const want = settings.hunters > 0 ? settings.hunters : Math.round(n / 3);
  return Math.max(1, Math.min(n - 1, want));
}

export function ringSize(ring) {
  const across = ring ? ringAcrossM(ring) : 0;
  if (!ring) return { key: 'none', label: 'No ring yet', across };
  if (across < 500) return { key: 'small', label: 'Small', across };
  if (across < 1500) return { key: 'medium', label: 'Medium', across };
  if (across < 3000) return { key: 'large', label: 'Large', across };
  return { key: 'huge', label: 'Huge', across };
}

const BY_SIZE = {
  small: { durationMin: 25, headStartMin: 3, pingEveryMin: 3, closingMin: 5, closingPingEveryMin: 1 },
  medium: { durationMin: 45, headStartMin: 5, pingEveryMin: 5, closingMin: 10, closingPingEveryMin: 2 },
  large: { durationMin: 60, headStartMin: 7, pingEveryMin: 6, closingMin: 10, closingPingEveryMin: 2 },
  huge: { durationMin: 90, headStartMin: 10, pingEveryMin: 7, closingMin: 15, closingPingEveryMin: 3 },
};

// The recommended timings for this ring and number of players (only the timing fields).
export function recommend(ring, playerCount) {
  const size = ringSize(ring).key;
  const rec = { ...(BY_SIZE[size] || BY_SIZE.medium) };
  if (playerCount >= 10) rec.durationMin = Math.min(120, rec.durationMin + 10);
  return rec;
}

// settings with the recommendation applied to every field the host hasn't changed by hand.
export function withRecommendation(settings, ring, playerCount) {
  const rec = recommend(ring, playerCount);
  const keep = new Set(settings.custom || []);
  const patch = {};
  for (const [k, v] of Object.entries(rec)) if (!keep.has(k)) patch[k] = v;
  return cleanSettings(patch, settings);
}

// The game clock, in ms since Start (pauses not counted):
// [0, headStartMs) head start; [headStartMs, endMs) the hunt; endMs = time's up.
export function schedule(settings) {
  const min = 60000;
  const headStartMs = settings.headStartMin * min;
  const endMs = headStartMs + settings.durationMin * min;
  const closingMs = settings.closingMin > 0 ? Math.min(settings.closingMin, settings.durationMin - 1) * min : 0;
  const closingStartMs = endMs - closingMs;
  const pings = [];
  // (at least a minute apart: an interval of 0 would never end this loop)
  const every = Math.max(1, settings.pingEveryMin) * min;
  for (let t = headStartMs + every; t < closingStartMs; t += every) pings.push(t);
  if (closingMs > 0) {
    // The first closing ping comes as closing in starts, so the speed-up never begins with the longest wait.
    const fast = Math.max(1, settings.closingPingEveryMin) * min;
    for (let t = closingStartMs; t < endMs; t += fast) pings.push(t);
  }
  return { headStartMs, endMs, closingStartMs, closingMs, pings };
}

// The ping circle's radius at this clock (0 = exact).
export function pingRadiusAt(settings, clockMs) {
  const s = schedule(settings);
  const r = settings.pingAccuracyM;
  return s.closingMs > 0 && clockMs >= s.closingStartMs ? Math.round(r * TIMING.CLOSING_RADIUS) : r;
}

// How big the ring is at this clock: 1 = full size, down to finalSizePct / 100.
export function ringScaleAt(settings, clockMs) {
  const s = schedule(settings);
  if (!settings.shrink || s.closingMs <= 0 || clockMs <= s.closingStartMs) return 1;
  const f = Math.min(1, (clockMs - s.closingStartMs) / (s.endMs - s.closingStartMs));
  return 1 - (1 - settings.finalSizePct / 100) * f;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '';
  const tens = Math.round(m / 10) * 10;
  if (tens < 1000) return `${tens || 0} m`; // (|| 0: never "-0 m")
  const km = m / 1000;
  return `${km.toFixed(km < 9.95 ? 1 : 0)} km`; // 996 m is "1.0 km", never "1000 m"; 9,960 m is "10 km"
}
