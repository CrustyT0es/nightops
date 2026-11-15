// Night Ops v1.4 (PAGE-RENDER): a small MP4 muxer for WebCodecs' chunks, written here (no dependencies).
//
//   createMp4Muxer({ sink, video: { codec, w, h, description }, audio: { codec, rate, channels, description } })
//     -> { addVideo(chunk, meta), addAudio(chunk, meta), finish() -> Promise<{ bytes, videoSamples, audioSamples }> }
//
// Layout: ftyp, then one mdat (a 64-bit header, its size patched at the end) whose samples go to the sink as they
// come, so a 45-min movie never sits in memory, then moov at the end with the sample tables (kept in memory: a few
// MB for 45 min). Codecs: avc1 (avcC from the encoder's description), vp09 (vpcC from the codec string), mp4a
// (esds from the AudioSpecificConfig), Opus (dOps from the OpusHead). One sample per chunk entry; stco, or co64 once
// the file passes 4 GB. The sink: { write(bytes, at) -> Promise|void, patch(at, bytes) -> Promise|void }.

export const VIDEO_SCALE = 90000;
export const MOVIE_SCALE = 1000;

const enc = new TextEncoder();

function u8(n) { return [n & 255]; }
function u16(n) { return [(n >>> 8) & 255, n & 255]; }
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u64(n) { const hi = Math.floor(n / 4294967296); return [...u32(hi), ...u32(n >>> 0)]; }
function str(s) { return [...enc.encode(s)]; }
function bytesOf(x) {
  if (!x) return [];
  if (x instanceof ArrayBuffer) return [...new Uint8Array(x)];
  if (ArrayBuffer.isView(x)) return [...new Uint8Array(x.buffer, x.byteOffset, x.byteLength)];
  return [...x];
}

// A box from its type and parts (arrays of bytes, nested boxes are arrays too).
export function box(type, ...parts) {
  const body = parts.flat(Infinity);
  return [...u32(body.length + 8), ...str(type), ...body];
}
function full(type, version, flags, ...parts) { return box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts); }

function matrix() { return [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)]; }

// vp09.PP.LL.DD -> vpcC
export function vpcC(codec) {
  const p = String(codec).split('.');
  const profile = Number(p[1]) || 0, level = Number(p[2]) || 31, depth = Number(p[3]) || 8;
  return full('vpcC', 1, 0, u8(profile), u8(level), u8((depth << 4) | (1 << 1) | 0), u8(1), u8(1), u8(1), u16(0));
}

// AudioSpecificConfig for AAC-LC when the encoder gave none.
function asc(rate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  const i = Math.max(0, rates.indexOf(rate));
  return [(2 << 3) | (i >> 1), ((i & 1) << 7) | (channels << 3)];
}
function desc(tag, body) {
  const n = body.length;
  return [tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f, ...body];
}
function esds(config, bits) {
  const dsi = desc(5, config);
  const dcd = desc(4, [0x40, (0x05 << 2) | 1, 0, 0, 0, ...u32(bits), ...u32(bits), ...dsi]);
  const es = desc(3, [...u16(1), 0, ...dcd, ...desc(6, [2])]);
  return full('esds', 0, 0, es);
}
// OpusHead (little-endian, from the encoder) -> dOps (big-endian)
export function dOps(head, rate, channels) {
  const b = bytesOf(head);
  let ch = channels, pre = 312, inRate = rate, gain = 0;
  if (b.length >= 19 && String.fromCharCode(...b.slice(0, 8)) === 'OpusHead') {
    ch = b[9]; pre = b[10] | (b[11] << 8); inRate = (b[12] | (b[13] << 8) | (b[14] << 16) | (b[15] << 24)) >>> 0; gain = b[16] | (b[17] << 8);
  }
  return box('dOps', u8(0), u8(ch), u16(pre), u32(inRate), u16(gain), u8(0));
}

