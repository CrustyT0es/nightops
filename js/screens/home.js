// Night Ops: the home screen. Who you are (name + optional selfie), then Create a game or Join one with a
// 6-letter code (typed, pasted, or from an invite link). A "How to play" sheet, and a note about location.
// There's no game yet, so this screen renders from the App (app.me, app.args, app.savedGame), not a view.
import { h, fill, face, text, listen } from '../dom.js?v=167';
import { icon } from '../ui/icons.js?v=167';
import { openSheet } from '../ui/sheet.js?v=167';
import { linkSheet, linkedPc } from '../pcedit.js?v=167'; // v1.5: the PC edit
import { pickFace } from '../face.js?v=167';
import { cleanName } from '../identity.js?v=167';
import { normalizeCode } from '../app.js?v=167';
import { LIMITS, TIMING, fmtClock } from '../../shared/rules.js?v=167';

const NS = 'http://www.w3.org/2000/svg';

// A code from whatever was typed or pasted: an invite link, "Join my game: WYKUSX", "wyk-usx", or a few letters
// on the way to six. Upper case, no spaces or dashes, at most 6 letters.
export function codeFrom(raw) {
  const s = String(raw ?? '');
  if (/[?#&]code=/i.test(s)) {
    const c = normalizeCode(s);
    if (c) return c;
  }
  const plain = s.toUpperCase().replace(/[\s\-_.]/g, '');
  if (/^[A-Z0-9]{0,6}$/.test(plain)) return plain;
  // Longer pasted text: a 6-letter word written in capitals ("WYKUSX", "WYK-USX") is the code.
  const words = s.replace(/\b([A-Z0-9]{3})[\s-]([A-Z0-9]{3})\b/g, '$1$2').split(/[^A-Za-z0-9]+/).reverse();
  const hit = words.find((w) => /^[A-Z0-9]{6}$/.test(w) && /[A-Z]/.test(w));
  if (hit) return hit;
  return plain.replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function svg(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// The Night Ops mark: a crosshair whose ring is half hunter red, half hider blue.
function emblem(size = 64) {
  const s = svg('svg', { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'home-emblem' });
  s.appendChild(svg('path', { d: 'M32 6 A26 26 0 0 0 32 58', fill: 'none', stroke: 'var(--hunter)', 'stroke-width': 4, 'stroke-linecap': 'round' }));
  s.appendChild(svg('path', { d: 'M32 6 A26 26 0 0 1 32 58', fill: 'none', stroke: 'var(--hider)', 'stroke-width': 4, 'stroke-linecap': 'round' }));
  s.appendChild(svg('circle', { cx: 32, cy: 32, r: 11, fill: 'none', stroke: 'var(--text-2)', 'stroke-width': 2, opacity: 0.6 }));
  s.appendChild(svg('path', { d: 'M32 0v14M32 50v14M0 32h14M50 32h14', stroke: 'var(--text)', 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
  s.appendChild(svg('circle', { cx: 32, cy: 32, r: 2.6, fill: 'var(--text)' }));
  return s;
}

// The rules in short, as a sheet (the lobby's info button opens it too).
export function howToPlay() {
  const show = fmtClock(TIMING.OUTSIDE_SHOW_MS);
  const part = (title, ...lines) => h('section.home-how-part', h('h3', title), lines.map((l) => h('p', l)));
  const body = h('div.home-how',
    part('Two teams',
      'Hunters and hiders. About a third of you hunt. In Infection, one person starts as the hunter.',
      'Hiders get a head start to hide before the hunters set off.'),
    part('Pings',
      'Every few minutes, the hunters see a circle on the map for each hider. The hider is somewhere inside it.',
      'Hiders get a warning just before each ping. Near the end, pings come faster and the circles get smaller.',
      "Keep Night Ops open while you play. Locking your phone or switching apps stops sharing your spot, so the pings show an old one. To hide the screen's light, use pocket mode (the moon): the screen goes black and your spot is still shared."),
    part('Tagging',
      'A hunter tags a hider by touching them, then taps Tag on their phone. The hider confirms it on theirs.',
      'In Classic, caught hiders join the hunters (or sit out, if the host picks that).'),
    part('Powers',
      'Hiders: Jammer (skip a ping), Decoy (a fake ping) and Sprint (hide your trail). Hunters: Radar (everyone live for a minute) and Exposure (exact spots). Each one works once a game.'),
    part('The ring',
      `Stay inside the ring the host draws. Step outside for ${show} and the hunters see you live until you're back in, and your phone keeps buzzing.`,
      'In the last minutes the ring can shrink, so keep an eye on it.'),
    part('SOS',
      'Anyone can press SOS. It pauses the game for everyone and shows where you are, so others can come and help.'),
    part('Stay safe',
      'Stay in the ring. No roads, no private property, no climbing fences or going into closed places.',
      "It's dark: watch your step, bring a light, and tell someone at home where you are. If anything feels wrong, press SOS."),
    // v1.3 PAGE-SETUP: Checkpoints
    part('Checkpoints',
      'In Checkpoints, the host puts checkpoints on the map, like stores or a statue. One is open at a time.',
      'Hiders see each new checkpoint a little before the hunters. Go there, do the task and take the photo. Each one counts once.',
      "Inside the open checkpoint you're safe for a few minutes. Stay too long, or go back to one you already did, and the hunters see you.",
      'Only go into the open checkpoint: other stores are off limits. No running or yelling inside stores; hunters wait outside.'),
    // v1.3 end PAGE-SETUP
    part('Who wins',
      'Hiders win if any of them are still free when time runs out. Hunters win by catching everyone.',
      'In Checkpoints, the hider with the most checkpoints wins.'), // v1.3 PAGE-SETUP: the Checkpoints line
    // v1.5.2: every finished game is saved by itself
    part('After the game',
      'Every game is saved for 30 days. Open it any time from Your games on the home screen: the replay, the movies, the walkie-talkie and the photos.'));
  openSheet({ title: 'How to play', body, actions: [{ label: 'Got it', kind: 'primary' }], className: 'home-how-sheet' });
}

// v1.4 Your games: one remembered game as words: { title, line, keep } (dates in the phone's own words).
const MODE_WORDS = { classic: 'Manhunt', infection: 'Infection', checkpoints: 'Checkpoints' };
const dayOf = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const dayTimeOf = (t) => `${dayOf(t)}, ${new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
export function pastLines(g, fmt = dayOf, when = fmt === dayOf ? dayTimeOf : fmt) {
  const date = when(g.when); // the time too: two rounds of one evening look different
  const title = `${MODE_WORDS[g.mode] || 'Manhunt'} · ${date}`;
  const role = g.role === 'watched' ? 'You watched' : g.role ? `You were a ${g.role}` : '';
  const line = [g.result, role].filter(Boolean).join(' · ');
  let keep = '';
  if (Number.isFinite(g.kept)) keep = `Saved until ${fmt(g.kept)}`; // v1.5.2: every finished round is saved 30 days
  else if (Number.isFinite(g.until)) keep = `Deleted after ${when(g.until)}`;
  return { title, line, keep };
}

// v1.6: the home screen's tagline sticker, a different one each time
export const TAGLINES = [
  'hide and seek, but your phone snitches',
  'cardio, but make it sneaky',
  'touch grass. run from friends.',
  'the bushes are your best friend now',
  'your mom thinks you\'re at a sleepover',
  'trust nobody. especially Sergio.',
  'they can see you. probably.',
];

export function mount(root, app, args = {}) {
  const S = {
    destroyed: false,
    busy: null,            // 'create' | 'join' | null
    face: null,            // the selfie on show (first-time form)
    offs: [],
  };
  const me0 = app.me || null;
  const known = !!(me0 && me0.name);
  S.face = me0 && me0.face ? me0.face : null;
  const startCode = codeFrom((args && args.code) || app.linkCode || '');
  const fromLink = !!startCode && !!(args && (args.join || args.code));

  // ---- who you are ----

  const nameInput = h('input#home-name.field.home-name', {
    type: 'text',
    autocomplete: 'nickname',
    autocapitalize: 'words',
    spellcheck: 'false',
    enterkeyhint: 'done',
    maxlength: String(LIMITS.name),
    placeholder: 'Your name',
    'aria-describedby': 'home-name-hint home-name-error',
    value: known ? me0.name : (me0 && me0.name) || '',
  });
  const nameError = h('p#home-name-error.home-error', { role: 'alert' });
  const facePlace = h('span.home-face');
  const selfieBtn = h('button.btn.small.home-selfie', { type: 'button' });
  const removeBtn = h('button.btn.small.ghost.home-selfie-remove', { type: 'button' }, 'Remove');

  function typedName() {
    return cleanName(nameInput.value);
  }

  function drawFace() {
    const name = known ? app.me?.name : typedName();
    const src = known ? app.me?.face : S.face;
    fill(facePlace, face({ name: name || '?', src, size: known ? 52 : 72, extra: 'home-face-pic' }));
    if (!known) {
      fill(selfieBtn, icon('camera', 20), S.face ? 'New selfie' : 'Add a selfie');
      removeBtn.hidden = !S.face;
    }
  }

  async function takeSelfie() {
    const data = await pickFace();
    if (S.destroyed || !data) return;
    S.face = data;
    app.saveMe({ name: typedName(), face: S.face });
    drawFace();
  }

  function showNameError(msg) {
    text(nameError, msg);
    nameInput.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) {
      try { nameInput.focus({ preventScroll: false }); } catch { nameInput.focus(); }
    }
  }

  let youCard;
  const nameRow = h('span.home-you-name');
  if (!known) {
    selfieBtn.addEventListener('click', () => takeSelfie());
    removeBtn.addEventListener('click', () => {
      S.face = null;
      app.saveMe({ name: typedName(), face: null });
      drawFace();
      selfieBtn.focus();
    });
    nameInput.addEventListener('input', () => {
      if (nameInput.getAttribute('aria-invalid') === 'true' && typedName()) showNameError('');
      drawFace();
    });
    nameInput.addEventListener('change', () => {
      const name = typedName();
      if (name || S.face) app.saveMe({ name, face: S.face });
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
    });
    youCard = h('section.home-card.home-you', { 'aria-labelledby': 'home-you-title' },
      h('h2#home-you-title.label', 'You'),
      h('div.home-you-top',
        facePlace,
        h('div.home-you-pic', selfieBtn, removeBtn,
          h('p.home-hint', 'Optional. Without one, your first letter shows.'))),
      h('label.home-field-label', { for: 'home-name' }, 'Your name'),
      nameInput,
      h('p#home-name-hint.home-hint', 'Friends see it on the map and in the chat.'),
      nameError);
  } else {
    const editBtn = h('button.btn.small.home-edit', { type: 'button', 'aria-label': 'Edit your name and selfie' }, 'Edit');
    editBtn.addEventListener('click', () => editMe(editBtn));
    youCard = h('section.home-card.home-you.known', { 'aria-labelledby': 'home-you-title' },
      facePlace,
      h('div.home-you-text', h('h2#home-you-title.label', 'Playing as'), nameRow),
      editBtn);
    text(nameRow, me0.name);
  }

  // The edit sheet for a name and selfie that are already saved.
  function editMe(opener) {
    const cur = app.me || {};
    let pic = cur.face || null;
    const input = h('input#home-edit-name.field', {
      type: 'text', autocomplete: 'nickname', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'done',
      maxlength: String(LIMITS.name), value: cur.name || '', 'aria-describedby': 'home-edit-error',
    });
    const err = h('p#home-edit-error.home-error', { role: 'alert' });
    const preview = h('span.home-face');
    const take = h('button.btn.small', { type: 'button' });
    const drop = h('button.btn.small.ghost', { type: 'button' }, 'Remove');
    const draw = () => {
      fill(preview, face({ name: cleanName(input.value) || '?', src: pic, size: 72, extra: 'home-face-pic' }));
      fill(take, icon('camera', 20), pic ? 'New selfie' : 'Add a selfie');
      drop.hidden = !pic;
    };
    take.addEventListener('click', async () => {
      const data = await pickFace();
      if (!data) return;
      pic = data;
      draw();
    });
    drop.addEventListener('click', () => { pic = null; draw(); take.focus(); });
    input.addEventListener('input', () => { draw(); if (cleanName(input.value)) text(err, ''); });
    const save = (close) => {
      const name = cleanName(input.value);
      if (!name) {
        text(err, 'Type your name first.');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      app.saveMe({ name, face: pic });
      close();
      if (!S.destroyed) {
        text(nameRow, name);
        drawFace();
        try { opener.focus(); } catch { /* gone */ }
      }
    };
    let sheet = null;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (sheet) save(sheet.close); }
    });
    draw();
    sheet = openSheet({
      title: 'Your name and selfie',
      body: h('div.home-edit',
        h('div.home-you-top', preview, h('div.home-you-pic', take, drop)),
        h('label.home-field-label', { for: 'home-edit-name' }, 'Your name'),
        input,
        err),
      actions: [{ label: 'Save', kind: 'primary', keepOpen: true, onClick: (close) => save(close) }],
    });
  }

  // ---- create or join ----

  const createBtn = h('button.btn.primary.wide.home-create', { type: 'button' }, icon('target', 22), h('span', 'Create a game'));
  const codeInput = h('input#home-code.field.home-code', {
    type: 'text',
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    placeholder: 'ABC123',
    'aria-describedby': 'home-code-hint home-join-error',
    value: startCode,
  });
  const joinBtn = h('button.btn.home-join-btn', { type: 'button' }, 'Join');
  const joinError = h('p#home-join-error.home-error', { role: 'alert' });
  const createError = h('p#home-create-error.home-error', { role: 'alert' });
  createBtn.setAttribute('aria-describedby', 'home-create-error');
  if (fromLink) createBtn.classList.remove('primary'); // the link's Join is the main thing here
  // v1.1 PAGE-WATCH: a ?watch= link's code (its Watch button is the main thing then)
  const watchCode = codeFrom((args && args.watch) || '');
  const fromWatch = watchCode.length === 6;
  if (fromWatch) createBtn.classList.remove('primary');
  // v1.1 end PAGE-WATCH

  function cleanCodeBox() {
    const before = codeInput.value;
    const after = codeFrom(before);
    if (after !== before) codeInput.value = after;
    joinBtn.classList.toggle('ready', after.length === 6);
  }
  codeInput.addEventListener('input', () => {
    cleanCodeBox();
    if (codeInput.getAttribute('aria-invalid') === 'true') {
      codeInput.setAttribute('aria-invalid', 'false');
      text(joinError, '');
    }
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); join(); }
  });

  function setBusy(what) {
    S.busy = what;
    createBtn.disabled = !!what;
    joinBtn.disabled = !!what;
    createBtn.setAttribute('aria-busy', what === 'create' ? 'true' : 'false');
    joinBtn.setAttribute('aria-busy', what === 'join' ? 'true' : 'false');
    fill(createBtn, icon('target', 22), h('span', what === 'create' ? 'Creating...' : 'Create a game'));
    text(joinBtn, what === 'join' ? 'Joining...' : 'Join');
  }

  // The name and selfie to send, or null (with the name box marked) when there's no name yet.
  function who() {
    if (known) {
      const m = app.me || {};
      if (m.name) return {};
      // The saved name went missing (storage cleared): ask for it again.
      editMe(createBtn);
      return null;
    }
    const name = typedName();
    if (!name) {
      showNameError('Type your name first.');
      return null;
    }
    showNameError('');
    return { name, face: S.face };
  }

  async function create() {
    if (S.busy) return;
    text(createError, '');
    const opts = who();
    if (!opts) return;
    setBusy('create');
    let res;
    try {
      res = await app.create({ ...opts, quiet: true });
    } catch (e) {
      res = { error: { message: e && e.message } };
    }
    if (S.destroyed) return;
    setBusy(null);
    if (res && res.error) {
      text(createError, res.offline ? 'No connection. Check your signal and try again.' : res.message || res.error.message || "That didn't work. Try again.");
    }
  }

  async function join() {
    if (S.busy) return;
    text(joinError, '');
    const code = codeFrom(codeInput.value);
    codeInput.value = code;
    if (code.length !== 6) {
      codeInput.setAttribute('aria-invalid', 'true');
      text(joinError, code ? 'Game codes have 6 letters and numbers.' : 'Type the game code first.');
      codeInput.focus();
      return;
    }
    const opts = who();
    if (!opts) return;
    setBusy('join');
    let res;
    try {
      res = await app.join(code, { ...opts, quiet: true });
    } catch (e) {
      res = { error: { message: e && e.message } };
    }
    if (S.destroyed) return;
    setBusy(null);
    if (res && res.error) {
      const c = res.code || res.error.code;
      let msg = res.offline ? 'No connection. Check your signal and try again.' : res.message || res.error.message || "That didn't work. Try again.";
      if (c === 'no_game' || c === 'not_found' || c === 'unknown_game' || res.status === 404) {
        msg = `No game found with the code ${code}. Check the letters with the host.`;
      }
      if (!res.offline) codeInput.setAttribute('aria-invalid', 'true');
      text(joinError, msg);
    }
  }

  createBtn.addEventListener('click', () => create());
  joinBtn.addEventListener('click', () => join());

  // v1.1 PAGE-WATCH: watching a game (a spectator: 2 minutes behind, never plays) --------------------------
  // -> Promise<string> the words to show when it didn't work ('' when it did)
  async function startWatching(code) {
    if (S.busy) return '';
    const opts = who();
    if (!opts) return '';
    S.busy = 'watch';
    let res;
    try {
      res = await app.watch(code, { ...opts, quiet: true });
    } catch (e) {
      res = { error: { message: e && e.message } };
    }
    if (S.destroyed) return '';
    S.busy = null;
    if (!res || !res.error) return '';
    const c = res.code || res.error.code;
    if (res.offline) return 'No connection. Check your signal and try again.';
    if (c === 'no_game' || c === 'not_found' || c === 'unknown_game' || res.status === 404) {
      return `No game found with the code ${code}. Check the letters with the host.`;
    }
    return res.message || res.error.message || "That didn't work. Try again.";
  }

  let watchCard = null;
  if (fromWatch) {
    const watchBtn = h('button.btn.primary.wide.home-watch-btn', { type: 'button' }, icon('eye', 22), h('span', `Watch game ${watchCode}`));
    const watchError = h('p#home-watch-error.home-error', { role: 'alert' });
    watchBtn.setAttribute('aria-describedby', 'home-watch-error');
    watchBtn.addEventListener('click', async () => {
      text(watchError, '');
      watchBtn.disabled = true;
      fill(watchBtn, icon('eye', 22), h('span', 'Opening...'));
      const msg = await startWatching(watchCode);
      if (S.destroyed) return;
      watchBtn.disabled = false;
      fill(watchBtn, icon('eye', 22), h('span', `Watch game ${watchCode}`));
      text(watchError, msg);
    });
    watchCard = h('section.home-card.home-watch', { 'aria-label': 'Watch this game' },
      h('span.label', 'Watch a game'),
      watchBtn,
      h('p.home-hint', "You see the game 2 minutes behind, from the side. You don't play and you don't see the chats."),
      watchError);
  }

  // "Watch a game" with a code: a sheet.
  function watchSheet() {
    const box = h('input#home-watch-code.field.home-code', {
      type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off',
      spellcheck: 'false', enterkeyhint: 'go', placeholder: 'ABC123', 'aria-describedby': 'home-watch-sheet-hint home-watch-sheet-error',
      value: codeFrom(codeInput.value),
    });
    const err = h('p#home-watch-sheet-error.home-error', { role: 'alert' });
    box.addEventListener('input', () => {
      const v = codeFrom(box.value);
      if (v !== box.value) box.value = v;
      text(err, '');
      box.setAttribute('aria-invalid', 'false');
    });
    let sheet = null;
    const go = async (close) => {
      const code = codeFrom(box.value);
      box.value = code;
      if (code.length !== 6) {
        box.setAttribute('aria-invalid', 'true');
        text(err, code ? 'Game codes have 6 letters and numbers.' : 'Type the game code first.');
        box.focus();
        return;
      }
      if (!known && !typedName()) {
        close();
        showNameError('Type your name first.');
        return;
      }
      const msg = await startWatching(code);
      if (msg) {
        text(err, msg);
        return;
      }
      close();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (sheet) go(sheet.close); }
    });
    sheet = openSheet({
      title: 'Watch a game',
      body: h('div.home-watch-sheet',
        h('label.home-field-label', { for: 'home-watch-code' }, 'Game code'),
        box,
        h('p#home-watch-sheet-hint.home-hint', "You see the game 2 minutes behind. You don't play and you don't see the chats."),
        err),
      actions: [{ label: 'Watch', kind: 'primary', keepOpen: true, onClick: (close) => go(close) }],
    });
  }
  // v1.1 end PAGE-WATCH ---------------------------------------------------------------------------------

  const joinBox = h('section.home-card.home-join', { 'aria-labelledby': 'home-code-label' },
    h('label#home-code-label.home-field-label', { for: 'home-code' }, fromLink ? 'Join this game' : 'Join a game'),
    h('div.home-join-row', codeInput, joinBtn),
    h('p#home-code-hint.sr-only', 'The 6-letter code from the host. A pasted invite link works too.'), // v1.6: said, not shown
    joinError);

  const createBox = h('section.home-card.home-make', { 'aria-label': 'Create a game' },
    createBtn,
    createError);

  // ---- a game this phone is still in (someone opened an invite to another game) ----

  let savedCard = null;
  if (app.savedGame && app.savedGame.code) {
    const back = h('button.btn.small.home-back', { type: 'button' }, 'Go back to it');
    back.addEventListener('click', () => {
      back.disabled = true;
      Promise.resolve(app.resume()).catch(() => {}).finally(() => { if (!S.destroyed) back.disabled = false; });
    });
    savedCard = h('section.home-card.home-saved', { 'aria-label': 'Your current game' },
      h('div.home-saved-text',
        h('span.label', 'Still in a game'),
        h('p', "You're in game ", h('span.mono.home-saved-code', app.savedGame.code), '. Joining another one leaves it.')),
      back);
  }

  // ---- the page ----

  const howBtn = h('button.btn.ghost.home-how-btn', { type: 'button' }, icon('info', 20), 'How to play');
  howBtn.addEventListener('click', () => howToPlay());
  // v1.1 PAGE-WATCH: "Watch a game"
  const watchOpenBtn = h('button.btn.ghost.home-watch-open', { type: 'button' }, icon('eye', 20), 'Watch a game');
  watchOpenBtn.addEventListener('click', () => watchSheet());
  // v1.1 end PAGE-WATCH
  // v1.5: "Link my PC" (the owner's PC makes a pro edit of every game this phone plays in)
  const pcBtn = h('button.btn.ghost.home-pc-open', { type: 'button' }, icon('link', 20), 'Link my PC');
  pcBtn.addEventListener('click', () => {
    if (typeof app.linkPc !== 'function') return;
    const ui = linkSheet({ linked: linkedPc(), onLink: (code) => app.linkPc(code) });
    openSheet({ title: 'Link my PC', body: ui.el, actions: [{ label: 'Done', kind: 'ghost' }], className: 'pc-link-sheet' });
  });

  // v1.4 Your games: games this phone was in or watched, while the server still has them.
  const gamesCard = h('section.home-card.home-games', { 'aria-labelledby': 'home-games-title', hidden: true });
  async function drawGames() {
    if (typeof app.pastGames !== 'function') return;
    let list = [];
    try { list = await app.pastGames(); } catch { return; }
    if (S.destroyed || !list.length) return;
    const rows = list.map((g) => {
      const w = pastLines(g);
      const btn = h('button.btn.small.home-game-open', { type: 'button', 'aria-label': `Open ${w.title}` }, 'Open');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const ok = await app.openPast(g);
        if (!ok && !S.destroyed) { li.remove(); if (!ul.children.length) gamesCard.hidden = true; }
        btn.disabled = false;
      });
      const rm = h('button.btn.small.ghost.home-game-remove', { type: 'button', 'aria-label': `Remove ${w.title} from this phone` }, 'Remove');
      rm.addEventListener('click', () => {
        try { if (app.identity && app.identity.forgetPast) app.identity.forgetPast(g.code, g.round); } catch { /* ignore */ }
        li.remove();
        if (!ul.children.length) gamesCard.hidden = true;
      });
      const li = h('li.home-game', h('div.home-game-text', h('p.home-game-title', w.title),
        w.line ? h('p.home-hint', w.line) : null, g.pro === 'ready' ? h('p.home-hint.home-game-pro', 'Pro edit ready') : null, w.keep ? h(`p.home-hint.home-game-keep${Number.isFinite(g.kept) ? '.kept' : ''}`, w.keep) : null),
        h('div.home-game-btns', btn, rm));
      return li;
    });
    const ul = h('ul.home-games-list', rows);
    fill(gamesCard, h('h2#home-games-title.label', 'Your games'), ul);
    gamesCard.hidden = false;
  }

  const order = fromLink ? [joinBox, h('p.home-or', h('span', 'or')), createBox] : [createBox, h('p.home-or', h('span', 'or')), joinBox];

  fill(root,
    h('div.home',
      h('header.home-head',
        h('div.home-sky', { 'aria-hidden': 'true' }, h('span.home-moon'), h('span.home-twinkle.t1'), h('span.home-twinkle.t2'), h('span.home-twinkle.t3')),
        h('h1.home-title', h('span.home-t1', 'Night'), ' ', h('span.home-t2', 'Ops')),
        h('p.home-tag', TAGLINES[Math.floor(Math.random() * TAGLINES.length)]),
        h('p.home-line', 'Manhunt in the dark with your friends. Hiders hide, hunters follow the pings on the map.')),
      savedCard,
      youCard,
      watchCard, // v1.1 PAGE-WATCH
      gamesCard, // v1.4 Your games
      order,
      h('footer.home-foot',
        h('div.home-foot-btns', howBtn, watchOpenBtn, pcBtn), // v1.1 PAGE-WATCH: Watch a game beside How to play; v1.5 Link my PC
        h('p.home-note', icon('pin', 18), h('span', 'Night Ops uses your location while a game is on, so the map works. Your phone asks when the game starts.')))));

  drawFace();
  cleanCodeBox();
  drawGames();

  // Start where it helps: the name box when there's no name yet, the code box when a link brought them here.
  setTimeout(() => {
    if (S.destroyed) return;
    const active = document.activeElement;
    if (active && active !== document.body && root.contains(active) && active !== root) return;
    if (!known && !typedName() && fromLink) {
      try { nameInput.focus({ preventScroll: true }); } catch { /* fine */ }
    }
  }, 0);

  S.offs.push(listen(window, 'pageshow', () => { if (!S.destroyed) setBusy(null); }));

  return {
    update() {
      // No game, no view: nothing changes here from the server.
    },
    destroy() {
      S.destroyed = true;
      for (const off of S.offs.splice(0)) off();
    },
  };
}
