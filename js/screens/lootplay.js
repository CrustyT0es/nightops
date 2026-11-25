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
import { h, text } from '../dom.js?v=180';
import { chest, chestModel } from '../chest.js?v=180';
import { cardEl, tiltFrom } from '../cards.js?v=180'; // v1.6.3: one card look everywhere
import { POWERS, fmtClock } from '../../shared/rules.js?v=180';
import { LOOT_POWERS, LOOT_PICK_M, LOOT_ACC_MAX_M, rarityOfPower } from '../../shared/loot.js?v=180';
import { distanceM, bearingDeg, isPoint } from '../../shared/geo.js?v=180';

export const RARITY_WORD = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', mythic: 'Mythic' }; // (v1.7: epic)
export const POWER_EMOJI = { jammer: '📵', decoy: '🎭', sprint: '🏃', radar: '📡', exposure: '👁️', hacker: '🚨', wiretap: '🎧' };
for (const [k, p] of Object.entries(LOOT_POWERS)) POWER_EMOJI[k] = p.emoji;
export const powerInfo = (k) => POWERS[k] || (LOOT_POWERS[k] ? { name: LOOT_POWERS[k].name, desc: LOOT_POWERS[k].line } : { name: k, desc: '' });
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
    case 'loot-queued': return { ...none, banner: [words, 'info'], buzz: 'tap' };
    case 'lootfx': {
      const big = { blackout: 'BLACKOUT', eye: 'ALL-SEEING EYE', storm: 'STATIC STORM', freeze: 'FREEZE', tracker: 'TRACKER DART' }[data.power];
      // v1.7: how my own Snitch call ended (a deal: `on`; no deal: `state`): my `call` event and the call screen say it
      if (data.power === 'snitch' && data.by === me.id && (data.on || data.state)) return none;
      if (data.by === me.id) return { ...none, banner: [words, 'power'], buzz: 'power' };
      // v1.6.3: the Blackout screen itself says it to the hunters (a moment would only wait unseen under it)
      if (data.power === 'blackout' && e.to === 'hunters') return { ...none, buzz: 'warn', beep: 'warn' };
      if (big && (data.power !== 'tracker' || e.to === me.id)) {
        return { ...none, moment: { kicker: data.power === 'blackout' || data.power === 'storm' || data.power === 'eye' ? 'Mythic loot' : 'Loot power', title: big, line: words, kind: data.power === 'eye' || data.power === 'tracker' || data.power === 'freeze' ? 'radar' : 'hider' }, buzz: 'warn', beep: 'warn' };
      }
      return { ...none, banner: [words, 'power'], buzz: 'power' };
    }
    case 'loot-team': return data.by === me.id ? none : { ...none, banner: [words, 'power'], buzz: 'power', beep: 'power' };
    default: return null;
  }
}

