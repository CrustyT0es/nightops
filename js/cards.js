// Night Ops v1.6.3: the cards. One look for every card in the game (your collection, the loot box's opening, the
// card-played effects), so it all feels like one game: a collectible card in the night-sticker style, its frame in
// the rarity's colour (common silver, rare violet, v1.7 epic emerald, legendary gold, mythic rainbow), the art tinted by its side
// (hiders blue, hunters red), a foil shine that follows your finger or the phone's tilt.
//
//   cardInfo(key)                 { key, team, name, line, emoji, rarity } or null
//   cardEl(key, opts)             a card element (.nc). opts: n (the ×2 sticker), full (its words on it), back (a back
//                                 to flip to), empty (a "?" slot: not found yet), spent (found, none left), rarity
//   cardsOf(view)                 the cards this phone can play now: [{ key, n, classic, rarity }]
//   binderOf(view, found)         the collection: { side, slots: [{ key, rarity, n, found, classic }], found, of, held }
//   cardFxOf(e, view)             what a card-played event shows on this phone (pure; null = nothing), from the
//                                 engine's own events, which already go only to who may know (engine-cards.test):
//                                 'self' (you played it), 'team' (a teammate did: "Liam played GLITCH"), 'them' (it's
//                                 on you: "RADAR!"). Secret cards never reach the other side, so they never show.
//   createCardFx({ root, doc })   -> { play(fx) -> true if it will show, bug(), destroy() }: the effects. Never in the
//                                 way: nothing on them takes a tap, they sit under the top bar (SOS stays in sight),
//                                 and none show on the SOS screen.
//   createCardDeck({ app, onClassic, useLoot, doc }) -> { button, update(view), open(), close() }: the tray's cards
//                                 button and your collection (a binder: every card of your side, the ones you haven't
//                                 found yet as "?"; hold one to see it big; tap to pick it; Use it plays it).
import { h, text } from './dom.js?v=179';
import { POWERS } from '../shared/rules.js?v=179';
import { LOOT_POWERS, LOOT_TABLE, RARITIES, rarityOfPower } from '../shared/loot.js?v=179';
import { cardTheme, themeKey, fxSound } from './fx.js?v=179';

// (v1.7: the tiers come from shared/loot.js: common, rare, epic, legendary, mythic)
export const RARITY_ORDER = [...RARITIES];
export const RARITY_WORD = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', mythic: 'Mythic' };
const EMOJI = { jammer: '📵', decoy: '🎭', sprint: '🏃', radar: '📡', exposure: '👁️', hacker: '🚨', wiretap: '🎧' };
export const HOLD_MS = 280;         // hold a card this long and it comes up big
export const FX_MS = { self: 2600, team: 2700, them: 2600, small: 2600, bug: 650 };
const STILL_MS = { self: 1400, team: 2400, them: 2200, small: 2400 };
// v1.7: the two versions of the cards both sides have, each in its own words (the hider one blue, the hunter one red).
const OWN_LINE = {
  grabbag_hider: 'Get a random common hider card right now.',
  grabbag_hunter: 'Get a random common hunter card right now.',
  multiplier_hider: 'Boost one of your hider cards by 25% to 100%: it lasts longer.',
  multiplier_hunter: 'Boost one of your hunter cards by 25% to 100%: it lasts longer.',
  duplicator_hider: 'Get a second copy of one of your hider cards.',
  duplicator_hunter: 'Get a second copy of one of your hunter cards.',
};

export function cardInfo(key) {
  const P = Object.prototype.hasOwnProperty.call(POWERS, key) ? POWERS[key] : null;
  const L = Object.prototype.hasOwnProperty.call(LOOT_POWERS, key) ? LOOT_POWERS[key] : null;
  if (!P && !L) return null;
  const team = (P || L).team;
  return { key, team, name: (P || L).name, line: OWN_LINE[key] || (P ? P.desc : L.line), emoji: L ? L.emoji : EMOJI[key] || '⭐', rarity: rarityOfPower(team, key) || 'rare', art: themeKey(key) };
}

