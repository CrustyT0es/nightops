// Night Ops: bottom sheets.
// openSheet({ title, body, actions, dismissable = true, onClose, className }) -> { el, body, close() }
//   body:    a node, text, or a list of them
//   actions: [{ label, kind: 'primary'|'danger'|'ghost'|'', onClick(close), keepOpen, disabled }] as
//            full-width buttons; after onClick the sheet closes unless keepOpen
// A dialog over a scrim (role=dialog, aria-modal, labelled by its title). Focus moves in and back after;
// Esc, the scrim, the X, a swipe down and the phone's Back close it when dismissable; everything under it is
// inert. Pocket mode stays on top of any sheet (it catches the touches; its double tap shows the sheet).
// Put `autofocus` on an element in the body to start there (else the sheet itself gets focus).
import { h, add } from '../dom.js?v=163';
import { icon } from './icons.js?v=163';
import { holdInert } from './inert.js?v=163';
import { backButton } from './back.js?v=163';

const stack = [];
let seq = 0;
const OUT_MS = 200;

function reducedMotion() {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

// Make everything but this layer, the banners and pocket mode inert; returns how to undo it. (Counted: what
// another sheet or pocket mode still holds stays inert.)
function shut(layer) {
  const releases = [];
  for (const el of document.body.children) {
    if (el === layer || el.classList.contains('banners') || el.classList.contains('pocket') || el.tagName === 'SCRIPT') continue;
    releases.push(holdInert(el));
  }
  return releases;
}

function reopen(releases) {
  for (const release of releases) release();
}

// The phone's Back closes the top sheet when it may be closed by accident (else it stays).
function closeTop() {
  const top = stack[stack.length - 1];
  if (!top || !top.dismissable) return false;
  top.close();
  return true;
}

function tellBack() {
  try { backButton.sheets(stack.length, closeTop); } catch (e) { console.error(e); }
}

export function openSheet({
  title = '',
  body = null,
  actions = [],
  dismissable = true,
  onClose = null,
  className = '',
} = {}) {
  const id = `sheet-${++seq}`;
  const before = document.activeElement;
  const titleEl = h('h2.sheet-title', { id: `${id}-title` }, String(title ?? ''));
  const bodyEl = h('div.sheet-body');
  add(bodyEl, [body]);

  let closed = false;
  const entry = { layer: null, inerted: [], close: null, dismissable: !!dismissable };

  const buttons = (Array.isArray(actions) ? actions : []).filter(Boolean).map((a) => {
    const kind = ['primary', 'danger', 'ghost'].includes(a.kind) ? `.${a.kind}` : '';
    const b = h(`button.btn.wide${kind}`, { type: 'button', disabled: !!a.disabled }, String(a.label ?? ''));
    b.addEventListener('click', () => {
      if (closed) return;
      let result;
      try {
        result = typeof a.onClick === 'function' ? a.onClick(close) : undefined;
      } catch (e) {
        console.error(e);
      }
      if (result && typeof result.catch === 'function') result.catch((e) => console.error(e));
      if (!a.keepOpen) close();
    });
    return b;
  });

  const closeBtn = dismissable
    ? h('button.sheet-close', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('close', 22))
    : null;
  const grip = h('div.sheet-grip', { 'aria-hidden': 'true' });
  const head = h('div.sheet-head', titleEl, closeBtn);
  const sheet = h('div.sheet', {
    role: 'dialog',
    'aria-modal': 'true',
    tabindex: '-1',
    ...(title ? { 'aria-labelledby': titleEl.id } : { 'aria-label': 'Dialog' }),
  }, grip, head, bodyEl, buttons.length ? h('div.sheet-actions', buttons) : null);
  if (!title) head.classList.add('no-title');
  if (className) {
    for (const c of String(className).split(/\s+/).filter(Boolean)) sheet.classList.add(c);
  }
  const scrim = h('div.scrim', { 'aria-hidden': 'true' });
  const layer = h('div.sheet-layer', scrim, sheet);
  entry.layer = layer;
  entry.close = close;

  scrim.addEventListener('click', () => { if (dismissable) close(); });

  function onKey(e) {
    if (stack[stack.length - 1] !== entry) return;
    if (e.key === 'Escape' && dismissable) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      // A focus trap for browsers without `inert`.
      const list = focusables(sheet);
      if (!list.length) {
        e.preventDefault();
        sheet.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  document.addEventListener('keydown', onKey, true);

  // Swipe the top of the sheet down to close it.
  if (dismissable) {
    let startY = null;
    let dy = 0;
    const down = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest && e.target.closest('button')) return;
      startY = e.clientY;
      dy = 0;
      sheet.classList.add('dragging');
      try { head.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };
    const move = (e) => {
      if (startY === null) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = dy ? `translateY(${dy}px)` : '';
    };
    const up = () => {
      if (startY === null) return;
      startY = null;
      sheet.classList.remove('dragging');
      if (dy > 90) close();
      else sheet.style.transform = '';
    };
    for (const el of [grip, head]) {
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
  }

  // (Under pocket mode, if it's on: pocket mode stays on top.)
  const pocket = [...document.body.children].find((el) => el.classList.contains('pocket'));
  if (pocket) document.body.insertBefore(layer, pocket);
  else document.body.appendChild(layer);
  entry.inerted = shut(layer);
  stack.push(entry);
  document.documentElement.classList.add('sheet-open');
  tellBack();

  const start = bodyEl.querySelector('[autofocus]');
  try { (start || sheet).focus({ preventScroll: true }); } catch { (start || sheet).focus(); }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    const i = stack.indexOf(entry);
    reopen(entry.inerted); // (what another sheet or pocket mode holds stays inert)
    entry.inerted = [];
    if (i !== -1) stack.splice(i, 1);
    if (!stack.length) document.documentElement.classList.remove('sheet-open');
    tellBack();
    layer.classList.add('out');
    setTimeout(() => layer.remove(), reducedMotion() ? 0 : OUT_MS);
    if (!stack.length && before && before.isConnected && typeof before.focus === 'function') {
      try { before.focus({ preventScroll: true }); } catch { before.focus(); }
    } else if (stack.length) {
      const top = stack[stack.length - 1].layer.querySelector('.sheet');
      if (top) top.focus({ preventScroll: true });
    }
    if (typeof onClose === 'function') {
      try { onClose(); } catch (e) { console.error(e); }
    }
  }

  return { el: sheet, body: bodyEl, close, layer };
}

// Close every open sheet (leaving a game, switching screens).
export function closeSheets() {
  for (const entry of [...stack].reverse()) entry.close();
}

export function sheetOpen() {
  return stack.length > 0;
}
