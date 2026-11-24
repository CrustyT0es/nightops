// Night Ops v1.4 (PAGE-DEVICES): one shared camera + microphone stream, and a watchdog that keeps it on.
// iPhones give one page one capture (two would fight), so the camera, both walkie-talkies and Wiretap all use this.
//
//   const m = createMedia({ media, doc, win, now, every, after, Ctx })
//   m.want({ video, audio })   what this phone needs held open now (video = the highlight cam, which records sound
//                              too; audio = a microphone kept open, e.g. while Wiretap may ask). App calls it from _take.
//   m.stream() -> MediaStream | null    the one held stream (never stop its tracks outside this file)
//   m.audio() -> Promise<{ stream, shared }>   a microphone: the held stream's audio when there is one (shared:
//                              true, never stopped by the user), else a walkie microphone of its own (shared: false,
//                              the caller stops it after use, as radio.js always did: an echo-cancelled microphone
//                              left open makes iPhones play everything at call volume)
//   m.state -> { cam, mic, needsTap }   cam 'ok'|'off'|'denied'|'none'|'na'; mic adds 'silent'
//   m.restore()                from a tap: getUserMedia again ("Tap to turn your camera and mic back on")
//   m.get() -> Promise<stream|null>   the held stream, asking (not from a tap) when it isn't there
//   m.reacquire(why)           a user of the stream saw it fail (a recorder error): get a new one
//   m.test(kind) -> Promise<state>   the ready check's test: kind 'camera' | 'mic' (asks once; a held stream counts)
//   m.allowed(kind, word)      v1.6.2: permissions.js's answer from an Allow tap; a wanted stream starts on a yes
//   m.on('state' | 'stream', fn) -> off()
//   m.level() -> 0..100        the microphone's loudness now
//   m.destroy()
export const SILENT_MS = 90000;
export const SILENT_LEVEL = 2;
export const REACQUIRE_STEPS_MS = [1000, 3000, 8000];
export const MUTE_OFF_MS = 3000;
export const CHECK_EVERY_MS = 1000;

export const VIDEO = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
// While the camera films: no voice processing (iPhones and Android's call mode would play every sound at call
// volume and drop Bluetooth earbuds to their hands-free profile for the whole game).
export const AUDIO_FILMING = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
export const AUDIO_WALKIE = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export function constraintsFor(want) {
  const c = {};
  if (want.video) c.video = { ...VIDEO };
  if (want.audio || want.video) c.audio = want.video ? { ...AUDIO_FILMING } : { ...AUDIO_WALKIE };
  return c;
}

// What a getUserMedia failure means. -> 'denied' | 'none' | 'off'
export function failWord(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'none';
  return 'off'; // NotReadableError (another app has it), AbortError...
}

