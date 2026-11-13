// Night Ops: map maths shared by the page and the server.
// Points are [lng, lat] (GeoJSON / MapLibre order) everywhere in Night Ops.
// Distances are metres. Small areas only (a neighbourhood, a city): an
// equirectangular projection around a nearby origin is plenty accurate.

export const EARTH_M = 6371008.8;
const RAD = Math.PI / 180;

export function isPoint(p) {
  return Array.isArray(p) && p.length >= 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
    p[0] >= -180 && p[0] <= 180 && p[1] >= -85 && p[1] <= 85;
}

export function distanceM(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

// The point eastM metres east and northM metres north of p.
export function offsetM(p, eastM, northM) {
  const lat = p[1] + northM / EARTH_M / RAD;
  const lng = p[0] + eastM / (EARTH_M * Math.cos(p[1] * RAD)) / RAD;
  return [lng, lat];
}

// The point distM metres from p towards bearingDeg (0 = north, 90 = east).
export function moveM(p, distM, bearingDeg) {
  const b = bearingDeg * RAD;
  return offsetM(p, distM * Math.sin(b), distM * Math.cos(b));
}

// Bearing from a to b in degrees, 0 = north, clockwise.
export function bearingDeg(a, b) {
  const [x, y] = toLocal(a, b);
  const d = Math.atan2(x, y) / RAD;
  return (d + 360) % 360;
}

// Local flat coordinates around origin: [x metres east, y metres north].
export function toLocal(origin, p) {
  const x = (p[0] - origin[0]) * RAD * EARTH_M * Math.cos(origin[1] * RAD);
  const y = (p[1] - origin[1]) * RAD * EARTH_M;
  return [x, y];
}

export function fromLocal(origin, xy) {
  return offsetM(origin, xy[0], xy[1]);
}

export function pointInPolygon(p, pts) {
  if (!pts || pts.length < 3) return false;
  const o = pts[0];
  const [px, py] = toLocal(o, p);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = toLocal(o, pts[i]);
    const [xj, yj] = toLocal(o, pts[j]);
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Area-weighted centroid; the plain average for a degenerate (flat) shape.
export function polygonCentroid(pts) {
  const o = pts[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = toLocal(o, pts[i]);
    const [xj, yj] = toLocal(o, pts[j]);
    const f = xj * yi - xi * yj;
    a += f; cx += (xj + xi) * f; cy += (yj + yi) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sy = 0;
    for (const p of pts) { const [x, y] = toLocal(o, p); sx += x; sy += y; }
    return fromLocal(o, [sx / pts.length, sy / pts.length]);
  }
  a *= 0.5;
  return fromLocal(o, [cx / (6 * a), cy / (6 * a)]);
}

export function polygonAreaM2(pts) {
  const o = pts[0];
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = toLocal(o, pts[i]);
    const [xj, yj] = toLocal(o, pts[j]);
    a += xj * yi - xi * yj;
  }
  return Math.abs(a / 2);
}

// A ring is { kind: 'circle', center: [lng, lat], radiusM }
//        or { kind: 'polygon', points: [[lng, lat], ...] } (3 to 20 corners, not closed).

export function ringCenter(ring) {
  return ring.kind === 'circle' ? ring.center : polygonCentroid(ring.points);
}

// The ring shrunk (or grown) by factor towards its centre.
export function scaleRing(ring, factor) {
  if (ring.kind === 'circle') return { kind: 'circle', center: ring.center, radiusM: ring.radiusM * factor };
  const c = polygonCentroid(ring.points);
  return {
    kind: 'polygon',
    points: ring.points.map((p) => {
      const [x, y] = toLocal(c, p);
      return fromLocal(c, [x * factor, y * factor]);
    }),
  };
}

export function ringContains(ring, p) {
  if (!ring) return true;
  if (ring.kind === 'circle') return distanceM(ring.center, p) <= ring.radiusM;
  return pointInPolygon(p, ring.points);
}

// Widest distance across the ring in metres.
export function ringAcrossM(ring) {
  if (ring.kind === 'circle') return 2 * ring.radiusM;
  let best = 0;
  for (let i = 0; i < ring.points.length; i++) {
    for (let j = i + 1; j < ring.points.length; j++) {
      best = Math.max(best, distanceM(ring.points[i], ring.points[j]));
    }
  }
  return best;
}

export function ringAreaM2(ring) {
  return ring.kind === 'circle' ? Math.PI * ring.radiusM ** 2 : polygonAreaM2(ring.points);
}

export function circlePoints(center, radiusM, steps = 64) {
  const out = [];
  for (let i = 0; i < steps; i++) out.push(moveM(center, radiusM, (360 * i) / steps));
  return out;
}

// The ring's outline as corner points (a circle becomes a 64-sided shape).
export function ringOutline(ring, steps = 64) {
  return ring.kind === 'circle' ? circlePoints(ring.center, ring.radiusM, steps) : ring.points.slice();
}

// [[west, south], [east, north]]
export function ringBounds(ring) {
  return boundsOf(ringOutline(ring, 32));
}

export function boundsOf(points) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points) {
    w = Math.min(w, p[0]); e = Math.max(e, p[0]);
    s = Math.min(s, p[1]); n = Math.max(n, p[1]);
  }
  return [[w, s], [e, n]];
}

