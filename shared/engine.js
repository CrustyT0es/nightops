// Night Ops: the game engine, shared by the server (which runs it) and the page (errorText and friends).
// Pure: no I/O, no clock and no randomness of its own. Time comes in as `now` (epoch ms) and randomness as
// `rand()` in [0, 1), so every test is exact. The state given is never changed: changes are made on a copy.
// Game time ("clock") is ms since Start with pauses left out: pings, powers, tags, the ring and the end all
// run on it, so an SOS pause stops every timer at once.
import {
  isPoint, distanceM, moveM, scaleRing, outsideByM, ringProblem, cleanRing, ringContains, boundsOf,
} from './geo.js';
import {
  LIMITS, TIMING, POWERS, HIDER_POWERS, DEFAULTS, PRESETS,
  cleanSettings, huntersFor, withRecommendation, schedule, pingRadiusAt, ringScaleAt, fmtClock,
} from './rules.js';

export const ENGINE_V = 1;

// The timing settings a recommendation sets (rules.recommend's fields).
export const TIMING_KEYS = Object.freeze(['durationMin', 'headStartMin', 'pingEveryMin', 'closingMin', 'closingPingEveryMin']);

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
};

// A sentence for an error code (any unknown code gets a general one).
export function errorText(code) {
  return typeof code === 'string' && has(ERRORS, code) ? ERRORS[code] : 'Something went wrong. Try again.';
}

function err(code, message) {
  return { error: { code, message: message || errorText(code) } };
}

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

function withoutLoneJoiners(text) {
  if (!text.includes(ZWJ)) return text;
  const a = Array.from(text);
  let out = '';
  for (let i = 0; i < a.length; i++) {
    if (a[i] === ZWJ && !(i > 0 && i < a.length - 1 && VISIBLE_NEXT_TO_ZWJ.test(a[i - 1]) && VISIBLE_NEXT_TO_ZWJ.test(a[i + 1]))) continue;
    out += a[i];
  }
  return out;
}

function tidy(text) {
  if (typeof text !== 'string') return '';
  return withoutLoneJoiners(text.normalize('NFC').replace(INVISIBLE, ' ')).replace(/\s+/g, ' ').trim();
}

// A name or message as it is compared: what can be seen, in lower case ('' = nothing visible at all).
export function nameKey(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').replace(NOT_SEEN, '').toLowerCase();
}

function seenAtAll(text) {
  return SEEN_LETTER.test(nameKey(text));
}

function letters(text) {
  return Array.from(text).length;
}

function cut(text, most) {
  const a = Array.from(text);
  return a.length > most ? a.slice(0, most).join('') : text;
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
  return { catches: 0, powers: [], distanceM: 0 };
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
  return s;
}

// The epoch time of a game-clock moment (only valid while the game isn't paused).
function epochOf(s, clock) {
  return s.startedAt + s.pausedMs + clock;
}

