// Night Ops v1.7: the FX library (CONTRACT.md "v1.7: the card overhaul", section 13). Big, themed, game-like effects
// for every card and every big moment, so a round feels like a video game. Everything here is art: it never decides
// who may see what (the engine's events and cards.js `cardFxOf` do), never takes a tap (pointer-events none, except
// the Snitch call screen, which is a real screen with buttons), sits under the top bar (SOS stays in sight) and moves
// by transform and opacity only (60 fps on a mid Android). prefers-reduced-motion gets a calm version (`.still`:
// the end of each move, no flashing). Sounds are tiny WebAudio blips made on the spot (no files), only when the
// game's Sound switch is on (alerts.js soundOn); vibration where the phone allows.
//
// The API (the wiring lane calls these; cards.js already uses cardTheme for every card-played effect):
//
//   cardTheme(fx, doc)            -> { el, sound, buzz, ms } the themed layer of a card-played effect (fx from
//                                 cardFxOf: power, who 'self'|'team'|'them', side, data). createCardFx puts it in.
//   createGameFx({ root, doc, sound }) -> { play(name, opts) -> boolean, busy(), destroy() }: the game's moments, one
//                                 big one at a time (a queue of 3), small ones ('headsup', 'crate-land') at once:
//       'drop-incoming' { ms }      the "DROP INCOMING" banner counting down, engine hum, a light buzz
//       'crate-land'    { x, y }    a thud and a dust ring at a screen point (or the middle)
//       'pinged'        { x, y }    a hider's own ping: sonar rings from their dot, "PINGED"
//       'ping-in'       { points }  a ping reaches the hunters: a ripple at each screen point, "PING!"
//       'ring-soon'     { ms }      "THE RING CLOSES IN 1:00": the edges pulse amber
//       'ring-shrinking' { ms }     the screen's edge sweeps inward, red, "RING CLOSING!"
//       'headsup'       { d, dir }  red radar pulse from the edges (brightest toward `dir` deg, 0 = up), "HUNTER NEAR!"
//       'call-ring'     { name, offer } a short "incoming call" flash (the real screen is createCallScreen)
//       'snitched'      {}          "Someone snitched on you 👀": a spotlight and a hit
//       'deal'          {}          the hunters: "A HIDER TOOK THE DEAL!"
//       'mirror'        { what: 'reflect'|'blocked'|'bounce' } the screen flips like a mirror / glass shield cracks /
//                                   the card ricochets
//       'bounced'       {}          a hunter's own Hacker came back: "BOUNCED!" and the alarm
//       'box-grab'      {}          a box grabbed: a gold pop
//   createCallScreen({ root, doc, name, offer, mates, ms, sound, onAccept, onHangup, onTalk, onSnitch, state })
//                                 -> { el, set(state: 'ringing'|'talk'|'pick'|'ended', words?), left(ms), close() }:
//                                 the Snitch call (the callee's phone rings; the caller sees 'talk' with no Snitch
//                                 button: pass `caller: true`). onTalk(true|false) is push-to-talk. `state` opens it
//                                 in another state ('talk': a callee who had answered before a reload).
//   pawTrail(layer, points, { ms, spacing, doc }) -> { el, remove() }: dog paw prints along screen points [[x, y]],
//                                 turned along the way, left-right, the newest darkest, trotting in one after another.
//   flyPlane(layer, { path: [[x,y],[x,y]], ms, drops: [[x,y]], fall, doc, onLand }) -> { el, remove() }: the drop
//                                 plane (tilted, a shadow on the map, a contrail) flying the path, crates under
//                                 parachutes falling to the drops, then a thud and a 10 m glow at each.
//   planeEl(doc), crateChuteEl(doc), pawEl(doc), dustEl(doc)   single pieces of map art (WIRING places them).
//   frost(target, { doc }) -> { crack(), remove() }: a frost layer over any element (the cards button, the binder);
//                                 crack() shatters it off.
//   Lasting looks: classes on the game's root, toggled by WIRING from view.fx: .fx-frozen .fx-useless .fx-mirror
//                                 .fx-headsup .fx-snitched (css/fx.css).
//   fxSound(name, doc), FX_SOUNDS   the synth sounds; MOMENTS   the moment names.
import { h, text } from './dom.js?v=181';
import { soundOn } from './alerts.js?v=181';

// ---- small helpers -----------------------------------------------------------------------------------------------

