// Pulse playback engine.
//  - Two audio "decks" so the next song can be loaded ahead of time (gapless) and
//    overlapped with the current one (crossfade).
//  - Optional Web Audio graph ("enhanced audio engine") for crossfade, the volume
//    leveller and the visualiser. It is only created when one of those is used, so
//    plain playback stays exactly as simple as before.
//  - Silence trimming, queue, shuffle/repeat, MediaSession and resume.
import * as db from './db.js';

export const cfg = { engine: true, crossfade: 0, trim: false, trimSense: 'normal', level: 'off' };

export const S = {
  map: new Map(),   // id -> track
  list: [],         // ids in the order the user was browsing
  queue: [],        // ids in actual play order (shuffled or not)
  idx: -1,
  shuffle: false,
  repeat: 'off',    // 'off' | 'all' | 'one'
};

// iOS ignores audio.volume (it is read-only there), so the UI hides the slider.
export const volumeSupported = (() => { const a = new Audio(); a.volume = 0.5; return a.volume === 0.5; })();

const listeners = { track: [], state: [], time: [], queue: [], error: [] };
export const on = (ev, fn) => listeners[ev].push(fn);
const emit = (ev, arg) => listeners[ev].forEach((fn) => fn(arg));

/* ---------- decks ---------- */
function makeDeck() {
  const el = new Audio();
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  return { el, url: null, id: null, tok: 0, src: null, lvl: null, fade: null, agcOn: false, agcDb: 0, smooth: null };
}
const decks = [makeDeck(), makeDeck()];
let ai = 0;
export let audio = decks[0].el;          // always the deck that is currently audible
const act = () => decks[ai];
const idle = () => decks[1 - ai];
export const current = () => S.map.get(S.queue[S.idx]);

/* ---------- covers ---------- */
const covers = new Map();
export function coverURL(t) {
  if (!t || !t.cover) return null;
  if (!covers.has(t.id)) covers.set(t.id, URL.createObjectURL(t.cover));
  return covers.get(t.id);
}
function dropCover(id) {
  if (covers.has(id)) { URL.revokeObjectURL(covers.get(id)); covers.delete(id); }
}

/* ---------- queue ---------- */
function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue(startId) {
  if (S.shuffle) {
    const rest = shuffleArr(S.list.filter((i) => i !== startId));
    S.queue = startId != null ? [startId, ...rest] : rest;
    S.idx = startId != null ? 0 : -1;
  } else {
    S.queue = S.list.slice();
    S.idx = startId != null ? S.queue.indexOf(startId) : -1;
  }
}

export function setCatalog(tracks) {
  S.map = new Map(tracks.map((t) => [t.id, t]));
}

export async function playList(ids, startId) {
  S.list = ids.slice();
  buildQueue(startId);
  emit('queue');
  await switchTo(S.idx, { play: true });
}

export async function jumpTo(queueIndex) {
  emit('queue');
  await switchTo(queueIndex, { play: true });
}

export function setShuffle(v) {
  const cur = S.queue[S.idx];
  S.shuffle = v;
  buildQueue(cur);
  emit('queue');
  save();
}

export function cycleRepeat() {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  emit('queue');
  save();
}

/* ---------- silence trimming ---------- */
const SENSE = { gentle: 0, normal: 1, aggressive: 2 };
function trimOf(t) {
  if (!cfg.trim || !t || !t.an || !Array.isArray(t.an.s)) return null;
  const i = SENSE[cfg.trimSense] ?? 1;
  return { s: t.an.s[i] || 0, e: t.an.e[i] || 0 };
}
const startOf = (t) => { const tr = trimOf(t); return tr && tr.s > 0.25 ? tr.s : 0; };
const endOf = (t, dur) => { const tr = trimOf(t); return tr && tr.e > 0 && tr.e < dur - 0.25 ? tr.e : dur; };

