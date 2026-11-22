// Night Ops v1.3 (PAGE-SETUP): the checkpoint editor (host only; App screen 'checkpoints'). The big-map frame like
// the ring editor: the map edge to edge with a bar over it (Cancel, "Checkpoints", Save) and a panel under it.
// Tap inside the ring to add a checkpoint (a name, a task, a zone of 20-80 m); tap a spot or its row to change it,
// move it earlier or later, or delete it. "Find stores in the ring" asks OpenStreetMap (js/places.js) and offers
// what it finds as pins and a list. Save sends one { type: 'checkpoints', list }; a refusal says why and stays.
// Nothing here needs the phone's location: "My spot" only centres the map on it when it's allowed.
import { h, fill, text, cls, listen } from '../dom.js?v=160';
import { icon } from '../ui/icons.js?v=160';
import { openSheet, sheetOpen } from '../ui/sheet.js?v=160';
import { createMap } from '../map.js?v=160';
import { findPlaces, KIND_WORDS, SOURCE_WORDS } from '../places.js?v=160';
import { isPoint, ringProblem, outsideByM, distanceM } from '../../shared/geo.js?v=160';
import { LIMITS, CP_TASK_IDEAS, cleanCheckpoints, checkpointProblem, cleanLine } from '../../shared/rules.js?v=160';

const MOST = LIMITS.checkpoints;
const R = LIMITS.cpRadius;
const R_STEP = 5;
const FIND_MS = 15000;
const ID_OK = /^[a-z0-9]{1,8}$/;
const PANEL_OVERLAP = 18;   // px of the map's foot under the panel's rounded top

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

// The next free id like the engine's ('k1', 'k2'...).
export function freeId(list) {
  const taken = new Set((list || []).map((c) => c && c.id));
  let n = 1;
  while (taken.has(`k${n}`)) n++;
  return `k${n}`;
}

// One checkpoint as the editor keeps it (what cleanCheckpoints keeps).
export function entryOf(c) {
  return {
    id: typeof c.id === 'string' && ID_OK.test(c.id) ? c.id : null,
    p: [c.p[0], c.p[1]],
    r: Number.isInteger(c.r) ? c.r : R.start,
    name: typeof c.name === 'string' ? c.name : '',
    task: typeof c.task === 'string' ? c.task : '',
    osm: typeof c.osm === 'string' ? c.osm : null,
  };
}

export function sameList(a, b) {
  try { return JSON.stringify(cleanCheckpoints(a || [])) === JSON.stringify(cleanCheckpoints(b || [])); } catch { return false; }
}

// "1. 7-Eleven, Buy a pack of gum, 35 m"
export function rowWords(c, i) {
  const name = cleanLine(c.name, LIMITS.cpName) || 'No name yet';
  const task = cleanLine(c.task, LIMITS.cpTask);
  return `${i + 1}. ${name}${task ? `, ${task}` : ''}, ${c.r} m`;
}

// A problem with `entry` itself, as a checkpoint of this list (an older problem elsewhere in the list never
// blocks adding or changing this one): its own checks, then too close to another.
export function newProblem(list, entry, ring) {
  const own = checkpointProblem([entry], ring);
  if (own) return own.replace(/^Give checkpoint 1 a name\.$/, 'Give it a name.').replace(/^Checkpoint 1: /, '');
  const name = cleanLine(entry.name, LIMITS.cpName);
  for (const c of list || []) {
    if (!c || c.id === entry.id || !isPoint(c.p)) continue;
    if (distanceM(c.p, entry.p) < LIMITS.cpApartM) {
      return `${name} and ${cleanLine(c.name, LIMITS.cpName)} are too close. Keep checkpoints at least ${LIMITS.cpApartM} m apart.`;
    }
  }
  return '';
}

// Places worth offering: not added already (the same OSM id, or a checkpoint within 20 m).
export function freshPlaces(places, list) {
  return (places || []).filter((pl) => !(list || []).some((c) => (pl.id && c.osm === pl.id) || distanceM(c.p, pl.p) < 20));
}

// ---- the screen -------------------------------------------------------------------------------------------

