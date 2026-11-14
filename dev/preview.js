// Night Ops: the preview page. Opens any screen with sample views (dev/fixtures.js) and no server:
//   preview.html?screen=game&as=hunter|hider|out&state=hunt|headstart|closing|paused|tagged|outside
//   ?screen=lobby&host=1   ?screen=ring&host=1&ring=0   ?screen=reveal&as=hider   ?screen=over&as=hunter&state=hunters
//   ?screen=home&code=WYKUSX   &tick=1 makes the clock run (timers count down, a sync every second)
// It runs the real App (js/app.js) with a fake server: commands are logged and answered with the same view
// (a chat message is added to the events), faces are generated pictures. Screens that don't exist yet show a
// card saying so, with a summary of the sample data.
// For tests: window.__preview = { app, log, view(), set(params), push(event) }.
import { App, memoryStore } from '../js/app.js';
import { ApiError } from '../js/api.js';
import { createIdentity } from '../js/identity.js';
import * as alerts from '../js/alerts.js';
import { h, fill } from '../js/dom.js';
import { fmtClock } from '../shared/rules.js';
import { ringCenter } from '../shared/geo.js';
import { fixture, faceFor, tickView, ALL } from './fixtures.js';
import { silentWav, toBase64 } from '../js/radio.js'; // v1.1 PAGE-RADIO
import { CAM_FILMED, camClips, PEOPLE } from './fixtures.js'; // v1.2 PAGE-CAM
import { cleanCheckpoints } from '../shared/rules.js'; // v1.3 PAGE-SETUP
import { lobbyCp } from './cpsetup-fixtures.js'; // v1.3 PAGE-SETUP
import { strikeCp } from './cpafter-fixtures.js'; // v1.3 PAGE-AFTER

// v1.2 PAGE-CAM: a 3 s WebM drawn here (a moving bar and the time), made once, for the preview's clip links.
let webm = null;
function previewWebm() {
  if (webm) return webm;
  webm = new Promise((resolve) => {
    try {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 240;
      const g = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      rec.onstop = () => resolve(URL.createObjectURL(new Blob(parts, { type: 'video/webm' })));
      const t0 = performance.now();
      const draw = () => {
        const t = performance.now() - t0;
        g.fillStyle = '#1b2330'; g.fillRect(0, 0, 320, 240);
        g.fillStyle = '#4ea8ff'; g.fillRect((t / 10) % 320, 90, 60, 60);
        g.fillStyle = '#e6ebf2'; g.font = '700 28px sans-serif'; g.fillText(`${(t / 1000).toFixed(1)} s`, 16, 40);
        if (t < 3000) requestAnimationFrame(draw); else rec.stop();
      };
      rec.start(500);
      draw();
    } catch { resolve(''); }
  });
  return webm;
}
// v1.2 end PAGE-CAM

