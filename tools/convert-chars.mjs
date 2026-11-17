// 把 Quaternius 的角色源文件（FBX / glTF）转成精简的 GLB：assets/quaternius-*/<名字>.glb
// 用法：node tools/convert-chars.mjs（需要本机装有 Chrome；用 playwright-core 无头打开，借 three r128 的 FBXLoader / GLTFLoader 读源文件）
//
// 输出的 GLB 是标准 glTF 2.0，任何查看器都能打开，内容是游戏用得到的那部分：
//   - 骨骼：按绑定姿态的世界矩阵去掉缩放后建节点层级（单位：米，模型高度归一到 spec.h）；
//   - 网格：每个材质一个图元，只有 POSITION / JOINTS_0 / WEIGHTS_0（+ 贴图上色的模型带 COLOR_0），按位置去重后带索引；
//     不存法线（游戏里重新摆好绑定姿态后按面重算，平涂风格本来就是一面一色）；
//   - 动画：只保留清单里的动作，按 30 帧/秒重采样成每根骨骼的平移 + 旋转（不变的轨道丢掉）。
//     现在只有蜘蛛用模型自带的动作（主角 / 游魂 / 仆从全由程序化动作驱动，比对过模型自带的升起、出手，不如程序化的贴合玩法），
//     其余三个的清单留空以省体积；要用时往 clips 里加名字重新转换即可。
// 游戏端（js/world.js 的 C 模型部分）用一个很小的同步 GLB 读取器解析，不经过 GLTFLoader。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = (p) => path.join(root, 'assets', p);
const SPECS = [
  {
    out: A('quaternius-modular-men/Adventurer.glb'), src: A('quaternius-modular-men/Adventurer.gltf'), h: 1.856,
    drop: '^Backpack/', // 背包在游戏里摘掉了，不转
    clips: [],
  },
  {
    out: A('quaternius-animated-zombie/Zombie.glb'), src: A('quaternius-animated-zombie/Zombie.fbx'), tex: A('quaternius-animated-zombie/ZombieTexture.png'), h: 1.8,
    clips: [],
  },
  {
    out: A('quaternius-animated-monster/Skeleton.glb'), src: A('quaternius-animated-monster/Skeleton.fbx'), h: 1.8,
    clips: [],
  },
  {
    out: A('quaternius-easy-enemy/Spider.glb'), src: A('quaternius-easy-enemy/Spider.fbx'), h: 0.65,
    clips: ['Spider_Idle', 'Spider_Walk', 'Spider_Attack', 'Spider_Death', 'Spider_Jump'],
  },
];

