// 贴图检查（tex-t2，设计稿 tex-design §3.3；只用 Node）：tools/check-art.mjs 的 checkArt() 调它，npm test 的第一步也就查了。
//   1. 程序化贴图的清单 assets/generated/manifest.json：每张打进包的图都有条目；用 tools/ground-tex.mjs 重新算像素，RGBA8 的 sha256 和清单一致
//      （改了生成器忘了重新生成 / 手改了图）；仓库里 JPEG 的 sha256 和字节数和清单一致（JPEG 的重新编码要 Chrome，只在 gen-ground-textures.mjs 里做）。
//   2. 尺寸：读 JPEG 文件头，边长是 2 的幂、不超过 art/budgets.json 里这一类的 maxPx；低档实际上传的边长不超过 lowPx（lo 变体看 lo，skipLow 算 0）。
//   3. 值域：程序化贴图的反照率亮度的平均和 p5–p95 跨度在这一类的 value 区间里。
//   4. 频率：反照率亮度减去 2×2 平均的残差均方根不超过这一类的 hf（游戏镜头下闪不闪的离线代理）。
//   5. 显存：按 js/world.js 的 ZONE_GFX 每个区要的包，算每区、每档上传的贴图显存（RGBA8 + mipmap），不超过 zoneGpuMB；
//      还在用照片的区按 legacy 封顶，封顶比实算高出 0.5 MB 以上也算失败（区变省了就把封顶跟着降下来，只许降不许升）。
//   另外：区域包里的每套贴图 js/world.js 里都要用到（打进包、解码了却不用的贴图白占下载和内存，比如 tex-t2 去掉的 Lava001）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TIERS = ['high', 'mid', 'low'];
const KINDS = ['albedo', 'normal', 'arh'];

// JPEG 文件头里的宽高（SOF0–SOF15，除了 DHT / JPG / DAC）
export function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
const gpuMB = (s) => (s ? (s.w * s.h * 4 * 4) / 3 / 1048576 : 0);
const pow2 = (n) => n > 0 && (n & (n - 1)) === 0;

// 反照率亮度（显示值，Rec.709）的平均、p5、p95 和 2×2 残差（0–255）
export function lumStats(u, N) {
  const L = new Float32Array(N * N);
  let sum = 0;
  for (let i = 0; i < N * N; i++) sum += L[i] = (0.2126 * u[i * 4] + 0.7152 * u[i * 4 + 1] + 0.0722 * u[i * 4 + 2]) / 255;
  const s = Float32Array.from(L).sort();
  let r2 = 0;
  for (let y = 0; y < N; y += 2)
    for (let x = 0; x < N; x += 2) {
      const a = L[y * N + x], b = L[y * N + x + 1], c = L[(y + 1) * N + x], d = L[(y + 1) * N + x + 1], m = (a + b + c + d) / 4;
      r2 += (a - m) ** 2 + (b - m) ** 2 + (c - m) ** 2 + (d - m) ** 2;
    }
  return { mean: sum / (N * N), p5: s[Math.floor(0.05 * s.length)], p95: s[Math.floor(0.95 * s.length)], hf: Math.sqrt(r2 / (N * N)) * 255 };
}

