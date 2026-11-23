// Night Ops: the ring editor (host only). A full-screen map: Circle (a centre and a size) or Draw (tap the
// corners in order). When the ring shrinks while closing in, the final size is set here too and shown dashed.
// Save sends cmd ring (and the final size); Cancel goes back to the lobby.
// Where it starts: the saved ring; else your spot when it's known; else the last ring used on this phone;
// else it asks for your location; else a world view and a hint to find your area.
import { h, fill, text, cls, listen } from '../dom.js?v=170';
import { icon } from '../ui/icons.js?v=170';
import { openSheet, sheetOpen } from '../ui/sheet.js?v=170';
import { createMap } from '../map.js?v=170';
import {
  isPoint, ringProblem, cleanRing, ringAcrossM, scaleRing, ringOutline, polygonCentroid, boundsOf,
} from '../../shared/geo.js?v=170';
import { LIMITS, SETTINGS_UI, fmtDistance } from '../../shared/rules.js?v=170';

export const LAST_RING_KEY = 'nightops-last-ring';
export const MIN_ACROSS = 100;
export const MAX_ACROSS = 5000;
const DEFAULT_RADIUS = 400;      // 800 m across: a park and a few streets
const FIND_MS = 15000;           // how long "Use my spot" waits for a fix
const MOST = LIMITS.ringCorners || 20;
const FINAL = SETTINGS_UI.find((s) => s.key === 'finalSizePct') || { min: 20, max: 90, step: 10 };
const NS = 'http://www.w3.org/2000/svg';

// ---- pure helpers -----------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The size slider runs 0..1000 on a log scale from 100 m to 5 km across, in tidy steps.
export function acrossFromSlider(v) {
  const a = MIN_ACROSS * (MAX_ACROSS / MIN_ACROSS) ** (clamp(Number(v) || 0, 0, 1000) / 1000);
  return a < 1000 ? Math.round(a / 10) * 10 : Math.round(a / 100) * 100;
}

export function sliderFromAcross(across) {
  const a = clamp(Number(across) || MIN_ACROSS, MIN_ACROSS, MAX_ACROSS);
  return Math.round((1000 * Math.log(a / MIN_ACROSS)) / Math.log(MAX_ACROSS / MIN_ACROSS));
}

export function readLastRing(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage.getItem(LAST_RING_KEY) || 'null');
    const ring = v && v.ring ? v.ring : v;
    return ring && !ringProblem(ring) ? cleanRing(ring) : null;
  } catch {
    return null;
  }
}

export function saveLastRing(ring, storage = globalThis.localStorage) {
  try { storage.setItem(LAST_RING_KEY, JSON.stringify({ ring, at: Date.now() })); } catch { /* full or blocked */ }
}

// A world view near this phone's time zone (a rough longitude), for when nothing better is known.
function worldGuess() {
  let off = 0;
  try { off = new Date().getTimezoneOffset(); } catch { off = 0; }
  return [clamp(-off / 4, -170, 170), 30];
}

