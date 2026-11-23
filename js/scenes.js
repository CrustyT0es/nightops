// Night Ops v1.4 (PAGE-REEL): the highlight reel as scenes. Pure (no DOM, no clocks): from the summary, the camera
// clips and the walkie-talkie, one scene list that both the page's player and the file renderer play, so what you
// watch is what you download.
//
//   scenes({ summary, clips, talk, speech, kind: 'highlights' | 'whole', most, ring }) -> reel
//   miniMap(call, { w, h }) -> { box, a, b, gap } | null       a close call's two tracks in pixels
//   gainOf(track, t) -> 0..1                                     a track's gain at reel time t
//   sceneAt(reel, t) -> index | -1;  clockAt(scene, t) -> game clock
//
// Rules (CONTRACT.md v1.4 D and H): a walkie message is always played whole; a scene ends at a pause; highlights
// come from the whole game (the beginning, middle and end), never "the first minutes of a long window"; "The whole
// game" covers every clock from 0 to endClock exactly once, in order.
import { TIMING } from '../shared/rules.js?v=170';
import { distanceM, toLocal } from '../shared/geo.js?v=170';
import { direct, fileTimeAt } from './director.js?v=170';
import { planTour } from './tour.js?v=170';

export const REEL = Object.freeze({ W: 720, H: 1280, FPS: 30 });
export const HIGHLIGHTS_MOST_MS = 480000;
export const HIGHLIGHTS_LEAST_MS = 240000;
export const INTRO_MS = 6000;
export const OUTRO_MS = 10000;
export const GAP_MS = 1500;
export const GAP_LONG_MS = 2500;
export const GAP_AFTER_MS = 60000;        // two scenes further apart than this get a "12 min later" between
export const SCENE_LEAST_MS = 4000;
export const SCENE_MOST_MS = 25000;
export const TALK_JOIN_MS = 6000;
export const JCUT_MS = 300;
export const XFADE_MS = 400;
export const PAUSE_LEVEL = 8;
export const PAUSE_MS = 400;
export const EXTEND_MOST_MS = 6000;
export const DUCK = 0.25;
export const DUCK_RAMP_MS = 100;
export const TONE_GAIN = 0.03;            // the room tone under everything (-30 dB): the reel is never dead silent
export const PAD_GAIN = 0.35;
export const CATCH_JOIN_MS = 60000;
export const FILL_EVERY_MS = 180000;      // highlights: one "on the move" candidate per this much plain footage
export const FILL_MS = 12000;
export const TITLE_MS = 3000;
export const CAPTION_MS = 4000;
const Q = 250;                            // loudQ's step
// v1.4.7: what someone said near their phone, and near approaches (a hunter within CAM_NEAR_M of a hider)
export const VOICE_LEVEL = 45;            // camera.js TALK_LEVEL (director.js VOICE_LEVEL)
export const VOICE_NEED_MS = 1500;
export const DARK_LEVEL = 12;             // director.js DARK
export const NEAR_JOIN_MS = 30000;        // a camera 'near' moment this close to a close call is that close call
export const NEAR_RUN_MS = 90000;         // the same pair's 'near' moments this close (one a minute) are one approach
export const SIDE_GAIN = 0.8;             // both phones' sound at once in a split: a little lower each

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const CLOSE_M = TIMING.CLOSE_CALL_M || 15;

const SCORE = { voice: 50, caught: 100, tag: 90, denied: 85, tap: 70, hack: 65, checkpoint: 60, overstay: 50, power: 40, outside: 30, stretch: 10 };
const TITLES = {
  caught: 'CAUGHT', tag: 'TAGGED', denied: 'NOT CAUGHT', near: 'CLOSE CALL', talk: 'ON THE RADIO', tap: 'WIRETAP',
  voice: 'OUT LOUD', hack: 'HACKED', power: 'POWER', checkpoint: 'CHECKPOINT', overstay: 'TIME UP', outside: 'OUT OF THE RING', stretch: 'ON THE MOVE',
};

// ---- small helpers ----

function namesOf(summary) {
  const m = new Map();
  for (const p of (summary && Array.isArray(summary.players) ? summary.players : [])) if (p && p.id) m.set(p.id, p);
  return m;
}

