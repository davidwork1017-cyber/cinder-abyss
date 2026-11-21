'use strict';
// assets.js —— 外部 CC0 素材（地面 / 岩壁贴图、布景模型）的按需加载。
// 素材由 tools/pack-assets.mjs 打成 js/assets/*.js（base64），这里按包名插入 <script> 加载：从 file:// 双击打开也能用。
// 贴图解码成 Image 后常驻（换区时世界层只释放显存里的纹理）；模型用 r128 的 GLTFLoader 解析，
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
  const imgs = Object.create(null); // 贴图 id → { albedo, normal, arh, avg: [r,g,b]（反照率的线性平均色） }
  const geos = Object.create(null); // 模型 key → BufferGeometry
  const geoInfo = Object.create(null); // 模型 key → { h, r }（高度、水平半径）
  const geoPack = Object.create(null); // 模型 key → 来自哪个包（测试用来核对第 0 区的布景是不是自产件）

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
    for (const id in data.tex || {}) {
      const t = data.tex[id];
      jobs.push(
        Promise.all([loadImage(t.albedo), loadImage(t.normal), loadImage(t.arh)]).then(([albedo, normal, arh]) => {
          imgs[id] = { albedo, normal, arh, avg: avgColor(albedo) };
        })
      );
    }
    for (const key in data.models || {}) jobs.push(parseModel(key, data.models[key]).then((g) => g && (geoPack[key] = name)));
    await Promise.all(jobs);
    // 解码完就丢掉 base64 原文（图像和几何体已经各自留了一份），省几 MB 内存
    data.tex = null;
    data.models = null;
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
  A.need = function (names) {
    return Promise.all(withDeps(names).map(loadPack)).then((r) => r.every(Boolean));
  };
  // 同步查询：这组包是否已经全部加载成功 / 是否已经有了结果（成功或失败）
  // ready 不展开依赖：布景件包坏了不该拖累地面贴图（世界层按 G.assets.geo 有没有模型单独判断布景）；settled 展开，等依赖也有了结果
  A.ready = (names) => names.every((n) => packState[n] && packState[n].ok);
  A.settled = (names) => withDeps(names).every((n) => packState[n] && packState[n].done);
  A.known = (name) => !!(INDEX.packs[name] || STORE[name]);
  A.tex = (id) => imgs[id] || null;
  A.geo = (key) => geos[key] || null;
  A.geoInfo = (key) => geoInfo[key] || null;
  A.geoPack = (key) => geoPack[key] || null;
  A.packOfTex = (id) => INDEX.textures[id] || null;
})();
