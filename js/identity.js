// Night Ops: who you are on this phone (name + selfie) and the game you're in ({code, id, secret}).
// Kept in localStorage under 'nightops-me' and 'nightops-game'. Every access is in try/catch: private
// browsing, a full or blocked storage never breaks the page (it falls back to memory for this visit).
import { LIMITS } from '../shared/rules.js?v=172';
import { cleanName as engineName } from '../shared/engine.js?v=172';

export const ME_KEY = 'nightops-me';
export const GAME_KEY = 'nightops-game';
// v1.1 PAGE-WATCH: the game this phone watches ({code, id, secret} of a spectator)
export const WATCH_KEY = 'nightops-watch';
// v1.1 end PAGE-WATCH
// v1.4 Your games: the games this phone was in or watched, newest first
export const PAST_KEY = 'nightops-past';
export const PAST_MOST = 10;
const MODES = new Set(['classic', 'infection', 'checkpoints']);

const ID = /^[0-9a-f]{12}$/i;
const SECRET = /^[0-9a-f]{32}$/i;
const CODE = /^[A-Z0-9]{6}$/;
const FACE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

// A name as the game shows it: the engine's own rule (the server uses it too), so a name the page
// accepts is never one the server turns down or changes.
export function cleanName(name) {
  return engineName(typeof name === 'number' ? String(name) : name);
}

// A selfie data: URL, or null when it isn't one we can use (the server refuses one over LIMITS.faceBytes,
// so a bigger saved one is dropped here rather than making create or join fail).
export function cleanFace(face) {
  if (typeof face !== 'string' || face.length > LIMITS.faceBytes) return null;
  return FACE.test(face) ? face : null;
}

// One remembered game, or null: { code, id, secret, as: 'player'|'watcher', round, mode, when, role, result }.
export function cleanPast(g) {
  const base = cleanGame(g);
  if (!base || !Number.isSafeInteger(g.round) || g.round < 0) return null;
  const text = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, n) : '');
  return {
    ...base,
    as: g.as === 'watcher' ? 'watcher' : 'player',
    round: g.round,
    mode: MODES.has(g.mode) ? g.mode : 'classic',
    when: Number.isFinite(g.when) && g.when > 0 ? g.when : g.round,
    role: text(g.role, 20),
    result: text(g.result, 60),
    ...(g.pro === 'ready' ? { pro: 'ready' } : {}), // v1.5: the PC's edit of this round is ready
  };
}

function cleanGame(g) {
  if (!g || typeof g !== 'object') return null;
  const code = String(g.code ?? '').toUpperCase();
  const id = String(g.id ?? '');
  const secret = String(g.secret ?? '');
  if (!CODE.test(code) || !ID.test(id) || !SECRET.test(secret)) return null;
  return { code, id, secret };
}

// getStorage() returns a Storage-like object ({getItem, setItem, removeItem}); it may throw or return null.
export function createIdentity(getStorage = () => globalThis.localStorage) {
  const memory = new Map();

  function storage() {
    try { return getStorage() || null; } catch { return null; }
  }
  function read(key) {
    const s = storage();
    if (s) {
      try {
        const v = s.getItem(key);
        if (v !== null && v !== undefined) return String(v);
      } catch { /* fall back to memory */ }
    }
    return memory.has(key) ? memory.get(key) : null;
  }
  function write(key, value) {
    memory.set(key, value);
    const s = storage();
    if (!s) return false;
    try {
      s.setItem(key, value);
      memory.delete(key);
      return true;
    } catch {
      return false; // full or blocked: kept in memory for this visit
    }
  }
  function remove(key) {
    memory.delete(key);
    const s = storage();
    if (!s) return;
    try { s.removeItem(key); } catch { /* nothing to do */ }
  }
  function readJson(key) {
    const raw = read(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function loadMe() {
    const v = readJson(ME_KEY);
    if (!v || typeof v !== 'object') return null;
    const name = cleanName(v.name);
    const face = cleanFace(v.face);
    if (!name && !face) return null;
    return { name, face };
  }

  // Returns what was saved ({name, face}) or null when there's nothing to keep.
  function saveMe(me) {
    const name = cleanName(me?.name);
    const face = cleanFace(me?.face);
    if (!name && !face) {
      remove(ME_KEY);
      return null;
    }
    const value = { name, face };
    write(ME_KEY, JSON.stringify(value));
    return value;
  }

  function loadGame() {
    return cleanGame(readJson(GAME_KEY));
  }

  function saveGame(g) {
    const value = cleanGame(g);
    if (!value) return null;
    write(GAME_KEY, JSON.stringify(value));
    return value;
  }

  function clearGame() {
    remove(GAME_KEY);
  }

  // v1.1 PAGE-WATCH: a spectator's id and secret, kept like a player's
  function loadWatch() {
    return cleanGame(readJson(WATCH_KEY));
  }

  function saveWatch(w) {
    const value = cleanGame(w);
    if (!value) return null;
    write(WATCH_KEY, JSON.stringify(value));
    return value;
  }

  function clearWatch() {
    remove(WATCH_KEY);
  }
  // v1.1 end PAGE-WATCH

  // v1.4 Your games: cleaned on every read, newest first, PAST_MOST at most, one per game round.
  function loadPast() {
    const raw = readJson(PAST_KEY);
    const out = [];
    for (const g of Array.isArray(raw) ? raw : []) {
      const c = cleanPast(g);
      if (c && !out.some((x) => x.code === c.code && x.round === c.round)) out.push(c);
    }
    return out.sort((a, b) => b.when - a.when).slice(0, PAST_MOST);
  }
  function rememberPast(g) {
    const c = cleanPast(g);
    if (!c) return null;
    const was = loadPast().find((x) => x.code === c.code && x.round === c.round);
    if (was && was.pro && !c.pro) c.pro = was.pro; // v1.5 (an over view arriving again never forgets it)
    const list = [c, ...loadPast().filter((x) => !(x.code === c.code && x.round === c.round))].slice(0, PAST_MOST);
    write(PAST_KEY, JSON.stringify(list));
    return c;
  }
  function forgetPast(code, round) {
    write(PAST_KEY, JSON.stringify(loadPast().filter((x) => !(x.code === code && x.round === round))));
  }

  return { loadMe, saveMe, loadGame, saveGame, clearGame, loadWatch, saveWatch, clearWatch, loadPast, rememberPast, forgetPast };
}

const shared = createIdentity();
export const loadMe = shared.loadMe;
export const saveMe = shared.saveMe;
export const loadGame = shared.loadGame;
export const saveGame = shared.saveGame;
export const clearGame = shared.clearGame;
// v1.1 PAGE-WATCH
export const loadWatch = shared.loadWatch;
export const saveWatch = shared.saveWatch;
export const clearWatch = shared.clearWatch;
// v1.1 end PAGE-WATCH
// v1.4 Your games
export const loadPast = shared.loadPast;
export const rememberPast = shared.rememberPast;
export const forgetPast = shared.forgetPast;
