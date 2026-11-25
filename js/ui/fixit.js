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
//
// v1.6.2 PERMS: helpView({ ..., ask, perm, onAnswer }) for location / mic / camera when the browser may still ask:
// one big "Allow location" button whose tap asks the browser itself (permissions.js), so its own Allow box shows.
// Only when the browser has blocked it for good ('denied', or a "no" with no box) does it say why and show the
// steps for this phone (with Try again, which asks again).
import { h, fill, text } from '../dom.js?v=178';
import { icon } from './icons.js?v=178';
import { holdInert } from './inert.js?v=178';
import { helpFor, stepParts, deviceKind } from '../help.js?v=178';
import { permState, lastAnswer, blockedWords, answerWords, LABELS, askLocation, askMic, askCamera } from '../permissions.js?v=178';

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

// v1.6.2 PERMS ------------------------------------------------------------------------------------------------------
export const ASKABLE = ['location', 'mic', 'camera'];
// the problems a tap on Allow can fix (the rest: location services off, no signal, no microphone... keep their steps)
export const ASK_WHYS = ['denied', 'asking', 'na', 'prompt', 'unanswered'];
const ICON_FOR = { location: 'locate', camera: 'camera', mic: 'mic', sound: 'speaker' };

// The part's own ask, from a tap (location: done once allowed; the watch finds the fix).
export function askFor(part) {
  if (part === 'mic') return () => askMic();
  if (part === 'camera') return () => askCamera();
  return () => askLocation({ waitFix: false });
}

// Which screen to start on: 'ask' (the big Allow button) or 'blocked' (why + the steps).
export function firstMode(part, perm, last = null) {
  if (perm === 'denied') return 'blocked';
  if (perm !== 'granted' && last && last.part === part && last.blocked) return 'blocked';
  return 'ask';
}

function askView({ part, why, kind, ask, perm, onAnswer, onLater, onReload, laterLabel, titleId }) {
  const S = { mode: firstMode(part, perm, lastAnswer(part)), why: ASK_WHYS.includes(why) ? 'denied' : why, busy: false };
  const last = lastAnswer(part);
  if (S.mode === 'blocked' && perm !== 'denied' && last && last.blocked && last.why) S.why = last.why;
  const title = h('h2.fx-title', titleId ? { id: titleId } : {});
  const line = h('p.fx-line');
  const reason = h('p.fx-why', { hidden: true });
  const hint = h('p.fx-ask-hint', 'Tap the button. When your phone asks, tap Allow.');
  const how = h('div.fx-how');
  const after = h('p.fx-after', { hidden: true });
  const word = h('span.fx-allow-word');
  // (.fx-try too: the screen's main button, as in the steps view)
  const allowBtn = h('button.btn.primary.wide.fx-allow.fx-try', { type: 'button' }, icon(ICON_FOR[part], 22), word);
  const reloadBtn = onReload ? h('button.btn.wide.fx-reload', { type: 'button', hidden: true, onclick: () => onReload() }, 'Reload Night Ops') : null;
  const laterBtn = onLater ? h('button.btn.ghost.wide.fx-later', { type: 'button', onclick: () => onLater() }, laterLabel) : null;
  const status = h('p.fx-status', { role: 'status', 'aria-live': 'polite' });
  const root = h('div.fx-help.fx-askview', { 'data-part': part, 'data-kind': kind },
    h('div.fx-icon', { 'aria-hidden': 'true' }, icon(ICON_FOR[part], 34)),
    title, line, reason, hint, how, after,
    h('div.fx-actions', allowBtn, reloadBtn, laterBtn),
    status);

  function paint() {
    const help = helpFor(part, S.why, kind);
    root.dataset.mode = S.mode;
    root.dataset.why = S.why;
    text(title, help.title);
    text(line, help.line);
    reason.hidden = S.mode !== 'blocked';
    text(reason, `${blockedWords(part)} Turn it back on like this:`);
    hint.hidden = S.mode !== 'ask';
    fill(how, S.mode === 'ask' ? null : stepList(help.steps));
    after.hidden = S.mode === 'ask' || !help.after;
    text(after, help.after || '');
    text(word, S.mode === 'ask' ? LABELS[part] : 'Try again');
    allowBtn.hidden = S.mode === 'done';
    if (S.mode === 'done') { hint.hidden = true; fill(how); after.hidden = true; }
    if (reloadBtn) reloadBtn.hidden = S.mode !== 'blocked';
  }

  allowBtn.addEventListener('click', () => {
    if (S.busy) return;
    S.busy = true;
    allowBtn.disabled = true;
    const blockedBefore = S.mode === 'blocked';
    fill(status, S.mode === 'ask' ? 'Asking your phone...' : 'Trying...');
    let p;
    try { p = ask(); } catch (e) { p = Promise.reject(e); } // (called in the tap itself: that shows the box)
    Promise.resolve(p).then((a) => {
      S.busy = false;
      allowBtn.disabled = false;
      if (!a) return;
      if (a.result === 'granted') S.mode = 'done';
      else if (a.blocked) { S.mode = 'blocked'; S.why = a.why || 'denied'; }
      else if (a.result === 'unavailable') { S.mode = 'steps'; S.why = a.why || 'off'; }
      else if (a.unsure) { S.mode = 'steps'; S.why = 'denied'; } // (may be blocked: the steps, and Try again stays)
      paint();
      root.dataset.result = a.result;
      // (a first block: the reason above the steps says it)
      fill(status, a.blocked && !blockedBefore ? '' : answerWords(a, { blockedBefore }));
      if (onAnswer) { try { onAnswer(a); } catch (e) { console.error(e); } }
    }, () => {
      S.busy = false;
      allowBtn.disabled = false;
      fill(status, "Couldn't ask. Tap the button again.");
    });
  });

  paint();
  // What the browser says about it (a moment later): blocked for good shows the steps at once.
  if (perm === undefined || perm === null) {
    permState(part).then((st) => {
      if (S.busy || S.mode !== 'ask') return;
      const m = firstMode(part, st, lastAnswer(part));
      if (m !== S.mode) { S.mode = m; paint(); }
    }).catch(() => {});
  }
  return root;
}
// v1.6.2 end PERMS --------------------------------------------------------------------------------------------------

