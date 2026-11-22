// Night Ops v1.6: the lobby vote's show, Jackbox style, on everyone's own phone (no TV). The host taps Let's vote;
// every phone plays the same show from the server's clock (view.now), hosted by Static, a talking walkie-talkie
// (the Retro Radio voice, audio/narrator/*.mp3, with captions in his speech bubble):
//
//   intro     the title, then three little 3D scenes: hiders, hunters, the ring (live location outside it)
//   gear      the group gear check: each phone checks its location, microphone (and camera, when the game films),
//             and everyone's ticks show on every phone
//   question  each question's cards flip in; tap your pick; everyone's faces show on the cards they picked
//   explain   a drum roll, the winner slams in, and a scene shows how it plays
//   results   every winner, then the lobby comes back
//
//   const show = createVoteShow(app);   show.update(view)   show.destroy()
// Its styles are css/vote.css (motion: transforms with perspective, CSS only; less motion = no movement).
import { h, fill, text, face } from '../dom.js?v=161';
import { OPTIONS, PROMPTS, EXPLAIN, stageAt, winner } from '../../shared/vote.js?v=161';

const AUDIO = 'audio/narrator/';
const MUTE_KEY = 'nightops-narrator';   // 'off' = the narrator stays quiet on this phone
export const DRUM_MS = 1300;            // the explainer's drum roll before the winner slams in
// The intro's beats (ms into it) and Static's line for each.
export const BEATS = [
  { at: 0, key: 'title', line: 'intro' },
  { at: 6600, key: 'hiders', line: 'how1' },
  { at: 13400, key: 'hunters', line: 'how2' },
  { at: 18100, key: 'ring', line: 'how3' },
  { at: 26000, key: 'gearcall', line: 'gearcall' },
];
// What Static says (the captions in his bubble), by sound file.
export const LINES = {
  intro: "Welcome to Night Ops! I'm Static, your host for tonight. Let's go over how this works, real quick.",
  how1: 'Hiders: you run and you hide. Every few minutes, your phone pings the hunters with a circle around where you are.',
  how2: 'Hunters: follow the pings, track them down, and tag them for real.',
  how3: "And everybody: stay inside the ring. Step outside, and your exact location goes live on everyone's map, in real time.",
  gearcall: 'Before we vote... gear check!',
  gear: 'Let your phone use your location, your microphone, and your camera. Wait for the green checks!',
  q_mode: 'Which game are we playing?',
  q_length: 'How long are we going?',
  q_pings: 'How often do hiders get pinged?',
  q_powers: 'Powers, or no powers?',
  q_caught: 'When a hider gets caught... what happens?',
  q_ring: 'What does the ring do?',
  q_walkies: 'Who gets a walkie-talkie?',
  results: "The votes are in! Host, hit start when everybody's ready.",
  e_mode_classic: "Classic it is! Hunters chase, hiders hide. Last one standing wins it for the hiders.",
  e_mode_checkpoints: "Checkpoints! One opens at a time. Get there, snap the photo. Most checkpoints wins.",
  e_mode_loot: "Loot drops! Boxes fall around the ring. Grab one, crack it open, and get a power. Common, rare... or legendary!",
  e_length_quick: "Twenty minutes! Short and sweaty.",
  e_length_standard: "Forty-five minutes. The classic.",
  e_length_long: "Ninety minutes! The long haul. Bring snacks.",
  e_pings_chill: "Chill pings. Every six minutes. More time to sneak around.",
  e_pings_normal: "Normal pings. Right in step with the game.",
  e_pings_rapid: "Rapid pings! Every two minutes. Keep moving!",
  e_powers_all: "All powers! Radar, Exposure and Hacker for the hunters. Jammer, Decoy and Sprint for the hiders.",
  e_powers_basic: "Just the basics. No Hacker, no Wiretap.",
  e_powers_none: "No powers! Just legs and lungs.",
  e_caught_join: "Caught? You join the hunt! The hunters grow as it goes.",
  e_caught_out: "Caught? You sit out and watch. No giving hiders away!",
  e_ring_steady: "The ring stays put. Stay inside, the whole game.",
  e_ring_shrink: "The ring shrinks! Near the end, it closes in to half.",
  e_ring_squeeze: "Tight squeeze! The ring closes in to thirty percent. Nowhere left to hide.",
  e_walkies_hunters: "Walkies for the hunters only. Hiders, keep it quiet.",
  e_walkies_both: "Walkies for both teams! Hold to talk, and go quiet when you're sneaking.",
};
const EMOJI = {
  target: '🎯', flag: '🚩', gift: '🎁', bolt: '⚡', moon: '🌙', owl: '🦉', sleep: '😴', radar: '📡', siren: '🚨',
  bolt2: '✨', shield: '🛡️', ban: '🚫', zombie: '🧟', chair: '🪑', circle: '⭕', shrink: '🌀', squeeze: '🤏', mic: '🎙️', mics: '📻',
};
export const TAGS = ['hide and seek, but your phone snitches', 'cardio, but make it sneaky', 'the bushes are your best friend now', 'trust nobody.'];

