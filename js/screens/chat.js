// Night Ops: the chat. Team chat with the game's events inside it, as a full-height sheet over the game.
//
//   openChat(app, { onClose }) -> { el, close(), isOpen(), refresh() }
//       The sheet: every event this phone may see (the server already filtered them: your side's chat and news,
//       plus everything sent to all), chat as bubbles (yours on the right), game events as small centred lines
//       with the time. A text box (Enter sends) and the quick buttons for your side. It stays scrolled to the
//       newest unless the player scrolled up ("New messages" then takes them down).
//   renderLines(container, events, app, { limit = 2 }) -> number shown
//       The newest chat messages as short one-line rows ("Mia: On my way"), for the game screen's panel.
//   sendChat(app, text) -> Promise<boolean>       QUICK, quickFor(view), sideKey(view), chatTitle(view) ...
//
// Never innerHTML: names and messages only ever go in as text.
import { h, fill, text, cls, face, listen } from '../dom.js?v=158';
import { icon } from '../ui/icons.js?v=158';
import { openSheet } from '../ui/sheet.js?v=158';
import { banner } from '../ui/banner.js?v=158';
import { LIMITS } from '../../shared/rules.js?v=158';
import { photoThumb, strikeActions } from './cpplay.js?v=158'; // v1.3 PAGE-PLAY

export const QUICK = Object.freeze({
  hunter: Object.freeze(['On my way', 'I see someone', 'Need backup']),
  hider: Object.freeze(['Moving', 'Staying put', 'Need help']),
  out: Object.freeze([]),
  all: Object.freeze([]),
});

const GROUP_MS = 3 * 60000;     // messages from the same person this close together share one name
const NEAR_BOTTOM_PX = 56;      // this close to the bottom counts as "reading the newest"
const COUNT_FROM = LIMITS.chat - 30;

// ---- pure helpers (no DOM) ------------------------------------------------------------------------------

// Whose chat this phone is in: 'hunter' | 'hider' | 'out' (sitting out, or anyone outside a live game: 'all').
export function sideKey(view) {
  if (!view || !view.me) return 'all';
  if (view.phase !== 'live') return 'all';
  if (view.me.status !== 'in') return 'out';
  if (view.me.team === 'hunter') return 'hunter';
  if (view.me.team === 'hider') return 'hider';
  return 'all';
}

export function quickFor(view) {
  return QUICK[sideKey(view)] || [];
}

export function chatTitle(view) {
  const k = sideKey(view);
  if (k === 'hunter') return 'Hunters chat';
  if (k === 'hider') return 'Hiders chat';
  return 'Chat with everyone';
}

export function whoSees(view) {
  const k = sideKey(view);
  if (k === 'hunter') return 'Only hunters see these messages.';
  if (k === 'hider') return 'Only hiders see these messages.';
  if (k === 'out') return "You're sitting out: everyone in the game sees your messages.";
  return 'Everyone in the game sees these messages.';
}

export function placeholderFor(view) {
  const k = sideKey(view);
  if (k === 'hunter') return 'Message the hunters';
  if (k === 'hider') return 'Message the hiders';
  return 'Message everyone';
}

export function isChat(e) {
  return !!e && e.kind === 'chat' && typeof e.text === 'string' && e.text.trim() !== '';
}

export function chatMessages(events) {
  return (Array.isArray(events) ? events : []).filter(isChat);
}

