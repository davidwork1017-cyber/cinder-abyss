// 试听包：编码 Vorbis、跑客观检查、写 manifest.json + checks.md。
// 用法：
//   cc-slot pool <名字> lab -- node tools/score/render.mjs tools/score/listen-jobs.json <wavDir>
//   node tools/score/listen.mjs <wavDir> <listenDir> [旧试听包的 manifest.json（对比提亮前后）]
// A-* = 引擎原始输出（总线增益 1：探索音乐约 −23 LUFS、环境音约 −29 LUFS，和 audio-score 那一包同一个电平，方便对比）
// demo-* / ref-sfx = 游戏里同一条混音链路、默认滑条下的真实比例，整体再提高 6 dB 方便听
// G-*（不编码）= 游戏内电平，用来判断「音乐比密集战斗音效低 ≥ 11 LU、环境音低 ≥ 17 LU」和 2–5 kHz 打击频段的余量
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeOne, readWav } from './analyze.mjs';

const [wavDir, listenDir, oldManifest] = process.argv.slice(2);
fs.mkdirSync(listenDir, { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
const jobs = JSON.parse(fs.readFileSync(path.join(here, 'listen-jobs.json'), 'utf8'));
const FFV = process.env.FFMPEG_VORBIS || process.env.FFMPEG || 'ffmpeg';
const LISTEN_DB = 6;
const ZONES = ['ash', 'frost', 'storm', 'abyss', 'rift', 'crown'];
const ZL = { ash: '灰烬荒原', frost: '霜骨沼泽', storm: '雷鸣遗迹', abyss: '烬渊深处', rift: '坠星裂谷', crown: '余烛殿' };

function writeWav(file, chs, sr = 48000) {
  const n = chs[0].length, nc = chs.length;
  const data = Buffer.alloc(n * nc * 4);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) data.writeFloatLE(chs[c][i], (i * nc + c) * 4);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(nc, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * nc * 4, 28); h.writeUInt16LE(nc * 4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
// demo copies raised by LISTEN_DB (same gain for every demo, so their relative levels stay true)
function raised(id, outId) {
  const g = Math.pow(10, LISTEN_DB / 20);
  const chs = readWav(path.join(wavDir, id + '.wav')).map((c) => c.map((x) => x * g));
  writeWav(path.join(wavDir, outId + '.wav'), chs);
  fs.copyFileSync(path.join(wavDir, id + '.json'), path.join(wavDir, outId + '.json'));
  return outId;
}
const fileOf = (id) => id.replace(/^A_/, 'A-').replace(/_/g, '-') + '.ogg';

const items = [];
for (const j of jobs) if (j.cat === 'A' || j.cat === 'A-lite') items.push({ id: j.id, file: fileOf(j.id), label: j.label, zone: j.zone, kind: j.kind, approach: j.cat });
items.push({ id: raised('D_ash_all', 'demo_ash_sfx_music'), file: 'demo-ash-sfx-music.ogg', label: '战斗混音示范：真实群战音效 + 灰烬荒原战斗音乐和环境音（游戏内比例，整体 +6 dB）', zone: 'ash', kind: 'demo', approach: 'game' });
items.push({ id: raised('D_crown_all', 'demo_crown_sfx_music'), file: 'demo-crown-boss-sfx-music.ogg', label: '战斗混音示范：同一段音效 + 余烛殿首领战音乐和环境音（游戏内比例，整体 +6 dB）', zone: 'crown', kind: 'demo', approach: 'game' });
items.push({ id: raised('D_sfx', 'demo_sfx_only'), file: 'demo-sfx-only.ogg', label: '对照：同一段只有音效（整体 +6 dB）', zone: null, kind: 'demo', approach: 'game' });

const results = [];
for (const it of items) {
  const r = analyzeOne(wavDir, it, listenDir);
  results.push({ ...it, ...r });
  console.log(it.file, r.lufs, r.truePeakDb, r.oggBytes);
}
const M = {};
for (const j of jobs) if (j.cat !== 'A' && j.cat !== 'A-lite') M[j.id] = analyzeOne(wavDir, { id: j.id, kind: j.kind }, null);

// ---------- in-game gates
const sfx = M.G_sfx;
const sumDb = (...d) => 10 * Math.log10(d.reduce((a, x) => a + Math.pow(10, x / 10), 0));
const inGame = { sfxLufs: sfx.lufs, sfxHitDb: sfx.hitDb, zones: {} };
for (const z of ZONES) {
  const e = M[`G_${z}_explore`], f = M[`G_${z}_fight`], a = M[`G_${z}_amb`], b = z === 'crown' ? M.G_crown_boss : null;
  const o = {
    exploreLufs: e.lufs, fightLufs: f.lufs, ambLufs: a.lufs, ...(b ? { bossLufs: b.lufs } : {}),
    musicUnderSfxLU: +(sfx.lufs - e.lufs).toFixed(1), fightUnderSfxLU: +(sfx.lufs - f.lufs).toFixed(1), ...(b ? { bossUnderSfxLU: +(sfx.lufs - b.lufs).toFixed(1) } : {}),
    ambUnderSfxLU: +(sfx.lufs - a.lufs).toFixed(1),
    hitBandMarginDb: +(sfx.hitDb - sumDb(e.hitDb, a.hitDb)).toFixed(1), // 2–5 kHz: sfx vs explore music + ambience
    hitBandMarginFightDb: +(sfx.hitDb - sumDb((b || f).hitDb, a.hitDb)).toFixed(1),
  };
  o.ok = Math.min(o.musicUnderSfxLU, o.fightUnderSfxLU, o.bossUnderSfxLU ?? 99) >= 11 && o.ambUnderSfxLU >= 17;
  inGame.zones[z] = o;
}
// demo mixes: loudness added by the bed
const demo = { sfxOnlyLufs: M.D_sfx.lufs, ashMixLufs: M.D_ash_all.lufs, crownMixLufs: M.D_crown_all.lufs, ashBedHitDb: M.D_ash_bed.hitDb, crownBedHitDb: M.D_crown_bed.hitDb, sfxHitDb: M.D_sfx.hitDb };

// ---------- lite vs full (the 中 decision): loudness, spectrum, density, offline render speed
const lite = {};
for (const z of ZONES) {
  const F = M[`L_${z}_full`], L = M[`L_${z}_lite`];
  const dens = (r) => r.density ? Object.fromEntries(Object.entries(r.density).map(([k, v]) => [k, v.totalPerBar])) : {};
  lite[z] = {
    lufs: [F.lufs, L.lufs], dLU: +(L.lufs - F.lufs).toFixed(1), centroid: [F.centroid, L.centroid], hitDb: [F.hitDb, L.hitDb], low: [F.low, L.low],
    notesPerBar: [dens(F), dens(L)], renderX: [F.rtFactor, L.rtFactor], maxVoices: [F.maxVoices, L.maxVoices],
  };
}

// ---------- brightening: before (audio-score set) vs after
let bright = null;
if (oldManifest && fs.existsSync(oldManifest)) {
  const old = JSON.parse(fs.readFileSync(oldManifest, 'utf8')).clips;
  const pick = (cl, f) => cl.find((c) => c.file === f);
  bright = {};
  for (const z of ZONES) {
    const of = z === 'ash' ? 'A-ash-explore.ogg' : `A-${z}-music.ogg`;
    const o = pick(old, of), n = results.find((r) => r.file === of);
    if (!o || !n) continue;
    bright[z] = { centroidHz: [o.checks.centroidHz, n.centroid], explorePerBar: [o.checks.notesPerBar?.I0?.totalPerBar, n.density?.I0?.totalPerBar], roughMean: [o.checks.roughness?.mean, n.roughness?.mean], lufs: [o.checks.lufs, n.lufs] };
  }
}

const clips = results.map((r) => ({
  file: r.file, label: r.label, zone: r.zone, kind: r.kind, approach: r.approach, seconds: r.seconds,
  checks: {
    lufs: r.lufs, truePeakDb: r.truePeakDb, samplePeakDb: r.peakDb, peakOk: r.truePeakDb <= -1, lra: r.lra,
    centroidHz: r.centroid, hitBandDb: r.hitDb, lowShare: r.low,
    ...(r.density ? { notesPerBar: r.density } : {}),
    ...(r.roughness ? { roughness: r.roughness } : {}),
    ...(r.rtFactor ? { renderRealtimeX: r.rtFactor, maxVoices: r.maxVoices } : {}),
  },
  ogg: { bytes: r.oggBytes, kbps: r.kbps },
}));
const out = {
  generated: new Date().toISOString(),
  note: 'A-* = engine output at bus gain 1 (explore music ≈ −23 LUFS, ambience ≈ −29 LUFS, same level as the audio-score set). demo-* = the game mix chain at the default sliders (master 80 / sfx 80 / ambience 60 / music 50), all raised +6 dB together. In-game gates are measured without the listening gain.',
  inGame, demo, liteVsFull: lite, brightening: bright, clips,
};
fs.writeFileSync(path.join(listenDir, 'manifest.json'), JSON.stringify(out, null, 1));

const rows = clips.map((c) => `| ${c.file} | ${c.seconds} | ${c.checks.lufs} | ${c.checks.truePeakDb} | ${c.checks.lra} | ${c.checks.centroidHz} | ${c.checks.hitBandDb} | ${c.checks.roughness ? c.checks.roughness.mean + ' / ' + c.checks.roughness.max : '–'} | ${c.checks.notesPerBar ? Object.entries(c.checks.notesPerBar).map(([k, v]) => k + ' ' + v.totalPerBar).join(', ') : '–'} | ${c.checks.peakOk ? 'ok' : 'FAIL'} |`);
const gate = ZONES.map((z) => { const o = inGame.zones[z]; return `| ${ZL[z]} | ${o.exploreLufs} | ${o.musicUnderSfxLU} | ${o.fightUnderSfxLU}${o.bossUnderSfxLU !== undefined ? ' / 首领 ' + o.bossUnderSfxLU : ''} | ${o.ambUnderSfxLU} | ${o.hitBandMarginDb} / ${o.hitBandMarginFightDb} | ${o.ok ? 'ok' : 'FAIL'} |`; });
const lt = ZONES.map((z) => { const o = lite[z]; return `| ${ZL[z]} | ${o.lufs.join(' / ')} | ${o.dLU} | ${o.centroid.join(' / ')} | ${o.hitDb.join(' / ')} | ${JSON.stringify(o.notesPerBar[0])} / ${JSON.stringify(o.notesPerBar[1])} | ${o.renderX.map((x) => x.toFixed(1)).join(' / ')} |`; });
const br = bright ? ZONES.filter((z) => bright[z]).map((z) => { const o = bright[z]; return `| ${ZL[z]} | ${o.centroidHz.join(' → ')} | ${o.explorePerBar.join(' → ')} | ${o.roughMean.join(' → ')} |`; }) : [];
const md = [
  `# 客观检查（${out.generated.slice(0, 16)}Z）`, '',
  `## 游戏内电平（默认滑条；密集战斗音效 ${inGame.sfxLufs} LUFS，2–5 kHz ${inGame.sfxHitDb} dB）`, '',
  '| 区 | 探索音乐 LUFS | 探索比音效低 LU | 战斗比音效低 LU | 环境音比音效低 LU | 打击频段余量 dB（探索 / 战斗） | 门槛 ≥11 / ≥17 |', '|---|---|---|---|---|---|---|', ...gate, '',
  ...(br.length ? ['## 提亮前后（探索音乐，audio-score → audio-int）', '', '| 区 | 频谱重心 Hz | 探索每小节音符 | 和弦粗糙度均值 |', '|---|---|---|---|', ...br, ''] : []),
  '## lite 和完整版（中画质要不要用 lite）', '', '| 区 | LUFS 完整 / lite | 差 LU | 重心 Hz | 2–5 kHz dB | 每小节音符（完整 / lite） | 离线渲染倍速 |', '|---|---|---|---|---|---|---|', ...lt, '',
  '## 每段', '', '| 文件 | 秒 | LUFS | 真峰值 dBFS | LRA | 重心 Hz | 2–5 kHz dB | 粗糙度 均值 / 最大 | 每小节音符 | 峰值 |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, '',
];
fs.writeFileSync(path.join(listenDir, 'checks.md'), md.join('\n'));
console.log(md.join('\n'));
