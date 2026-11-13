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

const params = Object.fromEntries(new URLSearchParams(location.search));
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
