// Night Ops: buzzes, beeps and keeping the screen on.
//   buzz(pattern)      navigator.vibrate when the phone has it (Android; iPhones don't), else nothing.
//                      pattern: a name from PATTERNS ('ping', 'catch'...), a number of ms, or an array.
//   beep(kind)         a short WebAudio sound, only when the player turned sound on (localStorage 'nightops-sound').
//   soundOn(), setSound(on)   read / change that choice (call setSound from a tap: it also unlocks audio on iPhones).
//   silentSwitchMutes()       true on an iPhone whose Safari can't play sound past the silent switch (before iOS 17)
//   keepAwake(on, why) Wake Lock while any reason ('app', 'pocket', ...) wants it; re-asked when the page returns.
//   awake()            true while a wake lock is held.
//   needsTap()         true when a lock is wanted but the phone refused it until it's tapped (iPhones after a reload).
//   onAwake(fn)        fn(awake) whenever that changes; -> off()
//
// iPhones only start sound, and only give a wake lock, from a real tap: WebKit wants "transient user activation",
// which a touchend, a click or a key press gives (a touchstart or a finger's pointerdown doesn't), for 5 s. So every
// tap also wakes the sound (when it's on) and asks for the wake lock when one is wanted but not held. The first tap
// on the page also asks for a lock once and lets it go at once: after one granted from a tap, WebKit gives this page
// later locks without one (when the game screen opens, or the page comes back).

export const SOUND_KEY = 'nightops-sound';

export const PATTERNS = {
  tap: 15,
  ping: [70, 60, 70],
  warn: [180, 90, 180],
  power: [40, 40, 120],
  radar: [250, 120, 250, 120, 250],
  tag: [120, 60, 120, 60, 400],
  catch: [300, 100, 300],
  caught: [500, 150, 500],
  sos: [500, 200, 500, 200, 500],
  win: [90, 60, 90, 60, 300],
  chat: 30,
};

export function buzz(pattern = 'tap') {
  try {
    const nav = globalThis.navigator;
    if (!nav || typeof nav.vibrate !== 'function') return false;
    const p = typeof pattern === 'string' ? (PATTERNS[pattern] ?? PATTERNS.tap) : pattern;
    return nav.vibrate(p);
  } catch {
    return false;
  }
}

// ---- sound -------------------------------------------------------------------------------------------

export function soundOn() {
  try { return globalThis.localStorage?.getItem(SOUND_KEY) === 'on'; } catch { return false; }
}

let ctx = null;
function audio() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

// Safari plays Web Audio as "ambient" sound, which the iPhone's silent switch mutes, unless the page says it's
// playback (Safari 17+). ('transient' and 'ambient' both still obey the switch.) While sound is on it's playback.
function setSession(on) {
  try {
    const session = globalThis.navigator?.audioSession;
    if (!session) return;
    const want = on ? 'playback' : 'auto';
    if (session.type !== want) session.type = want;
  } catch { /* not allowed here */ }
}

export function silentSwitchMutes() {
  try {
    const nav = globalThis.navigator;
    if (!nav || nav.audioSession) return false;
    const ua = String(nav.userAgent || '');
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  } catch {
    return false;
  }
}

let unlocked = null; // the context a silent sound was played on from a tap
function wakeSound() {
  if (!soundOn()) return;
  setSession(true);
  const c = audio();
  if (!c) return;
  // 'interrupted': WebKit's state after a call, Siri or the screen locking.
  if (c.state === 'suspended' || c.state === 'interrupted') c.resume().catch(() => {});
  if (unlocked !== c) {
    // A silent sound from the tap itself: older iPhones only unlock audio once something has played.
    try {
      const b = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = b;
      src.connect(c.destination);
      src.start(0);
      unlocked = c;
    } catch { /* ignore */ }
  }
}