export function createMedia({
  media = globalThis.navigator ? globalThis.navigator.mediaDevices : null,
  doc = globalThis.document,
  win = globalThis.window,
  now = () => Date.now(),
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = (id) => clearInterval(id),
  after = (fn, ms) => setTimeout(fn, ms),
  cancelAfter = (id) => clearTimeout(id),
  Ctx = (globalThis.window && (globalThis.window.AudioContext || globalThis.window.webkitAudioContext)) || null,
  Stream = globalThis.MediaStream,
} = {}) {
  const can = !!(media && typeof media.getUserMedia === 'function');
  const fns = new Map();
  const emit = (name, ...a) => {
    for (const fn of [...(fns.get(name) || [])]) {
      try { fn(...a); } catch (e) { console.error(e); }
    }
  };
  const M = {
    want: { video: false, audio: false },
    stream: null,
    asking: null,
    cam: can ? 'na' : 'none',
    mic: can ? 'na' : 'none',
    needsTap: false,
    muteAt: new Map(),     // track -> when it went muted
    quietSince: null,      // the mic level under SILENT_LEVEL since
    silentTries: 0,
    tries: 0,              // re-acquire attempts since the last good stream
    retryTimer: null,
    lastFail: null,        // 'denied' | 'none' | 'off' from the last ask
    micKnown: null,        // a test or walkie ask's result while nothing is held
    camKnown: null,
    ac: null, an: null, buf: null, src: null,
    dead: false,
  };
  let lastSig = '';

  const tracks = (s, kind) => {
    try { return kind === 'video' ? s.getVideoTracks() : kind === 'audio' ? s.getAudioTracks() : s.getTracks(); } catch { return []; }
  };
  const live = (t) => !!t && t.readyState !== 'ended';

  function stateNow() {
    return { cam: M.cam, mic: M.mic, needsTap: M.needsTap };
  }
  function changed() {
    const sig = `${M.cam}|${M.mic}|${M.needsTap}`;
    if (sig === lastSig) return;
    lastSig = sig;
    emit('state', stateNow());
  }

  // What each part is, from the held stream (or what's known without one).
  function judge() {
    const t = now();
    const s = M.stream;
    if (!can) { M.cam = 'none'; M.mic = 'none'; changed(); return; }
    const partWord = (kind, wanted, known) => {
      if (!wanted) return known === 'denied' || known === 'none' ? known : (known === 'ok' ? 'ok' : 'na');
      if (!s) return M.lastFail || (M.asking ? 'ok' : 'off');
      const tr = tracks(s, kind);
      if (!tr.length) return 'off';
      const t0 = tr[0];
      if (!live(t0)) return 'off';
      if (t0.muted === true) {
        const since = M.muteAt.get(t0);
        if (since === undefined) M.muteAt.set(t0, t);
        else if (t - since >= MUTE_OFF_MS) return 'off';
        return 'ok';
      }
      M.muteAt.delete(t0);
      return 'ok';
    };
    M.cam = partWord('video', M.want.video, M.camKnown);
    let mic = partWord('audio', M.want.video || M.want.audio, M.micKnown);
    if (mic === 'ok' && s && M.quietSince !== null && t - M.quietSince >= SILENT_MS) mic = 'silent';
    M.mic = mic;
    changed();
  }

  // ---- the microphone's level ----
  function listen(stream) {
    unlisten();
    if (!Ctx || !tracks(stream, 'audio').length) return;
    try {
      const ac = new Ctx();
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      M.ac = ac; M.src = src; M.an = an;
      M.buf = new Float32Array(an.fftSize);
      wakeAc();
    } catch { unlisten(); }
  }
  // iPhones start a context made outside a tap 'suspended', and put it 'interrupted' after a lock, call or Siri:
  // try now, and again at each tap (wakeOnTap).
  function wakeAc() {
    const ac = M.ac;
    if (!ac || !ac.resume) return;
    if (ac.state === 'suspended' || ac.state === 'interrupted') { try { ac.resume().catch(() => {}); } catch { /* ignore */ } }
  }
  function unlisten() {
    try { if (M.ac && M.ac.close) M.ac.close(); } catch { /* ignore */ }
    M.ac = null; M.src = null; M.an = null; M.buf = null;
  }
  function level() {
    if (!M.an || !M.buf) return null;
    // A context that isn't running feeds exact zeros: that's not a dead microphone.
    if (M.ac && M.ac.state && M.ac.state !== 'running') { M.zero = false; return null; }
    try {
      M.an.getFloatTimeDomainData(M.buf);
      let sum = 0;
      for (let i = 0; i < M.buf.length; i += 1) sum += M.buf[i] * M.buf[i];
      const rms = Math.sqrt(sum / M.buf.length);
      M.zero = sum === 0; // a dead mic feeds exact zeros; a quiet room never does
      return Math.max(0, Math.min(100, Math.round(rms * 300)));
    } catch { return null; }
  }

  // ---- getting a stream ----
  function stopStream(s) {
    for (const t of tracks(s, 'all')) { try { t.stop(); } catch { /* ignore */ } }
  }

  function watchStream(s) {
    for (const t of tracks(s, 'all')) {
      if (!t || typeof t.addEventListener !== 'function') continue;
      t.addEventListener('ended', () => { if (M.stream === s) { judge(); lost('ended'); } });
      t.addEventListener('mute', () => { if (M.stream === s) { M.muteAt.set(t, now()); judge(); } });
      t.addEventListener('unmute', () => { if (M.stream === s) { M.muteAt.delete(t); judge(); } });
    }
  }

  function needed() {
    return M.want.video || M.want.audio;
  }

  // Ask for what's wanted. byTap: from a tap (a refusal then is final until the next tap).
  function acquire(byTap = false) {
    if (!can || M.dead) return Promise.resolve(null);
    if (M.asking) return M.asking;
    const want = { ...M.want };
    if (!want.video && !want.audio) return Promise.resolve(null);
    M.asking = (async () => {
      try {
        const s = await media.getUserMedia(constraintsFor(want));
        if (M.dead || !needed()) { stopStream(s); return null; }
        const old = M.stream;
        M.stream = s;
        M.lastFail = null;
        M.needsTap = false;
        M.tries = 0;
        M.quietSince = null;
        if (want.video) M.camKnown = 'ok';
        M.micKnown = 'ok';
        watchStream(s);
        listen(s);
        if (old && old !== s) stopStream(old);
        judge();
        emit('stream', s, old || null);
        return s;
      } catch (e) {
        const w = failWord(e);
        M.lastFail = w;
        if (want.video) M.camKnown = w;
        M.micKnown = w;
        // iPhones often refuse without a tap: after the steps, or a refusal not from a tap, a tap is asked for.
        if (w === 'denied' && !byTap) M.needsTap = true;
        else if (w === 'off') M.needsTap = M.tries >= REACQUIRE_STEPS_MS.length;
        judge();
        if (w === 'off' && !byTap) later();
        return null;
      } finally {
        M.asking = null;
      }
    })();
    return M.asking;
  }

  // The stream (or a track of it) ended: get a new one on the steps, then ask for a tap.
  function lost(why) {
    if (!needed() || M.dead) return;
    if (M.retryTimer !== null) return;
    later(why);
  }
  function later() {
    if (M.retryTimer !== null || M.dead) return;
    if (M.tries >= REACQUIRE_STEPS_MS.length) {
      M.needsTap = true;
      judge();
      return;
    }
    const ms = REACQUIRE_STEPS_MS[M.tries];
    M.tries += 1;
    M.retryTimer = after(() => {
      M.retryTimer = null;
      if (!needed() || M.dead) return;
      if (M.stream && healthy(M.stream)) return;
      acquire(false);
    }, ms);
  }

  function healthy(s) {
    const ts = tracks(s, 'all');
    if (!ts.length || ts.some((t) => !live(t))) return false;
    if (M.want.video && !tracks(s, 'video').length) return false;
    return true;
  }

  // ---- the watchdog ----
  function check() {
    if (M.dead) return;
    const s = M.stream;
    if (needed() && s) {
      const lv = level();
      if (lv !== null) {
        // Only digital silence counts: a hider keeping still at night is quiet, not broken (AGC is off while filming).
        if (M.zero) { if (M.quietSince === null) M.quietSince = now(); } else { M.quietSince = null; M.silentTries = 0; }
      }
      if (!healthy(s)) lost('ended');
      else if (M.quietSince !== null && now() - M.quietSince >= SILENT_MS) {
        // A microphone some phones keep open but feed nothing after a call: once again, then a tap.
        if (M.silentTries === 0) { M.silentTries = 1; M.quietSince = now(); acquire(false); }
        else M.needsTap = true;
      }
    } else if (needed() && !s && !M.asking && M.retryTimer === null && !M.needsTap && M.lastFail !== 'denied') {
      acquire(false);
    }
    judge();
  }

  function onBack() {
    if (M.dead || (doc && doc.visibilityState === 'hidden')) return;
    if (needed() && M.stream && !healthy(M.stream)) { M.tries = 0; acquire(false); }
    check();
  }
  // Earbuds in or out: a new microphone only when the old one ended (one gone quiet is left to the watchdog).
  function onDevices() {
    if (M.dead || !needed() || !M.stream) return;
    const a = tracks(M.stream, 'audio')[0];
    if (!live(a)) acquire(false); // a quiet one is the watchdog's (SILENT_MS)
  }

  const dog = can ? every(check, CHECK_EVERY_MS) : null;
  const onVis = () => onBack();
  try { if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis); } catch { /* ignore */ }
  try { if (win && win.addEventListener) { win.addEventListener('pageshow', onVis); win.addEventListener('focus', onVis); } } catch { /* ignore */ }
  try { if (media && media.addEventListener) media.addEventListener('devicechange', onDevices); } catch { /* ignore */ }
  const wakeOnTap = () => wakeAc();
  try { if (win && win.addEventListener) win.addEventListener('pointerdown', wakeOnTap, { passive: true }); } catch { /* ignore */ }

  const m = {
    get state() { return stateNow(); },
    can,
    want({ video = false, audio = false } = {}) {
      const w = { video: !!video, audio: !!audio };
      const grew = (w.video && !M.want.video) || (w.audio && !M.want.audio && !M.want.video);
      M.want = w;
      if (!needed()) {
        if (M.stream) { const old = M.stream; M.stream = null; unlisten(); stopStream(old); emit('stream', null, old); }
        if (M.retryTimer !== null) { cancelAfter(M.retryTimer); M.retryTimer = null; }
        M.needsTap = false;
        M.tries = 0;
        judge();
        return;
      }
      if (grew || !M.stream || (w.video && !tracks(M.stream, 'video').length)) acquire(false);
      judge();
    },
    stream: () => M.stream,
    // The held stream when it's healthy, else ask for it (not from a tap). -> Promise<MediaStream | null>
    get() {
      if (M.stream && healthy(M.stream)) return Promise.resolve(M.stream);
      if (!needed()) return Promise.resolve(null);
      return acquire(false);
    },
    // byTap: called from a tap (the walkie's button); false from a server view (Wiretap), so a refusal asks for a tap.
    // filming: no voice processing (Wiretap only records: echo cancellation would move iPhones to call volume and
    // Bluetooth earbuds to hands-free).
    async audio({ byTap = true, filming = false } = {}) {
      const s = M.stream;
      const a = s ? tracks(s, 'audio').filter((t) => live(t) && t.muted !== true) : [];
      if (a.length) return { stream: Stream ? new Stream(a) : s, shared: true };
      if (needed()) {
        const got = await acquire(byTap);
        const b = got ? tracks(got, 'audio').filter(live) : [];
        if (b.length) return { stream: Stream ? new Stream(b) : got, shared: true };
      }
      try {
        const own = await media.getUserMedia({ audio: { ...(filming ? AUDIO_FILMING : AUDIO_WALKIE) } });
        M.micKnown = 'ok';
        judge();
        return { stream: own, shared: false };
      } catch (e) {
        M.micKnown = failWord(e);
        judge();
        throw e;
      }
    },
    restore() {
      M.tries = 0;
      M.needsTap = false;
      M.lastFail = null;
      M.silentTries = 0;
      M.quietSince = null;
      if (M.retryTimer !== null) { cancelAfter(M.retryTimer); M.retryTimer = null; }
      judge();
      if (!needed()) return Promise.resolve(null);
      return acquire(true);
    },
    reacquire() {
      if (!needed()) return;
      later();
    },
    // v1.6.2 PERMS: an Allow tap (permissions.js) was answered for kind 'mic' | 'camera' with word 'ok' | 'denied' |
    // 'none' | 'off'. What's known now; on a yes, a stream this phone wants (and hasn't got) is asked for again at
    // once, with no reload (the browser already said yes, so no second box). -> Promise<stream | null>
    allowed(kind, word) {
      if (M.dead) return Promise.resolve(null);
      const w = ['ok', 'denied', 'none', 'off'].includes(word) ? word : 'off';
      if (kind === 'camera') M.camKnown = w; else M.micKnown = w;
      if (w === 'ok' && needed() && !(M.stream && healthy(M.stream) && !M.needsTap)) return m.restore();
      judge();
      return Promise.resolve(M.stream);
    },
    // The ready check: ask once for this part (a held healthy stream already answers).
    async test(kind = 'mic') {
      const isCam = kind === 'camera';
      if (M.stream && healthy(M.stream) && (!isCam || tracks(M.stream, 'video').length)) return 'ok';
      if (!can) return 'none';
      try {
        const s = await media.getUserMedia(isCam ? { video: { ...VIDEO }, audio: { ...AUDIO_FILMING } } : { audio: { ...AUDIO_WALKIE } });
        stopStream(s);
        if (isCam) M.camKnown = 'ok';
        M.micKnown = 'ok';
        judge();
        return 'ok';
      } catch (e) {
        const w = failWord(e);
        if (isCam) M.camKnown = w; else M.micKnown = w;
        judge();
        return w;
      }
    },
    level: () => level() || 0,
    on(name, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!fns.has(name)) fns.set(name, new Set());
      fns.get(name).add(fn);
      return () => fns.get(name) && fns.get(name).delete(fn);
    },
    check,
    destroy() {
      M.dead = true;
      if (dog !== null) stopEvery(dog);
      if (M.retryTimer !== null) cancelAfter(M.retryTimer);
      if (M.stream) stopStream(M.stream);
      M.stream = null;
      unlisten();
      try { if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis); } catch { /* ignore */ }
      try { if (win && win.removeEventListener) { win.removeEventListener('pageshow', onVis); win.removeEventListener('focus', onVis); win.removeEventListener('pointerdown', wakeOnTap); } } catch { /* ignore */ }
      try { if (media && media.removeEventListener) media.removeEventListener('devicechange', onDevices); } catch { /* ignore */ }
      fns.clear();
    },
  };
  judge();
  return m;
}
