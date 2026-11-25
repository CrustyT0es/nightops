// Night Ops v1.2 (PAGE-CAM): the highlight cam. The selfie camera and microphone, opened once for a filmed player,
// recorded on the phone and kept there (camstore.js) until "Upload my clips" after the game.
//
//   const camera = createCamera({ app, alerts })   // null when this browser can't record video
//   camera.state     'off' | 'asking' | 'on' | 'denied' | 'unsupported' | 'full' | 'stopped' | 'done'
//   camera.start()   open the camera (from a tap, or on its own once the game screen shows)
//   camera.stopRecording()   "Stop filming" for the rest of this round (what's kept stays)
//   camera.stream()  the MediaStream while it's on (the walkie-talkie records from its audio: app.mic())
//   camera.mark(kind)  "Record this" ('mark'), or 'checkpoint' at the photo's tap: a moment at the game clock now
//   camera.take(view)  moments told by the server (n > app.camSince); starts / ends filming with the game
//   camera.held()    { count, bytes } of this round's clips on the phone (as last counted)
//   camera.on(name, fn)  'state' | 'clip' | 'error' -> off()
//   camera.stop()    a new round or leaving: recorders stopped (claimed ones saved), the camera let go
//
// Highlights: a recorder starts every CAM_ROLL_EVERY_MS and is thrown away at CAM_ROLL_KEEP_MS unless a moment
// claimed it; a claimed one runs until the moment + CAM_POST_MS (never past CAM_CLIP_MOST_MS) and is saved as one
// whole file (a recorder's first chunk holds the file's header, so chunks are never stitched across recorders).
// Everything: pieces of CAM_PIECE_MS, each next one started CAM_PIECE_OVERLAP_MS before the last ends.
// v1.4.7 (Highlights): talking near the phone is a moment too ('talk', talkStep below), with a cooldown and a cap.
import { TIMING, LIMITS } from '../shared/rules.js?v=183';
import { openCamStore, heldOf, PRUNE_MS } from './camstore.js?v=183';

export const CAM_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const VIDEO_BITS = 700000;
export const AUDIO_BITS = 64000;
export const STEP_MS = 500;           // how often the recorders' plan is looked at
export const LOUD_MS = 250;           // the microphone's loudness is measured this often (the loudest each second)
export const SHORTEST_MS = 1500;      // a recording shorter than this isn't kept
export const CONSTRAINTS = {
  video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
  // No echo cancellation (nor the other voice processing): while an echo-cancelled microphone is open, iPhones and
  // Android's call mode play every sound at call volume and Bluetooth earbuds drop to their hands-free profile, and
  // this one stays open all game (radio.js lets go of its own after each message for the same reason).
  audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
};
export const LATE_SLACK_MS = 1000;
const TICK_SLACK_MS = 50;    // a moment this far before a recorder's start still counts as in its file

const PRE = TIMING.CAM_PRE_MS;
const POST = TIMING.CAM_POST_MS;
const MOST = TIMING.CAM_CLIP_MOST_MS;
const EVERY = TIMING.CAM_ROLL_EVERY_MS;
const KEEP = TIMING.CAM_ROLL_KEEP_MS;
const PIECE = TIMING.CAM_PIECE_MS;
const OVERLAP = TIMING.CAM_PIECE_OVERLAP_MS;

export const WORDS = {
  tap: 'Tap to start your camera',
  asking: 'Starting the camera...',
  denied: 'Camera blocked',
  deniedLong: "Night Ops can't use the camera. Allow the camera and microphone for this site in your browser's settings, then tap again.",
  full: 'Your phone is full, so filming stopped.',
  filming: 'Filming',
  marked: 'Saving this moment.',
  stopped: 'Filming stopped for this game.',
};

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// ---- pure helpers (tested in Node) ----------------------------------------------------------------------------

export function pickType(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';
  for (const t of CAM_TYPES) {
    try { if (Recorder.isTypeSupported(t)) return t; } catch { /* next */ }
  }
  return '';
}

// 'video/mp4' | 'video/webm' | '' (the part before ';').
export function baseVideoType(t) {
  const b = String(t || '').split(';')[0].trim().toLowerCase();
  return b === 'video/mp4' || b === 'video/webm' ? b : '';
}

// Moments [{ clock, kind, ms? }] -> clip windows [{ from, to, kinds }] (game clock): each moment from clock - pre to
// (its end) + post; moments inside a window lengthen it, never past `most` from its start (the rest becomes the
// next window, which starts at its own moment's lead-in).
export function clipWindows(moments, { pre = PRE, post = POST, most = MOST } = {}) {
  const list = (Array.isArray(moments) ? moments : []).filter((m) => m && num(m.clock) !== null)
    .slice().sort((a, b) => a.clock - b.clock);
  const out = [];
  for (const m of list) {
    const from = Math.max(0, m.clock - pre);
    const until = m.clock + (num(m.ms) || 0) + post;
    const last = out[out.length - 1];
    if (last && m.clock <= last.to) {
      if (!last.kinds.includes(m.kind)) last.kinds.push(m.kind);
      const cap = last.from + most;
      if (until <= cap) {
        last.to = Math.max(last.to, until);
        continue;
      }
      last.to = cap;
      if (m.clock < cap && until - cap < 1000) continue;
      out.push({ from: Math.max(from, last.from + 1), to: Math.min(until, Math.max(from, last.from + 1) + most), kinds: [m.kind] });
      continue;
    }
    out.push({ from, to: Math.min(until, from + most), kinds: [m.kind] });
  }
  return out;
}