export function joinNames(list) {
  const n = list.filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

function cleanClips(clips) {
  return (Array.isArray(clips) ? clips : [])
    .filter((c) => c && typeof c.id === 'string' && typeof c.pid === 'string' && num(c.start) !== null && num(c.end) !== null && c.end > c.start)
    .slice().sort((a, b) => (a.start - b.start) || (a.id < b.id ? -1 : 1));
}

function cleanTalk(talk) {
  return (Array.isArray(talk) ? talk : [])
    .filter((x) => x && typeof x.from === 'string' && num(x.clock) !== null)
    .map((x) => ({ n: x.n === undefined ? null : x.n, from: x.from, clock: x.clock, ms: num(x.ms) !== null ? Math.max(300, x.ms) : 3000,
      side: x.side || null, tap: x.tap || null, of: x.of || null }))
    .sort((a, b) => (a.clock - b.clock) || ((a.n || 0) - (b.n || 0)));
}

const covering = (clips, pid, t) => clips.filter((c) => c.pid === pid && t >= c.start && t < c.end);
const anyCover = (clips, t) => clips.some((c) => t >= c.start && t < c.end);

// The loudness (0..100) of a clip at a game clock from loudQ (per 250 ms), else loud (per second), else null.
export function loudAt(clip, clock) {
  const s = fileTimeAt(clip, clock);
  if (s === null) return null;
  if (Array.isArray(clip.loudQ) && clip.loudQ.length) {
    const i = Math.max(0, Math.min(clip.loudQ.length - 1, Math.floor((s * 1000) / Q)));
    return num(clip.loudQ[i]);
  }
  if (Array.isArray(clip.loud) && clip.loud.length) {
    const i = Math.max(0, Math.min(clip.loud.length - 1, Math.floor(s)));
    return num(clip.loud[i]);
  }
  return null;
}

// Is a walkie message speaking at a clock? (speech: per message n, loudness per 250 ms; without it: start to end)
function msgSpeaking(m, clock, speech) {
  if (clock < m.clock || clock >= m.clock + m.ms) return false;
  const q = speech && m.n !== null ? (speech instanceof Map ? speech.get(m.n) : speech[m.n]) : null;
  if (!Array.isArray(q) || !q.length) return true;
  const v = num(q[Math.max(0, Math.min(q.length - 1, Math.floor((clock - m.clock) / Q)))]);
  return v === null || v >= PAUSE_LEVEL;
}

// ---- 1. candidates ----

function candidates(summary, clips, talk) {
  const names = namesOf(summary);
  const name = (id) => (names.get(id) ? names.get(id).name : 'Someone');
  const out = [];
  const moments = summary && summary.cam && Array.isArray(summary.cam.moments) ? summary.cam.moments : [];

  // Catches: one scene per catch (the tag, the answer and the catch merge within CATCH_JOIN_MS).
  const catches = [];
  for (const p of names.values()) {
    if (num(p.caughtAt) === null) continue;
    catches.push({ kind: 'caught', clock: p.caughtAt, people: [p.caughtBy, p.id].filter(Boolean),
      line: p.caughtBy ? `${name(p.caughtBy)} caught ${p.name}` : `${p.name} was caught` });
  }
  for (const m of moments) {
    if (!m || num(m.clock) === null || !Array.isArray(m.ids)) continue;
    if (m.kind === 'tag' || m.kind === 'denied' || m.kind === 'caught') {
      const near = catches.find((c) => Math.abs(c.clock - m.clock) <= CATCH_JOIN_MS && m.ids.some((id) => c.people.includes(id)));
      if (near) { near.from = Math.min(near.from === undefined ? near.clock : near.from, m.clock); continue; }
      catches.push({ kind: m.kind === 'caught' ? 'caught' : m.kind, clock: m.clock, people: m.ids.slice(),
        line: m.kind === 'denied' ? `${joinNames(m.ids.map(name))}: not caught` : `${joinNames(m.ids.map(name))}` });
    }
  }
  for (const c of catches) {
    const lo = Math.min(c.clock, c.from === undefined ? c.clock : c.from);
    out.push({ kind: c.kind, clock: c.clock, from: lo - 6000, to: c.clock + 9000, people: c.people, line: c.line, s: SCORE[c.kind] || 90 });
  }

  // Close calls with a gap (the closest moment from the full trails).
  for (const call of (summary && Array.isArray(summary.closeCalls) ? summary.closeCalls : [])) {
    if (!call || (call.kind !== 'near' && call.kind !== 'cpnear')) continue;
    const g = call.gap;
    const clock = g && num(g.clock) !== null ? g.clock : num(call.clock);
    if (clock === null) continue;
    const m = g && num(g.m) !== null ? g.m : num(call.m) !== null ? call.m : CLOSE_M;
    const ids = Array.isArray(call.ids) ? call.ids.slice(0, 2) : [];
    out.push({ kind: 'near', clock, from: clock - 10000, to: clock + 6000, people: ids, m: Math.round(m),
      line: `${joinNames(ids.map(name))}: ${Math.round(m)} m`, s: 80 + Math.max(0, CLOSE_M - m) * 2,
      mini: call.track ? { a: ids[0], b: ids[1], track: call.track, gap: g || null } : null });
  }

  // Hacks and taps.
  for (const h of (summary && Array.isArray(summary.hacks) ? summary.hacks : [])) {
    if (!h || num(h.clock) === null) continue;
    out.push({ kind: 'hack', clock: h.clock, from: h.clock - 4000, to: h.clock + 8000, people: [h.target, h.by].filter(Boolean),
      title: h.blocked ? 'HACK BLOCKED' : 'HACKED',
      line: h.blocked ? `${name(h.target)}'s Jammer blocked it` : `The alarm went off on ${name(h.target)}'s phone`, s: SCORE.hack });
  }
  for (const tp of (summary && Array.isArray(summary.taps) ? summary.taps : [])) {
    if (!tp || num(tp.clock) === null) continue;
    out.push({ kind: 'tap', clock: tp.clock, from: tp.clock - 3000, to: tp.clock + (TIMING.TAP_MS || 15000) + 8000,
      people: [tp.target, tp.by].filter(Boolean), tap: tp.id, line: `${name(tp.by)} listened in on ${name(tp.target)}`, s: SCORE.tap });
  }

  // Other camera moments: powers, checkpoints, outside (never SOS).
  for (const m of moments) {
    if (!m || num(m.clock) === null || !Array.isArray(m.ids)) continue;
    if (!['power', 'checkpoint', 'overstay', 'outside'].includes(m.kind)) continue;
    // A hack or a tap is already its own scene.
    if (m.kind === 'power' && out.some((c) => (c.kind === 'hack' || c.kind === 'tap') && Math.abs(c.clock - m.clock) < 3000)) continue;
    out.push({ kind: m.kind, clock: m.clock, from: m.clock - 5000, to: m.clock + (num(m.ms) !== null ? Math.min(m.ms, 15000) : 8000),
      people: m.ids.slice(0, 3), line: joinNames(m.ids.slice(0, 3).map(name)), s: SCORE[m.kind] });
  }

  // Walkie conversations (and the pieces of one tap): messages closer than TALK_JOIN_MS end to start.
  const convs = [];
  for (const m of talk) {
    const key = m.side === 'wiretap' ? `tap:${m.tap}` : `side:${m.side}`;
    const last = convs.filter((c) => c.key === key).pop();
    if (last && m.clock - last.end <= TALK_JOIN_MS) { last.msgs.push(m); last.end = Math.max(last.end, m.clock + m.ms); }
    else convs.push({ key, msgs: [m], end: m.clock + m.ms });
  }
  for (const c of convs) {
    const first = c.msgs[0];
    const who = [...new Set(c.msgs.map((m) => m.from))];
    if (first.side === 'wiretap') {
      const tap = out.find((x) => x.kind === 'tap' && x.tap === first.tap);
      if (tap) { tap.to = Math.max(tap.to, c.end + 1500); continue; }
      out.push({ kind: 'tap', clock: first.clock, from: first.clock - 2000, to: c.end + 1500, people: [first.of || first.from],
        line: `Listening in on ${name(first.of || first.from)}`, s: SCORE.tap });
      continue;
    }
    out.push({ kind: 'talk', clock: first.clock, from: first.clock - 2000, to: c.end + 1500, people: who,
      line: joinNames(who.map(name)), s: Math.min(70, 40 + 5 * c.msgs.length) });
  }

  // v1.4.7: near approaches the camera saw (a hunter within CAM_NEAR_M of a hider; the summary names the filmed
  // ones of the two, hider first) that aren't a close call already. One a minute while they stay close: one approach.
  const nearM = TIMING.CAM_NEAR_M || 50;
  const approaches = [];
  for (const m of moments.filter((x) => x && x.kind === 'near' && num(x.clock) !== null).slice().sort((a, b) => a.clock - b.clock)) {
    const ids = Array.isArray(m.ids) ? [...new Set(m.ids.filter((id) => typeof id === 'string'))].slice(0, 2) : [];
    if (!ids.length) continue;
    const key = ids.slice().sort().join(':');
    const run = approaches.find((a) => a.key === key && m.clock - a.last <= NEAR_RUN_MS);
    if (run) { run.last = m.clock; continue; }
    approaches.push({ key, ids, first: m.clock, last: m.clock });
  }
  for (const a of approaches) {
    if (out.some((c) => c.kind === 'near' && c.clock >= a.first - NEAR_JOIN_MS && c.clock <= a.last + NEAR_JOIN_MS && a.ids.some((id) => c.people.includes(id)))) continue;
    let line;
    if (a.ids.length >= 2) line = `${joinNames(a.ids.map(name))}: within ${nearM} m`;
    else {
      const p = names.get(a.ids[0]);
      const other = p && p.startTeam === 'hider' ? 'a hunter' : 'a hider';
      line = `${name(a.ids[0])} was within ${nearM} m of ${other}`;
    }
    out.push({ kind: 'near', clock: a.first, from: a.first - 10000, to: a.last + 8000, people: a.ids, m: null, line, s: 72, mini: null });
  }

  // v1.4.7: what people said out loud (a clip the phone kept for talking): its loudest stretch of speech
  for (const v of voices(clips)) {
    out.push({ kind: 'voice', clock: v.clock, from: v.from - 3000, to: v.to + 3000, people: [v.pid], voiceClip: v.id,
      line: name(v.pid), s: SCORE.voice + Math.min(15, v.ms / 1000) });
  }

  // Filmed people score more.
  for (const c of out) {
    const filmed = c.people.filter((pid) => covering(clips, pid, c.clock).length).length;
    if (filmed) c.s += 20 + 10 * (filmed - 1);
    c.title = c.title || TITLES[c.kind];
  }
  return out;
}

// v1.4.7: each clip kept for talking ('talk' in its kinds) -> its longest run of speech (loudQ over VOICE_LEVEL,
// pauses under a second bridged), as game clocks. Only runs of VOICE_NEED_MS or more.
export function voices(clips) {
  const out = [];
  for (const c of clips) {
    if (!c || !Array.isArray(c.kinds) || !c.kinds.includes('talk')) continue;
    // per 250 ms (loudQ), else each second's loudest taken for its four quarters (clips sent before v1.4.7's server)
    const q = Array.isArray(c.loudQ) && c.loudQ.length ? c.loudQ
      : Array.isArray(c.loud) ? c.loud.flatMap((v) => [v, v, v, v]) : [];
    if (!q.length) continue;
    let best = null, run = null, gap = 0;
    q.forEach((v, i) => {
      if (num(v) !== null && v >= VOICE_LEVEL) {
        if (!run) run = { a: i, b: i };
        run.b = i;
        gap = 0;
      } else if (run) {
        gap += 1;
        if (gap * Q >= 1000) { if (!best || run.b - run.a > best.b - best.a) best = run; run = null; gap = 0; }
      }
    });
    if (run && (!best || run.b - run.a > best.b - best.a)) best = run;
    if (!best) continue;
    const ms = (best.b - best.a + 1) * Q;
    if (ms < VOICE_NEED_MS) continue;
    const from = clockOfFile(c, best.a * Q), to = clockOfFile(c, (best.b + 1) * Q);
    out.push({ id: c.id, pid: c.pid, from, to, ms, clock: Math.round((from + to) / 2) });
  }
  return out;
}

// The game clock at a file time (ms): clocks per second when there, else start + t.
function clockOfFile(c, ms) {
  const list = Array.isArray(c.clocks) ? c.clocks : [];
  const i = Math.floor(ms / 1000);
  if (i < list.length && num(list[i]) !== null) return Math.round(list[i] + (ms - i * 1000));
  return Math.round(c.start + ms);
}

// v1.4.7: a shot is "dark" when most of its seconds are under DARK_LEVEL: the movie then shows the player's face
// with a sound-wave (and still plays the clip's audio)
function darkShot(clip, from, to) {
  if (!clip || !Array.isArray(clip.bright) || !clip.bright.length) return false;
  let n = 0, dark = 0;
  for (let t = from; t < to; t += 1000) {
    const s = fileTimeAt(clip, t);
    if (s === null) continue;
    const b = num(clip.bright[Math.max(0, Math.min(clip.bright.length - 1, Math.floor(s)))]);
    if (b === null) continue;
    n += 1;
    if (b < DARK_LEVEL) dark += 1;
  }
  return n > 0 && dark * 2 > n;
}

// Highlights only: plain footage, one "on the move" candidate per FILL_EVERY_MS at its loudest moment.
function fillers(clips, taken) {
  const out = [];
  if (!clips.length) return out;
  const lo = Math.min(...clips.map((c) => c.start));
  const hi = Math.max(...clips.map((c) => c.end));
  for (let t = lo; t + FILL_MS <= hi; t += FILL_EVERY_MS) {
    let best = null;
    for (let u = t; u < Math.min(hi, t + FILL_EVERY_MS); u += 5000) {
      const here = clips.filter((c) => u >= c.start && u + FILL_MS <= c.end);
      for (const c of here) {
        const v = loudAt(c, u) || 0;
        if (!best || v > best.v) best = { v, u, pid: c.pid };
      }
    }
    if (!best) continue;
    if (taken.some((x) => best.u < x.to && best.u + FILL_MS > x.from)) continue;
    out.push({ kind: 'stretch', clock: best.u + FILL_MS / 2, from: best.u, to: best.u + FILL_MS, people: [best.pid],
      title: TITLES.stretch, line: null, s: SCORE.stretch + best.v / 10 });
  }
  return out;
}

// ---- 3. edges: never cut speech; end at a pause ----

function loudPeople(c, clips, t) {
  for (const pid of c.people) {
    for (const clip of covering(clips, pid, t)) {
      const v = loudAt(clip, t);
      if (v !== null && v >= PAUSE_LEVEL) return true;
    }
  }
  return false;
}

function quietFrom(c, clips, talk, speech, t, dir) {
  // the first point (moving `dir`) where PAUSE_MS in a row are quiet; at most EXTEND_MOST_MS away
  let run = 0;
  for (let d = 0; d <= EXTEND_MOST_MS; d += Q) {
    const u = t + dir * d;
    const loud = loudPeople(c, clips, u) || talk.some((m) => msgSpeaking(m, u, speech));
    run = loud ? 0 : run + Q;
    if (run >= PAUSE_MS) return dir > 0 ? u - PAUSE_MS + Q : u + PAUSE_MS - Q;
  }
  return t + dir * EXTEND_MOST_MS;
}

function wholeMessages(c, talk) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of talk) {
      const end = m.clock + m.ms;
      if (m.clock < c.to && end > c.from) {
        if (m.clock < c.from) { c.from = m.clock - 200; changed = true; }
        if (end > c.to) { c.to = end + 300; changed = true; }
      }
    }
  }
}