/* ---------- audio engine (Web Audio) ---------- */
let ctx = null;
let nodes = null;
let vizWanted = false;
let transitioning = false;
const LEVEL_TARGET = -18; // dBFS RMS that songs are levelled towards

export const engineSupported = () => !!(window.AudioContext || window.webkitAudioContext);
export const engineActive = () => !!(ctx && nodes && cfg.engine);
export const getAnalyser = () => (nodes ? nodes.an : null);
export const sampleRate = () => (ctx ? ctx.sampleRate : 0);
export function setVizWanted(v) { vizWanted = !!v; }
const needsEngine = () => cfg.engine && (cfg.crossfade > 0 || cfg.level !== 'off' || vizWanted);

const setComp = (n, [th, knee, ratio, attack, release]) => {
  n.threshold.value = th; n.knee.value = knee; n.ratio.value = ratio;
  n.attack.value = attack; n.release.value = release;
};
const NEUTRAL = [0, 0, 1, 0.01, 0.2];
const DYN = {
  off:    { comp: NEUTRAL,                   lim: [0, 0, 1, 0.003, 0.1] },
  light:  { comp: NEUTRAL,                   lim: [-3, 3, 12, 0.003, 0.15] },
  normal: { comp: [-26, 12, 2.5, 0.02, 0.3], lim: [-2, 3, 12, 0.003, 0.15] },
  strong: { comp: [-32, 10, 5, 0.015, 0.25], lim: [-2, 3, 14, 0.003, 0.15] },
};
function applyDynamics() {
  if (!nodes) return;
  const d = DYN[cfg.engine ? cfg.level : 'off'] || DYN.off;
  setComp(nodes.comp, d.comp);
  setComp(nodes.lim, d.lim);
}

function setDeckLevel(d, t) {
  if (!d.lvl || !ctx) return;
  let db = 0;
  d.agcOn = false;
  d.agcDb = 0;
  d.smooth = null;
  if (cfg.engine && cfg.level !== 'off' && t) {
    if (t.an && typeof t.an.rms === 'number' && t.an.rms > -90) {
      const amount = cfg.level === 'light' ? 0.5 : 1;
      db = Math.max(-12, Math.min(9, (LEVEL_TARGET - t.an.rms) * amount));
      if (typeof t.an.peak === 'number' && t.an.peak + db > -1) db = -1 - t.an.peak;  // keep headroom
    } else {
      d.agcOn = true; // not analysed yet: follow the loudness live instead
    }
  }
  d.lvl.gain.setTargetAtTime(Math.pow(10, db / 20), ctx.currentTime, 0.05);
}

// Live fallback for songs that have not been analysed: nudges the gain towards the target.
const agcBuf = new Float32Array(2048);
setInterval(() => {
  if (!nodes || !cfg.engine || cfg.level === 'off' || transitioning) return;
  const d = act();
  if (!d.agcOn || d.el.paused || !ctx || ctx.state !== 'running') return;
  nodes.an.getFloatTimeDomainData(agcBuf);
  let sum = 0;
  for (let i = 0; i < agcBuf.length; i++) sum += agcBuf[i] * agcBuf[i];
  const db = 10 * Math.log10(sum / agcBuf.length + 1e-12);
  if (db < -52) return;                                  // quiet passage: leave the gain alone
  d.smooth = d.smooth == null ? db : d.smooth * 0.9 + db * 0.1;
  const err = LEVEL_TARGET - d.smooth;
  if (Math.abs(err) < 1.5) return;
  const step = (cfg.level === 'light' ? 0.06 : 0.12) * err;
  d.agcDb = Math.max(-12, Math.min(9, d.agcDb + step));
  d.lvl.gain.setTargetAtTime(Math.pow(10, d.agcDb / 20), ctx.currentTime, 0.4);
}, 250);

