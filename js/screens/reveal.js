// Night Ops: the role reveal, once per game at the start. Full screen in your side's colour: YOUR ROLE, a huge
// HUNTER or HIDER, one line on what to do, your teammates' faces, and Got it (or a tap anywhere) for the game.
// Its styles live at the end of css/lobby.css.
import { h, fill, face, text } from '../dom.js?v=181';
import { fmtClock } from '../../shared/rules.js?v=181';
import { icon } from '../ui/icons.js?v=181';
import { driverReveal } from './drive.js?v=181'; // v1.1 PAGE-DRIVER

const NS = 'http://www.w3.org/2000/svg';
const TAP_GUARD_MS = 700;   // a second tap on Start mustn't skip the reveal straight away
const MOST_FACES = 7;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function svg(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// A scope behind the title: rings, ticks and a slowly turning bearing scale.
function scope() {
  const s = svg('svg', { viewBox: '0 0 200 200', class: 'reveal-scope', 'aria-hidden': 'true', focusable: 'false' });
  s.appendChild(svg('circle', { cx: 100, cy: 100, r: 97, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.5, opacity: 0.5 }));
  s.appendChild(svg('circle', { cx: 100, cy: 100, r: 62, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.4, opacity: 0.35 }));
  s.appendChild(svg('path', { d: 'M100 0v14M100 186v14M0 100h14M186 100h14', stroke: 'currentColor', 'stroke-width': 0.8, opacity: 0.8 }));
  const turn = svg('g', { class: 'reveal-turn' });
  let d = '';
  for (let i = 0; i < 72; i++) {
    const a = (i * 5 * Math.PI) / 180;
    const long = i % 6 === 0;
    const r1 = 84;
    const r2 = long ? 77 : 81;
    d += `M${(100 + r1 * Math.sin(a)).toFixed(2)} ${(100 - r1 * Math.cos(a)).toFixed(2)}L${(100 + r2 * Math.sin(a)).toFixed(2)} ${(100 - r2 * Math.cos(a)).toFixed(2)}`;
  }
  turn.appendChild(svg('path', { d, stroke: 'currentColor', 'stroke-width': 0.6, opacity: 0.6 }));
  turn.appendChild(svg('path', { d: 'M100 100 L100 18', stroke: 'currentColor', 'stroke-width': 0.6, opacity: 0.45 }));
  s.appendChild(turn);
  return s;
}

// What the reveal says, from the view: { side, title, sub, line, keep, mates, matesLabel, alone }.
// keep: locking the phone or switching apps stops sharing your spot (the page can't send it from the background).
// v1.1 PAGE-DRIVER: the driver's own words (and "Jake drives the car" for the other hunters)
export function revealWords(view) {
  return driverReveal(plainRevealWords(view), view);
}
// v1.1 end PAGE-DRIVER

function plainRevealWords(view) {
  const me = (view && view.me) || {};
  const s = (view && view.settings) || {};
  const players = (view && view.players) || [];
  const infection = s.mode === 'infection';
  const side = me.team === 'hunter' || me.team === 'hider' ? me.team : null;
  const free = players.filter((p) => p.team === 'hider' && p.status === 'in');
  const mates = side ? players.filter((p) => p.team === side && p.status === 'in' && p.id !== me.id) : [];
  const t = (view && view.timing) || {};
  const setHead = (Number(s.headStartMin) || 0) * 60000;
  const left = Number.isFinite(t.headStartLeft) ? t.headStartLeft : null;
  // The head start as the rule says it, unless much of it has already gone (a late reveal).
  const head = left === null ? 0 : left >= setHead * 0.85 ? setHead : left;
  const mins = Number(s.durationMin) || 0;

  if (side === 'hunter') {
    const n = free.length;
    const who = n === 1 ? 'the hider' : `all ${n} hiders`;
    let line = `Find and tag ${who} in ${mins} min.`;
    line += head ? ` They get a ${fmtClock(head)} head start.` : ' The head start is over: go!';
    if (infection) line += ' Everyone you catch joins you.';
    return {
      side,
      title: 'Hunter',
      sub: infection ? 'Infection' : '',
      line,
      keep: 'Keep Night Ops open so your team sees you. Pocket mode (the moon) makes the screen black.',
      mates,
      matesLabel: 'Hunting with you',
      alone: infection ? 'You start alone. Everyone you catch joins you.' : "You're the only hunter.",
    };
  }
  if (side === 'hider') {
    let line = head ? `Run and hide. You have ${fmtClock(head)} before the hunters come.` : 'Run and hide. The hunters are already out.';
    if (s.caught === 'out' && !infection) line += ' If they catch you, you sit out.';
    return {
      side,
      title: 'Hider',
      sub: infection ? 'Infection' : '',
      line,
      keep: "Keep Night Ops open: locking your phone stops sharing your spot. To hide the screen's light, use pocket mode (the moon).",
      mates,
      matesLabel: 'Hiding too',
      alone: "You're the only hider. Make it count.",
    };
  }
  return { side: null, title: 'Game on', sub: '', line: "You're watching this one.", keep: '', mates: [], matesLabel: '', alone: '' };
}

export function mount(root, app) {
  const S = { destroyed: false, shownAt: Date.now(), gone: false };

  const kicker = h('p.reveal-kicker', 'Your role');
  const titleWord = h('span.reveal-word');
  const title = h('h1.reveal-title', titleWord, h('span.reveal-bar', { 'aria-hidden': 'true' }));
  const sub = h('p.reveal-sub');
  const line = h('p.reveal-line');
  const keepText = h('span');
  const keep = h('p.reveal-keep', icon('moon', 16), keepText);
  const teamLabel = h('p.reveal-team-label');
  const faces = h('div.reveal-faces', { role: 'list' });
  const alone = h('p.reveal-alone');
  const team = h('div.reveal-team', teamLabel, faces, alone);
  const go = h('button.btn.wide.reveal-go', { type: 'button' }, 'Got it');
  const code = h('span');
  const count = h('span');

  const layer = h('div.reveal',
    h('div.reveal-bg', { 'aria-hidden': 'true' }, scope()),
    h('div.reveal-frame', { 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
    h('div.reveal-head', { 'aria-hidden': 'true' }, code, count),
    h('div.reveal-main', kicker, title, sub, line, keep, team),
    h('div.reveal-foot', go, h('p.reveal-tap', { 'aria-hidden': 'true' }, 'Or tap anywhere')));
  fill(root, layer);

  function next() {
    if (S.destroyed || S.gone) return;
    S.gone = true;
    app.go('game');
  }

  go.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() - S.shownAt < TAP_GUARD_MS && e.detail > 0) return;
    next();
  });
  layer.addEventListener('click', () => {
    if (Date.now() - S.shownAt < TAP_GUARD_MS) return;
    next();
  });

  // v1.6: the narrator says your role (the retro radio voice; quiet when the phone turned the narrator off)
  let said = false;
  function sayRole(view, w) {
    if (said || !w.side) return;
    said = true;
    try {
      if (localStorage.getItem('nightops-narrator') === 'off') return;
    } catch { /* fine */ }
    const line = view.me && view.me.driver ? 'driver' : w.side === 'hunter' ? 'hunter' : 'hider';
    try { const a = new Audio(`audio/narrator/${line}.mp3`); const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch { /* no sound */ }
  }

  let facesSig = '';
  function render(view) {
    if (!view) return;
    const w = revealWords(view);
    sayRole(view, w);
    root.dataset.side = w.side || 'none';
    if (titleWord.textContent !== w.title) {
      text(titleWord, w.title);
      requestAnimationFrame(() => fitTitle());
    }
    title.setAttribute('aria-label', w.sub ? `${w.title}: ${w.sub}` : w.title);
    sub.hidden = !w.sub;
    text(sub, w.sub);
    text(line, w.line);
    keep.hidden = !w.keep;
    text(keepText, w.keep);
    text(code, String(view.code || ''));
    const hiders = (view.players || []).filter((p) => p.team === 'hider' && p.status === 'in').length;
    const hunters = (view.players || []).filter((p) => p.team === 'hunter' && p.status === 'in').length;
    text(count, `${plural(hunters, 'hunter', 'hunters')} · ${plural(hiders, 'hider', 'hiders')}`);

    team.hidden = !w.side;
    text(teamLabel, w.matesLabel);
    alone.hidden = w.mates.length > 0;
    text(alone, w.alone);
    teamLabel.hidden = !w.mates.length;
    const shown = w.mates.slice(0, MOST_FACES);
    const sig = JSON.stringify([w.side, shown.map((p) => [p.id, p.name, app.faces.get(p.id) ? 1 : 0]), w.mates.length]);
    if (sig !== facesSig) {
      facesSig = sig;
      fill(faces,
        shown.map((p) => h('div.reveal-mate', { role: 'listitem' },
          face({ name: p.name, src: app.faces.get(p.id) || null, team: w.side, size: 48 }),
          h('span.reveal-mate-name', p.name))),
        w.mates.length > shown.length
          ? h('div.reveal-mate', { role: 'listitem' },
            h('span.reveal-more', `+${w.mates.length - shown.length}`),
            h('span.reveal-mate-name', 'more'))
          : null);
    }
  }

  // The title shrinks until the word fits (a narrow phone, a big system font).
  function fitTitle() {
    if (S.destroyed) return;
    titleWord.style.fontSize = '';
    let size = parseFloat(getComputedStyle(title).fontSize) || 80;
    let guard = 24;
    while (title.scrollWidth > title.clientWidth + 1 && size > 36 && guard-- > 0) {
      size -= 4;
      titleWord.style.fontSize = `${size}px`;
    }
  }

  render(app.view);
  fitTitle();
  try { document.fonts?.ready?.then(fitTitle); } catch { /* old browser */ }
  const offResize = () => fitTitle();
  window.addEventListener('resize', offResize);
  // A buzz, but only once the page has been touched (Chrome refuses, noisily, before that).
  try {
    const ua = navigator.userActivation;
    if (!ua || ua.hasBeenActive) app.alerts?.buzz?.('power');
  } catch { /* fine */ }
  // Enter or Space goes on to the game too (the App puts the focus on this screen, not the button).
  const onKey = (e) => {
    if (S.destroyed || (e.key !== 'Enter' && e.key !== ' ')) return;
    const t = e.target;
    if (t && t !== document.body && t !== root && t.closest && t.closest('button, a, input, textarea, select')) return;
    e.preventDefault();
    next();
  };
  document.addEventListener('keydown', onKey);

  return {
    update(view) {
      if (S.destroyed) return;
      render(view);
    },
    destroy() {
      S.destroyed = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', offResize);
    },
  };
}
