// Night Ops: pocket mode. startPocket({ onWake }) -> stop()
// A black full-screen layer with a faint, slow line so you can tell it's on. It keeps the screen awake
// (Wake Lock, asked again when the page comes back), swallows every touch, and wakes on two taps within
// 450 ms, or Enter / Space / Esc, or its "Wake the screen" button for screen readers. stop() removes it
// without calling onWake.
import { h } from '../dom.js?v=180';
import { keepAwake } from '../alerts.js?v=180';
import { holdInert } from './inert.js?v=180';

export const DOUBLE_TAP_MS = 450;
const SWALLOW = ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup', 'click',
  'dblclick', 'contextmenu', 'wheel', 'gesturestart', 'gesturechange'];

export function startPocket({ onWake } = {}) {
  if (typeof document === 'undefined') return () => {};
  const before = document.activeElement;
  const app = document.getElementById('app');
  let releaseApp = () => {};

  const wakeBtn = h('button.sr-only.pocket-wake', { type: 'button' }, 'Wake the screen');
  const layer = h('div.pocket', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pocket mode', tabindex: '-1' },
    h('div.pocket-line', { 'aria-hidden': 'true' }),
    h('p.pocket-hint', { 'aria-hidden': 'true' }, 'Pocket mode. Tap twice to wake.'),
    wakeBtn);

  let stopped = false;
  let lastTap = 0;

  function swallow(e) {
    if (e.target === wakeBtn && e.type === 'click') return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
  }
  function onTap(e) {
    if (e.type === 'pointerdown' && e.pointerType === 'touch' && 'ontouchstart' in globalThis) return; // counted by touchstart
    const t = Date.now();
    if (t - lastTap <= DOUBLE_TAP_MS) {
      wake();
    } else {
      lastTap = t;
    }
  }
  function onKey(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      wake();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      wakeBtn.focus();
    }
  }
  function onVisible() {
    if (document.visibilityState === 'visible') keepAwake(true, 'pocket');
  }

  for (const type of SWALLOW) layer.addEventListener(type, swallow, { passive: false });
  layer.addEventListener('touchstart', onTap, { passive: false });
  layer.addEventListener('pointerdown', onTap);
  wakeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    wake();
  });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisible);

  document.body.appendChild(layer);
  // (Counted with the sheets: a sheet still open when this wakes keeps the page under it inert.)
  if (app) releaseApp = holdInert(app);
  document.documentElement.classList.add('pocket-on');
  keepAwake(true, 'pocket');
  try { layer.focus({ preventScroll: true }); } catch { layer.focus(); }

  function stop() {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisible);
    layer.remove();
    releaseApp();
    document.documentElement.classList.remove('pocket-on');
    keepAwake(false, 'pocket');
    // Focus back where it was, or into a sheet that opened meanwhile ("Did Sam tag you?").
    const sheets = document.querySelectorAll('.sheet-layer:not(.out) .sheet');
    const top = sheets.length ? sheets[sheets.length - 1] : null;
    const back = top && !top.contains(before) ? top : before;
    if (back && back.isConnected && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }
  function wake() {
    if (stopped) return;
    stop();
    if (typeof onWake === 'function') {
      try { onWake(); } catch (e) { console.error(e); }
    }
  }
  return stop;
}
