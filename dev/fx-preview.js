// v1.7 VISUALS: the FX preview page. Every card's effect for each `who`, made through the real cardFxOf from
// stand-in events (the contract's shapes), every game moment, the map art, the lasting looks and both binders.
//   window.fxDemo(name)  plays one: 'card:<key>:<self|team|them>', 'moment:<name>', 'plane', 'paws', 'call',
//                        'frost', 'look:<class>', 'binder:<hider|hunter>', 'collection:<hider|hunter>'
//   window.fxList()      every name fxDemo takes
import { h } from '../js/dom.js';
import { cardFxOf, createCardFx, createCardDeck, cardEl, cardInfo, RARITY_WORD } from '../js/cards.js';
import { createGameFx, createCallScreen, pawTrail, flyPlane, frost, MOMENTS } from '../js/fx.js';
import { CARD_KEYS, LOOT_TABLE, RARITIES } from '../shared/loot.js';

const Q = new URLSearchParams(location.search);
if (Q.has('clean')) document.body.classList.add('clean');
const root = document.getElementById('root');
const cards = createCardFx({ root });
const game = createGameFx({ root });
const mapLayer = document.getElementById('maplayer');
let taps = 0;
document.getElementById('tap').addEventListener('click', (e) => { taps += 1; e.currentTarget.textContent = `Tap test: ${taps}`; });
window.__taps = () => taps;

// (which side may notice a card of the other side: the THEM table in cards.js)
const THEM_OK = new Set(['radar', 'exposure', 'hacker', 'wiretap', 'freeze', 'double', 'tracker', 'storm', 'glitch', 'blackout', 'hound', 'quickping', 'useless']);
const players = [{ id: 'me', name: 'Mia' }, { id: 'leo', name: 'Leo' }, { id: 'sam', name: 'Sam' }, { id: 'ava', name: 'Ava' }];
const DATA = {
  multiplier_hider: { card: 'storm', pct: 73 }, multiplier_hunter: { card: 'freeze', pct: 60 },
  grabbag_hider: { got: 'smoke' }, grabbag_hunter: { got: 'compass' }, scout: { n: 2, m: 200 },
  swap: { with: 'leo', gave: 'smoke', got: 'decoy' }, eavesdrop: { hands: [{ id: 'ava', cards: { radar: 1, freeze: 1 } }, { id: 'sam', cards: { hound: 2 } }] },
  duplicator_hider: { card: 'blackout' }, duplicator_hunter: { card: 'eye' },
};
export function fxFor(key, who) {
  const side = cardInfo(key).team;
  const myTeam = who === 'them' ? (side === 'hunter' ? 'hider' : 'hunter') : side;
  const view = { phase: 'live', me: { id: 'me', name: 'Mia', team: myTeam, status: 'in' }, players, events: [] };
  const d = { power: key, ...(DATA[key] || {}) };
  let e;
  if (who === 'self') e = { kind: 'lootfx', to: 'me', clock: Date.now(), data: { ...d, by: 'me' } };
  else if (who === 'team') e = { kind: side === 'hider' ? 'power' : 'lootfx', to: side === 'hider' ? 'hiders' : 'hunters', clock: Date.now(), data: { ...d, by: 'leo' } };
  else if (key === 'radar' || key === 'exposure') e = { kind: key, to: 'hiders', clock: Date.now(), data: {} };
  else e = { kind: 'lootfx', to: 'me', clock: Date.now(), data: { power: key, target: 'me', ...(DATA[key] || {}) }, text: '' };
  return cardFxOf(e, view);
}

const CARD_WHOS = (k) => (THEM_OK.has(k) ? ['self', 'team', 'them'] : ['self', 'team']);
const NAMES = [];
for (const side of ['hider', 'hunter']) for (const k of CARD_KEYS[side]) for (const w of CARD_WHOS(k)) NAMES.push(`card:${k}:${w}`);
for (const m of MOMENTS) NAMES.push(`moment:${m}`);
NAMES.push('moment:mirror:blocked', 'moment:mirror:bounce', 'plane', 'paws', 'call', 'frost', 'look:fx-frozen', 'look:fx-useless', 'look:fx-mirror', 'look:fx-headsup', 'look:fx-snitched',
  'binder:hider', 'binder:hunter', 'collection:hider', 'collection:hunter');
window.fxList = () => [...NAMES];

