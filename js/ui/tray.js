// Night Ops v1.2 (PAGE-MAP): the bottom tray over the big map (the game, the spectator's screen and the replay).
//
//   const tray = createTray({ label, onState });
//   tray.el                      section.tray: the handle, the main row, the more rows
//   tray.setMain(parts)          up to 4 parts in one 56px row: elements, or { el, grow } (grow: the role's main action,
//                                it stretches; the rest are 56px squares). An element with class .tray-grow grows too.
//   tray.setMore(parts)          the rest of the panel (powers, quick chat, pickups...): shown only while open
//   tray.state                   'open' | 'tucked'   tray.set(state)   tray.toggle()   tray.height()
// The state is kept per phone (localStorage 'nightops-tray') and is the same on every screen. A phone that never chose
// starts open, unless its screen is shorter than TUCK_BELOW_PX: there the open tray would leave little map.
// The handle is a 28px row with a bar; its button's hit area is 44px (16px reaching up over the map, see map.css).
// Swiping it down tucks the tray, up opens it; a tap toggles. With nothing in the more rows there's no handle.
import { h, fill } from '../dom.js?v=149';

export const TRAY_KEY = 'nightops-tray';
export const TRAY_STATES = ['open', 'tucked'];
const SWIPE_PX = 18;
export const TUCK_BELOW_PX = 740;
let trayCount = 0;

// 'open' | 'tucked' from whatever was saved; nothing (or nonsense) saved: open, or tucked on a short screen.
export function trayStateFrom(raw, height = null) {
  if (raw === 'tucked' || raw === 'open') return raw;
  return Number.isFinite(height) && height > 0 && height < TUCK_BELOW_PX ? 'tucked' : 'open';
}

function screenHeight() {
  try { return Number(globalThis.innerHeight) || null; } catch { return null; }
}

function storage(store) {
  if (store !== undefined) return store;
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function readTrayState(store, height = screenHeight()) {
  try {
    const s = storage(store);
    return trayStateFrom(s ? s.getItem(TRAY_KEY) : null, height);
  } catch {
    return trayStateFrom(null, height);
  }
}

export function saveTrayState(state, store) {
  try {
    const s = storage(store);
    if (s) s.setItem(TRAY_KEY, trayStateFrom(state));
  } catch { /* private mode or full: this page still remembers */ }
}

// Parts [{ el, main, order, grow }] -> { main: [...], more: [...] } each by order (then as given). At most `most`
// in the main row: any more go to the top of the more rows.
export function splitParts(parts, most = 4) {
  const list = (Array.isArray(parts) ? parts : [])
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p && p.el)
    .sort((a, b) => ((Number(a.p.order) || 0) - (Number(b.p.order) || 0)) || a.i - b.i)
    .map(({ p }) => p);
  const main = list.filter((p) => p.main);
  const more = list.filter((p) => !p.main);
  return { main: main.slice(0, most), more: [...main.slice(most), ...more] };
}

// Where the map's buttons go: a column centred between the HUD's bottom and the tray's top, pushed up to sit
// `over` px above the tray when the gap is small; a row along the tray's top when even that doesn't fit.
// -> { mode: 'column' | 'row', top, bottom } (px from the top / from the bottom of the screen)
export function mapButtonsPlace({ hudBottom = 0, trayTop = 0, height = 0, count = 3, size = 44, gap = 8, over = 12, edge = 8 } = {}) {
  const n = Math.max(0, Math.floor(count));
  const room = trayTop - hudBottom;
  const col = n * size + Math.max(0, n - 1) * gap;
  const bottom = Math.max(0, height - trayTop) + over;
  if (n && col + over + edge <= room) {
    const centred = hudBottom + (room - col) / 2;
    const lowest = trayTop - over - col;
    return { mode: 'column', top: Math.round(Math.min(centred, lowest)), bottom };
  }
  return { mode: 'row', top: Math.round(trayTop - over - size), bottom };
}

// What the map's buttons cover, as map insets: a column on the right (Fit everyone keeps the ring out from under it),
// or a row along the tray's top (the map's credits and scale bar sit above it). at = mapButtonsPlace()'s answer
// (+ shown, the number of buttons). -> { bottom, right, left }
export function mapButtonInsets(at, height, trayTop, { size = 44, edge = 12, over = 12, clear = 12 } = {}) {
  const tray = Math.max(0, Math.round((Number(height) || 0) - (Number(trayTop) || 0)));
  const any = !!at && (at.shown === undefined || at.shown > 0);
  if (any && at.mode === 'row') return { bottom: tray + over + size + 4, right: 0, left: 0 };
  if (any && at.mode === 'column') return { bottom: tray, right: edge + size + clear, left: 0 };
  return { bottom: tray, right: 0, left: 0 };
}

export function createTray({ label = 'Your moves', onState = null, store } = {}) {
  const id = `tray-more-${++trayCount}`;
  const bar = h('span.tray-bar', { 'aria-hidden': 'true' });
  const handle = h('button.tray-handle', { type: 'button', 'aria-controls': id, 'aria-expanded': 'true', 'aria-label': 'Show less' }, bar);
  const main = h('div.tray-main');
  const more = h('div.tray-more', { id });
  const el = h('section.tray', { 'aria-label': label, 'data-state': 'open' }, handle, main, more);
  const T = {
    state: readTrayState(store),
    hasMore: false,
  };

  function paint() {
    const open = T.state === 'open';
    el.dataset.state = T.state;
    handle.setAttribute('aria-expanded', open ? 'true' : 'false');
    handle.setAttribute('aria-label', open ? 'Show less' : 'Show more');
    more.hidden = !open || !T.hasMore;
    handle.hidden = !T.hasMore;
    el.classList.toggle('no-more', !T.hasMore);
  }

  function set(state, { save = true } = {}) {
    const next = trayStateFrom(state);
    const changed = next !== T.state;
    T.state = next;
    paint();
    if (save) saveTrayState(next, store);
    if (changed && typeof onState === 'function') { try { onState(next); } catch (e) { console.error(e); } }
  }

  function toggle() { set(T.state === 'open' ? 'tucked' : 'open'); }

  function setMain(parts) {
    const list = (Array.isArray(parts) ? parts : []).filter(Boolean).map((p) => (p.el ? p : { el: p }));
    for (const p of list) {
      p.el.classList.add('tray-part');
      p.el.classList.toggle('tray-grow', !!p.grow || p.el.classList.contains('tray-grow'));
    }
    fill(main, list.map((p) => p.el));
    main.dataset.n = String(list.length);
  }

  function setMore(parts) {
    const list = (Array.isArray(parts) ? parts : []).filter(Boolean).map((p) => (p.el ? p.el : p));
    fill(more, list);
    T.hasMore = list.length > 0;
    paint();
  }

  // A tap toggles; a swipe down tucks, up opens.
  let down = null;
  let swiped = false;
  handle.addEventListener('pointerdown', (e) => {
    down = { y: e.clientY, id: e.pointerId };
    swiped = false;
    try { handle.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
  });
  handle.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== down.id || swiped) return;
    const dy = e.clientY - down.y;
    if (Math.abs(dy) < SWIPE_PX) return;
    swiped = true;
    set(dy > 0 ? 'tucked' : 'open');
  });
  const end = () => { down = null; };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('click', (e) => {
    if (swiped) { swiped = false; e.preventDefault(); return; }
    toggle();
  });

  paint();

  return {
    el,
    main,
    more,
    handle,
    setMain,
    setMore,
    set,
    toggle,
    get state() { return T.state; },
    height: () => { try { return el.getBoundingClientRect().height; } catch { return 0; } },
  };
}
