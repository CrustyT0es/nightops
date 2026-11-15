// Night Ops v1.4 (PAGE-RENDER): where a movie file is written while it's made.
//
//   openSink({ name, estBytes, type, storage, Worker, Blob, File }) -> sink
//   sink = { kind: 'opfs' | 'opfs-worker' | 'memory', write(bytes, at), patch(at, bytes), close() -> File|Blob,
//            abort(), bytes }
//
// The Origin Private File System first, so a big file never sits in memory: createWritable() on the main thread
// (Chrome, Android), else a Worker with createSyncAccessHandle (js/sinkworker.js, Safari). Memory only when neither
// is there, and only up to MEMORY_MOST. Old movie files in the 'movies' folder are deleted when a new one starts.

export const MEMORY_MOST = 400e6;
export const FOLDER = 'movies';
export const TOO_BIG = "This phone can't hold a file this big. Try Small.";

function tooBig() { return Object.assign(new Error(TOO_BIG), { name: 'TooBig' }); }

async function clearOld(dir, keep) {
  try {
    for await (const [n] of dir.entries()) { if (n !== keep) { try { await dir.removeEntry(n); } catch { /* in use */ } } }
  } catch { /* fine */ }
}

// Memory: pieces with their places, patches applied in place.
export function memorySink({ most = MEMORY_MOST, type = 'video/mp4', Blob: B = globalThis.Blob, name = 'movie' } = {}) {
  const parts = []; // { at, data }
  let end = 0;
  const sink = { kind: 'memory', get bytes() { return end; } };
  sink.write = (bytes, at = end) => {
    if (Math.max(end, at + bytes.length) > most) throw tooBig();
    parts.push({ at, data: bytes.slice() });
    end = Math.max(end, at + bytes.length);
  };
  sink.patch = (at, bytes) => {
    for (const p of parts) {
      const a = Math.max(at, p.at), b = Math.min(at + bytes.length, p.at + p.data.length);
      for (let i = a; i < b; i += 1) p.data[i - p.at] = bytes[i - at];
    }
  };
  sink.close = () => {
    parts.sort((x, y) => x.at - y.at);
    const out = []; let pos = 0;
    for (const p of parts) { if (p.at !== pos) throw new Error('A gap in the movie file.'); out.push(p.data); pos += p.data.length; }
    parts.length = 0;
    return new B(out, { type });
  };
  sink.abort = () => { parts.length = 0; end = 0; };
  sink.name = name;
  return sink;
}

export async function openSink({
  name = 'movie', estBytes = 0, type = 'video/mp4', storage = globalThis.navigator && globalThis.navigator.storage,
  Worker: W = globalThis.Worker, Blob: B = globalThis.Blob, most = MEMORY_MOST, workerUrl = null,
} = {}) {
  const fname = `nightops-${String(name).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'movie'}.part`;
  let dir = null;
  try { if (storage && typeof storage.getDirectory === 'function') dir = await (await storage.getDirectory()).getDirectoryHandle(FOLDER, { create: true }); } catch { dir = null; }
  if (dir) {
    await clearOld(dir, fname);
    try {
      const handle = await dir.getFileHandle(fname, { create: true });
      if (typeof handle.createWritable === 'function') {
        const out = await handle.createWritable({ keepExistingData: false });
        let end = 0, chain = Promise.resolve();
        const sink = { kind: 'opfs', get bytes() { return end; } };
        sink.write = (bytes, at = end) => { end = Math.max(end, at + bytes.length); chain = chain.then(() => out.write({ type: 'write', position: at, data: bytes })); return chain; };
        sink.patch = (at, bytes) => sink.write(bytes, at);
        sink.close = async () => { await chain; await out.close(); const f = await handle.getFile(); return f.type === type ? f : new B([f], { type }); };
        sink.abort = async () => { try { await chain; } catch { /* fine */ } try { await out.abort(); } catch { /* fine */ } try { await dir.removeEntry(fname); } catch { /* fine */ } };
        return sink;
      }
      if (W) {
        const w = new W(workerUrl || new URL('./sinkworker.js', import.meta.url), { type: 'module' });
        let n = 0; const waits = new Map();
        w.onmessage = (e) => { const p = waits.get(e.data && e.data.n); if (!p) return; waits.delete(e.data.n); if (e.data.error) p.no(new Error(e.data.error)); else p.ok(e.data); };
        const ask = (msg, transfer = []) => new Promise((ok, no) => { n += 1; waits.set(n, { ok, no }); w.postMessage({ ...msg, n }, transfer); });
        await ask({ op: 'open', folder: FOLDER, name: fname });
        let end = 0, chain = Promise.resolve();
        const sink = { kind: 'opfs-worker', get bytes() { return end; } };
        sink.write = (bytes, at = end) => {
          end = Math.max(end, at + bytes.length);
          const copy = bytes.slice();
          chain = chain.then(() => ask({ op: 'write', at, data: copy.buffer }, [copy.buffer]));
          return chain;
        };
        sink.patch = (at, bytes) => sink.write(bytes, at);
        sink.close = async () => { await chain; await ask({ op: 'close' }); w.terminate(); const f = await handle.getFile(); return new B([f], { type }); };
        sink.abort = async () => { try { await chain; } catch { /* fine */ } try { await ask({ op: 'close' }); } catch { /* fine */ } w.terminate(); try { await dir.removeEntry(fname); } catch { /* fine */ } };
        return sink;
      }
    } catch { /* memory then */ }
  }
  if (estBytes > most) throw tooBig();
  return memorySink({ most, type, Blob: B, name: fname });
}

// After the file was handed over: the old movie files go.
export async function clearMovies(storage = globalThis.navigator && globalThis.navigator.storage) {
  try { const dir = await (await storage.getDirectory()).getDirectoryHandle(FOLDER, { create: true }); await clearOld(dir, null); } catch { /* fine */ }
}