function edges(c, clips, talk, speech, endClock) {
  c.from = Math.max(0, c.from);
  c.to = Math.min(endClock, Math.max(c.to, c.from + SCENE_LEAST_MS));
  wholeMessages(c, talk);
  if (c.kind !== 'stretch') {
    c.to = Math.min(endClock, quietFrom(c, clips, talk, speech, c.to, +1));
    c.from = Math.max(0, quietFrom(c, clips, talk, speech, c.from, -1));
  }
  if (c.to - c.from > SCENE_MOST_MS) {
    const keepFrom = Math.max(c.from, Math.min(c.clock - 8000, c.to - SCENE_MOST_MS));
    c.from = keepFrom;
    c.to = Math.min(c.to, keepFrom + SCENE_MOST_MS);
  }
  wholeMessages(c, talk); // a message is never cut, even past SCENE_MOST_MS
  c.from = Math.max(0, Math.round(c.from));
  c.to = Math.min(endClock, Math.round(c.to));
  if (c.to - c.from < SCENE_LEAST_MS) {
    c.to = Math.min(endClock, c.from + SCENE_LEAST_MS);
    c.from = Math.max(0, Math.min(c.from, c.to - SCENE_LEAST_MS));
  }
  return c;
}

function merge(list) {
  const sorted = list.slice().sort((a, b) => a.from - b.from);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.from < last.to) {
      // never chain a busy stretch into one long scene: past SCENE_MOST_MS the next starts where this one ends
      // (wholeMessages already took every message under `last` whole, so its end is never inside one)
      const most = Math.max(SCENE_MOST_MS, last.to - last.from, c.to - c.from);
      if (Math.max(last.to, c.to) - Math.min(last.from, c.from) > most) {
        if (c.to - last.to >= SCENE_LEAST_MS) { out.push({ ...c, from: last.to }); continue; }
        if (c.to <= last.to) { last.s = Math.max(last.s, c.s); continue; }
      }
      const top = c.s > last.s ? c : last;
      last.from = Math.min(last.from, c.from);
      last.to = Math.max(last.to, c.to);
      last.people = [...new Set([...(top === c ? c.people : last.people), ...(top === c ? last.people : c.people)])];
      if (top === c) Object.assign(last, { kind: c.kind, title: c.title, line: c.line, clock: c.clock, mini: c.mini || last.mini, m: c.m, voiceClip: c.voiceClip }); // v1.4.7: voiceClip
      else if (!last.mini && c.mini) last.mini = c.mini;
      last.s = Math.max(last.s, c.s) + 5;
      last.parts = (last.parts || 1) + 1;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

// ---- 4. choosing highlights ----

function choose(cands, budget, lo, hi) {
  const third = Math.max(1, (hi - lo) / 3);
  const part = (c) => Math.max(0, Math.min(2, Math.floor(((c.from + c.to) / 2 - lo) / third)));
  const cost = (c) => (c.to - c.from) + GAP_LONG_MS;
  const chosen = new Set();
  const used = [0, 0, 0];
  let total = 0;
  const take = (c, check45) => {
    if (chosen.has(c)) return false;
    if (total + cost(c) > budget) return false;
    if (check45) {
      const p = part(c);
      const left = budget;
      const others = cands.some((x) => !chosen.has(x) && part(x) !== p && total + cost(x) <= budget);
      if (others && used[p] + cost(c) > Math.max(left, budget) * 0.45) return false;
    }
    chosen.add(c);
    used[part(c)] += cost(c);
    total += cost(c);
    return true;
  };
  const best = (list) => list.slice().sort((a, b) => (b.s - a.s) || (a.from - b.from));
  for (let p = 0; p < 3; p += 1) { for (const c of best(cands.filter((x) => part(x) === p))) if (take(c, false)) break; }
  for (const c of best(cands.filter((x) => x.kind === 'caught' || x.kind === 'tag'))) take(c, false);
  for (const c of best(cands)) take(c, true);
  for (const c of best(cands)) take(c, false); // what's left when only one third has scenes
  return cands.filter((c) => chosen.has(c)).sort((a, b) => a.from - b.from);
}

// ---- 6. layouts and shots ----

function filmedFor(clips, pid, from, to) {
  // the share of [from, to) that pid has footage for
  let n = 0, all = 0;
  for (let t = from; t < to; t += 1000) { all += 1; if (covering(clips, pid, t).length) n += 1; }
  return all ? n / all : 0;
}

function boxOf(summary, people, from, to) {
  const routes = summary && summary.routes ? summary.routes : {};
  const pts = [];
  const ids = people && people.length ? people : Object.keys(routes);
  for (const id of ids) {
    for (const p of routes[id] || []) {
      if (!Array.isArray(p)) continue;
      if (from !== null && (p[2] * 1000 < from - 30000 || p[2] * 1000 > to + 30000)) continue;
      pts.push(p);
    }
  }
  if (!pts.length && people && people.length) return boxOf(summary, null, from, to);
  if (!pts.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); }
  const padX = Math.max(0.0004, (e - w) * 0.15), padY = Math.max(0.0003, (n - s) * 0.15);
  return [[w - padX, s - padY], [e + padX, n + padY]];
}

