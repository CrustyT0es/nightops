// Night Ops v1.4 (PAGE-DEVICES): the lobby's ready check.
//   readyCard({ app, host }) -> { el, update(view), destroy() }
//   notReady(view) -> [{ id, name, why }]   (pure) who isn't ready, from view.ready (the host gets every row)
//   rowWord(row) -> { ok, words }           (pure) one player's line ("Ava: location off")
// Each phone sees its own rows (Location, Camera when filmed, Microphone, Alarm sound for a hider with Hacker on), each
// with a green dot and "Ready", or an amber dot and "Fix it" (the help screen for that part). "Test my location"
// takes one fix that never leaves the phone. The host's card adds "Everyone".
import { h, fill, text } from '../dom.js?v=171';
import { icon } from '../ui/icons.js?v=171';
import { openHelp } from '../ui/fixit.js?v=171';
import { deviceKind } from '../help.js?v=171';
import { soundFor } from '../hack.js?v=171';

export const AWAY_MS = 120000;     // "hasn't opened the game for 2 min"
export const GOOD_ACC_M = 30;
export const TEST_TONE_MS = 500;

const LOC_BAD = { denied: 'location blocked', off: 'location off', timeout: "location can't find them", none: 'no location on this phone' };
const CAM_BAD = { denied: 'camera blocked', off: 'camera off', none: 'no camera' };
const MIC_BAD = { denied: 'microphone blocked', off: 'microphone off', none: 'no microphone', silent: 'microphone hears nothing' };

export function rowWord(r) {
  if (!r) return { ok: false, words: '' };
  const bad = [];
  if (Number.isFinite(r.seen) && r.seen >= AWAY_MS) {
    return { ok: false, words: `${r.name}: hasn't opened the game for ${Math.floor(r.seen / 60000)} min` };
  }
  if (r.loc && LOC_BAD[r.loc]) bad.push(LOC_BAD[r.loc]);
  if (r.cam && CAM_BAD[r.cam]) bad.push(CAM_BAD[r.cam]);
  if (r.mic && MIC_BAD[r.mic]) bad.push(MIC_BAD[r.mic]);
  if (r.snd === 'locked') bad.push('alarm sound not tested');
  if (!r.loc && !r.cam && !r.mic) return { ok: true, words: `${r.name}: not checked yet`, unknown: true };
  if (!bad.length) return { ok: true, words: `${r.name}: ready` };
  return { ok: false, words: `${r.name}: ${bad.join(', ')}` };
}

export function notReady(view) {
  const rows = (view && Array.isArray(view.ready)) ? view.ready : [];
  const out = [];
  for (const r of rows) {
    const w = rowWord(r);
    if (!w.ok) out.push({ id: r.id, name: r.name, why: w.words.slice(r.name.length + 2) });
  }
  return out;
}

// My own rows (pure): what to show for this phone. -> [{ part, ok, words, why }]
export function myRows({ view, loc, media, soundOk, locTest = null }) {
  const s = (view && view.settings) || {};
  const rows = [];
  const lw = loc || 'asking';
  let locWords = 'Ready';
  let locOk = lw === 'ok';
  if (locTest && locTest.ok && Number.isFinite(locTest.acc)) {
    locOk = true;
    locWords = locTest.acc <= GOOD_ACC_M ? `Found you to ${locTest.acc} m` : `Found you, but only to ${locTest.acc} m. Go outside or turn on Precise Location.`;
  } else if (!locOk) locWords = lw === 'asking' ? 'Not tested yet' : 'Fix it';
  rows.push({ part: 'location', ok: locOk, words: locWords, why: lw === 'asking' ? 'denied' : lw, weak: !!(locTest && locTest.ok && locTest.acc > GOOD_ACC_M), untested: lw === 'asking' && !locTest });
  const camOk = !!(view && view.cam && view.cam.ok);
  if (s.cam && camOk) {
    const c = media ? media.cam : 'na';
    rows.push({ part: 'camera', ok: c === 'ok', words: c === 'ok' ? 'Ready' : c === 'na' ? 'Not tested yet' : 'Fix it', why: c === 'na' ? 'denied' : c, untested: c === 'na' });
  }
  const m = media ? media.mic : 'na';
  rows.push({ part: 'mic', ok: m === 'ok', words: m === 'ok' ? 'Ready' : m === 'na' ? 'Not tested yet' : 'Fix it', why: m === 'na' ? 'denied' : m, untested: m === 'na' });
  const mine = view && view.me ? (view.players || []).find((p) => p.id === view.me.id) : null;
  if (s.powers && s.powers.hacker && !(mine && mine.pick === 'hunter')) {
    rows.push({ part: 'sound', ok: !!soundOk, words: soundOk ? 'Ready' : 'Tap Test', why: 'locked', untested: !soundOk });
  }
  return rows;
}

