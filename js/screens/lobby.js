// Night Ops: the lobby. Everyone sees the code (Copy, QR, Share), the players, the mode, the ring and every
// setting. The host can change them all, pick teams, remove someone, hand over the host role and Start; the
// others see the same information read-only while they wait.
// Everything is built once and then changed in place on each view, so a sync never moves the page or loses
// focus. A setting the host just changed shows the new value at once (kept until the server answers).
import { h, fill, add, face, text, cls, listen } from '../dom.js?v=174';
import { icon } from '../ui/icons.js?v=174';
import { openSheet } from '../ui/sheet.js?v=174';
import { banner } from '../ui/banner.js?v=174';
import { qrSvg } from '../qr.js?v=174';
import { createMap } from '../map.js?v=174';
import { ringProblem } from '../../shared/geo.js?v=174';
import { cpCard } from './extras/cpcard.js?v=174'; // v1.3 PAGE-SETUP
import { readyCard, notReady } from './ready.js?v=174'; // v1.4 PAGE-DEVICES
import { createVoteShow } from './voteshow.js?v=174'; // v1.6: the Jackbox-style vote
import {
  LIMITS, MODES, POWERS, HIDER_POWERS, HUNTER_POWERS, PRESETS, SETTINGS_UI,
  huntersFor, ringSize, recommend, fmtDistance,
} from '../../shared/rules.js?v=174';

// v1.6: the browser checks written before the tabs and folds set localStorage 'nightops-show-all' = '1': every
// tab's content shows at once and the folded cards start open (never set on a real phone).
const SHOW_ALL = (() => { try { return globalThis.localStorage && localStorage.getItem('nightops-show-all') === '1'; } catch { return false; } })();

// v1.1 PAGE-WATCH: the Extras card's three rows (each its builder's module), loaded so that one that's missing
// or broken only leaves its row out, never the lobby.
const EXTRA_ROWS = ['driver', 'watch', 'radio'];
// v1.2 PAGE-RADIO: the "Walkie-talkie for hiders too" row
EXTRA_ROWS.push('radiohiders');
// v1.2 end PAGE-RADIO
// v1.2 PAGE-CAM: the Camera row
EXTRA_ROWS.push('cam');
// v1.2 end PAGE-CAM
// v1.4 PAGE-PLAY: Wiretap's OK and Team pins
EXTRA_ROWS.push('wiretap', 'pins');
// v1.4 end PAGE-PLAY
let extraMakers = null;
function loadExtraRows() {
  if (!extraMakers) {
    extraMakers = Promise.all(EXTRA_ROWS.map((name) => import(`./extras/${name}.js`)
      .then((m) => (m && typeof m.extraRow === 'function' ? m.extraRow : null))
      .catch((e) => { console.error(e); return null; })));
  }
  return extraMakers;
}
// v1.1 end PAGE-WATCH

const STEP_WAIT_MS = 350;   // stepper taps are sent once the host stops tapping for this long
// The icon for each power, as the game screen and the end screen draw it (there is no 'exposure' icon).
const POWER_ICON = { radar: 'radar', exposure: 'eye', jammer: 'jammer', decoy: 'decoy', sprint: 'sprint' };

const HINTS = {
  pingWarnSec: 'Hiders get a warning this long before each ping.',
  pingAccuracyM: 'How big the ping circle is. The hider is somewhere inside it.',
  closingMin: 'At the end, pings come faster and the circles get smaller.',
  finalSizePct: 'How small the ring gets by the end.',
  caught: 'What happens to a hider who gets tagged.',
};

// ---- pure helpers -----------------------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// How the teams will come out at Start, the same way the engine makes them: picks first, then Auto players
// at random until there are enough hunters, the rest hide.
export function teamPlan(settings, players) {
  const list = (players || []).filter((p) => p && p.status === 'in');
  const n = list.length;
  const want = huntersFor(settings, n);
  const pickedHunters = list.filter((p) => p.pick === 'hunter').length;
  const pickedHiders = list.filter((p) => p.pick === 'hider').length;
  const autos = n - pickedHunters - pickedHiders;
  const need = Math.max(0, want - pickedHunters);
  const hunters = pickedHunters + Math.min(need, autos);
  const hiders = pickedHiders + Math.max(0, autos - need);
  return { n, want, hunters, hiders, autos, pickedHunters, pickedHiders };
}

// Why the game can't start yet ('' when it can).
export function startProblem(view) {
  if (!view) return 'Waiting for the game.';
  const host = !!(view.me && view.me.host);
  if (!view.ring || ringProblem(view.ring)) return host ? 'Draw the ring first.' : 'The host still has to draw the ring.';
  // v1.3 PAGE-SETUP: Checkpoints needs its checkpoints
  if (view.settings && view.settings.mode === 'checkpoints' && view.cp && view.cp.problem) {
    if (host) return view.cp.problem;
    // The checkpoints are there but the game is too short for them: it's the game's length or open time.
    const least = Number(LIMITS.checkpointsLeast) || 2;
    const fits = view.cp.plan && Number.isFinite(view.cp.plan.fits) ? view.cp.plan.fits : null;
    if (Number(view.cp.count) >= least && fits !== null && fits < least) {
      return 'The game is too short for the checkpoints. The host can make it longer or change the open time.';
    }
    return 'The host still has to set up the checkpoints.';
  }
  // v1.3 end PAGE-SETUP
  const plan = teamPlan(view.settings, view.players);
  if (plan.n < 2) return 'You need at least 2 players. Share the code with your friends.';
  if (!plan.hunters) return 'Nobody is hunting. Set someone to Hunter or Auto.';
  if (!plan.hiders) return 'Nobody is hiding. Set someone to Hider or Auto.';
  return '';
}

export function teamLine(settings, players) {
  const plan = teamPlan(settings, players);
  if (plan.n < 2) return 'Teams are made when the game starts.';
  const counts = `${plural(plan.hunters, 'hunter', 'hunters')} and ${plural(plan.hiders, 'hider', 'hiders')}.`;
  const random = plan.autos > 0 ? ' Anyone on Auto gets a random side when the game starts.' : '';
  if (settings.mode === 'infection') return `${counts} Everyone the hunters catch joins them.${random}`;
  return `${counts}${random}`;
}

export function settingText(item, value) {
  if (item.kind === 'switch') return value ? 'On' : 'Off';
  if (item.kind === 'options') {
    const hit = item.options.find(([v]) => v === value);
    return hit ? hit[1] : String(value);
  }
  if (item.zero && value === 0) return item.zero;
  if (item.unit === '%') return `${value}%`;
  return `${value} ${item.unit || ''}`.trim();
}

function samePreset(settings, name) {
  const p = PRESETS[name];
  return !!p && Object.entries(p.settings).every(([k, v]) => settings[k] === v);
}

