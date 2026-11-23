// Night Ops: the spectator's screen (v1.1, PAGE-WATCH). mount(root, app) -> { update(view), destroy() }
//
// A spectator watches a game they don't play in. Everything they get is the server's watchView: 2 minutes
// behind the game (marks, pings, the play-by-play and the ring as they were then), never a chat, never one
// player's own news. This screen never asks for a location.
//   lobby  the code, who's in, the mode and rules, the ring, "Waiting for the host to start.", Stop watching
//   live   the map (every mark in the view), a "2 MIN BEHIND" tag, the time left as of then, the play-by-play,
//          N watching, Stop watching
// The end screen is the normal over screen (app.js sends a spectator there).
import { h, fill, face, text, cls, listen } from '../dom.js?v=166';
import { icon } from '../ui/icons.js?v=166';
import { createMap } from '../map.js?v=166';
import { createTray, mapButtonsPlace, mapButtonInsets } from '../ui/tray.js?v=166'; // v1.2 PAGE-MAP
import { openSheet } from '../ui/sheet.js?v=166'; // v1.2 PAGE-MAP: the menu
import { MODES, fmtClock } from '../../shared/rules.js?v=166';
import { cpWatch, cpEventThumb, cpRuleLine } from './cpafter.js?v=166'; // v1.3 PAGE-AFTER
import { createMapCam } from '../mapcam.js?v=166'; // v1.4 PAGE-REEL
import { followRow } from './reelparts.js?v=166'; // v1.4 PAGE-REEL

export const PBP_MOST = 80;          // play-by-play rows kept on screen
const TICK_MS = 1000;

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

const isObj = (x) => !!x && typeof x === 'object';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function watchingWords(n) {
  const k = Number(n) || 0;
  return k > 0 ? `${k} watching` : '';
}

// How far behind the spectator is, in words ("2 MIN BEHIND").
export function behindWords(view) {
  const ms = isObj(view) && isObj(view.watch) && Number.isFinite(view.watch.delayMs) ? view.watch.delayMs : 120000;
  const min = Math.max(1, Math.round(ms / 60000));
  return `${min} min behind`;
}

// Who's on which side, as of the view's clock.
export function sides(view) {
  const list = isObj(view) && Array.isArray(view.players) ? view.players.filter(isObj) : [];
  const live = isObj(view) && view.phase === 'live';
  const hunters = list.filter((p) => p.team === 'hunter' && p.status === 'in');
  const hiders = list.filter((p) => p.team === 'hider' && p.status === 'in');
  const out = list.filter((p) => live && p.status !== 'in');
  return { all: list, hunters, hiders, out };
}

// The line under the tag: what's going on, as of the view's clock.
export function statusWords(view) {
  if (!isObj(view)) return '';
  if (view.phase === 'lobby') return 'Waiting for the host to start.';
  if (view.phase !== 'live') return '';
  if (view.paused) {
    const who = isObj(view.sos) && view.sos.name ? view.sos.name : '';
    return who ? `Paused: SOS from ${who}.` : 'Paused.';
  }
  const t = isObj(view.timing) ? view.timing : {};
  if (view.sub === 'headstart' || Number.isFinite(t.headStartLeft)) return 'The hiders are hiding.';
  if (t.closing) return t.shrinking ? 'Closing in, ring shrinking.' : 'Closing in.';
  return 'The hunt is on.';
}

// The rules in short, for the read-only lobby.
export function ruleLines(settings) {
  const s = isObj(settings) ? settings : {};
  const lines = [];
  const mode = MODES[s.mode] || MODES.classic;
  lines.push([mode.label, mode.line]);
  if (Number.isFinite(s.durationMin)) lines.push(['Game', `${s.durationMin} min hunt`]);
  if (Number.isFinite(s.headStartMin)) lines.push(['Head start', `${s.headStartMin} min`]);
  if (Number.isFinite(s.pingEveryMin)) lines.push(['Pings', `every ${s.pingEveryMin} min`]);
  if (s.driver) lines.push(['Driver', 'One hunter drives and gives rides.']);
  return lines;
}