// ---------------- 页面里跑的部分 ----------------
function inPage(spec) {
  const T = THREE;
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  return new Promise((resolve, reject) => {
    const done = (root, anims) => {
      try {
        resolve(work(root, anims));
      } catch (e) {
        reject(e.stack || String(e));
      }
    };
    if (spec.kind === 'fbx') {
      const r = new T.FBXLoader().parse(b64(spec.data), '');
      done(r, r.animations || []);
    } else {
      new T.GLTFLoader().parse(atob(spec.data), '', (g) => done(g.scene, g.animations), (e) => reject(String(e)));
    }
  }).then((r) => (spec.texData ? r : r));

  function work(root, anims) {
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    const bones = [];
    const bi = new Map();
    for (const m of meshes) for (const b of m.skeleton.bones) if (!bi.has(b)) { bi.set(b, bones.length); bones.push(b); }
    // 贴图（Zombie 的调色板）：读成像素，按 UV 取色
    let px = null;
    if (spec.tex) {
      const c = document.createElement('canvas');
      c.width = spec.tex.w; c.height = spec.tex.h;
      const g = c.getContext('2d');
      g.drawImage(window.__texImg, 0, 0);
      px = g.getImageData(0, 0, c.width, c.height).data;
    }
    const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    // 绑定姿态：每根骨骼的世界矩阵 = boneInverse 的逆（取第一个用到它的网格）
    const bindW = bones.map(() => null);
    for (const m of meshes) m.skeleton.bones.forEach((b, i) => { const k = bi.get(b); if (!bindW[k]) bindW[k] = new T.Matrix4().copy(m.skeleton.boneInverses[i]).invert(); });
    // 先量绑定姿态下网格的高度，定出单位换算
    const v = new T.Vector3();
    let y0 = 1e9, y1 = -1e9;
    for (const m of meshes) { const p = m.geometry.attributes.position; for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m.bindMatrix); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); } }
    const U = spec.h / (y1 - y0);
    // 去缩放 + 换单位：骨骼矩阵只留旋转和位置
    const _p = new T.Vector3(), _q = new T.Quaternion(), _s = new T.Vector3(), one = new T.Vector3(1, 1, 1);
    const norm = (M) => { M.decompose(_p, _q, _s); _p.multiplyScalar(U); _p.y -= y0 * U; return new T.Matrix4().compose(_p, _q, one); };
    const bindN = bindW.map(norm);
    const parentOf = bones.map((b) => (b.parent && bi.has(b.parent) ? bi.get(b.parent) : -1));
    const local = (Ws, i) => (parentOf[i] < 0 ? Ws[i].clone() : new T.Matrix4().copy(Ws[parentOf[i]]).invert().multiply(Ws[i]));

    // ---- 网格：每个网格（多材质的按 group 拆开）一个图元 ----
    const prims = [];
    const mats = [];
    const matIdx = new Map();
    for (const m of meshes) {
      const g = m.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, uv = g.attributes.uv;
      const ml = Array.isArray(m.material) ? m.material : [m.material];
      const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : pos.count, materialIndex: 0 }];
      for (const gr of groups) {
        const mat = ml[gr.materialIndex || 0];
        if (!matIdx.has(mat.name)) {
          matIdx.set(mat.name, mats.length);
          // glTF 的颜色是线性的：GLTFLoader 读进来已经是线性，FBX 的颜色按 sRGB 换算
          const c = mat.color.clone();
          if (spec.kind === 'fbx') c.convertSRGBToLinear();
          mats.push({ name: mat.name, c: [c.r, c.g, c.b] });
        }
        const P = [], J = [], Wt = [], C = [], I = [];
        const seen = new Map();
        for (let n = gr.start; n < gr.start + gr.count; n++) {
          const i = g.index ? g.index.getX(n) : n;
          v.fromBufferAttribute(pos, i).applyMatrix4(m.bindMatrix).multiplyScalar(U);
          v.y -= y0 * U;
          // 4 个权重 → 统一骨骼表的序号，量化成 0..255（总和正好 255）
          const js = [si.getX(i), si.getY(i), si.getZ(i), si.getW(i)].map((k) => bi.get(m.skeleton.bones[k]));
          let ws = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
          const sum = ws.reduce((a, b) => a + b, 0) || 1;
          ws = ws.map((w) => w / sum);
          let q = ws.map((w) => Math.round(w * 255));
          const d = 255 - q.reduce((a, b) => a + b, 0);
          q[q.indexOf(Math.max(...q))] += d;
          for (let k = 0; k < 4; k++) if (!q[k]) js[k] = 0;
          let col = null;
          if (px && uv) {
            let u = uv.getX(i), w = uv.getY(i);
            u -= Math.floor(u); w -= Math.floor(w);
            const x = Math.min(spec.tex.w - 1, Math.floor(u * spec.tex.w)), y = Math.min(spec.tex.h - 1, Math.floor((1 - w) * spec.tex.h)); // FBX 的 UV 原点在左下
            const o = (y * spec.tex.w + x) * 4;
            col = [px[o], px[o + 1], px[o + 2]].map((c) => Math.round(s2l(c / 255) * 255));
          }
          const key = [v.x, v.y, v.z].map((a) => a.toFixed(5)).join() + '|' + js.join() + '|' + q.join() + '|' + (col ? col.join() : '');
          let idx = seen.get(key);
          if (idx === undefined) {
            idx = P.length / 3;
            seen.set(key, idx);
            P.push(v.x, v.y, v.z);
            J.push(...js);
            Wt.push(...q);
            if (col) C.push(...col, 255);
          }
          I.push(idx);
        }
        // 三角形绕序：FBX 镜像过的网格（绑定矩阵行列式为负）要翻回来
        if (m.bindMatrix.determinant() < 0) for (let k = 0; k < I.length; k += 3) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
        const grp = m.parent && m.parent.type === 'Group' && m.parent !== root ? m.parent.name : '';
        if (spec.drop && new RegExp(spec.drop).test((grp ? grp + '/' : '') + m.name)) continue;
        prims.push({ name: (grp ? grp + '/' : '') + m.name + (groups.length > 1 ? '#' + gr.materialIndex : ''), mat: matIdx.get(mat.name), P, J, W: Wt, C: C.length ? C : null, I });
      }
    }

    // ---- 动画：按 30 帧/秒重采样 ----
    const clips = [];
    const mixer = new T.AnimationMixer(root);
    for (const want of spec.clips) {
      const clip = anims.find((a) => a.name === want || a.name.endsWith('|' + want));
      if (!clip) throw new Error('缺少动作 ' + want);
      mixer.stopAllAction();
      const act = mixer.clipAction(clip);
      act.play();
      const fps = 30, n = Math.max(2, Math.round(clip.duration * fps) + 1);
      const times = [], tr = bones.map(() => []), rot = bones.map(() => []);
      for (let f = 0; f < n; f++) {
        const t = Math.min(clip.duration, f / fps);
        times.push(t);
        mixer.setTime(t);
        root.updateMatrixWorld(true);
        const Ws = bones.map((b) => norm(b.matrixWorld.clone()));
        bones.forEach((b, i) => {
          local(Ws, i).decompose(_p, _q, _s);
          tr[i].push(_p.x, _p.y, _p.z);
          rot[i].push(_q.x, _q.y, _q.z, _q.w);
        });
      }
      // 四元数连续化（相邻帧点积为负就取反），不变的轨道丢掉
      const ch = [];
      bones.forEach((b, i) => {
        const r = rot[i];
        for (let k = 4; k < r.length; k += 4) if (r[k] * r[k - 4] + r[k + 1] * r[k - 3] + r[k + 2] * r[k - 2] + r[k + 3] * r[k - 1] < 0) for (let c = 0; c < 4; c++) r[k + c] = -r[k + c];
        local(bindN, i).decompose(_p, _q, _s);
        const bt = [_p.x, _p.y, _p.z], bq = [_q.x, _q.y, _q.z, _q.w];
        const still = (arr, ref, eps) => { for (let k = 0; k < arr.length; k++) if (Math.abs(arr[k] - ref[k % ref.length]) > eps) return false; return true; };
        const bqn = bq[3] * r[3] + bq[0] * r[0] + bq[1] * r[1] + bq[2] * r[2] < 0 ? bq.map((x) => -x) : bq;
        if (!still(r, bqn, 1e-4)) ch.push({ node: i, path: 'rotation', v: r });
        if (!still(tr[i], bt, 1e-4 * spec.h)) ch.push({ node: i, path: 'translation', v: tr[i] });
      });
      clips.push({ name: want, times, ch });
    }

    // ---- 拼 glTF ----
    const bin = [];
    let off = 0;
    const views = [], accs = [];
    const view = (arr, target) => {
      const buf = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      const pad = (4 - (off % 4)) % 4;
      if (pad) { bin.push(new Uint8Array(pad)); off += pad; }
      bin.push(buf);
      views.push(Object.assign({ buffer: 0, byteOffset: off, byteLength: buf.byteLength }, target ? { target } : {}));
      off += buf.byteLength;
      return views.length - 1;
    };
    const acc = (arr, type, ct, extra, target) => {
      const n = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
      accs.push(Object.assign({ bufferView: view(arr, target), componentType: ct, count: arr.length / n, type }, extra || {}));
      return accs.length - 1;
    };
    const nodes = bones.map((b, i) => {
      local(bindN, i).decompose(_p, _q, _s);
      const kids = bones.map((_, k) => k).filter((k) => parentOf[k] === i);
      return Object.assign({ name: b.name, translation: [_p.x, _p.y, _p.z], rotation: [_q.x, _q.y, _q.z, _q.w] }, kids.length ? { children: kids } : {});
    });
    const ibm = new Float32Array(bones.length * 16);
    bindN.forEach((M, i) => ibm.set(new T.Matrix4().copy(M).invert().elements, i * 16));
    const meshNode = nodes.length;
    nodes.push({ name: spec.name, mesh: 0, skin: 0 });
    const primitives = prims.map((p) => {
      const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (let k = 0; k < p.P.length; k++) { lo[k % 3] = Math.min(lo[k % 3], p.P[k]); hi[k % 3] = Math.max(hi[k % 3], p.P[k]); }
      const at = {
        POSITION: acc(new Float32Array(p.P), 'VEC3', 5126, { min: lo, max: hi }, 34962),
        JOINTS_0: acc(new Uint8Array(p.J), 'VEC4', 5121, null, 34962),
        WEIGHTS_0: acc(new Uint8Array(p.W), 'VEC4', 5121, { normalized: true }, 34962),
      };
      if (p.C) at.COLOR_0 = acc(new Uint8Array(p.C), 'VEC4', 5121, { normalized: true }, 34962);
      const big = p.P.length / 3 > 65535;
      return { attributes: at, indices: acc(big ? new Uint32Array(p.I) : new Uint16Array(p.I), 'SCALAR', big ? 5125 : 5123, null, 34963), material: p.mat, extras: { name: p.name } };
    });
    const animations = clips.map((c) => {
      const tAcc = acc(new Float32Array(c.times), 'SCALAR', 5126, { min: [c.times[0]], max: [c.times[c.times.length - 1]] });
      const samplers = [], channels = [];
      for (const k of c.ch) {
        samplers.push({ input: tAcc, output: acc(new Float32Array(k.v), k.path === 'rotation' ? 'VEC4' : 'VEC3', 5126), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: k.node, path: k.path } });
      }
      return { name: c.name, samplers, channels };
    });
    const json = {
      asset: { version: '2.0', generator: '烬渊 tools/convert-chars.mjs', copyright: 'Quaternius, CC0 1.0' },
      scene: 0,
      scenes: [{ nodes: [...bones.map((_, i) => i).filter((i) => parentOf[i] < 0), meshNode] }],
      nodes,
      meshes: [{ name: spec.name, primitives }],
      skins: [{ joints: bones.map((_, i) => i), inverseBindMatrices: acc(ibm, 'MAT4', 5126) }],
      materials: mats.map((m) => ({ name: m.name, pbrMetallicRoughness: { baseColorFactor: [...m.c, 1], metallicFactor: 0, roughnessFactor: 1 } })),
      animations,
      accessors: accs,
      bufferViews: views,
      buffers: [{ byteLength: off }],
    };
    const all = new Uint8Array(off);
    let o2 = 0;
    for (const b of bin) { all.set(b, o2); o2 += b.byteLength; }
    let s = '';
    for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
    return { json: JSON.stringify(json), bin: btoa(s), stats: { bones: bones.length, prims: prims.map((p) => p.name + ':' + p.P.length / 3 + 'v/' + p.I.length / 3 + 't'), clips: clips.map((c) => c.name + ':' + c.ch.length) } };
  }
}

