// Night Ops: boot. Reads the invite code (?code=) and the saved identity, makes the App and shows the first
// screen: the saved game when there is one (a reload or a crash mid-game), else home.
import { App, normalizeCode } from './app.js';
import { createApi } from './api.js';
import * as identity from './identity.js';
import { createLocation } from './location.js';
import * as alerts from './alerts.js';

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

function boot() {
  const root = document.getElementById('app');
  const config = globalThis.NIGHTOPS || {};
  const api = createApi(config.api || '/api', { key: config.key || '' });
  const app = new App({ api, identity, location: createLocation(), alerts, root });
  // For the end-to-end tests and for poking around in the browser console.
  globalThis.nightops = app;
  app.start({ code: inviteCode() });
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
