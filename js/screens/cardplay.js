// Night Ops v1.7 (WIRING): the card overhaul on the phone's game screen (CONTRACT.md "v1.7: the card overhaul").
//
// Pure helpers (node tests: tests/cardplay-v17.test.mjs):
//   needsOf(key)                 -> { target, card, offer } what a card asks for before it's played
//   targetsFor(view, key)        -> [{ id, name, ok, why }] the free hiders a card may be aimed at
//   cardsToPick(view, key)       -> [{ key, n, boost }] the cards Multiplier / Duplicator may pick
//   teamDeckOf(view)             -> [{ id, name, me, driver, cards: [{ key, n, boost }] }] every hunter's hand
//   looksOf(view)                -> { 'fx-frozen', 'fx-useless', 'fx-mirror', 'fx-headsup', 'fx-snitched' } booleans
//   chipsOf(view, gone)          -> [{ cls, words }] the small lines over the map for v1.7's lasting effects (lootplay's
//                                createLootFx shows them in its row, through moreChips)
//   planeOf(view, gone)          -> { path, at, n, left } | null (left: ms to the landing on this phone's clock)
//   planeSpot(path, left)        -> { f, p } where the plane is now (f 0..1 along the path, flying from 8 s to 1 s)
//   pawPathsOf(view)             -> [{ id, label, pts: [[lng, lat]] }] Hound dog's trails (hunters) or Mirror's (hiders)
//   pawSteps(pts, every)         -> [{ p, next, i }] a paw every `every` metres along a trail, the newest last
//   rewindMarksOf(view)          -> map marks { kind: 'rewind' } for Rewind's circles
//   momentOf(e, view)            -> { name, opts, quiet, at?, replaces? } | null: which FX library moment an event
//                                plays (at: map points the moment is placed at; replaces: it stands in for the game
//                                screen's own big moment, which would cover the map)
//   playsMoments(view)           -> false on a driver's or an out player's phone (no one-shot moments there)
//   callEndWords(view, id)       -> how a call ended, from the newest `call` event for it ('' if none yet)
//   seatOf(view)                 -> { open, drivers } the second driver's seat (Become a driver)
//
// createCardPlay({ app, root, slot, map, deckButton, faces, pickRow, sos }) -> { use(key), update(view, clock),
//   event(e), teamDeck(view), seatButton, destroy() }
//   use(key)     plays a card from your hand: pick a hider, a card or an offer first when the card needs one
//   update       the lasting looks on the root (and the open binder), the chips, Eavesdrop's hands, the call
//                screen, the plane, the crates, the paw prints, the seat button
//   event(e)     plays the moments (headsup, mirror, snitched, deal, bounced, pinged, ping-in, ring-soon,
//                ring-shrinking) through createGameFx -> momentOf's answer + played (false: it didn't show)
//   sos          what the call screen's own SOS button does (shown only while a Blackout covers the screen)
import { h, text } from '../dom.js?v=183';
import { openSheet, closeSheets } from '../ui/sheet.js?v=183';
import { banner } from '../ui/banner.js?v=183';
import { cardInfo } from '../cards.js?v=183';
import { LOOT_POWERS, SNITCH_OFFERS, boostable, sideOfCard } from '../../shared/loot.js?v=183';
import { POWERS, fmtClock } from '../../shared/rules.js?v=183';
import { distanceM, bearingDeg, isPoint } from '../../shared/geo.js?v=183';
import { createGameFx, createCallScreen, planeEl, crateChuteEl, pawEl, dustEl, frost } from '../fx.js?v=183';

export const PLANE_FROM_MS = 8000;  // the plane starts across the map this long before the crates land...
export const PLANE_TO_MS = 1000;    // ...and is past the drop this long before
export const CRATE_FALL_MS = 1400;  // a crate's fall under its parachute, once the boxes are on the map
export const PAW_EVERY_M = 7;       // a paw print every few metres along a trail...
export const PAW_MOST = 70;         // ...at most this many a trail (the newest)
export const CALL_END_MS = 2600;    // the call screen stays this long after the call ends, saying how
export const ANSWERED_KEY = 'nightops-call-answered'; // the call this phone answered ("code|round|call id"): a reload keeps it answered
const WORDS_CALL_SAVED = "Only you two hear this. It's saved for the replay.";
const WORDS_CALL = 'Only you two hear this.';

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const nameIn = (view, id) => {
  const p = (view && Array.isArray(view.players) ? view.players : []).find((x) => x && x.id === id);
  return p && p.name ? String(p.name) : '';
};

// ---- what a card needs -----------------------------------------------------------------------------------------

export function needsOf(key) {
  const P = LOOT_POWERS[key] || {};
  const classicAim = key === 'hacker' || key === 'wiretap';
  return { target: !!P.target || classicAim, card: !!P.pick, offer: !!P.offer };
}

export function freeHiderList(view) {
  return (view && Array.isArray(view.players) ? view.players : [])
    .filter((p) => p && p.team === 'hider' && p.status === 'in' && !p.driver);
}

export function targetsFor(view, key) {
  const okIds = view && view.tapOk && Array.isArray(view.tapOk.okIds) ? view.tapOk.okIds : null;
  const me = view && view.me ? view.me.id : null;
  return freeHiderList(view).filter((p) => p.id !== me).map((p) => {
    const noTap = key === 'wiretap' && okIds && !okIds.includes(p.id);
    return { id: p.id, name: p.name || 'Hider', ok: !noTap, why: noTap ? "Didn't say OK to Wiretap" : '' };
  });
}

