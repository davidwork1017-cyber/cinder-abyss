// 客观检查 + Vorbis 编码（audio-score 的 analyze.mjs）：响度（ebur128 的 LUFS / LRA / 真峰值）、频带、粗糙度、音符密度。
// 用法：node tools/score/analyze.mjs <wavDir> <listenDir|-> <ids.json|all>
//   ids.json: [{ id, file, label, zone, kind, q }]（q = Vorbis 质量，默认 4）
// ffmpeg：$FFMPEG（要有 ebur128）、$FFMPEG_VORBIS（要有 libvorbis），默认都是 PATH 里的 ffmpeg
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FF = process.env.FFMPEG || 'ffmpeg'; // ebur128
const FFV = process.env.FFMPEG_VORBIS || FF; // libvorbis
const SR = 48000;

export function readWav(file) {
  const b = fs.readFileSync(file);
  const nc = b.readUInt16LE(22);
  const off = 44;
  const n = (b.length - off) / 4 / nc;
  const chs = Array.from({ length: nc }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) chs[c][i] = b.readFloatLE(off + (i * nc + c) * 4);
  return chs;
}

export function ebur(file) {
  // ffmpeg writes the summary to stderr
  const err = execFileSync('bash', ['-c', `${FF} -hide_banner -nostats -i "${file}" -af ebur128=peak=true -f null - 2>&1 | tail -20`], { encoding: 'utf8' });
  const I = +(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(err) || [])[1];
  const LRA = +(/LRA:\s+([\d.]+) LU/.exec(err) || [])[1];
  const TP = +(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(err) || [])[1];
  return { I, LRA, TP };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export function spectrum(chs) {
  const N = 4096, hop = 2048;
  const n = chs[0].length;
  const P = new Float64Array(N / 2);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= n; s += hop) {
    for (let i = 0; i < N; i++) {
      let x = 0;
      for (const c of chs) x += c[s + i];
      re[i] = (x / chs.length) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
  }
  let tot = 0, cen = 0, hit = 0, low = 0, mid = 0, air = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    tot += P[k];
    cen += f * P[k];
    if (f >= 2000 && f < 5000) hit += P[k];
    if (f < 250) low += P[k];
    if (f >= 250 && f < 2000) mid += P[k];
    if (f >= 5000) air += P[k];
  }
  // absolute band levels (dB re full scale, mean-square of the mono mix): share × total power
  let ms = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (const c of chs) x += c[i];
    x /= chs.length;
    ms += x * x;
  }
  ms /= n;
  const db = (share) => +(10 * Math.log10(share * ms + 1e-30)).toFixed(1);
  return { hitDb: db(hit / tot), lowDb: db(low / tot), midDb: db(mid / tot), centroid: Math.round(cen / tot), hitBand: +(hit / tot).toFixed(4), low: +(low / tot).toFixed(3), mid: +(mid / tot).toFixed(3), air: +(air / tot).toFixed(4), P };
}

