// 人形标准骨架的动作包：从 Universal Animation Library 1 / 2（Quaternius，CC0）里挑出要用的几个动作，
// 打成一个只有骨架和动作的精简 GLB（assets/ual/ual-clips.glb），再由 pack-assets.mjs 打进 js/assets/chars.js。
// 用法：node tools/ual-pack.mjs <UAL1 的 AnimationLibrary_Godot_Standard.glb> <UAL2 的 UAL2_Standard.glb> [输出.glb]
//       node tools/ual-pack.mjs --probe <GLB> <动作名>   打印骨盆高度随时间的变化（挑 Death01 截到哪儿用）
// 纯 Node，自己解析 GLB（下载包当数据读，不执行里面的任何东西）。
// 骨架：UAL2 的 65 骨骼（UE 风格骨骼名）去掉手指和 *_leaf 末端骨骼，剩 23 根；没有网格。
// UAL1 的 Godot 版是同一副骨架、DEF- 前缀的名字，绑定姿态逐骨骼一样（局部 TRS 相同），所以它的动作只要改名就能搬过来。
// 动作：逐帧（30 fps）写成每根骨骼的局部旋转（骨盆另带位移）；整段不变的通道丢掉。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// UAL1（DEF- 前缀）→ 标准骨骼名；手指不要
const UAL1_TO_STD = {
  root: 'root', 'DEF-hips': 'pelvis', 'DEF-spine.001': 'spine_01', 'DEF-spine.002': 'spine_02', 'DEF-spine.003': 'spine_03', 'DEF-neck': 'neck_01', 'DEF-head': 'Head',
  'DEF-shoulder.L': 'clavicle_l', 'DEF-upper_arm.L': 'upperarm_l', 'DEF-forearm.L': 'lowerarm_l', 'DEF-hand.L': 'hand_l',
  'DEF-shoulder.R': 'clavicle_r', 'DEF-upper_arm.R': 'upperarm_r', 'DEF-forearm.R': 'lowerarm_r', 'DEF-hand.R': 'hand_r',
  'DEF-thigh.L': 'thigh_l', 'DEF-shin.L': 'calf_l', 'DEF-foot.L': 'foot_l', 'DEF-toe.L': 'ball_l',
  'DEF-thigh.R': 'thigh_r', 'DEF-shin.R': 'calf_r', 'DEF-foot.R': 'foot_r', 'DEF-toe.R': 'ball_r',
};
// 留下的骨骼（标准骨架去掉手指 / 末端）
const KEEP = new Set(Object.values(UAL1_TO_STD));
// 要的动作：[来源 1|2, 源动作名, 包里的名字, 截取 [起, 止]（秒，缺省整段）]
// Death01 原长 2.4 s：0–0.6 s 慢慢跪下去，0.7–1.0 s 往后倒地，1.0–1.5 s 腿弹起来再落下，1.5 s 以后躺着不动：截到 1.6 s，游戏里再压进程序化死亡的时长（0.6 s）
const CLIPS = [
  [2, 'Zombie_Idle_Loop', 'Zombie_Idle'],
  [2, 'Zombie_Walk_Fwd_Loop', 'Zombie_Walk', null, true],
  [1, 'Hit_Chest', 'Hit_Chest'],
  [1, 'Death01', 'Death01', [0, 1.6]],
];
const FPS = 30;

