// Night Ops v1.6: the Loot drops mode. Classic, plus loot boxes that drop at random spots inside the ring every few
// minutes. A free hider who walks into a box's 5 m circle (LOOT_PICK_M) grabs it (one held at a time); opening it
// gives a fresh charge of one power, by its rarity. Everyone sees the boxes (and their circles) on the map, so
// a box is also a trap: the hunters know where hiders will run. Unclaimed boxes vanish after LOOT_LIFE_MS.
// Hunters grab boxes too (the owner: a box is something both teams race for): theirs hold a hunter power for the
// whole team. What's inside has a rarity (common, rare, legendary), shown when it bursts open.
// Pure functions over the game state; the engine calls them (lootDue, lootPickup, lootOpen, lootView).
//
// v1.7 (the card overhaul; CONTRACT.md "v1.7: the card overhaul"): 36 cards, 18 a side, in five tiers: common 50%,
// rare 22%, epic 15% (new, between rare and legendary: an emerald frame), legendary 10%, mythic 3%; inside a tier
// every card is as likely as the others. Grab bag, Multiplier and Duplicator come in a hider version and a hunter
// version (two keys each, two slots in the collection). This file is the cards' data: the tables, the odds, the
// words and the numbers every lane shares. What a card does is the engine's (engine.js), as the contract says.
import { distanceM, ringBounds, ringContains, outsideByM } from './geo.js?v=181';

export const LOOT_FIRST_MS = 60000;     // the first drop, this long after the head start
export const LOOT_EVERY_MS = 240000;    // then one every 4 minutes
export const LOOT_LIFE_MS = 180000;     // a box nobody grabs is gone after 3 minutes
// Picking a box up (the owner, Nov 2026: "you have to go within 5 m of the loot drop to pick it up", and the map shows
// that circle). A phone's fix is a spot plus a margin (acc, metres): the phone is probably within acc of the spot.
// The rule: the fix's own spot is within LOOT_PICK_M of the box, and its margin is no worse than LOOT_ACC_MAX_M.
//  - Not a margin of 5 m too: a good phone outdoors says 3-10 m, and 10-20 m between houses or under trees at
//    night, so most fixes would never count and a hider standing on the box could wait for ever.
//  - Not any margin: past about 25 m the spot comes from wifi or phone masts and jumps about; one of those landing
//    on the box by luck must never grab it from 30 m away.
// The spot wobbles by a few metres from fix to fix (one every 3 s or so), so someone standing in the circle grabs
// it within a few seconds, and someone walking past outside it doesn't.
export const LOOT_PICK_M = 10;          // the box's circle: a fix whose spot is this close grabs it (v1.7: 10 m, was 5)
export const LOOT_ACC_MAX_M = 25;       // ...when the fix's margin is no worse than this
export const LOOT_EDGE_M = 40;          // never dropped closer than this to the ring's edge
export const LOOT_MOST = 4;             // boxes in one drop at most

export function lootGame(s) { return !!s && s.settings && s.settings.mode === 'loot'; }

// How many boxes a drop has: one for every three hiders still free, at least one.
export function lootCount(hidersFree) { return Math.max(1, Math.min(LOOT_MOST, Math.ceil(hidersFree / 3))); }

