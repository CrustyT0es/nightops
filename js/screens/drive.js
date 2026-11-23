// Night Ops: the driver (v1.1, PAGE-DRIVER; v1.4 PAGE-PLAY: the driver only sees hunters).
//
//   mountDrive(container, app, { onSos, onMenu }) -> { update(view), destroy(), shown() }
//       The Driving screen: one calm map like a nav app, moving or parked, shown while this phone is the driver
//       (live). The car in the middle (Follow; a pan leaves it, "Follow me" brings it back), the hunters' faces,
//       team pins and pickups as big pins, the ring. A pickup draws a straight line from the car with the
//       distance; a tap on it: On my way / Picked up. A slim top bar (time left, voice, SOS, menu) and a bottom
//       bar (the walkie-talkie and the open pickups). It speaks pickups, pins, catches, closing in and the time
//       calls; never where a hider is (the server never tells the driver).
//   v1.4.8: turn-by-turn (js/screens/drivenav.js): the route along the roads, the next turn big at the top, spoken
//       turns, ETA / time / distance left and End at the bottom; it starts by itself for a pickup or a "Driver: go
//       here" pin, and each pickup, pin and the hunters have a Navigate button. The map then turns with the car and
//       tilts; a pan shows Recentre.
//   pickMeUp(app) -> { el, update(view) }      a hunter's "Pick me up" (and Waiting / coming / Cancel)
//   driverCard(app) -> { el, update(view) }    the driver's part of the hunter panel (pickups, words)
//   driverReveal(words, view)                  the reveal screen's words for the driver (and the others)
//
// Pure helpers are exported for tests (tests/page-driver.test.mjs, tests/page-play14.test.mjs).
import { h, fill, text, cls, listen } from '../dom.js?v=170';
import { icon } from '../ui/icons.js?v=170';
import { holdInert } from '../ui/inert.js?v=170';
import { fmtClock, fmtDistance } from '../../shared/rules.js?v=170';
import { directionWords, isPoint } from '../../shared/geo.js?v=170';
import { speechReady } from '../alerts.js?v=170';
import { cpSpeech, cpDriveLine } from './cpplay.js?v=170'; // v1.3 PAGE-PLAY
import { createMap } from '../map.js?v=170';
import { createMapCam } from '../mapcam.js?v=170';
import { openSheet } from '../ui/sheet.js?v=170';
import { pinsFor, createPinTool } from './pins.js?v=170';
import { createNav, SAFETY, CAMERA_EVERY_MS } from './drivenav.js?v=170'; // v1.4.8

export const VOICE_KEY = 'nightops-drive-voice';   // 'off' = the driver muted the voice
export const DRIVE_STALE_MS = 120000;              // events older than this aren't spoken (a phone that slept)
export const TIME_CALLS = [[300000, '5 minutes left.'], [60000, '1 minute left.']];
export const QUEUE_MOST = 6;                       // things waiting to be said; older ones go first
const TICK_MS = 500;
const WAIT_MS = 400;                               // how often a waiting voice looks again (a clip playing)
const TAP_LINE = 'Tap anywhere once to turn the voice on.';

const perfNow = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// ---- reading the view (pure) ----------------------------------------------------------------------------

// Show the Driving screen? The driver, live, in the game (moving or parked: v1.4).
export function showsDrive(view) {
  return !!view && view.phase === 'live' && !!view.me && !!view.me.driver && view.me.status === 'in'
    && !!view.drive && !!view.drive.me;
}

// This phone is the driver right now (live).
export function isDriver(view) {
  return !!view && view.phase === 'live' && !!view.me && !!view.me.driver && !!view.drive && !!view.drive.me;
}

// The driver's own spot: their hunter mark (the server's), else null.
export function driverSpot(view) {
  const me = view && view.me;
  if (!me) return null;
  const m = ((view && view.marks) || []).find((x) => x && x.id === me.id && (x.kind === 'hunter' || x.kind === 'self'));
  return m && isPoint(m.p) ? m.p : null;
}

