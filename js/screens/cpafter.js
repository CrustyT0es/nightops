// Night Ops v1.3 (PAGE-AFTER): Checkpoints after the game, in the replay and for spectators.
//
//   cpCard({ app, onWatch, canWatch }) -> { el, update(view), destroy() }   the end screen's Checkpoints card
//   cpReplay({ map }) -> { setData(summary), frame({ clockMs, map }), destroy() }   zones and done pulses
//   cpWatch({ app, map }) -> { el, update(view), destroy() }                 the spectator's parts
//   cpTicks(summary) -> [ { clockS, kind: 'checkpoint', label } ]            pure, the replay scrubber's ticks
//
// Pure helpers (tested in Node): cpFacts(view), cpBoard(facts), cpScoreLines(row, facts), cpTitle(winners,
// facts), cpShareLine(facts), cpReplaySpots(plan, done, routes, clockMs), cpWatchFacts(view), photoIds(rows).
// Names, tasks and texts only ever go in as text. Photos come from app.photo(ids) (the server sends only what this
// phone may see; a spectator's are 2 minutes late), never from a URL.
import { h, fill, face, text } from '../dom.js?v=182';
import { icon } from '../ui/icons.js?v=182';
import { banner } from '../ui/banner.js?v=182';
import { openPhoto } from '../ui/photo.js?v=182';
import { spotState, routeAt } from '../map.js?v=182';
import { fmtClock } from '../../shared/rules.js?v=182';
import { isPoint } from '../../shared/geo.js?v=182';

export const PULSE_MS = 4000;          // a done shows as a pulse on the hider's head this long (game time)
export const WATCH_NEWEST = 4;         // the spectator's tray shows this many of the newest dones
const STAY_WORDS = 'Stayed 20 s';

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= 64;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isPhotoId = (x) => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function clean(s, most = 200) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > most ? `${t.slice(0, most - 3).trimEnd()}...` : t;
}

function listNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function slotOf(x) {
  if (!isObj(x) || num(x.k) === null) return null;
  return {
    k: x.k,
    id: typeof x.id === 'string' ? x.id : `k${x.k}`,
    name: clean(x.name, 40) || `Checkpoint ${x.k + 1}`,
    task: clean(x.task, 80),
    p: isPoint(x.p) ? [x.p[0], x.p[1]] : null,
    r: num(x.r) !== null && x.r > 0 ? x.r : 35,
    at: num(x.at),
    show: num(x.show),
    close: num(x.close),
    state: x.state === 'active' || x.state === 'closed' ? x.state : null,
  };
}

function doneOf(x) {
  if (!isObj(x) || num(x.n) === null || num(x.k) === null || !isId(x.pid)) return null;
  return {
    n: x.n,
    k: x.k,
    pid: x.pid,
    name: clean(x.name, 40),
    clock: num(x.clock),
    how: x.how === 'stay' ? 'stay' : 'photo',
    photo: isPhotoId(x.photo) ? x.photo : null,
    struck: x.struck === true,
  };
}

function scoreOf(x) {
  if (!isObj(x) || !isId(x.pid)) return null;
  return {
    pid: x.pid,
    name: clean(x.name, 40),
    count: Math.max(0, Math.round(num(x.count) || 0)),
    last: num(x.last),
    caught: !!x.caught,
  };
}

