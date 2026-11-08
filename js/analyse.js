// Waveform analysis, done once per song and stored with it.
//   s / e : where audible sound starts and ends (seconds) at three sensitivities
//           [gentle, normal, aggressive]
//   rms   : average loudness in dBFS (quiet gaps ignored)
//   peak  : loudest sample in dBFS
const THRESHOLDS = [-55, -48, -40]; // dBFS: below this a 20 ms window counts as silence
const WINDOW_SEC = 0.02;
const round2 = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;

// channels: array of Float32Array (one per channel), sr: sample rate
export function analyseSamples(channels, sr) {
  const win = Math.max(1, Math.round(sr * WINDOW_SEC));
  const n = channels[0].length;
  const nw = Math.floor(n / win);
  const db = new Float32Array(nw);
  let peak = 0;
  for (let w = 0; w < nw; w++) {
    let sum = 0;
    const o = w * win;
    for (let c = 0; c < channels.length; c++) {
      const d = channels[c];
      for (let i = 0; i < win; i++) {
        const v = d[o + i];
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
    const ms = sum / (win * channels.length);
    db[w] = ms > 1e-12 ? 10 * Math.log10(ms) : -120;
  }

  const dur = n / sr;
  const s = [], e = [];
  for (const th of THRESHOLDS) {
    let a = 0;
    while (a < nw && db[a] < th) a++;
    if (a >= nw) { s.push(0); e.push(0); continue; }  // all silent: leave alone
    let b = nw - 1;
    while (b > a && db[b] < th) b--;
    s.push(round2(Math.max(0, a * WINDOW_SEC - 0.05)));
    e.push(round2(Math.min(dur, (b + 1) * WINDOW_SEC + 0.25)));
  }

  let power = 0, count = 0;
  for (let w = 0; w < nw; w++) {
    if (db[w] > -55) { power += Math.pow(10, db[w] / 10); count++; }
  }
  const rms = count ? 10 * Math.log10(power / count) : -120;
  const pk = peak > 0 ? 20 * Math.log10(peak) : -120;
  return { s, e, rms: round1(rms), peak: round1(pk), dur: round2(dur) };
}

// Decodes a song at a low sample rate (keeps memory small) and analyses it.
export async function analyseBlob(blob, durationHint) {
  if (durationHint && durationHint > 1500) return { skipped: true }; // over 25 minutes
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  const data = await blob.arrayBuffer();
  const ctx = new OAC(1, 1, 22050);
  const buf = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && p.catch) p.catch(reject);
  });
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  return analyseSamples(channels, buf.sampleRate);
}
