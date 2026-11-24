// Night Ops v1.3 (PAGE-PLAY): the game screen's checkpoint parts.
//
//   cpParts({ app }) -> { card, main, update(view, clock), wantsMain(view), status(view, clock), destroy() }
//       card   the tray's Checkpoints card (more rows, every role): which checkpoint, where, how long, the scores
//       main   a free hider inside the open checkpoint: "Take the photo" (photos off: "Stay here: 0:12 of 0:20"),
//              shown in the main row in place of the status chip (game.js swaps them by wantsMain)
//       update(view, clock)  clock = the game screen's local clock (countdowns run between views)
//       status(view, clock)  a hider status card for the chip while it matters (exposed, safe inside) or null
//   Pure helpers (tested in Node): cpOf, slotTitle, cardFor, mainFor, cpHud, spotsFor, scoresLine, doneCount,
//   cpEffect, cpSpeech, cpDriveLine, hiderCpStatus, HELP_CP.
//   photoThumb(app, id, { title, size, line }) -> a button that shows the photo small and opens it big on a tap.
//
// The server decides everything (inside, safe time, who sees what): this only shows what view.cp says.
import { h, fill, text, cls } from '../dom.js?v=177';
import { icon } from '../ui/icons.js?v=177';
import { banner } from '../ui/banner.js?v=177';
import { openPhoto } from '../ui/photo.js?v=177';
import { takePhoto } from '../snap.js?v=177';
import { TIMING, fmtClock, fmtDistance } from '../../shared/rules.js?v=177';
import { directionWords, isPoint } from '../../shared/geo.js?v=177';

export const SAFE_WARN_MS = 30000;   // "Safe here" turns amber under this
const STAY_MS = TIMING.CP_STAY_MS || 20000;

export const HELP_CP = {
  hider: [
    'Checkpoints: one is open at a time. You see each new one a little before the hunters. Go there, do the task and take the photo. Each one counts once.',
    'Inside the open checkpoint you are safe for a few minutes. Stay too long, or go back to one you already did, and the hunters see you.',
    'Only go into the open checkpoint: other stores are off limits. No running or yelling inside stores.',
  ],
  hunter: [
    'Checkpoints: the hiders race to one open checkpoint at a time. You see each one a little after them.',
    "Hiders inside the open checkpoint are safe for a few minutes. Wait outside: no running or yelling inside stores. If they stay too long, they show up live on your map.",
  ],
  out: [
    'Checkpoints: the hider with the most checkpoints wins. Caught hiders keep the ones they did.',
  ],
};

// ---- reading the view (pure) ----------------------------------------------------------------------------

// view.cp while the game is on (null in the lobby, other modes, or a page without it).
export function cpOf(view) {
  const cp = view && view.cp;
  return cp && typeof cp === 'object' && cp.lobby === false ? cp : null;
}

const left = (ms, d) => (Number.isFinite(ms) ? Math.max(0, ms - Math.max(0, Number(d) || 0)) : null);

// "Checkpoint 2 of 6: 7-Eleven"
export function slotTitle(slot, total) {
  if (!slot) return '';
  const n = Number(slot.k) + 1;
  const name = String(slot.name || '').trim();
  return `Checkpoint ${n}${total > 0 ? ` of ${total}` : ''}${name ? `: ${name}` : ''}`;
}