function svgNode(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

// ---- the screen -------------------------------------------------------------------------------------------

export function mount(root, app) {
  const view0 = app.view;
  const saved = view0 && view0.ring && !ringProblem(view0.ring) ? view0.ring : null;
  const S = {
    destroyed: false,
    mode: 'circle',
    circle: { center: null, radiusM: DEFAULT_RADIUS },
    points: [],
    undo: [],
    pct: view0 && view0.settings ? view0.settings.finalSizePct : 50,
    pctTouched: false,
    touched: false,
    tried: false,           // Save was tapped: show every problem
    finding: null,          // null | 'auto' | 'button'
    findTimer: 0,
    locNote: '',
    myPos: null,
    startedLoc: false,
    saving: false,
    world: false,           // showing the whole world (nothing known yet)
    raf: 0,
    innerSig: '',
    offs: [],
  };

  // ---- where it starts ----
  const here = app.positionNow && app.positionNow();
  const last = saved ? null : readLastRing();
  const startRing = saved || null;
  if (startRing) {
    if (startRing.kind === 'circle') {
      S.mode = 'circle';
      S.circle = { center: startRing.center.slice(), radiusM: startRing.radiusM };
    } else {
      S.mode = 'draw';
      S.points = startRing.points.map((p) => p.slice());
    }
  } else if (here && isPoint(here.p)) {
    S.circle.center = here.p.slice();
    S.myPos = here;
  } else if (last) {
    if (last.kind === 'circle') {
      S.circle = { center: last.center.slice(), radiusM: last.radiusM };
    } else {
      S.mode = 'draw';
      S.points = last.points.map((p) => p.slice());
    }
    S.fromLast = true;
  }

  // ---- the page ----

  const mapBox = h('div.ring-map-box');
  const innerSvg = svgNode('svg', { class: 'ring-inner', 'aria-hidden': 'true', focusable: 'false' });
  const innerPath = svgNode('path', { class: 'ring-inner-path' });
  innerSvg.appendChild(innerPath);
  const cross = h('div.ring-cross', { 'aria-hidden': 'true' });
  const hint = h('p.ring-hint', { role: 'status', 'aria-live': 'polite' });

  const closeBtn = h('button.btn.small.icon-only.ring-close', { type: 'button', 'aria-label': 'Cancel, back to the lobby' }, icon('close', 22));
  const spotBtn = h('button.btn.small.ring-spot', { type: 'button' }, icon('locate', 18), h('span', 'Use my spot'));
  const top = h('header.ring-top', closeBtn, h('h1.ring-title', 'The ring'), spotBtn);

  // Mode switch.
  const modeBtns = [['circle', 'Circle'], ['draw', 'Draw']].map(([m, words]) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1' }, icon(m, 18), h('span', words));
    b._mode = m;
    b.addEventListener('click', () => setMode(m));
    return b;
  });
  const modeSeg = h('div.seg.ring-modes', { role: 'radiogroup', 'aria-label': 'How to make the ring' }, modeBtns);
  modeSeg.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = Math.max(0, modeBtns.indexOf(document.activeElement));
    const next = modeBtns[(i + step + modeBtns.length) % modeBtns.length];
    next.focus();
    next.click();
  });

  // Circle: the size slider.
  const sizeValue = h('span.ring-value.mono');
  const slider = h('input#ring-size.ring-slider', {
    type: 'range', min: '0', max: '1000', step: '1', 'aria-describedby': 'ring-size-value',
  });
  sizeValue.id = 'ring-size-value';
  slider.addEventListener('input', () => {
    S.circle.radiusM = acrossFromSlider(slider.value) / 2;
    S.touched = true;
    draw();
  });
  const circlePart = h('div.ring-part.ring-circle',
    h('div.ring-row', h('label.ring-label', { for: 'ring-size' }, 'Size'), sizeValue),
    slider);

  // Draw: corners.
  const cornersValue = h('span.ring-value.mono');
  const undoBtn = h('button.btn.small', { type: 'button' }, icon('undo', 18), 'Undo');
  const clearBtn = h('button.btn.small', { type: 'button' }, icon('trash', 18), 'Start again');
  undoBtn.addEventListener('click', () => {
    if (!S.undo.length) return;
    S.points = S.undo.pop();
    S.touched = true;
    draw();
  });
  clearBtn.addEventListener('click', () => {
    if (!S.points.length) return;
    S.undo.push(S.points.slice());
    S.points = [];
    S.touched = true;
    draw();
  });
  const drawPart = h('div.ring-part.ring-draw',
    h('div.ring-row', h('span.ring-label', 'Corners'), cornersValue),
    h('div.ring-buttons', undoBtn, clearBtn));

  // Final size (only when the ring shrinks while closing in).
  const finalValue = h('span.stepper-value');
  const finalLive = h('span.sr-only', { 'aria-live': 'polite' });
  const finalMinus = h('button', { type: 'button', 'aria-label': 'Final size: smaller' }, icon('minus', 20));
  const finalPlus = h('button', { type: 'button', 'aria-label': 'Final size: bigger' }, icon('plus', 20));
  const stepFinal = (dir) => {
    const next = clamp(S.pct + dir * FINAL.step, FINAL.min, FINAL.max);
    if (next === S.pct) return;
    S.pct = next;
    S.pctTouched = true;
    S.touched = true;
    text(finalLive, `Final size ${next}%`);
    draw();
  };
  finalMinus.addEventListener('click', () => stepFinal(-1));
  finalPlus.addEventListener('click', () => stepFinal(1));
  const finalRow = h('div.ring-final',
    h('div.ring-final-text', h('span.ring-label', 'Final size'), h('span.ring-sub', 'Dashed: how small it gets by the end.')),
    h('div.stepper', { role: 'group', 'aria-label': 'Final ring size' }, finalMinus, finalValue, finalPlus, finalLive));

  const problem = h('p.ring-problem', { 'aria-live': 'polite' });
  const saveBtn = h('button.btn.primary.wide.ring-save', { type: 'button' });
  saveBtn.addEventListener('click', () => save());

  const panel = h('div.ring-panel', modeSeg, circlePart, drawPart, finalRow, problem, saveBtn);

  mapBox.append(innerSvg, cross, top, hint);
  fill(root, h('div.ring', mapBox, panel));

  // ---- the map ----

  let map = null;
  function makeMap() {
    if (map) { try { map.destroy(); } catch { /* ignore */ } }
    map = null;
    S.innerSig = '';
    try {
      map = createMap(mapBox, { interactive: true });
    } catch (e) {
      console.error(e);
      return;
    }
    const made = map;
    map.onTap((p) => placeAt(p));
    map.ready.then(() => { if (!S.destroyed && map === made) draw(); });
    // The map's own layers go under the bar, the hint and the dashed final size.
    mapBox.prepend(innerSvg, cross);
    const nmap = mapBox.querySelector('.nmap');
    if (nmap) mapBox.prepend(nmap);
  }
  makeMap();

  // A world view, for when nothing is known about where they play.
  function goWorld() {
    if (!map || currentRing()) return;
    S.world = true;
    map.center(worldGuess(), 1.6, { animate: false });
    draw();
  }

  // Leaving the world view for a real place: the plain map's flat projection is made around the first place
  // it showed, so a new one is made around this place (the street map doesn't need that).
  function leaveWorld() {
    if (!S.world) return;
    S.world = false;
    if (map && map.mode() === 'plain') {
      makeMap();
      drawMarks();
    }
  }
  // Keyboard: with the map focused, Enter puts a corner (or the centre) in the middle of the map.
  S.offs.push(listen(mapBox, 'keydown', (e) => {
    if (e.key !== 'Enter' || !map) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest('.nmap') || t.closest('button')) return;
    const c = map.getCenter();
    if (isPoint(c)) {
      e.preventDefault();
      placeAt(c);
    }
  }));

  // ---- doing things ----

  function currentRing() {
    if (S.mode === 'circle') {
      return S.circle.center ? { kind: 'circle', center: S.circle.center, radiusM: S.circle.radiusM } : null;
    }
    return S.points.length ? { kind: 'polygon', points: S.points } : null;
  }

  function placeAt(p) {
    if (!isPoint(p) || S.saving) return;
    S.touched = true;
    S.world = false;
    S.locNote = '';
    // Zoomed far out (the world view): a tap first takes the map to that place.
    const far = !!map && (map.getZoom() || 0) < 12;
    if (far && S.mode === 'draw') {
      map.center(p, 15, { animate: true });
      draw();
      return;
    }
    if (S.mode === 'circle') {
      S.circle.center = [p[0], p[1]];
    } else {
      if (S.points.length >= MOST) {
        try { app.alerts?.buzz?.('tap'); } catch { /* fine */ }
        return; // the hint says it's the most
      }
      S.undo.push(S.points.slice());
      if (S.undo.length > 60) S.undo.shift();
      S.points.push([p[0], p[1]]);
    }
    draw();
    if (far) fitTo(currentRing(), true);
  }

  function setMode(m) {
    if (m === S.mode) return;
    S.mode = m;
    S.touched = true;
    if (m === 'circle' && !S.circle.center) {
      if (S.points.length >= 3) {
        const poly = { kind: 'polygon', points: S.points };
        S.circle.center = polygonCentroid(S.points);
        S.circle.radiusM = clamp(ringAcrossM(poly) / 2, MIN_ACROSS / 2, MAX_ACROSS / 2);
      } else if (S.myPos && isPoint(S.myPos.p)) {
        S.circle.center = S.myPos.p.slice();
      } else if (map && !S.world && (map.getZoom() || 0) >= 12 && isPoint(map.getCenter())) {
        S.circle.center = map.getCenter();
      }
    }
    draw();
  }

  // ---- your spot ----

  function stopFinding() {
    S.finding = null;
    clearTimeout(S.findTimer);
    S.findTimer = 0;
  }

  function useSpot(pos, why) {
    S.myPos = pos;
    drawMarks();
    if (why === 'auto' && S.touched) return; // they've started without it: don't move anything
    leaveWorld();
    if (S.mode === 'circle') {
      S.circle.center = pos.p.slice();
      if (why === 'button') S.touched = true;
      draw();
      fitTo(currentRing(), true);
    } else if (map) {
      map.center(pos.p, Math.max(15, map.getZoom() || 0), { animate: true });
      draw();
    }
  }

  function findMe(why) {
    const loc = app.location;
    if (!loc || typeof loc.start !== 'function') {
      S.locNote = "This phone can't share its location here. Move the map and tap instead.";
      if (!map || !map.getCenter()) goWorld();
      draw();
      return;
    }
    const now = loc.latest && loc.latest();
    if (now && isPoint(now.p) && loc.status && loc.status() === 'ok') {
      useSpot(now, why);
      return;
    }
    S.finding = why;
    S.locNote = '';
    clearTimeout(S.findTimer);
    S.findTimer = setTimeout(() => {
      if (S.destroyed || !S.finding) return;
      stopFinding();
      S.locNote = "Couldn't find your spot. Try again outside, or move the map and tap.";
      if (!currentRing()) goWorld();
      draw();
    }, FIND_MS);
    try {
      loc.start();
      S.startedLoc = true;
    } catch (e) {
      console.error(e);
    }
    draw();
    // A phone that already said no answers at once.
    const st = loc.status ? loc.status() : '';
    if (st === 'denied' || st === 'unavailable') onLocation(st, loc.latest ? loc.latest() : null);
  }

  function onLocation(status, latest) {
    if (S.destroyed) return;
    if (latest && isPoint(latest.p)) {
      const first = !S.myPos;
      S.myPos = latest;
      drawMarks();
      if (S.finding) {
        const why = S.finding;
        stopFinding();
        useSpot(latest, why);
        return;
      }
      if (first) draw();
    }
    if (!S.finding) return;
    if (status === 'denied') {
      stopFinding();
      S.locNote = 'Location is blocked for this site. Allow it in your browser settings, or move the map and tap.';
      if (!currentRing()) goWorld();
      draw();
    } else if (status === 'unavailable') {
      stopFinding();
      S.locNote = "This phone can't find its location right now. Move the map and tap instead.";
      if (!currentRing()) goWorld();
      draw();
    }
  }

  if (app.location && typeof app.location.on === 'function') S.offs.push(app.location.on(onLocation));
  spotBtn.addEventListener('click', () => findMe('button'));

  // ---- drawing ----

  function drawMarks() {
    if (!map) return;
    const v = app.view;
    const me = v && v.me;
    if (S.myPos && isPoint(S.myPos.p) && me) {
      map.setMarks([{ id: me.id, kind: 'self', p: S.myPos.p, r: 0, age: 0, label: me.name }], { players: v.players, meId: me.id });
    } else {
      map.setMarks([], {});
    }
  }

  function shrinks() {
    const s = app.view && app.view.settings;
    return !!s && s.closingMin > 0 && !!s.shrink;
  }

  function hintWords(ring) {
    if (S.finding) return 'Finding your spot...';
    if (S.locNote) return S.locNote;
    if (S.world) {
      return map && map.mode() === 'plain'
        ? 'No street map on this phone. Tap Use my spot to start where you are.'
        : 'Drag and zoom the map to where you play, then tap.';
    }
    if (S.fromLast && !S.touched) return 'The last ring you used. Move it, or tap Use my spot.';
    if (S.mode === 'circle') return ring ? 'Tap the map to move the centre.' : 'Tap the map where the middle of the ring goes.';
    const n = S.points.length;
    if (n === 0) return 'Tap the map to add corners, in order around the edge.';
    if (n < 3) return `Keep tapping: at least 3 corners (${n} so far).`;
    if (n >= MOST) return `That's the most corners (${MOST}). Undo one to change it.`;
    return 'Tap to add more corners, or save it.';
  }

  function draw() {
    if (S.destroyed) return;
    for (const b of modeBtns) {
      const on = b._mode === S.mode;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    circlePart.hidden = S.mode !== 'circle';
    drawPart.hidden = S.mode !== 'draw';
    root.dataset.mode = S.mode;

    const ring = currentRing();
    const across = S.circle.radiusM * 2;
    // (Never under a finger that's dragging it: the tidy steps would make the thumb jump.)
    if (document.activeElement !== slider || String(acrossFromSlider(slider.value)) !== String(across)) {
      slider.value = String(sliderFromAcross(across));
    }
    slider.setAttribute('aria-valuetext', `${fmtDistance(across)} across`);
    text(sizeValue, `${fmtDistance(across)} across`);

    const n = S.points.length;
    const width = n >= 2 ? ringAcrossM({ kind: 'polygon', points: S.points }) : 0;
    text(cornersValue, n >= 2 ? `${n} corners · ${fmtDistance(width)} across` : `${n} ${n === 1 ? 'corner' : 'corners'}`);
    undoBtn.setAttribute('aria-disabled', S.undo.length ? 'false' : 'true');
    clearBtn.setAttribute('aria-disabled', n ? 'false' : 'true');

    const showFinal = shrinks();
    finalRow.hidden = !showFinal;
    text(finalValue, `${S.pct}%`);
    finalMinus.setAttribute('aria-disabled', S.pct <= FINAL.min ? 'true' : 'false');
    finalPlus.setAttribute('aria-disabled', S.pct >= FINAL.max ? 'true' : 'false');

    // Problems: shown once the shape could be a ring (or after Save was tapped).
    const p = ring ? ringProblem(cleanRing(ring))
      : S.mode === 'circle' ? 'Tap the map where the middle of the ring goes.' : 'Tap at least 3 corners.';
    const ready = S.mode === 'circle' ? !!ring : n >= 3;
    if (p && (ready || S.tried)) {
      text(problem, p);
      problem.dataset.kind = 'warn';
    } else {
      text(problem, '');
      delete problem.dataset.kind;
    }
    const canSave = !p && !S.saving;
    saveBtn.setAttribute('aria-disabled', canSave ? 'false' : 'true');
    fill(saveBtn, icon('check', 20), S.saving ? 'Saving...' : 'Save the ring');

    spotBtn.setAttribute('aria-busy', S.finding ? 'true' : 'false');
    cls(spotBtn, 'busy', !!S.finding);
    text(hint, hintWords(ring));

    if (map) {
      if (S.mode === 'circle') map.setDraft(ring ? { kind: 'circle', center: ring.center, radiusM: ring.radiusM } : null);
      else map.setDraft(n ? S.points : null);
    }
    S.inner = showFinal && ring && !ringProblem(cleanRing(ring)) ? scaleRing(ring, S.pct / 100) : null;
    loopInner();
  }

  // The final size, dashed, kept in place over the map as it moves.
  function loopInner() {
    if (S.raf || S.destroyed) return;
    const frame = () => {
      S.raf = 0;
      if (S.destroyed) return;
      const inner = S.inner;
      if (!inner || !map) {
        if (innerPath.getAttribute('d')) innerPath.setAttribute('d', '');
        S.innerSig = '';
        return; // no loop while there's nothing to draw
      }
      const c = map.getCenter();
      const z = map.getZoom();
      const w = mapBox.clientWidth;
      const hgt = mapBox.clientHeight;
      const sig = `${c ? c.join(',') : ''}|${z}|${w}x${hgt}|${JSON.stringify(inner)}|${map.mode()}`;
      if (sig !== S.innerSig) {
        S.innerSig = sig;
        let d = '';
        for (const p of ringOutline(inner, 72)) {
          const xy = map.project(p);
          if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) { d = ''; break; }
          d += `${d ? 'L' : 'M'}${xy[0].toFixed(1)} ${xy[1].toFixed(1)}`;
        }
        innerPath.setAttribute('d', d ? `${d}Z` : '');
      }
      S.raf = requestAnimationFrame(frame);
    };
    S.raf = requestAnimationFrame(frame);
  }

  function fitTo(ring, animate) {
    if (!map || !ring) return;
    const pts = ring.kind === 'circle' ? ringOutline(ring, 32) : ring.points;
    if (!pts.length) return;
    const topH = top.offsetHeight || 64;
    map.fit(pts.length === 1 ? pts[0] : boundsOf(pts), {
      padding: { top: topH + 36, right: 28, bottom: 44, left: 28 },
      animate: !!animate,
    });
  }

  // ---- saving and leaving ----

  function changed() {
    const ring = currentRing();
    let same = false;
    try {
      same = !!ring && !!saved && JSON.stringify(cleanRing(ring)) === JSON.stringify(cleanRing(saved));
    } catch { same = false; }
    const pctNow = app.view && app.view.settings ? app.view.settings.finalSizePct : S.pct;
    return (!same && (!!ring || !!saved) && S.touched) || (S.pctTouched && S.pct !== pctNow);
  }

  async function save() {
    if (S.saving) return;
    S.tried = true;
    const ring = currentRing();
    const clean = ring ? cleanRing(ring) : null;
    const p = clean ? ringProblem(clean) : (S.mode === 'circle' ? 'Tap the map where the middle of the ring goes.' : 'Tap at least 3 corners.');
    if (p) {
      text(problem, p);
      problem.dataset.kind = 'warn';
      draw();
      return;
    }
    S.saving = true;
    draw();
    const pctBefore = app.view && app.view.settings ? app.view.settings.finalSizePct : null;
    let res = null;
    let same = false;
    try { same = !!saved && JSON.stringify(clean) === JSON.stringify(cleanRing(saved)); } catch { same = false; }
    if (!same) {
      res = await app.cmd({ type: 'ring', ring: clean }, { quiet: true });
      if (S.destroyed) return;
      if (res && res.error) {
        S.saving = false;
        draw();
        text(problem, res.offline
          ? "No connection, so the ring wasn't saved. Try again when you have signal."
          : res.message || res.error.message || "The ring wasn't saved. Try again.");
        problem.dataset.kind = 'warn';
        return;
      }
    }
    if (S.pctTouched && S.pct !== pctBefore && shrinks()) {
      const r2 = await app.cmd({ type: 'settings', settings: { finalSizePct: S.pct } }, { quiet: true });
      if (S.destroyed) return;
      if (r2 && r2.error) {
        S.saving = false;
        draw();
        text(problem, `The ring is saved, but not the final size: ${r2.message || r2.error.message || 'try again.'}`);
        problem.dataset.kind = 'warn';
        return;
      }
    }
    saveLastRing(clean);
    S.saving = false;
    app.go('lobby');
  }

  function cancel() {
    if (S.saving) return;
    if (!changed()) {
      app.go('lobby');
      return;
    }
    openSheet({
      title: 'Leave without saving?',
      body: h('p', 'The ring you drew here will be lost.'),
      actions: [
        { label: 'Leave without saving', kind: 'danger', onClick: () => { if (!S.destroyed) app.go('lobby'); } },
        { label: 'Keep drawing', kind: 'ghost' },
      ],
    });
  }

  closeBtn.addEventListener('click', () => cancel());
  S.offs.push(listen(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !sheetOpen() && !S.destroyed) {
      e.preventDefault();
      cancel();
    }
  }));

  // ---- first look ----

  draw();
  drawMarks();
  const first = currentRing();
  if (first) {
    fitTo(first, false);
  } else {
    findMe('auto'); // nothing to start from: ask where they are (a world view if that fails)
  }

  return {
    update(view) {
      if (S.destroyed || !view) return;
      if (!S.pctTouched && view.settings) S.pct = view.settings.finalSizePct;
      draw();
      drawMarks();
    },
    destroy() {
      S.destroyed = true;
      stopFinding();
      if (S.raf) cancelAnimationFrame(S.raf);
      S.raf = 0;
      for (const off of S.offs.splice(0)) { try { off(); } catch { /* ignore */ } }
      if (map) { try { map.destroy(); } catch { /* ignore */ } }
      map = null;
      // Location was only for "my spot": stop it, unless the game has started and the App needs it now.
      if (S.startedLoc && app.location && !(app.view && app.view.phase === 'live')) {
        try { app.location.stop(); } catch { /* ignore */ }
      }
    },
  };
}
