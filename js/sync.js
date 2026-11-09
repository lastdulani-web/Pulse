// Lyrics sync tool: play a song, tap once per line, save or export a synced .lrc file.
import { formatLrc, readLrcFile } from './meta.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function fmtStamp(t) {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
const clock = (s) => {
  s = Math.floor(isFinite(s) ? Math.max(0, s) : 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Turns the text box into lines. Blank lines and [Chorus]-style labels are skipped.
// Existing times are kept when they still line up.
export function buildLines(text, times = null, prev = []) {
  const texts = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\[[^\]]*\]$/.test(l));
  return texts.map((tx, i) => {
    let t = null;
    if (times && times.length === texts.length && times[i] != null) t = times[i];
    else if (prev[i] && prev[i].text === tx) t = prev[i].t;
    return { text: tx, t };
  });
}

// A line can never start before the line above it
export function stampTime(lines, index, time) {
  let before = -Infinity;
  for (let i = 0; i < index; i++) if (lines[i].t != null && lines[i].t > before) before = lines[i].t;
  return round2(Math.max(0, time, before === -Infinity ? 0 : before + 0.05));
}

export function initSync({ $, P, db, toast, esc, ask, getLag, afterSave }) {
  const dlg = $('#syncSheet');
  const list = $('#syList');
  const st = { id: null, lines: [], sel: null, step: 'text', history: [], times: null, dirty: false, playingIdx: -1 };

  const track = () => P.S.map.get(st.id);
  const nextIndex = () => (st.sel != null ? st.sel : st.lines.findIndex((l) => l.t == null));
  const sameSong = () => { const c = P.current(); return !!c && c.id === st.id; };

  function show(step) {
    st.step = step;
    $('#syStepText').hidden = step !== 'text';
    $('#syStepTap').hidden = step !== 'tap';
  }

  function renderList(scroll = true) {
    const next = nextIndex();
    list.innerHTML = st.lines.map((l, i) => `
      <li class="sy-line${i === next ? ' next' : ''}${i === st.sel ? ' sel' : ''}" data-i="${i}">
        <button class="sy-time" data-act="seek" aria-label="Jump to this line">${l.t == null ? '--:--.--' : fmtStamp(l.t)}</button>
        <button class="sy-text" data-act="pick">${esc(l.text)}</button>
      </li>`).join('');
    const n = st.lines[next];
    $('#syNext').textContent = st.sel != null && n
      ? `Adjusting: “${n.text}”`
      : n ? `Next: “${n.text}”` : 'Every line is stamped. Save or export, or tap a line to adjust it.';
    $('#syNudge').hidden = st.sel == null;
    st.playingIdx = -1;
    updatePlaying();
    if (scroll) {
      const el = list.querySelector('.next') || list.querySelector('.sel');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function updatePlaying() {
    if (dlg.open && st.step === 'tap') $('#syClock').textContent = `${clock(P.audio.currentTime)} / ${clock(P.audio.duration)}`;
    const now = P.audio.currentTime;
    let idx = -1, best = -1;
    st.lines.forEach((l, i) => { if (l.t != null && l.t <= now && l.t >= best) { best = l.t; idx = i; } });
    if (idx === st.playingIdx) return;
    st.playingIdx = idx;
    [...list.children].forEach((el, i) => el.classList.toggle('playing', i === idx));
  }

  function stamp() {
    if (st.step !== 'tap') return;
    if (!sameSong()) { $('#syWarn').hidden = false; return; }
    const i = nextIndex();
    if (i < 0) { toast('Every line is stamped'); return; }
    st.lines[i].t = stampTime(st.lines, i, P.audio.currentTime - getLag());
    st.history.push(i);
    st.dirty = true;
    if (st.sel != null) st.sel = i + 1 < st.lines.length ? i + 1 : null;
    renderList();
  }

  function undo() {
    const i = st.history.pop();
    if (i == null) { toast('Nothing to undo'); return; }
    const t = st.lines[i].t;
    st.lines[i].t = null;
    st.sel = null;
    st.dirty = true;
    if (t != null) P.seek(Math.max(0, t - 2));
    renderList();
  }

  function nudge(act) {
    const i = st.sel;
    if (i == null) return;
    const l = st.lines[i];
    if (act === 'clear') l.t = null;
    else if (act === 'now') l.t = stampTime(st.lines, i, P.audio.currentTime - getLag());
    else l.t = stampTime(st.lines, i, (l.t == null ? P.audio.currentTime : l.t) + parseFloat(act));
    st.dirty = true;
    if (l.t != null) { P.seek(Math.max(0, l.t - 1.5)); if (P.audio.paused) P.toggle(); }
    renderList(false);
  }

  function syncedLines() {
    return st.lines.filter((l) => l.t != null).map((l) => ({ t: l.t, text: l.text })).sort((a, b) => a.t - b.t);
  }

  async function save() {
    const synced = syncedLines();
    if (synced.length < 2) { toast('Stamp at least two lines first'); return; }
    const lyrics = { synced, plain: st.lines.map((l) => l.text).join('\n') };
    await db.updateTrack(st.id, { lyrics });
    const tr = track();
    if (tr) tr.lyrics = lyrics;
    st.dirty = false;
    const skipped = st.lines.length - synced.length;
    dlg.close();
    afterSave(tr);
    toast(skipped ? `Saved. ${skipped} line${skipped === 1 ? '' : 's'} without a time left out of the sync.` : 'Synced lyrics saved', 4200);
  }

  async function exportLrc() {
    const synced = syncedLines();
    if (!synced.length) { toast('Stamp at least one line first'); return; }
    const tr = track() || {};
    const base = (tr.fileName || tr.title || 'lyrics').replace(/\.[^.]+$/, '');
    const name = `${base}.lrc`;
    const file = new File([formatLrc(synced, tr)], name, { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function open() {
    const t = P.current();
    if (!t) { toast('Play a song first'); return; }
    st.id = t.id;
    st.sel = null; st.history = []; st.dirty = false; st.times = null;
    $('#sySong').textContent = `${t.title}${t.artist ? ' · ' + t.artist : ''}`;
    $('#syWarn').hidden = true;
    const L = t.lyrics;
    if (L && L.synced && L.synced.length) {
      const items = L.synced.filter((l) => l.text);
      $('#syText').value = items.map((l) => l.text).join('\n');
      st.lines = items.map((l) => ({ text: l.text, t: l.t }));
      show('tap');
      renderList(false);
    } else {
      $('#syText').value = (L && L.plain) || '';
      st.lines = [];
      show('text');
    }
    $('#syPlay').textContent = P.audio.paused ? 'Play' : 'Pause';
    dlg.showModal();
  }

  async function tryClose() {
    if (st.dirty && !(await ask('Close without saving?', 'The times you stamped will be lost.', 'Close'))) return;
    st.dirty = false;
    dlg.close();
  }

  /* wiring */
  $('#syncClose').addEventListener('click', tryClose);
  dlg.addEventListener('cancel', (e) => { if (st.dirty) { e.preventDefault(); tryClose(); } });

  $('#syStart').addEventListener('click', () => {
    const lines = buildLines($('#syText').value, st.times, st.lines);
    if (!lines.length) { toast('Add some lyrics first'); return; }
    st.lines = lines; st.times = null; st.sel = null; st.history = [];
    show('tap');
    renderList(false);
    if (P.audio.paused) { P.seek(0); P.toggle(); }
    $('#syPlay').textContent = 'Pause';
  });
  $('#syBack').addEventListener('click', () => {
    $('#syText').value = st.lines.map((l) => l.text).join('\n');
    show('text');
  });
  $('#syLoad').addEventListener('click', () => $('#syFile').click());
  $('#syFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const parsed = await readLrcFile(f);
      if (!parsed) { toast('That file has no lyrics in it.'); return; }
      if (parsed.synced) {
        const items = parsed.synced.filter((l) => l.text);
        $('#syText').value = items.map((l) => l.text).join('\n');
        st.times = items.map((l) => l.t);
      } else {
        $('#syText').value = parsed.plain;
        st.times = null;
      }
    } catch { toast('Couldn’t read that file.'); }
  });

  const tap = $('#syTap');
  tap.addEventListener('pointerdown', (e) => { e.preventDefault(); stamp(); });
  tap.addEventListener('keydown', (e) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!e.repeat) stamp(); } });
  dlg.addEventListener('keydown', (e) => {
    if (st.step !== 'tap' || e.target === tap) return;
    if (e.target.closest('button') || /TEXTAREA|INPUT|SELECT/.test(e.target.tagName)) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) stamp(); }
  });

  $('#syPlay').addEventListener('click', () => P.toggle());
  $('#syRew').addEventListener('click', () => P.seek(Math.max(0, P.audio.currentTime - 5)));
  $('#syRestart').addEventListener('click', () => { P.seek(0); if (P.audio.paused) P.toggle(); });
  $('#syUndo').addEventListener('click', undo);
  $('#sySave').addEventListener('click', save);
  $('#syExport').addEventListener('click', exportLrc);
  $('#syNudge').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) nudge(b.dataset.act); });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('.sy-line');
    const b = e.target.closest('button');
    if (!li || !b) return;
    const i = +li.dataset.i;
    if (b.dataset.act === 'seek') {
      const t = st.lines[i].t;
      if (t != null) { P.seek(Math.max(0, t - 1)); if (P.audio.paused) P.toggle(); }
      st.sel = i;
    } else {
      st.sel = st.sel === i ? null : i;
    }
    renderList(false);
  });

  P.on('time', () => { if (dlg.open && st.step === 'tap') updatePlaying(); });
  P.on('state', () => { if (dlg.open) $('#syPlay').textContent = P.audio.paused ? 'Play' : 'Pause'; });
  P.on('track', () => { if (dlg.open && st.id != null && !sameSong()) $('#syWarn').hidden = false; });

  return { open };
}
