// Night Ops v1.4.7: camera uploads wait for wifi (Highlights and Everything alike).
//
//   netKind(nav) -> 'wifi' | 'cell' | 'none' | 'unknown'
//       navigator.connection.type where the phone tells it (Android Chrome); iPhones (Safari has no Network
//       Information API) and computers say nothing: 'unknown'
//   gateFor({ kind, choice, answered }) -> 'go' | 'wait' | 'ask' | 'later'
//       go: uploads may run; wait: a phone on mobile data (or no connection) holds them until wifi;
//       ask: nobody knows, so the card asks once "Are you on wifi?"; later: they said they'd upload on wifi
//   uploadStep({ state, left, filming, sending, tried }) -> 'run' | 'hold' | null
//       what the end screen's clips card does now: start uploading by itself, stop (wifi went), or nothing
//   createNetGate({ nav, storage, key }) -> gate   the gate of one round's clips on this phone
//       gate.kind, gate.state, gate.choice; gate.choose('now' | 'anyway' | 'later'); gate.on(fn) -> off(); destroy()
//       'later' (and any answer to the question) is remembered on the phone for that round, so the question is
//       asked once; opening the game again from Your games shows Upload my clips with no question.
//   leftWords(until, now) -> '23 hours left' | '29 days left' | '40 min left' | ''
//   untilOf({ view, list, now }) -> epoch | null   when this game's clips are deleted
// v1.5.2: every finished round is saved 30 days from its end (server/handler.js KEEP_ROUND_MS), so the line under
// Upload my clips counts days: "29 days left to upload. After that the clips are deleted."
export const KEEP_ROUND_MS = 30 * 24 * 60 * 60 * 1000;

export const NET_WORDS = {
  waiting: (n) => `Waiting for wifi to upload ${n} ${n === 1 ? 'clip' : 'clips'}.`,
  anyway: 'Upload now anyway',
  ask: (size) => `Are you on wifi? Clips are big (about ${size}).`,
  now: 'Upload now',
  later: "Wait, I'll upload later on wifi",
  laterLine: "No problem. Tap Upload my clips when you're on wifi.",
  left: (left) => `${left} to upload. After that the clips are deleted.`,
  gone: 'This game is being deleted.',
};

export function netKind(nav = globalThis.navigator) {
  let c = null;
  try { c = nav ? (nav.connection || nav.mozConnection || nav.webkitConnection || null) : null; } catch { c = null; }
  const type = c && typeof c.type === 'string' ? c.type.toLowerCase() : '';
  if (type === 'wifi' || type === 'ethernet') return 'wifi';
  if (type === 'cellular' || type === 'bluetooth' || type === 'wimax') return 'cell';
  if (type === 'none') return 'none';
  return 'unknown'; // '', 'other', 'unknown', or no API at all
}

export function gateFor({ kind = 'unknown', choice = null, answered = false } = {}) {
  if (choice === 'now' || choice === 'anyway') return 'go';
  if (kind === 'wifi') return 'go';
  if (kind === 'cell' || kind === 'none') return 'wait';
  if (choice === 'later' || answered) return 'later';
  return 'ask';
}

// tried: the card already started uploading since the gate last opened (a run that ended, or failed, isn't started
// again by itself in a loop: the button does that).
export function uploadStep({ state, left = 0, filming = false, sending = false, tried = false } = {}) {
  if (sending && state !== 'go') return 'hold';
  if (!left || filming || sending || tried) return null;
  return state === 'go' ? 'run' : null;
}

export function leftWords(until, now = Date.now()) {
  if (!Number.isFinite(until) || !Number.isFinite(now)) return '';
  const ms = until - now;
  if (ms <= 0) return '';
  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))} min left`;
  const h = Math.round(ms / 3600000);
  if (h < 48) return `${h} ${h === 1 ? 'hour' : 'hours'} left`;
  return `${Math.round(ms / 86400000)} days left`;
}

// Kept: its keep date (every finished round has one, v1.5.2). A game from Your games: the date the server gave. Else
// (the date not come yet, or an older server): 30 days from now, the keep date the server gives a round as it ends.
export function untilOf({ view = null, list = null, now = Date.now() } = {}) {
  const fin = (x) => (Number.isFinite(x) && x > now ? x : null);
  const kept = fin(list && list.kept) ?? fin(view && view.cam && view.cam.kept) ?? fin(view && view.kept)
    ?? fin(view && view.past && view.past.kept);
  if (kept !== null) return kept;
  if (view && view.past) return Number.isFinite(view.past.until) ? view.past.until : null;
  return now + KEEP_ROUND_MS;
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function createNetGate({ nav = globalThis.navigator, storage = defaultStorage(), key = '' } = {}) {
  const fns = new Set();
  const skey = `nightops-upload-net:${key}`;
  let answered = false;
  try { answered = !!(storage && key && storage.getItem(skey)); } catch { answered = false; }
  let choice = null;
  let conn = null;
  try { conn = nav ? (nav.connection || nav.mozConnection || nav.webkitConnection || null) : null; } catch { conn = null; }
  const emit = () => { for (const fn of [...fns]) { try { fn(gate.state); } catch (e) { console.error(e); } } };
  const onChange = () => emit();
  try { if (conn && typeof conn.addEventListener === 'function') conn.addEventListener('change', onChange); } catch { /* none */ }
  const gate = {
    get kind() { return netKind(nav); },
    get choice() { return choice; },
    get answered() { return answered; },
    get state() { return gateFor({ kind: netKind(nav), choice, answered }); },
    // 'now' (Upload now / Upload my clips), 'anyway' (Upload now anyway on mobile data), 'later' (wait for wifi)
    choose(c) {
      choice = c === 'now' || c === 'anyway' || c === 'later' ? c : null;
      if (choice === 'now' || choice === 'later') {
        answered = true;
        try { if (storage && key) storage.setItem(skey, choice); } catch { /* private mode: only this visit */ }
      }
      emit();
    },
    on(fn) { fns.add(fn); return () => fns.delete(fn); },
    destroy() {
      fns.clear();
      try { if (conn && typeof conn.removeEventListener === 'function') conn.removeEventListener('change', onChange); } catch { /* none */ }
    },
  };
  return gate;
}