function visualEntry(type, w, h, inner) {
  const name = new Array(32).fill(0);
  return box(type, new Array(6).fill(0), u16(1), new Array(16).fill(0), u16(w), u16(h), u32(0x480000), u32(0x480000),
    u32(0), u16(1), name, u16(0x18), u16(0xffff), inner);
}
function audioEntry(type, rate, channels, inner) {
  return box(type, new Array(6).fill(0), u16(1), new Array(8).fill(0), u16(channels), u16(16), u16(0), u16(0),
    u32((Math.min(rate, 65535) << 16) >>> 0), inner);
}

function sampleEntry(t) {
  const c = String(t.codec);
  if (t.kind === 'video') {
    if (c.startsWith('avc1')) return visualEntry('avc1', t.w, t.h, box('avcC', bytesOf(t.description)));
    if (c.startsWith('vp09')) return visualEntry('vp09', t.w, t.h, vpcC(c));
    throw new Error(`MP4 can't hold ${c}`);
  }
  if (c.startsWith('mp4a')) return audioEntry('mp4a', t.rate, t.channels, esds(t.description ? bytesOf(t.description) : asc(t.rate, t.channels), t.bits || 64000));
  if (c === 'opus') return audioEntry('Opus', t.rate, t.channels, dOps(t.description, t.rate, t.channels));
  throw new Error(`MP4 can't hold ${c}`);
}

function runs(values) { // [[count, value]]
  const out = [];
  for (const v of values) { const last = out[out.length - 1]; if (last && last[1] === v) last[0] += 1; else out.push([1, v]); }
  return out;
}

function trak(t, id, movieMs, big) {
  const n = t.times.length;
  const durs = [];
  for (let i = 0; i < n; i += 1) {
    const next = i + 1 < n ? t.times[i + 1] : t.times[i] + t.lastDur;
    durs.push(Math.max(1, Math.round(((next - t.times[i]) * t.scale) / 1e6)));
  }
  const mediaDur = durs.reduce((a, b) => a + b, 0);
  const tkMs = Math.round((mediaDur * MOVIE_SCALE) / t.scale);
  const video = t.kind === 'video';
  const stts = runs(durs);
  const stbl = box('stbl',
    full('stsd', 0, 0, u32(1), sampleEntry(t)),
    full('stts', 0, 0, u32(stts.length), stts.map(([k, v]) => [...u32(k), ...u32(v)])),
    video ? full('stss', 0, 0, u32(t.keys.length), t.keys.map((k) => u32(k + 1))) : [],
    full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    full('stsz', 0, 0, u32(0), u32(n), t.sizes.map((s) => u32(s))),
    big ? full('co64', 0, 0, u32(n), t.offsets.map((o) => u64(o))) : full('stco', 0, 0, u32(n), t.offsets.map((o) => u32(o))));
  const minf = box('minf',
    video ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0)),
    box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
    stbl);
  const lang = ((('u'.charCodeAt(0) - 0x60) << 10) | (('n'.charCodeAt(0) - 0x60) << 5) | ('d'.charCodeAt(0) - 0x60));
  return { ms: tkMs, bytes: box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(tkMs), u32(0), u32(0), u16(0), u16(video ? 0 : 1),
      u16(video ? 0 : 0x100), u16(0), matrix(), u32(video ? t.w << 16 : 0), u32(video ? t.h << 16 : 0)),
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(t.scale), u32(mediaDur), u16(lang), u16(0)),
      full('hdlr', 0, 0, u32(0), str(video ? 'vide' : 'soun'), u32(0), u32(0), u32(0), str(video ? 'Video' : 'Sound'), u8(0)),
      minf)) };
}

