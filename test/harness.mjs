// 测试用：用系统 Chrome 无头打开游戏，收集报错
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GAME_URL = 'file://' + path.join(root, 'index.html');

// title：要不要显示标题画面。默认 false——测试和各种截图 / 计时脚本一进页面就和以前一样直接进区（每次导航前设 window.__skipTitle，
// 重载页面也一样跳过）；只有测标题画面本身的步骤传 title: true
export async function launch({ width = 1440, height = 900, url = GAME_URL, title = false } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  if (!title) await page.addInitScript(() => { window.__skipTitle = true; });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await page.goto(url);
  return { browser, page, errors };
}