// A random spot well inside the ring (rejection sampling in its bounds), or null. Fix (Nov 2026, the owner's live game:
// a 50 m ring made no boxes at all): the margin from the edge shrinks with the ring (LOOT_EDGE_M, then 20, 8, 0 m),
// so a small ring still gets its boxes; null only when there is no ring.
export const LOOT_EDGES_M = Object.freeze([LOOT_EDGE_M, 20, 8, 0]);
export function spotFits(ring, p, edge = 0) {
  return !!ring && !!p && ringContains(ring, p) && outsideByM(ring, p) <= -edge;
}
// The margins to try for a ring: LOOT_EDGES_M, but never more than 15% of the ring's width (a 100 m ring keeps
// crates 15 m in, not 40 m, which left only its middle).
export function edgesFor(ring) {
  const b = ring && ringBounds(ring);
  if (!b) return LOOT_EDGES_M;
  const [[w, so], [e, n]] = b;
  const across = Math.min(distanceM([w, so], [e, so]), distanceM([w, so], [w, n]));
  return [...new Set(LOOT_EDGES_M.map((x) => Math.min(x, Math.round(across * 0.15))))];
}
export function lootSpot(ring, rand) {
  if (!ring) return null;
  const b = ringBounds(ring); // [[w, s], [e, n]]
  if (!b) return null;
  const [[w, so], [e, n]] = b;
  for (const edge of edgesFor(ring)) {
    for (let i = 0; i < 80; i++) {
      const p = [w + (e - w) * rand(), so + (n - so) * rand()];
      if (spotFits(ring, p, edge)) return [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))];
    }
  }
  return null;
}

// The state's loot record, made on first use: { next (clock of the next drop), n (ids), boxes: [] }.
export function lootOf(s, headStartMs) {
  if (!s.loot || typeof s.loot !== 'object' || !Array.isArray(s.loot.boxes)) {
    s.loot = { next: headStartMs + LOOT_FIRST_MS, n: 0, boxes: [] };
  }
  return s.loot;
}

// A drop: boxes at random spots, and the next drop's time. -> the new boxes
// v1.7: `spots` (the plane picked them 10 s before: one no longer LOOT_EDGE_M inside the ring is picked again) and
// `every` (dropEveryMs: the Drops setting and the players) are optional; without them it's v1.6's drop.
export function lootDrop(s, ring, clock, rand, hidersFree, { spots = null, every = LOOT_EVERY_MS } = {}) {
  const L = s.loot;
  const made = [];
  const n = Array.isArray(spots) && spots.length ? spots.length : lootCount(hidersFree); // (never zero boxes)
  for (let i = 0; i < n; i++) {
    const planned = Array.isArray(spots) ? spots[i] : null;
    const fits = planned && spotFits(ring, planned, 0); // (the plane picked it inside the ring 10 s ago)
    const p = fits ? [planned[0], planned[1]] : lootSpot(ring, rand);
    if (!p) continue;
    L.n += 1;
    const box = { id: `L${L.n}`, p, at: clock, until: clock + LOOT_LIFE_MS, by: null };
    L.boxes.push(box);
    made.push(box);
  }
  L.next = clock + every;
  // (old boxes go: taken or past their time, 10 minutes on, so the record stays small)
  L.boxes = L.boxes.filter((b) => clock - (b.by ? b.takenAt || b.at : b.until) < 600000);
  return made;
}

// The box a player at `point` grabs now (inside its circle), or null. (The fix's margin is the engine's check.)
export function lootNear(s, point, clock) {
  if (!s.loot || !Array.isArray(s.loot.boxes)) return null;
  let best = null;
  for (const b of s.loot.boxes) {
    if (b.by || clock >= b.until || clock < b.at) continue;
    const d = distanceM(point, b.p);
    if (d <= LOOT_PICK_M && (!best || d < best.d)) best = { box: b, d };
  }
  return best ? best.box : null;
}

