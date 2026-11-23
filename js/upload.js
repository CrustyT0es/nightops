// Night Ops v1.2 (PAGE-CAM): "Upload my clips". One clip at a time, oldest first: cam-upload (the server checks it
// and hands out a short-lived upload address) -> PUT the file there -> cam-done -> marked sent on the phone.
//
//   const up = createUploader({ app, store, code, round })
//   up.run()       start (or carry on); up.stop()
//   up.state       'idle' | 'sending' | 'done' | 'stopped' | 'refused'
//   up.progress    { done, total, bytes, totalBytes, sentNow }  (sentNow: bytes of the clip going up now)
//   up.message     the last refusal or problem in words ('' when none)
//   up.on('progress' | 'done' | 'error' | 'state', fn) -> off()
//   up.tellHave()  cam-have with what this phone holds (the end screen calls it once when it opens)
//
// A dropped connection or a failed PUT tries that clip again after 2, 5, 10 and 30 s (5 tries in all), then goes
// on with the next and comes back to it at the end. A refusal says its sentence and stops (a "bad clip" only skips
// that one). The screen is kept on while sending.
import { uploadMeta, clipShape } from './camera.js?v=173';
import { heldOf } from './camstore.js?v=173';

export const RETRY_MS = [2000, 5000, 10000, 30000];
export const PUT_TIMEOUT_MS = 10 * 60 * 1000;
export const STOPS = new Set(['cam_mine_full', 'cam_game_full', 'cam_space', 'old_round', 'not_recorded', 'no_cam', 'not_over']);
export const SKIPS = new Set(['bad_video', 'too_big']);

export const WORDS = {
  tooBigForCloud: "One clip was too big to send (over 50 MB), so it stays on your phone.",
  notArrived: "That clip didn't arrive. Night Ops will try it again.",
  failed: "Some clips didn't send. Tap Upload my clips to try again.",
  allUp: 'All your clips are up.',
};

const isOffline = (e) => !!(e && (e.offline || e.code === 'offline' || e.code === 'timeout' || e.code === 'busy' || e.code === 'server' || e.status >= 500));

function defaultWait(ms, signal) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

// PUT a blob with XHR (for its upload progress). -> Promise<{ status }>; rejects { offline: true } when the
// connection drops.
export function putFile({ makeXhr, url, headers, blob, onProgress, signal, timeoutMs = PUT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let xhr;
    try { xhr = makeXhr(); } catch (e) { reject(e); return; }
    let settled = false;
    const fin = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    try {
      xhr.open('PUT', url, true);
      for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, String(v));
      xhr.timeout = timeoutMs;
      if (xhr.upload) xhr.upload.onprogress = (e) => { if (e && e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
      xhr.onload = () => fin(resolve, { status: xhr.status });
      xhr.onerror = () => fin(reject, { offline: true, code: 'offline' });
      xhr.ontimeout = () => fin(reject, { offline: true, code: 'timeout' });
      xhr.onabort = () => fin(reject, { code: 'aborted' });
      if (signal) signal.addEventListener('abort', () => { try { xhr.abort(); } catch { /* ignore */ } }, { once: true });
      xhr.send(blob);
    } catch (e) {
      fin(reject, { offline: true, code: 'offline', error: e });
    }
  });
}

