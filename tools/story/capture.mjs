// 开场故事的截图 / 动态：在游戏页面里放故事（G.ui.playStory，暂停时间），按时间点摆好画面截图。
// node tools/story/capture.mjs <outDir> [--panels 0,5] [--sizes 1280x800,1024x640] [--strip 10] [--video 24] [--low]
//   每格：<outDir>/<格>_<宽>x<高>.png（字幕全出来的那一刻）、<格>_strip_NN.png（整格均匀取 N 帧）、
//   --video：<格>_<宽>x<高>/f_NNNN.png 逐帧（用 ffmpeg 拼成 mp4）
// 会起 Chrome：经由 cc-slot pool 跑。
import path from 'node:path';
import fs from 'node:fs';
import { arg, ROOT } from './common.mjs';

const out = path.resolve(process.argv[2]);
const panels = arg('panels', '0,5').split(',').map(Number);
const sizes = arg('sizes', '1280x800,1024x640').split(',').map((s) => s.split('x').map(Number));
const nStrip = +arg('strip', 10);
const fps = +arg('video', 0);
const low = process.argv.includes('--low');
fs.mkdirSync(out, { recursive: true });

const { launch, GAME_URL } = await import(path.join(ROOT, 'test/harness.mjs'));
for (const [w, h] of sizes) {
  const { browser, page, errors } = await launch({ width: w, height: h, url: 'about:blank' });
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()); });
  try {
    await page.goto(GAME_URL);
    await page.waitForFunction(() => window.G && G.ui && G.state && G.state.zone && G.player && G.player.ent, null, { timeout: 180000 });
    await page.keyboard.press('Enter');
    await page.addStyleTag({ content: '.st-hint { display: none !important; }' }); // 「点击继续 · 按住跳过」几秒后自己淡掉，截图里不要
    if (low) await page.evaluate(() => G.world.setQuality('low'));
    const ev = (fn, a) => page.evaluate(fn, a);
    for (const pi of panels) {
      await ev((pi) => G.ui.playStory(null, { from: pi, paused: true, silent: true }), pi);
      await page.waitForFunction(() => G.story && document.querySelector('#story.ready'), null, { timeout: 30000 });
      const info = await ev(() => G.story.info());
      const P = info.panels[pi];
      // 这一格要的图都解码好了再拍
      await page.waitForFunction((pi) => G.story.urls()[pi].every((u) => G.story.loaded().includes(u) || G.story.failed().includes(u)), pi, { timeout: 30000 });
      const fails = await ev(() => G.story.failed());
      if (fails.length) console.log('missing images:', fails.join(', '));
      const t0 = P.t0, tEnd = P.t0 + P.dur - 0.75; // 不拍换格的那一段
      const shotAt = async (t, file, steps) => {
        await ev(([t, n]) => { G.story.seek(t); G.story.stepFx(n, 1 / 30); }, [t, steps]);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.screenshot({ path: file });
      };
      // 主图：字幕全出来、镜头走了大半
      const main = path.join(out, P.id + '_' + w + 'x' + h + '.png');
      await shotAt(t0 + P.dur * 0.62, main, 150);
      console.log('shot', path.relative(ROOT, main));
      if (nStrip && w === sizes[0][0]) {
        for (let k = 0; k < nStrip; k++) {
          const t = t0 + ((tEnd - t0) * k) / (nStrip - 1);
          await shotAt(t, path.join(out, P.id + '_strip_' + String(k).padStart(2, '0') + '.png'), k === 0 ? 150 : 8);
        }
        console.log('strip', P.id, nStrip);
      }
      if (fps && w === sizes[0][0]) {
        const dir = path.join(out, P.id + '_' + w + 'x' + h);
        fs.mkdirSync(dir, { recursive: true });
        const n = Math.round((P.dur - 0.75) * fps); // 到换格之前（样张只有这一格的图）
        await ev(() => G.story.stepFx(150, 1 / 30));
        for (let k = 0; k < n; k++) {
          const t = Math.max(0, t0 - 0.0) + k / fps;
          await ev(([t, d]) => { G.story.seek(t); G.story.stepFx(1, d); }, [t, 1 / fps]);
          await page.screenshot({ path: path.join(dir, 'f_' + String(k).padStart(4, '0') + '.png') });
        }
        console.log('video frames', P.id, n);
      }
      await ev(() => G.story.skip());
      await page.waitForFunction(() => !G.ui.storyOn(), null, { timeout: 10000 });
    }
    if (errors.length) console.log('PAGE ERRORS:', errors.join('\n').slice(0, 2000));
    const realBad = bad.filter((b) => !/assets\/story\//.test(b) || !process.argv.includes('--allow-missing'));
    if (realBad.length) console.log('HTTP >= 400:', realBad.join('\n'));
  } finally {
    await browser.close();
  }
}
