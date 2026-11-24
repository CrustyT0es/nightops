// Night Ops: the game engine, shared by the server (which runs it) and the page (errorText and friends).
// Pure: no I/O, no clock and no randomness of its own. Time comes in as `now` (epoch ms) and randomness as
// `rand()` in [0, 1), so every test is exact. The state given is never changed: changes are made on a copy.
// Game time ("clock") is ms since Start with pauses left out: pings, powers, tags, the ring and the end all
// run on it, so an SOS pause stops every timer at once.
import { winnerAt } from './vote.js?v=177'; // v1.6.4: the vote's winner as every phone works it out
import {
  isPoint, distanceM, moveM, scaleRing, outsideByM, ringProblem, cleanRing, ringContains, boundsOf, toLocal, bearingDeg,
} from './geo.js?v=177';
import {
  LIMITS, TIMING, POWERS, HIDER_POWERS, HUNTER_POWERS, DEFAULTS, PRESETS, EXTRA_KEYS, EXTRA_CHOICES, CAM_KINDS,
  POWER_TARGETED, PIN_KINDS, fixPowers, cleanLine,
  cleanSettings, huntersFor, withRecommendation, schedule, pingRadiusAt, ringScaleAt, fmtClock,
  tidyText, cutText, nameKey, seenAtAll, withoutLoneJoiners,
  cpPlan, cleanCheckpoints, checkpointProblem, fixCheckpointSettings,
} from './rules.js?v=177';
import { newVote, stageAt, winner, settingsFor, voteView, ALL_QUESTIONS as QUESTIONS, closed, keepFor, cleanGear, driverOf as voteDriverOf } from './vote.js?v=177'; // v1.6: the lobby vote
import { lootGame, lootOf, lootDrop, lootNear, lootPower, lootView, LOOT_FIRST_MS, LOOT_PICK_M, LOOT_ACC_MAX_M, LOOT_POWERS, SMOKE_R, GHOST_PINGS, TRACKER_EVERY_MS } from './loot.js?v=177'; // v1.6: Loot drops

export const ENGINE_V = 1;

// The timing settings a recommendation sets (rules.recommend's fields).
export const TIMING_KEYS = Object.freeze(['durationMin', 'headStartMin', 'pingEveryMin', 'closingMin', 'closingPingEveryMin', 'cpLeadMin', 'cpSafeMin']);

const EVENTS_KEPT = 300;
const LOG_KEPT = 500;
const SEEN_EVERY_MS = 10000;   // lastSeen is refreshed at most this often (fewer saves)
const STEP_M = 8;              // smaller moves are GPS jitter, not walking
const ACC_MAX_M = 50;          // fixes worse than this don't count towards distance
const SPEED_MAX = 15;          // m/s: a faster move is a GPS jump (or a car) and isn't counted
const OUT_MARGIN_MIN_M = 10;   // outside the ring by more than the fix's accuracy (10..40 m) before it counts
const OUT_MARGIN_MAX_M = 40;
const CHAT_BURST = 6;          // at most this many chat messages...
const CHAT_WINDOW_MS = 15000;  // ...in this long, per player
const NEAR_WINDOW_MS = 15000;  // close calls: route points this close in time count as "together"
const GOT_AWAY_MS = 60000;     // ...and no catch of the hider this soon after
const LAST_PING_M = 60;        // a winner with a hunter this close at the last ping
const SPARE_MS = 15000;        // back in the ring (or a Jammer just in time) with less than this to spare
const ROUTE_MOST = 300;
const CLOSE_CALLS_KEPT = 6;
const DECOY_TRIES = 12;        // a Decoy's spot: this many tries 200-400 m away inside the ring...
const DECOY_SAMPLES = 20;      // ...then this many points anywhere in the ring
const RETAG_MS = 30000;        // a hunter can't tag the same hider again this soon after a "no"
const PICKS = ['auto', 'hunter', 'hider'];
// v1.1
const DRIVE_SPEED_MAX = 45;    // m/s: the driver's moves faster than this are GPS jumps
const MOTION_GAP_MS = 30000;   // a speed is worked out from two fixes at most this far apart
const PARK_SPOT_M = 15;        // a parked phone's fixes stay this close to where it stopped (GPS jitter)
const HOST_LOG_KEPT = 30;
const PICKUPS_KEPT = 100;
const REMOVED_WATCHERS_KEPT = 60;
const WATCH_JOINS_MOST = LIMITS.watchers * 3;
const RADIO_VIEW_MOST = 20;    // clips in one view at most
const RADIO_TYPES = ['audio/mp4', 'audio/webm'];
const RADIO_MS_MIN = 300;
const RADIO_MS_MAX = 15500;
const SIDE_WORDS = new Set(['all', 'hunters', 'hiders']);

// ---------------------------------------------------------------------------------------------------------
// Small helpers

// (Object.prototype.hasOwnProperty, not Object.hasOwn: older iPhone Safari doesn't have that one.)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const copy = typeof structuredClone === 'function'
  ? (x) => structuredClone(x)
  : (x) => JSON.parse(JSON.stringify(x));

const ERRORS = {
  not_host: 'Only the host can do that.',
  not_lobby: 'That only works in the lobby, before the game starts.',
  not_live: 'That only works while a game is on.',
  not_over: 'That only works once the game is over.',
  bad_cmd: "That didn't work. Try again.",
  full: `This game is full (${LIMITS.players} players).`,
  no_ring: 'Draw the ring first.',
  too_few: 'You need at least 2 players to start.',
  no_hunters: 'Someone has to hunt. Pick at least one hunter.',
  no_hiders: 'Someone has to hide. Pick at least one hider.',
  not_your_turn: "That's not for you right now.",
  used: "That's already been used.",
  cooldown: 'Not yet. Try again in a moment.',
  one_at_a_time: 'One power at a time. Wait until the one that is on is done.',
  paused: 'The game is paused.',
  gone: "That player isn't in the game any more.",
  bad_target: "That player can't be picked for that.",
  name: `Pick a name, 1 to ${LIMITS.name} letters.`,
  face: "That picture didn't work. Try another one.",
  // v1.1
  driver: "The driver can't do that.",
  no_driver: 'A driver needs 2 or more hunters. Add a hunter or turn the driver off.',
  no_watch: "This game doesn't allow watching.",
  watch_full: `${LIMITS.watchers} people are watching already.`,
  radio_full: 'The walkie-talkie is full for this game.',
  bad_audio: "That recording didn't work. Try again.",
  no_clip: "That clip isn't kept.",
  // v1.2
  no_cam: 'The camera is off in this game.',
  not_recorded: "You weren't filmed in this game.",
  old_round: 'That clip is from an earlier round.',
  bad_video: "That clip didn't record properly.",
  cam_mine_full: "That's all the clips you can send for this game.",
  cam_game_full: "This game's clips are full. The rest stay on your phone.",
  cam_space: 'Night Ops is out of room for clips right now. Try again tomorrow.',
  not_uploaded: "That clip didn't arrive. Try again.",
  no_video: "That clip isn't kept.",
  side_changed: "Your team changed, so that message wasn't sent.",
  // v1.3
  no_checkpoints: 'Set up at least 2 checkpoints first.',
  bad_checkpoints: "Those checkpoints don't work. Check them again.",
  safe_zone: "That hider is in the checkpoint's safe zone.",
  cp_closed: 'That checkpoint is closed.',
  cp_done: 'You already did this checkpoint.',
  cp_outside: 'Get inside the checkpoint first.',
  cp_photo: "That photo didn't work. Try again.",
  cp_full: "There's no room for more photos in this game.",
  no_photo: "That photo isn't kept.",
  // v1.4
  no_consent: "That hider didn't say OK to Wiretap.",
  no_wiretap: 'Wiretap is off in this game.',
  no_pins: 'Team pins are off in this game.',
  pins_full: 'You have 3 pins. Remove one first.',
  tap_over: 'That listening time is over.',
  not_tapped: "The hunters aren't listening to you.",
};

// A sentence for an error code (any unknown code gets a general one).
export function errorText(code) {
  return typeof code === 'string' && has(ERRORS, code) ? ERRORS[code] : 'Something went wrong. Try again.';
}

function err(code, message) {
  return { error: { code, message: message || errorText(code) } };
}

// (The text helpers live in rules.js, shared with the checkpoints' names and tasks.)
const tidy = tidyText;
const cut = cutText;
export { nameKey };

function letters(text) {
  return Array.from(text).length;
}

// A name as it will be shown: one line, no invisible letters, at most LIMITS.name letters ('' = no name,
// also when nothing in it can be seen, like a lone Hangul filler or a blank braille cell).
export function cleanName(name) {
  const out = withoutLoneJoiners(cut(tidy(name), LIMITS.name)).trim();
  return seenAtAll(out) ? out : '';
}

// A chat message as it will be shown ('' = nothing to send). Longer than LIMITS.chat is refused, not cut.
export function cleanChat(text) {
  const out = tidy(text);
  return seenAtAll(out) ? out : '';
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== '__proto__' && !SIDE_WORDS.has(id);
}

function playerOf(s, id) {
  return typeof id === 'string' && s && s.players && has(s.players, id) ? s.players[id] : null;
}

// A usable position from the store's map ({p, at, acc, clock}), or null. `clock` is the game clock when the
// fix was taken (the server stamps it; older records have none).
function posOf(positions, id) {
  if (!positions || typeof positions !== 'object' || typeof id !== 'string' || !has(positions, id)) return null;
  const pos = positions[id];
  if (!pos || !isPoint(pos.p)) return null;
  return {
    p: [pos.p[0], pos.p[1]],
    at: Number.isFinite(pos.at) ? pos.at : null,
    acc: Number.isFinite(pos.acc) && pos.acc >= 0 ? pos.acc : 0,
    clock: Number.isFinite(pos.clock) ? pos.clock : null,
  };
}

// How old a fix is in real time: what the map shows as its age, and whether a spot is still current.
function ageOf(pos, now) {
  return pos.at === null ? 0 : Math.max(0, now - pos.at);
}

// A spot that's still current enough to show as "live" or "exact" (Radar, Exposure): no older than a ping
// would take.
function current(pos, now) {
  return !!pos && (pos.at === null || now - pos.at <= TIMING.OFFLINE_SHOW_MS);
}

// How long a hider's phone has been quiet, in game time: an SOS pause isn't counted, so nobody is shown on
// the map for putting their phone away while everyone helps. A fix without a clock stamp (an older record)
// falls back to real time, stopped at the pause. A stamp ahead of the clock isn't from this round (the store
// missed its clean-up), and real time says how old it is.
function quietFor(s, pos, clock, now) {
  let wall = 0;
  if (pos.at !== null) {
    const until = s.pausedAt !== null && s.pausedAt !== undefined ? Math.min(now, s.pausedAt) : now;
    wall = Math.max(0, until - pos.at);
  }
  if (pos.clock === null) return wall;
  const game = clock - pos.clock;
  return game < 0 ? wall : game;
}

const active = (p) => !!p && p.status !== 'left' && p.status !== 'kicked';
const isFree = (p) => !!p && p.team === 'hider' && p.status === 'in';
const isHunter = (p) => !!p && p.team === 'hunter' && p.status === 'in';

