// Night Ops: the game screen (the hunt). mount(root, app) -> { update(view), destroy() }
//
//   Top HUD     your side and name, game time left, SOS, the menu; the next ping (a big countdown with a draining
//               bar, amber for hiders in the warning seconds) and the hiders still in (caught ones crossed out).
//   Map         the ring and the marks (js/map.js); hunters tap a hider's mark to tag them. Lines float over its
//               top only when they matter (outside the ring, closing in, reconnecting, location off, tags waiting).
//   Panel       hunters: I tagged someone, Radar and Exposure, the last chat lines and quick chat;
//               hiders: how hidden you are, Jammer / Decoy / Sprint, I got tagged, chat; out: who caught you, chat.
//   On top      moments for big events (one at a time, stale ones skipped), banners for the rest, the "did they tag
//               you?" sheet, and the SOS screen while the game is paused.
//
// Everything shown comes from the view. Between syncs a local clock ticks every 250 ms (createGameClock), so
// countdowns run smoothly and never go back up. DOM changes only where something changed.
import { h, fill, text, cls, face, listen } from '../dom.js?v=154';
import { icon } from '../ui/icons.js?v=154';
import { openSheet, closeSheets } from '../ui/sheet.js?v=154';
import { banner, clearBanners } from '../ui/banner.js?v=154';
import { moment } from '../ui/moment.js?v=154';
import { startPocket } from '../ui/pocket.js?v=154';
import { createMap, fmtAgo } from '../map.js?v=154';
import { TIMING, POWERS, HIDER_POWERS, HUNTER_POWERS, POWER_TARGETED, schedule, fmtClock, fmtDistance } from '../../shared/rules.js?v=154';
import { distanceM, isPoint } from '../../shared/geo.js?v=154';
import { openChat, renderLines, quickFor, sendChat } from './chat.js?v=154';
import { mountDrive, pickMeUp, driverCard, pickupLines } from './drive.js?v=154'; // v1.1 PAGE-DRIVER
import { createTray, splitParts, mapButtonsPlace, mapButtonInsets } from '../ui/tray.js?v=154'; // v1.2 PAGE-MAP
import { gameCamParts } from './camparts.js?v=154'; // v1.2 PAGE-CAM
import { createFixIt } from '../ui/fixit.js?v=154'; // v1.4 PAGE-DEVICES
import { createPinTool } from './pins.js?v=154'; // v1.4 PAGE-PLAY
import { cpParts, cpEffect, cpHud, cpOf, spotsFor, HELP_CP } from './cpplay.js?v=154'; // v1.3 PAGE-PLAY

export const TICK_MS = 250;
export const STALE_MOMENT_MS = 20000;   // a moment for something that happened longer ago than this is skipped
export const STALE_ALERT_MS = 120000;   // ...and so are banners and buzzes (a phone waking up after a long sleep)
export const CLOSING_SOON_MS = 5 * 60000;
export const MOST_FACES = 7;
export const WAKE_GUARD_MS = 700;      // taps this soon after pocket mode wakes go nowhere (the "did they tag you?" sheet)
const LOC_RETRY_WAIT_MS = 1500;        // still blocked this long after Try again: offer a reload
const SNAP_AHEAD_MS = 3000;   // the local clock this far ahead of the server's: jump back (a pause we missed)
const SNAP_BEHIND_MS = 1500;  // ...this far behind: jump forward
const SLEW_MS = 25;
// Away from Night Ops (the phone locked, another app in front): the page sends no location then.
export const AWAY_NOTE_MS = 30000;       // a hider away this long (game time) hears about it when they come back
export const AWAY_KEY = 'nightops-away'; // kept in localStorage while away, so a reloaded page still knows
export const POCKET_TIP_KEY = 'nightops-pocket-tip';
const AWAY_SLACK_MS = 10000;             // a slow answer, or the server's clock against the phone's
const AWAY_ROUND_MS = 15 * 60000;        // a round's start moved more than this: not the same round
const AWAY_MOST_MS = 6 * 3600000;        // older than this: forget it

const perfNow = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// When `view` reached this phone (perfNow's time). The App stamps its newest view (app.viewAt) as it comes;
// a screen can be shown, or faces can land, seconds later, and the view is that old by then. A view passed
// some other way (the dev preview, tests) counts as just arrived.
export function arrivedAt(view, app, now = perfNow()) {
  const at = app && app.view === view ? Number(app.viewAt) : NaN;
  return Number.isFinite(at) && at <= now ? at : now;
}

// The game clock right now, from a view that arrived at `recvAt`: { clock, running }. Paused, it stands still.
export function clockFrom(view, recvAt, now = perfNow()) {
  const running = !!view && view.phase === 'live' && !view.paused;
  const clock = Number(view && view.clock);
  return { clock: running ? clock + Math.max(0, now - recvAt) : clock, running };
}

// ---- the local game clock -----------------------------------------------------------------------------------
// set(clock, running) with each view; read() any time. Between views it runs at real speed from the newest view.
// When the server says a little less time has passed than we showed (a slow answer arrived before a quick one),
// it runs slower until they agree, rather than going back; a little more and it runs faster. Paused: it stops.

export function createGameClock(now = perfNow) {
  let shown = null;
  let last = 0;
  let base = 0;
  let baseAt = 0;
  let frozen = true;

  function read() {
    const t = now();
    if (shown === null) return 0;
    if (frozen) {
      last = t;
      return shown;
    }
    const dt = Math.max(0, t - last);
    last = t;
    const target = base + (t - baseAt);
    const projected = shown + dt;
    const ahead = projected - target;
    if (ahead > SNAP_AHEAD_MS || ahead < -SNAP_BEHIND_MS) shown = target;
    else if (ahead > SLEW_MS) shown = Math.max(shown + dt * 0.75, target);     // ahead: run slower
    else if (ahead < -SLEW_MS) shown = Math.min(shown + dt * 1.5, target);     // behind: run faster
    else shown = Math.max(shown, target);
    return shown;
  }

  function set(clock, running) {
    if (!Number.isFinite(clock)) return;
    if (shown !== null && !frozen) read(); // bring `shown` up to now first
    const t = now();
    base = clock;
    baseAt = t;
    last = t;
    if (!running) {
      frozen = true;
      shown = clock;
      return;
    }
    if (shown === null || frozen) {
      frozen = false;
      shown = shown === null || Math.abs(clock - shown) > SNAP_AHEAD_MS ? clock : Math.max(shown, clock);
    }
  }

  return { read, set, running: () => !frozen };
}

// ---- reading the view (pure, tested in Node) ----------------------------------------------------------------

// 'hunter' | 'hider' | 'out'
export function modeOf(view) {
  const me = view && view.me;
  if (!me || me.status !== 'in') return 'out';
  if (me.team === 'hunter') return 'hunter';
  if (me.team === 'hider') return 'hider';
  return 'out';
}

export function playerOf(view, id) {
  const list = view && Array.isArray(view.players) ? view.players : [];
  return list.find((p) => p && p.id === id) || null;
}

export function nameOf(view, id) {
  const p = playerOf(view, id);
  return p && p.name ? String(p.name) : 'Someone';
}

export function freeHiders(view) {
  return (view && Array.isArray(view.players) ? view.players : []).filter((p) => p && p.team === 'hider' && p.status === 'in');
}

export function activeHunters(view) {
  return (view && Array.isArray(view.players) ? view.players : []).filter((p) => p && p.team === 'hunter' && p.status === 'in');
}

// Everyone who was caught this game: caughtBy, sitting out, or a 'caught' event (the ring catches someone with no
// hunter, and in 'join' games they just look like hunters afterwards).
export function caughtIds(view) {
  const out = new Set();
  for (const p of (view && view.players) || []) {
    if (p && (p.caughtBy || p.status === 'caught')) out.add(p.id);
  }
  for (const e of (view && view.events) || []) {
    if (e && e.kind === 'caught' && e.data && typeof e.data.hider === 'string') out.add(e.data.hider);
  }
  return out;
}

// The hiders' row: free ones first, then the caught ones (crossed out). [{ id, name, caught }]
export function hidersRow(view) {
  const caught = caughtIds(view);
  const free = [];
  const gone = [];
  for (const p of (view && view.players) || []) {
    if (!p || p.status === 'kicked') continue;
    if (p.team === 'hider' && p.status === 'in') free.push({ id: p.id, name: p.name, caught: false });
    else if (caught.has(p.id)) gone.push({ id: p.id, name: p.name, caught: true });
  }
  return [...free, ...gone];
}

// Every countdown at this clock, in ms (null = doesn't apply). c = the local clock's reading.
export function countdowns(view, c) {
  const t = (view && view.timing) || {};
  const me = (view && view.me) || {};
  const d = view && Number.isFinite(c) && Number.isFinite(view.clock) && !view.paused ? c - view.clock : 0;
  const less = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : Math.max(0, ms - d));
  return {
    d,
    headStart: less(t.headStartLeft),
    left: less(t.left),
    ping: less(t.nextPingIn),
    closingIn: less(t.closingIn),
    radar: view && view.radar ? less(view.radar.ms) : null,
    sprint: Number(me.sprintLeft) > 0 ? less(me.sprintLeft) : 0,
    readyIn: view && view.team ? less(view.team.readyIn) : null,
    outsideFor: me.outsideFor === null || me.outsideFor === undefined || !Number.isFinite(me.outsideFor)
      ? null : me.outsideFor + Math.max(0, d),
  };
}

export function inHeadStart(view, cd) {
  return !!view && view.phase === 'live' && view.sub === 'headstart' && cd.headStart !== null && cd.headStart > 0;
}

export function isClosing(view, c) {
  const t = (view && view.timing) || {};
  if (t.closing === true) return true;
  if (!view || !view.settings || !(view.settings.closingMin > 0)) return false;
  try {
    const sch = schedule(view.settings);
    return sch.closingMs > 0 && c >= sch.closingStartMs && view.phase === 'live';
  } catch {
    return false;
  }
}

// The big countdown: { kind: 'headstart'|'ping'|'end'|'none', label, ms, frac (1 full .. 0 empty), warn, n }
export function pingInfo(view, cd, mode) {
  if (!view || view.phase !== 'live') return { kind: 'none', label: '', ms: null, frac: 0, warn: false, n: null };
  let sch = null;
  try { sch = schedule(view.settings); } catch { sch = null; }
  const frac = (ms, total) => (ms === null || !(total > 0) ? 0 : Math.max(0, Math.min(1, ms / total)));
  if (inHeadStart(view, cd)) {
    return {
      kind: 'headstart',
      label: mode === 'hunter' ? 'Hiders are hiding' : mode === 'hider' ? 'Run and hide' : 'Head start',
      ms: cd.headStart,
      frac: frac(cd.headStart, sch ? sch.headStartMs : 0),
      warn: false,
      n: null,
    };
  }
  const t = view.timing || {};
  if (t.pingN && cd.ping !== null) {
    let total = 0;
    if (sch) {
      const i = t.pingN - 1;
      const end = sch.pings[i];
      const start = i > 0 ? sch.pings[i - 1] : sch.headStartMs;
      if (Number.isFinite(end) && Number.isFinite(start)) total = end - start;
    }
    if (!(total > 0)) total = Math.max(60000, (t.nextPingIn || 0));
    const warnSec = Number(view.settings && view.settings.pingWarnSec) || 0;
    const warn = mode === 'hider' && warnSec > 0 && cd.ping <= warnSec * 1000;
    return { kind: 'ping', label: cd.ping <= 0 ? 'Pinging' : 'Ping in', ms: cd.ping, frac: frac(cd.ping, total), warn, n: t.pingN };
  }
  let total = 0;
  if (sch) {
    const last = sch.pings.length ? sch.pings[sch.pings.length - 1] : sch.headStartMs;
    total = sch.endMs - last;
  }
  return { kind: 'end', label: 'Final stretch', ms: cd.left, frac: frac(cd.left, total), warn: false, n: null };
}

// The newest event of a kind sent to `to` (or any), or null.
function newest(view, test) {
  const list = (view && view.events) || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && test(list[i])) return list[i];
  return null;
}