function readGLB(f) {
  const b = fs.readFileSync(f);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(f + ' 不是 GLB');
  const jl = b.readUInt32LE(12), J = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const bin = b.subarray(20 + jl + 8);
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const acc = (i) => {
    const a = J.accessors[i], v = J.bufferViews[a.bufferView], off = (v.byteOffset || 0) + (a.byteOffset || 0), n = a.count * NC[a.type];
    if (a.componentType !== 5126) throw new Error('只认 float 访问器');
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = bin.readFloatLE(off + k * 4);
    return out;
  };
  return { J, acc };
}
// ---------- 四元数 / 向量 ----------
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qrot = (q, v) => { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q)); return [p[0], p[1], p[2]]; };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const nrm = (q) => { const l = Math.hypot(...q); return q.map((v) => v / l); };
function slerp(a, b, t) {
  let c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], bb = b;
  if (c < 0) { bb = b.map((v) => -v); c = -c; }
  if (c > 0.9995) return nrm(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(c), s = Math.sin(th);
  return a.map((v, i) => (v * Math.sin((1 - t) * th) + bb[i] * Math.sin(t * th)) / s);
}
// 骨架：skin 的 joints，名字（按 rename 换成标准名）、父、绑定姿态局部 TRS
function skel(G, rename) {
  const sk = G.J.skins[0], idx = new Map(sk.joints.map((ni, i) => [ni, i]));
  const names = sk.joints.map((ni) => rename(G.J.nodes[ni].name || ''));
  const parent = sk.joints.map(() => -1);
  sk.joints.forEach((ni, i) => (G.J.nodes[ni].children || []).forEach((c) => { if (idx.has(c)) parent[idx.get(c)] = i; }));
  const loc = sk.joints.map((ni) => ({ t: G.J.nodes[ni].translation || [0, 0, 0], q: G.J.nodes[ni].rotation || [0, 0, 0, 1] }));
  return { nodes: sk.joints, idx, names, parent, loc };
}
// 动作在时刻 t 的局部 TRS（按骨骼下标）
function sample(G, S, a, t) {
  const L = S.loc.map((l) => ({ t: l.t, q: l.q }));
  for (const c of a.channels) {
    const b = S.idx.get(c.target.node);
    if (b === undefined) continue;
    const s = a.samplers[c.sampler], T = G.acc(s.input), V = G.acc(s.output), n = T.length;
    let i0 = 0;
    while (i0 < n - 2 && T[i0 + 1] <= t) i0++;
    const f = n < 2 ? 0 : Math.max(0, Math.min(1, (t - T[i0]) / (T[i0 + 1] - T[i0] || 1)));
    if (c.target.path === 'rotation') L[b] = { t: L[b].t, q: n < 2 ? Array.from(V.slice(0, 4)) : slerp(Array.from(V.slice(i0 * 4, i0 * 4 + 4)), Array.from(V.slice(i0 * 4 + 4, i0 * 4 + 8)), f) };
    else if (c.target.path === 'translation') L[b] = { t: n < 2 ? Array.from(V.slice(0, 3)) : [0, 1, 2].map((k) => V[i0 * 3 + k] + (V[i0 * 3 + 3 + k] - V[i0 * 3 + k]) * f), q: L[b].q };
  }
  return L;
}
const clipDur = (G, a) => Math.max(...a.channels.map((c) => { const T = G.acc(a.samplers[c.sampler].input); return T[T.length - 1]; }));
// 骨骼的世界变换（从骨架根往下乘）
function world(S, L) {
  const W = new Array(S.names.length);
  const order = [];
  const vis = (i) => { order.push(i); S.parent.forEach((p, k) => p === i && vis(k)); };
  S.parent.forEach((p, i) => p < 0 && vis(i));
  for (const i of order) {
    const p = S.parent[i];
    W[i] = p < 0 ? { t: L[i].t, q: L[i].q } : { t: add(W[p].t, qrot(W[p].q, L[i].t)), q: nrm(qmul(W[p].q, L[i].q)) };
  }
  return W;
}

// ---------- 探测：骨盆高度随时间 ----------
if (process.argv[2] === '--probe') {
  const G = readGLB(process.argv[3]);
  const S = skel(G, (n) => UAL1_TO_STD[n] || n);
  const a = G.J.animations.find((x) => x.name === process.argv[4]);
  const d = clipDur(G, a), pi = S.names.indexOf('pelvis'), hi = S.names.indexOf('Head');
  for (let t = 0; t <= d + 1e-6; t += 0.1) {
    const W = world(S, sample(G, S, a, t));
    console.log(t.toFixed(1), '骨盆 y', W[pi].t[1].toFixed(3), 'z', W[pi].t[2].toFixed(3), '头 y', W[hi].t[1].toFixed(3), '脚 y', W[S.names.indexOf('foot_l')].t[1].toFixed(3), W[S.names.indexOf('foot_r')].t[1].toFixed(3));
  }
  process.exit(0);
}