// '40 s ago', '1 min ago', '12 min ago' ('just now' under 10 s).
export function agoWords(ms) {
  if (!Number.isFinite(ms) || ms < 10000) return 'just now';
  if (ms < 60000) return `${Math.floor(ms / 10000) * 10} s ago`;
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

// "400 metres", "1.2 kilometres": for the voice (it reads "m" as "em").
export function spokenDistance(m) {
  if (!Number.isFinite(m)) return '';
  const tens = Math.round(m / 10) * 10;
  if (tens < 1000) return `${tens || 0} metres`;
  const km = m / 1000;
  const s = km.toFixed(km < 9.95 ? 1 : 0).replace(/\.0$/, '');
  return `${s} ${s === '1' ? 'kilometre' : 'kilometres'}`;
}

// How far and which way, as screen words ("400 m north-east") or '' without both spots.
function whereWords(from, to) {
  if (!isPoint(from) || !isPoint(to)) return '';
  const d = directionWords(from, to);
  return d.m < 20 ? 'right here' : `${fmtDistance(d.m)} ${d.dir}`;
}

// The driver's open pickups: [{ id, by, name, state, text }] oldest first.
export function pickupLines(view) {
  const drive = view && view.drive;
  if (!drive || !drive.me || !Array.isArray(drive.pickups)) return [];
  const from = driverSpot(view);
  return drive.pickups.filter((k) => k && (k.state === 'open' || k.state === 'coming')).map((k) => {
    const name = String(k.name || 'Someone');
    const where = whereWords(from, k.p);
    const text = k.state === 'coming'
      ? `${name}: you're on your way${where ? `, ${where}` : ''}`
      : `${name} needs a pickup${where ? `: ${where}` : ''}`;
    return { id: k.id, by: k.by, name, state: k.state, text };
  });
}

// What a hunter's "Pick me up" shows: null (no button) or { state: 'ask'|'open'|'coming', driver, text }.
export function pickupState(view) {
  const drive = view && view.drive;
  const me = view && view.me;
  if (!drive || !me || me.driver || drive.me || view.phase !== 'live' || me.status !== 'in' || me.team !== 'hunter') return null;
  const driver = String(drive.name || 'The driver');
  const mine = drive.mine;
  if (mine && mine.state === 'coming') return { state: 'coming', driver, text: `${driver} is coming` };
  if (mine && mine.state === 'open') return { state: 'open', driver, text: `Waiting for ${driver}` };
  if (!drive.here) return null;
  return { state: 'ask', driver, text: 'Pick me up' };
}

// What the voice says for an event, or null. view = the newest view (its marks are the ones this event brought).
export function speechFor(e, view) {
  if (!e || !view || typeof e.kind !== 'string') return null;
  const words = typeof e.text === 'string' ? e.text.trim() : '';
  const data = e.data && typeof e.data === 'object' ? e.data : {};
  const me = view.me || {};
  switch (e.kind) {
    case 'checkpoint': return cpSpeech(e, view, driverSpot(view)); // v1.3 PAGE-PLAY
    // v1.4 PAGE-PLAY: pins the driver should hear (never a hider's spot: "Hider seen" is said without where)
    case 'pin': {
      if (data.by === me.id) return null;
      const pin = ((view.pins) || []).find((x) => x && x.id === data.pinId);
      const who = (pin && pin.name) || String(words.split(':')[0] || 'A hunter');
      if (data.kind === 'driver') {
        const from = driverSpot(view);
        if (pin && from && isPoint(pin.p)) {
          const d = directionWords(from, pin.p);
          const where = d.m < 20 ? 'right here' : `${spokenDistance(d.m)} ${d.dir}`;
          return `${who}: go here, ${where}.${pin.note ? ` ${pin.note}.` : ''}`;
        }
        return words || null;
      }
      return `New pin from ${who}.`;
    }
    case 'pickup': {
      if (data.state === 'open') {
        if (data.by === me.id) return null;
        const k = ((view.drive && view.drive.pickups) || []).find((x) => x && x.id === data.pickupId);
        const from = driverSpot(view);
        if (k && from && isPoint(k.p)) {
          const d = directionWords(from, k.p);
          const where = d.m < 20 ? 'right here' : `${spokenDistance(d.m)} ${d.dir}`;
          return `${k.name || 'Someone'} needs a pickup, ${where}.`;
        }
        return words || null;
      }
      if (data.state === 'cancelled') return words || null;
      return null;
    }
    case 'caught':
    case 'closing':
    case 'over':
    case 'hunt':
    case 'sos':
    case 'resume':
      return words || null;
    default:
      return null;
  }
}

// "5 minutes left." when the time left went from over a mark to at or under it (else null).
export function timeCall(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || after >= before) return null;
  for (const [mark, words] of TIME_CALLS) if (before > mark && after <= mark && after > mark - 30000) return words;
  return null;
}

// The reveal screen's words with a driver this round (words = revealWords(view)'s).
export function driverReveal(words, view) {
  const me = (view && view.me) || {};
  if (!words || words.side !== 'hunter') return words;
  if (me.driver) {
    return {
      ...words,
      title: 'Driver',
      sub: '',
      line: "You drive the car and give the hunters rides. You only see the hunters: they tell you where to go.",
      keep: 'Eyes on the road: Night Ops talks to you while you drive. Your map shows the hunters and their pins.',
      matesLabel: 'Riding with you',
    };
  }
  const d = ((view && view.players) || []).find((p) => p && p.driver && p.id !== me.id);
  if (!d) return words;
  return { ...words, line: `${words.line} ${d.name} drives the car: ask for a pickup.` };
}