const params = Object.fromEntries(new URLSearchParams(location.search));
// v1.3 PAGE-PLAY: a checkpoint photo for the preview: a small JPEG with a coloured sky and the id's first letters
function previewPhoto(id) {
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = 180;
  const g = c.getContext('2d');
  const hue = parseInt(String(id).slice(0, 2), 16) || 200;
  const grad = g.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, `hsl(${hue}, 60%, 45%)`);
  grad.addColorStop(1, `hsl(${(hue + 50) % 360}, 50%, 15%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 240, 180);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = 'bold 28px sans-serif';
  g.fillText(String(id).slice(0, 4).toUpperCase(), 20, 160);
  return c.toDataURL('image/jpeg', 0.7);
}
// v1.3 end PAGE-PLAY
// v1.2 PAGE-MAP: &text=130 makes the text 130% (a phone's bigger text), &safe=47,34 stands in for an iPhone's
// notch and home bar (safe-area top, bottom in px)
if (/^\d{2,3}$/.test(params.text || '')) document.documentElement.style.fontSize = `${params.text}%`;
if (/^\d{1,3},\d{1,3}$/.test(params.safe || '')) {
  const [top, bottom] = params.safe.split(',');
  document.documentElement.style.setProperty('--safe-top', `${top}px`);
  document.documentElement.style.setProperty('--safe-bottom', `${bottom}px`);
}
// v1.2 end PAGE-MAP
// v1.2 PAGE-RADIO: &quiet=1 / &quiet=0 sets the hiders' Quiet before the page starts (kept per phone)
if (params.quiet === '1' || params.quiet === '0') {
  try { localStorage.setItem('nightops-quiet', params.quiet === '1' ? 'on' : 'off'); } catch { /* fine */ }
}
// v1.2 end PAGE-RADIO
const screen = (params.screen || 'home').toLowerCase().replace(/[^a-z-]/g, '') || 'home';
const ticking = params.tick === '1';
const log = [];

let fx = fixture({ ...params, screen });
let current = fx.view;

function say(...args) {
  log.push(args);
  console.info('[preview]', ...args);
}

function snapshot(since = 0) {
  if (!current) return null;
  const v = structuredClone(current);
  v.events = v.events.filter((e) => e.id > (Number(since) || 0));
  return v;
}

function pushEvent(e) {
  if (!current) return null;
  const id = (current.lastEventId || 0) + 1;
  const event = { id, at: current.now, clock: current.clock, ...e };
  current = { ...current, events: [...current.events, event], lastEventId: id };
  return event;
}

function side(me) {
  if (current.phase !== 'live' || me.status !== 'in') return 'all';
  return me.team === 'hunter' ? 'hunters' : me.team === 'hider' ? 'hiders' : 'all';
}

function onCmd(cmd) {
  say('cmd', cmd);
  if (!current || !cmd) return;
  if (cmd.type === 'chat' && typeof cmd.text === 'string' && cmd.text.trim()) {
    pushEvent({ kind: 'chat', to: side(current.me), text: cmd.text.trim().slice(0, 200), from: current.me.id });
  }
  // v1.3 PAGE-SETUP: the checkpoint editor's Save and the Checkpoints card's settings land at once
  if (cmd.type === 'checkpoints' && current.phase === 'lobby') {
    const list = cleanCheckpoints(cmd.list);
    current = { ...current, cp: lobbyCp(current, list) };
  } else if (cmd.type === 'settings' && cmd.settings && current.phase === 'lobby'
    && Object.keys(cmd.settings).some((k) => k === 'mode' || k.startsWith('cp'))) {
    current = { ...current, settings: { ...current.settings, ...cmd.settings } };
    if (current.settings.mode === 'checkpoints') current.cp = lobbyCp(current, current.cp && current.cp.list ? current.cp.list : []);
    else current.cp = null;
  }
  // v1.3 end PAGE-SETUP
  // v1.3 PAGE-AFTER: the host's Don't count / Count it again
  if (cmd.type === 'cpstrike' && current.cp && Number.isInteger(cmd.n)) {
    current = strikeCp(current, cmd);
    const d = current.cp.done.find((x) => x.n === cmd.n);
    if (d) pushEvent({ kind: 'checkpoint', to: 'all', text: cmd.struck ? `The host didn't count ${d.name}'s checkpoint ${d.k + 1}.` : `The host counts ${d.name}'s checkpoint ${d.k + 1} again.`, data: { what: 'strike', n: d.n, pid: d.pid, struck: !!cmd.struck } });
  }
  // v1.3 end PAGE-AFTER
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const api = {
  base: 'preview',
  async post(action, body = {}) {
    await delay(40);
    switch (action) {
      case 'sync':
        return { ok: true, view: snapshot(body.since) };
      // v1.1 PAGE-WATCH: a spectator's actions
      case 'wsync':
        return { ok: true, view: snapshot(body.since) };
      case 'wleave':
        say('wleave', body.watcher && body.watcher.id);
        return { ok: true };
      case 'watch': {
        say('watch', { code: body.code, name: body.name });
        fx = fixture({ screen: 'watch', state: 'lobby' });
        current = fx.view;
        return { ok: true, code: fx.watch.code, watcher: { id: fx.watch.id, secret: fx.watch.secret }, view: snapshot(0) };
      }
      // v1.1 end PAGE-WATCH
      // v1.1 PAGE-RADIO: the walkie-talkie: a sent clip is logged; any clip is a short silent sound
      case 'radio':
        say('radio', { type: body.type, ms: body.ms, letters: String(body.audio || '').length });
        return { ok: true, view: snapshot(body.since), clip: { n: 99, clock: current ? current.clock : 0 } };
      case 'clip': {
        say('clip', body.n);
        const c = (current && current.summary && Array.isArray(current.summary.radio) ? current.summary.radio : [])
          .concat(current && current.radio ? current.radio.clips : []).find((x) => x.n === body.n);
        const wav = silentWav(Math.min(15000, (c && c.ms) || 1500));
        return { ok: true, clip: { n: body.n, from: c ? c.from : '', clock: c ? c.clock : 0, ms: c ? c.ms : 1500, type: 'audio/wav', audio: toBase64(wav) } };
      }
      // v1.1 end PAGE-RADIO
      // v1.2 PAGE-CAM: the camera's actions (cam=1): every clip is up, each link a short WebM made here
      case 'cam-list': {
        const list = camClips(current && current.clock);
        const progress = CAM_FILMED.map((k) => {
          const id = PEOPLE[k].id;
          const done = list.filter((c) => c.pid === id);
          return { pid: id, done: done.length, bytes: done.reduce((t, c) => t + c.bytes, 0), have: k === 'mia' ? null : { count: done.length + (k === 'ava' ? 2 : 0), bytes: 0 } };
        });
        return { ok: true, mode: 'highlights', round: current ? current.round : 0, clips: list, progress, kept: current && current.cam ? current.cam.kept : null };
      }
      case 'cam-urls': {
        const url = await previewWebm();
        return { ok: true, urls: Object.fromEntries((body.ids || []).map((id) => [id, url])) };
      }
      case 'cam-have':
      case 'cam-done':
      case 'cam-upload':
        say(action, body);
        return { ok: true, skip: true, id: body.clip ? body.clip.id : body.id };
      case 'cam-keep': {
        say('cam-keep', body.keep);
        const kept = body.keep ? Date.now() + 30 * 24 * 3600 * 1000 : null;
        if (current && current.cam) current = { ...current, cam: { ...current.cam, kept } };
        return { ok: true, kept, released: [] };
      }
      // v1.2 end PAGE-CAM
      // v1.3 PAGE-PLAY: checkpoint photos: every photo is a small JPEG drawn here; a sent one counts at once
      case 'cp-photos':
        return { ok: true, photos: Object.fromEntries((body.ids || []).map((id) => [id, previewPhoto(id)])) };
      case 'cp-photo': {
        say('cp-photo', { k: body.k, bytes: Math.round(String(body.photo || '').length * 0.75) });
        if (current && current.cp && current.cp.mine) {
          const n = (current.cp.done || []).length + 1;
          const done = { n, k: body.k, pid: current.me.id, name: current.me.name, clock: current.clock, how: 'photo', photo: 'f0e1d2c3b4a59687', struck: false };
          current = { ...current, cp: { ...current.cp, done: [...current.cp.done, done], mine: { ...current.cp.mine, did: true, canPhoto: false } } };
          pushEvent({ kind: 'checkpoint', to: 'hiders', text: `${current.me.name} did checkpoint ${body.k + 1}: ${current.cp.active ? current.cp.active.name : ''}.`, data: { what: 'done', n, k: body.k, pid: current.me.id, photo: done.photo, how: 'photo' } });
        }
        return { ok: true, view: snapshot(body.since), done: { n: 3, k: body.k } };
      }
      // v1.3 end PAGE-PLAY
      case 'cmd':
        onCmd(body.cmd);
        return { ok: true, view: snapshot(body.since) };
      case 'faces':
        say('faces', body.ids);
        return { ok: true, faces: Object.fromEntries((body.ids || []).map((id) => [id, faceFor(id)])) };
      case 'face':
        say('face', `${String(body.face || '').length} letters`);
        return { ok: true, view: snapshot(body.since) };
      case 'create':
      case 'join': {
        say(action, { code: body.code, name: body.name, face: body.face ? 'yes' : 'no' });
        fx = fixture({ screen: 'lobby', host: action === 'create' ? '1' : '0' });
        current = fx.view;
        return { ok: true, code: fx.game.code, player: { id: fx.game.id, secret: fx.game.secret }, view: snapshot(0) };
      }
      default:
        throw new ApiError({ code: 'bad_cmd', message: 'The preview does not know that.', fromServer: true, status: 400 });
    }
  },
};