export function setSound(on) {
  try { globalThis.localStorage?.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
  setSession(!!on);
  if (on) {
    armTaps();
    wakeSound();
    beep('good');
  }
  return !!on;
}

// [frequency Hz, start s, length s] per kind.
const TONES = {
  tap: [[880, 0, 0.05]],
  info: [[660, 0, 0.09]],
  good: [[660, 0, 0.08], [990, 0.09, 0.12]],
  ping: [[1320, 0, 0.07], [1320, 0.12, 0.07]],
  warn: [[520, 0, 0.14], [520, 0.2, 0.14]],
  power: [[440, 0, 0.07], [660, 0.07, 0.07], [880, 0.14, 0.1]],
  radar: [[740, 0, 0.18], [555, 0.22, 0.18], [740, 0.44, 0.18]],
  tag: [[880, 0, 0.1], [660, 0.12, 0.1], [440, 0.24, 0.2]],
  catch: [[880, 0, 0.1], [660, 0.12, 0.1], [440, 0.24, 0.2]],
  caught: [[440, 0, 0.18], [330, 0.2, 0.3]],
  sos: [[988, 0, 0.12], [988, 0.18, 0.12], [988, 0.36, 0.12]],
  win: [[523, 0, 0.1], [659, 0.11, 0.1], [784, 0.22, 0.1], [1047, 0.33, 0.25]],
  chat: [[1180, 0, 0.05]],
  // v1.1 PAGE-RADIO: before a walkie-talkie clip (played even with sound off)
  radio: [[1046, 0, 0.06], [1568, 0.08, 0.08]],
  // v1.1 end PAGE-RADIO
  // v1.4 PAGE-PLAY: before a Wiretap piece (lower, so it never sounds like a teammate)
  tap: [[392, 0, 0.08], [294, 0.1, 0.1]],
  // v1.4 end PAGE-PLAY
};

export function beep(kind = 'info') {
  // v1.1 PAGE-RADIO: the walkie-talkie's beep plays with sound off too (the clip after it does)
  const radioBeep = (kind === 'radio' || kind === 'tap') && !soundOn(); // v1.4 PAGE-PLAY: 'tap' too
  if (!radioBeep) {
  // v1.1 end PAGE-RADIO
  if (!soundOn()) return false;
  armTaps();
  setSession(true);
  } // v1.1 PAGE-RADIO end of the radio beep's skip
  const c = audio();
  if (!c) return false;
  try {
    if (c.state === 'suspended' || c.state === 'interrupted') c.resume().catch(() => {});
    const t0 = c.currentTime + 0.01;
    for (const [freq, at, len] of TONES[kind] || TONES.info) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}

// v1.1 PAGE-RADIO: from a tap (the walkie-talkie's button or the game screen's first tap): readies the sound for
// the walkie-talkie's beep, also with sound off (iPhones only start audio from a tap).
export function unlockBeep() {
  const c = audio();
  if (!c) return false;
  try {
    if (c.state === 'suspended' || c.state === 'interrupted') c.resume().catch(() => {});
    if (unlocked !== c) {
      const b = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = b;
      src.connect(c.destination);
      src.start(0);
      unlocked = c;
    }
    return true;
  } catch {
    return false;
  }
}
// v1.1 end PAGE-RADIO

// v1.4 PAGE-PLAY: the Hacker alarm shares this context and session.
export function audioContext() { return audio(); }
// Play past the silent switch only for the alarm, then back to what the player's sound setting says.
export function alarmSession(on) { setSession(on ? true : soundOn()); }
// v1.4 end PAGE-PLAY

// ---- wake lock ---------------------------------------------------------------------------------------

const wanted = new Set();
let lock = null;
let asking = null;     // the request on its way (not from a tap)
let denied = false;    // the last request was refused (WebKit without a tap), and none is held since
let tapRefused = false; // ...and one asked from a tap was refused too (battery saver...): a tap won't help
let primed = false;    // a lock was granted from a tap on this page (WebKit then grants later ones without)
let primeAt = 0;
let watching = false;
const awakeFns = new Set();

function changed() {
  const now = !!lock;
  for (const fn of [...awakeFns]) {
    try { fn(now); } catch (e) { console.error(e); }
  }
}

function visible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

// A lock arrived: keep it if it's still wanted and we don't have one, else let it go.
function adopt(sentinel) {
  if (!sentinel) return;
  if (lock || !wanted.size) {
    try { sentinel.release().catch(() => {}); } catch { /* ignore */ }
    return;
  }
  lock = sentinel;
  denied = false;
  tapRefused = false;
  try {
    sentinel.addEventListener?.('release', () => {
      if (lock !== sentinel) return;
      lock = null;
      changed();
    });
  } catch { /* ignore */ }
  changed();
}

function request(nav, { tap = false } = {}) {
  return nav.wakeLock.request('screen').then((sentinel) => {
    primed = true;
    adopt(sentinel);
    return !!lock;
  }, () => {
    if (!lock) {
      const was = needsTap();
      denied = true;
      if (tap) tapRefused = true;
      if (was !== needsTap()) changed();
    }
    return false;
  });
}

// tap: asked from a real tap, so it goes even while another request is on its way (that one may be refused).
function acquire({ tap = false } = {}) {
  const nav = globalThis.navigator;
  if (!wanted.size || lock || !nav || !nav.wakeLock) return Promise.resolve(!!lock);
  if (!visible()) return Promise.resolve(false);
  if (tap) return request(nav, { tap: true });
  if (asking) return asking;
  asking = request(nav).finally(() => { asking = null; });
  return asking;
}

function release() {
  const l = lock;
  lock = null;
  if (l) {
    try { l.release().catch(() => {}); } catch { /* ignore */ }
    changed();
  }
}

// The first tap on a page: a lock asked for and let go at once (see the top).
function prime() {
  const nav = globalThis.navigator;
  if (primed || !nav || !nav.wakeLock || !visible()) return;
  const t = Date.now();
  if (t - primeAt < 2000) return;
  primeAt = t;
  nav.wakeLock.request('screen').then((sentinel) => {
    primed = true;
    adopt(sentinel); // kept if something wants it by now, else let go
  }, () => {});
}

let tapAskAt = 0;
function tapAwake() {
  const nav = globalThis.navigator;
  if (lock || !nav || !nav.wakeLock) return;
  if (!wanted.size) {
    prime();
    return;
  }
  // (When taps aren't helping either, not on every key press.)
  const t = Date.now();
  if (tapRefused && t - tapAskAt < 10000) return;
  tapAskAt = t;
  acquire({ tap: true });
}

function watchVisibility() {
  if (watching || typeof document === 'undefined' || !document.addEventListener) return;
  watching = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (wanted.size) acquire();
    if (soundOn() && ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) ctx.resume().catch(() => {});
  });
}

