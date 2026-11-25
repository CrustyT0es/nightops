// Night Ops v1.6.4: the explainer after the mode vote, played by js/screens/voteshow.js on every phone from the
// server's clock (the explain stage's length is shared/vote.js EXPLAIN_FOR). Static walks through how the winning
// mode plays, one animated scene after another, his words in his speech bubble (audio/narrator/x_*.mp3):
//   classic      the pings and the ring on a little map, the chase and the tag, who wins, then the powers as cards
//   checkpoints  a checkpoint opens, hiders see it first, a photo counts only inside, the safe time runs out, then the
//                next one opens and most checkpoints wins
//   loot         (v1.7) all 36 cards, a tier at a time (common, rare, epic, legendary, mythic: both sides' cards in
//                one scene, blue hiders on top, red hunters under), each flipped big with its few words as Static
//                names it; then the drop plane flies over and a crate lands with its 10 m circle, a hider walks in,
//                the chest opens, Blackout is played and the hunters' screens go dark; and a box can be a trap
//
//   EXPLAINERS[mode]               the beats [{ at, scene, line, mood, host }] (at: ms into the explain stage)
//   explainBeat(mode, ms)          the beat playing at ms (null before the first one)
//   explainScene(scene, mode, ctx) the scene; its [data-at] parts appear at their time. ctx: { names, faceAt(i, size) }
//   syncScene(root, ms)            .on on each [data-at] part whose time has come, .now while ms is in
//                                  [data-at, data-until), the ph-<name> classes of [data-phases] roots, the counts
// Its styles are css/vote.css (.vx-*). Everything moves by transform and opacity; less motion = each move's end.
import { h } from '../dom.js?v=182';
import { cardEl, cardInfo } from '../cards.js?v=182';
import { chest } from '../chest.js?v=182';
import { POWERS } from '../../shared/rules.js?v=182';
import { LOOT_TABLE, ALL_CARDS } from '../../shared/loot.js?v=182';
import { planeEl } from '../fx.js?v=182';

// How long each of Static's lines is (ms, the mp3 rounded up; tests/vote-explain.test.mjs reads the files).
export const LINE_MS = {
  e_mode_classic: 5570, e_mode_checkpoints: 4500, e_mode_loot: 6950,
  x_classic_1: 8600, x_classic_2: 8870, x_classic_3: 8970,
  x_cp_1: 4790, x_cp_2: 4450, x_cp_3: 5470, x_cp_4: 3720,
  x_loot_4: 4420, x_loot_5: 5210,
  x_cards_intro: 3790, x_tier_common: 10300, x_tier_rare: 7080, x_tier_epic: 5490, x_tier_legendary: 5120,
  x_card_blackout: 4560, x_card_eye: 4220, x_plane: 5360,
};
// What Static says in them (the captions match the words).
export const X_LINES = {
  x_classic_1: 'Every few minutes, hiders get pinged. Hunters see a circle around where you are... and the ring can close in. Keep moving!',
  x_classic_2: "Hunters: spot them, chase them, tag them for real. Catch everyone, and the hunters win. Anyone still free when time's up? Hiders win!",
  x_classic_3: 'And you get powers! Hunters get Radar, Exposure, and Hacker. Hiders get Decoy, Jammer, and Sprint. Save them for the perfect moment.',
  x_cp_1: 'A checkpoint opens on the map. Hiders see it first... so get a head start!',
  x_cp_2: "Run inside the circle and snap a photo. It only counts while you're in there.",
  x_cp_3: "Inside, you're safe for a few minutes. Stay too long, and the hunters see exactly where you are!",
  x_cp_4: 'Then the next checkpoint opens. Most checkpoints at the end wins!',
  x_cards_intro: 'Thirty-six cards! Blue ones for hiders, red ones for hunters.',
  x_tier_common: 'Commons first. Sprint, Smoke, Lucky, Heads up, Stall, Eavesdrop, and a Grab bag for hiders. Hacker, Compass, Hound dog, Quick ping, Scout, Rewind, and a Grab bag for hunters.',
  x_tier_rare: 'Rare cards! Decoy, Jammer, Swap, and Lookout for hiders. Radar, Double Double, Useless, and Wiretap for hunters.',
  x_tier_epic: 'Now... EPIC! Glitch, Mirror, and Ghost for hiders. Snitch, Freeze, and Tracker dart for hunters.',
  x_tier_legendary: 'Legendary! Static Storm, Exposure, and both sides get a Multiplier and a Duplicator.',
  x_card_blackout: "And the mythic one... Blackout! The hunters' screens go black for five minutes!",
  x_card_eye: 'And the mythic one... the All-Seeing Eye! Every hider, live. Nothing blocks it.',
  x_plane: 'Every few minutes, a plane flies over and drops crates. Get within ten meters of one to grab it!',
  x_loot_4: "Crack it open... Blackout! Play it, and every hunter's screen goes dark.",
  x_loot_5: 'Hunters grab boxes too, and everyone sees them on the map. So a box... might be a trap!',
};