// ---- the voice ------------------------------------------------------------------------------------------

// The voice waits while a walkie-talkie clip plays or waits to, and while this phone records one (the voice would
// be in the clip every hunter hears).
export function radioBusy(r) {
  if (!r) return false;
  return !!r.talking || r.state === 'recording' || r.state === 'asking' || (Number(r.queued) || 0) > 0;
}

let unlockedOnce = false; // (per page: a tap made speech work on this page)

const isIos = (win) => {
  try {
    const n = win && win.navigator;
    const ua = String((n && n.userAgent) || '');
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(n && n.maxTouchPoints) > 1);
  } catch { return false; }
};

// Speech works without a tap here already: any earlier tap on the page spoke silently (alerts.primeSpeech, from
// the lobby, the reveal...), or (not on an iPhone, which wants its first speak() from a tap) the page has had a
// tap at all (Chrome only asks for that).
export function speechWorks(win, primed = speechReady) {
  try { if (primed()) return true; } catch { /* ignore */ }
  try {
    const ua = win && win.navigator && win.navigator.userActivation;
    return !!ua && ua.hasBeenActive === true && !isIos(win);
  } catch { return false; }
}

// createVoice({ win, store, busy }) -> { supported, muted(), setMuted(on), unlocked(), unlock(), say(words), stop(),
// hush() } busy() true = wait (a walkie-talkie clip is playing, or this phone is recording one). Nothing is said
// before a tap (unlock(), or one earlier on the page): iPhones, and Chrome too, only speak once the page had one.
// hush(): what's being said stops and is said again once busy() is over (this phone started talking).
export function createVoice({ win = globalThis, store = null, busy = () => false, primed = speechReady } = {}) {
  const synth = win && win.speechSynthesis;
  const Utter = win && win.SpeechSynthesisUtterance;
  const supported = !!synth && typeof synth.speak === 'function' && typeof Utter === 'function';
  const st = store || (() => { try { return win.localStorage || null; } catch { return null; } })();
  const queue = [];
  let speaking = null;
  let timer = null;
  let guard = null;
  let dead = false;
  let unlocked = unlockedOnce;
  const isUnlocked = () => {
    if (!unlocked && supported && speechWorks(win, primed)) unlocked = unlockedOnce = true;
    return unlocked;
  };
  let muted = (() => { try { return !!st && st.getItem(VOICE_KEY) === 'off'; } catch { return false; } })();

  function voiceFor() {
    try {
      const list = typeof synth.getVoices === 'function' ? synth.getVoices() || [] : [];
      return list.find((v) => /^en[-_]?(gb|us|ca|au)?/i.test(v.lang) && v.localService) || list.find((v) => /^en/i.test(v.lang)) || null;
    } catch { return null; }
  }

  function done(u) {
    if (speaking !== u) return;
    speaking = null;
    clearTimeout(guard);
    guard = null;
    pump();
  }

  function pump() {
    clearTimeout(timer);
    timer = null;
    if (dead || !supported || muted || !isUnlocked() || speaking || !queue.length) return;
    let wait = false;
    try { wait = !!busy(); } catch { wait = false; }
    if (wait) {
      timer = setTimeout(pump, WAIT_MS);
      return;
    }
    const words = queue.shift();
    let u;
    try {
      u = new Utter(words);
      u.lang = 'en-GB';
      const v = voiceFor();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1;
      u.onend = () => done(u);
      u.onerror = () => done(u);
      u.words = words;
      speaking = u;
      synth.speak(u);
    } catch (e) {
      console.error(e);
      speaking = null;
      timer = setTimeout(pump, 0);
      return;
    }
    // Some browsers never say "end": move on after a while anyway.
    guard = setTimeout(() => done(u), 3000 + words.split(/\s+/).length * 600);
  }

  function say(words) {
    const w = String(words || '').trim();
    if (!w || dead || !supported || muted || !isUnlocked()) return false;
    queue.push(w);
    while (queue.length > QUEUE_MOST) queue.shift();
    pump();
    return true;
  }

  function stop() {
    queue.length = 0;
    clearTimeout(timer);
    clearTimeout(guard);
    timer = guard = null;
    speaking = null;
    try { if (supported) synth.cancel(); } catch { /* ignore */ }
  }

  function hush() {
    const u = speaking;
    if (!u) return false;
    speaking = null;
    clearTimeout(guard);
    guard = null;
    if (u.words) queue.unshift(u.words);
    while (queue.length > QUEUE_MOST) queue.pop();
    try { synth.cancel(); } catch { /* ignore */ }
    clearTimeout(timer);
    timer = setTimeout(pump, WAIT_MS);
    return true;
  }

  return {
    supported,
    muted: () => muted,
    unlocked: () => isUnlocked(),
    // From a tap: speech works from now on (says "Voice on." unless muted). Something is always spoken inside
    // the tap itself (silently when "Voice on." has to wait for a clip): an iPhone's first speak() must be.
    unlock() {
      if (!supported || unlocked) return false;
      unlocked = true;
      unlockedOnce = true;
      if (!muted) {
        queue.unshift('Voice on.');
        pump();
      }
      if (!speaking) {
        try {
          const u = new Utter(' ');
          u.volume = 0;
          synth.speak(u);
        } catch { /* ignore */ }
      }
      return true;
    },
    hush,
    setMuted(on) {
      muted = !!on;
      try { if (st) { if (muted) st.setItem(VOICE_KEY, 'off'); else st.removeItem(VOICE_KEY); } } catch { /* ignore */ }
      if (muted) stop();
      else if (unlocked) say('Voice on.');
    },
    say,
    stop,
    destroy() { stop(); dead = true; },
    pending: () => queue.slice(),
  };
}

