// Night Ops: the dev preview's Checkpoints samples while playing (v1.3, PAGE-PLAY). fixtures.js calls withCpPlay for
//   ?screen=game&as=hider&cp=lead|inside|safe|overstay|again|done[&photo=0]   Leo, a hider
//   ?screen=game&as=hunter&cp=waiting|shown|overstay                          Sam, a hunter
//   ?screen=game&as=driver&state=moving&cp=shown                               Sam driving
// Six checkpoints round Trinity Bellwoods; the third is open. Ava did the first, Priya the second (photos).
import { cleanCheckpoints } from '../shared/rules.js';
import { offsetM } from '../shared/geo.js';

const CENTRE = [-79.4135, 43.6476];
export const CP_SPOTS = [
  { id: 'k1', name: '7-Eleven', task: 'Buy a pack of gum', at: [-260, 180] },
  { id: 'k2', name: 'The big statue', task: 'Selfie with the big statue', at: [230, 220] },
  { id: 'k3', name: 'Bellwoods Market', task: 'Photo with something red', at: [150, -140] },
  { id: 'k4', name: 'Gas station', task: 'Selfie by the sign', at: [-320, -150] },
  { id: 'k5', name: 'Cafe Pamenar', task: '', at: [20, 300] },
  { id: 'k6', name: 'Kiosk', task: 'Buy a pack of gum', at: [380, -40] },
];
export const CP_PHOTO_IDS = ['a1b2c3d4e5f60718', 'b2c3d4e5f6071829', 'c3d4e5f60718293a'];
const ACTIVE = 2;
const OPEN_MS = 7 * 60000;

function rowOf(view, name) {
  return (view.players || []).find((p) => p.name === name) || null;
}

export function withCpPlay(view, params = {}) {
  const st = params.cp;
  if (!st || !view || view.phase !== 'live') return view;
  const photo = params.photo !== '0';
  view.settings = { ...view.settings, mode: 'checkpoints', cpOpenMin: 0, cpLeadMin: 2, cpSafeMin: 3, cpPhoto: photo, cpOrder: 'host' };
  const me = view.me;
  const hider = me.status === 'in' && me.team === 'hider';
  const self = (view.marks || []).find((m) => m.id === me.id && (m.kind === 'self' || m.kind === 'hunter'));
  const inside = ['inside', 'safe', 'overstay', 'again'].includes(st);
  const list = cleanCheckpoints(CP_SPOTS.map((c, k) => ({
    id: c.id,
    name: c.name,
    task: c.task,
    r: 35,
    // The open one sits right on Leo when he's inside it.
    p: k === ACTIVE && hider && inside && self ? self.p : offsetM(CENTRE, c.at[0], c.at[1]),
  })));
  const ava = rowOf(view, 'Ava');
  const priya = rowOf(view, 'Priya');
  const leo = rowOf(view, 'Leo');
  const done = [
    { n: 1, k: 0, pid: ava.id, name: 'Ava', clock: 540000, how: photo ? 'photo' : 'stay', photo: photo ? CP_PHOTO_IDS[0] : null, struck: false },
    { n: 2, k: 1, pid: priya.id, name: 'Priya', clock: 900000, how: photo ? 'photo' : 'stay', photo: photo ? CP_PHOTO_IDS[1] : null, struck: false },
  ];
  const did = st === 'done' || st === 'again' || st === 'safe';
  if (hider && did) done.push({ n: 3, k: ACTIVE, pid: leo.id, name: 'Leo', clock: view.clock - 40000, how: photo ? 'photo' : 'stay', photo: photo ? CP_PHOTO_IDS[2] : null, struck: false });
  const hunterSees = !hider && (st === 'shown' || st === 'overstay');
  const seesActive = hider || hunterSees;
  const slots = list.map((c, k) => ({ k, ...c, state: k === ACTIVE ? 'active' : 'closed' }));
  const seen = slots.filter((s) => s.k < ACTIVE || (s.k === ACTIVE && seesActive));
  const a = slots[ACTIVE];
  const huntersIn = st === 'lead' ? 72000 : 0;
  const scores = ['Ava', 'Leo', 'Priya', 'Jordan'].map((n) => rowOf(view, n)).filter(Boolean).map((p) => {
    const mine = done.filter((d) => d.pid === p.id && !d.struck);
    return { pid: p.id, name: p.name, count: mine.length, last: mine.length ? mine[mine.length - 1].clock : null, caught: !!p.caughtBy };
  }).sort((x, y) => y.count - x.count || (x.last ?? 1e12) - (y.last ?? 1e12) || x.name.localeCompare(y.name));
  view.cp = {
    lobby: false,
    total: list.length,
    unopened: 0,
    openMs: OPEN_MS,
    leadMs: 120000,
    safeMs: 180000,
    photo,
    list: seen.map(({ k, id, name, task, p, r, state }) => ({ k, id, name, task, p, r, state })),
    active: seesActive ? { k: a.k, id: a.id, name: a.name, task: a.task, p: a.p, r: a.r, closesIn: 250000, huntersIn } : null,
    waiting: !seesActive ? { k: ACTIVE, inMs: 80000 } : null,
    next: { k: ACTIVE + 1, inMs: hider ? 250000 : 370000 },
    mine: hider ? {
      k: ACTIVE,
      did,
      inside,
      safeLeft: st === 'inside' ? 161000 : st === 'safe' ? 25000 : null,
      exposed: st === 'overstay' ? 'time' : st === 'again' ? 'again' : null,
      canPhoto: photo && inside && !did,
      stay: !photo && st === 'inside' ? 12000 : null,
      left: st === 'overstay' ? 0 : st === 'safe' ? 25000 : st === 'inside' ? 161000 : 180000,
    } : null,
    done: done.filter((d) => hider || d.k < ACTIVE),
    scores,
  };
  // A hunter's map: Ava stayed at the checkpoint too long.
  if (!hider && st === 'overstay' && ava) {
    const i = view.marks.findIndex((m) => m.id === ava.id && m.kind !== 'sos');
    const mark = { id: ava.id, kind: 'overstay', p: offsetM(CENTRE, 150, -140), r: 0, age: 1500, label: 'Ava' };
    if (i >= 0) view.marks[i] = mark;
    else view.marks.push(mark);
  }
  // The play-by-play: Priya's checkpoint (with the photo) in the chat.
  let id = view.lastEventId || 0;
  const t0 = view.now - view.clock;
  const ev = (clock, to, text, data) => view.events.push({ id: ++id, at: t0 + clock, clock, kind: 'checkpoint', to, text, data });
  ev(900000, 'all', 'Priya did checkpoint 2: The big statue.', { what: 'done', n: 2, k: 1, pid: priya.id, photo: photo ? CP_PHOTO_IDS[1] : null, how: photo ? 'photo' : 'stay' });
  if (seesActive) {
    ev(view.clock - 60000, hider ? 'hiders' : 'hunters', `New checkpoint (3 of 6): ${a.name}. ${a.task}.`, { what: hider ? 'open' : 'show', k: ACTIVE, id: a.id, name: a.name, task: a.task, p: a.p, r: a.r, total: 6 });
  }
  view.lastEventId = id;
  return view;
}
