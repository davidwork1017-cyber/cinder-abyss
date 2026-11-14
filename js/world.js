'use strict';
// world.js —— 全部 THREE 渲染：场景/相机/灯光、区域生成与主题化外观、可行走判定、
// 实体模型、投射物、预警圈、掉落物、传送门、特效、飘字，以及 2D 叠加层（血条/掉落标签/小地图）
(function () {
  const G = window.G;
  const T = THREE;
  const W = (G.world = {});
  const TAU = Math.PI * 2;
  const rand = G.rand;

  let renderer, scene, camera, hemi, sun, lamp, fxLight, portalLight;
  let ocv, octx;
  let vw = 1, vh = 1, dpr = 1;
  let wtime = 0;

  // 复用的临时对象：热路径里不做任何分配
  const _v = new T.Vector3(), _v2 = new T.Vector3(), _s = new T.Vector3();
  const _c = new T.Color(), _c2 = new T.Color();
  const _m4 = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler();
  const UP = new T.Vector3(0, 1, 0);
  const _pr = { x: 0, y: 0, ok: false };

  const CAM_OFF = new T.Vector3(0, 24, 17);
  // 镜头整体向屏幕下方（+z）让出的距离：玩家因此站在画面中线偏上，
  // 脚下能看到的范围和头顶差不多（底部还有技能栏要占掉一截）
  const CAM_LEAD = 3;
  const HUD_BAND = 140; // 画面底部被技能栏 / 血球占住的高度（CSS 像素），W.inView 把它当作看不见
  const VIEW_PAD = 36; // W.inView 的屏幕边距
  const SUN_OFF = new T.Vector3(-11, 28, 17);
  const SHADOW_HALF = 28, SHADOW_MAP = 2048;
  const HEMI_I = 0.46;
  const camT = new T.Vector3();
  let camSnap = true;
  let shakeAmt = 0;
  const BASE_FOV = 38;
  // 镜头冲量（顺着打击方向顶一下再弹回）与视角收缩（终结技 / 处决时的一记「推近」）
  let punchX = 0, punchZ = 0, fovK = 0, fovNow = BASE_FOV;
  const sunR = new T.Vector3(), sunU = new T.Vector3();

  // ---------- 小工具 ----------
  // 材质颜色按线性空间参与光照，所以十六进制色要先转成线性
  const lin = (hex) => new T.Color(hex).convertSRGBToLinear();
  const hexOf = (c) => _c.set(c).getHex(); // 接受数字或 '#rrggbb'
  function mixHex(a, b, t) {
    return _c.set(a).lerp(_c2.set(b), t).getHex();
  }
  const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  function hash2(ix, iz) {
    let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // 世界坐标上的平滑值噪声（顶点着色、摆放用）
  function vnoise(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    let fx = x - ix, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // ---------- 几何体缓存（所有实体/特效共享，永不释放） ----------
  const geoCache = Object.create(null);
  const geo = (key, make) => geoCache[key] || (geoCache[key] = make());
  const gBox = (w, h, d) => geo(`b${w},${h},${d}`, () => new T.BoxGeometry(w, h, d));
  const gCyl = (rt, rb, h, s = 6) => geo(`c${rt},${rb},${h},${s}`, () => new T.CylinderGeometry(rt, rb, h, s));
  const gCone = (r, h, s = 5) => geo(`k${r},${h},${s}`, () => new T.ConeGeometry(r, h, s));
  const gIco = (r, d = 0) => geo(`i${r},${d}`, () => new T.IcosahedronGeometry(r, d));
  const gOct = (r) => geo(`o${r}`, () => new T.OctahedronGeometry(r, 0));
  const gTorus = (r, t, rs = 5, ts = 20, arc = Math.PI * 2) => geo(`t${r},${t},${rs},${ts},${arc}`, () => new T.TorusGeometry(r, t, rs, ts, arc));
  // 平躺在 XZ 平面上的单位方片（-1..1），着色器特效和贴花共用
  const gQuad = () =>
    geo('quad', () => {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute([-1, 0, -1, -1, 0, 1, 1, 0, 1, 1, 0, -1], 3));
      g.setAttribute('normal', new T.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setAttribute('uv', new T.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 1, 1], 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      return g;
    });

  // 把若干零件烘焙成一个带顶点色的几何体（一个怪 = 很少的 draw call）
  // 零件：[geometry, 颜色, x, y, z, rx, ry, rz, sx, sy, sz]（sy/sz 缺省时等于 sx）
  function bake(key, parts) {
    if (geoCache[key]) return geoCache[key];
    const srcs = [];
    let n = 0;
    for (const p of parts) {
      const s = p[0].index ? p[0].toNonIndexed() : p[0];
      srcs.push(s);
      n += s.attributes.position.count;
    }
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let o = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const sx = p[8] === undefined ? 1 : p[8];
      _e.set(p[5] || 0, p[6] || 0, p[7] || 0);
      _m4.compose(
        _v.set(p[2] || 0, p[3] || 0, p[4] || 0),
        _q.setFromEuler(_e),
        _s.set(sx, p[9] === undefined ? sx : p[9], p[10] === undefined ? sx : p[10])
      );
      _c.set(p[1]).convertSRGBToLinear();
      const a = srcs[i].attributes.position;
      for (let k = 0; k < a.count; k++) {
        _v2.fromBufferAttribute(a, k).applyMatrix4(_m4);
        pos[o] = _v2.x; pos[o + 1] = _v2.y; pos[o + 2] = _v2.z;
        col[o] = _c.r; col[o + 1] = _c.g; col[o + 2] = _c.b;
        o += 3;
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return (geoCache[key] = g);
  }
  // 从 a 点到 b 点的一根方棍（用于腿、爪、骨刺）
  function seg(color, ax, ay, az, bx, by, bz, th) {
    _v.set(bx - ax, by - ay, bz - az);
    const len = _v.length();
    _q.setFromUnitVectors(UP, _v.divideScalar(len));
    _e.setFromQuaternion(_q);
    return [gBox(th, 1, th), color, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, _e.x, _e.y, _e.z, 1, len, 1];
  }
  function put(parent, geom, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const m = new T.Mesh(geom, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  // ---------- 程序化贴图 ----------
  const texCache = Object.create(null);
  const tex = (key, make) => texCache[key] || (texCache[key] = make());

  const glowTex = () =>
    tex('glow', () => {
      const c = makeCanvas(64, 64), g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.14)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
      return new T.CanvasTexture(c);
    });
  // 竖直渐变：底部亮、顶部透明（光柱）
  const beamTex = () =>
    tex('beam', () => {
      const c = makeCanvas(4, 64), g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 64, 0, 0);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.3, 'rgba(255,255,255,0.5)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 4, 64);
      return new T.CanvasTexture(c);
    });
  // 横向：亮芯 + 柔边（闪电带）
  const boltTex = () =>
    tex('bolt', () => {
      const c = makeCanvas(64, 4), g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 64, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.3, 'rgba(255,255,255,0.22)');
      gr.addColorStop(0.44, 'rgba(255,255,255,1)');
      gr.addColorStop(0.56, 'rgba(255,255,255,1)');
      gr.addColorStop(0.7, 'rgba(255,255,255,0.22)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 4);
      return new T.CanvasTexture(c);
    });
  // 精英脚下的断续光环
  const dashRingTex = () =>
    tex('dash', () => {
      const S = 128, c = makeCanvas(S, S), g = c.getContext('2d');
      g.translate(S / 2, S / 2);
      g.strokeStyle = '#fff';
      g.lineWidth = 7;
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.arc(0, 0, 52, (i / 6) * TAU, (i / 6) * TAU + 0.72);
        g.stroke();
      }
      g.lineWidth = 2;
      g.globalAlpha = 0.7;
      g.beginPath();
      g.arc(0, 0, 41, 0, TAU);
      g.stroke();
      return new T.CanvasTexture(c);
    });
  // 法阵（首领竞技场 / 起点）
  const sigilTex = () =>
    tex('sigil', () => {
      const S = 512, c = makeCanvas(S, S), g = c.getContext('2d');
      const R = S / 2 - 10;
      g.translate(S / 2, S / 2);
      g.strokeStyle = '#fff';
      g.fillStyle = '#fff';
      g.lineCap = 'round';
      const circle = (r, w) => {
        g.lineWidth = w;
        g.beginPath();
        g.arc(0, 0, r, 0, TAU);
        g.stroke();
      };
      circle(R, 6);
      circle(R * 0.9, 2.5);
      circle(R * 0.56, 3);
      circle(R * 0.5, 1.5);
      circle(R * 0.16, 3);
      g.lineWidth = 3;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU, r0 = R * (i % 4 === 0 ? 0.78 : 0.85);
        g.beginPath();
        g.moveTo(Math.sin(a) * r0, Math.cos(a) * r0);
        g.lineTo(Math.sin(a) * R * 0.9, Math.cos(a) * R * 0.9);
        g.stroke();
      }
      // 两个交错的三角 + 顶点小环
      g.lineWidth = 3.5;
      for (let t = 0; t < 2; t++) {
        g.beginPath();
        for (let i = 0; i <= 3; i++) {
          const a = (i / 3) * TAU + t * (TAU / 6);
          const x = Math.sin(a) * R * 0.76, y = Math.cos(a) * R * 0.76;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        g.lineWidth = 3;
        g.beginPath();
        g.arc(Math.sin(a) * R * 0.76, Math.cos(a) * R * 0.76, R * 0.06, 0, TAU);
        g.stroke();
        g.beginPath();
        g.moveTo(Math.sin(a + TAU / 12) * R * 0.16, Math.cos(a + TAU / 12) * R * 0.16);
        g.lineTo(Math.sin(a + TAU / 12) * R * 0.5, Math.cos(a + TAU / 12) * R * 0.5);
        g.stroke();
      }
      return new T.CanvasTexture(c);
    });
  // 不规则暗斑（地面污渍）
  const blotchTex = () =>
    tex('blotch', () => {
      const S = 128, c = makeCanvas(S, S), g = c.getContext('2d');
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * TAU, d = Math.random() * 26, r = 14 + Math.random() * 24;
        const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.5)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, S, S);
      }
      return new T.CanvasTexture(c);
    });
  // 传送门旋涡
  const swirlTex = () =>
    tex('swirl', () => {
      const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
      const img = g.createImageData(S, S), d = img.data;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const px = (x / S) * 2 - 1, py = (y / S) * 2 - 1;
          const r = Math.sqrt(px * px + py * py), a = Math.atan2(py, px);
          const arm = 0.5 + 0.5 * Math.sin(a * 3 + r * 9);
          const v = Math.pow(arm, 2.2) * smooth01((1 - r) * 3.2) * (0.35 + 0.65 * smooth01(r * 2.2)) + smooth01(1 - r * 3.4) * 0.9;
          const i = (y * S + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = 255;
          d[i + 3] = Math.min(255, v * 255);
        }
      }
      g.putImageData(img, 0, 0);
      return new T.CanvasTexture(c);
    });

  // ----- 地面贴图：按区域主题生成 反照率 / 凹凸 / 自发光裂纹 三张可平铺贴图 -----
  const GROUND_STYLE = {
    // kind: crack=龟裂焦土 ice=冰面 tile=石板；fine=细裂纹层的胞数；amb=环境粒子
    ash: { kind: 'crack', cells: 10, fine: 26, crackW: 0.06, crackK: 0.55, glow: 0.3, rough: 0.95, bump: 0.06, emis: 1.15, amb: 'ember', ambRate: 13 },
    frost: { kind: 'ice', cells: 7, fine: 19, crackW: 0.035, crackK: 0.3, glow: 0.34, rough: 0.5, bump: 0.03, emis: 0.55, amb: 'snow', ambRate: 26 },
    storm: { kind: 'tile', cells: 8, fine: 0, crackW: 0.045, crackK: 0.55, glow: 0.11, rough: 0.8, bump: 0.05, emis: 1.0, amb: 'spark', ambRate: 7 },
    abyss: { kind: 'crack', cells: 12, fine: 30, crackW: 0.075, crackK: 0.62, glow: 0.17, rough: 0.9, bump: 0.07, emis: 0.95, amb: 'ember', ambRate: 20 },
  };
  const TILE = 14; // 一张地面贴图铺多少世界单位

  // 可平铺分形噪声，值域拉伸到约 0..1
  function fbmTile(S, seed) {
    const out = new Float32Array(S * S);
    let amp = 0.5, total = 0;
    for (let o = 0; o < 5; o++) {
      const P = 4 << o;
      const lat = new Float32Array(P * P);
      for (let i = 0; i < lat.length; i++) lat[i] = hash2(i + seed * 131, o * 17 + seed);
      const sc = P / S;
      for (let y = 0; y < S; y++) {
        const fy = y * sc, iy = Math.floor(fy);
        let ty = fy - iy;
        ty = ty * ty * (3 - 2 * ty);
        const r0 = (iy % P) * P, r1 = ((iy + 1) % P) * P;
        for (let x = 0; x < S; x++) {
          const fx = x * sc, ix = Math.floor(fx);
          let tx = fx - ix;
          tx = tx * tx * (3 - 2 * tx);
          const c0 = ix % P, c1 = (ix + 1) % P;
          const a = lat[r0 + c0], b = lat[r0 + c1], c = lat[r1 + c0], d = lat[r1 + c1];
          out[y * S + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
        }
      }
      total += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] = G.clamp((out[i] / total - 0.5) * 2.1 + 0.5, 0, 1);
    return out;
  }
  // 可平铺 Voronoi：edge = 到胞壁的近似距离，id = 每个胞的随机数
  function voronoiTile(S, N, seed) {
    const edge = new Float32Array(S * S), id = new Float32Array(S * S);
    const jx = new Float32Array(N * N), jy = new Float32Array(N * N), cv = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      jx[i] = hash2(i, seed);
      jy[i] = hash2(i, seed + 57);
      cv[i] = hash2(i, seed + 113);
    }
    for (let y = 0; y < S; y++) {
      const v = (y / S) * N, cy = Math.floor(v);
      for (let x = 0; x < S; x++) {
        const u = (x / S) * N, cx = Math.floor(u);
        let f1 = 9, f2 = 9, best = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const gy = cy + dj, ky = ((gy % N) + N) % N;
          for (let di = -1; di <= 1; di++) {
            const gx = cx + di, k = ky * N + (((gx % N) + N) % N);
            const dx = gx + jx[k] - u, dy = gy + jy[k] - v, d = dx * dx + dy * dy;
            if (d < f1) { f2 = f1; f1 = d; best = k; }
            else if (d < f2) f2 = d;
          }
        }
        edge[y * S + x] = Math.sqrt(f2) - Math.sqrt(f1);
        id[y * S + x] = cv[best];
      }
    }
    return { edge, id };
  }
  function groundTextures(def, st) {
    return tex('ground:' + def.id, () => {
      const S = 512, seed = def.level * 7 + 3;
      const n1 = fbmTile(S, seed), n2 = fbmTile(S, seed + 41);
      const vor = st.kind === 'tile' ? null : voronoiTile(S, st.cells, seed);
      const fine = st.fine ? voronoiTile(S, st.fine, seed + 23) : null;
      const cA = makeCanvas(S, S), cB = makeCanvas(S, S), cE = makeCanvas(S, S);
      const gA = cA.getContext('2d'), gB = cB.getContext('2d'), gE = cE.getContext('2d');
      const iA = gA.createImageData(S, S), iB = gB.createImageData(S, S), iE = gE.createImageData(S, S);
      const dA = iA.data, dB = iB.data, dE = iE.data;
      const pr = (def.path >> 16) & 255, pg = (def.path >> 8) & 255, pb = def.path & 255;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x, a = n1[i], b = n2[i];
          let crack, tone, rune = 0;
          if (vor) {
            crack = 1 - smooth01(vor.edge[i] / st.crackW);
            tone = 0.88 + 0.24 * vor.id[i];
          } else {
            // 错缝石板：砖缝为 crack，少数石板刻有发光符线
            const N = st.cells, v = (y / S) * N, row = Math.floor(v);
            const u = (x / S) * N + (row % 2) * 0.5, colI = Math.floor(u) % N;
            const fu = u - Math.floor(u), fv = v - row;
            const e = Math.min(fu, 1 - fu, fv, 1 - fv);
            crack = 1 - smooth01((e - 0.012 - a * 0.02) / st.crackW);
            const h = hash2(row * 31 + colI, seed);
            tone = 0.84 + 0.32 * h;
            if (hash2(row * 17 + colI * 5, seed + 9) < st.glow) {
              // 符文石板：内嵌一圈细线 + 中心菱形
              const inset = 1 - smooth01(Math.abs(e - 0.17) / 0.02);
              const dia = 1 - smooth01(Math.abs(Math.abs(fu - 0.5) + Math.abs(fv - 0.5) - 0.16) / 0.02);
              rune = Math.max(inset, dia);
            } else {
              // 其余石板只有砖缝在某些区域隐隐发亮
              rune = crack * smooth01((b - 0.74) / 0.14) * 0.6;
            }
          }
          // 细裂纹：只在噪声较高的地方出现，强度弱
          const hair = fine ? (1 - smooth01(fine.edge[i] / 0.055)) * smooth01((a - 0.35) * 2.2) : 0;
          let shade = (0.7 + 0.42 * a) * tone;
          let r = pr, g = pg, bl = pb;
          if (st.kind === 'ice') {
            // 冰裂是亮的，并带一点霜白
            const frost = smooth01((b - 0.55) * 3);
            shade *= 1 + st.crackK * crack + 0.16 * hair + 0.12 * frost;
            r += crack * 34 + frost * 10; g += crack * 40 + frost * 12; bl += crack * 46 + frost * 14;
          } else {
            shade *= (1 - st.crackK * crack) * (1 - 0.3 * hair);
          }
          shade += (hash2(x, y + seed) - 0.5) * 0.07;
          const hue = (b - 0.5) * 0.16;
          const k = i * 4;
          dA[k] = Math.min(255, r * shade * (1 + hue));
          dA[k + 1] = Math.min(255, g * shade);
          dA[k + 2] = Math.min(255, bl * shade * (1 - hue));
          dA[k + 3] = 255;
          const hgt = st.kind === 'ice' ? 0.75 + 0.25 * a - crack * 0.35 - hair * 0.12 : (1 - crack) * (0.55 + 0.45 * a) * (1 - hair * 0.35);
          dB[k] = dB[k + 1] = dB[k + 2] = hgt * 255;
          dB[k + 3] = 255;
          // 自发光：只有一部分区域的裂纹在发亮，避免均匀网格感
          const gl = vor ? crack * smooth01((b - (1 - st.glow - 0.12)) / 0.2) : rune;
          dE[k] = dE[k + 1] = dE[k + 2] = Math.min(255, gl * 255);
          dE[k + 3] = 255;
        }
      }
      gA.putImageData(iA, 0, 0);
      gB.putImageData(iB, 0, 0);
      gE.putImageData(iE, 0, 0);
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const mk = (c, srgb) => {
        const t = new T.CanvasTexture(c);
        t.wrapS = t.wrapT = T.RepeatWrapping;
        t.anisotropy = aniso;
        if (srgb) t.encoding = T.sRGBEncoding;
        return t;
      };
      return { map: mk(cA, true), bump: mk(cB, false), emis: mk(cE, false) };
    });
  }

  // ---------- 初始化 ----------
  W.zone = null;

  W.init = function () {
    const canvas = document.getElementById('gl');
    renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;

    scene = new T.Scene();
    scene.background = new T.Color(0x100c0a);
    scene.fog = new T.Fog(0x100c0a, 27, 64);

    camera = new T.PerspectiveCamera(BASE_FOV, 1, 2, 240);
    camera.position.copy(CAM_OFF);
    camera.lookAt(0, 1, 0); // 朝向固定，之后只平移
    camera.getWorldDirection(camF);
    camU.set(0, 1, 0).applyQuaternion(camera.quaternion);

    hemi = new T.HemisphereLight(0xffffff, 0x222222, HEMI_I);
    scene.add(hemi);

    sun = new T.DirectionalLight(0xffffff, 0.82);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
    sc.near = 1; sc.far = 90;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.04;
    scene.add(sun);
    scene.add(sun.target);
    // 阴影相机的右/上轴：用来把光源位置吸附到纹素网格，避免移动时阴影边缘游动
    _v.copy(SUN_OFF).normalize(); // 指向光源 = 阴影相机的 +z
    sunR.crossVectors(UP, _v).normalize();
    sunU.crossVectors(_v, sunR).normalize();

    lamp = new T.PointLight(0xffb878, 1.0, 16, 2); // 跟随玩家的暖光
    scene.add(lamp);
    fxLight = new T.PointLight(0xffffff, 0, 20, 2); // 大型特效的瞬时闪光（预先建好，避免运行时重编译着色器）
    scene.add(fxLight);
    portalLight = new T.PointLight(0x9a7bff, 0, 13, 2);
    scene.add(portalLight);

    initParticles();
    initHitFx();
    corpseRoot = new T.Group();
    scene.add(corpseRoot);

    ocv = document.getElementById('overlay');
    octx = ocv.getContext('2d');

    W.renderer = renderer;
    W.scene = scene;
    W.camera = camera;
    W.resize();
    window.addEventListener('resize', W.resize);

    // 预热特效着色器：先各建一个（不可见），统一编译，免得第一次放技能时卡一下
    poolGet(ringPool);
    poolGet(slashPool);
    boltGet();
    W.meteorFall(0, 0, 1, 0xffffff);
    meteors[0].on = false;
    meteors[0].mesh.visible = false;
    const warm = W.makeTelegraph({ shape: 'circle', x: 0, z: 0, r: 1 }, false);
    initAllyFx();
    warmEntities(); // 里面会真的渲染一帧，上面这些特效的着色器也一并编译
    W.removeTelegraph(warm);
  };

  W.resize = function () {
    vw = Math.max(1, window.innerWidth);
    vh = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(vw, vh);
    camera.aspect = vw / vh;
    camera.updateProjectionMatrix();
    ocv.width = Math.round(vw * dpr);
    ocv.height = Math.round(vh * dpr);
    ocv.style.width = vw + 'px';
    ocv.style.height = vh + 'px';
    // 粒子按世界单位换算成像素大小
    pMat.uniforms.uScale.value = (vh * dpr) / (2 * Math.tan((BASE_FOV * Math.PI) / 360));
    if (W.zone) buildMinimap(W.zone);
  };

  // ---------- 区域：布局 ----------
  function distSeg(x, z, s) {
    const ex = s.bx - s.ax, ez = s.bz - s.az;
    let t = ((x - s.ax) * ex + (z - s.az) * ez) / (ex * ex + ez * ez);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - s.ax - ex * t, dz = z - s.az - ez * t;
    return Math.sqrt(dx * dx + dz * dz);
  }
  // 到可行走区域边界的有向距离（内部为正）
  function zoneSd(zone, x, z) {
    let d = -1e9;
    const cs = zone.circles, ss = zone.segs;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], dx = x - c.x, dz = z - c.z;
      const v = c.r - Math.sqrt(dx * dx + dz * dz);
      if (v > d) d = v;
    }
    for (let i = 0; i < ss.length; i++) {
      const v = ss[i].hw - distSeg(x, z, ss[i]);
      if (v > d) d = v;
    }
    return d;
  }

  W.walkable = function (x, z, pad = 0) {
    const cs = W.zone.circles, ss = W.zone.segs;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], r = c.r - pad;
      if (r > 0) {
        const dx = x - c.x, dz = z - c.z;
        if (dx * dx + dz * dz <= r * r) return true;
      }
    }
    for (let i = 0; i < ss.length; i++) {
      if (distSeg(x, z, ss[i]) <= ss[i].hw - pad) return true;
    }
    return false;
  };

  function layoutZone() {
    let circles = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      circles = [{ x: 0, z: 0, r: 8 }];
      let heading = rand(0, TAU);
      for (let i = 1; i < 6; i++) {
        const prev = circles[i - 1];
        const r = i === 5 ? 15 : rand(9, 12.5);
        if (i > 1) heading += rand(-0.75, 0.75);
        const d = prev.r + r + rand(7, 12);
        circles.push({ x: prev.x + Math.sin(heading) * d, z: prev.z + Math.cos(heading) * d, r });
      }
      // 随机游走几乎不会自交，这里兜底检查一下不相邻的空地/走廊
      let ok = true;
      for (let i = 0; i < 6 && ok; i++) {
        for (let j = i + 2; j < 6 && ok; j++) {
          const a = circles[i], b = circles[j];
          if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + 9) ok = false;
        }
      }
      if (ok) break;
    }
    const segs = [];
    for (let i = 0; i < 5; i++) {
      segs.push({ ax: circles[i].x, az: circles[i].z, bx: circles[i + 1].x, bz: circles[i + 1].z, hw: 3 });
    }
    const b = { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 };
    for (const c of circles) {
      b.minX = Math.min(b.minX, c.x - c.r); b.maxX = Math.max(b.maxX, c.x + c.r);
      b.minZ = Math.min(b.minZ, c.z - c.r); b.maxZ = Math.max(b.maxZ, c.z + c.r);
    }
    return { circles, segs, bounds: b };
  }

  // ---------- 区域：外观 ----------
  let zoneGroup = null;
  let zoneDisp = []; // 换区时要 dispose 的东西
  let zoneFx = null; // 每帧要动的区域元素（水晶脉动、法阵、环境粒子配置）

  function disposeZone() {
    if (!zoneGroup) return;
    scene.remove(zoneGroup);
    for (const d of zoneDisp) d.dispose();
    zoneDisp = [];
    zoneGroup = null;
    zoneFx = null;
  }
  const own = (x) => (zoneDisp.push(x), x);

  // list：每个实例 10 个数 [x,y,z, rx,ry,rz, sx,sy,sz, 明暗]
  function instanced(geom, mat, list, shadow, tint) {
    const n = list.length / 10;
    if (!n) return null;
    const im = new T.InstancedMesh(geom, mat, n);
    for (let i = 0; i < n; i++) {
      const o = i * 10;
      _e.set(list[o + 3], list[o + 4], list[o + 5]);
      _m4.compose(_v.set(list[o], list[o + 1], list[o + 2]), _q.setFromEuler(_e), _s.set(list[o + 6], list[o + 7], list[o + 8]));
      im.setMatrixAt(i, _m4);
      if (tint) im.setColorAt(i, _c.copy(tint).multiplyScalar(list[o + 9]));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = false; // 实例分布在整张图上，包围球没有意义
    im.castShadow = shadow;
    im.receiveShadow = shadow;
    zoneGroup.add(im);
    own(im);
    return im;
  }

  // 顶点按位置的确定性扰动，让重复顶点一起移动（不会裂开）
  function jitterGeo(key, src, amt) {
    return geo(key, () => {
      const g = src.index ? src.toNonIndexed() : src.clone();
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        _v.fromBufferAttribute(p, i);
        const h = Math.sin(_v.x * 12.9898 + _v.y * 78.233 + _v.z * 37.719) * 43758.5453;
        const k = 1 + (h - Math.floor(h) - 0.5) * amt;
        p.setXYZ(i, _v.x * k, _v.y * (1 + (k - 1) * 0.5), _v.z * k);
      }
      g.computeVertexNormals();
      return g;
    });
  }
  const rockGeoA = () => jitterGeo('rockA', new T.IcosahedronGeometry(1, 0), 0.5);
  const rockGeoB = () => jitterGeo('rockB', new T.DodecahedronGeometry(1, 0), 0.42);
  const spireGeo = () =>
    jitterGeo('spire', new T.ConeGeometry(0.8, 2.6, 5, 2).translate(0, 1.3, 0), 0.5);

  // 各主题的远景摆件（焦树 / 冰棱 / 断柱 / 棘刺）
  function propGeo(id) {
    if (id === 'frost') {
      const C = 0x9fd2e6, D = 0x6fa6c4;
      return bake('prop/frost', [
        [gCone(0.5, 3.2, 5), C, 0, 1.6, 0, 0.06, 0, 0.05],
        [gCone(0.34, 2.1, 5), D, 0.55, 1.0, 0.2, 0, 0, -0.38],
        [gCone(0.3, 1.7, 5), C, -0.5, 0.8, -0.1, 0, 0, 0.42],
        [gCone(0.22, 1.2, 4), D, 0.1, 0.55, 0.55, 0.5, 0, 0],
      ]);
    }
    if (id === 'storm') {
      const C = 0x625d78, D = 0x47435a;
      return bake('prop/storm', [
        [gBox(1.35, 0.4, 1.35), D, 0, 0.2, 0],
        [gCyl(0.46, 0.52, 2.8, 8), C, 0, 1.8, 0],
        [gCyl(0.56, 0.5, 0.22, 8), D, 0, 0.55, 0],
        [gCyl(0.3, 0.46, 0.55, 8), C, 0.06, 3.4, 0, 0, 0, 0.22],
        [gCyl(0.46, 0.46, 0.9, 8), D, 1.35, 0.45, 0.4, 0, 0.5, Math.PI / 2],
      ]);
    }
    if (id === 'abyss') {
      const C = 0x2a171c, D = 0x180d11;
      return bake('prop/abyss', [
        [gCone(0.42, 2.6, 4), C, 0, 1.25, 0, 0, 0, 0.25],
        [gCone(0.3, 2.0, 4), D, 0.6, 0.9, 0.2, 0, 0, -0.5],
        [gCone(0.26, 1.6, 4), C, -0.55, 0.7, -0.3, 0, 0, 0.7],
        [gCone(0.18, 1.1, 4), D, 0, 0.5, 0.6, 0.7, 0, 0],
      ]);
    }
    const C = 0x231a16, D = 0x15100e;
    return bake('prop/ash', [
      [gCyl(0.11, 0.3, 3.3, 5), C, 0, 1.65, 0, 0, 0, 0.06],
      seg(D, 0.02, 2.2, 0, 0.95, 3.1, 0.1, 0.13),
      seg(D, 0, 1.7, 0, -0.75, 2.7, 0.3, 0.11),
      seg(C, -0.1, 2.9, 0, 0.1, 3.9, -0.55, 0.08),
      seg(D, 0.6, 2.75, 0.06, 0.7, 3.5, -0.3, 0.06),
    ]);
  }

  function buildVisuals(zone) {
    const def = zone.def;
    const st = GROUND_STYLE[def.id] || GROUND_STYLE.ash;
    const tx = groundTextures(def, st);
    zoneGroup = new T.Group();
    scene.add(zoneGroup);

    // 氛围：雾在 r128 里是在色调映射和编码之后混合的，所以直接用显示色
    scene.background.set(def.fog);
    scene.fog.color.set(def.fog);
    hemi.color.copy(lin(def.sky));
    hemi.groundColor.copy(lin(mixHex(def.fog, def.rock, 0.55)));
    sun.color.copy(lin(mixHex(0xffffff, def.sky, 0.5)));

    const sd = (x, z) => zoneSd(zone, x, z);
    const b = zone.bounds;

    // --- 地面：只在可行走区域及其外缘铺一张规则网格，用顶点色做边缘压暗和向虚空的渐隐 ---
    const pathL = lin(def.path), voidL = lin(def.voidc), VOID_K = 2.0;
    // 虚空的顶点色倍率：贴图本身带着路面颜色，乘上这个倍率后接近 voidc
    const vm = [
      Math.min(1, (voidL.r * VOID_K) / (pathL.r * 0.8)),
      Math.min(1, (voidL.g * VOID_K) / (pathL.g * 0.8)),
      Math.min(1, (voidL.b * VOID_K) / (pathL.b * 0.8)),
    ];
    const SKIRT = 2.8, CS = 0.8, M = 5;
    const x0 = b.minX - M, z0 = b.minZ - M;
    const nx = Math.ceil((b.maxX - b.minX + 2 * M) / CS), nz = Math.ceil((b.maxZ - b.minZ + 2 * M) / CS);
    const sx = nx + 1;
    const sdv = new Float32Array(sx * (nz + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) sdv[j * sx + i] = sd(x0 + i * CS, z0 + j * CS);
    const vid = new Int32Array(sx * (nz + 1)).fill(-1);
    const pos = [], uv = [], col = [], idx = [];
    const vert = (i, j) => {
      const k = j * sx + i;
      if (vid[k] >= 0) return vid[k];
      const x = x0 + i * CS, z = z0 + j * CS, d = sdv[k];
      const n = 0.84 + 0.3 * vnoise(x * 0.09 + 7.3, z * 0.09 - 2.1);
      const ao = 0.5 + 0.5 * smooth01(d / 2.6); // 靠近岩壁的地面更暗
      let kk = d >= 0 ? 1 : smooth01(1 + d / SKIRT);
      kk *= kk;
      const lit = n * ao;
      pos.push(x, 0, z);
      uv.push(x / TILE, -z / TILE);
      col.push(vm[0] + (lit - vm[0]) * kk, vm[1] + (lit - vm[1]) * kk, vm[2] + (lit - vm[2]) * kk);
      return (vid[k] = pos.length / 3 - 1);
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * sx + i;
        if (Math.max(sdv[k], sdv[k + 1], sdv[k + sx], sdv[k + sx + 1]) < -SKIRT) continue;
        const a = vert(i, j), bb = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
        idx.push(a, d, c, a, c, bb);
      }
    }
    const gg = own(new T.BufferGeometry());
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    gg.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    gg.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    gg.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    gg.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    gg.setIndex(pos.length / 3 > 65535 ? new T.Uint32BufferAttribute(idx, 1) : new T.Uint16BufferAttribute(idx, 1));
    const gmat = own(
      new T.MeshStandardMaterial({
        map: tx.map, bumpMap: tx.bump, bumpScale: st.bump, emissiveMap: tx.emis,
        emissive: lin(def.accent), emissiveIntensity: st.emis,
        roughness: st.rough, metalness: 0, vertexColors: true,
      })
    );
    // 发光裂纹只留在路面上，虚空里跟着顶点色一起熄灭
    gmat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= smoothstep( 0.2, 0.62, vColor.g );'
      );
    };
    const ground = new T.Mesh(gg, gmat);
    ground.receiveShadow = true;
    zoneGroup.add(ground);

    // --- 虚空底板：同一张贴图、同一倍率，和地面外缘无缝衔接 ---
    const VM = 220;
    const vx0 = b.minX - VM, vx1 = b.maxX + VM, vz0 = b.minZ - VM, vz1 = b.maxZ + VM;
    const vg = own(new T.BufferGeometry());
    vg.setAttribute('position', new T.Float32BufferAttribute([vx0, 0, vz0, vx0, 0, vz1, vx1, 0, vz1, vx1, 0, vz0], 3));
    vg.setAttribute('normal', new T.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    vg.setAttribute('uv', new T.Float32BufferAttribute([vx0 / TILE, -vz0 / TILE, vx0 / TILE, -vz1 / TILE, vx1 / TILE, -vz1 / TILE, vx1 / TILE, -vz0 / TILE], 2));
    vg.setIndex([0, 1, 2, 0, 2, 3]);
    const vmat = own(
      new T.MeshStandardMaterial({ map: tx.map, bumpMap: tx.bump, bumpScale: st.bump, color: new T.Color(vm[0], vm[1], vm[2]), roughness: 1, metalness: 0 })
    );
    const voidMesh = new T.Mesh(vg, vmat);
    voidMesh.position.y = -0.04;
    voidMesh.receiveShadow = true;
    zoneGroup.add(voidMesh);

    // --- 沿每条不可行走的边采样 ---
    // 在所有圆周和走廊两侧、向外偏移 off 处按间距取点
    const ringSamples = (spacing, off, cb) => {
      for (const c of zone.circles) {
        const rr = c.r + off, n = Math.max(6, Math.floor((TAU * rr) / spacing));
        const a0 = Math.random() * TAU;
        for (let k = 0; k < n; k++) {
          const a = a0 + ((k + rand(-0.3, 0.3)) / n) * TAU;
          cb(c.x + Math.sin(a) * rr, c.z + Math.cos(a) * rr);
        }
      }
      for (const s of zone.segs) {
        const ex = s.bx - s.ax, ez = s.bz - s.az, len = Math.hypot(ex, ez);
        const ux = ex / len, uz = ez / len;
        for (let t = rand(0, spacing); t < len; t += spacing) {
          const tt = t + rand(-0.3, 0.3) * spacing;
          for (let side = -1; side <= 1; side += 2) {
            cb(s.ax + ux * tt - uz * side * (s.hw + off), s.az + uz * tt + ux * side * (s.hw + off));
          }
        }
      }
    };

    // --- 岩石：内圈小、外圈大，再加一圈稀疏的尖岩 ---
    // 相机从 +z 方向俯视：可行走区域南缘（靠近镜头一侧）的高物会挡住战场，所以压矮
    const lowK = (x, z) => (sd(x, z - 4.5) > sd(x, z) + 2 ? 0.5 : 1);
    const rocksA = [], rocksB = [], spires = [];
    const pushRock = (x, z, s, tall) => {
      const list = Math.random() < 0.5 ? rocksA : rocksB;
      const sy = s * rand(0.65, 1.05) * tall;
      list.push(x, sy * 0.28, z, rand(-0.3, 0.3), rand(0, TAU), rand(-0.3, 0.3), s * rand(0.85, 1.2), sy, s * rand(0.85, 1.2), rand(0.7, 1.12));
    };
    ringSamples(1.2, 0.72, (x, z) => {
      if (sd(x, z) > -0.5) return;
      pushRock(x + rand(-0.2, 0.2), z + rand(-0.2, 0.2), rand(0.5, 0.85), 1);
    });
    ringSamples(1.9, 2.2, (x, z) => {
      if (sd(x, z) > -1.75) return;
      const lk = lowK(x, z);
      if (Math.random() < 0.28) {
        const s = rand(0.8, 1.3);
        spires.push(x, -0.2, z, rand(-0.18, 0.18), rand(0, TAU), rand(-0.18, 0.18), s, s * rand(0.9, 1.6) * lk, s, rand(0.6, 1.0));
      } else pushRock(x + rand(-0.4, 0.4), z + rand(-0.4, 0.4), rand(1.0, 1.65), rand(1, 1.35) * (lk < 1 ? 0.75 : 1));
    });
    ringSamples(4.2, 4.6, (x, z) => {
      x += rand(-1.2, 1.2);
      z += rand(-1.2, 1.2);
      if (sd(x, z) > -3.6 || Math.random() < 0.3) return;
      const s = rand(1.2, 2.0);
      spires.push(x, -0.3, z, rand(-0.22, 0.22), rand(0, TAU), rand(-0.22, 0.22), s, s * rand(0.9, 1.6) * lowK(x, z), s, rand(0.4, 0.75));
    });
    const rockMat = own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0, flatShading: true }));
    const rockTint = lin(def.rock);
    instanced(rockGeoA(), rockMat, rocksA, true, rockTint);
    instanced(rockGeoB(), rockMat, rocksB, true, rockTint);
    instanced(spireGeo(), rockMat, spires, true, rockTint);

    // --- 主题摆件 ---
    const props = [];
    ringSamples(6.5, 4.2, (x, z) => {
      x += rand(-1.5, 1.5);
      z += rand(-1.5, 1.5);
      if (sd(x, z) > -3.0 || Math.random() < 0.3) return;
      const s = rand(0.85, 1.6);
      props.push(x, -0.1, z, rand(-0.1, 0.1), rand(0, TAU), rand(-0.1, 0.1), s, s * rand(0.9, 1.3) * (lowK(x, z) < 1 ? 0.65 : 1), s, 1);
    });
    const icy = def.id === 'frost';
    const propMat = own(
      new T.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: icy ? 0.25 : 0.9, metalness: icy ? 0.1 : 0,
        emissive: lin(def.accent), emissiveIntensity: icy ? 0.22 : def.id === 'abyss' ? 0.1 : 0,
      })
    );
    instanced(propGeo(def.id), propMat, props, true, null);

    // --- 发光水晶簇 + 地面光晕 ---
    const crystals = [], glows = [];
    ringSamples(8.5, 1.6, (x, z) => {
      if (sd(x, z) > -1.1 || Math.random() < 0.3) return;
      const h = rand(0.9, 1.6);
      crystals.push(x, h * 0.45, z, rand(-0.25, 0.25), rand(0, TAU), rand(-0.25, 0.25), 0.26, h, 0.26, 1);
      const n = G.randInt(1, 3);
      for (let k = 0; k < n; k++) {
        const a = rand(0, TAU), hh = h * rand(0.4, 0.7);
        crystals.push(x + Math.sin(a) * 0.4, hh * 0.4, z + Math.cos(a) * 0.4, Math.cos(a) * 0.5, rand(0, TAU), -Math.sin(a) * 0.5, 0.18, hh, 0.18, 1);
      }
      const gr = rand(2.6, 3.8);
      glows.push(x, 0.05, z, 0, 0, 0, gr, 1, gr, 1);
    });
    const accentL = lin(def.accent);
    const crystalMat = own(
      new T.MeshStandardMaterial({ color: accentL.clone().multiplyScalar(0.3), emissive: accentL, emissiveIntensity: 1.0, roughness: 0.3, flatShading: true, toneMapped: false })
    );
    instanced(gOct(1), crystalMat, crystals, true, null);
    const glowMat = own(
      new T.MeshBasicMaterial({ map: glowTex(), color: accentL, transparent: true, opacity: 0.4, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false })
    );
    const glowIM = instanced(gQuad(), glowMat, glows, false, null);
    if (glowIM) glowIM.renderOrder = 1;

    // --- 地面暗斑 ---
    const blots = [];
    const blot = (x, z, r) => blots.push(x, 0.02, z, 0, rand(0, TAU), 0, r, 1, r * rand(0.6, 1), 1);
    zone.circles.forEach((c) => {
      for (let k = 0; k < 6; k++) {
        const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (c.r - 2.5);
        blot(c.x + Math.sin(a) * d, c.z + Math.cos(a) * d, rand(1.6, 4.2));
      }
    });
    for (const s of zone.segs) {
      for (let k = 0; k < 2; k++) {
        const t = rand(0.3, 0.7);
        blot(s.ax + (s.bx - s.ax) * t + rand(-1, 1), s.az + (s.bz - s.az) * t + rand(-1, 1), rand(1.4, 2.6));
      }
    }
    const blotMat = own(
      new T.MeshBasicMaterial({ map: blotchTex(), color: lin(mixHex(def.voidc, 0x000000, 0.4)), transparent: true, opacity: 0.38, depthWrite: false })
    );
    const blotIM = instanced(gQuad(), blotMat, blots, false, null);
    if (blotIM) blotIM.renderOrder = 1;

    // --- 法阵：首领竞技场（主题色）和起点（淡色） ---
    const sigil = (x, z, r, hex, op) => {
      const m = own(
        new T.MeshBasicMaterial({ map: sigilTex(), color: lin(hex), transparent: true, opacity: op, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false })
      );
      const q = new T.Mesh(gQuad(), m);
      q.position.set(x, 0.03, z);
      q.scale.set(r, 1, r);
      q.renderOrder = 1;
      zoneGroup.add(q);
      return q;
    };
    const bossSigil = sigil(zone.bossPos.x, zone.bossPos.z, zone.bossR * 0.84, def.accent, 0.26);
    sigil(zone.start.x, zone.start.z, 3.4, mixHex(def.sky, 0xffffff, 0.3), 0.16);

    _c.set(def.accent);
    zoneFx = {
      st, crystalMat, glowMat, bossSigil,
      ar: _c.r, ag: _c.g, ab: _c.b,
      ambAcc: 0, boltIn: rand(3, 7), boltT: 0,
    };
  }

  W.buildZone = function (def, level) {
    disposeZone();
    W.clearFx();
    const L = layoutZone();
    const boss = L.circles[5];
    const zone = {
      def, level,
      circles: L.circles, segs: L.segs,
      start: { x: 0, z: 0 },
      bossPos: { x: boss.x, z: boss.z }, bossR: boss.r,
      bounds: L.bounds,
    };
    W.zone = zone;
    buildVisuals(zone);
    buildMinimap(zone);
    camSnap = true;
    return zone;
  };


  // =====================================================================
  // 实体：程序化骨架 + 姿态动画
  // =====================================================================
  // 一只生物 = 两个共用一套骨骼的网格（受光的躯体 + 自发光部件）。所有零件烘焙进同一个几何体，
  // 每个顶点刚性绑定一根骨骼；骨骼矩阵由下面的姿态系统每帧算好，作为 uniform 数组交给着色器。
  // 这样一只怪无论有多少个关节和零件，都只有 2 次绘制（外加 1 次阴影）。
  const flashing = [];
  const WH = 0xffffff;
  const CH = 9; // 每个关节的姿态通道：rx ry rz（欧拉 XYZ）、ox oy oz（位移）、sx sy sz（缩放）
  const CHI = { rx: 0, ry: 1, rz: 2, ox: 3, oy: 4, oz: 5, sx: 6, sy: 7, sz: 8 };
  const NB_SMALL = 24, NB_BIG = 44; // 着色器里骨骼数组的长度（小怪 / 玩家与首领），同一档共用一个着色器程序
  const _m3 = new T.Matrix3();

  // 表面类型：[粗糙度, 金属度, 顶点色抖动]
  const SURF = {
    cloth: [0.96, 0, 0.07], leather: [0.74, 0.03, 0.05], hide: [0.82, 0, 0.07], bone: [0.52, 0.02, 0.05],
    stone: [0.9, 0.03, 0.1], chitin: [0.34, 0.25, 0.05], metal: [0.4, 0.8, 0.04], gold: [0.32, 0.9, 0.03],
    dark: [0.5, 0.55, 0.04], ice: [0.14, 0.2, 0.05], glow: [0.4, 0, 0],
  };

  // ----- 造型用的几何体（都走缓存） -----
  const gSph = (r, w = 10, h = 7) => geo(`s${r},${w},${h}`, () => new T.SphereGeometry(r, w, h));
  // 半球 / 球冠：ang 是从顶点往下张开的角度
  const gDome = (r, w = 10, h = 5, ang = Math.PI / 2) => geo(`d${r},${w},${h},${ang}`, () => new T.SphereGeometry(r, w, h, 0, TAU, 0, ang));
  // 车削体：pts = [[半径, 高度], ...]（自下而上）
  const gLathe = (key, pts, seg = 10) => geo('L' + key, () => new T.LatheGeometry(pts.map((p) => new T.Vector2(p[0], p[1])), seg));
  // 带倒角的板片：pts 是 XY 平面上的轮廓（逆时针），沿 z 方向有厚度并居中
  const gPlate = (key, pts, depth, bevel = 0.02) =>
    geo('P' + key, () => {
      const sh = new T.Shape();
      pts.forEach((p, i) => (i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1])));
      sh.closePath();
      const g = new T.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, steps: 1, curveSegments: 4 });
      g.translate(0, 0, -depth / 2);
      return g;
    });
  // 倒角方块（石板、甲片）：外尺寸 w×h×d
  const gRBox = (w, h, d, bv = 0.04) =>
    gPlate(`rb${w},${h},${d},${bv}`, [[-w / 2 + bv, -h / 2 + bv], [w / 2 - bv, -h / 2 + bv], [w / 2 - bv, h / 2 - bv], [-w / 2 + bv, h / 2 - bv]], d - bv * 2, bv);
  // 沿折线扫出一根粗细渐变的弯管（角、尾、爪、肋骨）。pts: [[x,y,z],...]；radii 与 pts 等长
  function gSweep(key, pts, radii, radial = 6, sub = 3) {
    return geo('W' + key, () => {
      const curve = new T.CatmullRomCurve3(pts.map((p) => new T.Vector3(p[0], p[1], p[2])), false, 'centripetal');
      const n = (pts.length - 1) * sub;
      const pos = [], nor = [], idx = [];
      const tan = new T.Vector3(), nrm = new T.Vector3(), bin = new T.Vector3(), prevT = new T.Vector3(), pt = new T.Vector3(), q = new T.Quaternion();
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        curve.getPoint(u, pt);
        curve.getTangent(u, tan);
        if (i === 0) {
          nrm.set(Math.abs(tan.y) < 0.9 ? 0 : 1, Math.abs(tan.y) < 0.9 ? 1 : 0, 0);
          nrm.crossVectors(tan, nrm).normalize();
        } else {
          nrm.applyQuaternion(q.setFromUnitVectors(prevT, tan)); // 平行移动，弯管不会扭麻花
        }
        prevT.copy(tan);
        bin.crossVectors(tan, nrm);
        const f = u * (radii.length - 1), i0 = Math.min(radii.length - 2, Math.floor(f));
        const r = radii[i0] + (radii[i0 + 1] - radii[i0]) * (f - i0);
        for (let k = 0; k < radial; k++) {
          const a = (k / radial) * TAU, ca = Math.cos(a), sa = Math.sin(a);
          const nx = nrm.x * ca + bin.x * sa, ny = nrm.y * ca + bin.y * sa, nz = nrm.z * ca + bin.z * sa;
          pos.push(pt.x + nx * r, pt.y + ny * r, pt.z + nz * r);
          nor.push(nx, ny, nz);
        }
        if (i === 0 || i === n) {
          // 端面：中心点 + 一圈重复顶点（法线沿切线）
          const s = i === 0 ? -1 : 1, base = pos.length / 3;
          pos.push(pt.x, pt.y, pt.z);
          nor.push(tan.x * s, tan.y * s, tan.z * s);
          for (let k = 0; k < radial; k++) {
            const ring = base - radial + k; // 复用刚写入的那一圈坐标
            pos.push(pos[ring * 3], pos[ring * 3 + 1], pos[ring * 3 + 2]);
            nor.push(tan.x * s, tan.y * s, tan.z * s);
          }
          for (let k = 0; k < radial; k++) {
            const a = base + 1 + k, b = base + 1 + ((k + 1) % radial);
            if (i === 0) idx.push(base, b, a);
            else idx.push(base, a, b);
          }
        }
      }
      // 侧面：每一圈在顶点数组里的起点（第 0 圈之后多插了 radial+1 个端面顶点）
      const ringAt = (i) => (i === 0 ? 0 : i * radial + radial + 1);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < radial; k++) {
          const a = ringAt(i) + k, b = ringAt(i) + ((k + 1) % radial), c = ringAt(i + 1) + k, d = ringAt(i + 1) + ((k + 1) % radial);
          idx.push(a, b, c, b, d, c);
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
      g.setIndex(idx);
      return g;
    });
  }

  // ----- 骨架定义 + 零件烘焙 -----
  // 用法：b.j(关节名, 父关节, 枢轴 x,y,z)；b.at(关节).surf(表面).p(几何体, 颜色, 位置…, 旋转…, 缩放…)
  // 所有坐标都是模型空间里的绑定姿态（面朝 +z，+x 是它的左手边，脚踩 y = 0）。
  function rigBuilder(key, NB) {
    const joints = [], JI = Object.create(null);
    const body = [], glow = [], aux = [];
    let curJ = 0, curS = SURF.cloth, curF = false;
    const mk = (g, c, x, y, z, rx, ry, rz, sx, sy, sz) => ({
      g, c, j: curJ, s: curS, f: curF,
      m: [x || 0, y || 0, z || 0, rx || 0, ry || 0, rz || 0, sx === undefined ? 1 : sx, sy === undefined ? (sx === undefined ? 1 : sx) : sy, sz === undefined ? (sx === undefined ? 1 : sx) : sz],
    });
    const B = {
      j(name, parent, x, y, z) {
        const pi = parent === null ? -1 : JI[parent];
        if (pi === undefined) throw new Error('rig ' + key + ': 未定义的父关节 ' + parent);
        const pj = pi < 0 ? null : joints[pi];
        JI[name] = joints.length;
        joints.push({ name, parent: pi, px: x, py: y, pz: z, lx: x - (pj ? pj.px : 0), ly: y - (pj ? pj.py : 0), lz: z - (pj ? pj.pz : 0) });
        return B;
      },
      at(name) {
        if (JI[name] === undefined) throw new Error('rig ' + key + ': 未定义的关节 ' + name);
        curJ = JI[name];
        return B;
      },
      // flat = true 时按面重算法线（硬朗的石头 / 晶体 / 甲片）
      surf(s, flat) {
        curS = s;
        curF = !!flat;
        return B;
      },
      // 受光零件。颜色可以是一个十六进制数，或 [下端色, 上端色] 的竖向渐变
      p(g, c, x, y, z, rx, ry, rz, sx, sy, sz) {
        body.push(mk(g, c, x, y, z, rx, ry, rz, sx, sy, sz));
        return B;
      },
      // 双面零件（披风、旗幡）：外侧 c，内侧 ci
      pd(g, c, ci, x, y, z, rx, ry, rz, sx, sy, sz) {
        const part = mk(g, c, x, y, z, rx, ry, rz, sx, sy, sz);
        part.ci = ci;
        body.push(part);
        return B;
      },
      // 第二组自发光零件，用独立材质（玩家武器上随稀有度变色的部分）
      x(g, k, x, y, z, rx, ry, rz, sx, sy, sz) {
        const part = mk(g, 0, x, y, z, rx, ry, rz, sx, sy, sz);
        part.k = k;
        part.s = SURF.glow;
        aux.push(part);
        return B;
      },
      // 自发光零件：k 是亮度（1 = 元素色全亮）
      g(g, k, x, y, z, rx, ry, rz, sx, sy, sz) {
        const part = mk(g, 0, x, y, z, rx, ry, rz, sx, sy, sz);
        part.k = k;
        part.s = SURF.glow;
        glow.push(part);
        return B;
      },
      // 两点之间的一段肢体：渐变粗细的圆柱 + 两端的球形关节
      limb(c, ax, ay, az, bx, by, bz, r0, r1, seg = 7, caps = 3, glowK) {
        _v.set(bx - ax, by - ay, bz - az);
        const len = _v.length();
        _q.setFromUnitVectors(UP, _v.divideScalar(len));
        _e.setFromQuaternion(_q);
        const add = (g, x, y, z, rx, ry, rz, sx, sy, sz) => (glowK ? B.g(g, glowK, x, y, z, rx, ry, rz, sx, sy, sz) : B.p(g, c, x, y, z, rx, ry, rz, sx, sy, sz));
        add(gCyl(r1, r0, 1, seg), (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, _e.x, _e.y, _e.z, 1, len, 1);
        if (caps & 1) add(gSph(1, seg + 1, 5), ax, ay, az, 0, 0, 0, r0);
        if (caps & 2) add(gSph(1, seg + 1, 5), bx, by, bz, 0, 0, 0, r1);
        return B;
      },
      build(o) {
        const bake1 = (list, isGlow) => {
          if (!list.length) return null;
          // 双面零件展开成正反两份：反面翻转绕序和法线，用内侧颜色
          const parts = [];
          for (const p of list) {
            parts.push(p);
            if (p.ci !== undefined) parts.push(Object.assign({}, p, { c: p.ci, inv: true }));
          }
          const srcs = [];
          let n = 0;
          for (const p of parts) {
            const s = p.g.index ? p.g.toNonIndexed() : p.g;
            srcs.push(s);
            n += s.attributes.position.count;
          }
          const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
          const bone = new Float32Array(n), surf = new Float32Array(n * 2);
          const cA = new T.Color(), cB = new T.Color();
          let v = 0;
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i], m = p.m, s = srcs[i];
            _e.set(m[3], m[4], m[5]);
            _m4.compose(_v.set(m[0], m[1], m[2]), _q.setFromEuler(_e), _s.set(m[6], m[7], m[8]));
            _m3.getNormalMatrix(_m4);
            const a = s.attributes.position, an = s.attributes.normal, v0 = v;
            let y0 = 1e9, y1 = -1e9;
            for (let k = 0; k < a.count; k++, v++) {
              _v2.fromBufferAttribute(a, k).applyMatrix4(_m4);
              pos[v * 3] = _v2.x; pos[v * 3 + 1] = _v2.y; pos[v * 3 + 2] = _v2.z;
              if (_v2.y < y0) y0 = _v2.y;
              if (_v2.y > y1) y1 = _v2.y;
              if (an && !p.f) {
                _v2.fromBufferAttribute(an, k).applyMatrix3(_m3).normalize();
                nor[v * 3] = _v2.x; nor[v * 3 + 1] = _v2.y; nor[v * 3 + 2] = _v2.z;
              }
              bone[v] = p.j;
              surf[v * 2] = p.s[0];
              surf[v * 2 + 1] = p.s[1];
            }
            // 镜像（负缩放）会把面翻过去：把每个三角形的后两个顶点对调回来
            if (m[6] * m[7] * m[8] < 0 !== !!p.inv) {
              for (let k = v0; k < v; k += 3) {
                for (let c = 0; c < 3; c++) {
                  const i1 = (k + 1) * 3 + c, i2 = (k + 2) * 3 + c;
                  let t = pos[i1]; pos[i1] = pos[i2]; pos[i2] = t;
                  t = nor[i1]; nor[i1] = nor[i2]; nor[i2] = t;
                }
              }
            }
            if (p.inv && an && !p.f) for (let k = v0 * 3; k < v * 3; k++) nor[k] = -nor[k];
            if (p.f || !an) {
              for (let k = v0; k < v; k += 3) {
                const o3 = k * 3;
                _v.set(pos[o3 + 3] - pos[o3], pos[o3 + 4] - pos[o3 + 1], pos[o3 + 5] - pos[o3 + 2]);
                _v2.set(pos[o3 + 6] - pos[o3], pos[o3 + 7] - pos[o3 + 1], pos[o3 + 8] - pos[o3 + 2]);
                _v.cross(_v2).normalize();
                for (let c = 0; c < 3; c++) {
                  nor[o3 + c * 3] = _v.x; nor[o3 + c * 3 + 1] = _v.y; nor[o3 + c * 3 + 2] = _v.z;
                }
              }
            }
            // 顶点色：纯色或竖向渐变，再按位置做一点明暗抖动，免得大色块发平
            const grad = Array.isArray(p.c);
            if (isGlow) cA.setScalar(p.k);
            else if (grad) {
              cA.set(p.c[0]).convertSRGBToLinear();
              cB.set(p.c[1]).convertSRGBToLinear();
            } else cA.set(p.c).convertSRGBToLinear();
            const jit = isGlow ? 0 : p.s[2], span = Math.max(1e-4, y1 - y0);
            for (let k = v0; k < v; k++) {
              const px = pos[k * 3], py = pos[k * 3 + 1], pz = pos[k * 3 + 2];
              let r = cA.r, g = cA.g, bl = cA.b;
              if (grad && !isGlow) {
                const t = (py - y0) / span;
                r += (cB.r - r) * t; g += (cB.g - g) * t; bl += (cB.b - bl) * t;
              }
              if (jit) {
                const h = Math.sin(px * 91.7 + py * 57.3 + pz * 133.1) * 43758.5453;
                const kk = 1 + (h - Math.floor(h) - 0.5) * jit * 2;
                r *= kk; g *= kk; bl *= kk;
              }
              // 贴近地面的部分压暗一点（假的环境光遮蔽）
              if (!isGlow && o.shade) {
                const sh = 1 - o.shade * (1 - smooth01(py / (o.height * 0.45)));
                r *= sh; g *= sh; bl *= sh;
              }
              col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = bl;
            }
          }
          const g = new T.BufferGeometry();
          g.setAttribute('position', new T.BufferAttribute(pos, 3));
          g.setAttribute('normal', new T.BufferAttribute(nor, 3));
          g.setAttribute('color', new T.BufferAttribute(col, 3));
          g.setAttribute('aBone', new T.BufferAttribute(bone, 1));
          g.setAttribute('aSurf', new T.BufferAttribute(surf, 2));
          // 动作会把肢体甩出绑定姿态的范围：包围球放大到不会被错误裁掉
          g.boundingSphere = new T.Sphere(new T.Vector3(0, o.height * 0.5, 0), o.height * 0.5 + (o.reach || 1.5));
          return g;
        };
        const nJ = joints.length;
        if (nJ > NB) throw new Error('rig ' + key + ': 关节数 ' + nJ + ' 超过 ' + NB);
        const rest = new Float32Array(nJ * CH);
        for (let i = 0; i < nJ; i++) rest[i * CH + 6] = rest[i * CH + 7] = rest[i * CH + 8] = 1;
        const J = Object.create(null);
        for (const name in JI) J[name] = JI[name] * CH;
        const geoBody = bake1(body, false), geoGlow = bake1(glow, true), geoAux = bake1(aux, true);
        const cnt = (g) => (g ? g.attributes.position.count / 3 : 0);
        return {
          key, NB, joints, JI, J, nJ, rest, geoBody, geoGlow, geoAux,
          tris: cnt(geoBody) + cnt(geoGlow) + cnt(geoAux),
          height: o.height, stride: o.stride || 3, clips: Object.create(null), loco: null, post: null, late: null,
          sockets: Object.create(null), hitJ: null, feet: null, ankle: 0,
        };
      },
    };
    return B;
  }
  const rigCache = Object.create(null);
  const rigOf = (key, make) => rigCache[key] || (rigCache[key] = make());

  // ----- 关键帧 -----
  // K = [k0, v0, k1, v1, ...]，段内默认缓入缓出；时间写成负数表示「加速冲到这一帧」（出手、落地）
  function kf(K, k) {
    const n = K.length;
    let ka = K[0] < 0 ? -K[0] : K[0];
    if (k <= ka) return K[1];
    for (let i = 2; i < n; i += 2) {
      const kb = K[i] < 0 ? -K[i] : K[i];
      if (k <= kb) {
        let t = (k - ka) / (kb - ka);
        t = K[i] < 0 ? t * t * t : t * t * (3 - 2 * t);
        return K[i - 1] + (K[i + 1] - K[i - 1]) * t;
      }
      ka = kb;
    }
    return K[n - 1];
  }
  // a..b 之间从 0 平滑升到 1
  const ramp = (k, a, b) => smooth01((k - a) / (b - a));
  // a→b 升起，c→d 落下
  const hump = (k, a, b, c, d) => (k < c ? smooth01((k - a) / (b - a)) : 1 - smooth01((k - c) / (d - c)));

  // 注册一个动作。spec：
  //   dur 默认时长；k0 「命中帧」在归一化时间里的位置（W.play 的 contact 用它做时间重映射）
  //   loop / hold 默认的循环与定格；fade / out 切入与切出的过渡时间
  //   base：'loco'（在移动姿态之上叠加，默认）| 'rest'（从绑定姿态开始，全身动作）
  //   keys：{ '关节.通道': [k, v, ...] }，通道为 rx ry rz ox oy oz sx sy sz，或 s（三轴等比缩放）
  //   lower：这些关节在角色实际移动时让位给步态（边走边打时腿继续迈步）
  //   air：腾空 / 倒地的动作，播放期间不做贴地修正
  //   trail：[k0, k1] 这段归一化时间里武器拖出刀光（只有玩家用）
  //   clear：[[关节, x, y, z, 半径], ...] 这些球不许钻进地面——腾空的翻滚里头朝下那一段，骨盆会被自动托高
  //   fn(ent, p, k, t)：关键帧之后的程序化补充
  function defClip(rig, name, spec) {
    const ci = [], cK = [], cLow = [];
    for (const key in spec.keys || {}) {
      const dot = key.indexOf('.'), jn = key.slice(0, dot), c = key.slice(dot + 1);
      if (rig.JI[jn] === undefined) throw new Error('rig ' + rig.key + ' / ' + name + ': 未定义的关节 ' + jn);
      const low = spec.lower && spec.lower.indexOf(jn) >= 0 ? 1 : 0;
      const list = c === 's' ? [6, 7, 8] : [CHI[c]];
      if (list[0] === undefined) throw new Error('rig ' + rig.key + ' / ' + name + ': 未知通道 ' + key);
      for (const ch of list) {
        ci.push(rig.JI[jn] * CH + ch);
        cK.push(spec.keys[key]);
        cLow.push(low);
      }
    }
    rig.clips[name] = {
      name, dur: spec.dur || 0.5, k0: spec.k0 || 0.5, loop: !!spec.loop, hold: !!spec.hold,
      fade: spec.fade === undefined ? 0.09 : spec.fade, out: spec.out === undefined ? 0.18 : spec.out,
      base: spec.base || 'loco', air: spec.air || false, ci, cK, cLow, fn: spec.fn || null,
      trail: spec.trail || null,
      clear: spec.clear
        ? spec.clear.map((c) => {
          if (rig.JI[c[0]] === undefined) throw new Error('rig ' + rig.key + ' / ' + name + ': 未定义的关节 ' + c[0]);
          return { j: rig.JI[c[0]], x: c[1], y: c[2], z: c[3], r: c[4] };
        })
        : null,
    };
  }
  const aliasClip = (rig, name, target) => (rig.clips[name] = rig.clips[target]);

  // ----- 着色器注入：刚性蒙皮 + 逐顶点粗糙/金属度 + 轮廓光 + 消散 -----
  const RIG_VERT_PARS = 'attribute float aBone;\nattribute vec2 aSurf;\nuniform mat4 uBones[ NB ];\nvarying vec2 vSurf;\nvarying vec3 vBP;\n';
  const RIG_FRAG_PARS = 'varying vec2 vSurf;\nvarying vec3 vBP;\nuniform vec3 uRim;\nuniform vec4 uDis;\n';
  const RIG_FRAG = [
    '#include <emissivemap_fragment>',
    'roughnessFactor = vSurf.x;',
    'metalnessFactor = vSurf.y;',
    // 轮廓光：俯视镜头下把身形从暗色地面上勾出来
    'float rigRim = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );',
    'totalEmissiveRadiance += uRim * rigRim * rigRim * rigRim;',
    // 死亡消散：按绑定姿态下的小方格逐块烧掉，边缘发亮
    'if ( uDis.a > 0.0 ) {',
    '  vec3 dq = floor( vBP * 9.0 );',
    '  float dn = fract( sin( dot( dq, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );',
    '  if ( dn < uDis.a ) discard;',
    '  totalEmissiveRadiance += uDis.rgb * ( 1.0 - smoothstep( uDis.a, uDis.a + 0.25, dn ) ) * 2.5;',
    '}',
  ].join('\n');
  function injectLit(sh, ent) {
    sh.uniforms.uBones = ent.uBones;
    sh.uniforms.uRim = ent.uRim;
    sh.uniforms.uDis = ent.uDis;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + RIG_VERT_PARS)
      .replace('#include <beginnormal_vertex>', 'mat4 boneM = uBones[ int( aBone + 0.5 ) ];\nvec3 objectNormal = mat3( boneM ) * normal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = ( boneM * vec4( position, 1.0 ) ).xyz;\nvSurf = aSurf;\nvBP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + RIG_FRAG_PARS)
      .replace('#include <emissivemap_fragment>', RIG_FRAG);
  }
  function injectDepth(sh, ent) {
    sh.uniforms.uBones = ent.uBones;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBone;\nuniform mat4 uBones[ NB ];\n')
      .replace('#include <begin_vertex>', 'vec3 transformed = ( uBones[ int( aBone + 0.5 ) ] * vec4( position, 1.0 ) ).xyz;');
  }

  // 金属反光用的环境贴图：一张手画的天空渐变，经 PMREM 预滤波
  let rigEnv = null;
  function rigEnvMap() {
    if (rigEnv) return rigEnv;
    const c = makeCanvas(128, 64), g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, '#fff6e6');
    gr.addColorStop(0.3, '#b9b2ad');
    gr.addColorStop(0.5, '#5e5a5c');
    gr.addColorStop(0.56, '#2a2627');
    gr.addColorStop(1, '#0c0a0a');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 64);
    // 两团高光：一冷一暖，转动时金属面上有东西在滑
    const blob = (x, y, r, col) => {
      const b = g.createRadialGradient(x, y, 0, x, y, r);
      b.addColorStop(0, col);
      b.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = b;
      g.fillRect(0, 0, 128, 64);
    };
    blob(30, 14, 22, 'rgba(255,240,210,0.95)');
    blob(96, 20, 18, 'rgba(190,215,255,0.7)');
    const t = new T.CanvasTexture(c);
    t.mapping = T.EquirectangularReflectionMapping;
    t.encoding = T.sRGBEncoding;
    const pm = new T.PMREMGenerator(renderer);
    rigEnv = pm.fromEquirectangular(t).texture;
    pm.dispose();
    t.dispose();
    return rigEnv;
  }

  // ----- 建立实体 -----
  // tintHex：躯体整体染色；elemHex：自发光部件的元素色
  function newEnt(kind, rig, tintHex, elemHex, glowI) {
    const group = new T.Group();
    const body = new T.Group();
    group.add(body);
    scene.add(group);
    const n = rig.nJ * CH;
    const ent = {
      group, body, mats: [], parts: {}, kind, own: [], ring: null, flashT: 0, removed: false,
      rig, pose: new Float32Array(n), from: new Float32Array(n), out: new Float32Array(n),
      mdl: new Float32Array(rig.nJ * 12), bones: new Float32Array(rig.NB * 16),
      phase: Math.random() * TAU, clock: Math.random() * 20, walk: Math.random() * TAU,
      mv: 0, spd: 0, mdir: 0, lx: NaN, lz: NaN, k: 1, gnd: 1,
      clip: null, cT: 0, cDur: 1, cLoop: false, cHold: false, cDone: null, cContact: -1, fadeT: 1, fadeDur: 0,
      hitT: 0, hitDur: 0.3, hitX: 0, hitZ: 0, hitS: 0,
      timeScale: 1, dying: null, orphan: false, emb: 0, sock: null,
      cK: 0, flashD: 0.09, flashK: 1, shT: 0, shDur: 0, shAmp: 0,
      elemC: new T.Color(elemHex), glowBase: glowI, glowK: 1, bodyMat: null, glowMat: null, depthMat: null,
      uBones: null, uRim: { value: new T.Color(0) }, uDis: { value: new T.Vector4(1, 1, 1, 0) },
    };
    ent.uBones = { value: ent.bones };
    ent.pose.set(rig.rest);
    ent.from.set(rig.rest);
    ent.out.set(rig.rest);

    const bm = new T.MeshStandardMaterial({ color: lin(tintHex), vertexColors: true, roughness: 1, metalness: 0, envMap: rigEnvMap(), envMapIntensity: 0.9 });
    bm.defines.NB = rig.NB;
    bm.onBeforeCompile = function (sh) { injectLit(sh, ent); };
    bm.userData.e0 = new T.Color(0);
    bm.userData.ei0 = 1;
    bm.userData.fi = 0.3;
    const ec = lin(elemHex);
    const gm = new T.MeshStandardMaterial({ color: ec.clone().multiplyScalar(0.25), vertexColors: true, emissive: ec, emissiveIntensity: glowI, roughness: 0.4, metalness: 0, toneMapped: false });
    gm.defines.NB = rig.NB;
    gm.onBeforeCompile = function (sh) { injectLit(sh, ent); };
    gm.userData.e0 = ec.clone();
    gm.userData.ei0 = glowI;
    gm.userData.fi = 1.25;
    const dm = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
    dm.defines = { NB: rig.NB };
    dm.onBeforeCompile = function (sh) { injectDepth(sh, ent); };
    ent.mats.push(bm, gm);
    ent.own.push(dm);
    ent.bodyMat = bm;
    ent.glowMat = gm;
    ent.depthMat = dm;

    const mb = new T.Mesh(rig.geoBody, bm);
    mb.castShadow = true;
    mb.customDepthMaterial = dm;
    body.add(mb);
    ent.meshBody = mb;
    if (rig.geoGlow) {
      const mg = new T.Mesh(rig.geoGlow, gm);
      body.add(mg);
      ent.meshGlow = mg;
    }
    if (rig.geoAux) {
      const am = new T.MeshStandardMaterial({ color: 0x000000, vertexColors: true, emissive: new T.Color(1, 1, 1), emissiveIntensity: 1, roughness: 0.4, metalness: 0, toneMapped: false });
      am.defines.NB = rig.NB;
      am.onBeforeCompile = function (sh) { injectLit(sh, ent); };
      am.userData.e0 = new T.Color(1, 1, 1);
      am.userData.ei0 = 1;
      am.userData.fi = 1.25;
      ent.mats.push(am);
      ent.auxMat = am;
      body.add(new T.Mesh(rig.geoAux, am));
    }
    solveRig(ent);
    return ent;
  }
  // 自发光片的发光强度。受击闪白期间只改基准值，闪完自然恢复到新值
  function setGlow(ent, k) {
    const m = ent.glowMat;
    m.userData.ei0 = ent.glowBase * ent.glowK * k;
    if (ent.flashT <= 0) m.emissiveIntensity = m.userData.ei0;
  }
  // 贴地的加色方片（精英环、首领光晕、玩家脚环）
  function groundDisc(ent, map, hex, r, opacity) {
    const m = new T.MeshBasicMaterial({ map, color: lin(hex), transparent: true, opacity, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false });
    ent.own.push(m);
    const q = new T.Mesh(gQuad(), m);
    q.position.y = 0.06;
    q.scale.set(r, 1, r);
    q.renderOrder = 2;
    ent.group.add(q);
    return q;
  }

  // ----- 姿态求解：欧拉角 → 模型矩阵 → 骨骼矩阵 -----
  function solveRig(ent) {
    const js = ent.rig.joints, n = js.length, o = ent.out, M = ent.mdl, Bn = ent.bones;
    for (let i = 0; i < n; i++) {
      const j = js[i], c = i * CH, m = i * 12;
      const a = Math.cos(o[c]), b = Math.sin(o[c]), cy = Math.cos(o[c + 1]), d = Math.sin(o[c + 1]), e = Math.cos(o[c + 2]), f = Math.sin(o[c + 2]);
      const sx = o[c + 6], sy = o[c + 7], sz = o[c + 8];
      const l00 = cy * e * sx, l01 = -cy * f * sy, l02 = d * sz;
      const l10 = (a * f + b * e * d) * sx, l11 = (a * e - b * f * d) * sy, l12 = -b * cy * sz;
      const l20 = (b * f - a * e * d) * sx, l21 = (b * e + a * f * d) * sy, l22 = a * cy * sz;
      const tx = j.lx + o[c + 3], ty = j.ly + o[c + 4], tz = j.lz + o[c + 5];
      let m00, m01, m02, m10, m11, m12, m20, m21, m22, mx, my, mz;
      if (j.parent < 0) {
        m00 = l00; m01 = l01; m02 = l02; m10 = l10; m11 = l11; m12 = l12; m20 = l20; m21 = l21; m22 = l22;
        mx = tx; my = ty; mz = tz;
      } else {
        const q = j.parent * 12;
        const p00 = M[q], p01 = M[q + 1], p02 = M[q + 2], p10 = M[q + 4], p11 = M[q + 5], p12 = M[q + 6], p20 = M[q + 8], p21 = M[q + 9], p22 = M[q + 10];
        m00 = p00 * l00 + p01 * l10 + p02 * l20; m01 = p00 * l01 + p01 * l11 + p02 * l21; m02 = p00 * l02 + p01 * l12 + p02 * l22;
        m10 = p10 * l00 + p11 * l10 + p12 * l20; m11 = p10 * l01 + p11 * l11 + p12 * l21; m12 = p10 * l02 + p11 * l12 + p12 * l22;
        m20 = p20 * l00 + p21 * l10 + p22 * l20; m21 = p20 * l01 + p21 * l11 + p22 * l21; m22 = p20 * l02 + p21 * l12 + p22 * l22;
        mx = p00 * tx + p01 * ty + p02 * tz + M[q + 3];
        my = p10 * tx + p11 * ty + p12 * tz + M[q + 7];
        mz = p20 * tx + p21 * ty + p22 * tz + M[q + 11];
      }
      M[m] = m00; M[m + 1] = m01; M[m + 2] = m02; M[m + 3] = mx;
      M[m + 4] = m10; M[m + 5] = m11; M[m + 6] = m12; M[m + 7] = my;
      M[m + 8] = m20; M[m + 9] = m21; M[m + 10] = m22; M[m + 11] = mz;
      // 骨骼矩阵 = 模型矩阵 × 平移(−枢轴)，列主序
      const k = i * 16;
      Bn[k] = m00; Bn[k + 1] = m10; Bn[k + 2] = m20;
      Bn[k + 4] = m01; Bn[k + 5] = m11; Bn[k + 6] = m21;
      Bn[k + 8] = m02; Bn[k + 9] = m12; Bn[k + 10] = m22;
      Bn[k + 12] = mx - (m00 * j.px + m01 * j.py + m02 * j.pz);
      Bn[k + 13] = my - (m10 * j.px + m11 * j.py + m12 * j.pz);
      Bn[k + 14] = mz - (m20 * j.px + m21 * j.py + m22 * j.pz);
      Bn[k + 15] = 1;
    }
  }

  // ----- 动画推进 -----
  // 开始一段过渡：把当前输出姿态记为起点（角度折回 ±π，翻滚转满一圈后不会倒着转回来）
  function beginFade(ent, dur) {
    const f = ent.from, o = ent.out;
    for (let i = 0; i < o.length; i++) {
      let v = o[i];
      if (i % CH < 3 && (v > Math.PI || v < -Math.PI)) v -= Math.round(v / TAU) * TAU;
      f[i] = v;
    }
    ent.fadeT = 0;
    ent.fadeDur = dur;
  }
  function endClip(ent, done) {
    const c = ent.clip, fn = ent.cDone;
    ent.clip = null;
    ent.cDone = null;
    beginFade(ent, c.out);
    if (done && fn) fn(ent);
  }
  // sdt：受时间缩放影响的动画时间步；dist：这一帧实际走过的距离
  function advanceEnt(ent, sdt, moving, dist, ldx, ldz) {
    const rig = ent.rig, p = ent.pose;
    ent.clock += sdt;
    const t = ent.clock;
    ent.mv += ((moving ? 1 : 0) - ent.mv) * Math.min(1, sdt * 10);
    if (moving && sdt > 0) {
      ent.walk += dist * rig.stride * (ent.mdir > 1.9 || ent.mdir < -1.9 ? -1 : 1); // 倒退时步态反着走
      ent.spd += (dist / sdt - ent.spd) * Math.min(1, sdt * 10);
      if (dist > 1e-4) {
        // 移动方向相对朝向的夹角（玩家边打边退时腿朝移动方向迈）
        let a = Math.atan2(ldx, ldz) - ent.group.rotation.y - ent.mdir;
        a -= Math.round(a / TAU) * TAU;
        ent.mdir += a * Math.min(1, sdt * 14);
      }
    } else {
      ent.spd += (0 - ent.spd) * Math.min(1, sdt * 10);
    }

    let c = ent.clip;
    p.set(rig.rest);
    if (!c || c.base !== 'rest') rig.loco(ent, p, t, sdt);
    if (c) {
      ent.cT += sdt;
      let k = ent.cT / ent.cDur, ended = false;
      if (k >= 1) {
        if (ent.cLoop) {
          ent.cT -= ent.cDur * Math.floor(k);
          k = ent.cT / ent.cDur;
        } else {
          k = 1;
          ended = !ent.cHold;
        }
      }
      if (ent.cContact > 0 && !ent.cLoop) {
        // 把「命中帧」对到调用方给的时刻上
        const tc = ent.cContact;
        k = ent.cT < tc ? (ent.cT / tc) * c.k0 : c.k0 + (Math.min(ent.cT, ent.cDur) - tc) / (ent.cDur - tc) * (1 - c.k0);
      }
      ent.cK = k;
      const ci = c.ci, cK = c.cK, cLow = c.cLow, lw = 1 - ent.mv;
      for (let i = 0; i < ci.length; i++) {
        const v = kf(cK[i], k), ix = ci[i];
        p[ix] = cLow[i] ? p[ix] + (v - p[ix]) * lw : v;
      }
      if (c.fn) c.fn(ent, p, k, t);
      if (ended) {
        // 最后一帧照常输出，再开始往移动姿态过渡
        mixOut(ent);
        endClip(ent, true);
        finishPose(ent, t, sdt);
        return;
      }
    }
    if (ent.fadeT < ent.fadeDur) ent.fadeT += sdt;
    mixOut(ent);
    finishPose(ent, t, sdt);
  }
  function mixOut(ent) {
    const p = ent.pose, o = ent.out;
    if (ent.fadeT < ent.fadeDur) {
      const f = ent.from, w = smooth01(ent.fadeT / ent.fadeDur);
      for (let i = 0; i < o.length; i++) o[i] = f[i] + (p[i] - f[i]) * w;
    } else o.set(p);
  }
  function finishPose(ent, t, sdt) {
    const rig = ent.rig, o = ent.out;
    if (rig.post) rig.post(ent, o, t, sdt);
    // 受击：朝攻击行进的方向一仰，同时先压扁再回弹
    if (ent.hitT > 0) {
      ent.hitT -= sdt;
      const u = 1 - Math.max(0, ent.hitT) / ent.hitDur, s = ent.hitS;
      const env = u < 0.16 ? u / 0.16 : (1 - (u - 0.16) / 0.84) * (1 - (u - 0.16) / 0.84);
      const sq = -Math.sin(u * TAU) * (1 - u) * 0.2 * s; // 负 = 压扁，正 = 拉长
      const a = 0.36 * s * env;
      o[0] += ent.hitZ * a;
      o[2] -= ent.hitX * a;
      o[3] += ent.hitX * 0.14 * s * env;
      o[5] += ent.hitZ * 0.14 * s * env;
      o[7] *= 1 + sq;
      o[6] *= 1 - sq * 0.5;
      o[8] *= 1 - sq * 0.5;
      const hj = rig.hitJ;
      if (hj) {
        // 头和上身多甩一点，慢半拍
        const lag = u < 0.3 ? u / 0.3 : (1 - (u - 0.3) / 0.7) * (1 - (u - 0.3) / 0.7);
        for (let i = 0; i < hj.length; i++) {
          o[hj[i]] += ent.hitZ * 0.32 * s * lag;
          o[hj[i] + 2] -= ent.hitX * 0.32 * s * lag;
        }
      }
    }
    solveRig(ent);
    // 贴地：把骨盆抬高 / 压低到最低的那只脚正好踩在地面上（腾空的动作除外）。
    // 这样屈膝、弓步、跑动的起伏都由腿的姿态自己决定，脚不会陷进地里或悬空。
    const ft = rig.feet;
    if (ft) {
      const c = ent.clip;
      ent.gnd += ((c && c.air === true ? 0 : 1) - ent.gnd) * Math.min(1, sdt * 14);
      if (ent.gnd > 0.01) {
        const M = ent.mdl;
        let y = M[ft[0] * 12 + 7];
        for (let i = 1; i < ft.length; i++) y = Math.min(y, M[ft[i] * 12 + 7]);
        const d = (y - rig.ankle) * ent.gnd;
        // 'jump'：只在脚要陷进地面时往上托，允许离地
        if (d < -1e-4 || (d > 1e-4 && !(c && c.air === 'jump'))) {
          o[4] -= d;
          solveRig(ent);
        }
      }
    }
    // 腾空的全身动作（翻滚）：头和躯干不许钻进地里——最低的那个球碰到地面就把骨盆托起来
    const cc = ent.clip;
    if (cc && cc.clear) {
      const M = ent.mdl, cl = cc.clear;
      let low = 0;
      for (let i = 0; i < cl.length; i++) {
        const q = cl[i], m = q.j * 12;
        const y = M[m + 4] * q.x + M[m + 5] * q.y + M[m + 6] * q.z + M[m + 7] - q.r;
        if (y < low) low = y;
      }
      if (low < -1e-4) {
        o[4] -= low;
        solveRig(ent);
      }
    }
    if (rig.late) rig.late(ent);
  }

  W.setEnt = function (ent, x, z, ang) {
    ent.group.position.set(x, 0, z);
    ent.group.rotation.y = ang;
  };
  // 每帧调用一次：推进步态与当前动作。scale（可选）和 ent.timeScale 相乘后作为这只实体的动画时间倍率，
  // 顿帧时传 0（或把 ent.timeScale 设成 0）即可单独冻结它。time 参数保留只为兼容旧签名。
  W.animEnt = function (ent, dt, moving, time, scale) {
    if (ent.removed || ent.dying) return;
    const g = ent.group.position;
    let dx = g.x - ent.lx, dz = g.z - ent.lz;
    ent.lx = g.x;
    ent.lz = g.z;
    let d = Math.hypot(dx, dz);
    if (!(d < 2.5)) d = dx = dz = 0; // 第一帧或瞬移
    advanceEnt(ent, dt * (scale === undefined ? 1 : scale) * ent.timeScale, moving, d, dx, dz);
    if (ent.ring) ent.ring.rotation.y += dt * 0.9;
  };

  // 播放一个动作。opts：{ dur 时长（秒）, loop 循环, hold 播完停在最后一帧, onDone(ent) 自然播完时回调,
  //   contact 「命中帧」距开始的秒数（动作会自动把蓄力 / 收招分摊到两侧）, fade 切入过渡秒数 }
  // 一次性动作播完后自动过渡回站立 / 移动。该骨架没有这个动作时返回 false。
  // 'hit' 是叠加在任何动作之上的受击反应，等价于 W.hitReact（opts.ang / opts.strength）。
  W.play = function (ent, name, opts) {
    if (!ent || ent.removed) return false;
    if (name === 'hit') {
      W.hitReact(ent, opts && opts.ang !== undefined ? opts.ang : ent.group.rotation.y + Math.PI, opts ? opts.strength : undefined);
      return true;
    }
    const c = ent.rig.clips[name];
    if (!c) return false;
    beginFade(ent, opts && opts.fade !== undefined ? opts.fade : c.fade);
    ent.clip = c;
    ent.cT = 0;
    ent.cDur = opts && opts.dur > 0 ? opts.dur : c.dur;
    ent.cLoop = opts && opts.loop !== undefined ? !!opts.loop : c.loop;
    ent.cHold = opts && opts.hold !== undefined ? !!opts.hold : c.hold;
    ent.cDone = (opts && opts.onDone) || null;
    ent.cContact = opts && opts.contact > 0 ? Math.min(opts.contact, ent.cDur * 0.97) : -1;
    return true;
  };
  // 中止当前动作，过渡回站立 / 移动（不触发 onDone）
  W.stop = function (ent, fade) {
    if (!ent || !ent.clip) return;
    const c = ent.clip;
    ent.clip = null;
    ent.cDone = null;
    beginFade(ent, fade === undefined ? c.out : fade);
  };
  // 当前正在播放的动作名（没有则为 null）
  W.clipOf = function (ent) {
    return ent && ent.clip ? ent.clip.name : null;
  };
  // 某个动作按默认时长播放时，从第一帧到「命中帧」要多少秒（没有这个动作返回 0）。
  // 敌人的出手动作据此提前开始播，让命中帧落在伤害结算的那一刻。
  W.clipLead = function (ent, name) {
    const c = ent && !ent.removed && ent.rig.clips[name];
    return c ? c.k0 * c.dur : 0;
  };
  // 受击反应：ang 是这一击行进的方向（世界朝向角），strength 约 0.5（轻）~ 2（终结技）
  W.hitReact = function (ent, ang, strength) {
    if (!ent || ent.removed) return;
    const a = ang - ent.group.rotation.y, s = strength === undefined ? 1 : strength;
    ent.hitX = Math.sin(a);
    ent.hitZ = Math.cos(a);
    ent.hitS = Math.min(2.2, s);
    ent.hitDur = 0.24 + 0.08 * Math.min(2, s);
    ent.hitT = ent.hitDur;
  };

  // 挂点的世界坐标：weapon（武器尖端）/ hand / head / chest。结果写进 out（不传则新建一个对象返回）；
  // 每帧都要取的地方请传入自己的 out，避免分配。
  W.entSocket = function (ent, name, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const s = (ent.sock && ent.sock[name]) || ent.rig.sockets[name];
    const g = ent.group, k = g.scale.x * ent.k;
    let x = 0, y = ent.rig.height * 0.6, z = 0;
    if (s) {
      const M = ent.mdl, m = s.j * 12;
      x = M[m] * s.x + M[m + 1] * s.y + M[m + 2] * s.z + M[m + 3];
      y = M[m + 4] * s.x + M[m + 5] * s.y + M[m + 6] * s.z + M[m + 7];
      z = M[m + 8] * s.x + M[m + 9] * s.y + M[m + 10] * s.z + M[m + 11];
    }
    const sn = Math.sin(g.rotation.y), cs = Math.cos(g.rotation.y);
    o.x = g.position.x + (x * cs + z * sn) * k;
    o.y = g.position.y + y * k;
    o.z = g.position.z + (z * cs - x * sn) * k;
    return o;
  };
  const sock = (rig, name, joint, x, y, z) => (rig.sockets[name] = { j: rig.JI[joint], x: x || 0, y: y || 0, z: z || 0 });

  // 受击闪白。k：强度（1 普通，2 重击，3 终结 / 处决）——越重越亮、亮得越久，后半段渐隐
  W.flash = function (ent, k) {
    if (ent.removed) return;
    const s = Math.min(3, k === undefined ? 1 : k);
    if (ent.flashT <= 0) flashing.push(ent);
    ent.flashD = 0.07 + 0.02 * s;
    ent.flashT = ent.flashD;
    ent.flashK = 0.9 + 0.3 * s;
    const ms = ent.mats;
    for (let i = 0; i < ms.length; i++) {
      ms[i].emissive.setRGB(1, 1, 1);
      ms[i].emissiveIntensity = ms[i].userData.fi * ent.flashK;
    }
  };
  // 顿帧期间模型原地抖动（按真实时间衰减，不受时间缩放影响）
  const shudders = [];
  W.shudder = function (ent, amp, dur) {
    if (!ent || ent.removed) return;
    if (ent.shT <= 0) shudders.push(ent);
    ent.shAmp = amp;
    ent.shDur = ent.shT = Math.max(0.02, dur);
  };
  function updateShudders(raw) {
    for (let i = shudders.length - 1; i >= 0; i--) {
      const e = shudders[i];
      e.shT -= raw;
      if (e.shT <= 0 || e.removed) {
        e.shT = 0;
        e.body.position.set(0, 0, 0);
        shudders[i] = shudders[shudders.length - 1];
        shudders.pop();
      } else {
        const a = e.shAmp * (0.35 + 0.65 * (e.shT / e.shDur));
        e.body.position.set((Math.random() - 0.5) * 2 * a, 0, (Math.random() - 0.5) * 2 * a);
      }
    }
  }
  function unflash(ent) {
    const ms = ent.mats;
    for (let i = 0; i < ms.length; i++) {
      ms[i].emissive.copy(ms[i].userData.e0);
      ms[i].emissiveIntensity = ms[i].userData.ei0;
    }
  }
  W.setEntScale = function (ent, k) {
    if (ent.dying) return; // 尸体的消失由 W.die 接管
    ent.group.scale.setScalar(Math.max(0.001, k));
  };

  // ----- 死亡：倒地动作 + 沿受击方向滑出 + 消散。由 world 自己推进，调用方照常 W.removeEnt 即可 -----
  const dyingEnts = [];
  let corpseRoot = null; // 已被主人「移除」但还没消散完的尸体挂在这里，不占场景的直接子节点
  // 各伤害类型的死法：消散边缘色 / 倒地后多久开始消散 / 消散时长 / 地上留下的痕迹（贴花种类）/ 飘屑的上升速度
  const DEATH_STYLE = {
    phys: { edge: 0xe8dcc8, linger: 0.22, fade: 0.5, decal: 4, up: 0.7 },
    fire: { edge: 0xff7a2c, linger: 0.05, fade: 0.6, decal: 1, up: 2.4 },
    cold: { edge: 0xc8eeff, linger: 0.4, fade: 0.2, decal: 2, up: -1.5 },
    light: { edge: 0xfff2a0, linger: 0, fade: 0.3, decal: 3, up: 1.4 },
  };
  // opts：{ ang 击杀这一下行进的方向, force 飞出的初速度（默认 0）, color 消散边缘的颜色（默认元素色）,
  //         linger 倒地后多停留的秒数, type 致命伤害的类型（phys / fire / cold / light，决定死法与地上的痕迹）,
  //         over 过量击杀的程度（0 ~ 2：越大飞得越远、碎得越快） }。
  // 对玩家调用时会留下一具替身来演，玩家本体不受影响。
  W.die = function (ent, opts) {
    if (!ent || ent.removed || ent.dying) return;
    const o = opts || {};
    if (ent.kind === 'player') {
      const dbl = makePlayerEnt();
      scene.remove(dbl.group);
      corpseRoot.add(dbl.group);
      dbl.orphan = true;
      dbl.group.position.copy(ent.group.position);
      dbl.group.rotation.y = ent.group.rotation.y;
      dbl.out.set(ent.out);
      applyGear(dbl, ent.gearType, ent.gearRar);
      ent = dbl;
    }
    const c = ent.rig.clips.death;
    const st = DEATH_STYLE[o.type] || null, big = ent.rig.NB === NB_BIG && ent.kind !== 'player';
    const over = big ? 0 : Math.max(0, Math.min(2, o.over || 0));
    const f = (o.force || 0) * (1 + over * 0.6), a = o.ang === undefined ? ent.group.rotation.y + Math.PI : o.ang;
    const violent = over >= 0.6;
    let clipDur = c ? c.dur : 0.4;
    if (o.type === 'cold') clipDur = Math.min(clipDur, 0.3); // 冻住：没倒完就僵在半道
    if (violent) clipDur = Math.min(clipDur, 0.26); // 过量击杀：还在半空就碎了
    ent.dying = {
      t: 0, clipDur, acc: 0, type: st ? o.type : '', st, over, begun: false,
      linger: violent ? 0 : o.linger !== undefined ? o.linger : st ? st.linger : 0.25,
      fade: (big ? 0.9 : st ? st.fade : 0.5) * (violent ? 0.6 : 1),
      vx: Math.sin(a) * f, vz: Math.cos(a) * f,
      vy: f > 5 ? Math.min(9, 2 + f * 0.32) : 0, // 力道够大才离地
      spin: f > 5 ? (Math.random() < 0.5 ? -1 : 1) * Math.min(16, f * 0.9) : 0,
    };
    if (o.color !== undefined) _c.set(o.color);
    else if (st) _c.set(st.edge);
    else _c.copy(ent.elemC);
    ent.uDis.value.set(_c.r, _c.g, _c.b, 0);
    ent.timeScale = 1;
    ent.hitT = 0;
    if (ent.shT > 0) ent.shT = 1e-4;
    if (ent.ring) ent.ring.visible = false;
    if (ent.ringShade) ent.ringShade.visible = false;
    W.play(ent, 'death', { hold: true });
    dyingEnts.push(ent);
    if (st) {
      const g = ent.group.position, h = ent.rig.height * ent.k, m = ent.bodyMat.userData;
      if (o.type === 'cold') {
        // 结一层霜：整体泛着冷光，动作几乎停住
        m.e0.setRGB(0.2, 0.42, 0.6);
        m.ei0 = 0.7;
      } else if (o.type === 'fire') {
        m.e0.setRGB(0.9, 0.25, 0.04);
        m.ei0 = 0.5;
      } else if (o.type === 'light') {
        m.e0.setRGB(0.8, 0.75, 0.3);
        m.ei0 = 0.45;
      }
      if (violent) {
        // 炸开：一把又大又沉的碎块 + 元素色的碎光
        const n = Math.round(12 + over * 10);
        _c.set(st.edge);
        for (let i = 0; i < n; i++) {
          const b = a + rand(-1.1, 1.1), sp = rand(3, 9) * (1 + over * 0.4), dk = i % 3 === 0 ? 1 : 0.22;
          spawnP(g.x + rand(-0.3, 0.3), rand(0.3, 0.8) * h, g.z + rand(-0.3, 0.3), Math.sin(b) * sp, rand(2, 7), Math.cos(b) * sp, rand(0.45, 0.9), rand(0.24, 0.42),
            _c.r * dk, _c.g * dk, _c.b * dk, 18, 1.2);
        }
        flashLight(g.x, h * 0.6 + 1, g.z, st.edge, 1.6 + over * 0.5);
      }
    }
  };
  function updateDying(dt) {
    for (let i = dyingEnts.length - 1; i >= 0; i--) {
      const ent = dyingEnts[i], d = ent.dying;
      if (ent.removed) {
        dyingEnts.splice(i, 1);
        continue;
      }
      d.t += dt;
      const g = ent.group.position, h = ent.rig.height * ent.k, u = ent.uDis.value, st = d.st;
      // 飞出：撞到不可走的地方就停；力道大的会离地翻转
      if (d.vx !== 0 || d.vz !== 0) {
        const nx = g.x + d.vx * dt, nz = g.z + d.vz * dt;
        if (W.walkable(nx, nz, 0.3)) {
          g.x = nx;
          g.z = nz;
        } else d.vx = d.vz = 0;
        const dr = Math.exp(-dt * (g.y > 0.02 ? 2.2 : 6));
        d.vx *= dr;
        d.vz *= dr;
        if (Math.abs(d.vx) + Math.abs(d.vz) < 0.05) d.vx = d.vz = 0;
      }
      if (d.vy !== 0 || g.y > 0) {
        d.vy -= 26 * dt;
        g.y += d.vy * dt;
        if (g.y <= 0) {
          g.y = 0;
          d.vy = 0;
          d.spin *= 0.3;
          for (let j = 0; j < 6; j++) spawnP(g.x + rand(-0.4, 0.4), 0.15, g.z + rand(-0.4, 0.4), rand(-2, 2), rand(0.5, 2), rand(-2, 2), rand(0.3, 0.6), rand(0.2, 0.34), 0.5, 0.45, 0.38, 2, 2);
        }
      }
      if (d.spin !== 0) {
        ent.group.rotation.y += d.spin * dt;
        d.spin *= Math.exp(-dt * 3);
      }
      // 各类型的死法：冰 = 僵住；电 = 抽搐冒火花；火 = 烧焦冒火星
      let rate = 1;
      if (d.type === 'cold') rate = 0.25;
      else if (d.type === 'light') {
        ent.body.position.set(rand(-0.06, 0.06), 0, rand(-0.06, 0.06));
        if (Math.random() < dt * 40) spawnP(g.x + rand(-0.4, 0.4) * h * 0.4, g.y + rand(0.2, 0.8) * h, g.z + rand(-0.4, 0.4) * h * 0.4, rand(-5, 5), rand(-1, 5), rand(-5, 5), rand(0.08, 0.2), 0.13, 1, 0.95, 0.5, 6, 2);
      } else if (d.type === 'fire') {
        ent.bodyMat.color.lerp(_c.setRGB(0.05, 0.035, 0.03), Math.min(1, dt * 3.5));
        if (Math.random() < dt * 22) spawnP(g.x + rand(-0.4, 0.4) * h * 0.4, g.y + rand(0.2, 0.8) * h, g.z + rand(-0.4, 0.4) * h * 0.4, rand(-0.6, 0.6), rand(1, 3), rand(-0.6, 0.6), rand(0.3, 0.7), rand(0.1, 0.2), 1, 0.5, 0.12, -1.5, 0.8);
      }
      advanceEnt(ent, dt * rate, false, 0, 0, 0);
      const k = (d.t - d.clipDur - d.linger) / d.fade;
      if (k > 0) {
        if (!d.begun) {
          d.begun = true;
          ent.meshBody.castShadow = false;
          if (st) {
            const big = ent.rig.NB === NB_BIG;
            W.decal(st.decal, g.x, g.z, (big ? 2.6 : 0.95 + d.over * 0.35) * Math.max(1, ent.k), rand(0, TAU), st.edge, big ? 7 : 4.5);
            if (d.type === 'cold') {
              // 冻脆了：整个碎成冰碴
              for (let j = 0; j < 22; j++) {
                const b = rand(0, TAU), sp = rand(2, 8);
                spawnP(g.x + Math.sin(b) * 0.3, g.y + rand(0.2, 0.9) * h, g.z + Math.cos(b) * 0.3, Math.sin(b) * sp, rand(1, 6), Math.cos(b) * sp, rand(0.4, 0.85), rand(0.2, 0.36), 0.78, 0.92, 1, 20, 1);
              }
              W.ring(g.x, g.z, 1.6 * Math.max(1, ent.k), 0xbfeaff, 0.28);
            }
          }
        }
        ent.uDis.value.w = Math.min(1, k);
        // 消散时飘出的碎屑（火往上、冰往下掉、其余缓缓上浮）
        d.acc += dt * (ent.rig.NB === NB_BIG ? 60 : 24) * (d.type === 'cold' ? 2 : 1);
        const up = st ? st.up : 1.6;
        while (d.acc > 1) {
          d.acc -= 1;
          spawnP(g.x + rand(-0.5, 0.5) * h * 0.4, g.y + rand(0.1, 0.5) * h, g.z + rand(-0.5, 0.5) * h * 0.4, rand(-0.6, 0.6), up > 0 ? rand(0.5, 1.5) * up : rand(0, 1), rand(-0.6, 0.6), rand(0.4, 0.9), rand(0.1, 0.2), u.x, u.y, u.z, up > 0 ? -0.8 : 9, 0.8);
        }
        if (k >= 1) {
          dyingEnts.splice(i, 1);
          disposeEnt(ent);
        }
      }
    }
  }
  function disposeEnt(ent) {
    if (ent.removed) return;
    if (ent.group.parent) ent.group.parent.remove(ent.group);
    for (const m of ent.mats) m.dispose();
    for (const m of ent.own) m.dispose();
    ent.removed = true;
  }
  W.removeEnt = function (ent) {
    if (ent.removed) return;
    if (ent.dying) {
      // 还在演死亡：从场景的直接子节点里挪走，演完由 updateDying 销毁
      if (!ent.orphan) {
        ent.orphan = true;
        scene.remove(ent.group);
        corpseRoot.add(ent.group);
      }
      return;
    }
    disposeEnt(ent);
  };
  function clearDying() {
    for (const ent of dyingEnts) disposeEnt(ent);
    dyingEnts.length = 0;
  }

  // =====================================================================
  // 玩家：余烬行者 —— 浅色兜帽披风、暗钢胸甲、单侧大肩甲，右手持武器，左手托着一点余烬
  // =====================================================================
  const HALF_PI = Math.PI / 2;
  // 披风 / 罩袍用的弧形布片：绕 y 轴车削出背后的一段弧面
  const gDrape = (key, pts, arc, seg = 7) =>
    geo('D' + key, () => new T.LatheGeometry(pts.map((p) => new T.Vector2(p[0], p[1])), seg, Math.PI - arc / 2, arc));

  function playerRig() {
    return rigOf('player', () => {
      const CLOAK = 0xe8dfc8, CLOAK_D = 0xb3a488, CLOAK_IN = 0x6d6150, STEEL = 0x5d6a84, STEEL_D = 0x343c4e;
      const LEATHER = 0x5e4432, DARK = 0x191b23, GOLD = 0xdcae45, CLOTH = 0x2f3644, BLADE = 0xd9dee6, WOOD = 0x6b4a32, BONE = 0xd9cfb6;
      const b = rigBuilder('player', NB_BIG);
      b.j('root', null, 0, 1.0, 0).j('spine', 'root', 0, 1.1, 0).j('chest', 'spine', 0, 1.32, 0).j('head', 'chest', 0, 1.62, 0.01);
      b.j('uaL', 'chest', 0.33, 1.5, 0).j('faL', 'uaL', 0.38, 1.19, -0.01).j('hL', 'faL', 0.39, 0.9, 0.02);
      b.j('uaR', 'chest', -0.33, 1.5, 0).j('faR', 'uaR', -0.38, 1.19, -0.01).j('hR', 'faR', -0.39, 0.9, 0.02);
      b.j('wB', 'hR', -0.39, 0.84, 0.05).j('wS', 'hR', -0.39, 0.84, 0.05).j('wW', 'hR', -0.39, 0.84, 0.05);
      b.j('thL', 'root', 0.14, 0.97, 0).j('shL', 'thL', 0.15, 0.53, 0.01).j('ftL', 'shL', 0.15, 0.12, 0);
      b.j('thR', 'root', -0.14, 0.97, 0).j('shR', 'thR', -0.15, 0.53, 0.01).j('ftR', 'shR', -0.15, 0.12, 0);
      b.j('cape1', 'chest', 0, 1.54, -0.16).j('cape2', 'cape1', 0, 1.14, -0.27).j('cape3', 'cape2', 0, 0.78, -0.33);
      b.j('tab', 'root', 0, 1.0, 0.19);

      // --- 骨盆：皮裙、两侧的腿甲片、腰带、腰包、余烬瓶 ---
      b.at('root').surf(SURF.leather);
      b.p(gLathe('pl/hip', [[0.28, 0.76], [0.3, 0.86], [0.26, 1.0], [0.24, 1.08]], 10), [0x35261d, LEATHER], 0, 0, 0, 0, 0, 0, 1, 1, 0.85);
      b.surf(SURF.metal, true);
      for (const s of [1, -1]) b.p(gPlate('pl/tasset', [[-0.1, 0.1], [0.1, 0.1], [0.11, -0.08], [0, -0.17], [-0.11, -0.08]], 0.025, 0.015), [STEEL_D, STEEL], s * 0.285, 0.9, 0, 0.05, s * HALF_PI, -s * 0.16);
      b.surf(SURF.gold).p(gTorus(0.255, 0.03, 5, 14), GOLD, 0, 1.045, 0, HALF_PI, 0, 0, 1, 0.85, 1);
      b.p(gRBox(0.12, 0.11, 0.05, 0.018), GOLD, 0, 1.045, 0.225);
      b.surf(SURF.leather).p(gRBox(0.14, 0.16, 0.1, 0.03), 0x7a5a42, 0.2, 0.95, 0.17, 0, 0.5, 0);
      b.surf(SURF.metal).p(gCyl(0.03, 0.036, 0.05, 6), STEEL_D, -0.22, 1.0, 0.17);
      b.g(gSph(0.052, 7, 5), 1, -0.22, 0.93, 0.17, 0, 0, 0, 1, 1.3, 1);
      // --- 前襟：垂在两腿之间的布条 ---
      b.at('tab').surf(SURF.cloth);
      b.pd(gPlate('pl/tab', [[-0.11, 0], [0.11, 0], [0.13, -0.32], [0, -0.46], [-0.13, -0.32]], 0.012, 0.004), [CLOAK_D, CLOAK], CLOAK_IN, 0, 1.0, 0.215, -0.07);
      b.surf(SURF.gold).p(gPlate('pl/tabg', [[0, 0.06], [0.045, 0], [0, -0.06], [-0.045, 0]], 0.01, 0.003), GOLD, 0, 0.79, 0.24, -0.07);

      // --- 腹部 ---
      b.at('spine').surf(SURF.leather);
      b.p(gLathe('pl/abd', [[0.235, 1.03], [0.225, 1.14], [0.25, 1.3], [0.22, 1.36]], 10), [STEEL_D, 0x3d4658], 0, 0, 0, 0, 0, 0, 1, 1, 0.82);

      // --- 胸甲、披肩、肩甲 ---
      b.at('chest').surf(SURF.metal);
      b.p(gLathe('pl/chest', [[0.23, 1.26], [0.31, 1.36], [0.33, 1.47], [0.25, 1.57], [0.12, 1.64]], 12), [STEEL_D, STEEL], 0, 0, 0, 0, 0, 0, 1, 1, 0.8);
      b.p(gPlate('pl/plast', [[-0.15, 0.12], [0, 0.17], [0.15, 0.12], [0.11, -0.07], [0, -0.14], [-0.11, -0.07]], 0.03, 0.022), STEEL, 0, 1.41, 0.235, -0.1);
      b.surf(SURF.gold).p(gPlate('pl/plastg', [[-0.13, 0.105], [0, 0.15], [0.13, 0.105], [0.13, 0.078], [0, 0.118], [-0.13, 0.078]], 0.02, 0.006), GOLD, 0, 1.415, 0.268, -0.1);
      b.g(gOct(0.05), 1, 0, 1.385, 0.28, 0, 0, 0, 1, 1.5, 0.6);
      // 披肩（浅色布）顺着肩膀垂下 + 金边 + 领口搭扣
      b.surf(SURF.cloth);
      b.p(gLathe('pl/mantle', [[0.39, 1.37], [0.4, 1.41], [0.34, 1.52], [0.23, 1.61], [0.15, 1.68]], 12), [CLOAK_D, CLOAK], 0, 0, -0.03, 0, 0, 0, 1, 1, 0.86);
      b.surf(SURF.gold).p(gTorus(0.395, 0.016, 5, 18), GOLD, 0, 1.385, -0.03, HALF_PI, 0, 0, 1, 0.86, 1);
      b.p(gSph(0.042, 7, 5), GOLD, 0, 1.585, 0.215, 0, 0, 0, 1, 1, 0.6);
      // 左肩：两层钢甲 + 金棱 + 一道符文光；右肩：小一号的单层甲
      b.surf(SURF.metal);
      b.p(gDome(0.21, 10, 4, 1.45), [STEEL_D, STEEL], 0.4, 1.52, 0, 0, 0, -0.55, 1.1, 0.8, 1.22);
      b.p(gDome(0.17, 10, 3, 1.4), [STEEL_D, STEEL], 0.5, 1.43, 0, 0, 0, -1.0, 1, 0.75, 1.25);
      b.surf(SURF.gold).p(gSweep('pl/ridge', [[0.3, 1.62, 0], [0.42, 1.675, 0], [0.55, 1.6, 0], [0.6, 1.5, 0]], [0.02, 0.026, 0.022, 0.012], 5), GOLD, 0, 0, 0);
      b.g(gBox(0.02, 0.02, 0.24), 0.9, 0.555, 1.47, 0, 0, 0, -1.0);
      b.surf(SURF.metal).p(gDome(0.16, 9, 3, 1.4), [STEEL_D, STEEL], -0.4, 1.51, 0, 0, 0, 0.6, 1, 0.75, 1.15);
      b.surf(SURF.gold).p(gTorus(0.15, 0.014, 4, 12), GOLD, -0.435, 1.455, 0, HALF_PI, 0, 0.6, 1, 1.15, 1);

      // --- 头：深兜帽，脸藏在阴影里，只露出一双发亮的眼睛 ---
      b.at('head').surf(SURF.cloth);
      b.p(gSph(0.22, 12, 8), [CLOAK_D, CLOAK], 0, 1.76, -0.03, 0, 0, 0, 1, 1.04, 1.16);
      b.p(gSph(0.15, 10, 7), DARK, 0, 1.705, 0.105, 0, 0, 0, 0.86, 1.08, 1);
      b.p(gTorus(0.15, 0.04, 6, 14), CLOAK, 0, 1.725, 0.14, 0.3, 0, 0, 0.92, 1.12, 1);
      b.p(gSweep('pl/hoodtip', [[0, 1.78, -0.1], [0, 1.74, -0.27], [0, 1.62, -0.36], [0, 1.47, -0.36]], [0.12, 0.1, 0.065, 0.012], 7), [CLOAK_D, CLOAK], 0, 0, 0);
      b.p(gCyl(0.15, 0.19, 0.13, 9), CLOAK_D, 0, 1.62, 0.0);
      b.g(gSph(0.021, 6, 4), 1, 0.054, 1.705, 0.245, 0, 0, 0.25, 1.5, 0.62, 1).g(gSph(0.021, 6, 4), 1, -0.054, 1.705, 0.245, 0, 0, -0.25, 1.5, 0.62, 1);

      // --- 手臂：布袖、带钢片的皮护腕、厚手套 ---
      const arm = (s, U, F, H) => {
        b.at(U).surf(SURF.cloth).limb(CLOTH, s * 0.33, 1.5, 0, s * 0.38, 1.19, -0.01, 0.105, 0.085, 7, 3);
        b.at(F).surf(SURF.leather).limb([0x3d2c20, LEATHER], s * 0.38, 1.19, -0.01, s * 0.39, 0.93, 0.02, 0.1, 0.082, 7, 0);
        b.surf(SURF.metal, true).p(gPlate('pl/bracer', [[-0.04, 0.09], [0.04, 0.09], [0.03, -0.09], [-0.03, -0.09]], 0.014, 0.01), STEEL, s * 0.468, 1.065, 0, 0, s * HALF_PI, s * 0.05);
        b.surf(SURF.gold).p(gCyl(0.097, 0.102, 0.035, 8), GOLD, s * 0.382, 1.15, -0.008).p(gCyl(0.086, 0.09, 0.03, 8), GOLD, s * 0.39, 0.955, 0.018);
        b.at(H).surf(SURF.leather).p(gSph(0.09, 8, 6), [DARK, 0x2a2d3a], s * 0.39, 0.86, 0.035, 0, 0, 0, 0.92, 1.12, 1.08);
      };
      arm(1, 'uaL', 'faL', 'hL');
      arm(-1, 'uaR', 'faR', 'hR');
      // 左手掌心的余烬
      b.at('hL').g(gOct(0.055), 1, 0.39, 0.75, 0.08, 0, 0.6, 0, 1, 1.5, 1);

      // --- 腿：布裤、护膝、钢胫甲、皮靴 ---
      const leg = (s, TH, SH, FT) => {
        b.at(TH).surf(SURF.cloth).limb(CLOTH, s * 0.14, 0.97, 0, s * 0.15, 0.53, 0.01, 0.14, 0.108, 7, 2);
        b.surf(SURF.metal, true).p(gDome(0.1, 6, 2, 1.3), STEEL, s * 0.15, 0.55, 0.075, HALF_PI - 0.2, 0, 0, 1, 0.9, 1.15);
        b.at(SH).surf(SURF.metal).p(gLathe('pl/greave', [[0.085, 0.1], [0.1, 0.24], [0.122, 0.42], [0.1, 0.5]], 8), [STEEL_D, STEEL], s * 0.15, 0, 0.012);
        b.surf(SURF.gold).p(gCyl(0.118, 0.123, 0.03, 8), GOLD, s * 0.15, 0.43, 0.012);
        b.at(FT).surf(SURF.leather).p(gSph(0.105, 8, 6), [0x241b16, 0x503b2d], s * 0.15, 0.072, 0.07, 0, 0, 0, 0.95, 0.72, 1.8);
        b.p(gCyl(0.098, 0.105, 0.11, 7), 0x3a2b21, s * 0.15, 0.14, 0);
      };
      leg(1, 'thL', 'shL', 'ftL');
      leg(-1, 'thR', 'shR', 'ftR');

      // --- 披风：三段，自上而下越来越宽，下摆撕成几条 ---
      b.surf(SURF.cloth);
      b.at('cape1').pd(gDrape('pl/c1', [[0.33, 1.1], [0.3, 1.3], [0.23, 1.56]], 2.5), [CLOAK_D, CLOAK], CLOAK_IN, 0, 0, 0.0);
      b.at('cape2').pd(gDrape('pl/c2', [[0.42, 0.74], [0.39, 0.95], [0.33, 1.16]], 2.3), [0x9a8c73, CLOAK_D], CLOAK_IN, 0, 0, 0.0);
      b.at('cape3');
      for (const a of [-0.84, -0.28, 0.28, 0.84]) {
        const h = Math.abs(a) > 0.5 ? 0.36 : 0.46;
        b.pd(gPlate('pl/tat' + h, [[-0.125, 0], [0.125, 0], [0.08, -h * 0.7], [0, -h], [-0.07, -h * 0.6]], 0.01, 0.003), [0x7d715c, 0x9a8c73], CLOAK_IN, Math.sin(a) * 0.41, 0.8, -Math.cos(a) * 0.41, 0.1, Math.PI + a, 0);
      }

      // --- 武器：三把都挂在右手上，握把沿 +z；没装备的那两把缩到 0 ---
      const WX = -0.39, WY = 0.84;
      // 刃：宽刃，血槽发光
      b.at('wB').surf(SURF.leather).p(gCyl(0.026, 0.028, 0.22, 6), 0x3a2a20, WX, WY, 0.03, HALF_PI);
      b.surf(SURF.gold).p(gSph(0.04, 6, 4), GOLD, WX, WY, -0.1);
      b.p(gPlate('pl/guard', [[-0.17, 0.03], [-0.11, -0.04], [0.11, -0.04], [0.17, 0.03], [0.08, 0.035], [-0.08, 0.035]], 0.055, 0.014), GOLD, WX, WY, 0.15, HALF_PI, HALF_PI, 0);
      b.surf(SURF.metal).p(gPlate('pl/blade', [[-0.06, 0], [0.06, 0], [0.075, 0.7], [0, 1.0], [-0.075, 0.7]], 0.012, 0.016), [0xa3acbb, BLADE], WX, WY, 0.17, HALF_PI, HALF_PI, 0);
      b.x(gBox(0.046, 0.02, 0.66), 1, WX, WY, 0.53);
      // 长杖：握在下三分之一处，杖头是一弯月牙托着晶体
      b.at('wS').surf(SURF.leather).p(gCyl(0.026, 0.032, 1.6, 6), [0x4a3222, WOOD], WX, WY, 0.35, HALF_PI);
      b.surf(SURF.gold).p(gCyl(0.04, 0.04, 0.06, 6), GOLD, WX, WY, 1.0, HALF_PI).p(gCyl(0.036, 0.02, 0.08, 6), GOLD, WX, WY, -0.46, HALF_PI);
      b.p(gSweep('pl/cres', [[0, -0.02, 1.12], [0, 0.13, 1.2], [0, 0.18, 1.36], [0, 0.08, 1.52]], [0.034, 0.032, 0.025, 0.004], 5), GOLD, WX, WY, 0);
      b.p(gSweep('pl/cres2', [[0, 0.02, 1.12], [0, -0.13, 1.2], [0, -0.18, 1.36], [0, -0.08, 1.52]], [0.034, 0.032, 0.025, 0.004], 5), GOLD, WX, WY, 0);
      b.x(gOct(0.09), 1, WX, WY, 1.36, 0, 0, 0, 0.8, 0.8, 1.5);
      // 短杖：骨柄、三根爪托着晶体
      b.at('wW').surf(SURF.bone).p(gCyl(0.02, 0.03, 0.52, 6), [0xa89c84, BONE], WX, WY, 0.16, HALF_PI);
      b.p(gSph(0.036, 6, 4), BONE, WX, WY, -0.1);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU, cx = Math.cos(a), sy = Math.sin(a);
        b.p(gSweep('pl/prong' + k, [[cx * 0.02, sy * 0.02, 0.4], [cx * 0.075, sy * 0.075, 0.5], [cx * 0.04, sy * 0.04, 0.64]], [0.018, 0.015, 0.003], 4), BONE, WX, WY, 0);
      }
      b.x(gOct(0.062), 1, WX, WY, 0.55, 0, 0, 0, 0.8, 0.8, 1.5);

      const rig = b.build({ height: 1.95, reach: 2.2, stride: 2.35, shade: 0.28 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.12;
      sock(rig, 'weapon', 'wB', 0, 0, 1.0);
      sock(rig, 'hand', 'hR', 0, -0.06, 0.02);
      sock(rig, 'handL', 'hL', 0, -0.1, 0.05);
      sock(rig, 'head', 'head', 0, 0.16, 0);
      sock(rig, 'chest', 'chest', 0, 0.12, 0.1);
      rig.loco = playerLoco;
      rig.post = playerPost;
      rig.late = playerLate;
      playerClips(rig);
      return rig;
    });
  }

  // 站立呼吸 + 跑动步态。步态相位来自实际走过的距离，脚不会在地上打滑
  function playerLoco(ent, p, t) {
    const J = ent.rig.J, mv = ent.mv, w = ent.walk;
    const s = Math.sin(w), c = Math.cos(w), id = 1 - mv;
    const run = Math.min(1.25, ent.spd / 7.2) * mv; // 0 = 站着，1 = 全速跑
    const br = Math.sin(t * 1.9), br2 = Math.sin(t * 0.95 + 1);
    const gear = ent.gearType;
    // 移动方向和朝向不一致时，胯转向移动方向，上身拧回来
    let md = ent.mdir;
    if (md > 1.9) md -= Math.PI;
    else if (md < -1.9) md += Math.PI;
    md *= mv * 0.75;

    p[J.root] = 0.2 * run;
    p[J.root + 1] = -0.14 * s * run + md;
    p[J.root + 2] = 0.03 * c * run;
    p[J.spine] = 0.05 * run + br * 0.012 * id;
    p[J.spine + 1] = -md * 0.5;
    p[J.chest] = 0.03 * id + br * 0.018 * id;
    p[J.chest + 1] = 0.24 * s * run - md * 0.5;
    p[J.chest + 6] = p[J.chest + 8] = 1 + br * 0.014 * id;
    p[J.head] = -0.1 * run - 0.02 * id + br * 0.01;
    p[J.head + 1] = br2 * 0.12 * id - 0.1 * s * run;

    // 腿：前摆时屈膝，蹬地时伸直
    const legSet = (TH, SH, FT, sn, cs, side) => {
      const lift = Math.max(0, cs);
      p[J[TH]] = (-0.78 * sn - 0.12 + 0.25 * lift) * run - 0.03 * id;
      p[J[TH] + 2] = side * 0.07 * id;
      p[J[SH]] = (0.3 + 1.25 * lift * lift + 0.25 * Math.max(0, -sn)) * run + 0.06 * id;
      p[J[FT]] = (0.55 * Math.max(0, -sn) - 0.3 * Math.max(0, sn)) * run - 0.03 * id;
      p[J[FT] + 2] = -side * 0.07 * id;
    };
    legSet('thL', 'shL', 'ftL', s, c, 1);
    legSet('thR', 'shR', 'ftR', -s, -c, -1);

    // 左臂自然摆动
    p[J.uaL] = 0.75 * s * run + 0.06 * id;
    p[J.uaL + 2] = 0.12 + 0.05 * run + br * 0.012 * id;
    p[J.faL] = -(0.85 + 0.25 * s) * run - 0.3 * id;
    p[J.hL + 1] = 0.3;
    // 右臂提着武器：跑起来收在身侧，摆幅小
    p[J.uaR] = (-0.45 * s - 0.1) * run - 0.18 * id;
    p[J.uaR + 2] = -0.14 - 0.06 * run - br * 0.012 * id;
    p[J.faR] = -0.75 * run - 0.5 * id;
    if (gear === 1) {
      // 长杖：竖着拄在身侧
      p[J.uaR] = (-0.3 * s - 0.25) * run - 0.3 * id;
      p[J.faR] = -0.9 * run - 0.75 * id;
      p[J.hR] = -0.75 + 0.2 * run;
      p[J.hR + 2] = 0.12;
    } else if (gear === 2) {
      // 短杖：小臂抬起，杖尖朝前上方
      p[J.faR] = -1.0 * run - 0.95 * id;
      p[J.hR] = -0.2;
    } else {
      // 刃：刃尖斜指前下方
      p[J.hR] = 0.5 - 0.25 * run;
      p[J.hR + 1] = 0.25;
      p[J.hR + 2] = -0.2 * id;
    }

    // 披风与前襟：跑起来向后扬，叠一层飘动
    const fl = Math.sin(t * 2.3 + ent.phase), fl2 = Math.sin(t * 3.1 + 1.3 + ent.phase), fl3 = Math.sin(w * 2 + 0.6);
    p[J.cape1] = 0.06 + 0.26 * run + fl * (0.025 + 0.03 * run);
    p[J.cape2] = 0.1 + 0.2 * run + fl2 * (0.04 + 0.05 * run) + fl3 * 0.06 * run;
    p[J.cape3] = 0.08 + 0.18 * run + Math.sin(t * 3.7 + 2.2) * (0.06 + 0.08 * run) - fl3 * 0.08 * run;
    p[J.cape1 + 2] = fl2 * 0.02 - 0.05 * c * run;
    p[J.tab] = -0.06 - 0.3 * run * Math.max(Math.abs(s), 0.4) + fl * 0.03;
  }
  // 每帧都要设的东西：只显示当前装备的那把武器，掌心余烬脉动
  function playerPost(ent, o, t) {
    const J = ent.rig.J, g = ent.gearType;
    o[J.wB + 6] = o[J.wB + 7] = o[J.wB + 8] = g === 0 ? 1 : 0;
    o[J.wS + 6] = o[J.wS + 7] = o[J.wS + 8] = g === 1 ? 1 : 0;
    o[J.wW + 6] = o[J.wW + 7] = o[J.wW + 8] = g === 2 ? 1 : 0;
    setGlow(ent, 1 + Math.sin(t * 5) * 0.12);
  }
  const _sk = { x: 0, y: 0, z: 0 }, _sk2 = { x: 0, y: 0, z: 0 };
  function playerLate(ent) {
    // 挥砍的出手段：武器拖出一道刀光
    const c = ent.clip;
    if (c && c.trail && ent === trail.ent && !ent.dying && ent.cK >= c.trail[0] && ent.cK <= c.trail[1]) {
      W.entSocket(ent, 'weapon', _sk);
      W.entSocket(ent, 'hand', _sk2);
      trailPush(ent, _sk2.x + (_sk.x - _sk2.x) * 0.3, _sk2.y + (_sk.y - _sk2.y) * 0.3, _sk2.z + (_sk.z - _sk2.z) * 0.3, _sk.x, _sk.y, _sk.z);
    }
    // 稀有度光晕跟着武器走；稀有武器偶尔掉一点光屑
    const a = ent.aura;
    if (!a || !a.visible) return;
    const s = ent.sock.weapon, M = ent.mdl, m = s.j * 12, z = s.z * (GEAR_AURA[ent.gearType] || GEAR_AURA[0])[0];
    a.position.set(M[m + 2] * z + M[m + 3], M[m + 6] * z + M[m + 7], M[m + 10] * z + M[m + 11]);
    if (ent.gearRar >= 2 && Math.random() < 0.06 && !ent.dying) {
      W.entSocket(ent, 'weapon', _sk);
      spawnP(_sk.x, _sk.y, _sk.z, rand(-0.3, 0.3), rand(0.2, 0.9), rand(-0.3, 0.3), rand(0.4, 0.8), 0.1, 1, 0.84, 0.37, -0.3, 0.6);
    }
  }

  // ----- 玩家动作 -----
  const LEGS = ['thL', 'shL', 'ftL', 'thR', 'shR', 'ftR'];
  function playerClips(rig) {
    // 出招时的站姿：左脚在前、屈膝压低重心（真的在走动时让位给步态）。骨盆高度由贴地修正自动得出
    const stance = (keys, d) => {
      keys['thL.rx'] = [0, -0.55 * d, 1, -0.55 * d];
      keys['shL.rx'] = [0, 0.75 * d, 1, 0.75 * d];
      keys['thR.rx'] = [0, 0.35 * d, 1, 0.35 * d];
      keys['shR.rx'] = [0, 0.35 * d, 1, 0.35 * d];
      keys['ftR.rx'] = [0, 0.25 * d, 1, 0.25 * d];
      keys['thL.rz'] = [0, 0.1, 1, 0.1];
      keys['thR.rz'] = [0, -0.16, 1, -0.16];
      return keys;
    };

    let A1, A2; // 前两段的关键帧，影步连斩的短促出刀照搬它们
    // 第一段：自右向左的横斩
    defClip(rig, 'attack1', {
      dur: 0.45, k0: 0.5, lower: LEGS, fade: 0.06, out: 0.2, trail: [0.3, 0.74],
      keys: (A1 = stance({
        'root.oz': [0, 0, 0.3, -0.05, -0.5, 0.12, 1, 0.03],
        'root.ry': [0, -0.05, 0.3, -0.18, -0.5, 0.08, 0.72, 0.12, 1, 0.02],
        'root.rx': [0, 0.08, 0.3, 0.04, -0.5, 0.2, 1, 0.08],
        'spine.ry': [0, -0.1, 0.3, -0.3, -0.5, 0.12, 0.72, 0.26, 1, 0.03],
        'chest.ry': [0, -0.15, 0.3, -0.42, -0.5, 0.18, 0.72, 0.4, 1, 0.03],
        'head.ry': [0, 0.2, 0.3, 0.7, -0.5, -0.3, 0.72, -0.6, 1, 0],
        'uaR.rz': [0, -0.9, 0.3, -1.3, -0.5, -1.42, 0.72, -1.25, 1, -0.5],
        'uaR.ry': [0, -0.2, 0.3, -0.95, -0.5, 0.95, 0.72, 1.55, 1, 0.7],
        'uaR.rx': [0, 0, 1, 0],
        'faR.rx': [0, -0.5, 0.3, -1.0, -0.5, -0.1, 0.72, -0.3, 1, -0.6],
        'hR.rx': [0, 1.3, 0.3, 2.0, -0.5, 1.45, 0.72, 1.15, 1, 0.9],
        'hR.ry': [0, 0, 1, 0],
        'hR.rz': [0, 0, 1, 0],
        'uaL.rx': [0, -0.2, 0.3, -0.8, -0.5, 0.55, 1, 0.2],
        'uaL.rz': [0, 0.3, 0.3, 0.45, -0.5, 0.75, 1, 0.3],
        'faL.rx': [0, -0.6, 0.3, -1.0, -0.5, -0.4, 1, -0.5],
        'cape1.rz': [0, 0, 0.3, -0.12, -0.5, 0.25, 0.8, 0.1, 1, 0],
        'cape2.rz': [0, 0, 0.3, -0.15, -0.56, 0.3, 0.85, 0.1, 1, 0],
      }, 1)),
    });
    // 第二段：反手自左向右、略微上挑
    defClip(rig, 'attack2', {
      dur: 0.45, k0: 0.5, lower: LEGS, fade: 0.06, out: 0.2, trail: [0.3, 0.74],
      keys: (A2 = stance({
        'root.oz': [0, 0.03, 0.3, 0, -0.5, 0.14, 1, 0.04],
        'root.ry': [0, 0.08, 0.3, 0.16, -0.5, -0.1, 0.72, -0.14, 1, -0.02],
        'root.rx': [0, 0.14, 0.3, 0.2, -0.5, 0.06, 1, 0.06],
        'spine.ry': [0, 0.15, 0.3, 0.28, -0.5, -0.14, 0.72, -0.26, 1, 0],
        'chest.ry': [0, 0.2, 0.3, 0.4, -0.5, -0.2, 0.72, -0.4, 1, 0],
        'head.ry': [0, -0.3, 0.3, -0.7, -0.5, 0.3, 0.72, 0.6, 1, 0],
        'uaR.rz': [0, -1.1, 0.3, -1.05, -0.5, -1.5, 0.72, -1.85, 1, -0.6],
        'uaR.ry': [0, 1.4, 0.3, 1.9, -0.5, 0.3, 0.72, -0.55, 1, -0.15],
        'uaR.rx': [0, 0, 1, 0],
        'faR.rx': [0, -0.6, 0.3, -1.2, -0.5, -0.1, 0.72, -0.25, 1, -0.6],
        'hR.rx': [0, 1.3, 0.3, 0.7, -0.5, 1.5, 0.72, 1.9, 1, 1.0],
        'hR.ry': [0, 0, 1, 0],
        'hR.rz': [0, 0, 1, 0],
        'uaL.rx': [0, 0.3, 0.3, 0.5, -0.5, -0.6, 1, -0.1],
        'uaL.rz': [0, 0.5, 0.3, 0.4, -0.5, 0.85, 1, 0.3],
        'faL.rx': [0, -0.7, 0.3, -0.9, -0.5, -0.5, 1, -0.5],
        'cape1.rz': [0, 0, 0.3, 0.12, -0.5, -0.25, 0.8, -0.1, 1, 0],
        'cape2.rz': [0, 0, 0.3, 0.15, -0.56, -0.3, 0.85, -0.1, 1, 0],
      }, 0.9)),
    });
    // 第三段（终结）：双手举过头顶，跃起后劈到地上，落成弓步
    defClip(rig, 'attack3', {
      dur: 0.6, k0: 0.5, lower: LEGS, air: 'jump', fade: 0.07, out: 0.26, trail: [0.33, 0.6],
      keys: {
        'root.oy': [0, -0.3, 0.16, -0.45, 0.34, 0.36, -0.5, -0.6, 0.8, -0.6, 1, -0.3],
        'root.oz': [0, 0, 0.16, -0.08, 0.34, 0.04, -0.5, 0.22, 0.8, 0.2, 1, 0.05],
        'root.rx': [0, 0.05, 0.18, -0.16, 0.34, -0.26, -0.5, 0.32, 0.8, 0.28, 1, 0.06],
        'spine.rx': [0, 0, 0.18, -0.15, 0.34, -0.22, -0.5, 0.22, 0.8, 0.2, 1, 0.02],
        'chest.rx': [0, 0, 0.18, -0.12, 0.34, -0.18, -0.5, 0.16, 0.8, 0.14, 1, 0.02],
        'head.rx': [0, 0, 0.3, 0.25, -0.5, -0.35, 0.8, -0.3, 1, 0],
        'uaR.rx': [0, -1.2, 0.18, -3.0, 0.34, -3.5, -0.5, -1.1, 0.8, -1.0, 1, -0.4],
        'uaR.rz': [0, -0.1, 0.18, 0.3, 0.34, 0.32, -0.5, 0.3, 1, -0.15],
        'uaR.ry': [0, 0, 1, 0],
        'faR.rx': [0, -1.0, 0.18, -0.8, 0.34, -1.1, -0.5, -0.1, 0.8, -0.15, 1, -0.5],
        'hR.rx': [0, 0.6, 0.18, 0.3, 0.34, -0.2, -0.5, 1.3, 0.8, 1.25, 1, 0.6],
        'hR.ry': [0, 0, 1, 0],
        'hR.rz': [0, 0, 1, 0],
        'uaL.rx': [0, -1.2, 0.18, -3.0, 0.34, -3.5, -0.5, -1.05, 0.8, -0.95, 1, -0.2],
        'uaL.rz': [0, 0.1, 0.18, -0.3, 0.34, -0.32, -0.5, -0.35, 1, 0.15],
        'faL.rx': [0, -1.0, 0.18, -0.8, 0.34, -1.1, -0.5, -0.2, 0.8, -0.25, 1, -0.4],
        'thL.rx': [0, -0.5, 0.16, -0.75, 0.34, -0.75, -0.5, -1.62, 0.8, -1.58, 1, -0.3],
        'shL.rx': [0, 0.7, 0.16, 1.35, 0.34, 1.5, -0.5, 1.4, 0.8, 1.4, 1, 0.4],
        'ftL.rx': [0, 0, 0.34, 0.4, -0.5, 0, 1, 0],
        'thR.rx': [0, 0.2, 0.16, -0.45, 0.34, 0.1, -0.5, 0.48, 0.8, 0.5, 1, 0.1],
        'shR.rx': [0, 0.4, 0.16, 1.2, 0.34, 1.6, -0.5, 0.5, 0.8, 0.5, 1, 0.2],
        'ftR.rx': [0, 0.2, 0.34, 0.6, -0.5, 0.6, 1, 0.1],
        'thL.rz': [0, 0.1, 1, 0.1],
        'thR.rz': [0, -0.12, 1, -0.12],
        'cape1.rx': [0, 0.1, 0.34, -0.15, -0.5, 0.5, 0.8, 0.3, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.34, -0.2, -0.56, 0.45, 0.85, 0.25, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.34, -0.2, -0.62, 0.4, 0.9, 0.2, 1, 0.1],
      },
    });
    // 投掷（投射物技能）：左手从身后甩出
    defClip(rig, 'throw', {
      dur: 0.5, k0: 0.5, lower: LEGS, fade: 0.06, out: 0.2,
      keys: stance({
        'root.oz': [0, 0, 0.32, -0.06, -0.5, 0.1, 1, 0.02],
        'root.ry': [0, 0.03, 0.32, 0.15, -0.5, -0.1, 0.75, -0.14, 1, 0],
        'spine.ry': [0, 0.08, 0.32, 0.28, -0.5, -0.16, 0.75, -0.24, 1, 0],
        'chest.ry': [0, 0.12, 0.32, 0.42, -0.5, -0.25, 0.75, -0.36, 1, 0],
        'chest.rx': [0, 0, 0.32, -0.15, -0.5, 0.2, 1, 0],
        'head.ry': [0, -0.2, 0.32, -0.75, -0.5, 0.45, 0.75, 0.65, 1, 0],
        'uaL.rx': [0, 0.3, 0.32, 1.1, -0.5, -1.5, 0.75, -1.9, 1, -0.3],
        'uaL.rz': [0, 0.4, 0.32, 0.9, -0.5, 0.2, 0.75, -0.1, 1, 0.2],
        'faL.rx': [0, -1.0, 0.32, -1.9, -0.5, -0.1, 0.75, -0.3, 1, -0.5],
        'hL.rx': [0, 0, 0.32, 0.6, -0.5, -0.5, 1, 0],
        'uaR.rx': [0, -0.2, 0.32, -0.9, -0.5, 0.6, 1, -0.1],
        'uaR.rz': [0, -0.3, 0.32, -0.4, -0.5, -0.6, 1, -0.2],
        'faR.rx': [0, -0.6, 0.32, -0.9, -0.5, -0.3, 1, -0.5],
      }, 0.8),
    });
    // 施法（新星 / 连锁 / 陨石）：收拢蓄力，然后把武器举向空中
    defClip(rig, 'cast', {
      dur: 0.6, k0: 0.5, lower: LEGS, fade: 0.07, out: 0.24,
      keys: {
        'root.rx': [0, 0.05, 0.34, 0.2, -0.5, -0.1, 0.8, -0.07, 1, 0],
        'spine.rx': [0, 0, 0.34, 0.2, -0.5, -0.2, 0.8, -0.15, 1, 0],
        'chest.rx': [0, 0, 0.34, 0.15, -0.5, -0.2, 0.8, -0.14, 1, 0],
        'chest.ry': [0, 0, 0.34, -0.3, -0.5, 0.15, 1, 0],
        'head.rx': [0, 0, 0.34, 0.25, -0.5, -0.45, 0.8, -0.35, 1, 0],
        'uaR.rx': [0, -0.5, 0.34, -0.7, -0.5, -2.85, 0.8, -2.75, 1, -0.5],
        'uaR.rz': [0, -0.1, 0.34, 0.35, -0.5, -0.25, 0.8, -0.22, 1, -0.15],
        'uaR.ry': [0, 0, 1, 0],
        'faR.rx': [0, -0.8, 0.34, -1.9, -0.5, -0.15, 0.8, -0.2, 1, -0.6],
        'hR.rx': [0, 0.2, 0.34, -0.5, -0.5, 0.25, 0.8, 0.2, 1, 0.3],
        'hR.ry': [0, 0, 1, 0],
        'hR.rz': [0, 0, 1, 0],
        'uaL.rx': [0, -0.4, 0.34, -0.9, -0.5, -1.3, 0.8, -1.2, 1, -0.2],
        'uaL.rz': [0, 0.2, 0.34, -0.3, -0.5, 1.1, 0.8, 1.0, 1, 0.2],
        'faL.rx': [0, -0.8, 0.34, -1.8, -0.5, -0.3, 0.8, -0.35, 1, -0.4],
        'thL.rx': [0, -0.1, 0.34, -0.75, -0.5, -0.1, 1, 0],
        'shL.rx': [0, 0.15, 0.34, 1.0, -0.5, 0.12, 1, 0.05],
        'thR.rx': [0, 0, 0.34, -0.45, -0.5, 0.12, 1, 0],
        'shR.rx': [0, 0.15, 0.34, 1.0, -0.5, 0.1, 1, 0.05],
        'ftR.rx': [0, 0, 0.34, -0.3, -0.5, 0.25, 0.8, 0.2, 1, 0],
        'ftL.rx': [0, 0, 0.34, -0.2, -0.5, 0.25, 0.8, 0.2, 1, 0],
        'thL.rz': [0, 0.12, 1, 0.12],
        'thR.rz': [0, -0.12, 1, -0.12],
        'cape1.rx': [0, 0.1, 0.34, 0, -0.5, 0.45, 0.8, 0.25, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.34, 0, -0.56, 0.45, 0.86, 0.25, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.34, 0, -0.62, 0.4, 0.9, 0.2, 1, 0.1],
      },
    });
    // 闪现：蜷身 → 收成一线消失 → 在落点弹开
    defClip(rig, 'blink', {
      dur: 0.45, k0: 0.5, fade: 0.05, out: 0.2,
      keys: {
        'root.rx': [0, 0.1, 0.4, 0.35, 0.5, 0, 0.62, 0.22, 1, 0.03],
        'root.sy': [0, 1, 0.38, 0.88, -0.5, 1.7, 0.56, 0.62, 0.72, 1.1, 1, 1],
        'root.sx': [0, 1, 0.38, 1.08, -0.5, 0.12, 0.56, 1.28, 0.72, 0.95, 1, 1],
        'root.sz': [0, 1, 0.38, 1.08, -0.5, 0.12, 0.56, 1.28, 0.72, 0.95, 1, 1],
        'spine.rx': [0, 0, 0.4, 0.3, 0.5, 0, 0.62, 0.2, 1, 0],
        'uaL.rx': [0, -0.3, 0.4, -1.0, 0.6, -0.3, 1, 0],
        'uaL.rz': [0, 0.1, 0.4, -0.5, 0.5, 0.2, 0.62, 0.9, 1, 0.2],
        'faL.rx': [0, -0.8, 0.4, -1.9, 0.62, -0.4, 1, -0.4],
        'uaR.rx': [0, -0.3, 0.4, -1.0, 0.6, -0.3, 1, -0.2],
        'uaR.rz': [0, -0.1, 0.4, 0.5, 0.5, -0.2, 0.62, -0.9, 1, -0.2],
        'faR.rx': [0, -0.8, 0.4, -1.9, 0.62, -0.4, 1, -0.5],
        'thL.rx': [0, -0.2, 0.4, -1.15, 0.5, -0.2, 0.62, -0.9, 1, 0],
        'shL.rx': [0, 0.3, 0.4, 1.5, 0.5, 0.3, 0.62, 1.2, 1, 0.05],
        'thR.rx': [0, -0.1, 0.4, -0.95, 0.5, -0.1, 0.62, -0.7, 1, 0],
        'shR.rx': [0, 0.3, 0.4, 1.5, 0.5, 0.3, 0.62, 1.2, 1, 0.05],
        'ftL.rx': [0, 0, 0.4, -0.3, 0.5, 0, 0.62, -0.25, 1, 0],
        'ftR.rx': [0, 0, 0.4, -0.3, 0.5, 0, 0.62, -0.25, 1, 0],
        'cape1.rx': [0, 0.1, 0.4, -0.3, 0.5, 0.2, 0.62, 0.7, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.4, -0.4, 0.5, 0.2, 0.66, 0.6, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.4, -0.4, 0.5, 0.2, 0.7, 0.5, 1, 0.1],
      },
    });
    // 影步连斩的一刀：闪现落地时身形还收成一道竖线，随即弹开、压低重心，照前两段的挥法快速斩出。
    // 正手 / 反手两个版本交替；时长由调用方按「闪现到出刀」的间隔给（命中帧 k0 对在出刀那一刻）
    const flick = (keys) => Object.assign({}, keys, {
      'root.sx': [0, 0.15, 0.14, 0.3, 0.26, 1.18, 0.36, 1, 1, 1],
      'root.sz': [0, 0.15, 0.14, 0.3, 0.26, 1.18, 0.36, 1, 1, 1],
      'root.sy': [0, 1.7, 0.14, 1.5, 0.26, 0.86, 0.36, 1, 1, 1],
      'root.oy': [0, 0.1, 0.18, -0.16, -0.5, -0.12, 1, -0.04],
    });
    defClip(rig, 'flicker', { dur: 0.27, k0: 0.5, lower: LEGS, fade: 0.02, out: 0.14, trail: [0.3, 0.78], keys: flick(A1) });
    defClip(rig, 'flicker2', { dur: 0.27, k0: 0.5, lower: LEGS, fade: 0.02, out: 0.14, trail: [0.3, 0.78], keys: flick(A2) });
    // 旋风斩：两腿岔开压低重心，持刃的右臂平伸，整个人绕竖轴一圈圈地转（俯视逆时针，刃口在前）；
    // 循环播放，一圈的时长由调用方按出手间隔给；真的在走动时腿让位给步态
    const C = (v) => [0, v, 1, v];
    defClip(rig, 'spin', {
      dur: 0.36, loop: true, lower: LEGS, fade: 0.08, out: 0.16, trail: [0, 1],
      keys: {
        'root.oy': [0, -0.02, 0.5, -0.07, 1, -0.02],
        'root.rx': C(0.1),
        'spine.rx': C(0.06),
        'chest.ry': C(-0.25),
        'head.ry': C(0.35),
        'head.rx': C(0.05),
        'uaR.rz': C(-1.4),
        'uaR.ry': C(0.3),
        'uaR.rx': C(0),
        'faR.rx': C(-0.25),
        'hR.rx': C(1.5),
        'hR.ry': C(0),
        'hR.rz': C(0),
        'uaL.rz': C(1.2),
        'uaL.rx': C(0),
        'faL.rx': C(-0.4),
        'thL.rx': C(-0.35), 'shL.rx': C(0.6), 'ftL.rx': C(-0.2), 'thL.rz': C(0.28),
        'thR.rx': C(-0.35), 'shR.rx': C(0.6), 'ftR.rx': C(-0.2), 'thR.rz': C(-0.28),
        'cape1.rx': C(0.8), 'cape2.rx': C(0.6), 'cape3.rx': C(0.5), 'cape1.rz': C(0.3),
        'tab.rx': C(-0.5),
      },
      fn(ent, p, k) {
        p[ent.rig.J.root + 1] = k * TAU;
      },
    });
    // 处决：沉身后引，弓步突刺，拧身抽刃
    defClip(rig, 'execute', {
      dur: 0.9, k0: 0.5, fade: 0.07, out: 0.28, trail: [0.3, 0.74],
      keys: {
        'root.oz': [0, 0, 0.3, -0.2, -0.5, 0.34, 0.72, 0.3, 1, 0.05],
        'root.rx': [0, 0.05, 0.3, -0.1, -0.5, 0.3, 0.72, 0.22, 1, 0.05],
        'root.ry': [0, -0.08, 0.3, -0.25, -0.5, 0.1, 0.72, 0.22, 1, 0.03],
        'spine.ry': [0, -0.1, 0.3, -0.35, -0.5, 0.15, 0.72, 0.35, 1, 0],
        'chest.ry': [0, -0.1, 0.3, -0.45, -0.5, 0.2, 0.72, 0.5, 1, 0],
        'head.ry': [0, 0.2, 0.3, 0.9, -0.5, -0.4, 0.72, -0.9, 1, 0],
        'uaR.rx': [0, -0.2, 0.3, 0.75, -0.5, -1.45, 0.62, -1.4, 0.72, -0.7, 1, -0.3],
        'uaR.rz': [0, -0.3, 0.3, -0.55, -0.5, 0.05, 0.62, -0.1, 0.72, -1.3, 1, -0.3],
        'uaR.ry': [0, 0, 0.62, 0, 0.72, -0.3, 1, 0],
        'faR.rx': [0, -0.6, 0.3, -1.5, -0.5, -0.04, 0.62, -0.1, 0.72, -0.4, 1, -0.5],
        'hR.rx': [0, 0.8, 0.3, 1.2, -0.5, 1.5, 0.62, 1.45, 0.72, 1.2, 1, 0.7],
        'hR.ry': [0, 0, 1, 0],
        'hR.rz': [0, 0, 1, 0],
        'uaL.rx': [0, -0.6, 0.3, -1.45, -0.5, 0.75, 0.72, 0.6, 1, 0],
        'uaL.rz': [0, 0.2, 0.3, 0.1, -0.5, 0.7, 0.72, 0.8, 1, 0.2],
        'faL.rx': [0, -0.6, 0.3, -0.25, -0.5, -0.7, 1, -0.4],
        'thL.rx': [0, -0.4, 0.3, -0.5, -0.5, -1.6, 0.72, -1.5, 1, -0.2],
        'shL.rx': [0, 0.6, 0.3, 1.3, -0.5, 1.4, 0.72, 1.4, 1, 0.3],
        'thR.rx': [0, 0.25, 0.3, -0.5, -0.5, 0.5, 0.72, 0.55, 1, 0.08],
        'shR.rx': [0, 0.3, 0.3, 1.3, -0.5, 0.45, 0.72, 0.45, 1, 0.15],
        'ftR.rx': [0, 0.2, 0.3, -0.3, -0.5, 0.6, 0.72, 0.6, 1, 0],
        'thL.rz': [0, 0.1, 1, 0.1],
        'thR.rz': [0, -0.14, 1, -0.14],
        'cape1.rx': [0, 0.1, 0.3, -0.2, -0.5, 0.6, 0.72, 0.35, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.3, -0.25, -0.56, 0.55, 0.78, 0.3, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.3, -0.25, -0.62, 0.5, 0.84, 0.25, 1, 0.1],
      },
    });
    // 翻滚：抱成一团向前滚一整圈
    defClip(rig, 'roll', {
      dur: 0.32, base: 'rest', air: true, fade: 0.04, out: 0.14,
      // 头朝下的那一段，兜帽 / 肩背 / 胯贴着地面滚过去，而不是沉到地面以下
      clear: [['head', 0, 0.14, -0.03, 0.25], ['chest', 0, 0.1, -0.02, 0.33], ['uaL', 0.06, 0, 0, 0.2], ['uaR', -0.06, 0, 0, 0.18], ['root', 0, -0.06, 0, 0.3]],
      keys: {
        'root.rx': [0, 0.5, 0.2, 1.6, 0.8, 5.6, 1, TAU],
        'root.oy': [0, -0.3, 0.25, -0.52, 0.75, -0.52, 1, -0.3],
        'spine.rx': [0, 0.5, 0.25, 0.85, 0.75, 0.85, 1, 0.3],
        'chest.rx': [0, 0.3, 0.25, 0.55, 0.75, 0.55, 1, 0.2],
        'head.rx': [0, 0.3, 0.25, 0.6, 0.75, 0.6, 1, 0],
        'thL.rx': [0, -1.2, 0.25, -2.0, 0.75, -2.0, 1, -0.9],
        'shL.rx': [0, 1.4, 0.25, 2.3, 0.75, 2.3, 1, 1.2],
        'thR.rx': [0, -1.0, 0.25, -1.9, 0.75, -1.9, 1, -0.6],
        'shR.rx': [0, 1.4, 0.25, 2.3, 0.75, 2.3, 1, 1.1],
        'uaL.rx': [0, -0.6, 0.25, -1.1, 0.75, -1.1, 1, -0.3],
        'faL.rx': [0, -1.4, 0.25, -2.0, 0.75, -2.0, 1, -0.8],
        'uaL.rz': [0, 0.2, 1, 0.2],
        'uaR.rx': [0, -0.6, 0.25, -1.0, 0.75, -1.0, 1, -0.3],
        'faR.rx': [0, -1.4, 0.25, -1.9, 0.75, -1.9, 1, -0.8],
        'uaR.rz': [0, -0.3, 1, -0.3],
        'hR.rx': [0, 1.2, 1, 1.0],
        'cape1.rx': [0, 0.3, 0.5, -0.4, 1, 0.5],
        'cape2.rx': [0, 0.3, 0.5, -0.5, 1, 0.5],
        'cape3.rx': [0, 0.3, 0.5, -0.5, 1, 0.5],
      },
    });
    // 死亡：踉跄、跪倒、向后仰倒
    defClip(rig, 'death', {
      dur: 0.95, base: 'rest', hold: true, air: true, fade: 0.08,
      keys: {
        'root.rx': [0, -0.15, 0.25, -0.3, 0.5, 0.05, -0.85, -1.5, 1, -1.47],
        'root.oy': [0, 0, 0.25, -0.12, 0.5, -0.48, -0.85, -0.8, 1, -0.82],
        'root.oz': [0, 0, 0.25, -0.12, 0.5, -0.2, 0.85, -0.5, 1, -0.5],
        'root.rz': [0, 0, 0.5, 0.12, 1, 0.1],
        'spine.rx': [0, -0.1, 0.25, -0.3, 0.5, 0.25, 0.85, -0.05, 1, 0],
        'chest.rx': [0, -0.1, 0.25, -0.25, 0.5, 0.2, 0.85, -0.12, 1, -0.08],
        'head.rx': [0, -0.3, 0.25, -0.5, 0.5, 0.45, 0.85, -0.5, 0.93, -0.2, 1, -0.3],
        'head.ry': [0, 0, 0.85, 0.5, 1, 0.55],
        'thL.rx': [0, 0, 0.25, 0.1, 0.5, -0.7, 0.85, -0.3, 1, -0.2],
        'shL.rx': [0, 0, 0.25, 0.3, 0.5, 2.0, 0.85, 0.9, 1, 0.75],
        'thR.rx': [0, 0, 0.25, 0.3, 0.5, -0.5, 0.85, -0.05, 1, 0],
        'shR.rx': [0, 0, 0.25, 0.4, 0.5, 2.0, 0.85, 0.3, 1, 0.2],
        'thL.rz': [0, 0.05, 1, 0.3],
        'thR.rz': [0, -0.05, 1, -0.25],
        'uaL.rx': [0, 0, 0.25, -0.9, 0.5, -0.4, 0.85, -0.1, 1, 0],
        'uaL.rz': [0, 0.2, 0.25, 0.9, 0.5, 0.5, 0.85, 1.25, 1, 1.2],
        'faL.rx': [0, -0.3, 0.25, -1.0, 0.5, -0.6, 0.85, -0.3, 1, -0.2],
        'uaR.rx': [0, 0, 0.25, -0.6, 0.5, -0.2, 0.85, 0, 1, 0],
        'uaR.rz': [0, -0.2, 0.25, -0.8, 0.5, -0.5, 0.85, -1.0, 1, -0.95],
        'faR.rx': [0, -0.4, 0.25, -0.9, 0.5, -0.5, 0.85, -0.2, 1, -0.15],
        'hR.rx': [0, 0.6, 0.5, 1.2, 1, 1.5],
        'cape1.rx': [0, 0.1, 0.5, 0.5, 0.85, 0, 1, 0],
        'cape2.rx': [0, 0.1, 0.5, 0.5, 0.85, -0.1, 1, -0.1],
        'cape3.rx': [0, 0.1, 0.5, 0.5, 0.85, -0.2, 1, -0.2],
      },
    });
  }

  // 武器的握法 / 挂点长度 / 稀有度的发光
  const GEAR_TIP = [1.17, 1.54, 0.68];
  const GEAR_GLOW = [[0xcfd6e2, 0.3], [0x7f9dff, 1.15], [0xffd75e, 1.5]];
  // 稀有度光晕：[沿武器的位置（占挂点长度的比例）, 魔法的大小, 稀有的大小, 不透明度]。
  // 刃的光裹着刃身；长杖 / 短杖握在头和胸口旁边，光只罩住杖头的晶体，小而淡，不把兜帽和上身照成一片白
  const GEAR_AURA = [[0.62, 1.0, 1.5, 1], [0.885, 0.5, 0.72, 0.5], [0.81, 0.42, 0.6, 0.5]];
  const auraMats = Object.create(null);
  function auraMat(hex, alpha) {
    const key = hex + ':' + alpha;
    return (
      auraMats[key] ||
      (auraMats[key] = new T.SpriteMaterial({ map: glowTex(), color: lin(hex), opacity: alpha, transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }))
    );
  }
  function applyGear(ent, type, rar) {
    ent.gearType = type;
    ent.gearRar = rar;
    const joint = type === 1 ? 'wS' : type === 2 ? 'wW' : 'wB';
    ent.sock.weapon.j = ent.rig.JI[type < 0 ? 'hR' : joint];
    ent.sock.weapon.z = type < 0 ? 0.05 : GEAR_TIP[type];
    const gg = GEAR_GLOW[rar] || GEAR_GLOW[0], m = ent.auxMat;
    m.userData.e0.set(gg[0]).convertSRGBToLinear();
    m.userData.ei0 = gg[1];
    if (ent.flashT <= 0) {
      m.emissive.copy(m.userData.e0);
      m.emissiveIntensity = gg[1];
    }
    ent.aura.visible = type >= 0 && rar >= 1;
    if (type >= 0 && rar >= 1) {
      const ga = GEAR_AURA[type];
      ent.aura.material = auraMat(gg[0], ga[3]);
      ent.aura.scale.setScalar(rar >= 2 ? ga[2] : ga[1]);
    }
  }
  function makePlayerEnt() {
    const ent = newEnt('player', playerRig(), WH, 0xffb347, 1.15);
    ent.sock = { weapon: { j: 0, x: 0, y: 0, z: 1 } };
    ent.uRim.value.setRGB(0.22, 0.2, 0.17);
    ent.aura = new T.Sprite(spriteMat(0xffffff));
    ent.aura.visible = false;
    ent.body.add(ent.aura);
    applyGear(ent, 0, 0);
    return ent;
  }
  W.makePlayer = function () {
    const ent = makePlayerEnt();
    trail.ent = ent; // 刀光只跟真正的玩家（死亡替身、预热用的那只不拖）
    ent.ring = groundDisc(ent, dashRingTex(), 0xffd08a, 0.95, 0.42);
    gearFrom(ent, G.save && G.save.equip);
    return ent;
  };
  function gearFrom(ent, equip) {
    const w = equip && equip.weapon;
    const type = w ? G.clamp(w.baseIdx | 0, 0, 2) : -1, rar = w ? G.clamp(w.rarity | 0, 0, 2) : 0;
    if (type !== ent.gearType || rar !== ent.gearRar) applyGear(ent, type, rar);
  }
  // 玩家的武器模型跟着装备走：equip 是存档里的 { slot: item }。
  // 武器底材 baseIdx 0 / 1 / 2 → 刃 / 长杖 / 短杖，稀有度决定武器上那道光的颜色和强度；没有武器时空手。
  W.setPlayerGear = function (equip) {
    const ent = G.player && G.player.ent;
    if (ent && !ent.removed) gearFrom(ent, equip);
  };

  // =====================================================================
  // 小怪
  // =====================================================================
  // 双足步态的一条腿：前摆时屈膝，蹬地时伸直。在已有姿态上叠加，w 为权重，a 为摆幅
  function legCycle(p, TH, SH, FT, sn, cs, w, a, kn) {
    const lift = cs > 0 ? cs : 0;
    p[TH] += (-a * sn + 0.3 * a * lift) * w;
    p[SH] += (0.2 + kn * lift * lift + 0.25 * (sn < 0 ? -sn : 0)) * w;
    p[FT] += (0.5 * (sn < 0 ? -sn : 0) - 0.3 * (sn > 0 ? sn : 0)) * a * w;
  }
  // 多足步态的一条腿：髋关节前后摆 + 抬腿。side = ±1（左 / 右）
  function crawlLeg(p, HIP, KNEE, ph, side, w, swing, lift) {
    const s = Math.sin(ph), up = Math.max(0, Math.cos(ph));
    p[HIP + 1] += side * swing * s * w;
    p[HIP + 2] += side * lift * up * w;
    if (KNEE >= 0) p[KNEE + 2] -= side * lift * 0.8 * up * w;
  }

  // ---------------------------------------------------------------------
  // 游魂：佝偻的枯瘦躯体裹着破寿衣，鹿骨面具，过长的手臂拖着骨爪，肋骨间透出元素余火
  // ---------------------------------------------------------------------
  function huskRig() {
    return rigOf('husk', () => {
      const HIDE = 0x8a7f76, HIDE_D = 0x4a4340, CLOTH = 0x2d2734, CLOTH_L = 0x4a4152, CLOTH_IN = 0x17141b, BONE = 0xded5ba, BONE_D = 0x9c927a;
      const b = rigBuilder('husk', NB_SMALL);
      b.j('root', null, 0, 0.95, 0).j('spine', 'root', 0, 1.02, 0.02).j('head', 'spine', 0, 1.5, 0.3).j('jaw', 'head', 0, 1.47, 0.36);
      b.j('uaL', 'spine', 0.31, 1.46, 0.12).j('faL', 'uaL', 0.43, 1.1, 0.2).j('uaR', 'spine', -0.31, 1.46, 0.12).j('faR', 'uaR', -0.43, 1.1, 0.2);
      b.j('thL', 'root', 0.14, 0.93, 0).j('shL', 'thL', 0.16, 0.52, 0.06).j('ftL', 'shL', 0.16, 0.1, 0);
      b.j('thR', 'root', -0.14, 0.93, 0).j('shR', 'thR', -0.16, 0.52, 0.06).j('ftR', 'shR', -0.16, 0.1, 0);
      b.j('rag1', 'root', 0, 0.94, -0.18).j('rag2', 'rag1', 0, 0.55, -0.27);

      // 下身：破袍，下摆撕成几条
      b.at('root').surf(SURF.cloth);
      b.pd(gLathe('hk/skirt', [[0.37, 0.4], [0.34, 0.56], [0.25, 0.82], [0.19, 1.02]], 9), [CLOTH, CLOTH_L], CLOTH_IN, 0, 0, 0, 0, 0, 0, 1, 1, 0.9);
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * TAU + 0.3, h = 0.16 + (k % 3) * 0.07;
        b.pd(gPlate('hk/tat' + (k % 3), [[-0.1, 0.02], [0.1, 0.02], [0.04, -h * 0.6], [0, -h], [-0.05, -h * 0.5]], 0.008, 0.002), CLOTH, CLOTH_IN, Math.sin(a) * 0.36, 0.42, Math.cos(a) * 0.33, -0.12, a, 0);
      }
      b.surf(SURF.bone).p(gTorus(0.2, 0.022, 4, 10), BONE_D, 0, 0.99, 0, HALF_PI, 0, 0, 1, 0.9, 1);
      // 身后拖着的两截破布
      b.at('rag1').surf(SURF.cloth).pd(gPlate('hk/rag1', [[-0.15, 0], [0.15, 0], [0.12, -0.42], [-0.1, -0.4]], 0.008, 0.002), [CLOTH, CLOTH_L], CLOTH_IN, 0, 0.95, -0.2, 0.25);
      b.at('rag2').pd(gPlate('hk/rag2', [[-0.11, 0], [0.12, 0], [0.1, -0.2], [0.03, -0.42], [-0.04, -0.24], [-0.1, -0.36]], 0.008, 0.002), CLOTH, CLOTH_IN, 0, 0.56, -0.3, 0.35);

      // 躯干：前倾的胸腔，肋骨，后背披着寿衣，脊骨刺穿布面
      b.at('spine').surf(SURF.hide);
      b.p(gSph(0.21, 9, 7), [HIDE_D, 0x2a2625], 0, 1.28, 0.1, 0.45, 0, 0, 1, 1.25, 0.85);
      b.p(gCyl(0.12, 0.17, 0.3, 7), HIDE_D, 0, 1.06, 0.03, 0.2);
      b.surf(SURF.bone);
      for (let i = 0; i < 3; i++) {
        const y = 1.2 + i * 0.105, z = 0.08 + i * 0.045;
        for (const s of [1, -1]) {
          b.p(gSweep('hk/rib' + i + s, [[s * 0.04, y + 0.05, z - 0.14], [s * 0.25, y + 0.02, z], [s * 0.22, y - 0.03, z + 0.17], [s * 0.05, y - 0.06, z + 0.23]], [0.03, 0.03, 0.025, 0.016], 5), [BONE_D, BONE], 0, 0, 0);
        }
      }
      b.p(gCyl(0.035, 0.03, 0.36, 5), BONE, 0, 1.28, 0.31, 0.42);
      b.g(gSph(0.1, 8, 6), 1, 0, 1.27, 0.19, 0, 0, 0, 1, 1.2, 0.8);
      b.surf(SURF.cloth);
      b.pd(gDrape('hk/shroud', [[0.36, 0.96], [0.36, 1.2], [0.3, 1.44], [0.17, 1.62]], 3.5, 8), [CLOTH, CLOTH_L], CLOTH_IN, 0, -0.06, 0.08, 0.2);
      b.surf(SURF.bone, true);
      for (let i = 0; i < 4; i++) {
        const y = 1.62 - i * 0.15, z = -0.22 - Math.sin(i * 0.9) * 0.07;
        b.p(gCone(0.05, 0.2, 4), BONE, 0, y, z, -1.25 - i * 0.12);
        b.g(gSph(0.045, 5, 3), 0.8, 0, y - 0.03, z + 0.06);
      }
      b.surf(SURF.bone);
      for (const s of [1, -1]) b.p(gSph(0.1, 7, 5), [BONE_D, BONE], s * 0.31, 1.47, 0.12);

      // 头：拉长的兽骨面具，深眼窝，一对分叉的角
      b.at('head').surf(SURF.bone);
      b.p(gSph(0.155, 9, 7), [BONE_D, BONE], 0, 1.57, 0.36, 0.25, 0, 0, 0.9, 0.9, 1.25);
      b.p(gCyl(0.06, 0.1, 0.24, 7), [BONE_D, BONE], 0, 1.49, 0.54, 1.25, 0, 0, 1, 1, 0.8);
      b.p(gRBox(0.2, 0.05, 0.1, 0.02), BONE, 0, 1.635, 0.46, 0.35);
      b.surf(SURF.cloth);
      for (const s of [1, -1]) b.p(gSph(0.05, 6, 5), 0x0c0a0d, s * 0.068, 1.575, 0.47, 0, 0, 0, 1, 1.1, 0.7);
      for (const s of [1, -1]) b.g(gSph(0.026, 6, 4), 1, s * 0.068, 1.575, 0.5);
      b.surf(SURF.bone);
      for (const s of [1, -1]) {
        b.p(gSweep('hk/horn' + s, [[s * 0.08, 1.66, 0.3], [s * 0.2, 1.8, 0.2], [s * 0.31, 1.99, 0.22], [s * 0.28, 2.16, 0.32]], [0.045, 0.04, 0.028, 0.006], 5), [BONE_D, BONE], 0, 0, 0);
        b.p(gSweep('hk/tine' + s, [[s * 0.21, 1.81, 0.2], [s * 0.32, 1.86, 0.07], [s * 0.4, 1.99, 0.0]], [0.03, 0.022, 0.005], 4), BONE, 0, 0, 0);
        b.g(gSph(0.03, 5, 3), 0.9, s * 0.28, 2.16, 0.32).g(gSph(0.024, 5, 3), 0.9, s * 0.4, 1.99, 0.0);
      }
      b.at('jaw').p(gPlate('hk/jaw', [[-0.07, 0], [0.07, 0], [0.045, -0.2], [-0.045, -0.2]], 0.035, 0.012), BONE_D, 0, 1.47, 0.39, -1.2);

      // 手臂：细瘦的上臂，缠着骨片的前臂，三根长爪（爪尖带一点元素光）
      for (const s of [1, -1]) {
        const U = s > 0 ? 'uaL' : 'uaR', F = s > 0 ? 'faL' : 'faR';
        b.at(U).surf(SURF.hide).limb([HIDE_D, HIDE], s * 0.31, 1.46, 0.12, s * 0.43, 1.1, 0.2, 0.07, 0.055, 6, 2);
        b.surf(SURF.bone, true).p(gCone(0.05, 0.2, 4), BONE, s * 0.47, 1.12, 0.1, -2.2, 0, -s * 0.5);
        b.at(F).surf(SURF.bone).limb([BONE_D, BONE], s * 0.43, 1.1, 0.2, s * 0.47, 0.76, 0.36, 0.055, 0.045, 6, 0);
        b.p(gSph(0.075, 7, 5), BONE_D, s * 0.47, 0.74, 0.37);
        for (let k = -1; k <= 1; k++) {
          const x = s * 0.47 + k * 0.065;
          b.p(gSweep('hk/claw' + s + k, [[x, 0.73, 0.38], [x + k * 0.03, 0.6, 0.53], [x + k * 0.04, 0.42, 0.54]], [0.032, 0.025, 0.004], 4), [BONE, BONE_D], 0, 0, 0);
          b.g(gSph(0.022, 5, 3), 0.7, x + k * 0.04, 0.44, 0.54);
        }
      }
      // 腿：只有小腿和脚露在袍子外
      for (const s of [1, -1]) {
        const TH = s > 0 ? 'thL' : 'thR', SH = s > 0 ? 'shL' : 'shR', FT = s > 0 ? 'ftL' : 'ftR';
        b.at(TH).surf(SURF.hide).limb(HIDE_D, s * 0.14, 0.93, 0, s * 0.16, 0.52, 0.06, 0.085, 0.06, 6, 2);
        b.at(SH).surf(SURF.bone).limb([BONE_D, BONE], s * 0.16, 0.52, 0.06, s * 0.16, 0.1, 0, 0.05, 0.04, 6, 0);
        b.at(FT).p(gSph(0.07, 7, 5), [BONE_D, BONE], s * 0.16, 0.055, 0.07, 0, 0, 0, 0.9, 0.7, 1.9);
        b.surf(SURF.bone, true).p(gCone(0.03, 0.12, 4), BONE, s * 0.13, 0.04, 0.2, HALF_PI + 0.2).p(gCone(0.03, 0.12, 4), BONE, s * 0.2, 0.04, 0.19, HALF_PI + 0.2, 0, -s * 0.3);
      }

      const rig = b.build({ height: 2.1, reach: 1.6, stride: 3.6, shade: 0.3 });
      rig.hitJ = [rig.J.head, rig.J.spine];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.1;
      sock(rig, 'weapon', 'faR', -0.02, -0.66, 0.34);
      sock(rig, 'hand', 'faL', 0.02, -0.4, 0.2);
      sock(rig, 'head', 'head', 0, 0.1, 0.1);
      sock(rig, 'chest', 'spine', 0, 0.3, 0.15);
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, s = Math.sin(ent.walk), c = Math.cos(ent.walk), id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 5) * mv;
        const a = Math.sin(t * 1.4 + ent.phase), a2 = Math.sin(t * 2.3 + ent.phase * 2);
        p[J.root + 2] = 0.07 * s * run + 0.02 * a * id;
        p[J.root + 1] = -0.1 * s * run;
        p[J.spine] = 0.12 + 0.2 * run + 0.03 * a;
        p[J.spine + 1] = 0.16 * s * run;
        p[J.spine + 2] = 0.05 * a2 * id;
        p[J.head] = -0.15 - 0.2 * run + 0.04 * a2;
        p[J.head + 2] = 0.16 * a * id + 0.08 * s * run;
        p[J.head + 1] = 0.12 * Math.sin(t * 0.7 + ent.phase) * id;
        p[J.jaw] = 0.12 + 0.1 * Math.max(0, Math.sin(t * 7 + ent.phase)) * (0.3 + run);
        // 手臂前伸着够东西，走起来一前一后地抓
        p[J.uaL] = -0.45 - 0.5 * run + (0.4 * s) * run + 0.05 * a;
        p[J.uaR] = -0.45 - 0.5 * run - (0.4 * s) * run + 0.05 * a2;
        p[J.uaL + 2] = 0.12;
        p[J.uaR + 2] = -0.12;
        p[J.faL] = -0.45 - 0.2 * run - 0.2 * s * run + 0.06 * a2;
        p[J.faR] = -0.45 - 0.2 * run + 0.2 * s * run + 0.06 * a;
        p[J.thL + 2] = 0.05;
        p[J.thR + 2] = -0.05;
        p[J.thL] = p[J.thR] = -0.12;
        p[J.shL] = p[J.shR] = 0.25;
        legCycle(p, J.thL, J.shL, J.ftL, s, c, run, 0.55, 0.8);
        legCycle(p, J.thR, J.shR, J.ftR, -s, -c, run, 0.55, 0.8);
        p[J.rag1] = 0.15 + 0.35 * run + 0.06 * a;
        p[J.rag2] = 0.15 + 0.25 * run + 0.1 * a2;
      };
      // 蓄力：后仰，双爪高举
      defClip(rig, 'windup', {
        dur: 0.35, hold: true, fade: 0.06,
        keys: {
          'root.oz': [0, 0, 1, -0.12],
          'spine.rx': [0, 0.15, 1, -0.5],
          'head.rx': [0, -0.15, 1, -0.55],
          'jaw.rx': [0, 0.15, 1, 0.75],
          'uaL.rx': [0, -0.8, 1, -2.5], 'uaL.rz': [0, 0.15, 1, 0.75], 'faL.rx': [0, -0.5, 1, -1.1],
          'uaR.rx': [0, -0.8, 1, -2.7], 'uaR.rz': [0, -0.15, 1, -0.6], 'faR.rx': [0, -0.5, 1, -1.2],
          'thL.rx': [0, -0.2, 1, -0.6], 'shL.rx': [0, 0.3, 1, 0.95],
          'thR.rx': [0, -0.1, 1, -0.2], 'shR.rx': [0, 0.3, 1, 0.9],
          'rag1.rx': [0, 0.15, 1, -0.2],
        },
      });
      // 扑击：整个上身砸下来，双爪交叉着撕过去
      defClip(rig, 'attack', {
        dur: 0.4, k0: 0.3, fade: 0.03, out: 0.2,
        keys: {
          'root.oz': [0, -0.12, -0.3, 0.3, 0.7, 0.2, 1, 0],
          'spine.rx': [0, -0.5, -0.3, 0.7, 0.65, 0.6, 1, 0.15],
          'spine.ry': [0, 0, -0.3, 0.25, 1, 0],
          'head.rx': [0, -0.55, -0.3, 0.1, 1, -0.15],
          'jaw.rx': [0, 0.75, -0.3, 0.05, 1, 0.12],
          'uaL.rx': [0, -2.5, -0.3, -1.0, 0.65, -0.7, 1, -0.5], 'uaL.rz': [0, 0.75, -0.3, -0.45, 0.65, -0.3, 1, 0.12], 'faL.rx': [0, -1.1, -0.3, -0.15, 1, -0.45],
          'uaR.rx': [0, -2.7, -0.36, -1.1, 0.65, -0.7, 1, -0.5], 'uaR.rz': [0, -0.6, -0.36, 0.5, 0.65, 0.3, 1, -0.12], 'faR.rx': [0, -1.2, -0.36, -0.15, 1, -0.45],
          'thL.rx': [0, -0.6, -0.3, -1.0, 0.65, -0.9, 1, -0.12], 'shL.rx': [0, 0.95, -0.3, 1.0, 0.65, 0.9, 1, 0.25],
          'thR.rx': [0, -0.2, -0.3, 0.35, 0.65, 0.3, 1, -0.12], 'shR.rx': [0, 0.9, -0.3, 0.4, 1, 0.25],
          'rag1.rx': [0, -0.2, -0.3, 0.8, 1, 0.15], 'rag2.rx': [0, 0, -0.36, 0.7, 1, 0.15],
        },
      });
      // 失衡：瘫软地弓着背，脑袋和双臂晃荡
      defClip(rig, 'stagger', {
        dur: 1.5, loop: true, fade: 0.15, out: 0.25,
        keys: {
          'thL.rx': [0, -0.5, 1, -0.5], 'shL.rx': [0, 1.0, 1, 1.0], 'thR.rx': [0, -0.35, 1, -0.35], 'shR.rx': [0, 0.9, 1, 0.9],
          'faL.rx': [0, -0.15, 1, -0.15], 'faR.rx': [0, -0.15, 1, -0.15], 'jaw.rx': [0, 0.5, 1, 0.5],
        },
        fn(ent, p, k) {
          const J = rig.J, a = k * TAU, s = Math.sin(a), c = Math.cos(a);
          p[J.root + 2] = 0.1 * s;
          p[J.spine] = 0.6 + 0.08 * c;
          p[J.spine + 2] = 0.16 * s;
          p[J.head] = 0.45 + 0.1 * Math.sin(a * 2);
          p[J.head + 2] = 0.35 * Math.sin(a + 0.8);
          p[J.uaL] = 0.1 + 0.2 * Math.sin(a + 1.5);
          p[J.uaR] = 0.1 + 0.2 * Math.sin(a + 2.6);
          p[J.uaL + 2] = 0.1 + 0.1 * s;
          p[J.uaR + 2] = -0.1 + 0.1 * s;
        },
      });
      // 死亡：双膝一软，向前扑倒
      defClip(rig, 'death', {
        dur: 0.6, base: 'rest', hold: true, air: true, fade: 0.05,
        keys: {
          'root.rx': [0, -0.25, 0.3, -0.1, -0.8, 1.35, 1, 1.3],
          'root.oy': [0, 0, 0.3, -0.25, -0.8, -0.74, 1, -0.76],
          'root.oz': [0, -0.1, 0.3, -0.05, 0.8, 0.3, 1, 0.3],
          'root.rz': [0, 0, 1, 0.2],
          'spine.rx': [0, -0.4, 0.3, 0.3, 0.8, 0.25, 1, 0.2],
          'head.rx': [0, -0.6, 0.3, 0.2, 0.8, -0.5, 0.9, -0.2, 1, -0.3], 'head.rz': [0, 0, 1, 0.5],
          'jaw.rx': [0, 0.8, 1, 0.5],
          'uaL.rx': [0, -1.6, 0.3, -1.0, 0.8, -2.6, 1, -2.7], 'uaL.rz': [0, 0.6, 1, 0.9], 'faL.rx': [0, -0.8, 0.8, -0.3, 1, -0.2],
          'uaR.rx': [0, -1.4, 0.3, -0.8, 0.8, -1.9, 1, -2.0], 'uaR.rz': [0, -0.6, 1, -1.1], 'faR.rx': [0, -0.8, 0.8, -0.6, 1, -0.5],
          'thL.rx': [0, -0.2, 0.3, -0.9, 0.8, -0.3, 1, -0.2], 'shL.rx': [0, 0.3, 0.3, 1.6, 0.8, 0.5, 1, 0.4],
          'thR.rx': [0, -0.1, 0.3, -0.7, 0.8, 0.1, 1, 0.1], 'shR.rx': [0, 0.3, 0.3, 1.7, 0.8, 0.9, 1, 0.8],
          'rag1.rx': [0, 0.2, 0.5, 0.9, 1, -0.3], 'rag2.rx': [0, 0.2, 0.6, 0.8, 1, -0.2],
        },
      });
      return rig;
    });
  }

  // ---------------------------------------------------------------------
  // 巨躯：山一样的肩背，小脑袋埋在肩窝里，一双石锤似的前臂拖到地面，背上顶着元素晶簇
  // ---------------------------------------------------------------------
  function bruteRig() {
    return rigOf('brute', () => {
      const HIDE = 0x8a6c5e, HIDE_D = 0x5a443c, BELLY = 0xa88d7a, DARK = 0x2a2321, STONE = 0x8d8684, STONE_D = 0x5b5654, BONE = 0xd0c4a8, IRON = 0x4a4a52, CLOTH = 0x5a2a26, CLOTH_IN = 0x2a1413;
      const b = rigBuilder('brute', NB_SMALL);
      b.j('root', null, 0, 1.12, 0).j('chest', 'root', 0, 1.45, 0).j('head', 'chest', 0, 2.2, 0.45).j('jaw', 'head', 0, 2.14, 0.55);
      b.j('uaL', 'chest', 0.92, 2.12, 0.05).j('faL', 'uaL', 1.18, 1.5, 0.12).j('uaR', 'chest', -0.92, 2.12, 0.05).j('faR', 'uaR', -1.18, 1.5, 0.12);
      b.j('thL', 'root', 0.4, 1.08, 0).j('shL', 'thL', 0.46, 0.58, 0.06).j('ftL', 'shL', 0.46, 0.16, 0.02);
      b.j('thR', 'root', -0.4, 1.08, 0).j('shR', 'thR', -0.46, 0.58, 0.06).j('ftR', 'shR', -0.46, 0.16, 0.02);
      b.j('flap', 'root', 0, 1.1, 0.42).j('flapB', 'root', 0, 1.1, -0.4);

      // 胯：粗腰、铁链腰带、兽骨扣、前后两片遮裆布
      b.at('root').surf(SURF.hide);
      b.p(gSph(0.6, 10, 7), [HIDE_D, HIDE], 0, 1.1, 0, 0, 0, 0, 1.02, 0.62, 0.86);
      b.surf(SURF.dark).p(gTorus(0.58, 0.07, 5, 14), IRON, 0, 1.2, 0, HALF_PI, 0, 0, 1, 0.86, 1);
      b.surf(SURF.bone).p(gSph(0.15, 7, 5), BONE, 0, 1.2, 0.5, 0, 0, 0, 1, 1.1, 0.7);
      b.surf(SURF.cloth);
      b.at('flap').pd(gPlate('br/flap', [[-0.26, 0], [0.26, 0], [0.22, -0.5], [0.08, -0.62], [-0.05, -0.5], [-0.2, -0.58]], 0.02, 0.006), [CLOTH_IN, CLOTH], CLOTH_IN, 0, 1.1, 0.5, -0.12);
      b.at('flapB').pd(gPlate('br/flapb', [[-0.3, 0], [0.3, 0], [0.24, -0.55], [-0.02, -0.46], [-0.22, -0.6]], 0.02, 0.006), [CLOTH_IN, CLOTH], CLOTH_IN, 0, 1.1, -0.48, 0.12, Math.PI);

      // 躯干：桶一样的胸背，浅色肚皮，肩上压着岩甲，背脊顶出一排晶簇
      b.at('chest').surf(SURF.hide);
      b.p(gSph(0.86, 12, 9), [HIDE_D, HIDE], 0, 1.95, 0, 0.12, 0, 0, 1.2, 0.92, 0.9);
      b.p(gSph(0.56, 10, 7), [HIDE, BELLY], 0, 1.66, 0.3, 0, 0, 0, 1.15, 1, 0.9);
      b.surf(SURF.stone, true);
      b.p(gIco(0.52, 0), [STONE_D, STONE], 0.98, 2.38, 0, 0.3, 0.4, 0, 1.1, 0.8, 1.15);
      b.p(gIco(0.52, 0), [STONE_D, STONE], -0.98, 2.38, 0, 0.1, 1.3, 0.2, 1.1, 0.8, 1.15);
      b.p(gIco(0.3, 0), STONE, 0.62, 2.62, -0.2, 0.5, 0.2, 0.3).p(gIco(0.3, 0), STONE, -0.62, 2.62, -0.2, 0.2, 0.9, 0.1);
      b.surf(SURF.bone, true);
      for (const s of [1, -1]) b.p(gCone(0.12, 0.4, 5), BONE, s * 1.28, 2.62, 0, 0, 0, -s * 0.7);
      b.surf(SURF.ice, true);
      const cr = [[0, 2.82, -0.42, -0.5, 0, 0.26, 1.0], [0.36, 2.7, -0.5, -0.55, -0.4, 0.2, 0.75], [-0.36, 2.7, -0.5, -0.55, 0.4, 0.2, 0.75], [0.18, 2.42, -0.72, -0.95, -0.2, 0.17, 0.6], [-0.2, 2.36, -0.74, -1.0, 0.25, 0.17, 0.6]];
      for (const c of cr) b.g(gCone(c[5], c[6], 5), 1, c[0], c[1], c[2], c[3], 0, c[4]);
      b.surf(SURF.stone, true);
      for (const c of cr) b.p(gIco(c[5] * 1.25, 0), STONE_D, c[0] * 0.9, c[1] - c[6] * 0.42, c[2] + 0.12, 0.4, c[0] * 3, 0);

      // 头：缩在肩窝里，铁下颚，獠牙，眉骨下两点光
      b.at('head').surf(SURF.hide);
      b.p(gSph(0.3, 9, 7), [HIDE_D, HIDE], 0, 2.3, 0.5, 0, 0, 0, 1, 0.95, 1.05);
      b.surf(SURF.stone, true).p(gRBox(0.5, 0.14, 0.26, 0.04), STONE_D, 0, 2.4, 0.66, 0.25);
      b.surf(SURF.cloth).p(gRBox(0.34, 0.09, 0.1, 0.02), 0x0d0b0b, 0, 2.31, 0.74);
      for (const s of [1, -1]) b.g(gSph(0.04, 6, 4), 1, s * 0.1, 2.31, 0.79, 0, 0, 0, 1.2, 0.8, 1);
      b.at('jaw').surf(SURF.dark);
      b.p(gPlate('br/jaw', [[-0.24, 0.04], [0.24, 0.04], [0.2, -0.16], [0, -0.22], [-0.2, -0.16]], 0.2, 0.03), IRON, 0, 2.18, 0.68, 0.2);
      b.surf(SURF.bone);
      for (const s of [1, -1]) b.p(gSweep('br/tusk' + s, [[s * 0.16, 2.14, 0.8], [s * 0.21, 2.26, 0.86], [s * 0.19, 2.4, 0.84]], [0.05, 0.04, 0.008], 5), BONE, 0, 0, 0);

      // 手臂：越往下越粗，前臂裹着铁箍，拳头是一整块带尖的岩石
      for (const s of [1, -1]) {
        const U = s > 0 ? 'uaL' : 'uaR', F = s > 0 ? 'faL' : 'faR';
        b.at(U).surf(SURF.hide).limb([HIDE_D, HIDE], s * 0.92, 2.12, 0.05, s * 1.18, 1.5, 0.12, 0.33, 0.27, 8, 3);
        b.at(F).limb([HIDE, HIDE_D], s * 1.18, 1.5, 0.12, s * 1.24, 0.82, 0.24, 0.28, 0.4, 8, 0);
        b.surf(SURF.dark).p(gTorus(0.36, 0.06, 5, 12), IRON, s * 1.22, 1.02, 0.2, HALF_PI + 0.18, 0, 0);
        b.p(gTorus(0.31, 0.045, 5, 12), IRON, s * 1.2, 1.3, 0.16, HALF_PI + 0.18, 0, 0);
        b.surf(SURF.stone, true).p(gIco(0.5, 0), [STONE_D, STONE], s * 1.25, 0.56, 0.3, 0.4, s * 0.5, 0.2, 1, 0.95, 1.1);
        b.surf(SURF.bone, true);
        for (let k = -1; k <= 1; k++) b.p(gCone(0.1, 0.3, 4), BONE, s * 1.25 + k * 0.24, 0.5, 0.72 - Math.abs(k) * 0.08, HALF_PI, 0, -k * 0.35);
      }
      // 腿：短粗，脚掌宽大
      for (const s of [1, -1]) {
        const TH = s > 0 ? 'thL' : 'thR', SH = s > 0 ? 'shL' : 'shR', FT = s > 0 ? 'ftL' : 'ftR';
        b.at(TH).surf(SURF.hide).limb([HIDE_D, HIDE], s * 0.4, 1.08, 0, s * 0.46, 0.58, 0.06, 0.33, 0.26, 8, 2);
        b.at(SH).limb(HIDE_D, s * 0.46, 0.58, 0.06, s * 0.46, 0.18, 0.02, 0.25, 0.28, 8, 0);
        b.surf(SURF.dark).p(gTorus(0.27, 0.045, 5, 12), IRON, s * 0.46, 0.32, 0.03, HALF_PI);
        b.at(FT).surf(SURF.stone, true).p(gIco(0.34, 0), [DARK, STONE_D], s * 0.46, 0.14, 0.12, 0, 0.4, 0, 1, 0.5, 1.35);
        b.surf(SURF.bone, true);
        for (let k = -1; k <= 1; k++) b.p(gCone(0.07, 0.2, 4), BONE, s * 0.46 + k * 0.17, 0.08, 0.56, HALF_PI + 0.1, 0, -k * 0.25);
      }

      const rig = b.build({ height: 3.0, reach: 2.4, stride: 1.75, shade: 0.3 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.16;
      sock(rig, 'weapon', 'faR', -0.07, -0.95, 0.2);
      sock(rig, 'hand', 'faL', 0.07, -0.95, 0.2);
      sock(rig, 'head', 'head', 0, 0.15, 0.1);
      sock(rig, 'chest', 'chest', 0, 0.45, 0.6);
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, s = Math.sin(ent.walk), c = Math.cos(ent.walk), id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 3.1) * mv, br = Math.sin(t * 1.3 + ent.phase);
        p[J.root + 2] = 0.09 * s * run;
        p[J.root + 1] = -0.14 * s * run;
        p[J.root] = 0.06 * run;
        p[J.chest] = 0.12 + 0.08 * run + 0.025 * br;
        p[J.chest + 1] = 0.2 * s * run;
        p[J.chest + 2] = -0.05 * s * run;
        p[J.chest + 6] = p[J.chest + 8] = 1 + 0.02 * br;
        p[J.head] = -0.05 + 0.04 * br;
        p[J.head + 1] = 0.2 * Math.sin(t * 0.6 + ent.phase) * id - 0.15 * s * run;
        p[J.jaw] = 0.05 + 0.08 * Math.max(0, br);
        // 指节拖地的摆臂
        p[J.uaL] = -0.1 + 0.45 * s * run + 0.03 * br;
        p[J.uaR] = -0.1 - 0.45 * s * run + 0.03 * br;
        p[J.uaL + 2] = 0.1 + 0.03 * br;
        p[J.uaR + 2] = -0.1 - 0.03 * br;
        p[J.faL] = -0.22 - 0.15 * s * run;
        p[J.faR] = -0.22 + 0.15 * s * run;
        p[J.thL] = p[J.thR] = -0.1;
        p[J.shL] = p[J.shR] = 0.2;
        p[J.thL + 2] = 0.08;
        p[J.thR + 2] = -0.08;
        legCycle(p, J.thL, J.shL, J.ftL, s, c, run, 0.5, 0.7);
        legCycle(p, J.thR, J.shR, J.ftR, -s, -c, run, 0.5, 0.7);
        p[J.flap] = -0.08 - 0.3 * Math.abs(s) * run + 0.04 * br;
        p[J.flapB] = 0.08 + 0.25 * run + 0.04 * br;
      };
      // 蓄力：双拳并举过头，胸膛后仰
      defClip(rig, 'windup', {
        dur: 0.85, hold: true, fade: 0.1,
        keys: {
          'root.rx': [0, 0.05, 0.75, -0.14, 1, -0.16],
          'chest.rx': [0, 0.15, 0.75, -0.4, 1, -0.45],
          'head.rx': [0, 0, 1, -0.3],
          'jaw.rx': [0, 0.05, 0.5, 0.45, 1, 0.5],
          'uaL.rx': [0, -0.3, 0.3, -1.2, 0.75, -2.75, 1, -2.9], 'uaL.rz': [0, 0.15, 0.3, 0.5, 1, -0.22], 'faL.rx': [0, -0.3, 0.75, -0.7, 1, -0.6],
          'uaR.rx': [0, -0.3, 0.3, -1.2, 0.75, -2.75, 1, -2.9], 'uaR.rz': [0, -0.15, 0.3, -0.5, 1, 0.22], 'faR.rx': [0, -0.3, 0.75, -0.7, 1, -0.6],
          'thL.rx': [0, -0.2, 1, -0.35], 'shL.rx': [0, 0.3, 1, 0.45], 'thR.rx': [0, -0.1, 1, 0.1], 'shR.rx': [0, 0.3, 1, 0.3],
          'flap.rx': [0, -0.1, 1, 0.1],
        },
      });
      // 砸地：双拳夯进面前的地里，顿一下再起身
      defClip(rig, 'attack', {
        dur: 0.55, k0: 0.22, fade: 0.03, out: 0.3,
        keys: {
          'root.rx': [0, -0.16, -0.22, 0.3, 0.7, 0.26, 1, 0.06],
          'root.oz': [0, 0, -0.22, 0.2, 0.7, 0.18, 1, 0],
          'chest.rx': [0, -0.45, -0.22, 0.75, 0.7, 0.68, 1, 0.14],
          'head.rx': [0, -0.3, -0.22, -0.5, 0.7, -0.45, 1, -0.05],
          'jaw.rx': [0, 0.5, -0.22, 0.1, 0.7, 0.4, 1, 0.05],
          'uaL.rx': [0, -2.9, -0.22, -0.85, 0.7, -0.8, 1, -0.15], 'uaL.rz': [0, -0.22, -0.22, -0.3, 0.7, -0.26, 1, 0.1], 'faL.rx': [0, -0.6, -0.22, -0.1, 0.7, -0.12, 1, -0.22],
          'uaR.rx': [0, -2.9, -0.22, -0.85, 0.7, -0.8, 1, -0.15], 'uaR.rz': [0, 0.22, -0.22, 0.3, 0.7, 0.26, 1, -0.1], 'faR.rx': [0, -0.6, -0.22, -0.1, 0.7, -0.12, 1, -0.22],
          'thL.rx': [0, -0.35, -0.22, -1.15, 0.7, -1.1, 1, -0.1], 'shL.rx': [0, 0.45, -0.22, 1.2, 0.7, 1.15, 1, 0.2],
          'thR.rx': [0, 0.1, -0.22, -0.85, 0.7, -0.8, 1, -0.1], 'shR.rx': [0, 0.3, -0.22, 1.25, 0.7, 1.2, 1, 0.2],
          'flap.rx': [0, 0.1, -0.22, -0.7, 1, -0.08], 'flapB.rx': [0, 0, -0.26, 0.9, 1, 0.08],
        },
      });
      // 失衡：单膝跪地，一只拳头撑着，喘
      defClip(rig, 'stagger', {
        dur: 1.8, loop: true, fade: 0.2, out: 0.35,
        keys: {
          'thL.rx': [0, -1.3, 1, -1.3], 'shL.rx': [0, 1.45, 1, 1.45], 'thR.rx': [0, 0.1, 1, 0.1], 'shR.rx': [0, 1.5, 1, 1.5], 'ftR.rx': [0, 0.5, 1, 0.5],
          'uaL.rx': [0, -0.55, 1, -0.55], 'faL.rx': [0, -0.05, 1, -0.05], 'uaL.rz': [0, -0.1, 1, -0.1],
          'uaR.rz': [0, -0.35, 1, -0.35], 'faR.rx': [0, -0.5, 1, -0.5], 'jaw.rx': [0, 0.5, 1, 0.5],
        },
        fn(ent, p, k) {
          const J = rig.J, s = Math.sin(k * TAU), s2 = Math.sin(k * TAU * 2);
          p[J.root] = 0.2;
          p[J.root + 2] = 0.05 * s;
          p[J.chest] = 0.5 + 0.06 * s2;
          p[J.chest + 2] = 0.1 * s;
          p[J.chest + 6] = p[J.chest + 8] = 1 + 0.04 * s2;
          p[J.head] = 0.35 + 0.08 * s2;
          p[J.head + 2] = 0.25 * s;
          p[J.uaR] = 0.2 + 0.1 * s;
        },
      });
      // 死亡：晃两下，像棵树一样朝前栽倒
      defClip(rig, 'death', {
        dur: 0.8, base: 'rest', hold: true, air: true, fade: 0.06,
        keys: {
          'root.rx': [0, -0.2, 0.3, -0.28, -0.82, 1.42, 0.9, 1.34, 1, 1.38],
          'root.oy': [0, 0, 0.3, -0.05, -0.82, -0.62, 1, -0.64],
          'root.oz': [0, -0.1, 0.3, -0.15, 0.82, 0.5, 1, 0.5],
          'root.rz': [0, 0, 0.3, 0.1, 1, 0.08],
          'chest.rx': [0, -0.3, 0.3, -0.35, 0.82, 0.15, 1, 0.1],
          'head.rx': [0, -0.4, 0.3, -0.5, 0.82, 0.2, 0.9, -0.3, 1, -0.2], 'jaw.rx': [0, 0.6, 1, 0.4],
          'uaL.rx': [0, -0.4, 0.3, -0.9, 0.82, -2.3, 1, -2.4], 'uaL.rz': [0, 0.5, 0.3, 0.9, 1, 0.8], 'faL.rx': [0, -0.4, 1, -0.3],
          'uaR.rx': [0, -0.2, 0.3, -0.6, 0.82, -1.3, 1, -1.4], 'uaR.rz': [0, -0.5, 0.3, -0.9, 1, -1.0], 'faR.rx': [0, -0.4, 1, -0.6],
          'thL.rx': [0, -0.1, 0.3, -0.3, 0.82, 0.1, 1, 0.1], 'shL.rx': [0, 0.2, 0.3, 0.7, 0.82, 0.4, 1, 0.3],
          'thR.rx': [0, 0, 0.3, 0.1, 0.82, -0.2, 1, -0.2], 'shR.rx': [0, 0.2, 0.3, 0.3, 0.82, 0.8, 1, 0.7],
          'flap.rx': [0, 0, 0.5, -0.8, 1, 0], 'flapB.rx': [0, 0, 0.6, 1.0, 1, 0.2],
        },
      });
      return rig;
    });
  }

  // ---------------------------------------------------------------------
  // 喷吐者：四条细腿托着低矮的分节甲壳，长颈顶着一朵张开的喇叭口，喉囊里蓄着元素液
  // ---------------------------------------------------------------------
  function spitterRig() {
    return rigOf('spitter', () => {
      const SHELL = 0x6f8060, SHELL_D = 0x3b4636, DARK = 0x20241f, PALE = 0xc2c7a6, PALE_D = 0x8e9478, HORN = 0x2e2a26;
      const b = rigBuilder('spitter', NB_SMALL);
      b.j('root', null, 0, 0.78, -0.05).j('neck1', 'root', 0, 0.98, 0.34).j('neck2', 'neck1', 0, 1.42, 0.46).j('head', 'neck2', 0, 1.82, 0.62);
      b.j('sac', 'neck1', 0, 1.14, 0.5).j('jawU', 'head', 0, 1.9, 0.72).j('jawD', 'head', 0, 1.76, 0.72);
      b.j('tail1', 'root', 0, 0.82, -0.6).j('tail2', 'tail1', 0, 1.0, -1.0);
      const LEG = [['FL', 1, 1], ['FR', -1, 1], ['BL', 1, -1], ['BR', -1, -1]];
      for (const [n, sx, sz] of LEG) {
        b.j('hip' + n, 'root', sx * 0.32, 0.8, sz > 0 ? 0.26 : -0.38).j('knee' + n, 'hip' + n, sx * 0.8, 1.14, sz > 0 ? 0.52 : -0.68);
      }

      // 躯壳：扁椭圆的身体，背上三片叠甲，腹面色浅
      b.at('root').surf(SURF.chitin);
      b.p(gSph(0.5, 11, 8), [PALE_D, SHELL_D], 0, 0.76, -0.08, 0, 0, 0, 1, 0.62, 1.32);
      b.surf(SURF.chitin);
      const plates = [[0.3, 0.5, 0.92], [-0.05, 0.56, 1.0], [-0.42, 0.46, 0.84]];
      plates.forEach((pl, i) => {
        b.p(gDome(pl[1], 10, 4, 1.25), [SHELL_D, SHELL], 0, 0.72, pl[0], -0.12 - i * 0.1, 0, 0, pl[2], 0.72, 0.62);
        b.surf(SURF.chitin, true).p(gCone(0.09, 0.3, 4), HORN, 0, 1.08 - i * 0.03, pl[0] - 0.12, -0.7).surf(SURF.chitin);
      });
      for (const s of [1, -1]) b.p(gSph(0.14, 7, 5), SHELL_D, s * 0.34, 0.8, 0.28).p(gSph(0.14, 7, 5), SHELL_D, s * 0.34, 0.8, -0.38);
      // 尾：两节，末端一根毒刺
      b.at('tail1').limb([SHELL_D, SHELL], 0, 0.82, -0.6, 0, 1.0, -1.0, 0.17, 0.11, 7, 3);
      b.at('tail2').limb(SHELL, 0, 1.0, -1.0, 0, 1.24, -1.24, 0.1, 0.06, 6, 2);
      b.surf(SURF.chitin, true).p(gCone(0.07, 0.34, 5), HORN, 0, 1.38, -1.28, 0.5);
      b.g(gSph(0.05, 6, 4), 0.8, 0, 1.24, -1.24);

      // 颈：两节肉质长颈，带环纹
      b.at('neck1').surf(SURF.hide).limb([PALE_D, PALE], 0, 0.98, 0.34, 0, 1.42, 0.46, 0.17, 0.125, 8, 3);
      b.surf(SURF.chitin).p(gTorus(0.15, 0.03, 4, 10), SHELL_D, 0, 1.3, 0.43, HALF_PI - 0.26);
      b.at('neck2').surf(SURF.hide).limb([PALE, PALE_D], 0, 1.42, 0.46, 0, 1.82, 0.62, 0.125, 0.11, 8, 2);
      b.surf(SURF.chitin).p(gTorus(0.128, 0.026, 4, 10), SHELL_D, 0, 1.56, 0.515, HALF_PI - 0.38).p(gTorus(0.12, 0.024, 4, 10), SHELL_D, 0, 1.7, 0.57, HALF_PI - 0.38);
      // 喉囊：蓄力时鼓起来
      b.at('sac').g(gSph(0.2, 9, 7), 0.85, 0, 1.14, 0.52, 0, 0, 0, 1, 1.1, 0.95);
      b.surf(SURF.chitin).p(gTorus(0.2, 0.018, 4, 12), SHELL_D, 0, 1.14, 0.52, 0, 0, 0, 1, 1.1, 1).p(gTorus(0.2, 0.018, 4, 12), SHELL_D, 0, 1.14, 0.52, 0, HALF_PI, 0, 1, 1.1, 0.95);

      // 头：喇叭口。上下各两片颚瓣，口腔里是亮的
      b.at('head').surf(SURF.chitin);
      b.p(gSph(0.24, 9, 7), [SHELL_D, SHELL], 0, 1.83, 0.64, 0, 0, 0, 1, 0.95, 1.15);
      b.g(gSph(0.17, 8, 6), 1, 0, 1.83, 0.84, 0, 0, 0, 1, 1, 0.6);
      for (const s of [1, -1]) b.g(gSph(0.04, 6, 4), 1, s * 0.19, 1.93, 0.68);
      const petal = gPlate('sp/petal', [[-0.13, 0], [0.13, 0], [0.18, 0.26], [0, 0.56], [-0.18, 0.26]], 0.03, 0.014);
      b.at('jawU');
      for (const s of [1, -1]) b.pd(petal, [SHELL_D, SHELL], 0x1a120e, s * 0.12, 1.95, 0.78, 1.05, 0, -s * 0.5);
      b.at('jawD');
      for (const s of [1, -1]) b.pd(petal, [SHELL_D, PALE_D], 0x1a120e, s * 0.12, 1.71, 0.78, 2.1, 0, -s * 2.6);

      // 腿：先向上拱起到膝，再长长地扎向地面
      for (const [n, sx, sz] of LEG) {
        const hz = sz > 0 ? 0.26 : -0.38, kz = sz > 0 ? 0.52 : -0.68, fz = sz > 0 ? 0.8 : -1.0;
        b.at('hip' + n).surf(SURF.chitin).limb([SHELL_D, DARK], sx * 0.32, 0.8, hz, sx * 0.8, 1.14, kz, 0.085, 0.06, 6, 2);
        b.at('knee' + n).limb(DARK, sx * 0.8, 1.14, kz, sx * 1.0, 0.03, fz, 0.06, 0.02, 6, 0);
        b.surf(SURF.chitin, true).p(gCone(0.05, 0.16, 4), HORN, sx * 0.84, 1.24, kz, 0, 0, -sx * 0.5);
      }

      const rig = b.build({ height: 2.1, reach: 1.5, stride: 4.4, shade: 0.25 });
      rig.hitJ = [rig.J.neck2, rig.J.head];
      sock(rig, 'weapon', 'head', 0, 0, 0.35);
      sock(rig, 'hand', 'head', 0, 0, 0.35);
      sock(rig, 'head', 'head', 0, 0.1, 0);
      sock(rig, 'chest', 'root', 0, 0.2, 0.2);
      const HIPS = LEG.map((l) => rig.J['hip' + l[0]]), KNEES = LEG.map((l) => rig.J['knee' + l[0]]);
      const LPH = [0, Math.PI, Math.PI, 0]; // 对角的两条腿同步
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, w = ent.walk, id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 4.2) * mv;
        const a = Math.sin(t * 2.2 + ent.phase), a2 = Math.sin(t * 1.3 + ent.phase * 2);
        p[J.root + 4] = 0.03 * a + 0.035 * Math.cos(2 * w) * run;
        p[J.root] = 0.03 * a2 * id - 0.05 * run;
        p[J.root + 2] = 0.05 * Math.sin(w) * run;
        for (let i = 0; i < 4; i++) crawlLeg(p, HIPS[i], KNEES[i], w + LPH[i], LEG[i][1], run, 0.4, 0.32);
        // 长颈像蛇一样左右找目标
        p[J.neck1] = -0.05 + 0.05 * a + 0.12 * run;
        p[J.neck1 + 2] = 0.1 * a2 * id + 0.06 * Math.sin(w) * run;
        p[J.neck2] = 0.12 - 0.06 * a - 0.1 * run;
        p[J.neck2 + 2] = 0.12 * Math.sin(t * 1.3 + ent.phase * 2 + 0.9) * id;
        p[J.head] = 0.1 + 0.08 * a2;
        p[J.head + 1] = 0.25 * Math.sin(t * 0.8 + ent.phase) * id;
        p[J.jawU] = -0.12 - 0.1 * Math.max(0, a);
        p[J.jawD] = 0.12 + 0.1 * Math.max(0, a);
        const sw = 1 + 0.07 * Math.sin(t * 3.1 + ent.phase);
        p[J.sac + 6] = p[J.sac + 7] = p[J.sac + 8] = sw;
        p[J.tail1] = -0.1 + 0.08 * a2;
        p[J.tail1 + 1] = 0.25 * Math.sin(t * 1.7 + ent.phase) * (0.5 + 0.5 * id) + 0.2 * Math.sin(w) * run;
        p[J.tail2] = -0.2 + 0.12 * a;
        p[J.tail2 + 1] = 0.3 * Math.sin(t * 1.7 + ent.phase - 0.8) * (0.5 + 0.5 * id);
      };
      rig.post = function (ent, o, t) {
        // 喉囊越鼓越亮
        setGlow(ent, 0.75 + 0.55 * Math.max(0, o[rig.J.sac + 6] - 0.8));
      };
      // 蓄力：长颈后仰，喉囊鼓胀，颚瓣张开
      defClip(rig, 'windup', {
        dur: 0.45, hold: true, fade: 0.07,
        keys: {
          'root.rx': [0, 0, 1, -0.2], 'root.oz': [0, 0, 1, -0.1],
          'neck1.rx': [0, 0, 1, -0.6], 'neck2.rx': [0, 0.1, 1, -0.45], 'head.rx': [0, 0.1, 1, -0.2],
          'jawU.rx': [0, -0.12, 1, -0.75], 'jawD.rx': [0, 0.12, 1, 0.75],
          'sac.s': [0, 1, 0.7, 1.55, 1, 1.7],
          'tail1.rx': [0, -0.1, 1, 0.3], 'tail2.rx': [0, -0.2, 1, 0.4],
          'hipFL.rz': [0, 0, 1, 0.22], 'hipFR.rz': [0, 0, 1, -0.22], 'kneeFL.rz': [0, 0, 1, -0.2], 'kneeFR.rz': [0, 0, 1, 0.2],
        },
      });
      // 喷吐：脖子甩向前，喉囊一瘪
      defClip(rig, 'attack', {
        dur: 0.45, k0: 0.22, fade: 0.03, out: 0.22,
        keys: {
          'root.rx': [0, -0.2, -0.22, 0.14, 1, 0], 'root.oz': [0, -0.1, -0.22, 0.14, 1, 0],
          'neck1.rx': [0, -0.6, -0.22, 0.55, 0.6, 0.35, 1, 0], 'neck2.rx': [0, -0.45, -0.22, 0.4, 0.6, 0.3, 1, 0.1], 'head.rx': [0, -0.2, -0.22, -0.5, 0.6, -0.3, 1, 0.1],
          'jawU.rx': [0, -0.75, -0.22, -1.1, 0.6, -0.4, 1, -0.12], 'jawD.rx': [0, 0.75, -0.22, 1.1, 0.6, 0.4, 1, 0.12],
          'sac.s': [0, 1.7, -0.22, 0.55, 0.6, 0.8, 1, 1],
          'tail1.rx': [0, 0.3, -0.22, -0.4, 1, -0.1], 'tail2.rx': [0, 0.4, -0.22, -0.5, 1, -0.2],
          'hipFL.rz': [0, 0.22, -0.22, -0.1, 1, 0], 'hipFR.rz': [0, -0.22, -0.22, 0.1, 1, 0],
        },
      });
      // 失衡：四腿劈开趴低，脖子耷拉到地上打晃
      defClip(rig, 'stagger', {
        dur: 1.6, loop: true, fade: 0.15, out: 0.3,
        keys: {
          'root.oy': [0, -0.32, 1, -0.32],
          'hipFL.rz': [0, -0.35, 1, -0.35], 'hipFR.rz': [0, 0.35, 1, 0.35], 'hipBL.rz': [0, -0.35, 1, -0.35], 'hipBR.rz': [0, 0.35, 1, 0.35],
          'kneeFL.rz': [0, 0.5, 1, 0.5], 'kneeFR.rz': [0, -0.5, 1, -0.5], 'kneeBL.rz': [0, 0.5, 1, 0.5], 'kneeBR.rz': [0, -0.5, 1, -0.5],
          'jawU.rx': [0, -0.5, 1, -0.5], 'jawD.rx': [0, 0.6, 1, 0.6], 'sac.s': [0, 0.75, 1, 0.75],
        },
        fn(ent, p, k) {
          const J = rig.J, s = Math.sin(k * TAU), c = Math.cos(k * TAU);
          p[J.root + 2] = 0.08 * s;
          p[J.neck1] = 0.75 + 0.1 * c;
          p[J.neck1 + 2] = 0.3 * s;
          p[J.neck2] = 0.5 + 0.1 * s;
          p[J.neck2 + 2] = 0.25 * c;
          p[J.head] = -0.3 + 0.15 * Math.sin(k * TAU * 2);
          p[J.tail1] = 0.3;
          p[J.tail2] = 0.3 + 0.1 * s;
        },
      });
      // 死亡：腿一收，侧翻，脖子甩到地上
      defClip(rig, 'death', {
        dur: 0.6, base: 'rest', hold: true, fade: 0.05,
        keys: {
          'root.oy': [0, 0.1, 0.3, 0.15, -0.75, -0.42, 1, -0.44],
          'root.rz': [0, 0, 0.3, 0.2, -0.75, 1.15, 1, 1.1],
          'root.rx': [0, -0.2, 1, 0.1],
          'neck1.rx': [0, -0.6, 0.3, -0.4, -0.8, 1.0, 1, 0.95], 'neck1.rz': [0, 0, 1, -0.5],
          'neck2.rx': [0, -0.4, 0.3, 0, 0.85, 0.6, 1, 0.55], 'head.rx': [0, 0, 1, 0.4],
          'jawU.rx': [0, -1.0, 1, -0.5], 'jawD.rx': [0, 1.0, 1, 0.7], 'sac.s': [0, 1.3, 0.4, 0.5, 1, 0.3],
          'hipFL.rz': [0, 0.3, 1, -0.9], 'hipFR.rz': [0, -0.3, 1, 0.9], 'hipBL.rz': [0, 0.3, 1, -0.9], 'hipBR.rz': [0, -0.3, 1, 0.7],
          'kneeFL.rz': [0, 0, 1, 1.5], 'kneeFR.rz': [0, 0, 1, -1.4], 'kneeBL.rz': [0, 0, 1, 1.6], 'kneeBR.rz': [0, 0, 1, -1.2],
          'tail1.rx': [0, 0.4, 1, -0.4], 'tail2.rx': [0, 0.4, 1, -0.5],
        },
      });
      return rig;
    });
  }

  // ---------------------------------------------------------------------
  // 爆裂虫：六条短腿驮着一颗被甲肋箍住的发光腹囊，囊比身子还大，头前顶着一对引信似的触角
  // ---------------------------------------------------------------------
  function bomberRig() {
    return rigOf('bomber', () => {
      const SHELL = 0x4a4654, SHELL_D = 0x23212a, PALE = 0x9d93a6, HORN = 0xcfc6b0;
      const b = rigBuilder('bomber', NB_SMALL);
      b.j('root', null, 0, 0.5, 0).j('head', 'root', 0, 0.5, 0.42).j('sac', 'root', 0, 0.74, -0.2).j('ribs', 'root', 0, 0.56, -0.2);
      b.j('antL', 'head', 0.1, 0.62, 0.6).j('antR', 'head', -0.1, 0.62, 0.6);
      const LZ = [0.3, 0.02, -0.28];
      for (let i = 0; i < 3; i++) b.j('legL' + i, 'root', 0.24, 0.46, LZ[i]).j('legR' + i, 'root', -0.24, 0.46, LZ[i]);

      // 胸节 + 腹板
      b.at('root').surf(SURF.chitin);
      b.p(gSph(0.32, 10, 7), [SHELL_D, SHELL], 0, 0.5, 0.12, 0, 0, 0, 1, 0.72, 1.3);
      b.p(gDome(0.3, 9, 3, 1.3), [SHELL_D, SHELL], 0, 0.54, 0.26, -0.5, 0, 0, 1.05, 0.7, 1);
      b.p(gSph(0.3, 9, 6), SHELL_D, 0, 0.46, -0.26, 0, 0, 0, 1, 0.55, 1.2);
      // 腹囊：发光的大球，表面爬着暗色的筋
      b.at('sac').g(gSph(0.5, 12, 9), 0.9, 0, 0.86, -0.26, 0, 0, 0, 1, 0.95, 1.08);
      b.g(gSph(0.2, 8, 6), 1, 0.2, 1.18, -0.12).g(gSph(0.16, 7, 5), 1, -0.24, 1.1, -0.48).g(gSph(0.14, 7, 5), 1, 0.05, 1.22, -0.5);
      b.surf(SURF.chitin);
      b.p(gTorus(0.5, 0.022, 4, 16), SHELL_D, 0, 0.86, -0.26, 0.2, 0.5, 0, 1, 0.96, 1.05).p(gTorus(0.5, 0.022, 4, 16), SHELL_D, 0, 0.86, -0.26, -0.3, -0.7, 0.2, 1, 0.96, 1.05);
      // 甲肋：三对，从身侧向上箍住腹囊
      b.at('ribs');
      for (let i = 0; i < 3; i++) {
        const z = -0.02 - i * 0.24;
        for (const s of [1, -1]) {
          b.p(gSweep('bm/rib' + i + s, [[s * 0.2, 0.5, z], [s * 0.56, 0.72, z], [s * 0.54, 1.12, z - 0.03], [s * 0.26, 1.36, z - 0.05]], [0.06, 0.055, 0.04, 0.012], 5), [SHELL_D, SHELL], 0, 0, 0);
        }
      }
      b.p(gSweep('bm/keel', [[0, 0.62, 0.22], [0, 1.1, 0.26], [0, 1.4, 0.0], [0, 1.42, -0.3]], [0.07, 0.06, 0.045, 0.012], 5), [SHELL_D, SHELL], 0, 0, 0);
      // 头：楔形小脑袋，一对大颚，四只小眼
      b.at('head').surf(SURF.chitin);
      b.p(gSph(0.2, 9, 6), [SHELL_D, SHELL], 0, 0.5, 0.5, 0.2, 0, 0, 1.1, 0.75, 1.1);
      b.surf(SURF.bone);
      for (const s of [1, -1]) b.p(gSweep('bm/mand' + s, [[s * 0.1, 0.44, 0.62], [s * 0.2, 0.4, 0.78], [s * 0.1, 0.36, 0.92]], [0.045, 0.035, 0.006], 5), [PALE, HORN], 0, 0, 0);
      for (const s of [1, -1]) b.g(gSph(0.032, 6, 4), 1, s * 0.11, 0.57, 0.66).g(gSph(0.022, 5, 3), 1, s * 0.17, 0.55, 0.58);
      // 触角：末端一点火星
      for (const s of [1, -1]) {
        b.at(s > 0 ? 'antL' : 'antR').surf(SURF.chitin);
        b.p(gSweep('bm/ant' + s, [[s * 0.1, 0.62, 0.6], [s * 0.2, 0.9, 0.72], [s * 0.3, 1.02, 0.95]], [0.025, 0.018, 0.01], 4), SHELL_D, 0, 0, 0);
        b.g(gSph(0.045, 6, 4), 1, s * 0.3, 1.02, 0.95);
      }
      // 腿
      for (let i = 0; i < 3; i++) {
        for (const s of [1, -1]) {
          const z = LZ[i], dz = (1 - i) * 0.2;
          b.at((s > 0 ? 'legL' : 'legR') + i).surf(SURF.chitin);
          b.p(gSweep('bm/leg' + i + s, [[s * 0.24, 0.46, z], [s * 0.52, 0.66, z + dz * 0.5], [s * 0.72, 0.3, z + dz], [s * 0.78, 0.0, z + dz * 1.2]], [0.06, 0.05, 0.035, 0.012], 5), [SHELL_D, SHELL], 0, 0, 0);
          b.surf(SURF.bone).p(gSph(0.055, 6, 4), PALE, s * 0.52, 0.66, z + dz * 0.5);
        }
      }

      const rig = b.build({ height: 1.45, reach: 1.4, stride: 7.5, shade: 0.2 });
      rig.hitJ = [rig.J.head];
      sock(rig, 'weapon', 'sac', 0, 0.2, 0);
      sock(rig, 'hand', 'head', 0, 0, 0.3);
      sock(rig, 'head', 'head', 0, 0.15, 0.1);
      sock(rig, 'chest', 'sac', 0, 0.1, 0);
      const LEGS6 = [rig.J.legL0, rig.J.legR0, rig.J.legL1, rig.J.legR1, rig.J.legL2, rig.J.legR2];
      const PH6 = [0, Math.PI, Math.PI, 0, 0, Math.PI]; // 三角步态
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, w = ent.walk, id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 7.2) * mv;
        const a = Math.sin(t * 3 + ent.phase);
        p[J.root + 4] = 0.02 * a * id + 0.03 * Math.cos(2 * w) * run;
        p[J.root + 2] = 0.08 * Math.sin(w) * run;
        p[J.root] = 0.1 * run;
        for (let i = 0; i < 6; i++) {
          const side = i & 1 ? -1 : 1;
          crawlLeg(p, LEGS6[i], -1, w + PH6[i], side, run, 0.5, 0.4);
          p[LEGS6[i] + 2] += side * 0.06 * Math.sin(t * 2 + i) * id;
        }
        p[J.head] = 0.05 + 0.08 * a * id;
        p[J.head + 1] = 0.3 * Math.sin(t * 1.9 + ent.phase) * id;
        p[J.antL] = 0.25 * Math.sin(t * 5 + ent.phase) - 0.3 * run;
        p[J.antR] = 0.25 * Math.sin(t * 5.6 + ent.phase + 1) - 0.3 * run;
        p[J.antL + 1] = 0.2 * Math.sin(t * 3.3);
        p[J.antR + 1] = -0.2 * Math.sin(t * 3.7);
        // 腹囊随步子晃
        p[J.sac + 2] = -0.1 * Math.sin(w - 0.6) * run;
        p[J.sac] = -0.06 * Math.cos(2 * w) * run;
      };
      rig.post = function (ent, o, t) {
        // 腹囊搏动：越接近引爆跳得越快越亮（swell 由蓄力动作写在 ent 上）
        const sw = ent.swell || 0, J = rig.J;
        const pulse = 0.5 + 0.5 * Math.sin(t * (9 + sw * 16));
        const k = 1 + pulse * (0.06 + 0.08 * sw);
        o[J.sac + 6] *= k;
        o[J.sac + 7] *= k;
        o[J.sac + 8] *= k;
        setGlow(ent, 0.7 + pulse * 0.45 + sw * 0.9);
        if (!ent.clip) ent.swell = 0;
      };
      // 蓄力：踮起脚，腹囊越胀越大
      defClip(rig, 'windup', {
        dur: 0.7, hold: true, fade: 0.08,
        keys: {
          'root.oy': [0, 0, 0.5, 0.16, 1, 0.2], 'root.rx': [0, 0.1, 1, 0.28],
          'sac.s': [0, 1, 0.6, 1.3, 1, 1.5], 'ribs.sx': [0, 1, 1, 1.22], 'ribs.sy': [0, 1, 1, 1.12],
          'head.rx': [0, 0.05, 1, 0.5],
          'antL.rx': [0, 0, 1, -0.6], 'antR.rx': [0, 0, 1, -0.6],
          'legL0.rz': [0, 0, 1, -0.3], 'legR0.rz': [0, 0, 1, 0.3], 'legL1.rz': [0, 0, 1, -0.32], 'legR1.rz': [0, 0, 1, 0.32], 'legL2.rz': [0, 0, 1, -0.3], 'legR2.rz': [0, 0, 1, 0.3],
        },
        fn(ent, p, k) {
          ent.swell = k;
          // 快炸了：浑身发抖
          const J = rig.J, sh = k * k * 0.03;
          p[J.root + 3] = Math.sin(k * 90) * sh;
          p[J.root + 5] = Math.cos(k * 77) * sh;
        },
      });
      // 引爆：腹囊猛地撑到最大（随后由调用方移除）
      defClip(rig, 'attack', {
        dur: 0.22, hold: true, fade: 0.02,
        keys: {
          'root.oy': [0, 0.2, 1, 0.3],
          'sac.s': [0, 1.5, -0.6, 2.3, 1, 2.5], 'ribs.sx': [0, 1.22, 1, 1.9], 'ribs.sy': [0, 1.12, 1, 1.5],
          'head.rx': [0, 0.5, 1, 0.8],
          'legL0.rz': [0, -0.3, 1, 0.5], 'legR0.rz': [0, 0.3, 1, -0.5], 'legL1.rz': [0, -0.32, 1, 0.5], 'legR1.rz': [0, 0.32, 1, -0.5], 'legL2.rz': [0, -0.3, 1, 0.5], 'legR2.rz': [0, 0.3, 1, -0.5],
        },
        fn(ent) {
          ent.swell = 1.4;
        },
      });
      // 失衡：四脚朝天，腿乱蹬
      defClip(rig, 'stagger', {
        dur: 0.9, loop: true, fade: 0.14, out: 0.25,
        keys: { 'root.rz': [0, 2.75, 1, 2.75], 'root.oy': [0, 0.42, 1, 0.42], 'sac.s': [0, 0.92, 1, 0.92] },
        fn(ent, p, k) {
          const J = rig.J, a = k * TAU;
          p[J.root] = 0.15 * Math.sin(a);
          for (let i = 0; i < 6; i++) {
            const side = i & 1 ? -1 : 1;
            p[LEGS6[i] + 2] = side * (-0.3 + 0.45 * Math.sin(a * 3 + i * 1.7));
            p[LEGS6[i] + 1] = 0.3 * Math.sin(a * 2 + i);
          }
          p[J.head + 1] = 0.4 * Math.sin(a * 2);
          p[J.antL] = 0.5 * Math.sin(a * 3);
          p[J.antR] = 0.5 * Math.cos(a * 3);
        },
      });
      // 死亡：腹囊漏气瘪掉，腿蜷起来
      defClip(rig, 'death', {
        dur: 0.5, base: 'rest', hold: true, fade: 0.04,
        keys: {
          'root.oy': [0, 0.15, 0.3, 0.25, -0.8, -0.2, 1, -0.2], 'root.rz': [0, 0, 1, 0.5], 'root.rx': [0, -0.3, 1, 0.1],
          'sac.s': [0, 1.25, 0.25, 1.35, 0.8, 0.35, 1, 0.3], 'ribs.sy': [0, 1.05, 1, 0.7],
          'head.rx': [0, -0.4, 1, 0.6],
          'legL0.rz': [0, 0.5, 1, -0.9], 'legR0.rz': [0, -0.5, 1, 0.9], 'legL1.rz': [0, 0.5, 1, -1.0], 'legR1.rz': [0, -0.5, 1, 1.0], 'legL2.rz': [0, 0.5, 1, -0.9], 'legR2.rz': [0, -0.5, 1, 0.9],
          'antL.rx': [0, -0.5, 1, 0.9], 'antR.rx': [0, -0.5, 1, 0.9],
        },
      });
      return rig;
    });
  }

  const MOB_RIG = { husk: huskRig, brute: bruteRig, spitter: spitterRig, bomber: bomberRig };

  W.makeMob = function (type, elemHex, elite) {
    const eh = hexOf(elemHex);
    // 躯体染一层和地面相反的冷暖色：火焰区地面偏暖 → 怪偏冷灰；其余区域地面偏冷 → 怪偏暖
    _c.set(eh);
    const warmGround = _c.r > 0.8 && _c.g < 0.6;
    const ent = newEnt(type, MOB_RIG[type](), warmGround ? 0xc3cbe6 : 0xf6dfc4, eh, 1.1);
    if (warmGround) ent.uRim.value.setRGB(0.1, 0.13, 0.2);
    else ent.uRim.value.setRGB(0.2, 0.15, 0.1);
    if (elite) {
      // 精英：更大、发光更强，轮廓上镀一圈金
      ent.k = 1.35;
      ent.body.scale.setScalar(1.35);
      ent.glowK = 1.35;
      setGlow(ent, 1);
      ent.uRim.value.setRGB(0.5, 0.36, 0.12);
      ent.ring = groundDisc(ent, dashRingTex(), mixHex(eh, 0xffe9b0, 0.45), G.MOBS[type].r * 1.35 + 0.75, 0.85);
    }
    return ent;
  };

  // =====================================================================
  // 首领
  // =====================================================================
  // 首领身上不断飘出的元素火星
  function bossEmbers(ent, dt, y, spread, rate) {
    ent.emb += dt * rate;
    while (ent.emb > 1) {
      ent.emb -= 1;
      const g = ent.group.position, c = ent.elemC;
      spawnP(g.x + rand(-spread, spread), y + rand(-0.6, 0.6), g.z + rand(-spread, spread), rand(-0.5, 0.5), rand(0.8, 2.2), rand(-0.5, 0.5), rand(0.6, 1.2), rand(0.12, 0.24), c.r, c.g, c.b, -0.6, 0.6);
    }
  }
  // 八种招式都能按名字播放：每个首领把它们归到自己的几组动作上（蓄力是「招式名_w」）
  const BOSS_PATTERNS = ['slam', 'charge', 'ring', 'fan', 'barrage', 'summon', 'spiral', 'cross'];
  function bossAliases(rig, map) {
    for (const pat of BOSS_PATTERNS) {
      aliasClip(rig, pat, map[pat]);
      aliasClip(rig, pat + '_w', map[pat] + '_w');
    }
    aliasClip(rig, 'stagger', 'broken');
  }

  // ---------------------------------------------------------------------
  // 熔渣巨像：玄武岩板拼成的躯干，胸口的炉栅后面烧着熔核；右臂是一整块锤石，左手三根石指
  // ---------------------------------------------------------------------
  function golemRig() {
    return rigOf('golem', () => {
      const ROCK = 0x8a8894, ROCK_D = 0x4b4954, SLAG = 0xa59a96, IRON = 0x3a3840, DARK = 0x26242b;
      const b = rigBuilder('golem', NB_BIG);
      b.j('root', null, 0, 1.75, 0).j('chest', 'root', 0, 2.15, 0).j('head', 'chest', 0, 3.7, 0.35).j('core', 'chest', 0, 2.75, 0.3);
      b.j('uaL', 'chest', 1.75, 3.4, 0).j('faL', 'uaL', 2.1, 2.35, 0.1).j('uaR', 'chest', -1.75, 3.4, 0).j('faR', 'uaR', -2.1, 2.35, 0.1);
      b.j('thL', 'root', 0.72, 1.6, 0).j('shL', 'thL', 0.8, 0.9, 0.06).j('ftL', 'shL', 0.8, 0.28, 0.04);
      b.j('thR', 'root', -0.72, 1.6, 0).j('shR', 'thR', -0.8, 0.9, 0.06).j('ftR', 'shR', -0.8, 0.28, 0.04);

      // 胯：一整块暗色基座，腰间一圈熔光
      b.at('root').surf(SURF.stone, true);
      b.p(gRBox(1.9, 0.7, 1.25, 0.1), [DARK, ROCK_D], 0, 1.7, 0);
      b.p(gRBox(0.7, 0.75, 0.3, 0.06), ROCK, 0, 1.55, 0.66, -0.1);
      b.g(gBox(1.7, 0.1, 1.3), 0.9, 0, 2.06, 0);
      // 躯干：左右两大块胸板夹着炉膛，背后三层板，肩上压着巨岩和烟囱
      b.at('chest');
      for (const s of [1, -1]) {
        b.p(gRBox(1.0, 1.55, 1.5, 0.12), [ROCK_D, ROCK], s * 0.86, 2.8, 0, 0, 0, -s * 0.1);
        b.p(gRBox(0.5, 0.5, 0.2, 0.05), SLAG, s * 0.9, 3.2, 0.8, -0.12, 0, -s * 0.1);
        b.p(gRBox(0.42, 0.42, 0.2, 0.05), ROCK, s * 0.92, 2.55, 0.8, 0.06, 0, -s * 0.1);
        b.p(gIco(0.92, 0), [ROCK_D, ROCK], s * 1.7, 3.62, 0, 0.3, s * 0.4, 0, 1.05, 0.85, 1.1);
        b.p(gCone(0.3, 1.0, 5), ROCK_D, s * 2.05, 4.32, -0.1, 0, 0, -s * 0.4).p(gCone(0.22, 0.7, 5), DARK, s * 1.5, 4.36, -0.4, -0.25, 0, -s * 0.1);
        b.surf(SURF.dark).p(gCyl(0.24, 0.3, 0.9, 7), IRON, s * 0.75, 4.05, -0.62, -0.18, 0, -s * 0.12).surf(SURF.stone, true);
        b.g(gCyl(0.19, 0.19, 0.1, 7), 1, s * 0.74, 4.5, -0.7, -0.18, 0, -s * 0.12);
        b.g(gBox(0.5, 0.1, 0.3), 0.9, s * 1.2, 3.28, 0.55);
        b.g(gBox(0.16, 0.14, 1.2), 0.8, s * 1.7, 4.12, 0.05, 0, s * 0.3, 0);
      }
      b.p(gRBox(2.5, 0.5, 1.6, 0.1), [ROCK, SLAG], 0, 3.62, 0, 0.06);
      b.p(gRBox(1.5, 1.6, 0.5, 0.1), ROCK_D, 0, 2.75, -0.62);
      b.p(gRBox(1.1, 0.5, 0.3, 0.08), ROCK, 0, 3.25, -0.92, 0.2).p(gRBox(0.9, 0.5, 0.3, 0.08), ROCK, 0, 2.65, -0.95, 0.1).p(gRBox(0.7, 0.45, 0.3, 0.08), ROCK, 0, 2.1, -0.9, -0.1);
      for (const y of [3.0, 2.4]) b.g(gBox(0.85, 0.12, 0.1), 0.9, 0, y, -0.9);
      for (const s of [1, -1]) b.g(gBox(0.13, 1.3, 0.1), 0.8, s * 0.66, 2.7, -0.84, 0, 0, s * 0.12);
      // 炉栅：四根铁条挡在熔核前面
      b.surf(SURF.dark);
      for (let i = -1.5; i <= 1.5; i++) b.p(gCyl(0.045, 0.045, 1.3, 5), IRON, i * 0.2, 2.75, 0.8);
      b.p(gRBox(0.95, 0.12, 0.14, 0.03), IRON, 0, 3.4, 0.8).p(gRBox(0.95, 0.12, 0.14, 0.03), IRON, 0, 2.12, 0.8);
      b.at('core').g(gIco(0.62, 1), 1, 0, 2.75, 0.3);
      // 头：一块带面甲的石板，缩在肩窝里
      b.at('head').surf(SURF.stone, true);
      b.p(gRBox(0.78, 0.66, 0.76, 0.08), [ROCK, SLAG], 0, 4.0, 0.35);
      b.p(gRBox(0.9, 0.24, 0.6, 0.06), ROCK_D, 0, 4.36, 0.26, -0.08);
      b.p(gRBox(0.5, 0.3, 0.2, 0.05), ROCK_D, 0, 3.72, 0.7, 0.2);
      b.g(gBox(0.52, 0.11, 0.08), 1, 0, 4.03, 0.74);
      // 左臂：石柱 + 三指巨手；右臂：一整块箍着铁带的锤石
      b.at('uaL').limb([ROCK_D, ROCK], 1.75, 3.4, 0, 2.1, 2.35, 0.1, 0.5, 0.42, 6, 0);
      b.at('uaR').limb([ROCK_D, ROCK], -1.75, 3.4, 0, -2.1, 2.35, 0.1, 0.5, 0.42, 6, 0);
      for (const s of [1, -1]) b.at(s > 0 ? 'faL' : 'faR').g(gCyl(0.4, 0.4, 0.16, 7), 1, s * 2.1, 2.32, 0.1, 0, 0, s * 0.3);
      b.at('faL').limb([ROCK, ROCK_D], 2.1, 2.3, 0.1, 2.22, 1.25, 0.3, 0.42, 0.5, 6, 0);
      b.p(gIco(0.6, 0), SLAG, 2.24, 1.05, 0.34, 0.3, 0.5, 0, 1, 0.8, 1);
      for (let k = -1; k <= 1; k++) b.p(gRBox(0.26, 0.75, 0.3, 0.06), [DARK, ROCK_D], 2.24 + k * 0.36, 0.55, 0.62 - Math.abs(k) * 0.12, 0.5, 0, -k * 0.2);
      b.at('faR').limb([ROCK, ROCK_D], -2.1, 2.3, 0.1, -2.2, 1.6, 0.22, 0.42, 0.46, 6, 0);
      b.p(gRBox(1.25, 1.35, 1.3, 0.14), [ROCK_D, SLAG], -2.24, 0.98, 0.34, 0.1, 0.25, 0);
      b.surf(SURF.dark).p(gRBox(1.36, 0.2, 1.4, 0.04), IRON, -2.24, 1.3, 0.34, 0.1, 0.25, 0).p(gRBox(1.36, 0.2, 1.4, 0.04), IRON, -2.24, 0.66, 0.34, 0.1, 0.25, 0);
      b.g(gBox(0.5, 0.5, 0.08), 0.9, -2.08, 0.98, 1.0, 0.1, 0.25, 0).g(gBox(1.0, 0.08, 1.0), 0.8, -2.24, 0.3, 0.34, 0.1, 0.25, 0);
      // 腿：石墩
      b.surf(SURF.stone, true);
      for (const s of [1, -1]) {
        const TH = s > 0 ? 'thL' : 'thR', SH = s > 0 ? 'shL' : 'shR', FT = s > 0 ? 'ftL' : 'ftR';
        b.at(TH).p(gRBox(0.8, 0.9, 0.9, 0.1), [ROCK_D, ROCK], s * 0.76, 1.3, 0.02);
        b.at(SH).p(gRBox(0.95, 0.8, 1.05, 0.1), [DARK, ROCK_D], s * 0.8, 0.62, 0.06).p(gRBox(0.5, 0.4, 0.2, 0.05), SLAG, s * 0.8, 0.95, 0.56, -0.2);
        b.g(gBox(0.7, 0.09, 0.9), 0.8, s * 0.8, 1.0, 0.04);
        b.at(FT).p(gRBox(1.05, 0.3, 1.4, 0.08), DARK, s * 0.8, 0.15, 0.18);
      }

      const rig = b.build({ height: 4.8, reach: 3.2, stride: 1.3, shade: 0.3 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.28;
      sock(rig, 'weapon', 'faR', -0.14, -1.9, 0.3);
      sock(rig, 'hand', 'faL', 0.14, -1.6, 0.4);
      sock(rig, 'head', 'head', 0, 0.4, 0);
      sock(rig, 'chest', 'core', 0, 0, 0.5);
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, s = Math.sin(ent.walk), c = Math.cos(ent.walk);
        const run = Math.min(1.2, ent.spd / 3.4) * mv, br = Math.sin(t * 1.1 + ent.phase);
        p[J.root + 2] = 0.07 * s * run;
        p[J.root + 1] = -0.12 * s * run;
        p[J.chest] = 0.06 + 0.06 * run + 0.02 * br;
        p[J.chest + 1] = 0.16 * s * run;
        p[J.head + 1] = 0.15 * Math.sin(t * 0.5 + ent.phase) * (1 - mv);
        p[J.head] = 0.03 * br;
        p[J.uaL] = -0.1 + 0.35 * s * run + 0.03 * br;
        p[J.uaR] = -0.05 - 0.3 * s * run + 0.03 * br;
        p[J.uaL + 2] = 0.1;
        p[J.uaR + 2] = -0.1;
        p[J.faL] = -0.2 - 0.1 * s * run;
        p[J.faR] = -0.12;
        p[J.thL] = p[J.thR] = -0.06;
        p[J.shL] = p[J.shR] = 0.12;
        legCycle(p, J.thL, J.shL, J.ftL, s, c, run, 0.42, 0.6);
        legCycle(p, J.thR, J.shR, J.ftR, -s, -c, run, 0.42, 0.6);
      };
      rig.post = function (ent, o, t, dt) {
        const J = rig.J, k = ent.coreK || 1;
        o[J.core + 1] = t * 0.7;
        o[J.core] = t * 0.4;
        const sc = (1 + Math.sin(t * 3) * 0.06) * k;
        o[J.core + 6] = o[J.core + 7] = o[J.core + 8] = sc;
        setGlow(ent, 0.85 + 0.15 * Math.sin(t * 3) + (k - 1) * 0.9);
        ent.coreK = 1 + (k - 1) * Math.max(0, 1 - dt * 5);
        if (!ent.dying) bossEmbers(ent, dt, 3.2, 0.9, 7);
      };
      const heat = (v) => (ent, p, k) => { ent.coreK = 1 + v * k; };
      // 砸地：锤石抡过头顶，夯下去
      defClip(rig, 'smash_w', {
        dur: 0.95, hold: true, fade: 0.12,
        keys: {
          'root.ry': [0, 0, 1, -0.2], 'chest.rx': [0, 0.06, 0.7, -0.3, 1, -0.36], 'chest.ry': [0, 0, 1, -0.35], 'head.rx': [0, 0, 1, -0.2],
          'uaR.rx': [0, -0.1, 0.35, -1.3, 0.8, -2.8, 1, -3.0], 'uaR.rz': [0, -0.1, 0.5, -0.5, 1, -0.2], 'faR.rx': [0, -0.1, 0.8, -0.6, 1, -0.5],
          'uaL.rx': [0, -0.1, 1, -1.1], 'uaL.rz': [0, 0.1, 1, 0.4], 'faL.rx': [0, -0.2, 1, -0.6],
          'thL.rx': [0, -0.06, 1, -0.4], 'shL.rx': [0, 0.12, 1, 0.5], 'thR.rx': [0, -0.06, 1, 0.15], 'shR.rx': [0, 0.12, 1, 0.3],
        },
      });
      defClip(rig, 'smash', {
        dur: 0.6, k0: 0.2, fade: 0.03, out: 0.35,
        keys: {
          'root.ry': [0, -0.2, -0.2, 0.15, 1, 0], 'root.rx': [0, 0, -0.2, 0.22, 0.7, 0.2, 1, 0],
          'chest.rx': [0, -0.36, -0.2, 0.6, 0.7, 0.55, 1, 0.08], 'chest.ry': [0, -0.35, -0.2, 0.3, 0.7, 0.25, 1, 0], 'head.rx': [0, -0.2, -0.2, -0.4, 1, 0],
          'uaR.rx': [0, -3.0, -0.2, -0.8, 0.7, -0.75, 1, -0.05], 'uaR.rz': [0, -0.2, -0.2, 0.25, 0.7, 0.2, 1, -0.1], 'faR.rx': [0, -0.5, -0.2, -0.05, 1, -0.12],
          'uaL.rx': [0, -1.1, -0.2, 0.6, 1, -0.1], 'uaL.rz': [0, 0.4, -0.2, 0.6, 1, 0.1], 'faL.rx': [0, -0.6, -0.2, -0.3, 1, -0.2],
          'thL.rx': [0, -0.4, -0.2, -1.0, 0.7, -0.95, 1, -0.06], 'shL.rx': [0, 0.5, -0.2, 1.1, 0.7, 1.05, 1, 0.12],
          'thR.rx': [0, 0.15, -0.2, -0.3, 0.7, -0.3, 1, -0.06], 'shR.rx': [0, 0.3, -0.2, 1.0, 0.7, 0.95, 1, 0.12],
        },
      });
      // 冲锋：压低重心，左肩顶在前面
      defClip(rig, 'rush_w', {
        dur: 0.75, hold: true, fade: 0.12,
        keys: {
          'root.rx': [0, 0, 1, 0.3], 'root.oz': [0, 0, 1, -0.3], 'chest.rx': [0, 0.06, 1, 0.35], 'chest.ry': [0, 0, 1, -0.45], 'head.rx': [0, 0, 1, -0.5],
          'uaL.rx': [0, -0.1, 1, -0.9], 'uaL.rz': [0, 0.1, 1, -0.3], 'faL.rx': [0, -0.2, 1, -1.2],
          'uaR.rx': [0, -0.05, 1, 0.7], 'uaR.rz': [0, -0.1, 1, -0.3], 'faR.rx': [0, -0.1, 1, -0.3],
          'thL.rx': [0, -0.06, 1, -0.9], 'shL.rx': [0, 0.12, 1, 1.1], 'thR.rx': [0, -0.06, 1, 0.3], 'shR.rx': [0, 0.12, 1, 0.5],
        },
      });
      defClip(rig, 'rush', {
        dur: 0.55, k0: 0.3, fade: 0.04, out: 0.3,
        keys: {
          'root.rx': [0, 0.3, 0.3, 0.5, 0.6, 0.2, 1, 0], 'root.oz': [0, -0.3, -0.2, 0.3, 1, 0], 'chest.rx': [0, 0.35, 0.3, 0.45, 0.7, 0, 1, 0.06], 'chest.ry': [0, -0.45, 0.6, -0.5, 1, 0], 'head.rx': [0, -0.5, 1, 0],
          'uaL.rx': [0, -0.9, 0.6, -0.8, 1, -0.1], 'uaL.rz': [0, -0.3, 1, 0.1], 'faL.rx': [0, -1.2, 0.6, -1.1, 1, -0.2],
          'uaR.rx': [0, 0.7, 0.3, 1.1, 1, -0.05], 'uaR.rz': [0, -0.3, 1, -0.1], 'faR.rx': [0, -0.3, 1, -0.12],
          'thL.rx': [0, -0.9, 0.3, -0.3, 0.6, -0.8, 1, -0.06], 'shL.rx': [0, 1.1, 0.3, 0.3, 0.6, 0.9, 1, 0.12],
          'thR.rx': [0, 0.3, 0.3, -0.8, 0.6, 0.2, 1, -0.06], 'shR.rx': [0, 0.5, 0.3, 1.0, 0.6, 0.4, 1, 0.12],
        },
      });
      // 弹幕：双臂护住炉膛蓄热，然后猛地敞开
      defClip(rig, 'burst_w', {
        dur: 0.45, hold: true, fade: 0.1,
        keys: {
          'chest.rx': [0, 0.06, 1, 0.38], 'head.rx': [0, 0, 1, 0.3],
          'uaL.rx': [0, -0.1, 1, -0.9], 'uaL.rz': [0, 0.1, 1, -0.5], 'faL.rx': [0, -0.2, 1, -1.3],
          'uaR.rx': [0, -0.05, 1, -0.8], 'uaR.rz': [0, -0.1, 1, 0.45], 'faR.rx': [0, -0.1, 1, -1.0],
          'thL.rx': [0, -0.06, 1, -0.5], 'shL.rx': [0, 0.12, 1, 0.8], 'thR.rx': [0, -0.06, 1, -0.4], 'shR.rx': [0, 0.12, 1, 0.8],
        },
        fn: heat(0.7),
      });
      defClip(rig, 'burst', {
        dur: 0.6, k0: 0.2, fade: 0.03, out: 0.35,
        keys: {
          'chest.rx': [0, 0.38, -0.2, -0.4, 0.6, -0.3, 1, 0.06], 'head.rx': [0, 0.3, -0.2, -0.45, 1, 0],
          'uaL.rx': [0, -0.9, -0.2, 0.3, 0.6, 0.2, 1, -0.1], 'uaL.rz': [0, -0.5, -0.2, 1.25, 0.6, 1.1, 1, 0.1], 'faL.rx': [0, -1.3, -0.2, -0.2, 1, -0.2],
          'uaR.rx': [0, -0.8, -0.2, 0.3, 0.6, 0.2, 1, -0.05], 'uaR.rz': [0, 0.45, -0.2, -1.2, 0.6, -1.05, 1, -0.1], 'faR.rx': [0, -1.0, -0.2, -0.15, 1, -0.12],
          'thL.rx': [0, -0.5, -0.2, -0.2, 1, -0.06], 'shL.rx': [0, 0.8, -0.2, 0.3, 1, 0.12], 'thR.rx': [0, -0.4, -0.2, -0.1, 1, -0.06], 'shR.rx': [0, 0.8, -0.2, 0.3, 1, 0.12],
          'thL.rz': [0, 0, -0.2, 0.2, 1, 0], 'thR.rz': [0, 0, -0.2, -0.2, 1, 0],
        },
        fn(ent, p, k) { if (k < 0.3) ent.coreK = 1.9; },
      });
      aliasClip(rig, 'hurl', 'burst'); aliasClip(rig, 'hurl_w', 'burst_w'); aliasClip(rig, 'call', 'smash'); aliasClip(rig, 'call_w', 'smash_w');
      // 破防：单膝跪地，锤石杵在地上，炉火明灭
      defClip(rig, 'broken', {
        dur: 2.0, loop: true, fade: 0.25, out: 0.45,
        keys: {
          'thL.rx': [0, -1.35, 1, -1.35], 'shL.rx': [0, 1.45, 1, 1.45], 'thR.rx': [0, 0.15, 1, 0.15], 'shR.rx': [0, 1.45, 1, 1.45], 'ftR.rx': [0, 0.5, 1, 0.5],
          'uaR.rx': [0, -0.7, 1, -0.7], 'faR.rx': [0, 0, 1, 0], 'uaL.rz': [0, 0.3, 1, 0.3], 'faL.rx': [0, -0.4, 1, -0.4],
        },
        fn(ent, p, k) {
          const J = rig.J, s = Math.sin(k * TAU), s2 = Math.sin(k * TAU * 2);
          p[J.root] = 0.18;
          p[J.root + 2] = 0.04 * s;
          p[J.chest] = 0.42 + 0.05 * s2;
          p[J.chest + 2] = 0.06 * s;
          p[J.head] = 0.4 + 0.06 * s2;
          p[J.head + 2] = 0.18 * s;
          p[J.uaL] = 0.15 + 0.08 * s;
          ent.coreK = 0.7 + 0.25 * Math.max(0, Math.sin(k * TAU * 5));
        },
      });
      // 死亡：炉火暴涨，双膝砸地，整个垮下来
      defClip(rig, 'death', {
        dur: 1.5, base: 'rest', hold: true, air: true, fade: 0.1,
        keys: {
          'root.rx': [0, -0.12, 0.3, -0.2, 0.55, 0.1, -0.88, 1.3, 1, 1.26],
          'root.oy': [0, 0, 0.3, -0.05, -0.55, -0.85, 0.7, -0.85, -0.88, -1.15, 1, -1.15],
          'root.oz': [0, -0.1, 0.55, 0, 0.88, 0.9, 1, 0.9], 'root.rz': [0, 0, 0.3, 0.08, 0.55, -0.06, 1, 0.06],
          'chest.rx': [0, -0.3, 0.3, -0.4, 0.55, 0.3, 0.88, 0.25, 1, 0.2], 'chest.rz': [0, 0, 0.3, -0.1, 0.55, 0.1, 1, 0],
          'head.rx': [0, -0.4, 0.3, -0.5, 0.55, 0.5, 0.88, -0.2, 1, -0.1], 'head.rz': [0, 0, 1, 0.3],
          'uaL.rx': [0, -0.5, 0.3, -1.2, 0.55, -0.3, 0.88, -2.3, 1, -2.4], 'uaL.rz': [0, 0.4, 0.3, 1.0, 0.55, 0.4, 1, 0.5], 'faL.rx': [0, -0.4, 1, -0.2],
          'uaR.rx': [0, -0.3, 0.3, -0.8, 0.55, 0, 0.88, -1.6, 1, -1.7], 'uaR.rz': [0, -0.4, 0.3, -0.9, 0.55, -0.2, 1, -0.7], 'faR.rx': [0, -0.2, 1, -0.3],
          'thL.rx': [0, 0, 0.3, 0.1, 0.55, -0.3, 0.88, 0, 1, 0], 'shL.rx': [0, 0.1, 0.3, 0.2, 0.55, 1.75, 0.88, 0.5, 1, 0.4],
          'thR.rx': [0, 0, 0.3, -0.2, 0.55, -0.2, 0.88, -0.2, 1, -0.2], 'shR.rx': [0, 0.1, 0.3, 0.4, 0.55, 1.7, 0.88, 0.8, 1, 0.7],
        },
        fn(ent, p, k) { ent.coreK = k < 0.5 ? 1 + k * 2 : Math.max(0.15, 2 - (k - 0.5) * 4); },
      });
      bossAliases(rig, { slam: 'smash', charge: 'rush', ring: 'burst', spiral: 'burst', fan: 'hurl', barrage: 'call', summon: 'call', cross: 'call' });
      return rig;
    });
  }

  // ---------------------------------------------------------------------
  // 霜织者：蛛腹上长出一截纤细的人形上身，六条长腿撑着悬空的身子，冰冠，垂到地面的霜纱
  // ---------------------------------------------------------------------
  function weaverRig() {
    return rigOf('weaver', () => {
      const CHIT = 0xcfdde8, CHIT_D = 0x7f94a6, ROBE = 0x2c3a4c, ROBE_L = 0x47596e, ROBE_IN = 0x141b24, DARK = 0x161c26, SILK = 0xe9f1f6;
      const b = rigBuilder('weaver', NB_BIG);
      b.j('root', null, 0, 2.2, 0).j('abd', 'root', 0, 2.2, -0.35).j('torso', 'root', 0, 2.55, 0.2).j('head', 'torso', 0, 3.6, 0.3);
      b.j('uaL', 'torso', 0.48, 3.25, 0.28).j('faL', 'uaL', 0.78, 2.62, 0.42).j('uaR', 'torso', -0.48, 3.25, 0.28).j('faR', 'uaR', -0.78, 2.62, 0.42);
      b.j('veil', 'root', 0, 2.3, 0.45).j('veil2', 'veil', 0, 1.3, 0.6).j('orbit', 'root', 0, 2.0, 0);
      const LEG = [];
      [[0.55, 0.9], [0.1, 0], [-0.4, -0.9]].forEach((d, i) => {
        for (const s of [1, -1]) {
          const n = (s > 0 ? 'L' : 'R') + i;
          const hip = [s * 0.55, 2.3, d[0]], knee = [s * 1.75, 3.35, d[0] + d[1] * 0.75], foot = [s * 2.6, 0.02, d[0] + d[1] * 1.6];
          b.j('hip' + n, 'root', hip[0], hip[1], hip[2]).j('knee' + n, 'hip' + n, knee[0], knee[1], knee[2]);
          LEG.push({ n, s, hip, knee, foot });
        }
      });

      // 蛛腹：水滴形，背上一列霜纹
      b.at('abd').surf(SURF.chitin);
      b.p(gSph(0.95, 12, 9), [DARK, ROBE_L], 0, 2.25, -0.95, 0.25, 0, 0, 0.95, 0.85, 1.35);
      b.p(gCone(0.3, 0.8, 6), DARK, 0, 2.0, -2.25, -HALF_PI - 0.3);
      for (let i = 0; i < 4; i++) {
        const z = -0.35 - i * 0.42, w = 0.5 - Math.abs(i - 1.2) * 0.12;
        b.g(gPlate('wv/chev' + i, [[-w, 0], [0, 0.22], [w, 0], [w, -0.1], [0, 0.1], [-w, -0.1]], 0.04, 0), 0.9, 0, 3.02 - i * 0.07 - (i > 2 ? 0.15 : 0), z, -HALF_PI + 0.1 + i * 0.12);
      }
      // 胸节：连着腿的硬壳
      b.at('root').surf(SURF.chitin);
      b.p(gSph(0.62, 10, 7), [ROBE, CHIT_D], 0, 2.3, 0.05, 0, 0, 0, 1.05, 0.7, 1.15);
      for (const l of LEG) b.p(gSph(0.17, 7, 5), CHIT_D, l.hip[0], l.hip[1], l.hip[2]);
      // 霜纱：从腰前垂到地面的两截长纱
      b.at('veil').surf(SURF.cloth);
      b.pd(gPlate('wv/veil1', [[-0.45, 0], [0.45, 0], [0.34, -1.05], [-0.34, -1.05]], 0.02, 0.004), [ROBE_L, SILK], ROBE_IN, 0, 2.35, 0.62, -0.14);
      b.g(gPlate('wv/rune', [[0, 0.2], [0.12, 0], [0, -0.2], [-0.12, 0]], 0.02, 0), 0.9, 0, 1.85, 0.72, -0.14);
      b.at('veil2').pd(gPlate('wv/veil2', [[-0.34, 0.04], [0.34, 0.04], [0.26, -0.7], [0.1, -1.0], [-0.02, -0.75], [-0.2, -0.95]], 0.02, 0.004), [ROBE, ROBE_L], ROBE_IN, 0, 1.3, 0.77, -0.14);

      // 上身：束腰的细长躯干，肩上搭着蛛丝披肩
      b.at('torso').surf(SURF.chitin);
      b.p(gLathe('wv/torso', [[0.42, 2.45], [0.26, 2.75], [0.3, 3.05], [0.42, 3.3], [0.2, 3.5], [0.12, 3.62]], 10), [CHIT_D, CHIT], 0, 0, 0.24, 0.06, 0, 0, 1, 1, 0.72);
      b.g(gCyl(0.275, 0.275, 0.06, 8), 0.9, 0, 2.78, 0.26, 0.06, 0, 0, 1, 1, 0.75);
      b.surf(SURF.cloth).pd(gDrape('wv/shawl', [[0.62, 2.85], [0.6, 3.1], [0.46, 3.36], [0.2, 3.52]], 3.6, 9), [ROBE, ROBE_L], ROBE_IN, 0, 0, 0.26);
      b.surf(SURF.chitin, true);
      for (const s of [1, -1]) b.p(gCone(0.14, 0.5, 5), CHIT, s * 0.55, 3.48, 0.2, 0, 0, -s * 0.9);
      // 头：细长的面具，六只眼，冰冠
      b.at('head').surf(SURF.chitin);
      b.p(gSph(0.3, 10, 8), [CHIT_D, CHIT], 0, 3.82, 0.32, 0, 0, 0, 0.82, 1.25, 0.95);
      b.p(gCone(0.14, 0.4, 6), CHIT_D, 0, 3.42, 0.42, Math.PI);
      b.surf(SURF.cloth).pd(gDrape('wv/hair', [[0.4, 3.2], [0.34, 3.6], [0.27, 3.95]], 2.6, 7), [ROBE, DARK], ROBE_IN, 0, 0, 0.3);
      for (const s of [1, -1]) {
        b.g(gSph(0.045, 6, 4), 1, s * 0.1, 3.9, 0.59, 0, 0, s * 0.4, 1.4, 0.7, 1).g(gSph(0.035, 6, 4), 1, s * 0.17, 3.78, 0.54).g(gSph(0.03, 6, 4), 1, s * 0.07, 3.74, 0.6);
      }
      for (let k = 0; k < 7; k++) {
        const a = ((k - 3) / 3) * 1.9, h = 0.85 - Math.abs(k - 3) * 0.13;
        b.g(gCone(0.075, h, 4), 1, Math.sin(a) * 0.26, 4.12 + h * 0.4, 0.26 - Math.cos(a) * 0.2 + 0.2, -0.25 * Math.cos(a), 0, -a * 0.35);
      }
      // 手臂：细长，三根长指，掌心托着一点霜光
      for (const s of [1, -1]) {
        const U = s > 0 ? 'uaL' : 'uaR', F = s > 0 ? 'faL' : 'faR';
        b.at(U).surf(SURF.chitin).limb([CHIT_D, CHIT], s * 0.48, 3.25, 0.28, s * 0.78, 2.62, 0.42, 0.1, 0.075, 6, 3);
        b.at(F).limb([CHIT, CHIT_D], s * 0.78, 2.62, 0.42, s * 0.82, 1.95, 0.7, 0.075, 0.06, 6, 2);
        for (let k = -1; k <= 1; k++) b.p(gSweep('wv/fing' + s + k, [[s * 0.82 + k * 0.05, 1.95, 0.7], [s * 0.84 + k * 0.1, 1.72, 0.84], [s * 0.82 + k * 0.12, 1.5, 0.82]], [0.035, 0.028, 0.005], 4), CHIT, 0, 0, 0);
        b.g(gSph(0.13, 7, 5), 1, s * 0.82, 1.78, 0.86);
      }
      // 腿：先扬到膝，再长长地刺向地面
      for (const l of LEG) {
        b.at('hip' + l.n).surf(SURF.chitin).limb([CHIT_D, CHIT], l.hip[0], l.hip[1], l.hip[2], l.knee[0], l.knee[1], l.knee[2], 0.14, 0.1, 6, 2);
        b.surf(SURF.chitin, true).p(gCone(0.1, 0.42, 4), CHIT, l.knee[0] + l.s * 0.08, l.knee[1] + 0.2, l.knee[2], 0, 0, -l.s * 0.5);
        b.at('knee' + l.n).surf(SURF.chitin).limb([DARK, ROBE_L], l.knee[0], l.knee[1], l.knee[2], l.foot[0], l.foot[1], l.foot[2], 0.1, 0.025, 6, 0);
        b.g(gCyl(0.07, 0.085, 0.14, 5), 0.8, (l.knee[0] + l.foot[0]) / 2, (l.knee[1] + l.foot[1]) / 2, (l.knee[2] + l.foot[2]) / 2);
      }
      // 环绕的冰晶
      b.at('orbit').surf(SURF.ice, true);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU;
        b.g(gOct(0.3), 1, Math.sin(a) * 2.5, 2.0 + (k % 2) * 0.5, Math.cos(a) * 2.5, 0.2, a, 0, 0.6, 1.8, 0.6);
      }

      const rig = b.build({ height: 4.7, reach: 3.2, stride: 2.2, shade: 0.15 });
      rig.hitJ = [rig.J.head, rig.J.torso];
      sock(rig, 'weapon', 'faR', -0.04, -0.84, 0.44);
      sock(rig, 'hand', 'faL', 0.04, -0.84, 0.44);
      sock(rig, 'head', 'head', 0, 0.3, 0);
      sock(rig, 'chest', 'torso', 0, 0.5, 0.3);
      const HIPS = LEG.map((l) => rig.J['hip' + l.n]), KNEES = LEG.map((l) => rig.J['knee' + l.n]);
      const PH = [0, Math.PI, Math.PI, 0, 0, Math.PI];
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, w = ent.walk, id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 3.8) * mv;
        const a = Math.sin(t * 1.6 + ent.phase), a2 = Math.sin(t * 2.3 + ent.phase);
        p[J.root + 4] = 0.12 * a + 0.06 * Math.cos(2 * w) * run;
        p[J.root] = 0.06 * run;
        p[J.root + 2] = 0.03 * Math.sin(w) * run;
        for (let i = 0; i < 6; i++) {
          crawlLeg(p, HIPS[i], KNEES[i], w + PH[i], LEG[i].s, run, 0.28, 0.2);
          // 身子上下浮动时腿尖留在原地
          p[HIPS[i] + 2] += LEG[i].s * (0.05 * a + 0.03 * Math.sin(t * 1.1 + i * 1.3) * id);
          p[KNEES[i] + 2] -= LEG[i].s * 0.04 * a;
        }
        p[J.abd] = 0.05 * a2;
        p[J.abd + 1] = 0.08 * Math.sin(t * 0.9 + ent.phase) + 0.1 * Math.sin(w) * run;
        p[J.torso] = 0.04 * a + 0.1 * run;
        p[J.torso + 1] = 0.1 * Math.sin(t * 0.7 + ent.phase) * id;
        p[J.head] = -0.05 - 0.04 * a;
        p[J.head + 2] = 0.08 * Math.sin(t * 0.9 + 1 + ent.phase);
        // 双手在胸前交替织线
        p[J.uaL] = -0.5 + 0.18 * a2;
        p[J.uaR] = -0.5 - 0.18 * a2;
        p[J.uaL + 2] = -0.1;
        p[J.uaR + 2] = 0.1;
        p[J.faL] = -0.7 + 0.25 * Math.sin(t * 2.3 + ent.phase + 1.2);
        p[J.faR] = -0.7 - 0.25 * Math.sin(t * 2.3 + ent.phase + 1.2);
        p[J.veil] = 0.05 + 0.25 * run + 0.05 * a2;
        p[J.veil2] = 0.1 + 0.3 * run + 0.1 * Math.sin(t * 2.3 + ent.phase - 1);
      };
      rig.post = function (ent, o, t) {
        const J = rig.J, k = ent.orbK || 1;
        o[J.orbit + 1] = t * 0.9;
        o[J.orbit + 6] = o[J.orbit + 8] = k;
        o[J.orbit + 4] += Math.sin(t * 2) * 0.2;
        ent.orbK = 1 + (k - 1) * 0.9;
        setGlow(ent, 0.9 + 0.12 * Math.sin(t * 2.6) + (k > 1 ? (k - 1) * 0.8 : 0));
      };
      // 扇形齐射：双手向后拉开丝线，甩出去
      defClip(rig, 'hurl_w', {
        dur: 0.4, hold: true, fade: 0.08,
        keys: {
          'torso.rx': [0, 0.04, 1, -0.28], 'head.rx': [0, -0.05, 1, -0.2],
          'uaL.rx': [0, -0.5, 1, 0.2], 'uaL.rz': [0, -0.1, 1, 1.0], 'faL.rx': [0, -0.7, 1, -1.5],
          'uaR.rx': [0, -0.5, 1, 0.2], 'uaR.rz': [0, 0.1, 1, -1.0], 'faR.rx': [0, -0.7, 1, -1.5],
          'veil.rx': [0, 0.05, 1, -0.2],
        },
      });
      defClip(rig, 'hurl', {
        dur: 0.36, k0: 0.3, fade: 0.03, out: 0.2,
        keys: {
          'torso.rx': [0, -0.28, -0.3, 0.35, 0.7, 0.25, 1, 0.04], 'head.rx': [0, -0.2, -0.3, 0.1, 1, -0.05],
          'uaL.rx': [0, 0.2, -0.3, -1.5, 0.7, -1.3, 1, -0.5], 'uaL.rz': [0, 1.0, -0.3, -0.25, 1, -0.1], 'faL.rx': [0, -1.5, -0.3, -0.1, 1, -0.7],
          'uaR.rx': [0, 0.2, -0.3, -1.5, 0.7, -1.3, 1, -0.5], 'uaR.rz': [0, -1.0, -0.3, 0.25, 1, 0.1], 'faR.rx': [0, -1.5, -0.3, -0.1, 1, -0.7],
          'veil.rx': [0, -0.2, -0.3, 0.5, 1, 0.05], 'veil2.rx': [0, 0.1, -0.36, 0.6, 1, 0.1],
        },
      });
      // 召唤 / 轰炸：双臂举向天空，前腿扬起，再一同落下
      defClip(rig, 'call_w', {
        dur: 0.4, hold: true, fade: 0.08,
        keys: {
          'root.rx': [0, 0, 1, -0.16], 'root.oy': [0, 0, 1, 0.25], 'torso.rx': [0, 0.04, 1, -0.3], 'head.rx': [0, -0.05, 1, -0.5],
          'uaL.rx': [0, -0.5, 1, -2.7], 'uaL.rz': [0, -0.1, 1, 0.45], 'faL.rx': [0, -0.7, 1, -0.25],
          'uaR.rx': [0, -0.5, 1, -2.7], 'uaR.rz': [0, 0.1, 1, -0.45], 'faR.rx': [0, -0.7, 1, -0.25],
          'hipL0.rz': [0, 0, 1, 0.5], 'hipR0.rz': [0, 0, 1, -0.5], 'kneeL0.rz': [0, 0, 1, 0.5], 'kneeR0.rz': [0, 0, 1, -0.5],
        },
      });
      defClip(rig, 'call', {
        dur: 0.7, k0: 0.25, fade: 0.04, out: 0.3,
        keys: {
          'root.rx': [0, -0.16, -0.25, 0.14, 0.7, 0.1, 1, 0], 'root.oy': [0, 0.25, -0.25, -0.3, 0.7, -0.2, 1, 0], 'torso.rx': [0, -0.3, -0.25, 0.4, 0.7, 0.3, 1, 0.04], 'head.rx': [0, -0.5, -0.25, 0.2, 1, -0.05],
          'uaL.rx': [0, -2.7, -0.25, -0.9, 0.7, -0.8, 1, -0.5], 'uaL.rz': [0, 0.45, -0.25, 0.5, 1, -0.1], 'faL.rx': [0, -0.25, -0.25, -0.1, 1, -0.7],
          'uaR.rx': [0, -2.7, -0.25, -0.9, 0.7, -0.8, 1, -0.5], 'uaR.rz': [0, -0.45, -0.25, -0.5, 1, 0.1], 'faR.rx': [0, -0.25, -0.25, -0.1, 1, -0.7],
          'hipL0.rz': [0, 0.5, -0.25, -0.12, 1, 0], 'hipR0.rz': [0, -0.5, -0.25, 0.12, 1, 0], 'kneeL0.rz': [0, 0.5, -0.25, 0, 1, 0], 'kneeR0.rz': [0, -0.5, -0.25, 0, 1, 0],
          'veil.rx': [0, 0, -0.25, 0.6, 1, 0.05],
        },
      });
      // 环形弹幕：蜷身收拢，再整个绽开
      defClip(rig, 'burst_w', {
        dur: 0.45, hold: true, fade: 0.08,
        keys: {
          'root.oy': [0, 0, 1, -0.35], 'torso.rx': [0, 0.04, 1, 0.5], 'head.rx': [0, -0.05, 1, 0.35],
          'uaL.rx': [0, -0.5, 1, -1.0], 'uaL.rz': [0, -0.1, 1, -0.6], 'faL.rx': [0, -0.7, 1, -1.7],
          'uaR.rx': [0, -0.5, 1, -1.0], 'uaR.rz': [0, 0.1, 1, 0.6], 'faR.rx': [0, -0.7, 1, -1.7],
        },
        fn(ent, p, k) { ent.orbK = 1 - 0.45 * k; },
      });
      defClip(rig, 'burst', {
        dur: 0.6, k0: 0.2, fade: 0.03, out: 0.3,
        keys: {
          'root.oy': [0, -0.35, -0.2, 0.3, 0.6, 0.2, 1, 0], 'torso.rx': [0, 0.5, -0.2, -0.35, 0.6, -0.25, 1, 0.04], 'head.rx': [0, 0.35, -0.2, -0.45, 1, -0.05],
          'uaL.rx': [0, -1.0, -0.2, -0.2, 0.6, -0.25, 1, -0.5], 'uaL.rz': [0, -0.6, -0.2, 1.5, 0.6, 1.35, 1, -0.1], 'faL.rx': [0, -1.7, -0.2, -0.1, 1, -0.7],
          'uaR.rx': [0, -1.0, -0.2, -0.2, 0.6, -0.25, 1, -0.5], 'uaR.rz': [0, 0.6, -0.2, -1.5, 0.6, -1.35, 1, 0.1], 'faR.rx': [0, -1.7, -0.2, -0.1, 1, -0.7],
          'veil.rx': [0, 0, -0.2, 0.7, 1, 0.05], 'veil2.rx': [0, 0.1, -0.26, 0.7, 1, 0.1],
        },
        fn(ent, p, k) { if (k > 0.15 && k < 0.4) ent.orbK = 1.7; },
      });
      aliasClip(rig, 'smash', 'call'); aliasClip(rig, 'smash_w', 'call_w'); aliasClip(rig, 'rush', 'burst'); aliasClip(rig, 'rush_w', 'burst_w');
      // 破防：身子塌到地上，腿朝四面瘫开，上身前伏
      defClip(rig, 'broken', {
        dur: 2.0, loop: true, fade: 0.25, out: 0.45,
        keys: { 'root.oy': [0, -1.35, 1, -1.35], 'uaL.rx': [0, -0.2, 1, -0.2], 'uaR.rx': [0, -0.1, 1, -0.1], 'faL.rx': [0, -0.2, 1, -0.2], 'faR.rx': [0, -0.3, 1, -0.3], 'veil.rx': [0, 0.9, 1, 0.9], 'veil2.rx': [0, 0.6, 1, 0.6] },
        fn(ent, p, k) {
          const J = rig.J, s = Math.sin(k * TAU), s2 = Math.sin(k * TAU * 2);
          for (let i = 0; i < 6; i++) {
            p[HIPS[i] + 2] = -LEG[i].s * (0.62 + 0.04 * Math.sin(k * TAU * 3 + i * 2));
            p[KNEES[i] + 2] = LEG[i].s * 0.75;
          }
          p[J.root + 2] = 0.06 * s;
          p[J.torso] = 0.75 + 0.06 * s2;
          p[J.torso + 2] = 0.12 * s;
          p[J.head] = 0.4 + 0.08 * s2;
          p[J.head + 2] = 0.3 * Math.sin(k * TAU + 0.8);
          p[J.abd] = -0.15 + 0.04 * s2;
          ent.orbK = 0.55;
        },
      });
      // 死亡：六条腿猛地蜷起，身子砸到地上，上身向后仰倒
      defClip(rig, 'death', {
        dur: 1.5, base: 'rest', hold: true, fade: 0.1,
        keys: {
          'root.oy': [0, 0.2, 0.25, 0.45, -0.6, -1.5, 1, -1.5], 'root.rz': [0, 0, 0.25, 0.1, 0.6, -0.12, 1, -0.1], 'root.rx': [0, -0.1, 0.25, -0.2, 0.6, 0, 1, -0.05],
          'torso.rx': [0, -0.4, 0.25, -0.55, 0.6, 0.3, -0.9, -1.2, 1, -1.15], 'head.rx': [0, -0.5, 0.25, -0.6, 0.6, 0.4, 0.9, -0.5, 1, -0.4], 'head.rz': [0, 0, 1, 0.4],
          'uaL.rx': [0, -1.5, 0.25, -2.4, 0.6, -0.8, 0.9, -2.2, 1, -2.3], 'uaL.rz': [0, 0.6, 0.25, 0.9, 1, 1.0], 'faL.rx': [0, -0.6, 1, -0.3],
          'uaR.rx': [0, -1.3, 0.25, -2.2, 0.6, -0.6, 0.9, -1.8, 1, -1.9], 'uaR.rz': [0, -0.6, 0.25, -0.9, 1, -1.2], 'faR.rx': [0, -0.6, 1, -0.5],
          'abd.rx': [0, 0, 0.6, -0.3, 1, -0.2], 'veil.rx': [0, 0, 0.6, 1.2, 1, 1.3], 'veil2.rx': [0, 0, 0.6, 0.8, 1, 0.4],
        },
        fn(ent, p, k) {
          const curl = ramp(k, 0.2, 0.75);
          for (let i = 0; i < 6; i++) {
            p[HIPS[i] + 2] = LEG[i].s * (0.35 * (1 - curl) * Math.sin(k * 30 + i) * 0.4 + 0.5 * curl);
            p[KNEES[i] + 2] = -LEG[i].s * 1.5 * curl;
          }
          ent.orbK = Math.max(0.01, 1 - k * 1.6);
        },
      });
      bossAliases(rig, { slam: 'smash', charge: 'rush', ring: 'burst', spiral: 'burst', fan: 'hurl', barrage: 'call', summon: 'call', cross: 'call' });
      return rig;
    });
  }

  // ---------------------------------------------------------------------
  // 雷霆监察者：悬浮的机关立柱，独眼，两道反向旋转的铜环，三块护盾板，一对离体的铁手
  // ---------------------------------------------------------------------
  function wardenRig() {
    return rigOf('warden', () => {
      const MET = 0x55536f, MET_D = 0x2a2940, BRASS = 0xc79a44, BRASS_D = 0x7a5c26, DARK = 0x191826;
      const b = rigBuilder('warden', NB_BIG);
      b.j('root', null, 0, 2.6, 0).j('head', 'root', 0, 3.75, 0).j('eye', 'head', 0, 4.02, 0.4).j('base', 'root', 0, 1.3, 0);
      b.j('ringA', 'root', 0, 2.75, 0).j('ringB', 'root', 0, 2.75, 0).j('orbit', 'root', 0, 1.7, 0);
      for (let k = 0; k < 3; k++) b.j('plate' + k, 'orbit', Math.sin((k / 3) * TAU) * 2.6, 1.7, Math.cos((k / 3) * TAU) * 2.6);
      b.j('handL', 'root', 1.9, 2.5, 0.7).j('handR', 'root', -1.9, 2.5, 0.7);

      // 立柱：收腰的机身，胸口一面带栅格的方匣，两肩立着线圈塔
      b.at('root').surf(SURF.metal);
      b.p(gLathe('wd/col', [[0.5, 1.5], [0.62, 1.9], [0.5, 2.3], [0.85, 2.5], [0.9, 3.3], [0.6, 3.55], [0.5, 3.75]], 10), [MET_D, MET], 0, 0, 0);
      b.surf(SURF.metal, true).p(gRBox(1.7, 1.0, 1.3, 0.1), [MET_D, MET], 0, 2.9, 0);
      b.surf(SURF.gold);
      b.p(gRBox(1.84, 0.16, 1.44, 0.04), BRASS, 0, 2.42, 0).p(gRBox(1.84, 0.16, 1.44, 0.04), BRASS, 0, 3.4, 0);
      b.p(gTorus(0.6, 0.06, 5, 14), BRASS, 0, 1.9, 0, HALF_PI).p(gTorus(0.5, 0.05, 5, 14), BRASS_D, 0, 2.3, 0, HALF_PI);
      b.g(gBox(1.0, 0.09, 0.06), 1, 0, 3.08, 0.67).g(gBox(1.0, 0.09, 0.06), 1, 0, 2.9, 0.67).g(gBox(1.0, 0.09, 0.06), 1, 0, 2.72, 0.67);
      b.g(gBox(0.9, 0.5, 0.06), 0.7, 0, 2.9, -0.67);
      for (const s of [1, -1]) {
        b.surf(SURF.dark).p(gCyl(0.22, 0.3, 1.7, 7), [DARK, MET_D], s * 1.22, 3.1, 0);
        b.surf(SURF.gold);
        for (let i = 0; i < 4; i++) b.p(gTorus(0.3 - i * 0.02, 0.05, 4, 10), BRASS, s * 1.22, 2.7 + i * 0.32, 0, HALF_PI);
        b.p(gCone(0.24, 0.5, 6), BRASS_D, s * 1.22, 4.2, 0);
        b.g(gOct(0.2), 1, s * 1.22, 4.62, 0, 0, 0, 0, 0.8, 1.4, 0.8);
      }
      // 头：铜环眼眶里嵌着一只独眼，上下两片眼睑
      b.at('head').surf(SURF.metal);
      b.p(gCyl(0.5, 0.6, 0.4, 8), MET, 0, 3.72, 0);
      b.p(gSph(0.56, 10, 8), [MET_D, MET], 0, 4.02, -0.02, 0, 0, 0, 1, 0.9, 0.9);
      b.surf(SURF.gold).p(gTorus(0.4, 0.09, 6, 16), BRASS, 0, 4.02, 0.36);
      b.surf(SURF.metal, true).p(gRBox(1.0, 0.16, 0.5, 0.04), MET_D, 0, 4.4, 0.24, 0.5).p(gRBox(0.8, 0.12, 0.4, 0.04), MET_D, 0, 3.66, 0.3, -0.5);
      b.surf(SURF.gold, true).p(gCone(0.12, 0.5, 4), BRASS, 0, 4.7, -0.1);
      b.at('eye').g(gOct(0.3), 1, 0, 4.02, 0.42, 0, 0, 0, 1, 1, 0.7);
      // 底座：倒锥 + 一圈导流片，底下喷着光
      b.at('base').surf(SURF.metal);
      b.p(gLathe('wd/base', [[0.08, 0.5], [0.5, 0.75], [1.05, 1.15], [1.15, 1.4], [0.6, 1.55]], 10), [DARK, MET_D], 0, 0, 0);
      b.surf(SURF.gold, true);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU;
        b.p(gPlate('wd/vane', [[0, 0], [0.5, 0.25], [0.5, 0.5], [0, 0.42]], 0.05, 0.015), BRASS, Math.sin(a) * 0.95, 0.9, Math.cos(a) * 0.95, 0, a - HALF_PI, 0);
      }
      b.g(gCyl(0.42, 0.1, 0.3, 8), 1, 0, 0.62, 0);
      // 两道铜环：各带三个节点
      const ring = (name, r, th) => {
        b.at(name).surf(SURF.gold).p(gTorus(r, th, 5, 28), [BRASS_D, BRASS], 0, 2.75, 0, HALF_PI);
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU;
          b.surf(SURF.metal, true).p(gRBox(0.34, 0.34, 0.34, 0.05), MET_D, Math.sin(a) * r, 2.75, Math.cos(a) * r, 0, a, 0);
          b.g(gOct(0.16), 1, Math.sin(a) * r, 3.04, Math.cos(a) * r);
        }
      };
      ring('ringA', 2.1, 0.075);
      ring('ringB', 1.72, 0.065);
      // 护盾板
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU, x = Math.sin(a) * 2.6, z = Math.cos(a) * 2.6;
        b.at('plate' + k).surf(SURF.metal, true);
        b.p(gPlate('wd/shield', [[-0.5, 0.75], [0.5, 0.75], [0.55, -0.3], [0, -0.85], [-0.55, -0.3]], 0.1, 0.04), [MET_D, MET], x, 1.7, z, 0, a, 0);
        b.surf(SURF.gold, true).p(gRBox(1.14, 0.12, 0.22, 0.03), BRASS, x, 2.3, z, 0, a, 0);
        b.g(gPlate('wd/srune', [[0, 0.4], [0.16, 0], [0, -0.4], [-0.16, 0]], 0.2, 0), 1, x, 1.72, z, 0, a, 0);
      }
      // 离体的铁手：掌心一只光眼，四根方指
      for (const s of [1, -1]) {
        const X = s * 1.9;
        b.at(s > 0 ? 'handL' : 'handR').surf(SURF.metal, true);
        b.p(gRBox(0.62, 0.7, 0.3, 0.07), [MET_D, MET], X, 2.5, 0.7);
        b.surf(SURF.gold, true).p(gRBox(0.7, 0.16, 0.36, 0.04), BRASS, X, 2.12, 0.7);
        b.surf(SURF.metal, true);
        for (let k = 0; k < 3; k++) b.p(gRBox(0.17, 0.5, 0.2, 0.04), MET, X + (k - 1) * 0.21, 3.02, 0.76, 0.25);
        b.p(gRBox(0.17, 0.4, 0.2, 0.04), MET, X - s * 0.42, 2.6, 0.78, 0.2, 0, s * 0.7);
        b.g(gOct(0.16), 1, X, 2.5, 0.88, 0, 0, 0, 1, 1, 0.5);
      }

      const rig = b.build({ height: 4.9, reach: 3.4, stride: 1, shade: 0 });
      rig.hitJ = [rig.J.head];
      sock(rig, 'weapon', 'handR', 0, 0, 0.3);
      sock(rig, 'hand', 'handL', 0, 0, 0.3);
      sock(rig, 'head', 'eye', 0, 0, 0.2);
      sock(rig, 'chest', 'root', 0, 0.3, 0.7);
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, a = Math.sin(t * 2 + ent.phase), a2 = Math.sin(t * 1.3 + ent.phase);
        p[J.root + 4] = 0.1 + 0.09 * a;
        p[J.root] = 0.14 * mv;
        p[J.head + 1] = 0.2 * Math.sin(t * 0.7 + ent.phase) * (1 - mv);
        p[J.handL + 4] = 0.12 * Math.sin(t * 2 + 1 + ent.phase);
        p[J.handR + 4] = 0.12 * Math.sin(t * 2 + 2.2 + ent.phase);
        p[J.handL + 2] = 0.12 + 0.05 * a2;
        p[J.handR + 2] = -0.12 - 0.05 * a2;
        p[J.handL] = -0.15 + 0.3 * mv;
        p[J.handR] = -0.15 + 0.3 * mv;
        p[J.handL + 5] = -0.4 * mv;
        p[J.handR + 5] = -0.4 * mv;
      };
      rig.post = function (ent, o, t, dt) {
        const J = rig.J, k = ent.spinK === undefined ? 1 : ent.spinK;
        ent.s1 = (ent.s1 || 0) + dt * 1.3 * k;
        ent.s2 = (ent.s2 || 0) + dt * 1.8 * k;
        const flat = ent.ringFlat || 0; // 1 = 两环放平（蓄力 / 瘫痪时）
        o[J.ringA] += 0.35 * Math.sin(t * 0.7) * (1 - flat);
        o[J.ringA + 1] = ent.s1;
        o[J.ringA + 2] += 0.25 * (1 - flat);
        o[J.ringB] += 0.5 * (1 - flat);
        o[J.ringB + 1] = -ent.s2;
        o[J.ringB + 2] += 0.4 * Math.cos(t * 0.9) * (1 - flat);
        o[J.orbit + 1] = -ent.s1 * 0.55;
        o[J.base + 1] = ent.s2 * 1.5;
        o[J.eye + 2] = t * 2.5 * (k > 0.2 ? 1 : 0.1);
        const es = (1 + Math.sin(t * 5) * 0.1) * (ent.eyeK || 1);
        o[J.eye + 6] = o[J.eye + 7] = es;
        setGlow(ent, (0.9 + 0.1 * Math.sin(t * 5)) * (k < 0.3 ? 0.45 : 1) + ((ent.eyeK || 1) - 1) * 0.8);
        if (!ent.clip) { ent.spinK = 1; ent.ringFlat = 0; ent.eyeK = 1; }
        if (!ent.dying) bossEmbers(ent, dt, 4.4, 1.3, 5);
      };
      const charge = (spin, flat, eye) => (ent, p, k) => { ent.spinK = 1 + (spin - 1) * k; ent.ringFlat = flat * k; ent.eyeK = 1 + (eye - 1) * k; };
      // 十字 / 轰炸 / 召唤：双手高举，两环放平加速，砸下
      defClip(rig, 'call_w', {
        dur: 0.4, hold: true, fade: 0.08,
        keys: {
          'root.oy': [0, 0.1, 1, 0.5], 'root.rx': [0, 0, 1, -0.12], 'head.rx': [0, 0, 1, -0.4],
          'handL.oy': [0, 0, 1, 2.1], 'handL.ox': [0, 0, 1, 0.5], 'handL.rx': [0, -0.15, 1, -0.6],
          'handR.oy': [0, 0, 1, 2.1], 'handR.ox': [0, 0, 1, -0.5], 'handR.rx': [0, -0.15, 1, -0.6],
        },
        fn: charge(3.2, 1, 1.5),
      });
      defClip(rig, 'call', {
        dur: 0.7, k0: 0.25, fade: 0.04, out: 0.3,
        keys: {
          'root.oy': [0, 0.5, -0.25, -0.45, 0.7, -0.3, 1, 0.1], 'root.rx': [0, -0.12, -0.25, 0.22, 0.7, 0.15, 1, 0], 'head.rx': [0, -0.4, -0.25, 0.3, 1, 0],
          'handL.oy': [0, 2.1, -0.25, -1.9, 0.7, -1.7, 1, 0], 'handL.ox': [0, 0.5, -0.25, 0.2, 1, 0], 'handL.oz': [0, 0, -0.25, 0.6, 1, 0], 'handL.rx': [0, -0.6, -0.25, 1.5, 0.7, 1.5, 1, -0.15],
          'handR.oy': [0, 2.1, -0.25, -1.9, 0.7, -1.7, 1, 0], 'handR.ox': [0, -0.5, -0.25, -0.2, 1, 0], 'handR.oz': [0, 0, -0.25, 0.6, 1, 0], 'handR.rx': [0, -0.6, -0.25, 1.5, 0.7, 1.5, 1, -0.15],
        },
        fn(ent, p, k) { ent.spinK = k < 0.3 ? 3.2 : 1 + 2.2 * (1 - k); ent.ringFlat = 1 - ramp(k, 0.3, 0.9); ent.eyeK = k < 0.35 ? 1.6 : 1; },
      });
      // 冲锋：整台机器前倾，双手后收，护盾转到身前
      defClip(rig, 'rush_w', {
        dur: 0.75, hold: true, fade: 0.1,
        keys: {
          'root.rx': [0, 0, 1, 0.42], 'root.oz': [0, 0, 1, -0.35], 'head.rx': [0, 0, 1, -0.35],
          'handL.oz': [0, 0, 1, -1.5], 'handL.ox': [0, 0, 1, 0.3], 'handL.rx': [0, -0.15, 1, 0.9],
          'handR.oz': [0, 0, 1, -1.5], 'handR.ox': [0, 0, 1, -0.3], 'handR.rx': [0, -0.15, 1, 0.9],
        },
        fn: charge(2.4, 0.6, 1.4),
      });
      defClip(rig, 'rush', {
        dur: 0.55, k0: 0.3, fade: 0.04, out: 0.3,
        keys: {
          'root.rx': [0, 0.42, 0.3, 0.62, 0.65, -0.2, 1, 0], 'root.oz': [0, -0.35, -0.2, 0.3, 1, 0], 'head.rx': [0, -0.35, 1, 0],
          'handL.oz': [0, -1.5, 0.5, -1.2, 1, 0], 'handL.ox': [0, 0.3, 1, 0], 'handL.rx': [0, 0.9, 1, -0.15],
          'handR.oz': [0, -1.5, 0.5, -1.2, 1, 0], 'handR.ox': [0, -0.3, 1, 0], 'handR.rx': [0, 0.9, 1, -0.15],
        },
        fn(ent, p, k) { ent.spinK = 2.4 - 1.4 * k; ent.ringFlat = 0.6 * (1 - k); },
      });
      // 环形弹幕：两环收紧，双手合到胸前，然后一起弹开
      defClip(rig, 'burst_w', {
        dur: 0.45, hold: true, fade: 0.08,
        keys: {
          'root.oy': [0, 0.1, 1, -0.2], 'ringA.s': [0, 1, 1, 0.62], 'ringB.s': [0, 1, 1, 0.62],
          'handL.ox': [0, 0, 1, -1.2], 'handL.oz': [0, 0, 1, 0.3], 'handL.ry': [0, 0, 1, -0.9],
          'handR.ox': [0, 0, 1, 1.2], 'handR.oz': [0, 0, 1, 0.3], 'handR.ry': [0, 0, 1, 0.9],
        },
        fn: charge(3.5, 1, 1.7),
      });
      defClip(rig, 'burst', {
        dur: 0.6, k0: 0.2, fade: 0.03, out: 0.3,
        keys: {
          'root.oy': [0, -0.2, -0.2, 0.4, 0.6, 0.3, 1, 0.1], 'ringA.s': [0, 0.62, -0.2, 1.45, 0.6, 1.2, 1, 1], 'ringB.s': [0, 0.62, -0.2, 1.5, 0.6, 1.2, 1, 1],
          'handL.ox': [0, -1.2, -0.2, 1.2, 0.6, 1.0, 1, 0], 'handL.oz': [0, 0.3, -0.2, -0.3, 1, 0], 'handL.ry': [0, -0.9, -0.2, 0.9, 1, 0],
          'handR.ox': [0, 1.2, -0.2, -1.2, 0.6, -1.0, 1, 0], 'handR.oz': [0, 0.3, -0.2, -0.3, 1, 0], 'handR.ry': [0, 0.9, -0.2, -0.9, 1, 0],
        },
        fn(ent, p, k) { ent.spinK = 1 + 2.5 * (1 - k); ent.ringFlat = 1 - ramp(k, 0.2, 0.8); ent.eyeK = k < 0.3 ? 1.7 : 1; },
      });
      aliasClip(rig, 'smash', 'call'); aliasClip(rig, 'smash_w', 'call_w'); aliasClip(rig, 'hurl', 'burst'); aliasClip(rig, 'hurl_w', 'burst_w');
      // 破防：失去动力坠到地上，歪向一边，两环停转，双手垂落
      defClip(rig, 'broken', {
        dur: 2.0, loop: true, fade: 0.25, out: 0.45,
        keys: {
          'root.oy': [0, -0.95, 1, -0.95], 'root.rz': [0, 0.32, 1, 0.32], 'root.rx': [0, 0.14, 1, 0.14], 'head.rx': [0, 0.45, 1, 0.45],
          'handL.oy': [0, -1.7, 1, -1.7], 'handL.rx': [0, 1.4, 1, 1.4], 'handL.ox': [0, 0.6, 1, 0.6],
          'handR.oy': [0, -1.2, 1, -1.2], 'handR.rx': [0, 1.2, 1, 1.2], 'handR.rz': [0, 0.5, 1, 0.5],
          'ringA.oy': [0, -0.9, 1, -0.9], 'ringB.oy': [0, -0.5, 1, -0.5], 'ringB.rz': [0, -0.5, 1, -0.5],
        },
        fn(ent, p, k) {
          const J = rig.J;
          ent.spinK = 0.06;
          ent.ringFlat = 1;
          ent.eyeK = 0.6 + 0.3 * Math.max(0, Math.sin(k * TAU * 6));
          p[J.root + 3] = Math.sin(k * TAU * 9) * 0.02;
          p[J.head + 2] = 0.1 * Math.sin(k * TAU);
        },
      });
      // 死亡：抽搐，两环崩开，整台机器栽倒
      defClip(rig, 'death', {
        dur: 1.6, base: 'rest', hold: true, fade: 0.1,
        keys: {
          'root.oy': [0, 0.3, 0.35, 0.6, -0.75, -1.3, 1, -1.3], 'root.rz': [0, 0, 0.35, -0.15, -0.75, 1.15, 0.85, 1.05, 1, 1.1], 'root.rx': [0, 0, 0.35, 0.15, 1, 0.25],
          'head.rx': [0, -0.3, 0.35, -0.5, 0.75, 0.6, 1, 0.5],
          'ringA.s': [0, 1, 0.35, 0.8, -0.55, 2.2, 1, 2.6], 'ringA.oy': [0, 0, 0.55, 0.5, 1, -1.2], 'ringA.rx': [0, 0, 1, 1.2],
          'ringB.s': [0, 1, 0.35, 0.8, -0.6, 1.9, 1, 2.2], 'ringB.oy': [0, 0, 0.6, 0.2, 1, -1.5], 'ringB.rz': [0, 0, 1, -1.0],
          'handL.oy': [0, 0.5, 0.35, 1.2, -0.7, -2.2, 1, -2.2], 'handL.ox': [0, 0, 1, 1.3], 'handL.rx': [0, -0.5, 1, 1.5],
          'handR.oy': [0, 0.5, 0.35, 1.0, -0.65, -2.2, 1, -2.2], 'handR.ox': [0, 0, 1, -0.6], 'handR.rx': [0, -0.5, 1, 1.4],
          'plate0.oy': [0, 0, 0.4, 0.3, -0.7, -0.85, 1, -0.85], 'plate1.oy': [0, 0, 0.45, 0.3, -0.75, -0.85, 1, -0.85], 'plate2.oy': [0, 0, 0.5, 0.3, -0.8, -0.85, 1, -0.85],
          'plate0.rx': [0, 0, 0.7, -1.4, 1, -1.5], 'plate1.rx': [0, 0, 0.75, 1.3, 1, 1.4], 'plate2.rz': [0, 0, 0.8, 1.3, 1, 1.4],
        },
        fn(ent, p, k) {
          ent.spinK = Math.max(0, 3 * (1 - k * 1.6));
          ent.ringFlat = 0;
          ent.eyeK = k < 0.35 ? 1 + k * 3 : Math.max(0.05, 2 - (k - 0.35) * 5);
          if (k < 0.4) p[rig.J.root + 3] = Math.sin(k * 160) * 0.06;
        },
      });
      bossAliases(rig, { slam: 'smash', charge: 'rush', ring: 'burst', spiral: 'burst', fan: 'hurl', barrage: 'call', summon: 'call', cross: 'call' });
      return rig;
    });
  }

  // ---------------------------------------------------------------------
  // 烬渊之主：黑曜石甲胄的巨角魔王，胸口一座熔炉，背后两扇刃翼，头顶悬着余烬冠，拖着一柄巨剑
  // ---------------------------------------------------------------------
  function lordRig() {
    return rigOf('lord', () => {
      const OBS = 0x3d2e38, OBS_D = 0x1d151b, OBS_L = 0x5c4653, CLOTH = 0x8a2230, CLOTH_D = 0x4a1019, CLOTH_IN = 0x21070b, BONE = 0xdccdb2, BONE_D = 0x9a8a72, GOLD = 0xb8862e;
      const b = rigBuilder('lord', NB_BIG);
      b.j('root', null, 0, 2.0, 0).j('spine', 'root', 0, 2.3, 0).j('chest', 'spine', 0, 2.8, 0).j('head', 'chest', 0, 3.65, 0.1);
      b.j('halo', 'head', 0, 4.75, 0.05).j('core', 'chest', 0, 2.95, 0.5);
      b.j('uaL', 'chest', 1.15, 3.3, 0).j('faL', 'uaL', 1.36, 2.4, 0.05).j('hL', 'faL', 1.42, 1.6, 0.15);
      b.j('uaR', 'chest', -1.15, 3.3, 0).j('faR', 'uaR', -1.36, 2.4, 0.05).j('hR', 'faR', -1.42, 1.6, 0.15).j('sword', 'hR', -1.42, 1.48, 0.2);
      b.j('thL', 'root', 0.42, 1.9, 0).j('shL', 'thL', 0.46, 1.05, 0.05).j('ftL', 'shL', 0.46, 0.22, 0.03);
      b.j('thR', 'root', -0.42, 1.9, 0).j('shR', 'thR', -0.46, 1.05, 0.05).j('ftR', 'shR', -0.46, 0.22, 0.03);
      b.j('wingL', 'chest', 0.5, 3.3, -0.45).j('wingL2', 'wingL', 1.7, 4.0, -0.75).j('wingR', 'chest', -0.5, 3.3, -0.45).j('wingR2', 'wingR', -1.7, 4.0, -0.75);
      b.j('cape1', 'chest', 0, 3.3, -0.5).j('cape2', 'cape1', 0, 2.1, -0.7).j('tab', 'root', 0, 1.95, 0.5);

      // 胯：裙甲、金腰带、前襟
      b.at('root').surf(SURF.dark);
      b.p(gLathe('ld/skirt', [[0.85, 1.4], [0.82, 1.6], [0.66, 1.95], [0.56, 2.12]], 10), [OBS_D, OBS], 0, 0, 0, 0, 0, 0, 1, 1, 0.82);
      b.surf(SURF.gold).p(gTorus(0.6, 0.07, 5, 14), GOLD, 0, 2.08, 0, HALF_PI, 0, 0, 1, 0.82, 1);
      b.surf(SURF.bone).p(gSph(0.17, 7, 5), BONE, 0, 2.08, 0.52, 0, 0, 0, 1, 1.15, 0.6);
      b.at('tab').surf(SURF.cloth).pd(gPlate('ld/tab', [[-0.3, 0], [0.3, 0], [0.26, -0.9], [0, -1.25], [-0.26, -0.9]], 0.02, 0.006), [CLOTH_D, CLOTH], CLOTH_IN, 0, 1.95, 0.6, -0.06);
      b.g(gPlate('ld/tabr', [[0, 0.2], [0.12, 0], [0, -0.2], [-0.12, 0]], 0.02, 0), 0.9, 0, 1.4, 0.68, -0.06);
      b.at('spine').surf(SURF.dark).p(gLathe('ld/abd', [[0.56, 2.05], [0.5, 2.3], [0.6, 2.6], [0.55, 2.75]], 10), [OBS_D, OBS], 0, 0, 0, 0, 0, 0, 1, 1, 0.8);

      // 胸：宽阔的黑曜石胸甲，肋状炉栅后面是熔炉；多层带刺的肩甲
      b.at('chest').surf(SURF.dark);
      b.p(gLathe('ld/chest', [[0.55, 2.65], [0.9, 2.95], [1.0, 3.25], [0.75, 3.5], [0.3, 3.66]], 12), [OBS, OBS_L], 0, 0, 0, 0, 0, 0, 1, 1, 0.74);
      b.surf(SURF.cloth).p(gSph(0.42, 8, 6), 0x0a0507, 0, 2.95, 0.42, 0, 0, 0, 1, 1.1, 0.6);
      b.surf(SURF.bone);
      for (let i = 0; i < 3; i++) {
        for (const s of [1, -1]) b.p(gSweep('ld/rib' + i + s, [[s * 0.62, 3.2 - i * 0.2, 0.42], [s * 0.36, 3.14 - i * 0.2, 0.72], [s * 0.06, 3.06 - i * 0.2, 0.78]], [0.06, 0.05, 0.035], 5), [BONE_D, BONE], 0, 0, 0);
      }
      b.at('core').g(gOct(0.34), 1, 0, 2.95, 0.5);
      b.at('chest').surf(SURF.dark, true);
      for (const s of [1, -1]) {
        b.p(gDome(0.62, 8, 3, 1.4), [OBS, OBS_L], s * 1.2, 3.42, 0, 0, 0, -s * 0.5, 1.1, 0.8, 1.15);
        b.p(gDome(0.5, 8, 3, 1.4), [OBS_D, OBS], s * 1.52, 3.22, 0, 0, 0, -s * 0.95, 1, 0.8, 1.2);
        b.p(gCone(0.2, 0.95, 5), OBS_L, s * 1.5, 4.0, -0.05, 0, 0, -s * 0.6).p(gCone(0.14, 0.6, 5), OBS, s * 1.86, 3.62, 0.1, 0, 0, -s * 1.1);
        b.g(gBox(0.06, 0.06, 0.7), 0.9, s * 1.68, 3.3, 0, 0, 0, -s * 0.95);
      }
      b.surf(SURF.gold).p(gTorus(0.36, 0.06, 5, 12), GOLD, 0, 3.6, 0.02, HALF_PI);

      // 头：窄盔，眼缝两点火，一对后掠的巨角加一对小角
      b.at('head').surf(SURF.dark);
      b.p(gSph(0.36, 10, 8), [OBS_D, OBS], 0, 3.92, 0.12, 0, 0, 0, 0.88, 1.12, 1);
      b.surf(SURF.dark, true).p(gPlate('ld/face', [[-0.24, 0.2], [0.24, 0.2], [0.16, -0.26], [0, -0.42], [-0.16, -0.26]], 0.12, 0.04), OBS_L, 0, 3.86, 0.44, -0.1);
      b.p(gCone(0.1, 0.5, 4), OBS_L, 0, 4.36, 0.2, -0.3);
      for (const s of [1, -1]) b.g(gSph(0.05, 6, 4), 1, s * 0.11, 3.94, 0.52, 0, 0, s * 0.35, 1.6, 0.55, 1);
      b.surf(SURF.bone);
      for (const s of [1, -1]) {
        b.p(gSweep('ld/horn' + s, [[s * 0.26, 4.05, 0.1], [s * 0.7, 4.25, 0.0], [s * 1.02, 4.72, -0.12], [s * 0.92, 5.3, -0.02]], [0.17, 0.15, 0.1, 0.012], 6), [BONE_D, BONE], 0, 0, 0);
        b.p(gSweep('ld/horn2' + s, [[s * 0.2, 4.2, -0.1], [s * 0.42, 4.5, -0.3], [s * 0.4, 4.86, -0.38]], [0.09, 0.07, 0.008], 5), BONE, 0, 0, 0);
        b.g(gSph(0.05, 5, 3), 0.9, s * 0.92, 5.3, -0.02);
      }
      // 余烬冠
      b.at('halo');
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        b.g(gOct(0.12), 1, Math.sin(a) * 0.8, 4.75, 0.05 + Math.cos(a) * 0.8, 0, a, 0, 1, 2.3, 1);
      }

      // 手臂：层叠的臂甲。左手是爪，掌心一团火；右手握着巨剑
      for (const s of [1, -1]) {
        const U = s > 0 ? 'uaL' : 'uaR', F = s > 0 ? 'faL' : 'faR', H = s > 0 ? 'hL' : 'hR';
        b.at(U).surf(SURF.dark).limb([OBS_D, OBS], s * 1.15, 3.3, 0, s * 1.36, 2.4, 0.05, 0.3, 0.24, 7, 3);
        b.at(F).limb([OBS, OBS_D], s * 1.36, 2.4, 0.05, s * 1.42, 1.66, 0.15, 0.26, 0.21, 7, 0);
        b.surf(SURF.dark, true).p(gCone(0.14, 0.5, 4), OBS_L, s * 1.52, 2.5, -0.18, -2.3, 0, -s * 0.3);
        b.surf(SURF.gold).p(gTorus(0.24, 0.045, 5, 10), GOLD, s * 1.4, 1.78, 0.13, HALF_PI + 0.12);
        b.at(H).surf(SURF.dark).p(gSph(0.25, 8, 6), [OBS_D, OBS], s * 1.42, 1.5, 0.17, 0, 0, 0, 0.95, 1.1, 1.05);
      }
      b.at('hL').surf(SURF.bone);
      for (let k = -1; k <= 1; k++) b.p(gSweep('ld/claw' + k, [[1.42 + k * 0.14, 1.36, 0.22], [1.44 + k * 0.2, 1.12, 0.4], [1.42 + k * 0.2, 0.9, 0.36]], [0.07, 0.055, 0.008], 5), [BONE, BONE_D], 0, 0, 0);
      b.g(gSph(0.16, 7, 5), 1, 1.42, 1.3, 0.34);
      // 巨剑：骨质护手，黑曜石宽刃，中间一道烧红的血槽
      const SX = -1.42, SY = 1.48;
      b.at('sword').surf(SURF.leather).p(gCyl(0.07, 0.08, 0.8, 6), OBS_D, SX, SY, 0.1, HALF_PI);
      b.surf(SURF.bone).p(gSph(0.13, 6, 4), BONE, SX, SY, -0.34);
      b.p(gPlate('ld/guard', [[-0.5, 0.1], [-0.3, -0.1], [0.3, -0.1], [0.5, 0.1], [0.24, 0.08], [-0.24, 0.08]], 0.16, 0.04), [BONE_D, BONE], SX, SY, 0.55, HALF_PI, HALF_PI, 0);
      b.surf(SURF.dark).p(gPlate('ld/blade', [[-0.2, 0], [0.2, 0], [0.26, 0.5], [0.2, 2.5], [0, 3.2], [-0.2, 2.5], [-0.26, 0.5]], 0.05, 0.045), [OBS, OBS_L], SX, SY, 0.62, HALF_PI, HALF_PI, 0);
      b.g(gBox(0.15, 0.1, 2.4), 1, SX, SY, 1.95);

      // 腿
      for (const s of [1, -1]) {
        const TH = s > 0 ? 'thL' : 'thR', SH = s > 0 ? 'shL' : 'shR', FT = s > 0 ? 'ftL' : 'ftR';
        b.at(TH).surf(SURF.dark).limb([OBS_D, OBS], s * 0.42, 1.9, 0, s * 0.46, 1.05, 0.05, 0.32, 0.25, 7, 2);
        b.surf(SURF.dark, true).p(gDome(0.26, 6, 2, 1.3), OBS_L, s * 0.46, 1.1, 0.2, HALF_PI - 0.2, 0, 0, 1, 0.9, 1.15);
        b.p(gCone(0.1, 0.36, 4), OBS_L, s * 0.46, 1.3, 0.34, 0.5);
        b.at(SH).surf(SURF.dark).p(gLathe('ld/greave', [[0.2, 0.2], [0.24, 0.5], [0.3, 0.9], [0.24, 1.08]], 8), [OBS_D, OBS], s * 0.46, 0, 0.05);
        b.surf(SURF.gold).p(gTorus(0.28, 0.04, 5, 10), GOLD, s * 0.46, 0.92, 0.05, HALF_PI);
        b.at(FT).surf(SURF.dark).p(gSph(0.27, 8, 6), [OBS_D, OBS], s * 0.46, 0.17, 0.2, 0, 0, 0, 0.95, 0.66, 1.8);
        b.surf(SURF.dark, true).p(gCone(0.12, 0.4, 4), OBS_L, s * 0.46, 0.14, 0.74, HALF_PI + 0.1);
      }

      // 刃翼：两段翼骨，下面垂着一排刀羽
      const feather = (h) => gPlate('ld/fth' + h, [[-0.2, 0], [0.2, 0], [0.13, -h * 0.7], [0, -h], [-0.1, -h * 0.65]], 0.03, 0.012);
      for (const s of [1, -1]) {
        const W1 = s > 0 ? 'wingL' : 'wingR', W2 = W1 + '2';
        b.at(W1).surf(SURF.bone).p(gSweep('ld/wa' + s, [[s * 0.5, 3.3, -0.45], [s * 1.1, 3.75, -0.62], [s * 1.7, 4.0, -0.75]], [0.14, 0.12, 0.1], 5), [BONE_D, BONE], 0, 0, 0);
        b.surf(SURF.cloth);
        b.pd(feather(1.9), [CLOTH_IN, CLOTH], CLOTH_D, s * 0.95, 3.62, -0.62, 0.3, 0, s * 0.12).pd(feather(2.2), [CLOTH_IN, CLOTH], CLOTH_D, s * 1.4, 3.88, -0.7, 0.3, 0, s * 0.25);
        b.at(W2).surf(SURF.bone).p(gSweep('ld/wb' + s, [[s * 1.7, 4.0, -0.75], [s * 2.4, 3.9, -0.9], [s * 3.0, 3.45, -1.0]], [0.1, 0.08, 0.02], 5), [BONE_D, BONE], 0, 0, 0);
        b.surf(SURF.dark, true).p(gCone(0.12, 0.6, 4), OBS_L, s * 1.72, 4.3, -0.75, 0, 0, -s * 0.2);
        b.surf(SURF.cloth);
        b.pd(feather(2.4), [CLOTH_IN, CLOTH], CLOTH_D, s * 1.95, 3.95, -0.82, 0.3, 0, s * 0.42).pd(feather(2.1), [CLOTH_IN, CLOTH_D], CLOTH_IN, s * 2.4, 3.86, -0.92, 0.3, 0, s * 0.62).pd(feather(1.6), [CLOTH_IN, CLOTH_D], CLOTH_IN, s * 2.8, 3.6, -1.0, 0.3, 0, s * 0.85);
        b.g(gSph(0.07, 5, 3), 0.9, s * 3.0, 3.45, -1.0);
      }
      // 披风
      b.surf(SURF.cloth);
      b.at('cape1').pd(gDrape('ld/c1', [[0.9, 2.05], [0.82, 2.7], [0.6, 3.35]], 2.2, 8), [CLOTH_D, CLOTH], CLOTH_IN, 0, 0, 0.1);
      b.at('cape2').pd(gDrape('ld/c2', [[1.1, 0.75], [1.05, 1.4], [0.92, 2.12]], 2.0, 8), [CLOTH_IN, CLOTH_D], CLOTH_IN, 0, 0, 0.1);

      const rig = b.build({ height: 5.3, reach: 3.8, stride: 1.25, shade: 0.28 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.22;
      sock(rig, 'weapon', 'sword', 0, 0, 3.8);
      sock(rig, 'hand', 'hL', 0, -0.3, 0.2);
      sock(rig, 'head', 'head', 0, 0.4, 0.1);
      sock(rig, 'chest', 'core', 0, 0, 0.3);
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, s = Math.sin(ent.walk), c = Math.cos(ent.walk), id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 4) * mv, br = Math.sin(t * 1.2 + ent.phase), fl = Math.sin(t * 1.5 + ent.phase);
        p[J.root + 1] = -0.1 * s * run;
        p[J.root + 2] = 0.03 * s * run;
        p[J.root] = 0.06 * run;
        p[J.spine] = 0.03 * br * id + 0.04 * run;
        p[J.chest] = 0.02 * br;
        p[J.chest + 1] = 0.14 * s * run;
        p[J.chest + 6] = p[J.chest + 8] = 1 + 0.012 * br;
        p[J.head] = -0.04 + 0.03 * br;
        p[J.head + 1] = 0.12 * Math.sin(t * 0.6 + ent.phase) * id;
        p[J.uaL] = -0.12 + 0.35 * s * run;
        p[J.uaL + 2] = 0.16;
        p[J.faL] = -0.35 - 0.1 * s * run;
        // 右手拖着剑：剑尖斜指前方地面
        p[J.uaR] = -0.2 - 0.12 * s * run + 0.02 * br;
        p[J.uaR + 2] = -0.2;
        p[J.faR] = -0.25;
        p[J.hR] = 0.62;
        p[J.hR + 1] = 0.3;
        p[J.thL] = p[J.thR] = -0.05;
        p[J.shL] = p[J.shR] = 0.1;
        p[J.thL + 2] = 0.06;
        p[J.thR + 2] = -0.06;
        legCycle(p, J.thL, J.shL, J.ftL, s, c, run, 0.5, 0.75);
        legCycle(p, J.thR, J.shR, J.ftR, -s, -c, run, 0.5, 0.75);
        // 翼：缓慢开合；披风与前襟随步伐飘
        p[J.wingL + 1] = 0.25 + 0.16 * fl;
        p[J.wingR + 1] = -0.25 - 0.16 * fl;
        p[J.wingL + 2] = 0.06 * fl;
        p[J.wingR + 2] = -0.06 * fl;
        p[J.wingL2 + 2] = -0.15 - 0.12 * fl;
        p[J.wingR2 + 2] = 0.15 + 0.12 * fl;
        p[J.cape1] = 0.05 + 0.22 * run + 0.03 * fl;
        p[J.cape2] = 0.06 + 0.2 * run + 0.06 * Math.sin(t * 2.1 + ent.phase);
        p[J.tab] = -0.04 - 0.25 * Math.abs(s) * run + 0.03 * fl;
      };
      rig.post = function (ent, o, t, dt) {
        const J = rig.J, k = ent.coreK || 1;
        o[J.halo + 1] = t * 1.2;
        o[J.halo + 4] += Math.sin(t * 2) * 0.06;
        o[J.core + 1] = t * 1.5;
        const sc = (1 + Math.sin(t * 4) * 0.12) * k;
        o[J.core + 6] = o[J.core + 7] = o[J.core + 8] = sc;
        setGlow(ent, 0.88 + 0.12 * Math.sin(t * 4) + (k - 1) * 0.8);
        ent.coreK = 1 + (k - 1) * Math.max(0, 1 - dt * 5);
        if (!ent.dying) bossEmbers(ent, dt, 3.2, 1.0, 9);
      };
      const heat = (v) => (ent, p, k) => { ent.coreK = 1 + v * k; };
      const wings = (keys, a, b2) => {
        // a / b2：[时间, 张开程度]（-1 收拢 … 1 完全张开）。b2 的时间 ≥ 0.99 时停在那个姿态（蓄力定格用），否则收回常态
        const e = b2[0] >= 0.99 ? b2[1] : 0;
        keys['wingL.ry'] = [0, 0.25, a[0], 0.25 - a[1] * 0.7, b2[0], 0.25 - b2[1] * 0.7, 1, 0.25 - e * 0.7];
        keys['wingR.ry'] = [0, -0.25, a[0], -0.25 + a[1] * 0.7, b2[0], -0.25 + b2[1] * 0.7, 1, -0.25 + e * 0.7];
        keys['wingL.rz'] = [0, 0, a[0], a[1] * 0.3, b2[0], b2[1] * 0.3, 1, e * 0.3];
        keys['wingR.rz'] = [0, 0, a[0], -a[1] * 0.3, b2[0], -b2[1] * 0.3, 1, -e * 0.3];
        keys['wingL2.rz'] = [0, -0.15, a[0], -0.15 + a[1] * 0.5, b2[0], -0.15 + b2[1] * 0.5, 1, -0.15 + e * 0.5];
        keys['wingR2.rz'] = [0, 0.15, a[0], 0.15 - a[1] * 0.5, b2[0], 0.15 - b2[1] * 0.5, 1, 0.15 - e * 0.5];
        return keys;
      };
      // 砸地：双手握剑举过头顶，劈下
      defClip(rig, 'smash_w', {
        dur: 0.95, hold: true, fade: 0.12,
        keys: wings({
          'root.rx': [0, 0, 1, -0.1], 'spine.rx': [0, 0, 1, -0.2], 'chest.rx': [0, 0, 1, -0.22], 'head.rx': [0, 0, 1, 0.15],
          'uaR.rx': [0, -0.2, 0.4, -1.4, 0.85, -3.0, 1, -3.2], 'uaR.rz': [0, -0.2, 0.5, -0.3, 1, 0.3], 'faR.rx': [0, -0.25, 0.85, -0.7, 1, -0.6], 'hR.rx': [0, 0.62, 0.5, 0.9, 1, 0.1], 'hR.ry': [0, 0.3, 1, 0],
          'uaL.rx': [0, -0.12, 0.4, -1.4, 0.85, -3.0, 1, -3.2], 'uaL.rz': [0, 0.16, 0.5, 0.2, 1, -0.3], 'faL.rx': [0, -0.35, 0.85, -0.8, 1, -0.7],
          'thL.rx': [0, -0.05, 1, -0.45], 'shL.rx': [0, 0.1, 1, 0.55], 'thR.rx': [0, -0.05, 1, 0.2], 'shR.rx': [0, 0.1, 1, 0.3],
          'cape1.rx': [0, 0.05, 1, -0.1],
        }, [0.6, 0.6], [0.99, 1]),
      });
      defClip(rig, 'smash', {
        dur: 0.65, k0: 0.2, fade: 0.03, out: 0.38,
        keys: wings({
          'root.rx': [0, -0.1, -0.2, 0.3, 0.7, 0.26, 1, 0], 'root.oz': [0, 0, -0.2, 0.3, 0.7, 0.26, 1, 0], 'spine.rx': [0, -0.2, -0.2, 0.3, 0.7, 0.26, 1, 0], 'chest.rx': [0, -0.22, -0.2, 0.25, 0.7, 0.2, 1, 0], 'head.rx': [0, 0.15, -0.2, -0.4, 1, 0],
          'uaR.rx': [0, -3.2, -0.2, -1.0, 0.7, -0.95, 1, -0.2], 'uaR.rz': [0, 0.3, -0.2, 0.3, 0.7, 0.26, 1, -0.2], 'faR.rx': [0, -0.6, -0.2, -0.08, 1, -0.25], 'hR.rx': [0, 0.1, -0.2, 1.25, 0.7, 1.2, 1, 0.62], 'hR.ry': [0, 0, 1, 0.3],
          'uaL.rx': [0, -3.2, -0.2, -1.0, 0.7, -0.95, 1, -0.12], 'uaL.rz': [0, -0.3, -0.2, -0.3, 0.7, -0.26, 1, 0.16], 'faL.rx': [0, -0.7, -0.2, -0.15, 1, -0.35],
          'thL.rx': [0, -0.45, -0.2, -1.5, 0.7, -1.45, 1, -0.05], 'shL.rx': [0, 0.55, -0.2, 1.4, 0.7, 1.35, 1, 0.1],
          'thR.rx': [0, 0.2, -0.2, 0.35, 0.7, 0.35, 1, -0.05], 'shR.rx': [0, 0.3, -0.2, 0.6, 0.7, 0.6, 1, 0.1], 'ftR.rx': [0, 0, -0.2, 0.5, 0.7, 0.5, 1, 0],
          'cape1.rx': [0, -0.1, -0.2, 0.6, 1, 0.05], 'cape2.rx': [0, 0, -0.26, 0.5, 1, 0.06],
        }, [0.2, -0.6], [0.7, -0.4]),
      });
      // 扇形齐射：左爪蓄火，横扫出去
      defClip(rig, 'hurl_w', {
        dur: 0.4, hold: true, fade: 0.08,
        keys: {
          'spine.ry': [0, 0, 1, 0.3], 'chest.ry': [0, 0, 1, 0.4], 'head.ry': [0, 0, 1, -0.5],
          'uaL.rx': [0, -0.12, 1, 0.5], 'uaL.rz': [0, 0.16, 1, 1.2], 'faL.rx': [0, -0.35, 1, -1.4],
        },
        fn: heat(0.5),
      });
      defClip(rig, 'hurl', {
        dur: 0.4, k0: 0.3, fade: 0.03, out: 0.22,
        keys: {
          'spine.ry': [0, 0.3, -0.3, -0.25, 0.7, -0.3, 1, 0], 'chest.ry': [0, 0.4, -0.3, -0.35, 0.7, -0.4, 1, 0], 'head.ry': [0, -0.5, -0.3, 0.4, 1, 0],
          'uaL.rx': [0, 0.5, -0.3, -1.45, 0.7, -1.5, 1, -0.12], 'uaL.rz': [0, 1.2, -0.3, 0.1, 0.7, -0.3, 1, 0.16], 'faL.rx': [0, -1.4, -0.3, -0.1, 0.7, -0.2, 1, -0.35],
          'hL.rx': [0, 0, -0.3, -0.7, 1, 0],
        },
      });
      // 螺旋 / 环形弹幕：剑举向天，左臂张开，双翼完全展开，一直撑到弹幕放完
      defClip(rig, 'burst_w', {
        dur: 0.3, hold: true, fade: 0.08,
        keys: wings({
          'spine.rx': [0, 0, 1, 0.25], 'chest.rx': [0, 0, 1, 0.2], 'head.rx': [0, 0, 1, 0.3],
          'uaR.rx': [0, -0.2, 1, -1.0], 'uaR.rz': [0, -0.2, 1, 0.4], 'faR.rx': [0, -0.25, 1, -1.3], 'hR.rx': [0, 0.62, 1, -0.4],
          'uaL.rx': [0, -0.12, 1, -0.9], 'uaL.rz': [0, 0.16, 1, -0.4], 'faL.rx': [0, -0.35, 1, -1.4],
          'thL.rx': [0, -0.05, 1, -0.4], 'shL.rx': [0, 0.1, 1, 0.7], 'thR.rx': [0, -0.05, 1, -0.3], 'shR.rx': [0, 0.1, 1, 0.7],
        }, [0.6, -0.6], [0.99, -1]),
        fn: heat(0.6),
      });
      defClip(rig, 'burst', {
        dur: 1.0, k0: 0.12, fade: 0.04, out: 0.4,
        keys: wings({
          'spine.rx': [0, 0.25, -0.12, -0.2, 0.85, -0.18, 1, 0], 'chest.rx': [0, 0.2, -0.12, -0.22, 0.85, -0.2, 1, 0], 'head.rx': [0, 0.3, -0.12, -0.3, 0.85, -0.25, 1, 0],
          'uaR.rx': [0, -1.0, -0.12, -2.9, 0.85, -2.8, 1, -0.2], 'uaR.rz': [0, 0.4, -0.12, -0.35, 0.85, -0.3, 1, -0.2], 'faR.rx': [0, -1.3, -0.12, -0.15, 0.85, -0.2, 1, -0.25], 'hR.rx': [0, -0.4, -0.12, 0.2, 0.85, 0.2, 1, 0.62],
          'uaL.rx': [0, -0.9, -0.12, -0.3, 0.85, -0.3, 1, -0.12], 'uaL.rz': [0, -0.4, -0.12, 1.35, 0.85, 1.25, 1, 0.16], 'faL.rx': [0, -1.4, -0.12, -0.2, 0.85, -0.25, 1, -0.35],
          'thL.rx': [0, -0.4, -0.12, -0.15, 1, -0.05], 'shL.rx': [0, 0.7, -0.12, 0.25, 1, 0.1], 'thR.rx': [0, -0.3, -0.12, -0.05, 1, -0.05], 'shR.rx': [0, 0.7, -0.12, 0.25, 1, 0.1],
          'thL.rz': [0, 0.06, 0.12, 0.2, 0.85, 0.2, 1, 0.06], 'thR.rz': [0, -0.06, 0.12, -0.2, 0.85, -0.2, 1, -0.06],
          'cape1.rx': [0, 0.05, 0.12, 0.5, 0.85, 0.4, 1, 0.05], 'cape2.rx': [0, 0.06, 0.16, 0.45, 0.85, 0.35, 1, 0.06],
        }, [0.12, 1], [0.85, 0.9]),
        fn(ent, p, k) {
          if (k > 0.1 && k < 0.85) {
            ent.coreK = 1.5;
            p[rig.J.uaR + 2] += Math.sin(k * 120) * 0.03; // 撑着的手臂在抖
          }
        },
      });
      // 十字 / 轰炸 / 召唤：反握巨剑高举，插进地里
      defClip(rig, 'call_w', {
        dur: 0.4, hold: true, fade: 0.08,
        keys: wings({
          'spine.rx': [0, 0, 1, -0.15], 'chest.rx': [0, 0, 1, -0.15],
          'uaR.rx': [0, -0.2, 1, -2.3], 'uaR.rz': [0, -0.2, 1, 0.35], 'faR.rx': [0, -0.25, 1, -0.9], 'hR.rx': [0, 0.62, 1, 2.6], 'hR.ry': [0, 0.3, 1, 0],
          'uaL.rx': [0, -0.12, 1, -2.2], 'uaL.rz': [0, 0.16, 1, -0.4], 'faL.rx': [0, -0.35, 1, -1.0],
          'thL.rx': [0, -0.05, 1, -0.3], 'shL.rx': [0, 0.1, 1, 0.4],
        }, [0.6, 0.5], [0.99, 0.8]),
      });
      defClip(rig, 'call', {
        dur: 0.75, k0: 0.22, fade: 0.03, out: 0.4,
        keys: wings({
          'root.rx': [0, 0, -0.22, 0.2, 0.75, 0.18, 1, 0], 'spine.rx': [0, -0.15, -0.22, 0.3, 0.75, 0.28, 1, 0], 'chest.rx': [0, -0.15, -0.22, 0.2, 0.75, 0.18, 1, 0], 'head.rx': [0, 0, -0.22, -0.35, 1, 0],
          'uaR.rx': [0, -2.3, -0.22, -0.95, 0.75, -0.95, 1, -0.2], 'uaR.rz': [0, 0.35, -0.22, 0.5, 0.75, 0.48, 1, -0.2], 'faR.rx': [0, -0.9, -0.22, -0.55, 0.75, -0.55, 1, -0.25], 'hR.rx': [0, 2.6, -0.22, 2.75, 0.75, 2.75, 1, 0.62], 'hR.ry': [0, 0, 1, 0.3],
          'uaL.rx': [0, -2.2, -0.22, -0.9, 0.75, -0.9, 1, -0.12], 'uaL.rz': [0, -0.4, -0.22, -0.55, 0.75, -0.52, 1, 0.16], 'faL.rx': [0, -1.0, -0.22, -0.6, 0.75, -0.6, 1, -0.35],
          'thL.rx': [0, -0.3, -0.22, -1.4, 0.75, -1.35, 1, -0.05], 'shL.rx': [0, 0.4, -0.22, 1.4, 0.75, 1.35, 1, 0.1],
          'thR.rx': [0, -0.05, -0.22, 0.1, 0.75, 0.1, 1, -0.05], 'shR.rx': [0, 0.1, -0.22, 1.3, 0.75, 1.25, 1, 0.1], 'ftR.rx': [0, 0, -0.22, 0.5, 0.75, 0.5, 1, 0],
          'cape1.rx': [0, 0.05, -0.22, 0.5, 1, 0.05], 'cape2.rx': [0, 0.06, -0.28, 0.5, 1, 0.06],
        }, [0.22, 1], [0.75, 0.7]),
        fn(ent, p, k) { if (k < 0.4) ent.coreK = 1.6; },
      });
      aliasClip(rig, 'rush', 'smash'); aliasClip(rig, 'rush_w', 'smash_w');
      // 破防：单膝跪倒，拄着剑，双翼垂落
      defClip(rig, 'broken', {
        dur: 2.2, loop: true, fade: 0.25, out: 0.5,
        keys: {
          'thL.rx': [0, -1.45, 1, -1.45], 'shL.rx': [0, 1.45, 1, 1.45], 'thR.rx': [0, 0.1, 1, 0.1], 'shR.rx': [0, 1.5, 1, 1.5], 'ftR.rx': [0, 0.5, 1, 0.5],
          'uaR.rx': [0, -1.0, 1, -1.0], 'uaR.rz': [0, 0.1, 1, 0.1], 'faR.rx': [0, -0.8, 1, -0.8], 'hR.rx': [0, 2.9, 1, 2.9], 'hR.ry': [0, 0, 1, 0],
          'uaL.rz': [0, 0.3, 1, 0.3], 'faL.rx': [0, -0.2, 1, -0.2],
          'wingL.ry': [0, 0.9, 1, 0.9], 'wingR.ry': [0, -0.9, 1, -0.9], 'wingL.rz': [0, -0.5, 1, -0.5], 'wingR.rz': [0, 0.5, 1, 0.5], 'wingL2.rz': [0, -0.8, 1, -0.8], 'wingR2.rz': [0, 0.8, 1, 0.8],
          'cape1.rx': [0, 0.3, 1, 0.3], 'halo.oy': [0, -0.5, 1, -0.5],
        },
        fn(ent, p, k) {
          const J = rig.J, s = Math.sin(k * TAU), s2 = Math.sin(k * TAU * 2);
          p[J.root] = 0.16;
          p[J.spine] = 0.3 + 0.04 * s2;
          p[J.chest] = 0.22 + 0.03 * s2;
          p[J.chest + 2] = 0.06 * s;
          p[J.chest + 6] = p[J.chest + 8] = 1 + 0.03 * s2;
          p[J.head] = 0.45 + 0.05 * s2;
          p[J.head + 2] = 0.14 * s;
          p[J.uaL] = 0.1 + 0.06 * s;
          p[J.halo + 2] = 0.3 + 0.1 * s;
          ent.coreK = 0.6 + 0.3 * Math.max(0, Math.sin(k * TAU * 4));
        },
      });
      // 死亡：巨剑脱手，仰天一震，跪倒，向前倾覆，余烬冠熄灭坠落
      defClip(rig, 'death', {
        dur: 1.8, base: 'rest', hold: true, air: true, fade: 0.1,
        keys: {
          'root.rx': [0, -0.1, 0.25, -0.25, 0.5, 0.05, 0.62, 0.1, -0.9, 1.35, 1, 1.3],
          'root.oy': [0, 0, 0.25, 0.05, -0.5, -0.92, 0.62, -0.92, -0.9, -1.55, 1, -1.55],
          'root.oz': [0, -0.1, 0.5, -0.1, 0.9, 0.9, 1, 0.9], 'root.rz': [0, 0, 0.5, 0.06, 1, 0.1],
          'spine.rx': [0, -0.2, 0.25, -0.4, 0.5, 0.2, 0.9, 0.15, 1, 0.1], 'chest.rx': [0, -0.2, 0.25, -0.4, 0.5, 0.2, 1, 0.1],
          'head.rx': [0, -0.4, 0.25, -0.7, 0.5, 0.5, 0.9, -0.2, 1, -0.1], 'head.rz': [0, 0, 1, 0.35],
          'uaL.rx': [0, -0.4, 0.25, -1.2, 0.5, -0.3, 0.9, -2.4, 1, -2.5], 'uaL.rz': [0, 0.5, 0.25, 1.3, 0.5, 0.5, 1, 0.7], 'faL.rx': [0, -0.5, 1, -0.3],
          'uaR.rx': [0, -0.3, 0.25, -1.0, 0.5, -0.2, 0.9, -1.4, 1, -1.5], 'uaR.rz': [0, -0.5, 0.25, -1.3, 0.5, -0.5, 1, -1.0], 'faR.rx': [0, -0.4, 1, -0.4],
          'sword.oy': [0, 0, 0.25, 0, -0.5, -1.2, 1, -1.2], 'sword.rz': [0, 0, 0.25, 0, 0.5, 1.2, 1, 1.4], 'sword.ox': [0, 0, 0.5, -0.6, 1, -0.9],
          'thL.rx': [0, 0, 0.25, 0.1, 0.5, -0.3, 0.9, 0.05, 1, 0.05], 'shL.rx': [0, 0.1, 0.25, 0.2, 0.5, 1.75, 0.9, 0.5, 1, 0.4],
          'thR.rx': [0, 0, 0.25, -0.2, 0.5, -0.2, 0.9, -0.15, 1, -0.15], 'shR.rx': [0, 0.1, 0.25, 0.4, 0.5, 1.7, 0.9, 0.8, 1, 0.7],
          'wingL.ry': [0, 0.25, 0.25, -0.6, 0.6, 0.9, 1, 1.1], 'wingR.ry': [0, -0.25, 0.25, 0.6, 0.6, -0.9, 1, -1.1],
          'wingL.rz': [0, 0, 0.25, 0.4, 0.6, -0.5, 1, -0.7], 'wingR.rz': [0, 0, 0.25, -0.4, 0.6, 0.5, 1, 0.7],
          'wingL2.rz': [0, -0.15, 0.25, 0.4, 0.6, -0.8, 1, -1.0], 'wingR2.rz': [0, 0.15, 0.25, -0.4, 0.6, 0.8, 1, 1.0],
          'cape1.rx': [0, 0.05, 0.5, 0.6, 0.9, 0, 1, -0.1], 'cape2.rx': [0, 0.06, 0.5, 0.6, 0.9, -0.2, 1, -0.2],
          'halo.oy': [0, 0, 0.3, 0.3, -0.75, -2.6, 1, -2.6], 'halo.s': [0, 1, 0.3, 1.3, 0.8, 0.3, 1, 0.1], 'halo.rx': [0, 0, 1, 1.2],
        },
        fn(ent, p, k) { ent.coreK = k < 0.3 ? 1 + k * 3 : Math.max(0.1, 1.9 - (k - 0.3) * 3.5); },
      });
      bossAliases(rig, { slam: 'smash', charge: 'rush', ring: 'burst', spiral: 'burst', fan: 'hurl', barrage: 'call', summon: 'call', cross: 'call' });
      return rig;
    });
  }

  const BOSS_RIG = { golem: golemRig, weaver: weaverRig, warden: wardenRig, lord: lordRig };

  W.makeBoss = function (kind, elemHex) {
    const eh = hexOf(elemHex);
    _c.set(eh); // 和小怪一样：暖色地面上的首领偏冷，冷色地面上的偏暖
    const warmGround = _c.r > 0.8 && _c.g < 0.6;
    const ent = newEnt(kind, BOSS_RIG[kind](), warmGround ? 0xd6daee : 0xfff0e0, eh, 1.15);
    if (warmGround) ent.uRim.value.setRGB(0.12, 0.15, 0.24);
    else ent.uRim.value.setRGB(0.24, 0.18, 0.12);
    groundDisc(ent, glowTex(), eh, G.BOSSES[kind].r * 2.4, 0.4);
    return ent;
  };

  // =====================================================================
  // 召唤物（友方）
  // =====================================================================
  // 统一的友方配色：苍白骨色 / 暗铁 / 浅石与青铜，魂火青的自发光，脚下一圈魂火青的光环，头顶魂火青的血条。
  // 敌人的自发光跟着区域元素走（橙 / 冰蓝 / 黄），玩家是暖白配金，魂火青这个偏绿的青色两边都不撞。
  const ALLY_HEX = 0x4fe3c8, ALLY_HI = 0xc4fff0, ALLY_CSS = '#4fe3c8'; // 与界面的 --ally 同色
  const ALLY_RGB = new T.Color(ALLY_HEX);
  // 友方脚环：一整圈实线 + 内圈细线 + 三颗朝外的菱形（精英怪是断续的环，一眼分得开）
  const allyRingTex = () =>
    tex('allyRing', () => {
      const S = 128, c = makeCanvas(S, S), g = c.getContext('2d');
      g.translate(S / 2, S / 2);
      g.strokeStyle = g.fillStyle = '#fff';
      g.lineWidth = 5;
      g.beginPath();
      g.arc(0, 0, 50, 0, TAU);
      g.stroke();
      g.globalAlpha = 0.55;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(0, 0, 41, 0, TAU);
      g.stroke();
      g.globalAlpha = 1;
      for (let i = 0; i < 3; i++) {
        g.save();
        g.rotate((i / 3) * TAU);
        g.beginPath();
        g.moveTo(0, -46);
        g.lineTo(7, -55);
        g.lineTo(0, -63);
        g.lineTo(-7, -55);
        g.closePath();
        g.fill();
        g.restore();
      }
      return new T.CanvasTexture(c);
    });

  // 友方脚环的暗底：普通混合的一圈暗色描边 + 很淡的暗心，垫在发光脚环下面，
  // 亮地面（冰原、骨灰地）上青环也压得住，不会被地面的青白色吃掉
  const allyShadeTex = () =>
    tex('allyShade', () => {
      const S = 128, c = makeCanvas(S, S), g = c.getContext('2d');
      g.translate(S / 2, S / 2);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 60);
      gr.addColorStop(0, 'rgba(0,0,0,0.32)');
      gr.addColorStop(0.62, 'rgba(0,0,0,0.38)');
      gr.addColorStop(0.72, 'rgba(0,0,0,0.9)');
      gr.addColorStop(0.92, 'rgba(0,0,0,0.9)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(0, 0, 60, 0, TAU);
      g.fill();
      return new T.CanvasTexture(c);
    });

  // 召唤物的每帧收尾：魂火忽明忽暗；升起 / 嘲讽 / 出手时亮一下，死亡时熄下去
  function minionPost(ent, o, t) {
    let k = 1 + 0.12 * Math.sin(t * 6.3 + ent.phase) + 0.07 * Math.sin(t * 15.7 + ent.phase * 3);
    const c = ent.clip;
    if (c) {
      const q = ent.cK, n = c.name;
      if (n === 'rise') k *= q < 0.72 ? 0.2 + q * 1.1 : 1 + 1.7 * (1 - smooth01((q - 0.72) / 0.28));
      else if (n === 'taunt') k *= 1 + 1.6 * hump(q, 0.48, 0.6, 0.8, 1);
      else if (n === 'attack') k *= 1 + 0.7 * hump(q, c.k0 - 0.2, c.k0, c.k0 + 0.04, c.k0 + 0.3);
      else if (n === 'death') k *= 1 - 0.85 * q;
    }
    setGlow(ent, k);
  }
  // 某个动作的归一化进度是否在这一帧越过了 a（播放期间的一次性特效用；换了动作自动重置）
  function crossed(ent, a) {
    return ent.fxPrev < a && ent.cK >= a;
  }
  // 动作里的一次性特效（rig.late，每帧在姿态解算之后调用）
  function minionLate(ent) {
    const c = ent.clip;
    if (c) minionClipFx(ent, c);
    else ent.fxClip = null;
    // 平时：魂火偶尔飘出一点余烬
    if (!ent.dying && Math.random() < (ent.kind === 'colossus' ? 0.07 : 0.035)) {
      W.entSocket(ent, 'chest', _sk);
      spawnP(_sk.x + rand(-0.1, 0.1), _sk.y, _sk.z + rand(-0.1, 0.1), rand(-0.2, 0.2), rand(0.4, 1.1), rand(-0.2, 0.2), rand(0.5, 0.9), 0.1, ALLY_RGB.r, ALLY_RGB.g, ALLY_RGB.b, -0.4, 0.6);
    }
  }
  function minionClipFx(ent, c) {
    if (ent.fxClip !== c) {
      ent.fxClip = c;
      ent.fxPrev = -1;
    }
    const g = ent.group.position, k = ent.k * ent.group.scale.x, big = ent.kind === 'colossus';
    const n = c.name;
    if (n === 'rise') {
      // 从地里钻出来：脚下翻起一圈魂火碎屑
      if (ent.cK < 0.65 && Math.random() < (big ? 0.9 : 0.55)) {
        const a = rand(0, TAU), d = rand(0.1, big ? 1.0 : 0.5) * k;
        spawnP(g.x + Math.sin(a) * d, 0.1, g.z + Math.cos(a) * d, Math.sin(a) * rand(0.3, 1.2), rand(1.5, 3.5), Math.cos(a) * rand(0.3, 1.2), rand(0.35, 0.7), rand(0.1, 0.2), ALLY_RGB.r * 0.8, ALLY_RGB.g * 0.8, ALLY_RGB.b * 0.8, 6, 1);
      }
      if (big && crossed(ent, 0.8)) {
        // 头颅落定、誓印点燃的那一下
        W.entSocket(ent, 'chest', _sk);
        for (let i = 0; i < 16; i++) {
          const a = rand(0, TAU), sp = rand(1.5, 4);
          spawnP(_sk.x, _sk.y, _sk.z, Math.sin(a) * sp, rand(0.5, 3), Math.cos(a) * sp, rand(0.35, 0.7), rand(0.12, 0.24), ALLY_RGB.r, ALLY_RGB.g, ALLY_RGB.b, 2, 1.5);
        }
      }
    } else if (n === 'attack' && crossed(ent, c.k0)) {
      // 命中帧：拳 / 刃落点扬起一点尘
      W.entSocket(ent, 'weapon', _sk);
      const cnt = big ? 14 : 4;
      for (let i = 0; i < cnt; i++) {
        const a = rand(0, TAU), sp = rand(1, big ? 4.5 : 2.5);
        spawnP(_sk.x + Math.sin(a) * 0.2, Math.max(0.1, _sk.y), _sk.z + Math.cos(a) * 0.2, Math.sin(a) * sp, rand(0.5, 2.5), Math.cos(a) * sp, rand(0.3, 0.6), rand(0.12, 0.26), 0.32, 0.3, 0.26, 5, 2);
      }
      if (big) {
        W.entSocket(ent, 'hand', _sk);
        for (let i = 0; i < cnt; i++) {
          const a = rand(0, TAU), sp = rand(1, 4.5);
          spawnP(_sk.x, Math.max(0.1, _sk.y), _sk.z, Math.sin(a) * sp, rand(0.5, 2.5), Math.cos(a) * sp, rand(0.3, 0.6), rand(0.12, 0.26), 0.32, 0.3, 0.26, 5, 2);
        }
      }
    } else if (n === 'taunt') {
      // 捶胸两下，然后吼：誓印喷出一把魂火
      if (crossed(ent, 0.16) || crossed(ent, 0.34)) {
        W.entSocket(ent, 'chest', _sk);
        for (let i = 0; i < 6; i++) spawnP(_sk.x, _sk.y, _sk.z, rand(-1.5, 1.5), rand(0, 2), rand(-1.5, 1.5), rand(0.2, 0.4), rand(0.1, 0.18), 1, 0.95, 0.85, 3, 2);
      }
      if (crossed(ent, c.k0)) {
        W.entSocket(ent, 'chest', _sk);
        for (let i = 0; i < 26; i++) {
          const a = rand(0, TAU), sp = rand(2, 6);
          spawnP(_sk.x, _sk.y, _sk.z, Math.sin(a) * sp, rand(0.5, 4), Math.cos(a) * sp, rand(0.4, 0.8), rand(0.12, 0.26), ALLY_RGB.r, ALLY_RGB.g, ALLY_RGB.b, 1, 1.4);
        }
      }
    } else if (n === 'death') {
      // 骸骨散架 / 石像崩落：倒地那一下溅出碎骨或碎石
      const at = big ? 0.42 : 0.55;
      if (crossed(ent, at) || (big && crossed(ent, 0.86))) {
        const cnt = big ? 18 : 10;
        for (let i = 0; i < cnt; i++) {
          const a = rand(0, TAU), sp = rand(1, big ? 4 : 2.5);
          spawnP(g.x + Math.sin(a) * 0.3 * k, rand(0.1, 0.5) * k, g.z + Math.cos(a) * 0.3 * k, Math.sin(a) * sp, rand(1, 3.5), Math.cos(a) * sp, rand(0.35, 0.7), rand(0.1, big ? 0.28 : 0.18), 0.5, 0.47, 0.4, 12, 1.2);
        }
      }
    }
    ent.fxPrev = ent.cK;
  }
  // 「idle」「walk」：步态本来就由 W.animEnt 的 moving 参数自动驱动；播放它们等于立刻回到站立 / 移动
  function locoClips(rig) {
    defClip(rig, 'idle', { dur: 0.01, fade: 0.12, out: 0.16 });
    defClip(rig, 'walk', { dur: 0.01, fade: 0.12, out: 0.16 });
  }

  // ---------------------------------------------------------------------
  // 烬骸仆从：精瘦的骷髅剑士，套着几片残甲——左肩暗铁肩甲、歪戴的半盔、一截胫甲；
  // 右手一把豁了口的剑，左臂绑着一面青铜包边的小圆盾；胸腔里烧着一团魂火
  // ---------------------------------------------------------------------
  function thrallRig() {
    return rigOf('thrall', () => {
      const BONE = 0xece3cc, BONE_D = 0xa69c86, IRON = 0x7a828e, IRON_D = 0x3d434d, BRONZE = 0xbb8e4c, BRONZE_D = 0x6f5329;
      const LEATHER = 0x5c4432, LEATHER_D = 0x35271c, WOOD = 0x6e5038, CLOTH = 0x2c4a47, CLOTH_L = 0x3f655f, CLOTH_IN = 0x132220, HOLE = 0x0a0c0c;
      const b = rigBuilder('thrall', NB_SMALL);
      b.j('root', null, 0, 0.95, 0).j('spine', 'root', 0, 1.05, -0.03).j('chest', 'spine', 0, 1.27, -0.03).j('head', 'chest', 0, 1.54, 0).j('jaw', 'head', 0, 1.6, 0.05);
      b.j('uaL', 'chest', 0.25, 1.44, -0.02).j('faL', 'uaL', 0.29, 1.15, -0.03).j('hL', 'faL', 0.31, 0.9, 0);
      b.j('uaR', 'chest', -0.25, 1.44, -0.02).j('faR', 'uaR', -0.29, 1.15, -0.03).j('hR', 'faR', -0.31, 0.9, 0);
      b.j('thL', 'root', 0.11, 0.92, 0).j('shL', 'thL', 0.12, 0.51, 0.01).j('ftL', 'shL', 0.12, 0.09, 0);
      b.j('thR', 'root', -0.11, 0.92, 0).j('shR', 'thR', -0.12, 0.51, 0.01).j('ftR', 'shR', -0.12, 0.09, 0);
      b.j('rag', 'root', 0, 0.99, 0.13).j('ragB', 'root', 0, 0.99, -0.13);

      // --- 骨盆：两片髂骨、骶骨、髋臼；皮腰带 + 青铜扣；左胯一片残破的铁甲裙 ---
      b.at('root').surf(SURF.bone);
      for (const s of [1, -1]) b.p(gSph(0.1, 8, 6), [BONE_D, BONE], s * 0.075, 0.97, -0.01, 0, 0, s * 0.55, 1.15, 0.8, 0.55);
      b.p(gCyl(0.05, 0.03, 0.13, 6), BONE_D, 0, 0.95, -0.06, -0.35);
      for (const s of [1, -1]) b.p(gSph(0.048, 7, 5), BONE, s * 0.11, 0.92, 0);
      b.surf(SURF.leather).p(gTorus(0.15, 0.03, 5, 12), LEATHER_D, 0, 1.02, 0, HALF_PI, 0, 0, 1, 0.8, 1);
      b.surf(SURF.gold).p(gRBox(0.09, 0.08, 0.04, 0.014), BRONZE, 0, 1.02, 0.125);
      b.surf(SURF.metal, true).p(gPlate('th/tasset', [[-0.08, 0.06], [0.08, 0.06], [0.09, -0.08], [0.02, -0.16], [-0.06, -0.1]], 0.02, 0.012), [IRON_D, IRON], 0.165, 0.94, 0.02, 0.06, HALF_PI, -0.22);
      b.at('rag').surf(SURF.cloth).pd(gPlate('th/rag', [[-0.1, 0], [0.1, 0], [0.11, -0.22], [0.04, -0.36], [0, -0.27], [-0.05, -0.39], [-0.11, -0.2]], 0.01, 0.003), [CLOTH, CLOTH_L], CLOTH_IN, 0, 1.0, 0.145, -0.08);
      b.at('ragB').pd(gPlate('th/ragb', [[-0.12, 0], [0.12, 0], [0.1, -0.3], [0.03, -0.24], [-0.04, -0.41], [-0.12, -0.26]], 0.01, 0.003), [CLOTH, CLOTH_L], CLOTH_IN, 0, 1.0, -0.145, 0.08);

      // --- 腰椎 ---
      b.at('spine').surf(SURF.bone);
      for (let i = 0; i < 3; i++) b.p(gCyl(0.034, 0.04, 0.055, 6), [BONE_D, BONE], 0, 1.05 + i * 0.07, -0.045);

      // --- 胸腔：胸椎、颈椎、四对肋骨、胸骨、锁骨、肩胛；肋骨间烧着魂火 ---
      b.at('chest').surf(SURF.bone);
      b.p(gCyl(0.028, 0.036, 0.3, 6), [BONE_D, BONE], 0, 1.36, -0.075, -0.08);
      b.p(gCyl(0.024, 0.028, 0.1, 6), BONE, 0, 1.53, -0.035, 0.25);
      for (let i = 0; i < 4; i++) {
        const y = 1.44 - i * 0.068, w = 0.135 + Math.sin((i + 1) * 0.8) * 0.035, z = 0.095 - i * 0.008;
        for (const s of [1, -1]) {
          b.p(gSweep('th/rib' + i + s, [[s * 0.02, y + 0.02, -0.085], [s * w, y, -0.045], [s * (w - 0.012), y - 0.03, z - 0.03], [s * 0.03, y - 0.06, z + 0.01]], [0.017, 0.019, 0.016, 0.011], 5), [BONE_D, BONE], 0, 0, 0);
        }
      }
      b.p(gRBox(0.05, 0.2, 0.03, 0.012), BONE, 0, 1.33, 0.105, -0.12);
      for (const s of [1, -1]) {
        b.limb(BONE, s * 0.03, 1.47, 0.06, s * 0.23, 1.46, -0.01, 0.017, 0.019, 5, 0);
        b.p(gPlate('th/scap', [[-0.06, 0.07], [0.07, 0.05], [0.02, -0.1]], 0.018, 0.008), BONE_D, s * 0.12, 1.39, -0.11, 0.1, 0, s * 0.2);
        b.p(gSph(0.048, 7, 5), [BONE_D, BONE], s * 0.25, 1.44, -0.02);
      }
      b.g(gSph(0.094, 8, 6), 1.5, 0, 1.33, 0.01, 0, 0, 0, 1, 1.5, 1);
      b.g(gCone(0.062, 0.22, 5), 1.25, 0, 1.48, 0.01);
      // 残甲：左肩两层暗铁肩甲 + 青铜包边，一条从左肩斜挎到右胯的皮带
      b.surf(SURF.metal);
      b.p(gDome(0.13, 9, 4, 1.4), [IRON_D, IRON], 0.28, 1.48, -0.01, 0, 0, -0.5, 1.05, 0.75, 1.15);
      b.p(gDome(0.105, 9, 3, 1.35), [IRON_D, IRON], 0.34, 1.41, -0.01, 0, 0, -0.95, 1, 0.7, 1.15);
      b.surf(SURF.gold).p(gSweep('th/rim', [[0.18, 1.545, 0.0], [0.28, 1.575, 0.0], [0.36, 1.525, 0.0], [0.41, 1.43, 0.0]], [0.015, 0.019, 0.017, 0.01], 4), BRONZE, 0, 0, 0);
      b.surf(SURF.leather).p(gSweep('th/strap', [[0.2, 1.51, 0.07], [0.08, 1.41, 0.125], [-0.07, 1.25, 0.12], [-0.15, 1.1, 0.07]], [0.02, 0.02, 0.02, 0.02], 4), LEATHER, 0, 0, 0);
      b.surf(SURF.gold).p(gSph(0.024, 6, 4), BRONZE, 0.005, 1.33, 0.135);

      // --- 头骨：深眼窝里两点魂火；歪戴的暗铁半盔，青铜盔脊 ---
      b.at('head').surf(SURF.bone);
      b.p(gSph(0.112, 10, 8), [BONE_D, BONE], 0, 1.665, 0, 0, 0, 0, 0.92, 1.0, 1.08);
      b.p(gRBox(0.165, 0.075, 0.1, 0.03), BONE, 0, 1.6, 0.065);
      b.surf(SURF.cloth);
      for (const s of [1, -1]) b.p(gSph(0.031, 6, 5), HOLE, s * 0.041, 1.64, 0.098, 0, 0, 0, 1.1, 0.9, 0.7);
      b.p(gCone(0.014, 0.03, 3), HOLE, 0, 1.607, 0.115, Math.PI);
      for (const s of [1, -1]) b.g(gSph(0.024, 6, 4), 1.7, s * 0.041, 1.64, 0.112);
      b.surf(SURF.bone).p(gRBox(0.115, 0.022, 0.03, 0.008), BONE, 0, 1.574, 0.1);
      b.surf(SURF.metal).p(gDome(0.122, 10, 3, 1.0), [IRON_D, IRON], 0.012, 1.69, -0.03, -0.38, 0, 0.16, 1, 0.95, 1.05);
      b.surf(SURF.gold).p(gSweep('th/crest', [[0, 1.775, 0.06], [0, 1.82, -0.02], [0, 1.795, -0.11], [0, 1.73, -0.15]], [0.013, 0.019, 0.017, 0.009], 4), BRONZE, 0, 0, 0);
      b.at('jaw').surf(SURF.bone).p(gPlate('th/jaw', [[-0.062, 0.02], [0.062, 0.02], [0.048, -0.045], [0, -0.065], [-0.048, -0.045]], 0.07, 0.014), BONE_D, 0, 1.555, 0.055, -0.2);
      b.p(gRBox(0.105, 0.02, 0.026, 0.008), BONE, 0, 1.565, 0.095);

      // --- 手臂：细骨、肘节、两根前臂骨、骨手；右前臂一圈青铜护腕 ---
      for (const s of [1, -1]) {
        const U = s > 0 ? 'uaL' : 'uaR', F = s > 0 ? 'faL' : 'faR', H = s > 0 ? 'hL' : 'hR';
        b.at(U).surf(SURF.bone).limb([BONE_D, BONE], s * 0.25, 1.44, -0.02, s * 0.29, 1.15, -0.03, 0.034, 0.029, 6, 2);
        b.at(F).limb([BONE_D, BONE], s * 0.29, 1.15, -0.03, s * 0.31, 0.92, 0, 0.027, 0.023, 6, 0);
        b.limb(BONE_D, s * 0.28, 1.13, -0.005, s * 0.3, 0.93, 0.02, 0.016, 0.015, 5, 0);
        b.at(H).p(gSph(0.044, 7, 5), [BONE_D, BONE], s * 0.31, 0.87, 0.01, 0, 0, 0, 0.8, 1.1, 1);
        for (let k = -1; k <= 1; k++) b.p(gCone(0.012, 0.07, 3), BONE, s * 0.31 + k * 0.021, 0.82, 0.03, Math.PI);
      }
      b.at('faR').surf(SURF.gold).p(gCyl(0.044, 0.05, 0.1, 8), [BRONZE_D, BRONZE], -0.305, 1.0, -0.012);
      b.surf(SURF.leather).p(gCyl(0.038, 0.04, 0.04, 8), LEATHER_D, -0.3, 1.075, -0.02);

      // --- 豁口剑：握把沿 +z，刃面竖着；血槽里一道光（随元素变色，见 W.minionElem） ---
      const WX = -0.31, WY = 0.85, WZ = 0.03;
      b.at('hR').surf(SURF.leather).p(gCyl(0.021, 0.023, 0.2, 6), LEATHER_D, WX, WY, WZ + 0.02, HALF_PI);
      b.surf(SURF.metal).p(gSph(0.03, 6, 4), IRON, WX, WY, WZ - 0.095);
      b.p(gRBox(0.04, 0.2, 0.045, 0.012), [IRON_D, IRON], WX, WY, WZ + 0.13);
      b.p(gPlate('th/blade', [[-0.045, 0], [0.045, 0], [0.05, 0.16], [0.03, 0.2], [0.052, 0.26], [0.055, 0.5], [0.034, 0.55], [0.05, 0.6], [0.042, 0.7], [0, 0.8], [-0.05, 0.68], [-0.056, 0.42], [-0.033, 0.37], [-0.054, 0.32], [-0.05, 0.1]], 0.012, 0.01), [0x6a7078, 0xb4b9be], WX, WY, WZ + 0.15, HALF_PI, HALF_PI, 0);
      b.x(gBox(0.038, 0.014, 0.44), 1, WX, WY, WZ + 0.44);

      // --- 小圆盾：绑在左前臂外侧，盾面朝 +x；木面、两道铁箍、青铜包边与盾心，盾面上一圈魂火誓印 ---
      b.at('faL').surf(SURF.leather).p(gCyl(0.215, 0.215, 0.03, 14), [LEATHER_D, WOOD], 0.365, 1.03, 0, 0, 0, HALF_PI);
      b.surf(SURF.metal).p(gBox(0.012, 0.4, 0.035), IRON, 0.383, 1.03, 0.085).p(gBox(0.012, 0.4, 0.035), IRON, 0.383, 1.03, -0.085);
      b.surf(SURF.gold).p(gTorus(0.215, 0.022, 4, 18), BRONZE, 0.38, 1.03, 0, 0, HALF_PI, 0);
      b.p(gDome(0.06, 8, 3), BRONZE, 0.38, 1.03, 0, 0, 0, -HALF_PI);
      b.g(gTorus(0.12, 0.016, 3, 16), 1.3, 0.388, 1.03, 0, 0, HALF_PI, 0);
      b.g(gTorus(0.226, 0.01, 3, 18), 0.9, 0.392, 1.03, 0, 0, HALF_PI, 0); // 盾沿一圈魂火描边

      // --- 腿：股骨、髌骨、胫腓骨、骨脚；右小腿一截暗铁胫甲，左膝青铜护膝 ---
      for (const s of [1, -1]) {
        const TH = s > 0 ? 'thL' : 'thR', SH = s > 0 ? 'shL' : 'shR', FT = s > 0 ? 'ftL' : 'ftR';
        b.at(TH).surf(SURF.bone).limb([BONE_D, BONE], s * 0.11, 0.92, 0, s * 0.12, 0.52, 0.01, 0.038, 0.031, 6, 0);
        b.p(gSph(0.04, 7, 5), BONE, s * 0.12, 0.52, 0.035);
        b.at(SH).limb([BONE_D, BONE], s * 0.12, 0.51, 0.01, s * 0.12, 0.1, 0, 0.031, 0.024, 6, 0);
        b.limb(BONE_D, s * 0.14, 0.48, -0.012, s * 0.135, 0.12, -0.01, 0.015, 0.013, 5, 0);
        b.at(FT).p(gSph(0.05, 7, 5), [BONE_D, BONE], s * 0.12, 0.05, 0.05, 0, 0, 0, 0.85, 0.6, 1.8);
        for (let k = -1; k <= 1; k++) b.p(gCone(0.012, 0.06, 3), BONE, s * 0.12 + k * 0.022, 0.025, 0.15, HALF_PI);
      }
      b.at('shR').surf(SURF.metal).p(gLathe('th/greave', [[0.048, 0.16], [0.058, 0.28], [0.064, 0.4], [0.053, 0.46]], 8), [IRON_D, IRON], -0.12, 0, 0.012);
      b.at('thL').surf(SURF.gold).p(gDome(0.058, 7, 2, 1.3), BRONZE, 0.12, 0.53, 0.05, HALF_PI - 0.2, 0, 0, 1, 0.9, 1.1);

      const rig = b.build({ height: 1.85, reach: 1.7, stride: 2.7, shade: 0.25 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.09;
      sock(rig, 'weapon', 'hR', 0, -0.05, 0.92);
      sock(rig, 'hand', 'hR', 0, -0.05, 0.03);
      sock(rig, 'handL', 'hL', 0, -0.05, 0.02);
      sock(rig, 'head', 'head', 0, 0.13, 0.02);
      sock(rig, 'chest', 'chest', 0, 0.06, 0.06);
      rig.post = minionPost;
      rig.late = minionLate;
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, s = Math.sin(ent.walk), c = Math.cos(ent.walk), id = 1 - mv;
        const run = Math.min(1.25, ent.spd / 5.5) * mv;
        const br = Math.sin(t * 1.8 + ent.phase), br2 = Math.sin(t * 0.8 + ent.phase * 1.7);
        p[J.root] = 0.16 * run;
        p[J.root + 1] = -0.14 * s * run;
        p[J.root + 2] = 0.04 * c * run;
        p[J.spine] = 0.1 + 0.08 * run + 0.02 * br * id;
        p[J.spine + 1] = 0.1 * s * run;
        p[J.chest] = 0.06 + 0.06 * run + 0.025 * br * id;
        p[J.chest + 1] = 0.16 * s * run - 0.12 * id;
        p[J.head] = -0.12 - 0.14 * run + 0.03 * br;
        p[J.head + 1] = 0.22 * br2 * id - 0.1 * s * run + 0.1 * id;
        p[J.head + 2] = 0.1 * Math.sin(t * 0.55 + ent.phase) * id;
        p[J.jaw] = 0.05 + 0.12 * Math.max(0, Math.sin(t * 11 + ent.phase)) * (0.25 + 0.75 * run);
        // 站着时是防守架势：左脚在前，屈膝
        p[J.thL] = -0.32 * id;
        p[J.shL] = 0.42 * id;
        p[J.ftL] = -0.1 * id;
        p[J.thR] = 0.12 * id;
        p[J.shR] = 0.3 * id;
        p[J.thL + 2] = 0.08 * id;
        p[J.thR + 2] = -0.1 * id;
        legCycle(p, J.thL, J.shL, J.ftL, s, c, run, 0.78, 1.15);
        legCycle(p, J.thR, J.shR, J.ftR, -s, -c, run, 0.78, 1.15);
        // 左臂：小臂横在身前举着盾
        p[J.uaL] = -0.5 - 0.15 * run + 0.03 * br;
        p[J.uaL + 1] = -0.55;
        p[J.uaL + 2] = 0.18;
        p[J.faL] = -1.25 - 0.1 * run;
        // 右臂：剑尖斜指前下方，跑起来随步子前后摆
        p[J.uaR] = -0.15 - 0.45 * s * run + 0.03 * br2;
        p[J.uaR + 2] = -0.14 - 0.05 * run;
        p[J.faR] = -0.75 - 0.25 * run;
        p[J.hR] = 0.45 - 0.15 * run;
        p[J.hR + 1] = 0.2;
        p[J.rag] = -0.06 - 0.32 * run * Math.max(Math.abs(s), 0.4) + 0.04 * br;
        p[J.ragB] = 0.08 + 0.3 * run + 0.05 * Math.sin(t * 2.7 + ent.phase);
      };
      thrallClips(rig);
      return rig;
    });
  }
  function thrallClips(rig) {
    locoClips(rig);
    // 升起：一只骨手先破土，撑着地面把身子拔出来，迈出一步站定（全程在地面以下的部分被地面挡住）
    defClip(rig, 'rise', {
      dur: 0.7, base: 'rest', air: true, fade: 0, out: 0.16,
      keys: {
        'root.oy': [0, -1.95, 0.2, -1.55, 0.42, -0.85, -0.65, -0.1, 0.82, 0.03, 1, 0],
        'root.rx': [0, 0.55, 0.3, 0.6, 0.62, 0.25, 1, 0.08],
        'root.rz': [0, 0.2, 0.4, -0.1, 0.75, 0.04, 1, 0],
        'spine.rx': [0, 0.45, 0.5, 0.3, 1, 0.1],
        'chest.rx': [0, 0.3, 0.5, 0.25, 1, 0.06],
        'head.rx': [0, -0.7, 0.4, -0.35, 0.7, 0.2, 1, -0.1],
        'head.rz': [0, 0.35, 0.5, -0.25, 0.8, 0.12, 1, 0.05],
        'jaw.rx': [0, 0.55, 0.55, 0.5, 0.85, 0.05, 1, 0.08],
        'uaL.rx': [0, -2.9, 0.22, -2.7, 0.45, -0.7, 0.75, -0.45, 1, -0.5],
        'uaL.rz': [0, 0.25, 0.45, 0.65, 0.75, 0.25, 1, 0.18],
        'uaL.ry': [0, 0, 0.6, 0, 1, -0.55],
        'faL.rx': [0, -0.2, 0.45, -0.25, 0.8, -1.1, 1, -1.25],
        'uaR.rx': [0, -1.2, 0.2, -2.8, 0.4, -2.4, 0.62, -0.9, 0.85, -0.2, 1, -0.15],
        'uaR.rz': [0, -0.3, 0.4, -0.45, 0.7, -0.2, 1, -0.14],
        'faR.rx': [0, -0.6, 0.3, -0.3, 0.6, -1.3, 1, -0.75],
        'hR.rx': [0, 1.2, 0.5, 0.9, 1, 0.45],
        'thL.rx': [0, -1.5, 0.45, -1.7, 0.72, -0.7, 1, -0.32],
        'shL.rx': [0, 1.9, 0.45, 2.1, 0.72, 0.9, 1, 0.42],
        'thR.rx': [0, -0.4, 0.5, -0.2, 0.8, 0.15, 1, 0.12],
        'shR.rx': [0, 1.3, 0.5, 1.4, 0.8, 0.45, 1, 0.3],
        'rag.rx': [0, 0.6, 0.6, 0.4, 1, -0.06],
        'ragB.rx': [0, -0.4, 0.6, 0.5, 1, 0.08],
      },
    });
    // 劈砍：剑举过右肩，拧腰斜劈到左下，左脚踏前一步；盾向后收（真的在走时腿让位给步态）
    defClip(rig, 'attack', {
      dur: 0.5, k0: 0.45, lower: ['thL', 'shL', 'ftL', 'thR', 'shR', 'ftR'], fade: 0.05, out: 0.2,
      keys: {
        'root.ry': [0, 0, 0.3, -0.32, -0.45, 0.32, 0.72, 0.28, 1, 0],
        'root.rx': [0, 0.1, 0.3, 0.0, -0.45, 0.3, 0.72, 0.26, 1, 0.1],
        'root.oz': [0, 0, 0.3, -0.06, -0.45, 0.16, 0.72, 0.13, 1, 0],
        'chest.ry': [0, -0.1, 0.3, -0.45, -0.45, 0.45, 0.72, 0.38, 1, -0.1],
        'chest.rx': [0, 0.06, 0.3, -0.12, -0.45, 0.2, 1, 0.06],
        'head.ry': [0, 0.1, 0.3, 0.45, -0.45, -0.3, 0.72, -0.25, 1, 0.1],
        'head.rx': [0, -0.12, 0.3, -0.25, -0.45, 0.05, 1, -0.12],
        'jaw.rx': [0, 0.05, 0.3, 0.1, -0.45, 0.5, 0.8, 0.3, 1, 0.05],
        'uaR.rx': [0, -0.2, 0.3, -2.7, -0.45, -0.65, 0.72, -0.45, 1, -0.2],
        'uaR.rz': [0, -0.14, 0.3, -0.55, -0.45, 0.45, 0.72, 0.5, 1, -0.14],
        'uaR.ry': [0, 0, 0.3, 0.3, -0.45, -0.2, 1, 0],
        'faR.rx': [0, -0.75, 0.3, -1.5, -0.45, -0.2, 0.72, -0.3, 1, -0.75],
        'hR.rx': [0, 0.45, 0.3, 0.1, -0.45, 0.85, 0.72, 0.8, 1, 0.45],
        'hR.ry': [0, 0.2, 1, 0.2],
        'uaL.rx': [0, -0.5, 0.3, -0.7, -0.45, 0.1, 0.72, 0.05, 1, -0.5],
        'uaL.rz': [0, 0.18, 0.3, 0.3, -0.45, 0.5, 1, 0.18],
        'faL.rx': [0, -1.25, 0.3, -1.4, -0.45, -0.8, 1, -1.25],
        'thL.rx': [0, -0.32, 0.3, -0.25, -0.45, -0.85, 0.72, -0.8, 1, -0.32],
        'shL.rx': [0, 0.42, 0.3, 0.35, -0.45, 0.95, 0.72, 0.9, 1, 0.42],
        'thR.rx': [0, 0.12, 0.3, 0.05, -0.45, 0.45, 0.72, 0.4, 1, 0.12],
        'shR.rx': [0, 0.3, 0.3, 0.25, -0.45, 0.55, 1, 0.3],
        'rag.rx': [0, -0.06, -0.45, -0.4, 1, -0.06],
      },
    });
    // 死亡：两膝一软跪坐下去，上身往前栽倒趴在地上，胸腔塌下去；头骨脱出来滚到一边，两臂散开，剑从手里滑落
    defClip(rig, 'death', {
      dur: 0.75, base: 'rest', hold: true, air: true, fade: 0.05,
      clear: [['head', 0, 0.12, 0.02, 0.11], ['chest', 0, 0.06, 0.02, 0.13], ['root', 0, 0, 0, 0.11], ['shL', 0, 0, 0.02, 0.05], ['shR', 0, 0, 0.02, 0.05], ['hL', 0, -0.03, 0, 0.05], ['hR', 0, -0.03, 0, 0.05], ['faL', 0.07, -0.12, 0, 0.2]],
      keys: {
        'root.oy': [0, 0, 0.25, -0.12, -0.6, -0.8, 1, -0.86],
        'root.rx': [0, -0.15, 0.25, -0.2, 0.6, 0.75, 1, 1.15],
        'root.rz': [0, 0, 0.5, 0.15, 1, 0.2],
        'spine.rx': [0, -0.1, 0.3, 0.2, 0.7, 0.45, 1, 0.35],
        'spine.rz': [0, 0, 1, -0.25],
        'chest.rx': [0, -0.15, 0.3, 0.1, 0.7, 0.35, 1, 0.2],
        'chest.sy': [0, 1, 0.6, 1, 1, 0.82],
        'head.rx': [0, -0.4, 0.3, -0.2, 0.55, 0.3, 1, 1.9],
        'head.rz': [0, 0, 0.5, 0.2, 1, 1.3],
        'head.oz': [0, 0, 0.5, 0.02, 0.75, 0.22, 1, 0.3],
        'head.oy': [0, 0, 0.5, 0.03, 0.75, -0.08, 1, -0.12],
        'head.ox': [0, 0, 0.5, 0, 1, 0.22],
        'jaw.rx': [0, 0.1, 0.4, 0.7, 1, 0.9],
        'thL.rx': [0, 0, 0.3, -0.5, 0.6, -1.5, 1, -1.6],
        'shL.rx': [0, 0.1, 0.3, 0.9, 0.6, 2.4, 1, 2.5],
        'thR.rx': [0, 0, 0.3, -0.3, 0.6, -1.25, 1, -1.35],
        'shR.rx': [0, 0.1, 0.3, 0.8, 0.6, 2.3, 1, 2.45],
        'thL.rz': [0, 0, 1, 0.35],
        'thR.rz': [0, 0, 1, -0.3],
        'uaL.rx': [0, -0.5, 0.3, -1.0, 0.7, -0.5, 1, -0.3],
        'uaL.ry': [0, -0.55, 1, 0],
        'uaL.rz': [0, 0.18, 0.5, 0.8, 1, 1.3],
        'faL.rx': [0, -1.25, 0.5, -0.5, 1, -0.2],
        'uaR.rx': [0, -0.2, 0.3, -0.8, 0.7, -0.5, 1, -0.35],
        'uaR.rz': [0, -0.14, 0.5, -0.8, 1, -1.25],
        'faR.rx': [0, -0.75, 0.5, -0.3, 1, -0.1],
        'hR.rx': [0, 0.45, 0.5, 1.2, 1, 1.5],
        'rag.rx': [0, 0, 0.6, -0.5, 1, -0.3],
        'ragB.rx': [0, 0, 0.6, 0.6, 1, 0.4],
      },
    });
  }

  // ---------------------------------------------------------------------
  // 石誓守像：风化暗石拼成的宽厚哨卫，青铜箍边；胸口的青铜圆章里亮着一道誓约之印，
  // 一双巨石般的拳头，方正的石盔上一道魂火目缝；腰间垂着友方颜色的布幡。约 1.6 倍玩家高
  // ---------------------------------------------------------------------
  function colossusRig() {
    return rigOf('colossus', () => {
      // 风化的暗灰石 + 暗青铜：明度明显低于玩家的白甲，站在一起也分得开
      const STONE = 0x655e55, STONE_D = 0x38342f, STONE_L = 0x786f63, BRONZE = 0x8a5d2b, BRONZE_D = 0x452c12;
      const CLOTH = 0x214f49, CLOTH_L = 0x2f6b63, CLOTH_IN = 0x0e2421, HOLE = 0x0b0d0d;
      const b = rigBuilder('colossus', NB_SMALL);
      b.j('root', null, 0, 1.5, 0).j('chest', 'root', 0, 1.85, 0).j('head', 'chest', 0, 2.85, 0.1);
      b.j('uaL', 'chest', 0.86, 2.6, 0).j('faL', 'uaL', 1.0, 1.95, 0.04).j('hL', 'faL', 1.06, 1.38, 0.1);
      b.j('uaR', 'chest', -0.86, 2.6, 0).j('faR', 'uaR', -1.0, 1.95, 0.04).j('hR', 'faR', -1.06, 1.38, 0.1);
      b.j('thL', 'root', 0.36, 1.42, 0).j('shL', 'thL', 0.4, 0.82, 0.04).j('ftL', 'shL', 0.4, 0.22, 0.02);
      b.j('thR', 'root', -0.36, 1.42, 0).j('shR', 'thR', -0.4, 0.82, 0.04).j('ftR', 'shR', -0.4, 0.22, 0.02);
      b.j('tab', 'root', 0, 1.6, 0.44).j('tab2', 'tab', 0, 1.06, 0.46);

      // --- 胯：厚重的石座，青铜腰箍，腰扣上一点魂火 ---
      b.at('root').surf(SURF.stone, true);
      b.p(gLathe('cl/hip', [[0.4, 1.18], [0.5, 1.3], [0.54, 1.5], [0.48, 1.7], [0.42, 1.8]], 8), [STONE_D, STONE], 0, 0, 0, 0, Math.PI / 8, 0, 1, 1, 0.78);
      b.surf(SURF.gold, true).p(gCyl(0.535, 0.555, 0.14, 8), [BRONZE_D, BRONZE], 0, 1.62, 0, 0, Math.PI / 8, 0, 1, 1, 0.8);
      b.p(gRBox(0.24, 0.2, 0.07, 0.03), BRONZE, 0, 1.6, 0.44);
      b.g(gOct(0.05), 0.9, 0, 1.6, 0.485, 0, 0, 0, 1, 1.3, 0.5);
      b.surf(SURF.stone, true);
      for (const s of [1, -1]) b.p(gIco(0.25, 0), STONE_D, s * 0.36, 1.4, 0);
      // --- 前襟布幡：上下两截，青铜横杆，上截缀一枚青铜菱徽 ---
      b.at('tab').surf(SURF.cloth).pd(gPlate('cl/tab', [[-0.22, 0], [0.22, 0], [0.22, -0.55], [-0.22, -0.55]], 0.016, 0.005), [CLOTH, CLOTH_L], CLOTH_IN, 0, 1.6, 0.47, -0.06);
      b.surf(SURF.gold).p(gCyl(0.026, 0.026, 0.54, 6), BRONZE, 0, 1.62, 0.49, 0, 0, HALF_PI);
      b.p(gPlate('cl/tabsig', [[0, 0.08], [0.06, 0], [0, -0.08], [-0.06, 0]], 0.012, 0.004), BRONZE, 0, 1.33, 0.5, -0.06);
      b.at('tab2').surf(SURF.cloth).pd(gPlate('cl/tab2', [[-0.22, 0], [0.22, 0], [0.2, -0.3], [0.08, -0.42], [0, -0.33], [-0.1, -0.44], [-0.21, -0.3]], 0.016, 0.005), [CLOTH, CLOTH_L], CLOTH_IN, 0, 1.06, 0.5, -0.02);

      // --- 躯干：上宽下窄的石胸，背后一块石板；胸前青铜护心镜，镜心是发光的誓约之印 ---
      b.at('chest').surf(SURF.stone, true);
      b.p(gLathe('cl/torso', [[0.44, 1.72], [0.56, 1.95], [0.74, 2.3], [0.82, 2.55], [0.66, 2.78], [0.34, 2.9]], 8), [STONE_D, STONE], 0, 0, 0, 0, Math.PI / 8, 0, 1, 1, 0.72);
      b.p(gRBox(0.92, 0.72, 0.18, 0.05), [STONE_D, STONE_L], 0, 2.4, -0.5, 0.12);
      b.surf(SURF.gold, true).p(gPlate('cl/pect', [[-0.46, 0.2], [0, 0.32], [0.46, 0.2], [0.4, -0.2], [0, -0.36], [-0.4, -0.2]], 0.08, 0.03), [BRONZE_D, BRONZE], 0, 2.42, 0.53, -0.12);
      b.surf(SURF.stone, true).p(gCyl(0.21, 0.21, 0.05, 10), HOLE, 0, 2.43, 0.6, HALF_PI - 0.12, 0, 0);
      b.surf(SURF.gold).p(gTorus(0.215, 0.032, 4, 16), BRONZE, 0, 2.43, 0.625, -0.12, 0, 0);
      // 誓印：一圈光环 + 一道竖贯的誓线 + 正中一颗菱形魂核（与技能图标同一个字形）
      b.g(gTorus(0.15, 0.02, 3, 16), 1.5, 0, 2.43, 0.632, -0.12, 0, 0);
      b.g(gBox(0.034, 0.27, 0.03), 1.5, 0, 2.43, 0.64, -0.12);
      b.g(gOct(0.07), 1.8, 0, 2.43, 0.665, -0.12, 0, 0, 0.85, 1.25, 0.55);
      // 项圈
      b.surf(SURF.gold, true).p(gCyl(0.36, 0.42, 0.12, 8), [BRONZE_D, BRONZE], 0, 2.86, 0.02, 0, Math.PI / 8, 0);

      // --- 头：方正的石盔，眉骨下一道魂火目缝，顶上一条青铜盔脊 ---
      b.at('head').surf(SURF.stone, true);
      b.p(gRBox(0.42, 0.46, 0.44, 0.07), [STONE_D, STONE], 0, 3.1, 0.12);
      b.p(gRBox(0.47, 0.12, 0.2, 0.04), STONE_D, 0, 3.17, 0.28);
      b.surf(SURF.cloth).p(gBox(0.34, 0.075, 0.04), HOLE, 0, 3.08, 0.345);
      b.g(gBox(0.3, 0.04, 0.03), 1.7, 0, 3.08, 0.36);
      b.surf(SURF.gold, true).p(gRBox(0.08, 0.1, 0.52, 0.03), BRONZE, 0, 3.36, 0.1);
      b.p(gRBox(0.46, 0.06, 0.48, 0.02), BRONZE_D, 0, 2.94, 0.12);

      // --- 手臂：粗石臂，大石肩甲（青铜包边），肘箍，两道青铜护腕；拳头是一整块巨石，指节上三颗随元素变色的符石 ---
      for (const s of [1, -1]) {
        const U = s > 0 ? 'uaL' : 'uaR', F = s > 0 ? 'faL' : 'faR', H = s > 0 ? 'hL' : 'hR';
        b.at(U).surf(SURF.stone, true).limb([STONE_D, STONE], s * 0.86, 2.6, 0, s * 1.0, 1.95, 0.04, 0.26, 0.21, 7, 3);
        b.p(gDome(0.42, 8, 3, 1.35), [STONE_D, STONE_L], s * 0.97, 2.72, 0, 0, 0, -s * 0.45, 1.1, 0.75, 1.0);
        b.surf(SURF.gold).p(gTorus(0.405, 0.04, 4, 16), BRONZE, s * 1.0, 2.785, 0, -HALF_PI, s * 0.45, 0, 1.1, 1.0, 1);
        b.p(gTorus(0.215, 0.035, 4, 12), BRONZE, s * 1.0, 1.95, 0.04, HALF_PI, 0, 0);
        b.at(F).surf(SURF.stone, true).limb([STONE, STONE_D], s * 1.0, 1.95, 0.04, s * 1.06, 1.38, 0.1, 0.21, 0.26, 7, 0);
        b.surf(SURF.gold, true).p(gCyl(0.27, 0.28, 0.1, 8), [BRONZE_D, BRONZE], s * 1.05, 1.5, 0.09).p(gCyl(0.25, 0.26, 0.07, 8), BRONZE, s * 1.03, 1.72, 0.07);
        b.at(H).surf(SURF.stone, true).p(gIco(0.34, 0), [STONE_D, STONE], s * 1.08, 1.12, 0.12, 0.3, s * 0.4, 0.15, 1.0, 1.05, 1.12);
        for (let k = -1; k <= 1; k++) b.x(gOct(0.055), 1, s * 1.08 + k * 0.14, 1.0 - Math.abs(k) * 0.03, 0.47, 0, 0, 0, 1, 1.3, 0.7);
      }

      // --- 腿：石腿，青铜护膝，粗胫甲上一道青铜箍，方石脚 + 青铜包头 ---
      for (const s of [1, -1]) {
        const TH = s > 0 ? 'thL' : 'thR', SH = s > 0 ? 'shL' : 'shR', FT = s > 0 ? 'ftL' : 'ftR';
        b.at(TH).surf(SURF.stone, true).limb([STONE_D, STONE], s * 0.36, 1.42, 0, s * 0.4, 0.82, 0.04, 0.27, 0.23, 7, 0);
        b.surf(SURF.gold, true).p(gDome(0.2, 7, 2, 1.3), BRONZE, s * 0.4, 0.84, 0.14, HALF_PI - 0.25, 0, 0, 1, 0.9, 1.1);
        b.at(SH).surf(SURF.stone, true).p(gLathe('cl/shin', [[0.2, 0.18], [0.26, 0.4], [0.28, 0.62], [0.22, 0.82]], 8), [STONE_D, STONE], s * 0.4, 0, 0.03);
        b.surf(SURF.gold, true).p(gCyl(0.285, 0.29, 0.08, 8), BRONZE, s * 0.4, 0.5, 0.03);
        b.at(FT).surf(SURF.stone, true).p(gRBox(0.4, 0.24, 0.62, 0.06), [STONE_D, STONE], s * 0.4, 0.12, 0.1);
        b.surf(SURF.gold, true).p(gRBox(0.42, 0.1, 0.12, 0.03), BRONZE_D, s * 0.4, 0.07, 0.38);
      }

      const rig = b.build({ height: 3.1, reach: 2.6, stride: 1.55, shade: 0.3 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.22;
      sock(rig, 'weapon', 'hR', 0, -0.26, 0.05);
      sock(rig, 'hand', 'hL', 0, -0.26, 0.05);
      sock(rig, 'handL', 'hL', 0, -0.26, 0.05);
      sock(rig, 'head', 'head', 0, 0.3, 0.05);
      sock(rig, 'chest', 'chest', 0, 0.58, 0.66);
      rig.post = minionPost;
      rig.late = minionLate;
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, s = Math.sin(ent.walk), c = Math.cos(ent.walk), id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 3.2) * mv, br = Math.sin(t * 1.1 + ent.phase), br2 = Math.sin(t * 0.5 + ent.phase * 1.3);
        p[J.root] = 0.05 * run;
        p[J.root + 1] = -0.12 * s * run;
        p[J.root + 2] = 0.07 * s * run;
        p[J.chest] = 0.05 + 0.06 * run + 0.02 * br;
        p[J.chest + 1] = 0.14 * s * run;
        p[J.chest + 2] = -0.05 * s * run;
        p[J.chest + 6] = p[J.chest + 8] = 1 + 0.015 * br;
        p[J.head] = -0.06 + 0.03 * br - 0.04 * run;
        p[J.head + 1] = 0.22 * br2 * id - 0.1 * s * run;
        // 拳头垂在膝旁，走起来一前一后地甩
        p[J.uaL] = 0.04 + 0.32 * s * run + 0.025 * br;
        p[J.uaR] = 0.04 - 0.32 * s * run + 0.025 * br;
        p[J.uaL + 2] = 0.1 + 0.02 * br;
        p[J.uaR + 2] = -0.1 - 0.02 * br;
        p[J.faL] = -0.22 - 0.12 * s * run;
        p[J.faR] = -0.22 + 0.12 * s * run;
        p[J.thL] = p[J.thR] = -0.06;
        p[J.shL] = p[J.shR] = 0.12;
        p[J.thL + 2] = 0.04;
        p[J.thR + 2] = -0.04;
        legCycle(p, J.thL, J.shL, J.ftL, s, c, run, 0.45, 0.75);
        legCycle(p, J.thR, J.shR, J.ftR, -s, -c, run, 0.45, 0.75);
        p[J.tab] = -0.04 - 0.28 * Math.abs(s) * run + 0.03 * br;
        p[J.tab2] = 0.03 + 0.15 * run * Math.abs(c) + 0.04 * br2;
      };
      colossusClips(rig);
      return rig;
    });
  }
  function colossusClips(rig) {
    locoClips(rig);
    const LEGS = ['thL', 'shL', 'ftL', 'thR', 'shR', 'ftR'];
    // 升起：身躯从地里升上来，两只拳头先后飞回腕上，最后头颅落到肩上，誓印「轰」地点亮
    defClip(rig, 'rise', {
      dur: 1.0, base: 'rest', air: true, fade: 0, out: 0.2,
      keys: {
        'root.oy': [0, -2.7, 0.45, -1.1, -0.66, -0.12, 0.8, 0.04, 1, 0],
        'root.rx': [0, 0.3, 0.55, 0.12, 0.8, -0.05, 1, 0],
        'root.rz': [0, -0.12, 0.5, 0.06, 1, 0],
        'chest.rx': [0, 0.35, 0.6, 0.15, -0.8, -0.12, 1, 0.05],
        'chest.s': [0, 0.9, 0.7, 0.95, -0.8, 1.04, 0.9, 0.99, 1, 1],
        'head.oy': [0, -0.6, 0.55, -0.2, 0.68, 0.22, -0.8, -0.08, 0.9, 0.03, 1, 0],
        'head.ry': [0, 1.8, 0.6, 0.6, 0.8, 0, 1, 0],
        'head.s': [0, 0.01, 0.5, 0.01, 0.62, 0.8, -0.8, 1.06, 0.9, 0.99, 1, 1],
        'uaL.rz': [0, 0.9, 0.5, 0.55, 0.75, 0.15, 1, 0.1],
        'uaR.rz': [0, -0.7, 0.5, -0.6, 0.75, -0.15, 1, -0.1],
        'uaL.rx': [0, -0.6, 0.5, -0.4, 0.8, 0.1, 1, 0.04],
        'uaR.rx': [0, -0.3, 0.5, -0.5, 0.8, 0.1, 1, 0.04],
        'faL.rx': [0, -0.6, 0.6, -0.5, 1, -0.22],
        'faR.rx': [0, -0.4, 0.6, -0.6, 1, -0.22],
        'hL.oy': [0, -0.9, 0.35, -0.7, -0.62, 0, 1, 0],
        'hL.s': [0, 0.3, 0.4, 0.6, -0.62, 1.12, 0.75, 0.97, 1, 1],
        'hR.oy': [0, -0.9, 0.45, -0.75, -0.7, 0, 1, 0],
        'hR.s': [0, 0.3, 0.5, 0.6, -0.7, 1.12, 0.82, 0.97, 1, 1],
        'thL.rx': [0, -0.3, 0.6, -0.4, 0.85, -0.06, 1, -0.06],
        'shL.rx': [0, 0.5, 0.6, 0.6, 0.85, 0.12, 1, 0.12],
        'thR.rx': [0, 0.1, 0.7, -0.1, 1, -0.06],
        'shR.rx': [0, 0.2, 0.7, 0.3, 1, 0.12],
        'tab.rx': [0, 0.5, 0.7, -0.3, 1, -0.04],
        'tab2.rx': [0, 0.4, 0.7, -0.2, 1, 0.03],
      },
    });
    // 双拳砸地：后仰把两只拳头并举过头，屈膝把全身的分量夯进面前的地里，顿一下再起身
    defClip(rig, 'attack', {
      dur: 0.9, k0: 0.55, lower: LEGS, fade: 0.08, out: 0.3,
      keys: {
        'root.rx': [0, 0.05, 0.4, -0.18, -0.55, 0.38, 0.78, 0.34, 1, 0.05],
        'root.oz': [0, 0, 0.4, -0.12, -0.55, 0.26, 0.78, 0.22, 1, 0],
        'chest.rx': [0, 0.05, 0.4, -0.38, -0.55, 0.58, 0.78, 0.52, 1, 0.05],
        'head.rx': [0, -0.06, 0.4, -0.3, -0.55, 0.05, 1, -0.06],
        'uaL.rx': [0, 0.04, 0.4, -2.95, -0.55, -1.2, 0.78, -1.08, 1, 0.04],
        'uaL.rz': [0, 0.1, 0.4, -0.3, -0.55, -0.15, 0.78, -0.1, 1, 0.1],
        'faL.rx': [0, -0.22, 0.4, -0.75, -0.55, -0.12, 0.78, -0.18, 1, -0.22],
        'uaR.rx': [0, 0.04, 0.4, -2.95, -0.55, -1.2, 0.78, -1.08, 1, 0.04],
        'uaR.rz': [0, -0.1, 0.4, 0.3, -0.55, 0.15, 0.78, 0.1, 1, -0.1],
        'faR.rx': [0, -0.22, 0.4, -0.75, -0.55, -0.12, 0.78, -0.18, 1, -0.22],
        'thL.rx': [0, -0.06, 0.4, -0.3, -0.55, -0.95, 0.78, -0.9, 1, -0.06],
        'shL.rx': [0, 0.12, 0.4, 0.45, -0.55, 1.15, 0.78, 1.1, 1, 0.12],
        'thR.rx': [0, -0.06, 0.4, 0.12, -0.55, -0.62, 0.78, -0.58, 1, -0.06],
        'shR.rx': [0, 0.12, 0.4, 0.3, -0.55, 1.05, 0.78, 1.0, 1, 0.12],
        'tab.rx': [0, -0.04, 0.4, 0.25, -0.55, -0.7, 1, -0.04],
        'tab2.rx': [0, 0.03, 0.4, 0.2, -0.6, -0.5, 1, 0.03],
      },
    });
    // 嘲讽：左右拳各捶一下胸，然后两臂一张、仰头怒吼（k0 = 吼出来的那一刻）
    defClip(rig, 'taunt', {
      dur: 0.8, k0: 0.6, lower: LEGS, fade: 0.08, out: 0.25,
      keys: {
        'uaL.rx': [0, 0.04, 0.1, -0.85, -0.16, -0.7, 0.28, -0.8, 0.46, -0.5, -0.6, -0.3, 0.88, -0.35, 1, 0.04],
        'uaL.ry': [0, 0, 0.1, -0.9, 0.28, -0.9, 0.5, 0, 1, 0],
        'uaL.rz': [0, 0.1, 0.1, -0.05, -0.16, -0.15, 0.28, -0.05, -0.6, 1.25, 0.88, 1.2, 1, 0.1],
        'faL.rx': [0, -0.22, 0.1, -1.7, -0.16, -2.0, 0.28, -1.6, 0.6, -0.35, 1, -0.22],
        'uaR.rx': [0, 0.04, 0.2, -0.5, 0.27, -0.85, -0.34, -0.7, 0.46, -0.75, -0.6, -0.3, 0.88, -0.35, 1, 0.04],
        'uaR.ry': [0, 0, 0.2, 0.5, 0.27, 0.9, 0.46, 0.9, 0.56, 0, 1, 0],
        'uaR.rz': [0, -0.1, 0.27, 0.05, -0.34, 0.15, 0.46, 0.05, -0.6, -1.25, 0.88, -1.2, 1, -0.1],
        'faR.rx': [0, -0.22, 0.27, -1.7, -0.34, -2.0, 0.46, -1.6, 0.6, -0.35, 1, -0.22],
        'chest.rx': [0, 0.05, 0.16, 0.16, 0.34, 0.16, -0.6, -0.42, 0.88, -0.38, 1, 0.05],
        'chest.ry': [0, 0, 0.16, 0.16, 0.34, -0.16, 0.55, 0, 1, 0],
        'head.rx': [0, -0.06, 0.45, 0.15, -0.6, -0.6, 0.88, -0.52, 1, -0.06],
        'root.rx': [0, 0, 0.45, 0.08, -0.6, -0.12, 0.88, -0.1, 1, 0],
        'thL.rx': [0, -0.06, 0.5, -0.25, 0.9, -0.22, 1, -0.06],
        'shL.rx': [0, 0.12, 0.5, 0.4, 0.9, 0.36, 1, 0.12],
        'thR.rx': [0, -0.06, 0.5, -0.15, 0.9, -0.12, 1, -0.06],
        'shR.rx': [0, 0.12, 0.5, 0.35, 0.9, 0.3, 1, 0.12],
        'thL.rz': [0, 0.04, 0.5, 0.16, 0.9, 0.16, 1, 0.04],
        'thR.rz': [0, -0.04, 0.5, -0.16, 0.9, -0.16, 1, -0.04],
        'tab.rx': [0, -0.04, 0.6, 0.3, 1, -0.04],
      },
    });
    // 崩塌：晃两下跪倒，往前扑在拳头上，最后头颅从肩上歪落
    defClip(rig, 'death', {
      dur: 1.2, base: 'rest', hold: true, air: true, fade: 0.06,
      clear: [['head', 0, 0.25, 0.1, 0.28], ['chest', 0, 0.55, 0.3, 0.5], ['root', 0, 0, 0, 0.4], ['shL', 0, 0, 0.1, 0.2], ['shR', 0, 0, 0.1, 0.2], ['hL', 0, -0.26, 0.05, 0.32], ['hR', 0, -0.26, 0.05, 0.32]],
      keys: {
        'root.oy': [0, 0, 0.2, -0.05, -0.42, -0.72, 0.6, -0.7, -0.86, -1.05, 1, -1.08],
        'root.rx': [0, -0.08, 0.2, -0.18, 0.42, 0.04, 0.6, 0.1, -0.86, 0.85, 1, 0.9],
        'root.rz': [0, 0, 0.15, 0.08, 0.3, -0.06, 0.6, 0.04, 1, 0.08],
        'chest.rx': [0, -0.1, 0.2, -0.28, 0.42, 0.3, -0.86, 0.42, 1, 0.38],
        'chest.rz': [0, 0, 0.15, -0.08, 0.3, 0.06, 1, 0.04],
        'head.rx': [0, -0.25, 0.42, 0.3, 0.86, 0.45, 1, 0.6],
        'head.rz': [0, 0, 0.86, 0.15, 1, 0.5],
        'head.oy': [0, 0, 0.86, 0, 1, -0.14],
        'head.ox': [0, 0, 0.86, 0, 1, 0.12],
        'uaL.rx': [0, 0, 0.2, -0.45, 0.42, -0.3, -0.86, -1.55, 1, -1.65],
        'uaL.rz': [0, 0.1, 0.42, 0.3, 1, 0.22],
        'faL.rx': [0, -0.22, 0.86, -0.1, 1, -0.05],
        'uaR.rx': [0, 0, 0.2, -0.3, 0.42, -0.2, -0.86, -1.5, 1, -1.6],
        'uaR.rz': [0, -0.1, 0.42, -0.35, 1, -0.25],
        'faR.rx': [0, -0.22, 0.86, -0.15, 1, -0.08],
        'thL.rx': [0, 0, 0.2, -0.1, -0.42, -1.55, 0.6, -1.5, 1, -1.4],
        'shL.rx': [0, 0, 0.2, 0.2, -0.42, 1.65, 1, 1.75],
        'thR.rx': [0, 0, 0.2, 0.1, -0.42, -1.45, 1, -1.3],
        'shR.rx': [0, 0, -0.42, 1.55, 1, 1.65],
        'tab.rx': [0, 0, 0.42, 0.5, 0.86, -0.6, 1, -0.5],
        'tab2.rx': [0, 0, 0.5, 0.4, 1, 0.3],
      },
    });
  }

  const MINION_RIG = { thrall: thrallRig, colossus: colossusRig };
  const MINION_RING_R = { thrall: 0.82, colossus: 1.6 };
  // 召唤物实体。kind：'thrall' | 'colossus'。elemHex（可选）：剑刃血槽 / 拳上符石这些点缀的颜色，
  // 默认魂火青；魂火（眼、胸腔、誓印）、脚环与血条永远是魂火青。之后可用 W.minionElem 改点缀色。
  W.makeMinion = function (kind, elemHex) {
    const k = MINION_RIG[kind] ? kind : 'thrall';
    const ent = newEnt(k, MINION_RIG[k](), WH, ALLY_HEX, k === 'colossus' ? 1.3 : 1.2);
    ent.ally = true;
    ent.fxPrev = -1;
    ent.fxClip = null;
    ent.uRim.value.setRGB(0.05, 0.24, 0.19);
    {
      const sm = new T.MeshBasicMaterial({ map: allyShadeTex(), color: lin(0x02100d), transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false });
      ent.own.push(sm);
      const sq = new T.Mesh(gQuad(), sm);
      sq.position.y = 0.05;
      sq.scale.set(MINION_RING_R[k] * 1.04, 1, MINION_RING_R[k] * 1.04);
      sq.renderOrder = 1;
      ent.group.add(sq);
      ent.ringShade = sq;
    }
    ent.ring = groundDisc(ent, allyRingTex(), ALLY_HEX, MINION_RING_R[k], 0.95);
    W.minionElem(ent, elemHex);
    return ent;
  };
  // 召唤物挡在镜头和玩家之间时，把它的身体打成一格一格的镂空（借死亡消散的离散方格，只是不发光），
  // 透过去能看见玩家。on：这一帧是否挡着；dt 用来平滑淡入淡出。正在倒下的不管
  W.allyOcclude = function (ent, on, dt) {
    if (!ent || ent.removed || ent.dying) return;
    const k0 = ent.occK || 0;
    const k = on ? Math.min(1, k0 + dt * 6) : Math.max(0, k0 - dt * 4);
    if (k === k0) return;
    ent.occK = k;
    ent.uDis.value.set(0, 0, 0, 0.72 * k);
  };
  W.minionElem = function (ent, hex) {
    if (!ent || ent.removed || !ent.auxMat) return;
    const m = ent.auxMat;
    m.userData.e0.set(hex === undefined || hex === null ? ALLY_HEX : hexOf(hex)).convertSRGBToLinear();
    m.userData.ei0 = 1.25;
    if (ent.flashT <= 0) {
      m.emissive.copy(m.userData.e0);
      m.emissiveIntensity = m.userData.ei0;
    }
  };

  // ---------- 预热 ----------
  // 每种骨架、每种掉落物模型各建一个，实打实渲染一帧：着色器在开场就编译好（之后刷怪不卡顿），
  // 共享几何体也全部上传完毕。留着这批材质不释放，着色器程序就不会在最后一只怪死掉时被回收。
  const keepers = [];
  function warmEntities() {
    const made = [makePlayerEnt()];
    for (const t in MOB_RIG) {
      if (!MOB_RIG[t]().clips.broken) aliasClip(MOB_RIG[t](), 'broken', 'stagger');
      made.push(W.makeMob(t, 0xff8a3c, false));
    }
    for (const k in BOSS_RIG) made.push(W.makeBoss(k, 0xff8a3c));
    for (const k in MINION_RIG) made.push(W.makeMinion(k));
    made.forEach((e, i) => e.group.position.set(((i % 3) - 1) * 5, 0, -Math.floor(i / 3) * 4));
    const loots = [];
    for (const s of G.SLOTS) loots.push(W.makeLoot('item', 0xffffff, s === 'weapon', 0, 2, s));
    for (let i = 1; i < 3; i++) loots.push(W.makeLoot('item', 0xffffff, false, 0, 2, { slot: 'weapon', baseIdx: i }));
    for (const k of ['item', 'cur', 'skill', 'blank', 'support']) loots.push(W.makeLoot(k, 0xffffff, false, 0, 2));
    allyFxVisible(true); // 召唤法阵 / 聚焦标记平时是隐藏的：预热这一帧让它们露个面，着色器一并编译
    const rt = new T.WebGLRenderTarget(64, 64);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    rt.dispose();
    allyFxVisible(false);
    for (const l of loots) W.removeMesh(l);
    for (const e of made) {
      scene.remove(e.group);
      e.removed = true;
      keepers.push(e);
    }
  }

  // ---------- 掉落物模型：一眼能认出是什么 ----------
  const LC = { steel: 0xaab2c0, steelD: 0x5a6274, gold: 0xe0b24a, leather: 0x7a5638, leatherD: 0x4a3324, wood: 0x6b4a32, bone: 0xd9cfb6, dark: 0x23252e };
  // 每种模型两份几何体：body（顶点色的实体）+ glow（按稀有度 / 通货颜色发光的点缀）
  const LOOT_MODEL = {
    blade: () => [
      bake('lt/blade', [[gPlate('lt/bl', [[-0.05, 0], [0.05, 0], [0.06, 0.42], [0, 0.6], [-0.06, 0.42]], 0.016, 0.012), LC.steel, 0, -0.12, 0], [gBox(0.26, 0.05, 0.06), LC.gold, 0, -0.13, 0], [gCyl(0.025, 0.028, 0.18, 6), LC.leatherD, 0, -0.24, 0], [gIco(0.04, 0), LC.gold, 0, -0.35, 0]]),
      bake('lt/bladeG', [[gBox(0.03, 0.4, 0.05), WH, 0, 0.1, 0]]),
    ],
    staff: () => [
      bake('lt/staff', [[gCyl(0.025, 0.032, 0.82, 6), LC.wood, 0, -0.08, 0], [gCyl(0.045, 0.045, 0.05, 6), LC.gold, 0, 0.28, 0], [gTorus(0.1, 0.022, 4, 10, 4.4), LC.gold, 0, 0.4, 0, 0, 0, 2.5]]),
      bake('lt/staffG', [[gOct(0.07), WH, 0, 0.41, 0, 0, 0, 0, 0.8, 1.3, 0.8]]),
    ],
    wand: () => [
      bake('lt/wand', [[gCyl(0.02, 0.032, 0.5, 6), LC.bone, 0, -0.1, 0], [gIco(0.04, 0), LC.bone, 0, -0.36, 0], [gCone(0.03, 0.14, 4), LC.bone, 0.06, 0.2, 0, 0, 0, -0.4], [gCone(0.03, 0.14, 4), LC.bone, -0.06, 0.2, 0, 0, 0, 0.4]]),
      bake('lt/wandG', [[gOct(0.06), WH, 0, 0.24, 0, 0, 0, 0, 0.8, 1.4, 0.8]]),
    ],
    helm: () => [
      bake('lt/helm', [[gDome(0.22, 8, 4, 1.7), LC.steel, 0, -0.04, 0], [gBox(0.05, 0.2, 0.05), LC.steelD, 0, -0.1, 0.2], [gBox(0.04, 0.05, 0.4), LC.gold, 0, 0.19, 0], [gTorus(0.215, 0.025, 4, 12), LC.gold, 0, -0.06, 0, Math.PI / 2]]),
      bake('lt/helmG', [[gBox(0.09, 0.03, 0.03), WH, 0.08, -0.02, 0.2], [gBox(0.09, 0.03, 0.03), WH, -0.08, -0.02, 0.2]]),
    ],
    body: () => [
      bake('lt/body', [[gLathe('lt/cuirass', [[0.14, -0.24], [0.2, -0.08], [0.24, 0.1], [0.16, 0.22], [0.09, 0.26]], 8), LC.steel, 0, 0, 0, 0, 0, 0, 1, 1, 0.75], [gDome(0.1, 6, 3, 1.5), LC.steelD, 0.24, 0.14, 0, 0, 0, -0.6], [gDome(0.1, 6, 3, 1.5), LC.steelD, -0.24, 0.14, 0, 0, 0, 0.6], [gTorus(0.15, 0.022, 4, 10), LC.gold, 0, -0.22, 0, Math.PI / 2, 0, 0, 1, 0.75, 1]]),
      bake('lt/bodyG', [[gOct(0.05), WH, 0, 0.06, 0.18, 0, 0, 0, 1, 1.4, 0.5]]),
    ],
    gloves: () => [
      bake('lt/glove', [[gCyl(0.11, 0.085, 0.2, 7), LC.leather, 0, -0.16, 0], [gBox(0.2, 0.17, 0.12), LC.steel, 0, 0.03, 0], [gBox(0.17, 0.12, 0.1), LC.steelD, 0, 0.17, 0.02, 0.3], [gBox(0.06, 0.12, 0.07), LC.steelD, 0.13, 0.03, 0.03, 0, 0, -0.5], [gTorus(0.108, 0.02, 4, 10), LC.gold, 0, -0.25, 0, Math.PI / 2]]),
      bake('lt/gloveG', [[gBox(0.17, 0.03, 0.03), WH, 0, 0.1, 0.07]]),
    ],
    boots: () => [
      bake('lt/boot', [[gCyl(0.1, 0.085, 0.28, 7), LC.leather, 0, 0.04, -0.06], [gIco(0.11, 1), LC.leatherD, 0, -0.14, 0.03, 0, 0, 0, 0.95, 0.75, 1.9], [gBox(0.2, 0.04, 0.38), LC.dark, 0, -0.22, 0.03], [gTorus(0.1, 0.02, 4, 10), LC.gold, 0, 0.17, -0.06, Math.PI / 2]]),
      bake('lt/bootG', [[gBox(0.21, 0.03, 0.03), WH, 0, 0.02, 0.03]]),
    ],
    belt: () => [
      bake('lt/belt', [[gTorus(0.2, 0.045, 4, 14), LC.leather, 0, 0, 0, Math.PI / 2, 0, 0, 1, 0.8, 1.6], [gBox(0.13, 0.13, 0.05), LC.gold, 0, 0, 0.17]]),
      bake('lt/beltG', [[gOct(0.04), WH, 0, 0, 0.21]]),
    ],
    ring: () => [
      bake('lt/ring', [[gTorus(0.14, 0.035, 5, 14), LC.gold, 0, -0.03, 0], [gCyl(0.05, 0.035, 0.05, 6), LC.gold, 0, 0.13, 0]]),
      bake('lt/ringG', [[gOct(0.065), WH, 0, 0.19, 0]]),
    ],
    amulet: () => [
      bake('lt/amulet', [[gTorus(0.17, 0.014, 4, 16), LC.gold, 0, 0.1, 0, 0, 0, 0, 1, 1.15, 1], [gCyl(0.085, 0.085, 0.03, 6), LC.gold, 0, -0.14, 0, Math.PI / 2]]),
      bake('lt/amuletG', [[gOct(0.065), WH, 0, -0.14, 0, 0, 0, 0, 1, 1.2, 0.6]]),
    ],
    item: () => [
      bake('lt/sack', [[gIco(0.2, 1), LC.leather, 0, -0.06, 0, 0, 0, 0, 1, 0.9, 1], [gCyl(0.07, 0.11, 0.1, 6), LC.leatherD, 0, 0.14, 0], [gTorus(0.085, 0.02, 4, 8), LC.gold, 0, 0.11, 0, Math.PI / 2]]),
      bake('lt/sackG', [[gOct(0.045), WH, 0, -0.04, 0.2]]),
    ],
    // 通货：一簇碎晶；技能宝石：竖长的六棱晶柱套着金箍；辅助宝石：扁圆的切面宝石嵌在金环里
    cur: () => [null, bake('lt/cur', [[gOct(0.17), WH, 0, 0.02, 0, 0, 0.4, 0, 0.7, 1.25, 0.7], [gOct(0.1), WH, 0.14, -0.08, 0.04, 0, 0, -0.5, 0.7, 1.2, 0.7], [gOct(0.09), WH, -0.12, -0.1, -0.05, 0.3, 0, 0.5, 0.7, 1.2, 0.7]])],
    skill: () => [
      bake('lt/skill', [[gTorus(0.15, 0.028, 4, 6), LC.gold, 0, 0, 0, Math.PI / 2], [gTorus(0.1, 0.022, 4, 6), LC.gold, 0, -0.22, 0, Math.PI / 2]]),
      bake('lt/skillG', [[gCyl(0.13, 0.13, 0.3, 6), WH, 0, 0, 0], [gCone(0.13, 0.2, 6), WH, 0, 0.25, 0], [gCone(0.13, 0.14, 6), WH, 0, -0.22, 0, Math.PI]]),
    ],
    // 无铭技能宝石：同一根晶柱，箍换成素银（晶体颜色由调用方给中性的银白）
    blank: () => [
      bake('lt/blank', [[gTorus(0.15, 0.028, 4, 6), LC.steel, 0, 0, 0, Math.PI / 2], [gTorus(0.1, 0.022, 4, 6), LC.steel, 0, -0.22, 0, Math.PI / 2]]),
      LOOT_MODEL.skill()[1],
    ],
    support: () => [
      bake('lt/sup', [[gTorus(0.2, 0.03, 4, 12), LC.gold, 0, 0, 0, Math.PI / 2], [gCone(0.04, 0.09, 4), LC.gold, 0.22, 0, 0, 0, 0, -Math.PI / 2], [gCone(0.04, 0.09, 4), LC.gold, -0.22, 0, 0, 0, 0, Math.PI / 2]]),
      bake('lt/supG', [[gIco(0.16, 0), WH, 0, 0, 0, 0, 0, 0, 1, 0.7, 1]]),
    ],
  };
  const lootModels = Object.create(null);
  const WEAPON_MODEL = ['blade', 'staff', 'wand'];
  let lootBody = null;

  // kind：item | cur | skill | blank（无铭技能宝石）| support。slot（可选，只对 item 有意义）：装备栏位名，或物品对象本身
  // （{ slot, baseIdx }，武器靠 baseIdx 区分 刃 / 长杖 / 短杖）。不传时是一只通用的小包裹。
  W.makeLoot = function (kind, hex, beam, x, z, slot) {
    const h = hexOf(hex);
    let key = kind;
    if (kind === 'item') {
      const sl = slot && typeof slot === 'object' ? slot.slot : slot;
      if (sl === 'weapon') key = WEAPON_MODEL[slot && typeof slot === 'object' ? G.clamp(slot.baseIdx | 0, 0, 2) : 0];
      else if (sl && LOOT_MODEL[sl]) key = sl;
    }
    if (!LOOT_MODEL[key]) key = 'item';
    const mdl = lootModels[key] || (lootModels[key] = LOOT_MODEL[key]());
    if (!lootBody) lootBody = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.45, envMap: rigEnvMap(), envMapIntensity: 0.9, flatShading: true });
    const grp = new T.Group();
    grp.position.set(x, 0, z);
    const gem = new T.Group();
    gem.position.y = 0.55;
    gem.scale.setScalar(1.3);
    if (key === 'blade' || key === 'staff' || key === 'wand') gem.rotation.z = 0.5; // 武器斜着悬在空中
    else if (key === 'ring' || key === 'amulet' || key === 'belt') gem.rotation.x = 0.35;
    if (mdl[0]) {
      const m = new T.Mesh(mdl[0], lootBody);
      m.castShadow = true;
      gem.add(m);
    }
    const g2 = new T.Mesh(mdl[1], lootMat(h));
    g2.castShadow = !mdl[0];
    gem.add(g2);
    grp.add(gem);
    const disc = new T.Mesh(gQuad(), discMat(h));
    disc.position.y = 0.05;
    disc.scale.set(beam ? 1.5 : 0.85, 1, beam ? 1.5 : 0.85);
    disc.renderOrder = 2;
    grp.add(disc);
    if (beam) {
      const bm = new T.Mesh(geo('beamCyl', () => new T.CylinderGeometry(0.05, 0.13, 6.5, 8, 1, true).translate(0, 3.25, 0)), beamMat(h));
      bm.renderOrder = 5;
      grp.add(bm);
      const sp = new T.Sprite(spriteMat(h));
      sp.position.y = 0.6;
      sp.scale.setScalar(1.4);
      grp.add(sp);
    }
    const u = grp.userData;
    u.kind = 'loot';
    u.gem = gem;
    u.t = 0;
    u.spin = rand(1.4, 2.2);
    u.ph = rand(0, TAU);
    grp.scale.setScalar(0.01);
    scene.add(grp);
    lootObjs.push(grp);
    return grp;
  };

  // ---------- 粒子：一个 Points，环形缓冲 ----------
  const PN = 2600;
  const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3), pSize = new Float32Array(PN);
  const pVel = new Float32Array(PN * 3), pBase = new Float32Array(PN * 3);
  const pLife = new Float32Array(PN), pMax = new Float32Array(PN), pSz = new Float32Array(PN);
  const pGrav = new Float32Array(PN), pDrag = new Float32Array(PN);
  let pNext = 0, pGeo = null, pMat = null;

  function initParticles() {
    for (let i = 0; i < PN; i++) pPos[i * 3 + 1] = -999;
    pGeo = new T.BufferGeometry();
    pGeo.setAttribute('position', new T.BufferAttribute(pPos, 3).setUsage(T.DynamicDrawUsage));
    pGeo.setAttribute('aColor', new T.BufferAttribute(pCol, 3).setUsage(T.DynamicDrawUsage));
    pGeo.setAttribute('aSize', new T.BufferAttribute(pSize, 1).setUsage(T.DynamicDrawUsage));
    pMat = new T.ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader:
        'attribute vec3 aColor; attribute float aSize; uniform float uScale; varying vec3 vC;\n' +
        'void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
        ' gl_PointSize = aSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }',
      fragmentShader:
        'varying vec3 vC;\n' +
        'void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.08, d);\n' +
        ' gl_FragColor = vec4(vC * a, 1.0); }',
      blending: T.AdditiveBlending, transparent: true, depthWrite: false,
    });
    const pts = new T.Points(pGeo, pMat);
    pts.frustumCulled = false;
    pts.renderOrder = 6;
    scene.add(pts);
  }
  // grav > 0 下坠，< 0 上浮；drag 为每秒速度衰减
  function spawnP(x, y, z, vx, vy, vz, life, size, r, g, b, grav, drag) {
    const i = pNext, j = i * 3;
    pNext = (pNext + 1) % PN;
    pPos[j] = x; pPos[j + 1] = y; pPos[j + 2] = z;
    pVel[j] = vx; pVel[j + 1] = vy; pVel[j + 2] = vz;
    pBase[j] = r; pBase[j + 1] = g; pBase[j + 2] = b;
    pLife[i] = pMax[i] = life;
    pSz[i] = size;
    pGrav[i] = grav;
    pDrag[i] = drag;
  }
  function updateParticles(dt) {
    for (let i = 0, j = 0; i < PN; i++, j += 3) {
      let l = pLife[i];
      if (l <= 0) continue;
      l -= dt;
      if (l <= 0) {
        pLife[i] = 0;
        pSize[i] = 0;
        pPos[j + 1] = -999;
        continue;
      }
      pLife[i] = l;
      const dr = Math.max(0, 1 - pDrag[i] * dt);
      let vy = (pVel[j + 1] - pGrav[i] * dt) * dr;
      pVel[j] *= dr;
      pVel[j + 2] *= dr;
      let y = pPos[j + 1] + vy * dt;
      if (y < 0.05 && vy < 0) {
        y = 0.05;
        vy = -vy * 0.3;
        pVel[j] *= 0.6;
        pVel[j + 2] *= 0.6;
      }
      pVel[j + 1] = vy;
      pPos[j] += pVel[j] * dt;
      pPos[j + 1] = y;
      pPos[j + 2] += pVel[j + 2] * dt;
      const f = l / pMax[i];
      // 出生时快速淡入，后半段淡出
      const a = Math.min(1, f * 2, (1 - f) * 10 + 0.15);
      pCol[j] = pBase[j] * a;
      pCol[j + 1] = pBase[j + 1] * a;
      pCol[j + 2] = pBase[j + 2] * a;
      pSize[i] = pSz[i] * (0.45 + 0.55 * f);
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.aColor.needsUpdate = true;
    pGeo.attributes.aSize.needsUpdate = true;
  }

  function flashLight(x, y, z, hex, intensity) {
    if (intensity < fxLight.intensity) return;
    fxLight.position.set(x, y, z);
    fxLight.color.set(hex);
    fxLight.intensity = intensity;
  }

  W.burst = function (x, y, z, hex, count, speed, life) {
    _c.set(hex);
    const r = _c.r, g = _c.g, b = _c.b;
    for (let i = 0; i < count; i++) {
      // 球面随机方向，略微偏上
      const a = Math.random() * TAU, u = Math.random() * 1.6 - 0.6, h = Math.sqrt(Math.max(0, 1 - u * u));
      const sp = speed * (0.3 + Math.random() * 0.7);
      const w = Math.random() < 0.25 ? 0.5 : 0; // 少量偏白的亮点
      spawnP(x, y, z, Math.sin(a) * h * sp, u * sp + speed * 0.25, Math.cos(a) * h * sp, life * (0.55 + Math.random() * 0.45), 0.16 + Math.random() * 0.2 + speed * 0.012,
        r + (1 - r) * w, g + (1 - g) * w, b + (1 - b) * w, 9, 1.6);
    }
    if (count >= 20) flashLight(x, Math.max(1.5, y + 1), z, hex, Math.min(2.4, count * 0.05));
  };

  // ---------- 打击感：贴地痕迹 / 命中闪光 / 命中火花 / 刀光（全部预先建好，运行时不再分配） ----------
  const DECAL_FRAG = [
    'uniform vec3 uColor; uniform float uK; uniform float uKind; uniform float uSeed; varying vec2 vP;',
    'float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed * 17.3) * 43758.5453); }',
    'float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'void main(){',
    '  float l = length(vP);',
    '  float fade = 1.0 - smoothstep(0.55, 1.0, uK);', // 后半段淡出
    '  float n = vn(vP * 3.0 + 5.0) * 0.6 + vn(vP * 7.0) * 0.4;',
    '  float an = atan(vP.x, vP.y);',
    '  vec3 col = uColor; float a = 0.0;',
    '  if (uKind < 0.5) {', // 0 擦痕：沿局部 z 的一道亮线，头亮尾细
    '    float wv = 1.0 - abs(vP.x);',
    '    float along = smoothstep(-1.0, -0.2, vP.y) * (1.0 - smoothstep(0.35, 1.0, vP.y));',
    '    a = pow(wv, 4.0) * along * (1.0 - uK) * (1.0 - uK) * 0.6;',
    '    col = mix(uColor, vec3(1.0), pow(wv, 9.0) * 0.6);',
    '  } else if (uKind < 1.5) {', // 1 焦痕：不规则的黑斑，起初边缘还带着余烬
    '    float blot = 1.0 - smoothstep(0.3 + n * 0.3, 0.72 + n * 0.26, l);',
    '    float rim = smoothstep(0.25, 0.6, l) * blot * (1.0 - smoothstep(0.0, 0.6, uK));',
    '    col = mix(vec3(0.02, 0.012, 0.01), uColor, rim * n * 1.1);',
    '    a = blot * 0.8 * fade;',
    '  } else if (uKind < 2.5) {', // 2 霜痕：放射状的冰晶
    '    float sp = pow(abs(cos(an * 4.0 + n * 1.6)), 7.0);',
    '    float body = 1.0 - smoothstep(0.15, 0.95, l);',
    '    a = (body * 0.2 + sp * (1.0 - smoothstep(0.3 + n * 0.5, 1.0, l)) * 0.42) * fade;',
    '    col = mix(uColor, vec3(1.0), sp * 0.5);',
    '  } else if (uKind < 3.5) {', // 3 电痕：枝状的细亮线 + 中心一点焦黑
    '    float br = 1.0 - smoothstep(0.0, 0.1, abs(sin(an * 3.5 + vn(vP * 5.0) * 5.0)));',
    '    float reach = 1.0 - smoothstep(0.35 + n * 0.5, 1.0, l);',
    '    float core = 1.0 - smoothstep(0.0, 0.3, l);',
    '    a = max(br * reach * 0.85 * (1.0 - smoothstep(0.2, 0.9, uK)), core * 0.6 * fade);',
    '    col = mix(vec3(0.03, 0.03, 0.02), uColor, br * reach);',
    '  } else if (uKind < 4.5) {', // 4 灰迹：一摊尘土
    '    float blot = 1.0 - smoothstep(0.25 + n * 0.3, 0.8 + n * 0.2, l);',
    '    col = mix(vec3(0.07, 0.06, 0.05), uColor * 0.25, n * 0.5);',
    '    a = blot * 0.55 * fade;',
    '  } else {', // 5 地裂：终结技砸出的放射状裂纹，起初缝里透着光
    '    float cr = 1.0 - smoothstep(0.0, 0.05 + 0.12 * l, abs(sin(an * 4.5 + n * 4.0)));',
    '    float reach = 1.0 - smoothstep(0.45 + n * 0.45, 1.0, l);',
    '    float core = 1.0 - smoothstep(0.0, 0.34, l);',
    '    float hot = 1.0 - smoothstep(0.0, 0.4, uK);',
    '    a = max(cr * reach, core * 0.7) * fade * 0.92;',
    '    col = mix(vec3(0.015, 0.01, 0.008), uColor * 1.4, hot * (cr * reach * 0.9 + core * 0.5));',
    '  }',
    '  if (l > 1.0 && uKind > 0.5) a = 0.0;',
    '  gl_FragColor = vec4(col, a);',
    '}',
  ].join('\n');
  const decals = [], flares = [];
  let decalNext = 0, flareNext = 0;
  const flareTex = () =>
    tex('flare', () => {
      // 四芒星：柔光 + 一长一短两对光芒
      const S = 128, c = makeCanvas(S, S), g = c.getContext('2d'), h = S / 2;
      const gr = g.createRadialGradient(h, h, 0, h, h, h);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.16, 'rgba(255,255,255,0.7)');
      gr.addColorStop(0.42, 'rgba(255,255,255,0.14)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
      g.globalCompositeOperation = 'lighter';
      const spike = (ang, len, wd) => {
        g.save();
        g.translate(h, h);
        g.rotate(ang);
        const lg = g.createLinearGradient(0, 0, len, 0);
        lg.addColorStop(0, 'rgba(255,255,255,0.95)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = lg;
        g.beginPath();
        g.moveTo(0, -wd);
        g.lineTo(len, 0);
        g.lineTo(0, wd);
        g.closePath();
        g.fill();
        g.restore();
      };
      for (let i = 0; i < 4; i++) {
        spike((i * Math.PI) / 2, h * 0.98, 5);
        spike((i * Math.PI) / 2 + Math.PI / 4, h * 0.5, 4);
      }
      return new T.CanvasTexture(c);
    });
  // 刀光：一条跟着武器走的带子。采样点按「绕角色的圆弧」补间，60 帧下的快挥也是顺滑的弧
  const TRAIL_MAX = 56, TRAIL_LIFE = 0.19;
  const trail = {
    ent: null, n: 0, live: 0, mesh: null, color: null,
    p: new Float32Array(TRAIL_MAX * 6), age: new Float32Array(TRAIL_MAX), mute: new Uint8Array(TRAIL_MAX),
    pos: new Float32Array(TRAIL_MAX * 6), al: new Float32Array(TRAIL_MAX * 2),
  };
  function initHitFx() {
    for (let i = 0; i < 40; i++) {
      const mat = new T.ShaderMaterial({
        uniforms: { uColor: { value: new T.Color() }, uK: { value: 0 }, uKind: { value: 0 }, uSeed: { value: 0 } },
        vertexShader: FX_VERT, fragmentShader: DECAL_FRAG, transparent: true, depthWrite: false, side: T.DoubleSide,
      });
      const mesh = new T.Mesh(gQuad(), mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      decals.push({ mesh, u: mat.uniforms, mat, on: false, t: 0, dur: 1 });
    }
    for (let i = 0; i < 14; i++) {
      const mat = new T.SpriteMaterial({ map: flareTex(), color: 0xffffff, transparent: true, blending: T.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false, fog: false });
      const sp = new T.Sprite(mat);
      sp.visible = false;
      sp.renderOrder = 7;
      scene.add(sp);
      flares.push({ sp, mat, on: false, t: 0, dur: 0.1, size: 1 });
    }
    const g = new T.BufferGeometry();
    const idx = new Uint16Array((TRAIL_MAX - 1) * 6), uv = new Float32Array(TRAIL_MAX * 2);
    for (let i = 0; i < TRAIL_MAX - 1; i++) {
      const a = i * 2, o = i * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    for (let i = 0; i < TRAIL_MAX; i++) uv[i * 2 + 1] = 1; // 每对顶点：0 = 靠手的一侧，1 = 刃尖
    g.setAttribute('position', new T.BufferAttribute(trail.pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aA', new T.BufferAttribute(trail.al, 1).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aU', new T.BufferAttribute(uv, 1));
    g.setIndex(new T.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    trail.color = { value: new T.Color(1, 1, 1) };
    const mat = new T.ShaderMaterial({
      uniforms: { uColor: trail.color },
      vertexShader: 'attribute float aA; attribute float aU; varying float vA; varying float vU;\nvoid main(){ vA = aA; vU = aU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; varying float vA; varying float vU;\nvoid main(){ float e = vU * vU; float a = vA * (0.16 + 0.84 * e);\n gl_FragColor = vec4(mix(uColor, vec3(1.0), e * e * 0.7) * a, 1.0); }',
      blending: T.AdditiveBlending, transparent: true, depthWrite: false, side: T.DoubleSide,
    });
    trail.mesh = new T.Mesh(g, mat);
    trail.mesh.frustumCulled = false;
    trail.mesh.renderOrder = 6;
    trail.mesh.visible = false;
    scene.add(trail.mesh);
  }
  function trailAdd(bx, by, bz, tx, ty, tz, age, mute) {
    const tr = trail;
    if (tr.n >= TRAIL_MAX) {
      // 满了：丢掉最老的一个
      tr.p.copyWithin(0, 6, tr.n * 6);
      tr.age.copyWithin(0, 1, tr.n);
      tr.mute.copyWithin(0, 1, tr.n);
      tr.n--;
    }
    const o = tr.n * 6;
    tr.p[o] = bx; tr.p[o + 1] = by; tr.p[o + 2] = bz; tr.p[o + 3] = tx; tr.p[o + 4] = ty; tr.p[o + 5] = tz;
    tr.age[tr.n] = age;
    tr.mute[tr.n] = mute;
    tr.n++;
  }
  function trailPush(ent, bx, by, bz, tx, ty, tz) {
    const tr = trail, cx = ent.group.position.x, cz = ent.group.position.z;
    if (tr.n > 0 && tr.live > 0) {
      // 接着上一帧：在两次采样之间按圆弧补几个点
      const o = (tr.n - 1) * 6, p = tr.p;
      const a0 = Math.atan2(p[o + 3] - cx, p[o + 5] - cz), r0 = Math.hypot(p[o + 3] - cx, p[o + 5] - cz), y0 = p[o + 4];
      const b0 = Math.atan2(p[o] - cx, p[o + 2] - cz), q0 = Math.hypot(p[o] - cx, p[o + 2] - cz), h0 = p[o + 1];
      const r1 = Math.hypot(tx - cx, tz - cz), q1 = Math.hypot(bx - cx, bz - cz);
      let da = Math.atan2(tx - cx, tz - cz) - a0, db = Math.atan2(bx - cx, bz - cz) - b0;
      da -= Math.round(da / TAU) * TAU;
      db -= Math.round(db / TAU) * TAU;
      const steps = Math.min(7, Math.ceil(Math.max(Math.abs(da) / 0.2, Math.abs(ty - y0) / 0.25)));
      const a1 = tr.age[tr.n - 1];
      for (let s = 1; s < steps; s++) {
        const f = s / steps, at = a0 + da * f, ab = b0 + db * f, rt = r0 + (r1 - r0) * f, rb = q0 + (q1 - q0) * f;
        trailAdd(cx + Math.sin(ab) * rb, h0 + (by - h0) * f, cz + Math.cos(ab) * rb, cx + Math.sin(at) * rt, y0 + (ty - y0) * f, cz + Math.cos(at) * rt, a1 * (1 - f), 0);
      }
    } else if (tr.n > 0) {
      // 新的一刀：和上一道之间插两个透明点断开
      const o = (tr.n - 1) * 6, p = tr.p;
      trailAdd(p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], tr.age[tr.n - 1], 1);
      trailAdd(bx, by, bz, tx, ty, tz, 0, 1);
    }
    trailAdd(bx, by, bz, tx, ty, tz, 0, 0);
    tr.live = 2;
  }
  function updateTrail(dt) {
    const tr = trail;
    if (tr.live > 0 && dt > 0) tr.live--;
    if (!tr.n) {
      if (tr.mesh.visible) tr.mesh.visible = false;
      return;
    }
    let drop = 0;
    for (let i = 0; i < tr.n; i++) {
      tr.age[i] += dt;
      if (tr.age[i] >= TRAIL_LIFE && drop === i) drop = i + 1; // 采样按时间先后排列，过期的都在队首
    }
    if (drop > 0) {
      tr.p.copyWithin(0, drop * 6, tr.n * 6);
      tr.age.copyWithin(0, drop, tr.n);
      tr.mute.copyWithin(0, drop, tr.n);
      tr.n -= drop;
    }
    const n = tr.n;
    for (let i = 0; i < n; i++) {
      const k = 1 - tr.age[i] / TRAIL_LIFE, a = tr.mute[i] || k <= 0 ? 0 : k * Math.sqrt(k);
      tr.al[i * 2] = tr.al[i * 2 + 1] = a;
    }
    tr.pos.set(n === TRAIL_MAX ? tr.p : tr.p.subarray(0, n * 6));
    const ge = tr.mesh.geometry;
    ge.attributes.position.needsUpdate = true;
    ge.attributes.aA.needsUpdate = true;
    ge.setDrawRange(0, Math.max(0, n - 1) * 6);
    tr.mesh.visible = n > 1;
  }
  // 刀光的颜色（一般取这一击里占比最大的伤害类型）
  W.setTrail = function (hex) {
    trail.color.value.set(hex);
  };

  // 贴地痕迹。kind：0 擦痕（短促，加色）1 焦痕 2 霜痕 3 电痕 4 灰迹 5 地裂；r 半径（擦痕为长度的一半），
  // wide 只对擦痕有意义（半宽）
  W.decal = function (kind, x, z, r, ang, hex, dur, wide) {
    let it = null;
    for (let i = 0; i < decals.length; i++) {
      const d = decals[(decalNext + i) % decals.length];
      if (!d.on) { it = d; break; }
    }
    if (!it) {
      // 都在用：顶掉最接近结束的那个
      it = decals[0];
      for (let i = 1; i < decals.length; i++) if (decals[i].t / decals[i].dur > it.t / it.dur) it = decals[i];
    }
    decalNext = (decalNext + 1) % decals.length;
    it.on = true;
    it.t = 0;
    it.dur = dur || 3;
    it.u.uColor.value.set(hex);
    it.u.uK.value = 0;
    it.u.uKind.value = kind;
    it.u.uSeed.value = Math.random();
    it.mat.blending = kind === 0 || kind === 2 ? T.AdditiveBlending : T.NormalBlending;
    it.mesh.position.set(x, kind === 0 ? 0.09 : 0.055, z);
    it.mesh.rotation.y = ang || 0;
    it.mesh.scale.set(kind === 0 ? wide || 0.25 : r, 1, r);
    it.mesh.visible = true;
  };
  function updateDecals(dt) {
    for (let i = 0; i < decals.length; i++) {
      const it = decals[i];
      if (!it.on) continue;
      it.t += dt;
      if (it.t >= it.dur) {
        it.on = false;
        it.mesh.visible = false;
      } else it.u.uK.value = it.t / it.dur;
    }
  }
  // 命中点的一记四芒星闪光
  function flare(x, y, z, hex, size, dur) {
    const f = flares[flareNext];
    flareNext = (flareNext + 1) % flares.length;
    f.on = true;
    f.t = 0;
    f.dur = dur;
    f.size = size;
    f.mat.color.set(hex).lerp(_c2.set(0xffffff), 0.45);
    f.mat.opacity = 1;
    f.mat.rotation = Math.random() * TAU;
    f.sp.position.set(x, y, z);
    f.sp.scale.setScalar(size * 0.6);
    f.sp.visible = true;
  }
  function updateFlares(dt) {
    for (let i = 0; i < flares.length; i++) {
      const f = flares[i];
      if (!f.on) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        f.on = false;
        f.sp.visible = false;
      } else {
        f.sp.scale.setScalar(f.size * (0.6 + 0.9 * Math.sqrt(k)));
        f.mat.opacity = 1 - k * k;
      }
    }
  }
  // 命中特效：火花顺着这一击行进的方向喷出去，按伤害类型换花样，地上留一道短促的擦痕。
  // type：phys / fire / cold / light；w：分量（0 轻击 1 重击 2 终结 3 处决）；crit：暴击再加一把
  const IMPACT_HEX = { phys: 0xfff0d0, fire: 0xff7a2c, cold: 0x9fe0ff, light: 0xffec70 };
  W.impact = function (x, y, z, ang, type, w, crit) {
    const hex = IMPACT_HEX[type] || IMPACT_HEX.phys;
    _c.set(hex);
    const r = _c.r, g = _c.g, b = _c.b, sn = Math.sin(ang), cs = Math.cos(ang);
    const n = 7 + w * 5 + (crit ? 6 : 0), sp = 9 + w * 3.5;
    for (let i = 0; i < n; i++) {
      const a = ang + rand(-0.7, 0.7) * (i % 4 === 0 ? 2.2 : 1), v = sp * rand(0.35, 1);
      const wh = i % 3 === 0 ? 0.75 : 0.15;
      spawnP(x, y + rand(-0.2, 0.2), z, Math.sin(a) * v, rand(0, 5) + w, Math.cos(a) * v, rand(0.14, 0.34) + w * 0.03, rand(0.1, 0.2) + w * 0.025,
        r + (1 - r) * wh, g + (1 - g) * wh, b + (1 - b) * wh, 14, 3.2);
    }
    if (type === 'fire') {
      // 余烬：慢、往上飘、活得久
      for (let i = 0, m = 4 + w * 3; i < m; i++) {
        spawnP(x + rand(-0.3, 0.3), y + rand(-0.2, 0.4), z + rand(-0.3, 0.3), sn * rand(0, 2.5) + rand(-1, 1), rand(1.5, 4), cs * rand(0, 2.5) + rand(-1, 1), rand(0.4, 0.85), rand(0.14, 0.26), 1, rand(0.35, 0.6), 0.1, -2, 1.2);
      }
    } else if (type === 'cold') {
      // 冰碴：大、沉、往下掉，再加一团白雾
      for (let i = 0, m = 4 + w * 2; i < m; i++) {
        const a = ang + rand(-1.2, 1.2), v = rand(3, 7);
        spawnP(x, y + rand(-0.1, 0.3), z, Math.sin(a) * v, rand(1, 4.5), Math.cos(a) * v, rand(0.35, 0.6), rand(0.22, 0.36), 0.8, 0.93, 1, 20, 1.5);
      }
      for (let i = 0; i < 3; i++) spawnP(x + rand(-0.3, 0.3), y + rand(-0.2, 0.3), z + rand(-0.3, 0.3), sn * rand(0.5, 2), rand(0.2, 1), cs * rand(0.5, 2), rand(0.3, 0.5), rand(0.45, 0.7), 0.3, 0.42, 0.5, -0.5, 3);
    } else if (type === 'light') {
      // 电火花：极快、极短、四面乱窜
      for (let i = 0, m = 6 + w * 3; i < m; i++) {
        const a = rand(0, TAU), v = rand(8, 17);
        spawnP(x, y + rand(-0.2, 0.3), z, Math.sin(a) * v, rand(-3, 8), Math.cos(a) * v, rand(0.06, 0.16), 0.13, 1, 1, 0.7, 0, 6);
      }
    } else {
      // 尘土
      for (let i = 0, m = 3 + w; i < m; i++) {
        spawnP(x + rand(-0.2, 0.2), 0.3, z + rand(-0.2, 0.2), sn * rand(1, 3) + rand(-1, 1), rand(0.5, 1.6), cs * rand(1, 3) + rand(-1, 1), rand(0.3, 0.55), rand(0.3, 0.5), 0.36, 0.32, 0.27, 1, 2.5);
      }
    }
    flare(x, y, z, hex, 1.0 + w * 0.45 + (crit ? 0.3 : 0), 0.08 + w * 0.02);
    const off = 0.9 + w * 0.35;
    W.decal(0, x + sn * off, z + cs * off, 0.9 + w * 0.5, ang, hex, 0.22 + w * 0.06, 0.16 + w * 0.04);
    if (w >= 1 || crit) flashLight(x, y + 1, z, hex, 0.9 + w * 0.5);
  };
  // 处决冲刺的残影：沿路径撒一串往后飘的光屑
  W.dashFx = function (x0, z0, x1, z1, hex) {
    _c.set(hex);
    const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz), n = Math.max(2, Math.ceil(d * 3));
    for (let i = 0; i < n; i++) {
      const k = i / n;
      spawnP(x0 + dx * k + rand(-0.15, 0.15), rand(0.4, 1.6), z0 + dz * k + rand(-0.15, 0.15), (-dx / (d || 1)) * rand(0.5, 2), rand(-0.2, 0.8), (-dz / (d || 1)) * rand(0.5, 2), rand(0.2, 0.45), rand(0.16, 0.3), _c.r, _c.g, _c.b, 0, 2);
    }
  };
  // 镜头：顺着 ang 方向顶一下（amt 为世界单位）；视角收缩 deg 度后弹回
  W.punch = function (ang, amt) {
    punchX = G.clamp(punchX + Math.sin(ang) * amt, -1.3, 1.3);
    punchZ = G.clamp(punchZ + Math.cos(ang) * amt, -1.3, 1.3);
  };
  W.fovKick = function (deg) {
    fovK = Math.min(7, Math.max(fovK, deg));
  };

  // ---------- 着色器方片特效（预警圈 / 冲击环 / 斩击弧） ----------
  const FX_VERT = 'varying vec2 vP;\nvoid main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const uTime = { value: 0 };

  const TELE_FRAG = [
    'uniform vec3 uColor; uniform vec3 uEdge; uniform vec2 uHalf; uniform float uK; uniform float uShape; uniform float uTime;',
    'varying vec2 vP;',
    'void main(){',
    '  vec2 p = vP * uHalf;',
    '  float d; float g;', // d：到边缘的世界距离（内部为正）；g：0..1 的填充坐标
    '  if (uShape < 0.5) { float l = length(p); d = uHalf.x - l; g = l / uHalf.x; }',
    '  else { vec2 q = uHalf - abs(p); d = min(q.x, q.y); g = abs(p.x) / uHalf.x; }',
    '  if (d < 0.0) discard;',
    '  float edge = 1.0 - smoothstep(0.1, 0.2, d);', // 外轮廓
    '  float inner = 1.0 - smoothstep(uK - 0.03, uK, g);', // 已经"充满"的部分
    '  float lead = smoothstep(uK - 0.14, uK - 0.02, g) * inner;', // 推进中的前沿亮线
    '  float rim = 1.0 - smoothstep(0.0, 1.1, d);', // 靠边的柔和加深
    '  float hot = smoothstep(0.72, 1.0, uK);',
    '  float pulse = 0.5 + 0.5 * sin(uTime * 16.0);',
    '  float a = 0.24 + rim * 0.16 + inner * (0.24 + 0.2 * uK) + hot * (0.08 + 0.12 * pulse);',
    '  vec3 col = mix(uColor, uEdge, max(edge, lead * 0.75));',
    '  col += hot * pulse * 0.18;',
    '  a = max(a, max(edge * 0.96, lead * 0.7));',
    '  a *= smoothstep(0.0, 0.035, d);',
    '  gl_FragColor = vec4(col, a);',
    '}',
  ].join('\n');

  W.makeTelegraph = function (spec, friendly) {
    const rect = spec.shape === 'rect';
    const hx = rect ? spec.w / 2 : spec.r, hz = rect ? spec.len / 2 : spec.r;
    const mat = new T.ShaderMaterial({
      uniforms: {
        uColor: { value: friendly ? new T.Color(1.0, 0.58, 0.16) : new T.Color(0.96, 0.07, 0.05) },
        uEdge: { value: friendly ? new T.Color(0.86, 0.95, 1.0) : new T.Color(1.0, 0.8, 0.62) },
        uHalf: { value: new T.Vector2(hx, hz) },
        uK: { value: 0 },
        uShape: { value: rect ? 1 : 0 },
        uTime,
      },
      vertexShader: FX_VERT, fragmentShader: TELE_FRAG,
      transparent: true, depthWrite: false, side: T.DoubleSide,
    });
    const mesh = new T.Mesh(gQuad(), mat);
    mesh.position.set(spec.x, 0.08, spec.z);
    mesh.scale.set(hx, 1, hz);
    if (rect) mesh.rotation.y = spec.ang; // 长轴 = 局部 +z = (sin ang, cos ang)
    mesh.renderOrder = 3;
    scene.add(mesh);
    const uK = mat.uniforms.uK;
    return {
      mesh, mat,
      setProgress(k) {
        uK.value = k < 0 ? 0 : k > 1 ? 1 : k;
      },
    };
  };
  W.removeTelegraph = function (handle) {
    scene.remove(handle.mesh);
    handle.mat.dispose();
  };

  // 冲击环 / 斩击弧用对象池，稳定后不再分配
  const RING_FRAG = [
    'uniform vec3 uColor; uniform float uK; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP);',
    '  float rr = 0.12 + 0.88 * (1.0 - (1.0 - uK) * (1.0 - uK));', // 先快后慢地扩张
    '  float band = smoothstep(rr - 0.2, rr - 0.025, l) * (1.0 - smoothstep(rr - 0.025, rr, l));',
    '  float fill = (1.0 - smoothstep(rr - 0.05, rr, l)) * 0.07;',
    '  float a = (band * 0.85 + fill) * (1.0 - uK) * (1.0 - uK * 0.5);',
    '  gl_FragColor = vec4(mix(uColor, vec3(1.0), band * 0.25), a);',
    '}',
  ].join('\n');
  const SLASH_FRAG = [
    'uniform vec3 uColor; uniform float uK; uniform float uArc; uniform float uDir; uniform float uIn; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP);',
    '  float an = atan(vP.x, vP.y) / uArc;', // 弧内为 -1..1（vP.y 是局部 +z，即朝向）
    '  if (abs(an) > 1.0 || l > 1.0) discard;',
    '  float radial = smoothstep(uIn, 0.9, l) * (1.0 - smoothstep(0.93, 1.0, l));', // 月牙：外沿最亮
    '  float h = (an * uDir) * 0.5 + 0.5;',
    '  float sweep = uK * 2.4;', // 刀光从弧的一端扫到另一端
    '  float head = 1.0 - smoothstep(sweep - 0.03, sweep, h);',
    '  float tail = smoothstep(sweep - 1.1, sweep, h);',
    '  float ends = smoothstep(0.0, 0.1, 1.0 - abs(an));',
    '  float a = radial * head * tail * ends * (1.0 - uK * uK * 0.5);',
    '  gl_FragColor = vec4(mix(uColor, vec3(1.0), radial * radial * 0.65), a);',
    '}',
  ].join('\n');

  function makePool(frag, extraUniforms, max) {
    return { items: [], frag, extraUniforms, max };
  }
  function poolGet(pool) {
    for (let i = 0; i < pool.items.length; i++) if (!pool.items[i].on) return pool.items[i];
    if (pool.items.length >= pool.max) {
      // 池满了就复用进度最靠后的那个
      let o = pool.items[0];
      for (let i = 1; i < pool.items.length; i++) if (pool.items[i].t / pool.items[i].dur > o.t / o.dur) o = pool.items[i];
      return o;
    }
    const uniforms = { uColor: { value: new T.Color() }, uK: { value: 0 } };
    if (pool.extraUniforms) for (const k of pool.extraUniforms) uniforms[k] = { value: 0 };
    const mat = new T.ShaderMaterial({
      uniforms, vertexShader: FX_VERT, fragmentShader: pool.frag,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
    });
    const mesh = new T.Mesh(gQuad(), mat);
    mesh.visible = false;
    mesh.renderOrder = 4;
    scene.add(mesh);
    const it = { mesh, u: uniforms, on: false, t: 0, dur: 1 };
    pool.items.push(it);
    return it;
  }
  function poolUpdate(pool, dt) {
    for (let i = 0; i < pool.items.length; i++) {
      const it = pool.items[i];
      if (!it.on) continue;
      it.t += dt;
      if (it.t >= it.dur) {
        it.on = false;
        it.mesh.visible = false;
      } else it.u.uK.value = it.t / it.dur;
    }
  }
  const ringPool = makePool(RING_FRAG, null, 28);
  const slashPool = makePool(SLASH_FRAG, ['uArc', 'uDir', 'uIn'], 12);

  W.ring = function (x, z, r, hex, dur) {
    const it = poolGet(ringPool);
    it.on = true;
    it.t = 0;
    it.dur = dur || 0.4;
    it.u.uColor.value.set(hex);
    it.u.uK.value = 0;
    it.mesh.position.set(x, 0.1, z);
    it.mesh.scale.set(r, 1, r);
    it.mesh.visible = true;
  };

  // opts（可选）：{ dir: 1 | -1 刀光扫过的方向, dur 时长, y 高度, inner 月牙内沿（0 ~ 0.9，越大越细） }
  W.slash = function (x, z, ang, range, arcDeg, hex, opts) {
    const it = poolGet(slashPool), o = opts || {};
    it.on = true;
    it.t = 0;
    it.dur = o.dur || 0.22;
    it.u.uColor.value.set(hex);
    it.u.uK.value = 0;
    const half = (arcDeg * Math.PI) / 360;
    it.u.uArc.value = Math.min(Math.PI, half);
    it.u.uDir.value = o.dir === -1 ? -1 : 1;
    it.u.uIn.value = o.inner === undefined ? 0.3 : o.inner;
    it.mesh.position.set(x, o.y === undefined ? 0.95 : o.y, z);
    it.mesh.rotation.y = ang;
    it.mesh.scale.set(range, 1, range);
    it.mesh.visible = true;
    // 弧线外沿甩出的碎光
    _c.set(hex);
    for (let i = 0; i < 7; i++) {
      const a = ang + rand(-half, half), d = range * rand(0.75, 0.98);
      spawnP(x + Math.sin(a) * d, 0.95, z + Math.cos(a) * d, Math.sin(a) * 5, rand(0.5, 2), Math.cos(a) * 5, rand(0.15, 0.3), 0.16, _c.r, _c.g, _c.b, 4, 3);
    }
  };

  // ----- 闪电：预分配的带状网格 -----
  const BOLT_MAXP = 96, BOLT_MAXIN = 24;
  const bolts = [];
  function boltGet() {
    for (let i = 0; i < bolts.length; i++) if (!bolts[i].on) return bolts[i];
    if (bolts.length >= 10) {
      // 池满了就顶掉最老的
      let o = bolts[0];
      for (let i = 1; i < bolts.length; i++) if (bolts[i].t > o.t) o = bolts[i];
      return o;
    }
    const g = new T.BufferGeometry();
    const pos = new Float32Array(BOLT_MAXP * 6), uv = new Float32Array(BOLT_MAXP * 4);
    const idx = new Uint16Array((BOLT_MAXP - 1) * 6);
    for (let i = 0; i < BOLT_MAXP - 1; i++) {
      const a = i * 2, o = i * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    for (let i = 0; i < BOLT_MAXP; i++) {
      uv[i * 4] = 0; uv[i * 4 + 1] = i / 8;
      uv[i * 4 + 2] = 1; uv[i * 4 + 3] = i / 8;
    }
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    const mat = new T.MeshBasicMaterial({ map: boltTex(), transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false, fog: false });
    const mesh = new T.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
    const b = { mesh, mat, pos, on: false, t: 0, n: 0, inX: new Float32Array(BOLT_MAXIN), inZ: new Float32Array(BOLT_MAXIN), path: new Float32Array(BOLT_MAXP * 2), rejit: false };
    bolts.push(b);
    return b;
  }
  // 把输入折线细分成锯齿路径，再挤出成贴地朝上的带子
  function boltBuild(b) {
    const path = b.path;
    let np = 0;
    for (let i = 0; i < b.n - 1; i++) {
      const ax = b.inX[i], az = b.inZ[i], bx = b.inX[i + 1], bz = b.inZ[i + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 0.001;
      const sub = Math.max(2, Math.min(10, Math.ceil(len / 1.0)));
      const nx = -dz / len, nz = dx / len;
      for (let k = 0; k < sub; k++) {
        if (np >= BOLT_MAXP - 1) break;
        const t = k / sub;
        const off = k === 0 ? 0 : rand(-0.5, 0.5) * Math.min(1, len * 0.25);
        path[np * 2] = ax + dx * t + nx * off;
        path[np * 2 + 1] = az + dz * t + nz * off;
        np++;
      }
    }
    path[np * 2] = b.inX[b.n - 1];
    path[np * 2 + 1] = b.inZ[b.n - 1];
    np++;
    const pos = b.pos, HW = 0.36;
    for (let i = 0; i < np; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(np - 1, i + 1);
      let dx = path[i1 * 2] - path[i0 * 2], dz = path[i1 * 2 + 1] - path[i0 * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const x = path[i * 2], z = path[i * 2 + 1], o = i * 6;
      pos[o] = x - dz * HW; pos[o + 1] = 1.25; pos[o + 2] = z + dx * HW;
      pos[o + 3] = x + dz * HW; pos[o + 4] = 1.25; pos[o + 5] = z - dx * HW;
    }
    b.mesh.geometry.attributes.position.needsUpdate = true;
    b.mesh.geometry.setDrawRange(0, (np - 1) * 6);
  }
  W.bolt = function (points, hex) {
    if (points.length < 2) return;
    const b = boltGet();
    b.n = Math.min(points.length, BOLT_MAXIN);
    for (let i = 0; i < b.n; i++) {
      b.inX[i] = points[i].x;
      b.inZ[i] = points[i].z;
    }
    b.on = true;
    b.t = 0;
    b.rejit = false;
    b.mat.color.set(hex).lerp(_c2.set(0xffffff), 0.35).convertSRGBToLinear();
    b.mat.opacity = 1;
    boltBuild(b);
    b.mesh.visible = true;
    // 每个落点炸一小撮火花
    _c.set(hex);
    for (let i = 1; i < b.n; i++) {
      for (let k = 0; k < 5; k++) {
        spawnP(b.inX[i], 1.2, b.inZ[i], rand(-4, 4), rand(0, 4), rand(-4, 4), rand(0.15, 0.35), 0.16, _c.r, _c.g, _c.b, 8, 2);
      }
    }
    flashLight(b.inX[b.n - 1], 2.5, b.inZ[b.n - 1], hex, 1.4);
  };
  function updateBolts(dt) {
    for (let i = 0; i < bolts.length; i++) {
      const b = bolts[i];
      if (!b.on) continue;
      b.t += dt;
      if (b.t >= 0.17) {
        b.on = false;
        b.mesh.visible = false;
        continue;
      }
      if (!b.rejit && b.t > 0.07) {
        // 中途重抖一次，像电弧在跳
        b.rejit = true;
        boltBuild(b);
      }
      b.mat.opacity = 1 - (b.t / 0.17) * (b.t / 0.17);
    }
  }

  // ----- 陨石 -----
  const spriteMats = Object.create(null);
  function spriteMat(hex) {
    return (
      spriteMats[hex] ||
      (spriteMats[hex] = new T.SpriteMaterial({ map: glowTex(), color: lin(hex), transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }))
    );
  }
  const coreMats = Object.create(null);
  function coreMat(hex) {
    return coreMats[hex] || (coreMats[hex] = new T.MeshBasicMaterial({ color: lin(mixHex(hex, 0xffffff, 0.6)), toneMapped: false, fog: false }));
  }
  const meteors = [];
  W.meteorFall = function (x, z, delay, hex) {
    let m = null;
    for (let i = 0; i < meteors.length; i++) if (!meteors[i].on) { m = meteors[i]; break; }
    if (!m && meteors.length >= 12) {
      m = meteors[0];
      for (let i = 1; i < meteors.length; i++) if (meteors[i].t / meteors[i].dur > m.t / m.dur) m = meteors[i];
    }
    if (!m) {
      const mesh = new T.Mesh(gIco(1, 1), coreMat(0xffffff));
      const glow = new T.Sprite(spriteMat(0xffffff));
      glow.scale.setScalar(6);
      mesh.add(glow);
      mesh.scale.setScalar(0.6);
      scene.add(mesh);
      m = { mesh, glow, on: false, t: 0, dur: 1, x: 0, z: 0, r: 1, g: 1, b: 1, hex: 0, gen: 0 };
      meteors.push(m);
    }
    m.gen++;
    const h = hexOf(hex);
    m.mesh.material = coreMat(h);
    m.glow.material = spriteMat(h);
    _c.set(h);
    m.r = _c.r; m.g = _c.g; m.b = _c.b;
    m.hex = h;
    m.x = x; m.z = z;
    m.t = 0;
    m.dur = Math.max(0.05, delay);
    m.on = true;
    m.mesh.visible = true;
    m.mesh.position.set(x - 6, 26, z - 9);
    return { m, gen: m.gen };
  };
  // 取消一颗还在半空的陨石（传入 meteorFall 的返回值）：首领被打出破绽时，它召来的落石一起消失
  W.cancelMeteor = function (tok) {
    if (!tok || !tok.m.on || tok.m.gen !== tok.gen) return;
    const m = tok.m;
    m.on = false;
    m.mesh.visible = false;
    const p = m.mesh.position;
    for (let j = 0; j < 8; j++) spawnP(p.x, p.y, p.z, rand(-3, 3), rand(-1, 3), rand(-3, 3), rand(0.2, 0.5), rand(0.2, 0.4), m.r, m.g, m.b, 4, 1.5);
  };
  function updateMeteors(dt) {
    for (let i = 0; i < meteors.length; i++) {
      const m = meteors[i];
      if (!m.on) continue;
      m.t += dt;
      const k = Math.min(1, m.t / m.dur), e = k * k; // 越落越快
      const px = m.x - 6 * (1 - e), py = 0.5 + 25.5 * (1 - e), pz = m.z - 9 * (1 - e);
      m.mesh.position.set(px, py, pz);
      m.mesh.rotation.x += dt * 9;
      for (let j = 0; j < 3; j++) {
        const w = Math.random() * 0.4;
        spawnP(px + rand(-0.3, 0.3), py + rand(-0.3, 0.3), pz + rand(-0.3, 0.3), rand(-1, 1), rand(0, 2), rand(-1, 1), rand(0.25, 0.55), rand(0.3, 0.6), m.r + (1 - m.r) * w, m.g + (1 - m.g) * w, m.b + (1 - m.b) * w, -1, 1);
      }
      if (k >= 1) {
        m.on = false;
        m.mesh.visible = false;
        flashLight(m.x, 2.5, m.z, m.hex, 3);
        for (let j = 0; j < 14; j++) {
          const a = rand(0, TAU), sp = rand(3, 9);
          spawnP(m.x, 0.3, m.z, Math.sin(a) * sp, rand(1, 6), Math.cos(a) * sp, rand(0.4, 0.9), rand(0.2, 0.4), m.r, m.g, m.b, 10, 1.2);
        }
      }
    }
  }

  // ---------- 飘字 ----------
  const TEXT_DUR = 0.8;
  const texts = [];
  // style（可选）：{ kind: 'crit' 暴击 | 'big' 终结 / 处决的大数字 | 'tag' 状态词（破绽、处决……）, y 起始高度（默认 2.1）, py 额外的屏幕像素偏移 }
  W.text = function (x, z, str, cssColor, sizePx, style) {
    let o = null;
    for (let i = 0; i < texts.length; i++) if (texts[i].t >= texts[i].dur) { o = texts[i]; break; }
    if (!o) {
      if (texts.length < 90) {
        o = { x: 0, z: 0, y: 2.1, str: '', color: '', size: 16, t: 0, dur: TEXT_DUR, ox: 0, oy: 0, vx: 0, kind: '', py: 0 };
        texts.push(o);
      } else {
        o = texts[0];
        for (let i = 1; i < texts.length; i++) if (texts[i].t > o.t) o = texts[i];
      }
    }
    o.x = x;
    o.z = z;
    o.str = String(str);
    o.color = cssColor || '#ffffff';
    o.size = sizePx || 16;
    o.t = 0;
    o.kind = (style && style.kind) || '';
    o.y = style && style.y !== undefined ? style.y : 2.1;
    o.py = (style && style.py) || 0; // 额外的屏幕像素偏移（「破绽」要让开头顶的处决提示）
    const arc = o.kind === 'crit' || o.kind === 'big';
    o.dur = o.kind === 'big' ? 1.25 : o.kind === 'crit' ? 1.0 : o.kind === 'tag' ? 1.15 : TEXT_DUR;
    o.ox = o.kind === 'tag' ? 0 : rand(-18, 18);
    o.oy = o.kind === 'tag' ? 0 : rand(-8, 8);
    o.vx = arc ? (Math.random() < 0.5 ? -1 : 1) * rand(24, 52) : 0; // 暴击数字往一侧抛出去
  };

  W.shake = function (amount) {
    shakeAmt = Math.min(1.4, Math.max(shakeAmt, amount));
  };

  // 换区 / 重生时把还在播放的临时特效全部收掉（它们的坐标属于上一个场景）
  W.clearFx = function () {
    for (const it of ringPool.items) { it.on = false; it.mesh.visible = false; }
    for (const it of slashPool.items) { it.on = false; it.mesh.visible = false; }
    for (const b of bolts) { b.on = false; b.mesh.visible = false; }
    for (const m of meteors) { m.on = false; m.mesh.visible = false; }
    for (const t of texts) t.t = t.dur;
    clearDying();
    for (const d of decals) { d.on = false; d.mesh.visible = false; }
    for (const f of flares) { f.on = false; f.sp.visible = false; }
    for (const s of summons) { s.on = false; s.grp.visible = false; }
    W.focusMark(null);
    trail.n = 0;
    trail.live = 0;
    trail.mesh.visible = false;
    for (const e of shudders) {
      e.shT = 0;
      if (!e.removed) e.body.position.set(0, 0, 0);
    }
    shudders.length = 0;
    punchX = punchZ = fovK = 0;
    for (let i = 0; i < PN; i++) {
      pLife[i] = 0;
      pSize[i] = 0;
      pPos[i * 3 + 1] = -999;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.aSize.needsUpdate = true;
    shakeAmt = 0;
    fxLight.intensity = 0;
  };

  // ---------- 投射物 / 掉落物 / 传送门 ----------
  const projObjs = [], lootObjs = [];
  let portalObj = null;

  // 敌方弹丸专用：压暗的元素色内核 + 一圈翻滚的红环。玩家的投射物是亮白核的纯色光球，
  // 两者靠明暗和轮廓就能分开，不依赖色相（火焰区里双方都是橙色）
  const hostileCores = Object.create(null);
  let hostileRing = null;
  const HOSTILE_RED = 0xff2a22;
  W.makeProjectile = function (hex, radius, hostile) {
    const h = hexOf(hex);
    let mesh;
    if (hostile) {
      if (!hostileRing) hostileRing = new T.MeshBasicMaterial({ color: lin(HOSTILE_RED), toneMapped: false, fog: false });
      const core = hostileCores[h] || (hostileCores[h] = new T.MeshBasicMaterial({ color: lin(mixHex(h, 0x0a0204, 0.62)), toneMapped: false, fog: false }));
      mesh = new T.Mesh(gIco(1, 0), core);
      mesh.scale.setScalar(radius * 1.15);
      mesh.add(new T.Mesh(geo('projRing', () => new T.TorusGeometry(1.75, 0.2, 5, 14)), hostileRing));
      const glow = new T.Sprite(spriteMat(h));
      glow.scale.setScalar(7);
      mesh.add(glow);
    } else {
      mesh = new T.Mesh(gIco(1, 1), coreMat(h));
      mesh.scale.setScalar(radius);
      const glow = new T.Sprite(spriteMat(h));
      glow.scale.setScalar(6.5);
      mesh.add(glow);
    }
    _c.set(h);
    const u = mesh.userData;
    u.kind = 'proj';
    u.r = _c.r; u.g = _c.g; u.b = _c.b;
    u.rad = radius;
    u.acc = 0;
    mesh.position.y = -50; // 调用方下一行就会设置位置；先藏到地下，避免在原点闪一帧
    scene.add(mesh);
    projObjs.push(mesh);
    return mesh;
  };

  const lootMats = Object.create(null);
  function lootMat(hex) {
    if (lootMats[hex]) return lootMats[hex];
    const c = lin(hex);
    return (lootMats[hex] = new T.MeshStandardMaterial({ color: c.clone().multiplyScalar(0.55), emissive: c, emissiveIntensity: 0.8, roughness: 0.35, metalness: 0.3, flatShading: true, toneMapped: false }));
  }
  const discMats = Object.create(null);
  function discMat(hex) {
    return (
      discMats[hex] ||
      (discMats[hex] = new T.MeshBasicMaterial({ map: glowTex(), color: lin(hex), transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }))
    );
  }
  const beamMats = Object.create(null);
  function beamMat(hex) {
    return (
      beamMats[hex] ||
      (beamMats[hex] = new T.MeshBasicMaterial({ map: beamTex(), color: lin(hex), transparent: true, opacity: 0.6, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false, fog: false }))
    );
  }
  W.makePortal = function (x, z) {
    const grp = new T.Group();
    grp.position.set(x, 0, z);
    const mats = [];
    const m = (mat) => (mats.push(mat), mat);
    const COL = 0x9d86ff;
    const stone = m(new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true }));
    const glow = m(new T.MeshStandardMaterial({ color: lin(COL).multiplyScalar(0.3), emissive: lin(COL), emissiveIntensity: 1.1, flatShading: true, toneMapped: false }));
    const sparts = [[gTorus(1.45, 0.16, 5, 24), 0x3a3644, 0, 0.12, 0, Math.PI / 2]];
    const gparts = [];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + TAU / 8, px = Math.sin(a) * 1.5, pz = Math.cos(a) * 1.5;
      sparts.push([gBox(0.3, 1.1, 0.3), 0x2c2936, px, 0.55, pz, 0, a, 0]);
      gparts.push([gOct(0.16), WH, px, 1.35, pz]);
    }
    put(grp, bake('portal/stone', sparts), stone);
    put(grp, bake('portal/glow', gparts), glow);
    const swirl = (r, y, op) => {
      const mm = m(new T.MeshBasicMaterial({ map: swirlTex(), color: lin(COL), transparent: true, opacity: op, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
      const q = new T.Mesh(gQuad(), mm);
      q.position.y = y;
      q.scale.set(r, 1, r);
      q.renderOrder = 2;
      grp.add(q);
      return q;
    };
    const s1 = swirl(1.35, 0.1, 0.62), s2 = swirl(1.9, 0.07, 0.3);
    const col = new T.Mesh(
      geo('portalCol', () => new T.CylinderGeometry(0.9, 1.25, 5, 16, 1, true).translate(0, 2.5, 0)),
      m(new T.MeshBasicMaterial({ map: beamTex(), color: lin(COL), transparent: true, opacity: 0.24, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false, fog: false }))
    );
    col.renderOrder = 5;
    grp.add(col);
    const u = grp.userData;
    u.kind = 'portal';
    u.mats = mats;
    u.s1 = s1;
    u.s2 = s2;
    u.col = col;
    u.acc = 0;
    scene.add(grp);
    portalObj = grp;
    portalLight.position.set(x, 2.2, z);
    portalLight.intensity = 1.2;
    return grp;
  };

  W.removeMesh = function (mesh) {
    if (mesh.parent) mesh.parent.remove(mesh);
    const kind = mesh.userData.kind;
    if (kind === 'proj') {
      const i = projObjs.indexOf(mesh);
      if (i >= 0) projObjs.splice(i, 1);
    } else if (kind === 'loot') {
      const i = lootObjs.indexOf(mesh);
      if (i >= 0) lootObjs.splice(i, 1);
    } else if (kind === 'portal') {
      for (const m of mesh.userData.mats) m.dispose();
      if (portalObj === mesh) {
        portalObj = null;
        portalLight.intensity = 0;
      }
    }
  };

  // ---------- 召唤法阵 / 聚焦标记（友方特效：开场建好，运行时只改参数，不分配） ----------
  // 法阵：沿圆周「画」出来的一张符阵（复用竞技场法阵的贴图），一边转一边淡出；中间升起一截魂火光柱
  const SIGIL_FRAG = [
    'uniform sampler2D uMap; uniform vec3 uColor; uniform float uK; uniform float uA; uniform float uRot; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP);',
    '  if (l > 1.0) discard;',
    '  float c = cos(uRot), s = sin(uRot);',
    '  vec2 q = vec2(c * vP.x - s * vP.y, s * vP.x + c * vP.y);',
    '  float t = texture2D(uMap, q * 0.5 + 0.5).a;',
    '  float an = atan(vP.x, vP.y) / 6.2831853 + 0.5;', // 0..1 绕一圈
    '  float rev = smoothstep(an - 0.06, an, uK * 1.08);', // 符线沿圆周依次亮起
    '  float core = (1.0 - smoothstep(0.0, 0.95, l)) * 0.22;',
    '  float a = (t * rev + core) * uA;',
    '  gl_FragColor = vec4(mix(uColor, vec3(1.0), t * rev * 0.4) * a, 1.0);',
    '}',
  ].join('\n');
  const SUMMON_N = 6;
  const summons = [];
  let summonNext = 0;
  // 聚焦标记：被聚焦的敌人头顶一颗倒悬的菱晶（深色描边，穿过模型也看得见）+ 脚下四角的瞄准框
  const focus = { ent: null, grp: null, gem: null, ring: null, r: 1, t: 0 };
  const focusTex = () =>
    tex('focus', () => {
      const S = 128, c = makeCanvas(S, S), g = c.getContext('2d');
      g.translate(S / 2, S / 2);
      g.strokeStyle = g.fillStyle = '#fff';
      g.lineCap = 'round';
      g.lineWidth = 6;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + TAU / 8;
        g.beginPath();
        g.arc(0, 0, 52, a - 0.42, a + 0.42);
        g.stroke();
        g.save();
        g.rotate(a);
        g.beginPath();
        g.moveTo(42, 0);
        g.lineTo(33, -6);
        g.lineTo(33, 6);
        g.closePath();
        g.fill();
        g.restore();
      }
      return new T.CanvasTexture(c);
    });
  function initAllyFx() {
    const colGeo = geo('summonCol', () => new T.CylinderGeometry(0.62, 0.9, 3, 14, 1, true).translate(0, 1.5, 0));
    for (let i = 0; i < SUMMON_N; i++) {
      const u = { uMap: { value: sigilTex() }, uColor: { value: new T.Color(ALLY_HEX) }, uK: { value: 0 }, uA: { value: 0 }, uRot: { value: 0 } };
      const sm = new T.ShaderMaterial({ uniforms: u, vertexShader: FX_VERT, fragmentShader: SIGIL_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
      const grp = new T.Group();
      const sig = new T.Mesh(gQuad(), sm);
      sig.position.y = 0.075;
      sig.renderOrder = 3;
      grp.add(sig);
      const bm = new T.MeshBasicMaterial({ map: beamTex(), color: lin(ALLY_HEX), transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false, fog: false });
      const col = new T.Mesh(colGeo, bm);
      col.renderOrder = 5;
      grp.add(col);
      grp.visible = false;
      scene.add(grp);
      summons.push({ grp, sig, col, u, bm, on: false, t: 0, dur: 1, r: 1, big: false, acc: 0, x: 0, z: 0, dir: 1, rung: false });
    }
    // 集火标记用金色（和召唤物名牌里的「集火」同色）：青色只留给友方，被集火的敌人不带友方的颜色
    const FOCUS_HEX = 0xffc85a, FOCUS_HI = 0xfff0c4;
    const grp = new T.Group();
    const gemGeo = geo('focusGem', () => new T.OctahedronGeometry(1, 0));
    const line = new T.Mesh(gemGeo, new T.MeshBasicMaterial({ color: lin(0x2a1a04), side: T.BackSide, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, fog: false }));
    line.scale.set(0.24, 0.42, 0.24);
    line.renderOrder = 8;
    const gem = new T.Mesh(gemGeo, new T.MeshBasicMaterial({ color: lin(FOCUS_HI), depthTest: false, depthWrite: false, transparent: true, toneMapped: false, fog: false }));
    gem.scale.set(0.17, 0.33, 0.17);
    gem.renderOrder = 9;
    const halo = new T.Sprite(spriteMat(FOCUS_HEX));
    halo.scale.setScalar(1.3);
    halo.renderOrder = 7;
    grp.add(halo, line, gem);
    grp.visible = false;
    scene.add(grp);
    const ring = new T.Mesh(gQuad(), new T.MeshBasicMaterial({ map: focusTex(), color: lin(FOCUS_HEX), transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    ring.position.y = 0.07;
    ring.renderOrder = 2;
    ring.visible = false;
    scene.add(ring);
    focus.grp = grp;
    focus.gem = gem;
    focus.ring = ring;
  }
  function allyFxVisible(on) {
    for (let i = 0; i < summons.length; i++) summons[i].grp.visible = on;
    focus.grp.visible = focus.ring.visible = on;
  }

  // 召唤时的法阵：x, z 落点；big = 石誓守像（更大、更亮、光柱更高）
  W.summonFx = function (x, z, big) {
    let s = null;
    for (let i = 0; i < summons.length; i++) if (!summons[i].on) { s = summons[i]; break; }
    if (!s) {
      s = summons[summonNext];
      summonNext = (summonNext + 1) % summons.length;
    }
    s.on = true;
    s.t = 0;
    s.big = !!big;
    s.dur = big ? 1.35 : 0.95;
    s.r = big ? 2.5 : 1.45;
    s.x = x;
    s.z = z;
    s.acc = 0;
    s.rung = false;
    s.dir = Math.random() < 0.5 ? -1 : 1;
    s.u.uK.value = 0;
    s.u.uA.value = 0;
    s.bm.opacity = 0;
    s.grp.position.set(x, 0, z);
    s.grp.visible = true;
    W.ring(x, z, s.r * 1.25, ALLY_HEX, 0.5);
    flashLight(x, 1.6, z, ALLY_HEX, big ? 2.2 : 1.2);
    for (let i = 0; i < (big ? 22 : 12); i++) {
      const a = rand(0, TAU), sp = rand(2, 5);
      spawnP(x + Math.sin(a) * 0.2, 0.15, z + Math.cos(a) * 0.2, Math.sin(a) * sp, rand(1, 3), Math.cos(a) * sp, rand(0.3, 0.55), rand(0.12, 0.22), 0.85, 1, 0.95, 6, 2.5);
    }
  };
  function updateSummons(dt) {
    for (let i = 0; i < summons.length; i++) {
      const s = summons[i];
      if (!s.on) continue;
      s.t += dt;
      const k = s.t / s.dur;
      if (k >= 1) {
        s.on = false;
        s.grp.visible = false;
        continue;
      }
      s.u.uK.value = Math.min(1, k / 0.32);
      s.u.uA.value = Math.min(1, k * 7) * (1 - smooth01((k - 0.55) / 0.45));
      s.u.uRot.value = s.dir * (k * 1.1 + (1 - Math.min(1, k * 3)) * 0.8);
      const sc = s.r * (0.8 + 0.2 * smooth01(k * 3));
      s.sig.scale.set(sc, 1, sc);
      s.bm.opacity = 0.55 * hump(k, 0.04, 0.28, 0.45, 0.95);
      const cw = s.r * (0.42 + 0.25 * k);
      s.col.scale.set(cw, (s.big ? 1.25 : 0.8) * (0.35 + 0.8 * smooth01(k * 2.5)), cw);
      // 魂火余烬从法阵里往上飘
      s.acc += dt * (s.big ? 110 : 60) * (1 - k);
      while (s.acc > 1) {
        s.acc -= 1;
        const an = Math.random() * TAU, d = Math.sqrt(Math.random()) * s.r * 0.85, w = Math.random() < 0.3 ? 0.6 : 0;
        spawnP(s.x + Math.sin(an) * d, 0.1, s.z + Math.cos(an) * d, rand(-0.3, 0.3), rand(1.4, 3.6) * (s.big ? 1.25 : 1), rand(-0.3, 0.3), rand(0.5, 1.0), rand(0.09, 0.2),
          ALLY_RGB.r + (1 - ALLY_RGB.r) * w, ALLY_RGB.g + (1 - ALLY_RGB.g) * w, ALLY_RGB.b + (1 - ALLY_RGB.b) * w, -1.2, 0.9);
      }
      if (!s.rung && k > 0.42) {
        s.rung = true;
        W.ring(s.x, s.z, s.r * 0.85, ALLY_HI, 0.35);
      }
    }
  }

  // 聚焦标记：传入敌人的实体（G.state.enemies[i].ent）就标在它头上并跟着走，传 null 隐藏。
  // 每帧调用或只在目标变化时调用都可以；目标被移除 / 开始死亡时标记自动消失。r（可选）：脚下瞄准框的半径
  W.focusMark = function (ent, r) {
    if (!ent || ent.removed || ent.dying) {
      focus.ent = null;
      focus.grp.visible = focus.ring.visible = false;
      return;
    }
    if (ent !== focus.ent) {
      focus.ent = ent;
      focus.t = 0;
      const d = (G.MOBS && G.MOBS[ent.kind]) || (G.BOSSES && G.BOSSES[ent.kind]);
      focus.r = r > 0 ? r : ((d && d.r) || 0.6) * ent.k;
    } else if (r > 0) focus.r = r;
  };
  function updateFocus(raw) {
    const e = focus.ent;
    if (!e) return;
    if (e.removed || e.dying) {
      W.focusMark(null);
      return;
    }
    focus.t += raw;
    const t = focus.t, g = e.group.position, h = e.rig.height * e.k * e.group.scale.y;
    const pop = t < 0.14 ? 0.3 + (t / 0.14) * 1.1 : t < 0.3 ? 1.4 - ((t - 0.14) / 0.16) * 0.4 : 1;
    focus.grp.position.set(g.x, g.y + h + 0.6 + Math.sin(t * 4) * 0.08, g.z);
    focus.grp.scale.setScalar(pop);
    focus.grp.rotation.y += raw * 2.4;
    focus.grp.visible = true;
    const rr = (focus.r + 0.35) * (t < 0.2 ? 1.6 - t * 3 : 1);
    focus.ring.position.set(g.x, 0.07, g.z);
    focus.ring.scale.set(rr, 1, rr);
    focus.ring.rotation.y -= raw * 0.9;
    focus.ring.visible = true;
  }

  // ---------- 每帧更新 ----------
  function spawnAmbient(fx) {
    const x = camT.x + rand(-26, 26), z = camT.z + CAM_LEAD + rand(-22, 13);
    const mode = fx.st.amb;
    if (mode === 'snow') {
      spawnP(x, rand(5, 9), z, rand(0.4, 1.2), rand(-2.6, -1.5), rand(-0.2, 0.5), rand(2.6, 4), rand(0.09, 0.17), 0.62, 0.74, 0.85, 0, 0);
    } else if (mode === 'spark') {
      spawnP(x, rand(0.2, 3.5), z, rand(-2, 2), rand(-1, 2), rand(-2, 2), rand(0.3, 0.8), rand(0.08, 0.16), fx.ar, fx.ag, fx.ab, 0, 0.5);
    } else {
      spawnP(x, rand(0.1, 1.2), z, rand(-0.2, 0.9), rand(0.5, 1.7), rand(-0.4, 0.4), rand(2.2, 4.5), rand(0.08, 0.2), fx.ar, fx.ag * 0.8, fx.ab * 0.6, -0.25, 0.15);
    }
  }

  // dt：游戏时间（顿帧时为 0，慢动作时被压缩）；raw：真实时间，镜头 / 震动 / 飘字 / 模型抖动用它，
  // 这样世界定格的那几帧里画面依然是活的。只传一个参数时两者相同。
  W.update = function (dt, raw) {
    if (raw === undefined) raw = dt;
    wtime += dt;
    uTime.value = wtime;
    const P = G.player;

    // 相机：平滑跟随，换区或瞬移过远时直接到位
    const far = Math.abs(P.x - camT.x) + Math.abs(P.z - camT.z) > 34;
    if (camSnap || far) {
      camT.set(P.x, 0, P.z);
      camSnap = false;
    } else {
      const k = 1 - Math.exp(-raw * 9);
      camT.x += (P.x - camT.x) * k;
      camT.z += (P.z - camT.z) * k;
    }
    let sx = 0, sy = 0;
    if (shakeAmt > 0.002) {
      sx = (Math.random() - 0.5) * shakeAmt * 1.1;
      sy = (Math.random() - 0.5) * shakeAmt * 1.1;
      shakeAmt *= Math.exp(-raw * 7);
    } else shakeAmt = 0;
    if (punchX !== 0 || punchZ !== 0) {
      const pk = Math.exp(-raw * 12);
      punchX *= pk;
      punchZ *= pk;
      if (Math.abs(punchX) + Math.abs(punchZ) < 0.004) punchX = punchZ = 0;
    }
    if (fovK > 0) {
      fovK *= Math.exp(-raw * 7);
      if (fovK < 0.03) fovK = 0;
    }
    if (Math.abs(BASE_FOV - fovK - fovNow) > 0.005) {
      fovNow = BASE_FOV - fovK;
      camera.fov = fovNow;
      camera.updateProjectionMatrix();
    }
    camera.position.set(camT.x + CAM_OFF.x + sx + punchX, CAM_OFF.y + sy, camT.z + CAM_OFF.z + CAM_LEAD + punchZ);
    camera.updateMatrixWorld();

    // 太阳跟随相机焦点，并吸附到阴影贴图的纹素网格
    const texel = (SHADOW_HALF * 2) / SHADOW_MAP;
    _v.set(camT.x, 0, camT.z - 3 + CAM_LEAD);
    const pr = _v.dot(sunR), pu = _v.dot(sunU);
    _v.addScaledVector(sunR, Math.round(pr / texel) * texel - pr).addScaledVector(sunU, Math.round(pu / texel) * texel - pu);
    sun.target.position.copy(_v);
    sun.position.copy(_v).add(SUN_OFF);
    lamp.position.set(P.x, 3.2, P.z + 0.6);
    if (fxLight.intensity > 0) {
      fxLight.intensity *= Math.exp(-dt * 10);
      if (fxLight.intensity < 0.02) fxLight.intensity = 0;
    }

    // 区域氛围
    const fx = zoneFx;
    if (fx) {
      fx.ambAcc += dt * fx.st.ambRate;
      while (fx.ambAcc > 1) {
        fx.ambAcc -= 1;
        spawnAmbient(fx);
      }
      fx.crystalMat.emissiveIntensity = 0.95 + Math.sin(wtime * 1.7) * 0.2;
      fx.glowMat.opacity = 0.38 + Math.sin(wtime * 1.7) * 0.08;
      fx.bossSigil.material.opacity = 0.24 + Math.sin(wtime * 1.2) * 0.07;
      fx.bossSigil.rotation.y += dt * 0.04;
      let hi = HEMI_I;
      if (fx.st.amb === 'spark') {
        // 雷鸣遗迹：不定时的天光闪烁
        fx.boltIn -= dt;
        if (fx.boltIn <= 0) {
          fx.boltIn = rand(4, 11);
          fx.boltT = 0.3;
        }
        if (fx.boltT > 0) {
          fx.boltT -= dt;
          const k = Math.max(0, fx.boltT / 0.3);
          hi += (k > 0.75 || (k > 0.3 && k < 0.5) ? 1 : 0.15) * k * 0.9;
        }
      }
      hemi.intensity = hi;
    }

    updateDying(dt);
    updateParticles(dt);
    updateDecals(dt);
    updateFlares(dt);
    updateTrail(dt);
    updateShudders(raw);
    poolUpdate(ringPool, dt);
    poolUpdate(slashPool, dt);
    updateBolts(dt);
    updateMeteors(dt);
    updateSummons(dt);
    updateFocus(raw);
    for (let i = 0; i < texts.length; i++) if (texts[i].t < texts[i].dur) texts[i].t += raw; // 数字按真实时间走：顿帧时照样弹出来

    // 受击闪白到时复原
    for (let i = flashing.length - 1; i >= 0; i--) {
      const e = flashing[i];
      e.flashT -= raw; // 按真实时间走：顿帧再长，闪白也只是一眨眼，不会糊成一片
      if (e.flashT <= 0 || e.removed) {
        e.flashT = 0;
        if (!e.removed) unflash(e);
        flashing[i] = flashing[flashing.length - 1];
        flashing.pop();
      } else {
        // 从峰值一路渐隐
        const f = e.flashK * (0.3 + 0.7 * (e.flashT / e.flashD)), ms = e.mats;
        for (let j = 0; j < ms.length; j++) ms[j].emissiveIntensity = ms[j].userData.fi * f;
      }
    }

    // 投射物：自转 + 拖尾
    for (let i = 0; i < projObjs.length; i++) {
      const m = projObjs[i], u = m.userData, p = m.position;
      m.rotation.x += dt * 7;
      m.rotation.y += dt * 9;
      u.acc += dt;
      if (u.acc > 0.028 && p.y > -10) {
        u.acc = 0;
        spawnP(p.x + rand(-0.1, 0.1), p.y + rand(-0.1, 0.1), p.z + rand(-0.1, 0.1), rand(-0.6, 0.6), rand(-0.2, 0.8), rand(-0.6, 0.6), rand(0.2, 0.36), u.rad * 2.2, u.r * 0.8, u.g * 0.8, u.b * 0.8, -0.5, 1);
      }
    }

    // 掉落物：落地弹出，然后悬浮旋转
    for (let i = 0; i < lootObjs.length; i++) {
      const g = lootObjs[i], u = g.userData;
      u.t += dt;
      const k = Math.min(1, u.t / 0.32);
      g.scale.setScalar(k < 1 ? 0.2 + 0.8 * k + Math.sin(k * Math.PI) * 0.25 : 1);
      u.gem.position.y = 0.55 + Math.sin(u.t * 2.4 + u.ph) * 0.09 + (k < 1 ? Math.sin(k * Math.PI) * 0.9 : 0);
      u.gem.rotation.y += dt * u.spin;
    }

    // 传送门
    if (portalObj) {
      const u = portalObj.userData, p = portalObj.position;
      u.s1.rotation.y += dt * 1.6;
      u.s2.rotation.y -= dt * 0.7;
      u.col.rotation.y += dt * 0.5;
      u.col.material.opacity = 0.22 + Math.sin(wtime * 3) * 0.05;
      portalLight.intensity = 1.2 + Math.sin(wtime * 3) * 0.25;
      u.acc += dt * 22;
      while (u.acc > 1) {
        u.acc -= 1;
        const a = rand(0, TAU), d = rand(0.2, 1.3);
        spawnP(p.x + Math.sin(a) * d, 0.15, p.z + Math.cos(a) * d, -Math.cos(a) * 1.2, rand(1.2, 3.2), Math.sin(a) * 1.2, rand(0.7, 1.4), rand(0.1, 0.2), 0.55, 0.45, 1.0, -0.4, 0.3);
      }
    }
  };

  // ---------- 投影 ----------
  function projTo(x, y, z) {
    _v.set(x, y, z).project(camera);
    _pr.x = (_v.x * 0.5 + 0.5) * vw;
    _pr.y = (-_v.y * 0.5 + 0.5) * vh;
    _pr.ok = _v.z > -1 && _v.z < 1;
    return _pr;
  }
  W.project = function (x, y, z) {
    projTo(x, y, z);
    return { x: _pr.x, y: _pr.y, ok: _pr.ok };
  };
  // 世界坐标 (x, z) 上一个半人高的点，此刻是否落在玩家看得见的画面里（底部 HUD 那一条不算）。
  // 按「镜头已经对准玩家」来算，不读平滑中的镜头，也不依赖渲染，所以逻辑层（敌人 AI）可以放心用。
  const camF = new T.Vector3(), camU = new T.Vector3();
  W.inView = function (x, z) {
    const P = G.player;
    const rx = x - P.x - CAM_OFF.x, ry = 1 - CAM_OFF.y, rz = z - P.z - CAM_OFF.z - CAM_LEAD;
    const depth = rx * camF.x + ry * camF.y + rz * camF.z;
    if (depth <= 0.1) return false;
    const th = Math.tan((BASE_FOV * Math.PI) / 360) * depth; // 用基准视角：逻辑判定不受镜头特效影响
    const px = (rx / (th * camera.aspect)) * 0.5 * vw + vw * 0.5; // 镜头不绕 y 轴转，屏幕右 = 世界 +x
    const py = vh * 0.5 - ((rx * camU.x + ry * camU.y + rz * camU.z) / th) * 0.5 * vh;
    return px >= VIEW_PAD && px <= vw - VIEW_PAD && py >= VIEW_PAD && py <= vh - HUD_BAND;
  };
  W.screenToGround = function (clientX, clientY) {
    _v.set((clientX / vw) * 2 - 1, -(clientY / vh) * 2 + 1, 0.5).unproject(camera);
    const o = camera.position;
    const dy = _v.y - o.y;
    const t = dy < -1e-6 ? -o.y / dy : 0;
    return { x: o.x + (_v.x - o.x) * t, z: o.z + (_v.z - o.z) * t };
  };

  // ---------- 2D 叠加层 ----------
  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
  const labelRects = [];
  let labelCount = 0;
  const labelW = new WeakMap(); // loot -> { label, w }

  W.lootLabelAt = function (clientX, clientY) {
    for (let i = labelCount - 1; i >= 0; i--) {
      const r = labelRects[i];
      if (clientX >= r.x - 2 && clientX <= r.x + r.w + 2 && clientY >= r.y - 2 && clientY <= r.y + r.h + 2) return r.loot;
    }
    return null;
  };

  // 小地图：静态部分（空地、走廊）在建区时画到离屏画布
  const MM = { size: 172, pad: 12, cv: null, s: 1, ox: 0, oz: 0 };
  function buildMinimap(zone) {
    const S = MM.size, b = zone.bounds;
    const cv = MM.cv || (MM.cv = makeCanvas(1, 1));
    cv.width = cv.height = Math.round(S * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(12,9,8,0.88)';
    g.fillRect(0, 0, S, S);
    const bw = b.maxX - b.minX, bh = b.maxZ - b.minZ;
    const s = (S - MM.pad * 2) / Math.max(bw, bh);
    MM.s = s;
    MM.ox = MM.pad + (S - MM.pad * 2 - bw * s) / 2 - b.minX * s;
    MM.oz = MM.pad + (S - MM.pad * 2 - bh * s) / 2 - b.minZ * s;
    const X = (x) => x * s + MM.ox, Z = (z) => z * s + MM.oz;
    const shape = (grow) => {
      g.lineCap = 'round';
      for (const sg of zone.segs) {
        g.lineWidth = Math.max(2, sg.hw * 2 * s + grow * 2);
        g.beginPath();
        g.moveTo(X(sg.ax), Z(sg.az));
        g.lineTo(X(sg.bx), Z(sg.bz));
        g.stroke();
      }
      for (const c of zone.circles) {
        g.beginPath();
        g.arc(X(c.x), Z(c.z), c.r * s + grow, 0, TAU);
        g.fill();
      }
    };
    // 先画一圈深色描边，再画路面色
    g.strokeStyle = g.fillStyle = 'rgba(0,0,0,0.85)';
    shape(1.5);
    const pc = '#' + new T.Color(mixHex(zone.def.path, 0xffffff, 0.12)).getHexString();
    g.strokeStyle = g.fillStyle = pc;
    shape(0);
    const ac = '#' + new T.Color(zone.def.accent).getHexString();
    g.strokeStyle = ac;
    g.globalAlpha = 0.9;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(X(zone.bossPos.x), Z(zone.bossPos.z), zone.bossR * s - 2, 0, TAU);
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(214,160,92,0.55)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, S - 1, S - 1);
  }

  function drawOverlay() {
    const g = octx, st = G.state, P = G.player;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, vw, vh);

    // --- 敌人血条：只画醒着、且受过伤或是精英的；首领的血条在 HUD 里 ---
    const es = st.enemies;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead || e.isBoss || !e.awake || !(e.elite || e.hp < e.maxHp)) continue;
      const p = projTo(e.x, e.height * (e.elite ? 1.3 : 1) + 0.35, e.z);
      if (!p.ok || p.x < -40 || p.x > vw + 40 || p.y < -20 || p.y > vh + 20) continue;
      const w = e.elite ? 60 : 40, h = e.elite ? 6 : 4;
      const x = Math.round(p.x - w / 2), y = Math.round(p.y);
      g.fillStyle = 'rgba(0,0,0,0.72)';
      g.fillRect(x - 1, y - 1, w + 2, h + 2);
      const k = Math.max(0, Math.min(1, e.hp / e.maxHp));
      g.fillStyle = e.freeze > 0 ? '#9fe2ff' : e.elite ? '#ffb53c' : '#d9412f';
      g.fillRect(x, y, w * k, h);
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(x, y, w * k, 1);
      // 架势条（精英）：血条下面一道细白条；被打出破绽后变成一道闪动的金条，随破绽时间缩短
      let ay = y + h + 2;
      if (e.poiseMax > 0) {
        g.fillStyle = 'rgba(0,0,0,0.72)';
        g.fillRect(x - 1, ay, w + 2, 5);
        if (e.brokenT > 0) {
          g.fillStyle = Math.sin(wtime * 16) > 0 ? '#fff6cf' : '#ffc94a';
          g.fillRect(x, ay + 1, w * Math.max(0, Math.min(1, e.brokenT / (e.brokenMax || 1))), 3);
        } else {
          g.fillStyle = e.poiseHit > 0 ? '#ffffff' : '#d9d2c2';
          g.fillRect(x, ay + 1, w * Math.max(0, Math.min(1, e.poise / e.poiseMax)), 3);
        }
        ay += 7;
      }
      // 异常状态小方点
      let sx = x;
      if (e.burnT > 0 && e.burn > 0) { g.fillStyle = '#ff8a3c'; g.fillRect(sx, ay, 5, 3); sx += 7; }
      if (e.chill > 0) { g.fillStyle = '#86d8ff'; g.fillRect(sx, ay, 5, 3); sx += 7; }
      if (e.shock > 0) { g.fillStyle = '#ffe45e'; g.fillRect(sx, ay, 5, 3); sx += 7; }
      if (e.stunT > 0) { g.fillStyle = '#ffffff'; g.fillRect(sx, ay, 5, 3); }
      if (e.elite && e !== st.hover) {
        // 准星指着它时名字由界面层的名牌显示，这里不重复画
        g.font = '600 12px ' + FONT;
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(0,0,0,0.85)';
        g.strokeText(e.name, p.x, y - 5);
        g.fillStyle = e.brokenT > 0 ? '#fff3c0' : '#ffd98a';
        g.fillText(e.name, p.x, y - 5);
      }
    }

    // --- 召唤物血条：魂火青，一直显示，左端一颗菱形（和敌人的红条一眼分开）。
    //     数值来自召唤物的主人维护的 G.state.minions[i].hp / maxHp，位置跟着 minions[i].ent 走 ---
    const ms = st.minions;
    if (ms) {
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i], ent = m && m.ent;
        if (!ent || m.dead || ent.removed || ent.dying || !(m.maxHp > 0)) continue;
        const gp = ent.group.position;
        const p = projTo(gp.x, gp.y + ent.rig.height * ent.k * ent.group.scale.y + 0.3, gp.z);
        if (!p.ok || p.x < -40 || p.x > vw + 40 || p.y < -20 || p.y > vh + 20) continue;
        const big = ent.kind === 'colossus', w = big ? 50 : 32, h = big ? 5 : 4;
        const x = Math.round(p.x - w / 2), y = Math.round(p.y);
        g.fillStyle = 'rgba(0,0,0,0.75)';
        g.fillRect(x - 1, y - 1, w + 2, h + 2);
        g.fillStyle = 'rgba(28,70,62,0.9)';
        g.fillRect(x, y, w, h);
        const k = Math.max(0, Math.min(1, m.hp / m.maxHp));
        g.fillStyle = ALLY_CSS;
        g.fillRect(x, y, w * k, h);
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.fillRect(x, y, w * k, 1);
        const cy = y + h / 2, d = h / 2 + 3;
        g.beginPath();
        g.moveTo(x - 2 - d, cy);
        g.lineTo(x - 2, cy - d);
        g.lineTo(x - 2 + d, cy);
        g.lineTo(x - 2, cy + d);
        g.closePath();
        g.fillStyle = 'rgba(0,0,0,0.8)';
        g.fill();
        g.beginPath();
        g.moveTo(x - 2 - d + 1.5, cy);
        g.lineTo(x - 2, cy - d + 1.5);
        g.lineTo(x - 2 + d - 1.5, cy);
        g.lineTo(x - 2, cy + d - 1.5);
        g.closePath();
        g.fillStyle = ALLY_CSS;
        g.fill();
      }
    }

    // --- 掉落标签：互相避让，矩形留给 lootLabelAt 做点击判定 ---
    const loot = st.loot;
    labelCount = 0;
    g.font = '13px ' + FONT;
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let i = 0; i < loot.length; i++) {
      const l = loot[i];
      const p = projTo(l.x, 1.0, l.z);
      if (!p.ok || p.x < -80 || p.x > vw + 80 || p.y < 0 || p.y > vh + 40) continue;
      let cw = labelW.get(l);
      if (!cw || cw.label !== l.label) {
        // 末尾的 ▲ / ▼（换装评估）单独上色：绿升红降，不跟着稀有度的颜色走
        const last = l.label.charAt(l.label.length - 1);
        const badge = last === '▲' || last === '▼' ? last : '';
        const main = badge ? l.label.slice(0, -1) : l.label;
        const mw = Math.ceil(g.measureText(main).width);
        cw = { label: l.label, main, badge, mw, w: mw + (badge ? Math.ceil(g.measureText(badge).width) : 0) };
        labelW.set(l, cw);
      }
      const w = cw.w + 16, h = 21;
      const x = Math.round(p.x - w / 2);
      let y = Math.round(p.y - 26 - h);
      // 和已放好的标签重叠就往上挪
      for (let pass = 0; pass < 14; pass++) {
        let moved = false;
        for (let j = 0; j < labelCount; j++) {
          const r = labelRects[j];
          if (x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y) {
            y = r.y - h - 2;
            moved = true;
          }
        }
        if (!moved) break;
      }
      let r = labelRects[labelCount];
      if (!r) r = labelRects[labelCount] = { x: 0, y: 0, w: 0, h: 0, loot: null };
      labelCount++;
      r.x = x; r.y = y; r.w = w; r.h = h; r.loot = l;
      g.fillStyle = 'rgba(10,8,6,0.84)';
      g.fillRect(x, y, w, h);
      g.strokeStyle = l.color;
      g.globalAlpha = 0.85;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      g.globalAlpha = 1;
      g.fillStyle = l.color;
      if (cw.badge) {
        g.textAlign = 'left';
        g.fillText(cw.main, x + 8, y + h / 2 + 0.5);
        g.fillStyle = cw.badge === '▲' ? '#8fe07a' : '#ff6a55';
        g.fillText(cw.badge, x + 8 + cw.mw, y + h / 2 + 0.5);
        g.textAlign = 'center';
      } else g.fillText(l.label, x + w / 2, y + h / 2 + 0.5);
    }
    for (let i = labelCount; i < labelRects.length; i++) labelRects[i].loot = null; // 不留住已捡走的掉落物

    // --- 飘字 ---
    g.textBaseline = 'middle';
    g.lineWidth = 3.5;
    g.strokeStyle = 'rgba(0,0,0,0.88)';
    g.textAlign = 'center';
    for (let i = 0; i < texts.length; i++) {
      const o = texts[i];
      if (o.t >= o.dur) continue;
      const p = projTo(o.x, o.y, o.z);
      if (!p.ok) continue;
      const k = o.t / o.dur, t = o.t;
      const arc = o.kind === 'crit' || o.kind === 'big';
      // 从小猛地放大再回落；暴击放得更大，并沿一道抛物线甩出去
      let pop, x, y;
      if (arc) {
        pop = t < 0.07 ? 0.4 + (t / 0.07) * 1.35 : t < 0.22 ? 1.75 - ((t - 0.07) / 0.15) * 0.6 : 1.15;
        x = p.x + o.ox + o.vx * t;
        y = p.y + o.oy - 125 * t + 96 * t * t;
      } else if (o.kind === 'tag') {
        pop = t < 0.1 ? 0.5 + (t / 0.1) * 0.8 : t < 0.24 ? 1.3 - ((t - 0.1) / 0.14) * 0.3 : 1;
        x = p.x;
        y = Math.max(34, p.y + o.py - 18 - (1 - (1 - k) * (1 - k)) * 26);
      } else {
        pop = t < 0.06 ? 0.5 + (t / 0.06) * 0.85 : t < 0.17 ? 1.35 - ((t - 0.06) / 0.11) * 0.35 : 1;
        x = p.x + o.ox;
        y = p.y + o.oy - (1 - (1 - k) * (1 - k)) * 46;
      }
      g.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      g.font = (o.kind ? '800 ' : '700 ') + Math.round(o.size * pop) + 'px "Trebuchet MS",' + FONT;
      if (arc) {
        // 暴击：黑描边 + 一圈伤害类型色的细边，字心用亮金白，和普通数字一眼分得开
        g.lineWidth = 6.5;
        g.strokeStyle = 'rgba(0,0,0,0.9)';
        g.strokeText(o.str, x, y);
        g.lineWidth = 2.5;
        g.strokeStyle = o.color;
        g.strokeText(o.str, x, y);
        g.fillStyle = o.kind === 'big' ? '#ffffff' : '#fff3b4';
        g.fillText(o.str, x, y);
        g.lineWidth = 3.5;
        g.strokeStyle = 'rgba(0,0,0,0.88)';
      } else {
        g.strokeText(o.str, x, y);
        g.fillStyle = o.color;
        g.fillText(o.str, x, y);
      }
    }
    g.globalAlpha = 1;

    // --- 小地图 ---
    if (MM.cv) {
      const S = MM.size, mx = vw - S - 14, my = 14;
      g.drawImage(MM.cv, mx, my, S, S);
      const X = (x) => mx + x * MM.s + MM.ox, Z = (z) => my + z * MM.s + MM.oz;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        if (e.dead || e.isBoss || !e.awake) continue;
        g.fillStyle = e.elite ? '#ffc04a' : 'rgba(255,96,72,0.9)';
        const r = e.elite ? 2.4 : 1.5;
        g.fillRect(X(e.x) - r, Z(e.z) - r, r * 2, r * 2);
      }
      if (ms) {
        g.fillStyle = ALLY_CSS;
        for (let i = 0; i < ms.length; i++) {
          const m = ms[i], ent = m && m.ent;
          if (!ent || m.dead || ent.removed) continue;
          const r = ent.kind === 'colossus' ? 2.6 : 1.7, gp = ent.group.position;
          g.fillRect(X(gp.x) - r, Z(gp.z) - r, r * 2, r * 2);
        }
      }
      const zn = W.zone;
      if (st.boss && !st.boss.dead) {
        // 首领：脉动的红色菱形
        const bx = X(st.boss.x), bz = Z(st.boss.z), r = 5 + Math.sin(wtime * 4) * 0.8;
        g.fillStyle = '#ff4a3a';
        g.strokeStyle = 'rgba(0,0,0,0.9)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(bx, bz - r);
        g.lineTo(bx + r, bz);
        g.lineTo(bx, bz + r);
        g.lineTo(bx - r, bz);
        g.closePath();
        g.stroke();
        g.fill();
      }
      if (st.portal) {
        const px = X(st.portal.x), pz = Z(st.portal.z);
        g.strokeStyle = '#b9a4ff';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(px, pz, 4.5 + Math.sin(wtime * 3) * 0.8, 0, TAU);
        g.stroke();
        g.fillStyle = '#e6dcff';
        g.fillRect(px - 1, pz - 1, 2, 2);
      }
      if (zn) {
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(X(zn.start.x) - 1.5, Z(zn.start.z) - 1.5, 3, 3);
      }
      g.fillStyle = P.dead ? '#888888' : '#ffffff';
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(X(P.x), Z(P.z), 3.2, 0, TAU);
      g.stroke();
      g.fill();
    }
  }

  W.render = function () {
    renderer.render(scene, camera);
    drawOverlay();
  };
})();