// For tests: forget that a tap unlocked speech on this page.
export function _resetUnlock() { unlockedOnce = false; }

// ---- the Driving layer ----------------------------------------------------------------------------------

// The pickup rows with their buttons, shared by the Driving layer and the parked card. Rows are made again only
// when the pickups or their states change; the words (distances) are updated in place, so a finger on a button
// never loses it. -> { el, update(lines) }
function pickupList(app, big, onSent = null) {
  const el = h('div.drive-pk-list');
  const S = { key: '', rows: new Map(), busy: false };
  function row(line) {
    const words = h('p.drive-pk-text', line.text);
    const buttons = [];
    const send = (b, what) => {
      if (S.busy || b.getAttribute('aria-disabled') === 'true') return;
      S.busy = true;
      for (const x of buttons) x.setAttribute('aria-disabled', 'true');
      Promise.resolve(app.cmd({ type: 'pickup', do: what, pickupId: line.id })).catch(() => null).then(() => {
        S.busy = false;
        for (const x of buttons) x.removeAttribute('aria-disabled');
        if (onSent) { try { onSent(what); } catch { /* fine */ } }
      });
    };
    if (line.state === 'open') {
      const b = h(`button.btn.drive-pk-btn${big ? '.big' : ''}`, { type: 'button', 'aria-label': `On my way to ${line.name}` }, 'On my way');
      b.addEventListener('click', () => send(b, 'coming'));
      buttons.push(b);
    }
    const done = h(`button.btn.primary.drive-pk-btn${big ? '.big' : ''}`, { type: 'button', 'aria-label': `Picked up ${line.name}` }, 'Picked up');
    done.addEventListener('click', () => send(done, 'done'));
    buttons.push(done);
    const rowEl = h('div.drive-pk', { 'data-id': line.id, 'data-state': line.state }, words, h('div.drive-pk-btns', buttons));
    return { el: rowEl, words };
  }
  return {
    el,
    update(lines) {
      const key = lines.map((l) => `${l.id}:${l.state}`).join('|');
      if (key !== S.key) {
        S.key = key;
        S.rows = new Map(lines.map((l) => [l.id, row(l)]));
        fill(el, [...S.rows.values()].map((r) => r.el));
      }
      for (const l of lines) { const r = S.rows.get(l.id); if (r) text(r.words, l.text); }
    },
  };
}

// The car and a pickup: "Sam: 300 m" (the line's label) and the big pin's words. Pure.
export function pickupPins(view) {
  const drive = view && view.drive;
  if (!drive || !drive.me || !Array.isArray(drive.pickups)) return [];
  const from = driverSpot(view);
  return drive.pickups.filter((k) => k && isPoint(k.p) && (k.state === 'open' || k.state === 'coming')).map((k) => {
    const name = String(k.name || 'Someone');
    const m = from ? directionWords(from, k.p).m : null;
    return {
      key: `pk:${k.id}`, id: k.id, p: k.p, kind: 'pickup', big: true,
      // (an unpinned pickup is where the hunter's face already is: no words over it, only the line)
      label: k.pinned ? (k.state === 'coming' ? `${name}: on my way` : `${name}: here`) : '',
      sub: '',
      from: from || null,
      line: Number.isFinite(m) ? `${name}: ${fmtDistance(m)}` : '',
    };
  });
}

// What the driver's map shows besides the marks: pickups (big, with lines) then the team's pins (big).
export function driveMapPins(view, d = 0) {
  return [...pickupPins(view), ...pinsFor(view, d).map((p) => ({ ...p, big: true }))];
}