// A hider's status card: { key, title, line, tone: 'ok'|'warn'|'danger'|'info', icon }
// stale: [{ from, to }] server times when this phone wasn't sharing its spot (see awayNews): a ping then
// showed the hunters an old spot, not one around you.
export function hiderStatus(view, c, cd = countdowns(view, c), { stale = [] } = {}) {
  const me = (view && view.me) || {};
  const powers = me.powers || {};
  if (inHeadStart(view, cd)) {
    return { key: 'headstart', title: 'Head start', line: "Hunters can't see you yet. Get far away.", tone: 'info', icon: 'moon' };
  }
  if (cd.outsideFor !== null) {
    const of = cd.outsideFor;
    if (of < TIMING.OUTSIDE_SHOW_MS) {
      return { key: 'outside', title: 'Outside the ring', line: 'Get back inside the blue line now.', tone: 'danger', icon: 'warn' };
    }
    return { key: 'outside', title: 'Hunters can see you', line: `You're outside the ring. Back in within ${fmtClock(TIMING.OUTSIDE_CATCH_MS - of)} or you're caught.`, tone: 'danger', icon: 'warn' };
  }
  const radar = view && view.radar;
  if (radar && cd.radar !== null) {
    if (radar.state === 'live') {
      if (radar.safe) return { key: 'radar-safe', title: 'Jammer on', line: "This Radar can't see you.", tone: 'ok', icon: 'jammer' };
      return { key: 'radar', title: 'On Radar!', line: `The hunters see you live for ${fmtClock(cd.radar)}.`, tone: 'danger', icon: 'radar' };
    }
    if (radar.safe) return { key: 'radar-safe', title: `Radar in ${fmtClock(cd.radar)}`, line: 'Your Jammer will hide you.', tone: 'ok', icon: 'jammer' };
    const canJam = powers.jammer === 'ready' && !HIDER_POWERS.some((k) => powers[k] === 'on');
    return { key: 'radar-warn', title: `Radar in ${fmtClock(cd.radar)}`, line: canJam ? 'Hide, or use your Jammer now.' : 'Get out of sight.', tone: 'warn', icon: 'radar' };
  }
  // Exposure: hiders hear about it as an event; the hunters see the spots for EXPOSURE_SHOW_MS.
  const exp = newest(view, (e) => e.kind === 'exposure' && e.to === 'hiders');
  if (exp && Number.isFinite(exp.clock) && c - exp.clock >= 0 && c - exp.clock < TIMING.EXPOSURE_SHOW_MS) {
    const hid = newest(view, (e) => e.kind === 'exposure' && e.to === me.id && e.clock === exp.clock);
    if (!hid) return { key: 'exposed', title: 'Exposed', line: 'The hunters see your exact spot right now.', tone: 'danger', icon: 'eye' };
  }
  if (powers.sprint === 'on') {
    return { key: 'sprint', title: `Sprint ${fmtClock(cd.sprint || 0)}`, line: 'Pings show where you started.', tone: 'ok', icon: 'sprint' };
  }
  if (powers.jammer === 'on') return { key: 'jammer', title: 'Jammer on', line: 'You skip the next ping.', tone: 'ok', icon: 'jammer' };
  if (powers.decoy === 'on') return { key: 'decoy', title: 'Decoy set', line: 'The next ping shows a fake spot.', tone: 'ok', icon: 'decoy' };
  const seen = ((view && view.marks) || []).find((m) => m && m.kind === 'seen' && m.id === me.id);
  if (seen) {
    const age = Math.max(0, (Number(seen.age) || 0) + Math.max(0, cd.d || 0));
    const seenAt = Number.isFinite(view.now) && Number.isFinite(seen.age) ? view.now - seen.age : null;
    const old = seenAt !== null && (Array.isArray(stale) ? stale : [])
      .some((s) => s && seenAt >= s.from && seenAt <= s.to);
    const where = old
      ? (seen.r > 0 ? `They saw a ${fmtDistance(seen.r)} circle around where you were when you left Night Ops.`
        : 'They saw where you were when you left Night Ops.')
      : seen.r > 0 ? `They saw a ${fmtDistance(seen.r)} circle around you.` : 'They saw your exact spot.';
    return { key: 'seen', title: `Seen ${fmtClock(age)} ago`, line: where, tone: age < 60000 ? 'warn' : 'info', icon: 'eye' };
  }
  return { key: 'hidden', title: 'Hidden', line: "The hunters haven't seen you yet.", tone: 'ok', icon: 'check' };
}

// A hunter power tile: { state: 'off'|'ready'|'warn'|'live'|'wait'|'used', line, usable, why }
export function hunterPower(view, name, cd, headStart = false) {
  const team = view && view.team;
  if (!team || team[name] === null || team[name] === undefined) return { state: 'off', line: '', usable: false, why: '' };
  if (name === 'radar' && view.radar && cd.radar !== null) {
    if (view.radar.state === 'warn') return { state: 'warn', line: `Live in ${fmtClock(cd.radar)}`, usable: false, why: 'Radar is starting.' };
    return { state: 'live', line: `Live ${fmtClock(cd.radar)}`, usable: false, why: 'Radar is on now.' };
  }
  if (name === 'exposure' && team.exposure === 'used' && ((view.marks || []).some((m) => m && m.kind === 'exposure'))) {
    return { state: 'live', line: 'Showing now', usable: false, why: 'Exposure is showing the spots now.' };
  }
  if (team[name] === 'used') return { state: 'used', line: 'Used', usable: false, why: `${POWERS[name].name} is used up for this game.` };
  if (view.paused) return { state: 'wait', line: 'Paused', usable: false, why: 'The game is paused.' };
  if (cd.readyIn !== null && cd.readyIn > 0) {
    return {
      state: 'wait',
      line: `Ready in ${fmtClock(cd.readyIn)}`,
      usable: false,
      why: headStart ? 'Hunter powers work once the head start is over.' : `Hunter powers need ${fmtClock(TIMING.HUNTER_POWER_GAP_MS)} between them.`,
    };
  }
  return { state: 'ready', line: 'Ready', usable: true, why: '' };
}

// A hider power tile.
export function hiderPower(view, name, cd, headStart = false) {
  const me = (view && view.me) || {};
  const powers = me.powers || {};
  const on = view && view.settings && view.settings.powers ? view.settings.powers[name] : true;
  if (!on || powers[name] === undefined || powers[name] === null) return { state: 'off', line: '', usable: false, why: '' };
  if (powers[name] === 'used') return { state: 'used', line: 'Used', usable: false, why: `You've used your ${POWERS[name].name}.` };
  if (powers[name] === 'on') {
    if (name === 'sprint') return { state: 'live', line: `On ${fmtClock(cd.sprint || 0)}`, usable: false, why: 'Sprint is on.' };
    return { state: 'live', line: name === 'jammer' ? 'On' : 'Set', usable: false, why: `${POWERS[name].name} is on until the next ping.` };
  }
  if (view.paused) return { state: 'wait', line: 'Paused', usable: false, why: 'The game is paused.' };
  if (headStart) return { state: 'wait', line: 'Not yet', usable: false, why: 'Powers work once the head start is over.' };
  if (HIDER_POWERS.some((k) => powers[k] === 'on')) {
    return { state: 'wait', line: 'Not now', usable: false, why: 'One power at a time. Wait until the one that is on is done.' };
  }
  return { state: 'ready', line: 'Ready', usable: true, why: '' };
}

// What we last know about a hider, for the tag list: 'Pinged 1:52 ago', 'Live on Radar'...
export function lastSeenWords(view, id, d = 0) {
  const m = ((view && view.marks) || []).find((x) => x && x.id === id && x.kind !== 'sos' && x.kind !== 'seen');
  if (!m) return 'No ping on them yet';
  const age = Math.max(0, (Number(m.age) || 0) + Math.max(0, d));
  switch (m.kind) {
    case 'ping': return age < 1000 ? 'Pinged just now' : `Pinged ${fmtAgo(age)}`;
    case 'radar': return 'Live on Radar';
    case 'exposure': return 'Exact spot from Exposure';
    case 'outside': return 'Outside the ring, live';
    case 'offline': return `Offline, last seen ${fmtAgo(age)}`;
    case 'overstay': return 'Live: stayed at the checkpoint'; // v1.3 PAGE-PLAY
    default: return '';
  }
}

// ---- away from Night Ops ----
// While the page is hidden (the phone locked, another app in front) it sends no location: the hunters' pings use
// the last spot it sent, and after OFFLINE_SHOW_MS they see that spot marked offline. awayFrom(view, ...) is what
// a hider's phone notes as it goes; awayNews(away, view) what to make of the first view once it's back:
//   null                       nothing to say (another game or round, too old, junk): forget it
//   { wait: true }             this view was made before the phone came back (a slow answer): wait for the next
//   { stretch: { from, to }, what: 'offline'|'old'|'', note }   server times the spot wasn't shared, what the
//                              hunters got meanwhile, and the warning to show ('' = none: short, or not a hider)

export function awayFrom(view, { clock, serverAt, at = Date.now() } = {}) {
  if (!view || view.phase !== 'live' || modeOf(view) !== 'hider') return null;
  if (!Number.isFinite(serverAt) || !Number.isFinite(at)) return null;
  return {
    code: String(view.code || ''),
    id: view.me.id,
    round: Number.isFinite(view.round) ? view.round : null,
    anchor: Number.isFinite(view.now) && Number.isFinite(view.clock) && !view.paused ? view.now - view.clock : null,
    clock: Number.isFinite(clock) ? clock : (Number.isFinite(view.clock) ? view.clock : null),
    serverAt,
    at,
  };
}

export function awayNews(away, view, wallNow = Date.now()) {
  if (!away || typeof away !== 'object' || !view || !view.me || view.phase !== 'live') return null;
  if (String(away.code || '') !== String(view.code || '') || away.id !== view.me.id) return null;
  if (!Number.isFinite(view.now) || !Number.isFinite(view.clock) || !Number.isFinite(away.serverAt) || !Number.isFinite(away.at)) return null;
  const wall = wallNow - away.at;
  if (!(wall >= -AWAY_SLACK_MS) || wall > AWAY_MOST_MS) return null;
  // The same round: its start time when the server says, else where it would have started (only pauses move it).
  if (Number.isFinite(away.round) && Number.isFinite(view.round)) {
    if (away.round !== view.round) return null;
  } else if (Number.isFinite(away.anchor) && !view.paused) {
    const moved = (view.now - view.clock) - away.anchor;
    if (moved < -AWAY_SLACK_MS || moved > AWAY_ROUND_MS) return null;
  }
  if (Number.isFinite(away.clock) && view.clock + AWAY_SLACK_MS < away.clock) return null;
  const gone = view.now - away.serverAt;
  if (gone < wall - AWAY_SLACK_MS) return { wait: true };
  const stretch = { from: away.serverAt, to: Math.max(away.serverAt, view.now) };
  const me = view.me;
  // Game time away after the head start (the hunters see nothing before it, and pauses don't count).
  let huntFrom = 0;
  try { huntFrom = schedule(view.settings).headStartMs || 0; } catch { huntFrom = 0; }
  const played = Number.isFinite(away.clock) ? view.clock - Math.max(away.clock, huntFrom) : gone;
  if (me.team !== 'hider' || me.status !== 'in' || played < AWAY_NOTE_MS) return { stretch, what: '', note: '' };
  const inside = (t) => Number.isFinite(t) && t >= stretch.from && t <= stretch.to;
  let what = '';
  for (const e of Array.isArray(view.events) ? view.events : []) {
    if (!e || e.to !== me.id || !inside(e.at)) continue;
    const result = e.data && typeof e.data === 'object' ? e.data.result : null;
    if (e.kind === 'nosignal' || (e.kind === 'ping' && result === 'nosignal')) what = 'offline';
    else if (e.kind === 'ping' && result === 'pinged' && !what) what = 'old';
  }
  if (!what) {
    const seen = (Array.isArray(view.marks) ? view.marks : []).find((m) => m && m.kind === 'seen' && m.id === me.id);
    if (seen && Number.isFinite(seen.age) && inside(view.now - seen.age)) what = 'old';
  }
  const first = `Your spot wasn't shared for ${fmtClock(Math.max(0, gone))} after you left Night Ops`;
  const fix = 'Next time use pocket mode (the moon): a black screen that still shares your spot.';
  const note = what === 'offline' ? `${first}, so the hunters saw your last spot marked offline. ${fix}`
    : what === 'old' ? `${first}, so the hunters saw an old one. ${fix}`
      : `${first}. To hide the screen, use pocket mode (the moon): it still shares your spot.`;
  return { stretch, what, note };
}

// The lines over the map, most important first. [{ key, text, tone: 'danger'|'warn'|'info'|'ok', icon, action? }]
// locRetried: Try again was tapped and location is still blocked (then the line offers a reload, which often is
// the only way a phone asks again). needsTap: the phone wouldn't keep the screen on until it's tapped (iPhones).
export function linesFor(view, c, cd, { connection = 'ok', location = 'ok', mode = modeOf(view), locRetried = false, needsTap = false } = {}) {
  const out = [];
  if (!view || view.phase !== 'live') return out;
  const me = view.me || {};
  const head = inHeadStart(view, cd);
  if (mode === 'hider' && cd.outsideFor !== null && !view.paused) {
    const of = cd.outsideFor;
    out.push(of < TIMING.OUTSIDE_SHOW_MS
      ? { key: 'outside', tone: 'danger', icon: 'warn', text: `Outside the ring! Back in within ${fmtClock(TIMING.OUTSIDE_SHOW_MS - of)} or they see you` }
      : { key: 'outside', tone: 'danger', icon: 'warn', text: `They can see you! Back in within ${fmtClock(TIMING.OUTSIDE_CATCH_MS - of)} or you're caught` });
  }
  if (connection === 'offline') out.push({ key: 'net', tone: 'warn', icon: 'warn', text: "Offline. Reconnecting when you're back online." });
  else if (connection && connection !== 'ok') out.push({ key: 'net', tone: 'warn', icon: 'clock', text: 'Reconnecting...' });
  if (mode !== 'out') {
    if (location === 'denied' && locRetried) {
      out.push({ key: 'loc:reload', tone: 'danger', icon: 'locate', text: 'Location is still blocked. Allow it for this site in your settings, then reload.', action: { label: 'Reload', reload: true } });
    } else if (location === 'denied') {
      out.push({ key: 'loc:denied', tone: 'danger', icon: 'locate', text: 'Location is blocked. Allow it for this site, then tap Try again.', action: { label: 'Try again', retryLocation: true } });
    }
    else if (location === 'unavailable') out.push({ key: 'loc', tone: 'warn', icon: 'locate', text: "Can't get your location. Turn on Location Services." });
    else if (location === 'asking') out.push({ key: 'loc', tone: 'info', icon: 'locate', text: 'Finding your location...' });
    if (needsTap) out.push({ key: 'awake', tone: 'warn', icon: 'moon', text: 'Tap the screen once so it stays on.' });
  }
  if (!head) {
    if (isClosing(view, c)) {
      const every = view.settings && view.settings.closingPingEveryMin;
      out.push(view.timing && view.timing.shrinking
        ? { key: 'closing', tone: 'warn', icon: 'target', text: 'Closing in: the ring is shrinking' }
        : { key: 'closing', tone: 'warn', icon: 'target', text: every ? `Closing in: pings every ${every} min` : 'Closing in: faster pings' });
    } else if (cd.closingIn !== null && cd.closingIn <= CLOSING_SOON_MS && cd.closingIn > 0) {
      out.push(view.settings && view.settings.shrink
        ? { key: 'closing', tone: 'info', icon: 'target', text: `Ring shrinks in ${fmtClock(cd.closingIn)}` }
        : { key: 'closing', tone: 'info', icon: 'target', text: `Faster pings in ${fmtClock(cd.closingIn)}` });
    }
  }
  for (const p of Array.isArray(view.pending) ? view.pending : []) {
    if (!p || p.hider === me.id) continue;
    const auto = Number.isFinite(p.autoIn) ? Math.max(0, p.autoIn - Math.max(0, cd.d)) : null;
    const hider = nameOf(view, p.hider);
    if (p.hunter === me.id) {
      out.push({ key: `wait:${p.id}`, tone: 'info', icon: 'clock', text: `Waiting for ${hider} to confirm${auto !== null ? ` ${fmtClock(auto)}` : ''}` });
    } else if (me.host) {
      out.push({ key: `host:${p.id}`, tone: 'info', icon: 'crown', text: `${nameOf(view, p.hunter)} tagged ${hider}. No answer yet.`, action: { label: 'Decide', catchId: p.id } });
    }
  }
  if (!head && !activeHunters(view).length && freeHiders(view).length) {
    out.push({ key: 'nohunters', tone: 'info', icon: 'info', text: me.host ? 'No hunters left. You can end the game in the menu.' : 'No hunters left. The host can end the game.' });
  }
  return out;
}

