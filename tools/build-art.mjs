// npm run build:art：无头 Blender 跑 art/build.py，按 art/catalog.py 生成全部布景件 → assets/ca/<区>/*.glb，
// 再写 assets/ca/manifest.json（尺寸、三角形数、来源脚本 + 种子），最后跑 tools/pack-assets.mjs 把要上线的件打进 js/assets/kit-<区>.js。
// 游戏和 npm test 都不需要 Blender：生成物一起提交。安装和用法见 docs/art-pipeline.md。
//   node tools/build-art.mjs [--only id,id] [--jobs N] [--no-pack]
//   --jobs N：同时起 N 个 Blender 进程，每个分几件（缺省 1 = 一个进程按顺序做完）；并行和串行的生成物逐字节相同
//   BLENDER=/path/to/blender 指定 Blender（缺省 ~/opt/blender-5.2.4/blender）；CA_THREADS 每个进程的烘焙线程数（缺省：串行 8，并行 1）
// 这里不管机器调度：共享机器上请用机器自己的调度包一层（烬渊的 devbox 上是 cc-slot batch，见 docs/art-pipeline.md）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGlb, stats } from './glb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] || '1' : null;
};
export const BLENDER_VERSION = '5.2.4';
const blender = process.env.BLENDER || path.join(os.homedir(), 'opt/blender-' + BLENDER_VERSION + '/blender');
const outDir = path.join(root, 'assets/ca');
const BASE = ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(root, 'art/build.py'), '--'];

function checkBlender() {
  if (!fs.existsSync(blender)) {
    console.error('找不到 Blender：' + blender + '（安装见 docs/art-pipeline.md，或用 BLENDER=... 指定）');
    process.exit(2);
  }
  const ver = spawnSync(blender, ['-b', '--factory-startup', '--version'], { encoding: 'utf8' }).stdout || '';
  if (!ver.includes('Blender ' + BLENDER_VERSION)) console.warn('警告：Blender 版本不是 ' + BLENDER_VERSION + '，生成物可能和仓库里的逐字节不同：' + ver.split('\n')[0]);
}

function runOne(extra, threads) {
  return new Promise((res) => {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CA_THREADS: String(threads) };
    const p = spawn(blender, [...BASE, ...extra], { cwd: root, env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code !== 0) {
        console.error(out.slice(-4000) + err.slice(-4000));
        console.error('Blender 失败（退出码 ' + code + '）：' + extra.join(' '));
        process.exit(1);
      }
      res(out.split('\n'));
    });
  });
}

// 清单里的全部 id（让 Blender 读 art/catalog.py，免得 Node 这边再解析一遍 Python）
async function catalogIds() {
  const lines = await runOne(['--list', '1'], 1);
  const l = lines.find((x) => x.startsWith('CA_IDS '));
  return JSON.parse(l.slice(7));
}