// Marks the driver's map may draw: only hunters (self included) and an SOS. The server already sends no more;
// this is a second lock.
export function driveMarks(view) {
  const ids = new Set(((view && view.players) || []).filter((p) => p && p.team === 'hunter').map((p) => p.id));
  return ((view && view.marks) || []).filter((m) => m && (m.kind === 'sos' || ((m.kind === 'hunter' || m.kind === 'self') && ids.has(m.id))));
}

export function mountDrive(container, app, { onSos = null, onMenu = null } = {}) {
  const S = { view: null, recvAt: 0, dead: false, lastLeft: null, shown: false, held: [], pinKey: '', ringKey: '' };
  const offs = [];
  const voice = createVoice({ win: globalThis, busy: () => radioBusy(app.radio) });

  const leftNum = h('span.drive-left');
  const voiceWord = h('span.drive-voice-word');
  const voiceBtn = h('button.drive-voice', { type: 'button', 'aria-pressed': 'true' }, icon('speaker', 24), voiceWord);
  voiceBtn.addEventListener('click', () => {
    voice.unlock();
    voice.setMuted(!voice.muted());
    paintVoice();
  });
  const sosBtn = h('button.drive-sos', { type: 'button', 'aria-label': 'SOS: pause the game and get help' }, icon('sos', 20), h('span', { 'aria-hidden': 'true' }, 'SOS'));
  sosBtn.addEventListener('click', () => { if (onSos) onSos(); });
  const menuBtn = h('button.drive-menu', { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'dialog' }, icon('menu', 22));
  menuBtn.addEventListener('click', () => { if (onMenu) onMenu(); });

  const tapLine = h('p.drive-tap', { hidden: true }, icon('speaker', 22), h('span', TAP_LINE));
  const talking = h('p.drive-talking', { hidden: true, role: 'status' });
  const cpLine = h('p.drive-cp', { hidden: true }); // v1.3 PAGE-PLAY
  const mapBox = h('div.drive-map');
  // v1.4.8: "Recentre" (it was "Follow me"): back on the car, and while navigating turned and tilted again
  const followBtn = h('button.drive-follow', { type: 'button', hidden: true }, icon('locate', 24), h('span', 'Recentre'));
  const pkCount = h('button.drive-pk-count', { type: 'button', hidden: true });
  let radioBtn = null;
  try { radioBtn = app.radio && typeof app.radio.button === 'function' ? app.radio.button({ big: true }) : null; } catch (e) { console.error(e); }

  const layer = h('section.drive-layer', { hidden: true, 'aria-label': 'Driving' },
    h('header.drive-top',
      h('div.drive-bar',
        h('div.drive-time', icon('car', 20), h('span.label', 'Left'), leftNum),
        h('div.drive-top-btns', voiceBtn, sosBtn, menuBtn))),
    h('div.drive-body', mapBox, h('div.drive-lines', tapLine, talking, cpLine), followBtn),
    h('footer.drive-foot', radioBtn ? h('div.drive-radio', radioBtn) : null, pkCount));
  container.appendChild(layer);

  let map = null;
  let cam = null;
  let pinTool = null;
  let nav = null; // v1.4.8
  try {
    map = createMap(mapBox, { interactive: true });
    // v1.4.8: turn-by-turn: its card over the top of the map, its strip at the bottom, Navigate, the safety line
    try {
      nav = createNav(app, { map, voice, onChange: () => paint() });
      layer.querySelector('.drive-lines').prepend(nav.card);
      const foot = layer.querySelector('.drive-foot');
      foot.prepend(nav.strip);
      foot.append(nav.go, nav.safety);
    } catch (e) { console.error(e); nav = null; }
    // v1.4.8 end
    cam = createMapCam(map, {
      fitAll: () => map.fitAll({ ring: S.view && (S.view.ringNow || S.view.ring), marks: driveMarks(S.view) }),
      pointOf: () => driverSpot(S.view),
      follow: 'me',
    });
    offs.push(cam.on('mode', (mode) => { followBtn.hidden = mode === 'follow'; }));
    pinTool = createPinTool(app, { map, getView: () => S.view, navigate: nav ? (pin) => nav.start({ kind: 'pin', id: pin.id }) : null }); // v1.4.8: navigate
    if (typeof map.onPinTap === 'function') offs.push(map.onPinTap((key) => tapPin(key)));
  } catch (e) { console.error(e); }
  if (!nav) layer.querySelector('.drive-foot').append(h('p.drive-safety', SAFETY)); // v1.4.8
  followBtn.addEventListener('click', () => { if (cam) cam.follow('me'); S.navCamAt = 0; });
  pkCount.addEventListener('click', () => {
    const first = pickupLines(S.view)[0];
    if (first) pickupSheet(first.id);
  });

  function pickupSheet(id) {
    const view = S.view;
    const k = view && view.drive && (view.drive.pickups || []).find((x) => x && x.id === id);
    if (!k) return;
    const lines = pickupLines(view).find((l) => l.id === id);
    let sheet = null;
    const list = pickupList(app, true, () => { if (sheet) sheet.close(); });
    list.update(lines ? [lines] : []);
    // v1.4.8: Navigate there (turn-by-turn)
    let go = null;
    if (nav) {
      const on = nav.navigating(`pickup:${id}`);
      go = h(`button.btn.wide.nav-sheet-go${on ? '' : '.primary'}`, { type: 'button', ...(on ? { 'aria-disabled': 'true' } : {}) }, icon('car', 22), h('span', on ? 'Navigating' : 'Navigate'));
      go.addEventListener('click', () => {
        if (!on) nav.start({ kind: 'pickup', id });
        if (sheet) sheet.close();
      });
    }
    // v1.4.8 end
    sheet = openSheet({ title: `${k.name || 'Someone'}${k.pinned ? ': pick me up here' : ': pick me up'}`, className: 'drive-pk-sheet', body: [go, list.el].filter(Boolean), actions: [{ label: 'Close', kind: 'ghost' }] });
  }

  function tapPin(key) {
    const k = String(key || '');
    if (k.startsWith('pk:')) pickupSheet(k.slice(3));
    else if (pinTool) pinTool.tapPin(k);
  }

  function paintVoice() {
    const off = voice.muted() || !voice.supported;
    text(voiceWord, !voice.supported ? 'No voice' : off ? 'Voice off' : 'Voice on');
    voiceBtn.setAttribute('aria-pressed', off ? 'false' : 'true');
    voiceBtn.setAttribute('aria-label', !voice.supported ? "This phone can't speak" : off ? 'Voice is off. Turn it on' : 'Voice is on. Turn it off');
    cls(voiceBtn, 'off', off);
    if (!voice.supported) voiceBtn.setAttribute('aria-disabled', 'true');
    tapLine.hidden = !voice.supported || voice.unlocked() || voice.muted();
  }

  const unlock = () => {
    if (S.dead || !isDriver(S.view)) return;
    if (voice.unlock()) paintVoice();
  };
  if (typeof document !== 'undefined') {
    offs.push(listen(document, 'click', unlock, true));
    offs.push(listen(document, 'keydown', unlock, true));
  }

  function serverNow() {
    const v = S.view;
    if (!v || !Number.isFinite(v.now)) return Date.now();
    return v.now + (perfNow() - S.recvAt);
  }

  function elapsed() {
    const v = S.view;
    return v && v.phase === 'live' && !v.paused ? Math.max(0, perfNow() - S.recvAt) : 0;
  }

  function paintTalking() {
    const t = app.radio && app.radio.talking;
    const name = t && (t.name || ((S.view && (S.view.players || []).find((p) => p.id === t.from)) || {}).name);
    talking.hidden = !t;
    text(talking, t ? (t.words || `${name || 'Someone'} is talking`) : '');
  }

  function paintMap(view) {
    if (!map) return;
    const rk = JSON.stringify([view.ring, view.ringNow]);
    if (rk !== S.ringKey && (view.ringNow || view.ring)) {
      S.ringKey = rk;
      try { map.setRing(view.ring, view.ringNow); } catch (e) { console.error(e); }
    }
    // (v1.4.8: while navigating the car sits at this phone's own newest fix, which is fresher than the server's)
    const marks = nav ? nav.carMarks(driveMarks(view)) : driveMarks(view);
    try { map.setMarks(marks, { faces: app.faces, players: view.players, meId: view.me ? view.me.id : null, paused: !!view.paused }); } catch (e) { console.error(e); }
    const pins = nav ? nav.pinLines(driveMapPins(view, elapsed())) : driveMapPins(view, elapsed()); // v1.4.8: no straight line under a route
    const key = JSON.stringify(pins);
    if (key !== S.pinKey) {
      S.pinKey = key;
      try { map.setPins(pins); } catch (e) { console.error(e); }
    }
    // the first look: close on the car (about 600 m across), then Follow keeps it in the middle
    if (cam && !S.zoomed && driverSpot(view)) { S.zoomed = true; try { map.center(driverSpot(view), 16, { animate: false }); } catch { /* fine */ } }
    // v1.4.8: navigating: the map follows the car turned to its heading and tilted (a pan leaves it: Recentre);
    // otherwise north up and flat, as before
    const navCam = nav && nav.active() ? nav.camera() : null;
    if (cam && navCam && typeof map.navCamera === 'function') {
      S.tilted = true;
      // (The turn card and the lines under it cover the map's top: the car is placed in what's left.)
      try {
        const lines = layer.querySelector('.drive-lines');
        const top = Math.max(0, Math.round(lines.getBoundingClientRect().bottom - mapBox.getBoundingClientRect().top));
        if (typeof map.setInsets === 'function') map.setInsets({ top: top > 16 ? top : 0 });
      } catch { /* fine */ }
      if (cam.mode === 'follow' && perfNow() - (S.navCamAt || 0) >= CAMERA_EVERY_MS) {
        S.navCamAt = perfNow();
        try { map.navCamera(navCam); } catch (e) { console.error(e); }
      }
      return;
    }
    if (S.tilted && typeof map.flatView === 'function') {
      S.tilted = false;
      try { map.flatView(); if (typeof map.setInsets === 'function') map.setInsets({ top: 0 }); } catch { /* fine */ }
    }
    // v1.4.8 end
    if (cam) cam.frame();
  }

  function paint() {
    const view = S.view;
    if (!view || S.dead) return;
    const shown = showsDrive(view);
    if (shown !== S.shown) {
      S.shown = shown;
      layer.hidden = !shown;
      cls(container, 'drive-on', shown);
      holdUnder(shown);
      if (shown && map && map.resize) map.resize();
      // v1.4.8: the screen stays on while the Driving layer shows (the app's own wake lock); banners under the card
      try { if (app.alerts && typeof app.alerts.keepAwake === 'function') app.alerts.keepAwake(shown, 'drive'); } catch { /* fine */ }
      bannersUnder(shown);
    }
    const d = elapsed();
    const t = view.timing || {};
    const left = Number.isFinite(t.left) ? Math.max(0, t.left - d) : null;
    text(leftNum, left === null ? '--:--' : fmtClock(left));
    if (isDriver(view)) {
      const said = timeCall(S.lastLeft, left);
      if (said) voice.say(said);
    }
    S.lastLeft = left;
    setHidden(sosBtn, view.phase !== 'live' || !!view.paused);
    if (nav) { try { nav.update(view); } catch (e) { console.error(e); } } // v1.4.8
    if (!shown) return;
    placeBanners(); // v1.4.8
    { const cl = cpDriveLine(view, driverSpot(view), d); setHidden(cpLine, !cl); text(cpLine, cl); } // v1.3 PAGE-PLAY
    cls(layer, 'navigating', !!(nav && nav.active())); // v1.4.8
    const pk = pickupLines(view);
    setHidden(pkCount, !pk.length);
    text(pkCount, pk.length === 1 ? `Pickup: ${pk[0].name}` : `${pk.length} pickups`);
    pkCount.setAttribute('aria-label', pk.map((l) => l.text).join('. '));
    paintMap(view);
  }

  function setHidden(el, hide) { if (el.hidden !== !!hide) el.hidden = !!hide; }

  // v1.4.8: news banners sit under the turn card (and the lines under it) while the Driving layer shows, never over
  // the next turn (drive.css reads --drive-banners-top while <html> has .drive-shown).
  function placeBanners() {
    try {
      const root = document.documentElement;
      const lines = layer.querySelector('.drive-lines');
      const top = layer.querySelector('.drive-top');
      const r = lines ? lines.getBoundingClientRect() : null;
      const bottom = Math.round(r && r.height > 0 ? r.bottom : top ? top.getBoundingClientRect().bottom : 0);
      if (S.bannersTop !== bottom) {
        S.bannersTop = bottom;
        root.style.setProperty('--drive-banners-top', `${bottom}px`);
      }
    } catch { /* fine */ }
  }

  function bannersUnder(on) {
    try {
      document.documentElement.classList.toggle('drive-shown', !!on);
      if (!on) { document.documentElement.style.removeProperty('--drive-banners-top'); S.bannersTop = null; }
    } catch { /* fine */ }
  }
  // v1.4.8 end

  function holdUnder(on) {
    for (const release of S.held.splice(0)) release();
    if (!on) return;
    for (const el of [...container.children]) {
      if (el !== layer && !el.classList.contains('g-sos-layer')) S.held.push(holdInert(el));
    }
  }

  function onEvent(e) {
    if (S.dead || !e) return;
    const view = app.view || S.view;
    if (!isDriver(view)) return;
    if (Number.isFinite(e.at) && serverNow() - e.at > DRIVE_STALE_MS) return;
    const words = speechFor(e, view);
    if (words) voice.say(words);
    if (e.kind === 'over') S.lastLeft = null;
  }

  offs.push(app.on('event', onEvent));
  if (app.radio && typeof app.radio.on === 'function') {
    try { offs.push(app.radio.on('talking', () => paintTalking())); } catch { /* ignore */ }
    try { offs.push(app.radio.on('state', (st) => { if (st === 'recording' || st === 'asking') voice.hush(); })); } catch { /* ignore */ }
  }
  const timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try { paint(); paintTalking(); } catch (e) { console.error(e); }
  }, TICK_MS);
  paintVoice();

  return {
    el: layer,
    voice,
    nav: () => nav, // v1.4.8
    map: () => map,
    cam: () => cam,
    shown: () => S.shown,
    update(view) {
      if (S.dead || !view) return;
      if (view !== S.view) {
        S.view = view;
        S.recvAt = app.view === view && Number.isFinite(app.viewAt) && app.viewAt <= perfNow() ? app.viewAt : perfNow();
      }
      if (!isDriver(view)) voice.stop();
      paint();
      paintTalking();
      paintVoice();
    },
    destroy() {
      if (S.dead) return;
      S.dead = true;
      clearInterval(timer);
      for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
      voice.destroy();
      try { if (nav) nav.destroy(); } catch { /* ignore */ } // v1.4.8
      bannersUnder(false); // v1.4.8
      try { if (app.alerts && typeof app.alerts.keepAwake === 'function') app.alerts.keepAwake(false, 'drive'); } catch { /* ignore */ } // v1.4.8
      try { if (pinTool) pinTool.destroy(); } catch { /* ignore */ }
      try { if (cam) cam.destroy(); } catch { /* ignore */ }
      try { if (map) map.destroy(); } catch { /* ignore */ }
      holdUnder(false);
      cls(container, 'drive-on', false);
      layer.remove();
    },
  };
}