// How far outside the ring p is, in metres (0 or less when inside).
export function outsideByM(ring, p) {
  if (ring.kind === 'circle') return distanceM(ring.center, p) - ring.radiusM;
  if (pointInPolygon(p, ring.points)) return 0;
  const o = p;
  let best = Infinity;
  const pts = ring.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = toLocal(o, pts[j]);
    const b = toLocal(o, pts[i]);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(a[0] * dx + a[1] * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(a[0] + t * dx, a[1] + t * dy));
  }
  return best;
}

export function pathLengthM(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceM(points[i - 1], points[i]);
  return total;
}

// True when two sides of the shape cross each other (corners tapped out of order make a bow tie, where
// "inside" means nothing). Sides that only touch, or a zero-length side, don't count.
export function sidesCross(pts) {
  if (!Array.isArray(pts) || pts.length < 4) return false;
  const o = pts[0];
  const xy = pts.map((p) => toLocal(o, p));
  const n = xy.length;
  const side = (a, b, c) => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < 1e-6 ? 0 : Math.sign(v);
  };
  for (let i = 0; i < n; i++) {
    const a = xy[i], b = xy[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // these two sides share the first corner
      const c = xy[j], d = xy[(j + 1) % n];
      const s1 = side(a, b, c), s2 = side(a, b, d), s3 = side(c, d, a), s4 = side(c, d, b);
      if (s1 * s2 < 0 && s3 * s4 < 0) return true;
    }
  }
  return false;
}

// '' when the ring is usable, else a sentence saying what's wrong.
export function ringProblem(ring) {
  if (!ring || typeof ring !== 'object') return 'Draw the ring first.';
  if (ring.kind === 'circle') {
    if (!isPoint(ring.center)) return 'The ring needs a centre.';
    if (!Number.isFinite(ring.radiusM) || ring.radiusM < 50) return 'The ring is too small (at least 100 m across).';
    if (ring.radiusM > 5000) return 'The ring is too big (at most 10 km across).';
    return '';
  }
  if (ring.kind === 'polygon') {
    const pts = ring.points;
    if (!Array.isArray(pts) || pts.length < 3) return 'Tap at least 3 corners.';
    if (pts.length > 20) return 'At most 20 corners.';
    if (!pts.every(isPoint)) return 'One of the corners is off the map.';
    if (sidesCross(pts)) return 'The sides cross. Tap the corners in order around the edge.';
    const across = ringAcrossM(ring);
    if (across < 100 || polygonAreaM2(pts) < 2000) return 'The ring is too small (at least 100 m across).';
    if (across > 10000) return 'The ring is too big (at most 10 km across).';
    return '';
  }
  return 'Draw the ring first.';
}

// A copy with numbers rounded (7 decimals of a degree is about 1 cm), safe to store.
export function cleanRing(ring) {
  const r7 = (v) => Math.round(v * 1e7) / 1e7;
  const pt = (p) => [r7(p[0]), r7(p[1])];
  if (ring.kind === 'circle') return { kind: 'circle', center: pt(ring.center), radiusM: Math.round(ring.radiusM) };
  return { kind: 'polygon', points: ring.points.map(pt) };
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

// The nearest of the 8 compass points for a bearing (0 = north, clockwise).
export function compassWord(deg) {
  const d = Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : 0;
  return COMPASS[Math.round(d / 45) % 8];
}

// How far and which way from one point to another: { m: metres rounded to 10, dir: a compass word }.
export function directionWords(from, to) {
  return { m: Math.round(distanceM(from, to) / 10) * 10, dir: compassWord(bearingDeg(from, to)) };
}
