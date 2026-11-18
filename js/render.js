// Night Ops v1.4 (PAGE-RENDER): "Download" for Highlights and The whole game.
//
//   downloadReel({ app, reel, summary, list, ring })         the sheet, the making, then Share / Save
//   renderReel({ app, reel, summary, ring, signal, onProgress, small }) -> { blob, type, name, size }
//
// The file is made from the SAME player the page shows (screens/reelplayer.js with record: true): the same scene
// list, drawFrame frames, sync and audio mix (J-cuts, crossfades, ducking), so what you watch is what you download.
// It's recorded in real time with MediaRecorder (canvas.captureStream + the mix's MediaStreamDestination), and each
// second's piece is written straight to the Origin Private File System, so a 45-min file never sits in memory
// (memory only where OPFS is missing, and then only up to MEMORY_MOST). About 720p at a rate that keeps 45 min
// near 400 MB; storage.estimate is checked first and a smaller size offered when space is short. Paused while the
// page is hidden (a hidden page's frames stop) and carried on when it's back; the screen kept on; Cancel any time.
import { h, text } from './dom.js?v=151';
import { openSheet } from './ui/sheet.js?v=151';
import { fmtClock } from '../shared/rules.js?v=151';
import { createMp4Muxer } from './mp4mux.js?v=151';
import { openSink as openFileSink, clearMovies } from './sink.js?v=151';

export const TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const FPS = 30;
export const AUDIO_BITS = 96000;
export const FULL_BITS = 1150000;          // video: 45 min x (1.15 + 0.096) Mbit/s = about 420 MB
export const SMALL_BITS = 500000;          // "Smaller file": about half
export const SLICE_MS = 1000;
export const MEMORY_MOST = 300e6;          // without OPFS, a file this big is all a phone can hold
export const SPACE_SPARE = 1.25;           // room asked for on top of the expected size

export function recType(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return Recorder ? 'video/webm' : '';
  for (const t of TYPES) { try { if (Recorder.isTypeSupported(t)) return t; } catch { /* next */ } }
  return '';
}

// The expected size in bytes of a reel `ms` long.
export function sizeFor(ms, small = false) {
  return Math.round(((Math.max(0, ms) / 1000) * ((small ? SMALL_BITS : FULL_BITS) + AUDIO_BITS)) / 8);
}

// estimate = navigator.storage.estimate()'s answer (or null). -> 'full' | 'small' | 'none' | 'unknown'
export function roomFor(ms, estimate) {
  if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return 'unknown';
  const free = estimate.quota - estimate.usage;
  if (free >= sizeFor(ms) * SPACE_SPARE) return 'full';
  if (free >= sizeFor(ms, true) * SPACE_SPARE) return 'small';
  return 'none';
}

export function fileName(kind, code, type) {
  const ext = String(type).startsWith('video/mp4') ? 'mp4' : 'webm';
  const what = kind === 'whole' ? 'whole game' : 'Highlights';
  return `Night Ops ${String(code || 'game').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'game'} ${what}.${ext}`;
}

// Where the recorder's pieces go. -> { write(blob), done() -> Blob, drop(), where: 'disk'|'memory', bytes }
// It goes through sink.js (the 'movies' folder, createWritable or the Worker's sync access handle, which is what
// an iPhone has), so old files are cleared there; files a 1.4 build left in the root are cleared too.
export async function openSink({ storage = globalThis.navigator && globalThis.navigator.storage, name = 'movie', type = 'video/webm', Blob: B = globalThis.Blob, most = MEMORY_MOST, Worker: W = globalThis.Worker } = {}) {
  await clearRootParts(storage);
  const file = await openFileSink({ name: `rec-${name}`, type, storage, Worker: W, Blob: B, most });
  const sink = { where: file.kind === 'memory' ? 'memory' : 'disk', bytes: 0 };
  let chain = Promise.resolve(), failed = null;
  sink.write = (blob) => {
    if (!blob || !blob.size) return chain;
    if (sink.where === 'memory' && sink.bytes + blob.size > most) throw Object.assign(new Error("The movie got too big for this phone's memory. Pick the smaller file or the highlights."), { name: 'TooBig' });
    sink.bytes += blob.size;
    chain = chain.then(async () => { if (!failed) await file.write(new Uint8Array(await blob.arrayBuffer())); }).catch((e) => { failed = failed || e; });
    return chain;
  };
  sink.done = async () => { await chain; if (failed) throw failed; const f = await file.close(); return f.type ? f : new B([f], { type }); };
  sink.drop = async () => { try { await chain; } catch { /* fine */ } try { await file.abort(); } catch { /* fine */ } };
  return sink;
}

