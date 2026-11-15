// Night Ops: game over. The winners (faces, a trophy, why it ended, the MVP), a replay of everyone's routes on the
// map (play/pause, a scrubber with the catches and close calls marked, 10x/30x/60x, full screen), the close calls
// (each with Watch, which jumps the replay to that moment), the scoreboard and the play-by-play. At the bottom:
// Play again (the host), Chat and Leave. Share sends a plain-text result.
//
// Built from view.result and view.summary (CONTRACT.md "Game over"). Older or partial games can lack any part of
// the summary: each part only shows when its facts are there, and odd data never throws. Names, chat and event
// texts only ever go in as text.
//
// Pure helpers (no DOM, tested in Node): overFacts(view), playerLines(row, facts), shareText(facts), listNames,
// ticksFor(facts, endS), captionAt(events, clockMs), phaseAt(facts, clockMs), defaultSpeed(endS), facesSig.
import { h, fill, face, text, cls, listen } from '../dom.js';
import { icon } from '../ui/icons.js';
import { banner } from '../ui/banner.js';
import { openSheet } from '../ui/sheet.js';
import { createMap, cleanRoute, routeAt, toBounds } from '../map.js';
import { POWERS, cleanSettings, schedule, ringScaleAt, fmtClock, fmtDistance } from '../../shared/rules.js';
import { scaleRing, boundsOf, isPoint } from '../../shared/geo.js';
import { createReplayRadio, replayRadioUi, replayClips, clipPlan } from '../radio.js'; // v1.1 PAGE-RADIO
import { createTray } from '../ui/tray.js'; // v1.2 PAGE-MAP
import { attachCamParts, confirmAgain } from './camparts.js'; // v1.2 PAGE-CAM
import { cpCard, cpReplay, cpFacts, cpTitle, cpShareLine, cpTicks } from './cpafter.js'; // v1.3 PAGE-AFTER
// v1.4 PAGE-REEL: the map camera, the scene player, the Movies card, the close calls' mini maps
import { createMapCam } from '../mapcam.js';
import { openReel } from './reelplayer.js';
import { moviesCard, callMini, followRow, loadFaces } from './reelparts.js';
import { scenes as reelScenes } from '../scenes.js';
import { keepRow } from './keeprow.js'; // v1.4 PAGE-RENDER
// v1.4 end PAGE-REEL

// v1.1 PAGE-RADIO: 1 = real time (the walkie-talkie plays at it); clipPlan(clips, fromS, toS, playing) is the replay's
// clip scheduler (js/radio.js)
export const SPEEDS = [1, 10, 30, 60];
export { clipPlan };
// v1.1 end PAGE-RADIO
export const CAPTION_MS = 90000;    // the replay's caption shows an event for this long (game time) after it
export const WATCH_LEAD_S = 20;     // Watch starts the replay this long before the close call
const MOST_WINNER_FACES = 8;
const MOST_NAMES = 4;               // more winners than this: "The hiders win!"
const MOST_CALLS = 10;
const MOST_ROUTES = 40;
const MOST_EVENTS = 400;
const FRAME_CAP_MS = 250;           // after a pause in frames (a hidden tab), the replay never jumps further
const REASONS = { time: "Time's up", caught: 'Everyone was caught', host: 'The host ended the game' };
const POWER_ICON = { radar: 'radar', exposure: 'eye', jammer: 'jammer', decoy: 'decoy', sprint: 'sprint' };
const CALL_ICON = { near: 'users', jammer: 'jammer', ring: 'circle', lastPing: 'radar' };
const CALL_KIND = { near: 'Close call', jammer: 'Jammer', ring: 'Ring', lastPing: 'Last ping' };
// When summary.events is missing, the play-by-play falls back to the events this phone saw, of these kinds.
const PLAY_KINDS = new Set(['start', 'hunt', 'caught', 'power', 'closing', 'over', 'sos', 'resume', 'leave', 'denied']);

// ---- pure helpers ---------------------------------------------------------------------------------------------

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 64;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const nonNeg = (x) => { const n = num(x); return n !== null && n >= 0 ? n : null; };
const side = (t) => (t === 'hunter' || t === 'hider' ? t : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function clean(s, most = 200) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > most ? `${t.slice(0, most - 3).trimEnd()}...` : t;
}

