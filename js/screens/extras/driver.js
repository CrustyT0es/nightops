// Night Ops: the lobby's Driver row (v1.1, PAGE-DRIVER). extraRow(ctx) -> { el, update(view) }
// ctx = { app, host, setSetting(key, value), cmd(cmd) -> Promise }.
// Host: the switch (greyed, with the reason, when a driver isn't possible: driverProblem), and when it's on,
// "Who drives": Pick for me, or one of the players. Everyone else: the setting in words.
import { h, fill, text, cls } from '../../dom.js?v=145';
import { icon } from '../../ui/icons.js?v=145';
import { EXTRAS_UI, driverProblem } from '../../../shared/rules.js?v=145';

const ITEM = EXTRAS_UI.find((x) => x.key === 'driver') || { key: 'driver', label: 'Driver', hint: '' };
export const PEND_MS = 5000; // a change on its way shows for at most this long before the view decides

// The players who could drive (everyone in, in the lobby's order).
export function playersIn(view) {
  return ((view && view.players) || []).filter((p) => p && p.status === 'in');
}

// What the row says, from the view (pure, tested): { on, problem, pick, pickName, words }.
export function driverRowState(view, pending = {}) {
  const s = (view && view.settings) || {};
  const list = playersIn(view);
  const problem = driverProblem(s, list.length, list.filter((p) => p.pick === 'hunter').length);
  const want = pending.on === undefined ? !!s.driver : !!pending.on;
  const on = want && !problem;
  const pickId = pending.pick === undefined ? (view && view.driverPick) || null : pending.pick;
  const picked = pickId ? list.find((p) => p.id === pickId) : null;
  const pick = picked ? picked.id : null;
  const pickName = picked ? String(picked.name || '') : '';
  const words = on ? 'On' : 'Off';
  return { on, problem, pick, pickName, words, setOn: !!s.driver };
}

export function extraRow(ctx) {
  const { app, host } = ctx || {};
  const S = { pendOn: undefined, pendOnAt: 0, pendPick: undefined, pendPickAt: 0, view: null, offSent: '', pickKey: '' };
  const now = () => Date.now();

  const label = h('div.lobby-set-label', icon('car', 20), h('span', ITEM.label));
  const hint = h('span.lobby-set-hint', ITEM.hint);
  const problemLine = h('p.drive-x-problem', { hidden: true, role: 'note' }, icon('info', 18), h('span'));
  const whoTitle = h('span.label.drive-x-who-title', 'Who drives');
  const whoChips = h('div.drive-x-chips', { role: 'radiogroup', 'aria-label': 'Who drives' });
  const whoNote = h('p.lobby-hint.drive-x-who-note');
  const who = h('div.drive-x-who', { hidden: true }, whoTitle, whoChips, whoNote);
  let control;
  if (host) {
    control = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': ITEM.label });
    control.addEventListener('click', () => {
      if (control.getAttribute('aria-disabled') === 'true') return;
      const st = driverRowState(S.view, pending());
      if (st.problem) return;
      const next = !st.on;
      S.pendOn = next;
      S.pendOnAt = now();
      ctx.setSetting('driver', next);
      paint();
    });
  } else {
    control = h('span.lobby-set-value');
  }
  const top = h('div.lobby-set.row.drive-x', { 'data-key': 'driver', 'data-anchor': '' }, label, control, hint);
  const el = h('div.drive-x-block', top, problemLine, who);

  function pending() {
    const t = now();
    if (S.pendOn !== undefined && (t - S.pendOnAt > PEND_MS || (S.view && S.view.settings && !!S.view.settings.driver === S.pendOn))) S.pendOn = undefined;
    if (S.pendPick !== undefined && (t - S.pendPickAt > PEND_MS || (S.view && (S.view.driverPick || null) === S.pendPick))) S.pendPick = undefined;
    return { on: S.pendOn, pick: S.pendPick };
  }

  function pickDriver(id) {
    S.pendPick = id;
    S.pendPickAt = now();
    Promise.resolve(ctx.cmd({ type: 'driver', playerId: id })).catch(() => null).then(() => {
      S.pendPick = undefined;
      paint();
    });
    paint();
  }

  function chip(id, words, picked) {
    const b = h('button.chip.drive-x-chip', { type: 'button', role: 'radio', 'aria-checked': picked ? 'true' : 'false' },
      id ? null : icon('shuffle', 18), words);
    cls(b, 'on', picked);
    b.addEventListener('click', () => { if (b.getAttribute('aria-checked') !== 'true') pickDriver(id); });
    return b;
  }

  function paint() {
    const view = S.view;
    if (!view) return;
    const st = driverRowState(view, pending());
    // A driver that can't be any more (players left, Infection): the host's phone turns it off once.
    if (host && st.problem && st.setOn && S.pendOn === undefined && S.offSent !== st.problem) {
      S.offSent = st.problem;
      ctx.setSetting('driver', false);
    }
    if (!st.problem) S.offSent = '';
    problemLine.hidden = !st.problem;
    text(problemLine.lastChild, st.problem);
    cls(top, 'off', !st.on);
    if (host) {
      control.setAttribute('aria-checked', st.on ? 'true' : 'false');
      if (st.problem) {
        control.setAttribute('aria-disabled', 'true');
        control.setAttribute('aria-label', `${ITEM.label}: ${st.problem}`);
      } else {
        control.removeAttribute('aria-disabled');
        control.setAttribute('aria-label', ITEM.label);
      }
    } else {
      text(control, st.words);
    }
    who.hidden = !st.on;
    if (!st.on) return;
    if (host) {
      const list = playersIn(view);
      const key = JSON.stringify([st.pick, list.map((p) => [p.id, p.name])]);
      if (key !== S.pickKey) {
        S.pickKey = key;
        fill(whoChips, chip(null, 'Pick for me', !st.pick), list.map((p) => chip(p.id, p.name, st.pick === p.id)));
      }
      whoChips.hidden = false;
      text(whoNote, st.pick ? `${st.pickName} goes on the hunters' team.` : 'A hunter is picked at random when the game starts.');
    } else {
      whoChips.hidden = true;
      whoTitle.hidden = true;
      text(whoNote, st.pick ? `${st.pickName} drives the car.` : 'One hunter is picked to drive when the game starts.');
    }
  }

  return {
    el,
    update(view) {
      if (!view) return;
      S.view = view;
      paint();
    },
  };
}