export function createMp4Muxer({ sink, video = null, audio = null } = {}) {
  if (!sink || typeof sink.write !== 'function') throw new Error('No sink.');
  const tracks = [];
  const mk = (kind, o, scale) => ({ kind, ...o, scale, times: [], sizes: [], offsets: [], keys: [], lastDur: 0, first: null });
  const vt = video ? mk('video', video, VIDEO_SCALE) : null;
  const at = audio ? mk('audio', audio, audio.rate || 48000) : null;
  if (vt) tracks.push(vt);
  if (at) tracks.push(at);
  const brands = ['isom', 'iso2', 'mp41'];
  if (vt && String(vt.codec).startsWith('avc1')) brands.push('avc1');
  if (vt && String(vt.codec).startsWith('vp09')) brands.push('vp09');
  const ftyp = box('ftyp', str('isom'), u32(0x200), brands.map(str));
  let pos = 0;
  let chain = Promise.resolve();
  let waiting = 0; // bytes handed to the sink and not written yet: the caller waits when this grows (backpressure)
  const put = (bytes, where = pos) => {
    waiting += bytes.length;
    chain = chain.then(() => sink.write(bytes, where)).finally(() => { waiting -= bytes.length; });
  };
  put(Uint8Array.from(ftyp)); pos += ftyp.length;
  const mdatAt = pos;
  put(Uint8Array.from([...u32(1), ...str('mdat'), ...u64(0)])); pos += 16;
  let done = false;

  function add(t, chunk, meta) {
    if (done || !t) return;
    if (meta && meta.decoderConfig && meta.decoderConfig.description && !t.description) t.description = meta.decoderConfig.description;
    // a chunk that already carries its bytes (a copy the caller made) is used as it is: never copied twice
    let data = chunk.data instanceof Uint8Array ? chunk.data : null;
    if (!data) { data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); }
    const ts = Number(chunk.timestamp) || 0;
    if (t.first === null) t.first = ts;
    if (chunk.type === 'key') t.keys.push(t.times.length);
    t.times.push(ts - t.first);
    t.sizes.push(data.length);
    t.offsets.push(pos);
    if (chunk.duration) t.lastDur = Number(chunk.duration);
    put(data); pos += data.length;
  }
  return {
    addVideo: (chunk, meta) => add(vt, chunk, meta),
    addAudio: (chunk, meta) => add(at, chunk, meta),
    get bytes() { return pos; },
    get pending() { return waiting; },
    drained: () => chain,
    async finish() {
      if (done) throw new Error('Finished already.');
      done = true;
      await chain;
      for (const t of tracks) if (!t.lastDur) t.lastDur = t.times.length > 1 ? (t.times[t.times.length - 1] - t.times[0]) / (t.times.length - 1) : 33333;
      const big = pos > 0xffffffff - 1e7;
      const traks = tracks.filter((t) => t.times.length).map((t, i) => trak(t, i + 1, 0, big));
      const ms = Math.max(0, ...traks.map((x) => x.ms));
      const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_SCALE), u32(ms), u32(0x10000), u16(0x100), u16(0), u32(0), u32(0),
        matrix(), new Array(24).fill(0), u32(traks.length + 1));
      const moov = box('moov', mvhd, traks.map((x) => x.bytes));
      const mdatSize = pos - mdatAt;
      await sink.write(Uint8Array.from(moov), pos);
      pos += moov.length;
      await (sink.patch ? sink.patch(mdatAt + 8, Uint8Array.from(u64(mdatSize))) : sink.write(Uint8Array.from(u64(mdatSize)), mdatAt + 8));
      return { bytes: pos, ms, videoSamples: vt ? vt.times.length : 0, audioSamples: at ? at.times.length : 0 };
    },
  };
}

// Reading boxes back (tests, and a quick check of a made file). -> [{ type, at, size, start (of the body), end }]
export function readBoxes(bytes, from = 0, to = bytes.length) {
  const out = [];
  let i = from;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i + 8 <= to) {
    let size = dv.getUint32(i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    let head = 8;
    if (size === 1) { size = dv.getUint32(i + 8) * 4294967296 + dv.getUint32(i + 12); head = 16; }
    if (size === 0) size = to - i;
    if (size < head || i + size > to) break;
    out.push({ type, at: i, size, start: i + head, end: i + size });
    i += size;
  }
  return out;
}
