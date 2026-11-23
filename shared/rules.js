// Night Ops: the game's settings, presets and timing rules, shared by the page and the server.
import { ringAcrossM, isPoint, distanceM, outsideByM, ringProblem } from './geo.js?v=167';

export const LIMITS = {
  players: 20,      // most people in one game
  name: 20,         // letters in a name
  chat: 200,        // letters in a chat message
  faceBytes: 16000, // a selfie's data: URL (a real 160 px selfie is 5-10 KB; server/schema.sql allows 20000)
  ringCorners: 20,
  // v1.1
  watchers: 20,             // spectators in one game (not counted in players)
  radioClips: 400,          // walkie-talkie clips in one round
  radioBytes: 480000,       // one clip's audio, decoded: 15 s even from phones that ignore the 24 kbps asked for (most Androids record ~150-250 kbps; at 48 KB they were cut at 2 s)
  radioGameBytes: 120000000, // all of a round's clips together
  // v1.2: the highlight cam
  camClipBytes: 60000000,   // one clip's file at most (a free Supabase bucket stops at 50 MB a file anyway)
  camPlayerBytes: Object.freeze({ highlights: 2000000000, everything: 3000000000 }), // one player's clips in one round (Pro plan: room for every clip)
  camGameBytes: 900000000,  // a round's clips from everyone (the handler's default; createHandler can lower it)
  camMoments: 1000,         // moments kept in one round (newest)
  camClipsEach: 200,        // clips one player may upload in one round
  // v1.3: Checkpoints
  checkpoints: 12,          // most checkpoints in the list
  checkpointsLeast: 2,      // Start needs at least this many (and at least this many that fit the game time)
  cpApartM: 60,             // checkpoint centres at least this far apart
  cpRadius: Object.freeze({ least: 20, most: 80, start: 35 }), // a checkpoint's zone radius, metres (whole numbers)
  cpName: 40,               // letters in a checkpoint's name
  cpTask: 80,               // letters in its task (may be empty)
  cpPhotoBytes: 60000,      // one photo's JPEG, decoded
  cpPhotoSide: 720,         // the page makes the longest side at most this
  cpPhotos: 300,            // photos stored in one round (then 'cp_full')
  cpPhotoIds: 12,           // photos fetched in one request
  // v1.4
  pinsEach: 3,              // live team pins one player may have
  pinNote: 40,              // letters in a pin's note (may be empty)
  pinsRound: 300,           // pins made in one round
  tapPieces: 3,             // Wiretap pieces per use (3 x 5 s)
  tapBytes: 48000,          // one Wiretap piece's audio, decoded
  tapClips: 120,            // Wiretap pieces in one round (their own cap, apart from the walkie's)
  tapGameBytes: 4000000,    // all of a round's Wiretap pieces together
};