// Everything Checkpoints shows at the end, from a view (view.cp is the freshest: it changes after a strike;
// summary.checkpoints has the plan's times and the close calls). null outside Checkpoints. Never throws.
export function cpFacts(view) {
  const v = isObj(view) ? view : {};
  const cp = isObj(v.cp) && v.cp.lobby !== true ? v.cp : null;
  const sum = isObj(v.summary) && isObj(v.summary.checkpoints) ? v.summary.checkpoints : null;
  const mode = isObj(v.settings) ? v.settings.mode : null;
  if (!cp && !sum) return null;
  if (mode && mode !== 'checkpoints' && !sum) return null;

  const names = new Map();
  for (const p of arr(v.players)) if (isObj(p) && isId(p.id) && clean(p.name, 40)) names.set(p.id, clean(p.name, 40));
  const caughtAt = new Map();
  if (isObj(v.summary)) {
    for (const p of arr(v.summary.players)) {
      if (!isObj(p) || !isId(p.id)) continue;
      if (clean(p.name, 40)) names.set(p.id, clean(p.name, 40));
      if (num(p.caughtAt) !== null) caughtAt.set(p.id, p.caughtAt);
    }
  }

  // The plan in play order: the summary's (with times), filled in from the view's list.
  const byK = new Map();
  for (const x of arr(sum && sum.plan)) { const s = slotOf(x); if (s && !byK.has(s.k)) byK.set(s.k, s); }
  for (const x of arr(cp && cp.list)) {
    const s = slotOf(x);
    if (!s) continue;
    if (!byK.has(s.k)) byK.set(s.k, s);
    else if (s.state) byK.get(s.k).state = s.state;
  }
  const plan = [...byK.values()].sort((a, b) => a.k - b.k);

  const doneSrc = cp && Array.isArray(cp.done) ? cp.done : arr(sum && sum.done);
  const seenN = new Set();
  const done = doneSrc.map(doneOf).filter((d) => d && !seenN.has(d.n) && seenN.add(d.n)).sort((a, b) => a.n - b.n);
  for (const d of done) { if (!d.name) d.name = names.get(d.pid) || 'Someone'; else if (!names.has(d.pid)) names.set(d.pid, d.name); }

  const scoreSrc = cp && Array.isArray(cp.scores) ? cp.scores : arr(sum && sum.scores);
  const scores = scoreSrc.map(scoreOf).filter(Boolean);
  for (const s of scores) { if (!s.name) s.name = names.get(s.pid) || 'Someone'; else if (!names.has(s.pid)) names.set(s.pid, s.name); }

  const closeCalls = arr(sum && sum.closeCalls)
    .filter((c) => isObj(c) && clean(c.text))
    .slice(0, 6)
    .map((c) => ({
      kind: ['cpsafe', 'cpnear', 'cpspare'].includes(c.kind) ? c.kind : 'cpnear',
      text: clean(c.text, 240),
      clock: num(c.clock) !== null && c.clock >= 0 ? c.clock : null,
      ids: arr(c.ids).filter(isId).slice(0, 6),
    }));

  const res = isObj(v.result) ? v.result : null;
  const winnerSrc = res && Array.isArray(res.winners) ? res.winners : isObj(v.summary) && Array.isArray(v.summary.winners) ? v.summary.winners : [];
  const winners = new Set(winnerSrc.filter(isId));

  const unopened = Math.max(0, Math.round(num(cp && cp.unopened) ?? num(sum && sum.unopened) ?? 0));
  const photo = cp && typeof cp.photo === 'boolean' ? cp.photo : isObj(v.settings) && typeof v.settings.cpPhoto === 'boolean' ? v.settings.cpPhoto : true;

  return {
    plan,
    done,
    scores,
    closeCalls,
    unopened,
    photo,
    winners,
    caughtAt,
    nameOf: (id) => names.get(id) || 'Someone',
    meId: isObj(v.me) && isId(v.me.id) ? v.me.id : null,
    host: !!(isObj(v.me) && v.me.host),
    over: v.phase === 'over',
  };
}

// The leaderboard rows, best first, each with its place (ties share it) and whether it won.
export function cpBoard(facts) {
  if (!facts) return [];
  const out = [];
  let place = 0;
  let prev = null;
  facts.scores.forEach((s, i) => {
    const same = prev && prev.count === s.count && prev.caught === s.caught && prev.last === s.last;
    if (!same) place = i + 1;
    prev = s;
    out.push({ ...s, place, won: facts.winners.has(s.pid) && s.count > 0, me: facts.meId === s.pid });
  });
  return out;
}

// The words on one leaderboard row.
export function cpScoreLines(row, facts) {
  const lines = [plural(row.count, 'checkpoint', 'checkpoints')];
  if (row.caught) {
    const at = facts && facts.caughtAt ? facts.caughtAt.get(row.pid) : null;
    lines.push(num(at) !== null ? `Caught at ${fmtClock(at)}` : 'Caught');
  } else {
    lines.push('Never caught');
  }
  if (row.count > 0 && num(row.last) !== null) lines.push(`${row.count === 1 ? 'Done' : 'Last one'} at ${fmtClock(row.last)}`);
  return lines;
}

