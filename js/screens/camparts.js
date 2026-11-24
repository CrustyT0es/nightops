// Night Ops v1.2 (PAGE-CAM): the end screen's parts of the highlight cam.
//
//   attachCamParts({ app, videoSlot, cardSlot, hooks }) -> { update(view), destroy() }
//       what over.js mounts: the clips card (into cardSlot) and the replay's video window (into videoSlot, fed from
//       hooks = { frame, open, close, jump }). Nothing shows for a game without the camera.
//   clipsCard({ app, list, urls, nav, storage }) -> { el, update(view), destroy() }   (v1.4.7: uploads wait for wifi, netgate.js)
//   createVideoWindow({ app, slot, list }) -> { setData({ list, summary }), frame(f), jump(clockMs), follow(pid), destroy() }
//   confirmAgain(app, view) -> Promise<boolean>   Play again's warning when this round has clips
//
// Pure helpers (tested in Node): fmtMB, progressWords, clipLabel, keptWords, camOf, stillComing, mineOf.
import { h, fill, text, cls, face } from '../dom.js?v=176';
import { icon } from '../ui/icons.js?v=176';
import { openSheet } from '../ui/sheet.js?v=176';
import { fmtClock } from '../../shared/rules.js?v=176';
import { direct, fileTimeAt } from '../director.js?v=176';
import { canMakeMovie, talkOf } from '../movie.js?v=176';
import { scenes as reelScenes } from '../scenes.js?v=176';
import { renderReel } from '../render.js?v=176';
import { createUploader } from '../upload.js?v=176';
import { heldOf } from '../camstore.js?v=176';
import { createNetGate, uploadStep, leftWords, untilOf, NET_WORDS } from '../netgate.js?v=176'; // v1.4.7
import { ask as askPart, answerWords as answerText } from '../permissions.js?v=176'; // v1.6.2 PERMS

export const POLL_MS = 10000;
export const URL_KEEP_MS = 13 * 60 * 1000;   // signed links last 15 min; asked again a little before
export const SYNC_S = 0.4;
export const STILL_EVERY_MS = 1000;

export const WORDS = {
  title: 'Camera',
  wifi: 'Uploading uses a lot of data. Wifi is best, like at home or at a cafe.',
  upload: 'Upload my clips',
  again: 'Upload the rest',
  allUp: 'All your clips are up.',
  none: 'No clips were saved on this phone.',
  del: 'Delete my clips from this phone',
  delAsk: "Your clips on this phone go for good. Clips you've already uploaded stay in the game.",
  forget: 'Take my clips out of the game',
  forgetAsk: 'Your uploaded clips are deleted from the game, so nobody can watch or download them.',
  forgot: 'Your clips are out of the game.',
  movie: 'Download the movie',
  all: 'Download all clips',
  // (v1.5.2: no Keep button: every finished round is saved 30 days by itself; keeprow.js says so. Where a download
  // goes is still said beside the download buttons.)
  saved: 'Downloads save to your phone (iPhone: the Files app, or Photos with Share > Save Video).',
  nothingYet: 'No clips are up yet. They show here as phones upload them.',
  noCamera: 'No camera here',
  againWarn: "This round stays saved for 30 days, but clips that aren't uploaded yet can't be added after Play again.",
  movieKeep: 'Keep this screen on and Night Ops open.',
  moviePaused: 'Paused while Night Ops is in the background. Come back to carry on.',
  movieCant: "This phone can't make the movie. Download the clips instead.",
};

// ---- pure helpers -----------------------------------------------------------------------------------------

export function fmtMB(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 MB';
  const mb = n / 1e6;
  return mb < 10 ? `${Math.max(0.1, Math.round(mb * 10) / 10)} MB` : `${Math.round(mb)} MB`;
}

export function camOf(view) {
  const s = view && view.summary;
  return s && s.cam && typeof s.cam === 'object' ? s.cam : null;
}

// One filmed player's upload line: "Ava: 8 of 12 clips", "Sam: none yet", "Mia: all 5", "Leo: 3 clips".
export function progressWords(row, name) {
  const done = Number(row && row.done) || 0;
  const have = row && row.have && Number.isInteger(row.have.count) ? row.have.count : null;
  if (have !== null && have === 0) return `${name}: no clips`;
  if (have !== null && done >= have) return done === 1 ? `${name}: 1 clip, all up` : `${name}: all ${done} clips`;
  if (have !== null) return `${name}: ${done} of ${have} ${have === 1 ? 'clip' : 'clips'}`;
  if (!done) return `${name}: none yet`;
  return `${name}: ${done} ${done === 1 ? 'clip' : 'clips'}`;
}

// Still waiting for some phone's clips (so the list is asked for again).
export function stillComing(list) {
  const rows = list && Array.isArray(list.progress) ? list.progress : [];
  if (!rows.length) return false;
  return rows.some((r) => !r.have || (Number(r.done) || 0) < r.have.count);
}