export const SLAM_AT = 2000;   // the drum roll (voteshow DRUM_MS), then the winner slams in
const GAP = 300;               // between two lines in one scene
const NEW_SCENE = 450;         // before a new scene (the colour wipe covers the change)
export const HOLD_MS = 1400;   // the last scene stays up this long after the last line

// The beats, laid out from the lines' lengths: [scene, line, { host, mood }] -> [{ at, scene, line, host, mood }].
function lay(items) {
  const out = [];
  let at = SLAM_AT;
  for (const [scene, line, more = {}] of items) {
    if (out.length) {
      const prev = out[out.length - 1];
      at = prev.at + LINE_MS[prev.line] + (prev.scene === scene ? GAP : NEW_SCENE) + (prev.pad || 0);
    }
    out.push({ at, scene, line, host: 'side', mood: '', ...more });
  }
  return out;
}
// v1.7: the tiers. Each tier is one scene: Static's line (two for the mythics) and, for each card, when he says its
// name (ms into that line, from ElevenLabs' character times when the line was made). Every one of the 36 cards is in
// exactly one tier, its LOOT_TABLE tier (tests check).
export const TIERS = [
  { r: 'common', lines: ['x_cards_intro', 'x_tier_common'], cards: [
    ['x_tier_common', [['sprint', 1030], ['smoke', 1490], ['lucky', 1890], ['headsup', 2250], ['stall', 2650], ['eavesdrop', 2960], ['grabbag_hider', 4020],
      ['hacker', 5460], ['compass', 5860], ['hound', 6290], ['quickping', 6910], ['scout', 7510], ['rewind', 7900], ['grabbag_hunter', 8650]]]] },
  { r: 'rare', lines: ['x_tier_rare'], cards: [
    ['x_tier_rare', [['decoy', 1060], ['jammer', 1650], ['swap', 2030], ['lookout', 2510], ['radar', 3860], ['double', 4390], ['useless', 4980], ['wiretap', 5570]]]] },
  { r: 'epic', lines: ['x_tier_epic'], cards: [
    ['x_tier_epic', [['glitch', 1080], ['mirror', 1440], ['ghost', 1920], ['snitch', 2970], ['freeze', 3400], ['tracker', 3970]]]] },
  { r: 'legendary', lines: ['x_tier_legendary'], cards: [
    ['x_tier_legendary', [['storm', 860], ['exposure', 1700], ['multiplier_hider', 3260], ['multiplier_hunter', 3700], ['duplicator_hider', 4130], ['duplicator_hunter', 4560]]]] },
  { r: 'mythic', lines: ['x_card_blackout', 'x_card_eye'], cards: [['x_card_blackout', [['blackout', 1900]]], ['x_card_eye', [['eye', 1900]]]] },
];
// Each card's few words, short enough to read while it's up (the card itself carries its full line).
export const SHORT = {
  sprint: 'Pings stay where you started', smoke: 'Next ping: a smoke cloud', lucky: 'Next box gives 2 cards',
  headsup: 'Buzzes when a hunter is near', stall: 'Your next ping comes late', eavesdrop: "See the hunters' cards",
  grabbag_hider: 'A random common card', decoy: 'Next ping pops up elsewhere', jammer: 'Skip the next ping',
  swap: 'Trade a card with a teammate', lookout: 'See every hunter for 15 s', glitch: "Hunters' phones go buggy",
  mirror: 'If they see you, you see them', ghost: 'Vanish from 2 pings', storm: 'Their map turns to TV static',
  multiplier_hider: 'Boost a card up to 100%', duplicator_hider: 'Copy one of your cards', blackout: "Hunters' screens go black",
  hacker: "Set off a hider's alarm", compass: 'An arrow to the nearest hider', hound: "Hiders' trails as paw prints",
  quickping: 'Next ping comes sooner', scout: 'How many hiders are close?', rewind: 'See the ping before last',
  grabbag_hunter: 'A random common card', radar: 'Every hider live for 1 min', double: 'Pings come twice as fast',
  useless: "One hider's cards stop working", wiretap: 'Listen in on a hider (with OK)', snitch: 'Call a hider, offer a deal',
  freeze: "Hiders' powers freeze", tracker: 'Follow one hider for 2 min', exposure: 'Exact spots, no warning',
  multiplier_hunter: 'Boost a card up to 100%', duplicator_hunter: 'Copy one of your cards', eye: 'Every hider live. Nothing blocks it.',
};
export const CARD_MIN_MS = 700; // a card stays up at least this long, so its few words can be read
// x_cards_intro: "Blue ones for hiders" and "red ones for hunters" (ms into the line, from its pauses)
export const INTRO_ROWS = { hider: [1400, 2450], hunter: [2450, 3700] };
// Both sides' cards, in the order they're dealt
export const DECK = { hider: [], hunter: [] };
for (const t of TIERS) for (const [, list] of t.cards) for (const [k] of list) DECK[LOOT_TABLE.hider[t.r].includes(k) ? 'hider' : 'hunter'].push(k);
export const TIER_PAD = 900; // after a tier's last line: its last card's words can be read, then the tier sits face up
const tierBeats = () => TIERS.flatMap((t) => t.lines.map((line, i) => [`tier-${t.r}`, line,
  { host: 'mini', mood: t.r === 'mythic' || t.r === 'epic' ? 'wow' : t.r === 'legendary' ? 'happy' : '', ...(i === t.lines.length - 1 ? { pad: TIER_PAD } : {}) }]));