// The rolling recorders' plan (Highlights). rs = { recs: [{ id, at, claim: null | { until, kinds } }], next, seq,
// ending }; t = the phone's time (ms); moments = [{ at, until, kind }] in the phone's time (until = the end of a
// walkie message, else at). -> { rs, actions: [{ do: 'start' | 'save' | 'drop', id, kinds? }] }
export function newRoll() {
  return { recs: [], next: 0, seq: 0, ending: false };
}

export function rollStep(rs0, { t, moments = [], ending = false, every = EVERY, keep = KEEP, pre = PRE, post = POST, most = MOST } = {}) {
  const rs = { ...rs0, recs: rs0.recs.map((r) => ({ ...r, claim: r.claim ? { ...r.claim, kinds: r.claim.kinds.slice() } : null })) };
  const actions = [];
  if (ending) rs.ending = true;
  const start = () => {
    rs.seq += 1;
    const r = { id: `r${rs.seq}`, at: t, claim: null };
    rs.recs.push(r);
    actions.push({ do: 'start', id: r.id });
    return r;
  };
  if (!rs.ending && t >= rs.next) {
    start();
    rs.next = t + every;
  }
  for (const m of moments) {
    if (!m || num(m.at) === null) continue;
    const until = (num(m.until) !== null ? Math.max(m.until, m.at) : m.at) + post;
    if (m.kind === 'over') rs.ending = true;
    // A clip still going takes it (as far as its most allows).
    // (Only a clip whose file holds the moment: one that started after it, a moment told late, doesn't.)
    const going = rs.recs.filter((r) => r.claim && m.at <= r.claim.until && r.at <= m.at + LATE_SLACK_MS)
      .sort((a, b) => b.at - a.at)[0];
    let leftUntil = until;
    if (going) {
      if (!going.claim.kinds.includes(m.kind)) going.claim.kinds.push(m.kind);
      const cap = going.at + most;
      going.claim.until = Math.min(cap, Math.max(going.claim.until, until));
      if (until <= cap) continue;
      leftUntil = until;
    }
    // Else (or for what's past its most) the newest free recorder that started early enough, else the oldest
    // free one (a shorter lead-in), else one started now.
    const free = rs.recs.filter((r) => !r.claim).sort((a, b) => a.at - b.at);
    const early = free.filter((r) => r.at <= m.at - pre);
    let r = early.length ? early[early.length - 1] : free[0];
    if (going && r && r.at <= going.at) r = free.find((x) => x.at > going.at) || null;
    if (!r) {
      // Nothing free: a recorder started now only holds the moment if it's happening now.
      if (m.at + LATE_SLACK_MS < t) continue;
      r = start();
    }
    // Told too late: every recorder started after it, so no file shows it (never a clip labelled with it).
    if (r.at > m.at + LATE_SLACK_MS) continue;
    r.claim = { until: Math.min(r.at + most, leftUntil), kinds: [m.kind] };
  }
  const keepRecs = [];
  for (const r of rs.recs) {
    if (r.claim) {
      if (t >= r.claim.until || t >= r.at + most) actions.push({ do: 'save', id: r.id, kinds: r.claim.kinds.slice() });
      else keepRecs.push(r);
    } else if (t - r.at >= keep || rs.ending) {
      actions.push({ do: 'drop', id: r.id });
    } else {
      keepRecs.push(r);
    }
  }
  rs.recs = keepRecs;
  return { rs, actions };
}

// Everything: ps = { recs: [{ id, at, kinds }], next, seq, endAt }; the 'over' moment sets endAt (its time +
// post); then every piece is saved and none started.
export function newPieces() {
  return { recs: [], next: 0, seq: 0, endAt: null };
}

export function pieceStep(ps0, { t, moments = [], piece = PIECE, overlap = OVERLAP, post = POST, stopNow = false } = {}) {
  const ps = { ...ps0, recs: ps0.recs.map((r) => ({ ...r, kinds: r.kinds.slice() })) };
  const actions = [];
  for (const m of moments) {
    if (!m || num(m.at) === null) continue;
    if (m.kind === 'over' && ps.endAt === null) ps.endAt = m.at + post;
    for (const r of ps.recs) if (m.at >= r.at && !r.kinds.includes(m.kind)) r.kinds.push(m.kind);
  }
  const ending = stopNow || (ps.endAt !== null && t >= ps.endAt);
  if (!ending && t >= ps.next) {
    ps.seq += 1;
    const r = { id: `p${ps.seq}`, at: t, kinds: [] };
    ps.recs.push(r);
    actions.push({ do: 'start', id: r.id });
    ps.next = t + piece - overlap;
    // A moment that happened this very step belongs to the new piece too.
    for (const m of moments) if (m && m.at === t && !r.kinds.includes(m.kind)) r.kinds.push(m.kind);
  }
  const left = [];
  for (const r of ps.recs) {
    if (ending || t >= r.at + piece) actions.push({ do: 'save', id: r.id, kinds: ['piece', ...r.kinds] });
    else left.push(r);
  }
  ps.recs = left;
  return { ps, actions };
}

