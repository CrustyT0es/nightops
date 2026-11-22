// Night Ops v1.4 (PAGE-REEL): "Watch the highlights" / "Watch the whole game" in the page.
//
//   openReel({ app, list, summary, kind, reel, ring, startAt, sceneIndex, doc, win }) -> player
//   player = { play(), pause(), seek(t), close(), on('time'|'end'|'error'|'close', fn), reel, el, stats }
//
// A full-screen layer with one canvas. Every frame is drawFrame(reel, t) from movie.js, the same drawer the file
// renderer uses: what you watch is what you download. One clock: the AudioContext's currentTime while playing
// (else performance.now()) is reel time. Clip frames come from a pool of <video> elements; each frame a video is
// compared with its target: off by more than DRIFT_MS -> playbackRate 0.9 / 1.1 for up to 1 s, over RESEEK_MS -> a
// seek. A video still loading holds its last frame dimmed; the clock never stalls (the audio carries on).
import { h, text } from '../dom.js?v=160';
import { icon } from '../ui/icons.js?v=160';
import { scenes } from '../scenes.js?v=160';
import { drawFrame, framePlan } from '../movie.js?v=160';
import { prepareMaps } from '../moviemap.js?v=160';
import { fmtClock } from '../../shared/rules.js?v=160';

export const VIDEO_POOL = 4;
export const REC_W = 720;              // a recorded file's size (render.js): about 720p, upright
export const REC_H = 1280;
export const DRIFT_MS = 120;
export const RESEEK_MS = 400;
export const NUDGE_MS = 1000;
export const AHEAD_MS = 1500;          // shots this far ahead are loaded early
export const SCHEDULE_AHEAD_S = 0.25;  // audio buffers are started this long before they're due

let open = null; // one player at a time

function urlsFor(app) {
  const got = new Map();
  return async (ids) => {
    const want = ids.filter((id) => !got.has(id));
    for (let i = 0; i < want.length; i += 8) {
      try {
        const r = await app.video('cam-urls', { ids: want.slice(i, i + 8) });
        for (const [id, url] of Object.entries((r && r.urls) || {})) if (typeof url === 'string') got.set(id, url);
      } catch { /* left out */ }
    }
    return Object.fromEntries(ids.filter((id) => got.has(id)).map((id) => [id, got.get(id)]));
  };
}

function facesOf(app, doc) {
  const out = new Map();
  const src = app && app.faces instanceof Map ? app.faces : new Map();
  for (const [id, url] of src) {
    if (typeof url !== 'string' || !url) continue;
    const img = doc.createElement('img');
    img.decoding = 'async';
    img.src = url;
    out.set(id, img);
  }
  return out;
}

// Built-in sounds: no files, no licences. -> AudioBuffer
export function synth(ctx, kind, seconds) {
  const rate = ctx.sampleRate;
  const n = Math.max(1, Math.round(rate * Math.min(seconds, 30)));
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    if (kind === 'whoosh') {
      lp += (rnd() - lp) * (0.02 + 0.2 * Math.sin((Math.PI * i) / n));
      d[i] = lp * 1.6;
    } else if (kind === 'pad') {
      d[i] = 0.18 * (Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 164.8 * t) + 0.4 * Math.sin(2 * Math.PI * 220.5 * t)) / 2;
    } else {
      lp += (rnd() - lp) * 0.03;
      d[i] = lp;
    }
  }
  return buf;
}