export const EXPLAINERS = {
  classic: lay([
    ['slam', 'e_mode_classic', { mood: 'happy' }],
    ['hunt', 'x_classic_1', { host: 'mini' }],
    ['hunt', 'x_classic_2', { host: 'mini', mood: 'wow' }],
    ['cpowers', 'x_classic_3', { host: 'mini', mood: 'happy' }],
  ]),
  checkpoints: lay([
    ['slam', 'e_mode_checkpoints', { mood: 'happy' }],
    ['race', 'x_cp_1', { host: 'mini' }],
    ['race', 'x_cp_2', { host: 'mini', mood: 'happy' }],
    ['race', 'x_cp_3', { host: 'mini', mood: 'wow' }],
    ['cpwin', 'x_cp_4', { host: 'mini', mood: 'happy' }],
  ]),
  loot: lay([
    ['slam', 'e_mode_loot', { mood: 'happy' }],
    ...tierBeats(),
    ['demo', 'x_plane', { host: 'mini', mood: 'wow' }],
    ['demo', 'x_loot_4', { host: 'mini', mood: 'wow' }],
    ['demo', 'x_loot_5', { host: 'mini', mood: 'wink' }],
  ]),
};
// When the last line ends (+ HOLD_MS): what EXPLAIN_FOR must be at least (tests check they agree).
export function explainerEnd(mode) {
  const b = EXPLAINERS[mode];
  const last = b[b.length - 1];
  return last.at + LINE_MS[last.line] + HOLD_MS;
}

export function explainBeat(mode, ms) {
  const beats = EXPLAINERS[mode];
  if (!beats) return null;
  let b = null;
  for (const x of beats) if (ms >= x.at) b = x;
  return b;
}

// The [data-at] parts, the [data-phases] roots and the collection counts follow the clock.
export function syncScene(root, ms) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-at]')) {
    const at = Number(el.dataset.at);
    const until = el.dataset.until === undefined ? Infinity : Number(el.dataset.until);
    el.classList.toggle('on', ms >= at);
    el.classList.toggle('now', ms >= at && ms < until);
    el.classList.toggle('past', ms >= until);
  }
  for (const el of root.querySelectorAll('[data-phases]')) {
    let list = [];
    try { list = JSON.parse(el.dataset.phases); } catch { /* none */ }
    for (const [name, at] of list) el.classList.toggle(`ph-${name}`, ms >= at);
  }
  for (const el of root.querySelectorAll('[data-count]')) {
    const scope = el.closest('.vx-deck') || root;
    const n = scope.querySelectorAll('.vx-slot.on').length;
    const of = scope.querySelectorAll('.vx-slot').length;
    const t = `${n}/${of}`;
    if (el.textContent !== t) el.textContent = t;
  }
}