// What a box holds, by its rarity, for the side that opens it. The classic powers (Sprint, Decoy, Jammer, Hacker,
// Radar, Exposure, Wiretap) charge the usual power; the loot-only ones (LOOT_POWERS) go into the opener's loot stash
// (v1.6: a hider's own, the hunters' shared one; v1.7: everyone's own) and are used with the `lootuse` command.
// Mythics block each other: while Blackout or the All-Seeing Eye runs, the other one waits in its stash.
// v1.7: the owner's tables and odds of Nov 2026 (final). Inside a tier the owner's order, which is also the
// binder's. Wiretap (a classic power) is in the hunters' rare tier now; it only comes out of a box while a free
// hider has said OK to it (the engine's rule: CONTRACT.md v1.7). One line a side: test_nightopsvideo.py reads them.
export const RARITY = [['common', 0.50], ['rare', 0.22], ['epic', 0.15], ['legendary', 0.10], ['mythic', 0.03]];
export const RARITIES = RARITY.map(([k]) => k);
export const LOOT_TABLE = {
  hider: { common: ['sprint', 'smoke', 'lucky', 'headsup', 'stall', 'eavesdrop', 'grabbag_hider'], rare: ['decoy', 'jammer', 'swap', 'lookout'], epic: ['glitch', 'mirror', 'ghost'], legendary: ['storm', 'multiplier_hider', 'duplicator_hider'], mythic: ['blackout'] },
  hunter: { common: ['hacker', 'compass', 'hound', 'quickping', 'scout', 'rewind', 'grabbag_hunter'], rare: ['radar', 'double', 'useless', 'wiretap'], epic: ['snitch', 'freeze', 'tracker'], legendary: ['exposure', 'multiplier_hunter', 'duplicator_hunter'], mythic: ['eye'] },
};
// The loot-only powers: every card that isn't a classic power (rules.js POWERS has those). ms: how long it lasts
// (before a Multiplier); target: picks a free hider (Snitch: or none, for a random one); pick: picks one of your own
// cards (`card`); offer: Snitch's deal (`offer`, SNITCH_OFFERS); mythic: never runs with another mythic. `line` is
// what the card says, kid-simple.
export const LOOT_POWERS = {
  smoke: { team: 'hider', name: 'Smoke', emoji: '🌫️', line: 'Your next ping is a big cloud of smoke: they get a direction, never your spot.' },
  glitch: { team: 'hider', name: 'Glitch', emoji: '👾', ms: 60000, line: "The hunters' phones go buggy for a minute. They won't know it's you." },
  ghost: { team: 'hider', name: 'Ghost', emoji: '👻', line: "You don't show up on the next 2 pings." },
  storm: { team: 'hider', name: 'Static Storm', emoji: '📺', ms: 120000, line: "The hunters' map turns to TV static for 2 minutes." },
  blackout: { team: 'hider', name: 'Blackout', emoji: '🌑', ms: 300000, mythic: true, line: "The hunters' screens go black for 5 minutes. Only their walkie works." },
  compass: { team: 'hunter', name: 'Compass', emoji: '🧭', ms: 30000, line: 'An arrow points to the nearest hider for 30 seconds.' },
  double: { team: 'hunter', name: 'Double Double', emoji: '⏩', line: 'The next 2 pings come twice as fast.' },
  freeze: { team: 'hunter', name: 'Freeze', emoji: '🧊', ms: 180000, line: "The hiders' powers are frozen for 3 minutes." },
  tracker: { team: 'hunter', name: 'Tracker dart', emoji: '🎯', ms: 120000, target: true, line: "One hider's spot updates every 20 seconds for 2 minutes. They're warned." },
  eye: { team: 'hunter', name: 'All-Seeing Eye', emoji: '🔮', ms: 120000, mythic: true, line: 'Every hider shows live for 2 minutes. No warning, nothing blocks it.' },
  // v1.7: the hiders' new cards
  lucky: { team: 'hider', name: 'Lucky', emoji: '🍀', line: 'Your next loot box gives you 2 cards.' },
  headsup: { team: 'hider', name: 'Heads up', emoji: '🔔', ms: 180000, line: 'For 3 minutes your phone buzzes when a hunter gets within 200 m.' },
  stall: { team: 'hider', name: 'Stall', emoji: '⏳', line: 'Your next ping comes 1 minute late, so they keep looking at your old spot.' },
  eavesdrop: { team: 'hider', name: 'Eavesdrop', emoji: '👂', line: "See every hunter's cards right now." },
  grabbag_hider: { team: 'hider', name: 'Grab bag', emoji: '🎒', line: 'Get a random common card right now.' },
  swap: { team: 'hider', name: 'Swap', emoji: '🎲', line: "Trade one of your cards for one of a teammate's, at random." },
  lookout: { team: 'hider', name: 'Lookout', emoji: '🔦', ms: 15000, line: 'Every hunter shows up live on your map for 15 seconds.' },
  mirror: { team: 'hider', name: 'Mirror', emoji: '🪞', ms: 180000, line: 'For 3 minutes: if they can see you, you can see them. Cards aimed at you bounce off.' },
  multiplier_hider: { team: 'hider', name: 'Multiplier', emoji: '✖️', pick: true, line: 'Boost one of your cards by 25% to 100%.' },
  duplicator_hider: { team: 'hider', name: 'Duplicator', emoji: '🧬', pick: true, line: 'Get a second copy of one of your cards.' },
  // v1.7: the hunters' new cards
  hound: { team: 'hunter', name: 'Hound dog', emoji: '🐕', ms: 120000, line: "Every hider's trail from the last 3 minutes shows as paw prints for 2 minutes." },
  quickping: { team: 'hunter', name: 'Quick ping', emoji: '⏱️', line: 'The next ping comes 1 minute sooner.' },
  scout: { team: 'hunter', name: 'Scout', emoji: '🔭', line: 'Find out how many hiders are within 200 m of you.' },
  rewind: { team: 'hunter', name: 'Rewind', emoji: '⏪', ms: 30000, line: "The ping before last comes back for 30 seconds: see which way they're going." },
  grabbag_hunter: { team: 'hunter', name: 'Grab bag', emoji: '🎒', line: 'Get a random common card right now.' },
  useless: { team: 'hunter', name: 'Useless', emoji: '🚫', ms: 300000, target: true, line: "Pick a hider: their cards don't work for 5 minutes." },
  snitch: { team: 'hunter', name: 'Snitch', emoji: '🕵️', target: true, offer: true, line: 'Call a hider and offer them a deal to give up a teammate.' },
  multiplier_hunter: { team: 'hunter', name: 'Multiplier', emoji: '✖️', pick: true, line: 'Boost one of your cards by 25% to 100%.' },
  duplicator_hunter: { team: 'hunter', name: 'Duplicator', emoji: '🧬', pick: true, line: 'Get a second copy of one of your cards.' },
};
export const SMOKE_R = 125;           // Smoke's cloud: 250 m across, the hider somewhere inside it
export const GHOST_PINGS = 2;
export const TRACKER_EVERY_MS = 20000;

