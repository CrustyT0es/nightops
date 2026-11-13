// Night Ops v1.2 (PAGE-CAM): "Download the movie". The director's auto-edit played in real time onto a 720x1280
// canvas (the shot on top with its name and the play-by-play line, a map strip at the bottom drawn on the canvas,
// a short card with the clock between the parts), its sound mixed through one AudioContext, recorded with
// MediaRecorder into one file on the phone.
//
//   canMakeMovie(win) -> boolean
//   movieParts({ list, summary, whole }) -> { windows, cuts, totalMs }   (pure)
//   renderMovie({ app, list, summary, faces, ring, whole, onProgress, signal, getUrls }) -> Promise<{ blob, type, name }>
import { direct, movieWindows, fileTimeAt } from './director.js';
import { fmtClock } from '../shared/rules.js';
import { ringOutline } from '../shared/geo.js';

export const W = 720;
export const H = 1280;
export const SHOT_H = Math.round(H * 0.62);
export const FPS = 30;
export const BITS = 2500000;
export const LONG_BITS = 1200000;          // a movie longer than LONG_MS is made at this rate (it's all held in memory)
export const LONG_MS = 5 * 60000;
export const WHOLE_MOST_MS = 15 * 60000;   // "The whole game" at most: a longer one doesn't fit in a phone's memory
export const MOVIE_MOST_BYTES = 350e6;     // the file stops growing here (a phone's tab is closed far before 1 GB)
export const VIDEO_POOL = 3;               // video elements, unlocked in the tap and reused
export const RADIO_POOL_MOST = 40;
export const CARD_MS = 1000;
export const CAPTION_WITHIN_MS = 5000;
export const MOVIE_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
const DRIFT_S = 0.5;
const COLORS = { hunter: '#ff5a5a', hider: '#4ea8ff', driver: '#ffc24a', out: '#9aa6b8' };

export function movieType(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';
  for (const t of MOVIE_TYPES) {
    try { if (Recorder.isTypeSupported(t)) return t; } catch { /* next */ }
  }
  return '';
}

export function canMakeMovie(win = globalThis.window) {
  try {
    if (!win || !win.HTMLCanvasElement || typeof win.HTMLCanvasElement.prototype.captureStream !== 'function') return false;
    return !!movieType(win.MediaRecorder);
  } catch {
    return false;
  }
}

// The talk list for the director: summary.radio (the walkie clips, kept when the game saves them); without it, the
// camera's own 'radio' moments (each walkie message's timing, its sender first when filmed), so the talker still
// leads the edit when the messages themselves weren't kept (n: null, nothing to play).
export function talkOf(summary) {
  if (summary && Array.isArray(summary.radio)) {
    return summary.radio
      .filter((c) => c && typeof c.from === 'string' && Number.isFinite(c.clock))
      .map((c) => ({ from: c.from, clock: c.clock, ms: Number(c.ms) || 3000, side: c.side || null, n: c.n }));
  }
  const moments = summary && summary.cam && Array.isArray(summary.cam.moments) ? summary.cam.moments : [];
  return moments
    .filter((m) => m && m.kind === 'radio' && Number.isFinite(m.clock) && Array.isArray(m.ids) && typeof m.ids[0] === 'string')
    .map((m) => ({ from: m.ids[0], clock: m.clock, ms: Number(m.ms) || 3000, side: null, n: null }));
}

// The movie's video rate: lower for a long one, so the file held in memory stays small.
export function movieBits(totalMs) {
  return totalMs > LONG_MS ? LONG_BITS : BITS;
}

// Which parts of the game the movie plays: the director's cuts over the whole game, windows from movieWindows
// (or, for "The whole game", from the first clip to the last; past wholeMost the busiest wholeMost of it, `capped`).
export function movieParts({ list, summary, whole = false, most = 480000, wholeMost = WHOLE_MOST_MS } = {}) {
  const clips = Array.isArray(list) ? list : [];
  if (!clips.length) return { windows: [], cuts: [], totalMs: 0, capped: false };
  const from = Math.min(...clips.map((c) => c.start));
  const to = Math.max(...clips.map((c) => c.end));
  const moments = summary && summary.cam ? summary.cam.moments : [];
  const talk = talkOf(summary);
  const cuts = direct({ clips, talk, moments, routes: summary ? summary.routes : null, from, to });
  let windows;
  let capped = false;
  if (whole) {
    windows = [];
    for (const c of cuts) {
      const last = windows[windows.length - 1];
      if (last && c.from - last.to < 4000) last.to = Math.max(last.to, c.to);
      else windows.push({ from: c.from, to: c.to });
    }
    const len = windows.reduce((s, w) => s + (w.to - w.from), 0);
    if (len > wholeMost) {
      windows = movieWindows({ cuts, moments, talk, most: wholeMost });
      capped = true;
    }
  } else {
    windows = movieWindows({ cuts, moments, talk, most });
  }
  const totalMs = windows.reduce((s, w) => s + (w.to - w.from), 0) + Math.max(0, windows.length) * CARD_MS;
  return { windows, cuts, totalMs, capped };
}

