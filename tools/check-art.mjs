// 自产素材检查（只用 Node，不需要 Blender）：assets/ca/manifest.json 里的每个 GLB 都要符合 docs/art-style.md 的规矩。
//   node tools/check-art.mjs        → 逐件打印，有问题以非 0 退出（每条问题都带件的 id）
// npm test 的第一步也会调用 checkArt()（test/smoke.mjs）；贴图的检查在 tools/check-textures.mjs（tex-t2），命令行和 test:func 的下一步都会跑。预算在 art/budgets.json，骨骼名表在 art/rig.json。
// 查的项目：文件在、和清单的 sha256 一致（防止改了生成器忘了提交生成物 / 清单）；三角形数在类别预算内；材质 / 贴图数；
// 只用共享调色板图集；高度在类别的合理范围（抓单位错）；原点在底面中心；没有未应用的节点变换；命名；必备的顶点属性；
// 带蒙皮的件骨骼名都在标准骨架表里（占位：表还是空的）；清单里的尺寸和 GLB 实测一致；打包进游戏的件确实在对应的包里。
// 首领（boss）：id = ca/boss_<kind>、文件 assets/ca/boss/<kind>.glb；骨骼和 art/rig.json 的 boss.kinds.<kind> 是同一组（导出器按层级排顺序）、不超过 40 根；
// 每个顶点最多 4 根骨骼、权重和为 1；每段动作带参数（extras 的 dur）；js/assets/boss-<kind>.js 里的就是从这份 GLB 打出来的（重新打包逐字节相同）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readGlb, stats, isIdentity, bakedMean, bakeGeo, packBoss, bossEntry, accessor, bossRows } from './glb.mjs';

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
  // 首领包：js/assets/boss-<kind>.js 里的 boss.<kind>
  const bossPackOf = (kind) => {
    const f = path.join(root, 'js/assets/boss-' + kind + '.js');
    if (!fs.existsSync(f)) return null;
    const src = fs.readFileSync(f, 'utf8');
    return (JSON.parse(src.slice(src.indexOf('= {') + 2, src.lastIndexOf(';'))).boss || {})[kind] || null;
  };
  const packOf = (zone) => {
    if (packed[zone] !== undefined) return packed[zone];
    const f = path.join(root, 'js/assets/kit-' + zone + '.js');
    if (!fs.existsSync(f)) return (packed[zone] = null);
    const src = fs.readFileSync(f, 'utf8');
    return (packed[zone] = JSON.parse(src.slice(src.indexOf('= {') + 2, src.lastIndexOf(';'))).geo || {}); // 打包时预烘焙的几何体（tools/pack-assets.mjs）
  };
  for (const a of man.assets) {
    const id = a.id || '(无 id)';
    if (ids.has(id)) bad(id, 'id 重复');
    ids.add(id);
    // 命名：ca/<区>_<物件>[_变体]，小写字母 / 数字 / 下划线；文件 = assets/ca/<区>/<id 去掉 ca/>.glb
    const isBoss = a.category === 'boss', kind = isBoss ? id.replace(/^ca\/boss_/, '') : null;
    if (!/^ca\/[a-z]+_[a-z0-9]+(_[a-z0-9]+)*$/.test(id)) bad(id, 'id 不合命名规则 ca/<区>_<物件>[_变体]（小写、下划线）');
    else if (id.slice(3, 3 + a.zone.length + 1) !== a.zone + '_') bad(id, 'id 的区域前缀和 zone 字段（' + a.zone + '）不一致');
    if (isBoss && a.zone !== 'boss') bad(id, '首领的 zone 应为 boss');
    const want = isBoss ? 'assets/ca/boss/' + kind + '.glb' : 'assets/ca/' + a.zone + '/' + id.slice(3) + '.glb';
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
    let lum = NaN;
    try {
      lum = bakedMean(g).lum;
    } catch (e) {
      bad(id, '算不出烘焙后的平均颜色：' + e.message);
    }
    rows.push({ id, cat: a.category, tris: s.tris, budget: cat.tris, h, r, mats: s.materials, tex: s.textures, ship: a.ship, lum });
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
    // 首领：骨骼表、骨骼数、权重、动作参数、首领包
    if (isBoss) {
      const want = ((rig.boss || {}).kinds || {})[kind];
      if (!want) bad(id, 'art/rig.json 的 boss.kinds 里没有 ' + kind);
      else if (s.bones.slice().sort().join() !== want.slice().sort().join() || new Set(s.bones).size !== s.bones.length) bad(id, '骨骼和 art/rig.json 的 boss.kinds.' + kind + ' 不一致：' + s.bones.join(','));
      if (s.bones.length > (cat.bones || 40) || s.bones.length > (rig.boss.maxBones || 40)) bad(id, '骨骼 ' + s.bones.length + ' 根，上限 ' + (cat.bones || 40));
      const pat = new RegExp(rig.boss.pattern), hum = new Set(rig.boss.humanoid);
      for (const b of s.bones) if (!hum.has(b) && !pat.test(b)) bad(id, '骨骼名 ' + b + ' 不合首领的命名规则（' + rig.boss.grammar.slice(0, 40) + '…）');
      if (s.bones[0] !== 'pelvis') bad(id, '根骨骼应为 pelvis');
      const pr = g.json.meshes[0].primitives[0];
      if (pr.attributes.WEIGHTS_0 === undefined || pr.attributes.JOINTS_1 !== undefined) bad(id, '权重：要有 WEIGHTS_0，且每个顶点最多 ' + (cat.weights || 4) + ' 根骨骼（不许有 JOINTS_1）');
      else {
        let worst = 0;
        for (const w of accessor(g, pr.attributes.WEIGHTS_0)) worst = Math.max(worst, Math.abs(w[0] + w[1] + w[2] + w[3] - 1));
        if (worst > 2 / 255) bad(id, '有顶点的权重和不是 1（最多差 ' + worst.toFixed(4) + '）');
      }
      const anims = g.json.animations || [];
      for (const an of anims) if (!an.extras || !(an.extras.dur > 0)) bad(id, '动作 ' + an.name + ' 缺参数（extras.dur）');
      for (const need of ['idle', 'walk', 'broken', 'hit', 'death', 'mood']) if (!anims.some((x) => x.name === need)) bad(id, '缺动作 ' + need);
      a.bones = s.bones.length;
      if (a.ship) {
        const e = bossPackOf(kind);
        if (!e) bad(id, '上线的首领不在 js/assets/boss-' + kind + '.js 里（重新跑 node tools/pack-assets.mjs）');
        else if (e.sha !== a.sha256) bad(id, 'js/assets/boss-' + kind + '.js 不是从当前 GLB 打的包（重新打包）');
        else if (JSON.stringify(e) !== JSON.stringify(bossEntry(a.sha256, packBoss(g, bossRows(g))))) bad(id, 'js/assets/boss-' + kind + '.js 里的数组和重新打包的不一致（重新打包）');
      }
    }
    // 骨骼（占位）：带蒙皮的件只能是角色类，骨骼名都要在标准骨架表里（首领按上面 boss 的表查）
    if (s.bones.length && !isBoss) {
      if (!cat.rigged) bad(id, '带蒙皮，但类别 ' + a.category + ' 不是角色类');
      const std = new Set(rig.standard.bones || []);
      if (!std.size) bad(id, '带蒙皮，但标准骨架的骨骼名表（art/rig.json）还是空的');
      else for (const b of s.bones) if (!std.has(b)) bad(id, '骨骼 ' + b + ' 不在标准骨架 ' + rig.standard.name + ' 里');
    } else if (cat.rigged && !s.bones.length) bad(id, '角色类的件没有蒙皮');
    // 清单和实测一致
    if (a.tris !== s.tris) bad(id, '清单 tris ' + a.tris + ' ≠ 实测 ' + s.tris);
    if (Math.abs(a.h - h) > 0.002) bad(id, '清单高度 ' + a.h + ' ≠ 实测 ' + h.toFixed(3));
    if (!a.source || !a.source.script || a.source.seed === undefined) bad(id, '清单缺来源脚本 / 种子');
    // 上线的件确实打进了 kit-<区> 包、且就是这一份（首领见上面的首领包）
    if (a.ship && !isBoss) {
      const pk = packOf(a.zone);
      if (!pk || !pk[id]) bad(id, 'ship 的件不在 js/assets/kit-' + a.zone + '.js 里（重新跑 node tools/pack-assets.mjs）');
      else {
        // 包里是从这份 GLB 预烘焙的几何体：sha 和清单一致，重新烘焙一遍逐字节相同
        const e = pk[id], b = bakeGeo(g), b64 = (f) => (f ? Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64') : undefined);
        if (e.sha !== a.sha256) bad(id, 'js/assets/kit-' + a.zone + '.js 里的这件不是从当前 GLB 烘焙的（重新打包）');
        else if (e.n !== b.count || e.p !== b64(b.pos) || e.nn !== b64(b.nor) || e.c !== b64(b.col) || e.g !== b64(b.glow)) bad(id, 'js/assets/kit-' + a.zone + '.js 里的几何体和重新烘焙的不一致（重新打包）');
      }
    }
  }
  checkAiHero(budgets, bad);
  return { fails, rows, count: man.assets.length };
}

