// Night Ops v1.6.2 (PERMS): ask the phone for location, the microphone and the camera straight from a tap, so the
// browser shows its own "Allow" box and nobody has to dig through Settings.
//
//   permState(part, { nav }) -> Promise<'granted' | 'denied' | 'prompt' | 'unknown'>
//        what the browser says before asking ('unknown' where it can't say: older Safari, Firefox for some parts)
//   askLocation(opts) / askMic(opts) / askCamera(opts) / ask(part, opts) -> Promise<Answer>
//        Call it in the tap's own handler, before any await: that's what lets the browser show its box. A test
//        stream is stopped at once; a location fix is never sent anywhere.
//   askAll(parts, { onStep }) -> Promise<{ [part]: Answer }>   one after another (location, then mic, then camera),
//        all from one tap. A later one that can't ask any more (iPhones want a tap for each) comes back needsTap.
//   classify({ part, outcome, state, ms, chained, acc }) -> Answer   (pure: tested in Node)
//   onAnswer(fn) -> off()   every Answer as it comes: app.js starts what was waiting (the location watch, the shared
//                          camera/mic stream, the walkie-talkie)
//   lastAnswer(part) -> Answer | null       blockedWords(part) -> "Your browser blocked ..., so it can't ask again."
//
// Answer = { part, result: 'granted' | 'denied' | 'unavailable', blocked, needsTap, why, state, ms, acc }
//   blocked   the browser won't show its box again, so only the steps in Settings help: the permission says
//             'denied', or the site is allowed but the phone itself said no, or a "no" came quicker than a person
//             could tap (no box showed)
//   needsTap  (askAll only) refused at once but not blocked: it needs its own tap
//   why       help.js's word for the steps: 'denied' | 'off' | 'none' | 'timeout' | 'unanswered' | null
//   state     the permission after asking ('unknown' where the browser can't say)
//   acc       location only: the fix's accuracy in metres (null without a fix)

export const PARTS = ['location', 'mic', 'camera'];
export const PERM_NAMES = { location: 'geolocation', mic: 'microphone', camera: 'camera' };
export const STATES = ['granted', 'denied', 'prompt', 'unknown'];
export const RESULTS = ['granted', 'denied', 'unavailable'];
// A "no" quicker than this never came from a person: the browser didn't show its box.
export const FAST_NO_MS = 450;
// Location: one fix asked for (never sent anywhere). The box itself isn't counted: browsers start the timeout once
// it's allowed. GUARD_MS: no answer at all by then (Firefox's "Not now" never calls back).
export const LOC_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
export const GUARD_MS = 30000;
// askAll / waitFix false: once location is allowed, this long for an error (Android says "no" here at once when
// the phone's own location is off) before it counts as allowed without a fix.
export const GRANTED_GRACE_MS = 1200;
export const QUERY_MS = 1500; // a permissions.query that never answers (some web views) counts as 'unknown'
export const MIC_ASK = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
export const CAMERA_ASK = { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } };

const WHAT = { location: 'your location', mic: 'the microphone', camera: 'the camera' };
export const LABELS = { location: 'Allow location', mic: 'Allow microphone', camera: 'Allow camera' };

export function blockedWords(part) {
  return `Your browser blocked ${WHAT[part] || 'it'}, so it can't ask again.`;
}

// The words to show after an answer (blockedBefore: the screen already showed the steps).
export function answerWords(a, { blockedBefore = false } = {}) {
  if (!a) return '';
  if (a.result === 'granted') return a.part === 'location' ? 'Allowed. Finding you...' : "Allowed. You're all set!";
  if (a.result === 'unavailable') {
    if (a.why !== 'none') return 'Not working yet. Try the steps.';
    return a.part === 'location' ? "This browser can't share a location." : `No ${a.part === 'mic' ? 'microphone' : 'camera'} found.`;
  }
  if (a.blocked) return blockedBefore ? 'Still blocked. Do the steps, then tap Try again.' : blockedWords(a.part);
  if (a.why === 'unanswered') return 'No answer yet. Tap the button again.';
  return 'Your phone said no. Tap the button again and pick Allow.';
}

const asPart = (part) => (PARTS.includes(part) ? part : 'location');
const asState = (s) => (STATES.includes(s) ? s : 'unknown');

