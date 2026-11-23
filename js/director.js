// Night Ops v1.2 (PAGE-CAM): the director. Pure (no DOM, no clocks): from everyone's clips, the walkie-talkie and
// the moments, which clip the replay shows at each moment of the game. Same input, same cuts.
//
//   fileTimeAt(clip, clock)            -> seconds into the clip's file at that game clock, or null (outside it)
//   direct({ clips, talk, moments, routes, from, to, follow }) -> [{ from, to, id, pid, why }]
//   movieWindows({ cuts, moments, talk, most }) -> [{ from, to }]   what "Download the movie" plays
//
// Rules, worked out second by second over [from, to) (game clock, ms):
//   1. Candidates = clips covering t. A dark one (bright < DARK) only counts when every candidate is dark.
//   2. follow (a face tapped): that player's clip whenever they have one (any brightness).
//   3. Talk: the speaker's clip while their walkie message plays; else the other talker of the exchange.
//   4. A tag, "no", catch or close call (its clip window around the moment): its people, cutting every SHOT_MS.
//      (v1.3: a checkpoint done or a safe time run out too, why 'checkpoint'.)
//   4b. (v1.4.7) Someone talking near their phone: a 'talk' clip while it hears speech, dark or not, why 'voice'.
//   5. Else the loudest / fastest-moving (loud + min(50, speed x 10)); 'only' when there's one candidate.
// A shot is held at least SHOT_MS unless its clip ends or goes dark, or a higher rule starts; within the
// loudest rule a switch needs a score SWITCH_BY higher.
import { TIMING } from '../shared/rules.js?v=175';
import { distanceM } from '../shared/geo.js?v=175';

export const SHOT_MS = 3000;
export const DARK = 12;
export const TALK_PAIR_MS = 10000;
export const SWITCH_BY = 15;
export const STEP_MS = 1000;

const PRE = TIMING.CAM_PRE_MS || 10000;
const POST = TIMING.CAM_POST_MS || 20000;
const RANK = { follow: 4, talk: 3, tag: 2, near: 2, loud: 1, only: 1 };
const SCENE_KINDS = new Set(['tag', 'denied', 'caught', 'near']);
// v1.3 PAGE-AFTER: rule 4 also takes a checkpoint done and a safe time run out (why 'checkpoint')
RANK.checkpoint = 2;
SCENE_KINDS.add('checkpoint');
SCENE_KINDS.add('overstay');
const sceneWhy = (kind) => (kind === 'near' ? 'near' : kind === 'checkpoint' || kind === 'overstay' ? 'checkpoint' : 'tag');
// v1.4 PAGE-REEL: a hack and a tap are rule 4 moments too (why 'hack' / 'tap')
RANK.hack = 2;
RANK.tap = 2;
SCENE_KINDS.add('hack');
SCENE_KINDS.add('tap');
const sceneWhy14 = (kind) => (kind === 'hack' || kind === 'tap' ? kind : sceneWhy(kind));
// v1.4 end PAGE-REEL
const weighty = (why) => why === 'hack' || why === 'tap' || why === 'talk' || why === 'tag' || why === 'near' || why === 'checkpoint' || why === 'voice';
// v1.3 end PAGE-AFTER
// v1.4.7: someone talking near their phone: a clip the phone kept for talking ('talk' in its kinds) while its
// loudness says they speak is shown over the loudest (even a dark one: the movie shows their face and plays it);
// below the walkie-talkie and the big moments. Everything's pieces never have 'talk', so they're unchanged.
export const VOICE_LEVEL = 45; // camera.js TALK_LEVEL
RANK.voice = 1.5;
// v1.4.7 end

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// Seconds into the file at a game clock. `clocks` gives the game clock at each whole second of the file (equal
// numbers while the game was paused); without it the file is taken to run with the clock from `start`.
export function fileTimeAt(clip, clock) {
  const c = num(clock);
  if (!clip || c === null) return null;
  const start = num(clip.start);
  const end = num(clip.end);
  if (start === null || end === null || c < start || c > end) return null;
  const length = num(clip.ms) !== null ? clip.ms / 1000 : (end - start) / 1000;
  let list = Array.isArray(clip.clocks) ? clip.clocks.filter((x) => num(x) !== null) : [];
  // v1.4 PAGE-REEL: t0, the clock measured at the file's first frame, is the exact start (clocks[0] is rounded)
  const t0 = num(clip.t0);
  if (t0 !== null && list.length >= 2) { const d = list[0] - t0; list = list.map((x) => x - d); }
  if (t0 !== null && list.length < 2) return Math.max(0, Math.min(length, (c - t0) / 1000));
  // v1.4 end PAGE-REEL
  if (list.length < 2) return Math.max(0, Math.min(length, (c - start) / 1000));
  if (c < list[0]) return 0;
  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i];
    const b = list[i + 1];
    if (c >= a && c < b) return Math.max(0, Math.min(length, i + (c - a) / (b - a)));
  }
  const last = list.length - 1;
  return Math.max(0, Math.min(length, last + (c - list[last]) / 1000));
}

