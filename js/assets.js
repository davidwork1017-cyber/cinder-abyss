'use strict';
// assets.js —— 外部 CC0 素材（地面 / 岩壁贴图、布景模型）的按需加载。
// 素材由 tools/pack-assets.mjs 打成 js/assets/*.js（base64），这里按包名插入 <script> 加载：从 file:// 双击打开也能用。
// 贴图（tex-t2）：包里的 JPEG 原文（base64）一直留着，解码出来的 Image 只留世界层要的那几个包（当前区 + 下一区，见 A.release）；
// 离开的区释放 Image，再进来时从留着的原文重新解码（不用再下载）。低档可以用每套贴图的 lo 变体（更小的一份），或者整套不解码（skipLow，
// 给一张 1×1 的透明占位图，比如低档不画的贴花图集），见 A.setLow。模型用 r128 的 GLTFLoader 解析，
// 再烘焙成一个只带 位置 / 法线 / 顶点色（线性）/ aCap 的几何体（KayKit 的调色板贴图按 UV 取色进顶点色），
// 这样所有布景都能用同一个按区域着色的材质、实例化绘制。任何一步失败都只是返回 null，世界层退回程序化外观。
(function () {
  const G = window.G;
  const T = window.THREE;
  const A = (G.assets = {});
  const INDEX = window.CA_ASSET_INDEX || { packs: {}, textures: {} };
  const STORE = (window.CA_ASSETS = window.CA_ASSETS || {});

  const packState = Object.create(null); // 包名 → { p: Promise, ok: bool, done: bool }
  const packFails = Object.create(null); // 包名 → 失败次数：前 MAX_TRIES - 1 次失败不记成定局，下次进入用到它的区域时重试
  const MAX_TRIES = 3;
  // 贴图 id → { full / lo / none: { albedo, normal, arh, avg: [r,g,b]（反照率的线性平均色） } }：按变体各存一份，只存解码过的
  const imgs = Object.create(null);
  const texEntry = Object.create(null); // 贴图 id → 包里的条目（{ albedo, normal, arh 原文, lo?: {...}, skipLow?: 1 }）
  const texOfPack = Object.create(null); // 包名 → 这个包里的贴图 id
  const texState = Object.create(null); // 包名 → 当前这一档的解码 { mode: 'full' | 'low', p, done, ok }
  const relGen = Object.create(null); // 包名 → 被 A.release 释放过几次（mem-hunt：释放之前发出的 need 结果出来时作废）
  let lateDropped = 0; // 测试用：包释放以后才解码完、直接放掉的图张数
  let lowMode = false; // 低档：有 lo 变体的贴图用 lo、标了 skipLow 的不解码
  const geos = Object.create(null); // 模型 key → BufferGeometry
  const geoInfo = Object.create(null); // 模型 key → { h, r }（高度、水平半径）
  const geoPack = Object.create(null); // 模型 key → 来自哪个包（测试用来核对第 0 区的布景是不是自产件）

  const KINDS = ['albedo', 'normal', 'arh']; // 一套贴图的三张图
  const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => res();
      s.onerror = () => {
        if (s.parentNode) s.parentNode.removeChild(s); // 重试时重新插一个
        rej(new Error('素材包加载失败：' + src));
      };
      document.head.appendChild(s);
    });
  }
  // zones-integrate：载入后先用 img.decode() 在后台线程把 JPEG 解好（原来是第一次 drawImage 时在主线程里同步解码，
  // 预取下一区的素材包时会在进区两三秒后卡一下）；不支持 decode() 的浏览器照旧 onload
  function loadImage(b64) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => (im.decode ? im.decode().then(() => res(im), () => res(im)) : res(im));
      im.onerror = () => rej(new Error('贴图解码失败'));
      im.src = 'data:image/jpeg;base64,' + b64;
    });
  }
  // 反照率的平均色（线性）：世界层用它把贴图归一化，再乘上区域的配色
  function avgColor(im) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      // willReadFrequently：用 CPU 画布，getImageData 不用等 GPU 进程（软件渲染下 GPU 进程正忙着画 3D，原来一次要等 1 秒多）
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      const a = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) a[k] += s2l(d[i + k] / 255);
      return a.map((v) => Math.max(0.005, v / 256));
    } catch (e) {
      return [0.25, 0.25, 0.25];
    }
  }

  // ---------- 模型：GLB → 烘焙几何体 ----------
  const texPixels = new Map(); // 贴图图像 → { w, h, d }
  function pixelsOf(img) {
    if (texPixels.has(img)) return texPixels.get(img);
    let out = null;
    try {
      const w = img.width, h = img.height;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true }); // 同上：CPU 画布，读像素不等 GPU
      g.drawImage(img, 0, 0);
      out = { w, h, d: g.getImageData(0, 0, w, h).data };
    } catch (e) {
      out = null;
    }
    texPixels.set(img, out);
    return out;
  }
  function bakeGltf(scene) {
    scene.updateMatrixWorld(true);
    const P = [], N = [], C = [], K = [], GL = [];
    const v = new T.Vector3(), n = new T.Vector3(), nm = new T.Matrix3(), col = new T.Color();
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
      const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const base = mat && mat.color ? mat.color : col.setRGB(1, 1, 1);
      const px = mat && mat.map && mat.map.image ? pixelsOf(mat.map.image) : null;
      // asset-lib：自产布景件带 COLOR_0（烘焙好的 AO / 边缘磨损 / 高度渐变，线性），乘在调色板颜色上；归一化的整数按 glTF 规则换成 0–1
      const vc = g.attributes.color, vcK = vc && vc.normalized ? 1 / (vc.array instanceof Uint8Array ? 255 : 65535) : 1;
      const cap = mat && /grass/i.test(mat.name || '') ? 1 : 0;
      nm.getNormalMatrix(o.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        P.push(v.x, v.y, v.z);
        if (nor) n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        else n.set(0, 1, 0);
        N.push(n.x, n.y, n.z);
        let r = base.r, gg = base.g, b = base.b;
        if (px && uv) {
          let u = uv.getX(i), w = uv.getY(i);
          u -= Math.floor(u);
          w -= Math.floor(w);
          const x = Math.min(px.w - 1, Math.floor(u * px.w)), y = Math.min(px.h - 1, Math.floor(w * px.h)); // glTF 的 UV 原点在左上，贴图不翻转
          const k = (y * px.w + x) * 4;
          r *= s2l(px.d[k] / 255);
          gg *= s2l(px.d[k + 1] / 255);
          b *= s2l(px.d[k + 2] / 255);
        }
        if (vc) {
          r *= vc.getX(i) * vcK;
          gg *= vc.getY(i) * vcK;
          b *= vc.getZ(i) * vcK;
        }
        C.push(r, gg, b);
        K.push(cap);
        GL.push(vc && vc.itemSize === 4 ? Math.max(0, 1 - vc.getW(i) * vcK) : 0); // asset-lib：自产件把自发光强度写在 COLOR_0 的 α 里（α = 1 - 发光）
      }
      if (g !== o.geometry) g.dispose();
    });
    if (!P.length) return null;
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    out.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    out.setAttribute('color', new T.Float32BufferAttribute(C, 3));
    if (K.some((k) => k > 0)) out.setAttribute('aCap', new T.Float32BufferAttribute(K, 1));
    if (GL.some((k) => k > 0.01)) out.setAttribute('aGlow', new T.Float32BufferAttribute(GL, 1)); // 余烬（布景材质里当自发光，见 world.js 的 triMaterial）
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }
  function disposeGltf(scene) {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) {
        if (m.map) {
          if (m.map.image && m.map.image.close) m.map.image.close();
          m.map.dispose();
        }
        m.dispose();
      }
    });
  }
  function b64ToBuf(b64) {
    const bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function parseModel(key, b64) {
    return new Promise((res) => {
      if (!T.GLTFLoader) return res(null);
      let loader;
      try {
        loader = new T.GLTFLoader();
        loader.parse(
          b64ToBuf(b64), '',
          (gltf) => {
            let g = null;
            try {
              g = bakeGltf(gltf.scene);
            } catch (e) {
              g = null;
            }
            try {
              disposeGltf(gltf.scene);
            } catch (e) { /* 忽略 */ }
            if (g) {
              const bb = g.boundingBox;
              geos[key] = g;
              geoInfo[key] = { h: bb.max.y - bb.min.y, r: Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z), y0: bb.min.y };
            }
            res(g);
          },
          () => res(null)
        );
      } catch (e) {
        res(null);
      }
    });
  }

  // ---------- 包 ----------
  async function decodePack(name) {
    const data = STORE[name];
    if (!data) throw new Error('素材包内容缺失：' + name);
    const jobs = [];
    // 贴图：原文（base64）留在条目里（释放以后还能重新解码，不用再下载）；解码按画质档另做（decodeTex）。
    // 探针（WebKit，五个区走三圈）：留 base64 字符串比换成 Blob 少占 10 MB 左右（Blob 在网络进程里还有一份），两者都不随走过的区增长
    const ids = Object.keys(data.tex || {});
    for (const id of ids) texEntry[id] = data.tex[id];
    for (const key in data.models || {}) jobs.push(parseModel(key, data.models[key]).then((g) => g && (geoPack[key] = name)));
    // 自产布景件（kit-<区> 包）：打包时已经烘焙好（tools/pack-assets.mjs，和上面的 bakeGltf 逐位一致），这里只把数组拷进几何体，不解析、不烘焙
    for (const key in data.geo || {}) {
      try {
        const e = data.geo[key], f32 = (b) => new Float32Array(b64ToBuf(b));
        const g = new T.BufferGeometry();
        if (e.fc) {
          // AI 武器（ai3d-weapons，外观 fc）：带索引的紧凑包（tools/glb.mjs 的 packFc），展开成不带索引的三角形、按面算法线（平直），发光进 aGlow
          const idx = e.i32 ? new Uint32Array(b64ToBuf(e.i)) : new Uint16Array(b64ToBuf(e.i)), P0 = f32(e.p), C0 = f32(e.c), G0 = e.g ? f32(e.g) : null;
          const P = new Float32Array(idx.length * 3), C = new Float32Array(idx.length * 3), GL = G0 ? new Float32Array(idx.length) : null;
          for (let k = 0; k < idx.length; k++) {
            const v = idx[k];
            P[k * 3] = P0[v * 3]; P[k * 3 + 1] = P0[v * 3 + 1]; P[k * 3 + 2] = P0[v * 3 + 2];
            C[k * 3] = C0[v * 3]; C[k * 3 + 1] = C0[v * 3 + 1]; C[k * 3 + 2] = C0[v * 3 + 2];
            if (GL) GL[k] = G0[v];
          }
          g.setAttribute('position', new T.BufferAttribute(P, 3));
          g.setAttribute('color', new T.BufferAttribute(C, 3));
          if (GL) g.setAttribute('aGlow', new T.BufferAttribute(GL, 1));
          g.computeVertexNormals();
          g.computeBoundingBox();
          g.computeBoundingSphere();
          const bb = g.boundingBox;
          geos[key] = g;
          geoInfo[key] = { h: bb.max.y - bb.min.y, r: Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z), y0: bb.min.y };
          geoPack[key] = name;
          continue;
        }
        g.setAttribute('position', new T.BufferAttribute(f32(e.p), 3));
        g.setAttribute('color', new T.BufferAttribute(f32(e.c), 3));
        if (e.i) {
          // AI 件（ai3d-pilot）：带索引的紧凑包（tools/glb.mjs 的 packAi）+ UV + 反照率贴图的 id（world.js 用 zoneTexture(id, 'albedo') 取）。
          // 包里不存法线：材质用平直着色；法线按索引补一份平滑的（阴影 / 别的着色器要这个属性时有值）
          g.setIndex(new T.BufferAttribute(e.i32 ? new Uint32Array(b64ToBuf(e.i)) : new Uint16Array(b64ToBuf(e.i)), 1));
          g.setAttribute('uv', new T.BufferAttribute(f32(e.u), 2));
          g.computeVertexNormals();
          g.userData.tex = e.t;
        } else g.setAttribute('normal', new T.BufferAttribute(f32(e.nn), 3));
        if (e.g) g.setAttribute('aGlow', new T.BufferAttribute(f32(e.g), 1)); // 余烬（布景材质里当自发光，见 world.js 的 triMaterial）
        g.computeBoundingBox();
        g.computeBoundingSphere();
        const bb = g.boundingBox;
        geos[key] = g;
        geoInfo[key] = { h: bb.max.y - bb.min.y, r: Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z), y0: bb.min.y };
        geoPack[key] = name;
      } catch (err) {
        /* 这一件坏了就不摆（摆放时 G.assets.geo 为空会跳过） */
      }
    }
    data.geo = null;
    // 带反照率贴图的首领（ai3d-golem）：贴图在包加载时就解码好（G.assets.need 返回时已经能用），首领建骨架时直接上传、第一帧就有贴图（开场故事的烘焙逐字节可复现）
    for (const key in data.boss || {}) {
      const e = data.boss[key];
      if (!e.tex || e._img) continue;
      const im = new Image();
      im.src = e.tex;
      e._img = im;
      jobs.push(im.decode().catch(() => {}));
    }
    await Promise.all(jobs);
    texOfPack[name] = ids; // 模型都解析完才登记：decodeTex 只在这之后才会看到这个包的贴图
    // 模型解析完就丢掉 base64 原文（几何体已经留了一份）；贴图的原文已经挪进 texEntry
    data.tex = null;
    data.models = null;
  }

  // ---------- 贴图：按画质档解码，离开的区释放 ----------
  // 这张贴图在当前画质档用哪一份：'full'（原图）/ 'lo'（低档的小图）/ 'none'（低档不解码，用透明占位图）
  const variantOf = (e) => (lowMode && e ? (e.lo ? 'lo' : e.skipLow ? 'none' : 'full') : 'full');
  const packMode = (name) => (lowMode && (texOfPack[name] || []).some((id) => variantOf(texEntry[id]) !== 'full') ? 'low' : 'full');
  let ph = null; // 1×1 占位图：反照率中灰、arh 的 G（不透明度）为 0，画出来是全透明
  function placeholder() {
    if (ph) return ph;
    const one = (r, g, b) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const x = c.getContext('2d');
      x.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      x.fillRect(0, 0, 1, 1);
      return c;
    };
    const a = one(89, 89, 89), f = one(128, 128, 255), z = one(255, 0, 128);
    return (ph = { albedo: a, normal: f, arh: z, avg: [0.1, 0.1, 0.1], placeholder: true });
  }
  function decodeTex(name) {
    const ids = texOfPack[name];
    if (!ids || !ids.length) return Promise.resolve(true);
    const mode = packMode(name);
    let st = texState[name];
    if (st && st.mode === mode) return st.p;
    st = texState[name] = { mode, p: null, done: false, ok: false };
    const jobs = [];
    for (const id of ids) {
      const e = texEntry[id], v = variantOf(e), have = imgs[id] || (imgs[id] = {});
      if (have[v]) continue;
      if (v === 'none') {
        have.none = placeholder();
        continue;
      }
      const src = v === 'lo' ? e.lo : e, kinds = KINDS.filter((k) => src[k]);
      jobs.push(
        Promise.all(kinds.map((k) => loadImage(src[k]))).then((ims) => {
          if (texState[name] !== st) {
            // 解码期间这个包被释放了 / 换了画质档：结果不要，图也马上放掉（mem-hunt：原来只是不存，WebKit 里解码出来的数据要等垃圾回收才走）
            ims.forEach(freeImg);
            lateDropped += ims.length;
            return;
          }
          const set = {};
          kinds.forEach((k, i) => (set[k] = ims[i]));
          set.avg = avgColor(set.albedo);
          (imgs[id] || (imgs[id] = {}))[v] = set;
        })
      );
    }
    st.p = Promise.all(jobs).then(
      () => {
        st.ok = true;
        st.done = true;
        return true;
      },
      (err) => {
        st.done = true;
        if (window.console) console.warn('[素材] ' + name + ' 的贴图解码失败，改用程序化外观', err);
        return false;
      }
    );
    return st.p;
  }
  // 解码到当前画质档为止：解码期间换了档就接着解新档；包被释放了就算没成。
  // g：要这个包时它的释放代数（relGen）。mem-hunt：包还在下载 / 解析时被释放了（换了区），下载完不再解码（原来照样解码、存进已经释放的包里）
  function texFor(name, g) {
    if (!(texOfPack[name] && texOfPack[name].length)) return Promise.resolve(true);
    if (g !== undefined && (relGen[name] || 0) !== g) return Promise.resolve(false);
    return decodeTex(name).then(() => {
      const st = texState[name];
      if (!st) return false;
      if (st.mode !== packMode(name) || !st.done) return texFor(name, g);
      return st.ok;
    });
  }
  function loadPack(name) {
    let st = packState[name];
    if (st) return st.p;
    st = packState[name] = { p: null, ok: false, done: false };
    const info = INDEX.packs[name];
    st.p = (async () => {
      try {
        if (!info && !STORE[name]) throw new Error('未知的素材包：' + name);
        if (!STORE[name]) {
          await Promise.race([
            loadScript(info.file),
            new Promise((_, rej) => setTimeout(() => rej(new Error('素材包加载超时：' + name)), 30000)),
          ]);
        }
        await decodePack(name);
        st.ok = true;
      } catch (e) {
        st.ok = false;
        const n = (packFails[name] = (packFails[name] || 0) + 1);
        const retry = n < MAX_TRIES && !!info; // 只有能重新下载的包才重试（文件丢了 / 网络抖了一下）
        if (window.console) console.warn('[素材] ' + (e && e.message ? e.message : e) + '，改用程序化外观' + (retry ? '（之后会重试）' : ''));
        if (retry) {
          if (packState[name] === st) delete packState[name];
          delete STORE[name]; // 脚本可能只执行了一半：下次重新加载文件
        }
      }
      st.done = true;
      return st.ok;
    })();
    return st.p;
  }

  // asset-lib：包的依赖（素材清单里的 with，比如 zone-ash 带上自产布景件包 kit-ash）展开进来，要一个包就连带要它的依赖
  function withDeps(names) {
    const out = [];
    const add = (n) => {
      if (out.indexOf(n) >= 0) return;
      out.push(n);
      const info = INDEX.packs[n];
      if (info && info.with) info.with.forEach(add);
    };
    names.forEach(add);
    return out;
  }
  // 一组包都加载完（不论成败）后 resolve 为「是否全部成功」
  // 要的时候记下每个包的释放代数：结果出来之前包被释放了（A.release 没留它），这次就算没成、也不解码（再要一次会重新解码）
  A.need = function (names) {
    return Promise.all(
      withDeps(names).map((n) => {
        const g = relGen[n] || 0;
        return loadPack(n).then((ok) => (ok ? texFor(n, g) : false));
      })
    ).then((r) => r.every(Boolean));
  };
  // 同步查询：这组包是否已经全部加载成功 / 是否已经有了结果（成功或失败）
  // ready 不展开依赖：布景件包坏了不该拖累地面贴图（世界层按 G.assets.geo 有没有模型单独判断布景）；settled 展开，等依赖也有了结果
  // 贴图包：ready 只要每张贴图有任意一份解码好的（刚换画质档、新的一份还在解码时先用旧的）；settled 要当前这一档解码完
  const anyTex = (n) => (texOfPack[n] || []).every((id) => !!A.tex(id));
  const texDone = (n) => !(texOfPack[n] && texOfPack[n].length) || (texState[n] && texState[n].done && texState[n].mode === packMode(n));
  A.ready = (names) => names.every((n) => packState[n] && packState[n].ok && anyTex(n));
  A.settled = (names) => withDeps(names).every((n) => packState[n] && packState[n].done && (!packState[n].ok || texDone(n)));
  A.known = (name) => !!(INDEX.packs[name] || STORE[name]);
  A.loading = (name) => !!(packState[name] && !packState[name].done); // 测试用：这个包要过、还在下载 / 解析
  // 当前画质档该用的那一份；还没解码好时先给别的已经解码的那份（none 占位图排最后），都没有就是 null
  A.tex = (id) => {
    const s = imgs[id];
    if (!s) return null;
    return s[variantOf(texEntry[id])] || s.full || s.lo || s.none || null;
  };
  A.texVariant = (id) => {
    const s = imgs[id], v = variantOf(texEntry[id]);
    return !s ? null : s[v] ? v : s.full ? 'full' : s.lo ? 'lo' : s.none ? 'none' : null;
  };
  A.texWant = (id) => variantOf(texEntry[id]); // 当前画质档想要的那一份
  // 画质档：低档有变化就返回 true（世界层接着 need 当前区的包、换掉区里纹理的图像，见 world.js 的 retierZone）
  A.setLow = function (on) {
    on = !!on;
    if (on === lowMode) return false;
    lowMode = on;
    return true;
  };
  A.isLow = () => lowMode;
  // 放掉一张解码过的图：src 换成 1×1 的 GIF，浏览器马上丢掉这张图的数据（不用等垃圾回收；WebKit 不这样做会一直留着）。
  // 只对已经不用的图做（离开的区的纹理在 disposeZone 里已经释放了显存）
  const GIF1 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  function freeImg(im) {
    try {
      if (im && im.tagName === 'IMG') {
        im.onload = im.onerror = null;
        im.src = GIF1;
      } else if (im && im.close) im.close();
    } catch (e) { /* 忽略 */ }
  }
  // 释放：只留 keep 这几个包（连同依赖）的 Image；留下的包里不是当前画质档的那一份（新的一份已经解码好了的话）也释放。
  // 返回释放了几张图。原文还在，之后 need 会重新解码
  A.release = function (keep) {
    const ks = new Set(withDeps(keep || []));
    let n = 0;
    // 没留的包（已经载好的、还在下载 / 解析的都算）释放代数 +1：还在路上的 need 作废，下载完不再解码
    for (const name in packState) if (!ks.has(name)) relGen[name] = (relGen[name] || 0) + 1;
    const drop = (id, v) => {
      const s = imgs[id];
      if (!s || !s[v]) return;
      if (v !== 'none')
        for (const k of KINDS)
          if (s[v][k]) {
            freeImg(s[v][k]);
            n++;
          }
      delete s[v];
    };
    for (const name in texOfPack) {
      const ids = texOfPack[name];
      if (!ids.length) continue;
      if (!ks.has(name)) {
        for (const id of ids) for (const v of ['full', 'lo', 'none']) drop(id, v);
        delete texState[name];
        continue;
      }
      for (const id of ids) {
        const want = variantOf(texEntry[id]);
        if (imgs[id] && imgs[id][want]) for (const v of ['full', 'lo', 'none']) if (v !== want) drop(id, v);
      }
    }
    return n;
  };
  // 测试 / 探针用：现在留着的解码图像（占位图不算）：张数、按 RGBA8 算的 MB、每张 id:变体:通道:边长
  A.texStats = function () {
    let n = 0, bytes = 0;
    const list = [];
    for (const id in imgs)
      for (const v in imgs[id]) {
        if (v === 'none') continue;
        for (const k of KINDS) {
          const im = imgs[id][v][k];
          if (!im) continue;
          n++;
          bytes += im.width * im.height * 4;
          list.push(id + ':' + v + ':' + k + ':' + im.width);
        }
      }
    const packs = Object.keys(texState).filter((k) => texState[k].done && texState[k].ok);
    return { images: n, mb: bytes / 1048576, list: list.sort(), packs: packs.sort(), low: lowMode, late: lateDropped };
  };
  A.texPending = (name) => !!(texState[name] && !texState[name].done); // 测试用：这个包这一档的解码还在路上
  A.geo = (key) => geos[key] || null;
  // 用完就放掉的几何体（AI 武器：主角骨架和两档掉落模型都建好以后，包里解码出来的源几何体不再要）
  A.dropGeo = (key) => {
    delete geos[key];
    delete geoInfo[key];
    delete geoPack[key];
  };
  A.geoInfo = (key) => geoInfo[key] || null;
  A.geoPack = (key) => geoPack[key] || null;
  A.packOfTex = (id) => INDEX.textures[id] || null;
})();