// js/world.js 的 ZONE_GFX：区 → 包（余烛殿 crown 沿用 abyss 的包）
export function zonePacks() {
  const src = fs.readFileSync(path.join(root, 'js/world.js'), 'utf8');
  const at = src.indexOf('const ZONE_GFX = {');
  const out = {};
  const re = /\n {4}([a-z]+): \{\n {6}packs: \[([^\]]*)\]/g;
  re.lastIndex = at;
  let m;
  while ((m = re.exec(src)) && m.index < at + 40000) out[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  return { packs: out, src };
}

export async function checkTextures() {
  const budgets = rd('art/budgets.json').textures, sources = rd('tools/asset-sources.json');
  const manFile = path.join(root, 'assets/generated/manifest.json');
  const man = fs.existsSync(manFile) ? rd('assets/generated/manifest.json') : { textures: {} };
  const fails = [], rows = [], zones = [];
  const bad = (id, msg) => fails.push('贴图 ' + id + '：' + msg);
  if (!budgets) return { fails: ['art/budgets.json 缺 textures'], rows, zones };
  const packed = new Set();
  for (const pk of Object.values(sources.packs)) for (const id of pk.textures || []) packed.add(id);
  let gen = null;
  const genJobs = async () => gen || (gen = await import('./ground-tex.mjs'));
  const info = {}; // id → { full: {kind: size}, lo: {kind: size} | null, skip }
  for (const id of [...packed].sort()) {
    const t = sources.textures[id];
    if (!t) {
      bad(id, '打进了包，但 tools/asset-sources.json 的 textures 里没有');
      continue;
    }
    const cls = t.class || (t.src === 'generated' ? 'tile' : 'photo'), C = budgets.classes[cls];
    if (!C) {
      bad(id, '未知的贴图类 ' + cls);
      continue;
    }
    const kinds = t.kinds || KINDS, dir = path.join(root, 'assets', t.src, id);
    const size = {}, lo = t.lo ? {} : null, files = {};
    for (const k of kinds) {
      const f = path.join(dir, k + '.jpg');
      if (!fs.existsSync(f)) {
        bad(id, '缺 ' + path.relative(root, f));
        continue;
      }
      files[k] = fs.readFileSync(f);
      size[k] = jpegSize(files[k]);
      if (!size[k]) bad(id, k + '.jpg 读不出尺寸');
    }
    if (lo)
      for (const k of t.loKinds || kinds) {
        const f = path.join(dir, 'lo', k + '.jpg');
        if (!fs.existsSync(f)) bad(id, '缺低档小图 ' + path.relative(root, f));
        else lo[k] = jpegSize((files['lo/' + k] = fs.readFileSync(f)));
      }
    info[id] = { full: size, lo, skip: !!t.skipLow };
    // 2. 尺寸
    for (const [k, s] of Object.entries(size)) {
      if (!s) continue;
      if (!pow2(s.w) || !pow2(s.h)) bad(id, k + ' 边长 ' + s.w + '×' + s.h + ' 不是 2 的幂');
      if (Math.max(s.w, s.h) > C.maxPx) bad(id, k + ' 边长 ' + Math.max(s.w, s.h) + '，' + cls + ' 类上限 ' + C.maxPx);
    }
    const lowSet = t.skipLow ? {} : lo || size;
    for (const [k, s] of Object.entries(lowSet)) if (s && Math.max(s.w, s.h) > C.lowPx) bad(id, '低档上传 ' + k + ' 边长 ' + Math.max(s.w, s.h) + '，' + cls + ' 类低档上限 ' + C.lowPx + '（加 lo 变体或 skipLow）');
    if (lo && C.lowNormal === false && lo.normal) bad(id, cls + ' 类的低档不带法线（lo 里去掉 normal）');
    if (t.lo && t.skipLow) bad(id, 'lo 和 skipLow 只能选一个');
    // 1. 程序化贴图：清单、像素、JPEG
    const row = { id, cls, px: size.albedo ? size.albedo.w : 0, lo: lo && lo.albedo ? lo.albedo.w : t.skipLow ? 0 : null };
    if (t.src === 'generated') {
      const e = man.textures[id];
      const { JOBS, rgba8, sha256 } = await genJobs();
      if (!e) bad(id, 'assets/generated/manifest.json 里没有（跑 node tools/gen-ground-textures.mjs）');
      else if (!JOBS[id]) bad(id, 'tools/ground-tex.mjs 里没有它的生成函数');
      else {
        const set3 = JOBS[id].make();
        if (e.px !== set3.albedo.N || (size.albedo && size.albedo.w !== e.px)) bad(id, '清单边长 ' + e.px + '、生成器 ' + set3.albedo.N + '、JPEG ' + (size.albedo && size.albedo.w) + ' 对不上');
        for (const k of kinds) {
          const me = e.maps && e.maps[k];
          if (!me) {
            bad(id, '清单里缺通道 ' + k);
            continue;
          }
          if (sha256(rgba8(set3[k])) !== me.pix) bad(id, k + ' 重新算的像素和清单的 sha256 不一致（改了 tools/ground-tex.mjs 没重新生成？）');
          if (files[k] && (sha(files[k]) !== me.jpg || files[k].length !== me.bytes)) bad(id, k + '.jpg 和清单的 sha256 / 字节数不一致（手改了图？）');
        }
        for (const k of Object.keys(e.maps || {})) if (!kinds.includes(k)) bad(id, '清单里多了没打包的通道 ' + k);
        if (lo) {
          if (!e.lo) bad(id, '有 lo 变体，清单里缺 lo');
          else
            for (const k of Object.keys(lo)) {
              const me = e.lo.maps && e.lo.maps[k];
              if (!me) bad(id, '清单的 lo 里缺通道 ' + k);
              else if (sha(files['lo/' + k]) !== me.jpg) bad(id, 'lo/' + k + '.jpg 和清单的 sha256 不一致');
              else if (JOBS[id].lo && sha256(rgba8(JOBS[id].lo()[k])) !== me.pix) bad(id, 'lo/' + k + ' 重新算的像素和清单不一致');
            }
        }
        // 3. 值域、4. 频率（反照率）
        const st = lumStats(rgba8(set3.albedo), set3.albedo.N);
        Object.assign(row, { mean: st.mean, span: st.p95 - st.p5, hf: st.hf });
        if (C.value) {
          const [lo0, hi0, span] = C.value;
          if (st.mean < lo0 || st.mean > hi0) bad(id, '反照率平均亮度 ' + st.mean.toFixed(3) + ' 不在 ' + cls + ' 类的 ' + lo0 + '–' + hi0);
          if (st.p95 - st.p5 > span) bad(id, '反照率 p5–p95 跨度 ' + (st.p95 - st.p5).toFixed(3) + '，' + cls + ' 类上限 ' + span);
        }
        if (C.hf !== undefined && st.hf > C.hf) bad(id, '反照率 2×2 残差 ' + st.hf.toFixed(2) + '，' + cls + ' 类上限 ' + C.hf + '（高频细节太多，游戏镜头下会闪）');
      }
    }
    rows.push(row);
  }
  for (const id of Object.keys(man.textures || {})) if (!packed.has(id)) bad(id, '在 assets/generated/manifest.json 里，但没有打进任何包');
  // 5. 每区、每档的显存
  const { packs: ZP, src } = zonePacks();
  const zIds = Object.keys(ZP);
  if (zIds.length < 5) fails.push('贴图：js/world.js 的 ZONE_GFX 里只认出 ' + zIds.length + ' 个区（packs 那一行的写法变了？）');
  for (const z of zIds) {
    const ids = new Set();
    for (const p of ZP[z]) {
      if (!sources.packs[p]) fails.push('贴图：' + z + ' 区要的包 ' + p + ' 不在 tools/asset-sources.json 里');
      else for (const id of sources.packs[p].textures || []) ids.add(id);
    }
    const mb = {};
    let photo = false;
    for (const tier of TIERS) {
      mb[tier] = 0;
      for (const id of ids) {
        const I = info[id];
        if (!I) continue;
        const set = tier === 'low' ? (I.skip ? {} : I.lo || I.full) : I.full;
        for (const s of Object.values(set)) mb[tier] += gpuMB(s);
        if ((sources.textures[id].class || (sources.textures[id].src === 'generated' ? 'tile' : 'photo')) === 'photo') photo = true;
      }
    }
    const L = budgets.legacy && budgets.legacy[z];
    for (const tier of TIERS) {
      const cap = L ? L[tier] : budgets.zoneGpuMB[tier];
      if (mb[tier] > cap + 1e-6) fails.push('贴图：' + z + ' 区' + tier + '档显存 ' + mb[tier].toFixed(1) + ' MB，上限 ' + cap + (L ? '（legacy 封顶）' : ''));
      else if (L && cap - mb[tier] > 0.5) fails.push('贴图：' + z + ' 区' + tier + '档实算 ' + mb[tier].toFixed(1) + ' MB，legacy 封顶 ' + cap + ' 高出 0.5 MB 以上：把 art/budgets.json 的封顶降到实算（只许降）');
    }
    if (L && !photo) fails.push('贴图：' + z + ' 区已经没有照片贴图，删掉 art/budgets.json 的 legacy.' + z + '，改按 zoneGpuMB 查');
    zones.push({ zone: z, packs: ZP[z], mb, legacy: !!L });
    // 区域包里的贴图都要用到
    for (const id of ids) if (src.indexOf("'" + id + "'") < 0) fails.push('贴图：' + id + ' 打进了 ' + z + ' 区的包，但 js/world.js 里没用到（白占下载和内存）');
  }
  return { fails, rows, zones };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const r = await checkTextures();
  for (const x of r.rows) console.log(x.id.padEnd(22), x.cls.padEnd(7), String(x.px).padStart(5), 'lo ' + String(x.lo).padStart(4), x.mean !== undefined ? '亮度 ' + x.mean.toFixed(3) + ' 跨度 ' + x.span.toFixed(3) + ' hf ' + x.hf.toFixed(2) : '');
  for (const z of r.zones) console.log(z.zone.padEnd(7), '高 ' + z.mb.high.toFixed(1), '中 ' + z.mb.mid.toFixed(1), '低 ' + z.mb.low.toFixed(1) + ' MB', z.legacy ? '(legacy)' : '', z.packs.join(' '));
  for (const f of r.fails) console.error('check-textures FAIL ' + f);
  console.log((r.fails.length ? 'check-textures 失败 ' + r.fails.length + ' 项' : 'check-textures ok') + '（' + ((Date.now() - t0) / 1000).toFixed(1) + ' s）');
  if (r.fails.length) process.exit(1);
}