function muted() { try { return localStorage.getItem(MUTE_KEY) === 'off'; } catch { return false; } }
const sv = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) el.appendChild(k);
  return el;
};
const setVar = (el, name, v) => { el.style.setProperty(name, String(v)); return el; };

// The beat of the intro at `ms` into it (a skipped intro is only the last one).
export function beatAt(ms, introMs) {
  if (introMs < BEATS[BEATS.length - 1].at) return BEATS[BEATS.length - 1];
  let b = BEATS[0];
  for (const x of BEATS) if (ms >= x.at) b = x;
  return b;
}

// ---- Static, the host: a cartoon walkie-talkie (SVG) with a bendy antenna, blinking eyes and a speaker-grille
// mouth that moves while he talks. makeStatic() -> { el, talk(on), pose(name) }
export function makeStatic() {
  const grille = [0, 1, 2, 3].map((i) => sv('rect', { class: 'st-bar', x: 36, y: 92 + i * 9, width: 48, height: 5, rx: 2.5 }));
  const svg = sv('svg', { viewBox: '0 0 120 170', class: 'st-svg', 'aria-hidden': 'true', focusable: 'false' },
    sv('g', { class: 'st-ant' },
      sv('rect', { x: 78, y: 4, width: 8, height: 40, rx: 4, class: 'st-ink-fill' }),
      sv('circle', { cx: 82, cy: 8, r: 8, class: 'st-tip' })),
    sv('g', { class: 'st-arm st-arm-l' }, sv('path', { d: 'M18 92 q-16 6 -14 24', class: 'st-limb' }), sv('circle', { cx: 4, cy: 118, r: 7, class: 'st-glove' })),
    sv('g', { class: 'st-arm st-arm-r' }, sv('path', { d: 'M102 92 q16 6 14 24', class: 'st-limb' }), sv('circle', { cx: 116, cy: 118, r: 7, class: 'st-glove' })),
    sv('rect', { x: 34, y: 150, width: 18, height: 12, rx: 6, class: 'st-foot' }),
    sv('rect', { x: 68, y: 150, width: 18, height: 12, rx: 6, class: 'st-foot' }),
    sv('rect', { x: 16, y: 36, width: 88, height: 120, rx: 18, class: 'st-body' }),
    sv('rect', { x: 26, y: 46, width: 68, height: 38, rx: 10, class: 'st-screen' }),
    sv('g', { class: 'st-eyes' },
      sv('ellipse', { cx: 47, cy: 65, rx: 7, ry: 9, class: 'st-eye' }),
      sv('ellipse', { cx: 73, cy: 65, rx: 7, ry: 9, class: 'st-eye' }),
      sv('circle', { cx: 49, cy: 67, r: 3.2, class: 'st-pupil' }),
      sv('circle', { cx: 75, cy: 67, r: 3.2, class: 'st-pupil' })),
    sv('g', { class: 'st-grille' }, ...grille),
    sv('circle', { cx: 92, cy: 132, r: 5, class: 'st-led' }),
    sv('rect', { x: 28, y: 128, width: 22, height: 9, rx: 4.5, class: 'st-btn' }));
  const el = h('div.st', { 'aria-hidden': 'true' }, svg);
  return {
    el,
    talk(on) { el.classList.toggle('talk', !!on); },
    pose(name) { el.dataset.pose = name || ''; },
  };
}

