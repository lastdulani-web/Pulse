// Lightweight, dependency-free tag reader.
// MP3 (ID3v2.2/2.3/2.4), FLAC (Vorbis comments + picture), M4A/MP4 (ilst atoms).
// Anything it can't read falls back to the file name, so import never fails.

const latin = new TextDecoder('iso-8859-1');
const utf8 = new TextDecoder('utf-8');
const u16le = new TextDecoder('utf-16le');
const u16be = new TextDecoder('utf-16be');

const clean = (s) => s.replace(/\0+$/, '').replace(/^\uFEFF/, '').trim();
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const synch = (b, o) => ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127);
const u32 = (b, o) => b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

function decode(b, enc) {
  if (enc === 1) {
    if (b[0] === 0xFF && b[1] === 0xFE) return clean(u16le.decode(b.subarray(2)));
    if (b[0] === 0xFE && b[1] === 0xFF) return clean(u16be.decode(b.subarray(2)));
    return clean(u16le.decode(b));
  }
  if (enc === 2) return clean(u16be.decode(b));
  if (enc === 3) return clean(utf8.decode(b));
  return clean(latin.decode(b));
}

/* ---------- MP3 / ID3v2 ---------- */
function textFrame(body) {
  return decode(body.subarray(1), body[0]).split('\0')[0].trim();
}

// Unsynchronised lyrics frame (USLT / ULT): encoding, 3-byte language, descriptor, text
function usltFrame(body) {
  const enc = body[0];
  let p = 4;
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p++;
    p += 1;
  }
  return decode(body.subarray(p), enc).replace(/\0/g, '');
}

function pictureFrame(body, v2) {
  const enc = body[0];
  let p = 1, mime;
  if (v2) {
    mime = 'image/' + (ascii(body, 1, 3).toLowerCase() === 'png' ? 'png' : 'jpeg');
    p = 4;
  } else {
    const e = body.indexOf(0, p);
    mime = latin.decode(body.subarray(p, e));
    p = e + 1;
    if (!mime.includes('/')) mime = 'image/' + (mime || 'jpeg');
    mime = mime.replace('jpg', 'jpeg');
  }
  p += 1; // picture type byte
  if (enc === 1 || enc === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < body.length && body[p] !== 0) p++;
    p += 1;
  }
  return { data: body.subarray(p), mime };
}

function parseID3(b) {
  const ver = b[3];
  const end = Math.min(10 + synch(b, 6), b.length);
  let p = 10;
  if (b[5] & 0x40) p += ver === 4 ? synch(b, 10) : u32(b, 10) + 4; // extended header
  const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
  const out = {};
  while (p + hLen <= end) {
    if (b[p] === 0) break;
    const id = ascii(b, p, idLen);
    const size = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]
      : ver === 4 ? synch(b, p + 4) : u32(b, p + 4);
    const s = p + hLen, e = s + size;
    if (size <= 0 || e > end) break;
    const body = b.subarray(s, e);
    if (id === 'TIT2' || id === 'TT2') out.title = textFrame(body);
    else if (id === 'TPE1' || id === 'TP1') out.artist = textFrame(body);
    else if (id === 'TALB' || id === 'TAL') out.album = textFrame(body);
    else if ((id === 'USLT' || id === 'ULT') && !out.lyrics) out.lyrics = usltFrame(body);
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) out.cover = pictureFrame(body, ver === 2);
    p = e;
  }
  return out;
}

/* ---------- FLAC ---------- */
function parseFlac(b) {
  const out = {};
  let p = 4;
  while (p + 4 <= b.length) {
    const head = b[p], last = head & 0x80, type = head & 0x7f;
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const s = p + 4, e = s + len;
    if (e > b.length) break;
    const dv = new DataView(b.buffer, b.byteOffset + s, len);
    if (type === 4) {
      let o = 0;
      o += 4 + dv.getUint32(o, true);
      const n = dv.getUint32(o, true); o += 4;
      for (let i = 0; i < n && o + 4 <= len; i++) {
        const l = dv.getUint32(o, true); o += 4;
        const str = utf8.decode(b.subarray(s + o, s + o + l)); o += l;
        const k = str.indexOf('=');
        if (k < 0) continue;
        const key = str.slice(0, k).toUpperCase(), val = str.slice(k + 1).trim();
        if (key === 'TITLE') out.title = val;
        else if (key === 'ARTIST') out.artist = val;
        else if (key === 'ALBUM') out.album = val;
        else if ((key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'UNSYNCED LYRICS') && !out.lyrics) out.lyrics = val;
      }
    } else if (type === 6 && !out.cover) {
      let o = 4;
      const ml = dv.getUint32(o); o += 4;
      const mime = latin.decode(b.subarray(s + o, s + o + ml)); o += ml;
      const dl = dv.getUint32(o); o += 4 + dl + 16;
      const il = dv.getUint32(o); o += 4;
      out.cover = { data: b.subarray(s + o, s + o + il), mime: mime || 'image/jpeg' };
    }
    if (last) break;
    p = e;
  }
  return out;
}

/* ---------- M4A / MP4 ---------- */
function boxes(b, s, e) {
  const out = [];
  let p = s;
  while (p + 8 <= e) {
    const len = u32(b, p);
    if (len < 8 || p + len > e) break;
    out.push({ type: ascii(b, p + 4, 4), s: p + 8, e: p + len });
    p += len;
  }
  return out;
}
const find = (b, s, e, type) => boxes(b, s, e).find((x) => x.type === type);