// v1.2 PAGE-MAP: the few words on the HUD's status line beside the hiders still in ("Radar live 0:41"). Pure.
export function hudNote(view, cd, mode = modeOf(view)) {
  if (!view || view.phase !== 'live') return '';
  if (view.paused) return 'Paused';
  // v1.3 PAGE-PLAY: Checkpoints leads with the open checkpoint ("CP 2: 7-Eleven 4:10"), then the rest
  if (cpOf(view) && !(cd && cd.cpDone)) {
    const lead = cpHud(view, cd ? cd.d : 0);
    const rest = hudNote(view, { ...(cd || {}), cpDone: true }, mode);
    if (lead) return rest ? `${lead} · ${rest}` : lead;
  }
  // v1.3 end PAGE-PLAY
  const radar = view.radar;
  if (radar && cd && cd.radar !== null && cd.radar !== undefined) {
    return radar.state === 'live' ? `Radar live ${fmtClock(cd.radar)}` : `Radar in ${fmtClock(cd.radar)}`;
  }
  if (mode === 'hider' && cd && cd.sprint > 0) return `Sprint ${fmtClock(cd.sprint)}`;
  if (view.timing && view.timing.closing) return view.timing.shrinking ? 'Ring shrinking' : 'Closing in';
  return '';
}

// What an event does on this phone: { moment, banner: [text, kind], buzz, beep, chat }. Pure.
export function effectOf(e, view) {
  const none = { moment: null, banner: null, buzz: null, beep: null, chat: false };
  if (!e || !view || !view.me) return none;
  const me = view.me;
  const mode = modeOf(view);
  const data = e.data && typeof e.data === 'object' ? e.data : {};
  const words = String(e.text || '');
  const say = (kind, b = null, bp = null) => ({ ...none, banner: words ? [words, kind] : null, buzz: b, beep: bp });
  switch (e.kind) {
    case 'checkpoint': return cpEffect(e, view); // v1.3 PAGE-PLAY
    case 'start':
    case 'again':
    case 'turned':
    case 'out':
      return none;
    case 'hunt':
      if (mode === 'hunter') {
        return { ...none, moment: { kicker: 'Head start over', title: 'GO', line: 'Find the hiders. Pings show roughly where they are.', kind: 'hunter' }, buzz: 'warn', beep: 'warn' };
      }
      if (mode === 'hider') {
        return { ...none, moment: { kicker: 'Head start over', title: 'Hunters are coming', line: 'Stay hidden. Stay inside the ring.', kind: 'hider' }, buzz: 'warn', beep: 'warn' };
      }
      return say('info');
    case 'ping': {
      const n = Number(data.n) || null;
      if (e.to === me.id) {
        const r = data.result;
        const good = r === 'jammer' || r === 'decoy' || r === 'sprint';
        return { ...none, moment: { kicker: n ? `Ping ${n}` : 'Ping', title: 'PING', line: words || 'You were pinged.', kind: good ? 'hider' : 'ping' }, buzz: 'ping', beep: 'ping' };
      }
      const count = Number(data.count);
      const line = !Number.isFinite(count) ? words.replace(/^Ping!\s*/, '')
        : count === 0 ? 'Nobody showed up on the map.' : count === 1 ? '1 hider on the map.' : `${count} hiders on the map.`;
      return { ...none, moment: { kicker: n ? `Ping ${n}` : 'Ping', title: 'PING', line, kind: 'ping' }, buzz: 'ping', beep: 'ping' };
    }
    case 'radar':
      if (e.to === 'hiders') {
        return { ...none, moment: { kicker: 'Warning', title: 'RADAR', line: words || 'Radar in 15 seconds!', kind: 'radar' }, buzz: 'radar', beep: 'radar' };
      }
      return say('power', 'power', 'power');
    case 'radar-live':
      if (e.to === me.id) return say('good', 'power');
      if (e.to === 'hiders') return say('warn', 'warn', 'warn');
      return say('power', 'power');
    case 'radar-over':
    case 'sprint-over':
      return say('info');
    case 'exposure':
      if (e.to === me.id) return say('good', 'power');
      if (e.to === 'hiders') return say('warn', 'warn', 'warn');
      return say('power', 'power', 'power');
    case 'power':
      // Your own power: the tile and your status card already say it's on (and Radar has its own line).
      if (data.by === me.id) return none;
      return say('power', 'power');
    case 'caught': {
      if (data.hider === me.id) {
        const hunter = data.hunter ? nameOf(view, data.hunter) : '';
        const kicker = data.how === 'ring' ? 'Outside the ring too long' : hunter ? `${hunter} caught you` : 'You were caught';
        // The view that brings this event already has my new side; the settings say it too, in case it doesn't.
        const st = view.settings || {};
        const turned = me.status === 'caught' ? false
          : (me.status === 'in' && me.team === 'hunter') || st.mode === 'infection' || st.caught !== 'out';
        return {
          ...none,
          moment: { kicker, title: 'CAUGHT', line: turned ? "You're a hunter now. Go get them!" : "You're out. You can still chat with everyone.", kind: 'caught' },
          buzz: 'caught',
          beep: 'caught',
        };
      }
      if (data.hunter === me.id) return say('catch', 'catch', 'catch');
      return say('catch', 'catch');
    }
    case 'tag':
      if (e.to === me.id) return { ...none, buzz: 'tag', beep: 'tag' }; // the "did they tag you?" sheet says it
      return say('catch', data.hider ? 'tap' : null);
    case 'denied':
      return say('warn', 'warn');
    case 'outside':
      if (e.to === me.id) return say('warn', 'warn', 'warn');
      return say('warn', 'ping');
    case 'inside':
      return say('good', 'tap');
    case 'closing':
      return say('warn', 'warn', 'warn');
    case 'sos':
      return { ...none, buzz: 'sos', beep: 'sos' }; // the SOS screen says it
    case 'resume':
      return say('good', 'tap');
    case 'chat':
      if (e.from === me.id) return none;
      return { ...none, banner: [`${nameOf(view, e.from)}: ${words}`, 'chat'], buzz: 'chat', beep: 'chat', chat: true };
    case 'over': {
      const won = Array.isArray(data.winners) && data.winners.includes(me.id);
      return { ...none, moment: { kicker: won ? 'You win' : 'Game over', title: 'GAME OVER', line: words, kind: 'win' }, buzz: 'win', beep: 'win' };
    }
    default:
      return words ? say('info') : none;
  }
}

// ---- the screen -----------------------------------------------------------------------------------------------

const SIDE_WORD = { hunter: 'Hunter', hider: 'Hider', out: 'Out' };
const POWER_ICON = { radar: 'radar', exposure: 'eye', jammer: 'jammer', decoy: 'decoy', sprint: 'sprint' };
// v1.4 PAGE-PLAY: Hacker and Wiretap's icons
POWER_ICON.hacker = 'warn';
POWER_ICON.wiretap = 'mic';
// v1.4 end PAGE-PLAY
const MOMENT_BANNER = { hunter: 'info', hider: 'info', ping: 'ping', caught: 'catch', radar: 'warn', win: 'win', sos: 'sos' };
const HELP = {
  hunter: [
    'Find the hiders and tag them for real. Then press I tagged someone: they confirm it on their phone.',
    'Every ping shows a circle for each hider. They were somewhere inside it when the ping happened.',
    'Radar shows every hider live for 1 minute, after a 15-second warning to them. Exposure shows exact spots right away, with no warning. Your team gets each once, 5 minutes apart.',
    'Keep Night Ops open so your team sees you. Pocket mode (the moon) makes the screen black.',
  ],
  hider: [
    'Stay inside the ring. Every few minutes the hunters get a ping: a circle somewhere around you.',
    "Keep Night Ops open. Locking your phone or switching apps stops sharing your spot, and the pings then show the hunters where you were. To hide the screen's light, use pocket mode (the moon): the screen goes black and your spot is still shared.",
    'Jammer skips the next ping. Decoy makes the next ping show up 200-400 m away. Sprint makes pings show where you started, for 2 minutes. One power at a time, each once.',
    'Got tagged? Be honest: press I got tagged, or say yes when your phone asks.',
  ],
  out: [
    "You're sitting out. You can still chat with everyone, but please don't give hiders away.",
  ],
};
const HELP_ALL = 'SOS pauses the game for everyone and shows everyone where you are. Use it if someone is hurt, lost or in danger. In an emergency, call 911 first.';

// Android phones can buzz; iPhones can't (no navigator.vibrate), so sound is their only alert.
function canBuzz() {
  try { return typeof globalThis.navigator?.vibrate === 'function'; } catch { return false; }
}

// What pocket mode promises on this phone (never a buzz on a phone that can't).
export function pocketWords(buzzes = canBuzz()) {
  return buzzes
    ? { label: 'Pocket mode: black screen that still buzzes', line: 'Black screen that still buzzes. Tap twice to wake.' }
    : { label: "Pocket mode: black screen. This phone can't buzz, so turn Sound on for warnings", line: "Black screen. This phone can't buzz: turn Sound on to hear warnings. Tap twice to wake." };
}

function teamWord(mode) {
  return SIDE_WORD[mode] || 'Player';
}

function ok(result) {
  return !!result && !result.error;
}