function sameAsRecommended(settings, ring, n) {
  if (!ring) return false;
  const rec = recommend(ring, n);
  return Object.entries(rec).every(([k, v]) => settings[k] === v);
}

// ---- small widgets ----------------------------------------------------------------------------------------

// A segmented control of radio buttons with arrow keys. options: [[value, words, small?], ...]
function radios({ label, options, onPick, className = '' }) {
  const el = h(`div.seg${className ? `.${className}` : ''}`, { role: 'radiogroup', 'aria-label': label });
  const btns = options.map(([value, words, small]) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1' },
      h('span.seg-main', words), small ? h('span.seg-sub', small) : null);
    b._value = value;
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      if (b.getAttribute('aria-checked') !== 'true') onPick(value);
    });
    return b;
  });
  add(el, btns);
  el.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = Math.max(0, btns.indexOf(document.activeElement));
    const next = btns[(i + step + btns.length) % btns.length];
    next.focus();
    next.click();
  });
  return {
    el,
    set(value) {
      let any = false;
      for (const b of btns) {
        const on = b._value === value;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        if (on) any = true;
      }
      if (!any && btns[0]) btns[0].tabIndex = 0;
    },
  };
}

// A -/+ stepper. Buttons at the ends say aria-disabled (not disabled) so focus never drops off them.
function stepper({ label, fmt, onChange }) {
  const value = h('span.stepper-value');
  const minus = h('button', { type: 'button', 'aria-label': `${label}: less` }, icon('minus', 20));
  const plus = h('button', { type: 'button', 'aria-label': `${label}: more` }, icon('plus', 20));
  const live = h('span.sr-only', { 'aria-live': 'polite' });
  const el = h('div.stepper', { role: 'group', 'aria-label': label }, minus, value, plus, live);
  let cur = 0;
  let lo = 0;
  let hi = 0;
  let step = 1;
  const go = (dir) => {
    const next = Math.max(lo, Math.min(hi, cur + dir * step));
    if (next === cur) return;
    onChange(next);
    text(live, `${label}: ${fmt(next)}`);
  };
  minus.addEventListener('click', () => go(-1));
  plus.addEventListener('click', () => go(1));
  return {
    el,
    set(v, min, max, by = 1) {
      cur = v;
      lo = min;
      hi = max;
      step = by;
      text(value, fmt(v));
      minus.setAttribute('aria-disabled', v <= min ? 'true' : 'false');
      plus.setAttribute('aria-disabled', v >= max ? 'true' : 'false');
    },
  };
}

function toggle({ label, onChange }) {
  const el = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label });
  el.addEventListener('click', () => onChange(el.getAttribute('aria-checked') !== 'true'));
  return {
    el,
    set(on) { el.setAttribute('aria-checked', on ? 'true' : 'false'); },
  };
}

function card(title, ...children) {
  const id = `lobby-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return h(`section.lobby-card`, { 'aria-labelledby': id, 'data-anchor': '' },
    h(`h2#${id}.label.lobby-card-title`, title), children);
}

// Copy text: the Clipboard API when there is one, else the old select-and-copy way. -> Promise<boolean>
async function copyText(words) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(words);
      return true;
    }
  } catch { /* try the old way */ }
  let ok = false;
  const ta = h('textarea.sr-only', { readonly: '', 'aria-hidden': 'true', tabindex: '-1' });
  ta.value = words;
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, words.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function copyByHand(title, words) {
  const box = h('input.field.lobby-copy-box', { type: 'text', readonly: '', value: words, 'aria-label': title, autofocus: '' });
  box.addEventListener('focus', () => box.select());
  openSheet({
    title,
    body: [h('p', "This phone wouldn't copy it. Press and hold the text below, then choose Copy."), box],
    actions: [{ label: 'Done', kind: 'primary' }],
  });
}

// ---- the screen -------------------------------------------------------------------------------------------