function withStop(s) {
  const t = String(s || '').trim();
  return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.`;
}

// A free hider ('hider'), or anyone else ('other': hunters, the driver, players sitting out).
export function cpRole(view) {
  const me = view && view.me;
  return me && me.status === 'in' && me.team === 'hider' ? 'hider' : 'other';
}

// Where this phone is: its own mark, else what location says. [lng, lat] or null.
export function mySpot(view, pos = null) {
  const me = view && view.me;
  const m = ((view && view.marks) || []).find((x) => x && me && x.id === me.id && (x.kind === 'self' || x.kind === 'hunter' || x.kind === 'hider'));
  if (m && isPoint(m.p)) return m.p;
  return pos && isPoint(pos.p) ? pos.p : null;
}

// "300 m north-east" ('' without both spots; "Right here" within 20 m).
export function whereWords(from, to) {
  if (!isPoint(from) || !isPoint(to)) return '';
  const d = directionWords(from, to);
  return d.m < 20 ? 'Right here' : `${fmtDistance(d.m)} ${d.dir}`;
}

// The counted checkpoints this view shows (struck ones don't count).
export function doneCount(view, pid = null) {
  const cp = cpOf(view);
  if (!cp) return 0;
  return (cp.done || []).filter((d) => d && !d.struck && (pid === null || d.pid === pid)).length;
}

// "Ava 2, Mia 1" (only those with one or more), '' when nobody has one yet.
export function scoresLine(view, most = 4) {
  const cp = cpOf(view);
  const rows = ((cp && cp.scores) || []).filter((r) => r && r.count > 0);
  if (!rows.length) return '';
  const shown = rows.slice(0, most).map((r) => `${r.name || 'Someone'} ${r.count}`);
  return rows.length > most ? `${shown.join(', ')} and ${rows.length - most} more` : shown.join(', ');
}

// What the Checkpoints card says: { title, task, lines: [{ key, text, tone: 'ok'|'warn'|'danger'|'info'|'' }],
// scores, done, state: 'active'|'waiting'|'next'|'none', k }. d = ms since the view came (countdowns run on).
export function cardFor(view, d = 0, from = null) {
  const cp = cpOf(view);
  if (!cp) return null;
  const role = cpRole(view);
  const lines = [];
  let title = '';
  let task = '';
  let state = 'none';
  let k = null;
  const a = cp.active;
  const mine = role === 'hider' ? cp.mine : null;
  if (a) {
    state = 'active';
    k = a.k;
    title = slotTitle(a, cp.total);
    task = String(a.task || '').trim();
    const where = mine && mine.inside ? '' : whereWords(from, a.p);
    const closes = left(a.closesIn, d);
    if (role === 'hider') {
      if (where) lines.push({ key: 'where', text: where, tone: '' });
      if (mine && mine.did) {
        const nx = cp.next ? left(cp.next.inMs, d) : null;
        lines.push({ key: 'did', text: nx !== null ? `Done. Next one in ${fmtClock(nx)}.` : 'Done. That was the last one.', tone: 'ok' });
      } else if (closes !== null) {
        lines.push({ key: 'closes', text: `Closes in ${fmtClock(closes)}`, tone: closes < 60000 ? 'warn' : '' });
      }
      const hIn = left(a.huntersIn, d);
      if (hIn > 0) lines.push({ key: 'hunters', text: `Hunters see it in ${fmtClock(hIn)}`, tone: 'info' });
      if (mine && mine.exposed) {
        lines.push({ key: 'exposed', text: 'The hunters can see you. Leave the checkpoint.', tone: 'danger' });
      } else if (mine && mine.inside && Number.isFinite(mine.safeLeft)) {
        const safe = left(mine.safeLeft, d);
        lines.push({ key: 'safe', text: `Safe here: ${fmtClock(safe)}`, tone: safe < SAFE_WARN_MS ? 'warn' : 'ok' });
      } else if (mine && !mine.did && !mine.inside && mine.left <= 0) {
        lines.push({ key: 'nosafe', text: 'Your safe time here is used up: inside, the hunters see you.', tone: 'warn' });
      }
    } else {
      const head = [title, where].filter(Boolean).join(', ');
      title = withStop(head);
      if (closes !== null) lines.push({ key: 'closes', text: `Closes in ${fmtClock(closes)}.`, tone: '' });
      lines.push({ key: 'rule', text: 'Wait outside: no running or yelling inside stores.', tone: 'info' });
    }
  } else if (cp.waiting) {
    state = 'waiting';
    k = cp.waiting.k;
    const n = Number(cp.waiting.k) + 1;
    title = `The hiders have checkpoint ${n}.`;
    lines.push({ key: 'wait', text: `You see it in ${fmtClock(left(cp.waiting.inMs, d))}.`, tone: 'info' });
  } else if (cp.next) {
    state = 'next';
    k = cp.next.k;
    title = `Checkpoint ${Number(cp.next.k) + 1}${cp.total ? ` of ${cp.total}` : ''}`;
    lines.push({ key: 'next', text: `Opens for you in ${fmtClock(left(cp.next.inMs, d))}.`, tone: 'info' });
  } else {
    title = 'Checkpoints';
    lines.push({ key: 'none', text: 'No more checkpoints this game.', tone: '' });
  }
  const done = doneCount(view);
  return { title, task, lines, scores: scoresLine(view), done, state, k, role };
}

// The main row's checkpoint part for a free hider inside the open one: null, { kind: 'photo', k } or
// { kind: 'stay', k, text, ms }.
export function mainFor(view, d = 0) {
  const cp = cpOf(view);
  if (!cp || !view || view.phase !== 'live' || cpRole(view) !== 'hider') return null;
  const m = cp.mine;
  if (!m || !m.inside || m.did || !cp.active || cp.active.k !== m.k) return null;
  if (cp.photo) return { kind: 'photo', k: m.k };
  const stay = Number.isFinite(m.stay) ? Math.min(STAY_MS, m.stay + Math.max(0, Number(d) || 0)) : 0;
  return { kind: 'stay', k: m.k, ms: stay, text: `Stay here: ${fmtClock(stay)} of ${fmtClock(STAY_MS)}` };
}

// The hider's chip while a checkpoint matters: exposed (danger) or safe inside one already done. Else null.
export function hiderCpStatus(view, d = 0) {
  const cp = cpOf(view);
  if (!cp || cpRole(view) !== 'hider' || !cp.mine) return null;
  const m = cp.mine;
  if (m.exposed) {
    return { key: 'cp-exposed', title: 'Hunters can see you', line: 'Leave the checkpoint now.', tone: 'danger', icon: 'warn' };
  }
  if (m.inside && Number.isFinite(m.safeLeft)) {
    const safe = left(m.safeLeft, d);
    return {
      key: 'cp-safe',
      title: `Safe here ${fmtClock(safe)}`,
      line: m.did ? 'You did this checkpoint. Leave before the time runs out.' : 'Do the task and take the photo.',
      tone: safe < SAFE_WARN_MS ? 'warn' : 'ok',
      icon: 'flag',
    };
  }
  return null;
}

// The HUD's status words: "CP 2 4:10 7-Eleven" (the time before the name, which may be cut on small screens),
// "CP 2 in 1:20" (hunters waiting), "Next CP 3:10", or ''.
export function cpHud(view, d = 0) {
  const cp = cpOf(view);
  if (!cp || !view || view.phase !== 'live') return '';
  if (cp.active) {
    // (The time first: on a small screen the name is what gets cut.)
    const name = String(cp.active.name || '').trim();
    return `CP ${Number(cp.active.k) + 1} ${fmtClock(left(cp.active.closesIn, d))}${name ? ` ${name}` : ''}`;
  }
  if (cp.waiting) return `CP ${Number(cp.waiting.k) + 1} in ${fmtClock(left(cp.waiting.inMs, d))}`;
  if (cp.next) return `Next CP ${fmtClock(left(cp.next.inMs, d))}`;
  return '';
}

// Should this phone keep its fixes fresh (location.setFast)? A free hider at or near the open checkpoint: the
// server decides "inside" only on a fix under 20 s old, and a phone standing still may stop sending them.
export const FRESH_NEAR_M = 150;
export function cpWantsFresh(view) {
  const cp = cpOf(view);
  if (!cp || !view || view.phase !== 'live' || cpRole(view) !== 'hider' || !cp.active || !cp.mine) return false;
  const m = cp.mine;
  if (m.inside || m.exposed || Number.isFinite(m.safeLeft) || Number.isFinite(m.stay)) return true;
  const from = mySpot(view);
  if (!from || !isPoint(cp.active.p)) return false;
  return directionWords(from, cp.active.p).m <= (Number(cp.active.r) || 0) + FRESH_NEAR_M;
}

// The checkpoints for map.setSpots: the ones this phone may see so far.
export function spotsFor(view) {
  const cp = cpOf(view);
  if (!cp) return [];
  const me = view.me || {};
  const mineDone = new Set((cp.done || []).filter((x) => x && x.pid === me.id && !x.struck).map((x) => x.k));
  return (cp.list || []).filter((s) => s && isPoint(s.p)).map((s) => {
    const spot = {
      key: `cp-${s.k}`,
      p: s.p,
      r: Number(s.r) || 0,
      n: Number(s.k) + 1,
      name: String(s.name || ''),
      state: s.state === 'active' ? 'active' : mineDone.has(s.k) ? 'done' : 'closed',
    };
    if (mineDone.has(s.k)) spot.mine = true;
    return spot;
  });
}

function playerName(view, id) {
  const p = ((view && view.players) || []).find((x) => x && x.id === id);
  return p && p.name ? String(p.name) : 'Someone';
}

function slotOf(view, k) {
  const cp = cpOf(view);
  return cp ? (cp.list || []).find((s) => s && s.k === k) || null : null;
}

// What a 'checkpoint' event does on this phone (same shape as game.js's effectOf). Pure.
export function cpEffect(e, view) {
  const none = { moment: null, banner: null, buzz: null, beep: null, chat: false };
  if (!e || e.kind !== 'checkpoint' || !view || !view.me) return none;
  const me = view.me;
  const data = e.data && typeof e.data === 'object' ? e.data : {};
  const words = String(e.text || '');
  const say = (kind, b = null, bp = null) => ({ ...none, banner: words ? [words, kind] : null, buzz: b, beep: bp });
  const total = Number(data.total) || (cpOf(view) ? cpOf(view).total : 0);
  switch (data.what) {
    case 'open':
    case 'show': {
      const n = Number(data.k) + 1;
      const name = String(data.name || '').trim();
      const line = [withStop(name), withStop(data.task)].filter(Boolean).join(' ') || words;
      return {
        ...none,
        moment: { kicker: `Checkpoint ${n}${total ? ` of ${total}` : ''}`, title: 'NEW CHECKPOINT', line, kind: 'checkpoint' },
        buzz: 'ping',
        beep: 'ping',
      };
    }
    case 'soon':
      return say('info', 'tap');
    case 'done': {
      if (data.pid === me.id) {
        const count = doneCount(view, me.id);
        const slot = slotOf(view, data.k);
        return {
          ...none,
          moment: {
            kicker: slot ? slotTitle(slot, total) : `Checkpoint ${Number(data.k) + 1}`,
            title: 'CHECKPOINT DONE',
            line: count > 1 ? `That's ${count}.` : 'Your first one.',
            kind: 'checkpoint',
          },
          buzz: 'power',
          beep: 'power',
        };
      }
      return say('checkpoint', 'tap');
    }
    case 'at':
      return say('good', 'tap');
    case 'overstay':
    case 'again':
      if (e.to === me.id) return say('warn', 'warn', 'warn');
      return say('warn', 'ping');
    case 'close':
    case 'left':
    case 'strike':
      return say('info');
    default:
      return words ? say('info') : none;
  }
}

