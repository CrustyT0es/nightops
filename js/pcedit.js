// Night Ops v1.5: the PC edit. A phone links once to the owner's PC (Jarvis's "Night Ops videos": Settings > Link Night
// Ops shows a code); from then on the rounds this phone plays in or watches are made into a YouTube-style edit on that
// PC, and the end screen's Movies card shows it first. Plain ES module; every word is set with textContent.
//
//   deviceSecret(storage)        this phone's own 32-hex secret (localStorage 'nightops-device'), made once
//   linkedPc(storage) / rememberPc(storage, name)   the PC this phone linked to ('nightops-pc')
//   cleanPair(text)              a typed code as the server takes it ('ab cd-efgh' -> 'ABCDEFGH') or ''
//   proState(maker)              the maker-movies answer as words: { show, title, sub, ready, files, pct }
//   proRows(maker, { onWatch, onDownload }) -> element | null   the Movies card's PC rows (first in the card)
//   linkSheet({ onLink, doc }) -> { el, set(state) }            "Link my PC": a box for the code and a button
import { h, text } from './dom.js?v=176';
import { icon } from './ui/icons.js?v=176';

export const DEVICE_KEY = 'nightops-device';
export const PC_KEY = 'nightops-pc';
const HEX32 = /^[0-9a-f]{32}$/;
const PAIR = /^[2-9A-HJKMNP-Z]{8}$/;

function read(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
function write(storage, key, value) {
  try { if (storage) storage.setItem(key, value); return true; } catch { return false; }
}

let memoryDevice = null;
export function deviceSecret(storage = globalThis.localStorage, random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const have = read(storage, DEVICE_KEY);
  if (typeof have === 'string' && HEX32.test(have)) return have;
  const hex = Array.from(random(16), (b) => b.toString(16).padStart(2, '0')).join('');
  if (write(storage, DEVICE_KEY, hex)) return hex;
  if (!memoryDevice) memoryDevice = hex; // (no storage: one for this visit)
  return memoryDevice;
}

export function linkedPc(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(read(storage, PC_KEY) || 'null');
    return v && typeof v.name === 'string' ? { name: v.name.slice(0, 30), at: Number(v.at) || 0 } : null;
  } catch { return null; }
}

export function rememberPc(storage, name, at = Date.now()) {
  return write(storage, PC_KEY, JSON.stringify({ name: String(name || '').slice(0, 30), at }));
}

export function cleanPair(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  return PAIR.test(s) ? s : '';
}

const owner = (by) => (by ? `${by}'s PC` : 'the PC');

export function proState(maker) {
  if (!maker || typeof maker !== 'object') return { show: false };
  const by = typeof maker.by === 'string' ? maker.by.slice(0, 30) : '';
  const pct = Number.isFinite(maker.progress) ? Math.max(0, Math.min(100, Math.round(maker.progress))) : 0;
  if (maker.status === 'ready' && maker.files && maker.files.highlights) {
    const note = typeof maker.note === 'string' && maker.note ? ` · ${maker.note.slice(0, 80)}` : ''; // "Subtitles: ElevenLabs"
    return { show: true, ready: true, title: 'Pro edit', sub: `Made on ${owner(by)}${note}`, files: maker.files, pct: 100 };
  }
  if (maker.status === 'making' && maker.files && maker.files.highlights) {
    // The highlights came first: watchable now, the rest still on the way.
    return { show: true, ready: true, title: 'Pro edit', sub: `Made on ${owner(by)} · the rest is still being made (${pct}%)`, files: maker.files, pct };
  }
  if (maker.status === 'making') {
    const note = typeof maker.note === 'string' && maker.note ? `${maker.note}, ` : '';
    return { show: true, ready: false, title: 'The pro edit is being made…', sub: `${note}${pct}% on ${owner(by)}`, pct };
  }
  if (maker.status === 'queued') {
    return { show: true, ready: false, title: 'The pro edit is being made…', sub: `Waiting for ${owner(by)} (it starts when everyone's clips are up)`, pct: 0 };
  }
  if (maker.status === 'failed') {
    return { show: true, ready: false, failed: true, title: "The pro edit didn't work", sub: typeof maker.note === 'string' && maker.note ? maker.note.slice(0, 120) : 'The movies below still work.', pct: 0 };
  }
  return { show: false };
}