// ---- what an answer means ----------------------------------------------------------------------------------------
// outcome: 'ok' (a fix / a stream), 'no' (refused), 'off' (location services off, or another app has the camera or
// microphone), 'missing' (nothing to ask: no geolocation / mediaDevices / no such device), 'timeout' (location: allowed,
// no fix yet), 'unanswered' (no answer at all)
export function classify({ part, outcome, state = 'unknown', ms = 0, chained = false, acc = null } = {}) {
  const p = asPart(part);
  const st = asState(state);
  const base = {
    part: p, result: 'denied', blocked: false, needsTap: false, why: 'denied', state: st,
    ms: Math.max(0, Math.round(Number(ms) || 0)), acc: Number.isFinite(acc) ? Math.max(0, Math.round(acc)) : null,
  };
  if (outcome === 'ok') return { ...base, result: 'granted', why: null };
  if (outcome === 'missing') return { ...base, result: 'unavailable', why: 'none' };
  if (outcome === 'off') return { ...base, result: 'unavailable', why: 'off' };
  if (outcome === 'timeout') {
    // (browsers only time out once it's allowed; a box still showing isn't a yes)
    return st === 'prompt' ? { ...base, why: 'unanswered' } : { ...base, result: 'granted', why: 'timeout' };
  }
  if (outcome === 'unanswered') {
    if (st === 'granted') return { ...base, result: 'granted', why: 'timeout' };
    if (st === 'denied') return { ...base, blocked: true };
    return { ...base, why: 'unanswered' };
  }
  // 'no' (and anything unknown): refused
  if (st === 'granted') {
    // The site is allowed but the phone said no: its own location is off (Android), or the browser app itself isn't
    // allowed the camera / microphone. Asking again can't help.
    return { ...base, blocked: true, why: p === 'location' ? 'off' : 'denied' };
  }
  if (st === 'denied') return { ...base, blocked: true };
  if (base.ms < FAST_NO_MS) {
    if (chained) return { ...base, needsTap: true };
    // The browser can't say (older Safari): a quick "no" may only be a quick tap. Show the steps, keep the button.
    if (st === 'unknown') return { ...base, unsure: true };
    return { ...base, blocked: true };
  }
  return base; // a person said no (or closed the box): the button can ask again
}

// ---- the browser's own word ---------------------------------------------------------------------------------------
function query(part, nav) {
  const name = PERM_NAMES[part];
  const perms = nav && nav.permissions;
  if (!name || !perms || typeof perms.query !== 'function') return Promise.resolve(null);
  try {
    const p = perms.query({ name });
    return p && typeof p.then === 'function' ? Promise.resolve(p).catch(() => null) : Promise.resolve(null);
  } catch { return Promise.resolve(null); }
}

export function permState(part, { nav = globalThis.navigator, after = setTimeout, cancel = clearTimeout, waitMs = QUERY_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const t = after(() => { if (!done) { done = true; resolve('unknown'); } }, waitMs);
    query(asPart(part), nav).then((st) => {
      if (done) return;
      done = true;
      cancel(t);
      resolve(asState(st && st.state));
    });
  });
}