// The hero's title in Checkpoints: "Ava wins with 4 checkpoints" / "Ava and Noah win with 3 checkpoints each".
// '' when the winners didn't win by checkpoints (none counted: Classic's words stay).
export function cpTitle(winnerIds, facts) {
  if (!facts) return '';
  const ids = arr(winnerIds).filter(isId);
  if (!ids.length) return '';
  const rows = ids.map((id) => facts.scores.find((s) => s.pid === id)).filter(Boolean);
  if (rows.length !== ids.length || !rows[0].count || rows.some((r) => r.count !== rows[0].count)) return '';
  const n = rows[0].count;
  const who = listNames(rows.map((r) => r.name));
  return rows.length === 1
    ? `${who} wins with ${plural(n, 'checkpoint', 'checkpoints')}`
    : `${who} win with ${plural(n, 'checkpoint', 'checkpoints')} each`;
}

// The share line's part: "Checkpoints: Ava 4, Mia 3, Noah 1" ('' with none counted).
export function cpShareLine(facts) {
  if (!facts) return '';
  const top = facts.scores.filter((s) => s.count > 0).slice(0, 3);
  return top.length ? `Checkpoints: ${top.map((s) => `${s.name} ${s.count}`).join(', ')}` : '';
}

// The replay scrubber's ticks: each counted checkpoint, at its clock.
// facts (cpFacts) when given: its dones (view.cp's, fresh after a strike; a later view may lack the summary).
export function cpTicks(summary, facts = null) {
  const cp = isObj(summary) && isObj(summary.checkpoints) ? summary.checkpoints : null;
  if (!cp && !facts) return [];
  const names = new Map();
  for (const p of arr(isObj(summary) ? summary.players : null)) if (isObj(p) && isId(p.id)) names.set(p.id, clean(p.name, 40));
  if (facts) for (const d of facts.done) if (!names.get(d.pid)) names.set(d.pid, facts.nameOf(d.pid));
  return arr(facts ? facts.done : cp.done).map(doneOf).filter((d) => d && !d.struck && d.clock !== null && d.clock >= 0)
    .sort((a, b) => a.clock - b.clock)
    .map((d) => ({ clockS: d.clock / 1000, kind: 'checkpoint', label: `${names.get(d.pid) || 'Someone'} did checkpoint ${d.k + 1}` }));
}

// The replay at a clock: the zones (open or closed by spotState) and the pulses (a done in its first PULSE_MS, on
// the hider's head as the route has it). Pure.
export function cpReplaySpots(plan, done, routes, clockMs) {
  const spots = [];
  for (const raw of arr(plan)) {
    const s = slotOf(raw);
    if (!s || !s.p) continue;
    const state = spotState(s, clockMs);
    if (!state) continue;
    spots.push({ key: `cp${s.k}`, p: s.p, r: s.r, n: s.k + 1, name: s.name, state });
  }
  const pulses = [];
  for (const raw of arr(done)) {
    const d = doneOf(raw);
    if (!d || d.struck || d.clock === null || clockMs < d.clock || clockMs >= d.clock + PULSE_MS) continue;
    const route = isObj(routes) ? routes[d.pid] : null;
    let p = null;
    if (Array.isArray(route) && route.length) {
      try { p = routeAt(route, clockMs / 1000).head; } catch { p = null; }
    }
    if (!isPoint(p)) {
      const slot = arr(plan).map(slotOf).find((s) => s && s.k === d.k);
      p = slot && slot.p ? slot.p : null;
    }
    if (p) pulses.push({ key: `d${d.n}`, n: d.n, pid: d.pid, p, age: clockMs - d.clock });
  }
  return { spots, pulses };
}

// A spectator's checkpoint facts (live: what the delayed view has; 2 minutes late by the server).
export function cpWatchFacts(view) {
  const v = isObj(view) ? view : {};
  const cp = isObj(v.cp) && v.cp.lobby !== true ? v.cp : null;
  if (!cp) return null;
  const names = new Map();
  for (const p of arr(v.players)) if (isObj(p) && isId(p.id) && clean(p.name, 40)) names.set(p.id, clean(p.name, 40));
  const list = arr(cp.list).map(slotOf).filter((s) => s && s.p).sort((a, b) => a.k - b.k);
  const active = isObj(cp.active) ? slotOf(cp.active) : null;
  const done = arr(cp.done).map(doneOf).filter(Boolean).sort((a, b) => b.n - a.n);
  for (const d of done) if (!d.name) d.name = names.get(d.pid) || 'Someone';
  const scores = arr(cp.scores).map(scoreOf).filter(Boolean);
  for (const s of scores) if (!s.name) s.name = names.get(s.pid) || 'Someone';
  const total = Math.max(0, Math.round(num(cp.total) || list.length));
  const waiting = isObj(cp.waiting) && num(cp.waiting.k) !== null ? { k: cp.waiting.k, inMs: Math.max(0, num(cp.waiting.inMs) || 0) } : null;
  const closesIn = active && isObj(cp.active) ? num(cp.active.closesIn) : null;
  return {
    list,
    spots: list.map((s) => ({
      key: `cp${s.k}`, p: s.p, r: s.r, n: s.k + 1, name: s.name,
      state: (active && active.k === s.k) || s.state === 'active' ? 'active' : 'closed',
    })),
    active: active ? { ...active, closesIn } : null,
    waiting,
    total,
    done,
    scores,
    nameOf: (id) => names.get(id) || 'Someone',
  };
}