function handOf(view) {
  const l = view && view.loot;
  return isObj(l) && isObj(l.hand) ? l : null;
}

export function cardsToPick(view, key) {
  const l = handOf(view);
  if (!l) return [];
  const boosts = isObj(l.boosts) ? l.boosts : {};
  const out = [];
  for (const [k, n] of Object.entries(l.hand)) {
    if (!(n > 0) || !cardInfo(k)) continue;
    const b = Array.isArray(boosts[k]) ? boosts[k].filter(Number.isFinite) : [];
    // (the card being played is one copy of its own key: it can't pick itself)
    const have = k === key ? n - 1 : n;
    if (have <= 0) continue;
    if (key === 'multiplier_hider' || key === 'multiplier_hunter') {
      if (!boostable(k) || b.length >= have) continue;
    } else if (key === 'duplicator_hider' || key === 'duplicator_hunter') {
      if (k === 'duplicator_hider' || k === 'duplicator_hunter') continue;
    }
    out.push({ key: k, n: have, boost: b.length ? Math.max(...b) : 0 });
  }
  return out.sort((a, b) => (cardInfo(a.key).name || '').localeCompare(cardInfo(b.key).name || ''));
}

export function teamDeckOf(view) {
  const l = view && view.loot;
  if (!isObj(l) || !Array.isArray(l.deck)) return [];
  const me = view.me ? view.me.id : null;
  return l.deck.filter((d) => d && d.id).map((d) => {
    const hand = isObj(d.hand) ? d.hand : {};
    const boosts = isObj(d.boosts) ? d.boosts : {};
    const cards = Object.entries(hand).filter(([k, n]) => n > 0 && cardInfo(k)).map(([k, n]) => {
      const b = Array.isArray(boosts[k]) ? boosts[k].filter(Number.isFinite) : [];
      return { key: k, n, boost: b.length ? Math.max(...b) : 0 };
    });
    return { id: d.id, name: nameIn(view, d.id) || 'Hunter', me: d.id === me, driver: !!d.driver, cards };
  });
}

// ---- lasting looks and chips -------------------------------------------------------------------------------------

export function looksOf(view) {
  const fx = (view && view.phase === 'live' && view.fx) || {};
  const me = (view && view.me) || {};
  const hider = me.team === 'hider' && me.status === 'in';
  const on = (v) => (Number.isFinite(v) ? v > 0 : !!v);
  return {
    'fx-frozen': hider && on(fx.freeze),
    'fx-useless': hider && Number.isFinite(fx.useless) && fx.useless > 0,
    'fx-mirror': hider && on(fx.mirror),
    'fx-headsup': hider && on(fx.headsup),
    'fx-snitched': hider && on(fx.snitched),
  };
}

export function chipsOf(view, gone = 0) {
  const fx = (view && view.phase === 'live' && view.fx) || {};
  const me = (view && view.me) || {};
  const left = (v) => Math.max(0, (Number(v) || 0) - gone);
  const out = [];
  const add = (cls, words) => out.push({ cls, words });
  if (me.team === 'hider') {
    if (left(fx.snitched)) add('snitched', `👀 Someone snitched on you. Move! ${fmtClock(left(fx.snitched))}`);
    if (left(fx.useless)) add('useless', `🚫 Your cards are useless ${fmtClock(left(fx.useless))}`);
    if (left(fx.headsup)) add('headsup', `🔔 Heads up on ${fmtClock(left(fx.headsup))}`);
    if (left(fx.lookout)) add('lookout', `🔦 Lookout: hunters live ${fmtClock(left(fx.lookout))}`);
    if (left(fx.mirror)) add('mirror', `🪞 Mirror on ${fmtClock(left(fx.mirror))}`);
    if (isObj(fx.mirrored) && left(fx.mirrored.left)) add('mirror', `🪞 You can see them too ${fmtClock(left(fx.mirrored.left))}`);
    if (isObj(fx.stall)) add('stall', Number.isFinite(fx.stall.at) && Number.isFinite(view.clock)
      ? `⏳ Stall: your late ping in ${fmtClock(Math.max(0, fx.stall.at - view.clock - gone))}`
      : '⏳ Stall ready: next ping');
    if (fx.safe > 0) add('safe', `🤝 Deal: off the next ping${fx.safe > 1 ? ` (${fx.safe})` : ''}`);
  } else if (me.team === 'hunter' && !me.driver) {
    if (isObj(fx.scout) && left(fx.scout.left)) add('scout', `🔭 Scout: ${fx.scout.n} ${fx.scout.n === 1 ? 'hider' : 'hiders'} within ${fx.scout.m || 200} m`);
    if (isObj(fx.hound) && left(fx.hound.left)) add('hound', `🐕 Paw prints ${fmtClock(left(fx.hound.left))}`);
    if (isObj(fx.rewind) && left(fx.rewind.left)) add('rewind', `⏪ Rewind ${fmtClock(left(fx.rewind.left))}`);
    if (Array.isArray(fx.useless)) for (const u of fx.useless) if (u && left(u.left)) add('useless', `🚫 ${nameIn(view, u.id) || 'A hider'}: useless ${fmtClock(left(u.left))}`);
  }
  return out;
}