// AI 生成的主角（ai3d-hero）：assets/ai/hero/hero.glb（高 / 中）、hero_lo.glb（低）。和来源记录里的 sha256 一致；三角形在 hero 预算内，
// 低档不比 Adventurer 重；材质 / 贴图数、高度；带蒙皮、骨骼是同一组 UE / UAL 名、每个顶点最多 4 根骨骼且权重和为 1；
// js/assets/chars.js 里的 aihero_hi / aihero_lo 就是这两份文件（重新打包逐字节相同）
function checkAiHero(budgets, bad) {
  const dir = path.join(root, 'assets/ai/hero');
  if (!fs.existsSync(path.join(dir, 'provenance.json'))) return;
  const cat = budgets.categories.hero, prov = JSON.parse(fs.readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
  const charsSrc = fs.readFileSync(path.join(root, 'js/assets/chars.js'), 'utf8');
  const chars = JSON.parse(charsSrc.slice(charsSrc.indexOf('= {') + 2, charsSrc.lastIndexOf(';')));
  const adv = stats(readGlb(path.join(root, 'assets/quaternius-modular-men/Adventurer.glb')));
  let bones0 = null;
  for (const [fn, key] of [['hero.glb', 'aihero_hi'], ['hero_lo.glb', 'aihero_lo']]) {
    const id = 'ai/hero/' + fn, f = path.join(dir, fn);
    if (!fs.existsSync(f)) { bad(id, '文件不在'); continue; }
    const buf = fs.readFileSync(f), sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (!prov.outputs || prov.outputs[fn] !== sha) bad(id, 'sha256 和 provenance.json 记的不一致（重新生成以后要一起更新来源记录）');
    if (!chars.models || chars.models[key] !== buf.toString('base64')) bad(id, 'js/assets/chars.js 里的 ' + key + ' 不是这份文件（重新跑 node tools/pack-assets.mjs）');
    const g = readGlb(buf), s = stats(g), h = s.max[1] - s.min[1];
    if (s.tris > cat.tris) bad(id, '三角形 ' + s.tris + ' 超过 hero 预算 ' + cat.tris);
    if (key === 'aihero_lo' && s.tris > adv.tris) bad(id, '低档 ' + s.tris + ' 个三角形，比 Adventurer（' + adv.tris + '）重');
    if (s.materials > cat.materials) bad(id, '材质 ' + s.materials + ' 个，超过 ' + cat.materials);
    if (s.textures > cat.textures) bad(id, '贴图 ' + s.textures + ' 张，超过 ' + cat.textures);
    if (h < cat.h[0] || h > cat.h[1]) bad(id, '高度 ' + h.toFixed(3) + ' 不在 ' + cat.h.join('–'));
    if (!s.bones.length) bad(id, '没有蒙皮');
    const bs = s.bones.slice().sort().join(',');
    if (bones0 === null) bones0 = bs;
    else if (bs !== bones0) bad(id, '高 / 低两档的骨骼不是同一组');
    for (const need of ['pelvis', 'spine_02', 'spine_03', 'neck_01', 'Head', 'upperarm_l', 'lowerarm_l', 'hand_l', 'middle_01_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'middle_01_r', 'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r'])
      if (s.bones.indexOf(need) < 0) bad(id, '缺骨骼 ' + need + '（world.js 的 playerAI 要用）');
    for (const pr of g.json.meshes[0].primitives) {
      const W = accessor(g, pr.attributes.WEIGHTS_0);
      let over = 0, sum = 0;
      for (const w of W) {
        if (w.filter((x) => x > 0).length > 4) over++;
        if (Math.abs(w.reduce((a, b) => a + b, 0) - 1) > 0.006) sum++;
      }
      if (over) bad(id, over + ' 个顶点超过 4 根骨骼');
      if (sum) bad(id, sum + ' 个顶点权重和不是 1');
      if (pr.attributes.COLOR_0 === undefined) bad(id, '没有 COLOR_0（一角一色）');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { fails, rows } = checkArt();
  // tex-t2：贴图（程序化贴图的像素清单、尺寸、值域、频率、每区每档的显存，见 tools/check-textures.mjs）
  const { checkTextures } = await import('./check-textures.mjs');
  const tx = await checkTextures();
  for (const z of tx.zones) console.log('贴图显存 ' + z.zone.padEnd(6), '高 ' + z.mb.high.toFixed(1), '中 ' + z.mb.mid.toFixed(1), '低 ' + z.mb.low.toFixed(1) + ' MB' + (z.legacy ? '（legacy 封顶）' : ''));
  fails.push(...tx.fails);
  for (const r of rows)
    console.log(r.id.padEnd(22), (r.cat + (r.ship ? '' : '*')).padEnd(9), String(r.tris).padStart(5) + ' / ' + String(r.budget).padEnd(6), 'h ' + r.h.toFixed(2).padStart(5), 'r ' + r.r.toFixed(2).padStart(5), 'mat ' + r.mats, 'tex ' + r.tex, '亮度 ' + r.lum.toFixed(3));
  console.log('（* = 备选件，没打进游戏；亮度 = 烘焙后的面积加权平均线性亮度，口径见 docs/art-style.md 的调色板一节）');
  if (fails.length) {
    for (const f of fails) console.error('check-art FAIL ' + f);
    process.exit(1);
  }
  console.log('check-art ok：' + rows.length + ' 件，贴图 ' + tx.rows.length + ' 套');
}
