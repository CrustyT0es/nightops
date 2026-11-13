// Night Ops v1.2 (PAGE-CAM): clips kept on the phone until they're uploaded (IndexedDB 'nightops-cam', one
// record per clip: the clip's details, its `blob`, `sent` and `savedAt`). Memory when IndexedDB can't open (a
// private window): the clips then last until the page closes, and at most MEMORY_MOST bytes are held (past
// that, put rejects as a full phone would: a tab holding a whole game in memory would be closed by iOS).
// An uploaded clip's blob is let go at once (its details stay, so the end screen still counts it).
//
//   const store = openCamStore({ indexedDB })
//   store.put(rec)                -> Promise   (a QuotaExceededError rejects as it is: the phone is full)
//   store.list(code, round)       -> Promise<[rec]>   oldest first (by start)
//   store.get(id)                 -> Promise<rec | null>
//   store.sent(id)                -> Promise   marks it uploaded and lets its blob go (it's in the game now)
//   store.freeSent()              -> Promise<number>   every uploaded clip's blob goes (any game): room for more
//   store.remove(id)              -> Promise
//   store.prune({ keep: [code, round], olderThan })  -> Promise<number>   other games' clips go: uploaded ones at
//                                   once, the rest once saved before olderThan
//   store.kind                    'idb' | 'memory'

export const DB_NAME = 'nightops-cam';
export const DB_STORE = 'clips';
export const PRUNE_MS = 2 * 24 * 3600 * 1000;
export const MEMORY_MOST = 100 * 1000 * 1000;

// The error put rejects with when there's no room (what IndexedDB says when the phone is full).
function fullError(message) {
  try { return new DOMException(message, 'QuotaExceededError'); } catch {
    const e = new Error(message);
    e.name = 'QuotaExceededError';
    return e;
  }
}

const blobBytes = (r) => (r && r.blob && Number.isFinite(r.blob.size) ? r.blob.size : 0);
const goesInPrune = (r, k, olderThan) => r.game !== k && (r.sent || Number(r.savedAt) < olderThan);

export const gameKey = (code, round) => `${String(code || '').toUpperCase()}:${Number(round) || 0}`;

function byStart(a, b) {
  return (Number(a.start) - Number(b.start)) || (Number(a.savedAt) - Number(b.savedAt)) || (a.id < b.id ? -1 : 1);
}

export function memoryCamStore({ most = MEMORY_MOST } = {}) {
  const m = new Map();
  const held = () => [...m.values()].reduce((n, r) => n + blobBytes(r), 0);
  return {
    kind: 'memory',
    async put(rec) {
      const before = blobBytes(m.get(rec.id));
      if (held() - before + blobBytes(rec) > most) throw fullError('Not enough memory to keep more clips.');
      m.set(rec.id, { ...rec, game: gameKey(rec.code, rec.round) });
    },
    async list(code, round) {
      const k = gameKey(code, round);
      return [...m.values()].filter((r) => r.game === k).sort(byStart);
    },
    async get(id) { return m.get(id) || null; },
    async sent(id) { const r = m.get(id); if (r) m.set(id, { ...r, sent: true, blob: null }); },
    async freeSent() {
      let n = 0;
      for (const r of [...m.values()]) if (r.sent && r.blob) { m.set(r.id, { ...r, blob: null }); n += 1; }
      return n;
    },
    async remove(id) { m.delete(id); },
    async prune({ keep = [], olderThan = 0 } = {}) {
      const k = gameKey(keep[0], keep[1]);
      let n = 0;
      for (const r of [...m.values()]) {
        if (goesInPrune(r, k, olderThan)) { m.delete(r.id); n += 1; }
      }
      return n;
    },
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export function openCamStore({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function') return memoryCamStore();
  const memory = memoryCamStore();
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve) => {
        let r;
        try { r = indexedDB.open(name, 1); } catch { resolve(null); return; }
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains(DB_STORE)) {
            const s = d.createObjectStore(DB_STORE, { keyPath: 'id' });
            s.createIndex('game', 'game');
          }
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
      });
    }
    return dbp;
  }
  async function run(mode, fn, fallback) {
    const d = await db();
    if (!d) return fallback();
    const tx = d.transaction(DB_STORE, mode);
    const out = await fn(tx.objectStore(DB_STORE));
    await done(tx);
    return out;
  }
  const store = {
    kind: 'idb',
    put(rec) {
      const row = { ...rec, game: gameKey(rec.code, rec.round) };
      return run('readwrite', (s) => req(s.put(row)), () => memory.put(rec));
    },
    async list(code, round) {
      const k = gameKey(code, round);
      const rows = await run('readonly', (s) => req(s.index('game').getAll(k)), () => memory.list(code, round));
      return (rows || []).slice().sort(byStart);
    },
    async get(id) {
      const r = await run('readonly', (s) => req(s.get(id)), () => memory.get(id));
      return r || null;
    },
    sent(id) {
      return run('readwrite', async (s) => {
        const r = await req(s.get(id));
        if (r) await req(s.put({ ...r, sent: true, blob: null }));
      }, () => memory.sent(id));
    },
    freeSent() {
      return run('readwrite', async (s) => {
        const all = await req(s.getAll());
        let n = 0;
        for (const r of all || []) {
          if (r.sent && r.blob) { await req(s.put({ ...r, blob: null })); n += 1; }
        }
        return n;
      }, () => memory.freeSent());
    },
    remove(id) {
      return run('readwrite', (s) => req(s.delete(id)), () => memory.remove(id));
    },
    prune({ keep = [], olderThan = 0 } = {}) {
      const k = gameKey(keep[0], keep[1]);
      return run('readwrite', async (s) => {
        const all = await req(s.getAll());
        let n = 0;
        for (const r of all || []) {
          if (goesInPrune(r, k, olderThan)) { await req(s.delete(r.id)); n += 1; }
        }
        return n;
      }, () => memory.prune({ keep, olderThan }));
    },
  };
  return store;
}

// What's held for one game: { count, bytes } (every clip, sent or not), and what's still to send.
export function heldOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const all = list.reduce((m, r) => ({ count: m.count + 1, bytes: m.bytes + (Number(r.bytes) || 0) }), { count: 0, bytes: 0 });
  const left = list.filter((r) => !r.sent);
  return { ...all, left: left.length, leftBytes: left.reduce((s, r) => s + (Number(r.bytes) || 0), 0) };
}