export function createUploader({
  app,
  store,
  code,
  round,
  mode = 'highlights',
  makeXhr = () => new XMLHttpRequest(),
  wait = defaultWait,
  alerts = app ? app.alerts : null,
} = {}) {
  const fns = new Map();
  const emit = (name, ...a) => {
    for (const fn of [...(fns.get(name) || [])]) {
      try { fn(...a); } catch (e) { console.error(e); }
    }
  };
  const S = {
    state: 'idle',
    progress: { done: 0, total: 0, bytes: 0, totalBytes: 0, sentNow: 0 },
    message: '',
    ctrl: null,
    running: null,
  };

  function setState(s) {
    if (S.state === s) return;
    S.state = s;
    emit('state', s);
  }

  async function rows() {
    return (await store.list(code, round)) || [];
  }

  async function count() {
    const list = await rows();
    const sent = list.filter((r) => r.sent);
    S.progress = {
      ...S.progress,
      done: sent.length,
      total: list.length,
      bytes: sent.reduce((s, r) => s + (Number(r.bytes) || 0), 0),
      totalBytes: list.reduce((s, r) => s + (Number(r.bytes) || 0), 0),
    };
    emit('progress', S.progress);
    return list;
  }

  async function tellHave() {
    try {
      const h = heldOf(await rows());
      await app.video('cam-have', { have: { count: h.count, bytes: h.bytes } });
    } catch { /* best effort */ }
  }

  // One clip. -> 'sent' | 'retry' | 'skip' | 'stop'
  async function one(rec, signal) {
    let res;
    try {
      res = await app.video('cam-upload', { clip: uploadMeta(rec) });
    } catch (e) {
      if (signal.aborted) return 'stop';
      if (STOPS.has(e.code)) { S.message = e.message; return 'stop'; }
      if (SKIPS.has(e.code)) { S.message = e.message; return 'skip'; }
      if (isOffline(e)) return 'retry';
      S.message = e.message || '';
      return 'retry';
    }
    if (res && res.skip) {
      await store.sent(rec.id);
      return 'sent';
    }
    const up = res && res.upload;
    if (!up || typeof up.url !== 'string') return 'retry';
    let put;
    try {
      put = await putFile({
        makeXhr, url: up.url, headers: up.headers, blob: rec.blob, signal,
        onProgress: (loaded) => {
          S.progress = { ...S.progress, sentNow: loaded };
          emit('progress', S.progress);
        },
      });
    } catch (e) {
      if (signal.aborted) return 'stop';
      return 'retry';
    }
    S.progress = { ...S.progress, sentNow: 0 };
    if (put.status === 413) { S.message = WORDS.tooBigForCloud; return 'skip'; }
    // 409: the file is already there (an earlier try got through): cam-done measures it.
    if (!(put.status >= 200 && put.status < 300) && put.status !== 409) return 'retry';
    try {
      await app.video('cam-done', { id: rec.id });
    } catch (e) {
      if (signal.aborted) return 'stop';
      if (e.code === 'too_big') { S.message = e.message; return 'skip'; }
      if (STOPS.has(e.code)) { S.message = e.message; return 'stop'; }
      return 'retry';
    }
    await store.sent(rec.id);
    return 'sent';
  }

  async function loop() {
    const ctrl = new AbortController();
    S.ctrl = ctrl;
    S.message = '';
    setState('sending');
    try { alerts && alerts.keepAwake && alerts.keepAwake(true, 'upload'); } catch { /* ignore */ }
    let stopped = false;
    let failedAny = false;
    try {
      let list = await count();
      const later = [];
      const todo = list.filter((r) => !r.sent && clipShape(r, { mode }));
      for (const pass of [todo, later]) {
        for (const rec of pass) {
          if (ctrl.signal.aborted) { stopped = true; break; }
          let outcome = 'retry';
          for (let tryNo = 0; tryNo < RETRY_MS.length + 1; tryNo += 1) {
            outcome = await one(rec, ctrl.signal);
            if (outcome !== 'retry' || ctrl.signal.aborted) break;
            if (tryNo < RETRY_MS.length) await wait(RETRY_MS[tryNo], ctrl.signal);
          }
          if (outcome === 'stop') { stopped = true; break; }
          if (outcome === 'retry') {
            if (pass === todo) later.push(rec);
            else failedAny = true;
          }
          list = await count();
          await tellHave();
        }
        if (stopped) break;
      }
    } catch (e) {
      emit('error', e);
      failedAny = true;
    } finally {
      try { alerts && alerts.keepAwake && alerts.keepAwake(false, 'upload'); } catch { /* ignore */ }
      S.ctrl = null;
    }
    await count().catch(() => {});
    if (ctrl.signal.aborted) setState('stopped');
    else if (stopped) { setState('refused'); emit('error', { message: S.message }); }
    else if (failedAny || S.progress.done < S.progress.total) {
      if (!S.message) S.message = WORDS.failed;
      setState('stopped');
      emit('error', { message: S.message });
    } else {
      setState('done');
      emit('done', S.progress);
    }
  }

  return {
    get state() { return S.state; },
    get progress() { return S.progress; },
    get message() { return S.message; },
    run() {
      if (S.running) return S.running;
      S.running = loop().finally(() => { S.running = null; });
      return S.running;
    },
    stop() {
      if (S.ctrl) S.ctrl.abort();
    },
    count,
    tellHave,
    on(name, fn) {
      if (!fns.has(name)) fns.set(name, new Set());
      fns.get(name).add(fn);
      return () => fns.get(name) && fns.get(name).delete(fn);
    },
  };
}