// ---- v1.7: the cards' shared data (CONTRACT.md "v1.7: the card overhaul" says what each card does) -------------
// Every card of a side in tier order (rarest last), the table's order inside a tier: the binder's order.
export const CARD_KEYS = Object.freeze({
  hider: Object.freeze(RARITIES.flatMap((r) => LOOT_TABLE.hider[r])),
  hunter: Object.freeze(RARITIES.flatMap((r) => LOOT_TABLE.hunter[r])),
});
export const ALL_CARDS = Object.freeze([...CARD_KEYS.hider, ...CARD_KEYS.hunter]);
// The three cards both sides have, as two cards each (a blue hider one and a red hunter one: their own keys, words
// and collection slots). cardBase(key): the card a version belongs to ('grabbag'), for one effect in both colours.
export const BOTH_SIDES = Object.freeze({
  grabbag: Object.freeze({ hider: 'grabbag_hider', hunter: 'grabbag_hunter' }),
  multiplier: Object.freeze({ hider: 'multiplier_hider', hunter: 'multiplier_hunter' }),
  duplicator: Object.freeze({ hider: 'duplicator_hider', hunter: 'duplicator_hunter' }),
});
export function cardBase(key) {
  for (const [base, v] of Object.entries(BOTH_SIDES)) if (v.hider === key || v.hunter === key) return base;
  return key;
}
// Which side a card is on ('hider' | 'hunter'), or null when it's no card.
export function sideOfCard(key) {
  if (CARD_KEYS.hider.includes(key)) return 'hider';
  if (CARD_KEYS.hunter.includes(key)) return 'hunter';
  return null;
}