// Where the movie clock (ms) is: { card: true, index, clock } between parts, else { index, clock } (game clock).
export function placeAt(windows, mc) {
  let t = mc;
  for (let i = 0; i < windows.length; i += 1) {
    if (t < CARD_MS) return { card: true, index: i, clock: windows[i].from };
    t -= CARD_MS;
    const len = windows[i].to - windows[i].from;
    if (t < len) return { card: false, index: i, clock: windows[i].from + t };
    t -= len;
  }
  return null;
}

function captionAt(events, clock) {
  let best = null;
  for (const e of events || []) {
    if (!e || !Number.isFinite(e.clock) || typeof e.text !== 'string') continue;
    if (e.clock <= clock && clock - e.clock <= CAPTION_WITHIN_MS) best = e;
  }
  return best ? best.text : '';
}

function teamOf(summary, pid) {
  const row = summary && Array.isArray(summary.players) ? summary.players.find((p) => p && p.id === pid) : null;
  if (!row) return 'out';
  if (row.driver) return 'driver';
  return row.startTeam === 'hider' ? 'hider' : 'hunter';
}

function nameOf(summary, pid) {
  const row = summary && Array.isArray(summary.players) ? summary.players.find((p) => p && p.id === pid) : null;
  return row && row.name ? String(row.name).slice(0, 40) : 'Someone';
}

// ---- drawing ----

function outlined(ctx, words, x, y, color, size) {
  ctx.font = `700 ${size}px "Space Grotesk", system-ui, sans-serif`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size / 6);
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.strokeText(words, x, y);
  ctx.fillStyle = color;
  ctx.fillText(words, x, y);
}

function wrapLines(ctx, words, width, most = 2) {
  const out = [];
  let line = '';
  for (const w of String(words).split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      out.push(line);
      line = w;
      if (out.length === most) break;
    } else {
      line = next;
    }
  }
  if (line && out.length < most) out.push(line);
  return out;
}

function drawCover(ctx, video, x, y, w, h) {
  const vw = video.videoWidth || 4;
  const vh = video.videoHeight || 3;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
}

export function ringPointsOf(ring) {
  try {
    if (!ring || (ring.kind !== 'circle' && !Array.isArray(ring.points))) return [];
    return ringOutline(ring, 48);
  } catch {
    return [];
  }
}

