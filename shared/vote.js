// Night Ops v1.6: the lobby vote, Jackbox style, on everyone's own phone. Pure functions over the game state,
// used by the engine (commands, the lazy result, the view) and the page (where in the show it is).
//
//   state.vote = null | {
//     id, at (epoch ms the show began), introMs, gearMs, voteMs, explainMs, resultMs,
//     questions: [{ q, options: [key...] }],
//     ballots: { [q]: { [playerId]: key } },
//     gear: { [playerId]: { loc, mic, cam } },      (the group gear check: true ok, false trouble, null not asked)
//     applied: false | true, result: { [q]: key } (each question's winner, filled in as each one closes)
//   }
// The timeline is fixed from `at`: the intro, the group gear check, then for each question its vote (voteMs) and
// the winner with its explainer (explainMs), then the recap (resultMs). Every phone works out where it is from the
// server's clock (view.now), so they all play together.
//
// The winner is decided from the picks alone (a tie is settled by a hash of the vote and the question, never by
// chance at the server), so a phone shows the right winner the moment the question closes, before the server's
// answer arrives. The settings change once, after the last question (applyDue in the engine).
//
// Not voted on, the host's own: the ring, checkpoints, the driver, spectators, the camera, who hunts.

export const INTRO_MS = 28500;    // the narrated intro: title + Static says hi, hiders, hunters, the ring, "gear check!"
export const GEAR_MS = 18000;     // everyone checks location, microphone and camera together
export const VOTE_MS = 10000;     // each question
export const EXPLAIN_MS = 9000;   // each winner (a drum roll, then the slam) and how it plays
export const RESULT_MS = 7000;    // the recap before the lobby comes back
export const SKIPPED_INTRO_MS = 3000; // the host skipped the intro: straight to the gear check

export const OPTIONS = {
  mode: {
    classic: { label: 'Classic', line: 'Hunters chase. Hiders hide.', icon: 'target' },
    checkpoints: { label: 'Checkpoints', line: 'Race to stores, snap a photo.', icon: 'flag' },
    loot: { label: 'Loot drops', line: 'Boxes drop. Grab them for powers.', icon: 'gift' },
  },
  length: {
    quick: { label: 'Quick', line: '20 minutes', icon: 'bolt' },
    standard: { label: 'Standard', line: '45 minutes', icon: 'moon' },
    long: { label: 'Long', line: '90 minutes', icon: 'owl' },
  },
  pings: {
    chill: { label: 'Chill', line: 'A ping every 6 min', icon: 'sleep' },
    normal: { label: 'Normal', line: 'Fits the game length', icon: 'radar' },
    rapid: { label: 'Rapid', line: 'A ping every 2 min', icon: 'siren' },
  },
  powers: {
    all: { label: 'All powers', line: 'Radar, Decoy, Hacker...', icon: 'bolt2' },
    basic: { label: 'Just the basics', line: 'No Hacker or Wiretap', icon: 'shield' },
    none: { label: 'No powers', line: 'Pure hide and seek', icon: 'ban' },
  },
  caught: {
    join: { label: 'Join the hunt', line: 'Caught? You hunt now', icon: 'zombie' },
    out: { label: 'Sit out', line: 'Caught? Watch and chat', icon: 'chair' },
  },
  ring: {
    steady: { label: 'Stays put', line: 'The ring never moves', icon: 'circle' },
    shrink: { label: 'Shrinks', line: 'Down to half at the end', icon: 'shrink' },
    squeeze: { label: 'Tight squeeze', line: 'Down to 30%', icon: 'squeeze' },
  },
  walkies: {
    hunters: { label: 'Hunters only', line: 'Hiders stay quiet', icon: 'mic' },
    both: { label: 'Both teams', line: 'Hiders get one too', icon: 'mics' },
  },
};
export const QUESTIONS = ['mode', 'length', 'pings', 'powers', 'caught', 'ring', 'walkies'];
export const PROMPTS = {
  mode: 'Which game?',
  length: 'How long?',
  pings: 'How often do hiders get pinged?',
  powers: 'Powers?',
  caught: 'When a hider gets caught...',
  ring: 'What does the ring do?',
  walkies: 'Who gets a walkie-talkie?',
};