// The play-by-play: newest first, never a chat, at most PBP_MOST.
export function pbpRows(events, most = PBP_MOST) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => isObj(e) && Number.isFinite(e.id) && e.kind !== 'chat' && typeof e.text === 'string' && e.text.trim());
  list.sort((a, b) => b.id - a.id);
  return list.slice(0, most).map((e) => ({
    id: e.id,
    clock: Number.isFinite(e.clock) ? Math.max(0, e.clock) : null,
    side: e.side === 'hunters' || e.side === 'hiders' ? e.side : 'all',
    kind: String(e.kind || ''),
    text: e.text.trim().slice(0, 240),
    ...(e.kind === 'checkpoint' && isObj(e.data) && e.data.what === 'done' ? { event: e } : {}), // v1.3 PAGE-AFTER: its photo
  }));
}

// The marks as the map draws them for a spectator: a hider's ping circle is "what the hunters saw" (the map's
// 'seen' slot), so it shows beside the hider's own dot instead of in its place.
export function mapMarks(marks) {
  return (Array.isArray(marks) ? marks : []).filter(isObj).map((m) => (m.kind === 'ping' ? { ...m, kind: 'seen' } : m));
}

// The time left, ticking on from when the view came (not while paused, never below 0). null = no clock.
export function leftNow(view, sinceMs = 0) {
  if (!isObj(view) || view.phase !== 'live' || !isObj(view.timing)) return null;
  const t = view.timing;
  const run = view.paused ? 0 : Math.max(0, Number(sinceMs) || 0);
  const less = (v) => (Number.isFinite(v) ? Math.max(0, v - run) : null);
  return { left: less(t.left), headStartLeft: less(t.headStartLeft) };
}

// ---- the screen -------------------------------------------------------------------------------------------

