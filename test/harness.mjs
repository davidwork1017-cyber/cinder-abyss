// 测试用：用系统 Chrome 无头打开游戏，收集报错
// 游戏经由本地静态 HTTP 服务打开（test/serve.mjs，和 GitHub Pages 一样按文件发），不是 file://。
// 要看 file:// 下的表现：CINDER_FILE=1 npm test（经典脚本 + base64 素材包，file:// 也能跑，但上线用的是 HTTP）。
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { serve } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let url0;
if (process.env.CINDER_FILE) url0 = pathToFileURL(path.join(root, 'index.html')).href;
else {
  // 随机端口；unref：测试脚本跑完、浏览器关掉后进程照常退出，不会被这个服务拖住
  const { server, url } = await serve();
  server.unref();
  url0 = url + 'index.html';
}
export const GAME_URL = url0;

export async function launch({ width = 1440, height = 900, url = GAME_URL } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await page.goto(url);
  return { browser, page, errors };
}