// v1.4.7: [left, right] of a two-person scene: the hider left, the hunter right (as v1.4's split)
function sidesOf(people, summary) {
  const [x, y] = people;
  if (!y) return [x || null, null];
  const sides = namesOf(summary);
  const hider = sides.get(x) && sides.get(x).startTeam === 'hunter' ? y : x;
  return [hider, hider === x ? y : x];
}

function shotsFor(sc, clips, talk, summary) {
  const shots = [];
  if (sc.start === null || !clips.length) return shots;
  if (sc.layout === 'split' || (sc.layout === 'minimap' && sc.people.length >= 2)) {
    // every clip of either player that overlaps the scene (v1.4.7: any of it)
    const [hider, hunter] = sidesOf(sc.people, summary);
    for (const [pid, slot] of [[hider, 'left'], [hunter, 'right']]) {
      for (const c of clips.filter((k) => k.pid === pid && k.start < sc.end && k.end > sc.start)) {
        shots.push({ from: Math.max(sc.start, c.start), to: Math.min(sc.end, c.end), id: c.id, pid, slot, why: 'near' });
      }
    }
    return shots;
  }
  const cuts = direct({ clips, talk, moments: summary && summary.cam ? summary.cam.moments : [], routes: summary ? summary.routes : null,
    from: sc.start, to: sc.end, follow: sc.layout === 'single' ? sc.people[0] : null });
  for (const c of cuts) shots.push({ ...c, slot: 'main' });
  if (sc.layout === 'mapcam') {
    // up to 3 others small, the ones filmed at the same time
    const main = new Set(cuts.map((c) => c.id));
    const others = clips.filter((k) => !main.has(k.id) && k.start < sc.end && k.end > sc.start);
    const byPid = [];
    for (const k of others) if (!byPid.some((x) => x.pid === k.pid)) byPid.push(k);
    for (const k of others.filter((o) => byPid.slice(0, 3).some((b) => b.pid === o.pid))) {
      shots.push({ from: Math.max(sc.start, k.start), to: Math.min(sc.end, k.end), id: k.id, pid: k.pid, slot: 'small', why: 'also' });
    }
  }
  return shots;
}