// ---- the plane ----------------------------------------------------------------------------------------------------

export function planeOf(view, gone = 0) {
  const l = view && view.loot;
  const pl = isObj(l) && isObj(l.plane) ? l.plane : null;
  if (!pl || !Array.isArray(pl.path) || pl.path.length < 2 || !isPoint(pl.path[0]) || !isPoint(pl.path[1])) return null;
  const left = (Number.isFinite(pl.in) ? pl.in : 0) - gone;
  return { path: [pl.path[0], pl.path[1]], at: pl.at, n: pl.n, left };
}

export function planeSpot(path, left) {
  const f = Math.max(0, Math.min(1, (PLANE_FROM_MS - left) / (PLANE_FROM_MS - PLANE_TO_MS)));
  const [a, b] = path;
  return { f, p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] };
}

// ---- paw prints and Rewind ------------------------------------------------------------------------------------------

export function pawPathsOf(view) {
  const fx = (view && view.phase === 'live' && view.fx) || {};
  const me = (view && view.me) || {};
  let paths = [];
  if (me.team === 'hunter' && !me.driver && isObj(fx.hound) && Array.isArray(fx.hound.paths)) paths = fx.hound.paths;
  else if (me.team === 'hider' && Array.isArray(fx.mirrorPaws)) paths = fx.mirrorPaws;
  return paths.filter((x) => x && Array.isArray(x.pts)).map((x) => ({
    id: x.id, label: x.label || nameIn(view, x.id), pts: x.pts.filter((q) => Array.isArray(q) && isPoint([q[0], q[1]])).map((q) => [q[0], q[1]]),
  })).filter((x) => x.pts.length >= 2);
}

export function pawSteps(pts, every = PAW_EVERY_M, most = PAW_MOST) {
  const out = [];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = distanceM(a, b);
    if (!(d > 0)) continue;
    for (let s = carry; s < d; s += every) {
      const f = s / d;
      out.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], next: b, b: bearingDeg(a, b) });
    }
    carry = (carry - d) % every;
    if (carry < 0) carry += every;
  }
  const last = pts[pts.length - 1];
  out.push({ p: [last[0], last[1]], next: null, b: out.length ? out[out.length - 1].b : 0 });
  return out.slice(-most).map((x, i) => ({ ...x, i }));
}

export function rewindMarksOf(view) {
  const fx = (view && view.phase === 'live' && view.fx) || {};
  const me = (view && view.me) || {};
  if (me.team !== 'hunter' || me.driver || !isObj(fx.rewind) || !Array.isArray(fx.rewind.spots)) return [];
  return fx.rewind.spots.filter((x) => x && isPoint(x.p)).map((x) => ({ id: x.id, kind: 'rewind', p: [x.p[0], x.p[1]], r: Number(x.r) || 0, age: Number(x.age) || 0, label: x.label || nameIn(view, x.id) }));
}

// ---- moments ------------------------------------------------------------------------------------------------------

export function momentOf(e, view) {
  if (!e || !view || !view.me || view.phase !== 'live') return null;
  const me = view.me;
  if (me.status !== 'in') return null;
  const d = isObj(e.data) ? e.data : {};
  switch (e.kind) {
    case 'loot-plane': {
      const ms = Number.isFinite(d.at) && Number.isFinite(e.clock) ? d.at - e.clock : 10000;
      return { name: 'drop-incoming', opts: { ms }, quiet: true };
    }
    case 'headsup': if (e.to !== me.id) return null; return { name: 'headsup', opts: { d: d.d }, quiet: false };
    case 'mirror': if (e.to !== me.id) return null; return { name: 'mirror', opts: { what: d.what === 'bounced' ? 'bounce' : d.what === 'blocked' ? 'blocked' : 'reflect' }, quiet: false };
    case 'snitched': if (e.to !== me.id) return null; return { name: 'snitched', opts: {}, quiet: false };
    case 'hacked': if (!d.bounced || e.to !== me.id) return null; return { name: 'bounced', opts: {}, quiet: false };
    case 'call':
      if (e.to !== me.id) return null;
      if (d.state === 'snitched' && me.team === 'hunter') return { name: 'deal', opts: {}, quiet: false };
      if (d.state === 'on' && me.team === 'hider') return { name: 'call-ring', opts: { name: nameIn(view, d.by) }, quiet: true };
      return null;
    case 'lootfx':
      if (d.power === 'snitch' && d.on && me.team === 'hunter' && !me.driver && d.by !== me.id) return { name: 'deal', opts: {}, quiet: false };
      return null;
    // v1.7 (section 13): being pinged and a ping reaching the hunters, in Loot drops: the FX instead of the screen's
    // big PING card (which covers the map the ripples are on); its words go to a banner. Never on the driver's phone.
    case 'ping': {
      if (me.driver || !isObj(view.settings) || view.settings.mode !== 'loot') return null;
      const marks = Array.isArray(view.marks) ? view.marks : [];
      if (e.to === me.id && me.team === 'hider') {
        if (d.result !== 'pinged' && d.result !== 'smoke') return null; // (a ping that missed them: the big card says how)
        const self = marks.find((m) => m && m.kind === 'self' && m.id === me.id && isPoint(m.p));
        return { name: 'pinged', opts: {}, at: self ? [self.p] : [], quiet: d.result === 'pinged' && !d.late, replaces: true };
      }
      if (e.to === 'hunters' && me.team === 'hunter') {
        if (!(Number(d.count) > 0)) return null; // ("Nobody showed up": the big card says it)
        // this ping's circles: the ping marks as old as the event (the view that brought it has them)
        const since = Number.isFinite(view.clock) && Number.isFinite(e.clock) ? view.clock - e.clock : 0;
        const at = marks.filter((m) => m && m.kind === 'ping' && isPoint(m.p) && Number(m.age) <= since + 1000).map((m) => m.p);
        return { name: 'ping-in', opts: {}, at, quiet: false, replaces: true };
      }
      return null;
    }
    // the ring closing in (every mode: section 10), a minute before and as it starts moving
    case 'closing-soon':
      if (me.driver) return null;
      return { name: 'ring-soon', opts: { ms: Number.isFinite(d.in) && d.in > 0 ? d.in : 60000 }, quiet: false };
    case 'closing':
      if (me.driver || !shrinks(view)) return null;
      return { name: 'ring-shrinking', opts: {}, quiet: false };
    default: return null;
  }
}

