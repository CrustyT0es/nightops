// Night Ops v1.3 (PAGE-SETUP): the lobby's Checkpoints card (shown when the mode is Checkpoints, after the ring).
//   cpCard(ctx) -> { el, update(view), destroy() }
//   ctx = { app, host, setSetting(key, value, waitMs) }; update gets the view with the host's pending picks on top
// The host: a small still map with the ring and the spots, how many there are (or what's wrong), when they open,
// "Set up checkpoints" (the editor), and the five Checkpoints settings. Everyone else: how many there are ("Only
// the host knows where") and the settings in words. Nobody but the host is ever sent the spots.
import { h, fill, text, cls } from '../../dom.js?v=151';
import { icon } from '../../ui/icons.js?v=151';
import { createMap } from '../../map.js?v=151';
import { ringProblem } from '../../../shared/geo.js?v=151';
import { LIMITS, CP_SETTINGS_UI, DEFAULTS } from '../../../shared/rules.js?v=151';

const STEP_WAIT_MS = 350;
const AUTO_NEXT = 3;   // from Auto (0) the open time steps to 3 min (1 and 2 are too short to get anywhere)

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

const mins = (ms) => Math.max(0, Math.round((Number(ms) || 0) / 60000));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The next value of a Checkpoints stepper (cpOpenMin skips 1 and 2: Auto, 3, 4...).
export function stepValue(item, value, dir) {
  const v = Number(value) || 0;
  let next = v + dir * (item.step || 1);
  if (item.key === 'cpOpenMin') {
    if (dir > 0 && v === 0) next = AUTO_NEXT;
    else if (dir < 0 && v <= AUTO_NEXT) next = 0;
  }
  return Math.max(item.min, Math.min(item.max, next));
}

// A setting in words. Auto shows the time it works out to: "Auto (7 min)".
export function cpValueWords(item, value, plan) {
  if (item.kind === 'switch') return value ? 'On' : 'Off';
  if (item.kind === 'options') {
    const hit = item.options.find(([v]) => v === value);
    return hit ? hit[1] : String(value);
  }
  if (value === 0 && item.zero) {
    if (item.key === 'cpOpenMin' && plan && plan.openMs > 0) return `${item.zero} (${mins(plan.openMs)} min)`;
    return item.zero;
  }
  return `${value} ${item.unit || ''}`.trim();
}

// "About 7 min each. Hiders see each one 2 min before the hunters. Safe for 3 min inside."
export function planWords(plan) {
  if (!plan || !(plan.openMs > 0)) return '';
  const lead = mins(plan.leadMs);
  const parts = [
    `About ${mins(plan.openMs)} min each.`,
    lead > 0 ? `Hiders see each one ${lead} min before the hunters.` : 'Hiders and hunters see each one at the same time.',
    `Safe for ${mins(plan.safeMs)} min inside.`,
  ];
  if (plan.skipped > 0) parts.push(`Only ${plan.fits} of ${plan.fits + plan.skipped} fit in the game time.`);
  return parts.join(' ');
}

// "6 checkpoints" / "No checkpoints yet"
export function countWords(n) {
  return n > 0 ? plural(n, 'checkpoint', 'checkpoints') : 'No checkpoints yet';
}

// What a player who isn't the host reads.
export function guestWords(cp) {
  const n = cp && Number.isInteger(cp.count) ? cp.count : 0;
  if (!n) return "The host hasn't put the checkpoints on the map yet.";
  return `${countWords(n)}. Only the host knows where.`;
}

// ---- widgets (the lobby's look) ---------------------------------------------------------------------------

