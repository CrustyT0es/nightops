// Night Ops v1.6.1: the lobby show, Jackbox style, on everyone's own phone (no TV), hosted by Static: a 3D
// walkie-talkie whose face is a little screen (the Retro Radio voice, audio/narrator/*.mp3, with captions in his
// speech bubble). Every phone plays the same show from the server's clock (view.now):
//
//   intro     Static walks everyone through the rules, one little 3D scene each: the teams, pings, tags, the ring
//             (live location outside it), powers, loot, the walkie and the driver, the ground rules (public
//             property only, SOS) and pocket mode; a channel-change between scenes
//   gear      everyone checks location, mic (and camera) together; anyone without a picture snaps one
//   question  the one vote: the game mode (Classic, Checkpoints, Loot drops); everyone's faces on their pick
//   explain   a drum roll, the winner slams in, and a scene shows how it plays
//   driver    (when the host has a driver on) who wants to drive? then a wheel lands on one of them
//   results   the mode and the driver, then the lobby comes back
//
//   const show = createVoteShow(app);   show.update(view)   show.destroy()
// Its styles are css/vote.css (CSS 3D only; less motion = no movement).
import { h, fill, text, face } from '../dom.js?v=163';
import { OPTIONS, PROMPTS, EXPLAIN, stageAt, winner, driverOf } from '../../shared/vote.js?v=163';
import { pickFace } from '../face.js?v=163';

const AUDIO = 'audio/narrator/';
const MUTE_KEY = 'nightops-narrator';   // 'off' = Static stays quiet on this phone
export const DRUM_MS = 1300;            // the explainer's drum roll before the winner slams in
// The intro's beats (ms into it), Static's line for each, and where he stands ('hero' big in the middle, 'side').
export const BEATS = [
  { at: 0, key: 'title', line: 'r_intro', host: 'hero' },
  { at: 6700, key: 'teams', line: 'r_teams', host: 'side' },
  { at: 12400, key: 'ping', line: 'r_ping', host: 'side' },
  { at: 19300, key: 'tag', line: 'r_tag', host: 'side' },
  { at: 28400, key: 'ring', line: 'r_ring', host: 'side' },
  { at: 35800, key: 'powers', line: 'r_powers', host: 'side' },
  { at: 42000, key: 'loot', line: 'r_loot', host: 'side' },
  { at: 50400, key: 'walkie', line: 'r_walkie', host: 'side' },
  { at: 58600, key: 'safety', line: 'r_safety', host: 'side' },
  { at: 73700, key: 'pocket', line: 'r_pocket', host: 'side' },
  { at: 81100, key: 'gearcall', line: 'r_gearcall', host: 'hero' },
];
// What Static says (the captions in his bubble), by sound file.
export const LINES = {
  r_intro: "Welcome to Night Ops! I'm Static, your host. Eyes on your phone... let me walk you through the rules.",
  r_teams: "First, the teams. Hunters hunt. Hiders hide. Your phone tells you which one you are.",
  r_ping: "Every few minutes, hiders get pinged. The hunters see a circle on the map, somewhere around where you are.",
  r_tag: "Hunters: find a hider, and tag them for real. Then press, I tagged someone. The hider confirms it on their phone. Be honest!",
  r_ring: "Stay inside the ring. Step outside, and your exact location goes live on everyone's map, in real time.",
  r_powers: "Both teams get powers. Radar, Decoy, Jammer, and more. Save them for the perfect moment.",
  r_loot: "In Loot drops, boxes fall around the ring. Walk right up to one, crack it open, and pray for legendary... or even mythic!",
  r_walkie: "Hunters get a walkie-talkie. Hold to talk, let go to send. And if there's a driver, they can pick you up and drive you closer.",
  r_safety: "Ground rules! Public property only. No backyards, no going inside stores or houses, and look both ways before you cross. If anyone's hurt or lost, hit S.O.S. It pauses the game for everyone.",
  r_pocket: "Pro tip: don't lock your phone. Tap the moon for pocket mode. Your screen goes black, and you stay in the game.",
  r_gearcall: "Alright! Gear check time!",
  gear2: "Let your phone use your location, your mic, and your camera. No profile picture yet? Snap one now, so everyone knows who's who!",
  q_driver: "Who wants to be the driver? Only if you can drive, and you've got a car!",
  spin: "Spinning the wheel...",
  nodriver: "Nobody wants to drive? Okay... everybody walks!",
  results2: "That's everything! Host, hit start when everybody's ready. Good luck out there!",
  q_mode: "Which game are we playing?",
  e_mode_classic: "Classic it is! Hunters chase, hiders hide. Last one standing wins it for the hiders.",
  e_mode_checkpoints: "Checkpoints! One opens at a time. Get there, snap the photo. Most checkpoints wins.",
  e_mode_loot: "Loot drops! Boxes fall around the ring. Grab one, crack it open, and get a power. Common, rare... or legendary!",
};
const EMOJI = { target: '🎯', flag: '🚩', gift: '🎁' };
export const TAGS = ['hide and seek, but your phone snitches', 'cardio, but make it sneaky', 'the bushes are your best friend now', 'trust nobody.'];