function reducedMotion(doc) {
  try { return doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---- the burst ----------------------------------------------------------------------------------------------

export function burst({ doc = globalThis.document, useIt = null } = {}) {
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
  // v1.6.2: a mystery chest in 3D: a base and a hinged lid (each a box of six shaded faces: lit front, darker
  // sides, gold trim), a "?" lock on the front. It spins in, hops and spins faster while it shakes, then the lid
  // swings open with light pouring out (Clash Royale style).
  const crate = h('div.lb-crate.mc', { 'aria-hidden': 'true' }, h('div.mc-glow'), chestModel(), h('div.mc-shadow'));
  const word = h('div.lb-word');
  // v1.6.3: the card that comes out is the same card as in your collection (js/cards.js), made once we know it.
  const card = h('div.lb-card.has-nc');
  card.addEventListener('click', (e) => { e.stopPropagation(); if (layer.dataset.stage === 'card') card.classList.toggle('flipped'); });
  const foot = h('div.lb-foot');
  const hint = h('p.lb-hint', 'Opening…');
  const live = h('p.sr-only', { 'aria-live': 'assertive' });
  const layer = h('div.lb', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Loot box', 'data-stage': 'shake' },
    h('div.lb-rays', { 'aria-hidden': 'true' }), h('div.lb-flash', { 'aria-hidden': 'true' }),
    h('div.lb-stage', crate, shards, sparks, word, card), foot, hint, live);
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
  const keys = (e) => { if (e.key === 'Escape' && (layer.dataset.stage === 'card' || layer.dataset.stage === 'fail')) close(); };
  doc.addEventListener('keydown', keys);
  done.then(() => doc.removeEventListener('keydown', keys));

  function reveal(rarity, power, more = null) {
    const r = RARITY_WORD[rarity] ? rarity : 'common';
    const wait = still ? 0 : Math.max(0, SHAKE_MS - (Date.now() - born));
    setTimeout(() => {
      if (closed) return;
      const p = powerInfo(power);
      layer.dataset.rarity = r;
      text(word, r === 'mythic' ? 'MYTHIC!!' : r === 'legendary' ? 'LEGENDARY!' : r === 'epic' ? 'EPIC!' : RARITY_WORD[r].toUpperCase());
      // It stays until OK (the owner: never gone before you've read it); a loot-only power can be used right away.
      const ok = h('button.btn.lb-ok', { type: 'button' }, 'OK');
      ok.addEventListener('click', (e) => { e.stopPropagation(); close(); });
      if (LOOT_POWERS[power] && useIt) {
        const use = h('button.btn.lb-use', { type: 'button' }, 'Use it now');
        use.addEventListener('click', (e) => { e.stopPropagation(); close(); try { useIt(power); } catch (err) { console.error(err); } });
        foot.append(use, ok);
      } else foot.append(ok);
      const nc = cardEl(power, { full: true, back: true, rarity: r });
      const inner = nc.querySelector('.nc-in');
      if (inner) inner.classList.add('lb-card-in');
      card.replaceChildren(nc);
      // A finger over the card moves its foil shine (the card itself keeps turning slowly).
      layer.addEventListener('pointermove', (e) => { tiltFrom(nc, card.getBoundingClientRect(), e.clientX, e.clientY); });
      // v1.7: Lucky: more cards came out of the same box
      const extra = Array.isArray(more) ? more.filter((m) => m && m.power) : [];
      text(hint, extra.length ? `🍀 Lucky! Also: ${extra.map((m) => `${powerInfo(m.power).name} (${(RARITY_WORD[m.rarity] || 'Common').toLowerCase()})`).join(', ')}. All in your cards 🃏` : 'It goes in your cards 🃏');
      if (extra.length) layer.classList.add('lucky');
      text(live, `${RARITY_WORD[r]} loot: ${p.name}. ${p.desc || ''}`);
      layer.dataset.stage = 'burst';
      // The card flips over a beat after the burst; the layer can be tapped away once it's showing.
      setTimeout(() => { if (!closed) { layer.dataset.stage = 'card'; try { ok.focus({ preventScroll: true }); } catch { /* fine */ } } }, still ? 0 : (r === 'mythic' ? 1700 : r === 'legendary' ? 1150 : r === 'epic' ? 950 : 800));
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

export function createLootButton({ app, doc = globalThis.document, onOpened = null, useIt = null } = {}) {
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
      import('../ui/banner.js?v=180').then(({ banner }) => banner(n
        ? `${n === 1 ? 'A box is' : `${n} boxes are`} on the map. Get within ${LOOT_PICK_M} m of one to grab it (zoom in to see the real circle).${when}`
        : `No boxes on the map right now.${when}`, 'info')).catch(() => {});
    }
  });
  async function open() {
    if (S.busy) return;
    S.busy = true;
    const b = burst({ doc, useIt });
    const before = lootOf(S.view) && lootOf(S.view).last ? lootOf(S.view).last.at : null;
    try {
      const v = await app.cmd({ type: 'lootopen' }, { quiet: true });
      const last = v && v.loot && v.loot.last;
      if (last && last.at !== before) {
        b.reveal(last.rarity, last.power, last.more);
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

// ---- v1.6.1: the loot stash (powers from boxes waiting to be used) -----------------------------------------
// createLootStash({ app, pickHider }) -> { el, use(power), update(view) }
// One button per power with its count; a tap uses it (Tracker dart asks which hider first, through pickHider).
export function createLootStash({ app, pickHider = null } = {}) {
  const row = h('div.ls-row');
  const el = h('section.ls', { hidden: true, 'aria-label': 'Your loot' }, h('p.ls-title', '🎁 Your loot'), row);
  const S = { sig: '', view: null };
  async function use(power) {
    const P = LOOT_POWERS[power];
    if (!P) return;
    let target;
    if (P.target) {
      target = pickHider ? await pickHider(S.view, P) : null;
      if (!target) return;
    }
    try { await app.cmd({ type: 'lootuse', power, ...(target ? { target } : {}) }); } catch { /* the banner says */ }
  }
  function update(view) {
    S.view = view;
    const l = lootOf(view);
    const stash = (l && l.stash) || {};
    const keys = Object.keys(stash).filter((k) => LOOT_POWERS[k] && stash[k] > 0);
    const fx = (view && view.fx) || {};
    const sig = JSON.stringify([stash, !!fx.freeze, !!fx.blackout]);
    el.hidden = !keys.length;
    if (sig === S.sig) return;
    S.sig = sig;
    const off = (k) => (LOOT_POWERS[k].team === 'hider' && fx.freeze) || (LOOT_POWERS[k].team === 'hunter' && fx.blackout);
    row.replaceChildren(...keys.map((k) => {
      const P = LOOT_POWERS[k];
      const b = h(`button.ls-btn${P.mythic ? '.mythic' : ''}`, { type: 'button', 'data-power': k, 'aria-label': `${P.name}${stash[k] > 1 ? `, ${stash[k]} of them` : ''}: ${P.line}` },
        h('span.ls-emoji', { 'aria-hidden': 'true' }, P.emoji), h('span.ls-name', P.name), stash[k] > 1 ? h('span.ls-n', `×${stash[k]}`) : null);
      if (off(k)) b.disabled = true;
      b.addEventListener('click', () => use(k));
      return b;
    }));
  }
  return { el, use, update };
}

// ---- v1.6.1: the box flies from the map into your phone --------------------------------------------------
// flyIn({ from: [x, y] (screen px) | null, to: element, doc }) -> Promise
export function flyIn({ from, to, doc = globalThis.document } = {}) {
  return new Promise((done) => {
    const W = doc.defaultView || globalThis;
    const still = reducedMotion(doc);
    const end = to && to.getBoundingClientRect ? to.getBoundingClientRect() : null;
    const sx = from ? from[0] : W.innerWidth / 2;
    const sy = from ? from[1] : W.innerHeight / 2;
    const ex = end ? end.left + end.width / 2 : W.innerWidth / 2;
    const ey = end ? end.top + end.height / 2 : W.innerHeight - 60;
    const crate = h('div.lf-crate', { 'aria-hidden': 'true' }, chest('fly'));
    const ring = h('div.lf-ring', { 'aria-hidden': 'true' });
    const got = h('div.lf-got', { 'aria-hidden': 'true' }, 'GOT IT!');
    const layer = h('div.lf', { 'aria-hidden': 'true' }, ring, crate, got);
    for (const [el, x, y] of [[ring, sx, sy], [crate, sx, sy], [got, ex, ey - 70]]) {
      el.style.setProperty('--x', `${Math.round(x)}px`);
      el.style.setProperty('--y', `${Math.round(y)}px`);
    }
    crate.style.setProperty('--dx', `${Math.round(ex - sx)}px`);
    crate.style.setProperty('--dy', `${Math.round(ey - sy)}px`);
    doc.body.appendChild(layer);
    if (to && to.classList) { to.classList.remove('lf-hit'); }
    const ms = still ? 300 : 1500;
    setTimeout(() => { if (to && to.classList) { to.classList.add('lf-hit'); setTimeout(() => to.classList.remove('lf-hit'), 900); } }, still ? 0 : 1050);
    setTimeout(() => { layer.remove(); done(); }, ms);
  });
}

// ---- v1.6.1: the nearest box, as a chip over the map ("🎁 45 m" and an arrow) -----------------------------
// v1.6.3: a box is picked up inside its circle (r metres, 5 m): -> { d, b (bearing), box, r, inside }
export const boxRadius = (b) => (b && Number.isFinite(b.r) && b.r > 0 ? b.r : LOOT_PICK_M);
export function nearestBox(view, me) {
  const l = lootOf(view);
  if (!l || l.held || !isPoint(me)) return null;
  let best = null;
  for (const b of l.boxes) {
    if (!isPoint(b.p)) continue;
    const d = distanceM(me, b.p);
    if (!best || d < best.d) best = { d, b: bearingDeg(me, b.p), box: b };
  }
  if (best) {
    best.r = boxRadius(best.box);
    best.inside = best.d <= best.r;
  }
  return best;
}

// v1.6.3: the chip's words for the nearest box (n from nearestBox; acc: this phone's GPS margin in metres, or
// null): -> { big, small }. Outside the circle: the distance to the box ("7 m", to the metre up close, to 5 m
// further off) over "Walk into the circle". Inside: "Right here!", and the box is picked up with the next fix, or
// waits for a sharper one (the game only counts a fix within LOOT_ACC_MAX_M).
export function nearWords(n, acc = null) {
  if (!n) return null;
  if (n.inside) {
    const vague = Number.isFinite(acc) && acc > LOOT_ACC_MAX_M;
    return { big: 'Right here!', small: vague ? 'GPS is fuzzy. Stand still.' : 'Grabbing it...' };
  }
  // (Never "5 m" while outside a 5 m circle: just outside reads as the next metre up.)
  const m = n.d < 30 ? Math.max(Math.floor(n.r) + 1, Math.round(n.d)) : Math.round(n.d / 5) * 5;
  return { big: `${m} m`, small: `Get within ${LOOT_PICK_M} m` }; // (v1.7: the circle's own size, 10 m once the engine has it)
}

// ---- v1.6.1: what the loot powers do to this screen --------------------------------------------------------
// createLootFx({ app, root, slot, sos, annoy }) -> { update(view, clock), destroy() }
//   slot     the lines over the map (game.js's .g-lines): the chips and the compass go there, in the flow, so they
//            never cover each other or the middle of the map
//   annoy    what Glitch may do by itself: { zoom(), pan(), tray(), chat(), menu(), tear() } (never SOS, tags or powers)
//   Blackout   the whole screen black: a countdown, a big walkie (it crackles) and SOS; nothing else works
//   Storm      TV static over the map (your own dot and the ring faintly through it)
//   Glitch     a minute of an app that won't behave: it zooms and pans the map, opens the tray and the chat by
//              itself, drops into a pocket mode that won't wake for 10 seconds, then asks "Leave the game?" (it
//              never leaves). It looks like the phone acting up, never like a power.
//   Compass    a chip with an arrow to the nearest hider; Eye a purple edge; Freeze frost on the hider's powers;
//   Tracked    a red edge on the hider a dart hit; Smoke / Ghost chips for the hider who has them on
export const POCKET_LOCK_MS = 10000;
export function createLootFx({ app, root, slot = null, sos = null, annoy = {}, moreChips = null, doc = globalThis.document } = {}) {
  // v1.7: moreChips(view, gone) -> [{ cls, words }] (cardplay.js chipsOf) joins the same row of chips
  const S = { view: null, glitchOn: false, crackle: null, dead: false, raf: 0, timer: null, pocketDone: false, started: 0 };
  const strip = h('div.lx-chips', { 'aria-live': 'polite' });
  const compass = h('div.lx-compass', { hidden: true, role: 'img' }, h('span.lx-arrow', { 'aria-hidden': 'true' }, '➤'), h('span.lx-cword'));
  const stack = h('div.lx-stack', strip, compass);
  const clockTxt = h('span.lx-bo-clock');
  const radioBtn = app && app.radio && typeof app.radio.button === 'function' ? (() => { try { return app.radio.button({ big: true }); } catch { return null; } })() : null;
  const sosBtn = h('button.btn.lx-bo-sos', { type: 'button' }, 'SOS');
  if (sos) sosBtn.addEventListener('click', () => { try { sos(); } catch (e) { console.error(e); } });
  const blackout = h('div.lx-blackout', { hidden: true, role: 'alertdialog', 'aria-label': 'Blackout' },
    h('div.lx-bo-noise', { 'aria-hidden': 'true' }),
    h('p.lx-bo-title', 'BLACKOUT'),
    h('p.lx-bo-line', 'A hider used a Mythic. Your screen is dark until it ends.'),
    clockTxt,
    radioBtn ? h('div.lx-bo-radio', radioBtn.wrap || radioBtn) : null,
    h('p.lx-bo-hint', 'Your walkie still works. Talk to your team.'),
    sosBtn);
  const storm = h('canvas.lx-storm', { hidden: true, width: 96, height: 160, 'aria-hidden': 'true' });
  const stormTxt = h('div.lx-storm-word', { hidden: true }, h('strong', 'NO SIGNAL'), h('span'));
  const edge = h('div.lx-edge', { 'aria-hidden': 'true' });
  // Glitch's pocket mode and its "Leave the game?" (neither leaves anything)
  const fpWord = h('p.lx-fp-word', 'Tap twice to wake');
  const fpBox = h('div.lx-fp-ask', { hidden: true, role: 'dialog', 'aria-label': 'Leave the game?' });
  const fakePocket = h('div.lx-fp', { hidden: true, 'aria-label': 'Pocket mode' }, h('span.lx-fp-moon', { 'aria-hidden': 'true' }, '🌙'), fpWord, fpBox);
  root.append(edge, fakePocket, blackout);
  (slot || root).append(stack);
  const mapEl = root.querySelector('.g-mapwrap');
  if (mapEl) mapEl.append(storm, stormTxt);
  else root.append(storm, stormTxt);

  function drawStatic() {
    if (S.dead || storm.hidden) { S.raf = 0; return; }
    const ctx = storm.getContext && storm.getContext('2d');
    if (ctx) {
      const img = ctx.createImageData(storm.width, storm.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = v; d[i + 1] = v; d[i + 2] = v + 10; d[i + 3] = 255; }
      ctx.putImageData(img, 0, 0);
    }
    S.raf = setTimeout(drawStatic, 66);
  }

  let actx = null;
  function crackle() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      actx = actx || new AC();
      if (actx.state === 'suspended') actx.resume().catch(() => {});
      const len = Math.floor(actx.sampleRate * (0.12 + Math.random() * 0.25));
      const buf = actx.createBuffer(1, len, actx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (Math.random() < 0.08 ? 1 : 0.35);
      const src = actx.createBufferSource();
      src.buffer = buf;
      const g = actx.createGain();
      g.gain.value = 0.06;
      const f = actx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1800;
      src.connect(f).connect(g).connect(actx.destination);
      src.start();
    } catch { /* no sound: the screen shows it */ }
  }

  // ---- Glitch: the app acts on its own
  const call = (k) => { try { if (typeof annoy[k] === 'function') annoy[k](); } catch (e) { console.error(e); } };
  function pocketTrap() {
    const until = Date.now() + POCKET_LOCK_MS;
    S.pocketDone = true;
    fakePocket.hidden = false;
    fpBox.hidden = true;
    text(fpWord, 'Tap twice to wake');
    const tap = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!fpBox.hidden) return;
      if (Date.now() < until) {
        text(fpWord, ['Waking…', 'Still waking…', 'Hold on…', 'Tap twice to wake'][Math.floor(Math.random() * 4)]);
        fakePocket.classList.remove('shake'); void fakePocket.offsetWidth; fakePocket.classList.add('shake');
        return;
      }
      ask(0);
    };
    fakePocket.onclick = tap;
    function ask(n) {
      fpBox.hidden = false;
      const leave = h('button.btn.lx-fp-leave', { type: 'button' }, 'Leave game');
      const stay = h('button.btn.lx-fp-stay', { type: 'button' }, 'Stay');
      const words = n === 0 ? ['Leave the game?', "You'll lose your spot in this round."] : ["Couldn't leave right now.", 'Try again?'];
      fpBox.replaceChildren(h('strong', words[0]), h('p', words[1]), h('div.lx-fp-btns', leave, stay));
      leave.onclick = (e) => { e.stopPropagation(); if (n < 1) ask(n + 1); else done(); };
      stay.onclick = (e) => { e.stopPropagation(); done(); };
    }
    function done() { fakePocket.hidden = true; fpBox.hidden = true; fakePocket.onclick = null; }
  }
  function glitchTick() {
    if (!S.glitchOn || S.dead) return;
    const t = Date.now() - S.started;
    if (!S.pocketDone && t > 14000 && fakePocket.hidden) pocketTrap();
    else if (fakePocket.hidden) {
      const acts = ['zoom', 'zoom', 'pan', 'pan', 'tray', 'chat', 'menu', 'tear']; // v1.6.3: 'tear', the screen tears
      call(acts[Math.floor(Math.random() * acts.length)]);
    }
    S.timer = setTimeout(glitchTick, 1400 + Math.random() * 1800);
  }

  function chip(cls, words) { return h(`span.lx-chip.${cls}`, words); }

  function update(view, clock) {
    if (S.dead) return;
    S.view = view;
    const fx = (view && view.phase === 'live' && view.fx) || {};
    const gone = Number.isFinite(clock) && Number.isFinite(view && view.clock) ? Math.max(0, clock - view.clock) : 0;
    const left = (k) => (Number.isFinite(fx[k]) ? Math.max(0, fx[k] - gone) : 0);
    const onHunters = !!(view && view.me && view.me.team === 'hunter'); // Blackout and Static Storm only hit the hunters' phones
    // (v1.7: an SOS pauses the game: the Blackout steps aside for the SOS screen, and comes back on Resume)
    const bo = onHunters && !(view && view.paused) ? left('blackout') : 0;
    // v1.6.3: a fresh Blackout switches the screen off like an old TV (once; never again after a reload)
    if (bo && blackout.hidden && bo > (LOOT_POWERS.blackout.ms || 0) - 10000) {
      blackout.classList.remove('arrive');
      const crt = h('div.lx-bo-crt', { 'aria-hidden': 'true' });
      blackout.append(crt);
      blackout.classList.add('arrive');
      setTimeout(() => { crt.remove(); blackout.classList.remove('arrive'); }, 1300);
    }
    blackout.hidden = !bo;
    doc.documentElement.classList.toggle('lx-dark', !!bo);
    if (bo) {
      text(clockTxt, fmtClock(bo));
      if (!S.crackle) { crackle(); S.crackle = setInterval(() => { if (Math.random() < 0.6) crackle(); }, 1800); }
    } else if (S.crackle) { clearInterval(S.crackle); S.crackle = null; }
    const st = onHunters ? left('storm') : 0;
    const stormWas = !storm.hidden;
    storm.hidden = !st;
    stormTxt.hidden = !st;
    if (st) { text(stormTxt.lastChild, fmtClock(st)); if (!stormWas) drawStatic(); }
    const victim = !!(view && view.me && view.me.team === 'hunter' && !view.me.driver); // Glitch only hits the hunters' phones
    const gl = victim && left('glitch') > 0;
    if (gl && !S.glitchOn) { S.glitchOn = true; S.started = Date.now(); S.pocketDone = false; call('tear'); S.timer = setTimeout(glitchTick, 1200); }
    if (!gl && S.glitchOn) { S.glitchOn = false; clearTimeout(S.timer); fakePocket.hidden = true; }
    const c = fx.compass && Math.max(0, fx.compass.left - gone) > 0 ? fx.compass : null;
    compass.hidden = !c;
    if (c) {
      const has = Number.isFinite(c.bearing);
      compass.firstChild.style.transform = `rotate(${has ? c.bearing - 90 : 0}deg)`;
      compass.classList.toggle('lost', !has);
      text(compass.lastChild, has ? `Nearest hider · ${fmtClock(Math.max(0, c.left - gone))}` : 'No hider signal');
      compass.setAttribute('aria-label', has ? `Compass: the nearest hider is ${Math.round(c.bearing)} degrees from north` : 'Compass: no hider signal');
    }
    edge.className = `lx-edge${left('eye') ? ' eye' : ''}${left('tracked') ? ' tracked' : ''}${left('freeze') ? ' freeze' : ''}`;
    const chips = [];
    if (left('eye')) chips.push(chip('eye', `🔮 All-Seeing Eye ${fmtClock(left('eye'))}`));
    if (left('freeze')) chips.push(chip('freeze', `🧊 Powers frozen ${fmtClock(left('freeze'))}`));
    if (left('tracked')) chips.push(chip('tracked', `🎯 Tracker dart on you ${fmtClock(left('tracked'))}`));
    if (fx.tracker) chips.push(chip('tracker', `🎯 Dart ${fmtClock(Math.max(0, fx.tracker.left - gone))}`));
    if (fx.smoke) chips.push(chip('smoke', '🌫️ Smoke ready: next ping'));
    if (fx.ghost) chips.push(chip('ghost', `👻 Ghost: ${fx.ghost} ping${fx.ghost === 1 ? '' : 's'}`));
    if (Array.isArray(fx.queued)) for (const k of fx.queued) chips.push(chip('queued', `${LOOT_POWERS[k] ? LOOT_POWERS[k].emoji : ''} ${LOOT_POWERS[k] ? LOOT_POWERS[k].name : k} queued`));
    if (view && view.me && view.me.team === 'hider') {
      if (left('blackout')) chips.push(chip('mine', `🌑 Hunters blacked out ${fmtClock(left('blackout'))}`));
      if (left('storm')) chips.push(chip('mine', `📺 Hunters in a storm ${fmtClock(left('storm'))}`));
      if (left('glitch')) chips.push(chip('mine', `👾 Hunters glitched ${fmtClock(left('glitch'))}`));
    }
    if (moreChips) { try { for (const c of moreChips(view, gone) || []) chips.push(chip(c.cls, c.words)); } catch (e) { console.error(e); } }
    const sig = chips.map((x) => x.textContent).join('|');
    if (strip.dataset.sig !== sig) { strip.dataset.sig = sig; strip.replaceChildren(...chips); }
    strip.hidden = !chips.length;
    root.classList.toggle('lx-frozen', !!left('freeze') && view && view.me && view.me.team === 'hider');
  }
  return {
    update,
    destroy() {
      S.dead = true;
      clearInterval(S.crackle);
      clearTimeout(S.raf);
      clearTimeout(S.timer);
      doc.documentElement.classList.remove('lx-dark');
      for (const el of [edge, stack, fakePocket, blackout, storm, stormTxt]) el.remove();
      try { if (actx) actx.close(); } catch { /* fine */ }
    },
  };
}

// ---- v1.6.1: your cards: v1.6.3 moved them to js/cards.js (the collection, one card look everywhere) ----------
export { cardsOf, createCardDeck } from '../cards.js?v=180';
