// Night Ops: top-of-screen toasts. banner(text, kind = 'info', ms = 3800) -> { el, close() }
// Kinds: info, ping, warn, good, catch, power, sos, win, chat (anything else shows as info).
// One role=status region (outside #app, so sheets never make it inert), newest on top, at most 3.
// clearBanners(kind?) closes them all (or one kind's).
// The same words shown again just restart their timer. Tap a banner to close it. ms 0 = stays until tapped.
import { h } from '../dom.js?v=152';
import { icon } from './icons.js?v=152';

export const BANNER_KINDS = {
  info: 'info',
  ping: 'radar',
  warn: 'warn',
  good: 'check',
  catch: 'target',
  power: 'sprint',
  sos: 'sos',
  win: 'trophy',
  chat: 'chat',
  checkpoint: 'flag', // v1.3 PAGE-PLAY: checkpoint violet (css/cpplay.css)
};
const MOST = 3;
const OUT_MS = 220;

let region = null;

function getRegion() {
  if (region && region.isConnected) return region;
  region = h('div.banners', { role: 'status', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  document.body.appendChild(region);
  return region;
}

function reducedMotion() {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function banner(text, kind = 'info', ms = 3800) {
  if (typeof document === 'undefined') return { el: null, close() {} };
  const k = Object.prototype.hasOwnProperty.call(BANNER_KINDS, kind) ? kind : 'info';
  const words = String(text ?? '').trim();
  if (!words) return { el: null, close() {} };
  const r = getRegion();

  // Same words already up: bring them to the top and restart the timer.
  for (const old of r.children) {
    if (old._words === words && old._kind === k && !old._closing) {
      r.prepend(old);
      old._restart(ms);
      return { el: old, close: old._close };
    }
  }

  const el = h(`div.banner.b-${k}`,
    h('span.banner-mark', icon(BANNER_KINDS[k], 18)),
    h('span.banner-text', words));
  el._words = words;
  el._kind = k;
  let timer = null;

  function close() {
    if (el._closing) return;
    el._closing = true;
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : OUT_MS);
  }
  function restart(t) {
    clearTimeout(timer);
    if (t > 0 && Number.isFinite(t)) timer = setTimeout(close, t);
  }
  el._close = close;
  el._restart = restart;
  el.addEventListener('click', close);

  r.prepend(el);
  // Too many: the oldest go at once.
  const live = [...r.children].filter((c) => !c._closing);
  for (const old of live.slice(MOST)) {
    old._closing = true;
    old.remove();
  }
  restart(ms);
  return { el, close };
}

// Remove every banner (used when leaving a game), or close only those of one kind.
export function clearBanners(kind) {
  if (!region) return;
  if (!kind) {
    region.replaceChildren();
    return;
  }
  for (const el of [...region.children]) if (el._kind === kind && el._close) el._close();
}
