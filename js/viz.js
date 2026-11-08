// Audio-reactive visualiser drawn on a canvas from the engine's analyser.
import * as P from './player.js';

export const DEFAULT_COLORS = ['#D7261E', '#F6ECDD'];

/* ---------- colours from album art ---------- */
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function pickColors(data) {
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const [h, s, l] = rgb2hsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.25 || l < 0.18 || l > 0.85) continue;
    const w = s * (1 - Math.abs(l - 0.5));
    const b = buckets[Math.min(11, Math.floor(h * 12))];
    b.w += w;
    b.h += h * w;
  }
  const ranked = buckets.filter((b) => b.w > 0).map((b) => ({ w: b.w, h: b.h / b.w })).sort((a, b) => b.w - a.w);
  if (!ranked.length || ranked[0].w < 1) return DEFAULT_COLORS;
  const h1 = ranked[0].h;
  const second = ranked.find((r, i) => i > 0 && Math.abs(r.h - h1) > 0.08 && r.w > ranked[0].w * 0.15);
  const h2 = second ? second.h : (h1 + 0.08) % 1;
  return [`hsl(${Math.round(h1 * 360)} 85% 58%)`, `hsl(${Math.round(h2 * 360)} 80% 68%)`];
}

export function extractColors(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 24, 24);
        resolve(pickColors(x.getImageData(0, 0, 24, 24).data));
      } catch { resolve(DEFAULT_COLORS); }
    };
    img.onerror = () => resolve(DEFAULT_COLORS);
    img.src = url;
  });
}

/* ---------- drawing ---------- */
export function createViz(canvas) {
  const g = canvas.getContext('2d');
  const opts = { style: 'bars', colors: DEFAULT_COLORS };
  let W = 0, H = 0, dpr = 1;
  let raf = 0, running = false, idleFrames = 0, rot = 0;
  let bars = [], caps = [];
  let freq = null, wave = null;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);

  // Group FFT bins into n log-spaced bands (0..1)
  function bands(an, n) {
    const sr = P.sampleRate() || 44100;
    const binHz = sr / an.fftSize;
    const fmin = 45, fmax = Math.min(16000, sr / 2 * 0.95);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const f0 = fmin * Math.pow(fmax / fmin, i / n);
      const f1 = fmin * Math.pow(fmax / fmin, (i + 1) / n);
      const a = Math.max(1, Math.floor(f0 / binHz));
      const b = Math.max(a + 1, Math.ceil(f1 / binHz));
      let m = 0, sum = 0;
      for (let k = a; k < b && k < freq.length; k++) { sum += freq[k]; if (freq[k] > m) m = freq[k]; }
      const v = (m * 0.6 + (sum / (b - a)) * 0.4) / 255;
      out[i] = Math.min(1, v * (0.78 + 0.45 * (i / n)));   // gentle tilt: highs are naturally quieter
    }
    return out;
  }

  function smoothBars(vals) {
    if (bars.length !== vals.length) { bars = vals.map(() => 0); caps = vals.map(() => 0); }
    for (let i = 0; i < vals.length; i++) {
      bars[i] = vals[i] > bars[i] ? vals[i] : bars[i] * 0.9 + vals[i] * 0.1;
      caps[i] = Math.max(bars[i], caps[i] - 0.007);
    }
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawBars(an) {
    const [c1, c2] = opts.colors;
    const n = Math.max(24, Math.min(48, Math.floor(W / 11)));
    smoothBars(bands(an, n));
    const padB = Math.min(36, H * 0.1);
    const maxH = H - padB - H * 0.08;
    const gap = Math.max(2, W * 0.008);
    const bw = (W - gap * (n + 1)) / n;
    const grad = g.createLinearGradient(0, H - padB, 0, H - padB - maxH);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    for (let i = 0; i < n; i++) {
      const h = Math.max(3, bars[i] * maxH);
      const x = gap + i * (bw + gap);
      g.fillStyle = grad;
      roundRect(x, H - padB - h, bw, h, bw / 2);
      g.fill();
      g.fillStyle = c2;
      g.globalAlpha = 0.85;
      g.fillRect(x, H - padB - caps[i] * maxH - 6, bw, 2.5);
      g.globalAlpha = 1;
    }
  }

  function drawWave(an) {
    const [c1, c2] = opts.colors;
    an.getByteTimeDomainData(wave);
    const cy = (H - Math.min(36, H * 0.1)) / 2 + H * 0.04;
    const amp = H * 0.3;
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    const step = Math.max(1, Math.floor(wave.length / 220));
    for (const [alpha, mirror, width] of [[1, 1, 3], [0.3, -1, 2]]) {
      g.beginPath();
      for (let i = 0, k = 0; i < wave.length; i += step, k++) {
        const x = (i / (wave.length - 1)) * W;
        const y = cy + mirror * ((wave[i] / 128) - 1) * amp;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.lineJoin = 'round';
      g.lineWidth = width;
      g.strokeStyle = grad;
      g.globalAlpha = alpha;
      g.shadowColor = c1;
      g.shadowBlur = alpha === 1 ? 16 : 0;
      g.stroke();
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;
  }

  function drawCircle(an) {
    const [c1, c2] = opts.colors;
    const n = 64;
    smoothBars(bands(an, n));
    const bass = (bars[0] + bars[1] + bars[2] + bars[3]) / 4;
    const cx = W / 2, cy = (H - Math.min(40, H * 0.12)) / 2;
    const size = Math.min(W, H);
    const r0 = size * 0.22 * (1 + bass * 0.1);
    rot += 0.002 + bass * 0.01;
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    g.lineCap = 'round';
    g.lineWidth = Math.max(2, size * 0.014);
    g.strokeStyle = grad;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rot - Math.PI / 2;
      const len = 3 + bars[i] * size * 0.2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      g.stroke();
    }
    g.beginPath();
    g.arc(cx, cy, r0 - size * 0.02, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = c1;
    g.globalAlpha = 0.5 + bass * 0.5;
    g.stroke();
    g.globalAlpha = 1;
  }

  function frame() {
    raf = 0;
    if (!running) return;
    const an = P.getAnalyser();
    g.clearRect(0, 0, W, H);
    if (an) {
      if (!freq || freq.length !== an.frequencyBinCount) { freq = new Uint8Array(an.frequencyBinCount); wave = new Uint8Array(an.fftSize); }
      an.getByteFrequencyData(freq);
      if (opts.style === 'wave') drawWave(an);
      else if (opts.style === 'circle') drawCircle(an);
      else drawBars(an);
    }
    // Park the loop while nothing is playing and the graphics have settled
    if (P.audio.paused) { idleFrames++; if (idleFrames > 90) return; } else idleFrames = 0;
    raf = requestAnimationFrame(frame);
  }

  return {
    start() { running = true; idleFrames = 0; resize(); if (!raf) raf = requestAnimationFrame(frame); },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; g.clearRect(0, 0, W, H); },
    set(o) { Object.assign(opts, o); },
    wake() { if (running && !raf) { idleFrames = 0; raf = requestAnimationFrame(frame); } },
  };
}
