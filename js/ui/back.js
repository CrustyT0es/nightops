// Night Ops: the phone's Back (Android's back gesture or button; an iPhone tab's swipe from the left edge).
// Without this, Back leaves Night Ops: on Android it closes an installed app, or a tab opened from an invite.
//   backButton.sheets(count, closeTop)   sheet.js: how many sheets are open; closeTop() closes the top one when
//                                        it may be closed by accident, else returns false ("Did Sam tag you?")
//   backButton.guard(on, onBack)         the App: during a live game Back stays in the game and calls onBack()
// One history entry (pushState) stands for all the open sheets, and one for the game. Back closes the top sheet,
// or stays in the game; an entry nobody needs any more is taken away again (history.back()). Staying is done by
// stepping forward again to the entry Back just left, so no new entry is made then.
// Chrome skips, on Back, history entries a page added without a tap (against pages that trap you): after the
// game's entry went in without one (a reload mid-game), the next tap adds one more, which Back can't skip.
// Each entry knows how far above the page's own entry it is (n), so it never steps back past this page.
const KEY = 'nightops';
const MOVE_MS = 1500; // our own back()/forward() lands within this; its popstate is ours

export function createBack({
  win = globalThis.window,
  hist = globalThis.history,
  nav = globalThis.navigator,
  now = () => Date.now(),
} = {}) {
  let sheetCount = 0;
  let closeTop = null;
  let guardOn = false;
  let onGuardBack = null;
  let movingAt = 0;
  let needTap = false;
  let inPop = false;
  let started = false;

  const usable = () => !!hist && typeof hist.pushState === 'function' && typeof hist.replaceState === 'function';

  function current() {
    try {
      const s = hist.state;
      const mine = s && typeof s === 'object' ? s[KEY] : null;
      if (mine && typeof mine === 'object') return { kind: mine.kind || null, n: Number.isInteger(mine.n) && mine.n > 0 ? mine.n : 0 };
    } catch { /* ignore */ }
    return { kind: null, n: 0 };
  }

  function others() {
    try {
      const s = hist.state;
      return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    } catch {
      return {};
    }
  }

  function push(kind) {
    const { n } = current();
    try { hist.pushState({ [KEY]: { kind, n: n + 1 } }, ''); return true; } catch { return false; }
  }

  function replace(kind) {
    const { n } = current();
    try { hist.replaceState({ ...others(), [KEY]: { kind, n } }, ''); } catch { /* ignore */ }
  }

  function moving() {
    return movingAt > 0 && now() - movingAt < MOVE_MS;
  }

  function step(dir) {
    movingAt = now();
    try {
      if (dir < 0) hist.back();
      else hist.forward();
    } catch {
      movingAt = 0;
    }
  }

  function tapNow() {
    try { return nav && nav.userActivation ? !!nav.userActivation.isActive : true; } catch { return true; }
  }

  // Make the history match what's open.
  function settle() {
    if (!usable() || moving()) return;
    let { kind, n } = current();
    if (sheetCount > 0) {
      if (kind !== 'sheet' || n === 0) push('sheet');
      return;
    }
    if (kind === 'sheet' || (kind === 'guard' && !guardOn)) {
      if (n > 0) {
        step(-1); // (settle runs again when it lands)
        return;
      }
      replace(null);
      kind = null;
    }
    if (guardOn && (kind !== 'guard' || n === 0)) {
      push('guard');
      needTap = !tapNow();
    }
  }

  function onPop() {
    if (moving()) {
      movingAt = 0;
      settle();
      return;
    }
    movingAt = 0;
    // A real Back: we're one entry below where we were.
    if (sheetCount > 0) {
      let closed = false;
      inPop = true;
      try {
        closed = !!(closeTop && closeTop());
      } catch (e) {
        console.error(e);
      } finally {
        inPop = false;
      }
      if (!closed || sheetCount > 0) step(1); // a sheet is still open: back up to its entry
      else settle();
      return;
    }
    if (guardOn) {
      try { if (onGuardBack) onGuardBack(); } catch (e) { console.error(e); }
      step(1); // back up to the game's entry Back just left (the one below may be one Chrome would skip)
      return;
    }
    settle();
  }

  function onTap(e) {
    if (!needTap || (e && e.isTrusted === false)) return;
    if (e && e.type === 'pointerup' && e.pointerType === 'mouse') return;
    if (!guardOn || sheetCount > 0 || moving() || current().kind !== 'guard') return;
    needTap = false;
    push('guard');
  }

  function start() {
    if (started) return;
    started = true;
    if (!usable() || !win || typeof win.addEventListener !== 'function') return;
    // This page's own entry is the bottom: never ours to take away (it may say 'sheet' from before a reload).
    try { hist.replaceState({ ...others(), [KEY]: { kind: null, n: 0 } }, ''); } catch { /* ignore */ }
    win.addEventListener('popstate', onPop);
    for (const type of ['pointerup', 'touchend', 'click', 'keydown']) win.addEventListener(type, onTap, true);
  }

  return {
    sheets(count, top) {
      start();
      sheetCount = Math.max(0, Number(count) || 0);
      if (typeof top === 'function') closeTop = top;
      if (!inPop) settle();
    },
    guard(on, onBack) {
      start();
      guardOn = !!on;
      if (typeof onBack === 'function') onGuardBack = onBack;
      settle();
    },
    // (tests)
    state: () => ({ sheets: sheetCount, guard: guardOn, needTap, moving: moving(), ...current() }),
  };
}

// The page's one Back handler (does nothing where there's no history, as in Node).
export const backButton = createBack();
