// Night Ops v1.4 (PAGE-PLAY): Wiretap on the hider's phone.
//
//   createWiretap(app, { doc, win, Recorder, after }) -> wt
//   wt.onView(view)   a new view.tap.id: the red mic dot shows at once, and TAP_PIECE_MS pieces are recorded one
//                     after another from the shared microphone (one MediaRecorder per piece, so each is a whole file)
//                     and sent at once (POST tap-piece). Never secret: the dot shows for as long as it records.
//   wt.state -> 'idle' | 'recording'
//   wt.destroy()
//
// The hider's phone never plays its own pieces (the server only gives tap clips to hunters).
import { h } from './dom.js?v=172';
import { toBase64 } from './radio.js?v=172';

export const TAP_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
export const TAP_BITS = 24000;
export const DOT_WORDS = 'Mic on for the hunters';

// The first type this browser's MediaRecorder can make ('' = let it pick).
export function pickType(Recorder) {
  try {
    if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';
    return TAP_TYPES.find((t) => Recorder.isTypeSupported(t)) || '';
  } catch { return ''; }
}

// Which pieces are still to record: [i...] from what the server says it has, up to `most`, while time is left.
export function piecesLeft(tap) {
  if (!tap || typeof tap !== 'object' || !tap.id) return [];
  const most = Number.isInteger(tap.most) && tap.most > 0 ? Math.min(tap.most, 10) : 3;
  const sent = Number.isInteger(tap.pieces) && tap.pieces > 0 ? tap.pieces : 0;
  if (!(Number(tap.until) > 0)) return [];
  const out = [];
  for (let i = sent; i < most; i++) out.push(i);
  return out;
}

// The piece's length: pieceMs, but never past the time left (and never under 300 ms, the server's floor).
export function pieceLength(tap, left = Infinity) {
  const piece = Number(tap && tap.pieceMs) > 0 ? Number(tap.pieceMs) : 5000;
  return Math.max(300, Math.min(piece, Number.isFinite(left) ? left : piece));
}

export function createWiretap(app, {
  doc = globalThis.document,
  win = globalThis.window || globalThis,
  Recorder = globalThis.MediaRecorder,
  after = (fn, ms) => setTimeout(fn, ms),
  now = () => Date.now(),
  make = h, // (tests: a stand-in for the DOM)
} = {}) {
  const S = { id: null, state: 'idle', dot: null, dead: false, done: new Set(), stop: null };

  function showDot(on) {
    if (on && !S.dot && doc && doc.body) {
      S.dot = make('div.wt-dot', { role: 'status', 'aria-live': 'polite' }, make('span.wt-dot-light', { 'aria-hidden': 'true' }), make('span.wt-dot-words', DOT_WORDS));
      doc.body.append(S.dot);
    } else if (!on && S.dot) {
      S.dot.remove();
      S.dot = null;
    }
  }

  async function getMic() {
    try {
      if (app && typeof app.mic === 'function') return await app.mic({ byTap: false, filming: true });
    } catch (e) { console.error(e); }
    return null;
  }

  function recordOne(stream, type, ms) {
    return new Promise((resolve) => {
      let rec;
      try { rec = new Recorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: TAP_BITS }); } catch (e) {
        try { rec = new Recorder(stream); } catch { resolve(null); return; }
      }
      const parts = [];
      const began = now();
      rec.ondataavailable = (e) => { if (e && e.data && e.data.size) parts.push(e.data); };
      rec.onerror = () => { try { rec.stop(); } catch { resolve(null); } };
      rec.onstop = () => {
        const kind = (rec.mimeType || type || 'audio/webm').split(';')[0];
        resolve(parts.length ? { blob: new Blob(parts, { type: kind }), type: kind, ms: Math.max(300, now() - began) } : null);
      };
      try { rec.start(); } catch { resolve(null); return; }
      S.stop = () => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* fine */ } };
      after(S.stop, ms);
    });
  }

  async function send(id, i, piece) {
    if (!app || typeof app._post !== 'function') return null;
    const bytes = new Uint8Array(await piece.blob.arrayBuffer());
    const body = { tap: id, i, audio: toBase64(bytes), type: piece.type, ms: Math.min(Math.round(piece.ms), 6500) };
    try {
      if (typeof app._since !== 'undefined') body.since = app._since;
      if (typeof app._radioSince === 'function') body.radioSince = app._radioSince();
      if (typeof app._camSince === 'function') body.camSince = app._camSince();
      const pos = typeof app._posToSend === 'function' ? app._posToSend() : null;
      if (pos) body.pos = pos;
      const res = await app._post('tap-piece', body, { timeoutMs: 20000 });
      if (res && res.view && typeof app._take === 'function') app._take(res.view);
      return res;
    } catch (e) { console.error(e); return null; }
  }

  async function run(tap) {
    const id = tap.id;
    S.state = 'recording';
    showDot(true);
    const mic = await getMic();
    const stream = mic && mic.stream;
    // No microphone (refused outside a tap, or a call has it): nothing is recorded, so the dot goes at once.
    if (!stream || !Recorder) { if (S.id === id) { S.state = 'idle'; showDot(false); } S.noMic = id; return; }
    const type = pickType(Recorder);
    const sends = [];
    const end = now() + Math.max(0, Number(tap.until) || 0);
    try {
      if (stream && Recorder) {
        for (const i of piecesLeft(tap)) {
          if (S.dead || S.id !== id) break;
          const left = end - now();
          if (left < 300) break;
          const piece = await recordOne(stream, type, pieceLength(tap, left));
          if (piece) sends.push(send(id, i, piece));
        }
      }
    } finally {
      if (mic && !mic.shared && stream) { try { for (const t of stream.getTracks()) t.stop(); } catch { /* fine */ } }
      await Promise.all(sends).catch(() => {});
      if (S.id === id) { S.state = 'idle'; showDot(false); }
    }
  }

  function onView(view) {
    if (S.dead) return;
    const tap = view && view.tap;
    if (!tap || !tap.id) {
      if (S.state === 'recording' && S.stop) S.stop();
      S.id = null;
      S.state = 'idle';
      showDot(false);
      return;
    }
    if (S.done.has(tap.id)) return;
    S.done.add(tap.id);
    S.id = tap.id;
    run(tap).catch((e) => console.error(e));
  }

  const off = app && typeof app.on === 'function' ? app.on('view', onView) : () => {};
  return {
    onView,
    get state() { return S.state; },
    noMic: () => S.noMic || null,
    destroy() { S.dead = true; off(); if (S.stop) S.stop(); showDot(false); },
  };
}
