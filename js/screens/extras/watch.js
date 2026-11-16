// Night Ops: the lobby's Spectators row (v1.1, PAGE-WATCH). extraRow(ctx) -> { el, update(view) }
//   ctx = { app, host, setSetting(key, value), cmd(cmd) -> Promise }
// The host: the switch. When on (everyone sees this): the watch link with Copy, Share and a QR code, and
// "N watching"; the host also gets each spectator with Remove. Not the host: the setting in words.
import { h, fill, text } from '../../dom.js?v=146';
import { icon } from '../../ui/icons.js?v=146';
import { openSheet } from '../../ui/sheet.js?v=146';
import { banner } from '../../ui/banner.js?v=146';
import { qrSvg } from '../../qr.js?v=146';
import { EXTRAS_UI } from '../../../shared/rules.js?v=146';

const ITEM = EXTRAS_UI.find((x) => x.key === 'spectators') || {
  key: 'spectators', label: 'Spectators', hint: 'Friends can watch the game 2 minutes behind. They never see chats.',
};

// ---- pure helpers (tested in Node) ------------------------------------------------------------------------

export function spectatorsOn(view) {
  const s = view && view.settings;
  return !(s && s.spectators === false);
}

// The words beside the link: "Nobody is watching yet." / "1 watching" / "3 watching".
export function watchCountWords(n) {
  const k = Number(n) || 0;
  return k > 0 ? `${k} watching` : 'Nobody is watching yet.';
}

// The host's list: [{ id, name }] with names cleaned up and no duplicates.
export function watcherRows(view) {
  const list = view && Array.isArray(view.watchers) ? view.watchers : [];
  const seen = new Set();
  const out = [];
  for (const w of list) {
    if (!w || typeof w.id !== 'string' || seen.has(w.id)) continue;
    seen.add(w.id);
    out.push({ id: w.id, name: String(w.name || 'Someone').slice(0, 40) });
  }
  return out;
}

async function copyText(words) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(words);
      return true;
    }
  } catch { /* try the old way */ }
  let ok = false;
  const ta = h('textarea.sr-only', { readonly: '', 'aria-hidden': 'true', tabindex: '-1' });
  ta.value = words;
  document.body.appendChild(ta);
  try {
    ta.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function byHand(words) {
  const box = h('input.field.lobby-copy-box', { type: 'text', readonly: '', value: words, 'aria-label': 'The watch link' });
  box.addEventListener('focus', () => box.select());
  openSheet({
    title: 'The watch link',
    body: [h('p', "This phone wouldn't copy it. Press and hold the text below, then choose Copy."), box],
    actions: [{ label: 'Done', kind: 'primary' }],
  });
}

// ---- the row ----------------------------------------------------------------------------------------------

export function extraRow(ctx = {}) {
  const app = ctx.app || {};
  const host = !!ctx.host;
  let view = null;
  const busy = new Set();

  const code = () => (view && view.code) || '';
  const link = () => {
    try { return typeof app.watchLink === 'function' ? app.watchLink(code()) : ''; } catch { return ''; }
  };

  const label = h('div.lobby-set-label.x-watch-label-row', icon('eye', 20), h('span', ITEM.label));
  const hint = h('span.lobby-set-hint', ITEM.hint);
  let control;
  let sw = null;
  if (host) {
    sw = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'true', 'aria-label': ITEM.label });
    sw.addEventListener('click', () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      try { ctx.setSetting && ctx.setSetting('spectators', on); } catch (e) { console.error(e); }
    });
    control = sw;
  } else {
    control = h('span.lobby-set-value');
  }
  const head = h('div.lobby-set.row.x-watch-head', { 'data-key': 'spectators', 'data-anchor': '' }, label, control, hint);

  // When on: the link and who's watching.
  const copyBtn = h('button.btn.small', { type: 'button', 'aria-label': 'Copy the watch link' }, icon('copy', 18), 'Copy');
  const shareBtn = h('button.btn.small', { type: 'button', 'aria-label': 'Share the watch link' }, icon('share', 18), 'Share');
  const qrBtn = h('button.btn.small', { type: 'button', 'aria-label': 'Show a QR code to watch' }, icon('qr', 18), 'QR code');
  copyBtn.addEventListener('click', async () => {
    const l = link();
    if (!l) return;
    if (await copyText(l)) banner('Watch link copied.', 'good', 2500);
    else byHand(l);
  });
  shareBtn.addEventListener('click', async () => {
    const l = link();
    if (!l) return;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Night Ops', text: `Watch our Night Ops game (2 minutes behind). The code is ${code()}.`, url: l });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    if (await copyText(l)) banner('Watch link copied. Paste it to whoever wants to watch.', 'good', 3000);
    else byHand(l);
  });
  qrBtn.addEventListener('click', () => {
    const l = link();
    if (!l) return;
    const size = Math.min(260, Math.max(180, (window.innerWidth || 360) - 120));
    openSheet({
      title: 'Scan to watch',
      className: 'lobby-qr-sheet',
      body: h('div.lobby-qr',
        h('div.lobby-qr-box', qrSvg(l, { size, label: `QR code to watch game ${code()}` })),
        h('p', 'Point another phone camera at the code. It opens Night Ops to watch this game, 2 minutes behind.'),
        h('p.lobby-qr-link', l)),
      actions: [{
        label: 'Copy the link',
        keepOpen: true,
        onClick: async () => { if (await copyText(l)) banner('Watch link copied.', 'good', 2500); else byHand(l); },
      }, { label: 'Done', kind: 'primary' }],
    });
  });
  const count = h('p.x-watch-count', icon('eye', 16), h('span'));
  const list = h('ul.x-watchers', { role: 'list', 'aria-label': 'Watching' });
  const more = h('div.x-watch-more',
    h('span.label.x-watch-label', 'Watch link'),
    h('div.x-watch-btns', copyBtn, shareBtn, qrBtn),
    count,
    list);

  const el = h('div.x-row.x-watch', head, more);

  function remove(w, btn) {
    if (busy.has(w.id)) return;
    busy.add(w.id);
    btn.disabled = true;
    Promise.resolve(ctx.cmd ? ctx.cmd({ type: 'unwatch', watcherId: w.id }) : null)
      .catch(() => null)
      .then((res) => {
        busy.delete(w.id);
        if (btn.isConnected) btn.disabled = false;
        if (res && !res.error) banner(`${w.name} isn't watching any more.`, 'info', 2500);
      });
  }

  function update(v) {
    if (!v) return;
    view = v;
    const on = spectatorsOn(v);
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    else text(control, on ? 'On' : 'Off');
    more.hidden = !on;
    text(count.querySelector('span'), watchCountWords(v.watching));
    const rows = host ? watcherRows(v) : [];
    const sig = rows.map((r) => `${r.id}:${r.name}`).join('|');
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      fill(list, rows.map((w) => {
        const btn = h('button.btn.small.ghost.x-unwatch', { type: 'button', 'aria-label': `Stop ${w.name} watching` }, 'Remove');
        btn.addEventListener('click', () => remove(w, btn));
        return h('li.x-watcher', icon('eye', 16), h('span.x-watcher-name', w.name), btn);
      }));
    }
    list.hidden = !rows.length;
  }

  return { el, update };
}
