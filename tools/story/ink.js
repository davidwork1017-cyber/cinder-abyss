// 开场故事的烘焙：在游戏页面里执行（bake.mjs 用 addScriptTag 注入），不进游戏本体。
// 每一层：用游戏自己的渲染链（卡通着色 + 调色 + 泛光）出图，再在 CPU 上加一道漫画处理：
//   墨线（深度突变 + 亮度 Sobel；角色层用透明度的轮廓）、平涂分阶、暗部网点、纸面颗粒。
// 角色层的透明度：同一帧分别清成黑底、白底各渲一次（不走后期），两张一样的像素就是不透明的。
(function () {
  const T = THREE;
  const W = G.world, R = W.renderer;

  // ---------- 镜头 ----------
  function applyCam(c) {
    const cam = W.camera;
    cam.position.set(c.pos[0], c.pos[1], c.pos[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(c.at[0], c.at[1], c.at[2]);
    if (c.roll) cam.rotateZ(c.roll);
    if (c.fov) cam.fov = c.fov;
    cam.near = 0.1; // 游戏镜头的近裁面是 2 米（一直离得很远），近景会把人切掉
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  // ---------- 读回画布 ----------
  function grab() {
    const cv = R.domElement;
    const c2 = document.createElement('canvas');
    c2.width = cv.width;
    c2.height = cv.height;
    const x = c2.getContext('2d');
    x.drawImage(cv, 0, 0);
    return x.getImageData(0, 0, c2.width, c2.height);
  }

  // ---------- 可见性：按层显隐 ----------
  // actors：角色的根节点列表。mode 'env' 藏起角色；'actors' 只留角色（灯光照旧）
  // 特效（粒子、叠加混合的网格）跟着角色层走：动作格里刀光、火星和人一起视差
  function isFx(o) {
    if (o.isPoints || o.isSprite) return true;
    const m = o.material && (Array.isArray(o.material) ? o.material[0] : o.material);
    return !!(o.isMesh && m && m.blending === T.AdditiveBlending);
  }
  function setLayer(actors, mode, fxWithActors, hide) {
    hide = hide || [];
    const keep = new Set();
    for (const a of actors) a.traverse((o) => keep.add(o));
    if (fxWithActors) W.scene.traverse((o) => { if (o.visible && isFx(o)) keep.add(o); });
    const saved = [];
    W.scene.traverse((o) => {
      if (o.isLight || o === W.scene || o.isCamera) return;
      const isA = keep.has(o);
      let vis = o.visible;
      if (mode === 'env' && isA) vis = false;
      if (mode === 'actors' && !isA && (o.isMesh || o.isPoints || o.isSprite || o.isLine)) {
        // 角色的祖先节点（场景里的组）不能藏，只藏渲染体
        vis = false;
      }
      // hide：'points' 粒子（近镜头里环境火星会变成大圆斑，交给播放时的 2D 火星）；'transparent' 半透明网格（地雾等）；
      // 'name:<名字>' 指定的物体
      if (vis && hide.length) {
        const m = o.material && (Array.isArray(o.material) ? o.material[0] : o.material);
        if (hide.includes('points') && (o.isPoints || o.isSprite)) vis = false;
        if (hide.includes('transparent') && o.isMesh && m && m.transparent && !isA) vis = false;
        if (o.name && hide.includes('name:' + o.name)) vis = false;
        // 'smoke'：火盆的烟（序列帧卡片，朝着游戏镜头摆的，换个机位就成了一块块灰板）
        if (hide.includes('smoke') && o.isMesh && m && m.uniforms && m.uniforms.uLickK && m.blending === T.NormalBlending) vis = false;
        // 'normalfx'：普通混合的半透明着色器网格（烟、尘团、地雾）：近镜头里会变成一大片糊在人前面的团
        if (hide.includes('normalfx') && o.isMesh && m && !isA && (m.isShaderMaterial || m.isRawShaderMaterial) && m.transparent && (m.blending === T.NormalBlending || m.blending === T.CustomBlending)) vis = false;
      }
      if (vis !== o.visible) {
        saved.push([o, o.visible]);
        o.visible = vis;
      }
    });
    return () => { for (const [o, v] of saved) o.visible = v; };
  }

  // ---------- 深度：换成深度材质渲一次（只给环境层用；透明 / 叠加的物体藏起来） ----------
  function depthPass(cam) {
    const swaps = [];
    const hide = [];
    const mats = new Map();
    W.scene.traverse((o) => {
      if (!o.visible) return;
      if (o.isPoints || o.isSprite || o.isLine) { hide.push(o); return; }
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || m.transparent || m.depthWrite === false || m.blending !== T.NormalBlending || m.visible === false) { hide.push(o); return; }
      // 自定义着色器的网格（特效、在顶点着色器里摆位置的东西）换成深度材质会摆错地方：深度里不画它们
      if (m.isShaderMaterial || m.isRawShaderMaterial) { hide.push(o); return; }
      const key = (o.isSkinnedMesh ? 's' : '') + (m.morphTargets ? 'm' : '') + (m.side === T.DoubleSide ? 'd' : '');
      let dm = mats.get(key);
      if (!dm) {
        dm = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, skinning: !!o.isSkinnedMesh, morphTargets: !!m.morphTargets, side: m.side });
        mats.set(key, dm);
      }
      swaps.push([o, o.material]);
      o.material = dm;
    });
    for (const o of hide) o.visible = false;
    const fog = W.scene.fog, bg = W.scene.background;
    W.scene.fog = null;
    W.scene.background = null;
    // 渲进单独的渲染目标再读回（不经过画布，也不碰游戏的后期链）
    const sz = R.getDrawingBufferSize(new T.Vector2());
    const rt = new T.WebGLRenderTarget(sz.x, sz.y, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, format: T.RGBAFormat, type: T.UnsignedByteType, depthBuffer: true });
    const cc = R.getClearColor(new T.Color()), ca = R.getClearAlpha(), ac = R.autoClear;
    R.setRenderTarget(rt);
    R.setClearColor(0xffffff, 1);
    R.autoClear = true;
    R.clear(true, true, true);
    R.render(W.scene, cam);
    const buf = new Uint8Array(sz.x * sz.y * 4);
    R.readRenderTargetPixels(rt, 0, 0, sz.x, sz.y, buf);
    R.setRenderTarget(null);
    R.autoClear = ac;
    rt.dispose();
    // 读回的是自下而上的行：翻成自上而下，和画布截图对齐
    const img = { width: sz.x, height: sz.y, data: new Uint8Array(buf.length) };
    const rowB = sz.x * 4;
    for (let y = 0; y < sz.y; y++) img.data.set(buf.subarray((sz.y - 1 - y) * rowB, (sz.y - y) * rowB), y * rowB);
    STORY_BAKE.lastDepthInfo = { swapped: swaps.length, hidden: hide.length, w: sz.x, h: sz.y };
    R.setClearColor(cc, ca);
    W.scene.fog = fog;
    W.scene.background = bg;
    for (const o of hide) o.visible = true;
    for (const [o, m] of swaps) o.material = m;
    for (const dm of mats.values()) dm.dispose();
    // RGBA 打包的深度 → 线性深度（米）
    const n = img.width * img.height, D = new Float32Array(n), d = img.data;
    const near = cam.near, far = cam.far;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4] / 256, g = d[i * 4 + 1] / 256, b = d[i * 4 + 2] / 256, a = d[i * 4 + 3] / 256; // 打包时乘过 256/255，读回的字节 / 256 正好还原
      // r128 的 unpackRGBAToDepth：r / 256^3 + g / 256^2 + b / 256 + a（a 是高位）
      const z = r / 16777216 + g / 65536 + b / 256 + a;
      const zz = z >= 0.9999 ? 1 : z;
      // 透视深度 → 视空间距离
      D[i] = zz >= 1 ? far : (near * far) / (far - zz * (far - near));
    }
    return D;
  }

  // ---------- 角色层的透明度：黑底 / 白底各渲一次 ----------
  function alphaPass(cam) {
    const fog = W.scene.fog, bg = W.scene.background;
    W.scene.background = null;
    const cc = R.getClearColor(new T.Color()), ca = R.getClearAlpha();
    R.setRenderTarget(null);
    const shot = (c) => {
      R.setClearColor(c, 1);
      R.clear();
      R.render(W.scene, cam);
      return grab();
    };
    const A = shot(0x000000), B = shot(0xffffff);
    R.setClearColor(cc, ca);
    W.scene.fog = fog;
    W.scene.background = bg;
    const n = A.width * A.height, al = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const diff = (B.data[j] - A.data[j] + B.data[j + 1] - A.data[j + 1] + B.data[j + 2] - A.data[j + 2]) / (3 * 255);
      al[i] = Math.min(1, Math.max(0, 1 - diff));
    }
    return al;
  }

  // ---------- 漫画处理（CPU） ----------
  // img：ImageData（游戏渲染链的结果），D：线性深度（可空），A：透明度（可空，角色层），o：参数
  function comic(img, D, A, o) {
    const w = img.width, h = img.height, n = w * h, src = img.data;
    if (A) {
      // 角色层是黑底上渲的（等于预乘了透明度）：先除回去，半透明的边和特效的光才是原色
      for (let i = 0; i < n; i++) {
        const a = A[i], j = i * 4;
        if (a > 0.02 && a < 0.999) {
          const k = 1 / a;
          src[j] = Math.min(255, src[j] * k);
          src[j + 1] = Math.min(255, src[j + 1] * k);
          src[j + 2] = Math.min(255, src[j + 2] * k);
        }
      }
    }
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      L[i] = (0.2126 * src[j] + 0.7152 * src[j + 1] + 0.0722 * src[j + 2]) / 255;
    }
    const s = o.scale || 1; // 线宽、网点按输出分辨率换算（渲染分辨率 / 输出分辨率）
    // 1) 线：亮度 Sobel（细）+ 深度突变（粗）+ 透明度轮廓
    const E = new Float32Array(n);
    const c0 = o.edge0 ?? 0.16, c1 = o.edge1 ?? 0.34, dk = o.depthK ?? 0.06;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const a = L[i - w - 1], b = L[i - w], c = L[i - w + 1], d = L[i - 1], f = L[i + 1], g = L[i + w - 1], hh = L[i + w], k = L[i + w + 1];
        const gx = c + 2 * f + k - a - 2 * d - g, gy = g + 2 * hh + k - a - 2 * b - c;
        let e = Math.sqrt(gx * gx + gy * gy);
        e = e <= c0 ? 0 : e >= c1 ? 1 : (e - c0) / (c1 - c0);
        e *= o.colorLine ?? 0.7;
        // 发光的东西（熔岩、火、特效）不描黑线：漫画里光是干净的
        const lc = o.glowCut ?? 0.55, lm = Math.max(a, b, c, d, L[i], f, g, hh, k);
        if (lm > lc) e *= Math.max(0, 1 - (lm - lc) / 0.12);
        if (D) {
          const z = D[i];
          const m = Math.max(Math.abs(D[i - 1] - z), Math.abs(D[i + 1] - z), Math.abs(D[i - w] - z), Math.abs(D[i + w] - z));
          // 只在近的那一侧画（离镜头近的物体的轮廓），远处的雾里线变淡
          const near = D[i - 1] > z || D[i + 1] > z || D[i - w] > z || D[i + w] > z;
          if (near && m / Math.max(z, 0.5) > dk) {
            const fade = Math.max(0.25, 1 - z / (o.lineFar || 70));
            e = Math.max(e, fade);
          }
        }
        if (A) {
          const ai = A[i];
          if (ai > 0.5 && (A[i - 1] < 0.5 || A[i + 1] < 0.5 || A[i - w] < 0.5 || A[i + w] < 0.5)) e = 1;
          if (ai < 0.02) e = 0;
        }
        E[i] = e;
      }
    }
    // 2) 线加粗：按半径做最大值滤波（横竖分开）
    const rad = Math.max(0, Math.round((o.lineW ?? 1.2) * s - 0.5));
    let Eo = E;
    if (rad > 0) {
      const tmp = new Float32Array(n);
      Eo = new Float32Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = -rad; k <= rad; k++) { const xx = x + k; if (xx >= 0 && xx < w) { const v = E[y * w + xx]; if (v > m) m = v; } }
        tmp[y * w + x] = m;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = -rad; k <= rad; k++) { const yy = y + k; if (yy >= 0 && yy < h) { const v = tmp[yy * w + x]; if (v > m) m = v; } }
        Eo[y * w + x] = m;
      }
    }
    // 发光的地方（熔岩、火、特效的光）连同周围一圈都不上墨：漫画里光是干净的
    {
      const lc = o.glowCut ?? 0.55, gr = rad + Math.max(1, Math.round((o.outW ?? 1.5) * s)) + 1;
      const Gm = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (L[i] > lc && (!A || A[i] > 0.02)) Gm[i] = 1;
      // 横竖两遍的膨胀
      const t1 = new Uint8Array(n);
      for (let y = 0; y < h; y++) {
        let last = -1e9;
        for (let x = 0; x < w; x++) { if (Gm[y * w + x]) last = x; if (x - last <= gr) t1[y * w + x] = 1; }
        last = 1e9;
        for (let x = w - 1; x >= 0; x--) { if (Gm[y * w + x]) last = x; if (last - x <= gr) t1[y * w + x] = 1; }
      }
      const t2 = new Uint8Array(n);
      for (let x = 0; x < w; x++) {
        let last = -1e9;
        for (let y = 0; y < h; y++) { if (t1[y * w + x]) last = y; if (y - last <= gr) t2[y * w + x] = 1; }
        last = 1e9;
        for (let y = h - 1; y >= 0; y--) { if (t1[y * w + x]) last = y; if (last - y <= gr) t2[y * w + x] = 1; }
      }
      o._glow = t2;
    }
    // 角色层：线画到轮廓外面一圈（透明度跟着扩），这样锯齿边藏在墨线里
    let Ao = A;
    if (A) {
      Ao = new Float32Array(n);
      const r2 = Math.max(1, Math.round((o.outW ?? 1.5) * s));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let m = A[i];
        if (m < 0.98) {
          for (let dy = -r2; dy <= r2 && m < 0.98; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -r2; dx <= r2; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w || dx * dx + dy * dy > r2 * r2) continue;
              const v = A[yy * w + xx];
              if (v > m) m = v;
            }
          }
        }
        if (m > A[i] + 0.01) Eo[i] = Math.max(Eo[i], m); // 外扩的那一圈是墨色
        Ao[i] = m;
      }
    }
    // 3) 平涂分阶 + 暗部网点 + 墨色 + 纸面颗粒
    const out = new ImageData(w, h), od = out.data;
    const N = o.bands ?? 4, soft = o.bandSoft ?? 0.18, pk = o.posterize ?? 0.55;
    const ht0 = o.halftone ?? 0.2, cell = (o.cell ?? 5.5) * s, htK = o.htK ?? 0.5;
    const ink = o.ink || [20, 12, 14], inkK = o.inkK ?? 0.92;
    const ca = Math.cos(Math.PI / 4), sa = Math.sin(Math.PI / 4);
    const grain = o.grain ?? 3;
    let seed = 12345;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, j = i * 4;
        let r = src[j], g = src[j + 1], b = src[j + 2];
        const l = L[i];
        // 分阶：保持色相，只把亮度推到台阶上（台阶之间留一点软边）
        const bb = l * N, fl = Math.floor(bb), fr = bb - fl;
        const t = fr < 0.5 - soft ? 0 : fr > 0.5 + soft ? 1 : (fr - 0.5 + soft) / (2 * soft);
        const lq = (fl + t) / N + 0.5 / N * 0.35;
        const kq = l > 0.004 ? 1 + pk * (lq / l - 1) : 1;
        const kq2 = Math.min(kq, 1.6);
        r *= kq2; g *= kq2; b *= kq2;
        // 网点：最暗的一阶里，45° 网格上的圆点，越暗点越大
        if (l < ht0) {
          const u = (x * ca + y * sa) / cell, v = (-x * sa + y * ca) / cell;
          const du = u - Math.round(u), dv = v - Math.round(v);
          const dd = Math.sqrt(du * du + dv * dv);
          const rr = 0.55 * Math.sqrt((ht0 - l) / ht0);
          if (dd < rr) {
            const e = Math.min(1, (rr - dd) * cell * 0.8); // 点的边缘抗锯齿
            const k = 1 - htK * e;
            r *= k; g *= k; b *= k;
          }
        }
        // 墨线（发光处不上）
        const e = (o._glow[i] ? 0 : Eo[i]) * inkK;
        r = r + (ink[0] - r) * e;
        g = g + (ink[1] - g) * e;
        b = b + (ink[2] - b) * e;
        // 纸面颗粒
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const nz = ((seed >> 8) / 8388608 - 0.5) * grain;
        od[j] = r + nz;
        od[j + 1] = g + nz;
        od[j + 2] = b + nz;
        od[j + 3] = Ao ? Math.round(Ao[i] * 255) : 255;
      }
    }
    return out;
  }

  // 缩到输出尺寸（高质量插值），导出 webp / png 的 dataURL
  function encode(img, ow, oh, type, q) {
    const c1 = document.createElement('canvas');
    c1.width = img.width;
    c1.height = img.height;
    c1.getContext('2d').putImageData(img, 0, 0);
    const c2 = document.createElement('canvas');
    c2.width = ow;
    c2.height = oh;
    const x = c2.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    // 目标宽高比和渲染图不一样时（一页多格里的窄格 / 长条格），从正中裁
    const W0 = img.width, H0 = img.height, a = ow / oh;
    let sw = W0, sh = H0;
    if (a > W0 / H0) sh = W0 / a;
    else sw = H0 * a;
    x.drawImage(c1, (W0 - sw) / 2, (H0 - sh) / 2, sw, sh, 0, 0, ow, oh);
    return c2.toDataURL(type || 'image/webp', q ?? 0.88);
  }

  // 拍一层。L：{ name, mode: 'full' | 'env' | 'actors', ink: {...} }；actors：角色根节点
  function layer(c, actors, L, ow, oh) {
    // 角色的蒙皮网格按绑定姿态的包围球做视锥剔除：游戏镜头一直很远看不出来，近景会把整个人剔掉
    for (const a of actors) a.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    // c.game：就用游戏自己的镜头（最后一格要和真正的开局画面对上）
    if (!c.game) applyCam(c);
    // 特效的面片是每帧按游戏镜头的朝向摆的：先用拍摄镜头的朝向跑一次零时长的更新，面片就朝着这台镜头
    W.update(0);
    if (!c.game) applyCam(c);
    const restore = setLayer(actors, L.mode === 'full' ? 'none' : L.mode, L.fx !== false, L.hide);
    // 游戏自己的渲染链（调色 / 泛光 / 抗锯齿）：W.render 里的镜头接管用同一个镜头。角色层清成黑底
    window.__cam = c.game ? null : c;
    const bg0 = W.scene.background, cc0 = R.getClearColor(new T.Color()), fogC = W.scene.fog && W.scene.fog.color.clone();
    if (L.mode === 'actors') { W.scene.background = new T.Color(0); R.setClearColor(0, 1); }
    W.render();
    const img = grab();
    W.scene.background = bg0;
    R.setClearColor(cc0, 1);
    if (fogC) W.scene.fog.color.copy(fogC);
    let D = null, A = null;
    if (L.mode !== 'actors' && L.depth !== false) D = depthPass(W.camera);
    if (L.mode === 'actors') A = alphaPass(W.camera);
    restore();
    let dbg = null;
    if (L.debug) {
      // 调试：原始渲染图 + 深度图（近白远黑）
      const dv = new ImageData(img.width, img.height);
      if (D) for (let i = 0; i < D.length; i++) { const v = Math.max(0, 255 - D[i] * 6); dv.data[i * 4] = dv.data[i * 4 + 1] = dv.data[i * 4 + 2] = v; dv.data[i * 4 + 3] = 255; }
      dbg = { raw: encode(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), ow, oh, 'image/webp', 0.9), depth: encode(dv, ow, oh, 'image/webp', 0.9) };
    }
    const out = comic(img, D, A, Object.assign({ scale: img.width / ow }, L.ink || {}));
    const res = { dbg, depthInfo: STORY_BAKE.lastDepthInfo || null, webp: encode(out, ow, oh, 'image/webp', L.q ?? 0.88), w: img.width, h: img.height };
    // split：按深度再切出一张近景层（近于 split 米的像素，边缘羽化 feather 米），给视差用
    if (L.split && D) {
      const near = new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), nd = near.data, f = L.feather || 1.5;
      for (let i = 0; i < D.length; i++) {
        const t = (L.split + f - D[i]) / (2 * f);
        nd[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, t)));
      }
      res.near = encode(near, ow, oh, 'image/webp', L.q ?? 0.88);
    }
    return res;
  }

  // ---------- 摆拍用的定格姿势：往角色的骨架里塞一个只在烘焙时存在的动作（全身、从绑定姿态起、停在最后一帧） ----------
  // keys：{ '关节.通道': 值 或 [k, v, k, v…] }，通道 rx ry rz ox oy oz（和 world.js 的 defClip 一样）
  const CHI = { rx: 0, ry: 1, rz: 2, ox: 3, oy: 4, oz: 5, sx: 6, sy: 7, sz: 8 };
  function pose(ent, name, keys, o) {
    o = o || {};
    const rig = ent.rig, ci = [], cK = [], cLow = [];
    for (const k in keys) {
      const [jn, c] = k.split('.');
      if (rig.JI[jn] === undefined || CHI[c] === undefined) throw new Error('pose ' + name + '：没有 ' + k);
      const v = keys[k];
      ci.push(rig.JI[jn] * 9 + CHI[c]);
      cK.push(Array.isArray(v) ? v : [0, v, 1, v]);
      cLow.push(0);
    }
    rig.clips[name] = {
      name, dur: o.dur || 0.6, k0: 0.5, loop: false, hold: true, fade: 0.02, out: 0.2, base: o.base || 'rest', air: o.air !== false,
      ci, cK, cLow, fn: null, trail: null, clear: null, hand: null, handL: null, draw: null, arrow: false, ikL: o.ikL ?? 0, spec: { keys },
    };
    if (ent.gearClips) delete ent.gearClips[name];
    W.play(ent, name, { hold: true, fade: 0.02 });
    // 玩家的动画在模拟里推（W.update 不管它），这里直接按帧推它自己的动画
    for (let i = 0; i < Math.ceil(((o.dur || 0.6) + 0.2) * 60); i++) W.animEnt(ent, 1 / 60, false);
  }
  // 关节在世界里的位置（off：关节坐标系里的偏移，米）
  function jointPos(ent, jn, off) {
    const j = ent.rig.JI[jn], m = ent.mdl, k = j * 12;
    const v = new T.Vector3(m[k + 3], m[k + 7], m[k + 11]);
    if (off) v.add(new T.Vector3(m[k] * off[0] + m[k + 1] * off[1] + m[k + 2] * off[2], m[k + 4] * off[0] + m[k + 5] * off[1] + m[k + 6] * off[2], m[k + 8] * off[0] + m[k + 9] * off[1] + m[k + 10] * off[2]));
    ent.group.updateMatrixWorld(true); // 传送后组的世界矩阵要到下一次渲染才更新：先自己更新
    return v.applyMatrix4(ent.body.matrixWorld);
  }
  // 世界坐标 → 画面里的比例位置（0..1，左上为原点），用拍摄镜头
  function screenOf(c, v) {
    if (!c.game) applyCam(c);
    const p = v.clone().project(W.camera);
    return [+(p.x * 0.5 + 0.5).toFixed(4), +(0.5 - p.y * 0.5).toFixed(4)];
  }

  window.STORY_BAKE = { pose, jointPos, screenOf, applyCam, grab, setLayer, depthPass, alphaPass, comic, encode, layer };
})();
