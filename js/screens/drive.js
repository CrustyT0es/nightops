// Night Ops: the driver (v1.1, PAGE-DRIVER).
//
//   mountDrive(container, app, { onSos, onMenu }) -> { update(view), destroy(), shown() }
//       The Driving layer: a full-screen layer over the game screen's map and panel, shown while this phone is
//       the driver and the server says the car isn't parked. No map: the time left, one big line per free hider
//       ("Ava: 400 m north-east, 1 min ago"), pickups with On my way / Picked up, the walkie-talkie, a voice
//       switch. It also speaks (speechSynthesis) whenever this phone is the driver, parked or not: new pings,
//       pickups, catches, closing in, 5 and 1 minutes left. Nothing needs a tap while moving.
//   pickMeUp(app) -> { el, update(view) }      a hunter's "Pick me up" (and Waiting / coming / Cancel)
//   driverCard(app) -> { el, update(view) }    the parked driver's part of the hunter panel (pickups, words)
//   driverReveal(words, view)                  the reveal screen's words for the driver (and the others)
//
// Parked or moving is the server's call (view.drive.parked, from the fixes it stored); this page never says.
// Pure helpers are exported for tests (tests/page-driver.test.mjs).
import { h, fill, text, cls, listen } from '../dom.js';
import { icon } from '../ui/icons.js';
import { holdInert } from '../ui/inert.js';
import { fmtClock, fmtDistance } from '../../shared/rules.js';
import { directionWords, isPoint } from '../../shared/geo.js';
import { speechReady } from '../alerts.js';

export const VOICE_KEY = 'nightops-drive-voice';   // 'off' = the driver muted the voice
export const DRIVE_STALE_MS = 120000;              // events older than this aren't spoken (a phone that slept)
export const FRESH_PING_MS = 45000;                // a ping mark this young came with the ping just heard
export const LIVE_KINDS = ['near', 'radar', 'exposure', 'outside'];
export const TIME_CALLS = [[300000, '5 minutes left.'], [60000, '1 minute left.']];
export const QUEUE_MOST = 6;                       // things waiting to be said; older ones go first
const TICK_MS = 500;
const WAIT_MS = 400;                               // how often a waiting voice looks again (a clip playing)
const TAP_LINE = 'Tap anywhere once to turn the voice on.';
const PARK_LINE = 'Parked? Stop for 5 seconds to see the map.';

const perfNow = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// ---- reading the view (pure) ----------------------------------------------------------------------------