// What a teammate's card does, said about them (the card's own words say "you").
const TEAM_LINE = {
  sprint: 'Their pings show where they started, for 2 min.',
  decoy: 'Their next ping is a fake, far away.',
  jammer: 'They skip the next ping.',
  smoke: 'Their next ping is a big cloud.',
  ghost: "They're gone from the next 2 pings.",
  glitch: "The hunters' phones go buggy for a minute.",
  storm: "The hunters' map is TV static for 2 min.",
  blackout: "The hunters' screens go black for 5 min.",
  radar: 'Every hider shows live for 1 min, in 15 s.',
  exposure: 'Exact spots for every hider, right now.',
  hacker: (t) => (t ? `${t}'s phone is blaring an alarm.` : "A hider's phone is blaring an alarm."),
  wiretap: (t) => (t ? `Listening in on ${t} for 15 s.` : 'Listening in on a hider for 15 s.'),
  compass: 'An arrow to the nearest hider, for 30 s.',
  double: 'The next 2 pings come twice as fast.',
  freeze: "The hiders' powers are frozen for 3 min.",
  tracker: (t) => (t ? `${t}'s spot updates every 20 s, for 2 min.` : "A hider's spot updates every 20 s, for 2 min."),
  eye: 'Every hider shows live for 2 min.',
  // v1.7
  lucky: 'Their next loot box gives 2 cards.',
  headsup: 'Their phone buzzes when a hunter is near, for 3 min.',
  stall: 'Their next ping comes 1 minute late.',
  eavesdrop: "They peeked at the hunters' cards.",
  grabbag_hider: 'They got a random common card.',
  swap: (t) => (t ? `They swapped a card with ${t}.` : 'They swapped a card with a teammate.'),
  lookout: 'They can see every hunter for 15 s.',
  mirror: 'For 3 min, cards aimed at them bounce off.',
  multiplier_hider: 'They boosted one of their cards.',
  duplicator_hider: 'They copied one of their cards.',
  hound: "Every hider's trail shows as paw prints for 2 min.",
  quickping: 'The next ping comes 1 minute sooner.',
  scout: 'They counted the hiders near them.',
  rewind: 'The ping before last is back for 30 s.',
  grabbag_hunter: 'They got a random common card.',
  useless: (t) => (t ? `${t}'s cards don't work for 5 min.` : "A hider's cards don't work for 5 min."),
  snitch: 'Calling a hider with a deal...',
  multiplier_hunter: 'They boosted one of their cards.',
  duplicator_hunter: 'They copied one of their cards.',
};
// The cards the other side is meant to notice, and what their phones say (the event's own words are the line).
const THEM = {
  radar: { title: 'RADAR!' },
  exposure: { title: 'EXPOSED!', line: 'The hunters just saw your exact spot. Move!' },
  hacker: { title: 'HACKER!', small: true },
  wiretap: { title: 'WIRETAP!', small: true },
  freeze: { title: 'FROZEN!' },
  double: { title: 'DOUBLE PINGS!' },
  tracker: { title: 'TRACKER DART!' },
  storm: { title: 'STATIC STORM!' },
  glitch: { title: 'GLITCH INCOMING!' },
  blackout: { title: 'BLACKOUT!' },
  // v1.7: the hunters' cards the hiders are told about (Useless: only the hider it's on)
  hound: { title: 'SNIFFED OUT!' },
  quickping: { title: 'PING COMING SOONER!' },
  useless: { title: 'USELESS!', line: "Your cards don't work for 5 minutes." },
};

const nameOf = (view, id) => {
  const p = (view && Array.isArray(view.players) ? view.players : []).find((x) => x && x.id === id);
  return p && p.name ? p.name : '';
};
const upper = (s) => String(s || '').toUpperCase();

export function cardFxOf(e, view) {
  if (!e || !view || !view.me || view.phase !== 'live') return null;
  const me = view.me;
  if (me.driver || me.status !== 'in' || (me.team !== 'hunter' && me.team !== 'hider')) return null;
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  let power = null;
  switch (e.kind) {
    case 'power': case 'lootfx': power = d.power; break;
    case 'loot-queued': if (e.to !== me.id) return null; power = d.power; break;
    case 'radar': case 'exposure': if (e.to !== 'hiders') return null; power = e.kind; break;
    default: return null;
  }
  const info = typeof power === 'string' ? cardInfo(power) : null;
  if (!info) return null;
  // v1.7: a Snitch call's news after it was played (a deal done: `on`; no deal: `state`) is no new card played: the
  // banner and the deal moment say it (as a card effect it showed "Ava played SNITCH" again and hid the words)
  if (power === 'snitch' && e.kind === 'lootfx' && (d.on || d.state)) return null;
  const at = Number.isFinite(e.clock) ? e.clock : 0;
  const data = { ...d };
  if (d.got && cardInfo(d.got)) data.gotName = cardInfo(d.got).name;
  if (d.with) data.withName = nameOf(view, d.with);
  if (Array.isArray(d.hands)) data.hands = d.hands.map((x) => ({ ...x, name: x && x.id ? nameOf(view, x.id) : 'Hunter' }));
  data.meName = me.name || 'You';
  const base = { power, card: info, side: info.team, rarity: info.rarity, data, key: `${power}|${d.by || ''}|${at}` };
  const others = Array.isArray(view.events) ? view.events : [];
  const alsoToMe = (kind, extra = () => true) => others.some((x) => x && x.kind === kind && x.to === me.id && x.clock === e.clock && extra(x));
  if (e.kind === 'loot-queued') {
    return { ...base, key: `${power}|${me.id}|${at}`, who: 'self', tone: 'play', kicker: 'You played', title: `${upper(info.name)}!`, line: String(e.text || info.line) };
  }
  // (a Hacker or Wiretap a Jammer stopped: its own words say so, "...but it was blocked.")
  const blockedWords = d.blocked && e.text ? String(e.text) : '';
  if (d.by && d.by === me.id) {
    let line = blockedWords || info.line;
    if (!blockedWords && Number.isFinite(d.pct) && d.card && cardInfo(d.card)) line = `${cardInfo(d.card).name} +${Math.round(d.pct)}%!`;
    else if (!blockedWords && d.got && cardInfo(d.got)) line = `You got ${cardInfo(d.got).name}!`;
    else if (!blockedWords && power === 'scout' && Number.isFinite(d.n)) line = `${d.n} ${d.n === 1 ? 'hider' : 'hiders'} within ${d.m || 200} m of you.`;
    return { ...base, who: 'self', tone: 'play', kicker: 'You played', title: `${upper(info.name)}!`, line };
  }
  const myTeam = me.team === 'hunter' ? 'hunter' : 'hider';
  if (info.team === myTeam) {
    if (!d.by) return null;
    const who = nameOf(view, d.by) || 'Your teammate';
    const tl = TEAM_LINE[power];
    let line = blockedWords || (typeof tl === 'function' ? tl(nameOf(view, d.target || d.with)) : tl || info.line);
    if (!blockedWords && Number.isFinite(d.pct) && d.card && cardInfo(d.card)) line = `${cardInfo(d.card).name} +${Math.round(d.pct)}%!`;
    else if (!blockedWords && power === 'scout' && Number.isFinite(d.n)) line = `${d.n} ${d.n === 1 ? 'hider' : 'hiders'} within ${d.m || 200} m of them.`;
    else if (!blockedWords && power === 'swap' && d.with === me.id && d.gave && d.got && cardInfo(d.gave) && cardInfo(d.got)) line = `They swapped with you: you gave ${cardInfo(d.gave).name} and got ${cardInfo(d.got).name}.`;
    return { ...base, who: 'team', tone: 'play', kicker: `${who} played`, title: upper(info.name), line };
  }
  // On me (the other side's card). Only the ones meant to be noticed: everything else never even reaches this phone.
  const T = THEM[power];
  if (!T) return null;
  if ((power === 'tracker' || power === 'useless') && d.target !== me.id) return null;
  if ((power === 'radar' || power === 'exposure') && e.kind === 'power') return null; // they come by their own events
  if (e.kind === 'power' && d.blocked) return null;
  const by = info.team === 'hunter' ? 'The hunters played' : 'The hiders played';
  // A Jammer that keeps me hidden turns the alarm into good news.
  const safe = (power === 'radar' && view.radar && view.radar.safe === true)
    || (power === 'exposure' && alsoToMe('exposure'))
    || ((power === 'hacker' || power === 'wiretap') && alsoToMe('power', (x) => x.data && x.data.blocked));
  if (safe) return { ...base, who: 'them', tone: 'safe', small: !!T.small, kicker: `${by} ${info.name}`, title: 'BLOCKED!', line: power === 'radar' ? 'Your Jammer hides you from it.' : 'Your Jammer kept you hidden.' };
  // The hider Hacker or Wiretap is on has their own alarm or microphone screen.
  if (power === 'hacker' && alsoToMe('hacked')) return null;
  if (power === 'wiretap' && alsoToMe('tap')) return null;
  return { ...base, who: 'them', tone: 'alert', small: !!T.small, kicker: by, title: T.title, line: T.line || String(e.text || info.line) };
}