// -60 dBFS -> 0, 0 dBFS -> 100.
export function loudOf(rms) {
  const r = num(rms);
  if (r === null || r <= 0) return 0;
  const db = 20 * Math.log10(r);
  return Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
}

// Mean luma of RGBA pixels, 0..100.
export function lumaOf(data) {
  if (!data || !data.length) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n += 1;
  }
  return n ? Math.max(0, Math.min(100, Math.round((sum / n / 255) * 100))) : 0;
}

export function newClipId(cryptoObj = globalThis.crypto) {
  const b = new Uint8Array(8);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') cryptoObj.getRandomValues(b);
  else for (let i = 0; i < 8; i += 1) b[i] = Math.floor(Math.random() * 256);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Per-second lists fitted to the file's length: ceil(ms / 1000) entries, clocks never going down.
export function fitSeconds({ ms, clocks, loud, bright, end }) {
  const want = Math.max(1, Math.ceil(ms / 1000));
  const fit = (list, pad) => {
    const out = (Array.isArray(list) ? list : []).slice(0, want);
    while (out.length < want) out.push(pad(out));
    return out;
  };
  let c = fit(clocks, (o) => (o.length ? Math.min(end, o[o.length - 1] + 1000) : 0)).map((x) => Math.max(0, Math.round(x)));
  for (let i = 1; i < c.length; i += 1) if (c[i] < c[i - 1]) c[i] = c[i - 1];
  c = c.map((x) => Math.min(x, end));
  for (let i = 1; i < c.length; i += 1) if (c[i] < c[i - 1]) c[i] = c[i - 1];
  const pct = (x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0)));
  return {
    clocks: c,
    loud: fit(loud, (o) => (o.length ? o[o.length - 1] : 0)).map(pct),
    bright: fit(bright, (o) => (o.length ? o[o.length - 1] : 50)).map(pct),
  };
}

// The page's own look at a clip before asking to upload it (the server checks it again, fully).
export function clipShape(c, { mode = 'highlights' } = {}) {
  if (!c || !/^[0-9a-f]{16}$/.test(String(c.id))) return false;
  if (!baseVideoType(c.type)) return false;
  const most = mode === 'everything' ? PIECE + OVERLAP + 5000 : MOST + 5000;
  if (!Number.isInteger(c.ms) || c.ms < 1000 || c.ms > most) return false;
  if (!Number.isInteger(c.bytes) || c.bytes < 1) return false;
  if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end < c.start) return false;
  const want = Math.ceil(c.ms / 1000);
  const ok = (l) => Array.isArray(l) && l.length >= Math.max(1, want - 2) && l.length <= want + 2;
  return ok(c.clocks) && ok(c.loud) && ok(c.bright) && Array.isArray(c.kinds) && c.kinds.length >= 1 && c.kinds.length <= 12;
}

// What the server keeps of a clip (cam-upload's `clip`).
export function uploadMeta(rec) {
  const out = {
    id: rec.id, round: rec.round, type: baseVideoType(rec.type), bytes: rec.bytes, ms: rec.ms, start: rec.start,
    end: rec.end, kinds: rec.kinds.slice(0, 12), clocks: rec.clocks, loud: rec.loud, bright: rec.bright,
  };
  // v1.4 PAGE-DEVICES: the clock at the file's first frame, and the loudness every 250 ms (clips made before v1.4
  // have neither)
  if (Number.isInteger(rec.t0) && rec.t0 >= rec.start - 2000 && rec.t0 <= rec.start + 2000) out.t0 = rec.t0;
  if (Array.isArray(rec.loudQ) && rec.loudQ.length) out.loudQ = rec.loudQ;
  // v1.4 end PAGE-DEVICES
  return out;
}

// v1.4 PAGE-DEVICES: per-250 ms loudness fitted to the file's length (ceil(ms / 250) entries, 0..100).
export const LOUDQ_MS = 250;
export function fitQuarters(list, ms) {
  const want = Math.max(1, Math.ceil(ms / LOUDQ_MS));
  const out = (Array.isArray(list) ? list : []).slice(0, want).map((x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0))));
  while (out.length < want) out.push(out.length ? out[out.length - 1] : 0);
  return out;
}
// The file's first frame on the game clock: the clock at the recorder's 'start', moved on by the first chunk's
// timecode where the browser gives a sensible one (else 0). Kept within 2 s of `start` (the server's rule).
export function firstFrameClock({ startClock, timecodeMs = 0, start }) {
  const base = Number.isFinite(startClock) ? startClock : start;
  const lat = Number.isFinite(timecodeMs) && timecodeMs > 0 && timecodeMs < 1500 ? timecodeMs : 0;
  const t0 = Math.round(base + lat);
  return Math.max(start - 2000, Math.min(start + 2000, t0));
}
// v1.4 end PAGE-DEVICES

