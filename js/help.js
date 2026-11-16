// Night Ops v1.4 (PAGE-DEVICES): what kind of phone this is, and step-by-step help to turn location, the camera,
// the microphone and the alarm sound back on. Pure (no DOM): the fix-it screen and the ready check draw it.
//
//   deviceKind(nav) -> 'ios-safari' | 'ios-app' | 'ios-chrome' | 'ios-other' | 'android-chrome' | 'android-other' | 'other'
//   helpFor(part, why, kind) -> { title, line, steps: [string], after: string | null }
//      part 'location' | 'camera' | 'mic' | 'sound'; why as loc.health() or media.js's states
//
// Steps are plain lines; words between ** ** are menu names (the screen draws them bold). Where a phone's exact
// menu isn't certain, the words stay loose ("the aA or ... button next to the address").

export const KINDS = ['ios-safari', 'ios-app', 'ios-chrome', 'ios-other', 'android-chrome', 'android-other', 'other'];
export const PARTS = ['location', 'camera', 'mic', 'sound'];
export const WHYS = {
  location: ['denied', 'off', 'timeout', 'stale', 'none', 'asking'],
  camera: ['denied', 'off', 'none'],
  mic: ['denied', 'off', 'none', 'silent'],
  sound: ['locked'],
};

export function deviceKind(nav = globalThis.navigator, win = globalThis.window) {
  const ua = String((nav && nav.userAgent) || '');
  const touch = Number(nav && nav.maxTouchPoints) || 0;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
  if (ios) {
    let standalone = !!(nav && nav.standalone === true);
    if (!standalone) {
      try { standalone = !!(win && win.matchMedia && win.matchMedia('(display-mode: standalone)').matches); } catch { /* no */ }
    }
    if (/CriOS/.test(ua)) return 'ios-chrome';
    if (/FxiOS|EdgiOS|OPiOS|GSA\/|DuckDuckGo|YaBrowser|Brave/.test(ua)) return 'ios-other';
    if (standalone) return 'ios-app';
    return 'ios-safari';
  }
  if (/Android/.test(ua)) {
    if (/Chrome\//.test(ua) && !/SamsungBrowser|Firefox|EdgA|OPR|Opera|UCBrowser|YaBrowser|DuckDuckGo/.test(ua)) return 'android-chrome';
    return 'android-other';
  }
  return 'other';
}

import { silentSwitchMutes } from './alerts.js?v=146';

const TRY = 'Tap **Try again**.';
export const RELOAD = 'If **Try again** still says no, tap **Reload Night Ops** (Safari only takes the new setting after a reload).';
export const AFTER_LOCATION = 'Keep Night Ops open. A locked phone stops sending your location (use pocket mode: the moon button).';

const IOS_LS = [
  'Open the **Settings** app.',
  'Tap **Privacy & Security**, then **Location Services**. Make sure it\'s on.',
];
const IOS_SAFARI_SITES = 'Scroll down to **Safari Websites** and pick **While Using the App** (or **Ask Next Time**).';
const IOS_SITE = 'Come back here, tap the **aA** (or **...**) button next to the address, then **Website Settings**, and set **Location** to **Allow**.';
const WEAK = [
  'Step outside or near a window: phones find you best under open sky.',
  'Turn on precise location (iPhone: **Precise Location** in the same Settings screen; Android: **Use precise location**).',
  TRY,
];
const iosApp = (what) => [
  'Open the **Settings** app.',
  `Tap **Privacy & Security**, then **${what}**, and check the browser you're using is allowed.`,
];

const LOCATION = {
  'ios-safari': {
    denied: [...IOS_LS, IOS_SAFARI_SITES, IOS_SITE, TRY, RELOAD],
    off: [...IOS_LS, TRY],
  },
  'ios-app': {
    denied: [...IOS_LS, IOS_SAFARI_SITES,
      'If it still says no, open Night Ops in Safari once, allow location there, then come back to this app.', TRY, RELOAD],
    off: [...IOS_LS, TRY],
  },
  'ios-chrome': {
    denied: ['Open the **Settings** app: **Privacy & Security** > **Location Services** (on) > **Chrome** > **While Using the App**.',
      'In Chrome, tap Try again and allow it.'],
    off: [...IOS_LS, TRY],
  },
  'ios-other': {
    denied: ['Open the **Settings** app: **Privacy & Security** > **Location Services** (on), then pick the browser you\'re using and set it to **While Using the App**.',
      'Come back here, tap Try again and allow it.'],
    off: [...IOS_LS, TRY],
  },
  'android-chrome': {
    denied: [
      'Swipe down from the top of the screen and check **Location** is on (Chrome says "denied" when the whole phone\'s location is off).',
      'Tap the icon left of the address (a lock or two sliders).',
      'Tap **Permissions** (or **Site settings**), then **Location**, and pick **Allow**.',
      'If Chrome itself isn\'t allowed: phone **Settings** > **Apps** > **Chrome** > **Permissions** > **Location** > **Allow only while using the app**, with **Use precise location** on.',
      TRY,
    ],
    off: ['Swipe down from the top of the screen and turn on **Location**.', TRY],
  },
  'android-other': {
    denied: [
      'Open your browser\'s menu or the icon next to the address, find **Site settings** or **Permissions**, and allow **Location** for this site.',
      'If the browser itself isn\'t allowed: phone **Settings** > **Apps** > your browser > **Permissions** > **Location** > **Allow**.',
      TRY,
    ],
    off: ['Swipe down from the top of the screen and turn on **Location**.', TRY],
  },
  other: {
    denied: ['Allow **Location** for this site in your browser\'s settings (often the icon next to the address).', TRY],
    off: ['Turn on location in your device\'s settings.', TRY],
  },
};

function media(what, word) {
  // what: 'Camera' | 'Microphone'; word: 'camera' | 'microphone'
  return {
    'ios-safari': {
      denied: [`Tap the **aA** (or **...**) button next to the address, then **Website Settings**, and set **${what}** to **Allow**.`,
        `If it isn't there: **Settings** app > **Apps** > **Safari** > **${what}** > **Allow** (on older iPhones **Settings** > **Safari**).`, TRY],
    },
    'ios-app': {
      denied: [`Open the **Settings** app and allow the **${what}** for Safari (**Apps** > **Safari** > **${what}**).`,
        'If it still says no, open Night Ops in Safari once, allow it there, then come back to this app.', TRY],
    },
    'ios-chrome': { denied: [...iosApp(what).slice(0, 1), `Tap **Privacy & Security** > **${what}** and turn **Chrome** on.`, TRY] },
    'ios-other': { denied: iosApp(what).concat(TRY) },
    'android-chrome': {
      denied: ['Tap the icon left of the address (a lock or two sliders).',
        `Tap **Permissions** (or **Site settings**), then **${what}**, and pick **Allow**.`,
        `If Chrome itself isn't allowed: phone **Settings** > **Apps** > **Chrome** > **Permissions** > **${what}** > **Allow**.`, TRY],
    },
    'android-other': {
      denied: [`Open your browser's site settings (the icon next to the address) and allow the **${what}** for this site.`, TRY],
    },
    other: { denied: [`Allow the **${what}** for this site in your browser's settings.`, TRY] },
    _off: [`Another app may be using the ${word} (a call, FaceTime, the Camera app, Siri). Close it.`, 'Come back to Night Ops and tap **Try again**.'],
    _none: [`Night Ops can't find a ${word} on this phone. If you use earbuds, take them out and put them back in.`, TRY],
    _silent: ['Your microphone hears nothing. A call or Siri may have taken it.', 'Take earbuds out and back in, or close the app that took it.', TRY],
  };
}

const CAMERA = media('Camera', 'camera');
const MIC = media('Microphone', 'microphone');

const SOUND = {
  _locked: ['Tap **Test** so Night Ops is allowed to make sound.', 'Turn your volume up. On newer iPhones sound plays even with the silent switch on; if you hear nothing, flip the switch off.'],
  // older iPhones (before iOS 17): the silent switch mutes web sound
  _muted: ['Tap **Test** so Night Ops is allowed to make sound.', 'Turn your volume up and turn the silent switch off (no orange showing).'],
};

export const HELP = { location: LOCATION, camera: CAMERA, mic: MIC, sound: SOUND };

const TITLES = { location: 'Your location is off', camera: 'Your camera is off', mic: 'Your microphone is off', sound: 'Alarm sound is off' };
const LINES = {
  location: {
    denied: "Night Ops isn't allowed to use your location.",
    off: "Your phone's location is turned off.",
    timeout: "Your phone can't find where you are.",
    stale: "Your phone can't find where you are.",
    none: "This browser can't share a location.",
    asking: 'Night Ops is asking for your location.',
  },
  camera: { denied: "Night Ops isn't allowed to use your camera.", off: 'Your camera stopped.', none: 'No camera found.' },
  mic: { denied: "Night Ops isn't allowed to use your microphone.", off: 'Your microphone stopped.', none: 'No microphone found.', silent: 'Your microphone hears nothing.' },
  sound: { locked: "Night Ops can't make sound yet." },
};

export function helpFor(part, why, kind, { silentMutes = silentSwitchMutes() } = {}) {
  const p = PARTS.includes(part) ? part : 'location';
  const k = KINDS.includes(kind) ? kind : 'other';
  const w = String(why || '');
  const table = HELP[p];
  let steps = null;
  if (p === 'location') {
    if (w === 'timeout' || w === 'stale') steps = WEAK;
    else if (w === 'none') steps = ['Open Night Ops in Safari (iPhone) or Chrome (Android): this browser can\'t share a location.'];
    else steps = (table[k] && (table[k][w] || table[k].denied)) || table.other.denied;
    if (w === 'off' && table[k] && table[k].off) steps = table[k].off;
  } else if (p === 'sound') {
    steps = silentMutes ? SOUND._muted : SOUND._locked;
  } else if (w === 'off' || w === 'none' || w === 'silent') {
    steps = table[`_${w}`];
  } else {
    steps = (table[k] && table[k].denied) || table.other.denied;
  }
  const lines = LINES[p];
  return {
    title: p === 'location' && (w === 'timeout' || w === 'stale') ? "Can't find you" : TITLES[p],
    line: lines[w] || lines[Object.keys(lines)[0]],
    steps: steps.slice(),
    after: p === 'location' ? AFTER_LOCATION : null,
  };
}

// "**Settings** app" -> [{ text: 'Settings', bold: true }, { text: ' app', bold: false }]
export function stepParts(step) {
  const out = [];
  String(step).split('**').forEach((t, i) => { if (t) out.push({ text: t, bold: i % 2 === 1 }); });
  return out;
}
