// npm run build:art：无头 Blender 跑 art/build.py，按 art/catalog.py 生成全部布景件 → assets/ca/<区>/*.glb，
// 再写 assets/ca/manifest.json（尺寸、三角形数、来源脚本 + 种子），最后跑 tools/pack-assets.mjs 把要上线的件打进 js/assets/kit-<区>.js。
// 游戏和 npm test 都不需要 Blender：生成物一起提交。安装和用法见 docs/art-pipeline.md。
//   node tools/build-art.mjs [--only id,id] [--no-pack]
//   BLENDER=/path/to/blender 指定 Blender（缺省 ~/opt/blender-5.2.4/blender）；CA_THREADS 烘焙线程数（缺省 8）
// 共享机器上的规矩：开跑前查测试槽位文件（CA_SLOT_FILE，缺省 ~/dev/zones-notes/SLOT），被占用就每 60 秒查一次、最多等 60 分钟；
// Blender 以 nice 15 / ionice idle / taskset 0-15 运行（Linux 上；没有这些命令就直接跑）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

function waitSlot() {
  const f = process.env.CA_SLOT_FILE || path.join(os.homedir(), 'dev/zones-notes/SLOT');
  for (let i = 0; i < 60; i++) {
    if (!fs.existsSync(f)) return;
    console.log('测试槽位被占用（' + fs.readFileSync(f, 'utf8').trim() + '），60 秒后再查');
    spawnSync('sleep', ['60']);
  }
  console.error('测试槽位 60 分钟没空出来，不跑 Blender');
  process.exit(3);
}

const has = (cmd) => spawnSync('sh', ['-c', 'command -v ' + cmd], { encoding: 'utf8' }).status === 0;

function runBlender(extra) {
  if (!fs.existsSync(blender)) {
    console.error('找不到 Blender：' + blender + '（安装见 docs/art-pipeline.md，或用 BLENDER=... 指定）');
    process.exit(2);
  }
  const ver = spawnSync(blender, ['-b', '--factory-startup', '--version'], { encoding: 'utf8' }).stdout || '';
  if (!ver.includes('Blender ' + BLENDER_VERSION)) console.warn('警告：Blender 版本不是 ' + BLENDER_VERSION + '，生成物可能和仓库里的逐字节不同：' + ver.split('\n')[0]);
  waitSlot();
  let cmd = [blender, '-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(root, 'art/build.py'), '--', ...extra];
  if (process.platform === 'linux') {
    if (has('taskset')) cmd = ['taskset', '-c', '0-15', ...cmd];
    if (has('ionice')) cmd = ['ionice', '-c3', ...cmd];
    if (has('nice')) cmd = ['nice', '-n', '15', ...cmd];
  }
  const t0 = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const lines = (r.stdout || '').split('\n');
  if (r.status !== 0) {
    console.error((r.stdout || '').slice(-4000) + (r.stderr || '').slice(-4000));
    console.error('Blender 失败（退出码 ' + r.status + '）');
    process.exit(1);
  }
  return { lines, ms: Date.now() - t0 };
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
    source: { script: 'art/ca/gen.py', gen: st.gen, catalog: 'art/catalog.py', seed: st.seed, args: st.args, bake: st.bake },
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

function main() {
  const only = opt('only');
  const statsFile = path.join(os.tmpdir(), 'ca-build-' + process.pid + '.json');
  const extra = ['--out', outDir, '--stats', statsFile];
  if (only) extra.push('--only', only);
  const { lines, ms } = runBlender(extra);
  for (const l of lines) if (l.startsWith('CA_ASSET ')) {
    const st = JSON.parse(l.slice(9));
    console.log(st.id.padEnd(22), String(st.tris).padStart(5) + ' tris', '烘焙 ' + st.bake_s.toFixed(3) + ' s', '共 ' + st.total_s.toFixed(3) + ' s');
  }
  const built = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  fs.unlinkSync(statsFile);
  const mfile = path.join(outDir, 'manifest.json');
  const old = fs.existsSync(mfile) ? JSON.parse(fs.readFileSync(mfile, 'utf8')) : { assets: [] };
  const byId = new Map(old.assets.map((a) => [a.id, a]));
  for (const st of built) byId.set(st.id, manifestEntry(st));
  // 清单里有、catalog 里已经删掉的件：只在全量构建时清掉
  const ids = new Set(built.map((b) => b.id));
  const assets = [...byId.values()].filter((a) => only || ids.has(a.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const man = {
    _comment: '自动生成（npm run build:art），不要手改。布景件清单：来源脚本 + 种子、尺寸（米，Y 朝上，原点在底面中心）、三角形数；tools/check-art.mjs 按它检查。',
    blender: BLENDER_VERSION,
    palette: 'assets/ca/palette.png',
    assets,
  };
  fs.writeFileSync(mfile, JSON.stringify(man, null, 1) + '\n');
  // 调色板图集也单独放一份 PNG（文档、以后引擎里直接采样用；和 GLB 里内嵌的是同一份字节）
  const first = assets[0] && readGlb(path.join(root, assets[0].file));
  if (first && first.json.images && first.json.images[0]) {
    const bv = first.json.bufferViews[first.json.images[0].bufferView];
    fs.writeFileSync(path.join(outDir, 'palette.png'), first.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
  }
  console.log('Blender ' + (ms / 1000).toFixed(1) + ' s，' + built.length + ' 件 → assets/ca/，清单 ' + assets.length + ' 件');
  if (opt('no-pack') === null) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools/pack-assets.mjs')], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
