// 烘焙开场故事的画格：node tools/story/bake.mjs [--panels p1,p6] [--try] [--out 目录] [--w 1600 --h 1000]
// 正式输出 assets/story/<格>/<层>.webp（--out 改目录）；--try 把每个候选镜头各出一张整图（不分层）做构图比较。
// 会起 Chrome：必须经由 cc-slot pool 跑，例如
//   cc-slot pool intro-story shots -- node tools/story/bake.mjs --panels p1
import path from 'node:path';
import fs from 'node:fs';
import { open, arg, ROOT } from './common.mjs';
import { PANELS } from './panels.mjs';

const ids = (arg('panels', Object.keys(PANELS).join(','))).split(',');
const tryMode = process.argv.includes('--try');
const out = path.resolve(arg('out', path.join(ROOT, 'assets/story')));
const OW = +arg('w', 1600), OH = +arg('h', 1000);
const t0 = Date.now();

// 渲染分辨率 = 输出 × 1.5（游戏「高」档的像素比上限），漫画处理在大图上做，再缩到输出尺寸
const S = await open({ width: OW, height: OH, quality: 'high', dpr: 1.5 });
try {
  await S.page.addScriptTag({ path: path.join(ROOT, 'tools/story/ink.js') });
  await S.hud(false);
  // 游戏镜头的朝向 / 视角 / 近裁面只在初始化时摆一次：先存下来，每一格开拍前还原（最后一格要用原样的游戏镜头）
  await S.ev(() => { const c = G.world.camera; window.__cam0 = { q: c.quaternion.clone(), fov: c.fov, near: c.near, far: c.far }; });
  let zone = '';
  for (const id of ids) {
    const P = PANELS[id];
    if (!P) throw new Error('没有这一格：' + id);
    // 布局种子固定（不固定时区域布局取决于进区前用掉了多少随机数，每次跑出来的深渊、房间都不一样）
    const key = P.pin ? 'pin' + P.pin : P.zone + ':' + (P.seed ?? 1);
    if (key !== zone) {
      if (P.pin) await S.ev((t) => G.enterPinnacle(t), P.pin); // 余烛殿：场地是固定的
      else await S.ev(([z, s]) => { G.debug.zoneSeed(s); G.enterZone(z, 0); }, [P.zone, P.seed ?? 1]);
      zone = key;
    }
    console.log(id, 'hd', await S.waitHd(45000));
    await S.ev(() => TT.settle(60));
    // 上一格留下的状态清掉：临时加的灯 / 物体（window.__tmp）、藏起来的主角
    await S.ev(() => {
      for (const o of window.__tmp || []) if (o.parent) o.parent.remove(o);
      window.__tmp = [];
      window.__points = null; window.__focus = null; window.__actors = []; window.__gamecam = null;
      const c = G.world.camera, c0 = window.__cam0;
      c.quaternion.copy(c0.q); c.fov = c0.fov; c.near = c0.near; c.far = c0.far; c.updateProjectionMatrix();
      window.__cam = null;
      const pe = G.player.ent;
      pe.group.visible = true;
      if (pe.ring) pe.ring.visible = false;
    });
    // 画格里有首领：先把脚本生成的首领包载进来（游戏里是进区、图标预热完以后才懒加载的；不等的话拍到的是原来的程序化外观）
    if (P.bosses) {
      const ok = await S.ev(async (ks) => {
        const r = {};
        for (const k of ks) { const p = 'boss-' + k; if (G.assets.known(p)) await G.assets.need([p]); r[k] = !!(G.world.bossRig && G.world.bossRig(k)); }
        return r;
      }, P.bosses);
      console.log(id, 'boss packs', JSON.stringify(ok));
      if (Object.values(ok).some((v) => !v)) throw new Error(id + ': boss pack missing ' + JSON.stringify(ok));
    }
    // 首领格：摆拍和「随机序列从固定种子重新开始」在同一次同步执行里（中间不让主循环插帧：渲染的帧里也有取 Math.random 的，
    // 等包的那一下和插进来的帧数每次不一样，首领出生时取的相位 / 时钟 / 步态跟着变，姿势就差一点）。其它格照旧
    if (P.bosses) {
      const run = new Function('key', [
        'let a = 20261121;',
        'for (let i = 0; i < key.length; i++) a = Math.imul(a ^ key.charCodeAt(i), 16777619) >>> 0;',
        'Math.random = function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };',
        'return ({ ' + P.setup.toString() + ' }).setup();',
      ].join('\n'));
      await S.page.evaluate(run, 'story:' + id);
    } else await S.ev(P.setup);
    // 画面时钟定住（发光圈 / 水面 / 火光的相位和打开页面花了多久无关）：两次烘出来一样
    await S.ev(() => { if (G.world.debugTime) G.world.debugTime(10); });
    // ready：场景里关键的东西建好了没有（比如深渊的崖口：换区后地形有一部分是在空档里补算的）
    if (P.ready) {
      const t1 = Date.now();
      let rr;
      while (!(rr = await S.ev(P.ready)) || rr.ok === false) {
        if (rr && rr.why) console.log('   not ready:', rr.why);
        if (Date.now() - t1 > 60000) throw new Error(id + '：场景一直没准备好');
        await S.frames(10);
        await S.ev(() => TT.settle(5));
      }
      console.log(id, 'ready after', Date.now() - t1, 'ms');
    }
    // 雾：这一格自己定的，没有就回到游戏默认（上一格的近雾不能留到这一格）
    await S.ev((f) => { const fg = G.world.scene.fog; G.world.setGloom(null); if (f) { fg.near = f[0]; fg.far = f[1]; } }, P.fog || null);
    await S.frames(3); // 让主循环跑几帧（渲染 / 地形分块 / 材质的每帧 uniform；模拟停着，动作帧不动）
    const focus = await S.ev(() => window.__focus || [0, 0]);
    const abs = (c) => (P.gamecam ? { game: true, hide: c.hide } : c.rel ? { pos: [focus[0] + c.rel[0], c.rel[1], focus[1] + c.rel[2]], at: [focus[0] + c.at[0], c.at[1], focus[1] + c.at[2]], fov: c.fov, roll: c.roll, hide: c.hide } : c);
    const dir = path.join(out, id);
    fs.mkdirSync(dir, { recursive: true });
    const cams = tryMode ? P.cams.map(abs) : [abs(P.cams[P.cam || 0])];
    // 这一格的输出尺寸：宽高比 aspect（一页多格里的格子），长边不超过 1600×1000
    const asp = P.aspect || OW / OH;
    const ow = asp >= OW / OH ? OW : Math.round(OH * asp), oh = asp >= OW / OH ? Math.round(OW / asp) : OH;
    // points：setup 里记下的世界坐标（window.__points），按这台镜头换成画面比例，播放器的火光 / 粒子按它摆
    const pts = await S.ev((cam) => {
      const o = {};
      for (const k in window.__points || {}) o[k] = STORY_BAKE.screenOf(cam, window.__points[k]);
      return o;
    }, cams[0]);
    // 裁成 aspect 以后的比例坐标
    {
      const a0 = OW / OH;
      for (const k in pts) {
        const [x, y] = pts[k];
        pts[k] = asp > a0 ? [x, +(0.5 + (y - 0.5) * (asp / a0)).toFixed(4)] : [+(0.5 + (x - 0.5) * (a0 / asp)).toFixed(4), y];
      }
    }
    if (Object.keys(pts).length) console.log('  ', id, 'points', JSON.stringify(pts));
    for (const [ci, cam] of cams.entries()) {
      const layers = tryMode ? [{ name: 'try' + ci, mode: 'full', fx: false, hide: cam.hide, debug: process.argv.includes('--debug') }] : P.layers;
      const meta = { id, cam, layers: [] };
      for (const L of layers) {
        const r = await S.ev(([cam, L, ow, oh]) => STORY_BAKE.layer(cam, window.__actors || [], L, ow, oh), [cam, L, ow, oh]);
        const save = (name, url) => {
          const f = path.join(dir, name + '.webp');
          fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
          console.log('  ', path.relative(ROOT, f), Math.round(fs.statSync(f).size / 1024) + ' KB', r.w + 'x' + r.h);
          meta.layers.push(name);
        };
        if (r.depthInfo) console.log('   depth', JSON.stringify(r.depthInfo));
        save(L.name, r.webp);
        if (r.dbg) { save(L.name + '-raw', r.dbg.raw); save(L.name + '-depth', r.dbg.depth); }
        if (r.near) save(L.name + '-near', r.near);
      }
    }
  }
  console.log('done', Math.round((Date.now() - t0) / 1000) + 's');
} finally {
  await S.close();
}