function layoutFor(c, clips) {
  if (c.kind === 'near') {
    if (c.mini) return 'minimap';
    // v1.4.7: both players side by side whenever both have footage of the approach (any of it)
    if (c.people.length >= 2 && c.people.slice(0, 2).every((pid) => filmedFor(clips, pid, c.from, c.to) > 0)) return 'split';
  }
  let any = false;
  for (let t = c.from; t < c.to; t += 1000) if (anyCover(clips, t)) { any = true; break; }
  return any ? 'mapcam' : 'map';
}

function captionsFor(summary, from, to) {
  return (summary && Array.isArray(summary.events) ? summary.events : [])
    .filter((e) => e && num(e.clock) !== null && typeof e.text === 'string' && e.clock >= from && e.clock < to)
    .map((e) => ({ from: e.clock, to: e.clock + CAPTION_MS, text: e.text.slice(0, 120) }));
}

function makeScene(c, clips, talk, summary, kind) {
  const sc = {
    kind: c.kind, at: 0, ms: 0, start: c.from, end: c.to, rate: 1, people: c.people.filter(Boolean),
    title: c.title || '', line: c.line || null, layout: 'map', shots: [], map: null, mini: null, captions: [], clock: c.clock,
  };
  sc.layout = layoutFor({ ...c, people: sc.people }, clips);
  if (c.kind === 'near' && c.mini) sc.mini = { a: c.mini.a, b: c.mini.b, track: c.mini.track, gap: c.mini.gap };
  sc.shots = shotsFor(sc, clips, talk, summary);
  // v1.4.7: both players of a close call or a near approach, hider left and hunter right, even one with no footage
  // (the movie shows their face there)
  if (sc.layout === 'split' || sc.layout === 'minimap') sc.sides = sidesOf(sc.people, summary);
  // v1.4.7: a scene of what someone said shows that clip (dark or not) for as long as it covers the scene
  if (c.voiceClip && sc.kind === 'voice') {
    const vc = clips.find((k) => k.id === c.voiceClip);
    if (vc) {
      const a = Math.max(sc.start, vc.start), b = Math.min(sc.end, vc.end);
      const kept = [];
      for (const x of sc.shots) {
        // other main shots keep only what's outside [a, b)
        if (x.slot !== 'main' || x.to <= a || x.from >= b) { kept.push(x); continue; }
        if (x.from < a) kept.push({ ...x, to: a });
        if (x.to > b) kept.push({ ...x, from: b });
      }
      if (b > a) kept.push({ from: a, to: b, id: vc.id, pid: vc.pid, slot: 'main', why: 'voice' });
      sc.shots = kept.sort((x, y) => (x.from - y.from) || (x.slot < y.slot ? -1 : 1));
    }
  }
  for (const x of sc.shots) {
    const k = clips.find((y) => y.id === x.id);
    if (darkShot(k, x.from, x.to)) x.dark = true;
  }
  if (!sc.shots.length && (sc.layout === 'mapcam' || sc.layout === 'split')) sc.layout = 'map';
  sc.map = { box: boxOf(summary, kind === 'whole' && c.kind === 'stretch' ? null : sc.people, c.from, c.to),
    follow: sc.people[0] || null, routes: kind === 'whole' ? 'so-far' : 'window', ring: true };
  sc.captions = captionsFor(summary, c.from, c.to);
  return sc;
}