// ---- the cards a phone holds, and its collection ------------------------------------------------------------

export function cardsOf(view) {
  const out = [];
  if (!view || !view.me) return out;
  const hunter = view.me.team === 'hunter';
  const L7 = view.phase === 'live' && view.loot && typeof view.loot === 'object' && view.loot.hand && typeof view.loot.hand === 'object' ? view.loot : null;
  if (L7) { // v1.7: every card I hold, classic ones too, with their boosts
    for (const [k, n] of Object.entries(L7.hand)) {
      if (!cardInfo(k) || !(n > 0)) continue;
      const b = L7.boosts && Array.isArray(L7.boosts[k]) ? L7.boosts[k].filter(Number.isFinite) : [];
      out.push({ key: k, n, classic: !!POWERS[k] && !LOOT_POWERS[k], boost: b.length ? Math.max(...b) : 0 });
    }
  } else if (hunter) {
    for (const k of ['radar', 'exposure', 'hacker', 'wiretap']) if (view.team && view.team[k] === 'ready') out.push({ key: k, n: 1, classic: true });
  } else {
    for (const [k, v] of Object.entries(view.me.powers || {})) if (v === 'ready' && POWERS[k]) out.push({ key: k, n: 1, classic: true });
  }
  const l = !L7 && view.phase === 'live' && view.loot && typeof view.loot === 'object' ? view.loot : null;
  for (const [k, n] of Object.entries((l && l.stash) || {})) if (LOOT_POWERS[k] && n > 0) out.push({ key: k, n, classic: false });
  const order = (r) => RARITY_ORDER.length - 1 - Math.max(0, RARITY_ORDER.indexOf(r)); // mythic first
  for (const c of out) c.rarity = (cardInfo(c.key) || {}).rarity || 'common';
  return out.sort((a, b) => order(a.rarity) - order(b.rarity) || a.key.localeCompare(b.key));
}

// Every card of your side in rarity order (the rarest last), whether you've found it, and how many you hold.
export function binderOf(view, found = []) {
  const side = view && view.me && view.me.team === 'hunter' ? 'hunter' : 'hider';
  const held = new Map(cardsOf(view).map((c) => [c.key, c]));
  const seen = new Set(found);
  const keys = RARITY_ORDER.flatMap((r) => LOOT_TABLE[side][r]);
  for (const k of held.keys()) if (!keys.includes(k)) keys.push(k);
  const slots = keys.map((key) => {
    const c = held.get(key);
    return { key, rarity: (cardInfo(key) || {}).rarity || 'common', n: c ? c.n : 0, boost: c && c.boost ? c.boost : 0, classic: c ? c.classic : !LOOT_POWERS[key], found: !!c || seen.has(key) };
  });
  return { side, slots, found: slots.filter((s) => s.found).length, of: slots.length, held: slots.reduce((a, s) => a + s.n, 0) };
}

// ---- one card ---------------------------------------------------------------------------------------------------