export function clipLabel(clip, name) {
  const s = Math.max(1, Math.round((Number(clip.ms) || 0) / 1000));
  const len = s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}` : `${s} s`;
  return `${fmtClock(clip.start)} ${name}, ${len}, ${fmtMB(clip.bytes)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function keptWords(epoch) {
  if (!Number.isFinite(epoch)) return '';
  const d = new Date(epoch);
  return `Kept until ${MONTHS[d.getMonth()]} ${d.getDate()}.`;
}

function nameIn(view, pid) {
  const s = view && view.summary;
  const rows = [...((s && s.players) || []), ...((view && view.players) || [])];
  const r = rows.find((p) => p && p.id === pid);
  return r && r.name ? String(r.name).slice(0, 40) : 'Someone';
}

function teamIn(view, pid) {
  const s = view && view.summary;
  const r = ((s && s.players) || []).find((p) => p && p.id === pid);
  if (!r) return null;
  if (r.driver) return 'driver';
  return r.startTeam === 'hider' ? 'hider' : 'hunter';
}

export function mineOf(view) {
  const cam = camOf(view);
  const me = view && view.me ? view.me.id : null;
  return !!(cam && me && Array.isArray(cam.filmed) && cam.filmed.includes(me));
}

function isComputer() {
  try { return globalThis.matchMedia && matchMedia('(pointer: fine)').matches; } catch { return false; }
}

// ---- the list (cam-list), shared by the card and the window ------------------------------------------------

function createList(app) {
  const fns = new Set();
  const S = { list: null, timer: 0, busy: false, dead: false, want: false };
  async function load() {
    if (S.busy || S.dead) return S.list;
    S.busy = true;
    try {
      const got = await app.video('cam-list', {});
      if (!S.dead && got) {
        S.list = { mode: got.mode, round: got.round, clips: Array.isArray(got.clips) ? got.clips : [], progress: Array.isArray(got.progress) ? got.progress : [], kept: Number.isFinite(got.kept) ? got.kept : null };
        for (const fn of [...fns]) try { fn(S.list); } catch (e) { console.error(e); }
      }
    } catch { /* asked again later */ } finally {
      S.busy = false;
    }
    return S.list;
  }
  function schedule() {
    clearTimeout(S.timer);
    if (S.dead || !S.want) return;
    S.timer = setTimeout(async () => {
      const hidden = globalThis.document && document.visibilityState === 'hidden';
      if (!hidden && (!S.list || stillComing(S.list) || S.extra)) await load();
      schedule();
    }, POLL_MS);
  }
  return {
    get list() { return S.list; },
    load,
    start() { if (S.want) return; S.want = true; load(); schedule(); },
    poke() { load(); },
    keepPolling(on) { S.extra = !!on; },
    on(fn) { fns.add(fn); return () => fns.delete(fn); },
    destroy() { S.dead = true; clearTimeout(S.timer); fns.clear(); },
  };
}

// Signed download links (asked for 8 at a time, asked again when old or broken).
function createUrls(app) {
  const got = new Map(); // id -> { url, at }
  return {
    async get(ids) {
      const now = Date.now();
      const want = [...new Set(ids)].filter((id) => { const g = got.get(id); return !g || now - g.at > URL_KEEP_MS; });
      for (let i = 0; i < want.length; i += 8) {
        try {
          const r = await app.video('cam-urls', { ids: want.slice(i, i + 8) });
          for (const [id, url] of Object.entries((r && r.urls) || {})) if (typeof url === 'string') got.set(id, { url, at: Date.now() });
        } catch { /* left out */ }
      }
      const out = {};
      for (const id of ids) if (got.has(id)) out[id] = got.get(id).url;
      return out;
    },
    forget(id) { got.delete(id); },
  };
}

// ---- Play again's warning ---------------------------------------------------------------------------------

export function confirmAgain(app, view) {
  const cam = camOf(view);
  if (!cam) return Promise.resolve(true);
  return new Promise((resolve) => {
    let answered = false;
    openSheet({
      title: 'Play again?',
      body: h('p.cam-sheet-line', WORDS.againWarn),
      actions: [
        { label: 'Play again', kind: 'primary', onClick: () => { answered = true; resolve(true); } },
        { label: 'Cancel', kind: 'ghost', onClick: () => { answered = true; resolve(false); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// ---- the clips card ---------------------------------------------------------------------------------------

export function clipsCard({ app, list, urls, nav, storage }) { // v1.4.7: nav, storage (the wifi gate's; tests)
  const S = { view: null, rows: [], up: null, dead: false, key: '', gate: null, offGate: null, tried: false, gateWas: null };
  const mineTitle = h('p.cam-mine-title');
  const uploadBtn = h('button.btn.primary.wide.cam-upload', { type: 'button' }, icon('send', 20), h('span', WORDS.upload));
  const wifi = h('p.cam-wifi', { role: 'status', 'aria-live': 'polite' }, WORDS.wifi);
  // v1.4.7: uploads wait for wifi: "Wait, I'll upload later on wifi" beside the question, and the time left
  const laterBtn = h('button.btn.ghost.wide.cam-later', { type: 'button', hidden: true }, h('span', NET_WORDS.later));
  const leftLine = h('p.cam-left', { hidden: true });
  const bar = h('div.cam-bar', { role: 'progressbar', 'aria-label': 'Uploading your clips', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, h('span.cam-bar-fill'));
  const upLine = h('p.cam-up-line', { role: 'status', 'aria-live': 'polite' });
  const delBtn = h('button.btn.ghost.small.cam-del', { type: 'button' }, icon('trash', 18), h('span', WORDS.del));
  const forgetBtn = h('button.btn.ghost.small.cam-forget', { type: 'button', hidden: true }, icon('trash', 18), h('span', WORDS.forget));
  const mine = h('div.cam-mine', { hidden: true }, mineTitle, wifi, uploadBtn, laterBtn, leftLine, bar, upLine, delBtn, forgetBtn);

  const progList = h('ul.cam-progress', { role: 'list' });
  const nothing = h('p.cam-nothing', WORDS.nothingYet);
  const movieBtn = h('button.btn.wide.cam-movie', { type: 'button', hidden: true }, icon('play', 20), h('span', WORDS.movie));
  const allBtn = h('button.btn.ghost.wide.cam-all', { type: 'button', hidden: true }, icon('share', 20), h('span', WORDS.all));
  const savedHint = h('p.cam-keep-hint', { hidden: true }, WORDS.saved);
  const el = h('section.over-card.over-cam', { 'aria-labelledby': 'over-cam-title', hidden: true },
    h('div.over-card-head', h('h2#over-cam-title.label', WORDS.title)),
    mine, progList, nothing, movieBtn, allBtn, savedHint);

  const code = () => String((S.view && S.view.code) || (app.game && app.game.code) || (app.watchGame && app.watchGame.code) || '').toUpperCase();
  const round = () => (S.view && Number.isFinite(S.view.round) ? S.view.round : (list.list ? list.list.round : null));
  const store = () => (app.cam && typeof app.cam.store === 'function' ? app.cam.store() : null);

  async function countMine() {
    const st = store();
    if (!st || !mineOf(S.view)) { S.rows = []; return; }
    try { S.rows = await st.list(code(), round()); } catch { S.rows = []; }
  }

  function uploader() {
    const st = store();
    if (!st) return null;
    if (S.up) return S.up;
    const cam = camOf(S.view);
    S.up = createUploader({ app, store: st, code: code(), round: round(), mode: cam ? cam.mode : 'highlights' });
    S.up.on('progress', () => paintMine());
    S.up.on('state', () => { paintMine(); list.keepPolling(S.up.state === 'sending'); if (S.up.state !== 'sending') list.poke(); });
    S.up.on('error', () => paintMine());
    return S.up;
  }

  function startUpload() {
    const up = uploader();
    if (!up) return;
    up.run().then(async () => { await countMine(); paintMine(); drive(); });
    paintMine();
  }

  // v1.4.7: the button by hand: on mobile data "Upload now anyway", after the question "Upload now", later on "Upload
  // my clips" (they say they're on wifi now); on wifi it carries on (and still waits if the wifi goes).
  uploadBtn.addEventListener('click', () => {
    const g = S.gate ? S.gate.state : 'go';
    if (S.gate && g === 'wait') S.gate.choose('anyway');
    else if (S.gate && g !== 'go') S.gate.choose('now');
    S.tried = true;
    startUpload();
  });
  laterBtn.addEventListener('click', () => {
    if (S.gate) S.gate.choose('later');
    paintMine();
  });

  // v1.4.7: start (or hold) uploads by themselves as the connection allows; once per opening of the gate
  function drive() {
    if (S.dead || !mineOf(S.view) || !store() || !S.gate) return;
    const h0 = heldOf(S.rows);
    const filming = !!(app.cam && app.cam.state === 'on');
    const sending = !!(S.up && S.up.state === 'sending');
    const what = uploadStep({ state: S.gate.state, left: h0.left, filming, sending, tried: S.tried });
    if (what === 'run') { S.tried = true; startUpload(); } else if (what === 'hold' && S.up) S.up.stop();
  }
  function onGate(state) {
    if (S.dead) return;
    if (state === 'go' && S.gateWas !== 'go') S.tried = false; // wifi again: carry on by itself
    S.gateWas = state;
    paintMine();
    drive();
  }

  delBtn.addEventListener('click', () => {
    openSheet({
      title: 'Delete your clips?',
      body: h('p.cam-sheet-line', WORDS.delAsk),
      actions: [
        {
          label: 'Delete them', kind: 'danger', onClick: async () => {
            if (S.up) S.up.stop();
            const st = store();
            for (const r of S.rows) { try { await st.remove(r.id); } catch { /* ignore */ } }
            await countMine();
            try { await app.video('cam-have', { have: { count: 0, bytes: 0 } }); } catch { /* ignore */ }
            paintMine();
          },
        },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
  });

  // My clips already up in the game (from the list), to take back out.
  const upMine = () => {
    const me = S.view && S.view.me ? S.view.me.id : null;
    return list.list && me ? list.list.clips.filter((c) => c.pid === me).length : 0;
  };

  forgetBtn.addEventListener('click', () => {
    openSheet({
      title: 'Take your clips out?',
      body: h('p.cam-sheet-line', WORDS.forgetAsk),
      actions: [
        {
          label: 'Take them out', kind: 'danger', onClick: async () => {
            if (S.up) S.up.stop();
            try {
              await app.video('cam-forget', {});
              app.banner(WORDS.forgot, 'info', 4000);
            } catch (e) {
              app.banner(e && e.message ? e.message : "That didn't work. Try again.", 'warn', 5000);
            }
            list.poke();
          },
        },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
  });

  movieBtn.addEventListener('click', () => openMovie());
  allBtn.addEventListener('click', () => openAll());

  function paintMine() {
    const show = mineOf(S.view) && !!store();
    mine.hidden = !show;
    if (!show) return;
    const h0 = heldOf(S.rows);
    const up = S.up;
    const sending = up && up.state === 'sending';
    const still = !!(app.cam && app.cam.state === 'on');
    text(mineTitle, h0.count ? `Your clips: ${h0.count}, ${fmtMB(h0.bytes)}` : still ? 'Saving your clips...' : WORDS.none);
    const left = h0.left;
    uploadBtn.hidden = !h0.count || (!left && !sending);
    // (The camera films 20 s past the end: the last clip is waited for first.)
    const filming = !!(app.cam && app.cam.state === 'on');
    uploadBtn.disabled = !!sending || filming;
    // v1.4.7: what the connection allows (go / wait for wifi / ask once / later on wifi) and the time left
    const g = S.gate ? S.gate.state : 'go';
    const idle = (h0.left < h0.count ? WORDS.again : WORDS.upload);
    text(uploadBtn.querySelector('span'), sending ? 'Uploading...' : filming ? 'Saving the last clip...'
      : g === 'wait' ? NET_WORDS.anyway : g === 'ask' ? NET_WORDS.now : idle);
    text(wifi, sending ? WORDS.wifi : g === 'wait' ? NET_WORDS.waiting(left) : g === 'ask' ? NET_WORDS.ask(fmtMB(h0.leftBytes || h0.bytes))
      : g === 'later' ? NET_WORDS.laterLine : WORDS.wifi);
    cls(wifi, 'net', !sending && g !== 'go');
    // (waiting for wifi is the calm choice: "Upload now anyway" is the quieter button then)
    cls(uploadBtn, 'primary', sending || g !== 'wait');
    cls(uploadBtn, 'ghost', !sending && g === 'wait');
    wifi.hidden = !left;
    laterBtn.hidden = !left || !!sending || g !== 'ask';
    const until = untilOf({ view: S.view, list: list.list });
    const lw = leftWords(until);
    leftLine.hidden = !left || !Number.isFinite(until);
    text(leftLine, lw ? NET_WORDS.left(lw) : NET_WORDS.gone);
    delBtn.hidden = !h0.count || !!sending;
    forgetBtn.hidden = !upMine() || !!sending;
    bar.hidden = !sending;
    if (up) {
      const p = up.progress;
      const pct = p.totalBytes ? Math.round(((p.bytes + (p.sentNow || 0)) / p.totalBytes) * 100) : 0;
      bar.setAttribute('aria-valuenow', String(Math.min(100, pct)));
      bar.firstChild.style.width = `${Math.min(100, pct)}%`;
      if (sending) text(upLine, `Sending ${Math.min(p.done + 1, p.total)} of ${p.total}...`);
      else if (up.state === 'done') text(upLine, WORDS.allUp);
      else text(upLine, up.message || '');
    } else {
      text(upLine, h0.count && !left ? WORDS.allUp : '');
    }
    cls(upLine, 'warn', !!(up && (up.state === 'refused' || up.state === 'stopped')));
  }

  function paintAll() {
    const v = S.view;
    const cam = camOf(v);
    el.hidden = !cam;
    if (!cam) return;
    paintMine();
    const l = list.list;
    const rows = l ? l.progress : cam.filmed.map((pid) => ({ pid, done: 0, have: null }));
    fill(progList, rows.map((r) => {
      const name = nameIn(v, r.pid);
      const team = teamIn(v, r.pid);
      return h('li.cam-prog-row', face({ name, src: app.faces && app.faces.get(r.pid), team, size: 28 }),
        h('span.cam-prog-text', progressWords(r, name)));
    }));
    if (!rows.length) fill(progList, h('li.cam-prog-row', h('span.cam-prog-text', 'Nobody was filmed in this game.')));
    const any = !!(l && l.clips.length);
    nothing.hidden = any || !rows.length;
    movieBtn.hidden = !any;
    // v1.4 PAGE-REEL: the movie moved to the end screen's Movies card (Highlights, The whole game)
    movieBtn.hidden = true;
    // v1.4 end PAGE-REEL
    allBtn.hidden = !any;
    savedHint.hidden = !any;
  }

  // ---- Download the movie ----

  function openMovie() {
    const l = list.list;
    if (!l || !l.clips.length) return;
    if (!canMakeMovie(globalThis.window)) {
      openSheet({ title: WORDS.movie, body: h('p.cam-sheet-line', WORDS.movieCant), actions: [{ label: 'OK', kind: 'primary' }] });
      return;
    }
    const summary = S.view && S.view.summary;
    // v1.4: the same scene reels as Watch the highlights / Watch the whole game (scenes.js: whole messages, J-cuts,
    // an intro and an outro), made by render.js. The old movieParts path is no longer used for files.
    const reelOf = (kind) => reelScenes({ summary: summary || {}, clips: l.clips, talk: summary && summary.radio, kind });
    const hi = reelOf('highlights');
    const short = { reel: hi, totalMs: hi.ms };
    const wr = l.mode === 'everything' ? reelOf('whole') : null;
    const long = wr ? { reel: wr, totalMs: wr.ms, capped: false } : null;
    let whole = false;
    const lenLine = (p) => `About ${Math.max(1, Math.round(p.totalMs / 60000))} min`;
    const choice = long && long.totalMs > short.totalMs + 30000
      ? h('div.seg.cam-movie-pick', { role: 'radiogroup', 'aria-label': 'Which movie' },
        ...[['The best parts', short, false], [long.capped ? 'The longest cut' : 'The whole game', long, true]].map(([words, p, w]) => {
          // A whole game longer than WHOLE_MOST_MS is cut to its busiest part: a longer file doesn't fit on a phone.
          const sub = w && p.capped ? `${lenLine(p)}, the most a phone can hold` : lenLine(p);
          const b = h('button', { type: 'button', role: 'radio', 'aria-checked': w ? 'false' : 'true' },
            h('span.seg-main', words), h('span.seg-sub', sub));
          b.addEventListener('click', () => {
            whole = w;
            for (const x of b.parentNode.children) x.setAttribute('aria-checked', x === b ? 'true' : 'false');
          });
          return b;
        }))
      : h('p.cam-sheet-line', `${lenLine(short)}. It plays through once while it's made.`);
    const sheet = openSheet({
      title: WORDS.movie,
      body: [choice, h('p.cam-sheet-line.muted', WORDS.movieKeep)],
      actions: [
        { label: 'Make the movie', kind: 'primary', onClick: () => makeMovie(whole ? long.reel : short.reel) },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
    return sheet;
  }

  async function makeMovie(reel) {
    const summary = S.view && S.view.summary;
    const ctrl = new AbortController();
    const line = h('p.cam-sheet-line', { role: 'status', 'aria-live': 'polite' }, 'Getting the clips...');
    const fillEl = h('span.cam-bar-fill');
    const barEl = h('div.cam-bar', { role: 'progressbar', 'aria-label': 'Making your movie', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fillEl);
    const preview = h('div.cam-movie-preview');
    const sheet = openSheet({
      title: 'Making your movie',
      body: [line, barEl, h('p.cam-sheet-line.muted', WORDS.movieKeep), preview],
      dismissable: false,
      actions: [{ label: 'Cancel', kind: 'ghost', onClick: () => ctrl.abort() }],
    });
    try { app.alerts && app.alerts.keepAwake && app.alerts.keepAwake(true, 'movie'); } catch { /* ignore */ }
    let result = null;
    try {
      result = await renderReel({
        app,
        reel,
        summary,
        ring: S.view && S.view.ring,
        code: code(),
        signal: ctrl.signal,
        onProgress: ({ at, total, paused }) => {
          const pct = total ? Math.min(100, Math.round((at / total) * 100)) : 0;
          fillEl.style.width = `${pct}%`;
          barEl.setAttribute('aria-valuenow', String(pct));
          text(line, paused ? WORDS.moviePaused : `Making your movie: ${fmtClock(at)} of ${fmtClock(total)}`);
        },
      });
    } catch (e) {
      try { sheet.close(); } catch { /* ignore */ }
      if (!(e && e.name === 'AbortError')) app.banner(e && e.message ? e.message : "The movie didn't work. Try again.", 'warn', 6000);
      return;
    } finally {
      try { app.alerts && app.alerts.keepAwake && app.alerts.keepAwake(false, 'movie'); } catch { /* ignore */ }
    }
    try { sheet.close(); } catch { /* ignore */ }
    offerFile(result);
  }

  // Share (a phone that can share files) or Save (a download link).
  function offerFile({ blob, type, name }) {
    const url = URL.createObjectURL(blob);
    let file = null;
    try { file = new File([blob], name, { type }); } catch { file = null; }
    const canShare = !!(file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
    const save = h('a.btn.wide.cam-save', { href: url, download: name }, icon('pin', 20), h('span', 'Save'));
    const actions = [];
    if (canShare) {
      actions.push({
        label: 'Share', kind: 'primary', keepOpen: true, onClick: async () => {
          try { await navigator.share({ files: [file], title: name }); } catch { /* cancelled */ }
        },
      });
    }
    actions.push({ label: 'Done', kind: canShare ? 'ghost' : '' });
    openSheet({
      title: 'Your movie is ready',
      body: [h('p.cam-sheet-line', `${name}, ${fmtMB(blob.size)}`), save],
      actions,
      onClose: () => setTimeout(() => URL.revokeObjectURL(url), 60000),
    });
    if (!canShare) save.classList.add('primary');
    S.lastMovie = { url, name, size: blob.size, type };
    el.dataset.movie = String(blob.size);
    el.dataset.movieType = type;
  }

  // ---- Download all clips ----

  async function saveClip(clip) {
    const got = await urls.get([clip.id]);
    const url = got[clip.id];
    if (!url) { app.banner("That clip didn't download. Try again.", 'warn', 4000); return; }
    const ext = clip.type === 'video/mp4' ? 'mp4' : 'webm';
    const name = `Night Ops ${code()} ${fmtClock(clip.start).replace(':', '-')} ${nameIn(S.view, clip.pid)}.${ext}`;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = h('a', { href, download: name, hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
    } catch {
      urls.forget(clip.id);
      app.banner("That clip didn't download. Try again.", 'warn', 4000);
    }
  }

  function openAll() {
    const l = list.list;
    if (!l || !l.clips.length) return;
    const rows = l.clips.map((c) => {
      const btn = h('button.btn.small.cam-clip-save', { type: 'button', 'aria-label': `Save ${clipLabel(c, nameIn(S.view, c.pid))}` }, 'Save');
      btn.addEventListener('click', async () => { btn.disabled = true; await saveClip(c); btn.disabled = false; });
      return h('li.cam-clip-row', face({ name: nameIn(S.view, c.pid), src: app.faces && app.faces.get(c.pid), team: teamIn(S.view, c.pid), size: 28 }),
        h('span.cam-clip-text', clipLabel(c, nameIn(S.view, c.pid))), btn);
    });
    const actions = [];
    if (isComputer()) {
      actions.push({ label: 'Save all', kind: 'primary', keepOpen: true, onClick: async () => { for (const c of l.clips) await saveClip(c); } });
    }
    actions.push({ label: 'Done', kind: actions.length ? 'ghost' : 'primary' });
    openSheet({ title: WORDS.all, body: h('ul.cam-clip-list', { role: 'list' }, rows), actions, className: 'cam-all-sheet' });
  }

  const off = list.on(() => paintAll());
  // A clip saved after the end screen opened (the camera films 20 s more): counted at once.
  const offClip = app.cam && typeof app.cam.on === 'function'
    ? app.cam.on('clip', () => {
      countMine().then(() => {
        if (S.dead) return;
        paintMine();
        drive();
        // v1.4.7: the others' "Ava: 0 of 3 clips" counts a clip saved after the end screen opened too
        const st = store();
        if (st && mineOf(S.view)) createUploader({ app, store: st, code: code(), round: round() }).tellHave();
      });
    })
    : () => {};
  const offState = app.cam && typeof app.cam.on === 'function' ? app.cam.on('state', () => { if (!S.dead) { paintMine(); drive(); } }) : () => {}; // v1.4.7: drive

  return {
    el,
    held: () => S.rows.length,
    async update(view) {
      if (!view) return;
      S.view = view;
      const key = `${code()}:${round()}`;
      if (camOf(view) && key !== S.key) {
        S.key = key;
        S.up = null;
        // v1.4.7: this round's wifi gate
        if (S.offGate) S.offGate();
        if (S.gate) S.gate.destroy();
        S.gate = createNetGate({ key, nav, storage });
        S.gateWas = S.gate.state;
        S.tried = false;
        S.offGate = S.gate.on(onGate);
        list.start();
        await countMine();
        if (mineOf(view) && store()) {
          // Once when the end screen opens: what this phone holds (the others see "of N").
          const st = store();
          const tell = createUploader({ app, store: st, code: code(), round: round() });
          tell.tellHave();
        }
      }
      paintAll();
      drive(); // v1.4.7
    },
    destroy() {
      S.dead = true;
      off();
      offClip();
      offState();
      if (S.up) S.up.stop();
      if (S.offGate) S.offGate(); // v1.4.7
      if (S.gate) S.gate.destroy();
    },
  };
}

// ---- the replay's video window ----------------------------------------------------------------------------

export function createVideoWindow({ app, slot, urls }) {
  const S = {
    list: [], summary: null, view: null, cuts: [], follow: null, shownId: null, loading: null,
    lastSeek: 0, big: false, dead: false, faces: '', speed: 1, playing: false, showTok: 0,
  };
  const make = () => {
    const v = h('video.cam-v', { playsinline: true, preload: 'auto', crossorigin: 'anonymous' });
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.muted = true;
    return v;
  };
  const A = make();
  const B = make();
  let front = A;
  let back = B;
  B.hidden = true;
  const nameTag = h('span.cam-v-name');
  const none = h('div.cam-v-none', { hidden: true }, icon('camera', 20), h('span', WORDS.noCamera));
  const screen = h('button.cam-v-screen', { type: 'button', 'aria-label': 'Make the video bigger' }, A, B, nameTag, none);
  const facesRow = h('div.cam-v-faces', { role: 'group', 'aria-label': 'Whose camera' });
  const el = h('div.cam-window', { hidden: true }, screen, facesRow);
  if (slot) slot.appendChild(el);

  screen.addEventListener('click', () => {
    S.big = !S.big;
    cls(el, 'big', S.big);
    screen.setAttribute('aria-label', S.big ? 'Make the video smaller' : 'Make the video bigger');
  });

  function recut() {
    if (!S.list.length) { S.cuts = []; return; }
    const from = Math.min(...S.list.map((c) => c.start));
    const to = Math.max(...S.list.map((c) => c.end));
    const sum = S.summary;
    S.cuts = direct({
      clips: S.list, talk: talkOf(sum), moments: sum && sum.cam ? sum.cam.moments : [], routes: sum ? sum.routes : null,
      from, to, follow: S.follow,
    });
  }

  function paintFaces() {
    const cam = S.summary && S.summary.cam;
    const filmed = cam && Array.isArray(cam.filmed) ? cam.filmed : [];
    const sig = `${filmed.join(',')}|${S.follow}|${filmed.map((p) => (app.faces && app.faces.has(p) ? 1 : 0)).join('')}|${S.list.length}`;
    if (sig === S.faces) return;
    S.faces = sig;
    const withClips = new Set(S.list.map((c) => c.pid));
    const auto = h('button.cam-face.cam-auto', { type: 'button', 'aria-pressed': S.follow ? 'false' : 'true' }, 'Auto');
    auto.addEventListener('click', () => api.follow(null));
    const btns = filmed.filter((p) => withClips.has(p)).map((pid) => {
      const name = nameIn({ summary: S.summary, players: S.view && S.view.players }, pid);
      const b = h('button.cam-face', { type: 'button', 'aria-pressed': S.follow === pid ? 'true' : 'false', 'aria-label': `Follow ${name}` },
        face({ name, src: app.faces && app.faces.get(pid), team: teamIn({ summary: S.summary }, pid), size: 32 }));
      b.addEventListener('click', () => api.follow(S.follow === pid ? null : pid));
      return b;
    });
    fill(facesRow, auto, btns);
  }

  function cutAt(clock) {
    return S.cuts.find((c) => clock >= c.from && clock < c.to) || null;
  }

  // tok: the show() it's for (a newer one wins: an old one never changes the element after it).
  async function load(el, id, tok = S.showTok) {
    const got = await urls.get([id]);
    if (tok !== S.showTok) return false;
    const url = got[id];
    if (!url) return false;
    if (el.dataset.id === id && el.src) return true;
    el.dataset.id = id;
    el.src = url;
    el.addEventListener('error', () => { urls.forget(id); if (el.dataset.id === id) el.dataset.id = ''; }, { once: true });
    return true;
  }

  async function show(cut, clock) {
    const clip = S.list.find((c) => c.id === cut.id);
    if (!clip) return;
    if (front.dataset.id === cut.id) return;
    if (S.loading === cut.id) return;
    // Each call has its own token: one overtaken by a newer cut (fast replay, a jump, a follow tap) stops at its next
    // await, so it never swaps in the other's file under its own name.
    S.showTok += 1;
    const tok = S.showTok;
    const stale = () => S.dead || tok !== S.showTok;
    S.loading = cut.id;
    const into = back;
    const ok = await load(into, cut.id, tok);
    if (stale() || !ok) { if (tok === S.showTok) S.loading = null; return; }
    await new Promise((resolve) => {
      if (into.readyState >= 2) { resolve(); return; }
      const done = () => { into.removeEventListener('loadeddata', done); into.removeEventListener('error', done); resolve(); };
      into.addEventListener('loadeddata', done);
      into.addEventListener('error', done);
      setTimeout(done, 6000);
    });
    if (stale() || into !== back || into.dataset.id !== cut.id) { if (tok === S.showTok) S.loading = null; return; }
    S.loading = null;
    const want = fileTimeAt(clip, clock);
    if (want !== null) try { back.currentTime = want; } catch { /* ignore */ }
    try { front.pause(); } catch { /* ignore */ }
    front.hidden = true;
    back.hidden = false;
    [front, back] = [back, front];
    S.shownId = cut.id;
    S.lastSeek = performance.now();
    // The video's own shape (a phone held upright films a tall picture).
    if (front.videoWidth && front.videoHeight) screen.style.aspectRatio = `${front.videoWidth} / ${front.videoHeight}`;
    const name = nameIn({ summary: S.summary, players: S.view && S.view.players }, clip.pid);
    text(nameTag, name);
    nameTag.dataset.team = teamIn({ summary: S.summary }, clip.pid) || '';
    el.dataset.shown = clip.pid;
    el.dataset.why = cut.why;
    // Load the next shot in the hidden one.
    const next = S.cuts.find((c) => c.from >= cut.to && c.id !== cut.id);
    if (next) load(back, next.id, tok);
  }

  const api = {
    el,
    setData({ list, summary, view }) {
      S.list = Array.isArray(list) ? list : [];
      S.summary = summary || null;
      S.view = view || S.view;
      recut();
      el.hidden = !S.list.length;
      paintFaces();
    },
    frame({ clockMs, playing, speed, realTime }) {
      if (S.dead || el.hidden) return;
      S.playing = !!playing;
      const cut = cutAt(clockMs);
      none.hidden = !!cut;
      cls(el, 'dim', !cut);
      if (!cut) {
        try { front.pause(); } catch { /* ignore */ }
        delete el.dataset.shown;
        return;
      }
      if (front.dataset.id !== cut.id) {
        show(cut, clockMs);
        return;
      }
      el.dataset.why = cut.why;
      const clip = S.list.find((c) => c.id === cut.id);
      const want = fileTimeAt(clip, clockMs);
      if (want === null) return;
      const live = playing && (speed === 1 || realTime);
      if (live) {
        front.muted = !!realTime || !!S.forceMute;
        if (Math.abs(front.currentTime - want) > SYNC_S) { try { front.currentTime = want; } catch { /* ignore */ } }
        if (front.paused) {
          const p = front.play();
          if (p && p.catch) p.catch(() => { S.forceMute = true; front.muted = true; front.play().catch(() => {}); });
        }
      } else {
        if (!front.paused) try { front.pause(); } catch { /* ignore */ }
        const now = performance.now();
        if (now - S.lastSeek >= STILL_EVERY_MS || !playing) {
          if (Math.abs(front.currentTime - want) > 0.2) { try { front.currentTime = want; } catch { /* ignore */ } }
          S.lastSeek = now;
        }
      }
    },
    jump(clockMs) {
      const cut = cutAt(clockMs);
      if (!cut) return;
      if (front.dataset.id !== cut.id) { show(cut, clockMs); return; }
      const clip = S.list.find((c) => c.id === cut.id);
      const want = fileTimeAt(clip, clockMs);
      if (want !== null) try { front.currentTime = want; } catch { /* ignore */ }
    },
    follow(pid) {
      S.follow = pid || null;
      recut();
      paintFaces();
    },
    close() {
      try { front.pause(); back.pause(); } catch { /* ignore */ }
    },
    destroy() {
      S.dead = true;
      for (const v of [A, B]) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ } }
      el.remove();
    },
    get cuts() { return S.cuts; },
  };
  return api;
}

// ---- what over.js mounts ----------------------------------------------------------------------------------

export function attachCamParts({ app, videoSlot = null, cardSlot = null, hooks = null }) {
  const list = createList(app);
  const urls = createUrls(app);
  const card = clipsCard({ app, list, urls });
  const win = videoSlot ? createVideoWindow({ app, slot: videoSlot, urls }) : null;
  if (cardSlot) cardSlot.appendChild(card.el);
  let view = null;
  const offList = list.on((l) => { if (win) win.setData({ list: l.clips, summary: view && view.summary, view }); });
  const added = [];
  if (hooks && win) {
    const push = (name, fn) => { if (Array.isArray(hooks[name])) { hooks[name].push(fn); added.push([name, fn]); } };
    push('frame', (f) => win.frame(f));
    push('jump', (f) => win.jump(f && Number.isFinite(f.clockMs) ? f.clockMs : 0));
    push('close', () => win.close());
    push('open', (f) => {
      if (!camOf(view)) return;
      list.poke();
      if (f && Number.isFinite(f.clockMs)) win.jump(f.clockMs);
    });
  }
  return {
    update(v) {
      view = v;
      if (!camOf(v)) {
        card.el.hidden = true;
        if (win) win.el.hidden = true;
        return;
      }
      card.update(v);
      if (win && list.list) win.setData({ list: list.list.clips, summary: v.summary, view: v });
    },
    destroy() {
      offList();
      list.destroy();
      card.destroy();
      if (win) win.destroy();
      if (hooks) for (const [name, fn] of added) { const i = hooks[name].indexOf(fn); if (i >= 0) hooks[name].splice(i, 1); }
    },
    // This round has clips (up, or on this phone): Play again warns first.
    hasClips() {
      return !!(list.list && list.list.clips.length) || card.held() > 0;
    },
    card,
    win,
    list,
  };
}

// ---- the game screen's parts ------------------------------------------------------------------------------
// gameCamParts({ app }) -> { hud, recordPart(role) -> { el, main, order } | null, menuRow(makeRow, later), update(view),
// destroy() }. hud goes in the HUD's slot: a red REC dot while filming, else "Tap to start your camera" (or what's
// wrong). Record this keeps a clip of the last 10 s and the next 20 s. All of it only for a filmed player.

export function filmedNow(view) {
  return !!(view && view.phase === 'live' && view.cam && view.cam.ok === true);
}

export function gameCamParts({ app }) {
  const cam = app && app.cam;
  const S = { view: null, dead: false, flash: 0 };
  const dot = h('span.cam-rec', { hidden: true, role: 'img', 'aria-label': 'Filming' }, h('span.cam-rec-dot', { 'aria-hidden': 'true' }), h('span.cam-rec-word', { 'aria-hidden': 'true' }, 'REC'));
  const chip = h('button.cam-start', { type: 'button', hidden: true }, icon('camera', 18), h('span.cam-start-word', 'Camera'));
  // v1.4 PAGE-DEVICES: a red "REC off" / "Mic off" chip when the shared stream isn't working (a tap turns it back on,
  // or opens the help screen when it's blocked)
  const media = app && app.media;
  const offChip = h('button.fx-chip', { type: 'button', hidden: true }, h('span.fx-chip-dot', { 'aria-hidden': 'true' }), h('span.fx-chip-word'));
  offChip.addEventListener('click', () => {
    if (!media) return;
    const st = media.state;
    const part = st.cam === 'denied' ? 'camera' : st.mic === 'denied' ? 'mic' : null;
    // v1.6.2 PERMS: blocked -> ask the browser from this tap; the steps only when it can't ask again
    if (part) allowFromTap(part);
    else media.restore();
  });
  function allowFromTap(part) {
    askPart(part).then((a) => {
      if (S.dead || !a) return;
      if (a.blocked || a.result === 'unavailable') {
        import('../ui/fixit.js?v=176').then((m) => m.openHelp({ part, why: a.why || 'denied', perm: a.blocked ? 'denied' : null, onTry: () => media.restore().then((x) => (x ? 'Working.' : 'Still not working.')) })).catch(() => {});
      } else if (a.result !== 'granted') app.banner(answerText(a), 'warn', 6000);
    });
  }
  // v1.4 end PAGE-DEVICES
  const hud = h('span.cam-hud', dot, chip, offChip);
  const recordBtn = h('button.btn.cam-mark', { type: 'button', 'aria-label': 'Record this: keep a clip of right now' },
    icon('camera', 22), h('span.cam-mark-word', 'Record this'));
  const markLine = h('span.cam-mark-line.sr-only', { role: 'status', 'aria-live': 'polite' });
  recordBtn.appendChild(markLine);

  chip.addEventListener('click', () => {
    if (!cam) return;
    // v1.6.2 PERMS: blocked -> the browser's own Allow box from this tap (a yes starts the camera: app.allowed)
    if (cam.state === 'denied') { allowFromTap('camera'); return; }
    cam.start();
    paint();
  });
  recordBtn.addEventListener('click', () => {
    if (!cam) return;
    if (cam.state !== 'on') {
      if (cam.state === 'denied') { allowFromTap('camera'); return; } // v1.6.2 PERMS
      cam.start();
      paint();
      return;
    }
    if (cam.mark()) {
      try { app.alerts && app.alerts.buzz && app.alerts.buzz('tap'); } catch { /* ignore */ }
      text(markLine, WORDS_GAME.marked);
      recordBtn.classList.add('marked');
      clearTimeout(S.flash);
      S.flash = setTimeout(() => { recordBtn.classList.remove('marked'); text(markLine, ''); }, 1500);
    }
  });

  function paint() {
    const v = S.view;
    const filmed = !!cam && filmedNow(v);
    const st = cam ? cam.state : 'unsupported';
    const on = filmed && st === 'on';
    dot.hidden = !on;
    const words = { off: 'Tap to start your camera', asking: 'Starting the camera...', denied: 'Camera blocked. Tap to allow it.', full: 'Your phone is full, so filming stopped.' }[st];
    const short = { off: 'Start camera', asking: 'Camera...', denied: 'Allow camera', full: 'Phone full' }[st];
    chip.hidden = !filmed || !words || cam.stoppedHere;
    if (words) {
      text(chip.querySelector('.cam-start-word'), short);
      chip.setAttribute('aria-label', words);
    }
    chip.dataset.state = st;
    chip.disabled = st === 'asking';
    recordBtn.hidden = !filmed || st === 'stopped' || st === 'full' || st === 'done' || cam.stoppedHere;
    // Not filming yet (the browser wanted a tap, or it's blocked): this button starts the camera too.
    recordBtn.dataset.state = st;
    recordBtn.setAttribute('aria-label', on ? 'Record this: keep a clip of right now' : (words || 'Tap to start your camera'));
    // v1.4 PAGE-DEVICES
    const ms = media ? media.state : null;
    const live = !!(v && v.phase === 'live' && v.me && v.me.status === 'in');
    let off = '';
    // (a camera that isn't on keeps the v1.2 chip, "Start camera", whose tap asks media.js again)
    if (ms && live && filmed && st === 'on' && !cam.stoppedHere && ms.cam !== 'ok' && ms.cam !== 'na') off = 'REC off';
    else if (ms && live && ['denied', 'off', 'silent', 'none'].includes(ms.mic)) off = ms.mic === 'denied' ? 'Mic blocked' : 'Mic off';
    offChip.hidden = !off;
    if (off) {
      text(offChip.querySelector('.fx-chip-word'), off);
      offChip.setAttribute('aria-label', /blocked/.test(off) ? `${off}. Tap to allow it.` : `${off}. Tap to turn it back on.`);
      dot.hidden = true;
    }
    // v1.4 end PAGE-DEVICES
  }

  const offState = cam ? cam.on('state', () => { if (!S.dead) paint(); }) : () => {};
  const offMedia = media && media.on ? media.on('state', () => { if (!S.dead) paint(); }) : () => {}; // v1.4 PAGE-DEVICES
  if (cam && typeof cam.attach === 'function') cam.attach(true);

  return {
    hud,
    recordPart(role) {
      if (!cam) return null;
      return { el: recordBtn, main: role === 'hunter', order: 30 };
    },
    // A menu row (the game screen's own row maker): "Stop filming", asking first.
    menuRow(makeRow, later = (fn) => fn) {
      if (!cam || !filmedNow(S.view) || cam.stoppedHere || cam.state === 'done') return null;
      return makeRow('camera', 'Stop filming', 'For the rest of this game', later(() => {
        openSheet({
          title: 'Stop filming?',
          body: h('p.cam-sheet-line', 'Your camera stops for the rest of this game. Clips already made stay on your phone.'),
          actions: [
            { label: 'Stop filming', kind: 'danger', onClick: () => { cam.stopRecording(); paint(); app.banner(WORDS_GAME.stopped, 'info', 4000); } },
            { label: 'Keep filming', kind: 'ghost' },
          ],
        });
      }));
    },
    update(view, screenRoot = null) {
      S.view = view;
      paint();
      // The pocket-mode tip ("Don't lock your phone") says locking stops the camera too.
      if (screenRoot && filmedNow(view) && !S.tipped) {
        const tip = screenRoot.querySelector('.g-tip-text');
        if (tip) {
          S.tipped = true;
          tip.appendChild(h('span.cam-tip', ' Locking it stops your camera too.'));
        }
      }
    },
    destroy() {
      S.dead = true;
      clearTimeout(S.flash);
      offState();
      offMedia(); // v1.4 PAGE-DEVICES
      if (cam && typeof cam.attach === 'function') cam.attach(false);
    },
  };
}

const WORDS_GAME = {
  deniedLong: "Night Ops can't use the camera. Allow the camera and microphone for this site in your browser's settings, then tap again.",
  marked: 'Saving this moment.',
  stopped: 'Filming stopped for this game.',
};
