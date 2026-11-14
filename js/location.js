// Night Ops: where this phone is. A watchPosition wrapper that keeps the last fix and never throws.
// createLocation() -> { start(), stop(), latest() -> {p, acc, speed, at}|null,
//                       status() -> 'off'|'asking'|'ok'|'denied'|'unavailable', on(fn) -> off() }
// setFast(on): while this phone is the driver it asks for a fresh fix much more often (the server only calls the
// car parked on a fix under PARK_FRESH_MS old, and a phone standing still often stops sending them).
// fn(status, latest) runs on every change. A phone standing still may stop sending fixes, so while started
// it asks for a fresh one now and then; and it restarts the watch when the page comes back to the front
// (iPhones can stop a watch in the background).
import { isPoint } from '../shared/geo.js';

const WATCH = { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 };
const FRESHEN = { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 };
const FRESHEN_EVERY_MS = 15000;
const STALE_MS = 20000;
// The driver's phone: a fix never older than about 8 s (well under the server's 20 s PARK_FRESH_MS), asked for
// fresh (maximumAge 0: a cached one would come back with the same time and be dropped).
export const FAST_FRESHEN_EVERY_MS = 4000;
export const FAST_STALE_MS = 6000;
const FAST_FRESHEN = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

export function createLocation({
  geo = globalThis.navigator?.geolocation,
  now = () => Date.now(),
  doc = globalThis.document,
  perms = globalThis.navigator?.permissions,
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = (t) => clearInterval(t),
  after = (fn, ms) => setTimeout(fn, ms),
  cancelAfter = (t) => clearTimeout(t),
} = {}) {
  let state = geo ? 'off' : 'unavailable';
  let last = null;
  let watchId = null;
  let running = false;
  let freshen = null;
  let fast = false;
  const fns = new Set();

  function emit() {
    for (const fn of [...fns]) {
      try { fn(state, last); } catch (e) { console.error(e); }
    }
  }
  function setState(s) {
    if (s !== state) {
      state = s;
      emit();
    }
  }

  function onFix(pos) {
    if (!running) return;
    const c = pos && pos.coords;
    if (!c) return;
    const p = [round(Number(c.longitude), 6), round(Number(c.latitude), 6)];
    if (!isPoint(p)) return;
    const acc = Number.isFinite(c.accuracy) ? Math.max(0, Math.round(c.accuracy)) : 9999;
    const t = now();
    // Some phones report odd timestamps; trust it only when it's close to our clock.
    const ts = Number(pos.timestamp);
    const at = Number.isFinite(ts) && Math.abs(t - ts) < 60000 ? Math.min(ts, t) : t;
    // A wild fix right after a good one (a phone jumping to a cell tower) is skipped.
    if (last && acc > 500 && last.acc < 100 && at - last.at < 15000) return;
    const speed = Number.isFinite(c.speed) && c.speed >= 0 ? round(c.speed, 1) : null;
    last = { p, acc, speed, at };
    state = 'ok';
    emit();
  }

  function onError(err) {
    if (!running) return;
    const code = err && err.code;
    if (code === 1) {
      // Permission denied: no point watching. start() tries again (after the player changes settings).
      clearWatch();
      setState('denied');
    } else if (code === 2) {
      if (!last) setState('unavailable');
    }
    // code 3 (timeout): keep watching, keep the state.
  }

  function clearWatch() {
    if (watchId !== null && geo) {
      try { geo.clearWatch(watchId); } catch { /* ignore */ }
    }
    watchId = null;
  }

  function watch() {
    clearWatch();
    try {
      watchId = geo.watchPosition(onFix, onError, WATCH);
    } catch {
      watchId = null;
      setState('unavailable');
    }
  }

  function poke() {
    if (!running || !geo || state === 'denied') return;
    if (last && now() - last.at < (fast ? FAST_STALE_MS : STALE_MS)) return;
    try { geo.getCurrentPosition(onFix, () => {}, fast ? FAST_FRESHEN : FRESHEN); } catch { /* ignore */ }
  }

  function startFreshen() {
    if (freshen) stopEvery(freshen);
    freshen = every(poke, fast ? FAST_FRESHEN_EVERY_MS : FRESHEN_EVERY_MS);
  }

  function setFast(on) {
    const want = !!on;
    if (want === fast) return;
    fast = want;
    if (running) {
      startFreshen();
      if (fast) poke();
    }
  }

  // Back to the front: the watch starts again. While blocked it asks once more too (the player may have just
  // allowed it in Settings; a phone that still blocks it answers "no" at once, without asking them again).
  // The 15 s freshen never asks while blocked: a timer must not bring a prompt back again and again.
  function onVisible() {
    if (!running || !doc || doc.visibilityState !== 'visible') return;
    watch();
    if (state !== 'denied') poke();
  }

  // Where the browser can say so, asking again as soon as location is allowed for this site.
  let permission = null;
  function onPermission() {
    if (running && state === 'denied' && permission && permission.state === 'granted') watch();
  }
  function watchPermission() {
    if (permission !== null) return;
    permission = false;
    try {
      const p = perms && perms.query ? perms.query({ name: 'geolocation' }) : null;
      if (!p || typeof p.then !== 'function') return;
      p.then((status) => {
        if (!status || typeof status.addEventListener !== 'function') return;
        permission = status;
        status.addEventListener('change', onPermission);
      }, () => {});
    } catch { /* not supported here */ }
  }

  // Also how to try again after "Don't Allow" (call it from a tap: some browsers only ask again then).
  function start() {
    if (!geo) {
      setState('unavailable');
      return;
    }
    if (running && state !== 'denied') return;
    running = true;
    if (!last) setState('asking');
    watch();
    watchPermission();
    if (!freshen) startFreshen();
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisible);
  }

  function stop() {
    running = false;
    clearWatch();
    if (freshen) stopEvery(freshen);
    freshen = null;
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisible);
    setState(geo ? 'off' : 'unavailable');
  }

  // v1.3: wait (at most waitMs) for a fix taken after `newerThan` and no older than maxAgeMs, asking for one now.
  // The checkpoint photo uses it: while the phone's own camera covers the page, no fixes come, so the last one is
  // from before the camera opened. -> Promise<latest() | null>: what it has at the end (maybe still old). Never
  // rejects.
  function waitFix({ newerThan = -Infinity, maxAgeMs = Infinity, waitMs = 8000 } = {}) {
    const good = () => !!last && last.at > newerThan && now() - last.at <= maxAgeMs;
    const copy = () => (last ? { p: last.p.slice(), acc: last.acc, speed: last.speed, at: last.at } : null);
    if (good() || !running || !geo || state === 'denied') return Promise.resolve(copy());
    return new Promise((resolve) => {
      let timer = null;
      const off = () => { fns.delete(onChange); if (timer !== null) cancelAfter(timer); };
      const onChange = () => { if (good()) { off(); resolve(copy()); } };
      fns.add(onChange);
      timer = after(() => { off(); resolve(copy()); }, Math.max(0, waitMs));
      try { geo.getCurrentPosition(onFix, () => {}, FAST_FRESHEN); } catch { /* ignore */ }
    });
  }

  return {
    start,
    stop,
    setFast,
    waitFix,
    fast: () => fast,
    latest: () => (last ? { p: last.p.slice(), acc: last.acc, speed: last.speed, at: last.at } : null),
    status: () => state,
    running: () => running,
    on(fn) {
      if (typeof fn !== 'function') return () => {};
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}
