// Night Ops v1.6: the game screen's Loot drops parts.
//
//   lootOf(view)              view.loot while a Loot drops game is on, else null
//   lootEffect(e, view)       what a loot event does on this phone (game.js's effectOf hands loot events here)
//   nextDropIn(view, clock)   ms until the next drop, counted on the screen's local clock
//   createLootButton({ app, onOpened })  -> { el, update(view, clock), destroy() }
//       The tray's loot button: "Open loot!" (glowing) while you hold a box, else when the next drop comes.
//   burst({ rarity, power, doc }) -> { reveal(rarity, power), fail(), done: Promise }
//       The full-screen opening, mobile-game style: the crate drops in and shakes (light leaking out of its
//       seams in the rarity's colour) until the server says what's inside, then bursts: a flash, the lid flies,
//       shards and sparks, the rarity slams in (COMMON / RARE / LEGENDARY!) and the power's card flips over.
//
// Rarity colours: common silver, rare violet, legendary gold. (Red and blue stay the teams'.)
import { h, text } from '../dom.js?v=161';
import { POWERS, fmtClock } from '../../shared/rules.js?v=161';

export const RARITY_WORD = { common: 'Common', rare: 'Rare', legendary: 'Legendary' };
export const POWER_EMOJI = { jammer: '📵', decoy: '🎭', sprint: '💨', radar: '📡', exposure: '👁️', hacker: '🚨', wiretap: '🎧' };
export const SHAKE_MS = 1500;     // the crate shakes at least this long (the anticipation), however quick the answer
export const SHOW_MS = 6500;      // the card stays this long, then it goes by itself (a tap closes it sooner)
const SHARDS = 14;
const SPARKS = 18;

export function lootOf(view) {
  const l = view && view.loot;
  return view && view.phase === 'live' && l && typeof l === 'object' ? l : null;
}

export function nextDropIn(view, clock) {
  const l = lootOf(view);
  if (!l || !Number.isFinite(l.next)) return null;
  const gone = Number.isFinite(clock) && Number.isFinite(view.clock) ? Math.max(0, clock - view.clock) : 0;
  return Math.max(0, l.next - gone);
}

export function lootEffect(e, view) {
  const none = { moment: null, banner: null, buzz: null, beep: null, chat: false };
  const me = (view && view.me) || {};
  const data = e && e.data && typeof e.data === 'object' ? e.data : {};
  const words = String((e && e.text) || '');
  switch (e && e.kind) {
    case 'loot': return { ...none, banner: [words || 'A loot box dropped!', 'power'], buzz: 'ping', beep: 'ping' };
    case 'loot-got': return { ...none, banner: [words || 'You grabbed a loot box!', 'good'], buzz: 'power', beep: 'power' };
    case 'loot-taken': return { ...none, banner: [words, 'warn'], buzz: 'tap' };
    case 'loot-open': return none; // the burst shows it
    case 'loot-team': return data.by === me.id ? none : { ...none, banner: [words, 'power'], buzz: 'power', beep: 'power' };
    default: return null;
  }
}