function parseMoov(b) {
  const out = {};
  const udta = find(b, 0, b.length, 'udta');
  const meta = udta && find(b, udta.s, udta.e, 'meta');
  const ilst = meta && find(b, meta.s + 4, meta.e, 'ilst');
  if (!ilst) return out;
  for (const item of boxes(b, ilst.s, ilst.e)) {
    const d = find(b, item.s, item.e, 'data');
    if (!d) continue;
    const flags = u32(b, d.s) & 0xFFFFFF;
    const payload = b.subarray(d.s + 8, d.e);
    if (item.type === '\xA9nam') out.title = clean(utf8.decode(payload));
    else if (item.type === '\xA9ART') out.artist = clean(utf8.decode(payload));
    else if (item.type === 'aART' && !out.artist) out.artist = clean(utf8.decode(payload));
    else if (item.type === '\xA9alb') out.album = clean(utf8.decode(payload));
    else if (item.type === '\xA9lyr') out.lyrics = clean(utf8.decode(payload));
    else if (item.type === 'covr') out.cover = { data: payload, mime: flags === 14 ? 'image/png' : 'image/jpeg' };
  }
  return out;
}

async function parseMp4(file) {
  let pos = 0;
  while (pos + 8 <= file.size) {
    const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let len = h.getUint32(0), hdr = 8;
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (len === 1 && h.byteLength >= 16) { len = Number(h.getBigUint64(8)); hdr = 16; }
    else if (len === 0) len = file.size - pos;
    if (len < 8) break;
    if (type === 'moov') {
      if (len > 64 * 1048576) return {};
      return parseMoov(new Uint8Array(await file.slice(pos + hdr, pos + len).arrayBuffer()));
    }
    pos += len;
  }
  return {};
}

/* ---------- Helpers ---------- */
function fromFilename(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/^\s*\d{1,3}[\s.\-)]+(?=\D)/, '').trim();
  const k = base.indexOf(' - ');
  if (k > 0) return { artist: base.slice(0, k).trim(), title: base.slice(k + 3).trim() || base };
  return { title: base || name, artist: '' };
}

// Shrink cover art to a small JPEG so the library stays light.
async function shrink(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    return out || blob;
  } catch { return blob; }
}

export async function readMeta(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let m = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (ascii(head, 0, 3) === 'ID3') {
      const size = synch(head, 6) + 10;
      m = parseID3(new Uint8Array(await file.slice(0, Math.min(size, 25 * 1048576)).arrayBuffer()));
    } else if (ascii(head, 0, 4) === 'fLaC') {
      m = parseFlac(new Uint8Array(await file.slice(0, Math.min(file.size, 16 * 1048576)).arrayBuffer()));
    } else if (ascii(head, 4, 4) === 'ftyp' || ext === 'm4a') {
      m = await parseMp4(file);
    }
  } catch { /* fall back to filename */ }
  const fb = fromFilename(file.name);
  const cover = m.cover && m.cover.data.length > 200
    ? await shrink(new Blob([m.cover.data], { type: m.cover.mime }))
    : null;
  return {
    title: m.title || fb.title,
    artist: m.artist || fb.artist || '',
    album: m.album || '',
    cover,
    lyrics: parseLyrics(m.lyrics),
  };
}

/* ---------- Lyrics ---------- */
// Accepts plain text or LRC text. Returns { synced: [{t, text}] | null, plain } or null.
const LRC_TIME = /\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]/g;
const LRC_WORD = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;

export function parseLyrics(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const off = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text);
  const offset = off ? parseInt(off[1], 10) / 1000 : 0;
  const synced = [];
  const plain = [];
  for (const line of text.split('\n')) {
    const times = [];
    LRC_TIME.lastIndex = 0;
    let m;
    while ((m = LRC_TIME.exec(line))) times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
    const body = line.replace(LRC_TIME, '').replace(LRC_WORD, '').trim();
    if (times.length) {
      for (const t of times) synced.push({ t: Math.max(0, t - offset), text: body });
      plain.push(body);
    } else if (/^\[[a-z]{2,}:[^\]]*\]$/i.test(line.trim())) {
      continue; // metadata tag such as [ar:Artist]
    } else {
      plain.push(line.trim());
    }
  }
  const plainText = plain.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (synced.length >= 2) {
    synced.sort((a, b) => a.t - b.t);
    return { synced, plain: plainText };
  }
  return plainText ? { synced: null, plain: plainText } : null;
}

// Reads a .lrc file (UTF-8, UTF-16 or old Windows encodings)
export async function readLrcFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s;
  if (buf[0] === 0xFF && buf[1] === 0xFE) s = u16le.decode(buf.subarray(2));
  else if (buf[0] === 0xFE && buf[1] === 0xFF) s = u16be.decode(buf.subarray(2));
  else {
    s = utf8.decode(buf);
    if (s.includes('\uFFFD')) s = new TextDecoder('windows-1252').decode(buf);
  }
  return parseLyrics(s);
}

// Builds the text of an .lrc file from timed lines: [{ t: seconds, text }]
export function formatLrc(lines, info = {}) {
  const out = [];
  if (info.title) out.push(`[ti:${info.title}]`);
  if (info.artist) out.push(`[ar:${info.artist}]`);
  if (info.album) out.push(`[al:${info.album}]`);
  out.push('[by:Pulse Media Player]');
  for (const l of lines) {
    const cs = Math.round(Math.max(0, l.t) * 100);
    const mm = Math.floor(cs / 6000);
    const ss = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    out.push(`[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(c).padStart(2, '0')}]${l.text}`);
  }
  return out.join('\n') + '\n';
}
