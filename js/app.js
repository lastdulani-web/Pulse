import * as db from './db.js';
import { readMeta, readLrcFile } from './meta.js';
import { analyseBlob } from './analyse.js';
import { createViz, extractColors, DEFAULT_COLORS } from './viz.js';
import { initSync } from './sync.js';
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
const DEFAULTS = {
  bgBlur: true, sort: 'title', resume: true, shuffleDefault: false, repeatDefault: 'off',
  engine: true, crossfade: 0, trim: false, trimSense: 'normal', level: 'off',
  vizStyle: 'bars', vizColors: true, lyrSize: 'm', syncLag: '0.2',
};
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('pulse.settings') || '{}')); } catch {}
if (!['title', 'artist', 'album', 'added'].includes(settings.sort)) settings.sort = 'title';
if (!['off', 'all', 'one'].includes(settings.repeatDefault)) settings.repeatDefault = 'off';
if (!['gentle', 'normal', 'aggressive'].includes(settings.trimSense)) settings.trimSense = 'normal';
if (!['off', 'light', 'normal', 'strong'].includes(settings.level)) settings.level = 'off';
if (!['bars', 'wave', 'circle'].includes(settings.vizStyle)) settings.vizStyle = 'bars';
if (!['s', 'm', 'l'].includes(settings.lyrSize)) settings.lyrSize = 'm';
if (!['0', '0.1', '0.2', '0.3'].includes(String(settings.syncLag))) settings.syncLag = '0.2';
settings.syncLag = String(settings.syncLag);
settings.crossfade = Math.max(0, Math.min(12, Math.round(Number(settings.crossfade) || 0)));
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

const baseName = (n) => n.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function safeAnalyse(blob, duration) {
  try {
    const r = await analyseBlob(blob, duration);
    return r && !r.skipped ? r : { failed: true };
  } catch { return { failed: true }; }
}