function stepperRow(item, onStep) {
  const value = h('span.stepper-value');
  const minus = h('button', { type: 'button', 'aria-label': `${item.label}: less` }, icon('minus', 20));
  const plus = h('button', { type: 'button', 'aria-label': `${item.label}: more` }, icon('plus', 20));
  const live = h('span.sr-only', { 'aria-live': 'polite' });
  minus.addEventListener('click', () => { if (minus.getAttribute('aria-disabled') !== 'true') onStep(-1, live); });
  plus.addEventListener('click', () => { if (plus.getAttribute('aria-disabled') !== 'true') onStep(1, live); });
  const el = h('div.lobby-set.row', { 'data-key': item.key, 'data-anchor': '' },
    h('div.lobby-set-label', h('span', item.label)),
    h('div.stepper', { role: 'group', 'aria-label': item.label }, minus, value, plus, live));
  return {
    el,
    set(v, words) {
      text(value, words);
      minus.setAttribute('aria-disabled', v <= item.min ? 'true' : 'false');
      plus.setAttribute('aria-disabled', v >= item.max ? 'true' : 'false');
    },
  };
}

function switchRow(item, onFlip) {
  const sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': item.label });
  sw.addEventListener('click', () => onFlip(sw.getAttribute('aria-checked') !== 'true'));
  const el = h('div.lobby-set.row', { 'data-key': item.key, 'data-anchor': '' },
    h('div.lobby-set-label', h('span', item.label)), sw,
    item.hint ? h('span.lobby-set-hint', item.hint) : null);
  return { el, set(v) { sw.setAttribute('aria-checked', v ? 'true' : 'false'); } };
}

function optionsRow(item, onPick, hint) {
  const btns = item.options.map(([value, words]) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1' }, h('span.seg-main', words));
    b._value = value;
    b.addEventListener('click', () => { if (b.getAttribute('aria-checked') !== 'true') onPick(value); });
    return b;
  });
  const seg = h('div.seg.lobby-options', { role: 'radiogroup', 'aria-label': item.label }, btns);
  seg.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = Math.max(0, btns.indexOf(document.activeElement));
    const next = btns[(i + step + btns.length) % btns.length];
    next.focus();
    next.click();
  });
  const el = h('div.lobby-set.lobby-set-col', { 'data-key': item.key, 'data-anchor': '' },
    h('div.lobby-set-label', h('span', item.label)), hint ? h('span.lobby-set-hint', hint) : null, seg);
  return {
    el,
    set(v) {
      for (const b of btns) {
        const on = b._value === v;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    },
  };
}

function wordsRow(item) {
  const value = h('span.lobby-set-value');
  const el = h('div.lobby-set.row', { 'data-key': item.key }, h('div.lobby-set-label', h('span', item.label)), value);
  return { el, set(v, words) { text(value, words); } };
}

// ---- the card ---------------------------------------------------------------------------------------------