// Night Ops 1.4's first recorder path left nightops-*.part files in the OPFS root: they go.
export async function clearRootParts(storage = globalThis.navigator && globalThis.navigator.storage) {
  try {
    const root = await storage.getDirectory();
    if (!root || typeof root.entries !== 'function') return;
    const gone = [];
    for await (const [n, h] of root.entries()) if (/^nightops-.*\.part$/.test(n) && (!h || h.kind !== 'directory')) gone.push(n);
    for (const n of gone) { try { await root.removeEntry(n); } catch { /* in use */ } }
  } catch { /* fine */ }
}

export async function renderReel({
  app, reel, summary = {}, ring = null, signal = null, small = false, onProgress = () => {}, code = '',
  doc = globalThis.document, win = globalThis.window, open = null, way = null,
} = {}) {
  if (!code) code = codeOf(app);
  const how = way || (await chooseWay(win));
  if (how.way === 'webcodecs') return renderFast({ app, reel, summary, ring, signal, small, onProgress, code, doc, win, how });
  const Recorder = win.MediaRecorder;
  const type = recType(Recorder);
  if (!type) throw new Error("This phone can't make a movie file. Watch it here instead.");
  const openReel = open || (await import('./screens/reelplayer.js?v=151')).openReel;
  const player = openReel({ app, summary, reel, ring, kind: reel.kind, record: true, doc, win });
  // the street map's pictures first (never longer than MAPS_WAIT_MS: then the grid)
  if (player.mapsReady) await Promise.race([player.mapsReady.catch(() => false), sleep(MAPS_WAIT_MS)]);
  const total = Math.max(1, reel.ms || player.reel.ms);
  const cv = player.canvas;
  let stream = null;
  try { stream = cv.captureStream(FPS); } catch { stream = null; }
  if (!stream) { player.close(); throw new Error("This phone can't make a movie file. Watch it here instead."); }
  if (player.audioStream) for (const tr of player.audioStream.getAudioTracks()) stream.addTrack(tr);
  const sink = await openSink({ storage: win.navigator && win.navigator.storage, name: reel.kind, type: type.split(';')[0], Blob: win.Blob, Worker: win.Worker });
  const rec = new Recorder(stream, { mimeType: type, videoBitsPerSecond: small ? SMALL_BITS : FULL_BITS, audioBitsPerSecond: AUDIO_BITS });
  let failed = null;
  rec.ondataavailable = (e) => { try { sink.write(e.data); } catch (err) { failed = err; stop(); } };
  let ended = false, paused = false, resolveEnd;
  const over = new Promise((res) => { resolveEnd = res; });
  function stop() { if (ended) return; ended = true; resolveEnd(); }
  player.on('end', stop);
  player.on('error', () => {});
  const onAbort = () => stop();
  if (signal) { if (signal.aborted) stop(); signal.addEventListener('abort', onAbort); }
  const startedAt = win.performance.now();
  let pausedMs = 0, pauseFrom = 0;
  const onVis = () => {
    if (ended) return;
    if (doc.hidden && !paused) {
      paused = true; pauseFrom = win.performance.now();
      try { player.pause(); } catch { /* fine */ }
      try { if (rec.state === 'recording') rec.pause(); } catch { /* fine */ }
      onProgress({ at: player.time(), total, paused: true, left: null, bytes: sink.bytes });
    } else if (!doc.hidden && paused) {
      paused = false; pausedMs += win.performance.now() - pauseFrom;
      try { if (rec.state === 'paused') rec.resume(); } catch { /* fine */ }
      try { player.play(); } catch { /* fine */ }
    }
  };
  doc.addEventListener('visibilitychange', onVis);
  const offTime = player.on('time', (t) => {
    if (paused) return;
    const spent = win.performance.now() - startedAt - pausedMs;
    const left = t > 2000 ? Math.max(0, (spent / t) * (total - t)) : null;
    onProgress({ at: t, total, paused: false, left, bytes: sink.bytes });
  });
  try { app && app.alerts && app.alerts.keepAwake && app.alerts.keepAwake(true, 'movie'); } catch { /* fine */ }
  try {
    try { await Promise.race([player.ready(), new Promise((r) => setTimeout(r, 8000))]); } catch { /* the cameras carry on */ }
    if (!ended) { rec.start(SLICE_MS); player.play(); }
    await over;
    await new Promise((res) => {
      if (rec.state === 'inactive') { res(); return; }
      rec.onstop = () => res();
      try { rec.stop(); } catch { res(); }
    });
  } finally {
    offTime();
    doc.removeEventListener('visibilitychange', onVis);
    if (signal) signal.removeEventListener('abort', onAbort);
    try { for (const tr of stream.getTracks()) tr.stop(); } catch { /* fine */ }
    try { player.close(); } catch { /* fine */ }
    try { app && app.alerts && app.alerts.keepAwake && app.alerts.keepAwake(false, 'movie'); } catch { /* fine */ }
  }
  if (failed || (signal && signal.aborted)) {
    await sink.drop();
    if (failed) throw failed;
    throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  }
  const blob = await sink.done();
  const base = type.split(';')[0];
  return { blob, type: base, name: fileName(reel.kind, code, base), size: blob.size, where: sink.where };
}

