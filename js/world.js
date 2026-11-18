'use strict';
// world.js —— 全部 THREE 渲染：场景/相机/灯光、区域生成与主题化外观、可行走判定、
// 实体模型、投射物、预警圈、掉落物、传送门、特效、飘字，以及 2D 叠加层（血条/掉落标签/小地图）
(function () {
  const G = window.G;
  const T = THREE;
  const W = (G.world = {});
  const TAU = Math.PI * 2;
  const rand = G.rand;

  let renderer, scene, camera, hemi, sun, fill, lamp, fxLight, portalLight;
  let ocv, octx;
  let vw = 1, vh = 1, dpr = 1;
  let wtime = 0;

  // 复用的临时对象：热路径里不做任何分配
  const _v = new T.Vector3(), _v2 = new T.Vector3(), _s = new T.Vector3();
  const _c = new T.Color(), _c2 = new T.Color();
  const _m4 = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler();
  const UP = new T.Vector3(0, 1, 0);
  const _pr = { x: 0, y: 0, ok: false };

  // 镜头：固定朝向的俯视（等距感），只平移不旋转。调镜头只改 CAMERA（调试时可以 G.world.setCamera({ ... }) 现场试）：
  //   pitch 俯角（度，从水平面往下）、dist 镜头到焦点的距离、fov 竖直视角（度）、lookY 焦点离地高度、
  //   lead 焦点向屏幕下方（+z）让出的距离：玩家因此站在画面中线偏上，脚下能看到的范围和头顶差不多（底部还有技能栏要占掉一截）、
  //   fogNear / fogFar 雾的起止（相对镜头的距离）、shadow 阴影贴图覆盖的半宽（镜头近了可以收小，阴影更清楚）
  // 旧镜头：pitch ≈ 53.5、dist ≈ 28.6、fov 38、lead 3、雾 27～64（主角在 900 高的画面里约 54 像素）
  const CAMERA = { pitch: 50, dist: 21, fov: 34, lookY: 1, lead: 2.2, fogNear: 22, fogFar: 52, shadow: 22 };
  const CAM_OFF = new T.Vector3();
  let CAM_LEAD = CAMERA.lead;
  function camDerive() {
    const a = (CAMERA.pitch * Math.PI) / 180;
    CAM_OFF.set(0, CAMERA.lookY + Math.sin(a) * CAMERA.dist, Math.cos(a) * CAMERA.dist);
    CAM_LEAD = CAMERA.lead;
  }
  camDerive();
  const HUD_BAND = 140; // 画面底部被技能栏 / 血球占住的高度（CSS 像素），W.inView 把它当作看不见
  const VIEW_PAD = 36; // W.inView 的屏幕边距
  // 主光从左上方略偏镜头一侧打下来：角色身上有一条清楚的明暗交界线，影子落向右上（角色身后），不压在脚前
  const SUN_OFF = new T.Vector3(-17, 27, 9);
  let SHADOW_HALF = CAMERA.shadow;
  const HEMI_I = 0.46; // 旧的半球光强度（ZONE_LIGHT 没写 hemiI 时用）
  let hemiBase = HEMI_I;
  const camT = new T.Vector3();
  let camSnap = true;
  let shakeAmt = 0;
  let BASE_FOV = CAMERA.fov;
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

  // =====================================================================
  // 卡通渲染基础（toon）：所有角色 / 环境共用的光照阶梯、色调曲线、轮廓光、笔触噪声、竖向渐变。
  // 这里的数字是唯一的出处，调风格只改这一节。
  //  · 光照阶梯：改的是 three 的 ShaderChunk（全局），所以每一个 MeshStandardMaterial（地面、岩石、布景、角色、掉落物）
  //    的直射光都变成 2～3 级的软阶梯；某个材质不要阶梯时 defines.TOON_OFF = 1，要更软的阶梯时 defines.TOON_SOFT = '0.2'。
  //  · 阴影的颜色不是黑灰：背光面 / 阴影里只剩环境光（半球光），半球光的天空色就是这个区域的「阴影色」（冷紫 / 冷蓝），
  //    地面色是暖色的反光；主光照到的地方环境光压到 TOON.ambLit，受光面是干净的暖色。见 ZONE_LIGHT。
  //  · 色调曲线：保持色相的高光肩部 + 一点饱和度（CustomToneMapping），低画质（没有后期）也是同一套颜色。
  //  · 轮廓光：角色材质（injectLit）按补光（第二盏方向光，镜头对面）的方向在背光一侧的边缘勾一道冷色光，强度 TOON.rimK。
  //  · makeToonMat / toonPatch / toonBrushTex / toonGradient / toonCast：给环境与角色工作用的工具，见各自注释。
  // =====================================================================
  const TOON = {
    // 阶梯：dot(N, L) 过 t1 进入中间调（亮度 mid），过 t2 进入受光面；soft 是每一级边缘的软化半宽
    t1: 0.0, t2: 0.42, mid: 0.56, soft: 0.07,
    ambLit: 0.3, // 主光照到的地方环境光（半球光）只留这么多：受光面是干净的暖色，冷紫只出现在背光面和阴影里（不然暖色会被冷光洗成粉灰）
    spec: 0.35, // 直射高光的倍率（卡通：高光收着，只在金属 / 冰上留一点）
    metal: 0.55, // 金属保留多少固有色（1 = 物理上的全黑漫反射；越小金属越像上了色的漆）
    knee: 0.78, sat: 1.1, // 色调曲线：亮度超过 knee 的部分按指数压向 1（保持色相）；sat 线性空间里的饱和度
    toe: 0.09, // 色调曲线的暗部：f(x) = x²(1 + toe) / (x + toe)，把暗部往下压、亮部几乎不动（1 → 1），黑色是真的黑，不是灰紫的雾
    // 阴影色（ZONE_LIGHT 的 shade = 半球光天空色、bounce = 地面色）在应用时统一处理：饱和度只留 shadeSat、强度乘 hemiK。
    // 表里写的是「这个区域的阴影偏什么色」，这两个数决定阴影有多深、多浓（phase 1b：之前阴影太浅太艳，像一层粉紫的雾）
    shadeSat: 0.55, hemiK: 0.55,
    exposure: 1.15, // phase 1b：阴影压深、加了暗部 toe 之后整体提一点曝光，地面回到 25%～35%
    rimK: 0.85, rimLo: 0.56, rimHi: 0.7, // 角色轮廓光：强度、菲涅尔阶梯的起止（越接近 1 越细）
    smoothChars: true, // C 模型用平滑法线（低多边形 + 软阶梯 = 一块块干净的明暗，而不是每个面一块颜色）
  };
  const fNum = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  (function patchToonChunks() {
    const SC = T.ShaderChunk;
    const RAMP = [
      '#ifndef TOON_SOFT',
      '#define TOON_SOFT ' + fNum(TOON.soft),
      '#endif',
      'float toonRamp( const in float x ) {',
      '#ifdef TOON_OFF',
      '\treturn saturate( x );',
      '#else',
      '\treturn ' + fNum(TOON.mid) + ' * smoothstep( ' + fNum(TOON.t1) + ' - TOON_SOFT, ' + fNum(TOON.t1) + ' + TOON_SOFT, x ) + ' +
        fNum(1 - TOON.mid) + ' * smoothstep( ' + fNum(TOON.t2) + ' - TOON_SOFT, ' + fNum(TOON.t2) + ' + TOON_SOFT, x );',
      '#endif',
      '}',
    ].join('\n');
    const rep = (name, a, b) => {
      if (SC[name].indexOf(a) < 0) {
        if (window.console) console.warn('[画面] 卡通着色：' + name + ' 里找不到要替换的片段，这一处保持原样');
        return;
      }
      SC[name] = SC[name].replace(a, b);
    };
    rep('lights_physical_pars_fragment', 'struct PhysicalMaterial {', RAMP + '\nstruct PhysicalMaterial {');
    rep('lights_physical_pars_fragment', 'vec3 irradiance = dotNL * directLight.color;', 'vec3 irradiance = toonRamp( dot( geometry.normal, directLight.direction ) ) * directLight.color;');
    rep(
      'lights_physical_pars_fragment',
      'reflectedLight.directSpecular += ( 1.0 - clearcoatDHR ) * irradiance * BRDF_Specular_GGX( directLight, geometry.viewDir, geometry.normal,',
      'reflectedLight.directSpecular += ( 1.0 - clearcoatDHR ) * ' + fNum(TOON.spec) + ' * irradiance * BRDF_Specular_GGX( directLight, geometry.viewDir, geometry.normal,'
    );
    // 主光（第 0 盏方向光：投影的太阳排在最前）的阶梯值 × 阴影，记下来给环境光用（只对 MeshStandard / Physical）
    rep('lights_fragment_begin', 'GeometricContext geometry;', '#ifdef STANDARD\n\tfloat toonSh = 1.0;\n\tfloat toonKeyLit = 0.0;\n#endif\nGeometricContext geometry;');
    rep(
      'lights_fragment_begin',
      'directLight.color *= all( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( directionalShadowMap[ i ]',
      '#ifdef STANDARD\n\t\ttoonSh =\n#else\n\t\tdirectLight.color *=\n#endif\n\t\tall( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( directionalShadowMap[ i ]'
    );
    rep(
      'lights_fragment_begin',
      'vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\t#endif\n\t\tRE_Direct( directLight, geometry, material, reflectedLight );',
      'vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\t#ifdef STANDARD\n\t\tdirectLight.color *= toonSh;\n\t\t#endif\n\t\t#endif\n\t\tRE_Direct( directLight, geometry, material, reflectedLight );\n' +
        '\t\t#if defined( STANDARD ) && ( UNROLLED_LOOP_INDEX == 0 )\n\t\ttoonKeyLit = toonRamp( dot( geometry.normal, directLight.direction ) ) * toonSh;\n\t\t#endif'
    );
    rep('lights_fragment_end', '#if defined( RE_IndirectDiffuse )\n\tRE_IndirectDiffuse(', '#if defined( STANDARD ) && !defined( TOON_OFF )\n\tirradiance *= mix( 1.0, ' + fNum(TOON.ambLit) + ', toonKeyLit );\n#endif\n#if defined( RE_IndirectDiffuse )\n\tRE_IndirectDiffuse(');
    rep('lights_physical_fragment', 'material.diffuseColor = diffuseColor.rgb * ( 1.0 - metalnessFactor );', 'material.diffuseColor = diffuseColor.rgb * ( 1.0 - metalnessFactor * ' + fNum(TOON.metal) + ' );');
    rep(
      'tonemapping_pars_fragment',
      'vec3 CustomToneMapping( vec3 color ) { return color; }',
      [
        'vec3 CustomToneMapping( vec3 color ) {',
        '\tvec3 c = max( color * toneMappingExposure, 0.0 );',
        '\tc = c * c * ' + fNum(1 + TOON.toe) + ' / ( c + ' + fNum(TOON.toe) + ' );',
        '\tfloat m = max( max( c.r, c.g ), c.b );',
        '\tif ( m > ' + fNum(TOON.knee) + ' ) c *= ( ' + fNum(TOON.knee) + ' + ' + fNum(1 - TOON.knee) + ' * ( 1.0 - exp( -( m - ' + fNum(TOON.knee) + ' ) / ' + fNum(1 - TOON.knee) + ' ) ) ) / m;',
        '\tfloat l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );',
        '\treturn saturate( mix( vec3( l ), c, ' + fNum(TOON.sat) + ' ) );',
        '}',
      ].join('\n')
    );
  })();

  // 笔触噪声贴图（灰度，均值 0.5，四方连续）：几百道带方向的软笔触叠在一层低频斑块上。全局只画一次。
  let toonBrush = null;
  function toonBrushTex() {
    if (toonBrush) return toonBrush;
    const N = 256, c = makeCanvas(N, N), g = c.getContext('2d');
    g.fillStyle = 'rgb(128,128,128)';
    g.fillRect(0, 0, N, N);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // 低频斑块
    for (let i = 0; i < 46; i++) {
      const x = rnd() * N, y = rnd() * N, r = 20 + rnd() * 46, v = rnd() < 0.5 ? 0 : 255, a = 0.05 + rnd() * 0.07;
      for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, `rgba(${v},${v},${v},${a})`);
        gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
        g.fillStyle = gr;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
    // 笔触：大多顺着一个主方向（约 -25°），长 10～34 像素，宽 3～7，明暗各半
    g.lineCap = 'round';
    for (let i = 0; i < 520; i++) {
      const x = rnd() * N, y = rnd() * N, len = 10 + rnd() * 24, a = -0.45 + (rnd() - 0.5) * 0.9, w = 3 + rnd() * 4;
      const v = rnd() < 0.5 ? 0 : 255, al = 0.06 + rnd() * 0.1;
      const dx = Math.cos(a) * len * 0.5, dy = Math.sin(a) * len * 0.5;
      g.strokeStyle = `rgba(${v},${v},${v},${al})`;
      g.lineWidth = w;
      for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
        g.beginPath();
        g.moveTo(x + ox - dx, y + oy - dy);
        g.quadraticCurveTo(x + ox + dy * 0.25, y + oy - dx * 0.25, x + ox + dx, y + oy + dy);
        g.stroke();
      }
    }
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = T.LinearMipmapLinearFilter;
    toonBrush = t;
    return t;
  }

  // toonPatch(material, opts)：给一个已有的 MeshStandardMaterial 加卡通的附加项（保留它原来的 onBeforeCompile）。
  //   brush: 0..1 笔触噪声的明暗幅度（0.15 左右是「看得出是画的」，0.3 是很重的笔触）；brushScale: 每个世界单位重复几次（默认 0.35）；
  //   brushSpace: 'world'（默认，三向投影）| 'object'（跟着网格走：会动的东西用它，免得纹理在身上游动）；
  //   grad: [底色, 顶色, y0, y1]，按世界高度乘一层渐变（十六进制色，乘在固有色上；y0..y1 之间平滑过渡）；
  //   soft: 这个材质的阶梯软化半宽（覆盖 TOON.soft）；off: true 时不要阶梯（物理的 dot(N, L)）。
  // 返回同一个材质。onBeforeCompile 的程序缓存键会带上这些选项，不同选项不会错用同一个着色器程序。
  function toonPatch(mat, o) {
    o = o || {};
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    if (o.soft !== undefined) mat.defines = Object.assign(mat.defines || {}, { TOON_SOFT: fNum(o.soft) });
    if (o.off) mat.defines = Object.assign(mat.defines || {}, { TOON_OFF: 1 });
    const U = {};
    let head = '', body = '', vHead = '', vBody = '';
    if (o.brush) {
      U.tToonBrush = { value: toonBrushTex() };
      U.uToonBrush = { value: new T.Vector2(o.brush, o.brushScale || 0.35) };
      vHead += 'varying vec3 vTbP;\nvarying vec3 vTbN;\n';
      const objSp = o.brushSpace === 'object';
      vBody += objSp
        ? '\tvTbP = position; vTbN = normal;\n'
        : '\tvec4 tbW = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\n\ttbW = instanceMatrix * tbW;\n#endif\n\tvTbP = ( modelMatrix * tbW ).xyz;\n\tvTbN = normalize( mat3( modelMatrix ) * objectNormal );\n';
      head += 'uniform sampler2D tToonBrush;\nuniform vec2 uToonBrush;\nvarying vec3 vTbP;\nvarying vec3 vTbN;\n';
      body +=
        '\t{\n\t\tvec3 bw = pow( abs( normalize( vTbN ) ), vec3( 3.0 ) ); bw /= dot( bw, vec3( 1.0 ) );\n' +
        '\t\tvec3 bp = vTbP * uToonBrush.y;\n' +
        '\t\tfloat bn = texture2D( tToonBrush, bp.zy ).r * bw.x + texture2D( tToonBrush, bp.xz ).r * bw.y + texture2D( tToonBrush, bp.xy ).r * bw.z;\n' +
        '\t\tdiffuseColor.rgb *= 1.0 + ( bn - 0.5 ) * 2.0 * uToonBrush.x;\n\t}\n';
    }
    if (o.grad) {
      const a = lin(o.grad[0]), b = lin(o.grad[1]);
      U.uToonGradA = { value: new T.Vector3(a.r, a.g, a.b) };
      U.uToonGradB = { value: new T.Vector3(b.r, b.g, b.b) };
      U.uToonGradY = { value: new T.Vector2(o.grad[2] || 0, o.grad[3] === undefined ? 2 : o.grad[3]) };
      vHead += 'varying float vTgY;\n';
      vBody += '\tvec4 tgW = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\n\ttgW = instanceMatrix * tgW;\n#endif\n\tvTgY = ( modelMatrix * tgW ).y;\n';
      head += 'uniform vec3 uToonGradA, uToonGradB;\nuniform vec2 uToonGradY;\nvarying float vTgY;\n';
      body += '\tdiffuseColor.rgb *= mix( uToonGradA, uToonGradB, smoothstep( uToonGradY.x, uToonGradY.y, vTgY ) );\n';
    }
    const key = 'toon:' + (o.brush ? 'b' + (o.brushSpace === 'object' ? 'o' : 'w') : '') + (o.grad ? 'g' : '');
    mat.userData.toonU = U;
    mat.onBeforeCompile = function (sh, r) {
      if (prev) prev.call(this, sh, r);
      Object.assign(sh.uniforms, U);
      if (vHead) {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + vHead).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vBody);
        // begin_vertex 可能已经被前一个 onBeforeCompile 换掉了（角色的蒙皮）：那就挂到 project_vertex 前面
        if (sh.vertexShader.indexOf(vBody) < 0) sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', vBody + '#include <project_vertex>');
      }
      if (head) {
        const f0 = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + head);
        // color_fragment 被前一个 onBeforeCompile 换掉了（岩石的三向投影）：挂到 normal_fragment_begin 前面
        sh.fragmentShader = f0.indexOf('#include <color_fragment>') >= 0 ? f0.replace('#include <color_fragment>', '#include <color_fragment>\n' + body) : f0.replace('#include <normal_fragment_begin>', body + '#include <normal_fragment_begin>');
      }
    };
    mat.customProgramCacheKey = () => key + '|' + (prevKey ? prevKey.call(mat) : '') + '|' + (prev ? prev.toString() : '');
    mat.needsUpdate = true;
    return mat;
  }
  // makeToonMat(opts)：环境 / 布景 / 程序化道具用的卡通材质。粗糙度 1、不是金属（没有 PBR 的反光），其余同 toonPatch：
  //   color（十六进制，默认白）、vertexColors（默认 true：顶点色就是画上去的颜色）、map、emissive / emissiveIntensity、
  //   flat（按面着色：硬朗的石头 / 晶体）、side、transparent / opacity、fog（默认 true）、brush / brushScale / brushSpace / grad / soft / off。
  // 例：makeToonMat({ brush: 0.18, grad: [0x4a3a66, 0xffffff, 0, 2.5] }) —— 带笔触、底部压成冷紫的岩石。
  function makeToonMat(o) {
    o = o || {};
    const m = new T.MeshStandardMaterial({
      color: o.color === undefined ? 0xffffff : lin(o.color), vertexColors: o.vertexColors === undefined ? true : !!o.vertexColors,
      roughness: 1, metalness: 0, flatShading: !!o.flat, side: o.side || T.FrontSide,
      transparent: !!o.transparent, opacity: o.opacity === undefined ? 1 : o.opacity, fog: o.fog === undefined ? true : o.fog,
    });
    if (o.map) m.map = o.map;
    if (o.emissive !== undefined) {
      m.emissive = lin(o.emissive);
      m.emissiveIntensity = o.emissiveIntensity === undefined ? 1 : o.emissiveIntensity;
    }
    return o.brush || o.grad || o.soft !== undefined || o.off ? toonPatch(m, o) : m;
  }
  // 竖向渐变（CPU，写进顶点色）：toonGradient(geometry, { bottom, top, y0, y1, k })。顶部偏亮偏暖、底部偏暗偏冷，
  // 乘在已有的 color 属性上（没有就先建一个白色的）；k 是渐变的强度（默认 1）。几何体自己的局部坐标 y。返回同一个几何体。
  function toonGradient(g, o) {
    o = o || {};
    const pos = g.attributes.position, n = pos.count;
    let col = g.attributes.color;
    if (!col) {
      col = new T.BufferAttribute(new Float32Array(n * 3).fill(1), 3);
      g.setAttribute('color', col);
    }
    const a = lin(o.bottom === undefined ? 0x5a4a7a : o.bottom), b = lin(o.top === undefined ? 0xffffff : o.top), k = o.k === undefined ? 1 : o.k;
    let y0 = o.y0, y1 = o.y1;
    if (y0 === undefined || y1 === undefined) {
      if (!g.boundingBox) g.computeBoundingBox();
      if (y0 === undefined) y0 = g.boundingBox.min.y;
      if (y1 === undefined) y1 = g.boundingBox.max.y;
    }
    const span = Math.max(1e-4, y1 - y0);
    for (let i = 0; i < n; i++) {
      const t = smooth01((pos.getY(i) - y0) / span);
      const r = a.r + (b.r - a.r) * t, gg = a.g + (b.g - a.g) * t, bl = a.b + (b.b - a.b) * t;
      col.setXYZ(i, col.getX(i) * (1 + (r - 1) * k), col.getY(i) * (1 + (gg - 1) * k), col.getZ(i) * (1 + (bl - 1) * k));
    }
    col.needsUpdate = true;
    return g;
  }
  // 调试 / 截图脚本用（游戏代码直接用上面的函数）
  W.toon = { TOON, makeToonMat, toonPatch, toonGradient, toonBrushTex, toonCast: (c) => toonCast(c) };
  // 角色固有色的统一处理（线性 rgb，原地改 c = [r, g, b]）：太暗的颜色抬到一个带冷紫的底（卡通里没有死黑），饱和度提一点。
  // 程序化骨架（bake1）和 C 模型（cApply）的每个顶点色都过一遍；phase 2 换角色配色时直接改各自的调色板，这里只兜底。
  const TOON_CAST = { floor: 0.03, floorTint: [0.62, 0.55, 1.0], sat: 1.18, max: 0.82 };
  function toonCast(c) {
    let l = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    const S = TOON_CAST.sat;
    for (let k = 0; k < 3; k++) c[k] = Math.max(0, l + (c[k] - l) * S);
    const F = TOON_CAST.floor;
    if (l < F) {
      const t = 1 - l / F; // 0 = 正好在底线上，1 = 纯黑
      for (let k = 0; k < 3; k++) c[k] += F * TOON_CAST.floorTint[k] * t;
      l = F;
    }
    if (l > TOON_CAST.max) for (let k = 0; k < 3; k++) c[k] *= TOON_CAST.max / l;
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
    // 坠星裂谷：glass = 熔融琉璃，胞块带流纹，胞缝是发亮的星辉，暗处散着星屑；amb 'mote' = 缓缓升起的星尘
    rift: { kind: 'glass', cells: 6, fine: 17, crackW: 0.042, crackK: 0.3, glow: 0.36, rough: 0.42, bump: 0.05, emis: 1.05, amb: 'mote', ambRate: 15 },
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
          if (st.kind === 'glass') {
            // 熔融琉璃：胞内顺着一个方向的流纹，胞缝透出星辉的淡青；整体压暗，让发光的裂缝跳出来
            const flow = 0.5 + 0.5 * Math.sin(((x * 0.7 + y * 0.45) / S) * TAU * 3 + a * 6 + vor.id[i] * 4);
            shade *= (0.78 + 0.16 * flow) * (1 - 0.22 * hair) * (0.82 + 0.3 * vor.id[i] * vor.id[i]);
            r += crack * 12; g += crack * 28; bl += crack * 20;
          } else if (st.kind === 'ice') {
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
          let gl = vor ? crack * smooth01((b - (1 - st.glow - 0.12)) / 0.2) : rune;
          if (st.kind === 'glass') {
            // 星辉：所有胞缝都隐隐发亮（主裂缝更亮），胞内暗处散着成簇的星屑
            const dust = hash2((x >> 1) + seed * 3, (y >> 1) * 7 + 11) > 0.9965 ? 1 - crack : 0;
            gl = Math.max(gl, crack * (0.05 + 0.25 * smooth01((a - 0.5) * 3)) + hair * 0.04, dust * 0.9);
          }
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

  // =====================================================================
  // 画面升级：CC0 PBR 地面 / 岩壁材质、CC0 布景模型、后期处理（泛光 + 调色 + 暗角）、画质档位。
  // 外部素材都是可选的：没加载到（或加载失败）时一切照旧走上面的程序化外观。素材来源见 assets/README.md
  // =====================================================================
  // 每个区域：packs 用到的素材包（js/assets/*.js）；
  // mats 地面三套材质 0 路面（可行走）/ 1 粗糙地面（路外过渡带、路上零星的斑块）/ 2 岩壁与虚空：
  //   tex 贴图 id，tile 一张贴图铺多少世界单位，con 贴图明暗起伏（0 纯色 / 1 原样），nrm 法线强度，rough 粗糙度倍率，sat 饱和度（缺省 1），
  //   k 亮度（乘在区域配色上：路面 = path，粗糙地面 = path 与 rock 之间，岩壁 = rock 与 voidc 之间）
  // lava：mode 1 = 路面的裂缝（高度低处）发光；mode 2 = 粗糙地面贴图的 R 通道就是自发光（熔岩流）
  // rock：岩石 / 岩壁的三向投影贴图；cap = 朝上的面盖一层（雪 / 灰），capAll = 程序化岩石也盖
  // grade：调色（sat 饱和度、con 对比度、lift 暗部偏色、gain 亮部增益、vig 暗角）；bloom：th 阈值、k 强度、r 半径
  // mist：贴地薄雾（只在路外的虚空上）；prop：布景模型的统一着色（tint 乘色、sat 保留原调色板饱和度的比例）
  // props：布景模型 [模型 key, 权重, 最小缩放, 最大缩放, 标记]；标记 t = 高（南缘不放）、r = 用岩石材质、l = 平放在地上（抬到贴地）
  //   outer 外圈（替换程序化摆件，keep = 程序化摆件保留的比例）、mid 中圈（midK 的概率替换程序化岩石）、
  //   edge 紧贴路边的小物件、fire 路边的火盆 / 灯（会发光）、boss 首领场地外的大件
  const ZONE_GFX = {
    ash: {
      packs: ['zone-ash', 'rock-dark', 'models'],
      mats: [
        // 卡通：路面是暗一档的灰褐焦土（不再是粉褐色），贴图的明暗起伏压低，地面不抢角色；路外是更暗、偏灰紫的灰土
        { tex: 'mud_cracked_dry_03', tile: 4.2, con: 0.45, nrm: 0.5, rough: 1, k: 0.68, sat: 0.85, col: 0x575358 }, // 偏冷的灰：被暖金色的主光一照就是灰褐，不是橙粉
        { tex: 'burned_ground_01', tile: 4.8, con: 0.6, nrm: 0.7, rough: 1, k: 0.62, sat: 0.9, col: 0x4a474e },
        { tex: 'dark_rock', tile: 6.5, con: 0.8, nrm: 1.0, rough: 1, k: 0.8, col: 0x2c2226 }, // 岩壁外的虚空地面比路面暗得多，把空地框出来
      ],
      lava: { mode: 1, color: 0xff5a1a, k: 1.7, patch: [0, 0.66] }, // 路面裂缝只在成片的几处发光（patch），不再满地一张发光的网
      rock: { tex: 'dark_rock', tile: 2.6, nrm: 1.2, cap: 0x5e5550, capAll: 0.12 },
      grade: { sat: 1.12, con: 1.1, lift: 0x0a0414, gain: 0xfff6ee, vig: 0.24 },
      bloom: { th: 0.97, k: 0.16, r: 0.32 }, // 卡通：泛光只留给最亮的特效核心，不再给整片画面罩一层雾
      mist: { color: 0x4a2636, a: 0.3 },
      prop: { tint: 0x6e5c54, sat: 0.5 }, // 卡通：布景模型压到岩壁那一档，不比地面亮
      props: {
        // 卡通布景：Kenney 的岩石和树桩去掉（和程序化的倒角岩风格不一致、树桩照片贴图发白），岩石全部是程序化的
        outer: [['kh/tree_dead_large', 3, 0.8, 1.1, 't'], ['kh/tree_dead_medium', 3, 0.9, 1.2, 't'], ['kh/tree_dead_small', 2, 1, 1.3, '']],
        keep: 0,
        mid: [],
        midK: 0,
        // 路边小物件：肋骨架（一个 1240 个三角形）去掉，给起点的植被和碎石腾出三角形预算
        edge: [['kh/skull', 2, 0.5, 0.7, ''], ['kh/bone_A', 3, 0.8, 1.1, 'l'], ['kd/sword_shield_broken', 1, 0.7, 0.9, ''], ['kh/gravemarker_A', 1, 0.8, 1, '']],
        fire: { m: 'kn/campfire_stones', s: 3.2, h: 0.12, color: 0xff7a2a, size: 1.5 },
        boss: [['kh/pillar', 2, 0.75, 0.95, 't'], ['kd/rubble_large', 1, 0.45, 0.6, '']],
      },
    },
    frost: {
      packs: ['zone-frost', 'rock-grey', 'models'],
      mats: [
        { tex: 'Ice002', tile: 7.5, con: 0.38, nrm: 0.55, rough: 0.6, k: 0.5 },
        { tex: 'Snow013', tile: 4.5, con: 0.9, nrm: 1.4, rough: 1, k: 0.45 },
        { tex: 'Rock035', tile: 6.5, con: 1.0, nrm: 1.0, rough: 1, k: 1.0 },
      ],
      lava: null,
      rock: { tex: 'Rock035', tile: 2.8, nrm: 1.1, cap: 0x8296aa, capAll: 0.45 }, // phase 3：雪盖 0xb4c8d6 / 0.6 → 0x8296aa / 0.45，岩壁不再比地面亮
      grade: { sat: 1.12, con: 1.1, lift: 0x04081a, gain: 0xf4faff, vig: 0.22 },
      bloom: { th: 0.97, k: 0.16, r: 0.32 }, // 卡通：泛光只留给最亮的特效核心，不再给整片画面罩一层雾
      mist: { color: 0x3c5566, a: 0.3 },
      prop: { tint: 0x8aa0b0, sat: 0.2 },
      props: {
        outer: [['kn/stone_tallA', 3, 2.6, 3.6, 'tr'], ['kn/rock_tallB', 2, 2.4, 3.2, 'tr'], ['kh/tree_dead_large', 2, 0.8, 1.05, 't'], ['kh/tree_dead_small', 2, 1, 1.3, '']],
        keep: 0.45,
        mid: [['kn/rock_largeB', 1, 1.6, 2.4, 'r'], ['kn/stone_tallC', 1, 2.2, 3, 'r']],
        midK: 0.3,
        edge: [['kh/ribcage', 1, 0.9, 1.2, 'l'], ['kh/bone_A', 3, 0.8, 1.1, 'l'], ['kh/skull', 1, 0.5, 0.7, '']],
        fire: { m: 'kh/lantern_standing', s: 1.3, h: 0.62, color: 0x7fd4ff, size: 0.55 },
        boss: [['kn/statue_ring', 1, 3, 3.6, 't'], ['kn/stone_tallA', 2, 3.2, 4, 'tr']],
      },
    },
    storm: {
      packs: ['zone-storm', 'rock-grey', 'models'],
      mats: [
        { tex: 'monastery_stone_floor', tile: 4.6, con: 0.9, nrm: 1.1, rough: 1, k: 0.8 },
        { tex: 'rocky_trail', tile: 4.8, con: 1.0, nrm: 1.2, rough: 1, k: 0.56 },
        { tex: 'Rock035', tile: 6.5, con: 1.0, nrm: 1.0, rough: 1, k: 1.0 },
      ],
      lava: null,
      rock: { tex: 'Rock035', tile: 2.8, nrm: 1.1, cap: 0, capAll: 0 },
      grade: { sat: 1.12, con: 1.1, lift: 0x080418, gain: 0xfaf6ff, vig: 0.24 },
      bloom: { th: 0.97, k: 0.16, r: 0.32 }, // 卡通：泛光只留给最亮的特效核心，不再给整片画面罩一层雾
      mist: { color: 0x2c2744, a: 0.32 },
      prop: { tint: 0x5f5b74, sat: 0.2 },
      props: {
        outer: [['kd/pillar', 3, 0.7, 0.95, 't'], ['kd/pillar_decorated', 1, 0.7, 0.9, 't'], ['kn/statue_column', 2, 3.4, 4.2, 't'], ['kn/statue_columnDamaged', 3, 3.4, 4.4, ''], ['kd/wall_broken', 2, 0.7, 0.9, 't'], ['kn/statue_obelisk', 1, 4, 5, 't']],
        keep: 0,
        mid: [['kd/rubble_half', 1, 0.45, 0.6, ''], ['kd/column', 1, 0.9, 1.2, '']],
        midK: 0.35,
        edge: [['kd/floor_tile_small_broken_A', 2, 0.5, 0.7, 'l'], ['kd/sword_shield_broken', 1, 0.7, 0.9, ''], ['kn/statue_columnDamaged', 1, 1.6, 2, '']],
        fire: { m: 'kh/lantern_standing', s: 1.4, h: 0.62, color: 0xffe45e, size: 0.6 },
        boss: [['kd/pillar_decorated', 2, 0.8, 1, 't'], ['kd/barrier_column', 1, 0.7, 0.9, '']],
      },
    },
    abyss: {
      packs: ['zone-abyss', 'rock-dark', 'models'],
      mats: [
        { tex: 'dark_rock_02', tile: 5.0, con: 0.85, nrm: 1.1, rough: 1, k: 1.0 },
        { tex: 'Lava001', tile: 6.0, con: 1.0, nrm: 1.0, rough: 1, k: 0.75 },
        { tex: 'dark_rock', tile: 6.5, con: 1.0, nrm: 1.0, rough: 1, k: 1.0 },
      ],
      lava: { mode: 2, color: 0xff3a22, k: 3.0 },
      rock: { tex: 'dark_rock', tile: 2.6, nrm: 1.2, cap: 0, capAll: 0 },
      grade: { sat: 1.12, con: 1.1, lift: 0x0c0412, gain: 0xfff2f0, vig: 0.26 },
      bloom: { th: 0.97, k: 0.16, r: 0.32 }, // 卡通：泛光只留给最亮的特效核心，不再给整片画面罩一层雾
      mist: { color: 0x2e0d12, a: 0.32 },
      prop: { tint: 0x5e4a4c, sat: 0.25 },
      props: {
        outer: [['kh/arch', 1, 0.8, 1, 't'], ['kh/grave_A_destroyed', 3, 1, 1.3, ''], ['kh/pillar', 2, 0.7, 0.9, 't'], ['kn/rock_tallA', 2, 2.4, 3.4, 'tr'], ['kh/tree_dead_medium', 2, 0.9, 1.2, 't']],
        keep: 0.3,
        mid: [['kn/rock_tallG', 1, 2.2, 3, 'r'], ['kn/rock_largeF', 1, 1.8, 2.4, 'r']],
        midK: 0.3,
        edge: [['kh/skull_candle', 1, 0.6, 0.8, ''], ['kh/skull', 2, 0.5, 0.7, ''], ['kh/ribcage', 1, 0.9, 1.2, 'l'], ['kh/gravemarker_A', 2, 0.8, 1, '']],
        fire: { m: 'kn/campfire_stones', s: 3.2, h: 0.12, color: 0xff3a2a, size: 1.6 },
        boss: [['kh/crypt', 1, 0.62, 0.7, 't1'], ['kh/arch', 1, 0.9, 1, 't'], ['kh/pillar', 2, 0.8, 1, 't']],
      },
    },
    rift: {
      packs: ['zone-rift', 'rock-grey', 'models'],
      mats: [
        { tex: 'slate_floor', tile: 5.5, con: 0.8, nrm: 1.0, rough: 0.6, k: 0.7 },
        { tex: 'moon_01', tile: 6.0, con: 1.0, nrm: 1.3, rough: 1, k: 0.46 },
        { tex: 'Rock035', tile: 6.5, con: 1.0, nrm: 1.0, rough: 1, k: 1.0 },
      ],
      lava: null,
      rock: { tex: 'Rock035', tile: 2.8, nrm: 1.1, cap: 0, capAll: 0 },
      grade: { sat: 1.12, con: 1.1, lift: 0x020a10, gain: 0xf2fff8, vig: 0.24 },
      bloom: { th: 0.97, k: 0.16, r: 0.32 }, // 卡通：泛光只留给最亮的特效核心，不再给整片画面罩一层雾
      mist: { color: 0x123a30, a: 0.32 },
      prop: { tint: 0x4c605a, sat: 0.16 },
      props: {
        outer: [['kn/stone_tallA', 3, 2.8, 3.8, 'tr'], ['kn/statue_obelisk', 2, 4, 5.2, 't'], ['kn/statue_ring', 1, 3, 3.6, ''], ['kd/rubble_large', 1, 0.4, 0.55, '']],
        keep: 0.5,
        mid: [['kn/rock_largeD', 1, 1.6, 2.4, 'r'], ['kn/stone_tallC', 1, 2.2, 3, 'r']],
        midK: 0.3,
        edge: [['kd/floor_tile_small_broken_A', 2, 0.5, 0.7, 'l'], ['kn/rock_largeB', 1, 0.6, 0.8, 'r']],
        fire: null,
        boss: [['kn/statue_obelisk', 1, 5, 6, 't'], ['kn/stone_tallA', 2, 3.4, 4.2, 'tr']],
      },
    },
  };

  // ----- 卡通光照的区域配色（toon）：key 主光（暖）、shade 阴影色 = 半球光的天空色（冷紫 / 冷蓝，背光面和阴影里就是这个颜色）、
  //   bounce 半球光的地面色（朝下的面的暖色反光）、rim 补光 / 轮廓光（镜头对面，冷色）、fog 雾和背景色（显示色，不过色调曲线）、
  //   exposure 色调曲线前的曝光。强度：keyI / hemiI / rimI。没写的区域按 G.ZONES 的配色推一套（toonLightOf）。
  //   第 0 区是设计稿里的标准色板；其它区域先保证「亮、饱和、不脏」，细调留给各区域的布景工作 -----
  const ZONE_LIGHT = {
    ash: { key: 0xffc286, keyI: 1.5, shade: 0x6248de, bounce: 0x9a3e22, hemiI: 0.95, rim: 0x8fb6ff, rimI: 0.9, fog: 0x2a1620, exposure: 1.0 },
    frost: { key: 0xffe8cc, keyI: 1.45, shade: 0x4c7ae0, bounce: 0x3a6078, hemiI: 0.9, rim: 0xc8ecff, rimI: 0.85, fog: 0x1a2c3e, exposure: 0.76 },
    storm: { key: 0xffe2a0, keyI: 1.45, shade: 0x5446c8, bounce: 0x5a4468, hemiI: 0.9, rim: 0xe6dcff, rimI: 0.85, fog: 0x221c36, exposure: 0.84 },
    abyss: { key: 0xffcc9c, keyI: 1.45, shade: 0x5038b0, bounce: 0x8a2a30, hemiI: 0.9, rim: 0xff9cb0, rimI: 0.85, fog: 0x2e121c, exposure: 1.0 },
    rift: { key: 0xf0ffe0, keyI: 1.45, shade: 0x3a8cc0, bounce: 0x245a48, hemiI: 0.9, rim: 0xa4ffde, rimI: 0.85, fog: 0x0f2a26, exposure: 0.86 },
  };
  // 阴影色的统一处理（TOON.shadeSat / hemiK）：线性空间里向亮度收饱和度
  function toonShade(hex) {
    const c = lin(hex), l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722, k = TOON.shadeSat;
    return c.setRGB(l + (c.r - l) * k, l + (c.g - l) * k, l + (c.b - l) * k);
  }
  function applyZoneLight(L) {
    scene.background.set(L.fog);
    scene.fog.color.set(L.fog);
    hemi.color.copy(toonShade(L.shade));
    hemi.groundColor.copy(toonShade(L.bounce));
    hemi.intensity = hemiBase = L.hemiI * TOON.hemiK;
    sun.color.copy(lin(L.key));
    sun.intensity = L.keyI;
    fill.color.copy(lin(L.rim));
    fill.intensity = L.rimI;
    renderer.toneMappingExposure = TOON.exposure * (L.exposure || 1);
  }
  // 调试 / 调色用：现场改当前区域的光照或调色（不写回表里，换区域就恢复）。
  //   G.world.toonTune({ light: { keyI: 1.4, shade: 0x6050c0 }, grade: { sat: 1.1 }, bloom: { k: 0.1 } })，返回当前生效的值
  W.toonTune = function (o) {
    o = o || {};
    const def = W.zone && W.zone.def;
    if (!def) return null;
    const L = Object.assign({}, toonLightOf(def), W._toonL && W._toonL.id === def.id ? W._toonL.v : {}, o.light || {});
    W._toonL = { id: def.id, v: L };
    applyZoneLight(L);
    const gx = ZONE_GFX[def.id];
    const gq = { grade: Object.assign({}, gx && gx.grade, (W._toonG && W._toonG.id === def.id && W._toonG.grade) || {}, o.grade || {}), bloom: Object.assign({}, gx && gx.bloom, (W._toonG && W._toonG.id === def.id && W._toonG.bloom) || {}, o.bloom || {}) };
    W._toonG = { id: def.id, grade: gq.grade, bloom: gq.bloom };
    applyZonePost(gq);
    return { light: L, grade: gq.grade, bloom: gq.bloom };
  };
  function toonLightOf(def) {
    return ZONE_LIGHT[def.id] || {
      key: mixHex(0xffffff, def.sky, 0.45), keyI: 1.45, shade: mixHex(0x5a48c8, def.accent, 0.2), bounce: mixHex(def.rock, def.accent, 0.35), hemiI: 0.9,
      rim: mixHex(def.sky, 0xffffff, 0.3), rimI: 0.85, fog: mixHex(def.fog, 0x3a2a4a, 0.4), exposure: 1.0,
    };
  }

  // ----- 画质档位：dpr 像素比上限（高档封顶 1.5：2 倍屏按原生像素渲染再叠多重采样太贵），post 走后期处理（泛光 / 调色 / 暗角），
  //   bloomRes 泛光链的分辨率比例，msaa 后期渲染目标的多重采样，shadow 阴影贴图边长，mist 贴地薄雾 -----
  const QUALITY = {
    high: { dpr: 1.5, post: true, bloom: true, bloomRes: 1, msaa: 4, shadow: 2048, mist: true },
    mid: { dpr: 1.25, post: true, bloom: true, bloomRes: 0.5, msaa: 2, shadow: 1024, mist: false },
    // 低档的 scale：3D 画面按 0.85 倍分辨率渲染（HUD / 血条叠加层仍是原生分辨率）。卡通风格的近镜头让角色、岩壁、粒子在画面里占的像素多了，
    // 第 0 区起点又多了植被；软件 GL 下 3D 画面和 HUD 图标的画布共用同一个 GPU 进程，画面一重，启动时空闲预热图标就慢（实测每个图标 538 → 601 毫秒）。
    // 0.85 倍分辨率 + 低档不画起点的草 / 蕨 / 苔（buildAshDress）之后：图标 508～522 毫秒，混战一帧 226～235 毫秒（改前 main 244），1440×900 / 1280×800 SwiftShader
    low: { dpr: 1, post: false, bloom: false, bloomRes: 1, msaa: 0, shadow: 1024, mist: false, scale: 0.85 },
  };
  let qual = QUALITY.high, qualId = 'high';
  const BLOOM_CAP = 1.1; // 进泛光的单个像素最亮多少（最大分量）
  const post = { composer: null, rt: null, bloom: null, grade: null, ok: false };

  // 最终调色：对比度 / 饱和度 / 暗部偏色 / 亮部增益 / 暗角。画面在渲染目标里已经是显示空间（sRGB）
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null }, uSat: { value: 1 }, uCon: { value: 1 }, uVig: { value: 0.4 }, uAspect: { value: 1.6 },
      uLift: { value: new T.Vector3(0, 0, 0) }, uGain: { value: new T.Vector3(1, 1, 1) },
    },
    vertexShader: 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uSat, uCon, uVig, uAspect; uniform vec3 uLift, uGain; varying vec2 vUv;',
      'void main(){',
      '  vec3 c = max(texture2D(tDiffuse, vUv).rgb, 0.0);',
      // 高光肩部：超过 0.8 的部分按指数压向 1（色调映射过的材质很少到这里，主要压的是不做色调映射的加色特效 + 泛光），
      // 叠在一起的技能不会糊成一整片死白，颜色也保得住
      '  c = mix(c, 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) * 5.0)), step(0.8, c));',
      '  c = (c - 0.5) * uCon + 0.5;',
      '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
      '  c = mix(vec3(l), c, uSat);',
      '  c = c * uGain + uLift * (1.0 - clamp(l, 0.0, 1.0));',
      '  vec2 q = (vUv - vec2(0.5, 0.47)) * vec2(uAspect, 1.0);',
      '  c *= mix(1.0, smoothstep(1.05, 0.32, length(q)), uVig);',
      '  gl_FragColor = vec4(max(c, 0.0), 1.0);',
      '}',
    ].join('\n'),
  };

  function postSize() {
    return { w: Math.max(1, Math.round(vw * dpr)), h: Math.max(1, Math.round(vh * dpr)) };
  }
  function makePostTarget() {
    const { w, h } = postSize();
    const gl2 = renderer.capabilities.isWebGL2;
    const half = gl2 && renderer.extensions.has('EXT_color_buffer_float');
    const opt = { minFilter: T.LinearFilter, magFilter: T.LinearFilter, format: T.RGBAFormat, type: half ? T.HalfFloatType : T.UnsignedByteType, encoding: T.sRGBEncoding };
    let rt;
    if (gl2 && qual.msaa > 0 && T.WebGLMultisampleRenderTarget) {
      rt = new T.WebGLMultisampleRenderTarget(w, h, opt);
      rt.samples = qual.msaa;
    } else rt = new T.WebGLRenderTarget(w, h, opt);
    return rt;
  }
  // 后期处理链：场景（显示空间、HDR 半浮点）→ 泛光 → 调色与暗角 → 屏幕。r128 的材质在渲染到目标时同样做色调映射，
  // 编码跟随目标（sRGB），所以画面和直接渲染到屏幕一致；toneMapped:false 的特效能超过 1，泛光只挑这些
  function initPost() {
    if (!T.EffectComposer || !T.RenderPass || !T.ShaderPass || !T.UnrealBloomPass) return;
    try {
      post.rt = makePostTarget();
      const c = (post.composer = new T.EffectComposer(renderer, post.rt));
      c.addPass(new T.RenderPass(scene, camera));
      const { w, h } = postSize();
      post.bloom = new T.UnrealBloomPass(new T.Vector2(w, h), 0.42, 0.5, 0.93);
      post.bloom.highPassUniforms.smoothWidth.value = 0.12;
      // 泛光的输入封顶（保持色相）：叠在一起的加色特效在半浮点目标里能到 3~5，不封顶的话一团技能会把周围整片晕成白色
      const hp = post.bloom.materialHighPassFilter;
      hp.fragmentShader = hp.fragmentShader.replace(
        'vec4 texel = texture2D( tDiffuse, vUv );',
        'vec4 texel = texture2D( tDiffuse, vUv ); float bMx = max(max(texel.r, texel.g), max(texel.b, 1e-4)); texel.rgb *= min(1.0, ' + BLOOM_CAP.toFixed(2) + ' / bMx);'
      );
      hp.needsUpdate = true;
      // 中档：泛光链按一半分辨率算（UnrealBloomPass 自己再逐级减半），省掉大半泛光开销
      const bSet = post.bloom.setSize.bind(post.bloom);
      post.bloom.setSize = (bw, bh) => bSet(Math.max(2, Math.round(bw * qual.bloomRes)), Math.max(2, Math.round(bh * qual.bloomRes)));
      c.addPass(post.bloom);
      post.grade = new T.ShaderPass(GradeShader);
      c.addPass(post.grade);
      post.ok = true;
    } catch (e) {
      post.ok = false;
      post.composer = null;
      if (window.console) console.warn('[画面] 后期处理初始化失败，改为直接渲染', e);
    }
  }
  // 卡通（phase 1b）：暗部的对比主要交给色调曲线的 toe（低画质没有后期也有），调色里的对比度只用一半
  // phase 3：暗角也只用一半（GRADE_VIG_K）：岩壁都在画面边缘，满强度的暗角会把它们压到 15% 以下（高画质 11.5%，低画质没有暗角是 21%）
  const GRADE_LIFT_K = 0, GRADE_CON_K = 0.5, GRADE_VIG_K = 0.5;
  function applyZonePost(gx) {
    if (!post.ok) return;
    const g = (gx && gx.grade) || { sat: 1.05, con: 1.04, lift: 0, gain: 0xffffff, vig: 0.24 };
    const u = post.grade.uniforms;
    u.uSat.value = g.sat;
    u.uCon.value = 1 + (g.con - 1) * GRADE_CON_K;
    u.uVig.value = g.vig * GRADE_VIG_K;
    // 卡通（phase 1b）：暗部偏色（lift）会把黑色抬成一层灰紫，不再用；表里的 lift 留着不删，乘 GRADE_LIFT_K
    _c.set(g.lift);
    u.uLift.value.set(_c.r, _c.g, _c.b).multiplyScalar(GRADE_LIFT_K);
    _c.set(g.gain);
    u.uGain.value.set(_c.r, _c.g, _c.b);
    const b = (gx && gx.bloom) || { th: 0.97, k: 0.16, r: 0.32 };
    post.bloom.threshold = b.th;
    post.bloom.strength = b.k;
    post.bloom.radius = b.r;
  }
  // 画质：'high' / 'mid' / 'low'。低档不走后期处理（无泛光 / 调色 / 暗角）、阴影贴图减半、像素比 1、不画薄雾
  W.setQuality = function (id) {
    if (!QUALITY[id]) id = G.defaultQuality && QUALITY[G.defaultQuality()] ? G.defaultQuality() : 'high'; // 'auto' 等：按设备推断
    const prev = qual;
    qual = QUALITY[id];
    qualId = id;
    if (!renderer) return id;
    if (sun && sun.shadow.mapSize.x !== qual.shadow) {
      sun.shadow.mapSize.set(qual.shadow, qual.shadow);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    }
    if (post.ok && prev.msaa !== qual.msaa) {
      post.rt = makePostTarget();
      post.composer.reset(post.rt);
    }
    if (post.ok) post.bloom.enabled = qual.bloom;
    if (zoneFx && zoneFx.mist) zoneFx.mist.visible = qual.mist;
    W.resize();
    return id;
  };
  W.quality = () => qualId;
  // 调试 / 测试用：当前画面状态
  W.gfxInfo = () => ({
    quality: qualId, post: !!(post.ok && qual.post), bloom: !!(post.ok && qual.post && qual.bloom), dpr, scale: qual.scale || 1,
    hd: !!(zoneFx && zoneFx.hd), fires: zoneFx && zoneFx.fires ? zoneFx.fires.list.length : 0, mist: !!(zoneFx && zoneFx.mist && zoneFx.mist.visible),
  });

  // ----- 贴图（每个区域进入时从解码好的图像建纹理，离开时释放显存） -----
  let zoneTex = Object.create(null);
  function zoneTexture(id, kind) {
    const key = id + ':' + kind;
    if (zoneTex[key]) return zoneTex[key];
    const im = G.assets.tex(id);
    const t = new T.Texture(im[kind]);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    t.needsUpdate = true;
    own(t);
    return (zoneTex[key] = t);
  }
  const gfxBroken = Object.create(null); // 建 PBR 外观时出过错的区域：之后一直用程序化外观
  // 贴图包（除布景模型包以外）都到了就能换 PBR 地面 / 岩壁；模型包单独判断，没有它就只是不摆 CC0 布景
  const texPacks = (gx) => gx.packs.filter((p) => p !== 'models');
  // 模型包到了且真的解析出了模型（GLTFLoader 缺失时包本身「成功」但一个模型都没有）
  const propsReady = (gx) => !!(G.assets && G.assets.ready(['models']) && gx.props.outer.some((e) => G.assets.geo(e[0])));
  function gfxReady(gx) {
    if (!gx || gfxBroken[gx.packs[0]] || !G.assets || !G.assets.ready(texPacks(gx))) return false;
    for (const m of gx.mats) if (!G.assets.tex(m.tex)) return false;
    return !!G.assets.tex(gx.rock.tex);
  }

  // ----- PBR 地面材质：三套贴图按顶点权重 + 各自的高度图混合，平铺用噪声偏移打散 -----
  const GROUND_FRAG_HEAD = [
    'uniform sampler2D tA0, tN0, tR0, tA1, tN1, tR1, tA2, tN2, tR2;',
    'uniform vec3 uS, uC0, uC1, uC2, uV0, uV1, uV2; uniform vec4 uK0, uK1, uK2;',
    'vec3 gSat(vec3 c, float s) { return mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, s); }',
    'uniform vec4 uLava; uniform vec2 uLavaM, uLavaP; uniform float uVK;',
    'varying vec2 vW; varying vec3 vWp;',
    'float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float gNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y); }',
    // 打散平铺（Quilez 的 texture variation）：按低频噪声在 8 组随机偏移里挑相邻两组采样、按反照率差异混合；三张图用同一组偏移和混合系数
    'void gSample2(sampler2D tA, sampler2D tN, sampler2D tR, vec2 uv, float k, out vec3 a, out vec3 n, out vec3 r) {',
    '  float l = k * 8.0, ia = floor(l), f = fract(l);',
    '  vec2 oa = sin(vec2(3.0, 7.0) * ia), ob = sin(vec2(3.0, 7.0) * (ia + 1.0));',
    '  vec3 a1 = texture2D(tA, uv + oa).rgb, a2 = texture2D(tA, uv + ob).rgb;',
    '  float m = smoothstep(0.2, 0.8, f - 0.1 * dot(a1 - a2, vec3(1.0)));',
    '  a = mix(a1, a2, m);',
    '  n = mix(texture2D(tN, uv + oa).xyz, texture2D(tN, uv + ob).xyz, m);',
    '  r = mix(texture2D(tR, uv + oa).xyz, texture2D(tR, uv + ob).xyz, m);',
    '}',
    'vec3 gLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }',
  ].join('\n');
  const GROUND_MAIN = [
    'vec2 gp = vec2(vWp.x, -vWp.z);',
    'float gk = gNoise(gp * 0.045);',
    'vec3 gw = vec3(vW.x, max(0.0, 1.0 - vW.x - vW.y), vW.y);',
    'vec3 a0 = vec3(0.5), n0 = vec3(0.5, 0.5, 1.0), r0 = vec3(1.0, 0.8, 0.0);',
    'vec3 a1 = a0, n1 = n0, r1 = r0, a2 = a0, n2 = n0, r2 = r0;',
    'if (gw.x > 0.003) gSample2(tA0, tN0, tR0, gp * uS.x, gk, a0, n0, r0);',
    'if (gw.y > 0.003) gSample2(tA1, tN1, tR1, gp * uS.y + 0.37, fract(gk * 1.7 + 0.31), a1, n1, r1);',
    'if (gw.z > 0.003) gSample2(tA2, tN2, tR2, gp * uS.z - 0.21, fract(gk * 2.3 + 0.57), a2, n2, r2);',
    // 高度混合：权重 + 高度，只保留最高的那一截，交界处沿着石缝 / 裂缝走
    'vec3 gh = vec3(r0.b, r1.b, r2.b) + gw;',
    'float ghm = max(max(gh.x, gh.y), gh.z) - 0.22;',
    'vec3 gb = max(gh - ghm, 0.0) * step(0.003, gw);',
    'gb /= max(gb.x + gb.y + gb.z, 1e-4);',
    'vec3 gA = gb.x * gSat(uC0 * mix(vec3(1.0), min(gLin(a0) * uV0, 2.2), uK0.x), uK0.w) + gb.y * gSat(uC1 * mix(vec3(1.0), min(gLin(a1) * uV1, 2.2), uK1.x), uK1.w) + gb.z * gSat(uC2 * mix(vec3(1.0), min(gLin(a2) * uV2, 2.2), uK2.x), uK2.w);',
    'float gAo = dot(gb, vec3(r0.r, uLavaM.x > 1.5 ? 1.0 : r1.r, r2.r));',
    'float gRgh = clamp(dot(gb, vec3(r0.g * uK0.y, r1.g * uK1.y, r2.g * uK2.y)), 0.04, 1.0);',
    'vec3 gn0 = n0 * 2.0 - 1.0, gn1 = n1 * 2.0 - 1.0, gn2 = n2 * 2.0 - 1.0;',
    'gn0.xy *= uK0.z; gn1.xy *= uK1.z; gn2.xy *= uK2.z;',
    'vec3 gnt = normalize(gn0 * gb.x + gn1 * gb.y + gn2 * gb.z);',
    // uv = (x, -z)：切线 = +x，副切线 = -z，法线 = +y
    'vec3 gNv = normalize((viewMatrix * vec4(gnt.x, gnt.z, -gnt.y, 0.0)).xyz);',
    // 熔岩：路面裂缝（高度低处；处处有一点，按低频噪声成片加亮）或熔岩流贴图的自发光；离开路面后跟着顶点色一起熄灭
    'vec3 gLava = vec3(0.0);',
    'if (uLava.a > 0.0) {',
    '  float pulse = 0.72 + 0.28 * sin(uLavaM.y * 1.3 + gNoise(gp * 0.25) * 6.2832);',
    '  float em = uLavaM.x > 1.5 ? r1.r * r1.r * gb.y : (1.0 - smoothstep(0.1, 0.42, r0.b)) * (uLavaP.x + (1.0 - uLavaP.x) * smoothstep(uLavaP.y, uLavaP.y + 0.38, gNoise(gp * 0.09 + 3.1))) * gb.x;',
    '  gLava = uLava.rgb * uLava.a * em * pulse * smoothstep(uVK + 0.02, uVK + 0.35, vColor.g);',
    '  gA *= 1.0 - 0.6 * min(1.0, em);',
    '}',
    'diffuseColor.rgb *= gA * mix(1.0, gAo, 0.75);',
  ].join('\n');
  function groundMaterial(gx, def) {
    const pathL = lin(def.path), rockL = lin(def.rock), voidL = lin(def.voidc);
    const base = [pathL, pathL.clone().lerp(rockL, 0.5), rockL.clone().lerp(voidL, 0.45)];
    // uLavaP：路面裂缝发光的成片程度（处处至少有多少、噪声过多少才开始亮），缺省 (0.3, 0.12)；lava.patch 可按区域改
    const U = { uS: { value: new T.Vector3() }, uLava: { value: new T.Vector4(0, 0, 0, 0) }, uLavaM: { value: new T.Vector2(0, 0) }, uLavaP: { value: new T.Vector2(0.3, 0.12) }, uVK: { value: GROUND_VK } };
    gx.mats.forEach((m, i) => {
      U['tA' + i] = { value: zoneTexture(m.tex, 'albedo') };
      U['tN' + i] = { value: zoneTexture(m.tex, 'normal') };
      U['tR' + i] = { value: zoneTexture(m.tex, 'arh') };
      U.uS.value.setComponent(i, 1 / m.tile);
      U['uC' + i] = { value: (m.col !== undefined ? lin(m.col) : base[i].clone()).multiplyScalar(m.k * 1.25) }; // col：直接给这套材质的颜色（不按区域配色推）
      const avg = G.assets.tex(m.tex).avg;
      U['uV' + i] = { value: new T.Vector3(1 / avg[0], 1 / avg[1], 1 / avg[2]) };
      U['uK' + i] = { value: new T.Vector4(m.con, m.rough, m.nrm, m.sat === undefined ? 1 : m.sat) };
    });
    if (gx.lava) {
      _c.set(gx.lava.color).convertSRGBToLinear();
      U.uLava.value.set(_c.r, _c.g, _c.b, gx.lava.k);
      U.uLavaM.value.x = gx.lava.mode;
      if (gx.lava.patch) U.uLavaP.value.set(gx.lava.patch[0], gx.lava.patch[1]);
    }
    const mat = own(new T.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true }));
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aW;\nvarying vec2 vW;\nvarying vec3 vWp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvW = aW;\n\tvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GROUND_FRAG_HEAD)
        .replace('#include <map_fragment>', GROUND_MAIN)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * gRgh;')
        .replace('#include <normal_fragment_maps>', 'normal = gNv;')
        .replace('#include <tonemapping_fragment>', '#include <tonemapping_fragment>\n\tgl_FragColor.rgb += gLava;');
    };
    mat.userData.U = U;
    return mat;
  }
  const GROUND_VK = 0.34; // 虚空的顶点色亮度（地面外缘向它渐变，虚空底板直接用它）

  // ----- 岩石 / 布景材质：三向投影贴图（岩壁的纹理）+ 法线，按区域着色；布景模型保留一部分原调色板 -----
  const TRI_HEAD = [
    'uniform sampler2D tRA, tRN; uniform float uRS, uRCon, uRNrm, uSat, uCapAll, uCapK; uniform vec3 uRV, uTint, uCapC;',
    'varying vec3 vTriP; varying float vCap;',
    'vec3 tLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }',
  ].join('\n');
  const TRI_MAIN = [
    'vec3 tfN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));',
    'vec3 tWN = normalize((vec4(tfN, 0.0) * viewMatrix).xyz);',
    'vec3 tw = pow(abs(tWN), vec3(4.0)); tw /= dot(tw, vec3(1.0));',
    'vec2 uvX = vTriP.zy * uRS, uvY = vTriP.xz * uRS, uvZ = vTriP.xy * uRS;',
    'vec3 tAl = vec3(0.0); vec3 nX = vec3(0.0, 0.0, 1.0), nY = nX, nZ = nX;',
    'if (tw.x > 0.02) { tAl += texture2D(tRA, uvX).rgb * tw.x; nX = texture2D(tRN, uvX).xyz * 2.0 - 1.0; }',
    'if (tw.y > 0.02) { tAl += texture2D(tRA, uvY).rgb * tw.y; nY = texture2D(tRN, uvY).xyz * 2.0 - 1.0; }',
    'if (tw.z > 0.02) { tAl += texture2D(tRA, uvZ).rgb * tw.z; nZ = texture2D(tRN, uvZ).xyz * 2.0 - 1.0; }',
    'tAl /= max(0.001, (tw.x > 0.02 ? tw.x : 0.0) + (tw.y > 0.02 ? tw.y : 0.0) + (tw.z > 0.02 ? tw.z : 0.0));',
    'vec3 tAlN = min(tLin(tAl) * uRV, vec3(2.2));', // 暗贴图里零星的亮斑除以平均色后会爆白，封顶
    // 法线：whiteout 混合（Ben Golus 的三向投影法线），各投影面的切线方向按法线朝向翻转
    'vec3 sgn = sign(tWN);',
    'nX.xy *= uRNrm; nY.xy *= uRNrm; nZ.xy *= uRNrm;',
    'nX.x *= sgn.x; nY.x *= sgn.y; nZ.x *= -sgn.z;',
    'nX = vec3(nX.xy + tWN.zy, abs(nX.z) * tWN.x);',
    'nY = vec3(nY.xy + tWN.xz, abs(nY.z) * tWN.y);',
    'nZ = vec3(nZ.xy + tWN.xy, abs(nZ.z) * tWN.z);',
    'vec3 tNW = normalize(nX.zyx * tw.x + nY.xzy * tw.y + nZ.xyz * tw.z);',
    'vec3 tNv = normalize((viewMatrix * vec4(tNW, 0.0)).xyz);',
    'float tCap = max(vCap, uCapAll) * uCapK * smoothstep(0.45, 0.8, tNW.y);',
    'diffuseColor.rgb *= mix(vec3(1.0), tAlN, uRCon);',
  ].join('\n');
  function triMaterial(gx, opt) {
    const r = gx.rock, avg = G.assets.tex(r.tex).avg;
    _c.set(opt.tint || 0xffffff).convertSRGBToLinear();
    const U = {
      tRA: { value: zoneTexture(r.tex, 'albedo') }, tRN: { value: zoneTexture(r.tex, 'normal') },
      uRS: { value: 1 / r.tile }, uRCon: { value: opt.con }, uRNrm: { value: r.nrm * opt.nrm }, uSat: { value: opt.sat },
      uRV: { value: new T.Vector3(1 / avg[0], 1 / avg[1], 1 / avg[2]) }, uTint: { value: new T.Vector3(_c.r, _c.g, _c.b).multiplyScalar(opt.tintK || 1) },
      uCapAll: { value: opt.cap ? r.capAll || 0 : 0 }, uCapC: { value: lin(r.cap || 0xffffff) }, uCapK: { value: r.cap ? 1 : 0 }, // 没有覆盖色的区域：Kenney 岩石的草皮顶面也按岩石处理
    };
    const mat = own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: opt.rough, metalness: 0, flatShading: true, vertexColors: !!opt.vc }));
    mat.onBeforeCompile = function (sh) {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aCap;\nvarying vec3 vTriP;\nvarying float vCap;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\tvec4 trp = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n\ttrp = instanceMatrix * trp;\n#endif\n\tvTriP = (modelMatrix * trp).xyz;\n\tvCap = aCap;'
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + TRI_HEAD)
        .replace('#include <map_fragment>', TRI_MAIN)
        .replace(
          '#include <color_fragment>',
          opt.vc
            ? '\tfloat tLm = dot(vColor, vec3(0.2126, 0.7152, 0.0722));\n\tdiffuseColor.rgb *= mix(vec3(tLm), vColor, uSat) * uTint;\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, uCapC, tCap);'
            : '#include <color_fragment>\n\tdiffuseColor.rgb *= uTint;\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, uCapC * (0.8 + 0.2 * tAlN.g), tCap);'
        )
        .replace('#include <normal_fragment_maps>', 'normal = tNv;');
    };
    // 卡通：岩壁 / 布景在三向投影贴图上再叠一层很淡的笔触噪声（世界空间），大块的面不至于是一整片照片纹理
    return toonPatch(mat, { brush: 0.1, brushScale: 0.45 });
  }

  // ----- 火盆 / 灯的火焰（加色混合、不做色调映射，泛光会把它们点亮） -----
  const brazierFlameTex = () =>
    tex('brazierFlame', () => {
      const Wd = 64, H = 128, c = makeCanvas(Wd, H), g = c.getContext('2d'), img = g.createImageData(Wd, H), d = img.data;
      for (let y = 0; y < H; y++) {
        const v = 1 - y / (H - 1); // 0 = 底部，1 = 火尖
        for (let x = 0; x < Wd; x++) {
          const u = (x / (Wd - 1)) * 2 - 1;
          const w = 0.82 * Math.pow(Math.max(0, 1 - v), 0.85) * Math.min(1, v * 7 + 0.35);
          const wig = Math.sin(v * 9 + u * 2) * 0.1 * v;
          const e = w > 0.001 ? Math.abs(u + wig) / w : 9;
          let a = e >= 1 ? 0 : Math.pow(1 - e, 1.3) * Math.min(1, (1 - v) * 2.2);
          a = Math.max(0, Math.min(1, a * (0.8 + 0.2 * Math.sin(v * 23 + u * 5))));
          const o = (y * Wd + x) * 4;
          d[o] = d[o + 1] = d[o + 2] = 255;
          d[o + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
      return new T.CanvasTexture(c);
    });
  const gVQuad = () => geo('vquad', () => new T.PlaneGeometry(1, 1).translate(0, 0.5, 0));

  // ----- 贴地薄雾：一张盖住整个区域的平面，透明度来自「离可行走区域多远」的遮罩，只在路外的虚空上起雾 -----
  const MIST_VERT = 'varying vec3 vWp; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWp = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }';
  const MIST_FRAG = [
    'uniform sampler2D tMask; uniform vec4 uBox; uniform vec3 uCol; uniform float uA, uT; varying vec3 vWp;',
    'float mH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float mN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mH(i), mH(i + vec2(1.0, 0.0)), f.x), mix(mH(i + vec2(0.0, 1.0)), mH(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'void main(){',
    '  vec2 uv = (vWp.xz - uBox.xy) / uBox.zw;',
    '  float m = texture2D(tMask, uv).r;',
    '  vec2 p = mat2(0.8, -0.6, 0.6, 0.8) * vWp.xz * 0.075;',
    '  float n = mN(p + vec2(uT * 0.04, uT * 0.025)) * 0.5 + mN(mat2(0.6, 0.8, -0.8, 0.6) * p * 2.1 - vec2(uT * 0.06, -uT * 0.02)) * 0.3 + mN(p * 4.3 + uT * 0.05) * 0.2;',
    '  float a = uA * m * smoothstep(0.2, 0.8, n);',
    '  gl_FragColor = vec4(uCol, a);',
    '}',
  ].join('\n');
  function buildMist(zone, gx, sd) {
    const b = zone.bounds, M = 26;
    const x0 = b.minX - M, z0 = b.minZ - M, w = b.maxX - b.minX + 2 * M, h = b.maxZ - b.minZ + 2 * M;
    const S = 1.25, cw = Math.ceil(w / S), ch = Math.ceil(h / S);
    const c = makeCanvas(cw, ch), g = c.getContext('2d'), im = g.createImageData(cw, ch), d = im.data;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const v = smooth01((-sd(x0 + (i + 0.5) * S, z0 + (j + 0.5) * S) - 1.5) / 6);
        const o = (j * cw + i) * 4;
        d[o] = d[o + 1] = d[o + 2] = Math.round(v * 255);
        d[o + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    const mt = own(new T.CanvasTexture(c));
    mt.flipY = false;
    _c.set(gx.mist.color);
    const mat = own(
      new T.ShaderMaterial({
        uniforms: { tMask: { value: mt }, uBox: { value: new T.Vector4(x0, z0, w, h) }, uCol: { value: new T.Vector3(_c.r, _c.g, _c.b) }, uA: { value: gx.mist.a }, uT: uTime },
        vertexShader: MIST_VERT, fragmentShader: MIST_FRAG, transparent: true, depthWrite: false,
      })
    );
    const pg = own(new T.PlaneGeometry(w, h).rotateX(-Math.PI / 2).translate(x0 + w / 2, 0.55, z0 + h / 2));
    const m = new T.Mesh(pg, mat);
    m.renderOrder = 2;
    m.frustumCulled = false;
    m.visible = qual.mist;
    zoneGroup.add(m);
    return m;
  }

  // ===== 卡通布景：灰烬荒原起点 =====
  // 第 0 区的卡通岩石（倒角的大块面、受光的顶面暖、贴地的底部冷紫）整区都用；其余布景只铺在起点附近（ASH_DRESS.r0 以内满密度，到 r1 渐稀）：
  // 路外的灰堆、碎石、枯草、灰蕨、焰苔和余烬花，可行走区域里的积灰、零星碎石和几道发光的熔岩裂缝（起点原来的法阵去掉了），
  // 从起点朝出口踩出来的一条路（地面顶点色提亮、偏暖），以及飘落的灰烬（位置在 GPU 里算，每帧只更新中心点和时间）。
  // 明暗层次（要求方给的目标，sRGB 亮度）：地面 25%～35%、岩壁 15%～25%、角色受光面 55%～75%、熔岩和特效高光 85%～100%。
  // 所以布景都压在地面那一档上下，只有熔岩裂缝的芯和余烬花是亮点。可行走区域里的东西都贴地、很矮（最高约 0.35），不碰撞、不挡怪和预警圈；
  // 高的东西（灰堆、蕨、岩石）只放在路外，路外本来就走不进去，碰撞和原来一致。全部实例化，起点布景一共约 10 个 draw call。
  const ASH_DRESS = { r0: 15, r1: 26 };
  const ASH_PAL = {
    rock: 0x6a6472, rockLo: 0x5c4e80, // phase 3：0x5a4a4e / 0x4a3c6c → 0x6a6472 / 0x5c4e80：去掉受光面的赤陶色，岩壁整体抬到 15% 左右（之前 11.5%，比目标暗） // 岩石固有色（比地面暗一档）、贴地的冷紫（乘在固有色上）
    ash: 0x3c3434, ashLo: 0x5a4a5a, ashFall: 0x9a8a8a, // 灰堆、地上的积灰（贴花，淡淡提亮一层）
    grass: 0xb07a40, grassLo: 0x4a2e2a, // 枯草
    fern: 0x3f8e84, fernLo: 0x1e3a48, // 灰蕨（冷色点缀）
    moss: 0x5a3426, mossLo: 0x2e1a1e, // 焰苔（暗锈色的苔垫，亮点交给余烬花）
    bloom: 0xffb04a, bloom2: 0xffe08a, // 余烬花（自发光）
    core: 0xffe08a, mid: 0xff7a2a, edge: 0xd0341c, char: 0x24161c, // 熔岩裂缝：芯 / 中 / 边 / 烧焦的外沿
  };
  // 本节自己的确定性随机数（按区域布局取种子）：不消耗 Math.random，刷怪等后续随机序列和改之前一样
  function ashRng(zone, salt) {
    let s = (Math.abs(Math.round(zone.circles[1].x * 97 + zone.circles[1].z * 131) + (salt || 0) * 7717) % 2147483646) + 1;
    return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  }
  // 倒角的大块面岩石：二十面体按几刀平面削出大的平面（顶上一刀、侧面几刀），法线一半取面法线、一半取平滑法线
  // ——平面是一整块干净的明暗，棱上是软的过渡，看起来是圆钝的大石块而不是一颗颗尖的低多边形。竖向渐变烘焙进顶点色
  function ashRockGeo(v) {
    return geo('ashRock' + v, () => {
      let s = 7919 * (v + 3);
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const src = new T.IcosahedronGeometry(1, v < 2 ? 1 : 0);
      const p = src.attributes.position;
      const planes = [];
      const tilt = () => (rnd() - 0.5) * 0.5;
      planes.push(new T.Vector4(tilt(), 1, tilt(), 0.5 + rnd() * 0.18)); // 顶面
      planes.push(new T.Vector4(0, -1, 0, 0.42)); // 底面（埋进地里的那一截削平，免得翻出来）
      const cuts = v < 2 ? 5 : 3;
      for (let c = 0; c < cuts; c++) {
        const a = (c / cuts) * TAU + rnd() * 0.9, e = (rnd() - 0.35) * 0.9;
        planes.push(new T.Vector4(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.66 + rnd() * 0.2));
      }
      for (const q of planes) {
        const l = Math.hypot(q.x, q.y, q.z);
        q.x /= l; q.y /= l; q.z /= l;
      }
      const sx = 0.95 + rnd() * 0.35, sy = 0.82 + rnd() * 0.22, sz = 0.85 + rnd() * 0.3;
      const pos = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        _v.fromBufferAttribute(p, i);
        // 低频起伏（按位置，重合的顶点一起动），再按平面削
        const h = Math.sin(_v.x * 3.1 + v) * Math.sin(_v.z * 2.7 - v * 0.7) * 0.08;
        _v.multiplyScalar(1 + h);
        for (const q of planes) {
          const dd = _v.x * q.x + _v.y * q.y + _v.z * q.z - q.w;
          if (dd > 0) _v.set(_v.x - q.x * dd, _v.y - q.y * dd, _v.z - q.z * dd);
        }
        pos[i * 3] = _v.x * sx; pos[i * 3 + 1] = _v.y * sy; pos[i * 3 + 2] = _v.z * sz;
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.computeVertexNormals(); // 非索引：面法线
      // 平滑法线：位置重合的顶点累加面法线
      const fn = g.attributes.normal, acc = new Map(), key = (i) => Math.round(pos[i * 3] * 1e3) + ',' + Math.round(pos[i * 3 + 1] * 1e3) + ',' + Math.round(pos[i * 3 + 2] * 1e3);
      for (let i = 0; i < p.count; i++) {
        const k = key(i), a = acc.get(k) || [0, 0, 0];
        a[0] += fn.getX(i); a[1] += fn.getY(i); a[2] += fn.getZ(i);
        acc.set(k, a);
      }
      for (let i = 0; i < p.count; i++) {
        const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]) || 1;
        _v.set(fn.getX(i) * 0.55 + (a[0] / l) * 0.45, fn.getY(i) * 0.55 + (a[1] / l) * 0.45, fn.getZ(i) * 0.55 + (a[2] / l) * 0.45).normalize();
        fn.setXYZ(i, _v.x, _v.y, _v.z);
      }
      src.dispose();
      return toonGradient(g, { bottom: ASH_PAL.rockLo, top: 0xffffff, y0: -0.42 * sy, y1: 0.55 * sy });
    });
  }
  // 尖岩：原来的五棱锥换成带竖向渐变的（另存一份，别的区域的缓存几何体不动）
  const ashSpireGeo = () => geo('ashSpire', () => toonGradient(spireGeo().clone(), { bottom: ASH_PAL.rockLo, top: 0xffffff, y0: 0, y1: 2.4 }));
  function ashRockMat() {
    return own(makeToonMat({ color: ASH_PAL.rock, brush: 0.16, brushScale: 0.42, soft: 0.1 }));
  }
  // 从起点朝第一条走廊的出口踩出来的一条路（略弯）：返回到这条折线的距离
  function ashTrail(zone) {
    const c0 = zone.circles[0], c1 = zone.circles[1];
    const dx = c1.x - c0.x, dz = c1.z - c0.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const end = c0.r + 6, pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = (i / 8) * end, w = Math.sin((t / end) * Math.PI * 1.3) * 1.1;
      pts.push([c0.x + ux * t - uz * w, c0.z + uz * t + ux * w]);
    }
    const f = (x, z) => {
      let d = 1e9;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], ex = b[0] - a[0], ez = b[1] - a[1];
        let t = ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = Math.min(d, Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t));
      }
      return d;
    };
    f.pts = pts;
    return f;
  }
  // 小件的几何体（烘焙顶点色 + 竖向渐变，一种一个实例化网格）
  const ashGrassGeo = () =>
    geo('ash/grass', () => {
      const parts = [];
      const blade = geo('ash/blade', () => new T.ConeGeometry(0.05, 1, 3, 1, true)); // 不封底的三棱锥：一片叶 3 个三角形
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + Math.sin(i * 4.1) * 0.4, lean = 0.28 + 0.2 * Math.abs(Math.sin(i * 2.3)), h = 0.38 + 0.22 * Math.abs(Math.sin(i * 1.7));
        parts.push([blade, i % 2 ? ASH_PAL.grass : mixHex(ASH_PAL.grass, 0x9a6a3a, 0.6), Math.sin(a) * 0.06, h * 0.5, Math.cos(a) * 0.06, Math.cos(a) * lean, a, -Math.sin(a) * lean, 1, h, 1]);
      }
      return toonGradient(bake('ash/grass0', parts).clone(), { bottom: ASH_PAL.grassLo, top: 0xffffff, y0: 0, y1: 0.5 });
    });
  const ashFernGeo = () =>
    geo('ash/fern', () => {
      const parts = [];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + Math.sin(i * 3.3) * 0.3;
        // 一片叶子：压扁拉长的八面体，从根部向外拱出去（一片 8 个三角形）
        parts.push([gOct(1), i % 2 ? ASH_PAL.fern : mixHex(ASH_PAL.fern, 0x6ac8b8, 0.25), Math.sin(a) * 0.36, 0.22, Math.cos(a) * 0.36, 1.0 * Math.cos(a), a, -1.0 * Math.sin(a), 0.075, 0.46, 0.025]);
      }
      return toonGradient(bake('ash/fern0', parts).clone(), { bottom: ASH_PAL.fernLo, top: 0xffffff, y0: 0, y1: 0.45 });
    });
  const ashMossGeo = () =>
    geo('ash/moss', () => toonGradient(bake('ash/moss0', [
      [gIco(1, 0), ASH_PAL.moss, 0, 0, 0, 0, 0, 0, 1, 0.32, 0.8],
      [gIco(0.6, 0), mixHex(ASH_PAL.moss, 0x8a4a2a, 0.35), 0.7, 0, 0.3, 0, 0.5, 0, 1, 0.36, 0.9],
    ]).clone(), { bottom: ASH_PAL.mossLo, top: 0xffffff, y0: -0.1, y1: 0.3 }));
  const ashDriftGeo = () =>
    geo('ash/drift', () => toonGradient(bake('ash/drift0', [
      [gIco(1, 1), ASH_PAL.ash, 0, 0, 0, 0, 0, 0, 1, 0.3, 0.7],
      [gIco(0.7, 1), mixHex(ASH_PAL.ash, 0xb4a0a8, 0.3), 0.75, 0.02, 0.2, 0, 0.4, 0, 1, 0.34, 0.8],
    ]).clone(), { bottom: ASH_PAL.ashLo, top: 0xffffff, y0: -0.05, y1: 0.32 }));
  const ashBloomGeo = () =>
    geo('ash/bloom', () => bake('ash/bloom0', [
      [gOct(0.09), ASH_PAL.bloom, 0, 0.16, 0, 0, 0, 0, 1, 1.3, 1],
      [gOct(0.07), ASH_PAL.bloom2, 0.13, 0.11, 0.05, 0, 0.6, 0, 1, 1.3, 1],
      [gOct(0.06), ASH_PAL.bloom, -0.08, 0.09, 0.12, 0, 0.3, 0, 1, 1.3, 1],
    ]));
  // 熔岩裂缝：一条随机折线（带一两条分叉），按宽度铺成贴地的条带；u = 离中线的远近（0 = 芯，1 = 边）写进顶点色
  function ashFissure(rnd, x, z, len, w, out) {
    const branch = (x0, z0, a0, L, w0, depth) => {
      // 折线：大体沿 a0 走，每一节左右折一下（锯齿状，不是平滑的弧，免得像一道刀光）
      const n = Math.max(4, Math.round(L / 0.32));
      let px = x0, pz = z0;
      const P = [[px, pz]], W0 = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + (rnd() < 0.7 ? (i % 2 ? 1 : -1) : 0) * (0.2 + rnd() * 0.45) + (rnd() - 0.5) * 0.35, l = (L / n) * (0.6 + rnd() * 0.8);
        px += Math.sin(a) * l;
        pz += Math.cos(a) * l;
        P.push([px, pz]);
      }
      for (let i = 0; i <= n; i++) W0.push(w0 * (0.55 + rnd() * 0.7) * Math.sin(Math.PI * Math.min(1, 0.1 + (i / n) * 0.9)) + 0.01);
      for (let i = 0; i < P.length - 1; i++) {
        const ww0 = W0[i], ww1 = W0[i + 1];
        const ex = P[i + 1][0] - P[i][0], ez = P[i + 1][1] - P[i][1], l = Math.hypot(ex, ez) || 1, nx = -ez / l, nz = ex / l;
        out.push([P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], nx, nz, ww0, ww1]);
      }
      if (depth < 1) {
        const nb = rnd() < 0.7 ? 1 : 2;
        for (let b = 0; b < nb; b++) {
          const k = 1 + Math.floor(rnd() * (P.length - 2));
          branch(P[k][0], P[k][1], a0 + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.6), L * (0.3 + rnd() * 0.25), w0 * 0.6, depth + 1);
        }
      }
    };
    branch(x, z, rnd() * TAU, len, w, 0);
  }
  // bands：[离中线的距离（× 宽度）, 颜色]，从中线往外一圈圈排（芯 → 橙 → 红边 → 烧焦的外沿），两侧对称
  function ashFissureGeo(segs, bands, y) {
    const pos = [], col = [], B = bands.map((q) => [q[0], lin(q[1])]);
    for (const s of segs) {
      const [ax, az, bx, bz, nx, nz, w0, w1] = s;
      for (const sg of [1, -1]) {
        for (let k = 0; k < B.length - 1; k++) {
          const i0 = B[k][0] * sg, i1 = B[k + 1][0] * sg, c0 = B[k][1], c1 = B[k + 1][1];
          const p = [ax + nx * w0 * i0, az + nz * w0 * i0, bx + nx * w1 * i0, bz + nz * w1 * i0, bx + nx * w1 * i1, bz + nz * w1 * i1, ax + nx * w0 * i1, az + nz * w0 * i1];
          pos.push(p[0], y, p[1], p[2], y, p[3], p[4], y, p[5], p[0], y, p[1], p[4], y, p[5], p[6], y, p[7]);
          col.push(c0.r, c0.g, c0.b, c0.r, c0.g, c0.b, c1.r, c1.g, c1.b, c0.r, c0.g, c0.b, c1.r, c1.g, c1.b, c1.r, c1.g, c1.b);
        }
      }
    }
    const g = own(new T.BufferGeometry());
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    return g;
  }
  // 飘落的灰烬：一团点精灵，每个点在一个跟着镜头走的盒子里按自己的速度漂，越出盒子就从另一边绕回来（GPU 里算），
  // 一成是暖色的火星。低画质不画
  const ASH_MOTE_VERT = [
    'attribute vec4 aSeed; uniform float uT, uScale; uniform vec3 uC; varying float vA; varying float vE;',
    'void main(){',
    '  vec3 box = vec3(34.0, 6.5, 30.0);',
    '  vec3 dr = vec3(0.45, -0.32, 0.18) * (0.55 + aSeed.w);',
    '  vec3 o = uC - box * 0.5;',
    '  vec3 w = mod(aSeed.xyz * box + dr * uT - o, box) + o;',
    '  w.x += sin(uT * 0.8 + aSeed.w * 40.0) * 0.35; w.z += cos(uT * 0.6 + aSeed.w * 23.0) * 0.25;',
    '  w.y = mod(aSeed.y * box.y - 0.32 * (0.55 + aSeed.w) * uT, box.y) + 0.15;',
    '  vec3 q = abs(w - uC) / (box * 0.5);',
    '  vA = smoothstep(1.0, 0.75, max(q.x, q.z)) * smoothstep(0.15, 0.9, w.y) * smoothstep(box.y, box.y - 1.0, w.y);',
    '  vE = step(0.9, aSeed.w);',
    '  vec4 mv = viewMatrix * vec4(w, 1.0);',
    '  gl_PointSize = (0.07 + 0.05 * aSeed.w) * (1.0 + vE * 0.3) * uScale / max(0.1, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    '}',
  ].join('\n');
  const ASH_MOTE_FRAG = [
    'uniform vec3 uAsh, uEmb; varying float vA; varying float vE;',
    'void main(){',
    '  float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.15, d) * vA;',
    '  gl_FragColor = vec4(mix(uAsh, uEmb, vE), a * mix(0.55, 0.9, vE));',
    '}',
  ].join('\n');

  function buildAshDress(zone, sd) {
    const rnd = ashRng(zone), st = zone.start, R0 = ASH_DRESS.r0, R1 = ASH_DRESS.r1;
    const trail = ashTrail(zone);
    const fade = (x, z) => 1 - smooth01((Math.hypot(x - st.x, z - st.z) - R0) / (R1 - R0));
    const L = { grass: [], fern: [], moss: [], drift: [], bloom: [], pebble: [], patch: [], glow: [] };
    const r = (a, b) => a + (b - a) * rnd();
    // 在起点周围按抖动网格撒点，按「离路边多远」和「离起点多远」决定放什么
    const G0 = 0.9;
    for (let gz = st.z - R1; gz <= st.z + R1; gz += G0) {
      for (let gx = st.x - R1; gx <= st.x + R1; gx += G0) {
        const x = gx + r(-0.45, 0.45), z = gz + r(-0.45, 0.45);
        const f = fade(x, z);
        if (f <= 0 || rnd() > f) continue;
        const d = sd(x, z), ds = Math.hypot(x - st.x, z - st.z), dt = trail(x, z);
        const n = vnoise(x * 0.35 + 3.7, z * 0.35 - 1.3); // 成片：同一片里多是同一种植物
        if (d < -0.15 && d > -4.2) {
          // 路外：贴着岩石脚的灰堆、蕨、枯草、焰苔，零星几簇余烬花
          const k = rnd();
          if (d > -1.6 && k < 0.16) L.drift.push(x, 0, z, 0, r(0, TAU), 0, r(0.7, 1.5), r(0.7, 1.3), r(0.7, 1.4), r(0.85, 1.1));
          else if (n > 0.55 && k < 0.75) L.fern.push(x, 0, z, 0, r(0, TAU), 0, r(1.1, 1.8), r(1, 1.6), r(1.1, 1.8), r(0.8, 1.15));
          else if (n < 0.36 && k < 0.45) L.moss.push(x, 0.02, z, r(-0.1, 0.1), r(0, TAU), r(-0.1, 0.1), r(0.4, 0.8), r(0.6, 1), r(0.4, 0.8), r(0.8, 1.15));
          else if (n > 0.38 && n < 0.56 && k < 0.85) {
            // 枯草成丛：一处两三簇挤在一起
            for (let q = 0; q < 3; q++) L.grass.push(x + r(-0.35, 0.35), 0, z + r(-0.35, 0.35), 0, r(0, TAU), 0, r(0.9, 1.4), r(0.9, 1.7), r(0.9, 1.4), r(0.8, 1.2));
          }
          if (n < 0.5 && rnd() < 0.26) L.bloom.push(x + r(-0.3, 0.3), 0, z + r(-0.3, 0.3), 0, r(0, TAU), 0, r(0.8, 1.3), r(0.8, 1.3), r(0.8, 1.3), 1);
        } else if (d >= -0.15 && d < 1.4) {
          // 可行走区域的边上：矮草、碎石（都很矮，不碰撞）
          const k = rnd();
          if (k < 0.3) L.grass.push(x, 0, z, 0, r(0, TAU), 0, r(0.6, 0.95), r(0.55, 0.85), r(0.6, 0.95), r(0.8, 1.1));
          else if (k < 0.5) L.pebble.push(x, 0.02, z, r(-0.4, 0.4), r(0, TAU), r(-0.4, 0.4), r(0.1, 0.22), r(0.07, 0.14), r(0.1, 0.22), r(0.75, 1.1));
          else if (k < 0.56 && d < 0.9) L.pebble.push(x, 0.02, z, r(-0.3, 0.3), r(0, TAU), r(-0.3, 0.3), r(0.26, 0.42), r(0.16, 0.26), r(0.26, 0.42), r(0.8, 1.05)); // 从岩壁上掉下来的碎块
          if (rnd() < 0.08) L.patch.push(x, 0.018, z, 0, r(0, TAU), 0, r(1.2, 2.2), 1, r(0.8, 1.5), 1);
        } else if (d >= 1.4 && ds > 2.6 && dt > 1.1) {
          // 空地中间：零星的积灰、碎石
          const k = rnd();
          if (k < 0.035) L.patch.push(x, 0.018, z, 0, r(0, TAU), 0, r(1.3, 2.6), 1, r(0.8, 1.6), 1);
          else if (k < 0.07) L.pebble.push(x, 0.02, z, r(-0.4, 0.4), r(0, TAU), r(-0.4, 0.4), r(0.08, 0.18), r(0.05, 0.11), r(0.08, 0.18), r(0.75, 1.1));
        }
      }
    }
    // 熔岩裂缝：空地边上几道、路外几道（离起点和路都有距离，不和预警圈混在一起）
    const fis = [], fr = ashRng(zone, 1), rf = (a, b) => a + (b - a) * fr(); // 单独一路随机数：调植被不会把裂缝挪走
    let tries = 0, nf = 0;
    while (nf < 7 && tries++ < 200) {
      const a = rf(0, TAU), dd = rf(3.5, R0 + 2), x = st.x + Math.sin(a) * dd, z = st.z + Math.cos(a) * dd, d = sd(x, z);
      if (trail(x, z) < 1.8 || d > 2.2 || d < -3) continue;
      const len = rf(1.4, 2.8);
      ashFissure(fr, x, z, len, rf(0.07, 0.11), fis);
      L.glow.push(x, 0.04, z, 0, 0, 0, len * 0.9, 1, len * 0.9, 1);
      nf++;
    }

    const ws = new T.Color(1, 1, 1);
    const foliage = own(makeToonMat({ brush: 0.12, brushScale: 0.8, soft: 0.14 }));
    // 低画质不画地上的草 / 蕨 / 苔（软件 GL 下它们和图标的画布共用一个 GPU 进程，见 QUALITY.low 的注释）
    const lowHide = [instanced(ashGrassGeo(), foliage, L.grass, false, ws), instanced(ashFernGeo(), foliage, L.fern, false, ws), instanced(ashMossGeo(), foliage, L.moss, false, ws)].filter(Boolean);
    instanced(ashDriftGeo(), own(makeToonMat({ brush: 0.1, brushScale: 0.5, soft: 0.16 })), L.drift, false, ws);
    instanced(ashRockGeo(2), own(makeToonMat({ color: ASH_PAL.rock, brush: 0.1 })), L.pebble, false, ws);
    const bloomMat = own(makeToonMat({ emissive: ASH_PAL.bloom, emissiveIntensity: 0.9 }));
    instanced(ashBloomGeo(), bloomMat, L.bloom, false, ws);
    // 积灰：贴地的淡灰紫斑（普通混合，不发光）
    const patchMat = own(new T.MeshBasicMaterial({ map: blotchTex(), color: lin(ASH_PAL.ashFall), transparent: true, opacity: 0.2, depthWrite: false }));
    const pIM = instanced(gQuad(), patchMat, L.patch, false, null);
    if (pIM) pIM.renderOrder = 1;
    // 熔岩裂缝：一张不受光的条带（芯接近白热、往外橙 → 红 → 烧焦的暗沿，不做色调映射）+ 地面上一点暖光
    let fisMat = null, glowMat = null;
    if (fis.length) {
      fisMat = own(new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: T.DoubleSide }));
      const bands = [[0, ASH_PAL.core], [0.3, ASH_PAL.mid], [0.6, ASH_PAL.edge], [0.85, ASH_PAL.char], [2.2, mixHex(ASH_PAL.char, 0x3a2a30, 0.5)]];
      const core = new T.Mesh(ashFissureGeo(fis, bands, 0.02), fisMat);
      core.renderOrder = 1;
      zoneGroup.add(core);
      glowMat = own(new T.MeshBasicMaterial({ map: glowTex(), color: lin(ASH_PAL.mid), transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
      const gIM = instanced(gQuad(), glowMat, L.glow, false, null);
      if (gIM) gIM.renderOrder = 1;
    }
    // 飘落的灰烬
    const NM = 150, seed = new Float32Array(NM * 4);
    for (let i = 0; i < NM * 4; i++) seed[i] = rnd();
    const mg = own(new T.BufferGeometry());
    mg.setAttribute('position', new T.BufferAttribute(new Float32Array(NM * 3), 3));
    mg.setAttribute('aSeed', new T.BufferAttribute(seed, 4));
    const mm = own(new T.ShaderMaterial({
      uniforms: { uT: uTime, uScale: pMat.uniforms.uScale, uC: { value: new T.Vector3(st.x, 0, st.z) }, uAsh: { value: lin(0xb8a8b8) }, uEmb: { value: lin(0xff9a4a) } },
      vertexShader: ASH_MOTE_VERT, fragmentShader: ASH_MOTE_FRAG, transparent: true, depthWrite: false,
    }));
    const motes = new T.Points(mg, mm);
    motes.frustumCulled = false;
    motes.renderOrder = 6;
    motes.visible = qualId !== 'low';
    zoneGroup.add(motes);
    for (const m of lowHide) m.visible = qualId !== 'low';
    return { trail, motes, mm, fisMat, glowMat, bloomMat, lowHide };
  }
  // 每帧（W.update 的区域氛围段里一行调用）：灰烬的盒子跟着镜头焦点，熔岩裂缝和余烬花慢慢呼吸
  function updateAshDress(D) {
    D.motes.visible = qualId !== 'low';
    for (let i = 0; i < D.lowHide.length; i++) D.lowHide[i].visible = qualId !== 'low';
    D.mm.uniforms.uC.value.set(camT.x, 0, camT.z + CAM_LEAD);
    const k = 0.5 + 0.5 * Math.sin(wtime * 1.3);
    if (D.fisMat) D.fisMat.color.setScalar(0.92 + 0.16 * k);
    if (D.glowMat) D.glowMat.opacity = 0.16 + 0.1 * k;
    D.bloomMat.emissiveIntensity = 0.75 + 0.3 * (0.5 + 0.5 * Math.sin(wtime * 1.7 + 1));
  }

  // ----- 按需加载区域素材：没就绪时先用程序化外观，就绪后若还在这个区域就原地重建一次外观 -----
  let loadingEl = null, pendingZone = null;
  function showLoading(on) {
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.id = 'zone-loading';
      loadingEl.textContent = '正在载入场景…';
      document.body.appendChild(loadingEl);
    }
    loadingEl.classList.toggle('on', !!on);
  }
  function requestZoneAssets(zone, gx) {
    if (!G.assets || !gx || G.assets.settled(gx.packs)) return;
    pendingZone = zone;
    showLoading(true);
    G.assets.need(gx.packs).then(() => {
      if (pendingZone === zone) {
        pendingZone = null;
        showLoading(false);
      }
      // 贴图到了而当前是程序化外观，或者模型包后到了而当前没摆布景：原地重建一次
      const up = gfxReady(gx) && (!zoneFx || !zoneFx.hd || (!zoneFx.props && propsReady(gx)));
      if (up && W.zone === zone && zoneGroup) {
        disposeZone();
        safeBuildVisuals(zone);
        // 换外观时画面先压暗一下再淡入，不是生硬地一跳
        try {
          const cv = renderer.domElement;
          cv.style.transition = 'none';
          cv.style.opacity = '0.25';
          void cv.offsetWidth;
          cv.style.transition = 'opacity 0.45s ease-out';
          cv.style.opacity = '1';
        } catch (e) { /* 忽略 */ }
      }
    });
  }
  // 空闲时预取下一个区域的素材包，走到那里时不用再等
  function prefetchNext(def) {
    if (!G.assets) return;
    const i = G.ZONES.indexOf(def);
    const nx = G.ZONES[i + 1] && ZONE_GFX[G.ZONES[i + 1].id];
    if (!nx) return;
    setTimeout(() => G.assets.need(nx.packs), 1500);
  }
  W.assetsPending = () => !!pendingZone;
  // 启动时先等首个区域的素材（最多 maxMs 毫秒），开场就是完整画面；等待期间整屏盖一层「正在载入场景…」
  W.preloadZone = function (idx, maxMs) {
    const def = G.ZONES[Math.max(0, Math.min(G.ZONES.length - 1, idx | 0))];
    const gx = def && ZONE_GFX[def.id];
    if (!gx || !G.assets || G.assets.settled(gx.packs)) return Promise.resolve(!!(gx && G.assets && G.assets.ready(gx.packs)));
    let boot = null;
    try {
      boot = document.createElement('div');
      boot.id = 'boot-loading';
      boot.textContent = '正在载入场景…';
      document.body.appendChild(boot);
    } catch (e) {
      boot = null;
    }
    const done = (v) => {
      if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
      boot = null;
      return v;
    };
    return Promise.race([G.assets.need(gx.packs), new Promise((r) => setTimeout(() => r(false), maxMs || 2500))]).then(done, () => done(false));
  };

  // ----- 布景模型：沿不可行走的边按权重挑模型，同一模型的所有摆放合成一个实例化网格 -----
  function pickW(list) {
    let tot = 0;
    for (const e of list) tot += e[1];
    let r = Math.random() * tot;
    for (const e of list) if ((r -= e[1]) <= 0) return e;
    return list[list.length - 1];
  }
  function buildProps(zone, gx, sd, ringSamples, lowK, mats) {
    const P = gx.props, def = zone.def;
    const by = Object.create(null); // 模型 key → { e, list }
    const once = Object.create(null);
    const place = (e, x, z, extra) => {
      const info = G.assets.geoInfo(e[0]);
      if (!G.assets.geo(e[0]) || !info) return false;
      if (e[4].indexOf('1') >= 0 && once[e[0]]) return false; // 标记 1：整个区域只放一个
      once[e[0]] = 1;
      const s = rand(e[2], e[3]);
      if (sd(x, z) > -(info.r * s * 0.8 + 0.4)) return false; // 模型的水平半径整个落在路外
      const flat = e[4].indexOf('l') >= 0;
      const y = flat ? -info.y0 * s : 0;
      const tilt = flat ? 0 : extra && extra.tilt ? extra.tilt : 0.06;
      (by[e[0]] || (by[e[0]] = { e, list: [], small: !!(extra && extra.small) })).list.push(x, y, z, rand(-tilt, tilt), rand(0, TAU), rand(-tilt, tilt), s, s, s, rand(0.78, 1.08));
      return true;
    };
    const choose = (list, x, z) => {
      if (lowK(x, z) >= 1) return pickW(list);
      const low = list.filter((e) => e[4].indexOf('t') < 0);
      return low.length ? pickW(low) : null;
    };
    // 外圈：替换程序化摆件
    ringSamples(6.5, 4.2, (x, z) => {
      x += rand(-1.5, 1.5);
      z += rand(-1.5, 1.5);
      if (sd(x, z) > -3.0 || Math.random() < 0.3) return;
      const e = choose(P.outer, x, z);
      if (e) place(e, x, z);
    });
    // 中圈：一部分程序化岩石旁边换成模型岩石
    if (P.mid && P.mid.length) {
      ringSamples(1.9, 2.2, (x, z) => {
        if (Math.random() >= P.midK * 0.6) return;
        x += rand(-0.4, 0.4);
        z += rand(-0.4, 0.4);
        if (sd(x, z) > -1.75) return;
        const e = choose(P.mid, x, z);
        if (e) place(e, x, z, { tilt: 0.2 });
      });
    }
    // 路边小物件
    if (P.edge && P.edge.length) {
      ringSamples(5.2, 1.25, (x, z) => {
        if (Math.random() < 0.45) return;
        x += rand(-0.4, 0.4);
        z += rand(-0.4, 0.4);
        const e = choose(P.edge, x, z);
        if (e) place(e, x, z, { small: true });
      });
    }
    // 首领场地外的大件（只放在远离镜头的北半圈）
    if (P.boss && P.boss.length) {
      const bp = zone.bossPos;
      for (let k = 0; k < 9; k++) {
        const a = Math.PI + (k / 8 - 0.5) * 2.4 + rand(-0.12, 0.12), d = zone.bossR + rand(3.2, 5.5);
        const x = bp.x + Math.sin(a) * d, z = bp.z + Math.cos(a) * d;
        if (lowK(x, z) < 1) continue;
        place(pickW(P.boss), x, z);
      }
    }
    // 火盆 / 灯：每块空地北侧两个（矮火堆南侧再加一个），紧贴路边
    const fires = [];
    if (P.fire && G.assets.geo(P.fire.m)) {
      const F = P.fire;
      const shortFire = F.m.indexOf('lantern') < 0; // 矮的火堆在南侧（靠镜头）也放一个，不会挡住战场；立灯只放北侧
      zone.circles.forEach((c, ci) => {
        const n = ci === zone.circles.length - 1 ? 4 : 2;
        const ns = shortFire && ci > 0 && ci < zone.circles.length - 1 ? 1 : 0;
        for (let k = 0; k < n + ns; k++) {
          const a = k >= n ? rand(-0.6, 0.6) : Math.PI + (n === 2 ? (k ? 0.75 : -0.75) : (k - 1.5) * 0.62) + rand(-0.15, 0.15), rr = c.r + 1.25;
          const x = c.x + Math.sin(a) * rr, z = c.z + Math.cos(a) * rr;
          if (sd(x, z) > -0.9) continue;
          (by[F.m] || (by[F.m] = { e: [F.m, 1, F.s, F.s, ''], list: [] })).list.push(x, 0, z, 0, rand(0, TAU), 0, F.s, F.s, F.s, 1);
          fires.push({ x, y: F.h * (F.m.indexOf('lantern') >= 0 ? F.s : 1), z, ph: rand(0, TAU), acc: 0 });
        }
      });
    }
    // 路边小物件不投影（又小又多，投影只是白白多画一遍）
    for (const k in by) {
      const { e, list, small } = by[k];
      const rockish = e[4].indexOf('r') >= 0;
      instanced(G.assets.geo(k), rockish ? mats.rock : mats.prop, list, !small, rockish && def.id !== 'ash' ? lin(def.rock).multiplyScalar(1.2) : new T.Color(1, 1, 1)); // 第 0 区的岩石材质自带颜色
    }
    if (!fires.length) return null;
    // 火焰：竖直的方片，朝镜头倾斜；每帧在 W.update 里按各自的相位抖动
    const F = P.fire;
    _c.set(F.color).convertSRGBToLinear();
    const fm = own(new T.MeshBasicMaterial({ map: brazierFlameTex(), color: new T.Color(_c.r * 2.4, _c.g * 2.4, _c.b * 2.4), transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, side: T.DoubleSide }));
    const im = new T.InstancedMesh(gVQuad(), fm, fires.length * 2);
    im.frustumCulled = false;
    im.renderOrder = 5;
    zoneGroup.add(im);
    own(im);
    const gm = own(new T.MeshBasicMaterial({ map: glowTex(), color: _c.clone().multiplyScalar(0.9), transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const gl = [];
    for (const f of fires) gl.push(f.x, 0.06, f.z, 0, 0, 0, 2.6 * F.size, 1, 2.6 * F.size, 1);
    const gIM = instanced(gQuad(), gm, gl, false, null);
    if (gIM) gIM.renderOrder = 1;
    return { im, list: fires, size: F.size, ar: _c.r, ag: _c.g, ab: _c.b };
  }
  const _fq = new T.Quaternion(), _fe = new T.Euler();
  function updateFires(F, dt) {
    const s = F.size;
    for (let i = 0; i < F.list.length; i++) {
      const f = F.list[i], t = wtime * 7 + f.ph;
      const fl = 0.85 + 0.15 * Math.sin(t) * Math.sin(t * 1.7 + 1.3);
      for (let k = 0; k < 2; k++) {
        const w = (k ? 0.55 : 1) * s, h = (k ? 1.25 : 1.6) * s * fl * (k ? 1.1 - 0.1 * Math.sin(t * 2.3) : 1);
        _fe.set(-0.62, k ? 0.3 : -0.3, 0);
        _fq.setFromEuler(_fe);
        _m4.compose(_v.set(f.x, f.y, f.z), _fq, _s.set(w, h, 1));
        F.im.setMatrixAt(i * 2 + k, _m4);
      }
      f.acc += dt * 6 * s;
      while (f.acc > 1) {
        f.acc -= 1;
        spawnP(f.x + rand(-0.2, 0.2) * s, f.y + 0.4 * s, f.z + rand(-0.2, 0.2) * s, rand(-0.3, 0.3), rand(1.2, 2.4), rand(-0.3, 0.3), rand(0.5, 1.1), rand(0.06, 0.12), F.ar, F.ag * 0.8, F.ab * 0.6, -0.6, 0.4);
      }
    }
    F.im.instanceMatrix.needsUpdate = true;
  }

  // ---------- 初始化 ----------
  W.zone = null;

  W.init = function () {
    const canvas = document.getElementById('gl');
    renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.outputEncoding = T.sRGBEncoding;
    // 卡通色调曲线（保持色相的高光肩部 + 饱和度，见 TOON / patchToonChunks），代替 ACES：ACES 会把中间调压灰、把饱和色洗淡
    renderer.toneMapping = T.CustomToneMapping;
    renderer.toneMappingExposure = TOON.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    // 画质档位：存档里的「画质」选项（高 / 中 / 低）；'auto'（玩家没选过）按设备推断（见 G.defaultQuality）
    let qs = G.save && G.save.opts && G.save.opts.quality;
    if (!QUALITY[qs] && G.defaultQuality) qs = G.defaultQuality();
    if (QUALITY[qs]) {
      qual = QUALITY[qs];
      qualId = qs;
    }

    scene = new T.Scene();
    scene.background = new T.Color(0x100c0a);
    scene.fog = new T.Fog(0x100c0a, CAMERA.fogNear, CAMERA.fogFar);

    camera = new T.PerspectiveCamera(BASE_FOV, 1, 2, 240);
    camAim(); // 朝向固定，之后只平移

    hemi = new T.HemisphereLight(0xffffff, 0x222222, HEMI_I);
    scene.add(hemi);

    sun = new T.DirectionalLight(0xffffff, 0.82);
    sun.castShadow = true;
    sun.shadow.mapSize.set(qual.shadow, qual.shadow);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
    sc.near = 1; sc.far = 90;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.04;
    scene.add(sun);
    scene.add(sun.target);
    // 补光：从镜头对面（画面上方）斜照过来的一盏不投影的方向光，按区域配色给角色和岩石勾一道轮廓
    fill = new T.DirectionalLight(0xffffff, 0.3);
    fill.position.set(12, 9, -14); // 镜头对面偏右：只照亮角色的背面和边缘，相当于轮廓光（角色材质按它的方向勾冷色的边）
    scene.add(fill);
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
    initSmoke();
    initProjFx();
    initArrows();
    corpseRoot = new T.Group();
    scene.add(corpseRoot);

    ocv = document.getElementById('overlay');
    octx = ocv.getContext('2d');

    W.renderer = renderer;
    W.scene = scene;
    W.camera = camera;
    initPost();
    W.resize();
    window.addEventListener('resize', W.resize);

    // 预热特效着色器：先各建一个（不可见），统一编译，免得第一次放技能时卡一下
    poolGet(ringPool);
    poolGet(slashPool);
    boltGet();
    W.meteorFall(0, 0, 1, 0xffffff);
    meteors[0].mesh.position.set(0, 1, 2); // 摆进预热那一帧的画面里，岩石材质一并编译
    const warm = W.makeTelegraph({ shape: 'circle', x: 0, z: 0, r: 1 }, false);
    initAllyFx();
    initGhosts();
    warmEntities(); // 里面会真的渲染一帧，上面这些特效的着色器也一并编译
    W.removeTelegraph(warm);
    meteorOff(meteors[0]);
    clearRibbons();
  };

  // 按 CAMERA 摆镜头的朝向（只在初始化和 W.setCamera 时调用）
  function camAim() {
    camera.position.copy(CAM_OFF);
    camera.lookAt(0, CAMERA.lookY, 0);
    camera.getWorldDirection(camF);
    camU.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.fov = fovNow = BASE_FOV;
    camera.updateProjectionMatrix();
    if (scene && scene.fog) {
      scene.fog.near = CAMERA.fogNear;
      scene.fog.far = CAMERA.fogFar;
    }
  }
  // 调试 / 调镜头：G.world.setCamera({ pitch, dist, fov, lead, lookY, fogNear, fogFar, shadow })，返回当前配置
  W.setCamera = function (o) {
    Object.assign(CAMERA, o || {});
    camDerive();
    BASE_FOV = CAMERA.fov;
    if (SHADOW_HALF !== CAMERA.shadow && sun) {
      SHADOW_HALF = CAMERA.shadow;
      const sc = sun.shadow.camera;
      sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
      sc.updateProjectionMatrix();
    }
    if (camera) {
      camAim();
      camSnap = true;
      W.resize();
      W.update(0);
    }
    return Object.assign({}, CAMERA);
  };

  W.resize = function () {
    vw = Math.max(1, window.innerWidth);
    vh = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, qual.dpr);
    const glDpr = dpr * (qual.scale || 1); // 3D 画面的像素比（低档比叠加层低一点，见 QUALITY.low.scale）
    renderer.setPixelRatio(glDpr);
    renderer.setSize(vw, vh);
    if (post.ok) {
      post.composer.setPixelRatio(dpr);
      post.composer.setSize(vw, vh);
      post.grade.uniforms.uAspect.value = vw / vh;
    }
    camera.aspect = vw / vh;
    camera.updateProjectionMatrix();
    ocv.width = Math.round(vw * dpr);
    ocv.height = Math.round(vh * dpr);
    ocv.style.width = vw + 'px';
    ocv.style.height = vh + 'px';
    // 粒子按世界单位换算成像素大小
    pMat.uniforms.uScale.value = (vh * glDpr) / (2 * Math.tan((BASE_FOV * Math.PI) / 360));
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
    if (id === 'rift') {
      // 坠星裂谷：斜插在地里的几根星骸晶柱，根部压着暗色的琉璃块
      const C = 0x9fcfc2, D = 0x557a71, S = 0x22302c;
      return bake('prop/rift', [
        [gOct(0.42), C, 0, 1.3, 0, 0.12, 0.3, 0.1, 1, 3.2, 1],
        [gOct(0.3), D, 0.55, 0.8, 0.15, 0, 0, -0.45, 1, 2.6, 1],
        [gOct(0.26), C, -0.5, 0.65, -0.1, 0.2, 0, 0.5, 1, 2.4, 1],
        [gIco(0.55, 0), S, 0.1, 0.15, 0.35, 0.3, 0.2, 0, 1.1, 0.6, 1],
        [gIco(0.4, 0), S, -0.3, 0.1, -0.45, 0, 0.5, 0.2, 1, 0.55, 1],
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

  // ----- 坠星裂谷的布景 -----
  // 岩壁外斜插的星骸碑（两面刻着发光的符线）、悬在虚空上方缓缓起伏的浮岩、空地里的陨坑（发亮的坑沿 + 一圈碎晶）、
  // 首领场地外一圈坠落的天穹碎片。相机从 +z 俯视：靠近镜头一侧（南缘）的高物一律不放
  const obeliskGeo = () => jitterGeo('obelisk', new T.BoxGeometry(1, 1, 1, 1, 4, 1).translate(0, 0.5, 0), 0.16);
  const isleGeo = () =>
    bake('rift/isle', [
      [gCone(1, 2.4, 6), 0x2b3b37, 0, -1.2, 0, Math.PI, 0, 0],
      [gIco(1.05, 0), 0x3d524c, 0, 0.05, 0, 0, 0.4, 0, 1.1, 0.35, 1.1],
      [gOct(0.35), 0xbfe8dc, 0.35, 0.55, 0.1, 0.2, 0, 0.3, 0.6, 1.6, 0.6],
      [gOct(0.25), 0x9fd8c8, -0.4, 0.4, -0.2, -0.3, 0, -0.4, 0.6, 1.4, 0.6],
      [gIco(0.4, 0), 0x2b3b37, 0.5, -0.9, 0.3, 0.3, 0, 0],
    ]);
  // 陨坑：坑心暗、坑沿一圈亮环，十几道放射状的裂纹
  const craterTex = () =>
    tex('crater', () => {
      const S = 256, c = makeCanvas(S, S), g = c.getContext('2d'), R = S / 2;
      g.translate(R, R);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, R);
      gr.addColorStop(0, 'rgba(255,255,255,0.05)');
      gr.addColorStop(0.55, 'rgba(255,255,255,0.12)');
      gr.addColorStop(0.72, 'rgba(255,255,255,0.85)');
      gr.addColorStop(0.8, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(-R, -R, S, S);
      g.strokeStyle = '#fff';
      g.lineCap = 'round';
      for (let i = 0; i < 15; i++) {
        const a = (i / 15) * TAU + Math.sin(i * 7.3) * 0.2, r0 = R * (0.18 + 0.1 * Math.abs(Math.sin(i * 3.1))), r1 = R * (0.86 + 0.12 * Math.abs(Math.sin(i * 5.7)));
        g.lineWidth = 1.5 + 2 * Math.abs(Math.sin(i * 2.3));
        g.globalAlpha = 0.55;
        g.beginPath();
        g.moveTo(Math.sin(a) * r0, Math.cos(a) * r0);
        const am = a + Math.sin(i * 1.7) * 0.12;
        g.lineTo(Math.sin(am) * (r0 + r1) * 0.5, Math.cos(am) * (r0 + r1) * 0.5);
        g.lineTo(Math.sin(a) * r1, Math.cos(a) * r1);
        g.stroke();
      }
      return new T.CanvasTexture(c);
    });
  function riftPieces(zone, sd, ringSamples, lowK, accentL, crystalMat) {
    const def = zone.def;
    // 星骸碑
    const obs = [], strips = [], picked = [];
    ringSamples(5.5, 3.4, (x, z) => {
      x += rand(-1, 1);
      z += rand(-1, 1);
      if (sd(x, z) > -2.4 || lowK(x, z) < 1 || Math.random() < 0.4) return;
      for (const q of picked) if (Math.hypot(q.x - x, q.z - z) < 12) return;
      picked.push({ x, z });
      const h = rand(4.5, 7), w = rand(0.9, 1.3), d = rand(0.7, 0.95);
      const rx = rand(-0.35, 0.35), ry = rand(0, TAU), rz = rand(-0.4, 0.4);
      obs.push(x, -0.6, z, rx, ry, rz, w, h, d, rand(0.75, 1.05));
      for (let k = 0; k < 3; k++) {
        for (const side of [1, -1]) {
          _e.set(rx, ry, rz);
          _v.set(0, h * (0.3 + k * 0.2), side * (d * 0.5 + 0.02)).applyEuler(_e);
          strips.push(x + _v.x, -0.6 + _v.y, z + _v.z, rx, ry, rz, w * (k === 1 ? 0.7 : 0.42), 0.07, 0.04, 1);
        }
      }
    });
    const obMat = own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.2, flatShading: true }));
    instanced(obeliskGeo(), obMat, obs, true, lin(mixHex(def.rock, 0x0a0f0e, 0.2)));
    instanced(gBox(1, 1, 1), crystalMat, strips, false, null);

    // 浮岩：悬在虚空上方，每块各自慢慢起伏、打转（W.update 里动）
    const isMat = own(new T.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0, emissive: accentL, emissiveIntensity: 0.07 }));
    const isles = [], ig = isleGeo();
    ringSamples(8, 7.5, (x, z) => {
      x += rand(-2, 2);
      z += rand(-2, 2);
      if (isles.length >= 14 || sd(x, z) > -5.5 || lowK(x, z) < 1 || Math.random() < 0.3) return;
      for (const q of isles) if (Math.hypot(q.x - x, q.z - z) < 8) return;
      const m = new T.Mesh(ig, isMat), y = rand(1.6, 4.6);
      m.scale.setScalar(rand(0.7, 1.5));
      m.position.set(x, y, z);
      m.rotation.y = rand(0, TAU);
      m.castShadow = true;
      zoneGroup.add(m);
      isles.push({ m, x, z, y, ph: rand(0, TAU), sp: rand(0.25, 0.5), rot: rand(-0.08, 0.08) });
    });

    // 陨坑
    const crMat = own(new T.MeshBasicMaterial({ map: craterTex(), color: accentL, transparent: true, opacity: 0.5, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const dkMat = own(new T.MeshBasicMaterial({ map: blotchTex(), color: lin(mixHex(def.voidc, 0x000000, 0.3)), transparent: true, opacity: 0.6, depthWrite: false }));
    const craters = [], darks = [], shards = [];
    for (let ci = 1; ci < zone.circles.length - 1; ci++) {
      const c = zone.circles[ci];
      if (Math.random() < 0.25) continue;
      const a = rand(0, TAU), d = rand(0, Math.max(0, c.r - 5.5)), x = c.x + Math.sin(a) * d, z = c.z + Math.cos(a) * d, r = rand(2.6, 3.8);
      craters.push(x, 0.035, z, 0, rand(0, TAU), 0, r, 1, r, 1);
      darks.push(x, 0.025, z, 0, rand(0, TAU), 0, r * 1.2, 1, r * 1.2, 1);
      const n = G.randInt(5, 8);
      for (let k = 0; k < n; k++) {
        const b = (k / n) * TAU + rand(-0.3, 0.3), rr = r * rand(0.72, 0.9), h = rand(0.25, 0.6);
        shards.push(x + Math.sin(b) * rr, h * 0.35, z + Math.cos(b) * rr, Math.cos(b) * 0.6, rand(0, TAU), -Math.sin(b) * 0.6, 0.12, h, 0.12, 1);
      }
    }
    const dIM = instanced(gQuad(), dkMat, darks, false, null);
    if (dIM) dIM.renderOrder = 1;
    const cIM = instanced(gQuad(), crMat, craters, false, null);
    if (cIM) cIM.renderOrder = 1;
    instanced(gOct(1), crystalMat, shards, true, null);

    // 首领场地外的天穹碎片
    const bp = zone.bossPos, sky = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * TAU + rand(-0.2, 0.2), d = zone.bossR + rand(3.5, 6.5);
      const x = bp.x + Math.sin(a) * d, z = bp.z + Math.cos(a) * d;
      if (sd(x, z) > -2.8 || lowK(x, z) < 1) continue;
      const h = rand(3, 5.5);
      sky.push(x, h * 0.3, z, rand(-0.3, 0.3), rand(0, TAU), rand(-0.3, 0.3), h * 0.22, h, h * 0.22, 1);
    }
    const skyMat = own(
      new T.MeshStandardMaterial({ color: lin(mixHex(def.accent, 0xffffff, 0.55)).multiplyScalar(0.35), emissive: accentL, emissiveIntensity: 0.55, roughness: 0.15, metalness: 0.1, flatShading: true })
    );
    instanced(gOct(1), skyMat, sky, true, null);
    return { isles, skyMat };
  }

  function buildVisuals(zone) {
    const def = zone.def;
    const st = GROUND_STYLE[def.id] || GROUND_STYLE.ash;
    // 区域的 CC0 素材已经就绪就用 PBR 外观（hd），否则先用程序化外观，同时去加载素材
    const gx = ZONE_GFX[def.id] || null;
    zoneTex = Object.create(null);
    zoneGroup = new T.Group();
    scene.add(zoneGroup);
    const hd = gfxReady(gx);
    const tx = hd ? null : groundTextures(def, st);

    // 氛围：雾在 r128 里是在色调映射和编码之后混合的，所以直接用显示色
    // 卡通光照：暖的主光、冷紫的阴影色（半球光天空色）、暖的地面反光、冷色的轮廓补光（ZONE_LIGHT）
    applyZoneLight(toonLightOf(def));
    applyZonePost(gx);

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
    // 第 0 区（卡通布景）：靠墙的地面压得更暗、范围更宽（把空地框出来），从起点到出口那条踩出来的路提亮一点
    const ash = def.id === 'ash', ashT = ash ? ashTrail(zone) : null;
    const x0 = b.minX - M, z0 = b.minZ - M;
    const nx = Math.ceil((b.maxX - b.minX + 2 * M) / CS), nz = Math.ceil((b.maxZ - b.minZ + 2 * M) / CS);
    const sx = nx + 1;
    const sdv = new Float32Array(sx * (nz + 1));
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) sdv[j * sx + i] = sd(x0 + i * CS, z0 + j * CS);
    const vid = new Int32Array(sx * (nz + 1)).fill(-1);
    const pos = [], uv = [], col = [], idx = [], aw = [];
    const vert = (i, j) => {
      const k = j * sx + i;
      if (vid[k] >= 0) return vid[k];
      const x = x0 + i * CS, z = z0 + j * CS, d = sdv[k];
      const n = 0.84 + 0.3 * vnoise(x * 0.09 + 7.3, z * 0.09 - 2.1);
      const ao = ash ? 0.42 + 0.58 * smooth01((d + 0.3) / 3.6) : 0.5 + 0.5 * smooth01(d / 2.6); // 靠近岩壁的地面更暗
      let kk = d >= 0 ? 1 : smooth01(1 + d / SKIRT);
      kk *= kk;
      let lit = n * ao;
      const tk = ashT && d > -0.5 ? (1 - smooth01((ashT(x, z) - 0.8) / 1.4)) * smooth01((d + 0.5) / 1.2) : 0; // 踩出来的路
      lit *= 1 + 0.2 * tk;
      pos.push(x, 0, z);
      uv.push(x / TILE, -z / TILE);
      if (hd) {
        // PBR 地面：顶点色只管明暗（压暗靠墙处、向虚空渐暗），颜色来自材质；aW = (路面权重, 岩壁权重)，其余是粗糙地面
        const v = GROUND_VK + (lit - GROUND_VK) * kk;
        const tv = ash ? (vnoise(x * 0.07 - 4.1, z * 0.07 + 8.3) - 0.5) * 0.14 : 0; // 第 0 区：大片的冷暖起伏（画出来的感觉）
        col.push(v * (1 + 0.07 * tk + tv), v, v * (1 - 0.1 * tk - tv));
        const pn = vnoise(x * 0.17 + 11.3, z * 0.17 - 5.1);
        let wp = smooth01((d + 0.45) / 1.0);
        // 路面上零星的粗糙斑块，离路边越远越少；第 0 区斑块更多更实（打散满地一样的龟裂纹），踩出来的路上没有
        wp *= ash ? 1 - 0.85 * smooth01((pn - 0.56) / 0.16) * smooth01((d + 0.5) / 2.5) * (1 - tk) * smooth01((Math.hypot(x - zone.start.x, z - zone.start.z) - 3) / 3) : 1 - 0.55 * smooth01((pn - 0.58) / 0.2) * smooth01(d / 2.2);
        aw.push(wp, smooth01((-d - 0.9) / 2.2) * (1 - wp));
      } else col.push(vm[0] + (lit - vm[0]) * kk, vm[1] + (lit - vm[1]) * kk, vm[2] + (lit - vm[2]) * kk);
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
    if (hd) gg.setAttribute('aW', new T.Float32BufferAttribute(aw, 2));
    gg.setIndex(pos.length / 3 > 65535 ? new T.Uint32BufferAttribute(idx, 1) : new T.Uint16BufferAttribute(idx, 1));
    const gmat = hd ? groundMaterial(gx, def) : own(
      new T.MeshStandardMaterial({
        map: tx.map, bumpMap: tx.bump, bumpScale: st.bump, emissiveMap: tx.emis,
        emissive: lin(def.accent), emissiveIntensity: st.emis,
        roughness: st.rough, metalness: 0, vertexColors: true,
      })
    );
    // 发光裂纹只留在路面上，虚空里跟着顶点色一起熄灭
    if (!hd) gmat.onBeforeCompile = (sh) => {
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
    if (hd) {
      // 和地面同一个材质：全是岩壁那一套、顶点色 = 虚空亮度，跟地面外缘无缝衔接
      vg.setAttribute('aW', new T.Float32BufferAttribute([0, 1, 0, 1, 0, 1, 0, 1], 2));
      vg.setAttribute('color', new T.Float32BufferAttribute(new Array(12).fill(GROUND_VK), 3));
    }
    const vmat = hd ? gmat : own(
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
      const coin = Math.random() < 0.5;
      const list = ash ? (s < 0.9 ? rocksB : rocksA) : coin ? rocksA : rocksB; // 第 0 区：大石头用多面数的倒角岩，小的用少面数的
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
    // 第 0 区：卡通岩石（纯色 + 笔触 + 竖向渐变，不用照片贴图），程序化外观和 PBR 外观都一样
    const rockMat = ash
      ? ashRockMat()
      : hd
        ? triMaterial(gx, { con: 1, nrm: 1, sat: 1, rough: 0.92, cap: true })
        : own(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0, flatShading: true }));
    const rockTint = ash ? new T.Color(1, 1, 1) : lin(def.rock);
    if (ash) {
      // 同一种几何体换几个变体（每个变体一个实例化网格），不至于所有石头一个样
      const split = (list, n) => {
        const out = [];
        for (let k = 0; k < n; k++) out.push([]);
        for (let i = 0; i < list.length; i += 10) out[(i / 10) % n].push(...list.slice(i, i + 10));
        return out;
      };
      split(rocksA, 2).forEach((l, k) => instanced(ashRockGeo(k), rockMat, l, true, rockTint));
      split(rocksB, 2).forEach((l, k) => instanced(ashRockGeo(2 + k), rockMat, l, true, rockTint));
      instanced(ashSpireGeo(), rockMat, spires, true, rockTint);
    } else {
      instanced(rockGeoA(), rockMat, rocksA, true, rockTint);
      instanced(rockGeoB(), rockMat, rocksB, true, rockTint);
      instanced(spireGeo(), rockMat, spires, true, rockTint);
    }

    // --- 主题摆件（有 CC0 布景模型时只保留 keep 比例的程序化摆件，其余换成模型，见 buildProps） ---
    const props = [];
    const withProps = hd && propsReady(gx);
    const keepK = withProps ? gx.props.keep : 1;
    ringSamples(6.5, 4.2, (x, z) => {
      x += rand(-1.5, 1.5);
      z += rand(-1.5, 1.5);
      if (sd(x, z) > -3.0 || Math.random() < 0.3 || Math.random() >= keepK) return;
      const s = rand(0.85, 1.6);
      props.push(x, -0.1, z, rand(-0.1, 0.1), rand(0, TAU), rand(-0.1, 0.1), s, s * rand(0.9, 1.3) * (lowK(x, z) < 1 ? 0.65 : 1), s, 1);
    });
    const icy = def.id === 'frost', rift = def.id === 'rift';
    const propMat = own(
      new T.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: icy ? 0.25 : rift ? 0.35 : 0.9, metalness: icy || rift ? 0.1 : 0,
        emissive: lin(def.accent), emissiveIntensity: icy ? 0.22 : rift ? 0.2 : def.id === 'abyss' ? 0.1 : 0,
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
      // 卡通：污斑不再是近黑的一大片（旧 0.38 不透明度把地面弄脏），颜色偏向这个区域的阴影色、淡一半
      new T.MeshBasicMaterial({ map: blotchTex(), color: lin(ash ? 0x2a1c1a : mixHex(mixHex(def.voidc, toonLightOf(def).shade, 0.3), 0x000000, 0.3)), transparent: true, opacity: 0.2, depthWrite: false }) // 第 0 区：暖的焦黑，不是冷紫
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
    // 起点的法阵：镜头拉近后原来的 3.4 会铺满半个画面，收成脚下一小圈、更淡（布景工作可以整个换掉）
    // 第 0 区不要起点法阵（贴在地上像界面，和布景不是一体的）；起点的布景见 buildAshDress
    if (!ash) sigil(zone.start.x, zone.start.z, 1.9, mixHex(def.sky, 0xffffff, 0.3), 0.1);
    const dress = ash ? buildAshDress(zone, sd) : null;
    const rp = rift ? riftPieces(zone, sd, ringSamples, lowK, accentL, crystalMat) : null;
    // --- CC0 布景模型、火盆、贴地薄雾 ---
    let fires = null, mist = null;
    if (hd) {
      if (withProps) {
        const pm = triMaterial(gx, { vc: true, con: 0.5, nrm: 0.6, sat: gx.prop.sat, tint: gx.prop.tint, tintK: 1.0, rough: 0.86 });
        fires = buildProps(zone, gx, sd, ringSamples, lowK, { rock: rockMat, prop: pm });
      }
      if (gx.mist) mist = buildMist(zone, gx, sd);
      prefetchNext(def);
    }
    if (gx && !withProps) requestZoneAssets(zone, gx);

    _c.set(def.accent);
    zoneFx = {
      st, crystalMat, glowMat, bossSigil,
      ar: _c.r, ag: _c.g, ab: _c.b,
      ambAcc: 0, boltIn: rand(3, 7), boltT: 0,
      isles: rp ? rp.isles : null, skyMat: rp ? rp.skyMat : null, starIn: rand(1.5, 4),
      fires, mist, gU: hd ? gmat.userData.U : null, hd, props: withProps, dress,
    };
  }

  // 建外观时 PBR 那条路出了任何错，都退回程序化外观重建一次（不让素材问题拖垮游戏）
  function safeBuildVisuals(zone) {
    try {
      buildVisuals(zone);
    } catch (e) {
      const gx = ZONE_GFX[zone.def.id];
      if (!gx || gfxBroken[gx.packs[0]]) throw e;
      gfxBroken[gx.packs[0]] = true;
      if (window.console) console.warn('[画面] 区域外观建立失败，改用程序化外观', e);
      disposeZone();
      buildVisuals(zone);
    }
  }

  W.buildZone = function (def, level) {
    disposeZone();
    W.clearFx();
    hideRiftFx();
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
    safeBuildVisuals(zone);
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
  // 扁的一绺头发：沿折线扫出扁椭圆截面（宽 w[i]、厚 th[i]，都是半径），薄的那一面始终朝外（背向 ctr），
  // 所以整绺贴着头皮躺平、从正面看是一片梳顺的发面而不是一根尖刺。两端收成圆钝的头
  function gStrand(key, pts, w, th, ctr, sub = 3) {
    return geo('S' + key, () => {
      const curve = new T.CatmullRomCurve3(pts.map((p) => new T.Vector3(p[0], p[1], p[2])), false, 'centripetal');
      const n = (pts.length - 1) * sub, R = 6;
      const pos = [], nor = [], idx = [];
      const pt = new T.Vector3(), tan = new T.Vector3(), out = new T.Vector3(), side = new T.Vector3(), C = new T.Vector3(ctr[0], ctr[1], ctr[2]);
      const lerp = (a, u) => {
        const f = u * (a.length - 1), i0 = Math.min(a.length - 2, Math.floor(f));
        return a[i0] + (a[i0 + 1] - a[i0]) * (f - i0);
      };
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        curve.getPoint(u, pt);
        curve.getTangent(u, tan);
        out.subVectors(pt, C);
        out.addScaledVector(tan, -out.dot(tan)).normalize();
        side.crossVectors(out, tan).normalize(); // (side, out) 绕切线逆时针，和 gSweep 的绕序一致
        // 两端各收一点，端面不至于是一刀切的平口
        const e = Math.min(1, Math.min(u, 1 - u) * n * 0.9 + 0.35);
        const ww = lerp(w, u) * e, tt = lerp(th, u) * e;
        for (let k = 0; k < R; k++) {
          const a = (k / R) * TAU, ca = Math.cos(a), sa = Math.sin(a);
          pos.push(pt.x + side.x * ca * ww + out.x * sa * tt, pt.y + side.y * ca * ww + out.y * sa * tt, pt.z + side.z * ca * ww + out.z * sa * tt);
          const nx = side.x * ca * tt + out.x * sa * ww, ny = side.y * ca * tt + out.y * sa * ww, nz = side.z * ca * tt + out.z * sa * ww, l = Math.hypot(nx, ny, nz) || 1;
          nor.push(nx / l, ny / l, nz / l);
        }
      }
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < R; k++) {
          const a = i * R + k, b = i * R + ((k + 1) % R), c = a + R, d = b + R;
          idx.push(a, b, c, b, d, c);
        }
      }
      // 端面：扇形封口（截面很扁，看不出平口）
      for (const [i, s] of [[0, -1], [n, 1]]) {
        const base = i * R;
        for (let k = 1; k < R - 1; k++) {
          if (s < 0) idx.push(base, base + k + 1, base + k);
          else idx.push(base, base + k, base + k + 1);
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
      g.setIndex(idx);
      return g;
    });
  }

  const _tc = [0, 0, 0];
  // ----- 骨架定义 + 零件烘焙 -----
  // 用法：b.j(关节名, 父关节, 枢轴 x,y,z)；b.at(关节).surf(表面).p(几何体, 颜色, 位置…, 旋转…, 缩放…)
  // 所有坐标都是模型空间里的绑定姿态（面朝 +z，+x 是它的左手边，脚踩 y = 0）。
  // cs（可选）：C 模型的配置。给了它时，本体关节上的程序化零件按 cs.keep(关节名, 种类) 过滤（种类：p 受光 / g 自发光 / x 稀有度光），
  // 被换掉的身体由 cApply 换成 C 模型的网格；武器等留下的零件照常烘焙
  function rigBuilder(key, NB, cs) {
    const joints = [], JI = Object.create(null), virt = [];
    let curTag = null; // b.tag(名字)：之后的零件带这个标签（给 cs.keep 区分同一关节上的武器和身体）
    const skip = (kind) => cs && !cs.keep(joints[curJ].name, kind, curTag);
    const body0 = [], glow0 = [], aux0 = [];
    // 变体：同一副骨架上可以互换显示的几组零件（玩家手里的远程武器）。b.variant(名字) 之后的零件进这一组，b.variant(null) 回到本体
    const variants = Object.create(null);
    let body = body0, glow = glow0, aux = aux0;
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
        // px0..pz0：程序化骨架原本的枢轴（换成 C 模型后 px..pz 会挪；按绑定坐标写死的武器握点、弓梢等用 px0 换算）
        joints.push({ name, parent: pi, px: x, py: y, pz: z, px0: x, py0: y, pz0: z, lx: x - (pj ? pj.px : 0), ly: y - (pj ? pj.py : 0), lz: z - (pj ? pj.pz : 0) });
        return B;
      },
      // 虚关节：只占姿态通道、不占骨骼（不能挂零件）。动作照常给它写关键帧，post / late 里当信号读（玩家的 cape1..3）
      v(name) {
        virt.push(name);
        return B;
      },
      at(name) {
        if (JI[name] === undefined) throw new Error('rig ' + key + ': 未定义的关节 ' + name);
        curJ = JI[name];
        return B;
      },
      tag(t) {
        curTag = t || null;
        return B;
      },
      variant(name) {
        if (!name) {
          body = body0; glow = glow0; aux = aux0;
        } else {
          const v = variants[name] || (variants[name] = { body: [], glow: [], aux: [] });
          body = v.body; glow = v.glow; aux = v.aux;
        }
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
        if (!skip('p')) body.push(mk(g, c, x, y, z, rx, ry, rz, sx, sy, sz));
        return B;
      },
      // 双面零件（披风、旗幡）：外侧 c，内侧 ci
      pd(g, c, ci, x, y, z, rx, ry, rz, sx, sy, sz) {
        if (skip('p')) return B;
        const part = mk(g, c, x, y, z, rx, ry, rz, sx, sy, sz);
        part.ci = ci;
        body.push(part);
        return B;
      },
      // 第二组自发光零件，用独立材质（玩家武器上随稀有度变色的部分）
      x(g, k, x, y, z, rx, ry, rz, sx, sy, sz) {
        if (skip('x')) return B;
        const part = mk(g, 0, x, y, z, rx, ry, rz, sx, sy, sz);
        part.k = k;
        part.s = SURF.glow;
        aux.push(part);
        return B;
      },
      // 自发光零件：k 是亮度（1 = 元素色全亮）
      g(g, k, x, y, z, rx, ry, rz, sx, sy, sz) {
        if (skip('g')) return B;
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
        // 卡通：不再把其余角色压成暗色调（旧的 style C 暗色曲线），所有角色的顶点色统一过 toonCast（抬死黑、提饱和）。
        // o.tone 保留为开关（false = 连 toonCast 也不过，原样用调色板）
        const tone = o.tone === undefined ? true : o.tone;
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
                // 手绘感的明暗起伏：按位置取平滑噪声（一片片过渡，而不是旧的「一面一色」的平涂抖动），顶部略亮
                const kk = 1 + (vnoise(px * 5.3 + pz * 2.9 + 11.1, py * 5.3 - pz * 1.7) - 0.5) * jit * 2.2;
                r *= kk; g *= kk; bl *= kk;
              }
              if (!isGlow && tone) {
                _tc[0] = r; _tc[1] = g; _tc[2] = bl;
                toonCast(_tc);
                r = _tc[0]; g = _tc[1]; bl = _tc[2];
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
        for (let i = 0; i < virt.length; i++) JI[virt[i]] = nJ + i;
        const nC = (nJ + virt.length) * CH;
        const rest = new Float32Array(nC);
        for (let i = 0; i < nC; i += CH) rest[i + 6] = rest[i + 7] = rest[i + 8] = 1;
        const J = Object.create(null);
        for (const name in JI) J[name] = JI[name] * CH;
        const geoBody = bake1(body0, false), geoGlow = bake1(glow0, true), geoAux = bake1(aux0, true);
        const cnt = (g) => (g ? g.attributes.position.count / 3 : 0);
        const geoVar = Object.create(null);
        for (const vn in variants) {
          const v = variants[vn];
          geoVar[vn] = { body: bake1(v.body, false), glow: bake1(v.glow, true), aux: bake1(v.aux, true) };
        }
        return {
          key, NB, joints, JI, J, nJ, rest, geoBody, geoGlow, geoAux, geoVar,
          tris: cnt(geoBody) + cnt(geoGlow) + cnt(geoAux),
          height: o.height, reach: o.reach || 1.5, stride: o.stride || 3, clips: Object.create(null), gearClips: Object.create(null), loco: null, post: null, late: null,
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
      // 只有玩家用：hand / handL 手的轨迹（交给 IK）；draw 拉弓的程度；arrow 右手捏箭；ikL 双手武器时左手握柄的权重
      hand: spec.hand ? handTrack(spec.hand) : null,
      handL: spec.handL ? handTrack(spec.handL) : null,
      draw: spec.draw || null, arrow: !!spec.arrow, ikL: spec.ikL,
      spec, // 原始描述：镜像 / 双手版本从它派生
    };
  }
  // 手的轨迹：{ f: 'chest' 胸口坐标系（默认）| 'model', k: [时刻...]（负数 = 加速冲到这一帧，同 kf）,
  //   p: [[x,y,z]...] 握点位置, d: [[x,y,z]...] 武器指向, e: [[x,y,z]...] 刃口朝向（缺省朝下）, w: [权重...]（缺省 1） }
  function handTrack(h) {
    const K = [];
    for (let i = 0; i < 9; i++) {
      const arr = [];
      for (let j = 0; j < h.k.length; j++) {
        const src = i < 3 ? h.p[j] : i < 6 ? h.d[j] : h.e ? h.e[j] : null;
        arr.push(h.k[j], src ? src[i % 3] : i === 7 ? -1 : 0);
      }
      K.push(arr);
    }
    let W = null;
    if (h.w) {
      W = [];
      for (let j = 0; j < h.k.length; j++) W.push(h.k[j], h.w[j]);
    }
    return { f: h.f || 'chest', K, W };
  }
  const aliasClip = (rig, name, target) => (rig.clips[name] = rig.clips[target]);
  // 给某种武器注册一个同名动作的替换版本（W.play 时按 ent.gearClips 先查）
  function defGearClip(rig, gear, name, spec) {
    const keep = rig.clips[name];
    defClip(rig, name, spec);
    const c = rig.clips[name];
    if (keep) rig.clips[name] = keep;
    else delete rig.clips[name];
    (rig.gearClips[gear] || (rig.gearClips[gear] = Object.create(null)))[name] = c;
    return c;
  }
  // 左右镜像一组关键帧：左右关节互换，绕 y / z 轴的转角和 x 向位移取反
  const MIRROR_J = { uaL: 'uaR', uaR: 'uaL', faL: 'faR', faR: 'faL', hL: 'hR', hR: 'hL', thL: 'thR', thR: 'thL', shL: 'shR', shR: 'shL', ftL: 'ftR', ftR: 'ftL' };
  function mirrorKeys(keys) {
    const out = {};
    for (const key in keys) {
      const dot = key.indexOf('.'), jn = key.slice(0, dot), ch = key.slice(dot + 1);
      const flip = ch === 'ry' || ch === 'rz' || ch === 'ox';
      out[(MIRROR_J[jn] || jn) + '.' + ch] = flip ? keys[key].map((v, i) => (i % 2 ? -v : v)) : keys[key];
    }
    return out;
  }

  // =====================================================================
  // C 模型：Quaternius 的平涂低多边形角色（CC0，2018–2020 的免费包），按卡通配色（设计稿 2.3）重新上色，蒙皮到程序化骨架上
  // =====================================================================
  // 源文件由 tools/convert-chars.mjs 转成精简的 GLB，tools/pack-assets.mjs 打成 js/assets/chars.js（base64，index.html 里同步引入，
  // file:// 双击打开也能用）。这里同步解析 GLB（不经过 GLTFLoader），然后：
  //   1. 摆姿势（静止姿态校正）：把模型的绑定姿态（T 字等）逐骨骼转到程序化骨架的静止姿态——上臂 / 小臂 / 大腿 / 小腿的朝向
  //      对齐程序化关节之间的连线（或配置里给的方向），手指握成拳，头可以缩小一点；
  //   2. 关节枢轴挪到模型对应骨骼的位置；没有对应骨骼的关节（武器、弓弦、幡布……）跟着父关节平移，挂在上面的程序化零件一起平移；
  //   3. 网格按摆好的姿势烘焙成静止姿态的顶点，每个顶点最多 4 根骨骼的权重换算到程序化关节上（多根骨骼并到同一关节的权重相加），
  //      和留下来的程序化零件（武器等）合成同一个几何体，着色器按 4 权重蒙皮（SKIN4）。
  // 原有的 defClip 动作、步态、IK、挂点、受击、死亡于是原样驱动新网格；模型自带的动作也能经 cClipKeys 采样成同一套关节通道的关键帧。
  // 任何一步失败都退回纯程序化骨架（cTry）。
  const CM = Object.create(null); // 模型 key → 解析结果（失败为 null）
  function cParse(b64) {
    const bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    const dv = new DataView(u8.buffer);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB');
    const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jl)));
    const b0 = 20 + jl + 8;
    const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    const CT = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
    const acc = (i) => {
      const a = json.accessors[i], v = json.bufferViews[a.bufferView], C = CT[a.componentType], len = a.count * NC[a.type];
      const off = b0 + (v.byteOffset || 0) + (a.byteOffset || 0);
      const out = new C(u8.buffer.slice(off, off + len * C.BYTES_PER_ELEMENT));
      if (!a.normalized) return out;
      const f = new Float32Array(len), d = a.componentType === 5121 ? 255 : 65535;
      for (let k = 0; k < len; k++) f[k] = out[k] / d;
      return f;
    };
    const sk = json.skins[0], nodes = json.nodes, nb = sk.joints.length;
    const boneOf = new Map();
    sk.joints.forEach((ni, i) => boneOf.set(ni, i));
    const parent = new Int16Array(nb).fill(-1);
    sk.joints.forEach((ni, i) => (nodes[ni].children || []).forEach((c) => { if (boneOf.has(c)) parent[boneOf.get(c)] = i; }));
    const ibm = acc(sk.inverseBindMatrices);
    const B = [];
    for (let i = 0; i < nb; i++) B.push(new T.Matrix4().fromArray(ibm, i * 16).invert());
    const names = sk.joints.map((ni) => nodes[ni].name);
    const loc = sk.joints.map((ni) => ({ t: nodes[ni].translation || [0, 0, 0], q: nodes[ni].rotation || [0, 0, 0, 1] }));
    const mats = json.materials.map((m) => ({ name: m.name, c: m.pbrMetallicRoughness.baseColorFactor }));
    const prims = json.meshes[0].primitives.map((p) => ({
      name: (p.extras && p.extras.name) || '', mat: mats[p.material].name, base: mats[p.material].c,
      P: acc(p.attributes.POSITION), J: acc(p.attributes.JOINTS_0), W: acc(p.attributes.WEIGHTS_0),
      C: p.attributes.COLOR_0 !== undefined ? acc(p.attributes.COLOR_0) : null, I: acc(p.indices),
    }));
    const clips = Object.create(null);
    for (const a of json.animations || []) {
      const times = acc(a.samplers[a.channels[0].sampler].input);
      const ch = a.channels.map((c) => ({ b: boneOf.get(c.target.node), path: c.target.path, v: acc(a.samplers[c.sampler].output) })).filter((c) => c.b !== undefined);
      clips[a.name] = { n: times.length, dur: times[times.length - 1], ch };
    }
    const bi = Object.create(null);
    names.forEach((nm, i) => (bi[nm] = i));
    const order = [];
    const visit = (i) => {
      order.push(i);
      for (let k = 0; k < nb; k++) if (parent[k] === i) visit(k);
    };
    for (let i = 0; i < nb; i++) if (parent[i] < 0) visit(i);
    let ymax = 0;
    for (const p of prims) for (let k = 1; k < p.P.length; k += 3) if (p.P[k] > ymax) ymax = p.P[k];
    return { nb, names, bi, parent, order, B, loc, prims, clips, ymax };
  }
  function cModel(key) {
    if (key in CM) return CM[key];
    let m = null;
    try {
      const st = window.CA_ASSETS && window.CA_ASSETS.chars;
      const b64 = st && st.models && st.models[key];
      if (b64) {
        m = cParse(b64);
        st.models[key] = null; // 解析完就放掉 base64 文本（约 0.6 MB），和 assets.js 处理其它资源包一样
      }
    } catch (e) {
      if (window.console) console.warn('[角色] 模型 ' + key + ' 解析失败，改用程序化外观', e);
      m = null;
    }
    return (CM[key] = m);
  }
  // 这副骨架要不要换成 C 模型：有配置、模型解析成功、没有被关掉（window.CA_PROCEDURAL_CHARS = true 时全部用程序化外观）
  function cSpec(key) {
    const sp = CSPEC[key];
    if (!sp || window.CA_PROCEDURAL_CHARS) return null;
    const md = cModel(sp.model);
    return md ? Object.assign({ key, md }, sp) : null;
  }
  // 先按 C 模型建骨架，出错就退回纯程序化
  function cTry(key, make) {
    const cs = cSpec(key);
    if (cs) {
      try {
        return make(cs);
      } catch (e) {
        if (window.console) console.warn('[角色] ' + key + ' 套用模型失败，改用程序化外观', e);
      }
    }
    return make(null);
  }

  const _cm = new T.Matrix4(), _cm2 = new T.Matrix4(), _cq = new T.Quaternion(), _cv = new T.Vector3(), _cv2 = new T.Vector3(), _cv3 = new T.Vector3();
  // M ← T(o) · R · T(−o) · M（绕 M 的原点做世界空间里的变换）
  function cAround(M, R) {
    _cv.setFromMatrixPosition(M);
    M.premultiply(_cm.makeTranslation(-_cv.x, -_cv.y, -_cv.z)).premultiply(R).premultiply(_cm.makeTranslation(_cv.x, _cv.y, _cv.z));
  }
  // 摆出静止姿态：返回每根骨骼摆好后的世界矩阵（程序化骨架的模型空间）。Bg：绑定姿态的世界矩阵（同一空间）
  function cPose(md, cs, Bg, Bgi, piv) {
    const P = new Array(md.nb), F = new Array(md.nb), SX = new Array(md.nb);
    for (const i of md.order) {
      const p = md.parent[i], nm = md.names[i];
      P[i] = p < 0 ? Bg[i].clone() : F[p].clone().multiply(_cm2.copy(Bgi[p]).multiply(Bg[i]));
      // 父骨骼被拉长了：子骨骼只跟着挪到拉长后的位置，自己不被拉长
      if (p >= 0 && SX[p]) P[i].setPosition(_cv2.setFromMatrixPosition(P[i]).applyMatrix4(SX[p]));
      const aim = cs.aim && cs.aim(nm);
      if (aim) {
        // 这根骨骼「指向」子骨骼 aim[0]（不必真是子节点：按绑定姿态里的相对位置算），转到目标方向 aim[1]
        const k = md.bi[aim[0]];
        _cv2.setFromMatrixPosition(P[i]);
        _cv3.setFromMatrixPosition(_cm2.copy(P[i]).multiply(Bgi[i]).multiply(Bg[k])).sub(_cv2).normalize();
        const t = aim[1];
        if (typeof t[0] === 'string') {
          const a = piv(t[0]), b = piv(t[1]);
          _cv2.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
        } else _cv2.set(t[0], t[1], t[2]).normalize();
        cAround(P[i], _cm2.makeRotationFromQuaternion(_cq.setFromUnitVectors(_cv3, _cv2)));
      }
      const rot = cs.rot && cs.rot(nm);
      if (rot) cAround(P[i], _cm2.makeRotationAxis(_cv2.set(rot[0], rot[1], rot[2]).normalize(), rot[3]));
      const sc = cs.scale && cs.scale(nm);
      if (sc) cAround(P[i], _cm2.makeScale(sc, sc, sc));
      // 沿骨骼方向拉长（骷髅的短腿）：st = [指向的骨骼, 倍数]
      const st = cs.stretch && cs.stretch(nm);
      if (st) {
        const k = md.bi[st[0]];
        _cv2.setFromMatrixPosition(P[i]);
        _cv3.setFromMatrixPosition(_cm2.copy(P[i]).multiply(Bgi[i]).multiply(Bg[k])).sub(_cv2).normalize();
        const f = st[1] - 1, x = _cv3.x, y = _cv3.y, z = _cv3.z;
        F[i] = P[i].clone();
        _cv2.setFromMatrixPosition(P[i]);
        const o = _cv2.clone();
        SX[i] = new T.Matrix4().set(1 + f * x * x, f * x * y, f * x * z, 0, f * x * y, 1 + f * y * y, f * y * z, 0, f * x * z, f * y * z, 1 + f * z * z, 0, 0, 0, 0, 1);
        SX[i].premultiply(_cm2.makeTranslation(o.x, o.y, o.z)).multiply(_cm2.makeTranslation(-o.x, -o.y, -o.z));
        P[i].premultiply(SX[i]);
        continue;
      }
      F[i] = P[i];
    }
    P.F = F; // 不带拉长的骨骼坐标系（采样模型动作时用）
    return P;
  }
  // 程序化骨架上留下来的零件（刚性、单骨骼）→ SKIN4 的数组；顺手按关节的位移平移
  function cRigid(g, dl, out) {
    if (!g) return;
    const p = g.attributes.position.array, n = g.attributes.normal.array, c = g.attributes.color.array, b = g.attributes.aBone.array, s = g.attributes.aSurf.array;
    for (let v = 0; v < b.length; v++) {
      const j = b[v] | 0;
      out.P.push(p[v * 3] + dl[j * 3], p[v * 3 + 1] + dl[j * 3 + 1], p[v * 3 + 2] + dl[j * 3 + 2]);
      out.N.push(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
      out.C.push(c[v * 3], c[v * 3 + 1], c[v * 3 + 2]);
      out.J.push(j, 0, 0, 0);
      out.W.push(1, 0, 0, 0);
      out.S.push(s[v * 2], s[v * 2 + 1]);
    }
  }
  const cBuf = () => ({ P: [], N: [], C: [], J: [], W: [], S: [] });
  // 蒙皮矩阵 K 下网格（不含隐藏的部分）的最低点
  function cLowY(md, cs, K) {
    let lo = Infinity;
    const v = new T.Vector3();
    for (const pr of md.prims) {
      if (cs.hide && cs.hide(pr.name, pr.mat)) continue;
      for (let i = 0, nv = pr.P.length / 3; i < nv; i++) {
        let y = 0;
        for (let k = 0; k < 4; k++) {
          const w = pr.W[i * 4 + k];
          if (w > 0) y += v.set(pr.P[i * 3], pr.P[i * 3 + 1], pr.P[i * 3 + 2]).applyMatrix4(K[pr.J[i * 4 + k]]).y * w;
        }
        if (y < lo) lo = y;
      }
    }
    return lo;
  }
  function cGeo(o, rig) {
    if (!o.P.length) return null;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(o.P, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(o.N, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(o.C, 3));
    g.setAttribute('aSkin', new T.Float32BufferAttribute(o.J, 4));
    g.setAttribute('aSkinW', new T.Float32BufferAttribute(o.W, 4));
    g.setAttribute('aSurf', new T.Float32BufferAttribute(o.S, 2));
    g.boundingSphere = new T.Sphere(new T.Vector3(0, rig.height * 0.5, 0), rig.height * 0.5 + (rig.reach || 1.5));
    return g;
  }
  // 把 C 模型套到刚建好的程序化骨架上（rig 来自 rigBuilder(.., cs).build）
  function cApply(rig, cs) {
    if (!cs) return;
    const md = cs.md, Jn = rig.joints, nJ = Jn.length;
    const piv0 = (n) => {
      const j = Jn[rig.JI[n]];
      return [j.px0 === undefined ? j.px : j.px0, j.py0 === undefined ? j.py : j.py0, j.pz0 === undefined ? j.pz : j.pz0];
    };
    // 模型空间换算：绕 y 转 yaw、等比缩放到 cs.height、骨盆对准 root 的水平位置
    const s = cs.height / md.ymax;
    const G = new T.Matrix4().makeRotationY(cs.yaw || 0).multiply(new T.Matrix4().makeScale(s, s, s));
    _cv.setFromMatrixPosition(md.B[md.bi[cs.center]]).applyMatrix4(G);
    const r0 = piv0('root');
    G.premultiply(new T.Matrix4().makeTranslation(r0[0] - _cv.x, 0, r0[2] - _cv.z));
    // 骨骼的世界矩阵换到这个空间：G · B · L⁻¹（L 是 G 去掉平移的部分，换完仍是不带缩放的刚体矩阵；蒙皮 P·B⁻¹ 里 L 抵消）
    const Gi = new T.Matrix4().makeRotationY(cs.yaw || 0).multiply(new T.Matrix4().makeScale(s, s, s)).invert();
    let Bg = md.B.map((m) => G.clone().multiply(m).multiply(Gi));
    let Bgi = Bg.map((m) => m.clone().invert());
    let P = cPose(md, cs, Bg, Bgi, piv0);
    // 贴地（cs.ground）：摆好姿势后网格最低点抬 / 压到这个高度——拉长了腿的骷髅，脚会被推到地面以下
    if (cs.ground !== undefined) {
      const lift = cs.ground - cLowY(md, cs, P.map((m, i) => m.clone().multiply(Bgi[i]).multiply(G)));
      if (Math.abs(lift) > 1e-4) {
        G.premultiply(new T.Matrix4().makeTranslation(0, lift, 0));
        Bg = md.B.map((m) => G.clone().multiply(m).multiply(Gi));
        Bgi = Bg.map((m) => m.clone().invert());
        P = cPose(md, cs, Bg, Bgi, piv0);
      }
    }
    const pos = (bn) => {
      if (md.bi[bn] === undefined) throw new Error('模型 ' + cs.model + ' 没有骨骼 ' + bn);
      _cv.setFromMatrixPosition(P[md.bi[bn]]);
      return [_cv.x, _cv.y, _cv.z];
    };
    // 关节枢轴：有对应骨骼的挪过去，其余跟着父关节平移（cs.shift 再额外挪一点：武器握点对准拳心）
    const dl = new Float32Array(nJ * 3);
    for (let i = 0; i < nJ; i++) {
      const j = Jn[i], src = cs.pivot[j.name];
      j.px0 = j.px; j.py0 = j.py; j.pz0 = j.pz;
      const np = typeof src === 'function' ? src(pos, piv0) : src ? pos(src) : null;
      if (np) {
        dl[i * 3] = np[0] - j.px; dl[i * 3 + 1] = np[1] - j.py; dl[i * 3 + 2] = np[2] - j.pz;
      } else if (j.parent >= 0) {
        for (let k = 0; k < 3; k++) dl[i * 3 + k] = dl[j.parent * 3 + k];
      }
      const sh = cs.shift && cs.shift[j.name];
      if (sh) for (let k = 0; k < 3; k++) dl[i * 3 + k] += sh[k];
    }
    for (let i = 0; i < nJ; i++) {
      const j = Jn[i];
      j.px += dl[i * 3]; j.py += dl[i * 3 + 1]; j.pz += dl[i * 3 + 2];
    }
    for (let i = 0; i < nJ; i++) {
      const j = Jn[i], pj = j.parent >= 0 ? Jn[j.parent] : null;
      j.lx = j.px - (pj ? pj.px : 0); j.ly = j.py - (pj ? pj.py : 0); j.lz = j.pz - (pj ? pj.pz : 0);
    }
    // C 骨骼 → 程序化关节：没写的跟最近的父骨骼走
    const jOf = new Int16Array(md.nb);
    for (const i of md.order) {
      const t = cs.map(md.names[i]);
      jOf[i] = t && rig.JI[t] !== undefined ? rig.JI[t] : md.parent[i] >= 0 ? jOf[md.parent[i]] : 0;
    }
    // 蒙皮矩阵：原始顶点 → 静止姿态（程序化骨架的模型空间）
    const K = P.map((m, i) => m.clone().multiply(Bgi[i]).multiply(G));
    const split = cs.split ? md.names.map((nm) => cs.split(nm, pos)) : null;
    const body = cBuf(), glow = cBuf();
    const v = new T.Vector3(), acc = new T.Vector3(), tmp = new T.Vector3(), col = [0, 0, 0];
    for (const pr of md.prims) {
      if (cs.hide && cs.hide(pr.name, pr.mat)) continue;
      const gk = cs.glow ? cs.glow(pr.mat, pr.name) : 0, out = gk ? glow : body;
      const sf = gk ? SURF.glow : cs.surf(pr.mat, pr.name);
      const nv = pr.P.length / 3;
      // 每个顶点：静止姿态的位置 + 并到程序化关节上的权重（最多 4 个）
      const RP = new Float32Array(nv * 3), RJ = new Float32Array(nv * 4), RW = new Float32Array(nv * 4), RC = new Float32Array(nv * 3);
      // cs.vglow(顶点色) → 这个顶点的自发光亮度（0 = 不发光）：三个顶点都发光的三角形进自发光网格（游魂身上的余烬裂纹）
      const VG = !gk && cs.vglow && pr.C ? new Float32Array(nv) : null;
      for (let i = 0; i < nv; i++) {
        v.set(pr.P[i * 3], pr.P[i * 3 + 1], pr.P[i * 3 + 2]);
        acc.set(0, 0, 0);
        const js = [], ws = [];
        for (let k = 0; k < 4; k++) {
          const w = pr.W[i * 4 + k];
          if (w <= 0) continue;
          const b = pr.J[i * 4 + k];
          acc.addScaledVector(tmp.copy(v).applyMatrix4(K[b]), w);
          let jj = jOf[b];
          const spl = split && split[b];
          if (spl) {
            // 一根骨骼拆成两个关节（只有前臂没有手骨的骷髅：前臂末端那一截给手腕关节）
            tmp.copy(v).applyMatrix4(K[b]);
            const t = ((tmp.x - spl.a[0]) * spl.d[0] + (tmp.y - spl.a[1]) * spl.d[1] + (tmp.z - spl.a[2]) * spl.d[2]) / spl.len;
            if (t > spl.from) jj = rig.JI[spl.j];
          }
          const at = js.indexOf(jj);
          if (at >= 0) ws[at] += w;
          else { js.push(jj); ws.push(w); }
        }
        RP[i * 3] = acc.x; RP[i * 3 + 1] = acc.y; RP[i * 3 + 2] = acc.z;
        // 多于 4 个关节时只留最重的 4 个
        while (js.length > 4) {
          let lo = 0;
          for (let k = 1; k < ws.length; k++) if (ws[k] < ws[lo]) lo = k;
          js.splice(lo, 1); ws.splice(lo, 1);
        }
        const sw = ws.reduce((a, b) => a + b, 0) || 1;
        for (let k = 0; k < 4; k++) { RJ[i * 4 + k] = k < js.length ? js[k] : 0; RW[i * 4 + k] = k < js.length ? ws[k] / sw : 0; }
        if (VG) VG[i] = cs.vglow([pr.C[i * 4], pr.C[i * 4 + 1], pr.C[i * 4 + 2]]);
        if (gk) RC[i * 3] = RC[i * 3 + 1] = RC[i * 3 + 2] = gk;
        else {
          const c = cs.color(pr.mat, pr.name, pr.base, pr.C ? [pr.C[i * 4], pr.C[i * 4 + 1], pr.C[i * 4 + 2]] : null, RP[i * 3 + 1], col, RP[i * 3], RP[i * 3 + 2]);
          if (cs.toon !== false) toonCast(c);
          RC[i * 3] = c[0]; RC[i * 3 + 1] = c[1]; RC[i * 3 + 2] = c[2];
        }
      }
      // 按三角形展开。卡通（TOON.smoothChars）：同一块网格里位置重合的顶点焊在一起，面法线按面积加权平均成平滑法线；
      // 关掉时是旧的平涂（每个面自己的法线）
      const I = pr.I, cull = cs.cull;
      let SN = null, wid = null;
      if (TOON.smoothChars && cs.smooth !== false) {
        wid = new Int32Array(nv);
        const wm = new Map();
        let nw = 0;
        for (let i = 0; i < nv; i++) {
          const kk = Math.round(RP[i * 3] * 2000) + ',' + Math.round(RP[i * 3 + 1] * 2000) + ',' + Math.round(RP[i * 3 + 2] * 2000);
          let w = wm.get(kk);
          if (w === undefined) wm.set(kk, (w = nw++));
          wid[i] = w;
        }
        SN = new Float32Array(nw * 3);
        for (let t = 0; t < I.length; t += 3) {
          const a = I[t], b = I[t + 1], c = I[t + 2];
          _cv.set(RP[b * 3] - RP[a * 3], RP[b * 3 + 1] - RP[a * 3 + 1], RP[b * 3 + 2] - RP[a * 3 + 2]);
          _cv2.set(RP[c * 3] - RP[a * 3], RP[c * 3 + 1] - RP[a * 3 + 1], RP[c * 3 + 2] - RP[a * 3 + 2]);
          _cv.cross(_cv2);
          for (const k of [a, b, c]) {
            const w = wid[k] * 3;
            SN[w] += _cv.x; SN[w + 1] += _cv.y; SN[w + 2] += _cv.z;
          }
        }
        for (let w = 0; w < SN.length; w += 3) {
          const l = Math.hypot(SN[w], SN[w + 1], SN[w + 2]) || 1;
          SN[w] /= l; SN[w + 1] /= l; SN[w + 2] /= l;
        }
      }
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t], b = I[t + 1], c = I[t + 2];
        // 按三角形剔掉不要的部分（主角的胡子）：给的是静止姿态里的面心
        if (cull && cull(pr.mat, (RP[a * 3] + RP[b * 3] + RP[c * 3]) / 3, (RP[a * 3 + 1] + RP[b * 3 + 1] + RP[c * 3 + 1]) / 3, (RP[a * 3 + 2] + RP[b * 3 + 2] + RP[c * 3 + 2]) / 3, pos)) continue;
        _cv.set(RP[b * 3] - RP[a * 3], RP[b * 3 + 1] - RP[a * 3 + 1], RP[b * 3 + 2] - RP[a * 3 + 2]);
        _cv2.set(RP[c * 3] - RP[a * 3], RP[c * 3 + 1] - RP[a * 3 + 1], RP[c * 3 + 2] - RP[a * 3 + 2]);
        _cv.cross(_cv2).normalize();
        const tg = VG && VG[a] > 0 && VG[b] > 0 && VG[c] > 0, o = tg ? glow : out, so = tg ? SURF.glow : sf;
        for (const k of [a, b, c]) {
          o.P.push(RP[k * 3], RP[k * 3 + 1], RP[k * 3 + 2]);
          if (SN) o.N.push(SN[wid[k] * 3], SN[wid[k] * 3 + 1], SN[wid[k] * 3 + 2]);
          else o.N.push(_cv.x, _cv.y, _cv.z);
          if (tg) o.C.push(VG[k], VG[k], VG[k]);
          else o.C.push(RC[k * 3], RC[k * 3 + 1], RC[k * 3 + 2]);
          o.J.push(RJ[k * 4], RJ[k * 4 + 1], RJ[k * 4 + 2], RJ[k * 4 + 3]);
          o.W.push(RW[k * 4], RW[k * 4 + 1], RW[k * 4 + 2], RW[k * 4 + 3]);
          o.S.push(so[0], so[1]);
        }
      }
    }
    // 配置里额外加的程序化零件（眼窝里的火、余烬囊…）：在新枢轴上建一副同名关节的小骨架来烘焙
    if (cs.extra) {
      const xb = rigBuilder(rig.key + '+', rig.NB);
      for (const j of Jn) xb.j(j.name, j.parent >= 0 ? Jn[j.parent].name : null, j.px, j.py, j.pz);
      cs.extra(xb, pos);
      const xr = xb.build({ height: rig.height, reach: rig.reach }); // 卡通：主角的额外零件（围巾、护肩、后摆）也过 toonCast，和模型本身同一套饱和度
      const z = new Float32Array(nJ * 3);
      cRigid(xr.geoBody, z, body);
      cRigid(xr.geoGlow, z, glow);
    }
    cRigid(rig.geoBody, dl, body);
    cRigid(rig.geoGlow, dl, glow);
    rig.geoBody = cGeo(body, rig);
    rig.geoGlow = cGeo(glow, rig);
    const aux = cBuf();
    cRigid(rig.geoAux, dl, aux);
    rig.geoAux = cGeo(aux, rig);
    for (const vn in rig.geoVar) {
      const gv = rig.geoVar[vn];
      for (const k of ['body', 'glow', 'aux']) {
        const o = cBuf();
        cRigid(gv[k], dl, o);
        gv[k] = cGeo(o, rig);
      }
    }
    const cnt = (g) => (g ? g.attributes.position.count / 3 : 0);
    rig.tris = cnt(rig.geoBody) + cnt(rig.geoGlow) + cnt(rig.geoAux);
    rig.skin4 = true;
    rig.cModel = cs.model;
    rig.cPose = { G, Gi, P, pos, md };
    if (cs.ankle !== undefined) rig.ankle = typeof cs.ankle === 'function' ? cs.ankle(rig) : cs.ankle;
    if (cs.stride) rig.stride = cs.stride;
    if (cs.gait) rig.gait = cs.gait;
    if (cs.emis) rig.emis = cs.emis; // [颜色, 强度]：躯体一层很淡的自发光（焦骨里透出的余烬）
    for (const k in cs.sock || {}) {
      const q = cs.sock[k];
      sock(rig, k, q[0], q[1], q[2], q[3]);
    }
  }

  // 模型自带的动作 → 程序化关节通道的关键帧（defClip 的 keys）。drive：程序化关节 → 带动它的模型骨骼（默认用 cs.pivot 里的骨骼名）
  // opts：{ from, to（截取的秒数）, fps（采样率，默认 20）, joints（只采这些关节）, trans（这些关节也采位移，默认只有 root）}
  const _cA = [], _cl = new T.Matrix4(), _cpos = new T.Vector3(), _csc = new T.Vector3(1, 1, 1);
  function cClipKeys(rig, cs, name, opts) {
    const md = cs.md, clip = md.clips[name], cp = rig.cPose;
    if (!clip || !cp) throw new Error('没有动作 ' + name);
    const o = opts || {};
    const t0 = o.from || 0, t1 = Math.min(clip.dur, o.to === undefined ? clip.dur : o.to), fps = o.fps || 20;
    const nF = Math.max(2, Math.round((t1 - t0) * fps) + 1);
    const drive = Object.assign({}, o.drive || {});
    for (const jn in cs.pivot) if (drive[jn] === undefined && typeof cs.pivot[jn] === 'string') drive[jn] = cs.pivot[jn];
    for (const jn in cs.drive || {}) if (drive[jn] === undefined) drive[jn] = cs.drive[jn];
    const Jn = rig.joints, nJ = Jn.length;
    const use = Jn.map((j) => drive[j.name] !== undefined && md.bi[drive[j.name]] !== undefined && (!o.joints || o.joints.indexOf(j.name) >= 0));
    const trans = o.trans || ['root'];
    const Pinv = cp.P.F.map((m) => m.clone().invert());
    const keys = Object.create(null);
    const M = Jn.map(() => new T.Matrix4());
    const loc = new Array(md.nb), W = new Array(md.nb);
    const qa = new T.Quaternion(), qb = new T.Quaternion(), e = new T.Euler();
    for (let f = 0; f < nF; f++) {
      const t = t0 + ((t1 - t0) * f) / (nF - 1), k = f / (nF - 1);
      // 采样每根骨骼的局部 TRS（逐帧线性插值，旋转 slerp）
      const u = (t / clip.dur) * (clip.n - 1), i0 = Math.min(clip.n - 2, Math.floor(u)), fr = u - i0;
      for (let b = 0; b < md.nb; b++) loc[b] = { t: md.loc[b].t, q: md.loc[b].q };
      for (const c of clip.ch) {
        const v = c.v;
        if (c.path === 'rotation') {
          qa.fromArray(v, i0 * 4); qb.fromArray(v, (i0 + 1) * 4);
          qa.slerp(qb, fr);
          loc[c.b] = { t: loc[c.b].t, q: [qa.x, qa.y, qa.z, qa.w] };
        } else if (c.path === 'translation') {
          const a = i0 * 3, b2 = a + 3;
          loc[c.b] = { t: [v[a] + (v[b2] - v[a]) * fr, v[a + 1] + (v[b2 + 1] - v[a + 1]) * fr, v[a + 2] + (v[b2 + 2] - v[a + 2]) * fr], q: loc[c.b].q };
        }
      }
      for (const b of md.order) {
        const L = _cl.compose(_cpos.fromArray(loc[b].t), qa.fromArray(loc[b].q), _csc);
        W[b] = md.parent[b] < 0 ? L.clone() : W[md.parent[b]].clone().multiply(L);
      }
      // 程序化关节的模型矩阵：带动它的骨骼的形变 × 平移(枢轴)；没有骨骼带动的关节保持静止姿态
      for (let i = 0; i < nJ; i++) {
        const j = Jn[i];
        if (use[i]) {
          const b = md.bi[drive[j.name]];
          M[i].copy(cp.G).multiply(W[b]).multiply(cp.Gi).multiply(Pinv[b]).multiply(_cl.makeTranslation(j.px, j.py, j.pz));
        } else if (j.parent >= 0) M[i].copy(M[j.parent]).multiply(_cl.makeTranslation(j.lx, j.ly, j.lz));
        else M[i].makeTranslation(j.px, j.py, j.pz);
        if (!use[i]) continue;
        const Lm = j.parent >= 0 ? _cl.copy(M[j.parent]).invert().multiply(M[i]) : _cl.copy(M[i]);
        e.setFromRotationMatrix(Lm, 'XYZ');
        _cpos.setFromMatrixPosition(Lm);
        const vals = { rx: e.x, ry: e.y, rz: e.z };
        if (trans.indexOf(j.name) >= 0) {
          vals.ox = _cpos.x - j.lx; vals.oy = _cpos.y - j.ly; vals.oz = _cpos.z - j.lz;
        }
        for (const ch in vals) {
          const key = j.name + '.' + ch, arr = keys[key] || (keys[key] = []);
          let val = vals[ch];
          if (ch[0] === 'r' && arr.length) {
            const prev = arr[arr.length - 1];
            val -= Math.round((val - prev) / TAU) * TAU; // 角度连续
          }
          arr.push(k, val);
        }
      }
    }
    return { keys, dur: (t1 - t0) / (o.speed || 1) };
  }

  // ----- 着色器注入：刚性蒙皮 + 逐顶点粗糙/金属度 + 轮廓光 + 消散 -----
  // SKIN4（C 模型）：每个顶点 4 根骨骼的线性混合蒙皮；否则一个顶点只跟一根骨骼（程序化零件）
  const RIG_SKIN_PARS = '#ifdef SKIN4\nattribute vec4 aSkin;\nattribute vec4 aSkinW;\n#else\nattribute float aBone;\n#endif\nuniform mat4 uBones[ NB ];\n';
  const RIG_BONE = '#ifdef SKIN4\nmat4 boneM = uBones[ int( aSkin.x + 0.5 ) ] * aSkinW.x + uBones[ int( aSkin.y + 0.5 ) ] * aSkinW.y + uBones[ int( aSkin.z + 0.5 ) ] * aSkinW.z + uBones[ int( aSkin.w + 0.5 ) ] * aSkinW.w;\n#else\nmat4 boneM = uBones[ int( aBone + 0.5 ) ];\n#endif\n';
  const RIG_VERT_PARS = RIG_SKIN_PARS + 'attribute vec2 aSurf;\nvarying vec2 vSurf;\nvarying vec3 vBP;\n';
  const RIG_FRAG_PARS = 'varying vec2 vSurf;\nvarying vec3 vBP;\nuniform vec3 uRim;\nuniform vec4 uDis;\n';
  const RIG_FRAG = [
    '#include <emissivemap_fragment>',
    'roughnessFactor = vSurf.x;',
    'metalnessFactor = vSurf.y;',
    // 轮廓光：俯视镜头下把身形从地面上勾出来。uRim 是每个实体自己的（精英的金边、受击 / 选中时的变色），
    'float rigRim = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );',
    'totalEmissiveRadiance += uRim * rigRim * rigRim * rigRim;',
    // 卡通轮廓光（TOON.rimK）：补光（第二盏方向光，在镜头对面）那一侧的边缘一条软阶梯的冷色光，另一侧只留很淡的一点——不是一圈描边
    '#if NUM_DIR_LIGHTS > 1',
    '{',
    '  float tRb = smoothstep( ' + fNum(TOON.rimLo) + ', ' + fNum(TOON.rimHi) + ', rigRim );',
    '  float tRm = smoothstep( -0.25, 0.45, dot( normal, directionalLights[ 1 ].direction ) );',
    '  totalEmissiveRadiance += directionalLights[ 1 ].color * ( diffuseColor.rgb * 0.6 + 0.4 ) * tRb * ( 0.15 + 0.85 * tRm ) * ' + fNum(TOON.rimK) + ';',
    '}',
    '#endif',
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
      .replace('#include <beginnormal_vertex>', RIG_BONE + 'vec3 objectNormal = mat3( boneM ) * normal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = ( boneM * vec4( position, 1.0 ) ).xyz;\nvSurf = aSurf;\nvBP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + RIG_FRAG_PARS)
      .replace('#include <emissivemap_fragment>', RIG_FRAG);
  }
  function injectDepth(sh, ent) {
    sh.uniforms.uBones = ent.uBones;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + RIG_SKIN_PARS)
      .replace('#include <begin_vertex>', RIG_BONE + 'vec3 transformed = ( boneM * vec4( position, 1.0 ) ).xyz;');
  }

  // 金属反光用的环境贴图：一张手画的天空渐变，经 PMREM 预滤波
  let rigEnv = null;
  function rigEnvMap() {
    if (rigEnv) return rigEnv;
    const c = makeCanvas(128, 64), g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 64);
    // 卡通：下半截不再是近黑（俯视镜头下金属面大多反射的是下半截，旧的会让金属一片黑），换成暖的地面反光
    gr.addColorStop(0, '#fff6e6');
    gr.addColorStop(0.3, '#d6cde0');
    gr.addColorStop(0.5, '#9a8ca6');
    gr.addColorStop(0.56, '#6e5a64');
    gr.addColorStop(1, '#4a3a3e');
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

  // 卡通：角色用平滑法线（程序化零件按各自烘焙的法线，C 模型见 TOON.smoothChars），光照阶梯给出干净的大块明暗；
  // 旧的「一律平涂（按面着色）」在阶梯光照下会碎成满身小色块
  const RIG_FLAT = false;
  // ----- 建立实体 -----
  // tintHex：躯体整体染色；elemHex：自发光部件的元素色
  // 变体零件里的自发光件不用本体的元素色、改用自己固定颜色的那几组：变体名 → [颜色, 亮度]。
  // 冰弓的冰裂纹和冰核要一直是冰蓝（玩家本体的元素色是琥珀橙）；颜色压得偏深一点，泛光之后仍是蓝而不是白
  const VAR_GLOW = { emberbow: [0x3fa8ff, 1.35] };
  function newEnt(kind, rig, tintHex, elemHex, glowI) {
    const group = new T.Group();
    const body = new T.Group();
    group.add(body);
    scene.add(group);
    const n = rig.rest.length; // 实关节 + 虚关节的姿态通道
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
    if (rig.skin4) bm.defines.SKIN4 = 1;
    bm.flatShading = RIG_FLAT;
    bm.onBeforeCompile = function (sh) { injectLit(sh, ent); };
    bm.userData.e0 = rig.emis ? lin(rig.emis[0]) : new T.Color(0);
    bm.userData.ei0 = rig.emis ? rig.emis[1] : 1;
    if (rig.emis) {
      bm.emissive.copy(bm.userData.e0);
      bm.emissiveIntensity = bm.userData.ei0;
    }
    bm.userData.fi = 0.3;
    const ec = lin(elemHex);
    const gm = new T.MeshStandardMaterial({ color: ec.clone().multiplyScalar(0.25), vertexColors: true, emissive: ec, emissiveIntensity: glowI, roughness: 0.4, metalness: 0, toneMapped: false });
    gm.defines.NB = rig.NB;
    if (rig.skin4) gm.defines.SKIN4 = 1;
    gm.flatShading = RIG_FLAT;
    gm.onBeforeCompile = function (sh) { injectLit(sh, ent); };
    gm.userData.e0 = ec.clone();
    gm.userData.ei0 = glowI;
    gm.userData.fi = 1.25;
    const dm = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
    dm.defines = { NB: rig.NB };
    if (rig.skin4) dm.defines.SKIN4 = 1;
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
      if (rig.skin4) am.defines.SKIN4 = 1;
      am.flatShading = RIG_FLAT;
      am.onBeforeCompile = function (sh) { injectLit(sh, ent); };
      am.userData.e0 = new T.Color(1, 1, 1);
      am.userData.ei0 = 1;
      am.userData.fi = 1.25;
      ent.mats.push(am);
      ent.auxMat = am;
      body.add(new T.Mesh(rig.geoAux, am));
    }
    // 变体零件：和本体共用材质与骨骼，平时隐藏，由 W.showVariant / applyGear 决定显示哪一组
    if (rig.geoVar) {
      for (const vn in rig.geoVar) {
        const gv = rig.geoVar[vn], list = [];
        if (gv.body) {
          const m = new T.Mesh(gv.body, bm);
          m.castShadow = true;
          m.customDepthMaterial = dm;
          list.push(m);
        }
        if (gv.glow) {
          let vm = gm;
          const vg = VAR_GLOW[vn];
          if (vg) {
            // 和本体的自发光材质一样，只是颜色固定；进 ent.mats，受击闪白 / 冻结 / 销毁都照常
            const vc = lin(vg[0]);
            vm = new T.MeshStandardMaterial({ color: vc.clone().multiplyScalar(0.25), vertexColors: true, emissive: vc, emissiveIntensity: vg[1], roughness: 0.4, metalness: 0, toneMapped: false });
            vm.defines.NB = rig.NB;
            if (rig.skin4) vm.defines.SKIN4 = 1;
            vm.flatShading = RIG_FLAT;
            vm.onBeforeCompile = function (sh) { injectLit(sh, ent); };
            vm.userData.e0 = vc.clone();
            vm.userData.ei0 = vg[1];
            vm.userData.fi = 1.25;
            ent.mats.push(vm);
          }
          list.push(new T.Mesh(gv.glow, vm));
        }
        if (gv.aux && ent.auxMat) list.push(new T.Mesh(gv.aux, ent.auxMat));
        for (const m of list) {
          m.visible = false;
          body.add(m);
        }
        (ent.vMesh || (ent.vMesh = Object.create(null)))[vn] = list;
      }
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
    for (let i = 0, n = ent.rig.joints.length; i < n; i++) solveJoint(ent, i);
  }
  // 只重算一个关节（父关节必须已经是最新的）：叶子上的链条（围巾、马尾）单独改了角度时用
  function solveJoint(ent, i) {
    const o = ent.out, M = ent.mdl, Bn = ent.bones;
    {
      const j = ent.rig.joints[i], c = i * CH, m = i * 12;
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
  const BACK_ON = 2.05, BACK_OFF = 1.75; // 倒退走的进 / 出阈值（弧度）
  // sdt：受时间缩放影响的动画时间步；dist：这一帧实际走过的距离
  function advanceEnt(ent, sdt, moving, dist, ldx, ldz) {
    const rig = ent.rig, p = ent.pose;
    ent.clock += sdt;
    const t = ent.clock;
    ent.mv += ((moving ? 1 : 0) - ent.mv) * Math.min(1, sdt * 10);
    if (moving && sdt > 0) {
      ent.walk += dist * rig.stride * (ent.back ? -1 : 1); // 倒退时步态反着走
      ent.spd += (dist / sdt - ent.spd) * Math.min(1, sdt * 10);
      if (dist > 1e-4) {
        // 移动方向相对朝向的夹角（玩家边打边退时腿朝移动方向迈）。跟得稍慢一点，起步时胯不会猛地一拧
        let a = Math.atan2(ldx, ldz) - ent.group.rotation.y - ent.mdir;
        a -= Math.round(a / TAU) * TAU;
        ent.mdir += a * Math.min(1, sdt * 9);
        ent.mdir -= Math.round(ent.mdir / TAU) * TAU; // 折回 ±π，长时间绕圈也不会越积越大
      }
      // 「倒退走」带滞回：夹角过 BACK_ON 才切到倒退，回到 BACK_OFF 以下才切回来。
      // 以前单一阈值 1.9：夹角在阈值附近晃时，步态方向和胯的朝向会一帧一帧来回翻，看起来像抽搐
      const am = Math.abs(ent.mdir);
      if (!ent.back && am > BACK_ON) ent.back = true;
      else if (ent.back && am < BACK_OFF) ent.back = false;
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
      // 卡通版：一仰更快到位（10% 的时间）、幅度大一点，压扁 / 回弹更明显
      const env = u < 0.1 ? u / 0.1 : (1 - (u - 0.1) / 0.9) * (1 - (u - 0.1) / 0.9);
      const sq = -Math.sin(u * TAU) * (1 - u) * 0.27 * s; // 负 = 压扁，正 = 拉长
      const a = 0.42 * s * env;
      o[0] += ent.hitZ * a;
      o[2] -= ent.hitX * a;
      o[3] += ent.hitX * 0.18 * s * env;
      o[5] += ent.hitZ * 0.18 * s * env;
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
    if (rig.late) rig.late(ent, sdt);
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
    // 玩家拿双手武器 / 长弓时，同名动作换成按这种武器重排的版本（名字不变）
    const c = (ent.gearClips && ent.gearClips[name]) || ent.rig.clips[name];
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

  // 受击闪色。k：强度（1 普通，2 重击，3 终结 / 处决）——越重越亮、亮得越久。
  // 卡通版：不是整个闪成白模，而是一层暖奶油色的亮光叠在固有色上（FLASH_RGB，线性），分两档跳变：先亮、再半亮、然后收掉
  const FLASH_RGB = [1, 0.74, 0.5];
  W.flash = function (ent, k) {
    if (ent.removed) return;
    const s = Math.min(3, k === undefined ? 1 : k);
    if (ent.flashT <= 0) flashing.push(ent);
    ent.flashD = 0.08 + 0.025 * s;
    ent.flashT = ent.flashD;
    ent.flashK = 0.62 + 0.2 * s;
    const ms = ent.mats;
    for (let i = 0; i < ms.length; i++) {
      ms[i].emissive.setRGB(FLASH_RGB[0], FLASH_RGB[1], FLASH_RGB[2]);
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
    if (ent.iced) return applyIce(ent); // 冻着的：闪白过后回到冰色
    const ms = ent.mats;
    for (let i = 0; i < ms.length; i++) {
      ms[i].emissive.copy(ms[i].userData.e0);
      ms[i].emissiveIntensity = ms[i].userData.ei0;
    }
  }
  function applyIce(ent) {
    const ms = ent.mats;
    for (let i = 0; i < ms.length; i++) {
      ms[i].emissive.setRGB(0.42, 0.78, 1);
      ms[i].emissiveIntensity = ms[i].userData.fi * 0.5;
    }
  }
  // 冻结：整个模型罩一层冰色（受击闪白照常，闪完回到冰色）；on = false 复原
  W.frost = function (ent, on) {
    if (!ent || ent.removed) return;
    ent.iced = !!on;
    if (ent.flashT > 0) return; // 正在闪白：闪完由 unflash 收尾
    if (on) applyIce(ent);
    else unflash(ent);
  };
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
    chaos: { edge: 0xf03cb4, linger: 0.1, fade: 0.35, decal: 1, up: -0.6 }, // 混沌：往里塌，压暗，品红的消散边
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
      if (ent.tails) dbl.tails = { s: ent.tails.s.slice(), init: true }; // 围巾 / 马尾接着原来的摆动，不跳回静止
      applyGear(dbl, ent.gearType, ent.gearRar, ent.gearVar);
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
      } else if (o.type === 'chaos') {
        // 往里塌：压暗，只透出一点品红
        m.e0.setRGB(0.42, 0.04, 0.3);
        m.ei0 = 0.4;
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
      } else if (d.type === 'chaos') {
        ent.bodyMat.color.lerp(_c.setRGB(0.05, 0.02, 0.06), Math.min(1, dt * 4));
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
  // 玩家：余烬行者 · 夜行束发 —— 灰烬银短发往后梳、脑后一束小马尾，青绿围巾两条长尾，深色皮衣 + 飞刀绑带，
  // 轻装短皮裙、软皮高靴；右手持武器，左手托着一点余烬。围巾尾巴和马尾由 tailSprings 的弹簧驱动
  // =====================================================================
  const HALF_PI = Math.PI / 2;
  // 披风 / 罩袍用的弧形布片：绕 y 轴车削出背后的一段弧面
  const gDrape = (key, pts, arc, seg = 7) =>
    geo('D' + key, () => new T.LatheGeometry(pts.map((p) => new T.Vector2(p[0], p[1])), seg, Math.PI - arc / 2, arc));

  // 长弓握把的 z 与上弓梢（弓弦上端的挂点）的绑定坐标；下弓梢关于握把对称
  const BOW_GZ = 0.04, BOW_TIP = [0.345, 1.01, 0.73];
  // 武器种类：底材的 type → 模型序号（也是 ent.gearType）。前三种的序号与旧存档的 baseIdx 一致
  // 远程武器（8 转膛机炮 / 9 焚炉喷枪 / 10 烬铸左轮）挂在同一个关节 wF 上，各自一组变体零件；四种弓共用长弓的序号 5（同一套握法与动作），
  // 弓身也是变体零件（弓弦仍挂在 bsU / bsL 上，四张弓的弓梢位置相同）
  const GEAR_KEYS = ['blade', 'staff', 'wand', 'daggers', 'hammer', 'bow', 'katana', 'banner', 'gatling', 'flamer', 'revolver'];
  const G_DAG = 3, G_HAM = 4, G_BOW = 5, G_KAT = 6, G_BAN = 7, G_GAT = 8, G_FLM = 9, G_REV = 10;
  const TWO_HAND = [false, false, false, false, true, false, true, false, true, true, false];
  const GEAR_JOINT = ['wB', 'wS', 'wW', 'wD', 'wH', 'wBo', 'wK', 'wBn', 'wF', 'wF', 'wF'];
  // 卡通：手持武器整体缩小一点（近镜头下原尺寸的武器比人还抢眼）。按握点缩放武器关节（playerPost），
  // 挂点（刀光、光晕、枪口）都经关节矩阵换算，跟着一起缩；双手武器的左手握点、弓弦在 playerIK 里按这个比例换算
  const GEAR_K = 0.88;
  // 武器底材的 type → 序号；弓类都算长弓（旧的 'bow' 即鹰眼长弓）
  const BOW_TYPES = ['huntbow', 'eagle', 'runebow', 'emberbow'];
  const GUN_TYPES = ['gatling', 'flamer', 'revolver'];
  const TYPE_GEAR = { huntbow: G_BOW, eagle: G_BOW, runebow: G_BOW, emberbow: G_BOW, bow: G_BOW };
  // 序号之外还要区分的具体型号（变体零件的名字）：弓 → 四种弓之一，枪 → 自己的 type
  const gearVariant = (type) => (type === 'bow' ? 'eagle' : BOW_TYPES.indexOf(type) >= 0 || GUN_TYPES.indexOf(type) >= 0 ? type : null);
  // 魂幡：挑杆的高度（握点往上，沿杆）、幡布挂点离杆的横向距离、两段幡布的长度
  const BAN_Z = 1.6, BAN_X = 0.25, BAN_L1 = 0.46, BAN_L2 = 0.44, BAN_CL = 0.26;
  const baseType = (baseIdx) => {
    const bs = G.BASES && G.BASES.weapon, b = bs && bs[baseIdx];
    return (b && b.type) || null;
  };
  function gearIndex(baseIdx) {
    const t = baseType(baseIdx);
    if (t && TYPE_GEAR[t] !== undefined) return TYPE_GEAR[t];
    const i = t ? GEAR_KEYS.indexOf(t) : -1;
    return i >= 0 ? i : G.clamp(baseIdx | 0, 0, 7);
  }

  // 皮衣 / 布 / 靴的配色：压暗的冷灰紫皮革，衬出青绿围巾和灰烬银的头发
  const LEA = 0x4e454b, LEA_D = 0x231f25, CLOTH = 0x272a36, BOOT = [0x17151a, 0x37323b], STRAP = 0x5a4a40, POUCH = 0x4e4038, DARK = 0x14151b;
  // 围巾尾巴：每条三节。len = 各节长度，w = 各节上下端宽度（4 个），kx = 结扣的横向位置（偏左，让开脑后的马尾），
  // x = 两条尾巴离结扣的横向距离，y / z = 第一节枢轴，splay = 两条尾巴静止时往两边分开的角度
  // 卡通：围巾是全身最饱和的一块（设计稿 2.3 的青绿 #2ec4b0，暗部 #1a6a78），尾巴加宽，俯视镜头下背后一抹青绿
  const SF = { len: [0.28, 0.27, 0.26], w: [0.1, 0.092, 0.078, 0.056], kx: 0.09, x: 0.045, y: 1.6, z: -0.15, splay: 0.13, c: [0x1a6a78, 0x2ec4b0], ci: 0x155866 };
  const SF_SEG = ['sfL1', 'sfL2', 'sfL3', 'sfR1', 'sfR2', 'sfR3'];
  // 马尾各节的枢轴：束在后脑偏高处（俯视也看得到那一撮），绑定姿态里已经往后下方斜，静止时发梢停在围巾圈上方、离开后颈；最后一个点是发梢
  const HAIR_T = [[0, 1.858, -0.172], [0, 1.795, -0.256], [0, 1.728, -0.296], [0, 1.655, -0.316]];
  const HP_SEG = ['hp1', 'hp2', 'hp3'];
  // 发色：灰烬银——冷调的浅灰，暗部压到石板灰。俯视镜头里头顶占了头部大半：在暖色的灰烬地面上冷亮色最跳；
  // 在霜原的青蓝地面上靠「比地面更亮、且不带青」分开；和深色皮衣、青绿围巾也拉得开。眉毛用更深的炭灰
  const HAIR_C = [0x4b4e5a, 0x8a8e9a, 0xaeb2bd];
  const lerpC = (a, b, t) => {
    const ch = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
    return (ch(16) << 16) | (ch(8) << 8) | ch(0);
  };
  function hairHead(b) {
    const [HD, HM, HL] = HAIR_C, BROW = 0x34353d;
    const SKIN = [0x9c7259, 0xd4aa8c], SKIN_D = 0xb08568;
    const y0 = 0.012;
    // 车削出的蛋形头：颧骨最宽、往下收成尖一点的下巴（埋进围巾）
    b.at('head').surf(SURF.leather);
    b.p(gLathe('hr/skull', [[0.001, 1.59], [0.072, 1.605], [0.114, 1.655], [0.139, 1.72], [0.145, 1.78], [0.124, 1.85], [0.072, 1.9], [0.001, 1.916]], 10), SKIN, 0, y0, 0.012, 0, 0, 0, 0.92, 1, 1.04);
    // 鼻梁一点小凸起；眉：两道细短的炭灰，外端略扬；眼：两点暗余烬，嵌在眉下
    b.p(gSph(0.018, 5, 3), SKIN_D, 0, 1.73 + y0, 0.15, -0.3, 0, 0, 0.6, 1.4, 0.5);
    for (const s of [1, -1]) b.p(gBox(0.044, 0.011, 0.018), BROW, s * 0.045, 1.79 + y0, 0.153, 0, s * 0.4, s * 0.14);
    for (const s of [1, -1]) b.g(gSph(0.0105, 5, 3), 0.55, s * 0.043, 1.762 + y0, 0.152, 0, s * 0.35, s * 0.12, 1.45, 0.55, 0.8);

    // 头发：一顶往后倾的发壳（前额发际线高、后脑压到后颈），上面躺着几绺梳向脑后的扁发片
    const cy = 1.778 + y0, cz = -0.012, C = [0, cy, cz];
    // 正中矢状面上的点：a = 0 正前方，PI/2 头顶，PI 正后方；s 往两侧偏（弧度）
    const hs = (a, s, r) => [Math.sin(s) * r * 0.95, cy + Math.sin(a) * Math.cos(s) * r, cz + Math.cos(a) * Math.cos(s) * r * 1.08];
    b.surf(SURF.leather);
    b.p(gDome(0.166, 10, 5, 1.8), [HD, HL], 0, cy, cz, -0.5, 0, 0, 0.95, 1.0, 1.08);
    // 往后梳的四绺：前端圆钝、在发际线上微微隆起（不是一根根竖起的尖），翻过头顶收进脑后的发结
    for (const s of [0.5, 0.17, -0.17, -0.5]) {
      const k = 1 - Math.abs(s) * 0.5;
      const pts = [hs(0.36, s, 0.166), hs(0.95, s * 0.95, 0.181 * k + 0.168 * (1 - k)), hs(1.75, s * 0.8, 0.178), hs(2.55, s * 0.4, 0.168)];
      b.p(gStrand('hr/l' + s, pts, [0.034, 0.043, 0.04, 0.02], [0.012, 0.017, 0.015, 0.008], C, 2), [HM, HL], 0, 0, 0);
    }
    // 斜刘海：从左侧分缝处压过额头、拨到右边太阳穴，宽而扁，左右不对称
    b.p(gStrand('hr/fr', [hs(1.05, 0.42, 0.178), hs(0.5, 0.2, 0.176), hs(0.3, -0.28, 0.174), hs(0.36, -0.78, 0.166)], [0.032, 0.046, 0.04, 0.016], [0.013, 0.016, 0.013, 0.007], C, 2), [HM, HL], 0, 0, 0);
    // 鬓角垂下的两缕碎发：扁的一片，贴着太阳穴和脸颊往下，末端略向前收；右边短一点
    for (const s of [1, -1]) {
      const l = s > 0 ? 1 : 0.8;
      b.p(gStrand('hr/f' + s, [[s * 0.114, 1.852, 0.056], [s * 0.124, 1.795, 0.07], [s * 0.119, 1.795 - 0.06 * l, 0.08], [s * 0.107, 1.795 - 0.095 * l, 0.092]], [0.019, 0.02, 0.014, 0.006], [0.008, 0.009, 0.007, 0.004], [0, 1.77, 0], 2), [HM, HL], 0, 0, 0);
    }

    // 马尾：每节一段，挂在 hp1..hp3 上；越往发梢越暗一点。发梢分成两撮，一长一短，略微叉开
    const T = HAIR_T, R = [[0.028, 0.045, 0.043], [0.043, 0.04, 0.034]];
    for (let i = 0; i < 2; i++) {
      const a = T[i], c = T[i + 1], m = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2 + 0.005, (a[2] + c[2]) / 2 - 0.012];
      const a0 = i ? [a[0], a[1] + 0.015, a[2] + 0.006] : a;
      b.at(HP_SEG[i]).p(gSweep('hr/t' + i, [a0, m, c], R[i], 5, 2), [lerpC(HL, HD, 0.25 + i * 0.22), lerpC(HL, HD, i * 0.22)], 0, 0, 0);
    }
    {
      const a = T[2], c = T[3];
      b.at('hp3');
      for (const [s, l] of [[1, 1], [-1, 0.8]]) {
        const e = [c[0] + s * 0.022, a[1] + (c[1] - a[1]) * l, c[2] - 0.004 + (1 - l) * 0.01];
        b.p(gSweep('hr/tt' + s, [[a[0] + s * 0.008, a[1] + 0.015, a[2] + 0.004], [s * 0.016, (a[1] + e[1]) / 2, (a[2] + e[2]) / 2 - 0.008], e], [0.026, 0.02, 0.006], 4, 2), [lerpC(HL, HD, 0.7), lerpC(HL, HD, 0.44)], 0, 0, 0);
      }
    }
    // 青色发绳
    const dy = T[1][1] - T[0][1], dz = T[1][2] - T[0][2];
    b.at('hp1').p(gTorus(0.03, 0.011, 3, 7), SF.c[1], T[0][0], T[0][1] - 0.006, T[0][2] - 0.008, Math.atan2(-dy, dz), 0, 0);
  }

  // ----- 远程武器的持握模型（变体零件）-----
  // 火器：握把在右手（握点 z≈0.03），枪身在握把上方，GUN_AX 是枪管轴线比握点高出的距离；枪口沿 +z
  const GUN_AX = 0.15;
  // 枪口 / 喷嘴相对握点的 z（挂点 weapon 用）
  const GUN_MUZ = { gatling: 0.98, flamer: 0.92, revolver: 0.5 };
  // 前握把（左手）的 z：和右手同一高度、在枪身轴线下方
  const GUN_FORE = { gatling: 0.32, flamer: 0.34 };
  // 站立 / 跑动时右手的位置（胸口坐标系：握点、枪口指向、枪身「下方」——握把一侧）；并进 LOCO_2H
  const GUN_LOCO = {
    [G_GAT]: { idle: [-0.06, -0.27, 0.16, 0.55, 0.0, 0.83, 0, -1, 0], run: [-0.1, -0.22, 0.14, 0.5, 0.3, 0.81, 0, -0.94, 0.33] },
    [G_FLM]: { idle: [-0.06, -0.27, 0.16, 0.55, 0.0, 0.83, 0, -1, 0], run: [-0.1, -0.22, 0.14, 0.5, 0.3, 0.81, 0, -0.94, 0.33] },
    [G_REV]: { idle: [-0.3, -0.48, 0.1, 0.05, -0.55, 0.83, 0, -0.83, -0.55], run: [-0.3, -0.42, 0.14, 0.05, -0.25, 0.97, 0, -0.97, -0.25] },
  };
  // 拿着机炮 / 喷枪时上身往右拧的角度（脊柱 + 胸口各一半），让斜端着的枪口朝正前方、左手够得着前握把
  const GUN_TWIST = -0.3;
  function rangedGuns(b, WX, WY, GOLD, STEEL, STEEL_D) {
    const AY = WY + GUN_AX, GUNM = 0x2b2d33, GUNM2 = 0x4a4d57, OIL = 0x1c1a1d, BRASS = 0xc8963c, COPPER = 0xb0643a;
    // --- 转膛机炮：后握把 + 方正的机匣（顶上一排散热槽）+ 左侧弹鼓 + 六根枪管（挂 wGb，开火时绕轴转）+ 机匣前下方的前握把 ---
    b.variant('gatling').at('wF').surf(SURF.leather);
    b.p(gRBox(0.055, 0.15, 0.07, 0.018), OIL, WX, WY - 0.01, 0.035, -0.25);
    b.surf(SURF.metal, true).p(gRBox(0.15, 0.15, 0.36, 0.03), [GUNM, GUNM2], WX, AY + 0.01, 0.12);
    b.p(gRBox(0.11, 0.05, 0.3, 0.015), STEEL_D, WX, AY + 0.1, 0.12);
    b.p(gBox(0.03, 0.06, 0.08), GUNM, WX, WY + 0.05, -0.02); // 扳机护圈
    b.surf(SURF.gold).p(gCyl(0.085, 0.085, 0.03, 10), BRASS, WX, AY, 0.31, HALF_PI);
    // 弹鼓 + 一截弹链
    b.surf(SURF.metal).p(gCyl(0.085, 0.085, 0.09, 10), [STEEL_D, STEEL], WX + 0.12, AY - 0.02, 0.1, 0, 0, HALF_PI);
    b.surf(SURF.gold).p(gTorus(0.085, 0.01, 4, 12), BRASS, WX + 0.165, AY - 0.02, 0.1, 0, HALF_PI, 0);
    b.p(gSweep('pl/gatbelt', [[0.12, -0.08, 0.1], [0.07, -0.07, 0.17], [0.03, -0.02, 0.2]], [0.022, 0.02, 0.02], 4), BRASS, WX, AY, 0);
    // 前握把：竖直的一截，左手握在 z = 0.42、和右手同一高度
    const FG = GUN_FORE.gatling;
    b.surf(SURF.leather).p(gCyl(0.026, 0.03, 0.17, 6), OIL, WX, WY + 0.02, FG).p(gRBox(0.07, 0.04, 0.09, 0.012), GUNM, WX, AY - 0.06, FG);
    b.surf(SURF.metal).p(gCyl(0.06, 0.06, 0.05, 8), GUNM2, WX, AY, FG + 0.03, HALF_PI);
    // 稀有度光：机匣顶上三道散热槽 + 弹鼓中心
    for (const zz of [0.04, 0.12, 0.2]) b.x(gBox(0.09, 0.012, 0.018), 1, WX, AY + 0.127, zz);
    b.x(gOct(0.026), 1, WX + 0.17, AY - 0.02, 0.1);
    // 枪管束（wGb：枢轴在轴线上 z = 0.3）
    b.at('wGb').surf(SURF.metal);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU, cx = Math.cos(a) * 0.046, cy = Math.sin(a) * 0.046;
      b.p(gCyl(0.017, 0.017, 0.64, 6), [STEEL_D, STEEL], WX + cx, AY + cy, 0.64, HALF_PI);
    }
    b.p(gCyl(0.024, 0.024, 0.66, 6), OIL, WX, AY, 0.62, HALF_PI);
    b.surf(SURF.gold).p(gTorus(0.066, 0.014, 4, 12), BRASS, WX, AY, 0.58).p(gTorus(0.066, 0.016, 4, 12), BRASS, WX, AY, 0.93);
    b.surf(SURF.metal).p(gCyl(0.07, 0.07, 0.04, 8), GUNM, WX, AY, 0.76, HALF_PI);
    b.x(gTorus(0.07, 0.006, 3, 12), 1, WX, AY, 0.955);

    // --- 焚炉喷枪：后握把，一根粗输焰管通到前端的喇叭喷嘴，管上骑着一只铜燃料罐（压力表），喷嘴下一点常燃的引火 ---
    b.variant('flamer').at('wF').surf(SURF.leather);
    b.p(gRBox(0.055, 0.15, 0.07, 0.018), OIL, WX, WY - 0.01, 0.035, -0.25);
    b.surf(SURF.metal).p(gRBox(0.11, 0.11, 0.26, 0.025), [GUNM, GUNM2], WX, AY - 0.01, 0.1);
    b.p(gCyl(0.036, 0.04, 0.6, 8), [STEEL_D, STEEL], WX, AY, 0.52, HALF_PI);
    for (const zz of [0.36, 0.52, 0.68]) b.surf(SURF.gold).p(gTorus(0.043, 0.01, 4, 10), BRASS, WX, AY, zz);
    // 喷嘴：外翻的喇叭口 + 里面一圈暗色的焰口
    b.surf(SURF.metal).p(gCyl(0.075, 0.042, 0.13, 10), STEEL_D, WX, AY, 0.86, HALF_PI);
    b.surf(SURF.gold).p(gTorus(0.074, 0.012, 4, 12), COPPER, WX, AY, 0.925);
    b.p(gCyl(0.008, 0.008, 0.14, 4), COPPER, WX, AY - 0.06, 0.84, HALF_PI);
    // 燃料罐：横骑在机身上方，两道铜箍、前端一只压力表
    b.surf(SURF.gold).p(gCyl(0.07, 0.07, 0.34, 10), [0x7a3e20, COPPER], WX, AY + 0.11, 0.2, HALF_PI);
    b.p(gDome(0.07, 10, 4), COPPER, WX, AY + 0.11, 0.37, HALF_PI).p(gDome(0.07, 10, 4), 0x7a3e20, WX, AY + 0.11, 0.03, -HALF_PI);
    b.surf(SURF.metal).p(gTorus(0.072, 0.012, 4, 12), STEEL_D, WX, AY + 0.11, 0.1).p(gTorus(0.072, 0.012, 4, 12), STEEL_D, WX, AY + 0.11, 0.3);
    b.p(gCyl(0.03, 0.03, 0.02, 8), STEEL, WX - 0.05, AY + 0.17, 0.31, 0, 0, 0.6);
    b.p(gSweep('pl/flmhose', [[0, 0.06, 0.37], [0, 0.03, 0.44], [0, 0.0, 0.48]], [0.014, 0.014, 0.014], 4), OIL, WX, AY, 0);
    // 前握把
    b.surf(SURF.leather).p(gCyl(0.026, 0.03, 0.16, 6), OIL, WX, WY + 0.03, GUN_FORE.flamer).p(gRBox(0.06, 0.04, 0.08, 0.012), GUNM, WX, AY - 0.055, GUN_FORE.flamer);
    // 发光：压力表盘（稀有度色）、引火（元素色，常燃）、管上一道烧红的焰纹
    b.x(gCyl(0.022, 0.022, 0.024, 8), 1, WX - 0.054, AY + 0.175, 0.31, 0, 0, 0.6);
    b.x(gBox(0.012, 0.012, 0.3), 1, WX, AY + 0.038, 0.55);
    b.g(gOct(0.024), 1, WX, AY - 0.06, 0.93, 0, 0, 0, 1, 1, 1.6);

    // --- 烬铸左轮：发黑的长管左轮，八棱枪管、粗转轮，枪身上烧着余烬的裂纹，握把是焦黑的骨木；转轮挂在 wGb 上（不转，只是位置） ---
    const BLK = 0x221c1c, BLK2 = 0x3a2e2a, EMBG = 0xd09048;
    b.variant('revolver').at('wF').surf(SURF.bone);
    b.p(gRBox(0.05, 0.16, 0.075, 0.02), [0x2a1a14, 0x5a3426], WX, WY - 0.015, 0.0, -0.32);
    b.surf(SURF.gold).p(gBox(0.054, 0.02, 0.08), EMBG, WX, WY - 0.09, -0.02, -0.32);
    b.surf(SURF.metal, true).p(gRBox(0.06, 0.1, 0.17, 0.016), [BLK, BLK2], WX, AY - 0.03, 0.06);
    b.p(gBox(0.022, 0.05, 0.05), BLK, WX, AY + 0.03, -0.035, 0.5); // 击锤
    b.p(gTorus(0.03, 0.007, 4, 8), BLK2, WX, WY + 0.06, 0.06, 0, HALF_PI, 0); // 扳机护圈
    b.p(gCyl(0.026, 0.026, 0.36, 8), [BLK, BLK2], WX, AY, 0.33, HALF_PI, Math.PI / 8, 0);
    b.p(gBox(0.03, 0.03, 0.3), BLK, WX, AY - 0.032, 0.3);
    b.surf(SURF.gold).p(gTorus(0.027, 0.008, 4, 8), EMBG, WX, AY, 0.505).p(gBox(0.01, 0.022, 0.03), EMBG, WX, AY + 0.03, 0.48);
    b.p(gTorus(0.027, 0.006, 4, 8), EMBG, WX, AY, 0.17);
    // 余烬裂纹（稀有度色：烬铸是余烬橙）
    b.x(gBox(0.006, 0.008, 0.26), 1, WX + 0.027, AY + 0.004, 0.33, 0, 0.06, 0).x(gBox(0.006, 0.008, 0.2), 1, WX - 0.027, AY - 0.004, 0.36, 0, -0.08, 0);
    b.x(gBox(0.062, 0.008, 0.008), 1, WX, AY - 0.03, 0.1, 0, 0, 0.3);
    b.at('wGb').surf(SURF.metal, true).p(gCyl(0.05, 0.05, 0.1, 8), [BLK, BLK2], WX, AY - 0.005, 0.1, HALF_PI);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.5;
      b.x(gOct(0.011), 1, WX + Math.cos(a) * 0.033, AY - 0.005 + Math.sin(a) * 0.033, 0.152);
    }
  }
  // 四种弓：弓臂从握把（LX, WY, GZ）弯到弓梢（相对握把 tx, ty, ±tz），弓梢位置一样（弓弦挂在本体的 bsU / bsL 上）
  function rangedBows(b, LX, WY, GZ, tx, ty, tz, GOLD) {
    const tipE = (s) => [LX + tx, WY + ty, GZ + s * tz];
    // --- 追猎弓：短而狠的反曲猎弓，乌木弓臂，梢头骨质外卷，握把缠青绿猎绳，弓背一枚「猎眼」---
    {
      const limb = (s) => [[0, 0, s * 0.08], [tx * 0.05, -0.05, s * 0.25], [tx * 0.3, -0.065, s * 0.45], [tx * 0.62, -0.01, s * 0.6], [tx * 0.86, ty * 0.6, s * 0.67], [tx, ty, s * tz]];
      b.variant('huntbow').at('wBo').surf(SURF.leather);
      b.p(gSweep('pl/hbU', limb(1), [0.032, 0.028, 0.022, 0.016, 0.012, 0.009], 6), [0x1f1a17, 0x4d3c2e], LX, WY, GZ);
      b.p(gSweep('pl/hbL', limb(-1), [0.032, 0.028, 0.022, 0.016, 0.012, 0.009], 6), [0x1f1a17, 0x4d3c2e], LX, WY, GZ);
      b.p(gCyl(0.037, 0.037, 0.17, 7), 0x23443e, LX, WY, GZ, HALF_PI);
      for (const zz of [-0.05, 0, 0.05]) b.p(gTorus(0.038, 0.007, 3, 8), 0x3d8a78, LX, WY, GZ + zz);
      b.surf(SURF.bone);
      for (const s of [1, -1]) {
        const t = tipE(s);
        b.p(gSweep('pl/hbtip' + s, [[0, 0, 0], [0, -0.015, s * 0.045], [0, -0.06, s * 0.07], [0, -0.09, s * 0.06]], [0.012, 0.011, 0.009, 0.004], 4), 0xd9cfb6, t[0], t[1], t[2]);
      }
      b.p(gCone(0.02, 0.07, 4), 0xd9cfb6, LX, WY - 0.06, GZ + 0.12, -0.5).p(gCone(0.02, 0.07, 4), 0xd9cfb6, LX, WY - 0.06, GZ - 0.12, Math.PI + 0.5);
      b.x(gOct(0.022), 1, LX, WY - 0.05, GZ, 0, 0, 0, 1, 0.6, 1.4);
      b.x(gBox(0.014, 0.014, 0.12), 1, LX + tx * 0.3, WY - 0.08, GZ + 0.42, -0.1).x(gBox(0.014, 0.014, 0.12), 1, LX + tx * 0.3, WY - 0.08, GZ - 0.42, 0.1);
    }
    // --- 符文弓：灰蓝的石纹弓臂，银色包角，握把外一圈符环，弓臂上各三道发光的符刻 ---
    {
      const limb = (s) => [[0, 0, s * 0.08], [tx * 0.1, -0.05, s * 0.28], [tx * 0.4, -0.035, s * 0.48], [tx * 0.74, ty * 0.38, s * 0.62], [tx, ty, s * tz]];
      b.variant('runebow').at('wBo').surf(SURF.stone);
      b.p(gSweep('pl/rbU', limb(1), [0.036, 0.032, 0.026, 0.018, 0.011], 6), [0x262c3a, 0x56637e], LX, WY, GZ);
      b.p(gSweep('pl/rbL', limb(-1), [0.036, 0.032, 0.026, 0.018, 0.011], 6), [0x262c3a, 0x56637e], LX, WY, GZ);
      b.surf(SURF.leather).p(gCyl(0.038, 0.038, 0.17, 7), 0x2a2232, LX, WY, GZ, HALF_PI);
      b.surf(SURF.metal).p(gTorus(0.085, 0.012, 4, 14), 0xb8c4d6, LX, WY - 0.02, GZ, 0, HALF_PI, 0);
      for (const s of [1, -1]) {
        const t = tipE(s);
        b.p(gCone(0.022, 0.08, 5), 0xb8c4d6, t[0], t[1] - 0.01, t[2] - s * 0.02, s > 0 ? HALF_PI : -HALF_PI);
        b.p(gCyl(0.041, 0.041, 0.024, 7), 0xb8c4d6, LX, WY, GZ + s * 0.095, HALF_PI);
      }
      b.x(gTorus(0.085, 0.006, 3, 14), 1, LX - 0.01, WY - 0.02, GZ, 0, HALF_PI, 0);
      for (const s of [1, -1]) for (const f of [0.22, 0.34, 0.46]) b.x(gBox(0.03, 0.01, 0.022), 1, LX + tx * f, WY - 0.06 + f * 0.04, GZ + s * f * 1.15, 0, 0, s * 0.3);
    }
    // --- 冰弓（凛羽）：霜钢弓臂棱角分明（握把处发暗、往梢头渐渐结霜发白），弓背伸出几枚淡蓝的冰晶尖刺，
    // 弓臂上一路冷蓝的冰裂纹，握把前托着一颗发冷光的冰核。裂纹和冰核走这把弓自己的冰蓝自发光（见 VAR_GLOW），
    // 不吃玩家的元素色；握把两头的细环是稀有度色（凛羽的烬铸档在 applyGear 里换成冰蓝，见 GEAR_GLOW_VAR）---
    {
      const limb = (s) => [[0, 0, s * 0.08], [tx * 0.1, -0.06, s * 0.24], [tx * 0.3, -0.075, s * 0.42], [tx * 0.56, -0.035, s * 0.56], [tx * 0.82, ty * 0.5, s * 0.66], [tx, ty, s * tz]];
      const ICE_LO = 0x3d86c4, ICE_HI = 0xc8ecff, FROST = 0xa9c6de;
      // 弓臂用低金属度的面：高金属度在俯视镜头下只反射出暗色的天空下半截，霜色会被吃成一片黑
      b.variant('emberbow').at('wBo').surf(SURF.bone, true);
      b.p(gSweep('pl/ebU', limb(1), [0.04, 0.036, 0.03, 0.022, 0.015, 0.01], 5), [0x2a4460, 0x9cc4e6], LX, WY, GZ);
      b.p(gSweep('pl/ebL', limb(-1), [0.04, 0.036, 0.03, 0.022, 0.015, 0.01], 5), [0x2a4460, 0x9cc4e6], LX, WY, GZ);
      b.surf(SURF.leather).p(gCyl(0.04, 0.04, 0.18, 7), 0x1b2838, LX, WY, GZ, HALF_PI);
      // 冰晶尖刺：拉长的八面体，硬朗的面
      b.surf(SURF.ice, true);
      for (const s of [1, -1]) {
        b.p(gOct(1), [ICE_LO, ICE_HI], LX + tx * 0.3, WY - 0.12, GZ + s * 0.4, -HALF_PI - s * 0.5, 0, 0, 0.026, 0.085, 0.026);
        b.p(gOct(1), [ICE_LO, ICE_HI], LX + tx * 0.6, WY - 0.06, GZ + s * 0.58, -HALF_PI - s * 0.8, 0, 0, 0.02, 0.06, 0.02);
        const t = tipE(s);
        b.p(gOct(1), [ICE_LO, ICE_HI], t[0], t[1] + 0.02, t[2] + s * 0.03, s > 0 ? HALF_PI - 0.4 : -HALF_PI + 0.4, 0, 0, 0.018, 0.065, 0.018);
        // 冰核两侧各一根托住它的霜钢爪
        b.surf(SURF.metal, true).p(gCone(0.012, 0.07, 4), FROST, LX, WY - 0.075, GZ + s * 0.035, -HALF_PI + s * 0.5).surf(SURF.ice, true);
      }
      b.surf(SURF.metal).p(gCyl(0.044, 0.044, 0.026, 7), FROST, LX, WY, GZ + 0.1, HALF_PI).p(gCyl(0.044, 0.044, 0.026, 7), FROST, LX, WY, GZ - 0.1, HALF_PI);
      // 冰裂纹：顺着弓臂一路的几段（冰蓝自发光）
      for (const s of [1, -1]) {
        b.g(gBox(0.012, 0.012, 0.16), 1, LX + tx * 0.15, WY - 0.075, GZ + s * 0.3, s * -0.1);
        b.g(gBox(0.012, 0.012, 0.13), 1, LX + tx * 0.45, WY - 0.065, GZ + s * 0.49, s * 0.15);
        b.g(gBox(0.01, 0.01, 0.1), 1, LX + tx * 0.75, WY + ty * 0.25, GZ + s * 0.62, s * 0.6);
      }
      b.g(gOct(0.038), 1.2, LX, WY - 0.075, GZ, 0, 0.6, 0, 1, 1.5, 1);
      // 稀有度色：握把两头的细环
      b.x(gTorus(0.046, 0.006, 3, 10), 1, LX, WY, GZ + 0.115).x(gTorus(0.046, 0.006, 3, 10), 1, LX, WY, GZ - 0.115);
    }
    b.variant(null);
  }

  // ----- C 模型的配置：哪副骨架换哪个模型、骨骼怎么对到关节上、怎么摆静止姿态、怎么上色 -----
  // map(骨骼名) → 关节名（蒙皮权重并过去）；pivot：关节 → 骨骼名（枢轴挪到那根骨骼）或 (pos, piv0) => [x,y,z]；
  // aim(骨骼名) → [指向的骨骼, 目标方向（[x,y,z] 或 [关节A, 关节B] 取程序化骨架里两关节的连线）]；rot(骨骼名) → [轴 x,y,z, 角度]；
  // scale(骨骼名) → 等比缩放；keep(关节名, 种类) → 这个关节上的程序化零件留不留；color(材质, 图元, 原色, 顶点色, y, out) → 线性 rgb；
  // surf(材质) → SURF；glow(材质) → 自发光强度（0 = 不发光）；hide(图元, 材质) → 不要这块网格；shift：关节 → 额外平移（武器对准拳心）
  const cLin = (hex) => {
    const c = lin(hex);
    return [c.r, c.g, c.b];
  };
  // 贴地的部分压暗一点（和程序化角色的假环境光遮蔽一样）
  const cShade = (out, c, y, h, k) => {
    const sh = 1 - k * (1 - smooth01(y / (h * 0.45)));
    out[0] = c[0] * sh; out[1] = c[1] * sh; out[2] = c[2] * sh;
    return out;
  };
  const FINGER = /^(Index|Middle|Ring|Pinky|Thumb)\d[LR]$/;
  // 主角：Adventurer（Ultimate Modular Men）。深靛蓝紫皮衣、青绿围巾、灰烬银的头发；背包摘掉
  // 卡通配色（设计稿 2.3）：每个材质一段竖向渐变 [下端色, 上端色, 下端 y, 上端 y]（静止姿态里的高度），上亮下冷，
  // 像手绘的明暗；固有色定在受光面落在亮度 55%～75% 的那一档，暗部交给光照阶梯和冷色阴影。
  // 模型的材质：Green = 短袖皮夹克，LightGreen = 里面的衬衣，Brown = 长裤，Brown2 = 腰带和护膝，Grey = 靴子，Black = 鞋底
  const PL_COL = {
    Hair: [0x9290b4, 0xeceaf6, 1.58, 1.9], // 灰烬银：头顶最亮，发梢压到冷灰紫
    Eyebrows: [0x5e5c78, 0x5e5c78, 0, 1], Eye: [0x1c1828, 0x1c1828, 0, 1],
    Skin: [0xc08478, 0xe8b8a4, 0.85, 1.75], // 暖肤色：脸最亮，手往下偏红（主光是暖橙，固有色偏粉一点，免得整张脸发橙）
    Green: [0x34366e, 0x5a5ca8, 1.02, 1.58], // 深靛蓝紫皮衣：肩头带一层亮边色（偏蓝一点，暖光下不发紫）
    LightGreen: [0x8e8680, 0xc8c0b4, 1.02, 1.58], // 亚麻衬衣：躯干正中一块浅色，把皮衣和围巾隔开（偏冷的米白，暖光下是奶油色）
    Brown: [0x2a2e4c, 0x434874, 0.12, 1.04], // 深海军蓝长裤
    Brown2: [0x402a28, 0x5a3a34, 0.58, 1.04], // 腰带 / 护膝：靴子同色系的深棕
    Grey: [0x3a2426, 0x5a3a36, 0.02, 0.24], Black: [0x221a20, 0x221a20, 0, 1], // 靴子 / 鞋底：深皮棕（暖光下浅了会像光脚）
    Gold: [0xc8923a, 0xe8b450, 0, 2],
  };
  for (const k in PL_COL) {
    const c = PL_COL[k];
    PL_COL[k] = { lo: cLin(c[0]), hi: cLin(c[1]), y0: c[2], y1: c[3] };
  }
  const PL_DEF = { lo: cLin(0x3b3439), hi: cLin(0x3b3439), y0: 0, y1: 1 };
  // 额外零件（护肩、后摆、护腕）的颜色，和模型的材质同一套：皮衣 [下, 上, 后摆下端, 后摆内侧]、靴子皮 [下, 上]、金饰
  const PL_LEA = [0x36386e, 0x5a5ca8, 0x2e3064, 0x262448], PL_BOOT = [0x3e2826, 0x664036], PL_GOLD = 0xe8b450;
  // 主角的顶点色：材质的竖向渐变 + 一层很淡的按位置的明暗起伏（笔触感）+ 贴地压暗
  const plColor = (mat, y, x, z, out) => {
    const c = PL_COL[mat] || PL_DEF, t = smooth01((y - c.y0) / (c.y1 - c.y0 || 1));
    const n = 1 + (vnoise(x * 9.1 + z * 4.3 + 3.7, y * 9.1 - z * 3.1) - 0.5) * 0.12;
    for (let k = 0; k < 3; k++) out[k] = (c.lo[k] + (c.hi[k] - c.lo[k]) * t) * n;
    return cShade(out, out, y, 1.9, 0.22);
  };
  const PL_SURF = { Skin: SURF.leather, Hair: SURF.cloth, Green: SURF.leather, LightGreen: SURF.cloth, Grey: SURF.leather, Black: SURF.leather, Brown2: SURF.leather, Gold: SURF.gold };
  const PL_MAP = {
    Root: 'root', Body: 'root', Hips: 'root', Abdomen: 'root', Torso: 'spine', Chest: 'chest', ShoulderL: 'chest', ShoulderR: 'chest', Neck: 'head', Head: 'head',
    UpperArmL: 'uaL', LowerArmL: 'faL', WristL: 'hL', UpperArmR: 'uaR', LowerArmR: 'faR', WristR: 'hR',
    UpperLegL: 'thL', LowerLegL: 'shL', FootL: 'ftL', UpperLegR: 'thR', LowerLegR: 'shR', FootR: 'ftR',
  };
  // 换成模型的身体关节（这些关节上的程序化零件不要了）；围巾的两条尾巴留着（挂在新的结扣上，照旧由弹簧驱动），马尾不要
  const PL_BODY = { root: 1, spine: 1, chest: 1, head: 1, uaL: 1, faL: 1, hL: 1, uaR: 1, faR: 1, hR: 1, thL: 1, shL: 1, ftL: 1, thR: 1, shR: 1, ftR: 1, tab: 1, hp1: 1, hp2: 1, hp3: 1 };
  // 围巾结扣：脖子后面偏左（相对 Neck 骨骼）
  const PL_KNOT = [0.07, -0.035, -0.125];
  const plKnot = (side) => (pos, piv0) => {
    const n = pos('Neck'), o = piv0('sf' + side + '1');
    return [n[0] + PL_KNOT[0] + (o[0] - SF.kx), n[1] + PL_KNOT[1], n[2] + PL_KNOT[2]];
  };
  // 上臂静止时比程序化骨架多张开一点（这个模型肩窄、胸厚，垂直放下会插进躯干）
  const PL_ARM = [0.3, -1, 0.0], PL_FORE = [0.06, -1, 0.1];
  // 游魂（Zombie）的骨骼 → 关节
  const HK_MAP = {
    Hips: 'root', Spine: 'spine', Spine1: 'spine', Spine2: 'spine', LeftShoulder: 'spine', RightShoulder: 'spine', Neck: 'head', Head: 'head', HeadTop_End: 'head',
    LeftArm: 'uaL', LeftForeArm: 'faL', RightArm: 'uaR', RightForeArm: 'faR', LeftUpLeg: 'thL', LeftLeg: 'shL', LeftFoot: 'ftL', RightUpLeg: 'thR', RightLeg: 'shR', RightFoot: 'ftR',
  };
  // 卡通配色（设计稿 2.3）：模型贴图调色板的几种颜色各换成游魂自己的一套——灰烬灰的冷皮肤、两种暗紫褐的破衣，
  // 贴图里的血污换成余烬裂纹（自发光，见 vglow），眼白压成深眼窝、瞳孔发光。比地面亮一档、比主角暗、饱和度低。
  // 每项：[贴图里的原色（最近的那个算数）, 下端色, 上端色]；渐变按静止姿态的高度（0.2 → 1.95）
  const HK_PAL = [
    [[0.8, 0.85, 0.45], 0x5a5070, 0xa49aa6], // 皮肤：头肩是灰烬灰 #a49aa6，往下压到冷紫
    [[0.6, 0.5, 0.4], 0x4c3848, 0x725666], // 破衬衣
    [[0.1, 0.15, 0.4], 0x2c2234, 0x4a3a52], // 破裤子
    [[0.7, 0.5, 0.2], 0x4e3a36, 0x5e463e], // 绳带 / 鞋
    [[0.85, 0.85, 0.6], 0x24161e, 0x24161e], // 眼白 → 深眼窝
  ].map((e) => ({ src: e[0], lo: cLin(e[1]), hi: cLin(e[2]) }));
  // 贴图里的血污（暗红）和红瞳 → 余烬裂纹 / 眼窝里的火：返回自发光亮度
  const HK_GLOW = [[[0.4, 0, 0], 1.25], [[0.65, 0, 0.05], 1.5]];
  const hkNear = (c, src) => (c[0] - src[0]) ** 2 + (c[1] - src[1]) ** 2 + (c[2] - src[2]) ** 2;
  const hkGlow = (c) => {
    let best = 0, bd = 0.02; // 和最近的余烬色足够近才发光
    for (const [src, k] of HK_GLOW) {
      const d = hkNear(c, src);
      if (d < bd) { bd = d; best = k; }
    }
    if (!best) return 0;
    for (const e of HK_PAL) if (hkNear(c, e.src) < bd) return 0;
    return best;
  };
  // 骷髅（Skeleton）：模型里 R 开头的骨骼在 +x 一侧（按看着它的人的左右起名），也就是骷髅自己的左边；…001 是手臂
  const TH_MAP = {
    Hips: 'root', Torso: 'chest', Neck: 'head', Head: 'head',
    RUpperLeg001: 'uaL', RDownLeg001: 'faL', LUpperLeg001: 'uaR', LDownLeg001: 'faR', RUpperLeg: 'thL', RDownLeg: 'shL', LUpperLeg: 'thR', LDownLeg: 'shR',
  };
  const TH_BONE = cLin(0xaaa398); // 骨色：卡通配色下抬亮成浅骨白（旧的焦骨 0x5a5a5c 在新光照下发脏）
  // 焦骨：按位置撒一层焦黑的斑（每个顶点 0～60% 压暗）
  const thChar = (out, c, x, y, z) => {
    const h = Math.sin(x * 41.3 + y * 27.1 + z * 63.7) * 43758.5453, n = h - Math.floor(h);
    const k = 1 - 0.6 * n * n;
    out[0] = c[0] * k; out[1] = c[1] * k * 0.98; out[2] = c[2] * k * 0.96;
    return out;
  };
  // 一段骨骼（a → b 的方向延长出去）上 t 处的点：骷髅的手腕在前臂上 66% 处
  const thSeg = (pos, a, b, t) => {
    const p = pos(a), q = pos(b);
    return [q[0] + (q[0] - p[0]) * t, q[1] + (q[1] - p[1]) * t, q[2] + (q[2] - p[2]) * t];
  };
  // split 的参数：骨骼 b 沿 a → b 方向，长度取 |a b|，过了 from 的部分换给关节 j；ankleY 给了时改按离地高度判断（小腿末端的脚）
  const thSplit = (pos, a, b, j, from, ankleY) => {
    const p = pos(a), q = pos(b), d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], len = Math.hypot(d[0], d[1], d[2]);
    if (ankleY !== undefined) return { j, a: [0, ankleY + 0.04, 0], d: [0, -1, 0], len: 1, from: 0 };
    return { j, a: q, d: d.map((v) => v / len), len, from };
  };
  // 蜘蛛（Spider）：身体 / 头 / 腹三节，八条腿各三节同名；脚上的 IK 骨骼不参与
  const SP_MAP = { Root: 'root', Body: 'root', Thorax: 'thx', Head: 'head', Abdomen: 'abd' };
  // 卡通：苔绿的甲壳（背上亮、腿根暗），在暖褐的地面上冷暖分得开，也和主角围巾的青绿不撞（旧的炭黑 / 深梅在卡通光照下是一团黑）
  const SP_COL = [cLin(0x2e3a2a), cLin(0x7a8e4e)];
  const CSPEC = {
    player: {
      model: 'adventurer', height: 1.9, yaw: 0, center: 'Hips',
      map: (n) => PL_MAP[n] || (FINGER.test(n) ? 'h' + n.slice(-1) : null),
      pivot: {
        root: 'Hips', spine: 'Torso', chest: 'Chest', head: 'Neck',
        uaL: 'UpperArmL', faL: 'LowerArmL', hL: 'WristL', uaR: 'UpperArmR', faR: 'LowerArmR', hR: 'WristR',
        thL: 'UpperLegL', shL: 'LowerLegL', thR: 'UpperLegR', shR: 'LowerLegR',
        ftL: (pos) => { const k = pos('LowerLegL'); return [k[0], 0.1, k[2]]; },
        ftR: (pos) => { const k = pos('LowerLegR'); return [k[0], 0.1, k[2]]; },
        sfL1: plKnot('L'), sfR1: plKnot('R'),
      },
      drive: { ftL: 'FootL', ftR: 'FootR' },
      aim: (n) => {
        const s = n.slice(-1) === 'L' ? 1 : -1;
        if (n === 'UpperArmL' || n === 'UpperArmR') return ['LowerArm' + n.slice(-1), [s * PL_ARM[0], PL_ARM[1], PL_ARM[2]]];
        if (n === 'LowerArmL' || n === 'LowerArmR') return ['Wrist' + n.slice(-1), [s * PL_FORE[0], PL_FORE[1], PL_FORE[2]]];
        if (n === 'WristL' || n === 'WristR') return ['Middle2' + n.slice(-1), [s * PL_FORE[0], PL_FORE[1], PL_FORE[2]]];
        if (n === 'UpperLegL' || n === 'UpperLegR') return ['LowerLeg' + n.slice(-1), ['th' + n.slice(-1), 'sh' + n.slice(-1)]];
        return null;
      },
      // 握拳：四指的第二、三节各往掌心卷
      rot: (n) => (/^(Index|Middle|Ring|Pinky)[23][LR]$/.test(n) ? [0, 0, 1, (n.slice(-1) === 'L' ? -1 : 1) * 1.25] : null),
      hide: (name) => /^Backpack\//.test(name),
      // 胡子（头发网格在嘴以下、脸前面的部分）剃掉：烬渊的主角是个年轻人
      cull: (mat, x, y, z, pos) => mat === 'Hair' && y < pos('Head')[1] + 0.065 && z > pos('Head')[2] + 0.04,
      keep: (j) => !PL_BODY[j],
      // 青绿围巾：脖子上绕两圈 + 背后的结（尾巴是程序化骨架原有的 sf 关节）；卡通：再加几件让剪影厚实的零件——
      // 左肩皮护肩（金边）、两条小臂的皮护腕、腰带的金扣、皮衣下摆往下接两片开衩的长后摆（各挂在一条大腿上，迈腿时跟着摆），
      // 左手掌心前托着的一团余烬（自发光）
      extra: (b, pos) => {
        const n = pos('Neck');
        b.at('chest').surf(SURF.cloth);
        b.p(gTorus(0.088, 0.05, 6, 14), SF.c[1], n[0], n[1] - 0.005, n[2] + 0.008, HALF_PI + 0.22, 0, 0, 1, 1, 1.2);
        b.p(gTorus(0.114, 0.048, 6, 14), [SF.c[0], SF.c[1]], n[0], n[1] - 0.055, n[2] + 0.012, HALF_PI - 0.12, 0, 0, 1.08, 0.92, 1.15);
        b.p(gSph(0.058, 7, 5), SF.c[0], n[0] + PL_KNOT[0], n[1] + PL_KNOT[1] + 0.01, n[2] + PL_KNOT[2], 0, -0.35, 0, 1.4, 1, 0.8);
        // 左肩护肩：一块压在肩头的圆皮甲，外沿一圈金
        const ua = pos('UpperArmL');
        b.at('uaL').surf(SURF.leather).p(gDome(0.1, 9, 3, 1.3), [PL_LEA[0], PL_LEA[1]], ua[0] + 0.025, ua[1] + 0.02, ua[2], 0, 0, -0.5, 1.05, 0.72, 1.12);
        b.surf(SURF.gold).p(gTorus(0.1, 0.011, 4, 12), PL_GOLD, ua[0] + 0.025, ua[1] + 0.02, ua[2], HALF_PI, -0.5, 0, 1.05, 1.12, 1);
        // 护腕：小臂中段到手腕，靴子同色的皮，手腕那头一道金箍
        for (const [S, j] of [['L', 'faL'], ['R', 'faR']]) {
          const a = pos('LowerArm' + S), w = pos('Wrist' + S), f = (t) => [a[0] + (w[0] - a[0]) * t, a[1] + (w[1] - a[1]) * t, a[2] + (w[2] - a[2]) * t];
          const p0 = f(0.3), p1 = f(0.92);
          b.at(j).surf(SURF.leather).limb([PL_BOOT[0], PL_BOOT[1]], p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.05, 0.047, 8, 0);
          const p2 = f(0.86);
          b.surf(SURF.gold).limb(PL_GOLD, p2[0], p2[1], p2[2], p1[0], p1[1], p1[2], 0.052, 0.05, 8, 0);
        }
        // 腰带金扣
        const hp = pos('Hips');
        b.at('root').surf(SURF.gold).p(gRBox(0.075, 0.06, 0.026, 0.01), PL_GOLD, hp[0], 1.02, 0.17);
        // 长后摆：皮衣下摆（y ≈ 1.02）往下接到膝盖上方，两片各包住一条大腿的后外侧，中间开衩
        for (const [S, j, sn] of [['L', 'thL', 1], ['R', 'thR', -1]]) {
          const t = pos('UpperLeg' + S);
          b.at(j).surf(SURF.leather).pd(gDrape('pl/coatTail', [[0.165, 0.5], [0.15, 0.64], [0.13, 0.84], [0.118, 1.04]], 1.9, 7), [PL_LEA[2], PL_LEA[0]], PL_LEA[3], t[0] + sn * 0.012, 0, t[2] + 0.01, 0, sn * 0.62, 0);
        }
        // 左手的余烬：拳心前下方一团（元素光 = 余烬橙），外面一圈淡一点的光
        const wl = pos('WristL'), md = pos('Middle1L');
        const ex = wl[0] + (md[0] - wl[0]) * 0.8, ey = wl[1] + (md[1] - wl[1]) * 0.8 - 0.05, ez = wl[2] + (md[2] - wl[2]) * 0.8 + 0.07;
        b.at('hL').g(gOct(0.042), 1.35, ex, ey, ez, 0, 0.6, 0, 1, 1.4, 1).g(gSph(0.05, 7, 5), 0.55, ex, ey + 0.01, ez, 0, 0, 0, 1, 1.25, 1);
      },
      color: (mat, prim, base, vc, y, out, x, z) => plColor(mat, y, x, z, out),
      surf: (mat) => PL_SURF[mat] || SURF.cloth,
      sock: { head: ['head', 0, 0.2, 0.02], chest: ['chest', 0, 0.06, 0.12] },
      ankle: (rig) => rig.joints[rig.JI.ftL].py,
    },
    // 游魂：Zombie（Animated Zombie）。贴图调色板的颜色去饱和、压向灰烬的灰褐；驼背、双臂前伸（对齐程序化游魂的静止姿态）；眼窝两点元素火
    husk: {
      model: 'zombie', height: 2.15, yaw: -HALF_PI, center: 'Hips',
      map: (n) => HK_MAP[n] || (/^LeftHand/.test(n) ? 'faL' : /^RightHand/.test(n) ? 'faR' : /^LeftToe/.test(n) ? 'ftL' : /^RightToe/.test(n) ? 'ftR' : null),
      pivot: { root: 'Hips', spine: 'Spine', head: 'Neck', uaL: 'LeftArm', faL: 'LeftForeArm', uaR: 'RightArm', faR: 'RightForeArm', thL: 'LeftUpLeg', shL: 'LeftLeg', ftL: 'LeftFoot', thR: 'RightUpLeg', shR: 'RightLeg', ftR: 'RightFoot' },
      aim: (n) => {
        const L = n.indexOf('Left') === 0, s = L ? 1 : -1, S = L ? 'Left' : 'Right', j = L ? 'L' : 'R';
        if (n === 'Spine') return ['Neck', ['spine', 'head']];
        if (n === 'Neck') return ['HeadTop_End', [0, 1, 0.3]];
        if (n === S + 'Arm') return [S + 'ForeArm', ['ua' + j, 'fa' + j]];
        if (n === S + 'ForeArm') return [S + 'Hand', [s * 0.1, -1, 0.45]];
        if (n === S + 'Hand') return [S + 'HandIndex1', [s * 0.1, -1, 0.45]];
        if (n === S + 'UpLeg') return [S + 'Leg', ['th' + j, 'sh' + j]];
        if (n === S + 'Leg') return [S + 'Foot', ['sh' + j, 'ft' + j]];
        return null;
      },
      keep: () => false,
      color: (mat, prim, base, vc, y, out, x, z) => {
        const c = vc || base;
        let e = HK_PAL[0], bd = 9;
        for (const q of HK_PAL) {
          const d = hkNear(c, q.src);
          if (d < bd) { bd = d; e = q; }
        }
        const t = smooth01((y - 0.2) / 1.75), n = 1 + (vnoise(x * 8.3 + z * 3.9 - 1.3, y * 8.3 + z * 2.7) - 0.5) * 0.16;
        for (let k = 0; k < 3; k++) out[k] = (e.lo[k] + (e.hi[k] - e.lo[k]) * t) * n;
        return cShade(out, out, y, 2.15, 0.25);
      },
      vglow: hkGlow,
      surf: () => SURF.hide,
      extra: (b, pos) => {
        // 眼窝里两点元素火（模型的眼睛在 Head 骨骼前上方）
        const h = pos('Head');
        b.at('head');
        for (const s of [1, -1]) b.g(gOct(0.026), 1.25, h[0] + s * 0.05, h[1] + 0.105, h[2] + 0.115, 0, 0, 0, 1, 0.7, 0.6);
        // 腰间挂着的几条破布（双面，锯齿下沿），让剪影不那么光溜
        const hp = pos('Hips');
        b.at('root').surf(SURF.cloth);
        const rag = (k, a, r, y, len, w) =>
          b.pd(gPlate('hk/rag' + k, [[-w, 0], [w, 0], [w * 0.8, -len * 0.7], [w * 0.35, -len * 0.55], [0, -len], [-w * 0.5, -len * 0.6], [-w * 0.9, -len * 0.8]], 0.006, 0.002),
            [0x3a2a3a, 0x5a4450], 0x2e2232, hp[0] + Math.sin(a) * r, y, hp[2] + Math.cos(a) * r, 0.12, a, 0);
        rag(0, 0.45, 0.17, hp[1] + 0.06, 0.36, 0.07);
        rag(1, -1.35, 0.17, hp[1] + 0.04, 0.3, 0.06);
        rag(2, Math.PI + 0.35, 0.16, hp[1] + 0.07, 0.42, 0.08);
      },
      sock: { weapon: ['faR', -0.02, -0.42, 0.14], hand: ['faL', 0.02, -0.42, 0.14], head: ['head', 0, 0.2, 0.08], chest: ['spine', 0, 0.32, 0.14] },
      ankle: (rig) => rig.joints[rig.JI.ftL].py,
    },
    // 烬骸仆从：Skeleton（Animated Monster）。焦骨色、透着一层很淡的余烬光；头骨缩小一点，腿拉长一些（原模型是大头短腿）；
    // 前臂末端那一截拆给手腕关节（模型没有手骨），剑和小圆盾沿用程序化的
    thrall: {
      model: 'skeleton', height: 1.62, yaw: 0, center: 'Hips',
      map: (n) => TH_MAP[n] || null,
      pivot: {
        root: 'Hips', chest: 'Torso', head: 'Neck', uaL: 'RUpperLeg001', faL: 'RDownLeg001', uaR: 'LUpperLeg001', faR: 'LDownLeg001', thL: 'RUpperLeg', shL: 'RDownLeg', thR: 'LUpperLeg', shR: 'LDownLeg',
        hL: (pos) => thSeg(pos, 'RUpperLeg001', 'RDownLeg001', 0.66), hR: (pos) => thSeg(pos, 'LUpperLeg001', 'LDownLeg001', 0.66),
        ftL: (pos) => { const k = pos('RDownLeg'); return [k[0], 0.085, k[2]]; }, ftR: (pos) => { const k = pos('LDownLeg'); return [k[0], 0.085, k[2]]; },
      },
      aim: (n) => {
        if (n === 'RUpperLeg001') return ['RDownLeg001', [0.2, -1, 0.02]];
        if (n === 'LUpperLeg001') return ['LDownLeg001', [-0.2, -1, 0.02]];
        if (n === 'RUpperLeg') return ['RDownLeg', ['thL', 'shL']];
        if (n === 'LUpperLeg') return ['LDownLeg', ['thR', 'shR']];
        return null;
      },
      scale: (n) => (n === 'Head' ? 0.84 : null),
      stretch: (n) => (n === 'RUpperLeg' || n === 'LUpperLeg' ? [n.replace('Upper', 'Down'), 1.7] : null),
      ground: 0, // 拉长大腿把小腿和脚推到了地面以下：整个模型抬回来，脚底贴地
      // 前臂末端 34% 是手：权重给手腕关节；小腿末端是脚：给脚踝关节
      split: (n, pos) => {
        if (n === 'RDownLeg001') return thSplit(pos, 'RUpperLeg001', 'RDownLeg001', 'hL', 0.66);
        if (n === 'LDownLeg001') return thSplit(pos, 'LUpperLeg001', 'LDownLeg001', 'hR', 0.66);
        if (n === 'RDownLeg') return thSplit(pos, 'RUpperLeg', 'RDownLeg', 'ftL', 0.82, 0.085);
        if (n === 'LDownLeg') return thSplit(pos, 'LUpperLeg', 'LDownLeg', 'ftR', 0.82, 0.085);
        return null;
      },
      keep: (j, kind, tag) => tag === 'gear',
      color: (mat, prim, base, vc, y, out, x, z) => cShade(out, thChar(out, TH_BONE, x, y, z), y, 1.85, 0.4),
      surf: () => SURF.bone,
      emis: [0xff5a1e, 0.015], // 很淡：整身的橙色自发光会把焦骨染成陶土色，余烬主要靠胸腔和眼窝的魂火
      extra: (b, pos) => {
        // 胸腔里的魂火（肋骨缝里透出来）+ 眼窝里两点魂火
        const t = pos('Torso'), n = pos('Neck'), h = pos('Head');
        b.at('chest').g(gSph(0.075, 7, 5), 1.4, t[0], t[1] + (n[1] - t[1]) * 0.55, t[2] + 0.01, 0, 0, 0, 1, 1.4, 0.9);
        b.at('head');
        for (const s of [1, -1]) b.g(gSph(0.026, 6, 4), 1.7, h[0] + s * 0.058, h[1] + 0.155, h[2] + 0.125, 0, 0, 0, 1.1, 0.9, 0.6);
      },
      // 步频 / 腿摆幅：着地那只脚往后扫的距离 ≈ 半个步态周期走过的距离（π / stride），和程序化骨架的比例一致
      stride: 4.1,
      gait: 0.9,
      sock: { weapon: ['hR', 0, -0.05, 0.92], hand: ['hR', 0, -0.05, 0.03], head: ['head', 0, 0.3, 0.02], chest: ['chest', 0, 0.22, 0.06] },
      ankle: (rig) => rig.joints[rig.JI.ftL].py,
    },
    // 喷吐者：Spider（Easy Enemy）。炭黑的身体，眼睛和腹背上的囊发着元素光；骨架是蜘蛛自己的（八条腿各三节），
    // 动作用模型自带的走 / 待机 / 攻击 / 死亡采样成关键帧，失衡是程序化的
    spitter: {
      model: 'spider', height: 0.78, yaw: 0, center: 'Body',
      map: (n) => (SP_MAP[n] !== undefined ? SP_MAP[n] : /Leg/.test(n) ? n : null),
      pivot: null, // spiderRig 里按骨骼逐个填
      keep: () => false,
      color: (mat, prim, base, vc, y, out) => {
        const t = smooth01((y - 0.12) / 0.5);
        for (let k = 0; k < 3; k++) out[k] = SP_COL[0][k] + (SP_COL[1][k] - SP_COL[0][k]) * t;
        return cShade(out, out, y, 0.78, 0.15);
      },
      surf: () => SURF.chitin,
      glow: (mat) => (mat === 'Material.001' ? 1.1 : 0),
      extra: (b, pos) => {
        // 腹背上的余烬囊：半埋在腹部上方的一团（元素光），囊外两道暗色的甲环
        const a = pos('Abdomen');
        const x = a[0], y = a[1] + 0.33, z = a[2] - 0.34;
        b.at('abd').g(gSph(0.13, 8, 6), 1.2, x, y, z, -0.25, 0, 0, 1.2, 0.45, 1.45);
        b.surf(SURF.chitin, true).p(gTorus(0.12, 0.018, 4, 12), 0x15110f, x, y + 0.02, z + 0.07, HALF_PI - 0.3, 0, 0, 1.15, 1, 0.7);
        b.p(gTorus(0.1, 0.016, 4, 12), 0x15110f, x, y - 0.01, z - 0.1, HALF_PI - 0.1, 0, 0, 1.2, 1, 0.7);
      },
      // Head 骨骼在身体中部：嘴（weapon / hand）挪到眼睛前下方的口器处，head 挪到眼睛上方
      sock: { weapon: ['head', 0, -0.02, 0.4], hand: ['head', 0, -0.02, 0.4], head: ['head', 0, 0.14, 0.22], chest: ['root', 0, 0.2, 0.05] },
    },
  };

  function playerRig() {
    return rigOf('player', () => cTry('player', (cs) => {
      const STEEL = 0x5d6a84, STEEL_D = 0x343c4e, GOLD = 0xdcae45, BLADE = 0xd9dee6, WOOD = 0x6b4a32, BONE = 0xd9cfb6;
      const b = rigBuilder('player', NB_BIG, cs);
      b.j('root', null, 0, 1.0, 0).j('spine', 'root', 0, 1.1, 0).j('chest', 'spine', 0, 1.32, 0).j('head', 'chest', 0, 1.62, 0.01);
      b.j('uaL', 'chest', 0.33, 1.5, 0).j('faL', 'uaL', 0.38, 1.19, -0.01).j('hL', 'faL', 0.39, 0.9, 0.02);
      b.j('uaR', 'chest', -0.33, 1.5, 0).j('faR', 'uaR', -0.38, 1.19, -0.01).j('hR', 'faR', -0.39, 0.9, 0.02);
      b.j('wB', 'hR', -0.39, 0.84, 0.05).j('wS', 'hR', -0.39, 0.84, 0.05).j('wW', 'hR', -0.39, 0.84, 0.05);
      // 后加的四种武器：双匕（两手各一把）、战锤、太刀挂右手；长弓挂左手，弓弦两段各挂在弓梢上（拉弓时转向右手、拉长）；
      // wA 是拉弓时右手捏着的那支箭
      b.j('wD', 'hR', -0.39, 0.84, 0.05).j('wH', 'hR', -0.39, 0.84, 0.05).j('wK', 'hR', -0.39, 0.84, 0.05).j('wA', 'hR', -0.39, 0.84, 0.03);
      b.j('wDL', 'hL', 0.39, 0.84, 0.05).j('wBo', 'hL', 0.39, 0.84, 0.05);
      b.j('bsU', 'wBo', BOW_TIP[0], BOW_TIP[1], BOW_TIP[2]).j('bsL', 'wBo', BOW_TIP[0], BOW_TIP[1], 0.08 - BOW_TIP[2]);
      // 魂幡挂右手；幡布两段（bnF1 挂在挑杆上，bnF2 是下半截），挑杆外端和杆另一侧各坠一串骨符（bnC1 / bnC2）。都由 bannerSway 按摆锤算
      b.j('wBn', 'hR', -0.39, 0.84, 0.05);
      b.j('bnF1', 'wBn', -0.39 - BAN_X, 0.84, BAN_Z).j('bnF2', 'bnF1', -0.39 - BAN_X, 0.84, BAN_Z - BAN_L1);
      b.j('bnC1', 'wBn', -0.39 - 0.48, 0.84, BAN_Z).j('bnC2', 'wBn', -0.39 + 0.15, 0.84, BAN_Z - 0.1);
      // 火器挂右手（三把枪各是一组变体零件）；wGb 是机炮的转膛（枪管束绕自身轴转）/ 左轮的转轮
      b.j('wF', 'hR', -0.39, 0.84, 0.05).j('wGb', 'wF', -0.39, 0.84 + GUN_AX, 0.3);
      b.j('thL', 'root', 0.14, 0.97, 0).j('shL', 'thL', 0.15, 0.53, 0.01).j('ftL', 'shL', 0.15, 0.12, 0);
      b.j('thR', 'root', -0.14, 0.97, 0).j('shR', 'thR', -0.15, 0.53, 0.01).j('ftR', 'shR', -0.15, 0.12, 0);
      b.j('tab', 'root', 0, 1.0, 0.19);
      // 围巾两条尾巴（各三节，挂在胸口）+ 马尾（三节，挂在头上）
      for (const [side, sn] of [['L', 1], ['R', -1]]) {
        const x = SF.kx + sn * SF.x;
        b.j('sf' + side + '1', 'chest', x, SF.y, SF.z).j('sf' + side + '2', 'sf' + side + '1', x, SF.y - SF.len[0], SF.z).j('sf' + side + '3', 'sf' + side + '2', x, SF.y - SF.len[0] - SF.len[1], SF.z);
      }
      b.j('hp1', 'head', ...HAIR_T[0]).j('hp2', 'hp1', ...HAIR_T[1]).j('hp3', 'hp2', ...HAIR_T[2]);
      // 旧披风的三节退成虚关节：动作里的 cape1..3 关键帧不再摆布片，只当作「甩」的信号喂给围巾 / 马尾的弹簧
      b.v('cape1').v('cape2').v('cape3');

      // --- 骨盆：短皮裙（让出大腿，腿显得长）、腰带、三只腰包、背后横挂一把短匕 ---
      b.at('root').surf(SURF.leather);
      b.p(gLathe('pl/hip', [[0.232, 0.85], [0.246, 0.91], [0.222, 1.0], [0.208, 1.08]], 10), [LEA_D, LEA], 0, 0, 0, 0, 0, 0, 1, 1, 0.84);
      b.p(gTorus(0.218, 0.024, 5, 14), 0x2a2326, 0, 1.04, 0, HALF_PI, 0, 0, 1, 0.84, 1);
      b.surf(SURF.gold).p(gRBox(0.09, 0.08, 0.04, 0.014), 0x8c8f99, 0, 1.04, 0.19);
      b.surf(SURF.leather);
      b.p(gRBox(0.1, 0.11, 0.07, 0.024), POUCH, 0.16, 0.96, 0.14, 0, 0.55, 0);
      b.p(gRBox(0.09, 0.1, 0.065, 0.022), POUCH, 0.235, 0.97, -0.01, 0, HALF_PI, 0);
      b.p(gRBox(0.08, 0.09, 0.06, 0.02), POUCH, -0.19, 0.97, 0.12, 0, -0.6, 0);
      b.p(gCyl(0.022, 0.022, 0.13, 6), 0x2a2326, 0.09, 1.0, -0.22, 0, 0, HALF_PI);
      b.surf(SURF.metal).p(gPlate('pl/knife', [[0, 0.02], [0.2, 0.012], [0.25, 0], [0.2, -0.012], [0, -0.02]], 0.008, 0.004), [0x8d97a8, 0xc9d0da], 0.15, 1.0, -0.225, 0, 0, Math.PI);
      // --- 前襟：两条长短不一的窄布 ---
      b.at('tab').surf(SURF.cloth);
      b.pd(gPlate('pl/tab1', [[-0.04, 0], [0.04, 0], [0.035, -0.26], [0, -0.3], [-0.035, -0.24]], 0.008, 0.003), [0x1a1a20, 0x2e2f38], 0x101014, 0.05, 1.0, 0.2, -0.07, 0, 0.05);
      b.pd(gPlate('pl/tab2', [[-0.035, 0], [0.035, 0], [0.03, -0.2], [0, -0.23], [-0.03, -0.18]], 0.008, 0.003), [0x1a1a20, 0x2e2f38], 0x101014, -0.045, 1.0, 0.205, -0.07, 0, -0.06);
      // --- 腹部：收腰 ---
      b.at('spine').surf(SURF.leather);
      b.p(gLathe('pl/abd', [[0.2, 1.03], [0.19, 1.14], [0.212, 1.3], [0.198, 1.36]], 10), [LEA_D, LEA], 0, 0, 0, 0, 0, 0, 1, 1, 0.82);
      // --- 胸：深色皮衣、左肩到右胯的飞刀绑带（三把飞刀）、左肩一块皮垫 ---
      b.at('chest').surf(SURF.leather);
      b.p(gLathe('pl/chest', [[0.2, 1.26], [0.258, 1.36], [0.272, 1.46], [0.205, 1.555], [0.1, 1.615]], 12), [LEA_D, LEA], 0, 0, 0, 0, 0, 0, 1, 1, 0.8);
      b.p(gSweep('pl/strap', [[0.22, 1.55, 0.06], [0.13, 1.47, 0.205], [-0.02, 1.34, 0.226], [-0.2, 1.24, 0.15]], [0.026, 0.026, 0.026, 0.024], 4), STRAP, 0, 0, 0);
      b.p(gSweep('pl/strap2', [[0.22, 1.55, 0.06], [0.16, 1.5, -0.14], [-0.02, 1.36, -0.2], [-0.2, 1.24, 0.15]], [0.024, 0.024, 0.024, 0.024], 4), STRAP, 0, 0, 0);
      b.surf(SURF.metal);
      for (let k = 0; k < 3; k++) b.p(gPlate('pl/fk', [[-0.012, 0], [0.012, 0], [0.008, 0.09], [0, 0.11], [-0.008, 0.09]], 0.006, 0.003), [0x7d8798, 0xc9d0da], 0.09 - k * 0.055, 1.46 - k * 0.045, 0.232, -0.12, 0, 0.55);
      b.surf(SURF.leather).p(gDome(0.115, 8, 3, 1.3), [LEA_D, LEA], 0.355, 1.5, 0, 0, 0, -0.62, 1, 0.7, 1.1);
      // --- 围巾：颈间绕两圈 + 背后偏左的结 + 两条细长的尾巴（各三节，tailSprings 驱动）---
      b.at('chest').surf(SURF.cloth);
      b.p(gTorus(0.122, 0.056, 6, 14), SF.c[1], 0, 1.605, -0.01, HALF_PI + 0.2, 0, 0, 1, 1, 1.3);
      b.p(gTorus(0.15, 0.05, 6, 14), [SF.c[0], SF.c[1]], 0, 1.555, 0.0, HALF_PI - 0.14, 0, 0, 1.06, 0.92, 1.25);
      b.p(gSph(0.062, 7, 5), SF.c[0], SF.kx, 1.585, -0.152, 0, -0.35, 0, 1.4, 1, 0.8);
      for (const [side, s] of [['L', 1], ['R', -1]]) {
        let y = SF.y;
        for (let i = 0; i < 3; i++) {
          const len = SF.len[i] + 0.03, w0 = SF.w[i] / 2, w1 = SF.w[i + 1] / 2, last = i === 2;
          const pts = last ? [[-w0, 0.03], [w0, 0.03], [w1, -len + 0.03], [0, -len + 0.03 + w1 * 1.1], [-w1, -len + 0.03]] : [[-w0, 0.03], [w0, 0.03], [w1, -len + 0.03], [-w1, -len + 0.03]];
          b.at('sf' + side + (i + 1)).pd(gPlate('pl/sc' + i, pts, 0.008, 0.004), SF.c, SF.ci, SF.kx + s * SF.x, y, SF.z, 0, 0, 0);
          y -= SF.len[i];
        }
      }
      // --- 头：束发 ---
      hairHead(b);
      // --- 手臂：细一圈的布袖、皮护腕、手套 ---
      const arm = (s, U, F, H) => {
        b.at(U).surf(SURF.cloth).limb(CLOTH, s * 0.33, 1.5, 0, s * 0.38, 1.19, -0.01, 0.09, 0.075, 7, 3);
        b.at(F).surf(SURF.leather).limb([LEA_D, LEA], s * 0.38, 1.19, -0.01, s * 0.39, 0.93, 0.02, 0.085, 0.07, 7, 0);
        b.p(gCyl(0.08, 0.084, 0.09, 8), [0x3a302c, STRAP], s * 0.387, 1.04, 0.005);
        b.at(H).surf(SURF.leather).p(gSph(0.082, 8, 6), [DARK, 0x2a2d3a], s * 0.39, 0.86, 0.035, 0, 0, 0, 0.92, 1.12, 1.08);
      };
      arm(1, 'uaL', 'faL', 'hL');
      arm(-1, 'uaR', 'faR', 'hR');
      // 左手掌心的余烬
      b.at('hL').g(gOct(0.05), 1, 0.39, 0.75, 0.08, 0, 0.6, 0, 1, 1.5, 1);
      // --- 腿：贴身长裤、小皮护膝、软皮高靴 + 绑腿 ---
      const leg = (s, TH, SH, FT) => {
        b.at(TH).surf(SURF.cloth).limb(CLOTH, s * 0.14, 0.97, 0, s * 0.15, 0.53, 0.01, 0.12, 0.094, 7, 2);
        b.surf(SURF.leather).p(gDome(0.085, 6, 2, 1.3), LEA, s * 0.15, 0.55, 0.065, HALF_PI - 0.2, 0, 0, 1, 0.9, 1.1);
        if (s < 0) b.p(gTorus(0.108, 0.013, 3, 8), STRAP, s * 0.145, 0.8, 0, HALF_PI, 0, 0, 1, 1, 1);
        b.at(SH).surf(SURF.leather).p(gLathe('pl/boot', [[0.078, 0.1], [0.082, 0.26], [0.092, 0.42], [0.098, 0.5]], 8), BOOT, s * 0.15, 0, 0.012);
        b.p(gTorus(0.088, 0.013, 3, 8), STRAP, s * 0.15, 0.3, 0.012, HALF_PI, 0, 0, 1, 1, 1).p(gTorus(0.094, 0.013, 3, 8), STRAP, s * 0.15, 0.4, 0.012, HALF_PI, 0, 0, 1, 1, 1);
        b.at(FT).surf(SURF.leather).p(gSph(0.096, 8, 6), BOOT, s * 0.15, 0.07, 0.07, 0, 0, 0, 0.92, 0.72, 1.78);
        b.p(gCyl(0.088, 0.096, 0.1, 7), BOOT[0], s * 0.15, 0.14, 0);
      };
      leg(1, 'thL', 'shL', 'ftL');
      leg(-1, 'thR', 'shR', 'ftR');

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

      // 双匕：短而带钩的叶形刃（单侧开刃、刃尖斜削），黑钢底色，刃脊一道光；护手只有向前弯的一侧
      const dagger = (J, X) => {
        b.at(J).surf(SURF.leather).p(gCyl(0.022, 0.025, 0.13, 6), 0x2a2230, X, WY, 0.03, HALF_PI);
        b.surf(SURF.metal).p(gTorus(0.026, 0.009, 4, 8), STEEL_D, X, WY, -0.055);
        b.surf(SURF.gold).p(gSweep('pl/dguard', [[0, 0.075, 0.13], [0, 0.04, 0.1], [0, -0.03, 0.098], [0, -0.07, 0.11]], [0.008, 0.016, 0.016, 0.006], 5), GOLD, X, WY, 0);
        b.surf(SURF.metal).p(gPlate('pl/dblade', [[-0.034, 0], [0.03, 0], [0.042, 0.19], [0.014, 0.37], [-0.03, 0.27], [-0.038, 0.12]], 0.01, 0.012), [0x3b4252, 0xb4bccb], X, WY, 0.11, HALF_PI, HALF_PI, 0);
        b.x(gBox(0.03, 0.01, 0.2), 1, X, WY + 0.004, 0.24);
      };
      dagger('wD', WX);
      dagger('wDL', -WX);
      // 战锤：长柄两段缠皮、金箍；锤头是一块厚重的方砧，两端包钢、顶上一根短刺，两侧开一道发光的符槽
      b.at('wH').surf(SURF.leather).p(gCyl(0.03, 0.034, 1.3, 7), [0x3b2a1e, WOOD], WX, WY, 0.31, HALF_PI);
      b.p(gCyl(0.039, 0.039, 0.2, 7), 0x2c211a, WX, WY, 0.03, HALF_PI).p(gCyl(0.039, 0.039, 0.16, 7), 0x2c211a, WX, WY, -0.22, HALF_PI);
      b.surf(SURF.gold).p(gCyl(0.043, 0.043, 0.03, 7), GOLD, WX, WY, 0.16, HALF_PI).p(gCyl(0.043, 0.043, 0.03, 7), GOLD, WX, WY, 0.72, HALF_PI);
      b.p(gOct(0.05), GOLD, WX, WY, -0.37, HALF_PI, 0, 0, 1, 1.3, 1);
      b.surf(SURF.metal, true).p(gRBox(0.21, 0.4, 0.26, 0.035), [STEEL_D, STEEL], WX, WY, 0.98);
      b.p(gCyl(0.125, 0.135, 0.07, 8), STEEL, WX, WY + 0.225, 0.98).p(gCyl(0.135, 0.125, 0.07, 8), STEEL, WX, WY - 0.225, 0.98);
      b.p(gCone(0.055, 0.2, 5), STEEL, WX, WY, 1.2, HALF_PI);
      b.surf(SURF.gold).p(gBox(0.225, 0.03, 0.27), GOLD, WX, WY + 0.15, 0.98).p(gBox(0.225, 0.03, 0.27), GOLD, WX, WY - 0.15, 0.98);
      b.x(gBox(0.218, 0.2, 0.034), 1, WX, WY, 0.98);
      // 太刀：长柄缠着菱形绳结，方圆的铁镡镶金边，刃身细长、向刃背一侧微弯，刃口一道刃纹光
      b.at('wK').surf(SURF.cloth).p(gCyl(0.026, 0.028, 0.3, 6), 0x1e1a22, WX, WY, -0.04, HALF_PI);
      for (const zz of [-0.15, -0.08, -0.01, 0.06]) b.p(gOct(0.028), 0x7a2e24, WX, WY + 0.024, zz, 0, 0, 0, 1, 0.5, 1).p(gOct(0.028), 0x7a2e24, WX, WY - 0.024, zz, 0, 0, 0, 1, 0.5, 1);
      b.surf(SURF.gold).p(gCyl(0.031, 0.031, 0.03, 6), GOLD, WX, WY, -0.2, HALF_PI);
      b.surf(SURF.metal).p(gCyl(0.08, 0.08, 0.02, 8), 0x2a2a30, WX, WY, 0.12, HALF_PI, Math.PI / 8, 0);
      b.surf(SURF.gold).p(gTorus(0.079, 0.008, 4, 8), GOLD, WX, WY, 0.12, 0, 0, Math.PI / 8).p(gBox(0.022, 0.06, 0.03), GOLD, WX, WY, 0.145);
      {
        const L = 0.98, K = 0.055, n = 7, pts = [], edge = [];
        const cx = (t) => K * t * t, wd = (t) => 0.033 - 0.01 * t;
        pts.push([-0.033, 0], [0.033, 0]);
        for (let i = 1; i <= n; i++) {
          const t = (i / n) * 0.9;
          pts.push([cx(t) + wd(t), L * t]);
        }
        pts.push([cx(1) + 0.012, L]);
        for (let i = n; i >= 1; i--) {
          const t = (i / n) * 0.9;
          pts.push([cx(t) - wd(t) + (t > 0.85 ? 0.01 : 0), L * t]);
          edge.unshift([0, cx(t) - wd(t) * 0.55, 0.15 + L * t]);
        }
        edge.unshift([0, -0.018, 0.16]);
        b.surf(SURF.metal).p(gPlate('pl/katana', pts, 0.012, 0.007), [0x8d96a6, 0xe6ebf2], WX, WY, 0.15, HALF_PI, HALF_PI, 0);
        b.x(gSweep('pl/hamon', edge, [0.008, 0.009, 0.009, 0.006], 4), 1, WX, WY, 0);
      }
      // 长弓：两片弓臂沿 ±z 弯成一张弓，弓背朝手心外（-y），弓弦在 +y 一侧；握把缠皮、两端金箍，弓臂上各一道光纹
      {
        const LX = -WX, GZ = BOW_GZ, tx = BOW_TIP[0] - LX, ty = BOW_TIP[1] - WY, tz = BOW_TIP[2] - GZ;
        const limb = (s) => [[0, 0, s * 0.08], [tx * 0.1, -0.035, s * 0.3], [tx * 0.35, -0.012, s * 0.5], [tx * 0.7, ty * 0.45, s * 0.63], [tx, ty, s * tz]];
        // 鹰眼长弓（旧存档里的长弓都是它）：弓身是变体零件，弓弦留在本体上，四张弓共用
        b.variant('eagle').at('wBo').surf(SURF.leather);
        b.p(gSweep('pl/bowU', limb(1), [0.03, 0.026, 0.02, 0.014, 0.009], 6), [0x3a2618, 0x7a5236], LX, WY, GZ);
        b.p(gSweep('pl/bowL', limb(-1), [0.03, 0.026, 0.02, 0.014, 0.009], 6), [0x3a2618, 0x7a5236], LX, WY, GZ);
        b.p(gCyl(0.036, 0.036, 0.17, 7), 0x2c211a, LX, WY, GZ, HALF_PI);
        b.surf(SURF.gold).p(gCyl(0.04, 0.04, 0.025, 7), GOLD, LX, WY, GZ + 0.095, HALF_PI).p(gCyl(0.04, 0.04, 0.025, 7), GOLD, LX, WY, GZ - 0.095, HALF_PI);
        b.p(gOct(0.022), GOLD, BOW_TIP[0], BOW_TIP[1], BOW_TIP[2]).p(gOct(0.022), GOLD, BOW_TIP[0], BOW_TIP[1], 2 * GZ - BOW_TIP[2]);
        b.x(gBox(0.018, 0.018, 0.17), 1, LX + tx * 0.2, WY - 0.05, GZ + 0.33, -0.08).x(gBox(0.018, 0.018, 0.17), 1, LX + tx * 0.2, WY - 0.05, GZ - 0.33, 0.08);
        // 鹰眼：握把上方一根白羽饰（长弓的远射意味）
        b.surf(SURF.cloth).p(gPlate('pl/eaglefe', [[0, 0], [0.03, 0.03], [0.028, 0.15], [0, 0.17], [-0.012, 0.08]], 0.006, 0.003), 0xe8e0cc, LX + 0.02, WY - 0.06, GZ + 0.13, HALF_PI + 0.3, 0, 0.2);
        rangedBows(b, LX, WY, GZ, tx, ty, tz, GOLD);
        b.variant(null);
        const half = BOW_TIP[2] - GZ;
        b.at('bsU').surf(SURF.cloth).p(gCyl(0.005, 0.005, half, 4), 0xe8e0c8, BOW_TIP[0], BOW_TIP[1], BOW_TIP[2] - half / 2, HALF_PI);
        b.at('bsL').p(gCyl(0.005, 0.005, half, 4), 0xe8e0c8, BOW_TIP[0], BOW_TIP[1], 2 * GZ - BOW_TIP[2] + half / 2, HALF_PI);
      }
      // 箭：箭尾在右手里，沿 +z 指出去；箭镞随稀有度发光
      b.at('wA').surf(SURF.leather).p(gCyl(0.009, 0.009, 0.86, 4), 0x8a6a48, WX, WY, 0.43, HALF_PI);
      b.surf(SURF.cloth).p(gPlate('pl/fletch', [[0, 0], [0.035, 0.02], [0.03, 0.13], [0, 0.12]], 0.004, 0.002), 0xd8cfb8, WX, WY, 0.0, HALF_PI, 0, 0);
      b.p(gPlate('pl/fletch', [[0, 0], [0.035, 0.02], [0.03, 0.13], [0, 0.12]], 0.004, 0.002), 0xd8cfb8, WX, WY, 0.0, HALF_PI, 0, Math.PI);
      b.x(gCone(0.022, 0.09, 4), 1, WX, WY, 0.9, HALF_PI);

      // 魂幡：一根比人还高的乌木杆，骨环缠绳，杆尾一枚铁钎；杆头三根骨爪托着一团魂火（随稀有度发光）；
      // 杆顶往外横挑一根短杆，挑着一面撕破的暗紫幡布（上下两段，摆锤驱动），幡面一道发光的符印，
      // 挑杆外端和杆的另一侧各坠一串骨珠和一枚小骷髅
      {
        const BX = WX - BAN_X, CL = 0x2e2436, CL2 = 0x262030, CI = 0x16121b, TRIM = 0xcdbf9f, EBON = 0x2a201b;
        b.at('wBn').surf(SURF.leather).p(gCyl(0.024, 0.03, 2.32, 6), EBON, WX, WY, 0.6, HALF_PI);
        b.p(gCyl(0.034, 0.034, 0.22, 6), 0x3a2a20, WX, WY, 0.03, HALF_PI);
        b.surf(SURF.gold).p(gCyl(0.038, 0.038, 0.025, 6), GOLD, WX, WY, 0.155, HALF_PI).p(gCyl(0.038, 0.038, 0.025, 6), GOLD, WX, WY, -0.095, HALF_PI);
        b.surf(SURF.metal).p(gCone(0.03, 0.16, 5), STEEL_D, WX, WY, -0.62, -HALF_PI);
        b.surf(SURF.bone);
        for (const zz of [0.62, 0.95, 1.3]) b.p(gTorus(0.033, 0.011, 4, 8), BONE, WX, WY, zz).p(gTorus(0.033, 0.011, 4, 8), BONE, WX, WY, zz + 0.035);
        // 杆头：金箍 + 三根骨爪 + 魂火
        b.surf(SURF.gold).p(gCyl(0.03, 0.046, 0.07, 6), GOLD, WX, WY, 1.74, HALF_PI);
        b.surf(SURF.bone);
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + 0.5, cx = Math.cos(a), sy = Math.sin(a);
          b.p(gSweep('pl/bnprong' + k, [[cx * 0.03, sy * 0.03, 1.76], [cx * 0.1, sy * 0.1, 1.86], [cx * 0.075, sy * 0.075, 1.97], [cx * 0.02, sy * 0.02, 2.03]], [0.02, 0.017, 0.012, 0.003], 4), BONE, WX, WY, 0);
        }
        b.x(gOct(0.075), 1, WX, WY, 1.89, 0, 0, 0, 0.9, 0.9, 1.35);
        // 挑杆（往外横出）+ 斜撑 + 外端金帽；杆另一侧一截短挑头
        b.surf(SURF.leather).p(gCyl(0.016, 0.019, 0.52, 5), EBON, WX - 0.25, WY, BAN_Z, 0, 0, HALF_PI);
        b.p(gSweep('pl/bnbrace', [[0, 0, BAN_Z - 0.24], [-0.07, 0, BAN_Z - 0.12], [-0.2, 0, BAN_Z - 0.015]], [0.012, 0.011, 0.01], 4), EBON, WX, WY, 0);
        b.p(gCyl(0.014, 0.016, 0.18, 5), EBON, WX + 0.08, WY, BAN_Z - 0.1, 0, 0, HALF_PI);
        b.surf(SURF.gold).p(gOct(0.028), GOLD, WX - 0.51, WY, BAN_Z).p(gOct(0.022), GOLD, WX + 0.175, WY, BAN_Z - 0.1);
        // 幡布上段：顶边金条，下沿一道骨白布边，幡面的符印（一圈环 + 一竖两横）两面都发光
        b.at('bnF1').surf(SURF.cloth);
        b.pd(gPlate('pl/bnc1', [[-0.18, 0], [-0.185, -0.22], [-0.175, -BAN_L1 - 0.01], [0.175, -BAN_L1 - 0.01], [0.17, -0.25], [0.18, 0]], 0.008, 0.003), CL, CI, BX, WY, BAN_Z - 0.02, HALF_PI);
        b.surf(SURF.gold).p(gBox(0.39, 0.026, 0.035), GOLD, BX, WY, BAN_Z - 0.015);
        b.surf(SURF.cloth).p(gBox(0.36, 0.02, 0.045), TRIM, BX, WY, BAN_Z - 0.4);
        b.x(gTorus(0.08, 0.008, 4, 14), 1, BX, WY, BAN_Z - 0.2, HALF_PI);
        b.x(gBox(0.014, 0.022, 0.32), 1, BX, WY, BAN_Z - 0.21);
        b.x(gBox(0.15, 0.022, 0.014), 1, BX, WY, BAN_Z - 0.12).x(gBox(0.1, 0.022, 0.014), 1, BX, WY, BAN_Z - 0.3);
        // 幡布下段：撕成长短不一的几条
        b.at('bnF2').surf(SURF.cloth);
        b.pd(gPlate('pl/bnc2', [[-0.175, 0.01], [-0.17, -0.28], [-0.15, -0.44], [-0.1, -0.31], [-0.045, -0.5], [0.015, -0.34], [0.07, -0.47], [0.12, -0.3], [0.165, -0.4], [0.175, 0.01]], 0.008, 0.003), CL2, CI, BX, WY, BAN_Z - BAN_L1, HALF_PI);
        // 骨符：一根细绳，两颗骨珠，一枚小骷髅（眼窝里一点余烬）
        const charm = (J, x, z) => {
          b.at(J).surf(SURF.cloth).p(gCyl(0.004, 0.004, 0.17, 3), 0x6a5a48, x, WY, z - 0.085, HALF_PI);
          b.surf(SURF.bone).p(gOct(0.02), BONE, x, WY, z - 0.12, 0, 0, 0, 1, 1, 1.5).p(gOct(0.016), BONE, x, WY, z - 0.165, 0, 0, 0, 1, 1, 1.4);
          b.p(gSph(0.038, 6, 5), BONE, x, WY, z - BAN_CL + 0.02, 0, 0, 0, 1, 0.95, 1.1);
          b.p(gBox(0.042, 0.03, 0.03), BONE, x, WY - 0.006, z - BAN_CL - 0.02);
          b.g(gOct(0.011), 1, x - 0.014, WY - 0.034, z - BAN_CL + 0.012).g(gOct(0.011), 1, x + 0.014, WY - 0.034, z - BAN_CL + 0.012);
        };
        charm('bnC1', WX - 0.48, BAN_Z);
        charm('bnC2', WX + 0.15, BAN_Z - 0.1);
      }
      // 三把火器（变体零件，挂 wF / wGb）
      rangedGuns(b, WX, WY, GOLD, STEEL, STEEL_D);
      b.variant(null);

      const rig = b.build({ height: 1.95, reach: 2.2, stride: 2.35, shade: 0.28 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.ftL, rig.JI.ftR];
      rig.ankle = 0.12;
      sock(rig, 'weapon', 'wB', 0, 0, 1.0);
      sock(rig, 'hand', 'hR', 0, -0.06, 0.02);
      sock(rig, 'handL', 'hL', 0, -0.1, 0.05);
      sock(rig, 'head', 'head', 0, 0.16, 0);
      sock(rig, 'chest', 'chest', 0, 0.12, 0.1);
      cApply(rig, cs);
      rig.loco = playerLoco;
      rig.post = playerPost;
      rig.late = playerLate;
      rig.gearJ = GEAR_JOINT.map((n) => rig.J[n]);
      // 手臂两节的绑定数据（双手武器的左手 / 动作里给定手的位置时用解析 IK 求肩肘角度）
      const pv = (n) => rig.joints[rig.JI[n]];
      const armData = (ua, fa, h, w) => {
        const a = pv(ua), f = pv(fa), c = pv(h), wj = pv(w);
        const U = [f.px - a.px, f.py - a.py, f.pz - a.pz], F = [c.px - f.px, c.py - f.py, c.pz - f.pz];
        // 握点（武器握把所在处）相对手腕枢轴的偏移：程序化骨架里握把在 (±0.39, 0.84, 0.03)；换成 C 模型后武器跟着手腕平移，
        // 再按配置挪一点对准拳心（武器关节比手腕多出来的那段位移）
        const ex = (k) => (wj[k] - (wj[k + '0'] === undefined ? wj[k] : wj[k + '0'])) - (c[k] - (c[k + '0'] === undefined ? c[k] : c[k + '0']));
        const c0 = (k) => (c[k + '0'] === undefined ? c[k] : c[k + '0']);
        const A = {
          ua: rig.J[ua], fa: rig.J[fa], h: rig.J[h], uaI: rig.JI[ua], faI: rig.JI[fa], hI: rig.JI[h], par: a.parent, U, F,
          grip: [ex('px'), 0.84 - c0('py') + ex('py'), 0.03 - c0('pz') + ex('pz')],
          k: 1,
        };
        if (rig.skin4) {
          // C 模型的手臂比程序化的短 / 肩窄：动作里给的手的位置按「离肩多远」等比换算（rm：胸口坐标系 / 模型空间里新旧肩位）
          const ch = pv('chest'), len = (P) => Math.hypot(P[0], P[1], P[2]);
          const U0 = [f.px0 - a.px0, f.py0 - a.py0, f.pz0 - a.pz0], F0 = [c.px0 - f.px0, c.py0 - f.py0, c.pz0 - f.pz0];
          A.k = (len(U) + len(F)) / (len(U0) + len(F0));
          A.rm = {
            c0: [a.px0 - ch.px0, a.py0 - ch.py0, a.pz0 - ch.pz0], c1: [a.px - ch.px, a.py - ch.py, a.pz - ch.pz],
            m0: [a.px0, a.py0, a.pz0], m1: [a.px, a.py, a.pz],
          };
        }
        return A;
      };
      rig.armR = armData('uaR', 'faR', 'hR', 'wB');
      rig.armL = armData('uaL', 'faL', 'hL', 'wBo');
      playerClips(rig);
      weaponClips(rig);
      rangedClips(rig);
      return rig;
    }));
  }

  // 站立呼吸 + 跑动步态。步态相位来自实际走过的距离，脚不会在地上打滑
  function playerLoco(ent, p, t, sdt) {
    const J = ent.rig.J, mv = ent.mv, w = ent.walk;
    const s = Math.sin(w), c = Math.cos(w), id = 1 - mv;
    const run = Math.min(1.25, ent.spd / 7.2) * mv; // 0 = 站着，1 = 全速跑
    const br = Math.sin(t * 1.9), br2 = Math.sin(t * 0.95 + 1);
    const gear = ent.gearType;
    // 移动方向和朝向不一致时，胯转向移动方向，上身拧回来。拧的幅度封顶（±HIP_MAX），
    // 侧着走时腿脚不会歪着拧过去；正走 / 倒退之间的切换用 backK 平滑过渡，不在一帧里翻转
    ent.backK = (ent.backK || 0) + ((ent.back ? 1 : 0) - (ent.backK || 0)) * Math.min(1, (sdt || 0) * 8);
    const fwd = ent.mdir, bwd = ent.mdir - Math.sign(ent.mdir || 1) * Math.PI;
    const HIP_MAX = 0.5, clampHip = (v) => Math.max(-HIP_MAX, Math.min(HIP_MAX, v * 0.6));
    let md = (clampHip(fwd) + (clampHip(bwd) - clampHip(fwd)) * ent.backK) * mv;

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
    if (gear === 1 || gear === G_BAN) {
      // 长杖 / 魂幡：竖着拄在身侧
      p[J.uaR] = (-0.3 * s - 0.25) * run - 0.3 * id;
      p[J.faR] = -0.9 * run - 0.75 * id;
      p[J.hR] = -0.75 + 0.2 * run;
      p[J.hR + 2] = 0.12;
    } else if (gear === 2) {
      // 短杖：小臂抬起，杖尖朝前上方
      p[J.faR] = -1.0 * run - 0.95 * id;
      p[J.hR] = -0.2;
    } else if (gear === G_DAG) {
      // 双匕：两手各握一把，小臂抬起护在身前，刃尖朝前；跑起来两臂交替前后摆
      p[J.uaR] = (-0.5 * s - 0.15) * run - 0.22 * id;
      p[J.uaR + 2] = -0.18 - 0.04 * run;
      p[J.faR] = -1.05 * run - 1.1 * id;
      p[J.hR] = 0.6 - 0.1 * run;
      p[J.hR + 1] = 0.25;
      p[J.uaL] = (0.5 * s - 0.15) * run - 0.22 * id;
      p[J.uaL + 2] = 0.18 + 0.04 * run;
      p[J.faL] = -1.05 * run - 1.1 * id;
      p[J.hL] = 0.6 - 0.1 * run;
      p[J.hL + 1] = -0.25;
    } else if (gear === G_BOW) {
      // 长弓：左手提弓垂在身侧，弓身竖直、上梢略向前倾，弓弦朝后；右手空着自然摆动
      p[J.uaR] = -0.75 * s * run + 0.06 * id;
      p[J.uaR + 2] = -0.12 - 0.05 * run - br * 0.012 * id;
      p[J.faR] = -(0.85 - 0.25 * s) * run - 0.3 * id;
      p[J.uaL] = 0.4 * s * run + 0.02 * id;
      p[J.uaL + 2] = 0.24 + 0.04 * run;
      p[J.faL] = -0.45 * run - 0.35 * id;
      p[J.hL] = -1.3 - p[J.uaL] - p[J.faL];
      p[J.hL + 1] = 0;
      p[J.hL + 2] = 0.1;
    } else if (gear === G_HAM || gear === G_KAT || gear >= G_GAT) {
      // 双手武器 / 火器：右手的位置由 IK 按 LOCO_2H 摆（见 playerLate）；这里只给一个相近的起点
      p[J.faR] = -1.0 * run - 1.1 * id;
      p[J.hR] = 0.4;
      if (gear === G_GAT || gear === G_FLM) {
        // 端着机炮 / 喷枪：上身往右拧，枪口朝正前方
        p[J.spine + 1] += GUN_TWIST * 0.5;
        p[J.chest + 1] += GUN_TWIST * 0.5;
        p[J.head + 1] -= GUN_TWIST * 0.8;
      }
    } else {
      // 刃：刃尖斜指前下方
      p[J.hR] = 0.5 - 0.25 * run;
      p[J.hR + 1] = 0.25;
      p[J.hR + 2] = -0.2 * id;
    }

    // 短前襟：跑起来向后扬，叠一层飘动（围巾和马尾在 tailSprings 里另算）
    p[J.tab] = -0.04 - 0.38 * run * Math.max(Math.abs(s), 0.4) + Math.sin(t * 2.3 + ent.phase) * 0.03;
  }
  // 每帧都要设的东西：只显示当前装备的那把武器，掌心余烬脉动
  function playerPost(ent, o, t, sdt) {
    const J = ent.rig.J, g = ent.gearType, gj = ent.rig.gearJ, gw = g >= 0 ? gj[g] : -1;
    for (let i = 0; i < gj.length; i++) o[gj[i] + 6] = o[gj[i] + 7] = o[gj[i] + 8] = gj[i] === gw ? GEAR_K : 0;
    gunSpinPost(ent, o, sdt || 0);
    o[J.wDL + 6] = o[J.wDL + 7] = o[J.wDL + 8] = g === G_DAG ? GEAR_K : 0;
    const c = ent.clip, a = g === G_BOW && c && c.arrow ? o[J.wA + 6] : 0;
    o[J.wA + 6] = o[J.wA + 7] = o[J.wA + 8] = a;
    setGlow(ent, 1 + Math.sin(t * 5) * 0.12);
  }

  // ----- 手臂 IK：双手武器的左手握在柄上；动作里也可以直接给出手（武器）在胸口坐标系里的位置与朝向 -----
  // 都在模型空间里算（角色自身的坐标系，面朝 +z），结果按权重混进姿态的欧拉角，最后重算一遍骨骼
  const _R = new Float32Array(9), _Rc = new Float32Array(9), _Ru = new Float32Array(9), _Rf = new Float32Array(9), _Rh = new Float32Array(9);
  const _eu = new Float32Array(3), _hk = new Float32Array(9), _hm = new Float32Array(9);
  // 模型矩阵里关节 j 的旋转（按列去掉缩放）
  function rotOf(M, j, out) {
    const m = j * 12;
    for (let c = 0; c < 3; c++) {
      const x = M[m + c], y = M[m + 4 + c], z = M[m + 8 + c], l = Math.hypot(x, y, z) || 1;
      out[c] = x / l;
      out[3 + c] = y / l;
      out[6 + c] = z / l;
    }
  }
  // out = Aᵀ · B（行主序 3×3）
  function mulTN(A, B, out) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r] * B[c] + A[3 + r] * B[3 + c] + A[6 + r] * B[6 + c];
  }
  // 与 solveRig 一致的 XYZ 欧拉角分解
  function eulerOf(R, out) {
    const s = R[2] > 1 ? 1 : R[2] < -1 ? -1 : R[2];
    out[1] = Math.asin(s);
    if (Math.abs(s) < 0.9999) {
      out[0] = Math.atan2(-R[5], R[8]);
      out[2] = Math.atan2(-R[1], R[0]);
    } else {
      out[0] = Math.atan2(R[7], R[4]);
      out[2] = 0;
    }
  }
  function blendRot(o, i, e, w) {
    for (let k = 0; k < 3; k++) {
      let d = e[k] - o[i + k];
      d -= Math.round(d / TAU) * TAU;
      o[i + k] += d * w;
    }
  }
  // 由「指向 d、刃口朝 e」搭出手的旋转（列 = 手的 x / y / z 轴在模型空间里的方向；刃口 = 手的 -y）
  function handFrame(dx, dy, dz, ex, ey, ez, out) {
    let l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    let k = ex * dx + ey * dy + ez * dz;
    let yx = -(ex - k * dx), yy = -(ey - k * dy), yz = -(ez - k * dz);
    l = Math.hypot(yx, yy, yz);
    if (l < 1e-3) {
      // 刃口方向和指向重合：退回「刃口朝下 / 朝前」
      ex = Math.abs(dy) < 0.9 ? 0 : 0; ey = Math.abs(dy) < 0.9 ? -1 : 0; ez = Math.abs(dy) < 0.9 ? 0 : 1;
      k = ex * dx + ey * dy + ez * dz;
      yx = -(ex - k * dx); yy = -(ey - k * dy); yz = -(ez - k * dz);
      l = Math.hypot(yx, yy, yz) || 1;
    }
    yx /= l; yy /= l; yz /= l;
    out[0] = yy * dz - yz * dy; out[3] = yz * dx - yx * dz; out[6] = yx * dy - yy * dx;
    out[1] = yx; out[4] = yy; out[7] = yz;
    out[2] = dx; out[5] = dy; out[8] = dz;
  }
  // 把手腕送到 (wx,wy,wz)，肘尖朝 (px,py,pz)；Rh 给定时顺便把手转到这个朝向
  function solveArm(ent, A, wx, wy, wz, px, py, pz, w, Rh) {
    const M = ent.mdl, o = ent.out, m = A.uaI * 12, U = A.U, F = A.F;
    let dx = wx - M[m + 3], dy = wy - M[m + 7], dz = wz - M[m + 11];
    const d = Math.hypot(dx, dy, dz) || 1e-4;
    dx /= d; dy /= d; dz /= d;
    // 肘角 r：|U + Rx(r)·F| = d（只绕小臂的 x 轴弯，往前弯为负）
    const uu = U[0] * U[0] + U[1] * U[1] + U[2] * U[2], ff = F[0] * F[0] + F[1] * F[1] + F[2] * F[2];
    const Ac = U[1] * F[1] + U[2] * F[2], Bs = U[2] * F[1] - U[1] * F[2];
    const cc = ((d * d - uu - ff) / 2 - U[0] * F[0]) / (Math.hypot(Ac, Bs) || 1e-6);
    const ph = Math.atan2(Bs, Ac), ac = Math.acos(cc > 1 ? 1 : cc < -1 ? -1 : cc);
    let r1 = ph - ac, r2 = ph + ac;
    r1 -= Math.round(r1 / TAU) * TAU;
    r2 -= Math.round(r2 / TAU) * TAU;
    // 两个解里挑落在 [-2.6, 0]（往前弯）的那个；都不在就挑离这个区间近的，再夹进去
    const o1 = r1 > 0 ? r1 : r1 < -2.6 ? -2.6 - r1 : 0, o2 = r2 > 0 ? r2 : r2 < -2.6 ? -2.6 - r2 : 0;
    let r = o1 <= o2 ? r1 : r2;
    r = r < -2.6 ? -2.6 : r > 0 ? 0 : r;
    const cr = Math.cos(r), sr = Math.sin(r);
    // 上臂局部：肩→腕 a、肘的偏移 b；模型空间：肩→目标 a'、朝向肘尖提示 b'
    let ax = U[0] + F[0], ay = U[1] + F[1] * cr - F[2] * sr, az = U[2] + F[1] * sr + F[2] * cr;
    let l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
    let k = U[0] * ax + U[1] * ay + U[2] * az;
    let bx = U[0] - k * ax, by = U[1] - k * ay, bz = U[2] - k * az;
    l = Math.hypot(bx, by, bz) || 1;
    bx /= l; by /= l; bz /= l;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    k = px * dx + py * dy + pz * dz;
    let qx = px - k * dx, qy = py - k * dy, qz = pz - k * dz;
    l = Math.hypot(qx, qy, qz);
    if (l < 1e-4) { qx = 0; qy = -1; qz = 0; l = 1; }
    qx /= l; qy /= l; qz /= l;
    const sx = dy * qz - dz * qy, sy = dz * qx - dx * qz, sz = dx * qy - dy * qx;
    // Ru = [a' b' c']·[a b c]ᵀ
    _Ru[0] = dx * ax + qx * bx + sx * cx; _Ru[1] = dx * ay + qx * by + sx * cy; _Ru[2] = dx * az + qx * bz + sx * cz;
    _Ru[3] = dy * ax + qy * bx + sy * cx; _Ru[4] = dy * ay + qy * by + sy * cy; _Ru[5] = dy * az + qy * bz + sy * cz;
    _Ru[6] = dz * ax + qz * bx + sz * cx; _Ru[7] = dz * ay + qz * by + sz * cy; _Ru[8] = dz * az + qz * bz + sz * cz;
    rotOf(M, A.par, _Rc);
    mulTN(_Rc, _Ru, _R);
    eulerOf(_R, _eu);
    blendRot(o, A.ua, _eu, w);
    o[A.fa] += (r - o[A.fa]) * w;
    o[A.fa + 1] *= 1 - w;
    o[A.fa + 2] *= 1 - w;
    if (Rh) {
      // 小臂的模型旋转 = Ru · Rx(r)；手的局部旋转 = 小臂ᵀ · Rh
      for (let i = 0; i < 3; i++) {
        _Rf[i * 3] = _Ru[i * 3];
        _Rf[i * 3 + 1] = _Ru[i * 3 + 1] * cr + _Ru[i * 3 + 2] * sr;
        _Rf[i * 3 + 2] = -_Ru[i * 3 + 1] * sr + _Ru[i * 3 + 2] * cr;
      }
      mulTN(_Rf, Rh, _R);
      eulerOf(_R, _eu);
      blendRot(o, A.h, _eu, w);
    }
  }
  // 手的轨迹（动作里的 hand / handL）在 k 时刻的值：位置 3 + 指向 3 + 刃口 3
  function evalHand(H, k, out) {
    for (let i = 0; i < 9; i++) out[i] = kf(H.K[i], k);
  }
  // 把轨迹值从它的坐标系（chest 胸口 / model 模型空间）换到模型空间
  function handToModel(ent, frame, src, out) {
    if (frame === 'model') {
      out.set(src);
      return;
    }
    const M = ent.mdl, j = ent.rig.JI[frame] * 12;
    rotOf(M, ent.rig.JI[frame], _Rc);
    for (let v = 0; v < 3; v++) {
      const x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
      out[v * 3] = _Rc[0] * x + _Rc[1] * y + _Rc[2] * z + (v ? 0 : M[j + 3]);
      out[v * 3 + 1] = _Rc[3] * x + _Rc[4] * y + _Rc[5] * z + (v ? 0 : M[j + 7]);
      out[v * 3 + 2] = _Rc[6] * x + _Rc[7] * y + _Rc[8] * z + (v ? 0 : M[j + 11]);
    }
  }
  // C 模型的手臂和程序化的长短 / 肩宽不同：手的目标位置按「从肩出发的位移 × 臂长比」换算，方向不变
  function remapHand(A, frame, src) {
    const r = A.rm;
    if (!r) return;
    const a = frame === 'model' ? r.m0 : r.c0, b = frame === 'model' ? r.m1 : r.c1;
    for (let i = 0; i < 3; i++) src[i] = b[i] + (src[i] - a[i]) * A.k;
  }
  // 双手武器站立 / 跑动时右手的位置（胸口坐标系：位置、指向、刃口朝向）
  const LOCO_2H = {
    [G_HAM]: { idle: [-0.13, -0.42, 0.3, -0.55, -0.62, 0.55, 0, -1, 0], run: [-0.24, 0.04, 0.24, -0.12, 0.55, -0.82, 0, 0.2, 1] },
    [G_KAT]: { idle: [-0.06, -0.33, 0.32, 0.05, 0.42, 0.9, 0, -1, 0], run: [-0.3, -0.42, 0.04, -0.2, -0.38, -0.9, 0, -1, 0] },
    // 火器：机炮 / 喷枪端在右胯前、枪口斜指左前（上身往右拧，枪口正好朝前），跑起来枪口略抬；左轮单手垂在身侧、枪口朝前下
    ...GUN_LOCO,
  };
  // 左手在双手武器柄上能握的范围（沿柄的 z，绑定坐标）；右手握在 z≈0.03，两手之间至少留 gap
  const GRIP_2H = { [G_HAM]: [-0.31, 0.62, 0.15], [G_KAT]: [-0.17, -0.1, 0.12], [G_GAT]: [GUN_FORE.gatling, GUN_FORE.gatling, 0.1], [G_FLM]: [GUN_FORE.flamer, GUN_FORE.flamer, 0.1] };
  function ikPole(ent, x, y, z) {
    // 肘尖提示：胸口坐标系里的方向 → 模型空间
    const M = ent.mdl, j = ent.rig.JI.chest * 12;
    _hm[0] = M[j] * x + M[j + 1] * y + M[j + 2] * z;
    _hm[1] = M[j + 4] * x + M[j + 5] * y + M[j + 6] * z;
    _hm[2] = M[j + 8] * x + M[j + 9] * y + M[j + 10] * z;
  }
  // 由模型空间的（位置、指向、刃口）把手臂摆过去
  function armTo(ent, A, T, w, poleX) {
    handFrame(T[3], T[4], T[5], T[6], T[7], T[8], _Rh);
    const gp = A.grip;
    const wx = T[0] - (_Rh[0] * gp[0] + _Rh[1] * gp[1] + _Rh[2] * gp[2]);
    const wy = T[1] - (_Rh[3] * gp[0] + _Rh[4] * gp[1] + _Rh[5] * gp[2]);
    const wz = T[2] - (_Rh[6] * gp[0] + _Rh[7] * gp[1] + _Rh[8] * gp[2]);
    ikPole(ent, poleX, -1, -0.35);
    solveArm(ent, A, wx, wy, wz, _hm[0], _hm[1], _hm[2], w, _Rh);
  }
  const _ikT = new Float32Array(9);
  function playerIK(ent, sdt) {
    const rig = ent.rig, c = ent.clip, g = ent.gearType, M = ent.mdl;
    let ik = ent.ik;
    if (!ik) ik = ent.ik = { src: null, t: 1, dur: 0.1, from: new Float32Array(9), cur: new Float32Array(9), fw: 0, w: 0, lw: 0, last: null };
    let re = false;
    // ---- 右手：动作给的轨迹，或双手武器的站立 / 跑动姿势 ----
    let src = null, want = 0;
    if (c && c.hand) {
      src = c;
      evalHand(c.hand, ent.cK, _hk);
      remapHand(rig.armR, c.hand.f, _hk);
      handToModel(ent, c.hand.f, _hk, _ikT);
      want = c.hand.W ? kf(c.hand.W, ent.cK) : 1;
    } else if (!c && LOCO_2H[g]) {
      src = 'loco';
      const L = LOCO_2H[g], mv = ent.mv, br = Math.sin(ent.clock * 1.9) * 0.012 * (1 - mv);
      for (let i = 0; i < 9; i++) _hk[i] = L.idle[i] + (L.run[i] - L.idle[i]) * mv;
      _hk[1] += br;
      remapHand(rig.armR, 'chest', _hk);
      handToModel(ent, 'chest', _hk, _ikT);
      want = 1;
    }
    if (src !== ik.src) {
      // 换了来源：从上一帧实际用的目标平滑过渡过去
      ik.from.set(ik.cur);
      ik.fw = ik.w;
      ik.t = 0;
      ik.dur = Math.max(0.05, c ? c.fade : ik.last ? ik.last.out : 0.15);
      if (ik.src && typeof ik.src === 'object') ik.last = ik.src;
      ik.src = src;
    }
    ik.t += sdt;
    const s = smooth01(ik.t / ik.dur);
    if (src) {
      if (ik.fw < 0.01 || s >= 1) ik.cur.set(_ikT);
      else for (let i = 0; i < 9; i++) ik.cur[i] = ik.from[i] + (_ikT[i] - ik.from[i]) * s;
    }
    ik.w = ik.fw + (want - ik.fw) * s;
    if (ik.w > 0.002 && src) {
      armTo(ent, rig.armR, ik.cur, ik.w, -0.8);
      solveRig(ent);
      re = true;
    }
    // ---- 左手：动作给的轨迹优先；否则双手武器时握在柄上 ----
    if (c && c.handL) {
      evalHand(c.handL, ent.cK, _hk);
      remapHand(rig.armL, c.handL.f, _hk);
      handToModel(ent, c.handL.f, _hk, _ikT);
      const wl = c.handL.W ? kf(c.handL.W, ent.cK) : 1;
      ik.lw = wl;
      armTo(ent, rig.armL, _ikT, wl * (ent.fadeT < ent.fadeDur ? smooth01(ent.fadeT / ent.fadeDur) : 1), 0.8);
      solveRig(ent);
      re = true;
    } else {
      const tw = TWO_HAND[g] ? (c ? (c.hand ? (c.ikL === undefined ? 1 : c.ikL) : 0) : 1 - ent.mv) : 0;
      ik.lw += (tw - ik.lw) * Math.min(1, sdt * 14);
      if (ik.lw > 0.002 && TWO_HAND[g]) {
        // 柄上离左肩最近、又不和右手挤在一起的那一点
        const wj = rig.gearJ[g] / CH, m = wj * 12, gr = GRIP_2H[g];
        rotOf(M, wj, _Rh);
        const pj = rig.joints[wj];
        const ox = -0.39 - pj.px0, oy = 0.84 + (gr[3] || 0) - pj.py0, oz = -pj.pz0;
        const Ox = M[m] * ox + M[m + 1] * oy + M[m + 2] * oz + M[m + 3];
        const Oy = M[m + 4] * ox + M[m + 5] * oy + M[m + 6] * oz + M[m + 7];
        const Oz = M[m + 8] * ox + M[m + 9] * oy + M[m + 10] * oz + M[m + 11];
        const sm = rig.armL.uaI * 12;
        let zg = (M[sm + 3] - Ox) * _Rh[2] + (M[sm + 7] - Oy) * _Rh[5] + (M[sm + 11] - Oz) * _Rh[8];
        // 柄上的可握范围随武器缩放（GEAR_K）一起缩
        const g0 = gr[0] * GEAR_K, g1 = gr[1] * GEAR_K, g2 = gr[2] * GEAR_K, gc = 0.03 * GEAR_K;
        zg = zg < g0 ? g0 : zg > g1 ? g1 : zg;
        if (Math.abs(zg - gc) < g2) zg = zg < gc && gc - g2 >= g0 ? gc - g2 : gc + g2 <= g1 ? gc + g2 : gc - g2;
        _ikT[0] = Ox + _Rh[2] * zg; _ikT[1] = Oy + _Rh[5] * zg; _ikT[2] = Oz + _Rh[8] * zg;
        _ikT[3] = _Rh[2]; _ikT[4] = _Rh[5]; _ikT[5] = _Rh[8];
        _ikT[6] = -_Rh[1]; _ikT[7] = -_Rh[4]; _ikT[8] = -_Rh[7];
        // 够不着就慢慢松手（不把胳膊扯直了去够）
        const dd = Math.hypot(_ikT[0] - M[sm + 3], _ikT[1] - M[sm + 7], _ikT[2] - M[sm + 11]);
        const reach = 1 - smooth01((dd - 0.6 * rig.armL.k) / (0.22 * rig.armL.k));
        if (reach > 0.002) {
          armTo(ent, rig.armL, _ikT, ik.lw * reach, 0.8);
          solveRig(ent);
          re = true;
        }
      }
    }
    // ---- 长弓：弓弦两段转向搭箭点（拉弓时是右手），箭从右手指向弓把 ----
    if (g === G_BOW) {
      const J = rig.J, o = ent.out, dk = c && c.draw ? kf(c.draw, ent.cK) : 0;
      const bj = rig.JI.wBo, bm = bj * 12, bp = rig.joints[bj], hm = rig.JI.hR * 12, hp = rig.joints[rig.JI.hR];
      let nx = BOW_TIP[0], ny = BOW_TIP[1], nz = BOW_GZ;
      // 右手握点（模型空间）
      const gx = rig.armR.grip[0], gy = rig.armR.grip[1], gz = rig.armR.grip[2];
      const hx = M[hm] * gx + M[hm + 1] * gy + M[hm + 2] * gz + M[hm + 3];
      const hy = M[hm + 4] * gx + M[hm + 5] * gy + M[hm + 6] * gz + M[hm + 7];
      const hz = M[hm + 8] * gx + M[hm + 9] * gy + M[hm + 10] * gz + M[hm + 11];
      if (dk > 0.001) {
        rotOf(M, bj, _Rh);
        // 弓关节带着武器缩放（GEAR_K）：右手的位置换回弓的绑定坐标时除掉这一层
        const ks = o[J.wBo + 6] || 1, qx = (hx - M[bm + 3]) / ks, qy = (hy - M[bm + 7]) / ks, qz = (hz - M[bm + 11]) / ks;
        const lx = _Rh[0] * qx + _Rh[3] * qy + _Rh[6] * qz + bp.px0;
        const ly = _Rh[1] * qx + _Rh[4] * qy + _Rh[7] * qz + bp.py0;
        const lz = _Rh[2] * qx + _Rh[5] * qy + _Rh[8] * qz + bp.pz0;
        nx += (lx - nx) * dk;
        ny += (ly - ny) * dk;
        nz += (lz - nz) * dk;
      }
      const half = BOW_TIP[2] - BOW_GZ;
      let vx = nx - BOW_TIP[0], vy = ny - BOW_TIP[1], vz = nz - BOW_TIP[2], vl = Math.hypot(vx, vy, vz) || 1;
      o[J.bsU] = Math.atan2(vy, -vz);
      o[J.bsU + 1] = Math.asin(G.clamp(-vx / vl, -1, 1));
      o[J.bsU + 2] = 0;
      o[J.bsU + 8] = vl / half;
      vz = nz - (2 * BOW_GZ - BOW_TIP[2]);
      vl = Math.hypot(vx, vy, vz) || 1;
      o[J.bsL] = Math.atan2(-vy, vz);
      o[J.bsL + 1] = Math.asin(G.clamp(vx / vl, -1, 1));
      o[J.bsL + 2] = 0;
      o[J.bsL + 8] = vl / half;
      if (o[J.wA + 6] > 0) {
        // 箭：右手 → 弓把
        const ox = 0.39 - bp.px0, oy = 0.84 - bp.py0, oz = BOW_GZ - bp.pz0;
        const bx = M[bm] * ox + M[bm + 1] * oy + M[bm + 2] * oz + M[bm + 3];
        const by = M[bm + 4] * ox + M[bm + 5] * oy + M[bm + 6] * oz + M[bm + 7];
        const bz = M[bm + 8] * ox + M[bm + 9] * oy + M[bm + 10] * oz + M[bm + 11];
        rotOf(M, rig.JI.hR, _Rh);
        const qx = bx - hx, qy = by - hy, qz = bz - hz, ql = Math.hypot(qx, qy, qz) || 1;
        const lx = (_Rh[0] * qx + _Rh[3] * qy + _Rh[6] * qz) / ql;
        const ly = (_Rh[1] * qx + _Rh[4] * qy + _Rh[7] * qz) / ql;
        const lz = (_Rh[2] * qx + _Rh[5] * qy + _Rh[8] * qz) / ql;
        o[J.wA] = Math.atan2(-ly, lz);
        o[J.wA + 1] = Math.asin(G.clamp(lx, -1, 1));
        o[J.wA + 2] = 0;
      }
      re = true;
    }
    if (re) solveRig(ent);
  }
  const _sk = { x: 0, y: 0, z: 0 }, _sk2 = { x: 0, y: 0, z: 0 };
  // ----- 魂幡的幡布与骨符：世界空间里的几个摆锤（Verlet），挂点跟着杆走，幡布被重力拉下、被动作甩起、跑动时拖在后面 -----
  // 摆锤：0 = 幡布上段（挂在 bnF1）、1 = 下段（挂在上段的末端）、2 / 3 = 两串骨符
  const BAN_BOB = [['bnF1', BAN_L1], [null, BAN_L2], ['bnC1', BAN_CL], ['bnC2', BAN_CL]];
  const _ba = new Float32Array(3);
  function bannerSway(ent, dt) {
    let s = ent.ban;
    if (ent.gearType !== G_BAN || ent.dying) {
      if (s) s.on = false;
      return;
    }
    if (!s) s = ent.ban = { on: false, P: new Float32Array(36), t: 0 };
    const rig = ent.rig, J = rig.J, o = ent.out, M = ent.mdl, P = s.P, g = ent.group;
    const yaw = g.rotation.y, cy = Math.cos(yaw), sy = Math.sin(yaw), sc = g.scale.x * ent.body.scale.x;
    rotOf(M, rig.JI.wBn, _Rh);
    const R = _Rh;
    const h = dt > 1 / 30 ? 1 / 30 : dt;
    s.t += h;
    // 相对挂点的摆动按 damp 衰减（不来回晃个没完）；相对空气的阻力 air 让幡布跑动时斜拖在后面，而不是被扯成一面平旗
    const damp = Math.pow(0.88, h * 60), air = 0.65 * h, G2 = 7.5 * h * h;
    // 风：沿幡面法线（杆的局部 y）的一点飘动
    const wind = (Math.sin(s.t * 2.7 + ent.phase) * 0.9 + Math.sin(s.t * 6.1) * 0.45) * h * h;
    const nx = (R[1] * cy + R[7] * sy) * wind, nz = (-R[1] * sy + R[7] * cy) * wind, ny = R[4] * wind;
    let rx1 = 0, ry1 = 0;
    for (let i = 0; i < 4; i++) {
      const b = BAN_BOB[i], q = i * 9;
      // 挂点（世界坐标）
      let ax, ay, az;
      if (b[0]) {
        const m = rig.JI[b[0]] * 12, mx = M[m + 3] * sc, my = M[m + 7] * sc, mz = M[m + 11] * sc;
        ax = g.position.x + mx * cy + mz * sy;
        ay = g.position.y + my;
        az = g.position.z - mx * sy + mz * cy;
      } else {
        ax = P[0]; ay = P[1]; az = P[2];
      }
      const L = b[1] * sc;
      let x = P[q], y = P[q + 1], z = P[q + 2];
      if (!s.on || Math.hypot(x - ax, y - ay, z - az) > L * 4) {
        x = P[q + 3] = ax; y = P[q + 4] = ay - L; z = P[q + 5] = az;
        P[q + 6] = ax; P[q + 7] = ay; P[q + 8] = az;
      }
      if (h > 0) {
        const fw = i < 2 ? 1 : 0.3;
        // 挂点这一步的位移
        const vax = ax - P[q + 6], vay = ay - P[q + 7], vaz = az - P[q + 8];
        P[q + 6] = ax; P[q + 7] = ay; P[q + 8] = az;
        const vx = x - P[q + 3], vy = y - P[q + 4], vz = z - P[q + 5];
        let x2 = x + vax + (vx - vax) * damp - vx * air + nx * fw;
        let y2 = y + vay + (vy - vay) * damp - vy * air - G2 + ny * fw;
        let z2 = z + vaz + (vz - vaz) * damp - vz * air + nz * fw;
        const dx = x2 - ax, dy = y2 - ay, dz = z2 - az, l = Math.hypot(dx, dy, dz) || 1;
        x2 = ax + (dx / l) * L; y2 = ay + (dy / l) * L; z2 = az + (dz / l) * L;
        P[q + 3] = x; P[q + 4] = y; P[q + 5] = z;
        x = x2; y = y2; z = z2;
        P[q] = x; P[q + 1] = y; P[q + 2] = z;
      }
      // 摆锤方向：世界 → 模型 → 杆的局部坐标
      const wx = (x - ax) / L, wy = (y - ay) / L, wz = (z - az) / L;
      const mx = wx * cy - wz * sy, mz = wx * sy + wz * cy, my = wy;
      _ba[0] = R[0] * mx + R[3] * my + R[6] * mz;
      _ba[1] = R[1] * mx + R[4] * my + R[7] * mz;
      _ba[2] = R[2] * mx + R[5] * my + R[8] * mz;
      const arx = Math.atan2(_ba[1], -_ba[2]), ary = Math.asin(G.clamp(-_ba[0], -1, 1));
      if (i === 0) {
        // 幡布沿挑杆挂着：主要绕挑杆前后摆，左右只许一点
        rx1 = arx;
        ry1 = G.clamp(ary, -0.25, 0.25);
        o[J.bnF1] = rx1; o[J.bnF1 + 1] = ry1; o[J.bnF1 + 2] = 0;
      } else if (i === 1) {
        let d = arx - rx1;
        d -= Math.round(d / TAU) * TAU;
        o[J.bnF2] = G.clamp(d, -1.4, 1.4); o[J.bnF2 + 1] = G.clamp(ary - ry1, -0.3, 0.3); o[J.bnF2 + 2] = 0;
      } else {
        const jj = i === 2 ? J.bnC1 : J.bnC2;
        o[jj] = arx; o[jj + 1] = G.clamp(ary, -1.2, 1.2); o[jj + 2] = 0;
      }
    }
    s.on = true;
    solveRig(ent);
  }

  // ----- 围巾尾巴 + 马尾：角度空间里的二阶弹簧 -----
  // 目标角 = 静止垂挂 + 重力（取胸口 / 头此刻的真实朝向，翻滚、倒地、仰头都对）+ 跑动后扬 + 风里的抖动 +
  // 身体转向 / 翻滚带出的侧甩与离心上扬 + 动作里 cape1..3 的关键帧（虚关节，当作「甩」的信号）。
  // 每节刚度递减，末梢慢半拍，自然形成鞭梢。积分完把每节的末端推出头、围巾圈（后颈）、后背、腰臀的碰撞球：
  // 翻滚、后仰时马尾顺着后颈滑过去而不是穿进脖子，围巾尾巴贴着背飘而不是钻进皮衣里
  const SF_K = [170, 115, 80], HP_K = [230, 160, 110];
  // 碰撞球：[挂的关节, 绑定姿态里的球心 x, y, z, 半径]
  const HP_COL = [['head', 0, 1.79, 0.0, 0.15], ['chest', 0, 1.58, -0.03, 0.2], ['chest', 0, 1.4, -0.01, 0.235]];
  const SF_COL = [['head', 0, 1.79, 0.0, 0.16], ['chest', 0, 1.4, 0.0, 0.225], ['spine', 0, 1.2, 0.0, 0.195], ['root', 0, 0.95, 0.0, 0.215]];
  // 状态数组 s 的布局：围巾 6 节 ×（rx, rz）的角度 [0, 12)、角速度 [12, 24)；马尾 3 节的角度 [24, 30)、角速度 [30, 36)；
  // 上一帧的围巾 / 马尾朝向（偏航、俯仰）[36, 40)；[40] = 上一帧的朝向是否有效；[41, 45) 上一帧胸口 / 头里的重力方向（x, z）
  const TS_N = 45;
  const _tR = new Float32Array(9), _tD = new Float32Array(3), _tgt = new Float32Array(18);
  // 关节 j 的坐标系里，竖直向下（模型空间的 -y）指向哪边
  function downIn(M, j, out) {
    rotOf(M, j, _tR);
    out[0] = -_tR[3];
    out[1] = -_tR[4];
    out[2] = -_tR[5];
  }
  const wrapA = (a) => a - Math.round(a / TAU) * TAU;
  function tailSprings(ent, dt) {
    const rig = ent.rig, J = rig.J, JI = rig.JI, o = ent.out, M = ent.mdl;
    let st = ent.tails;
    if (!st) st = ent.tails = { s: new Float32Array(TS_N), init: false };
    const s = st.s, tg = _tgt;
    const run = Math.min(1.3, ent.spd / 7.2), r1 = Math.min(1, run), ph = ent.phase || 0, t = ent.clock || 0;
    // 动作给的「甩」：旧披风关节上的关键帧
    const c1 = o[J.cape1], c2 = o[J.cape2], c3 = o[J.cape3], z1 = o[J.cape1 + 2], z2 = o[J.cape2 + 2];
    const yawB = ent.group.rotation.y + o[J.root + 1] + o[J.spine + 1] + o[J.chest + 1];
    const yawH = yawB + o[J.head + 1];
    // 动作把身子压扁 / 拉长（瞬步、影步的那一下）时，矩阵里的不等比缩放让「朝向」和碰撞球都不可信：
    // 这几帧沿用上一帧的重力方向、不算转速、不做碰撞，弹簧照常跑
    const cm = JI.chest * 12;
    const l0 = Math.hypot(M[cm], M[cm + 4], M[cm + 8]), l1 = Math.hypot(M[cm + 1], M[cm + 5], M[cm + 9]), l2 = Math.hypot(M[cm + 2], M[cm + 6], M[cm + 10]);
    const warp = Math.max(l0, l1, l2) > Math.min(l0, l1, l2) * 1.2;
    // 胸口 / 头里的重力方向，以及它们绕左右轴的俯仰（翻滚时转得飞快 → 离心）
    let gxS = s[41], gzS = s[42], gxH = s[43], gzH = s[44], pS = s[38], pH = s[39];
    if (!warp || !st.init) {
      downIn(M, JI.chest, _tD);
      gxS = _tD[0]; gzS = _tD[2]; pS = Math.atan2(_tD[2], -_tD[1]);
      downIn(M, JI.head, _tD);
      gxH = _tD[0]; gzH = _tD[2]; pH = Math.atan2(_tD[2], -_tD[1]);
      s[41] = gxS; s[42] = gzS; s[43] = gxH; s[44] = gzH;
    }
    let wS = 0, wH = 0, qS = 0, qH = 0;
    if (s[40] && dt > 0 && !warp) {
      const cl = (v) => (v > 22 ? 22 : v < -22 ? -22 : v);
      wS = cl(wrapA(yawB - s[36]) / dt);
      wH = cl(wrapA(yawH - s[37]) / dt);
      qS = cl(wrapA(pS - s[38]) / dt);
      qH = cl(wrapA(pH - s[39]) / dt);
    }
    s[36] = yawB; s[37] = yawH; s[38] = pS; s[39] = pH; s[40] = warp ? 0 : 1;

    // --- 围巾 ---
    {
      const cen = Math.min(0.9, (Math.abs(wS) + Math.abs(qS) * 0.5) * 0.055);
      const grav = -0.8 * gzS, gside = 0.8 * gxS;
      for (let side = 0; side < 2; side++) {
        const sn = side ? -1 : 1;
        for (let i = 0; i < 3; i++) {
          const q = (side * 3 + i) * 2;
          const fl = Math.sin(t * (10.5 + i * 1.7) + i * 1.2 + side * 0.9 + ph), fz = Math.sin(t * (8.3 + i * 1.3) + i * 1.5 + side * 2.1 + ph);
          const idle = Math.sin(t * 1.6 + i * 0.8 + side * 0.6 + ph) * 0.06 * (1 - r1);
          let rx, rz;
          if (i === 0) {
            rx = 0.3 + grav + 0.78 * run + cen + c1 * 0.9 + fl * 0.05 * run;
            rz = sn * SF.splay + gside - wS * 0.03 + z1 * 1.2 + fz * 0.08 * run + idle * 0.5;
          } else if (i === 1) {
            rx = 0.06 + 0.12 * run + cen * 0.5 + c2 * 0.7 + fl * 0.16 * run + idle;
            rz = sn * 0.04 - wS * 0.025 + z2 * 1.1 + fz * 0.15 * run + idle;
          } else {
            rx = 0.04 + 0.04 * run + cen * 0.3 + c3 * 0.6 + fl * 0.24 * run + idle;
            rz = -wS * 0.02 + z2 * 0.8 + fz * 0.22 * run + idle;
          }
          // 再大的甩动也只到水平略上，不翻到头顶
          tg[q] = i === 0 ? G.clamp(rx, -0.3, 1.45) : G.clamp(rx, -0.7, 0.45);
          tg[q + 1] = G.clamp(rz, -1.1, 1.1);
        }
      }
    }
    // --- 马尾：更硬、更短，额外叠一层跑步时的上下颠 ---
    {
      const cen = Math.min(0.7, (Math.abs(wH) + Math.abs(qH) * 0.5) * 0.045);
      const grav = -0.85 * gzH, gside = 0.6 * gxH, bob = Math.sin(ent.walk * 2) * r1, ph2 = ph + 0.7;
      for (let i = 0; i < 3; i++) {
        const q = 12 + i * 2;
        const fl = Math.sin(t * (9 + i * 1.9) + i * 1.3 + ph2), fz = Math.sin(t * (7.1 + i * 1.4) + i * 1.7 + ph2);
        const idle = Math.sin(t * 1.4 + i * 0.9 + ph2) * 0.05 * (1 - r1);
        let rx, rz;
        if (i === 0) {
          rx = grav + 0.62 * run + cen + c1 * 0.5 + bob * 0.12 + idle * 0.5;
          rz = gside - wH * 0.035 + z1 * 0.8 + fz * 0.06 * run + idle * 0.4;
        } else {
          rx = 0.08 * run + cen * 0.4 + fl * (0.1 + 0.05 * i) * run + bob * 0.08 + idle;
          rz = -wH * 0.025 + fz * (0.1 + 0.06 * i) * run + idle;
        }
        tg[q] = i === 0 ? G.clamp(rx, -0.6, 1.35) : G.clamp(rx, -0.6, 0.6);
        tg[q + 1] = G.clamp(rz, -1.0, 1.0);
      }
    }
    // --- 积分：1/120 秒一小步的半隐式欧拉（阻尼比 0.32 / 0.36）；状态坏了就直接贴回目标 ---
    if (!st.init) {
      for (let q = 0; q < 12; q++) { s[q] = tg[q]; s[12 + q] = 0; }
      for (let q = 0; q < 6; q++) { s[24 + q] = tg[12 + q]; s[30 + q] = 0; }
      st.init = true;
    } else if (dt > 0) {
      const n = Math.min(12, Math.max(1, Math.ceil(dt / (1 / 120)))), h = dt / n;
      for (let it = 0; it < n; it++) {
        for (let q = 0; q < 12; q++) {
          const k = SF_K[(q >> 1) % 3];
          s[12 + q] += (k * (tg[q] - s[q]) - 2 * 0.32 * Math.sqrt(k) * s[12 + q]) * h;
          s[q] += s[12 + q] * h;
        }
        for (let q = 0; q < 6; q++) {
          const k = HP_K[q >> 1];
          s[30 + q] += (k * (tg[12 + q] - s[24 + q]) - 2 * 0.36 * Math.sqrt(k) * s[30 + q]) * h;
          s[24 + q] += s[30 + q] * h;
        }
      }
      for (let q = 0; q < 36; q++) {
        if (!(Math.abs(s[q]) < 50)) {
          st.init = false;
          return tailSprings(ent, 0);
        }
      }
    }
    // --- 写回姿态 + 碰撞 ---
    for (let j = 0; j < 6; j++) {
      const ix = J[SF_SEG[j]], i = j % 3, sn = j < 3 ? 1 : -1;
      o[ix] = s[j * 2];
      o[ix + 2] = s[j * 2 + 1];
      // 绕尾巴自身的长轴拧一点：侧面看得到布面，不是一条线
      o[ix + 1] = sn * (0.12 + 0.22 * r1) * (i === 0 ? 1 : 0.4) + Math.sin(t * (6.5 + i) + j * 1.7 + ph) * (0.08 + 0.3 * r1);
    }
    for (let j = 0; j < 3; j++) {
      const ix = J[HP_SEG[j]];
      o[ix] = s[24 + j * 2];
      o[ix + 1] = 0;
      o[ix + 2] = s[24 + j * 2 + 1];
    }
    const chainL = rig.tailL || (rig.tailL = SF_SEG.slice(0, 3).map((n) => JI[n]));
    const chainR = rig.tailR || (rig.tailR = SF_SEG.slice(3).map((n) => JI[n]));
    const chainH = rig.tailH || (rig.tailH = HP_SEG.map((n) => JI[n]));
    const colS = rig.colS || (rig.colS = SF_COL.map((c) => [JI[c[0]], c[1], c[2], c[3], c[4]]));
    const colH = rig.colH || (rig.colH = HP_COL.map((c) => [JI[c[0]], c[1], c[2], c[3], c[4]]));
    for (const jj of chainL) solveJoint(ent, jj);
    for (const jj of chainR) solveJoint(ent, jj);
    for (const jj of chainH) solveJoint(ent, jj);
    if (warp) return;
    pushOut(ent, chainL, SF.len[2], colS, s, 0, 12);
    pushOut(ent, chainR, SF.len[2], colS, s, 6, 18);
    pushOut(ent, chainH, -1, colH, s, 24, 30);
  }
  // 链条（每节只有 rx / rz 两个自由度）的末端推出碰撞球：用两根转轴的雅可比做一步阻尼最小二乘，自根向梢、两遍。
  // 推出去的同时把朝球里转的角速度清掉（贴着滑，不弹回去再钻）。tipLen > 0：最后一节的末端在枢轴正下方 tipLen 处；
  // -1：马尾，发梢取 HAIR_T 的最后一点
  const _springPt = new Float32Array(3);
  function pushOut(ent, chain, tipLen, cols, s, a0, v0) {
    const rig = ent.rig, M = ent.mdl, o = ent.out, js = rig.joints, n = chain.length;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const ji = chain[i], m = ji * 12;
        // 这一节的末端（模型空间）
        let px, py, pz;
        if (i < n - 1) {
          const mc = chain[i + 1] * 12;
          px = M[mc + 3]; py = M[mc + 7]; pz = M[mc + 11];
        } else {
          const jp = js[ji];
          let ox, oy, oz;
          if (tipLen > 0) { ox = 0; oy = -tipLen; oz = 0; }
          else { const T3 = HAIR_T[3]; ox = T3[0] - jp.px0; oy = T3[1] - jp.py0; oz = T3[2] - jp.pz0; }
          px = M[m] * ox + M[m + 1] * oy + M[m + 2] * oz + M[m + 3];
          py = M[m + 4] * ox + M[m + 5] * oy + M[m + 6] * oz + M[m + 7];
          pz = M[m + 8] * ox + M[m + 9] * oy + M[m + 10] * oz + M[m + 11];
        }
        let dx = 0, dy = 0, dz = 0, hit = false;
        for (let c = 0; c < cols.length; c++) {
          const C = cols[c], cm = C[0] * 12, cj = js[C[0]];
          const ox = C[1] - cj.px0, oy = C[2] - cj.py0, oz = C[3] - cj.pz0;
          _springPt[0] = M[cm] * ox + M[cm + 1] * oy + M[cm + 2] * oz + M[cm + 3];
          _springPt[1] = M[cm + 4] * ox + M[cm + 5] * oy + M[cm + 6] * oz + M[cm + 7];
          _springPt[2] = M[cm + 8] * ox + M[cm + 9] * oy + M[cm + 10] * oz + M[cm + 11];
          const ex = px + dx - _springPt[0], ey = py + dy - _springPt[1], ez = pz + dz - _springPt[2], l = Math.hypot(ex, ey, ez);
          if (l < C[4] && l > 1e-5) {
            const k = (C[4] - l) / l;
            dx += ex * k; dy += ey * k; dz += ez * k;
            hit = true;
          }
        }
        if (!hit) continue;
        // 两根转轴：rx 绕父关节的 x 轴（欧拉 XYZ 最外层），rz 绕本关节自己的 z 轴（最内层）
        const qm = js[ji].parent * 12, qx = px - M[m + 3], qy = py - M[m + 7], qz = pz - M[m + 11];
        let ax = M[qm], ay = M[qm + 4], az = M[qm + 8], al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;
        let bx = M[m + 2], by = M[m + 6], bz = M[m + 10], bl = Math.hypot(bx, by, bz) || 1;
        bx /= bl; by /= bl; bz /= bl;
        const Ax = ay * qz - az * qy, Ay = az * qx - ax * qz, Az = ax * qy - ay * qx;
        const Bx = by * qz - bz * qy, By = bz * qx - bx * qz, Bz = bx * qy - by * qx;
        const lam = 1e-4, aa = Ax * Ax + Ay * Ay + Az * Az + lam, bb = Bx * Bx + By * By + Bz * Bz + lam, ab = Ax * Bx + Ay * By + Az * Bz;
        const ra = Ax * dx + Ay * dy + Az * dz, rb = Bx * dx + By * dy + Bz * dz, det = aa * bb - ab * ab;
        if (det < 1e-12) continue;
        // 多推 10%，下一帧不至于又刚好擦进去；一遍最多转 0.25 弧度，深陷时分几帧推出来，不会一帧弹飞
        const da = G.clamp(((bb * ra - ab * rb) / det) * 1.1, -0.25, 0.25), db = G.clamp(((aa * rb - ab * ra) / det) * 1.1, -0.25, 0.25);
        const qa = a0 + i * 2, qv = v0 + i * 2;
        s[qa] += da;
        s[qa + 1] += db;
        if (s[qv] * da < 0) s[qv] = 0;
        if (s[qv + 1] * db < 0) s[qv + 1] = 0;
        const ix = ji * CH;
        o[ix] = s[qa];
        o[ix + 2] = s[qa + 1];
        for (let k = i; k < n; k++) solveJoint(ent, chain[k]);
        moved = true;
      }
      if (!moved) break;
    }
  }

  function playerLate(ent, sdt) {
    tailSprings(ent, sdt || 0);
    playerIK(ent, sdt || 0);
    bannerSway(ent, sdt || 0);
    // 挥砍的出手段：武器拖出一道刀光
    const c = ent.clip;
    if (c && c.trail && ent === trail.ent && !ent.dying && ent.cK >= c.trail[0] && ent.cK <= c.trail[1]) {
      W.entSocket(ent, 'weapon', _sk);
      W.entSocket(ent, 'hand', _sk2);
      trailPush(ent, _sk2.x + (_sk.x - _sk2.x) * 0.3, _sk2.y + (_sk.y - _sk2.y) * 0.3, _sk2.z + (_sk.z - _sk2.z) * 0.3, _sk.x, _sk.y, _sk.z);
    }
    // 投掷（掷焰 / 飞刃）的蓄力：出手前火星往投掷的那只手里聚，出手那一刻手上一颗星 + 两团实心的烟（颜色见 W.castTint）
    if (c && c.name === 'throw' && ent === trail.ent && !ent.dying && sdt > 0) {
      const kk = ent.cK, cp = castPal;
      W.entSocket(ent, ent.gearClips && ent.gearClips.throw === c ? 'hand' : 'handL', _sk);
      if (kk > 0.08 && kk < 0.5) {
        ent.gatherAcc = (ent.gatherAcc || 0) + sdt * (qualId === 'low' ? 30 : 60);
        _c.set(cp[1]);
        while (ent.gatherAcc >= 1) {
          ent.gatherAcc -= 1;
          const a = rand(0, TAU), up = rand(-0.3, 0.6), d = rand(0.45, 0.8), t = rand(0.12, 0.18);
          const ox = Math.sin(a) * d, oy = up, oz = Math.cos(a) * d;
          spawnP(_sk.x + ox, _sk.y + oy, _sk.z + oz, -ox / t, -oy / t, -oz / t, t, rand(0.1, 0.16), _c.r, _c.g, _c.b, 0, 0);
        }
      }
      if ((ent.thrK || 0) < 0.5 && kk >= 0.5) {
        tChunk(1, _sk.x, _sk.y, _sk.z, 0, 0, 0, 0.14, 0.42, cp[0], cp[1], 0);
        tPuffs(_sk.x, _sk.y, _sk.z, qualId === 'low' ? 1 : 2, 1.2, 0.6, 0.26, 0.2, cp[1], cp[2]);
      }
      ent.thrK = kk;
    } else if (ent.thrK) ent.thrK = 0;
    // 稀有度光晕跟着武器走；稀有武器偶尔掉一点光屑
    const a = ent.aura;
    if (!a || !a.visible) return;
    const s = ent.sock.weapon, M = ent.mdl, m = s.j * 12, z = s.z * (GEAR_AURA[ent.gearType] || GEAR_AURA[0])[0];
    a.position.set(M[m + 2] * z + M[m + 3], M[m + 6] * z + M[m + 7], M[m + 10] * z + M[m + 11]);
    if (ent.gearRar === 2 && Math.random() < 0.06 && !ent.dying) {
      W.entSocket(ent, 'weapon', _sk);
      spawnP(_sk.x, _sk.y, _sk.z, rand(-0.3, 0.3), rand(0.2, 0.9), rand(-0.3, 0.3), rand(0.4, 0.8), 0.1, 1, 0.84, 0.37, -0.3, 0.6);
    }
    // 冰弓凛羽：不冒火星，弓身上一粒粒细碎的霜晶慢慢飘落，偶尔一粒亮白的冰闪
    if (ent.gearRar >= 3 && ent.gearVar === 'emberbow' && !ent.dying && sdt > 0) {
      ent.emberAcc = (ent.emberAcc || 0) + sdt * 16;
      if (ent.emberAcc >= 1) {
        W.entSocket(ent, 'weapon', _sk);
        W.entSocket(ent, 'hand', _sk2);
        while (ent.emberAcc >= 1) {
          ent.emberAcc -= 1;
          const f = Math.random() * 1.1 - 0.05, w = Math.random() < 0.18;
          spawnP(_sk2.x + (_sk.x - _sk2.x) * f + rand(-0.06, 0.06), _sk2.y + (_sk.y - _sk2.y) * f, _sk2.z + (_sk.z - _sk2.z) * f + rand(-0.06, 0.06),
            rand(-0.15, 0.15), rand(-0.1, 0.25), rand(-0.15, 0.15), rand(0.6, 1.1), w ? rand(0.07, 0.1) : rand(0.04, 0.07),
            w ? 0.8 : 0.25, w ? 0.93 : 0.62 + 0.15 * Math.random(), 1, 0.35, 1.2);
        }
      }
    }
    // 烬铸：火星沿着整把武器（握把到尖端）往上飘，偶尔一粒偏白的亮点
    else if (ent.gearRar >= 3 && !ent.dying && sdt > 0) {
      ent.emberAcc = (ent.emberAcc || 0) + sdt * 26;
      if (ent.emberAcc >= 1) {
        W.entSocket(ent, 'weapon', _sk);
        W.entSocket(ent, 'hand', _sk2);
        while (ent.emberAcc >= 1) {
          ent.emberAcc -= 1;
          const f = 0.25 + Math.random() * 0.75, w = Math.random() < 0.2 ? 0.55 : 0;
          spawnP(_sk2.x + (_sk.x - _sk2.x) * f, _sk2.y + (_sk.y - _sk2.y) * f, _sk2.z + (_sk.z - _sk2.z) * f, rand(-0.35, 0.35), rand(0.5, 1.5), rand(-0.35, 0.35),
            rand(0.35, 0.8), rand(0.07, 0.13), 1, 0.45 + 0.3 * Math.random() + w * 0.4, 0.12 + w * 0.6, -0.8, 0.8);
        }
      }
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
    // 第一段：自右向左的横斩（刀光窗口 trail 到 0.64 就收：长杖收招时杖身顺着自己的长度走，再拖下去是一条直板）
    defClip(rig, 'attack1', {
      dur: 0.45, k0: 0.5, lower: LEGS, fade: 0.06, out: 0.2, trail: [0.3, 0.64],
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
        // 卡通的挤压拉伸：蓄力时压低变宽（k 0.3），出手那一下拉长（命中帧 0.5），收招回弹到 1
        'root.sx': [0, 1, 0.3, 1.05, -0.5, 0.965, 0.72, 1.01, 1, 1],
        'root.sy': [0, 1, 0.3, 0.92, -0.5, 1.07, 0.72, 0.985, 1, 1],
        'root.sz': [0, 1, 0.3, 1.05, -0.5, 0.965, 0.72, 1.01, 1, 1],
      }, 1)),
    });
    // 第二段：反手自左向右、略微上挑
    defClip(rig, 'attack2', {
      dur: 0.45, k0: 0.5, lower: LEGS, fade: 0.06, out: 0.2, trail: [0.3, 0.64],
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
        'root.sx': [0, 1, 0.3, 1.045, -0.5, 0.97, 0.72, 1.01, 1, 1],
        'root.sy': [0, 1, 0.3, 0.93, -0.5, 1.065, 0.72, 0.985, 1, 1],
        'root.sz': [0, 1, 0.3, 1.045, -0.5, 0.97, 0.72, 1.01, 1, 1],
      }, 0.9)),
    });
    // 第三段（终结）：双手举过头顶，跃起后劈到地上，落成弓步
    defClip(rig, 'attack3', {
      dur: 0.6, k0: 0.5, lower: LEGS, air: 'jump', fade: 0.07, out: 0.26, trail: [0.33, 0.56],
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
        // 终结的挤压拉伸：下蹲蓄力压扁（0.16）→ 起跳拉长（0.34）→ 砸地压扁（命中帧 0.5）→ 回弹
        'root.sx': [0, 1, 0.16, 1.08, 0.34, 0.94, -0.5, 1.08, 0.66, 0.98, 1, 1],
        'root.sy': [0, 1, 0.16, 0.88, 0.34, 1.1, -0.5, 0.88, 0.66, 1.03, 1, 1],
        'root.sz': [0, 1, 0.16, 1.08, 0.34, 0.94, -0.5, 1.08, 0.66, 0.98, 1, 1],
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
        // 蓄力收身压低（0.32），甩出时拉长（0.5）
        'root.sx': [0, 1, 0.32, 1.04, -0.5, 0.97, 0.75, 1.01, 1, 1],
        'root.sy': [0, 1, 0.32, 0.93, -0.5, 1.06, 0.75, 0.99, 1, 1],
        'root.sz': [0, 1, 0.32, 1.04, -0.5, 0.97, 0.75, 1.01, 1, 1],
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

  // ----- 按武器换的动作 + 武器技的动作 -----
  const ARM_J = { uaR: 1, faR: 1, hR: 1, uaL: 1, faL: 1, hL: 1 };
  function noArms(keys) {
    const o = {};
    for (const k in keys) if (!ARM_J[k.slice(0, k.indexOf('.'))]) o[k] = keys[k];
    return o;
  }
  // 手的轨迹：[[k, 'I'] 站立姿势 | [k, 位置, 指向, 刃口]...]
  function track(I, list, f) {
    const k = [], p = [], d = [], e = [];
    for (const it of list) {
      const idle = it[1] === 'I';
      k.push(it[0]);
      // 站立姿势是胸口坐标系里的值：模型空间的轨迹要加上胸口的高度
      p.push(idle ? (f === 'model' ? [I[0], I[1] + 1.32, I[2]] : I.slice(0, 3)) : it[1]);
      d.push(idle ? I.slice(3, 6) : it[2]);
      e.push(idle ? I.slice(6, 9) : it[3] || [0, -1, 0]);
    }
    return { f: f || 'chest', k, p, d, e };
  }
  function weaponClips(rig) {
    const C = (v) => [0, v, 1, v];
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
    const base = (n) => rig.clips[n].spec;
    const flick = (keys) => Object.assign({}, keys, {
      'root.sx': [0, 0.15, 0.14, 0.3, 0.26, 1.18, 0.36, 1, 1, 1],
      'root.sz': [0, 0.15, 0.14, 0.3, 0.26, 1.18, 0.36, 1, 1, 1],
      'root.sy': [0, 1.7, 0.14, 1.5, 0.26, 0.86, 0.36, 1, 1, 1],
      'root.oy': [0, 0.1, 0.18, -0.16, -0.5, -0.12, 1, -0.04],
    });

    // --- 双手武器（战锤 / 太刀）：三段连击、旋风、处决都改成双手握持，右手按轨迹走，左手握柄 ---
    for (const g of [G_HAM, G_KAT]) {
      const I = LOCO_2H[g].idle;
      const T1 = track(I, [
        [0, 'I'],
        [0.3, [-0.3, 0.16, 0.18], [-0.45, 0.55, -0.7], [0.2, 0.3, 0.93]],
        [-0.5, [0.02, -0.12, 0.5], [0.75, -0.05, 0.65], [0.65, 0, -0.75]],
        [0.72, [0.26, -0.22, 0.32], [0.55, -0.25, -0.8], [-0.8, 0, -0.55]],
        [1, 'I'],
      ]);
      const T2 = track(I, [
        [0, 'I'],
        [0.3, [0.24, -0.28, 0.26], [0.55, -0.35, -0.75], [-0.5, 0.3, -0.3]],
        [-0.5, [-0.04, -0.02, 0.5], [-0.7, 0.2, 0.68], [-0.68, 0.1, -0.7]],
        [0.72, [-0.28, 0.2, 0.28], [-0.55, 0.55, -0.62], [0, 1, 0]],
        [1, 'I'],
      ]);
      // 终结的跳劈：落地时上身前倾很多，轨迹用模型空间（不跟着胸口转），锤头 / 刀尖正好落到身前的地面上
      const T3 = track(I, [
        [0, 'I'],
        [0.18, [-0.05, 1.55, 0.2], [0, 0.95, 0.3], [0, 0, 1]],
        [0.34, [0, 2.25, -0.05], [0, 0.35, -0.94], [0, 1, 0]],
        [-0.5, [0, 0.62, 0.78], [0, -0.42, 0.9], [0, -0.9, -0.42]],
        [0.8, [0, 0.6, 0.76], [0, -0.44, 0.9], [0, -0.9, -0.44]],
        [1, 'I'],
      ], 'model');
      const a1 = base('attack1'), a2 = base('attack2'), a3 = base('attack3');
      defGearClip(rig, g, 'attack1', Object.assign({}, a1, { keys: noArms(a1.keys), hand: T1 }));
      defGearClip(rig, g, 'attack2', Object.assign({}, a2, { keys: noArms(a2.keys), hand: T2 }));
      defGearClip(rig, g, 'attack3', Object.assign({}, a3, { keys: noArms(a3.keys), hand: T3 }));
      defGearClip(rig, g, 'flicker', Object.assign({}, base('flicker'), { keys: flick(noArms(a1.keys)), hand: T1 }));
      defGearClip(rig, g, 'flicker2', Object.assign({}, base('flicker2'), { keys: flick(noArms(a2.keys)), hand: T2 }));
      const sp = base('spin');
      const hold = [-0.2, -0.12, 0.4], hd = [-0.85, 0.05, 0.5], he = [0.5, 0, 0.85];
      defGearClip(rig, g, 'spin', Object.assign({}, sp, { keys: noArms(sp.keys), hand: track(I, [[0, hold, hd, he], [1, hold, hd, he]]) }));
      const ex = base('execute');
      defGearClip(rig, g, 'execute', Object.assign({}, ex, {
        keys: noArms(ex.keys),
        hand: track(I, [
          [0, 'I'],
          [0.3, [-0.26, 1.05, -0.05], [0.05, 0.1, 1]],
          [-0.5, [0, 1.0, 0.8], [0, -0.04, 1]],
          [0.62, [0, 1.0, 0.78], [0, -0.04, 1]],
          [0.78, [-0.22, 1.0, 0.6], [-0.7, -0.1, 0.7], [0.7, 0, 0.7]],
          [1, 'I'],
        ], 'model'),
      }));
    }
    // --- 长弓：弓在左手，近战动作左右镜像（用弓身抡），投掷换右手 ---
    for (const n of ['attack1', 'attack2', 'attack3', 'flicker', 'flicker2', 'execute', 'throw']) {
      const s = base(n);
      defGearClip(rig, G_BOW, n, Object.assign({}, s, { keys: mirrorKeys(s.keys) }));
    }
    // --- 魂幡：杆太长，终结的下劈改成杆头平压向前（不往地里戳），其余照长杖的挥法 ---
    {
      const s = base('attack3');
      defGearClip(rig, G_BAN, 'attack3', Object.assign({}, s, { keys: Object.assign({}, s.keys, { 'hR.rx': [0, 0.6, 0.18, 0.3, 0.34, -0.2, -0.5, 0.62, 0.8, 0.58, 1, 0.5] }) }));
    }
    {
      const s = base('spin');
      defGearClip(rig, G_BOW, 'spin', Object.assign({}, s, { keys: mirrorKeys(s.keys), fn(ent, p, k) { p[ent.rig.J.root + 1] = -k * TAU; } }));
    }

    // ===== 武器技（W.play(ent, 'w_' + type)）=====
    // 刃「回锋斩」：后引 → 弓步直刺（k0）→ 原地拧身一整圈横扫（扫到正后方约在 k = 0.62）
    defClip(rig, 'w_blade', {
      dur: 0.8, k0: 0.3, lower: LEGS, fade: 0.05, out: 0.22, trail: [0.2, 0.78],
      keys: stance({
        'root.oz': [0, 0, 0.14, -0.12, -0.3, 0.32, 0.45, 0.22, 1, 0.02],
        'root.rx': [0, 0.06, 0.14, 0, -0.3, 0.26, 0.45, 0.12, 0.8, 0.1, 1, 0.04],
        'root.ry': [0, 0, 0.14, -0.3, -0.3, 0.12, 0.44, 0.12, 0.76, TAU + 0.1, 1, TAU],
        'root.oy': [0, 0, 0.3, -0.06, 0.5, -0.1, 0.76, -0.12, 1, 0],
        'spine.ry': [0, 0, 0.14, -0.25, -0.3, 0.15, 0.45, 0, 1, 0],
        'chest.ry': [0, 0, 0.14, -0.45, -0.3, 0.25, 0.45, -0.1, 0.76, -0.25, 1, 0],
        'head.ry': [0, 0, 0.14, 0.6, -0.3, -0.25, 0.45, 0.2, 0.76, 0.3, 1, 0],
        'uaR.rx': [0, -0.2, 0.14, 0.6, -0.3, -1.45, 0.42, -1.2, 0.5, -0.05, 0.76, 0, 1, -0.2],
        'uaR.rz': [0, -0.3, 0.14, -0.45, -0.3, -0.08, 0.42, -0.5, 0.5, -1.4, 0.76, -1.4, 1, -0.35],
        'uaR.ry': [0, 0, 0.42, 0, 0.5, 0.35, 0.76, 0.35, 1, 0],
        'faR.rx': [0, -0.6, 0.14, -1.7, -0.3, -0.05, 0.42, -0.2, 0.5, -0.25, 0.76, -0.25, 1, -0.55],
        'hR.rx': [0, 0.9, 0.14, 1.45, -0.3, 1.55, 0.5, 1.5, 0.76, 1.5, 1, 0.8],
        'hR.ry': C(0), 'hR.rz': C(0),
        'uaL.rx': [0, -0.2, 0.14, -0.9, -0.3, 0.6, 0.5, 0, 1, 0.1],
        'uaL.rz': [0, 0.3, 0.3, 0.45, 0.5, 1.15, 0.76, 1.15, 1, 0.3],
        'faL.rx': [0, -0.6, 0.3, -0.4, 1, -0.5],
        'cape1.rx': [0, 0.1, 0.3, 0.3, 0.5, 0.8, 0.76, 0.8, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.3, 0.25, 0.5, 0.6, 0.76, 0.6, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.3, 0.2, 0.5, 0.5, 0.76, 0.5, 1, 0.1],
      }, 1),
    });
    // 长杖「地脉涌」：杖高举过头 → 沉身把杖尾杵进地里（k0）→ 定住片刻
    defClip(rig, 'w_staff', {
      dur: 0.75, k0: 0.55, fade: 0.06, out: 0.24,
      keys: {
        'root.oy': [0, 0, 0.3, 0.06, -0.55, -0.38, 0.75, -0.36, 1, 0],
        'root.rx': [0, 0.05, 0.3, -0.12, -0.55, 0.2, 0.75, 0.18, 1, 0.04],
        'spine.rx': [0, 0, 0.3, -0.15, -0.55, 0.12, 0.75, 0.1, 1, 0],
        'chest.rx': [0, 0, 0.3, -0.15, -0.55, 0.1, 0.75, 0.1, 1, 0],
        'head.rx': [0, 0, 0.3, -0.3, -0.55, 0.2, 1, 0],
        'uaR.rx': [0, -0.3, 0.3, -2.5, -0.55, -0.75, 0.75, -0.8, 1, -0.3],
        'uaR.rz': [0, -0.14, 0.3, 0.15, -0.55, -0.1, 1, -0.14],
        'uaR.ry': C(0),
        'faR.rx': [0, -0.75, 0.3, -0.35, -0.55, -0.25, 0.75, -0.3, 1, -0.75],
        'hR.rx': [0, -0.75, 0.3, 1.15, -0.55, -1.12, 0.75, -1.08, 1, -0.75],
        'hR.ry': C(0), 'hR.rz': C(0.12),
        'uaL.rx': [0, 0, 0.3, -1.6, -0.55, 0.2, 0.75, 0.2, 1, 0],
        'uaL.rz': [0, 0.12, 0.3, 0.9, -0.55, 1.1, 0.75, 1.1, 1, 0.12],
        'faL.rx': [0, -0.3, 0.3, -0.6, -0.55, -0.1, 1, -0.3],
        'hL.rx': [0, 0, 0.3, -0.4, -0.55, 0.3, 1, 0],
        'thL.rx': [0, -0.1, 0.3, -0.2, -0.55, -1.25, 0.75, -1.2, 1, -0.05],
        'shL.rx': [0, 0.1, 0.3, 0.2, -0.55, 1.55, 0.75, 1.5, 1, 0.08],
        'thR.rx': [0, 0, 0.3, 0.05, -0.55, 0.35, 0.75, 0.35, 1, 0],
        'shR.rx': [0, 0.1, 0.3, 0.15, -0.55, 1.3, 0.75, 1.25, 1, 0.08],
        'ftR.rx': [0, 0, -0.55, 0.4, 0.75, 0.4, 1, 0],
        'ftL.rx': [0, 0, -0.55, 0.2, 1, 0],
        'thL.rz': [0, 0.07, -0.55, 0.22, 0.75, 0.22, 1, 0.07],
        'thR.rz': [0, -0.07, -0.55, -0.22, 0.75, -0.22, 1, -0.07],
        'cape1.rx': [0, 0.1, 0.3, -0.1, -0.55, 0.7, 0.75, 0.4, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.3, -0.15, -0.58, 0.6, 0.8, 0.35, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.3, -0.15, -0.62, 0.5, 0.85, 0.3, 1, 0.1],
      },
    });
    // 短杖「秘弹连射」：右臂平举、杖尖指前，手腕连抖五下（k = 0.18 / 0.33 / 0.48 / 0.63 / 0.78，k0 是第一下）
    {
      const shots = [0.18, 0.33, 0.48, 0.63, 0.78];
      const hrx = [0, 0.2, 0.1, 1.0], uax = [0, -0.3, 0.1, -1.5], chx = [0, 0, 0.1, 0];
      for (const k of shots) {
        hrx.push(k - 0.04, 1.0, -k, 1.7, k + 0.06, 1.2);
        uax.push(k - 0.01, -1.5, -(k + 0.02), -1.64, k + 0.08, -1.5);
        chx.push(k - 0.01, 0, -(k + 0.02), -0.07, k + 0.09, 0);
      }
      hrx.push(0.88, 1.2, 1, 0.3);
      uax.push(0.9, -1.45, 1, -0.35);
      chx.push(1, 0);
      defClip(rig, 'w_wand', {
        dur: 0.9, k0: shots[0], lower: LEGS, fade: 0.06, out: 0.2,
        keys: stance({
          'chest.rx': chx,
          'chest.ry': [0, 0, 0.1, 0.35, 0.86, 0.35, 1, 0],
          'spine.ry': [0, 0, 0.1, 0.15, 0.86, 0.15, 1, 0],
          'head.ry': [0, 0, 0.1, -0.4, 0.86, -0.4, 1, 0],
          'uaR.rx': uax,
          'uaR.rz': [0, -0.15, 0.1, 0.12, 0.86, 0.12, 1, -0.15],
          'uaR.ry': C(0),
          'faR.rx': [0, -0.95, 0.1, -0.12, 0.86, -0.12, 1, -0.95],
          'hR.rx': hrx,
          'hR.ry': C(0), 'hR.rz': C(0),
          'uaL.rx': [0, 0, 0.1, -0.7, 0.86, -0.7, 1, 0],
          'uaL.rz': [0, 0.12, 0.1, -0.1, 0.86, -0.1, 1, 0.12],
          'faL.rx': [0, -0.3, 0.1, -1.7, 0.86, -1.7, 1, -0.3],
        }, 0.7),
      });
    }
    // 双匕「影刺」：蜷身收成一线消失（瞬移在 k≈0.22）→ 在目标身后弹开、双匕高举 → 一齐下刺（k0）
    defClip(rig, 'w_daggers', {
      dur: 0.6, k0: 0.5, fade: 0.04, out: 0.2, trail: [0.36, 0.6],
      keys: {
        'root.sy': [0, 1, 0.12, 0.86, -0.22, 1.7, 0.3, 0.6, 0.4, 1.12, 0.5, 1, 1, 1],
        'root.sx': [0, 1, 0.12, 1.1, -0.22, 0.1, 0.3, 1.25, 0.4, 0.95, 0.5, 1, 1, 1],
        'root.sz': [0, 1, 0.12, 1.1, -0.22, 0.1, 0.3, 1.25, 0.4, 0.95, 0.5, 1, 1, 1],
        'root.rx': [0, 0.1, 0.12, 0.4, 0.22, 0, 0.32, 0.3, -0.5, 0.45, 0.7, 0.4, 1, 0.05],
        'root.oy': [0, 0, 0.12, -0.2, 0.22, 0, 0.32, -0.25, -0.5, -0.4, 0.7, -0.38, 1, 0],
        'root.oz': [0, 0, 0.32, -0.1, -0.5, 0.25, 0.7, 0.22, 1, 0.02],
        'spine.rx': [0, 0, 0.12, 0.3, 0.22, 0, 0.32, -0.1, -0.5, 0.2, 1, 0],
        'head.rx': [0, 0, 0.32, -0.2, -0.5, 0.25, 1, 0],
        'uaR.rx': [0, -0.2, 0.12, -0.9, 0.22, -0.3, 0.32, -2.5, -0.5, -0.85, 0.7, -0.9, 1, -0.25],
        'uaR.rz': [0, -0.2, 0.12, 0.4, 0.22, -0.2, 0.32, -0.25, -0.5, 0.12, 0.7, 0.12, 1, -0.2],
        'faR.rx': [0, -1.1, 0.12, -1.9, 0.22, -0.5, 0.32, -1.3, -0.5, -0.15, 0.7, -0.2, 1, -1.1],
        'hR.rx': [0, 0.6, 0.32, 1.9, -0.5, 1.5, 0.7, 1.5, 1, 0.6],
        'uaL.rx': [0, -0.2, 0.12, -0.9, 0.22, -0.3, 0.32, -2.5, -0.5, -0.85, 0.7, -0.9, 1, -0.25],
        'uaL.rz': [0, 0.2, 0.12, -0.4, 0.22, 0.2, 0.32, 0.25, -0.5, -0.12, 0.7, -0.12, 1, 0.2],
        'faL.rx': [0, -1.1, 0.12, -1.9, 0.22, -0.5, 0.32, -1.3, -0.5, -0.15, 0.7, -0.2, 1, -1.1],
        'hL.rx': [0, 0.6, 0.32, 1.9, -0.5, 1.5, 0.7, 1.5, 1, 0.6],
        'hR.ry': C(0.15), 'hL.ry': C(-0.15),
        'thL.rx': [0, -0.2, 0.12, -1.1, 0.22, -0.2, 0.32, -0.8, -0.5, -1.3, 0.7, -1.25, 1, -0.1],
        'shL.rx': [0, 0.3, 0.12, 1.5, 0.22, 0.3, 0.32, 1.3, -0.5, 1.5, 0.7, 1.45, 1, 0.1],
        'thR.rx': [0, -0.1, 0.12, -0.95, 0.22, -0.1, 0.32, -0.3, -0.5, 0.5, 0.7, 0.5, 1, 0],
        'shR.rx': [0, 0.3, 0.12, 1.5, 0.22, 0.3, 0.32, 1.0, -0.5, 0.9, 0.7, 0.9, 1, 0.1],
        'ftR.rx': [0, 0, -0.5, 0.5, 0.7, 0.5, 1, 0],
        'cape1.rx': [0, 0.1, 0.12, -0.3, 0.22, 0.2, 0.32, 0.7, -0.5, 0.3, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.12, -0.4, 0.22, 0.2, 0.36, 0.6, -0.55, 0.3, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.12, -0.4, 0.22, 0.2, 0.4, 0.5, -0.6, 0.25, 1, 0.1],
      },
    });
    // 战锤「震地」：下蹲蓄力 → 跃起、锤举过头 → 落地砸进地面（k0）→ 定住
    {
      const I = LOCO_2H[G_HAM].idle;
      defClip(rig, 'w_hammer', {
        dur: 0.9, k0: 0.55, air: 'jump', fade: 0.06, out: 0.26, trail: [0.4, 0.6],
        hand: track(I, [
          [0, 'I'],
          [0.15, [-0.12, 0.8, 0.32], [-0.2, 0.3, 0.93], [0, 0, 1]],
          [0.36, [0, 2.3, -0.08], [0, 0.25, -0.97], [0, 1, 0.2]],
          [-0.55, [0, 0.52, 0.76], [0, -0.45, 0.89], [0, -0.89, -0.45]],
          [0.75, [0, 0.5, 0.75], [0, -0.47, 0.88], [0, -0.88, -0.47]],
          [1, 'I'],
        ], 'model'),
        keys: {
          'root.oy': [0, 0, 0.15, -0.25, 0.36, 0.32, -0.55, -0.5, 0.75, -0.48, 1, 0],
          'root.rx': [0, 0.05, 0.15, 0.15, 0.36, -0.25, -0.55, 0.32, 0.75, 0.3, 1, 0.05],
          'spine.rx': [0, 0, 0.36, -0.2, -0.55, 0.15, 0.75, 0.14, 1, 0],
          'chest.rx': [0, 0, 0.36, -0.2, -0.55, 0.1, 0.75, 0.1, 1, 0],
          'head.rx': [0, 0, 0.36, 0.15, -0.55, -0.35, 0.75, -0.3, 1, 0],
          'thL.rx': [0, -0.1, 0.15, -0.8, 0.36, -0.5, -0.55, -1.35, 0.75, -1.3, 1, -0.05],
          'shL.rx': [0, 0.1, 0.15, 1.2, 0.36, 0.9, -0.55, 1.5, 0.75, 1.45, 1, 0.08],
          'thR.rx': [0, 0, 0.15, -0.6, 0.36, 0.1, -0.55, 0.2, 0.75, 0.2, 1, 0],
          'shR.rx': [0, 0.1, 0.15, 1.1, 0.36, 0.8, -0.55, 1.3, 0.75, 1.25, 1, 0.08],
          'ftR.rx': [0, 0, -0.55, 0.35, 0.75, 0.35, 1, 0],
          'thL.rz': [0, 0.07, -0.55, 0.3, 0.75, 0.3, 1, 0.07],
          'thR.rz': [0, -0.07, -0.55, -0.3, 0.75, -0.3, 1, -0.07],
          'cape1.rx': [0, 0.1, 0.36, -0.2, -0.55, 0.7, 0.75, 0.4, 1, 0.1],
          'cape2.rx': [0, 0.1, 0.36, -0.25, -0.58, 0.6, 0.8, 0.35, 1, 0.1],
          'cape3.rx': [0, 0.1, 0.36, -0.25, -0.62, 0.5, 0.85, 0.3, 1, 0.1],
        },
      });
    }
    // 长弓「箭雨」：侧身举弓斜指天空、搭箭拉满 → 撒放（k0）→ 定住
    {
      const AIM = [0, 0.8, 0.6], GRIP = [0.15, 1.95, 0.63], DRAW = 0.46;
      const nock = GRIP.map((v, i) => v - AIM[i] * DRAW), rest = GRIP.map((v, i) => v - AIM[i] * 0.17);
      const out = [nock[0] - 0.08, nock[1] - AIM[1] * 0.12, nock[2] - AIM[2] * 0.12 - 0.06];
      const bowD = [0, 0.6, -0.8], handE = [0, -0.6, 0.8];
      defClip(rig, 'w_bow', {
        dur: 0.8, k0: 0.55, lower: LEGS, fade: 0.08, out: 0.24, arrow: true,
        draw: [0, 0, 0.15, 0, 0.45, 1, 0.54, 1, -0.57, 0, 1, 0],
        handL: { f: 'model', k: [0, 0.15, 0.75, 1], p: [[0.4, 0.85, 0.1], GRIP, GRIP, [0.4, 0.85, 0.1]], d: [bowD, bowD, bowD, bowD], e: [AIM, AIM, AIM, AIM], w: [0, 1, 1, 0] },
        hand: { f: 'model', k: [0, 0.15, 0.45, 0.54, -0.57, 0.75, 1], p: [[-0.4, 0.85, 0.05], rest, nock, nock, out, out, [-0.4, 0.85, 0.05]], d: [AIM, AIM, AIM, AIM, AIM, AIM, AIM], e: [handE, handE, handE, handE, handE, handE, handE], w: [0, 1, 1, 1, 1, 1, 0] },
        keys: {
          'wA.s': [0, 0, 0.12, 0, 0.16, 1, 0.55, 1, 0.56, 0, 1, 0],
          'root.ry': [0, 0, 0.15, -0.8, 0.75, -0.8, 1, 0],
          'chest.ry': [0, 0, 0.15, -0.3, 0.75, -0.3, 1, 0],
          'head.ry': [0, 0, 0.15, 0.9, 0.75, 0.9, 1, 0],
          'head.rx': [0, 0, 0.15, -0.4, 0.75, -0.4, 1, 0],
          'chest.rx': [0, 0, 0.2, -0.12, 0.54, -0.12, -0.58, -0.22, 0.75, -0.14, 1, 0],
          'thL.rz': [0, 0.07, 0.15, 0.22, 0.75, 0.22, 1, 0.07],
          'thR.rz': [0, -0.07, 0.15, -0.22, 0.75, -0.22, 1, -0.07],
          'thL.rx': [0, 0, 0.15, -0.15, 0.75, -0.15, 1, 0],
          'shL.rx': [0, 0.06, 0.15, 0.3, 0.75, 0.3, 1, 0.06],
          'shR.rx': [0, 0.06, 0.15, 0.25, 0.75, 0.25, 1, 0.06],
          'cape1.rx': [0, 0.1, 0.55, 0.1, 0.6, 0.3, 1, 0.1],
        },
      });
    }
    // 太刀「瞬断」：压低重心、刀收在右胯后 → 冲刺中一刀横斩到左前方（k0）→ 定住（延迟的斩线在这段落下）→ 甩刀收势
    {
      const I = LOCO_2H[G_KAT].idle;
      defClip(rig, 'w_katana', {
        dur: 0.9, k0: 0.3, lower: null, fade: 0.05, out: 0.24, trail: [0.15, 0.34],
        hand: track(I, [
          [0, 'I'],
          [0.15, [-0.3, -0.36, -0.04], [-0.25, -0.3, -0.92], [0.5, 0, -0.2]],
          [-0.3, [0.16, -0.08, 0.48], [0.88, 0.02, 0.47], [0.47, 0, -0.88]],
          [0.62, [0.16, -0.08, 0.47], [0.88, 0, 0.47], [0.47, 0, -0.88]],
          [-0.76, [-0.18, -0.3, 0.36], [-0.35, -0.45, 0.82], [0, -0.9, -0.4]],
          [0.86, [-0.18, -0.32, 0.36], [-0.35, -0.48, 0.8], [0, -0.9, -0.4]],
          [1, 'I'],
        ]),
        keys: {
          'root.oy': [0, 0, 0.15, -0.3, -0.3, -0.45, 0.62, -0.42, 0.8, -0.3, 1, 0],
          'root.rx': [0, 0.05, 0.15, 0.25, -0.3, 0.4, 0.62, 0.38, 0.8, 0.2, 1, 0.04],
          'root.ry': [0, 0, 0.15, -0.35, -0.3, 0.35, 0.62, 0.3, 1, 0],
          'spine.ry': [0, 0, 0.15, -0.3, -0.3, 0.3, 0.62, 0.25, 1, 0],
          'chest.ry': [0, 0, 0.15, -0.5, -0.3, 0.45, 0.62, 0.4, 0.8, 0.1, 1, 0],
          'head.ry': [0, 0, 0.15, 0.6, -0.3, -0.4, 0.62, -0.35, 1, 0],
          'thL.rx': [0, -0.1, 0.15, -0.7, -0.3, -1.5, 0.62, -1.45, 0.8, -0.9, 1, -0.05],
          'shL.rx': [0, 0.1, 0.15, 1.1, -0.3, 1.45, 0.62, 1.45, 0.8, 1.0, 1, 0.08],
          'thR.rx': [0, 0, 0.15, 0.2, -0.3, 0.75, 0.62, 0.7, 0.8, 0.4, 1, 0],
          'shR.rx': [0, 0.1, 0.15, 0.9, -0.3, 0.35, 0.62, 0.35, 0.8, 0.6, 1, 0.08],
          'ftR.rx': [0, 0, -0.3, 0.7, 0.62, 0.7, 1, 0],
          'cape1.rx': [0, 0.1, 0.15, 0, -0.3, 0.9, 0.62, 0.5, 1, 0.1],
          'cape2.rx': [0, 0.1, 0.15, 0, -0.33, 0.8, 0.66, 0.45, 1, 0.1],
          'cape3.rx': [0, 0.1, 0.15, 0, -0.36, 0.7, 0.7, 0.4, 1, 0.1],
          'tab.rx': [0, 0, -0.3, -0.6, 0.62, -0.3, 1, 0],
        },
      });
    }
    // 魂幡「魂潮」：把幡高举过头、后仰蓄势 → 朝前猛地一挥，杆头压向准星（k0：魂灵脱幡而出），左手顺势前指 → 定住，幡布被甩得猎猎翻卷 → 收回
    {
      const P0 = [-0.42, 0.95, 0.2], UP = [0, 1, 0], FWD = [0, 0, 1];
      const RAISE = [-0.3, 2.0, -0.02], RD = [0.08, 0.98, -0.18], RE = [0, 0.18, 0.98];
      const THR = [-0.24, 1.45, 0.62], TD = [0.12, 0.5, 0.86], TE = [0, -0.86, 0.5];
      defClip(rig, 'w_banner', {
        dur: 0.8, k0: 0.46, lower: LEGS, fade: 0.06, out: 0.24,
        hand: {
          f: 'model', k: [0, 0.1, 0.32, -0.46, 0.72, 1],
          p: [P0, P0, RAISE, THR, [-0.24, 1.42, 0.6], P0], d: [UP, UP, RD, TD, TD, UP], e: [FWD, FWD, RE, TE, TE, FWD], w: [0, 1, 1, 1, 1, 0],
        },
        keys: stance({
          'root.oz': [0, 0, 0.32, -0.1, -0.46, 0.26, 0.72, 0.22, 1, 0.02],
          'root.rx': [0, 0.04, 0.32, -0.14, -0.46, 0.26, 0.72, 0.22, 1, 0.04],
          'root.ry': [0, 0, 0.32, -0.2, -0.46, 0.15, 0.72, 0.12, 1, 0],
          'spine.rx': [0, 0, 0.32, -0.12, -0.46, 0.14, 0.72, 0.12, 1, 0],
          'chest.rx': [0, 0, 0.32, -0.16, -0.46, 0.12, 0.72, 0.1, 1, 0],
          'chest.ry': [0, 0, 0.32, -0.3, -0.46, 0.22, 0.72, 0.18, 1, 0],
          'head.rx': [0, 0, 0.32, -0.25, -0.46, 0.15, 1, 0],
          'head.ry': [0, 0, 0.32, 0.3, -0.46, -0.2, 1, 0],
          'uaL.rx': [0, 0, 0.32, 0.5, -0.46, -1.45, 0.72, -1.35, 1, 0],
          'uaL.rz': [0, 0.12, 0.32, 0.5, -0.46, 0.15, 0.72, 0.15, 1, 0.12],
          'faL.rx': [0, -0.3, 0.32, -1.2, -0.46, -0.15, 0.72, -0.2, 1, -0.3],
          'hL.rx': [0, 0, 0.32, 0.3, -0.46, -0.5, 0.72, -0.45, 1, 0],
          'cape1.rx': [0, 0.1, 0.32, -0.1, -0.46, 0.65, 0.72, 0.45, 1, 0.1],
          'cape2.rx': [0, 0.1, 0.32, -0.15, -0.5, 0.6, 0.76, 0.4, 1, 0.1],
          'cape3.rx': [0, 0.1, 0.32, -0.15, -0.54, 0.5, 0.8, 0.35, 1, 0.1],
        }, 0.9),
      });
    }

    // ===== 烬铸技 =====
    // 太刀「千刃归烬」的收刀：最后一闪落地，背对着一地斩痕——刀往右下一甩（血振），再横过身前慢慢送回左胯的鞘里，
    // 「咔」的一声入鞘（k0），斩痕一齐炸开；定住片刻，起身
    {
      const I = LOCO_2H[G_KAT].idle;
      defClip(rig, 'u_katana', {
        dur: 0.84, k0: 0.55, lower: null, fade: 0.04, out: 0.24, trail: [0.04, 0.24],
        hand: track(I, [
          [0, [-0.38, -0.18, 0.4], [-0.8, -0.2, 0.56], [0, -1, 0]],
          [-0.18, [-0.56, -0.34, 0.26], [-0.86, -0.46, 0.2], [0, -1, 0]],
          [0.34, [-0.2, -0.38, 0.42], [0.55, -0.15, -0.82], [0, 1, 0]],
          [-0.55, [0.2, -0.44, 0.14], [0.18, -0.22, -0.96], [0, 1, 0]],
          [0.86, [0.2, -0.44, 0.14], [0.18, -0.22, -0.96], [0, 1, 0]],
          [1, 'I'],
        ]),
        keys: {
          'root.oy': [0, -0.32, 0.18, -0.42, -0.55, -0.48, 0.86, -0.44, 1, 0],
          'root.rx': [0, 0.3, 0.18, 0.38, -0.55, 0.22, 0.86, 0.2, 1, 0.04],
          'root.ry': [0, 0.3, 0.18, 0.45, -0.55, -0.15, 0.86, -0.15, 1, 0],
          'spine.ry': [0, 0.2, 0.18, 0.3, -0.55, -0.2, 0.86, -0.18, 1, 0],
          'chest.ry': [0, 0.3, 0.18, 0.45, -0.55, -0.3, 0.86, -0.28, 1, 0],
          'chest.rx': [0, 0, -0.55, 0.12, 0.86, 0.1, 1, 0],
          'head.ry': [0, -0.3, 0.18, -0.5, -0.55, 0.35, 0.86, 0.32, 1, 0],
          'head.rx': [0, 0, -0.55, 0.22, 0.86, 0.2, 1, 0],
          'thL.rx': [0, -1.3, 0.18, -1.45, -0.55, -1.4, 0.86, -1.35, 1, -0.05],
          'shL.rx': [0, 1.4, 0.18, 1.5, -0.55, 1.5, 0.86, 1.45, 1, 0.08],
          'thR.rx': [0, 0.6, 0.18, 0.7, -0.55, 0.75, 0.86, 0.7, 1, 0],
          'shR.rx': [0, 0.4, 0.18, 0.4, -0.55, 0.5, 0.86, 0.5, 1, 0.08],
          'ftR.rx': [0, 0.6, 0.86, 0.6, 1, 0],
          'cape1.rx': [0, 0.7, 0.18, 0.9, -0.55, 0.4, 0.86, 0.25, 1, 0.1],
          'cape2.rx': [0, 0.6, 0.2, 0.8, -0.58, 0.35, 0.88, 0.22, 1, 0.1],
          'cape3.rx': [0, 0.5, 0.22, 0.7, -0.6, 0.3, 0.9, 0.2, 1, 0.1],
          'tab.rx': [0, -0.4, -0.55, -0.15, 1, 0],
        },
      });
    }
    // 长杖「三相天灾」：双手把杖高举过头、后仰望天（k0：风暴落下），举着定住，再收回
    defClip(rig, 'u_staff', {
      dur: 1.0, k0: 0.42, fade: 0.06, out: 0.26,
      keys: {
        'root.oy': [0, 0, 0.26, -0.14, -0.42, 0.06, 0.8, 0.04, 1, 0],
        'root.rx': [0, 0.05, 0.26, 0.1, -0.42, -0.14, 0.8, -0.12, 1, 0.04],
        'spine.rx': [0, 0, 0.26, 0.08, -0.42, -0.14, 0.8, -0.12, 1, 0],
        'chest.rx': [0, 0, 0.26, 0.05, -0.42, -0.3, 0.8, -0.26, 1, 0],
        'head.rx': [0, 0, 0.26, 0.1, -0.42, -0.55, 0.8, -0.48, 1, 0],
        'uaR.rx': [0, -0.3, 0.26, -1.6, -0.42, -2.95, 0.8, -2.9, 1, -0.3],
        'uaR.rz': [0, -0.14, 0.26, 0.05, -0.42, 0.12, 0.8, 0.1, 1, -0.14],
        'uaR.ry': C(0),
        'faR.rx': [0, -0.75, 0.26, -0.9, -0.42, -0.12, 0.8, -0.15, 1, -0.75],
        'hR.rx': [0, -0.75, 0.26, 0.4, -0.42, 1.35, 0.8, 1.3, 1, -0.75],
        'hR.ry': C(0), 'hR.rz': C(0.1),
        'uaL.rx': [0, 0, 0.26, -1.4, -0.42, -2.55, 0.8, -2.5, 1, 0],
        'uaL.rz': [0, 0.12, 0.26, -0.1, -0.42, -0.35, 0.8, -0.32, 1, 0.12],
        'faL.rx': [0, -0.3, 0.26, -0.9, -0.42, -0.45, 0.8, -0.45, 1, -0.3],
        'hL.rx': [0, 0, -0.42, 0.4, 1, 0],
        'thL.rx': [0, -0.1, 0.26, -0.45, -0.42, -0.3, 0.8, -0.3, 1, -0.05],
        'shL.rx': [0, 0.1, 0.26, 0.6, -0.42, 0.35, 0.8, 0.35, 1, 0.08],
        'thR.rx': [0, 0, 0.26, 0.2, -0.42, 0.3, 0.8, 0.3, 1, 0],
        'shR.rx': [0, 0.1, 0.26, 0.4, -0.42, 0.3, 0.8, 0.3, 1, 0.08],
        'thL.rz': [0, 0.07, -0.42, 0.24, 0.8, 0.24, 1, 0.07],
        'thR.rz': [0, -0.07, -0.42, -0.24, 0.8, -0.24, 1, -0.07],
        'cape1.rx': [0, 0.1, 0.26, 0.2, -0.42, 0.9, 0.8, 0.75, 1, 0.1],
        'cape2.rx': [0, 0.1, 0.28, 0.2, -0.46, 0.8, 0.84, 0.65, 1, 0.1],
        'cape3.rx': [0, 0.1, 0.3, 0.2, -0.5, 0.7, 0.88, 0.55, 1, 0.1],
      },
    });
    // 魂幡「万魂降临」：双手把魂幡举过头 → 猛地往下一杵，杆尾插进身前的地里（k0），幡杆竖着、人蹲成弓步 → 定住 → 拔起收回
    {
      const P0 = [-0.42, 0.95, 0.2], UP = [0, 1, 0], FWD = [0, 0, 1];
      const RAISE = [-0.18, 2.15, 0.22], PLANT = [-0.1, 0.92, 0.62], PD = [0, 1, 0.1];
      defClip(rig, 'u_banner', {
        dur: 1.0, k0: 0.5, fade: 0.06, out: 0.26,
        hand: {
          f: 'model', k: [0, 0.12, 0.34, -0.5, 0.82, 1],
          p: [P0, P0, RAISE, PLANT, PLANT, P0], d: [UP, UP, UP, PD, PD, UP], e: [FWD, FWD, FWD, FWD, FWD, FWD], w: [0, 1, 1, 1, 1, 0],
        },
        keys: {
          'root.oy': [0, 0, 0.34, 0.1, -0.5, -0.5, 0.82, -0.46, 1, 0],
          'root.rx': [0, 0.04, 0.34, -0.12, -0.5, 0.3, 0.82, 0.28, 1, 0.04],
          'root.oz': [0, 0, 0.34, -0.08, -0.5, 0.22, 0.82, 0.2, 1, 0],
          'spine.rx': [0, 0, 0.34, -0.15, -0.5, 0.14, 0.82, 0.12, 1, 0],
          'chest.rx': [0, 0, 0.34, -0.18, -0.5, 0.12, 0.82, 0.1, 1, 0],
          'head.rx': [0, 0, 0.34, -0.35, -0.5, 0.1, 0.82, 0.05, 1, 0],
          'uaL.rx': [0, 0, 0.34, -2.6, -0.5, -1.25, 0.82, -1.2, 1, 0],
          'uaL.rz': [0, 0.12, 0.34, -0.3, -0.5, -0.45, 0.82, -0.42, 1, 0.12],
          'faL.rx': [0, -0.3, 0.34, -0.4, -0.5, -0.5, 0.82, -0.5, 1, -0.3],
          'thL.rx': [0, -0.1, 0.34, -0.3, -0.5, -1.3, 0.82, -1.25, 1, -0.05],
          'shL.rx': [0, 0.1, 0.34, 0.3, -0.5, 1.5, 0.82, 1.45, 1, 0.08],
          'thR.rx': [0, 0, 0.34, 0.1, -0.5, 0.4, 0.82, 0.38, 1, 0],
          'shR.rx': [0, 0.1, 0.34, 0.2, -0.5, 1.35, 0.82, 1.3, 1, 0.08],
          'ftR.rx': [0, 0, -0.5, 0.45, 0.82, 0.45, 1, 0],
          'thL.rz': [0, 0.07, -0.5, 0.24, 0.82, 0.24, 1, 0.07],
          'thR.rz': [0, -0.07, -0.5, -0.24, 0.82, -0.24, 1, -0.07],
          'cape1.rx': [0, 0.1, 0.34, -0.2, -0.5, 0.8, 0.82, 0.5, 1, 0.1],
          'cape2.rx': [0, 0.1, 0.36, -0.25, -0.54, 0.7, 0.86, 0.45, 1, 0.1],
          'cape3.rx': [0, 0.1, 0.38, -0.25, -0.58, 0.6, 0.9, 0.4, 1, 0.1],
        },
      });
    }
  }

  // ----- 远程武器的动作：普攻 fire_<type>、R 技 r_<type>（另注册同名的 w_<type>，按旧的命名也播得出来）-----
  // 开火动作可以被连续重播（每发一次 W.play）：第 0 帧就是举枪瞄准的姿势，后坐只在开头一小段，之后一直保持瞄准，所以连射时姿势不跳
  function rangedClips(rig) {
    const C = (v) => [0, v, 1, v];
    const brace = (keys, d) => {
      keys['thL.rx'] = C(-0.45 * d);
      keys['shL.rx'] = C(0.6 * d);
      keys['thR.rx'] = C(0.3 * d);
      keys['shR.rx'] = C(0.4 * d);
      keys['ftR.rx'] = C(0.2 * d);
      keys['thL.rz'] = C(0.12);
      keys['thR.rz'] = C(-0.18);
      return keys;
    };
    const alias = (a, b) => { rig.clips[a] = rig.clips[b]; };
    // 机炮 / 喷枪的腰射：枪口对着胸口坐标系里的左前方（上身往右拧之后正好朝前）
    const HIP = GUN_LOCO[G_GAT].idle, hp = HIP.slice(0, 3), hd = HIP.slice(3, 6), he = HIP.slice(6, 9);
    const kick = (v, dz, dy) => [v[0], v[1] + dy, v[2] - dz];
    const hipTwist = { 'spine.ry': C(GUN_TWIST * 0.55), 'chest.ry': C(GUN_TWIST * 0.55), 'head.ry': C(-GUN_TWIST * 0.9), 'root.rx': C(-0.04) };
    // 转膛机炮：沉腰顶住后坐，枪身随每一发轻轻一震（机炮的转膛在 gunSpinPost 里转）
    defClip(rig, 'fire_gatling', {
      dur: 0.42, k0: 0.08, lower: LEGS, fade: 0.08, out: 0.3,
      hand: { k: [0, 0.06, 0.2, 1], p: [hp, kick(hp, 0.035, 0.01), hp, hp], d: [hd, [hd[0], hd[1] + 0.05, hd[2]], hd, hd], e: [he, he, he, he] },
      keys: brace(Object.assign({ 'chest.rx': [0, -0.08, 0.06, -0.12, 0.3, -0.08, 1, -0.08] }, hipTwist), 0.9),
    });
    // 熔光射线：双脚扎稳、上身后仰顶住，枪口对准（长按 ~3 秒；射线由 rangedFx 画）
    defClip(rig, 'r_gatling', {
      dur: 3.2, k0: 0.06, lower: null, fade: 0.12, out: 0.35,
      hand: { k: [0, 0.08, 1], p: [hp, kick(hp, -0.02, 0.03), kick(hp, -0.02, 0.03)], d: [hd, hd, hd], e: [he, he, he] },
      keys: brace(Object.assign({ 'chest.rx': [0, -0.1, 0.08, -0.2, 1, -0.2], 'root.oy': [0, 0, 0.1, -0.08, 1, -0.08] }, hipTwist), 1.3),
      fn(ent, p, k, t) {
        // 射线的反冲：整个人细细地抖
        const j = Math.sin(t * 71) * 0.012 + Math.sin(t * 43) * 0.008;
        p[ent.rig.J.chest] += j;
        p[ent.rig.J.root + 4] += j * 0.5;
      },
    });
    // 焚炉喷枪：弓步前压，枪口略向下扫，喷射中左右轻轻摆
    defClip(rig, 'fire_flamer', {
      dur: 0.5, k0: 0.08, lower: LEGS, fade: 0.08, out: 0.3,
      hand: { k: [0, 1], p: [kick(hp, -0.04, 0.02), kick(hp, -0.04, 0.02)], d: [[hd[0], -0.12, hd[2]], [hd[0], -0.12, hd[2]]], e: [he, he] },
      keys: brace(Object.assign({ 'chest.rx': C(0.08), 'spine.rx': C(0.06) }, hipTwist), 1.1),
      fn(ent, p, k, t) {
        p[ent.rig.J.chest + 1] += Math.sin(t * 5.5) * 0.06;
      },
    });
    // 焚天炎爆：把喷枪往身前一沉、枪口压向地面——蓄压（枪身发抖）→ 一口气泄掉全部热度（k0）→ 后坐着站起
    defClip(rig, 'r_flamer', {
      dur: 1.0, k0: 0.42, lower: null, fade: 0.08, out: 0.3,
      hand: {
        k: [0, 0.3, -0.42, 0.6, 1],
        p: [hp, [-0.02, -0.35, 0.28], [0.0, -0.48, 0.34], [0.0, -0.42, 0.24], hp],
        d: [hd, [0.4, -0.55, 0.73], [0.35, -0.8, 0.5], [0.4, -0.5, 0.75], hd],
        e: [he, [0, -0.8, -0.6], [0, -0.6, -0.8], [0, -0.85, -0.5], he],
      },
      keys: Object.assign({
        'root.oy': [0, 0, 0.3, -0.18, -0.42, -0.32, 0.6, -0.22, 1, 0],
        'spine.rx': [0, 0, 0.3, 0.18, -0.42, 0.3, 0.6, 0.12, 1, 0],
        'chest.rx': [0, 0, 0.3, 0.1, -0.42, 0.22, 0.6, -0.08, 1, 0],
        'thL.rx': [0, -0.1, 0.3, -0.9, 0.6, -0.8, 1, -0.05], 'shL.rx': [0, 0.1, 0.3, 1.1, 0.6, 1.0, 1, 0.08],
        'thR.rx': [0, 0, 0.3, 0.2, 0.6, 0.2, 1, 0], 'shR.rx': [0, 0.1, 0.3, 1.0, 0.6, 0.9, 1, 0.08],
        'thL.rz': C(0.18), 'thR.rz': C(-0.2),
        'cape1.rx': [0, 0.1, 0.42, 0.9, 0.7, 0.4, 1, 0.1], 'cape2.rx': [0, 0.1, 0.44, 0.8, 0.75, 0.35, 1, 0.1], 'cape3.rx': [0, 0.1, 0.46, 0.7, 0.8, 0.3, 1, 0.1],
      }, hipTwist),
      fn(ent, p, k, t) {
        if (k > 0.15 && k < 0.42) p[ent.rig.J.chest + 2] += Math.sin(t * 60) * 0.025 * (k - 0.15) * 4;
      },
    });
    // 烬铸左轮：拔枪（从胯边一抬就到肩高，k0 = 第一发）→ 枪口上跳 → 落回瞄准
    {
      // 模型空间：躯干侧身（右肩在前）不影响枪口方向
      const R0 = GUN_LOCO[G_REV].idle, aimP = [-0.28, 0.14, 0.52], aimD = [0.12, 0.0, 1], aimE = [0, -1, 0];
      const mP = [-0.2, 1.45, 0.64], mD = [0.04, 0, 1], low = [-0.36, 0.88, 0.18], lowD = [0.05, -0.55, 0.83], lowE = [0, -0.83, -0.55];
      defClip(rig, 'fire_revolver', {
        dur: 0.36, k0: 0.22, lower: LEGS, fade: 0.05, out: 0.28,
        hand: {
          f: 'model',
          k: [0, 0.18, -0.22, 0.34, 0.6, 1],
          p: [low, mP, mP, [mP[0], mP[1] + 0.07, mP[2] - 0.06], mP, mP],
          d: [lowD, mD, mD, [0.04, 0.55, 0.83], mD, mD],
          e: [lowE, aimE, aimE, [0, -0.83, 0.55], aimE, aimE],
          w: [0.6, 1, 1, 1, 1, 1],
        },
        keys: {
          'chest.ry': [0, 0, 0.18, 0.3, 1, 0.3], 'spine.ry': [0, 0, 0.18, 0.15, 1, 0.15], 'head.ry': [0, 0, 0.18, -0.4, 1, -0.4],
          'chest.rx': [0, 0, 0.22, 0, 0.34, -0.06, 0.6, 0, 1, 0],
        },
      });
      // 乱射：边走边朝四面八方扇射——右臂一圈一圈地甩，左手在击锤上来回拨（腿交给步态，移动不受影响）
      defClip(rig, 'r_revolver', {
        dur: 3.0, k0: 0.03, lower: LEGS, fade: 0.08, out: 0.3,
        hand: { k: [0, 1], p: [aimP, aimP], d: [aimD, aimD], e: [aimE, aimE] },
        handL: { k: [0, 1], p: [[-0.12, 0.12, 0.42], [-0.12, 0.12, 0.42]], d: [[0, 0.3, 1], [0, 0.3, 1]], e: [[0, -1, 0.3], [0, -1, 0.3]], w: [1, 1] },
        keys: { 'head.rx': C(0.1) },
        fn(ent, p, k, t) {
          // 上身绕着转：乱射是「朝四面八方」，靠躯干的扭动 + 手臂摆角把枪口甩向各个方向
          const J = ent.rig.J, a = t * 9.5;
          p[J.spine + 1] = Math.sin(a) * 0.7;
          p[J.chest + 1] = Math.sin(a + 0.6) * 0.55;
          p[J.chest] = -0.05 + Math.sin(a * 2.3) * 0.06;
          p[J.root + 4] += Math.abs(Math.sin(t * 31)) * 0.015;
        },
      });
    }
    // 弓：侧身举弓平射——左手把弓推到肩前，右手从弦上拉到下巴边（k = 0.15→0.42 拉满）→ 撒放（k0）→ 回身
    {
      const AIM = [0, 0.03, 1], GRIP = [0.08, 1.45, 0.62], DRAW = 0.5;
      const nock = GRIP.map((v, i) => v - AIM[i] * DRAW), rest = GRIP.map((v, i) => v - AIM[i] * 0.17);
      const out = [nock[0] - 0.1, nock[1] + 0.02, nock[2] - 0.08];
      const bowD = [0, 0.97, -0.03], handE = [0, -0.03, 1], lowL = [0.4, 0.85, 0.1], lowR = [-0.4, 0.85, 0.05];
      const bowSpec = (dur, k0, extra) => Object.assign({
        dur, k0, lower: LEGS, fade: 0.06, out: 0.22, arrow: true,
        draw: [0, 0, 0.12, 0, k0 - 0.04, 1, -k0 - 0.02, 0, 1, 0],
        handL: { f: 'model', k: [0, 0.1, 0.85, 1], p: [lowL, GRIP, GRIP, lowL], d: [bowD, bowD, bowD, bowD], e: [AIM, AIM, AIM, AIM], w: [0.3, 1, 1, 0] },
        hand: { f: 'model', k: [0, 0.1, k0 - 0.06, k0, -k0 - 0.03, 0.85, 1], p: [lowR, rest, nock, nock, out, out, lowR], d: [AIM, AIM, AIM, AIM, AIM, AIM, AIM], e: [handE, handE, handE, handE, handE, handE, handE], w: [0.3, 1, 1, 1, 1, 1, 0] },
        keys: {
          'wA.s': [0, 0, 0.08, 0, 0.12, 1, k0, 1, k0 + 0.01, 0, 1, 0],
          'root.ry': [0, 0, 0.1, -0.85, 0.85, -0.85, 1, 0],
          'chest.ry': [0, 0, 0.1, -0.35, 0.85, -0.35, 1, 0],
          'head.ry': [0, 0, 0.1, 1.05, 0.85, 1.05, 1, 0],
          'chest.rx': [0, 0, 0.12, -0.05, k0, -0.05, k0 + 0.03, -0.14, 0.85, -0.06, 1, 0],
          'thL.rz': C(0.2), 'thR.rz': C(-0.2),
          'cape1.rx': [0, 0.1, k0, 0.1, k0 + 0.05, 0.35, 1, 0.1],
        },
      }, extra || {});
      for (const t of BOW_TYPES) defClip(rig, 'fire_' + t, bowSpec(t === 'eagle' ? 0.62 : t === 'huntbow' ? 0.48 : 0.55, t === 'eagle' ? 0.6 : 0.52));
      alias('fire_bow', 'fire_eagle');
      // R：把弓高举过头、一声弦鸣（专注灌满后的增益）——弓身朝天、右手在弦上一勾一放，身后余势
      const upG = [0.05, 2.05, 0.25], upD = [0, 0.3, -0.95], upA = [0, 0.95, 0.3];
      for (const t of BOW_TYPES) {
        defClip(rig, 'r_' + t, {
          dur: 0.75, k0: 0.45, lower: LEGS, fade: 0.06, out: 0.28,
          draw: [0, 0, 0.2, 0, 0.4, 0.8, -0.47, 0, 1, 0],
          handL: { f: 'model', k: [0, 0.25, 0.7, 1], p: [lowL, upG, upG, lowL], d: [upD, upD, upD, upD], e: [upA, upA, upA, upA], w: [0.2, 1, 1, 0] },
          hand: { f: 'model', k: [0, 0.25, 0.42, -0.47, 0.7, 1], p: [lowR, [-0.05, 1.75, 0.18], [-0.05, 1.62, 0.12], [-0.3, 1.5, 0.05], [-0.3, 1.5, 0.05], lowR], d: [upA, upA, upA, upA, upA, upA], w: [0.2, 1, 1, 1, 1, 0] },
          keys: {
            'root.oy': [0, 0, 0.3, -0.06, -0.45, 0.06, 0.7, 0, 1, 0],
            'chest.rx': [0, 0, 0.3, -0.18, 0.7, -0.12, 1, 0],
            'head.rx': [0, 0, 0.3, -0.45, 0.7, -0.3, 1, 0],
            'cape1.rx': [0, 0.1, 0.45, 0.8, 1, 0.1], 'cape2.rx': [0, 0.1, 0.47, 0.7, 1, 0.1], 'cape3.rx': [0, 0.1, 0.49, 0.6, 1, 0.1],
          },
        });
      }
      alias('r_bow', 'r_eagle');
    }
    for (const t of GUN_TYPES.concat(BOW_TYPES, ['bow'])) if (!rig.clips['w_' + t] && rig.clips['r_' + t]) alias('w_' + t, 'r_' + t);
  }

  // 武器的握法 / 挂点长度 / 稀有度的发光
  // 挂点 weapon（武器尖端 / 长弓的上弓梢 / 魂幡杆头的魂火）相对武器关节的 [x, y, z]
  const GEAR_TIP = [[0, 0, 1.17], [0, 0, 1.54], [0, 0, 0.68], [0, 0, 0.5], [0, 0, 1.0], [BOW_TIP[0] - 0.39, BOW_TIP[1] - 0.84, BOW_TIP[2] - 0.05], [0, 0.04, 1.12], [0, 0, 1.84],
    [0, GUN_AX, GUN_MUZ.gatling - 0.05], [0, GUN_AX, GUN_MUZ.flamer - 0.05], [0, GUN_AX, GUN_MUZ.revolver - 0.05]];
  // 第 4 档是烬铸：余烬橙的自发光比稀有更亮，光晕更大（见 applyGear），武器上不停往上飘火星（见下面的 gear 更新）
  const GEAR_GLOW = [[0xcfd6e2, 0.3], [0x7f9dff, 1.15], [0xffd75e, 1.5], [0xff7424, 2.4]];
  // 个别武器的烬铸档换一种光色（只换这一把，不动其他烬铸武器）：冰弓凛羽是冰蓝，光晕和飘落的东西也跟着换（见 applyGear 与下面的 gear 更新）
  const GEAR_GLOW_VAR = { emberbow: [0x58b8ff, 2.0] };
  // 稀有度光晕：[沿武器的位置（占挂点长度的比例）, 魔法的大小, 稀有的大小, 不透明度]。
  // 刃的光裹着刃身；长杖 / 短杖握在头和胸口旁边，光只罩住杖头的晶体，小而淡，不把兜帽和上身照成一片白；
  // 双匕只罩右手那把；战锤罩住锤头；长弓的光在握把上；太刀和刃一样裹着刃身；魂幡罩住杆头的魂火
  const GEAR_AURA = [[0.62, 1.0, 1.5, 1], [0.885, 0.5, 0.72, 0.5], [0.81, 0.42, 0.6, 0.5], [0.55, 0.55, 0.85, 0.8], [0.95, 0.75, 1.1, 0.75], [0, 0.75, 1.05, 0.6], [0.6, 1.0, 1.5, 1], [1, 0.55, 0.8, 0.55],
    [0.3, 0.7, 1.0, 0.6], [0.3, 0.65, 0.95, 0.6], [0.45, 0.5, 0.75, 0.7]];
  const auraMats = Object.create(null);
  function auraMat(hex, alpha) {
    const key = hex + ':' + alpha;
    return (
      auraMats[key] ||
      (auraMats[key] = new T.SpriteMaterial({ map: glowTex(), color: lin(hex), opacity: alpha, transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }))
    );
  }
  function applyGear(ent, type, rar, vn) {
    ent.gearType = type;
    ent.gearRar = rar;
    ent.gearVar = vn || (type === G_BOW ? 'eagle' : type >= G_GAT ? GEAR_KEYS[type] : null);
    if (ent.vMesh) for (const k in ent.vMesh) for (const m of ent.vMesh[k]) m.visible = k === ent.gearVar;
    const sw = ent.sock.weapon, tip = type < 0 ? null : GEAR_TIP[type];
    sw.j = ent.rig.JI[type < 0 ? 'hR' : GEAR_JOINT[type]];
    sw.x = tip ? tip[0] : 0;
    sw.y = tip ? tip[1] : 0;
    sw.z = tip ? tip[2] : 0.05;
    // 挂点 hand：刀光的根部。长弓挥的是左手里的弓
    const sh = ent.sock.hand, hj = type === G_BOW ? 'hL' : 'hR';
    sh.j = ent.rig.JI[hj];
    sh.x = 0;
    sh.y = type === G_BOW ? -0.1 : -0.06;
    sh.z = type === G_BOW ? 0.05 : 0.02;
    ent.gearClips = (type >= 0 && ent.rig.gearClips[type]) || null;
    const gg = (rar >= 3 && GEAR_GLOW_VAR[ent.gearVar]) || GEAR_GLOW[rar] || GEAR_GLOW[0], m = ent.auxMat;
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
      ent.aura.scale.setScalar(rar >= 3 ? ga[2] * 1.3 : rar >= 2 ? ga[2] : ga[1]);
    }
  }
  function makePlayerEnt() {
    const ent = newEnt('player', playerRig(), WH, 0xff8a3a, 1.15); // 元素色 = 左手余烬的橙（设计稿 2.3 #ff8a3a）
    ent.sock = { weapon: { j: 0, x: 0, y: 0, z: 1 }, hand: { j: 0, x: 0, y: -0.06, z: 0.02 } };
    ent.gearType = 0;
    ent.gearClips = null;
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
    const type = w ? gearIndex(w.baseIdx | 0) : -1, rar = w ? G.clamp(w.rarity | 0, 0, 3) : 0;
    const vn = w ? gearVariant(baseType(w.baseIdx | 0)) : null;
    if (type !== ent.gearType || rar !== ent.gearRar || (vn || null) !== (ent.gearVar || null)) applyGear(ent, type, rar, vn);
  }
  // 玩家的武器模型跟着装备走：equip 是存档里的 { slot: item }。
  // 武器底材的 type（G.BASES.weapon[baseIdx].type：blade / staff / wand / daggers / hammer / bow / katana / banner）决定手里拿什么，
  // 稀有度决定武器上那道光的颜色和强度；没有武器时空手。
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
    return rigOf('husk', () => cTry('husk', (cs) => {
      const HIDE = 0x8a7f76, HIDE_D = 0x4a4340, CLOTH = 0x2d2734, CLOTH_L = 0x4a4152, CLOTH_IN = 0x17141b, BONE = 0xded5ba, BONE_D = 0x9c927a;
      const b = rigBuilder('husk', NB_SMALL, cs);
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
      cApply(rig, cs);
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
    }));
  }

  // ---------------------------------------------------------------------
  // 巨躯：山一样的肩背，小脑袋埋在肩窝里，一双石锤似的前臂拖到地面，背上顶着元素晶簇
  // ---------------------------------------------------------------------
  function bruteRig() {
    return rigOf('brute', () => {
      // 卡通：皮换成冷的板岩蓝灰（旧的粉褐和暖褐地面混在一起），背上的石块浅一档，腰布是一块浓红
      const HIDE = 0x6c76aa, HIDE_D = 0x3a406e, BELLY = 0x98a0c2, DARK = 0x2a2834, STONE = 0x8a86a2, STONE_D = 0x504c68, BONE = 0xd8ccb0, IRON = 0x4e4e5c, CLOTH = 0x9a2e28, CLOTH_IN = 0x3a1414;
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
  // ---------------------------------------------------------------------
  // 喷吐者（C 模型）：蜘蛛。骨架照着模型的骨骼建（身体、胸、头、腹 + 八条腿各三节），动作取模型自带的
  // 待机 / 走 / 攻击 / 死亡 / 跳（蓄力用跳之前那一下下蹲），失衡是程序化的。没有模型时用下面的程序化喷吐者
  // ---------------------------------------------------------------------
  const SP_LEGS = ['FrontLeg', 'MidFrontLeg', 'MidBackLeg', 'BackLeg'];
  // 一组采样好的关键帧 → 通道下标 + 关键帧（和 defClip 一样的格式），按归一化时间 k 写进姿态（w：混合权重）
  function cTrack(rig, keys) {
    const ci = [], cK = [];
    for (const key in keys) {
      const dot = key.indexOf('.'), j = rig.JI[key.slice(0, dot)];
      if (j === undefined) continue;
      ci.push(j * CH + CHI[key.slice(dot + 1)]);
      cK.push(keys[key]);
    }
    return { ci, cK };
  }
  function cTrackEval(tr, p, k, w) {
    for (let i = 0; i < tr.ci.length; i++) {
      const ix = tr.ci[i];
      p[ix] += (kf(tr.cK[i], k) - p[ix]) * w;
    }
  }
  function spiderRig(cs) {
    const b = rigBuilder('spitter', 28, cs);
    b.j('root', null, 0, 0.4, 0).j('thx', 'root', 0, 0.4, 0.2).j('head', 'thx', 0, 0.4, 0.3).j('abd', 'root', 0, 0.4, -0.3);
    cs.pivot = { root: 'Body', thx: 'Thorax', head: 'Head', abd: 'Abdomen' };
    for (const L of SP_LEGS) {
      for (const s of ['L', 'R']) {
        b.j(L + s, 'root', 0, 0.4, 0).j(L + '2' + s, L + s, 0, 0.4, 0).j(L + '3' + s, L + '2' + s, 0, 0.4, 0);
        for (const n of [L + s, L + '2' + s, L + '3' + s]) cs.pivot[n] = n;
      }
    }
    const rig = b.build({ height: 0.8, reach: 1.4, stride: 4.4, shade: 0 }); // stride：按腿尖着地时的滑动量调的（模型走一个周期约 1.4 米）
    cApply(rig, cs);
    rig.hitJ = [rig.J.thx, rig.J.abd];
    const idle = cClipKeys(rig, cs, 'Spider_Idle', { fps: 15 }), walk = cClipKeys(rig, cs, 'Spider_Walk', { fps: 30 });
    const idleT = cTrack(rig, idle.keys), walkT = cTrack(rig, walk.keys);
    rig.loco = function (ent, p, t) {
      cTrackEval(idleT, p, (((t + ent.phase * 3) / idle.dur) % 1 + 1) % 1, 1);
      if (ent.mv > 0.01) cTrackEval(walkT, p, (((ent.walk / TAU) % 1) + 1) % 1, Math.min(1, ent.mv * 1.2));
    };
    rig.post = function (ent, o, t) {
      // 余烬囊一鼓一鼓地亮；蓄力时越来越亮，吐出去那一下最亮
      const c = ent.clip;
      let k = 0.85 + 0.2 * Math.sin(t * 3.1 + ent.phase);
      if (c && c.name === 'windup') k += 0.9 * ent.cK;
      else if (c && c.name === 'attack') k += 1.2 * hump(ent.cK, 0, c.k0, c.k0 + 0.05, c.k0 + 0.35);
      setGlow(ent, k);
    };
    // 蓄力：跳之前那一下下蹲、前腿抬起（定格）
    const jump = cClipKeys(rig, cs, 'Spider_Jump', { fps: 30, to: 0.3 });
    defClip(rig, 'windup', { dur: 0.45, hold: true, fade: 0.08, base: 'rest', keys: jump.keys });
    // 喷吐：模型的扑咬，命中帧在前腿砸下、头往前探的那一刻
    const atk = cClipKeys(rig, cs, 'Spider_Attack', { fps: 30 });
    defClip(rig, 'attack', { dur: 0.55, k0: 0.42, fade: 0.05, out: 0.2, base: 'rest', keys: atk.keys });
    const die = cClipKeys(rig, cs, 'Spider_Death', { fps: 30 });
    // 模型的死亡动作先把身子弹起将近一个身高再翻过去：压成一下小跳
    const dy = die.keys['root.oy'];
    if (dy) for (let k = 1; k < dy.length; k += 2) if (dy[k] > 0) dy[k] *= 0.25;
    defClip(rig, 'death', { dur: 0.75, base: 'rest', hold: true, fade: 0.05, keys: die.keys });
    // 失衡：身子趴低、八条腿往外摊开，打着晃
    const legJ = [];
    SP_LEGS.forEach((L, i) => ['L', 'R'].forEach((s) => legJ.push([rig.J[L + s], rig.J[L + '2' + s], s === 'L' ? 1 : -1, i])));
    defClip(rig, 'stagger', {
      dur: 1.4, loop: true, fade: 0.15, out: 0.25,
      fn(ent, p, k) {
        const J = rig.J, a = k * TAU, s = Math.sin(a);
        p[J.root + 4] -= 0.12;
        p[J.root + 2] += 0.12 * s;
        p[J.root] += 0.08 * Math.cos(a);
        p[J.head] += 0.25 + 0.1 * Math.sin(a * 2);
        p[J.abd] -= 0.2;
        for (const [hip, knee, sd, i] of legJ) {
          p[hip + 2] -= sd * (0.22 + 0.06 * Math.sin(a + i));
          p[knee + 2] += sd * 0.2;
        }
      },
    });
    sock(rig, 'weapon', 'head', 0, 0.02, 0.2);
    for (const k in cs.sock || {}) {
      const q = cs.sock[k];
      sock(rig, k, q[0], q[1], q[2], q[3]);
    }
    return rig;
  }
  function spitterRig() {
    return rigOf('spitter', () => cTry('spitter', (cs) => (cs ? spiderRig(cs) : spitterProc())));
  }
  function spitterProc() {
    return (() => {
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
    })();
  }

  // ---------------------------------------------------------------------
  // 爆裂虫：六条短腿驮着一颗被甲肋箍住的发光腹囊，囊比身子还大，头前顶着一对引信似的触角
  // ---------------------------------------------------------------------
  function bomberRig() {
    return rigOf('bomber', () => {
      const SHELL = 0x5e5876, SHELL_D = 0x343048, PALE = 0xaea4ba, HORN = 0xd6ceb8; // 卡通：甲壳抬亮一档、偏蓝紫
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

  // ---------------------------------------------------------------------
  // 隙影：没有腿的兜帽身影，罩袍收成一条拖尾悬在地面上方；裂开的瓷面具上竖着一道发亮的裂口，
  // 细长的手臂末端是三根碎晶指，身边绕着三片小碎晶
  // ---------------------------------------------------------------------
  function phaserRig() {
    return rigOf('phaser', () => {
      const ROBE = 0x2e4866, ROBE_L = 0x4c6c92, ROBE_IN = 0x141c28, MASK = 0xe2e0d2, MASK_D = 0x9a9a8c, GLASS = 0xa6cdc2, GLASS_D = 0x58786f, DARK = 0x1a2030; // 卡通：袍子从炭灰换成钢蓝
      const b = rigBuilder('phaser', NB_SMALL);
      b.j('root', null, 0, 1.15, 0).j('body', 'root', 0, 1.45, 0.02).j('head', 'body', 0, 1.98, 0.08);
      b.j('uaL', 'body', 0.27, 1.8, 0.04).j('faL', 'uaL', 0.42, 1.42, 0.12).j('uaR', 'body', -0.27, 1.8, 0.04).j('faR', 'uaR', -0.42, 1.42, 0.12);
      b.j('tail1', 'root', 0, 1.05, -0.04).j('tail2', 'tail1', 0, 0.6, -0.16).j('orb', 'body', 0, 1.6, 0);

      // 罩袍下摆，撕成几条
      b.at('tail1').surf(SURF.cloth);
      b.pd(gLathe('ph/robe', [[0.13, 0.56], [0.26, 0.76], [0.34, 1.0], [0.31, 1.26]], 9), [ROBE, ROBE_L], ROBE_IN, 0, 0, -0.04);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU + 0.4;
        b.pd(gPlate('ph/tat' + (k % 2), [[-0.08, 0], [0.08, 0], [0.03, -0.32 + (k % 2) * 0.08], [-0.03, -0.22]], 0.008, 0.002), ROBE, ROBE_IN, Math.sin(a) * 0.29, 0.66, Math.cos(a) * 0.27 - 0.04, -0.2, a, 0);
      }
      // 拖尾：越往下越细，尾梢一点余光
      b.at('tail2').pd(gLathe('ph/tail', [[0.01, 0.1], [0.07, 0.28], [0.12, 0.46], [0.14, 0.62]], 8), [ROBE_IN, ROBE], ROBE_IN, 0, 0, -0.16);
      b.g(gSph(0.045, 6, 4), 0.8, 0, 0.12, -0.16);

      // 躯干：前胸一道竖裂透出元素光，肩头顶着碎晶，背后一片短披
      b.at('body').surf(SURF.cloth);
      b.p(gSph(0.24, 9, 7), [ROBE, ROBE_L], 0, 1.52, 0.02, 0, 0, 0, 1.05, 1.2, 0.85);
      b.pd(gDrape('ph/mantle', [[0.36, 1.3], [0.36, 1.55], [0.3, 1.78], [0.14, 1.92]], 3.6, 8), [ROBE, ROBE_L], ROBE_IN, 0, 0, 0.02);
      b.g(gBox(0.05, 0.3, 0.05), 1, 0, 1.52, 0.22, 0, 0, 0.15).g(gBox(0.03, 0.15, 0.04), 0.85, 0.05, 1.42, 0.21, 0, 0, -0.55);
      b.surf(SURF.ice, true);
      for (const s of [1, -1]) {
        b.p(gOct(0.1), [GLASS_D, GLASS], s * 0.3, 1.88, 0, 0, 0, -s * 0.3, 0.8, 2.2, 0.8);
        b.p(gOct(0.07), GLASS, s * 0.38, 1.8, -0.08, 0.3, 0, -s * 0.75, 0.7, 1.8, 0.7);
      }

      // 头：兜帽（前面敞开）+ 瓷面具，竖着的发光裂口，额上三根晶刺
      b.at('head').surf(SURF.cloth);
      b.pd(gDrape('ph/hood', [[0.03, 2.3], [0.17, 2.22], [0.23, 2.02], [0.21, 1.82]], 4.3, 9), [ROBE, ROBE_L], ROBE_IN, 0, 0, 0.04, -0.12);
      b.surf(SURF.bone).p(gSph(0.15, 9, 7), [MASK_D, MASK], 0, 2.0, 0.1, 0.1, 0, 0, 0.85, 1.12, 0.75);
      b.surf(SURF.cloth);
      for (const s of [1, -1]) b.p(gSph(0.032, 6, 4), DARK, s * 0.058, 2.05, 0.205, 0, 0, 0, 1.3, 0.8, 0.6);
      b.g(gBox(0.026, 0.22, 0.03), 1, 0, 1.99, 0.215, 0.1, 0, 0.12);
      b.surf(SURF.ice, true).p(gOct(0.05), GLASS, 0, 2.3, 0.04, -0.2, 0, 0, 0.6, 2.6, 0.6);
      for (const s of [1, -1]) b.p(gOct(0.04), GLASS_D, s * 0.1, 2.25, 0.04, -0.15, 0, -s * 0.45, 0.6, 2.2, 0.6);

      // 手臂：细瘦的上臂，碎晶前臂，三根长指（指尖带元素光）
      for (const s of [1, -1]) {
        const U = s > 0 ? 'uaL' : 'uaR', F = s > 0 ? 'faL' : 'faR';
        b.at(U).surf(SURF.cloth).limb([ROBE, ROBE_L], s * 0.27, 1.8, 0.04, s * 0.42, 1.42, 0.12, 0.065, 0.05, 6, 2);
        b.at(F).surf(SURF.ice).limb([DARK, GLASS_D], s * 0.42, 1.42, 0.12, s * 0.47, 1.1, 0.26, 0.045, 0.035, 6, 0);
        for (let k = -1; k <= 1; k++) {
          const x = s * 0.47 + k * 0.045;
          b.p(gSweep('ph/fing' + s + k, [[x, 1.09, 0.27], [x + k * 0.03, 0.96, 0.38], [x + k * 0.04, 0.82, 0.4]], [0.024, 0.018, 0.004], 4), [GLASS_D, GLASS], 0, 0, 0);
          b.g(gSph(0.018, 5, 3), 0.8, x + k * 0.04, 0.83, 0.4);
        }
      }
      // 身边绕着的三片碎晶（post 里转）
      b.at('orb');
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU;
        b.g(gOct(0.075), 1, Math.sin(a) * 0.6, 1.6 + (k - 1) * 0.12, Math.cos(a) * 0.6, 0, 0, 0, 0.7, 1.6, 0.7);
      }

      const rig = b.build({ height: 2.35, reach: 1.4, stride: 3, shade: 0.15 });
      rig.hitJ = [rig.J.head, rig.J.body];
      sock(rig, 'weapon', 'faR', -0.05, -0.58, 0.28);
      sock(rig, 'hand', 'faL', 0.05, -0.58, 0.28);
      sock(rig, 'head', 'head', 0, 0.1, 0.1);
      sock(rig, 'chest', 'body', 0, 0.05, 0.2);
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, id = 1 - mv, run = Math.min(1.2, ent.spd / 4.4) * mv;
        const a = Math.sin(t * 1.8 + ent.phase), a2 = Math.sin(t * 1.1 + ent.phase * 2);
        p[J.root + 4] = 0.12 + 0.08 * a; // 悬着，一起一伏
        p[J.root] = 0.28 * run + 0.03 * a2; // 朝行进方向前倾
        p[J.root + 2] = 0.05 * a2 * id;
        p[J.body] = 0.05 + 0.04 * a2;
        p[J.head] = -0.1 - 0.18 * run + 0.05 * a;
        p[J.head + 2] = 0.14 * Math.sin(t * 0.9 + ent.phase) * id;
        p[J.uaL] = -0.25 + 0.45 * run + 0.08 * a;
        p[J.uaR] = -0.25 + 0.45 * run + 0.08 * a2;
        p[J.uaL + 2] = 0.22 + 0.05 * a;
        p[J.uaR + 2] = -0.22 - 0.05 * a;
        p[J.faL] = -0.5 + 0.1 * a2;
        p[J.faR] = -0.5 + 0.1 * a;
        p[J.tail1] = 0.15 + 0.55 * run + 0.06 * a2;
        p[J.tail1 + 2] = 0.1 * Math.sin(t * 1.4 + ent.phase);
        p[J.tail2] = 0.2 + 0.45 * run + 0.1 * a;
        p[J.tail2 + 2] = 0.16 * Math.sin(t * 1.4 + ent.phase - 0.9);
      };
      rig.post = function (ent, o, t) {
        o[rig.J.orb + 1] = t * 2.4 + ent.phase;
        setGlow(ent, 0.85 + 0.15 * Math.sin(t * 4 + ent.phase));
      };
      // 蓄力：双手合拢在胸前聚光，后仰，碎晶环收紧发亮
      defClip(rig, 'windup', {
        dur: 0.45, hold: true, fade: 0.08,
        keys: {
          'root.oz': [0, 0, 1, -0.1], 'body.rx': [0, 0.05, 1, -0.25], 'head.rx': [0, -0.1, 1, -0.3],
          'uaL.rx': [0, -0.25, 1, -1.1], 'uaL.rz': [0, 0.22, 1, -0.3], 'faL.rx': [0, -0.5, 1, -0.5],
          'uaR.rx': [0, -0.25, 1, -1.1], 'uaR.rz': [0, -0.22, 1, 0.3], 'faR.rx': [0, -0.5, 1, -0.5],
          'orb.s': [0, 1, 1, 0.7], 'tail1.rx': [0, 0.15, 1, 0.35],
        },
      });
      // 出手：双臂猛地推出去，碎晶环炸开再收回
      defClip(rig, 'attack', {
        dur: 0.4, k0: 0.3, fade: 0.03, out: 0.2,
        keys: {
          'root.oz': [0, -0.1, -0.3, 0.12, 1, 0], 'body.rx': [0, -0.25, -0.3, 0.3, 1, 0.05], 'head.rx': [0, -0.3, -0.3, 0.15, 1, -0.1],
          'uaL.rx': [0, -1.1, -0.3, -1.5, 0.7, -1.3, 1, -0.3], 'uaL.rz': [0, -0.3, -0.3, 0.25, 1, 0.22], 'faL.rx': [0, -0.5, -0.3, -0.05, 1, -0.5],
          'uaR.rx': [0, -1.1, -0.3, -1.5, 0.7, -1.3, 1, -0.3], 'uaR.rz': [0, 0.3, -0.3, -0.25, 1, -0.22], 'faR.rx': [0, -0.5, -0.3, -0.05, 1, -0.5],
          'orb.s': [0, 0.7, -0.3, 1.5, 1, 1], 'tail1.rx': [0, 0.35, -0.3, -0.1, 1, 0.15],
        },
      });
      // 闪身：原地一拧，缩成一点
      defClip(rig, 'blink', {
        dur: 0.45, hold: true, fade: 0.05,
        keys: {
          'root.s': [0, 1, 0.3, 1.15, -1, 0.04], 'root.ry': [0, 0, 1, 3.6], 'root.oy': [0, 0.12, 0.35, 0.3, 1, 0.6],
          'uaL.rx': [0, -0.25, 1, -0.4], 'uaL.rz': [0, 0.22, 1, -0.6], 'uaR.rx': [0, -0.25, 1, -0.4], 'uaR.rz': [0, -0.22, 1, 0.6],
          'head.rx': [0, -0.1, 1, 0.4], 'tail1.rx': [0, 0.15, 1, -0.4], 'orb.s': [0, 1, 1, 0.3],
        },
      });
      // 现身：反着拧出来，双臂张开
      defClip(rig, 'appear', {
        dur: 0.3, fade: 0.01, out: 0.12,
        keys: {
          'root.s': [0, 0.04, -0.6, 1.12, 1, 1], 'root.ry': [0, -3.2, 0.7, 0, 1, 0], 'root.oy': [0, 0.6, 0.7, 0.15, 1, 0.12],
          'uaL.rx': [0, -0.4, 0.6, -0.9, 1, -0.6], 'uaL.rz': [0, -0.6, 0.6, 0.7, 1, 0.3], 'uaR.rx': [0, -0.4, 0.6, -0.9, 1, -0.6], 'uaR.rz': [0, 0.6, 0.6, -0.7, 1, -0.3],
          'orb.s': [0, 0.3, 0.6, 1.4, 1, 1],
        },
      });
      // 失衡：歪着头晃荡，手臂垂软
      defClip(rig, 'stagger', {
        dur: 1.4, loop: true, fade: 0.12, out: 0.25,
        keys: { 'faL.rx': [0, -0.15, 1, -0.15], 'faR.rx': [0, -0.15, 1, -0.15] },
        fn(ent, p, k) {
          const J = rig.J, a = k * TAU, s = Math.sin(a);
          p[J.root + 4] = 0.02 + 0.04 * Math.sin(a * 2);
          p[J.root + 2] = 0.16 * s;
          p[J.body] = 0.35 + 0.06 * Math.cos(a);
          p[J.head] = 0.4 + 0.1 * Math.sin(a * 2);
          p[J.head + 2] = 0.35 * Math.sin(a + 0.8);
          p[J.uaL] = 0.15 + 0.2 * Math.sin(a + 1.5);
          p[J.uaR] = 0.15 + 0.2 * Math.sin(a + 2.6);
          p[J.uaL + 2] = 0.1;
          p[J.uaR + 2] = -0.1;
        },
      });
      // 死亡：面具裂开似的仰头一抽，然后整团塌落在地，碎晶散落
      defClip(rig, 'death', {
        dur: 0.8, base: 'rest', hold: true, air: true, fade: 0.05,
        keys: {
          'root.oy': [0, 0.1, 0.25, 0.2, -0.8, -0.82, 1, -0.84], 'root.rx': [0, 0, 0.25, -0.35, -0.8, 1.2, 1, 1.25], 'root.rz': [0, 0, 1, 0.3],
          'body.rx': [0, 0, 0.25, -0.3, 1, 0.3], 'head.rx': [0, 0, 0.25, -0.7, 0.8, 0.4, 1, 0.3], 'head.rz': [0, 0, 1, 0.6],
          'uaL.rx': [0, -0.3, 0.25, -2.2, 0.8, -2.6, 1, -2.7], 'uaL.rz': [0, 0.2, 0.25, 1.0, 1, 1.1],
          'uaR.rx': [0, -0.3, 0.25, -2.0, 0.8, -1.6, 1, -1.7], 'uaR.rz': [0, -0.2, 0.25, -1.0, 1, -1.2],
          'tail1.rx': [0, 0.15, 0.6, -0.8, 1, -1.0], 'tail2.rx': [0, 0.2, 0.7, -0.6, 1, -0.7],
          'orb.oy': [0, 0, 0.3, 0.2, -0.85, -1.5, 1, -1.5], 'orb.s': [0, 1, 0.3, 1.4, 1, 0.5],
        },
      });
      return rig;
    });
  }

  // ---------------------------------------------------------------------
  // 陨角兽：矮壮的四足兽，额前顶着一根前弯的星晶巨角，背上叠着石甲、甲缝里透出元素光，短而粗的四条腿
  // ---------------------------------------------------------------------
  function chargerRig() {
    return rigOf('charger', () => {
      const HIDE = 0x6e6a60, HIDE_D = 0x3e3c36, BELLY = 0x9a9682, PLATE = 0x7e8c84, PLATE_D = 0x46524c, HORN = 0xbfe0d4, HORN_D = 0x6e948a, HOOF = 0x26282a, BONE = 0xd8d0b8; // 卡通：抬亮一档
      const b = rigBuilder('charger', NB_SMALL);
      b.j('root', null, 0, 1.0, -0.1).j('chest', 'root', 0, 1.1, 0.45).j('head', 'chest', 0, 1.05, 1.05).j('jaw', 'head', 0, 0.86, 1.22);
      const LEG = [['FL', 1, 0.72], ['FR', -1, 0.72], ['BL', 1, -0.62], ['BR', -1, -0.62]];
      for (const [n, sx, z] of LEG) b.j('u' + n, z > 0 ? 'chest' : 'root', sx * 0.42, 0.95, z).j('d' + n, 'u' + n, sx * 0.44, 0.5, z + (z > 0 ? 0.04 : -0.06));
      b.j('tail', 'root', 0, 1.15, -0.95);

      // 后躯与前胸：前高后低的一整块肉，肩背隆起
      b.at('root').surf(SURF.hide);
      b.p(gSph(0.55, 10, 8), [BELLY, HIDE], 0, 1.02, -0.38, 0.1, 0, 0, 1, 0.82, 1.12);
      b.surf(SURF.stone, true).p(gRBox(0.8, 0.22, 0.6, 0.06), [PLATE_D, PLATE], 0, 1.5, -0.42, -0.12);
      b.g(gBox(0.5, 0.05, 0.08), 0.85, 0, 1.55, -0.1, -0.12);
      b.at('chest').surf(SURF.hide);
      b.p(gSph(0.62, 10, 8), [BELLY, HIDE], 0, 1.15, 0.45, -0.1, 0, 0, 1.05, 0.98, 1.0);
      b.surf(SURF.stone, true);
      b.p(gRBox(1.0, 0.26, 0.7, 0.07), [PLATE_D, PLATE], 0, 1.74, 0.42, 0.1).p(gRBox(0.78, 0.22, 0.5, 0.06), PLATE, 0, 1.82, 0.12, -0.05);
      b.g(gBox(0.62, 0.05, 0.08), 0.9, 0, 1.78, 0.78, 0.1);
      b.surf(SURF.ice, true);
      for (let k = 0; k < 3; k++) b.p(gOct(0.08), [HORN_D, HORN], (k - 1) * 0.22, 1.95 - Math.abs(k - 1) * 0.06, 0.32 - Math.abs(k - 1) * 0.05, -0.3, 0, (k - 1) * -0.4, 0.8, 2.2, 0.8);

      // 头：低垂的宽额，前弯的星晶巨角，两侧短角，獠牙
      b.at('head').surf(SURF.hide);
      b.p(gSph(0.32, 9, 7), [HIDE_D, HIDE], 0, 1.0, 1.2, 0.2, 0, 0, 0.95, 0.82, 1.3);
      b.p(gCyl(0.16, 0.22, 0.4, 7), HIDE_D, 0, 0.88, 1.52, HALF_PI + 0.35);
      b.surf(SURF.stone, true).p(gRBox(0.5, 0.14, 0.4, 0.04), PLATE, 0, 1.22, 1.22, -0.25);
      b.surf(SURF.ice).p(gSweep('cg/horn', [[0, 1.18, 1.33], [0, 1.46, 1.78], [0, 1.92, 2.0], [0, 2.32, 1.86]], [0.2, 0.15, 0.08, 0.014], 7), [HORN_D, HORN], 0, 0, 0);
      b.g(gSph(0.06, 6, 4), 1, 0, 2.31, 1.86).g(gBox(0.035, 0.42, 0.05), 0.85, 0, 1.66, 1.93, 0.75).g(gBox(0.03, 0.22, 0.04), 0.7, 0, 2.08, 1.99, -0.2);
      for (const s of [1, -1]) {
        b.surf(SURF.bone).p(gSweep('cg/side' + s, [[s * 0.22, 1.1, 1.2], [s * 0.4, 1.18, 1.25], [s * 0.48, 1.32, 1.36]], [0.06, 0.04, 0.008], 5), BONE, 0, 0, 0);
        b.g(gSph(0.035, 6, 4), 1, s * 0.17, 1.06, 1.45);
      }
      b.at('jaw').surf(SURF.hide).p(gRBox(0.3, 0.1, 0.38, 0.04), HIDE_D, 0, 0.78, 1.42, 0.2);
      b.surf(SURF.bone, true);
      for (const s of [1, -1]) b.p(gCone(0.04, 0.22, 4), BONE, s * 0.13, 0.86, 1.58, -0.6);

      // 腿：粗短，膝下一截深色，蹄
      for (const [n, sx, z] of LEG) {
        const dz = z + (z > 0 ? 0.04 : -0.06);
        b.at('u' + n).surf(SURF.hide).limb([HIDE_D, HIDE], sx * 0.42, 0.98, z, sx * 0.44, 0.5, dz, 0.17, 0.13, 7, 2);
        b.at('d' + n).limb(HIDE_D, sx * 0.44, 0.5, dz, sx * 0.44, 0.12, dz + 0.02, 0.12, 0.1, 7, 0);
        b.surf(SURF.stone, true).p(gCyl(0.12, 0.15, 0.14, 7), HOOF, sx * 0.44, 0.07, dz + 0.03);
      }
      b.at('tail').surf(SURF.hide).limb(HIDE, 0, 1.15, -0.95, 0, 0.82, -1.12, 0.06, 0.035, 6, 2);
      b.surf(SURF.ice, true).p(gOct(0.06), HORN, 0, 0.76, -1.15, 0, 0, 0, 0.8, 1.8, 0.8);

      const rig = b.build({ height: 2.0, reach: 1.7, stride: 3.2, shade: 0.3 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      sock(rig, 'weapon', 'head', 0, 0.8, 0.75);
      sock(rig, 'hand', 'head', 0, 0, 0.45);
      sock(rig, 'head', 'head', 0, 0.15, 0.1);
      sock(rig, 'chest', 'chest', 0, 0.2, 0.3);
      const LJ = LEG.map(([n, , z]) => [rig.J['u' + n], rig.J['d' + n], z > 0 ? 1 : -1]);
      const LPH = [0, Math.PI, Math.PI, 0]; // 对角步
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, w = ent.walk, id = 1 - mv, run = Math.min(1.3, ent.spd / 4.2) * mv;
        const a = Math.sin(t * 1.5 + ent.phase), a2 = Math.sin(t * 0.9 + ent.phase * 2);
        p[J.root + 4] = 0.05 * Math.cos(2 * w) * run + 0.015 * a * id;
        p[J.root] = 0.02 * a2 * id;
        p[J.root + 2] = 0.04 * Math.sin(w) * run;
        p[J.chest] = 0.03 * a + 0.04 * Math.sin(2 * w) * run;
        p[J.head] = 0.05 + 0.06 * a2 + 0.08 * run;
        p[J.head + 1] = 0.25 * Math.sin(t * 0.7 + ent.phase) * id;
        p[J.jaw] = 0.05 + 0.08 * Math.max(0, a);
        p[J.tail] = 0.3 + 0.1 * a;
        p[J.tail + 2] = 0.35 * Math.sin(t * 2.2 + ent.phase);
        for (let i = 0; i < 4; i++) {
          const L = LJ[i], ph = w + LPH[i], s = Math.sin(ph), up = Math.max(0, Math.cos(ph));
          p[L[0]] += -0.55 * s * run;
          p[L[1]] += L[2] * 0.7 * up * run;
        }
      };
      rig.post = function (ent, o, t) {
        setGlow(ent, 0.85 + 0.15 * Math.sin(t * 2.5 + ent.phase));
      };
      // 蓄力：压低脑袋把角对准，后蹄刨地
      defClip(rig, 'windup', {
        dur: 0.8, hold: true, fade: 0.08,
        keys: {
          'root.oz': [0, 0, 1, -0.18], 'root.rx': [0, 0, 1, 0.08], 'chest.rx': [0, 0, 1, 0.22], 'head.rx': [0, 0.05, 1, 0.42], 'jaw.rx': [0, 0.05, 1, 0.3],
          'uBL.rx': [0, 0, 1, -0.25], 'dBL.rx': [0, 0, 1, -0.35], 'uBR.rx': [0, 0, 1, -0.25], 'dBR.rx': [0, 0, 1, -0.35],
          'tail.rx': [0, 0.3, 1, -0.4],
        },
        fn(ent, p, k) {
          // 右前蹄往后刨三下
          const J = rig.J, s = Math.max(0, Math.sin(k * TAU * 3));
          p[J.uFR] += 0.5 * s - 0.15;
          p[J.dFR] += 0.6 * s;
          p[J.head + 2] = 0.08 * Math.sin(k * TAU * 3);
        },
      });
      // 冲锋：四蹄腾跃的跑法，脑袋压低，尾巴绷直
      defClip(rig, 'charge', {
        dur: 0.36, loop: true, fade: 0.06, out: 0.2,
        keys: { 'head.rx': [0, 0.45, 1, 0.45], 'tail.rx': [0, -0.6, 1, -0.6] },
        fn(ent, p, k) {
          const J = rig.J, a = k * TAU, s = Math.sin(a), c = Math.cos(a);
          p[J.root] = 0.12 * s;
          p[J.root + 4] = 0.12 * Math.max(0, c);
          p[J.chest] = 0.2 + 0.08 * s;
          p[J.head] += 0.06 * c;
          for (const [u, d, sg] of LJ) {
            const ph = sg > 0 ? a : a + 2.2, ss = Math.sin(ph), up = Math.max(0, Math.cos(ph));
            p[u] = -0.8 * ss;
            p[d] = sg * 0.9 * up;
          }
        },
      });
      // 顶角：脑袋从下往上猛挑
      defClip(rig, 'attack', {
        dur: 0.42, k0: 0.35, fade: 0.03, out: 0.2,
        keys: {
          'root.oz': [0, -0.18, -0.35, 0.3, 1, 0], 'chest.rx': [0, 0.22, -0.35, -0.22, 0.7, -0.15, 1, 0], 'head.rx': [0, 0.42, -0.35, -0.65, 0.7, -0.45, 1, 0.05],
          'jaw.rx': [0, 0.3, -0.35, 0.05, 1, 0.05],
          'uFL.rx': [0, 0, -0.35, -0.5, 1, 0], 'uFR.rx': [0, 0, -0.35, -0.4, 1, 0], 'uBL.rx': [0, -0.25, -0.35, 0.3, 1, 0], 'uBR.rx': [0, -0.25, -0.35, 0.3, 1, 0],
        },
      });
      // 晕眩：脑袋耷拉着左右晃，四条腿叉开站不稳
      defClip(rig, 'stagger', {
        dur: 1.3, loop: true, fade: 0.12, out: 0.25,
        keys: { 'uFL.rz': [0, 0.2, 1, 0.2], 'uFR.rz': [0, -0.2, 1, -0.2], 'uBL.rz': [0, 0.15, 1, 0.15], 'uBR.rz': [0, -0.15, 1, -0.15] },
        fn(ent, p, k) {
          const J = rig.J, a = k * TAU;
          p[J.root + 2] = 0.12 * Math.sin(a);
          p[J.root + 4] = -0.08;
          p[J.chest] = 0.15 + 0.05 * Math.cos(a);
          p[J.head] = 0.5 + 0.1 * Math.sin(a * 2);
          p[J.head + 1] = 0.35 * Math.sin(a);
          p[J.head + 2] = 0.25 * Math.sin(a + 0.6);
          p[J.jaw] = 0.35;
        },
      });
      // 死亡：前腿一软跪倒，再侧翻过去，四蹄朝外僵住
      defClip(rig, 'death', {
        dur: 0.85, base: 'rest', hold: true, air: true, fade: 0.05,
        keys: {
          'root.rz': [0, 0, 0.35, 0.1, -0.85, 1.45, 1, 1.42], 'root.oy': [0, 0, 0.35, -0.22, -0.85, -0.42, 1, -0.44], 'root.rx': [0, 0, 0.35, 0.18, 1, 0.05],
          'chest.rx': [0, 0, 0.35, 0.25, 1, 0.05], 'head.rx': [0, 0, 0.35, 0.5, 0.85, -0.2, 1, -0.15], 'head.rz': [0, 0, 1, 0.3], 'jaw.rx': [0, 0, 1, 0.45],
          'uFL.rx': [0, 0, 0.35, -0.6, 1, -0.4], 'dFL.rx': [0, 0, 0.35, 1.2, 1, 0.3], 'uFR.rx': [0, 0, 0.35, -0.5, 1, -0.6], 'dFR.rx': [0, 0, 0.35, 1.1, 1, 0.2],
          'uBL.rx': [0, 0, 1, 0.4], 'uBR.rx': [0, 0, 1, 0.5], 'dBL.rx': [0, 0, 1, -0.2], 'dBR.rx': [0, 0, 1, -0.3],
          'tail.rx': [0, 0.3, 1, 0.9],
        },
      });
      return rig;
    });
  }

  const MOB_RIG = { husk: huskRig, brute: bruteRig, spitter: spitterRig, bomber: bomberRig, phaser: phaserRig, charger: chargerRig };

  W.makeMob = function (type, elemHex, elite) {
    const eh = hexOf(elemHex);
    // 躯体染一层和地面相反的冷暖色：火焰区地面偏暖 → 怪偏冷灰；其余区域地面偏冷 → 怪偏暖
    _c.set(eh);
    const warmGround = _c.r > 0.8 && _c.g < 0.6;
    // 卡通：染色收轻（旧的 0xc3cbe6 / 0xf6dfc4 是给暗色调压的，现在各怪的配色本身就按冷暖定好了）；
    // 冷色地面那一档几乎不偏暖（区域主光本来就是暖的，再染暖会把游魂的灰皮肤染成肉粉），只压暗一点，让主角仍是最亮的
    const ent = newEnt(type, MOB_RIG[type](), warmGround ? 0xe2e6f4 : 0xece6e0, eh, 1.1);
    if (warmGround) ent.uRim.value.setRGB(0.1, 0.13, 0.2);
    else ent.uRim.value.setRGB(0.2, 0.15, 0.1);
    // （旧：暗色的 C 模型轮廓光 ×1.5。卡通配色下角色不再是暗色，靠 TOON 的轮廓光分开，不再加强）
    if (elite) {
      // 精英：更大、发光更强，轮廓上镀一圈金
      ent.k = 1.35;
      ent.body.scale.setScalar(1.35);
      ent.glowK = 1.35;
      setGlow(ent, 1);
      // C 模型的面大而平，同样强度的金边会把整个身子染成土黄：收一点
      const rk = ent.rig.skin4 ? 0.42 : 1;
      ent.uRim.value.setRGB(0.5 * rk, 0.36 * rk, 0.12 * rk);
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
      const ROCK = 0xaaa6c0, ROCK_D = 0x66628a, SLAG = 0xbcaea6, IRON = 0x464456, DARK = 0x2e2c38; // 卡通：冷的浅板岩，和暖褐地面分开
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
      const CHIT = 0xb4c6da, CHIT_D = 0x6a82a0, ROBE = 0x30506e, ROBE_L = 0x4c7090, ROBE_IN = 0x16202e, DARK = 0x1c2434, SILK = 0xe4eef6; // 卡通：袍子换成亮一档的霜蓝，甲壳带一点蓝
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
      const MET = 0x6c6a94, MET_D = 0x383656, BRASS = 0xd8a84a, BRASS_D = 0x86652a, DARK = 0x222034; // 卡通：钢甲抬亮一档的靛蓝
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
      const OBS = 0x58405a, OBS_D = 0x2e2234, OBS_L = 0x80607e, CLOTH = 0xa82638, CLOTH_D = 0x5a1422, CLOTH_IN = 0x2a0a10, BONE = 0xe0d2b6, BONE_D = 0x9e8e76, GOLD = 0xd09a34; // 卡通：黑曜石抬成深紫红，披风更浓
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

  // ---------------------------------------------------------------------
  // 衔星巨兽：背上嵌着一块坠星的四足古兽。石甲覆背、甲缝透着星辉，长颈，额生星眼，
  // 一对琉璃巨角，口中能吐出横扫的星光射线
  // ---------------------------------------------------------------------
  function behemothRig() {
    return rigOf('behemoth', () => {
      const HIDE = 0x6c7a76, HIDE_D = 0x3c4846, BELLY = 0x949c88, PLATE = 0x8e9c96, PLATE_D = 0x505c58, GLASS = 0xc4ece1, GLASS_D = 0x6a988e, HOOF = 0x202424, BONE = 0xe0d8c2, BONE_D = 0x9c9682, DARK = 0x1a1e1e; // 卡通：抬亮一档
      const b = rigBuilder('behemoth', NB_BIG);
      b.j('root', null, 0, 2.5, -0.6).j('chest', 'root', 0, 2.7, 0.9).j('neck', 'chest', 0, 3.1, 1.9).j('head', 'neck', 0, 3.65, 2.75).j('jaw', 'head', 0, 3.42, 3.05);
      b.j('antL', 'head', 0.32, 4.05, 2.62).j('antR', 'head', -0.32, 4.05, 2.62).j('star', 'chest', 0, 3.85, 0.15);
      b.j('tail1', 'root', 0, 2.8, -2.1).j('tail2', 'tail1', 0, 2.45, -3.0);
      const LEGS = [['fL', 1, 'chest', 1.3, 1.45, 1.4], ['fR', -1, 'chest', 1.3, 1.45, 1.4], ['bL', 1, 'root', -1.3, -1.75, -1.55], ['bR', -1, 'root', -1.3, -1.75, -1.55]];
      for (const [n, sx, par, zu, zk, zh] of LEGS) b.j(n + 'u', par, sx * 0.95, 2.4, zu).j(n + 'k', n + 'u', sx * 1.0, 1.32, zk).j(n + 'h', n + 'k', sx * 1.0, 0.32, zh);

      // 后躯：低一截的臀，两块背甲，胯侧护甲
      b.at('root').surf(SURF.hide);
      b.p(gSph(1.05, 12, 9), [BELLY, HIDE], 0, 2.55, -1.05, 0.12, 0, 0, 1.0, 0.86, 1.15);
      b.surf(SURF.stone, true);
      b.p(gRBox(1.5, 0.35, 1.2, 0.1), [PLATE_D, PLATE], 0, 3.36, -1.1, -0.15);
      b.p(gRBox(1.2, 0.3, 0.9, 0.08), [PLATE_D, PLATE], 0, 3.18, -1.98, -0.42);
      for (const s of [1, -1]) b.p(gRBox(0.45, 0.75, 0.95, 0.08), PLATE_D, s * 0.98, 2.72, -1.2, 0, 0, -s * 0.25);
      b.g(gBox(1.0, 0.07, 0.1), 0.85, 0, 3.45, -0.5, -0.15).g(gBox(0.8, 0.06, 0.09), 0.75, 0, 3.3, -1.6, -0.3);

      // 前躯：宽厚的胸廓，肩甲，背甲，两肋几根外露的骨，肋下一道道星辉裂纹
      b.at('chest').surf(SURF.hide);
      b.p(gSph(1.2, 12, 9), [BELLY, HIDE], 0, 2.85, 0.72, -0.08, 0, 0, 1.05, 1.0, 1.12);
      b.surf(SURF.stone, true);
      b.p(gRBox(1.9, 0.4, 0.95, 0.1), [PLATE_D, PLATE], 0, 3.82, 1.08, 0.22);
      b.p(gRBox(1.7, 0.36, 0.8, 0.1), [PLATE_D, PLATE], 0, 3.74, -0.72, -0.12);
      for (const s of [1, -1]) {
        b.p(gRBox(0.5, 0.9, 1.0, 0.1), [PLATE_D, PLATE], s * 1.12, 3.1, 1.15, 0, 0, -s * 0.22);
        b.g(gBox(0.06, 0.95, 0.06), 0.8, s * 1.23, 2.75, 0.32, 0.45, 0, -s * 0.22).g(gBox(0.05, 0.6, 0.05), 0.7, s * 1.18, 2.55, -0.05, -0.3, 0, -s * 0.2);
        b.surf(SURF.bone);
        for (let i = 0; i < 3; i++) {
          const z = 0.1 + i * 0.4;
          b.p(gSweep('bh/rib' + s + i, [[s * 0.65, 3.6, z], [s * 1.18, 3.1, z + 0.08], [s * 1.18, 2.35, z + 0.14]], [0.07, 0.065, 0.035], 5), [BONE_D, BONE], 0, 0, 0);
        }
        b.surf(SURF.stone, true);
      }

      // 背上的坠星：一团亮核，裂开的石壳围着它，三根晶刺从壳缝里刺出来
      b.at('star');
      b.g(gIco(0.85, 1), 1, 0, 4.05, 0.15);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + 0.5;
        b.g(gOct(0.34), 0.9, Math.sin(a) * 0.6, 4.5, 0.15 + Math.cos(a) * 0.6, Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55, 0.6, 2.3, 0.6);
      }
      b.surf(SURF.stone, true);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU;
        b.p(gIco(0.48, 0), [PLATE_D, PLATE], Math.sin(a) * 0.72, 3.82, 0.15 + Math.cos(a) * 0.72, Math.cos(a) * 0.6, a, -Math.sin(a) * 0.6, 0.9, 0.55, 0.9);
      }

      // 长颈：粗颈 + 两片颈甲，颈脊一排琉璃晶鬃
      b.at('neck').surf(SURF.hide).limb([HIDE_D, HIDE], 0, 3.0, 1.7, 0, 3.55, 2.62, 0.64, 0.46, 9, 3);
      b.surf(SURF.stone, true).p(gRBox(0.85, 0.22, 0.55, 0.06), [PLATE_D, PLATE], 0, 3.72, 1.98, 0.62).p(gRBox(0.72, 0.2, 0.48, 0.06), PLATE, 0, 3.97, 2.36, 0.78);
      b.surf(SURF.ice, true);
      for (let k = 0; k < 4; k++) b.p(gOct(0.12), [GLASS_D, GLASS], (k % 2 ? 0.12 : -0.12), 3.98 + k * 0.1, 1.72 + k * 0.24, -0.65, 0, (k % 2 ? -0.25 : 0.25), 0.7, 2.4, 0.7);

      // 头：长吻，骨质额板，额心一只星眼，口中透光（张嘴才看得见），上颚一排獠牙
      b.at('head').surf(SURF.hide);
      b.p(gSph(0.55, 11, 8), [HIDE_D, HIDE], 0, 3.72, 2.9, 0.15, 0, 0, 0.85, 0.75, 1.2);
      b.p(gCyl(0.26, 0.36, 0.78, 8), HIDE_D, 0, 3.55, 3.42, HALF_PI + 0.3, 0, 0);
      b.surf(SURF.bone).p(gRBox(0.62, 0.16, 0.72, 0.05), [BONE_D, BONE], 0, 3.98, 3.02, 0.2);
      b.p(gRBox(0.36, 0.1, 0.4, 0.04), BONE, 0, 3.78, 3.55, 0.45);
      b.g(gSph(0.11, 8, 6), 1, 0, 4.02, 3.36).g(gSph(0.2, 8, 6), 1, 0, 3.45, 3.48, 0, 0, 0, 1, 0.55, 1.4);
      for (const s of [1, -1]) b.g(gSph(0.07, 6, 4), 1, s * 0.33, 3.78, 3.22);
      b.surf(SURF.bone, true);
      for (const s of [1, -1]) for (let k = 0; k < 3; k++) b.p(gCone(0.05, 0.2, 4), BONE, s * (0.11 + k * 0.08), 3.34, 3.66 - k * 0.16, Math.PI);
      // 下颚 + 一对上挑的獠牙
      b.at('jaw').surf(SURF.hide).p(gRBox(0.5, 0.16, 0.85, 0.05), HIDE_D, 0, 3.28, 3.42, 0.25);
      b.surf(SURF.bone);
      for (const s of [1, -1]) b.p(gSweep('bh/tusk' + s, [[s * 0.2, 3.3, 3.72], [s * 0.32, 3.48, 3.94], [s * 0.36, 3.76, 3.98]], [0.07, 0.05, 0.01], 5), [BONE_D, BONE], 0, 0, 0);
      // 角：琉璃质的分叉巨角，角梢发光
      for (const s of [1, -1]) {
        b.at(s > 0 ? 'antL' : 'antR').surf(SURF.ice);
        b.p(gSweep('bh/ant' + s, [[s * 0.3, 4.0, 2.65], [s * 0.75, 4.55, 2.45], [s * 1.25, 4.95, 2.05], [s * 1.55, 5.5, 1.8]], [0.13, 0.1, 0.07, 0.015], 6), [GLASS_D, GLASS], 0, 0, 0);
        b.p(gSweep('bh/tineA' + s, [[s * 0.7, 4.5, 2.47], [s * 0.76, 5.0, 2.75], [s * 0.7, 5.35, 2.86]], [0.07, 0.05, 0.01], 5), [GLASS_D, GLASS], 0, 0, 0);
        b.p(gSweep('bh/tineB' + s, [[s * 1.2, 4.92, 2.08], [s * 1.55, 5.0, 2.4], [s * 1.8, 5.15, 2.5]], [0.06, 0.04, 0.008], 5), [GLASS_D, GLASS], 0, 0, 0);
        b.g(gSph(0.06, 6, 4), 1, s * 1.55, 5.5, 1.8).g(gSph(0.05, 6, 4), 1, s * 0.7, 5.35, 2.86).g(gSph(0.05, 6, 4), 1, s * 1.8, 5.15, 2.5);
      }
      // 尾：两节，尾梢一根晶刺
      b.at('tail1').surf(SURF.hide).limb([HIDE_D, HIDE], 0, 2.8, -2.05, 0, 2.45, -3.0, 0.3, 0.2, 8, 1);
      b.at('tail2').limb(HIDE_D, 0, 2.45, -3.0, 0, 1.9, -3.7, 0.2, 0.08, 7, 1);
      b.surf(SURF.ice, true).p(gOct(0.16), GLASS, 0, 1.74, -3.86, 0.7, 0, 0, 0.8, 2.2, 0.8);
      b.g(gSph(0.07, 6, 4), 0.9, 0, 1.88, -3.72);
      // 腿：粗壮的上腿 + 膝甲，深色的小腿，宽蹄上箍着一圈星辉
      for (const [n, sx, , zu, zk, zh] of LEGS) {
        const front = zu > 0;
        b.at(n + 'u').surf(SURF.hide).limb([HIDE_D, HIDE], sx * 0.95, 2.5, zu, sx * 1.0, 1.32, zk, 0.45, 0.3, 8, 1);
        b.surf(SURF.stone, true).p(gRBox(0.5, 0.45, 0.6, 0.08), [PLATE_D, PLATE], sx * 1.08, 1.42, zk + (front ? 0.18 : -0.12), front ? 0.25 : -0.25, 0, -sx * 0.1);
        b.at(n + 'k').surf(SURF.hide).limb([DARK, HIDE_D], sx * 1.0, 1.32, zk, sx * 1.0, 0.36, zh, 0.27, 0.21, 8, 1);
        b.at(n + 'h').surf(SURF.stone, true).p(gCyl(0.3, 0.38, 0.36, 8), HOOF, sx * 1.0, 0.18, zh + 0.04);
        b.g(gTorus(0.31, 0.035, 4, 12), 0.75, sx * 1.0, 0.38, zh + 0.04, HALF_PI, 0, 0);
      }

      const rig = b.build({ height: 5.6, reach: 3.6, stride: 1.15, shade: 0.3 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.fLh, rig.JI.fRh, rig.JI.bLh, rig.JI.bRh];
      rig.ankle = 0.32;
      sock(rig, 'weapon', 'jaw', 0, 0.05, 0.45);
      sock(rig, 'hand', 'fLh', 0, -0.1, 0.1);
      sock(rig, 'head', 'head', 0, 0.45, 0.3);
      sock(rig, 'chest', 'star', 0, 0.15, 0);
      const LJ = LEGS.map(([n, , , zu]) => [rig.J[n + 'u'], rig.J[n + 'k'], rig.J[n + 'h'], zu > 0 ? 1 : -1]);
      const LPH = [0, Math.PI, Math.PI, 0]; // 对角步：左前与右后同步
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, w = ent.walk, id = 1 - mv, run = Math.min(1.2, ent.spd / 4.2) * mv;
        const br = Math.sin(t * 1.0 + ent.phase), a2 = Math.sin(t * 0.6 + ent.phase * 2);
        p[J.root + 2] = 0.035 * Math.sin(w) * run;
        p[J.root] = 0.02 * br * id;
        p[J.chest] = 0.02 * br + 0.04 * Math.sin(2 * w) * run;
        p[J.chest + 1] = 0.06 * Math.sin(w) * run;
        p[J.neck] = -0.05 + 0.05 * br + 0.08 * run;
        p[J.neck + 1] = 0.12 * a2 * id;
        p[J.head] = 0.05 - 0.04 * br - 0.06 * run;
        p[J.head + 1] = 0.15 * Math.sin(t * 0.45 + ent.phase) * id;
        p[J.jaw] = 0.05 + 0.05 * Math.max(0, br);
        p[J.tail1] = 0.2 + 0.05 * a2;
        p[J.tail1 + 1] = 0.2 * Math.sin(t * 0.9 + ent.phase) + 0.15 * Math.sin(w) * run;
        p[J.tail2] = 0.25 + 0.06 * br;
        p[J.tail2 + 1] = 0.25 * Math.sin(t * 0.9 + ent.phase - 0.8);
        for (let i = 0; i < 4; i++) {
          const L = LJ[i], ph = w + LPH[i], s = Math.sin(ph), up = Math.max(0, Math.cos(ph));
          p[L[0]] += -0.42 * s * run;
          p[L[1]] += L[3] * 0.7 * up * run;
          p[L[2]] += (-L[3] * 0.3 * up + 0.2 * s) * run;
        }
      };
      rig.post = function (ent, o, t, dt) {
        const J = rig.J, k = ent.coreK || 1;
        const sc = (1 + Math.sin(t * 2.6) * 0.05) * (1 + (k - 1) * 0.3); // 坠星只胀一点，亮度才是主要的变化
        o[J.star + 6] = o[J.star + 7] = o[J.star + 8] = sc;
        o[J.star + 1] = t * 0.25;
        setGlow(ent, 0.85 + 0.15 * Math.sin(t * 2.6) + (k - 1) * 0.9 + (ent.mouthK || 0) * 0.5);
        ent.coreK = 1 + (k - 1) * Math.max(0, 1 - dt * 5);
        ent.mouthK = (ent.mouthK || 0) * Math.max(0, 1 - dt * 4);
        if (!ent.dying) bossEmbers(ent, dt, 4.0, 1.0, 6);
      };
      const heat = (v) => (ent, p, k) => { ent.coreK = 1 + v * k; };
      const crouch = (v) => ({
        'fLu.rx': -0.45 * v, 'fLk.rx': 0.75 * v, 'fLh.rx': -0.3 * v, 'fRu.rx': -0.45 * v, 'fRk.rx': 0.75 * v, 'fRh.rx': -0.3 * v,
        'bLu.rx': 0.45 * v, 'bLk.rx': -0.75 * v, 'bLh.rx': 0.3 * v, 'bRu.rx': 0.45 * v, 'bRk.rx': -0.75 * v, 'bRh.rx': 0.3 * v,
      });
      // 践踏：人立而起，前蹄高抬
      defClip(rig, 'stomp_w', {
        dur: 0.95, hold: true, fade: 0.12,
        keys: {
          'root.rx': [0, 0, 0.6, -0.45, 1, -0.52], 'chest.rx': [0, 0, 1, -0.15],
          'neck.rx': [0, -0.05, 1, -0.45], 'head.rx': [0, 0.05, 1, 0.3], 'jaw.rx': [0, 0.05, 1, 0.45],
          'fLu.rx': [0, 0, 0.6, -1.0, 1, -1.15], 'fLk.rx': [0, 0, 0.6, 1.4, 1, 1.5], 'fRu.rx': [0, 0, 0.6, -0.8, 1, -0.95], 'fRk.rx': [0, 0, 0.6, 1.5, 1, 1.6],
          'bLu.rx': [0, 0, 1, 0.38], 'bLk.rx': [0, 0, 1, -0.3], 'bRu.rx': [0, 0, 1, 0.34], 'bRk.rx': [0, 0, 1, -0.25],
          'tail1.rx': [0, 0.2, 1, -0.3],
        },
        fn: heat(0.5),
      });
      defClip(rig, 'stomp', {
        dur: 0.6, k0: 0.22, fade: 0.03, out: 0.35,
        keys: {
          'root.rx': [0, -0.52, -0.22, 0.1, 0.6, 0.06, 1, 0], 'chest.rx': [0, -0.15, -0.22, 0.12, 1, 0],
          'neck.rx': [0, -0.45, -0.22, 0.25, 0.7, 0.2, 1, 0], 'head.rx': [0, 0.3, -0.22, 0.3, 1, 0.05], 'jaw.rx': [0, 0.45, -0.22, 0.65, 1, 0.05],
          'fLu.rx': [0, -1.15, -0.22, -0.35, 0.7, -0.3, 1, 0], 'fLk.rx': [0, 1.5, -0.22, 0.05, 1, 0], 'fRu.rx': [0, -0.95, -0.22, -0.3, 0.7, -0.25, 1, 0], 'fRk.rx': [0, 1.6, -0.22, 0.05, 1, 0],
          'bLu.rx': [0, 0.38, -0.22, -0.1, 1, 0], 'bLk.rx': [0, -0.3, 1, 0], 'bRu.rx': [0, 0.34, -0.22, -0.1, 1, 0], 'bRk.rx': [0, -0.25, 1, 0],
          'tail1.rx': [0, -0.3, -0.22, 0.5, 1, 0.2],
        },
        fn(ent, p, k) { if (k < 0.35) ent.coreK = 1.6; },
      });
      // 流星犁地：仰天长啸，背上的坠星越烧越亮；然后脑袋猛地砸向前方、前蹄一踏
      defClip(rig, 'howl_w', {
        dur: 0.7, hold: true, fade: 0.1,
        keys: {
          'root.rx': [0, 0, 1, -0.12], 'chest.rx': [0, 0, 1, -0.2], 'neck.rx': [0, -0.05, 1, -0.85], 'head.rx': [0, 0.05, 1, -0.55], 'jaw.rx': [0, 0.05, 0.5, 0.7, 1, 0.8],
          'fLu.rx': [0, 0, 1, -0.2], 'fRu.rx': [0, 0, 1, -0.2], 'bLu.rx': [0, 0, 1, 0.15], 'bRu.rx': [0, 0, 1, 0.15],
          'tail1.rx': [0, 0.2, 1, -0.4], 'tail2.rx': [0, 0.25, 1, -0.3],
        },
        fn: heat(0.9),
      });
      defClip(rig, 'howl', {
        dur: 0.75, k0: 0.2, fade: 0.03, out: 0.35,
        keys: {
          'root.rx': [0, -0.12, -0.2, 0.1, 1, 0], 'chest.rx': [0, -0.2, -0.2, 0.15, 1, 0],
          'neck.rx': [0, -0.85, -0.2, 0.2, 0.7, 0.1, 1, 0], 'head.rx': [0, -0.55, -0.2, 0.35, 1, 0.05], 'jaw.rx': [0, 0.8, -0.2, 0.9, 0.7, 0.5, 1, 0.05],
          'fLu.rx': [0, -0.2, -0.2, -0.5, 0.6, -0.3, 1, 0], 'fLk.rx': [0, 0, -0.2, 0.4, 1, 0], 'fRu.rx': [0, -0.2, 1, 0], 'bLu.rx': [0, 0.15, 1, 0], 'bRu.rx': [0, 0.15, 1, 0],
          'tail1.rx': [0, -0.4, -0.2, 0.4, 1, 0.2], 'tail2.rx': [0, -0.3, 1, 0.25],
        },
        fn(ent, p, k) { if (k < 0.4) ent.coreK = 2; },
      });
      // 坍缩：四肢一沉伏低身子，坠星一明一暗地蓄力；内爆那一刻猛地昂头
      const cw = crouch(1), cwK = {}, chK = {};
      for (const key in cw) {
        cwK[key] = [0, 0, 1, cw[key]];
        chK[key] = [0, cw[key], 0.85, cw[key] * 1.05, 1, 0];
      }
      defClip(rig, 'crouch_w', {
        dur: 0.6, hold: true, fade: 0.1,
        keys: Object.assign(cwK, { 'neck.rx': [0, 0, 1, 0.35], 'head.rx': [0, 0, 1, -0.2], 'jaw.rx': [0, 0.05, 1, 0.3], 'tail1.rx': [0, 0.2, 1, 0.5] }),
        fn: heat(1.0),
      });
      defClip(rig, 'crouch', {
        dur: 1.6, k0: 0.1, fade: 0.04, out: 0.35,
        keys: Object.assign(chK, {
          'neck.rx': [0, 0.35, 0.85, 0.4, 0.93, -0.3, 1, 0], 'head.rx': [0, -0.2, 0.85, -0.25, 0.93, -0.4, 1, 0], 'jaw.rx': [0, 0.3, 0.85, 0.4, 0.93, 0.8, 1, 0.05],
          'tail1.rx': [0, 0.5, 0.85, 0.55, 1, 0.2],
        }),
        fn(ent, p, k) { ent.coreK = k > 0.85 ? 2.3 : 1.5 + 0.5 * k + 0.2 * Math.sin(k * TAU * 6); },
      });
      // 衔星吐息：低头前探、张开大口，口中的光越聚越亮；吐息时嘴张到最大，脑袋跟着射线转
      defClip(rig, 'breath_w', {
        dur: 0.9, hold: true, fade: 0.1,
        keys: {
          'chest.rx': [0, 0, 1, 0.1], 'neck.rx': [0, 0, 1, 0.32], 'head.rx': [0, 0, 1, -0.08], 'jaw.rx': [0, 0.05, 1, 0.55],
          'fLu.rx': [0, 0, 1, -0.28], 'fLk.rx': [0, 0, 1, 0.38], 'fRu.rx': [0, 0, 1, -0.15], 'bLu.rx': [0, 0, 1, 0.22], 'bRu.rx': [0, 0, 1, 0.22],
        },
        fn(ent, p, k) { ent.mouthK = k; },
      });
      defClip(rig, 'breath', {
        dur: 1.6, k0: 0.08, fade: 0.04, out: 0.3,
        keys: {
          'chest.rx': [0, 0.1, 0.9, 0.1, 1, 0], 'neck.rx': [0, 0.32, 0.9, 0.3, 1, 0], 'head.rx': [0, -0.08, 0.9, -0.08, 1, 0.05], 'jaw.rx': [0, 0.55, 0.08, 0.9, 0.9, 0.9, 1, 0.05],
          'fLu.rx': [0, -0.28, 0.9, -0.28, 1, 0], 'fLk.rx': [0, 0.38, 0.9, 0.38, 1, 0], 'fRu.rx': [0, -0.15, 0.9, -0.15, 1, 0], 'bLu.rx': [0, 0.22, 0.9, 0.22, 1, 0], 'bRu.rx': [0, 0.22, 0.9, 0.22, 1, 0],
        },
        fn(ent, p, k) {
          ent.mouthK = k < 0.92 ? 1 : (1 - k) / 0.08;
          p[rig.J.head + 2] += 0.05 * Math.sin(k * TAU * 9);
        },
      });
      // 破绽：前腿一折跪倒，脑袋垂到地上，坠星明灭不定
      defClip(rig, 'broken', {
        dur: 2.2, loop: true, air: true, fade: 0.25, out: 0.45,
        keys: {
          'root.rx': [0, 0.3, 1, 0.3], 'root.oy': [0, -0.55, 1, -0.55], 'chest.rx': [0, 0.12, 1, 0.12],
          'fLu.rx': [0, -0.35, 1, -0.35], 'fLk.rx': [0, 1.9, 1, 1.9], 'fLh.rx': [0, 0.6, 1, 0.6], 'fRu.rx': [0, -0.25, 1, -0.25], 'fRk.rx': [0, 1.8, 1, 1.8], 'fRh.rx': [0, 0.6, 1, 0.6],
          'bLu.rx': [0, -0.3, 1, -0.3], 'bRu.rx': [0, -0.3, 1, -0.3], 'tail1.rx': [0, 0.7, 1, 0.7], 'tail2.rx': [0, 0.4, 1, 0.4],
        },
        fn(ent, p, k) {
          const J = rig.J, s = Math.sin(k * TAU), s2 = Math.sin(k * TAU * 2);
          p[J.neck] = 0.22 + 0.05 * s2;
          p[J.neck + 1] = 0.12 * s;
          p[J.head] = 0.3 + 0.08 * s2;
          p[J.head + 2] = 0.15 * s;
          p[J.jaw] = 0.35 + 0.1 * s2;
          p[J.chest + 6] = p[J.chest + 8] = 1 + 0.025 * s2;
          ent.coreK = 0.55 + 0.35 * Math.max(0, Math.sin(k * TAU * 5));
        },
      });
      // 死亡：最后一次人立长嘶，坠星暴亮，然后侧身轰然倒下，星光熄灭
      defClip(rig, 'death', {
        dur: 2.0, base: 'rest', hold: true, air: true, fade: 0.1,
        keys: {
          'root.rx': [0, 0, 0.25, -0.42, 0.5, 0.22, 1, 0.1],
          'root.rz': [0, 0, 0.5, 0.1, -0.9, 1.35, 1, 1.32],
          'root.oy': [0, 0, 0.25, 0.1, 0.5, -0.6, -0.9, -1.45, 1, -1.45],
          'chest.rx': [0, 0, 0.25, -0.2, 0.5, 0.2, 1, 0.1],
          'neck.rx': [0, 0, 0.25, -0.85, 0.6, 0.3, 0.9, 0.1, 1, 0.15], 'neck.rz': [0, 0, 0.6, -0.2, 1, -0.45],
          'head.rx': [0, 0, 0.25, -0.5, 0.6, 0.4, 1, 0.3], 'jaw.rx': [0, 0.05, 0.25, 0.9, 0.6, 0.5, 1, 0.6],
          'fLu.rx': [0, 0, 0.25, -1.0, 0.5, 0.2, 1, -0.3], 'fLk.rx': [0, 0, 0.25, 1.3, 0.5, 0.6, 1, 0.2], 'fRu.rx': [0, 0, 0.25, -0.8, 0.5, 0.4, 1, 0.2], 'fRk.rx': [0, 0, 0.25, 1.4, 0.5, 0.8, 1, 0.4],
          'bLu.rx': [0, 0, 0.25, 0.4, 0.5, -0.3, 1, -0.6], 'bRu.rx': [0, 0, 0.25, 0.35, 0.5, -0.2, 1, 0.3], 'bLk.rx': [0, 0, 1, 0.3], 'bRk.rx': [0, 0, 1, 0.5],
          'tail1.rx': [0, 0.2, 0.5, 0.6, 1, 0.3], 'tail1.ry': [0, 0, 1, 0.5],
        },
        fn(ent, p, k) { ent.coreK = k < 0.25 ? 1 + k * 4 : Math.max(0.1, 2 - (k - 0.25) * 2.6); },
      });
      bossAliases(rig, { slam: 'stomp', charge: 'stomp', ring: 'howl', spiral: 'howl', fan: 'breath', barrage: 'howl', summon: 'howl', cross: 'stomp' });
      for (const [pat, clip] of [['starfall', 'howl'], ['gravity', 'crouch'], ['sweep', 'breath']]) {
        aliasClip(rig, pat, clip);
        aliasClip(rig, pat + '_w', clip + '_w');
      }
      return rig;
    });
  }

  // ----- 衔星巨兽的招式特效 -----
  // 吐息射线：一束从口中斜射到远处地面的星光（平躺 + 竖立两片交叉的光带，外层元素色、芯白），两端各一团光晕。
  // 每帧由 enemies.js 喂位置；k = 0 时藏起来
  let riftBeamObj = null;
  W.riftBeam = function (x0, z0, x1, z1, hex, k) {
    if (!(k > 0)) {
      if (riftBeamObj) riftBeamObj.visible = riftBeamObj.userData.s1.visible = false;
      return;
    }
    if (!riftBeamObj) {
      const g = new T.Group(), parts = [];
      const add = (w, white, vert) => {
        const m = new T.Mesh(gQuad(), new T.MeshBasicMaterial({ map: boltTex(), color: 0xffffff, transparent: true, opacity: 1, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, side: T.DoubleSide, fog: false }));
        m.scale.set(w, 1, 1);
        if (vert) m.rotation.z = HALF_PI;
        m.renderOrder = 5;
        g.add(m);
        parts.push({ m, white });
      };
      add(1.5, false, false);
      add(1.5, false, true);
      add(0.5, true, false);
      add(0.5, true, true);
      const s0 = new T.Sprite(spriteMat(0xffffff)), s1 = new T.Sprite(spriteMat(0xffffff));
      g.add(s0);
      scene.add(s1);
      g.visible = false;
      scene.add(g);
      riftBeamObj = g;
      g.userData = { parts, s0, s1, hex: -1 };
    }
    const g = riftBeamObj, u = g.userData, y0 = 3.1, y1 = 0.35;
    if (u.hex !== hex) {
      u.hex = hex;
      for (const q of u.parts) q.m.material.color.copy(lin(q.white ? mixHex(hex, 0xffffff, 0.75) : hex));
      u.s0.material = u.s1.material = spriteMat(mixHex(hex, 0xffffff, 0.4));
    }
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    g.visible = true;
    g.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    g.lookAt(x1, y1, z1);
    const fl = 0.85 + Math.random() * 0.3;
    for (const q of u.parts) {
      q.m.scale.z = len / 2;
      q.m.scale.x = (q.white ? 0.42 : 1.35) * fl;
    }
    u.s0.position.set(0, 0, -len / 2);
    u.s0.scale.setScalar(2.6 * fl);
    u.s1.visible = true;
    u.s1.position.set(x1, 0.5, z1);
    u.s1.scale.setScalar(3.4 * fl);
    // 沿射线溅火星，落点扬一把碎光
    _c.set(hex);
    for (let i = 0; i < 3; i++) {
      const t = Math.random(), px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t, py = y0 + (y1 - y0) * t;
      spawnP(px, py, pz, rand(-1.5, 1.5), rand(0, 2.5), rand(-1.5, 1.5), rand(0.2, 0.45), rand(0.1, 0.2), _c.r + (1 - _c.r) * 0.5, _c.g + (1 - _c.g) * 0.5, _c.b + (1 - _c.b) * 0.5, 3, 1.5);
    }
    spawnP(x1, 0.3, z1, rand(-3, 3), rand(2, 5), rand(-3, 3), rand(0.3, 0.6), rand(0.15, 0.3), _c.r, _c.g, _c.b, 9, 1);
    flashLight(x1, 1.2, z1, hex, 1.2);
  };
  // 引力井：地上一圈缓缓收紧、越转越快的断续光环，星尘从外圈被吸进井心；k = −1 内爆，k = −2 直接收起
  let riftWellObj = null;
  W.riftWell = function (x, z, R, core, hex, k, dt) {
    if (!riftWellObj) {
      const m = new T.Mesh(gQuad(), new T.MeshBasicMaterial({ map: dashRingTex(), color: 0xffffff, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
      m.renderOrder = 2;
      m.visible = false;
      scene.add(m);
      riftWellObj = m;
    }
    const m = riftWellObj;
    if (k < 0) {
      m.visible = false;
      if (k === -1) {
        // 内爆：先往里一缩，再炸开一圈
        _c.set(hex);
        for (let i = 0; i < 36; i++) {
          const a = rand(0, TAU), v = rand(4, 11);
          spawnP(x, rand(0.3, 1.6), z, Math.sin(a) * v, rand(1, 5), Math.cos(a) * v, rand(0.35, 0.7), rand(0.15, 0.32), _c.r + (1 - _c.r) * 0.4, _c.g + (1 - _c.g) * 0.4, _c.b + (1 - _c.b) * 0.4, 6, 1.6);
        }
        flare(x, 1.2, z, hex, 6, 0.3);
        flashLight(x, 2, z, hex, 2.2);
        W.ring(x, z, core + 1.4, hex, 0.35);
        skyBolt(x, z, mixHex(hex, 0xffffff, 0.4), 9, 4, 0.5);
      }
      return;
    }
    const r = R - (R - core) * 0.35 * k;
    m.visible = true;
    m.material.color.copy(lin(hex));
    m.material.opacity = 0.45 + 0.4 * k;
    m.position.set(x, 0.06, z);
    m.scale.set(r, 1, r);
    m.rotation.y -= dt * (1.5 + 5 * k);
    _c.set(hex);
    let n = dt * 70;
    while (n > 0) {
      if (n < 1 && Math.random() > n) break;
      n -= 1;
      const a = rand(0, TAU), d = R * rand(0.75, 1.0), px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d, v = rand(4, 7);
      spawnP(px, rand(0.1, 0.9), pz, -Math.sin(a) * v + Math.cos(a) * 1.5, rand(0, 0.6), -Math.cos(a) * v - Math.sin(a) * 1.5, (d / v) * 0.9, rand(0.08, 0.16), _c.r + (1 - _c.r) * 0.3, _c.g + (1 - _c.g) * 0.3, _c.b + (1 - _c.b) * 0.3, 0, 0);
    }
  };
  // 流星犁地的一处落点：一道星光从天而降，地上炸开一圈碎光（每道线的第一处多一道竖直落雷）
  W.riftStrike = function (x, z, r, hex, big) {
    const hw = mixHex(hex, 0xffffff, 0.45);
    vstreak(x + rand(-0.8, 0.8), 8, z - 1.2, x, 0.1, z, big ? 0.5 : 0.32, hw, 0.2);
    if (big) skyBolt(x, z, hw, 7, 3, 0.35);
    flare(x, 0.6, z, hex, r * 2.2, 0.18);
    W.ring(x, z, r, hex, 0.25);
    _c.set(hex);
    for (let i = 0; i < 9; i++) {
      const a = rand(0, TAU), v = rand(2, 5);
      spawnP(x, 0.25, z, Math.sin(a) * v, rand(2, 5), Math.cos(a) * v, rand(0.25, 0.5), rand(0.1, 0.22), _c.r + (1 - _c.r) * 0.3, _c.g + (1 - _c.g) * 0.3, _c.b + (1 - _c.b) * 0.3, 9, 1);
    }
  };
  function hideRiftFx() {
    if (riftBeamObj) {
      riftBeamObj.visible = false;
      riftBeamObj.userData.s1.visible = false;
    }
    if (riftWellObj) riftWellObj.visible = false;
  }

  const BOSS_RIG = { golem: golemRig, weaver: weaverRig, warden: wardenRig, lord: lordRig, behemoth: behemothRig };

  W.makeBoss = function (kind, elemHex) {
    const eh = hexOf(elemHex);
    _c.set(eh); // 和小怪一样：暖色地面上的首领偏冷，冷色地面上的偏暖
    const warmGround = _c.r > 0.8 && _c.g < 0.6;
    const ent = newEnt(kind, BOSS_RIG[kind](), warmGround ? 0xe6e9f6 : 0xf2ece6, eh, 1.15); // 卡通：染色收轻，同小怪
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
      else if (n === 'cast2') k *= 1 + 1.4 * hump(q, 0.2, c.k0, c.k0 + 0.05, 0.95);
      else if (n === 'channel') k *= 1.5 + 0.3 * Math.sin(t * 31);
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
    if (ent.kind === 'pyre') {
      pyreClipFx(ent, c);
      ent.fxPrev = ent.cK;
      return;
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
    return rigOf('thrall', () => cTry('thrall', (cs) => {
      const BONE = 0xece3cc, BONE_D = 0xa69c86, IRON = 0x7a828e, IRON_D = 0x3d434d, BRONZE = 0xbb8e4c, BRONZE_D = 0x6f5329;
      const LEATHER = 0x5c4432, LEATHER_D = 0x35271c, WOOD = 0x6e5038, CLOTH = 0x2c4a47, CLOTH_L = 0x3f655f, CLOTH_IN = 0x132220, HOLE = 0x0a0c0c;
      const b = rigBuilder('thrall', NB_SMALL, cs);
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
      b.tag('gear'); // 剑和盾：换成 C 模型时留下
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
      b.tag(null);

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
      cApply(rig, cs);
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
        const ga = rig.gait || 0.78; // 腿摆幅（C 模型的骷髅腿短，摆得大一点、步频也高一点，脚才不打滑）
        legCycle(p, J.thL, J.shL, J.ftL, s, c, run, ga, 1.15);
        legCycle(p, J.thR, J.shR, J.ftR, -s, -c, run, ga, 1.15);
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
    }));
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
      const STONE = 0x7e7468, STONE_D = 0x48423a, STONE_L = 0x948a7c, BRONZE = 0x9a6a32, BRONZE_D = 0x4e3216; // 卡通：浅石抬亮一档
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

  // ---------------------------------------------------------------------
  // 焚骨祭司：佝偻的骸骨术士，罩着烧焦的长法袍和兜帽，袍角烧穿的破口里透着余烬；
  // 右手一根扭曲的骨木长杖，杖头铁笼里关着一团焚火（火弹从这里掷出），左掌心托着一簇小火；
  // 兜帽下的骷髅眼窝和敞开的胸腔里是魂火青——一眼认得出是自己人。14 个关节，2 个网格（躯体 + 魂火）+ 1 组焚火点缀
  // ---------------------------------------------------------------------
  function pyreRig() {
    return rigOf('pyre', () => {
      const BONE = 0xe4d8bd, BONE_D = 0x9d9179, ROBE = 0x3e3040, ROBE_L = 0x62485a, ROBE_IN = 0x1a1218, ASH = 0x6e5c58; // 卡通：袍子从炭黑抬成深紫褐
      const WOOD = 0x4a3426, WOOD_L = 0x6d4f39, IRON = 0x585d66, IRON_D = 0x2c3036, BRONZE = 0xa77a3e, HOLE = 0x0a0807;
      const b = rigBuilder('pyre', NB_SMALL);
      b.j('root', null, 0, 0.95, 0).j('spine', 'root', 0, 1.08, -0.02).j('chest', 'spine', 0, 1.3, -0.04).j('head', 'chest', 0, 1.58, 0.03);
      b.j('uaL', 'chest', 0.22, 1.47, -0.03).j('faL', 'uaL', 0.27, 1.17, -0.03).j('hL', 'faL', 0.29, 0.93, 0.02);
      b.j('uaR', 'chest', -0.22, 1.47, -0.03).j('faR', 'uaR', -0.27, 1.17, -0.03).j('hR', 'faR', -0.29, 0.93, 0.02);
      b.j('thL', 'root', 0.1, 0.92, 0).j('shL', 'thL', 0.11, 0.5, 0.01);
      b.j('thR', 'root', -0.1, 0.92, 0).j('shR', 'thR', -0.11, 0.5, 0.01);

      // --- 法袍下摆：一整圈焦黑的长袍（车削体），下沿烧得参差，里面衬着暗红；破口和下摆上几点余烬 ---
      b.at('root').surf(SURF.cloth);
      b.pd(gLathe('py/skirt', [[0.31, 0.14], [0.29, 0.3], [0.24, 0.62], [0.19, 0.88], [0.17, 1.04], [0.11, 1.09], [0.02, 1.11]], 12), [ROBE_IN, ROBE], ROBE_IN, 0, 0, 0);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + 0.3, r = 0.3;
        b.pd(gPlate('py/tat' + (i % 3), [[-0.07, 0], [0.07, 0], [0.05, -0.1 - (i % 3) * 0.03], [0, -0.05], [-0.05, -0.13]], 0.006, 0.002), ROBE, ROBE_IN, Math.sin(a) * r, 0.16, Math.cos(a) * r, 0.1, a, 0);
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + 0.9;
        b.x(gSph(0.022, 5, 4), 1.1, Math.sin(a) * 0.3, 0.17 + (i % 2) * 0.05, Math.cos(a) * 0.3);
      }
      b.surf(SURF.leather).p(gTorus(0.175, 0.026, 5, 12), ASH, 0, 1.0, 0, HALF_PI, 0, 0, 1, 0.85, 1);
      b.surf(SURF.bone).p(gSph(0.04, 6, 5), BONE, 0.12, 0.96, 0.12); // 腰间挂的一节骨
      b.p(gSph(0.032, 6, 5), BONE_D, 0.15, 0.89, 0.1);

      // --- 胸腔：袍子前襟敞开，露出肋骨，肋骨间烧着魂火；兜帽连着的肩披裹住后背 ---
      b.at('chest').surf(SURF.cloth);
      b.pd(gDrape('py/mantle', [[0.27, 1.06], [0.29, 1.28], [0.27, 1.45], [0.15, 1.58]], 4.0, 9), [ROBE, ROBE_L], ROBE_IN, 0, 0, -0.01);
      b.surf(SURF.bone);
      b.p(gCyl(0.026, 0.032, 0.3, 6), [BONE_D, BONE], 0, 1.33, -0.07, -0.08);
      for (let i = 0; i < 3; i++) {
        const y = 1.42 - i * 0.07, w = 0.12 + i * 0.012, z = 0.085 - i * 0.008;
        for (const sx of [1, -1]) b.p(gSweep('py/rib' + i + sx, [[sx * 0.02, y + 0.02, -0.075], [sx * w, y, -0.035], [sx * (w - 0.015), y - 0.03, z - 0.02], [sx * 0.03, y - 0.055, z + 0.01]], [0.015, 0.017, 0.014, 0.01], 5), [BONE_D, BONE], 0, 0, 0);
      }
      b.g(gSph(0.06, 8, 6), 1.5, 0, 1.34, 0.0, 0, 0, 0, 1, 1.3, 1);
      // 肩上一串骨珠
      for (let i = 0; i < 7; i++) {
        const a = -1.2 + (i / 6) * 2.4;
        b.p(gSph(0.026, 6, 4), i % 2 ? BONE : BONE_D, Math.sin(a) * 0.2, 1.5 - Math.abs(a) * 0.03, Math.cos(a) * 0.13);
      }
      b.surf(SURF.gold).p(gSph(0.03, 6, 4), BRONZE, 0, 1.47, 0.14);

      // --- 头：兜帽遮住大半个骷髅，眼窝里两点魂火，下颌骨随着念咒开合 ---
      b.at('head').surf(SURF.bone);
      b.p(gSph(0.1, 10, 8), [BONE_D, BONE], 0, 1.65, 0.01, 0, 0, 0, 0.92, 1.0, 1.06);
      b.p(gRBox(0.11, 0.045, 0.07, 0.02), BONE, 0, 1.588, 0.07);
      b.surf(SURF.cloth);
      for (const sx of [1, -1]) b.p(gSph(0.028, 6, 5), HOLE, sx * 0.038, 1.64, 0.092, 0, 0, 0, 1.1, 0.9, 0.7);
      for (const sx of [1, -1]) b.g(gSph(0.022, 6, 4), 1.8, sx * 0.038, 1.64, 0.104);
      b.pd(gDrape('py/hood', [[0.03, 1.88], [0.15, 1.84], [0.19, 1.69], [0.185, 1.52]], 4.9, 10), [ROBE, ROBE_L], ROBE_IN, 0, 0, 0.025, -0.05);
      b.pd(gCone(0.06, 0.18, 5), ROBE, ROBE_IN, 0, 1.9, -0.06, -0.9); // 兜帽尖往后耷拉

      // --- 手臂：袍袖从肩垂到肘，前臂是细骨，骨手 ---
      for (const sx of [1, -1]) {
        const U = sx > 0 ? 'uaL' : 'uaR', F = sx > 0 ? 'faL' : 'faR', H = sx > 0 ? 'hL' : 'hR';
        b.at(U).surf(SURF.cloth).pd(gLathe('py/sleeve', [[0.1, 1.1], [0.085, 1.17], [0.065, 1.33], [0.05, 1.47]], 8), [ROBE, ROBE_L], ROBE_IN, sx * 0.245, 0, -0.03);
        b.at(F).surf(SURF.bone).limb([BONE_D, BONE], sx * 0.27, 1.17, -0.03, sx * 0.29, 0.95, 0.02, 0.024, 0.02, 6, 0);
        b.at(H).p(gSph(0.04, 7, 5), [BONE_D, BONE], sx * 0.29, 0.9, 0.03, 0, 0, 0, 0.8, 1.1, 1);
        for (let k = -1; k <= 1; k++) b.p(gCone(0.011, 0.065, 3), BONE, sx * 0.29 + k * 0.019, 0.85, 0.05, Math.PI - 0.3);
      }
      // 左掌心的一簇焚火
      b.at('hL').x(gCone(0.035, 0.12, 5), 1.3, 0.31, 0.96, 0.09).x(gSph(0.03, 6, 4), 1.6, 0.31, 0.92, 0.09);

      // --- 骨木长杖：竖握在右手里，杖身扭着两道铜箍，杖头一只铁笼，笼里一团焚火，笼顶一枚兽颅 ---
      const SX = -0.3, SZ = 0.06;
      b.at('hR').surf(SURF.leather).p(gSweep('py/staff', [[SX, 0.12, SZ], [SX + 0.015, 0.6, SZ + 0.01], [SX - 0.01, 1.2, SZ - 0.005], [SX + 0.01, 1.72, SZ + 0.01], [SX, 1.95, SZ]], [0.022, 0.026, 0.024, 0.028, 0.034], 6), [WOOD, WOOD_L], 0, 0, 0);
      b.surf(SURF.gold).p(gCyl(0.036, 0.036, 0.04, 8), BRONZE, SX, 1.0, SZ).p(gCyl(0.038, 0.038, 0.04, 8), BRONZE, SX, 1.6, SZ);
      b.surf(SURF.metal);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + 0.4;
        b.p(gSweep('py/cage' + k, [[SX, 1.93, SZ], [SX + Math.sin(a) * 0.1, 2.02, SZ + Math.cos(a) * 0.1], [SX + Math.sin(a) * 0.1, 2.16, SZ + Math.cos(a) * 0.1], [SX, 2.25, SZ]], [0.011, 0.012, 0.012, 0.01], 4), [IRON_D, IRON], 0, 0, 0);
      }
      b.surf(SURF.bone).p(gSph(0.05, 7, 5), BONE, SX, 2.28, SZ + 0.01, 0, 0, 0, 0.9, 0.8, 1.2);
      b.x(gSph(0.07, 8, 6), 1.5, SX, 2.09, SZ).x(gCone(0.05, 0.14, 5), 1.2, SX, 2.17, SZ);

      // --- 腿：袍下露出两截细骨小腿和骨脚 ---
      for (const sx of [1, -1]) {
        const TH = sx > 0 ? 'thL' : 'thR', SH = sx > 0 ? 'shL' : 'shR';
        b.at(TH).surf(SURF.bone).limb([BONE_D, BONE], sx * 0.1, 0.92, 0, sx * 0.11, 0.51, 0.01, 0.032, 0.027, 6, 0);
        b.at(SH).limb([BONE_D, BONE], sx * 0.11, 0.5, 0.01, sx * 0.11, 0.09, 0, 0.026, 0.021, 6, 2);
        b.p(gSph(0.045, 7, 5), [BONE_D, BONE], sx * 0.11, 0.045, 0.05, 0, 0, 0, 0.85, 0.55, 1.8);
      }

      const rig = b.build({ height: 1.95, reach: 1.7, stride: 2.2, shade: 0.25 });
      rig.hitJ = [rig.J.head, rig.J.chest];
      rig.feet = [rig.JI.shL, rig.JI.shR];
      rig.ankle = 0.5;
      sock(rig, 'weapon', 'hR', -0.01, 1.16, 0.04); // 杖头铁笼里的焚火（火弹 / 灼链从这里出去）
      sock(rig, 'hand', 'hR', 0, -0.03, 0.02);
      sock(rig, 'handL', 'hL', 0.02, 0.03, 0.07);
      sock(rig, 'head', 'head', 0, 0.12, 0);
      sock(rig, 'chest', 'chest', 0, 0.06, 0.08);
      rig.post = minionPost;
      rig.late = minionLate;
      rig.loco = function (ent, p, t) {
        const J = rig.J, mv = ent.mv, s = Math.sin(ent.walk), id = 1 - mv;
        const run = Math.min(1.2, ent.spd / 5.5) * mv;
        const br = Math.sin(t * 1.5 + ent.phase), br2 = Math.sin(t * 0.7 + ent.phase * 1.3);
        p[J.root] = 0.08 * run;
        p[J.root + 1] = -0.08 * s * run;
        p[J.root + 2] = 0.05 * s * run;
        // 佝偻着背，头往前探；站着时肩头随着呼吸起伏，头慢慢转着打量四周
        p[J.spine] = 0.18 + 0.06 * run + 0.02 * br * id;
        p[J.chest] = 0.14 + 0.05 * run + 0.03 * br * id;
        p[J.chest + 1] = 0.08 * s * run;
        p[J.head] = -0.22 - 0.1 * run + 0.04 * br;
        p[J.head + 1] = 0.25 * br2 * id - 0.08 * s * run;
        p[J.thL] = -0.55 * s * run - 0.05 * id;
        p[J.shL] = (0.25 + 0.5 * Math.max(0, Math.cos(ent.walk))) * run + 0.08 * id;
        p[J.thR] = 0.55 * s * run + 0.04 * id;
        p[J.shR] = (0.25 + 0.5 * Math.max(0, -Math.cos(ent.walk))) * run + 0.06 * id;
        // 左手托着火，掌心朝上举在身侧
        p[J.uaL] = -0.35 + 0.3 * s * run + 0.03 * br;
        p[J.uaL + 2] = 0.22;
        p[J.faL] = -1.1 - 0.08 * br2;
        p[J.hL] = -0.25;
        // 右手拄杖：杖竖在身前右侧，走路时杖随步子点地
        p[J.uaR] = -0.32 - 0.25 * s * run;
        p[J.uaR + 2] = -0.08;
        p[J.faR] = -0.62 - 0.1 * run;
        p[J.hR] = 0.85 + 0.1 * run;
      };
      pyreClips(rig);
      return rig;
    });
  }
  function pyreClips(rig) {
    locoClips(rig);
    const LEGS = ['thL', 'shL', 'thR', 'shR'];
    // 升起：一团焚火从地里翻上来，骸骨裹着法袍从火里浮出，最后把杖往地上一顿
    defClip(rig, 'rise', {
      dur: 0.8, base: 'rest', air: true, fade: 0, out: 0.18,
      keys: {
        'root.oy': [0, -1.9, 0.3, -1.4, -0.7, -0.08, 0.86, 0.03, 1, 0],
        'root.rx': [0, 0.5, 0.45, 0.35, 0.8, 0.1, 1, 0.08],
        'spine.rx': [0, 0.5, 0.5, 0.3, 1, 0.18],
        'chest.rx': [0, 0.4, 0.5, 0.25, 1, 0.14],
        'head.rx': [0, 0.6, 0.45, 0.2, 0.75, -0.45, 1, -0.22],
        'uaL.rx': [0, -2.6, 0.45, -2.2, 0.75, -0.6, 1, -0.35],
        'uaL.rz': [0, 0.5, 0.6, 0.35, 1, 0.22],
        'faL.rx': [0, -0.3, 0.6, -0.8, 1, -1.1],
        'uaR.rx': [0, -2.4, 0.45, -2.6, 0.72, -1.0, 0.86, -0.25, 1, -0.32],
        'uaR.rz': [0, -0.4, 0.6, -0.2, 1, -0.08],
        'faR.rx': [0, -0.5, 0.6, -0.9, 1, -0.62],
        'hR.rx': [0, 0.3, 0.6, 0.6, 1, 0.85],
        'thL.rx': [0, -0.9, 0.6, -0.4, 1, -0.05],
        'shL.rx': [0, 1.2, 0.6, 0.5, 1, 0.08],
        'thR.rx': [0, -0.3, 0.6, -0.1, 1, 0.04],
        'shR.rx': [0, 0.8, 0.6, 0.3, 1, 0.06],
      },
    });
    // 掷火弹：杖往后一引，拧身把杖头朝目标一挥，焚火从杖头甩出去（k0 = 杖头挥到最前）
    defClip(rig, 'attack', {
      dur: 0.62, k0: 0.58, lower: LEGS, fade: 0.06, out: 0.2,
      keys: {
        'root.ry': [0, 0, 0.35, -0.3, -0.58, 0.28, 0.85, 0.2, 1, 0],
        'chest.ry': [0, 0, 0.35, -0.45, -0.58, 0.4, 0.85, 0.3, 1, 0],
        'chest.rx': [0, 0.14, 0.35, 0.0, -0.58, 0.3, 1, 0.14],
        'head.rx': [0, -0.22, 0.35, -0.35, -0.58, -0.1, 1, -0.22],
        'head.ry': [0, 0, 0.35, 0.35, -0.58, -0.25, 1, 0],
        'uaR.rx': [0, -0.32, 0.35, -2.3, -0.58, -1.35, 0.85, -1.2, 1, -0.32],
        'uaR.rz': [0, -0.08, 0.35, -0.5, -0.58, 0.1, 1, -0.08],
        'faR.rx': [0, -0.62, 0.35, -1.2, -0.58, -0.15, 0.85, -0.25, 1, -0.62],
        'hR.rx': [0, 0.85, 0.35, 0.6, -0.58, 2.0, 0.85, 1.8, 1, 0.85],
        'uaL.rx': [0, -0.35, 0.35, -0.9, -0.58, -0.1, 1, -0.35],
        'uaL.rz': [0, 0.22, 0.35, 0.5, -0.58, 0.3, 1, 0.22],
        'faL.rx': [0, -1.1, 0.35, -1.5, -0.58, -0.6, 1, -1.1],
        'thL.rx': [0, -0.05, 0.35, 0.1, -0.58, -0.45, 0.85, -0.4, 1, -0.05],
        'shL.rx': [0, 0.08, 0.35, 0.1, -0.58, 0.45, 1, 0.08],
        'thR.rx': [0, 0.04, 0.35, -0.1, -0.58, 0.25, 1, 0.04],
      },
    });
    // 坠焰：双手把杖高举过头、仰头念咒（杖头的焚火冲天而起），k0 = 举到最高；随后杖尾往地上重重一顿
    defClip(rig, 'cast2', {
      dur: 0.9, k0: 0.6, lower: LEGS, fade: 0.08, out: 0.25,
      keys: {
        'spine.rx': [0, 0.18, 0.4, -0.12, -0.6, -0.25, 0.85, 0.3, 1, 0.18],
        'chest.rx': [0, 0.14, 0.4, -0.15, -0.6, -0.3, 0.85, 0.3, 1, 0.14],
        'head.rx': [0, -0.22, 0.4, -0.6, -0.6, -0.75, 0.85, 0.05, 1, -0.22],
        'uaR.rx': [0, -0.32, 0.3, -1.6, -0.6, -2.95, 0.85, -1.1, 1, -0.32],
        'uaR.rz': [0, -0.08, 0.6, 0.25, 0.85, -0.05, 1, -0.08],
        'faR.rx': [0, -0.62, 0.3, -0.5, -0.6, -0.15, 0.85, -0.7, 1, -0.62],
        'hR.rx': [0, 0.85, 0.3, 1.6, -0.6, 2.9, 0.85, 1.0, 1, 0.85],
        'uaL.rx': [0, -0.35, 0.3, -1.6, -0.6, -2.9, 0.85, -0.6, 1, -0.35],
        'uaL.rz': [0, 0.22, 0.6, -0.25, 0.85, 0.3, 1, 0.22],
        'faL.rx': [0, -1.1, 0.3, -0.6, -0.6, -0.2, 0.85, -1.0, 1, -1.1],
        'thL.rx': [0, -0.05, 0.6, 0.05, -0.85, -0.5, 1, -0.05],
        'shL.rx': [0, 0.08, 0.6, 0.05, -0.85, 0.6, 1, 0.08],
        'thR.rx': [0, 0.04, -0.85, -0.25, 1, 0.04],
        'shR.rx': [0, 0.06, -0.85, 0.5, 1, 0.06],
      },
    });
    // 灼链：杖平端着指向目标，左手扶住杖身，整个身子前倾着顶住；身子随着引导微微发颤（fn 里的抖动）
    defClip(rig, 'channel', {
      dur: 2.2, k0: 0.1, lower: LEGS, fade: 0.12, out: 0.25,
      keys: {
        'root.rx': [0, 0.08, 0.1, 0.18, 0.9, 0.18, 1, 0.08],
        'chest.rx': [0, 0.14, 0.1, 0.3, 0.9, 0.3, 1, 0.14],
        'head.rx': [0, -0.22, 0.1, -0.4, 0.9, -0.4, 1, -0.22],
        'uaR.rx': [0, -0.32, 0.1, -1.05, 0.9, -1.05, 1, -0.32],
        'uaR.rz': [0, -0.08, 0.1, 0.15, 0.9, 0.15, 1, -0.08],
        'faR.rx': [0, -0.62, 0.1, -0.4, 0.9, -0.4, 1, -0.62],
        'hR.rx': [0, 0.85, 0.1, 1.95, 0.9, 1.95, 1, 0.85],
        'uaL.rx': [0, -0.35, 0.1, -1.2, 0.9, -1.2, 1, -0.35],
        'uaL.rz': [0, 0.22, 0.1, -0.35, 0.9, -0.35, 1, 0.22],
        'faL.rx': [0, -1.1, 0.1, -0.7, 0.9, -0.7, 1, -1.1],
        'thL.rx': [0, -0.05, 0.1, -0.4, 0.9, -0.4, 1, -0.05],
        'shL.rx': [0, 0.08, 0.1, 0.4, 0.9, 0.4, 1, 0.08],
        'thR.rx': [0, 0.04, 0.1, 0.3, 0.9, 0.3, 1, 0.04],
        'shR.rx': [0, 0.06, 0.1, 0.25, 0.9, 0.25, 1, 0.06],
      },
      fn(ent, p, k, t) {
        const J = rig.J, w = hump(k, 0.05, 0.12, 0.88, 0.98);
        p[J.chest + 1] += Math.sin(t * 41) * 0.035 * w;
        p[J.uaR] += Math.sin(t * 53 + 1) * 0.04 * w;
        p[J.head + 2] += Math.sin(t * 37) * 0.04 * w;
      },
    });
    // 散架：杖从手里脱落，两膝一软，法袍塌成一堆，骷髅连着兜帽滚落到一边
    defClip(rig, 'death', {
      dur: 0.8, base: 'rest', hold: true, air: true, fade: 0.05,
      clear: [['head', 0, 0.07, 0.02, 0.11], ['chest', 0, 0.03, 0.04, 0.13], ['root', 0, 0, 0, 0.1], ['shL', 0, 0, 0.02, 0.05], ['shR', 0, 0, 0.02, 0.05]],
      keys: {
        'root.oy': [0, 0, 0.25, -0.1, -0.65, -0.72, 1, -0.78],
        'root.rx': [0, 0, 0.3, -0.15, 0.65, 0.6, 1, 0.95],
        'spine.rx': [0, 0.18, 0.4, 0.4, 1, 0.5],
        'chest.rx': [0, 0.14, 0.4, 0.3, 1, 0.25],
        'chest.sy': [0, 1, 0.6, 1, 1, 0.8],
        'head.rx': [0, -0.22, 0.4, 0.2, 0.7, 0.8, 1, 1.6],
        'head.rz': [0, 0, 0.6, 0.4, 1, 1.2],
        'head.ox': [0, 0, 0.6, 0.05, 1, 0.24],
        'head.oz': [0, 0, 0.6, 0.12, 1, 0.26],
        'head.oy': [0, 0, 0.6, -0.03, 1, -0.12],
        'thL.rx': [0, 0, 0.3, -0.6, 0.65, -1.5, 1, -1.55],
        'shL.rx': [0, 0, 0.3, 1.0, 0.65, 2.4, 1, 2.5],
        'thR.rx': [0, 0, 0.3, -0.4, 0.65, -1.3, 1, -1.4],
        'shR.rx': [0, 0, 0.3, 0.9, 0.65, 2.3, 1, 2.45],
        'uaL.rx': [0, -0.35, 0.4, -0.9, 1, -0.2],
        'uaL.rz': [0, 0.22, 0.6, 0.9, 1, 1.3],
        'faL.rx': [0, -1.1, 1, -0.2],
        'uaR.rx': [0, -0.32, 0.35, -0.9, 1, -0.4],
        'uaR.rz': [0, -0.08, 0.6, -0.9, 1, -1.3],
        'faR.rx': [0, -0.62, 1, -0.1],
        'hR.rx': [0, 0.85, 0.35, 1.6, 0.7, 2.6, 1, 2.9],
        'hR.rz': [0, 0, 0.7, -0.6, 1, -0.9],
      },
    });
  }

  const MINION_RIG = { thrall: thrallRig, colossus: colossusRig, pyre: pyreRig };
  const MINION_RING_R = { thrall: 0.82, colossus: 1.6, pyre: 0.75 };
  // 召唤物实体。kind：'thrall' | 'colossus'。elemHex（可选）：剑刃血槽 / 拳上符石这些点缀的颜色，
  // 默认魂火青；魂火（眼、胸腔、誓印）、脚环与血条永远是魂火青。之后可用 W.minionElem 改点缀色。
  W.makeMinion = function (kind, elemHex) {
    const k = MINION_RIG[kind] ? kind : 'thrall';
    const ent = newEnt(k, MINION_RIG[k](), WH, ALLY_HEX, k === 'colossus' ? 1.3 : 1.2);
    ent.ally = true;
    ent.fxPrev = -1;
    ent.fxClip = null;
    ent.uRim.value.setRGB(0.05, 0.24, 0.19);
    if (kind === 'wraith') spectral(ent);
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
  // 万魂降临的英灵：仆从的骨架换一身半透明的魂火躯壳——骨色压成淡青、自己发着幽光，轮廓光很亮，
  // 大一圈；剑刃血槽这些点缀是余烬橙（烬铸）；走动时身上不断飘出魂火屑（见 updateSpectral）
  const spectralEnts = [];
  function spectral(ent) {
    const bm = ent.bodyMat;
    bm.transparent = true;
    bm.opacity = 0.62;
    bm.color.copy(lin(0x9ff5e6));
    bm.emissive.copy(lin(0x1f8f7a));
    bm.emissiveIntensity = 0.9;
    bm.userData.e0 = bm.emissive.clone();
    bm.userData.ei0 = 0.9;
    bm.needsUpdate = true;
    ent.uRim.value.setRGB(0.35, 1.25, 1.0);
    ent.k = 1.2;
    ent.body.scale.setScalar(1.2);
    ent.spectral = true;
    ent.specAcc = 0;
    spectralEnts.push(ent);
  }
  function updateSpectral(dt) {
    for (let i = spectralEnts.length - 1; i >= 0; i--) {
      const e = spectralEnts[i];
      if (e.removed || e.dying) {
        spectralEnts.splice(i, 1);
        continue;
      }
      if (!e.group.visible) continue;
      e.specAcc += dt * 26;
      const g = e.group.position;
      while (e.specAcc > 1) {
        e.specAcc -= 1;
        const warm = Math.random() < 0.22;
        const a = rand(0, TAU), d = rand(0.1, 0.45);
        spawnP(g.x + Math.sin(a) * d, rand(0.2, 2.4), g.z + Math.cos(a) * d, rand(-0.3, 0.3), rand(0.6, 1.8), rand(-0.3, 0.3), rand(0.4, 0.8), rand(0.1, 0.2),
          warm ? 1 : ALLY_RGB.r + 0.2, warm ? 0.62 : ALLY_RGB.g, warm ? 0.3 : ALLY_RGB.b, -0.5, 1.4);
      }
    }
  }
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
    for (let i = 1; i < GEAR_KEYS.length; i++) loots.push(W.makeLoot('item', 0xffffff, false, 0, 2, { slot: 'weapon', type: GEAR_KEYS[i] }));
    for (const k of ['item', 'cur', 'skill', 'blank', 'support']) loots.push(W.makeLoot(k, 0xffffff, false, 0, 2));
    loots.push(W.makeLoot('item', 0xff9b3d, true, 0, 2, { slot: 'weapon', type: 'katana', rarity: 3 })); // 烬铸的本体材质与双层光柱
    allyFxVisible(true); // 召唤法阵 / 聚焦标记平时是隐藏的：预热这一帧让它们露个面，着色器一并编译
    warmWeaponFx(true);
    if (ghosts.length) ghosts[0].mesh.visible = true; // 残影（亮度 0）：第一次冲刺 / 一闪时不再现编译着色器
    // 编码与后期处理的渲染目标、屏幕一致（sRGB）：这里编译出来的着色器就是之后真正要用的那一批
    const rt = new T.WebGLRenderTarget(64, 64, { encoding: T.sRGBEncoding });
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    rt.dispose();
    allyFxVisible(false);
    warmWeaponFx(false);
    if (ghosts.length) ghosts[0].mesh.visible = ghosts[0].on;
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
    // 双匕：两把交叉的叶形短刃；刃脊发光
    daggers: () => {
      const one = (s) => {
        const r = s * 0.42;
        const at = (x, y) => [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
        const P = (g, c, x, y, z, rx, ry, rz) => { const q = at(x, y); return [g, c, q[0], q[1], z, rx || 0, ry || 0, (rz || 0) + r]; };
        return [
          P(gPlate('lt/dag', [[-0.034, 0], [0.03, 0], [0.042, 0.19], [0.014, 0.37], [-0.03, 0.27], [-0.038, 0.12]], 0.012, 0.01), LC.steel, 0, -0.08, s * 0.02),
          P(gBox(0.15, 0.035, 0.05), LC.gold, 0, -0.09, s * 0.02),
          P(gCyl(0.022, 0.025, 0.13, 6), LC.dark, 0, -0.16, s * 0.02),
          P(gTorus(0.026, 0.009, 4, 8), LC.steelD, 0, -0.245, s * 0.02),
        ];
      };
      const glow = (s) => {
        const r = s * 0.42, x = -Math.sin(r) * 0.07, y = Math.cos(r) * 0.07;
        return [gBox(0.012, 0.2, 0.03), WH, x, y, s * 0.02, 0, 0, r];
      };
      return [bake('lt/daggers', one(1).concat(one(-1))), bake('lt/daggersG', [glow(1), glow(-1)])];
    },
    // 战锤：长柄 + 方砧锤头（两端包钢、顶上短刺），锤头两侧一道发光的符槽
    hammer: () => [
      bake('lt/hammer', [
        [gCyl(0.028, 0.032, 0.9, 6), LC.wood, 0, -0.1, 0], [gCyl(0.036, 0.036, 0.14, 6), LC.leatherD, 0, -0.42, 0],
        [gCyl(0.04, 0.04, 0.025, 6), LC.gold, 0, 0.12, 0], [gOct(0.045), LC.gold, 0, -0.57, 0],
        [gRBox(0.36, 0.17, 0.2, 0.03), LC.steelD, 0, 0.42, 0], [gCyl(0.1, 0.11, 0.06, 7), LC.steel, 0.2, 0.42, 0, 0, 0, Math.PI / 2], [gCyl(0.11, 0.1, 0.06, 7), LC.steel, -0.2, 0.42, 0, 0, 0, Math.PI / 2],
        [gCone(0.045, 0.15, 5), LC.steel, 0, 0.58, 0], [gBox(0.025, 0.18, 0.21), LC.gold, 0.12, 0.42, 0], [gBox(0.025, 0.18, 0.21), LC.gold, -0.12, 0.42, 0],
      ]),
      bake('lt/hammerG', [[gBox(0.16, 0.035, 0.212), WH, 0, 0.42, 0]]),
    ],
    // 长弓：竖着的一张弓，弓弦拉直；两片弓臂上各一道光纹
    bow: () => {
      const limb = (s) => [[0, s * 0.06, 0], [0, s * 0.24, -0.03], [0, s * 0.4, -0.01], [0, s * 0.5, 0.06], [0, s * 0.54, 0.13]];
      return [
        bake('lt/bow', [
          [gSweep('lt/bowU', limb(1), [0.026, 0.022, 0.017, 0.012, 0.008], 5), LC.leather, 0, 0, 0], [gSweep('lt/bowL', limb(-1), [0.026, 0.022, 0.017, 0.012, 0.008], 5), LC.leather, 0, 0, 0],
          [gCyl(0.03, 0.03, 0.14, 6), LC.leatherD, 0, 0, 0], [gCyl(0.034, 0.034, 0.02, 6), LC.gold, 0, 0.08, 0], [gCyl(0.034, 0.034, 0.02, 6), LC.gold, 0, -0.08, 0],
          [gCyl(0.005, 0.005, 1.08, 3), 0xe8e0c8, 0, 0, 0.13], [gOct(0.02), LC.gold, 0, 0.54, 0.13], [gOct(0.02), LC.gold, 0, -0.54, 0.13],
        ]),
        bake('lt/bowG', [[gBox(0.016, 0.14, 0.016), WH, 0, 0.26, -0.045], [gBox(0.016, 0.14, 0.016), WH, 0, -0.26, -0.045]]),
      ];
    },
    // 太刀：细长微弯的刃身、方圆的镡、缠绳的长柄；刃口一道刃纹光
    katana: () => {
      const L = 0.72, K = 0.045, pts = [[-0.026, 0], [0.026, 0]], edge = [];
      for (let i = 1; i <= 6; i++) { const t = (i / 6) * 0.9; pts.push([K * t * t + 0.026 - 0.008 * t, L * t]); }
      pts.push([K + 0.01, L]);
      for (let i = 6; i >= 1; i--) { const t = (i / 6) * 0.9; pts.push([K * t * t - 0.026 + 0.008 * t + (t > 0.85 ? 0.008 : 0), L * t]); edge.unshift([K * t * t - 0.014, -0.12 + L * t, 0]); }
      edge.unshift([-0.014, -0.11, 0]);
      return [
        bake('lt/katana', [
          [gPlate('lt/kat', pts, 0.01, 0.006), LC.steel, 0, -0.12, 0],
          [gCyl(0.065, 0.065, 0.018, 8), LC.dark, 0, -0.13, 0, 0, Math.PI / 8, 0], [gTorus(0.064, 0.007, 4, 8), LC.gold, 0, -0.13, 0, Math.PI / 2, 0, Math.PI / 8],
          [gCyl(0.022, 0.024, 0.24, 6), LC.dark, 0, -0.27, 0], [gOct(0.024), 0x7a2e24, 0.02, -0.22, 0, 0, 0, 0, 0.5, 1, 1], [gOct(0.024), 0x7a2e24, 0.02, -0.31, 0, 0, 0, 0, 0.5, 1, 1],
          [gCyl(0.026, 0.026, 0.025, 6), LC.gold, 0, -0.4, 0],
        ]),
        bake('lt/katanaG', [[gSweep('lt/hamon', edge, [0.008, 0.008, 0.006], 4), WH, 0, 0, 0]]),
      ];
    },
    // 魂幡：乌木杆、骨爪杆头，横挑杆挑着一面撕破的暗紫幡布，外端坠一枚小骷髅；魂火和幡面符印发光
    banner: () => [
      bake('lt/banner', [
        [gCyl(0.022, 0.028, 1.12, 6), 0x2a201b, 0, -0.02, 0], [gCone(0.026, 0.12, 5), LC.steelD, 0, -0.64, 0, Math.PI],
        [gCyl(0.032, 0.032, 0.12, 6), LC.leatherD, 0, -0.3, 0], [gCyl(0.036, 0.036, 0.022, 6), LC.gold, 0, 0.42, 0],
        [gTorus(0.03, 0.01, 4, 8), LC.bone, 0, 0.1, 0, Math.PI / 2], [gTorus(0.03, 0.01, 4, 8), LC.bone, 0, 0.14, 0, Math.PI / 2],
        [gCone(0.018, 0.14, 4), LC.bone, 0.05, 0.6, 0, 0, 0, -0.35], [gCone(0.018, 0.14, 4), LC.bone, -0.05, 0.6, 0, 0, 0, 0.35], [gCone(0.018, 0.14, 4), LC.bone, 0, 0.6, 0.05, 0.35, 0, 0],
        [gCyl(0.014, 0.016, 0.42, 5), 0x2a201b, 0.2, 0.36, 0, 0, 0, Math.PI / 2], [gOct(0.024), LC.gold, 0.42, 0.36, 0],
        [gPlate('lt/bnc', [[-0.15, 0], [-0.155, -0.36], [-0.12, -0.58], [-0.07, -0.42], [-0.02, -0.62], [0.04, -0.44], [0.09, -0.57], [0.13, -0.4], [0.15, 0]], 0.012, 0.004), 0x3a2c44, 0.22, 0.34, 0],
        [gBox(0.32, 0.02, 0.03), LC.bone, 0.22, 0.04, 0],
        [gCyl(0.004, 0.004, 0.14, 3), 0x6a5a48, 0.42, 0.29, 0], [gSph(0.034, 6, 5), LC.bone, 0.42, 0.2, 0],
      ]),
      bake('lt/bannerG', [
        [gOct(0.06), WH, 0, 0.53, 0, 0, 0, 0, 0.9, 1.3, 0.9],
        [gTorus(0.065, 0.008, 4, 12), WH, 0.22, 0.17, 0], [gBox(0.012, 0.28, 0.024), WH, 0.22, 0.16, 0], [gBox(0.12, 0.012, 0.024), WH, 0.22, 0.24, 0],
      ]),
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
  // 远程武器的掉落模型：三把枪横着（枪口朝 +y 方向斜指），四张弓竖着
  {
    const GM = 0x2b2d33, BR = 0xc8963c, CU = 0xb0643a, BLK = 0x221c1c;
    LOOT_MODEL.gatling = () => [
      bake('lt/gat', [
        [gRBox(0.14, 0.3, 0.14, 0.03), GM, 0, -0.08, 0], [gBox(0.05, 0.12, 0.06), 0x1c1a1d, 0, -0.26, -0.07, 0.4],
        [gCyl(0.07, 0.07, 0.07, 8), LC.steelD, 0.1, -0.08, -0.02, 0, 0, Math.PI / 2],
        ...[0, 1, 2, 3, 4, 5].map((k) => [gCyl(0.014, 0.014, 0.5, 5), LC.steel, Math.cos((k / 6) * TAU) * 0.04, 0.32, Math.sin((k / 6) * TAU) * 0.04]),
        [gTorus(0.058, 0.012, 4, 10), BR, 0, 0.1, 0, Math.PI / 2], [gTorus(0.058, 0.012, 4, 10), BR, 0, 0.55, 0, Math.PI / 2],
      ]),
      bake('lt/gatG', [[gBox(0.08, 0.02, 0.15), WH, 0, -0.02, 0.07], [gTorus(0.06, 0.006, 3, 10), WH, 0, 0.57, 0, Math.PI / 2]]),
    ];
    LOOT_MODEL.flamer = () => [
      bake('lt/flm', [
        [gRBox(0.1, 0.22, 0.1, 0.02), GM, 0, -0.14, 0], [gBox(0.05, 0.12, 0.06), 0x1c1a1d, 0, -0.3, -0.06, 0.4],
        [gCyl(0.034, 0.038, 0.46, 8), LC.steel, 0, 0.18, 0], [gCyl(0.065, 0.036, 0.11, 10), LC.steelD, 0, 0.45, 0],
        [gCyl(0.06, 0.06, 0.28, 10), CU, 0, -0.04, 0.1], [gTorus(0.062, 0.01, 4, 10), LC.steelD, 0, 0.04, 0.1, Math.PI / 2],
      ]),
      bake('lt/flmG', [[gOct(0.03), WH, 0, 0.52, -0.05], [gBox(0.012, 0.3, 0.012), WH, 0, 0.18, 0.036]]),
    ];
    LOOT_MODEL.revolver = () => [
      bake('lt/rev', [
        [gRBox(0.05, 0.16, 0.07, 0.02), 0x4a2a1c, 0, -0.16, -0.06, 0.4], [gRBox(0.06, 0.12, 0.1, 0.016), BLK, 0, -0.04, 0],
        [gCyl(0.048, 0.048, 0.1, 8), BLK, 0, 0.0, 0], [gCyl(0.024, 0.024, 0.34, 8), BLK, 0, 0.22, 0], [gTorus(0.026, 0.008, 4, 8), 0xd09048, 0, 0.39, 0, Math.PI / 2],
      ]),
      bake('lt/revG', [[gBox(0.008, 0.26, 0.01), WH, 0.026, 0.22, 0], [gBox(0.008, 0.2, 0.01), WH, -0.026, 0.25, 0]]),
    ];
    // extra（可选）：额外烘进本体的零件（冰弓的冰晶尖刺）
    const bowLoot = (key, col, fit, glow, curl, extra) => () => {
      const limb = (s) => [[0, s * 0.06, 0], [0, s * 0.24, -0.04 * curl], [0, s * 0.4, -0.02], [0, s * 0.5, 0.06], [0, s * 0.54, 0.13]];
      return [
        bake('lt/' + key, [
          [gSweep('lt/' + key + 'U', limb(1), [0.03, 0.025, 0.019, 0.013, 0.008], 5), col, 0, 0, 0], [gSweep('lt/' + key + 'L', limb(-1), [0.03, 0.025, 0.019, 0.013, 0.008], 5), col, 0, 0, 0],
          [gCyl(0.032, 0.032, 0.14, 6), LC.leatherD, 0, 0, 0], [gCyl(0.036, 0.036, 0.02, 6), fit, 0, 0.08, 0], [gCyl(0.036, 0.036, 0.02, 6), fit, 0, -0.08, 0],
          [gCyl(0.005, 0.005, 1.08, 3), 0xe8e0c8, 0, 0, 0.13], [gOct(0.022), fit, 0, 0.54, 0.13], [gOct(0.022), fit, 0, -0.54, 0.13],
        ].concat(extra || [])),
        bake('lt/' + key + 'G', glow),
      ];
    };
    LOOT_MODEL.eagle = LOOT_MODEL.bow;
    LOOT_MODEL.huntbow = bowLoot('hbow', 0x3a2c22, 0xd9cfb6, [[gOct(0.022), WH, 0, 0, -0.04], [gBox(0.014, 0.12, 0.014), WH, 0, 0.3, -0.06], [gBox(0.014, 0.12, 0.014), WH, 0, -0.3, -0.06]], 1.5);
    LOOT_MODEL.runebow = bowLoot('rbow', 0x3a4560, 0xb8c4d6, [[gTorus(0.07, 0.007, 3, 12), WH, 0, 0, -0.02, 0, Math.PI / 2, 0], [gBox(0.025, 0.02, 0.016), WH, 0, 0.22, -0.05], [gBox(0.025, 0.02, 0.016), WH, 0, -0.22, -0.05], [gBox(0.025, 0.02, 0.016), WH, 0, 0.36, -0.03], [gBox(0.025, 0.02, 0.016), WH, 0, -0.36, -0.03]], 1);
    // 冰弓：霜钢弓臂、霜银配件，弓背上四枚淡蓝冰晶尖刺；发光件（冰核 + 四段冰裂纹）是稀有度色，凛羽掉落时换成冰蓝（见 makeLoot）
    const EB_ICE = 0xbfe6fa, EB_ICE2 = 0x8cc8ee;
    LOOT_MODEL.emberbow = bowLoot('ebow', 0x46627e, 0xb4cce0, [[gOct(0.035), WH, 0, 0, -0.05], [gBox(0.012, 0.14, 0.012), WH, 0, 0.18, -0.06], [gBox(0.012, 0.14, 0.012), WH, 0, -0.18, -0.06], [gBox(0.012, 0.1, 0.012), WH, 0, 0.4, -0.02], [gBox(0.012, 0.1, 0.012), WH, 0, -0.4, -0.02]], 2, [
      [gOct(1), EB_ICE, 0, 0.26, -0.1, -0.5, 0, 0, 0.022, 0.075, 0.022], [gOct(1), EB_ICE, 0, -0.26, -0.1, 0.5, 0, 0, 0.022, 0.075, 0.022],
      [gOct(1), EB_ICE2, 0, 0.44, -0.04, -0.8, 0, 0, 0.017, 0.055, 0.017], [gOct(1), EB_ICE2, 0, -0.44, -0.04, 0.8, 0, 0, 0.017, 0.055, 0.017],
    ]);
  }
  const lootModels = Object.create(null);
  const WEAPON_MODEL = GEAR_KEYS; // 掉落模型的名字和武器种类同名
  let lootBody = null;
  let lootBodyU = null; // 烬铸武器掉在地上时的本体：带一点余烬自发光
  let lootBodyUIce = null; // 冰弓凛羽掉在地上时的本体：带一点冷蓝自发光

  // kind：item | cur | skill | blank（无铭技能宝石）| support。slot（可选，只对 item 有意义）：装备栏位名，或物品对象本身
  // （{ slot, baseIdx }，武器按 G.BASES.weapon[baseIdx].type 区分八种；也可以直接给 { slot: 'weapon', type }）。不传时是一只通用的小包裹。
  W.makeLoot = function (kind, hex, beam, x, z, slot) {
    const h = hexOf(hex);
    // 烬铸武器：更高更粗的双层光柱、更大的地面光盘、带一点余烬自发光的本体，悬着时不停往上冒火星
    const uq = kind === 'item' && !!slot && typeof slot === 'object' && slot.rarity === 3;
    let key = kind;
    if (kind === 'item') {
      const sl = slot && typeof slot === 'object' ? slot.slot : slot;
      if (sl === 'weapon') {
        const o = slot && typeof slot === 'object' ? slot : null;
        const bt = o ? o.type || baseType(o.baseIdx | 0) : null;
        key = bt && LOOT_MODEL[bt] ? bt : bt === 'bow' ? 'eagle' : WEAPON_MODEL[o ? gearIndex(o.baseIdx | 0) : 0];
      }
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
    if (WEAPON_MODEL.indexOf(key) >= 0 || BOW_TYPES.indexOf(key) >= 0) gem.rotation.z = key === 'bow' || BOW_TYPES.indexOf(key) >= 0 ? 0.3 : key === 'daggers' ? 0 : GUN_TYPES.indexOf(key) >= 0 ? 0.15 : 0.5; // 武器斜着悬在空中
    else if (key === 'ring' || key === 'amulet' || key === 'belt') gem.rotation.x = 0.35;
    if (uq && !lootBodyU) lootBodyU = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.55, envMap: rigEnvMap(), envMapIntensity: 1.0, flatShading: true, emissive: lin(0x7a2a06), emissiveIntensity: 0.9 });
    // 冰弓凛羽：本体透一点冷蓝而不是余烬橙，发光件冰蓝，往上冒的是霜雾冰晶（光柱、地面光盘、名牌仍是烬铸的颜色）
    const uqIce = uq && key === 'emberbow';
    if (uqIce && !lootBodyUIce) lootBodyUIce = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.5, envMap: rigEnvMap(), envMapIntensity: 1.0, flatShading: true, emissive: lin(0x0c3a6a), emissiveIntensity: 0.9 });
    if (mdl[0]) {
      const m = new T.Mesh(mdl[0], uqIce ? lootBodyUIce : uq ? lootBodyU : lootBody);
      m.castShadow = true;
      gem.add(m);
    }
    const g2 = new T.Mesh(mdl[1], lootMat(uqIce ? 0x4fb4ff : h));
    g2.castShadow = !mdl[0];
    gem.add(g2);
    grp.add(gem);
    const disc = new T.Mesh(gQuad(), discMat(h));
    disc.position.y = 0.05;
    const ds = uq ? 2.3 : beam ? 1.5 : 0.85;
    disc.scale.set(ds, 1, ds);
    disc.renderOrder = 2;
    grp.add(disc);
    if (beam) {
      const bm = uq
        ? new T.Mesh(geo('beamCylU', () => new T.CylinderGeometry(0.13, 0.15, 11, 10, 1, true).translate(0, 5.5, 0)), beamMat(h, 0.34))
        : new T.Mesh(geo('beamCyl', () => new T.CylinderGeometry(0.05, 0.13, 6.5, 8, 1, true).translate(0, 3.25, 0)), beamMat(h));
      bm.renderOrder = 5;
      grp.add(bm);
      if (uq) {
        // 里层一道更细、更亮的芯
        const core = new T.Mesh(geo('beamCylUc', () => new T.CylinderGeometry(0.03, 0.05, 9, 8, 1, true).translate(0, 4.5 + 1.0, 0)), beamMat(mixHex(h, 0xffffff, 0.5), 0.5));
        core.renderOrder = 5;
        grp.add(core);
      }
      const sp = new T.Sprite(spriteMat(h));
      sp.position.y = 0.6;
      sp.scale.setScalar(uq ? 1.2 : 1.4);
      grp.add(sp);
      if (uq) grp.userData.glow = sp;
    }
    const u = grp.userData;
    u.kind = 'loot';
    u.gem = gem;
    u.t = 0;
    u.spin = rand(1.4, 2.2);
    u.ph = rand(0, TAU);
    u.ember = uq ? 0 : -1; // 烬铸：火星的累计量（-1 不冒）
    u.frost = uqIce; // 冰弓凛羽：冒的是霜晶不是火星
    if (uq) {
      _c.set(h);
      u.er = _c.r;
      u.eg = _c.g;
      u.eb = _c.b;
    }
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
        // 卡通版：硬边的小圆点，中心一圈更亮（两档），不再是软绵绵的光斑
        'void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;\n' +
        ' float a = (1.0 - smoothstep(0.42, 0.5, d)) * (d < 0.24 ? 1.0 : 0.62);\n' +
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
      // 出生时快速淡入，后半段淡出；卡通版按三档跳变（不是平滑渐隐）
      const a0 = Math.min(1, f * 2, (1 - f) * 10 + 0.15), a = a0 > 0.66 ? 1 : a0 > 0.33 ? 0.6 : 0.3;
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
    '  float sfade = uK < 0.45 ? 1.0 : (uK < 0.75 ? 0.62 : 0.3);', // 卡通的几种痕迹：阶梯式淡出
    '  float n = vn(vP * 3.0 + 5.0) * 0.6 + vn(vP * 7.0) * 0.4;',
    '  float an = atan(vP.x, vP.y);',
    '  vec3 col = uColor; float a = 0.0;',
    '  if (uKind < 0.5) {', // 0 擦痕：沿局部 z 的一道亮线，头亮尾细
    '    float wv = 1.0 - abs(vP.x);',
    '    float along = smoothstep(-1.0, -0.2, vP.y) * (1.0 - smoothstep(0.35, 1.0, vP.y));',
    '    a = pow(wv, 4.0) * along * (1.0 - uK) * (1.0 - uK) * 0.6;',
    '    col = mix(uColor, vec3(1.0), pow(wv, 9.0) * 0.6);',
    '  } else if (uKind < 1.5) {', // 1 焦痕：不规则的焦斑（卡通版：硬边、深紫褐不是死黑），起初边缘一圈余烬色，淡出分三档
    '    float blot = 1.0 - smoothstep(0.5 + n * 0.3, 0.54 + n * 0.3, l);',
    '    float rim = step(0.36 + n * 0.22, l) * blot * step(uK, 0.3);',
    '    col = mix(vec3(0.07, 0.035, 0.05), uColor, rim);',
    '    a = blot * 0.82 * sfade;',
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
    '  } else if (uKind < 5.5) {', // 5 地裂：终结技砸出的放射状裂纹（卡通版：硬边），起初缝里透着光，淡出分三档
    '    float cr = step(abs(sin(an * 4.5 + n * 4.0)), 0.06 + 0.12 * l);',
    '    float reach = step(l, 0.6 + n * 0.4);',
    '    float core = step(l, 0.3 + n * 0.08);',
    '    float hot = step(uK, 0.3);',
    '    a = max(cr * reach, core * 0.75) * sfade * 0.92;',
    '    col = mix(vec3(0.07, 0.035, 0.05), uColor, hot * max(cr * reach, core * 0.6));',
    '  } else {', // 6 卡通命中印记：顺着打击方向（局部 +z）甩开的一摊星形印子，起初内圈是主色，之后压暗；淡出分三档
    '    vec2 q = vec2(vP.x, vP.y * 0.78 + 0.12);',
    '    float lq = length(q), aq = atan(q.x, q.y);',
    '    float rr = 0.5 + 0.32 * pow(abs(cos(aq * 2.5 + uSeed * 6.0)), 4.0) + 0.16 * cos(aq) + n * 0.12;',
    '    float body = step(lq, rr * 0.92);',
    '    float hot = step(lq, rr * 0.5) * step(uK, 0.35);',
    '    col = mix(uColor * 0.28 + vec3(0.03, 0.015, 0.04), uColor, hot);',
    '    a = body * 0.8 * sfade;',
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
  // ---------- 卡通特效色板（sRGB）：刀光 / 斩击弧取 [亮芯, 主色, 内沿]，命中碎片取 [亮芯, 主色, 暗边, 烟尘] ----------
  // 刀光一律是有颜色的实色月牙，不用纯白、不用加色：物理用青绿（主角围巾的色系，压在暖色地面上最跳），元素各用元素色。
  // 命中的火花反过来用暖金（青绿的刀光 + 暖色的迸溅，一冷一暖），烟尘是灰烬的冷灰紫
  const FX_PAL = {
    phys: [0xd6fff0, 0x4ce6cf, 0x0b7c84],
    fire: [0xfff0b0, 0xff8424, 0xc22c18],
    cold: [0xf0fbff, 0x78ccff, 0x2458d0],
    light: [0xfffbe0, 0xffdc40, 0xc8820e],
    chaos: [0xffd2f2, 0xf03cb4, 0x12061a], // 混沌：亮芯 / 品红 / 近黑的内沿
  };
  const HIT_PAL = {
    phys: [0xfff6d8, 0xffbe3c, 0xd2561c, 0x8a6a6e],
    fire: [0xfff0a0, 0xff7a22, 0xb02418, 0x6a4a48],
    cold: [0xf4fcff, 0x8fdcff, 0x2a62d0, 0xc4dcee],
    light: [0xfffce0, 0xffe04a, 0xb8700c, 0x9a8c7a],
    chaos: [0xffd8f4, 0xf04ab8, 0x3a0c46, 0x2a1830],
  };
  const _palTmp = [0, 0, 0, 0];
  // 伤害类型的代表色（G.TYPE_HEX）→ 色板；不认得的颜色就地推一组（浅芯 / 本色 / 压暗）
  function fxPal(hex, tbl) {
    const TH = G.TYPE_HEX, P = tbl || FX_PAL;
    for (const k in P) if (TH[k] === hex) return P[k];
    _palTmp[0] = mixHex(hex, 0xffffff, 0.75);
    _palTmp[1] = hex;
    _palTmp[2] = mixHex(hex, 0x000000, 0.5);
    _palTmp[3] = mixHex(hex, 0x8a7a86, 0.7);
    return _palTmp;
  }
  // 投掷蓄力的颜色：game.js 开始投掷时用 W.castTint(这一下的伤害类型色) 设置
  const castPal = FX_PAL.fire.slice();
  W.castTint = function (hex) {
    const p = fxPal(hex);
    for (let i = 0; i < 3; i++) castPal[i] = p[i];
  };
  // 刀光：一条跟着武器走的带子。采样点按「绕角色的圆弧」补间，60 帧下的快挥也是顺滑的弧。
  // 卡通版：越老的采样内沿越往刃尖收（头粗尾尖的月牙），横向三道硬边色带，不透明度只有三档
  const TRAIL_MAX = 56, TRAIL_LIFE = 0.18;
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
    trail.c0 = { value: new T.Color(1, 1, 1) };
    trail.c2 = { value: new T.Color(1, 1, 1) };
    const mat = new T.ShaderMaterial({
      uniforms: { uColor: trail.color, uC0: trail.c0, uC2: trail.c2 },
      vertexShader: 'attribute float aA; attribute float aU; varying float vA; varying float vU;\nvoid main(){ vA = aA; vU = aU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform vec3 uColor; uniform vec3 uC0; uniform vec3 uC2; varying float vA; varying float vU;',
        'void main(){',
        '  if (vA < 0.02) discard;',
        // 月牙：新的采样从握点铺到刃尖，越老内沿越往刃尖收
        '  float lo = 1.0 - pow(vA, 0.55);',
        '  float s = (vU - lo) / max(1.0 - lo, 0.001);',
        '  if (s < 0.0) discard;',
        // 横向三道硬边色带：刃尖一侧亮芯、中间主色、内沿深色
        '  vec3 col = s > 0.72 ? uC0 : (s > 0.34 ? uColor : uC2);',
        // 阶梯式淡出：三档不透明度
        '  float a = vA > 0.6 ? 0.96 : (vA > 0.3 ? 0.74 : 0.45);',
        '  gl_FragColor = vec4(col, a);',
        '}',
      ].join('\n'),
      transparent: true, depthWrite: false, side: T.DoubleSide,
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
      const k = 1 - tr.age[i] / TRAIL_LIFE, a = tr.mute[i] || k <= 0 ? 0 : k; // 卡通版的形状和阶梯都在着色器里按 k 算
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
    const p = fxPal(hex);
    trail.c0.value.set(p[0]);
    trail.color.value.set(p[1]);
    trail.c2.value.set(p[2]);
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
  const IMPACT_HEX = { phys: 0xfff0d0, fire: 0xff7a2c, cold: 0x9fe0ff, light: 0xffec70, chaos: 0xff6ad2 };
  // 卡通版：命中点一颗硬边的星，顺着打击方向甩出几片实色尖片，脚下扬起实心的烟团，地上留一摊星形的印子；
  // 原来的细火花只留一小半。低画质碎块减半
  W.impact = function (x, y, z, ang, type, w, crit) {
    const hex = IMPACT_HEX[type] || IMPACT_HEX.phys, pal = HIT_PAL[type] || HIT_PAL.phys, lo = qualId === 'low';
    _c.set(hex);
    const r = _c.r, g = _c.g, b = _c.b, sn = Math.sin(ang), cs = Math.cos(ang);
    tChunk(1, x - sn * 0.15, y + 0.1, z - cs * 0.15, 0, 0, 0, 0.16 + w * 0.03, 0.46 + w * 0.12 + (crit ? 0.16 : 0), pal[0], pal[1], 0);
    for (let i = 0, m = (lo ? 2 : 4) + w * 2 + (crit ? 2 : 0); i < m; i++) {
      const a = ang + rand(-0.75, 0.75) * (i % 3 === 0 ? 1.8 : 1), v = (7 + w * 2.5) * rand(0.45, 1);
      tChunk(0, x, y + rand(-0.15, 0.2), z, Math.sin(a) * v, rand(1.5, 5) + w, Math.cos(a) * v, rand(0.2, 0.34) + w * 0.03, rand(0.13, 0.2) + w * 0.03, pal[0], i % 2 ? pal[1] : pal[2], 16);
    }
    tPuffs(x + sn * 0.2, 0.3, z + cs * 0.2, (lo ? 1 : 2) + w, 1.6 + w * 0.6, 0.9, 0.36 + w * 0.06, 0.24 + w * 0.05, mixHex(pal[3], 0xf4e2d4, 0.7), pal[3]);
    const n = 3 + w * 2 + (crit ? 3 : 0), sp = 9 + w * 3.5;
    for (let i = 0; i < n; i++) {
      const a = ang + rand(-0.7, 0.7) * (i % 4 === 0 ? 2.2 : 1), v = sp * rand(0.35, 1);
      const wh = i % 3 === 0 ? 0.35 : 0.08; // 卡通版：火花保留颜色，少混白
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
    }
    // （物理的尘土由上面的实心烟团代替）
    W.decal(6, x + sn * 0.35, z + cs * 0.35, 0.5 + w * 0.22 + (crit ? 0.1 : 0), ang, pal[1], 0.55 + w * 0.2);
    if (w >= 1 || crit) flashLight(x, y + 1, z, hex, 0.5 + w * 0.3);
  };
  // 终结技砸地：落点一颗大星，一圈往外推的实心尘团，几片朝前甩的碎石尖片（ang 是劈下去的方向）
  W.smashFx = function (x, z, R, ang) {
    const lo = qualId === 'low', P = HIT_PAL.phys;
    tChunk(1, x, 0.6, z, 0, 0, 0, 0.22, 0.75 + R * 0.08, P[0], P[1], 0);
    const dust = mixHex(P[3], 0xf4e2d4, 0.7);
    for (let i = 0, n = lo ? 6 : 11; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.2, 0.2), v = R * rand(1.8, 2.6);
      tChunk(2, x + Math.sin(a) * R * 0.35, 0.3, z + Math.cos(a) * R * 0.35, Math.sin(a) * v, rand(0.6, 1.6), Math.cos(a) * v, rand(0.42, 0.58), rand(0.38, 0.55), dust, P[3], -0.6);
    }
    for (let i = 0, n = lo ? 4 : 7; i < n; i++) {
      const a = ang + rand(-1.3, 1.3), v = rand(5, 9);
      tChunk(0, x, 0.4, z, Math.sin(a) * v, rand(4, 8), Math.cos(a) * v, rand(0.45, 0.65), rand(0.2, 0.3), i % 2 ? P[1] : 0xb07a5c, i % 2 ? P[2] : 0x5a3a4c, 22);
    }
    flashLight(x, 1.5, z, 0xffc070, 0.8);
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
    'uniform vec3 uColor; uniform vec3 uC0; uniform float uK; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP);',
    '  float rr = 0.12 + 0.88 * (1.0 - (1.0 - uK) * (1.0 - uK));', // 先快后慢地扩张
    // 卡通版：一道硬边的色环，越扩越细；外缘一条浅色亮边；不透明度三档
    '  float w = 0.05 + 0.13 * (1.0 - uK);',
    '  if (l > rr || l < rr - w) discard;',
    '  float lit = step(rr - w * 0.35, l);',
    '  float a = uK < 0.45 ? 0.9 : (uK < 0.75 ? 0.62 : 0.32);',
    '  gl_FragColor = vec4(mix(uColor, uC0, lit), a);',
    '}',
  ].join('\n');
  // 斩击弧（卡通版）：一弯实色的月牙从弧的一端扫到另一端。前沿最厚、往尾巴收尖，弧的两端也收尖；
  // 径向三道硬边色带（外沿亮芯 uC0 / 主色 uColor / 内沿深色 uC2），不透明度三档。普通混合，不会叠成一片白
  const SLASH_FRAG = [
    'uniform vec3 uColor; uniform vec3 uC0; uniform vec3 uC2; uniform float uK; uniform float uArc; uniform float uDir; uniform float uIn; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP);',
    '  float an = atan(vP.x, vP.y) / uArc;', // 弧内为 -1..1（vP.y 是局部 +z，即朝向）
    '  if (abs(an) > 1.0 || l > 1.0) discard;',
    '  float h = (an * uDir) * 0.5 + 0.5;', // 0 = 起点，1 = 终点
    '  float d = uK * 2.1 - h;', // 到前沿的距离（> 0 是已经扫过的部分）
    '  if (d < 0.0 || d > 0.7) discard;',
    '  float tail = d / 0.7;',
    '  float ends = min(1.0, min(h, 1.0 - h) * 7.0);',
    '  float thick = (1.0 - uIn) * (1.0 - tail * tail) * ends;',
    '  float s = (l - (1.0 - thick)) / max(thick, 0.001);', // 0 = 内沿，1 = 外沿
    '  if (s < 0.0) discard;',
    '  vec3 col = s > 0.74 ? uC0 : (s > 0.34 ? uColor : uC2);',
    '  float a = uK < 0.42 ? 0.9 : (uK < 0.7 ? 0.62 : 0.32);',
    // phase 3：内沿那一道（暗色带）只留 40% 不透明，月牙压在敌人身上时还看得见敌人；亮芯和主色带不变，形状照样是实色的
    '  if (s <= 0.34) a *= 0.4;',
    '  gl_FragColor = vec4(col, a);',
    '}',
  ].join('\n');

  // blend：缺省加色；卡通的斩击弧 / 冲击环用普通混合（T.NormalBlending），颜色才立得住
  function makePool(frag, extraUniforms, max, blend) {
    return { items: [], frag, extraUniforms, max, blend: blend || T.AdditiveBlending };
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
    if (pool.extraUniforms) for (const k of pool.extraUniforms) uniforms[k] = { value: k.charAt(1) === 'C' ? new T.Color() : 0 }; // uC0 / uC2：颜色
    const mat = new T.ShaderMaterial({
      uniforms, vertexShader: FX_VERT, fragmentShader: pool.frag,
      transparent: true, depthWrite: false, blending: pool.blend, side: T.DoubleSide,
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
  const ringPool = makePool(RING_FRAG, ['uC0'], 28, T.NormalBlending);
  const slashPool = makePool(SLASH_FRAG, ['uArc', 'uDir', 'uIn', 'uC0', 'uC2'], 12, T.NormalBlending);

  W.ring = function (x, z, r, hex, dur) {
    const it = poolGet(ringPool);
    it.on = true;
    it.t = 0;
    it.dur = dur || 0.4;
    const pal = fxPal(hexOf(hex)); // 卡通版：环身取主色、外缘取亮芯色（伤害类型的代表色映射到色板，其余颜色就地推）
    it.u.uColor.value.set(pal[1]);
    it.u.uC0.value.set(pal[0]);
    it.u.uK.value = 0;
    it.mesh.position.set(x, 0.1, z);
    it.mesh.scale.set(r, 1, r);
    it.mesh.visible = true;
  };

  // opts（可选）：{ dir: 1 | -1 刀光扫过的方向, dur 时长, y 高度, inner 月牙内沿（0 ~ 0.9，越大越细）, tilt 侧倾 / pitch 俯仰（弧度） }
  W.slash = function (x, z, ang, range, arcDeg, hex, opts) {
    const it = poolGet(slashPool), o = opts || {};
    it.on = true;
    it.t = 0;
    it.dur = o.dur || 0.22;
    const pal = fxPal(hexOf(hex));
    it.u.uC0.value.set(pal[0]);
    it.u.uColor.value.set(pal[1]);
    it.u.uC2.value.set(pal[2]);
    it.u.uK.value = 0;
    const half = (arcDeg * Math.PI) / 360;
    it.u.uArc.value = Math.min(Math.PI, half);
    it.u.uDir.value = o.dir === -1 ? -1 : 1;
    it.u.uIn.value = o.inner === undefined ? 0.3 : o.inner;
    it.mesh.position.set(x, o.y === undefined ? 0.95 : o.y, z);
    // tilt：绕朝向轴侧倾（弧度，正 = 局部 +x 一侧抬高；dir = 1 时那一侧是刀光的终点），上挑的一刀不再是平铺在地上的一片；
    // pitch：整片绕自身的横轴俯仰（负 = 弧的中线往上抬）。tilt = π/2 时月牙竖起来，配合 pitch 画从头顶劈到地上的竖劈
    it.mesh.rotation.order = 'YXZ';
    it.mesh.rotation.set(o.pitch || 0, ang, o.tilt || 0);
    it.mesh.scale.set(range, 1, range);
    it.mesh.visible = true;
    // 弧线外沿甩出的几片实色碎片（低画质减半）
    const y = o.y === undefined ? 0.95 : o.y;
    for (let i = 0, n = qualId === 'low' ? 2 : 4; i < n; i++) {
      const a = ang + rand(-half, half) * 0.9, d = range * rand(0.8, 1.0), v = rand(3.5, 6);
      tChunk(0, x + Math.sin(a) * d, y, z + Math.cos(a) * d, Math.sin(a) * v, rand(0.5, 2.5), Math.cos(a) * v, rand(0.16, 0.26), rand(0.12, 0.18), pal[0], pal[1], 6);
    }
  };

  // ----- 闪电：预分配的带状网格 -----
  const BOLT_MAXP = 220, BOLT_MAXIN = 24, BOLT_LIFE = 0.34;
  const bolts = [];
  // minor：感电放出的小电弧。它们同时最多占 BOLT_MINOR 条，池满时先被顶掉，不会挤掉链雷自己的电弧
  const BOLT_POOL = 12, BOLT_MINOR = 4;
  function boltGet(minor) {
    let free = null, oldMinor = null, oldAny = null, minorN = 0;
    for (let i = 0; i < bolts.length; i++) {
      const b = bolts[i];
      if (!b.on) {
        if (!free) free = b;
        continue;
      }
      if (b.minor) {
        minorN++;
        if (!oldMinor || b.t > oldMinor.t) oldMinor = b;
      }
      if (!oldAny || b.t > oldAny.t) oldAny = b;
    }
    if (minor && minorN >= BOLT_MINOR) return oldMinor;
    if (free) return free;
    if (bolts.length >= BOLT_POOL) return minor ? oldMinor : oldMinor || oldAny; // 池满：先顶掉小电弧，再顶掉最老的
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
    const b = { mesh, mat, pos, on: false, t: 0, n: 0, inX: new Float32Array(BOLT_MAXIN), inZ: new Float32Array(BOLT_MAXIN), path: new Float32Array(BOLT_MAXP * 2), wid: new Float32Array(BOLT_MAXP), jit: 0, minor: false, hex: 0 };
    bolts.push(b);
    return b;
  }
  // 把输入折线细分成锯齿路径，再挤出成贴地朝上的带子；主干上再随机岔出几根渐细的分叉。
  // 各段之间用零宽的顶点对隔开（连接处的四边形面积为零），主干和分叉共用一条带子、一次 draw call
  function boltBuild(b) {
    const path = b.path, wid = b.wid, HW = 0.36;
    let np = 0;
    for (let i = 0; i < b.n - 1; i++) {
      const ax = b.inX[i], az = b.inZ[i], bx = b.inX[i + 1], bz = b.inZ[i + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 0.001;
      const sub = Math.max(2, Math.min(10, Math.ceil(len / 1.0)));
      const nx = -dz / len, nz = dx / len;
      for (let k = 0; k < sub; k++) {
        if (np >= 120) break;
        const t = k / sub;
        const off = k === 0 ? 0 : rand(-0.5, 0.5) * Math.min(1, len * 0.25);
        path[np * 2] = ax + dx * t + nx * off;
        path[np * 2 + 1] = az + dz * t + nz * off;
        wid[np] = HW * (k === 0 ? 1.15 : rand(0.75, 1.1)); // 粗细略有起伏，像在噼啪作响
        np++;
      }
    }
    path[np * 2] = b.inX[b.n - 1];
    path[np * 2 + 1] = b.inZ[b.n - 1];
    wid[np] = HW;
    np++;
    const main = np;
    // 分叉：从主干上随机一点岔出去，偏开 0.5–1.1 弧度，3–4 折，越往外越细
    const forks = b.minor ? (Math.random() < 0.5 ? 1 : 0) : Math.min(7, 2 + Math.floor(main / 4));
    for (let f = 0; f < forks; f++) {
      if (np + 8 > BOLT_MAXP) break;
      const j = 1 + Math.floor(Math.random() * Math.max(1, main - 2));
      const j1 = Math.min(main - 1, j + 1);
      let tx = path[j1 * 2] - path[j * 2], tz = path[j1 * 2 + 1] - path[j * 2 + 1];
      const tl = Math.hypot(tx, tz) || 1;
      const ang = Math.atan2(tx / tl, tz / tl) + (Math.random() < 0.5 ? -1 : 1) * rand(0.5, 1.1);
      const flen = b.minor ? rand(0.4, 0.9) : rand(0.9, 2.4), segs = 3 + (Math.random() < 0.5 ? 1 : 0);
      let x = path[j * 2], z = path[j * 2 + 1];
      // 零宽的隔断：上一段的末点、这一段的起点
      path[np * 2] = path[(np - 1) * 2]; path[np * 2 + 1] = path[(np - 1) * 2 + 1]; wid[np] = 0; np++;
      path[np * 2] = x; path[np * 2 + 1] = z; wid[np] = 0; np++;
      path[np * 2] = x; path[np * 2 + 1] = z; wid[np] = HW * 0.55; np++;
      let a = ang;
      for (let k = 1; k <= segs; k++) {
        a += rand(-0.45, 0.45);
        x += Math.sin(a) * (flen / segs);
        z += Math.cos(a) * (flen / segs);
        path[np * 2] = x; path[np * 2 + 1] = z;
        wid[np] = HW * 0.55 * (1 - k / segs) + 0.01;
        np++;
      }
    }
    const pos = b.pos;
    let seg0 = 0;
    for (let i = 0; i < np; i++) {
      if (wid[i] === 0) seg0 = i + 1;
      // 切线只在本段内取（不跨隔断）
      const i0 = Math.max(seg0, i - 1);
      let i1 = i + 1;
      if (i1 >= np || wid[i1] === 0) i1 = i;
      let dx = path[i1 * 2] - path[i0 * 2], dz = path[i1 * 2 + 1] - path[i0 * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const x = path[i * 2], z = path[i * 2 + 1], o = i * 6, w = wid[i];
      pos[o] = x - dz * w; pos[o + 1] = 1.25; pos[o + 2] = z + dx * w;
      pos[o + 3] = x + dz * w; pos[o + 4] = 1.25; pos[o + 5] = z - dx * w;
    }
    b.mesh.geometry.attributes.position.needsUpdate = true;
    b.mesh.geometry.setDrawRange(0, (np - 1) * 6);
  }
  W.bolt = function (points, hex, minor) {
    if (points.length < 2) return;
    const b = boltGet(!!minor);
    if (!b) return;
    b.minor = !!minor;
    b.n = Math.min(points.length, BOLT_MAXIN);
    for (let i = 0; i < b.n; i++) {
      b.inX[i] = points[i].x;
      b.inZ[i] = points[i].z;
    }
    b.on = true;
    b.t = 0;
    b.jit = 0;
    b.hex = hex;
    b.mat.color.set(hex).lerp(_c2.set(0xffffff), 0.35).convertSRGBToLinear();
    b.mat.opacity = 1;
    boltBuild(b);
    b.mesh.visible = true;
    // 每个落点：一记亮闪 + 一小撮火花 + 一团慢慢熄掉的余辉
    _c.set(hex);
    for (let i = 1; i < b.n; i++) {
      const x = b.inX[i], z = b.inZ[i];
      for (let k = 0; k < 5; k++) {
        spawnP(x, 1.2, z, rand(-4, 4), rand(0, 4), rand(-4, 4), rand(0.15, 0.35), 0.16, _c.r, _c.g, _c.b, 8, 2);
      }
      if (!minor) {
        flare(x, 1.25, z, hex, 1.9, 0.14);
        spawnP(x, 1.2, z, 0, 0, 0, 0.32, 1.1, _c.r * 0.55, _c.g * 0.55, _c.b * 0.55, 0, 0);
        for (let k = 0; k < 4; k++) {
          const a = rand(0, TAU), v = rand(9, 15);
          spawnP(x, 1.2, z, Math.sin(a) * v, rand(-2, 5), Math.cos(a) * v, rand(0.05, 0.12), 0.12, 1, 1, 0.85, 0, 6);
        }
      }
    }
    if (!minor) flare(b.inX[0], 1.25, b.inZ[0], hex, 1.1, 0.1);
    flashLight(b.inX[b.n - 1], 2.5, b.inZ[b.n - 1], hex, 1.4);
  };
  const BOLT_JIT = [0.05, 0.15, 0.24], BOLT_JIT_MINOR = [0.07];
  // 前 0.1 秒是亮的主闪（中途重抖一次），之后是一段忽明忽暗、越来越暗的余辉，期间电弧再跳两次
  function updateBolts(dt) {
    for (let i = 0; i < bolts.length; i++) {
      const b = bolts[i];
      if (!b.on) continue;
      b.t += dt;
      const life = b.minor ? 0.17 : BOLT_LIFE;
      if (b.t >= life) {
        b.on = false;
        b.mesh.visible = false;
        continue;
      }
      const JIT = b.minor ? BOLT_JIT_MINOR : BOLT_JIT;
      if (b.jit < JIT.length && b.t > JIT[b.jit]) {
        b.jit++;
        boltBuild(b);
      }
      const k = b.t / life;
      if (b.minor || b.t < 0.1) b.mat.opacity = 1 - k * k;
      else {
        const fl = Math.random();
        b.mat.opacity = Math.pow(1 - k, 1.4) * (fl < 0.2 ? 0.08 : 0.45 + fl * 0.55);
      }
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
  // 陨石：一块玄武岩（受光的岩体，贴着发光的熔岩裂纹，裂纹按陨石颜色着色），拖着火焰尾和黑烟落下；
  // 落地时一道冲击环、碎石四溅、扬起尘土（首领召来的落石再留一块焦痕）
  const meteorMats = Object.create(null);
  function meteorMat(hex) {
    return (
      meteorMats[hex] ||
      (meteorMats[hex] = new T.MeshStandardMaterial({
        color: 0x5a524c, map: basaltTex(), emissiveMap: crackTex(), emissive: lin(mixHex(hex, 0xffffff, 0.08)), emissiveIntensity: 2.4,
        roughness: 0.9, metalness: 0.05, flatShading: true,
      }))
    );
  }
  const meteors = [];
  // hostile（可选）：首领召来的落石
  W.meteorFall = function (x, z, delay, hex, hostile) {
    let m = null;
    for (let i = 0; i < meteors.length; i++) if (!meteors[i].on) { m = meteors[i]; break; }
    if (!m && meteors.length >= 12) {
      m = meteors[0];
      for (let i = 1; i < meteors.length; i++) if (meteors[i].t / meteors[i].dur > m.t / m.dur) m = meteors[i];
    }
    if (!m) {
      const mesh = new T.Mesh(rockGeo(1), meteorMat(0xffffff));
      const glow = new T.Sprite(spriteMat(0xffffff));
      glow.scale.setScalar(5);
      mesh.add(glow);
      mesh.scale.setScalar(0.78);
      scene.add(mesh);
      m = { mesh, glow, on: false, t: 0, dur: 1, x: 0, z: 0, r: 1, g: 1, b: 1, lr: 1, lg: 1, lb: 1, hex: 0, gen: 0, rib: -1, sm: 0, hostile: false };
      meteors.push(m);
    }
    m.gen++;
    const h = hexOf(hex);
    m.mesh.material = meteorMat(h);
    m.glow.material = spriteMat(h);
    _c.set(h);
    m.r = _c.r; m.g = _c.g; m.b = _c.b;
    _c.convertSRGBToLinear();
    m.lr = _c.r; m.lg = _c.g; m.lb = _c.b;
    m.hex = h;
    m.x = x; m.z = z;
    m.t = 0;
    m.dur = Math.max(0.05, delay);
    m.on = true;
    m.hostile = !!hostile;
    m.sm = 0;
    ribRelease(m.rib);
    m.rib = ribGet(0.6, 0.14, m.r + (1 - m.r) * 0.55, m.g + (1 - m.g) * 0.55, m.b + (1 - m.b) * 0.55, m.r * 0.55, m.g * 0.4, m.b * 0.35);
    m.mesh.visible = true;
    m.mesh.position.set(x - 6, 26, z - 9);
    m.mesh.rotation.set(rand(0, TAU), rand(0, TAU), 0);
    return { m, gen: m.gen };
  };
  function meteorOff(m) {
    m.on = false;
    m.mesh.visible = false;
    ribRelease(m.rib);
    m.rib = -1;
  }
  // 取消一颗还在半空的陨石（传入 meteorFall 的返回值）：首领被打出破绽时，它召来的落石一起消失
  W.cancelMeteor = function (tok) {
    if (!tok || !tok.m.on || tok.m.gen !== tok.gen) return;
    const m = tok.m;
    meteorOff(m);
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
      m.mesh.rotation.x += dt * 5;
      m.mesh.rotation.z += dt * 3;
      for (let j = 0; j < 3; j++) {
        const w = Math.random() * 0.4;
        spawnP(px + rand(-0.3, 0.3), py + rand(-0.3, 0.3), pz + rand(-0.3, 0.3), rand(-1, 1), rand(0, 2), rand(-1, 1), rand(0.25, 0.55), rand(0.3, 0.6), m.r + (1 - m.r) * w, m.g + (1 - m.g) * w, m.b + (1 - m.b) * w, -1, 1);
      }
      if (k >= 1) {
        meteorOff(m);
        meteorLand(m);
      }
    }
  }
  function meteorLand(m) {
    const x = m.x, z = m.z;
    flashLight(x, 2.5, z, m.hex, 3);
    flare(x, 0.8, z, mixHex(m.hex, 0xffffff, 0.4), 2.6, 0.14);
    W.ring(x, z, 2.6, mixHex(m.hex, 0xffffff, 0.65), 0.2); // 冲击环
    for (let j = 0; j < 14; j++) {
      const a = rand(0, TAU), sp = rand(3, 9);
      spawnP(x, 0.3, z, Math.sin(a) * sp, rand(1, 6), Math.cos(a) * sp, rand(0.4, 0.9), rand(0.2, 0.4), m.r, m.g, m.b, 10, 1.2);
    }
    debrisBurst(x, z, m.hostile ? 7 : 11, m.hex, m.hostile ? 0.8 : 1);
    // 尘土：贴地往外推的一圈灰黄色烟
    for (let j = 0; j < 10; j++) {
      const a = (j / 10) * TAU + rand(-0.2, 0.2), v = rand(2.5, 4.5);
      spawnS(x + Math.sin(a) * 0.6, rand(0.2, 0.6), z + Math.cos(a) * 0.6, Math.sin(a) * v, rand(0.3, 1.2), Math.cos(a) * v, rand(0.7, 1.1), rand(1.0, 1.6), 0.3, 0.26, 0.21, 0.55);
    }
    smokeLive = 1.5;
    if (m.hostile) W.decal(1, x, z, 1.7, rand(0, TAU), m.hex, 3);
  }

  // ---------- 元素异常的特效 ----------
  // 冻结（首领是重度冰缓）：脚下一片霜痕、一圈冰晶碎屑
  W.freezeFx = function (x, z, r, h, boss) {
    W.decal(2, x, z, r + (boss ? 1.6 : 0.7), Math.random() * TAU, 0x9fdcff, boss ? 3 : 2);
    W.ring(x, z, r + 1.4, 0xbfeaff, 0.35);
    W.burst(x, h * 0.5, z, 0xd6f3ff, boss ? 26 : 16, 4, 0.5);
    _c.set(0xd6f3ff);
    for (let i = 0; i < 10; i++) {
      const a = rand(0, TAU), d = rand(0.2, r + 0.4);
      spawnP(x + Math.sin(a) * d, rand(0.2, h), z + Math.cos(a) * d, 0, rand(-0.4, 0.4), 0, rand(0.5, 0.9), rand(0.12, 0.22), _c.r, _c.g, _c.b, 1.5, 3);
    }
  };
  // 爆燃：以敌人为中心的火焰爆炸
  // 卡通版：一道硬边色环 + 一颗星 + 一圈实心火团 + 少量火星（原来是两道同心环 + 48 粒软光点）
  W.blastFx = function (x, z, R) {
    const lo = qualId === 'low', P = HIT_PAL.fire;
    W.ring(x, z, R, 0xff7a2c, 0.42);
    W.decal(1, x, z, R * 0.8, Math.random() * TAU, 0xff6a2a, 3);
    tChunk(1, x, 1.0, z, 0, 0, 0, 0.2, 0.8 + R * 0.12, P[0], P[1], 0);
    for (let i = 0, n = lo ? 5 : 9; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.3, 0.3), v = rand(1.4, 2.4) * R;
      tChunk(2, x + Math.sin(a) * 0.3, 0.8, z + Math.cos(a) * 0.3, Math.sin(a) * v, rand(1, 2.4), Math.cos(a) * v, rand(0.34, 0.5), rand(0.36, 0.5), i % 3 ? 0xff7a22 : 0xffd060, i % 3 ? P[2] : 0xff7a22, -1.5);
    }
    W.burst(x, 0.9, z, 0xff7a2c, lo ? 8 : 14, 8, 0.5);
    W.shake(0.2);
  };
  // 感电的电弧：一道细小的闪电从 (x0,z0) 窜到 (x1,z1)，沿途带着往前飞的火花；self：没有别的目标，绕回自己身上
  W.spark = function (x0, y0, z0, x1, y1, z1, self) {
    if (self) {
      const a = rand(0, TAU);
      W.bolt([{ x: x1 + Math.sin(a) * 1.4, z: z1 + Math.cos(a) * 1.4 }, { x: x1, z: z1 }], 0xffe45e, true);
    } else {
      const mx = (x0 + x1) / 2 + rand(-0.6, 0.6), mz = (z0 + z1) / 2 + rand(-0.6, 0.6);
      W.bolt([{ x: x0, z: z0 }, { x: mx, z: mz }, { x: x1, z: z1 }], 0xffe45e, true);
    }
    _c.set(0xfff3a0);
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    for (let i = 0; i < 6; i++) {
      const f = i / 6;
      spawnP(x0 + dx * f, y0 + dy * f, z0 + dz * f, dx * 4, dy * 4 + rand(-1, 1), dz * 4, rand(0.08, 0.18), 0.14, _c.r, _c.g, _c.b, 0, 4);
    }
  };
  // 光环打中的敌人身上飘几粒霜屑（不闪白，免得一圈敌人每半秒集体发亮）
  W.frostSparkle = function (x, y, z, r) {
    _c.set(0xcfeeff);
    for (let i = 0; i < 3; i++) {
      const a = rand(0, TAU), d = rand(0, r);
      spawnP(x + Math.sin(a) * d, y + rand(-0.4, 0.5), z + Math.cos(a) * d, rand(-0.3, 0.3), rand(0.2, 0.8), rand(-0.3, 0.3), rand(0.3, 0.55), rand(0.08, 0.14), _c.r, _c.g, _c.b, -0.2, 1.5);
    }
  };

  // =====================================================================
  // 武器技的特效（全部预先建池，运行时只改参数，不分配）
  // =====================================================================
  // ----- 光带：直刺的枪芒 / 冲刺的路径 / 延迟落下的斩线 / 地脉 -----
  // 方片沿 ang 摆放：局部 x 横跨、z 顺着方向；mode 0 = 从尾到头射出再从尾部收掉，1 = 先是一道细暗线、到时刻 uD 骤亮再收细消失
  const STREAK_FRAG = [
    'uniform vec3 uColor; uniform float uK; uniform float uMode; uniform float uD; varying vec2 vP;',
    'void main(){',
    '  float a = abs(vP.x); float s = vP.y * 0.5 + 0.5;',
    '  float core = exp(-a * a * 9.0); float hot = exp(-a * a * 60.0);',
    '  float al; float wh;',
    '  if (uMode < 0.5) {',
    '    float head = smoothstep(0.0, 0.3, uK); float tail = smoothstep(0.2, 1.0, uK);',
    '    float m = (1.0 - smoothstep(head - 0.04, head, s)) * smoothstep(tail - 0.02, tail + 0.18, s);',
    '    float tip = 0.55 + 0.45 * s;',
    '    al = m * (core * 0.8 + hot * 1.2) * tip * (1.0 - uK * 0.5); wh = hot;',
    '  } else {',
    '    float ends = smoothstep(0.0, 0.2, s) * (1.0 - smoothstep(0.8, 1.0, s));',
    '    if (uK < uD) { float f = uK / max(uD, 0.001); al = exp(-a * a * 200.0) * ends * (0.35 + 0.45 * f) * (0.75 + 0.25 * sin(uK * 90.0)); wh = 0.3 * f; }',
    '    else { float f = (uK - uD) / max(1.0 - uD, 0.001); float w = mix(1.0, 0.12, f);',
    '      al = exp(-a * a * 9.0 / (w * w + 0.01)) * ends * (1.0 - f * f) * 1.5; wh = exp(-a * a * 60.0 / (w * w + 0.01)); }',
    '  }',
    '  gl_FragColor = vec4(mix(uColor, vec3(1.0), wh * 0.75), al);',
    '}',
  ].join('\n');
  const streaks = [];
  function streakGet() {
    let it = null;
    for (let i = 0; i < streaks.length; i++) if (!streaks[i].on) { it = streaks[i]; break; }
    if (!it && streaks.length >= 24) {
      it = streaks[0];
      for (let i = 1; i < streaks.length; i++) if (streaks[i].t / streaks[i].dur > it.t / it.dur) it = streaks[i];
    }
    if (!it) {
      const u = { uColor: { value: new T.Color() }, uK: { value: 0 }, uMode: { value: 0 }, uD: { value: 0 } };
      const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: FX_VERT, fragmentShader: STREAK_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
      const mesh = new T.Mesh(gQuad(), mat);
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      it = { mesh, u, on: false, t: 0, dur: 1, x: 0, z: 0, y: 1, ang: 0, hex: 0xffffff, fired: true, sparks: 0 };
      streaks.push(it);
    }
    return it;
  }
  // 从 (x0,z0) 朝 ang 方向长 len 的一道光带
  function streak(x0, z0, y, ang, len, hw, hex, dur, mode, delay) {
    const it = streakGet(), sn = Math.sin(ang), cs = Math.cos(ang);
    it.on = true;
    it.t = 0;
    it.dur = dur;
    it.u.uColor.value.set(hex);
    it.u.uK.value = 0;
    it.u.uMode.value = mode;
    it.u.uD.value = mode ? Math.min(0.9, delay / dur) : 0;
    it.fired = !mode;
    it.x = x0 + sn * len * 0.5;
    it.z = z0 + cs * len * 0.5;
    it.y = y;
    it.ang = ang;
    it.hex = hex;
    it.len = len;
    it.mesh.position.set(it.x, y, it.z);
    it.mesh.rotation.order = 'XYZ';
    it.mesh.rotation.set(0, ang, 0);
    it.mesh.scale.set(hw, 1, len * 0.5);
    it.mesh.visible = true;
    return it;
  }
  function updateStreaks(dt) {
    for (let i = 0; i < streaks.length; i++) {
      const it = streaks[i];
      if (!it.on) continue;
      it.t += dt;
      if (it.t >= it.dur) {
        it.on = false;
        it.mesh.visible = false;
        continue;
      }
      const k = it.t / it.dur;
      it.u.uK.value = k;
      if (!it.fired && k >= it.u.uD.value) {
        // 延迟的斩线落下：沿线炸开一串火花 + 一记闪光
        it.fired = true;
        _c.set(it.hex);
        const sn = Math.sin(it.ang), cs = Math.cos(it.ang);
        for (let j = 0; j < 16; j++) {
          const f = rand(-0.45, 0.45) * it.len, side = Math.random() < 0.5 ? -1 : 1, v = rand(3, 8);
          spawnP(it.x + sn * f, it.y, it.z + cs * f, cs * side * v + sn * rand(-2, 2), rand(0.5, 4), -sn * side * v + cs * rand(-2, 2), rand(0.18, 0.4), rand(0.12, 0.22), _c.r + (1 - _c.r) * 0.5, _c.g + (1 - _c.g) * 0.5, _c.b + (1 - _c.b) * 0.5, 9, 2.5);
        }
        flare(it.x, it.y, it.z, it.hex, 1.6, 0.12);
        flashLight(it.x, it.y + 1, it.z, it.hex, 1.4);
      }
    }
  }

  // ----- 烟：第二套点精灵，普通混合（暗色的烟雾不能用加色） -----
  const SN = 480;
  const sPos = new Float32Array(SN * 3), sCol = new Float32Array(SN * 4), sSize = new Float32Array(SN);
  const sVel = new Float32Array(SN * 3), sLife = new Float32Array(SN), sMax = new Float32Array(SN), sSz = new Float32Array(SN), sA = new Float32Array(SN);
  let sNext = 0, sGeo = null, sMat = null, sPts = null;
  function initSmoke() {
    for (let i = 0; i < SN; i++) sPos[i * 3 + 1] = -999;
    sGeo = new T.BufferGeometry();
    sGeo.setAttribute('position', new T.BufferAttribute(sPos, 3).setUsage(T.DynamicDrawUsage));
    sGeo.setAttribute('aColor', new T.BufferAttribute(sCol, 4).setUsage(T.DynamicDrawUsage));
    sGeo.setAttribute('aSize', new T.BufferAttribute(sSize, 1).setUsage(T.DynamicDrawUsage));
    sMat = new T.ShaderMaterial({
      uniforms: { uScale: pMat.uniforms.uScale },
      vertexShader:
        'attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;\n' +
        'void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
        ' gl_PointSize = aSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }',
      fragmentShader:
        'varying vec4 vC;\n' +
        'void main(){ vec2 q = gl_PointCoord - 0.5; float d = length(q);\n' +
        ' float n = 0.82 + 0.18 * sin(q.x * 23.0 + vC.a * 40.0) * sin(q.y * 19.0 - vC.a * 30.0);\n' +
        ' float a = smoothstep(0.5, 0.12, d * (1.0 + (1.0 - n))) * vC.a;\n' +
        ' if (a < 0.01) discard; gl_FragColor = vec4(vC.rgb, a); }',
      transparent: true, depthWrite: false,
    });
    sPts = new T.Points(sGeo, sMat);
    sPts.frustumCulled = false;
    sPts.renderOrder = 4;
    scene.add(sPts);
  }
  function spawnS(x, y, z, vx, vy, vz, life, size, r, g, b, a) {
    const i = sNext, j = i * 3;
    sNext = (sNext + 1) % SN;
    sPos[j] = x; sPos[j + 1] = y; sPos[j + 2] = z;
    sVel[j] = vx; sVel[j + 1] = vy; sVel[j + 2] = vz;
    sCol[i * 4] = r; sCol[i * 4 + 1] = g; sCol[i * 4 + 2] = b;
    sLife[i] = sMax[i] = life;
    sSz[i] = size;
    sA[i] = a;
  }
  let smokeLive = 0;
  function updateSmoke(dt) {
    if (smokeLive <= 0) return;
    smokeLive -= dt;
    for (let i = 0, j = 0; i < SN; i++, j += 3) {
      let l = sLife[i];
      if (l <= 0) continue;
      l -= dt;
      if (l <= 0) {
        sLife[i] = 0;
        sSize[i] = 0;
        sPos[j + 1] = -999;
        sCol[i * 4 + 3] = 0;
        continue;
      }
      sLife[i] = l;
      const dr = Math.max(0, 1 - 2.2 * dt);
      sVel[j] *= dr; sVel[j + 1] *= dr; sVel[j + 2] *= dr;
      sPos[j] += sVel[j] * dt; sPos[j + 1] += sVel[j + 1] * dt; sPos[j + 2] += sVel[j + 2] * dt;
      const f = l / sMax[i];
      sCol[i * 4 + 3] = sA[i] * Math.min(1, (1 - f) * 8) * f;
      sSize[i] = sSz[i] * (1.5 - 0.8 * f);
    }
    sGeo.attributes.position.needsUpdate = true;
    sGeo.attributes.aColor.needsUpdate = true;
    sGeo.attributes.aSize.needsUpdate = true;
  }
  // 一团烟：r 半径，n 团数，hex 烟的色调（会被压暗）
  W.smoke = function (x, y, z, r, n, hex) {
    _c.set(hex === undefined ? 0x2a2233 : hex);
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), d = r * Math.sqrt(Math.random()), v = rand(0.6, 2.2);
      spawnS(x + Math.sin(a) * d, y + rand(-0.3, 0.6), z + Math.cos(a) * d, Math.sin(a) * v, rand(0.3, 1.4), Math.cos(a) * v, rand(0.5, 0.95), rand(0.8, 1.4) * (0.7 + r * 0.6), _c.r, _c.g, _c.b, rand(0.8, 1));
    }
    smokeLive = 1.2;
  };

  // ----- 残影：玩家此刻姿势的半透明轮廓，原地淡出 -----
  const GHOST_VERT = [
    'varying vec3 vN; varying vec3 vV;',
    'void main(){',
    // 和角色本体同一套蒙皮（C 模型是 4 权重 SKIN4，程序化骨架是单骨骼 aBone）
    'BONE_CODE',
    ' vec4 mv = modelViewMatrix * ( boneM * vec4( position, 1.0 ) );',
    ' vN = normalize( normalMatrix * ( mat3( boneM ) * normal ) ); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
  ].join('\n');
  const GHOST_FRAG = 'uniform vec3 uColor; uniform float uA; varying vec3 vN; varying vec3 vV;\nvoid main(){ float r = 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) ); float a = ( 0.18 + 0.82 * r * r ) * uA; gl_FragColor = vec4( uColor * ( 0.6 + 0.8 * r ), a ); }';
  const ghosts = [];
  function initGhosts() {
    const rig = playerRig();
    for (let i = 0; i < 6; i++) {
      const u = { uBones: { value: new Float32Array(rig.NB * 16) }, uColor: { value: new T.Color() }, uA: { value: 0 } };
      const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: RIG_SKIN_PARS + GHOST_VERT.replace('BONE_CODE', RIG_BONE), fragmentShader: GHOST_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
      mat.defines = { NB: rig.NB };
      if (rig.skin4) mat.defines.SKIN4 = 1;
      const mesh = new T.Mesh(rig.geoBody, mat);
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      ghosts.push({ mesh, u, on: false, t: 0, dur: 0.3, a0: 1, wait: 0 });
    }
  }
  // 在 (x,z) 留一个 ent（玩家）当前姿势的残影；a 初始亮度，dur 淡出秒数，wait 延迟多久才出现
  W.afterimage = function (ent, x, z, hex, a, dur, wait) {
    if (!ent || ent.removed || ent.rig !== playerRig()) return;
    let g = null;
    for (let i = 0; i < ghosts.length; i++) if (!ghosts[i].on) { g = ghosts[i]; break; }
    if (!g) {
      g = ghosts[0];
      for (let i = 1; i < ghosts.length; i++) if (ghosts[i].t / ghosts[i].dur > g.t / g.dur) g = ghosts[i];
    }
    g.on = true;
    g.t = 0;
    g.dur = dur || 0.3;
    g.a0 = a === undefined ? 0.9 : a;
    g.wait = wait || 0;
    g.u.uBones.value.set(ent.bones);
    g.u.uColor.value.set(hex === undefined ? 0xbfd8ff : hex);
    g.u.uA.value = g.wait > 0 ? 0 : g.a0;
    g.mesh.position.set(x, ent.group.position.y, z);
    g.mesh.rotation.set(0, ent.group.rotation.y, 0);
    g.mesh.scale.setScalar(ent.group.scale.x * ent.k);
    g.mesh.visible = g.wait <= 0;
  };
  function updateGhosts(dt) {
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      if (!g.on) continue;
      if (g.wait > 0) {
        g.wait -= dt;
        if (g.wait > 0) continue;
        g.mesh.visible = true;
      }
      g.t += dt;
      const k = g.t / g.dur;
      if (k >= 1) {
        g.on = false;
        g.mesh.visible = false;
      } else g.u.uA.value = g.a0 * (1 - k) * (1 - k * 0.5);
    }
  }

  // ----- 震地的冲击波：从脚下沿 ang 推出去、越推越宽的一道波前 -----
  const WAVE_FRAG = [
    'uniform vec3 uColor; uniform float uK; uniform float uW0; uniform float uW1; varying vec2 vP;',
    'void main(){',
    '  float s = vP.y * 0.5 + 0.5;',
    '  float hw = mix(uW0, uW1, s) / uW1;',
    '  float ax = abs(vP.x) / max(hw, 0.001);',
    '  if (ax > 1.0) discard;',
    '  float front = min(uK / 0.72, 1.0);',
    '  float d = front - s - ax * ax * 0.05;', // 波前略微前凸
    '  if (d < 0.0) discard;',
    '  float band = exp(-d * d * 260.0);',
    '  float wake = exp(-d * 6.0) * 0.32;',
    '  float edge = 1.0 - smoothstep(0.7, 1.0, ax);',
    '  float fade = 1.0 - smoothstep(0.66, 1.0, uK);',
    '  float a = (band + wake) * edge * fade * smoothstep(0.0, 0.05, s);',
    '  gl_FragColor = vec4(mix(uColor, vec3(1.0), band * 0.55), a);',
    '}',
  ].join('\n');
  const waves = [];
  W.shockwave = function (x, z, ang, len, w0, w1, hex, dur) {
    let it = null;
    for (let i = 0; i < waves.length; i++) if (!waves[i].on) { it = waves[i]; break; }
    if (!it && waves.length >= 4) it = waves[0];
    if (!it) {
      const u = { uColor: { value: new T.Color() }, uK: { value: 0 }, uW0: { value: 1 }, uW1: { value: 1 } };
      const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: FX_VERT, fragmentShader: WAVE_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
      const mesh = new T.Mesh(gQuad(), mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
      it = { mesh, u, on: false, t: 0, dur: 1, x: 0, z: 0, ang: 0, len: 1, w0: 1, w1: 1, hex: 0, done: 0, crack: 0 };
      waves.push(it);
    }
    dur = dur || 0.55;
    it.on = true;
    it.t = 0;
    it.dur = dur;
    it.x = x; it.z = z; it.ang = ang; it.len = len; it.w0 = w0; it.w1 = w1; it.hex = hexOf(hex);
    it.done = 0;
    it.crack = 0.6;
    it.u.uColor.value.set(it.hex);
    it.u.uK.value = 0;
    it.u.uW0.value = w0;
    it.u.uW1.value = w1;
    const sn = Math.sin(ang), cs = Math.cos(ang);
    it.mesh.position.set(x + sn * len * 0.5, 0.11, z + cs * len * 0.5);
    it.mesh.rotation.y = ang;
    it.mesh.scale.set(w1 * 0.5, 1, len * 0.5);
    it.mesh.visible = true;
    // 落锤点：一圈冲击环、一块砸裂的地面、一团尘土和碎石
    W.ring(x, z, w0 * 1.6 + 0.8, hex, 0.35);
    W.decal(5, x, z, w0 + 0.9, rand(0, TAU), hex, 3.5);
    W.smoke(x, 0.4, z, 0.9, 10, 0x5a4a3e);
    _c.set(hex);
    for (let i = 0; i < 18; i++) {
      const a = rand(0, TAU), v = rand(2, 7);
      spawnP(x + Math.sin(a) * 0.4, 0.2, z + Math.cos(a) * 0.4, Math.sin(a) * v, rand(3, 8), Math.cos(a) * v, rand(0.5, 0.9), rand(0.18, 0.32), 0.42, 0.36, 0.3, 22, 0.6);
    }
    flare(x, 0.6, z, hex, 2.2, 0.14);
    flashLight(x, 1.5, z, hex, 2.4);
    W.shake(0.45);
  };
  function updateWaves(dt) {
    for (let i = 0; i < waves.length; i++) {
      const it = waves[i];
      if (!it.on) continue;
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) {
        it.on = false;
        it.mesh.visible = false;
        continue;
      }
      it.u.uK.value = k;
      // 波前走过的地方：翻起碎石和元素色的火花，隔一段裂开一道地缝
      const f = Math.min(1, k / 0.72) * it.len, sn = Math.sin(it.ang), cs = Math.cos(it.ang);
      _c.set(it.hex);
      while (it.done < f) {
        it.done += 0.32;
        const s = it.done, hw = (it.w0 + (it.w1 - it.w0) * (s / it.len)) * 0.5;
        const px = it.x + sn * s, pz = it.z + cs * s;
        for (let j = 0; j < 2; j++) {
          const o = rand(-hw, hw) * 0.9;
          spawnP(px + cs * o, 0.15, pz - sn * o, sn * rand(1, 3), rand(3, 7), cs * rand(1, 3), rand(0.35, 0.7), rand(0.16, 0.28), 0.4, 0.34, 0.28, 20, 0.8);
          spawnP(px + cs * o, 0.3, pz - sn * o, sn * rand(2, 5), rand(1, 3), cs * rand(2, 5), rand(0.2, 0.4), rand(0.12, 0.2), _c.r + (1 - _c.r) * 0.4, _c.g + (1 - _c.g) * 0.4, _c.b + (1 - _c.b) * 0.4, 6, 2);
        }
        if (s >= it.crack) {
          it.crack += 1.5;
          W.decal(5, px, pz, 0.55 + hw * 0.6, it.ang + rand(-0.4, 0.4), it.hex, 2.6);
        }
      }
    }
  }

  // ----- 箭雨：一个 InstancedMesh 画所有的箭（下落时拉长成发光的箭影，落地后插在地上一会儿） -----
  const AR_MAX = 90;
  const arX = new Float32Array(AR_MAX), arZ = new Float32Array(AR_MAX), arY = new Float32Array(AR_MAX), arT = new Float32Array(AR_MAX), arS = new Uint8Array(AR_MAX);
  const arDX = new Float32Array(AR_MAX), arDZ = new Float32Array(AR_MAX), arC = new Uint32Array(AR_MAX);
  let arMesh = null, arNext = 0, arLive = 0;
  const AR_FALL = 0.2, AR_STUCK = 0.75, AR_RISE = 0.3, AR_H = 8;
  const rains = [];
  const ZONE_FRAG = [
    'uniform vec3 uColor; uniform float uK; uniform float uA; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP); if (l > 1.0) discard;',
    '  float an = atan(vP.x, vP.y);',
    '  float edge = 1.0 - smoothstep(0.0, 0.03, abs(l - 0.96));',
    '  float ticks = pow(abs(sin(an * 10.0 - uK * 6.0)), 30.0) * smoothstep(0.84, 0.92, l) * (1.0 - smoothstep(0.95, 1.0, l));',
    '  float fill = smoothstep(0.2, 1.0, l) * 0.08;',
    '  float a = (edge * 0.75 + ticks * 0.5 + fill) * uA;',
    '  gl_FragColor = vec4(mix(uColor, vec3(1.0), edge * 0.3), a);',
    '}',
  ].join('\n');
  function initArrows() {
    const parts = [
      [gCyl(0.018, 0.018, 0.95, 4), 0xc8a878, 0, 0.5, 0],
      [gCone(0.05, 0.16, 4), 0xffffff, 0, 0.0, 0, Math.PI],
      [gBox(0.11, 0.16, 0.012), 0xf0e8d8, 0, 0.9, 0],
      [gBox(0.012, 0.16, 0.11), 0xf0e8d8, 0, 0.9, 0],
    ];
    const g = bake('fx/arrow', parts);
    const mat = new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
    arMesh = new T.InstancedMesh(g, mat, AR_MAX);
    arMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    _c.setRGB(1, 1, 1);
    for (let i = 0; i < AR_MAX; i++) {
      arMesh.setColorAt(i, _c);
      _m4.makeScale(0, 0, 0);
      arMesh.setMatrixAt(i, _m4);
    }
    arMesh.instanceColor.setUsage(T.DynamicDrawUsage);
    arMesh.frustumCulled = false;
    arMesh.renderOrder = 4;
    arMesh.visible = false;
    scene.add(arMesh);
  }
  // 放一支箭：state 1 = 从天上落到 (x,z)；3 = 从 (x,y,z) 往天上射走
  function arrowSpawn(x, y, z, dx, dz, state, hex) {
    const i = arNext;
    arNext = (arNext + 1) % AR_MAX;
    arX[i] = x; arY[i] = y; arZ[i] = z; arDX[i] = dx; arDZ[i] = dz;
    arT[i] = 0;
    arS[i] = state;
    arC[i] = hex;
    arLive = 1.5;
  }
  // 箭雨：在 (x,z) 半径 r 的范围里下 dur 秒的箭（delay 秒后开始落，默认 0.25）；fromX/fromZ 给出时先从那里朝天射出一把箭
  W.arrowRain = function (x, z, r, dur, hex, fromX, fromZ, delay) {
    let it = null;
    for (let i = 0; i < rains.length; i++) if (!rains[i].on) { it = rains[i]; break; }
    if (!it && rains.length >= 4) it = rains[0];
    if (!it) {
      const u = { uColor: { value: new T.Color() }, uK: { value: 0 }, uA: { value: 0 } };
      const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: FX_VERT, fragmentShader: ZONE_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
      const mesh = new T.Mesh(gQuad(), mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      scene.add(mesh);
      it = { mesh, u, on: false, t: 0, dur: 1, x: 0, z: 0, r: 1, acc: 0, hex: 0, dx: 0, dz: 1, delay: 0 };
      rains.push(it);
    }
    it.on = true;
    it.t = 0;
    it.delay = delay === undefined ? 0.25 : delay;
    it.dur = dur;
    it.x = x; it.z = z; it.r = r; it.acc = 0;
    it.hex = hexOf(hex);
    // 箭从射手那一侧斜着落下来
    let dx = 0, dz = 1;
    if (fromX !== undefined) {
      dx = x - fromX;
      dz = z - fromZ;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      _c.set(it.hex);
      for (let i = 0; i < 7; i++) arrowSpawn(fromX + rand(-0.3, 0.3), 1.8 + rand(0, 0.4), fromZ + rand(-0.3, 0.3), dx, dz, 3, it.hex);
      flare(fromX, 2, fromZ, it.hex, 1.2, 0.1);
    }
    it.dx = dx;
    it.dz = dz;
    it.u.uColor.value.set(it.hex);
    it.u.uA.value = 0;
    it.mesh.position.set(x, 0.09, z);
    it.mesh.scale.set(r, 1, r);
    it.mesh.visible = true;
  };
  function updateArrows(dt) {
    // 发射器：按时间撒箭
    for (let i = 0; i < rains.length; i++) {
      const it = rains[i];
      if (!it.on) continue;
      it.t += dt;
      const live = it.t - it.delay;
      it.u.uK.value = it.t;
      it.u.uA.value = Math.min(1, it.t / 0.2) * (live > it.dur ? Math.max(0, 1 - (live - it.dur) / 0.35) : 1);
      if (live > it.dur + 0.35) {
        it.on = false;
        it.mesh.visible = false;
        continue;
      }
      if (live < 0 || live > it.dur) continue;
      it.acc += dt * (26 + it.r * 6);
      while (it.acc > 1) {
        it.acc -= 1;
        const a = rand(0, TAU), d = it.r * Math.sqrt(Math.random()) * 0.95;
        arrowSpawn(it.x + Math.sin(a) * d, 0, it.z + Math.cos(a) * d, it.dx + rand(-0.15, 0.15), it.dz + rand(-0.15, 0.15), 1, it.hex);
      }
    }
    if (arLive <= 0) {
      if (arMesh.visible) arMesh.visible = false;
      return;
    }
    arLive -= dt;
    arMesh.visible = true;
    for (let i = 0; i < AR_MAX; i++) {
      const st = arS[i];
      if (!st) continue;
      arT[i] += dt;
      const t = arT[i];
      let px, py, pz, sy = 1, tilt = 0.35, bright = 1;
      if (st === 1) {
        const k = t / AR_FALL;
        if (k >= 1) {
          // 落地：插进土里，扬一点尘，闪一下
          arS[i] = 2;
          arT[i] = 0;
          _c.set(arC[i]);
          for (let j = 0; j < 3; j++) spawnP(arX[i], 0.12, arZ[i], rand(-1.5, 1.5), rand(0.8, 2.4), rand(-1.5, 1.5), rand(0.25, 0.45), rand(0.16, 0.26), 0.38, 0.33, 0.27, 6, 2);
          spawnP(arX[i], 0.25, arZ[i], 0, 1, 0, 0.12, 0.35, _c.r, _c.g, _c.b, 0, 0);
          arLive = Math.max(arLive, AR_STUCK);
          px = arX[i]; py = -0.12; pz = arZ[i];
        } else {
          const h = AR_H * (1 - k);
          px = arX[i] - arDX[i] * h * 0.4; py = h; pz = arZ[i] - arDZ[i] * h * 0.4;
          sy = 2.4;
          bright = 2.2;
        }
      } else if (st === 2) {
        const k = t / AR_STUCK;
        if (k >= 1) {
          arS[i] = 0;
          _m4.makeScale(0, 0, 0);
          arMesh.setMatrixAt(i, _m4);
          continue;
        }
        px = arX[i]; py = -0.12 - k * k * 0.5; pz = arZ[i];
        bright = 0.55 * (1 - k) + 0.15;
      } else {
        const k = t / AR_RISE;
        if (k >= 1) {
          arS[i] = 0;
          _m4.makeScale(0, 0, 0);
          arMesh.setMatrixAt(i, _m4);
          continue;
        }
        px = arX[i] + arDX[i] * k * 3; py = arY[i] + k * 14; pz = arZ[i] + arDZ[i] * k * 3;
        sy = -2.4; // 箭尖朝上
        tilt = 0.25;
        bright = 2;
      }
      // 箭沿 y 轴：箭尖在原点、箭杆朝 +y；朝来向倾斜
      _v.set(-arDZ[i], 0, arDX[i]);
      _q.setFromAxisAngle(_v.normalize(), -tilt * (sy < 0 ? -1 : 1));
      _m4.compose(_v2.set(px, py, pz), _q, _s.set(1, Math.abs(sy), 1));
      if (sy < 0) _m4.multiply(_mFlip);
      arMesh.setMatrixAt(i, _m4);
      _c.set(arC[i]).lerp(_c2.setRGB(1, 1, 1), 0.35).multiplyScalar(bright);
      arMesh.setColorAt(i, _c);
    }
    arMesh.instanceMatrix.needsUpdate = true;
    arMesh.instanceColor.needsUpdate = true;
  }
  const _mFlip = new T.Matrix4().makeRotationX(Math.PI);

  // ----- 秘弹：短杖的追踪小弹（由调用方移动）：拉长的晶尖 + 两粒绕转的光点，拖一条元素色的细带（实例化外形 'dart'） -----
  // opts（可选）：{ dx, dz } 出生时的飞行方向
  W.makeSeeker = function (hex, opts) {
    return W.makeProjectile(hex, 0.07, false, { kind: 'dart', dx: opts && opts.dx, dz: opts && opts.dz, tint: opts && opts.tint });
  };
  // 秘弹出膛 / 命中的一小下闪光
  W.seekerFx = function (x, y, z, hex) {
    _c.set(hex);
    for (let i = 0; i < 6; i++) {
      const a = rand(0, TAU), v = rand(2, 5);
      spawnP(x, y, z, Math.sin(a) * v, rand(-1, 3), Math.cos(a) * v, rand(0.12, 0.25), 0.14, _c.r + (1 - _c.r) * 0.4, _c.g + (1 - _c.g) * 0.4, _c.b + (1 - _c.b) * 0.4, 4, 3);
    }
    flare(x, y, z, hex, 0.8, 0.07);
  };

  // ----- 各武器技的组合特效 -----
  // 刃「回锋斩」的直刺：从 (x,z) 朝 ang 刺出 len 远的一道枪芒
  W.thrustFx = function (x, z, ang, len, hex) {
    streak(x, z, 1.05, ang, len, 0.55, hex, 0.3, 0, 0);
    const sn = Math.sin(ang), cs = Math.cos(ang);
    _c.set(hex);
    for (let i = 0; i < 12; i++) {
      const f = rand(0.3, 1) * len;
      spawnP(x + sn * f, 1.05 + rand(-0.15, 0.15), z + cs * f, sn * rand(4, 10), rand(-0.5, 1.5), cs * rand(4, 10), rand(0.12, 0.26), rand(0.1, 0.18), _c.r + (1 - _c.r) * 0.5, _c.g + (1 - _c.g) * 0.5, _c.b + (1 - _c.b) * 0.5, 2, 3);
    }
    flare(x + sn * len, 1.05, z + cs * len, hex, 1.1, 0.09);
  };
  // 刃「回锋斩」的回身横扫：绕 (x,z) 一整圈的月牙 + 外沿的冲击环 + 卷起的尘
  W.sweepFx = function (x, z, r, hex) {
    W.slash(x, z, rand(0, TAU), r, 360, hex, { dur: 0.3, inner: 0.55, y: 0.9 });
    W.ring(x, z, r * 1.05, hex, 0.3);
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), d = r * rand(0.6, 1);
      spawnP(x + Math.sin(a) * d, 0.25, z + Math.cos(a) * d, Math.cos(a) * 3, rand(0.5, 1.5), -Math.sin(a) * 3, rand(0.3, 0.55), rand(0.25, 0.4), 0.36, 0.32, 0.27, 1, 2.5);
    }
  };
  // 长杖「地脉涌」：脚下炸开一圈，地面裂出几道发光的地脉，沿圈喷起元素色的光柱。type：phys / fire / cold / light（决定地上的痕迹）
  const BURST_DECAL = { fire: 1, cold: 2, light: 3, phys: 5 };
  W.groundBurst = function (x, z, r, hex, type) {
    W.ring(x, z, r, hex, 0.45);
    W.ring(x, z, r * 0.55, mixHex(hex, 0xffffff, 0.5), 0.3);
    W.decal(BURST_DECAL[type] === undefined ? 5 : BURST_DECAL[type], x, z, r * 0.8, rand(0, TAU), hex, 3.5);
    const a0 = rand(0, TAU);
    for (let i = 0; i < 6; i++) streak(x, z, 0.14, a0 + (i / 6) * TAU + rand(-0.2, 0.2), r * rand(0.75, 0.95), 0.22, hex, 0.42, 0, 0);
    _c.set(hex);
    for (let i = 0; i < 26; i++) {
      const a = rand(0, TAU), d = r * rand(0.3, 0.95), wh = i % 3 === 0 ? 0.6 : 0.1;
      spawnP(x + Math.sin(a) * d, 0.2, z + Math.cos(a) * d, Math.sin(a) * rand(0.2, 1.5), rand(5, 10), Math.cos(a) * rand(0.2, 1.5), rand(0.35, 0.7), rand(0.18, 0.32), _c.r + (1 - _c.r) * wh, _c.g + (1 - _c.g) * wh, _c.b + (1 - _c.b) * wh, 9, 1.2);
    }
    W.burst(x, 0.6, z, hex, 22, 6, 0.5);
    flare(x, 0.8, z, hex, 2.2, 0.14);
    W.shake(0.3);
  };
  // 双匕「影刺」：起点和落点各一团烟，中间一串往回飘的暗影，落点一记闪光
  W.shadowStep = function (x0, z0, x1, z1, hex) {
    W.smoke(x0, 0.7, z0, 0.6, 14, 0x5a4870);
    W.smoke(x1, 0.7, z1, 0.5, 10, 0x5a4870);
    const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz) || 1, n = Math.max(3, Math.ceil(d * 2.5));
    _c.set(hex);
    for (let i = 0; i < n; i++) {
      const k = i / n;
      spawnP(x0 + dx * k + rand(-0.2, 0.2), rand(0.4, 1.6), z0 + dz * k + rand(-0.2, 0.2), (-dx / d) * rand(0.3, 1.2), rand(0, 0.6), (-dz / d) * rand(0.3, 1.2), rand(0.25, 0.5), rand(0.18, 0.3), _c.r * 0.7, _c.g * 0.7, _c.b * 0.7, -0.3, 2);
    }
    flare(x1, 1.1, z1, hex, 1.0, 0.08);
  };
  // 太刀「瞬断」的冲刺：沿路径留下几道残影（用 ent 此刻的姿势）、一道光带和地上的擦痕
  W.dashCut = function (ent, x0, z0, x1, z1, hex) {
    const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz);
    const ang = Math.atan2(dx, dz);
    if (ent) for (let i = 0; i < 4; i++) {
      const f = 0.15 + i * 0.22;
      W.afterimage(ent, x0 + dx * f, z0 + dz * f, hex, 0.35 + i * 0.15, 0.22 + i * 0.05, 0);
    }
    if (d > 0.2) {
      streak(x0, z0, 1.0, ang, d, 0.42, hex, 0.3, 0, 0);
      W.decal(0, x0 + dx * 0.5, z0 + dz * 0.5, d * 0.5, ang, hex, 0.5, 0.2);
    }
    _c.set(hex);
    const n = Math.max(3, Math.ceil(d * 3));
    for (let i = 0; i < n; i++) {
      const k = i / n;
      spawnP(x0 + dx * k + rand(-0.15, 0.15), rand(0.3, 1.6), z0 + dz * k + rand(-0.15, 0.15), (dx / (d || 1)) * rand(1, 3), rand(-0.2, 0.6), (dz / (d || 1)) * rand(1, 3), rand(0.2, 0.4), rand(0.12, 0.22), _c.r + (1 - _c.r) * 0.5, _c.g + (1 - _c.g) * 0.5, _c.b + (1 - _c.b) * 0.5, 0, 2.5);
    }
  };
  // 一道延迟落下的斩线：立刻在 (x,z) 横着出现一道细暗线，delay 秒后骤亮、炸开火花再消失
  W.cutLine = function (x, z, ang, len, hex, delay) {
    const dl = delay === undefined ? 0.35 : Math.max(0, delay);
    const sn = Math.sin(ang), cs = Math.cos(ang);
    streak(x - sn * len * 0.5, z - cs * len * 0.5, 1.0, ang, len, 0.5, hex, dl + 0.24, 1, dl);
  };
  // ----- 魂幡「魂潮」 -----
  // 魂灵出幡：W.soulTide(x, z, ang, hex[, ent])。杆头（ent 缺省是玩家；拿着武器时取它的 weapon 挂点，否则在 (x, 2.3, z)）
  // 炸开一团魂火、魂雾往外卷（偏向 ang 方向），脚下一圈魂环，一圈魂火从地上升起
  W.soulTide = function (x, z, ang, hex, ent) {
    const h = hexOf(hex === undefined || hex === null ? ALLY_HEX : hex);
    if (ent === undefined) ent = G.player && G.player.ent;
    const fa = ang || 0, fx = Math.sin(fa), fz = Math.cos(fa);
    let bx = x, by = 2.3, bz = z;
    if (ent && !ent.removed && ent.sock && ent.sock.weapon && ent.gearType >= 0) {
      W.entSocket(ent, 'weapon', _sk);
      bx = _sk.x; by = _sk.y; bz = _sk.z;
    }
    W.ring(x, z, 2.4, h, 0.5);
    W.ring(x, z, 1.2, mixHex(h, 0xffffff, 0.55), 0.32);
    flare(bx, by, bz, h, 2.0, 0.16);
    flashLight(bx, by, bz, h, 1.8);
    W.smoke(bx, by, bz, 0.35, 6, mixHex(h, 0x141820, 0.6));
    _c.set(h);
    for (let i = 0; i < 30; i++) {
      // 杆头：一圈往外旋出去的魂火，带一点上浮
      const a = rand(0, TAU), v = rand(1.5, 4.5), wh = i % 3 === 0 ? 0.65 : 0.15, f = rand(1, 4);
      spawnP(bx, by, bz, Math.sin(a) * v + Math.cos(a) * v * 0.5 + fx * f, rand(-0.5, 2), Math.cos(a) * v - Math.sin(a) * v * 0.5 + fz * f, rand(0.35, 0.7), rand(0.14, 0.26), _c.r + (1 - _c.r) * wh, _c.g + (1 - _c.g) * wh, _c.b + (1 - _c.b) * wh, -1.2, 2.2);
    }
    for (let i = 0; i < 18; i++) {
      // 魂环上升起的魂火
      const a = (i / 18) * TAU + rand(-0.1, 0.1);
      spawnP(x + Math.sin(a) * 2.2, 0.15, z + Math.cos(a) * 2.2, -Math.sin(a) * 0.6, rand(2.5, 4.5), -Math.cos(a) * 0.6, rand(0.4, 0.75), rand(0.16, 0.26), _c.r * 0.9, _c.g * 0.9, _c.b * 0.9, -0.4, 1.4);
    }
  };
  // 魂灵（由调用方移动，和 makeProjectile / makeSeeker 一样用 W.removeMesh 移除）：一颗亮的魂火头拖一条渐细的魂尾，朝着移动方向，
  // 一路飘下往上浮的魂火屑
  W.makeWisp = function (hex) {
    const h = hexOf(hex === undefined || hex === null ? ALLY_HEX : hex);
    const grp = new T.Group();
    const body = new T.Group();
    grp.add(body);
    const head = new T.Mesh(gSph(1, 8, 6), coreMat(mixHex(h, 0xffffff, 0.45)));
    head.scale.set(0.12, 0.12, 0.15);
    body.add(head);
    const tail = new T.Mesh(gCone(1, 1, 6), coreMat(h));
    tail.rotation.x = -HALF_PI; // 锥尖朝后（-z）
    tail.position.z = -0.24;
    tail.scale.set(0.085, 0.42, 0.085);
    body.add(tail);
    const glow = new T.Sprite(spriteMat(h));
    glow.scale.setScalar(1.15);
    body.add(glow);
    _c.set(h);
    const u = grp.userData;
    u.kind = 'proj';
    u.seek = true;
    u.wisp = body;
    u.r = _c.r; u.g = _c.g; u.b = _c.b;
    u.rad = 0.1;
    u.acc = 0;
    u.ph = rand(0, TAU);
    u.age = 0;
    u.lx = NaN; u.lz = NaN;
    u.rib = ribGet(0.2, 0.3, _c.r + (1 - _c.r) * 0.4, _c.g + (1 - _c.g) * 0.4, _c.b + (1 - _c.b) * 0.4, _c.r * 0.4, _c.g * 0.4, _c.b * 0.4); // 魂尾
    grp.position.y = -50;
    scene.add(grp);
    projObjs.push(grp);
    return grp;
  };
  // 魂灵撞上目标炸开：W.wispBurst(x, z, r, hex)，r 是炸开的半径。魂火往外炸成一圈、一点魂雾、地上一圈魂环、一记闪光
  W.wispBurst = function (x, z, r, hex) {
    const h = hexOf(hex === undefined || hex === null ? ALLY_HEX : hex), R = r || 1;
    const y = 1.1;
    _c.set(h);
    for (let i = 0; i < 16; i++) {
      const a = rand(0, TAU), v = rand(2, 4.5) * R, wh = i % 2 ? 0.55 : 0.1;
      spawnP(x, y, z, Math.sin(a) * v, rand(0, 3), Math.cos(a) * v, rand(0.22, 0.4), rand(0.14, 0.24), _c.r + (1 - _c.r) * wh, _c.g + (1 - _c.g) * wh, _c.b + (1 - _c.b) * wh, -0.8, 3);
    }
    W.smoke(x, y, z, 0.3 * R, 5, mixHex(h, 0x141820, 0.55));
    flare(x, y, z, h, 1.2 + 0.3 * R, 0.1);
    W.ring(x, z, R, h, 0.25);
  };
  // 魂潮的狂热：W.frenzyFx(ent, dur[, hex])，召唤物身上 dur 秒的魂火（轮廓光跟着脉动、身上不断冒出往上飘的魂火屑），结束时恢复原来的轮廓光
  const frenzies = [];
  W.frenzyFx = W.frenzy = function (ent, dur, hex) {
    if (!ent || ent.removed) return;
    const h = hexOf(hex === undefined || hex === null ? ALLY_HEX : hex);
    let it = null;
    for (let i = 0; i < frenzies.length; i++) if (frenzies[i].ent === ent) { it = frenzies[i]; break; }
    if (!it) {
      it = { ent, t: 0, dur: 1, acc: 0, rim: new T.Color().copy(ent.uRim.value), col: new T.Color() };
      frenzies.push(it);
    }
    it.t = 0;
    it.dur = dur === undefined ? 4 : dur;
    it.col.set(h).convertSRGBToLinear();
    W.entSocket(ent, 'chest', _sk);
    flare(_sk.x, _sk.y, _sk.z, h, 1.3, 0.12);
    _c.set(h);
    for (let i = 0; i < 10; i++) {
      const a = rand(0, TAU);
      spawnP(_sk.x + Math.sin(a) * 0.4, _sk.y - 0.4, _sk.z + Math.cos(a) * 0.4, Math.sin(a) * 1.2, rand(2, 4), Math.cos(a) * 1.2, rand(0.35, 0.6), rand(0.16, 0.24), _c.r, _c.g, _c.b, -0.8, 1.5);
    }
  };
  function updateFrenzy(dt) {
    for (let i = frenzies.length - 1; i >= 0; i--) {
      const it = frenzies[i], e = it.ent;
      it.t += dt;
      if (e.removed || e.dying || it.t >= it.dur) {
        if (!e.removed) e.uRim.value.copy(it.rim);
        frenzies.splice(i, 1);
        continue;
      }
      // 轮廓光：先亮一下，之后随心跳般的脉动，最后半秒淡回去
      const fade = Math.min(1, (it.dur - it.t) / 0.5), pulse = 0.55 + 0.45 * Math.sin(it.t * 9) * Math.sin(it.t * 9);
      const k = Math.min(1, it.t / 0.15) * fade * (0.6 + 0.9 * pulse);
      e.uRim.value.copy(it.rim).lerp(it.col, Math.min(1, k * 0.8)).multiplyScalar(1 + k * 1.6);
      it.acc += dt;
      if (it.acc > 0.07 && e.group.visible) {
        it.acc = 0;
        W.entSocket(e, 'chest', _sk);
        spawnP(_sk.x + rand(-0.35, 0.35), _sk.y + rand(-0.6, 0.3), _sk.z + rand(-0.35, 0.35), rand(-0.3, 0.3), rand(1.2, 2.6), rand(-0.3, 0.3), rand(0.35, 0.6), rand(0.12, 0.2), it.col.r * 1.4, it.col.g * 1.4, it.col.b * 1.4, -0.6, 1.2);
      }
    }
  }
  function clearFrenzy() {
    for (const it of frenzies) if (!it.ent.removed) it.ent.uRim.value.copy(it.rim);
    frenzies.length = 0;
  }

  // ----- 震飞：被震地掀起的敌人整个弹离地面一小段（只动整体高度，落地归零；setEnt 每帧把高度设回 0，这里在它之后再抬起来） -----
  const knocks = [];
  W.knockUp = function (ent, s) {
    if (!ent || ent.removed) return;
    if (!(ent.kuT < ent.kuDur)) knocks.push(ent);
    const k = s === undefined ? 1 : s;
    ent.kuT = 0;
    ent.kuDur = 0.36 + 0.14 * k;
    ent.kuH = 0.85 * k;
  };
  function updateKnocks(dt) {
    for (let i = knocks.length - 1; i >= 0; i--) {
      const e = knocks[i];
      e.kuT += dt;
      const k = e.kuT / e.kuDur;
      if (k >= 1 || e.removed) {
        e.kuT = e.kuDur;
        if (!e.removed) e.group.position.y = 0;
        knocks.splice(i, 1);
        continue;
      }
      e.group.position.y = e.kuH * 4 * k * (1 - k);
    }
  }
  function updateWeaponFx(dt) {
    updateKnocks(dt);
    updateStreaks(dt);
    updateSmoke(dt);
    updateGhosts(dt);
    updateWaves(dt);
    updateArrows(dt);
    updateFrenzy(dt);
    updateSpectral(dt);
    updateUfx(dt);
  }
  function clearWeaponFx() {
    clearFrenzy();
    clearUfx();
    clearPyreFx();
    for (const e of knocks) { e.kuT = e.kuDur; if (!e.removed) e.group.position.y = 0; }
    knocks.length = 0;
    for (const it of streaks) { it.on = false; it.mesh.visible = false; }
    for (const g of ghosts) { g.on = false; g.mesh.visible = false; }
    for (const it of waves) { it.on = false; it.mesh.visible = false; }
    for (const it of rains) { it.on = false; it.mesh.visible = false; }
    arS.fill(0);
    arLive = 0;
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < AR_MAX; i++) arMesh.setMatrixAt(i, _m4);
    arMesh.instanceMatrix.needsUpdate = true;
    arMesh.visible = false;
    for (let i = 0; i < SN; i++) {
      sLife[i] = 0;
      sSize[i] = 0;
      sPos[i * 3 + 1] = -999;
    }
    sGeo.attributes.position.needsUpdate = true;
    sGeo.attributes.aSize.needsUpdate = true;
    smokeLive = 0;
  }
  // 预热：每种特效各摆一个出来，让 warmEntities 那一帧把着色器编译掉
  let warmWisp = null;
  function warmWeaponFx(on) {
    if (warmWisp) {
      W.removeMesh(warmWisp);
      warmWisp = null;
    }
    if (on) {
      warmWisp = W.makeWisp(ALLY_HEX);
      warmWisp.position.set(0, 1, 2);
      streakGet().mesh.visible = true;
      ghosts[0].mesh.visible = true;
      W.shockwave(0, 2, 0, 4, 1, 3, 0xffffff, 0.5);
      W.arrowRain(0, 2, 2, 1, 0xffffff);
      arMesh.visible = true;
      spawnS(0, 1, 2, 0, 0, 0, 0.5, 1, 0.2, 0.2, 0.2, 0.5);
      smokeLive = 1;
      updateSmoke(0.01);
      warmProjFx(true);
    } else {
      clearWeaponFx();
      warmProjFx(false);
    }
  }

  // ---------- 光环：玩家脚下常驻的一圈淡淡的霜环 + 绕身飘的霜粒；每次脉冲有一道向外扩的细环 ----------
  const AURA_FRAG = [
    'uniform vec3 uColor; uniform float uA; uniform float uPulse; uniform float uTime; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP);',
    '  if (l > 1.0) discard;',
    '  float an = atan(vP.x, vP.y);',
    '  float edge = 1.0 - smoothstep(0.0, 0.014, abs(l - 0.955));',
    '  float ticks = pow(abs(sin(an * 12.0 + uTime * 0.5)), 40.0) * smoothstep(0.86, 0.94, l) * (1.0 - smoothstep(0.96, 1.0, l));',
    '  float fill = smoothstep(0.55, 1.0, l) * 0.02;',
    '  float rr = 0.55 + 0.43 * (1.0 - uPulse * uPulse);',
    '  float wave = (1.0 - smoothstep(0.0, 0.03, abs(l - rr))) * uPulse * 0.16;',
    // 亮的霜色细线两侧各垫一道深色描边（外侧那道更宽）：冰面这种浅色地面上也看得出圈在哪
    '  float halo = max(1.0 - smoothstep(0.0, 0.03, abs(l - 0.985)), (1.0 - smoothstep(0.0, 0.016, abs(l - 0.925))) * 0.7) * (1.0 - edge);',
    '  float aB = (edge * 0.7 + ticks * 0.3 + fill * 1.5 + wave * 1.6) * uA;',
    '  float aD = halo * 0.42 * uA;',
    '  float a = clamp(aB + aD, 0.0, 1.0);',
    '  if (a < 0.002) discard;',
    '  vec3 bright = mix(uColor, vec3(1.0), ticks * 0.35 + edge * 0.15);',
    '  gl_FragColor = vec4((bright * aB + vec3(0.02, 0.07, 0.13) * aD) / max(a, 0.001), a);',
    '}',
  ].join('\n');
  const aura = { mesh: null, u: null, r: 0, a: 0, pulse: 0, acc: 0 };
  W.setAura = function (r) {
    aura.r = r > 0 ? r : 0;
    if (aura.r > 0 && !aura.mesh && scene) {
      aura.u = { uColor: { value: new T.Color(0x86d8ff) }, uA: { value: 0 }, uPulse: { value: 0 }, uTime };
      const mat = new T.ShaderMaterial({ uniforms: aura.u, vertexShader: FX_VERT, fragmentShader: AURA_FRAG, transparent: true, depthWrite: false, side: T.DoubleSide });
      aura.mesh = new T.Mesh(gQuad(), mat);
      aura.mesh.renderOrder = 3;
      aura.mesh.visible = false;
      scene.add(aura.mesh);
    }
  };
  W.auraPulse = function (hit) {
    aura.pulse = hit ? 1 : 0.55;
  };
  W.auraInfo = () => ({ r: aura.r, a: aura.a, visible: !!(aura.mesh && aura.mesh.visible) });
  function updateAura(dt) {
    const P = G.player;
    const want = aura.r > 0 ? 1 : 0;
    aura.a += (want - aura.a) * Math.min(1, dt * 6);
    if (aura.a < 0.01 && !want) aura.a = 0;
    if (!aura.mesh) return;
    aura.mesh.visible = aura.a > 0;
    if (!aura.mesh.visible) return;
    if (aura.r > 0) aura.mesh.scale.set(aura.r, 1, aura.r);
    aura.mesh.position.set(P.x, 0.06, P.z);
    aura.pulse = Math.max(0, aura.pulse - dt * 2.6);
    aura.u.uA.value = aura.a;
    aura.u.uPulse.value = aura.pulse;
    // 绕身飘的霜粒：在圈里慢慢升起、打转
    if (want && P.ent && P.ent.group.visible) {
      aura.acc += dt * 9;
      _c.set(0xbfe8ff);
      while (aura.acc > 1) {
        aura.acc -= 1;
        const a = rand(0, TAU), d = aura.r * Math.sqrt(rand(0.15, 1));
        spawnP(P.x + Math.sin(a) * d, rand(0.1, 0.9), P.z + Math.cos(a) * d, Math.cos(a) * 0.5, rand(0.25, 0.7), -Math.sin(a) * 0.5, rand(1.0, 1.8), rand(0.07, 0.13), _c.r, _c.g, _c.b, -0.05, 0.4);
      }
    }
  }

  // ---------- 飘字 ----------
  const TEXT_DUR = 0.8;
  const texts = [];
  // style（可选）：{ kind: 'crit' 暴击 | 'big' 终结 / 处决的大数字 | 'tag' 状态词（破绽、处决……）, y 起始高度（默认 2.1）, py 额外的屏幕像素偏移 }
  // 池满时先顶掉谁：光环 / 电弧的淡数字最先，普通数字其次，暴击 / 终结 / 状态词（冻结、爆燃……）最后；
  // 淡数字自己另有上限，而且永远顶不掉比它重要的字
  const TEXT_MAX = 90, FAINT_MAX = 24;
  const textRank = (k) => (k === 'faint' ? 0 : k ? 2 : 1);
  W.text = function (x, z, str, cssColor, sizePx, style) {
    const kind = (style && style.kind) || '';
    const rank = textRank(kind);
    let o = null;
    let oldFaint = null, faintN = 0;
    for (let i = 0; i < texts.length; i++) {
      const q = texts[i];
      if (q.t >= q.dur) {
        if (!o) o = q;
      } else if (q.kind === 'faint') {
        faintN++;
        if (!oldFaint || q.t > oldFaint.t) oldFaint = q;
      }
    }
    if (rank === 0 && faintN >= FAINT_MAX) o = oldFaint;
    if (!o) {
      if (texts.length < TEXT_MAX) {
        o = { x: 0, z: 0, y: 2.1, str: '', color: '', size: 16, t: 0, dur: TEXT_DUR, ox: 0, oy: 0, vx: 0, kind: '', py: 0 };
        texts.push(o);
      } else {
        // 顶掉级别最低（同级里最老）的一条；没有不比自己重要的就不显示
        for (let i = 0; i < texts.length; i++) {
          const q = texts[i], r = textRank(q.kind);
          if (r > rank) continue;
          if (!o || r < textRank(o.kind) || (r === textRank(o.kind) && q.t > o.t)) o = q;
        }
        if (!o) return;
      }
    }
    o.x = x;
    o.z = z;
    o.str = String(str);
    o.color = cssColor || '#ffffff';
    o.size = sizePx || 16;
    o.t = 0;
    o.kind = kind;
    o.y = style && style.y !== undefined ? style.y : 2.1;
    o.py = (style && style.py) || 0; // 额外的屏幕像素偏移（「破绽」要让开头顶的处决提示）
    const arc = o.kind === 'crit' || o.kind === 'big';
    o.dur = o.kind === 'big' ? 1.25 : o.kind === 'crit' ? 1.0 : o.kind === 'tag' ? 1.15 : o.kind === 'faint' ? 0.55 : TEXT_DUR;
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
    for (const m of meteors) meteorOff(m);
    clearProjFx();
    for (const t of texts) t.t = t.dur;
    clearDying();
    for (const d of decals) { d.on = false; d.mesh.visible = false; }
    for (const f of flares) { f.on = false; f.sp.visible = false; }
    for (const s of summons) { s.on = false; s.grp.visible = false; }
    clearWeaponFx();
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
  // =====================================================================
  // 投射物外形 / 拖尾 / 命中（实例化绘制：每种零件一个 InstancedMesh，场上投射物再多 draw call 也是固定的）
  // 每颗投射物本身只是一个空 Group（池化）：game.js 照旧设它的位置、用 W.removeMesh 移除；
  // 每帧按它的种类（userData.vfx）把零件的矩阵 / 颜色写进各自的实例缓冲。
  // 种类：玩家 ember 掷焰 / blade 飞刃 / dart 秘弹 / orb 通用光球；
  //       敌方 glob 喷吐者的黏液弹 / shard 霜织者的冰棱 / spark 雷霆监察者的雷球 / firebolt 熔渣巨像与烬渊之主的火弹 / horb 通用敌弹。
  // 敌方弹丸一律带那圈翻滚的红环 + 压暗的内核，玩家的投射物一律是亮白的核，两者从不混淆。
  // =====================================================================
  const PF = Object.create(null); // 零件名 → { mesh, n, cap }
  const PF_LIST = [];
  const _pm = new T.Matrix4(), _pq = new T.Quaternion(), _pq2 = new T.Quaternion(), _pqI = new T.Quaternion();
  const _pv = new T.Vector3(), _ps = new T.Vector3(), _pc = new T.Color(), _pe = new T.Euler();
  const _bx = new T.Vector3(), _by = new T.Vector3(), _bz = new T.Vector3();
  const Z_AXIS = new T.Vector3(0, 0, 1);
  const camB = new T.Vector3(), camQ = new T.Quaternion(); // 镜头朝向固定（只平移）：后向 = 指向镜头
  const flameTex = () =>
    tex('flame', () => {
      // 火舌：上端圆润的亮头，往下拖成一条带流纹的细尾（白色，颜色由实例给）
      const Wd = 64, H = 128, c = makeCanvas(Wd, H), g = c.getContext('2d'), img = g.createImageData(Wd, H), d = img.data;
      for (let y = 0; y < H; y++) {
        const v = y / (H - 1);
        for (let x = 0; x < Wd; x++) {
          const u = (x / (Wd - 1)) * 2 - 1;
          let w;
          if (v < 0.2) w = Math.sqrt(Math.max(0, 1 - ((0.2 - v) / 0.2) ** 2)) * 0.78;
          else w = 0.78 * Math.pow(1 - (v - 0.2) / 0.8, 1.25);
          const wig = Math.sin(v * 19 + u * 3) * 0.06 * v;
          const e = w > 0.001 ? Math.abs(u + wig) / w : 9;
          let a = e >= 1 ? 0 : Math.pow(1 - e, 1.4);
          a *= Math.min(1, (1 - v) * 1.6) * (0.78 + 0.22 * Math.sin(u * 7 + v * 31) * Math.sin(v * 13));
          a = Math.max(0, Math.min(1, a * 1.25 + (v < 0.22 ? (1 - e) * 0.2 : 0)));
          const o = (y * Wd + x) * 4;
          d[o] = d[o + 1] = d[o + 2] = 255;
          d[o + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
      return new T.CanvasTexture(c);
    });
  const flameHardTex = () =>
    tex('flameHard', () => {
      // 实色火舌：轮廓清楚、边缘略带起伏的卡通火苗，中间亮、边上压暗一圈（乘上实例色就是亮橙芯 + 深红边）
      const Wd = 64, H = 128, c = makeCanvas(Wd, H), g = c.getContext('2d'), img = g.createImageData(Wd, H), d = img.data;
      for (let y = 0; y < H; y++) {
        const v = y / (H - 1);
        for (let x = 0; x < Wd; x++) {
          const u = (x / (Wd - 1)) * 2 - 1;
          let w;
          if (v < 0.18) w = Math.sqrt(Math.max(0, 1 - ((0.18 - v) / 0.18) ** 2)) * 0.82;
          else w = 0.82 * Math.pow(1 - (v - 0.18) / 0.82, 1.15) * (1 + 0.16 * Math.sin(v * 15));
          const wig = Math.sin(v * 11 + 0.6) * 0.18 * v;
          const e = w > 0.001 ? Math.abs(u + wig) / w : 9;
          const a = e >= 1 ? 0 : Math.min(1, (1 - e) / 0.14) * (1 - Math.max(0, (v - 0.9) / 0.1));
          const lum = 0.5 + 0.5 * Math.pow(Math.max(0, 1 - e), 0.8) * (1 - v * 0.4);
          const o = (y * Wd + x) * 4;
          d[o] = d[o + 1] = d[o + 2] = Math.round(lum * 255);
          d[o + 3] = Math.round(Math.max(0, a) * 255);
        }
      }
      g.putImageData(img, 0, 0);
      return new T.CanvasTexture(c);
    });
  const swooshTex = () =>
    tex('swoosh', () => {
      // 飞刃的残影环：三道弧，前沿亮、往后渐隐
      const S = 128, c = makeCanvas(S, S), g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const px = (x / (S - 1)) * 2 - 1, py = (y / (S - 1)) * 2 - 1, r = Math.hypot(px, py);
          const an = (Math.atan2(px, py) + TAU) % TAU;
          const loc = ((an * 3) / TAU) % 1;
          const band = Math.max(0, 1 - Math.abs(r - 0.8) / 0.17);
          const a = Math.pow(loc, 2.6) * band * band + Math.max(0, 1 - Math.abs(r - 0.93) / 0.04) * 0.25 * loc;
          const o = (y * S + x) * 4;
          d[o] = d[o + 1] = d[o + 2] = 255;
          d[o + 3] = r > 1 ? 0 : Math.round(Math.min(1, a) * 255);
        }
      }
      g.putImageData(img, 0, 0);
      return new T.CanvasTexture(c);
    });
  const crackleTex = () =>
    tex('crackle', () => {
      // 雷球表面的电弧：一条从中心往外折的锯齿亮线
      const Wd = 128, H = 32, c = makeCanvas(Wd, H), g = c.getContext('2d');
      g.strokeStyle = '#fff';
      g.lineCap = 'round';
      g.shadowColor = '#fff';
      g.shadowBlur = 5;
      const pts = [[4, 16], [22, 9], [36, 21], [52, 7], [66, 22], [82, 10], [98, 20], [112, 12], [124, 16]];
      for (const lw of [4, 1.6]) {
        g.lineWidth = lw;
        g.globalAlpha = lw > 2 ? 0.35 : 1;
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
        g.stroke();
      }
      g.globalAlpha = 0.8;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(52, 7); g.lineTo(60, 2); g.moveTo(82, 10); g.lineTo(90, 27);
      g.stroke();
      return new T.CanvasTexture(c);
    });
  const basaltTex = () =>
    tex('basalt', () => {
      const Wd = 128, H = 64, c = makeCanvas(Wd, H), g = c.getContext('2d'), img = g.createImageData(Wd, H), d = img.data;
      for (let y = 0; y < H; y++) for (let x = 0; x < Wd; x++) {
        const n = vnoise(x * 0.11, y * 0.11) * 0.6 + vnoise(x * 0.37 + 9, y * 0.37) * 0.4;
        const v = 30 + n * 46, o = (y * Wd + x) * 4;
        d[o] = v * 1.04; d[o + 1] = v * 0.95; d[o + 2] = v * 0.9; d[o + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return new T.CanvasTexture(c);
    });
  const crackTex = () =>
    tex('lavaCrack', () => {
      // 熔岩裂纹：黑底上若干条分叉的折线（发光贴图）
      const Wd = 256, H = 128, c = makeCanvas(Wd, H), g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, Wd, H);
      g.strokeStyle = '#fff';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.shadowColor = '#fff';
      let s = 7;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const crack = (x, y, ang, len, w, depth) => {
        g.lineWidth = w;
        g.shadowBlur = w * 3;
        g.beginPath();
        g.moveTo(x, y);
        for (let i = 0; i < len; i++) {
          ang += (rnd() - 0.5) * 1.1;
          x += Math.cos(ang) * 9;
          y += Math.sin(ang) * 9;
          g.lineTo(x, y);
          if (depth > 0 && rnd() < 0.18) {
            g.stroke();
            crack(x, y, ang + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd()), Math.ceil(len * 0.5), w * 0.6, depth - 1);
            g.lineWidth = w;
            g.shadowBlur = w * 3;
            g.beginPath();
            g.moveTo(x, y);
          }
        }
        g.stroke();
      };
      for (let i = 0; i < 9; i++) crack(rnd() * Wd, rnd() * H, rnd() * TAU, 9 + Math.floor(rnd() * 8), 2.6, 2);
      return new T.CanvasTexture(c);
    });
  // 不规则的岩块：二十面体按顶点位置的哈希往里外推，再压扁一点（同一位置的顶点推得一样，表面不裂开）
  function rockGeo(detail) {
    return geo('rock' + detail, () => {
      const g = new T.IcosahedronGeometry(1, detail);
      const a = g.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
        const h = hash2(Math.round(x * 997) + Math.round(y * 991) * 7, Math.round(z * 983) - Math.round(y * 977) * 3);
        const k = 0.78 + 0.34 * h;
        a.setXYZ(i, x * k * 1.05, y * k * 0.86, z * k);
      }
      g.computeVertexNormals();
      return g;
    });
  }
  // 给烘焙好的（非索引、带顶点色）几何体按面朝向做一遍假光照：不受光的材质也能看出棱面
  function facetShade(g, lx, ly, lz, amb) {
    const p = g.attributes.position, c = g.attributes.color;
    const l = Math.hypot(lx, ly, lz);
    lx /= l; ly /= l; lz /= l;
    for (let i = 0; i + 2 < p.count; i += 3) {
      _v.set(p.getX(i + 1) - p.getX(i), p.getY(i + 1) - p.getY(i), p.getZ(i + 1) - p.getZ(i));
      _v2.set(p.getX(i + 2) - p.getX(i), p.getY(i + 2) - p.getY(i), p.getZ(i + 2) - p.getZ(i));
      _v.cross(_v2).normalize();
      const k = amb + (1 - amb) * Math.abs(_v.x * lx + _v.y * ly + _v.z * lz);
      for (let j = 0; j < 3; j++) c.setXYZ(i + j, c.getX(i + j) * k, c.getY(i + j) * k, c.getZ(i + j) * k);
    }
    return g;
  }
  // 飞刃：中间一个铆钉轮毂，三片往后弯的刃。刃身是冷钢色，前沿一条亮白的刃口（顶点色，平躺在 XZ 面上，半径约 1）
  function bladeGeo() {
    return geo('flyBlade', () => {
      const P = [], C = [];
      const col = (r, g, b) => (_c.setRGB(r, g, b).convertSRGBToLinear(), [_c.r, _c.g, _c.b]);
      const tri = (a, b, c, ca, cb, cc) => {
        P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        C.push(...ca, ...cb, ...cc);
      };
      const cL = col(1, 1, 1), cE = col(0.8, 0.86, 0.96), cM = col(0.55, 0.6, 0.7), cB = col(0.2, 0.22, 0.28);
      const N = 10;
      for (let k = 0; k < 3; k++) {
        const base = (k / 3) * TAU;
        const L = [], E = [], B = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N, rho = 0.18 + 0.84 * t, th = base - 0.8 * Math.pow(t, 1.4);
          const w = 0.5 * Math.pow(1 - t, 0.8) * (0.55 + 0.45 * Math.min(1, t * 4));
          const cx = Math.sin(th) * rho, cz = Math.cos(th) * rho, nx = Math.cos(th), nz = -Math.sin(th);
          L.push([cx + nx * w * 0.58, 0, cz + nz * w * 0.58]);
          E.push([cx + nx * w * 0.3, 0, cz + nz * w * 0.3]);
          B.push([cx - nx * w * 0.42, 0, cz - nz * w * 0.42]);
        }
        for (let i = 0; i < N; i++) {
          tri(B[i], E[i], B[i + 1], cB, cM, cB);
          tri(E[i], E[i + 1], B[i + 1], cM, cM, cB);
          tri(E[i], L[i], E[i + 1], cE, cL, cE);
          tri(L[i], L[i + 1], E[i + 1], cL, cL, cE);
        }
      }
      const hubO = col(0.3, 0.32, 0.38), hubI = col(0.92, 0.94, 1);
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * TAU, a1 = ((i + 1) / 6) * TAU;
        tri([0, 0.02, 0], [Math.sin(a0) * 0.27, 0.02, Math.cos(a0) * 0.27], [Math.sin(a1) * 0.27, 0.02, Math.cos(a1) * 0.27], hubI, hubO, hubO);
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(C, 3));
      return g;
    });
  }
  // 冰棱：一根长的六棱冰锥（尖朝 +z）带两根小冰刺，按面朝向打上明暗
  function shardGeo() {
    return geo('iceShard', () => {
      const cone = new T.ConeGeometry(1, 1, 6);
      const g = bake('iceShardBake', [
        [gOct(1), 0xd8f4ff, 0, 0, 0.3, 0, 0, 0, 0.3, 0.3, 1.25],
        [gOct(1), 0xa8dcff, 0.22, 0.02, -0.35, 0, 0.45, 0, 0.13, 0.13, 0.6],
        [gOct(1), 0xa8dcff, -0.22, -0.02, -0.3, 0, -0.45, 0, 0.12, 0.12, 0.55],
        [cone, 0xffffff, 0, 0, 1.3, Math.PI / 2, 0, 0, 0.12, 0.4, 0.12],
      ]);
      cone.dispose();
      return facetShade(g, 0.3, 1, 0.4, 0.45);
    });
  }
  function pfPart(name, geom, mat, cap, order) {
    const mesh = new T.InstancedMesh(geom, mat, cap);
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    mesh.setColorAt(0, _pc.setRGB(1, 1, 1));
    mesh.instanceColor.setUsage(T.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    mesh.renderOrder = order || 0;
    scene.add(mesh);
    const p = { mesh, n: 0, cap };
    PF[name] = p;
    PF_LIST.push(p);
  }
  // 用 _pm 作当前矩阵写一个实例；颜色是线性空间
  function pfPut(name, r, g, b) {
    const p = PF[name];
    if (p.n >= p.cap) return;
    p.mesh.setMatrixAt(p.n, _pm);
    _pc.r = r; _pc.g = g; _pc.b = b;
    p.mesh.setColorAt(p.n, _pc);
    p.n++;
  }
  function mPose(x, y, z, q, sx, sy, sz) {
    _pm.compose(_pv.set(x, y, z), q, _ps.set(sx, sy, sz));
  }
  function mBill(x, y, z, s) {
    _pm.compose(_pv.set(x, y, z), camQ, _ps.set(s, s, s));
  }
  // 顺着速度拉长的公告板：面朝镜头，本地 +y 对准 (dx,dy,dz) 在屏幕上的投影
  function mStretch(x, y, z, dx, dy, dz, sx, sy) {
    _by.set(dx, dy, dz).addScaledVector(camB, -(dx * camB.x + dy * camB.y + dz * camB.z));
    if (_by.lengthSq() < 1e-8) _by.set(0, 1, 0);
    _by.normalize();
    _bx.crossVectors(_by, camB);
    _pm.makeBasis(_bx.multiplyScalar(sx), _by.multiplyScalar(sy), camB);
    _pm.setPosition(x, y, z);
  }
  let pfSolid = null;
  function initProjFx() {
    const add = (map, side) => new T.MeshBasicMaterial({ map, transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false, side: side || T.FrontSide });
    pfSolid = new T.MeshBasicMaterial({ toneMapped: false, fog: false });
    const vc = new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false, side: T.DoubleSide });
    const quad = geo('pfQuad', () => new T.PlaneGeometry(1, 1));
    const flameQuad = geo('pfFlame', () => new T.PlaneGeometry(1, 1).translate(0, -0.4, 0));
    pfPart('core', gIco(1, 1), pfSolid, 200, 0);
    pfPart('dart', gOct(1), pfSolid, 64, 0);
    pfPart('ring', geo('projRing', () => new T.TorusGeometry(1.75, 0.2, 5, 14)), pfSolid, 200, 0);
    pfPart('blade', bladeGeo(), vc, 64, 0);
    pfPart('shard', shardGeo(), vc, 64, 0);
    pfPart('blur', gQuad(), add(swooshTex(), T.DoubleSide), 64, 4);
    pfPart('glow', quad, add(glowTex()), 520, 5);
    pfPart('flame', flameQuad, add(flameTex()), 480, 6);
    // 普通混合的火舌：浅色地面（冰原、灰烬）上加色的火会被冲成一片白，垫一层实色的橙红火舌，火的形状和颜色才立得住
    pfPart('flameN', flameQuad, new T.MeshBasicMaterial({ map: flameHardTex(), transparent: true, depthWrite: false, toneMapped: false, fog: false }), 420, 5);
    pfPart('arc', quad, add(crackleTex()), 120, 6);
    const rockMat = new T.MeshStandardMaterial({ map: basaltTex(), roughness: 0.92, metalness: 0.05, flatShading: true });
    pfPart('debris', rockGeo(0), rockMat, 96, 0);
    // 卡通碎块（见 tChunk）：实心、不受光、不进雾，颜色就是画上去的颜色
    const tMat = new T.MeshBasicMaterial({ toneMapped: false, fog: false, side: T.DoubleSide });
    pfPart('tShard', geo('tShard', () => {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute([0, 0.62, 0, 0.5, 0.05, 0, 0, -0.38, 0, -0.5, 0.05, 0], 3));
      g.setIndex([0, 3, 1, 1, 3, 2]);
      return g;
    }), tMat, 128, 0);
    pfPart('tStar', geo('tStar', () => {
      const P = [0, 0, 0];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU, r = i % 2 ? 0.3 : 1;
        P.push(Math.sin(a) * r, Math.cos(a) * r, 0);
      }
      const idx = [];
      for (let i = 0; i < 8; i++) idx.push(0, 1 + i, 1 + ((i + 1) % 8));
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
      g.setIndex(idx);
      return g;
    }), tMat, 64, 0);
    // 烟团略透（0.8）：几个圆鼓包叠在一起的地方更实，看着是一团烟而不是一块石头
    pfPart('tPuff', geo('tPuff', () => new T.CircleGeometry(1, 10)), new T.MeshBasicMaterial({ toneMapped: false, fog: false, side: T.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }), 320, 3);
    initRibbons();
    rangedPfInit(add, vc, flameQuad, quad);
  }
  // 调试 / 测试：各零件此刻的实例数、拖尾条数、池里闲置的投射物数
  W.projFxInfo = function () {
    const o = { parts: {}, ribbons: 0, pool: pfPool.length };
    for (const k in PF) o.parts[k] = PF[k].mesh.count;
    for (let s = 0; s < RIB_N; s++) if (rbOn[s]) o.ribbons++;
    return o;
  };
  function pfBegin() {
    camQ.copy(camera.quaternion);
    camB.set(0, 0, 1).applyQuaternion(camQ);
    for (let i = 0; i < PF_LIST.length; i++) PF_LIST[i].n = 0;
  }
  function pfEnd() {
    for (let i = 0; i < PF_LIST.length; i++) {
      const p = PF_LIST[i], m = p.mesh;
      m.count = p.n;
      m.visible = p.n > 0;
      if (p.n) {
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor.needsUpdate = true;
      }
    }
  }

  // ----- 拖尾带子：所有投射物的拖尾合在一个网格里（一次 draw call），每颗占一段，按时间采样、面朝镜头、越往后越细越暗 -----
  const RIB_N = 128, RIB_S = 16, RIB_STEP = 0.02;
  const rbX = new Float32Array(RIB_N * RIB_S), rbY = new Float32Array(RIB_N * RIB_S), rbZ = new Float32Array(RIB_N * RIB_S), rbA = new Float32Array(RIB_N * RIB_S);
  const rbCnt = new Uint8Array(RIB_N), rbOn = new Uint8Array(RIB_N); // 0 空闲 1 跟着投射物 2 投射物没了、余下的淡出
  const rbW = new Float32Array(RIB_N), rbLife = new Float32Array(RIB_N), rbAcc = new Float32Array(RIB_N), rbCol = new Float32Array(RIB_N * 6);
  const rbPos = new Float32Array(RIB_N * RIB_S * 6), rbClr = new Float32Array(RIB_N * RIB_S * 6);
  let rbMesh = null, rbNext = 0, rbLive = 0;
  function initRibbons() {
    const g = new T.BufferGeometry();
    const side = new Float32Array(RIB_N * RIB_S * 2);
    const idx = new Uint16Array(RIB_N * (RIB_S - 1) * 6);
    let o = 0;
    for (let s = 0; s < RIB_N; s++) {
      for (let i = 0; i < RIB_S; i++) {
        const v = (s * RIB_S + i) * 2;
        side[v] = -1;
        side[v + 1] = 1;
        if (i < RIB_S - 1) {
          idx[o++] = v; idx[o++] = v + 1; idx[o++] = v + 2;
          idx[o++] = v + 1; idx[o++] = v + 3; idx[o++] = v + 2;
        }
      }
    }
    for (let i = 0; i < RIB_N * RIB_S * 2; i++) rbPos[i * 3 + 1] = -50;
    g.setAttribute('position', new T.BufferAttribute(rbPos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aCol', new T.BufferAttribute(rbClr, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aSide', new T.BufferAttribute(side, 1));
    g.setIndex(new T.BufferAttribute(idx, 1));
    const mat = new T.ShaderMaterial({
      vertexShader: 'attribute vec3 aCol; attribute float aSide; varying vec3 vC; varying float vS;\nvoid main(){ vC = aCol; vS = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'varying vec3 vC; varying float vS;\n' +
        'void main(){ float e = 1.0 - abs(vS); float a = smoothstep(0.0, 0.85, e); float core = pow(e, 6.0);\n' +
        ' gl_FragColor = vec4(vC * a + vec3(max(vC.r, max(vC.g, vC.b))) * core * 0.55, 1.0); }',
      blending: T.AdditiveBlending, transparent: true, depthWrite: false, side: T.DoubleSide,
    });
    rbMesh = new T.Mesh(g, mat);
    rbMesh.frustumCulled = false;
    rbMesh.renderOrder = 5;
    rbMesh.visible = false;
    scene.add(rbMesh);
  }
  // 申请一条拖尾：w 半宽，life 每个采样点活多久，头 / 尾的颜色（0..1，加色）。池满时先顶掉正在淡出的，再不行就不要拖尾
  function ribGet(w, life, r0, g0, b0, r1, g1, b1) {
    let s = -1;
    for (let i = 0; i < RIB_N; i++) {
      const k = (rbNext + i) % RIB_N;
      if (!rbOn[k]) { s = k; break; }
    }
    if (s < 0) for (let i = 0; i < RIB_N; i++) if (rbOn[i] === 2) { s = i; break; }
    if (s < 0) return -1;
    rbNext = (s + 1) % RIB_N;
    rbOn[s] = 1;
    rbCnt[s] = 0;
    rbW[s] = w;
    rbLife[s] = life;
    rbAcc[s] = 0;
    const c = s * 6;
    rbCol[c] = r0; rbCol[c + 1] = g0; rbCol[c + 2] = b0; rbCol[c + 3] = r1; rbCol[c + 4] = g1; rbCol[c + 5] = b1;
    rbLive = 1;
    return s;
  }
  // 拖尾头跟到 (x,y,z)：每 RIB_STEP 秒留下一个采样点
  function ribHead(s, x, y, z, dt) {
    if (s < 0 || rbOn[s] !== 1) return;
    rbLive = 1;
    const o = s * RIB_S;
    if (rbCnt[s] === 0) {
      rbX[o] = x; rbY[o] = y; rbZ[o] = z; rbA[o] = 0;
      rbX[o + 1] = x; rbY[o + 1] = y; rbZ[o + 1] = z; rbA[o + 1] = 0;
      rbCnt[s] = 2;
      return;
    }
    rbAcc[s] += dt;
    if (rbAcc[s] >= RIB_STEP) {
      rbAcc[s] = 0;
      const n = Math.min(RIB_S - 1, rbCnt[s]);
      rbX.copyWithin(o + 1, o, o + n);
      rbY.copyWithin(o + 1, o, o + n);
      rbZ.copyWithin(o + 1, o, o + n);
      rbA.copyWithin(o + 1, o, o + n);
      rbCnt[s] = n + 1;
    }
    rbX[o] = x; rbY[o] = y; rbZ[o] = z; rbA[o] = 0;
  }
  function ribRelease(s) {
    if (s >= 0 && rbOn[s] === 1) rbOn[s] = 2;
  }
  function ribKill(s) {
    rbOn[s] = 0;
    rbCnt[s] = 0;
    const v0 = s * RIB_S * 6;
    for (let i = 0; i < RIB_S * 6; i += 3) {
      rbPos[v0 + i] = 0; rbPos[v0 + i + 1] = -50; rbPos[v0 + i + 2] = 0;
      rbClr[v0 + i] = rbClr[v0 + i + 1] = rbClr[v0 + i + 2] = 0;
    }
  }
  function updateRibbons(dt) {
    if (!rbLive) return;
    let any = 0;
    for (let s = 0; s < RIB_N; s++) {
      if (!rbOn[s]) continue;
      const o = s * RIB_S, life = rbLife[s];
      let n = rbCnt[s];
      for (let i = rbOn[s] === 1 ? 1 : 0; i < n; i++) rbA[o + i] += dt;
      while (n > 1 && rbA[o + n - 1] >= life) n--;
      if (rbOn[s] === 2 && (n <= 1 || rbA[o] >= life)) {
        ribKill(s);
        continue;
      }
      rbCnt[s] = n;
      any = 1;
      const c = s * 6, w = rbW[s], v0 = s * RIB_S * 6;
      for (let i = 0; i < RIB_S; i++) {
        const j = Math.min(i, n - 1), v = v0 + i * 6;
        const i0 = o + Math.max(0, j - 1), i1 = o + Math.min(n - 1, j + 1);
        let tx = rbX[i0] - rbX[i1], ty = rbY[i0] - rbY[i1], tz = rbZ[i0] - rbZ[i1];
        // 侧向 = 切线 × 镜头后向（面朝镜头的带子）
        let sx = ty * camB.z - tz * camB.y, sy = tz * camB.x - tx * camB.z, sz = tx * camB.y - ty * camB.x;
        const sl = Math.hypot(sx, sy, sz);
        const f = i >= n ? 1 : Math.min(1, rbA[o + j] / life);
        const ww = sl > 1e-6 ? (w * Math.pow(1 - f, 0.7)) / sl : 0;
        sx *= ww; sy *= ww; sz *= ww;
        const x = rbX[o + j], y = rbY[o + j], z = rbZ[o + j];
        rbPos[v] = x - sx; rbPos[v + 1] = y - sy; rbPos[v + 2] = z - sz;
        rbPos[v + 3] = x + sx; rbPos[v + 4] = y + sy; rbPos[v + 5] = z + sz;
        const a = (1 - f) * (1 - f);
        const r = (rbCol[c] + (rbCol[c + 3] - rbCol[c]) * f) * a, g = (rbCol[c + 1] + (rbCol[c + 4] - rbCol[c + 1]) * f) * a, b = (rbCol[c + 2] + (rbCol[c + 5] - rbCol[c + 2]) * f) * a;
        rbClr[v] = rbClr[v + 3] = r; rbClr[v + 1] = rbClr[v + 4] = g; rbClr[v + 2] = rbClr[v + 5] = b;
      }
    }
    const ge = rbMesh.geometry;
    ge.attributes.position.needsUpdate = true;
    ge.attributes.aCol.needsUpdate = true;
    rbMesh.visible = !!any;
    if (!any) rbLive = 0;
  }
  // 换区 / 预热收尾：淡出中的拖尾直接收掉；还挂在投射物上的只清空采样（槽位仍归它，免得被别的投射物领走后两颗共用一条）
  function clearRibbons() {
    for (let s = 0; s < RIB_N; s++) {
      if (rbOn[s] === 1) {
        ribKill(s);
        rbOn[s] = 1;
      } else if (rbOn[s] || rbCnt[s]) ribKill(s);
    }
    if (rbMesh) {
      rbMesh.geometry.attributes.position.needsUpdate = true;
      rbMesh.geometry.attributes.aCol.needsUpdate = true;
      rbMesh.visible = false;
    }
    rbLive = 0;
  }

  // ----- 投射物本体 -----
  const projObjs = [], lootObjs = [];
  let portalObj = null;
  const pfPool = [];
  const HOSTILE_RED = 0xff2a22;
  // 每种外形的拖尾：[半宽, 寿命, 头色混白比例, 尾色亮度]（颜色从投射物的颜色算）
  const RIB_DEF = {
    ember: [0.24, 0.2], blade: [0.09, 0.1], dart: [0.12, 0.22], orb: [0.18, 0.15],
    glob: [0.17, 0.15], shard: [0.15, 0.2], spark: [0.13, 0.12], firebolt: [0.28, 0.22], horb: [0.15, 0.12],
    // 远程武器：子弹 / 左轮的重弹 / 箭 / 冰弓的寒冰箭 / 喷枪的火团
    bullet: [0.045, 0.07], slug: [0.07, 0.1], arrow: [0.04, 0.16], emberarrow: [0.11, 0.24], flamelet: [0.2, 0.12],
  };
  // 外形别名：game.js 那边怎么起名都认得
  const PF_ALIAS = { tracer: 'bullet', round: 'bullet', gun: 'bullet', gatling: 'bullet', revolver: 'slug', bolt: 'slug', homing: 'arrow', harrow: 'arrow', earrow: 'arrow', bow: 'arrow', flame: 'flamelet', flamer: 'flamelet', fire: 'flamelet', emberbow: 'emberarrow' };
  const PF_HOSTILE = { glob: 1, shard: 1, spark: 1, firebolt: 1, horb: 1 };
  // makeProjectile(hex, radius, hostile[, opts])：opts.kind 外形（缺省按敌我取 orb / horb），opts.dx/dz 出生时的飞行方向，
  // opts.tint 注入的元素色（拖尾、光晕和命中往这个颜色偏一点）
  W.makeProjectile = function (hex, radius, hostile, opts) {
    const o = opts || {};
    let kind = PF_ALIAS[o.kind] || o.kind;
    if (!hostile && !PF_DRAW[kind]) kind = rangedAutoKind(kind); // 远程武器普攻的弹丸：按手里的武器认外形（子弹 / 箭 / 火团）
    if (!PF_DRAW[kind] || !!PF_HOSTILE[kind] !== !!hostile) kind = hostile ? 'horb' : 'orb'; // 敌我外形不串用
    const h = hexOf(hex);
    const grp = pfPool.length ? pfPool.pop() : new T.Group();
    const u = grp.userData;
    u.kind = 'proj';
    u.vfx = kind;
    u.pooled = false;
    u.hostile = !!hostile;
    u.rad = radius;
    u.hex = h;
    _c.set(h);
    u.r = _c.r; u.g = _c.g; u.b = _c.b; // sRGB（粒子 / 拖尾用）
    _c.convertSRGBToLinear();
    u.lr = _c.r; u.lg = _c.g; u.lb = _c.b; // 线性（实例颜色用）
    if (o.tint !== undefined && o.tint !== null) {
      _c.set(o.tint);
      u.tr = _c.r; u.tg = _c.g; u.tb = _c.b; u.tinted = true;
    } else {
      u.tr = u.r; u.tg = u.g; u.tb = u.b; u.tinted = false;
    }
    u.age = 0;
    u.ph = rand(0, TAU);
    u.acc = 0;
    u.acc2 = 0;
    const dl = Math.hypot(o.dx || 0, o.dz || 0);
    u.dx = dl > 0 ? o.dx / dl : 0;
    u.dz = dl > 0 ? o.dz / dl : 1;
    u.lx = NaN; u.lz = NaN;
    u.trail = true; // world 自己画拖尾（game.js 不再每帧撒通用火花）
    u.ox = 0; u.oz = 0; u.oy = 0;
    const rd = RIB_DEF[kind];
    u.rib = ribForKind(kind, u, rd);
    if (RANGED_PF[kind]) rangedOnSpawn(kind, u);
    grp.position.set(0, -50, 0); // 调用方下一行就会设置位置；先藏到地下
    scene.add(grp);
    projObjs.push(grp);
    return grp;
  };
  function ribForKind(kind, u, rd) {
    // 拖尾颜色：头偏白、尾压暗；注入的元素色混进尾巴
    let r0, g0, b0, r1, g1, b1;
    const tk = u.tinted ? 0.55 : 0;
    if (kind === 'ember') { r0 = 0.95; g0 = 0.55; b0 = 0.2; r1 = 0.7; g1 = 0.1; b1 = 0.02; }
    else if (kind === 'blade') { r0 = 0.62; g0 = 0.68; b0 = 0.8; r1 = 0.22; g1 = 0.25; b1 = 0.32; }
    else if (kind === 'shard') { r0 = 0.72; g0 = 0.92; b0 = 1; r1 = 0.15; g1 = 0.35; b1 = 0.6; }
    else if (kind === 'spark') { r0 = 1; g0 = 0.95; b0 = 0.6; r1 = 0.55; g1 = 0.45; b1 = 0.1; }
    else if (kind === 'firebolt') { r0 = 1; g0 = 0.45; b0 = 0.12; r1 = 0.55; g1 = 0.05; b1 = 0.02; }
    else if (kind === 'bullet' || kind === 'slug') { r0 = 1; g0 = 0.9; b0 = 0.6; r1 = 0.8; g1 = 0.35; b1 = 0.08; }
    else if (kind === 'emberarrow') { r0 = 0.42; g0 = 0.76; b0 = 1; r1 = 0.04; g1 = 0.22; b1 = 0.65; }
    else if (kind === 'flamelet') { r0 = 1; g0 = 0.6; b0 = 0.22; r1 = 0.6; g1 = 0.08; b1 = 0.02; }
    else if (u.hostile) { r0 = u.r * 0.6; g0 = u.g * 0.6; b0 = u.b * 0.6; r1 = 0.45; g1 = 0.04; b1 = 0.03; }
    else { r0 = u.r + (1 - u.r) * 0.45; g0 = u.g + (1 - u.g) * 0.45; b0 = u.b + (1 - u.b) * 0.45; r1 = u.r * 0.55; g1 = u.g * 0.55; b1 = u.b * 0.55; }
    if (tk) {
      r1 += (u.tr - r1) * tk; g1 += (u.tg - g1) * tk; b1 += (u.tb - b1) * tk;
      r0 += (u.tr - r0) * tk * 0.4; g0 += (u.tg - g0) * tk * 0.4; b0 += (u.tb - b0) * tk * 0.4;
    }
    return ribGet(rd[0], rd[1], r0, g0, b0, r1, g1, b1);
  }
  // 线性空间里把投射物色往白 / 往暗混
  function pfLight(u, k) {
    _pc.setRGB(u.lr + (1 - u.lr) * k, u.lg + (1 - u.lg) * k, u.lb + (1 - u.lb) * k);
    return _pc;
  }
  function pfDark(u, k) {
    // 和旧的敌弹内核一样：元素色压向近黑的暗红（k 按 sRGB 的混合比例给，这里换算到线性）
    const m = Math.pow(1 - k, 2.2);
    _pc.setRGB(u.lr * m + 0.0033 * k, u.lg * m + 0.0006 * k, u.lb * m + 0.0012 * k);
    return _pc;
  }
  const RED_L = new T.Color(HOSTILE_RED).convertSRGBToLinear();
  function hostileRing(u, x, y, z, s) {
    _pe.set(u.age * 7 + u.ph, u.age * 9, 0);
    _pq.setFromEuler(_pe);
    mPose(x, y, z, _pq, s, s, s);
    pfPut('ring', RED_L.r, RED_L.g, RED_L.b);
  }
  function glowPut(u, x, y, z, s, k) {
    let r = u.lr, g = u.lg, b = u.lb;
    if (u.tinted) {
      _c.setRGB(u.tr, u.tg, u.tb).convertSRGBToLinear();
      r += (_c.r - r) * 0.4; g += (_c.g - g) * 0.4; b += (_c.b - b) * 0.4;
    }
    mBill(x, y, z, s);
    pfPut('glow', r * k, g * k, b * k);
  }
  // 绕 y 轴转向飞行方向的四元数
  function yawQ(u) {
    return _pq.setFromAxisAngle(UP, Math.atan2(u.dx, u.dz));
  }
  // 一条火舌：从 (x,z) 往飞行反方向拖，ang 是相对飞行方向的偏角
  function flameTongue(u, x, y, z, ang, w, len, r, g, b, part) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const ex = u.dx * c + u.dz * s, ez = -u.dx * s + u.dz * c;
    mStretch(x, y, z, ex, 0, ez, w, len);
    pfPut(part || 'flame', r, g, b);
  }
  const PF_DRAW = {
    // 掷焰：白热的核，一团内焰，三条左右摆动、长短闪烁的外焰舌；一路落下火星、拖一缕细烟
    ember(u, x, y, z, dt) {
      const r = u.rad, t = u.age, ph = u.ph;
      mPose(x, y, z, _pqI, r * 0.56, r * 0.56, r * 0.56); // 卡通版：白热的核大一圈，火球有一个清楚的亮芯
      pfPut('core', 1, 0.88, 0.58);
      const f1 = 1 + 0.16 * Math.sin(t * 37 + ph);
      const tk = u.tinted ? 0.45 : 0;
      _c.setRGB(u.tr, u.tg, u.tb).convertSRGBToLinear();
      // 火球：短而胖的一团（贴图的圆头），再套一层拉长的内焰
      mStretch(x + u.dx * r * 0.6, y, z + u.dz * r * 0.6, u.dx, 0, u.dz, r * 2.6 * (2 - f1), r * 2.2 * f1);
      pfPut('flame', 0.5 + (_c.r - 0.5) * tk * 0.5, 0.17 + (_c.g - 0.17) * tk * 0.5, 0.03 + (_c.b - 0.03) * tk * 0.5);
      const or = 0.8 + (_c.r - 0.8) * tk, og = 0.13 + (_c.g - 0.13) * tk, ob = 0.015 + (_c.b - 0.015) * tk;
      // 外焰舌：实色的橙红，三条左右错开、各自摆动闪烁
      const sr = 1 + (_c.r - 1) * tk, sg = 0.2 + (_c.g - 0.2) * tk, sb = 0.02 + (_c.b - 0.02) * tk;
      for (let k = 0; k < 3; k++) {
        const wob = Math.sin(t * 17 + ph + k * 2.1) * 0.35 + (k - 1) * 0.5;
        const len = r * (4.4 + 1.6 * Math.sin(t * 23 + k * 1.7 + ph)) * (k === 1 ? 1.3 : 0.85);
        const lat = (k - 1) * r * 0.55;
        flameTongue(u, x + u.dx * r * 0.35 + u.dz * lat, y + (k - 1) * 0.03, z + u.dz * r * 0.35 - u.dx * lat, wob, r * (k === 1 ? 2.4 : 1.9), len, sr, sg, sb, 'flameN');
      }
      // 实色火舌里的亮芯
      for (let k = 0; k < 2; k++) {
        const wob = Math.sin(t * 19 + ph + k * 2.7) * 0.25 + (k - 0.5) * 0.3;
        flameTongue(u, x + u.dx * r * 0.2, y + 0.04, z + u.dz * r * 0.2, wob, r * 1.0, r * (3 + Math.sin(t * 29 + k)), or * 0.8, og * 0.8, ob * 0.8);
      }
      // 卡通版：加色的光晕压到一半多（之前和泛光一起把火球冲成白团），形状靠实色火舌和下面的实心火团立住
      glowPut(u, x, y, z, r * 5, 0.26);
      u.acc += dt;
      while (u.acc > 0.02) {
        u.acc -= 0.02;
        const wh = Math.random();
        // 火星：小而亮，往上飘、往两侧散
        spawnP(x - u.dx * r + rand(-0.12, 0.12), y + rand(-0.1, 0.12), z - u.dz * r + rand(-0.12, 0.12), rand(-1.2, 1.2) - u.dx * 1.5, rand(0.3, 1.8), rand(-1.2, 1.2) - u.dz * 1.5, rand(0.25, 0.5), rand(0.08, 0.14), 1, 0.65 + wh * 0.3, 0.2 + wh * 0.4, -1.5, 1.8);
      }
      // 尾巴：一串实心的火团（亮橙压在深红上），先胀后缩没；低画质间隔加倍
      u.acc3 = (u.acc3 || 0) + dt;
      const pg = qualId === 'low' ? 0.07 : 0.035;
      if (u.acc3 > pg) {
        u.acc3 = 0;
        const fp = tk ? mixHex(0xff8424, u.hex, tk) : 0xff8424;
        tChunk(2, x - u.dx * r * 1.6 + rand(-0.1, 0.1), y + rand(-0.06, 0.1), z - u.dz * r * 1.6 + rand(-0.1, 0.1), -u.dx * 1.5 + rand(-0.6, 0.6), rand(0.3, 1.1), -u.dz * 1.5 + rand(-0.6, 0.6), rand(0.14, 0.24), r * rand(0.6, 1.0), fp, 0xb4281a, -1);
      }
      u.acc2 += dt;
      if (u.acc2 > 0.05) {
        u.acc2 = 0;
        spawnS(x - u.dx * r * 3, y + 0.1, z - u.dz * r * 3, rand(-0.2, 0.2), rand(0.5, 1.1), rand(-0.2, 0.2), rand(0.45, 0.7), rand(0.35, 0.5), 0.14, 0.12, 0.11, 0.4);
        smokeLive = 1.2;
      }
    },
    // 飞刃：三刃的旋转飞刃 + 跟着转的残影环，刃口随着转动一闪一闪
    blade(u, x, y, z, dt) {
      const r = u.rad, spin = u.age * 30 + u.ph;
      _pq.setFromAxisAngle(UP, spin);
      const k = 0.92 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(u.age * 11 + u.ph), 12);
      mPose(x, y, z, _pq, r * 2.5, r * 2.5, r * 2.5);
      pfPut('blade', k, k, k * 1.04);
      _pq.setFromAxisAngle(UP, spin - 0.35);
      mPose(x, y - 0.03, z, _pq, r * 3, 1, r * 3);
      if (u.tinted) {
        _c.setRGB(u.tr, u.tg, u.tb).convertSRGBToLinear();
        pfPut('blur', 0.3 + _c.r * 0.35, 0.33 + _c.g * 0.35, 0.4 + _c.b * 0.35);
      } else pfPut('blur', 0.42, 0.48, 0.6);
      glowPut(u, x, y, z, r * 4.2, 0.3);
    },
    // 秘弹：拉长的晶尖 + 两粒绕着它转的光点，拖一条元素色的细带
    dart(u, x, y, z, dt) {
      yawQ(u);
      const c = pfLight(u, 0.55);
      mPose(x, y, z, _pq, 0.085, 0.085, 0.3);
      pfPut('dart', c.r, c.g, c.b);
      const sx = u.dz, sz = -u.dx; // 侧向
      for (let k = 0; k < 2; k++) {
        const a = u.age * 24 + k * Math.PI + u.ph, o = Math.cos(a) * 0.17;
        mPose(x + sx * o - u.dx * 0.05, y + Math.sin(a) * 0.17, z + sz * o - u.dz * 0.05, _pqI, 0.035, 0.035, 0.035);
        pfPut('core', c.r, c.g, c.b);
      }
      glowPut(u, x, y, z, 1.0, 0.85);
      u.acc += dt;
      if (u.acc > 0.035) {
        u.acc = 0;
        spawnP(x + rand(-0.06, 0.06), y + rand(-0.06, 0.06), z + rand(-0.06, 0.06), rand(-0.4, 0.4), rand(-0.2, 0.5), rand(-0.4, 0.4), rand(0.2, 0.35), 0.12, u.r + (1 - u.r) * 0.3, u.g + (1 - u.g) * 0.3, u.b + (1 - u.b) * 0.3, 0, 2);
      }
    },
    // 通用光球（没有专门外形的玩家投射物）
    orb(u, x, y, z, dt) {
      const c = pfLight(u, 0.6);
      mPose(x, y, z, _pqI, u.rad, u.rad, u.rad);
      pfPut('core', c.r, c.g, c.b);
      glowPut(u, x, y, z, u.rad * 6.5, 1);
      pfSpray(u, x, y, z, dt);
    },
    // 喷吐者的黏液弹：一团压扁拉长、不停晃动的暗色黏液，表面一点湿亮的高光，后面甩着两滴，一路往下滴
    glob(u, x, y, z, dt) {
      const r = u.rad * 1.1, t = u.age, wob = Math.sin(t * 15 + u.ph);
      yawQ(u);
      const c = pfDark(u, 0.5);
      const cr = c.r, cg = c.g, cb = c.b;
      mPose(x, y, z, _pq, r * (1 - 0.1 * wob), r * (0.9 + 0.1 * wob), r * (1.2 + 0.12 * wob));
      pfPut('core', cr, cg, cb);
      const hl = pfLight(u, 0.7);
      mPose(x - r * 0.28, y + r * 0.6, z + r * 0.18, _pqI, r * 0.3, r * 0.18, r * 0.26);
      pfPut('core', hl.r, hl.g, hl.b);
      const sx = u.dz, sz = -u.dx;
      for (let k = 1; k <= 2; k++) {
        const d = r * (1.35 + k * 0.85) + 0.05 * Math.sin(t * 20 + k), lat = Math.sin(t * 11 + k * 2 + u.ph) * 0.07, s = r * (0.5 - 0.15 * k);
        mPose(x - u.dx * d + sx * lat, y - 0.04 * k, z - u.dz * d + sz * lat, _pqI, s, s, s);
        pfPut('core', cr, cg, cb);
      }
      hostileRing(u, x, y, z, u.rad * 1.15);
      glowPut(u, x, y, z, u.rad * 5.5, 0.85);
      u.acc += dt;
      if (u.acc > 0.06) {
        u.acc = 0;
        spawnP(x - u.dx * r + rand(-0.1, 0.1), y - r * 0.6, z - u.dz * r + rand(-0.1, 0.1), rand(-0.3, 0.3), rand(-0.5, 0), rand(-0.3, 0.3), rand(0.4, 0.6), rand(0.12, 0.17), u.r * 0.75, u.g * 0.75, u.b * 0.75, 16, 0.6);
      }
    },
    // 霜织者的冰棱：尖朝前、绕自身轴滚转的冰锥，一路散着霜雾和冰晶闪点
    shard(u, x, y, z, dt) {
      const r = u.rad;
      yawQ(u);
      _pq.multiply(_pq2.setFromAxisAngle(Z_AXIS, u.age * 9 + u.ph));
      const c = pfLight(u, 0.35);
      mPose(x, y, z, _pq, r * 1.6, r * 1.6, r * 1.6);
      pfPut('shard', c.r, c.g, c.b);
      hostileRing(u, x, y, z, u.rad * 1.15);
      glowPut(u, x, y, z, u.rad * 5, 0.65);
      u.acc += dt;
      if (u.acc > 0.035) {
        u.acc = 0;
        spawnP(x - u.dx * r + rand(-0.15, 0.15), y + rand(-0.1, 0.1), z - u.dz * r + rand(-0.15, 0.15), rand(-0.4, 0.4), rand(-0.2, 0.3), rand(-0.4, 0.4), rand(0.3, 0.5), rand(0.16, 0.26), 0.55, 0.75, 0.9, 0.5, 2.5);
        if (Math.random() < 0.4) spawnP(x + rand(-0.2, 0.2), y + rand(-0.15, 0.15), z + rand(-0.2, 0.2), 0, 0, 0, 0.18, 0.13, 1, 1, 1, 0, 0);
      }
    },
    // 雷霆监察者的雷球：暗色的球心，表面三道不停变换方向的电弧，往外乱迸的电火花
    spark(u, x, y, z, dt) {
      const r = u.rad, t = u.age;
      // 一颗跳动的亮芯，外面压一圈暗色的「电壳」（只是一圈暗环，不挡住亮芯）
      const pulse = 1 + 0.15 * Math.sin(t * 40 + u.ph);
      mPose(x, y, z, _pqI, r * 0.42 * pulse, r * 0.42 * pulse, r * 0.42 * pulse);
      pfPut('core', 1, 0.92, 0.6);
      mBill(x, y, z, r * 3.2 * pulse);
      pfPut('glow', 1, 0.85, 0.35);
      const fr = Math.floor(t * 24);
      for (let k = 0; k < 4; k++) {
        const hsh = hash2(fr * 3 + k, k * 17 + Math.floor(u.ph * 100));
        const ang = hsh * TAU, on = hash2(fr + 11, k) < 0.8 ? 1 : 0.3;
        _pq.copy(camQ).multiply(_pq2.setFromAxisAngle(Z_AXIS, ang));
        mPose(x, y, z, _pq, r * (3.2 + hsh * 1.8), r * 1.1, 1);
        pfPut('arc', 1.2 * on, 1.05 * on, 0.5 * on);
      }
      hostileRing(u, x, y, z, u.rad * 1.15);
      glowPut(u, x, y, z, u.rad * 6, 0.85);
      u.acc += dt;
      if (u.acc > 0.05) {
        u.acc = 0;
        const a = rand(0, TAU), v = rand(4, 8);
        spawnP(x, y, z, Math.sin(a) * v, rand(-1, 3), Math.cos(a) * v, rand(0.06, 0.14), 0.12, 1, 1, 0.7, 0, 6);
      }
    },
    // 熔渣巨像 / 烬渊之主的火弹：拉长的暗红焰心裹着深红的火舌，拖着黑烟
    firebolt(u, x, y, z, dt) {
      const r = u.rad, t = u.age, ph = u.ph;
      yawQ(u);
      mPose(x, y, z, _pq, r * 0.75, r * 0.75, r * 1.35);
      pfPut('core', 0.1, 0.012, 0.006);
      const f1 = 1 + 0.18 * Math.sin(t * 33 + ph);
      mStretch(x + u.dx * r * 0.4, y, z + u.dz * r * 0.4, u.dx, 0, u.dz, r * 2.4, r * 3.6 * f1);
      pfPut('flame', 0.85, 0.3, 0.05);
      for (let k = 0; k < 3; k++) {
        const wob = Math.sin(t * 15 + ph + k * 2.3) * 0.25 + (k - 1) * 0.35;
        const len = r * (4.8 + 1.6 * Math.sin(t * 21 + k * 1.9 + ph));
        // 敌方火弹：暗红实色火舌（比玩家的掷焰深一截），外面再罩一层淡淡的加色
        flameTongue(u, x, y + (k - 1) * 0.04, z, wob, r * 2.2, len, 0.45, 0.03, 0.012, 'flameN');
        if (k !== 1) flameTongue(u, x, y + 0.05, z, wob * 0.7, r * 1.3, len * 0.7, 0.55, 0.08, 0.02);
      }
      hostileRing(u, x, y, z, u.rad * 1.15);
      glowPut(u, x, y, z, u.rad * 6, 0.75);
      u.acc += dt;
      while (u.acc > 0.03) {
        u.acc -= 0.03;
        spawnP(x - u.dx * r * 1.5 + rand(-0.1, 0.1), y + rand(-0.1, 0.1), z - u.dz * r * 1.5 + rand(-0.1, 0.1), rand(-1, 1), rand(0.3, 1.5), rand(-1, 1), rand(0.25, 0.45), rand(0.1, 0.15), 1, 0.4, 0.1, -1, 1.5);
      }
      u.acc2 += dt;
      if (u.acc2 > 0.045) {
        u.acc2 = 0;
        spawnS(x - u.dx * r * 2.5, y + 0.05, z - u.dz * r * 2.5, rand(-0.2, 0.2), rand(0.4, 0.9), rand(-0.2, 0.2), rand(0.5, 0.8), rand(0.45, 0.6), 0.09, 0.06, 0.06, 0.55);
        smokeLive = 1.2;
      }
    },
    // 通用敌弹：压暗的内核 + 红环（和旧版一样的识别语言）
    horb(u, x, y, z, dt) {
      const c = pfDark(u, 0.62), s = u.rad * 1.15;
      mPose(x, y, z, _pqI, s, s, s);
      pfPut('core', c.r, c.g, c.b);
      hostileRing(u, x, y, z, s);
      glowPut(u, x, y, z, s * 7, 1);
      pfSpray(u, x, y, z, dt);
    },
  };
  function pfSpray(u, x, y, z, dt) {
    u.acc += dt;
    if (u.acc > 0.028) {
      u.acc = 0;
      spawnP(x + rand(-0.1, 0.1), y + rand(-0.1, 0.1), z + rand(-0.1, 0.1), rand(-0.6, 0.6), rand(-0.2, 0.8), rand(-0.6, 0.6), rand(0.2, 0.36), u.rad * 2.2, u.r * 0.8, u.g * 0.8, u.b * 0.8, -0.5, 1);
    }
  }
  function pfDraw(m, u, p, dt) {
    if (p.y < -10) return; // 还没摆到位置上
    u.age += dt;
    if (u.lx === u.lx) {
      const mx = p.x - u.lx, mz = p.z - u.lz, l2 = mx * mx + mz * mz;
      if (l2 > 1e-8) {
        const l = Math.sqrt(l2);
        u.dx = mx / l;
        u.dz = mz / l;
      }
    }
    u.lx = p.x;
    u.lz = p.z;
    if (u.rib >= 0) ribHead(u.rib, p.x, p.y, p.z, dt);
    PF_DRAW[u.vfx](u, p.x, p.y, p.z, dt);
  }

  // ----- 命中 / 撞墙 / 爆炸：W.projImpact(mesh, x, z, how, R) -----
  // how：'hit' 打中目标（可能继续飞）/ 'wall' 撞墙 / 'blast' 爆炸（R 为半径）。认得这种外形就画并返回 true，否则返回 false（调用方用通用火花）
  W.projImpact = function (mesh, x, z, how, R) {
    const u = mesh && mesh.userData;
    const vk = u && u.vfx;
    if (!vk) return false;
    const y = 1.1;
    if (vk === 'ember') {
      if (how === 'hit') return true; // 掷焰打中后由爆炸那一下出特效
      fireBurst(x, y, z, R || 1, u);
      return true;
    }
    if (vk === 'blade') {
      metalSparks(x, y, z, u.dx, u.dz, how === 'wall' ? 1.5 : 1, u);
      if (how === 'wall') W.decal(0, x - u.dx * 0.3, z - u.dz * 0.3, 0.6, Math.atan2(u.dx, u.dz), 0xfff0d0, 0.3, 0.14);
      return true;
    }
    if (vk === 'dart') {
      if (how === 'hit') return true;
      const h = u.hex, Rr = R || 0.8;
      W.ring(x, z, Rr, h, 0.26);
      W.ring(x, z, Rr * 0.45, mixHex(h, 0xffffff, 0.6), 0.16);
      flare(x, y, z, h, 1.3, 0.1);
      for (let i = 0; i < 14; i++) {
        const a = rand(0, TAU), v = rand(2.5, 6) * Math.max(0.6, Rr * 0.6), wh = i % 3 === 0 ? 0.6 : 0.15;
        spawnP(x, y, z, Math.sin(a) * v, rand(-0.5, 2.5), Math.cos(a) * v, rand(0.18, 0.35), rand(0.12, 0.2), u.r + (1 - u.r) * wh, u.g + (1 - u.g) * wh, u.b + (1 - u.b) * wh, 2, 3.5);
      }
      W.decal(3, x, z, Rr * 0.5, rand(0, TAU), h, 1.2);
      return true;
    }
    if (vk === 'orb') {
      if (how === 'hit') return false;
      W.ring(x, z, R || 1, u.hex, 0.3);
      W.burst(x, 1.0, z, u.hex, 16, 6, 0.4);
      return true;
    }
    // 敌方弹丸：命中 / 撞墙都是一次就没了
    if (vk === 'glob') {
      // 溅开：一圈往外甩的黏液滴、地上一摊、一点带颜色的雾
      for (let i = 0; i < 12; i++) {
        const a = rand(0, TAU), v = rand(1.5, 4.5);
        spawnP(x, y, z, Math.sin(a) * v, rand(0.5, 3.5), Math.cos(a) * v, rand(0.35, 0.6), rand(0.13, 0.22), u.r * 0.8, u.g * 0.8, u.b * 0.8, 14, 1);
      }
      W.smoke(x, y - 0.3, z, 0.2, 3, mixHex(u.hex, 0x101010, 0.6));
      W.decal(4, x, z, 0.75, rand(0, TAU), u.hex, 1.6);
      flare(x, y, z, u.hex, 0.8, 0.07);
      return true;
    }
    if (vk === 'shard') {
      // 碎冰：大块往下掉的冰碴 + 白雾 + 一小片霜痕
      for (let i = 0; i < 12; i++) {
        const a = rand(0, TAU), v = rand(2, 5.5);
        spawnP(x, y, z, Math.sin(a) * v, rand(1, 4), Math.cos(a) * v, rand(0.35, 0.6), rand(0.16, 0.3), 0.82, 0.94, 1, 18, 1.4);
      }
      W.smoke(x, y - 0.2, z, 0.25, 3, 0xbfdcec);
      W.decal(2, x, z, 0.9, rand(0, TAU), 0x9fdcff, 1.4);
      flare(x, y, z, 0xcfefff, 1.0, 0.08);
      return true;
    }
    if (vk === 'spark') {
      for (let i = 0; i < 12; i++) {
        const a = rand(0, TAU), v = rand(7, 14);
        spawnP(x, y, z, Math.sin(a) * v, rand(-2, 6), Math.cos(a) * v, rand(0.06, 0.16), 0.13, 1, 1, 0.7, 0, 6);
      }
      flare(x, y, z, 0xfff3a0, 1.4, 0.1);
      W.decal(3, x, z, 0.8, rand(0, TAU), 0xffe45e, 1.2);
      flashLight(x, 2, z, 0xffe45e, 0.9);
      return true;
    }
    if (vk === 'firebolt') {
      for (let i = 0; i < 12; i++) {
        const a = rand(0, TAU), v = rand(2, 5);
        spawnP(x, y, z, Math.sin(a) * v, rand(0.5, 3), Math.cos(a) * v, rand(0.25, 0.5), rand(0.14, 0.24), 1, rand(0.25, 0.5), 0.06, 4, 2);
      }
      W.smoke(x, y, z, 0.25, 3, 0x1a1010);
      W.decal(1, x, z, 0.7, rand(0, TAU), 0xff5a2a, 1.6);
      flare(x, y, z, 0xff7a2c, 1.0, 0.08);
      return true;
    }
    if (vk === 'horb') return false;
    return false;
  };
  // 掷焰炸开：火球闪光、一圈火焰环、往外喷的火星和火团、一团黑烟、地上一块短暂的焦痕
  function fireBurst(x, y, z, R, u) {
    const tint = u && u.tinted ? (_c.setRGB(u.tr, u.tg, u.tb), _c.getHex()) : 0;
    const h = tint ? mixHex(0xff7a2c, tint, 0.45) : 0xff7a2c;
    // 卡通版：硬边的色环 + 一颗大星 + 一圈往外翻的实心火团（亮黄压橙、橙压深红）+ 几片焦黑的碎块 + 少量火星，地上一块硬边焦斑
    const lo = qualId === 'low', P = HIT_PAL.fire;
    W.ring(x, z, R, h, 0.3); // 只留一道环：两道同心环压在焦斑上像个靶子
    tChunk(1, x, y + 0.15, z, 0, 0, 0, 0.2, 0.9 + R * 0.25, P[0], tint ? h : P[1], 0);
    flashLight(x, 2, z, 0xff8a3c, 1.6);
    for (let i = 0, n = lo ? 5 : 9; i < n; i++) {
      // 火团：大、往外翻、往上飘；三团里一团是亮黄的
      const a = (i / n) * TAU + rand(-0.3, 0.3), v = rand(1.6, 3) * R;
      tChunk(2, x + Math.sin(a) * 0.2, y - 0.2, z + Math.cos(a) * 0.2, Math.sin(a) * v, rand(1, 2.6), Math.cos(a) * v, rand(0.32, 0.46), rand(0.32, 0.46) * Math.sqrt(R), i % 3 ? h : 0xffd060, i % 3 ? P[2] : h, -1.5);
    }
    for (let i = 0, n = lo ? 3 : 5; i < n; i++) {
      const a = rand(0, TAU), v = rand(4, 7) * Math.sqrt(R);
      tChunk(0, x, y, z, Math.sin(a) * v, rand(3, 6), Math.cos(a) * v, rand(0.35, 0.5), rand(0.14, 0.2), 0xffb040, 0x3a1a20, 16);
    }
    for (let i = 0, n = lo ? 6 : 10; i < n; i++) {
      // 火星：小、快、带重力
      const a = rand(0, TAU), v = rand(4, 9) * Math.sqrt(R);
      spawnP(x, y, z, Math.sin(a) * v, rand(1, 6), Math.cos(a) * v, rand(0.3, 0.6), rand(0.08, 0.14), 1, rand(0.7, 0.95), rand(0.3, 0.6), 12, 1.5);
    }
    W.smoke(x, y + 0.2, z, 0.35 * R, lo ? 2 : 3, 0x241a16);
    W.decal(1, x, z, R * 0.7, rand(0, TAU), h, 1.8);
  }
  // 金属火花：顺着飞行方向喷出去的一把亮白火花
  function metalSparks(x, y, z, dx, dz, k, u) {
    const ang = Math.atan2(dx, dz);
    for (let i = 0, n = Math.round(11 * k); i < n; i++) {
      const a = ang + rand(-1, 1) * (i % 3 === 0 ? 1.8 : 0.8) + (k > 1 ? Math.PI : 0), v = rand(5, 12);
      const wh = Math.random();
      spawnP(x, y + rand(-0.1, 0.15), z, Math.sin(a) * v, rand(0.5, 4), Math.cos(a) * v, rand(0.1, 0.26), rand(0.07, 0.12), 1, 0.85 + wh * 0.15, 0.55 + wh * 0.4, 16, 3.5);
    }
    if (u && u.tinted) for (let i = 0; i < 5; i++) spawnP(x, y, z, rand(-3, 3), rand(0, 3), rand(-3, 3), rand(0.2, 0.35), 0.16, u.tr, u.tg, u.tb, 4, 3);
    flare(x, y, z, 0xeef4ff, 0.75 * k, 0.06);
  }

  // ----- 陨石的火焰尾 / 落地的碎石（每帧在 updateProjFx 里写实例） -----
  const DB_N = 96;
  const dbX = new Float32Array(DB_N), dbY = new Float32Array(DB_N), dbZ = new Float32Array(DB_N);
  const dbVX = new Float32Array(DB_N), dbVY = new Float32Array(DB_N), dbVZ = new Float32Array(DB_N);
  const dbL = new Float32Array(DB_N), dbM = new Float32Array(DB_N), dbS = new Float32Array(DB_N), dbR = new Float32Array(DB_N), dbC = new Float32Array(DB_N * 3);
  let dbNext = 0, dbLive = 0;
  function debrisBurst(x, z, n, hex, sp) {
    _c.set(hex);
    for (let i = 0; i < n; i++) {
      const k = dbNext;
      dbNext = (dbNext + 1) % DB_N;
      const a = rand(0, TAU), v = rand(3, 7.5) * sp;
      dbX[k] = x + Math.sin(a) * 0.4; dbY[k] = 0.4; dbZ[k] = z + Math.cos(a) * 0.4;
      dbVX[k] = Math.sin(a) * v; dbVY[k] = rand(4, 9) * sp; dbVZ[k] = Math.cos(a) * v;
      dbL[k] = dbM[k] = rand(0.7, 1.1);
      dbS[k] = rand(0.1, 0.22);
      dbR[k] = rand(0, TAU);
      dbC[k * 3] = _c.r; dbC[k * 3 + 1] = _c.g; dbC[k * 3 + 2] = _c.b;
    }
    dbLive = 1.2;
  }
  function updateDebris(dt) {
    if (dbLive <= 0) return;
    dbLive -= dt;
    for (let k = 0; k < DB_N; k++) {
      if (dbL[k] <= 0) continue;
      dbL[k] -= dt;
      if (dbL[k] <= 0) continue;
      dbVY[k] -= 22 * dt;
      dbX[k] += dbVX[k] * dt; dbY[k] += dbVY[k] * dt; dbZ[k] += dbVZ[k] * dt;
      if (dbY[k] < dbS[k] * 0.6 && dbVY[k] < 0) {
        // 落地弹一下，横向速度大幅衰减
        dbY[k] = dbS[k] * 0.6;
        dbVY[k] *= -0.3;
        dbVX[k] *= 0.45;
        dbVZ[k] *= 0.45;
      }
      dbR[k] += dt * 9;
      const f = dbL[k] / dbM[k], s = dbS[k] * Math.min(1, f * 4);
      _pe.set(dbR[k], dbR[k] * 0.7, 0);
      _pq.setFromEuler(_pe);
      mPose(dbX[k], dbY[k], dbZ[k], _pq, s, s, s);
      pfPut('debris', 0.55, 0.5, 0.48);
      // 刚飞出去的碎块带一点余烬
      if (f > 0.55 && Math.random() < 0.35) spawnP(dbX[k], dbY[k], dbZ[k], 0, 0.3, 0, rand(0.15, 0.3), 0.12, dbC[k * 3], dbC[k * 3 + 1], dbC[k * 3 + 2], -0.5, 2);
    }
  }
  function clearDebris() {
    dbL.fill(0);
    dbLive = 0;
  }
  // ----- 卡通碎块：尖片 / 星 / 烟团（实心、硬边，颜色分档跳变而不是渐隐；每种一个 InstancedMesh，环形缓冲，运行时不分配） -----
  // kind 0 尖片：顺着速度拉长的菱形，前 45% 是亮色 a、之后换成 b，最后 35% 缩没；
  //      1 星：四芒星，主色 b 垫底 + 亮芯 a，一出来就是八成大，先胀一下再缩没（顿帧时定格在画面上）；
  //      2 烟团：两层圆片（暗色 b 在下、亮色 a 在上偏左上，像打了光的一团），先胀后缩没，往上飘
  const CK_N = 192;
  const ckK = new Uint8Array(CK_N), ckP = new Float32Array(CK_N * 3), ckV = new Float32Array(CK_N * 3);
  const ckL = new Float32Array(CK_N), ckM = new Float32Array(CK_N), ckS = new Float32Array(CK_N), ckR = new Float32Array(CK_N), ckG = new Float32Array(CK_N);
  const ckA = new Float32Array(CK_N * 3), ckB = new Float32Array(CK_N * 3);
  let ckNext = 0, ckLive = 0;
  function tChunk(kind, x, y, z, vx, vy, vz, life, size, hexA, hexB, grav) {
    const i = ckNext, j = i * 3;
    ckNext = (ckNext + 1) % CK_N;
    ckK[i] = kind;
    ckP[j] = x; ckP[j + 1] = y; ckP[j + 2] = z;
    ckV[j] = vx; ckV[j + 1] = vy; ckV[j + 2] = vz;
    ckL[i] = ckM[i] = life;
    ckS[i] = size;
    ckR[i] = rand(0, TAU);
    ckG[i] = grav || 0;
    _c.set(hexA).convertSRGBToLinear();
    ckA[j] = _c.r; ckA[j + 1] = _c.g; ckA[j + 2] = _c.b;
    _c.set(hexB).convertSRGBToLinear();
    ckB[j] = _c.r; ckB[j + 1] = _c.g; ckB[j + 2] = _c.b;
    ckLive = 2;
  }
  function toonChunks(dt) {
    if (ckLive <= 0) return;
    let any = false;
    for (let i = 0; i < CK_N; i++) {
      let l = ckL[i];
      if (l <= 0) continue;
      l -= dt;
      ckL[i] = l;
      if (l <= 0) continue;
      any = true;
      const j = i * 3, k = ckK[i], f = 1 - l / ckM[i]; // f：0 出生 → 1 消失
      const dr = Math.max(0, 1 - (k === 2 ? 3.2 : 1.6) * dt);
      ckV[j + 1] -= ckG[i] * dt;
      ckV[j] *= dr; ckV[j + 1] *= k === 2 ? dr : 1; ckV[j + 2] *= dr;
      let y = ckP[j + 1] + ckV[j + 1] * dt;
      if (y < 0.06 && ckV[j + 1] < 0) {
        y = 0.06;
        ckV[j + 1] *= -0.25;
        ckV[j] *= 0.5;
        ckV[j + 2] *= 0.5;
      }
      ckP[j] += ckV[j] * dt;
      ckP[j + 1] = y;
      ckP[j + 2] += ckV[j + 2] * dt;
      const x = ckP[j], z = ckP[j + 2], s = ckS[i];
      if (k === 0) {
        const sh = f < 0.65 ? 1 : 1 - (f - 0.65) / 0.35;
        const sp = Math.hypot(ckV[j], ckV[j + 1], ckV[j + 2]);
        mStretch(x, y, z, ckV[j], ckV[j + 1], ckV[j + 2], s * 0.5 * sh, s * (1.3 + Math.min(1.2, sp * 0.12)) * sh);
        const c = f < 0.45 ? ckA : ckB;
        pfPut('tShard', c[j], c[j + 1], c[j + 2]);
      } else if (k === 1) {
        ckR[i] += dt * 3;
        const sc = s * (f < 0.25 ? 0.8 + 0.8 * f : 1 - (f - 0.25) / 0.75);
        _pq.copy(camQ).multiply(_pq2.setFromAxisAngle(Z_AXIS, ckR[i]));
        mPose(x, y, z, _pq, sc, sc, sc);
        pfPut('tStar', ckB[j], ckB[j + 1], ckB[j + 2]);
        _pq.multiply(_pq2.setFromAxisAngle(Z_AXIS, Math.PI / 4));
        mPose(x + camB.x * 0.04, y + camB.y * 0.04, z + camB.z * 0.04, _pq, sc * 0.55, sc * 0.55, sc * 0.55);
        pfPut('tStar', ckA[j], ckA[j + 1], ckA[j + 2]);
      } else {
        // 一小簇云：暗色的底垫在下面，上面三个亮色的圆鼓包（中间大、两边小），看着是一团烟而不是一颗石头
        const sc = s * (f < 0.3 ? 0.6 + (f / 0.3) * 0.4 : 1 - ((f - 0.3) / 0.7) * ((f - 0.3) / 0.7));
        const rx = Math.cos(ckR[i]) * sc, ry = Math.sin(ckR[i]) * sc * 0.25;
        mBill(x - camB.x * 0.03, y - sc * 0.12, z - camB.z * 0.03, sc * 0.9);
        pfPut('tPuff', ckB[j], ckB[j + 1], ckB[j + 2]);
        const ox = camB.x * 0.03, oy = camB.y * 0.03, oz = camB.z * 0.03;
        mBill(x + ox, y + sc * 0.1 + oy, z + oz, sc * 0.62);
        pfPut('tPuff', ckA[j], ckA[j + 1], ckA[j + 2]);
        mBill(x - rx * 0.5 + ox, y - ry + oy, z + oz, sc * 0.44);
        pfPut('tPuff', ckA[j], ckA[j + 1], ckA[j + 2]);
        mBill(x + rx * 0.5 + ox, y + ry - sc * 0.08 + oy, z + oz, sc * 0.4);
        pfPut('tPuff', ckA[j], ckA[j + 1], ckA[j + 2]);
      }
    }
    if (!any) ckLive--;
  }
  function clearChunks() {
    ckL.fill(0);
    ckLive = 0;
  }
  // 烟团（实心的两层圆片）：hexA 亮面、hexB 暗面
  function tPuffs(x, y, z, n, spread, up, life, size, hexA, hexB) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), v = spread * rand(0.4, 1);
      tChunk(2, x + Math.sin(a) * 0.15, y, z + Math.cos(a) * 0.15, Math.sin(a) * v, up * rand(0.6, 1.2), Math.cos(a) * v, life * rand(0.75, 1.15), size * rand(0.75, 1.2), hexA, hexB, -0.5);
    }
  }
  // 陨石尾焰：顺着下落方向拉长的大火舌（陨石的位置在 updateMeteors 里算好）
  function meteorFlames(dt) {
    for (let i = 0; i < meteors.length; i++) {
      const m = meteors[i];
      if (!m.on) continue;
      const p = m.mesh.position, t = m.t * 1.7 + i;
      // 下落方向（常量）：(6, -25.5, 9)
      const dx = 0.2159, dy = -0.9175, dz = 0.3238;
      ribHead(m.rib, p.x, p.y, p.z, dt);
      mStretch(p.x + dx * 0.3, p.y + dy * 0.3, p.z + dz * 0.3, dx, dy, dz, 1.3, 2.6 * (1 + 0.15 * Math.sin(t * 30)));
      pfPut('flame', m.lr * 0.5 + 0.5, m.lg * 0.5 + 0.4, m.lb * 0.5 + 0.15);
      for (let k = 0; k < 3; k++) {
        const o = (k - 1) * 0.28;
        mStretch(p.x + o, p.y + 0.1, p.z - o * 0.3, dx, dy, dz, 1.1, (3.6 + 1.2 * Math.sin(t * 23 + k * 2)) * (k === 1 ? 1.2 : 0.9));
        pfPut('flame', m.lr, m.lg * 0.85, m.lb * 0.7);
      }
      m.sm += dt;
      if (m.sm > 0.035) {
        m.sm = 0;
        spawnS(p.x - dx * 0.8 + rand(-0.2, 0.2), p.y - dy * 0.8, p.z - dz * 0.8 + rand(-0.2, 0.2), rand(-0.3, 0.3), rand(0, 0.6), rand(-0.3, 0.3), rand(0.5, 0.8), rand(0.6, 0.9), 0.1, 0.08, 0.07, 0.5);
        smokeLive = 1.2;
      }
    }
  }
  // 没走实例化的投射物（魂灵）：头尾左右摇曳，拖一串往上浮的魂火屑和一条魂尾
  function legacyProj(m, u, p, dt) {
    if (u.seek) {
      const dx = p.x - u.lx, dz = p.z - u.lz;
      if (dx * dx + dz * dz > 1e-6) m.rotation.y = Math.atan2(dx, dz);
      u.lx = p.x;
      u.lz = p.z;
    } else {
      m.rotation.x += dt * 7;
      m.rotation.y += dt * 9;
    }
    u.acc += dt;
    if (u.wisp) {
      // 刚放出时从幡头的高度落下来（前 0.3 秒），像是从幡上飞出去的
      u.ph += dt * 13;
      u.age += dt;
      const lift = u.age < 0.3 ? (1 - u.age / 0.3) * (1 - u.age / 0.3) * 1.1 : 0;
      u.wisp.rotation.y = Math.sin(u.ph) * 0.35;
      u.wisp.position.y = lift + Math.sin(u.ph * 0.5) * 0.08;
      if (p.y > -10 && u.rib >= 0) ribHead(u.rib, p.x, p.y + u.wisp.position.y, p.z, dt);
      if (u.acc > 0.03 && p.y > -10) {
        u.acc = 0;
        const wh = Math.random() < 0.3 ? 0.5 : 0;
        spawnP(p.x + rand(-0.08, 0.08), p.y + rand(-0.05, 0.1), p.z + rand(-0.08, 0.08), rand(-0.3, 0.3), rand(0.4, 1.4), rand(-0.3, 0.3), rand(0.3, 0.5), rand(0.14, 0.22), u.r + (1 - u.r) * wh, u.g + (1 - u.g) * wh, u.b + (1 - u.b) * wh, -1, 1.5);
      }
      return;
    }
    if (u.acc > 0.028 && p.y > -10) {
      u.acc = 0;
      spawnP(p.x + rand(-0.1, 0.1), p.y + rand(-0.1, 0.1), p.z + rand(-0.1, 0.1), rand(-0.6, 0.6), rand(-0.2, 0.8), rand(-0.6, 0.6), rand(0.2, 0.36), u.rad * 2.2, u.r * 0.8, u.g * 0.8, u.b * 0.8, -0.5, 1);
    }
  }
  // 每帧：投射物本体 + 陨石尾焰 + 碎石，写进实例缓冲；拖尾带子重建
  function updateProjFx(dt) {
    pfBegin();
    for (let i = 0; i < projObjs.length; i++) {
      const m = projObjs[i], u = m.userData;
      if (u.vfx) pfDraw(m, u, m.position, dt);
      else legacyProj(m, u, m.position, dt);
    }
    meteorFlames(dt);
    updateDebris(dt);
    rangedPfDraw(dt);
    pyrePfDraw(dt);
    toonChunks(dt);
    pfEnd();
    updateRibbons(dt);
  }
  // 预热：每种零件各摆一个，让 warmEntities 那一帧把着色器编译掉
  function warmProjFx(on) {
    for (let i = 0; i < PF_LIST.length; i++) {
      const p = PF_LIST[i];
      p.n = on ? 1 : 0;
      _pm.makeTranslation(0, 1, 2);
      if (on) p.mesh.setMatrixAt(0, _pm);
    }
    if (on) {
      camQ.copy(camera.quaternion);
      camB.set(0, 0, 1).applyQuaternion(camQ);
    }
    pfEnd();
    rbMesh.visible = on;
  }
  function clearProjFx() {
    clearRibbons();
    clearDebris();
    clearChunks();
    rangedClear();
    for (let i = 0; i < PF_LIST.length; i++) PF_LIST[i].n = 0;
    pfEnd();
  }

  // =====================================================================
  // 远程武器的特效：枪口焰、弹壳、曳光弹、箭（追踪 / 元素 / 燃箭）、喷火、燃烧的地面、熔光射线、焚天炎爆、乱射、弓的增益光环。
  // 大多由玩家身上正在播的动作（fire_<type> / r_<type>）自动驱动；game.js 也可以直接调这些接口（都可选，不调也有画面）：
  //   W.emberGround(x, z, r, dur)    地上一片燃烧的余烬（喷枪留下的火、焚天炎爆的火海）
  //   W.fireNova(x, z, R)            焚天炎爆的火浪（不调时 r_flamer 的出手帧自动放一次）
  //   W.laser(x, z, dx, dz, len)     熔光射线这一帧的起点 / 方向 / 长度（每帧调；不调时 r_gatling 播放期间沿枪口方向自动画）
  //   W.rangedBuff(type, dur)        弓的 R 增益光环（type = huntbow / eagle / runebow / emberbow，null 关掉；不调时 r_<弓> 自动开 8 秒）
  //   W.gunTracer(x0, z0, x1, z1)    一发瞬时弹道（乱射）；W.muzzle(ent) 枪口焰
  // 投射物外形（G.spawnProjectile 的 vk）：bullet 机炮曳光弹 / slug 左轮重弹 / arrow 箭（tint 给元素色）/ emberarrow 烬铸燃箭 / flamelet 火团；
  // 普攻弹丸不写 vk 时，按手里的武器自动认
  // =====================================================================
  const RANGED_PF = { bullet: 1, slug: 1, arrow: 1, emberarrow: 1, flamelet: 1 };
  const GUN_KIND = { gatling: 'bullet', revolver: 'slug', flamer: 'flamelet', huntbow: 'arrow', eagle: 'arrow', runebow: 'arrow', emberbow: 'emberarrow' };
  const BUFF_HEX = { huntbow: 0x6fe8b0, eagle: 0xffd75e, runebow: 0xc9a6ff, emberbow: 0x3a9cff }; // 冰弓压深一点：加法混合 + 泛光之后仍是冰蓝，不发白
  const RF = {
    muz: [], puffs: [], fires: [], shells: [], tracers: [],
    laser: { ext: -1, x: 0, z: 0, dx: 0, dz: 1, len: 0, scorch: 0 },
    buff: { type: null, t: 0, dur: 0, set: -9, acc: 0 },
    spray: 0, novaK: -1, novaSet: -9, groundAt: -9, projAt: -9, fireAt: -9, flameAcc: 0, gaugeT: 0, gaugeFull: false, gaugeK: 0, groundAuto: 0,
  };
  const _rs = { x: 0, y: 0, z: 0 }, _rs2 = { x: 0, y: 0, z: 0 }, _rf = { x: 0, y: 0, z: 0 };
  const _qFlat = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), -Math.PI / 2);
  const laserTex = () =>
    tex('laser', () => {
      const c = makeCanvas(64, 8), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 64, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.28, 'rgba(255,255,255,0.18)');
      gr.addColorStop(0.44, 'rgba(255,255,255,0.85)');
      gr.addColorStop(0.5, 'rgba(255,255,255,1)');
      gr.addColorStop(0.56, 'rgba(255,255,255,0.85)');
      gr.addColorStop(0.72, 'rgba(255,255,255,0.18)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 8);
      return new T.CanvasTexture(c);
    });
  function rangedPfInit(add, vc, flameQuad, quad) {
    const arrowGeo = bake('fx/arrowZ', [
      [gCyl(0.014, 0.014, 0.78, 4), 0xd8b888, 0, 0, -0.3, HALF_PI],
      [gCone(0.042, 0.14, 4), 0xffffff, 0, 0, 0.15, HALF_PI],
      [gBox(0.1, 0.012, 0.16), 0xf0e8d8, 0, 0, -0.6],
      [gBox(0.012, 0.1, 0.16), 0xf0e8d8, 0, 0, -0.6],
    ]);
    pfPart('arrow', arrowGeo, vc, 96, 0);
    pfPart('beam', quad, add(laserTex(), T.DoubleSide), 200, 6);
    pfPart('casing', gCyl(0.014, 0.014, 0.048, 6), pfSolid, 64, 0);
    pfPart('ringF', geo('fxRingThin', () => new T.TorusGeometry(1, 0.035, 3, 40)), add(null, T.DoubleSide), 24, 4);
  }
  const pEnt = () => {
    const e = G.player && G.player.ent;
    return e && !e.removed && !e.dying ? e : null;
  };
  const clipNm = (e) => (e && e.clip ? e.clip.name : '');
  // 武器关节 +z（枪管 / 武器指向）在世界里的方向，压平到地面
  function weaponFwd(ent, out) {
    const s = ent.sock.weapon, M = ent.mdl, m = s.j * 12, g = ent.group;
    const x = M[m + 2], z = M[m + 10], sn = Math.sin(g.rotation.y), cs = Math.cos(g.rotation.y);
    let wx = x * cs + z * sn, wz = z * cs - x * sn;
    const l = Math.hypot(wx, wz);
    if (l < 1e-4) { wx = sn; wz = cs; } else { wx /= l; wz /= l; }
    out.x = wx; out.y = 0; out.z = wz;
    return out;
  }
  // 元素色 → 元素（箭的拖尾 / 命中花样）
  function elemOf(r, g, b) {
    if (b > 0.7 && b > r + 0.1) return 'cold';
    if (r > 0.75 && g > 0.7 && b < 0.6) return 'light';
    if (r > 0.75 && g < 0.62) return 'fire';
    return null;
  }
  function rangedAutoKind(kind) {
    const ent = pEnt();
    if (!ent || !ent.gearVar || !GUN_KIND[ent.gearVar]) return kind;
    const nm = clipNm(ent);
    if (nm.indexOf('fire_') === 0 || nm.indexOf('r_') === 0 || wtime - RF.fireAt < 0.3) return GUN_KIND[ent.gearVar];
    return kind;
  }
  function muzzleAdd(x, y, z, dx, dz, s, hex) {
    if (RF.muz.length >= 24) RF.muz.shift();
    RF.muz.push({ x, y, z, dx, dz, t: 0, dur: 0.06 + 0.02 * s, s, hex, rot: rand(0, TAU) });
    _c.set(hex);
    for (let i = 0; i < 3; i++) spawnP(x, y, z, dx * rand(4, 8) + rand(-1, 1), rand(-0.3, 1.2), dz * rand(4, 8) + rand(-1, 1), rand(0.06, 0.14), 0.09, 1, 0.85, 0.5, 2, 6);
    flashLight(x, y + 0.4, z, hex, 0.9 * s);
  }
  function shellAdd(ent, dx, dz, big) {
    W.entSocket(ent, 'hand', _rs2);
    W.entSocket(ent, 'weapon', _rs);
    const x = _rs2.x + (_rs.x - _rs2.x) * 0.25, z = _rs2.z + (_rs.z - _rs2.z) * 0.25, y = _rs2.y + 0.15;
    if (RF.shells.length >= 60) RF.shells.shift();
    const rv = rand(1.6, 2.6);
    RF.shells.push({ x, y, z, vx: -dz * rv - dx * 0.4, vy: rand(2.2, 3.6), vz: dx * rv - dz * 0.4, t: 0, a: rand(0, TAU), w: rand(14, 24), big: !!big, rest: false });
  }
  W.muzzle = function (ent, s, hex) {
    ent = ent || pEnt();
    if (!ent) return;
    W.entSocket(ent, 'weapon', _rs);
    weaponFwd(ent, _rf);
    muzzleAdd(_rs.x, _rs.y, _rs.z, _rf.x, _rf.z, s || 1, hex === undefined ? 0xffc060 : hexOf(hex));
  };
  function rangedOnSpawn(kind, u) {
    RF.projAt = wtime;
    const ent = pEnt();
    if (u.tinted) u.el = elemOf(u.tr, u.tg, u.tb);
    else u.el = kind === 'arrow' ? elemOf(u.r, u.g, u.b) : null;
    if (!ent || u.hostile) return;
    const P = G.player;
    W.entSocket(ent, 'weapon', _rs);
    // 弹丸从枪口出来：画的位置前 0.1 秒从枪口滑到真正的弹道上
    if (kind === 'bullet' || kind === 'slug' || kind === 'flamelet') {
      u.ox = _rs.x - P.x; u.oz = _rs.z - P.z; u.oy = _rs.y - 1.1;
    } else {
      W.entSocket(ent, 'handL', _rs2);
      u.ox = _rs2.x - P.x; u.oz = _rs2.z - P.z; u.oy = _rs2.y - 1.1;
    }
    if (kind === 'bullet' || kind === 'slug') {
      const big = kind === 'slug';
      muzzleAdd(_rs.x, _rs.y, _rs.z, u.dx, u.dz, big ? 1.35 : 0.9, big ? 0xff9a40 : 0xffc060);
      if (!big || Math.random() < 0.5) shellAdd(ent, u.dx, u.dz, big);
    } else if (kind === 'arrow' || kind === 'emberarrow') {
      // 寒冰箭的出手闪光小一号：凛冬一次三支，三团闪光叠在一起会糊成白
      flare(_rs2.x, _rs2.y, _rs2.z, kind === 'emberarrow' ? 0x3a9cff : u.tinted ? u.hex : 0xfff0d0, kind === 'emberarrow' ? 0.3 : 0.5, 0.06);
    }
  }
  // 地上一片燃烧的余烬
  W.emberGround = function (x, z, r, dur, big) {
    RF.groundAt = wtime;
    if (RF.fires.length >= 28) RF.fires.shift();
    r = Math.max(0.4, r || 1);
    dur = dur || 3;
    RF.fires.push({ x, z, r, t: 0, dur, seed: rand(0, 100), acc: 0, big: !!big });
    W.decal(1, x, z, r * 1.05, rand(0, TAU), 0x2a1408, dur + 1.2);
  };
  // 焚天炎爆：脚下炸开一圈火浪，往外推开的火团 + 地上留一大片火
  W.fireNova = function (x, z, R) {
    RF.novaSet = wtime;
    R = R || 5.5;
    W.ring(x, z, R, 0xff7a2c, 0.5);
    W.ring(x, z, R * 0.6, 0xffd08a, 0.35);
    W.decal(1, x, z, R * 0.9, rand(0, TAU), 0x2a1408, 5);
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.05, 0.05), v = R / 0.5 * rand(0.85, 1.05);
      puffAdd(x + Math.sin(a) * 0.5, 0.45, z + Math.cos(a) * 0.5, Math.sin(a) * v, rand(0.2, 1.0), Math.cos(a) * v, rand(0.42, 0.55), rand(0.32, 0.5), 1);
    }
    for (let i = 0; i < 40; i++) {
      const a = rand(0, TAU), v = rand(3, 9);
      spawnP(x, 0.6, z, Math.sin(a) * v, rand(2, 7), Math.cos(a) * v, rand(0.5, 1.0), rand(0.12, 0.22), 1, rand(0.4, 0.75), 0.12, 6, 1.2);
    }
    flare(x, 1, z, 0xff8a3c, 3.2, 0.2);
    flashLight(x, 2.4, z, 0xff7a2c, 3);
    W.shake(0.45);
    // 留在地上的火海（game.js 自己放了就不重复）
    RF.groundAuto = { x, z, R, at: wtime + 0.08 };
  };
  // opt.charge（0..1）：蓄力中，只画一道细的瞄准线和枪口越聚越亮的光团；opt.w：射线粗细倍数（放出那一下粗，随后收细）
  W.laser = function (x, z, dx, dz, len, opt) {
    const L = RF.laser, l = Math.hypot(dx, dz) || 1;
    L.ext = wtime + 0.12;
    L.x = x; L.z = z; L.dx = dx / l; L.dz = dz / l; L.len = len || 0;
    L.charge = opt && opt.charge !== undefined ? opt.charge : -1;
    const w = opt && opt.w !== undefined ? opt.w : 1;
    if (L.charge < 0 && w > 1.5 && !(L.w > 1.5)) {
      // 放出的那一下：枪口一圈冲击 + 终点炸开
      W.ring(x, z, 1.6 + w * 0.4, 0xffb36a, 0.25);
      W.fovKick && W.fovKick(2.5);
    }
    L.w = L.charge >= 0 ? 0 : w;
  };
  W.rangedBuff = function (type, dur) {
    const B = RF.buff;
    B.type = type && BUFF_HEX[type] ? type : type === 'bow' ? 'eagle' : null;
    B.t = 0;
    B.dur = dur > 0 ? dur : 8;
    B.set = wtime;
  };
  W.gunTracer = function (x0, z0, x1, z1, y, hex) {
    if (RF.tracers.length >= 40) RF.tracers.shift();
    // hex 给了才按它上色（冰弓的冰晶连跳）；不给时照旧是枪火的琥珀色
    RF.tracers.push({ x0, y0: y || 1.25, z0, x1, y1: (y || 1.25) - 0.15, z1, t: 0, dur: 0.09, hex: hex === undefined ? 0xffb050 : hexOf(hex), tint: hex !== undefined });
  };
  // 量表灌满的那一刻：武器上一圈亮光 + 往上迸的火星（热度橙 / 专注青绿）
  W.gaugeFull = function (ent, kind) {
    ent = ent || pEnt();
    if (!ent) return;
    const hex = kind === 'heat' ? 0xff9a40 : 0x9fe8b0;
    W.entSocket(ent, 'weapon', _rs);
    flare(_rs.x, _rs.y, _rs.z, hex, 1.6, 0.16);
    W.ring(G.player.x, G.player.z, 1.4, hex, 0.35);
    _c.set(hex);
    for (let i = 0; i < 14; i++) spawnP(_rs.x, _rs.y, _rs.z, rand(-1.5, 1.5), rand(1.5, 3.5), rand(-1.5, 1.5), rand(0.35, 0.6), rand(0.08, 0.13), _c.r, _c.g, _c.b, 3, 1.2);
  };
  // 左轮装填：转轮甩出来转一圈（转轮一路连跳），掉几枚空弹壳
  W.reload = function (ent, t) {
    ent = ent || pEnt();
    if (!ent || ent.gearType !== G_REV) return;
    ent.revTurn = (ent.revTurn || 0) + 6;
    const f = G.player.face || 0;
    for (let i = 0; i < 3; i++) shellAdd(ent, Math.sin(f), Math.cos(f), true);
  };
  // 熔芯弹的小爆炸（命中处炸一团火）
  W.coreBlast = function (x, z, r) {
    W.ring(x, z, r, 0xff8a3c, 0.3);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU, v = r / 0.4;
      puffAdd(x, 0.7, z, Math.sin(a) * v, rand(0.5, 1.5), Math.cos(a) * v, rand(0.3, 0.4), rand(0.25, 0.4), 1);
    }
    flare(x, 1, z, 0xff8a3c, 1.6, 0.12);
    flashLight(x, 1.8, z, 0xff7a2c, 1.4);
  };
  // 喷火（没有 fire_flamer 动作时 game.js 才调）：沿 aim 喷一把火团
  W.flameCone = function (x, z, aim, R, arc, dur) {
    const sp = 10, n = 8;
    for (let i = 0; i < n; i++) {
      const a = aim + ((rand(-0.5, 0.5) * (arc || 60)) / 180) * Math.PI, v = sp * rand(0.85, 1.1);
      puffAdd(x + Math.sin(aim) * 0.6, 1.1, z + Math.cos(aim) * 0.6, Math.sin(a) * v, rand(-0.3, 0.5), Math.cos(a) * v, ((R || 5) / sp) * rand(0.8, 1.05), rand(0.55, 0.85), 0);
    }
  };
  // 元素满溢的命中小爆炸：按元素换花样
  const BURST_EL = { fire: [0xff7a2c, 1], cold: [0x86d8ff, 2], light: [0xffe45e, 3] };
  W.elemBurst = function (x, z, R, type) {
    const b = BURST_EL[type] || [0xffffff, 5], hex = b[0];
    W.ring(x, z, R, hex, 0.28);
    W.decal(b[1], x, z, R * 0.6, rand(0, TAU), hex, 1.2);
    _c.set(hex);
    for (let i = 0; i < 16; i++) {
      const a = rand(0, TAU), v = rand(2.5, 5.5);
      spawnP(x, 0.9, z, Math.sin(a) * v, rand(0.5, 3.5), Math.cos(a) * v, rand(0.2, 0.4), rand(0.12, 0.2), _c.r, _c.g, _c.b, type === 'cold' ? 6 : 2, 3);
    }
    if (type === 'fire') for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; puffAdd(x, 0.6, z, Math.sin(a) * 4, 1, Math.cos(a) * 4, 0.3, 0.3, 1); }
    if (type === 'light') W.bolt([{ x, z }, { x: x + rand(-R, R), z: z + rand(-R, R) }], hex);
    flare(x, 1, z, hex, 1.3, 0.1);
  };
  // 冰弓（凛羽）的冰晶连跳：一枚冰晶从 A 划一道弧落到 B
  // 弧线是一串冷蓝的冰晶点（越往落点越亮），落点一记小小的冷光、一圈霜环和几粒冰屑
  W.emberSpark = function (x0, z0, x1, z1) {
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const k = i / n, h = Math.sin(k * Math.PI) * 1.1;
      spawnP(x0 + (x1 - x0) * k, 1.0 + h, z0 + (z1 - z0) * k, rand(-0.3, 0.3), rand(-0.2, 0.4), rand(-0.3, 0.3), 0.18 + k * 0.2, 0.11 + 0.04 * Math.sin(k * 3), 0.18 + 0.2 * k, 0.5 + 0.25 * k, 1, 3, 2);
    }
    W.gunTracer(x0, z0, x1, z1, 1.1, 0x3a9cff);
    flare(x1, 1.0, z1, 0x2f8ee8, 0.75, 0.09);
    W.ring(x1, z1, 0.6, 0x2f8ee8, 0.2);
    for (let i = 0; i < 6; i++) {
      const a = rand(0, TAU), v = rand(1.5, 3.5), w = i === 0;
      spawnP(x1, 1.0, z1, Math.sin(a) * v, rand(0.5, 2.5), Math.cos(a) * v, rand(0.2, 0.4), w ? 0.09 : rand(0.05, 0.09), w ? 0.8 : 0.28, w ? 0.93 : 0.65, 1, 9, 2);
    }
  };
  // 凛冬的碎尸冰爆：一圈冰霜 + 四散的冰碴
  // 颜色都压在深一点的冰蓝上（加法混合 + 泛光会把浅色推成白）：外圈霜环、内圈一记冷光、地上留一片霜花，
  // 冰碴大多是冰蓝、少数亮白，贴地一层慢慢散开的淡蓝霜雾
  W.frostBlast = function (x, z, R) {
    W.ring(x, z, R, 0x2f8ee8, 0.3);
    W.ring(x, z, R * 0.55, 0x6cc0ff, 0.18);
    W.decal(2, x, z, R * 0.7, rand(0, TAU), 0x2466c8, 1.2);
    flare(x, 1.0, z, 0x2f8ee8, 1.0 + R * 0.25, 0.12);
    flashLight(x, 2, z, 0x3a8ce8, 0.7);
    for (let i = 0; i < 18; i++) {
      const a = rand(0, TAU), v = rand(2, 5) * Math.max(0.6, R / 2.5), w = i % 5 === 0;
      spawnP(x, 1.0, z, Math.sin(a) * v, rand(1, 4), Math.cos(a) * v, rand(0.35, 0.7), w ? rand(0.1, 0.14) : rand(0.06, 0.12), w ? 0.8 : 0.24, w ? 0.93 : 0.6, 1, 12, 2.5);
    }
    for (let i = 0; i < 8; i++) {
      const a = rand(0, TAU), d = rand(0, R * 0.6);
      spawnP(x + Math.sin(a) * d, 0.3, z + Math.cos(a) * d, 0, rand(0.2, 0.6), 0, rand(0.6, 1.1), rand(0.3, 0.5), 0.1, 0.26, 0.5, -0.3, 1.2);
    }
    return true;
  };
  W.rangedInfo = () => ({
    muzzle: RF.muz.length, puffs: RF.puffs.length, fires: RF.fires.length, shells: RF.shells.length, tracers: RF.tracers.length,
    laser: RF.laser.ext >= wtime || clipNm(pEnt()) === 'r_gatling', buff: RF.buff.type, spin: (pEnt() && pEnt().gunSpin) || 0,
  });
  function puffAdd(x, y, z, vx, vy, vz, life, s, wave) {
    if (RF.puffs.length >= 220) RF.puffs.shift();
    RF.puffs.push({ x, y, z, vx, vy, vz, t: 0, life, s, ph: rand(0, TAU), wave: wave || 0 });
  }
  // 动作开始播放的那一刻（W.play 包了一层）：记下开火时刻，弓的 R 自动开光环、喷枪的 R 记下出手帧
  function rangedOnPlay(ent, name, opts) {
    if (name.indexOf('fire_') === 0) {
      RF.fireAt = wtime;
      if (name === 'fire_revolver') ent.revTurn = (ent.revTurn || 0) + 1;
      return;
    }
    if (name.indexOf('r_') !== 0 && name.indexOf('w_') !== 0) return;
    const t = name.slice(2);
    if (BUFF_HEX[t] || t === 'bow') {
      if (wtime - RF.buff.set > 0.3) W.rangedBuff(t, 8);
      flare(G.player.x, 2.1, G.player.z, BUFF_HEX[t] || 0xffd75e, 2.2, 0.18);
    } else if (t === 'flamer') RF.novaK = 0;
  }
  {
    const play0 = W.play;
    W.play = function (ent, name, opts) {
      const ok = play0(ent, name, opts);
      if (ok && ent && ent.kind === 'player' && typeof name === 'string' && ent === pEnt()) rangedOnPlay(ent, name, opts);
      return ok;
    };
  }
  function rangedClear() {
    RF.muz.length = RF.puffs.length = RF.fires.length = RF.shells.length = RF.tracers.length = 0;
    RF.buff.type = null;
    RF.laser.ext = -1;
    RF.groundAuto = 0;
  }
  // 机炮的转膛（开火时 0.5 秒左右转起来）、左轮每发转一格
  function gunSpinPost(ent, o, sdt) {
    const g = ent.gearType;
    if (g !== G_GAT && g !== G_REV) return;
    const J = ent.rig.J, nm = clipNm(ent);
    if (g === G_GAT) {
      const want = nm === 'fire_gatling' ? 32 : nm === 'r_gatling' ? 44 : 0, v = ent.gunSpin || 0;
      ent.gunSpin = v + (want - v) * Math.min(1, sdt * (want > v ? 2.4 : 1.2));
      if (ent.gunSpin < 0.05 && !want) ent.gunSpin = 0;
      ent.gunAng = ((ent.gunAng || 0) + ent.gunSpin * sdt) % TAU;
      o[J.wGb + 2] = ent.gunAng;
    } else {
      const tgt = ((ent.revTurn || 0) * TAU) / 6, cur = ent.gunAng || 0;
      ent.gunAng = cur + (tgt - cur) * Math.min(1, sdt * 22);
      o[J.wGb + 2] = ent.gunAng;
    }
  }

  // ----- 投射物外形 -----
  // 弹丸画的位置：出生后 0.1 秒内从枪口（或弓）滑到真正的弹道上
  function rOff(u, x, y, z) {
    const k = Math.max(0, 1 - u.age / 0.1);
    _rs.x = x + u.ox * k; _rs.y = y + u.oy * k; _rs.z = z + u.oz * k;
    return _rs;
  }
  PF_DRAW.bullet = function (u, x, y, z, dt) {
    const p = rOff(u, x, y, z), L = 0.95;
    mStretch(p.x - u.dx * L * 0.5, p.y, p.z - u.dz * L * 0.5, u.dx, 0, u.dz, 0.075, L);
    pfPut('beam', 1.7, 1.2, 0.55);
    mPose(p.x, p.y, p.z, _pqI, 0.03, 0.03, 0.03);
    pfPut('core', 1.2, 1.1, 0.8);
    mBill(p.x, p.y, p.z, 0.45);
    pfPut('glow', 0.9, 0.55, 0.18);
  };
  PF_DRAW.slug = function (u, x, y, z, dt) {
    const p = rOff(u, x, y, z), L = 1.4;
    mStretch(p.x - u.dx * L * 0.5, p.y, p.z - u.dz * L * 0.5, u.dx, 0, u.dz, 0.13, L);
    pfPut('beam', 1.9, 0.95, 0.35);
    mStretch(p.x - u.dx * 0.25, p.y, p.z - u.dz * 0.25, u.dx, 0, u.dz, 0.05, 0.5);
    pfPut('beam', 2, 1.8, 1.4);
    mPose(p.x, p.y, p.z, _pqI, 0.045, 0.045, 0.045);
    pfPut('core', 1.3, 1.0, 0.7);
    mBill(p.x, p.y, p.z, 0.8);
    pfPut('glow', 1.0, 0.45, 0.12);
    u.acc += dt;
    if (u.acc > 0.03) {
      u.acc = 0;
      spawnP(p.x, p.y, p.z, rand(-0.5, 0.5), rand(0.2, 1), rand(-0.5, 0.5), rand(0.15, 0.3), 0.08, 1, 0.55, 0.2, -0.5, 2);
    }
  };
  const EL_HEX = { fire: [1, 0.42, 0.1], cold: [0.5, 0.85, 1], light: [1, 0.92, 0.35] };
  // tint（可选）：[r, g, b] 乘在箭身的顶点色上（冰弓的寒冰箭是霜钢箭杆、淡蓝箭羽）
  function arrowBody(u, p, k, tint) {
    _pq.setFromAxisAngle(UP, Math.atan2(u.dx, u.dz));
    mPose(p.x, p.y, p.z, _pq, k, k, k);
    if (tint) pfPut('arrow', tint[0], tint[1], tint[2]);
    else pfPut('arrow', 1, 1, 1);
  }
  const ICE_ARROW = [0.42, 0.62, 0.95];
  PF_DRAW.arrow = function (u, x, y, z, dt) {
    const p = rOff(u, x, y, z);
    arrowBody(u, p, 1);
    const hx = p.x + u.dx * 0.2, hz = p.z + u.dz * 0.2, e = u.el && EL_HEX[u.el];
    if (e) {
      mBill(hx, p.y, hz, 0.7);
      pfPut('glow', e[0] * 0.9, e[1] * 0.9, e[2] * 0.9);
      u.acc += dt;
      if (u.el === 'fire') {
        flameTongue(u, hx, p.y, hz, Math.sin(u.age * 30) * 0.2, 0.16, 0.42 + 0.1 * Math.sin(u.age * 41), 0.9, 0.3, 0.05, 'flameN');
      } else if (u.el === 'light' && hash2(Math.floor(u.age * 30), 7) < 0.6) {
        _pq.copy(camQ).multiply(_pq2.setFromAxisAngle(Z_AXIS, rand(0, TAU)));
        mPose(hx, p.y, hz, _pq, 0.5, 0.18, 1);
        pfPut('arc', 1.2, 1.05, 0.45);
      }
      if (u.acc > 0.035) {
        u.acc = 0;
        spawnP(hx, p.y, hz, rand(-0.4, 0.4), rand(-0.1, 0.6), rand(-0.4, 0.4), rand(0.18, 0.32), 0.1, e[0], e[1], e[2], u.el === 'cold' ? 0.6 : -0.6, 2);
      }
    } else {
      mBill(hx, p.y, hz, 0.35);
      pfPut('glow', 0.5, 0.48, 0.4);
    }
  };
  PF_DRAW.emberarrow = function (u, x, y, z, dt) {
    // 凛羽的寒冰箭：箭头套着一枚冰棱（尖朝前、绕箭杆慢慢滚转），外面一层冷光，身后拖着冰雾和细碎的冰晶（偶尔一粒亮白的冰闪）
    const p = rOff(u, x, y, z);
    arrowBody(u, p, 1.1, ICE_ARROW);
    const hx = p.x + u.dx * 0.22, hz = p.z + u.dz * 0.22;
    _pq.setFromAxisAngle(UP, Math.atan2(u.dx, u.dz)).multiply(_pq2.setFromAxisAngle(Z_AXIS, u.age * 7 + (u.ph || 0)));
    mPose(hx + u.dx * 0.05, p.y + 0.02, hz + u.dz * 0.05, _pq, 0.1, 0.1, 0.17);
    pfPut('shard', 0.5, 0.8, 1);
    mBill(hx, p.y, hz, 0.95);
    pfPut('glow', 0.07, 0.3, 0.85);
    u.acc += dt;
    while (u.acc > 0.025) {
      u.acc -= 0.025;
      const w = Math.random() < 0.15;
      spawnP(hx - u.dx * 0.3 + rand(-0.08, 0.08), p.y + rand(-0.05, 0.1), hz - u.dz * 0.3 + rand(-0.08, 0.08), rand(-0.6, 0.6) - u.dx, rand(-0.3, 0.6), rand(-0.6, 0.6) - u.dz, rand(0.3, 0.55), w ? 0.09 : rand(0.05, 0.09),
        w ? 0.75 : 0.22, w ? 0.9 : 0.58, 1, 2, 1.5);
    }
  };
  PF_DRAW.flamelet = function (u, x, y, z, dt) {
    const p = rOff(u, x, y, z), s = 0.25 + Math.min(1, u.age * 3) * 0.55;
    mStretch(p.x, p.y, p.z, u.dx, 0, u.dz, s * 1.3, s * 2.2);
    pfPut('flameN', 0.95, 0.38, 0.06);
    mStretch(p.x, p.y, p.z, u.dx, 0, u.dz, s * 0.8, s * 1.4);
    pfPut('flame', 0.9, 0.55, 0.2);
    mBill(p.x, p.y, p.z, s * 2.4);
    pfPut('glow', 0.6, 0.22, 0.04);
  };
  {
    const impact0 = W.projImpact;
    W.projImpact = function (mesh, x, z, how, R) {
      const u = mesh && mesh.userData, vk = u && u.vfx;
      if (!vk || !RANGED_PF[vk]) return impact0(mesh, x, z, how, R);
      const y = 1.1;
      if (vk === 'bullet' || vk === 'slug') {
        const big = vk === 'slug';
        for (let i = 0; i < (big ? 9 : 4); i++) {
          const a = Math.atan2(-u.dx, -u.dz) + rand(-1.1, 1.1), v = rand(3, 7);
          spawnP(x, y, z, Math.sin(a) * v, rand(0.5, 3.5), Math.cos(a) * v, rand(0.08, 0.2), rand(0.06, 0.11), 1, 0.8, 0.4, 9, 3);
        }
        flare(x, y, z, big ? 0xffa050 : 0xffe0a0, big ? 0.9 : 0.45, 0.06);
        if (how === 'wall') W.decal(0, x - u.dx * 0.2, z - u.dz * 0.2, 0.35, Math.atan2(u.dx, u.dz), 0xffd0a0, 0.3, 0.08);
        return true;
      }
      if (vk === 'flamelet') {
        for (let i = 0; i < 5; i++) spawnP(x, y, z, rand(-1.5, 1.5), rand(0.5, 2), rand(-1.5, 1.5), rand(0.2, 0.4), rand(0.15, 0.25), 1, rand(0.35, 0.6), 0.08, -1, 2);
        return true;
      }
      if (vk === 'emberarrow') {
        const r = how === 'blast' ? R || 1.4 : 0.9;
        // 冰屑四溅 + 一圈冷蓝的霜环；只有少数几粒是亮白的冰闪，泛光之后整体仍是冰蓝
        W.ring(x, z, r, 0x2f8ee8, 0.22);
        flare(x, y, z, 0x2f8ee8, 0.7 + r * 0.25, 0.08);
        for (let i = 0; i < 10; i++) {
          const a = rand(0, TAU), v = rand(1.5, 4), w = i < 2;
          spawnP(x, y, z, Math.sin(a) * v, rand(0.3, 2.5), Math.cos(a) * v, rand(0.2, 0.4), w ? 0.1 : rand(0.05, 0.1), w ? 0.8 : 0.25, w ? 0.92 : 0.62, 1, 10, 2);
        }
        return true;
      }
      // 箭：木屑 + 元素的小爆
      const e = u.el && EL_HEX[u.el];
      for (let i = 0; i < 5; i++) {
        const a = Math.atan2(-u.dx, -u.dz) + rand(-1, 1), v = rand(2, 4.5);
        spawnP(x, y, z, Math.sin(a) * v, rand(0.5, 2.5), Math.cos(a) * v, rand(0.2, 0.4), rand(0.07, 0.12), 0.85, 0.72, 0.5, 12, 1.5);
      }
      if (e) {
        for (let i = 0; i < 8; i++) {
          const a = rand(0, TAU), v = rand(2, 5);
          spawnP(x, y, z, Math.sin(a) * v, rand(-0.5, 2.5), Math.cos(a) * v, rand(0.15, 0.32), rand(0.1, 0.18), e[0], e[1], e[2], 3, 3);
        }
        _c.setRGB(e[0], e[1], e[2]);
        flare(x, y, z, _c.getHex(), 0.8, 0.08);
      } else flare(x, y, z, 0xfff0d0, 0.45, 0.05);
      if (how === 'wall') W.decal(0, x - u.dx * 0.2, z - u.dz * 0.2, 0.3, Math.atan2(u.dx, u.dz), 0xfff0d0, 0.3, 0.07);
      return true;
    };
  }

  // ----- 每帧：自动驱动 + 画出来（在 updateProjFx 的 pfBegin / pfEnd 之间） -----
  function flameRange() {
    const s = G.SKILLS && G.SKILLS.basic_flamer;
    return (s && (s.range || s.r || s.len)) || 4.6;
  }
  function rangedPfDraw(dt) {
    const ent = pEnt(), nm = clipNm(ent), P = G.player;
    // --- 喷枪：喷射期间从喷嘴往前喷火团 ---
    if (ent && ent.gearType === G_FLM && nm === 'fire_flamer' && dt > 0) {
      W.entSocket(ent, 'weapon', _rs);
      weaponFwd(ent, _rf);
      const rng = flameRange(), sp = 10;
      RF.flameAcc += dt * 75;
      while (RF.flameAcc >= 1) {
        RF.flameAcc -= 1;
        const spr = rand(-0.17, 0.17), c = Math.cos(spr), s = Math.sin(spr), fx = _rf.x * c + _rf.z * s, fz = -_rf.x * s + _rf.z * c, v = sp * rand(0.85, 1.1);
        puffAdd(_rs.x + fx * 0.05, _rs.y, _rs.z + fz * 0.05, fx * v, rand(-0.3, 0.5), fz * v, (rng / sp) * rand(0.8, 1.05), rand(0.55, 0.85), 0);
      }
      // 喷嘴口一团亮火
      mBill(_rs.x, _rs.y, _rs.z, 0.7);
      pfPut('glow', 1.2, 0.7, 0.25);
      flashLight(_rs.x + _rf.x * 1.5, 1.6, _rs.z + _rf.z * 1.5, 0xff8a3c, 1.4);
      // 地上的余烬：game.js 自己没放的话，隔一会儿在火焰尽头落一小片
      if (wtime - RF.groundAt > 1.2) {
        RF.groundAuto = RF.groundAuto || 0;
        if (Math.random() < dt * 2.2) {
          const d = rng * rand(0.6, 0.95);
          fireLite(_rs.x + _rf.x * d, _rs.z + _rf.z * d);
        }
      }
    } else RF.flameAcc = 0;
    // --- 焚天炎爆：出手帧放火浪（game.js 调过 W.fireNova 就不重复） ---
    if (ent && RF.novaK >= 0) {
      if (nm !== 'r_flamer' && nm !== 'w_flamer') RF.novaK = -1;
      else if (ent.cK >= ent.clip.k0 && RF.novaK < ent.clip.k0) {
        RF.novaK = 2;
        if (wtime - RF.novaSet > 0.4) {
          const s = G.SKILLS && G.SKILLS[(G.weaponSkill && G.weaponSkill()) || ''];
          W.fireNova(P.x, P.z, (s && (s.r || s.radius)) || 5.5);
        }
      } else if (RF.novaK < 2) RF.novaK = ent.cK;
    }
    if (RF.groundAuto && wtime >= RF.groundAuto.at) {
      const g = RF.groundAuto;
      RF.groundAuto = 0;
      if (wtime - RF.groundAt > 0.3) W.emberGround(g.x, g.z, g.R * 0.75, 4.5, true);
    }
    // --- 熔光射线 ---
    const L = RF.laser, lzOn = L.ext >= wtime || (ent && nm === 'w_gatling');
    if (lzOn && ent) drawLaser(ent, L, dt);
    // --- 乱射：game.js 没打出弹丸时，自动朝附近的敌人 / 四面八方甩出弹道 ---
    if (ent && (nm === 'r_revolver' || nm === 'w_revolver') && dt > 0) {
      RF.spray += dt * 13;
      while (RF.spray >= 1) {
        RF.spray -= 1;
        if (wtime - RF.projAt < 0.15) continue;
        sprayShot(ent);
      }
    } else RF.spray = 0;
    // --- 枪口焰 ---
    for (let i = RF.muz.length - 1; i >= 0; i--) {
      const m = RF.muz[i];
      m.t += dt;
      if (m.t >= m.dur) { RF.muz.splice(i, 1); continue; }
      const k = 1 - m.t / m.dur, s = m.s * (0.7 + 0.5 * k);
      _c.set(m.hex).convertSRGBToLinear();
      // 一道往前喷的长火舌 + 两侧斜出的短火舌（俯视是个十字星）+ 一团光
      mStretch(m.x + m.dx * 0.02, m.y, m.z + m.dz * 0.02, -m.dx, 0, -m.dz, 0.22 * s, 0.75 * s);
      pfPut('flame', 1.4 * k, 1.1 * k, 0.6 * k);
      for (const sd of [1, -1]) {
        const a = sd * 0.9, c = Math.cos(a), sn = Math.sin(a), ex = m.dx * c + m.dz * sn, ez = -m.dx * sn + m.dz * c;
        mStretch(m.x, m.y, m.z, -ex, 0, -ez, 0.12 * s, 0.32 * s);
        pfPut('flame', 1.2 * k, 0.8 * k, 0.35 * k);
      }
      mBill(m.x, m.y, m.z, 1.1 * s);
      pfPut('glow', _c.r * k * 1.4, _c.g * k * 1.2, _c.b * k);
    }
    // --- 瞬时弹道 ---
    for (let i = RF.tracers.length - 1; i >= 0; i--) {
      const tr = RF.tracers[i];
      tr.t += dt;
      if (tr.t >= tr.dur) { RF.tracers.splice(i, 1); continue; }
      const k = 1 - tr.t / tr.dur, dx = tr.x1 - tr.x0, dy = tr.y1 - tr.y0, dz = tr.z1 - tr.z0, l = Math.hypot(dx, dy, dz) || 1;
      mStretch((tr.x0 + tr.x1) / 2, (tr.y0 + tr.y1) / 2, (tr.z0 + tr.z1) / 2, dx, dy, dz, 0.07 + 0.05 * k, l);
      if (tr.tint) {
        _c.set(tr.hex);
        pfPut('beam', _c.r * 1.3 * k, _c.g * 1.3 * k, _c.b * 1.3 * k);
      } else pfPut('beam', 1.6 * k, 1.0 * k, 0.4 * k);
    }
    // --- 火团（喷火 / 火浪） ---
    for (let i = RF.puffs.length - 1; i >= 0; i--) {
      const f = RF.puffs[i];
      f.t += dt;
      if (f.t >= f.life) {
        if (Math.random() < 0.25) spawnS(f.x, f.y + 0.2, f.z, rand(-0.2, 0.2), rand(0.5, 1), rand(-0.2, 0.2), rand(0.5, 0.8), rand(0.4, 0.6), 0.12, 0.1, 0.09, 0.35), (smokeLive = 1.2);
        RF.puffs.splice(i, 1);
        continue;
      }
      const dr = Math.max(0, 1 - (f.wave ? 1.5 : 1.2) * dt);
      f.vx *= dr; f.vz *= dr; f.vy += dt * 1.6;
      f.x += f.vx * dt; f.y = Math.max(0.15, f.y + f.vy * dt); f.z += f.vz * dt;
      const a = f.t / f.life, s = f.s * (0.45 + a * 1.3), fl = 1 + 0.15 * Math.sin(wtime * 31 + f.ph);
      const r = 1, g = a < 0.25 ? 0.75 - a : 0.5 - a * 0.4, b = a < 0.2 ? 0.3 : 0.06, kk = a < 0.75 ? 1 : (1 - a) * 4;
      const vl = Math.hypot(f.vx, f.vz) || 1;
      mStretch(f.x, f.y, f.z, f.vx / vl, 0.15, f.vz / vl, s * 0.9 * fl, s * 1.5);
      pfPut('flameN', r * kk * (1 - a * 0.4), g * kk, b * kk);
      if (a < 0.6) {
        const hk = f.wave ? 0.45 : 0.9;
        mStretch(f.x, f.y + 0.05, f.z, f.vx / vl, 0.2, f.vz / vl, s * 0.55, s * 0.9 * fl);
        pfPut('flame', hk * kk, 0.66 * hk * kk, 0.28 * hk * kk);
      }
    }
    // --- 燃烧的地面 ---
    for (let i = RF.fires.length - 1; i >= 0; i--) {
      const F = RF.fires[i];
      F.t += dt;
      if (F.t >= F.dur) { RF.fires.splice(i, 1); continue; }
      drawFire(F, dt);
    }
    // --- 弹壳 ---
    for (let i = RF.shells.length - 1; i >= 0; i--) {
      const s = RF.shells[i];
      s.t += dt;
      if (s.t > 2.2) { RF.shells.splice(i, 1); continue; }
      if (!s.rest) {
        s.vy -= 13 * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        s.a += s.w * dt;
        if (s.y < 0.03) {
          s.y = 0.03;
          if (Math.abs(s.vy) < 1.2) { s.rest = true; s.vy = 0; } else { s.vy = -s.vy * 0.35; s.vx *= 0.5; s.vz *= 0.5; s.w *= 0.5; }
        }
      }
      const sc = (s.big ? 1.3 : 1) * (s.t > 1.8 ? (2.2 - s.t) / 0.4 : 1);
      _pe.set(s.rest ? HALF_PI : s.a, s.a * 0.7, s.rest ? 0 : s.a * 0.4);
      _pq.setFromEuler(_pe);
      mPose(s.x, s.y, s.z, _pq, sc, sc, sc);
      pfPut('casing', 0.95, 0.62, 0.22);
    }
    // --- 弓的 R 增益光环 ---
    drawBuff(ent, dt);
    // --- 热度 / 专注灌满：武器上的稀有度光一呼一吸（「R 可以放了」）；热度很高时枪口冒烟 ---
    gaugeFx(ent, dt);
  }
  // 喷枪自己落的一小片余烬（只有画面）
  function fireLite(x, z) {
    if (RF.fires.length >= 28) RF.fires.shift();
    RF.fires.push({ x, z, r: rand(0.55, 0.85), t: 0, dur: rand(1.6, 2.4), seed: rand(0, 100), acc: 0, big: false });
    W.decal(1, x, z, 0.8, rand(0, TAU), 0x2a1408, 3);
  }
  function drawFire(F, dt) {
    const fin = Math.min(1, F.t / 0.18), fout = Math.min(1, (F.dur - F.t) / 0.7), a = fin * fout;
    const n = Math.max(3, Math.min(F.big ? 26 : 10, Math.round(F.r * F.r * 1.6)));
    // 一地发红的余烬：贴地的小光斑，一明一暗地跳（火的范围靠它连成一片，火舌只是点缀）
    const ne = Math.max(5, Math.min(F.big ? 90 : 18, Math.round(F.r * F.r * 5)));
    for (let k = 0; k < ne; k++) {
      const h1 = hash2(k * 5 + 11, Math.floor(F.seed) + 7), h2 = hash2(k * 17 + 3, Math.floor(F.seed) + 1), ang = h1 * TAU, d = Math.sqrt(h2) * F.r;
      const fl = 0.55 + 0.45 * Math.sin(wtime * (3 + h2 * 5) + k * 2.1), sz = (0.35 + h1 * 0.45) * a;
      mPose(F.x + Math.sin(ang) * d, 0.06, F.z + Math.cos(ang) * d, _qFlat, sz, sz, 1);
      pfPut('glow', 0.95 * fl * a, 0.32 * fl * a, 0.05 * fl * a);
    }
    // 底下一层暗红的地光
    mPose(F.x, 0.07, F.z, _qFlat, F.r * 1.9, F.r * 1.9, 1);
    pfPut('glow', 0.42 * a, 0.1 * a, 0.015 * a);
    for (let k = 0; k < n; k++) {
      const h1 = hash2(k * 7 + 1, Math.floor(F.seed)), h2 = hash2(k * 13 + 5, Math.floor(F.seed) + 3);
      const ang = h1 * TAU, d = Math.sqrt(h2) * F.r * 0.92;
      const x = F.x + Math.sin(ang) * d, z = F.z + Math.cos(ang) * d;
      const fl = 0.75 + 0.35 * Math.sin(wtime * (9 + h1 * 6) + k * 1.7), sz = (0.34 + h2 * 0.22) * a;
      mStretch(x, 0.05, z, 0, -1, 0, sz * 0.75, sz * 1.5 * fl);
      pfPut('flameN', 0.95, 0.32 + 0.12 * h1, 0.05);
      if (k % 2 === 0) {
        mStretch(x, 0.08, z, 0, -1, 0, sz * 0.45, sz * 0.95 * fl);
        pfPut('flame', 0.95 * a, 0.62 * a, 0.25 * a);
      }
    }
    F.acc += dt * F.r * 5;
    while (F.acc >= 1) {
      F.acc -= 1;
      const ang = rand(0, TAU), d = Math.sqrt(Math.random()) * F.r;
      spawnP(F.x + Math.sin(ang) * d, 0.2, F.z + Math.cos(ang) * d, rand(-0.3, 0.3), rand(1, 2.6), rand(-0.3, 0.3), rand(0.4, 0.9), rand(0.07, 0.13), 1, rand(0.45, 0.75), 0.12, -1, 0.8);
    }
  }
  function drawLaser(ent, L, dt) {
    W.entSocket(ent, 'weapon', _rs);
    let x0 = _rs.x, z0 = _rs.z, dx, dz, len;
    const y0 = _rs.y;
    if (L.ext >= wtime) {
      dx = L.dx; dz = L.dz; len = L.len;
      if (Math.hypot(L.x - x0, L.z - z0) > 2) { x0 = L.x; z0 = L.z; }
    } else {
      weaponFwd(ent, _rf);
      dx = _rf.x; dz = _rf.z; len = 0;
    }
    if (!(len > 0)) {
      // 没给长度：往前走到墙为止（最多 14 米）
      len = 14;
      for (let d = 0.5; d <= 14; d += 0.5) if (!W.walkable(x0 + dx * d, z0 + dz * d, 0)) { len = d; break; }
    }
    const x1 = x0 + dx * len, z1 = z0 + dz * len, y1 = y0 - 0.25, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, my = (y0 + y1) / 2;
    if (L.ext >= wtime && L.charge >= 0) {
      // 蓄力：细细的瞄准线（越蓄越亮、越稳）+ 枪口聚起的光团，四周的光粒往枪口收
      const k = L.charge, fl = k >= 1 ? 1 : 0.6 + 0.4 * Math.abs(Math.sin(wtime * (20 + k * 30)));
      mStretch(mx, my, mz, dx, (y1 - y0) / len, dz, 0.045 + 0.05 * k, len);
      pfPut('beam', (0.9 + k) * fl, (0.3 + 0.5 * k) * fl, 0.08 * fl);
      mBill(x0, y0, z0, 0.3 + 0.8 * k);
      pfPut('glow', 0.6 + 0.6 * k, 0.25 + 0.35 * k, 0.05 + 0.1 * k);
      mBill(x0, y0, z0, 0.1 + 0.25 * k);
      pfPut('core', 1 + 0.6 * k, 0.8 + 0.5 * k, 0.4 + 0.4 * k);
      if (dt > 0 && Math.random() < dt * (10 + 30 * k)) {
        const a = rand(0, TAU), d = rand(0.8, 1.6);
        spawnP(x0 + Math.sin(a) * d, y0 + rand(-0.4, 0.6), z0 + Math.cos(a) * d, -Math.sin(a) * d * 3, rand(-0.5, 0.5), -Math.cos(a) * d * 3, 0.3, rand(0.06, 0.1), 1, 0.7 + 0.3 * Math.random(), 0.3, 0, 1);
      }
      if (k >= 1) { mPose(x1, 0.07, z1, _qFlat, 0.8, 0.8, 1); pfPut('glow', 0.9, 0.3, 0.05); }
      return;
    }
    const pulse = (1 + 0.12 * Math.sin(wtime * 47) + 0.06 * Math.sin(wtime * 83)) * (L.ext >= wtime && L.w > 0 ? L.w : 1);
    // 外焰（火）→ 内焰 → 白热的芯
    mStretch(mx, my, mz, dx, (y1 - y0) / len, dz, 0.75 * pulse, len);
    pfPut('beam', 0.95, 0.26, 0.05);
    mStretch(mx, my, mz, dx, (y1 - y0) / len, dz, 0.34 * pulse, len);
    pfPut('beam', 1.4, 0.75, 0.22);
    mStretch(mx, my, mz, dx, (y1 - y0) / len, dz, 0.12, len);
    pfPut('beam', 2.2, 2.0, 1.6);
    // 缠在光束上的电弧（雷）
    const nArc = Math.max(3, Math.round(len / 1.6));
    for (let i = 0; i < nArc; i++) {
      if (hash2(Math.floor(wtime * 28) + i * 3, i) < 0.35) continue;
      const f = (i + hash2(Math.floor(wtime * 20), i + 9)) / nArc;
      _pq.copy(camQ).multiply(_pq2.setFromAxisAngle(Z_AXIS, Math.atan2(dz, dx) + rand(-0.5, 0.5)));
      mPose(x0 + dx * len * f, y0 + (y1 - y0) * f, z0 + dz * len * f, _pq, rand(0.9, 1.5), rand(0.3, 0.45), 1);
      pfPut('arc', 1.1, 1.0, 0.45);
    }
    mBill(x0, y0, z0, 1.4 * pulse);
    pfPut('glow', 1.3, 0.6, 0.15);
    mBill(x1, y1, z1, 2.2 * pulse);
    pfPut('glow', 1.4, 0.55, 0.12);
    mPose(x1, 0.07, z1, _qFlat, 2.4, 2.4, 1);
    pfPut('glow', 0.9, 0.3, 0.05);
    if (dt > 0) {
      for (let i = 0; i < 3; i++) {
        const a = rand(0, TAU), v = rand(2, 6), el = Math.random() < 0.4;
        spawnP(x1, y1, z1, Math.sin(a) * v - dx * 2, rand(1, 4), Math.cos(a) * v - dz * 2, rand(0.12, 0.3), rand(0.08, 0.14), 1, el ? 0.95 : 0.55, el ? 0.5 : 0.15, 8, 2);
      }
      flashLight(x1, 1.5, z1, 0xff8a3c, 2.2);
      L.scorch -= dt;
      if (L.scorch <= 0) {
        L.scorch = 0.12;
        W.decal(1, x1, z1, 0.55, rand(0, TAU), 0x2a1408, 1.6);
      }
    }
  }
  function sprayShot(ent) {
    const P = G.player, S = G.state;
    W.entSocket(ent, 'weapon', _rs);
    let tx, tz, best = null, n = 0;
    const es = (S && S.enemies) || [];
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead || Math.hypot(e.x - P.x, e.z - P.z) > 9) continue;
      n++;
      if (Math.random() * n < 1) best = e; // 附近的敌人里随手挑一个
    }
    if (best && Math.random() < 0.8) {
      tx = best.x + rand(-0.3, 0.3);
      tz = best.z + rand(-0.3, 0.3);
    } else {
      const a = rand(0, TAU), d = rand(5, 8);
      tx = P.x + Math.sin(a) * d;
      tz = P.z + Math.cos(a) * d;
    }
    const dx = tx - _rs.x, dz = tz - _rs.z, l = Math.hypot(dx, dz) || 1;
    W.gunTracer(_rs.x, _rs.z, tx, tz, _rs.y);
    muzzleAdd(_rs.x, _rs.y, _rs.z, dx / l, dz / l, 1.1, 0xff9a40);
    ent.revTurn = (ent.revTurn || 0) + 1;
    if (Math.random() < 0.35) shellAdd(ent, dx / l, dz / l, true);
    for (let i = 0; i < 4; i++) spawnP(tx, 1.0, tz, rand(-3, 3), rand(0.5, 3), rand(-3, 3), rand(0.08, 0.18), 0.08, 1, 0.8, 0.4, 9, 3);
  }
  function drawBuff(ent, dt) {
    const B = RF.buff;
    if (!B.type) return;
    B.t += dt;
    const PB = G.player, gone = PB && 'rbuff' in PB && !PB.rbuff && wtime - B.set > 0.8; // 逻辑层的增益已经结束
    if (B.t >= B.dur || gone || !ent || (ent.gearVar && ent.gearVar !== B.type) || (PB && PB.dead)) {
      B.type = null;
      return;
    }
    const P = G.player, x = P.x, z = P.z, t = wtime;
    _c.set(BUFF_HEX[B.type]).convertSRGBToLinear();
    const cr = _c.r, cg = _c.g, cb = _c.b;
    const left = B.dur - B.t, a = Math.min(1, B.t / 0.25) * (left < 1.2 ? 0.55 + 0.45 * Math.abs(Math.sin(t * 9)) : 1);
    // 脚下：一圈细光环 + 地光
    _pq.copy(_qFlat);
    mPose(x, 0.08, z, _pq, 1.05, 1.05, 1.05);
    const rk = B.type === 'emberbow' ? 0.2 : 0.8; // 冰弓的细光环压得很暗：冰蓝的细线一泛光就成了白圈
    pfPut('ringF', cr * a * rk, cg * a * rk, cb * a * rk);
    mPose(x, 0.06, z, _qFlat, 2.6, 2.6, 1);
    pfPut('glow', cr * 0.45 * a, cg * 0.45 * a, cb * 0.45 * a);
    B.acc += dt * 14;
    if (B.type === 'huntbow') {
      // 万矢：五枚小箭影绕身转
      for (let k = 0; k < 5; k++) {
        const ang = t * 2.6 + (k / 5) * TAU, px = x + Math.sin(ang) * 0.85, pz = z + Math.cos(ang) * 0.85;
        mStretch(px, 1.25 + 0.1 * Math.sin(t * 3 + k), pz, Math.cos(ang), 0, -Math.sin(ang), 0.12, 0.6);
        pfPut('beam', cr * 2.2 * a, cg * 2.2 * a, cb * 2.2 * a);
        mBill(px, 1.25, pz, 0.35);
        pfPut('glow', cr * a, cg * a, cb * a);
      }
    } else if (B.type === 'eagle') {
      // 一矢穿心：脚下四道转动的准星刻度，眼前一点金光
      for (let k = 0; k < 4; k++) {
        const ang = t * 1.2 + (k / 4) * TAU, px = x + Math.sin(ang) * 1.3, pz = z + Math.cos(ang) * 1.3;
        _pq.setFromAxisAngle(UP, ang).multiply(_qFlat);
        mPose(px, 0.09, pz, _pq, 0.07, 0.42, 1);
        pfPut('beam', cr * 2 * a, cg * 2 * a, cb * 1.6 * a);
      }
      const f = G.player.face || 0;
      mBill(x + Math.sin(f) * 0.18, 1.78, z + Math.cos(f) * 0.18, 0.5 + 0.1 * Math.sin(t * 12));
      pfPut('glow', 1.6 * a, 1.4 * a, 0.8 * a);
    } else if (B.type === 'runebow') {
      // 元素满溢：火、冰、雷三颗元素球绕身转，地上的光圈跟着换色
      const EC = [[1, 0.4, 0.08], [0.45, 0.8, 1], [1, 0.9, 0.3]];
      for (let k = 0; k < 3; k++) {
        const ang = t * 3.1 + (k / 3) * TAU, px = x + Math.sin(ang) * 0.75, pz = z + Math.cos(ang) * 0.75, py = 1.2 + 0.15 * Math.sin(t * 4 + k * 2);
        mPose(px, py, pz, _pqI, 0.07, 0.07, 0.07);
        pfPut('core', EC[k][0] * 1.3, EC[k][1] * 1.3, EC[k][2] * 1.3);
        mBill(px, py, pz, 0.55);
        pfPut('glow', EC[k][0] * a, EC[k][1] * a, EC[k][2] * a);
        if (dt > 0 && Math.random() < dt * 20) spawnP(px, py, pz, rand(-0.3, 0.3), rand(0, 0.5), rand(-0.3, 0.3), rand(0.25, 0.45), 0.09, EC[k][0], EC[k][1], EC[k][2], 0, 2);
      }
    } else if (B.type === 'emberbow') {
      // 冰弓（凛羽）：脚下一圈冰晶（高矮交错、慢慢绕身转、轻轻起伏），冰晶之间贴地一层淡蓝的霜雾
      for (let k = 0; k < 10; k++) {
        const ang = (k / 10) * TAU + t * 0.5, rr = k % 2 ? 0.62 : 0.76, px = x + Math.sin(ang) * rr, pz = z + Math.cos(ang) * rr;
        const fl = 0.88 + 0.12 * Math.sin(t * 4 + k * 2.3), h = (k % 2 ? 0.17 : 0.24) * fl * Math.min(1, B.t / 0.35);
        _pq.copy(_pq2.setFromAxisAngle(UP, ang * 2 + k)).multiply(_qFlat); // 尖朝上，各自转一个角度，冰面反光错落
        mPose(px, h * 0.95, pz, _pq, h * 0.6, h * 0.6, h);
        pfPut('shard', 0.34 * a, 0.66 * a, 1.0 * a);
      }
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * TAU - t * 0.35, px = x + Math.sin(ang) * 0.65, pz = z + Math.cos(ang) * 0.65;
        mBill(px, 0.22, pz, 0.85 + 0.1 * Math.sin(t * 2 + k));
        pfPut('glow', 0.03 * a, 0.12 * a, 0.3 * a);
      }
    }
    // 绕身升起的光粒
    while (B.acc >= 1) {
      B.acc -= 1;
      const ang = rand(0, TAU), d = rand(0.3, 0.9);
      spawnP(x + Math.sin(ang) * d, rand(0.2, 1.2), z + Math.cos(ang) * d, rand(-0.2, 0.2), rand(0.8, 1.8), rand(-0.2, 0.2), rand(0.5, 0.9), rand(0.07, 0.12),
        Math.min(1, cr * 1.6 + 0.2), Math.min(1, cg * 1.6 + 0.2), Math.min(1, cb * 1.6 + 0.2), -0.6, 0.8);
    }
  }
  function gaugeFx(ent, dt) {
    if (!ent || !ent.gearVar || !GUN_KIND[ent.gearVar]) return;
    RF.gaugeT -= dt;
    if (RF.gaugeT <= 0) {
      RF.gaugeT = 0.2;
      let k = 0;
      try {
        const rw = typeof G.rangedWeapon === 'function' ? G.rangedWeapon() : null, gg = rw && rw.gauge;
        k = gg && gg.max > 0 ? gg.v / gg.max : 0;
      } catch (e) {
        k = 0;
      }
      RF.gaugeK = k;
      RF.gaugeFull = k >= 0.999;
    }
    const m = ent.auxMat;
    if (m && ent.flashT <= 0) {
      const base = m.userData.ei0;
      m.emissiveIntensity = RF.gaugeFull ? base * (1.25 + 0.55 * Math.abs(Math.sin(wtime * 5))) : base;
    }
    // 热度高：枪口冒一缕青烟；满了还噼啪掉火星
    if (dt > 0 && ent.gearType >= G_GAT && RF.gaugeK > 0.7 && Math.random() < dt * (RF.gaugeFull ? 9 : 4)) {
      W.entSocket(ent, 'weapon', _rs);
      spawnS(_rs.x, _rs.y + 0.05, _rs.z, rand(-0.1, 0.1), rand(0.4, 0.8), rand(-0.1, 0.1), rand(0.5, 0.9), rand(0.18, 0.28), 0.16, 0.15, 0.15, 0.3);
      smokeLive = 1.2;
      if (RF.gaugeFull) spawnP(_rs.x, _rs.y, _rs.z, rand(-0.6, 0.6), rand(0.5, 1.6), rand(-0.6, 0.6), rand(0.2, 0.4), 0.08, 1, 0.6, 0.2, 3, 1);
    }
  }

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
  function beamMat(hex, op) {
    const key = op ? hex + ':' + op : hex;
    return (
      beamMats[key] ||
      (beamMats[key] = new T.MeshBasicMaterial({ map: beamTex(), color: lin(hex), transparent: true, opacity: op || 0.6, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false, fog: false }))
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
      const u = mesh.userData;
      if (u.rib >= 0) {
        ribRelease(u.rib); // 拖尾留在原地淡出
        u.rib = -1;
      }
      if (u.vfx && !u.pooled) {
        u.pooled = true;
        pfPool.push(mesh);
      }
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

  // ---------- 焚骨祭司的特效 ----------
  // 火弹：W.makePyreBolt() 返回一个投射物（和 makeProjectile 一样由调用方摆位置、用 W.removeMesh 移除）：
  //   白热的核裹着一团焚火，两缕魂火青的细焰绕着它打转，一路洒火星、拖一条橙红的尾巴
  RIB_DEF.pyre = [0.22, 0.24];
  PF_DRAW.pyre = function (u, x, y, z, dt) {
    const r = u.rad, t = u.age, ph = u.ph;
    mPose(x, y, z, _pqI, r * 0.5, r * 0.5, r * 0.5);
    pfPut('core', 1, 0.85, 0.55);
    const f1 = 1 + 0.18 * Math.sin(t * 33 + ph);
    mStretch(x + u.dx * r * 0.5, y, z + u.dz * r * 0.5, u.dx, 0, u.dz, r * 2.8 * (2 - f1), r * 2.4 * f1);
    pfPut('flame', 0.55, 0.2, 0.04);
    for (let k = 0; k < 2; k++) {
      const wob = Math.sin(t * 15 + ph + k * 2.4) * 0.3 + (k - 0.5) * 0.7;
      flameTongue(u, x + u.dx * r * 0.3, y, z + u.dz * r * 0.3, wob, r * 2.1, r * (4.6 + 1.4 * Math.sin(t * 21 + k * 2)), 1, 0.24, 0.03, 'flameN');
    }
    // 魂火青的两缕：绕着火球转
    for (let k = 0; k < 2; k++) {
      const a = t * 14 + ph + k * Math.PI, ox = Math.cos(a) * r * 1.3, oy = Math.sin(a) * r * 1.0;
      mBill(x - u.dz * ox, y + oy, z + u.dx * ox, r * 1.6);
      pfPut('glow', ALLY_RGB.r * 0.5, ALLY_RGB.g * 0.9, ALLY_RGB.b * 0.8);
    }
    glowPut(u, x, y, z, r * 6.5, 0.5);
    u.acc += dt;
    while (u.acc > 0.025) {
      u.acc -= 0.025;
      const teal = Math.random() < 0.25;
      spawnP(x - u.dx * r + rand(-0.1, 0.1), y + rand(-0.1, 0.1), z - u.dz * r + rand(-0.1, 0.1), rand(-1, 1) - u.dx * 1.4, rand(0.3, 1.6), rand(-1, 1) - u.dz * 1.4, rand(0.25, 0.45), rand(0.08, 0.13),
        teal ? ALLY_RGB.r : 1, teal ? ALLY_RGB.g : rand(0.55, 0.85), teal ? ALLY_RGB.b : 0.2, -1.4, 1.8);
    }
  };
  W.makePyreBolt = function () {
    return W.makeProjectile(0xff8a3c, 0.27, false, { kind: 'pyre' });
  };
  // 火弹炸开：橙红的火环 + 金色内环，火团往上翻、火星四溅，几点魂火青的余烬往上飘，地上一块焦痕
  W.pyreBlast = function (x, z, R, mesh) {
    const y = 0.9;
    W.ring(x, z, R, 0xff7a2c, 0.32);
    W.ring(x, z, R * 0.5, 0xffd7a0, 0.18);
    flare(x, y, z, 0xffa050, 1.5 + R * 0.35, 0.12);
    flashLight(x, 2, z, 0xff8a3c, 1.5);
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), v = rand(1, 3) * R;
      spawnP(x, y, z, Math.sin(a) * v, rand(0.5, 2.4), Math.cos(a) * v, rand(0.22, 0.4), rand(0.4, 0.62), 1, 0.42, 0.1, -2, 3.5);
    }
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU), v = rand(4, 8) * Math.sqrt(R);
      spawnP(x, y, z, Math.sin(a) * v, rand(1, 5), Math.cos(a) * v, rand(0.3, 0.55), rand(0.08, 0.13), 1, rand(0.7, 0.95), rand(0.3, 0.55), 12, 1.5);
    }
    for (let i = 0; i < 6; i++) spawnP(x + rand(-R, R) * 0.5, 0.4, z + rand(-R, R) * 0.5, rand(-0.4, 0.4), rand(1.2, 2.6), rand(-0.4, 0.4), rand(0.5, 0.9), rand(0.1, 0.16), ALLY_RGB.r, ALLY_RGB.g, ALLY_RGB.b, -0.8, 1);
    W.smoke(x, y + 0.2, z, 0.3 * R, 4, 0x241a16);
    W.decal(1, x, z, R * 0.65, rand(0, TAU), 0xff7a2c, 1.6);
  };
  // 坠焰：一颗裹着焚火的陨石从天而降（地上的预警圈由 game.js 的友方预警画），落点先亮一圈魂火青的咒环
  W.pyreMeteor = function (x, z, R, delay) {
    W.meteorFall(x, z, delay, 0xff9a4a);
    W.ring(x, z, R * 0.9, ALLY_HEX, 0.4);
    W.ring(x, z, R * 0.45, 0xffb070, 0.3);
  };
  W.pyreMeteorLand = function (x, z, R) {
    W.ring(x, z, R, 0xff7a2c, 0.5);
    W.ring(x, z, R * 0.6, 0xffd08a, 0.35);
    W.ring(x, z, R * 1.15, ALLY_HEX, 0.3);
    W.decal(1, x, z, R * 0.9, rand(0, TAU), 0x2a1408, 4);
    const n = 36;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.06, 0.06), v = (R / 0.45) * rand(0.8, 1.05);
      puffAdd(x + Math.sin(a) * 0.4, 0.45, z + Math.cos(a) * 0.4, Math.sin(a) * v, rand(0.2, 1.0), Math.cos(a) * v, rand(0.38, 0.5), rand(0.3, 0.46), 1);
    }
    for (let i = 0; i < 34; i++) {
      const a = rand(0, TAU), v = rand(3, 8);
      spawnP(x, 0.6, z, Math.sin(a) * v, rand(2, 7), Math.cos(a) * v, rand(0.5, 1.0), rand(0.12, 0.22), 1, rand(0.4, 0.75), 0.12, 6, 1.2);
    }
    for (let i = 0; i < 10; i++) spawnP(x + rand(-1, 1) * R * 0.6, 0.3, z + rand(-1, 1) * R * 0.6, rand(-0.5, 0.5), rand(1.5, 3.5), rand(-0.5, 0.5), rand(0.6, 1.1), rand(0.12, 0.2), ALLY_RGB.r, ALLY_RGB.g, ALLY_RGB.b, -0.6, 0.9);
    flare(x, 1, z, 0xff8a3c, 2.8, 0.18);
    flashLight(x, 2.4, z, 0xff7a2c, 2.6);
    W.emberGround(x, z, R * 0.7, 2.2);
  };
  // 灼链：W.pyreBeam(ent, e) 每帧调用，从这位祭司的杖头连到目标胸口；e 为 null 收起。
  // 一根橙红的火焰光束，里面缠着一缕魂火青的细线，沿途翻滚着火星，打在目标身上一团亮光。超过 0.15 秒没再调就自己收起
  const pyreBeams = [];
  W.pyreBeam = function (ent, e) {
    let b = null;
    for (let i = 0; i < pyreBeams.length; i++) if (pyreBeams[i].ent === ent) b = pyreBeams[i];
    if (!e) {
      if (b) pyreBeams.splice(pyreBeams.indexOf(b), 1);
      return;
    }
    if (!b) {
      b = { ent, x: 0, y: 0, z: 0, at: 0, t0: wtime };
      pyreBeams.push(b);
      W.entSocket(ent, 'weapon', _rs);
      flare(_rs.x, _rs.y, _rs.z, 0xffa050, 1.4, 0.15);
    }
    b.x = e.x;
    b.z = e.z;
    b.y = Math.min(2.2, (e.height || 2) * 0.55);
    b.at = wtime;
  };
  // 焰蓄：W.pyreCharge(ent, k[, release]) k = 0..1，杖头的焚火随之变大变亮；release 时迸一下
  const pyreEnts = [];
  W.pyreCharge = function (ent, k, release) {
    if (!ent || ent.removed) return;
    if (pyreEnts.indexOf(ent) < 0) pyreEnts.push(ent);
    ent.pyreK = G.clamp(k || 0, 0, 1);
    if (release) {
      W.entSocket(ent, 'weapon', _rs);
      flare(_rs.x, _rs.y, _rs.z, 0xffc070, 2.2, 0.18);
      for (let i = 0; i < 18; i++) {
        const a = rand(0, TAU), v = rand(1.5, 4);
        spawnP(_rs.x, _rs.y, _rs.z, Math.sin(a) * v, rand(1, 4), Math.cos(a) * v, rand(0.3, 0.6), rand(0.1, 0.18), 1, rand(0.55, 0.85), 0.2, 2, 1.5);
      }
    }
  };
  function pyrePfDraw(dt) {
    for (let i = pyreBeams.length - 1; i >= 0; i--) {
      const b = pyreBeams[i], ent = b.ent;
      if (ent.removed || ent.dying || wtime - b.at > 0.15) {
        pyreBeams.splice(i, 1);
        continue;
      }
      W.entSocket(ent, 'weapon', _rs);
      const x0 = _rs.x, y0 = _rs.y, z0 = _rs.z, x1 = b.x, y1 = b.y, z1 = b.z;
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz) || 1;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
      const grow = Math.min(1, (wtime - b.t0) / 0.12);
      const pulse = (1 + 0.15 * Math.sin(wtime * 43 + i) + 0.07 * Math.sin(wtime * 71)) * grow;
      mStretch(mx, my, mz, dx / len, dy / len, dz / len, 0.5 * pulse, len);
      pfPut('beam', 0.95, 0.28, 0.05);
      mStretch(mx, my, mz, dx / len, dy / len, dz / len, 0.22 * pulse, len);
      pfPut('beam', 1.4, 0.8, 0.25);
      // 缠在里面的一缕魂火青
      const tw = Math.sin(wtime * 9 + i) * 0.06;
      mStretch(mx, my + tw, mz, dx / len, dy / len, dz / len, 0.09, len);
      pfPut('beam', ALLY_RGB.r * 1.4, ALLY_RGB.g * 1.6, ALLY_RGB.b * 1.5);
      mBill(x0, y0, z0, 0.9 * pulse);
      pfPut('glow', 1.3, 0.6, 0.18);
      mBill(x1, y1, z1, 1.5 * pulse);
      pfPut('glow', 1.4, 0.55, 0.12);
      if (dt > 0) {
        for (let k = 0; k < 2; k++) {
          const f = Math.random();
          spawnP(x0 + dx * f, y0 + dy * f, z0 + dz * f, rand(-0.8, 0.8), rand(0.2, 1.6), rand(-0.8, 0.8), rand(0.2, 0.4), rand(0.08, 0.14), 1, rand(0.5, 0.85), 0.15, -1, 2);
        }
        spawnP(x1, y1, z1, rand(-2.5, 2.5), rand(0.5, 3), rand(-2.5, 2.5), rand(0.25, 0.45), rand(0.1, 0.18), 1, 0.6, 0.2, 6, 1.5);
        if (Math.random() < dt * 12) flashLight(x1, y1 + 0.5, z1, 0xff8a3c, 1.1);
      }
    }
    // 杖头的焰蓄：一团随焰蓄长大的焚火光晕，满了以后一跳一跳地往上蹿火舌
    for (let i = pyreEnts.length - 1; i >= 0; i--) {
      const ent = pyreEnts[i];
      if (ent.removed) {
        pyreEnts.splice(i, 1);
        continue;
      }
      if (ent.dying || !ent.group.visible) continue;
      const k = ent.pyreK || 0;
      if (k <= 0.02) continue;
      W.entSocket(ent, 'weapon', _rs);
      const fl = 1 + 0.12 * Math.sin(wtime * 23 + ent.phase);
      mBill(_rs.x, _rs.y, _rs.z, (0.25 + 0.75 * k) * fl);
      pfPut('glow', 1.2 * k, 0.5 * k, 0.12 * k);
      if (k >= 0.999) {
        const h = 0.25 + 0.12 * Math.sin(wtime * 17 + ent.phase);
        mStretch(_rs.x, _rs.y + h * 0.5, _rs.z, 0, 1, 0, 0.22, h * 1.6);
        pfPut('flame', 1, 0.42, 0.08);
        if (dt > 0 && Math.random() < dt * 20) spawnP(_rs.x + rand(-0.06, 0.06), _rs.y + 0.1, _rs.z + rand(-0.06, 0.06), rand(-0.3, 0.3), rand(1, 2.4), rand(-0.3, 0.3), rand(0.3, 0.5), rand(0.07, 0.12), 1, 0.7, 0.25, -1, 1);
      }
    }
  }
  function clearPyreFx() {
    pyreBeams.length = 0;
  }
  // 祭司动作里的一次性特效（minionClipFx 转过来）
  function pyreClipFx(ent, c) {
    const n = c.name, g = ent.group.position;
    if (n === 'rise') {
      // 一团焚火从地里翻上来，夹着几点魂火青
      if (ent.cK < 0.7 && Math.random() < 0.7) {
        const a = rand(0, TAU), d = rand(0.05, 0.45), teal = Math.random() < 0.3;
        spawnP(g.x + Math.sin(a) * d, 0.1, g.z + Math.cos(a) * d, Math.sin(a) * rand(0.2, 0.8), rand(1.6, 3.6), Math.cos(a) * rand(0.2, 0.8), rand(0.35, 0.7), rand(0.12, 0.22),
          teal ? ALLY_RGB.r : 1, teal ? ALLY_RGB.g : rand(0.45, 0.7), teal ? ALLY_RGB.b : 0.12, -1.5, 1.2);
      }
      if (crossed(ent, 0.86)) W.ring(g.x, g.z, 0.9, 0xff8a3c, 0.3); // 杖往地上一顿
    } else if (n === 'attack' && crossed(ent, c.k0)) {
      W.entSocket(ent, 'weapon', _sk);
      flare(_sk.x, _sk.y, _sk.z, 0xffa050, 1.1, 0.1);
      for (let i = 0; i < 6; i++) spawnP(_sk.x, _sk.y, _sk.z, rand(-1.5, 1.5), rand(0.5, 2.5), rand(-1.5, 1.5), rand(0.2, 0.4), rand(0.08, 0.13), 1, 0.7, 0.25, 4, 2);
    } else if (n === 'cast2') {
      W.entSocket(ent, 'weapon', _sk);
      if (ent.cK > 0.2 && ent.cK < c.k0 && Math.random() < 0.8) spawnP(_sk.x + rand(-0.08, 0.08), _sk.y, _sk.z + rand(-0.08, 0.08), rand(-0.3, 0.3), rand(2.5, 5), rand(-0.3, 0.3), rand(0.3, 0.55), rand(0.12, 0.2), 1, rand(0.45, 0.75), 0.12, -1, 1);
      if (crossed(ent, c.k0)) {
        flare(_sk.x, _sk.y, _sk.z, 0xffc070, 2.4, 0.2);
        flashLight(_sk.x, _sk.y, _sk.z, 0xff8a3c, 1.8);
        for (let i = 0; i < 16; i++) spawnP(_sk.x, _sk.y, _sk.z, rand(-1, 1), rand(4, 9), rand(-1, 1), rand(0.4, 0.7), rand(0.12, 0.2), 1, rand(0.5, 0.8), 0.15, -2, 1);
      }
      if (crossed(ent, 0.85)) W.ring(g.x, g.z, 1.2, 0xff8a3c, 0.3);
    } else if (n === 'death' && crossed(ent, 0.55)) {
      // 法袍塌下去：扬起一把灰和余烬，魂火从胸腔里散掉
      for (let i = 0; i < 12; i++) {
        const a = rand(0, TAU), sp = rand(0.8, 2.4);
        spawnP(g.x + Math.sin(a) * 0.25, rand(0.1, 0.5), g.z + Math.cos(a) * 0.25, Math.sin(a) * sp, rand(0.8, 2.6), Math.cos(a) * sp, rand(0.4, 0.8), rand(0.1, 0.2), 0.35, 0.3, 0.27, 6, 1.4);
      }
      for (let i = 0; i < 10; i++) spawnP(g.x + rand(-0.3, 0.3), rand(0.2, 0.9), g.z + rand(-0.3, 0.3), rand(-0.6, 0.6), rand(0.8, 2.2), rand(-0.6, 0.6), rand(0.4, 0.8), rand(0.08, 0.14), 1, rand(0.5, 0.8), 0.18, -0.8, 1.2);
    }
  }

  // ---------- 烬铸武器的特效 ----------
  // 残刃：敌人头顶一圈悬着的小刃，叠几层亮几把（最多 5 把），慢慢转；目标被移除 / 开始死亡时自动收起
  const MARK_N = 5, MARK_POOL = 24;
  const markPool = [];
  let markMat = null;
  function newMarkSet() {
    if (!markMat) markMat = new T.MeshBasicMaterial({ color: lin(0xffe2b8), toneMapped: false, fog: false });
    const grp = new T.Group();
    const blades = [];
    for (let i = 0; i < MARK_N; i++) {
      const a = (i / MARK_N) * TAU;
      const piv = new T.Group();
      piv.rotation.y = a;
      const b = new T.Mesh(gOct(0.1), markMat);
      b.scale.set(1.1, 6.2, 1.7);
      b.position.set(0, 0, 1);
      b.rotation.x = -0.45; // 刃尖朝下、向里斜，像插向它的一圈刀
      piv.add(b);
      const gl = new T.Sprite(spriteMat(0xff9b3d));
      gl.scale.setScalar(1.1);
      gl.position.set(0, 0, 1);
      piv.add(gl);
      piv.userData.b = b;
      piv.userData.g = gl;
      grp.add(piv);
      blades.push(piv);
    }
    grp.visible = false;
    scene.add(grp);
    const m = { grp, blades, ent: null, n: 0, t: 0, pop: 0 };
    markPool.push(m);
    return m;
  }
  // n：当前层数（0 收起）
  W.bladeMarks = function (ent, n) {
    if (!ent) return;
    let m = null;
    for (let i = 0; i < markPool.length; i++) if (markPool[i].ent === ent) m = markPool[i];
    if (!(n > 0)) {
      if (m) {
        m.ent = null;
        m.grp.visible = false;
      }
      return;
    }
    if (!m) {
      for (let i = 0; i < markPool.length && !m; i++) if (!markPool[i].ent) m = markPool[i];
      if (!m && markPool.length < MARK_POOL) m = newMarkSet();
      if (!m) return;
      m.ent = ent;
      m.t = 0;
    }
    m.n = Math.min(MARK_N, n);
    m.pop = 0.22;
  };
  W.bladeMarkCount = function (ent) {
    for (let i = 0; i < markPool.length; i++) if (markPool[i].ent === ent) return markPool[i].n;
    return 0;
  };
  function updateMarks(raw) {
    for (let i = 0; i < markPool.length; i++) {
      const m = markPool[i];
      const e = m.ent;
      if (!e) continue;
      if (e.removed || e.dying) {
        m.ent = null;
        m.grp.visible = false;
        continue;
      }
      m.t += raw;
      if (m.pop > 0) m.pop = Math.max(0, m.pop - raw);
      // 一圈小刃绕着它的上半身转（在头顶血条下面，不和血条、名字挤在一起），刚叠上一层时整圈一跳
      const g = e.group.position, hh = e.rig.height * e.k * e.group.scale.y;
      const d = (G.MOBS && G.MOBS[e.kind]) || (G.BOSSES && G.BOSSES[e.kind]);
      const R = (((d && d.r) || 0.6) * e.k + 0.35) * (1 + m.pop * 0.8);
      m.grp.position.set(g.x, g.y + hh * 0.72 + Math.sin(m.t * 3) * 0.06, g.z);
      m.grp.rotation.y += raw * 1.6;
      for (let j = 0; j < MARK_N; j++) {
        const pv = m.blades[j];
        pv.visible = j < m.n;
        pv.userData.b.position.z = R;
        pv.userData.g.position.z = R;
      }
      m.grp.visible = true;
    }
  }
  W.updateMarks = updateMarks;
  // 残刃引爆：五道刀光从四面同时斩过，一团白热的火花，地上一道冲击环
  // R：波及半径（从目标边缘算），冲击环推到这里
  W.markBurstFx = function (x, z, h, r, R) {
    const y = Math.min(2.4, h * 0.55);
    flashLight(x, y + 1, z, 0xffc27a, 2.6);
    flare(x, y, z, 0xffd9a8, 2.6 + (r || 0.6), 0.16);
    const a0 = Math.random() * TAU;
    for (let i = 0; i < MARK_N; i++) W.slash(x, z, a0 + (i / MARK_N) * TAU, 1.4 + (r || 0.6), 70, i % 2 ? 0xffe2b8 : 0xff9b3d, { y: y * (0.75 + 0.1 * i), dur: 0.2, inner: 0.55, dir: i % 2 ? -1 : 1 });
    W.ring(x, z, (r || 0.6) + (R || 2.0), 0xffb066, 0.32);
    W.burst(x, y, z, 0xfff0d0, 30, 8, 0.4);
    W.burst(x, y, z, 0xff9b3d, 16, 5, 0.5);
  };
  // 残刃转移：一串余烬色的刃光从倒下的敌人飞向下一个
  W.markJumpFx = function (x0, z0, x1, z1, h) {
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
    const y1 = Math.min(2.4, (h || 2) * 0.6);
    const n = Math.min(24, 8 + Math.round(len * 3));
    for (let q = 0; q < n; q++) {
      const f = q / n;
      _c.set(q % 2 ? 0xffe2b8 : 0xff9b3d);
      spawnP(x0 + dx * f, 1.0 + (y1 - 1.0) * f + Math.sin(f * Math.PI) * 0.8, z0 + dz * f, (dx / len) * 3, rand(0.2, 0.6), (dz / len) * 3, rand(0.25, 0.45), 0.22, _c.r, _c.g, _c.b, 0, 2);
    }
    W.burst(x1, y1, z1, 0xffc27a, 8, 3, 0.3);
  };
  // 三相共鸣：三色（火 / 冰 / 雷）的三道圈从中心推开，火星流从触发的敌人涌向每个被灌的敌人（另外两种颜色交替）
  const TRI_HEX = { fire: 0xff7a2c, cold: 0x7fd4ff, light: 0xffe45e };
  W.triFx = function (x0, z0, R, t, targets) {
    W.ring(x0, z0, R, TRI_HEX.fire, 0.7);
    W.ring(x0, z0, R * 0.8, TRI_HEX.cold, 0.6);
    W.ring(x0, z0, R * 0.6, TRI_HEX.light, 0.5);
    flashLight(x0, 2.2, z0, 0xffe8d0, 1.2);
    const others = ['fire', 'cold', 'light'].filter((x) => x !== t);
    for (const k of ['fire', 'cold', 'light']) W.burst(x0, 1.2, z0, TRI_HEX[k], 10, 5, 0.5);
    for (let i = 0; i < targets.length; i++) {
      const o = targets[i];
      const y1 = o.h * 0.6;
      for (let j = 0; j < 2; j++) {
        const hx = TRI_HEX[others[j]];
        _c.set(hx);
        // 每个被灌的敌人脚下各亮起两道（另外两种元素颜色的）小圈
        W.ring(o.x, o.z, 0.85 + j * 0.4, hx, 0.5);
        if (o.self) {
          // 自己身上：两色火星绕着身体往上旋
          for (let q = 0; q < 14; q++) {
            const a = (q / 14) * TAU + j * Math.PI;
            spawnP(o.x + Math.sin(a) * 0.8, 0.3 + q * 0.12, o.z + Math.cos(a) * 0.8, Math.cos(a) * 1.6, 1.8, -Math.sin(a) * 1.6, rand(0.5, 0.8), 0.24, _c.r, _c.g, _c.b, -0.5, 1.2);
          }
          continue;
        }
        // 从触发的敌人涌过去的一道弧形火星流（两种颜色各走一边）
        const dx = o.x - x0, dz = o.z - z0, len = Math.hypot(dx, dz) || 1;
        const n = Math.min(22, 10 + Math.round(len * 3));
        for (let q = 0; q < n; q++) {
          const f = q / n, off = (j ? 1 : -1) * Math.sin(f * Math.PI) * 0.7;
          const px = x0 + dx * f + (dz / len) * off, pz = z0 + dz * f - (dx / len) * off;
          spawnP(px, 1.0 + (y1 - 1.0) * f + Math.sin(f * Math.PI) * 0.6, pz, (dx / len) * 2.5, rand(0.2, 0.8), (dz / len) * 2.5, rand(0.4, 0.7), 0.24, _c.r, _c.g, _c.b, 0, 2);
        }
        W.burst(o.x, y1, o.z, hx, 8, 3, 0.4);
      }
    }
  };
  // 魂火：魂火青与余烬橙两层火从倒下的召唤物脚下腾起，冲击环推到伤害半径
  W.soulFireFx = function (x, z, R, h) {
    flashLight(x, 1.6, z, ALLY_HEX, 2.2);
    flare(x, 0.9, z, ALLY_HEX, 2.4, 0.16);
    W.ring(x, z, R, ALLY_HEX, 0.42);
    W.ring(x, z, R * 0.65, 0xff9b3d, 0.3);
    W.decal(1, x, z, R * 0.6, Math.random() * TAU, ALLY_HEX, 2.5);
    for (let i = 0; i < 36; i++) {
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * R * 0.8, warm = i % 3 === 0;
      const r = warm ? 1 : ALLY_RGB.r, g = warm ? 0.6 : ALLY_RGB.g, b = warm ? 0.25 : ALLY_RGB.b;
      spawnP(x + Math.sin(a) * d * 0.3, 0.2, z + Math.cos(a) * d * 0.3, Math.sin(a) * rand(2, 5), rand(1.5, 4.5), Math.cos(a) * rand(2, 5), rand(0.45, 0.9), rand(0.16, 0.3), r, g, b, -1.5, 1.4);
    }
    W.burst(x, h * 0.5, z, 0xe8fff8, 12, 4, 0.35);
  };

  // ---------- 烬铸技的特效 ----------
  const EMBER = 0xff9b3d, EMBER_HI = 0xffe2b8;
  // 立着的光带：从 (x0,y0,z0) 到 (x1,y1,z1)（同一个 z 附近的竖直 / 斜向光带，落雷、天降光柱用），hw 半宽
  function vstreak(x0, y0, z0, x1, y1, z1, hw, hex, dur) {
    const it = streakGet();
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 0.01;
    it.on = true;
    it.t = 0;
    it.dur = dur;
    it.u.uColor.value.set(hex);
    it.u.uK.value = 0;
    it.u.uMode.value = 0;
    it.u.uD.value = 0;
    it.fired = true;
    it.x = (x0 + x1) / 2;
    it.y = (y0 + y1) / 2;
    it.z = (z0 + z1) / 2;
    it.len = len;
    it.mesh.position.set(it.x, it.y, it.z);
    // 平躺的方片先绕 x 轴立起来（长边朝上），再在画面里绕 z 轴斜过去
    it.mesh.rotation.order = 'ZYX';
    it.mesh.rotation.set(-HALF_PI, 0, Math.atan2(-dx, dy));
    it.mesh.scale.set(hw, 1, len * 0.5);
    it.mesh.visible = true;
    return it;
  }
  // 一道从天而降的锯齿落雷：分 n 段，每段横向抖开一点，底下再向两侧岔出两道贴地的小电弧
  function skyBolt(x, z, hex, top, n, hw) {
    let px = x + rand(-0.6, 0.6), py = top, pz = z;
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const nx = i === n ? x : x + rand(-0.9, 0.9) * (1 - k * 0.6);
      const ny = top * (1 - k);
      vstreak(px, py, pz, nx, ny, z, hw * (1 - k * 0.35), hex, 0.22);
      px = nx;
      py = ny;
    }
  }

  // ----- 千刃归烬 -----
  // 斩痕：挂在被闪过的敌人身上的一道余烬色细光（一直跟着它），收刀那一刻随斩痕一齐炸开（ashClear）
  const ASH_N = 36;
  const ashMarks = [];
  let ashTex = null;
  function ashMarkTex() {
    if (ashTex) return ashTex;
    const c = makeCanvas(128, 32), g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 128, 0);
    gr.addColorStop(0, 'rgba(255,120,40,0)');
    gr.addColorStop(0.2, 'rgba(255,150,60,0.9)');
    gr.addColorStop(0.5, 'rgba(255,240,215,1)');
    gr.addColorStop(0.8, 'rgba(255,150,60,0.9)');
    gr.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(0, 16);
    g.quadraticCurveTo(64, 6, 128, 16);
    g.quadraticCurveTo(64, 26, 0, 16);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.fillRect(28, 15, 72, 2);
    ashTex = new T.CanvasTexture(c);
    return ashTex;
  }
  function ashGet() {
    for (let i = 0; i < ashMarks.length; i++) if (!ashMarks[i].on) return ashMarks[i];
    if (ashMarks.length >= ASH_N) return null;
    const mat = new T.SpriteMaterial({ map: ashMarkTex(), color: lin(0xffc890), transparent: true, blending: T.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false, fog: false });
    const sp = new T.Sprite(mat);
    sp.renderOrder = 7;
    sp.visible = false;
    scene.add(sp);
    const m = { sp, mat, on: false, ent: null, t: 0, y: 1, len: 1.6, pop: 0 };
    ashMarks.push(m);
    return m;
  }
  W.ashMark = function (ent, ang, n, h) {
    if (!ent || ent.removed) return;
    const m = ashGet();
    if (!m) return;
    m.on = true;
    m.ent = ent;
    m.t = 0;
    m.pop = 0;
    m.y = (h || 2) * rand(0.32, 0.72);
    m.len = 2.0 + Math.min(1.8, (h || 2) * 0.4);
    m.mat.rotation = rand(-1.2, 1.2);
    m.sp.visible = true;
    const g = ent.group.position;
    flare(g.x, m.y, g.z, EMBER, 1.2, 0.08);
  };
  // 收刀：所有斩痕骤亮一下再散掉
  W.ashClear = function () {
    for (const m of ashMarks) if (m.on && !m.pop) m.pop = 0.001;
  };
  function updateAshMarks(dt) {
    for (const m of ashMarks) {
      if (!m.on) continue;
      m.t += dt;
      const e = m.ent;
      if (m.pop > 0) m.pop += dt;
      if (!e || e.removed || m.t > 4 || m.pop > 0.16) {
        m.on = false;
        m.ent = null;
        m.sp.visible = false;
        continue;
      }
      const g = e.group.position;
      m.sp.position.set(g.x, m.y, g.z);
      // 出现时从一点拉开，挂着的时候微微呼吸；收刀时骤亮变粗
      const open = Math.min(1, m.t / 0.07);
      const breathe = 0.85 + 0.15 * Math.sin(m.t * 18);
      const pk = m.pop > 0 ? 1 + m.pop * 9 : 1;
      m.sp.scale.set(m.len * open * (m.pop > 0 ? 1.25 : 1), 0.42 * breathe * pk, 1);
      m.mat.opacity = m.pop > 0 ? 1 - m.pop / 0.16 : 0.75 + 0.25 * breathe;
    }
  }
  // 一闪的路径：两道余烬色的残影、一条贴地的光带、一路火星
  W.ashDash = function (ent, x0, z0, x1, z1, hex) {
    const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz);
    const ang = Math.atan2(dx, dz);
    if (ent) for (let i = 0; i < 3; i++) W.afterimage(ent, x0 + dx * (0.2 + i * 0.28), z0 + dz * (0.2 + i * 0.28), i ? hex : EMBER_HI, 0.45 + i * 0.12, 0.2 + i * 0.06, 0);
    if (d > 0.2) {
      streak(x0, z0, 1.05, ang, d, 0.32, EMBER_HI, 0.26, 0, 0);
      streak(x0, z0, 0.12, ang, d, 0.5, EMBER, 0.5, 0, 0);
    }
    const n = Math.max(4, Math.ceil(d * 4));
    for (let i = 0; i < n; i++) {
      const k = i / n, warm = i % 3 !== 0;
      spawnP(x0 + dx * k + rand(-0.2, 0.2), rand(0.3, 1.7), z0 + dz * k + rand(-0.2, 0.2), (dx / (d || 1)) * rand(1, 4), rand(0, 1.4), (dz / (d || 1)) * rand(1, 4), rand(0.25, 0.5), rand(0.12, 0.22), 1, warm ? 0.62 : 0.95, warm ? 0.26 : 0.85, -0.6, 2.2);
    }
    flare(x1, 1.1, z1, hex, 1.3, 0.08);
  };
  // 收刀：delay 秒里四周的火星朝你收拢，脚下一道收紧的细环
  W.ashSheathe = function (x, z, delay) {
    const T0 = Math.max(0.12, delay);
    for (let i = 0; i < 26; i++) {
      const a = rand(0, TAU), r = rand(2.2, 4);
      spawnP(x + Math.sin(a) * r, rand(0.3, 2), z + Math.cos(a) * r, (-Math.sin(a) * r) / T0, rand(-0.3, 0.3), (-Math.cos(a) * r) / T0, T0, rand(0.1, 0.18), 1, 0.7, 0.35, 0, 0);
    }
    W.ring(x, z, 3.2, EMBER, T0);
  };
  // 斩痕齐爆：n 道刀光交叉斩过（越多越密），白热的一团火花，地上一道冲击环；吃掉残刃（mk）时再多一圈金色的刃光
  W.ashBurst = function (x, z, h, r, n, mk) {
    const y = Math.min(2.4, (h || 2) * 0.55), rr = r || 0.6;
    flashLight(x, y + 1.2, z, EMBER, 2.2);
    flare(x, y, z, EMBER, 2.2 + rr + Math.min(6, n) * 0.2, 0.16);
    const cnt = Math.min(8, 2 + n);
    const a0 = rand(0, TAU);
    for (let i = 0; i < cnt; i++) {
      const a = a0 + (i / cnt) * Math.PI + rand(-0.15, 0.15), len = 2.2 + rr * 2.2;
      streak(x - Math.sin(a) * len * 0.5, z - Math.cos(a) * len * 0.5, y * (0.6 + 0.5 * (i / cnt)), a, len, 0.42, i % 2 ? EMBER_HI : EMBER, 0.3, 0, 0);
    }
    // 竖着劈下的两道
    vstreak(x - 0.9, y + 1.6, z, x + 0.9, 0.2, z, 0.35, EMBER_HI, 0.24);
    vstreak(x + 0.8, y + 1.5, z, x - 0.7, 0.2, z, 0.3, EMBER, 0.24);
    W.ring(x, z, rr + 2.2, EMBER, 0.36);
    W.ring(x, z, rr + 1.2, EMBER_HI, 0.22);
    W.decal(0, x, z, rr + 1.4, a0, EMBER, 1.6, 0.35);
    W.burst(x, y, z, 0xfff0d0, 12 + Math.min(6, n) * 2, 9, 0.4);
    W.burst(x, y, z, EMBER, 22 + Math.min(6, n) * 3, 7, 0.6);
    if (mk > 0) {
      for (let i = 0; i < Math.min(5, mk); i++) W.slash(x, z, a0 + (i / 5) * TAU, 1.5 + rr, 80, i % 2 ? 0xffe2b8 : 0xffc27a, { y: y * (0.8 + 0.1 * i), dur: 0.24, inner: 0.5, dir: i % 2 ? -1 : 1 });
      W.ring(x, z, rr + 3, 0xffc27a, 0.42);
    }
  };

  // ----- 三相天灾 -----
  // 地上的三相法阵：外圈三段（火 / 冰 / 雷）顺转，内圈反转，中间一个旋转的三角，风暴结束前淡出
  const TRI_FRAG = [
    'uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform float uA; uniform float uRot; varying vec2 vP;',
    'vec3 pick(float s){ return s < 1.0 ? uC0 : (s < 2.0 ? uC1 : uC2); }',
    'void main(){',
    '  float l = length(vP);',
    '  if (l > 1.0) discard;',
    '  float an = atan(vP.x, vP.y) / 6.2831853 + 0.5;',
    '  float s1 = fract(an + uRot * 0.15) * 3.0;',
    '  float g1 = smoothstep(0.0, 0.04, fract(s1)) * (1.0 - smoothstep(0.92, 1.0, fract(s1)));',
    '  float r1 = (1.0 - smoothstep(0.0, 0.025, abs(l - 0.94))) * g1;',
    '  float r1b = (1.0 - smoothstep(0.0, 0.01, abs(l - 0.88))) * 0.5;',
    '  float s2 = fract(an - uRot * 0.27) * 3.0;',
    '  float tick = pow(abs(sin((an - uRot * 0.27) * 3.14159 * 24.0)), 30.0) * smoothstep(0.56, 0.6, l) * (1.0 - smoothstep(0.66, 0.7, l));',
    '  float r2 = (1.0 - smoothstep(0.0, 0.016, abs(l - 0.63))) + tick * 0.8;',
    // 旋转的等边三角：到三条边的距离
    '  float ca = cos(uRot * 0.6), sa = sin(uRot * 0.6);',
    '  vec2 q = vec2(ca * vP.x - sa * vP.y, sa * vP.x + ca * vP.y);',
    '  float d = 1e3;',
    '  for (int i = 0; i < 3; i++) { float a = float(i) * 2.0943951; vec2 n = vec2(sin(a), cos(a)); d = min(d, abs(dot(q, n) + 0.3)); }',
    '  float tri = (1.0 - smoothstep(0.0, 0.014, d)) * (1.0 - smoothstep(0.58, 0.62, l));',
    '  float fill = smoothstep(0.2, 1.0, l) * 0.07;',
    '  vec3 c1 = pick(s1), c2 = pick(s2);',
    '  vec3 col = c1 * (r1 * 1.2 + r1b) + c2 * r2 * 0.9 + mix(c1, vec3(1.0), 0.5) * tri * 0.8 + c1 * fill;',
    '  float a = clamp((r1 + r1b * 0.6 + r2 * 0.8 + tri * 0.7 + fill) * uA, 0.0, 1.0);',
    '  if (a < 0.003) discard;',
    '  gl_FragColor = vec4(col / max(0.001, r1 * 1.2 + r1b + r2 * 0.9 + tri * 0.8 + fill), a);',
    '}',
  ].join('\n');
  const storms = [];
  const STORM_HEX = [0xff7a2c, 0x7fd4ff, 0xffe45e];
  W.triStorm = function (x, z, R, dur) {
    let s = null;
    for (const it of storms) if (!it.on) { s = it; break; }
    if (!s) {
      const u = { uC0: { value: lin(STORM_HEX[0]) }, uC1: { value: lin(STORM_HEX[1]) }, uC2: { value: lin(STORM_HEX[2]) }, uA: { value: 0 }, uRot: { value: 0 } };
      const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: FX_VERT, fragmentShader: TRI_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
      const mesh = new T.Mesh(gQuad(), mat);
      mesh.renderOrder = 3;
      mesh.visible = false;
      scene.add(mesh);
      s = { mesh, u, on: false, t: 0, dur: 1, x: 0, z: 0, R: 1, acc: 0, flash: 0 };
      storms.push(s);
    }
    s.on = true;
    s.t = 0;
    s.dur = dur;
    s.x = x;
    s.z = z;
    s.R = R;
    s.acc = 0;
    s.flash = 0;
    s.mesh.position.set(x, 0.09, z);
    s.mesh.scale.set(R, 1, R);
    s.mesh.visible = true;
    for (let i = 0; i < 3; i++) W.ring(x, z, R * (1 - i * 0.18), STORM_HEX[i], 0.5 + i * 0.1);
    flashLight(x, 4, z, 0xffe8d0, 2);
  };
  function updateStorms(dt) {
    for (const s of storms) {
      if (!s.on) continue;
      s.t += dt;
      if (s.t >= s.dur) {
        s.on = false;
        s.mesh.visible = false;
        continue;
      }
      const k = s.t / s.dur;
      s.u.uA.value = Math.min(1, s.t / 0.25) * (1 - smooth01((k - 0.85) / 0.15));
      s.u.uRot.value = s.t * 2.2;
      s.mesh.scale.setScalar(s.R * (0.85 + 0.15 * Math.min(1, s.t / 0.3)));
      s.mesh.scale.y = 1;
      if (k > 0.9) continue;
      // 头顶压着一团翻滚的暗云，云里三色电光乱闪；地面上三色的流光绕着圈往里旋
      s.acc += dt;
      while (s.acc > 0.035) {
        s.acc -= 0.035;
        const a = rand(0, TAU), d = Math.sqrt(Math.random()) * s.R * 1.05;
        spawnS(s.x + Math.sin(a) * d, rand(5.6, 6.6), s.z + Math.cos(a) * d * 0.7, rand(-0.6, 0.6), rand(-0.1, 0.2), rand(-0.6, 0.6), rand(1.0, 1.5), rand(2.2, 3.4), 0.24, 0.21, 0.3, 0.8);
        smokeLive = 1.5;
        const t = (Math.random() * 3) | 0, b = rand(0, TAU), r0 = s.R * rand(0.8, 1.0);
        _c.set(STORM_HEX[t]);
        spawnP(s.x + Math.sin(b) * r0, 0.25, s.z + Math.cos(b) * r0, Math.cos(b) * 3 - Math.sin(b) * 1.5, rand(0.4, 1.4), -Math.sin(b) * 3 - Math.cos(b) * 1.5, rand(0.4, 0.7), rand(0.12, 0.2), _c.r, _c.g, _c.b, -0.3, 1.2);
      }
      s.flash -= dt;
      if (s.flash <= 0) {
        s.flash = rand(0.08, 0.2);
        const a = rand(0, TAU), d = Math.sqrt(Math.random()) * s.R;
        const hx = STORM_HEX[(Math.random() * 3) | 0];
        flare(s.x + Math.sin(a) * d, rand(5.6, 6.4), s.z + Math.cos(a) * d * 0.7, hx, rand(2.5, 4.5), 0.12);
      }
    }
  }
  // 冰棱：从云里直坠下来的一根冰晶（落地时由 triStrikeLand 炸开）
  const icicles = [];
  let iceMat = null;
  function icicleGet() {
    for (const it of icicles) if (!it.on) return it;
    if (!iceMat) iceMat = new T.MeshStandardMaterial({ color: lin(0xcff2ff), emissive: lin(0x5fc8ff), emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.92, flatShading: true });
    const mesh = new T.Mesh(gOct(0.5), iceMat);
    mesh.scale.set(0.55, 2.6, 0.55);
    mesh.visible = false;
    scene.add(mesh);
    const glow = new T.Sprite(spriteMat(0x7fd4ff));
    glow.scale.setScalar(2.4);
    mesh.add(glow);
    const it = { mesh, on: false, t: 0, dur: 0.2, x: 0, z: 0 };
    icicles.push(it);
    return it;
  }
  function updateIcicles(dt) {
    for (const it of icicles) {
      if (!it.on) continue;
      it.t += dt;
      const k = Math.min(1, it.t / it.dur);
      const y = 0.9 + 5.4 * (1 - k * k);
      it.mesh.position.set(it.x, y, it.z);
      it.mesh.rotation.y += dt * 6;
      spawnP(it.x + rand(-0.2, 0.2), y + 1, it.z + rand(-0.2, 0.2), 0, rand(1, 3), 0, rand(0.15, 0.3), rand(0.12, 0.2), 0.8, 0.95, 1, 0, 2);
      if (k >= 1) {
        it.on = false;
        it.mesh.visible = false;
      }
    }
  }
  // 风暴的一击开始落下：t = 'fire' 陨火 / 'cold' 冰棱 / 'light' 云里先蓄一下光（落雷是瞬间的，在落地那一刻劈下）
  W.triStrike = function (x, z, t, r, fall) {
    if (t === 'fire') W.meteorFall(x, z, fall, STORM_HEX[0]);
    else if (t === 'cold') {
      const it = icicleGet();
      it.on = true;
      it.t = 0;
      it.dur = Math.max(0.05, fall);
      it.x = x;
      it.z = z;
      it.mesh.visible = true;
      it.mesh.position.set(x, 6.3, z);
    } else {
      flare(x, 6, z, STORM_HEX[2], 3.6, Math.max(0.08, fall));
      W.decal(3, x, z, r * 0.6, rand(0, TAU), STORM_HEX[2], fall + 0.3);
    }
  };
  W.triStrikeLand = function (x, z, t, r) {
    const hx = STORM_HEX[t === 'fire' ? 0 : t === 'cold' ? 1 : 2];
    W.ring(x, z, r, hx, 0.3);
    if (t === 'fire') {
      W.decal(1, x, z, r * 0.7, rand(0, TAU), hx, 2.2);
      W.burst(x, 0.6, z, 0xffb070, 14, 6, 0.45);
    } else if (t === 'cold') {
      W.decal(2, x, z, r * 0.85, rand(0, TAU), 0x9fdcff, 2.4);
      flare(x, 0.8, z, 0xd6f3ff, 2.4, 0.12);
      _c.set(0xd6f3ff);
      for (let i = 0; i < 18; i++) {
        const a = rand(0, TAU), v = rand(3, 7);
        spawnP(x, 0.5, z, Math.sin(a) * v, rand(2, 6), Math.cos(a) * v, rand(0.35, 0.7), rand(0.14, 0.26), _c.r, _c.g, _c.b, 12, 1.5);
      }
      flashLight(x, 2, z, hx, 1.6);
    } else {
      skyBolt(x, z, hx, 6.2, 4, 0.55);
      skyBolt(x, z, 0xffffff, 6.2, 3, 0.18);
      const a = rand(0, TAU);
      W.bolt([{ x, z }, { x: x + Math.sin(a) * r * 1.3, z: z + Math.cos(a) * r * 1.3 }], hx, true);
      W.bolt([{ x, z }, { x: x - Math.sin(a + 0.6) * r * 1.2, z: z - Math.cos(a + 0.6) * r * 1.2 }], hx, true);
      flare(x, 1.0, z, 0xffffff, 3, 0.12);
      flashLight(x, 3, z, hx, 2.6);
      W.burst(x, 0.8, z, hx, 16, 7, 0.35);
    }
  };

  // ----- 万魂降临 -----
  // 插旗：准星处一个大的魂火法阵（借召唤的法阵），一圈魂火青 + 余烬橙的冲击环，一道从你的幡头连到法阵的魂流
  W.soulHost = function (x, z, R, fx, fz) {
    W.summonFx(x, z, true);
    W.ring(x, z, R, ALLY_HEX, 0.7);
    W.ring(x, z, R * 0.7, EMBER, 0.55);
    W.ring(fx, fz, 2.6, ALLY_HI, 0.45);
    W.decal(5, fx, fz, 1.6, rand(0, TAU), 0x9fe8da, 2.5);
    flashLight(x, 3, z, ALLY_HEX, 2.6);
    const dx = x - fx, dz = z - fz, d = Math.hypot(dx, dz) || 1;
    for (let i = 0; i < 30; i++) {
      const k = i / 30, warm = i % 4 === 0;
      spawnP(fx + dx * k, 0.4 + Math.sin(k * Math.PI) * 2.2, fz + dz * k, (dx / d) * 4, rand(0.5, 1.5), (dz / d) * 4, rand(0.5, 0.8), rand(0.16, 0.26), warm ? 1 : ALLY_RGB.r, warm ? 0.62 : ALLY_RGB.g, warm ? 0.3 : ALLY_RGB.b, -0.6, 1);
    }
    for (let i = 0; i < 40; i++) {
      const a = rand(0, TAU), r = Math.sqrt(Math.random()) * R;
      spawnP(x + Math.sin(a) * r, 0.15, z + Math.cos(a) * r, 0, rand(3, 7), 0, rand(0.6, 1.2), rand(0.14, 0.28), ALLY_RGB.r, ALLY_RGB.g, ALLY_RGB.b, -1.5, 0.8);
    }
  };
  // 一位英灵从天而降：一道魂火青的天光柱直劈到落点，外面裹一层余烬橙，落点亮起召唤法阵
  W.champFx = function (x, z) {
    vstreak(x, 15, z, x, 0, z, 0.9, ALLY_HEX, 0.5);
    vstreak(x, 15, z, x, 0, z, 0.3, ALLY_HI, 0.4);
    vstreak(x + 0.25, 13, z, x, 0, z, 1.4, EMBER, 0.35);
    W.summonFx(x, z, false);
    flare(x, 0.6, z, ALLY_HI, 2.6, 0.16);
  };
  // 英灵落地一砸：冲击环、地裂、扬尘
  W.champLand = function (x, z, R) {
    W.ring(x, z, R, ALLY_HEX, 0.38);
    W.ring(x, z, R * 0.6, EMBER, 0.3);
    W.decal(5, x, z, R * 0.75, rand(0, TAU), 0x9fe8da, 2.2);
    W.burst(x, 0.3, z, 0xcbbba6, 12, 5, 0.45);
    W.burst(x, 1.0, z, ALLY_HEX, 14, 5, 0.4);
    W.shake(0.12);
  };
  // 英灵时间到了消散：魂火往上飘散
  W.champFade = function (x, z, h) {
    for (let i = 0; i < 24; i++) {
      const a = rand(0, TAU), d = rand(0.1, 0.6), warm = i % 4 === 0;
      spawnP(x + Math.sin(a) * d, rand(0.2, h || 2.4), z + Math.cos(a) * d, Math.sin(a) * 0.6, rand(2, 4.5), Math.cos(a) * 0.6, rand(0.6, 1.1), rand(0.14, 0.24), warm ? 1 : ALLY_RGB.r, warm ? 0.62 : ALLY_RGB.g, warm ? 0.3 : ALLY_RGB.b, -1, 1);
    }
  };
  // 现有召唤物被治疗：身上一道往上冲的魂火青光
  W.soulHeal = function (ent, x, z, h) {
    flare(x, (h || 2) * 0.6, z, ALLY_HI, 1.6, 0.14);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      spawnP(x + Math.sin(a) * 0.55, 0.2, z + Math.cos(a) * 0.55, 0, rand(3, 5), 0, rand(0.35, 0.55), rand(0.12, 0.2), 0.75, 1, 0.9, -1, 1);
    }
  };

  function updateUfx(dt) {
    updateAshMarks(dt);
    updateStorms(dt);
    updateIcicles(dt);
  }
  function clearUfx() {
    for (const m of ashMarks) { m.on = false; m.ent = null; m.sp.visible = false; }
    for (const s of storms) { s.on = false; s.mesh.visible = false; }
    for (const it of icicles) { it.on = false; it.mesh.visible = false; }
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

  // =====================================================================
  // 混沌特效（混沌流）：黑洞、黑旋风、黑焰、渊缚、渊陷
  // =====================================================================
  // 卡通特效的写法：硬边色带、三档阶梯透明度、普通混合（「黑」不能用加色画）。核是近黑的 CH_CORE，外面一道品红 CH_RIM，
  // 最外一条亮芯 CH_HI（灰度约 87%，特效高光段）。全部预分配：黑洞圆盘最多 5 个、漩涡最多 6 团，用完复用；低画质少画零件
  const CH_CORE = 0x12061a, CH_RIM = 0xf03cb4, CH_HI = 0xffd2f2, CH_DARK = 0x3a0c46;
  // 黑洞圆盘：核占 55%，中间一圈是转着的螺旋缝（uSp 条），外缘品红 + 亮芯细边；uA 是整体的三档不透明度（开合时跳档）
  const HOLE_FRAG = [
    'uniform vec3 uCore; uniform vec3 uRim; uniform vec3 uHi; uniform float uA; uniform float uSp; uniform float uTime; varying vec2 vP;',
    'void main(){',
    '  float l = length(vP);',
    '  if (l > 1.0) discard;',
    '  float an = atan(vP.x, vP.y) / 6.2831853;',
    '  float sp = fract(an * uSp + l * 1.7 + uTime * 0.85);', // 螺旋缝：越往里转得越紧
    '  vec3 col = uCore; float a = 0.94;',
    '  if (l > 0.94) { col = uHi; a = 0.92; }',
    '  else if (l > 0.84) { col = uRim; a = 0.9; }',
    '  else if (l > 0.55) { if (sp < 0.2) { col = uRim; a = 0.86; } else { col = uCore; a = 0.62; } }',
    '  gl_FragColor = vec4(col, a * uA);',
    '}',
  ].join('\n');
  // 漩涡：上宽下窄的开口圆台，绕着身子的斜条纹往上卷（亮芯 / 品红 / 近黑三档），顶上一段降到三成不透明
  const VORTEX_VERT = 'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const VORTEX_FRAG = [
    'uniform vec3 uCore; uniform vec3 uRim; uniform vec3 uHi; uniform float uTime; uniform float uPh; varying vec2 vUv;',
    'void main(){',
    '  float s = fract(vUv.x * 3.0 + vUv.y * 1.4 - uTime * 2.6 + uPh);', // uPh：同一次施放的几团各错开一点相位
    '  vec3 col = s < 0.16 ? uHi : (s < 0.5 ? uRim : uCore);',
    '  float a = vUv.y > 0.82 ? 0.32 : (vUv.y > 0.55 ? 0.62 : 0.9);',
    '  if (s >= 0.5 && vUv.y > 0.55) discard;', // 上半截只留亮条：漏斗口是一圈卷起来的条纹，不是一面墙
    '  gl_FragColor = vec4(col, a);',
    '}',
  ].join('\n');
  const chHoles = [], chVorts = [];
  const flame = { on: false, acc: 0 };
  function chUniforms(extra) {
    const u = { uCore: { value: new T.Color(CH_CORE) }, uRim: { value: new T.Color(CH_RIM) }, uHi: { value: new T.Color(CH_HI) }, uTime };
    return Object.assign(u, extra || {});
  }
  W.makeHole = function (x, z, R, mouth) {
    let h = chHoles.find((o) => !o.on);
    if (!h) {
      if (chHoles.length >= 5) {
        h = chHoles[0];
      } else {
        const u = chUniforms({ uA: { value: 0 }, uSp: { value: 6 } });
        const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: FX_VERT, fragmentShader: HOLE_FRAG, transparent: true, depthWrite: false, side: T.DoubleSide });
        const mesh = new T.Mesh(gQuad(), mat);
        mesh.renderOrder = 3;
        mesh.visible = false;
        scene.add(mesh);
        h = { mesh, u, on: false };
        chHoles.push(h);
      }
    }
    h.on = true;
    h.x = x;
    h.z = z;
    h.R = R;
    h.k = 0;
    h.acc = 0;
    h.u.uSp.value = qualId === 'low' ? 3 : 6;
    h.mesh.position.set(x, 0.07, z);
    h.mesh.scale.set(0.01, 1, 0.01);
    h.mesh.visible = true;
    W.ring(x, z, R, CH_RIM, 0.3);
    return h;
  };
  // k：0..1 的进度。开（前 12%）和合（后 12%）时半径缩放、不透明度按 1 / 0.62 / 0.3 三档跳；高画质从外圈吸进尖片
  W.updateHole = function (h, k, dt) {
    if (!h || !h.on) return;
    h.k = k;
    const open = k < 0.12 ? k / 0.12 : k > 0.88 ? (1 - k) / 0.12 : 1;
    const s = h.R * (0.35 + 0.65 * open);
    h.mesh.scale.set(s, 1, s);
    h.mesh.rotation.y -= dt * 1.4;
    h.u.uA.value = open > 0.66 ? 1 : open > 0.33 ? 0.62 : 0.3;
    if (qualId === 'low') return;
    h.acc += dt * 10;
    while (h.acc > 1) {
      h.acc -= 1;
      const a = rand(0, TAU), d = h.R * rand(0.9, 1.25), v = rand(4, 6.5);
      tChunk(0, h.x + Math.sin(a) * d, rand(0.15, 0.6), h.z + Math.cos(a) * d, -Math.sin(a) * v, rand(0, 0.6), -Math.cos(a) * v, (d / v) * 0.8, rand(0.14, 0.22), CH_HI, CH_RIM, 0);
    }
  };
  W.removeHole = function (h) {
    if (!h || !h.on) return;
    h.on = false;
    h.mesh.visible = false;
    W.ring(h.x, h.z, h.R * 0.55, CH_RIM, 0.3); // 合上时往里一收
  };
  W.holeCount = () => chHoles.filter((h) => h.on).length;

  // i：同一次施放里的第几团（多重投射）。相位、转向、高矮各错开一点，几团挨在一起时不会糊成一个盘
  W.makeVortex = function (x, z, R, i) {
    let v = chVorts.find((o) => !o.on);
    if (!v) {
      if (chVorts.length >= 6) {
        v = chVorts[0];
      } else {
        const lo = qualId === 'low';
        const geo = new T.CylinderGeometry(1, 0.28, 1, lo ? 8 : 12, 1, true);
        geo.translate(0, 0.5, 0);
        const u = chUniforms({ uPh: { value: 0 } });
        const mat = new T.ShaderMaterial({ uniforms: u, vertexShader: VORTEX_VERT, fragmentShader: VORTEX_FRAG, transparent: true, depthWrite: false, side: T.DoubleSide });
        const mesh = new T.Mesh(geo, mat);
        mesh.renderOrder = 4;
        mesh.visible = false;
        scene.add(mesh);
        v = { mesh, u, on: false };
        chVorts.push(v);
      }
    }
    v.on = true;
    v.R = R;
    v.acc = 0;
    const k = i || 0;
    v.dir = k % 2 ? -1 : 1;
    v.u.uPh.value = k * 0.37;
    v.mesh.rotation.y = k * 1.3;
    v.mesh.position.set(x, 0.05, z);
    v.mesh.scale.set(R * (1 - 0.06 * (k % 3)), 2.4 * (1 - 0.12 * (k % 3)), R * (1 - 0.06 * (k % 3)));
    v.mesh.visible = true;
    return v;
  };
  W.updateVortex = function (v, x, z, dt) {
    if (!v || !v.on) return;
    v.mesh.position.set(x, 0.05, z);
    v.mesh.rotation.y += dt * 9 * (v.dir || 1);
    // 甩出的尖片：高画质每 0.06 秒一片，低画质 0.12 秒
    v.acc += dt * (qualId === 'low' ? 8 : 16);
    while (v.acc > 1) {
      v.acc -= 1;
      const a = rand(0, TAU), w = rand(3, 5.5);
      tChunk(0, x + Math.sin(a) * v.R * 0.8, rand(0.3, 1.8), z + Math.cos(a) * v.R * 0.8, Math.cos(a) * w, rand(0.5, 2), -Math.sin(a) * w, rand(0.2, 0.32), rand(0.14, 0.2), CH_HI, CH_RIM, 4);
    }
  };
  W.removeVortex = function (v) {
    if (!v || !v.on) return;
    v.on = false;
    v.mesh.visible = false;
    tPuffs(v.mesh.position.x, 0.4, v.mesh.position.z, qualId === 'low' ? 1 : 3, 1.4, 0.8, 0.35, 0.3, CH_DARK, CH_CORE);
  };
  W.vortexCount = () => chVorts.filter((v) => v.on).length;

  // 黑焰：玩家身上往上飘的几缕黑焰（暗紫的烟团 + 品红转近黑的尖片），高画质每 0.2 秒 2 粒、低画质每 0.4 秒 1 粒
  W.setFlame = function (on) {
    flame.on = !!on;
  };
  W.flameOn = () => flame.on;
  function updateFlame(dt) {
    const P = G.player;
    if (!flame.on || !P || !P.ent || !P.ent.group.visible) return;
    flame.acc += dt * (qualId === 'low' ? 2.5 : 14);
    while (flame.acc > 1) {
      flame.acc -= 1;
      const a = rand(0, TAU), d = rand(0.2, 0.55), x = P.x + Math.sin(a) * d, z = P.z + Math.cos(a) * d;
      // 暗紫的烟团垫底（形状），品红转近黑的尖片往上窜（亮芯那一档是特效高光段）
      if (Math.random() < 0.45) tChunk(2, x, rand(0.4, 1.5), z, 0, 0, 0, rand(0.55, 0.8), rand(0.3, 0.42), CH_RIM, CH_CORE, -1.6);
      else tChunk(0, x, rand(0.3, 1.2), z, rand(-0.3, 0.3), rand(1.8, 2.8), rand(-0.3, 0.3), rand(0.45, 0.65), rand(0.18, 0.26), CH_HI, CH_RIM, -0.5);
    }
  }
  // 渊缚：脚下一道品红的细环，几片往身上吸的尖片；首领的环大一圈
  // 低画质不画：怪堆里渊缚接连触发时，每道环都是一次 draw call（飘字「渊缚」和头顶的第四段异常条照样有）
  W.bindFx = function (x, z, r, h, boss) {
    if (qualId === 'low') return;
    W.ring(x, z, r + (boss ? 1.4 : 0.9), CH_RIM, 0.3);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + rand(-0.3, 0.3), d = r + 1.2, v = rand(4, 6);
      tChunk(0, x + Math.sin(a) * d, h * 0.4, z + Math.cos(a) * d, -Math.sin(a) * v, 0, -Math.cos(a) * v, 0.22, 0.18, CH_HI, CH_RIM, 0);
    }
  };
  // 渊陷：尸体处一圈往里收的环 + 往里吸的尖片
  W.voidFx = function (x, z, R) {
    W.ring(x, z, R, CH_RIM, 0.35);
    if (qualId === 'low') return;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + rand(-0.3, 0.3), v = rand(5, 8);
      tChunk(0, x + Math.sin(a) * R, 0.5, z + Math.cos(a) * R, -Math.sin(a) * v, rand(0, 1), -Math.cos(a) * v, R / v, 0.2, CH_HI, CH_RIM, 0);
    }
  };
  function updateChaosFx(dt) {
    updateFlame(dt);
  }

  // ---------- 每帧更新 ----------
  function spawnAmbient(fx) {
    const x = camT.x + rand(-26, 26), z = camT.z + CAM_LEAD + rand(-22, 13);
    const mode = fx.st.amb;
    if (mode === 'snow') {
      spawnP(x, rand(5, 9), z, rand(0.4, 1.2), rand(-2.6, -1.5), rand(-0.2, 0.5), rand(2.6, 4), rand(0.09, 0.17), 0.62, 0.74, 0.85, 0, 0);
    } else if (mode === 'spark') {
      spawnP(x, rand(0.2, 3.5), z, rand(-2, 2), rand(-1, 2), rand(-2, 2), rand(0.3, 0.8), rand(0.08, 0.16), fx.ar, fx.ag, fx.ab, 0, 0.5);
    } else if (mode === 'mote') {
      // 星尘：从琉璃地面的裂缝里缓缓升起，偶尔一粒偏白
      const w = Math.random() < 0.3 ? 0.6 : 0;
      spawnP(x, rand(0.05, 0.6), z, rand(-0.2, 0.2), rand(0.35, 0.95), rand(-0.2, 0.2), rand(3, 5.5), rand(0.06, 0.14), fx.ar + (1 - fx.ar) * w, fx.ag + (1 - fx.ag) * w, fx.ab + (1 - fx.ab) * w, -0.05, 0.25);
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
      shakeAmt *= Math.exp(-raw * 10);
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
    const texel = (SHADOW_HALF * 2) / sun.shadow.mapSize.x;
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
      if (fx.fires) updateFires(fx.fires, dt);
      if (fx.dress) updateAshDress(fx.dress);
      if (fx.gU) fx.gU.uLavaM.value.y = wtime;
      fx.glowMat.opacity = 0.38 + Math.sin(wtime * 1.7) * 0.08;
      fx.bossSigil.material.opacity = 0.24 + Math.sin(wtime * 1.2) * 0.07;
      fx.bossSigil.rotation.y += dt * 0.04;
      let hi = hemiBase;
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
      if (fx.isles) {
        // 坠星裂谷：浮岩起伏、天穹碎片呼吸、天边不时划过一颗流星
        for (let i = 0; i < fx.isles.length; i++) {
          const q = fx.isles[i];
          q.m.position.y = q.y + Math.sin(wtime * q.sp + q.ph) * 0.35;
          q.m.rotation.y += dt * q.rot;
        }
        fx.skyMat.emissiveIntensity = 0.5 + Math.sin(wtime * 1.3) * 0.15;
        fx.starIn -= dt;
        if (fx.starIn <= 0) {
          fx.starIn = rand(2.5, 6);
          const sx = camT.x + rand(-16, 16), sy = rand(5, 8), sz = camT.z - rand(6, 13), dx = rand(0.6, 1) * (Math.random() < 0.5 ? -1 : 1), dy = -0.32, dz = 0.2, v = 24;
          for (let i = 0; i < 16; i++) {
            const w = 1 - i / 16;
            spawnP(sx - dx * i * 0.22, sy - dy * i * 0.22, sz - dz * i * 0.22, dx * v, dy * v, dz * v, 0.25 + 0.4 * w, 0.06 + 0.16 * w, fx.ar + (1 - fx.ar) * w, fx.ag + (1 - fx.ag) * w, fx.ab + (1 - fx.ab) * w, 0, 0);
          }
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
    updateAura(dt);
    updateMeteors(dt);
    updateSummons(dt);
    updateFocus(raw);
    updateMarks(raw);
    updateWeaponFx(dt);
    updateChaosFx(dt);
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
        // 卡通版：两档跳变（前 55% 全亮，之后半亮），不是平滑渐隐
        const f = e.flashK * (e.flashT / e.flashD > 0.45 ? 1 : 0.45), ms = e.mats;
        for (let j = 0; j < ms.length; j++) ms[j].emissiveIntensity = ms[j].userData.fi * f;
      }
    }

    // 投射物：外形、拖尾、陨石尾焰、碎石（实例化，见 updateProjFx）
    updateProjFx(dt);

    // 掉落物：落地弹出，然后悬浮旋转
    for (let i = 0; i < lootObjs.length; i++) {
      const g = lootObjs[i], u = g.userData;
      u.t += dt;
      const k = Math.min(1, u.t / 0.32);
      g.scale.setScalar(k < 1 ? 0.2 + 0.8 * k + Math.sin(k * Math.PI) * 0.25 : 1);
      u.gem.position.y = 0.55 + Math.sin(u.t * 2.4 + u.ph) * 0.09 + (k < 1 ? Math.sin(k * Math.PI) * 0.9 : 0);
      u.gem.rotation.y += dt * u.spin;
      if (u.ember >= 0) {
        // 烬铸：光晕一呼一吸，火星从地面光盘里往上飘
        if (u.glow) u.glow.scale.setScalar(1.1 + Math.sin(u.t * 3.1) * 0.2);
        u.ember += dt * 34;
        const p = g.position;
        while (u.ember >= 1 && u.frost) {
          // 霜晶：慢慢升起、一路减速的冷蓝细点，偶尔一粒亮白
          u.ember -= 1;
          if (Math.random() < 0.4) continue; // 比火星稀一些
          const a = rand(0, TAU), d = Math.sqrt(Math.random()) * 1.1, w = Math.random() < 0.2;
          spawnP(p.x + Math.sin(a) * d, 0.1 + Math.random() * 0.5, p.z + Math.cos(a) * d, rand(-0.2, 0.2), rand(0.5, 1.5), rand(-0.2, 0.2), rand(0.8, 1.4), w ? rand(0.08, 0.12) : rand(0.05, 0.1),
            w ? 0.75 : 0.22, w ? 0.9 : 0.6, 1, 0.25, 1.4);
        }
        while (u.ember >= 1) {
          u.ember -= 1;
          const a = rand(0, TAU), d = Math.sqrt(Math.random()) * 1.1, w = Math.random() < 0.25 ? 0.5 : 0;
          spawnP(p.x + Math.sin(a) * d, 0.1 + Math.random() * 0.6, p.z + Math.cos(a) * d, rand(-0.25, 0.25), rand(1.0, 2.8), rand(-0.25, 0.25), rand(0.6, 1.3), rand(0.08, 0.16),
            u.er + (1 - u.er) * w, u.eg * 0.8 + (1 - u.eg) * w, u.eb * 0.5 + w * 0.6, -0.9, 0.6);
        }
      }
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

  // 敌人头顶血条下的异常值三小段；返回下一行的 y
  const BU_CSS = { fire: '#ff8a3c', cold: '#86d8ff', light: '#ffe45e', chaos: '#ff6ad2' };
  const BU_DIM = { fire: 'rgba(255,138,60,0.22)', cold: 'rgba(134,216,255,0.22)', light: 'rgba(255,228,94,0.22)', chaos: 'rgba(255,106,210,0.22)' };
  function drawBuildUp(g, e, x, y, w) {
    const b = e.bu;
    if (!b) return y;
    const BU_DEATH = (G.BUILDUP && G.BUILDUP.deathMin) || 0.5;
    const on = { fire: e.blastT > 0, cold: e.freeze > 0 || e.bossChill > 0, light: e.shockT > 0, chaos: e.bindT > 0 || e.bossBind > 0 };
    const ch = b.chaos > 0.005 || on.chaos; // 混沌（渊缚）有累积时才多出第四段，平时还是三段
    if (!(b.fire > 0.005 || b.cold > 0.005 || b.light > 0.005 || on.fire || on.cold || on.light || ch)) return y;
    const els = ch ? G.BUILD_TYPES : G.ELEMS, nSeg = els.length;
    const gap = 2, sw = (w - gap * (nSeg - 1)) / nSeg;
    g.fillStyle = 'rgba(0,0,0,0.72)';
    g.fillRect(x - 1, y - 1, w + 2, 5);
    for (let i = 0; i < nSeg; i++) {
      const t = els[i], sx = x + i * (sw + gap);
      g.fillStyle = BU_DIM[t];
      g.fillRect(sx, y, sw, 3);
      // 刚触发（冻结 / 重度冰缓 / 感电 / 爆燃之后）：整段亮着闪动；平时按累积量涨
      const k = on[t] ? 1 : Math.max(0, Math.min(1, b[t]));
      if (k > 0) {
        g.fillStyle = on[t] ? (Math.sin(wtime * 14) > 0 ? '#ffffff' : BU_CSS[t]) : BU_CSS[t];
        g.fillRect(sx, y, sw * k, 3);
      }
      // 半格处一道刻度：过了它，这只敌人死的时候就会触发该元素的死亡异常（尸爆 / 碎冰 / 放电）
      if (!on[t]) {
        g.fillStyle = k >= BU_DEATH ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.65)';
        g.fillRect(Math.round(sx + sw * BU_DEATH), y - 1, 1, 5);
      }
    }
    return y + 6;
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
      // 元素异常值不为空（或刚触发）的也画：满血的怪被光环 / 异常灌着的时候也看得见进度
      const bu = e.bu;
      const buOn = !!bu && (bu.fire > 0.005 || bu.cold > 0.005 || bu.light > 0.005 || e.freeze > 0 || e.shockT > 0 || e.blastT > 0);
      if (e.dead || e.isBoss || !e.awake || !(e.elite || e.hp < e.maxHp || buOn)) continue;
      const p = projTo(e.x, e.height * (e.elite ? 1.3 : 1) + 0.35, e.z);
      if (!p.ok || p.x < -40 || p.x > vw + 40 || p.y < -20 || p.y > vh + 20) continue;
      const w = e.elite ? 60 : 40, h = e.elite ? 6 : 4;
      const x = Math.round(p.x - w / 2), y = Math.round(p.y);
      g.fillStyle = 'rgba(0,0,0,0.72)';
      g.fillRect(x - 1, y - 1, w + 2, h + 2);
      const k = Math.max(0, Math.min(1, e.hp / e.maxHp));
      g.fillStyle = e.freeze > 0 ? '#9fe2ff' : e.elite ? '#ffb53c' : '#d9412f';
      g.fillRect(x, y, w * k, h);
      if (e.shockT > 0 && Math.sin(wtime * 30) > 0.2) {
        // 感电：血条边上噼啪闪一下
        g.fillStyle = 'rgba(255,228,94,0.85)';
        g.fillRect(x - 1, y - 1, w + 2, 1);
        g.fillRect(x - 1, y + h, w + 2, 1);
      }
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
      // 元素异常值：火 / 冰 / 雷三小段并排，各占三分之一宽，按累积量从左往右涨（有任何一段不为空时才画）
      ay = drawBuildUp(g, e, x, ay, w);
      if (e.stunT > 0) { g.fillStyle = '#ffffff'; g.fillRect(x, ay, 5, 3); }
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
      const uqL = l.kind === 'item' && l.data && l.data.rarity === 3;
      if (uqL) {
        // 烬铸：名牌外面再描一圈发光的边
        g.shadowColor = l.color;
        g.shadowBlur = 10;
        g.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
        g.shadowBlur = 0;
      }
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
      g.globalAlpha = (k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1) * (o.kind === 'faint' ? 0.6 : 1); // 光环 / 电弧的小数字淡一些
      g.font = (o.kind && o.kind !== 'faint' ? '800 ' : '700 ') + Math.round(o.size * pop) + 'px "Trebuchet MS",' + FONT;
      if (o.kind === 'faint') {
        g.lineWidth = 2.5;
        g.strokeText(o.str, x, y);
        g.fillStyle = o.color;
        g.fillText(o.str, x, y);
        g.lineWidth = 3.5;
      } else if (arc) {
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

  // 自动画质（存档里是 'auto'，即玩家没手动选过）：连续 4 秒平均帧间隔超过 24 毫秒（明显掉帧）就降一档，只在本次运行有效
  const autoQ = { last: 0, acc: 0, n: 0 };
  function autoQualityWatch() {
    const now = performance.now();
    const d = autoQ.last ? now - autoQ.last : 0;
    autoQ.last = now;
    if (qualId === 'low' || !G.save || !G.save.opts || G.save.opts.quality !== 'auto' || document.hidden || pendingZone || G.state.paused) {
      autoQ.acc = autoQ.n = 0;
      return;
    }
    if (!d || d > 250) {
      autoQ.acc = autoQ.n = 0; // 切标签页、建区域之类的单次卡顿不算
      return;
    }
    autoQ.acc += d;
    autoQ.n++;
    if (autoQ.acc < 4000) return;
    const avg = autoQ.acc / autoQ.n;
    autoQ.acc = autoQ.n = 0;
    if (avg > 24) {
      const next = qualId === 'high' ? 'mid' : 'low';
      if (window.console) console.info('[画面] 帧间隔平均 ' + avg.toFixed(1) + ' 毫秒，画质自动降到「' + (next === 'mid' ? '中' : '低') + '」');
      W.setQuality(next);
      if (G.ui && G.ui.refresh && G.ui.isOpen && G.ui.isOpen()) G.ui.refresh();
    }
  }
  W.render = function () {
    autoQualityWatch();
    if (post.ok && qual.post) post.composer.render();
    else renderer.render(scene, camera);
    drawOverlay();
  };
})();