// The photo ids in some done rows (counted or not), in order.
export function photoIds(rows) {
  return [...new Set(arr(rows).filter((d) => d && isPhotoId(d.photo)).map((d) => d.photo))];
}

// ---- photos on screen -----------------------------------------------------------------------------------------

// A thumbnail: a 44px button holding the photo (filled in when it comes), a tap opens it big. A 'stay' done is a
// tile with its words. opts: { app, done, title, line, actions: () => [...] }
function thumb({ app, done, title, line, actions, small = false }) {
  if (done.how === 'stay' || !done.photo) {
    return h(`span.cpa-tile.stay${done.struck ? '.struck' : ''}${small ? '.small' : ''}`,
      icon('clock', small ? 16 : 20), small ? null : h('span', STAY_WORDS));
  }
  const pic = h('span.cpa-pic', { 'aria-hidden': 'true' }, icon('camera', small ? 16 : 20));
  const b = h(`button.cpa-tile.photo${done.struck ? '.struck' : ''}${small ? '.small' : ''}`, {
    type: 'button',
    'aria-label': `Photo: ${title}${done.struck ? ', not counted' : ''}`,
    'data-photo': done.photo,
  }, pic);
  let src = '';
  b.addEventListener('click', () => {
    openPhoto({ src, title, line: line(), actions: typeof actions === 'function' ? actions() : [] });
  });
  if (app && typeof app.photo === 'function') {
    app.photo([done.photo]).then((got) => {
      const url = got && got[done.photo];
      if (typeof url !== 'string' || !url.startsWith('data:image/')) return;
      src = url;
      fill(pic, h('img', { src: url, alt: '', draggable: 'false' }));
      b.classList.add('has-pic');
    }).catch(() => { /* stays the camera icon */ });
  }
  return b;
}

// ---- the end screen's card ------------------------------------------------------------------------------------

