// Night Ops v1.2 (PAGE-CAM): "Download the movie". The director's auto-edit played in real time onto a 720x1280
// canvas (the shot on top with its name and the play-by-play line, a map strip at the bottom drawn on the canvas,
// a short card with the clock between the parts), its sound mixed through one AudioContext, recorded with
// MediaRecorder into one file on the phone.
//
//   canMakeMovie(win) -> boolean
//   movieParts({ list, summary, whole }) -> { windows, cuts, totalMs }   (pure)
//   renderMovie({ app, list, summary, faces, ring, whole, onProgress, signal, getUrls }) -> Promise<{ blob, type, name }>
import { direct, movieWindows, fileTimeAt } from './director.js?v=165';
import { fmtClock } from '../shared/rules.js?v=165';
import { ringOutline } from '../shared/geo.js?v=165';
// v1.4 PAGE-REEL: the reel's frame drawer (drawFrame, framePlan, audioAt, drawMiniMap) is at the end of this file.
// The v1.2 movieParts/renderMovie above it stay only until PAGE-RENDER's render.js takes over the downloads.
import { fitView, boxKey } from './moviemap.js?v=165';
import { tourView } from './tour.js?v=165';
import { REEL, sceneAt, clockAt, gainOf, miniMap, TITLE_MS, joinNames, loudAt } from './scenes.js?v=165';

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

// ===========================================================================================================
// v1.4 PAGE-REEL: the reel's frames. Pure drawing: no fetching, no time of its own. The page's player
// (screens/reelplayer.js) and the file renderer (render.js) both call drawFrame for each reel time t.
//
//   framePlan(reel, t) -> { scene, index, clock, shots: [{ id, pid, fileAt, slot }] }   the clip frames t needs
//   audioAt(reel, t0, t1) -> [{ kind, src, track, from, to, fileAt, g0, g1 }]            what plays between
//   drawFrame(ctx, reel, t, { sources, faces, summary, ring, w, h, scale })
//   drawMiniMap(ctx, mini, { clockMs, faces, summary, x, y, w, h })
// ===========================================================================================================

const INK = '#e6ebf2';
const DIM = '#9aa6b8';
const NIGHT = '#07090d';
const PANEL = '#0b0f15';
const LINE14 = '#1f2836';
const ACCENT = '#7cf2b0';
const TEAM14 = { hunter: '#ff5a5a', hider: '#4ea8ff', driver: '#ffc24a', out: '#9aa6b8' };
const CAM_H = Math.round(REEL.H * 0.62);

const clipIndex = new WeakMap();
function clipOf(reel, id) {
  let m = clipIndex.get(reel);
  if (!m) { m = new Map((reel.clips || []).map((c) => [c.id, c])); clipIndex.set(reel, m); }
  return m.get(id) || null;
}

export function framePlan(reel, t) {
  const index = sceneAt(reel, t);
  const scene = index >= 0 ? reel.scenes[index] : null;
  if (!scene) return { scene: null, index: -1, clock: null, shots: [] };
  const clock = clockAt(scene, t);
  const shots = [];
  if (clock !== null) {
    for (const s of scene.shots || []) {
      if (clock < s.from || clock >= s.to) continue;
      const clip = clipOf(reel, s.id);
      const fileAt = clip ? fileTimeAt(clip, clock) : null;
      if (fileAt === null) continue;
      const shot = { id: s.id, pid: s.pid, fileAt, slot: s.slot };
      // v1.4.7: too dark to see: the movie draws the face and a sound wave at this loudness (no frame needed)
      if (s.dark) { shot.dark = true; shot.level = loudAt(clip, clock) || 0; }
      shots.push(shot);
    }
  }
  return { scene, index, clock, shots };
}

export function audioAt(reel, t0, t1) {
  const out = [];
  for (const track of reel.audio || []) {
    const from = Math.max(t0, track.at), to = Math.min(t1, track.at + track.ms);
    if (to <= from) continue;
    out.push({ kind: track.kind, src: track.src, track, from, to, fileAt: track.fileAt + (from - track.at) / 1000,
      g0: gainOf(track, from), g1: gainOf(track, to) });
  }
  return out;
}

function person(summary, pid) {
  const row = summary && Array.isArray(summary.players) ? summary.players.find((p) => p && p.id === pid) : null;
  return { name: row && row.name ? String(row.name).slice(0, 30) : 'Someone',
    color: TEAM14[!row ? 'out' : row.driver ? 'driver' : row.startTeam === 'hider' ? 'hider' : 'hunter'] };
}

function faceOf(faces, pid) {
  if (!faces) return null;
  const f = faces instanceof Map ? faces.get(pid) : faces[pid];
  return f && (f.width || f.naturalWidth || f.videoWidth) ? f : null;
}

