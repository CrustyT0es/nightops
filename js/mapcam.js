// Night Ops v1.4 (PAGE-REEL): the map never fights you.
//
//   createMapCam(map, { fitAll, pointOf, follow, now, every }) -> cam
//   cam.mode            'auto' | 'free' | 'follow'
//   cam.auto(reason)    a screen asks for an automatic fit: done only while mode is 'auto'
//   cam.fitNow()        "Fit everyone" pressed: fits, mode back to 'auto'
//   cam.centre(id|p)    "Centre on me": a one-off centre, mode stays (or goes) 'free'
//   cam.follow(id)      mode 'follow': each frame() eases to pointOf(id); null -> 'free'
//   cam.frame()         the screen calls it each drawn frame (replay) or each view (live)
//   cam.on('mode', fn)  -> off()
//   cam.destroy()
//
// The first fit happens once, the first time auto() runs with the map sized. After any user move the mode is
// 'free' and nothing moves the map by itself until a button is pressed.

export const FOLLOW_EASE_MS = 300;
export const FOLLOW_MIN_PX = 2;       // closer than this to the middle: no move

export function createMapCam(map, { fitAll, pointOf, follow = null, now = () => Date.now() } = {}) {
  const fns = new Set();
  const cam = { mode: follow ? 'follow' : 'auto', following: follow || null, fitted: false };
  let lastEase = -Infinity;
  let busy = 0; // our own moves in progress (never counted as the person's)
  const tell = () => { for (const fn of [...fns]) { try { fn(cam.mode, cam.following); } catch { /* fine */ } } };
  const setMode = (m, id = null) => {
    const changed = m !== cam.mode || id !== cam.following;
    cam.mode = m;
    cam.following = m === 'follow' ? id : null;
    if (changed) tell();
  };
  const off = map && typeof map.onUserMove === 'function'
    ? map.onUserMove(() => { if (!busy) setMode('free'); })
    : () => {};
  const ours = (fn) => {
    busy += 1;
    try { return fn(); } finally { busy -= 1; }
  };
  const doFit = () => ours(() => {
    try { return fitAll ? fitAll() !== false : false; } catch { return false; }
  });

  cam.auto = (reason = '') => {
    if (cam.mode !== 'auto') return false;
    const ok = doFit();
    if (ok) cam.fitted = true;
    return ok;
  };
  cam.fitNow = () => {
    setMode('auto');
    const ok = doFit();
    if (ok) cam.fitted = true;
    return ok;
  };
  cam.centre = (what) => {
    const p = Array.isArray(what) ? what : (pointOf ? pointOf(what) : null);
    setMode('free');
    if (!p || !map || typeof map.center !== 'function') return false;
    ours(() => map.center(p, undefined, { animate: true }));
    return true;
  };
  cam.follow = (id) => {
    if (!id) { setMode('free'); return; }
    setMode('follow', id);
    lastEase = -Infinity;
    cam.frame();
  };
  cam.frame = () => {
    if (cam.mode !== 'follow' || !pointOf || !map) return;
    const p = pointOf(cam.following);
    if (!p) return;
    const t = now();
    if (t - lastEase < FOLLOW_EASE_MS) return;
    try {
      const at = typeof map.project === 'function' ? map.project(p) : null;
      const mid = typeof map.getCenter === 'function' && map.getCenter() && typeof map.project === 'function'
        ? map.project(map.getCenter()) : null;
      if (at && mid && Math.hypot(at[0] - mid[0], at[1] - mid[1]) < FOLLOW_MIN_PX) return;
    } catch { /* move anyway */ }
    lastEase = t;
    ours(() => { try { map.center(p, undefined, { animate: true }); } catch { /* fine */ } });
  };
  cam.on = (what, fn) => {
    if (what !== 'mode' || typeof fn !== 'function') return () => {};
    fns.add(fn);
    return () => fns.delete(fn);
  };
  cam.destroy = () => { off(); fns.clear(); };
  return cam;
}