// What the driver's voice says for a checkpoint event (null = nothing). from = the driver's spot.
export function cpSpeech(e, view, from = null) {
  if (!e || e.kind !== 'checkpoint') return null;
  const data = e.data && typeof e.data === 'object' ? e.data : {};
  switch (data.what) {
    case 'show': {
      const name = String(data.name || '').trim() || `checkpoint ${Number(data.k) + 1}`;
      if (isPoint(from) && isPoint(data.p)) {
        const d = directionWords(from, data.p);
        if (d.m < 20) return `New checkpoint: ${name}, right here.`;
        const tens = Math.round(d.m / 10) * 10;
        const dist = tens < 1000 ? `${tens} metres` : `${(d.m / 1000).toFixed(1).replace(/\.0$/, '')} kilometres`;
        return `New checkpoint: ${name}, ${dist} ${d.dir}.`;
      }
      return `New checkpoint: ${name}.`;
    }
    case 'overstay':
    case 'again':
      if (e.to !== 'hunters') return null;
      return `${playerName(view, data.id)} is live at a checkpoint.`;
    case 'done':
      return `${playerName(view, data.pid)} did checkpoint ${Number(data.k) + 1}.`;
    default:
      return null;
  }
}

// The Driving layer's line: "Checkpoint 2, 7-Eleven: 400 m north-east, closes in 4 min" ('' when nothing's open
// for the driver yet).
export function cpDriveLine(view, from = null, d = 0) {
  const cp = cpOf(view);
  if (!cp) return '';
  if (cp.active) {
    const a = cp.active;
    const name = String(a.name || '').trim();
    const where = whereWords(from, a.p);
    const ms = left(a.closesIn, d);
    const mins = Math.max(1, Math.ceil(ms / 60000));
    const when = ms < 60000 ? 'closes in under a minute' : `closes in ${mins} min`;
    const at = where === 'Right here' ? 'right here' : where;
    return `Checkpoint ${Number(a.k) + 1}${name ? `, ${name}` : ''}: ${at ? `${at}, ` : ''}${when}`;
  }
  if (cp.waiting) return `Checkpoint ${Number(cp.waiting.k) + 1}: you see it in ${fmtClock(left(cp.waiting.inMs, d))}`;
  return '';
}