export function cpCard({ app, onWatch = null, canWatch = () => false } = {}) {
  const S = { dead: false, sig: '', facts: null, busy: false };
  const boardList = h('ol.cpa-board', { role: 'list', 'aria-label': 'Checkpoints leaderboard' });
  const slots = h('div.cpa-slots');
  const callsTitle = h('h3#cpa-calls-title.label.cpa-sub', 'Close calls at checkpoints');
  const callsList = h('ul.cpa-calls', { role: 'list', 'aria-labelledby': 'cpa-calls-title' });
  const calls = h('div.cpa-calls-box', callsTitle, callsList);
  const unopened = h('p.cpa-unopened.over-hint');
  const el = h('section.over-card.cpa-card', { 'aria-labelledby': 'cpa-title', hidden: true },
    h('div.over-card-head', h('h2#cpa-title.label.cpa-title', icon('flag', 16), h('span', 'Checkpoints'))),
    boardList, slots, calls, unopened);

  const faceOf = (id) => (app && app.faces instanceof Map ? app.faces.get(id) : null) || null;

  async function strike(d, struck) {
    if (S.busy || S.dead || !app || typeof app.cmd !== 'function') return;
    S.busy = true;
    let res = null;
    try { res = await app.cmd({ type: 'cpstrike', n: d.n, struck }); } catch (e) { console.error(e); }
    S.busy = false;
    if (S.dead) return;
    if (res && !(res instanceof Error) && !res.error) {
      banner(struck ? `${d.name}'s checkpoint ${d.k + 1} doesn't count now.` : `${d.name}'s checkpoint ${d.k + 1} counts again.`, 'info');
    }
  }

  function draw(f) {
    const board = cpBoard(f);
    fill(boardList, board.map((r) => h(`li.cpa-row${r.won ? '.won' : ''}${r.me ? '.me' : ''}`,
      h('span.cpa-place.mono', { 'aria-label': `Place ${r.place}` }, String(r.place)),
      face({ name: r.name, src: faceOf(r.pid), team: r.caught ? 'out' : 'hider', size: 40 }),
      h('div.cpa-row-main',
        h('div.cpa-row-top',
          h('span.cpa-name', r.name),
          r.me ? h('span.chip.over-you-chip', 'You') : null,
          r.won ? h('span.chip.over-win-chip', icon('trophy', 13), h('span', 'Winner')) : null),
        h('p.cpa-row-line', cpScoreLines(r, f).slice(1).join(' · '))),
      h('span.cpa-count', { 'aria-hidden': 'true' }, h('strong.mono', String(r.count)), h('span', r.count === 1 ? 'checkpoint' : 'checkpoints')),
      h('span.sr-only', cpScoreLines(r, f)[0]))));
    boardList.hidden = !board.length;

    fill(slots, f.plan.map((s) => {
      const mine = f.done.filter((d) => d.k === s.k);
      const head = h('h3.cpa-slot-name', h('span.cpa-slot-n.mono', `${s.k + 1}.`), ' ', s.name, s.task ? h('span.cpa-slot-task', `: ${s.task}`) : null);
      const tiles = mine.map((d) => {
        const title = `${d.name}, checkpoint ${s.k + 1}`;
        const line = () => {
          const words = [`${d.name} did ${s.name}${d.clock !== null ? ` at ${fmtClock(d.clock)}` : ''}.`];
          if (d.struck) words.push('Not counted.');
          return words.join(' ');
        };
        const actions = () => (f.host && f.over && app && app.view && app.view.phase === 'over'
          ? [d.struck
            ? { label: 'Count it again', kind: 'primary', onClick: () => strike(d, false) }
            : { label: "Don't count", kind: 'danger', onClick: () => strike(d, true) }]
          : []);
        return h(`div.cpa-done${d.struck ? '.struck' : ''}`,
          thumb({ app, done: d, title, line, actions }),
          h('span.cpa-done-name', d.name),
          d.struck ? h('span.cpa-done-note', 'Not counted') : null,
          // (A 'stay' tile has no photo to open: the host strikes it here.)
          (d.how === 'stay' || !d.photo) && f.host && f.over
            ? h('button.btn.small.ghost.cpa-strike', {
              type: 'button', onclick: () => strike(d, !d.struck),
            }, d.struck ? 'Count it again' : "Don't count")
            : null);
      });
      const opened = f.over || s.state || mine.length;
      return h('section.cpa-slot', { 'aria-label': `Checkpoint ${s.k + 1}: ${s.name}` },
        head,
        tiles.length ? h('div.cpa-dones', tiles) : h('p.cpa-none', opened ? 'Nobody did this one.' : 'Not open yet.'));
    }));
    slots.hidden = !f.plan.length;

    calls.hidden = !f.closeCalls.length;
    fill(callsList, f.closeCalls.map((c, i) => {
      const id = `cpa-call-${i}`;
      const watch = onWatch && canWatch() && c.clock !== null
        ? h('button.btn.small.over-watch', { type: 'button', 'aria-describedby': id }, icon('play', 16), h('span', 'Watch'))
        : null;
      if (watch) watch.addEventListener('click', () => onWatch(c));
      return h(`li.cpa-call.k-${c.kind}`,
        h('div.cpa-call-text',
          h('span.cpa-call-kind', c.kind === 'cpsafe' ? 'Safe zone' : c.kind === 'cpspare' ? 'Just in time' : 'Close call',
            c.clock !== null ? ` · ${fmtClock(c.clock)}` : ''),
          h(`p#${id}.cpa-call-line`, c.text)),
        watch);
    }));

    text(unopened, f.unopened > 0
      ? `Never opened: ${plural(f.unopened, 'checkpoint', 'checkpoints')} (the game was too short).`
      : '');
    unopened.hidden = !f.unopened;
  }

  function update(view) {
    if (S.dead) return;
    const f = cpFacts(view);
    S.facts = f;
    el.hidden = !f;
    if (!f) { S.sig = ''; return; }
    const faces = app && app.faces instanceof Map ? [...f.scores].map((s) => (app.faces.get(s.pid) ? 1 : 0)).join('') : '';
    const sig = JSON.stringify([f.plan.map((s) => [s.k, s.name, s.task, s.state]), f.done, f.scores, f.closeCalls,
      f.unopened, [...f.winners], f.host, f.over, f.meId, faces, canWatch()]);
    if (sig === S.sig) return;
    S.sig = sig;
    draw(f);
  }

  return {
    el,
    update,
    destroy() { S.dead = true; },
  };
}

