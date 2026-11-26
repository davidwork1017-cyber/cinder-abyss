// 极简 GLB 读取器（只用 Node 自带模块）：给 tools/check-art.mjs 和统计脚本用，不进游戏。
// 读出 JSON 块和 BIN 块，按访问器取顶点 / 索引，算三角形数、包围盒（套上节点变换后的世界坐标）。
import fs from 'node:fs';

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGlb(fileOrBuf) {
  const buf = Buffer.isBuffer(fileOrBuf) ? fileOrBuf : fs.readFileSync(fileOrBuf);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  return { json, bin, bytes: buf.length };
}

// 访问器 → 普通数组（每个元素一个分量数组）；归一化整数按 glTF 规则换成 0–1
export function accessor(g, i) {
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView];
  const [Arr, size] = COMP[a.componentType], n = NCOMP[a.type];
  const stride = bv.byteStride || size * n, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Array(a.count);
  const maxv = a.normalized ? { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType] : 1;
  for (let k = 0; k < a.count; k++) {
    const v = new Array(n);
    for (let c = 0; c < n; c++) {
      const at = g.bin.byteOffset + base + k * stride + c * size;
      v[c] = new Arr(g.bin.buffer.slice(at, at + size))[0] / maxv;
    }
    out[k] = v;
  }
  return out;
}

const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
export const isIdentity = (m) => m.every((v, i) => Math.abs(v - I4[i]) < 1e-6);

