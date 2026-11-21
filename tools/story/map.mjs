// 调构图用：打印区域的可走地图（ASCII，每格 2 米），标出玩家、首领位置
import { open } from './common.mjs';
const zi = +process.argv[2];
const S = await open({ width: 640, height: 400 });
try {
  if (zi) await S.ev((zi) => G.enterZone(zi, 0), zi);
  const r = await S.ev(() => {
    const z = G.state.zone, W = G.world, b = z.bounds;
    const rows = [];
    const x0 = b.minX ?? b.x0 ?? b[0], x1 = b.maxX ?? b.x1 ?? b[2], z0 = b.minZ ?? b.z0 ?? b[1], z1 = b.maxZ ?? b.z1 ?? b[3];
    for (let zz = z0; zz <= z1; zz += 2) {
      let s = '';
      for (let xx = x0; xx <= x1; xx += 2) {
        const p = Math.hypot(xx - G.player.x, zz - G.player.z) < 1.5;
        s += p ? 'P' : W.walkable(xx, zz, 0) ? '.' : ' ';
      }
      rows.push(String(Math.round(zz)).padStart(5) + ' ' + s);
    }
    return { bounds: b, start: z.start, bossPos: z.bossPos, player: [G.player.x, G.player.z], x0, rows };
  });
  console.log(JSON.stringify({ bounds: r.bounds, start: r.start, bossPos: r.bossPos, player: r.player, x0: r.x0 }));
  console.log(r.rows.join('\n'));
} finally { await S.close(); }
