// Night Ops: selfies. pickFace() -> Promise<dataUrl|null>
// Call it from a tap: it opens the front camera (or the photo picker), crops the middle square, makes it
// 160 px and a JPEG at quality 0.72, smaller again until it fits LIMITS.faceBytes. null when the player
// cancels, or when the picture can't be used (a banner then says why).
// faceFromFile(file) -> Promise<dataUrl> does the same for a file you already have (it throws a plain
// sentence on trouble).
import { LIMITS } from '../shared/rules.js?v=167';
import { banner } from './ui/banner.js?v=167';

export const FACE_SIZE = 160;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const TRIES = [[160, 0.72], [160, 0.62], [144, 0.6], [128, 0.55], [112, 0.5], [96, 0.45]];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    const done = (ok) => {
      img.onload = null;
      img.onerror = null;
      if (ok) resolve({ img, url });
      else {
        URL.revokeObjectURL(url);
        reject(new Error("That picture couldn't be opened. Try taking a new photo."));
      }
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });
}

// Draw the source's centre square into a size x size canvas, halving step by step for a sharp result.
function squareCanvas(img, size) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error("That picture couldn't be opened. Try taking a new photo.");
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  // Portrait selfies: faces sit a little above the middle.
  const sy = h > w ? (h - side) * 0.35 : (h - side) / 2;

  let cur = null;
  let curSize = side;
  // First step: crop (and shrink to at most 4x the target, so the steps below stay few).
  const first = Math.min(side, size * 4);
  cur = document.createElement('canvas');
  cur.width = first;
  cur.height = first;
  let ctx = cur.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, first, first);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, first, first);
  curSize = first;
  while (curSize / 2 >= size) {
    const nextSize = Math.max(size, Math.round(curSize / 2));
    const c = document.createElement('canvas');
    c.width = nextSize;
    c.height = nextSize;
    ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nextSize, nextSize);
    cur = c;
    curSize = nextSize;
  }
  if (curSize !== size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, size, size);
    cur = c;
  }
  return cur;
}

export async function faceFromFile(file) {
  if (!file) throw new Error('No picture was picked.');
  if (file.type && !file.type.startsWith('image/')) throw new Error('That file is not a picture.');
  if (file.size > MAX_FILE_BYTES) throw new Error('That picture is too big. Try taking a new photo.');
  const { img, url } = await loadImage(file);
  try {
    let small = null;
    let lastSize = 0;
    for (const [size, quality] of TRIES) {
      if (size !== lastSize) {
        small = squareCanvas(img, size);
        lastSize = size;
      }
      const data = small.toDataURL('image/jpeg', quality);
      if (!data.startsWith('data:image/jpeg')) throw new Error("This phone couldn't make the picture. Try again.");
      if (data.length <= LIMITS.faceBytes) return data;
    }
    throw new Error('That picture is too detailed to send. Try a plainer background.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function pickFace() {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'user');
    input.className = 'sr-only';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');

    let finished = false;
    let fallback = null;
    function finish(value) {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
      input.remove();
      resolve(value);
    }
    // Browsers without the 'cancel' event: when the page comes back and nothing was picked a few
    // seconds later, it was cancelled. (iPhones can take a moment to hand over a photo.)
    function onBack() {
      if (document.visibilityState === 'hidden') return;
      clearTimeout(fallback);
      fallback = setTimeout(() => {
        if (!input.files || !input.files.length) finish(null);
      }, 4000);
    }

    input.addEventListener('change', async () => {
      clearTimeout(fallback);
      const file = input.files && input.files[0];
      if (!file) {
        finish(null);
        return;
      }
      try {
        finish(await faceFromFile(file));
      } catch (e) {
        banner(e && e.message ? e.message : "That picture couldn't be used. Try another one.", 'warn', 5000);
        finish(null);
      }
    });
    input.addEventListener('cancel', () => finish(null));

    document.body.appendChild(input);
    // Listen for the return only after the picker had a chance to open.
    setTimeout(() => {
      if (finished) return;
      window.addEventListener('focus', onBack);
      document.addEventListener('visibilitychange', onBack);
    }, 300);
    try {
      input.click();
    } catch {
      finish(null);
    }
  });
}