export function cardEl(key, { n = 0, full = false, back = false, empty = false, spent = false, rarity = null, boost = 0 } = {}) {
  const info = cardInfo(key) || { key, team: 'hider', name: String(key || '?'), line: '', emoji: '⭐', rarity: 'common' };
  const r = RARITY_WORD[rarity] ? rarity : info.rarity;
  const longest = Math.max(...String(info.name).split(/\s+/).map((w) => w.length));
  const el = h(`div.nc.r-${r}.s-${info.team}.a-${info.art || themeKey(info.key)}${longest >= 9 ? '.long' : ''}${full ? '.full' : ''}${empty ? '.empty' : ''}${spent ? '.spent' : ''}`, { 'data-card': info.key, 'aria-hidden': 'true' });
  const inner = h('div.nc-in');
  if (empty) {
    inner.append(h('div.nc-face.nc-blank', h('span.nc-sil'), h('span.nc-q', '?'), h('span.nc-rw', RARITY_WORD[r])));
  } else {
    if (back) {
      for (let i = 0; i < 4; i++) { const e = h('i.nc-edge'); e.style.setProperty('--z', `${-(i + 1) * 0.12}em`); inner.append(e); }
      inner.append(h('div.nc-face.nc-back', h('span.card-moon'), h('b.card-logo', 'NIGHT', h('br'), 'OPS')));
    }
    inner.append(h('div.nc-face.nc-front',
      h('span.nc-mythic'),
      h('div.nc-art', h('span.nc-bg'), h('span.nc-stars'), h('span.nc-halo'), h('span.nc-deco'), h('span.nc-emoji', info.emoji)),
      h('span.nc-gem'),
      h('strong.nc-name', info.name),
      full ? h('p.nc-line', info.line) : null,
      h('span.nc-rw', RARITY_WORD[r]),
      h('span.nc-holo', h('i.nc-foil'), h('i.nc-glare'), h('i.nc-sweep'))));
  }
  el.append(inner);
  if (spent && !empty) el.append(h('span.nc-used', 'Used'));
  if (n > 1) el.append(h('span.nc-n', `×${n}`));
  if (boost > 0 && !empty) el.append(h('span.nc-boost', `+${Math.round(boost)}%`));
  return el;
}

