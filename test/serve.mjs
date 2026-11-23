// 本地静态 HTTP 服务：把仓库根目录原样发出去，和 GitHub Pages 的发法一致（静态文件、按扩展名给 Content-Type）。
// 测试（test/harness.mjs）在进程里起一个随机端口的；自己看游戏用 npm run serve（默认 8080，可传端口：node test/serve.mjs 9000）。
// 只用 Node 自带模块，不用装全局工具。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';
import { execFile } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// 起服务，返回 { server, url }；port 0 = 随机端口。stats 传一个对象进来会累计请求数、发出的字节数和请求过的文件（测加载量用）；
// root 缺省是本仓库（工具可以拿它发别的 checkout）
export function serve({ port = 0, host = '127.0.0.1', stats = null, root = ROOT } = {}) {
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    // 路径里带 NUL（%00）时 fs.stat 会同步抛错，整个进程（连同跑着的测试）直接崩掉，先挡掉
    if (rel.includes('\0')) {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    // /__old/<提交>/<路径>：发某个旧提交里的文件（git cat-file，按需取、取过就缓存）。和当前代码同源、共用 localStorage，
    // 测试拿它验证「退回旧代码」：旧版本读新代码写的存档（test/smoke.mjs 的多存档步骤）。Pages 上没有这个路径
    const om = /^\/__old\/([0-9a-f]{7,40})\/(.+)$/.exec(rel);
    if (om) return sendOld(req, res, root, om[1], om[2], stats);
    const file = path.join(root, rel);
    // 不许跳出仓库根目录；node_modules 和 .git 不发（Pages 上也没有）
    if (!file.startsWith(root + path.sep) || /[\\/](node_modules|\.git)([\\/]|$)/.test(file.slice(root.length))) {
      res.writeHead(404).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (stats) {
        stats.requests = (stats.requests || 0) + 1;
        stats.bytes = (stats.bytes || 0) + st.size;
        (stats.files || (stats.files = [])).push(rel);
      }
      if (req.method === 'HEAD') res.end();
      // pipeline：读文件出错时不抛未处理的 error 事件，页面中途断开时也会关掉文件句柄（pipe 两样都不管）
      else pipeline(fs.createReadStream(file), res, () => {});
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok({ server, url: 'http://' + host + ':' + server.address().port + '/' }));
  });
}

const oldCache = new Map();
function sendOld(req, res, root, commit, rel, stats) {
  if (rel.split('/').some((p) => p === '..' || p === '.' || p === '') || /^(node_modules|\.git)(\/|$)/.test(rel)) {
    res.writeHead(404).end();
    return;
  }
  const key = commit + ':' + rel;
  let p = oldCache.get(key);
  if (!p) {
    p = new Promise((ok) =>
      execFile('git', ['-C', root, 'cat-file', 'blob', key], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (err, out) => ok(err ? null : out))
    );
    oldCache.set(key, p);
  }
  p.then((buf) => {
    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    if (stats) {
      stats.requests = (stats.requests || 0) + 1;
      stats.bytes = (stats.bytes || 0) + buf.length;
    }
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ port: +(process.argv[2] || 8080) });
  console.log('烬渊：' + url + '（Ctrl+C 停止）');
}