// ---- small parts ---------------------------------------------------------------------------------------------
const lineAt = (mode, line) => {
  const b = (EXPLAINERS[mode] || []).find((x) => x.line === line);
  return b ? b.at : 0;
};
const phases = (list) => ({ 'data-phases': JSON.stringify(list.map(([n, at]) => [n, Math.round(at)])) });
const at = (ms, until) => ({ 'data-at': String(Math.round(ms)), ...(until !== undefined ? { 'data-until': String(Math.round(until)) } : {}) });
// A spot on a little map (100 x 82 units; positions in units, so the map scales with the phone).
// (--x0/--y0 inline: where it starts; a phase's CSS moves it with --x/--y)
const spot = (cls, x, y, attrs = {}, ...kids) => h(`div.vx-at.${cls}`, { ...attrs, style: { '--x0': x, '--y0': y, ...(attrs.style || {}) } }, ...kids);
const dot = (team, cls, x, y, ...kids) => spot(`vx-dot.t-${team}.${cls}`, x, y, {}, ...kids);
function miniMap(cls, attrs, ...kids) {
  return h(`div.vx-map${cls ? `.${cls}` : ''}`, { 'aria-hidden': 'true', ...attrs },
    h('div.vx-map-in', h('i.vx-streets'), h('i.vx-park'), h('i.vx-block.b1'), h('i.vx-block.b2'), h('i.vx-block.b3'), ...kids));
}
const kicker = (cls, words) => h(`p.vs-kicker.vx-kick.${cls}`, words);
const KEY = { hider: 'Hiders', hunter: 'Hunters', ping: 'A ping', ring: 'The ring', cp: 'Checkpoint', box: 'Grab zone' };
const legend = (...kinds) => h('ul.vx-legend', { 'aria-hidden': 'true' }, ...kinds.map((k) => h('li', h(`i.t-${k}`), KEY[k])));
const names3 = (ctx) => {
  const fill = ['Ava', 'Sam', 'Mia', 'Leo'];
  const got = ((ctx && ctx.names) || []).filter(Boolean).slice(0, 4);
  for (const n of fill) if (got.length < 4 && !got.includes(n)) got.push(n);
  return got;
};
const token = (ctx, name, i) => {
  const f = ctx && ctx.faceAt ? ctx.faceAt(i, 30) : null;
  return h('span.vx-token', f || h('span.vx-initial', String(name || '?').slice(0, 1).toUpperCase()), h('b', name), h('i.vx-x', '✕'));
};

// ---- Classic: the hunt ----------------------------------------------------------------------------------------
function hunt(mode, ctx) {
  const A = lineAt(mode, 'x_classic_1');
  const B = lineAt(mode, 'x_classic_2');
  const ppl = names3(ctx);
  return h('div.vx-scene.vx-hunt', phases([['ping', A + 1500], ['see', A + 2700], ['ring', A + 5800], ['move', A + 7500],
    ['chase', B], ['tag', B + 1600], ['catch', B + 2800], ['hwin', B + 3900], ['time', B + 5400], ['swin', B + 7600]]),
  kicker('hider', 'How it plays'),
  h('div.vx-stagebox',
    miniMap('', {},
      spot('vx-ring', 50, 41, {}, h('i.vx-ring-c')),
      spot('vx-ping.p1', 27, 52, {}, h('i'), h('b', 'PING')),
      spot('vx-ping.p2', 73, 30, {}, h('i'), h('b', 'PING')),
      spot('vx-ping.p3', 50, 64, {}, h('i'), h('b', 'PING')),
      dot('hider', 'd1', 24, 55), dot('hider', 'd2', 70, 28), dot('hider', 'd3', 53, 62),
      dot('hunter', 'k1', 14, 16), dot('hunter', 'k2', 86, 70),
      spot('vx-burst.tagb', 66, 22, {}, h('b', 'TAG!')),
      h('div.vx-hud', h('span.vx-timer', h('i')), h('b.vx-hud-w', 'NEXT PING'), h('b.vx-hud-p', 'PING!'))),
    h('div.vx-confirm', h('small', 'Did they tag you?'), h('b', 'YES')),
    h('div.vx-panel.win-h', h('div.vx-tokens', ...ppl.slice(0, 3).map((n, i) => token(ctx, n, i))), h('p.vx-banner.t-hunter', 'HUNTERS WIN')),
    h('div.vx-panel.win-s', h('p.vx-clock0', "0:00 · TIME'S UP"), h('div.vx-tokens', ...ppl.slice(0, 3).map((n, i) => token(ctx, n, i))), h('p.vx-banner.t-hider', 'HIDERS WIN'))),
  legend('hider', 'hunter', 'ping', 'ring'));
}

