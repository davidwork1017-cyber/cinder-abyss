// 在 headless Chrome 里跑 tools/score/lab.html 的渲染任务，每个任务写一个 32 位浮点 WAV + 一个 meta JSON。
// 用法（会起 Chrome，走测试槽位的池）：cc-slot pool <名字> lab -- node tools/score/render.mjs <jobs.json> <输出目录>
// job: { id, fn: 'renderA' | 'renderGame' | 'planA' | 'liveTest', spec: {...} }
//   renderGame 的 spec.sfx = 'montage' | 'crowd' 时，从 fight-sfx.json 读那条真实群战的音效时间线放进 spec.events
//   liveTest 另外记整个 Chrome 进程树的 CPU 占用（cpuPct，100 = 一个核）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, '../../package.json'));
const { chromium } = require('playwright-core');

const [jobsFile, outDir] = process.argv.slice(2);
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
const FIGHT = JSON.parse(fs.readFileSync(path.join(here, 'fight-sfx.json'), 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

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

// 本进程所有子孙进程（整个 Chrome 进程树）的 CPU 秒数（user + sys）
function treeCpu() {
  const kids = {}, stat = {};
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      (kids[+f[1]] = kids[+f[1]] || []).push(+d);
      stat[d] = (+f[11] + +f[12]) / 100;
    } catch (e) {}
  }
  let tot = 0;
  const walk = (p) => (kids[p] || []).forEach((c) => ((tot += stat[c] || 0), walk(c)));
  walk(process.pid);
  return tot;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('file://' + path.join(here, 'lab.html'));
try {
  for (const job of jobs) {
    const t0 = Date.now(), cpu0 = treeCpu();
    const spec = Object.assign({}, job.spec);
    if (spec.sfx) spec.events = FIGHT[spec.sfx];
    const res = await page.evaluate(([fn, spec]) => window[fn](spec), [job.fn, spec]);
    if (job.fn === 'liveTest') res.cpuPct = +((100 * (treeCpu() - cpu0)) / ((Date.now() - t0) / 1000)).toFixed(1);
    if (errs.length) throw new Error('page errors: ' + errs.join(' | '));
    delete spec.events;
    const meta = { id: job.id, fn: job.fn, spec, ...(res.extra || res) };
    delete meta.len;
    delete meta.nch;
    if (res.len) {
      const CH = 1 << 19, chs = [];
      for (let c = 0; c < res.nch; c++) {
        const f = new Float32Array(res.len);
        for (let s = 0; s < res.len; s += CH) {
          const b = Buffer.from(await page.evaluate(([c, s, CH]) => window.chunk(c, s, CH), [c, s, CH]), 'base64');
          f.set(new Float32Array(b.buffer, b.byteOffset, b.length / 4), s);
        }
        chs.push(f);
      }
      writeWav(path.join(outDir, job.id + '.wav'), chs);
      meta.seconds = res.len / 48000;
    }
    fs.writeFileSync(path.join(outDir, job.id + '.json'), JSON.stringify(meta));
    console.log(job.id, job.fn, ((Date.now() - t0) / 1000).toFixed(1) + 's', meta.rtFactor ? 'rt×' + meta.rtFactor.toFixed(1) : '', meta.cpuPct != null ? 'cpu ' + meta.cpuPct + '%' : '', meta.maxVoices ? 'maxVoices ' + meta.maxVoices : '');
  }
} finally {
  await browser.close();
}