function introScene(summary) {
  const ps = summary && Array.isArray(summary.players) ? summary.players : [];
  return { kind: 'intro', at: 0, ms: INTRO_MS, start: null, end: null, rate: 1, people: ps.map((p) => p.id),
    title: 'NIGHT OPS', line: modeWords(summary && summary.mode), layout: 'card', shots: [],
    map: { box: boxOf(summary, null, null, null), follow: null, routes: 'none', ring: true }, mini: null, captions: [],
    date: summary && num(summary.startAt) !== null ? summary.startAt : null };
}

function outroScene(summary) {
  const names = namesOf(summary);
  const name = (id) => (names.get(id) ? names.get(id).name : 'Someone');
  const winners = summary && Array.isArray(summary.winners) ? summary.winners : [];
  const ps = [...names.values()];
  const stats = {
    catches: ps.reduce((n, p) => n + (p.catches || 0), 0),
    closeCalls: (summary && Array.isArray(summary.closeCalls) ? summary.closeCalls : []).length,
    distanceM: ps.reduce((n, p) => n + (p.distanceM || 0), 0),
  };
  return { kind: 'outro', at: 0, ms: OUTRO_MS, start: null, end: null, rate: 1, people: winners.slice(),
    title: winners.length ? `${joinNames(winners.map(name))} ${winners.length === 1 ? 'wins' : 'win'}`.toUpperCase() : 'GAME OVER',
    line: summary && summary.mvp ? `MVP: ${name(summary.mvp)}` : null, layout: 'card', shots: [],
    map: { box: boxOf(summary, null, null, null), follow: null, routes: 'all', ring: true }, mini: null, captions: [], stats };
}

function modeWords(mode) {
  if (mode === 'checkpoints') return 'Checkpoints';
  if (mode === 'classic' || !mode) return 'Classic manhunt';
  return String(mode).slice(0, 1).toUpperCase() + String(mode).slice(1);
}

export function laterWords(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'A LITTLE LATER';
  return `${min} MIN LATER`;
}

function gapScene(from, to, summary) {
  const ms = to - from > 600000 ? GAP_LONG_MS : GAP_MS;
  return { kind: 'gap', at: 0, ms, start: from, end: to, rate: (to - from) / ms, people: [], title: laterWords(to - from), line: null,
    layout: 'map', shots: [], map: { box: boxOf(summary, null, null, null), follow: null, routes: 'so-far', ring: true }, mini: null, captions: [] };
}

// ---- the audio plan ----

function camTracksOf(sc, clips) {
  const out = [];
  if (sc.start === null || sc.kind === 'gap') return out;
  // v1.4.7: a split or a close call plays both players' real sound (left and right), each its own track, a little
  // lower while both play; a dark shot's sound plays too (the movie shows the face)
  const both = sc.layout === 'split' || sc.layout === 'minimap';
  const shots = sc.shots.filter((s) => s.slot === 'main' || s.slot === 'left' || (both && s.slot === 'right'))
    .sort((a, b) => (a.from - b.from) || (a.slot < b.slot ? -1 : 1));
  const byId = new Map(clips.map((c) => [c.id, c]));
  for (const s of shots) {
    const clip = byId.get(s.id);
    if (!clip) continue;
    const fa = fileTimeAt(clip, s.from);
    if (fa === null) continue;
    const t = { kind: 'cam', src: s.id, at: sc.at + (s.from - sc.start), ms: s.to - s.from, fileAt: fa };
    if (both) {
      t.side = s.slot === 'right' ? 'right' : 'left';
      if (shots.some((o) => o.slot !== s.slot && o.from < s.to && o.to > s.from)) t.base = SIDE_GAIN;
    }
    out.push(t);
  }
  return out;
}

