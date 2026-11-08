import * as db from './db.js';
import { readMeta } from './meta.js';
import * as P from './player.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const AUDIO_EXT = ['mp3', 'flac', 'wav', 'm4a'];
const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', m4a: 'audio/mp4' };
const PLACEHOLDER = 'assets/art-tile-v5.png';

let tracks = [];
let query = '';
let dragging = false;

/* ---------- settings (saved on this device) ---------- */
const DEFAULTS = { bgBlur: true, sort: 'title', resume: true, shuffleDefault: false, repeatDefault: 'off' };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('pulse.settings') || '{}')); } catch {}
if (!['title', 'artist', 'album', 'added'].includes(settings.sort)) settings.sort = 'title';
if (!['off', 'all', 'one'].includes(settings.repeatDefault)) settings.repeatDefault = 'off';
const saveSettings = () => { try { localStorage.setItem('pulse.settings', JSON.stringify(settings)); } catch {} };

const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
const byField = (f) => (a, b) => {
  const x = f(a), y = f(b);
  if (!x && y) return 1;       // blanks go last
  if (x && !y) return -1;
  return cmp(x, y) || cmp(a.title, b.title);
};
function sortTracks(arr) {
  const k = settings.sort;
  arr.sort(k === 'added' ? (a, b) => b.addedAt - a.addedAt
    : k === 'artist' ? byField((t) => t.artist)
    : k === 'album' ? byField((t) => t.album)
    : (a, b) => cmp(a.title, b.title));
}

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ext = (name) => (name.split('.').pop() || '').toLowerCase();
const isAudio = (f) => AUDIO_EXT.includes(ext(f.name));
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
function fmtBytes(n) {
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
const setFill = (el) => el.style.setProperty('--p', `${(el.value - el.min) / (el.max - el.min) * 100}%`);

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function ask(title, text, okLabel = 'Delete') {
  const dlg = $('#confirm');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  dlg.returnValue = 'cancel';
  dlg.showModal();
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
}

/* ---------- tabs ---------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
$('#miniMain').addEventListener('click', () => showView('now'));

/* ---------- library ---------- */
async function refreshLibrary() {
  tracks = await db.getAllTracks();
  sortTracks(tracks);
  P.setCatalog(tracks);
  renderLibrary();
}

function visibleTracks() {
  const q = query.trim().toLowerCase();
  if (!q) return tracks;
  return tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
}

function thumbHTML(t) {
  const url = P.coverURL(t);
  return url ? `<img src="${url}" alt="" loading="lazy">` : '<svg class="ic"><use href="#i-note"/></svg>';
}

function renderLibrary() {
  const shown = visibleTracks();
  const total = tracks.reduce((n, t) => n + (t.size || 0), 0);
  $('#libStats').textContent = tracks.length ? `${tracks.length} song${tracks.length === 1 ? '' : 's'} · ${fmtBytes(total)}` : '0 songs';
  $('#empty').hidden = tracks.length > 0;
  $('#clearRow').hidden = tracks.length === 0;
  $('#list').innerHTML = shown.map((t) => `
    <li class="row" data-id="${t.id}">
      <button class="row-main">
        <span class="thumb">${thumbHTML(t)}</span>
        <span class="meta"><b>${esc(t.title)}</b><i>${esc(t.artist || 'Unknown artist')}</i></span>
        <span class="eq" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="tail"><span class="dur">${fmtTime(t.duration)}</span><span class="fmt">${esc(t.format)}</span></span>
      </button>
      <button class="row-del" aria-label="Delete ${esc(t.title)}"><svg class="ic sm"><use href="#i-trash"/></svg></button>
    </li>`).join('');
  if (tracks.length && !shown.length) $('#list').innerHTML = '<li class="empty"><p>No songs match your search.</p></li>';
  markRows();
}

function markRows() {
  const cur = P.current();
  $$('#list .row').forEach((r) => {
    const isCur = !!cur && +r.dataset.id === cur.id;
    r.classList.toggle('current', isCur);
    r.classList.toggle('playing', isCur && !P.audio.paused);
  });
}

$('#list').addEventListener('click', async (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const id = +row.dataset.id;
  if (e.target.closest('.row-del')) {
    const t = tracks.find((x) => x.id === id);
    if (await ask('Delete this song?', `“${t.title}” will be removed from Pulse. The original file on your device isn’t touched.`)) {
      await db.deleteTrack(id);
      await P.removeTrack(id);
      await refreshLibrary();
      toast('Song deleted');
    }
  } else if (e.target.closest('.row-main')) {
    const cur = P.current();
    if (cur && cur.id === id) { P.toggle(); return; }
    P.playList(visibleTracks().map((t) => t.id), id);
  }
});

$('#search').addEventListener('input', (e) => { query = e.target.value; renderLibrary(); });

$('#btnClear').addEventListener('click', async () => {
  if (await ask('Clear your library?', `All ${tracks.length} songs will be removed from Pulse. Your original files aren’t touched.`, 'Clear library')) {
    await db.clearAll();
    P.clearAll();
    await refreshLibrary();
    updateStorage();
    toast('Library cleared');
  }
});

/* ---------- import ---------- */
$('#btnImportFiles').addEventListener('click', () => $('#fileIn').click());
$('#btnImportFolder').addEventListener('click', () => $('#dirIn').click());
$('#fileIn').addEventListener('change', (e) => importFiles([...e.target.files]).finally(() => { e.target.value = ''; }));
$('#dirIn').addEventListener('change', (e) => importFiles([...e.target.files]).finally(() => { e.target.value = ''; }));

function getDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (d) => { clearTimeout(timer); URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(isFinite(d) ? d : 0); };
    const timer = setTimeout(() => done(0), 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

async function importFiles(files) {
  files = files.filter(isAudio);
  if (!files.length) { toast('No supported audio found. Use MP3, FLAC, WAV or M4A.'); return; }
  const have = new Set(tracks.map((t) => `${t.fileName}|${t.size}`));
  let added = 0, skipped = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    toast(`Importing ${i + 1} of ${files.length}…`, 0);
    if (have.has(`${f.name}|${f.size}`)) { skipped++; continue; }
    try {
      const e = ext(f.name);
      const blob = f.slice(0, f.size, f.type || MIME[e]);
      const [meta, duration] = await Promise.all([readMeta(f), getDuration(blob)]);
      await db.addTrack({
        title: meta.title, artist: meta.artist, album: meta.album, cover: meta.cover,
        duration, format: e.toUpperCase(), size: f.size, fileName: f.name, addedAt: Date.now(),
      }, blob);
      have.add(`${f.name}|${f.size}`);
      added++;
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  await refreshLibrary();
  db.requestPersistence();
  const parts = [`Added ${added} song${added === 1 ? '' : 's'}`];
  if (skipped) parts.push(`${skipped} already in library`);
  if (failed) parts.push(`${failed} failed (storage may be full)`);
  toast(parts.join(' · '), 4200);
}

/* ---------- now playing ---------- */
const seekEl = $('#seek'), volEl = $('#vol');

function renderTrack() {
  const t = P.current();
  const art = t ? P.coverURL(t) : null;
  $('#npTitle').textContent = t ? t.title : 'Nothing playing';
  $('#npArtist').textContent = t ? (t.artist || 'Unknown artist') : 'Import songs to get started';
  const img = $('#artImg');
  img.src = art || PLACEHOLDER;
  img.classList.toggle('ph', !art);
  img.alt = art ? `Cover art for ${t.title}` : 'Pulse';
  const bg = $('#bgart');
  bg.style.backgroundImage = art ? `url("${art}")` : '';
  bg.classList.toggle('on', !!art && settings.bgBlur);
  $('#mini').hidden = !t;
  $('#miniTitle').textContent = t ? t.title : '';
  $('#miniArtist').textContent = t ? (t.artist || 'Unknown artist') : '';
  $('#miniArt').src = art || PLACEHOLDER;
  seekEl.disabled = !t;
  document.title = t ? `${t.title} · Pulse` : 'Pulse';
  renderTime();
  markRows();
}

function renderTime() {
  const t = P.current();
  const dur = isFinite(P.audio.duration) && P.audio.duration > 0 ? P.audio.duration : (t ? t.duration : 0);
  $('#tDur').textContent = fmtTime(dur);
  if (dragging) return;
  const cur = t ? P.audio.currentTime : 0;
  $('#tCur').textContent = fmtTime(cur);
  seekEl.value = dur ? Math.round(cur / dur * 1000) : 0;
  setFill(seekEl);
}

function renderState() {
  const playing = !P.audio.paused;
  $$('.js-play').forEach((b) => {
    b.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
  markRows();
}

function renderQueueState() {
  $('#btnShuffle').classList.toggle('on', P.S.shuffle);
  $('#btnShuffle').setAttribute('aria-pressed', P.S.shuffle);
  const rep = $('#btnRepeat');
  rep.classList.toggle('on', P.S.repeat !== 'off');
  rep.querySelector('use').setAttribute('href', P.S.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  rep.setAttribute('aria-label', `Repeat: ${P.S.repeat}`);
}

P.on('track', renderTrack);
P.on('time', renderTime);
P.on('state', renderState);
P.on('queue', renderQueueState);
P.on('error', (m) => toast(m, 3600));

$('#btnPlay').addEventListener('click', P.toggle);
$('#miniPlay').addEventListener('click', P.toggle);
$('#btnNext').addEventListener('click', () => P.next(false));
$('#miniNext').addEventListener('click', () => P.next(false));
$('#btnPrev').addEventListener('click', () => P.prev());
$('#btnShuffle').addEventListener('click', () => P.setShuffle(!P.S.shuffle));
$('#btnRepeat').addEventListener('click', P.cycleRepeat);

['pointerdown', 'touchstart'].forEach((ev) => seekEl.addEventListener(ev, () => { dragging = true; }, { passive: true }));
seekEl.addEventListener('input', () => {
  setFill(seekEl);
  const dur = P.audio.duration;
  if (isFinite(dur)) {
    const sec = seekEl.value / 1000 * dur;
    $('#tCur').textContent = fmtTime(sec);
    P.seek(sec);
  }
});
['change', 'pointerup', 'touchend', 'pointercancel'].forEach((ev) => seekEl.addEventListener(ev, () => { dragging = false; }));

if (P.volumeSupported) {
  volEl.value = Math.round(P.audio.volume * 100);
  setFill(volEl);
  volEl.addEventListener('input', () => { setFill(volEl); P.setVolume(volEl.value / 100); });
} else {
  $('#volRow').hidden = true;
  $('#volNote').hidden = false;
}

/* close the confirm dialog when the backdrop is clicked */
['confirm', 'settingsSheet', 'aboutSheet'].forEach((id) => $(`#${id}`).addEventListener('click', (e) => { if (e.target.id === id) e.target.close(); }));

/* desktop keyboard: space = play/pause */
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); P.toggle(); }
});

/* ---------- settings + about sheets ---------- */
let sleepTimer = null, sleepAt = 0, sleepMin = 0;

function syncSleep() {
  $('#setSleep').value = String(sleepMin);
  $('#sleepSub').textContent = sleepAt
    ? `Playback stops at ${new Date(sleepAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'Off';
}
function endSleep(announce) {
  clearTimeout(sleepTimer); sleepTimer = null; sleepAt = 0; sleepMin = 0;
  if (announce) { P.audio.pause(); toast('Sleep timer: playback stopped', 4000); }
  syncSleep();
}
function startSleep(min) {
  endSleep(false);
  if (!min) return;
  sleepMin = min;
  sleepAt = Date.now() + min * 60000;
  sleepTimer = setTimeout(() => endSleep(true), min * 60000);
  syncSleep();
}
// Backup check while audio is playing (timers can be slowed down in the background)
P.on('time', () => { if (sleepAt && Date.now() >= sleepAt) endSleep(true); });

function syncSettingsUI() {
  $('#setBlur').checked = settings.bgBlur;
  $('#setResume').checked = settings.resume;
  $('#setShuffle').checked = settings.shuffleDefault;
  $('#setSort').value = settings.sort;
  $$('#setRepeat button').forEach((b) => b.classList.toggle('on', b.dataset.val === settings.repeatDefault));
  syncSleep();
}

async function updateStorage() {
  const total = tracks.reduce((n, t) => n + (t.size || 0), 0);
  const base = `${tracks.length} song${tracks.length === 1 ? '' : 's'} · ${fmtBytes(total)}`;
  $('#setStorage').textContent = base;
  try {
    const e = await navigator.storage?.estimate?.();
    if (e && e.quota) $('#setStorage').textContent = `${base} · about ${fmtBytes(Math.max(0, e.quota - e.usage))} free`;
  } catch {}
}

$('#btnSettings').addEventListener('click', () => { syncSettingsUI(); updateStorage(); $('#settingsSheet').showModal(); });
$('#btnAbout').addEventListener('click', () => $('#aboutSheet').showModal());
$('#settingsClose').addEventListener('click', () => $('#settingsSheet').close());
$('#aboutClose').addEventListener('click', () => $('#aboutSheet').close());

$('#setBlur').addEventListener('change', (e) => { settings.bgBlur = e.target.checked; saveSettings(); renderTrack(); });
$('#setResume').addEventListener('change', (e) => { settings.resume = e.target.checked; saveSettings(); });
$('#setShuffle').addEventListener('change', (e) => { settings.shuffleDefault = e.target.checked; saveSettings(); });
$('#setSort').addEventListener('change', (e) => { settings.sort = e.target.value; saveSettings(); sortTracks(tracks); renderLibrary(); });
$('#setRepeat').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  settings.repeatDefault = b.dataset.val; saveSettings(); syncSettingsUI();
});
$('#setSleep').addEventListener('change', (e) => startSleep(+e.target.value));

function applyLaunchDefaults() {
  if (P.S.shuffle !== settings.shuffleDefault) P.setShuffle(settings.shuffleDefault);
  for (let i = 0; i < 3 && P.S.repeat !== settings.repeatDefault; i++) P.cycleRepeat();
}

/* ---------- boot ---------- */
setTimeout(() => {
  const s = $('#splash');
  s.classList.add('hide');
  setTimeout(() => s.remove(), 600);
}, 2000);

(async function boot() {
  try {
    await refreshLibrary();
    await P.restore(settings.resume);
    applyLaunchDefaults();
  } catch (err) {
    console.error(err);
    toast('Storage isn’t available in this browser mode.', 5000);
  }
  renderTrack(); renderState(); renderQueueState();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.error));
}