// ---- photos ---------------------------------------------------------------------------------------------

// A small photo button: a camera icon until the photo comes (app.photo), then the picture; a tap opens it big.
// `actions`: a function giving openSheet's actions at the tap (the host's "Don't count" during the game).
export function photoThumb(app, id, { title = 'Photo', line = '', size = 64, actions = null } = {}) {
  const box = h('span.cp-thumb-pic', { 'aria-hidden': 'true' }, icon('camera', Math.round(size * 0.4)));
  const btn = h('button.cp-thumb', {
    type: 'button',
    style: { width: `${size}px`, height: `${size}px` },
    'aria-label': `Photo: ${title}. Open it`,
  }, box);
  let src = null;
  const show = (url) => {
    if (!url || src) return;
    src = url;
    fill(box, h('img', { src: url, alt: '', draggable: 'false' }));
    btn.classList.add('has-pic');
  };
  const cached = app && app.photos && typeof app.photos.get === 'function' ? app.photos.get(id) : null;
  if (cached) show(cached);
  else if (app && typeof app.photo === 'function' && typeof id === 'string' && id) {
    Promise.resolve(app.photo([id])).then((got) => show(got && got[id])).catch(() => {});
  }
  btn.addEventListener('click', () => {
    if (!src) {
      banner(id ? "The photo isn't here yet. Try again in a moment." : 'No photo for this one.', 'info');
      if (id && app && typeof app.photo === 'function') Promise.resolve(app.photo([id])).then((got) => show(got && got[id])).catch(() => {});
      return;
    }
    let more = [];
    try { more = typeof actions === 'function' ? (actions() || []) : []; } catch (e) { console.error(e); }
    openPhoto({ src, title, line, actions: more });
  });
  return btn;
}