// Multiplier: what a boost of `pct` (BOOST_LEAST..BOOST_MOST in BOOST_STEPs) does to each card. Not here = it can't
// be boosted: the instant cards, Wiretap (its hider agreed to 15 s), Multiplier and Duplicator themselves.
//   'time'   it lasts ms x (1 + pct/100): Radar its live minute, Sprint its 2 min, Hound dog its paws' 2 min
//   'count'  the pings it covers (COUNTS), one more at BOOST_COUNT_AT or more: Jammer 2, Ghost 3, Smoke 2, Double Double 3
//   'shift'  the ping moves further: STALL_MS or QUICK_MS x (1 + pct/100)
//   'decoy'  after its first fake it keeps fooling pings for DECOY_BOOST_MS x pct/100, the fake spot walking slowly
export const BOOST = Object.freeze({
  sprint: 'time', smoke: 'count', headsup: 'time', stall: 'shift', decoy: 'decoy', jammer: 'count', lookout: 'time',
  glitch: 'time', mirror: 'time', ghost: 'count', storm: 'time', blackout: 'time',
  compass: 'time', hound: 'time', quickping: 'shift', rewind: 'time', radar: 'time', double: 'count', useless: 'time',
  freeze: 'time', tracker: 'time', eye: 'time',
});
export const COUNTS = Object.freeze({ jammer: 1, smoke: 1, ghost: GHOST_PINGS, double: 2 });
export const BOOST_LEAST = 25;
export const BOOST_MOST = 100;
export const BOOST_STEP = 5;
export const BOOST_COUNT_AT = 50;      // a 'count' card covers one more ping from this boost up
export const boostable = (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(BOOST, key);
// The boost a Multiplier gives: 25, 30, ... 100, each as likely (one rand() call).
export function boostRoll(rand) {
  const steps = Math.floor((BOOST_MOST - BOOST_LEAST) / BOOST_STEP) + 1;
  const v = Number(rand());
  const i = Number.isFinite(v) ? Math.max(0, Math.min(steps - 1, Math.floor(v * steps))) : 0;
  return BOOST_LEAST + i * BOOST_STEP;
}
const pctOf = (pct) => (Number.isFinite(pct) ? Math.max(0, Math.min(BOOST_MOST, pct)) : 0);
// A 'time' or 'shift' card's ms with its boost (to the second); a 'count' card's pings with its boost.
export const boostedMs = (ms, pct) => Math.round((ms * (1 + pctOf(pct) / 100)) / 1000) * 1000;
export const boostedCount = (n, pct) => n + (pctOf(pct) >= BOOST_COUNT_AT ? 1 : 0);

// The numbers the new cards use (ms of game clock, metres).
export const HEADSUP_M = 200;           // Heads up: a hunter (a driver too) this close buzzes your phone...
export const HEADSUP_GAP_MS = 15000;    // ...at most once in this long (each hunter once per Heads up)
export const STALL_MS = 60000;          // Stall: you're pinged on your own this long after the ping you're left out of
export const QUICK_MS = 60000;          // Quick ping: the next ping comes this much sooner...
export const QUICK_LEAST_MS = 10000;    // ...but never sooner than this from now
export const SCOUT_M = 200;             // Scout: the free hiders within this of you
export const HOUND_LOOK_MS = 180000;    // Hound dog: the trail from this far back (the paws then show for its ms)
export const EAVESDROP_SHOW_MS = 30000; // Eavesdrop: the hunters' hands stay on your screen this long
export const DECOY_BOOST_MS = 300000;   // a boosted Decoy keeps fooling pings for this x pct/100 after its first...
export const WALK_MPS = 1.2;            // ...its fake spot walking this fast, like a person (never two pins)
export const SNITCH_CALL_MS = 45000;    // Snitch: the call lasts this long
export const SNITCH_FLASH_MS = 30000;   // ...and the teammate given up shows on the hunters' map this long
// Snitch's deals: the hunter picks one (the list stays open for more later). 'safe': the snitch is left out of the
// next ping, like a Jammer.
export const SNITCH_OFFERS = Object.freeze([
  Object.freeze({ key: 'card', label: 'A random loot card', line: 'Give up a teammate and get a random card.' }),
  Object.freeze({ key: 'safe', label: 'A safe next ping', line: "Give up a teammate and you're left out of the next ping." }),
]);

// The drop plane: its flight path shows this long before the crates land.
export const PLANE_LEAD_MS = 10000;
export const PLANE_PAD_M = 300;                         // the path starts and ends this far outside the ring
export const PLANE_OFFSET_M = Object.freeze([40, 140]); // it passes this far from the drop's middle: it never points at a spot
export const PLANE_LAND_MS = 4000;                      // the plane stays in the view this long after the crates land

// How often boxes drop: the "Drops" setting (lobby and vote). 'normal' goes by the players in the round (hiders and
// hunters, drivers too, counted at each drop): 2-5 a drop every 4 min, 6-9 every 3, 10 or more every 2.5.
export const DROPS = Object.freeze(['few', 'normal', 'lots']);
export const DROPS_DEFAULT = 'normal';
export const DROPS_UI = Object.freeze([
  Object.freeze({ value: 'few', label: 'Few', line: 'A drop every 5 minutes.' }),
  Object.freeze({ value: 'normal', label: 'Normal', line: 'Every 4 minutes, more often with more players.' }),
  Object.freeze({ value: 'lots', label: 'Lots', line: 'A drop every 2 minutes.' }),
]);
export function dropEveryMs(drops, players) {
  if (drops === 'few') return 300000;
  if (drops === 'lots') return 120000;
  const n = Number.isFinite(players) ? players : 0;
  return n >= 10 ? 150000 : n >= 6 ? 180000 : 240000;
}

export function rarityOf(r) {
  let acc = 0;
  for (const [name, p] of RARITY) { acc = Math.round((acc + p) * 1000) / 1000; if (r < acc) return name; }
  return 'common';
}
export function rarityOfPower(side, power) {
  const table = LOOT_TABLE[side === 'hunter' ? 'hunter' : 'hider'];
  return RARITIES.find((k) => table[k].includes(power)) || null;
}
// -> { power, rarity }. `allowed` (the game's classic powers that are on) never blocks a loot-only power; a rarity
// with nothing on gives the next one down, else the next one up. v1.7: `allowed` may be a function instead,
// (key) -> may it drop now, asked of every card (the engine's rules on top: Wiretap only while a free hider has said
// OK to it).
export function lootPower(side, rand, allowed = null) {
  const table = LOOT_TABLE[side === 'hunter' ? 'hunter' : 'hider'];
  const ok = typeof allowed === 'function' ? (k) => !!allowed(k) : (k) => LOOT_POWERS[k] || !allowed || allowed.includes(k);
  const order = [...RARITIES].reverse(); // mythic first
  const i = order.indexOf(rarityOf(rand()));
  const tries = [...order.slice(i), ...order.slice(0, i).reverse()];
  for (const rarity of tries) {
    const list = table[rarity].filter(ok);
    if (list.length) return { power: list[Math.min(list.length - 1, Math.floor(rand() * list.length))], rarity };
  }
  return { power: table.common.find((k) => LOOT_POWERS[k]) || table.common[0], rarity: 'common' };
}

// What a phone sees: the boxes on the ground now, whether it holds one, the next drop's time, its last loot.
export function lootView(s, me, clock) {
  if (!lootGame(s) || !s.loot) return null;
  const boxes = s.loot.boxes.filter((b) => !b.by && clock >= b.at && clock < b.until).map((b) => ({ id: b.id, p: [...b.p], left: b.until - clock, r: LOOT_PICK_M }));
  return {
    boxes,
    held: !!(me && me.loot),
    next: Math.max(0, s.loot.next - clock),
    last: me && me.lootLast ? { ...me.lootLast } : null,
    // (v1.7: every card is its holder's; `stash` stays "the loot-only cards I can play" for older screens)
    stash: Object.fromEntries(Object.entries((me && me.lootHeld) || {}).filter(([k, n]) => LOOT_POWERS[k] && n > 0)),
    grabbed: s.loot.boxes.filter((b) => b.by).length,
  };
}