// v1.4.7: talking counts as a moment (Highlights). Fed every LOUD_MS with the microphone's loudness (loudOf):
// when at least TALK_NEED_MS of the last TALK_WINDOW_MS is over TALK_LEVEL (talking, shouting, laughing near the
// phone), one 'talk' moment from the first loud sample to now; then nothing for TALK_COOLDOWN_MS, at most
// TALK_MOST a round, and none once this round's clips on the phone reach TALK_BUDGET bytes (a talk clip is ~35 s,
// ~3.5 MB; the rest of camPlayerBytes.highlights stays for tags, close calls and the walkie-talkie). While the
// walkie-talkie records or plays (`busy`) nothing counts: its own 'radio' moment keeps that clip.
// ts = { loud: [times over the level], last: time of the last moment | null, count }
export const TALK_LEVEL = 45;           // about -33 dBFS: a voice at arm's length, not wind or footsteps
export const TALK_NEED_MS = 1500;
export const TALK_WINDOW_MS = 4000;
export const TALK_COOLDOWN_MS = 90000;
export const TALK_MOST = 10;
export const TALK_BUDGET = 75000000; // (fixed: the per-player cap went up to 2 GB on the Pro plan, but filming stays as it was)

export function newTalk() {
  return { loud: [], last: null, count: 0 };
}

export function talkStep(ts0, { t, level, busy = false, held = 0, budget = TALK_BUDGET, step = LOUD_MS, need = TALK_NEED_MS,
  window = TALK_WINDOW_MS, cooldown = TALK_COOLDOWN_MS, most = TALK_MOST, threshold = TALK_LEVEL } = {}) {
  const ts = { ...ts0, loud: ts0.loud.filter((x) => x > t - window) };
  if (busy) { ts.loud = []; return { ts, moment: null }; }
  if (num(level) !== null && level >= threshold) ts.loud.push(t);
  if (ts.count >= most) return { ts, moment: null };
  if (num(held) !== null && held >= budget) return { ts, moment: null };
  if (ts.last !== null && t - ts.last < cooldown) return { ts, moment: null };
  if (ts.loud.length * step < need) return { ts, moment: null };
  const at = ts.loud[0];
  ts.last = t;
  ts.count += 1;
  ts.loud = [];
  return { ts, moment: { at, until: t, kind: 'talk' } };
}

// ---- the camera -----------------------------------------------------------------------------------------------