function ensureEngine() {
  if (!cfg.engine || !engineSupported()) return false;
  if (!ctx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC({ latencyHint: 'playback' });
      const n = {};
      n.mix = ctx.createGain();
      n.comp = ctx.createDynamicsCompressor();
      n.lim = ctx.createDynamicsCompressor();
      n.an = ctx.createAnalyser();
      n.an.fftSize = 2048;
      n.an.smoothingTimeConstant = 0.72;
      n.an.minDecibels = -88;
      n.an.maxDecibels = -12;
      n.mix.connect(n.comp); n.comp.connect(n.lim); n.lim.connect(n.an); n.an.connect(ctx.destination);
      decks.forEach((d) => {
        d.src = ctx.createMediaElementSource(d.el);
        d.lvl = ctx.createGain();
        d.fade = ctx.createGain();
        d.src.connect(d.lvl); d.lvl.connect(d.fade); d.fade.connect(n.mix);
      });
      nodes = n;
      // Phone calls, lock screen etc. can pause the audio context: wake it back up.
      ctx.onstatechange = () => {
        if ((ctx.state === 'suspended' || ctx.state === 'interrupted') && !audio.paused) ctx.resume().catch(() => {});
      };
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && ctx && ctx.state !== 'running' && !audio.paused) ctx.resume().catch(() => {});
      });
      applyDynamics();
      decks.forEach((d) => setDeckLevel(d, S.map.get(d.id)));
    } catch (e) {
      console.error('Audio engine unavailable', e);
      ctx = null; nodes = null;
      return false;
    }
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return true;
}

// Call from a tap/click so the browser allows audio to start.
export function requestEngine() { return ensureEngine(); }

export function reapply() {
  applyDynamics();
  decks.forEach((d) => setDeckLevel(d, S.map.get(d.id)));
}
export function configure(patch) {
  Object.assign(cfg, patch);
  reapply();
}

