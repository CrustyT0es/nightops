// Night Ops v1.4 (PAGE-DEVICES): "Your location is off", the red bar, and "Tap to turn your camera and mic back on".
//
//   helpView({ part, why, kind, onTry, onLater, tryLabel }) -> element   the steps for this phone (help.js), drawn
//   openHelp({ part, why, kind, onTry }) -> { close() }                   the same as a full-screen layer (lobby "Fix it")
//   createFixIt({ app, root }) -> { el, bar, tapBtn, update(view), destroy(), statusWord(view), lostWords(view),
//                                   everyoneRows(view) }
//
// During a live game: when the watchdog says 'denied', 'off' or 'timeout' (or 'stale' for STALE_SHOUT_MS more), a
// full-screen layer over the map and tray (under sheets, moments, SOS and pocket mode). It goes by itself as soon as
// a fix comes; "I'll fix it later" leaves a red bar ("Location off. Fix it") until then. Retries go on underneath.
import { h, fill } from '../dom.js?v=151';
import { icon } from './icons.js?v=151';
import { holdInert } from './inert.js?v=151';
import { helpFor, stepParts, deviceKind } from '../help.js?v=151';

export const STALE_SHOUT_MS = 30000;
export const LOST = ['denied', 'off'];
// A single timeout (indoors, under trees) often clears at the next try: it waits like 'stale'.
export const SLOW = ['timeout', 'stale'];
export const IOS_KINDS = ['ios-safari', 'ios-app'];

// Should the layer show? health: loc.health(); staleFor: ms it has been 'stale'.
export function locShouts(health, staleFor = 0) {
  if (LOST.includes(health)) return true;
  return SLOW.includes(health) && staleFor >= STALE_SHOUT_MS;
}

// After Try again: on an iPhone, Safari keeps a "Don't Allow" until the page reloads.
export function wantsReload(kind, health) {
  return IOS_KINDS.includes(kind) && health === 'denied';
}

// "Location: live" / "Location: 30 s old" / "Location: off" from view.me.fix and the watchdog's word.
export function locStatus(fix, health) {
  if (LOST.includes(health)) return 'Location: off';
  if (health === 'timeout' && !(fix && fix.state === 'live')) return 'Location: finding you...';
  if (fix && fix.state === 'live') return 'Location: live';
  if (fix && fix.state === 'old' && Number.isFinite(fix.age)) return `Location: ${Math.max(1, Math.round(fix.age / 1000))} s old`;
  if (health === 'ok') return 'Location: live';
  if (fix && fix.state === 'lost') return 'Location: off';
  if (health === 'asking') return 'Location: finding you...';
  if (fix && fix.state === 'old') return 'Location: old';
  return health === 'stale' ? 'Location: off' : 'Location: finding you...';
}

// HUD words for the team's view.locLost ("No location from Ava", "No location from Ava and Leo", "... and 2 more").
export function lostWords(list) {
  const names = (Array.isArray(list) ? list : []).map((p) => p && p.name).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return `No location from ${names[0]}`;
  if (names.length === 2) return `No location from ${names[0]} and ${names[1]}`;
  return `No location from ${names[0]} and ${names.length - 1} more`;
}

const WHY_WORDS = { denied: 'location blocked', off: 'location off', timeout: "can't find them", stale: 'location stopped', none: 'no location yet', quiet: 'no signal' };
export function lostLine(p) {
  const mins = Number.isFinite(p.since) ? Math.floor(p.since / 60000) : 0;
  return `${p.name}: ${WHY_WORDS[p.why] || 'no location'}${mins >= 1 ? ` for ${mins} min` : ''}`;
}

function stepList(steps) {
  return h('ol.fx-steps', steps.map((st) => h('li', stepParts(st).map((part) => (part.bold ? h('strong', part.text) : part.text)))));
}

export function helpView({ part = 'location', why = 'denied', kind = deviceKind(), onTry = null, onLater = null, onReload = null, tryLabel = 'Try again', laterLabel = "I'll fix it later", titleId = '' } = {}) {
  const help = helpFor(part, why, kind);
  const iconName = part === 'location' ? 'locate' : part === 'camera' ? 'camera' : part === 'mic' ? 'mic' : 'speaker';
  const tryBtn = onTry ? h('button.btn.primary.wide.fx-try', { type: 'button' }, tryLabel) : null;
  const status = h('p.fx-status', { role: 'status', 'aria-live': 'polite' });
  const reloadBtn = onReload ? h('button.btn.wide.fx-reload', { type: 'button', hidden: true, onclick: () => onReload() }, 'Reload Night Ops') : null;
  if (tryBtn) {
    tryBtn.addEventListener('click', async () => {
      tryBtn.disabled = true;
      fill(status, 'Trying...');
      let res = null;
      try { res = await onTry(); } catch { res = null; }
      tryBtn.disabled = false;
      const word = res && typeof res === 'object' ? res.words : res;
      fill(status, typeof word === 'string' ? word : '');
      if (reloadBtn && res && typeof res === 'object' && res.reload) reloadBtn.hidden = false;
    });
  }
  const laterBtn = onLater ? h('button.btn.ghost.wide.fx-later', { type: 'button', onclick: () => onLater() }, laterLabel) : null;
  return h('div.fx-help', { 'data-part': part, 'data-why': why, 'data-kind': kind },
    h('div.fx-icon', { 'aria-hidden': 'true' }, icon(iconName, 34)),
    h('h2.fx-title', titleId ? { id: titleId } : {}, help.title),
    h('p.fx-line', help.line),
    stepList(help.steps),
    help.after ? h('p.fx-after', help.after) : null,
    h('div.fx-actions', tryBtn, reloadBtn, laterBtn),
    status);
}