function mySpot() {
  if (!current) return null;
  const mine = current.marks.find((m) => m.id === current.me.id && (m.kind === 'self' || m.kind === 'hunter'));
  if (mine) return mine.p;
  return current.ring ? ringCenter(current.ring) : [-79.4135, 43.6475];
}

const fakeLocation = {
  start() { say('location', 'start'); },
  stop() { say('location', 'stop'); },
  latest() {
    const p = mySpot();
    return p ? { p: p.slice(), acc: 8, speed: 0.6, at: Date.now() } : null;
  },
  status: () => 'ok',
  running: () => true,
  on: () => () => {},
};

// A screen that doesn't exist yet: say so, and show what the sample view holds.
function missing(name, error) {
  return {
    mount(root, app) {
      const body = h('div');
      const card = h('div.app-card', { style: { textAlign: 'left', justifyItems: 'stretch', width: 'min(100%, 560px)' } },
        h('span.label', 'Preview'),
        h('h2', `screens/${name}.js isn't built yet`),
        h('p.app-detail', error && error.message ? error.message : ''),
        body,
        h('span.label', 'Other samples'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          ALL.map((p) => {
            const q = new URLSearchParams(p).toString();
            return h('a.chip', { href: `?${q}` }, Object.values(p).join(' '));
          })));
      root.classList.add('screen-error');
      fill(root, card);
      const draw = (view) => {
        if (!view) {
          fill(body, h('p.app-line', `No game. Saved name: ${app.me ? app.me.name : 'none'}.` +
            (app.args && app.args.code ? ` Join code from the link: ${app.args.code}.` : '')));
          return;
        }
        const me = view.me;
        const t = view.timing || {};
        const time = (ms) => (ms === null || ms === undefined ? '-' : fmtClock(ms));
        fill(body,
          h('p.mono', `${view.code} · ${view.phase}${view.sub ? ` / ${view.sub}` : ''}${view.paused ? ' · paused' : ''}`),
          h('p.app-line', `You: ${me.name}${me.host ? ' (host)' : ''}, ${me.team || 'no team yet'}, ${me.status}`),
          h('p.app-line', `Players: ${view.players.map((p) => `${p.name}${p.team ? ` (${p.team}${p.status !== 'in' ? `, ${p.status}` : ''})` : ''}`).join(', ')}`),
          view.phase === 'live'
            ? h('p.mono', `head start ${time(t.headStartLeft)} · left ${time(t.left)} · ping ${t.pingN ?? '-'} in ${time(t.nextPingIn)}`)
            : null,
          view.marks.length ? h('p.app-line', `Marks: ${view.marks.map((m) => `${m.kind} ${m.label}`).join(', ')}`) : null,
          view.summary ? h('p.app-line', `Winners: ${view.summary.winners.map((id) => view.players.find((p) => p.id === id)?.name).join(', ')}`) : null,
          h('span.label', `Last events (${view.events.length})`),
          h('ul.plain-list', view.events.slice(-5).map((e) => h('li.app-line', e.text))));
      };
      draw(app.view);
      return { update: draw, destroy() {} };
    },
  };
}

