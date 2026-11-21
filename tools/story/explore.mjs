// 调构图用：进某个区域，打印布局里的地标，按给的镜头拍几张。
// node tools/story/explore.mjs <outDir> <zoneIdx> [shots.json]
import path from 'node:path';
import fs from 'node:fs';
import { open } from './common.mjs';

const out = process.argv[2], zi = +process.argv[3];
const spec = process.argv[4] && !process.argv[4].startsWith('--') ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) : null;
const S = await open({ width: 1280, height: 800 });
try {
  const seed = process.argv.includes('--seed') ? +process.argv[process.argv.indexOf('--seed') + 1] : null;
  if (seed !== null) await S.ev((s) => G.debug.zoneSeed(s), seed);
  if (zi || seed !== null) await S.ev((zi) => G.enterZone(zi, 0), zi);
  console.log('hd', await S.waitHd(40000));
  await S.ev(() => { TT.settle(90); });
  await S.hud(false);
  const info = await S.ev(() => {
    const z = G.state.zone, L = z.layout || z.L || z.spec || null;
    const keys = Object.keys(z);
    let feats = null;
    const sp = (z.layout && z.layout.spec) || z.spec || (L && L.spec);
    if (sp && sp.feats) feats = sp.feats.map((f) => ({ kind: f.kind, x: f.x, z: f.z, r: f.r, pts: f.pts && f.pts.map((p) => p.map((v) => +(+v).toFixed(1))) }));
    return { keys, player: [G.player.x, G.player.z, G.player.face], feats, boss: G.state.boss && [G.state.boss.x, G.state.boss.z] };
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'info.json'), JSON.stringify(info, null, 1));
  console.log(JSON.stringify(info).slice(0, 1500));
  await S.frames(2);
  await S.shot(path.join(out, 'gamecam.png'));
  for (const [i, c] of (spec || []).entries()) {
    await S.ev((c) => {
      if (c.tp) { TT.tp(c.tp[0], c.tp[1], c.tp[2] || 0); TT.settle(20); }
      G.player.ent.group.visible = !c.hideP; if (G.player.ent.ring) G.player.ent.ring.visible = !c.hideP;
      const f = G.world.scene.fog;
      if (c.fog) { f.near = c.fog[0]; f.far = c.fog[1]; } else G.world.setGloom(null);
    }, c);
    await S.cam(c);
    await S.frames(3);
    await S.shot(path.join(out, 'cam' + i + '.png'));
  }
} finally {
  await S.close();
}