export const TIMING = {
  RADAR_WARN_MS: 15000,        // hiders are warned this long before Radar goes live
  RADAR_LIVE_MS: 60000,        // Radar shows every hider live for this long
  EXPOSURE_SHOW_MS: 10000,     // an Exposure snapshot stays on the hunters' map this long
  HUNTER_POWER_GAP_MS: 300000, // Radar and Exposure can't be used within 5 min of each other
  SPRINT_MS: 120000,           // Sprint lasts 2 min
  DECOY_MIN_M: 200,
  DECOY_MAX_M: 400,
  OUTSIDE_SHOW_MS: 15000,      // outside the ring this long: hunters see you live (15 s since 1.5.1)
  OUTSIDE_CATCH_MS: 0,         // v1.5.1: 0 = the ring never catches (was 120000: outside 2 min, caught); you stay live instead
  OFFLINE_MS: 60000,           // no location for this long: "offline"
  OFFLINE_SHOW_MS: 180000,     // offline this long (a hider): hunters see the last known spot
  TAG_AUTO_MS: 60000,          // a tag nobody answers counts this long after the hider's phone got it
  CLOSE_CALL_M: 15,            // a hunter this close without a catch is a close call
  TRAIL_EVERY_MS: 10000,       // one route point per player this often (for the replay)
  SYNC_MS: 3000,               // the page asks for news this often
  CLOSING_RADIUS: 0.5,         // ping circles shrink to this share in the closing minutes
  // v1.1: spectators, the driver, the walkie-talkie
  SPECTATOR_DELAY_MS: 120000,  // spectators see the game this far behind (game clock)
  SPECTATOR_SPOT_MS: 60000,    // a spectator's dot: the newest route point within this before the delayed clock
  WATCH_SYNC_MS: 5000,         // a spectator's page asks for news this often
  WATCH_SEEN_EVERY_MS: 30000,  // a spectator's lastSeen is saved at most this often
  WATCH_IDLE_MS: 90000,        // a spectator not seen this long isn't counted (and goes first when full)
  PARK_KMH: 5,                 // the driver is parked under this speed...
  PARK_MS: 5000,               // ...held for this long...
  PARK_FRESH_MS: 20000,        // ...on a fix no older than this
  DRIVER_NEAR_M: 150,          // v1.1 only: unused since v1.4 (the driver never sees hiders)
  RADIO_MAX_MS: 15000,         // a clip sends itself at this length
  RADIO_MIN_MS: 400,           // shorter holds are dropped (the page); the server refuses under 300 ms
  RADIO_GAP_MS: 2000,          // at most one clip per player this often
  RADIO_STALE_MS: 60000,       // the page plays a new clip by itself only if it's no older than this
  // v1.2: the highlight cam
  CAM_PRE_MS: 10000,           // a Highlights clip starts this long before its moment...
  CAM_POST_MS: 20000,          // ...and ends this long after it (moments closer than that merge)
  CAM_CLIP_MOST_MS: 60000,     // one Highlights clip at most (a longer run of moments becomes the next clip)
  CAM_ROLL_EVERY_MS: 5000,     // Highlights: a new rolling recorder starts this often (so a clip's lead-in is 10-15 s)...
  CAM_ROLL_KEEP_MS: 15000,     // ...and is thrown away at this age unless a moment claimed it (3 run at once)
  CAM_PIECE_MS: 90000,         // Everything: one piece is this long...
  CAM_PIECE_OVERLAP_MS: 2000,  // ...and the next one starts this long before it ends
  CAM_NEAR_M: 50,              // close call for the camera: a hunter this close to a free hider...
  CAM_NEAR_FRESH_MS: 20000,    // ...both fixes no older than this...
  CAM_NEAR_GAP_MS: 60000,      // ...and at most one such moment per hunter-hider pair this often
  // v1.3: Checkpoints
  CP_FRESH_MS: 20000,          // a fix counts for "inside" only this fresh (now - at and now - got)
  CP_ACC_MAX_M: 50,            // a fix worse than this says nothing about inside/outside
  CP_ACC_SLACK_M: 15,          // inside = within r + min(acc, this) of the centre
  CP_STAY_MS: 20000,           // photos off: inside this long (one visit) counts it
  CP_OPEN_LEAST_MS: 180000,    // Auto never makes a checkpoint shorter than 3 min
  CP_LAST_MS: 180000,          // a checkpoint isn't opened (for the hunters) later than this before time's up
  CP_PHOTO_GAP_MS: 5000,       // one photo per player this often
  CP_TOLD_GAP_MS: 60000,       // "You're at the checkpoint" at most this often per hider per checkpoint
  CP_NEAR_CALL_M: 40,          // close call: a hunter this close when a checkpoint was done
  CP_HOLD_MS: 10000,           // the safe zone (and the photo) need a fix that kept the visit going this recently
  CP_POOR_SLACK_M: 40,         // a poor fix (worse than CP_ACC_MAX_M) keeps an open visit going within r + this
  CP_BACK_MS: 10000,           // back in this soon after a visit ended: the same visit goes on (GPS jitter at the edge)
  CP_TAG_NEAR_M: 100,          // a refused tag names the safe zone only to a hunter this close to it (once shown)
  // v1.4
  HACK_MS: 5000,               // Hacker's alarm sounds this long
  HACK_STALE_MS: 30000,        // a phone that hears of its hack later than this (game clock) doesn't sound it
  TAP_MS: 15000,               // Wiretap listens this long
  TAP_PIECE_MS: 5000,          // in pieces this long (each one a whole file)
  TAP_START_MS: 20000,         // no piece by then: nothing heard, the power is given back
  TAP_END_MS: 45000,           // pieces after this are refused (late uploads)
  PIN_MS: 300000,              // a team pin lasts 5 min
  FIX_LIVE_MS: 15000,          // "Location: live" while the newest stored fix is this fresh...
  FIX_LOST_MS: 45000,          // ...and "lost" past this (the team and the host are told), real time
  HEALTH_EVERY_MS: 60000,      // a phone's health is saved at most this often unless it changes
  TRAIL_NEAR_MS: 3000,         // route points this often for a player near the other side...
  TRAIL_NEAR_M: 100,           // ...within this many metres (close calls get a real track)
};