const [f1, f2, outArg] = process.argv.slice(2);
if (!f1 || !f2) throw new Error('用法：node tools/ual-pack.mjs <UAL1.glb> <UAL2.glb> [输出.glb]');
const out = outArg || path.join(root, 'assets/ual/ual-clips.glb');
const G1 = readGLB(f1), G2 = readGLB(f2);
const S1 = skel(G1, (n) => UAL1_TO_STD[n] || n), S2 = skel(G2, (n) => n);
// 输出骨架 = UAL2 去掉手指 / 末端
const keep = S2.names.map((n, i) => (KEEP.has(n) ? i : -1)).filter((i) => i >= 0);
const missing = [...KEEP].filter((n) => S2.names.indexOf(n) < 0);
if (missing.length) throw new Error('UAL2 里缺骨骼 ' + missing.join(' '));
// 两边绑定姿态逐骨骼一致（UAL1 的动作直接改名搬过来的前提）
for (const n of KEEP) {
  const a = S1.loc[S1.names.indexOf(n)], b = S2.loc[S2.names.indexOf(n)];
  const dt = Math.hypot(a.t[0] - b.t[0], a.t[1] - b.t[1], a.t[2] - b.t[2]), dq = 1 - Math.abs(a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3]);
  if (dt > 1e-4 || dq > 1e-6) throw new Error('UAL1 / UAL2 的绑定姿态在 ' + n + ' 不一致');
}
const outIx = new Map(keep.map((i, k) => [i, k]));
const nodes = keep.map((i) => {
  const n = { name: S2.names[i], translation: S2.loc[i].t, rotation: S2.loc[i].q };
  const ch = S2.parent.map((p, k) => (p === i && outIx.has(k) ? outIx.get(k) : -1)).filter((k) => k >= 0);
  if (ch.length) n.children = ch;
  return n;
});
// 逆绑定矩阵：按绑定姿态的世界变换求（列主序）
const W0 = world(S2, S2.loc);
const ibm = new Float32Array(keep.length * 16);
keep.forEach((i, k) => {
  const { t, q } = W0[i], qi = qinv(q), ti = qrot(qi, t).map((v) => -v);
  const [x, y, z, w] = qi;
  const m = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, ti[0], ti[1], ti[2], 1];
  ibm.set(m, k * 16);
});