/* ---------- first-tap unlock ---------- */
// Phones only let a media element start playing after a tap. Starting the spare deck
// silently once means it can take over later (next song, lock screen) without a tap.
let unlocked = false;
let silentUrl = null;
function makeSilentWav() {
  const n = 800, sr = 8000;
  const b = new ArrayBuffer(44 + n * 2);
  const v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
export function unlock() {
  if (!unlocked) {
    unlocked = true;
    try {
      const d = idle();
      if (!d.el.getAttribute('src')) {
        if (!silentUrl) silentUrl = makeSilentWav();
        d.el.src = silentUrl;
        const p = d.el.play();
        if (p && p.then) {
          p.then(() => { d.el.pause(); d.el.removeAttribute('src'); d.el.load(); })
            .catch(() => { d.el.removeAttribute('src'); });
        }
      }
    } catch { /* not critical */ }
  }
  if (needsEngine()) ensureEngine();
}

/* ---------- loading and switching tracks ---------- */
let switchToken = 0;
let pendingQueue = null;
let failStreak = 0;

async function prepare(d, id) {
  if (d.id === id && d.url) return true;
  const tok = ++d.tok;
  const blob = await db.getFile(id);
  if (d.tok !== tok) return false;
  if (!blob) return false;
  if (d.url) URL.revokeObjectURL(d.url);
  d.url = URL.createObjectURL(blob);
  d.id = id;
  d.el.src = d.url;
  d.el.load();
  return true;
}

function whenMeta(el) {
  return new Promise((resolve) => {
    if (el.readyState >= 1) return resolve();
    const done = () => { el.removeEventListener('loadedmetadata', done); clearTimeout(tm); resolve(); };
    const tm = setTimeout(done, 4000);
    el.addEventListener('loadedmetadata', done);
  });
}

async function place(d, t, startAt) {
  await whenMeta(d.el);
  const st = startAt != null ? startAt : startOf(t);
  try { d.el.currentTime = st || 0; } catch { /* ignore */ }
}

async function playEl(el) {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  try { await el.play(); return true; } catch { return false; }
}

const CURVE_IN = new Float32Array(64).map((_, i) => Math.sin((i / 63) * Math.PI / 2));
const CURVE_OUT = new Float32Array(64).map((_, i) => Math.cos((i / 63) * Math.PI / 2));

// Never let a failure leave the scheduler stuck in the middle of a switch
async function switchTo(...args) {
  try { return await doSwitch(...args); } catch (e) {
    console.error(e);
    transitioning = false;
    emit('error', 'Couldn’t load that song.');
  }
}

async function doSwitch(idx, { play = true, fade = 0, startAt = null } = {}) {
  const q = pendingQueue || S.queue;
  const id = q[idx];
  const t = S.map.get(id);
  if (!t) return resetPlayer();

  const token = ++switchToken;
  transitioning = true;
  const outD = act();
  const wasPlaying = !outD.el.paused;
  const sameDeck = !play || !wasPlaying;      // only use the spare deck when overlapping or handing off
  const inD = sameDeck ? outD : idle();

  const commit = () => {
    if (pendingQueue) { S.queue = pendingQueue; pendingQueue = null; }
    S.idx = idx;
  };

  const ok = await prepare(inD, id);
  if (token !== switchToken) return;
  if (!ok) {
    transitioning = false;
    emit('error', `“${t.title}” is missing from storage.`);
    if (play && S.queue.length > 1 && ++failStreak <= S.queue.length) { commit(); return next(true); }
    return;
  }
  failStreak = 0;
  await place(inD, t, startAt);
  if (token !== switchToken) return;
  setDeckLevel(inD, t);

  const useFade = !sameDeck && fade > 0 && engineActive() && ctx.state === 'running';
  if (nodes) {
    const now = ctx.currentTime;
    inD.fade.gain.cancelScheduledValues(now);
    outD.fade.gain.cancelScheduledValues(now);
    if (useFade) {
      inD.fade.gain.setValueAtTime(0, now);
      inD.fade.gain.setValueCurveAtTime(CURVE_IN, now, fade);
      outD.fade.gain.setValueCurveAtTime(CURVE_OUT, now, fade);
    } else {
      inD.fade.gain.setValueAtTime(1, now);
    }
  }

  if (!play) {
    commit();
    transitioning = false;
    emit('queue'); emit('track'); emit('state'); emit('time');
    updateSession(t);
    save();
    return;
  }

  const started = await playEl(inD.el);
  if (token !== switchToken) return;

  if (!started && !sameDeck) {
    // The spare deck was not allowed to start: take over on the deck that is already playing.
    const ok2 = await prepare(outD, id);
    if (token !== switchToken) return;
    if (!ok2) { transitioning = false; return; }
    await place(outD, t, startAt);
    setDeckLevel(outD, t);
    if (nodes) { const n = ctx.currentTime; outD.fade.gain.cancelScheduledValues(n); outD.fade.gain.setValueAtTime(1, n); }
    await playEl(outD.el);
    commit();
    transitioning = false;
    emit('queue'); emit('track'); emit('state'); emit('time');
    updateSession(t);
    save();
    return;
  }

  if (sameDeck) {
    commit();
    transitioning = false;
    emit('queue'); emit('track');
    updateSession(t);
    save();
    return;
  }

  // Hand over to the other deck
  ai = 1 - ai;
  audio = inD.el;
  commit();
  emit('queue'); emit('track'); emit('state'); emit('time');
  updateSession(t);
  setPlayback('playing');
  save();

  const finish = () => {
    outD.el.pause();
    if (nodes) { outD.fade.gain.cancelScheduledValues(0); outD.fade.gain.value = 1; }
    if (token === switchToken) transitioning = false;
  };
  if (useFade) setTimeout(finish, fade * 1000 + 80); else finish();
}

function resetPlayer() {
  switchToken++;
  transitioning = false;
  pendingQueue = null;
  decks.forEach((d) => {
    d.tok++;
    d.el.pause();
    d.el.removeAttribute('src');
    d.el.load();
    if (d.url) { URL.revokeObjectURL(d.url); d.url = null; }
    d.id = null;
  });
  S.idx = -1;
  if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
  emit('track'); emit('state'); emit('time'); emit('queue');
}

/* ---------- transport ---------- */
export function toggle() {
  if (!current()) return;
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

export function seek(sec) {
  if (!isFinite(sec)) return;
  audio.currentTime = Math.max(0, Math.min(sec, audio.duration || sec));
  updatePosition();
}

// Index of the song that follows the current one, or null at the end of the queue
function targetNext() {
  if (!S.queue.length) return null;
  if (S.idx + 1 < S.queue.length) return S.idx + 1;
  if (S.repeat === 'all') {
    if (S.shuffle) {
      const cur = S.queue[S.idx];
      const ids = shuffleArr(S.list.slice());
      if (ids.length > 1 && ids[0] === cur) [ids[0], ids[1]] = [ids[1], ids[0]];
      pendingQueue = ids;     // applied once the next song is actually playing
    }
    return 0;
  }
  return null;
}
// Same, without side effects (used for preloading)
function peekNext() {
  if (!S.queue.length) return null;
  if (S.idx + 1 < S.queue.length) return S.queue[S.idx + 1];
  if (S.repeat === 'all' && !S.shuffle) return S.queue[0];
  return null;
}

export async function next(auto = false) {
  if (!S.queue.length) return;
  if (auto && S.repeat === 'one') {
    audio.currentTime = startOf(current());
    audio.play().catch(() => {});
    return;
  }
  const ni = targetNext();
  if (ni == null) {
    if (auto) { audio.pause(); audio.currentTime = startOf(current()); }
    return;
  }
  await switchTo(ni, { play: true });
}

export async function prev() {
  if (!S.queue.length) return;
  if (audio.currentTime > startOf(current()) + 3) { audio.currentTime = startOf(current()); return; }
  if (S.idx > 0) return switchTo(S.idx - 1, { play: true });
  if (S.repeat === 'all') return switchTo(S.queue.length - 1, { play: true });
  audio.currentTime = startOf(current());
}

export function setVolume(v) {
  decks.forEach((d) => { d.el.volume = v; });
  save();
}

/* ---------- gapless / crossfade scheduler ---------- */
function preloadNext() {
  if (transitioning) return;
  const id = peekNext();
  if (id == null) return;
  const d = idle();
  if (d.id === id && d.url) return;
  prepare(d, id).catch(() => {});
}

setInterval(() => {
  if (transitioning) return;
  const el = audio;
  if (el.paused || el.ended) return;
  const t = current();
  if (!t) return;
  const dur = el.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const end = endOf(t, dur);
  const rem = end - el.currentTime;
  if (rem < 25) preloadNext();

  if (S.repeat === 'one') {
    if (rem <= 0.06) el.currentTime = startOf(t);
    return;
  }
  const fadeSec = engineActive() && ctx.state === 'running' ? cfg.crossfade : 0;
  if (rem > Math.max(fadeSec, 0.06)) return;

  const ni = targetNext();
  if (ni == null) {
    if (end < dur - 0.1) { el.pause(); el.currentTime = startOf(t); }   // trimmed end of the last song
    return;
  }
  switchTo(ni, { play: true, fade: fadeSec });
}, 80);

/* ---------- library changes ---------- */
export async function removeTrack(id) {
  const cur = current();
  const wasCurrent = !!cur && cur.id === id;
  const wasPlaying = !audio.paused;
  const qi = S.queue.indexOf(id);
  S.list = S.list.filter((i) => i !== id);
  S.queue = S.queue.filter((i) => i !== id);
  S.map.delete(id);
  dropCover(id);
  if (qi !== -1 && qi < S.idx) S.idx--;
  decks.forEach((d) => {
    if (d.id === id && d.el !== audio) {
      d.id = null;
      if (d.url) { URL.revokeObjectURL(d.url); d.url = null; }
      d.el.removeAttribute('src');
    }
  });
  if (wasCurrent) {
    if (!S.queue.length) return resetPlayer();
    if (S.idx >= S.queue.length) S.idx = 0;
    await switchTo(S.idx, { play: wasPlaying });
  }
  emit('queue');
}

export function clearAll() {
  covers.forEach((u) => URL.revokeObjectURL(u));
  covers.clear();
  S.map.clear(); S.list = []; S.queue = [];
  resetPlayer();
  try { localStorage.removeItem('afrobox.state'); } catch {}
}

/* ---------- MediaSession ---------- */
const setPlayback = (state) => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state; };

function updateSession(t) {
  if (!('mediaSession' in navigator)) return;
  const art = coverURL(t) || new URL('icons/icon-512-v5.png', document.baseURI).href;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist || 'Unknown artist',
    album: t.album || 'Pulse Media Player',
    artwork: [{ src: art, sizes: '512x512', type: t.cover ? t.cover.type : 'image/png' }],
  });
}

