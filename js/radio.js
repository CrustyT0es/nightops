// Night Ops: the hunters' walkie-talkie (v1.1, PAGE-RADIO). Record, send, queue and play clips.
//
//   const radio = createRadio({ app, alerts })   // null when this browser can't record (no MediaRecorder or
//                                                // getUserMedia)
//   radio.button({ big })  a hold-to-talk button (touch, mouse, keyboard; a screen reader's double tap starts and
//                          a second one sends). Its line says "Sam is talking", what went wrong, or the time held.
//   radio.state            'idle' | 'asking' | 'recording' | 'sending' | 'denied' | 'unsupported'
//   radio.talking          null | { from, name } while a clip plays
//   radio.last             the newest clip number taken from a view (the page sends it as radioSince)
//   radio.take(view)       new clips from view.radio queued (never your own, never older than RADIO_STALE_MS)
//   radio.hold(), radio.letGo()   what the button does (press and release)
//   radio.unlock()         from a tap: readies the one shared <audio> (so clips play in pocket mode) and the beep
//   radio.on(name, fn)     'state' | 'talking' | 'error' -> off()
//   radio.stop()           playback and recording stopped, the queue emptied, the microphone let go
//   radio.destroy()
//
// v1.2 (PAGE-RADIO): the hiders' walkie-talkie and Quiet.
//   createRadio({ ..., getMic })   the microphone: app.mic() when the app has it (the camera's own audio while it
//                          films, shared: never stopped here), else getUserMedia as before
//   radio.side             'hunters' | 'hiders' | null, from the latest view.radio (a caught hider who joins the
//                          hunters switches with the next view: the hiders' messages waiting are dropped)
//   radio.quiet            radio.setQuiet(on) (kept per phone: localStorage 'nightops-quiet'). Hiders only: while
//                          on, a new message isn't played: one short buzz, and it waits in radio.held
//   radio.held             [{ n, from, name, ms, clock }] oldest first, HELD_MOST at most; radio.playHeld(n)
//   radio.quietButton()    the Quiet switch (a 56px tray square); radio.heldList() the waiting messages with Play
//   radio.on('held' | 'quiet' | 'side', fn)
//
// The replay's side (over.js): clipPlan(clips, fromS, toS, playing) says which clips a replay frame crossed, and
// createReplayRadio({ app, getClock, onChange }) plays them one at a time while the replay runs at real time.
//
// The microphone is asked for on the first hold only (the browser remembers the yes). Its stream is let go of as
// soon as each clip is recorded: a phone keeping an echo-cancelled microphone open plays everything at call volume
// (and a car's or headset's Bluetooth drops to its hands-free sound) and shows its mic light all game.
//
// Sound needs a real tap first (a pointerdown isn't one on an iPhone): every tap on the page (alerts.onTap) and
// the button's release ready it, again and again until it works.
import { h, text, cls } from './dom.js?v=151';
import { icon } from './ui/icons.js?v=151';
import { TIMING, LIMITS, fmtClock } from '../shared/rules.js?v=151';

export const RADIO_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
export const BITS = 24000;
export const SEND_TIMEOUT_MS = 20000;
export const LINE_MS = 5000;          // a passing line ("Sent.", "Didn't send...") shows this long
export const BEEP_GAP_MS = 320;       // the beep, then the clip
export const PLAY_SLACK_MS = 5000;    // a clip that never says it ended moves on after its length + this
export const LATE_S = 10;             // replay: a waiting clip more than this late (replay clock) is skipped
export const FETCH_WAIT_MS = 8000;    // replay: a clip still not here after this is passed over
export const AHEAD = 2;               // replay: clips fetched ahead of the replay clock
export const SLICE_MS = 1000;         // the recorder hands over what it has this often (to watch the size)
export const SIZE_SLACK = 2500;       // bytes kept free under LIMITS.radioBytes for the end of the file
export const CLIP_TRIES = 4;          // a clip that didn't download (no signal) is asked for this many times
export const RETRY_MS = 2000;         // ...waiting this long, then twice as long each time
export const SPEECH_WAIT_MS = 10000;  // a clip waits at most this long for the driver's voice to finish
const LOOK_AGAIN_MS = 300;
// v1.2 PAGE-RADIO
export const QUIET_KEY = 'nightops-quiet';
export const HELD_MOST = 10;          // messages kept waiting while Quiet is on (the oldest goes)
export const BUZZ_MS = 60;            // one short buzz for each message held
// v1.2 end PAGE-RADIO

export const WORDS = {
  hold: 'Hold to talk',
  asking: 'Allow the microphone',
  sending: 'Sending...',
  sent: 'Sent.',
  short: 'Hold the button while you talk.',
  denied: "The walkie-talkie needs the microphone. Allow it in your browser's settings.",
  unsupported: "This phone can't record walkie-talkie messages.",
  notSent: "Didn't send. Hold to try again.",
  tooLong: 'That was too long to send. Keep it shorter.',
  full: 'Sent what fits. Hold again to say more.',
  ready: 'Ready. Hold the button while you talk.',
  tap: 'Tap the screen once to hear the walkie-talkie.',
  off: 'Only hunters have the walkie-talkie.',
  letGo: 'Let go to send',
  // v1.2 PAGE-RADIO
  earbuds: 'Earbuds help: nobody near you hears it.',
  quietOn: 'Quiet is on: messages wait here. Tap Play to hear one.',
  quietOff: 'Quiet keeps messages from playing out loud. They wait here.',
  // v1.2 end PAGE-RADIO
};

export const tapWords = (name) => `Listening to ${name || 'a hider'}`; // v1.4 PAGE-PLAY
export const talkingWords = (name) => `${name || 'A hunter'} is talking`;
export const cantPlayWords = (name) => `${name || 'A hunter'}'s message can't play on this phone.`;
export const notHereWords = (name) => `${name || 'A hunter'}'s message didn't come through.`;

// ---- pure helpers (tested in Node) ----------------------------------------------------------------------------