// The value of a per-second list (loud, bright) at a game clock; null when unknown.
export function perSecond(clip, key, clock) {
  const s = fileTimeAt(clip, clock);
  const list = clip && Array.isArray(clip[key]) ? clip[key] : null;
  if (s === null || !list || !list.length) return null;
  const v = list[Math.max(0, Math.min(list.length - 1, Math.floor(s)))];
  return num(v);
}

export function isDark(clip, clock) {
  const b = perSecond(clip, 'bright', clock);
  return b !== null && b < DARK;
}

// m/s of a player around a clock (summary.routes: [[lng, lat, clockSeconds], ...]).
export function speedAt(routes, pid, clock) {
  const pts = routes && Array.isArray(routes[pid]) ? routes[pid] : null;
  if (!pts || pts.length < 2) return 0;
  const t = clock / 1000;
  let i = 0;
  while (i < pts.length - 1 && pts[i + 1][2] <= t) i += 1;
  const a = pts[Math.max(0, Math.min(i, pts.length - 2))];
  const b = pts[Math.max(1, Math.min(i + 1, pts.length - 1))];
  const dt = b[2] - a[2];
  if (!(dt > 0) || Math.abs(t - a[2]) > 120) return 0;
  const d = distanceM([a[0], a[1]], [b[0], b[1]]);
  return Number.isFinite(d) ? d / dt : 0;
}

// v1.4.7: how loud a talk clip's speech is in the second from t (loudQ: at least 2 of its 4 quarters over
// VOICE_LEVEL; else the per-second loud), or null when nobody speaks there (or it isn't a talk clip).
export function speaksAt(clip, t) {
  if (!clip || !Array.isArray(clip.kinds) || !clip.kinds.includes('talk')) return null;
  const s = fileTimeAt(clip, t);
  if (s === null) return null;
  if (Array.isArray(clip.loudQ) && clip.loudQ.length) {
    const i = Math.floor(s * 4);
    let n = 0;
    let top = 0;
    for (let k = i; k < i + 4 && k < clip.loudQ.length; k += 1) {
      const v = num(clip.loudQ[k]);
      if (v === null) continue;
      if (v >= VOICE_LEVEL) n += 1;
      top = Math.max(top, v);
    }
    return n >= 2 ? top : null;
  }
  const v = perSecond(clip, 'loud', t);
  return v !== null && v >= VOICE_LEVEL ? v : null;
}

function covers(clip, t) {
  return fileTimeAt(clip, t) !== null && t < clip.end;
}

// Of one player's clips covering t, the one to show: the current one if it's theirs, else the one going on longest.
function pickOf(list, currentId) {
  if (!list.length) return null;
  const cur = list.find((c) => c.id === currentId);
  if (cur) return cur;
  return list.slice().sort((a, b) => (b.end - a.end) || (a.id < b.id ? -1 : 1))[0];
}

function clean(clips) {
  return (Array.isArray(clips) ? clips : [])
    .filter((c) => c && typeof c.id === 'string' && typeof c.pid === 'string' && num(c.start) !== null && num(c.end) !== null && c.end > c.start)
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.id < b.id ? -1 : 1));
}

function talkOf(talk) {
  return (Array.isArray(talk) ? talk : [])
    .filter((x) => x && typeof x.from === 'string' && num(x.clock) !== null)
    .map((x) => ({ from: x.from, clock: x.clock, ms: num(x.ms) !== null ? Math.max(500, x.ms) : 3000, side: x.side || null }))
    .sort((a, b) => a.clock - b.clock);
}

function scenesOf(moments) {
  return (Array.isArray(moments) ? moments : [])
    .filter((m) => m && SCENE_KINDS.has(m.kind) && num(m.clock) !== null && Array.isArray(m.ids) && m.ids.length)
    .sort((a, b) => a.clock - b.clock);
}