// ---- Classic: the powers, popping in as cards when Static says each ------------------------------------------
const CLASSIC_POWERS = { hunter: [['radar', 1900], ['exposure', 2460], ['hacker', 3290]], hider: [['decoy', 4890], ['jammer', 5570], ['sprint', 6320]] };
function classicPowers(mode) {
  const C = lineAt(mode, 'x_classic_3');
  const row = (side, label, labelAt) => h(`div.vx-prow.t-${side}`,
    h('p.vx-plabel', at(C + labelAt), label),
    h('div.vx-pcards', ...CLASSIC_POWERS[side].map(([k, ms], i) => h('div.vx-ptile', { ...at(C + ms), style: { '--i': i } },
      cardEl(k, { back: true }), h('p.vx-pline', POWERS[k].idle)))));
  return h('div.vx-scene.vx-cpowers', phases([['save', C + 7100]]),
    kicker('warn', 'Powers'),
    row('hunter', 'HUNTERS', 1200),
    row('hider', 'HIDERS', 4240));
}

// ---- Checkpoints: the race ------------------------------------------------------------------------------------
function race(mode) {
  const A = lineAt(mode, 'x_cp_1');
  const B = lineAt(mode, 'x_cp_2');
  const C = lineAt(mode, 'x_cp_3');
  const flag = (cls, x, y, name, i) => spot(`vx-cp.${cls}`, x, y, { style: { '--i': i } }, h('i.vx-cp-zone'), h('span.vx-cp-pin', '🚩'), h('b.vx-cp-name', name));
  return h('div.vx-scene.vx-race', phases([['flags', A + 200], ['open', A + 700], ['first', A + 1700], ['hunt', A + 3900],
    ['zoom', B], ['inside', B + 500], ['snap', B + 1150], ['out', B + 2300],
    ['safe', C], ['bounce', C + 800], ['over', C + 1860], ['live', C + 3000]]),
  kicker('warn', 'How it plays'),
  h('div.vx-stagebox',
    miniMap('', {},
      spot('vx-ring', 50, 41, {}, h('i.vx-ring-c')),
      flag('c1', 68, 27, 'Corner store', 0), flag('c2', 27, 58, 'Big statue', 1), flag('c3', 78, 66, 'Park gate', 2),
      spot('vx-shield', 66, 29, {}, h('i')),
      dot('hider', 'd1', 18, 18), dot('hider', 'd2', 38, 72),
      dot('hunter', 'k1', 88, 44), dot('hunter', 'k2', 10, 44),
      spot('vx-bump', 76, 24, {}, h('b', "Can't tag here!")),
      spot('vx-live', 66, 29, {}, h('b', '📍 LIVE'))),
    h('div.vx-hud.cp', h('b.vx-open', 'OPEN'), h('span.vx-safe', h('i'), h('b', 'SAFE'))),
    h('div.vx-chip.first', '👀 Hiders see it first'),
    h('div.vx-chip.lock', '🔒 Hunters: not yet'),
    h('div.vx-polaroid.yes', h('i.vx-photo'), h('b', '✓ COUNTS')),
    h('div.vx-polaroid.no', h('i.vx-photo'), h('b', '✕ NOT INSIDE')),
    h('i.vx-flash')),
  legend('hider', 'hunter', 'cp'));
}

