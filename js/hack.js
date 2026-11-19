// v1.4 Hacker: when the server's view says this hider was hacked (view.hack {n, at, ms}),
// blare a full-gain siren for ms (5 s) and flash "HACKED". Each n plays once.
import { h } from './dom.js?v=154';
import { audioContext, unlockBeep, alarmSession } from './alerts.js?v=154';

// sound: alerts.js's shared context (tests: stand-ins). The audio session is never touched by a tap: only around the
// siren itself (alarmSession), so a player's "sound off" stays off and capture isn't disturbed.
// A window other than this page's (tests) gets the same rules on its own context.
export function soundFor(win) {
  if (win === globalThis || win === globalThis.window) return { context: audioContext, wake: unlockBeep, session: alarmSession };
  let ctx = null;
  let woke = null;
  const context = () => {
    if (ctx) return ctx;
    const AC = win && (win.AudioContext || win.webkitAudioContext);
    if (!AC) return null;
    try { ctx = new AC(); } catch { ctx = null; }
    return ctx;
  };
  const session = (on) => { try { const ses = win.navigator && win.navigator.audioSession; if (ses) ses.type = on ? 'playback' : 'auto'; } catch { /* ignore */ } };
  const wake = () => {
    const c = context();
    if (!c) return;
    if ((c.state === 'suspended' || c.state === 'interrupted') && c.resume) { try { c.resume().catch(() => {}); } catch { /* ignore */ } }
    if (woke !== c && c.createBuffer) {
      try { const src = c.createBufferSource(); src.buffer = c.createBuffer(1, 1, 22050); src.connect(c.destination); src.start(0); woke = c; } catch { /* ignore */ }
    }
  };
  return { context, wake, session };
}

export function createAlarm(app, { win = globalThis, sound = soundFor(win) } = {}) {
  let played = 0;
  const context = () => { try { return sound.context(); } catch { return null; } };

  // A tap anywhere wakes sound (iOS: resume from 'suspended' or 'interrupted', plus a silent buffer once).
  function unlock() { try { sound.wake(); } catch { /* ignore */ } }

  function siren(ms) {
    const c = context();
    if (!c) return false;
    try { sound.session(true); } catch { /* ignore */ }
    if ((c.state === 'suspended' || c.state === 'interrupted') && c.resume) { try { c.resume().catch(() => {}); } catch { /* ignore */ } }
    try { win.setTimeout(() => { try { sound.session(false); } catch { /* ignore */ } }, ms + 300); } catch { /* ignore */ }
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'square';
      gain.gain.value = 1;
      const t0 = c.currentTime;
      const end = t0 + ms / 1000;
      for (let t = t0, up = true; t < end; t += 0.4, up = !up) osc.frequency.setValueAtTime(up ? 1400 : 700, t);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(end);
      return true;
    } catch { return false; }
  }

  function flash(ms) {
    const doc = win.document;
    if (!doc || !doc.body) return;
    try {
      const el = h('div.hack-flash', { role: 'alert' }, h('strong', 'HACKED'), h('span', 'The hunters set off your alarm.'));
      doc.body.append(el);
      win.setTimeout(() => el.remove(), ms);
    } catch { /* no page to draw on */ }
  }

  function onView(view) {
    const hk = view && view.hack;
    if (!hk || typeof hk.n !== 'number' || hk.n <= played) return;
    played = hk.n;
    const ms = Math.min(Math.max(hk.ms || 5000, 1000), 10000);
    siren(ms);
    flash(ms);
    if (win.navigator && win.navigator.vibrate) { try { win.navigator.vibrate([400, 200, 400, 200, 400]); } catch { /* ignore */ } }
  }

  const off = app && app.on ? app.on('view', onView) : () => {};
  if (win.addEventListener) win.addEventListener('pointerdown', unlock, { passive: true });
  return {
    onView,
    ready: () => { const c = context(); return !!(c && c.state === 'running') || !!(app && app.soundOk); },
    played: () => played,
    stop() { off(); if (win.removeEventListener) win.removeEventListener('pointerdown', unlock); },
  };
}
