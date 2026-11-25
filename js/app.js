// Night Ops: the App. It owns everything: the saved identity, the game you're in, the sync loop, the events,
// the faces, location, and which screen shows. Screens never talk to the server: they use the App.
//
//   const app = new App({ api, identity, location, alerts, root })
//   app.view          the latest view (view.events = every event kept, oldest first) or null
//   app.viewAt        when app.view came (performance.now()), so a screen shown later knows how old it is
//   app.events        the same list of events (deduped by id, at most 400)
//   app.me            { name, face } saved on this phone (setting it saves it)
//   app.game          { code, id, secret } | null
//   app.savedGame     a saved game we're not showing (someone opened an invite link to another game)
//   app.connection    'ok' | 'reconnecting' | 'offline'
//   app.screen        the screen showing ('home', 'lobby', ...); app.args its arguments ({ code } for home)
//   app.linkCode      the code from an invite link (?code=), '' if none
//   app.faces         Map id -> data: URL (fetched once per faceV)
//   app.location      the createLocation() object; app.alerts the alerts module
//   app.on(name, fn)  -> off(). 'view' (every new view), 'event' (each new event, oldest first, never twice),
//                     'error' (an ApiError), 'screen' (name), 'connection' (state), 'faces' (the Map)
//   app.go(name, args)                show a screen: 'home' | 'lobby' | 'ring' | 'reveal' | 'game' | 'over'
//   app.create(opts), app.join(code, opts)   opts: { name, face, quiet }; -> Promise<view|ApiError>
//   app.leave()       leave the game (best effort on the server) and go home
//   app.resume()      go back to app.savedGame
//   app.cmd(cmd, { quiet })   -> Promise<view|ApiError>; a banner says what went wrong unless quiet
//   app.setFace(dataUrl)      save a new selfie (and send it when in a game) -> Promise<view|ApiError|null>
//   app.positionNow() latest own position { p, acc, speed, at } or null
//   app.player(id)    a player from the latest view, or null
//   app.inviteLink()  https://.../?code=WYKUSX (opens Join with the code filled in)
//   app.syncNow()     ask the server for news now
// An ApiError has code, message, status, offline, ok: false and error: { code, message }; a view never has
// `message` or `error`, so `if (result.error)` tells them apart.
//
// Screen modules export mount(root, app, args) -> { update(view), destroy() }. update() is called on every
// view (and again when faces arrive). A screen that fails to load or throws shows a plain card with Try again.
import { TIMING, LIMITS } from '../shared/rules.js?v=181';
import { h, fill } from './dom.js?v=181';
import { icon } from './ui/icons.js?v=181';
import { banner as defaultBanner } from './ui/banner.js?v=181';
import { closeSheets } from './ui/sheet.js?v=181';
import { backButton } from './ui/back.js?v=181';
import { ApiError, toApiError, WORDS } from './api.js?v=181';
import { cleanName, cleanFace } from './identity.js?v=181';
import { createRadio, fromBase64 } from './radio.js?v=181'; // v1.1 PAGE-RADIO
import { createCamera } from './camera.js?v=181'; // v1.2 PAGE-CAM
import { cpWantsFresh } from './screens/cpplay.js?v=181'; // v1.3 PAGE-PLAY
import { createMedia } from './media.js?v=181'; // v1.4 PAGE-DEVICES
import { deviceKind } from './help.js?v=181'; // v1.4 PAGE-DEVICES
import { deviceSecret, rememberPc } from './pcedit.js?v=181'; // v1.5: the PC edit
import { onAnswer as onPermAnswer } from './permissions.js?v=181'; // v1.6.2 PERMS

export const SCREENS = ['home', 'lobby', 'ring', 'reveal', 'game', 'over', 'watch']; // v1.1 PAGE-WATCH: 'watch'
SCREENS.push('checkpoints'); // v1.3 PAGE-SETUP: the checkpoint editor (the host, in the lobby)
export const EVENT_CAP = 400;
export const HELD_CAP = 100;       // events kept for a screen that is still loading
export const BACKOFF_MS = [1000, 2000, 5000, 10000];
export const SEEN_KEY = 'nightops-seen';
export const REVEALED_KEY = 'nightops-revealed';
export const BACK_WORDS = "To leave the game, use I'm out in the menu.";
const SOON_MS = 400;              // a sync this soon after a command
const REVEAL_MAX_MS = 30000;      // the reveal gives way to the game after this long
const FACE_RETRY_MS = 15000;
const GONE = new Set(['gone', 'no_game', 'bad_secret', 'bad_player', 'no_player', 'unknown_game', 'not_found', 'kicked']);
const NOT_SENT = "No connection, so that didn't go through. Try again.";
const PHOTO_ASK_AGAIN_MS = 10000;
// v1.3: a checkpoint photo goes with a fix at most this old (the server wants one under TIMING.CP_FRESH_MS, 20 s),
// waiting at most PHOTO_FIX_WAIT_MS for it after the phone's camera closes.
export const PHOTO_FIX_AGE_MS = 6000;
export const PHOTO_FIX_WAIT_MS = 8000;  // v1.3 PAGE-PLAY: a checkpoint photo that didn't come isn't asked for again sooner

// ---- pure helpers (tested in Node) ------------------------------------------------------------------

export function sideOf(team) {
  if (team === 'hunter') return 'hunters';
  if (team === 'hider') return 'hiders';
  return null;
}

export function isEvent(e) {
  return !!e && typeof e === 'object' && Number.isFinite(e.id);
}

export function maxId(events, start = 0) {
  let m = start;
  for (const e of events || []) if (isEvent(e) && e.id > m) m = e.id;
  return m;
}