const still = (doc) => { try { return doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
function buzz(p) { try { const d = globalThis.document; if (d && d.visibilityState === 'hidden') return; const n = globalThis.navigator; if (n && typeof n.vibrate === 'function') n.vibrate(p); } catch { /* fine */ } }
const r = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
// n pieces with CSS vars from fn(i, rand) -> { cls?, vars, text? }
function bits(n, cls, fn, seed = 7) {
  const rand = r(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = fn(i, rand) || {};
    const el = h(`i.${cls}${o.cls ? `.${o.cls}` : ''}`, o.text || null);
    for (const [k, v] of Object.entries(o.vars || {})) el.style.setProperty(`--${k}`, String(v));
    out.push(el);
  }
  return out;
}
const div = (cls, ...kids) => h(`div.${cls}`, ...kids);

// ---- sounds: tiny synth blips (no files) --------------------------------------------------------------------------

let AC = null;
function ac() {
  if (AC) return AC;
  const C = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!C) return null;
  try { AC = new C(); } catch { AC = null; }
  return AC;
}
function tone(c, { f = 440, f2 = null, at = 0, t = 0.15, type = 'sine', g = 0.12 }) {
  const o = c.createOscillator();
  const v = c.createGain();
  const t0 = c.currentTime + at;
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + t);
  v.gain.setValueAtTime(0.0001, t0);
  v.gain.exponentialRampToValueAtTime(g, t0 + 0.012);
  v.gain.exponentialRampToValueAtTime(0.0001, t0 + t);
  o.connect(v).connect(c.destination);
  o.start(t0);
  o.stop(t0 + t + 0.02);
}
function noise(c, { at = 0, t = 0.3, g = 0.1, lp = 1200, hp = 0 }) {
  const len = Math.max(1, Math.floor(c.sampleRate * t));
  const b = c.createBuffer(1, len, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = c.createBufferSource();
  s.buffer = b;
  const f = c.createBiquadFilter();
  f.type = hp ? 'highpass' : 'lowpass';
  f.frequency.value = hp || lp;
  const v = c.createGain();
  v.gain.value = g;
  s.connect(f).connect(v).connect(c.destination);
  s.start(c.currentTime + at);
}
export const FX_SOUNDS = {
  whoosh: (c) => noise(c, { t: 0.45, lp: 900, g: 0.16 }),
  sparkle: (c) => { for (let i = 0; i < 5; i++) tone(c, { f: 1200 + i * 260, at: i * 0.06, t: 0.18, type: 'triangle', g: 0.06 }); },
  bell: (c) => { tone(c, { f: 880, t: 0.6, type: 'triangle' }); tone(c, { f: 1320, at: 0.02, t: 0.5, g: 0.05 }); },
  sand: (c) => noise(c, { t: 0.9, hp: 3000, g: 0.05 }),
  wave: (c) => { tone(c, { f: 300, f2: 600, t: 0.4 }); tone(c, { f: 360, f2: 720, at: 0.2, t: 0.4 }); },
  pop: (c) => { tone(c, { f: 220, f2: 900, t: 0.12, type: 'square', g: 0.07 }); },
  zap: (c) => { tone(c, { f: 1800, f2: 120, t: 0.25, type: 'sawtooth', g: 0.06 }); },
  glass: (c) => { tone(c, { f: 2400, t: 0.4, type: 'triangle', g: 0.05 }); tone(c, { f: 3100, at: 0.05, t: 0.3, g: 0.04 }); },
  shatter: (c) => { noise(c, { t: 0.5, hp: 2500, g: 0.15 }); tone(c, { f: 2900, t: 0.2, type: 'triangle', g: 0.05 }); },
  slots: (c) => { for (let i = 0; i < 12; i++) tone(c, { f: 700 + (i % 3) * 120, at: i * 0.07, t: 0.04, type: 'square', g: 0.04 }); tone(c, { f: 1046, at: 0.95, t: 0.4, type: 'triangle', g: 0.1 }); },
  ding: (c) => tone(c, { f: 1046, t: 0.5, type: 'triangle', g: 0.1 }),
  static: (c) => noise(c, { t: 0.8, hp: 800, g: 0.09 }),
  off: (c) => tone(c, { f: 900, f2: 40, t: 0.5, type: 'sine', g: 0.12 }),
  alarm: (c) => { for (let i = 0; i < 4; i++) tone(c, { f: i % 2 ? 660 : 880, at: i * 0.16, t: 0.15, type: 'square', g: 0.05 }); },
  tick: (c) => { for (let i = 0; i < 8; i++) tone(c, { f: 1500, at: i * 0.07, t: 0.03, type: 'square', g: 0.05 }); },
  sonar: (c) => { tone(c, { f: 1200, f2: 1100, t: 0.9, g: 0.08 }); },
  bark: (c) => { tone(c, { f: 420, f2: 180, t: 0.12, type: 'sawtooth', g: 0.08 }); tone(c, { f: 420, f2: 180, at: 0.2, t: 0.12, type: 'sawtooth', g: 0.08 }); },
  howl: (c) => tone(c, { f: 380, f2: 760, t: 1.1, type: 'sawtooth', g: 0.05 }),
  rewind: (c) => tone(c, { f: 200, f2: 1600, t: 0.7, type: 'sawtooth', g: 0.04 }),
  slam: (c) => { noise(c, { t: 0.25, lp: 400, g: 0.3 }); tone(c, { f: 120, f2: 50, t: 0.3, g: 0.2 }); },
  ring: (c) => { for (let i = 0; i < 6; i++) tone(c, { f: i % 2 ? 1000 : 1250, at: i * 0.08, t: 0.07, g: 0.06 }); },
  ice: (c) => { noise(c, { t: 0.6, hp: 4000, g: 0.08 }); tone(c, { f: 2600, f2: 1800, t: 0.5, type: 'triangle', g: 0.04 }); },
  thunk: (c) => { tone(c, { f: 180, f2: 60, t: 0.18, type: 'square', g: 0.12 }); },
  flash: (c) => { noise(c, { t: 0.12, hp: 2000, g: 0.2 }); tone(c, { f: 3000, f2: 600, t: 0.3, g: 0.03 }); },
  engine: (c) => { const t = 1.6; tone(c, { f: 70, f2: 95, t, type: 'sawtooth', g: 0.05 }); tone(c, { f: 72, f2: 98, t, type: 'sawtooth', g: 0.04 }); },
  thud: (c) => { tone(c, { f: 90, f2: 40, t: 0.3, g: 0.22 }); noise(c, { t: 0.2, lp: 300, g: 0.15 }); },
  deal: (c) => { tone(c, { f: 523, t: 0.15, type: 'triangle' }); tone(c, { f: 784, at: 0.15, t: 0.3, type: 'triangle' }); },
  hit: (c) => { tone(c, { f: 200, f2: 60, t: 0.4, type: 'square', g: 0.09 }); },
};
export function fxSound(name, doc = globalThis.document, on = soundOn) {
  try {
    if (!name || !FX_SOUNDS[name] || !(typeof on === 'function' ? on() : on)) return false;
    if (doc && doc.visibilityState === 'hidden') return false;
    const c = ac();
    if (!c) return false;
    if (c.state === 'suspended') c.resume().catch(() => {});
    FX_SOUNDS[name](c);
    return true;
  } catch { return false; }
}

// ---- the card themes ---------------------------------------------------------------------------------------------
// One themed layer per card (both sides' Grab bag / Multiplier / Duplicator share theirs, in their side's colours).
// Each builder gets { who, side, data, still } and returns { kids, sound, buzz }. 'team' shows a small version of it
// (a strip behind the banner), 'self' and 'them' the whole screen.

const BASE = { grabbag_hider: 'grabbag', grabbag_hunter: 'grabbag', multiplier_hider: 'multiplier', multiplier_hunter: 'multiplier', duplicator_hider: 'duplicator', duplicator_hunter: 'duplicator' };
export const themeKey = (power) => BASE[power] || power;

const speed = (n) => bits(n, 'fx-streak', (i, q) => ({ vars: { y: `${Math.round(q() * 100)}%`, d: `${(q() * 0.35).toFixed(2)}s`, w: `${40 + Math.round(q() * 50)}%` } }), 11);
const sparkles = (n, seed = 3) => bits(n, 'fx-spark', (i, q) => ({ vars: { x: `${Math.round(q() * 100)}%`, y: `${Math.round(q() * 90)}%`, d: `${(q() * 0.9).toFixed(2)}s`, s: (0.5 + q()).toFixed(2) } }), seed);
const rings = (n, cls = 'fx-ring') => bits(n, cls, (i) => ({ vars: { d: `${i * 0.28}s` } }));
const big = (emoji, cls = '') => h(`b.fx-big${cls ? `.${cls}` : ''}`, emoji);
const word = (w, cls = '') => h(`b.fx-word${cls ? `.${cls}` : ''}`, w);

const THEMES = {
  sprint: () => ({ kids: [...speed(16), div('fx-dust', ...bits(6, 'fx-puff', (i, q) => ({ vars: { x: `${10 + i * 15}%`, d: `${(i * 0.08).toFixed(2)}s`, s: (0.7 + q() * 0.6).toFixed(2) } }))), big('🏃', 'run')], sound: 'whoosh', buzz: [20, 30, 20] }),
  smoke: () => ({ kids: bits(9, 'fx-cloud', (i, q) => ({ vars: { x: `${Math.round(q() * 90)}%`, y: `${30 + Math.round(q() * 60)}%`, d: `${(i * 0.09).toFixed(2)}s`, s: (1 + q() * 1.4).toFixed(2), dx: `${Math.round((q() - 0.5) * 80)}px` } }), 5), sound: 'whoosh', buzz: [40] }),
  lucky: () => ({ kids: [div('fx-rays'), big('🍀', 'spin'), ...sparkles(16), ...bits(10, 'fx-coin', (i, q) => ({ vars: { a: `${i * 36}deg`, d: `${(q() * 0.2).toFixed(2)}s` } }))], sound: 'sparkle', buzz: [20, 30, 20, 30, 60] }),
  headsup: () => ({ kids: [div('fx-edge-red'), ...rings(3, 'fx-sonar'), big('🔔', 'swing')], sound: 'bell', buzz: [80, 60, 80] }),
  stall: () => ({ kids: [div('fx-glass', div('fx-glass-top'), div('fx-glass-bot'), div('fx-stream'), ...bits(10, 'fx-grain', (i, q) => ({ vars: { d: `${(q() * 1.2).toFixed(2)}s`, x: `${Math.round((q() - 0.5) * 6)}px` } }))), word('+1:00 LATE', 'amber')], sound: 'sand', buzz: [30] }),
  eavesdrop: ({ data, card }) => {
    const hands = (Array.isArray(data && data.hands) ? data.hands : []).slice(0, 4);
    // one column per hunter: their name over their cards (real mini cards: emoji + name, never a key)
    const cols = hands.map((x, i) => {
      const keys = Object.keys((x && x.cards) || {}).slice(0, 3);
      const cards = keys.length ? keys.map((k) => (card && card(k)) || h('b', '?')) : [h('i.fx-ed-none', 'no cards')];
      const col = div('fx-ed-col', h('b.fx-ed-name', String((x && (x.name || x.id)) || 'Hunter')), div('fx-ed-cards', ...cards));
      col.style.setProperty('--d', `${0.6 + i * 0.12}s`);
      return col;
    });
    return { kids: [big('👂', 'ear'), ...rings(4, 'fx-arc'), div('fx-ed', ...(cols.length ? cols : [div('fx-ed-col', h('b.fx-ed-name', 'No hunter has cards'))]))], sound: 'wave', buzz: [20] };
  },
  grabbag: ({ data, card }) => ({ kids: [big('🎒', 'shake'), ...bits(12, 'fx-confetti', (i, q) => ({ vars: { a: `${i * 30 + q() * 20}deg`, c: ['#ffd23f', '#5fd0ff', '#ff5fd2', '#7ef0c0'][i % 4] } })), div('fx-gotcard', (data && data.got && card && card(data.got)) || (data && data.gotName ? data.gotName : '?'))], sound: 'pop', buzz: [30, 40, 60] }),
  decoy: () => ({ kids: [div('fx-holo', big('📍', 'pin'), div('fx-scan')), big('🎭', 'masks')], sound: 'zap', buzz: [20] }),
  jammer: () => ({ kids: [div('fx-bars', ...bits(5, 'fx-bar', (i) => ({ vars: { i, d: `${0.1 + i * 0.07}s` } }))), div('fx-scramble'), word('JAMMED', 'stamp')], sound: 'static', buzz: [15, 15, 15, 15, 40] }),
  swap: ({ data }) => ({ kids: [div('fx-av.a', String((data && data.meName) || 'You').slice(0, 1)), div('fx-av.b', String((data && data.withName) || '?').slice(0, 1)), div('fx-swapcard.one'), div('fx-swapcard.two'), big('🎲', 'dice')], sound: 'whoosh', buzz: [20, 40, 20] }),
  lookout: () => ({ kids: [div('fx-dark'), div('fx-beam'), ...bits(4, 'fx-hdot', (i, q) => ({ vars: { x: `${15 + Math.round(q() * 70)}%`, y: `${15 + Math.round(q() * 55)}%`, d: `${0.5 + i * 0.25}s` } }), 9), big('🔦', 'torch')], sound: 'zap', buzz: [20] }),
  glitch: () => ({ kids: [...bits(8, 'fx-slice', (i, q) => ({ vars: { y: `${Math.round(q() * 92)}%`, hh: `${2 + Math.round(q() * 7)}%`, x: `${Math.round((q() - 0.5) * 70)}px`, d: `${(q() * 0.6).toFixed(2)}s` } })), big('👾', 'rgb')], sound: 'zap', buzz: [10, 20, 10, 20, 10] }),
  mirror: () => ({ kids: [div('fx-pane', div('fx-shine')), big('🪞', 'mir')], sound: 'glass', buzz: [20] }),
  ghost: () => ({ kids: [div('fx-fade'), big('👻', 'swoop')], sound: 'howl', buzz: [40] }),
  storm: () => ({ kids: [div('fx-snow'), div('fx-roll'), big('📺', 'tv')], sound: 'static', buzz: [30, 20, 30] }),
  multiplier: ({ data }) => {
    const pct = Number.isFinite(data && data.pct) ? Math.round(data.pct) : 75;
    const reel = (digits, i) => div(`fx-reel.n${i}`, div('fx-reel-in', ...[...'0123456789', ...'0123456789', digits].map((d) => h('span', d))));
    const s = String(pct).padStart(2, '0');
    return { kids: [div('fx-slot', h('span.fx-plus', '+'), ...[...s].map((d, i) => reel(d, i)), h('span.fx-pc', '%')), ...sparkles(14, 9), div('fx-rays.gold')], sound: 'slots', buzz: [10, 10, 10, 10, 10, 10, 80] };
  },
  duplicator: ({ data, card }) => ({ kids: [div('fx-helix', ...bits(14, 'fx-base', (i) => ({ vars: { i, d: `${(i * 0.06).toFixed(2)}s` } }))), div('fx-split', div('fx-dcard.l', (data && data.card && card && card(data.card)) || null), div('fx-dcard.r', (data && data.card && card && card(data.card)) || null)), div('fx-dna-flash')], sound: 'zap', buzz: [20, 30, 50] }),
  blackout: ({ who }) => ({ kids: who === 'self' ? [div('fx-bo', div('fx-bo-screen', h('span.fx-bo-who', '🕵️'))), word('LIGHTS OUT', 'amber')] : [div('fx-crt')], sound: 'off', buzz: [60] }),
  hacker: () => ({ kids: [div('fx-strobe'), big('🚨', 'siren'), word('ALARM!', 'red')], sound: 'alarm', buzz: [100, 50, 100] }),
  compass: () => ({ kids: [div('fx-dial', div('fx-needle'), h('b.fx-n', 'N'))], sound: 'tick', buzz: [15, 30, 60] }),
  hound: ({ who }) => ({ kids: [div('fx-paws-row', ...bits(9, 'fx-paw', (i) => ({ vars: { i, d: `${(i * 0.13).toFixed(2)}s`, y: `${i % 2 ? 8 : -8}px` } })).map((p) => { p.append(pawEl()); return p; })), big('🐕', 'sniff'), who === 'them' ? word('SNIFFED OUT!', 'red') : word('WOOF!')], sound: who === 'them' ? 'howl' : 'bark', buzz: [40, 60, 40] }),
  quickping: ({ who }) => ({ kids: [div('fx-watch', div('fx-hand')), word(who === 'them' ? 'PING COMING SOONER!' : '-1:00', 'cyan')], sound: 'tick', buzz: [15, 15, 15, 15, 40] }),
  scout: ({ data }) => ({ kids: [div('fx-bino'), h('b.fx-count', String(Number.isFinite(data && data.n) ? data.n : '?')), h('b.fx-count-w', `within ${(data && data.m) || 200} m`)], sound: 'ding', buzz: [20, 40] }),
  rewind: () => ({ kids: [div('fx-vhs'), ...bits(5, 'fx-track', (i, q) => ({ vars: { y: `${Math.round(q() * 90)}%`, d: `${(q() * 0.6).toFixed(2)}s` } })), word('◀◀ REWIND', 'vhs')], sound: 'rewind', buzz: [20, 20, 20] }),
  radar: () => ({ kids: [div('fx-scope', div('fx-sweep'), ...bits(5, 'fx-blip', (i, q) => ({ vars: { x: `${15 + Math.round(q() * 70)}%`, y: `${15 + Math.round(q() * 70)}%`, d: `${(q() * 1.4).toFixed(2)}s` } }), 13))], sound: 'sonar', buzz: [30, 80, 30] }),
  double: () => ({ kids: [...rings(2, 'fx-shock'), word('×2', 'x2')], sound: 'slam', buzz: [80, 40, 80] }),
  useless: () => ({ kids: [word('USELESS', 'stamp-red')], sound: 'slam', buzz: [120] }),
  wiretap: () => ({ kids: [big('🎧', 'phones'), div('fx-eq', ...bits(16, 'fx-eqbar', (i, q) => ({ vars: { i, d: `${(q() * 0.5).toFixed(2)}s`, s: (0.3 + q() * 0.7).toFixed(2) } })))], sound: 'wave', buzz: [20] }),
  snitch: () => ({ kids: [big('🕵️', 'spy'), div('fx-dial-phone', '📞'), div('fx-dots', h('i'), h('i'), h('i')), word('CALLING...', 'cyan')], sound: 'ring', buzz: [40, 40, 40] }),
  freeze: () => ({ kids: [div('fx-frost-edge'), ...bits(14, 'fx-flake', (i, q) => ({ text: '❄', vars: { x: `${Math.round(q() * 100)}%`, d: `${(q() * 1).toFixed(2)}s`, s: (0.6 + q()).toFixed(2) } })), div('fx-cube', '🧊'), word('FROZEN', 'ice')], sound: 'ice', buzz: [30, 30, 90] }),
  tracker: () => ({ kids: [div('fx-reticle', h('i'), h('i')), big('🎯', 'dart')], sound: 'thunk', buzz: [90] }),
  exposure: () => ({ kids: [div('fx-white'), div('fx-shutter'), big('📸', 'cam')], sound: 'flash', buzz: [60] }),
  eye: () => ({ kids: [div('fx-eye', div('fx-lid.top'), div('fx-iris'), div('fx-lid.bot')), ...sparkles(10, 17)], sound: 'wave', buzz: [40, 80, 120] }),
};
export const THEMED = Object.freeze(Object.keys(THEMES));
export const FX_THEME_MS = { self: 2600, team: 2700, them: 2600 };

// `card(key)` (optional) draws a real mini card (cards.js passes its cardEl): Grab bag's reveal, Duplicator's copies, Eavesdrop's hands.
export function cardTheme(fx, doc = globalThis.document, { card = null } = {}) {
  if (!fx || typeof fx.power !== 'string') return null;
  const key = themeKey(fx.power);
  const make = THEMES[key];
  if (!make) return null;
  const who = fx.who === 'self' || fx.who === 'team' || fx.who === 'them' ? fx.who : 'self';
  const side = fx.side === 'hunter' ? 'hunter' : 'hider';
  const t = make({ who, side, data: fx.data || {}, still: still(doc), card: typeof card === 'function' ? (k) => { try { return card(k); } catch { return null; } } : null });
  const el = h(`div.fxt.fxt-${key}.w-${who}.s-${side}${who === 'team' ? '.mini' : ''}${fx.tone === 'safe' ? '.safe' : ''}`, { 'aria-hidden': 'true' }, ...t.kids);
  if (still(doc)) el.classList.add('still');
  return { el, key, sound: who === 'team' ? 'pop' : t.sound, buzz: who === 'team' ? [15] : t.buzz, ms: FX_THEME_MS[who] };
}

// ---- map art ------------------------------------------------------------------------------------------------------

const PLANE_SVG = '<svg viewBox="0 0 120 120" width="100%" height="100%"><defs><linearGradient id="nofx-pb" x1="0" x2="1"><stop offset="0" stop-color="#6d7891"/><stop offset=".45" stop-color="#eef2fb"/><stop offset="1" stop-color="#8994ad"/></linearGradient><linearGradient id="nofx-pw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe5f3"/><stop offset="1" stop-color="#7a86a3"/></linearGradient></defs>'
  + '<path d="M60 8c5 0 7 8 7 18v22l44 20v10l-44-10v24l14 10v8l-21-6-21 6v-8l14-10V78L9 88V78l44-20V26c0-10 2-18 7-18z" fill="url(#nofx-pw)" stroke="#0a0820" stroke-width="3" stroke-linejoin="round"/>'
  + '<path d="M60 10c4 0 6 8 6 18v70c0 6-3 10-6 10s-6-4-6-10V28c0-10 2-18 6-18z" fill="url(#nofx-pb)"/>'
  + '<path d="M56 20q4-6 8 0v8h-8z" fill="#3fa3ff" stroke="#0a0820" stroke-width="1.5"/><circle cx="34" cy="66" r="4" fill="#ff4f5e"/><circle cx="86" cy="66" r="4" fill="#7ef0c0"/></svg>';
export function planeEl(doc = globalThis.document) {
  const el = h('div.fx-plane', { 'aria-hidden': 'true' }, h('i.fx-trail'), h('i.fx-trail.two'), div('fx-plane-shadow'), div('fx-plane-body'));
  // (a fixed drawing of our own, no player's words: safe as markup)
  el.querySelector('.fx-plane-body').innerHTML = PLANE_SVG;
  el.querySelector('.fx-plane-shadow').innerHTML = PLANE_SVG;
  return el;
}
export function crateChuteEl() {
  return h('div.fx-chute', { 'aria-hidden': 'true' }, div('fx-canopy'), div('fx-lines'), div('fx-crate', h('b', '?')));
}
export function pawEl() { return h('i.fx-pawprint', { 'aria-hidden': 'true' }, h('b'), h('b'), h('b'), h('b'), h('span')); }
export function dustEl() { return div('fx-dustring', h('i'), h('i')); }

// Paw prints along screen points: one every `spacing` px, turned along the way, left and right, newest darkest.
export function pawTrail(layer, points, { ms = 1600, spacing = 26, doc = globalThis.document } = {}) {
  const el = h('div.fx-pawtrail', { 'aria-hidden': 'true' });
  const pts = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const steps = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    for (let d = steps.length ? spacing - ((steps.carry || 0)) : 0; d < len; d += spacing) {
      steps.push({ x: x0 + Math.cos(ang) * d, y: y0 + Math.sin(ang) * d, a: ang });
    }
    steps.carry = len % spacing;
  }
  const n = steps.length;
  steps.slice(-160).forEach((s, i, all) => {
    const side = i % 2 ? 1 : -1;
    const ox = Math.cos(s.a + Math.PI / 2) * 6 * side;
    const oy = Math.sin(s.a + Math.PI / 2) * 6 * side;
    const p = pawEl(doc);
    p.style.transform = `translate(${(s.x + ox).toFixed(1)}px, ${(s.y + oy).toFixed(1)}px) rotate(${((s.a * 180) / Math.PI + 90).toFixed(1)}deg)`;
    p.style.setProperty('--o', (0.35 + 0.65 * ((i + 1) / all.length)).toFixed(2));
    p.style.setProperty('--d', `${Math.round((ms * i) / Math.max(1, all.length))}ms`);
    el.append(p);
  });
  el.dataset.paws = String(Math.min(n, 160));
  if (still(doc)) el.classList.add('still');
  layer.append(el);
  return { el, remove: () => el.remove() };
}