export const MODES = {
  classic: { label: 'Classic', line: 'A third hunt, the rest hide. Caught hiders join the hunters.' },
  infection: { label: 'Infection', line: 'One hunter to start. Everyone caught joins them.' },
  checkpoints: { label: 'Checkpoints', line: 'Hiders race to checkpoints and take a photo at each. Most checkpoints wins.' },
  loot: { label: 'Loot drops', line: 'Nobody starts with a power. Loot boxes drop around the ring: race there first for common, rare, legendary or mythic powers.' }, // v1.6
};

export const POWERS = {
  jammer: { team: 'hider', name: 'Jammer', idle: 'Skip the next ping', desc: 'You skip the next ping. Blocks Radar too, if it is on in time.' },
  decoy: { team: 'hider', name: 'Decoy', idle: 'Fake ping 300 m off', desc: 'Your next ping shows up 200-400 m away, somewhere else in the ring.' },
  sprint: { team: 'hider', name: 'Sprint', idle: 'Hide your trail 2 min', desc: 'For 2 minutes, pings show where you were when you started it.' },
  radar: { team: 'hunter', name: 'Radar', idle: 'Everyone live, 1 min', desc: 'Every hider shows up live for 1 minute. They get a 15-second warning.' },
  exposure: { team: 'hunter', name: 'Exposure', idle: 'Exact spots, no warning', desc: 'An exact dot for every hider, right now. No warning.' },
  // v1.4
  hacker: { team: 'hunter', name: 'Hacker', idle: "Set off a hider's phone", desc: "Pick a hider: their phone blares an alarm for 5 seconds. You don't see where they are." },
  wiretap: { team: 'hunter', name: 'Wiretap', idle: 'Listen in for 15 s', desc: 'Pick a hider who said OK: you hear 15 seconds of their microphone, a few seconds late.' },
};
export const HIDER_POWERS = ['jammer', 'decoy', 'sprint'];
export const HUNTER_POWERS = ['radar', 'exposure', 'hacker', 'wiretap'];
// v1.4: the hunter powers that take a `target` (a free hider).
export const POWER_TARGETED = Object.freeze(['hacker', 'wiretap']);
// v1.4: team pins. ("Pick me up here" is a pickup with a point, not a pin.)
export const PIN_KINDS = Object.freeze(['seen', 'go', 'driver']);
export const PIN_WORDS = Object.freeze({ seen: 'Hider seen', go: 'Go here', driver: 'Driver: go here' });

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
  powers: Object.freeze({ jammer: true, decoy: true, sprint: true, radar: true, exposure: true, hacker: true, wiretap: false }),
  custom: Object.freeze([]), // settings the host changed by hand (recommendations leave them alone)
  // v1.1 extras: never in `custom`, presets or recommendations
  driver: false,           // one hunter drives and gives rides
  spectators: true,        // friends may watch, 2 minutes behind
  radioSave: true,         // the walkie-talkie is kept for the replay
  // v1.2 extras
  radioHiders: false,      // hiders get their own walkie-talkie
  cam: false,              // phones film clips for the replay (only players who say OK)
  camMode: 'highlights',   // 'highlights' or 'everything' (EXTRA_CHOICES)
  // v1.4 extra
  pins: true,              // hunters and the driver can drop pins only their team sees
  // v1.3 Checkpoints (ordinary settings: a hand change puts them in `custom`; presets never touch them)
  cpOpenMin: 0,            // minutes each checkpoint stays open; 0 = Auto (the game time shared out so all fit)
  cpLeadMin: 2,            // hiders see each checkpoint this many minutes before the hunters
  cpSafeMin: 3,            // safe time inside a checkpoint, per hider per checkpoint in total
  cpPhoto: true,           // a photo is needed; false = staying inside CP_STAY_MS counts it
  cpOrder: 'host',         // 'host' (the host's order) | 'shuffle' (shuffled at Start)
});