function stillMotion(doc) {
  try { return doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
function vibrate(ms) {
  try { const nav = globalThis.navigator; if (nav && typeof nav.vibrate === 'function') nav.vibrate(ms); } catch { /* fine */ }
}

// ---- the effects ------------------------------------------------------------------------------------------------

const SHARDS = 16;
const pick = (list, i) => list[i % list.length];

export function createCardFx({ root, doc = globalThis.document } = {}) {
  const layer = h('div.cfx', { 'aria-hidden': 'true' });
  const live = h('p.sr-only.cfx-said', { role: 'status' });
  (root || doc.body).append(layer, live);
  const Q = [];
  let busy = false;
  let dead = false;
  let timer = null;

  function build(fx) {
    const r = fx.rarity || 'common';
    const s = fx.side === 'hunter' ? 'hunter' : 'hider';
    const words = (cls) => h(`div.${cls}`, h('p.cfx-k', fx.kicker || ''), h('p.cfx-t', fx.title || ''), fx.line ? h('p.cfx-l', fx.line) : null);
    if (fx.who === 'self') {
      const shards = h('div.cfx-shards');
      for (let i = 0; i < SHARDS; i++) {
        const sh = h('i.cfx-shard');
        sh.style.setProperty('--a', `${Math.round((360 / SHARDS) * i + pick([0, 9, -7, 4], i))}deg`);
        sh.style.setProperty('--d', `${pick([150, 210, 120, 260, 180], i)}px`);
        sh.style.setProperty('--r', `${pick([1, -1], i) * pick([220, 300, 160, 410], i)}deg`);
        sh.style.setProperty('--s', pick(['1', '.7', '1.3', '.85'], i));
        shards.append(sh);
      }
      return h(`div.cfx-self.r-${r}.s-${s}`, h('div.cfx-glow'), h('div.cfx-flash'), h('div.cfx-ring'), h('div.cfx-ring.two'), shards,
        h('div.cfx-fly', cardEl(fx.power, { back: true, rarity: r })), words('cfx-words'));
    }
    if (fx.who === 'team' || fx.small) {
      return h(`div.cfx-team.s-${s}.r-${r}.t-${fx.tone || 'play'}${fx.who === 'them' ? '.on-me' : ''}`,
        h('div.cfx-mini', cardEl(fx.power, { rarity: r })), words('cfx-team-w'));
    }
    return h(`div.cfx-them.s-${s}.r-${r}.t-${fx.tone || 'alert'}`, h('div.cfx-dim'), h('div.cfx-edge'),
      h('div.cfx-tape.top'), h('div.cfx-tape.bot'),
      h('div.cfx-them-in', h('p.cfx-k', fx.kicker || ''), h('p.cfx-t', fx.title || ''),
        h('div.cfx-spin', cardEl(fx.power, { back: true, rarity: r })), fx.line ? h('p.cfx-l', fx.line) : null));
  }

  function next() {
    const fx = Q.shift();
    if (!fx || dead) { busy = false; return; }
    busy = true;
    const still = stillMotion(doc);
    const kind = fx.who === 'self' ? 'self' : fx.who === 'team' ? 'team' : fx.small ? 'small' : 'them';
    const el = build(fx);
    if (still) el.classList.add('still');
    // v1.7: the card's own themed effect (fx.js) under the card and its words
    const theme = cardTheme(fx, doc, { card: (k) => (cardInfo(k) ? cardEl(k) : null) });
    if (theme) { el.classList.add('themed'); el.prepend(theme.el); fxSound(theme.sound, doc); }
    layer.append(el);
    text(live, [fx.kicker, fx.title, fx.line].filter(Boolean).join(' '));
    if (theme && theme.buzz) vibrate(theme.buzz); else if (fx.who === 'self') vibrate([30, 40, 90]);
    timer = setTimeout(() => { el.remove(); next(); }, still ? STILL_MS[kind] : FX_MS[kind]);
  }

  function play(fx) {
    if (dead || !fx || (doc.visibilityState && doc.visibilityState === 'hidden')) return false;
    if (Q.length >= 2) return false;
    Q.push(fx);
    if (!busy) next();
    return true;
  }

  // Glitch on a hunter's phone: the screen tears for a moment, like a broken phone (no words: it's never a "power").
  function bug() {
    if (dead || stillMotion(doc)) return;
    const el = h('div.cfx-bug');
    for (let i = 0; i < 7; i++) {
      const sl = h('i');
      sl.style.setProperty('--t', `${Math.round(Math.random() * 92)}%`);
      sl.style.setProperty('--h', `${1 + Math.round(Math.random() * 5)}%`);
      sl.style.setProperty('--x', `${Math.round((Math.random() - 0.5) * 60)}px`);
      sl.style.setProperty('--c', pick(['rgba(255,40,120,.5)', 'rgba(40,255,240,.45)', 'rgba(0,0,0,.8)', 'rgba(255,255,255,.3)'], i));
      el.append(sl);
    }
    el.append(h('b.cfx-scan'));
    layer.append(el);
    setTimeout(() => el.remove(), FX_MS.bug);
  }

  return {
    play,
    bug,
    busy: () => busy,
    destroy() { dead = true; clearTimeout(timer); Q.length = 0; layer.remove(); live.remove(); },
  };
}

// ---- the foil: a finger on the card (or the phone tilting) moves its shine and turns it -------------------------

// Sets --mx/--my (0-1, where the light is) and --rx/--ry (the tilt) on `el` from a point over `box`.
export function tiltFrom(el, box, x, y, most = 16) {
  const px = Math.max(0, Math.min(1, (x - box.left) / Math.max(1, box.width)));
  const py = Math.max(0, Math.min(1, (y - box.top) / Math.max(1, box.height)));
  el.style.setProperty('--mx', px.toFixed(3));
  el.style.setProperty('--my', py.toFixed(3));
  el.style.setProperty('--ry', `${((px - 0.5) * 2 * most).toFixed(2)}deg`);
  el.style.setProperty('--rx', `${((0.5 - py) * 2 * most).toFixed(2)}deg`);
}

// The phone's tilt moves every card's shine on `el` (Android gives it without asking; an iPhone needs a tap's
// permission, which a collection is not worth asking for, so it simply never comes there). -> off()
function tiltShine(el, W) {
  if (!W || typeof W.addEventListener !== 'function' || !('DeviceOrientationEvent' in W)) return () => {};
  let base = null;
  let raf = 0;
  let last = null;
  const on = (e) => {
    if (!Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
    if (!base) base = { b: e.beta, g: e.gamma };
    last = e;
    if (raf) return;
    raf = W.requestAnimationFrame(() => {
      raf = 0;
      const gx = Math.max(-1, Math.min(1, (last.gamma - base.g) / 30));
      const by = Math.max(-1, Math.min(1, (last.beta - base.b) / 30));
      el.style.setProperty('--mx', (0.5 + gx / 2).toFixed(3));
      el.style.setProperty('--my', (0.5 + by / 2).toFixed(3));
    });
  };
  W.addEventListener('deviceorientation', on);
  return () => { W.removeEventListener('deviceorientation', on); if (raf) W.cancelAnimationFrame(raf); };
}

// ---- hold a card: it comes up big from its slot with its words, turning with the finger ----------------------
// Shared by the in-round binder and the lifetime collection (collection.js). layer() is the open screen (the big
// card goes in it); onPick(key) is a tap, or a hold let go. -> { bind(btn, slot), putBack(), drop(), zoomed() }
export function createHolder({ doc = globalThis.document, layer, onPick = null } = {}) {
  const W = doc.defaultView || globalThis;
  const S = { zoom: null, timers: [] };
  const still = () => stillMotion(doc);
  function later(fn, ms) { const t = setTimeout(fn, ms); S.timers.push(t); return t; }
  function inspect(slot, btn) {
    if (S.zoom || !layer()) return;
    const big = cardEl(slot.key, { n: slot.n, full: slot.found, empty: !slot.found, spent: slot.found && !slot.n, rarity: slot.rarity });
    const holder = h('div.cd-zoom-card', big);
    const zoom = h('div.cd-zoom', { 'aria-hidden': 'true' }, h('div.cd-zoom-dim'), holder);
    layer().append(zoom);
    // (where the big card sits, untouched: it grows from its slot to there, and shrinks back the same way)
    const to = holder.getBoundingClientRect();
    S.zoom = { el: zoom, holder, big, btn, to };
    btn.classList.add('lifted');
    vibrate(12);
    if (!still()) {
      holder.style.transform = fromSlot(btn, to);
      void holder.offsetWidth;
    }
    zoom.classList.add('on');
    holder.style.transform = '';
  }
  function fromSlot(btn, to) {
    const from = btn.getBoundingClientRect();
    const k = to.width ? from.width / to.width : 1;
    return `translate(${Math.round(from.left + from.width / 2 - (to.left + to.width / 2))}px, ${Math.round(from.top + from.height / 2 - (to.top + to.height / 2))}px) scale(${k.toFixed(3)})`;
  }
  function putBack() {
    const z = S.zoom;
    if (!z) return;
    S.zoom = null;
    z.el.classList.remove('on');
    if (!still() && z.btn.isConnected) {
      z.big.style.setProperty('--rx', '0deg');
      z.big.style.setProperty('--ry', '0deg');
      z.holder.style.transform = fromSlot(z.btn, z.to);
    }
    later(() => { z.el.remove(); z.btn.classList.remove('lifted'); }, still() ? 0 : 260);
  }
  let rafTilt = 0;
  let tiltAt = null;
  function tiltTo(x, y) {
    tiltAt = { x, y };
    if (rafTilt || !S.zoom || still()) return;
    rafTilt = W.requestAnimationFrame(() => {
      rafTilt = 0;
      const z = S.zoom;
      if (!z || !tiltAt) return;
      tiltFrom(z.big, z.btn.getBoundingClientRect(), tiltAt.x, tiltAt.y, 18);
    });
  }

  function bindSlot(btn, slot) {
    let timer = 0;
    let start = null;
    let hover = 0;
    let byHover = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      clearTimeout(timer);
      clearTimeout(hover);
      if (byHover) return;
      timer = setTimeout(() => {
        if (!start) return;
        try { btn.setPointerCapture(start.id); } catch { /* fine */ }
        inspect(slot, btn);
        tiltTo(start.x, start.y);
      }, HOLD_MS);
    });
    btn.addEventListener('pointermove', (e) => {
      if (S.zoom && S.zoom.btn === btn) { tiltTo(e.clientX, e.clientY); return; }
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { clearTimeout(timer); start = null; }
    });
    const end = (picked) => {
      clearTimeout(timer);
      start = null;
      if (S.zoom && S.zoom.btn === btn && !byHover) {
        putBack();
        if (picked && onPick) onPick(slot.key); // (a finger held this long gets no click: holding it picks it too)
      }
    };
    // A finger holding a big card: moving up or down tilts it instead of scrolling (pan-y would cancel the hold).
    btn.addEventListener('touchmove', (e) => { if (S.zoom && S.zoom.btn === btn && e.cancelable) e.preventDefault(); }, { passive: false });
    btn.addEventListener('pointerup', () => end(true));
    btn.addEventListener('pointercancel', () => end(false));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    // A mouse: resting on a card brings it up too (and moving off puts it back).
    btn.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(hover);
      hover = setTimeout(() => { if (!S.zoom) { byHover = true; inspect(slot, btn); tiltTo(e.clientX, e.clientY); } }, 420);
    });
    btn.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(hover);
      if (byHover) { byHover = false; if (S.zoom && S.zoom.btn === btn) putBack(); }
    });
    btn.addEventListener('click', () => { if (onPick) onPick(slot.key); });
  }

  return {
    bind: bindSlot,
    putBack,
    drop() { if (S.zoom) { S.zoom.el.remove(); S.zoom.btn.classList.remove('lifted'); S.zoom = null; } },
    zoomed: () => !!S.zoom,
  };
}