async function importFiles(files) {
  const audioFiles = files.filter(isAudio);
  const lrcFiles = files.filter((f) => ext(f.name) === 'lrc');
  if (!audioFiles.length && !lrcFiles.length) { toast('No supported files found. Use MP3, FLAC, WAV, M4A or .lrc.'); return; }
  const lrcMap = new Map(lrcFiles.map((f) => [baseName(f.name), f]));
  const usedLrc = new Set();
  const have = new Set(tracks.map((t) => `${t.fileName}|${t.size}`));
  const wantAnalysis = settings.trim || settings.level !== 'off';
  let added = 0, skipped = 0, failed = 0, withLyrics = 0;
  for (let i = 0; i < audioFiles.length; i++) {
    const f = audioFiles[i];
    toast(`Importing ${i + 1} of ${audioFiles.length}…`, 0);
    if (have.has(`${f.name}|${f.size}`)) { skipped++; continue; }
    try {
      const e = ext(f.name);
      const blob = f.slice(0, f.size, f.type || MIME[e]);
      const [meta, duration] = await Promise.all([readMeta(f), getDuration(blob)]);
      let lyrics = meta.lyrics;
      const lf = lrcMap.get(baseName(f.name));
      if (lf) {
        usedLrc.add(lf);
        try {
          const parsed = await readLrcFile(lf);
          if (parsed && (parsed.synced || !lyrics)) lyrics = parsed;   // synced beats plain
        } catch { /* ignore a bad .lrc */ }
      }
      if (lyrics) withLyrics++;
      let an;
      if (wantAnalysis) {
        toast(`Analysing ${i + 1} of ${audioFiles.length}…`, 0);
        an = await safeAnalyse(blob, duration);
      }
      await db.addTrack({
        title: meta.title, artist: meta.artist, album: meta.album, cover: meta.cover, lyrics,
        ...(an ? { an } : {}),
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

  // .lrc files that were not imported alongside their song: match against songs already in the library
  let attached = 0, unmatched = 0;
  for (const lf of lrcFiles) {
    if (usedLrc.has(lf)) continue;
    const tr = tracks.find((x) => baseName(x.fileName || '') === baseName(lf.name));
    if (!tr) { unmatched++; continue; }
    try {
      const parsed = await readLrcFile(lf);
      if (parsed) { tr.lyrics = parsed; await db.updateTrack(tr.id, { lyrics: parsed }); attached++; }
    } catch { unmatched++; }
  }
  if (attached) { lastTid = null; renderTrack(); }
  db.requestPersistence();
  updateAnalysisStatus();

  const parts = [];
  if (audioFiles.length) parts.push(`Added ${added} song${added === 1 ? '' : 's'}`);
  if (skipped) parts.push(`${skipped} already in library`);
  if (failed) parts.push(`${failed} failed (storage may be full)`);
  if (withLyrics + attached) parts.push(`${withLyrics + attached} with lyrics`);
  if (unmatched) parts.push(`${unmatched} .lrc without a matching song`);
  toast(parts.join(' · '), 5000);
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
  const tid = t ? t.id : null;
  if (tid !== lastTid) {                 // only when the song actually changes
    lastTid = tid;
    renderLyrics();
    updateColors(art);
    if (t && !t.an && (settings.trim || settings.level !== 'off')) queueAnalysis(t);
  }
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
  syncAdvancedUI();
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

/* ---------- Now Playing views: artwork, lyrics, visualiser ---------- */
let lastTid = null;
let stageMode = 'art';
try { const m = localStorage.getItem('pulse.stage'); if (['art', 'lyrics', 'viz'].includes(m)) stageMode = m; } catch {}
const viz = createViz($('#vizCanvas'));
let artColors = DEFAULT_COLORS;
let colorToken = 0;
const lyr = { lines: [], cur: -1, synced: false };
let userScrollUntil = 0;

const vizAvailable = () => settings.engine && P.engineSupported();

function applyVizOpts() {
  viz.set({ style: settings.vizStyle, colors: settings.vizColors ? artColors : DEFAULT_COLORS });
}
function applyLyrSize() {
  $('#stage').style.setProperty('--lyr', { s: '17px', m: '21px', l: '26px' }[settings.lyrSize]);
}
async function updateColors(url) {
  const tok = ++colorToken;
  const c = url ? await extractColors(url) : DEFAULT_COLORS;
  if (tok !== colorToken) return;
  artColors = c;
  document.documentElement.style.setProperty('--art-c1', c[0]);
  applyVizOpts();
}

// The switcher fades away while reading lyrics or watching the visualiser; a tap on the card brings it back.
let tabsTimer = null;
function wakeTabs() {
  const st = $('#stage');
  st.classList.remove('idle');
  clearTimeout(tabsTimer);
  if (stageMode !== 'art') tabsTimer = setTimeout(() => st.classList.add('idle'), 3500);
}
$('#stage').addEventListener('pointerdown', wakeTabs, { capture: true, passive: true });
$('#stage').addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wakeTabs(); }, { passive: true });

function setStage(mode, { persist = true, boot = false } = {}) {
  stageMode = mode;
  if (persist) { try { localStorage.setItem('pulse.stage', mode); } catch {} }
  $('#paneLyr').hidden = mode !== 'lyrics';
  $('#paneViz').hidden = mode !== 'viz';
  $$('#stageTabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  P.setVizWanted(mode === 'viz');
  if (mode === 'viz') {
    if (!boot) P.requestEngine();          // a tap is needed before audio can be analysed
    $('#vizMsg').hidden = vizAvailable();
    applyVizOpts();
    if (vizAvailable()) viz.start(); else viz.stop();
  } else {
    viz.stop();
  }
  if (mode === 'lyrics') updateLyricsCursor(true, true);
  wakeTabs();
}
$('#stageTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setStage(b.dataset.mode);
});
P.on('state', () => viz.wake());

/* lyrics */
function renderLyrics() {
  const t = P.current();
  const box = $('#lyrScroll');
  const L = t && t.lyrics;
  const empty = $('#lyrEmpty');
  box.innerHTML = '';
  box.classList.remove('plain');
  lyr.lines = []; lyr.cur = -1; lyr.synced = false;
  empty.hidden = true;
  $('#btnSync').hidden = !t;
  if (L && L.synced && L.synced.length) {
    lyr.synced = true;
    box.innerHTML = L.synced.map((l, i) => `<p class="ln" data-i="${i}">${esc(l.text) || '♪'}</p>`).join('');
    lyr.lines = [...box.children];
    updateLyricsCursor(true, true);
  } else if (L && L.plain) {
    box.classList.add('plain');
    box.innerHTML = `<p class="plain-text">${esc(L.plain)}</p>`;
    box.scrollTop = 0;
  } else {
    empty.hidden = false;
    empty.querySelector('p').textContent = t ? 'No lyrics for this song' : 'Nothing playing';
    empty.querySelector('.sub').textContent = t
      ? 'Import a matching .lrc file with your music, or add one now.'
      : 'Play a song to see its lyrics here.';
    $('#btnAddLrc').hidden = !t;
    $('#btnSyncEmpty').hidden = !t;
  }
}

function scrollToLine(i, instant) {
  const box = $('#lyrScroll');
  const el = lyr.lines[i];
  if (!el) return;
  if (!instant && Date.now() < userScrollUntil) return;      // the listener is scrolling by hand
  box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: instant ? 'auto' : 'smooth' });
}

function updateLyricsCursor(force, instant) {
  if (!lyr.synced) return;
  const t = P.current();
  const L = t && t.lyrics && t.lyrics.synced;
  if (!L) return;
  const now = P.audio.currentTime + 0.25;       // tiny look-ahead so the line lights up as it is sung
  let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].t <= now) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans === lyr.cur && !force) return;
  lyr.cur = ans;
  lyr.lines.forEach((el, i) => { el.classList.toggle('cur', i === ans); el.classList.toggle('past', i < ans); });
  if (ans >= 0 && stageMode === 'lyrics') scrollToLine(ans, instant);
}
P.on('time', () => { if (stageMode === 'lyrics') updateLyricsCursor(false); });

