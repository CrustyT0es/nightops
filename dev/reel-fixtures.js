// Night Ops v1.4 (PAGE-REEL): the preview's reel sample (&reel=1 on screen=over): the v1.4 summary fields
// (endClock, startAt, mode) and a close call with its gap and track, made from the sample routes.
import { distanceM } from '../shared/geo.js';

function pointAt(pts, sec) {
  if (!pts || !pts.length) return null;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i], b = pts[i + 1];
    if (sec >= a[2] && sec <= b[2]) { const f = b[2] > a[2] ? (sec - a[2]) / (b[2] - a[2]) : 0; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
  }
  return null;
}

export function withReel(view, params = {}) {
  if (params.reel !== '1' || !view || !view.summary) return view;
  const s = view.summary;
  s.endClock = Number.isFinite(view.clock) ? view.clock : 2700000;
  s.startAt = Date.UTC(2026, 10, 14, 19, 30);
  s.mode = 'classic';
  s.hacks = s.hacks || [];
  s.taps = s.taps || [];
  s.pins = s.pins || [];
  for (const c of s.closeCalls || []) {
    if (c.kind !== 'near' || !Array.isArray(c.ids) || c.ids.length < 2) continue;
    const [a, b] = c.ids;
    const A = s.routes[a], B = s.routes[b];
    if (!A || !B) continue;
    const at = c.clock / 1000;
    const pa = pointAt(A, at), pb0 = pointAt(B, at);
    if (!pa || !pb0) continue;
    // the hunter's track is moved so the two pass c.m metres apart at the call's clock
    const m = Number.isFinite(c.m) ? c.m : 8;
    const shift = [pa[0] - pb0[0] + m / 69000, pa[1] - pb0[1]];
    const track = { from: c.clock - 60000, to: c.clock + 20000, a: [], b: [] };
    for (let t = track.from; t <= track.to; t += 3000) {
      const x = pointAt(A, t / 1000), y = pointAt(B, t / 1000);
      if (x) track.a.push([x[0], x[1], t]);
      if (y) track.b.push([y[0] + shift[0], y[1] + shift[1], t]);
    }
    const pb = [pb0[0] + shift[0], pb0[1] + shift[1]];
    c.gap = { m: Math.round(distanceM(pa, pb)), clock: c.clock, a: { id: a, p: pa }, b: { id: b, p: pb } };
    c.track = track;
  }
  return view;
}
