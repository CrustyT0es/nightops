// Night Ops: who you are on this phone (name + selfie) and the game you're in ({code, id, secret}).
// Kept in localStorage under 'nightops-me' and 'nightops-game'. Every access is in try/catch: private
// browsing, a full or blocked storage never breaks the page (it falls back to memory for this visit).
import { LIMITS } from '../shared/rules.js';
import { cleanName as engineName } from '../shared/engine.js';

export const ME_KEY = 'nightops-me';
export const GAME_KEY = 'nightops-game';

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

  return { loadMe, saveMe, loadGame, saveGame, clearGame };
}

const shared = createIdentity();
export const loadMe = shared.loadMe;
export const saveMe = shared.saveMe;
export const loadGame = shared.loadGame;
export const saveGame = shared.saveGame;
export const clearGame = shared.clearGame;