export function helpView({ part = 'location', why = 'denied', kind = deviceKind(), onTry = null, onLater = null, onReload = null, tryLabel = 'Try again', laterLabel = "I'll fix it later", titleId = '', ask = null, perm = null, onAnswer = null } = {}) {
  // v1.6.2 PERMS: the Allow button first, where a tap can still make the browser ask
  if (ask && ASKABLE.includes(part) && ASK_WHYS.includes(why)) return askView({ part, why, kind, ask, perm, onAnswer, onLater, onReload, laterLabel, titleId });
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
// v1.6.2 PERMS: ask (from permissions.js; default: the part's own) shows the Allow button where it can still help;
// onAnswer(answer) hears each answer, and a yes closes the layer by itself after GRANT_CLOSE_MS.
export const GRANT_CLOSE_MS = 1400;
const reloadPage = () => { try { globalThis.location.reload(); } catch { /* ignore */ } };
export function openHelp({ part, why, kind = deviceKind(), onTry = null, onClose = null, ask, perm = null, onAnswer = null, onReload } = {}) {
  seq += 1;
  const id = `fx-t${seq}`;
  const before = document.activeElement;
  let release = () => {};
  const closeBtn = h('button.fx-close', { type: 'button', 'aria-label': 'Close' }, icon('close', 22));
  const asking = ask === undefined ? (ASKABLE.includes(part) ? askFor(part) : null) : ask;
  const view = helpView({
    part, why, kind, onTry, onLater: () => close(), laterLabel: 'Close', titleId: id,
    ask: asking,
    perm,
    // (Safari keeps a "Don't Allow" until the page reloads: the game comes back by itself)
    onReload: onReload === undefined ? (IOS_KINDS.includes(kind) ? reloadPage : null) : onReload,
    onAnswer: (a) => {
      if (onAnswer) { try { onAnswer(a); } catch (e) { console.error(e); } }
      if (a && a.result === 'granted') setTimeout(() => close(), GRANT_CLOSE_MS);
    },
  });
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

// v1.6.2 PERMS: from a tap, ask the browser for `part` at once (its own Allow box). Blocked for good, or not
// working for another reason: the help layer with the steps. -> Promise<Answer>
export function allowOrHelp(part, { kind = deviceKind(), onTry = null, onAnswer = null } = {}) {
  return askFor(part)().then((a) => {
    const again = () => askFor(part)().then((x) => answerWords(x, { blockedBefore: true }));
    if (a && (a.blocked || a.result === 'unavailable')) openHelp({ part, why: a.why || 'denied', kind, onTry: onTry || again, perm: a.blocked ? 'denied' : null });
    if (onAnswer) { try { onAnswer(a); } catch (e) { console.error(e); } }
    return a;
  });
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
    // v1.6.2 PERMS: blocked -> the browser's own Allow box straight from this tap; the steps only if it can't ask
    if (st.cam === 'denied' || st.mic === 'denied') allowOrHelp(st.cam === 'denied' ? 'camera' : 'mic', { kind, onTry: () => media.restore().then((s) => (s ? '' : 'Still not working.')) });
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
      // v1.6.2 PERMS: blocked -> "Allow location" asks the browser itself (app.js restarts the watch on a yes)
      ask: why === 'denied' ? askFor('location') : null,
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