export function direct({ clips, talk, moments, routes, from, to, follow = null } = {}) {
  const list = clean(clips);
  if (!list.length) return [];
  const lo = num(from) !== null ? from : list[0].start;
  const hi = num(to) !== null ? to : Math.max(...list.map((c) => c.end));
  if (!(hi > lo)) return [];
  const talks = talkOf(talk);
  const scenes = scenesOf(moments);
  const out = [];
  let cur = null; // { id, pid, why, since, score }

  for (let t = lo; t < hi; t += STEP_MS) {
    const all = list.filter((c) => covers(c, t));
    if (!all.length) {
      cur = null;
      continue;
    }
    const bright = all.filter((c) => !isDark(c, t));
    const pool = bright.length ? bright : all;
    const byPid = (pid, from = pool) => pickOf(from.filter((c) => c.pid === pid), cur && cur.id);

    // What each rule wants now.
    let want = null;
    if (follow) {
      const c = byPid(follow, all);
      if (c) want = { clip: c, why: 'follow' };
    }
    if (!want) {
      const speaking = talks.filter((x) => t >= x.clock && t < x.clock + x.ms);
      for (const x of speaking.slice().reverse()) {
        let c = byPid(x.from);
        if (!c) {
          const others = talks.filter((y) => y.from !== x.from && y.clock <= x.clock && y.clock + y.ms >= x.clock - TALK_PAIR_MS)
            .reverse();
          for (const y of others) {
            c = byPid(y.from);
            if (c) break;
          }
          if (!c) {
            const after = talks.filter((y) => y.from !== x.from && y.clock > x.clock && y.clock <= x.clock + x.ms + TALK_PAIR_MS);
            for (const y of after) {
              c = byPid(y.from);
              if (c) break;
            }
          }
        }
        if (c) { want = { clip: c, why: 'talk' }; break; }
      }
    }
    if (!want) {
      const scene = scenes.filter((m) => t >= m.clock - PRE && t < m.clock + POST).pop();
      if (scene) {
        const people = scene.ids.map((pid) => byPid(pid)).filter(Boolean);
        if (people.length) {
          const turn = Math.floor((t - (scene.clock - PRE)) / SHOT_MS) % people.length;
          // Holding the current person when they're one of them, until the shot's time is up.
          let c = people[turn];
          if (cur && people.some((p) => p.id === cur.id) && t - cur.since < SHOT_MS) c = people.find((p) => p.id === cur.id);
          want = { clip: c, why: sceneWhy14(scene.kind) }; // v1.3 PAGE-AFTER: sceneWhy (v1.4: sceneWhy14)
        }
      }
    }
    // v1.4.7: someone talking near their phone (the one already showing while they still talk)
    if (!want) {
      const talking = all.map((c) => ({ c, v: speaksAt(c, t) })).filter((x) => x.v !== null)
        .sort((a, b) => (b.v - a.v) || (a.c.id < b.c.id ? -1 : 1));
      if (talking.length) {
        const mine = cur ? talking.find((x) => x.c.id === cur.id) : null;
        want = { clip: (mine || talking[0]).c, why: 'voice' };
      }
    }
    let scores = null;
    if (!want) {
      scores = pool.map((c) => ({ c, s: (perSecond(c, 'loud', t) || 0) + Math.min(50, speedAt(routes, c.pid, t) * 10) }))
        .sort((a, b) => (b.s - a.s) || (a.c.id < b.c.id ? -1 : 1));
      want = { clip: scores[0].c, why: pool.length === 1 ? 'only' : 'loud', score: scores[0].s };
    }

    // Hold the shot unless it ended, went dark, or a higher rule starts.
    let next = want;
    if (cur) {
      const stillThere = pool.some((c) => c.id === cur.id) || ((cur.why === 'follow' || cur.why === 'voice') && all.some((c) => c.id === cur.id)); // v1.4.7: voice
      const held = t - cur.since;
      const higher = RANK[want.why] > RANK[cur.why];
      if (stillThere && !higher && want.clip.id !== cur.id) {
        if (held < SHOT_MS) {
          next = { clip: list.find((c) => c.id === cur.id), why: cur.why };
        } else if ((want.why === 'loud' || want.why === 'only') && (cur.why === 'loud' || cur.why === 'only')) {
          const mine = scores.find((x) => x.c.id === cur.id);
          if (mine && want.score < mine.s + SWITCH_BY) next = { clip: mine.c, why: cur.why };
        }
      }
    }

    const c = next.clip;
    const stop = Math.min(hi, t + STEP_MS, c.end);
    if (!cur || cur.id !== c.id) cur = { id: c.id, pid: c.pid, why: next.why, since: t };
    else cur.why = next.why;
    const last = out[out.length - 1];
    if (last && last.id === c.id && last.why === next.why && last.to === t) last.to = stop;
    else out.push({ from: t, to: stop, id: c.id, pid: c.pid, why: next.why });
    if (stop < t + STEP_MS) cur = null; // the clip ended inside this second
  }
  return out;
}