export function createVoteShow(app, { doc = globalThis.document } = {}) {
  const S = {
    view: null, skew: 0, key: '', localSkip: 0, timer: null, dead: false, played: new Set(), voteId: null,
    tapped: false, gear: null, gearRun: null, explainKey: '', talkUntil: 0,
  };
  const layer = h('div.vs', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'The vote' });
  const stage = h('div.vs-stage');
  const clock = h('div.vs-clock', { 'aria-hidden': 'true' });
  const muteBtn = h('button.vs-mute', { type: 'button' });
  const skipBtn = h('button.vs-skip', { type: 'button' }, 'Skip ▸');
  const stars = h('div.vs-stars');
  const sky = h('div.vs-sky', { 'aria-hidden': 'true' }, h('div.vs-rays'), stars, h('div.vs-stars.far'));
  const host = makeStatic();
  const bubble = h('p.vs-bubble', { 'aria-live': 'polite' });
  const hostBox = h('div.vs-host', host.el, bubble);
  layer.append(sky, stage, hostBox, clock, h('div.vs-top', muteBtn, skipBtn));
  doc.body.appendChild(layer);
  const narr = new Audio();
  narr.preload = 'auto';
  narr.addEventListener('playing', () => host.talk(true));
  for (const ev of ['ended', 'pause', 'error']) narr.addEventListener(ev, () => host.talk(Date.now() < S.talkUntil && muted()));
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
  skipBtn.addEventListener('click', () => { S.localSkip = S.voteId; S.key = ''; tick(); });

  // Static says a line: the sound (unless muted) and the caption; his mouth moves while it plays.
  function say(line, words = LINES[line]) {
    const id = `${S.voteId}:${line}`;
    if (S.played.has(id)) return;
    S.played.add(id);
    if (words) { text(bubble, words); bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop'); }
    S.talkUntil = Date.now() + Math.min(7000, 900 + String(words || '').length * 55);
    if (muted()) { host.talk(true); setTimeout(() => host.talk(Date.now() < S.talkUntil && !narr.paused), S.talkUntil - Date.now()); return; }
    try { narr.src = `${AUDIO}${line}.mp3`; const p = narr.play(); if (p && p.catch) p.catch(() => host.talk(false)); } catch { /* no sound: the words are in the bubble */ }
  }

  const now = () => Date.now() + S.skew;
  const players = () => {
    const out = {};
    for (const p of (S.view && S.view.players) || []) out[p.id] = p;
    return out;
  };
  const faceFor = (pid, size, extra = '') => {
    const p = players()[pid] || {};
    let src = null;
    try { src = app.faces && app.faces.get ? app.faces.get(pid) || null : null; } catch { src = null; }
    return face({ name: p.name || '?', src, team: null, size, extra });
  };

  // ---- the little 3D stages ----
  // A tilted night map (a plane leaning back), with the ring on it; `kids` are dots and effects on the plane.
  function plane(cls, ...kids) {
    return h(`div.vs-world${cls ? `.${cls}` : ''}`, { 'aria-hidden': 'true' },
      h('div.vs-plane', h('div.vs-grid'), h('div.vs-ringshape'), ...kids));
  }
  const dot = (team, cls = '') => h(`span.vs-pdot.t-${team}${cls ? `.${cls}` : ''}`);

  function title() {
    const tag = TAGS[(S.voteId || 0) % TAGS.length];
    const word = (w, cls) => h(`span.vs-word.${cls}`, [...w].map((ch, i) => setVar(h('span.vs-letter', ch), '--i', i)));
    return h('div.vs-title',
      h('div.vs-moon', { 'aria-hidden': 'true' }),
      h('h1.vs-logo', word('NIGHT', 'vs-l1'), word('OPS', 'vs-l2')),
      h('p.vs-tag', tag));
  }
  function sceneHiders() {
    return h('div.vs-scene',
      h('p.vs-kicker.hider', 'Hiders'),
      h('h2.vs-scene-title', 'Run. Hide.', h('br'), 'Get pinged.'),
      plane('', dot('hider', 'run1'), dot('hider', 'run2'), h('span.vs-pingring'), h('span.vs-pingring.late'), dot('hider', 'pinged')),
      h('div.vs-phone', { 'aria-hidden': 'true' }, h('span', 'PING!')));
  }
  function sceneHunters() {
    return h('div.vs-scene',
      h('p.vs-kicker.hunter', 'Hunters'),
      h('h2.vs-scene-title', 'Follow the pings.', h('br'), 'Tag them for real.'),
      plane('', h('span.vs-pingring.still'), dot('hider', 'prey'), dot('hunter', 'chase1'), dot('hunter', 'chase2'), h('span.vs-tagstar', 'TAG!')));
  }
  function sceneRing() {
    return h('div.vs-scene',
      h('p.vs-kicker.warn', 'Everyone'),
      h('h2.vs-scene-title', 'Stay in the ring.'),
      plane('', dot('hider', 'stepout'), h('span.vs-livebadge', '📍 LIVE LOCATION')),
      h('p.vs-scene-sub', 'Step out and everyone sees exactly where you are.'));
  }
  function gearCall() {
    return h('div.vs-call',
      h('h1.vs-big.vs-slam', 'Gear', h('br'), 'check!'),
      h('div.vs-gearicons', { 'aria-hidden': 'true' }, ...['📍', '🎙️', '📷'].map((e, i) => setVar(h('span', e), '--i', i))));
  }

  // ---- the gear check ----
  const GEAR_PARTS = [['loc', '📍', 'Location'], ['mic', '🎙️', 'Mic'], ['cam', '📷', 'Camera']];
  const wantsCam = () => !!(S.view && S.view.settings && S.view.settings.cam);
  function gearScreen() {
    const grid = h('div.vs-gear-grid');
    const mine = h('div.vs-gear-mine');
    const again = h('button.btn.vs-gear-go', { type: 'button' }, 'Check my gear');
    again.addEventListener('click', () => runGear());
    S.gearEls = { grid, mine, again };
    return h('div.vs-gear',
      h('h1.vs-big.vs-prompt', 'Gear check'),
      mine, again, grid);
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
    const meId = S.view.me && S.view.me.id;
    const g = { ...(v.gear || {}) };
    const sig = JSON.stringify([g, S.gear, wantsCam()]);
    if (sig === S.gearSig) return;
    S.gearSig = sig;
    const mineNow = S.gear || g[meId] || null;
    fill(els.mine, GEAR_PARTS.map(([k, e, label]) => {
      const st = k === 'cam' && !wantsCam() ? 'off' : mineNow ? mineNow[k] : null;
      return h('div.vs-gear-row', gearIcon(st, e, label), h('span', label),
        h('strong', st === true ? 'Ready' : st === false ? 'Fix it' : st === 'busy' ? 'Checking…' : st === 'off' ? 'Not this game' : '—'));
    }));
    text(els.again, S.gearRun ? 'Checking…' : mineNow ? 'Check again' : 'Check my gear');
    els.again.disabled = !!S.gearRun;
    fill(els.grid, ((S.view && S.view.players) || []).map((p, i) => {
      const pg = p.id === meId && S.gear ? S.gear : g[p.id];
      const allOk = pg && pg.loc === true && pg.mic === true && (pg.cam === true || !wantsCam());
      return setVar(h(`div.vs-gear-card${allOk ? '.ready' : ''}`, faceFor(p.id, 40),
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

  // ---- a question ----
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
    return h('div.vs-q', { 'data-q': q.q },
      h('p.vs-qn', `${i + 1} / ${v.questions.length}`),
      h('h1.vs-big.vs-prompt', PROMPTS[q.q]),
      h('div.vs-opts', opts));
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

  // ---- the winner and how it plays ----
  // The winner: the server's once it has said, else worked out here from the picks (the same rule, so they agree).
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
  function explainScene(scene, q, key) {
    const o = OPTIONS[q][key];
    switch (scene) {
      case 'classic': return plane('', dot('hider', 'flee'), dot('hunter', 'chase1'), dot('hunter', 'chase2'));
      case 'checkpoints': return plane('', ...[0, 1, 2].map((n) => setVar(h('span.vs-flag', '🚩'), '--i', n)), h('span.vs-flash'));
      case 'loot': return h('div.vs-lootshow', { 'aria-hidden': 'true' },
        h('span.nloot-box.big', h('span.nloot-lid'), h('span.nloot-body')),
        h('span.vs-rarities', ...['COMMON', 'RARE', 'LEGENDARY!'].map((w, n) => setVar(h(`span.r${n}`, w), '--i', n))));
      case 'clock': return h('div.vs-clockface', { 'aria-hidden': 'true' }, ...((o.line.match(/\d+/) || ['45'])[0]).padStart(2, '0').split('').concat([':', '0', '0']).map((d, n) => setVar(h('span.vs-digit', d), '--i', n)));
      case 'ping': return plane(`ping-${key}`, dot('hider', 'sit'), h('span.vs-pingring.loop'), h('span.vs-pingring.loop.late'), h('span.vs-every', o.line));
      case 'powers': return h('div.vs-fan', { 'aria-hidden': 'true' }, ...(key === 'basic' ? ['📡', '👁️', '📵', '🎭', '💨'] : ['📡', '🚨', '👁️', '📵', '🎭', '💨'])
        .map((e, n, all) => setVar(setVar(h('span.vs-pcard', e), '--i', n), '--n', all.length)));
      case 'nopowers': return h('div.vs-fan.none', { 'aria-hidden': 'true' }, ...['📡', '📵', '🎭'].map((e, n) => setVar(setVar(h('span.vs-pcard', e), '--i', n), '--n', 3)), h('span.vs-banstamp', '🚫'));
      case 'join': return plane('', dot('hunter', 'tagger'), dot('hider', 'turns'), h('span.vs-plus', '+1 hunter'));
      case 'out': return plane('', dot('hunter', 'tagger'), dot('hider', 'benched'), h('span.vs-bench', '🪑'));
      case 'ring': return plane('', dot('hider', 'stepout'), h('span.vs-livebadge', '📍 LIVE LOCATION'));
      case 'shrink': return plane(`shrink-${key}`, dot('hider', 'sit'));
      case 'walkie': return h('div.vs-walkies', { 'aria-hidden': 'true' },
        h('span.vs-wt.t-hunter', '📻', h('i.vs-wave'), h('i.vs-wave.late')),
        ...(key === 'both' ? [h('span.vs-wt.t-hider', '📻', h('i.vs-wave'), h('i.vs-wave.late'))] : [h('span.vs-wt.t-hider.quiet', '🤫')]));
      default: return h('div');
    }
  }
  function explain(i) {
    const v = S.view.vote;
    const q = v.questions[i].q;
    const key = winnerOf(i);
    const x = (EXPLAIN[q] && EXPLAIN[q][key]) || { title: OPTIONS[q][key].label, lines: [OPTIONS[q][key].line], scene: '' };
    const o = OPTIONS[q][key];
    return h('div.vs-explain', { 'data-q': q, 'data-k': key },
      h('div.vs-burst', { 'aria-hidden': 'true' }, ...Array.from({ length: 16 }, (_, n) => setVar(h('i'), '--a', `${n * 22.5}deg`))),
      h('div.vs-winner', h('span.vs-emoji', { 'aria-hidden': 'true' }, EMOJI[o.icon] || '⭐'), h('h1.vs-big', x.title)),
      h('div.vs-scenebox', explainScene(x.scene, q, key)),
      h('ul.vs-lines', x.lines.map((l, n) => setVar(h('li', l), '--i', n))));
  }

  function results() {
    const v = S.view.vote;
    return h('div.vs-res',
      h('h1.vs-big.vs-slam', 'The votes', h('br'), 'are in!'),
      h('div.vs-wins', v.questions.map((q, i) => {
        const k = winnerOf(i);
        const o = k ? OPTIONS[q.q][k] : null;
        return setVar(h('div.vs-win', { 'data-i': String(i) },
          h('span.vs-emoji', { 'aria-hidden': 'true' }, o ? (EMOJI[o.icon] || '⭐') : '…'),
          h('span.vs-opt-text', h('small', PROMPTS[q.q]), h('strong', o ? o.label : 'Counting…'))), '--i', i);
      })),
      h('p.vs-sub', S.view.me && S.view.me.host ? 'Settings updated. Hit Start when everyone\'s ready!' : 'Waiting for the host to start the game.'));
  }

  function show(key, el, pose = '') {
    S.key = key;
    fill(stage, el);
    layer.dataset.scene = key.split(':')[0];
    host.pose(pose);
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
    if (at.stage === 'intro') {
      skipped = S.localSkip === v.id;
      const beat = skipped ? { key: 'wait', line: null } : beatAt(at.ms, v.introMs);
      const key = `intro:${beat.key}`;
      if (S.key !== key) {
        const els = { title, hiders: sceneHiders, hunters: sceneHunters, ring: sceneRing, gearcall: gearCall };
        show(key, els[beat.key] ? els[beat.key]() : h('div.vs-call', h('h1.vs-big', 'Get ready…')), beat.key === 'title' ? 'wave' : beat.key === 'gearcall' ? 'jump' : 'point');
        if (beat.line) say(beat.line);
      }
      text(clock, '');
    } else if (at.stage === 'gear') {
      if (S.key !== 'gear') {
        S.gearSig = '';
        show('gear', gearScreen(), 'jump');
        say('gear');
        if (S.tapped && !S.gearRun && !S.gear) runGear();
      }
      paintGear();
      const secs = Math.ceil(at.left / 1000);
      text(clock, String(secs));
      clock.classList.toggle('hurry', secs <= 3);
    } else if (at.stage === 'question') {
      const key = `q:${at.i}`;
      if (S.key !== key) {
        show(key, question(at.i), 'point');
        say(`q_${v.questions[at.i].q}`);
      }
      paintDots(at.i);
      const secs = Math.ceil(at.left / 1000);
      text(clock, String(secs));
      clock.classList.toggle('hurry', secs <= 3);
    } else if (at.stage === 'explain') {
      const q = v.questions[at.i].q;
      if (at.ms < DRUM_MS) {
        const key = `drum:${at.i}`;
        if (S.key !== key) show(key, drum(at.i), 'drum');
      } else {
        const k = winnerOf(at.i);
        const key = `explain:${at.i}:${k}`;
        if (S.key !== key) {
          show(key, explain(at.i), 'cheer');
          const x = EXPLAIN[q] && EXPLAIN[q][k];
          say(`e_${q}_${k}`, LINES[`e_${q}_${k}`] || (x ? `${x.title} ${x.lines.join(' ')}` : ''));
        }
      }
      text(clock, '');
    } else {
      const key = `res:${(v.questions || []).map((_, i) => winnerOf(i)).join(',')}`;
      if (S.key !== key) { show(key, results(), 'wave'); say('results'); }
      text(clock, '');
    }
    skipBtn.hidden = at.stage !== 'intro' || skipped;
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
