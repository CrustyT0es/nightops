// Night Ops v1.6.4: your card collection, for life (the owner: "Add card collection for powers you got too in the
// menu"). Every card this phone has got, across games, kept on the phone (localStorage 'nightops-collection'), and a
// screen of both sides' cards: the ones you've had with how many times (×N), the rest as "?" slots.
//
//   loadCollection(storage)            { v: 1, cards: { key: { n, first } }, seen: [ids], at: { code, clock, r } }
//   countView(col, view, now)          -> true when it changed: counts the cards that newly came into this phone's
//                                       hand (a loot box opened = +1 for its card; a classic card = +1 once a round)
//   recordView(storage, view, now)     load + count + save; never throws (storage may be off, full or broken)
//   collectionOf(col)                  { sides: { hider: [slots], hunter: [slots] }, found, of }
//   collectionLine(col)                "12 of 17 cards found"
//   openCollection({ doc, storage })   the read-only screen (hold a card to see it big, like the binder)
//
// Counting never doubles on reloads or redraws: each time a card comes is an occurrence id kept in `seen` (the
// newest SEEN_MOST): "<code>#<round>|L|<box opened at>|<card>" for a box, "<code>#<round>|C|<card>" for a classic card.
// A round is told apart by its clock going back (a new round starts from 0), as the binder does.
import { h, text } from './dom.js?v=180';
import { POWERS } from '../shared/rules.js?v=180';
import { LOOT_TABLE } from '../shared/loot.js?v=180';
import { RARITY_ORDER, RARITY_WORD, cardInfo, cardEl, cardsOf, createHolder } from './cards.js?v=180';

export const COLLECTION_KEY = 'nightops-collection';
export const SEEN_MOST = 400;

const fresh = () => ({ v: 1, cards: {}, seen: [], at: { code: '', clock: 0, r: 0 } });

