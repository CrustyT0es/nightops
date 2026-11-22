// Night Ops v1.6: the Loot drops mode. Classic, plus loot boxes that drop at random spots inside the ring every few
// minutes. A free hider who walks within LOOT_PICK_M of one grabs it (one held at a time); opening it gives a fresh
// charge of one power, by its rarity. Everyone sees the boxes on the map, so
// a box is also a trap: the hunters know where hiders will run. Unclaimed boxes vanish after LOOT_LIFE_MS.
// Hunters grab boxes too (the owner: a box is something both teams race for): theirs hold a hunter power for the
// whole team. What's inside has a rarity (common, rare, legendary), shown when it bursts open.
// Pure functions over the game state; the engine calls them (lootDue, lootPickup, lootOpen, lootView).
import { distanceM, ringBounds, ringContains, outsideByM } from './geo.js?v=161';

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

// What a box holds, by its rarity (the owner's pick: common 60%, rare 30%, legendary 10%), for the side that opens it.
// The most powerful power is the legendary one (the owner: "have the most OP ones be legendary"):
//   hunters: Exposure (every hider's exact spot, no warning) > Radar (live for a minute, after a warning) > Hacker
//            (an alarm on one phone, no spot)
//   hiders:  Jammer (skips a whole ping and blocks Radar) > Decoy (one ping in the wrong place) > Sprint (pings show
//            where you started: still close by)
export const RARITY = [['common', 0.6], ['rare', 0.3], ['legendary', 0.1]];
export const LOOT_TABLE = {
  hider: { common: 'sprint', rare: 'decoy', legendary: 'jammer' },
  hunter: { common: 'hacker', rare: 'radar', legendary: 'exposure' },
};
export function rarityOf(r) {
  let acc = 0;
  for (const [name, p] of RARITY) { acc += p; if (r < acc) return name; }
  return 'common';
}
// -> { power, rarity }. A power switched off in the settings gives the next one down that's on, else the next one up;
// with none on, still the common one (the box is the point of the mode).
export function lootPower(side, rand, allowed = null) {
  const table = LOOT_TABLE[side === 'hunter' ? 'hunter' : 'hider'];
  const order = ['legendary', 'rare', 'common'];
  const ok = (k) => !allowed || allowed.includes(table[k]);
  const i = order.indexOf(rarityOf(rand()));
  const tries = [...order.slice(i), ...order.slice(0, i).reverse()];
  const rarity = tries.find(ok) || 'common';
  return { power: table[rarity], rarity };
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
    grabbed: s.loot.boxes.filter((b) => b.by).length,
  };
}