// ---- the replay's zones and pulses ----------------------------------------------------------------------------

export function cpReplay({ map = null } = {}) {
  const S = { dead: false, plan: [], done: [], routes: {}, map: null, spotsKey: '', layer: null, pulses: new Map(), raf: 0, last: null };
  const mapNow = (m) => (typeof m === 'function' ? m() : m) || (typeof map === 'function' ? map() : map);

  // facts (cpFacts) when given: its dones, fresh after a strike.
  function setData(summary, facts = null) {
    if (summary === S.summary && (!facts || facts.done === S.done)) return;
    S.summary = summary;
    const cp = isObj(summary) && isObj(summary.checkpoints) ? summary.checkpoints : null;
    S.plan = cp ? arr(cp.plan) : facts ? facts.plan : [];
    S.done = facts ? facts.done : cp ? arr(cp.done) : [];
    S.routes = isObj(summary) && isObj(summary.routes) ? summary.routes : {};
    S.spotsKey = '';
  }

  function layerOn(m) {
    if (S.layer && S.layer.isConnected && S.layer.parentNode === m.element) return S.layer;
    if (S.layer) S.layer.remove();
    S.layer = null;
    S.pulses.clear();
    if (!m || !m.element) return null;
    S.layer = h('div.cpa-pulses', { 'aria-hidden': 'true' });
    m.element.appendChild(S.layer);
    return S.layer;
  }

  function place() {
    S.raf = 0;
    const m = S.map;
    if (S.dead || !m || !S.layer) return;
    for (const rec of S.pulses.values()) {
      const xy = typeof m.project === 'function' ? m.project(rec.p) : null;
      if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) { rec.el.hidden = true; continue; }
      rec.el.hidden = false;
      rec.el.style.transform = `translate(${Math.round(xy[0])}px, ${Math.round(xy[1])}px)`;
    }
    // (While a pulse shows, follow a drag or pinch of the map.)
    if (S.pulses.size && typeof requestAnimationFrame === 'function') S.raf = requestAnimationFrame(place);
  }

  function frame({ clockMs, map: m0 } = {}) {
    if (S.dead || !Number.isFinite(clockMs)) return;
    const m = mapNow(m0);
    if (!m) return;
    if (m !== S.map) { S.map = m; S.spotsKey = ''; }
    const { spots, pulses } = cpReplaySpots(S.plan, S.done, S.routes, clockMs);
    const key = JSON.stringify(spots.map((s) => [s.key, s.state]));
    if (key !== S.spotsKey && typeof m.setSpots === 'function') {
      S.spotsKey = key;
      try { m.setSpots(spots.map((s) => ({ ...s, label: s.state === 'active' }))); } catch (e) { console.error(e); }
    }
    const layer = layerOn(m);
    if (!layer) return;
    const want = new Set();
    for (const p of pulses) {
      want.add(p.key);
      let rec = S.pulses.get(p.key);
      if (!rec) {
        const el = h('span.cpa-pulse', icon('check', 14));
        layer.appendChild(el);
        rec = { el, p: p.p };
        S.pulses.set(p.key, rec);
      }
      rec.p = p.p;
    }
    for (const [k, rec] of S.pulses) {
      if (want.has(k)) continue;
      rec.el.remove();
      S.pulses.delete(k);
    }
    if (S.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.raf);
    S.raf = 0;
    place();
  }

  return {
    setData,
    frame,
    destroy() {
      S.dead = true;
      if (S.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.raf);
      if (S.layer) S.layer.remove();
      S.layer = null;
      S.pulses.clear();
      if (S.map && typeof S.map.setSpots === 'function') { try { S.map.setSpots([]); } catch { /* gone */ } }
    },
  };
}

// ---- the spectator ------------------------------------------------------------------------------------------