let seq = 0;
// A full-screen help layer (from the ready check's "Fix it", or a camera/mic chip). Esc and Close close it.
export function openHelp({ part, why, kind = deviceKind(), onTry = null, onClose = null } = {}) {
  seq += 1;
  const id = `fx-t${seq}`;
  const before = document.activeElement;
  let release = () => {};
  const closeBtn = h('button.fx-close', { type: 'button', 'aria-label': 'Close' }, icon('close', 22));
  const view = helpView({ part, why, kind, onTry, onLater: () => close(), laterLabel: 'Close', titleId: id });
  const layer = h('div.fx-layer.fx-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id, tabindex: '-1' },
    h('div.fx-scroll', closeBtn, view));
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    release();
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
    try { if (before && before.focus) before.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (onClose) onClose();
  }
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  const app = document.getElementById('app');
  if (app) release = holdInert(app);
  document.body.appendChild(layer);
  try { layer.focus({ preventScroll: true }); } catch { /* ignore */ }
  return { el: layer, close };
}

// ---- the game screen's parts ----
export function createFixIt({ app, root = null, now = () => Date.now(), kind = deviceKind(), reload = () => { try { globalThis.location.reload(); } catch { /* ignore */ } }, wait = 4000 } = {}) {
  const loc = app && app.location;
  const media = app && app.media;
  const S = { view: null, later: false, shown: false, staleAt: null, health: 'none', release: null, dead: false, before: null };
  const titleId = 'fx-loc-title';
  const layer = h('div.fx-layer.fx-loc', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1', hidden: true });
  const bar = h('button.fx-bar', { type: 'button', hidden: true }, icon('warn', 18), h('span.fx-bar-word', 'Location off. Fix it'));
  bar.addEventListener('click', () => { S.later = false; paint(true); });
  const tapBtn = h('button.btn.primary.fx-tapback', { type: 'button', hidden: true }, icon('camera', 22), h('span', 'Tap to turn your camera and mic back on'));
  tapBtn.addEventListener('click', () => {
    if (!media) return;
    const st = media.state;
    if (st.cam === 'denied' || st.mic === 'denied') openHelp({ part: st.cam === 'denied' ? 'camera' : 'mic', why: 'denied', kind, onTry: () => media.restore().then((s) => (s ? '' : 'Still blocked.')) });
    else media.restore();
  });

  function liveAndIn(v) {
    return !!(v && v.phase === 'live' && v.me && v.me.status === 'in');
  }

  function draw(why) {
    fill(layer, h('div.fx-scroll', helpView({
      part: 'location',
      why,
      kind,
      titleId,
      onTry: () => {
        try { if (loc && loc.retry) loc.retry(); } catch { /* ignore */ }
        return new Promise((r) => setTimeout(() => {
          const hl = loc && loc.health ? loc.health() : 'none';
          if (hl === 'ok') r('Found you.');
          else if (wantsReload(kind, hl)) r({ words: 'Still blocked. Reload Night Ops: the game comes back by itself.', reload: true });
          else r('Still looking. Keep this open.');
        }, wait));
      },
      onReload: IOS_KINDS.includes(kind) ? () => reload() : null,
      onLater: () => { S.later = true; paint(); },
    })));
    layer.dataset.why = why;
  }

  function paint(focus = false) {
    if (S.dead) return;
    const v = S.view;
    const health = loc && typeof loc.health === 'function' ? loc.health() : 'ok';
    const t = now();
    if (SLOW.includes(health)) { if (S.staleAt === null) S.staleAt = t; } else S.staleAt = null;
    const wrong = liveAndIn(v) && locShouts(health, S.staleAt === null ? 0 : t - S.staleAt);
    if (!wrong) S.later = false;
    const show = wrong && !S.later;
    if (show && (!S.shown || layer.dataset.why !== health)) draw(health);
    if (show && !S.shown) {
      S.before = document.activeElement;
      layer.hidden = false;
      if (root) S.release = holdInert(root);
      try { layer.focus({ preventScroll: true }); } catch { /* ignore */ }
    } else if (!show && S.shown) {
      layer.hidden = true;
      if (S.release) { S.release(); S.release = null; }
      try { if (S.before && S.before.isConnected && S.before.focus) S.before.focus({ preventScroll: true }); } catch { /* ignore */ }
    } else if (show && focus) {
      try { layer.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    S.shown = show;
    bar.hidden = !(wrong && S.later);
    // the camera / mic tap button
    const st = media ? media.state : null;
    tapBtn.hidden = !(st && st.needsTap && v && v.phase === 'live');
    S.health = health;
  }

  const offLoc = loc && typeof loc.on === 'function' ? loc.on(() => paint()) : () => {};
  const offMedia = media && typeof media.on === 'function' ? media.on('state', () => paint()) : () => {};
  const timer = setInterval(() => paint(), 1000);
  document.body.appendChild(layer);

  return {
    el: layer,
    bar,
    tapBtn,
    update(view) { S.view = view; paint(); },
    handling: () => S.shown || !bar.hidden,
    statusWord(view) {
      const health = loc && typeof loc.health === 'function' ? loc.health() : 'ok';
      return locStatus(view && view.me ? view.me.fix : null, health);
    },
    lostWords(view) { return lostWords(view && view.locLost); },
    // The host's "Everyone's phones" (menu): one line each from view.locLost, or "Everyone's location is live."
    everyoneRows(view) {
      const list = (view && view.locLost) || [];
      return list.length ? list.map(lostLine) : ["Everyone's location is live."];
    },
    destroy() {
      S.dead = true;
      clearInterval(timer);
      offLoc();
      offMedia();
      if (S.release) { S.release(); S.release = null; }
      layer.remove();
    },
  };
}
