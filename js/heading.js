// Night Ops: which way the phone is facing (the beam of light on your own dot, like Google Maps).
//
//   const stop = watchHeading((deg) => ...)   deg: 0 = north, clockwise; null when the phone can't tell (no compass, a
//                                             desktop, iOS motion access refused). Smoothed, at most ~15 a second.
//   stop()                                    stops listening
//
// Android Chrome: 'deviceorientationabsolute' (alpha against north). iPhone: 'deviceorientation' with
// webkitCompassHeading, which iOS only sends after DeviceOrientationEvent.requestPermission() from a tap: the first
// tap anywhere asks once (iOS shows its own "Motion & Orientation" box).

const EVERY_MS = 66;   // at most this often to the map
const SMOOTH = 0.35;   // each reading moves the heading this share of the way (a compass jitters)
const LOST_MS = 4000;  // no reading this long: the beam goes

export function screenAngle() {
  try {
    const a = screen.orientation && Number(screen.orientation.angle);
    if (Number.isFinite(a)) return a;
  } catch { /* ignore */ }
  const w = Number(globalThis.orientation);
  return Number.isFinite(w) ? w : 0;
}

// One reading's compass heading (0 = north, clockwise), or null.
export function headingOf(e, angle = 0) {
  if (!e) return null;
  let deg = null;
  if (Number.isFinite(e.webkitCompassHeading)) deg = e.webkitCompassHeading; // iOS: already a compass heading
  else if (e.absolute === true && Number.isFinite(e.alpha)) deg = 360 - e.alpha; // alpha turns the other way
  if (deg === null) return null;
  return (((deg + angle) % 360) + 360) % 360;
}

// The heading moved `k` of the way towards `to`, the short way round.
export function blend(from, to, k = SMOOTH) {
  if (!Number.isFinite(from)) return to;
  const d = ((to - from + 540) % 360) - 180;
  return (((from + d * k) % 360) + 360) % 360;
}

export function watchHeading(cb) {
  if (typeof window === 'undefined' || typeof cb !== 'function') return () => {};
  let cur = null;
  let sent = 0;
  let last = 0;
  let lost = null;
  let trail = null; // (the last reading always arrives, after a burst too)
  let dead = false;
  const send = (v) => { try { cb(v); } catch (e) { console.error(e); } };
  const onReading = (e) => {
    const h = headingOf(e, screenAngle());
    if (h === null || dead) return;
    cur = blend(cur, h);
    last = Date.now();
    if (last - sent >= EVERY_MS) { sent = last; send(Math.round(cur)); }
    else if (!trail) trail = setTimeout(() => { trail = null; if (!dead && cur !== null) { sent = Date.now(); send(Math.round(cur)); } }, EVERY_MS);
    clearTimeout(lost);
    lost = setTimeout(() => { if (!dead && Date.now() - last >= LOST_MS) { cur = null; send(null); } }, LOST_MS + 50);
  };
  const absolute = 'ondeviceorientationabsolute' in window;
  const kind = absolute ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(kind, onReading);

  // iOS asks for motion access, and only from a tap: the first one anywhere asks, once.
  const D = globalThis.DeviceOrientationEvent;
  let asked = false;
  const ask = () => {
    if (asked) return;
    asked = true;
    window.removeEventListener('pointerup', ask, true);
    try { D.requestPermission().catch(() => {}); } catch { /* ignore */ }
  };
  if (!absolute && D && typeof D.requestPermission === 'function') window.addEventListener('pointerup', ask, true);

  return () => {
    dead = true;
    clearTimeout(lost);
    clearTimeout(trail);
    window.removeEventListener(kind, onReading);
    window.removeEventListener('pointerup', ask, true);
  };
}