// A map strip: the ring and everyone's route so far (plain projection, no tiles).
export function stripProjection(routes, ring, box) {
  const pts = [];
  for (const r of Object.values(routes || {})) for (const p of r || []) if (Array.isArray(p)) pts.push(p);
  for (const p of ringPointsOf(ring)) pts.push(p);
  if (!pts.length) return null;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const lat = (minY + maxY) / 2;
  const kx = Math.cos((lat * Math.PI) / 180);
  const spanX = Math.max(1e-6, (maxX - minX) * kx);
  const spanY = Math.max(1e-6, maxY - minY);
  const pad = 30;
  const s = Math.min((box.w - pad * 2) / spanX, (box.h - pad * 2) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return (p) => [box.x + box.w / 2 + (p[0] - cx) * kx * s, box.y + box.h / 2 - (p[1] - cy) * s];
}

function drawStrip(ctx, { routes, ring, summary, clock, proj }) {
  const y0 = SHOT_H;
  ctx.fillStyle = '#0b0f15';
  ctx.fillRect(0, y0, W, H - y0);
  ctx.strokeStyle = '#1f2836';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, y0 + 1);
  ctx.lineTo(W, y0 + 1);
  ctx.stroke();
  if (!proj) return;
  const ringPts = ringPointsOf(ring);
  if (ringPts.length > 2) {
    ctx.beginPath();
    ringPts.forEach((p, i) => { const [x, y] = proj(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = '#e6ebf2';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  const t = clock / 1000;
  for (const [pid, pts] of Object.entries(routes || {})) {
    const color = COLORS[teamOf(summary, pid)] || COLORS.out;
    const sofar = (pts || []).filter((p) => p[2] <= t);
    if (!sofar.length) continue;
    ctx.beginPath();
    sofar.forEach((p, i) => { const [x, y] = proj(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.globalAlpha = 1;
    const [x, y] = proj(sofar[sofar.length - 1]);
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#07090d';
    ctx.stroke();
    outlined(ctx, nameOf(summary, pid), x + 16, y + 6, '#e6ebf2', 22);
  }
}

function drawCard(ctx, clock, code) {
  ctx.fillStyle = '#07090d';
  ctx.fillRect(0, 0, W, SHOT_H);
  ctx.textAlign = 'center';
  outlined(ctx, fmtClock(clock), W / 2, SHOT_H / 2, '#e6ebf2', 96);
  ctx.font = '500 30px "JetBrains Mono", monospace';
  ctx.fillStyle = '#9aa6b8';
  ctx.fillText(code ? `NIGHT OPS ${code}` : 'NIGHT OPS', W / 2, SHOT_H / 2 + 70);
  ctx.textAlign = 'left';
}

// ---- the render ----

export async function renderMovie({
  app,
  list,
  summary,
  ring = null,
  code = '',
  whole = false,
  onProgress = () => {},
  signal = null,
  getUrls,
  doc = globalThis.document,
  win = globalThis.window,
  now = () => performance.now(),
  later = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  // Everything up to the first await runs inside the "Make the movie" tap: the sound and every media element are
  // unlocked here (iPhones only let an element play with sound after a tap, and the tap is long gone by the time a
  // clip has loaded). The elements are then reused by changing their src.
  const Recorder = win.MediaRecorder;
  const type = movieType(Recorder);
  if (!type) throw new Error("This phone can't make a movie.");
  const parts = movieParts({ list, summary, whole });
  if (!parts.windows.length) throw new Error('No clips to make a movie from yet.');
  const byId = new Map(list.map((c) => [c.id, c]));
  const canvas = doc.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const AC = win.AudioContext || win.webkitAudioContext;
  const audio = AC ? new AC() : null;
  const dest = audio ? audio.createMediaStreamDestination() : null;
  const box = doc.createElement('div');
  box.className = 'cam-hidden-media';
  box.setAttribute('aria-hidden', 'true');
  (doc.body || doc.documentElement).appendChild(box);
  // Each element through its own gain into the mix (a video's goes to 0 while a walkie message plays: its camera
  // heard the same words, live, a moment before the message's own recording).
  function wire(el) {
    if (!audio) return null;
    try {
      const src = audio.createMediaElementSource(el);
      const gain = audio.createGain();
      src.connect(gain);
      gain.connect(dest);
      return gain;
    } catch { return null; }
  }
  function unlock(el) {
    try {
      el.load();
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      el.pause();
    } catch { /* not here */ }
  }
  function media(tag) {
    const el = doc.createElement(tag);
    if (tag === 'video') {
      el.crossOrigin = 'anonymous';
      el.playsInline = true;
      el.setAttribute('playsinline', '');
    }
    el.preload = 'auto';
    box.appendChild(el);
    const gain = wire(el);
    unlock(el);
    return { el, gain };
  }
  const slots = [];
  for (let i = 0; i < VIDEO_POOL; i += 1) slots.push({ ...media('video'), id: null, used: 0, busy: false, ready: null });
  const talk = talkOf(summary);
  const wanted = talk.filter((c) => Number.isInteger(c.n) && parts.windows.some((w) => c.clock < w.to && c.clock + c.ms > w.from)).slice(0, RADIO_POOL_MOST);
  const radioPool = wanted.map(() => media('audio'));
  if (audio && audio.state === 'suspended') { try { await audio.resume(); } catch { /* ignore */ } }

  const stream = canvas.captureStream(FPS);
  if (dest) for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
  const rec = new Recorder(stream, { mimeType: type, videoBitsPerSecond: movieBits(parts.totalMs), audioBitsPerSecond: 128000 });
  const chunks = [];
  let bytes = 0;
  let tooBig = false;
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    bytes += e.data.size;
    if (bytes > MOVIE_MOST_BYTES) { tooBig = true; return; }
    chunks.push(e.data);
  };

  const urls = {};
  async function urlFor(id) {
    if (urls[id]) return urls[id];
    const got = await getUrls([id]);
    Object.assign(urls, got || {});
    return urls[id] || null;
  }
  let useN = 0;
  const failed = new Set(); // clips that wouldn't load (never waited for again)
  let shown = null; // the slot on screen
  const slotOf = (id) => slots.find((x) => x.id === id) || null;
  // A clip into an element (the least recently used one that isn't on screen). -> Promise<element | null>
  function load(id) {
    const have = slotOf(id);
    if (have) {
      have.used = ++useN;
      return have.ready;
    }
    const s = slots.filter((x) => x !== shown && !x.busy).sort((a, b) => a.used - b.used)[0]
      || slots.filter((x) => x !== shown).sort((a, b) => a.used - b.used)[0];
    if (!s) return Promise.resolve(null);
    s.id = id;
    s.used = ++useN;
    s.busy = true;
    s.ready = (async () => {
      try {
        const url = await urlFor(id);
        if (s.id !== id) return null;
        if (!url) { s.id = null; failed.add(id); return null; }
        try { s.el.pause(); } catch { /* ignore */ }
        s.el.src = url;
        await new Promise((resolve) => {
          if (s.el.readyState >= 2) { resolve(); return; }
          let t = null;
          const done = () => { s.el.removeEventListener('loadeddata', done); s.el.removeEventListener('error', done); if (t) clearTimeout(t); resolve(); };
          s.el.addEventListener('loadeddata', done);
          s.el.addEventListener('error', done);
          t = setTimeout(done, 8000);
        });
        if (s.el.readyState < 2) failed.add(id);
        return s.id === id ? s.el : null;
      } catch {
        failed.add(id);
        return null;
      } finally {
        s.busy = false;
      }
    })();
    return s.ready;
  }

  // Walkie clips (fetched first) into the unlocked audio elements.
  const radioEls = [];
  if (app && typeof app.clip === 'function') {
    for (let i = 0; i < wanted.length; i += 1) {
      const c = wanted[i];
      try {
        const got = await app.clip(c.n);
        if (got && got.url) {
          const a = radioPool[i];
          a.el.src = got.url;
          radioEls.push({ el: a.el, clip: c });
        }
      } catch { /* left out */ }
    }
  }

  const routes = summary && summary.routes ? summary.routes : {};
  const proj = stripProjection(routes, ring, { x: 0, y: SHOT_H, w: W, h: H - SHOT_H });
  const events = summary && Array.isArray(summary.events) ? summary.events : [];
  let mc = 0;
  let last = now();
  let paused = false;  // the page is hidden
  let holding = false; // waiting for a clip to load
  let stopped = false;

  // The walkie follows the movie clock: playing only inside its own message (never over a card, a hidden page or
  // a load), seeked back when it drifts. -> true while one plays (the shot's own sound is turned down).
  function syncRadio(clock, on) {
    let talking = false;
    for (const r of radioEls) {
      const inside = on && clock >= r.clip.clock && clock < r.clip.clock + r.clip.ms;
      try {
        if (inside) {
          talking = true;
          const want = Math.max(0, (clock - r.clip.clock) / 1000);
          if (r.el.paused) {
            r.el.currentTime = want;
            const p = r.el.play();
            if (p && p.catch) p.catch(() => {});
          } else if (Math.abs(r.el.currentTime - want) > DRIFT_S) {
            r.el.currentTime = want;
          }
        } else if (!r.el.paused) {
          r.el.pause();
        }
      } catch { /* ignore */ }
    }
    for (const x of slots) if (x.gain) try { x.gain.gain.value = talking ? 0 : 1; } catch { /* ignore */ }
    return talking;
  }
  function pauseAll() {
    for (const x of slots) try { x.el.pause(); } catch { /* ignore */ }
    for (const r of radioEls) try { r.el.pause(); } catch { /* ignore */ }
  }
  // The recorder runs only while the picture moves (never while hidden or waiting for a clip).
  function setHeld() {
    const want = paused || holding;
    try {
      if (want && rec.state === 'recording') rec.pause();
      else if (!want && rec.state === 'paused') rec.resume();
    } catch { /* ignore */ }
    if (want) pauseAll();
    last = now();
  }

  const onVis = () => {
    const hidden = doc.visibilityState === 'hidden';
    if (hidden === paused) return;
    paused = hidden;
    setHeld();
    if (hidden) onProgress({ at: mc, total: parts.totalMs, paused: true });
  };
  doc.addEventListener('visibilitychange', onVis);

  function cutAt(clock) {
    return parts.cuts.find((c) => clock >= c.from && clock < c.to) || null;
  }
  function nextCut(clock, id) {
    return parts.cuts.find((c) => c.from > clock && c.id !== id && parts.windows.some((w) => c.from < w.to && c.to > w.from)) || null;
  }

  const finished = new Promise((resolve, reject) => {
    rec.onstop = () => resolve();
    rec.onerror = (e) => reject(e && e.error ? e.error : new Error("The movie didn't record."));
  });
  rec.start(1000);

  try {
    await new Promise((resolve, reject) => {
      const abort = () => { stopped = true; reject(Object.assign(new Error('Stopped.'), { name: 'AbortError' })); };
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      }
      let busy = false;
      const tick = async () => {
        if (stopped) return;
        if (busy) { later(tick, 1000 / FPS); return; }
        busy = true;
        try {
          if (tooBig) {
            stopped = true;
            reject(new Error("The movie got too big for this phone. Try The best parts."));
            return;
          }
          const t = now();
          if (!paused && !holding) mc += Math.min(200, t - last);
          last = t;
          const at = placeAt(parts.windows, mc);
          if (!at) { resolve(); return; }
          onProgress({ at: mc, total: parts.totalMs, paused });
          if (at.card) {
            for (const x of slots) try { x.el.pause(); } catch { /* ignore */ }
            syncRadio(at.clock, false);
            drawCard(ctx, at.clock, code);
          } else {
            const cut = cutAt(at.clock);
            const clip = cut ? byId.get(cut.id) : null;
            let drew = false;
            if (clip && !failed.has(clip.id)) {
              const have = slotOf(clip.id);
              let v = have && !have.busy && have.el.readyState >= 2 ? have.el : null;
              if (!v) {
                // Not loaded yet: the recording waits (no frozen frames in the file, the walkie doesn't run on).
                holding = true;
                setHeld();
                v = await load(clip.id);
                holding = false;
                if (stopped) return;
                setHeld();
              }
              if (v && v.readyState >= 2) {
                const s = slots.find((x) => x.el === v) || null;
                if (shown && shown !== s) try { shown.el.pause(); } catch { /* ignore */ }
                shown = s;
                const want = fileTimeAt(clip, at.clock);
                if (want !== null && Math.abs(v.currentTime - want) > DRIFT_S) {
                  try { v.currentTime = want; } catch { /* ignore */ }
                }
                if (v.paused && !paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, W, SHOT_H);
                try { drawCover(ctx, v, 0, 0, W, SHOT_H); drew = true; } catch { drew = false; }
                outlined(ctx, nameOf(summary, clip.pid), 28, 64, COLORS[teamOf(summary, clip.pid)], 44);
              }
              // The next shot loads while this one plays.
              const next = nextCut(at.clock, clip.id);
              if (next && !slotOf(next.id) && !failed.has(next.id)) load(next.id).catch(() => {});
            }
            if (!drew) {
              if (shown) try { shown.el.pause(); } catch { /* ignore */ }
              ctx.fillStyle = '#07090d';
              ctx.fillRect(0, 0, W, SHOT_H);
            }
            const words = captionAt(events, at.clock);
            if (words) {
              ctx.fillStyle = 'rgba(7,9,13,0.72)';
              ctx.fillRect(0, SHOT_H - 120, W, 120);
              ctx.font = '700 32px "Space Grotesk", system-ui, sans-serif';
              const lines = wrapLines(ctx, words, W - 56);
              lines.forEach((l, i) => outlined(ctx, l, 28, SHOT_H - 120 + 48 + i * 40, '#e6ebf2', 32));
            }
            ctx.font = '700 28px "JetBrains Mono", monospace';
            ctx.fillStyle = '#e6ebf2';
            ctx.textAlign = 'right';
            ctx.fillText(fmtClock(at.clock), W - 24, 52);
            ctx.textAlign = 'left';
            syncRadio(at.clock, !paused);
          }
          drawStrip(ctx, { routes, ring, summary, clock: at.clock, proj });
        } catch (e) {
          console.error(e);
        } finally {
          busy = false;
        }
        later(tick, 1000 / FPS);
      };
      tick();
    });
  } finally {
    stopped = true;
    doc.removeEventListener('visibilitychange', onVis);
    pauseAll();
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    for (const tr of stream.getTracks()) try { tr.stop(); } catch { /* ignore */ }
  }
  await finished;
  try { box.remove(); } catch { /* ignore */ }
  try { audio && audio.close(); } catch { /* ignore */ }
  if (signal && signal.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  const base = String(type).split(';')[0];
  const blob = new win.Blob(chunks, { type: base });
  const ext = base === 'video/mp4' ? 'mp4' : 'webm';
  return { blob, type: base, name: `Night Ops ${code || 'game'}.${ext}` };
}