$('#lyrScroll').addEventListener('click', (e) => {
  const p = e.target.closest('.ln');
  const t = P.current();
  if (!p || !lyr.synced || !t) return;
  P.seek(t.lyrics.synced[+p.dataset.i].t);
  userScrollUntil = 0;
  updateLyricsCursor(true);
});
['wheel', 'touchstart', 'pointerdown'].forEach((ev) => $('#lyrScroll').addEventListener(ev, () => { userScrollUntil = Date.now() + 4000; }, { passive: true }));

$('#btnAddLrc').addEventListener('click', () => $('#lrcIn').click());
$('#lrcIn').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const t = P.current();
  if (!file || !t) return;
  try {
    const parsed = await readLrcFile(file);
    if (!parsed) { toast('That file has no lyrics in it.'); return; }
    t.lyrics = parsed;
    await db.updateTrack(t.id, { lyrics: parsed });
    renderLyrics();
    toast(parsed.synced ? 'Synced lyrics added' : 'Lyrics added');
  } catch { toast('Couldn’t read that file.'); }
});

/* ---------- sync lyrics (make an .lrc) ---------- */
const sync = initSync({
  $, P, db, toast, esc, ask,
  getLag: () => parseFloat(settings.syncLag) || 0,
  afterSave: () => { lastTid = null; renderTrack(); setStage('lyrics'); },
});
$('#btnSync').addEventListener('click', () => sync.open());
$('#btnSyncEmpty').addEventListener('click', () => sync.open());

/* ---------- song analysis (silence trimming + volume leveller) ---------- */
let analysisChain = Promise.resolve();
let scanning = false;

function queueAnalysis(t) {
  if (!t || t.an || t._queued) return analysisChain;
  t._queued = true;
  analysisChain = analysisChain.then(async () => {
    try {
      const blob = await db.getFile(t.id);
      if (!blob) return;
      t.an = await safeAnalyse(blob, t.duration);
      await db.updateTrack(t.id, { an: t.an });
      P.reapply();
      updateAnalysisStatus();
    } finally { t._queued = false; }
  });
  return analysisChain;
}

function updateAnalysisStatus() {
  const done = tracks.filter((t) => t.an).length;
  $('#anStatus').textContent = tracks.length
    ? `${done} of ${tracks.length} songs analysed. Used by silence trimming and the leveller.`
    : 'No songs yet';
  $('#btnScan').disabled = scanning || done === tracks.length;
}

async function scanLibrary() {
  const todo = tracks.filter((t) => !t.an);
  if (scanning || !todo.length) { if (!todo.length) toast('All songs are analysed'); return; }
  scanning = true;
  updateAnalysisStatus();
  for (let i = 0; i < todo.length; i++) {
    toast(`Analysing ${i + 1} of ${todo.length}…`, 0);
    await queueAnalysis(todo[i]);
    await new Promise((r) => setTimeout(r, 30));
  }
  scanning = false;
  updateAnalysisStatus();
  toast(`Analysed ${todo.length} song${todo.length === 1 ? '' : 's'}`, 3500);
}
$('#btnScan').addEventListener('click', scanLibrary);

function analyseCurrentIfNeeded() {
  const t = P.current();
  if (t && !t.an && (settings.trim || settings.level !== 'off')) queueAnalysis(t);
}