// held + incoming, deduped by id (the incoming copy wins), oldest first, only the newest `cap`.
export function mergeEvents(held, incoming, cap = EVENT_CAP) {
  const byId = new Map();
  for (const e of held || []) if (isEvent(e)) byId.set(e.id, e);
  for (const e of incoming || []) if (isEvent(e)) byId.set(e.id, e);
  const out = [...byId.values()].sort((a, b) => a.id - b.id);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

// Events without the ones addressed to `side` ('hunters' | 'hiders').
export function dropSide(events, side) {
  return side ? (events || []).filter((e) => e.to !== side) : (events || []).slice();
}

export function eventsAfter(events, lastId) {
  return (events || []).filter((e) => isEvent(e) && e.id > lastId);
}

export function backoffDelay(failures) {
  if (!(failures > 0)) return 0;
  return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
}

// Which screen a view wants. current = the screen showing; revealed = this game's reveal was shown here.
// null = no opinion (no view).
export function chooseScreen({ view, current = null, revealed = false } = {}) {
  if (!view || typeof view !== 'object') return null;
  // v1.1 PAGE-WATCH: a spectator's view: the watch screen, and the normal end screen (never reveal, ring or game)
  if (view.watcher) return watchScreenFor(view);
  // v1.1 end PAGE-WATCH
  // v1.3 PAGE-SETUP: the host stays in the checkpoint editor while the lobby lasts
  if (view.phase === 'lobby' && current === 'checkpoints') return view.me && view.me.host ? 'checkpoints' : 'lobby';
  // v1.3 end PAGE-SETUP
  if (view.phase === 'lobby') return current === 'ring' && view.me && view.me.host ? 'ring' : 'lobby';
  if (view.phase === 'live') {
    if (current === 'reveal') return 'reveal';
    return revealed ? 'game' : 'reveal';
  }
  if (view.phase === 'over') return 'over';
  return null;
}

// v1.1 PAGE-WATCH: spectators (pure helpers, tested in Node)
const WATCH_GONE = new Set(['gone', 'no_game', 'bad_secret', 'bad_player', 'no_player', 'unknown_game', 'not_found',
  'kicked', 'no_watch', 'no_watcher']);

// The screen for a spectator's view: 'watch' in the lobby and the game, 'over' at the end.
export function watchScreenFor(view) {
  if (!view || typeof view !== 'object') return null;
  if (view.phase === 'over') return 'over';
  if (view.phase === 'lobby' || view.phase === 'live') return 'watch';
  return null;
}

// Errors that mean this phone no longer watches that game (removed, watching turned off, the game gone).
export function isWatchGone(err) {
  if (!err) return false;
  if (WATCH_GONE.has(err.code)) return true;
  return !!err.fromServer && (err.status === 403 || err.status === 404);
}

export function watchLostWords(err) {
  if (err && err.code === 'kicked') return 'The host stopped you watching this game.';
  if (err && err.code === 'no_watch') return "This game doesn't allow watching any more.";
  if (err && (err.code === 'no_game' || err.status === 404)) return 'That game is over or was closed.';
  if (err && err.fromServer && err.message) return err.message;
  return "You're no longer watching that game.";
}
// v1.1 end PAGE-WATCH

// The side whose news this phone gets: your team's, but only while you're still in (a hider who was caught and
// sits out gets neither side's news, like the server's canSee).
export function sideNow(view) {
  return view && view.me && view.me.status === 'in' ? sideOf(view.me.team) : null;
}

// Whether `view` is newer than `prev`. `rev` is the saved version of the game a view was made from: a view
// made from an older save is older, whatever its time says (a sync that read the game just before a command
// saved it, but answered after). Without `rev` (or with the same one), the later `now` wins.
// v1.4 Your games: a short role and result for the list.
export function roleOf(view) {
  const me = view && view.me;
  if (!me) return '';
  if (me.driver) return 'driver';
  const t = me.startTeam || me.team;
  return t === 'hunter' ? 'hunter' : t === 'hider' ? 'hider' : '';
}
export function resultOf(view) {
  const sum = view && (view.summary || view.result);
  if (!sum) return 'Game over';
  const me = view.me && view.me.id;
  if (me && Array.isArray(sum.winners) && sum.winners.includes(me)) return 'You won';
  if (sum.reason === 'caught') return 'The hunters won';
  if (sum.reason === 'time' || sum.reason === 'host') return 'The hiders won';
  return 'Game over';
}

export function isFresher(view, prev) {
  if (!prev) return true;
  const later = !(Number(view && view.now) < Number(prev.now));
  const rv = Number(view && view.rev);
  const pv = Number(prev.rev);
  if (Number.isFinite(rv) && Number.isFinite(pv)) return rv > pv || (rv === pv && later);
  return later;
}

// When a view's round started (epoch ms), or null (the lobby, or a server that doesn't say).
export function roundOf(view) {
  return view && Number.isFinite(view.round) ? view.round : null;
}

// Which round the reveal was shown for: the code plus the round's start (else the newest 'start' event held).
export function revealKey(view, events, code) {
  const c = String((view && view.code) || code || '');
  const round = roundOf(view);
  if (round !== null) return `${c}:${round}`;
  let start = null;
  for (const e of events || []) if (isEvent(e) && e.kind === 'start' && (!start || e.id > start.id)) start = e;
  return start ? `${c}:e${start.id}` : c;
}

// body[data-team]: 'hunter' | 'hider' | 'out' | 'none'
export function teamOf(view) {
  if (!view || view.phase !== 'live' || !view.me) return 'none';
  if (view.me.status !== 'in') return 'out';
  return view.me.team === 'hunter' || view.me.team === 'hider' ? view.me.team : 'none';
}

// A 6-letter game code from whatever was typed or pasted (an invite link works too); '' when there's none.
export function normalizeCode(raw) {
  let s = String(raw ?? '');
  const m = /[?#&]code=([A-Za-z0-9-]{6,8})/.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{6}$/.test(s) ? s : '';
}

// Errors that mean this phone is no longer in that game.
export function isGone(err, action = '') {
  if (!err) return false;
  if (GONE.has(err.code)) return true;
  // A sync has nothing else that can be refused: Night Ops itself saying 403/404 means we're out.
  return action === 'sync' && !!err.fromServer && (err.status === 403 || err.status === 404);
}

function lostWords(err) {
  if (err && err.code === 'kicked') return 'The host removed you from the game.';
  if (err && err.fromServer && err.message) return err.message;
  if (err && err.code === 'no_game') return 'That game is over or was closed.';
  return "You're no longer in that game.";
}

function sameArgs(a, b) {
  try { return JSON.stringify(a || {}) === JSON.stringify(b || {}); } catch { return false; }
}

function isFaceUrl(u) {
  return typeof u === 'string' && u.length < 200000 && /^data:image\/(jpeg|png|webp|svg\+xml)[;,]/.test(u);
}

function shortText(s, n = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

// sessionStorage first (this tab), localStorage too (survives a crash); memory when both are blocked.
export function webStore() {
  const memory = new Map();
  const stores = () => {
    const out = [];
    try { if (globalThis.sessionStorage) out.push(globalThis.sessionStorage); } catch { /* blocked */ }
    try { if (globalThis.localStorage) out.push(globalThis.localStorage); } catch { /* blocked */ }
    return out;
  };
  return {
    get(key) {
      for (const s of stores()) {
        try {
          const v = s.getItem(key);
          if (v !== null && v !== undefined) return v;
        } catch { /* next */ }
      }
      return memory.has(key) ? memory.get(key) : null;
    },
    set(key, value) {
      memory.set(key, String(value));
      for (const s of stores()) {
        try { s.setItem(key, String(value)); } catch { /* full or blocked */ }
      }
    },
    remove(key) {
      memory.delete(key);
      for (const s of stores()) {
        try { s.removeItem(key); } catch { /* ignore */ }
      }
    },
  };
}

export function memoryStore() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => m.set(k, String(v)),
    remove: (k) => m.delete(k),
  };
}

function defaultLoadScreen(name, attempt) {
  return attempt ? import(`./screens/${name}.js?try=${attempt}`) : import(`./screens/${name}.js`);
}

// ---- the App ----------------------------------------------------------------------------------------

const HEALTH_ACTIONS = new Set(['sync', 'cmd', 'radio', 'cp-photo', 'tap-piece']); // v1.4 PAGE-DEVICES

export class App {
  constructor({
    api,
    identity,
    location = null,
    alerts = null,
    root = null,
    banner = defaultBanner,
    loadScreen = defaultLoadScreen,
    store = webStore(),
    doc = globalThis.document ?? null,
    win = globalThis.window ?? null,
    syncMs = TIMING.SYNC_MS,
    autoScreen = true,
    back = backButton,
    radio = createRadio, // v1.1 PAGE-RADIO: makes app.radio (null = no walkie-talkie)
    camera = createCamera, // v1.2 PAGE-CAM: makes app.cam (null = this browser can't film)
    media = createMedia, // v1.4 PAGE-DEVICES: makes app.media (the one shared camera + microphone stream)
  } = {}) {
    this.api = api;
    this.back = back;
    this.identity = identity;
    this.location = location;
    this.alerts = alerts;
    this.root = root;
    this.banner = (...a) => {
      try { return banner(...a); } catch (e) { console.error(e); return null; }
    };
    this.loadScreen = loadScreen;
    this.store = store;
    this.doc = doc;
    this.win = win;
    this.syncMs = syncMs;
    this.autoScreen = autoScreen;

    this.view = null;
    this.game = null;
    this.savedGame = null;
    this.events = [];
    this.faces = new Map();
    this.connection = 'ok';
    this.screen = null;
    this.args = {};
    this.linkCode = '';

    this._fns = new Map();
    this._since = 0;
    this._lastEmitted = 0;
    this._failures = 0;
    this._timer = null;
    this._syncing = null;
    this._again = false;
    this._faceVs = new Map();
    this._facesBusy = false;
    this._facesRetryAt = 0;
    this._mounted = null;
    this._token = 0;
    this._tries = 0;
    this._updateFails = 0;
    this._locOn = false;
    this._busy = null;
    this._started = false;
    this._off = [];
    this._revealTimer = null;
    this._net = null;
    this._placed = 0;
    this._stopped = false;
    this._wasLive = false;
    this._held = [];   // events for a screen that is still loading (given to it once it's there)
    // v1.1 PAGE-WATCH: the game this phone watches as a spectator ({ code, id, secret }), and how often it asks
    this.watchGame = null;
    this.watchMs = TIMING.WATCH_SYNC_MS;
    // v1.1 end PAGE-WATCH
    // v1.1 PAGE-RADIO: the walkie-talkie (null when this browser can't record or play), and the clips fetched
    // (n -> Promise of { url, ... }; their blob: URLs let go of on a new round or leaving)
    this._clips = new Map();
    this._clipUrls = [];
    this.radio = null;
    try {
      this.radio = typeof radio === 'function' ? radio({ app: this, alerts, doc, win }) || null : null;
    } catch (e) {
      console.error(e);
      this.radio = null;
    }
    // v1.1 end PAGE-RADIO
    // v1.4 PAGE-DEVICES: the one shared stream and its watchdog (before the camera, which films from it)
    this.media = null;
    try {
      this.media = typeof media === 'function' ? media({ doc, win }) || null : null;
    } catch (e) {
      console.error(e);
      this.media = null;
    }
    this.soundOk = false; // the ready check's "Test" (or the alarm) made a sound: the AudioContext is unlocked
    // v1.4 end PAGE-DEVICES
    // v1.2 PAGE-CAM: the highlight cam (null when this browser can't record video), and the newest moment taken
    this.camSince = 0;
    this.cam = null;
    try {
      this.cam = typeof camera === 'function' ? camera({ app: this, alerts, doc, win }) || null : null;
    } catch (e) {
      console.error(e);
      this.cam = null;
    }
    // v1.2 end PAGE-CAM
    // v1.4 PAGE-DEVICES: the camera stopping (after the game's last clip) lets the shared stream go
    try { if (this.cam && this.media) this.cam.on('state', () => this._wantMedia()); } catch (e) { console.error(e); }
    // v1.3 PAGE-PLAY: checkpoint photos fetched (id -> data: URL), cleared on a new round and on leaving
    this.photos = new Map();
    this._photoAsked = new Map(); // id -> when it was last asked for and didn't come (not asked again for 10 s)
    this._photoWait = new Map();  // id -> Promise of the answer it's in
    // v1.3 end PAGE-PLAY
  }

  // v1.1 PAGE-WATCH: true while this phone is a spectator (app.game is null then)
  get watching() {
    return !!this.watchGame && !this.game;
  }
  // v1.1 end PAGE-WATCH

  // ---- who you are ----

  get me() {
    try { return this.identity && this.identity.loadMe ? this.identity.loadMe() : null; } catch { return null; }
  }

  set me(value) {
    this.saveMe(value);
  }

  saveMe(value) {
    let saved = null;
    try { saved = this.identity.saveMe(value); } catch (e) { console.error(e); }
    if (this.game && saved && saved.face) this.faces.set(this.game.id, saved.face);
    return saved;
  }

  // ---- listeners ----

  on(name, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!this._fns.has(name)) this._fns.set(name, new Set());
    this._fns.get(name).add(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    const set = this._fns.get(name);
    if (set) set.delete(fn);
  }

  emit(name, ...args) {
    const set = this._fns.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }

  // ---- starting and stopping ----

  // start({ code }): code = the ?code= from an invite link.
  start({ code = '', watch = '' } = {}) {
    if (this._started) return;
    this._started = true;
    this._stopped = false;
    this._listen();
    const link = normalizeCode(code);
    this.linkCode = link;
    // v1.1 PAGE-WATCH: a ?watch= link, or a game this phone was watching (a reload)
    if (!link && this._startWatching(normalizeCode(watch))) return;
    // v1.1 end PAGE-WATCH
    let saved = null;
    try { saved = this.identity.loadGame(); } catch { saved = null; }
    if (saved && (!link || link === saved.code)) {
      this._enterSaved(saved);
      return;
    }
    this.savedGame = saved || null;
    this.go('home', link ? { code: link, join: true } : {});
  }

  // Stops the loop and every timer (tests, the preview). syncNow() still works by hand.
  stop() {
    this._started = false;
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    clearTimeout(this._revealTimer);
    for (const off of this._off.splice(0)) off();
    this._guard(false);
    if (this._locOn && this.location) {
      this._locOn = false;
      try { this.location.stop(); } catch { /* ignore */ }
    }
  }

  _listen() {
    const add = (target, type, fn) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      this._off.push(() => target.removeEventListener(type, fn));
    };
    // v1.6.2 PERMS: an Allow button (or the gear check) got an answer: what waited for it starts, no reload
    this._off.push(onPermAnswer((a) => this.allowed(a)));
    add(this.doc, 'visibilitychange', () => {
      if (this._hidden()) {
        clearTimeout(this._timer);
        this._timer = null;
      } else if (this.game) {
        this.syncNow();
      }
    });
    add(this.win, 'online', () => {
      if (!this.game) return;
      this._failures = 0;
      this._setConnection('reconnecting');
      this.syncNow();
    });
    add(this.win, 'offline', () => {
      if (this.game) this._setConnection('offline');
    });
    add(this.win, 'pageshow', (e) => {
      if (e && e.persisted && this.game) this.syncNow();
    });
    // v1.1 PAGE-WATCH: the same for a spectator's loop
    add(this.doc, 'visibilitychange', () => {
      if (!this.watching) return;
      if (this._hidden()) {
        clearTimeout(this._timer);
        this._timer = null;
      } else {
        this.syncNow();
      }
    });
    add(this.win, 'online', () => {
      if (!this.watching) return;
      this._failures = 0;
      this._setConnection('reconnecting');
      this.syncNow();
    });
    add(this.win, 'offline', () => {
      if (this.watching) this._setConnection('offline');
    });
    add(this.win, 'pageshow', (e) => {
      if (e && e.persisted && this.watching) this.syncNow();
    });
    // v1.1 end PAGE-WATCH
  }

  _hidden() {
    return !!this.doc && this.doc.visibilityState === 'hidden';
  }

  _online() {
    return globalThis.navigator?.onLine !== false;
  }

  // ---- games ----

  create(opts = {}) {
    if (this._busy) return this._busy;
    this._busy = this._create(opts).finally(() => { this._busy = null; });
    return this._busy;
  }

  async _create(opts) {
    const me = this._meFrom(opts);
    if (!me.name) return this._fail(new ApiError({ code: 'name', message: 'Type your name first.' }), opts);
    const old = this.game || this.savedGame;
    try {
      const res = await this.api.post('create', { name: me.name, ...this._device(), ...(me.face ? { face: me.face } : {}) }, { timeoutMs: 20000 });
      const g = {
        code: String(res?.code || res?.view?.code || '').toUpperCase(),
        id: res?.player?.id,
        secret: res?.player?.secret,
      };
      if (!this._enter(g, res && res.view)) throw new ApiError({ code: 'bad_answer', message: WORDS.bad_answer });
      if (old && old.code !== this.game.code) this._sendLeave(old);
      return this.view;
    } catch (e) {
      return this._fail(toApiError(e), opts);
    }
  }

  join(code, opts = {}) {
    const c = normalizeCode(code);
    if (!c) {
      return Promise.resolve(this._fail(new ApiError({
        code: 'bad_code',
        message: 'Game codes have 6 letters and numbers, like WYKUSX.',
      }), opts));
    }
    if (this.game && this.game.code === c) return this.syncNow().then(() => this.view);
    if (this.savedGame && this.savedGame.code === c) return this.resume();
    if (this._busy) return this._busy;
    this._busy = this._join(c, opts).finally(() => { this._busy = null; });
    return this._busy;
  }

  async _join(c, opts) {
    const me = this._meFrom(opts);
    if (!me.name) return this._fail(new ApiError({ code: 'name', message: 'Type your name first.' }), opts);
    const old = this.game || this.savedGame;
    try {
      const res = await this.api.post('join', { code: c, name: me.name, ...this._device(), ...(me.face ? { face: me.face } : {}) }, { timeoutMs: 20000 });
      const g = {
        code: String(res?.view?.code || c).toUpperCase(),
        id: res?.player?.id,
        secret: res?.player?.secret,
      };
      if (!this._enter(g, res && res.view)) throw new ApiError({ code: 'bad_answer', message: WORDS.bad_answer });
      if (old && old.code !== this.game.code) this._sendLeave(old);
      return this.view;
    } catch (e) {
      return this._fail(toApiError(e), opts);
    }
  }

  resume() {
    const g = this.savedGame;
    if (!g) return Promise.resolve(this.view);
    this.savedGame = null;
    this._enterSaved(g);
    return this.syncNow().then(() => this.view);
  }

  // v1.4 Your games: a finished round this phone was in (or watched) is remembered for the home screen.
  _rememberPast(view, cred, as) {
    if (!view || view.phase !== 'over' || !cred || !Number.isFinite(view.round)) return;
    if (!this.identity || typeof this.identity.rememberPast !== 'function') return;
    try {
      this.identity.rememberPast({
        code: cred.code, id: cred.id, secret: cred.secret, as, round: view.round,
        mode: view.settings && view.settings.mode, when: view.round, role: as === 'watcher' ? 'watched' : roleOf(view),
        result: resultOf(view),
      });
    } catch { /* ignore */ }
  }

  // ---- v1.5: the PC edit ----
  // This phone's device secret (for a PC it's linked to), sent with create / join / watch; {} when there's no storage.
  _device() {
    // (Only a real browser's storage: a page with none, like the tests' stand-in, sends nothing new.)
    try { return globalThis.localStorage ? { device: deviceSecret(globalThis.localStorage) } : {}; } catch { return {}; }
  }

  // The credentials of the round on screen: the game, the spectated game or a past game. null when there's none.
  _roundCred() {
    const v = this.view;
    if (!v || !Number.isFinite(v.round)) return null;
    if (this.pastGame) {
      const g = this.pastGame;
      return { code: g.code, round: v.round, [g.as === 'watcher' ? 'watcher' : 'player']: { id: g.id, secret: g.secret } };
    }
    if (this.watching && this.watchGame) return { code: this.watchGame.code, round: v.round, watcher: { id: this.watchGame.id, secret: this.watchGame.secret } };
    if (this.game) return { code: this.game.code, round: v.round, player: { id: this.game.id, secret: this.game.secret } };
    return null;
  }

  // Link this phone to a PC with the code the PC shows. -> Promise<the PC's name> (rejects with an ApiError)
  async linkPc(pair) {
    const me = this._meFrom({});
    const cred = this._roundCred();
    const body = { pair, ...this._device(), name: me.name || '' };
    if (cred) {
      body.code = cred.code;
      if (cred.player) body.player = cred.player;
      if (cred.watcher) body.watcher = cred.watcher;
    }
    const res = await this.api.post('maker-link', body, { timeoutMs: 20000 });
    const name = res && res.linked && typeof res.linked.name === 'string' ? res.linked.name : '';
    try { rememberPc(globalThis.localStorage, name); } catch { /* fine */ }
    this.emit('pc-linked', name);
    return name;
  }

  // The PC edit of the round on screen: { status, progress, note, by, files? } or null (none). Never rejects.
  async proEdit() {
    const cred = this._roundCred();
    if (!cred) return null;
    try {
      const res = await this.api.post('maker-movies', cred, { timeoutMs: 15000 });
      const m = res && res.maker && typeof res.maker === 'object' ? res.maker : null;
      if (m && m.status === 'ready' && this.identity && typeof this.identity.loadPast === 'function') {
        const g = this.identity.loadPast().find((x) => x.code === cred.code && x.round === cred.round);
        if (g && g.pro !== 'ready') { try { this.identity.rememberPast({ ...g, pro: 'ready' }); } catch { /* fine */ } }
      }
      return m;
    } catch {
      return null;
    }
  }

  // v1.4 Your games: the remembered games and whether the server still has them ([{...item, there, kept, until}]).
  async pastGames() {
    const list = this.identity && typeof this.identity.loadPast === 'function' ? this.identity.loadPast() : [];
    if (!list.length) return [];
    let res = null;
    try { // a failed check keeps the saved dates (the list still shows)
      res = await this.api.post('past-check', { items: list.map((g) => ({ code: g.code, round: g.round, id: g.id, secret: g.secret, as: g.as })) });
    } catch { res = null; }
    const items = Array.isArray(res && res.items) ? res.items : [];
    const out = [];
    for (const g of list) {
      const r = items.find((x) => x && x.code === g.code && x.round === g.round);
      if (r && r.there === false) {
        try { this.identity.forgetPast(g.code, g.round); } catch { /* ignore */ }
        continue;
      }
      out.push({ ...g, there: !!(r && r.there), kept: r ? r.kept : (g.kept ?? null), until: r ? r.until : (g.until ?? null) });
    }
    return out;
  }

  // v1.4 Your games: open a remembered game's end screen (replay, highlights, downloads). False when it's gone.
  async openPast(g) {
    const who = { id: g.id, secret: g.secret };
    let res;
    try {
      res = await this.api.post('past', { code: g.code, round: g.round, ...(g.as === 'watcher' ? { watcher: who } : { player: who }) });
    } catch (e) {
      if (e && (e.status === 404 || e.status === 403)) {
        try { this.identity.forgetPast(g.code, g.round); } catch { /* ignore */ }
        this.banner('This game is gone.', 'warn', 5000);
        return false;
      }
      this._fail(e);
      return false;
    }
    if (!res || !res.view) return false;
    this._resetGameState();
    this.game = null;
    this.savedGame = null;
    this.pastGame = g;
    this.view = { ...res.view, events: Array.isArray(res.view.events) ? res.view.events : [] };
    this.viewAt = globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now();
    this.go('over');
    this._pastFaces(g);
    return true;
  }

  // v1.4.3: a past game's profile pictures, so the replay shows faces, not initials (asked with that game's own
  // id and secret; the game's players now, so a round held after Play again may miss some). Failures are quiet.
  _pastFaces(g) {
    const v = this.view;
    const ids = (Array.isArray(v && v.players) ? v.players : [])
      .filter((p) => p && typeof p.id === 'string' && Number(p.faceV) > 0 && !this.faces.has(p.id)).map((p) => p.id);
    if (!ids.length) return;
    const who = { id: g.id, secret: g.secret };
    this.api.post('faces', { code: g.code, ids, ...(g.as === 'watcher' ? { watcher: who } : { player: who }) }, { timeoutMs: 15000 })
      .then((res) => {
        if (this.pastGame !== g) return;
        const got = res && res.faces && typeof res.faces === 'object' ? res.faces : {};
        let any = false;
        for (const id of ids) if (isFaceUrl(got[id])) { this.faces.set(id, got[id]); any = true; }
        if (any) this.emit('faces', this.faces);
      })
      .catch(() => { /* initials stay */ });
  }

  leave() {
    if (this.pastGame) { // v1.4: leaving a past game's end screen only goes home
      this.pastGame = null;
      this.view = null;
      this.go('home', {});
      return Promise.resolve(true);
    }
    if (this.watching) return this.stopWatching(); // v1.1 PAGE-WATCH: Leave on a spectator's screens
    const game = this.game || this.savedGame;
    if (game) this._sendLeave(game);
    this._exit();
    return Promise.resolve(true);
  }

  _sendLeave(game) {
    try {
      this.api.post('cmd', {
        code: game.code,
        player: { id: game.id, secret: game.secret },
        cmd: { type: 'leave' },
      }, { timeoutMs: 8000, keepalive: true }).catch(() => {});
    } catch { /* best effort */ }
  }

  _meFrom(opts = {}) {
    const saved = this.me || {};
    const name = cleanName(opts.name !== undefined ? opts.name : saved.name);
    const face = opts.face !== undefined ? cleanFace(opts.face) : cleanFace(saved.face);
    if (opts.name !== undefined || opts.face !== undefined) this.saveMe({ name, face });
    return { name, face };
  }

  _fail(err, opts = {}) {
    if (!opts.quiet) this.banner(err.offline ? (err.message || NOT_SENT) : err.message, 'warn', 5000);
    this.emit('error', err);
    return err;
  }

  _enter(g, view) {
    let saved = null;
    try { saved = this.identity.saveGame(g); } catch { saved = null; }
    if (!saved || !view || typeof view !== 'object') return false;
    this._clearSeen();
    this._resetGameState();
    this._dropWatch(); // v1.1 PAGE-WATCH: playing ends watching
    this.game = saved;
    this.savedGame = null;
    // What happened before you joined (who joined before you) isn't news: only what comes after is.
    this._lastEmitted = null;
    const mine = cleanFace(this.me?.face);
    if (mine) this.faces.set(saved.id, mine);
    this._take(view);
    this._schedule();
    return true;
  }

  _enterSaved(saved) {
    this._resetGameState();
    this.game = saved;
    this.savedGame = null;
    this._lastEmitted = this._readSeen(saved); // null: history isn't news
    this._showLoading();
    this.syncNow();
  }

  _resetGameState() {
    clearTimeout(this._timer);
    this._timer = null;
    clearTimeout(this._revealTimer);
    this.view = null;
    this.events = [];
    this._since = 0;
    this._lastEmitted = 0;
    this.faces.clear();
    this._faceVs.clear();
    this._facesRetryAt = 0;
    this._failures = 0;
    this._held = [];
    this._radioReset(); // v1.1 PAGE-RADIO: the walkie-talkie stops, its clips go
    this._camReset(); // v1.2 PAGE-CAM: filming stops (clips kept on the phone stay)
    this._photoReset(); // v1.3 PAGE-PLAY
    this._setConnection('ok');
    if (this._locOn && this.location) {
      this._locOn = false;
      try { this.location.stop(); } catch { /* ignore */ }
    }
  }

  _exit({ home = true } = {}) {
    try { if (this.media) this.media.want({ video: false, audio: false }); } catch (e) { console.error(e); } // v1.4 PAGE-DEVICES
    try { this.identity.clearGame(); } catch { /* ignore */ }
    this._clearSeen();
    this._resetGameState();
    this.game = null;
    this.savedGame = null;
    this._renderNet();
    this._guard(false);
    if (this.doc && this.doc.body) {
      this.doc.body.dataset.team = 'none';
      delete this.doc.body.dataset.phase;
    }
    try { this.alerts?.keepAwake?.(false, 'app'); } catch { /* ignore */ }
    if (home) this.go('home', {});
  }

  _lost(err) {
    this._exit();
    this.banner(lostWords(err), 'warn', 7000);
    this.emit('error', err);
  }

  // ---- talking to the server ----

  _post(action, extra, opts) {
    // v1.1 PAGE-WATCH: a spectator sends `watcher` instead of `player` (wsync, faces, clip)
    if (this.watching) {
      const w = this.watchGame;
      return this.api.post(action, { code: w.code, watcher: { id: w.id, secret: w.secret }, ...extra }, opts);
    }
    // v1.1 end PAGE-WATCH
    const g = this.game;
    // v1.4 PAGE-DEVICES: what this phone's location, camera, microphone and sound are like (the ready check, and
    // who has no location), in every sync / cmd / radio / cp-photo / tap-piece body
    if (HEALTH_ACTIONS.has(action) && extra && typeof extra === 'object' && !extra.health) {
      const health = this.health();
      if (health) extra = { ...extra, health };
    }
    // v1.4 end PAGE-DEVICES
    return this.api.post(action, { code: g.code, player: { id: g.id, secret: g.secret }, ...extra }, opts);
  }

  // v1.4 PAGE-DEVICES: what the shared stream holds open: a filmed player's camera while live, and while the camera
  // is still filming after the game (Highlights keeps going a little past the end)
  _wantMedia(view = this.view) {
    try {
      if (!this.media) return;
      const filmed = !!(this.cam && view && view.phase === 'live' && view.cam && view.cam.ok === true);
      const still = !!(this.cam && this.cam.filming && view && (view.phase === 'live' || view.phase === 'over'));
      this.media.want({ video: filmed || still, audio: false });
    } catch (e) { console.error(e); }
  }

  // v1.6.2 PERMS: permissions.js heard an answer (an Allow tap, or the gear check). A yes starts what was waiting
  // for it, with no reload: the location watch starts again (a live game), media.js asks again for a stream it
  // wants, a blocked walkie-talkie is ready, and a camera that was blocked starts filming.
  allowed(a) {
    if (!a || !a.part) return;
    const yes = a.result === 'granted';
    try {
      if (a.part === 'location') {
        const loc = this.location;
        if (yes && loc && typeof loc.running === 'function' && loc.running() && typeof loc.retry === 'function') loc.retry();
        return;
      }
      const word = yes ? 'ok' : a.result === 'unavailable' ? (a.why === 'none' ? 'none' : 'off') : 'denied';
      if (this.media && typeof this.media.allowed === 'function') this.media.allowed(a.part === 'camera' ? 'camera' : 'mic', word);
      if (!yes) return;
      if (a.part === 'mic' && this.radio && typeof this.radio.allowed === 'function') this.radio.allowed();
      if (a.part === 'camera' && this.cam && this.cam.state === 'denied' && typeof this.cam.start === 'function') {
        Promise.resolve(this.cam.start()).catch(() => {});
      }
    } catch (e) { console.error(e); }
  }

  // v1.4 PAGE-DEVICES: { loc, acc, cam, mic, snd, dev } (never a position: `loc` is only the watchdog's word)
  health() {
    try {
      const loc = this.location;
      const v = this.view;
      const st = this.media ? this.media.state : null;
      const hider = !!(v && v.me && v.me.team === 'hider');
      const hacker = !!(v && v.settings && v.settings.powers && v.settings.powers.hacker);
      let snd = 'na';
      if (hacker && hider) {
        const al = this.alarm;
        const ready = al && typeof al.ready === 'function' ? !!al.ready() : this.soundOk;
        snd = ready ? 'ok' : 'locked';
      }
      const camWanted = !!(v && v.cam && v.cam.ok === true);
      return {
        // in the lobby the watch isn't running: the ready check's word (permission state / its test)
        loc: loc && typeof loc.health === 'function'
          ? (typeof loc.running === 'function' && !loc.running() && this.lobbyLoc ? this.lobbyLoc : loc.health()) : 'none',
        acc: loc && typeof loc.accuracy === 'function' ? loc.accuracy() : null,
        cam: st && camWanted ? st.cam : 'na',
        mic: st ? st.mic : 'na',
        snd,
        dev: deviceKind(globalThis.navigator, this.win),
      };
    } catch (e) {
      console.error(e);
      return null;
    }
  }
  // v1.4 end PAGE-DEVICES

  // The position to send: the latest fix while live, but never an old one sent again and again (Location
  // switched off, or a GPS that stopped): the server then sees the phone go quiet, as it should. (The server
  // also ignores a fix it already has, for pages that are older than this one.)
  _posToSend() {
    if (!this.view || this.view.phase !== 'live' || !this.location) return null;
    try {
      const status = typeof this.location.status === 'function' ? this.location.status() : 'ok';
      if (status === 'denied' || status === 'unavailable') return null;
      const p = this.location.latest();
      if (!p || !Array.isArray(p.p)) return null;
      // (p.at is this phone's own clock, like Date.now(): location.js keeps it within a minute of it.)
      if (Number.isFinite(p.at) && Date.now() - p.at > TIMING.OFFLINE_MS) return null;
      return p;
    } catch {
      return null;
    }
  }

  syncNow() {
    if (this.watching) return this._watchSync(); // v1.1 PAGE-WATCH
    if (!this.game) return Promise.resolve(null);
    if (this._syncing) {
      this._again = true;
      return this._syncing;
    }
    clearTimeout(this._timer);
    this._timer = null;
    const game = this.game;
    const body = { since: this._since };
    body.radioSince = this._radioSince(); // v1.1 PAGE-RADIO
    body.camSince = this._camSince(); // v1.2 PAGE-CAM
    const pos = this._posToSend();
    if (pos) body.pos = pos;
    this._syncing = this._post('sync', body, { timeoutMs: 9000 })
      .then((res) => {
        if (game !== this.game) return null;
        this._ok();
        this._take(res && res.view);
        return this.view;
      })
      .catch((e) => {
        if (game !== this.game) return null;
        this._failed(toApiError(e), 'sync');
        return null;
      })
      .finally(() => {
        this._syncing = null;
        if (this._again && this.game && !this._stopped) {
          this._again = false;
          this.syncNow();
        } else {
          this._again = false;
          this._schedule();
        }
      });
    return this._syncing;
  }

  _schedule(delay) {
    clearTimeout(this._timer);
    this._timer = null;
    // v1.1 PAGE-WATCH: a spectator asks every watchMs
    if (this.watching) {
      if (this._hidden() || this._stopped || (this._syncing && delay === undefined)) return;
      const wait = delay !== undefined ? delay : (this._failures ? backoffDelay(this._failures) : this.watchMs);
      this._timer = setTimeout(() => {
        this._timer = null;
        this.syncNow();
      }, wait);
      return;
    }
    // v1.1 end PAGE-WATCH
    if (!this.game || this._hidden() || this._stopped) return;
    if (this._syncing && delay === undefined) return; // its own finish schedules the next one
    const ms = delay !== undefined ? delay : (this._failures ? backoffDelay(this._failures) : this.syncMs);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.syncNow();
    }, ms);
  }

  _ok() {
    this._failures = 0;
    this._setConnection('ok');
  }

  _failed(err, action) {
    if (isGone(err, action)) {
      this._lost(err);
      return;
    }
    this._failures += 1;
    if (err.offline || err.status >= 500 || err.code === 'busy') {
      this._setConnection(this._online() ? 'reconnecting' : 'offline');
    } else {
      this._setConnection('reconnecting');
    }
    if (this._failures === 1) this.emit('error', err);
  }

  _setConnection(state) {
    if (state === this.connection) return;
    this.connection = state;
    this._renderNet();
    this.emit('connection', state);
  }

  async cmd(cmd, { quiet = false } = {}) {
    if (!this.game) {
      const err = new ApiError({ code: 'not_in_game', message: "You're not in a game right now." });
      if (!quiet) this.banner(err.message, 'warn');
      return err;
    }
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      return new ApiError({ code: 'bad_cmd', message: "That didn't work. Try again." });
    }
    const game = this.game;
    const body = { cmd, since: this._since };
    body.radioSince = this._radioSince(); // v1.1 PAGE-RADIO
    body.camSince = this._camSince(); // v1.2 PAGE-CAM
    const pos = this._posToSend();
    if (pos) body.pos = pos;
    try {
      const res = await this._post('cmd', body, { timeoutMs: 10000 });
      if (game !== this.game) return (res && res.view) || null;
      this._ok();
      this._take(res && res.view);
      // A quick sync after the command (others may have moved on too). One already on its way read the game
      // before this command was saved, so another goes right after it (its finish would otherwise put the
      // next one a whole SYNC_MS away).
      if (this._syncing) this._again = true;
      else this._schedule(SOON_MS);
      return this.view;
    } catch (e) {
      const err = toApiError(e);
      if (game !== this.game) return err;
      if (isGone(err, 'cmd')) {
        // Make sure before dropping the game: a sync says for certain whether we're still in it.
        this.syncNow();
      }
      if (err.offline) {
        this._failures += 1;
        this._setConnection(this._online() ? 'reconnecting' : 'offline');
        this._schedule();
      }
      if (!quiet) this.banner(err.offline ? NOT_SENT : err.message, 'warn', 4500);
      this.emit('error', err);
      return err;
    }
  }

  async setFace(dataUrl) {
    const face = cleanFace(dataUrl);
    const me = this.me || {};
    this.saveMe({ name: me.name, face });
    if (!this.game || !face) return null;
    const game = this.game;
    this.faces.set(game.id, face);
    this._safeUpdate();
    try {
      const res = await this._post('face', { face }, { timeoutMs: 20000 });
      if (game !== this.game) return null;
      this._ok();
      this._take(res && res.view);
      return this.view;
    } catch (e) {
      const err = toApiError(e);
      if (game === this.game && isGone(err, 'face')) this.syncNow();
      return this._fail(err);
    }
  }

  positionNow() {
    try { return this.location && this.location.latest ? this.location.latest() : null; } catch { return null; }
  }

  // A player from the latest view, or null.
  player(id) {
    const list = this.view && Array.isArray(this.view.players) ? this.view.players : [];
    return list.find((p) => p && p.id === id) || null;
  }

  // The link that opens Join with this game's code filled in.
  inviteLink(code = this.game && this.game.code) {
    if (!code) return '';
    try {
      const here = new URL(globalThis.location.href);
      return `${here.origin}${here.pathname}?code=${encodeURIComponent(code)}`;
    } catch {
      return `?code=${encodeURIComponent(code)}`;
    }
  }

  // v1.1 PAGE-RADIO: the walkie-talkie --------------------------------------------------------------------

  _radioSince() {
    const n = this.radio ? Number(this.radio.last) : 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  _radioReset() {
    try { if (this.radio) this.radio.stop(); } catch (e) { console.error(e); }
    if (!this._clips) return;
    this._clips.clear();
    const U = (this.win && this.win.URL) || globalThis.URL;
    for (const url of this._clipUrls.splice(0)) {
      try { U.revokeObjectURL(url); } catch { /* ignore */ }
    }
  }

  // One clip's audio by its number (players and spectators; the server decides who may hear it), as a blob: URL
  // kept until the round changes. -> Promise<{ url, type, ms, from, clock } | null>
  clip(n) {
    if (!Number.isInteger(n) || n < 1 || (!this.game && !this.watching)) return Promise.resolve(null);
    if (this._clips.has(n)) return this._clips.get(n);
    const clips = this._clips;
    const p = this._post('clip', { n }, { timeoutMs: 20000 })
      .then((res) => {
        const c = res && res.clip;
        if (!c || typeof c.audio !== 'string' || !c.audio) return null;
        const B = (this.win && this.win.Blob) || globalThis.Blob;
        const U = (this.win && this.win.URL) || globalThis.URL;
        const url = U.createObjectURL(new B([fromBase64(c.audio)], { type: String(c.type || 'audio/mp4') }));
        if (clips === this._clips && this._clips.get(n) === p) this._clipUrls.push(url);
        else { try { U.revokeObjectURL(url); } catch { /* ignore */ } return null; }
        return { url, type: c.type, ms: c.ms, from: c.from, clock: c.clock, n };
      })
      .catch((e) => {
        const err = toApiError(e);
        // Not kept (404): asked once. Anything else (no signal): asked again next time.
        if (err.code !== 'no_clip' && this._clips.get(n) === p) this._clips.delete(n);
        return null;
      });
    this._clips.set(n, p);
    return p;
  }

  // Send a recorded clip ({ audio: base64, type, ms }). -> Promise<{ n, clock } | ApiError>
  async sendClip({ audio, type, ms, side } = {}) {
    if (!this.game) return new ApiError({ code: 'not_in_game', message: "You're not in a game right now." });
    const game = this.game;
    const body = { audio, type, ms, since: this._since, radioSince: this._radioSince() };
    if (side === 'hunters' || side === 'hiders' || side === 'call') body.side = side; // the channel it was recorded on (v1.7: 'call')
    body.camSince = this._camSince(); // v1.2 PAGE-CAM
    const pos = this._posToSend();
    if (pos) body.pos = pos;
    try {
      const res = await this._post('radio', body, { timeoutMs: 20000 });
      if (game !== this.game) return new ApiError({ code: 'not_in_game', message: "You're not in this game any more." });
      this._ok();
      this._take(res && res.view);
      return res && res.clip ? res.clip : {};
    } catch (e) {
      const err = toApiError(e);
      if (game === this.game && isGone(err, 'radio')) this.syncNow();
      this.emit('error', err);
      return err;
    }
  }
  // v1.1 end PAGE-RADIO ----------------------------------------------------------------------------------

  // v1.4.8: the driver's turn-by-turn. Asks the server for a route to `to` ({ kind: 'pickup'|'pin', id } or
  // { kind: 'hunters' }); the server asks the routing servers, never the page. opts: { start, heading }.
  // -> Promise<{ route, why, wait } | ApiError> (never rejects; the view that comes with it is taken as a sync's).
  async route(to, { start = false, heading = null } = {}) {
    if (!this.game || this.watching) return new ApiError({ code: 'not_in_game', message: "You're not in a game right now." });
    const game = this.game;
    const body = { to, since: this._since, radioSince: this._radioSince(), camSince: this._camSince() };
    if (start) body.start = true;
    if (typeof heading === 'number' && Number.isFinite(heading)) body.heading = Math.round(((heading % 360) + 360) % 360) % 360;
    const pos = this._posToSend();
    if (pos) body.pos = pos;
    try {
      const res = await this._post('route', body, { timeoutMs: 25000 });
      if (game !== this.game) return new ApiError({ code: 'not_in_game', message: "You're not in this game any more." });
      this._ok();
      this._take(res && res.view);
      return { route: (res && res.route) || null, why: (res && res.why) || null, wait: res && Number.isFinite(res.wait) ? res.wait : null };
    } catch (e) {
      const err = toApiError(e);
      if (game === this.game && isGone(err, 'route')) this.syncNow();
      return err;
    }
  }
  // v1.4.8 end

  // v1.2 PAGE-CAM: the highlight cam ---------------------------------------------------------------------

  _camSince() {
    const n = Number(this.camSince);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  _camReset() {
    this.camSince = 0;
    try { if (this.cam) this.cam.stop(); } catch (e) { console.error(e); }
  }

  // The game clock now (ms): the newest view's clock and how long ago it came, standing still while paused.
  // null without a live or over view.
  gameClock() {
    const v = this.view;
    if (!v || (v.phase !== 'live' && v.phase !== 'over') || !Number.isFinite(Number(v.clock))) return null;
    const now = globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now();
    const at = Number.isFinite(this.viewAt) && this.viewAt <= now ? this.viewAt : now;
    return v.paused ? Number(v.clock) : Number(v.clock) + (now - at);
  }

  // The microphone for the walkie-talkie: the camera's own audio while it films (never stop it: shared), else a
  // microphone of its own. -> Promise<{ stream, shared }>
  async mic(opts) {
    // v1.4 PAGE-DEVICES: through the one shared stream (media.js): its audio when it's held, else a walkie
    // microphone of its own that the caller stops after use
    if (this.media && this.media.can) return this.media.audio(opts);
    // v1.4 end PAGE-DEVICES
    try {
      const s = this.cam && typeof this.cam.stream === 'function' ? this.cam.stream() : null;
      const tracks = s && typeof s.getAudioTracks === 'function' ? s.getAudioTracks().filter((t) => t.readyState !== 'ended' && t.muted !== true) : [];
      if (tracks.length) {
        const M = (this.win && this.win.MediaStream) || globalThis.MediaStream;
        return { stream: M ? new M(tracks) : s, shared: true };
      }
    } catch (e) { console.error(e); }
    const media = globalThis.navigator && globalThis.navigator.mediaDevices;
    const stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    return { stream, shared: false };
  }

  // A cam-* action with this phone's player (or spectator) details. -> Promise<answer> (rejects with an ApiError)
  _pastVideo(action, body) {
    const cred = this._roundCred();
    if (!cred || !cred.player) return Promise.reject(new ApiError({ code: 'not_in_game', message: "You're not in a game right now." }));
    const base = { code: cred.code, round: cred.round, player: cred.player };
    let call;
    if (action === 'cam-upload') call = this.api.post('past-cam', { ...base, what: 'upload', clip: body.clip }, { timeoutMs: 20000 });
    else if (action === 'cam-done') call = this.api.post('past-cam', { ...base, what: 'done', id: body.id }, { timeoutMs: 20000 });
    else if (action === 'cam-list') call = this.api.post('past-media', { ...base, what: 'cam-list' }, { timeoutMs: 20000 });
    else if (action === 'cam-urls') call = this.api.post('past-media', { ...base, what: 'cam-urls', ids: body.ids }, { timeoutMs: 20000 });
    else return Promise.resolve({}); // (cam-have / cam-keep / cam-forget: the live game's, nothing to do here)
    return call.catch((e) => { throw toApiError(e); });
  }

  video(action, body = {}) {
    if (!/^cam-(upload|done|have|list|urls|keep|forget)$/.test(String(action))) {
      return Promise.reject(new ApiError({ code: 'bad_request', message: "That didn't work. Try again." }));
    }
    // v1.5.1: a round opened from Your games: its own videos go to it (past-cam / past-media), never the live game's
    if (this.pastGame && !this.watching) return this._pastVideo(action, body && typeof body === 'object' ? body : {});
    if (!this.game && !this.watching) {
      return Promise.reject(new ApiError({ code: 'not_in_game', message: "You're not in a game right now." }));
    }
    return this._post(action, body && typeof body === 'object' ? body : {}, { timeoutMs: 20000 }).catch((e) => {
      throw toApiError(e);
    });
  }
  // v1.2 end PAGE-CAM -------------------------------------------------------------------------------------

  // v1.3 PAGE-PLAY: checkpoint photos ---------------------------------------------------------------------

  _photoReset() {
    if (!this.photos) return;
    this.photos.clear();
    this._photoAsked.clear();
    this._photoWait.clear();
    if (this._photoQueue) this._photoQueue.clear();
    this._photoBatch = null;
  }

  // Photos by id (players and spectators: the server sends only what this phone may see). The ones kept here
  // first, then cp-photos for the rest in groups of 12. The ids asked for in one go of drawing (an end screen with
  // a thumb per photo, each asking for its own) are gathered into those groups and sent one group at a time, so a
  // big game's photos never flood the server (it limits each player's requests). An id that didn't come isn't
  // asked again for 10 s.
  // -> Promise<{ [id]: dataUrl }>; never rejects (a missing photo is simply not in the answer).
  async photo(ids) {
    const out = {};
    try {
      const want = [...new Set((Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)))];
      const ask = [];
      const waits = [];
      const now = Date.now();
      for (const id of want) {
        if (this.photos.has(id)) out[id] = this.photos.get(id);
        else if (this._photoWait.has(id)) waits.push(this._photoWait.get(id).then(() => { if (this.photos.has(id)) out[id] = this.photos.get(id); }));
        else if (!(now - (this._photoAsked.get(id) || 0) < PHOTO_ASK_AGAIN_MS)) ask.push(id);
      }
      if (ask.length && (this.game || this.watching)) {
        const p = this._askPhotos(ask);
        waits.push(p.then(() => { for (const id of ask) if (this.photos.has(id)) out[id] = this.photos.get(id); }));
      }
      await Promise.all(waits);
    } catch (e) {
      console.error(e);
    }
    return out;
  }

  // Queue ids for the next cp-photos round (sent after this go of drawing). -> Promise, resolved once they're in.
  _askPhotos(ids) {
    if (!this._photoQueue) this._photoQueue = new Set();
    for (const id of ids) this._photoQueue.add(id);
    if (!this._photoBatch) {
      const batch = new Promise((resolve) => setTimeout(resolve, 0))
        .then(() => this._sendQueuedPhotos(batch))
        .catch(() => {});
      this._photoBatch = batch;
    }
    const p = this._photoBatch;
    for (const id of ids) this._photoWait.set(id, p);
    return p;
  }

  async _sendQueuedPhotos(batch) {
    if (this._photoBatch === batch) this._photoBatch = null; // asks from now on go in the next round
    const ask = [...this._photoQueue].filter((id) => this._photoWait.get(id) === batch);
    for (const id of ask) this._photoQueue.delete(id);
    const LIMIT = Number(LIMITS.cpPhotoIds) || 12;
    const kept = this.photos;
    try {
      for (let i = 0; i < ask.length; i += LIMIT) {
        const group = ask.slice(i, i + LIMIT);
        if (!(this.game || this.watching) || kept !== this.photos) break;
        try {
          const res = await this._post('cp-photos', { ids: group }, { timeoutMs: 20000 });
          const got = res && res.photos && typeof res.photos === 'object' ? res.photos : {};
          for (const id of group) {
            const url = got[id];
            if (typeof url === 'string' && url.startsWith('data:image/jpeg;base64,') && kept === this.photos) {
              this.photos.set(id, url);
              this._photoAsked.delete(id);
            } else {
              this._photoAsked.set(id, Date.now());
            }
          }
        } catch {
          for (const id of group) this._photoAsked.set(id, Date.now());
        }
      }
    } finally {
      for (const id of ask) if (this._photoWait.get(id) === batch) this._photoWait.delete(id);
    }
  }

  // Send a checkpoint photo (a free hider inside the open checkpoint k). -> Promise<view>; rejects with an ApiError
  // whose message says why (outside, closed, done already...).
  // While the phone's own camera covers the page no location fixes come, so the last one is from before the camera
  // opened, and the server (which wants a fix under CP_FRESH_MS) would say "Get inside the checkpoint first". So it
  // first waits a moment for a fresh fix (opts.onCheck() is told when it has to wait), and when the server still says
  // outside, it waits for a newer fix than the one it sent and sends once more.
  async sendPhoto(k, dataUrl, opts = {}) {
    if (!this.game) throw new ApiError({ code: 'not_in_game', message: "You're not in this game right now." });
    const game = this.game;
    await this._photoFix(-Infinity, opts);
    if (game !== this.game) throw new ApiError({ code: 'not_in_game', message: "You're not in this game any more." });
    let res;
    try {
      res = await this._sendPhotoOnce(game, k, dataUrl);
    } catch (e) {
      const err = toApiError(e);
      if (err.code !== 'cp_outside') throw err;
      const got = game === this.game && await this._photoFix(Number.isFinite(e && e.sentAt) ? e.sentAt : -Infinity, opts);
      if (!got || game !== this.game) {
        this.emit('error', err);
        throw err;
      }
      try {
        res = await this._sendPhotoOnce(game, k, dataUrl);
      } catch (e2) {
        const err2 = toApiError(e2);
        if (err2.code === 'cp_outside') this.emit('error', err2);
        throw err2;
      }
    }
    return this._photoSent(game, res, dataUrl);
  }

  // Wait (PHOTO_FIX_WAIT_MS at most) for a fix newer than `newerThan` and under PHOTO_FIX_AGE_MS old. -> true when
  // one came (or the one there already was good), false otherwise. Never rejects.
  async _photoFix(from, opts = {}) {
    const loc = this.location;
    if (!loc || typeof loc.waitFix !== 'function') return false;
    try {
      const fresh = (p) => !!p && Number.isFinite(p.at) && p.at > from && Date.now() - p.at <= PHOTO_FIX_AGE_MS;
      if (fresh(loc.latest())) return true;
      if (typeof opts.onCheck === 'function') { try { opts.onCheck(); } catch (e) { console.error(e); } }
      const p = await loc.waitFix({ newerThan: from, maxAgeMs: PHOTO_FIX_AGE_MS, waitMs: PHOTO_FIX_WAIT_MS });
      return fresh(p);
    } catch {
      return false;
    }
  }

  async _sendPhotoOnce(game, k, dataUrl) {
    const body = { k, photo: dataUrl, since: this._since, radioSince: this._radioSince(), camSince: this._camSince() };
    const pos = this._posToSend();
    if (pos) body.pos = pos;
    try {
      return await this._post('cp-photo', body, { timeoutMs: 30000 });
    } catch (e) {
      const err = toApiError(e);
      if (game === this.game && isGone(err, 'cp-photo')) this.syncNow();
      if (game === this.game && err.offline) this._setConnection(this._online() ? 'reconnecting' : 'offline');
      if (err.code !== 'cp_outside') this.emit('error', err);
      // (cp_outside: sendPhoto waits for a fix newer than the one sent here, and may send once more.)
      err.sentAt = pos && Number.isFinite(pos.at) ? pos.at : -Infinity;
      throw err;
    }
  }

  _photoSent(game, res, dataUrl) {
    if (game !== this.game) throw new ApiError({ code: 'not_in_game', message: "You're not in this game any more." });
    this._ok();
    // Our own photo is kept here at once (its id comes in the view's list of checkpoints done).
    const n = res && res.done ? res.done.n : null;
    const done = res && res.view && res.view.cp && Array.isArray(res.view.cp.done) ? res.view.cp.done : [];
    const row = done.find((d) => d && d.n === n && typeof d.photo === 'string');
    if (row) this.photos.set(row.photo, dataUrl);
    this._take(res && res.view);
    return this.view;
  }
  // v1.3 end PAGE-PLAY -------------------------------------------------------------------------------------

  // v1.1 PAGE-WATCH: spectators -------------------------------------------------------------------------
  // A spectator has their own id and secret (identity's 'nightops-watch'), never plays and never sends a
  // position. Their loop posts wsync every watchMs; the views come 2 minutes behind (the server decides).

  // The link that opens "Watch game CODE" (one tap).
  watchLink(code = (this.game && this.game.code) || (this.watchGame && this.watchGame.code)) {
    if (!code) return '';
    try {
      const here = new URL(globalThis.location.href);
      return `${here.origin}${here.pathname}?watch=${encodeURIComponent(code)}`;
    } catch {
      return `?watch=${encodeURIComponent(code)}`;
    }
  }

  // Start watching a game with the saved name (opts.name to change it). -> Promise<view|ApiError>
  watch(code, opts = {}) {
    const c = normalizeCode(code);
    if (!c) {
      return Promise.resolve(this._fail(new ApiError({
        code: 'bad_code',
        message: 'Game codes have 6 letters and numbers, like WYKUSX.',
      }), opts));
    }
    if (this.watching && this.watchGame.code === c) return this.syncNow().then(() => this.view);
    if (this._busy) return this._busy;
    this._busy = this._watch(c, opts).finally(() => { this._busy = null; });
    return this._busy;
  }

  async _watch(c, opts) {
    const me = this._meFrom(opts);
    if (!me.name) return this._fail(new ApiError({ code: 'name', message: 'Type your name first.' }), opts);
    try {
      const res = await this.api.post('watch', { code: c, name: me.name, ...this._device() }, { timeoutMs: 20000 });
      const w = {
        code: String(res?.code || res?.view?.code || c).toUpperCase(),
        id: res?.watcher?.id,
        secret: res?.watcher?.secret,
      };
      if (!this._enterWatch(w, res && res.view)) throw new ApiError({ code: 'bad_answer', message: WORDS.bad_answer });
      return this.view;
    } catch (e) {
      return this._fail(toApiError(e), opts);
    }
  }

  // Stop watching (the server is told, best effort) and go home. -> Promise<true>
  stopWatching() {
    const w = this.watchGame;
    if (w) this._sendWleave(w);
    this._endWatch();
    this.go('home', {});
    return Promise.resolve(true);
  }

  _sendWleave(w) {
    try {
      this.api.post('wleave', { code: w.code, watcher: { id: w.id, secret: w.secret } },
        { timeoutMs: 8000, keepalive: true }).catch(() => {});
    } catch { /* best effort */ }
  }

  _loadWatch() {
    try { return this.identity && typeof this.identity.loadWatch === 'function' ? this.identity.loadWatch() : null; } catch { return null; }
  }

  // From start(): true when this phone goes on watching (or shows the link's "Watch game" screen).
  _startWatching(link) {
    const saved = this._loadWatch();
    if (!link && !saved) return false;
    let game = null;
    try { game = this.identity.loadGame(); } catch { game = null; }
    // A watch link to the game this phone plays in: just play.
    if (link && game && game.code === link) return false;
    if (saved && (!link || link === saved.code)) {
      this.savedGame = game || null;
      this._resetGameState();
      this.watchGame = saved;
      this._lastEmitted = null; // what's already there is history
      this._showLoading();
      this.syncNow();
      return true;
    }
    if (link) {
      this.savedGame = game || null;
      this.go('home', { watch: link });
      return true;
    }
    return false;
  }

  _enterWatch(w, view) {
    let saved = null;
    try { saved = this.identity.saveWatch(w); } catch { saved = null; }
    if (!saved || !view || typeof view !== 'object') return false;
    // A game this phone plays in stays saved (Home offers to go back to it), but isn't shown.
    if (this.game) {
      this.savedGame = this.game;
      this.game = null;
    }
    this._resetGameState();
    this.watchGame = saved;
    this._lastEmitted = null;
    this._takeWatch(view);
    this._schedule();
    return true;
  }

  _endWatch() {
    try { this.identity.clearWatch(); } catch { /* ignore */ }
    try { if (this.radio && typeof this.radio.stop === 'function') this.radio.stop(); } catch { /* ignore */ }
    this._resetGameState();
    this.watchGame = null;
    this._renderNet();
    if (this.doc && this.doc.body) {
      this.doc.body.dataset.team = 'none';
      delete this.doc.body.dataset.phase;
      delete this.doc.body.dataset.watching;
    }
  }

  // Joining or creating a game ends watching (from _enter).
  _dropWatch() {
    const w = this.watchGame || this._loadWatch();
    if (!w) return;
    this._sendWleave(w);
    try { this.identity.clearWatch(); } catch { /* ignore */ }
    this.watchGame = null;
    if (this.doc && this.doc.body) delete this.doc.body.dataset.watching;
  }

  _watchSync() {
    if (this._syncing) {
      this._again = true;
      return this._syncing;
    }
    clearTimeout(this._timer);
    this._timer = null;
    const w = this.watchGame;
    this._syncing = this._post('wsync', { since: this._since }, { timeoutMs: 9000 })
      .then((res) => {
        if (w !== this.watchGame) return null;
        this._ok();
        this._takeWatch(res && res.view);
        return this.view;
      })
      .catch((e) => {
        if (w !== this.watchGame) return null;
        const err = toApiError(e);
        if (isWatchGone(err)) {
          this._endWatch();
          this.go('home', {});
          this.banner(watchLostWords(err), 'warn', 7000);
          this.emit('error', err);
          return null;
        }
        this._failures += 1;
        this._setConnection(err.offline && !this._online() ? 'offline' : 'reconnecting');
        if (this._failures === 1) this.emit('error', err);
        return null;
      })
      .finally(() => {
        this._syncing = null;
        if (this._again && this.watching && !this._stopped) {
          this._again = false;
          this.syncNow();
        } else {
          this._again = false;
          this._schedule();
        }
      });
    return this._syncing;
  }

  // A spectator's view: like _take, without anything of a player's (no location, no reveal, no Back guard).
  // `since` follows view.lastEventId (the server goes through chats and one-player news without sending them).
  _takeWatch(view) {
    if (!view || typeof view !== 'object' || !this.watchGame || !view.watcher) return;
    if (view.code && String(view.code).toUpperCase() !== this.watchGame.code) return;
    const prev = this.view;
    const fresher = isFresher(view, prev);
    const incoming = Array.isArray(view.events) ? view.events.filter(isEvent) : [];
    let refetch = false;
    if (fresher && this._newRound(prev, view, incoming)) {
      const recounted = Number.isFinite(view.lastEventId) && view.lastEventId < this._since;
      if (recounted) this._lastEmitted = 0;
      this.events = [];
      this._since = 0;
      refetch = !incoming.some((e) => e.kind === 'again');
    }
    this.events = mergeEvents(this.events, incoming);
    if (!refetch) {
      this._since = Math.max(this._since, maxId(incoming), Number.isFinite(view.lastEventId) ? view.lastEventId : 0);
    }
    if (this._lastEmitted === null) this._lastEmitted = maxId(this.events);
    const fresh = eventsAfter(this.events, this._lastEmitted);
    if (fresh.length) this._lastEmitted = fresh[fresh.length - 1].id;

    if (fresher) {
      view.events = this.events;
      if (view.phase === 'over' && !view.summary && prev && prev.phase === 'over' && prev.summary
        && prev.overId === view.overId) view.summary = prev.summary;
      this.view = view;
      this._rememberPast(view, this.watchGame, 'watcher');
      this.viewAt = globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now();
      if (this.doc && this.doc.body) {
        this.doc.body.dataset.team = 'none';
        this.doc.body.dataset.phase = String(view.phase || '');
        this.doc.body.dataset.watching = '1';
      }
      this._watchFaces();
      if (this.autoScreen) {
        const want = chooseScreen({ view, current: this.screen });
        if (want && want !== this.screen) this.go(want);
        else this._safeUpdate();
      } else {
        this._safeUpdate();
      }
      this.emit('view', this.view);
    } else if (this.view) {
      this.view.events = this.events;
    }
    for (const e of fresh) this._deliver(e);
    if (refetch) {
      if (this._syncing) this._again = true;
      else this._schedule(0);
    }
  }

  // Faces for a spectator (the same answer a player gets).
  _watchFaces() {
    const v = this.view;
    const w = this.watchGame;
    if (!v || !w || !Array.isArray(v.players)) return;
    const want = [];
    const versions = new Map();
    for (const p of v.players) {
      if (!p || typeof p.id !== 'string') continue;
      const fv = Number(p.faceV) || 0;
      if (!fv || this._faceVs.get(p.id) === fv) continue;
      want.push(p.id);
      versions.set(p.id, fv);
    }
    if (!want.length || this._facesBusy || Date.now() < this._facesRetryAt) return;
    this._facesBusy = true;
    this._post('faces', { ids: want }, { timeoutMs: 15000 })
      .then((res) => {
        if (w !== this.watchGame) return;
        const got = (res && res.faces && typeof res.faces === 'object') ? res.faces : {};
        let any = false;
        for (const id of want) {
          if (isFaceUrl(got[id])) {
            this.faces.set(id, got[id]);
            any = true;
          }
          this._faceVs.set(id, versions.get(id));
        }
        if (any) {
          this._safeUpdate();
          this.emit('faces', this.faces);
        }
      })
      .catch(() => { if (w === this.watchGame) this._facesRetryAt = Date.now() + FACE_RETRY_MS; })
      .finally(() => { this._facesBusy = false; });
  }
  // v1.1 end PAGE-WATCH ---------------------------------------------------------------------------------

  // ---- views and events ----

  _take(view) {
    if (!view || typeof view !== 'object' || !this.game) return;
    if (view.code && String(view.code).toUpperCase() !== this.game.code) return;
    const prev = this.view;
    const fresher = isFresher(view, prev);
    const incoming = Array.isArray(view.events) ? view.events.filter(isEvent) : [];

    let refetch = false;
    if (fresher && this._newRound(prev, view, incoming)) {
      // Play again: the old round's events go (a phone asleep through the lobby, or the whole round, too).
      const recounted = Number.isFinite(view.lastEventId) && view.lastEventId < this._since;
      if (recounted) this._lastEmitted = 0; // the server counts from 1 again: the new round's events are news
      this.events = [];
      this._since = 0;
      // What came with this view is the whole round only when it starts at the Play again; else fetch it all.
      refetch = !incoming.some((e) => e.kind === 'again');
      try { this.store.remove(REVEALED_KEY); } catch { /* ignore */ }
      this._radioReset(); // v1.1 PAGE-RADIO: a new round's clips count from 1 again
      this._camReset(); // v1.2 PAGE-CAM: a new round's moments count from 1 again
      this._photoReset(); // v1.3 PAGE-PLAY: the last round's photos go
    }
    // The side you're no longer on (a hider who joined the hunters, or was caught and sits out): its news goes.
    const was = sideNow(prev);
    if (fresher && prev && was && was !== sideNow(view)) {
      this.events = dropSide(this.events, was);
    }
    this.events = mergeEvents(this.events, incoming);
    if (!refetch) this._since = Math.max(this._since, maxId(incoming));

    if (this._lastEmitted === null) {
      // Resumed, or just joined: what's already there is history, not news.
      this._lastEmitted = maxId(this.events);
      this._writeSeen();
    }
    const fresh = eventsAfter(this.events, this._lastEmitted);
    if (fresh.length) {
      this._lastEmitted = fresh[fresh.length - 1].id;
      this._writeSeen();
    }

    if (fresher) {
      view.events = this.events;
      // The server sends the end screen's summary once (it's big); later views of the same round keep it.
      if (view.phase === 'over' && !view.summary && prev && prev.phase === 'over' && prev.summary
        && prev.overId === view.overId) view.summary = prev.summary;
      this.view = view;
      this._rememberPast(view, this.game, 'player');
      // When it came (performance.now()): a screen shown later starts its clock from here, not from then.
      this.viewAt = globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now();
      // v1.1 PAGE-RADIO: new walkie-talkie clips (live hunters only; anyone else's radio stops)
      try { if (this.radio) this.radio.take(view); } catch (e) { console.error(e); }
      // v1.1 end PAGE-RADIO
      // v1.4 PAGE-DEVICES: what the shared stream should hold open (a filmed player's camera, live only)
      this._wantMedia(view);
      // v1.4 end PAGE-DEVICES
      // v1.2 PAGE-CAM: moments for the camera (a filmed player's phone only)
      try { if (this.cam) this.cam.take(view); } catch (e) { console.error(e); }
      // v1.2 end PAGE-CAM
    } else if (this.view) {
      this.view.events = this.events;
    }

    const status = this.view && this.view.me && this.view.me.status;
    if (status === 'kicked' || status === 'left') {
      if (status === 'kicked') this._lost(new ApiError({ code: 'kicked', message: 'The host removed you from the game.' }));
      else this._exit();
      return;
    }

    if (fresher) {
      this._applyBody();
      this._applyLocation();
      this._ensureFaces();
      this._applyScreen();
      this._guard(this.view.phase === 'live');
      this.emit('view', this.view);
    }
    for (const e of fresh) this._deliver(e);
    if (refetch) {
      if (this._syncing) this._again = true;
      else this._schedule(0);
    }
  }

  // A new round started since `prev` (the host pressed Play again). A game leaves 'over' only that way; a
  // different start time says so too (a phone asleep from round 1 into round 2), and so does a Play again event
  // this phone hasn't seen while it still holds others (they're from the round before it).
  _newRound(prev, view, incoming) {
    if (!prev) return false;
    if (prev.phase === 'over' && view.phase !== 'over') return true;
    const a = roundOf(prev);
    const b = roundOf(view);
    if (a !== null && b !== null && a !== b) return true;
    const again = incoming.filter((e) => e.kind === 'again').pop();
    return !!again && this.events.length > 0 && !this.events.some((e) => e.id === again.id && e.kind === 'again');
  }

  // Events go to the screen showing. A screen that is still loading gets them once it's there (they'd reach
  // nobody now); so does the game screen for what came during the reveal (its chat badge counts them).
  _holding() {
    if (!this.root || !this.screen) return false;
    return !this._mounted || this._mounted.name !== this.screen || this.screen === 'reveal';
  }

  _deliver(e) {
    if (!this._holding()) {
      this.emit('event', e);
      return;
    }
    this._held.push(e);
    if (this._held.length > HELD_CAP) this._held.splice(0, this._held.length - HELD_CAP);
  }

  _flush() {
    if (this._holding()) return;
    for (const e of this._held.splice(0)) this.emit('event', e);
  }

  // During a live game the phone's Back stays in the game (it would close Night Ops on Android).
  _guard(on) {
    this._guardLive = !!on;
    try {
      const hold = this._backHold;
      if (this.back && typeof this.back.guard === 'function') {
        this.back.guard(!!on || !!hold, () => (this._backHold ? this._backHold() : this._backPressed()));
      }
    } catch (e) {
      console.error(e);
    }
  }

  // v1.3: a screen with changes not yet saved (the checkpoint editor) keeps Back on the page too: Back then calls
  // fn (which asks "Leave without saving?"). holdBack(null) lets it go.
  holdBack(fn) {
    this._backHold = typeof fn === 'function' ? fn : null;
    this._guard(!!this._guardLive);
  }

  _backPressed() {
    const root = this.doc && this.doc.documentElement;
    if (root && root.classList && root.classList.contains('pocket-on')) return; // pocket mode stays asleep
    this.banner(BACK_WORDS, 'info', 4000);
  }

  _applyBody() {
    if (!this.doc || !this.doc.body) return;
    this.doc.body.dataset.team = teamOf(this.view);
    this.doc.body.dataset.phase = this.view ? String(this.view.phase || '') : '';
  }

  _applyLocation() {
    const v = this.view;
    // A screen may keep the screen awake during the game; never after it.
    const live = !!v && v.phase === 'live';
    if (this._wasLive && !live) {
      try { this.alerts?.keepAwake?.(false, 'app'); } catch { /* ignore */ }
    }
    this._wasLive = live;
    if (!this.location) return;
    const want = !!v && v.phase === 'live' && !!v.me && v.me.status === 'in';
    // v1.1 PAGE-DRIVER: the driver's phone keeps its fixes fresh (parked is decided on a fix under 20 s old).
    try {
      // v1.3 PAGE-PLAY: ...and so does a hider at or near the open checkpoint (inside is decided on a fix under 20 s old)
      if (typeof this.location.setFast === 'function') this.location.setFast(want && (!!v.me.driver || cpWantsFresh(v)));
    } catch (e) {
      console.error(e);
    }
    try {
      if (want && !this._locOn) {
        this._locOn = true;
        this.location.start();
      } else if (!want && this._locOn) {
        this._locOn = false;
        this.location.stop();
      }
    } catch (e) {
      console.error(e);
    }
  }

  _ensureFaces() {
    const v = this.view;
    const game = this.game;
    if (!v || !game || !Array.isArray(v.players)) return;
    const mine = cleanFace(this.me?.face);
    const want = [];
    const versions = new Map();
    let changed = false;
    for (const p of v.players) {
      if (!p || typeof p.id !== 'string') continue;
      const fv = Number(p.faceV) || 0;
      if (!fv) {
        if (this.faces.has(p.id) && p.id !== game.id) {
          this.faces.delete(p.id);
          this._faceVs.delete(p.id);
          changed = true;
        }
        continue;
      }
      if (this._faceVs.get(p.id) === fv) continue;
      if (p.id === game.id && mine) {
        this.faces.set(p.id, mine);
        this._faceVs.set(p.id, fv);
        continue;
      }
      want.push(p.id);
      versions.set(p.id, fv);
    }
    if (changed) this.emit('faces', this.faces);
    if (!want.length || this._facesBusy || Date.now() < this._facesRetryAt) return;
    this._facesBusy = true;
    this._post('faces', { ids: want }, { timeoutMs: 15000 })
      .then((res) => {
        if (game !== this.game) return;
        const got = (res && res.faces && typeof res.faces === 'object') ? res.faces : {};
        let any = false;
        for (const id of want) {
          if (isFaceUrl(got[id])) {
            this.faces.set(id, got[id]);
            any = true;
          }
          this._faceVs.set(id, versions.get(id));
        }
        if (any) {
          this._safeUpdate();
          this.emit('faces', this.faces);
        }
      })
      .catch((e) => {
        if (game !== this.game) return;
        const err = toApiError(e);
        this._facesRetryAt = Date.now() + FACE_RETRY_MS;
        if (isGone(err, 'faces')) this.syncNow();
      })
      .finally(() => { this._facesBusy = false; });
  }

  // ---- the reveal, once per game per phone ----

  _revealed() {
    try { return this.store.get(REVEALED_KEY); } catch { return null; }
  }

  _readSeen(game) {
    try {
      const v = JSON.parse(this.store.get(SEEN_KEY) || 'null');
      if (v && v.code === game.code && v.id === game.id && Number.isFinite(v.last)) return v.last;
    } catch { /* nothing kept */ }
    return null;
  }

  _writeSeen() {
    if (!this.game) return;
    try {
      this.store.set(SEEN_KEY, JSON.stringify({ code: this.game.code, id: this.game.id, last: this._lastEmitted || 0 }));
    } catch { /* ignore */ }
  }

  _clearSeen() {
    try { this.store.remove(SEEN_KEY); } catch { /* ignore */ }
  }

  _applyScreen() {
    const v = this.view;
    if (!v) return;
    // The reveal is shown once per round on this phone (the key names the round, so a phone that slept through
    // the lobby between rounds still sees which side it's on now).
    const key = revealKey(v, this.events, this.game.code);
    if (v.phase === 'lobby' && this._revealed() !== null) {
      try { this.store.remove(REVEALED_KEY); } catch { /* ignore */ }
    }
    if (!this.autoScreen) {
      this._safeUpdate();
      return;
    }
    const want = chooseScreen({ view: v, current: this.screen, revealed: this._revealed() === key });
    if (want === 'reveal' && this._revealed() !== key) {
      try { this.store.set(REVEALED_KEY, key); } catch { /* ignore */ }
    }
    if (want && want !== this.screen) this.go(want);
    else this._safeUpdate();
  }

  // ---- screens ----

  go(name, args = {}, { retry = false } = {}) {
    if (typeof name !== 'string' || !/^[a-z][a-z-]*$/.test(name)) {
      console.warn(`Night Ops: no screen called ${name}`);
      return;
    }
    const a = args && typeof args === 'object' ? args : {};
    if (!retry && this.screen === name && this._mounted && this._mounted.name === name && sameArgs(a, this.args)) {
      this._safeUpdate();
      return;
    }
    const changing = this.screen !== name;
    this.screen = name;
    this.args = a;
    if (changing) this._updateFails = 0;
    const token = ++this._token;
    this._unmount();
    if (changing) {
      try { closeSheets(); } catch { /* no sheets in Node */ }
    }
    clearTimeout(this._revealTimer);
    if (name === 'reveal') {
      this._revealTimer = setTimeout(() => {
        if (this.screen === 'reveal' && this.view && this.view.phase === 'live') this.go('game');
      }, REVEAL_MAX_MS);
    }
    if (this.doc && this.doc.body) this.doc.body.dataset.screen = name;
    if (changing) this.emit('screen', name);
    if (!this.root) return;

    setTimeout(() => {
      if (token === this._token && this._placed !== token && this.root && !this.root.querySelector('.app-error')) {
        fill(this.root, h('section.screen.screen-pending', h('div.app-card', { role: 'status' },
          h('div.app-spinner', { 'aria-hidden': 'true' }), h('p.app-line', 'Loading...'))));
      }
    }, 400);

    const attempt = retry ? ++this._tries : 0;
    Promise.resolve()
      .then(() => this.loadScreen(name, attempt))
      .then((mod) => {
        if (token === this._token) this._mount(name, mod, token);
      })
      .catch((err) => {
        if (token === this._token) this._showError(name, err, 'load');
      });
  }

  _mount(name, mod, token) {
    if (!mod || typeof mod.mount !== 'function') {
      this._showError(name, new Error(`screens/${name}.js has no mount()`), 'load');
      return;
    }
    const el = h(`section.screen.screen-${name}`, { tabindex: '-1', 'data-screen': name });
    fill(this.root, el);
    this._placed = token;
    let result;
    try {
      result = mod.mount(el, this, this.args);
    } catch (e) {
      this._showError(name, e, 'mount');
      return;
    }
    Promise.resolve(result).then((inst) => {
      if (token !== this._token) {
        try { inst && inst.destroy && inst.destroy(); } catch { /* ignore */ }
        return;
      }
      this._mounted = { name, el, inst: inst || {}, token };
      if (this.view) this._safeUpdate();
      // The events that came while it was loading (it listens from mount()).
      if (this._mounted && this._mounted.token === token) this._flush();
      if (this._mounted && this._mounted.el === el && el.isConnected && !el.contains(this.doc?.activeElement)) {
        try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    }, (e) => {
      if (token === this._token) this._showError(name, e, 'mount');
    });
  }

  _safeUpdate() {
    const m = this._mounted;
    if (!m || !this.view || !m.inst || typeof m.inst.update !== 'function') return;
    try {
      m.inst.update(this.view);
      this._updateFails = 0;
    } catch (e) {
      console.error(e);
      this._updateFails += 1;
      if (this._updateFails === 1) this.go(m.name, this.args, { retry: true });
      else this._showError(m.name, e, 'update');
    }
  }

  _unmount() {
    const m = this._mounted;
    this._mounted = null;
    if (!m) return;
    try {
      if (m.inst && typeof m.inst.destroy === 'function') m.inst.destroy();
    } catch (e) {
      console.error(e);
    }
    try { m.el.remove(); } catch { /* ignore */ }
  }

  _showError(name, err, phase) {
    console.error(err);
    this._unmount();
    this.emit('error', err);
    if (!this.root) return;
    const loading = phase === 'load';
    const card = h('div.app-card.app-error', { role: 'alert' },
      h('span.app-card-icon', icon('warn', 28)),
      h('h2', loading ? "This screen didn't load" : 'Something went wrong on this screen'),
      h('p.app-line', loading ? 'Check your signal, then try again.' : 'Try again. If it keeps happening, reload the page.'),
      err && err.message ? h('p.app-detail', shortText(err.message)) : null,
      h('div.app-card-actions',
        h('button.btn.primary.wide', { type: 'button', onclick: () => this.go(name, this.args, { retry: true }) }, 'Try again'),
        !this.game && name !== 'home'
          ? h('button.btn.ghost.wide', { type: 'button', onclick: () => this.go('home', {}) }, 'Back to the start')
          : null));
    fill(this.root, h(`section.screen.screen-error`, { 'data-failed': name }, card));
  }

  _showLoading() {
    this.screen = null;
    this._token += 1;
    this._unmount();
    if (this.doc && this.doc.body) this.doc.body.dataset.screen = 'loading';
    if (!this.root) return;
    const leaveBtn = h('button.btn.ghost.wide', { type: 'button', hidden: true, onclick: () => this.leave() }, 'Leave this game');
    fill(this.root, h('section.screen.screen-loading',
      h('div.app-card', { role: 'status' },
        h('div.app-spinner', { 'aria-hidden': 'true' }),
        h('h2', 'Getting back into your game'),
        this.game ? h('p.app-code', this.game.code) : null,
        h('p.app-line', 'One moment...'),
        h('div.app-card-actions', leaveBtn))));
    setTimeout(() => {
      if (leaveBtn.isConnected) leaveBtn.hidden = false;
    }, 8000);
  }

  _renderNet() {
    if (!this.doc || !this.doc.body) return;
    if (!this._net) {
      this._net = h('div.net-line', { role: 'status', 'aria-live': 'polite', hidden: true });
      this.doc.body.appendChild(this._net);
    }
    const show = (!!this.game || this.watching) && this.connection !== 'ok'; // v1.1 PAGE-WATCH: spectators too
    const words = this.connection === 'offline' ? "Offline. Reconnecting when you're back online." : 'Reconnecting...';
    if (show) {
      if (this._net.textContent !== words) this._net.textContent = words;
      this._net.dataset.state = this.connection;
      this._net.hidden = false;
    } else {
      this._net.hidden = true;
      this._net.textContent = '';
    }
  }
}