// v1.2 PAGE-RADIO: the hiders' side
export const sideOf = (radio) => (radio && radio.side === 'hiders' ? 'hiders' : 'hunters');
export const someone = (side) => (side === 'hiders' ? 'A hider' : 'A hunter');
export const sideLabel = (side) => (side === 'hiders' ? "Hiders' walkie-talkie" : "Hunters' walkie-talkie");
// "Mia sent a message (4 s)"
export function heldWords(name, ms) {
  const s = Math.max(1, Math.round((num(ms) || 0) / 1000));
  return `${name || 'Someone'} sent a message (${s} s)`;
}
// The replay's caption: "Ava (hiders) is talking" when both teams talked, else "Sam is talking".
export function replayTalkingWords(name, side, both) {
  const who = name || someone(side);
  return both ? `${who} (${side === 'hiders' ? 'hiders' : 'hunters'}) is talking` : `${who} is talking`;
}
export function readQuiet(store) {
  try { return !!store && store.getItem(QUIET_KEY) === 'on'; } catch { return false; }
}
export function saveQuiet(store, on) {
  try { if (store) store.setItem(QUIET_KEY, on ? 'on' : 'off'); } catch { /* private mode: this page remembers */ }
}
// Held messages, oldest first, the oldest dropped past `most`. Pure: -> a new list.
export function addHeld(list, item, most = HELD_MOST) {
  const out = (Array.isArray(list) ? list : []).filter((x) => x && x.n !== item.n);
  out.push(item);
  out.sort((a, b) => a.n - b.n);
  return out.length > most ? out.slice(out.length - most) : out;
}
// v1.2 end PAGE-RADIO

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// The first type this browser records: AAC in MP4 (plays on iPhones and Android), else Opus in WebM.
export function pickType(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';
  for (const t of RADIO_TYPES) {
    try { if (Recorder.isTypeSupported(t)) return t; } catch { /* next */ }
  }
  return '';
}

// 'audio/mp4' | 'audio/webm' | '' (what the server takes: the part before ';', lower case).
export function baseType(t) {
  const b = String(t || '').split(';')[0].trim().toLowerCase();
  return b === 'audio/mp4' || b === 'audio/webm' ? b : '';
}

export function toBase64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(s);
}