// Sethares roughness of a set of midi notes (6 harmonics, 0.88^k), relative to a major triad + bass in the same register
function partials(midis) {
  const ps = [];
  for (const m of midis) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    for (let k = 1; k <= 6; k++) ps.push([f * k, Math.pow(0.88, k - 1)]);
  }
  return ps;
}
function diss(midis) {
  const ps = partials(midis);
  let d = 0;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const [f1, a1] = ps[i], [f2, a2] = ps[j];
      const fm = Math.min(f1, f2), df = Math.abs(f1 - f2);
      const s = 0.24 / (0.0207 * fm + 18.96);
      d += Math.min(a1, a2) * (Math.exp(-3.5 * s * df) - Math.exp(-5.75 * s * df));
    }
  return d;
}
export function roughness(log) {
  const chords = (log || []).filter((e) => e.k === 'chord');
  if (!chords.length) return null;
  const vals = chords.map((c) => {
    const all = [...c.midis, c.bass];
    const root = c.bass + 12 * Math.round((c.midis[0] - c.bass) / 12);
    const ref = diss([root, root + 4, root + 7, c.bass]);
    return { name: c.name, r: diss(all) / ref };
  });
  const rs = vals.map((v) => v.r);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const tense = [...new Set(vals.filter((v) => v.r > 1.6).map((v) => v.name))];
  return { mean: +mean.toFixed(2), max: +Math.max(...rs).toFixed(2), n: rs.length, tenseChords: tense };
}
export function density(log, barSec) {
  const notes = (log || []).filter((e) => e.k === 'note');
  const by = {};
  for (const e of notes) {
    const key = e.I;
    by[key] = by[key] || { bars: new Set(), mel: 0, ost: 0, perc: 0, arp: 0 };
    by[key].bars.add(e.bar);
    if (e.layer === 'arp') by[key].arp++;
    else if (e.layer === 'ost') by[key].ost++;
    else if (e.layer === 'perc') by[key].perc++;
    else by[key].mel++;
  }
  // bars spent at each intensity (count bars with any event logged at that intensity, incl. chord events)
  const barsAt = {};
  for (const e of log || []) if (e.bar !== undefined) (barsAt[e.I] = barsAt[e.I] || new Set()).add(e.bar);
  const out = {};
  for (const k in by) {
    const nb = (barsAt[k] || by[k].bars).size || 1;
    const tot = by[k].mel + by[k].ost + by[k].perc + by[k].arp;
    out['I' + k] = { bars: nb, melPerBar: +(by[k].mel / nb).toFixed(2), arpPerBar: +(by[k].arp / nb).toFixed(2), ostPerBar: +(by[k].ost / nb).toFixed(2), percPerBar: +(by[k].perc / nb).toFixed(2), totalPerBar: +(tot / nb).toFixed(2), perSec: +(tot / nb / barSec).toFixed(2) };
  }
  return out;
}
function seam(chs) {
  // wrap jump vs typical sample-to-sample step, and RMS of the last / first 50 ms
  const n = chs[0].length;
  let jump = 0;
  const steps = [];
  for (const c of chs) {
    jump = Math.max(jump, Math.abs(c[0] - c[n - 1]));
    for (let i = 1; i < n; i += 97) steps.push(Math.abs(c[i] - c[i - 1]));
  }
  steps.sort((a, b) => a - b);
  const p99 = steps[Math.floor(steps.length * 0.99)];
  const rms = (a, b) => {
    let s = 0, k = 0;
    for (const c of chs) for (let i = a; i < b; i++) (s += c[i] * c[i]), k++;
    return 10 * Math.log10(s / k + 1e-20);
  };
  const W = 2400;
  return { wrapJump: +jump.toFixed(5), stepP99: +p99.toFixed(5), rmsEndDb: +rms(n - W, n).toFixed(1), rmsStartDb: +rms(0, W).toFixed(1) };
}

export function analyzeOne(wavDir, item, listenDir) {
  const wav = path.join(wavDir, item.id + '.wav');
  const meta = JSON.parse(fs.readFileSync(path.join(wavDir, item.id + '.json'), 'utf8'));
  const chs = readWav(wav);
  let peak = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > peak) peak = Math.abs(c[i]);
  const L = ebur(wav);
  const sp = spectrum(chs);
  delete sp.P;
  const res = { id: item.id, seconds: +(chs[0].length / SR).toFixed(2), peakDb: +(20 * Math.log10(peak)).toFixed(2), truePeakDb: L.TP, lufs: L.I, lra: L.LRA, ...sp };
  if (meta.log) {
    const zone = meta.spec && meta.spec.zone;
    res.roughness = item.kind !== 'amb' ? roughness(meta.log) : null;
    if (zone && item.kind !== 'amb') {
      const Z = { ash: [76, 16, 4], frost: [63, 12, 4], storm: [88, 16, 4], abyss: [54, 16, 4], rift: [70, 12, 6], crown: [66, 16, 4] }[zone];
      res.density = density(meta.log, (Z[1] * 60) / Z[0] / Z[2]);
    }
  }
  for (const k of ['createMs', 'rtFactor', 'wallMs', 'tickMed', 'tickP95', 'tickMax', 'ticks', 'maxVoices', 'nodes', 'initMs', 'maxDiff', 'seamDiff']) if (meta[k] != null) res[k] = typeof meta[k] === 'number' ? +meta[k].toFixed(k === 'maxDiff' || k === 'seamDiff' ? 7 : 3) : meta[k];
  if (meta.fn === 'renderB') res.seam = seam(chs);
  if (listenDir && item.file) {
    const ogg = path.join(listenDir, item.file);
    execFileSync(FFV, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', '-q:a', String(item.q ?? 4), ogg]);
    res.file = item.file;
    res.oggBytes = fs.statSync(ogg).size;
    res.kbps = +((res.oggBytes * 8) / res.seconds / 1000).toFixed(1);
  }
  return res;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const [wavDir, listenDir, idsArg] = process.argv.slice(2);
  const items = idsArg === 'all'
    ? fs.readdirSync(wavDir).filter((f) => f.endsWith('.wav')).map((f) => ({ id: f.slice(0, -4) }))
    : JSON.parse(fs.readFileSync(idsArg, 'utf8'));
  const all = [];
  for (const it of items) {
    const r = analyzeOne(wavDir, it, listenDir === '-' ? null : listenDir);
    all.push({ ...it, ...r });
    console.log(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(wavDir, 'metrics.json'), JSON.stringify(all, null, 1));
}
