// Night Ops: making parts of the page inert while something sits over them (sheets, pocket mode).
//   holdInert(el) -> release()
// Counted: an element stays inert (and hidden from screen readers) until everyone who asked has let go, then it
// goes back to how it was before the first one asked. So a sheet closing under pocket mode, or pocket mode waking
// over a sheet, never leaves the page usable under something that is still open.
const held = new Map(); // el -> { n, inert, hidden }

export function holdInert(el) {
  if (!el || typeof el.setAttribute !== 'function') return () => {};
  let rec = held.get(el);
  if (!rec) {
    rec = { n: 0, inert: !!el.inert, hidden: el.getAttribute('aria-hidden') };
    held.set(el, rec);
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
  }
  rec.n += 1;
  let done = false;
  return function release() {
    if (done) return;
    done = true;
    if (held.get(el) !== rec) return;
    rec.n -= 1;
    if (rec.n > 0) return;
    held.delete(el);
    el.inert = rec.inert;
    if (rec.hidden === null || rec.hidden === undefined) el.removeAttribute('aria-hidden');
    else el.setAttribute('aria-hidden', rec.hidden);
  };
}

// How many holds an element has (tests).
export function inertHolds(el) {
  const rec = held.get(el);
  return rec ? rec.n : 0;
}