function finishAudio(reel, clips, talk) {
  const tracks = [];
  const duckSpans = [];
  // walkie and wiretap: every message inside a scene, whole, at its own clock
  for (const sc of reel.scenes) {
    if (sc.start === null || sc.kind === 'gap') continue;
    for (const m of talk) {
      if (m.clock < sc.start || m.clock >= sc.end) continue;
      const at = sc.at + (m.clock - sc.start);
      if (tracks.some((t) => (t.kind === 'walkie' || t.kind === 'tap') && t.src === m.n && m.n !== null)) continue;
      tracks.push({ kind: m.side === 'wiretap' ? 'tap' : 'walkie', src: m.n, at, ms: m.ms, fileAt: 0, gain: [[at, 0], [at + 30, 1], [at + m.ms - 30, 1], [at + m.ms, 0]] });
      duckSpans.push([at, at + m.ms]);
    }
  }
  // camera: J-cut and crossfade at each scene change
  for (let i = 0; i < reel.scenes.length; i += 1) {
    const sc = reel.scenes[i];
    const cams = camTracksOf(sc, clips);
    if (!cams.length) continue;
    // (v1.4.7: every track starting with the scene, and every one ending with it: both sides of a split)
    for (const first of cams) {
      // the J-cut: its audio starts JCUT_MS before the picture
      if (Math.abs(first.at - sc.at) >= 5) continue;
      const back = Math.min(JCUT_MS, first.fileAt * 1000);
      first.at -= back; first.ms += back; first.fileAt -= back / 1000;
      first.fadeIn = true;
    }
    for (const last of cams) {
      // the crossfade: it runs XFADE_MS - JCUT_MS past the scene's end, fading out
      if (Math.abs(last.at + last.ms - (sc.at + sc.ms)) < 5) { last.ms += Math.max(0, XFADE_MS - JCUT_MS); last.fadeOut = true; }
    }
    for (const t of cams) tracks.push(t);
  }
  for (const t of tracks) {
    if (t.kind !== 'cam') continue;
    const end = t.at + t.ms;
    const fade = (u) => {
      let g = 1;
      if (t.fadeIn) g = Math.min(g, (u - t.at) / XFADE_MS);
      if (t.fadeOut) g = Math.min(g, (end - u) / XFADE_MS);
      return Math.max(0, Math.min(1, g));
    };
    const duck = (u) => {
      let g = 1;
      for (const [a, b] of duckSpans) {
        if (u >= a - DUCK_RAMP_MS && u <= b + DUCK_RAMP_MS) {
          const k = u < a ? (a - u) / DUCK_RAMP_MS : u > b ? (u - b) / DUCK_RAMP_MS : 0;
          g = Math.min(g, DUCK + (1 - DUCK) * k);
        }
      }
      return g;
    };
    const keys = new Set([t.at, end]);
    if (t.fadeIn) keys.add(t.at + XFADE_MS);
    if (t.fadeOut) keys.add(end - XFADE_MS);
    for (const [a, b] of duckSpans) for (const k of [a - DUCK_RAMP_MS, a, b, b + DUCK_RAMP_MS]) if (k > t.at && k < end) keys.add(k);
    const base = num(t.base) !== null ? t.base : 1; // v1.4.7: SIDE_GAIN while both sides of a split play
    t.gain = [...keys].filter((k) => k >= t.at && k <= end).sort((x, y) => x - y).map((k) => [Math.round(k), Math.round(fade(k) * duck(k) * base * 1000) / 1000]);
    if (!t.fadeIn) t.gain[0][1] = Math.max(t.gain[0][1], 0); // a hard cut inside a scene
    delete t.fadeIn; delete t.fadeOut; delete t.base;
  }
  // stings: a whoosh under each gap, a pad under the intro and outro, the room tone under everything
  for (const sc of reel.scenes) {
    if (sc.kind === 'gap') {
      const at = sc.at - XFADE_MS / 2, ms = sc.ms + XFADE_MS;
      tracks.push({ kind: 'sting', src: 'whoosh', at, ms, fileAt: 0, gain: [[at, 0], [at + ms * 0.4, 0.8], [at + ms, 0]] });
    }
    if (sc.kind === 'intro' || sc.kind === 'outro') {
      const at = sc.at, ms = sc.ms + (sc.kind === 'intro' ? XFADE_MS : 0);
      tracks.push({ kind: 'sting', src: 'pad', at, ms, fileAt: 0, gain: [[at, 0], [at + 600, PAD_GAIN], [at + ms - 800, PAD_GAIN], [at + ms, 0]] });
    }
  }
  tracks.push({ kind: 'sting', src: 'tone', at: 0, ms: reel.ms, fileAt: 0, gain: [[0, TONE_GAIN], [reel.ms, TONE_GAIN]] });
  for (const t of tracks) {
    t.at = Math.max(0, Math.round(t.at));
    t.ms = Math.max(0, Math.min(reel.ms - t.at, Math.round(t.ms)));
  }
  reel.audio = tracks.filter((t) => t.ms > 0).sort((a, b) => (a.at - b.at) || (a.kind < b.kind ? -1 : 1));
}

export function gainOf(track, t) {
  const g = track && Array.isArray(track.gain) ? track.gain : null;
  if (!g || !g.length) return t >= track.at && t < track.at + track.ms ? 1 : 0;
  if (t < g[0][0]) return g[0][1];
  for (let i = 0; i < g.length - 1; i += 1) {
    const [a, x] = g[i], [b, y] = g[i + 1];
    if (t >= a && t <= b) return b === a ? y : x + (y - x) * ((t - a) / (b - a));
  }
  return g[g.length - 1][1];
}

// ---- the reel ----

function place(reel) {
  let at = 0;
  for (const sc of reel.scenes) { sc.at = at; at += sc.ms; }
  reel.ms = at;
  reel.marks = reel.scenes.map((sc, i) => ({ at: sc.at, sceneIndex: i, title: sc.title, kind: sc.kind }))
    .filter((m) => m.kind !== 'stretch' && m.kind !== 'gap');
}

// v1.4.6: the director camera's tour of each quiet map stretch (tour.js)
function tours(reel, summary) {
  for (const sc of reel.scenes) {
    let t = null;
    try { t = planTour(sc, summary); } catch { t = null; }
    if (t) sc.tour = t;
  }
}

function busiest(summary, endClock) {
  const routes = summary && summary.routes ? summary.routes : {};
  let best = { from: 0, m: -1 };
  for (let t = 0; t + 60000 <= Math.max(60000, endClock); t += 30000) {
    let m = 0;
    for (const pts of Object.values(routes)) {
      for (let i = 1; i < pts.length; i += 1) {
        const c = pts[i][2] * 1000;
        if (c > t && c <= t + 60000) m += distanceM(pts[i - 1], pts[i]) || 0;
      }
    }
    if (m > best.m) best = { from: t, m };
  }
  return { from: best.from, to: Math.min(Math.max(endClock, 60000), best.from + 60000) };
}

// What the reel keeps of a clip: when it plays, and (v1.4.7) its loudness for a dark shot's sound wave.
function reelClip(c) {
  const out = { id: c.id, pid: c.pid, start: c.start, end: c.end, ms: c.ms, clocks: c.clocks, t0: c.t0 };
  if (Array.isArray(c.loudQ) && c.loudQ.length) out.loudQ = c.loudQ;
  else if (Array.isArray(c.loud) && c.loud.length) out.loud = c.loud;
  return out;
}