function shrinks(view) {
  const s = view && isObj(view.settings) ? view.settings : null;
  return !!s && !!s.shrink && s.closingMin > 0 && s.finalSizePct < 100;
}

// One-shot moments (the drop's countdown, a crate landing...) are for players who are in and not driving; a
// spectator (no `me`) gets them too (section 13).
export function playsMoments(view) {
  const me = view && view.me;
  return !me || (me.status === 'in' && !me.driver);
}

// What a call's end says on its screen: the newest `call` event to this phone for that call that isn't its start.
// (app.js hands a view over before the events it brings, so the screen reads them from view.events.)
export function endWordsOf(e) {
  const d = e && isObj(e.data) ? e.data : {};
  if (d.state === 'timeout') return 'Time up. No deal.';
  return e && typeof e.text === 'string' && e.text.trim() ? e.text : 'The call ended.';
}
export function callEndWords(view, id) {
  const me = view && view.me ? view.me.id : null;
  const list = view && Array.isArray(view.events) ? view.events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const d = e && isObj(e.data) ? e.data : null;
    if (e && e.kind === 'call' && e.to === me && d && d.call === id && d.state && d.state !== 'on') return endWordsOf(e);
  }
  return '';
}

// A spectator (2 minutes late): a card the hunters' side may know about shows as a team-style effect. watchView
// never carries hider card news while live (section 11), so only what reaches here is shown.
export function spectatorFx(e, view) {
  if (!e || !view || view.phase !== 'live') return null;
  if (e.kind !== 'power' && e.kind !== 'lootfx') return null;
  if (e.to !== 'hunters' && e.to !== 'all') return null;
  const d = isObj(e.data) ? e.data : {};
  const info = typeof d.power === 'string' ? cardInfo(d.power) : null;
  if (!info) return null;
  if (d.power === 'snitch' && (d.on || d.state)) return null; // (how a Snitch call ended: news, not a card played again)
  const who = d.by && info.team === 'hunter' ? nameIn(view, d.by) : '';
  return {
    power: d.power, card: info, side: info.team, rarity: info.rarity, data: { ...d }, key: `${d.power}|${d.by || ''}|${e.clock}`,
    who: 'team', tone: 'play', kicker: who ? `${who} played` : info.team === 'hunter' ? 'The hunters played' : 'The hiders played',
    title: String(info.name).toUpperCase(), line: String(e.text || info.line),
  };
}

export function seatOf(view) {
  const dv = view && view.drive;
  const me = (view && view.me) || {};
  const open = !!(view && view.phase === 'live' && me.team === 'hunter' && me.status === 'in' && !me.driver && isObj(dv) && isObj(dv.slot) && dv.slot.open);
  return { open, drivers: isObj(dv) && Array.isArray(dv.drivers) ? dv.drivers : [] };
}

// ---- the controller ------------------------------------------------------------------------------------------------