export function mount(root, app) {
  const view0 = app.view;
  if (!view0 || !view0.me || !view0.me.host || view0.phase !== 'lobby') {
    setTimeout(() => app.go('lobby'), 0);
    fill(root, h('p.cpe-wait', 'Only the host sets up the checkpoints.'));
    return { update() {}, destroy() {} };
  }
  const savedNow = () => {
    const cp = app.view && app.view.cp;
    return cp && Array.isArray(cp.list) ? cp.list.map(entryOf) : [];
  };
  const S = {
    destroyed: false,
    saved: savedNow(),
    list: savedNow(),
    saving: false,
    note: '',            // the hint over the map
    noteWhy: '',
    noteTimer: 0,
    finding: false,
    findCtl: null,
    places: [],
    placesNote: '',
    looked: false,       // the store finder has answered once
    sheet: null,         // { close, key, r }
    draft: null,         // a new checkpoint being made (drawn dashed)
    myPos: null,
    locating: false,
    locTimer: 0,
    startedLoc: false,
    offs: [],
  };
  const ring = () => (app.view && app.view.ring && !ringProblem(app.view.ring) ? app.view.ring : null);

  // ---- the page ----

  const mapBox = h('div.cpe-map-box');
  const hint = h('p.cpe-hint', { role: 'status', 'aria-live': 'polite' });
  const closeBtn = h('button.btn.small.icon-only.cpe-close', { type: 'button', 'aria-label': 'Cancel, back to the lobby' }, icon('close', 22));
  const saveBtn = h('button.btn.small.primary.cpe-save', { type: 'button' });
  const top = h('header.cpe-top', closeBtn, h('h1.cpe-title', 'Checkpoints'), saveBtn);
  const spotBtn = h('button.map-btn.cpe-spot', { type: 'button', 'aria-label': 'My spot: centre the map on me' }, icon('locate', 22));

  const count = h('span.cpe-count.mono');
  const listEl = h('ol.cpe-list', { 'aria-label': 'Your checkpoints' });
  const empty = h('p.cpe-empty', 'No checkpoints yet. Tap the map inside the ring, or find stores below.');
  const problem = h('p.cpe-problem', { 'aria-live': 'polite' });
  const findBtn = h('button.btn.wide.cpe-find', { type: 'button' });
  const findNote = h('p.cpe-find-note', { 'aria-live': 'polite' });
  const source = h('p.cpe-source', SOURCE_WORDS);
  const placesEl = h('ul.cpe-places', { 'aria-label': 'Stores in the ring' });
  const panel = h('div.cpe-panel',
    h('div.cpe-head', h('h2.cpe-head-title', 'Your checkpoints'), count),
    empty, listEl, problem,
    h('div.cpe-finder', findBtn, findNote, placesEl, source));

  mapBox.append(top, hint, spotBtn);
  fill(root, h('div.cpe', mapBox, panel));

  // ---- the map ----

  let map = null;
  try {
    map = createMap(mapBox, { interactive: true });
    const nmap = mapBox.querySelector('.nmap');
    if (nmap) mapBox.prepend(nmap);
    map.onTap((p) => tapMap(p));
    if (typeof map.onSpotTap === 'function') map.onSpotTap((key) => tapSpot(key));
    map.ready.then(() => { if (!S.destroyed) drawMap(); });
  } catch (e) {
    console.error(e);
    map = null;
  }

  // Keyboard: with the map focused, Enter adds a checkpoint in the middle of the map.
  S.offs.push(listen(mapBox, 'keydown', (e) => {
    if (e.key !== 'Enter' || !map) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest('.nmap') || t.closest('button')) return;
    const c = map.getCenter();
    if (isPoint(c)) { e.preventDefault(); tapMap(c); }
  }));

  function say(words, why = '') {
    S.note = words;
    S.noteWhy = why;
    clearTimeout(S.noteTimer);
    if (words && why === 'brief') S.noteTimer = setTimeout(() => { if (!S.destroyed) { S.note = ''; draw(); } }, 4000);
    draw();
  }

  function buzz() { try { app.alerts?.buzz?.('tap'); } catch { /* fine */ } }

  function tapMap(p) {
    if (!isPoint(p) || S.saving || S.sheet) return;
    const r = ring();
    if (!r) { say('Draw the ring first.', 'brief'); buzz(); return; }
    if (outsideByM(r, p) > 0) { say('Checkpoints go inside the ring.', 'brief'); buzz(); return; }
    if (S.list.length >= MOST) { say(`That's the most: ${MOST} checkpoints. Delete one to add another.`, 'brief'); buzz(); return; }
    editSheet(null, { p, name: '', task: '', r: R.start, osm: null });
  }

  function tapSpot(key) {
    if (S.sheet || S.saving) return;
    if (key.startsWith('osm:')) {
      const pl = S.places.find((x) => `osm:${x.id}` === key);
      if (pl) addPlace(pl);
      return;
    }
    const i = S.list.findIndex((c) => c.id === key);
    if (i >= 0) editSheet(i);
  }

  function addPlace(pl) {
    if (S.list.length >= MOST) { say(`That's the most: ${MOST} checkpoints. Delete one to add another.`, 'brief'); return; }
    editSheet(null, { p: pl.p.slice(), name: pl.name, task: '', r: R.start, osm: pl.id });
  }

  // ---- the sheet: a new checkpoint, or one to change ----

  function editSheet(index, fresh = null) {
    const isNew = index === null;
    const base = isNew ? fresh : S.list[index];
    const entry = { ...entryOf({ ...base, id: isNew ? freeId(S.list) : base.id }) };
    const nameIn = h('input#cpe-name.field', {
      type: 'text', maxlength: String(LIMITS.cpName), autocomplete: 'off', enterkeyhint: 'next',
      placeholder: 'A store, a statue...', value: entry.name, ...(entry.name ? {} : { autofocus: '' }),
    });
    const taskIn = h('input#cpe-task.field', {
      type: 'text', maxlength: String(LIMITS.cpTask), autocomplete: 'off', enterkeyhint: 'done',
      placeholder: 'What to do there', value: entry.task,
    });
    const ideas = h('div.cpe-ideas', { role: 'group', 'aria-label': 'Task ideas' }, CP_TASK_IDEAS.map((idea) => {
      const b = h('button.chip.cpe-idea', { type: 'button' }, idea);
      b.addEventListener('click', () => { taskIn.value = idea; entry.task = idea; taskIn.focus(); });
      return b;
    }));
    const zoneValue = h('span.stepper-value');
    const zoneLive = h('span.sr-only', { 'aria-live': 'polite' });
    const minus = h('button', { type: 'button', 'aria-label': 'Zone: smaller' }, icon('minus', 20));
    const plus = h('button', { type: 'button', 'aria-label': 'Zone: bigger' }, icon('plus', 20));
    const setZone = (r, tell) => {
      entry.r = Math.max(R.least, Math.min(R.most, r));
      text(zoneValue, `${entry.r} m`);
      minus.setAttribute('aria-disabled', entry.r <= R.least ? 'true' : 'false');
      plus.setAttribute('aria-disabled', entry.r >= R.most ? 'true' : 'false');
      if (tell) text(zoneLive, `Zone ${entry.r} metres`);
      if (S.sheet) S.sheet.r = entry.r;
      drawMap();
    };
    minus.addEventListener('click', () => setZone(entry.r - R_STEP, true));
    plus.addEventListener('click', () => setZone(entry.r + R_STEP, true));
    const err = h('p.cpe-sheet-error', { 'aria-live': 'polite' });
    const parts = [
      h('label.cpe-label', { for: 'cpe-name' }, 'Name'), nameIn,
      h('label.cpe-label', { for: 'cpe-task' }, 'Task', h('span.cpe-optional', ' (if you like)')), taskIn, ideas,
      h('div.cpe-zone',
        h('div.cpe-zone-text', h('span.cpe-label', 'Zone'), h('span.cpe-sub', 'How far round the spot counts as there.')),
        h('div.stepper', { role: 'group', 'aria-label': 'Zone size' }, minus, zoneValue, plus, zoneLive)),
    ];
    let moveRow = null;
    // Moves show at once, but only Done keeps them: Cancel (or Back) puts the order back as it was.
    const startList = S.list;
    let kept = false;
    if (!isNew) {
      const earlier = h('button.btn.small', { type: 'button' }, 'Move earlier');
      const later = h('button.btn.small', { type: 'button' }, 'Move later');
      const del = h('button.btn.small.ghost.cpe-delete', { type: 'button' }, icon('trash', 18), 'Delete');
      del.addEventListener('click', () => {
        kept = true;
        S.list = S.list.filter((c) => c.id !== entry.id);
        if (sheet) sheet.close();
        say(`Deleted ${cleanLine(entry.name, LIMITS.cpName) || 'that checkpoint'}.`, 'brief');
      });
      const place = () => S.list.findIndex((c) => c.id === entry.id);
      const syncMove = () => {
        const i = place();
        earlier.setAttribute('aria-disabled', i <= 0 ? 'true' : 'false');
        later.setAttribute('aria-disabled', i < 0 || i >= S.list.length - 1 ? 'true' : 'false');
        if (sheet && sheet.el) {
          const t = sheet.el.querySelector('.sheet-title');
          if (t) text(t, `Checkpoint ${i + 1}`);
        }
      };
      const move = (dir) => {
        const i = place();
        const j = i + dir;
        if (i < 0 || j < 0 || j >= S.list.length) return;
        const next = S.list.slice();
        [next[i], next[j]] = [next[j], next[i]];
        S.list = next;
        syncMove();
        text(zoneLive, `Now checkpoint ${j + 1}`);
        draw();
      };
      earlier.addEventListener('click', () => move(-1));
      later.addEventListener('click', () => move(1));
      moveRow = h('div.cpe-move', earlier, later, del);
      parts.push(moveRow);
      setTimeout(syncMove, 0);
    }
    parts.push(err);

    const commit = (close) => {
      entry.name = nameIn.value;
      entry.task = taskIn.value;
      const at = isNew ? null : S.list.findIndex((c) => c.id === entry.id);
      const r = ring();
      let p = '';
      if (!cleanLine(entry.name, LIMITS.cpName)) p = 'Give it a name.';
      else if (r) p = newProblem(S.list, entry, r);
      if (p) {
        text(err, p);
        nameIn.setAttribute('aria-invalid', cleanLine(entry.name, LIMITS.cpName) ? 'false' : 'true');
        return;
      }
      const next = S.list.slice();
      if (isNew) next.push(entry);
      else next[at] = entry;
      S.list = next;
      kept = true;
      close();
      draw();
    };

    const actions = isNew
      ? [{ label: 'Add', kind: 'primary', keepOpen: true, onClick: (close) => commit(close) }, { label: 'Cancel', kind: 'ghost' }]
      : [
        { label: 'Done', kind: 'primary', keepOpen: true, onClick: (close) => commit(close) },
        { label: 'Cancel', kind: 'ghost' },
      ];
    if (isNew) S.draft = entry;
    // The map goes back to where it was when the sheet closes (it zooms in on the spot meanwhile).
    const before = map ? { c: map.getCenter(), z: map.getZoom() } : null;
    const sheet = openSheet({
      title: isNew ? 'New checkpoint' : `Checkpoint ${index + 1}`,
      body: parts,
      actions,
      className: 'cpe-sheet',
      onClose: () => {
        if (S.sheet && S.sheet.handle === sheet) S.sheet = null;
        S.draft = null;
        if (!isNew && !kept && S.list !== startList) S.list = startList;
        if (map && before && isPoint(before.c) && Number.isFinite(before.z)) {
          if (typeof map.setInsets === 'function') map.setInsets({}); // (getCenter is the map's own middle)
          map.center(before.c, before.z, { animate: false });
        }
        if (map && typeof map.setInsets === 'function') map.setInsets({ top: topInset(), bottom: PANEL_OVERLAP });
        if (!S.destroyed) draw();
      },
    });
    S.sheet = { handle: sheet, key: isNew ? '_new' : entry.id, r: entry.r };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); taskIn.focus(); } });
    taskIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); taskIn.blur(); } });
    setZone(entry.r, false);
    // Keep the spot in sight above the sheet.
    setTimeout(() => {
      if (!map || S.destroyed || !sheet.el) return;
      const covered = Math.max(0, (mapBox.getBoundingClientRect().bottom || 0) - (sheet.el.getBoundingClientRect().top || 0));
      if (typeof map.setInsets === 'function') map.setInsets({ top: topInset(), bottom: covered });
      map.center(entry.p, Math.max(17.5, map.getZoom() || 0), { animate: true }); // close enough to see the zone
    }, 60);
    draw();
  }

  // ---- your spot ----

  function stopLocating() {
    S.locating = false;
    clearTimeout(S.locTimer);
    S.locTimer = 0;
  }

  function useSpot(pos) {
    S.myPos = pos;
    drawMarks();
    if (map) map.center(pos.p, Math.max(16, map.getZoom() || 0), { animate: true });
  }

  function findMe() {
    const loc = app.location;
    if (!loc || typeof loc.start !== 'function') { say("This phone can't share its location here.", 'brief'); return; }
    const now = loc.latest && loc.latest();
    if (now && isPoint(now.p) && loc.status && loc.status() === 'ok') { useSpot(now); return; }
    S.locating = true;
    clearTimeout(S.locTimer);
    S.locTimer = setTimeout(() => {
      if (S.destroyed || !S.locating) return;
      stopLocating();
      say("Couldn't find your spot. You don't need it: tap the map.", 'brief');
    }, FIND_MS);
    try { loc.start(); S.startedLoc = true; } catch (e) { console.error(e); }
    draw();
    const st = loc.status ? loc.status() : '';
    if (st === 'denied' || st === 'unavailable') onLocation(st, null);
  }

  function onLocation(status, latest) {
    if (S.destroyed) return;
    if (latest && isPoint(latest.p)) {
      S.myPos = latest;
      drawMarks();
      if (S.locating) { stopLocating(); useSpot(latest); draw(); }
      return;
    }
    if (!S.locating) return;
    if (status === 'denied' || status === 'unavailable') {
      stopLocating();
      say(status === 'denied' ? "Location is blocked for this site. You don't need it: tap the map." : "This phone can't find its location right now. Tap the map instead.", 'brief');
    }
  }
  if (app.location && typeof app.location.on === 'function') S.offs.push(app.location.on(onLocation));
  spotBtn.addEventListener('click', () => findMe());

  // ---- the store finder ----

  async function find() {
    if (S.finding) return;
    const r = ring();
    if (!r) { S.placesNote = 'Draw the ring first.'; draw(); return; }
    S.finding = true;
    S.placesNote = '';
    S.findCtl = typeof AbortController === 'function' ? new AbortController() : null;
    draw();
    const res = await findPlaces(r, { signal: S.findCtl ? S.findCtl.signal : undefined });
    if (S.destroyed || res.cancelled) return;
    S.finding = false;
    S.findCtl = null;
    S.looked = true;
    S.places = res.places || [];
    S.placesNote = res.error || '';
    if (!res.error && !freshPlaces(S.places, S.list).length) S.placesNote = 'Every store found is already a checkpoint.';
    draw();
    if (S.places.length && map && typeof map.fitAll === 'function') {
      // Show them all: the ring with its pins.
      map.fitAll({ ring: r, marks: S.places.map((pl) => ({ p: pl.p, r: 0 })), padding: 30 });
    }
  }
  findBtn.addEventListener('click', () => find());

  // ---- drawing ----

  function drawMarks() {
    if (!map) return;
    const me = app.view && app.view.me;
    if (S.myPos && isPoint(S.myPos.p) && me) {
      map.setMarks([{ id: me.id, kind: 'self', p: S.myPos.p, r: 0, age: 0, label: me.name }], { players: app.view.players, meId: me.id });
    } else {
      map.setMarks([], {});
    }
  }

  function spotList() {
    const saved = new Map(S.saved.map((c) => [c.id, JSON.stringify(cleanCheckpoints([c])[0])]));
    const out = S.list.map((c, i) => {
      let same = false;
      try { same = saved.get(c.id) === JSON.stringify(cleanCheckpoints([c])[0]); } catch { same = false; }
      const editing = S.sheet && S.sheet.key === c.id;
      return {
        key: c.id, p: c.p, r: editing ? S.sheet.r : c.r, n: i + 1, name: cleanLine(c.name, LIMITS.cpName),
        state: same && !editing ? 'active' : 'draft',
        label: !(same && !editing) ? undefined : false, // saved ones: the number (the list below has the names)
      };
    });
    if (S.draft) {
      out.push({ key: '_new', p: S.draft.p, r: S.sheet ? S.sheet.r : S.draft.r, n: S.list.length + 1, name: cleanLine(S.draft.name, LIMITS.cpName), state: 'draft' });
    }
    for (const pl of freshPlaces(S.places, S.list)) out.push({ key: `osm:${pl.id}`, p: pl.p, r: 0, n: 0, name: pl.name, state: 'suggest' });
    return out;
  }

  function drawMap() {
    if (!map || S.destroyed) return;
    map.setRing(ring(), null);
    if (typeof map.setSpots === 'function') map.setSpots(spotList());
  }

  function topInset() { return Math.round(top.offsetHeight || 64); }

  function problemNow() {
    const r = ring();
    if (!r) return 'Draw the ring first.';
    return checkpointProblem(S.list, r);
  }

  function hintWords() {
    if (S.note) return S.note;
    if (S.locating) return 'Finding your spot...';
    if (!ring()) return 'Draw the ring first, in the lobby.';
    if (S.list.length >= MOST) return `That's the most: ${MOST} checkpoints.`;
    if (!S.list.length) return 'Tap the map to add a checkpoint.';
    return S.list.length < LIMITS.checkpointsLeast ? 'Tap the map to add another.' : '';
  }

  function drawList() {
    const sig = JSON.stringify(S.list);
    if (listEl.dataset.sig === sig) return;
    listEl.dataset.sig = sig;
    fill(listEl, S.list.map((c, i) => {
      const name = cleanLine(c.name, LIMITS.cpName) || 'No name yet';
      const task = cleanLine(c.task, LIMITS.cpTask);
      const b = h('button.cpe-row', { type: 'button', 'aria-label': `${rowWords(c, i)}. Change it` },
        h('span.cpe-badge', { 'aria-hidden': 'true' }, String(i + 1)),
        h('span.cpe-row-text', { 'aria-hidden': 'true' }, h('span.cpe-row-name', name),
          h('span.cpe-row-sub', `${task || 'No task'} · ${c.r} m`)),
        h('span.cpe-row-go', { 'aria-hidden': 'true' }, icon('back', 18)));
      b.addEventListener('click', () => { const j = S.list.findIndex((x) => x.id === c.id); if (j >= 0) editSheet(j); });
      return h('li', b);
    }));
  }

  function drawPlaces() {
    const fresh = freshPlaces(S.places, S.list);
    const sig = JSON.stringify(fresh.map((p) => p.id)) + S.list.length;
    if (placesEl.dataset.sig === sig) return;
    placesEl.dataset.sig = sig;
    fill(placesEl, fresh.map((pl) => {
      const add = h('button.btn.small.cpe-add', { type: 'button', 'aria-label': `Add ${pl.name}` }, icon('plus', 18), 'Add');
      add.addEventListener('click', () => addPlace(pl));
      return h('li.cpe-place',
        h('span.cpe-place-pin', { 'aria-hidden': 'true' }),
        h('span.cpe-place-text', h('span.cpe-place-name', pl.name), h('span.cpe-place-kind', KIND_WORDS[pl.kind] || '')),
        add);
    }));
    placesEl.hidden = !fresh.length;
  }

  function changed() { return !sameList(S.list, S.saved); }

  // While something here isn't saved, the phone's Back (an iPhone's swipe, Android's back) asks like the X does
  // instead of leaving Night Ops with the changes.
  let holding = false;
  function holdBack() {
    const want = !S.destroyed && changed();
    if (want === holding || typeof app.holdBack !== 'function') return;
    holding = want;
    try { app.holdBack(want ? () => { if (!S.destroyed && !sheetOpen()) cancel(); } : null); } catch (e) { console.error(e); }
  }

  function draw() {
    if (S.destroyed) return;
    const n = S.list.length;
    text(count, `${n} of ${MOST}`);
    empty.hidden = n > 0;
    drawList();
    const p = problemNow();
    const words = p || (n < LIMITS.checkpointsLeast ? `Add at least ${LIMITS.checkpointsLeast} checkpoints to play.` : '');
    text(problem, words);
    problem.dataset.kind = p ? 'warn' : 'info';
    cls(problem, 'warn', !!p);
    text(hint, hintWords());
    cls(hint, 'warn', S.noteWhy === 'brief');
    findBtn.setAttribute('aria-busy', S.finding ? 'true' : 'false');
    findBtn.setAttribute('aria-disabled', S.finding || !ring() ? 'true' : 'false');
    fill(findBtn, icon('pin', 20), S.finding ? 'Looking...' : S.looked ? 'Find stores again' : 'Find stores in the ring');
    text(findNote, S.placesNote);
    drawPlaces();
    spotBtn.setAttribute('aria-busy', S.locating ? 'true' : 'false');
    cls(spotBtn, 'busy', S.locating);
    saveBtn.setAttribute('aria-disabled', S.saving || !!p ? 'true' : 'false');
    fill(saveBtn, S.saving ? 'Saving...' : 'Save');
    drawMap();
    holdBack();
  }

  // ---- saving and leaving ----

  async function save() {
    if (S.saving) return;
    const p = problemNow();
    if (p) { text(problem, p); return; }
    if (!changed()) { app.go('lobby'); return; }
    S.saving = true;
    draw();
    const res = await app.cmd({ type: 'checkpoints', list: cleanCheckpoints(S.list) }, { quiet: true });
    if (S.destroyed) return;
    S.saving = false;
    if (res && res.error) {
      draw();
      text(problem, res.offline
        ? "No connection, so the checkpoints weren't saved. Try again when you have signal."
        : res.message || res.error.message || "The checkpoints weren't saved. Try again.");
      cls(problem, 'warn', true);
      return;
    }
    S.saved = S.list.map(entryOf);
    holdBack();
    app.go('lobby');
  }
  saveBtn.addEventListener('click', () => save());

  function cancel() {
    if (S.saving) return;
    if (!changed()) { app.go('lobby'); return; }
    openSheet({
      title: 'Leave without saving?',
      body: h('p', 'The checkpoints you changed here will be lost.'),
      actions: [
        { label: 'Leave without saving', kind: 'danger', onClick: () => { if (!S.destroyed) app.go('lobby'); } },
        { label: 'Keep going', kind: 'ghost' },
      ],
    });
  }
  closeBtn.addEventListener('click', () => cancel());
  S.offs.push(listen(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !sheetOpen() && !S.destroyed) { e.preventDefault(); cancel(); }
  }));

  // ---- first look ----

  draw();
  drawMarks();
  if (map) {
    if (typeof map.setInsets === 'function') requestAnimationFrame(() => { if (!S.destroyed && map) map.setInsets({ top: topInset(), bottom: PANEL_OVERLAP }); });
    const r = ring();
    if (r) map.fit(r, { padding: 24, animate: false });
  }

  return {
    update(view) {
      if (S.destroyed || !view) return;
      if (!view.me || !view.me.host || view.phase !== 'lobby') return; // the App takes us away
      // The saved list changed elsewhere (another phone of the host's): take it when nothing here was changed.
      const now = savedNow();
      if (!sameList(now, S.saved)) {
        const untouched = !changed();
        S.saved = now;
        if (untouched && !S.sheet) S.list = now.map(entryOf);
      }
      draw();
      drawMarks();
    },
    destroy() {
      S.destroyed = true;
      holdBack();
      stopLocating();
      clearTimeout(S.noteTimer);
      if (S.findCtl) { try { S.findCtl.abort(); } catch { /* ignore */ } }
      for (const off of S.offs.splice(0)) { try { off(); } catch { /* ignore */ } }
      if (map) { try { map.destroy(); } catch { /* ignore */ } }
      map = null;
      if (S.startedLoc && app.location && !(app.view && app.view.phase === 'live')) {
        try { app.location.stop(); } catch { /* ignore */ }
      }
    },
  };
}
