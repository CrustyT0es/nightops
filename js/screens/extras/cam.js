// Night Ops: the lobby's Camera row (v1.2, PAGE-CAM).  extraRow(ctx) -> { el, update(view) }
// ctx = { app, host, setSetting(key, value), cmd(cmd) -> Promise }.
// The host: the switch, and when it's on, Highlights or Everything. Everyone else: the setting in words.
// When it's on, every player has "I'm OK being recorded" (a switch; its first tap also asks for the camera and
// microphone once and shows a small mirror for 3 s). The host sees how many said OK and who isn't filmed.
import { h, text, cls, fill } from '../../dom.js?v=154';
import { icon } from '../../ui/icons.js?v=154';
import { EXTRAS_UI, CAM_MODES_UI } from '../../../shared/rules.js?v=154';
import { CONSTRAINTS } from '../../camera.js?v=154';

const ITEM = EXTRAS_UI.find((x) => x.key === 'cam') || {
  key: 'cam', label: 'Camera', hint: 'Phones film clips with the selfie camera for the replay. Only people who say OK are filmed.',
};
const MODES = Array.isArray(CAM_MODES_UI) && CAM_MODES_UI.length ? CAM_MODES_UI : [
  { value: 'highlights', label: 'Highlights', line: 'Short clips around the big moments. Smaller to upload.' },
  { value: 'everything', label: 'Everything', line: 'Films the whole game. Big uploads: use wifi.' },
];
export const PEND_MS = 5000;
export const MIRROR_MS = 3000;
export const WORDS = {
  rule: 'Only people who say OK are filmed. Spectators are never filmed.',
  again: 'Everyone needs to say OK again.',
  ok: "I'm OK being recorded",
  okLine: 'Your selfie camera and microphone film clips during the game. Only for the replay of this game.',
  blocked: "The camera is blocked on this phone. Allow it in your browser's settings. You can still say OK.",
  none: 'Nobody has said OK yet.',
};

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

