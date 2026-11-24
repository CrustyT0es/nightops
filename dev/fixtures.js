// Night Ops: sample views for the preview page and for screen tests. Every view has the contract's exact shape
// (see CONTRACT.md "View"). Six friends play around Trinity Bellwoods Park in Toronto:
// Ava (the host) and Leo, Priya and Jordan hide; Sam and Mia hunt.
//
//   fixture({ screen, as, state, host, ring }) -> { view, me, game }
//     screen: home | lobby | ring | reveal | game | over | chat
//     as:     hunter | hider | out            (game, reveal, chat, over)
//     state:  headstart | hunt | closing | paused | tagged | outside   (game, chat); hunters (over: hunters won)
//     host:   '1' = you are the host (lobby, ring)
//     ring:   '0' = no ring drawn yet (lobby, ring)
//   faceFor(id) -> a generated SVG data: URL (a silhouette on a coloured background)
import { cleanSettings, withRecommendation, schedule, ringScaleAt, pingRadiusAt, TIMING, fmtClock } from '../shared/rules.js';
import { scaleRing, moveM, ringContains, ringCenter, offsetM } from '../shared/geo.js';
import { withDriver, DRIVER_SAMPLES } from './drive-fixtures.js'; // v1.1 PAGE-DRIVER
import { withCpPlay } from './cpplay-fixtures.js'; // v1.3 PAGE-PLAY
import { withCpSetup } from './cpsetup-fixtures.js'; // v1.3 PAGE-SETUP
import { withCpOver, withCpWatch } from './cpafter-fixtures.js'; // v1.3 PAGE-AFTER
import { withReel } from './reel-fixtures.js'; // v1.4 PAGE-REEL

export const CODE = 'WYKUSX';
export const NOW = Date.UTC(2026, 10, 14, 2, 40, 0); // Fri 13 Nov 2026, 9:40 pm in Toronto

export const PEOPLE = {
  ava: { id: 'a1f0c2d3e4b5', name: 'Ava', faceV: 1, hue: 200 },
  sam: { id: 'b2e1d3c4f5a6', name: 'Sam', faceV: 2, hue: 8 },
  mia: { id: 'c3d2e1f4a5b6', name: 'Mia', faceV: 0, hue: 330 },
  leo: { id: 'd4c3b2a1f6e5', name: 'Leo', faceV: 1, hue: 140 },
  priya: { id: 'e5b4a3c2d1f6', name: 'Priya', faceV: 3, hue: 270 },
  jordan: { id: 'f6a5b4c3d2e1', name: 'Jordan', faceV: 0, hue: 40 },
};
const ORDER = ['ava', 'sam', 'mia', 'leo', 'priya', 'jordan'];
const HUNTERS = ['sam', 'mia'];
const HIDERS = ['ava', 'leo', 'priya', 'jordan'];
const SECRET = '0123456789abcdef0123456789abcdef';

// Around Trinity Bellwoods Park: Dundas St W to Queen St W, Ossington Ave to Gore Vale.
export const RING = {
  kind: 'polygon',
  points: [
    [-79.4209, 43.6498],
    [-79.4152, 43.6531],
    [-79.4071, 43.6512],
    [-79.4063, 43.6447],
    [-79.4122, 43.6424],
    [-79.4197, 43.6438],
  ],
};

// Where everyone is at the moment of the main ("hunt") view.
const SPOTS = {
  ava: [-79.4161, 43.6489],     // behind the tennis courts
  sam: [-79.4128, 43.6471],
  mia: [-79.4176, 43.6452],
  leo: [-79.4096, 43.6501],     // in the dog bowl
  priya: [-79.4185, 43.6509],
  jordan: [-79.4102, 43.6449],
};

