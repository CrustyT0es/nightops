// Night Ops: full-screen moments for big events.
// moment({ kicker, title, line, kind, ms = 1800, tap = true }) -> Promise (resolves when it's gone)
// Kinds: 'hunter', 'hider', 'ping', 'caught', 'radar', 'win', 'sos'. A huge title, the kicker in mono caps
// above it, one line under it, on a background tinted in the kind's colour. One at a time: others wait their
// turn (only the newest two wait; older ones are skipped). Tap (or Esc) closes it when `tap` is true; with
// tap false, taps go through to the screen underneath. Nothing is shown while the page is hidden.
import { h } from '../dom.js?v=172';

export const MOMENT_KINDS = ['hunter', 'hider', 'ping', 'caught', 'radar', 'win', 'sos'];
MOMENT_KINDS.push('checkpoint'); // v1.3 PAGE-PLAY: checkpoint violet (css/cpplay.css)
const OUT_MS = 200;
const NS = 'http://www.w3.org/2000/svg';

const waiting = [];
let showing = null;

function reducedMotion() {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function rings() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'moment-rings');
  const add = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
    return el;
  };
  add('circle', { cx: 100, cy: 100, r: 96, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.6, opacity: 0.35 });
  add('circle', { cx: 100, cy: 100, r: 70, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.8, opacity: 0.45, 'stroke-dasharray': '2 5' });
  add('circle', { cx: 100, cy: 100, r: 44, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.6, opacity: 0.3 });
  add('path', { d: 'M100 0v26M100 174v26M0 100h26M174 100h26', stroke: 'currentColor', 'stroke-width': 0.8, opacity: 0.5 });
  add('path', { class: 'moment-sweep', d: 'M100 100 L100 4', stroke: 'currentColor', 'stroke-width': 1.2, opacity: 0.6 });
  return svg;
}

// Shrink the title until its longest word fits the width.
function fitTitle(el) {
  let size = parseFloat(getComputedStyle(el).fontSize) || 64;
  let guard = 20;
  while (el.scrollWidth > el.clientWidth + 1 && size > 30 && guard-- > 0) {
    size -= 4;
    el.style.fontSize = `${size}px`;
  }
}

function next() {
  const item = waiting.shift();
  if (!item) {
    showing = null;
    return;
  }
  if (document.visibilityState === 'hidden') {
    item.resolve();
    next();
    return;
  }
  showing = item;
  const o = item.opts || {};
  const kind = MOMENT_KINDS.includes(o.kind) ? o.kind : 'ping';
  const tap = o.tap !== false;
  const ms = Number.isFinite(o.ms) && o.ms > 0 ? o.ms : 1800;

  const title = h('h2.moment-title', String(o.title ?? ''));
  const layer = h(`div.moment.m-${kind}${tap ? '.tappable' : ''}`,
    h('div.moment-glow', { 'aria-hidden': 'true' }),
    rings(),
    h('div.moment-inner', { role: 'alert' },
      o.kicker ? h('p.moment-kicker', String(o.kicker)) : null,
      title,
      o.line ? h('p.moment-line', String(o.line)) : null),
    tap ? h('p.moment-hint', { 'aria-hidden': 'true' }, 'Tap to close') : null);

  let done = false;
  let timer = null;
  function hide() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    layer.classList.add('out');
    setTimeout(() => {
      layer.remove();
      item.resolve();
      next();
    }, reducedMotion() ? 0 : OUT_MS);
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  }
  if (tap) {
    layer.addEventListener('click', hide);
    document.addEventListener('keydown', onKey, true);
  }
  document.body.appendChild(layer);
  fitTitle(title);
  // The web font may arrive a moment later and be wider: fit again then.
  try { document.fonts?.ready?.then(() => { if (!done) fitTitle(title); }); } catch { /* old browser */ }
  setTimeout(() => { if (!done) fitTitle(title); }, 300);
  timer = setTimeout(hide, ms);
}

export function moment(opts = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
      resolve();
      return;
    }
    waiting.push({ opts, resolve });
    while (waiting.length > 2) waiting.shift().resolve();
    if (!showing) next();
  });
}
