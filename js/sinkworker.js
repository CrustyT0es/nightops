// Night Ops v1.4 (PAGE-RENDER): writes a movie file into the Origin Private File System with a sync access
// handle (Safari, where createWritable is missing). Messages: open {folder, name}, write {at, data}, close.
let handle = null;
self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.op === 'open') {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(m.folder, { create: true });
      const file = await dir.getFileHandle(m.name, { create: true });
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
    } else if (m.op === 'write') {
      handle.write(new Uint8Array(m.data), { at: m.at });
    } else if (m.op === 'close') {
      if (handle) { handle.flush(); handle.close(); handle = null; }
    }
    self.postMessage({ n: m.n });
  } catch (err) {
    self.postMessage({ n: m.n, error: String((err && err.message) || err) });
  }
};