// The parts of the game the movie plays (game clock): where there's footage, merged when close (under 4 s
// apart), at most `most` ms in all (the busiest windows first: talk and scenes, then the rest, in clock order).
export function movieWindows({ cuts, moments, talk, most = 480000 } = {}) {
  const list = (Array.isArray(cuts) ? cuts : []).filter((c) => c && num(c.from) !== null && c.to > c.from)
    .slice().sort((a, b) => a.from - b.from);
  const merged = [];
  for (const c of list) {
    const last = merged[merged.length - 1];
    if (last && c.from - last.to < 4000) {
      last.to = Math.max(last.to, c.to);
      last.weight += (weighty(c.why) ? 3 : 1) * (c.to - c.from); // v1.3 PAGE-AFTER: weighty
    } else {
      merged.push({ from: c.from, to: c.to, weight: (weighty(c.why) ? 3 : 1) * (c.to - c.from) }); // v1.3 PAGE-AFTER: weighty
    }
  }
  const total = merged.reduce((s, w) => s + (w.to - w.from), 0);
  if (total <= most) return merged.map(({ from, to }) => ({ from, to }));
  // Too long (v1.4): never "the first minutes of a window". Long footage is cut into short scenes (one round
  // each moment and each walkie message, then even slices of the rest), and the budget is spread over the
  // beginning, middle and end of the game, the best scenes of each part first, then shown in game order.
  return pickScenes(merged, [...scenesOf(moments).map((m) => ({ at: m.clock, ms: 0, s: 30 })),
    ...talkOf(talk).map((x) => ({ at: x.clock, ms: x.ms, s: 20 }))], most);
}

export const SCENE_BEFORE = 6000;   // a moment's scene starts this long before it
export const SCENE_AFTER = 10000;   // ... and runs this long after it (a walkie message: after its end)
export const SLICE_MS = 20000;      // filler scenes of plain footage
export const SCENE_MOST = 25000;    // a scene is at most this long (a long walkie message keeps going whole)

function pickScenes(windows, marks, most) {
  const inside = (t) => windows.find((w) => t >= w.from && t < w.to);
  const cands = [];
  for (const m of marks) {
    const w = inside(m.at);
    if (!w) continue;
    const from = Math.max(w.from, m.at - SCENE_BEFORE);
    const to = Math.min(w.to, Math.max(m.at + m.ms + SCENE_AFTER, Math.min(from + SCENE_MOST, m.at + m.ms + 1000)));
    cands.push({ from, to, s: m.s });
  }
  for (const w of windows) {
    for (let t = w.from; t < w.to; t += SLICE_MS * 3) {
      cands.push({ from: t, to: Math.min(w.to, t + SLICE_MS), s: 1 });
    }
  }
  if (!cands.length) return [];
  const lo = Math.min(...windows.map((w) => w.from));
  const hi = Math.max(...windows.map((w) => w.to));
  const third = Math.max(1, (hi - lo) / 3);
  const part = (c) => Math.min(2, Math.floor(((c.from + c.to) / 2 - lo) / third));
  const queues = [[], [], []];
  for (const c of cands) queues[part(c)].push(c);
  for (const q of queues) q.sort((a, b) => (b.s - a.s) || (a.from - b.from));
  const keep = [];
  const used = () => keep.reduce((n, k) => n + (k.to - k.from), 0);
  const overlaps = (c) => keep.some((k) => c.from < k.to && c.to > k.from);
  let going = true;
  while (going) {
    going = false;
    for (const q of queues) {
      while (q.length) {
        const c = q.shift();
        if (overlaps(c)) continue;
        if (used() + (c.to - c.from) > most) continue; // a scene is whole or not at all
        keep.push({ from: c.from, to: c.to });
        going = true;
        break;
      }
    }
  }
  keep.sort((a, b) => a.from - b.from);
  const out = [];
  for (const k of keep) {
    const last = out[out.length - 1];
    if (last && k.from <= last.to) last.to = Math.max(last.to, k.to);
    else out.push({ ...k });
  }
  return out;
}