// The extra switches (booleans; never counted as "changed by hand", never in presets or recommendations).
export const EXTRA_KEYS = Object.freeze(['driver', 'spectators', 'radioSave', 'radioHiders', 'cam', 'pins']);
// Extra choices (one of a list; the same rules as EXTRA_KEYS).
export const EXTRA_CHOICES = Object.freeze({ camMode: Object.freeze(['highlights', 'everything']) });
const EXTRA_ALL = [...EXTRA_KEYS, ...Object.keys(EXTRA_CHOICES)];

// The lobby's "Extras" card, in this order.
export const EXTRAS_UI = [
  { key: 'driver', label: 'Driver', hint: 'One hunter drives a car and gives the others rides. The driver never tags.' },
  { key: 'spectators', label: 'Spectators', hint: 'Friends can watch the game 2 minutes behind. They never see chats.' },
  { key: 'radioSave', label: 'Save the walkie-talkie for the replay', hint: 'The walkie-talkie is saved for the end-of-game replay.' },
  { key: 'radioHiders', label: 'Walkie-talkie for hiders too', hint: 'Hiders get their own walkie-talkie. Each team only hears its own.' },
  { key: 'cam', label: 'Camera', hint: 'Phones film clips with the selfie camera for the replay. Only people who say OK are filmed.' },
  { key: 'pins', label: 'Team pins', hint: 'Hunters and the driver can drop pins only their team sees.' },
];

// The Camera row's two choices.
export const CAM_MODES_UI = [
  { value: 'highlights', label: 'Highlights', line: 'Short clips around the big moments. Smaller to upload.' },
  { value: 'everything', label: 'Everything', line: 'Films the whole game. Big uploads: use wifi.' },
];

// Moment kinds ('mark' = the phone's own "Record this", never from the server).
// (v1.4.7 appended 'talk': the phone heard talking. v1.3 appended 'checkpoint' and 'overstay', so older lists stay valid.)
export const CAM_KINDS = Object.freeze(['radio', 'tag', 'denied', 'caught', 'near', 'power', 'sos', 'outside', 'over', 'mark',
  'checkpoint', 'overstay', 'hack', 'tap', 'talk']);

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
  { key: 'caught', label: 'Caught hiders', kind: 'options', options: [['join', 'Become hunters'], ['out', 'Sit out and watch']], show: (s) => s.mode !== 'infection' },
];

// v1.3: the lobby's Checkpoints card, in this order (the same item shape as SETTINGS_UI).
export const CP_SETTINGS_UI = [
  { key: 'cpOpenMin', label: 'Each checkpoint is open for', kind: 'stepper', min: 0, max: 30, step: 1, unit: 'min', zero: 'Auto' },
  { key: 'cpLeadMin', label: "Hiders' head start on each", kind: 'stepper', min: 0, max: 5, step: 1, unit: 'min', zero: 'None' },
  { key: 'cpSafeMin', label: 'Safe time inside', kind: 'stepper', min: 1, max: 10, step: 1, unit: 'min' },
  { key: 'cpPhoto', label: 'Photo needed', kind: 'switch', hint: 'Off: staying inside for 20 seconds counts it.' },
  { key: 'cpOrder', label: 'Order', kind: 'options', options: [['host', 'In my order'], ['shuffle', 'Shuffled']] },
];

export const CP_TASK_IDEAS = ['Buy a pack of gum', 'Selfie by the sign', 'Selfie with the big statue', 'Photo with something red'];