export function mount(root, app) {
  const S = {
    destroyed: false,
    tab: 'players',          // v1.5.1: the lobby tab showing
    open: new Set(),         // v1.5.1: the folded cards opened
    view: null,
    host: null,              // the role the page was built for
    pending: new Map(),      // setting key -> value the host just picked, until the server answers
    seq: new Map(),
    timers: new Map(),       // key -> { id, go } for steppers waiting to send
    map: null,
    mapSig: null,
    starting: false,
    startError: '',
    startErrorSig: '',
    preset: null,            // a preset being sent
    recommending: false,
    offs: [],
    w: null,                 // the widgets of the current build
  };

  const html = document.documentElement;
  const oldAnchor = html.style.overflowAnchor;
  html.style.overflowAnchor = 'none'; // we keep the place ourselves (Safari has no scroll anchoring)

  // ---- values, with what the host just picked on top ----

  function val(key) {
    if (S.pending.has(key)) return S.pending.get(key);
    const s = S.view ? S.view.settings : {};
    if (key.startsWith('powers.')) return !!(s.powers && s.powers[key.slice(7)]);
    return s[key];
  }

  // The settings as they'll be once what's pending lands (for show() and the team line).
  function settingsNow() {
    const s = { ...(S.view ? S.view.settings : {}) };
    s.powers = { ...(s.powers || {}) };
    for (const [k, v] of S.pending) {
      if (k.startsWith('powers.')) s.powers[k.slice(7)] = v;
      else if (!k.startsWith('pick:')) s[k] = v;
    }
    return s;
  }

  function playersNow() {
    const list = S.view ? S.view.players || [] : [];
    return list.map((p) => (S.pending.has(`pick:${p.id}`) ? { ...p, pick: S.pending.get(`pick:${p.id}`) } : p));
  }

  function send(key, value, cmd) {
    const seq = (S.seq.get(key) || 0) + 1;
    S.seq.set(key, seq);
    return Promise.resolve(app.cmd(cmd)).catch(() => null).then(() => {
      if (S.seq.get(key) === seq) S.pending.delete(key);
      if (!S.destroyed) render();
    });
  }

  // Send the stepper changes still waiting for the host to stop tapping. -> Promise (all answered)
  function flush() {
    const waits = [];
    for (const t of [...S.timers.values()]) {
      clearTimeout(t.id);
      try { waits.push(t.go()); } catch { /* ignore */ }
    }
    S.timers.clear();
    return Promise.all(waits);
  }

  function setSetting(key, value, wait = 0) {
    S.pending.set(key, value);
    const old = S.timers.get(key);
    if (old) clearTimeout(old.id);
    const patch = key.startsWith('powers.') ? { powers: { [key.slice(7)]: value } } : { [key]: value };
    const go = () => {
      S.timers.delete(key);
      return send(key, value, { type: 'settings', settings: patch });
    };
    if (wait > 0) {
      S.seq.set(key, (S.seq.get(key) || 0) + 1); // a reply from an older send no longer clears this one
      S.timers.set(key, { id: setTimeout(go, wait), go });
    } else {
      go();
    }
    render();
  }

  function setPick(player, pick) {
    const key = `pick:${player.id}`;
    S.pending.set(key, pick);
    send(key, pick, { type: 'pick', playerId: player.id, pick });
    render();
  }

  // ---- the page parts ----

  function buildTop() {
    const leave = h('button.btn.small.ghost.lobby-leave', { type: 'button' }, icon('door', 20), 'Leave');
    leave.addEventListener('click', () => confirmLeave());
    const how = h('button.btn.small.ghost.icon-only.lobby-how', { type: 'button', 'aria-label': 'How to play' }, icon('info', 20));
    how.addEventListener('click', () => {
      import('./home.js?v=174').then((m) => m.howToPlay && m.howToPlay()).catch(() => banner("That didn't open. Try again.", 'warn'));
    });
    return h('header.lobby-top',
      h('div.lobby-top-text', h('span.label', 'Lobby'), h('h1.lobby-title', 'Get ready')),
      how, leave);
  }

  function buildCode() {
    const code = h('p.lobby-code');
    const copy = h('button.btn.small', { type: 'button' }, icon('copy', 18), 'Copy');
    const qr = h('button.btn.small', { type: 'button' }, icon('qr', 18), 'QR code');
    const share = h('button.btn.small', { type: 'button' }, icon('share', 18), 'Share');
    copy.setAttribute('aria-label', 'Copy the game code');
    qr.setAttribute('aria-label', 'Show a QR code to join');
    share.setAttribute('aria-label', 'Share the invite link');
    copy.addEventListener('click', async () => {
      const c = S.view ? S.view.code : '';
      if (!c) return;
      if (await copyText(c)) banner(`Code ${c} copied.`, 'good', 2500);
      else copyByHand('The game code', c);
    });
    qr.addEventListener('click', () => showQr());
    share.addEventListener('click', () => shareLink());
    const el = h('section.lobby-card.lobby-code-card', { 'aria-labelledby': 'lobby-code-title', 'data-anchor': '' },
      h('h2#lobby-code-title.label.lobby-card-title', 'Game code'),
      code,
      h('div.lobby-code-actions', copy, qr, share),
      h('p.sr-only', 'Friends type the code in Night Ops, scan the QR code or open the link.')); // v1.6: said, not shown
    return {
      el,
      update(v) {
        const c = String(v.code || '');
        if (code.dataset.code !== c) {
          code.dataset.code = c;
          // Letters one by one for screen readers (a code read as a word sounds wrong).
          fill(code,
            h('span.sr-only', Array.from(c).join(' ')),
            Array.from(c).map((ch) => h('span.lobby-code-letter', { 'aria-hidden': 'true' }, ch)));
        }
      },
    };
  }

  function showQr() {
    const v = S.view;
    if (!v) return;
    const link = app.inviteLink(v.code);
    const size = Math.min(260, Math.max(180, (window.innerWidth || 360) - 120));
    const copyLink = async () => {
      if (await copyText(link)) banner('Invite link copied.', 'good', 2500);
      else copyByHand('The invite link', link);
    };
    openSheet({
      title: 'Scan to join',
      className: 'lobby-qr-sheet',
      body: h('div.lobby-qr',
        h('div.lobby-qr-box', qrSvg(link, { size, label: `QR code to join game ${v.code}` })),
        h('p.lobby-qr-code', v.code),
        h('p', 'Point another phone camera at the code. It opens Night Ops with the code filled in.'),
        h('p.lobby-qr-link', link)),
      actions: [{ label: 'Copy the link', keepOpen: true, onClick: () => copyLink() }, { label: 'Done', kind: 'primary' }],
    });
  }

  async function shareLink() {
    const v = S.view;
    if (!v) return;
    const link = app.inviteLink(v.code);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Night Ops', text: `Join my Night Ops game. The code is ${v.code}.`, url: link });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // they closed the share menu
      }
    }
    if (await copyText(link)) banner('Invite link copied. Paste it to your friends.', 'good', 3000);
    else copyByHand('The invite link', link);
  }

  function confirmLeave() {
    const v = S.view;
    const host = v && v.me && v.me.host;
    const next = host && v ? (v.players || []).find((p) => p.id !== v.me.id) : null;
    openSheet({
      title: 'Leave this game?',
      body: h('p', host && next
        ? `${next.name} becomes the host. You can join again with the code while the game is in the lobby.`
        : 'You can join again with the code while the game is in the lobby.'),
      actions: [
        { label: 'Leave the game', kind: 'danger', onClick: () => { app.leave(); } },
        { label: 'Stay', kind: 'ghost' },
      ],
    });
  }

  // -- players and teams --

  function buildPlayers(host) {
    const count = h('span.lobby-count.mono');
    const list = h('ul.lobby-players', { role: 'list' });
    const rows = new Map();
    const line = h('p.lobby-teams-line');

    let shuffle = null;
    let hunters = null;
    let huntersRow = null;
    if (host) {
      shuffle = h('button.btn.small.lobby-shuffle', { type: 'button' }, icon('shuffle', 18), 'Shuffle teams');
      shuffle.addEventListener('click', () => {
        if (shuffle.getAttribute('aria-disabled') === 'true') return;
        for (const p of playersNow()) if (p.pick !== 'auto') S.pending.set(`pick:${p.id}`, 'auto');
        const keys = [...S.pending.keys()].filter((k) => k.startsWith('pick:'));
        const seq = new Map(keys.map((k) => [k, (S.seq.get(k) || 0) + 1]));
        for (const [k, n] of seq) S.seq.set(k, n);
        render();
        Promise.resolve(app.cmd({ type: 'shuffle' })).catch(() => null).then(() => {
          for (const [k, n] of seq) if (S.seq.get(k) === n) S.pending.delete(k);
          if (!S.destroyed) render();
        });
        banner('Everyone is on Auto: the sides are random when the game starts.', 'info', 3000);
      });
      hunters = stepper({
        label: 'Number of hunters',
        fmt: (v) => (v === 0 ? `Auto (${huntersFor({ ...settingsNow(), hunters: 0 }, teamPlan(settingsNow(), playersNow()).n)})` : String(v)),
        onChange: (v) => setSetting('hunters', v, STEP_WAIT_MS),
      });
      huntersRow = h('div.lobby-set.row', { 'data-anchor': '' },
        h('div.lobby-set-label', h('span', 'Hunters')),
        hunters.el,
        h('span.lobby-set-hint', 'Auto: about a third of the players.'));
    }

    const el = h('section.lobby-card.lobby-players-card', { 'aria-labelledby': 'lobby-players-title', 'data-anchor': '' },
      h('div.lobby-card-head', h('h2#lobby-players-title.label.lobby-card-title', 'Players'), count),
      list,
      h('div.lobby-teams',
        line,
        huntersRow,
        shuffle ? h('div.lobby-teams-actions', shuffle) : null));

    function makeRow(p) {
      const faceBox = h('span.lobby-face');
      const name = h('span.lobby-name');
      const you = h('span.chip.lobby-you', 'You');
      const crown = h('span.chip.lobby-crown', icon('crown', 14), 'Host');
      const online = h('span.lobby-online');
      const tags = h('span.lobby-tags', you, crown, online);
      const top = h('div.lobby-player-top', faceBox, h('div.lobby-who', name, tags));
      const row = { el: h('li.lobby-player', { 'data-id': p.id, 'data-anchor': '' }, top), faceBox, name, you, crown, online, src: undefined, team: undefined };
      if (host) {
        row.more = h('button.btn.small.icon-only.ghost.lobby-more', { type: 'button' }, icon('menu', 20));
        row.more.addEventListener('click', () => playerMenu(p.id));
        top.appendChild(row.more);
        row.pick = radios({
          label: `Side for ${p.name}`,
          className: 'lobby-pick',
          options: [['auto', 'Auto'], ['hunter', 'Hunter'], ['hider', 'Hider']],
          onPick: (pick) => {
            const cur = (S.view && S.view.players || []).find((x) => x.id === p.id);
            if (cur) setPick(cur, pick);
          },
        });
        row.el.appendChild(row.pick.el);
      } else {
        row.chip = h('span.chip.lobby-pick-chip');
        top.appendChild(row.chip);
      }
      return row;
    }

    return {
      el,
      update(v) {
        const players = playersNow();
        const meId = v.me && v.me.id;
        text(count, `${players.length} / ${LIMITS.players}`);
        const seen = new Set();
        let prev = null;
        for (const p of players) {
          seen.add(p.id);
          let row = rows.get(p.id);
          if (!row) {
            row = makeRow(p);
            rows.set(p.id, row);
          }
          // Keep the order of the view without moving rows that are already in place.
          const want = prev ? prev.nextSibling : list.firstChild;
          if (want !== row.el) list.insertBefore(row.el, want);
          prev = row.el;

          const mine = p.id === meId;
          text(row.name, p.name);
          row.you.hidden = !mine;
          row.crown.hidden = !p.host;
          cls(row.online, 'away', !p.online);
          text(row.online, p.online ? 'Online' : 'Away');
          const team = p.pick === 'hunter' || p.pick === 'hider' ? p.pick : null;
          const src = app.faces.get(p.id) || null;
          if (row.src !== src || row.team !== team || row.faceName !== p.name) {
            row.src = src;
            row.team = team;
            row.faceName = p.name;
            fill(row.faceBox, face({ name: p.name, src, team, size: 42 }));
          }
          if (row.pick) {
            row.pick.set(p.pick || 'auto');
            row.pick.el.setAttribute('aria-label', `Side for ${p.name}`);
          }
          if (row.more) {
            row.more.hidden = mine;
            row.more.setAttribute('aria-label', `More for ${p.name}`);
          }
          if (row.chip) {
            row.chip.hidden = !team;
            row.chip.className = `chip lobby-pick-chip${team ? ` ${team}` : ''}`;
            text(row.chip, team === 'hunter' ? 'Hunter' : team === 'hider' ? 'Hider' : '');
          }
        }
        for (const [id, row] of rows) {
          if (!seen.has(id)) {
            row.el.remove();
            rows.delete(id);
          }
        }

        const s = settingsNow();
        text(line, teamLine(s, players));
        if (hunters) {
          const n = players.length;
          const classic = s.mode !== 'infection';
          huntersRow.hidden = !classic || n < 3;
          const v2 = Math.min(Number(val('hunters')) || 0, Math.max(0, n - 1));
          hunters.set(v2, 0, Math.max(1, n - 1));
        }
        if (shuffle) {
          const allAuto = players.every((p) => (p.pick || 'auto') === 'auto');
          shuffle.setAttribute('aria-disabled', allAuto ? 'true' : 'false');
        }
      },
    };
  }

  function playerMenu(id) {
    const p = S.view && (S.view.players || []).find((x) => x.id === id);
    if (!p) return;
    openSheet({
      title: p.name,
      body: h('div.lobby-menu-who', face({ name: p.name, src: app.faces.get(p.id) || null, size: 56 }),
        h('p', `What do you want to do with ${p.name}?`)),
      actions: [
        { label: `Make ${p.name} the host`, onClick: () => setTimeout(() => confirmHost(p), 0) },
        { label: `Remove ${p.name}`, kind: 'danger', onClick: () => setTimeout(() => confirmKick(p), 0) },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
  }

  function confirmHost(p) {
    openSheet({
      title: `Make ${p.name} the host?`,
      body: h('p', `${p.name} will run the game: the ring, the settings and Start. You stay in the game as a player.`),
      actions: [
        { label: `Make ${p.name} the host`, kind: 'primary', onClick: () => { app.cmd({ type: 'host', playerId: p.id }); } },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
  }

  function confirmKick(p) {
    openSheet({
      title: `Remove ${p.name}?`,
      body: h('p', `${p.name} leaves the game. If it was a mistake, they can join again with the code.`),
      actions: [
        {
          label: `Remove ${p.name}`,
          kind: 'danger',
          onClick: () => {
            app.cmd({ type: 'kick', playerId: p.id }); // the "kick" event says it worked
          },
        },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
  }

  // -- mode --

  function buildMode(host) {
    if (!host) {
      const title = h('p.lobby-mode-name');
      const line = h('p.lobby-hint');
      return {
        el: card('Mode', h('div.tile.lobby-mode.on', title, line)),
        update() {
          const m = MODES[settingsNow().mode] || MODES.classic;
          text(title, m.label);
          text(line, m.line);
        },
      };
    }
    // v1.6: Infection is gone from the picker (the owner: "basically the same" as Classic); a game already set to it
    // still shows it.
    const shown = Object.entries(MODES).filter(([key]) => key !== 'infection' || settingsNow().mode === 'infection');
    const tiles = shown.map(([key, m]) => {
      const b = h('button.tile.lobby-mode', { type: 'button', role: 'radio', 'aria-checked': 'false' },
        h('span.lobby-mode-top', h('span.lobby-mode-name', m.label), h('span.lobby-mode-tick', icon('check', 18))),
        h('span.lobby-hint', m.line));
      b._value = key;
      b.addEventListener('click', () => { if (val('mode') !== key) setSetting('mode', key); });
      return b;
    });
    const group = h('div.lobby-modes', { role: 'radiogroup', 'aria-label': 'Mode' }, tiles);
    group.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const i = Math.max(0, tiles.indexOf(document.activeElement));
      const next = tiles[(i + step + tiles.length) % tiles.length];
      next.focus();
      next.click();
    });
    return {
      el: card('Mode', group),
      update() {
        const mode = val('mode');
        for (const t of tiles) {
          const on = t._value === mode;
          t.setAttribute('aria-checked', on ? 'true' : 'false');
          t.tabIndex = on ? 0 : -1;
        }
      },
    };
  }

  // -- the ring --

  function buildRing(host) {
    const mapBox = h('div.lobby-ring-map', { 'aria-hidden': 'true' });
    const size = h('p.lobby-ring-size');
    const kind = h('span.chip.lobby-ring-kind');
    const empty = h('div.lobby-ring-empty', icon('draw', 28),
      h('p', host ? 'Draw where you play: a park, or a few streets.' : "The host hasn't drawn the ring yet."));
    let btn = null;
    if (host) {
      btn = h('button.btn.wide.lobby-ring-btn', { type: 'button' });
      btn.addEventListener('click', () => app.go('ring'));
    }
    const info = h('div.lobby-ring-info', size, kind);
    const el = card('The ring', mapBox, empty, info,
      h('p.lobby-hint.lobby-ring-rule', 'Everyone stays inside it. No roads or private property.'), btn);
    return {
      el,
      mapBox,
      update(v) {
        const ring = v.ring && !ringProblem(v.ring) ? v.ring : null;
        mapBox.hidden = !ring;
        info.hidden = !ring;
        empty.hidden = !!ring;
        if (ring) {
          const rs = ringSize(ring);
          text(size, `${fmtDistance(rs.across)} across`);
          text(kind, `${rs.label} ring`);
        }
        if (btn) {
          fill(btn, icon(ring ? 'draw' : 'circle', 20), ring ? 'Change the ring' : 'Draw the ring');
          cls(btn, 'primary', !ring);
        }
        drawRingMap(ring, mapBox);
      },
    };
  }

  function drawRingMap(ring, box) {
    let sig = '';
    try { sig = JSON.stringify(ring); } catch { sig = String(Math.random()); }
    if (S.map && S.map._box !== box) {
      try { S.map.destroy(); } catch { /* ignore */ }
      S.map = null;
      S.mapSig = null;
    }
    if (sig === S.mapSig) return;
    S.mapSig = sig;
    if (!ring) {
      if (S.map) { try { S.map.destroy(); } catch { /* ignore */ } }
      S.map = null;
      return;
    }
    try {
      if (!S.map) {
        S.map = createMap(box, { interactive: false });
        S.map._box = box;
      }
      S.map.setRing(ring, null);
      S.map.fit(ring, { padding: 18, animate: false });
    } catch (e) {
      console.error(e);
    }
  }

  // -- time and rules --

  function settingRow(item, host) {
    // The name and its control share a line; a hint goes on its own line under them.
    const hint = () => (HINTS[item.key] ? h('span.lobby-set-hint', HINTS[item.key]) : null);
    const label = h('div.lobby-set-label', h('span', item.label));
    if (!host) {
      const value = h('span.lobby-set-value');
      return {
        item,
        el: h('div.lobby-set.row', { 'data-key': item.key, 'data-anchor': '' }, label, value, hint()),
        set(v) { text(value, settingText(item, v)); },
      };
    }
    if (item.kind === 'stepper') {
      const st = stepper({ label: item.label, fmt: (v) => settingText(item, v), onChange: (v) => setSetting(item.key, v, STEP_WAIT_MS) });
      return {
        item,
        el: h('div.lobby-set.row', { 'data-key': item.key, 'data-anchor': '' }, label, st.el, hint()),
        set(v) { st.set(v, item.min, item.max, item.step); },
      };
    }
    if (item.kind === 'options') {
      const r = radios({ label: item.label, options: item.options, onPick: (v) => setSetting(item.key, v), className: 'lobby-options' });
      return {
        item,
        el: h('div.lobby-set.lobby-set-col', { 'data-key': item.key, 'data-anchor': '' }, label, hint(), r.el),
        set(v) { r.set(v); },
      };
    }
    const sw = toggle({ label: item.label, onChange: (on) => setSetting(item.key, on) });
    return {
      item,
      el: h('div.lobby-set.row', { 'data-key': item.key, 'data-anchor': '' }, label, sw.el, hint()),
      set(v) { sw.set(!!v); },
    };
  }

  function buildTime(host) {
    const parts = [];
    let presets = null;
    let rec = null;
    let recSub = null;
    let recState = null;
    const presetLine = h('p.lobby-hint.lobby-preset-line');
    if (host) {
      presets = radios({
        label: 'Game length',
        className: 'lobby-presets',
        options: Object.entries(PRESETS).map(([k, p]) => [k, p.label, `${p.settings.durationMin} min`]),
        onPick: (name) => {
          S.preset = name;
          render();
          Promise.resolve(app.cmd({ type: 'preset', name })).catch(() => null).then(() => {
            if (S.preset === name) S.preset = null;
            if (!S.destroyed) render();
          });
        },
      });
      recSub = h('span.lobby-rec-sub');
      recState = h('span.lobby-rec-state');
      rec = h('button.tile.lobby-rec', { type: 'button', 'aria-pressed': 'false' },
        h('span.lobby-rec-icon', icon('target', 22)),
        h('span.lobby-rec-text', h('span.lobby-rec-title', 'Recommended for your ring'), recSub),
        recState);
      rec.addEventListener('click', () => {
        if (rec.getAttribute('aria-disabled') === 'true' || rec.getAttribute('aria-pressed') === 'true') return;
        S.recommending = true;
        render();
        Promise.resolve(app.cmd({ type: 'recommend' })).catch(() => null).then(() => {
          S.recommending = false;
          if (!S.destroyed) render();
        });
      });
      parts.push(presets.el, presetLine, rec);
    } else {
      parts.push(presetLine);
    }
    const rows = SETTINGS_UI.map((item) => settingRow(item, host));
    parts.push(h('div.lobby-sets', rows.map((r) => r.el)));
    const el = card('Time and rules', parts);
    return {
      el,
      update(v) {
        const s = settingsNow();
        const n = (v.players || []).length;
        const which = Object.keys(PRESETS).find((k) => samePreset(s, k)) || null;
        const showing = S.preset || which;
        if (presets) presets.set(showing);
        const ring = v.ring && !ringProblem(v.ring) ? v.ring : null;
        const recOn = sameAsRecommended(s, ring, n);
        if (showing && PRESETS[showing]) text(presetLine, `${PRESETS[showing].label}: ${PRESETS[showing].line}.`);
        else if (recOn) text(presetLine, 'Recommended times for this ring.');
        else text(presetLine, `Custom: ${s.durationMin} min, pings every ${s.pingEveryMin}.`);
        if (rec) {
          if (!ring) {
            text(recSub, 'Draw the ring first, then tap here for times that suit it.');
            rec.setAttribute('aria-disabled', 'true');
            rec.setAttribute('aria-pressed', 'false');
            fill(recState);
          } else {
            const rs = ringSize(ring);
            const r = recommend(ring, n);
            text(recSub, `${rs.label} ring, ${fmtDistance(rs.across)} across: ${r.durationMin} min, pings every ${r.pingEveryMin}.`);
            rec.setAttribute('aria-disabled', S.recommending ? 'true' : 'false');
            rec.setAttribute('aria-pressed', recOn ? 'true' : 'false');
            if (S.recommending) fill(recState, h('span.lobby-rec-busy', 'Wait'));
            else if (recOn) fill(recState, icon('check', 20), h('span.sr-only', 'Using it'));
            else fill(recState, h('span.lobby-rec-use', 'Use'));
          }
        }
        let lastShown = null;
        for (const r of rows) {
          const shown = !r.item.show || r.item.show(s);
          if (r.el.hidden === shown) r.el.hidden = !shown;
          r.set(val(r.item.key));
          if (shown) lastShown = r;
        }
        for (const r of rows) cls(r.el, 'last', r === lastShown);
      },
    };
  }

  // v1.1 PAGE-WATCH: the Extras card (Driver, Spectators, Save the walkie-talkie), after the powers card.
  // Each row: extraRow({ app, host, setSetting, cmd }) -> { el, update(view) }; update gets the view with the
  // host's pending picks on top.
  function buildExtras(host) {
    const rows = [];
    const extras = card('Extras');
    extras.classList.add('lobby-extras');
    let last = null;
    const ctx = { app, host, setSetting: (key, value) => setSetting(key, value), cmd: (c) => app.cmd(c) };
    loadExtraRows().then((makers) => {
      if (S.destroyed || (S.w && S.w.extras && S.w.extras.el !== extras)) return; // built again since
      for (const make of makers) {
        if (!make) continue;
        try {
          const row = make(ctx);
          if (!row || !row.el) continue;
          rows.push(row);
          extras.appendChild(row.el);
          if (last) row.update(last);
        } catch (e) { console.error(e); }
      }
    });
    return {
      el: extras,
      update(v) {
        last = { ...v, settings: settingsNow() };
        for (const row of rows) {
          try { row.update(last); } catch (e) { console.error(e); }
        }
      },
    };
  }
  // v1.1 end PAGE-WATCH

  // -- powers --

  function buildPowers(host) {
    const rows = [];
    const group = (title, keys) => h('div.lobby-power-group',
      h('h3.lobby-power-head', title),
      keys.map((k) => {
        const p = POWERS[k];
        let ctl;
        let set;
        if (host) {
          const sw = toggle({ label: p.name, onChange: (on) => setSetting(`powers.${k}`, on) });
          ctl = sw.el;
          set = (on) => sw.set(on);
        } else {
          ctl = h('span.chip.lobby-power-state');
          set = (on) => { text(ctl, on ? 'On' : 'Off'); cls(ctl, 'ok', on); };
        }
        const row = h('div.lobby-power.row', { 'data-anchor': '' },
          h('span.lobby-power-icon', icon(POWER_ICON[k] || k, 22)),
          h('div.lobby-power-text', h('span.lobby-power-name', p.name), h('span.lobby-set-hint', p.desc)),
          ctl);
        rows.push({ k, row, set });
        return row;
      }));
    const el = card('Powers',
      h('p.lobby-hint', 'Each power works once a game.'),
      h('div.lobby-power-groups', group('Hiders', HIDER_POWERS), group('Hunters', HUNTER_POWERS)));
    return {
      el,
      update() {
        for (const r of rows) {
          const on = !!val(`powers.${r.k}`);
          r.set(on);
          cls(r.row, 'off', !on);
        }
      },
    };
  }

  // -- the bar at the bottom --

  function buildFoot(host) {
    if (!host) {
      const who = h('p.lobby-wait-text');
      const sum = h('p.lobby-wait-sum.mono');
      return {
        el: h('div.lobby-foot.guest', h('div.lobby-wait', { role: 'status' }, h('span.lobby-wait-dot', { 'aria-hidden': 'true' }), h('div', who, sum))),
        update(v) {
          const hostP = (v.players || []).find((p) => p.host);
          text(who, hostP ? `Waiting for ${hostP.name} to start the game` : 'Waiting for the host to start the game');
          const s = v.settings || {};
          const words = [`${s.durationMin} min game`, `${s.headStartMin} min head start`, `pings every ${s.pingEveryMin} min`];
          const sig = words.join('|');
          if (sum.dataset.sig !== sig) {
            sum.dataset.sig = sig;
            fill(sum, words.map((w, i) => [i ? ' · ' : '', h('span', w)]));
          }
        },
      };
    }
    const why = h('p#lobby-why.lobby-why', { 'aria-live': 'polite' });
    const start = h('button.btn.primary.wide.lobby-start', { type: 'button', 'aria-describedby': 'lobby-why' });
    start.addEventListener('click', async () => {
      if (start.getAttribute('aria-disabled') === 'true' || S.starting) return;
      if (startProblem(S.view)) return;
      // v1.4 PAGE-DEVICES: someone isn't ready: a warning, never a block
      if (!S.readyAsked) {
        const late = notReady(S.view);
        if (late.length) {
          openSheet({
            title: 'Not everyone is ready',
            className: 'rd-sheet',
            body: [h('p.rd-sheet-line', 'These phones may not share their location or sound. They can still play.'),
              h('ul.rd-sheet-list', late.map((p) => h('li', h('strong', p.name), `: ${p.why}`)))],
            actions: [
              { label: 'Start anyway', kind: 'primary', onClick: () => { S.readyAsked = true; setTimeout(() => { start.click(); S.readyAsked = false; }, 0); } },
              { label: 'Wait', kind: 'ghost' },
            ],
          });
          return;
        }
      }
      // v1.4 end PAGE-DEVICES
      S.starting = true;
      S.startError = '';
      render();
      let res;
      try {
        await flush(); // what the host just changed goes first
        if (S.destroyed) return;
        res = await app.cmd({ type: 'start' }, { quiet: true });
      } catch (e) {
        res = { error: { message: e && e.message } };
      }
      if (S.destroyed) return;
      S.starting = false;
      if (res && res.error) {
        S.startError = res.offline
          ? "No connection, so the game didn't start. Try again when you have signal."
          : res.message || res.error.message || "That didn't work. Try again.";
        S.startErrorSig = startSig(S.view);
      }
      render();
    });
    // v1.6: Let's vote: every phone plays the intro and votes on the mode, the length and a twist
    const voteBtn = h('button.btn.lobby-vote', { type: 'button' }, h('span', { 'aria-hidden': 'true' }, '🎲'), "Let's vote");
    voteBtn.addEventListener('click', () => {
      Promise.resolve(app.cmd({ type: 'votestart' })).catch(() => banner("The vote didn't start. Try again.", 'warn'));
    });
    return {
      el: h('div.lobby-foot', why, h('div.lobby-foot-row', voteBtn, start)),
      update(v) {
        const problem = startProblem(v);
        const words = S.startError || problem;
        text(why, words);
        why.hidden = !words;
        cls(why, 'error', !!S.startError);
        start.setAttribute('aria-disabled', problem || S.starting ? 'true' : 'false');
        fill(start, icon('play', 20), S.starting ? 'Starting...' : 'Start the game');
      },
    };
  }

  // What starting depends on: a refused Start's message goes once one of these changes.
  function startSig(v) {
    if (!v) return '';
    try {
      return JSON.stringify([v.ring, v.settings, (v.players || []).map((p) => [p.id, p.pick, p.status]), v.me && v.me.host]);
    } catch {
      return String(Math.random());
    }
  }

  // ---- building and drawing ----

  function build(host) {
    if (S.map) { try { S.map.destroy(); } catch { /* ignore */ } }
    S.map = null;
    S.mapSig = null;
    const w = {
      code: buildCode(),
      players: buildPlayers(host),
      mode: buildMode(host),
      ring: buildRing(host),
      time: buildTime(host),
      powers: buildPowers(host),
      extras: buildExtras(host), // v1.1 PAGE-WATCH
      foot: buildFoot(host),
    };
    S.w = w;
    S.host = host;
    // v1.5.1 (the clean-up): two tabs, Players (the code, who's in, the ready check) and Game (every setting), and
    // the long cards folded to a line until tapped. Everything is still there; only less of it at once.
    const panels = {
      players: h('div.lobby-panel', { 'data-tab': 'players', role: 'tabpanel', id: 'lobby-panel-players' }, w.code.el, w.players.el),
      game: h('div.lobby-panel', { 'data-tab': 'game', role: 'tabpanel', id: 'lobby-panel-game' }, w.mode.el, w.ring.el, w.time.el, w.powers.el, w.extras.el),
    };
    const tabBtn = (key, label) => {
      const b = h('button.lobby-tab', { type: 'button', role: 'tab', 'data-tab': key, 'aria-controls': `lobby-panel-${key}` }, label);
      b.addEventListener('click', () => showTab(key));
      return b;
    };
    const tabs = h('div.lobby-tabs', { role: 'tablist', 'aria-label': 'Lobby' }, tabBtn('players', 'Players'), tabBtn('game', host ? 'Game settings' : 'Game'));
    S.panels = panels;
    S.tabs = tabs;
    fill(root, h('div.lobby', { 'data-role': host ? 'host' : 'guest' },
      buildTop(),
      tabs,
      h('div.lobby-body', panels.players, panels.game), // v1.1 PAGE-WATCH: extras
      w.foot.el));
    fold(w.time.el, 'time');
    fold(w.powers.el, 'powers');
    fold(w.extras.el, 'extras');
    showTab(S.tab || 'players');
    // v1.3 PAGE-SETUP: the Checkpoints card, right after the ring card (it shows itself in Checkpoints mode)
    if (S.cpCard) { try { S.cpCard.destroy(); } catch { /* ignore */ } }
    S.cpCard = null;
    try {
      S.cpCard = cpCard({ app, host, setSetting: (key, value, wait) => setSetting(key, value, wait) });
      w.ring.el.after(S.cpCard.el);
    } catch (e) { console.error(e); S.cpCard = null; }
    // v1.3 end PAGE-SETUP
    // v1.4 PAGE-DEVICES: the ready check, at the top of the lobby
    if (S.ready) { try { S.ready.destroy(); } catch { /* ignore */ } }
    S.ready = null;
    try {
      S.ready = readyCard({ app, host });
      const slot = h('div.lobby-ready-slot', S.ready.el);
      const body = S.panels && S.panels.players;
      if (body) body.prepend(slot);
    } catch (e) { console.error(e); S.ready = null; }
    // v1.4 end PAGE-DEVICES
  }

  // v1.5.1: the lobby's tabs
  function showTab(key) {
    if (!S.panels || !S.panels[key]) key = 'players';
    S.tab = key;
    for (const [k, el] of Object.entries(S.panels)) el.hidden = !SHOW_ALL && k !== key;
    for (const b of S.tabs.querySelectorAll('.lobby-tab')) {
      const on = b.dataset.tab === key;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  // v1.5.1: a long card folded to its title and a one-line summary; a tap opens it (kept open across rebuilds)
  function fold(el, key) {
    const title = el.querySelector('.lobby-card-title');
    if (!title) return;
    const sum = h('span.lobby-fold-sum');
    const btn = h('button.lobby-fold', { type: 'button', 'aria-expanded': 'false' }, sum, h('span.lobby-fold-chev', icon('chevron', 18)));
    title.after(btn);
    el.classList.add('foldable');
    el.dataset.fold = key;
    const set = (open) => {
      cls(el, 'folded', !open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', `${open ? 'Close' : 'Open'} ${title.textContent}`);
    };
    btn.addEventListener('click', () => {
      const open = el.classList.contains('folded');
      if (open) S.open.add(key); else S.open.delete(key);
      set(open);
    });
    set(SHOW_ALL || S.open.has(key));
  }

  function foldSummaries() {
    const s = settingsNow();
    const put = (key, words) => {
      const el = root.querySelector(`.lobby-card[data-fold="${key}"] .lobby-fold-sum`);
      if (el) text(el, words);
    };
    const preset = Object.values(PRESETS).find((p) => Object.entries(p.settings).every(([k, v]) => s[k] === v));
    put('time', `${preset ? `${preset.label}: ` : ''}${s.durationMin} min, pings every ${s.pingEveryMin}`);
    const keys = [...HIDER_POWERS, ...HUNTER_POWERS];
    const on = keys.filter((k) => !!val(`powers.${k}`));
    put('powers', on.length === keys.length ? 'All on' : on.length ? `${on.map((k) => POWERS[k].name).join(', ')}` : 'All off');
    const names = { driver: 'Driver', spectators: 'Spectators', radioSave: 'Walkie saved', radioHiders: 'Hider walkie', cam: 'Camera', pins: 'Pins' };
    const ex = Object.keys(names).filter((k) => !!s[k]).map((k) => names[k]);
    put('extras', ex.length ? ex.join(', ') : 'None');
  }

  // Keep what's on screen in place while things above it change (a row appears, a setting shows).
  function keepPlace(fn) {
    const scroller = document.scrollingElement || html;
    const y = scroller.scrollTop;
    if (y < 2) { fn(); return; }
    let anchor = null;
    let top = 0;
    for (const el of root.querySelectorAll('[data-anchor]')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 8) { anchor = el; top = r.top; break; }
    }
    // The card it's in, by its place in the list: the page is built again when the host changes.
    const cards = [...root.querySelectorAll('.lobby-card')];
    const card = anchor ? anchor.closest('.lobby-card') : null;
    const cardIdx = card ? cards.indexOf(card) : -1;
    const cardTop = card ? card.getBoundingClientRect().top : 0;
    fn();
    let d = 0;
    if (anchor && anchor.isConnected) {
      d = anchor.getBoundingClientRect().top - top;
    } else if (cardIdx >= 0) {
      const now = root.querySelectorAll('.lobby-card')[cardIdx];
      if (now) d = now.getBoundingClientRect().top - cardTop;
    }
    if (Math.abs(d) >= 1) scroller.scrollTop += d;
  }

  function render() {
    const v = S.view;
    if (!v || S.destroyed) return;
    const host = !!(v.me && v.me.host);
    keepPlace(() => {
      if (host !== S.host) {
        // Becoming (or no longer being) the host changes every control: build again, keeping the scroll.
        const wasHost = S.host;
        build(host);
        if (wasHost !== null && host) banner("You're the host now. You can change the settings and start.", 'good', 4500);
      }
      const w = S.w;
      for (const part of [w.code, w.players, w.mode, w.ring, w.time, w.powers, w.extras, w.foot]) { // v1.1 PAGE-WATCH: extras
        try { part.update(v); } catch (e) { console.error(e); }
      }
      // v1.3 PAGE-SETUP
      if (S.cpCard) { try { S.cpCard.update({ ...v, settings: settingsNow() }); } catch (e) { console.error(e); } }
      // v1.3 end PAGE-SETUP
      if (S.ready) { try { S.ready.update({ ...v, settings: settingsNow() }); } catch (e) { console.error(e); } } // v1.4 PAGE-DEVICES
      try { foldSummaries(); } catch (e) { console.error(e); } // v1.5.1
    });
  }

  // ---- events while the lobby shows ----

  // Friends joining one after another get one banner with all their names, not a stack of them over the page.
  const joined = { names: [], shown: null };
  function joinBanner(e, about) {
    const p = S.view && (S.view.players || []).find((x) => x.id === about);
    const name = p ? p.name : String(e.text || '').replace(/ joined\.$/, '');
    const live = !!joined.shown && !!joined.shown.el && joined.shown.el.isConnected && !joined.shown.el._closing;
    if (!live) joined.names = [];
    if (!joined.names.includes(name)) joined.names.push(name);
    const n = joined.names;
    let words = e.text;
    if (n.length === 2) words = `${n[0]} and ${n[1]} joined.`;
    else if (n.length === 3) words = `${n[0]}, ${n[1]} and ${n[2]} joined.`;
    else if (n.length > 3) words = `${n[0]}, ${n[1]} and ${n.length - 2} others joined.`;
    if (live) joined.shown.close();
    joined.shown = banner(words, 'info', 3000);
  }

  S.offs.push(app.on('event', (e) => {
    if (!e || S.destroyed) return;
    const meId = S.view && S.view.me ? S.view.me.id : app.game && app.game.id;
    const about = e.data && e.data.id;
    if (e.kind === 'join' && about !== meId) joinBanner(e, about);
    else if ((e.kind === 'leave' || e.kind === 'kick') && about !== meId) banner(e.text, 'info', 3000);
    else if (e.kind === 'host' && about !== meId) banner(e.text, 'info', 3500);
    else if (e.kind === 'again') banner(e.text, 'good', 3500);
  }));
  S.offs.push(app.on('faces', () => { if (!S.destroyed && S.view) render(); }));
  S.offs.push(listen(window, 'resize', () => {
    if (S.map && S.map.resize) S.map.resize();
    if (S.cpCard && S.cpCard.resize) S.cpCard.resize(); // v1.3 PAGE-SETUP
  }));

  // The screen stays on while waiting here, so nobody's phone has gone to sleep when the host starts (a locked
  // phone gets no news: the reveal and the head start would wait for them to unlock it).
  try { app.alerts?.keepAwake?.(true, 'lobby'); } catch { /* no Wake Lock: fine */ }

  // First draw: an empty page until the view arrives (the App calls update right after mount).
  if (app.view) {
    S.view = app.view;
    render();
  } else {
    fill(root, h('div.lobby', h('p.lobby-hint', 'Loading the lobby...')));
  }

  // v1.6: the vote's show over everything (on every phone in the lobby)
  let voteShow = null;
  try { voteShow = createVoteShow(app); } catch (e) { console.error(e); }

  return {
    update(view) {
      if (!view || S.destroyed) return;
      S.view = view;
      if (voteShow) { try { voteShow.update(view); } catch (e) { console.error(e); } }
      // A refused Start's words stay until something that matters for starting changes.
      if (S.startError && startSig(view) !== S.startErrorSig) S.startError = '';
      // v1.3 PAGE-SETUP: ...and when the checkpoints change
      const cpSig = view.cp ? `${view.cp.count}|${view.cp.problem}` : '';
      if (S.startError && S.cpSig !== undefined && cpSig !== S.cpSig) S.startError = '';
      S.cpSig = cpSig;
      // v1.3 end PAGE-SETUP
      render();
    },
    destroy() {
      S.destroyed = true;
      if (voteShow) { try { voteShow.destroy(); } catch { /* ignore */ } }
      // Send stepper changes that were still waiting (the host tapped "Draw the ring" right after), unless
      // the lobby is over (the game started): then they can't apply any more.
      if (app.view && app.view.phase === 'lobby') flush();
      for (const t of [...S.timers.values()]) clearTimeout(t.id);
      S.timers.clear();
      for (const off of S.offs.splice(0)) { try { off(); } catch { /* ignore */ } }
      if (S.map) { try { S.map.destroy(); } catch { /* ignore */ } }
      S.map = null;
      if (S.cpCard) { try { S.cpCard.destroy(); } catch { /* ignore */ } } // v1.3 PAGE-SETUP
      if (S.ready) { try { S.ready.destroy(); } catch { /* ignore */ } } // v1.4 PAGE-DEVICES
      html.style.overflowAnchor = oldAnchor;
      try { app.alerts?.keepAwake?.(false, 'lobby'); } catch { /* ignore */ }
    },
  };
}
