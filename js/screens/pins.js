// Night Ops v1.4 (PAGE-PLAY): team pins. Hunters and the driver drop pins only their own team sees.
//
//   pinsFor(view, d)          -> the list for map.setPins (pure; d = ms since the view came)
//   pinWords(pin)             -> "Sam: go here. Note: by the gate"
//   createPinTool(app, { map, getView, banner, navigate }) -> { btn, update(view), arm(), tapPin(key), destroy() }
//       the tray's "Pin" button: the next map tap opens the drop sheet; a pin tapped shows its words (+ Remove;
//       v1.4.8: + Navigate on the driver's phone, for a Driver: go here or Go here pin, when `navigate(pin)` is given)
import { h, text, cls } from '../dom.js?v=169';
import { icon } from '../ui/icons.js?v=169';
import { openSheet } from '../ui/sheet.js?v=169';
import { LIMITS } from '../../shared/rules.js?v=169';

// 'Hider seen' pins are never shown to the driver (they only see hunters): use 'Driver: go here' for them.
export const PIN_HINT = "The driver doesn't see Hider seen pins. Use Driver: go here.";
export const PIN_LABEL = { seen: 'Hider seen', go: 'Go here', driver: 'Driver: go here' };
export const PIN_SAY = { seen: 'hider seen here', go: 'go here', driver: 'driver, go here' };
export const ARM_WORDS = 'Tap the map where the pin goes.';
export const PIN_NOTE_MOST = (LIMITS && LIMITS.pinNote) || 40;