/* ---------- audio settings ---------- */
function applyAudioConfig(gesture) {
  P.configure({ engine: settings.engine, crossfade: settings.crossfade, trim: settings.trim, trimSense: settings.trimSense, level: settings.level });
  if (gesture && settings.engine && (settings.crossfade > 0 || settings.level !== 'off' || stageMode === 'viz')) P.requestEngine();
  syncAdvancedUI();
}

const segOn = (sel, val) => $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.val === String(val)));

function syncAdvancedUI() {
  $('#setTrim').checked = settings.trim;
  $('#setEngine').checked = settings.engine;
  $('#setVizColors').checked = settings.vizColors;
  segOn('#setTrimSense', settings.trimSense);
  segOn('#setLevel', settings.level);
  segOn('#setVizStyle', settings.vizStyle);
  segOn('#setLyrSize', settings.lyrSize);
  segOn('#setSyncLag', settings.syncLag);
  const cross = $('#setCross');
  cross.value = settings.crossfade;
  setFill(cross);
  $('#crossVal').textContent = settings.crossfade ? `${settings.crossfade} s` : 'Off';
  const eng = vizAvailable();
  $('#rowCross').classList.toggle('dim', !eng);
  $('#rowLevel').classList.toggle('dim', !eng);
  $('#rowTrimSense').classList.toggle('dim', !settings.trim);
  $('#engSub').textContent = !P.engineSupported()
    ? 'Not supported by this browser'
    : settings.engine
      ? 'Powers crossfade, the leveller and the visualiser'
      : 'Off. Crossfade, the leveller and the visualiser are unavailable. Restart the app after switching this off.';
  $('#vizMsg').hidden = eng;
  updateAnalysisStatus();
}

function bindSeg(sel, key, after) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings[key] = b.dataset.val;
    saveSettings();
    segOn(sel, settings[key]);
    if (after) after();
  });
}
function bindSwitch(sel, key, after) {
  $(sel).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    saveSettings();
    if (after) after();
  });
}
bindSwitch('#setEngine', 'engine', () => { applyAudioConfig(true); if (stageMode === 'viz') setStage('viz', { persist: false }); });
bindSwitch('#setTrim', 'trim', () => { applyAudioConfig(false); analyseCurrentIfNeeded(); });
bindSeg('#setTrimSense', 'trimSense', () => applyAudioConfig(false));
bindSeg('#setLevel', 'level', () => { applyAudioConfig(true); analyseCurrentIfNeeded(); });
bindSeg('#setVizStyle', 'vizStyle', applyVizOpts);
bindSwitch('#setVizColors', 'vizColors', applyVizOpts);
bindSeg('#setLyrSize', 'lyrSize', applyLyrSize);
bindSeg('#setSyncLag', 'syncLag');
$('#setCross').addEventListener('input', (e) => {
  settings.crossfade = +e.target.value;
  saveSettings();
  setFill(e.target);
  $('#crossVal').textContent = settings.crossfade ? `${settings.crossfade} s` : 'Off';
  applyAudioConfig(true);
});

// Phones need one tap before sound can be set up. The first tap anywhere does it.
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => P.unlock(), { once: true, capture: true }));

/* ---------- iPhone home-screen viewport gap ---------- */
// On some iPhones an installed web app is laid out about 47px short of the real screen height,
// leaving an unpainted strip under the bottom bar. Measure it, then let the CSS paint into it.
function updateViewportGap() {
  let gap = 0;
  if (navigator.standalone === true && window.innerHeight > window.innerWidth) {
    const expected = Math.max(screen.width, screen.height);
    gap = expected - window.innerHeight;
    if (!(gap > 8 && gap <= 90)) gap = 0;
  }
  document.documentElement.style.setProperty('--vgap', `${gap}px`);
  document.documentElement.classList.toggle('vgap', gap > 0);
}
updateViewportGap();
window.addEventListener('resize', updateViewportGap);
window.addEventListener('orientationchange', () => setTimeout(updateViewportGap, 300));

/* ---------- boot ---------- */
setTimeout(() => {
  const s = $('#splash');
  s.classList.add('hide');
  setTimeout(() => s.remove(), 600);
}, 2000);

(async function boot() {
  try {
    applyLyrSize();
    applyAudioConfig(false);
    await refreshLibrary();
    await P.restore(settings.resume);
    applyLaunchDefaults();
  } catch (err) {
    console.error(err);
    toast('Storage isn’t available in this browser mode.', 5000);
  }
  renderTrack(); renderState(); renderQueueState();
  setStage(stageMode, { persist: false, boot: true });
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.error));
}
