// 比两份 test:func 日志（整套跑 vs 分片合并的，或两次分片）：步骤集合、每步通过 / 失败、每步结果里打印的数字（test/README.md「分片」）。
//   node test/func-compare.mjs <A.log> <B.log>
// 打印：两边的步骤数、只在一边的步骤（同名的步骤按第几次出现区分）、判定不同的步骤、结果文字不同的步骤（ms 耗时先换成 N 再比），
// 以及带指纹 / 哈希 / 随机数 / draw 的步骤两边的值、fp 行。步骤集合、判定或 fp 的 save / seed 不同时退出码 1；只有结果文字不同时退出码 0，逐条列出来人工看。
import { readFileSync } from 'node:fs';

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error('用法：node test/func-compare.mjs <A.log> <B.log>');
  process.exit(2);
}
const STEP = /^(ok {3}|FAIL )(.*)$/;
function parse(file) {
  const rows = new Map(), dup = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const m = STEP.exec(l);
    if (!m) continue;
    let body = m[2].replace(/ {2}\(\d+ms\)( \[pool, not comparable\])?$/, '');
    const i = body.indexOf(' — ');
    const name = i < 0 ? body : body.slice(0, i);
    const info = i < 0 ? '' : body.slice(i + 3);
    // 有几步同名（「传送门：…」整套里出现 4 次）：按第几次出现区分，key = 名字 #n
    let key = name, n = 1;
    while (rows.has(key)) key = name + ' #' + ++n;
    if (n > 1) dup.push(key);
    rows.set(key, { ok: m[1].startsWith('ok'), info });
  }
  return { rows, dup };
}
const A = parse(fa), B = parse(fb);
const norm = (s) => s.replace(/\d+(\.\d+)?\s*ms/g, 'Nms');
const short = (s, n = 90) => (s.length > n ? s.slice(0, n) + '…' : s);
const onlyA = [...A.rows.keys()].filter((k) => !B.rows.has(k));
const onlyB = [...B.rows.keys()].filter((k) => !A.rows.has(k));
const both = [...A.rows.keys()].filter((k) => B.rows.has(k));
const verdict = both.filter((k) => A.rows.get(k).ok !== B.rows.get(k).ok);
const text = both.filter((k) => !verdict.includes(k) && norm(A.rows.get(k).info) !== norm(B.rows.get(k).info));
const okN = (r) => [...r.rows.values()].filter((x) => x.ok).length;
console.log('A ' + fa + '：' + A.rows.size + ' 步（通过 ' + okN(A) + '）' + (A.dup.length ? '，其中同名的第 2 次以后 ' + A.dup.length + ' 步' : ''));
console.log('B ' + fb + '：' + B.rows.size + ' 步（通过 ' + okN(B) + '）' + (B.dup.length ? '，其中同名的第 2 次以后 ' + B.dup.length + ' 步' : ''));
for (const k of onlyA) console.log('  只在 A：' + short(k));
for (const k of onlyB) console.log('  只在 B：' + short(k));
for (const k of verdict) console.log('  判定不同：' + short(k) + '  A ' + (A.rows.get(k).ok ? 'ok' : 'FAIL') + ' / B ' + (B.rows.get(k).ok ? 'ok' : 'FAIL') + '\n      A：' + short(A.rows.get(k).info, 300) + '\n      B：' + short(B.rows.get(k).info, 300));
console.log('步骤集合 ' + (onlyA.length || onlyB.length ? '不同' : '相同') + '，判定不同 ' + verdict.length + ' 步，结果文字不同 ' + text.length + ' 步（ms 换成 N 之后）');
for (const k of text) console.log('  文字不同：' + short(k, 60) + '\n      A：' + A.rows.get(k).info + '\n      B：' + B.rows.get(k).info);
// 确定性的数：带指纹 / 哈希 / 随机数 / draw 的步骤，两边的 8 位十六进制值和整句
const DET = /指纹|哈希|随机数|draw|fingerprint/;
const det = both.filter((k) => DET.test(k) || DET.test(A.rows.get(k).info));
console.log('\n确定性的数（' + det.length + ' 步）：');
const hex = (s) => (s.match(/\b[0-9a-f]{8}\b/g) || []).join(' ');
for (const k of det) {
  const a = A.rows.get(k).info, b = B.rows.get(k).info;
  console.log((norm(a) === norm(b) ? '  =  ' : '  ≠  ') + short(k, 50) + (hex(a) || hex(b) ? '  [' + hex(a) + (hex(a) === hex(b) ? '' : ' | ' + hex(b)) + ']' : ''));
  if (norm(a) !== norm(b)) console.log('      A：' + a + '\n      B：' + b);
}
// CINDER_FP=1 跑的：界面布局每个面板开头的状态指纹（fp 行）。save（内存里的存档）和 seed 要一样；ls 按真实时间自动存档，只作参考
const fps = (f) => new Map(readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('fp ')).map((l) => {
  const w = l.split(' ');
  const get = (k) => w[w.indexOf(k) + 1];
  return [w[1], { core: 'save ' + get('save') + ' seed ' + get('seed'), ls: get('ls') }];
}));
const fa2 = fps(fa), fb2 = fps(fb);
let fpBad = 0;
if (fa2.size || fb2.size) {
  console.log('\n界面布局开头的状态指纹（CINDER_FP；save 和 seed 要一样，ls 只作参考）：');
  for (const k of new Set([...fa2.keys(), ...fb2.keys()])) {
    const a = fa2.get(k), b = fb2.get(k), same = !!a && !!b && a.core === b.core;
    if (!same) fpBad++;
    console.log((same ? '  =  ' : '  ≠  ') + k + '  ' + (a ? a.core : '-') + (same ? '' : '  |  ' + (b ? b.core : '-')) + (a && b && a.ls !== b.ls ? '  (ls 不同)' : ''));
  }
  console.log('fp：' + (fa2.size === fb2.size && !fpBad ? '全部相同' : fpBad + ' 处不同'));
}
process.exit(onlyA.length || onlyB.length || verdict.length || fpBad ? 1 : 0);