let lastPos = 0;
function updatePosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, d),
    });
  } catch { /* ignore */ }
}

function initSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ } };
  set('play', () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); audio.play().catch(() => {}); });
  set('pause', () => audio.pause());
  set('previoustrack', () => prev());
  set('nexttrack', () => next(false));
  set('seekto', (d) => seek(d.seekTime));
  set('seekbackward', (d) => seek(audio.currentTime - (d.seekOffset || 10)));
  set('seekforward', (d) => seek(audio.currentTime + (d.seekOffset || 10)));
  set('stop', () => { audio.pause(); audio.currentTime = 0; });
}

/* ---------- audio events (only the audible deck reports) ---------- */
decks.forEach((d) => {
  const el = d.el;
  const onEl = (ev, fn) => el.addEventListener(ev, (e) => { if (el === audio) fn(e); });
  onEl('play', () => { setPlayback('playing'); emit('state'); updatePosition(); });
  onEl('pause', () => { setPlayback('paused'); emit('state'); updatePosition(); save(); });
  onEl('timeupdate', () => {
    emit('time');
    const now = Date.now();
    if (now - lastPos > 1000) { lastPos = now; updatePosition(); }
  });
  onEl('durationchange', () => { emit('time'); updatePosition(); });
  onEl('loadedmetadata', () => { emit('time'); updatePosition(); });
  onEl('seeked', updatePosition);
  onEl('ended', () => {
    if (S.repeat === 'one') { el.currentTime = startOf(current()); el.play().catch(() => {}); }
    else next(true);
  });
  onEl('error', () => {
    const t = current();
    if (!t || !el.getAttribute('src')) return;
    emit('error', `Couldn’t play “${t.title}”.`);
    if (S.queue.length > 1) next(true);
  });
});