// Every card of a side, rarest last; the classic cards no box holds (Wiretap) after their rarity's.
export function sideKeys(side) {
  const keys = RARITY_ORDER.flatMap((r) => LOOT_TABLE[side][r]);
  for (const [k, P] of Object.entries(POWERS)) if (P && P.team === side && !keys.includes(k) && cardInfo(k)) keys.push(k);
  const order = (k) => RARITY_ORDER.indexOf((cardInfo(k) || {}).rarity || 'common');
  return keys.map((k, i) => [k, i]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(([k]) => k);
}

export function cleanCollection(raw) {
  const col = fresh();
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return col;
  if (raw.cards && typeof raw.cards === 'object') {
    for (const [k, c] of Object.entries(raw.cards)) {
      if (!cardInfo(k) || !c || typeof c !== 'object') continue;
      const n = Math.floor(Number(c.n));
      if (!(n > 0)) continue;
      col.cards[k] = { n: Math.min(n, 99999), first: Number.isFinite(c.first) ? c.first : 0 };
    }
  }
  if (Array.isArray(raw.seen)) col.seen = raw.seen.filter((x) => typeof x === 'string').slice(-SEEN_MOST);
  if (raw.at && typeof raw.at === 'object') {
    col.at = { code: String(raw.at.code || ''), clock: Number(raw.at.clock) || 0, r: Math.max(0, Math.floor(Number(raw.at.r) || 0)) };
  }
  return col;
}

export function loadCollection(storage) {
  try { return cleanCollection(JSON.parse(storage.getItem(COLLECTION_KEY) || 'null')); } catch { return fresh(); }
}
export function saveCollection(storage, col) {
  try { storage.setItem(COLLECTION_KEY, JSON.stringify(col)); return true; } catch { return false; }
}

export function countView(col, view, now = Date.now()) {
  if (!col || !view || !view.me || view.phase !== 'live') return false;
  const me = view.me;
  if (me.team !== 'hunter' && me.team !== 'hider') return false;
  const side = me.team;
  const code = String(view.code || '');
  const clock = Number(view.clock) || 0;
  let changed = false;
  // Which round: a new code, or the clock gone back (a new round starts again from 0).
  if (code !== col.at.code) { col.at = { code, clock, r: 0 }; changed = true; }
  else if (clock + 60000 < col.at.clock) { col.at = { code, clock, r: col.at.r + 1 }; changed = true; }
  else if (clock > col.at.clock + 10000) { col.at.clock = clock; changed = true; }
  const round = `${code}#${col.at.r}`;
  const seen = new Set(col.seen);
  const add = (id, key) => {
    if (seen.has(id)) return;
    seen.add(id);
    col.seen.push(id);
    const c = col.cards[key] || { n: 0, first: now };
    c.n += 1;
    col.cards[key] = c;
    changed = true;
  };
  const mark = (id) => { if (!seen.has(id)) { seen.add(id); col.seen.push(id); changed = true; } };
  // A box opened: its card, once (and a classic card it charged isn't counted again this round).
  const last = view.loot && typeof view.loot === 'object' ? view.loot.last : null;
  if (last && typeof last.power === 'string' && Number.isFinite(last.at)) {
    const info = cardInfo(last.power);
    if (info && info.team === side) {
      add(`${round}|L|${last.at}|${last.power}`, last.power);
      if (POWERS[last.power]) mark(`${round}|C|${last.power}`);
    }
  }
  // The classic cards in your hand now: once a round each.
  for (const c of cardsOf(view)) if (c.classic && (cardInfo(c.key) || {}).team === side) add(`${round}|C|${c.key}`, c.key);
  if (col.seen.length > SEEN_MOST) col.seen = col.seen.slice(-SEEN_MOST);
  return changed;
}

export function recordView(storage, view, now = Date.now()) {
  try {
    if (!storage) return false;
    const col = loadCollection(storage);
    if (!countView(col, view, now)) return false;
    return saveCollection(storage, col);
  } catch { return false; }
}

export function collectionOf(col) {
  const c = (col && col.cards) || {};
  const sides = {};
  let found = 0;
  let of = 0;
  for (const side of ['hider', 'hunter']) {
    sides[side] = sideKeys(side).map((key) => {
      const n = c[key] ? c[key].n : 0;
      of += 1;
      if (n) found += 1;
      return { key, rarity: (cardInfo(key) || {}).rarity || 'common', n, found: n > 0, classic: !!POWERS[key] };
    });
  }
  return { sides, found, of };
}

export function collectionLine(col) {
  const { found, of } = collectionOf(col);
  return `${found} of ${of} cards found`;
}

function localStore(W) { try { return W.localStorage; } catch { return null; } }
function stillMotion(doc) {
  try { return doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---- the screen ------------------------------------------------------------------------------------------------

export function openCollection({ doc = globalThis.document, storage = undefined, onClose = null } = {}) {
  const W = doc.defaultView || globalThis;
  const store = storage === undefined ? localStore(W) : storage;
  const col = store ? loadCollection(store) : fresh();
  const all = collectionOf(col);
  const opener = doc.activeElement;
  let L = null;
  let sel = null;
  const holder = createHolder({ doc, layer: () => L, onPick: (key) => select(key) });

  const nameEl = h('strong.cd-pick-name');
  const lineEl = h('p.cd-pick-line');
  const bar = h('div.cd-bar.cl-bar', h('div.cd-pick', nameEl, lineEl));
  const slotsOf = Object.values(all.sides).flat();

  function select(key) {
    sel = key;
    for (const b of L ? L.querySelectorAll('.cd-slot') : []) {
      const on = b.dataset.key === key;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const slot = slotsOf.find((s) => s.key === key) || null;
    const info = slot ? cardInfo(slot.key) : null;
    bar.dataset.rarity = slot ? slot.rarity : '';
    if (!slot) { text(nameEl, all.found ? 'Tap a card' : 'No cards yet'); text(lineEl, all.found ? 'Hold a card to see it big.' : 'Every card you get in a game lands here. Grab loot boxes to find more.'); }
    else if (!slot.found) { text(nameEl, 'Not found yet'); text(lineEl, `A ${RARITY_WORD[slot.rarity].toLowerCase()} ${info.team} card. Get it in a game to see it here.`); }
    else { text(nameEl, `${info.name} ×${slot.n}`); text(lineEl, info.line); }
  }

  function label(slot) {
    const info = cardInfo(slot.key);
    if (!slot.found) return `Not found yet: a ${RARITY_WORD[slot.rarity].toLowerCase()} ${info.team} card`;
    return `${info.name}, ${RARITY_WORD[slot.rarity]}, got ${slot.n} ${slot.n === 1 ? 'time' : 'times'}`;
  }

  function section(side) {
    const slots = all.sides[side];
    const got = slots.filter((s) => s.found).length;
    const grid = h('div.cd-grid', { role: 'group', 'aria-label': side === 'hunter' ? 'Hunter cards' : 'Hider cards' });
    slots.forEach((slot, i) => {
      const btn = h(`button.cd-slot.r-${slot.rarity}${slot.found ? '' : '.unfound'}`, {
        type: 'button', 'data-key': slot.key, 'aria-pressed': 'false', 'aria-label': label(slot),
      }, cardEl(slot.key, { empty: !slot.found, rarity: slot.rarity }));
      if (slot.found) btn.append(h('span.cl-n', `×${slot.n}`));
      btn.style.setProperty('--i', String(i));
      holder.bind(btn, slot);
      grid.append(btn);
    });
    return h(`section.cl-side.s-${side}`, { 'data-side': side },
      h('h3.cl-side-title', h('span', side === 'hunter' ? 'Hunter cards' : 'Hider cards'), h('span.cl-side-n', `${got} / ${slots.length}`)),
      grid);
  }

  function keys(e) {
    if (!L) return;
    if (e.key === 'Escape') { e.preventDefault(); if (holder.zoomed()) holder.putBack(); else close(); }
  }

  function close() {
    if (!L) return;
    holder.drop();
    const el = L;
    L = null;
    el.classList.add('out');
    doc.removeEventListener('keydown', keys, true);
    setTimeout(() => el.remove(), stillMotion(doc) ? 0 : 300);
    try { if (opener && opener.isConnected) opener.focus({ preventScroll: true }); } catch { /* fine */ }
    if (onClose) { try { onClose(); } catch { /* fine */ } }
  }

  const pct = all.of ? Math.round((all.found / all.of) * 100) : 0;
  const shut = h('button.cd-x', { type: 'button', 'aria-label': 'Close the card collection' }, '✕');
  shut.addEventListener('click', () => close());
  const meter = h('div.cl-meter', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(all.of), 'aria-valuenow': String(all.found), 'aria-label': 'Cards found' },
    h('i.cl-fill'));
  meter.querySelector('.cl-fill').style.width = `${pct}%`;
  L = h('div.cd.cl', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cl-title' },
    h('div.cd-back', { 'aria-hidden': 'true' }),
    h('header.cd-head', h('div.cd-head-w',
      h('h2#cl-title.cd-title', 'Card collection'),
      h('p.cd-sub', h('span.cl-found', `${all.found} / ${all.of} found`)),
      meter), shut),
    h('div.cd-scroll', section('hider'), section('hunter'),
      h('p.cd-tip', 'Hold a card to see it big. Every card you get in a game counts, on this phone.')),
    bar);
  L.querySelector('.cd-back').addEventListener('click', () => close());
  L.addEventListener('touchmove', (e) => { if (holder.zoomed() && e.cancelable) e.preventDefault(); }, { passive: false });
  doc.body.appendChild(L);
  L.classList.add('in', 'dealing');
  setTimeout(() => { if (L) L.classList.remove('dealing'); }, 1400);
  doc.addEventListener('keydown', keys, true);
  select(null);
  try { shut.focus({ preventScroll: true }); } catch { /* fine */ }
  return { close, el: L };
}