function muted() { try { return localStorage.getItem(MUTE_KEY) === 'off'; } catch { return false; } }
const setVar = (el, name, v) => { el.style.setProperty(name, String(v)); return el; };

// The beat of the intro at `ms` into it (a skipped intro is only the last one).
export function beatAt(ms, introMs) {
  if (introMs < BEATS[BEATS.length - 1].at) return BEATS[BEATS.length - 1];
  let b = BEATS[0];
  for (const x of BEATS) if (ms >= x.at) b = x;
  return b;
}

// ---- Static, the host: a 3D walkie-talkie (a CSS box: front, back, sides, top, bottom) with a bendy antenna,
// floating over his own shadow; his face is a little CRT screen (glowing eyes, a mouth that's a sound meter while
// he talks). makeStatic() -> { el, talk(on), mood(name) }   moods: '' | 'happy' | 'wow' | 'wink'
export function makeStatic() {
  const bars = [0, 1, 2, 3, 4, 5, 6].map((i) => setVar(h('i.s3-bar'), '--i', i));
  const screen = h('div.s3-screen',
    h('div.s3-eyes', h('i.s3-eye'), h('i.s3-eye')),
    h('div.s3-mouth', bars),
    h('i.s3-scan'));
  const front = h('div.s3-face.s3-front', screen,
    h('div.s3-grille', Array.from({ length: 15 }, () => h('i'))),
    h('i.s3-led'), h('i.s3-knob'));
  const box = h('div.s3-body', front,
    h('div.s3-face.s3-back'), h('div.s3-face.s3-left', h('i.s3-ptt')), h('div.s3-face.s3-right'),
    h('div.s3-face.s3-top'), h('div.s3-face.s3-bottom'),
    h('div.s3-ant', h('i.s3-ant-a'), h('i.s3-ant-b'), h('i.s3-tip')));
  const el = h('div.s3', { 'aria-hidden': 'true' }, h('div.s3-shadow'), h('div.s3-float', h('div.s3-spin', box)));
  return {
    el,
    talk(on) { el.classList.toggle('talk', !!on); },
    mood(name) { el.dataset.mood = name || ''; },
  };
}

