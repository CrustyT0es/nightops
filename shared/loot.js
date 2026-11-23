// Night Ops v1.6: the Loot drops mode. Classic, plus loot boxes that drop at random spots inside the ring every few
// minutes. A free hider who walks within LOOT_PICK_M of one grabs it (one held at a time); opening it gives a fresh
// charge of one power, by its rarity. Everyone sees the boxes on the map, so
// a box is also a trap: the hunters know where hiders will run. Unclaimed boxes vanish after LOOT_LIFE_MS.
// Hunters grab boxes too (the owner: a box is something both teams race for): theirs hold a hunter power for the
// whole team. What's inside has a rarity (common, rare, legendary), shown when it bursts open.
// Pure functions over the game state; the engine calls them (lootDue, lootPickup, lootOpen, lootView).
import { distanceM, ringBounds, ringContains, outsideByM } from './geo.js?v=175';

export const LOOT_FIRST_MS = 60000;     // the first drop, this long after the head start
export const LOOT_EVERY_MS = 240000;    // then one every 4 minutes
export const LOOT_LIFE_MS = 180000;     // a box nobody grabs is gone after 3 minutes
export const LOOT_PICK_M = 20;          // grabbed within this of it (a phone's fix is rarely better)
export const LOOT_EDGE_M = 40;          // never dropped closer than this to the ring's edge
export const LOOT_MOST = 4;             // boxes in one drop at most

export function lootGame(s) { return !!s && s.settings && s.settings.mode === 'loot'; }

// How many boxes a drop has: one for every three hiders still free, at least one.
export function lootCount(hidersFree) { return Math.max(1, Math.min(LOOT_MOST, Math.ceil(hidersFree / 3))); }

// A random spot well inside the ring (rejection sampling in its bounds), or null.
export function lootSpot(ring, rand) {
  if (!ring) return null;
  const b = ringBounds(ring); // [[w, s], [e, n]]
  if (!b) return null;
  const [[w, so], [e, n]] = b;
  for (let i = 0; i < 60; i++) {
    const p = [w + (e - w) * rand(), so + (n - so) * rand()];
    if (ringContains(ring, p) && outsideByM(ring, p) <= -LOOT_EDGE_M) return [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))];
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
export function lootDrop(s, ring, clock, rand, hidersFree) {
  const L = s.loot;
  const made = [];
  for (let i = 0; i < lootCount(hidersFree); i++) {
    const p = lootSpot(ring, rand);
    if (!p) continue;
    L.n += 1;
    const box = { id: `L${L.n}`, p, at: clock, until: clock + LOOT_LIFE_MS, by: null };
    L.boxes.push(box);
    made.push(box);
  }
  L.next = clock + LOOT_EVERY_MS;
  // (old boxes go: taken or past their time, 10 minutes on, so the record stays small)
  L.boxes = L.boxes.filter((b) => clock - (b.by ? b.takenAt || b.at : b.until) < 600000);
  return made;
}

// The box a hider at `point` grabs now (free, holding nothing), or null.
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

// What a box holds, by its rarity, for the side that opens it (the owner's tables, Nov 2026). The classic powers
// (Sprint, Decoy, Jammer, Hacker, Radar, Exposure) charge the usual power; the loot-only ones (LOOT_POWERS) go into
// the opener's loot stash (a hider's own, the hunters' shared one) and are used with the `lootuse` command.
// Mythics (5%) block each other: while Blackout or the All-Seeing Eye runs, the other one waits in its stash.
export const RARITY = [['common', 0.55], ['rare', 0.30], ['legendary', 0.10], ['mythic', 0.05]];
export const RARITIES = RARITY.map(([k]) => k);
export const LOOT_TABLE = {
  hider: { common: ['sprint', 'smoke'], rare: ['decoy', 'jammer', 'glitch'], legendary: ['ghost', 'storm'], mythic: ['blackout'] },
  hunter: { common: ['hacker', 'compass'], rare: ['radar', 'double', 'freeze'], legendary: ['exposure', 'tracker'], mythic: ['eye'] },
};
// The loot-only powers. ms: how long it lasts; target: picks a hider.
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
};
export const SMOKE_R = 125;           // Smoke's cloud: 250 m across, the hider somewhere inside it
export const GHOST_PINGS = 2;
export const TRACKER_EVERY_MS = 20000;

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
// with nothing on gives the next one down, else the next one up.
export function lootPower(side, rand, allowed = null) {
  const table = LOOT_TABLE[side === 'hunter' ? 'hunter' : 'hider'];
  const ok = (k) => LOOT_POWERS[k] || !allowed || allowed.includes(k);
  const order = ['mythic', 'legendary', 'rare', 'common'];
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
  const boxes = s.loot.boxes.filter((b) => !b.by && clock >= b.at && clock < b.until).map((b) => ({ id: b.id, p: [...b.p], left: b.until - clock }));
  return {
    boxes,
    held: !!(me && me.loot),
    next: Math.max(0, s.loot.next - clock),
    last: me && me.lootLast ? { ...me.lootLast } : null,
    stash: { ...((me && (me.team === 'hunter' ? s.lootTeam : me.lootHeld)) || {}) },
    grabbed: s.loot.boxes.filter((b) => b.by).length,
  };
}