// 统计：三角形数、顶点数、材质 / 贴图数、世界坐标包围盒、各网格节点（名字、局部变换）、骨骼名
export function stats(g) {
  const j = g.json, out = { tris: 0, verts: 0, materials: (j.materials || []).length, textures: (j.textures || []).length, images: (j.images || []).length, meshNodes: [], bones: [], attrs: new Set(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const s of j.skins || []) for (const ji of s.joints) out.bones.push(j.nodes[ji].name || '');
  const walk = (ni, parent) => {
    const n = j.nodes[ni], m = mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) {
      out.meshNodes.push({ name: n.name || '', mesh: j.meshes[n.mesh].name || '', local: nodeMatrix(n), world: m });
      for (const p of j.meshes[n.mesh].primitives) {
        Object.keys(p.attributes).forEach((k) => out.attrs.add(k));
        const pos = accessor(g, p.attributes.POSITION);
        out.verts += pos.length;
        out.tris += (p.indices !== undefined ? j.accessors[p.indices].count : pos.length) / 3;
        for (const v of pos) {
          const w = [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
          for (let k = 0; k < 3; k++) {
            out.min[k] = Math.min(out.min[k], w[k]);
            out.max[k] = Math.max(out.max[k], w[k]);
          }
        }
      }
    }
    for (const c of n.children || []) walk(c, m);
  };
  const sc = j.scenes[j.scene || 0];
  for (const ni of sc.nodes) walk(ni, I4);
  out.attrs = [...out.attrs].sort();
  return out;
}

// ---------- 烘焙后的平均颜色（和游戏 js/assets.js 的 bakeGltf 同口径：底色贴图按 UV 取色 × baseColorFactor × COLOR_0） ----------
import zlib from 'node:zlib';
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
// 8 位 PNG（灰度 / 灰度 + α / RGB / RGBA，非隔行）解码成原始像素
export function decodePng(buf) {
  let o = 8, w, h, ct, bd, il;
  const idat = [];
  while (o < buf.length) {
    const L = buf.readUInt32BE(o), t = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + L);
    if (t === 'IHDR') [w, h, bd, ct, il] = [d.readUInt32BE(0), d.readUInt32BE(4), d[8], d[9], d[12]];
    if (t === 'IDAT') idat.push(d);
    o += 12 + L;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (bd !== 8 || !bpp || il) throw new Error('只支持 8 位非隔行的灰度 / RGB / RGBA PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, out = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)], line = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1));
    for (let x = 0; x < st; x++) {
      const a = x >= bpp ? out[y * st + x - bpp] : 0, b = y ? out[(y - 1) * st + x] : 0, c = x >= bpp && y ? out[(y - 1) * st + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * st + x] = v & 255;
    }
  }
  return { w, h, bpp, d: out };
}
// 面积加权的平均线性颜色和亮度（每个三角形取第一个顶点的颜色，游戏里是平直着色、一面一色）
export function bakedMean(g) {
  const j = g.json, acc = [0, 0, 0];
  let A = 0;
  for (const mesh of j.meshes)
    for (const p of mesh.primitives) {
      const pbr = ((j.materials || [])[p.material] || {}).pbrMetallicRoughness || {}, bf = pbr.baseColorFactor || [1, 1, 1, 1];
      let im = null;
      if (pbr.baseColorTexture) {
        const bv = j.bufferViews[j.images[j.textures[pbr.baseColorTexture.index].source].bufferView];
        im = decodePng(g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
      }
      const P = accessor(g, p.attributes.POSITION);
      const U = p.attributes.TEXCOORD_0 !== undefined ? accessor(g, p.attributes.TEXCOORD_0) : null;
      const C = p.attributes.COLOR_0 !== undefined ? accessor(g, p.attributes.COLOR_0) : null;
      const I = p.indices !== undefined ? accessor(g, p.indices).map((v) => v[0]) : P.map((_, i) => i);
      for (let t = 0; t < I.length; t += 3) {
        const [a, b, c] = [P[I[t]], P[I[t + 1]], P[I[t + 2]]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const ar = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
        const i0 = I[t];
        let col = [bf[0], bf[1], bf[2]];
        if (im && U) {
          let uu = U[i0][0], vv = U[i0][1];
          uu -= Math.floor(uu);
          vv -= Math.floor(vv);
          const k = (Math.min(im.h - 1, Math.floor(vv * im.h)) * im.w + Math.min(im.w - 1, Math.floor(uu * im.w))) * im.bpp;
          col = col.map((x, q) => x * s2l(im.d[k + Math.min(q, im.bpp - 1)] / 255));
        }
        if (C) col = col.map((x, q) => x * C[i0][q]);
        for (let q = 0; q < 3; q++) acc[q] += col[q] * ar;
        A += ar;
      }
    }
  const m = acc.map((x) => x / (A || 1));
  return { rgb: m, lum: 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] };
}

// ---------- 打包时预烘焙（tools/pack-assets.mjs 用）：和游戏 js/assets.js 的 bakeGltf 逐位一致的几何体 ----------
// 游戏里原来要「解析 GLB → 解码调色板 PNG → 逐顶点烘焙」，进第 0 区前在主线程上做；改成打包时在这里做好，游戏端只把数组拷进 BufferGeometry。
// 算法照搬 bakeGltf：展开索引；位置 / 法线乘节点的世界矩阵（自产件的变换都已应用，check-art 保证是单位矩阵，这里只接受单位矩阵）；
// 法线归一化；颜色 = baseColorFactor × 贴图按 UV 取色（sRGB → 线性）× COLOR_0（归一化整数原值 × 1 / 最大值，和 r128 的 getX 不反归一化一致）；
// aGlow = 1 - COLOR_0 的 α。每一步的运算顺序和 three r128 的 Vector3 / Matrix3 / Matrix4 一样（JS 双精度算、存成 Float32），所以结果逐位相同。
function rawAccessor(g, i) {
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView];
  const [Arr, size] = COMP[a.componentType], n = NCOMP[a.type];
  const stride = bv.byteStride || size * n, base = g.bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Arr(a.count * n), dv = new DataView(g.bin.buffer);
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[get](base + k * stride + c * size, true);
  return { arr: out, n, normalized: !!a.normalized, type: a.componentType };
}
export function bakeGeo(g) {
  const j = g.json, P = [], N = [], C = [], GL = [], U = [];
  const sc = j.scenes[j.scene || 0];
  const walk = (ni) => {
    const nd = j.nodes[ni];
    if (!isIdentity(nodeMatrix(nd)) || nodeMatrix(nd).some((v, i) => v !== I4[i])) throw new Error('预烘焙只接受单位变换的节点：' + (nd.name || ni));
    if (nd.mesh !== undefined)
      for (const p of j.meshes[nd.mesh].primitives) {
        const mat = (j.materials || [])[p.material] || {}, pbr = mat.pbrMetallicRoughness || {}, bf = pbr.baseColorFactor || [1, 1, 1, 1];
        let px = null;
        if (pbr.baseColorTexture) {
          const bv = j.bufferViews[j.images[j.textures[pbr.baseColorTexture.index].source].bufferView];
          const im = decodePng(g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
          if (im.bpp < 3) throw new Error('预烘焙只支持 RGB / RGBA 贴图');
          px = im;
        }
        const pos = rawAccessor(g, p.attributes.POSITION), nor = p.attributes.NORMAL !== undefined ? rawAccessor(g, p.attributes.NORMAL) : null;
        const uv = p.attributes.TEXCOORD_0 !== undefined ? rawAccessor(g, p.attributes.TEXCOORD_0) : null, vc = p.attributes.COLOR_0 !== undefined ? rawAccessor(g, p.attributes.COLOR_0) : null;
        const idx = p.indices !== undefined ? rawAccessor(g, p.indices).arr : null, cnt = idx ? idx.length : pos.arr.length / 3;
        const vcK = vc && vc.normalized ? 1 / (vc.type === 5121 ? 255 : 65535) : 1;
        if (vc && vc.normalized && vc.type !== 5121 && vc.type !== 5123) throw new Error('COLOR_0 只支持 8 / 16 位无符号归一化');
        for (let k = 0; k < cnt; k++) {
          const i = idx ? idx[k] : k;
          // Vector3.applyMatrix4（单位矩阵）：w = 1 / (0x + 0y + 0z + 1)，x' = (1x + 0y + 0z + 0) * w
          const x = pos.arr[i * 3], y = pos.arr[i * 3 + 1], z = pos.arr[i * 3 + 2];
          const w = 1 / (0 * x + 0 * y + 0 * z + 1);
          P.push((1 * x + 0 * y + 0 * z + 0) * w, (0 * x + 1 * y + 0 * z + 0) * w, (0 * x + 0 * y + 1 * z + 0) * w);
          if (nor) {
            // Vector3.applyMatrix3（单位法线矩阵）+ normalize（divideScalar(length() || 1) = multiplyScalar(1 / l)）
            const a = nor.arr[i * 3], b = nor.arr[i * 3 + 1], c = nor.arr[i * 3 + 2];
            let nx = 1 * a + 0 * b + 0 * c, ny = 0 * a + 1 * b + 0 * c, nz = 0 * a + 0 * b + 1 * c;
            const s = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
            nx *= s; ny *= s; nz *= s;
            N.push(nx, ny, nz);
          } else N.push(0, 1, 0);
          let r = bf[0], gg = bf[1], bb = bf[2];
          if (px && uv) {
            let u = uv.arr[i * 2], v = uv.arr[i * 2 + 1];
            u -= Math.floor(u);
            v -= Math.floor(v);
            const X = Math.min(px.w - 1, Math.floor(u * px.w)), Y = Math.min(px.h - 1, Math.floor(v * px.h)), q = (Y * px.w + X) * px.bpp;
            r *= s2l(px.d[q] / 255);
            gg *= s2l(px.d[q + 1] / 255);
            bb *= s2l(px.d[q + 2] / 255);
          }
          if (vc) {
            r *= vc.arr[i * vc.n] * vcK;
            gg *= vc.arr[i * vc.n + 1] * vcK;
            bb *= vc.arr[i * vc.n + 2] * vcK;
          }
          C.push(r, gg, bb);
          U.push(uv ? uv.arr[i * 2] : 0, uv ? uv.arr[i * 2 + 1] : 0); // AI 件（材质 ai_albedo）要带 UV 采样自己的反照率贴图；调色板件的包里不写
          GL.push(vc && vc.n === 4 ? Math.max(0, 1 - vc.arr[i * 4 + 3] * vcK) : 0);
        }
      }
    for (const c of nd.children || []) walk(c);
  };
  for (const ni of sc.nodes) walk(ni);
  return { count: P.length / 3, pos: Float32Array.from(P), nor: Float32Array.from(N), col: Float32Array.from(C), glow: GL.some((k) => k > 0.01) ? Float32Array.from(GL) : null, uv: Float32Array.from(U) };
}

// ---------- AI 件（ai3d-pilot，外观 albedo）的紧凑包：bakeGeo 的结果按 (位置, UV, 颜色) 焊接成带索引的网格 ----------
// 游戏端用平直着色（材质 flatShading，法线在着色器里按面算），所以不存法线；颜色只是烘好的 AO（同一个顶点的各个角相同）。
// 输出 { n: 索引数, p: 顶点位置 Float32 × 3, u: UV Float32 × 2, c: 颜色 Float32 × 3, i: 索引 Uint16 / Uint32 }，顺序 = 第一次出现的顺序（固定）
export function packAi(g) {
  const b = bakeGeo(g), map = new Map(), P = [], U = [], C = [], I = [];
  const f = new Float32Array(1), u32 = new Uint32Array(f.buffer), bits = (x) => ((f[0] = x), u32[0]);
  for (let k = 0; k < b.count; k++) {
    const key = [b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2], b.uv[k * 2], b.uv[k * 2 + 1], b.col[k * 3], b.col[k * 3 + 1], b.col[k * 3 + 2]].map(bits).join(',');
    let v = map.get(key);
    if (v === undefined) {
      v = P.length / 3;
      map.set(key, v);
      P.push(b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2]);
      U.push(b.uv[k * 2], b.uv[k * 2 + 1]);
      C.push(b.col[k * 3], b.col[k * 3 + 1], b.col[k * 3 + 2]);
    }
    I.push(v);
  }
  const verts = P.length / 3;
  return { n: I.length, verts, p: Float32Array.from(P), u: Float32Array.from(U), c: Float32Array.from(C), i: verts < 65536 ? Uint16Array.from(I) : Uint32Array.from(I) };
}

