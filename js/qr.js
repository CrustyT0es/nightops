// Night Ops: QR codes. qrSvg(text, { size, label }) -> <svg> with dark modules on white and a quiet zone of
// 4 modules (phone cameras need it). Uses window.qrcode from vendor/qrcode.js (qrcode-generator, MIT).
// Never throws: without the library, or for text too long for a QR code, it returns a plain box saying so.

const NS = 'http://www.w3.org/2000/svg';
export const QUIET = 4;

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// The dark modules as one path, a run of dark modules in a row per rectangle.
export function qrPath(isDark, count, quiet = QUIET) {
  let d = '';
  for (let r = 0; r < count; r++) {
    let c = 0;
    while (c < count) {
      if (!isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < count && isDark(r, c)) c++;
      d += `M${start + quiet} ${r + quiet}h${c - start}v1h${start - c}z`;
    }
  }
  return d;
}

export function qrSvg(text, { size = 220, label = 'QR code', level = 'M' } = {}) {
  const lib = globalThis.qrcode;
  let qr = null;
  try {
    if (typeof lib !== 'function') throw new Error('no library');
    if (lib.stringToBytesFuncs && lib.stringToBytesFuncs['UTF-8']) lib.stringToBytes = lib.stringToBytesFuncs['UTF-8'];
    qr = lib(0, ['L', 'M', 'Q', 'H'].includes(level) ? level : 'M');
    qr.addData(String(text ?? ''));
    qr.make();
  } catch {
    qr = null;
  }

  if (!qr) {
    const svg = el('svg', { viewBox: '0 0 100 100', width: size, height: size, role: 'img', 'aria-label': 'QR code not available', class: 'qr qr-missing' });
    svg.appendChild(el('rect', { width: 100, height: 100, rx: 6, fill: '#0f141c', stroke: '#2a3444' }));
    const t = el('text', { x: 50, y: 54, 'text-anchor': 'middle', fill: '#9aa6b8', 'font-size': 9 });
    t.textContent = 'No QR code';
    svg.appendChild(t);
    return svg;
  }

  const count = qr.getModuleCount();
  const total = count + QUIET * 2;
  const svg = el('svg', {
    viewBox: `0 0 ${total} ${total}`,
    width: size,
    height: size,
    role: 'img',
    'aria-label': label,
    'shape-rendering': 'crispEdges',
    class: 'qr',
  });
  svg.appendChild(el('rect', { width: total, height: total, fill: '#ffffff' }));
  svg.appendChild(el('path', { d: qrPath((r, c) => qr.isDark(r, c), count), fill: '#000000' }));
  return svg;
}