export function openReel({
  app, list = [], summary = {}, kind = 'highlights', reel = null, ring = null, startAt = 0, sceneIndex = null,
  doc = globalThis.document, win = globalThis.window, record = false,
} = {}) {
  // record: render.js's file making. The same frames and the same mix, on a fixed REEL-sized canvas, the layer out
  // of sight, and the mix also sent to `player.audioStream` for the recorder. It never starts by itself.
  if (open) { try { open.close(); } catch { /* fine */ } }
  const R = reel || scenes({ summary, clips: list, talk: summary && summary.radio, kind });
  const fns = { time: new Set(), end: new Set(), error: new Set(), close: new Set() };
  const emit = (what, x) => { for (const fn of [...fns[what]]) { try { fn(x); } catch { /* fine */ } } };
  const stats = { seeks: 0, nudges: 0, frames: 0 };
  const getUrls = app && typeof app.video === 'function' ? urlsFor(app) : async () => ({});
  const faces = facesOf(app, doc);
  // a past game's pictures may come after the layer opened (app._pastFaces): take them as they come
  const offFaces = app && typeof app.on === 'function' ? app.on('faces', () => {
    for (const [id, img] of facesOf(app, doc)) if (!faces.has(id)) faces.set(id, img);
  }) : null;
  // the street map under the movie's map (made once; the grid shows until it's there, or for good)
  let maps = null;
  try { maps = prepareMaps(R, { doc, win }); } catch { maps = null; }

  // ---- the layer ----
  const canvas = h('canvas.reel-canvas', { 'aria-hidden': 'true' });
  const playBtn = h('button.reel-btn.reel-play', { type: 'button', 'aria-label': 'Pause' }, icon('pause', 26));
  const backBtn = h('button.reel-btn.reel-skip', { type: 'button', 'aria-label': 'Back 10 seconds' }, icon('skipback', 22), h('span.reel-skip-n', { 'aria-hidden': 'true' }, '10'));
  const fwdBtn = h('button.reel-btn.reel-skip', { type: 'button', 'aria-label': 'Forward 10 seconds' }, icon('skipfwd', 22), h('span.reel-skip-n', { 'aria-hidden': 'true' }, '10'));
  const closeBtn = h('button.reel-btn.reel-close', { type: 'button', 'aria-label': 'Close' }, icon('close', 24));
  const timeEl = h('span.reel-time', '0:00');
  const nowEl = h('p.reel-now.sr-only', { 'aria-live': 'polite' });
  const bar = h('div.reel-bar', { role: 'group', 'aria-label': 'Scenes' });
  const fillEl = h('span.reel-bar-fill');
  bar.append(fillEl);
  for (const m of R.marks || []) {
    const b = h('button.reel-tick', { type: 'button', style: { left: `${(100 * m.at) / Math.max(1, R.ms)}%` },
      'aria-label': `${m.title ? m.title.toLowerCase() : 'scene'} at ${fmtClock(m.at)}` });
    b.addEventListener('click', (e) => { e.stopPropagation(); seek(m.at); });
    bar.append(b);
  }
  bar.addEventListener('click', (e) => {
    const r = bar.getBoundingClientRect();
    if (r.width > 0) seek(((e.clientX - r.left) / r.width) * R.ms);
  });
  const title = kind === 'whole' ? 'The whole game' : 'Highlights';
  const el = h('div.reel-layer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    canvas,
    h('div.reel-top', h('span.reel-name', title), timeEl, closeBtn),
    h('div.reel-foot', backBtn, playBtn, fwdBtn, bar),
    nowEl);
  if (record) el.classList.add('reel-recording');
  doc.body.append(el);
  if (record) { canvas.width = REC_W; canvas.height = REC_H; }
  const ctx2d = canvas.getContext('2d');

  // ---- audio ----
  let ac = null;
  try { const AC = win.AudioContext || win.webkitAudioContext; if (AC) ac = new AC(); } catch { ac = null; }
  const master = ac ? ac.createGain() : null;
  let audioStream = null;
  if (master) {
    if (record) {
      try { const dest = ac.createMediaStreamDestination(); master.connect(dest); audioStream = dest.stream; } catch { audioStream = null; }
    } else master.connect(ac.destination);
  }
  const buffers = new Map(); // 'walkie:n' | 'sting:x' -> AudioBuffer
  const playing = []; // scheduled sources
  async function loadBuffers() {
    if (!ac) return;
    for (const tr of R.audio) {
      if (tr.kind === 'sting') {
        const key = `sting:${tr.src}`;
        if (!buffers.has(key)) buffers.set(key, synth(ac, tr.src, tr.src === 'tone' ? 8 : tr.ms / 1000 + 0.5));
      }
    }
    for (const tr of R.audio) {
      if ((tr.kind !== 'walkie' && tr.kind !== 'tap') || tr.src === null) continue;
      const key = `walkie:${tr.src}`;
      if (buffers.has(key) || !app || typeof app.clip !== 'function') continue;
      try {
        const got = await app.clip(tr.src);
        if (!got || !got.url) continue;
        const data = await (await fetch(got.url)).arrayBuffer();
        buffers.set(key, await ac.decodeAudioData(data));
        if (state.playing) schedule(); // a late one still plays from where it is
      } catch { /* left out: the camera carries on */ }
    }
  }

  function unschedule() {
    while (playing.length) { const p = playing.pop(); try { p.src.stop(); } catch { /* fine */ } try { p.src.disconnect(); } catch { /* fine */ } }
  }
  const scheduled = new Set();
  function schedule() {
    if (!ac || !state.playing) return;
    const t = now();
    for (const tr of R.audio) {
      if (tr.kind === 'cam') continue;
      const id = `${tr.kind}:${tr.src}:${tr.at}`;
      if (scheduled.has(id)) continue;
      if (tr.at + tr.ms <= t || tr.at > t + 4000) continue;
      const buf = buffers.get(tr.kind === 'sting' ? `sting:${tr.src}` : `walkie:${tr.src}`);
      if (!buf) continue;
      scheduled.add(id);
      const src = ac.createBufferSource();
      src.buffer = buf;
      if (tr.src === 'tone') src.loop = true;
      const g = ac.createGain();
      src.connect(g);
      g.connect(master);
      const base = ac.currentTime - t / 1000; // ctx time of reel 0
      const startAt = Math.max(ac.currentTime, base + tr.at / 1000);
      const offset = Math.max(0, (Math.max(t, tr.at) - tr.at) / 1000);
      g.gain.setValueAtTime(0, ac.currentTime);
      for (const [rt, v] of tr.gain || [[tr.at, 1], [tr.at + tr.ms, 1]]) {
        const when = base + rt / 1000;
        if (when >= ac.currentTime) g.gain.linearRampToValueAtTime(v, when);
        else g.gain.setValueAtTime(v, ac.currentTime);
      }
      try {
        if (src.loop) src.start(startAt, offset % buf.duration, Math.max(0, (tr.at + tr.ms - Math.max(t, tr.at)) / 1000));
        else src.start(startAt, offset);
      } catch { continue; }
      playing.push({ src, g });
    }
  }

  // ---- videos ----
  const pool = [];
  for (let i = 0; i < VIDEO_POOL; i += 1) {
    const v = doc.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.className = 'reel-video';
    const slot = { v, id: null, used: 0, gain: null, ready: false, rateUntil: 0 };
    if (ac) {
      try { const s = ac.createMediaElementSource(v); slot.gain = ac.createGain(); slot.gain.gain.value = 0; s.connect(slot.gain); slot.gain.connect(master); } catch { slot.gain = null; }
    }
    if (!slot.gain) v.muted = true;
    v.addEventListener('loadeddata', () => { slot.ready = true; });
    el.append(v); // in the page (hidden) so iPhones decode frames
    pool.push(slot);
  }
  let useN = 0;
  const urlWait = new Map();
  function slotFor(id) {
    const have = pool.find((s) => s.id === id);
    if (have) { have.used = ++useN; return have; }
    return null;
  }
  function ask(s, id) {
    // the link (asked once at a time; a miss is asked again a little later)
    if (s.asking) return;
    const last = urlWait.get(id);
    if (last && last.missAt && perf() - last.missAt < 2000) return;
    s.asking = true;
    const late = new Promise((resolve) => setTimeout(() => resolve(null), 8000)); // never wait for ever
    Promise.race([getUrls([id]), late]).then((got) => {
      s.asking = false;
      if (!got || !got[id]) { urlWait.set(id, { missAt: perf() }); return; }
      urlWait.delete(id);
      if (s.id !== id) return;
      s.v.src = got[id];
      try { s.v.load(); } catch { /* fine */ }
    }, () => { s.asking = false; urlWait.set(id, { missAt: perf() }); });
  }
  function claim(id, keep) {
    let s = slotFor(id);
    if (s) { if (!s.v.getAttribute('src')) ask(s, id); return s; }
    s = pool.filter((x) => !keep.has(x.id)).sort((a, b) => a.used - b.used)[0];
    if (!s) return null;
    s.id = id; s.used = ++useN; s.ready = false;
    try { s.v.pause(); } catch { /* fine */ }
    s.v.removeAttribute('src');
    ask(s, id);
    return s;
  }

  // ---- the clock ----
  const state = { playing: false, t: Math.max(0, startAt), base: 0, closed: false, raf: 0 };
  if (Number.isInteger(sceneIndex) && R.scenes[sceneIndex]) state.t = R.scenes[sceneIndex].at;
  const perf = () => (win.performance ? win.performance.now() : Date.now());
  let useAc = false; // the clock: the AudioContext's once it runs, else performance.now()
  const clockNow = () => (useAc ? ac.currentTime * 1000 : perf());
  function now() {
    if (!state.playing) return state.t;
    return Math.min(R.ms, clockNow() - state.base);
  }

  function wanted(t) {
    // what the frame needs now, the camera audio playing now, and what's coming
    const need = new Map(); // id -> { fileAt, gain, show }
    const plan = framePlan(R, t);
    for (const s of plan.shots) need.set(s.id, { fileAt: s.fileAt, gain: 0, show: true });
    for (const tr of R.audio) {
      if (tr.kind !== 'cam' || t < tr.at || t >= tr.at + tr.ms) continue;
      const fa = tr.fileAt + (t - tr.at) / 1000;
      const g = gainAt(tr, t);
      const was = need.get(tr.src);
      if (was) was.gain = Math.max(was.gain, g);
      else need.set(tr.src, { fileAt: fa, gain: g, show: false });
    }
    const ahead = framePlan(R, t + AHEAD_MS);
    for (const s of ahead.shots) if (!need.has(s.id)) need.set(s.id, { fileAt: s.fileAt, gain: 0, show: false, ahead: true });
    return { plan, need };
  }
  function gainAt(tr, t) {
    const g = tr.gain;
    if (!g || !g.length) return 1;
    for (let i = 0; i < g.length - 1; i += 1) {
      if (t >= g[i][0] && t <= g[i + 1][0]) {
        const span = g[i + 1][0] - g[i][0];
        return span ? g[i][1] + (g[i + 1][1] - g[i][1]) * ((t - g[i][0]) / span) : g[i + 1][1];
      }
    }
    return t < g[0][0] ? g[0][1] : g[g.length - 1][1];
  }

  function sync(t, need) {
    const keep = new Set(need.keys());
    for (const [id, want] of need) {
      const s = claim(id, keep);
      if (!s) continue;
      const v = s.v;
      if (s.gain) s.gain.gain.value = want.gain;
      if (!v.src || v.readyState < 1) continue;
      const target = want.fileAt;
      const off = (v.currentTime - target) * 1000;
      if (Math.abs(off) > RESEEK_MS || (!state.playing && Math.abs(off) > 40) || (want.ahead && v.paused)) {
        if (!v.seeking) { try { v.currentTime = Math.max(0, target); stats.seeks += 1; } catch { /* fine */ } }
      } else if (Math.abs(off) > DRIFT_MS) {
        v.playbackRate = off > 0 ? 0.9 : 1.1;
        s.rateUntil = perf() + NUDGE_MS;
        stats.nudges += 1;
      } else if (perf() > s.rateUntil && v.playbackRate !== 1) {
        v.playbackRate = 1;
      }
      if (state.playing && !want.ahead && v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      if ((!state.playing || want.ahead) && !v.paused) { try { v.pause(); } catch { /* fine */ } }
    }
    for (const s of pool) {
      if (s.id && !keep.has(s.id)) {
        if (s.gain) s.gain.gain.value = 0;
        if (!s.v.paused) { try { s.v.pause(); } catch { /* fine */ } }
      }
    }
  }

  function size() {
    if (record) return;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const w = Math.max(1, Math.round((canvas.clientWidth || el.clientWidth || 390) * dpr));
    const hh = Math.max(1, Math.round((canvas.clientHeight || el.clientHeight || 844) * dpr));
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
  }

  let lastScene = -1;
  function frame() {
    if (state.closed) return;
    const t = now();
    const { plan, need } = wanted(t);
    sync(t, need);
    size();
    const sources = new Map();
    for (const s of plan.shots) {
      const slot = slotFor(s.id);
      if (slot && slot.v.readyState >= 2) sources.set(s.id, { img: slot.v, stale: slot.v.seeking });
    }
    try { drawFrame(ctx2d, R, t, { sources, faces, summary, ring, maps, w: canvas.width, h: canvas.height, progress: false }); } catch (e) { emit('error', e); }
    stats.frames += 1;
    fillEl.style.width = `${(100 * t) / Math.max(1, R.ms)}%`;
    text(timeEl, `${fmtClock(t)} / ${fmtClock(R.ms)}`);
    if (plan.index !== lastScene) {
      lastScene = plan.index;
      const sc = plan.scene;
      if (sc && sc.title) text(nowEl, [sc.title.toLowerCase(), sc.line].filter(Boolean).join(': '));
    }
    emit('time', t);
    if (state.playing) {
      schedule();
      if (t >= R.ms) { pause(); state.t = R.ms; emit('end'); return; }
      state.raf = win.requestAnimationFrame(frame);
    }
  }

  function setPlayIcon(paused) {
    playBtn.replaceChildren(icon(paused ? 'play' : 'pause', 26));
    playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }

  function play() {
    if (state.closed || state.playing) return;
    if (state.t >= R.ms) state.t = 0;
    try { if (ac && ac.state !== 'running') ac.resume(); } catch { /* fine */ }
    state.playing = true;
    useAc = !!(ac && ac.state === 'running');
    state.base = clockNow() - state.t;
    scheduled.clear();
    unschedule();
    setPlayIcon(false);
    schedule();
    win.cancelAnimationFrame(state.raf);
    state.raf = win.requestAnimationFrame(frame);
  }
  function pause() {
    if (!state.playing) return;
    state.t = now();
    state.playing = false;
    unschedule();
    scheduled.clear();
    for (const s of pool) { try { s.v.pause(); } catch { /* fine */ } }
    setPlayIcon(true);
    frame();
  }
  function seek(t) {
    const was = state.playing;
    if (was) pause();
    state.t = Math.max(0, Math.min(R.ms, Number(t) || 0));
    frame();
    if (was) play();
  }
  // The AudioContext's clock may start later than performance.now(): when it starts, carry on from where we were.
  if (ac && typeof ac.addEventListener === 'function') {
    ac.addEventListener('statechange', () => {
      if (!state.playing || useAc || ac.state !== 'running') return;
      const t = now();
      useAc = true;
      state.base = clockNow() - t;
      scheduled.clear();
      unschedule();
      schedule();
    });
  }
  const onHide = () => { if (!record && doc.hidden && state.playing) pause(); };
  doc.addEventListener('visibilitychange', onHide);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === ' ' && e.target === doc.body) { e.preventDefault(); if (state.playing) pause(); else play(); }
  };
  doc.addEventListener('keydown', onKey);

  function close() {
    if (state.closed) return;
    pause();
    state.closed = true;
    try { if (offFaces) offFaces(); } catch { /* fine */ }
    win.cancelAnimationFrame(state.raf);
    doc.removeEventListener('visibilitychange', onHide);
    doc.removeEventListener('keydown', onKey);
    for (const s of pool) { try { s.v.pause(); s.v.removeAttribute('src'); s.v.load(); } catch { /* fine */ } }
    try { if (ac) ac.close(); } catch { /* fine */ }
    el.remove();
    if (open === player) open = null;
    emit('close');
  }
  playBtn.addEventListener('click', () => (state.playing ? pause() : play()));
  backBtn.addEventListener('click', () => seek(now() - 10000));
  fwdBtn.addEventListener('click', () => seek(now() + 10000));
  closeBtn.addEventListener('click', close);
  canvas.addEventListener('click', () => (state.playing ? pause() : play()));

  const player = {
    maps,
    mapsReady: maps ? maps.done : Promise.resolve(false),
    reel: R, el, stats, canvas, pool, audioStream, record, ready: () => loadingBuffers,
    play, pause, seek, close,
    time: () => now(),
    on(what, fn) { if (!fns[what] || typeof fn !== 'function') return () => {}; fns[what].add(fn); return () => fns[what].delete(fn); },
  };
  open = player;
  try { globalThis.__nightopsReel = player; } catch { /* fine */ } // for the browser checks
  const loadingBuffers = loadBuffers();
  frame();
  if (!record) {
    try { closeBtn.focus(); } catch { /* fine */ }
    play();
  }
  return player;
}