function txt(ctx, words, x, y, { size = 28, color = INK, weight = 700, align = 'left', font = 'Space Grotesk', outline = true } = {}) {
  ctx.font = `${weight} ${size}px "${font}", system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  if (outline) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(4, size / 5);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(words, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(words, x, y);
  ctx.textAlign = 'left';
}

// A stencil title: wide-spaced capitals with the stencil's bridges cut through them.
function stencil(ctx, words, x, y, size, color = INK, alpha = 1, align = 'left') {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `700 ${size}px "Space Grotesk", system-ui, sans-serif`;
  const spaced = String(words).toUpperCase().split('').join(' ');
  ctx.textAlign = align;
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 4.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(spaced, x, y);
  ctx.fillStyle = color;
  ctx.fillText(spaced, x, y);
  // the bridges: two thin dark bars through the letters
  const wide = ctx.measureText(spaced).width;
  const left = align === 'center' ? x - wide / 2 : align === 'right' ? x - wide : x;
  ctx.fillStyle = 'rgba(7,9,13,0.9)';
  ctx.fillRect(left, y - size * 0.42, wide, Math.max(2, size * 0.06));
  ctx.restore();
}

function round(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// a hider's ring goes red (#ff2d2d) from their catch, as on the replay map (map.js `caught`)
export function ringColor(summary, pid, clock) {
  const row = summary && Array.isArray(summary.players) ? summary.players.find((p) => p && p.id === pid) : null;
  const at = row ? Number(row.caughtAt) : NaN;
  if (row && row.caughtAt !== null && row.caughtAt !== undefined && Number.isFinite(at) && clock !== null && clock !== undefined && at <= clock) return CAUGHT_RING;
  return person(summary, pid).color;
}
export const CAUGHT_RING = '#ff2d2d';

function drawFace(ctx, faces, summary, pid, x, y, r, clock = null) {
  const who = person(summary, pid);
  const img = faceOf(faces, pid);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#16202c';
  ctx.fill();
  if (img) {
    ctx.clip();
    try { ctx.drawImage(img, x - r, y - r, r * 2, r * 2); } catch { /* not drawable yet */ }
  } else {
    txt(ctx, who.name.slice(0, 1).toUpperCase(), x, y + r * 0.36, { size: r, align: 'center', outline: false });
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(3, r / 8);
  ctx.strokeStyle = ringColor(summary, pid, clock);
  ctx.stroke();
}

function sourceOf(sources, id) {
  if (!sources) return null;
  const v = sources instanceof Map ? sources.get(id) : sources[id];
  if (!v) return null;
  if (v.img) return v;
  return { img: v, stale: false };
}

// v1.4.7: a shot too dark to see (shot.dark), or a side of a close call with no footage (shot.none): the player's
// face, a sound wave moving with their loudness (shot.level, 0..100; none for no footage) and their name under it.
// Deterministic in t (reel ms), so the page's player and the file match frame for frame.
export const WAVE_BARS = 23;
function drawVoice(ctx, faces, summary, shot, x, y, w, h, { small = false, t = 0, clock = null } = {}) {
  const who = person(summary, shot.pid);
  ctx.save();
  round(ctx, x, y, w, h, small ? 12 : 0);
  ctx.clip();
  ctx.fillStyle = '#0d131c';
  ctx.fillRect(x, y, w, h);
  const r = Math.max(14, Math.min(w, h) * (small ? 0.2 : 0.17));
  const cx = x + w / 2;
  const cy = y + h * (small ? 0.36 : 0.38);
  ctx.globalAlpha = shot.none ? 0.55 : 1;
  drawFace(ctx, faces, summary, shot.pid, cx, cy, r, clock);
  ctx.globalAlpha = 1;
  const waveY = cy + r + (small ? 18 : 46);
  const most = Math.min(h * 0.14, small ? 22 : 64);
  if (!shot.none) {
    const level = Number.isFinite(shot.level) ? shot.level : 0;
    const amp = Math.max(0.12, Math.min(1, (level - 8) / 55));
    const bars = small ? 13 : WAVE_BARS;
    const span = Math.min(w * 0.72, small ? 150 : 420);
    const bw = span / bars;
    ctx.fillStyle = who.color;
    for (let i = 0; i < bars; i += 1) {
      const wob = Math.abs(Math.sin(i * 1.7 + t / 140) * 0.6 + Math.sin(i * 0.55 - t / 230) * 0.4);
      const hump = Math.sin((Math.PI * (i + 0.5)) / bars);
      const bh = Math.max(3, most * amp * (0.25 + 0.75 * wob) * (0.45 + 0.55 * hump));
      ctx.fillRect(x + (w - span) / 2 + i * bw + bw * 0.2, waveY - bh / 2, Math.max(2, bw * 0.6), bh);
    }
  }
  ctx.restore();
  txt(ctx, who.name, cx, Math.min(y + h - (small ? 8 : 20), waveY + most / 2 + (small ? 24 : 50)), { size: small ? 20 : 38, color: who.color, align: 'center' });
  if (small) {
    round(ctx, x, y, w, h, 12);
    ctx.lineWidth = 3;
    ctx.strokeStyle = who.color;
    ctx.stroke();
  }
  return true;
}

function drawShot(ctx, sources, summary, shot, x, y, w, h, { name = true, small = false, faces = null, t = 0, clock = null } = {}) {
  if (shot && (shot.dark || shot.none) && shot.pid) return drawVoice(ctx, faces, summary, shot, x, y, w, h, { small, t, clock }); // v1.4.7
  ctx.save();
  round(ctx, x, y, w, h, small ? 12 : 0);
  ctx.clip();
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, w, h);
  const s = shot ? sourceOf(sources, shot.id) : null;
  let drawn = false;
  if (s) {
    const img = s.img;
    const vw = img.videoWidth || img.width || 4;
    const vh = img.videoHeight || img.height || 3;
    if (vw > 4 && vh > 3) {
      const k = Math.max(w / vw, h / vh);
      const sw = w / k, sh = h / k;
      try { ctx.drawImage(img, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h); drawn = true; } catch { /* not ready */ }
    }
    if (drawn && s.stale) { ctx.fillStyle = 'rgba(7,9,13,0.45)'; ctx.fillRect(x, y, w, h); }
  }
  if (!drawn) {
    ctx.fillStyle = '#121a25';
    ctx.fillRect(x, y, w, h);
    if (shot) txt(ctx, 'Loading', x + w / 2, y + h / 2 + 8, { size: small ? 18 : 26, color: DIM, align: 'center', weight: 500, outline: false });
  }
  ctx.restore();
  if (small) {
    round(ctx, x, y, w, h, 12);
    ctx.lineWidth = 3;
    ctx.strokeStyle = shot ? person(summary, shot.pid).color : LINE14;
    ctx.stroke();
  }
  if (name && shot) {
    const who = person(summary, shot.pid);
    txt(ctx, who.name, x + (small ? 10 : 24), y + h - (small ? 12 : 26), { size: small ? 20 : 34, color: who.color });
  }
  return drawn;
}

// ---- the map, plain projection of the scene's box ----

function projector(box, rect) {
  const v = fitView(box, rect);
  return v ? v.toPx : null;
}

// the street map's still picture under the panel (moviemap.js), else nothing (the grid shows)
function drawStreets(ctx, maps, box, rect) {
  if (!maps || !box || typeof maps.get !== 'function') return false;
  const v = fitView(box, rect);
  if (!v) return false;
  // v1.4.6: a tour's view in between pictures: the most detailed picture that covers all of it (cropped), else any
  let pic = maps.get(boxKey(box));
  if (!pic && typeof maps.cover === 'function') {
    const [a0, a1] = v.fromPx(rect.x, rect.y), [b0, b1] = v.fromPx(rect.x + rect.w, rect.y + rect.h);
    pic = maps.cover([a0, a1, b0, b1]);
  }
  if (!pic && typeof maps.any === 'function') pic = maps.any();
  if (!pic || !pic.img) return false;
  const [x0, y0] = v.toPxM([pic.bounds[0], pic.bounds[1]]), [x1, y1] = v.toPxM([pic.bounds[2], pic.bounds[3]]);
  try { ctx.drawImage(pic.img, x0, y0, x1 - x0, y1 - y0); } catch { return false; }
  ctx.fillStyle = 'rgba(7,9,13,0.18)'; // a touch darker, so routes and names stand out as on the replay
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  return true;
}

function headAt(pts, sec) {
  if (!pts || !pts.length || sec < pts[0][2]) return null;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i], b = pts[i + 1];
    if (sec >= a[2] && sec <= b[2]) {
      const f = b[2] > a[2] ? (sec - a[2]) / (b[2] - a[2]) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  const last = pts[pts.length - 1];
  return sec - last[2] < 600 ? [last[0], last[1]] : null;
}

function drawGrid(ctx, rect) {
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = 'rgba(124,242,176,0.06)';
  ctx.lineWidth = 1;
  for (let x = rect.x; x < rect.x + rect.w; x += 48) { ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.h); ctx.stroke(); }
  for (let y = rect.y; y < rect.y + rect.h; y += 48) { ctx.beginPath(); ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.w, y); ctx.stroke(); }
}

function drawMap(ctx, scene, clock, rect, { summary, ring, faces, focus = [], maps = null, box = null } = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  drawGrid(ctx, rect);
  const view = box || (scene.map && scene.map.box);
  drawStreets(ctx, maps, view, rect);
  const proj = projector(view, rect);
  if (proj) {
    const ringPts = ringPointsOf(ring);
    if (ringPts.length > 2) {
      ctx.beginPath();
      ringPts.forEach((p, i) => { const [x, y] = proj(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(124,242,176,0.04)';
      ctx.fill();
      ctx.setLineDash([14, 10]);
      ctx.strokeStyle = 'rgba(230,235,242,0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const sec = clock === null ? Infinity : clock / 1000;
    const mode = scene.map ? scene.map.routes : 'so-far';
    // v1.4.5: the whole path so far always stays (the owner: no paths that start part-way or fade)
    const lo = -Infinity;
    // pins (only those living at this clock)
    for (const pin of (summary && Array.isArray(summary.pins) ? summary.pins : [])) {
      if (!pin || !Array.isArray(pin.p) || clock === null || clock < pin.clock || clock > pin.until) continue;
      const [x, y] = proj(pin.p);
      ctx.beginPath();
      ctx.moveTo(x, y - 14); ctx.lineTo(x + 10, y); ctx.lineTo(x, y + 14); ctx.lineTo(x - 10, y); ctx.closePath();
      ctx.fillStyle = '#ffc24a';
      ctx.fill();
    }
    if (mode !== 'none') {
      const heads = [];
      for (const [pid, pts] of Object.entries((summary && summary.routes) || {})) {
        const who = person(summary, pid);
        const sofar = (pts || []).filter((p) => p[2] <= sec && p[2] >= lo);
        const lit = !focus.length || focus.includes(pid);
        if (sofar.length > 1) {
          ctx.beginPath();
          sofar.forEach((p, i) => { const [x, y] = proj(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
          ctx.strokeStyle = who.color;
          ctx.globalAlpha = lit ? 0.75 : 0.25;
          ctx.lineWidth = lit ? 5 : 3;
          ctx.lineJoin = 'round';
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        const h = mode === 'all' ? (pts && pts.length ? pts[pts.length - 1] : null) : headAt(pts, sec);
        if (h) heads.push({ pid, xy: proj(h), lit });
      }
      for (const h of heads.sort((a, b) => Number(a.lit) - Number(b.lit))) {
        const r = h.lit ? 22 : 14;
        ctx.globalAlpha = h.lit ? 1 : 0.6;
        drawFace(ctx, faces, summary, h.pid, h.xy[0], h.xy[1], r, clock);
        ctx.globalAlpha = 1;
        if (h.lit && rect.h > 300) txt(ctx, person(summary, h.pid).name, h.xy[0] + r + 6, h.xy[1] + 8, { size: 22 });
      }
    }
  }
  ctx.restore();
}

// ---- v1.4.6: the director camera's "everyone" corner map (ring, every player's dot, the main view's frame) ----

export const OVERVIEW = { x: REEL.W - 196, y: 84, w: 176, h: 250 };

function drawOverview(ctx, scene, clock, view, { summary, ring, faces, maps } = {}) {
  const sbox = scene.map && scene.map.box;
  if (!sbox) return;
  const r = OVERVIEW;
  ctx.save();
  round(ctx, r.x, r.y, r.w, r.h, 14);
  ctx.clip();
  drawGrid(ctx, r);
  drawStreets(ctx, maps, sbox, r);
  ctx.fillStyle = 'rgba(7,9,13,0.25)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const v = fitView(sbox, r, 10);
  if (v) {
    const pts = ringPointsOf(ring);
    if (pts.length > 2) {
      ctx.beginPath();
      pts.forEach((p, i) => { const [x, y] = v.toPx(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(230,235,242,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const sec = clock === null ? Infinity : clock / 1000;
    for (const pid of Object.keys((summary && summary.routes) || {}).sort()) {
      const h = headAt(summary.routes[pid], sec);
      if (!h) continue;
      const [x, y] = v.toPx(h);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = ringColor(summary, pid, clock);
      ctx.fill();
    }
    if (view && view.box) {
      // what the big map shows (its view fitted to the whole frame)
      const big = fitView(view.box, { x: 0, y: 0, w: REEL.W, h: REEL.H });
      if (big) {
        const [a0, a1] = big.fromPx(0, 0), [b0, b1] = big.fromPx(REEL.W, REEL.H);
        const [x0, y0] = v.toPxM([a0, a1]), [x1, y1] = v.toPxM([b0, b1]);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }
  ctx.restore();
  round(ctx, r.x, r.y, r.w, r.h, 14);
  ctx.strokeStyle = LINE14;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (view && view.label) {
    txt(ctx, view.label, r.x + r.w, r.y + r.h + 30, { size: 20, align: 'right', color: INK, weight: 600 });
  }
}

// ---- the close-call mini map ----

const miniCache = new WeakMap();
function miniFor(scene, w, h) {
  let c = miniCache.get(scene);
  if (!c || c.w !== w || c.h !== h) { c = { w, h, mm: miniMap(scene.mini, { w, h }) }; miniCache.set(scene, c); }
  return c.mm;
}

function headPx(list, clockMs) {
  if (!list || !list.length || clockMs < list[0][2]) return list && list.length ? [list[0][0], list[0][1]] : null;
  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i], b = list[i + 1];
    if (clockMs >= a[2] && clockMs <= b[2]) {
      const f = b[2] > a[2] ? (clockMs - a[2]) / (b[2] - a[2]) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  const l = list[list.length - 1];
  return [l[0], l[1]];
}

export function drawMiniMap(ctx, mini, { clockMs = Infinity, faces = null, summary = null, x = 0, y = 0, still = false, streets = null } = {}) {
  if (!mini) return;
  const { w, h } = mini.box;
  ctx.save();
  ctx.translate(x, y);
  round(ctx, 0, 0, w, h, 18);
  ctx.clip();
  drawGrid(ctx, { x: 0, y: 0, w, h });
  if (streets) {
    try { ctx.drawImage(streets, 0, 0, w, h); ctx.fillStyle = 'rgba(7,9,13,0.18)'; ctx.fillRect(0, 0, w, h); } catch { /* the grid stays */ }
  }
  // a 10 m scale tick
  const tenM = mini.box.pxPerM * 10;
  ctx.strokeStyle = 'rgba(230,235,242,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(16, h - 18); ctx.lineTo(16 + tenM, h - 18); ctx.stroke();
  txt(ctx, '10 m', 22 + tenM, h - 12, { size: Math.max(14, w / 22), color: DIM, weight: 500, outline: false });
  const ids = mini.ids || [];
  const sides = [[mini.a, ids[0]], [mini.b, ids[1]]];
  const t = still ? Infinity : clockMs;
  for (const [list, pid] of sides) {
    const col = pid ? person(summary, pid).color : ACCENT;
    const upto = list.filter((p) => p[2] <= t);
    if (upto.length > 1) {
      ctx.beginPath();
      upto.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      const head = headPx(list, t);
      if (head && !still) ctx.lineTo(head[0], head[1]);
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(3, w / 90);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }
  const g = mini.gap;
  const past = g && t >= g.clock;
  const ha = still && g ? [g.x1, g.y1] : headPx(mini.a, t);
  const hb = still && g ? [g.x2, g.y2] : headPx(mini.b, t);
  if (ha && hb) {
    const raw = Math.round(Math.hypot(hb[0] - ha[0], hb[1] - ha[1]) / mini.box.pxPerM);
    const m = past || still ? g.m : g ? Math.max(g.m, raw) : raw; // never under the closest before it comes
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = past || still ? '#ffc24a' : INK;
    ctx.lineWidth = past || still ? 4 : 3;
    ctx.beginPath(); ctx.moveTo(ha[0], ha[1]); ctx.lineTo(hb[0], hb[1]); ctx.stroke();
    ctx.setLineDash([]);
    if (past && g) {
      ctx.beginPath();
      ctx.arc((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2, Math.max(14, w / 14), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,194,74,0.6)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    const r = Math.max(12, w / 16);
    const fc = still ? Infinity : clockMs;
    if (ids[0]) drawFace(ctx, faces, summary, ids[0], ha[0], ha[1], r, fc);
    if (ids[1]) drawFace(ctx, faces, summary, ids[1], hb[0], hb[1], r, fc);
    const mx = (ha[0] + hb[0]) / 2, my = Math.min(ha[1], hb[1]) - r - 14;
    txt(ctx, `${m} m`, Math.max(40, Math.min(w - 40, mx)), Math.max(r * 2 + 10, my), { size: Math.max(22, w / (past || still ? 7 : 10)),
      align: 'center', color: past || still ? '#ffc24a' : INK, weight: 700 });
  }
  ctx.restore();
  round(ctx, x, y, w, h, 18);
  ctx.strokeStyle = LINE14;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ---- the pieces of a frame ----

function drawTitle(ctx, scene, t, summary) {
  if (!scene.title || scene.kind === 'stretch' && !scene.title) return;
  const into = t - scene.at;
  const big = into < TITLE_MS && scene.kind !== 'intro' && scene.kind !== 'outro' && scene.kind !== 'gap';
  if (big) {
    const a = Math.min(1, into / 250, (TITLE_MS - into) / 400 + 0.2);
    const y = scene.layout === 'minimap' ? REEL.H - 180 : CAM_H - 150;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    ctx.fillStyle = 'rgba(7,9,13,0.55)';
    ctx.fillRect(0, y - 74, REEL.W, scene.line ? 128 : 96);
    ctx.restore();
    stencil(ctx, scene.title, 36, y, 64, scene.kind === 'caught' || scene.kind === 'tag' ? '#ff5a5a' : scene.kind === 'near' ? '#ffc24a' : INK, Math.max(0, a));
    if (scene.line) txt(ctx, scene.line, 38, y + 40, { size: 30, color: DIM });
  } else if (scene.kind !== 'intro' && scene.kind !== 'outro' && scene.kind !== 'gap' && scene.kind !== 'stretch') {
    // a small tag in the corner for the rest of the scene
    ctx.save();
    ctx.font = '700 22px "Space Grotesk", system-ui, sans-serif';
    const label = String(scene.title).toUpperCase();
    const wd = ctx.measureText(label).width + 28;
    round(ctx, 24, 28, wd, 40, 20);
    ctx.fillStyle = 'rgba(7,9,13,0.7)';
    ctx.fill();
    ctx.restore();
    txt(ctx, String(scene.title).toUpperCase(), 38, 56, { size: 22, color: INK, outline: false });
  }
  void summary;
}

function drawCaption(ctx, scene, clock, y) {
  if (clock === null) return;
  const cap = (scene.captions || []).filter((c) => clock >= c.from && clock < c.to).pop();
  if (!cap) return;
  ctx.font = '600 28px "Space Grotesk", system-ui, sans-serif';
  const lines = wrapLines(ctx, cap.text, REEL.W - 80, 2);
  ctx.save();
  ctx.fillStyle = 'rgba(7,9,13,0.7)';
  round(ctx, 24, y - 40, REEL.W - 48, 24 + lines.length * 36, 14);
  ctx.fill();
  ctx.restore();
  lines.forEach((l, i) => txt(ctx, l, 40, y - 6 + i * 36, { size: 28, weight: 600, outline: false }));
}

function drawProgress(ctx, reel, t) {
  const y = REEL.H - 14, x0 = 24, wd = REEL.W - 48;
  ctx.fillStyle = 'rgba(230,235,242,0.18)';
  ctx.fillRect(x0, y, wd, 5);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(x0, y, wd * Math.max(0, Math.min(1, t / Math.max(1, reel.ms))), 5);
  ctx.fillStyle = INK;
  for (const m of reel.marks || []) ctx.fillRect(x0 + (wd * m.at) / Math.max(1, reel.ms) - 1, y - 4, 3, 13);
}

function drawCard14(ctx14, reel, scene, t, o) {
  const ctx = ctx14;
  drawMap(ctx, scene, null, { x: 0, y: 0, w: REEL.W, h: REEL.H }, { summary: o.summary, ring: o.ring, faces: o.faces, maps: o.maps });
  ctx.fillStyle = 'rgba(7,9,13,0.72)';
  ctx.fillRect(0, 0, REEL.W, REEL.H);
  const into = t - scene.at;
  const a = Math.min(1, into / 500);
  const players = (o.summary && Array.isArray(o.summary.players) ? o.summary.players : []);
  if (scene.kind === 'intro') {
    stencil(ctx, 'NIGHT OPS', REEL.W / 2, 330, 104, ACCENT, a, 'center');
    if (scene.line) txt(ctx, scene.line, REEL.W / 2, 400, { size: 36, align: 'center', color: INK });
    if (scene.date) {
      const d = new Date(scene.date);
      const words = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      txt(ctx, words, REEL.W / 2, 450, { size: 26, align: 'center', color: DIM, weight: 500 });
    }
    const rows = [['HUNTERS', players.filter((p) => p.startTeam === 'hunter' || p.driver)], ['HIDERS', players.filter((p) => p.startTeam === 'hider')]];
    let y = 600;
    rows.forEach(([label, list], ri) => {
      if (!list.length) return;
      const show = Math.max(0, Math.min(1, (into - 600 - ri * 500) / 400));
      ctx.save();
      ctx.globalAlpha = show;
      stencil(ctx, label, REEL.W / 2, y, 34, ri ? TEAM14.hider : TEAM14.hunter, 1, 'center');
      const n = Math.min(list.length, 6);
      const gap = Math.min(110, (REEL.W - 80) / n);
      list.slice(0, 6).forEach((p, i) => {
        const x = REEL.W / 2 + (i - (n - 1) / 2) * gap;
        drawFace(ctx, o.faces, o.summary, p.id, x, y + 80, 42);
        txt(ctx, String(p.name).slice(0, 10), x, y + 156, { size: 22, align: 'center' });
      });
      ctx.restore();
      y += 250;
    });
  } else {
    const winners = scene.people || [];
    stencil(ctx, 'GAME OVER', REEL.W / 2, 240, 70, DIM, a, 'center');
    const n = Math.min(winners.length, 5);
    const gap = Math.min(150, (REEL.W - 80) / Math.max(1, n));
    winners.slice(0, 5).forEach((pid, i) => {
      const x = REEL.W / 2 + (i - (n - 1) / 2) * gap;
      drawFace(ctx, o.faces, o.summary, pid, x, 400, 60);
    });
    ctx.font = '700 48px "Space Grotesk", system-ui, sans-serif';
    const lines = wrapLines(ctx, scene.title, REEL.W - 80, 2);
    lines.forEach((l, i) => stencil(ctx, l, REEL.W / 2, 560 + i * 60, 48, ACCENT, Math.min(1, into / 900), 'center'));
    if (scene.line) txt(ctx, scene.line, REEL.W / 2, 700, { size: 34, align: 'center', color: '#ffc24a' });
    const st = scene.stats || {};
    const tiles = [[String(st.catches || 0), 'catches'], [String(st.closeCalls || 0), 'close calls'],
      [st.distanceM >= 1000 ? `${(st.distanceM / 1000).toFixed(1)} km` : `${st.distanceM || 0} m`, 'walked']];
    tiles.forEach(([big, small], i) => {
      const x = 40 + i * ((REEL.W - 80) / 3) + (REEL.W - 80) / 6;
      const show = Math.max(0, Math.min(1, (into - 1200 - i * 300) / 400));
      ctx.save();
      ctx.globalAlpha = show;
      round(ctx, x - 100, 780, 200, 150, 18);
      ctx.fillStyle = 'rgba(22,32,44,0.9)';
      ctx.fill();
      txt(ctx, big, x, 860, { size: 50, align: 'center', outline: false });
      txt(ctx, small, x, 905, { size: 24, align: 'center', color: DIM, weight: 500, outline: false });
      ctx.restore();
    });
  }
}

// v1.4.7: a split's two sides now: each side's shot, else that person's face (no footage of them at this moment)
function sidesNow(scene, by) {
  const sides = Array.isArray(scene.sides) ? scene.sides : [];
  const pick = (slot, pid) => by(slot)[0] || (pid ? { pid, none: true } : null);
  return [pick('left', sides[0]), pick('right', sides[1])];
}

export function drawFrame(ctx, reel, t, { sources = null, faces = null, summary = null, ring = null, maps = null, w = REEL.W, h = REEL.H, scale = 1, progress = true } = {}) {
  ctx.save();
  ctx.fillStyle = NIGHT;
  ctx.fillRect(0, 0, w, h);
  const k = Math.min(w / REEL.W, h / REEL.H) * (scale > 0 ? 1 : 1);
  ctx.translate((w - REEL.W * k) / 2, (h - REEL.H * k) / 2);
  ctx.scale(k, k);
  ctx.beginPath();
  ctx.rect(0, 0, REEL.W, REEL.H);
  ctx.clip();
  const plan = framePlan(reel, t);
  const scene = plan.scene;
  const o = { sources, faces, summary, ring, maps };
  if (!scene) { ctx.restore(); return plan; }
  const clock = plan.clock;
  const by = (slot) => plan.shots.filter((s) => s.slot === slot);
  const full = { x: 0, y: 0, w: REEL.W, h: REEL.H };
  const lower = { x: 0, y: CAM_H, w: REEL.W, h: REEL.H - CAM_H };
  switch (scene.layout) {
    case 'card':
      drawCard14(ctx, reel, scene, t, o);
      break;
    case 'split': {
      const [left, right] = sidesNow(scene, by);
      drawShot(ctx, sources, summary, left, 0, 0, REEL.W / 2 - 3, CAM_H, { faces, t, clock });
      drawShot(ctx, sources, summary, right, REEL.W / 2 + 3, 0, REEL.W / 2 - 3, CAM_H, { faces, t, clock });
      drawMap(ctx, scene, clock, lower, { summary, ring, faces, maps, focus: scene.people });
      break;
    }
    case 'minimap': {
      const filmed = by('left')[0] || by('right')[0] || null;
      const [left, right] = sidesNow(scene, by);
      const top = filmed ? 380 : 0;
      ctx.fillStyle = PANEL;
      ctx.fillRect(0, 0, REEL.W, REEL.H);
      if (top) {
        drawShot(ctx, sources, summary, left, 20, 20, REEL.W / 2 - 30, top - 40, { small: true, faces, t, clock });
        drawShot(ctx, sources, summary, right, REEL.W / 2 + 10, 20, REEL.W / 2 - 30, top - 40, { small: true, faces, t, clock });
      }
      // the mini map in the middle of what's left; the title and the distance under it
      const size = Math.min(REEL.W - 40, REEL.H - top - 300);
      const y0 = top + Math.max(20, (REEL.H - top - 300 - size) / 2 + 20);
      const mm = miniFor(scene, size, size);
      if (mm) drawMiniMap(ctx, mm, { clockMs: clock, faces, summary, x: (REEL.W - size) / 2, y: y0, streets: maps && typeof maps.mini === 'function' ? maps.mini(scene) : null });
      else drawMap(ctx, scene, clock, { x: 0, y: top, w: REEL.W, h: REEL.H - top }, { summary, ring, faces, maps, focus: scene.people });
      break;
    }
    case 'mapcam': {
      const main = by('main')[0] || by('left')[0] || null;
      // footage that isn't there (not up yet, or past its file's end): the map fills the frame instead
      // (v1.4.7: a dark shot needs no frame: its face and sound wave)
      const hasMain = main && (main.dark || sourceOf(sources, main.id)) && drawShot(ctx, sources, summary, main, 0, 0, REEL.W, CAM_H, { faces, t, clock });
      if (!hasMain && sources !== null) {
        drawMap(ctx, scene, clock, full, { summary, ring, faces, maps, focus: main ? [main.pid] : scene.people });
        drawCaption(ctx, scene, clock, REEL.H - 140);
        break;
      }
      if (!hasMain) drawShot(ctx, sources, summary, main, 0, 0, REEL.W, CAM_H, { faces, t, clock });
      const smalls = by('small').filter((s) => !main || s.pid !== main.pid).slice(0, 3);
      smalls.forEach((s, i) => drawShot(ctx, sources, summary, s, REEL.W - 20 - (i + 1) * 176 + 16, CAM_H - 150, 160, 120, { small: true, faces, t, clock }));
      drawMap(ctx, scene, clock, lower, { summary, ring, faces, maps, focus: main ? [main.pid] : scene.people });
      drawCaption(ctx, scene, clock, CAM_H - 180);
      break;
    }
    case 'single': {
      drawShot(ctx, sources, summary, by('main')[0] || null, 0, 0, REEL.W, REEL.H, { faces, t, clock });
      drawCaption(ctx, scene, clock, REEL.H - 120);
      break;
    }
    default: {
      const view = scene.tour ? tourView(scene, t) : null;
      drawMap(ctx, scene, clock, full, { summary, ring, faces, maps, box: view ? view.box : null,
        focus: view && view.pids.length ? view.pids : scene.people });
      if (view) drawOverview(ctx, scene, clock, view, o);
      if (scene.kind === 'gap') {
        ctx.fillStyle = 'rgba(7,9,13,0.4)';
        ctx.fillRect(0, 0, REEL.W, REEL.H);
        stencil(ctx, scene.title, REEL.W / 2, REEL.H / 2, 64, INK, 1, 'center');
        // the fast-forward mark
        ctx.fillStyle = ACCENT;
        for (let i = 0; i < 2; i += 1) {
          const x = REEL.W / 2 - 36 + i * 40, y = REEL.H / 2 + 70;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 34, y + 22); ctx.lineTo(x, y + 44); ctx.closePath(); ctx.fill();
        }
        if (clock !== null) txt(ctx, fmtClock(clock), REEL.W / 2, REEL.H / 2 + 170, { size: 34, align: 'center', font: 'JetBrains Mono', weight: 500 });
      } else {
        drawCaption(ctx, scene, clock, REEL.H - 140);
      }
    }
  }
  if (scene.kind !== 'intro' && scene.kind !== 'outro' && scene.kind !== 'gap' && clock !== null) {
    txt(ctx, fmtClock(clock), REEL.W - 28, 58, { size: 26, align: 'right', font: 'JetBrains Mono', weight: 500 });
  }
  drawTitle(ctx, scene, t, summary);
  if (scene.people && scene.people.length && scene.kind !== 'intro' && scene.kind !== 'outro' && scene.kind !== 'gap' && t - scene.at >= TITLE_MS && scene.line) {
    txt(ctx, joinNames(scene.people.map((p) => person(summary, p).name)), 38, 100, { size: 24, color: DIM, weight: 500 });
  }
  if (progress) drawProgress(ctx, reel, t); // (the page's player has its own bar)
  ctx.restore();
  return plan;
}
// v1.4 end PAGE-REEL