const INTS = {
  hunters: [0, LIMITS.players - 1, 1],
  durationMin: [10, 120, 5],
  headStartMin: [1, 10, 1],
  pingEveryMin: [1, 10, 1],
  closingMin: [0, 30, 5],
  closingPingEveryMin: [1, 5, 1],
  finalSizePct: [20, 90, 10],
  cpOpenMin: [0, 30, 1],
  cpLeadMin: [0, 5, 1],
  cpSafeMin: [1, 10, 1],
};
const CHOICES = {
  mode: Object.keys(MODES),
  pingWarnSec: [0, 15, 30, 60],
  pingAccuracyM: [0, 50, 100, 200],
  caught: ['join', 'out'],
  cpOrder: ['host', 'shuffle'],
};
const CP_INTS = ['cpOpenMin', 'cpLeadMin', 'cpSafeMin'];

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
  if ('cpPhoto' in input && typeof input.cpPhoto === 'boolean') out.cpPhoto = input.cpPhoto;
  for (const key of EXTRA_KEYS) if (key in input && typeof input[key] === 'boolean') out[key] = input[key];
  for (const [key, list] of Object.entries(EXTRA_CHOICES)) {
    if (key in input && list.includes(input[key])) out[key] = input[key];
  }
  if (input.powers && typeof input.powers === 'object') {
    for (const p of Object.keys(POWERS)) {
      if (typeof input.powers[p] === 'boolean') out.powers[p] = input.powers[p];
    }
  }
  if (Array.isArray(input.custom)) {
    // An own key, not `in`: 'toString' or 'constructor' are "in" every object.
    const own = (k) => Object.prototype.hasOwnProperty.call(DEFAULTS, k);
    out.custom = [...new Set(input.custom.filter((k) => typeof k === 'string' && own(k) && k !== 'custom' && !EXTRA_ALL.includes(k)))];
  }
  return fixUp(out);
}

// v1.3: a missing or invalid Checkpoints field gets its default (older stored settings); an open time of 1 or
// 2 minutes becomes 3 (Auto never goes below 3 either). Changes s in place and returns it.
export function fixCheckpointSettings(s) {
  for (const key of CP_INTS) {
    const [min, max] = INTS[key];
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) s[key] = DEFAULTS[key];
  }
  if (s.cpOpenMin === 1 || s.cpOpenMin === 2) s.cpOpenMin = 3;
  if (typeof s.cpPhoto !== 'boolean') s.cpPhoto = DEFAULTS.cpPhoto;
  if (!CHOICES.cpOrder.includes(s.cpOrder)) s.cpOrder = DEFAULTS.cpOrder;
  return s;
}

function fixUp(s) {
  fixCheckpointSettings(s);
  fixPowers(s);
  // (Older stored settings lack the v1.1/v1.2 extras: they get the defaults.)
  for (const key of EXTRA_KEYS) if (typeof s[key] !== 'boolean') s[key] = DEFAULTS[key];
  for (const [key, list] of Object.entries(EXTRA_CHOICES)) if (!list.includes(s[key])) s[key] = DEFAULTS[key];
  if (Array.isArray(s.custom)) s.custom = s.custom.filter((k) => !EXTRA_ALL.includes(k));
  // Infection starts with one hunter: no driver.
  if (s.mode === 'infection') s.driver = false;
  if (s.closingMin >= s.durationMin) s.closingMin = Math.max(0, Math.floor((s.durationMin - 5) / 5) * 5);
  // Closing in means faster pings: never slower than the usual ones.
  if (s.closingPingEveryMin > s.pingEveryMin) s.closingPingEveryMin = Math.max(1, s.pingEveryMin);
  return s;
}

// v1.4: a missing power switch (older stored settings) gets its default. Changes s in place and returns it.
export function fixPowers(s) {
  const was = s.powers && typeof s.powers === 'object' && !Array.isArray(s.powers) ? s.powers : {};
  const out = {};
  for (const k of Object.keys(POWERS)) out[k] = typeof was[k] === 'boolean' ? was[k] : DEFAULTS.powers[k];
  s.powers = out;
  return s;
}

// How many hunters (the driver included) for n players.
export function huntersFor(settings, n) {
  if (n < 2) return 0;
  if (settings.mode === 'infection') return 1;
  const want = settings.hunters > 0 ? settings.hunters : Math.round(n / 3);
  return Math.max(1, Math.min(n - 1, want));
}

// '' when a driver is possible, else the sentence saying why not. `pickedHunters`: players the host picked
// as hunters by hand; the game starts with all of them, topped up to huntersFor (as cmdStart does).
export function driverProblem(settings, playersIn, pickedHunters = 0) {
  if (settings && settings.mode === 'infection') return 'Infection starts with one hunter, so there is no driver.';
  if (!(playersIn >= 3)) return 'A driver needs at least 3 players.';
  const picked = Number.isFinite(pickedHunters) ? Math.max(0, Math.min(playersIn - 1, Math.floor(pickedHunters))) : 0;
  if (Math.max(huntersFor(settings, playersIn), picked) < 2) return 'A driver needs 2 or more hunters. Add a hunter first.';
  return '';
}