export function scenes({ summary = {}, clips = [], talk = null, speech = null, kind = 'highlights', most = HIGHLIGHTS_MOST_MS } = {}) {
  const list = cleanClips(clips);
  const msgs = cleanTalk(talk || (summary && summary.radio) || []);
  const lastClip = list.length ? Math.max(...list.map((c) => c.end)) : 0;
  const lastMsg = msgs.length ? Math.max(...msgs.map((m) => m.clock + m.ms)) : 0;
  const endClock = num(summary && summary.endClock) !== null ? summary.endClock : Math.max(lastClip, lastMsg, 60000);
  const cands = candidates(summary, list, msgs).filter((c) => c.clock >= 0 && c.clock <= endClock + 30000);
  const done = merge(cands.map((c) => edges({ ...c }, list, msgs, speech, endClock)));
  const reel = { kind, ms: 0, scenes: [], audio: [], marks: [], endClock, clips: list.map(reelClip) };

  if (kind === 'whole') {
    reel.scenes.push(introScene(summary));
    // the candidates cut the one timeline; between them plain stretches, cut where the footage changes
    const parts = [];
    let t = 0;
    const stretch = (from, to) => {
      // split at changes of "how many filmed" (0 / 1 / 2+), at most every 10 min for the progress bar
      let a = from;
      const filmedN = (u) => new Set(list.filter((c) => u >= c.start && u < c.end).map((c) => c.pid)).size;
      let k = Math.min(2, filmedN(a));
      for (let u = from + 1000; u < to; u += 1000) {
        const n = Math.min(2, filmedN(u));
        const inMsg = msgs.some((m) => u > m.clock && u < m.clock + m.ms);
        if (!inMsg && ((n !== k && u - a >= 3000) || u - a >= 600000)) {
          parts.push({ kind: 'stretch', clock: a, from: a, to: u, people: [], title: '', line: null, s: 0 });
          a = u; k = n;
        }
      }
      if (to > a) parts.push({ kind: 'stretch', clock: a, from: a, to, people: [], title: '', line: null, s: 0 });
    };
    for (const c of done) {
      const from = Math.max(t, c.from);
      if (from >= endClock) break;
      if (from > t) stretch(t, from);
      const to = Math.min(endClock, Math.max(from + 1, c.to));
      parts.push({ ...c, from, to });
      t = to;
    }
    if (t < endClock) stretch(t, endClock);
    for (const p of parts) {
      const sc = makeScene(p, list, msgs, summary, 'whole');
      sc.ms = sc.end - sc.start;
      if (p.kind === 'stretch') { sc.title = ''; sc.map.follow = null; }
      reel.scenes.push(sc);
    }
    reel.scenes.push(outroScene(summary));
    place(reel);
    tours(reel, summary);
    finishAudio(reel, list, msgs);
    return reel;
  }

  // Highlights
  const fill = fillers(list, done);
  const all = merge([...done, ...fill.map((c) => edges(c, list, msgs, speech, endClock))]);
  const lo = num(summary && summary.headStartMs) !== null ? summary.headStartMs : 0;
  const budget = Math.max(0, most - INTRO_MS - OUTRO_MS);
  let chosen = choose(all, budget, lo, endClock);
  if (!chosen.length) {
    const b = busiest(summary, endClock);
    chosen = [{ kind: 'stretch', clock: b.from, from: b.from, to: b.to, people: [], title: 'ON THE MOVE', line: null, s: 0 }];
  }
  reel.scenes.push(introScene(summary));
  let prev = null;
  for (const c of chosen) {
    if (prev && c.from - prev.to > GAP_AFTER_MS) reel.scenes.push(gapScene(prev.to, c.from, summary));
    const sc = makeScene(c, list, msgs, summary, 'highlights');
    sc.ms = sc.end - sc.start;
    reel.scenes.push(sc);
    prev = c;
  }
  reel.scenes.push(outroScene(summary));
  // the gaps were budgeted at GAP_LONG_MS each, so this stays within `most`
  place(reel);
  tours(reel, summary);
  finishAudio(reel, list, msgs);
  return reel;
}

export function sceneAt(reel, t) {
  const s = reel && reel.scenes ? reel.scenes : [];
  for (let i = 0; i < s.length; i += 1) if (t >= s[i].at && t < s[i].at + s[i].ms) return i;
  return s.length && t >= reel.ms ? s.length - 1 : -1;
}

export function clockAt(scene, t) {
  if (!scene || scene.start === null) return null;
  return scene.start + Math.max(0, Math.min(scene.ms, t - scene.at)) * scene.rate;
}

// ---- the close-call mini map ----

export function miniMap(call, { w = 300, h = 300 } = {}) {
  const track = call && call.track ? call.track : call && call.mini ? call.mini.track : null;
  const gap = call && call.gap ? call.gap : call && call.mini ? call.mini.gap : null;
  if (!track || !Array.isArray(track.a) || !Array.isArray(track.b) || (!track.a.length && !track.b.length)) return null;
  const pts = [...track.a, ...track.b];
  const origin = gap && gap.a && Array.isArray(gap.a.p) ? gap.a.p : [pts[0][0], pts[0][1]];
  const loc = (p) => toLocal(origin, [p[0], p[1]]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { const [x, y] = loc(p); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const span = Math.max(60, (x1 - x0) * 1.4, (y1 - y0) * 1.4);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sx = Math.min(w, h) / span;
  const px = (p) => { const [x, y] = loc(p); return [w / 2 + (x - cx) * sx, h / 2 - (y - cy) * sx]; };
  const map = (list) => list.map((p) => { const [x, y] = px(p); return [x, y, p[2]]; });
  let g = null;
  if (gap && gap.a && gap.b && Array.isArray(gap.a.p) && Array.isArray(gap.b.p)) {
    const [gx1, gy1] = px(gap.a.p), [gx2, gy2] = px(gap.b.p);
    g = { x1: gx1, y1: gy1, x2: gx2, y2: gy2, m: Math.round(num(gap.m) !== null ? gap.m : distanceM(gap.a.p, gap.b.p)), clock: gap.clock };
  }
  // the closest points go into both routes at the closest moment, so the heads pass exactly through them and the
  // counter comes down smoothly to the closest distance (thinned routes cut that corner, and it jumped)
  const withGap = (list, side) => {
    if (!g || num(gap.clock) === null || !side || !Array.isArray(side.p)) return list;
    const out = list.filter((p) => p[2] !== gap.clock);
    const i = out.findIndex((p) => p[2] > gap.clock);
    const pt = [side.p[0], side.p[1], gap.clock];
    if (i < 0) out.push(pt); else out.splice(i, 0, pt);
    return out;
  };
  return { box: { w, h, metres: span, pxPerM: sx }, a: map(withGap(track.a, gap && gap.a)), b: map(withGap(track.b, gap && gap.b)), gap: g,
    ids: [gap && gap.a ? gap.a.id : null, gap && gap.b ? gap.b.id : null], origin, geo: { cx, cy }, from: track.from, to: track.to };
}
