// Pulse playback engine: one <audio> element, a queue, shuffle/repeat,
// MediaSession (lock screen / notification controls) and resume-where-you-left-off.
import * as db from './db.js';

export const audio = new Audio();
audio.preload = 'auto';
audio.setAttribute('playsinline', '');

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
  await loadCurrent(true);
}

export async function jumpTo(queueIndex) {
  S.idx = queueIndex;
  emit('queue');
  await loadCurrent(true);
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

/* ---------- loading ---------- */
let objectUrl = null;
let loadToken = 0;
let pendingSeek = 0;

async function loadCurrent(play) {
  const t = current();
  if (!t) return resetPlayer();
  const token = ++loadToken;
  const blob = await db.getFile(t.id);
  if (token !== loadToken) return;
  if (!blob) {
    emit('error', `“${t.title}” is missing from storage.`);
    return next(true);
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  audio.src = objectUrl;
  emit('track');
  updateSession(t);
  save();
  if (play) {
    try { await audio.play(); } catch (e) { /* needs a tap on some browsers */ }
  }
}

function resetPlayer() {
  loadToken++;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  S.idx = -1;
  if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
  emit('track'); emit('state'); emit('time'); emit('queue');
}

/* ---------- transport ---------- */
export function toggle() {
  if (!current()) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

export function seek(sec) {
  if (!isFinite(sec)) return;
  audio.currentTime = Math.max(0, Math.min(sec, audio.duration || sec));
  updatePosition();
}

export async function next(auto = false) {
  if (!S.queue.length) return;
  if (auto && S.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (S.idx + 1 < S.queue.length) { S.idx++; emit('queue'); return loadCurrent(true); }
  if (S.repeat === 'all') {
    if (S.shuffle) buildQueue(null);
    S.idx = 0; emit('queue'); return loadCurrent(true);
  }
  if (auto) { audio.pause(); audio.currentTime = 0; }
}

export async function prev() {
  if (!S.queue.length) return;
  if (audio.currentTime > 3 || S.idx === 0) {
    if (S.idx === 0 && S.repeat === 'all' && audio.currentTime <= 3) { S.idx = S.queue.length - 1; emit('queue'); return loadCurrent(true); }
    audio.currentTime = 0; return;
  }
  S.idx--; emit('queue'); return loadCurrent(true);
}

export function setVolume(v) {
  audio.volume = v;
  save();
}

/* ---------- library changes ---------- */
export async function removeTrack(id) {
  const wasCurrent = current() && current().id === id;
  const wasPlaying = !audio.paused;
  const qi = S.queue.indexOf(id);
  S.list = S.list.filter((i) => i !== id);
  S.queue = S.queue.filter((i) => i !== id);
  S.map.delete(id);
  dropCover(id);
  if (qi !== -1 && qi < S.idx) S.idx--;
  if (wasCurrent) {
    if (!S.queue.length) return resetPlayer();
    if (S.idx >= S.queue.length) S.idx = 0;
    await loadCurrent(wasPlaying);
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
  } catch {}
}

function initSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', () => prev());
  set('nexttrack', () => next(false));
  set('seekto', (d) => seek(d.seekTime));
  set('seekbackward', (d) => seek(audio.currentTime - (d.seekOffset || 10)));
  set('seekforward', (d) => seek(audio.currentTime + (d.seekOffset || 10)));
  set('stop', () => { audio.pause(); audio.currentTime = 0; });
}

/* ---------- audio events ---------- */
audio.addEventListener('play', () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; emit('state'); updatePosition(); });
audio.addEventListener('pause', () => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; emit('state'); updatePosition(); save(); });
audio.addEventListener('timeupdate', () => {
  emit('time');
  const now = Date.now();
  if (now - lastPos > 1000) { lastPos = now; updatePosition(); }
});
audio.addEventListener('durationchange', () => { emit('time'); updatePosition(); });
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek) { audio.currentTime = pendingSeek; pendingSeek = 0; }
  emit('time'); updatePosition();
});
audio.addEventListener('seeked', updatePosition);
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => {
  const t = current();
  if (!t || !audio.src) return;
  emit('error', `Couldn’t play “${t.title}”.`);
  if (S.queue.length > 1) next(true);
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
  } catch {}
}
setInterval(() => { if (!audio.paused) save(); }, 3000);
window.addEventListener('pagehide', save);

export async function restore(resume = true) {
  initSession();
  let st = null;
  try { st = JSON.parse(localStorage.getItem('afrobox.state') || 'null'); } catch {}
  if (!st) return;
  if (volumeSupported && typeof st.vol === 'number') audio.volume = st.vol;
  if (!resume) { emit('queue'); return; }
  S.shuffle = !!st.shuffle;
  S.repeat = ['off', 'all', 'one'].includes(st.repeat) ? st.repeat : 'off';
  if (st.id != null && S.map.has(st.id)) {
    S.list = (st.list || []).filter((i) => S.map.has(i));
    if (!S.list.includes(st.id)) S.list = [...S.map.keys()];
    buildQueue(st.id);
    pendingSeek = st.pos || 0;
    await loadCurrent(false);
  }
  emit('queue');
}