// The drop plane flying a screen path, crates falling under parachutes at the drops.
// It removes itself (path, plane, crates, dust) FLIGHT_LINGER ms after the last crate lands, unless keep: true.
export const FLIGHT_LINGER = 1500;
export function flyPlane(layer, { path = [[-60, 200], [460, 120]], ms = 7000, drops = [], fall = 1800, doc = globalThis.document, onLand = null, sound = soundOn, keep = false } = {}) {
  const el = h('div.fx-flight', { 'aria-hidden': 'true' });
  const [[x0, y0], [x1, y1]] = path;
  const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  const line = div('fx-flightpath');
  const len = Math.hypot(x1 - x0, y1 - y0);
  line.style.cssText = `width:${len.toFixed(0)}px;transform:translate(${x0}px,${y0}px) rotate(${ang.toFixed(1)}deg)`;
  const plane = planeEl(doc);
  plane.style.setProperty('--x0', `${x0}px`); plane.style.setProperty('--y0', `${y0}px`);
  plane.style.setProperty('--x1', `${x1}px`); plane.style.setProperty('--y1', `${y1}px`);
  plane.style.setProperty('--a', `${(ang + 90).toFixed(1)}deg`);
  plane.style.setProperty('--ms', `${ms}ms`);
  el.append(line, plane);
  const timers = [];
  const calm = still(doc);
  drops.forEach(([x, y], i) => {
    // (when the plane passes nearest the spot... roughly: the crates leave in turn through the middle of the flight)
    const at = Math.round(ms * (0.35 + (0.3 * i) / Math.max(1, drops.length)));
    const c = crateChuteEl(doc);
    c.style.setProperty('--x', `${x}px`); c.style.setProperty('--y', `${y}px`);
    c.style.setProperty('--fall', `${fall}ms`); c.style.setProperty('--d', `${at}ms`);
    el.append(c);
    timers.push(setTimeout(() => {
      const d = dustEl(doc);
      d.style.setProperty('--x', `${x}px`); d.style.setProperty('--y', `${y}px`);
      el.append(d);
      timers.push(setTimeout(() => d.remove(), 1200));
      fxSound('thud', doc, sound);
      if (onLand) try { onLand(i); } catch { /* fine */ }
    }, calm ? 0 : at + fall));
  });
  if (calm) el.classList.add('still');
  layer.append(el);
  fxSound('engine', doc, sound);
  const end = calm ? 0 : Math.max(ms, Math.round(ms * 0.65) + fall);
  if (!keep) timers.push(setTimeout(() => { for (const t of timers) clearTimeout(t); el.remove(); }, end + FLIGHT_LINGER));
  return { el, remove() { for (const t of timers) clearTimeout(t); el.remove(); } };
}