// ---------- AI 武器（ai3d-weapons，外观 fc）的紧凑包：bakeGeo 的结果按 (位置, 颜色, 发光) 焊接成带索引的网格 ----------
// 颜色是逐面的（按件聚成几种色块），同一色块里的角大多能共用顶点；法线不存（游戏端展开成不带索引的三角形、按面重算，平直着色）。
// 输出 { n: 索引数, p: 位置 Float32 × 3, c: 颜色 Float32 × 3, g: 发光 Float32 × 1（没有发光面时为 null）, i: 索引 Uint16 / Uint32 }，顺序 = 第一次出现的顺序（固定）
export function packFc(g) {
  const b = bakeGeo(g), map = new Map(), P = [], C = [], GL = [], I = [];
  const f = new Float32Array(1), u32 = new Uint32Array(f.buffer), bits = (x) => ((f[0] = x), u32[0]);
  for (let k = 0; k < b.count; k++) {
    const gl = b.glow ? b.glow[k] : 0;
    const key = [b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2], b.col[k * 3], b.col[k * 3 + 1], b.col[k * 3 + 2], gl].map(bits).join(',');
    let v = map.get(key);
    if (v === undefined) {
      v = P.length / 3;
      map.set(key, v);
      P.push(b.pos[k * 3], b.pos[k * 3 + 1], b.pos[k * 3 + 2]);
      C.push(b.col[k * 3], b.col[k * 3 + 1], b.col[k * 3 + 2]);
      GL.push(gl);
    }
    I.push(v);
  }
  const verts = P.length / 3;
  return { n: I.length, verts, p: Float32Array.from(P), c: Float32Array.from(C), g: b.glow ? Float32Array.from(GL) : null, i: verts < 65536 ? Uint16Array.from(I) : Uint32Array.from(I) };
}