export function createVoteShow(app, { doc = globalThis.document } = {}) {
  const S = {
    view: null, skew: 0, key: '', localSkip: 0, timer: null, dead: false, played: new Set(), voteId: null,
    tapped: false, gear: null, gearRun: null, talkUntil: 0, snapping: false, wheelDone: '',
  };
  const layer = h('div.vs', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'The vote' });
  const stage = h('div.vs-stage');
  const clock = h('div.vs-clock', { 'aria-hidden': 'true' });
  const muteBtn = h('button.vs-mute', { type: 'button' });
  const skipBtn = h('button.vs-skip', { type: 'button' }, 'Skip ▸');
  const sky = h('div.vs-sky', { 'aria-hidden': 'true' }, h('div.vs-rays'), h('div.vs-stars'), h('div.vs-stars.far'), h('div.vs-floor'));
  const host = makeStatic();
  const bubble = h('p.vs-bubble', { 'aria-live': 'polite' });
  const hostBox = h('div.vs-host', host.el, bubble);
  const tvx = h('div.vs-tvx', { 'aria-hidden': 'true' });
  layer.append(sky, stage, hostBox, clock, tvx, h('div.vs-top', muteBtn, skipBtn));
  layer.dataset.host = 'hero';
  doc.body.appendChild(layer);
  const narr = new Audio();
  narr.preload = 'auto';
  narr.addEventListener('playing', () => host.talk(true));
  for (const ev of ['ended', 'pause', 'error']) narr.addEventListener(ev, () => host.talk(muted() && Date.now() < S.talkUntil));
  let unlocked = false;
  const unlock = () => {
    S.tapped = true;
    if (unlocked) return;
    unlocked = true;
    try { narr.muted = true; const p = narr.play(); if (p && p.catch) p.catch(() => {}); narr.pause(); narr.muted = false; } catch { /* fine */ }
  };
  doc.addEventListener('pointerdown', unlock, { capture: true, passive: true });

  function paintMute() {
    text(muteBtn, muted() ? '🔇' : '🔊');
    muteBtn.setAttribute('aria-label', muted() ? 'Turn Static on' : 'Turn Static off');
  }
  paintMute();
  muteBtn.addEventListener('click', () => {
    try { localStorage.setItem(MUTE_KEY, muted() ? 'on' : 'off'); } catch { /* fine */ }
    if (muted()) narr.pause();
    paintMute();
  });
  skipBtn.addEventListener('click', () => { S.localSkip = S.voteId; S.key = ''; tick(); app.cmd({ type: 'voteskip' }, { quiet: true }).catch(() => {}); }); // (everyone skips with the host)

  // Static says a line: the sound (unless muted) and the caption; his mouth moves while it plays.
  function say(line, words = LINES[line]) {
    const id = `${S.voteId}:${line}`;
    if (S.played.has(id)) return;
    S.played.add(id);
    if (words) { text(bubble, words); bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop'); }
    S.talkUntil = Date.now() + Math.min(15000, 900 + String(words || '').length * 55);
    if (muted()) { host.talk(true); setTimeout(() => host.talk(Date.now() < S.talkUntil && !narr.paused), S.talkUntil - Date.now()); return; }
    try { narr.src = `${AUDIO}${line}.mp3`; const p = narr.play(); if (p && p.catch) p.catch(() => host.talk(false)); } catch { /* the words are in the bubble */ }
  }

  // The channel change between scenes: the old picture collapses to a line, static, the new one opens.
  function channel() {
    tvx.classList.remove('go');
    void tvx.offsetWidth;
    tvx.classList.add('go');
  }

  const now = () => Date.now() + S.skew;
  const players = () => ((S.view && S.view.players) || []).filter((p) => p && p.status !== 'kicked' && p.status !== 'left');
  const byId = (id) => players().find((p) => p.id === id) || {};
  const faceSrc = (pid) => { try { return app.faces && app.faces.get ? app.faces.get(pid) || null : null; } catch { return null; } };
  const faceFor = (pid, size, extra = '') => face({ name: byId(pid).name || '?', src: faceSrc(pid), team: null, size, extra });

  // ---- the little 3D stages ----
  function plane(cls, ...kids) {
    return h(`div.vs-world${cls ? `.${cls}` : ''}`, { 'aria-hidden': 'true' },
      h('div.vs-plane', h('div.vs-grid'), h('div.vs-ringshape'), ...kids));
  }
  const dot = (team, cls = '') => h(`span.vs-pdot.t-${team}${cls ? `.${cls}` : ''}`);
  const head = (kicker, cls, title) => [h(`p.vs-kicker.${cls}`, kicker), h('h2.vs-scene-title', ...title)];

  function title() {
    const tag = TAGS[(S.voteId || 0) % TAGS.length];
    const word = (w, cls) => h(`span.vs-word.${cls}`, [...w].map((ch, i) => setVar(h('span.vs-letter', ch), '--i', i)));
    return h('div.vs-title',
      h('div.vs-moon', { 'aria-hidden': 'true' }),
      h('h1.vs-logo', word('NIGHT', 'vs-l1'), word('OPS', 'vs-l2')),
      h('p.vs-tag', tag));
  }
  const SCENES = {
    teams: () => h('div.vs-scene', ...head('The teams', 'warn', ['Hunters hunt.', h('br'), 'Hiders hide.']),
      h('div.vs-coins', { 'aria-hidden': 'true' },
        h('div.vs-coin.t-hunter', h('span', '🎯'), h('b', 'HUNTERS')),
        h('div.vs-coin.t-hider', h('span', '👀'), h('b', 'HIDERS'))),
      h('div.vs-phonecard', { 'aria-hidden': 'true' }, h('small', "You're a"), h('b', 'HIDER'))),
    ping: () => h('div.vs-scene', ...head('Pings', 'hider', ['Every few minutes:', h('br'), 'PING.']),
      plane('', dot('hider', 'run1'), dot('hider', 'run2'), h('span.vs-pingring'), h('span.vs-pingring.late'), dot('hider', 'pinged')),
      h('div.vs-phone', { 'aria-hidden': 'true' }, h('span', 'PING!'))),
    tag: () => h('div.vs-scene', ...head('Tagging', 'hunter', ['Tag them', h('br'), 'for real.']),
      plane('', h('span.vs-pingring.still'), dot('hider', 'prey'), dot('hunter', 'chase1'), dot('hunter', 'chase2'), h('span.vs-tagstar', 'TAG!')),
      h('div.vs-confirm', { 'aria-hidden': 'true' }, h('small', 'Did they tag you?'), h('b', 'YES, I GOT TAGGED'))),
    ring: () => h('div.vs-scene', ...head('The ring', 'warn', ['Stay inside.']),
      plane('', dot('hider', 'stepout'), h('span.vs-livebadge', '📍 LIVE LOCATION')),
      h('p.vs-scene-sub', 'Step out and everyone sees exactly where you are.')),
    powers: () => h('div.vs-scene', ...head('Powers', 'warn', ['Use them at', h('br'), 'the perfect moment.']),
      h('div.vs-carousel', { 'aria-hidden': 'true' }, h('div.vs-carousel-in',
        ...['📡', '🎭', '📵', '👁️', '🏃', '🚨', '🌫️', '👻'].map((e, i, all) => setVar(setVar(h('span.vs-ccard', e), '--i', i), '--n', all.length))))),
    loot: () => h('div.vs-scene', ...head('Loot drops', 'warn', ['Grab a box.', h('br'), 'Crack it open.']),
      h('div.vs-lootshow', { 'aria-hidden': 'true' },
        h('span.nloot-box.big', h('span.nloot-lid'), h('span.nloot-body')),
        h('span.vs-rarities', ...['COMMON', 'RARE', 'LEGENDARY', 'MYTHIC'].map((w, n) => setVar(h(`span.r${n}`, w), '--i', n))))),
    walkie: () => h('div.vs-scene', ...head('Walkie + driver', 'hunter', ['Hold to talk.', h('br'), 'Hop in the car.']),
      plane('road', h('span.vs-road'), h('span.vs-car', '🚗'), dot('hunter', 'waiting')),
      h('div.vs-walkies.solo', { 'aria-hidden': 'true' }, h('span.vs-wt.t-hunter', '📻', h('i.vs-wave'), h('i.vs-wave.late')))),
    safety: () => h('div.vs-scene.safety', ...head('Ground rules', 'warn', ['Public property', h('br'), 'only.']),
      h('div.vs-sign', { 'aria-hidden': 'true' }, h('div.vs-sign-in', h('b', 'PUBLIC'), h('b', 'PROPERTY'), h('small', 'ONLY'))),
      h('ul.vs-rules', ...[['🏡', 'No backyards'], ['🏪', 'Not inside stores or houses'], ['🚸', 'Look both ways'], ['🆘', 'Hurt or lost? Hit SOS']]
        .map(([e, w], i) => setVar(h('li', h('span', { 'aria-hidden': 'true' }, e), w), '--i', i)))),
    pocket: () => h('div.vs-scene', ...head('Pro tip', 'hider', ["Don't lock", h('br'), 'your phone.']),
      h('div.vs-pocket', { 'aria-hidden': 'true' }, h('div.vs-pphone', h('div.vs-pscreen', h('span', '🌙')))),
      h('p.vs-scene-sub', 'Tap the moon: pocket mode keeps you in the game.')),
    gearcall: () => h('div.vs-call',
      h('h1.vs-big.vs-slam', 'Gear', h('br'), 'check!'),
      h('div.vs-gearicons', { 'aria-hidden': 'true' }, ...['📍', '🎙️', '📷'].map((e, i) => setVar(h('span', e), '--i', i)))),
  };

  // ---- the gear check (and a picture for anyone without one) ----
  const GEAR_PARTS = [['loc', '📍', 'Location'], ['mic', '🎙️', 'Mic'], ['cam', '📷', 'Camera']];
  const wantsCam = () => !!(S.view && S.view.settings && S.view.settings.cam);
  const meId = () => S.view && S.view.me && S.view.me.id;
  const hasFace = (pid) => !!faceSrc(pid) || (byId(pid).faceV > 0);
  function gearScreen() {
    const grid = h('div.vs-gear-grid');
    const mine = h('div.vs-gear-mine');
    const again = h('button.btn.vs-gear-go', { type: 'button' }, 'Check my gear');
    again.addEventListener('click', () => runGear());
    const snap = h('button.btn.vs-snap', { type: 'button', hidden: true }, '📸 Snap my picture');
    snap.addEventListener('click', async () => {
      if (S.snapping) return;
      S.snapping = true;
      text(snap, 'Opening camera…');
      try {
        const url = await pickFace();
        if (url && app.setFace) await app.setFace(url);
      } catch { /* a banner says */ }
      S.snapping = false;
      S.gearSig = '';
      paintGear();
    });
    S.gearEls = { grid, mine, again, snap };
    return h('div.vs-gear', h('h1.vs-big.vs-prompt', 'Gear check'), mine, h('div.vs-gear-btns', again, snap), grid);
  }
  function gearIcon(state, emoji, label) {
    const cls = state === true ? 'ok' : state === false ? 'bad' : state === 'busy' ? 'busy' : state === 'off' ? 'off' : 'wait';
    const word = { ok: 'ready', bad: 'needs fixing', busy: 'checking', off: 'not used this game', wait: 'not checked yet' }[cls];
    return h(`span.vs-gi.${cls}`, { title: `${label}: ${word}`, 'aria-label': `${label}: ${word}` }, emoji);
  }
  function paintGear() {
    const els = S.gearEls;
    const v = S.view && S.view.vote;
    if (!els || !v) return;
    const me = meId();
    const g = { ...(v.gear || {}) };
    const faces = players().map((p) => hasFace(p.id) ? 1 : 0).join('');
    const sig = JSON.stringify([g, S.gear, wantsCam(), faces, S.snapping]);
    if (sig === S.gearSig) return;
    S.gearSig = sig;
    const mineNow = S.gear || g[me] || null;
    fill(els.mine, GEAR_PARTS.map(([k, e, label]) => {
      const st = k === 'cam' && !wantsCam() ? 'off' : mineNow ? mineNow[k] : null;
      return h('div.vs-gear-row', gearIcon(st, e, label), h('span', label),
        h('strong', st === true ? 'Ready' : st === false ? 'Fix it' : st === 'busy' ? 'Checking…' : st === 'off' ? 'Not this game' : '—'));
    }));
    text(els.again, S.gearRun ? 'Checking…' : mineNow ? 'Check again' : 'Check my gear');
    els.again.disabled = !!S.gearRun;
    els.snap.hidden = !me || hasFace(me);
    if (!S.snapping) text(els.snap, '📸 Snap my picture');
    fill(els.grid, players().slice(0, 12).map((p, i) => {
      const pg = p.id === me && S.gear ? S.gear : g[p.id];
      const allOk = pg && pg.loc === true && pg.mic === true && (pg.cam === true || !wantsCam());
      return setVar(h(`div.vs-gear-card${allOk ? '.ready' : ''}${hasFace(p.id) ? '' : '.noface'}`, faceFor(p.id, 34),
        h('span.vs-gear-name', p.name || '?'),
        h('span.vs-gear-icons', ...GEAR_PARTS.map(([k, e, label]) => gearIcon(k === 'cam' && !wantsCam() ? 'off' : pg ? pg[k] : null, e, label)))), '--i', i);
    }));
  }
  async function runGear() {
    if (S.gearRun) return;
    const cam = wantsCam();
    S.gear = { loc: 'busy', mic: 'busy', cam: cam ? 'busy' : null };
    paintGear();
    const nav = globalThis.navigator || {};
    const loc = new Promise((res) => {
      try {
        if (!nav.geolocation) return res(false);
        nav.geolocation.getCurrentPosition(() => res(true), () => res(false), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
      } catch { res(false); }
    }).then((ok) => { S.gear.loc = ok; paintGear(); return ok; });
    const media = async (c) => {
      try {
        const st = await nav.mediaDevices.getUserMedia(c);
        for (const t of st.getTracks()) t.stop();
        return true;
      } catch { return false; }
    };
    S.gearRun = (async () => {
      const mic = await media({ audio: true });
      S.gear.mic = mic; paintGear();
      const camOk = cam ? await media({ video: { facingMode: 'user' } }) : null;
      S.gear.cam = camOk; paintGear();
      const l = await loc;
      try { await app.cmd({ type: 'gear', loc: l, mic, cam: camOk }, { quiet: true }); } catch { /* the next view says */ }
    })();
    try { await S.gearRun; } finally { S.gearRun = null; S.gearSig = ''; paintGear(); }
  }

  // ---- the vote ----
  function question(i) {
    const v = S.view.vote;
    const q = v.questions[i];
    const opts = q.options.map((k, j) => {
      const o = OPTIONS[q.q][k];
      const b = setVar(h('button.vs-opt', { type: 'button', 'data-k': k },
        h('span.vs-emoji', { 'aria-hidden': 'true' }, EMOJI[o.icon] || '⭐'),
        h('span.vs-opt-text', h('strong', o.label), h('small', o.line)),
        h('span.vs-dots', { 'aria-hidden': 'true' }),
        h('span.vs-stamp', { 'aria-hidden': 'true' }, 'My pick!')), '--i', j);
      b.addEventListener('click', () => pick(q.q, k));
      return b;
    });
    return h('div.vs-q', { 'data-q': q.q }, h('h1.vs-big.vs-prompt', PROMPTS[q.q]), h('div.vs-opts', opts));
  }
  async function pick(q, k) {
    for (const b of stage.querySelectorAll('.vs-opt')) b.classList.toggle('mine', b.dataset.k === k);
    try { await app.cmd({ type: 'vote', q, pick: k }); } catch { /* the next view says how it went */ }
  }
  function paintDots(i) {
    const v = S.view.vote;
    const q = v.questions[i];
    const picks = v.picks[q.q] || {};
    for (const b of stage.querySelectorAll('.vs-opt')) {
      const who = Object.entries(picks).filter(([, k]) => k === b.dataset.k).map(([pid]) => pid);
      const dots = b.querySelector('.vs-dots');
      const sig = who.join(',');
      if (dots && dots.dataset.sig !== sig) {
        dots.dataset.sig = sig;
        fill(dots, who.map((pid) => faceFor(pid, 26, 'vs-dot')));
      }
      b.classList.toggle('mine', v.mine[q.q] === b.dataset.k);
    }
  }
  function winnerOf(i) {
    const v = S.view.vote;
    const q = v.questions[i];
    return (v.result && v.result[q.q]) || winner(q, v.picks[q.q], v.id, null);
  }
  function drum(i) {
    const v = S.view.vote;
    const q = v.questions[i];
    return h('div.vs-q.vs-drum', { 'data-q': q.q },
      h('h1.vs-big.vs-prompt', 'And the winner is…'),
      h('div.vs-opts', q.options.map((k, j) => {
        const o = OPTIONS[q.q][k];
        return setVar(h('div.vs-opt.drum', { 'data-k': k },
          h('span.vs-emoji', { 'aria-hidden': 'true' }, EMOJI[o.icon] || '⭐'),
          h('span.vs-opt-text', h('strong', o.label))), '--i', j);
      })));
  }
  function explainScene(scene) {
    switch (scene) {
      case 'classic': return plane('', dot('hider', 'flee'), dot('hunter', 'chase1'), dot('hunter', 'chase2'));
      case 'checkpoints': return plane('', ...[0, 1, 2].map((n) => setVar(h('span.vs-flag', '🚩'), '--i', n)), h('span.vs-flash'));
      case 'loot': return SCENES.loot().lastChild;
      default: return h('div');
    }
  }
  function explain(i) {
    const v = S.view.vote;
    const q = v.questions[i].q;
    const key = winnerOf(i);
    const o = OPTIONS[q][key];
    const x = (EXPLAIN[q] && EXPLAIN[q][key]) || { title: o.label, lines: [o.line], scene: '' };
    return h('div.vs-explain', { 'data-q': q, 'data-k': key },
      h('div.vs-burst', { 'aria-hidden': 'true' }, ...Array.from({ length: 16 }, (_, n) => setVar(h('i'), '--a', `${n * 22.5}deg`))),
      h('div.vs-winner', h('span.vs-emoji', { 'aria-hidden': 'true' }, EMOJI[o.icon] || '⭐'), h('h1.vs-big', x.title)),
      h('div.vs-scenebox', explainScene(x.scene)),
      h('ul.vs-lines', x.lines.map((l, n) => setVar(h('li', l), '--i', n))));
  }

  // ---- the driver ----
  function driverAsk() {
    const yes = h('button.vs-dbtn.yes', { type: 'button' }, h('span', '🚗'), h('b', "I'll drive"), h('span.vs-dots'));
    const no = h('button.vs-dbtn.no', { type: 'button' }, h('span', '🚶'), h('b', "I'll walk"), h('span.vs-dots'));
    yes.addEventListener('click', () => drive(true));
    no.addEventListener('click', () => drive(false));
    return h('div.vs-q.vs-driver', h('h1.vs-big.vs-prompt', 'Who wants', h('br'), 'to drive?'),
      h('p.vs-sub', 'Only if you can drive and have a car.'), h('div.vs-dbtns', yes, no));
  }
  async function drive(yes) {
    for (const b of stage.querySelectorAll('.vs-dbtn')) b.classList.toggle('mine', b.classList.contains(yes ? 'yes' : 'no'));
    try { await app.cmd({ type: 'drive', yes }); } catch { /* the next view says */ }
  }
  function paintDrive() {
    const v = S.view.vote;
    const d = v.drive || {};
    for (const b of stage.querySelectorAll('.vs-dbtn')) {
      const want = b.classList.contains('yes');
      const who = Object.entries(d).filter(([, y]) => y === want).map(([pid]) => pid);
      const dots = b.querySelector('.vs-dots');
      const sig = who.join(',');
      if (dots.dataset.sig !== sig) { dots.dataset.sig = sig; fill(dots, who.map((pid) => faceFor(pid, 26, 'vs-dot'))); }
      if (d[meId()] !== undefined) b.classList.toggle('mine', d[meId()] === want);
    }
  }
  const volunteers = (v) => Object.entries(v.drive || {}).filter(([id, y]) => y === true && players().some((p) => p.id === id)).map(([id]) => id).sort();
  const theDriver = (v) => (v.driver !== null && v.driver !== undefined ? v.driver : driverOf(v, players().map((p) => p.id)));
  function wheel() {
    const v = S.view.vote;
    const ids = volunteers(v);
    const pickId = theDriver(v);
    if (!ids.length || !pickId) {
      return h('div.vs-call', h('h1.vs-big.vs-slam', 'Nobody', h('br'), 'drives!'), h('p.vs-sub', 'Everybody walks. Good luck.'));
    }
    const seg = 360 / ids.length;
    const disc = h('div.vs-wheel-disc');
    disc.style.setProperty('--n', String(ids.length));
    ids.forEach((id, i) => {
      const label = setVar(h('span.vs-wheel-label', faceFor(id, 34), h('b', byId(id).name || '?')), '--a', `${i * seg + seg / 2}deg`);
      disc.appendChild(label);
    });
    const at = ids.indexOf(pickId);
    const land = 360 * 6 + (360 - (at * seg + seg / 2));
    disc.style.setProperty('--land', `${land}deg`);
    const name = h('p.vs-wheel-name', byId(pickId).name || '');
    return h('div.vs-spin', h('h1.vs-big.vs-prompt', 'Spinning…'),
      h('div.vs-wheel', h('i.vs-wheel-pin'), disc), name);
  }

  function results() {
    const v = S.view.vote;
    const k = winnerOf(0);
    const o = OPTIONS.mode[k];
    const d = v.driverMs ? theDriver(v) : undefined;
    return h('div.vs-res',
      h('h1.vs-big.vs-slam', "Let's", h('br'), 'play!'),
      h('div.vs-wins',
        setVar(h('div.vs-win', h('span.vs-emoji', { 'aria-hidden': 'true' }, EMOJI[o.icon] || '⭐'), h('span.vs-opt-text', h('small', 'Game'), h('strong', o.label))), '--i', 0),
        d !== undefined ? setVar(h('div.vs-win', h('span.vs-emoji', { 'aria-hidden': 'true' }, d ? '🚗' : '🚶'), h('span.vs-opt-text', h('small', 'Driver'), h('strong', d ? (byId(d).name || '?') : 'Nobody'))), '--i', 1) : null),
      h('p.vs-sub', S.view.me && S.view.me.host ? 'Hit Start when everyone\'s ready!' : 'Waiting for the host to start the game.'));
  }

  function show(key, el, where = 'side', mood = '') {
    if (S.key) channel();
    S.key = key;
    fill(stage, el);
    layer.dataset.scene = key.split(':')[0];
    layer.dataset.host = where;
    host.mood(mood);
  }

  function tick() {
    if (S.dead) return;
    const v = S.view && S.view.vote;
    const at = v ? stageAt(v, now()) : { stage: 'done' };
    if (!v || at.stage === 'done') {
      layer.hidden = true;
      doc.documentElement.classList.remove('vs-on');
      S.key = '';
      return;
    }
    layer.hidden = false;
    doc.documentElement.classList.add('vs-on');
    let skipped = false;
    const countdown = () => { const secs = Math.ceil(at.left / 1000); text(clock, String(secs)); clock.classList.toggle('hurry', secs <= 3); };
    if (at.stage === 'intro') {
      skipped = S.localSkip === v.id;
      const beat = skipped ? { key: 'wait', line: null, host: 'hero' } : beatAt(at.ms, v.introMs);
      const key = `intro:${beat.key}`;
      if (S.key !== key) {
        const el = beat.key === 'title' ? title() : SCENES[beat.key] ? SCENES[beat.key]() : h('div.vs-call', h('h1.vs-big', 'Get ready…'));
        show(key, el, beat.host, beat.key === 'title' || beat.key === 'gearcall' ? 'happy' : beat.key === 'safety' ? 'wow' : '');
        if (beat.line) say(beat.line);
      }
      text(clock, '');
    } else if (at.stage === 'gear') {
      if (S.key !== 'gear') {
        S.gearSig = '';
        show('gear', gearScreen(), 'side', 'happy');
        say('gear2');
        if (S.tapped && !S.gearRun && !S.gear) runGear();
      }
      paintGear();
      countdown();
    } else if (at.stage === 'question') {
      const key = `q:${at.i}`;
      if (S.key !== key) {
        show(key, question(at.i), 'side', 'wow');
        layer.classList.remove('dive'); void layer.offsetWidth; layer.classList.add('dive');
        say(`q_${v.questions[at.i].q}`);
      }
      paintDots(at.i);
      countdown();
    } else if (at.stage === 'explain') {
      const q = v.questions[at.i].q;
      if (at.ms < DRUM_MS) {
        const key = `drum:${at.i}`;
        if (S.key !== key) show(key, drum(at.i), 'side', 'wow');
      } else {
        const k = winnerOf(at.i);
        const key = `explain:${at.i}:${k}`;
        if (S.key !== key) {
          show(key, explain(at.i), 'side', 'happy');
          say(`e_${q}_${k}`);
        }
      }
      text(clock, '');
    } else if (at.stage === 'driver') {
      if (S.key !== 'driver') { show('driver', driverAsk(), 'side', 'wink'); say('q_driver'); }
      paintDrive();
      countdown();
    } else if (at.stage === 'spin') {
      const key = `spin:${volunteers(v).join(',')}:${theDriver(v)}`;
      if (S.key !== key && !S.key.startsWith('spin:')) {
        show(key, wheel(), 'side', 'wow');
        say(volunteers(v).length ? 'spin' : 'nodriver');
      }
      text(clock, '');
    } else {
      const key = `res:${winnerOf(0)}:${v.driverMs ? theDriver(v) : ''}`;
      if (S.key !== key) { show(key, results(), 'hero', 'happy'); say('results2'); }
      text(clock, '');
    }
    skipBtn.hidden = at.stage !== 'intro' || skipped || !(S.view.me && S.view.me.host);
    layer.dataset.stage = at.stage;
  }

  S.timer = setInterval(tick, 150);

  return {
    el: layer,
    update(view) {
      if (S.dead || !view) return;
      S.view = view;
      if (Number.isFinite(view.now)) S.skew = view.now - Date.now();
      if (view.vote && view.vote.id !== S.voteId) { S.voteId = view.vote.id; S.key = ''; S.gear = null; }
      tick();
    },
    destroy() {
      S.dead = true;
      clearInterval(S.timer);
      try { narr.pause(); } catch { /* fine */ }
      doc.removeEventListener('pointerdown', unlock, { capture: true });
      doc.documentElement.classList.remove('vs-on');
      layer.remove();
    },
  };
}