function cpWin(mode, ctx) {
  const A = lineAt(mode, 'x_cp_4');
  const ppl = names3(ctx).slice(0, 3);
  const scores = [3, 2, 1];
  return h('div.vx-scene.vx-cpwin', phases([['next', A + 300], ['win', A + 2880]]),
    kicker('warn', 'Winning'),
    h('div.vx-cprow', { 'aria-hidden': 'true' },
      h('span.vx-cpchip.done', '✓ Corner store'), h('span.vx-cpchip.open', '🚩 Big statue'), h('span.vx-cpchip.lock', '🔒 Park gate')),
    h('ol.vx-board', { 'aria-hidden': 'true' }, ...ppl.map((n, i) => h('li', { ...at(A + 1500 + i * 260), style: { '--i': i } },
      h('span.vx-rank', String(i + 1)), h('b.vx-who', n),
      h('span.vx-flags', ...Array.from({ length: scores[i] }, (_, f) => h('i', { style: { '--f': f } }, '🚩'))),
      i === 0 ? h('span.vx-crown', '👑') : null))),
    h('p.vx-banner.t-gold', 'MOST CHECKPOINTS WINS'));
}

// ---- Loot drops: a tier (v1.7) ---------------------------------------------------------------------------------
const TIER_SAY = { common: 'COMMON', rare: 'RARE', epic: 'EPIC!', legendary: 'LEGENDARY!', mythic: 'MYTHIC!!' };
const TIER_TITLE = { common: 'Common cards', rare: 'Rare cards', epic: 'Epic cards', legendary: 'Legendary cards', mythic: 'Mythic cards' };
const tierOf = (r) => TIERS.find((x) => x.r === r);
const sideIn = (r, k) => (LOOT_TABLE.hider[r].includes(k) ? 'hider' : 'hunter');
// When each card of a tier comes up (ms into the explain stage): as he says its name, CARD_MIN_MS apart at least.
export function tierTimes(r, mode = 'loot') {
  const out = [];
  let last = -Infinity;
  for (const [line, list] of tierOf(r).cards) {
    const base = lineAt(mode, line);
    for (const [k, ms] of list) { last = Math.max(base + ms - 120, last + CARD_MIN_MS); out.push([k, last]); }
  }
  return out;
}
function tier(r, mode) {
  const t = tierOf(r);
  const times = tierTimes(r, mode);
  const lastLine = t.lines[t.lines.length - 1];
  const lineEnd = lineAt(mode, lastLine) + (LINE_MS[lastLine] || 0);
  // the last card stays up to the line's end (and a moment more), then the whole tier lines up face up
  const until = (i) => (i + 1 < times.length ? times[i + 1][1] : Math.max(lineEnd + TIER_PAD - 150, times[i][1] + 1300));
  const idx = (k) => times.findIndex((x) => x[0] === k);
  const bigs = times.map(([k, ms], i) => h(`div.vx-big.r-${r}.vfx-${k}.t-${sideIn(r, k)}`, at(ms, until(i)),
    h('p.vx-rw', sideIn(r, k) === 'hider' ? 'HIDER CARD' : 'HUNTER CARD'),
    h('div.vx-fx', { 'aria-hidden': 'true' }, h('i.a'), h('i.b'), h('i.c'), h('i.d')),
    h('div.vx-big-card', cardEl(k, { full: true, back: true })),
    h('p.vx-say', SHORT[k] || cardInfo(k).line || '')));
  // The commons open the deck: "Thirty-six cards! Blue ones for hiders, red ones for hunters." (x_cards_intro) shows
  // the count, then lights the blue row and the red one as he says them (INTRO_ROWS: ms into that line).
  const intro = t.lines[0] === 'x_cards_intro' ? lineAt(mode, 'x_cards_intro') : null;
  const cols = Math.max(LOOT_TABLE.hider[r].length, LOOT_TABLE.hunter[r].length);
  const row = (side) => h(`div.vx-row.t-${side}`, {
    style: { '--cols': cols },
    ...(intro !== null ? at(intro + INTRO_ROWS[side][0], intro + INTRO_ROWS[side][1]) : {}),
  },
  h('b.vx-rowlabel', side === 'hider' ? 'HIDERS' : 'HUNTERS'),
  h('div.vx-rowcards', ...times.filter(([k]) => sideIn(r, k) === side).map(([k, ms], j) =>
    h(`div.vx-slot.r-${r}`, { ...at(ms, until(idx(k))), style: { '--i': j } }, cardEl(k, { back: true })))));
  const first = lineAt(mode, t.lines[intro !== null ? 1 : 0]);
  return h(`div.vx-scene.vx-deck.vx-tier.r-${r}`,
    h('div.vx-deckhead', h(`p.vs-kicker.vx-kick.vx-tierword.r-${r}`, TIER_TITLE[r]), h('span.vx-count', { 'data-count': '1', 'aria-hidden': 'true' }, `0/${times.length}`)),
    h('div.vx-spot', { 'aria-hidden': 'true' }, h('i.vx-rays'),
      intro !== null ? h('p.vx-tierbig.r-all', at(intro, first), `${ALL_CARDS.length} CARDS`) : null,
      h(`p.vx-tierbig.r-${r}`, at(first, times[0][1]), TIER_SAY[r]), ...bigs),
    h('div.vx-grid.vx-rows', { 'aria-hidden': 'true' }, row('hider'), row('hunter')),
    r === 'mythic' ? h('i.vx-dark.blk', at(times[0][1] + 500, times[1][1])) : null,
    r === 'mythic' ? h('i.vx-dark.eye', at(times[1][1] + 500)) : null);
}