// ---- your collection --------------------------------------------------------------------------------------------

const FOUND_KEY = 'nightops-cards-found';

export function createCardDeck({ app, onClassic = null, useLoot = null, below = null, doc = globalThis.document } = {}) {
  // v1.7: `below(view)` -> an element under your cards (the hunters' team deck), drawn again with them
  const W = doc.defaultView || globalThis;
  const count = h('span.cd-n', { 'aria-hidden': 'true' });
  const stack = h('span.cd-stack', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const button = h('button.tray-sq.cd-btn', { type: 'button', 'aria-label': 'Your cards' }, stack, count);
  const S = { view: null, layer: null, sel: null, sig: '', found: new Set(), code: '', clock: 0, zoom: null, untilt: null, grid: null, bar: null, timers: [] };
  button.addEventListener('click', () => open());

  // The cards you've had this round (kept through a reload: a new round starts again, as its clock goes back).
  try {
    const was = JSON.parse(W.sessionStorage.getItem(FOUND_KEY) || 'null');
    if (was && typeof was.code === 'string' && Array.isArray(was.keys)) { S.code = was.code; S.clock = Number(was.clock) || 0; S.found = new Set(was.keys.filter((k) => typeof k === 'string')); }
  } catch { /* fine */ }
  function remember(view) {
    const code = String((view && view.code) || '');
    const clock = Number(view && view.clock) || 0;
    if (code !== S.code || clock + 60000 < S.clock) { S.found = new Set(); S.code = code; }
    let changed = clock - S.clock > 10000;
    S.clock = Math.max(S.clock, clock);
    const add = (k) => { if (typeof k === 'string' && cardInfo(k) && !S.found.has(k)) { S.found.add(k); changed = true; } };
    for (const c of cardsOf(view)) add(c.key);
    const last = view && view.loot && view.loot.last;
    if (last && cardInfo(last.power) && cardInfo(last.power).team === (view.me && view.me.team === 'hunter' ? 'hunter' : 'hider')) add(last.power);
    if (changed) { try { W.sessionStorage.setItem(FOUND_KEY, JSON.stringify({ code: S.code, clock: S.clock, keys: [...S.found] })); } catch { /* fine */ } }
  }
  // A card you played stays found (game.js tells us when your own card-played effect shows).
  function played(key) { if (cardInfo(key)) S.found.add(key); }

  const still = () => stillMotion(doc);
  function later(fn, ms) { const t = setTimeout(fn, ms); S.timers.push(t); return t; }

  function frozenWhy(slot) {
    const fx = (S.view && S.view.fx) || {};
    const info = cardInfo(slot.key);
    if (info && info.team === 'hider' && fx.freeze) return 'Frozen: the hunters froze your cards.';
    if (info && info.team === 'hunter' && fx.blackout) return 'Blackout: no cards until it ends.';
    if (S.view && S.view.me && S.view.me.driver) return "The driver can't use cards. They wait for you."; // v1.7
    if (Number.isFinite(fx.useless) && fx.useless > 0) return `Useless: your cards don't work for ${Math.ceil(fx.useless / 60000)} min.`; // v1.7
    return '';
  }

  // ---- the binder
  function slotLabel(slot) {
    const info = cardInfo(slot.key);
    if (!slot.found) return `Not found yet: a ${RARITY_WORD[slot.rarity].toLowerCase()} card`;
    const many = slot.n > 1 ? `, ${slot.n} of them` : slot.n === 1 ? '' : ', used';
    return `${info.name}, ${RARITY_WORD[slot.rarity]}${many}`;
  }
  function paintBar() {
    if (!S.bar) return;
    const slot = S.slots.find((x) => x.key === S.sel) || null;
    const info = slot ? cardInfo(slot.key) : null;
    const nameEl = S.bar.querySelector('.cd-pick-name');
    const lineEl = S.bar.querySelector('.cd-pick-line');
    const use = S.bar.querySelector('.cd-use');
    let why = '';
    if (!slot) { text(nameEl, S.binder.held ? 'Pick a card' : 'No cards yet'); text(lineEl, S.binder.held ? 'Tap a card to pick it. Hold it to see it big.' : 'Race to a loot box on the map. Every card comes out of one.'); }
    else if (!slot.found) { text(nameEl, 'Not found yet'); text(lineEl, `A ${RARITY_WORD[slot.rarity].toLowerCase()} card. Grab loot boxes to find it.`); }
    else {
      text(nameEl, `${info.name}${slot.n > 1 ? ` ×${slot.n}` : ''}${slot.boost ? ` · +${Math.round(slot.boost)}%` : ''}`); // v1.7: a boost
      why = slot.n ? frozenWhy(slot) : '';
      text(lineEl, !slot.n ? 'Used. Find another in a loot box.' : why || info.line);
    }
    S.bar.dataset.rarity = slot ? slot.rarity : '';
    const can = !!(slot && slot.found && slot.n > 0 && !why);
    use.disabled = !can;
    use.setAttribute('aria-label', slot && slot.found && slot.n ? `Use ${info.name}` : 'Use');
  }
  function select(key, focus = false) {
    S.sel = key;
    for (const b of S.grid ? S.grid.querySelectorAll('.cd-slot') : []) {
      const on = b.dataset.key === key;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on && focus) { try { b.focus({ preventScroll: true }); } catch { /* fine */ } }
    }
    paintBar();
  }

  // ---- hold a card: it comes up big, turning with your finger (shared with the lifetime collection)
  const holder = createHolder({ doc, layer: () => S.layer, onPick: (key) => select(key) });
  const bindSlot = holder.bind;

  function keys(e) {
    if (!S.layer) return;
    if (e.key === 'Escape') { e.preventDefault(); if (holder.zoomed()) holder.putBack(); else close(); return; }
    const all = [...S.grid.querySelectorAll('.cd-slot')];
    const i = all.indexOf(doc.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key];
    if (!step) return;
    e.preventDefault();
    const j = Math.max(0, Math.min(all.length - 1, i + step));
    try { all[j].focus({ preventScroll: false }); } catch { /* fine */ }
  }

  async function useSel() {
    const slot = S.slots.find((x) => x.key === S.sel);
    if (!slot || !slot.found || !slot.n || frozenWhy(slot)) return;
    const btn = S.grid && S.grid.querySelector(`.cd-slot[data-key="${slot.key}"]`);
    if (btn) btn.classList.add('playing');
    vibrate(20);
    await new Promise((r) => setTimeout(r, still() ? 0 : 420));
    close();
    try {
      if (slot.classic) { if (onClassic) onClassic(slot.key); } else if (useLoot) await useLoot(slot.key);
    } catch (e) { console.error(e); }
  }

  function close() {
    const L = S.layer;
    if (!L) return;
    holder.drop();
    S.layer = null;
    S.grid = null;
    S.bar = null;
    if (S.untilt) { S.untilt(); S.untilt = null; }
    L.classList.add('out');
    doc.removeEventListener('keydown', keys, true);
    setTimeout(() => L.remove(), still() ? 0 : 300);
    try { button.focus({ preventScroll: true }); } catch { /* fine */ }
  }

  // The binder's slots and its "N of 8 found" (again, in place, when your hand changes while it's open).
  function fill() {
    const b = binderOf(S.view, [...S.found]);
    S.binder = b;
    S.slots = b.slots;
    holder.drop();
    text(S.layer.querySelector('.cd-found'), ` · ${b.found} of ${b.of} found`);
    text(S.layer.querySelector('.cd-tip'), b.held ? 'Hold a card to see it big. Tap to pick it.' : 'Every card comes out of a loot box.');
    S.grid.replaceChildren(...b.slots.map((slot, i) => {
      const btn = h(`button.cd-slot.r-${slot.rarity}${slot.found ? '' : '.unfound'}${slot.found && !slot.n ? '.spent' : ''}`, {
        type: 'button', 'data-key': slot.key, 'aria-pressed': 'false', 'aria-label': slotLabel(slot),
      }, cardEl(slot.key, { n: slot.n, empty: !slot.found, spent: slot.found && !slot.n, rarity: slot.rarity, boost: slot.boost }));
      btn.style.setProperty('--i', String(i));
      bindSlot(btn, slot);
      return btn;
    }));
    const team = S.layer.querySelector('.cd-team');
    if (team) {
      let el = null;
      try { el = below ? below(S.view) : null; } catch (e) { console.error(e); }
      team.replaceChildren(...(el ? [el] : []));
      team.hidden = !el;
    }
    const held = b.slots.filter((x) => x.n > 0);
    const keep = b.slots.find((x) => x.key === S.sel && x.found);
    select(keep ? keep.key : held.length ? held[0].key : null);
  }

  function open() {
    if (S.layer) return;
    const side = S.view && S.view.me && S.view.me.team === 'hunter' ? 'hunter' : 'hider';
    const r = button.getBoundingClientRect ? button.getBoundingClientRect() : null;
    const grid = h('div.cd-grid', { role: 'group', 'aria-label': 'Your cards' });
    const title = h('h2#cd-title.cd-title', 'Your cards');
    const sub = h('p.cd-sub', h('span.cd-side', side === 'hunter' ? 'Hunter cards' : 'Hider cards'), h('span.cd-found'));
    const shut = h('button.cd-x', { type: 'button', 'aria-label': 'Close your cards' }, '✕');
    shut.addEventListener('click', () => close());
    const use = h('button.btn.cd-use', { type: 'button' }, 'Use it');
    use.addEventListener('click', () => useSel());
    const bar = h('div.cd-bar', h('div.cd-pick', h('strong.cd-pick-name'), h('p.cd-pick-line')), use);
    const L = h(`div.cd.side-${side}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cd-title' },
      h('div.cd-back', { 'aria-hidden': 'true' }),
      h('header.cd-head', h('div.cd-head-w', title, sub), shut),
      h('div.cd-scroll', grid, h('p.cd-tip'), h('div.cd-team', { hidden: true })),
      bar);
    L.querySelector('.cd-back').addEventListener('click', () => close());
    // A finger on a big card shouldn't scroll the binder underneath it.
    L.addEventListener('touchmove', (e) => { if (holder.zoomed() && e.cancelable) e.preventDefault(); }, { passive: false });
    doc.body.appendChild(L);
    S.layer = L;
    S.grid = grid;
    S.bar = bar;
    fill();
    // The cards fly out of the cards button into their slots.
    if (r && !still()) {
      for (const btn of grid.children) {
        const s = btn.getBoundingClientRect();
        btn.style.setProperty('--dx', `${Math.round(r.left + r.width / 2 - (s.left + s.width / 2))}px`);
        btn.style.setProperty('--dy', `${Math.round(r.top + r.height / 2 - (s.top + s.height / 2))}px`);
      }
    }
    L.classList.add('in', 'dealing');
    later(() => L.classList.remove('dealing'), 1400); // (a hand that changes while it's open is drawn again in place)
    S.untilt = tiltShine(grid, W);
    doc.addEventListener('keydown', keys, true);
    const first = grid.querySelector('.cd-slot.sel') || shut;
    try { first.focus({ preventScroll: true }); } catch { /* fine */ }
  }

  function update(view) {
    S.view = view;
    remember(view);
    const cards = cardsOf(view);
    const n = cards.reduce((a, c) => a + c.n, 0);
    let sig = cards.map((c) => `${c.key}${c.n}+${c.boost || 0}`).join(',');
    if (below && view && view.loot && Array.isArray(view.loot.deck)) sig += `|${JSON.stringify(view.loot.deck)}`; // v1.7: the team deck changed
    const fx = (view && view.fx) || {};
    sig += `|${!!fx.freeze}${!!fx.blackout}${!!fx.useless}`;
    text(count, String(n));
    count.hidden = !n;
    button.classList.toggle('some', n > 0);
    const loot = !!(view && view.phase === 'live' && view.loot);
    button.hidden = !loot;
    button.setAttribute('aria-label', n ? `Your cards: ${n}` : 'Your cards: none yet');
    if (sig !== S.sig) {
      if (S.sig && n > 0 && S.sig.split('|')[0] !== sig.split('|')[0]) { button.classList.remove('new'); void button.offsetWidth; button.classList.add('new'); }
      S.sig = sig;
      // Open and the hand changed (a teammate played a card from the team's hand): draw it again where it was.
      if (S.layer) fill();
    }
  }

  return { button, update, open, close, played, isOpen: () => !!S.layer };
}
