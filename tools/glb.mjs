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
  const j = g.json, P = [], N = [], C = [], GL = [];
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
          GL.push(vc && vc.n === 4 ? Math.max(0, 1 - vc.arr[i * 4 + 3] * vcK) : 0);
        }
      }
    for (const c of nd.children || []) walk(c);
  };
  for (const ni of sc.nodes) walk(ni);
  return { count: P.length / 3, pos: Float32Array.from(P), nor: Float32Array.from(N), col: Float32Array.from(C), glow: GL.some((k) => k > 0.01) ? Float32Array.from(GL) : null };
}
