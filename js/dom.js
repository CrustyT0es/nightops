// Night Ops: tiny DOM helpers. Never put anyone's text into innerHTML: h() only ever uses textContent.

// h('button.btn.primary', { onclick, disabled: true, 'aria-label': 'Start' }, 'Start', childNode, [more])
// The tag may carry .classes and one #id. Attributes: on* functions become listeners; class/className;
// style objects; booleans add/remove the attribute; null/undefined/false are skipped. dataset via data-*.
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/i.exec(tag);
  if (!m) throw new Error(`bad tag ${tag}`);
  const el = document.createElement(m[1] || 'div');
  if (m[2]) el.id = m[2].slice(1);
  if (m[3]) el.className = m[3].slice(1).replace(/\./g, ' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) setAttrs(el, attrs);
  add(el, children);
  return el;
}

export function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) {
      if (!k.startsWith('on')) el.removeAttribute(k === 'className' ? 'class' : k);
      continue;
    }
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class' || k === 'className') {
      el.className = el.className ? `${el.className} ${v}` : v;
    } else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k === 'text') {
      el.textContent = String(v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else if (k === 'value' && 'value' in el) {
      el.value = String(v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  return el;
}

// Append children: strings/numbers become text nodes; arrays are flattened; null/false skipped.
export function add(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Replace everything inside el with children.
export function fill(el, ...children) {
  el.replaceChildren();
  return add(el, children);
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

// Set an element's text only when it changed (keeps screen readers and layout calm).
export function text(el, value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (el.textContent !== s) el.textContent = s;
  return el;
}

// Toggle a class; returns el.
export function cls(el, name, on) {
  el.classList.toggle(name, !!on);
  return el;
}

// The first letter of a name, for a face with no selfie.
export function initial(name) {
  const s = String(name || '?').trim();
  return (s ? Array.from(s)[0] : '?').toUpperCase();
}

// A face: the selfie if there is one, else the initial; ringed in the team colour.
// team: 'hunter' | 'hider' | 'driver' | 'out' | null. size in px.
export function face({ name, src, team, size = 36, extra = '' } = {}) {
  const el = h(`span.face${team ? `.t-${team}` : ''}${extra ? `.${extra}` : ''}`, {
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` },
    'aria-hidden': 'true',
  });
  if (src) {
    el.appendChild(h('img', { src, alt: '', draggable: 'false' }));
  } else {
    el.textContent = initial(name);
  }
  return el;
}

// Listen; returns a function that stops listening.
export function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}