export function mount(root, app) {
  const S = {
    view: null,
    recvAt: 0,
    mode: null,
    dead: false,
    unread: 0,
    warnedPing: null,
    pendingSheet: null,  // { sheet, catchId, auto }
    tagSheet: null,      // { sheet, rows: [{ id, sub }] }
    chat: null,          // chat controller while open
    pocketStop: null,
    wokeAt: -Infinity,   // when pocket mode last woke (taps right after it go nowhere)
    locRetriedAt: 0,     // when Try again was tapped for a blocked location
    sosShown: false,
    sosKey: '',
    ringKey: '',
    overShown: false,
    wasLive: false,
    seenPending: new Set(),
    hidden: false,
    outsideBanner: null, // the "you're outside the ring" banner, closed when you're back in
    away: null,          // while this hider's page is hidden: when and where it went (see awayNews)
    stale: [],           // [{ from, to }] server times this phone wasn't sharing its spot (newest last)
  };
  const gclock = createGameClock();
  const offs = [];
  const al = app.alerts || {};
  const buzz = (p) => { try { if (p && al.buzz) al.buzz(p); } catch { /* ignore */ } };
  const beep = (k) => { try { if (k && al.beep) al.beep(k); } catch { /* ignore */ } };
  const faceSrc = (id) => (app.faces && typeof app.faces.get === 'function' ? app.faces.get(id) : null) || null;
  const locStatus = () => {
    try { return app.location && typeof app.location.status === 'function' ? app.location.status() : 'ok'; } catch { return 'ok'; }
  };
  const needsTap = () => {
    try { return !!(al.needsTap && al.needsTap()); } catch { return false; }
  };

  // A line's button: the host settles a tag, or location is asked for again (from this tap), or a reload.
  function lineAction(act) {
    if (!act) return;
    if (act.catchId) {
      decideFor(act.catchId);
    } else if (act.retryLocation) {
      S.locRetriedAt = perfNow();
      try { if (app.location && app.location.start) app.location.start(); } catch (e) { console.error(e); }
      paint();
    } else if (act.reload) {
      // (The game is saved on this phone: it opens again right where it was.)
      try { globalThis.location.reload(); } catch { /* ignore */ }
    }
  }

  // ---- the HUD ----

  // v1.2 PAGE-MAP: a slim bar over the big map.
  //   row 1 (44px): team dot + side word | time left | next ping | slot (S.hudSlot) | SOS | menu
  //   row 2 (22px): the hiders still in (small faces) and a short status ("Radar live 0:41"); the ping's 3px bar
  const teamSide = h('span.g-team-side');
  const teamName = h('span.g-team-name.sr-only');
  // Under 390px the pill has no room for the side word: a role icon stands for it (target, eye, car, a cross).
  const teamIcon = h('span.g-team-icon', { 'aria-hidden': 'true' });
  const teamPill = h('div.g-team', h('span.g-team-dot', { 'aria-hidden': 'true' }), teamIcon, teamSide,
    h('span.sr-only', ', '), teamName);
  const leftNum = h('span.g-left-num');
  const leftBox = h('div.g-left', h('span.label.g-left-label', 'Left'), leftNum);
  const sosBtn = h('button.g-sos', { type: 'button', 'aria-label': 'SOS: pause the game and get help', onclick: () => askSos() },
    icon('sos', 18), h('span', { 'aria-hidden': 'true' }, 'SOS'));
  const moreBtn = h('button.g-more', { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'dialog', onclick: () => openMenu() }, icon('menu', 22));
  const pingLabel = h('span.label.g-ping-label');
  const pingNum = h('span.g-ping-num');
  const pingText = h('div.g-ping-text', pingLabel, pingNum);
  const pingBox = h('div.g-ping', pingText);
  S.hudSlot = h('span.g-hud-slot'); // v1.2: PAGE-CAM's REC dot goes here
  // v1.2 PAGE-CAM: the REC dot, or "Tap to start your camera" (a filmed player only)
  const camParts = gameCamParts({ app });
  S.hudSlot.appendChild(camParts.hud);
  // v1.2 end PAGE-CAM
  const cpp = cpParts({ app }); // v1.3 PAGE-PLAY: the Checkpoints card and "Take the photo"
  const topBar = h('div.g-topbar', teamPill, leftBox, pingBox, S.hudSlot, sosBtn, moreBtn);
  const hidersLabel = h('span.g-hiders-label');
  const hidersFaces = h('div.g-hfaces');
  const hidersBox = h('div.g-hiders', { role: 'img' }, hidersFaces, hidersLabel);
  const hudNoteEl = h('span.g-hudnote');
  const hudLineBox = h('div.g-hudline', hidersBox, hudNoteEl);
  // v1.1 PAGE-WATCH: "N watching" (an eye and the number) beside your team, when anyone watches
  const watchChip = h('span.g-watching', { hidden: true, role: 'img' }, icon('eye', 14), h('span.g-watching-n'));
  hudLineBox.append(watchChip); // v1.2 PAGE-MAP: on the status line
  function paintWatching(view) {
    const n = Number(view && view.watching) || 0;
    watchChip.hidden = !(n > 0);
    text(watchChip.querySelector('.g-watching-n'), String(n));
    watchChip.setAttribute('aria-label', `${n} watching`);
  }
  // v1.1 end PAGE-WATCH
  // v1.4 PAGE-DEVICES: "Location: live" on the status line, the fix-it layer, its red bar and the camera tap button
  const fixIt = createFixIt({ app, root });
  const locWord = h('span.fx-locword');
  hudLineBox.append(locWord);
  // v1.4 end PAGE-DEVICES
  const barFill = h('div.g-bar-fill');
  const bar = h('div.g-bar', { 'aria-hidden': 'true' }, barFill);
  const hud = h('header.g-hud', topBar, hudLineBox, bar);

  // ---- the map and what floats over it ----

  const mapBox = h('div.g-map');
  const linesBox = h('div.g-lines');
  const lineEls = new Map();
  const headKicker = h('p.g-head-kicker', 'Head start');
  const headTitle = h('h2.g-head-title', 'Hiders are hiding');
  const headNum = h('p.g-head-num');
  const headFill = h('div.g-bar-fill');
  const headLine = h('p.g-head-line', "Don't peek. The hunt starts when this hits zero.");
  const headCard = h('div.g-head', { hidden: true },
    h('div.g-head-card', headKicker, headTitle, headNum, h('div.g-bar.g-head-bar', { 'aria-hidden': 'true' }, headFill), headLine));
  // v1.2 PAGE-MAP: round buttons on the map: Centre on me, Fit everyone, Pocket mode, and + / - on the plain map.
  const meBtn = h('button.g-mapbtn.map-btn.g-mebtn', { type: 'button', 'aria-label': 'Centre on me', onclick: () => centerOnMe() }, icon('locate', 22));
  const ringBtn = h('button.g-mapbtn.map-btn.g-fitbtn', { type: 'button', 'aria-label': 'Fit everyone: the ring and every mark', onclick: () => fitEveryone() }, icon('fit', 22));
  const pocketBtn = h('button.g-mapbtn.map-btn.g-pocketbtn', { type: 'button', 'aria-label': pocketWords().label, onclick: () => pocketOn() }, icon('moon', 22));
  const zoomInBtn = h('button.g-mapbtn.map-btn.g-zoombtn', { type: 'button', 'aria-label': 'Zoom in', hidden: true, onclick: () => { if (map) map.zoomBy(1); } }, icon('plus', 22));
  const zoomOutBtn = h('button.g-mapbtn.map-btn.g-zoombtn', { type: 'button', 'aria-label': 'Zoom out', hidden: true, onclick: () => { if (map) map.zoomBy(-1); } }, icon('minus', 22));
  const mapBtns = h('div.g-mapbtns', meBtn, ringBtn, pocketBtn, zoomInBtn, zoomOutBtn);
  // Once per phone, a hider's first game: pocket mode instead of locking the phone (which stops sharing your spot).
  const tipClose = h('button.g-tip-close', { type: 'button', 'aria-label': 'Got it, hide this tip', onclick: () => tipDone(true) }, icon('close', 18));
  const tip = h('div.g-tip', { hidden: true, role: 'note' },
    h('span.g-tip-icon', icon('moon', 18)),
    h('p.g-tip-text', h('strong', "Don't lock your phone:"), ' it stops sharing your spot. Pocket mode (the moon) blacks out the screen instead.'),
    tipClose);
  const mapWrap = h('div.g-mapwrap', mapBox, linesBox, headCard, mapBtns, tip);
  S.tipDone = (() => { try { return globalThis.localStorage?.getItem(POCKET_TIP_KEY) === '1'; } catch { return false; } })();
  function tipDone(focusMoon = false) {
    if (S.tipDone) return;
    S.tipDone = true;
    try { globalThis.localStorage?.setItem(POCKET_TIP_KEY, '1'); } catch { /* ignore */ }
    const had = tip.contains(document.activeElement);
    tip.hidden = true;
    if (focusMoon || had) { try { pocketBtn.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  // ---- the panel: v1.2 PAGE-MAP's bottom tray (a main row, and more rows while it's open) ----

  const tray = createTray({ label: 'Your moves', onState: () => { placeBanners(); } });
  const panel = tray.el;
  panel.classList.add('g-panel');
  let P = {}; // the current panel's parts

  // ---- the SOS screen ----

  const sosTitle = h('h2.g-sos-title', { id: 'g-sos-title' });
  const sosLine = h('p.g-sos-line', { id: 'g-sos-line' });
  const sosDist = h('p.g-sos-dist');
  const sosResume = h('button.btn.wide.g-sos-resume', { type: 'button', onclick: () => resume() });
  const sosNote = h('p.g-sos-note');
  const sosLayer = h('div.g-sos-layer', { hidden: true, role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'g-sos-title', 'aria-describedby': 'g-sos-line' },
    h('div.g-sos-top', h('p.g-sos-kicker', icon('sos', 16), h('span', 'Game paused')), sosTitle, sosLine, sosDist),
    h('div.g-sos-mid', { 'aria-hidden': 'true' }),
    h('div.g-sos-bottom',
      h('a.btn.danger.wide.g-sos-call', { href: 'tel:911' }, icon('sos', 20), 'Call 911'),
      h('button.btn.ghost.wide.g-sos-show', { type: 'button', onclick: () => showSosSpot() }, icon('pin', 20), 'Show them on the map'),
      sosResume, sosNote));

  root.classList.add('g-root');
  // v1.1 PAGE-RADIO: the walkie-talkie readies its sound from every real tap itself (alerts.onTap: a touch's
  // pointerdown isn't a tap to an iPhone).
  fill(root, mapWrap, hud, panel, sosLayer); // v1.2 PAGE-MAP: the map under everything, edge to edge
  hud.after(fixIt.tapBtn); // v1.4 PAGE-DEVICES
  linesBox.prepend(fixIt.bar); // v1.4 PAGE-DEVICES: the red bar leads the lines over the map

  // News banners go under the HUD on this screen, so the time left, the next ping and SOS are never covered
  // (game.css reads --g-hud-bottom). On the SOS screen they go back to the top.
  // v1.2 PAGE-MAP: the map fills the screen under the HUD and the tray: --g-tray-top (px from the top) and
  // --g-tray-h say where the tray starts, the map is told what they hide (setInsets), and the map's buttons sit in
  // the gap between them (a row along the tray's top when the gap is small).
  const rootStyle = document.documentElement.style;
  const setVar = (k, v) => { if (rootStyle.getPropertyValue(k) !== v) rootStyle.setProperty(k, v); };
  function placeBanners() {
    if (S.dead) return;
    const vh = globalThis.innerHeight || 0;
    const bottom = S.sosShown ? 0 : Math.max(0, Math.round(hud.getBoundingClientRect().bottom));
    const trayTop = S.sosShown ? vh : Math.round(tray.el.getBoundingClientRect().top) || vh;
    setVar('--g-hud-bottom', `${bottom}px`);
    setVar('--g-tray-top', `${trayTop}px`);
    setVar('--g-tray-h', `${Math.max(0, vh - trayTop)}px`);
    const at = placeMapButtons(bottom, trayTop, vh);
    // The map's buttons sit over the map: Fit everyone and Centre on me keep clear of them, and so do the map's
    // credits and scale bar (insets).
    if (map) { try { map.setInsets({ top: bottom, ...mapButtonInsets(at, vh, trayTop) }); } catch { /* ignore */ } }
  }
  function placeMapButtons(hudBottom, trayTop, vh) {
    const shown = [...mapBtns.children].filter((b) => !b.hidden).length;
    const at = { ...mapButtonsPlace({ hudBottom, trayTop, height: vh, count: shown }), shown };
    if (mapBtns.dataset.mode !== at.mode) mapBtns.dataset.mode = at.mode;
    const top = at.mode === 'column' ? `${at.top}px` : '';
    const bot = at.mode === 'row' ? `${at.bottom}px` : '';
    if (mapBtns.style.top !== top) mapBtns.style.top = top;
    if (mapBtns.style.bottom !== bot) mapBtns.style.bottom = bot;
    // v1.2 integration: a row of map buttons along the tray's top lifts the lines that float there ("Sam is
    // talking", "Mia sent a message (2 s)") above it, so they never cover the buttons.
    const lift = at.mode === 'row' ? Math.max(0, Math.round(trayTop - mapBtns.getBoundingClientRect().top)) : 0;
    setVar('--g-btnrow-lift', `${lift}px`);
    // v1.2 end integration
    // The pocket tip points at the moon (and waits while there's no room beside the buttons).
    cls(tip, 'no-room', at.mode === 'row');
    if (!tip.hidden) {
      const r = pocketBtn.getBoundingClientRect();
      const b = at.mode === 'column' ? `${Math.round(vh - r.bottom)}px` : `${Math.round(vh - r.top + 10)}px`;
      if (tip.style.bottom !== b) tip.style.bottom = b;
      tip.dataset.mode = at.mode;
    }
    return at;
  }
  let hudWatch = null;
  try {
    hudWatch = new ResizeObserver(() => placeBanners());
    hudWatch.observe(hud);
    hudWatch.observe(tray.el);
  } catch { /* an old browser: the next update places them */ }
  offs.push(listen(window, 'resize', () => placeBanners()));

  let map = null;
  try {
    map = createMap(mapBox, { interactive: true });
  } catch (e) {
    console.error(e);
    map = null;
  }
  // v1.2 PAGE-MAP: + and - only on the plain map (the street map pinches).
  function paintZoom() {
    if (S.dead) return;
    const plainMap = !!map && S.mapFinal && map.mode() === 'plain';
    zoomInBtn.hidden = !plainMap;
    zoomOutBtn.hidden = !plainMap;
    placeBanners();
  }
  // v1.4 PAGE-PLAY: team pins (hunters and the driver): the tray's Pin, a tap on a pin for its words
  let pinTool = null;
  try { pinTool = map ? createPinTool(app, { map, getView: () => S.view, banner }) : null; } catch (e) { console.error(e); }
  // v1.4 end PAGE-PLAY
  if (map) {
    // (While the street map loads, the plain map shows for a moment: + and - wait for the final choice.)
    map.ready.then(() => { S.mapFinal = true; paintZoom(); });
    offs.push(map.onMode(() => { S.mapFinal = true; paintZoom(); }));
  }

  // ---- the panel per side ----

  function chatPreview() {
    const lines = h('span.g-chat-lines');
    const badge = h('span.g-chat-badge', { hidden: true, 'aria-hidden': 'true' });
    const unread = h('span.sr-only');
    const btn = h('button.g-chat', { type: 'button', onclick: () => openChatSheet() },
      h('span.sr-only', 'Open chat. '),
      unread,
      lines,
      h('span.g-chat-icon', icon('chat', 22), badge));
    return { btn, lines, badge, unread, key: '' };
  }

  function quickRow(view) {
    const words = quickFor(view);
    if (!words.length) return null;
    return h('div.g-quick', { role: 'group', 'aria-label': 'Quick messages to your team' },
      words.map((w) => h('button.chip.g-qbtn', { type: 'button', onclick: (ev) => quickSend(ev.currentTarget, w) }, w)));
  }

  function powerTile(name) {
    const state = h('span.g-power-state');
    const btn = h('button.g-power', { type: 'button', 'data-power': name, onclick: () => onPower(name) },
      h('span.g-power-icon', icon(POWER_ICON[name] || 'info', 22)),
      h('span.g-power-text', h('span.g-power-name', POWERS[name].name), state));
    return { name, btn, state };
  }

  // A chip in the tray's main row that stands for the role: a tap opens the tray.
  function trayChip(cls2, iconName) {
    const ic = h('span.tray-chip-icon', icon(iconName, 22));
    const title = h('strong.tray-chip-title');
    const sub = h('span.tray-chip-sub');
    const btn = h(`button.tray-chip.${cls2}`, { type: 'button', 'aria-controls': tray.more.id, onclick: () => tray.set(tray.state === 'open' ? 'tucked' : 'open') },
      ic, h('span.tray-chip-words', title, sub));
    return { btn, ic, title, sub, iconName };
  }

  // v1.2 PAGE-MAP: what goes in the tray, per role ('hunter' | 'hider' | 'out' | 'driver').
  // Each part: { el, main: true (the 56px main row) | false (the more rows), order, grow (stretches in the main row) }.
  // Main rows: hunter = Tag, walkie, Record this, chat; hider = status chip, walkie, Quiet, chat; out = "You're out"
  // chip, chat; parked driver = pickups chip, walkie, chat. PAGE-RADIO and PAGE-CAM add theirs below, marked.
  function trayParts(role, view) {
    const parts = [];
    if (role === 'hunter') {
      parts.push({ el: P.tagBtn, main: true, grow: true, order: 10 });
      parts.push({ el: P.drive.el, main: false, order: 10 });
      parts.push({ el: P.powers, main: false, order: 20 });
    } else if (role === 'driver') {
      parts.push({ el: P.chip.btn, main: true, grow: true, order: 10 });
      parts.push({ el: P.drive.el, main: false, order: 10 });
    } else if (role === 'hider') {
      parts.push({ el: P.chip.btn, main: true, grow: true, order: 10 });
      parts.push({ el: P.status, main: false, order: 5 });
      parts.push({ el: P.powers, main: false, order: 20 });
    } else {
      parts.push({ el: P.chip.btn, main: true, grow: true, order: 10 });
      parts.push({ el: P.out, main: false, order: 5 });
    }
    // v1.1 PAGE-RADIO: the walkie-talkie (hold to talk; its line says "Sam is talking"); v1.2: a square in the main row
    if ((role === 'hunter' || role === 'driver') && app.radio) {
      try { parts.push({ el: app.radio.button(), main: true, order: 20 }); } catch (e) { console.error(e); }
    }
    // v1.1 end PAGE-RADIO
    // v1.2 PAGE-RADIO: the hiders' walkie-talkie (with "Walkie-talkie for hiders too"): hold to talk and Quiet in
    // the main row, the messages Quiet held (and the earbuds hint) in the more rows. A caught hider who joins the
    // hunters gets the hunters' button above (the panel is built again for the new role).
    if (role === 'hider' && app.radio && view && (view.radio || (view.settings && view.settings.radioHiders))) {
      try {
        parts.push({ el: app.radio.button(), main: true, order: 20 });
        parts.push({ el: app.radio.quietButton(), main: true, order: 30 });
        parts.push({ el: app.radio.heldList(), main: false, order: 7 });
      } catch (e) { console.error(e); }
    }
    // v1.2 end PAGE-RADIO
    // v1.4 PAGE-PLAY: Pin (hunters, when team pins are on)
    if (pinTool && role === 'hunter' && view && Array.isArray(view.pins)) parts.push({ el: pinTool.btn, main: true, order: 25 });
    // v1.4 end PAGE-PLAY
    // v1.2 PAGE-CAM: Record this (main row for hunters, in the more rows for the rest)
    { const rp = camParts.recordPart(role); if (rp) parts.push(rp); }
    // v1.2 end PAGE-CAM
    // v1.3 PAGE-PLAY: Checkpoints: the card in the more rows (every role); a free hider inside the open checkpoint
    // gets "Take the photo" in place of the status chip (cpSwap keeps it right as they come and go)
    P.cpParts = null;
    if (cpOf(view)) {
      parts.push({ el: cpp.card, main: false, order: 6 });
      if (role === 'hider' && P.chip) {
        const i = parts.findIndex((x) => x.el === P.chip.btn);
        P.cpMain = cpp.wantsMain(view);
        P.cpSlots = { i, chip: parts[i], main: { el: cpp.main, main: true, grow: true, order: 10 } };
        if (i >= 0 && P.cpMain) parts[i] = P.cpSlots.main;
      }
      P.cpParts = parts;
    }
    // v1.3 end PAGE-PLAY
    parts.push({ el: P.chatBtn, main: true, order: 90 });
    // The last chat lines and the quick buttons.
    parts.push({ el: P.talk, main: false, order: 80 });
    return parts;
  }

  function buildPanel(mode, view) {
    P = { mode, tiles: [], chat: chatPreview() };
    const driver = mode === 'hunter' && !!(view && view.me && view.me.driver);
    if (mode === 'hunter') {
      P.tagText = h('span.g-tag-text', 'I tagged someone');
      P.tagNote = h('span.g-tag-note', { hidden: true });
      P.tagBtn = h('button.btn.primary.wide.g-tag', { type: 'button', onclick: () => openTagSheet() },
        icon('target', 22), h('span.g-tag-words', P.tagText, P.tagNote));
      P.powers = h('div.g-powers');
      // v1.1 PAGE-DRIVER: the driver never tags and has no powers (their card instead); others get Pick me up
      P.drive = driver ? driverCard(app) : pickMeUp(app);
      if (driver) P.chip = trayChip('g-pickups', 'car');
      // v1.1 end PAGE-DRIVER
    } else if (mode === 'hider') {
      P.statusIcon = h('span.g-status-icon');
      P.statusTitle = h('strong.g-status-title');
      P.statusLine = h('span.g-status-line');
      P.gotTagged = h('button.g-gottag', { type: 'button', onclick: () => openGotTagged() }, 'I got tagged');
      P.status = h('div.g-status', P.statusIcon, P.statusTitle, P.gotTagged, P.statusLine);
      P.powers = h('div.g-powers');
      P.chip = trayChip('g-hstat', 'check');
    } else {
      P.outLine = h('p.g-out-line');
      P.outHiders = h('div.g-out-hiders');
      P.outLabel = h('span.label.g-out-label');
      P.out = h('div.g-out', h('div.g-out-head', icon('flag', 22), h('strong.g-out-title', "You're out")), P.outLine, P.outLabel, P.outHiders);
      P.chip = trayChip('g-outchip', 'flag');
      text(P.chip.title, "You're out");
    }
    P.chatBadge = h('span.tray-badge', { hidden: true, 'aria-hidden': 'true' });
    P.chatBtn = h('button.tray-sq.g-chatbtn', { type: 'button', 'aria-label': 'Chat', onclick: () => openChatSheet() }, icon('chat', 24), P.chatBadge);
    const quick = quickRow(view);
    P.talk = h(`div.g-talk${quick ? '.has-quick' : ''}`, P.chat.btn, quick);
    const { main, more } = splitParts(trayParts(driver ? 'driver' : mode, view));
    tray.setMain(main.map((p) => ({ el: p.el, grow: !!p.grow })));
    tray.setMore(more.map((p) => p.el));
    panel.dataset.mode = mode;
    P.tileKey = '';
    placeBanners();
  }

  function paintPowers(view, cd, head) {
    if (!P.powers) return;
    const list = P.mode === 'hunter' ? HUNTER_POWERS : HIDER_POWERS;
    const states = list.map((name) => [name, P.mode === 'hunter' ? hunterPower(view, name, cd, head) : hiderPower(view, name, cd, head)]);
    const shown = states.filter(([, st]) => st.state !== 'off').map(([name]) => name);
    const key = shown.join(',');
    if (key !== P.tileKey) {
      P.tileKey = key;
      P.tiles = shown.map(powerTile);
      fill(P.powers, P.tiles.map((t) => t.btn));
      P.powers.dataset.n = String(shown.length);
      P.powers.hidden = !shown.length;
    }
    for (const t of P.tiles) {
      const st = states.find(([name]) => name === t.name)[1];
      text(t.state, st.line);
      if (t.btn.dataset.state !== st.state) t.btn.dataset.state = st.state;
      const dis = st.usable ? null : 'true';
      if (t.btn.getAttribute('aria-disabled') !== dis) {
        if (dis) t.btn.setAttribute('aria-disabled', 'true');
        else t.btn.removeAttribute('aria-disabled');
      }
      t.why = st.why;
    }
  }

  function paintChatPreview(view) {
    const c = P.chat;
    if (!c) return;
    const events = (view && view.events) || [];
    let last = null;
    for (let i = events.length - 1; i >= 0; i--) if (events[i] && events[i].kind === 'chat') { last = events[i]; break; }
    const key = `${last ? last.id : 0}:${S.mode}:${app.faces ? app.faces.size : 0}`;
    if (key !== c.key) {
      c.key = key;
      const n = renderLines(c.lines, events, app, { limit: 2 });
      if (!n) fill(c.lines, h('span.g-chat-empty', 'Chat with your team'));
    }
    const badgeText = S.unread > 9 ? '9+' : String(S.unread);
    text(c.badge, S.unread ? badgeText : '');
    c.badge.hidden = !S.unread;
    text(c.unread, S.unread ? `${S.unread} new ${S.unread === 1 ? 'message' : 'messages'}. ` : '');
    // v1.2 PAGE-MAP: the tray's chat square
    if (P.chatBadge) {
      text(P.chatBadge, S.unread ? badgeText : '');
      P.chatBadge.hidden = !S.unread;
      const label = S.unread ? `Chat, ${S.unread} new` : 'Chat';
      if (P.chatBtn.getAttribute('aria-label') !== label) P.chatBtn.setAttribute('aria-label', label);
    }
  }

  // ---- painting (on every view and every tick) ----

  function setHidden(el, hide) {
    if (el.hidden !== !!hide) el.hidden = !!hide;
  }

  function paintHiders(view, head) {
    const row = hidersRow(view);
    const free = row.filter((r) => !r.caught);
    const key = row.map((r) => `${r.id}:${r.caught ? 1 : 0}:${faceSrc(r.id) ? 1 : 0}`).join('|');
    text(hidersLabel, `${free.length} ${free.length === 1 ? 'hider' : 'hiders'} ${head ? 'hiding' : 'left'}`);
    if (hidersBox.dataset.key === key) return;
    hidersBox.dataset.key = key;
    const shown = row.slice(0, MOST_FACES);
    const more = row.length - shown.length;
    fill(hidersFaces,
      shown.map((r) => h(`span.g-hface${r.caught ? '.caught' : ''}`,
        face({ name: r.name, src: faceSrc(r.id), team: r.caught ? 'out' : 'hider', size: 18 }))),
      more > 0 ? h('span.g-hmore', `+${more}`) : null);
    const caught = row.filter((r) => r.caught).map((r) => r.name);
    hidersBox.setAttribute('aria-label',
      `${free.length} ${free.length === 1 ? 'hider' : 'hiders'} still in${free.length ? `: ${free.map((r) => r.name).join(', ')}` : ''}.` +
      (caught.length ? ` Caught: ${caught.join(', ')}.` : ''));
    setHidden(hidersBox, !row.length);
  }

  function paintLines(view, c, cd) {
    const loc = locStatus();
    if (loc !== 'denied') S.locRetriedAt = 0;
    const list = linesFor(view, c, cd, {
      connection: app.connection,
      location: fixIt.handling() ? 'ok' : loc, // v1.4 PAGE-DEVICES: the fix-it layer / red bar says it instead
      mode: S.mode,
      locRetried: S.locRetriedAt > 0 && perfNow() - S.locRetriedAt > LOC_RETRY_WAIT_MS,
      needsTap: needsTap(),
    });
    const keys = list.map((l) => l.key);
    for (const [key, rec] of lineEls) {
      if (!keys.includes(key)) {
        rec.el.remove();
        lineEls.delete(key);
      }
    }
    let prev = null;
    for (const l of list) {
      let rec = lineEls.get(l.key);
      if (!rec) {
        const words = h('span.g-line-text');
        const act = l.action;
        const btn = act ? h('button.g-line-btn', { type: 'button', onclick: () => lineAction(act) }, act.label) : null;
        const el = h('div.g-line', h('span.g-line-icon', icon(l.icon || 'info', 18)), words, btn);
        rec = { el, words, icon: l.icon };
        lineEls.set(l.key, rec);
      }
      if (rec.el.dataset.tone !== l.tone) rec.el.dataset.tone = l.tone;
      text(rec.words, l.text);
      // Keep the order without moving nodes that are already in place.
      const want = prev ? prev.nextSibling : linesBox.firstChild;
      if (want !== rec.el) linesBox.insertBefore(rec.el, want);
      prev = rec.el;
    }
  }

  // v1.2 PAGE-MAP: a tray chip's words, icon and tone.
  function paintChip(chip, title, sub, iconName, tone) {
    if (!chip) return;
    text(chip.title, title);
    text(chip.sub, sub || '');
    if (chip.iconName !== iconName) { chip.iconName = iconName; fill(chip.ic, icon(iconName, 22)); }
    if (chip.btn.dataset.tone !== tone) chip.btn.dataset.tone = tone;
    const label = `${title}${sub ? `. ${sub}` : ''}. ${tray.state === 'open' ? 'Show less' : 'Show more'}`;
    if (chip.btn.getAttribute('aria-label') !== label) chip.btn.setAttribute('aria-label', label);
    chip.btn.setAttribute('aria-expanded', tray.state === 'open' ? 'true' : 'false');
  }

  function paint() {
    const view = S.view;
    if (!view || S.dead) return;
    const c = gclock.read();
    const cd = countdowns(view, c);
    const mode = S.mode;
    const head = inHeadStart(view, cd);
    const live = view.phase === 'live';
    cpSwap(view, c); // v1.3 PAGE-PLAY

    // Top bar.
    text(teamSide, view.me && view.me.driver && mode === 'hunter' ? 'Driver' : teamWord(mode)); // v1.1 PAGE-DRIVER: Driver
    {
      const roleIcon = view.me && view.me.driver && mode === 'hunter' ? 'car' : ({ hunter: 'target', hider: 'eye', out: 'close' }[mode] || 'circle');
      if (teamIcon.dataset.icon !== roleIcon) { teamIcon.dataset.icon = roleIcon; fill(teamIcon, icon(roleIcon, 16)); }
    }
    text(teamName, view.me && view.me.name ? view.me.name : '');
    text(leftNum, cd.left === null ? '--:--' : fmtClock(cd.left));
    setHidden(sosBtn, !live || view.paused);

    // The big countdown.
    const pi = pingInfo(view, cd, mode);
    const hunterHead = head && mode === 'hunter';
    setHidden(pingText, pi.kind === 'none' || hunterHead);
    setHidden(pingBox, pi.kind === 'none' || hunterHead); // v1.2 PAGE-MAP
    setHidden(bar, pi.kind === 'none' || hunterHead);
    text(pingLabel, pi.label);
    text(pingNum, pi.ms === null ? '--:--' : fmtClock(pi.ms));
    cls(pingBox, 'is-warn', pi.warn);
    cls(pingBox, 'is-head', pi.kind === 'headstart');
    cls(bar, 'is-warn', pi.warn);
    const frac = pi.frac.toFixed(4);
    if (barFill.dataset.n !== String(pi.n) || barFill.dataset.kind !== pi.kind) {
      // A new countdown: refill at once instead of sliding back up.
      barFill.classList.add('snap');
      barFill.dataset.n = String(pi.n);
      barFill.dataset.kind = pi.kind;
      barFill.style.transform = `scaleX(${frac})`;
      void barFill.offsetWidth;
      barFill.classList.remove('snap');
    } else if (barFill.dataset.f !== frac) {
      barFill.style.transform = `scaleX(${frac})`;
    }
    barFill.dataset.f = frac;

    // A buzz when the ping warning starts (hiders).
    if (pi.warn && pi.kind === 'ping' && !view.paused && pi.ms > 0 && S.warnedPing !== pi.n && !S.hidden) {
      S.warnedPing = pi.n;
      buzz('warn');
      beep('warn');
    }

    paintHiders(view, head);
    // v1.2 PAGE-MAP; v1.4 PAGE-DEVICES: then who on my team has no location
    { const a = hudNote(view, cd, mode); const b = fixIt.lostWords(view); text(hudNoteEl, a && b ? `${a} · ${b}` : a || b); }
    { const w = view.phase === 'live' && view.me && view.me.status === 'in' ? fixIt.statusWord(view) : ''; text(locWord, w); locWord.dataset.k = /off/.test(w) ? 'bad' : /old|finding/.test(w) ? 'warn' : 'ok'; locWord.hidden = !w; }

    // Head start card (hunters).
    setHidden(headCard, !hunterHead);
    if (hunterHead) {
      text(headNum, fmtClock(cd.headStart));
      const f = pi.frac.toFixed(4);
      if (headFill.dataset.f !== f) {
        headFill.style.transform = `scaleX(${f})`;
        headFill.dataset.f = f;
      }
    }

    paintLines(view, c, cd);
    setHidden(meBtn, mode === 'out');
    setHidden(mapBtns, hunterHead);
    setHidden(tip, S.tipDone || mode !== 'hider' || !live || !!view.paused || !!S.pocketStop);

    // The panel.
    if (P.mode === 'hunter') {
      const canTag = live && !head && !view.paused;
      if (canTag) P.tagBtn.removeAttribute('aria-disabled');
      else P.tagBtn.setAttribute('aria-disabled', 'true');
      setHidden(P.tagNote, canTag);
      text(P.tagNote, view.paused ? 'Game paused' : head ? 'After the head start' : '');
      paintPowers(view, cd, head);
      // v1.2 PAGE-MAP: the parked driver's chip
      if (P.chip && view.me && view.me.driver) {
        const n = pickupLines(view).length;
        const parked = !!(view.drive && view.drive.parked);
        paintChip(P.chip, n ? `${n} ${n === 1 ? 'pickup' : 'pickups'}` : parked ? 'Parked' : 'Driving',
          n ? 'Tap to see who' : parked ? 'Hiders near the car show live' : '', 'car', n ? 'warn' : 'info');
      }
    } else if (P.mode === 'hider') {
      const st = cpStatusOr(hiderStatus(view, c, cd, { stale: S.stale }), view, c); // v1.3 PAGE-PLAY: cpStatusOr
      if (P.status.dataset.tone !== st.tone) P.status.dataset.tone = st.tone;
      if (P.statusIcon.dataset.icon !== st.icon) {
        P.statusIcon.dataset.icon = st.icon;
        fill(P.statusIcon, icon(st.icon, 24));
      }
      text(P.statusTitle, st.title);
      text(P.statusLine, st.line);
      paintChip(P.chip, st.title, st.tone === 'ok' ? '' : st.line.length <= 34 ? st.line : '', st.icon, st.tone); // v1.2 PAGE-MAP
      if (head || view.paused) P.gotTagged.setAttribute('aria-disabled', 'true');
      else P.gotTagged.removeAttribute('aria-disabled');
      paintPowers(view, cd, head);
    } else if (P.mode === 'out') {
      const me = view.me || {};
      const by = me.caught && me.caught.by ? nameOf(view, me.caught.by) : '';
      let line;
      if (me.status === 'caught') line = by ? `${by} caught you.` : 'You were caught.';
      else line = "You're not on a team right now.";
      text(P.outLine, `${line} You can still chat with everyone.`);
      paintChip(P.chip, "You're out", by ? `${by} caught you` : '', 'flag', 'info'); // v1.2 PAGE-MAP
      const free = freeHiders(view);
      text(P.outLabel, free.length ? `Still hiding (${free.length})` : 'Nobody is hiding any more');
      const key = free.map((p) => `${p.id}:${faceSrc(p.id) ? 1 : 0}`).join('|');
      if (P.outHiders.dataset.key !== key) {
        P.outHiders.dataset.key = key;
        fill(P.outHiders, free.map((p) => h('span.g-out-hider',
          face({ name: p.name, src: faceSrc(p.id), team: 'hider', size: 32 }), h('span.g-out-name', p.name))));
      }
    }
    paintChatPreview(view);

    // Tags waiting for me, the tag list's ages, the SOS distance.
    if (S.pendingSheet && S.pendingSheet.auto) {
      const p = (view.pending || []).find((x) => x && x.id === S.pendingSheet.catchId);
      if (p && Number.isFinite(p.autoIn)) {
        const left = Math.max(0, p.autoIn - Math.max(0, cd.d));
        text(S.pendingSheet.auto, `If you don't answer, it counts as a catch in ${fmtClock(left)}.`);
      }
    }
    if (S.tagSheet) {
      for (const r of S.tagSheet.rows) text(r.sub, r.busy ? 'Sending...' : r.waiting ? 'Waiting for them to confirm' : lastSeenWords(view, r.id, cd.d));
    }
    if (S.sosShown) paintSosDistance(view);
  }

  // v1.3 PAGE-PLAY: the checkpoint parts follow the view and the clock; the main row swaps "Take the photo" and the
  // status chip; the hider's chip says when a checkpoint matters more (exposed, safe inside) than the usual status.
  function cpSwap(view, c) {
    if (!P.cpParts) return;
    cpp.update(view, c);
    const slots = P.cpSlots;
    if (!slots || slots.i < 0) return;
    const want = cpp.wantsMain(view);
    if (want === P.cpMain) return;
    P.cpMain = want;
    P.cpParts[slots.i] = want ? slots.main : slots.chip;
    const { main } = splitParts(P.cpParts);
    tray.setMain(main.map((p) => ({ el: p.el, grow: !!p.grow })));
    placeBanners();
  }
  function cpStatusOr(st, view, c) {
    if (!P.cpParts || !st || st.key === 'outside' || st.key === 'headstart') return st;
    const cs = cpp.status(view, c);
    if (!cs) return st;
    return cs.tone === 'danger' || st.tone === 'ok' || st.tone === 'info' ? cs : st;
  }
  // v1.3 end PAGE-PLAY

  function tick() {
    if (S.dead) return;
    S.hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (S.hidden) return;
    try {
      paint();
    } catch (e) {
      console.error(e);
    }
  }

  // ---- map ----

  function paintMap(view) {
    if (!map) return;
    const ring = view.ringNow || view.ring;
    const key = JSON.stringify([view.ring, view.ringNow]);
    if (key !== S.ringKey && ring) {
      S.ringKey = key;
      try { map.setRing(view.ring, view.ringNow); } catch (e) { console.error(e); }
    }
    const hunter = S.mode === 'hunter';
    try {
      map.setMarks(view.marks || [], {
        faces: app.faces,
        players: view.players,
        meId: view.me ? view.me.id : null,
        onTap: hunter ? (mark) => onMarkTap(mark) : undefined,
        paused: !!view.paused,
      });
    } catch (e) {
      console.error(e);
    }
    // v1.3 PAGE-PLAY: the checkpoints this phone may see (open, closed, the hider's own done ones ticked)
    if (typeof map.setSpots === 'function' && (cpOf(view) || S.cpSpotsKey)) {
      const spots = spotsFor(view);
      const key = JSON.stringify(spots);
      if (key !== S.cpSpotsKey) {
        S.cpSpotsKey = key;
        try { map.setSpots(spots); } catch (e) { console.error(e); }
      }
    }
    // v1.3 end PAGE-PLAY
  }

  function myPoint() {
    const view = S.view;
    const me = view && view.me;
    const mark = ((view && view.marks) || []).find((m) => m && me && m.id === me.id && (m.kind === 'self' || m.kind === 'hunter'));
    if (mark && isPoint(mark.p)) return mark.p;
    const pos = app.positionNow();
    return pos && isPoint(pos.p) ? pos.p : null;
  }

  function centerOnMe() {
    const p = myPoint();
    if (!p) {
      banner(locStatus() === 'denied' ? 'Location is blocked. Allow it for this site in your settings.' : "Can't find you yet. Give it a moment.", 'warn');
      return;
    }
    if (map) map.center(p, Math.max(16, (map.getZoom && map.getZoom()) || 16), { animate: true });
  }

  function fitRing(animate = false) {
    const v = S.view;
    const ring = v && (v.ringNow || v.ring);
    if (map && ring) map.fit(v.ring || ring, { padding: 28, animate });
  }

  // v1.2 PAGE-MAP: Fit everyone: the ring and every mark (with its circle).
  function fitEveryone() {
    const v = S.view;
    if (!map || !v) return;
    if (!map.fitAll({ ring: v.ringNow || v.ring, marks: v.marks || [] })) fitRing(true);
  }

  function onMarkTap(mark) {
    const view = S.view;
    if (!view || S.mode !== 'hunter' || !mark) return;
    const p = playerOf(view, mark.id);
    if (!p || p.team !== 'hider' || p.status !== 'in') return;
    if (view.me && view.me.driver) { banner("The driver can't tag. Ask another hunter.", 'info'); return; } // v1.1 PAGE-DRIVER
    const cd = countdowns(view, gclock.read());
    if (inHeadStart(view, cd) || view.paused) {
      banner(view.paused ? 'The game is paused.' : 'Tags count once the head start is over.', 'info');
      return;
    }
    if ((view.pending || []).some((x) => x && x.hider === p.id)) {
      banner(`${p.name} already has a tag waiting.`, 'info');
      return;
    }
    ask({
      title: `Tag ${p.name}?`,
      body: [
        h('div.g-ask-who', face({ name: p.name, src: faceSrc(p.id), team: 'hider', size: 56 }), h('div', h('strong', p.name), h('span.g-ask-sub', lastSeenWords(view, p.id, cd.d)))),
        h('p', `Only if you really tagged them. ${p.name} confirms it on their phone.`),
      ],
      yes: `Yes, I tagged ${p.name}`,
      run: () => app.cmd({ type: 'tag', target: p.id }).then(ok),
    });
  }

  // ---- sheets ----

  // While a sheet's command is on its way its buttons say they're busy. (Not `disabled`: that would throw the
  // focus out of the sheet; the handlers check isBusy instead.)
  function busy(sheet, on) {
    if (!sheet) return;
    cls(sheet.el, 'is-busy', on);
    for (const b of sheet.el.querySelectorAll('.sheet-actions button, .g-pick')) {
      if (b.disabled) continue;
      if (on) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    }
  }
  const isBusy = (sheet) => !!sheet && sheet.el.classList.contains('is-busy');

  // A yes/no sheet. run() -> Promise<boolean>: true closes it.
  function ask({ title, body, yes, kind = 'primary', no = 'Cancel', run, className = '' }) {
    let sheet = null;
    sheet = openSheet({
      title,
      body,
      className: `g-sheet ${className}`.trim(),
      actions: [
        {
          label: yes,
          kind,
          keepOpen: true,
          onClick: async (close) => {
            if (isBusy(sheet)) return;
            busy(sheet, true);
            let done = false;
            try {
              done = !!(await run());
            } catch (e) {
              console.error(e);
            }
            if (done) close();
            else busy(sheet, false);
          },
        },
        { label: no, kind: 'ghost' },
      ],
    });
    return sheet;
  }

  function pickRow({ id, name, team, sub, onClick, disabled = false }) {
    const subEl = h('span.g-pick-sub', sub || '');
    const btn = h('button.g-pick', { type: 'button', disabled, onclick: onClick },
      face({ name, src: faceSrc(id), team, size: 44 }),
      h('span.g-pick-text', h('span.g-pick-name', name), subEl));
    return { btn, sub: subEl };
  }

  function openTagSheet() {
    const view = S.view;
    if (!view || S.mode !== 'hunter') return;
    const cd = countdowns(view, gclock.read());
    if (view.paused) { banner('The game is paused.', 'info'); return; }
    if (inHeadStart(view, cd)) { banner('Tags count once the head start is over.', 'info'); return; }
    const pendingIds = new Set((view.pending || []).map((p) => p && p.hider));
    const free = freeHiders(view);
    const rows = [];
    let sheet = null;
    const items = free.map((p) => {
      const rec = { id: p.id, sub: null, busy: false, waiting: pendingIds.has(p.id) };
      const r = pickRow({
        id: p.id,
        name: p.name,
        team: 'hider',
        sub: rec.waiting ? 'Waiting for them to confirm' : lastSeenWords(view, p.id, cd.d),
        disabled: rec.waiting,
        onClick: async () => {
          if (!sheet || rec.busy || isBusy(sheet)) return;
          rec.busy = true;
          busy(sheet, true);
          text(rec.sub, 'Sending...');
          const res = await app.cmd({ type: 'tag', target: p.id });
          rec.busy = false;
          if (ok(res)) {
            sheet.close();
          } else {
            busy(sheet, false);
            text(rec.sub, lastSeenWords(S.view, p.id, 0));
          }
        },
      });
      rec.sub = r.sub;
      rows.push(rec);
      return r.btn;
    });
    const body = items.length
      ? [h('p.g-sheet-note', 'Pick who you tagged. They confirm it on their phone.'), h('div.g-picks', items)]
      : [h('p.g-sheet-note', 'Nobody is hiding right now.')];
    sheet = openSheet({
      title: 'Who did you tag?',
      body,
      className: 'g-sheet',
      onClose: () => { if (S.tagSheet && S.tagSheet.sheet === sheet) S.tagSheet = null; },
    });
    S.tagSheet = { sheet, rows };
  }

  function openGotTagged() {
    const view = S.view;
    if (!view || S.mode !== 'hider') return;
    const cd = countdowns(view, gclock.read());
    if (view.paused) { banner('The game is paused.', 'info'); return; }
    if (inHeadStart(view, cd)) { banner('Catches count once the head start is over.', 'info'); return; }
    const hunters = activeHunters(view).filter((p) => p.id !== view.me.id && !p.driver); // v1.1 PAGE-DRIVER: never the driver
    let sheet = null;
    const send = async (by) => {
      if (!sheet || isBusy(sheet)) return;
      busy(sheet, true);
      const res = await app.cmd(by ? { type: 'tagged', by } : { type: 'tagged' });
      if (ok(res)) sheet.close();
      else busy(sheet, false);
    };
    const items = hunters.map((p) => pickRow({ id: p.id, name: p.name, team: 'hunter', sub: 'Tagged me', onClick: () => send(p.id) }).btn);
    items.push(h('button.g-pick.g-pick-plain', { type: 'button', onclick: () => send(null) },
      h('span.g-pick-icon', icon('target', 22)), h('span.g-pick-text', h('span.g-pick-name', "I don't know who"), h('span.g-pick-sub', 'It still counts'))));
    sheet = openSheet({
      title: 'Who tagged you?',
      body: [h('p.g-sheet-note', 'This counts as caught right away. Thanks for being honest.'), h('div.g-picks', items)],
      className: 'g-sheet',
    });
  }

  // The tag waiting for my answer: a sheet that can't be closed by accident.
  function syncPending(view) {
    const me = view.me || {};
    const mine = S.mode === 'hider' && !view.paused
      ? (view.pending || []).find((p) => p && p.hider === me.id) : null;
    if (S.pendingSheet && (!mine || mine.id !== S.pendingSheet.catchId)) {
      const old = S.pendingSheet;
      S.pendingSheet = null;
      old.sheet.close();
    }
    if (S.pendingSheet && mine && !S.pendingSheet.hasFace && faceSrc(mine.hunter)) {
      const nf = face({ name: nameOf(view, mine.hunter), src: faceSrc(mine.hunter), team: 'hunter', size: 56 });
      S.pendingSheet.face.replaceWith(nf);
      S.pendingSheet.face = nf;
      S.pendingSheet.hasFace = true;
    }
    if (!mine || S.pendingSheet) return;
    const hunter = nameOf(view, mine.hunter);
    const hunterFace = face({ name: hunter, src: faceSrc(mine.hunter), team: 'hunter', size: 56 });
    const auto = h('p.g-sheet-note.g-auto');
    let sheet = null;
    const answer = async (yes) => {
      if (!sheet || isBusy(sheet)) return;
      // Pocket mode stays on top of this sheet: its double tap shows the question. A third tap straight after
      // must not answer a question nobody has read yet.
      if (S.pocketStop || perfNow() - S.wokeAt < WAKE_GUARD_MS) return;
      busy(sheet, true);
      const res = await app.cmd({ type: 'answer', catchId: mine.id, yes });
      if (!ok(res)) busy(sheet, false);
      // On success the next view has no tag waiting, and that closes the sheet.
    };
    sheet = openSheet({
      title: `Did ${hunter} tag you?`,
      dismissable: false,
      className: 'g-sheet g-pending',
      body: [
        h('div.g-ask-who', hunterFace,
          h('div', h('strong', `${hunter} says they tagged you.`), h('span.g-ask-sub', 'Did they?'))),
        auto,
      ],
      actions: [
        { label: "Yes, I'm caught", kind: 'danger', keepOpen: true, onClick: () => answer(true) },
        { label: "No, they didn't", kind: '', keepOpen: true, onClick: () => answer(false) },
      ],
      onClose: () => { if (S.pendingSheet && S.pendingSheet.sheet === sheet) S.pendingSheet = null; },
    });
    S.pendingSheet = { sheet, catchId: mine.id, auto, face: hunterFace, hasFace: !!faceSrc(mine.hunter) };
  }

  // The host settles a tag nobody answered.
  function decideFor(catchId) {
    const view = S.view;
    const p = view && (view.pending || []).find((x) => x && x.id === catchId);
    if (!p) return;
    const hunter = nameOf(view, p.hunter);
    const hider = nameOf(view, p.hider);
    let sheet = null;
    const answer = async (yes) => {
      if (!sheet || isBusy(sheet)) return;
      busy(sheet, true);
      const res = await app.cmd({ type: 'answer', catchId, yes });
      if (ok(res)) sheet.close();
      else busy(sheet, false);
    };
    sheet = openSheet({
      title: `Did ${hunter} tag ${hider}?`,
      className: 'g-sheet',
      body: h('p', `${hider} hasn't answered. As the host you can decide. Ask them in person first if you can.`),
      actions: [
        { label: `Yes, ${hider} is caught`, kind: 'danger', keepOpen: true, onClick: () => answer(true) },
        { label: 'No, it doesn\'t count', kind: '', keepOpen: true, onClick: () => answer(false) },
      ],
    });
  }

  function onPower(name) {
    const view = S.view;
    if (!view) return;
    const tile = (P.tiles || []).find((t) => t.name === name);
    const cd = countdowns(view, gclock.read());
    const head = inHeadStart(view, cd);
    const st = P.mode === 'hunter' ? hunterPower(view, name, cd, head) : hiderPower(view, name, cd, head);
    if (!st.usable) {
      banner(st.why || (tile && tile.why) || "That can't be used right now.", 'info');
      return;
    }
    const pw = POWERS[name];
    const once = P.mode === 'hunter'
      ? 'Your team gets it once this game.'
      : 'You get it once this game.';
    if (POWER_TARGETED.includes(name)) { pickTarget(view, name, pw, once); return; }
    ask({
      title: `Use ${pw.name}?`,
      body: [h('div.g-ask-power', h('span.g-ask-power-icon', icon(POWER_ICON[name] || 'info', 28)), h('p', pw.desc)), h('p.g-sheet-note', once)],
      yes: `Use ${pw.name}`,
      run: () => app.cmd({ type: 'power', power: name }).then((res) => {
        if (ok(res)) buzz('power');
        return ok(res);
      }),
    });
  }

  // v1.4: Hacker and Wiretap need a hider picked first (Wiretap: only ones who said OK).
  function pickTarget(view, name, pw, once) {
    const okIds = (view.tapOk && Array.isArray(view.tapOk.okIds)) ? view.tapOk.okIds : [];
    let sheet = null;
    const rows = freeHiders(view).map((p) => {
      const no = name === 'wiretap' && !okIds.includes(p.id);
      return pickRow({
        id: p.id, name: p.name, team: 'hider', disabled: no,
        sub: no ? "Didn't say OK to Wiretap" : '',
        onClick: () => {
          if (sheet && sheet.close) sheet.close(); else closeSheets();
          ask({
            title: `Use ${pw.name} on ${p.name}?`,
            body: [h('p', pw.desc), h('p.g-sheet-note', once)],
            yes: `Use ${pw.name}`,
            run: () => app.cmd({ type: 'power', power: name, target: p.id }).then((res) => {
              if (ok(res)) buzz('power');
              return ok(res);
            }),
          });
        },
      }).btn;
    });
    sheet = openSheet({
      title: `${pw.name}: pick a hider`,
      body: rows.length ? [h('div.g-pick-list', ...rows)] : [h('p', 'No hider is free right now.')],
      className: 'g-sheet g-target',
      actions: [{ label: 'Cancel', kind: 'ghost' }],
    });
  }

  function openChatSheet() {
    if (S.chat && S.chat.isOpen()) return;
    S.unread = 0;
    // Everything the banners say is in the chat too: they'd only cover its title.
    for (const kind of ['chat', 'info', 'ping', 'warn', 'good', 'catch', 'power']) clearBanners(kind);
    if (S.view) paintChatPreview(S.view);
    S.chat = openChat(app, {
      onClose: () => {
        S.chat = null;
        S.unread = 0;
        if (S.view && !S.dead) paintChatPreview(S.view);
      },
    });
  }

  async function quickSend(btn, words) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    cls(btn, 'busy', true);
    let sent = false;
    try {
      sent = await sendChat(app, words);
    } finally {
      cls(btn, 'busy', false);
      btn.disabled = false;
    }
    if (sent && btn.isConnected) {
      buzz('tap');
      cls(btn, 'sent', true);
      setTimeout(() => cls(btn, 'sent', false), 900);
    }
  }

  // ---- the menu ----

  function menuRow(iconName, title, line, onClick, extra = '') {
    return h(`button.g-menu-row${extra ? `.${extra}` : ''}`, { type: 'button', onclick: onClick },
      h('span.g-menu-icon', icon(iconName, 22)),
      h('span.g-menu-text', h('span.g-menu-title', title), line ? h('span.g-menu-line', line) : null));
  }

  function openMenu() {
    const view = S.view;
    if (!view) return;
    const me = view.me || {};
    let sheet = null;
    const later = (fn) => () => { sheet.close(); setTimeout(fn, 0); };
    const soundOn = !!(al.soundOn && al.soundOn());
    const soundSwitch = h('button.g-menu-row.g-menu-switch', { type: 'button', role: 'switch', 'aria-checked': soundOn ? 'true' : 'false' },
      h('span.g-menu-icon', icon('speaker', 22)),
      h('span.g-menu-text', h('span.g-menu-title', 'Sound'), h('span.g-menu-line', canBuzz()
        ? 'Beeps for pings and warnings'
        : (al.silentSwitchMutes && al.silentSwitchMutes()
          ? "This phone can't buzz: with sound off, warnings only show on screen. The silent switch may mute beeps."
          : "This phone can't buzz: with sound off, warnings only show on screen"))),
      h('span.g-switch-look', { 'aria-hidden': 'true' }));
    soundSwitch.addEventListener('click', () => {
      const now = soundSwitch.getAttribute('aria-checked') !== 'true';
      try { if (al.setSound) al.setSound(now); } catch { /* ignore */ }
      soundSwitch.setAttribute('aria-checked', now ? 'true' : 'false');
    });
    const rows = [
      menuRow('moon', 'Pocket mode', pocketWords().line, later(pocketOn)),
      soundSwitch,
      menuRow('info', 'How to play', '', later(openHelp)),
    ];
    // v1.2 PAGE-CAM: Stop filming (asks first)
    { const r = camParts.menuRow(menuRow, later); if (r) rows.push(r); }
    // v1.2 end PAGE-CAM
    // v1.4 PAGE-DEVICES: the host's "Everyone's phones" (who has no location)
    if (me.host && view.phase === 'live') {
      rows.push(menuRow('locate', "Everyone's phones", fixIt.everyoneRows(view).join(' · ')));
    }
    // v1.4 end PAGE-DEVICES
    if (me.host) {
      rows.push(menuRow('crown', 'Hand over host', 'Someone else runs the game', later(openHandOver)));
      if (view.phase === 'live') rows.push(menuRow('flag', 'End the game', 'For everyone, right now', later(askEnd), 'danger'));
    }
    rows.push(menuRow('door', "I'm out", 'Leave this game', later(askLeave), 'danger'));
    sheet = openSheet({ title: 'Menu', body: h('div.g-menu', rows), className: 'g-sheet' });
  }

  function openHelp() {
    const mode = S.mode || 'out';
    openSheet({
      title: 'How to play',
      className: 'g-sheet',
      body: [
        h('span.label', mode === 'hunter' ? "You're a hunter" : mode === 'hider' ? "You're a hider" : "You're sitting out"),
        ...(HELP[mode] || []).map((p) => h('p', p)),
        ...(cpOf(S.view) ? (HELP_CP[mode] || []).map((p) => h('p.g-help-cp', p)) : []), // v1.3 PAGE-PLAY
        h('p.g-help-sos', HELP_ALL),
      ],
      actions: [{ label: 'Got it', kind: 'primary' }],
    });
  }

  function openHandOver() {
    const view = S.view;
    if (!view) return;
    const others = (view.players || []).filter((p) => p && p.status === 'in' && p.id !== view.me.id);
    let sheet = null;
    const items = others.map((p) => pickRow({
      id: p.id,
      name: p.name,
      team: p.team === 'hunter' ? 'hunter' : p.team === 'hider' ? 'hider' : null,
      sub: p.online === false ? 'Offline right now' : (p.team === 'hunter' ? 'Hunter' : p.team === 'hider' ? 'Hider' : ''),
      onClick: async () => {
        if (!sheet || isBusy(sheet)) return;
        busy(sheet, true);
        const res = await app.cmd({ type: 'host', playerId: p.id });
        if (ok(res)) sheet.close();
        else busy(sheet, false);
      },
    }).btn);
    sheet = openSheet({
      title: 'Who should be the host?',
      className: 'g-sheet',
      body: items.length
        ? [h('p.g-sheet-note', 'The host can end the game and decide tags nobody answered.'), h('div.g-picks', items)]
        : [h('p.g-sheet-note', "There's nobody else to hand it to.")],
    });
  }

  function askEnd() {
    const free = freeHiders(S.view);
    ask({
      title: 'End the game now?',
      body: h('p', free.length
        ? `It ends for everyone. The ${free.length === 1 ? 'hider' : `${free.length} hiders`} still in win.`
        : 'It ends for everyone.'),
      yes: 'End the game',
      kind: 'danger',
      run: () => app.cmd({ type: 'end' }).then(ok),
    });
  }

  function askLeave() {
    const mode = S.mode;
    ask({
      title: 'Leave this game?',
      body: h('p', mode === 'hider'
        ? "You're out for this round and can't come back in. Tell your team first."
        : "You can't come back into this round. The others keep playing."),
      yes: 'Leave the game',
      kind: 'danger',
      no: 'Stay',
      run: async () => {
        const res = await app.cmd({ type: 'leave' }, { quiet: true });
        // Offline or refused: leave on this phone anyway (the App tells the server when it can).
        if (!ok(res) && app.game) app.leave();
        return true;
      },
    });
  }

  // ---- SOS ----

  function askSos() {
    const view = S.view;
    if (!view || view.phase !== 'live') return;
    if (view.paused) return;
    ask({
      title: 'Send an SOS?',
      body: [
        h('p', 'This pauses the game for everyone and shows everyone where you are. Use it if someone is hurt, lost or in danger.'),
        h('a.btn.ghost.wide.g-sheet-call', { href: 'tel:911' }, icon('sos', 20), 'Emergency? Call 911'),
      ],
      yes: 'Send SOS',
      kind: 'danger',
      run: () => app.cmd({ type: 'sos' }).then(ok),
    });
  }

  function resume() {
    if (sosResume.getAttribute('aria-disabled') === 'true') return;
    sosResume.setAttribute('aria-disabled', 'true');
    app.cmd({ type: 'resume' }).finally(() => { sosResume.removeAttribute('aria-disabled'); });
  }

  function showSosSpot() {
    const v = S.view;
    if (!v || !v.sos || !isPoint(v.sos.p)) {
      banner("Their phone hasn't shared a spot yet.", 'warn');
      return;
    }
    if (map) map.center(v.sos.p, 17.5, { animate: true });
  }

  function paintSosDistance(view) {
    const sos = view.sos;
    const me = view.me || {};
    if (!sos) return;
    let words = '';
    if (sos.by === me.id) words = 'Everyone can see where you are.';
    else if (!isPoint(sos.p)) words = "Their phone hasn't shared a spot yet.";
    else {
      const pos = app.positionNow();
      words = pos && isPoint(pos.p) ? `${sos.name || 'They'} ${sos.name ? 'is' : 'are'} about ${fmtDistance(distanceM(pos.p, sos.p))} from you.` : 'Their spot is on the map.';
    }
    text(sosDist, words);
  }

  function syncSos(view) {
    const on = view.phase === 'live' && !!view.paused;
    const sos = view.sos;
    const me = view.me || {};
    if (on) {
      const key = `${sos ? sos.by : ''}`;
      if (!S.sosShown || S.sosKey !== key) {
        S.sosKey = key;
        if (!S.sosShown) {
          S.sosShown = true;
          // Everything else steps aside: sheets close, pocket mode wakes up.
          if (S.pendingSheet) { const o = S.pendingSheet; S.pendingSheet = null; o.sheet.close(); }
          closeSheets();
          if (S.pocketStop) { const stop = S.pocketStop; S.pocketStop = null; stop(); }
          sosLayer.hidden = false;
          root.classList.add('g-sos-on');
          hud.inert = true;
          panel.inert = true;
          mapBtns.inert = true;
          setTimeout(() => { try { sosTitle.setAttribute('tabindex', '-1'); sosTitle.focus({ preventScroll: true }); } catch { /* ignore */ } }, 0);
        }
        // (after the layout change: the map now fills the screen)
        if (sos && isPoint(sos.p) && map) {
          const spot = sos.p;
          requestAnimationFrame(() => { if (map && S.sosShown) map.center(spot, 17, { animate: false }); });
        }
      }
      const mine = !!sos && sos.by === me.id;
      text(sosTitle, !sos ? 'Game paused' : mine ? 'You sent an SOS' : `SOS from ${sos.name || 'a player'}`);
      text(sosLine, mine
        ? 'The game is paused and everyone can see your spot. Help is coming.'
        : 'The game is paused for everyone. Go and help, or call for help.');
      const canResume = !!sos && (mine || !!me.host);
      sosResume.hidden = !canResume;
      text(sosResume, mine ? "I'm OK. Resume the game" : 'Resume the game');
      sosNote.hidden = canResume;
      text(sosNote, sos ? `Only ${sos.name || 'they'} or the host can restart the game.` : 'Only the host can restart the game.');
      paintSosDistance(view);
    } else if (S.sosShown) {
      S.sosShown = false;
      S.sosKey = '';
      sosLayer.hidden = true;
      root.classList.remove('g-sos-on');
      hud.inert = false;
      panel.inert = false;
      mapBtns.inert = false;
      fitRing(true);
    }
  }

  // ---- pocket mode ----

  // A phone that can't buzz (iPhones) only beeps, and only with Sound on: it's asked once, from this tap.
  function pocketOn() {
    if (S.pocketStop || S.dead) return;
    if (S.view && S.view.paused) return;
    const soundIsOn = (() => { try { return !!(al.soundOn && al.soundOn()); } catch { return false; } })();
    if (!canBuzz() && !soundIsOn && !S.askedSound) {
      S.askedSound = true;
      openSheet({
        title: "This phone can't buzz",
        body: h('p.g-sheet-note', 'Turn Sound on so you hear warnings and SOS with the screen off? Beeps can give away your spot.'),
        actions: [
          {
            label: 'Turn Sound on',
            kind: 'primary',
            onClick: () => {
              try { if (al.setSound) al.setSound(true); } catch { /* ignore */ }
              setTimeout(pocketNow, 0);
            },
          },
          { label: 'Stay silent', kind: '', onClick: () => { setTimeout(pocketNow, 0); } },
        ],
        className: 'g-sheet',
      });
      return;
    }
    pocketNow();
  }

  function pocketNow() {
    if (S.pocketStop || S.dead) return;
    if (S.view && S.view.paused) return;
    tipDone();
    S.pocketStop = startPocket({ onWake: () => { S.pocketStop = null; S.wokeAt = perfNow(); } });
  }

  // ---- away from Night Ops (see awayNews) ----

  function keptAway() {
    try {
      const raw = globalThis.localStorage && globalThis.localStorage.getItem(AWAY_KEY);
      const a = raw ? JSON.parse(raw) : null;
      return a && typeof a === 'object' ? a : null;
    } catch { return null; }
  }

  function keepAway(a) {
    try {
      if (!globalThis.localStorage) return;
      if (a) globalThis.localStorage.setItem(AWAY_KEY, JSON.stringify(a));
      else globalThis.localStorage.removeItem(AWAY_KEY);
    } catch { /* private mode or full: this page still remembers */ }
  }

  // The page is going out of sight: a free hider's phone stops sharing its spot from now.
  function goingAway() {
    if (S.dead || S.away) return;
    const a = awayFrom(S.view, { clock: gclock.read(), serverAt: serverNow(), at: Date.now() });
    if (!a) return;
    S.away = a;
    keepAway(a);
  }

  // A new view while the page shows: if this phone was away, note when, and tell a hider what it cost.
  function settleAway(view) {
    if (!S.away || S.dead) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const news = awayNews(S.away, view);
    if (news && news.wait) return;
    S.away = null;
    keepAway(null);
    if (!news) return;
    S.stale = [...S.stale, news.stretch].slice(-12);
    if (news.note) {
      // After the events this view brings have had their say (at most 3 banners show: this one stays on top).
      setTimeout(() => { if (!S.dead) banner(news.note, 'warn', 12000); }, 0);
    }
  }

  // ---- events: moments, banners, buzzes ----

  const momentQ = [];
  let momentBusy = false;

  function serverNow() {
    const v = S.view;
    if (!v || !Number.isFinite(v.now)) return Date.now();
    return v.now + (perfNow() - S.recvAt);
  }

  function ageOf(e) {
    return e && Number.isFinite(e.at) ? serverNow() - e.at : 0;
  }

  // A moment that's too old to make a fuss about: a banner with the event's own words instead.
  function quietly(e, opts) {
    const words = e && typeof e.text === 'string' && e.text.trim() ? e.text : opts && opts.line;
    if (words && ageOf(e) <= STALE_ALERT_MS) banner(words, MOMENT_BANNER[opts && opts.kind] || 'info');
  }

  async function runMoments() {
    if (momentBusy) return;
    momentBusy = true;
    try {
      while (momentQ.length && !S.dead) {
        const item = momentQ.shift();
        if (perfNow() - item.queued > STALE_MOMENT_MS || ageOf(item.event) > STALE_MOMENT_MS) {
          quietly(item.event, item.opts);
          continue;
        }
        await moment(item.opts);
      }
    } finally {
      momentBusy = false;
    }
  }

  function onEvent(e) {
    if (S.dead || !e) return;
    const view = S.view || app.view;
    if (!view) return;
    const fx = effectOf(e, view);
    const age = ageOf(e);
    if (fx.chat && !(S.chat && S.chat.isOpen())) {
      S.unread += 1;
      if (S.view) paintChatPreview(S.view);
    }
    if (age > STALE_ALERT_MS) return;
    const chatOpen = !!(S.chat && S.chat.isOpen());
    if (fx.moment && age <= STALE_MOMENT_MS) {
      momentQ.push({ opts: fx.moment, event: e, queued: perfNow() });
      runMoments();
    } else if (fx.moment) {
      quietly(e, fx.moment);
    } else if (fx.banner && !chatOpen) {
      // (With the chat open the event shows in it instead.)
      const shown = banner(fx.banner[0], fx.banner[1]);
      const me = view.me || {};
      // "Back inside the ring" takes the "you're outside" warning away with it.
      if (e.kind === 'outside' && e.to === me.id) S.outsideBanner = shown;
    }
    if (e.kind === 'inside' && S.outsideBanner) {
      S.outsideBanner.close();
      S.outsideBanner = null;
    }
    if (age <= STALE_MOMENT_MS && !(fx.chat && chatOpen)) {
      buzz(fx.buzz);
      beep(fx.beep);
    }
    if (e.kind === 'over') S.overShown = true;
  }

  // The game ended: App switches to the end screen right away (this screen goes before the 'over' event comes),
  // so the big moment is shown from here.
  function overMoment(view) {
    if (S.overShown) return;
    S.overShown = true;
    const e = [...((view && view.events) || [])].reverse().find((x) => x && x.kind === 'over');
    const fx = effectOf(e || { kind: 'over', text: 'Game over.', data: (view && view.result) || {} }, view);
    if (fx.moment && (!e || ageOf(e) <= STALE_MOMENT_MS)) {
      moment(fx.moment);
      buzz(fx.buzz);
      beep(fx.beep);
    }
  }

  // ---- update / destroy ----

  function update(view) {
    if (S.dead || !view) return;
    // The App also calls this with a view we already have (faces landed) or one that came a while ago (this
    // screen was just shown): the clock only moves for a view this screen hasn't had, from when it arrived.
    const isNew = view !== S.view;
    if (isNew) {
      S.view = view;
      S.recvAt = arrivedAt(view, app);
      const now = clockFrom(view, S.recvAt);
      gclock.set(now.clock, now.running);
    }
    if (view.phase === 'live') S.wasLive = true;
    if (isNew) settleAway(view);
    const mode = modeOf(view);
    if (mode !== S.mode || !P.mode) {
      S.mode = mode;
      buildPanel(mode, view);
      if (S.tagSheet && mode !== 'hunter') S.tagSheet.sheet.close();
    }
    paintMap(view);
    syncSos(view);
    syncPending(view);
    paint();
    syncDrive(view); // v1.1 PAGE-DRIVER
    paintWatching(view); // v1.1 PAGE-WATCH
    camParts.update(view, root); // v1.2 PAGE-CAM
    fixIt.update(view); // v1.4 PAGE-DEVICES
    if (pinTool) { try { pinTool.update(view); } catch (e) { console.error(e); } } // v1.4 PAGE-PLAY
    placeBanners();
    if (view.phase === 'over' && S.wasLive) overMoment(view);
  }

  // v1.1 PAGE-DRIVER: the Driving layer for the driver (it shows itself while not parked), and the panel's part
  function syncDrive(view) {
    if (P.drive) { try { P.drive.update(view); } catch (e) { console.error(e); } }
    const driving = !!(view.me && view.me.driver && view.phase === 'live');
    if (driving && !S.drive) {
      try { S.drive = mountDrive(root, app, { onSos: () => askSos(), onMenu: () => openMenu() }); } catch (e) { console.error(e); }
    } else if (!driving && S.drive) {
      try { S.drive.destroy(); } catch { /* ignore */ }
      S.drive = null;
    }
    if (S.drive) { try { S.drive.update(view); } catch (e) { console.error(e); } }
  }
  // v1.1 end PAGE-DRIVER

  offs.push(app.on('event', onEvent));
  offs.push(app.on('connection', () => { if (S.view) paint(); }));
  if (typeof al.onAwake === 'function') {
    try { offs.push(al.onAwake(() => { if (S.view && !S.dead) paint(); })); } catch { /* ignore */ }
  }
  if (app.location && typeof app.location.on === 'function') {
    offs.push(app.location.on(() => { if (S.view && !S.dead) paint(); }));
  }
  if (typeof document !== 'undefined') {
    offs.push(listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
      else goingAway();
    }));
    // (iOS can close a page without a visibilitychange first.)
    offs.push(listen(window, 'pagehide', () => goingAway()));
  }
  const timer = setInterval(tick, TICK_MS);
  try { if (al.keepAwake) al.keepAwake(true, 'game'); } catch { /* ignore */ }
  // Away when the page was closed or reloaded (iPhones do that to a page left in the background): the first view
  // says what it cost.
  S.away = keptAway();

  function destroy() {
    if (S.dead) return;
    const last = app.view;
    if (last && last.phase === 'over' && S.wasLive) overMoment(last);
    S.dead = true;
    clearInterval(timer);
    if (hudWatch) { try { hudWatch.disconnect(); } catch { /* ignore */ } }
    rootStyle.removeProperty('--g-hud-bottom');
    rootStyle.removeProperty('--g-tray-top'); // v1.2 PAGE-MAP
    rootStyle.removeProperty('--g-tray-h');
    momentQ.length = 0;
    for (const off of offs.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
    if (S.pocketStop) { const stop = S.pocketStop; S.pocketStop = null; try { stop(); } catch { /* ignore */ } }
    try { if (al.keepAwake) al.keepAwake(false, 'game'); } catch { /* ignore */ }
    // The game screen goes (game over, left): nothing to report later. Shown again for the same game (a retry
    // after an error), it picks the note up.
    if (S.away && !(last && last.phase === 'live' && modeOf(last) === 'hider')) keepAway(null);
    if (S.chat) { try { S.chat.close(); } catch { /* ignore */ } }
    try { camParts.destroy(); } catch { /* ignore */ } // v1.2 PAGE-CAM
    try { fixIt.destroy(); } catch { /* ignore */ } // v1.4 PAGE-DEVICES
    try { if (pinTool) pinTool.destroy(); } catch { /* ignore */ } // v1.4 PAGE-PLAY
    try { cpp.destroy(); } catch { /* ignore */ } // v1.3 PAGE-PLAY
    if (S.pendingSheet) { try { S.pendingSheet.sheet.close(); } catch { /* ignore */ } }
    if (S.tagSheet) { try { S.tagSheet.sheet.close(); } catch { /* ignore */ } }
    if (S.drive) { try { S.drive.destroy(); } catch { /* ignore */ } S.drive = null; } // v1.1 PAGE-DRIVER
    if (map) { try { map.destroy(); } catch { /* ignore */ } }
    map = null;
    root.classList.remove('g-root', 'g-sos-on');
  }

  // (The App calls update() with the latest view right after mounting.)
  return { update, destroy };
}