// Show the Driving layer? Only for the driver, live, while the car isn't parked.
export function showsDrive(view) {
  return !!view && view.phase === 'live' && !!view.me && !!view.me.driver && view.me.status === 'in'
    && !!view.drive && !!view.drive.me && !view.drive.parked;
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

function hidersIn(view) {
  return ((view && view.players) || []).filter((p) => p && p.team === 'hider' && p.status === 'in');
}

function markOf(view, id) {
  return ((view && view.marks) || []).find((m) => m && m.id === id && m.kind !== 'sos' && m.kind !== 'seen') || null;
}

// How far and which way, as screen words ("400 m north-east") or '' without both spots.
function whereWords(from, to) {
  if (!isPoint(from) || !isPoint(to)) return '';
  const d = directionWords(from, to);
  return d.m < 20 ? 'right here' : `${fmtDistance(d.m)} ${d.dir}`;
}

// One line per free hider: [{ id, name, kind, live, text, m }]. d = ms since the view came (ages tick on).
export function hiderLines(view, d = 0) {
  const from = driverSpot(view);
  const extra = Math.max(0, Number(d) || 0);
  return hidersIn(view).map((p) => {
    const name = String(p.name || 'Someone');
    const m = markOf(view, p.id);
    if (!m || !isPoint(m.p)) return { id: p.id, name, kind: null, live: false, text: `${name}: no ping yet`, m: null };
    const live = LIVE_KINDS.includes(m.kind);
    const where = whereWords(from, m.p);
    const age = Math.max(0, (Number(m.age) || 0) + (live ? 0 : extra));
    let when;
    if (live) when = m.kind === 'near' ? 'live, near the car' : 'live';
    else if (m.kind === 'offline') when = `offline, ${agoWords(age)}`;
    else when = agoWords(age);
    const words = where ? `${where}, ${when}` : (live ? when : `pinged ${when}`);
    const dist = from ? directionWords(from, m.p).m : null;
    return { id: p.id, name, kind: m.kind, live, text: `${name}: ${words}`, m: dist };
  });
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
    case 'ping': {
      if (e.to !== 'hunters') return null;
      const from = driverSpot(view);
      const parts = [];
      for (const p of hidersIn(view)) {
        const m = markOf(view, p.id);
        if (!m || !isPoint(m.p) || !from) continue;
        const fresh = LIVE_KINDS.includes(m.kind) || (m.kind === 'ping' && Number(m.age) <= FRESH_PING_MS);
        if (!fresh) continue;
        const d = directionWords(from, m.p);
        parts.push(d.m < 20 ? `${p.name}, right here.` : `${p.name}, ${spokenDistance(d.m)} ${d.dir}.`);
      }
      return parts.length ? `Ping. ${parts.join(' ')}` : (words || null);
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
    case 'outside':
    case 'radar-live':
      return e.to === 'hunters' ? (words || null) : null;
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
      line: "You drive the car and give the hunters rides. You never tag and can't be caught.",
      keep: 'Eyes on the road: Night Ops talks to you while you drive. Stop for 5 seconds to see the map.',
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
function pickupList(app, big) {
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

export function mountDrive(container, app, { onSos = null, onMenu = null } = {}) {
  const S = { view: null, recvAt: 0, dead: false, lastLeft: null, shown: false, hdKey: '', held: [] };
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
  const pkTitle = h('h2.label.drive-sec-title', 'Pickups');
  const pkList = pickupList(app, true);
  const pkBox = h('section.drive-pickups', { hidden: true, 'aria-label': 'Pickups' }, pkTitle, pkList.el);
  const hdTitle = h('h2.label.drive-sec-title');
  const hdList = h('ul.drive-hiders-list');
  const hdBox = h('section.drive-hiders', { 'aria-label': 'Hiders' }, hdTitle, hdList);
  let radioBtn = null;
  try { radioBtn = app.radio && typeof app.radio.button === 'function' ? app.radio.button({ big: true }) : null; } catch (e) { console.error(e); }
  const radioBox = radioBtn ? h('div.drive-radio', radioBtn) : null;
  const parkLine = h('p.drive-park', icon('car', 20), h('span', PARK_LINE));

  const layer = h('section.drive-layer', { hidden: true, 'aria-label': 'Driving' },
    h('header.drive-top',
      h('div.drive-bar',
        h('p.drive-kicker', icon('car', 18), h('span', 'Driving')),
        h('div.drive-top-btns', voiceBtn, sosBtn, menuBtn)),
      h('div.drive-time', h('span.label', 'Left'), leftNum)),
    h('div.drive-body', tapLine, talking, pkBox, hdBox),
    h('footer.drive-foot', radioBox, parkLine));
  container.appendChild(layer);

  function paintVoice() {
    const off = voice.muted() || !voice.supported;
    text(voiceWord, !voice.supported ? 'No voice' : off ? 'Voice off' : 'Voice on');
    voiceBtn.setAttribute('aria-pressed', off ? 'false' : 'true');
    voiceBtn.setAttribute('aria-label', !voice.supported ? "This phone can't speak" : off ? 'Voice is off. Turn it on' : 'Voice is on. Turn it off');
    cls(voiceBtn, 'off', off);
    if (!voice.supported) voiceBtn.setAttribute('aria-disabled', 'true');
    tapLine.hidden = !voice.supported || voice.unlocked() || voice.muted();
  }

  // The first tap anywhere unlocks the voice (iPhones only speak after one).
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
    text(talking, t ? `${name || 'Someone'} is talking` : '');
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
    if (!shown) return;
    const pk = pickupLines(view);
    pkList.update(pk);
    setHidden(pkBox, !pk.length);
    const lines = hiderLines(view, d);
    text(hdTitle, lines.length ? `Hiders (${lines.length})` : 'Hiders');
    const hdKey = lines.map((l) => `${l.id}:${l.text}:${l.live ? 1 : 0}`).join('|');
    if (hdKey !== S.hdKey) {
      S.hdKey = hdKey;
      fill(hdList, lines.length
        ? lines.map((l) => {
          const i = l.text.indexOf(': ');
          return h(`li.drive-hider${l.live ? '.live' : ''}`, { 'data-id': l.id },
            h('strong', l.text.slice(0, i + 1)), ` ${l.text.slice(i + 2)}`);
        })
        : h('li.drive-hider.none', 'Nobody is hiding any more.'));
    }
  }

  function setHidden(el, hide) { if (el.hidden !== !!hide) el.hidden = !!hide; }

  // While the layer shows, the map and panel under it can't be reached (the SOS screen above it can).
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
    // A hold starts: what the voice is saying stops (said again after), so it's never in the clip.
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
      const near = Number(drive.near) || 0;
      text(line, parked
        ? (near ? `${near} ${near === 1 ? 'hider' : 'hiders'} near the car, live on your map.` : 'Hiders within 150 m of the car show live here.')
        : 'Drive off and the driving screen comes back.');
      list.update(pickupLines(view));
    },
  };
}