/* ---------- persistence ---------- */
function save() {
  try {
    const t = current();
    localStorage.setItem('afrobox.state', JSON.stringify({
      id: t ? t.id : null,
      pos: audio.currentTime || 0,
      vol: audio.volume,
      shuffle: S.shuffle,
      repeat: S.repeat,
      list: S.list,
    }));
  } catch { /* ignore */ }
}
setInterval(() => { if (!audio.paused) save(); }, 3000);
window.addEventListener('pagehide', save);

export async function restore(resume = true) {
  initSession();
  let st = null;
  try { st = JSON.parse(localStorage.getItem('afrobox.state') || 'null'); } catch { /* ignore */ }
  if (!st) return;
  if (volumeSupported && typeof st.vol === 'number') decks.forEach((d) => { d.el.volume = st.vol; });
  if (!resume) { emit('queue'); return; }
  S.shuffle = !!st.shuffle;
  S.repeat = ['off', 'all', 'one'].includes(st.repeat) ? st.repeat : 'off';
  if (st.id != null && S.map.has(st.id)) {
    S.list = (st.list || []).filter((i) => S.map.has(i));
    if (!S.list.includes(st.id)) S.list = [...S.map.keys()];
    buildQueue(st.id);
    await switchTo(S.idx, { play: false, startAt: st.pos || 0 });
  }
  emit('queue');
}