function reducedMotion(doc) {
  try { return doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---- the burst ----------------------------------------------------------------------------------------------

export function burst({ doc = globalThis.document } = {}) {
  const still = reducedMotion(doc);
  const shards = h('div.lb-shards', { 'aria-hidden': 'true' });
  for (let i = 0; i < SHARDS; i++) {
    const s = h('span.lb-shard');
    s.style.setProperty('--a', `${Math.round((360 / SHARDS) * i + (i % 3) * 9)}deg`);
    s.style.setProperty('--d', `${150 + (i * 37) % 120}px`);
    s.style.setProperty('--r', `${(i % 2 ? 1 : -1) * (200 + i * 40)}deg`);
    shards.appendChild(s);
  }
  const sparks = h('div.lb-sparks', { 'aria-hidden': 'true' });
  for (let i = 0; i < SPARKS; i++) {
    const s = h('span.lb-spark');
    s.style.setProperty('--a', `${Math.round((360 / SPARKS) * i + 5)}deg`);
    s.style.setProperty('--d', `${120 + (i * 53) % 220}px`);
    s.style.setProperty('--t', `${(i % 5) * 0.06}s`);
    sparks.appendChild(s);
  }
  const crate = h('div.lb-crate', { 'aria-hidden': 'true' },
    h('div.lb-lid', h('span.lb-face.lb-lid-top'), h('span.lb-face.lb-lid-front')),
    h('div.lb-body', h('span.lb-face.lb-front', h('span.lb-q', '?')), h('span.lb-face.lb-side'), h('span.lb-seam')));
  const word = h('div.lb-word');
  const emoji = h('div.lb-emoji', { 'aria-hidden': 'true' });
  const name = h('div.lb-name');
  const desc = h('p.lb-desc');
  const card = h('div.lb-card', h('div.lb-card-in', h('div.lb-card-back', { 'aria-hidden': 'true' }, '?'), h('div.lb-card-front', emoji, name, desc)));
  const hint = h('p.lb-hint', 'Opening…');
  const live = h('p.sr-only', { 'aria-live': 'assertive' });
  const layer = h('div.lb', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Loot box', 'data-stage': 'shake' },
    h('div.lb-rays', { 'aria-hidden': 'true' }), h('div.lb-flash', { 'aria-hidden': 'true' }),
    h('div.lb-stage', crate, shards, sparks, word, card), hint, live);
  if (still) layer.classList.add('still');
  doc.body.appendChild(layer);
  const born = Date.now();
  let finish;
  const done = new Promise((r) => { finish = r; });
  let closed = false;
  let autoClose = null;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(autoClose);
    layer.classList.add('out');
    setTimeout(() => { layer.remove(); finish(); }, still ? 0 : 280);
  };
  const keys = (e) => { if (e.key === 'Escape' && layer.dataset.stage !== 'shake') close(); };
  doc.addEventListener('keydown', keys);
  done.then(() => doc.removeEventListener('keydown', keys));

  function reveal(rarity, power) {
    const r = RARITY_WORD[rarity] ? rarity : 'common';
    const wait = still ? 0 : Math.max(0, SHAKE_MS - (Date.now() - born));
    setTimeout(() => {
      if (closed) return;
      const p = POWERS[power] || { name: power, desc: '' };
      layer.dataset.rarity = r;
      text(word, r === 'legendary' ? 'LEGENDARY!' : RARITY_WORD[r].toUpperCase());
      text(emoji, POWER_EMOJI[power] || '⭐');
      text(name, p.name);
      text(desc, p.desc || '');
      text(hint, 'Tap to keep it');
      text(live, `${RARITY_WORD[r]} loot: ${p.name}. ${p.desc || ''}`);
      layer.dataset.stage = 'burst';
      // The card flips over a beat after the burst; the layer can be tapped away once it's showing.
      setTimeout(() => { if (!closed) layer.dataset.stage = 'card'; }, still ? 0 : (r === 'legendary' ? 1150 : 800));
      layer.addEventListener('click', () => { if (layer.dataset.stage === 'card') close(); });
      autoClose = setTimeout(close, SHOW_MS + (r === 'legendary' ? 1000 : 0));
    }, wait);
  }
  function fail(msg = "Couldn't open it. Try again.") {
    text(hint, msg);
    layer.dataset.stage = 'fail';
    setTimeout(close, 1400);
  }
  return { el: layer, reveal, fail, close, done };
}

// ---- the tray button ----------------------------------------------------------------------------------------

export function createLootButton({ app, doc = globalThis.document, onOpened = null } = {}) {
  const ico = h('span.lt-ico', { 'aria-hidden': 'true' }, '🎁');
  const label = h('span.lt-label');
  const badge = h('span.lt-n', { 'aria-hidden': 'true' });
  // Holding a box: a wide glowing "Open loot!". Otherwise a square with a small badge: boxes on the map, or the
  // time to the next drop.
  const el = h('button.tray-sq.lt', { type: 'button' }, ico, label, badge);
  const S = { view: null, clock: null, busy: false, sig: '' };
  el.addEventListener('click', () => {
    const l = lootOf(S.view);
    if (!l) return;
    if (l.held) open();
    else {
      const n = l.boxes.length;
      const ms = nextDropIn(S.view, S.clock);
      const when = ms === null ? '' : ` Next drop in ${fmtClock(ms)}.`;
      import('../ui/banner.js?v=161').then(({ banner }) => banner(n
        ? `${n === 1 ? 'A box is' : `${n} boxes are`} on the map. Walk right up to one to grab it.${when}`
        : `No boxes on the map right now.${when}`, 'info')).catch(() => {});
    }
  });
  async function open() {
    if (S.busy) return;
    S.busy = true;
    const b = burst({ doc });
    const before = lootOf(S.view) && lootOf(S.view).last ? lootOf(S.view).last.at : null;
    try {
      const v = await app.cmd({ type: 'lootopen' }, { quiet: true });
      const last = v && v.loot && v.loot.last;
      if (last && last.at !== before) {
        b.reveal(last.rarity, last.power);
        if (onOpened) { try { onOpened(last); } catch (e) { console.error(e); } }
      } else b.fail(v && v.message ? v.message : undefined);
    } catch (e) {
      b.fail(e && e.message ? e.message : undefined);
    }
    await b.done;
    S.busy = false;
  }
  function update(view, clock) {
    S.view = view;
    S.clock = clock;
    const l = lootOf(view);
    el.hidden = !l;
    if (!l) return;
    const held = !!l.held;
    const ms = nextDropIn(view, clock);
    const n = l.boxes.length;
    const small = held ? '' : n ? String(n) : ms !== null ? fmtClock(ms) : '';
    const words = held ? 'Open your loot box' : n ? `Loot: ${n} ${n === 1 ? 'box' : 'boxes'} on the map` : ms !== null ? `Loot: next drop in ${fmtClock(ms)}` : 'Loot';
    const sig = `${held}|${small}`;
    if (sig === S.sig) return;
    S.sig = sig;
    el.className = held ? 'btn lt held' : `tray-sq lt${n ? ' some' : ''}`;
    text(label, held ? 'Open!' : '');
    label.hidden = !held;
    text(badge, small);
    badge.hidden = !small;
    el.setAttribute('aria-label', words);
  }
  return { el, update, open, destroy() { el.remove(); } };
}