const W = () => window.innerWidth;
const H = () => window.innerHeight;
let call = null;
let deck = null;
let col = null;
function closeAll() {
  if (call) { call.close(); call = null; }
  if (deck) { deck.close(); }
  if (col) { col.remove(); col = null; document.body.classList.remove('scroll'); }
}
function collection(side) {
  closeAll();
  const el = h('div.pv-col', h('h2', side === 'hunter' ? 'Hunter cards · 18 of 18' : 'Hider cards · 18 of 18'));
  for (const r of RARITIES) {
    el.append(h(`h4.r-${r}`, RARITY_WORD[r]));
    el.append(h('div.grid', ...LOOT_TABLE[side][r].map((k, i) => { const c = cardEl(k, { n: k === 'smoke' || k === 'hound' ? 2 : 0, boost: k === 'storm' || k === 'freeze' ? 60 : 0 }); c.style.setProperty('--i', String(i)); return c; })));
  }
  document.body.append(el);
  col = el;
  document.body.classList.add("scroll");
  return true;
}
function closeups(side) {
  closeAll();
  const keys = Q.get('keys') ? Q.get('keys').split(',') : CARD_KEYS[side];
  const el = h('div.pv-col.big', h('h2', 'New cards'), h('div.grid', ...keys.map((k) => cardEl(k, { full: true }))));
  document.body.append(el);
  col = el;
  document.body.classList.add("scroll");
  return true;
}
window.fxCloseups = closeups;

window.fxDemo = (name) => {
  const [kind, a, b] = String(name).split(':');
  if (kind === 'card') { const fx = fxFor(a, b); return fx ? cards.play(fx) : false; }
  if (kind === 'moment') {
    const opts = { 'drop-incoming': { ms: 10000 }, 'ring-soon': { ms: 60000 }, headsup: { d: 140, dir: 40 }, 'call-ring': { name: 'Hunters' }, mirror: { what: b || 'reflect' }, pinged: { x: W() / 2, y: H() / 2 - 56 }, 'ping-in': { points: [[W() * 0.3, H() * 0.35], [W() * 0.7, H() * 0.55], [W() * 0.5, H() * 0.25]] }, 'crate-land': {} }[a] || {};
    return game.play(a, opts);
  }
  if (kind === 'plane') {
    const f = flyPlane(mapLayer, { path: [[-80, H() * 0.62], [W() + 80, H() * 0.28]], ms: 6000, drops: [[W() * 0.35, H() * 0.48], [W() * 0.62, H() * 0.42]], onLand: () => game.play('crate-land', {}) });
    game.play('drop-incoming', { ms: 8000 });
    setTimeout(() => f.remove(), 9500);
    return true;
  }
  if (kind === 'paws') {
    const pts = [];
    for (let i = 0; i <= 30; i++) { const t = i / 30; pts.push([30 + t * (W() - 60), H() * 0.7 - Math.sin(t * Math.PI * 1.4) * H() * 0.3]); }
    const p = pawTrail(mapLayer, pts, { ms: 2200 });
    setTimeout(() => p.remove(), 5000);
    return true;
  }
  if (kind === 'call') {
    closeAll();
    game.play('call-ring', { name: 'Hunters' });
    setTimeout(() => {
      call = createCallScreen({ root, name: 'Hunters', offer: 'Give up a teammate and get a random card.', mates: [{ id: 'leo', name: 'Leo' }, { id: 'sam', name: 'Sam' }], onHangup: () => setTimeout(closeAll, 900), onSnitch: () => { game.play('deal', {}); setTimeout(closeAll, 600); } });
      window.__call = call;
    }, Q.has('instant') ? 0 : 1600);
    return true;
  }
  if (kind === 'frost') {
    const f = frost(document.getElementById('cards'));
    setTimeout(() => f.crack(), 2600);
    return true;
  }
  if (kind === 'look') { root.classList.toggle(a); document.body.classList.toggle(a, false); return true; }
  if (kind === 'binder') {
    closeAll();
    const hand = Object.fromEntries(CARD_KEYS[a].map((k) => [k, k === 'smoke' || k === 'hound' ? 2 : 1]));
    deck = createCardDeck({ app: root });
    deck.update({ phase: 'live', code: 'PREV', clock: 1000, me: { id: 'me', team: a, status: 'in', powers: {} }, team: {}, fx: {}, loot: { hand, boosts: { storm: [60], freeze: [45] }, boxes: [] } });
    deck.open();
    return true;
  }
  if (kind === 'collection') return collection(a);
  if (kind === 'closeups') return closeups(a || 'hider');
  return false;
};

// the buttons
const nav = document.getElementById('controls');
let group = '';
for (const n of NAMES) {
  const g = n.split(':')[0] === 'card' ? `${cardInfo(n.split(':')[1]).team} cards` : n.split(':')[0];
  if (g !== group) { nav.append(h('h3', g)); group = g; }
  const b = h('button', { type: 'button' }, n.replace(/^card:/, '').replace(/^moment:/, ''));
  b.addEventListener('click', () => window.fxDemo(n));
  nav.append(b);
}
nav.append(h('h3', 'close'));
const x = h('button', { type: 'button' }, 'close screens');
x.addEventListener('click', closeAll);
nav.append(x);
window.fxClose = closeAll;
