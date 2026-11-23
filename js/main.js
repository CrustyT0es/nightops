// Night Ops: boot. Reads the invite code (?code=) and the saved identity, makes the App and shows the first
// screen: the saved game when there is one (a reload or a crash mid-game), else home.
import { createAlarm } from './hack.js?v=166';
import { createWiretap } from './wiretap.js?v=166'; // v1.4 PAGE-PLAY
import { App, normalizeCode } from './app.js?v=166';
import { createApi } from './api.js?v=166';
import * as identity from './identity.js?v=166';
import { createLocation } from './location.js?v=166';
import * as alerts from './alerts.js?v=166';

function inviteCode() {
  try {
    const url = new URL(globalThis.location.href);
    const code = normalizeCode(url.searchParams.get('code') || '') ||
      normalizeCode(/(?:^|[#&])code=([^&]+)/.exec(url.hash.slice(1))?.[1] || '');
    if (url.searchParams.has('code') || /(?:^|[#&])code=/.test(url.hash.slice(1))) {
      // Keep the address clean: a reload then resumes the game instead of asking to join again.
      url.searchParams.delete('code');
      const hash = url.hash.replace(/(^#|&)code=[^&]*/, '').replace(/^#&/, '#');
      history.replaceState(history.state, '', `${url.pathname}${url.search}${hash === '#' ? '' : hash}`);
    }
    return code;
  } catch {
    return '';
  }
}

// v1.1 PAGE-WATCH: ?watch=CODE (or #watch=CODE) opens "Watch game CODE"; taken out of the address like ?code=.
function watchCode() {
  try {
    const url = new URL(globalThis.location.href);
    const code = normalizeCode(url.searchParams.get('watch') || '') ||
      normalizeCode(/(?:^|[#&])watch=([^&]+)/.exec(url.hash.slice(1))?.[1] || '');
    if (url.searchParams.has('watch') || /(?:^|[#&])watch=/.test(url.hash.slice(1))) {
      url.searchParams.delete('watch');
      const hash = url.hash.replace(/(^#|&)watch=[^&]*/, '').replace(/^#&/, '#');
      history.replaceState(history.state, '', `${url.pathname}${url.search}${hash === '#' ? '' : hash}`);
    }
    return code;
  } catch {
    return '';
  }
}
// v1.1 end PAGE-WATCH

// v1.4.1: #past=CODE.ROUND.ID.SECRET (a link made for a game kept before Your games existed) adds that round to
// Your games as a spectator's, then leaves the address. Only the hash is read, so the secret never reaches a server
// log; it's taken out of the address at once.
function takePastLink(store = identity) {
  try {
    const url = new URL(globalThis.location.href);
    const m = /(?:^|[#&])past=([^&]+)/.exec(url.hash.slice(1));
    if (!m) return false;
    const hash = url.hash.replace(/(^#|&)past=[^&]*/, '').replace(/^#&/, '#');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${hash === '#' ? '' : hash}`);
    const [code, round, id, secret] = decodeURIComponent(m[1]).split('.');
    const r = Number(round);
    if (!Number.isSafeInteger(r)) return false;
    const g = store.rememberPast({ code: normalizeCode(code || ''), round: r, id, secret, as: 'watcher', when: r, role: '', result: '' });
    return g !== false;
  } catch {
    return false;
  }
}

function boot() {
  takePastLink();
  const root = document.getElementById('app');
  const config = globalThis.NIGHTOPS || {};
  const api = createApi(config.api || '/api', { key: config.key || '' });
  const app = new App({ api, identity, location: createLocation(), alerts, root });
  // For the end-to-end tests and for poking around in the browser console.
  app.alarm = createAlarm(app); // v1.4 Hacker
  app.wiretap = createWiretap(app); // v1.4 PAGE-PLAY: the hider's phone records when the hunters listen in
  globalThis.nightops = app;
  app.start({ code: inviteCode(), watch: watchCode() }); // v1.1 PAGE-WATCH: watch
  return app;
}

try {
  boot();
} catch (e) {
  console.error(e);
  const root = document.getElementById('app');
  if (root) {
    root.replaceChildren();
    const p = document.createElement('p');
    p.className = 'boot-line';
    p.textContent = "Night Ops couldn't start on this browser. Try updating it, or open the link in Safari or Chrome.";
    root.appendChild(p);
  }
}
