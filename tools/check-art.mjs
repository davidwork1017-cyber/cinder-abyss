// 自产素材检查（只用 Node，不需要 Blender）：assets/ca/manifest.json 里的每个 GLB 都要符合 docs/art-style.md 的规矩。
//   node tools/check-art.mjs        → 逐件打印，有问题以非 0 退出（每条问题都带件的 id）
// npm test 的第一步也会调用 checkArt()（test/smoke.mjs）。预算在 art/budgets.json，骨骼名表在 art/rig.json。
// 查的项目：文件在、和清单的 sha256 一致（防止改了生成器忘了提交生成物 / 清单）；三角形数在类别预算内；材质 / 贴图数；
// 只用共享调色板图集；高度在类别的合理范围（抓单位错）；原点在底面中心；没有未应用的节点变换；命名；必备的顶点属性；
// 带蒙皮的件骨骼名都在标准骨架表里（占位：表还是空的）；清单里的尺寸和 GLB 实测一致；打包进游戏的件确实在对应的包里。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readGlb, stats, isIdentity } from './glb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

export function checkArt() {
  const budgets = rd('art/budgets.json'), rig = rd('art/rig.json'), man = rd('assets/ca/manifest.json');
  const fails = [], rows = [];
  const bad = (id, msg) => fails.push(id + '：' + msg);
  const palFile = path.join(root, man.palette || 'assets/ca/palette.png');
  const palSha = fs.existsSync(palFile) ? crypto.createHash('sha256').update(fs.readFileSync(palFile)).digest('hex') : null;
  if (!palSha) bad('(清单)', '缺调色板图集 ' + man.palette);
  const ids = new Set();
  // 打包进游戏的件：kit-<区> 包里的 key（直接读生成的包文件，确认上线的就是清单里这一份）
  const packed = {};
  const packOf = (zone) => {
    if (packed[zone] !== undefined) return packed[zone];
    const f = path.join(root, 'js/assets/kit-' + zone + '.js');
    if (!fs.existsSync(f)) return (packed[zone] = null);
    const src = fs.readFileSync(f, 'utf8');
    return (packed[zone] = JSON.parse(src.slice(src.indexOf('= {') + 2, src.lastIndexOf(';'))).models);
  };
  for (const a of man.assets) {
    const id = a.id || '(无 id)';
    if (ids.has(id)) bad(id, 'id 重复');
    ids.add(id);
    // 命名：ca/<区>_<物件>[_变体]，小写字母 / 数字 / 下划线；文件 = assets/ca/<区>/<id 去掉 ca/>.glb
    if (!/^ca\/[a-z]+_[a-z0-9]+(_[a-z0-9]+)*$/.test(id)) bad(id, 'id 不合命名规则 ca/<区>_<物件>[_变体]（小写、下划线）');
    else if (id.slice(3, 3 + a.zone.length + 1) !== a.zone + '_') bad(id, 'id 的区域前缀和 zone 字段（' + a.zone + '）不一致');
    const want = 'assets/ca/' + a.zone + '/' + id.slice(3) + '.glb';
    if (a.file !== want) bad(id, '文件名应为 ' + want + '，清单里是 ' + a.file);
    const cat = budgets.categories[a.category];
    if (!cat) {
      bad(id, '未知类别 ' + a.category);
      continue;
    }
    const file = path.join(root, a.file);
    if (!fs.existsSync(file)) {
      bad(id, '文件不存在 ' + a.file);
      continue;
    }
    const buf = fs.readFileSync(file);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== a.sha256) bad(id, 'GLB 和清单的 sha256 不一致（改了生成器没重新 npm run build:art，或者手改了文件）');
    let g, s;
    try {
      g = readGlb(buf);
      s = stats(g);
    } catch (e) {
      bad(id, 'GLB 读不了：' + e.message);
      continue;
    }
    const h = s.max[1] - s.min[1];
    const r = Math.max(-s.min[0], s.max[0], -s.min[2], s.max[2]);
    rows.push({ id, cat: a.category, tris: s.tris, budget: cat.tris, h, r, mats: s.materials, tex: s.textures, ship: a.ship });
    // 预算
    if (s.tris > cat.tris) bad(id, '三角形 ' + s.tris + ' 超过 ' + a.category + ' 预算 ' + cat.tris);
    if (s.materials > cat.materials) bad(id, '材质 ' + s.materials + ' 个，上限 ' + cat.materials);
    if (s.textures > cat.textures || s.images > cat.textures) bad(id, '贴图 ' + Math.max(s.textures, s.images) + ' 张，上限 ' + cat.textures);
    // 只用共享调色板：材质名固定、图集和 assets/ca/palette.png 同一份字节
    for (const m of g.json.materials || []) if (m.name !== budgets.material) bad(id, '材质名 ' + m.name + '，应为共享的 ' + budgets.material);
    for (const im of g.json.images || []) {
      const bv = g.json.bufferViews[im.bufferView];
      const ih = bv ? crypto.createHash('sha256').update(g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)).digest('hex') : null;
      if (ih !== palSha) bad(id, '贴图不是共享调色板图集（' + (im.name || im.uri || '?') + '）');
    }
    // 单位 / 尺度：高度在类别的合理范围里（按厘米导出会大 100 倍）
    if (!(h >= cat.h[0] && h <= cat.h[1])) bad(id, '高度 ' + h.toFixed(3) + ' m 不在 ' + a.category + ' 的合理范围 ' + cat.h.join('–') + ' m（单位错了？）');
    // 原点在底面中心：最低点在地面附近（允许根 / 埋入部分到 -15% 高度），原点落在水平包围盒里且靠近中心
    if (s.min[1] > 0.02) bad(id, '最低点 y = ' + s.min[1].toFixed(3) + '，悬空：原点应在底面（y = 0 是地面）');
    if (s.min[1] < -(0.15 * h + 0.05)) bad(id, '最低点 y = ' + s.min[1].toFixed(3) + '，埋得太深（> 15% 高度）：原点不在底面？');
    const ext = Math.max(s.max[0] - s.min[0], s.max[2] - s.min[2]);
    const cx = (s.max[0] + s.min[0]) / 2, cz = (s.max[2] + s.min[2]) / 2;
    if (s.min[0] > 0 || s.max[0] < 0 || s.min[2] > 0 || s.max[2] < 0 || Math.hypot(cx, cz) > 0.35 * ext + 0.05)
      bad(id, '原点不在水平中心附近（包围盒中心 ' + cx.toFixed(2) + ', ' + cz.toFixed(2) + '，宽 ' + ext.toFixed(2) + '）');
    // 没有未应用的变换：只有一个网格节点、本身和父级都是单位矩阵
    if (s.meshNodes.length !== 1) bad(id, '网格节点 ' + s.meshNodes.length + ' 个，应为 1 个');
    for (const n of s.meshNodes) {
      if (!isIdentity(n.world)) bad(id, '节点 ' + n.name + ' 带未应用的变换（位置 / 旋转 / 缩放要应用进顶点）');
      const nm = id.replace('/', '_');
      if (n.name !== nm) bad(id, '节点名 ' + n.name + '，应为 ' + nm);
    }
    // 顶点属性
    for (const k of budgets.requiredAttributes) if (!s.attrs.includes(k) && !(cat.rigged && k === 'COLOR_0')) bad(id, '缺顶点属性 ' + k); // 角色可以不带烘焙的顶点色
    // 骨骼（占位）：带蒙皮的件只能是角色类，骨骼名都要在标准骨架表里
    if (s.bones.length) {
      if (!cat.rigged) bad(id, '带蒙皮，但类别 ' + a.category + ' 不是角色类');
      const std = new Set(rig.standard.bones || []);
      if (!std.size) bad(id, '带蒙皮，但标准骨架的骨骼名表（art/rig.json）还是空的');
      else for (const b of s.bones) if (!std.has(b)) bad(id, '骨骼 ' + b + ' 不在标准骨架 ' + rig.standard.name + ' 里');
    } else if (cat.rigged) bad(id, '角色类的件没有蒙皮');
    // 清单和实测一致
    if (a.tris !== s.tris) bad(id, '清单 tris ' + a.tris + ' ≠ 实测 ' + s.tris);
    if (Math.abs(a.h - h) > 0.002) bad(id, '清单高度 ' + a.h + ' ≠ 实测 ' + h.toFixed(3));
    if (!a.source || !a.source.script || a.source.seed === undefined) bad(id, '清单缺来源脚本 / 种子');
    // 上线的件确实打进了 kit-<区> 包、且就是这一份
    if (a.ship) {
      const pk = packOf(a.zone);
      if (!pk || !pk[id]) bad(id, 'ship 的件不在 js/assets/kit-' + a.zone + '.js 里（重新跑 node tools/pack-assets.mjs）');
      else if (Buffer.from(pk[id], 'base64').compare(buf) !== 0) bad(id, 'js/assets/kit-' + a.zone + '.js 里的这件和 GLB 不一致（重新打包）');
    }
  }
  return { fails, rows, count: man.assets.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { fails, rows } = checkArt();
  for (const r of rows)
    console.log(r.id.padEnd(22), (r.cat + (r.ship ? '' : '*')).padEnd(9), String(r.tris).padStart(5) + ' / ' + String(r.budget).padEnd(6), 'h ' + r.h.toFixed(2).padStart(5), 'r ' + r.r.toFixed(2).padStart(5), 'mat ' + r.mats, 'tex ' + r.tex);
  console.log('（* = 备选件，没打进游戏）');
  if (fails.length) {
    for (const f of fails) console.error('check-art FAIL ' + f);
    process.exit(1);
  }
  console.log('check-art ok：' + rows.length + ' 件');
}