// v1.3 integration: the host's "Don't count" / "Count it again" for a done, while the game is on (the end screen's
// card has its own). [] for anyone else, or a done the host's view doesn't hold.
export function strikeActions(app, n) {
  const v = app && app.view;
  if (!v || v.phase !== 'live' || !v.me || !v.me.host || !v.cp || !Array.isArray(v.cp.done)) return [];
  const d = v.cp.done.find((x) => x && x.n === n);
  if (!d || typeof app.cmd !== 'function') return [];
  const go = async (struck) => {
    let res = null;
    try { res = await app.cmd({ type: 'cpstrike', n, struck }); } catch (e) { console.error(e); }
    if (res && !(res instanceof Error) && !res.error) {
      try { banner(struck ? `${d.name}'s checkpoint ${d.k + 1} doesn't count now.` : `${d.name}'s checkpoint ${d.k + 1} counts again.`, 'info'); } catch (e) { console.error(e); }
    }
  };
  return [d.struck
    ? { label: 'Count it again', kind: 'primary', onClick: () => go(false) }
    : { label: "Don't count", kind: 'danger', onClick: () => go(true) }];
}

// ---- the parts ------------------------------------------------------------------------------------------

export function cpParts({ app }) {
  const S = { view: null, sending: false, checking: false, kept: null, dead: false, cardKey: '', mainKey: '' };

  const cTitle = h('strong.cp-card-title');
  const cTask = h('p.cp-card-task');
  const cLines = h('div.cp-card-lines', { 'aria-live': 'polite' });
  const cScores = h('p.cp-card-scores');
  const card = h('section.cp-card', { 'aria-label': 'Checkpoints' },
    h('div.cp-card-head', h('span.cp-card-icon', icon('flag', 20)), cTitle),
    cTask, cLines, cScores);

  const mainWords = h('span.cp-main-words', 'Take the photo');
  const mainBtn = h('button.btn.primary.wide.cp-main', { type: 'button', onclick: () => onPhoto() }, icon('camera', 22), mainWords);
  const stayWords = h('span.cp-stay-words');
  const stayFill = h('span.cp-stay-fill', { 'aria-hidden': 'true' });
  const stayBox = h('div.cp-stay', { role: 'status', hidden: true }, stayFill, icon('clock', 20), stayWords);
  const main = h('div.cp-mainbox.tray-grow', mainBtn, stayBox);

  const lineEls = new Map();

  function dOf(view, clock) {
    if (!view || !Number.isFinite(clock) || !Number.isFinite(view.clock) || view.paused) return 0;
    return Math.max(0, clock - view.clock);
  }

  function from(view) {
    let pos = null;
    try { pos = app && typeof app.positionNow === 'function' ? app.positionNow() : null; } catch { pos = null; }
    return mySpot(view, pos);
  }

  function paintCard(view, d) {
    const c = cardFor(view, d, from(view));
    card.hidden = !c;
    if (!c) return;
    text(cTitle, c.title);
    text(cTask, c.task);
    cTask.hidden = !c.task;
    card.dataset.state = c.state;
    const keys = c.lines.map((l) => l.key);
    for (const [key, el] of lineEls) {
      if (!keys.includes(key)) { el.remove(); lineEls.delete(key); }
    }
    let prev = null;
    for (const l of c.lines) {
      let el = lineEls.get(l.key);
      if (!el) {
        el = h('p.cp-line');
        lineEls.set(l.key, el);
      }
      text(el, l.text);
      if ((el.dataset.tone || '') !== (l.tone || '')) el.dataset.tone = l.tone || '';
      const want = prev ? prev.nextSibling : cLines.firstChild;
      if (want !== el) cLines.insertBefore(el, want);
      prev = el;
    }
    const sc = c.scores ? `Scores: ${c.scores}` : 'No checkpoints done yet.';
    text(cScores, c.done ? `${sc} · Checkpoints done: ${c.done}` : sc);
  }

  function paintMain(view, d) {
    const m = mainFor(view, d);
    const photo = !!m && m.kind === 'photo';
    if (mainBtn.hidden !== !photo) mainBtn.hidden = !photo;
    const stay = !!m && m.kind === 'stay';
    if (stayBox.hidden !== !stay) stayBox.hidden = !stay;
    if (stay) {
      text(stayWords, m.text);
      stayFill.style.transform = `scaleX(${Math.max(0, Math.min(1, m.ms / STAY_MS)).toFixed(3)})`;
    }
    // (v1.3 integration: beside the hiders' walkie-talkie and Quiet a 390 px row has no room for the long words, so
    // it says "Photo"; its name stays "Take the photo".)
    const row = mainBtn.closest('.tray-main');
    const crowded = !!row && !!row.querySelector(':scope > .radio');
    const kept = !!S.kept && !!m && S.kept.k === m.k;
    const full = kept ? 'Send the photo' : 'Take the photo';
    text(mainWords, S.sending ? (S.checking ? 'Checking your spot...' : 'Sending...') : (crowded ? (kept ? 'Send' : 'Photo') : full));
    if (crowded && !S.sending) mainBtn.setAttribute('aria-label', full);
    else mainBtn.removeAttribute('aria-label');
    cls(mainBtn, 'busy', S.sending);
    if (S.sending) mainBtn.setAttribute('aria-disabled', 'true');
    else mainBtn.removeAttribute('aria-disabled');
  }

  // A photo that didn't go (outside by the server's last fix, no signal, busy) is kept for this checkpoint, so the
  // next tap sends it again without the camera ("Send the photo").
  const KEEP_ON = ['cp_outside', 'busy', 'server', 'error', 'timeout', 'offline'];
  async function onPhoto() {
    if (S.sending || S.dead) return;
    const view = S.view;
    const m = mainFor(view, 0);
    if (!m || m.kind !== 'photo') return;
    if (S.kept && S.kept.k !== m.k) S.kept = null;
    let shot = S.kept ? S.kept.shot : null;
    if (!shot) {
      // The highlight cam keeps the lead-in now: it stops while the phone's own camera is open (sync: the camera
      // must still open straight from the tap).
      try { if (app && app.cam && typeof app.cam.mark === 'function') app.cam.mark('checkpoint'); } catch (e) { console.error(e); }
      try {
        shot = await takePhoto();
      } catch (e) {
        banner((e && e.message) || "That photo didn't work. Try again.", 'warn');
        return;
      }
    }
    if (!shot || S.dead) return;
    S.kept = { k: m.k, shot };
    S.sending = true;
    S.checking = false;
    paintMain(S.view, 0);
    try {
      if (typeof app.sendPhoto !== 'function') throw new Error("This page can't send photos yet. Reload it.");
      await app.sendPhoto(m.k, shot.dataUrl, {
        onCheck: () => { if (!S.dead) { S.checking = true; paintMain(S.view, 0); } },
      });
      S.kept = null;
      // The 'done' event brings the moment.
    } catch (e) {
      const keep = !!e && (e.offline || KEEP_ON.includes(e.code));
      if (!keep) S.kept = null;
      const why = (e && e.message) || "That photo didn't send. Try again.";
      banner(keep ? `${why} Your photo is kept: tap Send the photo to try again.` : why, 'warn', 6000);
    } finally {
      S.sending = false;
      S.checking = false;
      if (!S.dead && S.view) paintMain(S.view, 0);
    }
  }

  return {
    card,
    main,
    wantsMain(view) { return !!mainFor(view, 0); },
    status(view, clock) { return hiderCpStatus(view, dOf(view, clock)); },
    update(view, clock) {
      if (S.dead || !view) return;
      S.view = view;
      const d = dOf(view, clock);
      try { paintCard(view, d); } catch (e) { console.error(e); }
      try { paintMain(view, d); } catch (e) { console.error(e); }
    },
    destroy() { S.dead = true; },
  };
}