// ---- who hears an answer ------------------------------------------------------------------------------------------
const listeners = new Set();
const last = new Map();
export function onAnswer(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function lastAnswer(part) {
  return last.get(asPart(part)) || null;
}
// (tests) forget what was heard
export function forget() {
  last.clear();
}
function tell(a) {
  last.set(a.part, a);
  for (const fn of [...listeners]) {
    try { fn(a); } catch (e) { console.error(e); }
  }
  return a;
}
// Another part of the page asked the browser itself (the lobby's camera mirror): its yes, told like ours.
export function reportGranted(part) {
  return tell(classify({ part, outcome: 'ok', state: 'granted' }));
}

const nowMs = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// ---- location ------------------------------------------------------------------------------------------------------
// waitFix: wait for a fix (the ready check's "Found you to 8 m"); false: done as soon as it's allowed (the gear check,
// one step of askAll). The fix's own callbacks keep working after (they're just not waited for).
export function askLocation({
  nav = globalThis.navigator, now = nowMs, after = setTimeout, cancel = clearTimeout,
  chained = false, waitFix = true, options = LOC_OPTIONS, guardMs = GUARD_MS, graceMs = GRANTED_GRACE_MS,
} = {}) {
  const t0 = now();
  const geo = nav && nav.geolocation;
  return new Promise((resolve) => {
    let done = false;
    let guard = null;
    let grace = null;
    let status = null;
    const onChange = () => { if (status && status.state === 'granted' && !waitFix) allowed(); else if (status && status.state === 'denied') finish('no'); };
    function stopWatching() {
      if (guard !== null) cancel(guard);
      if (grace !== null) cancel(grace);
      guard = null; grace = null;
      try { if (status && status.removeEventListener) status.removeEventListener('change', onChange); } catch { /* fine */ }
    }
    function finish(outcome, acc = null) {
      if (done) return;
      done = true;
      stopWatching();
      const ms = now() - t0;
      permState('location', { nav, after, cancel }).then((state) => resolve(tell(classify({ part: 'location', outcome, state, ms, chained, acc }))));
    }
    function allowed() {
      if (done || grace !== null) return;
      grace = after(() => { grace = null; finish('ok'); }, graceMs);
    }
    if (!geo || typeof geo.getCurrentPosition !== 'function') { finish('missing'); return; }
    try {
      // first, in the tap itself: this is what shows the box
      geo.getCurrentPosition((pos) => {
        const c = pos && pos.coords;
        finish('ok', c && Number.isFinite(c.accuracy) ? c.accuracy : null);
      }, (err) => {
        const code = err && err.code;
        finish(code === 1 ? 'no' : code === 2 ? 'off' : 'timeout');
      }, options);
    } catch {
      finish('missing');
      return;
    }
    if (done) return;
    guard = after(() => { guard = null; finish('unanswered'); }, guardMs);
    if (!waitFix) {
      // Done once the browser says it's allowed (a fix can take a while outdoors at night).
      query('location', nav).then((st) => {
        if (done || !st) return;
        status = st;
        try { if (st.addEventListener) st.addEventListener('change', onChange); } catch { /* fine */ }
        if (st.state === 'granted') allowed();
      });
    }
  });
}

// ---- the microphone and the camera ---------------------------------------------------------------------------------
export function mediaOutcome(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'no';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError' || n === 'NotSupportedError' || n === 'TypeError') return 'missing';
  return 'off'; // NotReadableError: another app has it (a call, the Camera app); AbortError
}

function askMedia(part, { nav = globalThis.navigator, now = nowMs, after = setTimeout, cancel = clearTimeout, chained = false } = {}) {
  const t0 = now();
  const md = nav && nav.mediaDevices;
  const answer = (outcome) => permState(part, { nav, after, cancel })
    .then((state) => tell(classify({ part, outcome, state, ms: now() - t0, chained })));
  if (!md || typeof md.getUserMedia !== 'function') return answer('missing');
  let p;
  try {
    // first, in the tap itself: this is what shows the box
    p = md.getUserMedia(part === 'camera' ? CAMERA_ASK : MIC_ASK);
  } catch (e) {
    p = Promise.reject(e);
  }
  return Promise.resolve(p).then((stream) => {
    // only a test: let go at once (an open microphone keeps iPhones at call volume)
    try { for (const t of stream.getTracks()) t.stop(); } catch { /* fine */ }
    return answer('ok');
  }, (e) => answer(mediaOutcome(e)));
}

export const askMic = (opts) => askMedia('mic', opts);
export const askCamera = (opts) => askMedia('camera', opts);

export function ask(part, opts = {}) {
  const p = asPart(part);
  return p === 'location' ? askLocation(opts) : askMedia(p, opts);
}

// Still inside a tap? (Chrome and Safari 16.4+ can say; elsewhere a later step is treated as maybe not.)
function stillTapped(nav) {
  try { return !!(nav && nav.userActivation && nav.userActivation.isActive); } catch { return false; }
}

// "Allow all": one tap, each part asked after the one before was answered. onStep(part, null) as one starts,
// onStep(part, answer) when it's answered. tapped false: not from a tap at all (the gear check starting by itself),
// so even the first one's instant "no" only means it needs a tap.
export async function askAll(parts = PARTS, opts = {}) {
  const nav = opts.nav === undefined ? globalThis.navigator : opts.nav;
  const out = {};
  let first = opts.tapped !== false;
  for (const part of parts) {
    if (!PARTS.includes(part)) continue;
    const step = typeof opts.onStep === 'function' ? opts.onStep : null;
    if (step) { try { step(part, null); } catch (e) { console.error(e); } }
    const chained = !first && !stillTapped(nav);
    const a = await ask(part, { ...opts, nav, chained, waitFix: false });
    out[part] = a;
    if (step) { try { step(part, a); } catch (e) { console.error(e); } }
    first = false;
  }
  return out;
}