function emit(s, t, kind, to, text, data, from) {
  const e = { id: s.nextEventId++, at: t.at, clock: t.clock, kind, to, text };
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
  if (reason !== 'caught' && winners.length) {
    let best = null;
    for (const id of winners) {
      const p = s.players[id];
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
    if (!n || p.status === 'kicked') continue;
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
  s.phase = 'over';
  s.radar = null;
  const winners = winnersOf(s, reason);
  const mvp = mvpOf(s, reason, winners);
  s.result = { reason, winners, mvp };
  let text;
  if (reason === 'time') {
    text = winners.length ? `Time's up! ${winWords(s, winners, 'hiders')}` : "Time's up!";
  } else if (reason === 'caught') {
    const anyCaught = s.catches.some((c) => c.state === 'done');
    const win = winWords(s, winners, 'hunters');
    text = `${anyCaught ? "Everyone's caught." : 'No hiders left.'}${win ? ` ${win}` : ''}`;
  } else {
    const win = winWords(s, winners, 'hiders');
    text = `The host ended the game.${win ? ` ${win}` : ''}`;
  }
  s.overEventId = emit(s, t, 'over', 'all', text, { reason, winners: winners.slice() }).id;
  note(s, { kind: 'over', clock: t.clock, text });
  // A summary without routes right away, so the end screen always has one; the server builds the full one
  // with the stored routes and puts it in place of this one.
  s.summary = summarize(s, []);
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

function passHost(s, t) {
  const rest = ordered(s).filter((p) => p.id !== s.hostId);
  const next = rest.find((p) => p.status === 'in') || rest.find(active);
  if (!next) return;
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
  s.catches = s.catches.filter((c) => !(c.hider === p.id && c.state === 'pending'));
  if (status === 'kicked') emit(s, t, 'kick', 'all', `${p.name} was removed from the game.`, { id: p.id });
  else emit(s, t, 'leave', 'all', `${p.name} left the game.`, { id: p.id });
  if (s.phase === 'live') note(s, { kind: 'leave', clock: t.clock, id: p.id, text: `${p.name} left the game.` });
  if (s.hostId === p.id) passHost(s, t);
  if (s.phase !== 'live') return;
  if (s.pausedAt !== null && (!s.sos || s.sos.by === p.id)) resumeGame(s, t, null);
  if (wasFree) checkEnd(s, t);
  if (s.phase === 'live' && wasHunter && !Object.values(s.players).some(isHunter)) {
    emit(s, t, 'info', 'all', 'No hunters left. The host can end the game.');
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
  const results = [];
  const quiet = [];
  let count = 0;
  for (const p of freeHiders(s)) {
    let result;
    if (p.powers.jammer === 'on') {
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
        const d = Math.sqrt(R()) * r;
        const b = R() * 360;
        spots[p.id] = { p: r > 0 ? moveM(spot, d, b) : spot, r };
        count++;
      }
    }
    results.push([p, result]);
  }
  s.pings.push({ n, clock, at: t.at, spots });
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
  if (s.pings.length < sch.pings.length) offer(sch.pings[s.pings.length], 3, { type: 'ping', n: s.pings.length + 1 });
  if (s.radar && s.radar.recorded) offer(s.radar.until, 4, { type: 'radarEnd' });
  for (const p of ordered(s)) {
    if (!isFree(p)) continue;
    if (p.powers.sprint === 'on' && p.sprintUntil !== null) offer(p.sprintUntil, 5, { type: 'sprintEnd', id: p.id });
    // (The ring rule stops at time's up, also while the end waits for a tag's answer.)
    if (p.outsideSince !== null) {
      const show = p.outsideSince + TIMING.OUTSIDE_SHOW_MS;
      const catchAt = p.outsideSince + TIMING.OUTSIDE_CATCH_MS;
      if (!p.outsideShown && show < sch.endMs) offer(show, 6, { type: 'outsideShow', id: p.id });
      if (catchAt < sch.endMs) offer(catchAt, 7, { type: 'outsideCatch', id: p.id });
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
      const ms = TIMING.OUTSIDE_CATCH_MS - TIMING.OUTSIDE_SHOW_MS;
      emit(s, t, 'outside', p.id, `The hunters can see you now. Get back in within ${fmtClock(ms)} or you're caught.`, { ms, seen: true });
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
      const left = sch.pings.filter((x) => x >= sch.closingStartMs).length;
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
    default:
      break;
  }
}

export function advance(state, { now, positions = {}, rand } = {}) {
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
  if (!s.flags || !Array.isArray(s.log)) own();
  for (let guard = 0; guard < 10000 && s.phase === 'live'; guard++) {
    const item = nextDue(s, sch, ctx, clockNow);
    if (!item || item.clock > clockNow) break;
    own();
    runDue(s, item, ctx);
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

  // Distance walked: only clear moves (bigger than the jitter and the fix's accuracy), never jumps.
  if (acc <= ACC_MAX_M) {
    if (!p.track || !isPoint(p.track.p)) {
      p.track = { p: point, at };
      changed = true;
    } else {
      const d = distanceM(p.track.p, point);
      if (d >= Math.max(STEP_M, acc)) {
        const dt = Math.max(1, (at - p.track.at) / 1000);
        if (d / dt <= SPEED_MAX) p.stats.distanceM = Math.round((p.stats.distanceM + d) * 10) / 10;
        p.track = { p: point, at };
        changed = true;
      }
    }
  }

  // Out of the ring (hiders, during the hunt, while the clock runs).
  if (isFree(p) && s.ring && s.pausedAt === null) {
    const clock = clockOf(s, now);
    const sch = schedule(s.settings);
    if (clock >= sch.headStartMs && clock < sch.endMs) {
      const by = outsideByM(ringAt(s, clock), point);
      const margin = Math.max(OUT_MARGIN_MIN_M, Math.min(OUT_MARGIN_MAX_M, acc));
      const t = { now, clock, at: now };
      if (p.outsideSince === null && by > margin) {
        p.outsideSince = clock;
        p.outsideShown = false;
        emit(s, t, 'outside', p.id,
          `You're outside the ring. Get back in within ${fmtClock(TIMING.OUTSIDE_SHOW_MS)} or the hunters see you.`,
          { ms: TIMING.OUTSIDE_SHOW_MS });
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
    for (const k of Object.keys(patch)) if (has(DEFAULTS, k) && k !== 'custom') custom.add(k);
    next.custom = [...custom];
  }
  s.settings = next;
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
  return null;
}

function cmdShuffle(s) {
  for (const p of Object.values(s.players)) p.pick = 'auto';
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

  for (const p of Object.values(s.players)) resetForGame(p);
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
  const headStartMs = schedule(s.settings).headStartMs;
  const t0 = { now: t.now, clock: 0, at: t.now };
  const text = `Game on! Hiders have ${fmtClock(headStartMs)} to hide.`;
  emit(s, t0, 'start', 'all', text, { headStartMs });
  note(s, { kind: 'start', clock: 0, text: `Game on: ${hunters.length} ${hunters.length === 1 ? 'hunter' : 'hunters'}, ${hiders.length} ${hiders.length === 1 ? 'hider' : 'hiders'}.` });
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
    note(s, { kind: 'power', power, by: actor.id, clock: t.clock, text });
    return null;
  }
  if (actor.team !== 'hunter') return err('not_your_turn', 'Only hunters can use that.');
  if (s.team[power] !== 'ready') return err('used', `${name} is used up.`);
  const last = s.team.lastPowerAt;
  if (last !== null && t.clock - last < TIMING.HUNTER_POWER_GAP_MS) {
    return err('cooldown', `Wait ${fmtClock(TIMING.HUNTER_POWER_GAP_MS - (t.clock - last))} after the last hunter power.`);
  }
  s.team[power] = 'used';
  s.team.lastPowerAt = t.clock;
  actor.stats.powers.push(name);
  const text = `${actor.name} used ${name}.`;
  emit(s, t, 'power', 'hunters', text, { power, by: actor.id });
  note(s, { kind: 'power', power, by: actor.id, clock: t.clock, text });
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
    const count = Object.keys(spots).length;
    emit(s, t, 'exposure', 'hunters', 'Exposure: exact spots!', missed ? { count, missed } : { count });
    emit(s, t, 'exposure', 'hiders', 'The hunters used Exposure.');
    for (const id of jammed) emit(s, t, 'exposure', id, 'Your Jammer hid you from Exposure.');
  }
  return null;
}

function cmdTag(s, actor, cmd, t) {
  const wait = inHunt(s, t, 'Tags count');
  if (wait) return wait;
  if (!isHunter(actor)) return err('not_your_turn', 'Only hunters can tag.');
  const target = playerOf(s, cmd.target);
  if (!isFree(target)) return err('bad_target', "That player isn't hiding right now.");
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
  }
  let hunterId = null;
  if (cmd.by !== undefined && cmd.by !== null && cmd.by !== '') {
    const hunter = playerOf(s, cmd.by);
    if (!hunter || hunter.team !== 'hunter' || hunter.status === 'kicked' || hunter.id === hider.id) {
      return err('bad_target', 'Pick the hunter who caught you.');
    }
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
  emit(s, t, 'sos', 'all', `SOS from ${actor.name}. The game is paused.`, { by: actor.id });
  note(s, { kind: 'sos', clock: t.clock, text: `SOS from ${actor.name}.` });
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
  emit(s, { now: t.now, clock: 0, at: t.now }, 'again', 'all', 'New round! Back to the lobby.');
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
};

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
  if (out && out.error) return out;
  if (playerOf(s, actorId)) s.players[actorId].lastSeen = now;
  s.updatedAt = now;
  return { state: s };
}

// ---------------------------------------------------------------------------------------------------------
// viewFor: the only thing a page ever gets about the game

// Which events a player may see: to all; to them; to their side while they're in it (a hider who joined
// the hunters sees hunter news from then on and no hider news at all; players sitting out see neither).
function canSee(e, me) {
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
    return { ...base, kind: 'ping', p: [seen.spot.p[0], seen.spot.p[1]], r: seen.spot.r, age: Math.max(0, clock - seen.ping.clock) };
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
  if (s.phase === 'over') {
    for (const p of ordered(s)) {
      if (!active(p) || !p.team) continue;
      const pos = posOf(positions, p.id);
      if (pos) marks.push({ id: p.id, kind: p.team, team: p.team, p: pos.p, r: 0, age: ageOf(pos, now), label: p.name });
    }
    return marks;
  }
  if (s.phase !== 'live') return marks;
  if (isHunter(me)) {
    for (const p of ordered(s)) {
      if (!isHunter(p)) continue;
      const pos = posOf(positions, p.id);
      if (pos) marks.push({ id: p.id, kind: 'hunter', p: pos.p, r: 0, age: ageOf(pos, now), label: p.name });
    }
    const r = s.radar;
    const radarLive = !!r && clock >= r.liveAt && clock < r.until;
    const blocked = !r ? [] : r.recorded ? (r.blocked || []) : radarSafe(s, r);
    const exposureOn = !!s.exposure && clock >= s.exposure.at && clock < s.exposure.at + TIMING.EXPOSURE_SHOW_MS;
    for (const h of freeHiders(s)) {
      const m = hiderMark(s, h, { clock, now, positions, sch, radarLive, blocked, exposureOn });
      if (m) marks.push(m);
    }
  } else if (isFree(me)) {
    const pos = posOf(positions, me.id);
    if (pos) marks.push({ id: me.id, kind: 'self', p: pos.p, r: 0, age: ageOf(pos, now), label: me.name });
    const seen = newestPingSpot(s, me.id);
    if (seen) {
      marks.push({ id: me.id, kind: 'seen', p: [seen.spot.p[0], seen.spot.p[1]], r: seen.spot.r, age: Math.max(0, clock - seen.ping.clock), label: me.name });
    }
  }
  if (s.sos) {
    const by = playerOf(s, s.sos.by);
    const pos = posOf(positions, s.sos.by);
    if (pos) marks.push({ id: s.sos.by, kind: 'sos', p: pos.p, r: 0, age: ageOf(pos, now), label: by ? by.name : '' });
  }
  return marks;
}

export function viewFor(state, playerId, { now, positions = {}, since = 0 } = {}) {
  const s = state;
  const me = playerOf(s, playerId);
  const live = s.phase === 'live';
  const over = s.phase === 'over';
  const clock = clockOf(s, now);
  const sch = schedule(s.settings);
  const paused = live && s.pausedAt !== null && s.pausedAt !== undefined;
  const sinceId = Number.isFinite(Number(since)) ? Number(since) : 0;

  const meView = me ? {
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
  } : {
    id: String(playerId || ''), name: '', host: false, team: null, startTeam: null, status: 'left', faceV: 0,
    powers: {}, sprintLeft: 0, outsideFor: null, caught: null,
  };

  const players = ordered(s)
    .filter((p) => s.phase !== 'lobby' || p.status === 'in')
    .map((p) => {
      const row = {
        id: p.id, name: p.name, host: s.hostId === p.id, team: p.team, status: p.status,
        faceV: p.faceV, online: online(s, p, positions, now),
      };
      if (s.phase === 'lobby') row.pick = p.pick;
      if (p.caughtBy) row.caughtBy = p.caughtBy;
      return row;
    });

  let ringNow = null;
  if (s.ring && s.phase !== 'lobby') ringNow = copy(ringAt(s, live ? clock : (over ? clock : 0)));

  const timing = { headStartLeft: null, left: null, nextPingIn: null, pingN: null, closingIn: null, shrinking: false, closing: false };
  if (live) {
    timing.headStartLeft = clock < sch.headStartMs ? sch.headStartMs - clock : null;
    timing.left = Math.max(0, sch.endMs - clock);
    const k = s.pings.length;
    if (k < sch.pings.length) {
      timing.nextPingIn = Math.max(0, sch.pings[k] - clock);
      timing.pingN = k + 1;
    }
    if (sch.closingMs > 0) {
      timing.closing = clock >= sch.closingStartMs;
      timing.closingIn = timing.closing ? null : sch.closingStartMs - clock;
      timing.shrinking = timing.closing && !!s.settings.shrink;
    }
  }

  let team = null;
  if (live && isHunter(me)) {
    const gap = s.team.lastPowerAt !== null ? Math.max(0, s.team.lastPowerAt + TIMING.HUNTER_POWER_GAP_MS - clock) : 0;
    team = {
      radar: s.settings.powers.radar ? s.team.radar : null,
      exposure: s.settings.powers.exposure ? s.team.exposure : null,
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
  const noSignal = live && isHunter(me) ? freeHiders(s).filter((p) => p.noFixTold === true).map((p) => p.id) : [];

  let sos = null;
  if (live && s.sos) {
    const by = playerOf(s, s.sos.by);
    const pos = posOf(positions, s.sos.by);
    sos = { by: s.sos.by, name: by ? by.name : '', p: pos ? pos.p : null };
  }

  const events = s.events
    .filter((e) => e.id > sinceId && canSee(e, me))
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
    settings: copy(s.settings),
    ring: s.ring ? copy(s.ring) : null,
    ringNow,
    timing,
    marks: marksFor(s, me, { clock, now, positions, sch }),
    team,
    radar,
    pending,
    sos,
    noSignal,
    events,
    // The newest event this player may see (never the game's own count, which would tell them the moment
    // the other side does something secret).
    lastEventId: s.events.reduce((m, e) => (e.id > m && canSee(e, me) ? e.id : m), 0),
    result: over && s.result ? copy(s.result) : null,
    // The summary (routes and all, up to 140 KB) goes once: with the view that first carries the 'over'
    // event, or to a phone starting afresh (since 0). The page keeps it (overId says which round it's for).
    summary: over && s.summary && !(Number.isFinite(s.overEventId) && sinceId >= s.overEventId) ? copy(s.summary) : null,
    overId: over && Number.isFinite(s.overEventId) ? s.overEventId : null,
  };
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

  // A hunter within CLOSE_CALL_M of a free hider, and no catch of that hider in the next minute.
  const pairs = new Map();
  for (const d of players) {
    if (d.startTeam !== 'hider') continue;
    for (const pt of tracks[d.id] || []) {
      if (pt.clock < sch.headStartMs || sideAt(d, pt.clock) !== 'hider') continue;
      if (done.some((c) => c.hider === d.id && c.at >= pt.clock && c.at <= pt.clock + GOT_AWAY_MS)) continue;
      for (const h of players) {
        if (h.id === d.id || sideAt(h, pt.clock) !== 'hunter') continue;
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
  return calls.slice(0, CLOSE_CALLS_KEPT).map(({ score, ...rest }) => rest);
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
    return {
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
  };
}