function glb(jsonStr, bin) {
  const pad4 = (n) => (n + 3) & ~3;
  let json = Buffer.from(jsonStr, 'utf8');
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(pad4(json.length) - json.length, 0x20)]);
  if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(json.length, 0x4e4f534a), json, ch(bin.length, 0x004e4942), bin]);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
for (const f of ['vendor/three.min.js', 'tools/vendor/fflate.min.js', 'tools/vendor/NURBSUtils.js', 'tools/vendor/NURBSCurve.js', 'tools/vendor/FBXLoader.js', 'vendor/GLTFLoader.js']) {
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, f), 'utf8') });
}
for (const s of SPECS) {
  const kind = s.src.endsWith('.fbx') ? 'fbx' : 'gltf';
  const data = kind === 'fbx' ? fs.readFileSync(s.src).toString('base64') : Buffer.from(fs.readFileSync(s.src, 'utf8')).toString('base64');
  let tex = null;
  if (s.tex) {
    const url = 'data:image/png;base64,' + fs.readFileSync(s.tex).toString('base64');
    tex = await page.evaluate((url) => new Promise((ok) => { const im = new Image(); im.onload = () => { window.__texImg = im; ok({ w: im.width, h: im.height }); }; im.src = url; }), url);
  }
  const name = path.basename(s.out, '.glb');
  const r = await page.evaluate(inPage, { kind, data, tex, h: s.h, clips: s.clips, name, drop: s.drop });
  const out = glb(r.json, Buffer.from(r.bin, 'base64'));
  fs.writeFileSync(s.out, out);
  console.log(path.relative(root, s.out), (out.length / 1024).toFixed(0) + ' KB', JSON.stringify(r.stats));
}
await browser.close();
