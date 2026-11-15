// Night Ops: line icons (24x24, currentColor, 2px strokes). icon(name, size) -> <svg aria-hidden="true">.
// Add new ones here rather than inline in screens, so every screen draws them the same way.

const NS = 'http://www.w3.org/2000/svg';

// Each icon: a list of [tag, attributes]. Strokes unless the attributes say fill.
const PATHS = {
  radar: [['circle', { cx: 12, cy: 12, r: 9 }], ['circle', { cx: 12, cy: 12, r: 4.5 }], ['path', { d: 'M12 12 18.5 5.5' }]],
  eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  jammer: [['path', { d: 'M2 8.5a15 15 0 0 1 20 0' }], ['path', { d: 'M5.5 12a10 10 0 0 1 13 0' }], ['path', { d: 'M9 15.5a5 5 0 0 1 6 0' }], ['path', { d: 'M3 3l18 18' }]],
  decoy: [['path', { d: 'M9 20s-5-4.6-5-8.5a5 5 0 0 1 10 0C14 15.4 9 20 9 20z' }], ['path', { d: 'M17 13.5s3-2.8 3-5.1a3 3 0 0 0-6 0', 'stroke-dasharray': '2 2.5' }]],
  sprint: [['path', { d: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z' }]],
  sos: [['path', { d: 'M12 3 2 20h20L12 3z' }], ['path', { d: 'M12 10v4' }], ['path', { d: 'M12 17h.01' }]],
  target: [['circle', { cx: 12, cy: 12, r: 8 }], ['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 1v4M12 19v4M1 12h4M19 12h4' }]],
  chat: [['path', { d: 'M4 5h16v11H9l-5 4V5z' }]],
  send: [['path', { d: 'M3 11 21 3l-8 18-2-8-8-2z' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  back: [['path', { d: 'M15 5l-7 7 7 7' }]],
  menu: [['circle', { cx: 5, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 19, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }]],
  fit: [['path', { d: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' }], ['circle', { cx: 12, cy: 12, r: 2.5 }]], // v1.2 PAGE-MAP: Fit everyone
  qr: [['path', { d: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z' }], ['path', { d: 'M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2' }]],
  link: [['path', { d: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1' }], ['path', { d: 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1' }]],
  copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], ['path', { d: 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3' }]],
  share: [['path', { d: 'M12 3v12M7 8l5-5 5 5' }], ['path', { d: 'M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6' }]],
  users: [['circle', { cx: 9, cy: 8, r: 3.5 }], ['path', { d: 'M2.5 20a6.5 6.5 0 0 1 13 0' }], ['path', { d: 'M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5' }]],
  shuffle: [['path', { d: 'M3 7h3.5c2.5 0 4 1.5 5.5 5s3 5 5.5 5H21' }], ['path', { d: 'M3 17h3.5c1.4 0 2.5-.5 3.4-1.5M14.1 8.5c.9-1 2-1.5 3.4-1.5H21' }], ['path', { d: 'M18 4l3 3-3 3M18 14l3 3-3 3' }]],
  crown: [['path', { d: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z' }]],
  check: [['path', { d: 'M4 12.5l5 5L20 6.5' }]],
  pin: [['path', { d: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z' }], ['circle', { cx: 12, cy: 9.5, r: 2.5 }]],
  circle: [['circle', { cx: 12, cy: 12, r: 9, 'stroke-dasharray': '3 3' }], ['circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' }]],
  draw: [['path', { d: 'M5 18 4 8l8-5 8 6-3 11H5z' }], ['circle', { cx: 4, cy: 8, r: 1.5, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 12, cy: 3, r: 1.5, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 20, cy: 9, r: 1.5, fill: 'currentColor', stroke: 'none' }]],
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }]],
  trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' }]],
  play: [['path', { d: 'M7 4v16l13-8L7 4z' }]],
  pause: [['path', { d: 'M8 5v14M16 5v14' }]],
  skipback: [['path', { d: 'M4 12a8 8 0 1 0 2.3-5.6' }], ['path', { d: 'M4 3v5h5' }]], // the 10 s buttons
  skipfwd: [['path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }], ['path', { d: 'M20 3v5h-5' }]],
  moon: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }]],
  door: [['path', { d: 'M14 4H6v16h8' }], ['path', { d: 'M10 12h10M17 9l3 3-3 3' }]],
  camera: [['path', { d: 'M4 8h3l2-3h6l2 3h3v11H4V8z' }], ['circle', { cx: 12, cy: 13, r: 3.5 }]],
  car: [['path', { d: 'M5 17h14v-5l-2-5H7l-2 5v5z' }], ['path', { d: 'M5 12h14' }], ['circle', { cx: 8, cy: 17, r: 1.5 }], ['circle', { cx: 16, cy: 17, r: 1.5 }]],
  warn: [['path', { d: 'M12 3 2 20h20L12 3z' }], ['path', { d: 'M12 10v4' }], ['path', { d: 'M12 17h.01' }]],
  locate: [['circle', { cx: 12, cy: 12, r: 7 }], ['circle', { cx: 12, cy: 12, r: 2.5, fill: 'currentColor', stroke: 'none' }], ['path', { d: 'M12 1v4M12 19v4M1 12h4M19 12h4' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
  flag: [['path', { d: 'M5 21V4M5 4h11l-2 4 2 4H5' }]],
  trophy: [['path', { d: 'M8 4h8v5a4 4 0 0 1-8 0V4z' }], ['path', { d: 'M8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 20h8M10 17h4' }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v6M12 7.5h.01' }]],
  settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' }]],
  speaker: [['path', { d: 'M11 5 6 9H2v6h4l5 4V5z' }], ['path', { d: 'M15.5 8.5a5 5 0 0 1 0 7' }], ['path', { d: 'M19 5a10 10 0 0 1 0 14' }]],
  mic: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }]],
};

export const ICON_NAMES = Object.keys(PATHS);

export function icon(name, size = 22, extraClass = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon${extraClass ? ` ${extraClass}` : ''}`);
  for (const [tag, attrs] of PATHS[name] || PATHS.info) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}