function names(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// What the row says (pure): { on, mode, modeWords, okLine (host: "3 of 5 OK"), notFilmed ("Leo isn't filmed."),
// mine (my OK, or null for a phone that isn't a player) }.
export function camRowState(view, pending = {}) {
  const s = (view && view.settings) || {};
  const on = pending.on !== undefined ? !!pending.on : !!s.cam;
  const mode = pending.mode !== undefined ? pending.mode : (s.camMode === 'everything' ? 'everything' : 'highlights');
  const m = MODES.find((x) => x.value === mode) || MODES[0];
  const cam = view && view.cam && typeof view.cam === 'object' ? view.cam : null;
  const mine = view && view.me ? (pending.ok !== undefined ? !!pending.ok : !!(cam && cam.ok)) : null;
  let okLine = '';
  let notFilmed = '';
  if (on && cam) {
    okLine = `${cam.okCount || 0} of ${cam.inCount || 0} OK`;
    if (Array.isArray(cam.okIds)) {
      const ok = new Set(cam.okIds);
      const left = ((view && view.players) || []).filter((p) => p && p.status === 'in' && !ok.has(p.id)).map((p) => String(p.name || ''));
      if (left.length === 1) notFilmed = `${left[0]} isn't filmed.`;
      else if (left.length > 1) notFilmed = `${names(left)} aren't filmed.`;
    }
  }
  return { on, mode, modeWords: m.label, modeLine: m.line, okLine, notFilmed, mine };
}

// ---- the row ----------------------------------------------------------------------------------------------

export function extraRow(ctx = {}) {
  const { app, host } = ctx;
  const S = { view: null, pendOn: undefined, pendOnAt: 0, pendMode: undefined, pendModeAt: 0, pendOk: undefined, pendOkAt: 0, again: false, asked: false, wasOk: false, okKey: '' };
  const now = () => Date.now();

  const label = h('div.lobby-set-label.x-cam-label', icon('camera', 20), h('span', ITEM.label));
  let control;
  if (host) {
    control = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': ITEM.label });
    control.addEventListener('click', () => {
      const st = camRowState(S.view, pending());
      S.pendOn = !st.on;
      S.pendOnAt = now();
      S.again = true;
      ctx.setSetting('cam', S.pendOn);
      paint();
    });
  } else {
    control = h('span.lobby-set-value');
  }
  const hint = h('span.lobby-set-hint', ITEM.hint);
  const top = h('div.lobby-set.row.x-cam-head', { 'data-key': 'cam', 'data-anchor': '' }, label, control, hint);

  // The two choices (host: buttons; everyone: the words).
  const modeBtns = MODES.map((m) => {
    const b = h('button.x-cam-mode', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1' },
      h('span.x-cam-mode-name', m.label), h('span.x-cam-mode-line', m.line));
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-checked') === 'true') return;
      S.pendMode = m.value;
      S.pendModeAt = now();
      S.again = true;
      ctx.setSetting('camMode', m.value);
      paint();
    });
    return { m, b };
  });
  const modeGroup = h('div.x-cam-modes', { role: 'radiogroup', 'aria-label': 'What the camera films' }, modeBtns.map((x) => x.b));
  modeGroup.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = Math.max(0, modeBtns.findIndex((x) => x.b === document.activeElement));
    const next = modeBtns[(i + step + modeBtns.length) % modeBtns.length].b;
    next.focus();
    next.click();
  });
  const modeWords = h('p.x-cam-mode-words');
  const rule = h('p.x-cam-rule', icon('info', 18), h('span', WORDS.rule));
  const againLine = h('p.x-cam-again', { role: 'status', hidden: true }, WORDS.again);

  // I'm OK being recorded.
  const okSwitch = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': WORDS.ok });
  const okRow = h('div.x-cam-ok',
    h('div.x-cam-ok-text', h('span.x-cam-ok-title', WORDS.ok), h('span.x-cam-ok-line', WORDS.okLine)),
    okSwitch);
  const mirror = h('div.x-cam-mirror', { hidden: true, 'aria-hidden': 'true' });
  const blocked = h('p.x-cam-blocked', { hidden: true, role: 'status' }, WORDS.blocked);
  okSwitch.addEventListener('click', () => {
    const st = camRowState(S.view, pending());
    const next = !st.mine;
    S.pendOk = next;
    S.pendOkAt = now();
    Promise.resolve(ctx.cmd({ type: 'camok', ok: next })).catch(() => null).then(() => {
      S.pendOk = undefined;
      paint();
    });
    if (next && !S.asked) {
      S.asked = true;
      tryCamera();
    }
    paint();
  });

  const count = h('p.x-cam-count', { 'aria-live': 'polite' });
  const who = h('p.x-cam-who');
  const body = h('div.x-cam-body', { hidden: true }, host ? modeGroup : modeWords, rule, againLine, okRow, mirror, blocked, host ? count : null, host ? who : null);
  const el = h('div.x-row.x-cam', top, body);

  // Ask for the camera and microphone once (so the game screen needs no prompt), with a small mirror for 3 s.
  async function tryCamera() {
    const media = globalThis.navigator && navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== 'function') return;
    let stream = null;
    try {
      stream = await media.getUserMedia(CONSTRAINTS);
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) blocked.hidden = false;
      return;
    }
    blocked.hidden = true;
    const v = h('video', { muted: true, playsinline: true, autoplay: true });
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    fill(mirror, v);
    mirror.hidden = false;
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
    setTimeout(() => {
      for (const t of stream.getTracks()) try { t.stop(); } catch { /* ignore */ }
      v.srcObject = null;
      mirror.hidden = true;
      fill(mirror);
    }, MIRROR_MS);
  }

  function pending() {
    const t = now();
    const s = (S.view && S.view.settings) || {};
    if (S.pendOn !== undefined && (t - S.pendOnAt > PEND_MS || !!s.cam === S.pendOn)) S.pendOn = undefined;
    if (S.pendMode !== undefined && (t - S.pendModeAt > PEND_MS || s.camMode === S.pendMode)) S.pendMode = undefined;
    if (S.pendOk !== undefined && t - S.pendOkAt > PEND_MS) S.pendOk = undefined;
    return { on: S.pendOn, mode: S.pendMode, ok: S.pendOk };
  }

  function paint() {
    const st = camRowState(S.view, pending());
    if (host) control.setAttribute('aria-checked', st.on ? 'true' : 'false');
    else text(control, st.on ? st.modeWords : 'Off');
    body.hidden = !st.on;
    for (const { m, b } of modeBtns) {
      const picked = m.value === st.mode;
      b.setAttribute('aria-checked', picked ? 'true' : 'false');
      b.tabIndex = picked ? 0 : -1;
    }
    text(modeWords, `${st.modeWords}: ${st.modeLine}`);
    okRow.hidden = st.mine === null;
    okSwitch.setAttribute('aria-checked', st.mine ? 'true' : 'false');
    cls(okRow, 'on', !!st.mine);
    againLine.hidden = !(st.on && S.again);
    text(count, st.okLine);
    text(who, st.notFilmed || (st.okLine.startsWith('0 of') ? WORDS.none : ''));
    who.hidden = !who.textContent;
  }

  function update(v) {
    if (!v) return;
    const s = v.settings || {};
    const key = `${!!s.cam}:${s.camMode}`;
    // The host changed the camera: everyone's OK went back to no. Say so to whoever had said OK.
    if (S.okKey && S.okKey !== key && S.wasOk) S.again = true;
    S.okKey = key;
    const cam = v.cam && typeof v.cam === 'object' ? v.cam : null;
    if (cam && cam.ok) S.again = false;
    S.wasOk = !!(cam && cam.ok);
    S.view = v;
    paint();
  }

  return { el, update };
}
