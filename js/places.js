// Night Ops v1.3 (PAGE-SETUP): the store finder. The checkpoint editor asks OpenStreetMap's Overpass API, once per
// tap on "Find stores in the ring", for corner stores, supermarkets, kiosks, gas stations, cafes and fast food
// inside the ring's box, and offers them as suggestions. One plain POST: no credentials, no other headers, nothing
// about the game or the players is sent (only the box). It never throws: a problem comes back as a sentence that
// says the way on (tapping the map always works).
import { LIMITS, cleanLine, nameKey } from '../shared/rules.js?v=177';
import { isPoint, ringCenter, ringProblem, outsideByM, distanceM, ringOutline, scaleRing } from '../shared/geo.js?v=177';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const PLACES_MOST = 40;
export const PLACES_TIMEOUT_MS = 15000;
export const SAME_PLACE_M = 30;     // the same name this close is one place (a shop mapped as a point and a building)
export const KIND_WORDS = Object.freeze({
  convenience: 'Convenience store',
  supermarket: 'Supermarket',
  kiosk: 'Kiosk',
  fuel: 'Gas station',
  cafe: 'Cafe',
  fast_food: 'Fast food',
});
export const SOURCE_WORDS = 'Store names come from OpenStreetMap.';
export const PLACES_ERRORS = Object.freeze({
  offline: "Couldn't reach the store finder. Check your connection, or tap the map to add spots.",
  busy: 'The store finder is busy. Try again in a minute, or tap the map to add spots.',
  none: 'No stores found in the ring. Tap the map to add spots.',
  noRing: 'Draw the ring first.',
});

const SHOPS = ['convenience', 'supermarket', 'kiosk'];
const AMENITIES = ['fuel', 'cafe', 'fast_food'];
const f6 = (v) => Number(v).toFixed(6);

// Overpass gives what it finds in id order, not by distance, and cuts the list at the count asked for. So the
// ring's middle half is asked for first (its places always come), then the whole ring, both as the ring's own shape
// (a box would also count its corners outside a round ring).
export const NEAR_MOST = 150;
export const ALL_MOST = 350;

const kinds = (area) => `nwr["shop"~"^(${SHOPS.join('|')})$"](${area});`
  + `nwr["amenity"~"^(${AMENITIES.join('|')})$"](${area});`;
const polyOf = (ring) => `poly:"${ringOutline(ring, 24).map(([lon, lat]) => `${f6(lat)} ${f6(lon)}`).join(' ')}"`;

// The Overpass QL for everything we look for: given a ring, inside it (its middle first); given bounds
// ([[w, s], [e, n]], as geo.ringBounds gives), inside that box.
export function overpassQuery(ringOrBounds) {
  if (ringOrBounds && !Array.isArray(ringOrBounds) && typeof ringOrBounds === 'object') {
    const ring = ringOrBounds;
    return `[out:json][timeout:12];(${kinds(polyOf(scaleRing(ring, 0.5)))})->.near;(${kinds(polyOf(ring))})->.all;`
      + `.near out center tags qt ${NEAR_MOST};.all out center tags qt ${ALL_MOST};`;
  }
  const [[w, s], [e, n]] = ringOrBounds;
  const box = `${f6(s)},${f6(w)},${f6(n)},${f6(e)}`;
  return `[out:json][timeout:12];(${kinds(box)});out center tags 200;`;
}

// Overpass ran out of time or memory: it still answers 200, with a "remark" saying so beside what it had.
export function overpassTrouble(json) {
  const r = json && typeof json.remark === 'string' ? json.remark.toLowerCase() : '';
  return !!r && (r.includes('error') || r.includes('timed out') || r.includes('timeout') || r.includes('out of memory'));
}

function kindOf(tags) {
  if (SHOPS.includes(tags.shop)) return tags.shop;
  if (AMENITIES.includes(tags.amenity)) return tags.amenity;
  return null;
}

// Overpass's answer -> the places inside the ring, nearest its centre first. Pure.
export function placesFrom(json, ring) {
  const els = json && Array.isArray(json.elements) ? json.elements : [];
  if (!ring || ringProblem(ring)) return [];
  const mid = ringCenter(ring);
  const found = [];
  const seen = new Set();
  for (const el of els) {
    if (!el || typeof el !== 'object') continue;
    if (!['node', 'way', 'relation'].includes(el.type) || !Number.isSafeInteger(el.id) || el.id < 0) continue;
    if (seen.has(`${el.type}/${el.id}`)) continue; // (the middle's places come twice)
    seen.add(`${el.type}/${el.id}`);
    const tags = el.tags && typeof el.tags === 'object' ? el.tags : {};
    const kind = kindOf(tags);
    if (!kind) continue;
    const at = Number.isFinite(el.lat) && Number.isFinite(el.lon) ? el
      : el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon) ? el.center : null;
    if (!at) continue;
    const p = [Math.round(at.lon * 1e7) / 1e7, Math.round(at.lat * 1e7) / 1e7];
    if (!isPoint(p) || outsideByM(ring, p) > 0) continue;
    const name = cleanLine(typeof tags.name === 'string' ? tags.name : '', LIMITS.cpName)
      || cleanLine(typeof tags.brand === 'string' ? tags.brand : '', LIMITS.cpName)
      || KIND_WORDS[kind];
    found.push({ id: `${el.type}/${el.id}`, name, kind, p, d: isPoint(mid) ? distanceM(mid, p) : 0 });
  }
  found.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  const kept = [];
  for (const pl of found) {
    const key = nameKey(pl.name);
    if (kept.some((k) => nameKey(k.name) === key && distanceM(k.p, pl.p) < SAME_PLACE_M)) continue;
    kept.push(pl);
    if (kept.length >= PLACES_MOST) break;
  }
  return kept.map(({ id, name, kind, p }) => ({ id, name, kind, p }));
}

// Ask Overpass. -> { places, error } (error '' when it worked and found something; cancelled: true when `signal`
// stopped it). Never throws.
export async function findPlaces(ring, { fetch: fetchFn = globalThis.fetch, signal, timeoutMs = PLACES_TIMEOUT_MS } = {}) {
  if (!ring || ringProblem(ring)) return { places: [], error: PLACES_ERRORS.noRing };
  if (typeof fetchFn !== 'function') return { places: [], error: PLACES_ERRORS.offline };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; if (ctl) ctl.abort(); }, Math.max(1, timeoutMs));
  const onStop = () => { if (ctl) ctl.abort(); };
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); return { places: [], error: '', cancelled: true }; }
    signal.addEventListener('abort', onStop, { once: true });
  }
  try {
    const res = await fetchFn(OVERPASS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(overpassQuery(ring))}`,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!res || !res.ok) return { places: [], error: PLACES_ERRORS.busy };
    let json;
    try { json = await res.json(); } catch {
      if (signal && signal.aborted) return { places: [], error: '', cancelled: true };
      return { places: [], error: timedOut ? PLACES_ERRORS.offline : PLACES_ERRORS.busy };
    }
    // A query that ran out of time says "busy" (try again), never "no stores", even with part of a list.
    if (overpassTrouble(json)) return { places: [], error: PLACES_ERRORS.busy };
    const places = placesFrom(json, ring);
    return { places, error: places.length ? '' : PLACES_ERRORS.none };
  } catch {
    if (signal && signal.aborted && !timedOut) return { places: [], error: '', cancelled: true };
    return { places: [], error: PLACES_ERRORS.offline };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onStop);
  }
}
