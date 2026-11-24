// Night Ops: where this phone is. A watchPosition wrapper that keeps the last fix and never throws.
// createLocation() -> { start(), stop(), latest() -> {p, acc, speed, at}|null,
//                       status() -> 'off'|'asking'|'ok'|'denied'|'unavailable', on(fn) -> off() }
// setFast(on): while this phone is the driver it asks for a fresh fix much more often (the server only calls the
// car parked on a fix under PARK_FRESH_MS old, and a phone standing still often stops sending them).
// fn(status, latest) runs on every change. A phone standing still may stop sending fixes, so while started
// it asks for a fresh one now and then; and it restarts the watch when the page comes back to the front
// (iPhones can stop a watch in the background).
import { isPoint } from '../shared/geo.js?v=176';

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

// v1.4 PAGE-DEVICES: the watchdog. health() says what's wrong in words a help screen can use; the watch is started
// again after errors (on these steps, then every 30 s), when the page comes back, and when no fix came for a while.
export const WATCHDOG_MS = 20000;
export const RETRY_STEPS_MS = [2000, 5000, 10000, 30000];
export const TEST_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
const DOG_EVERY_MS = 1000;
// v1.4 end PAGE-DEVICES

export function createLocation({
  geo = globalThis.navigator?.geolocation,
  now = () => Date.now(),
  doc = globalThis.document,
  win = globalThis.window, // v1.4 PAGE-DEVICES: pageshow / focus
  perms = globalThis.navigator?.permissions,
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = (t) => clearInterval(t),
  after = (fn, ms) => setTimeout(fn, ms),
  cancelAfter = (t) => clearTimeout(t),
  // v1.4 PAGE-DEVICES: the watchdog's 1 s tick (its own timer: never keeps Node alive)
  dogEvery = (fn, ms) => { const t = setInterval(fn, ms); if (t && t.unref) t.unref(); return t; },
  dogStop = (t) => clearInterval(t),
} = {}) {
  let state = geo ? 'off' : 'unavailable';
  let last = null;
  let watchId = null;
  let running = false;
  let freshen = null;
  let fast = false;
  const fns = new Set();
  // v1.4 PAGE-DEVICES: the watchdog's memory
  let lastErr = null;        // { code, at }
  let startedAt = 0;         // when the watch last (re)started
  let retryN = 0;            // which RETRY_STEPS_MS step comes next
  let retryTimer = null;
  let dog = null;
  let seenHealth = null;
  let deniedBack = false;    // a denied watch tried again once on coming back
  // v1.4 end PAGE-DEVICES

  function emit() {
    seenHealth = health(); // v1.4 PAGE-DEVICES
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
    lastErr = null; // v1.4 PAGE-DEVICES
    retryN = 0;
    if (retryTimer !== null) { cancelAfter(retryTimer); retryTimer = null; }
    emit();
  }

  function onError(err) {
    if (!running) return;
    const code = err && err.code;
    lastErr = { code: Number(code) || 0, at: now() }; // v1.4 PAGE-DEVICES
    if (code === 2 || code === 3) scheduleRetry();
    if (code === 1) {
      // Permission denied: no point watching. start() tries again (after the player changes settings).
      clearWatch();
      setState('denied');
    } else if (code === 2) {
      if (!last) setState('unavailable');
    }
    // code 3 (timeout): keep watching, keep the state.
    if (seenHealth !== health()) emit(); // v1.4 PAGE-DEVICES: health words changed
  }

  // v1.4 PAGE-DEVICES ---------------------------------------------------------------------------------------
  function health() {
    if (!geo) return 'none';
    if (state === 'denied') return 'denied';
    const t = now();
    const fresh = !!last && t - last.at < WATCHDOG_MS;
    if (fresh) return 'ok';
    if (!running) return last ? 'stale' : 'none';
    if (lastErr && t - lastErr.at < WATCHDOG_MS + 30000) {
      if (lastErr.code === 2) return 'off';
      if (lastErr.code === 3) return 'timeout';
    }
    if (!last && t - startedAt < WATCHDOG_MS) return 'asking';
    return 'stale';
  }

  // After an error 2 or 3: the watch again on the next step (then every 30 s).
  function scheduleRetry() {
    if (retryTimer !== null || !running) return;
    const ms = RETRY_STEPS_MS[Math.min(retryN, RETRY_STEPS_MS.length - 1)];
    retryN += 1;
    retryTimer = after(() => {
      retryTimer = null;
      if (running && state !== 'denied') watch();
    }, ms);
  }

  // Every second: a stuck watch (no fix for WATCHDOG_MS; iPhones stop one in the background) starts again, and
  // listeners hear when the health words change (fresh -> stale needs no event to happen).
  function sniff() {
    if (!running) return;
    const t = now();
    if (state !== 'denied' && t - startedAt >= WATCHDOG_MS && (!last || t - last.at >= WATCHDOG_MS) && retryTimer === null) watch();
    if (health() !== seenHealth) emit();
  }

  function onBack() {
    if (!running || !geo) return;
    if (doc && doc.visibilityState === 'hidden') return;
    if (state === 'denied') {
      if (deniedBack) return;
      deniedBack = true; // once per coming back (a page reading "denied" again won't loop)
    }
    watch();
    if (state !== 'denied') poke();
  }
  const onHidden = () => { if (doc && doc.visibilityState === 'hidden') deniedBack = false; };

  // "Test my location" (the ready check): one fresh fix from a tap, never sent anywhere.
  function test() {
    const t0 = now();
    if (!geo) return Promise.resolve({ ok: false, acc: null, ms: 0, why: 'none' });
    return new Promise((resolve) => {
      let done = false;
      const end = (r) => { if (!done) { done = true; resolve({ ...r, ms: Math.max(0, Math.round(now() - t0)) }); } };
      const guard = after(() => end({ ok: false, acc: null, why: 'timeout' }), TEST_OPTIONS.timeout + 2000);
      try {
        geo.getCurrentPosition((pos) => {
          cancelAfter(guard);
          const c = pos && pos.coords;
          const acc = c && Number.isFinite(c.accuracy) ? Math.max(0, Math.round(c.accuracy)) : null;
          if (running) onFix(pos);
          if (state === 'denied' && running) { state = 'asking'; watch(); }
          end({ ok: true, acc, why: null });
        }, (err) => {
          cancelAfter(guard);
          const code = err && err.code;
          end({ ok: false, acc: null, why: code === 1 ? 'denied' : code === 2 ? 'off' : 'timeout' });
        }, TEST_OPTIONS);
      } catch {
        cancelAfter(guard);
        end({ ok: false, acc: null, why: 'none' });
      }
    });
  }

  // "Try again" (from a tap): the watch cleared and started again; the browser may ask again from here.
  function retry() {
    if (!geo) return;
    lastErr = null;
    retryN = 0;
    if (retryTimer !== null) { cancelAfter(retryTimer); retryTimer = null; }
    if (!running) { start(); return; }
    if (state === 'denied') state = 'asking';
    watch();
    poke();
    emit();
  }
  // v1.4 end PAGE-DEVICES ----------------------------------------------------------------------------------

  function clearWatch() {
    if (watchId !== null && geo) {
      try { geo.clearWatch(watchId); } catch { /* ignore */ }
    }
    watchId = null;
  }

  function watch() {
    clearWatch();
    startedAt = now(); // v1.4 PAGE-DEVICES
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
    if (!running || !doc) return;
    if (doc.visibilityState !== 'visible') { onHidden(); return; }
    onBack(); // v1.4 PAGE-DEVICES: a denied watch only once per coming back
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
    // v1.4 PAGE-DEVICES
    if (win && win.addEventListener) { win.addEventListener('pageshow', onBack); win.addEventListener('focus', onBack); }
    if (!dog) dog = dogEvery(sniff, DOG_EVERY_MS);
    // v1.4 end PAGE-DEVICES
  }

  function stop() {
    running = false;
    clearWatch();
    if (freshen) stopEvery(freshen);
    freshen = null;
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisible);
    // v1.4 PAGE-DEVICES
    if (win && win.removeEventListener) { win.removeEventListener('pageshow', onBack); win.removeEventListener('focus', onBack); }
    if (dog) dogStop(dog);
    dog = null;
    if (retryTimer !== null) { cancelAfter(retryTimer); retryTimer = null; }
    lastErr = null;
    // v1.4 end PAGE-DEVICES
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
    health, // v1.4 PAGE-DEVICES
    test,
    retry,
    accuracy: () => (last ? last.acc : null),
    running: () => running,
    on(fn) {
      if (typeof fn !== 'function') return () => {};
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}