async function loadScreen(name, attempt) {
  const url = `../js/screens/${name}.js${attempt ? `?try=${attempt}` : ''}`;
  try {
    return await import(url);
  } catch (e) {
    return missing(name, e);
  }
}

const identityStore = new Map();
const identity = createIdentity(() => ({
  getItem: (k) => (identityStore.has(k) ? identityStore.get(k) : null),
  setItem: (k, v) => identityStore.set(k, String(v)),
  removeItem: (k) => identityStore.delete(k),
}));
if (fx.me) identity.saveMe(fx.me);
if (fx.game) identity.saveGame(fx.game);
if (fx.watch) identity.saveWatch(fx.watch); // v1.1 PAGE-WATCH

const app = new App({
  api,
  identity,
  location: fakeLocation,
  alerts,
  root: document.getElementById('app'),
  store: memoryStore(),
  loadScreen,
  syncMs: ticking ? 1000 : 3600000,
  autoScreen: false,
});
app.watchMs = ticking ? 1000 : 3600000; // v1.1 PAGE-WATCH

if (ticking) {
  setInterval(() => {
    if (current) current = tickView(current, 1000);
  }, 1000);
}

window.__preview = {
  app,
  log,
  view: () => current,
  // Swap the sample data: __preview.set({ state: 'paused' }) or __preview.set({ screen: 'over' }).
  set(next = {}) {
    fx = fixture({ ...params, screen, ...next });
    current = fx.view;
    return app.syncNow();
  },
  push(e) {
    const event = pushEvent(e);
    app.syncNow();
    return event;
  },
};

if (screen === 'home' || !fx.game) {
  app.start({ code: params.code || '' });
  // a spectator's game over is the normal end screen (app.js watchScreen)
  if (screen !== 'home') app.go(screen === 'watch' && params.state === 'over' ? 'over' : screen);
} else {
  app.start({});
  app.syncNow().then(() => app.go(screen));
}
// v1.2 PAGE-MAP: &replay=1 opens the end screen's replay layer
if (screen === 'over' && params.replay === '1') {
  const openReplay = (tries = 0) => {
    const b = document.querySelector('.over-watch-replay');
    if (b && !b.hidden) b.click();
    else if (tries < 40) setTimeout(() => openReplay(tries + 1), 150);
  };
  setTimeout(openReplay, 300);
}
// v1.2 end PAGE-MAP