// ---- Loot drops: the demo ------------------------------------------------------------------------------------
function demo(mode) {
  const A = lineAt(mode, 'x_plane');
  const B = lineAt(mode, 'x_loot_4');
  const C = lineAt(mode, 'x_loot_5');
  const phone = (cls) => h(`div.vx-hphone.${cls}`, h('div.vx-hscreen', h('i.vx-hmap'), h('i.vx-hdot'), h('b.vx-hblack', '🌑', h('br'), 'BLACKOUT'), h('small', 'Only the walkie works')), h('span.vx-hlabel', 'HUNTER'));
  return h('div.vx-scene.vx-demo', phases([['plane', A + 400], ['drop', A + 2100], ['walk', A + 3500], ['grab', A + 4700],
    ['open', B], ['burst', B + 350], ['card', B + 800], ['play', B + 2300], ['dark', B + 2900],
    ['race', C], ['see', C + 1700], ['trap', C + 3250], ['pounce', C + 4700]]),
  kicker('warn', 'How it plays'),
  h('div.vx-stagebox',
    miniMap('m1', {},
      spot('vx-ring', 50, 41, {}, h('i.vx-ring-c')),
      spot('vx-zone.z1', 60, 36, {}, h('i'), h('b', '10 m GRAB ZONE')),
      spot('vx-planepath', 50, 38, {}, h('i')),
      spot('vx-box.x1', 60, 36, {}, h('i.vx-chute'), chest('map')),
      spot('vx-box.x3', 80, 60, {}, h('i.vx-chute'), chest('map')),
      spot('vx-plane', -20, 60, {}, planeEl()),
      spot('vx-zone.z2', 32, 33, {}, h('i')),
      spot('vx-box.x2', 32, 33, {}, chest('map')),
      spot('vx-bush', 50, 20, {}, h('span', '🌳')),
      dot('hider', 'you', 12, 66, h('b.vx-tag', 'YOU')),
      dot('hunter', 'k1', 88, 14),
      spot('vx-grab', 60, 36, {}, h('b', 'GRABBED!')),
      spot('vx-trap', 36, 26, {}, h('b', 'TRAP!'))),
    h('div.vx-chestbox', chest('show'), h('div.vx-out', cardEl('blackout', { full: true, back: true })), h('b.vx-played', 'PLAYED!'), h('p.vx-rw.r-mythic', 'MYTHIC!!')),
    h('div.vx-phones', phone('p1'), phone('p2')),
    h('div.vx-eyes', h('span.vx-chip.t-hunter', '👁 Hunters see it'), h('span.vx-chip.t-hider', '👁 Hiders see it'))),
  legend('hider', 'hunter', 'box'));
}

export function explainScene(scene, mode, ctx = {}) {
  switch (scene) {
    case 'hunt': return hunt(mode, ctx);
    case 'cpowers': return classicPowers(mode);
    case 'race': return race(mode);
    case 'cpwin': return cpWin(mode, ctx);
    case 'tier-common': return tier('common', mode);
    case 'tier-rare': return tier('rare', mode);
    case 'tier-epic': return tier('epic', mode);
    case 'tier-legendary': return tier('legendary', mode);
    case 'tier-mythic': return tier('mythic', mode);
    case 'demo': return demo(mode);
    default: return null;
  }
}