const isPoint = (p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function agoShort(ms) {
  const m = Math.floor((Number(ms) || 0) / 60000);
  return m < 1 ? 'now' : `${m} min`;
}

// The pins this view may show: hunters (the driver too) only; never anyone else's view, which has view.pins null.
export function pinsFor(view, d = 0) {
  const list = view && Array.isArray(view.pins) ? view.pins : [];
  const extra = Math.max(0, Number(d) || 0);
  return list.filter((p) => p && p.id && isPoint(p.p) && (Number(p.left) || 0) - extra > 0).map((p) => ({
    key: `pin:${p.id}`,
    id: p.id,
    p: p.p,
    kind: PIN_LABEL[p.kind] ? p.kind : 'go',
    label: PIN_LABEL[p.kind] || 'Pin',
    sub: `${p.name || 'Someone'}, ${agoShort((Number(p.age) || 0) + extra)}${p.note ? ` · ${p.note}` : ''}`,
    mine: !!p.mine,
  }));
}

export function pinWords(pin) {
  if (!pin) return '';
  const base = `${pin.name || 'Someone'}: ${PIN_SAY[pin.kind] || 'pin'}.`;
  return pin.note ? `${base} Note: ${pin.note}` : base;
}

// Can this view drop pins? -> '' (yes) or the reason.
export function cantPin(view) {
  if (!view || view.phase !== 'live') return 'Pins are for the game.';
  if (!Array.isArray(view.pins)) return 'Team pins are off in this game.';
  if (view.paused) return 'The game is paused.';
  if (!(Number(view.pinsLeft) > 0)) return 'You have 3 pins. Remove one first.';
  return '';
}

// The kinds this phone may drop: [{ kind, label }] (Driver: go here needs a driver who isn't me; Pick me up here is
// a hunter's, never the driver's).
export function pinKinds(view) {
  const me = (view && view.me) || {};
  const drive = view && view.drive;
  const out = [{ kind: 'seen', label: PIN_LABEL.seen }, { kind: 'go', label: PIN_LABEL.go }];
  if (drive && drive.here && !me.driver) out.push({ kind: 'driver', label: PIN_LABEL.driver });
  if (drive && drive.here && !me.driver && !(drive.mine && (drive.mine.state === 'open' || drive.mine.state === 'coming'))) {
    out.push({ kind: 'pickup', label: 'Pick me up here' });
  }
  return out;
}

const okRes = (res) => !!res && !res.error;

export function openDropSheet(app, view, p, { banner = null } = {}) {
  const kinds = pinKinds(view);
  let pick = kinds[1] ? kinds[1].kind : kinds[0].kind;
  const btns = kinds.map((k) => {
    const b = h(`button.pin-kind.k-${k.kind}`, { type: 'button', 'aria-pressed': k.kind === pick ? 'true' : 'false' },
      h('span.pin-kind-dot', { 'aria-hidden': 'true' }), h('span', k.label));
    b.addEventListener('click', () => {
      pick = k.kind;
      for (const x of btns) x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    return b;
  });
  const note = h('input.pin-note', { type: 'text', maxlength: String(PIN_NOTE_MOST), placeholder: 'Note (you can leave it empty)', 'aria-label': 'Note', autocomplete: 'off' });
  const line = h('p.pin-line', `Lasts 5 minutes. ${Number(view.pinsLeft) || 0} left for you.`);
  return openSheet({
    title: 'Drop a pin',
    className: 'pin-sheet',
    body: [h('div.pin-kinds', btns), note, line].concat(view.drive && view.drive.here && !(view.me && view.me.driver) ? [h('p.pin-hint', PIN_HINT)] : []),
    actions: [
      {
        label: 'Drop it', kind: 'primary', keepOpen: true,
        onClick: async (close) => {
          const words = String(note.value || '').trim().slice(0, PIN_NOTE_MOST);
          const cmd = pick === 'pickup'
            ? { type: 'pickup', do: 'ask', p: [p[0], p[1]] }
            : { type: 'pin', do: 'add', kind: pick, p: [p[0], p[1]], note: words };
          const res = await app.cmd(cmd);
          if (okRes(res)) close();
          else if (banner && res && res.error && res.error.message) banner(res.error.message, 'warn');
        },
      },
      { label: 'Cancel', kind: 'ghost' },
    ],
  });
}

export function openPinInfo(app, view, pin, { navigate = null } = {}) {
  const me = (view && view.me) || {};
  const host = !!me.host;
  const canRemove = !!pin.mine || host;
  // v1.4.8: the driver's turn-by-turn to this pin
  const canGo = typeof navigate === 'function' && !!me.driver && (pin.kind === 'driver' || pin.kind === 'go');
  return openSheet({
    title: PIN_LABEL[pin.kind] || 'Pin',
    className: 'pin-sheet',
    body: [h('p.pin-info', pinWords(pin)), h('p.pin-line', `${agoShort(pin.age)} old · ${Math.max(1, Math.ceil((Number(pin.left) || 0) / 60000))} min left`)],
    actions: [
      canGo ? { label: 'Navigate', kind: 'primary', onClick: () => navigate(pin) } : null, // v1.4.8
      canRemove ? { label: 'Remove it', kind: 'danger', onClick: () => app.cmd({ type: 'pin', do: 'remove', pinId: pin.id }) } : null,
      { label: 'Close', kind: 'ghost' },
    ],
  });
}

export function createPinTool(app, { map = null, getView = () => app.view, banner = null, navigate = null } = {}) {
  const S = { armed: false, offTap: null, offPin: null, dead: false };
  const word = h('span', 'Pin');
  const btn = h('button.btn.tray-btn.pin-btn', { type: 'button', hidden: true, 'aria-pressed': 'false', 'aria-label': 'Drop a team pin' }, icon('pin', 22), word);

  function disarm() {
    S.armed = false;
    btn.setAttribute('aria-pressed', 'false');
    cls(btn, 'on', false);
    text(word, 'Pin');
    if (S.offTap) { S.offTap(); S.offTap = null; }
  }

  function arm() {
    const view = getView();
    const why = cantPin(view);
    if (why) { if (banner) banner(why, 'info'); return false; }
    if (!map || typeof map.onTap !== 'function') return false;
    if (S.armed) { disarm(); return false; }
    S.armed = true;
    btn.setAttribute('aria-pressed', 'true');
    cls(btn, 'on', true);
    text(word, 'Tap');
    if (banner) banner(ARM_WORDS, 'info');
    S.offTap = map.onTap((p) => {
      disarm();
      const v = getView();
      if (!cantPin(v)) openDropSheet(app, v, p, { banner });
    });
    return true;
  }
  btn.addEventListener('click', () => arm());

  function tapPin(key) {
    const view = getView();
    const id = String(key || '').replace(/^pin:/, '');
    const pin = view && Array.isArray(view.pins) ? view.pins.find((x) => x && x.id === id) : null;
    if (pin) openPinInfo(app, view, pin, { navigate }); // v1.4.8: navigate
  }
  if (map && typeof map.onPinTap === 'function') S.offPin = map.onPinTap(tapPin);

  return {
    btn,
    arm,
    tapPin,
    armed: () => S.armed,
    update(view) {
      if (S.dead) return;
      const on = !!(view && view.phase === 'live' && Array.isArray(view.pins) && view.me && view.me.status === 'in');
      btn.hidden = !on;
      if (!on && S.armed) disarm();
      if (map && typeof map.setPins === 'function') {
        try { map.setPins(on ? pinsFor(view) : []); } catch (e) { console.error(e); }
      }
    },
    destroy() {
      S.dead = true;
      disarm();
      if (S.offPin) S.offPin();
    },
  };
}