// "Ava", "Ava and Noah", "Ava, Leo and Priya".
export function listNames(names) {
  const list = arr(names).map((n) => clean(String(n ?? ''), 40)).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function powerName(key) {
  if (POWERS[key]) return POWERS[key].name;
  const s = clean(String(key ?? ''), 20);
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function fromSummary(p, nameOf, driverId = null) {
  const catches = nonNeg(p.catches);
  // v1.1 PAGE-DRIVER: the driver's row says how far they drove and how many pickups (never "0 m covered":
  // their moves count as driving, not walking).
  const driver = p.driver === true || (!!driverId && p.id === driverId);
  const walked = nonNeg(p.distanceM);
  return {
    id: p.id,
    name: nameOf(p.id),
    startTeam: side(p.startTeam),
    team: side(p.team),
    status: typeof p.status === 'string' ? p.status : null,
    caughtBy: isId(p.caughtBy) ? p.caughtBy : null,
    caughtAt: nonNeg(p.caughtAt),
    survivedMs: nonNeg(p.survivedMs),
    catches: catches === null ? null : Math.round(catches),
    distanceM: driver && !walked ? null : walked,
    powers: [...new Set(arr(p.powers).filter((x) => typeof x === 'string' && x))].slice(0, 8),
    driver,
    drivenM: driver ? nonNeg(p.drivenM) : null,
    pickups: driver && nonNeg(p.pickups) !== null ? Math.round(p.pickups) : null,
    partial: false,
  };
}

function fromView(p, nameOf) {
  return {
    id: p.id,
    name: nameOf(p.id),
    startTeam: null,
    team: side(p.team),
    status: typeof p.status === 'string' ? p.status : null,
    caughtBy: isId(p.caughtBy) ? p.caughtBy : null,
    caughtAt: null,
    survivedMs: null,
    catches: null,
    distanceM: null,
    powers: [],
    driver: p.driver === true,
    drivenM: null,
    pickups: null,
    partial: true,
  };
}

// Everything the screen shows, from a view, checked and tidied. Never throws.
export function overFacts(view) {
  const v = isObj(view) ? view : {};
  const sum = isObj(v.summary) ? v.summary : null;
  const res = isObj(v.result) ? v.result : null;
  const meId = isObj(v.me) && isId(v.me.id) ? v.me.id : null;

  const names = new Map();
  const viewPlayers = arr(v.players).filter((p) => isObj(p) && isId(p.id));
  for (const p of viewPlayers) { const n = clean(p.name, 40); if (n) names.set(p.id, n); }
  const sumPlayers = sum ? arr(sum.players).filter((p) => isObj(p) && isId(p.id)) : [];
  for (const p of sumPlayers) { const n = clean(p.name, 40); if (n) names.set(p.id, n); }
  const nameOf = (id) => names.get(id) || 'Someone';

  // v1.1 PAGE-DRIVER: summary.driver { id, drivenM, pickups } fills in a row that lacks them.
  const sumDriver = sum && isObj(sum.driver) && isId(sum.driver.id) ? sum.driver : null;
  const seen = new Set();
  const once = (p) => (seen.has(p.id) ? false : (seen.add(p.id), true));
  const rows = sumPlayers.length
    ? sumPlayers.filter(once).map((p) => fromSummary(p, nameOf, sumDriver ? sumDriver.id : null))
    : viewPlayers.filter((p) => p.status !== 'kicked').filter(once).map((p) => fromView(p, nameOf));
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (sumDriver && byId.has(sumDriver.id)) {
    const r = byId.get(sumDriver.id);
    if (!r.partial) {
      if (r.drivenM === null && nonNeg(sumDriver.drivenM) !== null) r.drivenM = nonNeg(sumDriver.drivenM);
      if (r.pickups === null && nonNeg(sumDriver.pickups) !== null) r.pickups = Math.round(sumDriver.pickups);
    }
  }
  const driverRow = rows.find((r) => r.driver) || null;

  const reason = [sum && sum.reason, res && res.reason].find((r) => typeof r === 'string' && REASONS[r]) || null;
  // v1.3 PAGE-AFTER: in Checkpoints the result's winners lead (they change when the host doesn't count a photo)
  const cpF = cpFacts(v);
  const cpRes = cpF && res && Array.isArray(res.winners) ? res.winners : null;
  // v1.3 end PAGE-AFTER
  const winnerList = cpRes || (sum && Array.isArray(sum.winners) ? sum.winners : res && Array.isArray(res.winners) ? res.winners : []); // v1.3 PAGE-AFTER: cpRes
  // (Ids nobody here knows are left out: "Someone wins!" says nothing.)
  const winners = [...new Set(winnerList.filter(isId))].filter((id) => names.has(id) || byId.has(id));
  const winnerSet = new Set(winners);
  let winnerSide = null;
  if (reason === 'caught') winnerSide = 'hunter';
  else if (reason === 'time' || reason === 'host') winnerSide = 'hider';
  else if (winners.length) {
    let hunters = 0, hiders = 0;
    for (const id of winners) {
      const r = byId.get(id);
      const t = r ? r.startTeam || r.team : null;
      if (t === 'hunter') hunters += 1; else if (t === 'hider') hiders += 1;
    }
    winnerSide = hunters > hiders ? 'hunter' : hiders > hunters ? 'hider' : null;
  }

  // Settings and timing (only when the view carries settings).
  let sch = null;
  if (isObj(v.settings)) {
    try { sch = schedule(cleanSettings(v.settings)); } catch { sch = null; }
  }
  const settings = sch ? cleanSettings(v.settings) : null;

  // Routes: clean points only ([lng, lat, clockSeconds], in time order); players with none are left out.
  const routes = {};
  let routeCount = 0;
  if (sum && isObj(sum.routes)) {
    for (const [id, pts] of Object.entries(sum.routes)) {
      if (!isId(id) || routeCount >= MOST_ROUTES) continue;
      const c = cleanRoute(pts);
      if (c.length) { routes[id] = c; routeCount += 1; }
    }
  }

  // The play-by-play: the summary's, else what this phone saw.
  let events = [];
  let eventsFrom = 'none';
  if (sum && Array.isArray(sum.events)) {
    events = sum.events
      .filter((e) => isObj(e) && nonNeg(e.clock) !== null && clean(e.text))
      .map((e) => ({ clock: e.clock, text: clean(e.text, 300) }));
    eventsFrom = 'summary';
  }
  if (!events.length) {
    const own = arr(v.events)
      .filter((e) => isObj(e) && PLAY_KINDS.has(e.kind) && nonNeg(e.clock) !== null && clean(e.text))
      .map((e) => ({ clock: e.clock, text: clean(e.text, 300) }));
    if (own.length) { events = own; eventsFrom = 'view'; }
  }
  events = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.clock - b.clock || a.i - b.i)
    .map(({ clock, text: t }) => ({ clock, text: t }));
  if (events.length > MOST_EVENTS) events = events.slice(events.length - MOST_EVENTS);

  const closeCalls = (sum ? arr(sum.closeCalls) : [])
    .filter((c) => isObj(c) && clean(c.text))
    .slice(0, MOST_CALLS)
    .map((c) => ({
      kind: typeof c.kind === 'string' && CALL_KIND[c.kind] ? c.kind : 'near',
      text: clean(c.text, 240),
      clock: nonNeg(c.clock),
      ids: arr(c.ids).filter(isId).slice(0, 6),
      raw: c.track && c.gap ? c : null, // v1.4 PAGE-REEL: for the close call's mini map
    }));

  // The replay's end: the view's clock (the end clock once over), or the latest thing we know of, if later.
  let endMs = nonNeg(v.clock) || 0;
  for (const e of events) endMs = Math.max(endMs, e.clock);
  for (const pts of Object.values(routes)) endMs = Math.max(endMs, pts[pts.length - 1][2] * 1000);
  for (const r of rows) if (r.caughtAt !== null) endMs = Math.max(endMs, r.caughtAt);
  for (const c of closeCalls) if (c.clock !== null) endMs = Math.max(endMs, c.clock);
  const headStartMs = sch ? sch.headStartMs : null;
  // How long the game was: the view's clock is exact once it's over; the rest is a guess for older games.
  const gameMs = nonNeg(v.clock) || endMs;
  const huntMs = headStartMs !== null && gameMs > headStartMs ? gameMs - headStartMs : gameMs;

  // The title.
  const winnerNames = winners.map(nameOf);
  let title;
  if (!winners.length) title = 'Game over';
  else if (winners.length <= MOST_NAMES) title = `${listNames(winnerNames)} ${winners.length === 1 ? 'wins' : 'win'}!`;
  else if (winnerSide === 'hunter') title = 'The hunters win!';
  else if (winnerSide === 'hider') title = 'The hiders win!';
  else title = `${listNames([...winnerNames.slice(0, 3), `${winners.length - 3} more`])} win!`;
  // v1.3 PAGE-AFTER: "Ava wins with 4 checkpoints" (Classic's words when no checkpoint counted)
  const cpWords = cpF ? cpTitle(winners, cpF) : '';
  if (cpWords) title = winners.length <= MOST_NAMES ? `${cpWords}!` : title;
  // v1.3 end PAGE-AFTER

  // The MVP: most catches when the hunters' catches decided it, else the one who covered the most ground.
  const mvpId = isId(sum && sum.mvp) ? sum.mvp : isId(res && res.mvp) ? res.mvp : null;
  let mvp = null;
  if (mvpId) {
    const r = byId.get(mvpId);
    const name = nameOf(mvpId);
    const hunted = r && (r.startTeam === 'hunter' || r.team === 'hunter');
    if (r && r.catches > 0 && (reason === 'caught' || hunted)) {
      mvp = { id: mvpId, line: `Most catches: ${name} (${r.catches})`, short: `Most catches: ${name}` };
    } else if (r && r.distanceM > 0) {
      mvp = { id: mvpId, line: `Most ground covered: ${name} (${fmtDistance(r.distanceM)})`, short: `Most ground covered: ${name}` };
    } else if (names.has(mvpId)) {
      mvp = { id: mvpId, line: `MVP: ${name}`, short: `MVP: ${name}` };
    }
  }

  const caught = rows.filter((r) => r.caughtAt !== null || (r.partial && (r.status === 'caught' || r.caughtBy))).length;
  const hidersStarted = rows.filter((r) => r.startTeam === 'hider').length;
  const walked = rows.filter((r) => r.distanceM !== null);
  const totalM = walked.length ? walked.reduce((t, r) => t + r.distanceM, 0) : null;

  return {
    code: clean(v.code, 12),
    meId,
    meHost: !!(isObj(v.me) && v.me.host),
    nameOf,
    names,
    rows,
    byId,
    reason,
    reasonLine: REASONS[reason] || '',
    winners,
    winnerSet,
    winnerSide,
    meWon: !!meId && winnerSet.has(meId),
    title,
    mvp,
    settings,
    sch,
    headStartMs,
    endMs,
    huntMs,
    caught,
    hidersStarted,
    totalM,
    routes,
    hasRoutes: routeCount > 0,
    closeCalls,
    events,
    eventsFrom,
    ring: v.ring || null,
    ringNow: v.ringNow || null,
    marks: arr(v.marks).filter((m) => isObj(m) && isPoint(m.p)),
    partial: !sum,
    driver: driverRow ? { id: driverRow.id, drivenM: driverRow.drivenM, pickups: driverRow.pickups } : null,
    cp: cpF, cpTicks: cpTicks(sum, cpF), // v1.3 PAGE-AFTER
  };
}

// The words on one scoreboard row.
export function playerLines(row, facts) {
  const nameOf = facts && typeof facts.nameOf === 'function' ? facts.nameOf : () => 'Someone';
  const started = row.startTeam || (row.partial ? row.team : null);
  const sideWord = row.driver ? 'Driver' : started === 'hunter' ? 'Hunter' : started === 'hider' ? 'Hider' : '';
  let status = '';
  if (row.caughtAt !== null) {
    // (No hunter: the ring caught them, the only catch without one.)
    const by = row.caughtBy ? `Caught by ${nameOf(row.caughtBy)}` : 'Caught outside the ring';
    status = `${by}, ${fmtClock(row.caughtAt)}\u00a0in`;
  } else if (row.partial && (row.status === 'caught' || row.caughtBy)) {
    status = row.caughtBy ? `Caught by ${nameOf(row.caughtBy)}` : 'Caught';
  } else if (row.status === 'left') {
    status = 'Left the game';
  } else if (started === 'hider' && (!row.partial || row.status === 'in')) {
    status = 'Never caught';
  }
  const stats = [];
  if (row.catches !== null && (row.catches > 0 || (started === 'hunter' && !row.driver))) {
    stats.push(plural(row.catches, 'catch', 'catches'));
  }
  if (row.distanceM !== null) stats.push(`${fmtDistance(row.distanceM)} covered`);
  if (row.driver && row.drivenM !== null && row.drivenM !== undefined) stats.push(`${fmtDistance(row.drivenM)} driven`);
  if (row.driver && row.pickups !== null && row.pickups !== undefined) stats.push(plural(row.pickups, 'pickup', 'pickups'));
  const powers = row.powers.map((key) => ({ key, name: powerName(key), icon: POWER_ICON[key] || 'sprint' })).filter((p) => p.name);
  return {
    sideWord,
    side: started,
    status,
    stats,
    powers,
    won: !!(facts && facts.winnerSet && facts.winnerSet.has(row.id)),
    me: !!(facts && facts.meId === row.id),
  };
}

// Winners first; then most catches; then the hider who lasted longest; then as the server listed them.
export function boardOrder(facts) {
  const rows = facts.rows.map((r, i) => ({ r, i }));
  rows.sort((a, b) => {
    const wa = facts.winnerSet.has(a.r.id) ? 0 : 1;
    const wb = facts.winnerSet.has(b.r.id) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    const ca = a.r.catches || 0, cb = b.r.catches || 0;
    if (ca !== cb) return cb - ca;
    const sa = a.r.survivedMs || 0, sb = b.r.survivedMs || 0;
    if (sa !== sb) return sb - sa;
    return a.i - b.i;
  });
  return rows.map((x) => x.r);
}

// "Night Ops: Ava and Noah won after 45:00. Most catches: Sam."
export function shareText(facts) {
  const f = facts || {};
  const after = f.huntMs > 0 ? ` after ${fmtClock(f.huntMs)}` : '';
  let line;
  const ids = arr(f.winners);
  if (!ids.length) line = `Night Ops: game over${after}.`;
  else if (ids.length <= MOST_NAMES) line = `Night Ops: ${listNames(ids.map((id) => (f.nameOf ? f.nameOf(id) : 'Someone')))} won${after}.`;
  else line = `Night Ops: the ${f.winnerSide === 'hunter' ? 'hunters' : 'hiders'} won${after}.`;
  if (f.mvp && f.mvp.short) line += ` ${f.mvp.short}.`;
  // v1.3 PAGE-AFTER: "Checkpoints: Ava 4, Mia 3, Noah 1"
  const cpLine = f.cp ? cpShareLine(f.cp) : '';
  if (cpLine) line += ` ${cpLine}.`;
  // v1.3 end PAGE-AFTER
  return line;
}

// Marks on the replay's timeline: the end of the head start, each catch, each close call.
export function ticksFor(facts, endS) {
  const out = [];
  if (!(endS > 0)) return out;
  const add = (s, kind, label) => {
    if (Number.isFinite(s) && s >= 0 && s <= endS) out.push({ s, kind, label, pct: (s / endS) * 100 });
  };
  if (facts.headStartMs > 0) add(facts.headStartMs / 1000, 'start', 'Head start over');
  for (const r of facts.rows) if (r.caughtAt !== null) add(r.caughtAt / 1000, 'catch', `${r.name} caught`);
  for (const c of facts.closeCalls) if (c.clock !== null) add(c.clock / 1000, 'close', c.text);
  for (const t of arr(facts.cpTicks)) add(t.clockS, 'checkpoint', t.label); // v1.3 PAGE-AFTER
  return out;
}

// The newest play-by-play line at or before clockMs, if it happened within `within` ms.
export function captionAt(events, clockMs, within = CAPTION_MS) {
  let best = null;
  for (const e of arr(events)) {
    if (e.clock <= clockMs) best = e;
    else break;
  }
  return best && clockMs - best.clock <= within ? best : null;
}

export function phaseAt(facts, clockMs) {
  const sch = facts && facts.sch;
  if (!sch) return '';
  if (clockMs < sch.headStartMs) return 'Head start';
  if (sch.closingMs > 0 && clockMs >= sch.closingStartMs && clockMs < sch.endMs) return 'Closing in';
  if (clockMs >= sch.endMs) return 'End';
  return 'Hunt';
}

// A replay that lasts about a minute and a half: 30x for up to 45 minutes of game, 60x for longer ones.
export function defaultSpeed(endS) {
  return endS > 2700 ? 60 : 30;
}

// The facts that change what the info parts show (not the faces or the replay clock).
function factsSig(f) {
  return JSON.stringify([
    f.code, f.meId, f.reason, f.winners, f.mvp && f.mvp.line, f.endMs, f.headStartMs, f.hasRoutes,
    f.rows.map((r) => [r.id, r.name, r.startTeam, r.team, r.status, r.caughtBy, r.caughtAt, r.catches, r.distanceM, r.powers]),
    f.closeCalls.map((c) => [c.text, c.clock]),
    f.events.length, f.events.length ? f.events[f.events.length - 1].text : '',
    f.cp ? f.cp.done.map((d) => [d.n, d.struck]) : null, // v1.3 PAGE-AFTER
  ]);
}

function routesSig(f) {
  return JSON.stringify([
    Object.entries(f.routes).map(([id, pts]) => [id, pts.length, pts[pts.length - 1][2]]),
    f.ring ? JSON.stringify(f.ring).length : 0,
    f.hasRoutes ? 0 : f.marks.map((m) => [m.id, m.kind, m.p]),
  ]);
}

// Which players have a picture right now (faces arrive after the screen is up).
export function facesSig(ids, faces) {
  const get = (id) => (faces && typeof faces.get === 'function' ? faces.get(id) : null);
  return ids.map((id) => (get(id) ? `${id}:${String(get(id)).length}` : '')).join(',');
}

function reducedMotion() {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---- the screen -----------------------------------------------------------------------------------------------

export function mount(root, app) {
  const S = {
    dead: false,
    facts: null,
    sig: '',
    facesSig: '',
    routesSig: '',
    busy: false,
    keptCode: null,
    keptSummary: null,
    keptResult: null,
    chat: null,
    unread: 0,
  };
  // The replay: clock in game seconds.
  const R = {
    clock: 0,
    end: 0,
    speed: 30,
    speedSet: false,
    playing: false,
    raf: 0,
    last: 0,
    full: false,
    map: null,
    ringQ: null,
    shownS: -1,
    watching: null,
    inerted: [],
  };
  const offs = [];
  const faces = () => (app && app.faces instanceof Map ? app.faces : new Map());
  const faceOf = (id) => faces().get(id) || null;

  // ---- the winners ----

  const kickerText = h('span');
  const kicker = h('p.over-kicker', icon('trophy', 18), kickerText);
  const title = h('h1.over-title');
  const reasonLine = h('p.over-reason');
  const winnersList = h('ul.over-winners', { role: 'list', 'aria-label': 'Winners' });
  const mvpText = h('span');
  const mvpLine = h('p.over-mvp', icon('crown', 18), mvpText);
  const youLine = h('p.over-you');
  const stats = h('dl.over-stats');
  const shareBtn = h('button.btn.small.over-share', { type: 'button' }, icon('share', 18), h('span', 'Share result'));
  const hero = h('section.over-hero', { 'aria-labelledby': 'over-title' },
    h('div.over-hero-bg', { 'aria-hidden': 'true' }),
    kicker, title, reasonLine, winnersList, mvpLine, youLine, stats, shareBtn);
  title.id = 'over-title';

  // ---- the replay: v1.2 PAGE-MAP ----
  // On the page a poster: a still map of everyone's whole routes and "Watch the replay". It opens the replay layer
  // (the only way to play it): the map edge to edge, a HUD (the caption, the clock, Close), a top-left slot for the
  // video window (div.ov-video-slot, PAGE-CAM), and the tray: play/pause and the scrubber; open, the speeds, the
  // Walkie-talkie switch and Fit everyone. R.hooks (PAGE-CAM) hear every frame, opening, closing and jump.

  const posterBox = h('div.over-map.over-poster-map');
  const posterWrap = h('div.over-map-wrap.over-poster-wrap', posterBox);
  const posterLine = h('p.over-poster-line');
  const watchReplayBtn = h('button.btn.primary.wide.over-watch-replay', { type: 'button' }, icon('play', 20), h('span', 'Watch the replay'));
  const replayHead = h('div.over-card-head', h('h2#over-replay-title.label', 'Replay'));
  const poster = h('section.over-card.over-poster', { 'aria-labelledby': 'over-replay-title' },
    replayHead, posterWrap, posterLine, watchReplayBtn);
  const camSlot = h('div.over-cam-slot'); // v1.2: PAGE-CAM's clips card

  const mapBox = h('div.over-map.ov-map');
  const caption = h('p.over-caption');
  const playBtn = h('button.btn.icon-only.over-play', { type: 'button', 'aria-label': 'Play the replay' }, icon('play', 22));
  // 10 s back / forward: 10 s of what you're watching (game time at the replay's speed)
  const backBtn = h('button.btn.icon-only.over-skip.over-back10', { type: 'button', 'aria-label': 'Back 10 seconds' }, icon('skipback', 20), h('span.over-skip-n', { 'aria-hidden': 'true' }, '10'));
  const fwdBtn = h('button.btn.icon-only.over-skip.over-fwd10', { type: 'button', 'aria-label': 'Forward 10 seconds' }, icon('skipfwd', 20), h('span.over-skip-n', { 'aria-hidden': 'true' }, '10'));
  const clockNow = h('span.over-now', '0:00');
  const clockEnd = h('span.over-sub');
  const clockPhase = h('span.over-sub.over-phase');
  const clockBox = h('div.over-clock', { 'aria-hidden': 'true' }, clockNow, clockEnd, clockPhase);
  const speedBtns = SPEEDS.map((n) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'data-speed': String(n),
    'aria-label': n === 1 ? 'Real time' : `${n} times as fast`, // v1.1 PAGE-RADIO: Real time
  }, n === 1 ? 'Real time' : `${n}x`)); // v1.1 PAGE-RADIO
  const speedSeg = h('div.seg.over-speed', { role: 'radiogroup', 'aria-label': 'Replay speed' }, speedBtns);
  const fitBtn = h('button.btn.small.over-fit', { type: 'button' }, icon('fit', 18), h('span', 'Fit everyone'));
  // v1.4 PAGE-REEL: Follow beside Fit everyone, and the faces row it opens
  const followBtn = h('button.btn.small.over-follow.mapcam-btn', { type: 'button', 'aria-pressed': 'false', 'aria-expanded': 'false' }, icon('locate', 18), h('span', 'Follow'));
  const follow = followRow({ onPick: (id) => pickFollow(id) });
  // v1.4 end PAGE-REEL
  const controls = h('div.over-controls', speedSeg, fitBtn, followBtn); // v1.4 PAGE-REEL: followBtn
  const ticks = h('div.over-ticks', { 'aria-hidden': 'true' });
  const range = h('input.over-range', {
    type: 'range', min: '0', max: '1', step: '1', value: '0', 'aria-label': 'Replay time',
  });
  const track = h('div.over-track', ticks, range);
  const legend = h('p.over-legend', { 'aria-hidden': 'true' },
    h('span.over-key.k-catch', 'Catch'), h('span.over-key.k-close', 'Close call'),
    h('span.over-key.k-checkpoint', 'Checkpoint')); // v1.3 PAGE-AFTER: Checkpoint
  const fullBtn = h('button.g-more.over-full', { type: 'button', 'aria-label': 'Close the replay' }, icon('close', 22));
  const ovHud = h('header.ov-hud', h('div.ov-hud-row', caption, clockBox, fullBtn));
  const videoSlot = h('div.ov-video-slot'); // v1.2: PAGE-CAM's video window
  const zoomIn = h('button.map-btn.ov-zoom', { type: 'button', 'aria-label': 'Zoom in', hidden: true }, icon('plus', 22));
  const zoomOut = h('button.map-btn.ov-zoom', { type: 'button', 'aria-label': 'Zoom out', hidden: true }, icon('minus', 22));
  // Fit everyone on the map itself too (the tray's copy is hidden while the tray is tucked).
  const ovFit = h('button.map-btn.ov-fit', { type: 'button', 'aria-label': 'Fit everyone' }, icon('fit', 22));
  const ovBtns = h('div.ov-mapbtns', zoomIn, zoomOut, ovFit);
  const rTray = createTray({ label: 'Replay controls', onState: () => placeLayer() });
  rTray.el.classList.add('ov-tray');
  rTray.setMain([backBtn, playBtn, fwdBtn, { el: track, grow: true }]);
  const moreParts = [controls, follow.el, legend]; // v1.4 PAGE-REEL: follow.el
  rTray.setMore(moreParts);
  const mapWrap = h('div.over-map-wrap.ov-map-wrap', mapBox);
  const replay = h('section.over-replay.ov-layer', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ov-title' },
    h('h2#ov-title.sr-only', 'Replay'), mapWrap, ovHud, videoSlot, ovBtns, rTray.el);
  R.hooks = { frame: [], open: [], close: [], jump: [] };

  // ---- close calls, scoreboard, play-by-play ----

  const callsList = h('ul.over-calls-list', { role: 'list' });
  const calls = h('section.over-card.over-calls', { 'aria-labelledby': 'over-calls-title' },
    h('div.over-card-head', h('h2#over-calls-title.label', 'Close calls')), callsList);

  const boardList = h('ul.over-board-list', { role: 'list' });
  const boardNote = h('p.over-hint', { hidden: true });
  const board = h('section.over-card.over-board', { 'aria-labelledby': 'over-board-title' },
    h('div.over-card-head', h('h2#over-board-title.label', 'Scoreboard')), boardList, boardNote);

  const pbpCount = h('span.over-pbp-count');
  const pbpList = h('ol.over-pbp-list', { role: 'list' });
  const pbp = h('details.over-card.over-pbp',
    // (The row inside the summary is the flex box: older Safari can't lay a summary out as one.)
    h('summary.over-pbp-head', h('span.over-pbp-row', h('span.label', 'Play-by-play'), pbpCount,
      h('span.over-pbp-chevron', { 'aria-hidden': 'true' }, icon('back', 18)))),
    pbpList);

  // ---- the bottom bar ----

  const againBtn = h('button.btn.primary.over-again', { type: 'button', hidden: true }, icon('play', 20), h('span.over-again-word', 'Play again'));
  const waitLine = h('p.over-wait', { role: 'status', hidden: true });
  const chatDot = h('span.over-dot', { hidden: true, 'aria-hidden': 'true' });
  const chatBtn = h('button.btn.icon-only.over-chat', { type: 'button', 'aria-label': 'Chat' }, icon('chat', 22), chatDot);
  const leaveBtn = h('button.btn.ghost.over-leave', { type: 'button' }, icon('door', 20), h('span', 'Leave'));
  const foot = h('div.over-foot', leaveBtn, chatBtn, waitLine, againBtn);

  // v1.3 PAGE-AFTER: the Checkpoints card right after the hero, and the replay's zones and pulses
  const cpSlot = h('div.over-cp-slot');
  const cpUi = cpCard({
    app,
    canWatch: () => hasReplay(),
    onWatch: (c) => watchCall({ ...c, kind: 'near' }, -1),
  });
  cpSlot.appendChild(cpUi.el);
  const cpR = cpReplay({ map: () => R.map });
  // v1.3 end PAGE-AFTER
  // v1.4 PAGE-REEL: the Movies card after the replay's poster, and the keep row's place under the hero
  const keepSlot = h('div.over-keep-slot'); // its content is PAGE-RENDER's
  const movies = moviesCard({
    onWatch: (kind, reel) => watchMovie(kind, reel),
    onDownload: (kind, reel) => downloadMovie(kind, reel),
    onReplay: () => { if (hasReplay()) { setFull(true); if (R.clock >= R.end - 0.5) R.clock = 0; play(); } },
  });
  S.keepSlot = keepSlot;
  const keepUi = keepRow({ app }); keepSlot.append(keepUi.el); // v1.4 PAGE-RENDER: the keep row's content
  // v1.4 end PAGE-REEL
  const body = h('div.over-body', hero, keepSlot, cpSlot, poster, movies.el, camSlot, calls, board, pbp); // v1.3 PAGE-AFTER: cpSlot; v1.4 PAGE-REEL: keepSlot, movies.el
  const page = h('div.over', body, foot);
  fill(root, page, replay); // v1.2 PAGE-MAP: the replay layer sits over the page
  S.camSlot = camSlot; // v1.2: for PAGE-CAM
  S.videoSlot = videoSlot;
  // v1.2 PAGE-CAM: the clips card (in camSlot) and the replay's video window (in videoSlot, fed by R.hooks)
  const camUi = attachCamParts({ app, videoSlot, cardSlot: camSlot, hooks: R.hooks });
  // v1.2 end PAGE-CAM
  // v1.1 PAGE-WATCH: a spectator gets Stop watching in place of Leave (app.leave() stops watching) and no chat;
  // their view has no `me`, so no "you" lines show.
  if (app && app.watching) {
    fill(leaveBtn, icon('door', 20), h('span', 'Stop watching'));
    chatBtn.hidden = true;
    page.classList.add('over-watching');
  }
  // v1.1 end PAGE-WATCH
  // v1.1 PAGE-RADIO: the walkie-talkie in the replay. Clips play when the replay crosses their start, at real time;
  // the list under the replay plays each by hand.
  const RR = createReplayRadio({
    app,
    getClock: () => R.clock,
    nameOf: (id) => (S.facts ? S.facts.nameOf(id) : 'A hunter'),
    onChange: () => { if (!S.dead) { radioUi.paint(RR); captionKey = ''; drawCaption(); } },
  });
  const radioUi = replayRadioUi({
    onSwitch: (on) => { RR.enabled = on; },
    onPlay: (clip) => {
      RR.unlock();
      if (hasReplay()) setFull(true); // v1.2 PAGE-MAP: the replay plays in its layer
      if (hasReplay()) jumpTo(clip.clock / 1000);
      RR.playNow(clip);
      if (hasReplay()) play();
    },
  });
  moreParts.splice(1, 0, radioUi.switchRow); // v1.2 PAGE-MAP: the switch in the replay's tray
  rTray.setMore(moreParts);
  camSlot.after(radioUi.card);
  // v1.1 end PAGE-RADIO

  // ---- drawing the info parts ----

  function drawHero(f) {
    root.dataset.side = f.winnerSide || 'none';
    text(kickerText, f.code ? `Game over · ${f.code}` : 'Game over');
    text(title, f.title);
    text(reasonLine, f.reasonLine);
    reasonLine.hidden = !f.reasonLine;

    const shown = f.winners.slice(0, MOST_WINNER_FACES);
    fill(winnersList,
      shown.map((id) => {
        const r = f.byId.get(id);
        const team = r ? r.team || r.startTeam : f.winnerSide;
        return h('li.over-winner',
          face({ name: f.nameOf(id), src: faceOf(id), team: team || null, size: 52 }),
          h('span.over-winner-name', f.nameOf(id)));
      }),
      f.winners.length > shown.length
        ? h('li.over-winner', h('span.over-more', { 'aria-hidden': 'true' }, `+${f.winners.length - shown.length}`),
          h('span.over-winner-name', `${f.winners.length - shown.length} more`))
        : null);
    winnersList.hidden = !f.winners.length;

    text(mvpText, f.mvp ? f.mvp.line : '');
    mvpLine.hidden = !f.mvp;

    if (f.meWon) text(youLine, 'You won');
    else if (f.meId && f.winners.length && f.byId.has(f.meId)) text(youLine, 'Better luck next round');
    else text(youLine, '');
    cls(youLine, 'won', f.meWon);
    youLine.hidden = !youLine.textContent;

    const cells = [];
    if (f.huntMs > 0) cells.push([f.headStartMs !== null ? 'Hunt' : 'Game', fmtClock(f.huntMs)]);
    if (f.hidersStarted > 0) cells.push(['Caught', `${Math.min(f.caught, f.hidersStarted)} of ${f.hidersStarted}`]);
    else if (f.caught > 0) cells.push(['Caught', String(f.caught)]);
    if (f.totalM !== null && f.totalM > 0) cells.push(['Covered', fmtDistance(f.totalM)]);
    // v1.3 PAGE-AFTER: "Done": the checkpoints done, in the distance's place (four cells don't fit a phone)
    if (f.cp && f.cp.plan.length) {
      const i = cells.findIndex((c) => c[0] === 'Covered');
      if (i >= 0) cells.splice(i, 1);
      cells.splice(1, 0, ['Done', String(f.cp.done.filter((d) => !d.struck).length)]);
    }
    // v1.3 end PAGE-AFTER
    fill(stats, cells.map(([k, val]) => h('div.over-stat', h('dt', k), h('dd', val))));
    stats.hidden = !cells.length;
  }

  function drawCalls(f) {
    const usable = f.closeCalls;
    calls.hidden = !usable.length;
    fill(callsList, usable.map((c, i) => {
      const textId = `over-call-${i}`;
      const watch = R.end > 0 && f.hasRoutes && c.clock !== null
        ? h('button.btn.small.over-watch', { type: 'button', 'aria-describedby': textId, 'data-call': String(i) },
          icon('play', 16), h('span', 'Watch'))
        : null;
      if (watch) watch.addEventListener('click', () => watchCall(c, i));
      // v1.4 PAGE-REEL: a near call with its track: the still mini map, Watch = its scene, the replay under it
      const raw = c.raw || null;
      const mini = raw && raw.track && raw.gap
        ? callMini(raw, { summary: S.keptSummary, faces: loadFaces(app), onWatch: (x) => watchCallScene(x), onShow: watch ? () => watchCall(c, i) : null })
        : null;
      if (mini) {
        return h(`li.over-call.k-${c.kind}.has-mini`,
          h('div.over-call-text',
            h('span.over-call-kind', CALL_KIND[c.kind] || 'Close call', c.clock !== null ? ` · ${fmtClock(c.clock)}` : ''),
            h(`p#${textId}.over-call-line`, c.text), mini));
      }
      // v1.4 end PAGE-REEL
      return h(`li.over-call.k-${c.kind}`,
        h('span.over-call-icon', { 'aria-hidden': 'true' }, icon(CALL_ICON[c.kind] || 'users', 20)),
        h('div.over-call-text',
          h('span.over-call-kind', CALL_KIND[c.kind] || 'Close call', c.clock !== null ? ` · ${fmtClock(c.clock)}` : ''),
          h(`p#${textId}.over-call-line`, c.text)),
        watch);
    }));
  }

  function drawBoard(f) {
    const rows = boardOrder(f);
    board.hidden = !rows.length;
    fill(boardList, rows.map((r) => {
      const L = playerLines(r, f);
      const faceTeam = r.status === 'caught' ? 'out' : r.team || r.startTeam || null;
      return h(`li.over-row${L.won ? '.won' : ''}${L.me ? '.me' : ''}`,
        face({ name: r.name, src: faceOf(r.id), team: faceTeam, size: 44 }),
        h('div.over-row-main',
          h('div.over-row-top',
            h('span.over-row-name', r.name),
            L.me ? h('span.chip.over-you-chip', 'You') : null,
            L.won ? h('span.chip.over-win-chip', icon('trophy', 13), h('span', 'Winner')) : null),
          h('p.over-row-line',
            L.sideWord ? h(`span.over-side.s-${L.side}`, h('span.sr-only', 'Started as '), L.sideWord) : null,
            L.sideWord && L.status ? h('span.over-sep', { 'aria-hidden': 'true' }, ' · ') : null,
            L.status ? h(`span.over-status${L.status === 'Never caught' ? '.free' : ''}`, L.status) : null),
          L.stats.length || L.powers.length
            ? h('div.over-row-stats',
              L.stats.map((s) => h('span.over-stat-chip', s)),
              L.powers.length ? h('span.sr-only', 'Powers used:') : null,
              L.powers.map((p) => h('span.chip.over-power', icon(p.icon, 13), h('span', p.name))))
            : null));
    }));
    boardNote.hidden = !f.partial || !rows.length;
    text(boardNote, f.partial ? 'The full scores for this game are not available.' : '');
  }

  function drawPbp(f) {
    pbp.hidden = !f.events.length;
    text(pbpCount, plural(f.events.length, 'line', 'lines'));
    const jump = f.hasRoutes && R.end > 0;
    fill(pbpList, f.events.map((e) => {
      const stamp = h('span.over-pbp-time', fmtClock(e.clock));
      const words = h('span.over-pbp-text', e.text);
      if (!jump) return h('li.over-pbp-item.plain', stamp, words);
      const b = h('button.over-pbp-btn', { type: 'button' }, stamp, words,
        h('span.sr-only', '. Show it in the replay'),
        h('span.over-pbp-go', { 'aria-hidden': 'true' }, icon('play', 14)));
      b.addEventListener('click', () => jumpTo(e.clock / 1000, { show: true }));
      return h('li.over-pbp-item', b);
    }));
  }

  // ---- the footer ----

  function drawFoot(view) {
    // v1.4 PAGE-REEL: a past game (Your games): no Play again, and Back home in place of Leave
    const past = !!(view && view.past);
    cls(page, 'over-past', past);
    if (past) {
      againBtn.hidden = true;
      waitLine.hidden = false;
      text(waitLine, view.past.current === false ? 'The clips and photos went when they played again.' : '');
      waitLine.hidden = !waitLine.textContent;
      fill(leaveBtn, icon('back', 20), h('span', 'Back home'));
      chatBtn.hidden = true;
      return;
    }
    // v1.4 end PAGE-REEL
    const host = !!(view && view.me && view.me.host);
    againBtn.hidden = !host;
    waitLine.hidden = host;
    if (!host) {
      const hostRow = view && Array.isArray(view.players) ? view.players.find((p) => p && p.host && p.status !== 'left' && p.status !== 'kicked') : null;
      const who = hostRow ? clean(hostRow.name, 40) : '';
      text(waitLine, who ? `Waiting for ${who} to start a new round.` : 'Waiting for the host to start a new round.');
    }
    againBtn.disabled = S.busy;
    text(againBtn.querySelector('.over-again-word'), S.busy ? 'Starting...' : 'Play again');
  }

  function paintChat() {
    chatDot.hidden = !S.unread;
    chatBtn.setAttribute('aria-label', S.unread ? `Chat, ${S.unread} new` : 'Chat');
  }

  // ---- the replay ----

  function hasReplay() {
    const f = S.facts;
    return !!f && f.hasRoutes && R.end > 0;
  }

  function whole() {
    const f = S.facts;
    if (!f) return null;
    const ringBox = toBounds(f.ring) || toBounds(f.ringNow);
    if (ringBox) return ringBox;
    const pts = [];
    for (const r of Object.values(f.routes)) for (const p of r) pts.push(p);
    if (pts.length) return boundsOf(pts);
    return toBounds(f.marks.map((m) => m.p));
  }

  function ensureMap() {
    if (R.map || S.dead) return R.map;
    try {
      // v1.2 PAGE-MAP: the poster's still map on the page, or the layer's (pinch and drag) while it's open
      R.map = createMap(R.full ? mapBox : posterBox, { interactive: R.full });
      if (R.full) {
        const map = R.map;
        const zoomBtns = () => {
          if (S.dead || R.map !== map) return;
          const plainMap = map.mode() === 'plain';
          zoomIn.hidden = !plainMap;
          zoomOut.hidden = !plainMap;
        };
        map.ready.then(zoomBtns);
        map.onMode(zoomBtns);
        // v1.4 PAGE-REEL: once the person moves this map, nothing fits it again until a button says so
        R.cam = createMapCam(map, { fitAll: () => { placeMap(null); return true; }, pointOf: (id) => followPoint(id) });
        R.cam.on('mode', () => paintFollow());
        // v1.4 end PAGE-REEL
        placeLayer();
      }
    } catch (e) {
      console.error(e);
      R.map = null;
    }
    return R.map;
  }

  // v1.2 PAGE-MAP: the layer's map is told what its HUD and tray hide, and the video slot sits under the HUD.
  function placeLayer() {
    if (S.dead || !R.full) return;
    const vh = globalThis.innerHeight || 0;
    const top = Math.round(ovHud.getBoundingClientRect().bottom);
    const trayTop = Math.round(rTray.el.getBoundingClientRect().top) || vh;
    replay.style.setProperty('--ov-hud-bottom', `${top}px`);
    replay.style.setProperty('--ov-tray-h', `${Math.max(0, vh - trayTop)}px`);
    // (Banners sit under this HUD while the layer is open: over.css reads it from the page's root.)
    try { document.documentElement.style.setProperty('--ov-hud-bottom-page', `${top}px`); } catch { /* no document */ }
    const vw = globalThis.innerWidth || 0;
    const btns = ovBtns.getBoundingClientRect();
    const right = btns.width > 0 ? Math.max(0, Math.round(vw - btns.left) + 12) : 0;
    const video = videoInset(top, trayTop, vw);
    if (R.map) { try { R.map.setInsets({ top: video.top, left: video.left, right, bottom: Math.max(0, vh - trayTop) }); } catch { /* ignore */ } }
    // The video window came (or changed size): the routes are fitted again into what's left.
    const sig = `${video.top}|${video.left}`;
    if (R.videoSig !== undefined && R.videoSig !== sig && R.map) autoFit('video'); // v1.4 PAGE-REEL: autoFit
    R.videoSig = sig;
  }

  // The video window sits over the top-left of the map: the map keeps clear of it, either beside it or under it,
  // whichever leaves more map to fit the routes in.
  function videoInset(top, trayTop, vw) {
    const shown = [...videoSlot.children].find((c) => !c.hidden);
    const r = shown ? videoSlot.getBoundingClientRect() : null;
    if (!r || r.width <= 0 || r.height <= 0) return { top, left: 0 };
    const tall = Math.max(0, trayTop - top);
    const beside = Math.max(0, vw - r.right - 8) * tall;
    const under = vw * Math.max(0, trayTop - r.bottom - 8);
    return beside >= under ? { top, left: Math.round(r.right + 8) } : { top: Math.round(r.bottom + 8), left: 0 };
  }

  // v1.2 PAGE-MAP: tell PAGE-CAM's parts (R.hooks) where the replay is.
  function hook(kind) {
    const list = R.hooks && R.hooks[kind];
    if (!list || !list.length) return;
    const at = { clockMs: Math.round(R.clock * 1000), playing: R.playing, speed: R.speed, realTime: !!RR.busy() };
    for (const fn of list.slice()) { try { fn(at); } catch (e) { console.error(e); } }
  }

  function dropMap() {
    if (R.cam) { try { R.cam.destroy(); } catch { /* ignore */ } R.cam = null; } // v1.4 PAGE-REEL
    if (!R.map) return;
    try { R.map.destroy(); } catch (e) { console.error(e); }
    R.map = null;
    R.ringQ = null;
  }

  function placeMap(cam) {
    const box = whole();
    if (!box || !R.map) return;
    if (cam && cam.center && Number.isFinite(cam.zoom)) {
      R.map.center(cam.center, cam.zoom, { animate: false });
    } else {
      R.map.fit(box, { padding: R.full ? 40 : 18, animate: false });
    }
  }

  // Everything the replay shows at R.clock.
  function drawReplay() {
    const f = S.facts;
    if (!f || S.dead) return;
    const map = R.map;
    const atS = R.full ? R.clock : R.end; // v1.2 PAGE-MAP: the poster shows the whole routes
    if (map) {
      try {
        if (f.ring) {
          const scale = f.settings ? ringScaleAt(f.settings, atS * 1000) : 1;
          const q = hasReplay() ? Math.round(scale * 100) / 100 : -1;
          if (q !== R.ringQ) {
            R.ringQ = q;
            if (q === -1) map.setRing(f.ring, f.ringNow);
            else map.setRing(f.ring, q < 1 ? scaleRing(f.ring, q) : null);
          }
        } else if (R.ringQ !== 'now') {
          R.ringQ = 'now';
          map.setRing(null, f.ringNow);
        }
        cpR.frame({ clockMs: atS * 1000, map }); // v1.3 PAGE-AFTER: checkpoint zones open and close
        if (hasReplay()) {
          map.setRoutes(f.routes, atS, { players: f.rows, faces: faces() });
        } else {
          map.setRoutes(null, null);
          map.setMarks(f.marks, { faces: faces(), players: f.rows, meId: f.meId });
        }
      } catch (e) {
        console.error(e);
      }
    }
    if (!hasReplay()) return;
    const s = Math.min(R.end, Math.max(0, R.clock));
    const whole1 = Math.floor(s);
    if (String(range.value) !== String(Math.round(s))) range.value = String(Math.round(s));
    range.style.setProperty('--p', `${(s / R.end) * 100}%`);
    if (whole1 !== R.shownS) {
      R.shownS = whole1;
      text(clockNow, fmtClock(whole1 * 1000));
      range.setAttribute('aria-valuetext', `${fmtClock(whole1 * 1000)} of ${fmtClock(R.end * 1000)}`);
      const ph = phaseAt(f, s * 1000);
      text(clockEnd, `of ${fmtClock(R.end * 1000)}`);
      text(clockPhase, ph);
    }
    drawCaption();
    if (R.cam && R.full) R.cam.frame(); // v1.4 PAGE-REEL: Follow
    hook('frame'); // v1.2 PAGE-MAP
  }

  function drawCaption() {
    const f = S.facts;
    if (!f) return;
    const ms = R.clock * 1000;
    // v1.1 PAGE-RADIO: "Sam is talking" while a clip plays
    const talk = RR.talking();
    if (talk) { fillCaption(fmtClock(talk.clock), talk.words || `${talk.name} is talking`, 'radio'); return; } // v1.2 PAGE-RADIO: talk.words
    // v1.1 end PAGE-RADIO
    const w = R.watching;
    if (w && ms >= (w.clock - WATCH_LEAD_S * 1000) - 1 && ms <= w.clock + 25000) {
      fillCaption(fmtClock(w.clock), w.text, 'watch');
      return;
    }
    if (w && (ms > w.clock + 25000 || ms < w.clock - WATCH_LEAD_S * 1000 - 1)) {
      R.watching = null;
      markWatching();
    }
    const e = captionAt(f.events, ms);
    if (e) fillCaption(fmtClock(e.clock), e.text, '');
    else fillCaption('', R.playing ? '' : 'Press play to watch everyone move.', 'hint');
  }

  let captionKey = '';
  function fillCaption(stamp, words, kind) {
    const key = `${stamp}|${words}|${kind}`;
    if (key === captionKey) return;
    captionKey = key;
    caption.dataset.kind = kind || 'event';
    fill(caption, stamp ? h('span.over-caption-time', stamp) : null, h('span.over-caption-text', words));
  }

  function setupReplay(f) {
    const ends = [f.endMs / 1000];
    for (const pts of Object.values(f.routes)) ends.push(pts[pts.length - 1][2]);
    const end = f.hasRoutes ? Math.max(...ends.filter(Number.isFinite), 0) : 0;
    const wasEnd = R.end;
    R.end = end;
    if (!R.speedSet) R.speed = defaultSpeed(end);
    if (!wasEnd || R.clock > end) R.clock = end;   // first time: show the whole routes
    const usable = end > 0;
    for (const el of [controls, track, legend]) el.hidden = !usable;
    watchReplayBtn.hidden = !usable; // v1.2 PAGE-MAP
    text(posterLine, usable ? `${fmtClock(end * 1000)} of the game, ${plural(Object.keys(f.routes).length, 'route', 'routes')}. Pinch and drag in the replay.` : '');
    range.max = String(Math.max(1, Math.ceil(end)));
    R.shownS = -1;

    // The timeline's marks.
    const list = ticksFor(f, end);
    fill(ticks, list.map((t) => h(`span.over-tick.k-${t.kind}`, { style: { left: `${t.pct}%` } })));
    legend.querySelector('.k-catch').hidden = !list.some((t) => t.kind === 'catch');
    legend.querySelector('.k-close').hidden = !list.some((t) => t.kind === 'close');
    legend.querySelector('.k-checkpoint').hidden = !list.some((t) => t.kind === 'checkpoint'); // v1.3 PAGE-AFTER
    legend.hidden = !usable || !list.some((t) => t.kind !== 'start');

    if (!usable) {
      stop();
      if (R.full) setFull(false);
      poster.hidden = !whole();
      fillCaption('', f.marks.length
        ? "No routes were saved for this game, so here's where everyone ended up."
        : 'No routes were saved for this game.', 'hint');
      text(posterLine, caption.textContent);
    } else {
      poster.hidden = false;
      captionKey = '';
    }
    paintSpeed();
    paintPlay();
    if (!poster.hidden) {
      const first = !R.map;
      ensureMap();
      if (first) placeMap(null);
    }
    drawReplay();
  }

  function paintPlay() {
    fill(playBtn, icon(R.playing ? 'pause' : 'play', 22));
    playBtn.setAttribute('aria-label', R.playing ? 'Pause the replay' : 'Play the replay');
    cls(replay, 'playing', R.playing);
  }

  function paintSpeed() {
    for (const b of speedBtns) {
      const on = Number(b.dataset.speed) === R.speed;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  function setSpeed(n, { focus = false } = {}) {
    if (!SPEEDS.includes(n)) return;
    R.speed = n;
    R.speedSet = true;
    RR.cancel(); // v1.1 PAGE-RADIO: a speed tap stops the clip
    paintSpeed();
    if (focus) speedBtns.find((b) => Number(b.dataset.speed) === n)?.focus();
  }

  function frame(now) {
    R.raf = 0;
    if (S.dead || !R.playing) return;
    const dt = Math.min(FRAME_CAP_MS, Math.max(0, now - R.last));
    R.last = now;
    // v1.1 PAGE-RADIO: real time while a clip plays; a clip starting pulls the replay back to its start; the end
    // waits for the last clip
    const fromS = R.clock;
    R.clock = Math.min(R.end, R.clock + (dt / 1000) * (RR.busy() ? 1 : R.speed));
    const snap = RR.advance(fromS, R.clock, true);
    if (snap !== null && snap < R.clock) R.clock = snap;
    drawReplay();
    if (R.clock >= R.end && !RR.busy()) {
    // v1.1 end PAGE-RADIO
      stop();
      return;
    }
    R.raf = requestAnimationFrame(frame);
  }

  function play() {
    if (!hasReplay() || S.dead) return;
    if (R.clock >= R.end - 0.5) { R.clock = 0; RR.cancel(); } // v1.1 PAGE-RADIO: from the start again
    RR.unlock(); RR.resume(); // v1.1 PAGE-RADIO (Play is a tap)
    R.playing = true;
    R.last = performance.now();
    if (!R.raf) R.raf = requestAnimationFrame(frame);
    paintPlay();
    drawReplay();
  }

  function stop() {
    RR.pause(); // v1.1 PAGE-RADIO
    R.playing = false;
    if (R.raf) cancelAnimationFrame(R.raf);
    R.raf = 0;
    paintPlay();
  }

  function jumpTo(s, { show = false, keepWatch = false } = {}) {
    if (!hasReplay()) return;
    R.clock = Math.max(0, Math.min(R.end, s));
    RR.cancel(); // v1.1 PAGE-RADIO: a jump stops the clip
    if (!keepWatch) { R.watching = null; markWatching(); }
    R.last = performance.now();
    drawReplay();
    hook('jump'); // v1.2 PAGE-MAP
    if (show && !R.full) showReplay();
  }

  // v1.2 PAGE-MAP: the replay plays in its layer
  function showReplay() {
    if (hasReplay()) setFull(true);
  }

  // Watch: a few seconds before the moment, slowly, zoomed in on whoever it was about.
  function watchCall(c, index) {
    if (!hasReplay() || c.clock === null) return;
    R.watching = { ...c, index };
    markWatching();
    setSpeed(10);
    jumpTo(c.clock / 1000 - WATCH_LEAD_S, { keepWatch: true });
    const pts = [];
    for (const id of c.ids) {
      const r = S.facts.routes[id];
      if (!r) continue;
      const at = routeAt(r, c.clock / 1000);
      if (at.head) pts.push(at.head);
    }
    if (!R.full) showReplay(); // v1.4 PAGE-REEL: open first, so its first fit can't undo the centring below
    if (R.map && pts.length) {
      try {
        if (pts.length === 1) R.map.center(pts[0], 16.5);
        else R.map.fit(pts, { padding: 80, maxZoom: 17 });
      } catch (e) { console.error(e); }
      if (R.cam) { R.cam.mode = 'free'; R.cam.following = null; paintFollow(); } // v1.4 PAGE-REEL: a person's choice: it stays put
    }
    play();
  }

  function markWatching() {
    const at = R.watching ? R.watching.index : -1;
    for (const b of callsList.querySelectorAll('.over-watch')) {
      const on = Number(b.dataset.call) === at;
      cls(b.closest('.over-call'), 'watching', on);
    }
  }

  // ---- full screen ----

  // v1.2 PAGE-MAP: the replay layer (open) or the poster (closed).
  function setFull(on) {
    if (on === R.full || S.dead) return;
    if (on && !hasReplay()) return;
    R.full = on;
    replay.hidden = !on;
    cls(replay, 'full', on);
    try { document.documentElement.classList.toggle('over-full-on', on); } catch { /* no document */ }
    // Everything else on the screen sleeps while the replay fills it.
    if (on) {
      R.inerted = [];
      for (const el of [page, radioUi.card]) { // v1.1 PAGE-RADIO: radioUi.card
        if (!el || el.inert) continue;
        el.inert = true;
        R.inerted.push(el);
      }
    } else {
      for (const el of R.inerted) el.inert = false;
      R.inerted = [];
    }
    // A new map: pinch and drag work in the layer; on the page, the poster is a still picture.
    const keep = on ? null : R.map;
    dropMap();
    if (keep) { /* (the layer's view isn't kept for the poster) */ }
    ensureMap();
    if (on) autoFit('open'); else placeMap(null); // v1.4 PAGE-REEL: autoFit
    if (on) {
      placeLayer();
      requestAnimationFrame(() => { if (R.full) { placeLayer(); autoFit('open'); drawReplay(); } }); // v1.4 PAGE-REEL
    } else {
      stop();
    }
    drawReplay();
    hook(on ? 'open' : 'close');
    try { (on ? fullBtn : watchReplayBtn).focus({ preventScroll: true }); } catch { /* fine */ }
  }

  // ---- sharing ----

  async function share() {
    const words = shareText(S.facts || overFacts(app.view));
    const nav = globalThis.navigator || {};
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ text: words });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // they closed the share sheet
      }
    }
    try {
      if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(words);
        if (!S.dead) banner('Result copied. Paste it anywhere.', 'good');
        return;
      }
    } catch { /* show it instead */ }
    if (S.dead) return;
    const box = h('textarea.field.over-share-text', { readonly: true, rows: '3', 'aria-label': 'The result', autofocus: true });
    box.value = words;
    openSheet({
      title: 'Share the result',
      body: [h('p', 'Copy this and send it to anyone.'), box],
      actions: [{ label: 'Done', kind: 'primary' }],
    });
    try { box.select(); } catch { /* fine */ }
  }

  // ---- chat ----

  async function openChatSheet() {
    if (S.chat || S.dead) return;
    S.chat = 'opening';
    try {
      const mod = await import('./chat.js');
      if (S.dead) { S.chat = null; return; }
      S.unread = 0;
      paintChat();
      S.chat = mod.openChat(app, { onClose: () => { S.chat = null; } });
    } catch (e) {
      console.error(e);
      S.chat = null;
      if (!S.dead) banner("The chat didn't open. Check your signal and try again.", 'warn');
    }
  }

  function onEvent(e) {
    if (S.dead || !isObj(e)) return;
    const words = clean(e.text, 220);
    if (!words) return;
    if (e.kind === 'chat') {
      const meId = app.view && app.view.me ? app.view.me.id : null;
      if (e.from === meId || S.chat) return;
      S.unread += 1;
      paintChat();
      const who = (S.facts && e.from && S.facts.names.get(e.from)) || clean(app.player?.(e.from)?.name, 40) || 'Someone';
      banner(`${who}: ${words}`, 'chat');
    } else if (e.kind === 'leave' || e.kind === 'host' || e.kind === 'kick') {
      banner(words, 'info');
    }
  }

  // ---- wiring ----

  shareBtn.addEventListener('click', () => { share().catch((e) => console.error(e)); });
  playBtn.addEventListener('click', () => (R.playing ? stop() : play()));
  const skip = (dir) => { if (hasReplay()) jumpTo(R.clock + dir * 10 * (Number(R.speed) || 1), { keepWatch: true }); };
  backBtn.addEventListener('click', () => skip(-1));
  fwdBtn.addEventListener('click', () => skip(1));
  const fitEveryone = () => {
    const f = S.facts;
    if (!R.map || !f) return;
    if (R.cam) { R.cam.mode = 'auto'; } // v1.4 PAGE-REEL: Fit everyone puts the map back on its own
    paintFollow(); // v1.4 PAGE-REEL
    if (!R.map.fitAll({ ring: f.ring || f.ringNow })) {
      const box = whole();
      if (box) R.map.fit(box, { padding: 40 });
    }
  };
  fitBtn.addEventListener('click', fitEveryone);
  ovFit.addEventListener('click', fitEveryone);
  fullBtn.addEventListener('click', () => setFull(false));
  // v1.2 PAGE-MAP: Watch the replay (from the start when it's at the end), or a tap on the poster
  watchReplayBtn.addEventListener('click', () => {
    if (!hasReplay()) return;
    setFull(true);
    if (R.clock >= R.end - 0.5) R.clock = 0;
    play();
  });
  posterWrap.addEventListener('click', () => { if (hasReplay()) setFull(true); });
  // v1.4 PAGE-REEL: Follow opens the faces row
  followBtn.addEventListener('click', () => {
    const open = follow.el.hidden;
    follow.el.hidden = !open;
    followBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) paintFollow();
  });
  // v1.4 end PAGE-REEL
  zoomIn.addEventListener('click', () => { if (R.map) R.map.zoomBy(1); });
  zoomOut.addEventListener('click', () => { if (R.map) R.map.zoomBy(-1); });
  try {
    const ro = new ResizeObserver(() => placeLayer());
    ro.observe(ovHud);
    ro.observe(rTray.el);
    ro.observe(videoSlot);
    offs.push(() => ro.disconnect());
  } catch { /* an old browser: placed when it opens */ }
  offs.push(listen(window, 'resize', () => placeLayer()));
  range.addEventListener('input', () => jumpTo(Number(range.value) || 0));
  // Arrow keys move 10 seconds and Page Up/Down a minute (a whole game is thousands of seconds).
  range.addEventListener('keydown', (e) => {
    const by = { ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10, PageUp: 60, PageDown: -60 }[e.key];
    if (!by || !hasReplay()) return;
    e.preventDefault();
    jumpTo(R.clock + by);
  });
  for (const b of speedBtns) b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
  speedSeg.addEventListener('keydown', (e) => {
    const i = SPEEDS.indexOf(R.speed);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(SPEEDS.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SPEEDS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setSpeed(SPEEDS[next], { focus: true });
  });
  againBtn.addEventListener('click', async () => {
    if (S.busy || S.dead) return;
    // v1.2 PAGE-CAM: "This round's clips and replay will be deleted." first, when there are clips
    if (camUi.hasClips() && !(await confirmAgain(app, { summary: S.keptSummary }))) return;
    if (S.busy || S.dead) return;
    // v1.2 end PAGE-CAM
    S.busy = true;
    drawFoot(app.view);
    let result = null;
    try { result = await app.cmd({ type: 'again' }); } catch (e) { console.error(e); }
    if (S.dead) return;
    S.busy = false;
    drawFoot(app.view);
    if (result && result.error) againBtn.focus();
  });
  leaveBtn.addEventListener('click', () => {
    stop();
    // v1.4 PAGE-REEL: Back home from a past game
    if (app && app.view && app.view.past) {
      try { if (typeof app.closePast === 'function') app.closePast(); else app.leave(); } catch (e) { console.error(e); }
      return;
    }
    // v1.4 end PAGE-REEL
    try { app.leave(); } catch (e) { console.error(e); }
  });
  chatBtn.addEventListener('click', () => { openChatSheet(); });
  offs.push(listen(document, 'keydown', (e) => {
    if (e.key === 'Escape' && R.full && !document.documentElement.classList.contains('sheet-open')) {
      e.preventDefault();
      setFull(false);
    }
  }));
  if (app && typeof app.on === 'function') offs.push(app.on('event', onEvent));

  // ---- v1.4 PAGE-REEL: the map camera, Follow, the movies ----

  function autoFit(reason) {
    if (!R.map) return;
    if (R.cam) R.cam.auto(reason);
    else placeMap(null);
  }
  function followPoint(id) {
    const f = S.facts;
    const r = f && f.routes ? f.routes[id] : null;
    if (!r) return null;
    const at = routeAt(r, R.clock);
    return at && at.head ? at.head : null;
  }
  function pickFollow(id) {
    if (!R.cam) return;
    if (id) R.cam.follow(id); else R.cam.follow(null);
    paintFollow();
  }
  function paintFollow() {
    const f = S.facts;
    const following = R.cam && R.cam.mode === 'follow' ? R.cam.following : null;
    followBtn.setAttribute('aria-pressed', following ? 'true' : 'false');
    if (!f || follow.el.hidden) return;
    const players = f.rows.filter((r) => f.routes && f.routes[r.id]);
    follow.set(players, following, f.meId, faces);
  }
  function movieClips() {
    const l = camUi && camUi.list ? camUi.list.list : null;
    return l && Array.isArray(l.clips) ? l.clips.filter((c) => c && (c.state === undefined || c.state === 'done' || c.state === 'up')) : [];
  }
  function paintMovies() {
    const sum = S.keptSummary;
    // (a summary from before v1.4 has no endClock: the replay's end stands in)
    const withEnd = sum && !Number.isFinite(sum.endClock) && S.facts ? { ...sum, endClock: S.facts.endMs } : sum;
    try { movies.set({ summary: withEnd, clips: movieClips() }); } catch (e) { console.error(e); }
  }
  if (camUi && camUi.list && typeof camUi.list.on === 'function') offs.push(camUi.list.on(() => paintMovies()));
  function watchMovie(kind, reel, sceneIndex = null) {
    const r = reel || movies.reel(kind);
    if (!r) return;
    stop();
    try { if (S.reel) S.reel.close(); } catch { /* fine */ }
    S.reel = openReel({ app, list: movieClips(), summary: S.keptSummary, kind, reel: r, ring: S.facts ? S.facts.ring || S.facts.ringNow : null, sceneIndex });
    S.reel.on('close', () => { S.reel = null; });
  }
  // A close call's Watch: that call's scene (the highlights' one when it's there, else a reel of that call alone).
  function watchCallScene(call) {
    const clock = call.gap ? call.gap.clock : call.clock;
    let r = movies.reel('highlights');
    let i = r ? r.scenes.findIndex((sc) => sc.kind === 'near' && sc.start !== null && sc.start <= clock && sc.end >= clock) : -1;
    if (i < 0) {
      r = reelScenes({ summary: { ...S.keptSummary, closeCalls: [call], cam: null, hacks: [], taps: [], radio: null,
        players: (S.keptSummary.players || []).map((p) => ({ ...p, caughtAt: null })) }, clips: movieClips(), kind: 'highlights' });
      i = r.scenes.findIndex((sc) => sc.kind === 'near');
    }
    if (i < 0) return;
    watchMovie('highlights', r, i);
  }
  async function downloadMovie(kind, reel) {
    const r = reel || movies.reel(kind);
    if (!r) return;
    let mod = null;
    try { mod = await import('../render.js'); } catch { mod = null; }
    if (!mod || typeof mod.downloadReel !== 'function') {
      banner("Downloads aren't ready on this phone yet. Watch it here for now.", 'warn', 5000);
      return;
    }
    try { await mod.downloadReel({ app, reel: r, summary: S.keptSummary, list: movieClips(), ring: S.facts ? S.facts.ring || S.facts.ringNow : null }); } catch (e) {
      if (!(e && e.name === 'AbortError')) banner(e && e.message ? e.message : "The download didn't work. Try again.", 'warn', 6000);
    }
  }
  // v1.4 end PAGE-REEL

  // ---- update / destroy ----

  function update(view) {
    if (S.dead || !view) return;
    if (view.phase && view.phase !== 'over') { drawFoot(view); return; }
    // A later view without the summary (or the result) keeps the last one this game sent: it never changes once
    // the game is over, so a server that stops resending it doesn't empty the screen.
    const code = String(view.code || '');
    if (code !== S.keptCode) { S.keptCode = code; S.keptSummary = null; S.keptResult = null; }
    if (isObj(view.summary)) S.keptSummary = view.summary;
    if (isObj(view.result)) S.keptResult = view.result;
    if ((!isObj(view.summary) && S.keptSummary) || (!isObj(view.result) && S.keptResult)) {
      view = { ...view, summary: isObj(view.summary) ? view.summary : S.keptSummary, result: isObj(view.result) ? view.result : S.keptResult };
    }
    const f = overFacts(view);
    const sig = factsSig(f);
    const ids = f.rows.map((r) => r.id);
    for (const id of f.winners) if (!ids.includes(id)) ids.push(id);
    const fsig = facesSig(ids, faces());
    const rsig = routesSig(f);
    const changed = sig !== S.sig;
    S.facts = f;
    try { camUi.update(view); } catch (e) { console.error(e); } // v1.2 PAGE-CAM
    try { keepUi.update(view); } catch (e) { console.error(e); } // v1.4 PAGE-RENDER
    paintMovies(); // v1.4 PAGE-REEL
    // v1.3 PAGE-AFTER: the Checkpoints card and the replay's zones
    try { cpUi.update(view); cpR.setData(view.summary, f.cp); } catch (e) { console.error(e); }
    const cpTickSig = JSON.stringify(f.cpTicks);
    if (cpTickSig !== S.cpTickSig) { S.cpTickSig = cpTickSig; S.routesSig = ''; } // (a strike moves the ticks)
    // v1.3 end PAGE-AFTER
    // v1.1 PAGE-RADIO: the clips (summary.radio) and whether the walkie-talkie was saved
    try {
      const clips = replayClips(view.summary);
      RR.setClips(clips);
      radioUi.set(clips, f.nameOf, !(view.summary && view.summary.radioSaved === false));
      radioUi.paint(RR);
    } catch (e) { console.error(e); }
    // v1.1 end PAGE-RADIO
    if (rsig !== S.routesSig) {
      S.routesSig = rsig;
      setupReplay(f);
    }
    if (changed || fsig !== S.facesSig) {
      drawHero(f);
      drawBoard(f);
    }
    if (changed) {
      drawCalls(f);
      drawPbp(f);
      markWatching();
    }
    S.sig = sig;
    S.facesSig = fsig;
    drawFoot(view);
    drawReplay(); // faces on the replay's heads
  }

  function destroy() {
    if (S.dead) return;
    stop();
    S.dead = true;
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    for (const el of R.inerted) el.inert = false;
    R.inerted = [];
    try { document.documentElement.classList.remove('over-full-on'); } catch { /* ignore */ }
    if (R.full) { R.full = false; hook('close'); } // v1.2 PAGE-MAP
    if (S.chat && typeof S.chat.close === 'function') { try { S.chat.close(); } catch { /* ignore */ } }
    S.chat = null;
    try { RR.destroy(); } catch { /* ignore */ } // v1.1 PAGE-RADIO
    try { camUi.destroy(); } catch { /* ignore */ } // v1.2 PAGE-CAM
    try { cpUi.destroy(); cpR.destroy(); } catch { /* ignore */ } // v1.3 PAGE-AFTER
    try { if (S.reel) S.reel.close(); } catch { /* ignore */ } // v1.4 PAGE-REEL
    dropMap();
  }

  update(app && app.view ? app.view : { phase: 'over' });
  paintChat();
  return { update, destroy };
}
