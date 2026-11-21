// 开场故事的烘焙工具共用部分：起游戏（test/harness.mjs，本地 HTTP，和 Pages 一样）、固定随机种子、
// 停住模拟、隐藏 HUD、接管镜头。只在烘焙 / 调构图时用，游戏本身不加载这里的任何东西。
// 必须经由 cc-slot pool 跑（会起 Chrome）。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function open(o = {}) {
  const width = o.width || 1600, height = o.height || 1000;
  const { launch, GAME_URL } = await import(path.join(ROOT, 'test/harness.mjs'));
  const { browser, page, errors } = await launch({ width, height, url: 'about:blank', dpr: o.dpr || null });
  const seed = o.seed === undefined ? 20261121 : o.seed;
  // 固定种子的 Math.random：区域布局、刷怪、粒子每次都一样，烘出来的图可复现
  await page.addInitScript((seed) => {
    let a = seed >>> 0;
    Math.random = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }, seed);
  await page.goto(GAME_URL);
  const ev = (fn, a) => page.evaluate(fn, a);
  const frames = (n) => ev((n) => new Promise((res) => { let i = 0; const f = () => (++i > n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 1);
  await page.waitForFunction(() => window.G && G.debug && G.state && G.state.zone && G.player && G.player.ent, null, { timeout: 180000 });
  await page.keyboard.press('Enter'); // 关掉开场卡片
  await ev((q) => {
    G.save.opts.quality = q;
    G.world.setQuality(q);
    G.debug.god(true);
    G.debug.hold(true);
    const W = G.world, P = G.player, St = G.state;
    // 镜头接管：window.__cam = { pos:[x,y,z], at:[x,y,z], fov, roll }；每次渲染前摆好、渲染后还原，游戏自己的镜头逻辑不受影响
    const orig = W.render;
    const q0 = new THREE.Quaternion(), p0 = new THREE.Vector3();
    W.render = function () {
      const c = window.__cam, cam = W.camera;
      if (!c) return orig();
      q0.copy(cam.quaternion);
      p0.copy(cam.position);
      const fov0 = cam.fov;
      cam.position.set(c.pos[0], c.pos[1], c.pos[2]);
      cam.lookAt(c.at[0], c.at[1], c.at[2]);
      if (c.roll) cam.rotateZ(c.roll);
      if (c.fov) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
      orig();
      cam.quaternion.copy(q0);
      cam.position.copy(p0);
      if (c.fov) { cam.fov = fov0; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
    };
    window.TT = {
      tp(x, z, face) {
        P.x = x; P.z = z; P.cast = null; P.roll.t = 0;
        if (face !== undefined) { P.face = face; P.drawFace = face; }
        W.setEnt(P.ent, x, z, P.face);
      },
      clear() {
        if (G.clearMinions) G.clearMinions();
        G.clearEnemies();
        for (const l of St.loot) W.removeMesh(l.mesh);
        St.loot.length = 0;
      },
      mob(type, x, z, o) {
        o = o || {};
        const e = G.spawnMob(type, x, z, o.level || 1, { awake: true, elite: !!o.elite });
        e.wasAwake = true;
        if (!o.kill) e.hp = e.maxHp = 1e6;
        if (!o.atk) e.atkCd = 1e9;
        if (!o.move) e.speed = 0;
        if (o.face !== undefined) e.face = o.face;
        return e;
      },
      tick(n) { for (let i = 0; i < n; i++) G.tick(1 / 60); },
      settle(n) { for (let i = 0; i < (n || 120); i++) W.update(1 / 60); },
      aim(x, z) { G.input.mouse.wx = x; G.input.mouse.wz = z; },
    };
  }, o.quality || 'high');
  const hud = (on) => ev((on) => {
    for (const el of document.body.children) {
      if (el === G.world.renderer.domElement || el.tagName === 'SCRIPT') continue;
      if (!on) { if (el.dataset.stHide === undefined) { el.dataset.stHide = el.style.display || ''; el.style.display = 'none'; } }
      else if (el.dataset.stHide !== undefined) { el.style.display = el.dataset.stHide; delete el.dataset.stHide; }
    }
  }, on);
  const cam = (c) => ev((c) => { window.__cam = c; }, c || null);
  const waitHd = async (ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(() => G.world.gfxInfo().hd)) {
        await new Promise((r) => setTimeout(r, 900));
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
  const shot = async (file, opt) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, ...(opt || {}) });
    console.log('shot', file);
  };
  const close = async () => {
    if (errors.length) console.log('PAGE ERRORS:', errors.join('\n').slice(0, 3000));
    await browser.close();
  };
  return { browser, page, errors, ev, frames, hud, cam, waitHd, shot, close, width, height };
}

export function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