const LABEL = { location: 'Location', camera: 'Camera', mic: 'Microphone', sound: 'Alarm sound' };
const ICON = { location: 'locate', camera: 'camera', mic: 'mic', sound: 'speaker' };

// A quiet 0.5 s siren: unlocks the AudioContext from a tap, so a Hacker alarm can sound later.
export function playTestTone(win = globalThis.window) {
  const sound = soundFor(win);
  try {
    // From the tap: wakes the shared context the Hacker alarm plays on (resume + a silent buffer).
    sound.wake();
    const ac = sound.context();
    if (!ac) return false;
    sound.session(true);
    setTimeout(() => { try { sound.session(false); } catch { /* ignore */ } }, TEST_TONE_MS + 300);
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sawtooth';
    const t = ac.currentTime;
    o.frequency.setValueAtTime(700, t);
    o.frequency.linearRampToValueAtTime(1300, t + TEST_TONE_MS / 2000);
    o.frequency.linearRampToValueAtTime(700, t + TEST_TONE_MS / 1000);
    g.gain.setValueAtTime(0.15, t);
    g.gain.linearRampToValueAtTime(0, t + TEST_TONE_MS / 1000);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + TEST_TONE_MS / 1000 + 0.05);
    return true;
  } catch { return false; }
}

export function readyCard({ app, host = false } = {}) {
  const kind = deviceKind();
  const S = { view: null, locWord: 'asking', locTest: null, testing: false, dead: false, perm: null };
  const list = h('ul.rd-list');
  const testBtn = h('button.btn.rd-test', { type: 'button' }, icon('locate', 18), 'Test my location');
  const testLine = h('p.rd-test-line', { role: 'status', 'aria-live': 'polite' });
  const everyone = h('div.rd-everyone', { hidden: true });
  const el = h('section.lobby-card.rd-card', { 'aria-labelledby': 'rd-title', 'data-anchor': 'ready' },
    h('div.rd-head', h('h2#rd-title.rd-title', 'Ready check'), h('span.rd-sum')),
    list, h('div.rd-testrow', testBtn), testLine, everyone);
  // v1.6: the head opens and folds the card
  const headEl = el.querySelector('.rd-head');
  headEl.setAttribute('role', 'button');
  headEl.tabIndex = 0;
  const flip = () => { S.userFold = !el.classList.contains('rd-folded'); el.classList.toggle('rd-folded', S.userFold); };
  headEl.addEventListener('click', flip);
  headEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });

  function setLoc(w) {
    S.locWord = w;
    try { if (app) app.lobbyLoc = w; } catch { /* ignore */ }
  }

  // The permission state where the browser can say it (Safari can't: then it's found by the test).
  try {
    const perms = globalThis.navigator && navigator.permissions;
    if (perms && perms.query) {
      perms.query({ name: 'geolocation' }).then((st) => {
        if (S.dead || !st) return;
        S.perm = st;
        const apply = () => {
          if (st.state === 'granted') setLoc(S.locTest && !S.locTest.ok ? S.locTest.why : 'ok');
          else if (st.state === 'denied') setLoc('denied');
          else if (!S.locTest) setLoc('asking');
          paint();
        };
        st.onchange = apply;
        apply();
      }, () => {});
    }
  } catch { /* not here */ }
  if (!(globalThis.navigator && navigator.geolocation)) setLoc('none');

  testBtn.addEventListener('click', async () => {
    const loc = app && app.location;
    if (!loc || typeof loc.test !== 'function' || S.testing) return;
    S.testing = true;
    testBtn.disabled = true;
    text(testLine, 'Finding you...');
    const r = await loc.test();
    S.testing = false;
    testBtn.disabled = false;
    if (S.dead) return;
    S.locTest = r;
    setLoc(r.ok ? 'ok' : r.why);
    if (r.ok) text(testLine, r.acc <= GOOD_ACC_M ? `Found you to ${r.acc} m.` : `Found you, but only to ${r.acc} m. Go outside or turn on Precise Location.`);
    else text(testLine, r.why === 'denied' ? 'Location is blocked. Tap Fix it.' : r.why === 'off' ? 'Location is off. Tap Fix it.' : "Couldn't find you. Tap Fix it.");
    testLine.dataset.kind = r.ok ? (r.acc <= GOOD_ACC_M ? 'good' : 'weak') : 'bad';
    paint();
    if (app && app.syncNow) app.syncNow();
  });

  function fixIt(row) {
    const media = app && app.media;
    let onTry = null;
    if (row.part === 'location') onTry = async () => { const r = await app.location.test(); S.locTest = r; setLoc(r.ok ? 'ok' : r.why); paint(); return r.ok ? `Found you to ${r.acc} m.` : 'Still not working.'; };
    else if (row.part === 'camera' || row.part === 'mic') onTry = async () => { const r = media ? await media.test(row.part) : 'none'; paint(); return r === 'ok' ? 'Working.' : 'Still not working.'; };
    else onTry = () => { const ok = playTestTone(); if (app) app.soundOk = ok; paint(); return ok ? 'Did you hear it?' : "This phone can't make sound."; };
    openHelp({ part: row.part, why: row.why, kind, onTry });
  }

  async function test(row) {
    const media = app && app.media;
    if (row.part === 'sound') { const ok = playTestTone(); if (app) app.soundOk = ok; paint(); return; }
    if (row.part === 'location') { testBtn.click(); return; }
    if (media) { await media.test(row.part); paint(); }
  }

  function paint() {
    if (S.dead || !S.view) return;
    const media = app && app.media ? app.media.state : null;
    const rows = myRows({ view: S.view, loc: S.locWord, media, soundOk: !!(app && app.soundOk), locTest: S.locTest });
    fill(list, rows.map((r) => {
      const dot = h('span.rd-dot', { 'data-k': r.ok ? (r.weak ? 'weak' : 'ok') : (r.untested ? 'wait' : 'bad'), 'aria-hidden': 'true' });
      const action = r.ok && !r.weak ? null
        : r.untested ? h('button.btn.small.rd-do', { type: 'button', onclick: () => test(r) }, 'Test')
          : h('button.btn.small.rd-do.rd-fix', { type: 'button', onclick: () => fixIt(r) }, 'Fix it');
      return h('li.rd-row', { 'data-part': r.part, 'data-ok': r.ok ? '1' : '0' },
        dot, icon(ICON[r.part], 18), h('span.rd-label', LABEL[r.part]), h('span.rd-words', r.ok && !r.weak ? 'Ready' : r.words), action);
    }));
    const good = rows.every((r) => r.ok);
    const left = rows.filter((r) => !r.ok).length;
    text(el.querySelector('.rd-sum'), good ? 'All set' : left === 1 ? '1 to check' : `${left} to check`);
    el.dataset.ok = good ? '1' : '0';
    // v1.6: folded to its head once everything's ready (a tap opens it again); open while something needs doing
    if (S.userFold === undefined) el.classList.toggle('rd-folded', good);
    // The host: everyone's rows.
    const all = host && Array.isArray(S.view.ready) ? S.view.ready : null;
    everyone.hidden = !all || all.length < 1;
    if (all) {
      fill(everyone, h('h3.rd-sub', 'Everyone'), h('ul.rd-all', all.map((r) => {
        const w = rowWord(r);
        return h('li.rd-person', { 'data-ok': w.ok ? '1' : '0' }, h('span.rd-dot', { 'data-k': w.ok ? (w.unknown ? 'wait' : 'ok') : 'bad', 'aria-hidden': 'true' }), h('span', w.words));
      })));
    }
  }

  const offMedia = app && app.media && app.media.on ? app.media.on('state', paint) : () => {};
  return {
    el,
    update(view) { S.view = view; paint(); },
    destroy() { S.dead = true; offMedia(); if (S.perm) S.perm.onchange = null; },
  };
}