export function manifestEntry(st) {
  const file = path.join(outDir, st.file);
  const buf = fs.readFileSync(file);
  const s = stats(readGlb(buf));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const h = s.max[1] - s.min[1];
  return {
    id: st.id,
    category: st.cat,
    zone: st.zone,
    file: 'assets/ca/' + st.file,
    ship: st.ship,
    replaces: st.replaces || null,
    tris: s.tris,
    verts: s.verts,
    materials: s.materials,
    textures: s.textures,
    bounds: { min: s.min.map(r3), max: s.max.map(r3) },
    h: r3(h),
    r: r3(Math.max(-s.min[0], s.max[0], -s.min[2], s.max[2])),
    y0: r3(s.min[1]),
    // golem_ai（ai3d-golem）：AI 生成的源模型经 art/ai/golem_rig.py 处理；参数 + 源文件 sha256 在 args.spec 里，来源记录在 assets/ca/boss/golem.provenance.json
    source: st.gen === 'golem_ai'
      ? { script: 'art/ai/golem_rig.py', fit: 'art/ai/golem_fit.py', clips: 'art/ca/boss/golem_clips.py', gen: st.gen, catalog: 'art/catalog.py', seed: st.seed, args: st.args, provenance: 'assets/ca/boss/golem.provenance.json' }
      : st.cat === 'boss'
      ? { script: 'art/ca/boss/' + st.gen + '.py', clips: 'art/ca/boss/' + st.gen + '_clips.py', gen: st.gen, catalog: 'art/catalog.py', seed: st.seed, args: st.args, bake: st.bake }
      : { script: 'art/ca/gen.py', gen: st.gen, catalog: 'art/catalog.py', seed: st.seed, args: st.args, bake: st.bake },
    ...(st.cat === 'boss' ? { bones: st.bones, clips: st.clips, home: st.home } : {}),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

async function main() {
  checkBlender();
  const only = opt('only');
  const jobs = Math.max(1, +(opt('jobs') || 1));
  const ids = only ? only.split(',') : await catalogIds();
  const threads = +(process.env.CA_THREADS || (jobs > 1 ? 1 : 8));
  // 分组：按清单顺序轮流分给各个进程
  const groups = Array.from({ length: Math.min(jobs, ids.length) }, () => []);
  ids.forEach((id, i) => groups[i % groups.length].push(id));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-build-'));
  const t0 = Date.now();
  await Promise.all(groups.map((g, gi) => runOne(['--out', outDir, '--stats', path.join(tmp, gi + '.json'), '--only', g.join(',')], threads)));
  const ms = Date.now() - t0;
  const built = [];
  groups.forEach((g, gi) => built.push(...JSON.parse(fs.readFileSync(path.join(tmp, gi + '.json'), 'utf8'))));
  fs.rmSync(tmp, { recursive: true });
  built.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  for (const st of built) console.log(st.id.padEnd(22), String(st.tris).padStart(5) + ' tris', '烘焙 ' + st.bake_s.toFixed(3) + ' s', '共 ' + st.total_s.toFixed(3) + ' s');
  if (built.length !== ids.length) {
    console.error('有件没生成出来：期望 ' + ids.length + ' 件，实际 ' + built.length + ' 件');
    process.exit(1);
  }
  const mfile = path.join(outDir, 'manifest.json');
  const old = fs.existsSync(mfile) ? JSON.parse(fs.readFileSync(mfile, 'utf8')) : { assets: [] };
  const byId = new Map(old.assets.map((a) => [a.id, a]));
  for (const st of built) byId.set(st.id, manifestEntry(st));
  // 清单里有、catalog 里已经删掉的件：只在全量构建时清掉
  const builtIds = new Set(built.map((b) => b.id));
  const assets = [...byId.values()].filter((a) => only || builtIds.has(a.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const man = {
    _comment: '自动生成（npm run build:art），不要手改。布景件清单：来源脚本 + 种子、尺寸（米，Y 朝上，原点在底面中心）、三角形数；tools/check-art.mjs 按它检查。',
    blender: BLENDER_VERSION,
    palette: 'assets/ca/palette.png',
    assets,
  };
  fs.writeFileSync(mfile, JSON.stringify(man, null, 1) + '\n');
  // 调色板图集也单独放一份 PNG（文档、以后引擎里直接采样用；和 GLB 里内嵌的是同一份字节）
  const first = assets.find((a) => a.category !== 'boss') && readGlb(path.join(root, assets.find((a) => a.category !== 'boss').file));
  if (first && first.json.images && first.json.images[0]) {
    const bv = first.json.bufferViews[first.json.images[0].bufferView];
    fs.writeFileSync(path.join(outDir, 'palette.png'), first.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
  }
  console.log('Blender ' + (ms / 1000).toFixed(1) + ' s（' + groups.length + ' 个进程 × 烘焙线程 ' + threads + '），' + built.length + ' 件 → assets/ca/，清单 ' + assets.length + ' 件');
  if (opt('no-pack') === null) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools/pack-assets.mjs')], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