// What a player typed, tidied: one line, trimmed ('' = nothing to send).
export function tidyText(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function letters(s) {
  return Array.from(String(s ?? '')).length;
}

// '9:41 PM' for an epoch time ('' when there's none).
export function timeOf(at) {
  if (!Number.isFinite(at) || at <= 0) return '';
  try {
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    const d = new Date(at);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

function playerIn(view, id) {
  const list = view && Array.isArray(view.players) ? view.players : [];
  return list.find((p) => p && p.id === id) || null;
}

export function nameOf(view, id) {
  const p = playerIn(view, id);
  return p && p.name ? String(p.name) : 'Someone';
}

// A player's colour: 'hunter' | 'hider' | 'out'.
export function teamOf(view, id) {
  const p = playerIn(view, id);
  if (!p) return 'out';
  if (p.status !== 'in') return 'out';
  return p.team === 'hunter' ? 'hunter' : p.team === 'hider' ? 'hider' : 'out';
}

// ---- sending ----------------------------------------------------------------------------------------------

// Sends a chat message. Resolves true when the server took it. The App shows a banner when it didn't.
export async function sendChat(app, raw) {
  const t = tidyText(raw);
  if (!t) return false;
  if (letters(t) > LIMITS.chat) {
    banner(`Keep it to ${LIMITS.chat} letters.`, 'warn');
    return false;
  }
  let res;
  try {
    res = await app.cmd({ type: 'chat', text: t });
  } catch {
    return false;
  }
  return !!res && !res.error;
}

// ---- the panel's last lines ------------------------------------------------------------------------------

// Fills container with the newest `limit` chat messages, one short row each. Returns how many it shows.
export function renderLines(container, events, app, { limit = 2 } = {}) {
  const view = app && app.view;
  const meId = view && view.me ? view.me.id : null;
  const list = chatMessages(events).slice(-Math.max(0, limit));
  fill(container, list.map((e) => {
    const mine = e.from === meId;
    const who = mine ? 'You' : nameOf(view, e.from);
    return h('span.chat-line',
      h(`span.chat-line-name.t-${mine ? 'me' : teamOf(view, e.from)}`, `${who}: `),
      h('span.chat-line-text', e.text));
  }));
  return list.length;
}

// ---- the sheet --------------------------------------------------------------------------------------------

export function openChat(app, { onClose = null } = {}) {
  const startView = app.view;
  let open = true;
  let sending = false;
  let lastKey = '';
  const rendered = new Map(); // event id -> li
  let lastId = 0;
  let newCount = 0;
  const offs = [];

  const who = h('p.chat-who');
  const list = h('ol.chat-list', { role: 'log', 'aria-label': 'Messages', tabindex: '0' });
  const newBtn = h('button.chat-new', { type: 'button', hidden: true }, icon('back', 16, 'chat-new-arrow'), h('span.chat-new-text', 'New messages'));
  const scrollBox = h('div.chat-scroll', list, newBtn);
  const quick = h('div.chat-quick', { role: 'group', 'aria-label': 'Quick messages' });
  const input = h('input.field.chat-input', {
    type: 'text',
    maxlength: String(LIMITS.chat),
    autocomplete: 'off',
    autocapitalize: 'sentences',
    spellcheck: 'true',
    enterkeyhint: 'send',
    'aria-label': 'Message',
    placeholder: placeholderFor(startView),
  });
  const sendBtn = h('button.btn.primary.icon-only.chat-send', { type: 'button', 'aria-label': 'Send' }, icon('send', 22));
  const count = h('p.chat-count', { 'aria-live': 'polite', hidden: true });
  const compose = h('div.chat-compose', input, sendBtn);
  const body = h('div.chat-wrap', who, scrollBox, quick, compose, count);

  const sheet = openSheet({
    title: chatTitle(startView),
    body,
    className: 'chat-sheet',
    onClose: () => {
      open = false;
      for (const off of offs.splice(0)) {
        try { off(); } catch { /* ignore */ }
      }
      if (typeof onClose === 'function') onClose();
    },
  });
  const titleEl = sheet.el.querySelector('.sheet-title');

  // ---- the list ----

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
  }
  function toBottom() {
    list.scrollTop = list.scrollHeight;
    newCount = 0;
    newBtn.hidden = true;
  }

  function entry(e, prev, view, meId) {
    if (isChat(e)) {
      const mine = e.from === meId;
      const cont = !!prev && isChat(prev) && prev.from === e.from && Number.isFinite(e.at) && Number.isFinite(prev.at) &&
        e.at - prev.at < GROUP_MS;
      const team = teamOf(view, e.from);
      const name = nameOf(view, e.from);
      const li = h(`li.chat-msg${mine ? '.mine' : ''}${cont ? '.cont' : ''}`, { 'data-id': String(e.id) });
      if (!mine) {
        if (cont) {
          li.appendChild(h('span.chat-face-gap', { 'aria-hidden': 'true' }));
        } else {
          const f = face({ name, src: app.faces && app.faces.get ? app.faces.get(e.from) : null, team, size: 28 });
          f.dataset.from = String(e.from || '');
          li.appendChild(f);
        }
      }
      const time = timeOf(e.at);
      li.appendChild(h('div.chat-bubble',
        !mine && !cont ? h(`span.chat-name.t-${team}`, name) : null,
        mine ? h('span.sr-only', 'You: ') : (cont ? h('span.sr-only', `${name}: `) : null),
        h('span.chat-text', e.text),
        time ? h('span.chat-time', { 'aria-hidden': 'true' }, time) : null));
      return li;
    }
    const time = timeOf(e.at);
    // v1.3 PAGE-PLAY: a checkpoint done with a photo shows it small (a tap opens it big)
    const cpd = e.kind === 'checkpoint' && e.data && e.data.what === 'done' && typeof e.data.photo === 'string' && e.data.photo
      ? h('span.chat-event-photo', photoThumb(app, e.data.photo, {
        title: String(e.text || 'Checkpoint photo').replace(/\.$/, ''), size: 64,
        actions: Number.isInteger(e.data.n) ? () => strikeActions(app, e.data.n) : null,
      }))
      : null;
    // v1.3 end PAGE-PLAY
    return h(`li.chat-event.k-${String(e.kind || 'info').replace(/[^a-z-]/g, '')}`, { 'data-id': String(e.id) },
      time ? h('span.chat-event-time', time) : null,
      h('span.chat-event-text', String(e.text || '')), cpd);
  }

  function showable(events) {
    return (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(e.id) && typeof e.text === 'string' && e.text.trim());
  }

  function rebuild() {
    const view = app.view;
    const meId = view && view.me ? view.me.id : null;
    const events = showable(view && view.events);
    rendered.clear();
    const items = [];
    let prev = null;
    for (const e of events) {
      const li = entry(e, prev, view, meId);
      rendered.set(e.id, li);
      items.push(li);
      prev = e;
    }
    lastId = events.length ? events[events.length - 1].id : 0;
    if (!items.length) {
      items.push(h('li.chat-empty', 'No messages yet. Say hi to your team.'));
    }
    fill(list, items);
  }

  function refresh() {
    if (!open) return;
    const view = app.view;
    if (!view) return;
    // The side can change (a hider who's caught joins the hunters): words and quick buttons follow.
    const key = sideKey(view);
    if (key !== lastKey) {
      lastKey = key;
      if (titleEl) text(titleEl, chatTitle(view));
      text(who, whoSees(view));
      input.placeholder = placeholderFor(view);
      const words = quickFor(view);
      fill(quick, words.map((w) => h('button.chip.chat-qbtn', { type: 'button', onclick: (ev) => quickSend(ev.currentTarget, w) }, w)));
      quick.hidden = !words.length;
    }
    const events = showable(view.events);
    const meId = view.me ? view.me.id : null;
    // Anything already shown that's gone (a new round, or the side changed): draw it all again.
    const ids = new Set(events.map((e) => e.id));
    let gone = false;
    for (const id of rendered.keys()) {
      if (!ids.has(id)) { gone = true; break; }
    }
    if (gone || (!rendered.size && events.length)) {
      const stick = nearBottom();
      rebuild();
      if (stick || !rendered.size) toBottom();
      return;
    }
    const fresh = events.filter((e) => e.id > lastId && !rendered.has(e.id));
    if (!fresh.length) return;
    const stick = nearBottom();
    const empty = list.querySelector('.chat-empty');
    if (empty) empty.remove();
    let prev = null;
    // The event shown just before the first fresh one, for grouping.
    const before = events.filter((e) => e.id < fresh[0].id);
    if (before.length) prev = before[before.length - 1];
    let mineNew = false;
    let othersNew = 0;
    for (const e of fresh) {
      const li = entry(e, prev, view, meId);
      rendered.set(e.id, li);
      list.appendChild(li);
      prev = e;
      if (isChat(e) && e.from === meId) mineNew = true;
      else othersNew += 1;
    }
    lastId = fresh[fresh.length - 1].id;
    if (stick || mineNew) {
      toBottom();
    } else if (othersNew) {
      newCount += othersNew;
      text(newBtn.querySelector('.chat-new-text'), newCount === 1 ? '1 new message' : `${newCount} new messages`);
      newBtn.hidden = false;
    }
  }

  function refreshFaces() {
    if (!open) return;
    for (const f of list.querySelectorAll('.face[data-from]')) {
      const id = f.dataset.from;
      const src = app.faces && app.faces.get ? app.faces.get(id) : null;
      const img = f.querySelector('img');
      if (src && (!img || img.getAttribute('src') !== src)) {
        const view = app.view;
        const nf = face({ name: nameOf(view, id), src, team: teamOf(view, id), size: 28 });
        nf.dataset.from = id;
        f.replaceWith(nf);
      }
    }
  }

  // ---- sending ----

  function showCount() {
    const n = letters(input.value);
    if (n >= COUNT_FROM) {
      const left = LIMITS.chat - n;
      text(count, left >= 0 ? `${left} letters left` : `${-left} letters too many`);
      count.hidden = false;
    } else if (!count.hidden) {
      count.hidden = true;
      text(count, '');
    }
  }

  async function send() {
    if (sending) return;
    const t = tidyText(input.value);
    if (!t) {
      input.focus();
      return;
    }
    sending = true;
    cls(sendBtn, 'busy', true);
    sendBtn.setAttribute('aria-disabled', 'true');
    let ok = false;
    try {
      ok = await sendChat(app, t);
    } finally {
      sending = false;
      cls(sendBtn, 'busy', false);
      sendBtn.removeAttribute('aria-disabled');
    }
    if (ok) {
      // Only clear what was sent: if they typed more meanwhile, keep it.
      if (tidyText(input.value) === t) input.value = '';
      showCount();
      refresh();
      toBottom();
    }
  }

  async function quickSend(btn, words) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    cls(btn, 'busy', true);
    let ok = false;
    try {
      ok = await sendChat(app, words);
    } finally {
      cls(btn, 'busy', false);
      btn.disabled = false;
    }
    if (ok) {
      try { app.alerts?.buzz?.('tap'); } catch { /* ignore */ }
      refresh();
      toBottom();
    }
  }

  offs.push(listen(input, 'keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  }));
  offs.push(listen(input, 'input', showCount));
  offs.push(listen(sendBtn, 'click', () => {
    send();
    // Keep the keyboard up on phones: the button took the focus away.
    try { input.focus({ preventScroll: true }); } catch { /* ignore */ }
  }));
  // Tapping send must not blur the box first (that drops the keyboard and moves the sheet on iPhones).
  offs.push(listen(sendBtn, 'pointerdown', (e) => { if (e.pointerType !== 'mouse') e.preventDefault(); }));
  offs.push(listen(newBtn, 'click', () => toBottom()));
  offs.push(listen(list, 'scroll', () => {
    if (!newBtn.hidden && nearBottom()) {
      newCount = 0;
      newBtn.hidden = true;
    }
  }, { passive: true }));

  // ---- the phone's keyboard ----
  // iPhones keep the page the same height when the keyboard opens and only shrink the "visual viewport": keep the
  // sheet inside what's visible so the text box sits right above the keyboard.
  const vv = globalThis.visualViewport;
  const layer = sheet.layer;
  function fitViewport() {
    if (!open || !vv || !layer) return;
    const stick = nearBottom();
    const hidden = Math.max(0, (globalThis.innerHeight || 0) - vv.height);
    if (hidden > 60) {
      layer.style.top = `${Math.round(vv.offsetTop)}px`;
      layer.style.bottom = 'auto';
      layer.style.height = `${Math.round(vv.height)}px`;
      layer.classList.add('chat-keyboard');
    } else {
      layer.style.top = '';
      layer.style.bottom = '';
      layer.style.height = '';
      layer.classList.remove('chat-keyboard');
    }
    if (stick) toBottom();
  }
  if (vv && typeof vv.addEventListener === 'function') {
    offs.push(listen(vv, 'resize', fitViewport));
    offs.push(listen(vv, 'scroll', fitViewport));
  }

  // ---- keeping up ----

  offs.push(app.on('view', () => refresh()));
  offs.push(app.on('faces', () => refreshFaces()));

  refresh();
  if (!rendered.size) rebuild();
  // Once laid out (the sheet slides in), start at the newest.
  toBottom();
  requestAnimationFrame(() => requestAnimationFrame(() => { if (open) toBottom(); }));

  return {
    el: sheet.el,
    close: () => sheet.close(),
    isOpen: () => open,
    refresh,
    input,
  };
}