export function cpCard(ctx) {
  const { app, host } = ctx;
  const S = { view: null, map: null, mapSig: null, destroyed: false, shown: {} };

  const titleId = `lobby-checkpoints-${Math.random().toString(36).slice(2, 7)}`;
  const mapBox = h('div.cpc-map', { 'aria-hidden': 'true' });
  const headline = h('p.cpc-count');
  const problem = h('p.cpc-problem', { 'aria-live': 'polite' });
  const plan = h('p.lobby-hint.cpc-plan');
  const shrinkLine = h('p.lobby-hint.cpc-shrink', 'The ring shrinks at the end. Checkpoints outside the smaller ring are still safe to stand in.');
  let btn = null;
  if (host) {
    btn = h('button.btn.wide.cpc-btn', { type: 'button' });
    btn.addEventListener('click', () => app.go('checkpoints'));
  }

  const val = (key) => {
    const s = S.view && S.view.settings;
    return s && s[key] !== undefined ? s[key] : DEFAULTS[key];
  };
  const cpPlan = () => (S.view && S.view.cp && S.view.cp.plan) || null;

  const rows = CP_SETTINGS_UI.map((item) => {
    if (!host) return { item, ...wordsRow(item) };
    if (item.kind === 'stepper') {
      return {
        item,
        ...stepperRow(item, (dir, live) => {
          const next = stepValue(item, val(item.key), dir);
          if (next === val(item.key)) return;
          ctx.setSetting(item.key, next, STEP_WAIT_MS);
          text(live, `${item.label}: ${cpValueWords(item, next, cpPlan())}`);
        }),
      };
    }
    if (item.kind === 'switch') return { item, ...switchRow(item, (on) => ctx.setSetting(item.key, on)) };
    return {
      item,
      ...optionsRow(item, (v) => ctx.setSetting(item.key, v),
        item.key === 'cpOrder' ? 'You know where the checkpoints are. Shuffle them so nobody knows which comes next.' : ''),
    };
  });
  const sets = h('div.lobby-sets.cpc-sets', rows.map((r) => r.el));

  const guestLine = h('p.cpc-guest');
  const el = h('section.lobby-card.cpc', { 'aria-labelledby': titleId, 'data-anchor': '' },
    h(`h2#${titleId}.label.lobby-card-title`, 'Checkpoints'),
    host ? [mapBox, h('div.cpc-head', h('span.cpc-icon', { 'aria-hidden': 'true' }, icon('flag', 20)), headline), problem, plan, btn]
      : [h('div.cpc-head', h('span.cpc-icon', { 'aria-hidden': 'true' }, icon('flag', 20)), guestLine), plan],
    sets, shrinkLine);
  el.hidden = true;

  function drawMap(v) {
    const ring = v.ring && !ringProblem(v.ring) ? v.ring : null;
    const list = v.cp && Array.isArray(v.cp.list) ? v.cp.list : [];
    const show = !!ring && list.length > 0 && !el.hidden;
    mapBox.hidden = !show;
    let sig = '';
    try { sig = JSON.stringify([ring, list, show]); } catch { sig = String(Math.random()); }
    if (sig === S.mapSig) return;
    S.mapSig = sig;
    if (!show) {
      if (S.map) { try { S.map.destroy(); } catch { /* ignore */ } }
      S.map = null;
      return;
    }
    try {
      if (!S.map) S.map = createMap(mapBox, { interactive: false });
      S.map.setRing(ring, null);
      if (typeof S.map.setSpots === 'function') {
        S.map.setSpots(list.map((c, i) => ({ key: c.id, p: c.p, r: c.r, n: i + 1, name: c.name, state: 'active', label: false })));
      }
      S.map.fit(ring, { padding: 14, animate: false });
    } catch (e) {
      console.error(e);
    }
  }

  return {
    el,
    update(v) {
      if (S.destroyed || !v) return;
      S.view = v;
      const s = v.settings || {};
      const on = s.mode === 'checkpoints';
      if (el.hidden === on) el.hidden = !on;
      if (!on) { drawMap(v); return; }
      const cp = v.cp || null;
      const n = cp && Number.isInteger(cp.count) ? cp.count : 0;
      const pl = cp && cp.plan ? cp.plan : null;
      if (host) {
        text(headline, countWords(n));
        const p = cp ? cp.problem || '' : '';
        text(problem, p);
        problem.hidden = !p;
        fill(btn, icon(n ? 'draw' : 'plus', 20), n ? 'Change the checkpoints' : 'Set up checkpoints');
        cls(btn, 'primary', n < LIMITS.checkpointsLeast);
      } else {
        text(guestLine, guestWords(cp));
      }
      const pw = n >= LIMITS.checkpointsLeast ? planWords(pl) : '';
      text(plan, pw);
      plan.hidden = !pw;
      shrinkLine.hidden = !(s.shrink && s.closingMin > 0);
      for (const r of rows) {
        const value = s[r.item.key] !== undefined ? s[r.item.key] : DEFAULTS[r.item.key];
        r.set(value, cpValueWords(r.item, value, pl));
      }
      drawMap(v);
    },
    resize() { if (S.map && S.map.resize) S.map.resize(); },
    destroy() {
      S.destroyed = true;
      if (S.map) { try { S.map.destroy(); } catch { /* ignore */ } }
      S.map = null;
    },
  };
}
