'use strict';
// vfx.js —— 特效的贴图库与共用着色器（visual-fidelity 1a）。
// 贴图由 tools/gen-vfx-textures.mjs 程序化生成（固定种子），pack-assets 打进 js/assets/vfx.js（index.html 同步引入），这里解码成纹理。
// 所有特效着色器共用一组 uniform（G.vfx.U：时间 + 五张贴图），一段 GLSL 工具（G.vfx.GLSL），世界层的特效要么
// 用 G.vfx.sprite(...) 拿一个按参数缓存的材质（同参数同材质、同一个着色器程序，不会每个实例各编一次），
// 要么在自己的 ShaderMaterial 前面拼上 G.vfx.GLSL、把 G.vfx.U 合进 uniforms。
// 包缺了 / 图解码失败也不影响游戏：纹理换成 1×1 的中性色，着色器照样编译，特效退回接近原来的平涂样子。
(function () {
  const G = window.G;
  const T = window.THREE;
  const V = (G.vfx = {});
  const PACK = (window.CA_ASSETS && window.CA_ASSETS.vfx) || null;

  // three 给每个纹理 / 材质 / 几何体生成 uuid 时会调用 Math.random。贴图库、预热用的临时对象这些「原来没有的分配」放在 quiet 里做：
  // 期间 Math.random 换成自己的伪随机，不动全局的随机序列（同一个种子下区域布局、刷怪和原来一样，前后截图逐帧对得上）
  let qs = 0x2545f491;
  const qrand = () => {
    qs = (qs + 0x6d2b79f5) >>> 0;
    let t = qs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  V.quiet = function (fn) {
    const r = Math.random;
    Math.random = qrand;
    try {
      return fn();
    } finally {
      Math.random = r;
    }
  };

  // ---------- 贴图 ----------
  // noiseA：R 分形噪声 / G 沃罗诺伊 F1（胞腔中心暗）/ B 胞腔边（裂纹线）；noiseB：R 竖向条纹 / G 细碎噪声 / B 胞腔随机灰度
  // ramps：8 行色带（左暗右亮，sRGB，4 档硬阶梯），行号见 V.RAMP；flipA：4×4 帧 R 火舌 / G 烟团 / B 火花；flipB：R 冲击环 / G 斩击弧 / B 电弧
  V.RAMP = { fire: 0, frost: 1, light: 2, chaos: 3, abyss: 4, holy: 5, poison: 6, ash: 7 };
  const pending = [];
  function fallback(v) {
    const t = new T.DataTexture(new Uint8Array([v, v, v, 255]), 1, 1, T.RGBAFormat);
    t.needsUpdate = true;
    return t;
  }
  function load(id, opt) {
    const b64 = PACK && PACK.img && PACK.img[id];
    if (!b64 || typeof Image === 'undefined') return fallback(opt.fb);
    const t = new T.Texture();
    t.wrapS = t.wrapT = opt.wrap;
    t.minFilter = opt.mip ? T.LinearMipmapLinearFilter : T.LinearFilter;
    t.magFilter = T.LinearFilter;
    t.generateMipmaps = !!opt.mip;
    t.anisotropy = 1;
    const im = new Image();
    const p = new Promise((res) => {
      im.onload = () => {
        const done = () => {
          t.image = im;
          t.needsUpdate = true;
          res(true);
        };
        if (im.decode) im.decode().then(done, done);
        else done();
      };
      im.onerror = () => {
        if (window.console) console.warn('[特效] 贴图解码失败：' + id + '，这一张用中性色代替');
        res(false);
      };
    });
    im.src = 'data:image/png;base64,' + b64;
    pending.push(p);
    return t;
  }
  const RW = T.RepeatWrapping, CW = T.ClampToEdgeWrapping;
  V.tex = V.quiet(() => ({
    noiseA: load('noiseA', { wrap: RW, mip: true, fb: 128 }),
    noiseB: load('noiseB', { wrap: RW, mip: true, fb: 128 }),
    // 色带不做多级纹理：缩小时会把上下两行混在一起
    ramps: load('ramps', { wrap: CW, mip: false, fb: 200 }),
    flipA: load('flipA', { wrap: CW, mip: true, fb: 0 }),
    flipB: load('flipB', { wrap: CW, mip: true, fb: 0 }),
  }));
  V.ok = !!(PACK && PACK.img);
  let readyFlag = false;
  V.whenReady = Promise.all(pending).then((r) => {
    readyFlag = r.every(Boolean);
    return readyFlag;
  });
  V.ready = () => readyFlag;
  V.bytes = () => (PACK && PACK.img ? Object.keys(PACK.img).reduce((s, k) => s + PACK.img[k].length, 0) : 0);

  // ---------- 共用 uniform：所有特效材质都引用同一批对象（世界层每帧只改 uTime 一处） ----------
  V.U = {
    uTime: { value: 0 },
    uLo: { value: 0 }, // 低画质 = 1（世界层的 setQuality 设）：大面积的特效在低画质下把噪声纹理收一点
    tNoiseA: { value: V.tex.noiseA },
    tNoiseB: { value: V.tex.noiseB },
    tRamp: { value: V.tex.ramps },
    tFlipA: { value: V.tex.flipA },
    tFlipB: { value: V.tex.flipB },
  };
  // 把共用 uniform 合进一个材质自己的 uniforms（同一批对象，不复制）
  V.uni = function (own) {
    const u = Object.assign({}, own || {});
    for (const k in V.U) if (!u[k]) u[k] = V.U[k];
    return u;
  };

  // ---------- GLSL 工具（拼在各特效片元着色器的最前面） ----------
  //   vfxNA / vfxNB(p)：两张噪声（四方连续，p 是贴图坐标，1 = 一整张）
  //   vfxRamp(t, row)：第 row 行色带上 t 处的颜色（sRGB，0 暗 → 1 亮）；vfxLin：sRGB → 线性
  //   vfxFlip(atlas, chan, frame, uv)：序列帧图集（4×4）里第 frame 帧（取模 16）、通道 chan（如 vec3(1,0,0)）在帧内 uv 处的值
  //   vfxErode(v, th, w)：噪声门限消融：x = 硬边不透明度（v 过 th），y = 门限上方宽 w 的一道亮边
  //   vfxSteps(a)：不透明度按卡通的三档跳（1 / 0.62 / 0.3）
  V.GLSL = [
    'uniform float uTime; uniform float uLo; uniform sampler2D tNoiseA; uniform sampler2D tNoiseB; uniform sampler2D tRamp; uniform sampler2D tFlipA; uniform sampler2D tFlipB;',
    'vec3 vfxNA(vec2 p){ return texture2D(tNoiseA, p).rgb; }',
    'vec3 vfxNB(vec2 p){ return texture2D(tNoiseB, p).rgb; }',
    'vec3 vfxRamp(float t, float row){ return texture2D(tRamp, vec2(clamp(t, 0.008, 0.992), (row + 0.5) / 8.0)).rgb; }',
    'vec3 vfxLin(vec3 c){ return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }',
    'float vfxFlip(sampler2D atlas, vec3 chan, float frame, vec2 uv){',
    '  float f = mod(floor(frame), 16.0); vec2 c = vec2(mod(f, 4.0), floor(f / 4.0));',
    '  vec2 q = clamp(uv, 0.02, 0.98);',
    '  return dot(texture2D(atlas, vec2((c.x + q.x) * 0.25, (3.0 - c.y + q.y) * 0.25)).rgb, chan);',
    '}',
    'vec2 vfxErode(float v, float th, float w){ float a = smoothstep(th, th + 0.025, v); return vec2(a, a * (1.0 - smoothstep(th + w, th + w + 0.025, v))); }',
    'float vfxSteps(float a){ return a > 0.66 ? 1.0 : (a > 0.33 ? 0.62 : (a > 0.02 ? 0.3 : 0.0)); }',
  ].join('\n');

  // ---------- 方片 / 公告板的通用特效材质 ----------
  // V.sprite(o)：同样的 o 返回同一个材质（按参数缓存）。实例化网格用 instanceMatrix / instanceColor（线性色），
  // 每个实例另有一个 aFx = (消融进度 0..1, 随机种子 0..1, 亮度倍率, 备用)，没有 aFx 属性的网格用 uniform uFx。
  //   o.shape：'map'（o.map 这张旧的程序化贴图：白色 + alpha 的形状）/ 'flipA' / 'flipB'（序列帧，o.chan 选通道 0/1/2）/ 'solid'（实心，形状由几何体给）
  //   o.fps：序列帧每秒几帧（帧号 = 时间 × fps + 种子 × 16），0 = 帧号直接取 aFx.x × 15（跟着进度走一遍）
  //   o.erode：噪声消融（门限 = aFx.x；o.edge 亮边宽，亮边取实例色往白混，0 = 不要亮边）；o.radial：消融从外圈往里吃（烟团）；o.lick：沿形状的竖向往上滚的条纹噪声啃边（火舌）
  //   o.tone：亮度分三档上色（暗边 / 主色 / 亮芯，都从实例色推），卡通的硬色带；o.ground：离地这么高以内渐隐（贴地的部分不切出硬线）
  //   o.flow：顺着 v 方向往前流的条纹噪声调制亮度（光束、曳光）
  //   o.blend：'add' 加色 / 'normal'；o.flipV：形状上下翻转（火舌的宽底朝前）
  // own = true：不走缓存、单独建一个（自己的 uColor / uFx，比如几段颜色不同的光束；着色器程序照样共用）
  const cache = Object.create(null);
  V.sprite = function (o, own) {
    // 缓存键：贴图只取 uuid（不能让 JSON.stringify 碰到纹理本身：它的 toJSON 会生成新的 uuid、消耗 Math.random）
    const key = JSON.stringify(Object.assign({}, o, { map: o.map ? o.map.uuid : 0 }));
    if (!own && cache[key]) return cache[key];
    const defs = {};
    if (o.shape === 'flipA' || o.shape === 'flipB') defs.VFX_FLIP = 1;
    if (o.shape === 'solid') defs.VFX_SOLID = 1;
    if (o.radial) defs.VFX_RADIAL = 1;
    if (o.erode) defs.VFX_ERODE = 1;
    if (o.lick) defs.VFX_LICK = 1;
    if (o.flow) defs.VFX_FLOW = 1;
    if (o.tone) defs.VFX_TONE = 1;
    if (o.ground) defs.VFX_GROUND = 1;
    if (o.flipV) defs.VFX_FLIPV = 1;
    if (o.afx) defs.VFX_AFX = 1;
    const chan = [0, 0, 0];
    chan[o.chan || 0] = 1;
    const u = V.uni({
      tMap: { value: defs.VFX_FLIP ? V.tex[o.shape] : o.map || V.tex.flipA },
      uChan: { value: new T.Vector3(chan[0], chan[1], chan[2]) },
      uFps: { value: o.fps || 0 },
      uEdge: { value: o.edge === undefined ? 0.12 : o.edge },
      uGround: { value: o.ground || 0.3 },
      uLickK: { value: o.lick || 0 },
      uLumLo: { value: o.lumLo || 0 },
      uColor: { value: new T.Color(1, 1, 1) },
      uFx: { value: new T.Vector4(0, 0, 1, 0) },
      uOpacity: { value: o.opacity === undefined ? 1 : o.opacity },
    });
    const m = new T.ShaderMaterial({
      uniforms: u,
      defines: defs,
      vertexShader: SPRITE_VERT,
      fragmentShader: V.GLSL + '\n' + SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: o.blend === 'normal' ? T.NormalBlending : T.AdditiveBlending,
      side: o.side === 'double' ? T.DoubleSide : T.FrontSide,
      fog: false,
    });
    m.toneMapped = false;
    m.userData.vfx = true;
    if (!own) cache[key] = m;
    return m;
  };
  V.materials = () => Object.keys(cache).map((k) => cache[k]);
  // 给实例化网格的几何体挂上逐实例的 aFx（几何体要是这个网格独有的：调用方先 clone）
  V.addFx = function (geom, cap) {
    const a = new T.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    a.setUsage(T.DynamicDrawUsage);
    geom.setAttribute('aFx', a);
    return a;
  };

  // ---------- 一个材质画好几种公告板：光晕 + 六种序列帧（预乘 alpha 混合：加色的种类输出 alpha = 0，普通混合的输出 alpha） ----------
  // 世界层把它挂在投射物的「光晕」零件上：光晕和所有序列帧特效（命中的火团、烟、火花、冲击环、斩击弧、电弧）共用一个实例缓冲、一次 draw call。
  // aFx = (进度 0..1, 种子, 亮度倍率, 种类)。种类：0 光晕（和原来的 glowTex 同一条径向曲线）/ 1 火团 / 2 烟团 / 3 火花 / 4 冲击环 / 5 斩击弧 / 6 电弧
  // 7 = 循环的火团（帧号跟着时间转、不淡出，投射物的火头用）
  V.FB = { glow: 0, fire: 1, smoke: 2, spark: 3, ring: 4, slash: 5, arc: 6, fireLoop: 7 };
  V.VD = { scorch: 0, frost: 1, void: 2, flash: 3 }; // 地面痕迹的种类（着色器里是 10 + 种类）
  const DECAL_FN = [
    // 地面痕迹（种类 10..13 → 0..3）：前 45% 完整，之后被噪声从外圈往里蚀掉；焦痕刚落下时裂缝里透着余烬（实例色），霜痕只有外沿一圈冰带
    'void vfxDecal(float kind, float k, float seed){',
    '  vec2 p = vUv * 2.0 - 1.0; float l = length(p);',
    '  if (l > 1.0) discard;',
    // 闪光不取贴图，先画完返回；霜痕只有外沿一圈，里面先丢掉（同一个实例的像素走同一支，贴图导数不受影响）
    '  if (kind > 2.5) {',
    '    float f = (1.0 - l) * (1.0 - l) * (1.0 - k) * (1.0 - k) * vFx.z;',
    '    if (f < 0.004) discard;',
    '    gl_FragColor = vec4(linearToOutputTexel(vec4(vCol, 1.0)).rgb * f * 1.2, 0.0); return;',
    '  }',
    '  if (kind > 0.5 && kind < 1.5 && l < 0.6) discard;',
    '  vec2 q = vUv * 0.8 + seed * 7.31;',
    '  float n = vfxNA(q).r;',
    '  float ce = uLo > 0.5 ? n : vfxNA(q * 1.5 + 0.37).b;', // 低画质少取一次贴图
    '  float er = k < 0.45 ? 0.0 : (k - 0.45) / 0.55;', // 消融进度
    '  float edge = 1.0 - l + (n - 0.5) * 0.5;', // 不规则的外沿
    '  float m = smoothstep(0.0, 0.05, edge - er * (1.1 - n * 0.4));',
    '  vec3 rgb = vec3(0.0); float a = 0.0;',
    '  if (kind < 0.5) {',
    // 焦痕：近黑的焦斑（带一点褐紫，不是死黑），前 35% 裂缝里透着余烬的亮色（加色）
    '    vec3 c = vec3(0.075, 0.045, 0.05) * (0.8 + 0.4 * n);',
    '    a = m * 0.8;',
    '    float hot = step(0.55, ce) * (1.0 - smoothstep(0.1, 0.38, k)) * step(l, 0.8);',
    '    rgb = linearToOutputTexel(vec4(c, 1.0)).rgb * a + linearToOutputTexel(vec4(vCol * 1.3, 1.0)).rgb * hot * m;',
    '  } else if (kind < 1.5) {',
    // 霜痕：只有外沿的一圈冰带（跟着半径扩开，像霜从里往外扫过去），冰带上胞腔边是更亮的冰缝，往里长着一根根尖的冰晶；
    // 圈里是空的（光环常驻，整片铺满会把脚下的地面和怪都罩成一片白）。灰度里靠尖的形状认得出是冰
    '    float an = atan(p.y, p.x);',
    '    float band = smoothstep(0.68, 0.74, l + (n - 0.5) * 0.12);',
    '    float spk = step(0.93, pow(abs(cos(an * 9.0 + n * 2.0 + seed * 6.0)), 14.0) + (l - 0.6) * 0.12) * step(0.64, l) * step(l, 0.95);',
    '    vec3 c = mix(vCol * 0.75, vec3(0.92, 0.97, 1.0), clamp(ce * 0.7 + spk, 0.0, 1.0));',
    '    a = m * band * (0.22 + 0.26 * ce) + spk * 0.38 * (1.0 - er) * m;',
    '    rgb = linearToOutputTexel(vec4(c, 1.0)).rgb * a;',
    '  } else if (kind < 2.5) {',
    // 渊痕：近黑的暗紫，胞腔边是品红的细纹
    '    float vein = step(0.72, ce) * step(l, 0.8);',
    '    vec3 c = mix(vec3(0.035, 0.01, 0.045), vCol, vein * 0.5);',
    '    a = m * (0.55 + 0.12 * vein);',
    '    rgb = linearToOutputTexel(vec4(c, 1.0)).rgb * a;',
    '  } else {',
    // 地面闪光：中心亮、往外快速衰减，整体按 (1 − k)² 熄掉，加色
    '    float f = (1.0 - l) * (1.0 - l) * (1.0 - k) * (1.0 - k);',
    '    rgb = linearToOutputTexel(vec4(vCol, 1.0)).rgb * f * 1.2;',
    '    a = 0.0;',
    '  }',
    '  rgb *= vFx.z; a *= vFx.z;',
    '  if (a < 0.004 && dot(rgb, vec3(1.0)) < 0.004) discard;',
    '  gl_FragColor = vec4(rgb, a);',
    '}',
  ].join('\n');

  // V.multi()：投射物光晕零件用；V.multi(true)：地面痕迹 + 序列帧合用的那一个实例网格（同一个着色器程序，多一点多边形偏移，贴地的痕迹不和地面打架）。
  // 种类 10..13 是地面痕迹（焦痕 / 霜痕 / 渊痕 / 地面闪光，见 V.VD），画在平躺的方片上
  const multiMats = {};
  V.multi = function (ground) {
    const key = ground ? 'g' : 'p';
    if (multiMats[key]) return multiMats[key];
    const multiMat = (multiMats[key] = new T.ShaderMaterial({
      uniforms: V.uni({ uColor: { value: new T.Color(1, 1, 1) }, uFx: { value: new T.Vector4(0, 0, 1, 0) } }),
      defines: { VFX_AFX: 1 },
      vertexShader: SPRITE_VERT,
      fragmentShader: V.GLSL + '\n' + MULTI_FRAG,
      transparent: true,
      depthWrite: false,
      blending: T.CustomBlending,
      blendEquation: T.AddEquation,
      blendSrc: T.OneFactor,
      blendDst: T.OneMinusSrcAlphaFactor,
      polygonOffset: !!ground,
      polygonOffsetFactor: ground ? -2 : 0,
      polygonOffsetUnits: ground ? -2 : 0,
      fog: false,
    }));
    multiMat.toneMapped = false;
    multiMat.userData.vfx = true;
    return multiMat;
  };
  const MULTI_FRAG = [
    'varying vec2 vUv; varying vec3 vCol; varying vec4 vFx; varying float vWy;',
    'void vfxDecal(float kind, float k, float seed);',
    'void main(){',
    '  float kind = floor(vFx.w + 0.5), k = vFx.x, seed = vFx.y;',
    '  if (kind > 9.5) { vfxDecal(kind - 10.0, k, seed); return; }',
    '  float loop = step(6.5, kind);',
    '  if (loop > 0.5) { kind = 1.0; k = fract(uTime * 1.6 + seed); }',
    '  vec3 col = vCol; float a = 0.0; float add = 1.0; float boost = 0.0;',
    '  if (kind < 0.5) {',
    // 光晕：glowTex 的径向渐变（0 → 1、0.25 → 0.55、0.6 → 0.14、1 → 0），加色
    '    float r = length(vUv - 0.5) * 2.0;',
    '    a = r < 0.25 ? mix(1.0, 0.55, r / 0.25) : (r < 0.6 ? mix(0.55, 0.14, (r - 0.25) / 0.35) : mix(0.14, 0.0, clamp((r - 0.6) / 0.4, 0.0, 1.0)));',
    '  } else if (kind < 3.5) {',
    '    vec3 ch = kind < 1.5 ? vec3(1.0, 0.0, 0.0) : (kind < 2.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));',
    '    float s = vfxFlip(tFlipA, ch, k * 15.99, vUv);',
    '    if (kind < 1.5) {',
    // 火团：卡通的三档色带（暗红边 / 主色 / 亮芯往白混），噪声啃一下边，普通混合，最亮的一档再叠一点加色
    '      float n = vfxNA(vUv * 0.7 + seed * 5.3 + vec2(0.0, -uTime * 0.6)).r;',
    '      float kf = mix(k, 0.1, loop);',
    '      float t = s * (0.75 + 0.4 * n) * (1.0 - 0.45 * kf);',
    '      a = smoothstep(0.1, 0.18, t) * (1.0 - smoothstep(0.75, 1.0, kf));',
    '      float mx = max(col.r, max(col.g, col.b));',
    '      col = t < 0.34 ? col * 0.4 : (t < 0.78 ? col : mix(col, vec3(mx, mx * 0.86, mx * 0.55), 0.55));',
    '      add = 0.0; boost = t > 0.78 ? 0.15 : 0.0;',
    '    } else if (kind < 2.5) {',
    // 烟团：普通混合，上亮下暗（像打了光），边缘按噪声蚀出硬边、三档透明度
    '      float n = vfxNA(vUv * 0.9 + seed * 3.1).r;',
    '      a = smoothstep(0.12, 0.2, s * (0.75 + 0.5 * n)) * (0.55 + 0.35 * step(0.55, s));',
    '      col *= 0.75 + 0.45 * smoothstep(0.3, 0.9, vUv.y + n * 0.2);',
    '      add = 0.0;',
    '    } else {',
    // 火花：星芒，加色，亮芯往白混
    '      a = s;',
    '      col = mix(col, vec3(max(col.r, max(col.g, col.b))), smoothstep(0.6, 1.0, s) * 0.6);',
    '    }',
    '  } else {',
    '    vec3 ch = kind < 4.5 ? vec3(1.0, 0.0, 0.0) : (kind < 5.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));',
    '    float s = vfxFlip(tFlipB, ch, kind < 5.5 ? k * 15.99 : k * 15.99 + seed * 16.0, vUv);',
    '    if (kind < 5.5) {',
    // 冲击环 / 斩击弧：普通混合的实色，外沿一道亮色（卡通的两档），三档透明度
    '      a = smoothstep(0.12, 0.22, s) * vfxSteps(1.0 - k);',
    '      col = s > 0.7 ? col * 0.35 + vec3(0.65) * max(col.r, max(col.g, col.b)) : col;',
    '      add = 0.0;',
    '    } else {',
    '      a = s; col = mix(col, vec3(1.0), smoothstep(0.7, 1.0, s) * 0.5);',
    '    }',
    '  }',
    // 贴地渐隐：火团 / 烟团 / 火花这些立着的公告板，插进地面的那一截不切出一道硬线（平躺的冲击环不算）
    '  if (kind > 0.5 && kind < 3.5) a *= smoothstep(0.0, 0.35, vWy);',
    '  a *= vFx.z;',
    '  if (a < 0.004) discard;',
    '  vec3 o = linearToOutputTexel(vec4(col, 1.0)).rgb;',
    '  gl_FragColor = vec4(o * a * (1.0 + boost), (1.0 - add) * a);',
    '}',
  ].join('\n') + '\n' + DECAL_FN;

  const SPRITE_VERT = [
    'uniform vec3 uColor; uniform vec4 uFx;',
    '#ifdef VFX_AFX',
    'attribute vec4 aFx;',
    '#endif',
    'varying vec2 vUv; varying vec3 vCol; varying vec4 vFx; varying float vWy;',
    'void main(){',
    '  vUv = uv;',
    '  vec4 wp = vec4(position, 1.0);',
    '#ifdef USE_INSTANCING',
    '  wp = instanceMatrix * wp;',
    '#endif',
    '  wp = modelMatrix * wp; vWy = wp.y;',
    '#ifdef USE_INSTANCING_COLOR',
    '  vCol = instanceColor;',
    '#else',
    '  vCol = uColor;',
    '#endif',
    '#ifdef VFX_AFX',
    '  vFx = aFx;',
    '#else',
    '  vFx = uFx;',
    '#endif',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}',
  ].join('\n');
  const SPRITE_FRAG = [
    'uniform sampler2D tMap; uniform vec3 uChan; uniform float uFps; uniform float uEdge; uniform float uGround; uniform float uLickK; uniform float uOpacity; uniform float uLumLo;',
    'varying vec2 vUv; varying vec3 vCol; varying vec4 vFx; varying float vWy;',
    'void main(){',
    '  vec2 uv = vUv;',
    '#ifdef VFX_FLIPV',
    '  uv.y = 1.0 - uv.y;',
    '#endif',
    '  float seed = vFx.y;',
    // 形状：序列帧的一个通道，或者旧贴图的 alpha（乘上亮度：flameHard 这类中间亮、边上暗的贴图）
    '#if defined(VFX_SOLID)',
    '  float s = 1.0; float lum = 1.0;',
    '#elif defined(VFX_FLIP)',
    '  float fr = uFps > 0.0 ? uTime * uFps + seed * 16.0 : vFx.x * 15.0;',
    '  float s = vfxFlip(tMap, uChan, fr, uv);',
    '  float lum = s;',
    '#else',
    '  vec4 m = texture2D(tMap, uv);',
    '  float s = m.a; float lum = max(max(m.r, m.g), m.b);',
    '#endif',
    '  float a = s;',
    '  vec3 col = vCol;',
    // 火舌啃边：竖向条纹噪声沿形状往上滚（v 方向），形状外沿被啃出一道道缺口，越靠尾巴啃得越深
    '#ifdef VFX_LICK',
    '  vec3 nb = vfxNB(vec2(uv.x * 0.7 + seed * 3.1, uv.y * 0.55 + uTime * 1.6 + seed));',
    '  float lick = nb.r * 0.7 + vfxNA(vec2(uv.x * 0.9 + seed, uv.y * 0.8 + uTime * 2.3)).r * 0.3;',
    '  a = s * smoothstep(0.0, 0.1, s - lick * uLickK * (1.15 - uv.y));',
    '#endif',
    '#ifdef VFX_FLOW',
    '  a *= 0.55 + 0.9 * vfxNB(vec2(uv.x * 0.4 + seed, uv.y * 0.25 - uTime * 3.0)).r;',
    '#endif',
    // 噪声消融：进度 vFx.x 是门限，门限上方一道亮边
    '#ifdef VFX_ERODE',
    '  float n = vfxNA(uv * 0.85 + seed * 7.31).r * 0.75 + vfxNB(uv * 1.7 + seed * 3.7).g * 0.25;',
    '#ifdef VFX_RADIAL',
    '  n = mix(n, 1.0 - length(uv - 0.5) * 2.0, 0.55);',
    '#endif',
    '  vec2 er = vfxErode(n * 0.92 + 0.04, vFx.x, uEdge);',
    '  a *= er.x;',
    '  if (uEdge > 0.0) col = mix(col, col * 0.4 + vec3(0.6), er.y);',
    '#endif',
    // 卡通的三档色带：亮度低的外沿压暗、中间主色、最里面一档往白混（都从实例色推出来，注入元素色的投射物照样跟着变色）
    '#ifdef VFX_TONE',
    '  float t = clamp((lum - uLumLo) / (1.0 - uLumLo), 0.0, 1.0) * (0.75 + 0.5 * vfxNA(uv * vec2(0.6, 0.3) + vec2(seed, uTime * 0.9)).r);',
    '  col = t < 0.3 ? col * 0.5 : (t < 0.78 ? col * 0.92 : col * 0.5 + vec3(0.5) * max(col.r, max(col.g, col.b)));',
    '#endif',
    '#ifdef VFX_GROUND',
    '  a *= smoothstep(0.0, uGround, vWy);',
    '#endif',
    '  a *= uOpacity * vFx.z;',
    '  if (a < 0.004) discard;',
    // 加色混合：颜色预乘不透明度（和原来的 MeshBasicMaterial + AdditiveBlending 一样，SrcAlpha·src + dst）
    '  gl_FragColor = linearToOutputTexel(vec4(col, a));',
    '}',
  ].join('\n');
})();