// A play-by-play thumbnail for a 'done' event (null for anything else).
export function cpEventThumb({ app, event }) {
  if (!isObj(event) || event.kind !== 'checkpoint' || !isObj(event.data) || event.data.what !== 'done') return null;
  const d = doneOf({ ...event.data, name: '' });
  if (!d) return null;
  const words = clean(event.text, 120) || 'A checkpoint';
  return thumb({ app, done: d, title: words.replace(/\.$/, ''), line: () => words, small: true });
}

export function cpWatch({ app, map = null } = {}) {
  const S = { dead: false, sig: '', spotsKey: '', map: null };
  const now = h('p.cpa-w-now');
  const scores = h('p.cpa-w-scores');
  const newest = h('ul.cpa-w-dones', { role: 'list', 'aria-label': 'Newest checkpoints done' });
  const el = h('section.cpa-w', { 'aria-labelledby': 'cpa-w-title', hidden: true },
    h('h2#cpa-w-title.label.cpa-title', icon('flag', 16), h('span', 'Checkpoints')), now, scores, newest);

  function update(view) {
    if (S.dead) return;
    const f = cpWatchFacts(view);
    el.hidden = !f;
    const m = typeof map === 'function' ? map() : map;
    if (m !== S.map) { S.map = m; S.spotsKey = ''; }
    if (m && typeof m.setSpots === 'function') {
      const spots = f ? f.spots : [];
      const key = JSON.stringify(spots.map((s) => [s.key, s.state, s.p]));
      if (key !== S.spotsKey) {
        S.spotsKey = key;
        try { m.setSpots(spots.map((s) => ({ ...s, label: s.state === 'active' }))); } catch (e) { console.error(e); }
      }
    }
    if (!f) return;
    let line;
    if (f.active) {
      line = `Open: checkpoint ${f.active.k + 1} of ${f.total}, ${f.active.name}.${f.active.task ? ` ${f.active.task}.`.replace(/([.!?])\.$/, '$1') : ''}`;
    } else if (f.waiting) {
      line = `The hiders have checkpoint ${f.waiting.k + 1}. It shows here in ${fmtClock(f.waiting.inMs)}.`;
    } else if (f.list.length) {
      line = `${plural(f.list.length, 'checkpoint', 'checkpoints')} of ${f.total} so far.`;
    } else {
      line = `${plural(f.total, 'checkpoint', 'checkpoints')} tonight. None open yet.`;
    }
    const top = f.scores.filter((s) => s.count > 0);
    const scoreWords = top.length ? `Scores: ${top.slice(0, 5).map((s) => `${s.name} ${s.count}`).join(', ')}` : 'No checkpoints done yet.';
    const shown = f.done.slice(0, WATCH_NEWEST);
    const sig = JSON.stringify([line, scoreWords, shown]);
    if (sig === S.sig) return;
    S.sig = sig;
    text(now, line);
    text(scores, scoreWords);
    fill(newest, shown.map((d) => {
      const slot = f.list.find((s) => s.k === d.k);
      const what = `${d.name} did checkpoint ${d.k + 1}${slot ? `: ${slot.name}` : ''}`;
      return h(`li.cpa-w-done${d.struck ? '.struck' : ''}`,
        thumb({ app, done: d, title: what, line: () => `${what}.${d.struck ? ' Not counted.' : ''}`, small: true }),
        h('span.cpa-w-words', h('span.cpa-w-what', what), h('span.cpa-w-time.mono', d.clock !== null ? fmtClock(d.clock) : ''),
          d.struck ? h('span.cpa-done-note', 'Not counted') : null));
    }));
    newest.hidden = !shown.length;
  }

  return {
    el,
    update,
    destroy() {
      S.dead = true;
      if (S.map && typeof S.map.setSpots === 'function') { try { S.map.setSpots([]); } catch { /* gone */ } }
    },
  };
}

// The read-only lobby's rule line for a spectator: "6 checkpoints. Only the host knows where." (null otherwise).
export function cpRuleLine(view) {
  const v = isObj(view) ? view : {};
  if (!isObj(v.settings) || v.settings.mode !== 'checkpoints') return null;
  const n = isObj(v.cp) ? Math.max(0, Math.round(num(v.cp.count) || 0)) : 0;
  return ['Checkpoints', n ? `${plural(n, 'checkpoint', 'checkpoints')}. Only the host knows where.` : 'The host is setting them up.'];
}