export function createCamera({
  app,
  alerts = null,
  doc = globalThis.document,
  win = globalThis.window,
  Recorder = globalThis.MediaRecorder,
  media = globalThis.navigator ? globalThis.navigator.mediaDevices : null,
  store = null,
  now = () => (globalThis.performance ? performance.now() : Date.now()),
  wall = () => Date.now(),
  timers = { set: (fn, ms) => setInterval(fn, ms), clear: (id) => clearInterval(id) },
  shared = app && app.media ? app.media : null, // v1.4 PAGE-DEVICES: the one shared stream (media.js)
} = {}) {
  if (typeof Recorder !== 'function' || !media || typeof media.getUserMedia !== 'function') return null;
  const type = pickType(Recorder);
  if (!type) return null;
  let camStore = store;
  const getStore = () => {
    if (!camStore) camStore = openCamStore();
    return camStore;
  };

  const fns = new Map();
  const emit = (name, ...a) => {
    for (const fn of [...(fns.get(name) || [])]) {
      try { fn(...a); } catch (e) { console.error(e); }
    }
  };
  const S = {
    state: 'off',
    stream: null,
    key: null,          // `${code}:${round}` of the round being filmed
    code: '', round: null, pid: '', mode: 'highlights',
    want: false,        // live and filmed: the camera should run
    ending: false,
    stoppedKey: null,   // "Stop filming" for this round
    plan: null,         // newRoll() / newPieces()
    live: new Map(),    // plan id -> a running recording
    queue: [],          // moments waiting for the next step
    taken: 0,           // newest moment n taken
    stepId: null, loudId: null,
    sample: { loud: 0, bright: 50 },
    loudMax: 0,
    held: { count: 0, bytes: 0, left: 0, leftBytes: 0 },
    video: null, canvas: null, ctx2d: null, audio: null, analyser: null, buf: null,
    pruned: false,
    asked: null,
    talk: newTalk(),    // v1.4.7
  };

  function setState(s) {
    if (S.state === s) return;
    S.state = s;
    emit('state', s);
  }

  function clockNow() {
    try {
      const c = app && typeof app.gameClock === 'function' ? app.gameClock() : null;
      return num(c) !== null ? Math.max(0, Math.round(c)) : null;
    } catch { return null; }
  }

  // ---- the stream and its measurements ----

  // A stream iOS or Android ended or interrupted (a call, Siri, the Camera app, a lock) is no use any more.
  function alive(stream) {
    try {
      const tracks = stream.getTracks();
      return tracks.length > 0 && tracks.every((tr) => tr.readyState !== 'ended' && tr.muted !== true);
    } catch { return false; }
  }

  function watchTracks(stream) {
    let tracks = [];
    try { tracks = stream.getTracks(); } catch { /* none */ }
    for (const tr of tracks) {
      if (!tr || typeof tr.addEventListener !== 'function') continue;
      tr.addEventListener('ended', () => { if (S.stream === stream) lost(true); });
      // Muted (the capture interrupted): what's claimed is saved and REC goes off; it comes back on its own.
      tr.addEventListener('mute', () => { if (S.stream === stream) lost(false); });
      tr.addEventListener('unmute', () => {
        if (S.stream === stream && alive(stream) && S.want && S.stoppedKey !== S.key && !S.hidden) begun();
      });
    }
  }

  // The camera stopped under us: the recorders stop (claimed clips saved), the REC dot goes, and the chip shows.
  function lost(ended) {
    stopAll(true);
    if (ended) letGo();
    if (S.state === 'on' || S.state === 'asking') setState('off');
  }

  async function open(byTap = false) {
    if (S.stream && alive(S.stream)) return S.stream;
    if (S.stream) letGo();
    if (S.asked) return S.asked;
    setState('asking');
    S.asked = (async () => {
      try {
        // v1.4 PAGE-DEVICES: the shared stream (asked for by media.js; a tap here is media.restore())
        let stream;
        if (shared) {
          const held = shared.stream();
          stream = held && alive(held) && held.getVideoTracks().length ? held : (byTap ? await shared.restore() : await shared.get());
          if (!stream) {
            setState(shared.state.cam === 'denied' ? 'denied' : 'off');
            return null;
          }
        } else stream = await media.getUserMedia(CONSTRAINTS);
        // v1.4 end PAGE-DEVICES
        if (!S.want) {
          if (!shared) for (const tr of stream.getTracks()) try { tr.stop(); } catch { /* ignore */ }
          setState('off');
          return null;
        }
        S.stream = stream;
        watchTracks(stream);
        // Clips wait on the phone until after the game: ask once that the browser doesn't clear them for room.
        if (!S.persisted) {
          S.persisted = true;
          try {
            const st = globalThis.navigator && navigator.storage;
            if (st && typeof st.persist === 'function') st.persist().catch(() => {});
          } catch { /* not here */ }
        }
        measure(stream);
        setState('on');
        return stream;
      } catch (e) {
        const name = e && e.name;
        setState(name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied' : 'off');
        emit('error', e);
        return null;
      } finally {
        S.asked = null;
      }
    })();
    return S.asked;
  }

  function measure(stream) {
    try {
      if (doc && typeof doc.createElement === 'function') {
        // A tiny live copy of the picture (kept in the page: iPhones stop videos that are hidden) for brightness.
        const v = doc.createElement('video');
        v.muted = true;
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.playsInline = true;
        v.className = 'cam-sampler';
        v.setAttribute('aria-hidden', 'true');
        v.srcObject = stream;
        (doc.body || doc.documentElement).appendChild(v);
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
        S.video = v;
        const c = doc.createElement('canvas');
        c.width = 32;
        c.height = 24;
        S.canvas = c;
        S.ctx2d = c.getContext('2d', { willReadFrequently: true });
      }
    } catch (e) { console.error(e); }
    try {
      const AC = (win && (win.AudioContext || win.webkitAudioContext)) || null;
      if (AC && stream.getAudioTracks().length) {
        const ac = new AC();
        const src = ac.createMediaStreamSource(stream);
        const an = ac.createAnalyser();
        an.fftSize = 1024;
        src.connect(an);
        S.audio = ac;
        S.analyser = an;
        S.buf = new Float32Array(an.fftSize);
        if (ac.state === 'suspended' && ac.resume) ac.resume().catch(() => {});
      }
    } catch (e) { console.error(e); }
  }

  function readLoud() {
    if (!S.analyser) return;
    try {
      S.analyser.getFloatTimeDomainData(S.buf);
      let s = 0;
      for (let i = 0; i < S.buf.length; i += 1) s += S.buf[i] * S.buf[i];
      const lv = loudOf(Math.sqrt(s / S.buf.length));
      S.loudMax = Math.max(S.loudMax, lv);
      for (const rec of S.live.values()) rec.loudQ.push(lv); // v1.4 PAGE-DEVICES
      // v1.4.7: talking near the phone keeps the rolling clip (Highlights only; never while filming is ending)
      if (S.mode === 'highlights' && S.plan && !S.ending && !S.plan.ending) {
        const t = now();
        const r = talkStep(S.talk, { t, level: lv, busy: walkieBusy(), held: S.held.bytes });
        S.talk = r.ts;
        if (r.moment) {
          const c = clockNow();
          if (c !== null) S.queue.push({ clock: c - (t - r.moment.at), kind: 'talk', local: r.moment });
        }
      }
    } catch { /* ignore */ }
  }

  // v1.4.7: the walkie-talkie recording or playing (its words aren't someone talking near this phone)
  function walkieBusy() {
    try {
      const r = app && app.radio;
      return !!(r && (r.talking || r.state === 'recording'));
    } catch { return false; }
  }

  function readBright() {
    if (!S.ctx2d || !S.video || S.video.readyState < 2) return S.sample.bright;
    try {
      S.ctx2d.drawImage(S.video, 0, 0, 32, 24);
      return lumaOf(S.ctx2d.getImageData(0, 0, 32, 24).data);
    } catch { return S.sample.bright; }
  }

  function letGo() {
    if (S.stream && !shared) for (const tr of S.stream.getTracks()) try { tr.stop(); } catch { /* ignore */ } // v1.4: never the shared one
    S.stream = null;
    if (S.video) { try { S.video.srcObject = null; S.video.remove(); } catch { /* ignore */ } }
    S.video = null;
    if (S.audio) { try { S.audio.close(); } catch { /* ignore */ } }
    S.audio = null;
    S.analyser = null;
  }

  // ---- recordings ----

  function begin(planId) {
    if (!S.stream) return;
    const clock = clockNow();
    const rec = {
      planId, chunks: [], t0: now(), clock0: clock === null ? 0 : clock, clocks: [], loud: [], bright: [],
      r: null, drop: false, done: false, mime: type,
      startClock: null, timecode: null, loudQ: [], // v1.4 PAGE-DEVICES
    };
    try {
      const r = new Recorder(S.stream, { mimeType: type, videoBitsPerSecond: VIDEO_BITS, audioBitsPerSecond: AUDIO_BITS });
      r.ondataavailable = (e) => {
        if (rec.timecode === null && e && Number.isFinite(e.timecode)) rec.timecode = e.timecode; // v1.4 PAGE-DEVICES
        if (!rec.drop && e && e.data && e.data.size) rec.chunks.push(e.data);
      };
      // v1.4 PAGE-DEVICES: the clock at the recorder's start (t0), and an error saves what's there and asks again
      r.onstart = () => { if (rec.startClock === null) { const c = clockNow(); rec.startClock = c === null ? rec.clock0 : c; } };
      const recStream = S.stream;
      r.onerror = (e) => {
        emit('error', e && e.error ? e.error : e);
        if (S.stream !== recStream) return; // a recorder of a stream already replaced: nothing to do
        if (S.recErrored) return;
        S.recErrored = true;
        stopAll(true);
        letGo();
        if (S.state === 'on') setState('off');
        if (shared) shared.reacquire('recorder');
        if (S.want && !S.hidden) setTimeout(() => { if (!S.plan && S.state !== 'full') begun(); }, 1500);
      };
      // v1.4 end PAGE-DEVICES
      rec.r = r;
      if (r.mimeType) rec.mime = r.mimeType;
      r.start(1000);
    } catch (e) {
      emit('error', e);
      return;
    }
    rec.clocks.push(rec.clock0);
    rec.loud.push(S.sample.loud);
    rec.bright.push(S.sample.bright);
    S.live.set(planId, rec);
  }

  function end(planId, kinds) {
    const rec = S.live.get(planId);
    if (!rec) return;
    S.live.delete(planId);
    if (!kinds) rec.drop = true;
    const t1 = now();
    const clock1 = clockNow();
    const r = rec.r;
    const finish = () => {
      if (rec.done) return;
      rec.done = true;
      if (rec.drop) { rec.chunks = []; return; }
      save(rec, kinds, t1, clock1).catch((e) => emit('error', e));
    };
    try {
      if (r && r.state !== 'inactive') {
        r.onstop = finish;
        r.stop();
        setTimeout(finish, 3000); // a recorder that never says it stopped
      } else finish();
    } catch { finish(); }
  }

  async function save(rec, kinds, t1, clock1) {
    const ms = Math.round(t1 - rec.t0);
    if (ms < SHORTEST_MS || !rec.chunks.length) return;
    const B = (win && win.Blob) || globalThis.Blob;
    const vtype = baseVideoType(rec.mime) || baseVideoType(type) || 'video/webm';
    const blob = new B(rec.chunks, { type: vtype });
    rec.chunks = [];
    const start = Math.max(0, Math.round(rec.clock0));
    const endClock = Math.max(start, Math.round(clock1 === null ? start + ms : clock1));
    const fitted = fitSeconds({ ms, clocks: rec.clocks, loud: rec.loud, bright: rec.bright, end: endClock });
    // v1.4 PAGE-DEVICES
    fitted.t0 = firstFrameClock({ startClock: rec.startClock === null ? rec.clock0 : rec.startClock, timecodeMs: rec.timecode, start });
    fitted.loudQ = fitQuarters(rec.loudQ, ms);
    // v1.4 end PAGE-DEVICES
    const clip = {
      id: newClipId(), code: S.code, round: S.round, pid: S.pid, mode: S.mode, type: vtype,
      bytes: blob.size, ms, start, end: endClock, kinds: [...new Set(kinds)].slice(0, 12), ...fitted,
      blob, sent: false, savedAt: wall(),
    };
    const full = (e) => !!(e && (e.name === 'QuotaExceededError' || e.code === 22));
    try {
      try {
        await getStore().put(clip);
      } catch (e) {
        // No room: clips already uploaded (an earlier game's) make room first, then once more.
        if (!full(e) || typeof getStore().freeSent !== 'function' || !(await getStore().freeSent().catch(() => 0))) throw e;
        await getStore().put(clip);
      }
    } catch (e) {
      if (full(e)) {
        setState('full');
        try { alerts && alerts.banner && alerts.banner(WORDS.full, 'warn', 7000); } catch { /* ignore */ }
        try { app && app.banner && app.banner(WORDS.full, 'warn', 7000); } catch { /* ignore */ }
        stopAll(false);
        letGo();
      }
      emit('error', e);
      return;
    }
    S.held = { ...S.held, count: S.held.count + 1, bytes: S.held.bytes + clip.bytes };
    emit('clip', { ...clip, blob: undefined });
  }

  // ---- the plan, every STEP_MS ----

  function toLocal(m) {
    const t = now();
    const c = clockNow();
    const at = c === null ? t : t - Math.max(0, c - m.clock);
    return { at, until: at + (num(m.ms) || 0), kind: m.kind };
  }

  function step() {
    if (!S.plan) return;
    // v1.4 PAGE-DEVICES: the shared stream went away under us: save what's claimed and wait for media.js's new one
    // (never end the round's filming for it)
    if (shared && !S.stream && !S.ending) {
      stopAll(true);
      if (S.state === 'on') setState('off');
      return;
    }
    const t = now();
    const moments = S.queue.splice(0).map((m) => (m.local ? m.local : toLocal(m)));
    let actions;
    if (S.mode === 'everything') {
      const r = pieceStep(S.plan, { t, moments, stopNow: !S.stream });
      S.plan = r.ps;
      actions = r.actions;
    } else {
      const r = rollStep(S.plan, { t, moments, ending: S.ending || !S.stream });
      S.plan = r.rs;
      actions = r.actions;
    }
    for (const a of actions) {
      if (a.do === 'start') begin(a.id);
      else if (a.do === 'save') end(a.id, a.kinds);
      else end(a.id, null);
    }
    const idle = S.mode === 'everything' ? S.plan.recs.length === 0 && S.plan.endAt !== null && t >= S.plan.endAt
      : S.plan.recs.length === 0 && S.plan.ending;
    if (idle) finishRound('done');
  }

  // One entry per second of each file: clocks[i] is the game clock at file second i (this one timer isn't lined up
  // with each recorder's start, so the clock is taken back to that second).
  function tickSecond() {
    S.sample = { loud: S.loudMax, bright: readBright() };
    S.loudMax = 0;
    const c = clockNow();
    const t = now();
    for (const rec of S.live.values()) secondsUpTo(rec, t, c);
  }

  function secondsUpTo(rec, t, c) {
    while (rec.t0 + rec.clocks.length * 1000 <= t + TICK_SLACK_MS) {
      const prev = rec.clocks.length ? rec.clocks[rec.clocks.length - 1] : rec.clock0;
      const back = t - (rec.t0 + rec.clocks.length * 1000);
      rec.clocks.push(c === null ? prev : Math.max(prev, Math.round(c - back)));
      rec.loud.push(S.sample.loud);
      rec.bright.push(S.sample.bright);
    }
  }

  let secondId = null;
  function run() {
    if (S.stepId) return;
    S.plan = S.mode === 'everything' ? newPieces() : newRoll();
    S.talk = { ...S.talk, loud: [] }; // (the round's count and cooldown go on across a hidden page or a new stream)
    S.stepId = timers.set(step, STEP_MS);
    S.loudId = timers.set(readLoud, LOUD_MS);
    secondId = timers.set(tickSecond, 1000);
    step();
  }

  function halt() {
    if (S.stepId) timers.clear(S.stepId);
    if (S.loudId) timers.clear(S.loudId);
    if (secondId) timers.clear(secondId);
    S.stepId = null;
    S.loudId = null;
    secondId = null;
  }

  // Stop every recorder: the claimed ones (and Everything's pieces) are saved when `keep`, the rest dropped.
  function stopAll(keep) {
    const plan = S.plan;
    for (const [planId] of [...S.live]) {
      let kinds = null;
      if (keep && plan) {
        const p = plan.recs.find((r) => r.id === planId);
        if (S.mode === 'everything' && p) kinds = ['piece', ...p.kinds];
        else if (p && p.claim) kinds = p.claim.kinds;
      }
      end(planId, kinds);
    }
    S.plan = null;
    halt();
  }

  function finishRound(state) {
    stopAll(true);
    letGo();
    setState(state);
  }

  async function begun(byTap = false) {
    if (!S.want || S.stoppedKey === S.key || S.hidden) return;
    const stream = await open(byTap);
    if (stream && S.want && !S.hidden) {
      if (S.state !== 'on') setState('on');
      S.recErrored = false; // v1.4 PAGE-DEVICES
      run();
    }
  }

  // The page going to the background: iOS may close it there, so what's being filmed is saved now (claimed clips,
  // Everything's pieces); filming starts again when the page is back.
  function hide() {
    S.hidden = true;
    if (S.plan) stopAll(true);
  }

  function show() {
    S.hidden = false;
    if (S.want && S.state !== 'full' && S.stoppedKey !== S.key && !S.asked) begun();
  }

  const onVisibility = () => {
    if (!doc) return;
    if (doc.visibilityState === 'hidden') hide();
    else show();
  };
  const onPageHide = () => hide();
  const onPageShow = () => { if (!doc || doc.visibilityState !== 'hidden') show(); };
  try { if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility); } catch { /* ignore */ }
  try {
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', onPageHide);
      win.addEventListener('pageshow', onPageShow);
    }
  } catch { /* ignore */ }

  function countHeld() {
    if (!S.code) return;
    const key = S.key;
    getStore().list(S.code, S.round).then((rows) => {
      if (key === S.key) S.held = heldOf(rows);
    }).catch(() => {});
  }

  // v1.4 PAGE-DEVICES: the shared stream was replaced (re-acquired after a drop): what's claimed is saved, and
  // filming starts again on the new stream into new clips.
  const offShared = shared && typeof shared.on === 'function' ? shared.on('stream', (fresh) => {
    if (fresh && S.stream === fresh) return;
    if (S.plan) stopAll(true);
    if (S.video) { try { S.video.srcObject = null; S.video.remove(); } catch { /* ignore */ } }
    S.video = null;
    if (S.audio) { try { S.audio.close(); } catch { /* ignore */ } }
    S.audio = null;
    S.analyser = null;
    S.stream = null;
    const ok = !!fresh && alive(fresh) && fresh.getVideoTracks().length > 0;
    if (ok && S.want && !S.hidden && S.stoppedKey !== S.key && S.state !== 'full' && S.state !== 'done') {
      // straight onto the new stream (no waiting: a second swap can't land in between)
      S.stream = fresh;
      watchTracks(fresh);
      measure(fresh);
      S.recErrored = false;
      setState('on');
      run();
    } else if (S.state === 'on' || S.state === 'asking') setState('off');
  }) : () => {};
  // v1.4 end PAGE-DEVICES

  const camera = {
    get state() { return S.state; },
    get mode() { return S.mode; },
    stream: () => S.stream,
    store: getStore,
    held: () => ({ count: S.held.count, bytes: S.held.bytes }),
    start() {
      if (S.state === 'full' || S.stoppedKey === S.key) return Promise.resolve(null);
      if (!S.want) return Promise.resolve(null);
      return begun(true); // v1.4 PAGE-DEVICES: a tap
    },
    stopRecording() {
      S.stoppedKey = S.key;
      finishRound('stopped');
    },
    // kind 'checkpoint' (v1.3): "Take the photo" was tapped. An iPhone mutes this camera while its own camera is
    // open (and a phone stops it while the page is hidden), so the clip with the lead-in is claimed now, at the tap;
    // the server's moment later (once the photo counts) only finds the recorders started after the camera came back.
    mark(kind = 'mark') {
      const c = clockNow();
      const k = kind === 'checkpoint' ? 'checkpoint' : 'mark';
      if (!S.plan || c === null) return false;
      S.queue.push({ clock: c, kind: k, local: { at: now(), until: now(), kind: k } });
      step();
      return true;
    },
    take(view) {
      const cam = view && view.cam;
      const live = view && view.phase === 'live';
      const over = view && view.phase === 'over';
      const code = String((view && view.code) || (app && app.game && app.game.code) || '').toUpperCase();
      const round = view && Number.isFinite(view.round) ? view.round : null;
      const key = `${code}:${round}`;
      if (S.key !== key) {
        if (S.key) camera.stop();
        S.key = key;
        S.code = code;
        S.round = round;
        S.taken = 0;
        S.ending = false;
        S.held = { count: 0, bytes: 0, left: 0, leftBytes: 0 };
        S.talk = newTalk(); // v1.4.7: TALK_MOST counts per round
        countHeld();
        if (!S.pruned && code) {
          S.pruned = true;
          getStore().prune({ keep: [code, round], olderThan: wall() - PRUNE_MS }).catch(() => {});
        }
      }
      S.pid = view && view.me ? view.me.id : S.pid;
      const filmed = !!cam && cam.ok === true && (live || over);
      if (cam && cam.mode) S.mode = cam.mode === 'everything' ? 'everything' : 'highlights';
      // Moments told to this phone.
      if (filmed && Array.isArray(cam.moments)) {
        const since = app && Number.isInteger(app.camSince) ? app.camSince : S.taken;
        for (const m of cam.moments) {
          if (!m || !Number.isInteger(m.n) || m.n <= Math.max(S.taken, since)) continue;
          if (S.plan) S.queue.push(m);
        }
        const last = Math.max(S.taken, ...cam.moments.map((m) => (m && Number.isInteger(m.n) ? m.n : 0)), Number(cam.last) || 0);
        S.taken = last;
        if (app) app.camSince = last;
      }
      if (over && S.mode === 'highlights' && S.plan && !S.ending && !S.queue.some((m) => m.kind === 'over')) {
        // The server's 'over' moment normally says it; this ends filming even if it never came.
        S.queue.push({ clock: clockNow() || 0, kind: 'over' });
      }
      if (over && S.mode === 'everything' && S.plan && S.plan.endAt === null && !S.queue.some((m) => m.kind === 'over')) {
        S.queue.push({ clock: clockNow() || 0, kind: 'over' });
      }
      if (over) S.ending = true;
      S.want = filmed && live;
      if (S.want && S.state === 'off' && !S.asked && S.stoppedKey !== key && S.autostart) begun();
      if (!filmed && S.plan) finishRound('off');
      // Filming stopped while the page was away (nothing running), and no more is wanted: let the camera go.
      if (!S.want && !S.plan && S.stream) {
        letGo();
        setState(over ? 'done' : 'off');
      }
      if (S.plan) step();
    },
    // The game screen says it's showing (so the camera may start on its own).
    attach(on = true) {
      S.autostart = !!on;
      if (on && S.want && S.state === 'off' && !S.asked && S.stoppedKey !== S.key) begun();
    },
    stop() {
      stopAll(true);
      letGo();
      S.want = false;
      S.queue = [];
      if (S.state !== 'full' && S.state !== 'unsupported') setState('off');
    },
    destroy() {
      camera.stop();
      fns.clear();
      offShared(); // v1.4 PAGE-DEVICES
      try { if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility); } catch { /* ignore */ }
      try {
        if (win && typeof win.removeEventListener === 'function') {
          win.removeEventListener('pagehide', onPageHide);
          win.removeEventListener('pageshow', onPageShow);
        }
      } catch { /* ignore */ }
    },
    on(name, fn) {
      if (!fns.has(name)) fns.set(name, new Set());
      fns.get(name).add(fn);
      return () => fns.get(name) && fns.get(name).delete(fn);
    },
    get filming() { return S.live.size > 0 || (!!S.plan && S.state === 'on'); },
    get wanted() { return S.want; },
    get stoppedHere() { return S.stoppedKey !== null && S.stoppedKey === S.key; },
    type,
  };
  return camera;
}