// A frost layer over any element (it gets position relative if it was static); crack() shatters it off.
export function frost(target, { doc = globalThis.document } = {}) {
  if (!target) return { crack() {}, remove() {} };
  const W = doc.defaultView || globalThis;
  try { if (W.getComputedStyle(target).position === 'static') target.style.position = 'relative'; } catch { /* fine */ }
  const el = div('fx-frostcover', div('fx-frost-cr'), ...bits(6, 'fx-frost-shard', (i) => ({ vars: { a: `${i * 60 + 15}deg` } })));
  el.setAttribute('aria-hidden', 'true');
  target.append(el);
  return {
    el,
    crack() { el.classList.add('cracking'); fxSound('shatter', doc); setTimeout(() => el.remove(), still(doc) ? 0 : 700); },
    remove() { el.remove(); },
  };
}

// ---- the game's moments --------------------------------------------------------------------------------------------

const clock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}`; };
export const MOMENTS = ['drop-incoming', 'crate-land', 'pinged', 'ping-in', 'ring-soon', 'ring-shrinking', 'headsup', 'call-ring', 'snitched', 'deal', 'mirror', 'bounced', 'box-grab'];
const SMALL = new Set(['headsup', 'crate-land', 'box-grab', 'ping-in']);

const MOMENT = {
  // (`until` = Date.now() + ms when the drop was announced: a countdown that waited in the queue still ends on time)
  'drop-incoming': ({ ms = 10000, until = null }) => {
    const n = h('b.fx-cd', clock(ms));
    const end = Number.isFinite(until) ? until : Date.now() + ms;
    let iv = null;
    return {
      el: div('fx-m.fx-drop', div('fx-drop-bar', h('span.fx-drop-ico', '✈️'), h('b.fx-drop-w', 'DROP INCOMING'), n), div('fx-drop-scan')),
      ms: Math.min(ms, 11000), urgent: true, sound: 'engine', buzz: [30, 60, 30], said: 'Drop incoming',
      start() {
        this.ms = Math.max(600, Math.min(11000, end - Date.now()));
        const tick = () => { const left = end - Date.now(); text(n, clock(left)); if (left <= 0) clearInterval(iv); };
        tick(); iv = setInterval(tick, 250);
      },
      stop: () => clearInterval(iv),
    };
  },
  'crate-land': ({ x, y }) => {
    const d = dustEl();
    const box = div('fx-m.fx-land', d, div('fx-land-crate', '📦'), ...bits(8, 'fx-land-puff', (i) => ({ vars: { a: `${i * 45}deg` } })));
    // (the crate, its dust and puffs all land on the spot: x, y in this layer's px)
    if (Number.isFinite(x) && Number.isFinite(y)) { box.style.setProperty('--x', `${x}px`); box.style.setProperty('--y', `${y}px`); } else d.classList.add('mid');
    return { el: box, ms: 1400, sound: 'thud', buzz: [40] };
  },
  pinged: ({ x, y }) => {
    const box = div('fx-m.fx-pinged', ...rings(4, 'fx-ping-ring'), word('PINGED'));
    if (Number.isFinite(x)) { box.style.setProperty('--x', `${x}px`); box.style.setProperty('--y', `${y}px`); }
    return { el: box, ms: 2000, sound: 'sonar', buzz: [60, 40, 60], said: 'You were pinged' };
  },
  'ping-in': ({ points = [] }) => {
    const pts = points.length ? points : [[null, null]];
    const box = div('fx-m.fx-pingin', word('PING!', 'cyan'), ...pts.slice(0, 12).map(([x, y]) => {
      const p = div('fx-ripple', h('i'), h('i'));
      if (Number.isFinite(x)) { p.style.setProperty('--x', `${x}px`); p.style.setProperty('--y', `${y}px`); } else p.classList.add('mid');
      return p;
    }));
    return { el: box, ms: 1500, sound: 'sonar', buzz: [20], said: 'Ping' };
  },
  'ring-soon': ({ ms = 60000 }) => ({ el: div('fx-m.fx-ringsoon', div('fx-edge-amber'), word(`RING CLOSES IN ${clock(ms)}`, 'amber')), ms: 2600, sound: 'alarm', buzz: [60, 60, 60], said: `The ring closes in ${clock(ms)}` }),
  'ring-shrinking': () => ({ el: div('fx-m.fx-ringshrink', div('fx-closein'), div('fx-closein.two'), word('RING CLOSING!', 'red')), ms: 3000, sound: 'alarm', buzz: [100, 50, 100], said: 'The ring is closing in' }),
  headsup: ({ d, dir }) => {
    const box = div('fx-m.fx-hu', div('fx-edge-red'), div('fx-hu-chip', h('span', '🔔'), h('b', 'HUNTER NEAR!'), Number.isFinite(d) ? h('i', `${Math.round(d)} m`) : null));
    if (Number.isFinite(dir)) { box.classList.add('dir'); box.style.setProperty('--dir', `${dir}deg`); box.append(div('fx-hu-glow')); }
    return { el: box, ms: 2200, sound: 'bell', buzz: [80, 60, 80], said: 'A hunter is near' };
  },
  'call-ring': ({ name = 'Hunters' }) => ({ el: div('fx-m.fx-callring', div('fx-callring-in', h('span.fx-callico', '📞'), h('b', 'INCOMING CALL'), h('i', String(name)))), ms: 1800, sound: 'ring', buzz: [200, 100, 200, 100, 200], said: 'Incoming call from the hunters' }),
  snitched: () => ({ el: div('fx-m.fx-snitched', div('fx-spot'), div('fx-hitflash'), word('SOMEONE SNITCHED ON YOU 👀', 'red')), ms: 2800, sound: 'hit', buzz: [150, 60, 150], said: 'Someone snitched on you' }),
  deal: () => ({ el: div('fx-m.fx-deal', ...sparkles(12, 21), big('🤝', 'shake'), word('A HIDER TOOK THE DEAL!', 'gold')), ms: 2600, sound: 'deal', buzz: [40, 40, 120], said: 'A hider took the deal' }),
  mirror: ({ what = 'reflect' }) => {
    if (what === 'blocked') return { el: div('fx-m.fx-mblock', div('fx-shield'), div('fx-cracks'), word('BLOCKED!', 'glass')), ms: 2200, sound: 'shatter', buzz: [30, 30, 80], said: 'Blocked by your Mirror' };
    if (what === 'bounce') return { el: div('fx-m.fx-mbounce', div('fx-pane'), div('fx-ricochet', '🃏'), word('BOUNCED OFF!', 'glass')), ms: 2200, sound: 'glass', buzz: [30, 80], said: 'It bounced off your Mirror' };
    return { el: div('fx-m.fx-mreflect', div('fx-flipglass'), word('MIRRORED!', 'glass')), ms: 2200, sound: 'glass', buzz: [20, 40], said: 'Mirror: you can see them too' };
  },
  bounced: () => ({ el: div('fx-m.fx-bounced', div('fx-strobe'), div('fx-ricochet', '🚨'), word('BOUNCED!', 'red')), ms: 2200, sound: 'alarm', buzz: [100, 50, 100], said: 'Your Hacker bounced back' }),
  'box-grab': () => ({ el: div('fx-m.fx-grab', div('fx-rays.gold'), ...sparkles(12, 5), big('📦', 'pop')), ms: 1400, sound: 'pop', buzz: [30, 30] }),
};

export function createGameFx({ root, doc = globalThis.document, sound = soundOn } = {}) {
  const layer = h('div.gfx', { 'aria-hidden': 'true' });
  const live = h('p.sr-only.gfx-said', { role: 'status' });
  (root || doc.body).append(layer, live);
  const Q = [];
  let cur = null;
  let dead = false;
  function show(m, done) {
    const calm = still(doc);
    if (m.start) m.start();
    if (calm) m.el.classList.add('still');
    layer.append(m.el);
    if (m.said) text(live, m.said);
    fxSound(m.sound, doc, sound);
    if (m.buzz) buzz(m.buzz);
    const t = setTimeout(() => { if (m.stop) m.stop(); m.el.remove(); done(); }, calm ? Math.min(m.ms, 1800) : m.ms);
    return { t, m };
  }
  function next() {
    const job = Q.shift();
    if (!job || dead) { cur = null; return; }
    cur = show(job, next);
  }
  function play(name, opts = {}) {
    if (dead || !MOMENT[name] || (doc.visibilityState && doc.visibilityState === 'hidden')) return false;
    // (the queue is checked before anything is built: a refused moment starts nothing)
    if (!SMALL.has(name) && Q.length >= 3 && name !== 'drop-incoming') return false;
    const m = MOMENT[name](opts || {});
    m.name = name;
    if (SMALL.has(name)) { show(m, () => {}); return true; }
    // the drop countdown is tied to the plane: it goes first in the queue
    if (m.urgent) Q.unshift(m); else Q.push(m);
    if (Q.length > 3) { const gone = Q.pop(); if (gone.stop) gone.stop(); }
    // ...and cuts short whatever big moment is showing, so it's on screen while the plane flies
    if (m.urgent && cur) { clearTimeout(cur.t); if (cur.m.stop) cur.m.stop(); cur.m.el.remove(); cur = null; }
    if (!cur) next();
    return true;
  }
  return {
    play,
    el: layer, // (v1.7 WIRING: screen points for a moment are given in this layer's own px)
    busy: () => !!cur,
    destroy() { dead = true; if (cur) { clearTimeout(cur.t); if (cur.m.stop) cur.m.stop(); } for (const m of Q) if (m.stop) m.stop(); Q.length = 0; layer.remove(); live.remove(); },
  };
}

// ---- the Snitch call screen (a real screen: it takes taps) -----------------------------------------------------

// At 0:00 the call ends by itself ("Time up."): the ringer stops and onTimeout runs (else onHangup), once.
// The ringer never rings or buzzes while the page is hidden, or while the screen itself isn't showing (the SOS
// screen hides it: the game is paused, so the call doesn't run out either). Once 'ended' the countdown stops.
// `state` (v1.7 WIRING): the state to open in ('talk' for a callee who answered before the page was reloaded).
export function createCallScreen({ root, doc = globalThis.document, name = 'Hunters', offer = '', mates = [], ms = 45000, caller = false, sound = soundOn, onAccept = null, onHangup = null, onTalk = null, onSnitch = null, onTimeout = null, state: first = null } = {}) {
  const timer = h('b.call-time', clock(ms));
  const words = h('p.call-words');
  const status = h('p.call-status', caller ? 'Calling...' : 'Incoming call');
  const accept = h('button.call-btn.accept', { type: 'button', 'aria-label': 'Answer' }, h('span', '📞'), h('i', 'Answer'));
  const hang = h('button.call-btn.hang', { type: 'button', 'aria-label': 'Hang up' }, h('span', '📞'), h('i', 'Hang up'));
  const talk = h('button.call-btn.talk', { type: 'button', 'aria-label': 'Hold to talk' }, h('span', '🎙️'), h('i', 'Hold to talk'));
  const snitch = h('button.call-btn.snitch', { type: 'button' }, h('span', '🐀'), h('i', 'Snitch'));
  const pickList = h('div.call-pick', { role: 'group', 'aria-label': 'Who to give up' });
  const el = h('div.call', { role: 'dialog', 'aria-modal': 'false', 'aria-label': `Call from ${name}`, 'data-state': 'ringing' },
    div('call-bg', ...rings(3, 'call-wave')),
    div('call-top', h('div.call-av', '🕵️'), h('strong.call-name', String(name)), status, timer),
    h('p.call-offer', offer ? `The deal: ${offer}` : ''), words, pickList,
    div('call-btns', accept, talk, snitch, hang));
  let left = ms;
  let ringer = null;
  let over = false;
  const timeUp = () => {
    if (over) return;
    over = true; clearInterval(iv);
    if (el.dataset.state !== 'ended') { set('ended', 'Time up.'); const f = onTimeout || onHangup; if (f) try { f(); } catch { /* fine */ } }
  };
  const iv = setInterval(() => { left -= 1000; text(timer, clock(left)); if (left <= 0) timeUp(); }, 1000);
  const shown = () => {
    if (!el.isConnected || (el.closest && el.closest('.g-sos-on'))) return false;
    try { return el.getClientRects().length > 0; } catch { return true; }
  };
  const ringOnce = () => { if (doc.visibilityState === 'hidden' || !shown()) return; fxSound('ring', doc, sound); buzz([300, 150, 300]); };
  function set(state, say = '') {
    el.dataset.state = state;
    clearInterval(ringer); ringer = null;
    if (state === 'ended') { over = true; clearInterval(iv); }
    if (state === 'ringing' && !caller) { ringOnce(); ringer = setInterval(ringOnce, 1600); }
    text(status, state === 'ringing' ? (caller ? 'Calling...' : 'Incoming call') : state === 'talk' ? 'On a call' : state === 'pick' ? 'Who do you give up?' : 'Call ended');
    text(words, say);
    accept.hidden = state !== 'ringing' || caller;
    talk.hidden = state !== 'talk';
    snitch.hidden = state !== 'talk' || caller || !mates.length;
    hang.hidden = state === 'ended';
    pickList.replaceChildren(...(state === 'pick' ? mates.map((m) => {
      const b = h('button.call-mate', { type: 'button' }, String(m.name || m.id));
      b.addEventListener('click', () => { if (onSnitch) onSnitch(m.id); });
      return b;
    }) : []));
  }
  accept.addEventListener('click', () => { if (onAccept) onAccept(); set('talk'); });
  hang.addEventListener('click', () => { if (onHangup) onHangup(); set('ended', 'No deal.'); });
  snitch.addEventListener('click', () => set('pick'));
  const tk = (on) => (e) => { if (e && e.cancelable) e.preventDefault(); talk.classList.toggle('on', on); if (onTalk) onTalk(on); };
  talk.addEventListener('pointerdown', tk(true));
  talk.addEventListener('pointerup', tk(false));
  talk.addEventListener('pointercancel', tk(false));
  talk.addEventListener('contextmenu', (e) => e.preventDefault());
  if (still(doc)) el.classList.add('still');
  (root || doc.body).append(el);
  set(first === 'talk' || first === 'ringing' ? first : caller ? 'talk' : 'ringing');
  return {
    el,
    set,
    left(n) { if (over) return; left = n; text(timer, clock(n)); if (n <= 0) timeUp(); },
    close() { over = true; clearInterval(iv); clearInterval(ringer); el.classList.add('out'); setTimeout(() => el.remove(), still(doc) ? 0 : 260); },
  };
}
