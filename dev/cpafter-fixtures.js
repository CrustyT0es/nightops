// Night Ops: the dev preview's Checkpoints samples after the game and for spectators (v1.3, PAGE-AFTER).
//   ?screen=over&cp=1[&host=1]           the end screen: Ava wins with 3 checkpoints; Priya's last one not counted
//   ?screen=watch&state=live&cp=1        a spectator 2 minutes behind: checkpoint 3 open, two done so far
//   ?screen=watch&state=over&cp=1        a spectator's end screen
// strikeCp(view, cmd) is the preview's stand-in for the host's {type:'cpstrike'} (scores and winners again).
import { cleanCheckpoints, cpPlan, schedule } from '../shared/rules.js';
import { offsetM } from '../shared/geo.js';
import { CP_SPOTS } from './cpplay-fixtures.js';

const CENTRE = [-79.4135, 43.6476];
// Seven checkpoints listed; the game time fits six of them (8 min each).
const SPOTS7 = [...CP_SPOTS, { id: 'k7', name: 'Supermarket', task: 'Photo with a shopping cart', at: [-120, -320] }];
export const CPA_PHOTOS = {
  ava1: '0a1b2c3d4e5f6071', priya2: '1b2c3d4e5f607182', ava3: '2c3d4e5f60718293', leo3: '3d4e5f607182930a',
  leo4: '4e5f607182930a1b', ava5: '5f607182930a1b2c', priya5: '607182930a1b2c3d',
};

function rowOf(view, name) {
  return (view.players || []).find((p) => p.name === name) || null;
}

function planOf(settings) {
  const list = cleanCheckpoints(SPOTS7.map((c) => ({ id: c.id, name: c.name, task: c.task, r: 35, p: offsetM(CENTRE, c.at[0], c.at[1]) })));
  const pl = cpPlan(settings, list.length);
  const plan = pl.slots.map((sl) => ({ ...list[sl.k], k: sl.k, at: sl.at, show: sl.show, close: sl.close }));
  return { plan, unopened: list.length - plan.length, pl };
}

// Scores as cpScores ranks them: count, never caught, the earliest last one, the name.
export function scoresOf(view, done) {
  const sum = view.summary;
  const rows = (sum ? sum.players : view.players).filter((p) => (sum ? p.startTeam === 'hider' : p.team === 'hider' || p.caughtBy));
  return rows.map((p) => {
    const mine = done.filter((d) => d.pid === p.id && !d.struck);
    const ks = new Set();
    let last = null;
    for (const d of mine) { if (!ks.has(d.k)) { ks.add(d.k); last = d.clock; } }
    return { pid: p.id, name: p.name, count: ks.size, last, caught: p.caughtAt !== null && p.caughtAt !== undefined ? true : !!p.caughtBy };
  }).sort((a, b) => b.count - a.count || (a.caught - b.caught) || (a.last ?? 1e15) - (b.last ?? 1e15) || a.name.localeCompare(b.name));
}

function winnersOf(scores, fallback) {
  const top = scores[0];
  if (!top || !top.count) return fallback;
  return scores.filter((s) => s.count === top.count && s.caught === top.caught && s.last === top.last).map((s) => s.pid);
}

function donesFor(view, plan) {
  const ava = rowOf(view, 'Ava');
  const leo = rowOf(view, 'Leo');
  const priya = rowOf(view, 'Priya');
  const at = (k, after) => plan[k].at + after;
  const list = [
    [0, ava, 140000, CPA_PHOTOS.ava1],
    [1, priya, 200000, CPA_PHOTOS.priya2],
    [2, ava, 150000, CPA_PHOTOS.ava3],
    [2, leo, 230000, CPA_PHOTOS.leo3],
    [3, leo, 160000, CPA_PHOTOS.leo4],
    [4, ava, 130000, CPA_PHOTOS.ava5],
    [4, priya, 210000, CPA_PHOTOS.priya5],
  ].filter(([k, who]) => plan[k] && who);
  return list.map(([k, who, after, photo], i) => ({
    n: i + 1, k, pid: who.id, name: who.name, clock: at(k, after), how: 'photo', photo, struck: false,
  }));
}

