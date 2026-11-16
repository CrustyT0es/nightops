// v1.4.6: the movie's director camera. In a quiet map stretch (no catch, close call, pickup or power: scene kind
// 'stretch' or 'gap' drawn full-frame), the map doesn't sit zoomed out on everyone: it tours. The stretch is cut into
// segments of TOUR.SEG_MIN..SEG_MAX ms of MOVIE time; each looks at the densest cluster of players (their heads plus
// how crowded their routes are in that segment) or, every other one, at one or two hiders in turn; the view eases
// there over TOUR.EASE_MS and back to everyone in the stretch's last EASE_MS. Pure and deterministic (only the
// summary's routes and players), so the watched movie and the downloaded file match frame for frame.
//
//   planTour(scene, summary) -> { segs: [{ at, ms, box, pids, label, why: 'crowd'|'hiders' }] } | null
//   tourView(scene, t) -> { box, label, pids, zoomed } | null        t = reel time
//   tourBoxes(scene) -> [box]                                       the zoomed boxes (moviemap.js pictures them)

export const TOUR = { EASE_MS: 1000, SEG_MIN: 6000, SEG_MAX: 12000, SEG: 8000, MIN_M: 90, BIG_SHARE: 0.6, ASPECT: 720 / 1280 };
export const QUIET_KINDS = ['stretch', 'gap'];

const M_PER_DEG = 111320;

function headAt(pts, sec) {
  if (!Array.isArray(pts) || !pts.length || sec < pts[0][2]) return null;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i], b = pts[i + 1];
    if (sec >= a[2] && sec <= b[2]) {
      const f = b[2] > a[2] ? (sec - a[2]) / (b[2] - a[2]) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
  }
  const last = pts[pts.length - 1];
  return sec - last[2] < 600 ? [last[0], last[1]] : null;
}

function metres(a, b, cosLat) {
  return Math.hypot((a[0] - b[0]) * M_PER_DEG * cosLat, (a[1] - b[1]) * M_PER_DEG);
}

function boxSpanM(box, cosLat) {
  return [(box[1][0] - box[0][0]) * M_PER_DEG * cosLat, (box[1][1] - box[0][1]) * M_PER_DEG];
}

function playersOf(summary) {
  const m = new Map();
  for (const p of (summary && Array.isArray(summary.players) ? summary.players : [])) if (p && p.id) m.set(String(p.id), p);
  return m;
}

function labelOf(pids, players) {
  const names = pids.map((id) => String((players.get(id) && players.get(id).name) || id).slice(0, 12));
  if (names.length <= 2) return names.join(' & ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

// a box round these points, padded, at least MIN_M across, shaped like the frame
function frameBox(pts, cosLat) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); }
  const cx = (w + e) / 2, cy = (s + n) / 2;
  let wm = Math.max(TOUR.MIN_M, (e - w) * M_PER_DEG * cosLat * 1.3);
  let hm = Math.max(TOUR.MIN_M, (n - s) * M_PER_DEG * 1.3);
  if (wm / hm < TOUR.ASPECT) wm = hm * TOUR.ASPECT; else hm = wm / TOUR.ASPECT;
  const dx = wm / 2 / (M_PER_DEG * cosLat), dy = hm / 2 / M_PER_DEG;
  return [[cx - dx, cy - dy], [cx + dx, cy + dy]];
}