function lengthOf(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The Movies card's first rows: the PC's edit (Watch and Download the highlights; the vertical cut and the whole game
// as downloads), or how far it's got.
export function proRows(maker, { onWatch = () => {}, onDownload = () => {} } = {}) {
  const st = proState(maker);
  if (!st.show) return null;
  const head = h('div.over-pro-words', h('span.over-movie-name.over-pro-name', st.title), h('span.over-movie-sub.over-pro-sub', st.sub));
  if (!st.ready) {
    const bar = h('div.over-pro-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(st.pct) },
      h('span.over-pro-fill', { style: { width: `${st.pct}%` } }));
    return h(`div.over-pro.${st.failed ? 'is-failed' : 'is-making'}`, head, st.failed ? null : bar);
  }
  const f = st.files;
  const watch = h('button.btn.small.primary.over-pro-watch', { type: 'button' }, icon('play', 16), h('span', 'Watch'));
  const down = h('button.btn.small.ghost.over-pro-down', { type: 'button', 'aria-label': 'Download the pro edit' }, h('span', 'Download'));
  watch.addEventListener('click', () => onWatch('highlights', f.highlights));
  down.addEventListener('click', () => onDownload('highlights', f.highlights));
  const extra = [];
  const more = [['vertical', 'Download the vertical cut', 'for your phone, about a minute'], ['whole', 'The whole game', 'start to end, with chapters']];
  for (const [kind, label, line] of more) {
    if (!f[kind]) continue;
    const b = h('button.btn.small.ghost.over-pro-more', { type: 'button', 'data-kind': kind },
      h('span', label), h('span.over-movie-sub', [lengthOf(f[kind].ms), line].filter(Boolean).join(' · ')));
    b.addEventListener('click', () => (kind === 'whole' ? onWatch(kind, f[kind]) : onDownload(kind, f[kind])));
    extra.push(b);
  }
  const len = lengthOf(f.highlights.ms);
  if (len) text(head.lastChild, `${st.sub} · ${len}`);
  return h('div.over-pro.is-ready', h('div.over-movie-row.k-pro', head, watch, down), extra.length ? h('div.over-pro-extra', ...extra) : null);
}

// "Link my PC": type the code the PC shows (Jarvis > Settings > Night Ops > Link Night Ops).
export function linkSheet({ onLink = async () => {}, linked = null } = {}) {
  const input = h('input.input.pc-code', {
    type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '11',
    placeholder: 'ABCD-EFGH', 'aria-label': 'The code on your PC',
  });
  const say = h('p.pc-say', { role: 'status', 'aria-live': 'polite' });
  const go = h('button.btn.primary.pc-go', { type: 'button' }, h('span', 'Link my PC'));
  const intro = h('p.pc-intro', 'On your PC, open Jarvis, then Settings, Night Ops, Link Night Ops. Type the code it shows. '
    + 'From then on, the games you play or watch are made into a pro edit on that PC.');
  const now = h('p.pc-now');
  if (linked && linked.name) text(now, `Linked to ${linked.name}'s PC. Link again to change it.`);
  const el = h('div.pc-link', intro, now, input, go, say);
  let busy = false;
  const send = async () => {
    if (busy) return;
    const code = cleanPair(input.value);
    if (!code) { text(say, 'Codes have 8 letters and numbers, like ABCD-EFGH.'); return; }
    busy = true;
    go.disabled = true;
    text(say, 'Linking…');
    try {
      const name = await onLink(code);
      text(say, name ? `Linked to ${name}'s PC.` : 'Linked to your PC.');
      input.value = '';
    } catch (e) {
      text(say, e && e.message ? e.message : "That didn't work. Try again.");
    } finally {
      busy = false;
      go.disabled = false;
    }
  };
  go.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  return { el, input, say, send };
}
