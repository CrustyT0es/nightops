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
import { TIMING } from '../shared/rules.js';
import { h, fill } from './dom.js';
import { icon } from './ui/icons.js';
import { banner as defaultBanner } from './ui/banner.js';
import { closeSheets } from './ui/sheet.js';
import { backButton } from './ui/back.js';
import { ApiError, toApiError, WORDS } from './api.js';
import { cleanName, cleanFace } from './identity.js';

export const SCREENS = ['home', 'lobby', 'ring', 'reveal', 'game', 'over'];
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
  if (view.phase === 'lobby') return current === 'ring' && view.me && view.me.host ? 'ring' : 'lobby';
  if (view.phase === 'live') {
    if (current === 'reveal') return 'reveal';
    return revealed ? 'game' : 'reveal';
  }
  if (view.phase === 'over') return 'over';
  return null;
}

// The side whose news this phone gets: your team's, but only while you're still in (a hider who was caught and
// sits out gets neither side's news, like the server's canSee).
export function sideNow(view) {
  return view && view.me && view.me.status === 'in' ? sideOf(view.me.team) : null;
}

// Whether `view` is newer than `prev`. `rev` is the saved version of the game a view was made from: a view
// made from an older save is older, whatever its time says (a sync that read the game just before a command
// saved it, but answered after). Without `rev` (or with the same one), the later `now` wins.
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
  }

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
  start({ code = '' } = {}) {
    if (this._started) return;
    this._started = true;
    this._stopped = false;
    this._listen();
    const link = normalizeCode(code);
    this.linkCode = link;
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
      const res = await this.api.post('create', { name: me.name, ...(me.face ? { face: me.face } : {}) }, { timeoutMs: 20000 });
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
      const res = await this.api.post('join', { code: c, name: me.name, ...(me.face ? { face: me.face } : {}) }, { timeoutMs: 20000 });
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

  leave() {
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
    this._setConnection('ok');
    if (this._locOn && this.location) {
      this._locOn = false;
      try { this.location.stop(); } catch { /* ignore */ }
    }
  }

  _exit({ home = true } = {}) {
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
    const g = this.game;
    return this.api.post(action, { code: g.code, player: { id: g.id, secret: g.secret }, ...extra }, opts);
  }

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
    if (!this.game) return Promise.resolve(null);
    if (this._syncing) {
      this._again = true;
      return this._syncing;
    }
    clearTimeout(this._timer);
    this._timer = null;
    const game = this.game;
    const body = { since: this._since };
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
      // When it came (performance.now()): a screen shown later starts its clock from here, not from then.
      this.viewAt = globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now();
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
    try {
      if (this.back && typeof this.back.guard === 'function') this.back.guard(!!on, () => this._backPressed());
    } catch (e) {
      console.error(e);
    }
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
    const show = !!this.game && this.connection !== 'ok';
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
