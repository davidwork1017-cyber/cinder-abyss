// 调姿势用：按某一格的 setup 摆好场景，再把几组姿势（JSON：[{ keys, cam }…]）依次套到主角身上各拍一张（整图、不分层）。
// 关节位置标一个小红球，用来核对 jointPos。
// node tools/story/posetest.mjs <outDir> <panelId> <variants.json>
import path from 'node:path';
import fs from 'node:fs';
import { open, ROOT } from './common.mjs';
import { PANELS } from './panels.mjs';

const out = path.resolve(process.argv[2]), P = PANELS[process.argv[3]];
const vars = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
fs.mkdirSync(out, { recursive: true });
const S = await open({ width: 1280, height: 800, quality: 'high' });
try {
  await S.page.addScriptTag({ path: path.join(ROOT, 'tools/story/ink.js') });
  await S.hud(false);
  await S.ev(([z, s]) => { G.debug.zoneSeed(s); G.enterZone(z, 0); }, [P.zone, P.seed ?? 1]);
  await S.waitHd(45000);
  await S.ev(() => TT.settle(60));
  await S.ev(() => { window.__noPose = true; window.__tmp = []; });
  await S.ev(P.setup);
  await S.ev((f) => { const fg = G.world.scene.fog; if (f) { fg.near = f[0]; fg.far = f[1]; } }, P.fog || null);
  await S.frames(3);
  for (const [i, v] of vars.entries()) {
    const r = await S.ev(([v, i]) => {
      const Pl = G.player, f = window.__focus || [Pl.x, Pl.z];
      if (v.keys) STORY_BAKE.pose(Pl.ent, 'storyTest' + i, v.keys);
      const c = v.cam;
      const cam = { pos: [f[0] + c.rel[0], c.rel[1], f[1] + c.rel[2]], at: [f[0] + c.at[0], c.at[1], f[1] + c.at[2]], fov: c.fov };
      // 关节标记
      (window.__marks || []).forEach((m) => G.world.scene.remove(m));
      window.__marks = [];
      const pts = {};
      for (const [jn, off] of v.marks || []) {
        const p = STORY_BAKE.jointPos(Pl.ent, jn, off);
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false }));
        m.position.copy(p);
        m.renderOrder = 99;
        G.world.scene.add(m);
        window.__marks.push(m);
        pts[jn] = STORY_BAKE.screenOf(cam, p);
      }
      const res = STORY_BAKE.layer(cam, [], { name: 't', mode: 'full', fx: false, hide: ['points', 'normalfx'], depth: false }, 1280, 800);
      return { webp: res.webp, pts };
    }, [v, i]);
    fs.writeFileSync(path.join(out, 'v' + i + '.webp'), Buffer.from(r.webp.split(',')[1], 'base64'));
    console.log('v' + i, JSON.stringify(r.pts));
  }
} finally {
  await S.close();
}