// Players in join order (ties by id), so randomness and lists never depend on object key order.
function ordered(s) {
  return Object.values(s.players).sort((a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function freeHiders(s) {
  return ordered(s).filter(isFree);
}

function countIn(s) {
  return Object.values(s.players).filter((p) => p.status === 'in').length;
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function seconds(ms) {
  return Math.max(1, Math.round(ms / 1000));
}

function minutesWords(min) {
  return min === 1 ? 'every minute' : `every ${min} min`;
}

// A small seeded generator, only used when a caller forgets to pass rand (so the engine stays pure).
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randOf(rand, s, now) {
  const base = typeof rand === 'function' ? rand : seeded(`${s.code}:${now}:${s.nextEventId}`);
  return () => {
    const v = Number(base());
    if (!Number.isFinite(v) || v < 0) return 0;
    return v < 1 ? v : 1 - 1e-12;
  };
}

function freshStats() {
  return { catches: 0, powers: [], distanceM: 0, drivenM: 0, pickups: 0 };
}

function freshRadio() {
  return { next: 1, bytes: 0, lastAt: {}, clips: [] };
}

// Settings with the v1.1/v1.2 extras filled in (an older stored state has none).
function extrasOf(settings) {
  const out = { ...(settings || {}) };
  for (const k of EXTRA_KEYS) if (typeof out[k] !== 'boolean') out[k] = DEFAULTS[k];
  for (const [k, list] of Object.entries(EXTRA_CHOICES)) if (!list.includes(out[k])) out[k] = DEFAULTS[k];
  // v1.3: the Checkpoints settings too.
  fixCheckpointSettings(out);
  // v1.4: Hacker and Wiretap (older stored settings have no switch for them).
  fixPowers(out);
  return out;
}

// Settings keys that are extras (never "changed by hand").
const EXTRA_ALL = [...EXTRA_KEYS, ...Object.keys(EXTRA_CHOICES)];

// The driver of this round who is still in, or null.
function driverOf(s) {
  if (!s || !s.driver || s.driver.left || (s.phase !== 'live' && s.phase !== 'over')) return null;
  const d = playerOf(s, s.driver.id);
  return d && d.status === 'in' && d.team === 'hunter' ? d : null;
}

// This round's driver id (also once they left), or null.
function driverIdOf(s) {
  return s && s.driver && typeof s.driver.id === 'string' && (s.phase === 'live' || s.phase === 'over') ? s.driver.id : null;
}

function isDriver(s, p) {
  return !!p && driverIdOf(s) === p.id;
}

function freshTeam() {
  return { radar: 'ready', exposure: 'ready', lastPowerAt: null };
}

function newPlayer({ id, name, secretHash, now }) {
  return {
    id, name, secretHash: typeof secretHash === 'string' ? secretHash : '',
    faceV: 0, joinedAt: now, lastSeen: now,
    pick: 'auto', team: null, startTeam: null, status: 'in',
    caughtBy: null, caughtAt: null, turnedAt: null,
    powers: {}, sprintFrom: null, sprintUntil: null, outsideSince: null,
    stats: freshStats(),
    driverAt: null,
    camOk: false,        // v1.2: "I'm OK being recorded" (kept across rounds)
    tapOk: false,        // v1.4: "I'm OK with Wiretap" (kept across rounds; reset when the host switches Wiretap)
    health: null,        // v1.4: what the phone last said about its location, camera, mic and sound
    // internal (never in a view)
    turnedEvent: null,   // first event id this player sees as a hunter (after being caught)
    leftAt: null,        // clock when they left or were removed
    track: null,         // { p, at }: the last spot counted towards distanceM
    outsideShown: false, // hunters were told this hider is outside the ring
    noFixTold: false,    // hunters were told this hider's phone sends no location (cleared by a new fix)
    chatAt: [],          // when they last chatted (epoch), for the slow-down rule
  };
}

function resetForGame(p) {
  p.team = null; p.startTeam = null;
  p.caughtBy = null; p.caughtAt = null; p.turnedAt = null; p.turnedEvent = null; p.leftAt = null;
  p.powers = {}; p.sprintFrom = null; p.sprintUntil = null; p.outsideSince = null; p.outsideShown = false;
  p.noFixTold = false;
  p.stats = freshStats(); p.track = null;
  p.driverAt = null;
  p.loot = null; p.lootHeld = {}; p.lootFx = {}; p.lootLast = null; // v1.6.1: loot
}

// Fill in internal fields a stored state may lack (older or hand-made states), on a copy we own.
function fillIn(s) {
  if (!s.flags || typeof s.flags !== 'object') s.flags = { hunt: false, closing: false };
  if (!Array.isArray(s.log)) s.log = [];
  if (!Array.isArray(s.events)) s.events = [];
  if (!Array.isArray(s.pings)) s.pings = [];
  if (!Array.isArray(s.catches)) s.catches = [];
  if (!s.team || typeof s.team !== 'object') s.team = freshTeam();
  if (!Number.isFinite(s.nextEventId)) s.nextEventId = s.events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  if (!Number.isFinite(s.nextCatchId)) s.nextCatchId = s.catches.length + 1;
  if (!Number.isFinite(s.pausedMs)) s.pausedMs = 0;
  if (s.endClock === undefined) s.endClock = null;
  for (const p of Object.values(s.players)) {
    if (!p.powers || typeof p.powers !== 'object') p.powers = {};
    if (!p.stats || typeof p.stats !== 'object') p.stats = freshStats();
    if (!Array.isArray(p.stats.powers)) p.stats.powers = [];
    if (!Array.isArray(p.chatAt)) p.chatAt = [];
    if (p.turnedEvent === undefined) p.turnedEvent = null;
    if (p.leftAt === undefined) p.leftAt = null;
    if (typeof p.noFixTold !== 'boolean') p.noFixTold = false;
  }
  if (s.overEventId === undefined) s.overEventId = null;
  // v1.1
  if (!Array.isArray(s.hostLog)) s.hostLog = [];
  if (s.settings && typeof s.settings === 'object') s.settings = extrasOf(s.settings);
  if (s.driverPick === undefined) s.driverPick = null;
  if (s.driver === undefined) s.driver = null;
  if (!Array.isArray(s.pickups)) s.pickups = [];
  if (!Number.isFinite(s.nextPickupId)) s.nextPickupId = s.pickups.length + 1;
  if (!s.watchers || typeof s.watchers !== 'object' || Array.isArray(s.watchers)) s.watchers = {};
  if (!Number.isFinite(s.watchJoins)) s.watchJoins = 0;
  if (!Array.isArray(s.removedWatchers)) s.removedWatchers = [];
  if (!s.radio || typeof s.radio !== 'object' || !Array.isArray(s.radio.clips)) s.radio = freshRadio();
  if (!Number.isFinite(s.radio.next)) s.radio.next = s.radio.clips.length + 1;
  if (!Number.isFinite(s.radio.bytes)) s.radio.bytes = 0;
  if (!s.radio.lastAt || typeof s.radio.lastAt !== 'object') s.radio.lastAt = {};
  for (const p of Object.values(s.players)) {
    if (!Number.isFinite(p.stats.drivenM)) p.stats.drivenM = 0;
    if (!Number.isFinite(p.stats.pickups)) p.stats.pickups = 0;
    if (p.driverAt === undefined) p.driverAt = null;
    // v1.2
    if (typeof p.camOk !== 'boolean') p.camOk = false;
  }
  // v1.2
  if (s.cam === undefined || (s.cam !== null && (typeof s.cam !== 'object' || !Array.isArray(s.cam.ids)))) s.cam = null;
  if (s.cam) {
    if (!Array.isArray(s.cam.moments)) s.cam.moments = [];
    if (!Number.isFinite(s.cam.next)) s.cam.next = s.cam.moments.reduce((m, x) => Math.max(m, x.n || 0), 0) + 1;
    if (!s.cam.near || typeof s.cam.near !== 'object' || Array.isArray(s.cam.near)) s.cam.near = {};
    if (!s.cam.have || typeof s.cam.have !== 'object' || Array.isArray(s.cam.have)) s.cam.have = {};
    if (s.cam.mode !== 'everything') s.cam.mode = 'highlights';
  }
  for (const c of s.radio.clips) if (c.side !== 'hiders' && c.side !== 'wiretap') c.side = 'hunters';
  // v1.3
  if (!Array.isArray(s.checkpoints)) s.checkpoints = [];
  fillCp(s);
  // v1.4
  for (const p of Object.values(s.players)) {
    if (typeof p.tapOk !== 'boolean') p.tapOk = false;
    if (p.health === undefined || (p.health !== null && typeof p.health !== 'object')) p.health = null;
  }
  if (!Array.isArray(s.hacks)) s.hacks = [];
  if (!Array.isArray(s.taps)) s.taps = [];
  if (!Number.isFinite(s.nextTapId)) s.nextTapId = s.taps.length + 1;
  if (!Array.isArray(s.pins)) s.pins = [];
  if (!Number.isFinite(s.nextPinId)) s.nextPinId = s.pins.length + 1;
  return s;
}

// The epoch time of a game-clock moment (only valid while the game isn't paused).
function epochOf(s, clock) {
  return s.startedAt + s.pausedMs + clock;
}

// Event ids follow the server's clock (the ms it happened, or the next free number): a player who only sees
// some events can't count the ones in between (a gap only says time went by, which `at` says anyway).
function emit(s, t, kind, to, text, data, from) {
  const id = Math.max(s.nextEventId, Number.isFinite(t.now) ? Math.floor(t.now) : 0);
  s.nextEventId = id + 1;
  const e = { id, at: t.at, clock: t.clock, kind, to, text };
  if (from) e.from = from;
  if (data) e.data = data;
  s.events.push(e);
  if (s.events.length > EVENTS_KEPT) s.events.splice(0, s.events.length - EVENTS_KEPT);
  return e;
}

// The play-by-play and the facts close calls are made from (kept in the state, never in a view).
function note(s, entry) {
  s.log.push(entry);
  if (s.log.length > LOG_KEPT) s.log.splice(0, s.log.length - LOG_KEPT);
}

// v1.2: a moment for the camera (a Highlights clip is kept around it). Only while the round is filmed (live, or
// the 'over' moment as it ends), only for filmed players (`ids`, and `with` for a near call's hunter, who is never
// told); a moment that names no filmed player isn't kept. `data` stays small ({ power }, { how }).
function addMoment(s, t, kind, ids, { ms, data, with: also } = {}) {
  const cam = s.cam;
  if (!cam || !Array.isArray(cam.ids)) return null;
  if (s.phase !== 'live' && !(s.phase === 'over' && kind === 'over')) return null;
  const filmed = (list) => [...new Set((list || []).filter((id) => typeof id === 'string' && cam.ids.includes(id)))];
  const told = filmed(ids);
  const others = filmed(also).filter((id) => !told.includes(id));
  if (!told.length && !others.length) return null;
  const m = { n: cam.next++, clock: Math.max(0, Math.round(t.clock)), kind, ids: told };
  if (others.length) m.with = others;
  if (Number.isFinite(ms)) m.ms = ms;
  if (data) m.data = data;
  cam.moments.push(m);
  if (cam.moments.length > LIMITS.camMoments) cam.moments.splice(0, cam.moments.length - LIMITS.camMoments);
  return m;
}

// Hunters in (the driver too) within CAM_NEAR_M of a free hider, both fixes fresh, and no near moment for the pair
// within CAM_NEAR_GAP_MS: [[hunterId, hiderId]...], only pairs with a filmed player.
function nearPairs(s, ctx, clock) {
  const cam = s.cam;
  if (!cam || s.pausedAt !== null && s.pausedAt !== undefined) return [];
  const fresh = (id) => {
    const pos = posOf(ctx.positions, id);
    return pos && pos.at !== null && ctx.now - pos.at >= -TIMING.CAM_NEAR_FRESH_MS && ctx.now - pos.at <= TIMING.CAM_NEAR_FRESH_MS ? pos : null;
  };
  const near = cam.near && typeof cam.near === 'object' ? cam.near : {};
  const out = [];
  const hiders = freeHiders(s).map((h) => [h, fresh(h.id)]).filter(([, pos]) => pos);
  if (!hiders.length) return out;
  for (const hunter of ordered(s)) {
    if (!isHunter(hunter)) continue;
    const hp = fresh(hunter.id);
    if (!hp) continue;
    for (const [hider, dp] of hiders) {
      if (!cam.ids.includes(hunter.id) && !cam.ids.includes(hider.id)) continue;
      const last = near[`${hunter.id}:${hider.id}`];
      if (Number.isFinite(last) && clock - last < TIMING.CAM_NEAR_GAP_MS) continue;
      if (distanceM(hp.p, dp.p) <= TIMING.CAM_NEAR_M) out.push([hunter.id, hider.id]);
    }
  }
  return out;
}

function addNear(s, t, hunterId, hiderId) {
  const cam = s.cam;
  cam.near[`${hunterId}:${hiderId}`] = t.clock;
  // (Old pairs go: one older than the gap can't hold anything back any more.)
  for (const [k, at] of Object.entries(cam.near)) {
    if (!Number.isFinite(at) || t.clock - at >= TIMING.CAM_NEAR_GAP_MS) delete cam.near[k];
  }
  addMoment(s, t, 'near', [hiderId], { with: [hunterId] });
}

function leftWords(n) {
  return n === 0 ? 'No hiders left.' : n === 1 ? '1 hider left.' : `${n} hiders left.`;
}

// ---------------------------------------------------------------------------------------------------------
// Making a game

export function newGame({ code, hostId, hostName, secretHash, now }) {
  const name = cleanName(hostName) || 'Host';
  const players = {};
  players[hostId] = newPlayer({ id: hostId, name, secretHash, now });
  return {
    v: 1,
    code: String(code || ''),
    createdAt: now,
    updatedAt: now,
    phase: 'lobby',
    hostId,
    settings: cleanSettings(null),
    ring: null,
    players,
    startedAt: null,
    pausedAt: null,
    pausedMs: 0,
    pings: [],
    team: freshTeam(),
    radar: null,
    exposure: null,
    catches: [],
    sos: null,
    events: [],
    nextEventId: 1,
    result: null,
    summary: null,
    // internal
    flags: { hunt: false, closing: false }, // the 'hunt' and 'closing' events have been sent
    log: [],                                 // play-by-play + facts for close calls
    endClock: null,                          // the clock when the game ended
    overEventId: null,                       // the 'over' event's id: a phone past it has the summary already
    nextCatchId: 1,                          // never reset, so an old tag id never matches a new tag
    // v1.1
    driverPick: null,                        // lobby: the host's choice of driver (null = pick for me)
    driver: null,                            // live/over: { id, left }
    pickups: [],
    nextPickupId: 1,
    watchers: {},                            // spectators (kept across rounds)
    watchJoins: 0,
    removedWatchers: [],
    radio: freshRadio(),
    // v1.4
    hacks: [],                               // this round's Hacker uses
    taps: [],                                // this round's Wiretap uses
    nextTapId: 1,
    pins: [],                                // this round's team pins
    nextPinId: 1,
    // v1.2
    cam: null,                               // live/over with settings.cam: who is filmed and their moments
    // v1.3
    checkpoints: [],                         // the host's checkpoints (any phase; kept across rounds)
    cp: null,                                // live/over in Checkpoints: this round's plan, visits and dones
  };
}

// Names already used (by anyone still in the game) get " 2", " 3"... Names are compared by what can be seen
// (nameKey), so "Sam" with an invisible letter tacked on is still "Sam" and gets its number.
function uniqueName(name, taken) {
  const used = new Set(taken.map(nameKey));
  if (!used.has(nameKey(name))) return name;
  for (let k = 2; k < 1000; k++) {
    const tail = ` ${k}`;
    const candidate = `${withoutLoneJoiners(cut(name, LIMITS.name - tail.length)).trimEnd()}${tail}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
  return name;
}

export function addPlayer(state, { id, name, secretHash, now } = {}) {
  if (!state || state.phase !== 'lobby') return err('not_lobby');
  if (!validId(id) || playerOf(state, id) || typeof secretHash !== 'string') return err('bad_cmd');
  const clean = cleanName(name);
  if (!clean) return err('name');
  const here = Object.values(state.players).filter(active);
  if (here.length >= LIMITS.players) return err('full');
  const s = fillIn(copy(state));
  const finalName = uniqueName(clean, here.map((p) => p.name));
  s.players[id] = newPlayer({ id, name: finalName, secretHash, now });
  const t = { now, clock: 0, at: now };
  emit(s, t, 'join', 'all', `${finalName} joined.`, { id });
  // A host who left an empty lobby leaves nobody to start the game: whoever joins next takes over.
  if (!active(playerOf(s, s.hostId))) passHost(s, t);
  s.updatedAt = now;
  return { state: s };
}

// ---------------------------------------------------------------------------------------------------------
// The clock

export function clockOf(state, now) {
  if (!state || state.startedAt === null || state.startedAt === undefined) return 0;
  if (state.phase === 'over' && Number.isFinite(state.endClock)) return state.endClock;
  const end = state.pausedAt !== null && state.pausedAt !== undefined ? state.pausedAt : now;
  return Math.max(0, end - state.startedAt - (state.pausedMs || 0));
}

function ringAt(s, clock) {
  if (!s.ring) return null;
  const f = ringScaleAt(s.settings, clock);
  return f === 1 ? s.ring : scaleRing(s.ring, f);
}

// ---------------------------------------------------------------------------------------------------------
// Catching, leaving, the end

// A free hider is caught: they join the hunters (Infection, or caught 'join') or sit out.
function catchHider(s, hider, hunterId, how, t, record) {
  const turned = s.settings.mode === 'infection' || s.settings.caught === 'join';
  s.catches = s.catches.filter((c) => c === record || !(c.hider === hider.id && c.state === 'pending'));
  hider.caughtBy = hunterId || null;
  hider.caughtAt = t.clock;
  hider.powers = {};
  hider.sprintFrom = null;
  hider.sprintUntil = null;
  hider.outsideSince = null;
  hider.outsideShown = false;
  if (cpGame(s)) cpEndVisit(s, hider.id, t.clock, 'gone', t);
  // v1.4: a Wiretap on a caught hider ends now (it was agreed to as a hider, never after).
  for (const tap of s.taps || []) {
    if (tapOpen(tap) && tap.target === hider.id) finishTap(s, tap, t, { giveBack: true, tell: true });
  }
  if (turned) {
    hider.team = 'hunter';
    hider.turnedAt = t.clock;
    hider.turnedEvent = s.nextEventId;
  } else {
    hider.status = 'caught';
  }
  const hunter = hunterId ? playerOf(s, hunterId) : null;
  if (hunter && how !== 'ring') hunter.stats.catches += 1;
  const left = freeHiders(s).length;
  let line;
  if (how === 'ring') line = `${hider.name} stayed outside the ring and ${turned ? 'is caught' : 'is out'}.`;
  else if (hunter) line = `${hunter.name} caught ${hider.name}.`;
  else line = `${hider.name} is caught.`;
  const text = `${line} ${leftWords(left)}`;
  emit(s, t, 'caught', 'all', text, { hider: hider.id, hunter: hunter ? hunter.id : null, how, left });
  addMoment(s, t, 'caught', [hider.id, hunter && how !== 'ring' && how !== 'host' ? hunter.id : null], { data: { how } });
  note(s, { kind: 'caught', clock: t.clock, hider: hider.id, hunter: hunter ? hunter.id : null, how, text: line });
  if (turned) emit(s, t, 'turned', hider.id, "You're a hunter now. Go get them!");
  else emit(s, t, 'out', hider.id, "You're out. You can still chat with everyone.");
}

function winnersOf(s, reason) {
  const list = ordered(s);
  if (reason === 'caught') {
    let w = list.filter((p) => p.startTeam === 'hunter' && p.status === 'in');
    if (!w.length) w = list.filter(isHunter);
    return w.map((p) => p.id);
  }
  return list.filter(isFree).map((p) => p.id);
}

function mvpOf(s, reason, winners) {
  const driverId = driverIdOf(s);
  if (reason !== 'caught' && winners.length) {
    let best = null;
    for (const id of winners) {
      const p = s.players[id];
      if (id === driverId) continue;
      if (!best || p.stats.distanceM > best.stats.distanceM) best = p;
    }
    return best ? best.id : null;
  }
  // The hunter with the most catches; a tie goes to whoever got there first.
  const count = {};
  const reached = {};
  for (const e of s.log) {
    if (e.kind !== 'caught' || !e.hunter || e.how === 'ring') continue;
    count[e.hunter] = (count[e.hunter] || 0) + 1;
    reached[e.hunter] = e.clock;
  }
  let best = null;
  for (const p of ordered(s)) {
    const n = count[p.id] || 0;
    if (!n || p.status === 'kicked' || p.id === driverId) continue;
    if (!best || n > count[best] || (n === count[best] && reached[p.id] < reached[best])) best = p.id;
  }
  return best;
}

function winWords(s, ids, side) {
  if (!ids.length) return '';
  if (ids.length > 4) return `The ${side} win!`;
  const names = ids.map((id) => s.players[id].name);
  return `${listNames(names)} ${names.length === 1 ? 'wins' : 'win'}!`;
}

function endGame(s, reason, t) {
  if (s.pausedAt !== null) {
    s.pausedMs += t.now - s.pausedAt;
    s.pausedAt = null;
    s.sos = null;
  }
  // Tags still waiting don't count. At time's up only a tag the hider's phone never got can still be waiting
  // (the end waits for every other one), so say why it didn't count.
  for (const c of s.catches) {
    if (c.state !== 'pending' || reason !== 'time') continue;
    const hunter = playerOf(s, c.hunter);
    const hider = playerOf(s, c.hider);
    if (!hunter || !hider) continue;
    emit(s, t, 'lapsed', 'all', `${hunter.name}'s tag on ${hider.name} doesn't count: ${hider.name}'s phone never got it.`, { catchId: c.id });
  }
  s.catches = s.catches.filter((c) => c.state !== 'pending');
  s.endClock = t.clock;
  endPickups(s, () => true, t);
  // v1.4: every pin ends, and every tap still going.
  endPinsAndTaps(s, t, () => true, 'ended');
  // v1.3: every checkpoint visit ends (its safe time added); nothing more is told.
  cpEndAll(s, t, 'end');
  s.phase = 'over';
  s.radar = null;
  const cw = cpWinners(s);
  const winners = cw ? cw.winners : winnersOf(s, reason);
  const mvp = cw ? mvpOf(s, 'time', winners) : mvpOf(s, reason, winners);
  s.result = { reason, winners, mvp };
  const text = overText(s, reason, winners, cw);
  s.overEventId = emit(s, t, 'over', 'all', text, { reason, winners: winners.slice() }).id;
  addMoment(s, t, 'over', ordered(s).filter((p) => p.status === 'in' || p.status === 'caught').map((p) => p.id));
  note(s, { kind: 'over', clock: t.clock, text });
  // A summary without routes right away, so the end screen always has one; the server builds the full one
  // with the stored routes and puts it in place of this one.
  s.summary = summarize(s, []);
}

// The line the game ends with (also written again when the host strikes a photo after the end).
function overText(s, reason, winners, cw) {
  let text;
  if (cw) {
    const lead = reason === 'time' ? "Time's up!" : reason === 'caught'
      ? (s.catches.some((c) => c.state === 'done') ? "Everyone's caught." : 'No hiders left.') : 'The host ended the game.';
    text = `${lead} ${cpWinWords(s, winners, cw.count)}`;
  } else if (reason === 'time') {
    text = winners.length ? `Time's up! ${winWords(s, winners, 'hiders')}` : "Time's up!";
  } else if (reason === 'caught') {
    const anyCaught = s.catches.some((c) => c.state === 'done');
    const win = winWords(s, winners, 'hunters');
    text = `${anyCaught ? "Everyone's caught." : 'No hiders left.'}${win ? ` ${win}` : ''}`;
  } else {
    const win = winWords(s, winners, 'hiders');
    text = `The host ended the game.${win ? ` ${win}` : ''}`;
  }
  return text;
}

// Open pickups that should end (the game ended, the driver went, the asker left) become 'ended'.
function endPickups(s, which, t) {
  for (const k of s.pickups || []) {
    if ((k.state === 'open' || k.state === 'coming') && which(k)) {
      k.state = 'ended';
      k.endedAt = t.clock;
    }
  }
}

function checkEnd(s, t) {
  if (s.phase === 'live' && freeHiders(s).length === 0) endGame(s, 'caught', t);
}

function resumeGame(s, t, byId) {
  s.pausedMs += t.now - s.pausedAt;
  s.pausedAt = null;
  s.sos = null;
  emit(s, t, 'resume', 'all', 'Game back on.', { by: byId || null });
}

// Host changes during a round, so a spectator's delayed view names the host as it was then (hostAt).
function logHost(s, to, t) {
  if (s.phase !== 'live') return;
  if (!Array.isArray(s.hostLog)) s.hostLog = [];
  s.hostLog.push({ from: s.hostId, to, clock: t.clock });
  if (s.hostLog.length > HOST_LOG_KEPT) s.hostLog.splice(0, s.hostLog.length - HOST_LOG_KEPT);
}

function hostAt(s, T) {
  let id = s.hostId;
  const log = Array.isArray(s.hostLog) ? s.hostLog : [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (!(log[i].clock > T)) break;
    id = log[i].from;
  }
  return id;
}

function passHost(s, t) {
  const rest = ordered(s).filter((p) => p.id !== s.hostId);
  const next = rest.find((p) => p.status === 'in') || rest.find(active);
  if (!next) return;
  logHost(s, next.id, t);
  s.hostId = next.id;
  emit(s, t, 'host', 'all', `${next.name} is the host now.`, { id: next.id });
}

// Someone leaves or is removed: in every phase, with everything that hangs on them tidied up.
function removePlayer(s, p, status, t) {
  const wasFree = isFree(p);
  const wasHunter = isHunter(p);
  p.status = status;
  if (s.phase === 'live') p.leftAt = t.clock;
  p.powers = {};
  p.sprintFrom = null;
  p.sprintUntil = null;
  p.outsideSince = null;
  p.outsideShown = false;
  if (s.phase === 'live' && cpGame(s)) cpEndVisit(s, p.id, t.clock, 'gone', t);
  s.catches = s.catches.filter((c) => !(c.hider === p.id && c.state === 'pending'));
  if (status === 'kicked') emit(s, t, 'kick', 'all', `${p.name} was removed from the game.`, { id: p.id });
  else emit(s, t, 'leave', 'all', `${p.name} left the game.`, { id: p.id });
  if (s.phase === 'live') note(s, { kind: 'leave', clock: t.clock, id: p.id, text: `${p.name} left the game.` });
  if (s.hostId === p.id) passHost(s, t);
  if (s.phase === 'lobby' && s.driverPick === p.id) s.driverPick = null;
  if (s.phase === 'live') {
    endPinsAndTaps(s, t, (id) => id === p.id);
    endPickups(s, (k) => k.by === p.id, t);
    if (s.driver && s.driver.id === p.id && !s.driver.left) {
      s.driver.left = true;
      endPickups(s, () => true, t);
      const text = status === 'kicked' ? `${p.name} was removed, so nobody is driving now.`
        : `${p.name} left, so nobody is driving now.`;
      emit(s, t, 'driver', 'all', text, { id: p.id });
    }
  }
  if (s.phase !== 'live') return;
  if (s.pausedAt !== null && (!s.sos || s.sos.by === p.id)) resumeGame(s, t, null);
  if (wasFree) checkEnd(s, t);
  if (s.phase === 'live' && wasHunter) {
    const hunters = Object.values(s.players).filter(isHunter);
    if (!hunters.length) {
      emit(s, t, 'info', 'all', 'No hunters left. The host can end the game.');
    } else if (hunters.every((x) => isDriver(s, x))) {
      emit(s, t, 'info', 'all', 'Only the driver is left on the hunters\' side, and the driver never tags. The host can end the game.');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pings

// A point somewhere inside the ring (null when a polygon's try misses): 2 rand() calls.
function pointInRing(ring, R) {
  if (ring.kind === 'circle') return moveM(ring.center, Math.sqrt(R()) * ring.radiusM, R() * 360);
  const [[w, so], [e, no]] = boundsOf(ring.points);
  const p = [w + R() * (e - w), so + R() * (no - so)];
  return ringContains(ring, p) ? p : null;
}

// Where a Decoy's fake ping goes: 200-400 m from the hider, somewhere else in the ring. A fake spot outside
// the ring would give the Decoy away (an honest circle is never further out than its own radius), so it
// stays inside. A small or thin ring: the point inside it found closest to that 200-400 m band. Only a
// fixed number of rand() calls, so tests stay exact.
function decoySpot(ring, spot, R) {
  const min = TIMING.DECOY_MIN_M;
  const max = TIMING.DECOY_MAX_M;
  if (!ring) return moveM(spot, min + R() * (max - min), R() * 360);
  for (let i = 0; i < DECOY_TRIES; i++) {
    const c = moveM(spot, min + R() * (max - min), R() * 360);
    if (ringContains(ring, c)) return c;
  }
  let best = null;
  let bestOff = Infinity;
  for (let i = 0; i < DECOY_SAMPLES; i++) {
    const c = pointInRing(ring, R);
    if (!c) continue;
    const d = distanceM(spot, c);
    const off = d < min ? min - d : d > max ? d - max : 0;
    if (off < bestOff) { best = c; bestOff = off; }
  }
  return best || spot;
}

function takePing(s, n, clock, ctx) {
  const t = { now: ctx.now, clock, at: epochOf(s, clock) };
  const r = pingRadiusAt(s.settings, clock);
  const R = ctx.rand;
  const spots = {};
  const fakes = {}; // (whose spot was a Decoy's or Sprint's start: only the pro edit reads it, after the game)
  const results = [];
  const quiet = [];
  let count = 0;
  for (const p of freeHiders(s)) {
    let result;
    const lfx = p.lootFx && typeof p.lootFx === 'object' ? p.lootFx : null;
    if (lfx && lfx.ghost > 0) { // v1.6.1: Ghost (loot): not on this ping
      spots[p.id] = { skipped: 'ghost' };
      lfx.ghost -= 1;
      result = 'ghost';
    } else if (p.powers.jammer === 'on') {
      spots[p.id] = { skipped: 'jammer' };
      p.powers.jammer = 'used';
      result = 'jammer';
      // Used up by a ping during a Radar warning: it still hides them from that Radar (they turned it on
      // in time, and their screen said so).
      if (s.radar && !s.radar.recorded && clock < s.radar.liveAt) {
        if (!Array.isArray(s.radar.blocked)) s.radar.blocked = [];
        if (!s.radar.blocked.includes(p.id)) s.radar.blocked.push(p.id);
      }
    } else {
      const pos = posOf(ctx.positions, p.id);
      if (!pos || quietFor(s, pos, clock, t.at) > TIMING.OFFLINE_SHOW_MS) {
        spots[p.id] = { skipped: 'nosignal' };
        result = 'nosignal';
        quiet.push(p);
      } else {
        let spot = pos.p;
        result = 'pinged';
        if (p.powers.decoy === 'on') {
          spot = decoySpot(ringAt(s, clock), spot, R);
          p.powers.decoy = 'used';
          result = 'decoy';
        } else if (p.powers.sprint === 'on' && p.sprintUntil !== null && clock < p.sprintUntil && isPoint(p.sprintFrom)) {
          spot = [p.sprintFrom[0], p.sprintFrom[1]];
          result = 'sprint';
        }
        // The circle's centre is the spot moved up to r in a random direction (sqrt: even over the area),
        // so the spot is somewhere inside the circle, never always in the middle.
        let rr = r;
        let smoke = false;
        if (lfx && lfx.smoke) { // v1.6.1: Smoke (loot): a big cloud, even with exact pings
          rr = Math.max(r, SMOKE_R);
          lfx.smoke = false;
          smoke = true;
          if (result === 'pinged') result = 'smoke';
        }
        const d = Math.sqrt(R()) * rr;
        const b = R() * 360;
        spots[p.id] = { p: rr > 0 ? moveM(spot, d, b) : spot, r: rr, ...(smoke ? { smoke: true } : {}) };
        if (result === 'decoy' || result === 'sprint') fakes[p.id] = result;
        count++;
      }
    }
    results.push([p, result]);
  }
  s.pings.push({ n, clock, at: t.at, spots, ...(Object.keys(fakes).length ? { fakes } : {}) });
  let hunters = count === 0 ? 'Ping! Nobody showed up on the map.'
    : count === 1 ? 'Ping! 1 hider on the map.' : `Ping! ${count} hiders on the map.`;
  // A phone that sends no location is named (the hunters should know who isn't playing fair or has a
  // problem); a Jammer never is, so the hunters never learn who used a power.
  if (quiet.length) hunters += ` No signal from ${listNames(quiet.map((p) => p.name))}.`;
  const data = { n, count };
  if (quiet.length) data.nosignal = quiet.map((p) => p.id);
  emit(s, t, 'ping', 'hunters', hunters, data);
  const words = {
    pinged: 'You were pinged.',
    jammer: 'Jammer worked. They got nothing on you.',
    decoy: 'Decoy worked. They saw a fake spot.',
    sprint: 'Sprint: they only saw where you started.',
    ghost: 'Ghost: you were invisible on that ping.',
    smoke: 'Smoke: they only saw a big cloud.',
    nosignal: 'The ping missed you: no location from your phone.',
  };
  for (const [p, result] of results) emit(s, t, 'ping', p.id, words[result], { n, result });
}

// ---------------------------------------------------------------------------------------------------------
// advance: everything that happens by itself as the game clock runs

// When a waiting tag's minute started: when the hider's phone got it (seenAt). A tag their phone never got
// has no start (null): it waits for them or for the host. (A tag stored before tags were marked seen counts
// from when it was made, as it did then.)
function tagFrom(c) {
  if (Number.isFinite(c.seenAt)) return c.seenAt;
  return c.askEventId === undefined && Number.isFinite(c.at) ? c.at : null;
}

// When time's up really ends the game: the end of the clock, or later while a tag waits for its answer, so
// a hider tagged in the last minute can't win by not answering. A tag the phone never got waits a minute
// from when it was made (time for the phone to get it); after that it doesn't count.
function endAt(s, sch) {
  let end = sch.endMs;
  for (const c of s.catches) {
    if (c.state !== 'pending') continue;
    const from = tagFrom(c);
    end = Math.max(end, (from !== null ? from : c.at) + TIMING.TAG_AUTO_MS);
  }
  return end;
}

// The earliest thing due, in the order the contract lists (ties: tags, Radar going live, pings, Radar's end,
// Sprint's end, outside, no signal, closing in, the end), or null.
function nextDue(s, sch, ctx, clockNow) {
  let best = null;
  const offer = (clock, prio, item) => {
    if (!Number.isFinite(clock)) return;
    if (!best || clock < best.clock || (clock === best.clock && prio < best.prio)) best = { clock, prio, ...item };
  };
  if (!s.flags.hunt) offer(sch.headStartMs, 0, { type: 'hunt' });
  for (const c of s.catches) {
    if (c.state !== 'pending') continue;
    const from = tagFrom(c);
    if (from !== null) offer(from + TIMING.TAG_AUTO_MS, 1, { type: 'tag', id: c.id });
  }
  if (s.radar && !s.radar.recorded) offer(s.radar.liveAt, 2, { type: 'radarLive' });
  const times = pingTimes(s, sch); // v1.6.1: Double Double moves pings
  if (s.pings.length < times.length) offer(times[s.pings.length], 3, { type: 'ping', n: s.pings.length + 1 });
  lootFxDue(s, offer); // v1.6.1
  if (s.radar && s.radar.recorded) offer(s.radar.until, 4, { type: 'radarEnd' });
  for (const p of ordered(s)) {
    if (!isFree(p)) continue;
    if (p.powers.sprint === 'on' && p.sprintUntil !== null) offer(p.sprintUntil, 5, { type: 'sprintEnd', id: p.id });
    // (The ring rule stops at time's up, also while the end waits for a tag's answer.)
    if (p.outsideSince !== null) {
      const show = p.outsideSince + TIMING.OUTSIDE_SHOW_MS;
      const catchAt = p.outsideSince + TIMING.OUTSIDE_CATCH_MS;
      if (!p.outsideShown && show < sch.endMs) offer(show, 6, { type: 'outsideShow', id: p.id });
      // (v1.5.1: the ring no longer catches anyone: outside, you stay live on the hunters' map until you're back in)
      if (TIMING.OUTSIDE_CATCH_MS > 0 && catchAt < sch.endMs) offer(catchAt, 7, { type: 'outsideCatch', id: p.id });
    }
    // A phone that sends no location: the hunters are told, once until it sends one again. No position at
    // all: a few minutes into the hunt; an old one: when its spot shows up on the hunters' map.
    if (!p.noFixTold) {
      const pos = posOf(ctx.positions, p.id);
      const due = pos
        ? Math.max(sch.headStartMs, clockNow - quietFor(s, pos, clockNow, ctx.now) + TIMING.OFFLINE_SHOW_MS)
        : sch.headStartMs + TIMING.OFFLINE_SHOW_MS;
      if (due < sch.endMs) offer(due, 7.5, { type: 'noSignal', id: p.id });
    }
  }
  if (sch.closingMs > 0 && !s.flags.closing) offer(sch.closingStartMs, 8, { type: 'closing' });
  offer(endAt(s, sch), 9, { type: 'end' });
  cpDue(s, sch, offer);
  v14Due(s, offer);
  // v1.6: Loot drops (read only here: the record is made when the drop runs)
  if (lootGame(s) && s.ring) {
    const next = s.loot && Number.isFinite(s.loot.next) ? s.loot.next : sch.headStartMs + LOOT_FIRST_MS;
    if (next < sch.endMs) offer(next, 9.5, { type: 'lootDrop' });
  }
  return best;
}

function runDue(s, item, ctx) {
  const t = { now: ctx.now, clock: item.clock, at: epochOf(s, item.clock) };
  const p = item.id ? playerOf(s, item.id) : null;
  switch (item.type) {
    case 'hunt': {
      s.flags.hunt = true;
      emit(s, t, 'hunt', 'all', 'Head start is over. Go get them!');
      note(s, { kind: 'hunt', clock: t.clock, text: 'Head start over. The hunt is on.' });
      break;
    }
    case 'tag': {
      const c = s.catches.find((x) => x.id === item.id);
      const hider = c ? playerOf(s, c.hider) : null;
      if (!c) break;
      if (!isFree(hider)) {
        s.catches = s.catches.filter((x) => x !== c);
        break;
      }
      c.state = 'done';
      catchHider(s, hider, c.hunter, 'tag', t, c);
      checkEnd(s, t);
      break;
    }
    case 'radarLive': {
      // Hiders whose Jammer is on right now stay hidden for this whole Radar, and so do the ones whose Jammer
      // a ping used up during the warning (takePing put them in `blocked`).
      const early = Array.isArray(s.radar.blocked) ? s.radar.blocked : [];
      const blocked = freeHiders(s).filter((h) => h.powers.jammer === 'on' || early.includes(h.id)).map((h) => h.id);
      s.radar.recorded = true;
      s.radar.blocked = blocked;
      note(s, { kind: 'radar-live', clock: t.clock, blocked: blocked.slice() });
      const mins = Math.round(TIMING.RADAR_LIVE_MS / 60000);
      emit(s, t, 'radar-live', 'hunters', `Radar is live for ${mins} min.`);
      emit(s, t, 'radar-live', 'hiders', `Radar is live. The hunters can see hiders for ${mins} min.`);
      for (const id of blocked) emit(s, t, 'radar-live', id, 'Your Jammer hides you from this Radar.');
      break;
    }
    case 'ping':
      takePing(s, item.n, item.clock, ctx);
      break;
    case 'trackerTick': lootTrackerTick(s, t, ctx); break; // v1.6.1
    case 'mythicNext': lootMythicNext(s, t, ctx); break; // v1.6.1
    case 'radarEnd': {
      s.radar = null;
      emit(s, t, 'radar-over', 'hunters', 'Radar is off.');
      emit(s, t, 'radar-over', 'hiders', 'Radar is off.');
      break;
    }
    case 'sprintEnd': {
      p.powers.sprint = 'used';
      p.sprintFrom = null;
      p.sprintUntil = null;
      emit(s, t, 'sprint-over', p.id, 'Sprint is over. Pings show where you really are again.');
      break;
    }
    case 'outsideShow': {
      p.outsideShown = true;
      emit(s, t, 'outside', 'hunters', `${p.name} is outside the ring: live on your map.`, { id: p.id });
      emit(s, t, 'outside', p.id, "The hunters can see you live until you're back inside the ring.", { seen: true });
      break;
    }
    case 'outsideCatch': {
      const record = { id: `c${s.nextCatchId++}`, hunter: null, hider: p.id, at: t.clock, how: 'ring', state: 'done' };
      s.catches.push(record);
      catchHider(s, p, null, 'ring', t, record);
      checkEnd(s, t);
      break;
    }
    case 'noSignal': {
      if (!isFree(p) || p.noFixTold) break;
      p.noFixTold = true;
      const mins = Math.round(TIMING.OFFLINE_SHOW_MS / 60000);
      const last = posOf(ctx.positions, p.id);
      const text = `No location from ${p.name}'s phone for ${mins} min.${last ? ' Their last spot is on your map.' : ''}`;
      emit(s, t, 'nosignal', 'hunters', text, { id: p.id });
      // The host settles arguments, so they hear it too, whichever side they're on.
      const host = playerOf(s, s.hostId);
      if (host && active(host) && host.id !== p.id && !isHunter(host)) {
        emit(s, t, 'nosignal', host.id, `No location from ${p.name}'s phone for ${mins} min.`, { id: p.id });
      }
      emit(s, t, 'nosignal', p.id, last
        ? 'Your phone stopped sending its location, so the hunters were shown your last spot. Keep Night Ops open.'
        : "The hunters were told your phone isn't sending its location. Turn location on for Night Ops.", { id: p.id });
      break;
    }
    case 'closing': {
      s.flags.closing = true;
      const sch = schedule(s.settings);
      const left = pingTimes(s, sch).filter((x) => x >= sch.closingStartMs).length;
      const parts = [];
      // (The first closing ping comes as closing in starts, just before this line.)
      if (left >= 2) parts.push(`Pings ${minutesWords(s.settings.closingPingEveryMin)}`);
      else if (left === 1) parts.push('That was the last ping');
      if (s.settings.shrink) parts.push(parts.length ? 'the ring is shrinking' : 'The ring is shrinking');
      const text = parts.length ? `Closing in! ${parts.join(left === 1 ? ', and ' : ' and ')}.` : 'Closing in!';
      emit(s, t, 'closing', 'all', text);
      note(s, { kind: 'closing', clock: t.clock, text: 'Closing in.' });
      break;
    }
    case 'end':
      // (A tag settled at this same moment may have caught the last hider already.)
      endGame(s, freeHiders(s).length ? 'time' : 'caught', t);
      break;
    case 'pinEnd':
    case 'tapEnd':
      v14RunDue(s, item, t);
      break;
    case 'lootDrop': { // v1.6
      lootOf(s, schedule(s.settings).headStartMs);
      const made = lootDrop(s, ringAt(s, item.clock), item.clock, ctx.rand, freeHiders(s).length);
      if (made.length) {
        emit(s, t, 'loot', 'all', made.length === 1 ? 'A loot box dropped! Check the map.' : `${made.length} loot boxes dropped! Check the map.`, { n: made.length });
        note(s, { kind: 'loot-drop', clock: t.clock, boxes: made.map((b) => ({ id: b.id, p: [b.p[0], b.p[1]], until: b.until, r: LOOT_PICK_M })) }); // (the pro edit; r: the pickup circle, metres)
        addMoment(s, t, 'loot', [], { data: { n: made.length } });
      }
      break;
    }
    default:
      if (cpGame(s)) cpRunDue(s, item, t, ctx);
      break;
  }
}

export function advance(state, { now, positions = {}, rand } = {}) {
  // v1.6: the lobby vote: each question's winner once it has closed, the settings after the last one
  if (state && state.phase === 'lobby' && state.vote && !state.vote.applied && voteOwed(state.vote, now)) {
    const s1 = fillIn(copy(state));
    if (voteDue(s1, now)) { s1.updatedAt = now; return { state: s1, changed: true }; }
  }
  if (!state || state.phase !== 'live' || state.startedAt === null) return { state, changed: false };
  let s = state;
  let owned = false;
  const own = () => {
    if (!owned) { s = fillIn(copy(state)); owned = true; }
    return s;
  };
  if (s.pausedAt !== null && s.pausedAt !== undefined) {
    const by = s.sos ? playerOf(s, s.sos.by) : null;
    if (by && active(by)) return { state, changed: false };
    // The player who sent the SOS has left (or there's no SOS behind the pause): the game goes on.
    own();
    resumeGame(s, { now, clock: clockOf(s, now), at: now }, null);
  }
  const sch = schedule(state.settings);
  const clockNow = clockOf(s, now);
  const ctx = { now, positions: positions || {}, rand: randOf(rand, state, now) };
  if (!s.flags || !Array.isArray(s.log) || cpUnfilled(s)) own();
  for (let guard = 0; guard < 10000 && s.phase === 'live'; guard++) {
    const item = nextDue(s, sch, ctx, clockNow);
    if (!item || item.clock > clockNow) break;
    own();
    runDue(s, item, ctx);
  }
  // v1.2: close calls for the camera (after the pings).
  if (s.phase === 'live' && s.cam) {
    const found = nearPairs(s, ctx, clockOf(s, now));
    if (found.length) {
      own();
      const t = { now, clock: clockOf(s, now), at: now };
      for (const [hunterId, hiderId] of found) addNear(s, t, hunterId, hiderId);
    }
  }
  if (owned) s.updatedAt = now;
  return { state: s, changed: owned };
}

// ---------------------------------------------------------------------------------------------------------
// onPosition: a player's phone sent where they are (the server stores the position itself)

export function onPosition(state, playerId, pos, { now } = {}) {
  const p0 = playerOf(state, playerId);
  if (!p0 || !active(p0) || state.phase !== 'live' || !pos || !isPoint(pos.p)) return { state, changed: false };
  const at = Number.isFinite(pos.at) ? pos.at : now;
  const acc = Number.isFinite(pos.acc) && pos.acc >= 0 ? pos.acc : 0;
  const point = [pos.p[0], pos.p[1]];
  const s = fillIn(copy(state));
  const p = s.players[playerId];
  let changed = false;

  if (!Number.isFinite(p.lastSeen) || now - p.lastSeen >= SEEN_EVERY_MS) {
    p.lastSeen = now;
    changed = true;
  }
  // Their phone sends a location again: a later silence is told to the hunters again.
  if (p.noFixTold) {
    p.noFixTold = false;
    changed = true;
  }

  // Distance walked: only clear moves (bigger than the jitter and the fix's accuracy), never jumps. The
  // driver's moves are distance driven instead (never walking: the MVP is picked by walking).
  const driving = isDriver(s, p) && s.phase === 'live';
  if (acc <= ACC_MAX_M) {
    if (!p.track || !isPoint(p.track.p)) {
      p.track = { p: point, at };
      changed = true;
    } else {
      const d = distanceM(p.track.p, point);
      if (d >= Math.max(STEP_M, acc)) {
        const dt = Math.max(1, (at - p.track.at) / 1000);
        if (driving) {
          if (d / dt <= DRIVE_SPEED_MAX) p.stats.drivenM = Math.round(((p.stats.drivenM || 0) + d) * 10) / 10;
        } else if (d / dt <= SPEED_MAX) {
          p.stats.distanceM = Math.round((p.stats.distanceM + d) * 10) / 10;
        }
        p.track = { p: point, at };
        changed = true;
      }
    }
  }

  // v1.6: Loot drops: a free hider (or a hunter) holding nothing grabs a box once their fix's spot is inside its
  // 5 m circle, from a fix no vaguer than LOOT_ACC_MAX_M (loot.js says why), while the clock runs
  if (lootGame(s) && (isFree(p) || isHunter(p)) && !isDriver(s, p) && !p.loot && s.pausedAt === null && acc <= LOOT_ACC_MAX_M) {
    const clock = clockOf(s, now);
    const sch = schedule(s.settings);
    if (clock >= sch.headStartMs && clock < sch.endMs) {
      const box = lootNear(s, point, clock);
      if (box) {
        box.by = p.id;
        box.takenAt = clock;
        p.loot = { id: box.id, at: clock };
        const t = { now, clock, at: now };
        emit(s, t, 'loot-got', p.id, 'You grabbed a loot box! Open it from your tray.');
        note(s, { kind: 'loot-grab', by: p.id, id: box.id, clock }); // (the pro edit)
        emit(s, t, 'loot-taken', p.team === 'hunter' ? 'hiders' : 'hunters', `${p.name} grabbed a loot box!`, { id: p.id });
        addMoment(s, t, 'loot', [p.id]);
        changed = true;
      }
    }
  }

  // v1.3: checkpoint visits (free hiders, while the clock runs, before time's up).
  let inCheckpoint = false;
  if (isFree(p) && cpGame(s) && s.pausedAt === null) {
    const clock = clockOf(s, now);
    if (clock < schedule(s.settings).endMs) {
      if (cpOnFix(s, p, pos, now, clock)) changed = true;
      const slot = cpActive(s, clock);
      inCheckpoint = !!slot && cpHere(s, p.id, slot, { [p.id]: pos }, now);
    }
  }

  // Out of the ring (hiders, during the hunt, while the clock runs). In Checkpoints, inside the active
  // checkpoint counts as inside the ring (a checkpoint left outside a shrinking ring never catches anyone).
  if (isFree(p) && s.ring && s.pausedAt === null) {
    const clock = clockOf(s, now);
    const sch = schedule(s.settings);
    if (clock >= sch.headStartMs && clock < sch.endMs) {
      const by = inCheckpoint ? 0 : outsideByM(ringAt(s, clock), point);
      const margin = Math.max(OUT_MARGIN_MIN_M, Math.min(OUT_MARGIN_MAX_M, acc));
      const t = { now, clock, at: now };
      if (p.outsideSince === null && by > margin) {
        p.outsideSince = clock;
        p.outsideShown = false;
        emit(s, t, 'outside', p.id,
          `You're outside the ring. Get back in within ${fmtClock(TIMING.OUTSIDE_SHOW_MS)} or the hunters see you.`,
          { ms: TIMING.OUTSIDE_SHOW_MS });
        addMoment(s, t, 'outside', [p.id]);
        changed = true;
      } else if (p.outsideSince !== null && by <= 0) {
        const outFor = clock - p.outsideSince;
        const spare = p.outsideShown ? TIMING.OUTSIDE_CATCH_MS - outFor : TIMING.OUTSIDE_SHOW_MS - outFor;
        if (spare >= 0 && spare < SPARE_MS) {
          note(s, { kind: 'back-in', clock, id: p.id, spare, seen: p.outsideShown });
        }
        p.outsideSince = null;
        p.outsideShown = false;
        emit(s, t, 'inside', p.id, 'Back inside the ring.');
        changed = true;
      }
    }
  }

  if (!changed) return { state, changed: false };
  s.updatedAt = now;
  return { state: s, changed: true };
}

// ---------------------------------------------------------------------------------------------------------
// markSeen: a tagged hider's phone has the question. The page asks with `since` = the newest event it kept,
// so `since` at or past the tag's own event proves the phone got it (an answer lost on the way doesn't
// count). The tag's minute starts then. The server calls this for the phone asking, on every request.

export function markSeen(state, playerId, { now, since } = {}) {
  if (!state || state.phase !== 'live' || !Array.isArray(state.catches) || typeof playerId !== 'string') {
    return { state, changed: false };
  }
  const got = Number(since);
  if (!Number.isFinite(got)) return { state, changed: false };
  const due = (c) => c && c.state === 'pending' && c.hider === playerId && !Number.isFinite(c.seenAt)
    && Number.isFinite(c.askEventId) && got >= c.askEventId;
  if (!state.catches.some(due)) return { state, changed: false };
  const s = fillIn(copy(state));
  const clock = clockOf(s, now);
  for (const c of s.catches) if (due(c)) c.seenAt = clock;
  s.updatedAt = now;
  return { state: s, changed: true };
}

// ---------------------------------------------------------------------------------------------------------
// apply: commands

function cmdSettings(s, actor, cmd) {
  const patch = cmd.settings;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return err('bad_cmd');
  const next = cleanSettings(patch, s.settings);
  if (!Array.isArray(patch.custom)) {
    const custom = new Set(next.custom);
    for (const k of Object.keys(patch)) if (has(DEFAULTS, k) && k !== 'custom' && !EXTRA_ALL.includes(k)) custom.add(k);
    next.custom = [...custom];
  }
  const was = extrasOf(s.settings);
  // The camera switched on or off, or its mode changed: everyone says OK again (they agreed to something else).
  if (next.cam !== was.cam || next.camMode !== was.camMode) {
    for (const p of Object.values(s.players)) p.camOk = false;
  }
  // v1.4: Wiretap switched on or off: everyone says OK again.
  if (!!next.powers.wiretap !== !!was.powers.wiretap) {
    for (const p of Object.values(s.players)) p.tapOk = false;
  }
  s.settings = next;
  // Spectators switched off: everyone watching is let go (their page is told).
  if (!next.spectators) {
    for (const wid of Object.keys(s.watchers || {})) dropWatcher(s, wid, 'off');
  }
  return null;
}

function cmdPreset(s, actor, cmd) {
  const preset = typeof cmd.name === 'string' && has(PRESETS, cmd.name) ? PRESETS[cmd.name] : null;
  if (!preset) return err('bad_cmd');
  const keys = Object.keys(preset.settings);
  const next = cleanSettings(preset.settings, s.settings);
  next.custom = next.custom.filter((k) => !keys.includes(k));
  s.settings = next;
  return null;
}

function cmdRecommend(s) {
  const base = { ...s.settings, custom: s.settings.custom.filter((k) => !TIMING_KEYS.includes(k)) };
  s.settings = withRecommendation(base, s.ring, countIn(s));
  return null;
}

function cmdRing(s, actor, cmd) {
  const problem = ringProblem(cmd.ring);
  if (problem) return err(cmd.ring ? 'bad_cmd' : 'no_ring', problem);
  const ring = cleanRing(cmd.ring);
  const again = ringProblem(ring);
  if (again) return err('bad_cmd', again);
  s.ring = ring;
  s.settings = withRecommendation(s.settings, ring, countIn(s));
  return null;
}

function cmdPick(s, actor, cmd) {
  const target = playerOf(s, cmd.playerId);
  if (!target || target.status !== 'in') return err('gone');
  if (!PICKS.includes(cmd.pick)) return err('bad_cmd');
  target.pick = cmd.pick;
  if (s.driverPick === target.id && cmd.pick !== 'hunter') s.driverPick = null;
  return null;
}

function cmdShuffle(s) {
  for (const p of Object.values(s.players)) p.pick = 'auto';
  s.driverPick = null;
  return null;
}

function cmdDriver(s, actor, cmd) {
  if (cmd.playerId === null || cmd.playerId === undefined) {
    s.driverPick = null;
    return null;
  }
  const target = playerOf(s, cmd.playerId);
  if (!target || target.status !== 'in') return err('bad_target');
  s.driverPick = target.id;
  target.pick = 'hunter';
  return null;
}

function cmdKick(s, actor, cmd, t) {
  const target = playerOf(s, cmd.playerId);
  if (!target || !active(target)) return err('gone');
  if (target.id === actor.id) return err('bad_target', "You can't remove yourself. Leave the game instead.");
  removePlayer(s, target, 'kicked', t);
  return null;
}

function cmdHost(s, actor, cmd, t) {
  const target = playerOf(s, cmd.playerId);
  if (!target || !active(target)) return err('gone');
  if (target.id === actor.id) return err('bad_target', "You're the host already.");
  logHost(s, target.id, t);
  s.hostId = target.id;
  emit(s, t, 'host', 'all', `${target.name} is the host now.`, { id: target.id });
  return null;
}

function shuffled(list, R) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(R() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cmdStart(s, actor, cmd, t) {
  if (!s.ring || ringProblem(s.ring)) return err('no_ring');
  const cpWrong = cpCheckStart(s);
  if (cpWrong) return cpWrong;
  const players = ordered(s).filter((p) => p.status === 'in');
  if (players.length < 2) return err('too_few');
  const want = huntersFor(s.settings, players.length);
  const hunters = players.filter((p) => p.pick === 'hunter');
  const hiders = players.filter((p) => p.pick === 'hider');
  const autos = shuffled(players.filter((p) => p.pick !== 'hunter' && p.pick !== 'hider'), t.rand);
  const need = Math.max(0, want - hunters.length);
  hunters.push(...autos.slice(0, need));
  hiders.push(...autos.slice(need));
  if (!hunters.length) return err('no_hunters');
  if (!hiders.length) return err('no_hiders');
  let driver = null;
  if (s.settings.driver && s.settings.mode !== 'infection') {
    if (hunters.length < 2) return err('no_driver');
    driver = hunters.find((p) => p.id === s.driverPick) || null;
    if (!driver) {
      const list = ordered(s).filter((p) => hunters.includes(p));
      driver = list[Math.min(list.length - 1, Math.floor(t.rand() * list.length))];
    }
  }

  for (const p of Object.values(s.players)) resetForGame(p);
  s.loot = null; s.lootTeam = {}; s.fx = {}; // a new round: no boxes, cards or card effects carried over from the last one
  const hiderPowers = HIDER_POWERS.filter((k) => s.settings.powers[k]);
  for (const p of hunters) { p.team = 'hunter'; p.startTeam = 'hunter'; }
  for (const p of hiders) {
    p.team = 'hider';
    p.startTeam = 'hider';
    p.powers = Object.fromEntries(hiderPowers.map((k) => [k, 'ready']));
  }
  s.phase = 'live';
  s.startedAt = t.now;
  s.pausedAt = null;
  s.pausedMs = 0;
  s.pings = [];
  s.team = freshTeam();
  freshV14(s, true);
  // v1.6.1: Loot drops: nobody starts with a power; every one comes out of a box (the owner, Nov 2026).
  if (lootGame(s)) {
    s.team = { lastPowerAt: null };
    for (const p of hiders) p.powers = {};
  }
  s.radar = null;
  s.exposure = null;
  s.catches = [];
  s.sos = null;
  s.result = null;
  s.summary = null;
  s.flags = { hunt: false, closing: false };
  s.log = [];
  s.endClock = null;
  s.overEventId = null;
  s.hostLog = [];
  s.driver = driver ? { id: driver.id, left: false } : null;
  s.pickups = [];
  s.nextPickupId = 1;
  s.radio = freshRadio();
  s.watchJoins = 0;
  s.cam = s.settings.cam ? {
    mode: s.settings.camMode === 'everything' ? 'everything' : 'highlights',
    ids: ordered(s).filter((p) => p.status === 'in' && p.camOk === true).map((p) => p.id),
    moments: [],
    next: 1,
    near: {},
    have: {},
  } : null;
  // v1.3: this round's checkpoints (shuffled after the teams and the driver were picked).
  s.cp = s.settings.mode === 'checkpoints' ? cpMake(s, t.rand) : null;
  const headStartMs = schedule(s.settings).headStartMs;
  const t0 = { now: t.now, clock: 0, at: t.now };
  const text = `Game on! Hiders have ${fmtClock(headStartMs)} to hide.`;
  emit(s, t0, 'start', 'all', text, { headStartMs });
  note(s, { kind: 'start', clock: 0, text: `Game on: ${hunters.length} ${hunters.length === 1 ? 'hunter' : 'hunters'}, ${hiders.length} ${hiders.length === 1 ? 'hider' : 'hiders'}.` });
  if (driver) {
    driver.driverAt = 0;
    emit(s, t0, 'driver', 'all', `${driver.name} is driving.`, { id: driver.id });
    note(s, { kind: 'driver', clock: 0, id: driver.id, text: `${driver.name} is driving.` });
  }
  if (s.cp) note(s, { kind: 'cp-plan', clock: 0, text: `${s.cp.plan.length} checkpoints tonight.` });
  return null;
}

function inHunt(s, t, what) {
  if (s.pausedAt !== null) return err('paused');
  const sch = schedule(s.settings);
  if (t.clock < sch.headStartMs) return err('cooldown', `${what} once the head start is over.`);
  // Past time's up the game only waits for a tag's answer: nothing new starts.
  if (t.clock >= sch.endMs) return err('cooldown', "Time's up.");
  return null;
}

function cmdPower(s, actor, cmd, t) {
  const power = cmd.power;
  if (typeof power !== 'string' || !has(POWERS, power)) return err('bad_cmd');
  const wait = inHunt(s, t, 'Powers work');
  if (wait) return wait;
  if (!s.settings.powers[power]) return err('bad_cmd', 'That power is off in this game.');
  if (actor.status !== 'in') return err('not_your_turn', "You're out, so no powers.");
  const name = POWERS[power].name;
  if (POWERS[power].team === 'hider') {
    if (actor.team !== 'hider') return err('not_your_turn', 'Only hiders can use that.');
    if (fxOn(s, 'freeze', t.clock)) return err('frozen', `Your powers are frozen for ${fmtClock(fxLeft(s, 'freeze', t.clock))}.`); // v1.6.1
    const was = actor.powers[power];
    if (was === 'on') return err('used', `${name} is on already.`);
    if (was !== 'ready') return err('used', `${name} is used up.`);
    if (HIDER_POWERS.some((k) => actor.powers[k] === 'on')) return err('one_at_a_time');
    if (power === 'sprint') {
      const pos = posOf(t.positions, actor.id);
      if (!pos || ageOf(pos, t.now) > TIMING.OFFLINE_MS) {
        return err('bad_cmd', "Sprint needs your location. Turn location on and try again.");
      }
      actor.sprintFrom = pos.p;
      actor.sprintUntil = t.clock + TIMING.SPRINT_MS;
    }
    actor.powers[power] = 'on';
    actor.stats.powers.push(name);
    const text = `${actor.name} used ${name}.`;
    emit(s, t, 'power', 'hiders', text, { power, by: actor.id });
    // (until: Sprint's end, for the pro edit's glowing stretch where the pings stayed behind)
    note(s, { kind: 'power', power, by: actor.id, clock: t.clock, text, ...(power === 'sprint' ? { until: actor.sprintUntil } : {}) });
    addMoment(s, t, 'power', [actor.id], { data: { power } });
    return null;
  }
  if (actor.team !== 'hunter') return err('not_your_turn', 'Only hunters can use that.');
  if (isDriver(s, actor)) return err('driver', "The driver can't use powers.");
  if (fxOn(s, 'blackout', t.clock)) return err('blackout', `Blackout: nothing works for ${fmtClock(fxLeft(s, 'blackout', t.clock))}.`); // v1.6.1
  if (s.team[power] !== 'ready') return err('used', `${name} is used up.`);
  const last = s.team.lastPowerAt;
  if (last !== null && t.clock - last < TIMING.HUNTER_POWER_GAP_MS) {
    return err('cooldown', `Wait ${fmtClock(TIMING.HUNTER_POWER_GAP_MS - (t.clock - last))} after the last hunter power.`);
  }
  // v1.4: Hacker and Wiretap pick a hider.
  if (POWER_TARGETED.includes(power)) return targetedPower(s, actor, cmd, t, power);
  s.team[power] = 'used';
  s.team.lastPowerAt = t.clock;
  actor.stats.powers.push(name);
  const text = `${actor.name} used ${name}.`;
  emit(s, t, 'power', 'hunters', text, { power, by: actor.id });
  note(s, { kind: 'power', power, by: actor.id, clock: t.clock, text });
  // (The free hiders are in it too: Radar's warning and Exposure are "on them".)
  addMoment(s, t, 'power', [actor.id, ...freeHiders(s).map((h) => h.id)], { data: { power } });
  if (power === 'radar') {
    const liveAt = t.clock + TIMING.RADAR_WARN_MS;
    s.radar = { by: actor.id, at: t.clock, liveAt, until: liveAt + TIMING.RADAR_LIVE_MS, blocked: [], recorded: false };
    const secs = Math.round(TIMING.RADAR_WARN_MS / 1000);
    const liveIn = TIMING.RADAR_WARN_MS;
    emit(s, t, 'radar', 'hunters', `Radar goes live in ${secs} seconds.`, { liveIn });
    const jam = s.settings.powers.jammer ? ' Hide or use your Jammer.' : ' Hide!';
    emit(s, t, 'radar', 'hiders', `Radar in ${secs} seconds!${jam}`, { liveIn });
  } else {
    const spots = {};
    const jammed = [];
    let missed = 0;
    for (const h of freeHiders(s)) {
      if (h.powers.jammer === 'on') { jammed.push(h.id); continue; }
      let spot = null;
      if (h.powers.sprint === 'on' && h.sprintUntil !== null && t.clock < h.sprintUntil && isPoint(h.sprintFrom)) {
        spot = [h.sprintFrom[0], h.sprintFrom[1]];
      } else {
        // Only a current spot: a phone that went quiet keeps its honest "Offline, last seen" mark instead
        // of an old spot passed off as exact and fresh.
        const pos = posOf(t.positions, h.id);
        if (current(pos, t.now)) spot = pos.p;
        else missed++;
      }
      if (spot) spots[h.id] = spot;
    }
    s.exposure = { by: actor.id, at: t.clock, spots };
    note(s, { kind: 'exposure', clock: t.clock, by: actor.id, spots: copy(spots), jammed: jammed.slice() }); // (the pro edit: every Exposure's dots)
    const count = Object.keys(spots).length;
    emit(s, t, 'exposure', 'hunters', 'Exposure: exact spots!', missed ? { count, missed } : { count });
    emit(s, t, 'exposure', 'hiders', 'The hunters used Exposure.');
    for (const id of jammed) emit(s, t, 'exposure', id, 'Your Jammer hid you from Exposure.');
  }
  return null;
}

function cmdTag(s, actor, cmd, t) {
  if (isDriver(s, actor)) return err('driver', "The driver can't tag. Ask another hunter.");
  const wait = inHunt(s, t, 'Tags count');
  if (wait) return wait;
  if (!isHunter(actor)) return err('not_your_turn', 'Only hunters can tag.');
  const target = playerOf(s, cmd.target);
  if (!isFree(target)) return err('bad_target', "That player isn't hiding right now.");
  // v1.3: inside the open checkpoint with safe time left, nobody can tag them. The first refusal a minute for a
  // pair is noted (a close call); the refusal carries the state so the note can be saved.
  const safe = cpProtected(s, target, t.positions, t.now, t.clock);
  if (safe) {
    const key = `${actor.id}|${target.id}`;
    const last = s.cp.refused[key];
    let keep = false;
    if (!Number.isFinite(last) || t.clock - last >= TIMING.CP_TOLD_GAP_MS) {
      s.cp.refused[key] = t.clock;
      note(s, { kind: 'cp-safe', clock: t.clock, hunter: actor.id, hider: target.id, k: safe.k });
      keep = true;
    }
    // Only a hunter who may see the checkpoint and stands near it hears why: otherwise a tag from anywhere
    // would tell where a checkpoint is before its time, or who is in it right now.
    const hp = cpWhere({ p: safe.p, r: safe.r }, posFrom(t.positions, actor.id), t.now);
    const near = cpHuntersSee(s, safe, t.clock) && !!hp && hp.d <= safe.r + TIMING.CP_TAG_NEAR_M;
    const e = near ? err('safe_zone', `${target.name} is in the checkpoint's safe zone.`) : err('bad_target', CP_TAG_NOT_NOW);
    return { ...e, keep };
  }
  if (s.catches.some((c) => c.hider === target.id && c.state === 'pending')) {
    return err('bad_target', `${target.name} already has a tag waiting.`);
  }
  if (s.catches.some((c) => c.hider === target.id && c.hunter === actor.id && c.state === 'denied'
    && Number.isFinite(c.deniedAt) && t.clock - c.deniedAt < RETAG_MS)) {
    return err('cooldown', `${target.name} just said no. Settle it in person first.`);
  }
  // The tag's minute starts once the hider's phone has the question (seenAt, set by markSeen): a phone
  // that's locked or out of signal can't be caught from across the park by a tag it never saw.
  const c = { id: `c${s.nextCatchId++}`, hunter: actor.id, hider: target.id, at: t.clock, how: 'tag', state: 'pending', askEventId: null, seenAt: null };
  s.catches.push(c);
  c.askEventId = emit(s, t, 'tag', target.id, `${actor.name} says they tagged you.`, { catchId: c.id, hunter: actor.id }).id;
  emit(s, t, 'tag', 'hunters', `${actor.name} tagged ${target.name}. Waiting for ${target.name} to confirm.`, { catchId: c.id, hider: target.id });
  addMoment(s, t, 'tag', [actor.id, target.id]);
  return null;
}

function cmdAnswer(s, actor, cmd, t) {
  if (s.pausedAt !== null) return err('paused');
  const c = typeof cmd.catchId === 'string' ? s.catches.find((x) => x.id === cmd.catchId) : null;
  if (!c || c.state !== 'pending') return err('bad_target', 'That tag is already settled.');
  if (actor.id !== c.hider && actor.id !== s.hostId) return err('not_your_turn', 'Only the tagged hider or the host can answer.');
  if (typeof cmd.yes !== 'boolean') return err('bad_cmd');
  const hider = playerOf(s, c.hider);
  if (!isFree(hider)) {
    s.catches = s.catches.filter((x) => x !== c);
    return err('bad_target', 'That tag is already settled.');
  }
  if (cmd.yes) {
    c.state = 'done';
    catchHider(s, hider, c.hunter, 'tag', t, c);
    checkEnd(s, t);
    return null;
  }
  c.state = 'denied';
  c.deniedAt = t.clock;
  const text = actor.id === hider.id
    ? `${hider.name} says no. Settle it in person.`
    : `${actor.name} said no for ${hider.name}. Settle it in person.`;
  emit(s, t, 'denied', 'all', text, { catchId: c.id });
  addMoment(s, t, 'denied', [c.hunter, hider.id]);
  return null;
}

function cmdTagged(s, actor, cmd, t) {
  const wait = inHunt(s, t, 'Catches count');
  if (wait) return wait;
  let hider = actor;
  let how = 'self';
  const target = cmd.target;
  if (target !== undefined && target !== null && target !== actor.id) {
    if (actor.id !== s.hostId) return err('not_host');
    hider = playerOf(s, target);
    how = 'host';
    if (!isFree(hider)) return err('bad_target', "That player isn't hiding right now.");
  } else if (!isFree(hider)) {
    return err('not_your_turn', "You're not hiding right now.");
  } else if (cpProtected(s, hider, t.positions, t.now, t.clock)) {
    return err('safe_zone', "You're in the checkpoint's safe zone, so you can't be caught here.");
  }
  let hunterId = null;
  if (cmd.by !== undefined && cmd.by !== null && cmd.by !== '') {
    const hunter = playerOf(s, cmd.by);
    if (!hunter || hunter.team !== 'hunter' || hunter.status === 'kicked' || hunter.id === hider.id) {
      return err('bad_target', 'Pick the hunter who caught you.');
    }
    if (isDriver(s, hunter)) return err('driver', "The driver can't tag. Pick the hunter who caught you.");
    hunterId = hunter.id;
  }
  const record = { id: `c${s.nextCatchId++}`, hunter: hunterId, hider: hider.id, at: t.clock, how, state: 'done' };
  s.catches.push(record);
  catchHider(s, hider, hunterId, how, t, record);
  checkEnd(s, t);
  return null;
}

function cmdChat(s, actor, cmd, t) {
  const text = cleanChat(cmd.text);
  if (!text) return err('bad_cmd', 'Type a message first.');
  if (letters(text) > LIMITS.chat) return err('bad_cmd', `Keep it to ${LIMITS.chat} letters.`);
  const recent = (actor.chatAt || []).filter((x) => Number.isFinite(x) && t.now - x >= 0 && t.now - x < CHAT_WINDOW_MS);
  if (recent.length >= CHAT_BURST) return err('cooldown', 'Slow down a little.');
  recent.push(t.now);
  actor.chatAt = recent;
  let to = 'all';
  if (s.phase === 'live' && actor.status === 'in') to = actor.team === 'hunter' ? 'hunters' : actor.team === 'hider' ? 'hiders' : 'all';
  emit(s, t, 'chat', to, text, null, actor.id);
  return null;
}

function cmdSos(s, actor, cmd, t) {
  if (s.pausedAt !== null) return err('paused', 'The game is paused already.');
  s.pausedAt = t.now;
  s.sos = { by: actor.id, at: t.now };
  // an SOS ends any Wiretap at once: nobody listens in on an emergency
  for (const tap of s.taps || []) if (tapOpen(tap)) finishTap(s, tap, t, { giveBack: true });
  emit(s, t, 'sos', 'all', `SOS from ${actor.name}. The game is paused.`, { by: actor.id });
  note(s, { kind: 'sos', clock: t.clock, text: `SOS from ${actor.name}.` });
  addMoment(s, t, 'sos', ordered(s).filter((p) => p.status === 'in').map((p) => p.id));
  return null;
}

function cmdResume(s, actor, cmd, t) {
  if (s.pausedAt === null) return err('bad_cmd', "The game isn't paused.");
  if (actor.id !== s.hostId && !(s.sos && s.sos.by === actor.id)) {
    return err('not_host', 'Only the host or the person who sent the SOS can restart the game.');
  }
  resumeGame(s, t, actor.id);
  return null;
}

function cmdLeave(s, actor, cmd, t) {
  removePlayer(s, actor, 'left', t);
  return null;
}

function cmdEnd(s, actor, cmd, t) {
  endGame(s, 'host', t);
  return null;
}

function cmdAgain(s, actor, cmd, t) {
  for (const id of Object.keys(s.players)) if (!active(s.players[id])) delete s.players[id];
  for (const p of Object.values(s.players)) {
    resetForGame(p);
    p.status = 'in';
    p.pick = 'auto';
  }
  s.phase = 'lobby';
  s.startedAt = null;
  s.pausedAt = null;
  s.pausedMs = 0;
  s.pings = [];
  s.team = freshTeam();
  freshV14(s, false);
  // Wiretap consent is for one round: everyone is asked again in the lobby.
  for (const p of Object.values(s.players)) p.tapOk = false;
  s.radar = null;
  s.exposure = null;
  s.catches = [];
  s.sos = null;
  s.events = [];
  s.result = null;
  s.summary = null;
  s.flags = { hunt: false, closing: false };
  s.log = [];
  s.endClock = null;
  s.overEventId = null;
  s.driverPick = null;
  s.driver = null;
  s.pickups = [];
  s.nextPickupId = 1;
  s.radio = freshRadio();
  s.watchJoins = 0;
  s.cam = null;
  s.cp = null;
  emit(s, { now: t.now, clock: 0, at: t.now }, 'again', 'all', 'New round! Back to the lobby.');
  return null;
}

// Pickups: a hunter asks the driver for a ride; the driver says "On my way" and "Picked up".
function cmdPickup(s, actor, cmd, t) {
  const what = cmd.do;
  if (what === 'ask') {
    if (s.pausedAt !== null) return err('paused');
    if (!isHunter(actor) || isDriver(s, actor)) return err('not_your_turn', 'Only hunters can ask the driver for a pickup.');
    const driver = driverOf(s);
    if (!driver) return err('no_driver', 'Nobody is driving.');
    // v1.4: "Pick me up here" carries a point (`p`); without one it's the asker's own spot, as before.
    const pinned = cmd.p !== undefined && cmd.p !== null;
    if (pinned && !pinSpotOk(s, cmd.p, t.clock)) return err('bad_target', "That's too far from the ring.");
    const pos = posOf(t.positions, actor.id);
    if (!pinned && (!pos || ageOf(pos, t.now) > TIMING.OFFLINE_MS)) return err('bad_cmd', 'A pickup needs your location.');
    if (s.pickups.some((k) => k.by === actor.id && (k.state === 'open' || k.state === 'coming'))) {
      return err('used', 'You already asked for a pickup.');
    }
    const spotP = pinned ? [Number(cmd.p[0]), Number(cmd.p[1])] : pos.p;
    const k = { id: `k${s.nextPickupId++}`, by: actor.id, p: spotP, at: t.clock, state: 'open', comingAt: null, doneAt: null, pinned };
    s.pickups.push(k);
    if (s.pickups.length > PICKUPS_KEPT) s.pickups.splice(0, s.pickups.length - PICKUPS_KEPT);
    emit(s, t, 'pickup', 'hunters', `${actor.name} asked ${driver.name} for a pickup.`, { pickupId: k.id, by: actor.id, state: 'open' });
    return null;
  }
  if (what !== 'coming' && what !== 'done' && what !== 'cancel') return err('bad_cmd');
  const k = typeof cmd.pickupId === 'string' ? s.pickups.find((x) => x.id === cmd.pickupId) : null;
  const openNow = !!k && (k.state === 'open' || k.state === 'coming');
  if (what === 'cancel') {
    if (k && k.by !== actor.id) return err('not_your_turn', 'Only the hunter who asked can cancel it.');
    if (!openNow) return err('bad_target', 'That pickup is over.');
    k.state = 'cancelled';
    const driver = driverOf(s);
    if (driver) emit(s, t, 'pickup', driver.id, `${actor.name} doesn't need a pickup any more.`, { pickupId: k.id, by: actor.id, state: 'cancelled' });
    return null;
  }
  if (!isDriver(s, actor) || !driverOf(s)) return err('not_your_turn', 'Only the driver can do that.');
  if (what === 'coming') {
    if (!k || k.state !== 'open') return err('bad_target', 'That pickup is over.');
    k.state = 'coming';
    k.comingAt = t.clock;
    emit(s, t, 'pickup', k.by, `${actor.name} is coming.`, { pickupId: k.id, state: 'coming' });
    return null;
  }
  if (!openNow) return err('bad_target', 'That pickup is over.');
  k.state = 'done';
  k.doneAt = t.clock;
  actor.stats.pickups = (actor.stats.pickups || 0) + 1;
  const asker = playerOf(s, k.by);
  const text = `${actor.name} picked up ${asker ? asker.name : 'someone'}.`;
  emit(s, t, 'pickup', 'hunters', text, { pickupId: k.id, by: k.by, state: 'done' });
  note(s, { kind: 'pickup', clock: t.clock, id: k.by, text });
  return null;
}

function cmdUnwatch(s, actor, cmd) {
  if (typeof cmd.watcherId !== 'string' || !has(s.watchers, cmd.watcherId)) return err('bad_target', "That person isn't watching.");
  dropWatcher(s, cmd.watcherId, 'kicked');
  return null;
}

function cmdCamok(s, actor, cmd) {
  if (typeof cmd.ok !== 'boolean') return err('bad_cmd');
  if (!extrasOf(s.settings).cam) return err('no_cam');
  actor.camOk = cmd.ok;
  return null;
}

function cmdFace(s, actor, cmd) {
  const v = cmd.faceV;
  if (!Number.isInteger(v) || v < 0 || v > 1e9) return err('face');
  actor.faceV = v;
  return null;
}

const ANY = ['lobby', 'live', 'over'];
const COMMANDS = {
  settings: { host: true, phases: ['lobby'], run: cmdSettings },
  preset: { host: true, phases: ['lobby'], run: cmdPreset },
  recommend: { host: true, phases: ['lobby'], run: cmdRecommend },
  ring: { host: true, phases: ['lobby'], run: cmdRing },
  pick: { host: true, phases: ['lobby'], run: cmdPick },
  shuffle: { host: true, phases: ['lobby'], run: cmdShuffle },
  kick: { host: true, phases: ['lobby', 'live'], run: cmdKick },
  host: { host: true, phases: ANY, run: cmdHost },
  start: { host: true, phases: ['lobby'], run: cmdStart },
  power: { phases: ['live'], run: cmdPower },
  tag: { phases: ['live'], run: cmdTag },
  answer: { phases: ['live'], run: cmdAnswer },
  tagged: { phases: ['live'], run: cmdTagged },
  chat: { phases: ANY, run: cmdChat },
  sos: { phases: ['live'], run: cmdSos },
  resume: { phases: ['live'], run: cmdResume },
  leave: { phases: ANY, run: cmdLeave },
  end: { host: true, phases: ['live'], run: cmdEnd },
  again: { host: true, phases: ['over'], run: cmdAgain },
  face: { phases: ANY, run: cmdFace },
  // v1.1
  driver: { host: true, phases: ['lobby'], run: cmdDriver },
  pickup: { phases: ['live'], run: cmdPickup },
  unwatch: { host: true, phases: ANY, run: cmdUnwatch },
  // v1.2
  camok: { phases: ['lobby'], run: cmdCamok },
  // v1.3
  checkpoints: { host: true, phases: ['lobby'], run: cmdCheckpoints },
  cpstrike: { host: true, phases: ['live', 'over'], run: cmdCpStrike },
  // v1.4
  tapok: { phases: ['lobby', 'live'], run: cmdTapok },
  pin: { phases: ['live'], run: cmdPin },
  // v1.6: the lobby vote
  lootopen: { phases: ['live'], run: cmdLootOpen }, // v1.6: Loot drops
  lootuse: { phases: ['live'], run: cmdLootUse }, // v1.6.1: the loot-only powers
  votestart: { host: true, phases: ['lobby'], run: cmdVoteStart },
  vote: { phases: ['lobby'], run: cmdVote },
  votestop: { host: true, phases: ['lobby'], run: cmdVoteStop },
  gear: { phases: ['lobby'], run: cmdGear },
  drive: { phases: ['lobby'], run: cmdDrive },
  voteskip: { host: true, phases: ['lobby'], run: cmdVoteSkip },
};

// v1.6: Loot drops: open the box you hold for a fresh charge of a hider power (a used-up one first).
function cmdLootOpen(s, actor, cmd, t) {
  if (!lootGame(s)) return err('bad_cmd');
  if (!isFree(actor) && !isHunter(actor)) return err('not_free', "You can't open loot right now.");
  if (!actor.loot) return err('no_loot', "You're not holding a loot box. Find one on the map.");
  const side = actor.team === 'hunter' ? 'hunter' : 'hider';
  const on = Object.entries(s.settings.powers || {}).filter(([, v]) => v).map(([k]) => k);
  const got = lootPower(side, t.rand, on.length ? on : null);
  if (side === 'hunter' && fxOn(s, 'blackout', t.clock)) return err('blackout', `Blackout: open it when your screen's back (${fmtClock(fxLeft(s, 'blackout', t.clock))}).`);
  if (LOOT_POWERS[got.power]) { const st = stashOf(s, actor); st[got.power] = (st[got.power] || 0) + 1; } // v1.6.1
  else if (side === 'hunter') s.team[got.power] = 'ready';
  else actor.powers = { ...(actor.powers || {}), [got.power]: 'ready' };
  actor.loot = null;
  actor.lootLast = { power: got.power, rarity: got.rarity, at: t.clock };
  actor.stats.loot = (actor.stats.loot || 0) + 1;
  const name = POWERS[got.power] ? POWERS[got.power].name : LOOT_POWERS[got.power] ? LOOT_POWERS[got.power].name : got.power;
  const word = { mythic: 'MYTHIC', legendary: 'LEGENDARY', rare: 'Rare', common: 'Common' }[got.rarity] || 'Common';
  emit(s, t, 'loot-open', actor.id, `${word} loot: ${name}!`, { power: got.power, rarity: got.rarity });
  note(s, { kind: 'loot-open', by: actor.id, power: got.power, rarity: got.rarity, clock: t.clock, text: `${actor.name} opened ${word} loot: ${name}` }); // (the replay and the pro edit)
  if (side === 'hunter') emit(s, t, 'loot-team', 'hunters', `${actor.name} opened loot: ${name} for the team!`, { power: got.power, rarity: got.rarity, by: actor.id });
  return null;
}

// ---- v1.6.1: the loot-only powers (shared/loot.js LOOT_POWERS). Effects live in s.fx ({ name: { until, by } });
// a hider's Smoke and Ghost in p.lootFx; the stashes in p.lootHeld (a hider's) and s.lootTeam (the hunters').
// Mythics (Blackout, the All-Seeing Eye) never run together: one used while a Mythic runs (or waits) is queued
// (s.fx.queue) and starts by itself when the one before ends. Effects on the hunters never touch the driver.
const MYTHICS = ['blackout', 'eye'];
function fxOf(s) { if (!s.fx || typeof s.fx !== 'object') s.fx = {}; return s.fx; }
function fxOn(s, k, clock) { const f = s.fx && s.fx[k]; return !!f && Number.isFinite(f.until) && clock < f.until; }
function fxLeft(s, k, clock) { return fxOn(s, k, clock) ? s.fx[k].until - clock : 0; }
function stashOf(s, p) {
  if (p.team === 'hunter') { if (!s.lootTeam || typeof s.lootTeam !== 'object') s.lootTeam = {}; return s.lootTeam; }
  if (!p.lootHeld || typeof p.lootHeld !== 'object') p.lootHeld = {};
  return p.lootHeld;
}
function mythicEnds(s, clock) {
  let end = null;
  for (const k of MYTHICS) if (fxOn(s, k, clock)) end = Math.max(end || 0, s.fx[k].until);
  return end;
}

// The ping times with Double Double's changes (s.pingAdd, s.pingDrop).
function pingTimes(s, sch) {
  const add = Array.isArray(s.pingAdd) ? s.pingAdd : [];
  const drop = Array.isArray(s.pingDrop) ? s.pingDrop : [];
  if (!add.length && !drop.length) return sch.pings;
  return [...sch.pings.filter((x) => !drop.includes(x)), ...add.filter((x) => x < sch.endMs)].sort((a, b) => a - b);
}

function lootFxDue(s, offer) {
  const f = s.fx;
  if (!f) return;
  const tr = f.tracker;
  if (tr && Number.isFinite(tr.next) && tr.next < tr.until) offer(tr.next, 2.4, { type: 'trackerTick' });
  if (Array.isArray(f.queue) && f.queue.length) {
    const end = MYTHICS.map((k) => (f[k] && Number.isFinite(f[k].until) ? f[k].until : 0)).reduce((a, b) => Math.max(a, b), 0);
    offer(end, 2.2, { type: 'mythicNext' });
  }
}

function lootTrackerTick(s, t, ctx) {
  const tr = s.fx && s.fx.tracker;
  if (!tr) return;
  const h = playerOf(s, tr.target);
  if (!isFree(h)) { tr.until = t.clock; tr.next = null; return; }
  const pos = posOf(ctx.positions, h.id);
  if (pos && current(pos, ctx.now)) tr.spot = { p: [pos.p[0], pos.p[1]], clock: t.clock };
  tr.next = t.clock + TRACKER_EVERY_MS;
}

function lootMythicNext(s, t, ctx) {
  const f = fxOf(s);
  const next = Array.isArray(f.queue) ? f.queue.shift() : null;
  if (!next) return;
  const by = playerOf(s, next.by) || { id: next.by, name: next.name || 'Someone', team: next.side, stats: freshStats() };
  startLootFx(s, t, next.power, by, null, ctx);
}

function cmdLootUse(s, actor, cmd, t) {
  if (!lootGame(s)) return err('bad_cmd');
  const power = cmd.power;
  const P = typeof power === 'string' && Object.prototype.hasOwnProperty.call(LOOT_POWERS, power) ? LOOT_POWERS[power] : null;
  if (!P) return err('bad_cmd');
  const wait = inHunt(s, t, 'Powers work');
  if (wait) return wait;
  if (P.team === 'hider' ? !isFree(actor) : !isHunter(actor)) return err('not_your_turn', P.team === 'hider' ? 'Only hiders can use that.' : 'Only hunters can use that.');
  if (isDriver(s, actor)) return err('driver', "The driver can't use powers.");
  const stash = stashOf(s, actor);
  if (!(stash[power] > 0)) return err('used', `You don't have ${P.name}.`);
  if (P.team === 'hider' && fxOn(s, 'freeze', t.clock)) return err('frozen', `Your powers are frozen for ${fmtClock(fxLeft(s, 'freeze', t.clock))}.`);
  if (P.team === 'hunter' && fxOn(s, 'blackout', t.clock)) return err('blackout', `Blackout: nothing works for ${fmtClock(fxLeft(s, 'blackout', t.clock))}.`);
  let target = null;
  if (P.target) {
    target = playerOf(s, cmd.target);
    if (!isFree(target)) return err('bad_target', 'Pick a hider who is still hiding.');
  }
  stash[power] -= 1;
  if (!stash[power]) delete stash[power];
  const f = fxOf(s);
  if (P.mythic && (mythicEnds(s, t.clock) !== null || (Array.isArray(f.queue) && f.queue.length))) {
    if (!Array.isArray(f.queue)) f.queue = [];
    f.queue.push({ power, by: actor.id, name: actor.name, side: actor.team });
    const startsAt = mythicEnds(s, t.clock) || t.clock;
    const running = MYTHICS.find((k) => fxOn(s, k, t.clock));
    emit(s, t, 'loot-queued', actor.id, `${P.name} is queued: it starts in ${fmtClock(Math.max(0, startsAt - t.clock))}${running ? `, when ${LOOT_POWERS[running].name} ends` : ''}.`, { power });
    return null;
  }
  startLootFx(s, t, power, actor, target);
  return null;
}

function startLootFx(s, t, power, actor, target) {
  const P = LOOT_POWERS[power];
  const f = fxOf(s);
  const until = P.ms ? t.clock + P.ms : null;
  const text = `${actor.name} used ${P.name}.`;
  if (actor.stats && Array.isArray(actor.stats.powers)) actor.stats.powers.push(P.name);
  note(s, { kind: 'power', power, by: actor.id, clock: t.clock, text, loot: true, ...(until !== null ? { until } : {}), ...(target ? { target: target.id } : {}) }); // (until, target: the pro edit)
  const them = (team) => (team === 'hider' ? freeHiders(s) : ordered(s).filter((p) => isHunter(p) && !isDriver(s, p))).map((p) => p.id);
  switch (power) {
    case 'smoke': case 'ghost': {
      if (!actor.lootFx || typeof actor.lootFx !== 'object') actor.lootFx = {};
      if (power === 'smoke') actor.lootFx.smoke = true;
      else actor.lootFx.ghost = (actor.lootFx.ghost || 0) + GHOST_PINGS;
      emit(s, t, 'lootfx', actor.id, power === 'smoke' ? 'Smoke is ready: your next ping is a big cloud.' : "Ghost: you're invisible on the next 2 pings.", { power, by: actor.id });
      // v1.6.3: the other hiders see the card played (as with Sprint, Decoy and Jammer); the hunters never do, and
      // a spectator only once the game is over (viewFor's 'power' to 'hiders' rule).
      emit(s, t, 'power', 'hiders', text, { power, by: actor.id, loot: true });
      addMoment(s, t, 'power', [actor.id], { data: { power, loot: true } });
      return;
    }
    case 'double': {
      const sch = schedule(s.settings);
      const times = pingTimes(s, sch);
      const next = times[s.pings.length];
      const every = (t.clock >= sch.closingStartMs && sch.closingMs > 0 ? s.settings.closingPingEveryMin : s.settings.pingEveryMin) * 60000;
      const a1 = Math.round(Number.isFinite(next) ? Math.min(next, t.clock + every / 2) : t.clock + every / 2);
      const a2 = Math.round(a1 + every / 2);
      if (!Array.isArray(s.pingAdd)) s.pingAdd = [];
      if (!Array.isArray(s.pingDrop)) s.pingDrop = [];
      if (Number.isFinite(next)) { if (s.pingAdd.includes(next)) s.pingAdd.splice(s.pingAdd.indexOf(next), 1); else s.pingDrop.push(next); }
      for (const a of [a1, a2]) if (a < sch.endMs && !pingTimes(s, sch).includes(a)) s.pingAdd.push(a);
      emit(s, t, 'lootfx', 'hunters', `${actor.name} used Double Double: the next 2 pings come twice as fast!`, { power, by: actor.id });
      emit(s, t, 'lootfx', 'hiders', 'The hunters used Double Double: the next 2 pings come twice as fast!', { power });
      addMoment(s, t, 'power', [actor.id, ...them('hider')], { data: { power, loot: true } });
      return;
    }
    case 'tracker': {
      f.tracker = { target: target.id, by: actor.id, until, next: t.clock, spot: null };
      emit(s, t, 'lootfx', 'hunters', `${actor.name} hit ${target.name} with a Tracker dart: their spot updates every 20 seconds.`, { power, by: actor.id, target: target.id });
      emit(s, t, 'lootfx', target.id, "Tracker dart! The hunters see your spot every 20 seconds for 2 minutes. Move!", { power, target: target.id });
      addMoment(s, t, 'power', [actor.id, target.id], { data: { power, loot: true } });
      return;
    }
    default: {
      f[power] = { until, by: actor.id };
      const W = {
        glitch: ['GLITCH! Your phones will act buggy for a minute.', `${actor.name} glitched the hunters' phones for a minute!`],
        storm: ['Static Storm! Your map is static for 2 minutes.', `${actor.name} hit the hunters with a Static Storm!`],
        blackout: ['BLACKOUT! Your screen is dark for 5 minutes. Your walkie still works.', `${actor.name} blacked out the hunters for 5 minutes!`],
        compass: [`${actor.name} used Compass: follow the arrow for 30 seconds.`, null],
        freeze: [`${actor.name} froze the hiders' powers for 3 minutes.`, "Freeze! The hunters froze your powers for 3 minutes."],
        eye: [`ALL-SEEING EYE! Every hider is live for 2 minutes.`, null],
      }[power] || [null, null];
      if (W[0]) emit(s, t, 'lootfx', 'hunters', W[0], { power, by: actor.id });
      if (W[1]) emit(s, t, 'lootfx', 'hiders', W[1], { power, by: actor.id });
      if (!W[0] && !W[1]) emit(s, t, 'lootfx', actor.id, text, { power, by: actor.id });
      const hit = P.team === 'hider' ? them('hunter') : them('hider');
      addMoment(s, t, 'power', [actor.id, ...hit], { data: { power, loot: true } });
    }
  }
}

// What the loot powers do to this phone's view: { blackout, storm, glitch, eye, freeze (ms left), compass { left,
// bearing }, tracker { id, left }, tracked (ms: a dart on me), queued [power], smoke, ghost } or null.
function lootFxView(s, me, clock, positions, now) {
  if (!me || !lootGame(s) || s.phase !== 'live') return null;
  const out = {};
  const left = (k) => fxLeft(s, k, clock);
  if (isHunter(me) && !isDriver(s, me)) {
    for (const k of ['blackout', 'storm', 'glitch', 'eye', 'freeze']) if (left(k)) out[k] = left(k);
    if (left('compass')) {
      const mine = posOf(positions, me.id);
      let best = null;
      for (const h of freeHiders(s)) {
        const pos = posOf(positions, h.id);
        if (!mine || !pos || !current(pos, now)) continue;
        const d = distanceM(mine.p, pos.p);
        if (!best || d < best.d) best = { d, b: bearingDeg(mine.p, pos.p) };
      }
      out.compass = { left: left('compass'), bearing: best ? Math.round(best.b) : null };
    }
    const tr = s.fx && s.fx.tracker;
    if (tr && clock < tr.until) out.tracker = { id: tr.target, left: tr.until - clock };
  } else if (isFree(me)) {
    for (const k of ['blackout', 'storm', 'glitch', 'freeze']) if (left(k)) out[k] = left(k);
    const tr = s.fx && s.fx.tracker;
    if (tr && tr.target === me.id && clock < tr.until) out.tracked = tr.until - clock;
    const lf = me.lootFx || {};
    if (lf.smoke) out.smoke = true;
    if (lf.ghost > 0) out.ghost = lf.ghost;
  }
  const q = s.fx && Array.isArray(s.fx.queue) ? s.fx.queue.filter((x) => x.by === me.id || (x.side === 'hunter' && isHunter(me))) : [];
  if (q.length) out.queued = q.map((x) => x.power);
  return Object.keys(out).length ? out : null;
}

// ---- v1.6: the lobby vote (shared/vote.js). The host starts it; every phone plays the same intro and asks the
// same questions from the server's clock; picks count while their question is open; the winners go into the
// settings the first time anyone asks after the last question (voteDue, from advance).
function cmdVoteStart(s, actor, cmd, t) {
  const n = Array.isArray(s.checkpoints) ? s.checkpoints.length : 0;
  s.nextVoteId = (Number.isInteger(s.nextVoteId) ? s.nextVoteId : 0) + 1;
  const canDrive = !!s.settings.driver && s.settings.mode !== 'infection' && countIn(s) >= 3;
  const keep = Object.fromEntries(QUESTIONS.map((q) => [q, keepFor(q, s.settings)]).filter(([, k]) => typeof k === 'string'));
  s.vote = newVote({ now: t.now, id: s.nextVoteId, checkpoints: n, skipIntro: cmd.skipIntro === true, driver: canDrive, keep });
  emit(s, { now: t.now, clock: 0, at: t.now }, 'vote', 'all', `${actor.name} started the vote!`);
  return null;
}

function cmdVote(s, actor, cmd, t) {
  const v = s.vote;
  if (!v || v.applied) return err('vote_closed', 'The vote is over.');
  const at = stageAt(v, t.now);
  if (at.stage !== 'question') return err('vote_closed', at.stage === 'intro' ? 'The vote starts in a moment.' : 'The vote is over.');
  const question = v.questions[at.i];
  if (cmd.q !== question.q || typeof cmd.pick !== 'string' || !question.options.includes(cmd.pick)) {
    return err('vote_closed', "That question's closed: the next one's up.");
  }
  v.ballots[question.q][actor.id] = cmd.pick;
  return null;
}

function cmdVoteStop(s) {
  s.vote = null;
  return null;
}

// The group gear check: what this phone found (location, microphone, camera), shown as everyone's ticks.
function cmdGear(s, actor, cmd) {
  const v = s.vote;
  if (!v || v.applied) return err('vote_closed', 'The vote is over.');
  if (!v.gear || typeof v.gear !== 'object') v.gear = {};
  v.gear[actor.id] = cleanGear(cmd);
  return null;
}

// The host skips Static's rules for everyone: the intro ends now (everyone's phone jumps to the gear check); or
// (v1.6.4) the winner's explainer ends now (everyone's phone jumps to the driver or the recap).
function cmdVoteSkip(s, actor, cmd, t) {
  const v = s.vote;
  if (!v || v.applied) return err('vote_closed', 'The vote is over.');
  const at = stageAt(v, t.now);
  if (at.stage === 'intro') v.introMs = Math.max(0, t.now - v.at);
  else if (at.stage === 'explain') {
    if (!v.cut || typeof v.cut !== 'object') v.cut = {};
    v.cut[at.i] = Math.max(0, Math.round(at.ms));
  }
  return null;
}

// Who wants to drive: yes or no while the driver question is up.
function cmdDrive(s, actor, cmd, t) {
  const v = s.vote;
  if (!v || v.applied || !v.driverMs) return err('vote_closed', 'The vote is over.');
  if (stageAt(v, t.now).stage !== 'driver') return err('vote_closed', "That question's closed.");
  if (!v.drive || typeof v.drive !== 'object') v.drive = {};
  v.drive[actor.id] = cmd.yes === true;
  return null;
}

// Is there a winner or the settings still to write?
function voteOwed(v, now) {
  const at = stageAt(v, now);
  if (at.stage === 'results' || at.stage === 'done') return true;
  if (at.stage === 'spin' && v.driverPicked === undefined) return true;
  const result = v.result || {};
  return v.questions.some((q, i) => !result[q.q] && closed(v, i, now));
}

// Each closed question's winner (decided from the picks alone: every phone works out the same), and the settings
// once the last one has closed. -> true when it changed the state.
function voteDue(s, now) {
  const v = s.vote;
  if (!v || v.applied) return false;
  if (!v.result || typeof v.result !== 'object') v.result = {};
  let changed = false;
  v.questions.forEach((question, i) => {
    if (v.result[question.q] || !closed(v, i, now)) return;
    // (the picks and what was kept when the show began, as every phone has it; a vote from before v1.6.4: the settings now)
    v.result[question.q] = v.keep ? winnerAt(v, i) : winner(question, v.ballots[question.q], v.id, keepFor(question.q, s.settings));
    changed = true;
  });
  const at = stageAt(v, now);
  // The driver: the wheel lands on one of the volunteers (none: the host's pick stands).
  if (v.driverMs && v.driverPicked === undefined && ['spin', 'results', 'done'].includes(at.stage)) {
    const ids = Object.values(s.players).filter((p) => p.status === 'in').map((p) => p.id);
    const pick = voteDriverOf(v, ids);
    v.driverPicked = pick;
    if (pick) { s.driverPick = pick; s.players[pick].pick = 'hunter'; }
    changed = true;
  }
  if (at.stage !== 'results' && at.stage !== 'done') return changed;
  let next = s.settings;
  for (const q of QUESTIONS) {
    const key = v.result[q];
    if (!key) continue;
    const patch = settingsFor(q, key, { presets: PRESETS, powers: [...HIDER_POWERS, ...HUNTER_POWERS] });
    if (!Object.keys(patch).length) continue;
    const merged = cleanSettings(patch, next);
    if (Array.isArray(merged.custom)) merged.custom = merged.custom.filter((k) => !Object.keys(patch).includes(k));
    next = merged;
  }
  s.settings = next;
  v.applied = true;
  return true;
}

function phaseError(phases) {
  if (phases.includes('live')) return 'not_live';
  if (phases.includes('lobby')) return 'not_lobby';
  return 'not_over';
}

export function apply(state, actorId, cmd, { now, positions = {}, rand } = {}) {
  if (!state || !state.players) return err('bad_cmd');
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.type !== 'string' || !has(COMMANDS, cmd.type)) {
    return err('bad_cmd');
  }
  const actor0 = playerOf(state, actorId);
  if (!actor0 || !active(actor0)) return err('gone', "You're not in this game any more.");
  const command = COMMANDS[cmd.type];
  if (command.host && state.hostId !== actorId) return err('not_host');
  if (!command.phases.includes(state.phase)) return err(phaseError(command.phases));
  const s = fillIn(copy(state));
  const actor = s.players[actorId];
  const t = { now, clock: clockOf(s, now), at: now, positions: positions || {}, rand: randOf(rand, state, now) };
  const out = command.run(s, actor, cmd, t);
  if (out && out.error) {
    // (A refusal that still changed something worth keeping, like a safe-zone note, carries the state.)
    if (out.keep) {
      s.updatedAt = now;
      return { error: out.error, state: s };
    }
    return { error: out.error };
  }
  if (playerOf(s, actorId)) s.players[actorId].lastSeen = now;
  s.updatedAt = now;
  return { state: s };
}

// ---------------------------------------------------------------------------------------------------------
// v1.1: motion and parking (the driver), spectators, the walkie-talkie

// A stored fix with its speed (`v`, m/s or null), since when it has been slow (`slowSince`, epoch or null)
// and where it stopped (`slowAt`, while slow). The handler calls this for every fix it stores; only the
// driver's are read (isParked). Times are the server's (`got`, when it stored the fix), never the phone's own
// clock, which a page could set. The phone's speed is believed only while how far it really moved agrees:
// a slow run lasts only while every fix stays within PARK_SPOT_M of where it began and comes within
// MOTION_GAP_MS of the one before, so jitter of a still phone keeps it, and a made-up "speed 0" while
// moving (or after a gap) never does.
function fixTime(f) {
  if (!f) return null;
  if (Number.isFinite(f.got)) return f.got;
  return Number.isFinite(f.at) ? f.at : null;
}

export function withMotion(prev, rec) {
  const out = { ...(rec || {}) };
  delete out.slowAt;
  const time = fixTime(out);
  const before = fixTime(prev);
  const dt = time !== null && before !== null ? time - before : null;
  const near = dt !== null && dt > 0 && dt <= MOTION_GAP_MS && isPoint(prev.p) && isPoint(out.p);
  const moved = near ? distanceM(prev.p, out.p) : null;
  const worked = near ? moved / (dt / 1000) : null;
  const said = Number.isFinite(out.speed) && out.speed >= 0 ? out.speed : null;
  // A real move (past the jitter) faster than parking speed, or a jump: what the phone says doesn't count.
  const belie = near && moved > PARK_SPOT_M && (worked * 3.6 >= TIMING.PARK_KMH || worked > DRIVE_SPEED_MAX);
  const v = said !== null && !belie ? said : worked;
  out.v = v;
  let slow;
  if (said !== null && !belie) slow = said * 3.6 < TIMING.PARK_KMH;
  else slow = near && (moved <= PARK_SPOT_M || worked * 3.6 < TIMING.PARK_KMH);
  const anchor = prev && isPoint(prev.slowAt) ? prev.slowAt : null;
  if (slow && near && Number.isFinite(prev.slowSince) && anchor && distanceM(anchor, out.p) <= PARK_SPOT_M) {
    out.slowSince = prev.slowSince;
    out.slowAt = [anchor[0], anchor[1]];
  } else if (slow && time !== null && isPoint(out.p)) {
    out.slowSince = time;
    out.slowAt = [out.p[0], out.p[1]];
  } else {
    out.slowSince = null;
  }
  return out;
}

// The driver's stored fix (with v/slowSince as the handler stored them), or null.
function driverFix(positions, id) {
  if (!positions || typeof positions !== 'object' || !has(positions, id)) return null;
  const pos = positions[id];
  return pos && isPoint(pos.p) ? pos : null;
}

// Parked: the driver's latest fix is fresh and has been slow for PARK_MS. Anything else is "moving" (the
// safe side: no map while driving). Decided from stored fixes only, never from what a page says.
export function isParked(state, positions, now) {
  if (!state || state.phase !== 'live') return false;
  const d = driverOf(state);
  if (!d) return false;
  const pos = driverFix(positions, d.id);
  if (!pos || !Number.isFinite(pos.at) || now - pos.at > TIMING.PARK_FRESH_MS) return false;
  const time = fixTime(pos);
  if (!Number.isFinite(pos.slowSince) || time === null || now - time > TIMING.PARK_FRESH_MS) return false;
  return time - pos.slowSince >= TIMING.PARK_MS;
}

function watchersOf(s) {
  return s && s.watchers && typeof s.watchers === 'object' ? s.watchers : {};
}

function watchingCount(s, now) {
  return Object.values(watchersOf(s)).filter((w) => w && Number.isFinite(w.lastSeen) && now - w.lastSeen < TIMING.WATCH_IDLE_MS).length;
}

function dropWatcher(s, wid, status) {
  const w = s.watchers[wid];
  if (!w) return;
  delete s.watchers[wid];
  // (Someone who left, or was let go for idling, no longer counts towards the round's watch joins: one person
  // joining over and over mustn't lock everyone out of watching for the rest of the round. People the host
  // removed still count; the handler also limits watch joins per game and per address.)
  if (status === 'left' && Number.isFinite(s.watchJoins) && s.watchJoins > 0) s.watchJoins -= 1;
  s.removedWatchers = (s.removedWatchers || []).filter((x) => x.id !== wid);
  s.removedWatchers.push({ id: wid, status, hash: w.secretHash || '' });
  if (s.removedWatchers.length > REMOVED_WATCHERS_KEPT) s.removedWatchers.splice(0, s.removedWatchers.length - REMOVED_WATCHERS_KEPT);
}

export function addWatcher(state, { id, name, secretHash, now } = {}) {
  if (!state || !state.players) return err('bad_cmd');
  if (!extrasOf(state.settings).spectators) return err('no_watch');
  if (!validId(id) || playerOf(state, id) || has(watchersOf(state), id) || typeof secretHash !== 'string') return err('bad_cmd');
  const clean = cleanName(name);
  if (!clean) return err('name');
  const s = fillIn(copy(state));
  if (s.watchJoins >= WATCH_JOINS_MOST) return err('full', 'Too many people joined to watch this game. Try again next round.');
  if (Object.keys(s.watchers).length >= LIMITS.watchers) {
    for (const w of Object.values(s.watchers)) {
      if (!Number.isFinite(w.lastSeen) || now - w.lastSeen >= TIMING.WATCH_IDLE_MS) dropWatcher(s, w.id, 'left');
    }
    if (Object.keys(s.watchers).length >= LIMITS.watchers) return err('watch_full');
  }
  const finalName = uniqueName(clean, Object.values(s.watchers).map((w) => w.name));
  s.watchers[id] = { id, name: finalName, secretHash, joinedAt: now, lastSeen: now };
  s.removedWatchers = s.removedWatchers.filter((x) => x.id !== id);
  s.watchJoins += 1;
  s.updatedAt = now;
  return { state: s };
}

export function touchWatcher(state, wid, { now } = {}) {
  const w = state && has(watchersOf(state), wid) ? state.watchers[wid] : null;
  if (!w || (Number.isFinite(w.lastSeen) && now - w.lastSeen < TIMING.WATCH_SEEN_EVERY_MS)) return { state, changed: false };
  const s = fillIn(copy(state));
  s.watchers[wid].lastSeen = now;
  return { state: s, changed: true };
}

export function removeWatcher(state, wid, { now, status = 'left' } = {}) {
  if (!state || !has(watchersOf(state), wid)) return { state };
  const s = fillIn(copy(state));
  dropWatcher(s, wid, status);
  if (Number.isFinite(now)) s.updatedAt = now;
  return { state: s };
}

// The delayed clock a spectator sees: never newer than now minus SPECTATOR_DELAY_MS of game time.
function watchClock(s, now) {
  return Math.max(0, clockOf(s, now) - TIMING.SPECTATOR_DELAY_MS);
}

// The route-point clocks watchView needs (null when it needs none: the lobby and game over).
export function watchWindow(state, now) {
  if (!state || state.phase !== 'live' || state.startedAt === null || state.startedAt === undefined) return null;
  const T = watchClock(state, now);
  return { from: Math.max(0, T - TIMING.SPECTATOR_SPOT_MS), to: T };
}

// A player's side and status as they were at game clock T (for spectators).
function teamAt(p, T) {
  if (p.startTeam === 'hunter') return 'hunter';
  if (Number.isFinite(p.turnedAt) && T >= p.turnedAt) return 'hunter';
  return p.startTeam || p.team;
}

function statusAt(p, T) {
  if ((p.status === 'left' || p.status === 'kicked') && Number.isFinite(p.leftAt) && T >= p.leftAt) return p.status;
  if (Number.isFinite(p.caughtAt) && T >= p.caughtAt && !Number.isFinite(p.turnedAt)) return 'caught';
  return 'in';
}

function sideOf(to) {
  return to === 'hunters' || to === 'hiders' ? to : 'all';
}

export function watchView(state, wid, { now, positions = {}, trails = [], since = 0 } = {}) {
  const s = state;
  const w = has(watchersOf(s), wid) ? s.watchers[wid] : null;
  const live = s.phase === 'live';
  const over = s.phase === 'over';
  const lobby = !live && !over;
  const T = live ? watchClock(s, now) : clockOf(s, now);
  const sch = schedule(s.settings);
  // An SOS pause stops the game clock at a clock newer than T (T is always 2 minutes behind it), so as of T
  // the game was never paused: a spectator sees the SOS only as its event, once that is 2 minutes old.
  const paused = false;
  const hostThen = live ? hostAt(s, T) : s.hostId;
  const sinceId = Number.isFinite(Number(since)) ? Number(since) : 0;
  const driverId = driverIdOf(s);

  const players = ordered(s)
    .filter((p) => (lobby ? p.status === 'in' : !!p.startTeam))
    .map((p) => {
      const row = live
        ? { id: p.id, name: p.name, host: hostThen === p.id, team: teamAt(p, T), status: statusAt(p, T), faceV: p.faceV, online: true }
        : { id: p.id, name: p.name, host: hostThen === p.id, team: p.team, status: p.status, faceV: p.faceV, online: true };
      if (live && p.caughtBy && Number.isFinite(p.caughtAt) && p.caughtAt <= T) row.caughtBy = p.caughtBy;
      if (over && p.caughtBy) row.caughtBy = p.caughtBy;
      if (driverId === p.id) row.driver = true;
      return row;
    });

  const timing = { headStartLeft: null, left: null, nextPingIn: null, pingN: null, closingIn: null, shrinking: false, closing: false };
  const pingsSoFar = live ? s.pings.filter((x) => x.clock <= T) : s.pings;
  if (live) {
    timing.headStartLeft = T < sch.headStartMs ? sch.headStartMs - T : null;
    timing.left = Math.max(0, sch.endMs - T);
    const k = pingsSoFar.length;
    const times = pingTimes(s, sch);
    if (k < times.length) {
      timing.nextPingIn = Math.max(0, times[k] - T);
      timing.pingN = k + 1;
    }
    if (sch.closingMs > 0) {
      timing.closing = T >= sch.closingStartMs;
      timing.closingIn = timing.closing ? null : sch.closingStartMs - T;
      timing.shrinking = timing.closing && !!s.settings.shrink;
    }
  }

  let marks = [];
  if (over) {
    marks = marksFor(s, { id: '', status: 'over' }, { clock: T, now, positions, sch });
  } else if (live) {
    const newest = {};
    for (const tp of Array.isArray(trails) ? trails : []) {
      if (!tp || typeof tp !== 'object' || !isPoint(tp.p) || !Number.isFinite(tp.clock)) continue;
      if (tp.clock > T || tp.clock < T - TIMING.SPECTATOR_SPOT_MS) continue;
      if (typeof tp.pid !== 'string' || !playerOf(s, tp.pid)) continue;
      if (!newest[tp.pid] || tp.clock > newest[tp.pid].clock) newest[tp.pid] = tp;
    }
    // (Only the hunters' dots: a free hider is seen only as the hunters saw them, their ping circles. A player
    // can watch their own game on a second phone, and a hider's exact spot, even 2 minutes old, would beat
    // every ping, Jammer, Sprint and Decoy. Everyone's route shows in the replay at the end.)
    for (const p of ordered(s)) {
      if (!p.startTeam || statusAt(p, T) !== 'in') continue;
      const tp = newest[p.id];
      if (!tp) continue;
      const team = teamAt(p, T);
      if (team !== 'hunter') continue;
      const m = { id: p.id, kind: team, team, p: [tp.p[0], tp.p[1]], r: 0, age: T - tp.clock, label: p.name };
      if (driverId === p.id) m.driver = true;
      marks.push(m);
    }
    for (const p of ordered(s)) {
      if (!p.startTeam || teamAt(p, T) !== 'hider' || statusAt(p, T) !== 'in') continue;
      for (let i = pingsSoFar.length - 1; i >= 0; i--) {
        const spot = pingsSoFar[i].spots && pingsSoFar[i].spots[p.id];
        if (spot && isPoint(spot.p)) {
          marks.push({ id: p.id, kind: 'ping', p: [spot.p[0], spot.p[1]], r: spot.r, age: Math.max(0, T - pingsSoFar[i].clock), label: p.name });
          break;
        }
      }
    }
  }

  // Events in id order, released only once T has passed them (strictly in order, none skipped); never chat,
  // never one player's own news.
  const events = [];
  let lastEventId = sinceId;
  for (const e of s.events) {
    if (e.id <= sinceId) continue;
    if (live && e.clock > T) break;
    lastEventId = e.id;
    if (e.kind === 'chat' || e.kind === 'pin' || !SIDE_WORDS.has(e.to)) continue;
    // (A hider's own power news stays hidden until the game is over: a hunter watching would learn of a Decoy.
    // So do the hiders' checkpoint news: a hunter's second phone learns nothing early.)
    if (live && (e.kind === 'power' || e.kind === 'checkpoint') && e.to === 'hiders') continue;
    const out = { id: e.id, at: e.at, clock: e.clock, kind: e.kind, to: e.to, side: sideOf(e.to), text: e.text };
    if (e.from) out.from = e.from;
    if (e.data) out.data = copy(e.data);
    events.push(out);
  }

  const sos = null;

  return {
    v: s.v,
    engine: ENGINE_V,
    code: s.code,
    phase: s.phase,
    sub: live ? (T < sch.headStartMs ? 'headstart' : 'hunt') : null,
    now,
    clock: T,
    paused,
    watcher: w ? { id: w.id, name: w.name } : { id: String(wid || ''), name: '' },
    watch: { delayMs: TIMING.SPECTATOR_DELAY_MS },
    watching: watchingCount(s, now),
    me: null,
    players,
    settings: copy(extrasOf(s.settings)),
    ring: s.ring ? copy(s.ring) : null,
    ringNow: s.ring && !lobby ? copy(ringAt(s, T)) : null,
    timing,
    marks,
    team: null,
    radar: null,
    pending: [],
    noSignal: [],
    sos,
    events,
    lastEventId,
    result: over && s.result ? copy(s.result) : null,
    summary: over && s.summary && !(Number.isFinite(s.overEventId) && sinceId >= s.overEventId) ? copy(s.summary) : null,
    overId: over && Number.isFinite(s.overEventId) ? s.overEventId : null,
    radio: null,
    drive: null,
    watchers: [],
    driverPick: null,
    cam: !lobby && s.cam && Array.isArray(s.cam.ids) ? { on: true, mode: s.cam.mode, filmed: s.cam.ids.slice() } : null,
    cp: cpWatchFor(s, T),
  };
}

function radioOf(s) {
  return s && s.radio && typeof s.radio === 'object' && Array.isArray(s.radio.clips) ? s.radio : freshRadio();
}

// Which side a clip was sent on (clips from before v1.2 are the hunters').
function sideOfClip(clip) {
  return clip && (clip.side === 'hiders' || clip.side === 'wiretap') ? clip.side : 'hunters';
}

// May this player hear this clip live? Each team only hears its own. The hunters' clips: a hunter who is in; a
// hider who turned only from when they turned. The hiders' clips: a hider who is free right now (one who turned
// hears no hider clips any more, old ones included).
function hearsLive(p, clip, s) {
  if (sideOfClip(clip) === 'hiders') return isFree(p);
  // (v1.4: Wiretap pieces are heard like the hunters' own clips, but never by the driver: a hider's microphone
  // can give away where they are, and the driver never learns that.)
  if (!isHunter(p)) return false;
  if (sideOfClip(clip) === 'wiretap' && s && isDriver(s, p)) return false;
  if (p.startTeam === 'hunter') return true;
  return Number.isFinite(p.turnedAt) && clip.clock >= p.turnedAt;
}

// May this player send a clip? Hunters who are in; free hiders too with radioHiders.
function maySend(s, p) {
  return isHunter(p) || (isFree(p) && !!extrasOf(s.settings).radioHiders);
}

function typeBase(type) {
  return typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
}

// The channel a player sends on right now.
function channelOf(p) {
  return isHunter(p) ? 'hunters' : 'hiders';
}

// Why a clip can't be taken from this player now (null = it can). `side` is the channel the page recorded on
// ('hunters' | 'hiders'; older pages send none): a clip recorded on one channel never goes out on the other.
// Even without it, a clip whose talking started before the sender turned (a hider caught and turned while
// the upload was on its way) is refused: it was said to the hiders, never meant for the hunters.
export function clipProblem(state, playerId, { ms, type, bytes, now, side } = {}) {
  if (!state || state.phase !== 'live') return err('not_live').error;
  const p = playerOf(state, playerId);
  if (!p || !active(p)) return err('gone').error;
  if (!maySend(state, p)) {
    return err('not_your_turn', extrasOf(state.settings).radioHiders
      ? "You can't use the walkie-talkie right now." : 'Only hunters have the walkie-talkie.').error;
  }
  if (!RADIO_TYPES.includes(typeBase(type))) return err('bad_audio').error;
  if (!Number.isInteger(ms) || ms < RADIO_MS_MIN || ms > RADIO_MS_MAX) return err('bad_audio').error;
  if (side !== undefined && side !== null && side !== channelOf(p)) return err('side_changed').error;
  if (isHunter(p) && p.startTeam !== 'hunter' && Number.isFinite(p.turnedAt)
    && clockOf(state, now) - ms < p.turnedAt) return err('side_changed').error;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > LIMITS.radioBytes) return err('bad_audio').error;
  const r = radioOf(state);
  const walkieClips = r.clips.filter((c) => c.side !== 'wiretap').length;
  const last = r.lastAt && Number.isFinite(r.lastAt[p.id]) ? r.lastAt[p.id] : null;
  if (last !== null && now - last >= 0 && now - last < TIMING.RADIO_GAP_MS) return err('cooldown', 'Wait a moment before the next one.').error;
  if (walkieClips >= LIMITS.radioClips || (r.bytes || 0) + bytes > LIMITS.radioGameBytes) return err('radio_full').error;
  return null;
}

export function addClip(state, playerId, { id, ms, type, bytes, now, side } = {}) {
  const problem = clipProblem(state, playerId, { ms, type, bytes, now, side });
  if (problem) return { error: problem };
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return err('bad_cmd');
  if (radioOf(state).clips.some((c) => c.id === id)) return err('bad_cmd');
  const s = fillIn(copy(state));
  // (clock: when the talking started, not when the clip arrived: the button is let go, then it's sent.)
  const sender = s.players[playerId];
  const clip = { n: s.radio.next++, id, from: playerId, clock: Math.max(0, clockOf(s, now) - ms), ms, type: typeBase(type),
    side: channelOf(sender) };
  s.radio.clips.push(clip);
  // v1.2: a moment for the sender and every filmed player who hears it live.
  addMoment(s, { now, clock: clip.clock, at: now }, 'radio',
    [playerId, ...ordered(s).filter((p) => p.id !== playerId && hearsLive(p, clip, s)).map((p) => p.id)], { ms });
  s.radio.bytes += bytes;
  s.radio.lastAt[playerId] = now;
  s.players[playerId].lastSeen = now;
  s.updatedAt = now;
  return { state: s, clip: { ...clip } };
}

// May `who` ({ player: id } or { watcher: id }) fetch clip n's audio?
export function canFetchClip(state, who, n) {
  if (!state || !who || typeof who !== 'object') return false;
  const clip = radioOf(state).clips.find((c) => c.n === n);
  if (!clip) return false;
  if (state.phase === 'live') {
    if (typeof who.player !== 'string') return false;
    return hearsLive(playerOf(state, who.player), clip, state);
  }
  if (state.phase === 'over') {
    if (!extrasOf(state.settings).radioSave) return false;
    if (typeof who.player === 'string') {
      const p = playerOf(state, who.player);
      return !!p && p.status !== 'kicked';
    }
    if (typeof who.watcher === 'string') return has(watchersOf(state), who.watcher);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// viewFor: the only thing a page ever gets about the game

// Which events a player may see: to all; to them; to their side while they're in it (a hider who joined
// the hunters sees hunter news from then on and no hider news at all; players sitting out see neither).
// v1.4: news a live driver never gets, whoever it was sent to: it tells where hiders are or were.
// (Checkpoint news about the checkpoints themselves, opening, closing, coming soon, is the car's too.)
const DRIVER_HIDDEN = new Set(['ping', 'exposure', 'radar', 'radar-live', 'radar-over', 'outside', 'nosignal']);
const DRIVER_CP_OK = new Set(['show', 'open', 'close', 'soon']);
function driverHidden(e) {
  if (e.kind === 'pin') return !!(e.data && e.data.kind === 'seen'); // "Hider seen" pins are a hider's spot
  if (e.kind === 'checkpoint') return !(e.data && DRIVER_CP_OK.has(e.data.what));
  return DRIVER_HIDDEN.has(e.kind);
}

function canSee(e, me, s) {
  if (me && e.to !== me.id && s && s.phase === 'live' && isDriver(s, me) && driverHidden(e)) return false;
  if (e.to === 'all') return true;
  if (!me) return false;
  if (e.to === me.id) return true;
  if (me.status !== 'in') return false;
  if (e.to === 'hiders') return me.team === 'hider';
  if (e.to === 'hunters') {
    if (me.team !== 'hunter') return false;
    if (me.startTeam === 'hunter') return true;
    return Number.isFinite(me.turnedEvent) && e.id >= me.turnedEvent;
  }
  return false;
}

function newestPingSpot(s, id) {
  for (let i = s.pings.length - 1; i >= 0; i--) {
    const spot = s.pings[i].spots && s.pings[i].spots[id];
    if (spot && isPoint(spot.p)) return { ping: s.pings[i], spot };
  }
  return null;
}

// The spot any reveal of this hider shows: where their Sprint started while it's on, else where they are.
function revealSpot(p, pos, clock) {
  if (p.powers.sprint === 'on' && p.sprintUntil !== null && clock < p.sprintUntil && isPoint(p.sprintFrom)) {
    return [p.sprintFrom[0], p.sprintFrom[1]];
  }
  return pos ? pos.p : null;
}

function online(s, p, positions, now) {
  if (!active(p)) return false;
  if (s.phase === 'lobby') return true; // nobody sends their location in the lobby
  const pos = posOf(positions, p.id);
  const last = Math.max(Number.isFinite(p.lastSeen) ? p.lastSeen : 0, pos && pos.at !== null ? pos.at : 0);
  return now - last < TIMING.OFFLINE_MS;
}

function hiderMark(s, h, { clock, now, positions, sch, radarLive, blocked, exposureOn }) {
  const pos = posOf(positions, h.id);
  const base = { id: h.id, label: h.name };
  const paused = s.pausedAt !== null && s.pausedAt !== undefined;
  if (clock < sch.headStartMs) return null; // nothing about hiders during the head start
  // Radar shows a current spot as live; a phone gone quiet keeps its honest "offline" mark below.
  if (radarLive && !paused && !blocked.includes(h.id) && (!pos || current(pos, now))) {
    const spot = revealSpot(h, pos, clock);
    if (spot) return { ...base, kind: 'radar', p: spot, r: 0, age: pos ? ageOf(pos, now) : 0 };
  }
  if (exposureOn && s.exposure.spots && isPoint(s.exposure.spots[h.id])) {
    const p = s.exposure.spots[h.id];
    return { ...base, kind: 'exposure', p: [p[0], p[1]], r: 0, age: Math.max(0, clock - s.exposure.at) };
  }
  // (v1.4: the parked driver's 'near' marks are gone: the driver never sees a hider.)
  // v1.3: safe time ran out at a checkpoint, or back at one already done: live, the real spot (never Sprint's).
  if (!paused && pos && current(pos, now) && cpExposed(s, h, clock)) {
    return { ...base, kind: 'overstay', p: pos.p, r: 0, age: ageOf(pos, now) };
  }
  if (!paused && pos && h.outsideSince !== null && clock - h.outsideSince >= TIMING.OUTSIDE_SHOW_MS) {
    return { ...base, kind: 'outside', p: pos.p, r: 0, age: ageOf(pos, now) };
  }
  // Offline: quiet for OFFLINE_SHOW_MS of game time (never during an SOS pause, and the pause doesn't count
  // afterwards either). The age shown stays the real one.
  if (!paused && pos && quietFor(s, pos, clock, now) >= TIMING.OFFLINE_SHOW_MS) {
    const spot = revealSpot(h, pos, clock);
    return { ...base, kind: 'offline', p: spot, r: 0, age: ageOf(pos, now) };
  }
  const seen = newestPingSpot(s, h.id);
  if (seen) {
    return { ...base, kind: 'ping', p: [seen.spot.p[0], seen.spot.p[1]], r: seen.spot.r, age: Math.max(0, clock - seen.ping.clock), ...(seen.spot.smoke ? { smoke: true } : {}) };
  }
  return null;
}

// Before Radar goes live: the hiders it won't see (Jammer on now, or used up by a ping during the warning).
function radarSafe(s, r) {
  const early = Array.isArray(r.blocked) ? r.blocked : [];
  return freeHiders(s).filter((h) => h.powers.jammer === 'on' || early.includes(h.id)).map((h) => h.id);
}

function marksFor(s, me, { clock, now, positions, sch }) {
  const marks = [];
  if (!me) return marks;
  const driverId = driverIdOf(s);
  if (s.phase === 'over') {
    for (const p of ordered(s)) {
      if (!active(p) || !p.team) continue;
      const pos = posOf(positions, p.id);
      if (!pos) continue;
      const m = { id: p.id, kind: p.team, team: p.team, p: pos.p, r: 0, age: ageOf(pos, now), label: p.name };
      if (p.id === driverId) m.driver = true;
      marks.push(m);
    }
    return marks;
  }
  if (s.phase !== 'live') return marks;
  if (isHunter(me)) {
    for (const p of ordered(s)) {
      if (!isHunter(p)) continue;
      const pos = posOf(positions, p.id);
      if (!pos) continue;
      const m = { id: p.id, kind: 'hunter', p: pos.p, r: 0, age: ageOf(pos, now), label: p.name };
      if (p.id === driverId) m.driver = true;
      marks.push(m);
    }
    // v1.4: the driver sees the hunters only (and an SOS, below): nothing about any hider, ever.
    const r = s.radar;
    const radarLive = !!r && clock >= r.liveAt && clock < r.until;
    const blocked = !r ? [] : r.recorded ? (r.blocked || []) : radarSafe(s, r);
    const exposureOn = !!s.exposure && clock >= s.exposure.at && clock < s.exposure.at + TIMING.EXPOSURE_SHOW_MS;
    if (!isDriver(s, me)) {
      // v1.6.1: loot: Blackout shows nothing; the All-Seeing Eye every hider live; Static Storm no hider;
      // a Tracker dart its hider's spot every 20 seconds.
      const eye = fxOn(s, 'eye', clock);
      const tr = s.fx && s.fx.tracker && clock < s.fx.tracker.until ? s.fx.tracker : null;
      if (!fxOn(s, 'blackout', clock)) {
        for (const h of freeHiders(s)) {
          const pos = posOf(positions, h.id);
          if (eye && s.pausedAt == null && pos && current(pos, now) && clock >= sch.headStartMs) {
            marks.push({ id: h.id, label: h.name, kind: 'radar', eye: true, p: [pos.p[0], pos.p[1]], r: 0, age: ageOf(pos, now) });
            continue;
          }
          if (fxOn(s, 'storm', clock)) continue;
          if (tr && tr.target === h.id && tr.spot) {
            marks.push({ id: h.id, label: h.name, kind: 'tracked', p: [tr.spot.p[0], tr.spot.p[1]], r: 0, age: Math.max(0, clock - tr.spot.clock) });
            continue;
          }
          const m = hiderMark(s, h, { clock, now, positions, sch, radarLive, blocked, exposureOn });
          if (m) marks.push(m);
        }
      }
    }
  } else if (isFree(me)) {
    const pos = posOf(positions, me.id);
    if (pos) marks.push({ id: me.id, kind: 'self', p: pos.p, r: 0, age: ageOf(pos, now), label: me.name });
    const seen = newestPingSpot(s, me.id);
    if (seen) {
      marks.push({ id: me.id, kind: 'seen', p: [seen.spot.p[0], seen.spot.p[1]], r: seen.spot.r, age: Math.max(0, clock - seen.ping.clock), label: me.name, ...(seen.spot.smoke ? { smoke: true } : {}) });
    }
  }
  if (s.sos) {
    const by = playerOf(s, s.sos.by);
    const pos = posOf(positions, s.sos.by);
    if (pos) marks.push({ id: s.sos.by, kind: 'sos', p: pos.p, r: 0, age: ageOf(pos, now), label: by ? by.name : '' });
  }
  return marks;
}

export function viewFor(state, playerId, { now, positions = {}, since = 0, radioSince = 0, camSince = 0 } = {}) {
  const s = state;
  const me = playerOf(s, playerId);
  const live = s.phase === 'live';
  const over = s.phase === 'over';
  const clock = clockOf(s, now);
  const sch = schedule(s.settings);
  const paused = live && s.pausedAt !== null && s.pausedAt !== undefined;
  const sinceId = Number.isFinite(Number(since)) ? Number(since) : 0;

  const meView0 = me ? {
    id: me.id,
    name: me.name,
    host: s.hostId === me.id,
    team: me.team,
    startTeam: me.startTeam,
    status: me.status,
    faceV: me.faceV,
    powers: isFree(me) ? { ...me.powers } : {},
    sprintLeft: live && isFree(me) && me.powers.sprint === 'on' && me.sprintUntil !== null ? Math.max(0, me.sprintUntil - clock) : 0,
    outsideFor: live && isFree(me) && me.outsideSince !== null ? Math.max(0, clock - me.outsideSince) : null,
    caught: me.caughtAt !== null && me.caughtAt !== undefined ? { by: me.caughtBy, at: me.caughtAt } : null,
    driver: isDriver(s, me),
  } : {
    id: String(playerId || ''), name: '', host: false, team: null, startTeam: null, status: 'left', faceV: 0,
    powers: {}, sprintLeft: 0, outsideFor: null, caught: null, driver: false,
  };
  // v1.4: my own stored fix, in words ("Location: live" / "30 s old" / "off").
  const meView = { ...meView0, fix: (live || over) && me ? fixOf(s, posOf(positions, me.id), now) : null };
  const driverId = driverIdOf(s);

  const players = ordered(s)
    .filter((p) => s.phase !== 'lobby' || p.status === 'in')
    .map((p) => {
      const row = {
        id: p.id, name: p.name, host: s.hostId === p.id, team: p.team, status: p.status,
        faceV: p.faceV, online: online(s, p, positions, now),
      };
      if (s.phase === 'lobby') row.pick = p.pick;
      if (p.caughtBy) row.caughtBy = p.caughtBy;
      if (p.id === driverId) row.driver = true;
      return row;
    });

  let ringNow = null;
  if (s.ring && s.phase !== 'lobby') ringNow = copy(ringAt(s, live ? clock : (over ? clock : 0)));

  const timing = { headStartLeft: null, left: null, nextPingIn: null, pingN: null, closingIn: null, shrinking: false, closing: false };
  if (live) {
    timing.headStartLeft = clock < sch.headStartMs ? sch.headStartMs - clock : null;
    timing.left = Math.max(0, sch.endMs - clock);
    const k = s.pings.length;
    const times = pingTimes(s, sch);
    if (k < times.length) {
      timing.nextPingIn = Math.max(0, times[k] - clock);
      timing.pingN = k + 1;
    }
    if (sch.closingMs > 0) {
      timing.closing = clock >= sch.closingStartMs;
      timing.closingIn = timing.closing ? null : sch.closingStartMs - clock;
      timing.shrinking = timing.closing && !!s.settings.shrink;
    }
  }

  let team = null;
  const iDrive = !!me && isDriver(s, me);
  if (live && isHunter(me) && !iDrive) {
    const gap = s.team.lastPowerAt !== null ? Math.max(0, s.team.lastPowerAt + TIMING.HUNTER_POWER_GAP_MS - clock) : 0;
    const powers = extrasOf(s.settings).powers;
    const st = (k) => (powers[k] && (s.team[k] === 'ready' || s.team[k] === 'used') ? s.team[k] : null);
    team = {
      radar: s.settings.powers.radar ? s.team.radar : null,
      exposure: s.settings.powers.exposure ? s.team.exposure : null,
      hacker: st('hacker'),
      wiretap: st('wiretap'),
      readyIn: Math.max(gap, Math.max(0, sch.headStartMs - clock)),
    };
  }

  let radar = null;
  if (live && s.radar && me && me.status === 'in' && (me.team === 'hunter' || me.team === 'hider')) {
    const r = s.radar;
    if (clock < r.liveAt) radar = { state: 'warn', ms: r.liveAt - clock };
    else if (clock < r.until) radar = { state: 'live', ms: r.until - clock };
    if (radar && me.team === 'hider') {
      radar.safe = clock < r.liveAt || !r.recorded ? radarSafe(s, r).includes(me.id) : (r.blocked || []).includes(me.id);
    }
  }

  // A tag's minute runs once the hider's phone has it (seen). Until then: no countdown, except on the hider's
  // own phone, which is just getting it and starts the minute with its next request.
  const pending = !live || !me ? [] : s.catches
    .filter((c) => c.state === 'pending' && (s.hostId === me.id || c.hunter === me.id || c.hider === me.id))
    .map((c) => {
      const from = tagFrom(c);
      const autoIn = from !== null ? Math.max(0, from + TIMING.TAG_AUTO_MS - clock)
        : c.hider === me.id ? TIMING.TAG_AUTO_MS : null;
      return { id: c.id, hunter: c.hunter, hider: c.hider, at: c.at, seen: from !== null, autoIn };
    });

  // Hunters: the hiders whose phones they were told send no location (cleared when one comes back).
  const noSignal = live && isHunter(me) && !iDrive ? freeHiders(s).filter((p) => p.noFixTold === true).map((p) => p.id) : [];

  let sos = null;
  if (live && s.sos) {
    const by = playerOf(s, s.sos.by);
    const pos = posOf(positions, s.sos.by);
    sos = { by: s.sos.by, name: by ? by.name : '', p: pos ? pos.p : null };
  }

  // v1.1: the driver, the walkie-talkie, spectators
  const parked = live && !!me && isDriver(s, me) && isParked(s, positions, now);
  const marks = marksFor(s, me, { clock, now, positions, sch });
  const drive = live && me ? driveFor(s, me, { now, positions, parked }) : null;
  let radio = null;
  if (live && me && maySend(s, me)) {
    const after = Number.isFinite(Number(radioSince)) ? Number(radioSince) : 0;
    const mine = radioOf(s).clips.filter((c) => hearsLive(me, c, s));
    const fresh = mine.filter((c) => c.n > after).slice(-RADIO_VIEW_MOST)
      .map((c) => {
        const out = { n: c.n, from: c.from, clock: c.clock, ms: c.ms, type: c.type };
        if (c.side === 'wiretap') { out.tap = c.tap; out.of = c.of; }
        return out;
      });
    radio = { clips: fresh, last: mine.length ? mine[mine.length - 1].n : 0, side: isHunter(me) ? 'hunters' : 'hiders' };
  }
  const cam = camViewFor(s, me, camSince);
  const isHost = !!me && s.hostId === me.id;
  const watchers = isHost ? Object.values(watchersOf(s))
    .sort((a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : 1))
    .map((w) => ({ id: w.id, name: w.name })) : [];

  const events = s.events
    .filter((e) => e.id > sinceId && canSee(e, me, s))
    .map((e) => {
      const out = { id: e.id, at: e.at, clock: e.clock, kind: e.kind, to: e.to, text: e.text };
      if (e.from) out.from = e.from;
      if (e.data) out.data = copy(e.data);
      return out;
    });

  return {
    v: s.v,
    engine: ENGINE_V,
    code: s.code,
    phase: s.phase,
    sub: live ? (clock < sch.headStartMs ? 'headstart' : 'hunt') : null,
    now,
    clock,
    paused,
    me: meView,
    players,
    settings: copy(extrasOf(s.settings)),
    ring: s.ring ? copy(s.ring) : null,
    ringNow,
    timing,
    marks,
    team,
    radar,
    pending,
    sos,
    noSignal,
    events,
    // The newest event this player may see (never the game's own count, which would tell them the moment
    // the other side does something secret).
    lastEventId: s.events.reduce((m, e) => (e.id > m && canSee(e, me, s) ? e.id : m), 0),
    result: over && s.result ? copy(s.result) : null,
    // The summary (routes and all, up to 140 KB) goes once: with the view that first carries the 'over'
    // event, or to a phone starting afresh (since 0). The page keeps it (overId says which round it's for).
    summary: over && s.summary && !(Number.isFinite(s.overEventId) && sinceId >= s.overEventId) ? copy(s.summary) : null,
    overId: over && Number.isFinite(s.overEventId) ? s.overEventId : null,
    watching: watchingCount(s, now),
    driverPick: s.phase === 'lobby' && typeof s.driverPick === 'string' ? s.driverPick : null,
    vote: s.phase === 'lobby' && s.vote ? voteView(s.vote, me ? me.id : null) : null, // v1.6
    loot: (live || over) ? lootView(s, me, clock) : null, // v1.6 Loot drops
    fx: live ? lootFxView(s, me, clock, positions, now) : null, // v1.6.1 the loot powers' effects
    watchers,
    drive,
    radio,
    cam,
    cp: driverCp(cpViewFor(s, me, { clock, now, positions }), live && iDrive),
    // v1.4
    ...v14ViewFor(s, me, { live, over, clock, now, positions, sch }),
  };
}

// v1.4: the driver's view of the checkpoints: the checkpoints themselves, never who did one (where a hider was).
function driverCp(cp, driving) {
  if (!cp || !driving) return cp;
  // the driver never learns who is at a checkpoint: no done list and no scores while live
  const out = { ...cp };
  if (Array.isArray(cp.done)) out.done = [];
  if ('scores' in cp) out.scores = [];
  return out;
}

// v1.2: what a player's view says about the camera (see the contract's "View additions").
const CAM_VIEW_MOST = 30;
function camViewFor(s, me, camSince) {
  if (s.phase === 'lobby') {
    const settings = extrasOf(s.settings);
    if (!settings.cam) return null;
    const inList = ordered(s).filter((p) => p.status === 'in');
    const okList = inList.filter((p) => p.camOk === true);
    return {
      on: true, mode: settings.camMode,
      ok: !!me && me.camOk === true,
      okCount: okList.length, inCount: inList.length,
      okIds: me && s.hostId === me.id ? okList.map((p) => p.id) : null,
      filmed: [], moments: [], last: 0, kept: null,
    };
  }
  const c = s.cam;
  if (!c || !Array.isArray(c.ids)) return null;
  const after = Number.isFinite(Number(camSince)) ? Number(camSince) : 0;
  const mine = me ? (c.moments || []).filter((m) => Array.isArray(m.ids) && m.ids.includes(me.id)) : [];
  const moments = mine.filter((m) => m.n > after).slice(-CAM_VIEW_MOST).map((m) => {
    const out = { n: m.n, clock: m.clock, kind: m.kind };
    if (Number.isFinite(m.ms)) out.ms = m.ms;
    return out;
  });
  const started = ordered(s).filter((p) => !!p.startTeam).length;
  return {
    on: true, mode: c.mode,
    ok: !!me && c.ids.includes(me.id),
    okCount: c.ids.length, inCount: started,
    okIds: null,
    filmed: c.ids.slice(),
    moments,
    last: mine.length ? mine[mine.length - 1].n : 0,
    kept: null,
  };
}

// The driver's panel (the driver) or the pickup button's facts (another hunter who is in), else null.
function driveFor(s, me, { now, positions, parked }) {
  if (!s.driver || !isHunter(me)) return null;
  const d = playerOf(s, s.driver.id);
  if (!d) return null;
  const here = !!driverOf(s);
  if (me.id !== d.id) {
    const k = (s.pickups || []).find((x) => x.by === me.id && (x.state === 'open' || x.state === 'coming'));
    return {
      id: d.id, name: d.name, here,
      mine: k ? { id: k.id, state: k.state, at: k.at, comingAt: k.comingAt } : null,
    };
  }
  if (!here) return null;
  const fix = driverFix(positions, d.id);
  const pickups = (s.pickups || []).filter((k) => k.state === 'open' || k.state === 'coming').map((k) => {
    const asker = playerOf(s, k.by);
    const pos = posOf(positions, k.by);
    // (A pinned pickup stays where it was asked for; otherwise it follows the asker, a hunter.)
    const follow = pos && !k.pinned;
    return {
      id: k.id, by: k.by, name: asker ? asker.name : '',
      p: follow ? pos.p : [k.p[0], k.p[1]], age: follow ? ageOf(pos, now) : 0,
      state: k.state, at: k.at, pinned: !!k.pinned,
    };
  });
  return {
    id: d.id, name: d.name, here: true, me: true,
    parked: !!parked,
    speedKmh: fix && Number.isFinite(fix.v) ? Math.round(fix.v * 3.6) : null,
    fixAge: fix && Number.isFinite(fix.at) ? Math.max(0, now - fix.at) : null,
    pickups,
    drivenM: Math.round(d.stats.drivenM || 0),
    done: d.stats.pickups || 0,
  };
}

// ---------------------------------------------------------------------------------------------------------
// v1.3: Checkpoints (see the contract's "v1.3: Checkpoints"). One checkpoint ("slot") is active at a time,
// for the free hiders from `at` and for everyone else from `show`. A free hider whose fresh fix is inside the
// active slot has an open visit there: safe from tags for the safe time (per checkpoint, in total), then
// shown live to the hunters until they leave. Everything is decided here, from stored fixes only.

const CP_SPARE_MS = 15000;      // a visit that ends with this little safe time left (1 s or more) is a close call
const CP_NEAR_WINDOW_MS = 15000;
const CP_PHOTO_ID = /^[0-9a-f]{16}$/;
const CP_TAG_NOT_NOW = "That tag can't count right now. Sort it out in person.";

function freshCp(plan, unopened, openMs, leadMs, safeMs) {
  return {
    plan, unopened, openMs, leadMs, safeMs,
    stage: { opened: 0, shown: 0, closed: 0 },
    done: [],
    next: 1,
    visits: {},
    used: {},
    toldAt: {},
    refused: {},
    photos: { count: 0, bytes: 0, lastAt: {} },
  };
}

// (Fills in what an older or hand-made state.cp lacks; on a copy we own.)
function fillCp(s) {
  if (s.cp === undefined || (s.cp !== null && (typeof s.cp !== 'object' || !Array.isArray(s.cp.plan)))) s.cp = null;
  if (!s.cp) return;
  const cp = s.cp;
  const plan = cpPlan(s.settings, cp.plan.length);
  if (!Number.isFinite(cp.unopened)) cp.unopened = 0;
  if (!Number.isFinite(cp.openMs)) cp.openMs = plan.openMs;
  if (!Number.isFinite(cp.leadMs)) cp.leadMs = plan.leadMs;
  if (!Number.isFinite(cp.safeMs)) cp.safeMs = plan.safeMs;
  if (!cp.stage || typeof cp.stage !== 'object') cp.stage = { opened: 0, shown: 0, closed: 0 };
  for (const k of ['opened', 'shown', 'closed']) if (!Number.isInteger(cp.stage[k])) cp.stage[k] = 0;
  if (!Array.isArray(cp.done)) cp.done = [];
  for (const d of cp.done) if (!Array.isArray(d.hist)) d.hist = d.struck ? [[Number.isFinite(d.struckAt) ? d.struckAt : d.clock, true]] : [];
  if (!Number.isFinite(cp.next)) cp.next = cp.done.reduce((m, d) => Math.max(m, d.n || 0), 0) + 1;
  for (const k of ['visits', 'used', 'toldAt', 'refused']) {
    if (!cp[k] || typeof cp[k] !== 'object' || Array.isArray(cp[k])) cp[k] = {};
  }
  if (!cp.photos || typeof cp.photos !== 'object') cp.photos = { count: 0, bytes: 0, lastAt: {} };
  if (!Number.isFinite(cp.photos.count)) cp.photos.count = 0;
  if (!Number.isFinite(cp.photos.bytes)) cp.photos.bytes = 0;
  if (!cp.photos.lastAt || typeof cp.photos.lastAt !== 'object') cp.photos.lastAt = {};
}

function cpGame(s) {
  const cp = s && s.cp;
  return !!cp && typeof cp === 'object' && Array.isArray(cp.plan) && !!cp.stage && Array.isArray(cp.done)
    && !!cp.visits && !!cp.used && !!cp.toldAt && !!cp.refused && !!cp.photos;
}

// A state.cp that needs fillIn's help (older or hand-made).
function cpUnfilled(s) {
  return !!s && !!s.cp && !cpGame(s);
}

// Counted checkpoints of one player: each slot once (a struck one done again, then counted again, is one).
function cpCountOf(dones, pid) {
  return new Set(dones.filter((d) => d && d.pid === pid && !d.struck).map((d) => d.k)).size;
}

function cpSafeOf(s) {
  return Number.isFinite(s.cp.safeMs) ? s.cp.safeMs : cpPlan(s.settings, s.cp.plan.length).safeMs;
}

// A stored fix as the checkpoints read it, or null. `got` = when the server stored it (else `at`).
function cpFix(pos) {
  if (!pos || typeof pos !== 'object' || !isPoint(pos.p)) return null;
  const at = Number.isFinite(pos.at) ? pos.at : null;
  return {
    p: [pos.p[0], pos.p[1]],
    at,
    got: Number.isFinite(pos.got) ? pos.got : at,
    acc: Number.isFinite(pos.acc) && pos.acc >= 0 ? pos.acc : 0,
    clock: Number.isFinite(pos.clock) ? pos.clock : null,
  };
}

// A fix that says something about inside or outside: fresh (CP_FRESH_MS, by the phone's time and by when the
// server got it) and no worse than CP_ACC_MAX_M. Poor fixes change nothing.
function cpDecisive(pos, now) {
  const f = cpFix(pos);
  if (!f || f.at === null || f.got === null) return null;
  if (now - f.at > TIMING.CP_FRESH_MS || now - f.got > TIMING.CP_FRESH_MS) return null;
  return f.acc <= TIMING.CP_ACC_MAX_M ? f : null;
}

function cpWithin(slot, f) {
  return distanceM(slot.p, f.p) <= slot.r + Math.min(f.acc, TIMING.CP_ACC_SLACK_M);
}

// Is this fix inside this checkpoint right now? (Exported for tests; a page never decides it.)
export function cpInside(cp, pos, now) {
  if (!cp || typeof cp !== 'object' || !isPoint(cp.p) || !Number.isFinite(cp.r)) return false;
  const f = cpDecisive(pos, now);
  return !!f && cpWithin(cp, f);
}

function posFrom(positions, id) {
  return positions && typeof positions === 'object' && typeof id === 'string' && has(positions, id) ? positions[id] : null;
}

// How a fresh fix stands to a checkpoint: { f, where }. where 'in' (a good fix inside: opens or keeps a visit),
// 'near' (a poor fix, as indoors, whose centre is close: keeps an open visit going, opens none), 'out' (a good fix
// clearly outside even allowing for its accuracy: ends a visit), or null (it says nothing either way). Null
// when the fix isn't fresh.
function cpWhere(slot, pos, now) {
  const f = cpFix(pos);
  if (!f || f.at === null || f.got === null) return null;
  if (now - f.at > TIMING.CP_FRESH_MS || now - f.got > TIMING.CP_FRESH_MS) return null;
  const d = distanceM(slot.p, f.p);
  if (f.acc <= TIMING.CP_ACC_MAX_M) {
    if (d <= slot.r + Math.min(f.acc, TIMING.CP_ACC_SLACK_M)) return { f, d, where: 'in' };
    return { f, d, where: d - f.acc > slot.r ? 'out' : null };
  }
  return { f, d, where: d <= slot.r + Math.min(f.acc, TIMING.CP_POOR_SLACK_M) ? 'near' : null };
}

// A visit kept going by a fix this recently (server time; the fix's own time if older).
function cpHeld(v, now) {
  return !!v && Number.isFinite(v.got) && now - v.got <= TIMING.CP_HOLD_MS;
}

// Is this hider at this (active) checkpoint now, for the photo, the stay and the ring? Their newest fix inside,
// or an open visit there kept going recently, unless the newest fix is clearly outside.
function cpHere(s, pid, slot, positions, now) {
  const w = cpWhere(slot, posFrom(positions, pid), now);
  if (w && w.where === 'out') return false;
  if (w && w.where === 'in') return true;
  const v = cpVisit(s, pid);
  return !!v && v.k === slot.k && cpHeld(v, now);
}

// The active slot at this clock (live only): at <= clock < close.
function cpActive(s, clock) {
  if (!cpGame(s) || s.phase !== 'live') return null;
  return s.cp.plan.find((a) => a.at <= clock && clock < a.close) || null;
}

const cpKey = (pid, k) => `${pid}|${k}`;

function cpUsed(s, pid, k) {
  const v = s.cp.used[cpKey(pid, k)];
  return Number.isFinite(v) ? v : 0;
}

function cpCounted(s, pid, k) {
  return s.cp.done.find((d) => d.pid === pid && d.k === k && !d.struck) || null;
}

function cpVisit(s, pid) {
  return has(s.cp.visits, pid) ? s.cp.visits[pid] : null;
}

function taskWords(task) {
  if (typeof task !== 'string' || !task) return '';
  return /[.!?]$/.test(task) ? task : `${task}.`;
}

function cpCountWords(n) {
  return n === 1 ? '1 checkpoint' : `${n} checkpoints`;
}

// May the hunters see what happens at this checkpoint yet? Not during the head start, nor before its `show`
// (the server never gives a checkpoint's place away early, not even by a hider shown standing in it).
function cpHuntersSee(s, slot, clock) {
  return clock >= schedule(s.settings).headStartMs && clock >= slot.show;
}

function cpTellHunters(s, p, why, t) {
  if (why === 'time') emit(s, t, 'checkpoint', 'hunters', `${p.name} stayed at the checkpoint too long: live on your map.`, { what: 'overstay', id: p.id });
  else emit(s, t, 'checkpoint', 'hunters', `${p.name} went back to a checkpoint they already did: live on your map.`, { what: 'again', id: p.id });
}

// Safe time ran out (or the visit opened with none left, or on a checkpoint already done): the hunters see
// this hider live until they leave. Before the hunters may see the checkpoint they aren't told (cpShow tells
// them then, if it's still so).
function cpExposeNews(s, p, slot, why, t) {
  const N = slot.k + 1;
  if (why === 'time') {
    emit(s, t, 'checkpoint', p.id, 'Your safe time is up. The hunters can see you until you leave the checkpoint.', { what: 'overstay', k: slot.k });
    note(s, { kind: 'cp-overstay', clock: t.clock, id: p.id, k: slot.k, text: `${p.name} stayed at checkpoint ${N} too long.` });
  } else {
    emit(s, t, 'checkpoint', p.id, "You already did this checkpoint, so you're not safe here. The hunters can see you until you leave.", { what: 'again', k: slot.k });
    note(s, { kind: 'cp-again', clock: t.clock, id: p.id, k: slot.k, text: `${p.name} went back to checkpoint ${N}.` });
  }
  if (cpHuntersSee(s, slot, t.clock)) cpTellHunters(s, p, why, t);
  addMoment(s, t, 'overstay', [p.id]);
}

// A visit ends at game clock `end`. Safe time spent in it is added up (an exposed visit adds nothing more).
// why: 'out' (a fix outside), 'stale' (no fix inside for CP_FRESH_MS), 'close', 'gone', 'end'.
function cpEndVisit(s, pid, end, why, t) {
  const v = cpVisit(s, pid);
  if (!v) return;
  delete s.cp.visits[pid];
  // (Back in within CP_BACK_MS after leaving: the same visit goes on, so GPS jitter at the edge is never 'again'.)
  if (why === 'out' || why === 'stale') {
    if (!s.cp.back || typeof s.cp.back !== 'object') s.cp.back = {};
    s.cp.back[pid] = { k: v.k, clock: t.clock, exposed: v.exposed || null };
  }
  const until = Math.max(v.since, end);
  if (!v.exposed) {
    const key = cpKey(pid, v.k);
    const used = cpUsed(s, pid, v.k);
    const left = Math.max(0, cpSafeOf(s) - used);
    const spent = Math.min(until - v.since, left);
    s.cp.used[key] = used + spent;
    const spare = left - spent;
    if ((why === 'out' || why === 'stale') && spare >= 1000 && spare <= CP_SPARE_MS) {
      note(s, { kind: 'cp-left', clock: until, id: pid, k: v.k, spare });
    }
  } else if (why === 'out' || why === 'stale') {
    emit(s, t, 'checkpoint', pid, 'You left the checkpoint.', { what: 'left', k: v.k });
  }
}

function cpEndAll(s, t, why, which = () => true) {
  if (!cpGame(s)) return;
  for (const pid of Object.keys(s.cp.visits)) {
    const v = s.cp.visits[pid];
    if (v && which(v)) cpEndVisit(s, pid, t.clock, why, t);
  }
}

// A checkpoint counts (a photo, or a stay with photos off).
function cpRecord(s, p, slot, how, photo, t, bytes) {
  const cp = s.cp;
  const told = t.clock >= slot.show;
  const d = {
    n: cp.next++, k: slot.k, pid: p.id, clock: t.clock, how, photo: how === 'photo' ? photo : null,
    struck: false, struckAt: null, told, hist: [],
  };
  cp.done.push(d);
  if (how === 'photo') {
    cp.photos.count += 1;
    if (Number.isInteger(bytes) && bytes > 0) cp.photos.bytes += bytes;
    cp.photos.lastAt[p.id] = t.now;
  }
  const text = `${p.name} did checkpoint ${slot.k + 1}: ${slot.name}.`;
  emit(s, t, 'checkpoint', told ? 'all' : 'hiders', text, { what: 'done', n: d.n, k: slot.k, pid: p.id, photo: d.photo, how });
  addMoment(s, t, 'checkpoint', [p.id]);
  note(s, { kind: 'cp-done', clock: t.clock, id: p.id, k: slot.k, n: d.n, text });
  return d;
}

// A free hider's fix (onPosition): visits open, go on and end. Returns whether anything changed.
function cpOnFix(s, p, raw, now, clock) {
  const cp = s.cp;
  const slot = cpActive(s, clock);
  const t = { now, clock, at: now };
  let changed = false;
  let v = cpVisit(s, p.id);
  if (v && (!slot || v.k !== slot.k)) {
    cpEndVisit(s, p.id, clock, 'close', t);
    v = null;
    changed = true;
  }
  if (!slot) return changed;
  const w = cpWhere(slot, raw, now);
  if (!w || !w.where) return changed;
  const f = w.f;
  if (w.where === 'out') {
    // Charged up to now (when the server heard it), never to a time the phone says: that could take it back.
    if (v) {
      cpEndVisit(s, p.id, clock, 'out', t);
      changed = true;
    }
    return changed;
  }
  // The fix's own clock (when it was taken), never ahead of now nor before the slot opened.
  const at = Math.max(slot.at, f.clock !== null ? Math.min(f.clock, clock) : clock);
  const got = Math.min(f.got, f.at, now);
  if (w.where === 'near' && !v) return changed; // a poor fix opens nothing
  if (v) {
    if (at > v.at) v.at = at;
    if (!(Number.isFinite(v.got) && v.got >= got)) v.got = got;
    changed = true;
  } else {
    const safeMs = cpSafeOf(s);
    const back = cp.back && has(cp.back, p.id) ? cp.back[p.id] : null;
    const resumed = !!back && back.k === slot.k && clock - back.clock <= TIMING.CP_BACK_MS;
    if (back) delete cp.back[p.id];
    const outOfTime = cpUsed(s, p.id, slot.k) >= safeMs ? 'time' : null;
    const exposed = resumed ? (back.exposed || outOfTime) : cpCounted(s, p.id, slot.k) ? 'again' : outOfTime;
    v = { k: slot.k, since: at, at, got, exposed, exposedAt: exposed ? at : null, stayTried: false };
    cp.visits[p.id] = v;
    changed = true;
    if (exposed) {
      cpExposeNews(s, p, slot, exposed, t);
    } else if (!exposed) {
      const key = cpKey(p.id, slot.k);
      const last = cp.toldAt[key];
      if (!Number.isFinite(last) || clock - last >= TIMING.CP_TOLD_GAP_MS) {
        cp.toldAt[key] = clock;
        const left = Math.max(0, safeMs - cpUsed(s, p.id, slot.k));
        const how = s.settings.cpPhoto ? 'Take the photo.' : `Stay ${Math.round(TIMING.CP_STAY_MS / 1000)} seconds to count it.`;
        emit(s, t, 'checkpoint', p.id, `You're at the checkpoint. You're safe here for ${fmtClock(left)}. ${how}`, { what: 'at', k: slot.k, safeMs: left });
      }
    }
  }
  // Photos off: inside long enough in this visit counts it (also checked by advance's 'cpStay').
  if (!s.settings.cpPhoto && !v.exposed && !cpCounted(s, p.id, slot.k) && v.at - v.since >= TIMING.CP_STAY_MS) {
    v.stayTried = true;
    cpRecord(s, p, slot, 'stay', null, t);
    changed = true;
  }
  return changed;
}

// Protected from tags right now: an open, unexposed visit on the active slot, inside on a fresh fix, with safe
// time left. Returns the slot, or null.
// The visit must have been kept going by a fix in the last CP_HOLD_MS (a phone gone quiet, locked or out of
// signal, isn't safe for long), and a good newest fix must be inside the circle the hunters see (the accuracy
// slack only helps a checkpoint count; a poor fix, as indoors, may be a little off).
function cpProtected(s, h, positions, now, clock) {
  if (!cpGame(s) || !isFree(h)) return null;
  const slot = cpActive(s, clock);
  const v = cpVisit(s, h.id);
  if (!slot || !v || v.k !== slot.k || v.exposed) return null;
  const pos = posFrom(positions, h.id);
  if (Number.isFinite(v.got)) {
    if (!cpHeld(v, now)) return null;
  } else if (!cpInside(slot, pos, now)) {
    return null; // (a visit from before v.got was kept)
  }
  const w = cpWhere(slot, pos, now);
  if (w && (w.where === 'out' || (w.f.acc <= TIMING.CP_ACC_MAX_M && w.d > slot.r))) return null;
  if (cpUsed(s, h.id, slot.k) + (clock - v.since) >= cpSafeOf(s)) return null;
  return slot;
}

// A free hider the hunters see live because of a checkpoint (an exposed visit), once the hunters may see that
// checkpoint (`clock` given: the hunters' map).
function cpExposed(s, h, clock) {
  if (!cpGame(s) || !isFree(h)) return false;
  const v = cpVisit(s, h.id);
  if (!v || !v.exposed) return false;
  if (clock === undefined) return true;
  const slot = s.cp.plan[v.k];
  return !!slot && cpHuntersSee(s, slot, clock);
}

// The due items (advance), after the existing ones at the same clock.
function cpDue(s, sch, offer) {
  if (!cpGame(s)) return;
  const cp = s.cp;
  const plan = cp.plan;
  const E = sch.endMs;
  // (A slot closes as the next one opens, at the same clock: the close goes first.)
  if (cp.stage.closed < plan.length - 1 && cp.stage.closed < cp.stage.opened) {
    const sl = plan[cp.stage.closed];
    if (sl.close < E) offer(sl.close, 10, { type: 'cpClose', k: sl.k });
  }
  if (cp.stage.opened < plan.length) {
    const sl = plan[cp.stage.opened];
    if (sl.at < E) offer(sl.at, 11, { type: 'cpOpen', k: sl.k });
  }
  if (cp.stage.shown < plan.length && cp.stage.shown < cp.stage.opened) {
    const sl = plan[cp.stage.shown];
    if (sl.show < E) offer(sl.show, 12, { type: 'cpShow', k: sl.k });
  }
  const safeMs = cpSafeOf(s);
  for (const p of ordered(s)) {
    const v = cpVisit(s, p.id);
    if (!v) continue;
    // An exposed visit never goes stale: it ends only on a good fix outside (or the close, a catch, the end),
    // so going quiet never takes a hider off the hunters' map (the offline rule takes over in time).
    if (v.exposed) continue;
    // (At the same clock: the stay counts first, then the stale end, then the safe time.)
    if (!s.settings.cpPhoto && !v.stayTried && !cpCounted(s, p.id, v.k)) {
      const stay = v.since + TIMING.CP_STAY_MS;
      if (stay < E) offer(stay, 13, { type: 'cpStay', id: p.id });
    }
    if (v.at + TIMING.CP_FRESH_MS < E) offer(v.at + TIMING.CP_FRESH_MS, 14, { type: 'cpStale', id: p.id });
    const out = v.since + Math.max(0, safeMs - cpUsed(s, p.id, v.k));
    if (out < E) offer(out, 15, { type: 'cpSafeOut', id: p.id });
  }
}

function cpRunDue(s, item, t, ctx) {
  const cp = s.cp;
  const total = cp.plan.length;
  switch (item.type) {
    case 'cpClose': {
      const slot = cp.plan[cp.stage.closed];
      cp.stage.closed += 1;
      cpEndAll(s, t, 'close', (v) => v.k === slot.k);
      emit(s, t, 'checkpoint', 'all', `Checkpoint ${slot.k + 1} is closed.`, { what: 'close', k: slot.k });
      return true;
    }
    case 'cpOpen': {
      const slot = cp.plan[cp.stage.opened];
      cp.stage.opened += 1;
      const huntersIn = Math.max(0, slot.show - t.clock);
      const task = taskWords(slot.task);
      let text = `New checkpoint (${slot.k + 1} of ${total}): ${slot.name}.${task ? ` ${task}` : ''}`;
      if (huntersIn > 0) text += ` The hunters see it in ${fmtClock(huntersIn)}.`;
      emit(s, t, 'checkpoint', 'hiders', text, {
        what: 'open', k: slot.k, id: slot.id, name: slot.name, task: slot.task, p: [slot.p[0], slot.p[1]], r: slot.r, total, huntersIn,
      });
      if (slot.show > slot.at) {
        emit(s, t, 'checkpoint', 'hunters', `The hiders have checkpoint ${slot.k + 1}. You see it in ${fmtClock(huntersIn)}.`,
          { what: 'soon', k: slot.k, total, inMs: huntersIn });
      }
      return true;
    }
    case 'cpShow': {
      const slot = cp.plan[cp.stage.shown];
      cp.stage.shown += 1;
      emit(s, t, 'checkpoint', 'hunters', `New checkpoint (${slot.k + 1} of ${total}): ${slot.name}. Wait outside: no running or yelling inside stores.`, {
        what: 'show', k: slot.k, id: slot.id, name: slot.name, task: slot.task, p: [slot.p[0], slot.p[1]], r: slot.r, total,
      });
      note(s, { kind: 'cp-open', clock: t.clock, k: slot.k, text: `Checkpoint ${slot.k + 1} opened: ${slot.name}.` });
      // Hiders shown there before the hunters could see it: the hunters are told now (the map shows them now).
      if (cpHuntersSee(s, slot, t.clock)) {
        for (const p of ordered(s)) {
          const v = cpVisit(s, p.id);
          if (v && v.k === slot.k && v.exposed && isFree(p)) cpTellHunters(s, p, v.exposed, t);
        }
      }
      // Checkpoints done in the hiders' head start on it are told to the hunters now (struck ones aren't).
      for (const d of cp.done) {
        if (d.k !== slot.k || d.told) continue;
        d.told = true;
        if (d.struck) continue;
        const p = playerOf(s, d.pid);
        emit(s, t, 'checkpoint', 'hunters', `${p ? p.name : 'Someone'} did checkpoint ${slot.k + 1}: ${slot.name}.`,
          { what: 'done', n: d.n, k: d.k, pid: d.pid, photo: d.photo, how: d.how, late: true });
      }
      return true;
    }
    case 'cpStale': {
      // Safe time counts up to the last fix that kept the visit going, not up to now.
      const v = cpVisit(s, item.id);
      if (v && !v.exposed) cpEndVisit(s, item.id, Math.min(v.at, item.clock), 'stale', t);
      return true;
    }
    case 'cpSafeOut': {
      const v = cpVisit(s, item.id);
      const p = playerOf(s, item.id);
      if (!v || v.exposed || !p) return true;
      // Nothing kept the visit going lately: they may well have left, so nobody is shown; the visit ends there.
      if (item.clock - v.at > TIMING.CP_HOLD_MS) {
        cpEndVisit(s, item.id, v.at, 'stale', t);
        return true;
      }
      v.exposed = 'time';
      v.exposedAt = item.clock;
      cp.used[cpKey(item.id, v.k)] = cpSafeOf(s);
      cpExposeNews(s, p, cp.plan[v.k], 'time', t);
      return true;
    }
    case 'cpStay': {
      const v = cpVisit(s, item.id);
      const p = playerOf(s, item.id);
      if (!v || !p) return true;
      v.stayTried = true;
      const slot = cp.plan[v.k];
      const w = cpWhere(slot, posFrom(ctx.positions, p.id), ctx.now);
      if (!v.exposed && isFree(p) && !cpCounted(s, p.id, v.k) && !s.settings.cpPhoto && !(w && w.where === 'out')) {
        cpRecord(s, p, slot, 'stay', null, t);
      }
      return true;
    }
    default:
      return false;
  }
}

// cmdStart's part in Checkpoints: an error, or the round's state.cp (made only once everything else passed).
function cpCheckStart(s) {
  if (s.settings.mode !== 'checkpoints') return null;
  const list = Array.isArray(s.checkpoints) ? s.checkpoints : [];
  if (list.length < LIMITS.checkpointsLeast) return err('no_checkpoints');
  const problem = checkpointProblem(list, s.ring);
  if (problem) return err('bad_checkpoints', problem);
  if (cpPlan(s.settings, list.length).slots.length < LIMITS.checkpointsLeast) {
    return err('no_checkpoints', 'The game is too short for 2 checkpoints. Make it longer or set the open time to Auto.');
  }
  return null;
}

function cpMake(s, R) {
  const list = s.checkpoints;
  const order = s.settings.cpOrder === 'shuffle' ? shuffled(list, R) : list.slice();
  const plan = cpPlan(s.settings, order.length);
  const slots = plan.slots.map((sl) => {
    const c = order[sl.k];
    return { k: sl.k, id: c.id, name: c.name, task: c.task, p: [c.p[0], c.p[1]], r: c.r, at: sl.at, show: sl.show, close: sl.close };
  });
  return freshCp(slots, plan.skipped, plan.openMs, plan.leadMs, plan.safeMs);
}

function cmdCheckpoints(s, actor, cmd) {
  const list = cmd.list;
  if (!Array.isArray(list)) return err('bad_checkpoints', 'Add the checkpoints again.');
  if (list.length > LIMITS.checkpoints) return err('bad_checkpoints', `At most ${LIMITS.checkpoints} checkpoints.`);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || typeof c !== 'object' || Array.isArray(c) || !isPoint(c.p)) return err('bad_checkpoints', `Checkpoint ${i + 1} is off the map.`);
  }
  const clean = cleanCheckpoints(list);
  const problem = checkpointProblem(clean, s.ring);
  if (problem) return err('bad_checkpoints', problem);
  s.checkpoints = clean;
  return null;
}

// Who may see a slot: a free hider from `at`; everyone else from `show`; everyone once over (if it opened).
function cpSeesSlot(s, me, slot, clock) {
  if (s.phase === 'over') return slot.k < s.cp.stage.opened || slot.at <= clock;
  return isFree(me) ? slot.at <= clock : slot.show <= clock;
}

function cpSeesDone(s, me, d, clock) {
  if (s.phase === 'over') return true;
  if (me && d.pid === me.id) return true;
  const slot = s.cp.plan[d.k];
  return !!slot && cpSeesSlot(s, me, slot, clock);
}

// struck as of a clock (spectators): the last change at or before it.
function struckAt(d, T) {
  let out = false;
  for (const [clock, struck] of d.hist || []) if (clock <= T) out = struck;
  return out;
}

function cmdCpStrike(s, actor, cmd, t) {
  if (!cpGame(s)) return err('bad_cmd');
  if (!Number.isInteger(cmd.n) || typeof cmd.struck !== 'boolean') return err('bad_cmd');
  const over = s.phase === 'over';
  const d = s.cp.done.find((x) => x.n === cmd.n);
  if (!d || (!over && !cpSeesDone(s, actor, d, t.clock))) return err('bad_target', "That checkpoint isn't on your screen yet.");
  if (d.struck === cmd.struck) return null;
  if (!cmd.struck && cpCounted(s, d.pid, d.k)) {
    const p0 = playerOf(s, d.pid);
    return err('bad_target', `${p0 ? p0.name : 'They'} did checkpoint ${d.k + 1} again, and that one counts already.`);
  }
  const at = over && Number.isFinite(s.endClock) ? s.endClock : t.clock;
  d.struck = cmd.struck;
  d.struckAt = at;
  d.hist.push([at, cmd.struck]);
  const p = playerOf(s, d.pid);
  const name = p ? p.name : 'Someone';
  const N = d.k + 1;
  const text = cmd.struck ? `The host didn't count ${name}'s checkpoint ${N}.` : `The host counts ${name}'s checkpoint ${N} again.`;
  const data = { what: 'strike', n: d.n, pid: d.pid, struck: cmd.struck };
  const te = { now: t.now, clock: at, at: t.now };
  note(s, { kind: 'cp-strike', clock: at, id: d.pid, n: d.n, text });
  if (over) {
    data.winners = cpRejudge(s);
    if (s.summary && Array.isArray(s.summary.events)) s.summary.events.push({ clock: at, text });
  }
  emit(s, te, 'checkpoint', over || d.told ? 'all' : 'hiders', text, data);
  return null;
}

// The scores: one row per player who started as a hider (not kicked), best first. `asOf` (spectators): a catch
// after that clock doesn't count yet.
export function cpScores(state, dones, { asOf } = {}) {
  if (!state || !state.players) return [];
  const list = Array.isArray(dones) ? dones : [];
  const rows = ordered(state).filter((p) => p.startTeam === 'hider' && p.status !== 'kicked').map((p) => {
    const mine = list.filter((d) => d && d.pid === p.id && !d.struck);
    // (The newest counted one per slot: each slot counts once.)
    const firsts = new Map();
    for (const d of mine) if (!firsts.has(d.k) || d.clock < firsts.get(d.k)) firsts.set(d.k, d.clock);
    const last = firsts.size ? Math.max(...firsts.values()) : null;
    const caughtAt = Number.isFinite(p.caughtAt) ? p.caughtAt : null;
    const caught = caughtAt !== null && (!Number.isFinite(asOf) || caughtAt <= asOf);
    // Someone who left the game stays on the board but can't win, and ties like someone caught.
    const left = p.status === 'left' && (!Number.isFinite(asOf) || !Number.isFinite(p.leftAt) || p.leftAt <= asOf);
    return { pid: p.id, name: p.name, count: firsts.size, last, caught, left };
  });
  rows.sort((a, b) => (b.count - a.count) || (Number(a.caught || a.left) - Number(b.caught || b.left))
    || ((a.last === null ? Infinity : a.last) - (b.last === null ? Infinity : b.last))
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
  return rows;
}

// The winners by checkpoints, or null when nobody has one counted.
function cpWinners(s) {
  if (!cpGame(s)) return null;
  const rows = cpScores(s, s.cp.done).filter((r) => !r.left);
  const top = rows[0];
  if (!top || top.count <= 0) return null;
  const same = rows.filter((r) => r.count === top.count && r.caught === top.caught && r.last === top.last);
  return { winners: ordered(s).filter((p) => same.some((r) => r.pid === p.id)).map((p) => p.id), count: top.count };
}

function cpWinWords(s, ids, count) {
  const names = ids.map((id) => s.players[id].name);
  if (names.length === 1) return `${names[0]} wins with ${cpCountWords(count)}.`;
  const who = names.length > 4 ? `${names.length} hiders` : listNames(names);
  return `${who} win with ${cpCountWords(count)} each.`;
}

// After a strike while over: the winners, MVP and the summary's checkpoint parts again (routes, close calls kept).
function cpRejudge(s) {
  const reason = s.result ? s.result.reason : 'host';
  const cw = cpWinners(s);
  const winners = cw ? cw.winners : winnersOf(s, reason);
  const mvp = cw ? mvpOf(s, 'time', winners) : mvpOf(s, reason, winners);
  s.result = { ...(s.result || { reason }), winners: winners.slice(), mvp };
  // The end line says the winners as they are now: the 'over' event, its play-by-play line and the summary's.
  const text = overText(s, reason, winners, cw);
  let old = null;
  const ev = s.events.find((e) => e.id === s.overEventId && e.kind === 'over');
  if (ev) {
    old = ev.text;
    ev.text = text;
    ev.data = { ...(ev.data || {}), winners: winners.slice() };
  }
  for (let i = s.log.length - 1; i >= 0; i--) {
    if (s.log[i] && s.log[i].kind === 'over') {
      if (old === null) old = s.log[i].text;
      s.log[i] = { ...s.log[i], text };
      break;
    }
  }
  if (s.summary && typeof s.summary === 'object' && Array.isArray(s.summary.events) && old !== null && old !== text) {
    s.summary.events = s.summary.events.map((e) => (e && e.text === old ? { ...e, text } : e));
  }
  if (s.summary && typeof s.summary === 'object') {
    s.summary.winners = winners.slice();
    s.summary.mvp = mvp;
    if (s.summary.checkpoints && typeof s.summary.checkpoints === 'object') {
      s.summary.checkpoints.done = cpDoneRows(s);
      s.summary.checkpoints.scores = cpScores(s, s.cp.done);
    }
    if (Array.isArray(s.summary.players)) {
      for (const row of s.summary.players) {
        if (row && row.startTeam === 'hider') row.checkpoints = cpCountOf(s.cp.done, row.id);
      }
    }
  }
  return winners.slice();
}

function cpDoneRows(s) {
  return s.cp.done.map((d) => ({ n: d.n, k: d.k, pid: d.pid, clock: d.clock, how: d.how, photo: d.photo, struck: !!d.struck }));
}

function cpSlotView(sl) {
  return { k: sl.k, id: sl.id, name: sl.name, task: sl.task, p: [sl.p[0], sl.p[1]], r: sl.r };
}

function cpLobbyView(s, host) {
  const list = Array.isArray(s.checkpoints) ? s.checkpoints : [];
  const plan = cpPlan(s.settings, list.length);
  let problem = checkpointProblem(list, s.ring);
  // (Its words name the checkpoints: only the host knows them.)
  if (problem && !host) problem = 'The host needs to fix the checkpoints.';
  if (!problem && list.length < LIMITS.checkpointsLeast) problem = errorText('no_checkpoints');
  else if (!problem && plan.slots.length < LIMITS.checkpointsLeast) {
    problem = 'The game is too short for 2 checkpoints. Make it longer or set the open time to Auto.';
  }
  return {
    lobby: true,
    count: list.length,
    list: host ? copy(list) : null,
    problem,
    plan: { openMs: plan.openMs, leadMs: plan.leadMs, safeMs: plan.safeMs, fits: plan.slots.length, skipped: plan.skipped },
  };
}

// view.cp for a player (see the contract's "View additions").
function cpViewFor(s, me, { clock, now, positions }) {
  if (!s.settings || s.settings.mode !== 'checkpoints') return null;
  if (s.phase === 'lobby') return cpLobbyView(s, !!me && s.hostId === me.id);
  if (!cpGame(s)) return null;
  const cp = s.cp;
  const live = s.phase === 'live';
  const hider = live && isFree(me);
  const sees = (sl) => cpSeesSlot(s, me, sl, clock);
  const act = live ? cpActive(s, clock) : null;
  const list = cp.plan.filter(sees).map((sl) => ({ ...cpSlotView(sl), state: act && act.k === sl.k ? 'active' : 'closed' }));
  let active = null;
  let waiting = null;
  if (act) {
    if (sees(act)) active = { ...cpSlotView(act), closesIn: act.close - clock, huntersIn: hider ? Math.max(0, act.show - clock) : 0 };
    else waiting = { k: act.k, inMs: act.show - clock };
  }
  let next = null;
  if (live) {
    const opens = (sl) => (hider ? sl.at : sl.show);
    const nx = cp.plan.find((sl) => opens(sl) > clock && (!waiting || sl.k !== waiting.k));
    if (nx) next = { k: nx.k, inMs: opens(nx) - clock };
  }
  let mine = null;
  if (hider && act) {
    const safeMs = cpSafeOf(s);
    const v = cpVisit(s, me.id);
    const on = v && v.k === act.k ? v : null;
    const used = cpUsed(s, me.id, act.k);
    const ongoing = on && !on.exposed ? Math.max(0, clock - on.since) : 0;
    const left = Math.max(0, safeMs - used - ongoing);
    const did = !!cpCounted(s, me.id, act.k);
    mine = {
      k: act.k,
      did,
      inside: cpHere(s, me.id, act, positions, now),
      safeLeft: on && !on.exposed ? left : null,
      exposed: on ? on.exposed : null,
      canPhoto: !!s.settings.cpPhoto && cpPhotoProblem(s, me.id, { k: act.k, now, positions }) === null,
      stay: !s.settings.cpPhoto && on && !on.exposed && !did ? Math.max(0, clock - on.since) : null,
      left,
    };
  }
  const seen = cp.done.filter((d) => cpSeesDone(s, me, d, clock));
  const name = (id) => (playerOf(s, id) ? s.players[id].name : '');
  return {
    lobby: false,
    total: cp.plan.length,
    unopened: cp.unopened,
    openMs: cp.openMs,
    leadMs: cp.leadMs,
    safeMs: cpSafeOf(s),
    photo: !!s.settings.cpPhoto,
    list,
    active,
    waiting,
    next,
    mine,
    done: seen.map((d) => ({ n: d.n, k: d.k, pid: d.pid, name: name(d.pid), clock: d.clock, how: d.how, photo: d.photo, struck: !!d.struck })),
    scores: cpScores(s, seen),
  };
}

// view.cp for a spectator: the game as of the delayed clock T.
function cpWatchFor(s, T) {
  if (!s.settings || s.settings.mode !== 'checkpoints') return null;
  if (s.phase === 'lobby') {
    const lv = cpLobbyView(s, false);
    return { ...lv, problem: '' };
  }
  if (!cpGame(s)) return null;
  const cp = s.cp;
  const live = s.phase === 'live';
  if (!live) {
    const over = cpViewFor(s, null, { clock: T, now: 0, positions: {} });
    return over ? { ...over, mine: null } : null;
  }
  const act = cp.plan.find((a) => a.at <= T && T < a.close) || null;
  const list = cp.plan.filter((sl) => sl.show <= T).map((sl) => ({ ...cpSlotView(sl), state: act && act.k === sl.k ? 'active' : 'closed' }));
  let active = null;
  let waiting = null;
  if (act) {
    if (act.show <= T) active = { ...cpSlotView(act), closesIn: act.close - T, huntersIn: 0 };
    else waiting = { k: act.k, inMs: act.show - T };
  }
  const nx = cp.plan.find((sl) => sl.show > T && (!waiting || sl.k !== waiting.k));
  const seen = cp.done
    .filter((d) => d.clock <= T && cp.plan[d.k] && cp.plan[d.k].show <= T)
    .map((d) => ({ ...d, struck: struckAt(d, T) }));
  const name = (id) => (playerOf(s, id) ? s.players[id].name : '');
  return {
    lobby: false,
    total: cp.plan.length,
    unopened: cp.unopened,
    openMs: cp.openMs,
    leadMs: cp.leadMs,
    safeMs: cpSafeOf(s),
    photo: !!s.settings.cpPhoto,
    list,
    active,
    waiting,
    next: nx ? { k: nx.k, inMs: nx.show - T } : null,
    mine: null,
    done: seen.map((d) => ({ n: d.n, k: d.k, pid: d.pid, name: name(d.pid), clock: d.clock, how: d.how, photo: d.photo, struck: d.struck })),
    scores: cpScores(s, seen, { asOf: T }),
  };
}

// Why this player can't take a checkpoint's photo now (null = they can), in the contract's order.
export function cpPhotoProblem(state, playerId, { k, now, positions } = {}) {
  return cpProblem(state, playerId, { k, now, positions, how: 'photo' });
}

function cpProblem(state, playerId, { k, now, positions, how }) {
  const no = (code, message) => err(code, message).error;
  if (!state || state.phase !== 'live') return no('not_live');
  if (!state.settings || state.settings.mode !== 'checkpoints' || !cpGame(state)) return no('bad_cmd');
  if (state.pausedAt !== null && state.pausedAt !== undefined) return no('paused');
  const clock = clockOf(state, now);
  if (clock >= schedule(state.settings).endMs) return no('cooldown', "Time's up.");
  const p = playerOf(state, playerId);
  if (!isFree(p)) return no('not_your_turn', 'Only hiders who are still free can do checkpoints.');
  const slot = cpActive(state, clock);
  if (!Number.isInteger(k) || !slot || slot.k !== k) return no('cp_closed');
  if (state.cp.done.some((d) => d.pid === p.id && d.k === k && !d.struck)) return no('cp_done');
  if (!cpHere(state, p.id, slot, positions, now)) return no('cp_outside');
  if (how !== 'photo') return state.settings.cpPhoto ? no('bad_cmd') : null;
  const photos = state.cp.photos || { count: 0, lastAt: {} };
  if ((photos.count || 0) >= LIMITS.cpPhotos) return no('cp_full');
  const last = photos.lastAt && Number.isFinite(photos.lastAt[p.id]) ? photos.lastAt[p.id] : null;
  if (last !== null && now - last >= 0 && now - last < TIMING.CP_PHOTO_GAP_MS) return no('cooldown', 'Wait a moment before the next photo.');
  if (!state.settings.cpPhoto) return no('bad_cmd', "This game doesn't need photos.");
  return null;
}

// A checkpoint counts for this player (the handler, after storing the photo). The visit goes on: the rest of
// its safe time still protects them.
export function doCheckpoint(state, playerId, { k, photo, now, positions, how = 'photo', bytes } = {}) {
  if (how !== 'photo' && how !== 'stay') return err('bad_cmd');
  const problem = cpProblem(state, playerId, { k, now, positions, how });
  if (problem) return { error: problem };
  if (how === 'photo' && (typeof photo !== 'string' || !CP_PHOTO_ID.test(photo) || state.cp.done.some((d) => d.photo === photo))) {
    return err('cp_photo');
  }
  const s = fillIn(copy(state));
  const t = { now, clock: clockOf(s, now), at: now };
  const p = s.players[playerId];
  const d = cpRecord(s, p, s.cp.plan[k], how, how === 'photo' ? photo : null, t, bytes);
  const v = cpVisit(s, playerId);
  if (v && v.k === k) v.stayTried = true;
  p.lastSeen = now;
  s.updatedAt = now;
  return { state: s, done: { n: d.n, k: d.k } };
}

// May `who` ({ player: id } or { watcher: id }) see this photo?
export function canSeePhoto(state, who, photoId, now) {
  if (!state || !cpGame(state) || !who || typeof who !== 'object' || typeof photoId !== 'string' || !CP_PHOTO_ID.test(photoId)) return false;
  const d = state.cp.done.find((x) => x.photo === photoId);
  if (!d) return false;
  const live = state.phase === 'live';
  if (!live && state.phase !== 'over') return false;
  if (typeof who.player === 'string') {
    const p = playerOf(state, who.player);
    if (!p || p.status === 'kicked') return false;
    if (!live) return true;
    if (isDriver(state, p)) return false;   // (v1.4: never the driver while live)
    return active(p) && cpSeesDone(state, p, d, clockOf(state, now));
  }
  if (typeof who.watcher === 'string') {
    if (!has(watchersOf(state), who.watcher)) return false;
    if (!live) return true;
    const T = watchClock(state, now);
    const slot = state.cp.plan[d.k];
    return d.clock <= T && !!slot && slot.show <= T;
  }
  return false;
}

// summary.checkpoints (Checkpoints mode only).
function cpSummaryOf(s, tracks) {
  if (!cpGame(s)) return null;
  return {
    plan: copy(s.cp.plan),
    unopened: s.cp.unopened,
    done: cpDoneRows(s),
    scores: cpScores(s, s.cp.done),
    closeCalls: cpCloseCalls(s, tracks),
  };
}

function cpCloseCalls(s, tracks) {
  const calls = [];
  const name = (id) => (playerOf(s, id) ? s.players[id].name : 'Someone');
  const plan = s.cp.plan;
  const driverId = driverIdOf(s);
  const seenSafe = new Set();
  for (const e of s.log) {
    if (e.kind === 'cp-safe') {
      const key = `${e.hunter}|${e.hider}|${e.k}`;
      if (seenSafe.has(key)) continue;
      seenSafe.add(key);
      calls.push({
        kind: 'cpsafe', clock: e.clock, ids: [e.hider, e.hunter], score: -1,
        text: `${name(e.hunter)} reached ${name(e.hider)} at checkpoint ${e.k + 1}, but ${name(e.hider)} was in the safe zone.`,
      });
    } else if (e.kind === 'cp-left') {
      calls.push({
        kind: 'cpspare', clock: e.clock, ids: [e.id], ms: e.spare, score: e.spare / CP_SPARE_MS,
        text: `${name(e.id)} left checkpoint ${e.k + 1} with ${seconds(e.spare)} s of safe time left.`,
      });
    }
  }
  const players = ordered(s).filter((p) => p.startTeam && p.status !== 'kicked');
  for (const d of s.cp.done) {
    if (d.struck || !plan[d.k]) continue;
    let best = null;
    for (const h of players) {
      if (h.id === d.pid || h.id === driverId || sideAt(h, d.clock) !== 'hunter') continue;
      const ht = tracks[h.id];
      if (!ht) continue;
      for (let j = firstFrom(ht, d.clock - CP_NEAR_WINDOW_MS); j < ht.length && ht[j].clock <= d.clock + CP_NEAR_WINDOW_MS; j++) {
        const m = distanceM(plan[d.k].p, ht[j].p);
        if (m <= TIMING.CP_NEAR_CALL_M && (!best || m < best.m)) best = { m, h };
      }
    }
    if (best) {
      const metres = Math.max(1, Math.round(best.m));
      calls.push({
        kind: 'cpnear', clock: d.clock, ids: [d.pid, best.h.id], m: metres, score: best.m / TIMING.CP_NEAR_CALL_M,
        text: `${name(d.pid)} did checkpoint ${d.k + 1} with ${best.h.name} ${metres} m away.`,
      });
    }
  }
  calls.sort((a, b) => (a.score - b.score) || (a.clock - b.clock));
  return withGaps(calls.slice(0, CLOSE_CALLS_KEPT).map(({ score, ...rest }) => rest), tracks);
}

// ---------------------------------------------------------------------------------------------------------
// summarize: the end screen (scoreboard, close calls, routes, play-by-play)

// Which side a player was on at a clock: 'hunter', 'hider' (free) or null (not playing then).
function sideAt(p, clock) {
  if (!p.startTeam || p.status === 'kicked') return null;
  if (p.leftAt !== null && p.leftAt !== undefined && clock > p.leftAt) return null;
  if (p.startTeam === 'hunter') return 'hunter';
  if (p.turnedAt !== null && p.turnedAt !== undefined && clock >= p.turnedAt) return 'hunter';
  if (p.caughtAt !== null && p.caughtAt !== undefined && clock >= p.caughtAt) return null;
  return 'hider';
}

function trackPoints(s, trails, endClock) {
  const out = {};
  if (!Array.isArray(trails)) return out;
  for (const tp of trails) {
    if (!tp || typeof tp !== 'object') continue;
    const p = playerOf(s, tp.pid);
    if (!p || !p.startTeam || p.status === 'kicked') continue;
    if (!isPoint(tp.p) || !Number.isFinite(tp.clock) || tp.clock < 0 || tp.clock > endClock) continue;
    if (p.leftAt !== null && p.leftAt !== undefined && tp.clock > p.leftAt) continue;
    if (!out[p.id]) out[p.id] = [];
    out[p.id].push({ p: [tp.p[0], tp.p[1]], clock: tp.clock });
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => a.clock - b.clock);
  return out;
}

// Index of the first point at or after clock (points sorted by clock).
function firstFrom(points, clock) {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].clock < clock) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function closestInTime(points, clock, within) {
  if (!points || !points.length) return null;
  const i = firstFrom(points, clock);
  let best = null;
  for (const j of [i - 1, i]) {
    const pt = points[j];
    if (!pt || Math.abs(pt.clock - clock) > within) continue;
    if (!best || Math.abs(pt.clock - clock) < Math.abs(best.clock - clock)) best = pt;
  }
  return best;
}

function closeCallsOf(s, tracks, sch) {
  const calls = [];
  const players = ordered(s).filter((p) => p.startTeam && p.status !== 'kicked');
  const name = (id) => (playerOf(s, id) ? s.players[id].name : 'Someone');
  const done = s.catches.filter((c) => c.state === 'done');
  const driverId = driverIdOf(s);

  // A hunter within CLOSE_CALL_M of a free hider, and no catch of that hider in the next minute.
  const pairs = new Map();
  for (const d of players) {
    if (d.startTeam !== 'hider') continue;
    for (const pt of tracks[d.id] || []) {
      if (pt.clock < sch.headStartMs || sideAt(d, pt.clock) !== 'hider') continue;
      if (done.some((c) => c.hider === d.id && c.at >= pt.clock && c.at <= pt.clock + GOT_AWAY_MS)) continue;
      for (const h of players) {
        if (h.id === d.id || h.id === driverId || sideAt(h, pt.clock) !== 'hunter') continue;
        const ht = tracks[h.id];
        if (!ht) continue;
        for (let j = firstFrom(ht, pt.clock - NEAR_WINDOW_MS); j < ht.length && ht[j].clock <= pt.clock + NEAR_WINDOW_MS; j++) {
          const m = distanceM(pt.p, ht[j].p);
          if (m > TIMING.CLOSE_CALL_M) continue;
          const key = `${d.id}|${h.id}`;
          const was = pairs.get(key);
          if (!was || m < was.m) pairs.set(key, { m, clock: pt.clock, d, h });
        }
      }
    }
  }
  for (const { m, clock, d, h } of pairs.values()) {
    const metres = Math.max(1, Math.round(m));
    calls.push({
      kind: 'near', clock, ids: [d.id, h.id], m: metres, score: m / TIMING.CLOSE_CALL_M,
      text: `${d.name} and ${h.name} were ${metres} m apart and ${d.name} got away.`,
    });
  }

  // A Jammer that went on just before a Radar went live (and hid them from it).
  for (const rl of s.log) {
    if (rl.kind !== 'radar-live') continue;
    for (const id of rl.blocked || []) {
      let jam = null;
      for (const e of s.log) {
        if (e.kind === 'power' && e.power === 'jammer' && e.by === id && e.clock <= rl.clock) jam = e;
      }
      if (!jam) continue;
      const gap = rl.clock - jam.clock;
      if (gap > SPARE_MS) continue;
      calls.push({
        kind: 'jammer', clock: rl.clock, ids: [id], ms: gap, score: gap / SPARE_MS,
        text: gap < 1000 ? `${name(id)}'s Jammer went on just as Radar went live.`
          : `${name(id)}'s Jammer went on ${seconds(gap)} s before Radar went live.`,
      });
    }
  }

  // Back in the ring with seconds to spare.
  for (const e of s.log) {
    if (e.kind !== 'back-in') continue;
    calls.push({
      kind: 'ring', clock: e.clock, ids: [e.id], ms: e.spare, score: e.spare / SPARE_MS,
      text: e.seen ? `${name(e.id)} got back in the ring ${seconds(e.spare)} s before being caught.`
        : `${name(e.id)} got back in the ring with ${seconds(e.spare)} s to spare.`,
    });
  }

  // A winning hider with a hunter close by at the last ping.
  const last = s.pings[s.pings.length - 1];
  const winners = s.result ? s.result.winners : [];
  if (last) {
    for (const id of winners) {
      const w = playerOf(s, id);
      if (!w || w.startTeam !== 'hider' || w.team !== 'hider') continue;
      const wp = closestInTime(tracks[id], last.clock, NEAR_WINDOW_MS);
      if (!wp) continue;
      let best = null;
      for (const h of players) {
        if (h.id === id || sideAt(h, last.clock) !== 'hunter') continue;
        const hp = closestInTime(tracks[h.id], last.clock, NEAR_WINDOW_MS);
        if (!hp) continue;
        const m = distanceM(wp.p, hp.p);
        if (!best || m < best.m) best = { m, h };
      }
      if (best && best.m <= LAST_PING_M) {
        const metres = Math.max(1, Math.round(best.m));
        calls.push({
          kind: 'lastPing', clock: last.clock, ids: [id, best.h.id], m: metres, score: best.m / LAST_PING_M,
          text: `${w.name} won with ${best.h.name} only ${metres} m away at the last ping.`,
        });
      }
    }
  }

  calls.sort((a, b) => (a.score - b.score) || (a.clock - b.clock));
  return withGaps(calls.slice(0, CLOSE_CALLS_KEPT).map(({ score, ...rest }) => rest), tracks);
}

function thin(points, most) {
  if (points.length <= most) return points;
  const out = [];
  for (let k = 0; k < most; k++) out.push(points[Math.round((k * (points.length - 1)) / (most - 1))]);
  return out;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function summarize(state, trails = []) {
  const s = state;
  const sch = schedule(s.settings);
  const endClock = Number.isFinite(s.endClock) ? s.endClock : clockOf(s, s.updatedAt);
  const result = s.result || { reason: null, winners: [], mvp: null };
  const tracks = trackPoints(s, trails, endClock);
  const driverId = driverIdOf(s);
  const players = ordered(s).filter((p) => p.startTeam && p.status !== 'kicked').map((p) => {
    let survivedMs = null;
    if (p.startTeam === 'hider') {
      const until = p.caughtAt !== null && p.caughtAt !== undefined ? p.caughtAt
        : p.leftAt !== null && p.leftAt !== undefined ? p.leftAt : endClock;
      survivedMs = Math.max(0, until - sch.headStartMs);
    }
    // The same number the MVP is picked by: only clear moves on good fixes. A phone that never gave a fix
    // good enough to count (worse than 50 m all game) has none (null), never its jittery route length.
    const walked = p.track || p.stats.distanceM > 0 ? p.stats.distanceM : null;
    const row = {
      id: p.id,
      name: p.name,
      startTeam: p.startTeam,
      team: p.team,
      status: p.status,
      caughtBy: p.caughtBy,
      caughtAt: p.caughtAt,
      survivedMs,
      catches: p.stats.catches,
      distanceM: walked === null ? null : Math.round(walked),
      powers: p.stats.powers.slice(),
    };
    if (p.id === driverId) {
      row.driver = true;
      row.drivenM = Math.round(p.stats.drivenM || 0);
      row.pickups = p.stats.pickups || 0;
    }
    if (cpGame(s) && p.startTeam === 'hider') row.checkpoints = cpCountOf(s.cp.done, p.id);
    return row;
  });
  const driverRow = players.find((x) => x.driver) || null;
  const radioSaved = !!extrasOf(s.settings).radioSave;
  const clips = radioOf(s).clips.slice()
    .sort((a, b) => (a.clock - b.clock) || (a.n - b.n))
    .map((c) => {
      const out = { n: c.n, from: c.from, clock: c.clock, ms: c.ms, type: c.type, side: sideOfClip(c) };
      if (out.side === 'wiretap') { out.tap = c.tap; out.of = c.of; }
      return out;
    });
  const routes = {};
  for (const [id, points] of Object.entries(tracks)) {
    routes[id] = thin(points, ROUTE_MOST).map((x) => [r6(x.p[0]), r6(x.p[1]), Math.round(x.clock / 1000)]);
  }
  return {
    winners: result.winners.slice(),
    reason: result.reason,
    mvp: result.mvp,
    players,
    closeCalls: closeCallsOf(s, tracks, sch),
    routes,
    events: s.log.filter((e) => e.text).map((e) => ({ clock: e.clock, text: e.text })),
    driver: driverRow ? { id: driverRow.id, drivenM: driverRow.drivenM, pickups: driverRow.pickups } : null,
    radioSaved: radioSaved,
    radio: radioSaved && clips.length ? clips : null,
    cam: camSummaryOf(s),
    checkpoints: cpSummaryOf(s, tracks),
    // v1.4
    endClock,
    startAt: s.startedAt,
    mode: s.settings ? s.settings.mode : null,
    ...v14SummaryOf(s, radioSaved),
  };
}

// v1.2: every moment kept, by clock; a near call's hunter merged into its ids (for the director).
function camSummaryOf(s) {
  const c = s.cam;
  if (!c || !Array.isArray(c.ids)) return null;
  const moments = (c.moments || []).slice()
    .sort((a, b) => (a.clock - b.clock) || (a.n - b.n))
    .map((m) => {
      const out = { clock: m.clock, kind: m.kind, ids: [...new Set([...(m.ids || []), ...(m.with || [])])] };
      if (Number.isFinite(m.ms)) out.ms = m.ms;
      return out;
    });
  return { mode: c.mode, filmed: c.ids.slice(), moments };
}

// ---------------------------------------------------------------------------------------------------------
// v1.2: clips from the highlight cam (checked before an upload is allowed; the page runs it too)

const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const CAM_SLACK_MS = 5000;
const CAM_KINDS_MOST = 12;

function camProblem(code) {
  return { code, message: errorText(code) };
}

// Why this clip can't be uploaded by this player (null = it can). See "Clip metadata" in the contract.
export function camClipProblem(state, playerId, clip, { now } = {}) {
  if (!state || state.phase !== 'over') return camProblem('not_over');
  const c = state.cam;
  if (!c || !Array.isArray(c.ids)) return camProblem('no_cam');
  if (typeof playerId !== 'string' || !c.ids.includes(playerId)) return camProblem('not_recorded');
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) return camProblem('bad_video');
  if (clip.round !== state.startedAt) return camProblem('old_round');
  const bad = camProblem('bad_video');
  if (typeof clip.id !== 'string' || !/^[0-9a-f]{16}$/.test(clip.id)) return bad;
  if (!VIDEO_TYPES.includes(typeBase(clip.type))) return bad;
  if (!Number.isInteger(clip.bytes) || clip.bytes < 1 || clip.bytes > LIMITS.camClipBytes) return bad;
  const msMost = c.mode === 'everything'
    ? TIMING.CAM_PIECE_MS + TIMING.CAM_PIECE_OVERLAP_MS + CAM_SLACK_MS
    : TIMING.CAM_CLIP_MOST_MS + CAM_SLACK_MS;
  if (!Number.isInteger(clip.ms) || clip.ms < 1000 || clip.ms > msMost) return bad;
  const endMost = (Number.isFinite(state.endClock) ? state.endClock : clockOf(state, now)) + TIMING.CAM_POST_MS + CAM_SLACK_MS;
  const { start, end } = clip;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > endMost) return bad;
  const kinds = clip.kinds;
  if (!Array.isArray(kinds) || kinds.length < 1 || kinds.length > CAM_KINDS_MOST) return bad;
  if (!kinds.every((k) => typeof k === 'string' && (k === 'piece' || CAM_KINDS.includes(k)))) return bad;
  const want = Math.ceil(clip.ms / 1000);
  const sized = (list) => Array.isArray(list) && list.length >= Math.max(1, want - 2) && list.length <= want + 2;
  if (!sized(clip.clocks) || !sized(clip.loud) || !sized(clip.bright)) return bad;
  let before = 0;
  for (const x of clip.clocks) {
    if (!Number.isInteger(x) || x < before || x > endMost) return bad;
    before = x;
  }
  const pct = (x) => Number.isInteger(x) && x >= 0 && x <= 100;
  if (!clip.loud.every(pct) || !clip.bright.every(pct)) return bad;
  // v1.4: the game clock at the file's first frame, and the loudness per 250 ms (both optional).
  if (clip.t0 !== undefined && (!Number.isInteger(clip.t0) || clip.t0 < start - 2000 || clip.t0 > start + 2000)) return bad;
  if (clip.loudQ !== undefined) {
    const q = Math.ceil(clip.ms / 250);
    if (!Array.isArray(clip.loudQ) || clip.loudQ.length < Math.max(1, q - 4) || clip.loudQ.length > q + 4 || !clip.loudQ.every(pct)) return bad;
  }
  return null;
}

// A filmed player's phone says what it holds (after the game): { count, bytes }, for the end screen's "of N".
export function noteCamHave(state, playerId, { count, bytes, now } = {}) {
  if (!state || state.phase !== 'over' || !state.cam || !Array.isArray(state.cam.ids)) return { state, changed: false };
  if (typeof playerId !== 'string' || !state.cam.ids.includes(playerId)) return { state, changed: false };
  if (!Number.isInteger(count) || count < 0 || count > 1000) return { state, changed: false };
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 2e9) return { state, changed: false };
  const was = state.cam.have && has(state.cam.have, playerId) ? state.cam.have[playerId] : null;
  if (was && was.count === count && was.bytes === bytes) return { state, changed: false };
  const s = fillIn(copy(state));
  s.cam.have[playerId] = { count, bytes, at: Number.isFinite(now) ? now : null };
  if (Number.isFinite(now)) s.updatedAt = now;
  return { state: s, changed: true };
}

// ---------------------------------------------------------------------------------------------------------
// v1.4: Hacker, Wiretap, team pins, phones' health (see the contract's "v1.4: from the first real game")

const HACKS_KEPT = 20;
const TAPS_KEPT = 20;
const PIN_RING_M = 2000;        // a pin (or a pinned pickup) at most this far outside the ring's edge
const TRACK_BEFORE_MS = 60000;  // a close call's track: this long before its closest moment...
const TRACK_AFTER_MS = 20000;   // ...to this long after
const TRACK_MOST = 60;          // points per player in a track
const GAP_LOOK_MS = 30000;      // the closest moment is looked for this far either side of the call
const GAP_STEP_MS = 60000;      // two route points further apart than this aren't joined up
const HEALTH_WORDS = Object.freeze({
  loc: ['ok', 'stale', 'asking', 'denied', 'off', 'timeout', 'none'],
  cam: ['ok', 'off', 'denied', 'none', 'na'],
  mic: ['ok', 'off', 'denied', 'none', 'silent', 'na'],
  snd: ['ok', 'locked', 'na'],
  dev: ['ios-safari', 'ios-app', 'ios-chrome', 'ios-other', 'android-chrome', 'android-other', 'other'],
});
const LOST_WHY = ['denied', 'off', 'timeout', 'stale', 'none'];
const PIN_TEXT = { seen: 'hider seen here', go: 'go here', driver: 'driver, go here' };

// Start (`starting`) or Play again: this round's Hacker, Wiretap and pins begin afresh. (tapOk and health stay.)
function freshV14(s, starting) {
  const powers = extrasOf(s.settings).powers;
  for (const k of ['hacker', 'wiretap']) {
    if (starting && powers[k]) s.team[k] = 'ready';
    else delete s.team[k];
  }
  delete s.team.tapGivenBack;
  s.hacks = [];
  s.taps = [];
  s.nextTapId = 1;
  s.pins = [];
  s.nextPinId = 1;
}

const tapOpen = (tap) => !!tap && (tap.state === 'asked' || tap.state === 'listening');
const pinLive = (pin, clock) => !!pin && pin.gone === null && clock < pin.until;

// A tap ends: 'done' (something was heard) or 'empty' (nothing came: the power is given back when `giveBack`).
function finishTap(s, tap, t, { giveBack = true, tell = true } = {}) {
  if (!tapOpen(tap)) return;
  const target = playerOf(s, tap.target);
  const tname = target ? target.name : 'the hider';
  if (tap.pieces > 0) {
    tap.state = 'done';
    tap.endAt = t.clock;
    if (tell) {
      emit(s, t, 'tap', tap.target, 'Someone listened in.', { tap: tap.id, state: 'done' });
      note(s, { kind: 'tap-done', clock: t.clock, id: tap.target, text: `Someone listened in on ${tname}.` });
    }
    return;
  }
  tap.state = 'empty';
  tap.endAt = t.clock;
  // Given back once a round at most: after that an empty tap keeps the power used and the spacing.
  if (giveBack && s.phase === 'live' && s.team.wiretap === 'used' && s.team.tapGivenBack !== true) {
    s.team.wiretap = 'ready';
    s.team.tapGivenBack = true;
    if (s.team.lastPowerAt === tap.at) s.team.lastPowerAt = Number.isFinite(tap.before) ? tap.before : null;
    const by = playerOf(s, tap.by);
    if (by && Array.isArray(by.stats.powers)) {
      const i = by.stats.powers.lastIndexOf(POWERS.wiretap.name);
      if (i >= 0) by.stats.powers.splice(i, 1);
    }
    if (tell) {
      emit(s, t, 'tap', 'hunters', `Nothing came from ${tname}'s phone, so Wiretap is ready again.`, { tap: tap.id, state: 'empty' });
    }
  }
}

// Pins and taps that hang on someone (`who(id)` true) end; at the game's end every one (no news then).
function endPinsAndTaps(s, t, who, why = 'ended') {
  for (const pin of s.pins || []) {
    if (pin.gone === null && who(pin.by)) { pin.gone = why; pin.goneAt = Math.min(t.clock, pin.until); }
  }
  const ending = why === 'ended' && s.phase !== 'live';
  for (const tap of s.taps || []) {
    if (tapOpen(tap) && (who(tap.by) || who(tap.target))) finishTap(s, tap, t, { giveBack: !ending, tell: !ending });
  }
}

// Hacker and Wiretap: the usual hunter power checks are done; now the hider they picked.
function targetedPower(s, actor, cmd, t, power) {
  const target = playerOf(s, cmd.target);
  if (!isFree(target)) return err('bad_target', 'Pick a hider who is still free.');
  const name = POWERS[power].name;
  const blocked = target.powers.jammer === 'on';
  if (power === 'wiretap') {
    if (target.tapOk !== true) return err('no_consent', `${target.name} didn't say OK to Wiretap.`);
    if ((s.taps || []).some(tapOpen)) return err('one_at_a_time');
  }
  const before = s.team.lastPowerAt;
  s.team[power] = 'used';
  s.team.lastPowerAt = t.clock;
  actor.stats.powers.push(name);
  if (power === 'hacker') {
    const n = (s.hacks || []).reduce((m, h) => Math.max(m, h.n || 0), 0) + 1;
    s.hacks.push({ n, by: actor.id, target: target.id, at: t.clock, blocked });
    if (s.hacks.length > HACKS_KEPT) s.hacks.splice(0, s.hacks.length - HACKS_KEPT);
    const text = blocked ? `${actor.name} used Hacker on ${target.name}, but it was blocked.`
      : `${actor.name} used Hacker on ${target.name}. Hacker was sent to ${target.name}'s phone.`;
    emit(s, t, 'power', 'hunters', text, { power, by: actor.id, target: target.id, blocked });
    emit(s, t, 'power', 'hiders', 'The hunters used Hacker.', { power });
    if (blocked) emit(s, t, 'power', target.id, 'Your Jammer blocked the hunters\' Hacker.', { power, blocked: true });
    else emit(s, t, 'hacked', target.id, 'HACKED! The hunters set off your alarm.', { ms: TIMING.HACK_MS, n });
    note(s, { kind: 'power', power, by: actor.id, target: target.id, blocked, clock: t.clock, text });
    addMoment(s, t, 'hack', [target.id], { with: [actor.id], data: { blocked } });
    return null;
  }
  const tap = {
    id: `t${s.nextTapId++}`, by: actor.id, target: target.id, at: t.clock, state: blocked ? 'blocked' : 'asked',
    pieces: 0, firstAt: null, lastAt: null, got: [], before,
  };
  s.taps.push(tap);
  if (s.taps.length > TAPS_KEPT) s.taps.splice(0, s.taps.length - TAPS_KEPT);
  const text = blocked ? `${actor.name} tried Wiretap on ${target.name}, but it was blocked.`
    : `${actor.name} is listening in on ${target.name}.`;
  emit(s, t, 'power', 'hunters', text, { power, by: actor.id, target: target.id, tap: tap.id, blocked });
  emit(s, t, 'power', 'hiders', 'The hunters used Wiretap.', { power });
  if (blocked) emit(s, t, 'power', target.id, 'Your Jammer blocked the hunters\' Wiretap.', { power, blocked: true });
  else emit(s, t, 'tap', target.id, 'Your microphone is on for the hunters for 15 seconds.', { tap: tap.id, ms: TIMING.TAP_MS });
  note(s, { kind: 'power', power, by: actor.id, target: target.id, blocked, clock: t.clock, text });
  if (!blocked) addMoment(s, t, 'tap', [target.id]);
  return null;
}

// A pin's (or a pinned pickup's) point: a real point at most PIN_RING_M outside the ring as it is now.
function pinSpotOk(s, p, clock) {
  if (!isPoint(p) || !s.ring) return false;
  const by = outsideByM(ringAt(s, clock), [Number(p[0]), Number(p[1])]);
  return Number.isFinite(by) && by <= PIN_RING_M;
}

function cmdTapok(s, actor, cmd, t) {
  if (typeof cmd.ok !== 'boolean') return err('bad_cmd');
  if (!extrasOf(s.settings).powers.wiretap) return err('no_wiretap');
  if (s.phase === 'live' && cmd.ok === true && actor.tapOk !== true) return err('not_lobby');
  actor.tapOk = cmd.ok;
  // Taken back mid-round: a tap on them ends at once (what came stays; nothing more is recorded).
  if (!cmd.ok && s.phase === 'live') {
    for (const tap of s.taps || []) if (tapOpen(tap) && tap.target === actor.id) finishTap(s, tap, t, { giveBack: false });
  }
  return null;
}

function cmdPin(s, actor, cmd, t) {
  if (!isHunter(actor)) return err('not_your_turn', 'Only hunters can drop pins.');
  if (!extrasOf(s.settings).pins) return err('no_pins');
  if (cmd.do === 'remove') {
    const pin = typeof cmd.pinId === 'string' ? s.pins.find((x) => x.id === cmd.pinId) : null;
    if (!pin || !pinLive(pin, t.clock)) return err('bad_target', 'That pin is gone.');
    if (pin.by !== actor.id && s.hostId !== actor.id) return err('not_your_turn', 'Only the one who dropped it can remove it.');
    pin.gone = 'removed';
    pin.goneAt = t.clock;
    return null;
  }
  if (cmd.do !== 'add') return err('bad_cmd');
  if (s.pausedAt !== null) return err('paused');
  if (!PIN_KINDS.includes(cmd.kind)) return err('bad_cmd');
  if (cmd.kind === 'driver') {
    if (!driverOf(s)) return err('no_driver', 'Nobody is driving.');
    if (isDriver(s, actor)) return err('bad_cmd');
  }
  if (!pinSpotOk(s, cmd.p, t.clock)) return err('bad_target', "That's too far from the ring.");
  const pinNote = cmd.note === undefined || cmd.note === null ? '' : typeof cmd.note === 'string' ? cleanLine(cmd.note, LIMITS.pinNote) : null;
  if (pinNote === null) return err('bad_cmd');
  if (s.pins.filter((x) => x.by === actor.id && pinLive(x, t.clock)).length >= LIMITS.pinsEach) {
    return err('pins_full', `You have ${LIMITS.pinsEach} pins. Remove one first.`);
  }
  if (s.pins.length >= LIMITS.pinsRound) return err('pins_full', 'No more pins this round.');
  const pin = {
    id: `p${s.nextPinId++}`, by: actor.id, kind: cmd.kind, p: [Number(cmd.p[0]), Number(cmd.p[1])], note: pinNote,
    at: t.clock, until: t.clock + TIMING.PIN_MS, gone: null, goneAt: null,
  };
  s.pins.push(pin);
  const text = `${actor.name}: ${PIN_TEXT[pin.kind]}.${pinNote ? ` Note: ${pinNote}` : ''}`;
  emit(s, t, 'pin', 'hunters', text, { pinId: pin.id, by: actor.id, kind: pin.kind });
  return null;
}

// When a pin runs out or a tap has to end (game clock).
function tapDeadline(tap) {
  if (tap.state === 'asked' && tap.pieces === 0) return tap.at + TIMING.TAP_START_MS;
  const late = tap.at + TIMING.TAP_END_MS;
  // (The first piece arrives one piece after the recording began, and the last one a piece later: the slack
  // keeps a slow upload of the last piece from being refused.)
  const first = Number.isFinite(tap.firstAt) ? tap.firstAt : tap.at;
  return Math.min(late, first + TIMING.TAP_MS + TIMING.TAP_PIECE_MS);
}

function v14Due(s, offer) {
  for (const pin of s.pins || []) if (pin.gone === null) offer(pin.until, 10, { type: 'pinEnd', pin: pin.id });
  for (const tap of s.taps || []) if (tapOpen(tap)) offer(tapDeadline(tap), 10.5, { type: 'tapEnd', tap: tap.id });
}

function v14RunDue(s, item, t) {
  if (item.type === 'pinEnd') {
    const pin = s.pins.find((x) => x.id === item.pin);
    if (pin && pin.gone === null) { pin.gone = 'expired'; pin.goneAt = pin.until; }
    return;
  }
  const tap = s.taps.find((x) => x.id === item.tap);
  if (tap) finishTap(s, tap, t);
}

// Why this Wiretap piece can't be taken from this player now (null = it can). See "How the hider's phone is
// told to record" in the contract.
export function tapPieceProblem(state, playerId, { tap, i, ms, type, bytes, now } = {}) {
  const no = (code, message) => err(code, message).error;
  if (!state || state.phase !== 'live') return no('not_live');
  const p = playerOf(state, playerId);
  if (!p || !active(p) || !isFree(p)) return no('gone');
  const tp = typeof tap === 'string' && Array.isArray(state.taps) ? state.taps.find((x) => x.id === tap) : null;
  if (!tp || tp.target !== p.id || !tapOpen(tp)) return no('not_tapped');
  if (state.pausedAt !== null && state.pausedAt !== undefined) return no('tap_over');
  const clock = clockOf(state, now);
  if (clock > tp.at + TIMING.TAP_END_MS || clock > tapDeadline(tp)) return no('tap_over');
  const got = Array.isArray(tp.got) ? tp.got : [];
  if (!Number.isInteger(i) || i < 0 || i >= LIMITS.tapPieces || got.includes(i) || tp.pieces >= LIMITS.tapPieces) return no('tap_over');
  if (!RADIO_TYPES.includes(typeBase(type))) return no('bad_audio');
  if (!Number.isInteger(ms) || ms < RADIO_MS_MIN || ms > TIMING.TAP_PIECE_MS + 1500) return no('bad_audio');
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > LIMITS.tapBytes) return no('bad_audio');
  const r = radioOf(state);
  const tapClips = r.clips.filter((c) => c.side === 'wiretap').length;
  if (tapClips >= LIMITS.tapClips || (r.tapBytes || 0) + bytes > LIMITS.tapGameBytes) return no('radio_full');
  return null;
}

// A Wiretap piece arrived: a radio clip on the 'wiretap' side, heard live by the hunters only.
export function addTapPiece(state, playerId, { tap, i, id, ms, type, bytes, now } = {}) {
  const problem = tapPieceProblem(state, playerId, { tap, i, ms, type, bytes, now });
  if (problem) return { error: problem };
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return err('bad_cmd');
  if (radioOf(state).clips.some((c) => c.id === id)) return err('bad_cmd');
  const s = fillIn(copy(state));
  const t = { now, clock: clockOf(s, now), at: now };
  const tp = s.taps.find((x) => x.id === tap);
  if (!Array.isArray(tp.got)) tp.got = [];
  const clip = {
    n: s.radio.next++, id, from: playerId, clock: Math.max(tp.at, t.clock - ms), ms, type: typeBase(type),
    side: 'wiretap', tap: tp.id, of: tp.target,
  };
  s.radio.clips.push(clip);
  s.radio.tapBytes = (Number.isFinite(s.radio.tapBytes) ? s.radio.tapBytes : 0) + bytes; // its own cap, not the walkie's
  tp.got.push(i);
  tp.pieces += 1;
  if (tp.firstAt === null) tp.firstAt = t.clock;
  tp.lastAt = t.clock;
  if (tp.state === 'asked') tp.state = 'listening';
  if (tp.pieces >= LIMITS.tapPieces) finishTap(s, tp, t);
  s.players[playerId].lastSeen = now;
  s.updatedAt = now;
  return { state: s, clip: { ...clip } };
}

// A phone said how its location, camera, microphone and sound are (Ready check). Unknown values are dropped.
// Changed only when something differs or HEALTH_EVERY_MS went by (one save a minute at most for a steady phone).
export function noteHealth(state, playerId, health, { now } = {}) {
  const p0 = state && state.players ? playerOf(state, playerId) : null;
  if (!p0 || !active(p0) || !health || typeof health !== 'object' || Array.isArray(health) || !Number.isFinite(now)) {
    return { state, changed: false };
  }
  const h = {};
  for (const [k, list] of Object.entries(HEALTH_WORDS)) h[k] = list.includes(health[k]) ? health[k] : null;
  const acc = health.acc;
  h.acc = typeof acc === 'number' && Number.isFinite(acc) && acc >= 0 && acc <= 100000 ? Math.round(acc) : null;
  const was = p0.health && typeof p0.health === 'object' ? p0.health : null;
  // (accuracy counts as changed only when it moves to another band: GPS accuracy shifts on most fixes)
  const same = was && Object.keys(h).every((k) => (k === 'acc' ? accBand(was.acc) === accBand(h.acc) : was[k] === h[k]));
  if (same && Number.isFinite(was.at) && now - was.at >= 0 && now - was.at < TIMING.HEALTH_EVERY_MS) {
    return { state, changed: false };
  }
  const s = fillIn(copy(state));
  s.players[playerId].health = { ...h, at: now };
  return { state: s, changed: true };
}

function accBand(a) {
  if (!Number.isFinite(a)) return -1;
  return a <= 10 ? 0 : a <= 30 ? 1 : a <= 100 ? 2 : 3;
}

// How old a player's stored fix is, in words (view.me.fix). No fix this round: 'none'.
function fixOf(s, pos, now) {
  if (!pos || !Number.isFinite(pos.at) || (Number.isFinite(s.startedAt) && pos.at < s.startedAt)) {
    return { age: null, acc: null, state: 'none' };
  }
  const age = Math.max(0, now - pos.at);
  const acc = Number.isFinite(pos.acc) ? Math.round(pos.acc) : null;
  const state = age <= TIMING.FIX_LIVE_MS ? 'live' : age <= TIMING.FIX_LOST_MS ? 'old' : 'lost';
  return { age, acc, state };
}

// Why this player has no fresh location right now, or null (they have one).
function lostWhy(s, p, positions, now) {
  const fix = fixOf(s, posOf(positions, p.id), now);
  const said = p.health && typeof p.health === 'object' ? p.health.loc : null;
  const off = said === 'denied' || said === 'off';
  if (!off && (fix.state === 'live' || fix.state === 'old')) return null;
  return LOST_WHY.includes(said) ? said : 'quiet';
}

function lostRow(s, p, why, positions, now) {
  const pos = posOf(positions, p.id);
  const since = pos && Number.isFinite(pos.at) && pos.at >= s.startedAt ? now - pos.at : now - s.startedAt;
  return { id: p.id, name: p.name, why, since: Math.max(0, since) };
}

// view.locLost: who has no fresh location, as `me` may know (see the contract).
function locLostFor(s, me, { clock, now, positions, sch }) {
  if (!me || me.status !== 'in' || (me.team !== 'hunter' && me.team !== 'hider')) return [];
  const out = [];
  const mine = (p) => p.status === 'in' && p.team === me.team;
  const driving = isDriver(s, me);
  const host = s.hostId === me.id && !driving;
  for (const p of ordered(s)) {
    if (p.id === me.id || p.status !== 'in' || (p.team !== 'hunter' && p.team !== 'hider')) continue;
    const why = lostWhy(s, p, positions, now);
    if (!why) continue;
    if (mine(p)) { out.push(lostRow(s, p, why, positions, now)); continue; }
    if (!host) continue;
    // The other team, for the host: only once the no-signal rule would name them (OFFLINE_SHOW_MS of game time).
    const pos = posOf(positions, p.id);
    const quiet = pos ? quietFor(s, pos, clock, now) >= TIMING.OFFLINE_SHOW_MS
      : clock >= sch.headStartMs + TIMING.OFFLINE_SHOW_MS;
    if (quiet || p.noFixTold === true) out.push(lostRow(s, p, why, positions, now));
  }
  return out;
}

function readyRow(s, p, now) {
  const h = p.health && typeof p.health === 'object' ? p.health : {};
  const pick = (k) => (h[k] === undefined ? null : h[k]);
  return {
    id: p.id, name: p.name, loc: pick('loc'), acc: pick('acc'), cam: pick('cam'), mic: pick('mic'), snd: pick('snd'),
    dev: pick('dev'), seen: Number.isFinite(p.lastSeen) ? Math.max(0, now - p.lastSeen) : null,
  };
}

// The view's v1.4 parts: ready, locLost, pins, pinsLeft, tap, tapOk, hack.
function v14ViewFor(s, me, { live, over, clock, now, positions, sch }) {
  const lobby = !live && !over;
  const settings = extrasOf(s.settings);
  let ready = null;
  if (lobby && me && me.status === 'in') {
    ready = s.hostId === me.id
      ? ordered(s).filter((p) => p.status === 'in').map((p) => readyRow(s, p, now))
      : [readyRow(s, me, now)];
  }
  const locLost = live ? locLostFor(s, me, { clock, now, positions, sch }) : null;
  let pins = null;
  let pinsLeft = 0;
  if (live && settings.pins && isHunter(me)) {
    const list = (Array.isArray(s.pins) ? s.pins : []).filter((x) => pinLive(x, clock));
    // (a hider who turned sees only the pins dropped since they turned)
    const since = me.startTeam === 'hunter' ? -Infinity : (Number.isFinite(me.turnedAt) ? me.turnedAt : Infinity);
    const driving = isDriver(s, me);
    pins = list.filter((x) => x.at >= since && !(driving && x.kind === 'seen')).slice().reverse().map((x) => ({
      id: x.id, by: x.by, name: playerOf(s, x.by) ? s.players[x.by].name : '', kind: x.kind, p: [x.p[0], x.p[1]],
      note: x.note, age: Math.max(0, clock - x.at), left: Math.max(0, x.until - clock), mine: x.by === me.id,
    }));
    pinsLeft = Math.max(0, LIMITS.pinsEach - list.filter((x) => x.by === me.id).length);
  }
  let tap = null;
  if (live && me && isFree(me) && s.pausedAt === null) {
    const tp = (Array.isArray(s.taps) ? s.taps : []).find((x) => x.target === me.id && tapOpen(x));
    if (tp && clock < tp.at + TIMING.TAP_END_MS) {
      const first = Number.isFinite(tp.firstAt) ? tp.firstAt : clock;
      const end = Math.min(tp.at + TIMING.TAP_END_MS, first + TIMING.TAP_MS);
      tap = { id: tp.id, until: Math.max(0, end - clock), pieceMs: TIMING.TAP_PIECE_MS, pieces: tp.pieces, most: LIMITS.tapPieces };
    }
  }
  const okIds = ordered(s).filter((p) => (lobby ? p.status === 'in' : active(p)) && p.tapOk === true).map((p) => p.id);
  const tapOk = { on: !!settings.powers.wiretap, ok: !!me && me.tapOk === true, okIds };
  let hack = null;
  if (live && me) {
    const hk = (Array.isArray(s.hacks) ? s.hacks : []).filter((x) => x.target === me.id && !x.blocked).pop();
    if (hk && clock - hk.at >= 0 && clock - hk.at <= TIMING.HACK_STALE_MS) hack = { n: hk.n, at: hk.at, ms: TIMING.HACK_MS };
  }
  return { ready, locLost, pins, pinsLeft, tap, tapOk, hack };
}

// Is a route point due for this player? Every TRAIL_EVERY_MS as before, or every TRAIL_NEAR_MS while their
// stored fix is within TRAIL_NEAR_M of a player of the other side (both fixes fresh), so close calls have a
// real track. `now` defaults to the clock's own time.
export function trailDue(state, pid, positions, lastClock, clock, { now } = {}) {
  if (!Number.isFinite(clock)) return false;
  if (!Number.isFinite(lastClock)) return true;
  const gap = clock - lastClock;
  if (gap >= TIMING.TRAIL_EVERY_MS) return true;
  if (gap < TIMING.TRAIL_NEAR_MS || !state || state.phase !== 'live') return false;
  const p = playerOf(state, pid);
  if (!p || p.status !== 'in') return false;
  const at = Number.isFinite(now) ? now : epochOf(state, clock);
  const fresh = (id) => {
    const pos = posOf(positions || {}, id);
    return pos && pos.at !== null && Math.abs(at - pos.at) <= TIMING.CAM_NEAR_FRESH_MS ? pos : null;
  };
  const mine = fresh(pid);
  if (!mine) return false;
  const others = isHunter(p) ? freeHiders(state) : isFree(p) ? ordered(state).filter(isHunter) : [];
  return others.some((o) => {
    const op = fresh(o.id);
    return !!op && distanceM(mine.p, op.p) <= TIMING.TRAIL_NEAR_M;
  });
}

// Where a player was at a clock, from their route points (joined up in a straight line), or null.
function pointAt(points, clock) {
  if (!points || !points.length) return null;
  const i = firstFrom(points, clock);
  const b = points[i];
  if (b && b.clock === clock) return b.p;
  const a = points[i - 1];
  if (!a || !b || b.clock - a.clock > GAP_STEP_MS) return null;
  const f = (clock - a.clock) / (b.clock - a.clock);
  return [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f];
}

// The closest moment between two players around a close call, from their full route points.
function gapOf(tracks, aId, bId, clock) {
  const A = tracks[aId], B = tracks[bId];
  if (!A || !B || !A.length || !B.length) return null;
  const from = clock - GAP_LOOK_MS, to = clock + GAP_LOOK_MS;
  const times = new Set();
  for (const list of [A, B]) {
    for (let j = firstFrom(list, from); j < list.length && list[j].clock <= to; j++) times.add(list[j].clock);
  }
  // Between two neighbouring times both walk in a straight line, so the closest moment there is worked out
  // exactly (in metres round the first point), not only at the route points themselves.
  const list = [...times].sort((x, y) => x - y);
  let best = null;
  const consider = (T) => {
    const pa = pointAt(A, T), pb = pointAt(B, T);
    if (!pa || !pb) return;
    const m = distanceM(pa, pb);
    if (!best || m < best.m) best = { m, clock: T, pa, pb };
  };
  for (let i = 0; i < list.length; i++) {
    consider(list[i]);
    const T1 = list[i], T2 = list[i + 1];
    if (T2 === undefined) continue;
    const a1 = pointAt(A, T1), b1 = pointAt(B, T1), a2 = pointAt(A, T2), b2 = pointAt(B, T2);
    if (!a1 || !b1 || !a2 || !b2) continue;
    // The gap (b - a) at T1 and T2, in metres.
    const g1 = toLocal(a1, b1);
    const g2 = toLocal(a2, b2);
    const dx = g2[0] - g1[0], dy = g2[1] - g1[1];
    const len2 = dx * dx + dy * dy;
    if (!len2) continue;
    const f = -(g1[0] * dx + g1[1] * dy) / len2;
    if (f > 0 && f < 1) consider(T1 + f * (T2 - T1));
  }
  if (!best) return null;
  return {
    m: Math.round(best.m), clock: Math.round(best.clock),
    a: { id: aId, p: [r6(best.pa[0]), r6(best.pa[1])] }, b: { id: bId, p: [r6(best.pb[0]), r6(best.pb[1])] },
  };
}

function trackOf(tracks, aId, bId, gap) {
  if (!gap) return null;
  const from = gap.clock - TRACK_BEFORE_MS, to = gap.clock + TRACK_AFTER_MS;
  const part = (id) => {
    const list = tracks[id] || [];
    const out = [];
    for (let j = firstFrom(list, from); j < list.length && list[j].clock <= to; j++) out.push(list[j]);
    return thin(out, TRACK_MOST).map((x) => [r6(x.p[0]), r6(x.p[1]), Math.round(x.clock)]);
  };
  return { from, to, a: part(aId), b: part(bId) };
}

// Every close call gets `gap` and `track` (null unless it's a hunter close to a hider: 'near', 'cpnear').
function withGaps(calls, tracks) {
  return calls.map((c) => {
    if ((c.kind !== 'near' && c.kind !== 'cpnear') || !Array.isArray(c.ids) || c.ids.length < 2) return { ...c, gap: null, track: null };
    const gap = gapOf(tracks, c.ids[0], c.ids[1], c.clock);
    return { ...c, gap, track: trackOf(tracks, c.ids[0], c.ids[1], gap) };
  });
}

// summary.hacks / taps / pins (this round's, for the replay and the movies).
function v14SummaryOf(s, radioSaved) {
  const clips = radioOf(s).clips;
  return {
    hacks: (s.hacks || []).map((h) => ({ clock: h.at, by: h.by, target: h.target, blocked: !!h.blocked })),
    taps: (s.taps || []).map((tp) => ({
      id: tp.id, clock: tp.at, by: tp.by, target: tp.target, state: tp.state,
      pieces: radioSaved ? clips.filter((c) => c.side === 'wiretap' && c.tap === tp.id).map((c) => c.n) : [],
    })),
    pins: (s.pins || []).map((x) => ({
      id: x.id, by: x.by, kind: x.kind, p: [x.p[0], x.p[1]], note: x.note, clock: x.at,
      until: Number.isFinite(x.goneAt) && x.goneAt !== null ? Math.min(x.goneAt, x.until) : x.until,
    })),
  };
}

// What a kept game's record holds (the server's `past`): everything an over view has but `me`.
export function pastBase(state) {
  if (!state || state.phase !== 'over') return null;
  const now = Number.isFinite(state.updatedAt) ? state.updatedAt : 0;
  const v = viewFor(state, '', { now, positions: {}, since: 0 });
  delete v.me;
  return v;
}