export function planTour(scene, summary) {
  if (!scene || !QUIET_KINDS.includes(scene.kind) || scene.layout !== 'map' || scene.start === null || scene.start === undefined) return null;
  const sbox = scene.map && scene.map.box;
  if (!sbox || !(scene.ms >= TOUR.SEG_MIN)) return null;
  const routes = summary && summary.routes ? summary.routes : {};
  const players = playersOf(summary);
  const ids = Object.keys(routes).sort();
  if (!ids.length) return null;
  const cosLat = Math.cos(((sbox[0][1] + sbox[1][1]) / 2) * Math.PI / 180) || 1;
  const [sw, sh] = boxSpanM(sbox, cosLat);
  const R = Math.max(TOUR.MIN_M * 0.75, Math.hypot(sw, sh) * 0.15);
  const n = Math.max(1, Math.min(Math.floor(scene.ms / TOUR.SEG_MIN), Math.round(scene.ms / TOUR.SEG)));
  const segMs = scene.ms / n;
  const rate = scene.rate || 1;
  const segs = [];
  let hiderTurn = 0, lastKey = '';
  for (let i = 0; i < n; i += 1) {
    const at = i * segMs;
    const c0 = scene.start + at * rate, c1 = scene.start + (at + segMs) * rate;
    const mid = (c0 + c1) / 2000;
    const heads = [];
    for (const id of ids) {
      const h = headAt(routes[id], mid);
      if (!h) continue;
      const p = players.get(id);
      const caught = p && Number.isFinite(p.caughtAt) && p.caughtAt <= mid * 1000;
      const hider = !!(p && p.startTeam === 'hider' && !caught);
      // where the route goes in this segment (so the view keeps them in it)
      const path = (routes[id] || []).filter((q) => Array.isArray(q) && q[2] * 1000 >= c0 && q[2] * 1000 <= c1);
      heads.push({ id, h, hider, path });
    }
    if (!heads.length) { segs.push({ at, ms: segMs, box: null, pids: [], label: '', why: 'crowd' }); continue; }
    // the crowd: the head with most others (and route points) near it
    let crowd = null;
    for (const a of heads) {
      const near = heads.filter((b) => metres(a.h, b.h, cosLat) <= R);
      let busy = 0;
      for (const b of heads) for (const q of b.path) if (metres(a.h, q, cosLat) <= R) busy += 1;
      const score = near.length * 10 + Math.min(busy, 40) / 4;
      if (!crowd || score > crowd.score) crowd = { score, near };
    }
    // the hiders, one at a time (with the nearest other hider when close)
    const hiders = heads.filter((x) => x.hider);
    let pick = null;
    if (hiders.length) {
      const one = hiders[hiderTurn % hiders.length];
      const others = hiders.filter((x) => x !== one).sort((x, y) => metres(one.h, x.h, cosLat) - metres(one.h, y.h, cosLat) || (x.id < y.id ? -1 : 1));
      pick = [one];
      if (others.length && metres(one.h, others[0].h, cosLat) <= R * 2) pick.push(others[0]);
    }
    const wantHiders = pick && (i % 2 === 1 || crowd.near.length < 2);
    let members = wantHiders ? pick : crowd.near;
    let why = wantHiders ? 'hiders' : 'crowd';
    let key = members.map((x) => x.id).sort().join(',');
    if (key === lastKey && segs.length) { // never the same people twice running
      const alt = wantHiders ? crowd.near : pick;
      const altKey = alt ? alt.map((x) => x.id).sort().join(',') : key;
      if (alt && altKey !== key) { members = alt; why = wantHiders ? 'crowd' : 'hiders'; key = altKey; }
    }
    if (why === 'hiders') hiderTurn += 1;
    lastKey = key;
    const pts = members.flatMap((x) => [x.h, ...x.path]);
    let box = frameBox(pts, cosLat);
    const [bw, bh] = boxSpanM(box, cosLat);
    if (bw * bh >= sw * sh * TOUR.BIG_SHARE) box = null; // as big as everyone: stay on everyone
    const pids = members.map((x) => x.id).sort();
    segs.push({ at, ms: segMs, box, pids, label: box ? labelOf(pids, players) : '', why });
  }
  return segs.some((s) => s.box) ? { segs } : null;
}

function smooth(f) { const x = Math.max(0, Math.min(1, f)); return x * x * (3 - 2 * x); }

// centre linearly, size geometrically (so a zoom feels even)
function lerpBox(a, b, f) {
  if (f <= 0) return a;
  if (f >= 1) return b;
  const ca = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2], cb = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
  const wa = a[1][0] - a[0][0], ha = a[1][1] - a[0][1], wb = b[1][0] - b[0][0], hb = b[1][1] - b[0][1];
  const g = (x, y) => (x > 0 && y > 0 ? x * Math.pow(y / x, f) : x + (y - x) * f);
  const c = [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f], w = g(wa, wb) / 2, h = g(ha, hb) / 2;
  return [[c[0] - w, c[1] - h], [c[0] + w, c[1] + h]];
}

export function tourView(scene, t) {
  const tour = scene && scene.tour;
  const sbox = scene && scene.map && scene.map.box;
  if (!tour || !Array.isArray(tour.segs) || !tour.segs.length || !sbox) return null;
  const u = Math.max(0, Math.min(scene.ms, t - scene.at));
  let i = tour.segs.findIndex((s) => u >= s.at && u < s.at + s.ms);
  if (i < 0) i = tour.segs.length - 1;
  const seg = tour.segs[i];
  const to = seg.box || sbox;
  const from = i > 0 ? tour.segs[i - 1].box || sbox : sbox;
  let box = lerpBox(from, to, smooth((u - seg.at) / TOUR.EASE_MS));
  const tail = scene.ms - u;
  if (tail < TOUR.EASE_MS) box = lerpBox(box, sbox, smooth(1 - tail / TOUR.EASE_MS)); // back to everyone at the cut
  const zoomed = box !== sbox;
  return { box, label: seg.box ? seg.label : '', pids: seg.box ? seg.pids : [], zoomed };
}

export function tourBoxes(scene) {
  return scene && scene.tour && Array.isArray(scene.tour.segs) ? scene.tour.segs.map((s) => s.box).filter(Boolean) : [];
}