// The explainer after each question: what the winner means, in the words Static says. { title, lines, scene }
// (scene: the little animation js/screens/voteshow.js plays).
export const EXPLAIN = {
  mode: {
    classic: { scene: 'classic', title: 'Classic it is!', lines: ['Hunters chase, hiders hide.', 'Last hider standing wins it for the hiders.'] },
    checkpoints: { scene: 'checkpoints', title: 'Checkpoints!', lines: ['One checkpoint opens at a time.', 'Get there, snap the photo. Most checkpoints wins.'] },
    loot: { scene: 'loot', title: 'Loot drops!', lines: ['Boxes drop around the ring every few minutes.', 'Walk up to one to grab it. Both teams can!', 'Open it: common, rare or LEGENDARY power.'] },
  },
  length: {
    quick: { scene: 'clock', title: '20 minutes!', lines: ['Short and sweaty.', 'Pings every 3 minutes.'] },
    standard: { scene: 'clock', title: '45 minutes!', lines: ['The classic length.', 'Pings every 5 minutes.'] },
    long: { scene: 'clock', title: '90 minutes!', lines: ['The long haul. Bring snacks.', 'Pings every 7 minutes.'] },
  },
  pings: {
    chill: { scene: 'ping', title: 'Chill pings', lines: ['Hiders show up every 6 minutes.', 'More time to sneak around.'] },
    normal: { scene: 'ping', title: 'Normal pings', lines: ['Pings come as often as the game length says.'] },
    rapid: { scene: 'ping', title: 'Rapid pings!', lines: ['Hiders show up every 2 minutes.', 'Keep moving!'] },
  },
  powers: {
    all: { scene: 'powers', title: 'All powers!', lines: ['Hunters get Radar, Exposure and Hacker.', 'Hiders get Jammer, Decoy and Sprint.'] },
    basic: { scene: 'powers', title: 'Just the basics', lines: ['Radar and Exposure for hunters.', 'Jammer, Decoy and Sprint for hiders.'] },
    none: { scene: 'nopowers', title: 'No powers!', lines: ['Just legs and lungs.', 'Pure hide and seek.'] },
  },
  caught: {
    join: { scene: 'join', title: 'Caught? Join the hunt!', lines: ['Get tagged and you switch sides.', 'The hunt grows as it goes.'] },
    out: { scene: 'out', title: 'Caught? Sit out.', lines: ['Get tagged and you watch from the side.', 'No giving hiders away!'] },
  },
  ring: {
    steady: { scene: 'ring', title: 'The ring stays put', lines: ['Stay inside the ring the whole game.', 'Step out and everyone sees exactly where you are.'] },
    shrink: { scene: 'shrink', title: 'The ring shrinks!', lines: ['Near the end it closes in to half.', 'Step out and everyone sees exactly where you are.'] },
    squeeze: { scene: 'shrink', title: 'Tight squeeze!', lines: ['Near the end it closes in to 30%.', 'Nowhere left to hide.'] },
  },
  walkies: {
    hunters: { scene: 'walkie', title: 'Hunters only', lines: ['Hold to talk to your team.', 'Hiders: text chat only.'] },
    both: { scene: 'walkie', title: 'Walkies for both!', lines: ['Each team gets its own walkie-talkie.', 'Hold to talk. Quiet mode for sneaking.'] },
  },
};

// The settings a winning key changes (merged by the engine's cleanSettings, in QUESTIONS order: pings after length).
export function settingsFor(q, key, { presets, powers } = {}) {
  if (q === 'mode') return { mode: key };
  if (q === 'length') return presets && presets[key] ? { ...presets[key].settings } : {};
  if (q === 'pings') {
    if (key === 'chill') return { pingEveryMin: 6, closingPingEveryMin: 3 };
    if (key === 'rapid') return { pingEveryMin: 2, closingPingEveryMin: 1 };
    return {};
  }
  if (q === 'powers') {
    const all = powers || [];
    if (key === 'none') return { powers: Object.fromEntries(all.map((p) => [p, false])) };
    if (key === 'basic') return { powers: Object.fromEntries(all.map((p) => [p, p !== 'hacker' && p !== 'wiretap'])) };
    return { powers: Object.fromEntries(all.map((p) => [p, p !== 'wiretap'])) }; // (Wiretap stays the host's: it needs everyone's OK)
  }
  if (q === 'caught') return { caught: key };
  if (q === 'ring') {
    if (key === 'shrink') return { shrink: true, finalSizePct: 50 };
    if (key === 'squeeze') return { shrink: true, finalSizePct: 30 };
    return { shrink: false };
  }
  if (q === 'walkies') return { radioHiders: key === 'both' };
  return {};
}

export function totalMs(v) {
  return v.introMs + (v.gearMs || 0) + v.questions.length * (v.voteMs + (v.explainMs || 0)) + v.resultMs;
}

