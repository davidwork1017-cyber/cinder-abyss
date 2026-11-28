// style-pixel：像素风 + 暗色地牢的画面实验（只在网址带 ?px= 时由 index.html 加载，默认完全不加载）。
// 只改画面：模拟、存档、随机序列都不碰（闪烁取 G.vr，不取 Math.random）。灯光的强度只在画这一帧时改、画完马上恢复。
//
// 管线：场景 → 低分辨率目标（最近邻、不抗锯齿、带深度）→ 低分辨率处理一道（描边 / 调色 / 暗角 / 调色板 + 有序抖动）
//      → 放大到画布（锐利放大：像素内部是平的，像素之间只过渡 1 个屏幕像素）。HUD 和血条叠加层仍是原生分辨率。
// 镜头：游戏镜头只平移、不转，所以把镜头位置吸附到低分辨率像素的网格上，静止的东西在焦平面上不会游动。
//
// 网址参数（都可选）：
//   px=a|b|c|d|1      预设（1 = a）
//   pxh=320|400|480   低分辨率目标的高（像素）
//   pxpal=0|1         调色板量化（自己的 48 色暗色地牢色板）
//   pxdith=0..1       有序抖动强度（4×4 Bayer）
//   pxol=0|1|2        描边：0 无、1 角色 / 敌人、2 角色 + 场景深度边
//   pxdark=0|1        暗色地牢光照（压暗环境、火盆点光、主角周围的光）
//   pxfog=0..1        视野暗角（以主角为中心）
//   pxcon=对比度 pxsat=饱和度 pxsnap=0|1（镜头吸附）
//   pxtel=0|1         敌方预警圈另画一层、不进调色板（边保持清楚、填充保持半透明）
//   pxstep=0|12       角色动画按每秒几帧取样（只改画面：画的时候换成上一个取样点的骨骼，模拟照常）
//   pxdir=0|8|16      角色朝向量化成几个方向（只在画的时候改 group.rotation.y，画完恢复）
//   proto=1           没有 px= 时取预设 d（?proto=1 原型用）
// 页面里：G.px.set({ h: 400, pal: 1, ... }) 现场改，G.px.cfg 当前配置，G.px.stats 最近一帧的 draw / 三角面数
(function () {
  const W = G.world, T = THREE;
  const qs = new URLSearchParams(location.search);
  const PRESET = {
    // A：低分辨率、全彩、原来的光照（只看「像素化」本身）
    a: { h: 400, pal: 0, dith: 0, ol: 0, dark: 0, fog: 0, con: 1.05, sat: 1.05, tel: 1, step: 0, dir: 0 },
    // B：调色板 + 抖动、火光照明（暗）
    b: { h: 320, pal: 1, dith: 0.6, ol: 1, dark: 1, fog: 0.75, con: 1.05, sat: 1.0, tel: 1, step: 0, dir: 0 },
    // C：低分辨率 + 描边、高对比（暗，不量化）
    c: { h: 400, pal: 0, dith: 0, ol: 2, dark: 1, fog: 0.55, con: 1.18, sat: 1.1, tel: 1, step: 0, dir: 0 },
    // D：折中（?proto=1 用这一套）：360 高、调色板（轻抖动）、角色描边 + 场景深度边、暗色光照、视野暗角、预警圈不量化、动画 12 帧 / 秒、朝向 8 方向
    d: { h: 360, pal: 1, dith: 0.3, ol: 2, dark: 1, fog: 0.65, con: 1.1, sat: 1.05, tel: 1, step: 12, dir: 8 },
  };
  let pid = (qs.get('px') || (qs.has('proto') && qs.get('proto') !== '0' ? 'd' : 'a')).toLowerCase();
  if (!PRESET[pid]) pid = 'a';
  const cfg = Object.assign({ id: pid, snap: 1 }, PRESET[pid]);
  const num = (k, key) => {
    if (qs.has(k) && qs.get(k) !== '' && isFinite(+qs.get(k))) cfg[key] = +qs.get(k);
  };
  num('pxh', 'h'); num('pxpal', 'pal'); num('pxdith', 'dith'); num('pxol', 'ol'); num('pxdark', 'dark');
  num('pxfog', 'fog'); num('pxcon', 'con'); num('pxsat', 'sat'); num('pxsnap', 'snap');
  num('pxtel', 'tel'); num('pxstep', 'step'); num('pxdir', 'dir');

  // ----- 色板：自己定的 48 色暗色地牢色板（冷紫灰的石头、暖褐的土、火 / 余烬、敌对的血红、冷色魔法、毒绿 / 青、奥术紫、腐肉粉、皮肤、黄绿） -----
  const PAL = [
    0x07060a, 0x120e16, 0x1c1722, 0x2a2430, 0x3a3340, 0x4e4654, 0x655c69, 0x82797f, 0xa39a98, 0xcfc6bb, // 石头 / 骨白
    0x2a1a14, 0x40281c, 0x5c3a24, 0x7c5232, 0xa0703e, // 土 / 木
    0x5a1a12, 0x8c2a16, 0xc4441c, 0xe8702a, 0xf6a443, 0xffd37a, 0xfff1c8, // 余烬 / 火（近白只给最亮的火芯）
    0x6e1420, 0xa82230, 0xe0404a, // 敌对红
    0x14203a, 0x23385c, 0x3a5c8a, 0x6a94c4, 0xa8d0f0, // 冷色 / 冰 / 法术
    0x163428, 0x2a5a40, 0x4c8a5a, 0x2a6a6c, 0x58b0a8, // 毒绿 / 青
    0x2c1840, 0x4a2a6c, 0x7a4ab0, 0xb08ae0, // 奥术紫
    0x6a3a48, 0xa8606e, 0xd898a0, // 腐肉 / 粉（游魂这类敌人的本色不丢）
    0x9a6a4e, 0xd4a07a, // 皮肤
    0x6e7a24, 0xb0c03e, // 黄绿（喷吐者这类敌人）
    0x5e4a52, 0x8c7472, // 暖灰紫（受火光照的石地，过渡不跳色）
  ];
  const palV = PAL.map((h) => new T.Vector3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255));

  // ----- 低分辨率处理：描边 → 调色 → 视野暗角 → 调色板 + 抖动（输入输出都是显示空间 sRGB） -----
  const procMat = new T.ShaderMaterial({
    uniforms: {
      tCol: { value: null }, tAll: { value: null }, uTel: { value: 0 }, tDep: { value: null }, uSrc: { value: new T.Vector2(1, 1) },
      uNear: { value: 2 }, uFar: { value: 240 }, uOl: { value: 0 }, uPal: { value: palV }, uPalOn: { value: 0 }, uDith: { value: 0 },
      uCon: { value: 1 }, uSat: { value: 1 }, uFog: { value: 0 }, uHero: { value: new T.Vector2(0.5, 0.5) }, uAsp: { value: 1.6 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tCol, tAll, tDep; uniform vec2 uSrc, uHero; uniform float uNear, uFar, uOl, uPalOn, uDith, uCon, uSat, uFog, uAsp, uTel;',
      'uniform vec3 uPal[' + PAL.length + '];',
      'varying vec2 vUv;',
      'float lin(float d){ return uNear * uFar / (uFar - d * (uFar - uNear)); }',
      // 4×4 Bayer（位交错公式）：0..1
      'float bayer2(vec2 a){ a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }',
      'float bayer(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }',
      'void main(){',
      '  vec2 px = 1.0 / uSrc;',
      '  vec4 s = texture2D(tCol, vUv); vec3 c = s.rgb; float isC = step(s.a, 0.5);', // alpha < 0.5 = 角色像素（world.js 的 AO_MARK）
      '  float d = lin(texture2D(tDep, vUv).r);',
      '  vec2 o[4]; o[0] = vec2(px.x, 0.0); o[1] = vec2(-px.x, 0.0); o[2] = vec2(0.0, px.y); o[3] = vec2(0.0, -px.y);',
      '  float edgeC = 0.0, edgeW = 0.0;',
      '  for (int k = 0; k < 4; k++) {',
      '    vec4 n = texture2D(tCol, vUv + o[k]); float dn = lin(texture2D(tDep, vUv + o[k]).r);',
      '    if (uOl > 0.5 && isC < 0.5 && n.a < 0.5 && dn < d) edgeC = 1.0;', // 角色外面一圈 1 像素
      '    if (uOl > 1.5 && isC < 0.5 && n.a >= 0.5 && (d - dn) > 0.025 * dn + 0.12) edgeW = 1.0;', // 场景深度边：邻居明显在前面
      '  }',
      // 亮的像素（火、预警圈、技能芯）不压：它们要在暗处跳出来
      '  float br = smoothstep(0.55, 0.85, max(c.r, max(c.g, c.b)));',
      '  c = (c - 0.5) * uCon + 0.5;',
      '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
      '  c = mix(vec3(l), c, uSat);',
      // 视野暗角：以主角为中心的椭圆，外圈压到 25%；角色像素和亮像素少压一些
      '  if (uFog > 0.0) {',
      '    vec2 q = (vUv - uHero) * vec2(uAsp, 1.0);',
      '    float f = smoothstep(0.28, 0.95, length(q));',
      '    float keep = max(br, isC * 0.6);',
      '    c *= mix(1.0, 0.22, f * uFog * (1.0 - keep));',
      '  }',
      '  c = mix(c, c * 0.45, edgeW);',
      '  c = mix(c, vec3(0.03, 0.02, 0.045), edgeC);',
      '  c = clamp(c, 0.0, 1.0);',
      '  if (uPalOn > 0.5) {',
      '    c += (bayer(gl_FragCoord.xy) - 0.5) * uDith * 0.14;',
      '    float best = 1e9; vec3 bc = c;',
      '    for (int k = 0; k < ' + PAL.length + '; k++) { vec3 e = c - uPal[k]; float dd = dot(e * e, vec3(0.3, 0.55, 0.15)); if (dd < best) { best = dd; bc = uPal[k]; } }',
      '    c = bc;',
      '  }',
      // 预警圈层：tAll = 场景 + 敌方预警圈，tCol = 不带预警圈的场景；差值原样叠回（不量化、不压暗角）：红边清楚，填充仍是半透明的一层
      '  if (uTel > 0.5) c = clamp(c + texture2D(tAll, vUv).rgb - s.rgb, 0.0, 1.0);',
      '  gl_FragColor = vec4(c, 1.0);',
      '}',
    ].join('\n'),
    depthTest: false, depthWrite: false,
  });
  // ----- 放大到画布：锐利放大（像素内部取同一个纹素，边界上过渡 1 个屏幕像素，非整数倍也不会一列宽一列窄） -----
  const upMat = new T.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uSrc: { value: new T.Vector2(1, 1) }, uDst: { value: new T.Vector2(1, 1) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tSrc; uniform vec2 uSrc, uDst; varying vec2 vUv;',
      'void main(){',
      '  vec2 t = vUv * uSrc; vec2 c = floor(t) + 0.5; vec2 d = clamp((t - c) * (uDst / uSrc), -0.5, 0.5);',
      '  gl_FragColor = vec4(texture2D(tSrc, (c + d) / uSrc).rgb, 1.0);',
      '}',
    ].join('\n'),
    depthTest: false, depthWrite: false,
  });
  const qCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new T.Mesh(new T.PlaneGeometry(2, 2), procMat);
  quad.frustumCulled = false;
  const qScene = new T.Scene();
  qScene.add(quad);
  const copyMat = new T.ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }',
    depthTest: false, depthWrite: false, blending: T.NoBlending,
  });
  // 敌方预警圈另画的那一层：画的时候把预警圈的网格挪进这个场景（自己的灯光状态，主场景的着色器不因此换程序），画完挪回去
  const teleScene = new T.Scene();
  const mk0 = W.makeTelegraph;
  W.makeTelegraph = function (spec, friendly) {
    const h = mk0.apply(this, arguments);
    if (h && h.mesh && !friendly) h.mesh.userData.pxTele = 1;
    return h;
  };

  let rtA = null, rtB = null, rtS = null, rw = 0, rh = 0;
  function targets() {
    const v = W._px.view();
    const h = Math.max(90, Math.round(cfg.h)), w = Math.max(90, Math.round((h * v.vw) / v.vh));
    if (rtA && w === rw && h === rh) return;
    if (rtA) (rtA.dispose(), rtB.dispose(), rtS.dispose());
    rw = w;
    rh = h;
    rtA = W._px.displayRT(new T.WebGLRenderTarget(w, h, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, format: T.RGBAFormat, type: T.UnsignedByteType }));
    rtA.depthTexture = new T.DepthTexture(w, h);
    rtB = new T.WebGLRenderTarget(w, h, { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat, type: T.UnsignedByteType, depthBuffer: false });
    rtS = new T.WebGLRenderTarget(w, h, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, format: T.RGBAFormat, type: T.UnsignedByteType, depthBuffer: false });
    rtS.texture.internalFormat = 'RGBA8';
  }

  // ----- 暗色地牢光照：火盆点光（固定 4 盏，换区不重编着色器）、主角的暖光、压暗的环境 / 主光 / 雾 -----
  const NT = 4, torches = [];
  const DARK = { hemi: 0.3, sun: 0.42, fill: 0.55, exp: 0.92, lampI: 5.5, lampD: 13, torchI: 7, torchD: 11, fog: 0x060509, fogK: 0.85 };
  const _c = new T.Color(), _v = new T.Vector3(), _r = new T.Vector3(), _u = new T.Vector3(), _p = new T.Vector3();
  const init0 = W.init;
  W.init = function () {
    const r = init0.apply(this, arguments);
    for (let i = 0; i < NT; i++) {
      const L = new T.PointLight(0xff9a48, 0, DARK.torchD, 2);
      L.userData = { ph: G.vr() * 6.283, fl: 1 };
      W.scene.add(L);
      torches.push(L);
    }
    return r;
  };
  function placeTorches(on, dt) {
    const F = W._px.fires(), P = G.player, list = (on && F && F.list) || [];
    const near = list.map((f) => ({ f, d: (f.x - P.x) * (f.x - P.x) + (f.z - P.z) * (f.z - P.z) })).filter((o) => o.d < 22 * 22).sort((a, b) => a.d - b.d);
    for (let i = 0; i < NT; i++) {
      const L = torches[i], o = near[i];
      if (!o) {
        L.intensity = 0;
        continue;
      }
      // 闪烁：低通过的画面随机数（G.vr），加一点慢的正弦
      const u = L.userData;
      u.fl += (0.75 + G.vr() * 0.5 - u.fl) * Math.min(1, dt * 14);
      const t = performance.now() * 0.001;
      L.position.set(o.f.x, (o.f.y || 0) + 1.1, o.f.z);
      L.intensity = DARK.torchI * u.fl * (0.9 + 0.1 * Math.sin(t * 5.3 + u.ph));
      L.distance = DARK.torchD;
    }
  }

  let lastT = 0, lastSim = -1, vt = 0, tMove = 0;
  const st = { draws: 0, tris: 0, ms: 0, tele: 0, ents: 0 };
  const ents = [], teles = [];
  // 动画步进：每个实体记一份「上一个取样点」的骨骼和身体变换；新动作开始（ent.clip 换了）立刻取样，读招不晚
  function holdEnt(e, key) {
    let h = e._pxH;
    if (!h || h.b.length !== e.bones.length) h = e._pxH = { k: -1, clip: null, b: new Float32Array(e.bones.length), p: new T.Vector3(), q: new T.Quaternion(), s: new T.Vector3(), lp: new T.Vector3(), lq: new T.Quaternion(), ls: new T.Vector3() };
    if (h.k !== key || h.clip !== e.clip) {
      h.k = key;
      h.clip = e.clip;
      h.b.set(e.bones);
      h.p.copy(e.body.position);
      h.q.copy(e.body.quaternion);
      h.s.copy(e.body.scale);
    }
    h.lp.copy(e.body.position);
    h.lq.copy(e.body.quaternion);
    h.ls.copy(e.body.scale);
    e.uBones.value = h.b;
    e.body.position.copy(h.p);
    e.body.quaternion.copy(h.q);
    e.body.scale.copy(h.s);
  }
  function unholdEnt(e) {
    const h = e._pxH;
    e.uBones.value = e.bones;
    if (!h) return;
    e.body.position.copy(h.lp);
    e.body.quaternion.copy(h.lq);
    e.body.scale.copy(h.ls);
  }
  // 画布的像素比：放大那一步要至少 2 倍于低分辨率目标，像素才是整齐的方块（手机「低」档画布只有 341 高，比 360 的目标还小，
  // 不改就成了缩小、糊掉）。只多一道放大的开销，场景本身画在低分辨率目标里。换算：画布高 ≥ 2 × 目标高，最多到设备像素比
  function pxCanvas() {
    const R = W.renderer, v = W._px.view();
    if (!R || !W.pxRender) return;
    const want = Math.min(window.devicePixelRatio || 1, Math.max(v.glDpr, (2 * Math.max(90, Math.round(cfg.h))) / Math.max(1, v.vh)));
    if (Math.abs(R.getPixelRatio() - want) > 1e-3) R.setPixelRatio(want);
  }
  const rs0 = W.resize;
  W.resize = function () {
    const r = rs0.apply(this, arguments);
    pxCanvas();
    return r;
  };
  function pxRender() {
    const R = W.renderer, S = W.scene, cam = W.camera, H = W._px, v = H.view();
    targets();
    pxCanvas();
    const now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016;
    lastT = now;
    // 画面时钟：模拟在走就跟模拟时间（逐帧截图可复现）；模拟停了半秒以上（菜单、暂停）才跟真实时间，同一步里多画几次不算时间
    const simT = G.state && G.state.time;
    const dSim = lastSim >= 0 && typeof simT === 'number' ? simT - lastSim : -1;
    if (dSim > 0 && dSim < 0.5) (vt += dSim), (tMove = now);
    else if (dSim !== 0 || now - tMove > 500) vt += dt;
    lastSim = typeof simT === 'number' ? simT : -1;
    // 存一份会改的值，画完恢复
    const s0 = { hemi: H.hemi.intensity, sun: H.sun.intensity, fill: H.fill.intensity, li: H.lamp.intensity, ld: H.lamp.distance, exp: R.toneMappingExposure, fog: S.fog.color.getHex(), bg: S.background.getHex(), ps: H.pScale.value, ao: H.aoMark.value };
    const p0 = cam.position.clone();
    const dark = cfg.dark > 0;
    if (dark) {
      H.hemi.intensity *= DARK.hemi;
      H.sun.intensity *= DARK.sun;
      H.fill.intensity *= DARK.fill;
      H.lamp.intensity = DARK.lampI;
      H.lamp.distance = Math.min(H.lamp.distance, 16) * (DARK.lampD / 16);
      R.toneMappingExposure *= DARK.exp;
      _c.setHex(s0.fog).lerp(_c.clone().setHex(DARK.fog), DARK.fogK);
      S.fog.color.copy(_c);
      S.background.copy(_c);
    }
    placeTorches(dark, dt);
    // 粒子按世界单位换算像素：换成低分辨率目标的高
    H.pScale.value = s0.ps * (rh / Math.max(1, v.vh * v.glDpr));
    H.aoMark.value = 1; // 角色像素在 alpha 里记 0（描边用）
    // 实体（角色 / 敌人）和敌方预警圈
    ents.length = teles.length = 0;
    for (const o of S.children) {
      const ud = o.userData;
      if (ud.pxEnt && !ud.pxEnt.removed) ents.push(ud.pxEnt);
      else if (ud.pxTele && o.visible && cfg.tel) teles.push(o);
    }
    const key = cfg.step > 0 ? Math.floor(vt * cfg.step) : 0;
    const dq = cfg.dir > 0 ? (Math.PI * 2) / cfg.dir : 0;
    for (const e of ents) {
      if (cfg.step > 0 && !e.dying) holdEnt(e, key);
      if (dq) {
        e._pxR = e.group.rotation.y;
        e.group.rotation.y = Math.round(e._pxR / dq) * dq;
      }
    }
    for (const m of teles) S.remove(m);
    // 镜头吸附到低分辨率像素网格（焦平面上 1 像素多少米）
    if (cfg.snap) {
      cam.updateMatrixWorld();
      _r.set(1, 0, 0).applyQuaternion(cam.quaternion);
      _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const P = G.player;
      const D = _p.set(P.x, 1, P.z).sub(cam.position).dot(_v.set(0, 0, -1).applyQuaternion(cam.quaternion));
      const m = (2 * D * Math.tan((cam.fov * Math.PI) / 360)) / rh;
      const a = cam.position.dot(_r), b = cam.position.dot(_u);
      cam.position.addScaledVector(_r, Math.round(a / m) * m - a).addScaledVector(_u, Math.round(b / m) * m - b);
      cam.updateMatrixWorld();
    }
    // 主角在画面里的位置（视野暗角的中心）
    _p.set(G.player.x, 1, G.player.z).project(cam);
    R.setRenderTarget(rtA);
    R.render(S, cam);
    st.draws = R.info.render.calls;
    st.tris = R.info.render.triangles;
    st.tele = teles.length;
    st.ents = ents.length;
    // 预警圈层：先把不带预警圈的场景存一份，再把预警圈画进 rtA（深度测试用 rtA 的深度，角色挡得住）
    if (teles.length) {
      copyMat.uniforms.tSrc.value = rtA.texture;
      quad.material = copyMat;
      R.setRenderTarget(rtS);
      R.render(qScene, qCam);
      for (const m of teles) teleScene.add(m);
      const ac = R.autoClear, su = R.shadowMap.autoUpdate;
      R.autoClear = false;
      R.shadowMap.autoUpdate = false;
      R.setRenderTarget(rtA);
      R.render(teleScene, cam);
      R.autoClear = ac;
      R.shadowMap.autoUpdate = su;
      for (const m of teles) S.add(m);
    }
    // 恢复
    for (const e of ents) {
      if (cfg.step > 0) unholdEnt(e);
      if (dq) e.group.rotation.y = e._pxR;
    }
    cam.position.copy(p0);
    cam.updateMatrixWorld();
    H.hemi.intensity = s0.hemi;
    H.sun.intensity = s0.sun;
    H.fill.intensity = s0.fill;
    H.lamp.intensity = s0.li;
    H.lamp.distance = s0.ld;
    R.toneMappingExposure = s0.exp;
    S.fog.color.setHex(s0.fog);
    S.background.setHex(s0.bg);
    H.pScale.value = s0.ps;
    H.aoMark.value = s0.ao;
    for (const L of torches) L.intensity = 0; // 火盆点光只在这一帧亮（关掉 px 时原来的画面不受影响）
    // 低分辨率处理
    const u = procMat.uniforms;
    u.tCol.value = teles.length ? rtS.texture : rtA.texture;
    u.tAll.value = rtA.texture;
    u.uTel.value = teles.length ? 1 : 0;
    u.tDep.value = rtA.depthTexture;
    u.uSrc.value.set(rw, rh);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uOl.value = cfg.ol;
    u.uPalOn.value = cfg.pal;
    u.uDith.value = cfg.dith;
    u.uCon.value = cfg.con;
    u.uSat.value = cfg.sat;
    u.uFog.value = cfg.fog;
    u.uHero.value.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
    u.uAsp.value = rw / rh;
    quad.material = procMat;
    R.setRenderTarget(rtB);
    R.render(qScene, qCam);
    // 放大到画布
    R.setRenderTarget(null);
    const sz = R.getDrawingBufferSize(_v2);
    upMat.uniforms.tSrc.value = rtB.texture;
    upMat.uniforms.uSrc.value.set(rw, rh);
    upMat.uniforms.uDst.value.set(sz.x, sz.y);
    quad.material = upMat;
    R.render(qScene, qCam);
    st.ms = performance.now() - now;
  };
  W.pxRender = pxRender;
  // ?proto=1 原型：第 1 区（灰烬荒原）用开放式地图（js/openmap.js 换掉了它的生成器）的种子 808（map-open 推荐的那一张），其它区照常随机
  if (/[?&]proto=1\b/.test(location.search)) {
    const bz0 = W.buildZone;
    W.buildZone = function (def) {
      W.pinZoneSeed(def && def.id === 'ash' && G.openMap ? 808 : null);
      try {
        return bz0.apply(this, arguments);
      } finally {
        W.pinZoneSeed(null);
      }
    };
  }
  const _v2 = new T.Vector2();
  G.px = {
    cfg,
    stats: st,
    dark: DARK,
    palette: PAL,
    size: () => [rw, rh],
    set(o) {
      Object.assign(cfg, o || {});
      return Object.assign({}, cfg);
    },
    // 实验工具用：整条像素管线开 / 关（关掉时画布像素比回到游戏自己的值）
    enable(on) {
      W.pxRender = on ? pxRender : null;
      W.resize();
      return !!W.pxRender;
    },
    preset(id) {
      if (!PRESET[id]) return null;
      Object.assign(cfg, PRESET[id], { id });
      return Object.assign({}, cfg);
    },
  };
})();