// ---- the hunter panel's parts ---------------------------------------------------------------------------

// "Pick me up" for a hunter who isn't the driver; then "Waiting for Jake" / "Jake is coming" with Cancel.
export function pickMeUp(app) {
  const S = { key: '', busy: false, view: null };
  const words = h('span.drive-ask-text');
  const ask = h('button.btn.wide.drive-ask', { type: 'button' }, icon('car', 22), words);
  const cancel = h('button.btn.small.ghost.drive-ask-cancel', { type: 'button' }, 'Cancel');
  const el = h('div.drive-ask-row', { hidden: true }, ask, cancel);

  function run(cmd) {
    if (S.busy) return;
    S.busy = true;
    ask.setAttribute('aria-disabled', 'true');
    cancel.setAttribute('aria-disabled', 'true');
    Promise.resolve(app.cmd(cmd)).catch(() => null).then(() => {
      S.busy = false;
      ask.removeAttribute('aria-disabled');
      cancel.removeAttribute('aria-disabled');
      if (S.view) paint(S.view);
    });
  }
  ask.addEventListener('click', () => {
    const st = pickupState(S.view);
    if (!st || st.state !== 'ask') return;
    run({ type: 'pickup', do: 'ask' });
  });
  cancel.addEventListener('click', () => {
    const mine = S.view && S.view.drive && S.view.drive.mine;
    if (mine) run({ type: 'pickup', do: 'cancel', pickupId: mine.id });
  });

  function paint(view) {
    const st = pickupState(view);
    el.hidden = !st;
    if (!st) return;
    const key = `${st.state}:${st.text}`;
    if (key === S.key) return;
    S.key = key;
    text(words, st.text);
    el.dataset.state = st.state;
    cancel.hidden = st.state === 'ask';
    cancel.setAttribute('aria-label', `Cancel the pickup from ${st.driver}`);
    cls(ask, 'waiting', st.state !== 'ask');
    if (st.state === 'ask') ask.removeAttribute('aria-live');
    else ask.setAttribute('aria-live', 'polite');
  }

  return {
    el,
    update(view) {
      S.view = view;
      paint(view);
    },
  };
}

// The parked driver's part of the panel (in place of I tagged someone and the powers): what parking does and
// the open pickups with their buttons.
export function driverCard(app) {
  const title = h('strong.drive-card-title', 'Parked');
  const line = h('span.drive-card-line');
  const list = pickupList(app, false);
  const el = h('div.drive-card', { hidden: true },
    h('div.drive-card-head', h('span.drive-card-icon', icon('car', 22)), h('div.drive-card-words', title, line)),
    list.el);
  return {
    el,
    update(view) {
      const on = isDriver(view);
      el.hidden = !on;
      if (!on) return;
      const drive = view.drive;
      const parked = !!drive.parked;
      text(title, parked ? "You're parked" : 'Driving');
      text(line, 'Your map shows the hunters, their pins and pickups. The hunters tell you where to go.');
      list.update(pickupLines(view));
    },
  };
}