// Where the show is at `now`: { stage: 'intro'|'gear'|'question'|'explain'|'results'|'done', i (question index),
// left (ms to the stage's end), ms (into the stage) }.
export function stageAt(v, now) {
  if (!v) return { stage: 'done', i: -1, left: 0, ms: 0 };
  let t = now - v.at;
  if (t < v.introMs) return { stage: 'intro', i: -1, left: v.introMs - t, ms: t };
  t -= v.introMs;
  const gear = v.gearMs || 0;
  if (t < gear) return { stage: 'gear', i: -1, left: gear - t, ms: t };
  t -= gear;
  const n = v.questions.length;
  const each = v.voteMs + (v.explainMs || 0);
  if (t < n * each) {
    const i = Math.floor(t / each);
    const u = t - i * each;
    if (u < v.voteMs) return { stage: 'question', i, left: v.voteMs - u, ms: u };
    return { stage: 'explain', i, left: each - u, ms: u - v.voteMs };
  }
  t -= n * each;
  if (t < v.resultMs) return { stage: 'results', i: n, left: v.resultMs - t, ms: t };
  return { stage: 'done', i: n, left: 0, ms: t - v.resultMs };
}

// Has question i's vote closed at `now`?
export function closed(v, i, now) {
  const at = stageAt(v, now);
  if (at.stage === 'results' || at.stage === 'done') return true;
  if (at.stage === 'explain') return at.i >= i;
  if (at.stage === 'question') return at.i > i;
  return false;
}

// The questions offered: Checkpoints only once the host has placed at least two; `skip` leaves questions out.
export function newVote({ now, id, checkpoints = 0, skipIntro = false, skip = [] }) {
  const options = (q) => Object.keys(OPTIONS[q]).filter((k) => q !== 'mode' || k !== 'checkpoints' || checkpoints >= 2);
  const qs = QUESTIONS.filter((q) => !skip.includes(q));
  return {
    id, at: now,
    introMs: skipIntro ? SKIPPED_INTRO_MS : INTRO_MS, gearMs: GEAR_MS, voteMs: VOTE_MS, explainMs: EXPLAIN_MS, resultMs: RESULT_MS,
    questions: qs.map((q) => ({ q, options: options(q) })),
    ballots: Object.fromEntries(qs.map((q) => [q, {}])),
    gear: {},
    applied: false,
    result: {},
  };
}

// A number in [0, 1) from words (FNV-1a), for a tie that every phone settles the same way.
export function hashUnit(words) {
  let x = 0x811c9dc5;
  for (const ch of String(words)) { x ^= ch.codePointAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
  return x / 4294967296;
}

// The winner of a question: the most votes; a tie is settled by hashUnit(`${voteId}:${q}`); no votes at all keeps
// `keep` (what the settings already are), else the first option.
export function winner(question, ballots, voteId = 0, keep = null) {
  const counts = new Map(question.options.map((k) => [k, 0]));
  for (const k of Object.values(ballots || {})) if (counts.has(k)) counts.set(k, counts.get(k) + 1);
  const most = Math.max(0, ...counts.values());
  if (most === 0) return question.options.includes(keep) ? keep : question.options[0];
  const top = [...counts].filter(([, n]) => n === most).map(([k]) => k);
  if (top.length === 1) return top[0];
  return top[Math.min(top.length - 1, Math.floor(hashUnit(`${voteId}:${question.q}`) * top.length))];
}

// What the settings are now, as each question's option (for "no votes keeps what it is").
export function keepFor(q, settings = {}) {
  if (q === 'mode') return settings.mode === 'infection' ? 'classic' : settings.mode;
  if (q === 'caught') return settings.caught;
  if (q === 'walkies') return settings.radioHiders ? 'both' : 'hunters';
  if (q === 'ring') return !settings.shrink ? 'steady' : (settings.finalSizePct <= 30 ? 'squeeze' : 'shrink');
  return null;
}

// The gear check's answer for one phone: each of loc/mic/cam true (works), false (trouble) or null (not checked).
export function cleanGear(g) {
  const one = (x) => (x === true ? true : x === false ? false : null);
  return { loc: one(g && g.loc), mic: one(g && g.mic), cam: one(g && g.cam) };
}

// What a phone sees: the timeline, the questions with every pick so far (who picked what: the dots), its own picks,
// everyone's gear check.
export function voteView(v, meId) {
  if (!v) return null;
  const qs = v.questions.map((x) => x.q);
  return {
    id: v.id, at: v.at, introMs: v.introMs, gearMs: v.gearMs || 0, voteMs: v.voteMs, explainMs: v.explainMs || 0, resultMs: v.resultMs,
    questions: v.questions.map((x) => ({ q: x.q, options: [...x.options] })),
    picks: Object.fromEntries(qs.map((q) => [q, { ...((v.ballots || {})[q] || {}) }])),
    mine: Object.fromEntries(qs.map((q) => [q, ((v.ballots || {})[q] || {})[meId] || null])),
    gear: Object.fromEntries(Object.entries(v.gear || {}).map(([id, g]) => [id, cleanGear(g)])),
    applied: !!v.applied,
    result: v.result ? { ...v.result } : {},
  };
}