export function ringSize(ring) {
  const across = ring ? ringAcrossM(ring) : 0;
  if (!ring) return { key: 'none', label: 'No ring yet', across };
  if (across < 500) return { key: 'small', label: 'Small', across };
  if (across < 1500) return { key: 'medium', label: 'Medium', across };
  if (across < 3000) return { key: 'large', label: 'Large', across };
  return { key: 'huge', label: 'Huge', across };
}

// (cpLeadMin and cpSafeMin only matter in Checkpoints; cpOpenMin is never recommended: its Auto fits already.)
const BY_SIZE = {
  small: { durationMin: 25, headStartMin: 3, pingEveryMin: 3, closingMin: 5, closingPingEveryMin: 1, cpLeadMin: 1, cpSafeMin: 2 },
  medium: { durationMin: 45, headStartMin: 5, pingEveryMin: 5, closingMin: 10, closingPingEveryMin: 2, cpLeadMin: 2, cpSafeMin: 3 },
  large: { durationMin: 60, headStartMin: 7, pingEveryMin: 6, closingMin: 10, closingPingEveryMin: 2, cpLeadMin: 3, cpSafeMin: 4 },
  huge: { durationMin: 90, headStartMin: 10, pingEveryMin: 7, closingMin: 15, closingPingEveryMin: 3, cpLeadMin: 3, cpSafeMin: 5 },
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

// ---------------------------------------------------------------------------------------------------------
// Text: names, messages and checkpoint words are cleaned the same way (the engine's cleanName and cleanChat
// use these too).

// Letters that only cause trouble in a name or a message: control characters, zero-width spaces, and the
// direction marks that can flip text around (U+061C and U+180E too). The joiner U+200D is kept only between
// two visible letters, where it holds an emoji or some scripts together; alone it would make a blank name.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const ZWJ = '\u200d';
// (Unicode property escapes, no look-behind: this file also runs in the page, and iPhones before iOS 16.4
// can't even read a regular expression with a look-behind in it.)
const VISIBLE_NEXT_TO_ZWJ = /[\p{L}\p{M}\p{N}\p{S}]/u;
// What two names are compared by: the letters a person sees. Fillers that draw nothing (the Hangul fillers,
// the blank braille cell, variation selectors, tag letters, the joiner...) and spaces don't count.
const NOT_SEEN = /[\p{Default_Ignorable_Code_Point}\u2800\s]/gu;
const SEEN_LETTER = /[\p{L}\p{N}\p{S}\p{P}]/u;

export function withoutLoneJoiners(text) {
  if (!text.includes(ZWJ)) return text;
  const a = Array.from(text);
  let out = '';
  for (let i = 0; i < a.length; i++) {
    if (a[i] === ZWJ && !(i > 0 && i < a.length - 1 && VISIBLE_NEXT_TO_ZWJ.test(a[i - 1]) && VISIBLE_NEXT_TO_ZWJ.test(a[i + 1]))) continue;
    out += a[i];
  }
  return out;
}

// One line, no invisible letters, spaces squeezed.
export function tidyText(text) {
  if (typeof text !== 'string') return '';
  return withoutLoneJoiners(text.normalize('NFC').replace(INVISIBLE, ' ')).replace(/\s+/g, ' ').trim();
}

// A name or message as it is compared: what can be seen, in lower case ('' = nothing visible at all).
export function nameKey(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').replace(NOT_SEEN, '').toLowerCase();
}

export function seenAtAll(text) {
  return SEEN_LETTER.test(nameKey(text));
}

export function cutText(text, most) {
  const a = Array.from(text);
  return a.length > most ? a.slice(0, most).join('') : text;
}

// A line as it will be shown, at most `most` letters ('' = nothing that can be seen).
export function cleanLine(text, most) {
  const out = withoutLoneJoiners(cutText(tidyText(text), most)).trim();
  return seenAtAll(out) ? out : '';
}

// ---------------------------------------------------------------------------------------------------------
// v1.3: Checkpoints

// When each checkpoint opens (see the contract's "cpPlan"). Pure.
export function cpPlan(settings, count) {
  const s = fixCheckpointSettings({ ...(settings || DEFAULTS) });
  const min = 60000;
  const safeMs = s.cpSafeMin * min;
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (n < 1) return { openMs: 0, leadMs: 0, safeMs, slots: [], skipped: 0 };
  const sch = schedule(s);
  const H = sch.headStartMs;
  const E = sch.endMs;
  const openMs = s.cpOpenMin > 0 ? s.cpOpenMin * min
    : Math.max(TIMING.CP_OPEN_LEAST_MS, Math.floor((E - H) / n / min) * min);
  const leadMs = Math.max(0, Math.min(s.cpLeadMin * min, openMs - min));
  const slots = [];
  for (let k = 0; k < n; k++) {
    const show = H + k * openMs;
    if (k > 0 && show > E - TIMING.CP_LAST_MS) break;
    slots.push({ k, at: Math.max(0, show - leadMs), show, close: E });
  }
  for (let k = 0; k < slots.length - 1; k++) slots[k].close = slots[k + 1].at;
  return { openMs, leadMs, safeMs, slots, skipped: n - slots.length };
}

const CP_ID = /^[a-z0-9]{1,8}$/;
const CP_OSM = /^(node|way|relation)\/[0-9]{1,15}$/;
const r7 = (v) => Math.round(v * 1e7) / 1e7;

function isEntry(c) {
  return !!c && typeof c === 'object' && !Array.isArray(c) && isPoint(c.p);
}

// The host's checkpoints made safe to store: entries without a valid point dropped, cut to LIMITS.checkpoints.
export function cleanCheckpoints(list) {
  if (!Array.isArray(list)) return [];
  const entries = list.filter(isEntry).slice(0, LIMITS.checkpoints);
  const taken = new Set();
  const ids = entries.map((c) => {
    if (typeof c.id === 'string' && CP_ID.test(c.id) && !taken.has(c.id)) {
      taken.add(c.id);
      return c.id;
    }
    return null;
  });
  let next = 1;
  const { least, most, start } = LIMITS.cpRadius;
  return entries.map((c, i) => {
    let id = ids[i];
    if (id === null) {
      while (taken.has(`k${next}`)) next++;
      id = `k${next}`;
      taken.add(id);
    }
    const r = typeof c.r === 'number' && Number.isFinite(c.r) ? Math.max(least, Math.min(most, Math.round(c.r))) : start;
    return {
      id,
      p: [r7(c.p[0]), r7(c.p[1])],
      r,
      name: cleanLine(c.name, LIMITS.cpName),
      task: cleanLine(c.task, LIMITS.cpTask),
      osm: typeof c.osm === 'string' && CP_OSM.test(c.osm) ? c.osm : null,
    };
  });
}

// '' when the list works with this ring, else a sentence saying what's wrong (fewer than 2 is fine here: the
// editor saves one at a time; Start checks the count).
export function checkpointProblem(list, ring) {
  if (!Array.isArray(list)) return 'Add the checkpoints again.';
  if (list.length > LIMITS.checkpoints) return `At most ${LIMITS.checkpoints} checkpoints.`;
  const { least, most } = LIMITS.cpRadius;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const n = i + 1;
    if (!isEntry(c)) return `Checkpoint ${n} is off the map.`;
    if (!cleanLine(c.name, LIMITS.cpName)) return `Give checkpoint ${n} a name.`;
    if (!Number.isInteger(c.r) || c.r < least || c.r > most) return `Checkpoint ${n}: the zone must be ${least} to ${most} m around the spot.`;
  }
  if (ringProblem(ring)) return 'Draw the ring first.';
  const name = (c) => cleanLine(c.name, LIMITS.cpName);
  for (const c of list) if (outsideByM(ring, c.p) > 0) return `${name(c)} is outside the ring.`;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (distanceM(list[i].p, list[j].p) < LIMITS.cpApartM) {
        return `${name(list[i])} and ${name(list[j])} are too close. Keep checkpoints at least ${LIMITS.cpApartM} m apart.`;
      }
    }
  }
  return '';
}
