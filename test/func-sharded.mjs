// test:func 分片并行跑（test/README.md「分片」）：起 n 个 `cc-slot pool <名字> func --wait <分钟> -- timeout <秒> node test/smoke.mjs --func --shard i/n`，
// 每份占一个池令牌、一个浏览器；等这 n 个子进程退出（按 pid，不轮询进程表），把各份的日志按整套跑的先后（块的顺序）拼成一份，
// 开头一行带 HEAD，最后一行是合计的「通过 N 项」。任何一份失败、没跑完、HEAD 对不上、块缺了或重了，都以非 0 退出。
//
//   npm run test:func:sharded -- 3 --name <工人名>            # 3 份，日志在 test-logs/sharded-<UTC>-<pid>/，合并结果打到 stdout
//   node test/func-sharded.mjs 3 --name <工人名> --out <目录>  # 各份日志和合并的 func.log 放到 <目录>
// 选项：--wait <分钟>（排队上限，默认 360）、--timeout <秒>（每份在槽位里面的限时，默认 7200）、--out <目录>。
// 名字也可以用环境变量 CC_SLOT_NAME 给。不能在池令牌里面跑（一个令牌只开一个浏览器）；在独占槽位里面跑时 n 份直接并行。
import { spawn, execSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const die = (msg, rc = 2) => {
  console.error('func-sharded: ' + msg);
  process.exit(rc);
};
const n = +argv.find((a, i) => /^\d+$/.test(a) && !/^--/.test(argv[i - 1] || ''));
const name = opt('--name', process.env.CC_SLOT_NAME);
const waitMin = opt('--wait', '360');
const tmo = opt('--timeout', '7200');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const out = path.resolve(opt('--out', path.join(root, 'test-logs', 'sharded-' + stamp + '-' + process.pid)));

// 块和分法从 smoke.mjs 的源码里读（FUNC_BLOCKS / SHARDS），不在这里另抄一份
const src = readFileSync(path.join(root, 'test', 'smoke.mjs'), 'utf8');
const blkSrc = (src.match(/const FUNC_BLOCKS = \[([\s\S]*?)\n\];/) || [])[1] || '';
const BLOCKS = [...blkSrc.matchAll(/\{ id: '([a-z0-9-]+)'|\n {4}id: '([a-z0-9-]+)'/g)].map((m) => m[1] || m[2]);
const shSrc = (src.match(/const SHARDS = \{([\s\S]*?)\n\};/) || [])[1] || '';
const SHARDS = Object.fromEntries([...shSrc.matchAll(/\n {2}(\d+): (\[.*\]),/g)].map((m) => [m[1], JSON.parse(m[2].replace(/'/g, '"'))]));
if (BLOCKS.length < 2 || !Object.keys(SHARDS).length) die('没能从 test/smoke.mjs 里读出 FUNC_BLOCKS / SHARDS');
if (!SHARDS[n]) die('用法：node test/func-sharded.mjs <n> --name <工人名>，n = ' + Object.keys(SHARDS).join(' / '));
if (/^pool:/.test(process.env.CC_SLOT_HELD || '')) die('不能在池令牌里面跑分片（' + process.env.CC_SLOT_HELD + '）：一个令牌只开一个浏览器，n 份要各占一个令牌');
let slot = true;
try {
  execSync('command -v cc-slot', { stdio: 'ignore', shell: '/bin/bash' });
} catch (e) {
  slot = false;
}
if (slot && !name) die('要给 cc-slot 的名字：--name <工人名>（或环境变量 CC_SLOT_NAME）');
let head = '?';
try {
  head = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch (e) {}
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const mmss = (ms) => Math.floor(ms / 60000) + ':' + String(Math.round((ms % 60000) / 1000)).padStart(2, '0');
const say = (m) => console.error(new Date().toISOString().slice(11, 19) + 'Z func-sharded: ' + m);

// ------------------------------------------------------------------ 起 n 份
const kids = [];
for (let k = 1; k <= n; k++) {
  const log = path.join(out, 'shard-' + k + '.log');
  const fd = openSync(log, 'w');
  const cmd = ['timeout', tmo, process.execPath, 'test/smoke.mjs', '--func', '--shard', k + '/' + n];
  const full = slot ? ['cc-slot', 'pool', name, 'func', '--wait', waitMin, '--', ...cmd] : cmd;
  // detached：每份自成一个进程组，收到 SIGTERM 时整组叫停（cc-slot → timeout → node → Chrome）
  const ch = spawn(full[0], full.slice(1), { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const kid = { k, log, pid: ch.pid, start: Date.now(), end: 0, rc: null, sig: null, blocks: SHARDS[n][k - 1] };
  kid.done = new Promise((res) => {
    ch.on('exit', (rc, sig) => {
      kid.rc = rc;
      kid.sig = sig;
      kid.end = Date.now();
      say('分片 ' + k + '/' + n + ' 结束：' + (sig ? '信号 ' + sig : 'rc ' + rc) + '，' + mmss(kid.end - kid.start));
      res();
    });
    ch.on('error', (e) => {
      kid.rc = 127;
      kid.end = Date.now();
      kid.err = String(e.message || e);
      say('分片 ' + k + '/' + n + ' 起不来：' + kid.err);
      res();
    });
  });
  kids.push(kid);
  say('分片 ' + k + '/' + n + '（' + kid.blocks.join(' ') + '）pid ' + ch.pid + ' → ' + path.relative(root, log));
}
let stopping = false;
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(s, () => {
    if (stopping) return;
    stopping = true;
    console.log('KILLED 收到 ' + s + '：叫停 ' + n + ' 份（整个进程组），本次作废');
    for (const kid of kids) {
      if (kid.end) continue;
      try {
        process.kill(-kid.pid, 'SIGTERM');
      } catch (e) {}
    }
    setTimeout(() => process.exit(s === 'SIGINT' ? 130 : s === 'SIGHUP' ? 129 : 143), 3000).unref();
  });
}
await Promise.all(kids.map((k) => k.done));

// ------------------------------------------------------------------ 拼日志
const bad = []; // 合并时发现的问题（每条都让退出码非 0）
const byBlock = {};
const STEP = /^(ok {3}|FAIL )/;
let passed = 0, failed = 0;
const per = [];
const tails = [];
for (const kid of kids) {
  const lines = existsSync(kid.log) ? readFileSync(kid.log, 'utf8').split('\n') : [];
  const hdr = lines.find((l) => l.startsWith('== test:func · '));
  const hHead = hdr && (hdr.match(/ · HEAD (\S+) · /) || [])[1];
  const hTime = hdr && (hdr.match(/ · (\d{4}-\d\d-\d\dT[\d:.]+Z) · /) || [])[1];
  const hSlot = hdr && (hdr.match(/ · 槽位 (\S+)/) || [])[1];
  const hLog = hdr && (hdr.match(/Chrome 日志 (\S+)/) || [])[1];
  const sumLine = [...lines].reverse().find((l) => /^(失败 \d+ 项，)?通过 \d+ 项$/.test(l));
  const sp = sumLine ? +(sumLine.match(/通过 (\d+) 项/) || [])[1] : 0;
  const sf = sumLine ? +((sumLine.match(/失败 (\d+) 项/) || [])[1] || 0) : 0;
  let cur = null, nOk = 0, nFail = 0, finished = false;
  const seen = [];
  for (const l of lines) {
    const m = /^== 块 (\S+)$/.exec(l);
    if (m) {
      if (m[1] === '完') {
        finished = true;
        cur = null;
        continue;
      }
      cur = m[1];
      seen.push(cur);
      if (byBlock[cur]) bad.push('块 ' + cur + ' 跑了不止一次（分片 ' + byBlock[cur].k + ' 和 ' + kid.k + '）');
      byBlock[cur] = { k: kid.k, lines: [] };
      continue;
    }
    if (cur) byBlock[cur].lines.push(l);
    else if (finished && /^(CHROME-DIED|KILLED|WARN|note|audit)/.test(l)) tails.push('[分片 ' + kid.k + '] ' + l);
    else if (!finished && /^(KILLED|WARN|note|FAIL)/.test(l)) tails.push('[分片 ' + kid.k + '] ' + l);
    if (STEP.test(l)) l.startsWith('ok') ? nOk++ : nFail++;
  }
  // 每份自己的检查：HEAD、跑完、合计和逐行数的一致、该跑的块都跑了
  const qMs = hTime ? Date.parse(hTime) - kid.start : null;
  const runMs = hTime ? kid.end - Date.parse(hTime) : null;
  if (!hdr) bad.push('分片 ' + kid.k + ' 没有开头那行（没起来？见 ' + path.relative(root, kid.log) + (kid.err ? '：' + kid.err : '') + '）');
  else if (hHead !== head) bad.push('分片 ' + kid.k + ' 的 HEAD 是 ' + hHead + '，不是 ' + head + '（跑的时候换了提交？）');
  if (kid.rc !== 0) bad.push('分片 ' + kid.k + ' 退出码 ' + (kid.sig ? '信号 ' + kid.sig : kid.rc) + (kid.rc === 3 ? '（排队超过 ' + waitMin + ' 分钟没拿到令牌）' : kid.rc === 124 || kid.rc === 143 ? '（到了 timeout ' + tmo + ' 秒或被叫停，结果作废）' : ''));
  if (hdr && !finished) bad.push('分片 ' + kid.k + ' 没跑完（没有「== 块 完」）');
  if (sumLine && (sp !== nOk || sf !== nFail)) bad.push('分片 ' + kid.k + ' 的合计（通过 ' + sp + '、失败 ' + sf + '）和逐行数的（' + nOk + ' / ' + nFail + '）对不上');
  if (hdr && seen.join(' ') !== kid.blocks.join(' ')) bad.push('分片 ' + kid.k + ' 跑的块是「' + seen.join(' ') + '」，应是「' + kid.blocks.join(' ') + '」');
  passed += nOk;
  failed += nFail;
  per.push({ kid, hSlot, hLog, qMs, runMs, nOk, nFail });
}
for (const b of BLOCKS) if (!byBlock[b]) bad.push('块 ' + b + ' 没有结果');

const outLines = [];
outLines.push('== test:func · HEAD ' + head + ' · ' + new Date(t0).toISOString() + ' · 分片 ' + n + ' 份并行（' + (slot ? 'cc-slot pool ' + name + ' func --wait ' + waitMin + '，' : '不经 cc-slot，') + '每份 timeout ' + tmo + ' 秒）· 墙钟 ' + mmss(Date.now() - t0) + ' · 耗时数字不可比 [pool, not comparable]');
for (const p of per)
  outLines.push(
    '-- 分片 ' + p.kid.k + '/' + n + '（' + p.kid.blocks.join(' ') + '）：槽位 ' + (p.hSlot || '?') + ' · 排队 ' + (p.qMs === null ? '?' : mmss(Math.max(0, p.qMs))) + ' · 跑了 ' + (p.runMs === null ? '?' : mmss(p.runMs)) + ' · ' + (p.nFail ? '失败 ' + p.nFail + ' 项，' : '') + '通过 ' + p.nOk + ' 项 · rc ' + (p.kid.sig || p.kid.rc) + ' · 日志 ' + path.relative(root, p.kid.log) + (p.hLog ? ' · Chrome 日志 ' + p.hLog : '')
  );
for (const b of BLOCKS) {
  if (!byBlock[b]) continue;
  for (const l of byBlock[b].lines) if (l !== '') outLines.push(l);
}
if (tails.length) outLines.push('', ...tails);
if (bad.length) outLines.push('', ...bad.map((b) => 'SHARD-BAD ' + b));
const total = (failed ? '失败 ' + failed + ' 项，' : '') + '通过 ' + passed + ' 项';
outLines.push('', 'test:func ' + total + '（分片 ' + n + ' 份：' + per.map((p) => (p.nFail ? p.nFail + ' 失败 / ' : '') + p.nOk).join(' + ') + '）');
outLines.push(bad.length && !failed ? '失败 ' + bad.length + ' 处（分片本身，见 SHARD-BAD），通过 ' + passed + ' 项' : total);
const text = outLines.join('\n') + '\n';
writeFileSync(path.join(out, 'func.log'), text);
process.stdout.write(text);
say('合并日志 ' + path.relative(root, path.join(out, 'func.log')));
process.exit(failed || bad.length ? 1 : 0);