// keepAwake(true, 'pocket') / keepAwake(false, 'pocket'). Resolves to whether a lock is held.
export function keepAwake(on, why = 'app') {
  if (on) wanted.add(why);
  else wanted.delete(why);
  watchVisibility();
  armTaps();
  if (!wanted.size) {
    denied = false;
    tapRefused = false;
    release();
    return Promise.resolve(false);
  }
  return Promise.resolve(acquire());
}

export function awake() {
  return !!lock;
}

export function needsTap() {
  try {
    return !!globalThis.navigator?.wakeLock && wanted.size > 0 && !lock && denied && !tapRefused;
  } catch {
    return false;
  }
}

export function onAwake(fn) {
  if (typeof fn !== 'function') return () => {};
  awakeFns.add(fn);
  return () => awakeFns.delete(fn);
}

// ---- taps ----------------------------------------------------------------------------------------------

// v1.1: anything that needs a real tap to work (the walkie-talkie's <audio>, the driver's voice) listens here.
// Touch counts on its touchend/pointerup (a pointerdown isn't a tap to an iPhone), a mouse on its click.
const tapFns = new Set();
export function onTap(fn) {
  if (typeof fn !== 'function') return () => {};
  tapFns.add(fn);
  armTaps();
  return () => tapFns.delete(fn);
}

// The driver's voice: iPhones only speak once a speechSynthesis.speak() came from a tap. The first tap anywhere
// on the page (the lobby, the reveal...) says nothing, silently, so the voice works later without one.
let speechPrimed = false;
export function speechReady() { return speechPrimed; }
export function primeSpeech(win = globalThis.window) {
  if (speechPrimed) return true;
  try {
    const synth = win && win.speechSynthesis;
    const Utter = win && win.SpeechSynthesisUtterance;
    if (!synth || typeof synth.speak !== 'function' || typeof Utter !== 'function') return false;
    const u = new Utter(' ');
    u.volume = 0;
    synth.speak(u);
    speechPrimed = true;
    return true;
  } catch {
    return false;
  }
}
export function _resetSpeech() { speechPrimed = false; }

let tapsArmed = false;
function armTaps() {
  if (tapsArmed || typeof document === 'undefined' || !document.addEventListener) return;
  tapsArmed = true;
  const onTap = (e) => {
    if (!e || e.isTrusted === false) return;
    if (e.type === 'pointerup' && e.pointerType === 'mouse') return;
    if (e.type === 'keydown' && (e.key === 'Escape' || e.repeat)) return;
    try { wakeSound(); } catch { /* ignore */ }
    try { tapAwake(); } catch { /* ignore */ }
    try { primeSpeech(); } catch { /* ignore */ }
    for (const fn of [...tapFns]) {
      try { fn(e); } catch (err) { console.error(err); }
    }
  };
  // Capture on the document, so it runs before anything that stops a touch (pocket mode swallows them all).
  for (const type of ['touchend', 'pointerup', 'click', 'keydown']) {
    document.addEventListener(type, onTap, { capture: true, passive: true });
  }
  watchVisibility();
}

// In a page (not in Node): ready for the first tap, and Safari's audio session set when sound was left on.
try {
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    armTaps();
    if (soundOn()) setSession(true);
  }
} catch { /* ignore */ }