export function createCardPlay({ app, root, slot = null, getMap = () => null, deckButton = null, pickRow = null, sos = null, doc = globalThis.document } = {}) {
  const S = { view: null, gone: 0, dead: false, call: null, ending: null, later: new Set(), plane: null, planeKey: '', crates: [], boxIds: null, paws: [], pawKey: '', raf: 0, offDraw: null, mapRef: null, frozeWas: false, landed: '' };
  const gfx = createGameFx({ root, doc });
  const ears = h('div.cp7-ears', { hidden: true, 'aria-label': "The hunters' cards" });
  (slot || root).append(ears);
  const seatButton = h('button.btn.wide.cp7-seat', { type: 'button', hidden: true }, '🚗 Become a driver');
  seatButton.addEventListener('click', () => becomeDriver());
  // the map art: a line for the plane's path, the plane, crates, paws
  const svgNS = 'http://www.w3.org/2000/svg';
  const pathSvg = doc.createElementNS(svgNS, 'svg');
  pathSvg.setAttribute('class', 'cp7-path');
  const pathLine = doc.createElementNS(svgNS, 'line');
  pathSvg.append(pathLine);
  const plane = planeEl(doc);
  plane.classList.add('cp7-plane');
  const pawsBox = h('div.cp7-paws');
  const art = h('div.cp7-art', pawsBox, pathSvg, plane);
  pathSvg.style.display = 'none';
  plane.hidden = true;
  const view = () => S.view;

  function attach() {
    const map = getMap();
    if (!map || map === S.mapRef || !map.cardLayer) return;
    if (S.offDraw) S.offDraw();
    S.mapRef = map;
    map.cardLayer.append(art);
    S.offDraw = map.onDraw(() => place());
  }
  const project = (p) => { try { return S.mapRef ? S.mapRef.project(p) : null; } catch { return null; } };
  // A map point in the moments layer's own px (it starts under the top bar), or null when it isn't on the screen.
  function toLayer(p) {
    const xy = isPoint(p) ? project(p) : null;
    const mapEl = S.mapRef && S.mapRef.element;
    if (!xy || !mapEl || !gfx.el) return null;
    const r = mapEl.getBoundingClientRect();
    const L = gfx.el.getBoundingClientRect();
    const x = r.left + xy[0] - L.left;
    const y = r.top + xy[1] - L.top;
    if (!(L.width > 0 && L.height > 0) || x < 0 || y < 0 || x > L.width || y > L.height) return null;
    return [Math.round(x), Math.round(y)];
  }

  // ---- playing a card
  function pickSheet({ title, rows, note = '' }) {
    return new Promise((resolve) => {
      let picked = null;
      let sheet = null;
      const btns = rows.map((r) => {
        const b = pickRow ? pickRow({ id: r.id, name: r.name, team: r.team || 'hider', sub: r.sub || '', disabled: r.disabled,
          onClick: () => { picked = r.value; if (sheet) sheet.close(); else closeSheets(); } }).btn
          : h('button.g-pick', { type: 'button', disabled: !!r.disabled, onclick: () => { picked = r.value; if (sheet) sheet.close(); } }, r.name);
        if (r.cls) b.classList.add(r.cls);
        return b;
      });
      sheet = openSheet({
        title,
        body: [note ? h('p.g-sheet-note', note) : null, btns.length ? h('div.g-pick-list', ...btns) : h('p', 'Nothing to pick right now.')].filter(Boolean),
        className: 'g-sheet g-target cp7-pick',
        actions: [{ label: 'Cancel', kind: 'ghost' }],
        onClose: () => resolve(picked),
      });
    });
  }
  function cardRows(list) {
    return list.map((c) => {
      const info = cardInfo(c.key);
      return { value: c.key, id: `card-${c.key}`, name: `${info.emoji} ${info.name}${c.n > 1 ? ` ×${c.n}` : ''}`, sub: c.boost ? `Boosted +${c.boost}%` : info.line, cls: 'cp7-cardrow', team: info.team };
    });
  }
  async function use(key) {
    const v = view();
    if (!v || !key) return false;
    const info = cardInfo(key);
    if (!info) return false;
    const need = needsOf(key);
    const cmd = { type: 'lootuse', power: key };
    if (need.card) {
      const list = cardsToPick(v, key);
      if (!list.length) { banner(key.startsWith('multiplier') ? 'None of your cards can be boosted right now.' : 'You need another card to copy.', 'info'); return false; }
      const pick = await pickSheet({ title: key.startsWith('multiplier') ? 'Multiplier: boost which card?' : 'Duplicator: copy which card?', rows: cardRows(list), note: info.line });
      if (!pick) return false;
      cmd.card = pick;
    }
    if (need.target) {
      const hiders = targetsFor(view(), key);
      const rows = hiders.map((x) => ({ value: x.id, id: x.id, name: x.name, sub: x.why, disabled: !x.ok }));
      if (need.offer) rows.unshift({ value: '*random', id: 'random', name: '🎲 Any hider (random)', sub: 'You find out who picks up.' });
      const pick = await pickSheet({ title: `${info.name}: pick a hider`, rows, note: info.line });
      if (!pick) return false;
      if (pick !== '*random') cmd.target = pick;
    }
    if (need.offer) {
      const offer = await pickSheet({
        title: 'Snitch: what do you offer?',
        rows: SNITCH_OFFERS.map((o) => ({ value: o.key, id: `offer-${o.key}`, name: o.label, sub: o.line, cls: 'cp7-offer', team: 'hunter' })),
        note: 'They get 45 seconds to take the deal and give up a teammate.',
      });
      if (!offer) return false;
      cmd.offer = offer;
    }
    try {
      const res = await app.cmd(cmd);
      return !!res && !res.error;
    } catch { return false; }
  }

  async function becomeDriver() {
    seatButton.disabled = true;
    try { await app.cmd({ type: 'becomedriver' }); } catch { /* the banner says */ }
    seatButton.disabled = false;
  }

  // ---- the hunters' team deck (under your cards in the binder)
  function teamDeck(v) {
    const rows = teamDeckOf(v).filter((r) => !r.me);
    if (!(v && v.me && v.me.team === 'hunter') || !Array.isArray(v.loot && v.loot.deck)) return null;
    const list = rows.map((r) => h('li.cp7-mate', { 'data-id': r.id },
      h('strong.cp7-mate-name', `${r.name}${r.driver ? ' 🚗' : ''}`),
      r.cards.length
        ? h('span.cp7-mate-cards', ...r.cards.map((c) => {
          const info = cardInfo(c.key);
          return h(`span.cp7-mini.r-${info.rarity}`, { 'data-card': c.key, title: info.line }, `${info.emoji} ${info.name}${c.n > 1 ? ` ×${c.n}` : ''}${c.boost ? ` +${c.boost}%` : ''}`);
        }))
        : h('span.cp7-mate-none', 'No cards yet')));
    return h('section.cp7-team', { 'aria-label': 'Team deck' },
      h('h3.cp7-team-title', '🃏 Team deck'),
      h('p.cp7-team-line', "Your team's cards. Only whoever holds a card can play it: tell them on the walkie."),
      rows.length ? h('ul.cp7-team-list', ...list) : h('p.cp7-mate-none', 'No other hunters yet.'));
  }

  // ---- the call screen
  // (a callee who answered keeps it answered through a reload: the call id is kept on this phone)
  const callKey = (v, id) => `${(v && v.code) || ''}|${v && Number.isFinite(v.round) ? v.round : ''}|${id}`;
  const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };
  function answered(v, id) { try { const s = store(); return !!s && s.getItem(ANSWERED_KEY) === callKey(v, id); } catch { return false; } }
  function keepAnswered(v, id) { try { const s = store(); if (s) s.setItem(ANSWERED_KEY, callKey(v, id)); } catch { /* fine */ } }
  function syncCall(v) {
    const c = v && v.phase === 'live' && v.fx && isObj(v.fx.call) ? v.fx.call : null;
    if (S.call && (!c || c.id !== S.call.id)) {
      const old = S.call;
      S.call = null;
      // How it ended: the end's own event (in this view's events), else what the screen already says (it counted
      // down to "Time up.", or Hang up was pressed here), else a plain line. Its countdown stops.
      const el = old.screen.el;
      const said = el.dataset.state === 'ended' ? String((el.querySelector('.call-words') || {}).textContent || '') : '';
      try { old.screen.set('ended', callEndWords(v, old.id) || said || 'The call ended.'); } catch { /* fine */ }
      const ending = { id: old.id, screen: old.screen, until: Date.now() + CALL_END_MS };
      S.ending = ending;
      setTimeout(() => { old.screen.close(); if (S.ending === ending) S.ending = null; }, CALL_END_MS);
      if (app.radio && old.talking) { try { app.radio.callLetGo(); } catch { /* fine */ } }
    }
    if (!c) return;
    const left = Math.max(0, c.left - S.gone);
    if (!S.call) {
      const offer = SNITCH_OFFERS.find((o) => o.key === c.offer);
      const caller = c.role === 'hunter';
      const savedLine = c.saved ? WORDS_CALL_SAVED : WORDS_CALL;
      const rec = { id: c.id, talking: false, screen: null };
      const again = !caller && answered(v, c.id);
      rec.screen = createCallScreen({
        root, doc,
        name: caller ? `Calling ${nameIn(v, c.with) || 'a hider'}` : (nameIn(v, c.with) || 'The hunters'),
        offer: offer ? offer.label : '',
        mates: caller ? [] : (Array.isArray(c.mates) ? c.mates : []).map((id) => ({ id, name: nameIn(v, id) || 'Hider' })),
        ms: left,
        caller,
        state: again ? 'talk' : null,
        onAccept: () => {
          keepAnswered(S.view || v, c.id);
          setTimeout(() => { try { rec.screen.set('talk', savedLine); } catch { /* fine */ } }, 0);
        },
        onHangup: () => { app.cmd({ type: 'call', do: 'hangup' }).catch(() => {}); },
        onTimeout: () => {},
        onTalk: (on) => {
          if (!app.radio) { if (on) banner("This phone can't record. Hang up or pick someone.", 'info'); return; }
          rec.talking = on;
          try { if (on) app.radio.callHold(); else app.radio.callLetGo(); } catch (e) { console.error(e); }
        },
        onSnitch: (id) => { app.cmd({ type: 'call', do: 'snitch', on: id }).catch(() => {}); },
      });
      rec.screen.el.classList.add(`cp7-call-${c.role}`);
      // (a Blackout covers the hunter's screen, but never the call: the call keeps its own SOS on top)
      if (sos) {
        const sb = h('button.call-sos', { type: 'button', 'aria-label': 'SOS: pause the game and get help' }, 'SOS');
        sb.addEventListener('click', () => { try { sos(); } catch (e) { console.error(e); } });
        rec.screen.el.append(sb);
      }
      if (caller) rec.screen.set('talk', `${savedLine} Make your offer.`);
      else if (again) rec.screen.set('talk', savedLine);
      S.call = rec;
    } else {
      S.call.screen.left(left);
    }
  }

  // ---- the map art: placed every frame the map draws, and every animation frame while the plane flies
  function place() {
    const map = S.mapRef;
    if (!map || S.dead) return;
    const pl = S.plane;
    if (pl) {
      const a = project(pl.path[0]);
      const b = project(pl.path[1]);
      if (a && b) {
        pathSvg.style.display = '';
        pathLine.setAttribute('x1', a[0]); pathLine.setAttribute('y1', a[1]);
        pathLine.setAttribute('x2', b[0]); pathLine.setAttribute('y2', b[1]);
        const left = pl.left - (performance.now() - pl.t0);
        const spot = planeSpot(pl.path, left);
        const xy = project(spot.p);
        const flying = left <= PLANE_FROM_MS && left >= PLANE_TO_MS - 400;
        plane.hidden = !xy || !flying;
        if (xy) {
          const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
          plane.style.setProperty('--a', `${(ang + 90).toFixed(1)}deg`);
          plane.style.transform = `translate(${xy[0].toFixed(1)}px, ${xy[1].toFixed(1)}px)`;
        }
      }
    } else {
      pathSvg.style.display = 'none';
      plane.hidden = true;
    }
    for (const c of S.crates) {
      const xy = project(c.p);
      if (!xy) continue;
      c.el.style.setProperty('--x', `${xy[0].toFixed(1)}px`);
      c.el.style.setProperty('--y', `${xy[1].toFixed(1)}px`);
    }
    for (const paw of S.paws) {
      const xy = project(paw.p);
      if (!xy) { paw.el.style.display = 'none'; continue; }
      let ang = paw.b;
      const nx = paw.next ? project(paw.next) : null;
      if (nx && (nx[0] !== xy[0] || nx[1] !== xy[1])) ang = (Math.atan2(nx[1] - xy[1], nx[0] - xy[0]) * 180) / Math.PI + 90;
      const side = paw.i % 2 ? 5 : -5;
      const r = ((ang - 90) * Math.PI) / 180 + Math.PI / 2;
      paw.el.style.display = '';
      paw.el.style.transform = `translate(${(xy[0] + Math.cos(r) * side).toFixed(1)}px, ${(xy[1] + Math.sin(r) * side).toFixed(1)}px) rotate(${ang.toFixed(1)}deg)`;
    }
  }
  function loop() {
    S.raf = 0;
    if (S.dead || !S.plane) return;
    place();
    const left = S.plane.left - (performance.now() - S.plane.t0);
    if (left > PLANE_TO_MS - 600) S.raf = requestAnimationFrame(loop);
  }

  function syncPlane(v) {
    const p = planeOf(v, S.gone);
    const key = p ? `${p.at}|${JSON.stringify(p.path)}` : '';
    if (!p) { S.plane = null; S.planeKey = ''; return; }
    if (key !== S.planeKey) {
      S.planeKey = key;
      // (never on a driver's phone, whose Driving screen it would cover, or one that's out: section 13)
      if (p.left > 0 && playsMoments(v)) gfx.play('drop-incoming', { ms: p.left, until: Date.now() + p.left });
    }
    S.plane = { ...p, t0: performance.now() };
    if (!S.raf && p.left > PLANE_TO_MS - 600) S.raf = requestAnimationFrame(loop);
  }

  function syncCrates(v) {
    const l = v && v.phase === 'live' && isObj(v.loot) ? v.loot : null;
    const boxes = l && Array.isArray(l.boxes) ? l.boxes : [];
    const ids = new Set(boxes.map((b) => b.id));
    if (S.boxIds) {
      // boxes that just landed while the plane was on: crates parachute down onto them
      const fresh = boxes.filter((b) => !S.boxIds.has(b.id) && isPoint(b.p));
      const planeNear = !!(l && isObj(l.plane));
      if (fresh.length && planeNear) {
        const thud = playsMoments(v);
        fresh.forEach((b, i) => {
          const el = crateChuteEl(doc);
          el.classList.add('cp7-crate');
          el.style.setProperty('--fall', `${CRATE_FALL_MS}ms`);
          el.style.setProperty('--d', `${i * 220}ms`);
          art.append(el);
          const rec = { el, p: b.p };
          S.crates.push(rec);
          setTimeout(() => {
            const xy = project(b.p);
            const dust = dustEl(doc);
            dust.classList.add('cp7-dust');
            if (xy) { dust.style.setProperty('--x', `${xy[0]}px`); dust.style.setProperty('--y', `${xy[1]}px`); }
            art.append(dust);
            setTimeout(() => dust.remove(), 1300);
            const at = thud && !S.dead ? toLayer(b.p) : null; // (in the moments layer's px: it starts under the top bar)
            if (at) gfx.play('crate-land', { x: at[0], y: at[1] });
          }, CRATE_FALL_MS + i * 220);
          setTimeout(() => { el.remove(); S.crates = S.crates.filter((c) => c !== rec); }, CRATE_FALL_MS + i * 220 + 1400);
        });
        if (S.mapRef && S.mapRef.redraw) S.mapRef.redraw();
      }
    }
    S.boxIds = ids;
  }

  function syncPaws(v) {
    const paths = pawPathsOf(v);
    const key = JSON.stringify(paths.map((x) => [x.id, x.pts.length, x.pts[0], x.pts[x.pts.length - 1]]));
    if (key === S.pawKey) return;
    S.pawKey = key;
    pawsBox.replaceChildren();
    S.paws = [];
    for (const path of paths) {
      const steps = pawSteps(path.pts);
      const lab = h('span.cp7-pawname', path.label || '');
      steps.forEach((s, i) => {
        const el = pawEl(doc);
        el.style.setProperty('--o', (0.35 + 0.65 * ((i + 1) / steps.length)).toFixed(2));
        el.style.setProperty('--d', `${Math.round((1600 * i) / Math.max(1, steps.length))}ms`);
        pawsBox.append(el);
        S.paws.push({ el, p: s.p, next: s.next, b: s.b, i });
      });
      void lab;
    }
    pawsBox.dataset.paws = String(S.paws.length);
    if (S.mapRef && S.mapRef.redraw) S.mapRef.redraw();
  }

  function syncEars(v) {
    const fx = (v && v.phase === 'live' && v.fx) || {};
    const e = isObj(fx.eavesdrop) && fx.eavesdrop.left - S.gone > 0 ? fx.eavesdrop : null;
    ears.hidden = !e;
    if (!e) { ears.dataset.sig = ''; return; }
    const sig = JSON.stringify(e.hands);
    const head = ears.querySelector('.cp7-ears-head b');
    if (ears.dataset.sig !== sig) {
      ears.dataset.sig = sig;
      ears.replaceChildren(
        h('p.cp7-ears-head', '👂 The hunters’ cards ', h('b')),
        h('ul.cp7-ears-list', ...(Array.isArray(e.hands) ? e.hands : []).map((x) => {
          const cards = Object.entries(isObj(x.cards) ? x.cards : {}).filter(([k, n]) => n > 0 && cardInfo(k));
          return h('li.cp7-ear', h('strong', nameIn(v, x.id) || 'Hunter'),
            cards.length ? h('span.cp7-mate-cards', ...cards.map(([k, n]) => h(`span.cp7-mini.r-${cardInfo(k).rarity}`, { 'data-card': k }, `${cardInfo(k).emoji} ${cardInfo(k).name}${n > 1 ? ` ×${n}` : ''}`))) : h('span.cp7-mate-none', 'No cards'));
        })));
    }
    text(ears.querySelector('.cp7-ears-head b') || head, fmtClock(Math.max(0, e.left - S.gone)));
  }

  function update(v, clock) {
    if (S.dead || !v) return;
    S.view = v;
    S.gone = Number.isFinite(clock) && Number.isFinite(v.clock) ? Math.max(0, clock - v.clock) : 0;
    attach();
    const looks = looksOf(v);
    const cd = doc.querySelector('.cd');
    for (const [k, on] of Object.entries(looks)) {
      root.classList.toggle(k, on);
      if (cd) cd.classList.toggle(k, on && (k === 'fx-frozen' || k === 'fx-useless'));
    }
    if (S.frozeWas && !looks['fx-frozen'] && deckButton) { try { const f = frost(deckButton, { doc }); f.crack(); } catch { /* fine */ } }
    S.frozeWas = looks['fx-frozen'];
    syncEars(v);
    syncCall(v);
    syncPlane(v);
    syncCrates(v);
    syncPaws(v);
    const seat = seatOf(v);
    seatButton.hidden = !seat.open;
  }

  // A moment's options with its map points (`at`) made screen points of the moments layer, when it plays.
  function placed(m) {
    const opts = { ...(m.opts || {}) };
    if (!Array.isArray(m.at)) return opts;
    const pts = m.at.map(toLayer).filter(Boolean);
    if (m.name === 'ping-in') opts.points = pts;
    else if (pts[0]) { opts.x = pts[0][0]; opts.y = pts[0][1]; }
    return opts;
  }

  function event(e) {
    const v = view();
    if (!v || S.dead || !e) return null;
    const d = isObj(e.data) ? e.data : {};
    // how a call ended, when its event comes after the view that ended it: the closing call screen says it
    if (e.kind === 'call' && e.to === (v.me && v.me.id) && d.state && d.state !== 'on' && S.ending && S.ending.id === d.call) {
      try { S.ending.screen.set('ended', endWordsOf(e)); } catch { /* fine */ }
    }
    const m = momentOf(e, v);
    if (!m) return null;
    if (m.name === 'drop-incoming') return m; // the plane's own countdown plays it (once per plane)
    // The caller's "A HIDER TOOK THE DEAL!" waits for their call screen to go (it would play unseen under it).
    if (m.name === 'deal' && e.kind === 'call') {
      const wait = S.ending && S.ending.id === d.call ? S.ending.until - Date.now() : S.call && S.call.id === d.call ? CALL_END_MS : 0;
      if (wait > 0) {
        const t = setTimeout(() => { S.later.delete(t); if (!S.dead) gfx.play(m.name, placed(m)); }, wait + 300);
        S.later.add(t);
        return { ...m, played: true };
      }
    }
    return { ...m, played: gfx.play(m.name, placed(m)) };
  }

  return {
    use, update, event, teamDeck, seatButton,
    marks: (v) => rewindMarksOf(v),
    destroy() {
      S.dead = true;
      if (S.raf) cancelAnimationFrame(S.raf);
      if (S.offDraw) S.offDraw();
      for (const t of S.later) clearTimeout(t);
      S.later.clear();
      if (S.call) S.call.screen.close();
      if (S.ending) { try { S.ending.screen.close(); } catch { /* fine */ } S.ending = null; }
      gfx.destroy();
      art.remove(); ears.remove(); seatButton.remove();
      for (const k of Object.keys(looksOf(null))) root.classList.remove(k);
    },
  };
}

export { sideOfCard, POWERS };