// The end screen.
export function withCpOver(view, params = {}) {
  if (params.cp !== '1' || !view || view.phase !== 'over') return view;
  view.settings = { ...view.settings, mode: 'checkpoints', cpOpenMin: 8, cpLeadMin: 2, cpSafeMin: 3, cpPhoto: true, cpOrder: 'host' };
  // host=1: this phone (Leo) is the host, so Don't count shows.
  if (params.host === '1' && view.me) {
    view.me = { ...view.me, host: true };
    view.players = view.players.map((p) => ({ ...p, host: p.id === view.me.id }));
  }
  const { plan, unopened } = planOf(view.settings);
  const done = donesFor(view, plan);
  // Priya's checkpoint 5 isn't counted (a blurry photo).
  const priya5 = done.find((d) => d.photo === CPA_PHOTOS.priya5);
  if (priya5) priya5.struck = true;
  const scores = scoresOf(view, done);
  const winners = winnersOf(scores, view.result ? view.result.winners : []);
  const ava = rowOf(view, 'Ava');
  const sam = rowOf(view, 'Sam');
  const leo = rowOf(view, 'Leo');
  const mia = rowOf(view, 'Mia');
  const closeCalls = [
    { kind: 'cpsafe', text: 'Sam reached Ava at checkpoint 3, but Ava was in the safe zone.', clock: plan[2].at + 170000, ids: [ava.id, sam.id] },
    { kind: 'cpnear', text: 'Leo did checkpoint 4 with Mia 22 m away.', clock: plan[3].at + 160000, ids: [leo.id, mia.id] },
    { kind: 'cpspare', text: 'Ava left checkpoint 5 with 6 s of safe time left.', clock: plan[4].at + 290000, ids: [ava.id] },
  ];
  view.result = { ...view.result, winners };
  if (view.summary) {
    const names = winners.map((id) => (view.players.find((p) => p.id === id) || {}).name || 'Someone');
    const events = [...view.summary.events];
    for (const s of plan) events.push({ clock: s.show, text: `Checkpoint ${s.k + 1} opened: ${s.name}.` });
    for (const d of done) events.push({ clock: d.clock, text: `${d.name} did checkpoint ${d.k + 1}: ${plan[d.k].name}.` });
    events.sort((a, b) => a.clock - b.clock);
    const last = events[events.length - 1];
    if (last && /^Time's up/.test(last.text)) last.text = `Time's up! ${names.join(' and ')} ${names.length === 1 ? 'wins' : 'win'} with ${scores[0].count} checkpoints.`;
    view.summary = {
      ...view.summary,
      winners,
      mvp: winners[0] || view.summary.mvp,
      events,
      players: view.summary.players.map((p) => {
        const s = scores.find((x) => x.pid === p.id);
        return s ? { ...p, checkpoints: s.count } : p;
      }),
      checkpoints: { plan, unopened, done: done.map(({ name, ...d }) => d), scores, closeCalls },
    };
    if (view.summary.cam && Array.isArray(view.summary.cam.moments)) {
      view.summary.cam = { ...view.summary.cam, moments: [...view.summary.cam.moments, ...done.map((d) => ({ kind: 'checkpoint', clock: d.clock, ids: [d.pid] }))] };
    }
  }
  view.cp = {
    lobby: false,
    total: plan.length,
    unopened,
    openMs: 8 * 60000,
    leadMs: 120000,
    safeMs: 180000,
    photo: true,
    list: plan.map(({ k, id, name, task, p, r }) => ({ k, id, name, task, p, r, state: 'closed' })),
    active: null,
    waiting: null,
    next: null,
    mine: null,
    done,
    scores,
  };
  return view;
}

// The host's "Don't count" / "Count it again" in the preview: the done, the scores and the winners again.
export function strikeCp(view, cmd) {
  if (!view || !view.cp || !Array.isArray(view.cp.done)) return view;
  const done = view.cp.done.map((d) => (d.n === cmd.n ? { ...d, struck: !!cmd.struck } : d));
  const scores = scoresOf(view, done);
  const winners = winnersOf(scores, view.result ? view.result.winners : []);
  const out = { ...view, cp: { ...view.cp, done, scores }, result: { ...view.result, winners } };
  if (view.summary && view.summary.checkpoints) {
    out.summary = {
      ...view.summary,
      winners,
      checkpoints: { ...view.summary.checkpoints, done: done.map(({ name, ...d }) => d), scores },
    };
  }
  return out;
}

// A spectator (live: 2 minutes behind, so only what had shown by then; over: everything).
export function withCpWatch(view, params = {}) {
  if (params.cp !== '1' || !view) return view;
  if (view.phase === 'over') return withCpOver(view, params);
  if (view.phase !== 'live') return view;
  view.settings = { ...view.settings, mode: 'checkpoints', cpOpenMin: 8, cpLeadMin: 2, cpSafeMin: 3, cpPhoto: true, cpOrder: 'host' };
  const sch = schedule(view.settings);
  const { plan, unopened } = planOf(view.settings);
  const T = view.clock;
  // The sample's clock sits in the third checkpoint's window: make it open as of T.
  const shift = Math.max(0, (plan[2] ? plan[2].show + 60000 : T) - T);
  const at = T + shift;
  const seen = plan.filter((s) => s.show <= at);
  const done = donesFor(view, plan).filter((d) => d.clock <= at && plan[d.k].show <= at).map((d) => ({ ...d, clock: d.clock - shift }));
  const activeSlot = plan.find((s) => s.show <= at && at < s.close) || null;
  const next = plan.find((s) => s.at > at) || null;
  const scores = scoresOf(view, done);
  view.cp = {
    lobby: false,
    total: plan.length,
    unopened,
    openMs: 8 * 60000,
    leadMs: 120000,
    safeMs: 180000,
    photo: true,
    list: seen.map(({ k, id, name, task, p, r }) => ({ k, id, name, task, p, r, state: activeSlot && activeSlot.k === k ? 'active' : 'closed' })),
    active: activeSlot ? { k: activeSlot.k, id: activeSlot.id, name: activeSlot.name, task: activeSlot.task, p: activeSlot.p, r: activeSlot.r, closesIn: activeSlot.close - at, huntersIn: 0 } : null,
    waiting: null,
    next: next ? { k: next.k, inMs: next.show - at } : null,
    mine: null,
    done,
    scores,
  };
  let id = view.lastEventId || 0;
  const t0 = view.now - view.clock;
  const events = [...view.events];
  for (const d of done) {
    events.push({
      id: ++id, at: t0 + d.clock, clock: d.clock, kind: 'checkpoint', to: 'all', side: 'all',
      text: `${d.name} did checkpoint ${d.k + 1}: ${plan[d.k].name}.`,
      data: { what: 'done', n: d.n, k: d.k, pid: d.pid, photo: d.photo, how: d.how },
    });
  }
  if (activeSlot) {
    events.push({
      id: ++id, at: t0 + Math.max(sch.headStartMs, activeSlot.show - shift), clock: Math.max(0, activeSlot.show - shift), kind: 'checkpoint', to: 'hunters', side: 'hunters',
      text: `New checkpoint (${activeSlot.k + 1} of ${plan.length}): ${activeSlot.name}. Wait outside: no running or yelling inside stores.`,
      data: { what: 'show', k: activeSlot.k, id: activeSlot.id, name: activeSlot.name, task: activeSlot.task, p: activeSlot.p, r: activeSlot.r, total: plan.length },
    });
  }
  events.sort((a, b) => a.clock - b.clock);
  events.forEach((e, i) => { e.id = i + 1; });
  view.events = events;
  view.lastEventId = events.length;
  return view;
}