export function faceFor(id) {
  const p = Object.values(PEOPLE).find((x) => x.id === id);
  const hue = p ? p.hue : 210;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},62%,48%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},55%,22%)"/>` +
    `</linearGradient></defs><rect width="160" height="160" fill="url(#g)"/>` +
    `<circle cx="80" cy="64" r="30" fill="hsl(${hue},30%,88%)"/>` +
    `<path d="M24 160c4-36 28-54 56-54s52 18 56 54z" fill="hsl(${hue},30%,88%)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// A small, repeatable random number maker (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round7 = (p) => [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7];

function baseSettings({ caught = 'join' } = {}) {
  const s = withRecommendation(cleanSettings({ caught }), RING, ORDER.length);
  return s;
}

// The master list of events for a game at this clock; the view only shows the ones the viewer may see.
function allEvents({ phase, clock, settings, as, state }) {
  const sch = schedule(settings);
  const t0 = NOW - clock; // when the game started (no pauses in these samples)
  const list = [];
  const ev = (atClock, kind, to, text, extra = {}) => {
    list.push({ id: 0, at: t0 + atClock, clock: Math.max(0, atClock), kind, to, text, ...extra });
  };
  // Ids in time order, like the server's.
  const done = () => {
    list.sort((a, b) => a.at - b.at);
    list.forEach((e, i) => { e.id = i + 1; });
    return { list, t0 };
  };
  const jordanCaught = state === 'out' || phase === 'over';
  const P = PEOPLE;
  // The lobby: people joining, a bit of chat.
  const lobbyAt = (ms) => -ms; // before Start
  ev(lobbyAt(540000), 'join', 'all', 'Sam joined.', { data: { id: P.sam.id } });
  ev(lobbyAt(480000), 'join', 'all', 'Mia joined.', { data: { id: P.mia.id } });
  ev(lobbyAt(420000), 'join', 'all', 'Leo joined.', { data: { id: P.leo.id } });
  ev(lobbyAt(400000), 'chat', 'all', 'Ring is the whole park, right?', { from: P.leo.id });
  ev(lobbyAt(380000), 'chat', 'all', 'Park plus one street around it. No going in shops.', { from: P.ava.id });
  ev(lobbyAt(300000), 'join', 'all', 'Priya joined.', { data: { id: P.priya.id } });
  ev(lobbyAt(240000), 'join', 'all', 'Jordan joined.', { data: { id: P.jordan.id } });
  if (phase === 'lobby') return done();

  ev(0, 'start', 'all', `Game on! Hiders have ${fmtClock(sch.headStartMs)} to hide.`, { data: { headStartMs: sch.headStartMs } });
  ev(60000, 'chat', 'hunters', "I'll take the north side.", { from: P.sam.id });
  ev(95000, 'chat', 'hiders', 'Split up, nobody near the gates.', { from: P.ava.id });
  if (clock < sch.headStartMs) return done();

  ev(sch.headStartMs, 'hunt', 'all', 'Head start is over. Go get them!');
  const pings = sch.pings.filter((t) => t <= clock);
  pings.forEach((t, i) => {
    const n = i + 1;
    const free = jordanCaught && t > 1062000 ? 3 : 4;
    const count = n === 2 ? free - 1 : free;
    ev(t, 'ping', 'hunters', `Ping! ${count} hiders on the map.`, { data: { n, count } });
    for (const k of HIDERS) {
      if (k === 'jordan' && jordanCaught && t > 1062000) continue;
      const jammed = k === 'jordan' && n === 2;
      ev(t, 'ping', P[k].id, jammed ? 'Jammer worked. They got nothing on you.' : 'You were pinged.',
        { data: { n, result: jammed ? 'jammer' : 'pinged' } });
    }
    if (n === 1) {
      ev(t + 40000, 'chat', 'hunters', 'Leo is by the dog bowl for sure', { from: P.mia.id });
      ev(t + 70000, 'chat', 'hiders', 'They are heading east', { from: P.priya.id });
    }
    if (n === 2) {
      ev(t - 45000, 'power', 'hiders', 'Jordan used Jammer.', { data: { power: 'jammer', by: P.jordan.id } });
    }
  });
  if (clock >= 1060000 && state !== 'headstart') {
    ev(1060000, 'power', 'hunters', 'Sam used Radar.', { data: { power: 'radar', by: P.sam.id } });
    ev(1060000, 'radar', 'hunters', 'Radar goes live in 15 seconds.', { data: { liveIn: TIMING.RADAR_WARN_MS } });
    ev(1060000, 'radar', 'hiders', 'Radar in 15 seconds! Hide or use your Jammer.', { data: { liveIn: TIMING.RADAR_WARN_MS } });
    ev(1070000, 'chat', 'hiders', 'RADAR. Stay still.', { from: P.ava.id });
  }
  if (jordanCaught) {
    ev(1050000, 'tag', 'hunters', 'Sam tagged Jordan. Waiting for Jordan to confirm.', { data: { catchId: 'k1', hider: P.jordan.id } });
    ev(1050000, 'tag', P.jordan.id, 'Sam says they tagged you.', { data: { catchId: 'k1', hunter: P.sam.id } });
    ev(1062000, 'caught', 'all', 'Sam caught Jordan. 3 hiders left.', { data: { hider: P.jordan.id, hunter: P.sam.id, how: 'tag', left: 3 } });
  }
  if (state === 'tagged') {
    ev(clock - 5000, 'tag', P.leo.id, 'Sam says they tagged you.', { data: { catchId: 'k2', hunter: P.sam.id } });
    ev(clock - 5000, 'tag', 'hunters', 'Sam tagged Leo. Waiting for Leo to confirm.', { data: { catchId: 'k2', hider: P.leo.id } });
  }
  if (state === 'outside') {
    ev(clock - 12000, 'outside', P.leo.id, "You're outside the ring. Get back in within 0:30 or the hunters see you.", { data: { ms: TIMING.OUTSIDE_SHOW_MS } });
  }
  if (clock >= sch.closingStartMs) {
    ev(sch.closingStartMs, 'closing', 'all', `Closing in! Pings every ${settings.closingPingEveryMin} min and the ring is shrinking.`);
  }
  if (state === 'paused') {
    ev(clock, 'sos', 'all', 'SOS from Priya. The game is paused.', { data: { by: P.priya.id } });
  }
  if (phase === 'over' && state !== 'hunters') {
    ev(sch.endMs, 'over', 'all', "Time's up! Ava, Leo and Priya win!", { data: { reason: 'time', winners: [P.ava.id, P.leo.id, P.priya.id] } });
  }
  if (phase === 'over' && state === 'hunters') {
    ev(2650000, 'over', 'all', "Everyone's caught. Sam, Mia and Jordan win!", { data: { reason: 'caught', winners: [P.sam.id, P.mia.id, P.jordan.id] } });
  }
  return done();
}

function visibleTo(list, me) {
  const side = me.team === 'hunter' ? 'hunters' : me.team === 'hider' ? 'hiders' : null;
  return list.filter((e) => e.to === 'all' || e.to === me.id || (side && e.to === side && me.status === 'in'));
}

// A wandering route for the replay: [lng, lat, clockSeconds], inside the ring.
function route(key, endMs) {
  const rand = seeded(key.length * 7919 + key.charCodeAt(0));
  const hunter = HUNTERS.includes(key);
  let p = ringCenter(RING);
  const out = [];
  const stepS = 25;
  const end = Math.floor(endMs / 1000);
  let heading = rand() * 360;
  for (let s = 0; s <= end; s += stepS) {
    const hiding = !hunter && s > 300 && rand() < 0.75;
    const dist = hiding ? rand() * 6 : 12 + rand() * (hunter ? 45 : 30);
    heading += (rand() - 0.5) * 70;
    let next = moveM(p, dist, heading);
    if (!ringContains(RING, next)) {
      heading += 180;
      next = moveM(p, dist, heading);
      if (!ringContains(RING, next)) next = p;
    }
    p = next;
    out.push([...round7(p), s]);
  }
  // End where the main view says they are.
  out[out.length - 1] = [...SPOTS[key], end];
  return out.slice(-300);
}

function summaryFor(settings, hidersWin) {
  const sch = schedule(settings);
  const P = PEOPLE;
  const catchAt = 1062000;
  const players = ORDER.map((k) => {
    const p = P[k];
    const startTeam = HUNTERS.includes(k) ? 'hunter' : 'hider';
    const caught = k === 'jordan' || (!hidersWin && startTeam === 'hider');
    const caughtAt = k === 'jordan' ? catchAt : caught ? 2200000 + ORDER.indexOf(k) * 90000 : null;
    return {
      id: p.id,
      name: p.name,
      startTeam,
      team: caught ? 'hunter' : startTeam,
      caughtBy: caught ? P.sam.id : null,
      caughtAt,
      survivedMs: startTeam === 'hider' ? (caughtAt ?? sch.endMs) - sch.headStartMs : 0,
      catches: k === 'sam' ? (hidersWin ? 1 : 3) : k === 'mia' ? (hidersWin ? 0 : 1) : 0,
      distanceM: 1800 + ((p.hue * 37) % 2600),
      powers: k === 'jordan' ? ['jammer'] : k === 'sam' ? ['radar'] : k === 'leo' ? ['decoy', 'sprint'] : k === 'mia' ? ['exposure'] : [],
    };
  });
  const winners = hidersWin ? [P.ava.id, P.leo.id, P.priya.id] : [P.sam.id, P.mia.id, P.jordan.id];
  const routes = {};
  for (const k of ORDER) routes[P[k].id] = route(k, sch.endMs);
  return {
    winners,
    reason: hidersWin ? 'time' : 'caught',
    mvp: hidersWin ? P.leo.id : P.sam.id,
    players,
    closeCalls: [
      { kind: 'near', text: 'Leo and Sam were 8 m apart and Leo got away.', clock: 1650000, ids: [P.leo.id, P.sam.id] },
      { kind: 'jammer', text: 'Priya turned on Jammer 6 seconds before Radar went live.', clock: 1069000, ids: [P.priya.id] },
      { kind: 'ring', text: 'Ava got back inside the ring with 9 seconds to spare.', clock: 2310000, ids: [P.ava.id] },
      { kind: 'lastPing', text: "Leo's nearest hunter at the last ping was 42 m away.", clock: 2880000, ids: [P.leo.id, P.mia.id] },
      { kind: 'near', text: 'Ava and Mia were 12 m apart and Ava got away.', clock: 2050000, ids: [P.ava.id, P.mia.id] },
    ],
    routes,
    events: [
      { clock: 0, text: `Game on! Hiders have ${fmtClock(sch.headStartMs)} to hide.` },
      { clock: sch.headStartMs, text: 'Head start is over. Go get them!' },
      { clock: 855000, text: 'Jordan used Jammer.' },
      { clock: 1060000, text: 'Sam used Radar.' },
      { clock: catchAt, text: 'Sam caught Jordan. 3 hiders left.' },
      { clock: 1500000, text: 'Leo used Decoy.' },
      { clock: 1980000, text: 'Mia used Exposure.' },
      { clock: 2205000, text: 'Leo used Sprint.' },
      { clock: sch.closingStartMs, text: 'Closing in! Pings every 2 min and the ring is shrinking.' },
      hidersWin
        ? { clock: sch.endMs, text: "Time's up! Ava, Leo and Priya win!" }
        : { clock: 2650000, text: 'Everyone is caught. Sam, Mia and Jordan win!' },
    ],
  };
}

const CLOCKS = {
  reveal: 1500,
  headstart: 130000,
  hunt: 1098000,
  tagged: 1098000,
  outside: 1098000,
  paused: 1098000,
  out: 1098000,
  closing: 2700000,
};

function meKey(as) {
  if (as === 'hunter') return 'sam';
  if (as === 'out') return 'jordan';
  return 'leo';
}

function timingFor(settings, clock, phase) {
  const none = { headStartLeft: null, left: null, nextPingIn: null, pingN: null, closingIn: null, shrinking: false };
  if (phase !== 'live') return none;
  const sch = schedule(settings);
  const nextIdx = sch.pings.findIndex((t) => t > clock);
  return {
    headStartLeft: clock < sch.headStartMs ? sch.headStartMs - clock : null,
    left: Math.max(0, sch.endMs - clock),
    nextPingIn: nextIdx === -1 ? null : sch.pings[nextIdx] - clock,
    pingN: nextIdx === -1 ? null : nextIdx + 1,
    closingIn: sch.closingMs > 0 && clock < sch.closingStartMs ? sch.closingStartMs - clock : null,
    shrinking: !!settings.shrink && sch.closingMs > 0 && clock >= sch.closingStartMs,
  };
}

export function fixture(params = {}) {
  // v1.1 PAGE-DRIVER: as=driver (Sam drives) and driver=1 (a driver this round): the usual sample, then the driver
  if ((params.as === 'driver' || params.driver === '1') && !params.drv) {
    return withDriver(fixture({ ...params, as: params.as === 'driver' ? 'hunter' : params.as, drv: '1' }), params);
  }
  // v1.1 end PAGE-DRIVER
  if (params.screen === 'watch') return watchFixture(params); // v1.1 PAGE-WATCH
  // v1.3 PAGE-SETUP: screen=checkpoints (the editor: the host's lobby) and mode=checkpoints in the lobby
  if ((params.screen === 'checkpoints' || params.mode === 'checkpoints') && !params.cpset) {
    const inner = { ...params, cpset: '1' };
    if (params.screen === 'checkpoints') Object.assign(inner, { screen: 'lobby', host: '1' });
    return withCpSetup(fixture(inner), params);
  }
  // v1.3 end PAGE-SETUP
  const screen = params.screen || 'game';
  const as = params.as || (screen === 'over' ? 'hider' : 'hunter');
  const host = params.host === '1' || params.host === true || params.host === 1;
  const noRing = params.ring === '0' || params.ring === false;
  const state = params.state || (screen === 'reveal' ? 'reveal' : screen === 'over' ? 'time' : 'hunt');

  if (screen === 'home') return { view: null, me: { name: 'Leo', face: null }, game: null };

  const P = PEOPLE;
  const phase = screen === 'lobby' || screen === 'ring' ? 'lobby' : screen === 'over' ? 'over' : 'live';
  const caughtOut = as === 'out';
  const settings = baseSettings({ caught: caughtOut ? 'out' : 'join' });
  const sch = schedule(settings);
  const hidersWin = !(phase === 'over' && state === 'hunters');

  // Who am I?
  let key;
  if (phase === 'lobby') key = host ? 'ava' : 'leo';
  else if (screen === 'reveal' || phase === 'live') key = meKey(as);
  else key = as === 'hunter' ? 'sam' : 'leo';
  const me0 = P[key];

  let clock = 0;
  if (phase === 'live') clock = screen === 'reveal' ? CLOCKS.reveal : (CLOCKS[caughtOut ? 'out' : state] ?? CLOCKS.hunt);
  if (phase === 'over') clock = hidersWin ? sch.endMs : 2650000;
  const sub = phase === 'live' ? (clock < sch.headStartMs ? 'headstart' : 'hunt') : null;
  const paused = phase === 'live' && state === 'paused';

  // Teams and status for everyone.
  const players = ORDER.map((k) => {
    const p = P[k];
    let team = null;
    let status = 'in';
    let caughtBy;
    if (phase !== 'lobby') {
      team = HUNTERS.includes(k) ? 'hunter' : 'hider';
      const jordanCaught = phase === 'over' || caughtOut;
      if (k === 'jordan' && jordanCaught) {
        caughtBy = P.sam.id;
        if (caughtOut) status = 'caught';
        else team = 'hunter';
      }
      if (phase === 'over' && !hidersWin && team === 'hider') {
        team = 'hunter';
        caughtBy = P.sam.id;
      }
    }
    const row = {
      id: p.id,
      name: p.name,
      host: k === 'ava',
      team,
      status,
      faceV: p.faceV,
      online: !(k === 'jordan' && phase === 'live' && !caughtOut),
    };
    if (phase === 'lobby') row.pick = k === 'sam' ? 'hunter' : 'auto';
    if (caughtBy) row.caughtBy = caughtBy;
    return row;
  });
  const meRow = players.find((p) => p.id === me0.id);

  const isHider = meRow.team === 'hider';
  const powers = phase === 'lobby' || !isHider ? {} : {
    jammer: key === 'jordan' ? 'used' : 'ready',
    decoy: 'ready',
    sprint: key === 'leo' && state === 'closing' ? 'on' : 'ready',
  };
  if (phase === 'over' && key === 'leo') Object.assign(powers, { jammer: 'ready', decoy: 'used', sprint: 'used' });

  const me = {
    id: me0.id,
    name: me0.name,
    host: me0 === P.ava,
    team: meRow.team,
    startTeam: phase === 'lobby' ? null : (HUNTERS.includes(key) ? 'hunter' : 'hider'),
    status: meRow.status,
    powers,
    sprintLeft: powers.sprint === 'on' ? 74000 : 0,
    outsideFor: state === 'outside' && key === 'leo' ? 12000 : null,
    caught: caughtOut ? { by: P.sam.id, at: 1062000 } : null,
  };

  const ring = noRing && phase === 'lobby' ? null : RING;
  const ringNow = phase === 'live' ? scaleRing(RING, ringScaleAt(settings, clock)) : phase === 'over' ? scaleRing(RING, settings.finalSizePct / 100) : null;
  const timing = timingFor(settings, clock, phase);

  // Marks.
  const marks = [];
  const radarLive = phase === 'live' && !paused && clock >= 1075000 && clock < 1135000 && state !== 'closing';
  const huntOn = phase === 'live' && sub === 'hunt';
  if (phase === 'live' && me.status === 'in' && me.team === 'hunter') {
    for (const k of HUNTERS) marks.push({ id: P[k].id, kind: 'hunter', p: SPOTS[k], r: 0, age: k === key ? 0 : 2000, label: P[k].name });
    if (huntOn) {
      const r = pingRadiusAt(settings, clock);
      const lastPing = sch.pings.filter((t) => t <= clock).pop();
      const prevPing = sch.pings.filter((t) => t < (lastPing ?? 0)).pop();
      const blur = (k, by) => moveM(SPOTS[k], by, ORDER.indexOf(k) * 61);
      if (radarLive) {
        marks.push({ id: P.ava.id, kind: 'radar', p: SPOTS.ava, r: 0, age: 0, label: 'Ava' });
        marks.push({ id: P.priya.id, kind: 'radar', p: SPOTS.priya, r: 0, age: 0, label: 'Priya' });
      } else if (lastPing !== undefined) {
        marks.push({ id: P.ava.id, kind: 'ping', p: round7(blur('ava', r * 0.4)), r, age: clock - lastPing, label: 'Ava' });
        marks.push({ id: P.priya.id, kind: state === 'closing' ? 'outside' : 'ping', p: round7(blur('priya', r * 0.5)), r: state === 'closing' ? 0 : r, age: state === 'closing' ? 0 : clock - lastPing, label: 'Priya' });
      }
      if (lastPing !== undefined) {
        // Leo's Jammer blocked the Radar: the hunters still have Leo's last ping.
        marks.push({ id: P.leo.id, kind: 'ping', p: round7(blur('leo', r * 0.6)), r, age: clock - lastPing, label: 'Leo' });
      }
      if (!caughtOut && prevPing !== undefined) {
        // Jordan jammed the last ping: an older circle.
        marks.push({ id: P.jordan.id, kind: 'ping', p: round7(blur('jordan', r * 0.3)), r, age: clock - prevPing, label: 'Jordan' });
      }
    }
  } else if (phase === 'live' && me.status === 'in' && me.team === 'hider') {
    const mine = state === 'outside' ? offsetM(RING.points[3], 60, -20) : SPOTS[key];
    marks.push({ id: me.id, kind: 'self', p: round7(mine), r: 0, age: 0, label: me.name });
    const lastPing = sch.pings.filter((t) => t <= clock).pop();
    if (huntOn && lastPing !== undefined) {
      const r = pingRadiusAt(settings, lastPing);
      marks.push({ id: me.id, kind: 'seen', p: round7(moveM(SPOTS[key], r * 0.55, 220)), r, age: clock - lastPing, label: me.name });
    }
  } else if (phase === 'over') {
    for (const k of ORDER) {
      const row = players.find((p) => p.id === P[k].id);
      marks.push({ id: P[k].id, kind: row.team === 'hunter' ? 'hunter' : 'hider', p: SPOTS[k], r: 0, age: 0, label: P[k].name });
    }
  }
  const sos = paused ? { by: P.priya.id, name: 'Priya', p: SPOTS.priya } : null;
  if (sos) marks.push({ id: P.priya.id, kind: 'sos', p: sos.p, r: 0, age: 0, label: 'Priya' });

  const radar = radarLive && me.status === 'in' && (me.team === 'hunter' || me.team === 'hider')
    ? { state: 'live', ms: 1135000 - clock }
    : null;
  const team = phase === 'live' && me.team === 'hunter' && me.status === 'in'
    ? (sub === 'headstart'
      ? { radar: 'ready', exposure: 'ready', readyIn: timing.headStartLeft }
      : { radar: 'used', exposure: state === 'closing' ? 'used' : 'ready', readyIn: Math.max(0, 1060000 + TIMING.HUNTER_POWER_GAP_MS - clock) })
    : null;

  const pending = [];
  if (state === 'tagged' && (key === 'leo' || key === 'sam' || me.host)) {
    pending.push({ id: 'k2', hunter: P.sam.id, hider: P.leo.id, at: clock - 5000 });
  }

  const { list } = allEvents({ phase, clock, settings, as, state: caughtOut ? 'out' : state });
  const events = visibleTo(list, me);
  const lastEventId = list.length ? list[list.length - 1].id : 0;

  const view = {
    v: 1,
    code: CODE,
    phase,
    sub,
    now: NOW,
    clock,
    paused,
    me,
    players,
    settings,
    ring,
    ringNow,
    timing,
    marks,
    team,
    radar,
    pending,
    sos,
    events,
    lastEventId,
    result: phase === 'over'
      ? { reason: hidersWin ? 'time' : 'caught', winners: hidersWin ? [P.ava.id, P.leo.id, P.priya.id] : [P.sam.id, P.mia.id, P.jordan.id], mvp: hidersWin ? P.leo.id : P.sam.id }
      : null,
    summary: phase === 'over' ? summaryFor(settings, hidersWin) : null,
  };
  withRadio(view, params); // v1.1 PAGE-RADIO
  withCam(view, params); // v1.2 PAGE-CAM
  withReel(view, params); // v1.4 PAGE-REEL: &reel=1
  withHidersRadio(view, params); // v1.2 PAGE-RADIO
  withLoot(view, params); // v1.6: &loot=1 (boxes on the map) | held (holding one)
  withCpPlay(view, params); // v1.3 PAGE-PLAY: &cp=lead|inside|safe|overstay|again|done (hider), waiting|shown|overstay
  if (!params.cpw) withCpOver(view, params); // v1.3 PAGE-AFTER: screen=over&cp=1

  return {
    view,
    me: { name: me0.name, face: me0.faceV ? faceFor(me0.id) : null },
    game: { code: CODE, id: me0.id, secret: SECRET },
  };
}

// v1.6: Loot drops. &loot=1: a Loot drops game with two boxes on the map (one about to go); &loot=held: this
// phone holds one too.
function withLoot(view, params) {
  if (!params.loot || view.phase !== 'live') return;
  view.settings = { ...view.settings, mode: 'loot' };
  view.loot = {
    boxes: [{ id: 'L1', p: offsetM(SPOTS.leo, 120, 60), left: 150000 }, { id: 'L2', p: offsetM(SPOTS.sam, -90, -110), left: 20000 }],
    held: params.loot === 'held', next: 130000, last: null, grabbed: 1,
    stash: view.me && view.me.team === 'hunter' ? { compass: 1, tracker: 1, eye: 1 } : { smoke: 2, ghost: 1, blackout: 1 },
  };
  // v1.6.3: &lootat=<metres>: one more box that far north-east of this phone (2 = inside its 5 m circle)
  const at = Number(params.lootat);
  const mine = (view.marks || []).find((m) => view.me && m.id === view.me.id && (m.kind === 'self' || m.kind === 'hunter'));
  if (Number.isFinite(at) && at >= 0 && mine) {
    const d = at / Math.SQRT2;
    view.loot.boxes.push({ id: 'L3', p: offsetM(mine.p, d, d), left: 120000 });
  }
  for (const b of view.loot.boxes) b.r = 5;
  // &fx=blackout|storm|glitch|compass|eye|freeze|tracked|smoke: what a loot power does to this phone
  const fx = { blackout: { blackout: 287000 }, storm: { storm: 104000 }, glitch: { glitch: 52000 }, compass: { compass: { left: 24000, bearing: 40 } },
    eye: { eye: 98000 }, freeze: { freeze: 150000 }, tracked: { tracked: 95000 }, smoke: { smoke: true, ghost: 2, queued: ['blackout'] } }[params.fx];
  if (fx) view.fx = fx;
}

// v1.1 PAGE-RADIO: the walkie-talkie. A live hunter who is in gets view.radio (radio=1: with a clip from Mia a few
// seconds ago); over with radio=1: summary.radio with clips (radioSave=0: not saved, no clips).
export const RADIO_CLIPS = [
  { n: 1, from: 'p_mia', clock: 640000, ms: 4200, type: 'audio/mp4' },
  { n: 2, from: 'p_sam', clock: 1063000, ms: 6100, type: 'audio/mp4' },
  { n: 3, from: 'p_mia', clock: 1066000, ms: 3000, type: 'audio/mp4' },
  { n: 4, from: 'p_jordan', clock: 2210000, ms: 9800, type: 'audio/mp4' },
];
function withRadio(view, params = {}) {
  const ids = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`p_${k}`, p.id]));
  const clips = RADIO_CLIPS.map((c) => ({ ...c, from: ids[c.from] || c.from }));
  view.radio = null;
  if (view.phase === 'live' && view.me && view.me.team === 'hunter' && view.me.status === 'in') {
    const mine = params.radio === '1' ? [{ n: 1, from: ids.p_mia, clock: Math.max(0, view.clock - 4000), ms: 3200, type: 'audio/mp4' }] : [];
    view.radio = { clips: mine, last: mine.length };
  }
  if (view.summary) {
    const saved = params.radioSave !== '0';
    view.summary.radioSaved = saved;
    view.summary.radio = saved && params.radio === '1' ? clips : null;
    if (view.settings) view.settings = { ...view.settings, radioSave: saved };
  }
  return view;
}
// v1.1 end PAGE-RADIO

// v1.2 PAGE-RADIO: the hiders' walkie-talkie (hradio=1, with radioHiders on). A live hider who is in gets
// view.radio with side 'hiders' and two messages from Leo and Priya a few seconds ago (with &quiet=1 in the
// preview, Quiet holds them); hunters get side 'hunters'. Over with radio=1: the hiders' clips join the replay.
export const HIDER_CLIPS = [
  { n: 5, from: 'p_leo', clock: 700000, ms: 3600, type: 'audio/mp4', side: 'hiders' },
  { n: 6, from: 'p_priya', clock: 1070000, ms: 2500, type: 'audio/mp4', side: 'hiders' },
];
function withHidersRadio(view, params = {}) {
  if (params.hradio !== '1') return view;
  const ids = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`p_${k}`, p.id]));
  if (view.settings) view.settings = { ...view.settings, radioHiders: true };
  if (view.phase === 'live' && view.me && view.me.status === 'in') {
    if (view.me.team === 'hider') {
      const fresh = [
        { n: 5, from: ids.p_leo, clock: Math.max(0, view.clock - 6000), ms: 3600, type: 'audio/mp4' },
        { n: 6, from: ids.p_priya, clock: Math.max(0, view.clock - 3000), ms: 2500, type: 'audio/mp4' },
      ].filter((c) => c.from !== view.me.id);
      view.radio = { clips: fresh, last: 6, side: 'hiders' };
    } else if (view.radio) {
      view.radio = { ...view.radio, side: 'hunters' };
    }
  }
  if (view.summary && Array.isArray(view.summary.radio)) {
    const hiders = HIDER_CLIPS.map((c) => ({ ...c, from: ids[c.from] || c.from }));
    view.summary.radio = [...view.summary.radio.map((c) => ({ ...c, side: 'hunters' })), ...hiders]
      .sort((a, b) => a.clock - b.clock);
  }
  return view;
}
// v1.2 end PAGE-RADIO

// Move a view's clock on by ms (the preview's ?tick=1): timers count down, nothing else changes.
export function tickView(view, ms) {
  if (!view || view.phase !== 'live' || view.paused) return { ...view, now: view.now + ms };
  const clock = view.clock + ms;
  const t = view.timing;
  const less = (v) => (v === null || v === undefined ? v : Math.max(0, v - ms));
  return {
    ...view,
    now: view.now + ms,
    clock,
    timing: {
      ...t,
      headStartLeft: less(t.headStartLeft),
      left: less(t.left),
      nextPingIn: less(t.nextPingIn),
      closingIn: less(t.closingIn),
    },
    radar: view.radar ? { ...view.radar, ms: Math.max(0, view.radar.ms - ms) } : null,
    marks: view.marks.map((m) => (m.kind === 'ping' || m.kind === 'seen' ? { ...m, age: m.age + ms } : m)),
    me: { ...view.me, sprintLeft: Math.max(0, (view.me.sprintLeft || 0) - ms) },
  };
}

// Every combination the preview knows, for screenshot runs.
export const ALL = [
  { screen: 'home' },
  { screen: 'lobby', host: '1' },
  { screen: 'lobby', host: '0' },
  { screen: 'lobby', host: '1', ring: '0' },
  { screen: 'ring', host: '1' },
  { screen: 'ring', host: '1', ring: '0' },
  { screen: 'reveal', as: 'hider' },
  { screen: 'reveal', as: 'hunter' },
  { screen: 'game', as: 'hunter', state: 'headstart' },
  { screen: 'game', as: 'hider', state: 'headstart' },
  { screen: 'game', as: 'hunter', state: 'hunt' },
  { screen: 'game', as: 'hider', state: 'hunt' },
  { screen: 'game', as: 'hunter', state: 'closing' },
  { screen: 'game', as: 'hider', state: 'closing' },
  { screen: 'game', as: 'hider', state: 'tagged' },
  { screen: 'game', as: 'hider', state: 'outside' },
  { screen: 'game', as: 'hunter', state: 'paused' },
  { screen: 'game', as: 'out' },
  { screen: 'over', as: 'hider' },
  { screen: 'over', as: 'hunter', state: 'hunters' },
  ...DRIVER_SAMPLES, // v1.1 PAGE-DRIVER
  { screen: 'watch', state: 'lobby' }, // v1.1 PAGE-WATCH
  { screen: 'watch', state: 'live' }, // v1.1 PAGE-WATCH
];

// v1.1 PAGE-WATCH: a spectator's views (screen=watch&state=lobby|live|paused|over), shaped like the engine's
// watchView: me null, `watcher`, `watch`, every player's spot as of the delayed clock, the pings so far, events
// to all/hunters/hiders (never chat, never one player's) with `side`.
export const WATCHER = { id: '9a8b7c6d5e4f', name: 'Grandpa Joe', secret: 'fedcba9876543210fedcba9876543210' };

export function watchFixture(params = {}) {
  const state = params.state || 'live';
  const phase = state === 'lobby' ? 'lobby' : state === 'over' ? 'over' : 'live';
  const base = fixture({
    screen: phase === 'lobby' ? 'lobby' : phase === 'over' ? 'over' : 'game',
    as: 'hunter',
    state: state === 'paused' ? 'paused' : phase === 'over' ? 'time' : 'hunt',
    host: '0',
    cpw: '1', // v1.3 PAGE-AFTER: withCpWatch adds the checkpoints below
  }).view;
  const T = base.clock;
  const sch = schedule(base.settings);
  const players = base.players.map((p) => ({ ...p, online: true }));
  let marks = [];
  if (phase === 'live') {
    for (const k of ORDER) {
      const row = players.find((p) => p.id === PEOPLE[k].id);
      if (!row || row.status !== 'in') continue;
      marks.push({ id: row.id, kind: row.team, team: row.team, p: SPOTS[k], r: 0, age: 4000 + ORDER.indexOf(k) * 3000, label: row.name });
    }
    const lastPing = sch.pings.filter((t) => t <= T).pop();
    if (lastPing !== undefined) {
      const r = pingRadiusAt(base.settings, lastPing);
      for (const k of HIDERS) {
        marks.push({ id: PEOPLE[k].id, kind: 'ping', p: round7(moveM(SPOTS[k], r * 0.45, ORDER.indexOf(k) * 61)), r, age: T - lastPing, label: PEOPLE[k].name });
      }
    }
  } else if (phase === 'over') {
    marks = base.marks;
  }
  const { list } = allEvents({ phase, clock: T, settings: base.settings, as: 'hunter', state: state === 'paused' ? 'paused' : 'hunt' });
  const sideOf = (to) => (to === 'hunters' || to === 'hiders' ? to : 'all');
  const events = list
    .filter((e) => e.kind !== 'chat' && (e.to === 'all' || e.to === 'hunters' || e.to === 'hiders'))
    .map((e) => ({ ...e, side: sideOf(e.to) }));
  const view = {
    ...base,
    me: null,
    watcher: { id: WATCHER.id, name: WATCHER.name },
    watch: { delayMs: TIMING.SPECTATOR_DELAY_MS || 120000 },
    watching: 3,
    players,
    marks,
    team: null,
    radar: null,
    pending: [],
    noSignal: [],
    sos: base.paused ? { by: PEOPLE.priya.id, name: 'Priya', p: null } : null,
    events,
    lastEventId: list.length ? list[list.length - 1].id : 0,
    radio: null,
    drive: null,
    watchers: [],
    driverPick: null,
  };
  withCpWatch(view, params); // v1.3 PAGE-AFTER: &cp=1
  return { view, me: { name: WATCHER.name, face: null }, game: null, watch: { code: CODE, id: WATCHER.id, secret: WATCHER.secret } };
}
// v1.1 end PAGE-WATCH

// v1.2 PAGE-CAM: the highlight cam (cam=1). Lobby: the Camera row on (Ava and Sam said OK); live: Ava (as=hider) or
// Sam (as=hunter) is filmed; over: summary.cam with moments, and CAM_CLIPS answered by the preview's cam-list.
export const CAM_FILMED = ['ava', 'sam', 'mia'];
export function camClips(endMs = 2400000) {
  const ids = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [k, p.id]));
  const at = (k, start, s, i) => ({
    id: `c0ffee00000000${String(i).padStart(2, '0')}`, pid: ids[k], type: 'video/webm', bytes: 3200000 + i * 400000,
    ms: s * 1000, start, end: start + s * 1000, kinds: ['tag'],
    clocks: Array.from({ length: s }, (_, j) => start + j * 1000),
    loud: Array.from({ length: s }, (_, j) => (k === 'sam' ? 60 : 30) + (j % 5) * 4),
    bright: Array.from({ length: s }, () => 55),
  });
  return [at('ava', 630000, 30, 1), at('sam', 1055000, 30, 2), at('mia', 1058000, 30, 3), at('sam', Math.max(0, endMs - 25000), 30, 4)];
}
function withCam(view, params = {}) {
  if (params.cam !== '1') return view;
  const ids = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [k, p.id]));
  const filmed = CAM_FILMED.map((k) => ids[k]);
  const mode = params.camMode === 'everything' ? 'everything' : 'highlights';
  if (view.settings) view.settings = { ...view.settings, cam: true, camMode: mode };
  const meId = view.me ? view.me.id : null;
  if (view.phase === 'lobby') {
    const okIds = [ids.ava, ids.sam];
    view.cam = {
      on: true, mode, ok: okIds.includes(meId), okCount: okIds.length,
      inCount: (view.players || []).filter((p) => p.status === 'in').length,
      okIds: view.me && view.me.host ? okIds : null, filmed: [], moments: [], last: 0, kept: null,
    };
  } else {
    view.cam = {
      on: true, mode, ok: filmed.includes(meId), okCount: filmed.length, inCount: (view.players || []).length, okIds: null,
      filmed, moments: [], last: 0, kept: params.kept === '1' ? NOW + 30 * 24 * 3600 * 1000 : null,
    };
  }
  if (view.summary) {
    view.summary.cam = {
      mode, filmed,
      moments: [
        { clock: 640000, kind: 'radio', ids: [ids.mia], ms: 4200 },
        { clock: 1063000, kind: 'tag', ids: [ids.sam, ids.ava] },
        { clock: 1066000, kind: 'caught', ids: [ids.ava, ids.sam] },
      ],
    };
  }
  return view;
}
// v1.2 end PAGE-CAM