const chunks = [];
let off = 0;
const accessors = [], bufferViews = [];
const addAcc = (arr, type, extra) => {
  const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), p = (4 - (b.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: off, byteLength: b.length });
  chunks.push(b);
  if (p) chunks.push(Buffer.alloc(p));
  off += b.length + p;
  const NC = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
  accessors.push(Object.assign({ bufferView: bufferViews.length - 1, componentType: 5126, count: arr.length / NC[type], type }, extra || {}));
  return accessors.length - 1;
};
const ibmAcc = addAcc(ibm, 'MAT4');
const animations = [];
const report = [];
for (const [src, cn, name, cut, gait] of CLIPS) {
  const G = src === 1 ? G1 : G2, S = src === 1 ? S1 : S2;
  const a = G.J.animations.find((x) => x.name === cn);
  if (!a) throw new Error('UAL' + src + ' 里没有动作 ' + cn);
  const d = clipDur(G, a), t0 = cut ? cut[0] : 0, t1 = cut ? Math.min(d, cut[1]) : d;
  const nF = Math.max(2, Math.round((t1 - t0) * FPS) + 1);
  const times = new Float32Array(nF);
  for (let f = 0; f < nF; f++) times[f] = ((t1 - t0) * f) / (nF - 1);
  // 按输出骨骼收集每帧的局部旋转 / 位移
  const R = keep.map(() => []), P = keep.map(() => []);
  // 走路（gait）：两只脚相对骨盆前后扫过的范围（取平均）×2 ≈ 一个周期走多远（原地循环的动作，游戏按走过的距离推进相位）
  const sweep = { foot_l: [1e9, -1e9], foot_r: [1e9, -1e9] };
  for (let f = 0; f < nF; f++) {
    const L = sample(G, S, a, t0 + times[f]);
    if (gait) {
      const W = world(S, L), pz = W[S.names.indexOf('pelvis')].t[2];
      for (const fn in sweep) {
        const z = W[S.names.indexOf(fn)].t[2] - pz;
        sweep[fn][0] = Math.min(sweep[fn][0], z);
        sweep[fn][1] = Math.max(sweep[fn][1], z);
      }
    }
    keep.forEach((i2, k) => {
      const i = S.names.indexOf(S2.names[i2]);
      let q = L[i].q;
      const prev = R[k][R[k].length - 1];
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0) q = q.map((v) => -v);
      R[k].push(q);
      P[k].push(L[i].t);
    });
  }
  const tAcc = addAcc(times, 'SCALAR', { min: [0], max: [times[nF - 1]] });
  const samplers = [], channels = [];
  keep.forEach((i2, k) => {
    const r0 = S2.loc[i2];
    const rotVar = R[k].some((q) => 1 - Math.abs(q[0] * r0.q[0] + q[1] * r0.q[1] + q[2] * r0.q[2] + q[3] * r0.q[3]) > 1e-7);
    // 位移：只有骨盆（其余骨骼的位移是骨长，不动）
    const posVar = S2.names[i2] === 'pelvis' && P[k].some((t) => Math.hypot(t[0] - r0.t[0], t[1] - r0.t[1], t[2] - r0.t[2]) > 1e-5);
    if (rotVar) {
      samplers.push({ input: tAcc, output: addAcc(new Float32Array(R[k].flat()), 'VEC4'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: k, path: 'rotation' } });
    }
    if (posVar) {
      samplers.push({ input: tAcc, output: addAcc(new Float32Array(P[k].flat()), 'VEC3'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: k, path: 'translation' } });
    }
  });
  const anim = { name, samplers, channels };
  let extra = '';
  if (gait) {
    const cycle = sweep.foot_l[1] - sweep.foot_l[0] + sweep.foot_r[1] - sweep.foot_r[0]; // 两脚各自的扫幅之和 = 平均扫幅 ×2
    anim.extras = { cycle: Math.round(cycle * 1000) / 1000 };
    extra = '，一个周期 ' + anim.extras.cycle + ' m（动作包单位）';
  }
  animations.push(anim);
  report.push(name + '（UAL' + src + ' ' + cn + (cut ? ' ' + t0 + '–' + t1 + ' s' : '') + '）' + nF + ' 帧，' + channels.length + ' 个通道' + extra);
}

const bin = Buffer.concat(chunks);
const J = {
  asset: { version: '2.0', generator: 'cinder-abyss tools/ual-pack.mjs' },
  scene: 0, scenes: [{ nodes: [0] }],
  nodes, skins: [{ joints: keep.map((_, k) => k), inverseBindMatrices: ibmAcc }],
  animations, accessors, bufferViews, buffers: [{ byteLength: bin.length }],
};
let json = Buffer.from(JSON.stringify(J), 'utf8');
if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
const hdr = Buffer.alloc(12);
hdr.writeUInt32LE(0x46546c67, 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([hdr, ch(json.length, 0x4e4f534a), json, ch(bin.length, 0x004e4942), bin]));
console.log('骨骼', keep.length, '：', keep.map((i) => S2.names[i]).join(' '));
for (const r of report) console.log('动作', r);
console.log('写出', path.relative(root, out), fs.statSync(out).size, '字节');