export function fromBase64(str) {
  const bin = atob(String(str || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// A short silent WAV (8 kHz, 16-bit mono): unlocks an <audio> from a tap, and stands in for clips in the preview.
export function silentWav(ms = 60) {
  const samples = Math.max(1, Math.round(8 * ms));
  const data = samples * 2;
  const b = new Uint8Array(44 + data);
  const v = new DataView(b.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i += 1) b[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, data, true);
  return b;
}

// How long a clip may be recorded for: RADIO_MAX_MS, or less when this phone's last clip showed its recorder makes
// more bytes a second than the server takes (some ignore the bit rate asked for).
export function maxHoldMs(bytesPerMs) {
  const r = num(bytesPerMs);
  if (!r || r <= 0) return TIMING.RADIO_MAX_MS;
  return Math.max(2000, Math.min(TIMING.RADIO_MAX_MS, Math.floor((LIMITS.radioBytes * 0.97) / r)));
}

// Which of view.radio's clips to play: new ones (not seen before), not your own, not older than RADIO_STALE_MS
// (game clock) and in order. `seen` (a Set of n) is filled in with every clip looked at.
export function clipsToPlay(view, seen, meId = view && view.me ? view.me.id : null) {
  const r = view && view.radio;
  if (!r || !Array.isArray(r.clips)) return [];
  const clock = num(view.clock);
  const out = [];
  const list = r.clips.filter((c) => c && Number.isInteger(c.n)).slice().sort((a, b) => a.n - b.n);
  for (const c of list) {
    if (seen.has(c.n)) continue;
    seen.add(c.n);
    if (meId && c.from === meId) continue;
    if (clock !== null && num(c.clock) !== null && c.clock < clock - TIMING.RADIO_STALE_MS) continue;
    out.push(c);
  }
  return out;
}

// The replay: clips whose start the replay clock crossed going from fromS to toS (seconds) while playing,
// by clock. A jump (not playing) or going back crosses nothing. [fromS, toS): every start is crossed once.
export function clipPlan(clips, fromS, toS, playing) {
  if (!playing || !(toS > fromS) || !Array.isArray(clips)) return [];
  return clips
    .filter((c) => c && num(c.clock) !== null && c.clock / 1000 >= fromS && c.clock / 1000 < toS)
    .sort((a, b) => a.clock - b.clock || a.n - b.n);
}

// "4:12 Sam, 6 s" for the replay's list.
export function clipLine(clip, name) {
  const s = Math.max(1, Math.round((num(clip && clip.ms) || 0) / 1000));
  return `${fmtClock(num(clip && clip.clock) || 0)} ${name || 'A hunter'}, ${s} s`;
}

// The replay's clips from a summary: well-formed ones, by clock.
export function replayClips(summary) {
  const list = summary && Array.isArray(summary.radio) ? summary.radio : [];
  return list
    .filter((c) => c && Number.isInteger(c.n) && num(c.clock) !== null && num(c.ms) !== null && typeof c.from === 'string')
    .slice()
    .sort((a, b) => a.clock - b.clock || a.n - b.n);
}

function emitter() {
  const fns = new Map();
  return {
    on(name, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!fns.has(name)) fns.set(name, new Set());
      fns.get(name).add(fn);
      return () => fns.get(name)?.delete(fn);
    },
    emit(name, ...a) {
      for (const fn of [...(fns.get(name) || [])]) {
        try { fn(...a); } catch (e) { console.error(e); }
      }
    },
    clear() { fns.clear(); },
  };
}

// An <audio> unlocked from a tap: a silent sound played from the tap itself (iPhones then let it play later,
// also with the screen blacked out by pocket mode).
// Until the silent sound has really played (confirmed), every tap tries again: a try from a touch's pointerdown
// is refused by iPhones, and must not stop the release's try.
function unlocker(win, makeAudio) {
  let el = null;
  let unlocked = false;
  let confirmed = false;
  let tries = 0;
  let silentUrl = '';
  return {
    get el() {
      if (!el) {
        try { el = makeAudio(); } catch { el = null; }
        if (el) { try { el.preload = 'auto'; el.setAttribute?.('playsinline', ''); } catch { /* fine */ } }
      }
      return el;
    },
    unlock(busy) {
      const a = this.el;
      if (!a || confirmed || busy) return;
      try {
        const U = win && win.URL ? win.URL : globalThis.URL;
        const B = win && win.Blob ? win.Blob : globalThis.Blob;
        if (!silentUrl && U && B && typeof U.createObjectURL === 'function') silentUrl = U.createObjectURL(new B([silentWav()], { type: 'audio/wav' }));
        if (!silentUrl) return;
        a.src = silentUrl;
        const p = a.play();
        const mine = ++tries;
        unlocked = true;
        if (p && typeof p.then === 'function') {
          p.then(() => {
            confirmed = true;
            if (a.src === silentUrl || String(a.src).endsWith(silentUrl)) a.pause();
          }, () => { if (mine === tries && !confirmed) unlocked = false; });
        } else {
          confirmed = true;
        }
      } catch {
        unlocked = false;
      }
    },
    get unlocked() { return unlocked; },
    get confirmed() { return confirmed; },
    reset() { unlocked = false; confirmed = false; },
  };
}

// ---- the live walkie-talkie -----------------------------------------------------------------------------------

export function createRadio({
  app,
  alerts = null,
  doc = globalThis.document ?? null,
  win = globalThis.window ?? null,
  Recorder = globalThis.MediaRecorder,
  media = globalThis.navigator ? globalThis.navigator.mediaDevices : undefined,
  makeAudio = () => new Audio(),
  now = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  // Something else is speaking (the driver's voice): a new clip waits for it (at most SPEECH_WAIT_MS).
  otherBusy = () => !!(win && win.speechSynthesis && win.speechSynthesis.speaking),
  // v1.2 PAGE-RADIO: the microphone (-> Promise<MediaStream | { stream, shared }>) and where Quiet is kept
  getMic = null,
  store = (() => { try { return globalThis.localStorage || null; } catch { return null; } })(),
  // v1.2 end PAGE-RADIO
} = {}) {
  // v1.2 PAGE-RADIO: app.mic() first (one microphone for the camera and the walkie-talkie on iPhones)
  const micFrom = typeof getMic === 'function' ? getMic
    : app && typeof app.mic === 'function' ? () => app.mic()
    : media && typeof media.getUserMedia === 'function'
      ? () => media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      : null;
  if (typeof Recorder !== 'function' || !micFrom) return null;
  // v1.2 end PAGE-RADIO
  const ev = emitter();
  const audio = unlocker(win, makeAudio);
  const buttons = new Set();
  const seen = new Set();
  const R = {
    state: 'idle',
    talking: null,
    last: 0,
    on: false,              // on the radio now (a live hunter, by the latest view)
    meId: null,
    stream: null,
    rec: null,
    chunks: [],
    holding: false,
    startedAt: 0,
    autoTimer: null,
    tickTimer: null,
    bytesPerMs: null,
    queue: [],
    current: null,          // { clip, token, timer }
    token: 0,
    note: '',
    noteTimer: null,
    pressAt: -Infinity,
    byClick: false,
    dead: false,
    granted: false,         // the microphone was allowed once (asking again won't show a prompt)
    bytes: 0,               // recorded so far (this clip)
    slice: 0,               // the biggest slice so far (this clip)
    tries: new Map(),       // n -> downloads tried
    retries: new Set(),     // timers bringing a clip back to try again
    waitSince: null,        // a clip waiting for the driver's voice, since
    pumpTimer: null,
    // v1.2 PAGE-RADIO
    shared: false,          // R.stream is the camera's: never stopped here
    side: null,             // 'hunters' | 'hiders' (the latest view.radio)
    quiet: readQuiet(store),
    held: [],               // [{ n, from, name, ms, clock, clip }]
    // v1.2 end PAGE-RADIO
  };

  const nameOf = (id) => {
    try {
      const p = app && typeof app.player === 'function' ? app.player(id) : null;
      return p && p.name ? String(p.name).slice(0, 40) : someone(R.side);
    } catch { return someone(R.side); }
  };

  function setState(s) {
    if (R.state === s) return;
    R.state = s;
    ev.emit('state', s);
    paint();
  }

  function say(words, { stay = false, error = false } = {}) {
    clearTimer(R.noteTimer);
    R.noteTimer = null;
    R.note = words || '';
    if (words && !stay) R.noteTimer = setTimer(() => { R.note = ''; paint(); }, LINE_MS);
    if (words && error) ev.emit('error', words);
    paint();
  }

  // ---- the buttons ----

  function lineWords() {
    if (R.state === 'recording') return WORDS.letGo;
    if (R.state === 'denied') return R.note || WORDS.denied;
    if (R.state === 'unsupported') return WORDS.unsupported;
    return R.note || '';
  }

  function wordFor() {
    if (R.state === 'recording') return `Talking ${fmtClock(Math.max(0, now() - R.startedAt))}`;
    if (R.state === 'asking') return R.granted ? WORDS.hold : WORDS.asking;
    if (R.state === 'sending') return WORDS.sending;
    if (R.talking && R.talking.words) return R.talking.words; // v1.4 PAGE-PLAY: a Wiretap piece
    if (R.talking) return talkingWords(R.talking.name || someone(R.side));
    return WORDS.hold;
  }

  function paint() {
    for (const b of [...buttons]) {
      if (b.wrap.isConnected) b.seen = true;
      else if (b.seen) { buttons.delete(b); continue; }
      b.wrap.dataset.state = R.state;
      cls(b.wrap, 'hearing', !!R.talking && R.state !== 'recording');
      cls(b.wrap, 'off', !R.on);
      text(b.word, wordFor());
      const line = R.on ? lineWords() : '';
      if (b.line.textContent !== line) text(b.line, line);
      b.line.hidden = !line;
      b.btn.disabled = !R.on || R.state === 'unsupported';
      b.btn.setAttribute('aria-pressed', R.state === 'recording' ? 'true' : 'false');
      b.btn.setAttribute('aria-label', R.state === 'recording'
        ? 'Walkie-talkie: recording. Let go to send.'
        : `Walkie-talkie: hold to talk to the ${R.side === 'hiders' ? 'hiders' : 'hunters'}`);
    }
  }

  function button({ big = false } = {}) {
    const word = h('span.radio-word', WORDS.hold);
    const btn = h('button.radio-btn', { type: 'button', 'aria-pressed': 'false' },
      h('span.radio-icon', icon('mic', big ? 34 : 22)), word);
    const line = h('p.radio-line', { role: 'status', 'aria-live': 'polite', hidden: true });
    const wrap = h(`div.radio${big ? '.radio-big' : ''}`, btn, line);
    const b = { wrap, btn, word, line, seen: false };
    buttons.add(b);

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* fine */ }
      press('pointer');
    });
    const up = () => release('pointer');
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press('key'); }
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release('key'); }
    });
    // A click with no hold before it (a screen reader's double tap): the first starts, the next one sends.
    btn.addEventListener('click', () => {
      if (now() - R.pressAt < 700) return;
      if (R.state === 'recording' && R.byClick) release('click');
      else press('click');
    });
    paint();
    return wrap;
  }

  // ---- recording ----

  function press(by) {
    if (R.dead || !R.on) return;
    R.pressAt = by === 'click' ? -Infinity : now();
    // (A touch's pointerdown isn't a tap to an iPhone: its release readies the sound instead.)
    if (by !== 'pointer') unlock();
    if (R.state === 'sending' || R.state === 'recording' || R.state === 'asking' || R.state === 'unsupported') return;
    R.holding = true;
    R.byClick = by === 'click';
    if (!R.stream) { ask(); return; }
    record();
  }

  function release(by) {
    if (by === 'pointer' || by === 'key') R.pressAt = now();
    unlock(); // a touch's release is a real tap (its pointerdown isn't, to an iPhone)
    if (!R.holding) return;
    if (R.byClick && by !== 'click') return;
    R.holding = false;
    if (R.state === 'recording') finish();
  }

  function ask() {
    setState('asking');
    let p;
    try {
      p = micFrom(); // v1.2 PAGE-RADIO
    } catch (e) {
      p = Promise.reject(e);
    }
    Promise.resolve(p).then((got) => {
      // v1.2 PAGE-RADIO: { stream, shared } from app.mic(), or a plain stream
      const shared = !!(got && got.stream && got.shared);
      const stream = got && got.stream ? got.stream : got;
      const dropStream = (s) => { if (!shared) dropOwn(s); };
      // v1.2 end PAGE-RADIO
      if (R.dead || !R.on) { dropStream(stream); if (!R.dead) setState('idle'); return; }
      const first = !R.granted;
      R.granted = true;
      if (!R.holding) {
        // Let go before the microphone came: nothing to record, and it isn't kept open.
        dropStream(stream);
        setState('idle');
        say(first ? WORDS.ready : WORDS.short);
        return;
      }
      R.stream = stream;
      R.shared = shared; // v1.2 PAGE-RADIO
      try {
        for (const t of stream.getTracks()) t.addEventListener?.('ended', () => { if (R.stream === stream) R.stream = null; });
      } catch { /* fine */ }
      setState('idle');
      record();
    }, (e) => {
      if (R.dead) return;
      R.holding = false;
      const name = e && e.name;
      if (name === 'NotFoundError' || name === 'NotSupportedError' || name === 'OverconstrainedError') {
        setState('idle');
        say(WORDS.unsupported, { error: true });
        return;
      }
      setState('denied');
      say(WORDS.denied, { stay: true, error: true });
    });
  }

  function record() {
    const type = pickType(Recorder);
    let rec;
    try {
      const opts = { audioBitsPerSecond: BITS };
      if (type) opts.mimeType = type;
      rec = new Recorder(R.stream, opts);
    } catch {
      try { rec = new Recorder(R.stream); } catch { rec = null; }
    }
    if (!rec) {
      R.holding = false;
      setState('unsupported');
      return;
    }
    pausePlayback();
    R.rec = rec;
    R.chunks = [];
    R.bytes = 0;
    R.slice = 0;
    rec.ondataavailable = (e) => {
      if (!e || !e.data || e.data.size === 0) return;
      R.chunks.push(e.data);
      const size = Number(e.data.size) || 0;
      R.bytes += size;
      R.slice = Math.max(R.slice, size);
      // Nearly as much as the server takes: sent now, rather than made too big to send.
      if (R.rec === rec && R.state === 'recording' && R.bytes + R.slice * 1.5 + SIZE_SLACK > LIMITS.radioBytes) {
        R.holding = false;
        R.full = true;
        finish();
      }
    };
    rec.onstop = () => stopped(rec, type);
    rec.onerror = () => { if (R.rec === rec) { R.discard = true; try { rec.stop(); } catch { stopped(rec, type); } } };
    R.discard = false;
    R.full = false;
    try {
      rec.start(SLICE_MS);
    } catch {
      R.rec = null;
      R.holding = false;
      setState('idle');
      say(WORDS.unsupported, { error: true });
      dropStream(R.stream);
      R.stream = null;
      R.shared = false;
      resumePlayback();
      return;
    }
    R.startedAt = now();
    R.note = '';
    setState('recording');
    const limit = maxHoldMs(R.bytesPerMs);
    R.autoTimer = setTimer(() => { if (R.state === 'recording') { R.holding = false; finish(); } }, limit);
    const tick = () => {
      R.tickTimer = null;
      if (R.state !== 'recording') return;
      paint();
      R.tickTimer = setTimer(tick, 250);
    };
    R.tickTimer = setTimer(tick, 250);
  }

  function finish() {
    const rec = R.rec;
    R.heldMs = Math.min(TIMING.RADIO_MAX_MS + 400, now() - R.startedAt);
    clearTimer(R.autoTimer);
    clearTimer(R.tickTimer);
    R.autoTimer = null;
    R.tickTimer = null;
    if (!rec) return;
    setState('sending');
    try { rec.stop(); } catch { stopped(rec, ''); }
  }

  // v1.4 PAGE-DEVICES: the shared stream was swapped (re-acquired after a drop) mid-message: what was said is sent as
  // it is (stopped() sends it when long enough), and the next hold uses the new stream.
  try {
    if (app && app.media && typeof app.media.on === 'function') {
      app.media.on('stream', () => { if (R.rec && R.shared && R.state !== 'sending') finish(); });
    }
  } catch { /* ignore */ }
  // v1.4 end PAGE-DEVICES

  function stopped(rec, type) {
    if (R.rec !== rec) return;
    R.rec = null;
    clearTimer(R.autoTimer);
    clearTimer(R.tickTimer);
    const ms = Math.round(R.heldMs || 0);
    const chunks = R.chunks;
    R.chunks = [];
    // Recorded: the microphone is let go of at once (asked for again, with no prompt, at the next hold).
    if (R.stream) { dropStream(R.stream); R.stream = null; R.shared = false; }
    if (R.discard || R.dead) {
      R.discard = false;
      if (!R.dead) { setState('idle'); resumePlayback(); }
      return;
    }
    if (ms < TIMING.RADIO_MIN_MS) {
      setState('idle');
      say(WORDS.short);
      resumePlayback();
      return;
    }
    const kind = baseType(rec.mimeType) || baseType(chunks[0] && chunks[0].type) || baseType(type);
    setState('sending');
    resumePlayback();
    send(chunks, kind, ms, R.side);
  }

  // `side`: the channel it was recorded on. The server refuses it if the team changed meanwhile (a hider
  // caught and turned while this was on its way must never be heard by the hunters).
  async function send(chunks, kind, ms, side) {
    try {
      const B = (win && win.Blob) || globalThis.Blob;
      const blob = new B(chunks, { type: kind || 'audio/mp4' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (R.dead) return;
      if (bytes.length) R.bytesPerMs = bytes.length / Math.max(1, ms);
      if (!kind || !bytes.length) { setState('idle'); say(WORDS.unsupported, { error: true }); return; }
      if (bytes.length > LIMITS.radioBytes) { setState('idle'); say(WORDS.tooLong, { error: true }); return; }
      if (side !== R.side) { setState('idle'); say(WORDS.notSent, { error: true }); return; }
      const res = await app.sendClip({ audio: toBase64(bytes), type: kind, ms: Math.max(300, Math.min(15500, ms)), side: side || undefined });
      if (R.dead) return;
      setState('idle');
      if (res && res.error) {
        const fromServer = !res.offline && res.status && res.status < 500 && res.code !== 'busy' && res.message;
        say(fromServer ? res.message : WORDS.notSent, { error: true });
        return;
      }
      if (res && Number.isInteger(res.n)) seen.add(res.n);
      say(R.full ? WORDS.full : WORDS.sent);
    } catch (e) {
      console.error(e);
      if (R.dead) return;
      setState('idle');
      say(WORDS.notSent, { error: true });
    }
  }

  function dropOwn(stream) {
    try { for (const t of stream.getTracks()) t.stop(); } catch { /* fine */ }
  }
  // v1.2 PAGE-RADIO: the camera's stream (shared) is only let go of, never stopped
  function dropStream(stream) {
    if (stream && stream === R.stream && R.shared) return;
    dropOwn(stream);
  }

  function letGoOfMic() {
    if (R.rec) {
      R.discard = true;
      try { R.rec.stop(); } catch { R.rec = null; }
    }
    R.holding = false;
    clearTimer(R.autoTimer);
    clearTimer(R.tickTimer);
    if (R.stream) { dropStream(R.stream); R.stream = null; R.shared = false; }
    if (R.state === 'recording' || R.state === 'asking') setState('idle');
  }

  // ---- playing ----

  function talking(t) {
    R.talking = t;
    ev.emit('talking', t);
    paint();
  }

  function busyMic() {
    return R.state === 'recording' || R.state === 'asking';
  }

  // Paused for this phone's own talking: the clip's "never ended" timer stops too, and goes on from where it was.
  function pausePlayback() {
    const c = R.current;
    if (!c || !c.playing) return;
    if (c.timer) {
      clearTimer(c.timer);
      c.timer = null;
      c.left = Math.max(0, c.deadline - now());
    }
    try { audio.el.pause(); } catch { /* fine */ }
  }

  function resumePlayback() {
    const c = R.current;
    if (c && c.playing) {
      if (!c.timer && c.left !== null && c.left !== undefined) {
        c.deadline = now() + c.left;
        c.timer = setTimer(c.done, c.left);
        c.left = null;
      }
      const a = audio.el;
      try { const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch { /* fine */ }
    } else {
      pump();
    }
  }

  // A clip that didn't download (a moment with no signal): asked for again a little later, a few times.
  function tryAgain(clip) {
    const tries = (R.tries.get(clip.n) || 0) + 1;
    R.tries.set(clip.n, tries);
    if (tries >= CLIP_TRIES) return false;
    const t = setTimer(() => {
      R.retries.delete(t);
      if (R.dead || !R.on) return;
      if (quietNow()) { keep(clip, false); return; } // v1.2 PAGE-RADIO
      const at = R.queue.findIndex((c) => c.n > clip.n);
      if (at < 0) R.queue.push(clip); else R.queue.splice(at, 0, clip);
      pump();
    }, RETRY_MS * 2 ** (tries - 1));
    R.retries.add(t);
    return true;
  }

  function pump() {
    clearTimer(R.pumpTimer);
    R.pumpTimer = null;
    if (R.dead || R.current || busyMic() || !R.queue.length) return;
    // The driver's voice is speaking: the clip waits for it (not for ever: some browsers never say it's done).
    let other = false;
    try { other = !!otherBusy(); } catch { other = false; }
    if (other) {
      if (R.waitSince === null) R.waitSince = now();
      if (now() - R.waitSince < SPEECH_WAIT_MS) {
        R.pumpTimer = setTimer(pump, LOOK_AGAIN_MS);
        return;
      }
    }
    R.waitSince = null;
    const clip = R.queue.shift();
    const token = ++R.token;
    const name = nameOf(clip.from);
    R.current = { clip, token, playing: false, timer: null, name };
    // v1.4 PAGE-PLAY: a Wiretap piece: "Listening to Ava" and its own beep
    const tapped = !!clip.tap;
    talking({ from: clip.from, name, n: clip.n, ...(tapped ? { tap: clip.tap, words: tapWords(nameOf(clip.of || clip.from)) } : {}) });
    try { alerts && alerts.beep && alerts.beep(tapped ? 'tap' : 'radio'); } catch { /* ignore */ }
    // v1.4 end PAGE-PLAY
    const wait = new Promise((r) => setTimer(r, BEEP_GAP_MS));
    let got;
    try { got = Promise.resolve(app.clip(clip.n)); } catch { got = Promise.resolve(null); }
    Promise.all([got.catch(() => null), wait]).then(([c]) => {
      if (!R.current || R.current.token !== token) return;
      if (!c || !c.url) {
        if (tryAgain(clip)) ended(token);
        else failed(token, notHereWords(name));
        return;
      }
      R.tries.delete(clip.n);
      const a = audio.el;
      if (!a) { failed(token, cantPlayWords(name)); return; }
      const done = () => ended(token);
      const bad = () => failed(token, cantPlayWords(name));
      a.onended = done;
      a.onerror = bad;
      R.current.playing = true;
      R.current.done = done;
      const span = (num(clip.ms) || TIMING.RADIO_MAX_MS) + PLAY_SLACK_MS;
      R.current.deadline = now() + span;
      R.current.left = null;
      R.current.timer = setTimer(done, span);
      try {
        a.src = c.url;
        if (busyMic()) { pausePlayback(); return; } // pressed during the beep: plays once the recording is done
        const p = a.play();
        if (p && typeof p.then === 'function') {
          p.catch((e) => {
            if (e && e.name === 'AbortError') return;
            if (e && e.name === 'NotAllowedError') blocked(token);
            else bad();
          });
        }
      } catch {
        bad();
      }
    });
  }

  function ended(token) {
    if (!R.current || R.current.token !== token) return;
    clearTimer(R.current.timer);
    const a = audio.el;
    if (a) { a.onended = null; a.onerror = null; }
    R.current = null;
    talking(null);
    pump();
  }

  function failed(token, words) {
    if (!R.current || R.current.token !== token) return;
    say(words, { error: true });
    ended(token);
  }

  // The browser won't play before a tap: the clip waits (first in line) and plays after the next tap.
  function blocked(token) {
    if (!R.current || R.current.token !== token) return;
    const clip = R.current.clip;
    clearTimer(R.current.timer);
    const a = audio.el;
    if (a) { a.onended = null; a.onerror = null; }
    R.current = null;
    R.token += 1;
    R.queue.unshift(clip);
    R.blocked = true;
    audio.reset(); // the silent sound didn't count: the next tap readies it again
    talking(null);
    say(WORDS.tap, { stay: true });
  }

  function stopPlayback() {
    R.queue = [];
    for (const t of R.retries) clearTimer(t);
    R.retries.clear();
    R.tries.clear();
    clearTimer(R.pumpTimer);
    R.pumpTimer = null;
    R.waitSince = null;
    if (R.current) {
      clearTimer(R.current.timer);
      const a = audio.el;
      if (a) { a.onended = null; a.onerror = null; try { a.pause(); } catch { /* fine */ } }
      R.current = null;
      R.token += 1;
    }
    if (R.talking) talking(null);
  }

  // ---- the API ----

  function take(view) {
    if (R.dead) return;
    const on = !!(view && view.phase === 'live' && view.radio && Array.isArray(view.radio.clips));
    if (!on) {
      if (R.on) {
        R.on = false;
        stopPlayback();
        letGoOfMic();
        dropHeld(); // v1.2 PAGE-RADIO
        paint();
      }
      return;
    }
    if (!R.on) { R.on = true; paint(); }
    // v1.2 PAGE-RADIO: the side (a caught hider who joins the hunters switches channels here)
    const side = sideOf(view.radio);
    if (side !== R.side) {
      const had = R.side;
      R.side = side;
      if (had) { stopPlayback(); letGoOfMic(); }
      dropHeld();
      ev.emit('side', side);
      paint();
      paintQuiet();
    }
    // v1.2 end PAGE-RADIO
    R.meId = view.me ? view.me.id : R.meId;
    const last = Number(view.radio.last);
    if (Number.isInteger(last) && last > R.last) R.last = last;
    for (const c of view.radio.clips) if (c && Number.isInteger(c.n) && c.n > R.last) R.last = c.n;
    const fresh = clipsToPlay(view, seen, R.meId);
    if (fresh.length) {
      // v1.2 PAGE-RADIO: Quiet: each new message waits (one short buzz each)
      if (quietNow()) { for (const c of fresh) keep(c, true); return; }
      R.queue.push(...fresh);
      pump();
    }
  }

  // ---- v1.2 PAGE-RADIO: Quiet and the messages waiting ----

  const quietNow = () => R.quiet && R.side === 'hiders';
  const quietButtons = new Set();
  const heldLists = new Set();

  function keep(clip, buzz) {
    const name = nameOf(clip.from);
    R.held = addHeld(R.held, { n: clip.n, from: clip.from, name, ms: num(clip.ms) || 0, clock: num(clip.clock) || 0, clip });
    if (buzz) {
      try { alerts && typeof alerts.buzz === 'function' && alerts.buzz(BUZZ_MS); } catch { /* ignore */ }
      say(heldWords(name, clip.ms));
    }
    heldChanged();
  }

  function dropHeld() {
    if (!R.held.length) return;
    R.held = [];
    heldChanged();
  }

  function heldChanged() {
    ev.emit('held', R.held.map(({ clip, ...x }) => x));
    paintQuiet();
  }

  function setQuiet(on) {
    const next = !!on;
    if (next === R.quiet) return;
    R.quiet = next;
    saveQuiet(store, next);
    if (next && R.side === 'hiders') {
      // Quiet now: the message playing stops and waits with the rest (stealth can't wait for the end of it).
      const back = [];
      if (R.current) back.push(R.current.clip);
      back.push(...R.queue);
      R.queue = [];
      if (R.current) {
        clearTimer(R.current.timer);
        const a = audio.el;
        if (a) { a.onended = null; a.onerror = null; try { a.pause(); } catch { /* fine */ } }
        R.current = null;
        R.token += 1;
        talking(null);
      }
      for (const c of back) keep(c, false);
    } else if (!next) {
      // Quiet off: everything that waited plays, in order, and the list empties.
      const list = R.held.map((x) => x.clip);
      R.held = [];
      R.queue.push(...list);
      heldChanged();
      pump();
    }
    ev.emit('quiet', next);
    paintQuiet();
  }

  // One by hand (from a tap): first in line, with Quiet still on.
  function playHeld(n) {
    const i = R.held.findIndex((x) => x.n === n);
    if (i < 0) return false;
    unlock();
    const [x] = R.held.splice(i, 1);
    R.queue.unshift(x.clip);
    heldChanged();
    pump();
    return true;
  }

  function crossedSpeaker(size) {
    const svg = icon('speaker', size, 'radio-quiet-off');
    try {
      while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild);
      const NS = 'http://www.w3.org/2000/svg';
      const d = (doc || globalThis.document);
      const x = d.createElementNS(NS, 'path');
      x.setAttribute('d', 'M16 9l5 6M21 9l-5 6');
      svg.appendChild(x);
    } catch { /* the plain speaker */ }
    return svg;
  }

  function quietButton() {
    const badge = h('span.tray-badge.radio-quiet-badge', { hidden: true, 'aria-hidden': 'true' });
    const btn = h('button.tray-sq.radio-quiet', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Quiet' },
      h('span.radio-quiet-icon', icon('speaker', 24, 'radio-quiet-on'), crossedSpeaker(24)),
      h('span.radio-quiet-word', 'Quiet'),
      badge);
    btn.addEventListener('click', () => { unlock(); setQuiet(!R.quiet); });
    const b = { btn, badge, seen: false };
    quietButtons.add(b);
    paintQuiet();
    return btn;
  }

  function heldList() {
    const hint = h('p.radio-held-hint', WORDS.earbuds);
    const state = h('p.radio-held-state');
    const list = h('ul.radio-held-list', { role: 'list', 'aria-label': 'Messages waiting' });
    const el = h('section.radio-held', { 'aria-label': "Hiders' walkie-talkie" },
      h('div.radio-held-head', icon('mic', 18), h('strong', "Hiders' walkie-talkie")), state, list, hint);
    const b = { el, state, list, key: '', seen: false };
    heldLists.add(b);
    paintQuiet();
    return el;
  }

  function paintQuiet() {
    const on = quietNow();
    const n = R.held.length;
    for (const b of [...quietButtons]) {
      if (b.btn.isConnected) b.seen = true;
      else if (b.seen) { quietButtons.delete(b); continue; }
      b.btn.setAttribute('aria-checked', R.quiet ? 'true' : 'false');
      b.btn.setAttribute('aria-label', n ? `Quiet, ${n} ${n === 1 ? 'message' : 'messages'} waiting` : 'Quiet');
      b.btn.dataset.on = R.quiet ? 'true' : 'false';
      text(b.badge, n ? String(n) : '');
      b.badge.hidden = !n;
    }
    for (const b of [...heldLists]) {
      if (b.el.isConnected) b.seen = true;
      else if (b.seen) { heldLists.delete(b); continue; }
      cls(b.el, 'quiet', on);
      const words = on ? WORDS.quietOn : WORDS.quietOff;
      if (b.state.textContent !== words) text(b.state, words);
      const key = R.held.map((x) => `${x.n}:${x.name}`).join(',');
      if (key === b.key) continue;
      b.key = key;
      b.list.hidden = !n;
      b.list.replaceChildren(...R.held.map((x) => {
        const words2 = heldWords(x.name, x.ms);
        const play = h('button.btn.small.radio-held-play', { type: 'button', 'aria-label': `Play: ${words2}` }, icon('play', 16), h('span', 'Play'));
        play.addEventListener('click', () => playHeld(x.n));
        return h('li.radio-held-row', h('span.radio-held-time', fmtClock(x.clock)), h('span.radio-held-words', words2), play);
      }));
    }
  }
  // v1.2 end PAGE-RADIO

  function unlock() {
    try { alerts && alerts.unlockBeep && alerts.unlockBeep(); } catch { /* ignore */ }
    audio.unlock(!!(R.current && R.current.playing));
    if (R.blocked) {
      R.blocked = false;
      if (R.note === WORDS.tap) say('');
      pump();
    }
  }

  function stop() {
    stopPlayback();
    letGoOfMic();
    R.blocked = false;
    R.on = false;
    R.last = 0;
    seen.clear();
    R.side = null;  // v1.2 PAGE-RADIO
    dropHeld();     // v1.2 PAGE-RADIO
    clearTimer(R.noteTimer);
    R.note = '';
    if (R.state === 'sending') setState('idle');
    paint();
  }

  function destroy() {
    stop();
    R.dead = true;
    try { if (offTap) offTap(); } catch { /* fine */ }
    buttons.clear();
    quietButtons.clear(); // v1.2 PAGE-RADIO
    heldLists.clear();    // v1.2 PAGE-RADIO
    ev.clear();
  }

  // Every real tap on the page readies the sound (until it works), not only the first pointerdown.
  let offTap = null;
  try { offTap = alerts && typeof alerts.onTap === 'function' ? alerts.onTap(() => { if (!R.dead) unlock(); }) : null; } catch { offTap = null; }

  // The phone's tab hidden: a hold can't be let go of where nobody sees it.
  try {
    doc && doc.addEventListener && doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden' && R.state === 'recording') { R.holding = false; finish(); }
    });
  } catch { /* fine */ }

  return {
    button,
    hold: () => press('pointer'),     // what the button does (also for tests): start, and let go to send
    letGo: () => release('pointer'),
    take,
    unlock,
    stop,
    destroy,
    on: ev.on,
    get state() { return R.state; },
    get talking() { return R.talking; },
    get last() { return R.last; },
    get queued() { return R.queue.length; },
    get unlocked() { return audio.unlocked; },
    // v1.2 PAGE-RADIO
    get side() { return R.side; },
    get quiet() { return R.quiet; },
    get held() { return R.held.map(({ clip, ...x }) => x); },
    setQuiet,
    playHeld,
    quietButton,
    heldList,
    // v1.2 end PAGE-RADIO
  };
}

