// Night Ops v1.3 (PAGE-PLAY): take a checkpoint photo.
//
//   takePhoto({ doc, win }) -> Promise<{ dataUrl, bytes, w, h } | null>
//       Call it straight from a tap: it opens the phone's camera at once (<input type=file accept="image/*"
//       capture="environment">; an iPhone opens its own camera, a computer a file picker). null when cancelled.
//       The picture is turned the right way up (EXIF), made small (longest side LIMITS.cpPhotoSide) and saved as a
//       JPEG of at most LIMITS.cpPhotoBytes: quality 0.7, then 0.6 and 0.5, then 600 and 480 px, never bigger.
//       Rejects with an Error whose message is a sentence for the player ("That photo didn't work. Try again.").
//   shrinkTo(width, height, most) -> { w, h }     the size that fits `most` on the longest side (never larger)
//   jpegBytes(dataUrl) -> n                       how many bytes a base64 data: URL holds
//   fitPhoto(source, w, h, { doc }) -> { dataUrl, bytes, w, h }   the size and quality steps above (tests use it)
//
// (With the highlight camera on, an iPhone mutes its stream while its own camera is open; camera.js picks up again.)
import { LIMITS } from '../shared/rules.js?v=155';

export const PHOTO_WORDS = {
  failed: "That photo didn't work. Try again.",
  notImage: "That isn't a photo. Try again with the camera.",
  tooBig: "That photo is too big to send. Try again, a little further away.",
};
// [longest side, JPEG quality], tried in order until the photo fits.
export const STEPS = Object.freeze([
  [LIMITS.cpPhotoSide, 0.7], [LIMITS.cpPhotoSide, 0.6], [LIMITS.cpPhotoSide, 0.5],
  [600, 0.5], [480, 0.5], [360, 0.45],
]);
const CANCEL_WAIT_MS = 1200; // after the page gets the focus back with nothing picked: the picker was closed

export function shrinkTo(width, height, most) {
  const w = Math.max(0, Number(width) || 0);
  const hh = Math.max(0, Number(height) || 0);
  const m = Math.max(1, Math.floor(Number(most) || 1));
  if (!w || !hh) return { w: 0, h: 0 };
  const long = Math.max(w, hh);
  if (long <= m) return { w: Math.round(w), h: Math.round(hh) };
  const k = m / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(hh * k)) };
}

export function jpegBytes(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf('base64,');
  if (i < 0) return 0;
  const b64 = s.slice(i + 7);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

// Draw `source` (an ImageBitmap or <img>) small enough and save it as a JPEG that fits LIMITS.cpPhotoBytes.
export function fitPhoto(source, width, height, { doc = globalThis.document, most = LIMITS.cpPhotoBytes } = {}) {
  const canvas = doc.createElement('canvas');
  let last = null;
  for (const [side, q] of STEPS) {
    const { w, h } = shrinkTo(width, height, side);
    if (!w || !h) throw new Error(PHOTO_WORDS.notImage);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) throw new Error(PHOTO_WORDS.failed);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.drawImage(source, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', q);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error(PHOTO_WORDS.failed);
    const bytes = jpegBytes(dataUrl);
    last = { dataUrl, bytes, w, h };
    if (bytes > 0 && bytes <= most) break;
  }
  // Let the big picture go (phones run short of memory with a few of these around).
  canvas.width = 1;
  canvas.height = 1;
  if (!last || !(last.bytes > 0)) throw new Error(PHOTO_WORDS.failed);
  if (last.bytes > most) throw new Error(PHOTO_WORDS.tooBig);
  return last;
}

// The picked file as something a canvas can draw, the right way up: { source, w, h, done() }.
async function decode(file, win, doc) {
  const make = win && typeof win.createImageBitmap === 'function' ? win.createImageBitmap.bind(win) : null;
  if (make) {
    for (const opts of [{ imageOrientation: 'from-image' }, undefined]) {
      try {
        const bmp = opts ? await make(file, opts) : await make(file);
        if (bmp && bmp.width > 0 && bmp.height > 0) {
          return { source: bmp, w: bmp.width, h: bmp.height, done: () => { try { bmp.close(); } catch { /* ignore */ } } };
        }
      } catch { /* the next way */ }
    }
  }
  // An <img> (browsers turn it upright by its EXIF on their own now).
  const U = (win && win.URL) || globalThis.URL;
  const url = U.createObjectURL(file);
  try {
    const img = doc.createElement('img');
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(PHOTO_WORDS.notImage));
      img.src = url;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!(w > 0 && h > 0)) throw new Error(PHOTO_WORDS.notImage);
    return { source: img, w, h, done: () => { try { U.revokeObjectURL(url); } catch { /* ignore */ } } };
  } catch (e) {
    try { U.revokeObjectURL(url); } catch { /* ignore */ }
    throw e;
  }
}

// Open the camera (a file input) and wait for a picture: the File, or null when the picker was closed.
function pick(doc, win) {
  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.setAttribute('capture', 'environment');
  input.className = 'snap-input';
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  // (In the page, out of sight: an iPhone only opens the picker of an input that's in the document.)
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.width = '1px';
  input.style.height = '1px';
  input.style.opacity = '0';
  if (doc.body) doc.body.appendChild(input);
  return {
    input,
    wait: new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (file) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { win.removeEventListener('focus', onFocus); } catch { /* ignore */ }
        try { input.remove(); } catch { /* ignore */ }
        resolve(file || null);
      };
      const first = () => (input.files && input.files.length ? input.files[0] : null);
      const onFocus = () => {
        // Back from the picker: a picked file's 'change' comes a moment after the focus on some phones.
        clearTimeout(timer);
        timer = setTimeout(() => { if (!first()) finish(null); }, CANCEL_WAIT_MS);
      };
      input.addEventListener('change', () => finish(first()));
      input.addEventListener('cancel', () => finish(null));
      try { win.addEventListener('focus', onFocus); } catch { /* ignore */ }
    }),
  };
}

export async function takePhoto({ doc = globalThis.document, win = globalThis.window || globalThis } = {}) {
  const { input, wait } = pick(doc, win);
  // Straight from the tap (no await before this): browsers only open a picker from one.
  input.click();
  const file = await wait;
  if (!file) return null;
  if (file.type && !/^image\//i.test(file.type)) throw new Error(PHOTO_WORDS.notImage);
  let pic = null;
  try {
    pic = await decode(file, win, doc);
  } catch (e) {
    throw new Error(e && e.message === PHOTO_WORDS.notImage ? PHOTO_WORDS.notImage : PHOTO_WORDS.failed);
  }
  try {
    return fitPhoto(pic.source, pic.w, pic.h, { doc });
  } finally {
    pic.done();
  }
}