export function mount(root, app) {
  const S = {
    dead: false,
    view: null,
    built: null,        // 'lobby' | 'live'
    recvAt: 0,
    map: null,
    ringKey: '',
    fitted: false,
    pbpKey: '',
    newest: 0,
  };
  const offs = [];
  const perfNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now());
  const faceSrc = (id) => (app.faces && typeof app.faces.get === 'function' ? app.faces.get(id) : null) || null;
  let W = {};

  root.classList.add('w-root');

  function stopBtn(extra = '') {
    const b = h(`button.btn.small.ghost.w-stop${extra}`, { type: 'button' }, icon('door', 20), h('span', 'Stop watching'));
    b.addEventListener('click', () => {
      b.disabled = true;
      try { app.stopWatching(); } catch (e) { console.error(e); }
    });
    return b;
  }

  function dropMap() {
    if (S.cam) { try { S.cam.destroy(); } catch { /* ignore */ } S.cam = null; } // v1.4 PAGE-REEL
    if (S.map) { try { S.map.destroy(); } catch { /* ignore */ } }
    S.map = null;
    S.ringKey = '';
    S.fitted = false;
    if (S.offMode) { try { S.offMode(); } catch { /* ignore */ } S.offMode = null; } // v1.2 PAGE-MAP
    if (S.ro) { try { S.ro.disconnect(); } catch { /* ignore */ } S.ro = null; }
    S.mapFinal = false;
  }

  function newMap(box, interactive) {
    try {
      return createMap(box, { interactive });
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // ---- the lobby ----

  function buildLobby() {
    dropMap();
    const code = h('p.w-code.mono');
    const status = h('p.w-wait', { role: 'status' });
    const count = h('span.w-count');
    const players = h('ul.w-players', { role: 'list' });
    const rules = h('dl.w-rules');
    const mapBox = h('div.w-lobby-map');
    const noRing = h('p.w-hint', { hidden: true }, "The host hasn't drawn the ring yet.");
    const watching = h('p.w-watching-line');
    const page = h('div.w-lobby',
      h('header.w-lobby-top',
        h('div.w-lobby-text',
          h('span.label.w-kicker', icon('eye', 16), h('span', 'Watching')),
          h('h1.w-title', 'Waiting to start')),
        stopBtn()),
      h('section.w-card.w-status-card', { 'aria-label': 'The game' },
        h('span.label', 'Game code'), code,
        h('div.w-wait-row', h('span.w-pulse', { 'aria-hidden': 'true' }), status),
        h('p.w-hint', "You'll see the game 2 minutes behind. You don't play and you don't see the chats."),
        watching),
      h('section.w-card', { 'aria-labelledby': 'w-players-title' },
        h('h2#w-players-title.label.w-card-title', 'Players ', count), players),
      h('section.w-card', { 'aria-labelledby': 'w-rules-title' },
        h('h2#w-rules-title.label.w-card-title', 'Rules'), rules),
      h('section.w-card', { 'aria-labelledby': 'w-ring-title' },
        h('h2#w-ring-title.label.w-card-title', 'The ring'), mapBox, noRing));
    fill(root, page);
    W = { code, status, count, players, rules, mapBox, noRing, watching };
    S.built = 'lobby';
  }

  function paintLobby(v) {
    text(W.code, v.code || '');
    text(W.status, statusWords(v));
    const list = sides(v).all;
    text(W.count, `(${list.length})`);
    fill(W.players, list.map((p) => h('li.w-player',
      face({ name: p.name, src: faceSrc(p.id), size: 36 }),
      h('span.w-player-name', p.name),
      p.host ? h('span.chip.w-host', icon('crown', 14), 'Host') : null)));
    // v1.3 PAGE-AFTER: "6 checkpoints. Only the host knows where."
    const cpRule = cpRuleLine(v);
    fill(W.rules, [...ruleLines(v.settings), ...(cpRule ? [cpRule] : [])].map(([k, words]) => h('div.w-rule', h('dt', k), h('dd', words))));
    // v1.3 end PAGE-AFTER
    text(W.watching, watchingWords(v.watching));
    W.watching.hidden = !v.watching;
    const ring = v.ring || null;
    W.noRing.hidden = !!ring;
    W.mapBox.hidden = !ring;
    if (ring) {
      if (!S.map) S.map = newMap(W.mapBox, false);
      const key = JSON.stringify(ring);
      if (S.map && key !== S.ringKey) {
        S.ringKey = key;
        try {
          S.map.setRing(ring, null);
          S.map.fit(ring, { padding: 18, animate: false });
        } catch (e) { console.error(e); }
      }
    }
  }

  // ---- the game, 2 minutes behind ----

  // v1.2 PAGE-MAP: the big map's frame, as on the game screen: the map edge to edge, a slim HUD on top ("2 MIN
  // BEHIND", the time left as of then, N watching, the menu with Stop watching) and the tray at the bottom (the newest
  // play-by-play line and Stop watching; open: who's on which side and the play-by-play).
  function buildLive() {
    dropMap();
    const left = h('span.w-left-num.mono');
    const leftLabel = h('span.label.w-left-label', 'Left');
    const tag = h('span.w-tag', icon('clock', 14), h('span.w-tag-word'));
    const status = h('p.w-status', { role: 'status' });
    const watching = h('span.w-watching', icon('eye', 16), h('span.w-watching-n'));
    const code = h('span.w-hud-code.mono');
    const menu = h('button.g-more.w-menu', { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'dialog' }, icon('menu', 22));
    menu.addEventListener('click', () => openMenu());
    const hud = h('header.w-hud',
      h('div.w-hud-top', tag, h('div.w-left', leftLabel, left), watching, menu),
      h('div.w-hud-line', h('span.w-hud-who', h('span.sr-only', 'Watching game '), code), status));
    const mapBox = h('div.w-map');
    const fit = h('button.w-mapbtn.map-btn', { type: 'button', 'aria-label': 'Fit everyone: the ring and every mark' }, icon('fit', 22));
    fit.addEventListener('click', () => { if (S.cam) S.cam.fitNow(); else fitAll(true); paintFollow(); }); // v1.4 PAGE-REEL: fitNow
    // v1.4 PAGE-REEL: Follow a face (the map eases to them each view; a drag stops it)
    const followBtn = h('button.w-mapbtn.map-btn.mapcam-btn', { type: 'button', 'aria-label': 'Follow someone', 'aria-pressed': 'false', 'aria-expanded': 'false' }, icon('locate', 22));
    const follow = followRow({ onPick: (id) => { if (S.cam) S.cam.follow(id); paintFollow(); } });
    followBtn.addEventListener('click', () => {
      const open = follow.el.hidden;
      follow.el.hidden = !open;
      followBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { paintFollow(); try { W.tray.set('open'); } catch { /* fine */ } }
    });
    // v1.4 end PAGE-REEL
    const zin = h('button.w-mapbtn.map-btn.w-zoom', { type: 'button', 'aria-label': 'Zoom in', hidden: true }, icon('plus', 22));
    const zout = h('button.w-mapbtn.map-btn.w-zoom', { type: 'button', 'aria-label': 'Zoom out', hidden: true }, icon('minus', 22));
    zin.addEventListener('click', () => { if (S.map) S.map.zoomBy(1); });
    zout.addEventListener('click', () => { if (S.map) S.map.zoomBy(-1); });
    const btns = h('div.w-mapbtns', fit, followBtn, zin, zout); // v1.4 PAGE-REEL: followBtn
    const mapWrap = h('div.w-mapwrap', mapBox, btns);
    const hunters = h('span.w-side.hunters');
    const hiders = h('span.w-side.hiders');
    const out = h('span.w-side.out');
    const pbpList = h('ol.w-pbp', { role: 'list', 'aria-label': 'Play-by-play, newest first' });
    const pbpEmpty = h('p.w-hint.w-pbp-empty', 'Nothing has happened yet.');
    const tray = createTray({ label: 'The game so far', onState: () => place() });
    const newestTime = h('span.tray-chip-sub.w-newest-time');
    const newestText = h('strong.tray-chip-title.w-newest-text');
    const newest = h('button.tray-chip.w-newest', { type: 'button', 'aria-controls': tray.more.id },
      h('span.tray-chip-icon', icon('flag', 22)), h('span.tray-chip-words', newestText, newestTime));
    newest.addEventListener('click', () => tray.toggle());
    const stopSq = h('button.tray-sq.w-stop-sq', { type: 'button', 'aria-label': 'Stop watching' }, icon('door', 22));
    stopSq.addEventListener('click', () => { stopSq.disabled = true; try { app.stopWatching(); } catch (e) { console.error(e); } });
    tray.setMain([{ el: newest, grow: true }, stopSq]);
    // v1.3 PAGE-AFTER: the checkpoints (zones on the map; scores and the newest done in the tray), 2 min late
    if (S.cpW) { try { S.cpW.destroy(); } catch { /* ignore */ } }
    S.cpW = cpWatch({ app, map: () => S.map });
    // v1.3 end PAGE-AFTER
    tray.setMore([h('div.w-sides', hunters, hiders, out), follow.el, S.cpW.el, h('h2.label.w-pbp-title', 'Play-by-play'), pbpEmpty, pbpList]); // v1.3 PAGE-AFTER: S.cpW.el // v1.4 PAGE-REEL: follow.el
    tray.el.classList.add('w-panel');
    fill(root, mapWrap, hud, tray.el);
    root.classList.add('w-live');
    W = { left, leftLabel, tag, status, watching, code, mapBox, hunters, hiders, out, pbpList, pbpEmpty, hud, tray, btns, zin, zout, newestText, newestTime, follow, followBtn }; // v1.4 PAGE-REEL: follow, followBtn
    S.map = newMap(mapBox, true);
    // v1.4 PAGE-REEL: the map camera: the first fit, then only the buttons move it
    if (S.cam) { try { S.cam.destroy(); } catch { /* fine */ } S.cam = null; }
    if (S.map) {
      S.cam = createMapCam(S.map, { fitAll: () => { fitAll(false); return true; }, pointOf: (id) => markPoint(id) });
      S.cam.on('mode', () => paintFollow());
    }
    // v1.4 end PAGE-REEL
    if (S.map) {
      S.map.ready.then(() => { S.mapFinal = true; paintZoom(); });
      S.offMode = S.map.onMode(() => { S.mapFinal = true; paintZoom(); });
    }
    try {
      S.ro = new ResizeObserver(() => place());
      S.ro.observe(hud);
      S.ro.observe(tray.el);
    } catch { /* the next update places it */ }
    S.pbpKey = '';
    S.built = 'live';
    place();
  }

  function paintZoom() {
    if (S.dead || S.built !== 'live') return;
    const plainMap = !!S.map && S.mapFinal && S.map.mode() === 'plain';
    W.zin.hidden = !plainMap;
    W.zout.hidden = !plainMap;
    place();
  }

  // The map shows under the bars; its buttons sit between them.
  function place() {
    if (S.dead || S.built !== 'live' || !W.hud) return;
    const vh = globalThis.innerHeight || 0;
    const top = Math.round(W.hud.getBoundingClientRect().bottom);
    const trayTop = Math.round(W.tray.el.getBoundingClientRect().top) || vh;
    root.style.setProperty('--w-hud-bottom', `${top}px`);
    // (Banners sit under this HUD: watch.css reads it from the page's root.)
    try { document.documentElement.style.setProperty('--w-hud-bottom-page', `${top}px`); } catch { /* no document */ }
    root.style.setProperty('--w-tray-h', `${Math.max(0, vh - trayTop)}px`);
    const shown = [...W.btns.children].filter((b) => !b.hidden).length;
    const at = mapButtonsPlace({ hudBottom: top, trayTop, height: vh, count: shown });
    W.btns.dataset.mode = at.mode;
    W.btns.style.top = at.mode === 'column' ? `${at.top}px` : '';
    W.btns.style.bottom = at.mode === 'row' ? `${at.bottom}px` : '';
    // Fit everyone keeps clear of the buttons; the map's credits sit above a row of them.
    if (S.map) { try { S.map.setInsets({ top, ...mapButtonInsets({ ...at, shown }, vh, trayTop) }); } catch { /* ignore */ } }
  }

  function openMenu() {
    let sheet = null;
    const row = h('button.g-menu-row.danger', { type: 'button' },
      h('span.g-menu-icon', icon('door', 22)),
      h('span.g-menu-text', h('span.g-menu-title', 'Stop watching'), h('span.g-menu-line', 'Back to the start')));
    row.addEventListener('click', () => { if (sheet) sheet.close(); try { app.stopWatching(); } catch (e) { console.error(e); } });
    sheet = openSheet({ title: 'Menu', body: h('div.g-menu', row), className: 'g-sheet' });
  }

  function fitRing(animate = false) {
    const v = S.view;
    const ring = v && (v.ring || v.ringNow);
    if (S.map && ring) {
      try { S.map.fit(ring, { padding: 28, animate }); } catch (e) { console.error(e); }
    }
  }

  function fitAll(animate = true) {
    const v = S.view;
    if (!S.map || !v) return;
    try {
      if (!S.map.fitAll({ ring: v.ringNow || v.ring, marks: mapMarks(v.marks), animate })) fitRing(animate);
    } catch (e) { console.error(e); }
  }

  function paintClock() {
    const v = S.view;
    if (!v || S.built !== 'live') return;
    const t = leftNow(v, perfNow() - S.recvAt);
    if (!t) return;
    const head = Number.isFinite(t.headStartLeft);
    text(W.leftLabel, head ? 'Head start' : 'Left');
    text(W.left, fmtClock(head ? t.headStartLeft : (t.left || 0)));
  }

  function paintLive(v) {
    text(W.code, v.code || '');
    text(W.tag.querySelector('.w-tag-word'), behindWords(v).toUpperCase());
    text(W.status, statusWords(v));
    cls(W.status, 'paused', !!v.paused);
    text(W.watching.querySelector('.w-watching-n'), String(Number(v.watching) || 0));
    W.watching.setAttribute('aria-label', watchingWords(v.watching) || 'Nobody else watching');
    W.watching.hidden = !(Number(v.watching) > 0);
    const sd = sides(v);
    text(W.hunters, plural(sd.hunters.length, 'hunter', 'hunters'));
    text(W.hiders, `${plural(sd.hiders.length, 'hider', 'hiders')} free`);
    text(W.out, sd.out.length ? `${sd.out.length} out` : '');
    W.out.hidden = !sd.out.length;
    paintClock();

    if (S.map) {
      const key = JSON.stringify([v.ring, v.ringNow]);
      if (key !== S.ringKey && (v.ring || v.ringNow)) {
        S.ringKey = key;
        try { S.map.setRing(v.ring, v.ringNow); } catch (e) { console.error(e); }
      }
      try {
        S.map.setMarks(mapMarks(v.marks), { faces: app.faces, players: v.players, meId: null, paused: !!v.paused });
      } catch (e) { console.error(e); }
    }

    try { if (S.cpW) S.cpW.update(v); } catch (e) { console.error(e); } // v1.3 PAGE-AFTER
    const rows = pbpRows(v.events);
    const key = rows.map((r) => r.id).join(',');
    if (key !== S.pbpKey) {
      const before = S.newest;
      S.pbpKey = key;
      S.newest = rows.length ? rows[0].id : 0;
      fill(W.pbpList, rows.map((r) => h(`li.w-pbp-item.s-${r.side}${before && r.id > before ? '.new' : ''}`,
        h('span.w-pbp-time.mono', r.clock === null ? '' : fmtClock(r.clock)),
        h('span.w-pbp-text', r.text),
        r.event ? cpEventThumb({ app, event: r.event }) : null))); // v1.3 PAGE-AFTER: the done's photo
      W.pbpEmpty.hidden = rows.length > 0;
      // v1.2 PAGE-MAP: the tray's main row shows the newest line
      text(W.newestText, rows.length ? rows[0].text : 'Nothing has happened yet.');
      text(W.newestTime, rows.length && rows[0].clock !== null ? fmtClock(rows[0].clock) : '');
    }
    // (The first fit waits for the tray's words, so it lands in what shows between the bars.)
    if (S.map && !S.fitted && (v.ring || v.ringNow)) {
      S.fitted = true;
      place();
      if (S.cam) S.cam.auto('first'); else fitAll(false); // v1.4 PAGE-REEL
    }
    if (S.cam) S.cam.frame(); // v1.4 PAGE-REEL: Follow
  }

  // v1.4 PAGE-REEL: Follow's faces and where they are
  function markPoint(id) {
    const v = S.view;
    const m = v && Array.isArray(v.marks) ? v.marks.find((x) => x && x.id === id && Array.isArray(x.p)) : null;
    return m ? m.p : null;
  }
  function paintFollow() {
    if (!W || !W.follow) return;
    const following = S.cam && S.cam.mode === 'follow' ? S.cam.following : null;
    W.followBtn.setAttribute('aria-pressed', following ? 'true' : 'false');
    if (W.follow.el.hidden) return;
    const v = S.view;
    const ids = new Set((v && Array.isArray(v.marks) ? v.marks : []).map((m) => m && m.id));
    const players = (v && Array.isArray(v.players) ? v.players : []).filter((p) => p && ids.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, startTeam: p.team || p.startTeam }));
    W.follow.set(players, following, null, () => (app.faces instanceof Map ? app.faces : new Map()));
  }
  // v1.4 end PAGE-REEL

  // ---- update / destroy ----

  function update(view) {
    if (S.dead || !isObj(view)) return;
    if (view !== S.view) {
      S.view = view;
      S.recvAt = Number.isFinite(app.viewAt) && app.view === view ? app.viewAt : perfNow();
    }
    const want = view.phase === 'live' ? 'live' : view.phase === 'lobby' ? 'lobby' : null;
    if (!want) return; // the over screen takes it from here
    if (want !== S.built) {
      root.classList.remove('w-live');
      if (want === 'live') buildLive();
      else buildLobby();
    }
    if (want === 'live') paintLive(view);
    else paintLobby(view);
  }

  offs.push(app.on('faces', () => { if (S.view && !S.dead) update(S.view); }));
  offs.push(listen(window, 'resize', () => { if (S.map && S.map.resize) S.map.resize(); place(); }));
  const timer = setInterval(paintClock, TICK_MS);

  if (app.view) update(app.view);
  else fill(root, h('div.w-lobby', h('p.w-hint', 'Loading the game...')));

  return {
    update,
    destroy() {
      if (S.dead) return;
      S.dead = true;
      clearInterval(timer);
      for (const off of offs.splice(0)) { try { off(); } catch { /* ignore */ } }
      if (S.ro) { try { S.ro.disconnect(); } catch { /* ignore */ } } // v1.2 PAGE-MAP
      if (S.offMode) { try { S.offMode(); } catch { /* ignore */ } }
      if (S.cpW) { try { S.cpW.destroy(); } catch { /* ignore */ } } // v1.3 PAGE-AFTER
      dropMap();
      root.classList.remove('w-root', 'w-live');
    },
  };
}