// ---- the replay's walkie-talkie -------------------------------------------------------------------------------

// createReplayRadio({ app, getClock, onChange, makeAudio }) for over.js:
//   setClips(clips)          summary.radio's clips (replayClips)
//   enabled (get/set)        the "Walkie-talkie" switch
//   advance(fromS, toS, playing) -> snapS | null   each replay frame; a clip starting with nothing playing pulls
//                            the replay back to its start (so the call lines up with the routes)
//   busy()                   a clip playing (or on its way): the replay runs at real time
//   talking()                { n, from, name, clock } | null, for the caption
//   playNow(clip)            the list's Play (from a tap)
//   pause(), resume()        the replay's Pause and Play
//   cancel()                 a jump or a speed tap: the clip stops, the waiting ones go
//   rowState(n)              '' | 'playing' | 'failed:<words>'
//   unlock()                 from a tap
//   destroy()
export function createReplayRadio({
  app,
  getClock = () => 0,
  onChange = () => {},
  nameOf = () => 'A hunter',
  win = globalThis.window ?? null,
  makeAudio = () => new Audio(),
  now = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  const audio = unlocker(win, makeAudio);
  const fetched = new Map();   // n -> Promise<{url}|null>
  const rows = new Map();      // n -> words when it failed
  const done = new Set();      // clips started or waiting since the last cancel (never crossed twice)
  const Q = { clips: [], enabled: true, queue: [], current: null, token: 0, paused: false, dead: false };

  const changed = () => { try { onChange(); } catch (e) { console.error(e); } };

  function get(n) {
    if (!fetched.has(n)) {
      let p;
      try { p = Promise.resolve(app && app.clip ? app.clip(n) : null); } catch { p = Promise.resolve(null); }
      p = p.catch(() => null).then((c) => {
        if (!c) fetched.delete(n); // tried again next time it's needed
        return c;
      });
      fetched.set(n, p);
    }
    return fetched.get(n);
  }

  function prefetch(s) {
    if (!Q.enabled) return;
    let k = 0;
    for (const c of Q.clips) {
      if (c.clock / 1000 + c.ms / 1000 < s) continue;
      if (rows.has(c.n)) continue;
      get(c.n);
      k += 1;
      if (k >= AHEAD) break;
    }
  }

  function fail(n, words) {
    rows.set(n, words);
  }

  function start(clip) {
    const token = ++Q.token;
    const name = nameOf(clip.from) || someone(clip.side); // v1.2 PAGE-RADIO: 'A hider' for a hiders' clip
    Q.current = { clip, token, name, playing: false, timer: null };
    done.add(clip.n);
    changed();
    const waitTimer = setTimer(() => {
      if (Q.current && Q.current.token === token && !Q.current.playing) { fail(clip.n, notHereWords(name)); next(token); }
    }, FETCH_WAIT_MS);
    get(clip.n).then((c) => {
      clearTimer(waitTimer);
      if (!Q.current || Q.current.token !== token) return;
      if (!c || !c.url) { fail(clip.n, notHereWords(name)); next(token); return; }
      const a = audio.el;
      if (!a) { fail(clip.n, cantPlayWords(name)); next(token); return; }
      a.onended = () => next(token);
      a.onerror = () => { fail(clip.n, cantPlayWords(name)); next(token); };
      Q.current.playing = true;
      Q.current.done = () => next(token);
      const span = clip.ms + PLAY_SLACK_MS * 2;
      Q.current.left = null;
      if (Q.paused) Q.current.left = span; // the timer starts when the replay plays again
      else { Q.current.deadline = now() + span; Q.current.timer = setTimer(Q.current.done, span); }
      try {
        a.src = c.url;
        if (!Q.paused) {
          const p = a.play();
          if (p && p.catch) p.catch((e) => { if (!e || e.name !== 'AbortError') { fail(clip.n, cantPlayWords(name)); next(token); } });
        }
      } catch {
        fail(clip.n, cantPlayWords(name));
        next(token);
      }
    });
  }

  function next(token) {
    if (!Q.current || Q.current.token !== token) return;
    clearTimer(Q.current.timer);
    const a = audio.el;
    if (a) { a.onended = null; a.onerror = null; }
    Q.current = null;
    const now = getClock();
    while (Q.queue.length) {
      const c = Q.queue.shift();
      if (now - c.clock / 1000 > LATE_S) continue; // too late now: skipped (still in the list)
      start(c);
      return;
    }
    changed();
  }

  function cancel() {
    Q.queue = [];
    done.clear();
    if (Q.current) {
      clearTimer(Q.current.timer);
      const a = audio.el;
      if (a) { a.onended = null; a.onerror = null; try { a.pause(); } catch { /* fine */ } }
      Q.current = null;
      Q.token += 1;
      changed();
    }
  }

  return {
    setClips(clips) {
      const key = (clips || []).map((c) => c.n).join(',');
      if (key === Q.clips.map((c) => c.n).join(',')) return;
      cancel();
      Q.clips = (clips || []).slice();
    },
    get clips() { return Q.clips; },
    get enabled() { return Q.enabled; },
    set enabled(on) {
      Q.enabled = !!on;
      if (!Q.enabled) cancel();
      changed();
    },
    advance(fromS, toS, playing) {
      if (Q.dead) return null;
      prefetch(toS);
      if (!Q.enabled) return null;
      let snap = null;
      for (const c of clipPlan(Q.clips, fromS, toS, playing)) {
        if (done.has(c.n)) continue;
        if (!Q.current && !Q.queue.length) {
          start(c);
          snap = c.clock / 1000;
        } else {
          done.add(c.n);
          Q.queue.push(c);
        }
      }
      return snap;
    },
    busy: () => !!Q.current,
    // v1.2 PAGE-RADIO: side and the caption's words ("Ava (hiders) is talking" when both teams talked)
    talking: () => (Q.current ? {
      n: Q.current.clip.n, from: Q.current.clip.from, name: Q.current.name, clock: Q.current.clip.clock,
      side: sideOf(Q.current.clip),
      words: replayTalkingWords(Q.current.name, sideOf(Q.current.clip), Q.clips.some((c) => c.side === 'hiders')),
    } : null),
    playNow(clip) {
      cancel();
      Q.paused = false;
      rows.delete(clip.n);
      start(clip);
    },
    // Paused: the clip's "never ended" timer stops with it (a long pause never skips the clip), and goes on
    // from where it was on Play.
    pause() {
      Q.paused = true;
      const c = Q.current;
      if (c && c.playing) {
        if (c.timer) { clearTimer(c.timer); c.timer = null; c.left = Math.max(0, c.deadline - now()); }
        try { audio.el.pause(); } catch { /* fine */ }
      }
    },
    resume() {
      Q.paused = false;
      const c = Q.current;
      if (c && c.playing) {
        if (!c.timer && c.left !== null && c.left !== undefined) {
          c.deadline = now() + c.left;
          c.timer = setTimer(c.done, c.left);
          c.left = null;
        }
        try { const p = audio.el.play(); if (p && p.catch) p.catch(() => {}); } catch { /* fine */ }
      }
    },
    cancel,
    rowState(n) {
      if (Q.current && Q.current.clip.n === n) return 'playing';
      return rows.has(n) ? `failed:${rows.get(n)}` : '';
    },
    unlock() { audio.unlock(!!(Q.current && Q.current.playing)); },
    destroy() {
      cancel();
      Q.dead = true;
    },
  };
}

// The replay's walkie-talkie parts (over.js puts them in): a "Walkie-talkie" switch for the replay card, and a
// card listing every clip with Play.
//   replayRadioUi({ onSwitch(on), onPlay(clip) }) -> { switchRow, card, set(clips, nameOf, saved), paint(rr) }
export const NOT_SAVED = "The walkie-talkie wasn't saved for this game.";
export function replayRadioUi({ onSwitch = () => {}, onPlay = () => {} } = {}) {
  const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'true', 'aria-labelledby': 'over-radio-sw' });
  const switchRow = h('div.over-radio-switch', { hidden: true },
    h('span.over-radio-sw-label', icon('mic', 18), h('span#over-radio-sw', 'Walkie-talkie')),
    h('span.over-radio-sw-hint', 'Plays in real time'),
    sw);
  sw.addEventListener('click', () => {
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    onSwitch(on);
  });
  const title = h('h2#over-radio-title.label', 'Walkie-talkie');
  const note = h('p.over-hint.over-radio-note', { hidden: true });
  const list = h('ul.over-radio-list', { role: 'list' });
  // v1.4.4: a long game has 100+ clips: the first few show, the rest behind "Show all" (a playing one always shows)
  const FEW = 4;
  let open = false;
  const more = h('button.btn.small.wide.over-radio-more', { type: 'button', 'aria-expanded': 'false', hidden: true });
  const card = h('section.over-card.over-radio', { 'aria-labelledby': 'over-radio-title', hidden: true },
    h('div.over-card-head', title), note, list, more);
  let rows = [];
  function fold() {
    const many = rows.length > FEW + 1;
    more.hidden = !many;
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
    text(more, open ? 'Show fewer' : `Show all ${rows.length} clips`);
    rows.forEach((r, i) => { r.li.hidden = many && !open && i >= FEW && !r.li.classList.contains('playing'); });
  }
  more.addEventListener('click', () => {
    open = !open;
    fold();
    if (!open) { try { card.scrollIntoView({ block: 'nearest' }); } catch { /* fine */ } }
  });
  let key = '';

  function set(clips, nameOf = () => 'A hunter', saved = true) {
    const k = `${saved ? 1 : 0}|${clips.map((c) => `${c.n}:${c.from}:${c.clock}:${c.side || ''}`).join(',')}`;
    if (k === key) return;
    key = k;
    const both = clips.some((c) => c.side === 'hiders'); // v1.2 PAGE-RADIO
    switchRow.hidden = !clips.length;
    text(title, clips.length ? `Walkie-talkie (${clips.length})` : 'Walkie-talkie');
    note.hidden = !!saved;
    text(note, saved ? '' : NOT_SAVED);
    card.hidden = !clips.length && !!saved;
    rows = clips.map((c) => {
      const name = nameOf(c.from) || someone(c.side); // v1.2 PAGE-RADIO
      const line = clipLine(c, name);
      const state = h('span.over-radio-state');
      // v1.2 PAGE-RADIO: both teams' clips: each row says whose walkie-talkie
      const side = sideOf(c);
      const tag = both ? h(`span.over-radio-side.${side}`, sideLabel(side)) : null;
      const btn = h('button.btn.small.over-radio-play', { type: 'button', 'aria-label': `Play ${line}${both ? `, ${sideLabel(side)}` : ''}` }, icon('play', 16), h('span', 'Play'));
      btn.addEventListener('click', () => onPlay(c));
      const li = h(`li.over-radio-row${both ? `.side-${side}` : ''}`,
        h('span.over-radio-icon', { 'aria-hidden': 'true' }, icon('mic', 18)),
        h('div.over-radio-text', tag, h('span.over-radio-time', fmtClock(c.clock)), h('span.over-radio-who', `${name}, ${Math.max(1, Math.round(c.ms / 1000))} s`), state),
        btn);
      return { n: c.n, li, state };
    });
    list.replaceChildren(...rows.map((r) => r.li));
    fold();
  }

  function paint(rr) {
    for (const r of rows) {
      const st = rr ? rr.rowState(r.n) : '';
      const playing = st === 'playing';
      cls(r.li, 'playing', playing);
      cls(r.li, 'failed', st.startsWith('failed:'));
      const words = playing ? 'Playing' : st.startsWith('failed:') ? st.slice(7) : '';
      if (r.state.textContent !== words) text(r.state, words);
    }
    fold();
  }

  return { switchRow, card, set, paint, get on() { return sw.getAttribute('aria-checked') === 'true'; } };
}