// ---------- 首领包（boss-golem）：带蒙皮和动作的首领 GLB → 游戏直接用的数组（和布景件的预烘焙一样，游戏端不解析 GLB、不解码调色板） ----------
// 输出一个 JSON 对象（pack-assets 写进 js/assets/boss-<kind>.js，check-art 重新打包一遍逐字节核对）：
//   bones：[[名字, 父骨骼序号, 枢轴 x, y, z], ...]，枢轴 = 绑定姿态里骨骼的位置（glTF 的 Y 朝上 = 游戏的模型空间），父骨骼在前；
//   顶点（焊接后）：p 位置（Float32 × 3）、j 骨骼序号（Uint8 × 4）、w 权重（Uint8 × 4，和 255）；
//   角（每个三角形 3 个）：ci 顶点序号（Uint16）、c 颜色（Uint8 × 4：调色板按 UV 取色（sRGB → 线性）× COLOR_0 的 rgb，再编码回 sRGB 8 位；
//     α = COLOR_0 的 α = 1 - 自发光）、r 每个三角形的调色板行号（Uint8，游戏端按行定表面类型）；
//   clips：{ 名字: { ex: 动作参数（GLB 的 extras）, n: 帧数, ch: { '骨骼.通道': Int16 数组（rx ry rz 弧度、ox oy oz 米，× 8192） } } }。
//     通道值在这里按游戏的关节通道算好（和 world.js 的 cClipKeys 同一套：骨骼的形变矩阵 W · 绑定逆矩阵，乘回枢轴，换成父关节里的局部矩阵，
//     XYZ 欧拉 + 相对静止位置的位移，逐帧去掉 2π 跳变）；恒为 0 的通道不写。
const s2lT = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
// 调色板图集的行数（每行 2 像素高）：首领包按 UV 记行号
export const bossRows = (g) => {
  const im = g.json.images[0], bv = g.json.bufferViews[im.bufferView];
  return g.bin.readUInt32BE((bv.byteOffset || 0) + 20) / 2; // PNG 的 IHDR 高度
};
export const BOSS_Q = 8192; // 通道值的量化：Int16 / 8192（±4 弧度 / 米，精度 0.00012）
const m4mul = (a, b) => { const o = new Float64Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = v; } return o; };
const m4trs = (t, q) => {
  const [x, y, z, w] = q;
  return Float64Array.from([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, t[0], t[1], t[2], 1]);
};
const m4inv = (m) => {
  // 刚体矩阵（旋转 + 平移）的逆
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
  o[15] = 1;
  return o;
};
export function packBoss(g, rows) {
  const j = g.json, prim = j.meshes[0].primitives[0];
  const pbr = (j.materials[prim.material] || {}).pbrMetallicRoughness || {}, bf = pbr.baseColorFactor || [1, 1, 1, 1];
  const ibv = j.bufferViews[j.images[j.textures[pbr.baseColorTexture.index].source].bufferView];
  const px = decodePng(g.bin.subarray(ibv.byteOffset || 0, (ibv.byteOffset || 0) + ibv.byteLength));
  const pos = rawAccessor(g, prim.attributes.POSITION), uv = rawAccessor(g, prim.attributes.TEXCOORD_0), vc = rawAccessor(g, prim.attributes.COLOR_0);
  const jn = rawAccessor(g, prim.attributes.JOINTS_0), wt = rawAccessor(g, prim.attributes.WEIGHTS_0), idx = rawAccessor(g, prim.indices).arr;
  const n = pos.arr.length / 3, vcK = vc.normalized ? 1 / (vc.type === 5121 ? 255 : 65535) : 1;
  const skin = j.skins[0], nb = skin.joints.length, boneOf = new Map(skin.joints.map((ni, i) => [ni, i]));
  // 骨骼：父骨骼（只认骨骼之间的父子关系）、静止 TRS、绑定逆矩阵 → 枢轴
  const parent = new Array(nb).fill(-1);
  skin.joints.forEach((ni, i) => (j.nodes[ni].children || []).forEach((c) => { if (boneOf.has(c)) parent[boneOf.get(c)] = i; }));
  const ibm = rawAccessor(g, skin.inverseBindMatrices).arr, IBM = [], BW = [];
  for (let b = 0; b < nb; b++) { IBM.push(Float64Array.from(ibm.subarray(b * 16, b * 16 + 16))); BW.push(m4inv(IBM[b])); }
  for (let b = 0; b < nb; b++) if (parent[b] >= b) throw new Error('首领骨骼的顺序：父骨骼要在前（' + j.nodes[skin.joints[b]].name + '）');
  const piv = BW.map((m) => [m[12], m[13], m[14]]);
  const bones = skin.joints.map((ni, b) => [j.nodes[ni].name, parent[b], ...piv[b].map((v) => Math.fround(v))]);
  // 顶点：权重量化回 8 位（生成时已是 1/255 的倍数），按（位置, 骨骼, 权重）焊接
  const vkey = new Map(), P = [], J8 = [], W8 = [], remap = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const w = [], jj = [];
    let s = 0, top = 0;
    for (let k = 0; k < 4; k++) {
      const x = wt.normalized ? wt.arr[i * 4 + k] / (wt.type === 5121 ? 255 : 65535) : wt.arr[i * 4 + k];
      w.push(Math.round(x * 255));
      s += w[k];
      if (w[k] > w[top]) top = k;
    }
    w[top] += 255 - s;
    for (let k = 0; k < 4; k++) jj.push(w[k] ? jn.arr[i * 4 + k] : 0);
    const key = pos.arr[i * 3] + ',' + pos.arr[i * 3 + 1] + ',' + pos.arr[i * 3 + 2] + '|' + jj.join(',') + '|' + w.join(',');
    let at = vkey.get(key);
    if (at === undefined) {
      at = P.length / 3;
      vkey.set(key, at);
      P.push(pos.arr[i * 3], pos.arr[i * 3 + 1], pos.arr[i * 3 + 2]);
      J8.push(...jj);
      W8.push(...w);
    }
    remap[i] = at;
  }
  // 角：顶点序号 + 烘焙好的颜色（sRGB 8 位）+ 每个三角形的调色板行
  const nc = idx.length, CI = new Uint16Array(nc), C8 = new Uint8Array(nc * 4), R8 = new Uint8Array(nc / 3);
  if (P.length / 3 > 65535) throw new Error('首领顶点太多（焊接后 ' + P.length / 3 + '）');
  for (let t = 0; t < nc; t++) {
    const i = idx[t];
    CI[t] = remap[i];
    let u = uv.arr[i * 2], v = uv.arr[i * 2 + 1];
    u -= Math.floor(u);
    v -= Math.floor(v);
    const X = Math.min(px.w - 1, Math.floor(u * px.w)), Y = Math.min(px.h - 1, Math.floor(v * px.h)), q = (Y * px.w + X) * px.bpp;
    for (let k = 0; k < 3; k++) C8[t * 4 + k] = Math.round(Math.min(1, Math.max(0, l2s(bf[k] * s2lT(px.d[q + k] / 255) * vc.arr[i * 4 + k] * vcK))) * 255);
    C8[t * 4 + 3] = Math.round(vc.arr[i * 4 + 3] * vcK * 255);
    if (t % 3 === 0) R8[t / 3] = Math.min(rows - 1, Math.floor(Y / (px.h / rows)));
  }
  // 动作 → 游戏的关节通道
  const restT = skin.joints.map((ni) => j.nodes[ni].translation || [0, 0, 0]), restR = skin.joints.map((ni) => j.nodes[ni].rotation || [0, 0, 0, 1]);
  const clips = {};
  for (const a of j.animations || []) {
    const ins = a.channels.map((c) => rawAccessor(g, a.samplers[c.sampler].input).arr);
    const nF = Math.max(...ins.map((x) => x.length));
    const tr = restT.map(() => null), rot = restR.map(() => null);
    a.channels.forEach((c, ci) => {
      const b = boneOf.get(c.target.node);
      if (b === undefined) return;
      const v = rawAccessor(g, a.samplers[c.sampler].output).arr, nk = ins[ci].length, nc2 = c.target.path === 'rotation' ? 4 : 3;
      const at = (f) => Array.from(v.subarray(Math.min(f, nk - 1) * nc2, Math.min(f, nk - 1) * nc2 + nc2));
      if (nk !== nF && nk > 2) throw new Error('首领动作 ' + a.name + '：通道帧数不一致');
      if (c.target.path === 'translation') tr[b] = at;
      else if (c.target.path === 'rotation') rot[b] = at;
      else if (c.target.path === 'scale') for (let f = 0; f < nk; f++) if (at(f).some((x) => Math.abs(x - 1) > 1e-6)) throw new Error('首领动作 ' + a.name + '：骨骼有缩放（游戏端不采缩放）');
    });
    const ch = {};
    const vals = {};
    for (let f = 0; f < nF; f++) {
      const W = [], D = [], M = [];
      for (let b = 0; b < nb; b++) {
        const L = m4trs(tr[b] ? tr[b](f) : restT[b], rot[b] ? rot[b](f) : restR[b]);
        W[b] = parent[b] < 0 ? L : m4mul(W[parent[b]], L);
        D[b] = m4mul(W[b], IBM[b]);
        M[b] = m4mul(D[b], m4trs(piv[b], [0, 0, 0, 1]));
        const Lm = parent[b] < 0 ? M[b] : m4mul(m4inv(M[parent[b]]), M[b]);
        // three 的 Euler.setFromRotationMatrix（'XYZ'）
        const m11 = Lm[0], m12 = Lm[4], m13 = Lm[8], m22 = Lm[5], m23 = Lm[9], m32 = Lm[6], m33 = Lm[10];
        const ey = Math.asin(Math.min(1, Math.max(-1, m13)));
        let ex, ez;
        if (Math.abs(m13) < 0.9999999) { ex = Math.atan2(-m23, m33); ez = Math.atan2(-m12, m11); } else { ex = Math.atan2(m32, m22); ez = 0; }
        const lx = piv[b][0] - (parent[b] < 0 ? 0 : piv[parent[b]][0]), ly = piv[b][1] - (parent[b] < 0 ? 0 : piv[parent[b]][1]), lz = piv[b][2] - (parent[b] < 0 ? 0 : piv[parent[b]][2]);
        const o = { rx: ex, ry: ey, rz: ez, ox: Lm[12] - lx, oy: Lm[13] - ly, oz: Lm[14] - lz };
        for (const k in o) {
          const key = bones[b][0] + '.' + k, arr = vals[key] || (vals[key] = []);
          let x = o[k];
          if (k[0] === 'r' && arr.length) x -= Math.round((x - arr[arr.length - 1]) / (2 * Math.PI)) * 2 * Math.PI;
          arr.push(x);
        }
      }
    }
    for (const key of Object.keys(vals)) {
      const q = Int16Array.from(vals[key].map((x) => Math.round(x * BOSS_Q)));
      if (q.every((x) => x === 0)) continue;
      if (q.some((x) => Math.abs(x) >= 32767)) throw new Error('首领动作 ' + a.name + '：' + key + ' 超出量化范围');
      ch[key] = q.every((x) => x === q[0]) ? Int16Array.of(q[0]) : q;
    }
    clips[a.name] = { ex: a.extras || {}, n: nF, ch };
  }
  return { bones, nv: P.length / 3, p: Float32Array.from(P), j: Uint8Array.from(J8), w: Uint8Array.from(W8), nc, ci: CI, c: C8, r: R8, clips };
}
// 首领包的 JSON（数组转 base64，键的顺序固定）
export function bossEntry(sha, b) {
  const b64 = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
  const clips = {};
  for (const name of Object.keys(b.clips).sort()) {
    const c = b.clips[name], ch = {};
    for (const k of Object.keys(c.ch).sort()) ch[k] = b64(c.ch[k]);
    clips[name] = { ex: c.ex, n: c.n, ch };
  }
  return { sha, q: BOSS_Q, bones: b.bones, nv: b.nv, p: b64(b.p), j: b64(b.j), w: b64(b.w), nc: b.nc, ci: b64(b.ci), c: b64(b.c), r: b64(b.r), clips };
}