function mb(n) { return `${Math.max(1, Math.round(n / 1e6))} MB`; }

// The whole thing with its sheets. Resolves when the file was offered (or the person cancelled).
export async function downloadReel({ app, reel, summary = {}, ring = null, code = '', doc = globalThis.document, win = globalThis.window } = {}) {
  if (!reel || !reel.scenes || !reel.scenes.length) throw new Error('Nothing to make a movie from yet.');
  const how = await chooseWay(win);
  if (how.way === 'none') throw new Error(NO_WAY);
  if (!code) code = codeOf(app);
  try { if (win.navigator.storage && win.navigator.storage.persist) win.navigator.storage.persist().catch(() => {}); } catch { /* fine */ }
  await clearRootParts(win.navigator && win.navigator.storage); // leftovers first, so the estimate is fair
  let est = null;
  try { est = win.navigator.storage && win.navigator.storage.estimate ? await win.navigator.storage.estimate() : null; } catch { est = null; }
  const room = roomFor(reel.ms, est);
  if (room === 'none') throw new Error(`Not enough space on this phone for this movie (about ${mb(sizeFor(reel.ms, true))}). Free some space, or pick Highlights.`);
  const fast = how.way === 'webcodecs';
  const est2 = (sm) => renderPlan({ reel, quality: sm ? 'small' : 'normal' }).estBytes;
  const small = await new Promise((res) => {
    const len = `${fmtClock(reel.ms)} long, about ${mb(fast ? est2(room === 'small') : sizeFor(reel.ms, room === 'small'))}.`;
    const lines = [h('p.cam-sheet-line', len), h('p.cam-sheet-line.muted', fast
      ? "Keep Night Ops open and the screen on. It pauses if you leave and carries on when you're back."
      : "It plays through once while it's made. Keep Night Ops open: it pauses if you leave and carries on when you're back.")];
    if (room === 'small') lines.push(h('p.cam-sheet-line', 'Your phone is low on space, so it will be the smaller file.'));
    const actions = [{ label: 'Make the file', kind: 'primary', onClick: () => res(room === 'small') }];
    if (room !== 'small') actions.push({ label: `Small (about ${mb(fast ? est2(true) : sizeFor(reel.ms, true))})`, kind: 'ghost', onClick: () => res(true) });
    actions.push({ label: 'Cancel', kind: 'ghost', onClick: () => res(null) });
    openSheet({ title: reel.kind === 'whole' ? 'Download the whole game' : 'Download the highlights', body: lines, actions, onClose: () => res(null) });
  });
  if (small === null) return null;
  const ctrl = new AbortController();
  const line = h('p.cam-sheet-line.render-line', { role: 'status', 'aria-live': 'polite' }, 'Getting ready...');
  const fillEl = h('span.cam-bar-fill');
  const barEl = h('div.cam-bar.render-bar', { role: 'progressbar', 'aria-label': 'Making your movie', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fillEl);
  const sheet = openSheet({ title: 'Making your movie', body: [line, barEl], dismissable: false, actions: [{ label: 'Cancel', kind: 'ghost', onClick: () => ctrl.abort() }] });
  let got;
  try {
    got = await renderReel({ app, reel, summary, ring, code, small, signal: ctrl.signal, doc, win, onProgress: ({ at, total, paused, left }) => {
      const pct = Math.min(100, Math.round((at / total) * 100));
      fillEl.style.width = `${pct}%`;
      barEl.setAttribute('aria-valuenow', String(pct));
      text(line, paused ? 'Paused: come back to Night Ops to carry on.'
        : `Making ${reel.kind === 'whole' ? 'The whole game' : 'Highlights'}: ${fmtClock(at)} of ${fmtClock(total)}${left !== null ? `. About ${leftWords(left)} left` : ''}`);
    } });
  } finally { try { sheet.close(); } catch { /* fine */ } }
  offer(got, doc, win);
  return got;
}

function offer({ blob, type, name }, doc, win) {
  const url = win.URL.createObjectURL(blob);
  let file = null;
  try { file = new win.File([blob], name, { type }); } catch { file = null; }
  const nav = win.navigator;
  const canShare = !!(file && nav.share && nav.canShare && nav.canShare({ files: [file] }));
  const save = h('a.btn.wide.cam-save', { href: url, download: name }, h('span', 'Save'));
  if (!canShare) save.classList.add('primary');
  const actions = [];
  if (canShare) actions.push({ label: 'Share', kind: 'primary', keepOpen: true, onClick: async () => { try { await nav.share({ files: [file], title: name }); } catch { /* cancelled */ } } });
  actions.push({ label: 'Done', kind: canShare ? 'ghost' : '' });
  openSheet({ title: 'Your movie is ready', body: [h('p.cam-sheet-line', `${name}, ${mb(blob.size)}`), h('p.cam-sheet-line.muted', 'iPhone: Share > Save Video puts it in Photos, Save to Files in the Files app.'), save], actions,
    onClose: () => setTimeout(() => { win.URL.revokeObjectURL(url); }, 60000) });
  try { doc.documentElement.dataset.movie = String(blob.size); doc.documentElement.dataset.movieType = type; } catch { /* fine */ }
}

// ---------------------------------------------------------------------------------------------------------------
// v1.4: the faster way. WebCodecs encodes each frame drawFrame draws (map-only stretches as fast as the encoder
// takes), audio mixed in AUDIO_PIECE_S pieces with an OfflineAudioContext, written by mp4mux.js into the OPFS sink.

export const MAPS_WAIT_MS = 30000; // the street map may hold the start of a movie this long at most
export const NO_WAY = "This phone can't make the movie. Try on a computer with Chrome.";
export const AUDIO_PIECE_S = 10;
export const AUDIO_RATE = 48000;
export const CAM_AUDIO_LRU = 6;
export const KEY_EVERY_S = 2;
export const QUEUE_MOST = 30;
export const PENDING_MOST = 16e6;            // bytes waiting for the file: the frames wait past this
export const DRIFT_S = 0.12;                 // a camera this far from its frame waits (behind) or holds (ahead)
export const SEEK_GAP_S = 1;                 // further than this (a cut, a jump) it seeks: the only time it does

// What a playing camera video needs for the frame at `at` (seconds in its file), its time now being `cur`:
// 'ok' draw it, 'wait' let it play on to the frame, 'hold' pause it until the frames catch up, 'seek' jump.
// The videos play at their own speed; seeking every frame decoded each clip again from its last keyframe.
export function seekStep(at, cur) {
  const d = at - (Number(cur) || 0);
  if (Math.abs(d) > SEEK_GAP_S) return 'seek';
  if (d > DRIFT_S) return 'wait';
  if (d < -DRIFT_S) return 'hold';
  return 'ok';
}

// A codec closed by the browser while the page was in the background (Chrome reclaims idle ones with a
// QuotaExceededError) is made again; it isn't a failure.
export function reclaimed(e) {
  return !!e && (e.name === 'QuotaExceededError' || /reclaim/i.test(String(e.message || '')));
}
const VIDEO_CODECS = ['avc1.42E01F', 'vp09.00.31.08'];
const AUDIO_CODECS = ['mp4a.40.2', 'opus'];

function codeOf(app) {
  const g = app && (app.pastGame || app.game);
  return g && g.code ? g.code : '';
}

function leftWords(ms) {
  const m = Math.round(ms / 60000);
  return m >= 1 ? `${m} min` : `${Math.max(5, Math.round(ms / 5000) * 5)} s`;
}

// Sizes and rates. normal 720x1280, small 540x960; highlights 2.5 / 1.2 Mbps, the whole game 1.0 / 0.6.
export function renderPlan({ reel, quality = 'normal' } = {}) {
  const small = quality === 'small';
  const whole = reel && reel.kind === 'whole';
  const w = small ? 540 : 720, hh = small ? 960 : 1280;
  const videoBits = whole ? (small ? 600000 : 1000000) : (small ? 1200000 : 2500000);
  const audioBits = 64000;
  const fps = whole ? 24 : 30;
  const ms = Math.max(0, (reel && reel.ms) || 0);
  return { w, h: hh, fps, videoBits, audioBits, estBytes: Math.round(((ms / 1000) * (videoBits + audioBits)) / 8 * 1.03) };
}

export async function chooseWay(win = globalThis.window) {
  const none = { way: 'none' };
  const rec = recType(win && win.MediaRecorder) ? { way: 'recorder', container: String(recType(win.MediaRecorder)).includes('mp4') ? 'mp4' : 'webm', sink: 'opfs' } : none;
  if (!win || !win.VideoEncoder || !win.AudioEncoder || !win.VideoFrame || !win.AudioData || !(win.OfflineAudioContext || win.webkitOfflineAudioContext)) return rec;
  let video = null, audio = null;
  for (const codec of VIDEO_CODECS) {
    const config = { codec, width: 720, height: 1280, bitrate: 2500000, framerate: 30, ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) };
    try { if ((await win.VideoEncoder.isConfigSupported(config)).supported) { video = config; break; } } catch { /* next */ }
  }
  for (const codec of AUDIO_CODECS) {
    const config = { codec, sampleRate: AUDIO_RATE, numberOfChannels: 1, bitrate: 64000 };
    try { if ((await win.AudioEncoder.isConfigSupported(config)).supported) { audio = config; break; } } catch { /* next */ }
  }
  if (!video || !audio) return rec;
  let sink = 'memory';
  try { if (win.navigator.storage && win.navigator.storage.getDirectory) sink = win.FileSystemWritableFileStream ? 'opfs' : 'opfs-worker'; } catch { /* memory */ }
  return { way: 'webcodecs', video, audio, container: 'mp4', sink };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitFor(el, what, ms) {
  return new Promise((res) => {
    let done = false;
    const fin = (ok) => { if (done) return; done = true; el.removeEventListener(what, on); res(ok); };
    const on = () => fin(true);
    el.addEventListener(what, on);
    setTimeout(() => fin(false), ms);
  });
}

async function linksFor(app, ids) {
  const got = {};
  if (!app || typeof app.video !== 'function') return got;
  for (let i = 0; i < ids.length; i += 8) {
    try { const r = await app.video('cam-urls', { ids: ids.slice(i, i + 8) }); Object.assign(got, (r && r.urls) || {}); } catch { /* left out */ }
  }
  return got;
}

export async function renderFast({ app, reel, summary = {}, ring = null, signal = null, small = false, onProgress = () => {}, code = '', doc = globalThis.document, win = globalThis.window, how = null } = {}) {
  const way = how || (await chooseWay(win));
  if (way.way !== 'webcodecs') throw new Error(NO_WAY);
  const { drawFrame, framePlan, audioAt } = await import('./movie.js?v=151');
  const { synth } = await import('./screens/reelplayer.js?v=151');
  const { gainOf } = await import('./scenes.js?v=151');
  const plan = renderPlan({ reel, quality: small ? 'small' : 'normal' });
  const total = Math.max(1, reel.ms);
  const stopped = () => !!(signal && signal.aborted);
  const sink = await openFileSink({ name: `${code || 'game'}-${reel.kind}`, estBytes: plan.estBytes, type: 'video/mp4', storage: win.navigator && win.navigator.storage, Worker: win.Worker, Blob: win.Blob });
  let failure = null, lost = false, keyNext = true;
  let venc = null, aenc = null;
  const onError = (e) => { if (reclaimed(e)) lost = true; else failure = failure || e; };
  function makeEncoders() {
    for (const e of [venc, aenc]) { try { if (e && e.state !== 'closed') e.close(); } catch { /* fine */ } }
    venc = new win.VideoEncoder({ output: (c, m) => mux.addVideo(c, m), error: onError });
    aenc = new win.AudioEncoder({ output: (c, m) => mux.addAudio(c, m), error: onError });
    venc.configure({ ...way.video, width: plan.w, height: plan.h, bitrate: plan.videoBits, framerate: plan.fps });
    aenc.configure({ ...way.audio, bitrate: plan.audioBits });
    lost = false; keyNext = true; // a new encoder starts on a keyframe
  }
  const gone = () => lost || venc.state === 'closed' || aenc.state === 'closed';
  makeEncoders();
  // the muxer needs the decoder configs, which come with the first chunks: it's made then
  let mux = null;
  const pendingV = [], pendingA = [];
  let vMeta = null, aMeta = null;
  const real = () => createMp4Muxer({ sink,
    video: { codec: way.video.codec, w: plan.w, h: plan.h, description: vMeta && vMeta.decoderConfig && vMeta.decoderConfig.description },
    audio: { codec: way.audio.codec, rate: AUDIO_RATE, channels: 1, bits: plan.audioBits, description: aMeta && aMeta.decoderConfig && aMeta.decoderConfig.description } });
  mux = {
    addVideo(c, m) { if (m && m.decoderConfig && !vMeta) vMeta = m; if (realMux) realMux.addVideo(c); else { pendingV.push(copyChunk(c)); flushPending(); } },
    addAudio(c, m) { if (m && m.decoderConfig && !aMeta) aMeta = m; if (realMux) realMux.addAudio(c); else { pendingA.push(copyChunk(c)); flushPending(); } },
  };
  let realMux = null;
  function flushPending() {
    if (!realMux) { if (!vMeta || !aMeta) return; realMux = real(); }
    while (pendingV.length) realMux.addVideo(pendingV.shift());
    while (pendingA.length) realMux.addAudio(pendingA.shift());
  }
  function copyChunk(c) {
    const data = new Uint8Array(c.byteLength); c.copyTo(data);
    return { type: c.type, timestamp: c.timestamp, duration: c.duration, byteLength: data.length, data, copyTo: (d) => d.set(data) };
  }

  // ---- frames ----
  const canvas = typeof win.OffscreenCanvas === 'function' ? new win.OffscreenCanvas(plan.w, plan.h) : Object.assign(doc.createElement('canvas'), { width: plan.w, height: plan.h });
  const ctx = canvas.getContext('2d');
  const faces = new Map();
  if (app && app.faces instanceof Map) {
    for (const [id, url] of app.faces) { if (typeof url !== 'string') continue; const img = new win.Image(); img.src = url; faces.set(id, img); }
    await Promise.race([Promise.all([...faces.values()].map((i) => (i.decode ? i.decode().catch(() => {}) : null))), sleep(3000)]);
  }
  let maps = null;
  try {
    const { prepareMaps } = await import('./moviemap.js?v=151');
    maps = prepareMaps(reel, { doc, win });
    await Promise.race([maps.done.catch(() => false), sleep(MAPS_WAIT_MS)]);
  } catch { maps = null; }
  const vids = new Map(); // id -> { v, ok }
  const ids = [...new Set((reel.clips || []).map((c) => c.id))];
  const links = ids.length ? await linksFor(app, ids) : {};
  const holder = doc.createElement('div');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none';
  doc.body.append(holder);
  async function videoFor(id) {
    if (vids.has(id)) return vids.get(id);
    const slot = { v: null, ok: false };
    vids.set(id, slot);
    if (!links[id]) return slot;
    if (vids.size > 6) { // let go of the least used
      const old = [...vids.entries()].find(([k, s]) => k !== id && s.v);
      if (old) { try { old[1].v.removeAttribute('src'); old[1].v.load(); old[1].v.remove(); } catch { /* fine */ } vids.delete(old[0]); }
    }
    const v = doc.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    holder.append(v);
    v.src = links[id];
    slot.v = v;
    slot.ok = await waitFor(v, 'loadeddata', 10000);
    return slot;
  }
  const play = (v) => { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch { /* fine */ } };
  const pause = (v) => { try { if (!v.paused) v.pause(); } catch { /* fine */ } };
  async function frameOf(id, at) {
    const s = await videoFor(id);
    if (!s.ok) return null;
    const v = s.v;
    let step = seekStep(at, v.currentTime);
    if (step === 'seek') {
      pause(v);
      try { v.currentTime = Math.max(0, at); } catch { return null; }
      if (!(await waitFor(v, 'seeked', 3000))) return { img: v, stale: true };
      step = seekStep(at, v.currentTime);
    }
    if (step === 'hold') pause(v);
    else if (!v.ended) {
      if (v.paused) play(v);
      const until = win.performance.now() + 1000;
      while (seekStep(at, v.currentTime) === 'wait' && !v.ended && !v.paused && win.performance.now() < until) await sleep(8);
    }
    return v.readyState >= 2 ? { img: v, stale: false } : null;
  }
  const pauseAll = (but = null) => { for (const [id, sl] of vids) if (sl.v && !(but && but.has(id))) pause(sl.v); };

  // ---- audio ----
  const OAC = win.OfflineAudioContext || win.webkitOfflineAudioContext;
  const decoded = new Map(); // key -> AudioBuffer (LRU for cameras)
  const camOrder = [];
  async function bufferFor(tr, octx) {
    const key = tr.kind === 'sting' ? `sting:${tr.src}` : `${tr.kind}:${tr.src}`;
    if (decoded.has(key)) {
      if (tr.kind === 'cam') { const i = camOrder.indexOf(key); if (i >= 0) { camOrder.splice(i, 1); camOrder.push(key); } } // used: newest
      return decoded.get(key);
    }
    let buf = null;
    try {
      if (tr.kind === 'sting') buf = synth(octx, tr.src, tr.src === 'tone' ? 8 : tr.track.ms / 1000 + 0.5);
      else if (tr.kind === 'cam') {
        if (links[tr.src]) buf = await octx.decodeAudioData(await (await win.fetch(links[tr.src])).arrayBuffer());
        camOrder.push(key);
      } else if (app && typeof app.clip === 'function') {
        const got = await app.clip(tr.src);
        if (got && got.url) buf = await octx.decodeAudioData(await (await win.fetch(got.url)).arrayBuffer());
      }
    } catch { buf = null; }
    decoded.set(key, buf);
    return buf;
  }
  let audioDone = 0; // ms rendered
  async function audioPiece(t0) {
    const t1 = Math.min(total, t0 + AUDIO_PIECE_S * 1000);
    const frames = Math.max(1, Math.round(((t1 - t0) / 1000) * AUDIO_RATE));
    const octx = new OAC(1, frames, AUDIO_RATE);
    const parts = audioAt(reel, t0, t1);
    // cameras no longer needed (not in this piece, nor in the scene being made) let go, least used first
    const need = new Set(parts.filter((p) => p.kind === 'cam').map((p) => `cam:${p.src}`));
    const soon = t1 + 3 * AUDIO_PIECE_S * 1000; // and the next pieces: a scene going back and forth between phones
    for (const tr of reel.audio || []) if (tr && tr.kind === 'cam' && tr.at < soon && tr.at + tr.ms > t0) need.add(`cam:${tr.src}`);
    for (let i = 0; i < camOrder.length && camOrder.length > CAM_AUDIO_LRU;) {
      if (need.has(camOrder[i])) { i += 1; continue; }
      decoded.delete(camOrder[i]); camOrder.splice(i, 1);
    }
    for (const p of parts) {
      const buf = await bufferFor(p, octx);
      if (!buf) continue;
      const src = octx.createBufferSource();
      src.buffer = buf;
      if (p.kind === 'sting' && p.src === 'tone') src.loop = true;
      const g = octx.createGain();
      const when = (p.from - t0) / 1000;
      g.gain.setValueAtTime(gainOf(p.track, p.from), when);
      for (const [rt, val] of p.track.gain || []) if (rt > p.from && rt < p.to) g.gain.linearRampToValueAtTime(val, (rt - t0) / 1000);
      g.gain.linearRampToValueAtTime(gainOf(p.track, p.to), (p.to - t0) / 1000);
      src.connect(g); g.connect(octx.destination);
      const offset = p.kind === 'cam' ? p.fileAt : (p.from - p.track.at) / 1000;
      try { src.start(when, src.loop ? offset % buf.duration : Math.max(0, offset), (p.to - p.from) / 1000); } catch { /* left out */ }
    }
    const out = await octx.startRendering();
    const data = out.getChannelData(0).slice();
    const ad = new win.AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round(t0 * 1000), data });
    aenc.encode(ad);
    ad.close();
    audioDone = t1;
  }

  const step = 1000 / plan.fps;
  const frames = Math.ceil(total / step);
  const startedAt = win.performance.now();
  let pausedMs = 0;
  try { app && app.alerts && app.alerts.keepAwake && app.alerts.keepAwake(true, 'movie'); } catch { /* fine */ }
  try {
    for (let i = 0; i < frames; i += 1) {
      if (stopped() || failure) break;
      if (doc.hidden) {
        const from = win.performance.now();
        onProgress({ at: i * step, total, paused: true, left: null, bytes: sink.bytes });
        pauseAll();
        // everything in flight is written before the browser may close the idle encoders
        try { if (!gone()) { await venc.flush(); await aenc.flush(); } } catch (e) { if (!reclaimed(e)) failure = failure || e; }
        while (doc.hidden && !stopped()) await sleep(300);
        pausedMs += win.performance.now() - from;
      }
      if (stopped() || failure) break;
      if (gone()) makeEncoders(); // reclaimed while away: new ones, carrying on with a keyframe
      const t = i * step;
      while (audioDone < total && audioDone <= t + 1000) await audioPiece(audioDone);
      const fp = framePlan(reel, t);
      const sources = new Map();
      // (v1.4.7: a dark shot is drawn as the face and a sound wave: no frame to fetch; its sound is mixed anyway)
      for (const s of fp.shots) { if (s.dark) continue; const f = await frameOf(s.id, s.fileAt); if (f) sources.set(s.id, f); }
      pauseAll(new Set(fp.shots.filter((s) => !s.dark).map((s) => s.id)));
      drawFrame(ctx, reel, t, { sources, faces, summary, ring, maps, w: plan.w, h: plan.h, scale: plan.w / 720 });
      const vf = new win.VideoFrame(canvas, { timestamp: Math.round(t * 1000), duration: Math.round(step * 1000) });
      if (gone()) makeEncoders();
      venc.encode(vf, { keyFrame: keyNext || i % Math.round(plan.fps * KEY_EVERY_S) === 0 });
      keyNext = false;
      vf.close();
      while (venc.encodeQueueSize > QUEUE_MOST) await sleep(5);
      while (realMux && realMux.pending > PENDING_MOST && !failure && !stopped()) await sleep(5); // the file is behind
      if (i % 15 === 0) {
        const spent = win.performance.now() - startedAt - pausedMs;
        onProgress({ at: t, total, paused: false, left: t > 2000 ? Math.max(0, (spent / t) * (total - t)) : null, bytes: sink.bytes });
        await sleep(0);
      }
    }
    while (!stopped() && !failure && audioDone < total) await audioPiece(audioDone);
    if (!stopped() && !failure) { await venc.flush(); await aenc.flush(); }
  } finally {
    try { venc.close(); } catch { /* fine */ }
    try { aenc.close(); } catch { /* fine */ }
    holder.remove();
    try { app && app.alerts && app.alerts.keepAwake && app.alerts.keepAwake(false, 'movie'); } catch { /* fine */ }
  }
  if (stopped() || failure || !realMux) {
    await sink.abort();
    if (failure) throw (failure.name === 'TooBig' ? failure : new Error("The movie didn't work on this phone. Try Small, or try again."));
    if (!realMux && !stopped()) throw new Error("The movie didn't work on this phone. Try again.");
    throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  }
  await realMux.finish();
  const blob = await sink.close();
  onProgress({ at: total, total, paused: false, left: 0, bytes: blob.size });
  return { blob, type: 'video/mp4', name: fileName(reel.kind, code, 'video/mp4'), size: blob.size, where: sink.kind, way: 'webcodecs' };
}

export { clearMovies };
