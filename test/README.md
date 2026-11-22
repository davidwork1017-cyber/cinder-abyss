# 测试

端到端冒烟测试：`test/smoke.mjs` 用系统 Chrome（无头、SwiftShader 软件渲染）打开游戏，把整个流程走一遍。
游戏经由本地 HTTP 服务打开（`test/harness.mjs` + `test/serve.mjs`，发法和 GitHub Pages 一样）。

## 三个命令

| 命令 | 跑什么 | 要不要独占机器 |
| --- | --- | --- |
| `npm test` | 全部：先 test:func，再 test:timed（各开一个新浏览器）。最后一行是合计的「通过 N 项」，上面一行是两份各自的数 | 要。上线前跑的就是它 |
| `npm run test:func` | 功能步骤（`main()`）：不看墙钟，机器忙只会变慢、不会误报 | 现在还要：池里跑的 A/B 验证通过之前，和 `npm test` 一样独占 |
| `npm run test:timed` | 计时步骤（`timedMain()`）：结果取决于真实时间，机器一忙就误报 | 一直要，几分钟跑完 |

在开发机上都经过 `cc-slot`：

```bash
cc-slot run <名字> test -- npm test              # 独占
cc-slot run <名字> test -- npm run test:timed    # 独占
cc-slot run <名字> test -- npm run test:func     # 独占（A/B 验证通过后改成 cc-slot pool <名字> func -- …）
```

只跑 test:func，或在池里跑（`cc-slot pool` 会设 `CC_SLOT_HELD=pool:…`，手动跑可以设 `CC_POOL=1`）时，每行 ok 后面会挂上 `[pool, not comparable]`：这时的步骤耗时和步骤里打印的 ms 数字不能和独占跑的比。
每份开头打一行 `== test:<份> · HEAD <提交> · <时间> · 槽位 …`，贴结果时连同最后的「通过 N 项」一起贴。

## 实时循环和按模拟时间推进

「技能：X 绑定到…」那十步按住键以后用 `G.tick(1/60)` 在页面里推进模拟（每次 evaluate 一秒），不等真实时间的帧，机器忙时也不会超时。实时循环（requestAnimationFrame 驱动、`G.debug.hold(false)`）本身仍由别的步骤覆盖，比如「键盘移动」和「武器技：拿着 X 按 R…」；改这些步骤时别把它们也全换成按模拟时间推进。

## 省渲染（test:func）

test:func 默认让游戏看到的 `window.devicePixelRatio` 是 0.5：3D 画面和叠加层（血条、名牌、小地图）按一半分辨率渲染，像素只剩四分之一；CSS 布局、鼠标坐标、视口（1440×900）都不变，画质档还是软件渲染下默认的「低」。SwiftShader 的开销主要在像素上，这样几个 Chrome 一起跑时每帧快得多。
做法在 `test/harness.mjs` 的 `dpr` 选项（导航前装一段页面脚本）和 `test/smoke.mjs` 顶上的 `FULL_RES`：下面这些步骤要看像素、画面数值或指定尺寸下的布局，进步骤前临时改回 1，出来再改回 0.5。

| 按 devicePixelRatio 1 跑的步骤（名字开头） | 为什么 |
| --- | --- |
| 首屏、怪物：远处沉睡、区域 N、首领「…」、存档：刷新页面后 | `T.frame()` 统计画面亮度和颜色数，首屏还取小地图的像素 |
| 画面：、特效贴图库 | 画质档切换（三档 / 高低两档）、`gfxInfo()` |
| 异兆小地图、宝箱、小地图 | 取小地图上的像素颜色 |
| 技能卡版式、标题画面与暂停菜单在小窗口 | 指定窗口尺寸下的布局 |

`CINDER_FULL=1 npm run test:func` 全程按 1 跑（和拆分前一样）。test:timed 一直按 1。新步骤要看像素或画面数值时，把步骤名开头加进 `FULL_RES`，并在上表记一行。

## 随机数

测试里的 `Math.random` 是确定的（`test/harness.mjs` 的 `seed` 选项 + `installTestRandom`，在游戏脚本之前装上）：

- **每一步开始时按步骤名重新播种**（`step()` 里调 `window.__testRand.seed(步骤名)`）。一步拿到的随机序列和前面跑过哪些步骤、那些步骤用掉多少随机数无关：前面的背包步骤换了什么装备、掷到什么布局，都不会让后面某一步的数字一次一个样。这一步里重载页面、新开浏览器也从同一个种子开始（种子记在 sessionStorage）。
- 播种时也把 `Math.random` 装回来：上一步 `T.fix()` 之后失败、没来得及 `T.unfix()`，不会把钉死的随机数带进下一步。
- **两路序列**：测试脚本直接驱动的代码（`page.evaluate` 里的调用、`G.tick` / `G.debug.step`、键盘鼠标事件）用前台一路；`requestAnimationFrame` / `setTimeout` / `setInterval` / `requestIdleCallback` 的回调（实时循环、空闲预热、定时器）用后台一路。后台回调跑几次取决于机器快慢，分开以后它们不会挪动前台那一路。
- 游戏自己带种子的系统照旧：布局（`genLayout`、区域种子）、外观随机序列（`withVisualRandom`）、各处 `ashRng` 都按自己的种子走。正式游戏里不装这一层，随机数和以前一样。
- `CINDER_SEED=<任意字符串>`：换一套种子（每步的种子 = 它 + 步骤名），查某一步是不是只在这一套随机数下碰巧能过。`CINDER_RANDOM=1`：不播种，照旧用浏览器自己的随机数。
- 步骤名改了，这一步的随机序列就换了：改名后整套跑一遍再提交。

## 体检（CINDER_AUDIT=1）

不改结果，每一步结束时多打几行 `audit`：`T.tp` 传送到 0.4 米余量下不能走的地方；`until` / 页面加载 / 导航 / `install` 的等待用掉了防卡死超时的一半以上。最后列出全程最接近超时的 12 次等待。加新步骤、或者池里跑得特别慢时用它看有没有离超时太近的等待。

## 计时步骤

test:timed 里的步骤从 test:func 拆出来：计时断言原样搬过去（条件和上限不改），前面补上它要的最少准备；原来那一步留在 test:func 里，只做功能检查。整步都看墙钟的（拖拽贴边自动滚动）整步搬走。

| test:timed 的步骤 | 拆自 test:func 的 | 看的时间 |
| --- | --- | --- |
| 计时｜图标预热 | 图标预热 | 启动后空闲时画完全部图标，120 秒内（test:func 只等它画完，安全超时 5 分钟） |
| 计时｜武器界面 | 武器界面：HUD 的 R 格…… | 空手按 R 的气泡样式按 performance.now 留 620 ms，两三帧后还得在（test:func 只查气泡文字） |
| 计时｜新手提示：做到之后…… | 新手提示 | 按下翻滚到提示换掉至少 1.9 秒 |
| 计时｜新手提示：濒死时喝药…… | 新手提示 | 喝药提示 5 秒内顶上来 |
| 计时｜大字提示 | 大字提示不互相顶掉 | 3 秒时下面那几行还在，5.2 秒时全部消失 |
| 计时｜渊印·生成 | 渊印·生成 | 掷一次三枚印（连同校验）平均不到 2 ms |
| 计时｜异兆选址 | 异兆选址 | 100 个布局正常进区时选址最慢一次不到 5 ms（游戏在 enterZone 里按 performance.now 量） |
| 计时｜技能页拖拽贴边自动滚动 | 整步搬来（原来在 test:func） | 贴边自动滚动按 performance.now 走：进边带停 250 ms 才滚，最快每秒 900 像素；拖起、松手都要在这段停顿之内做完 |

**加新步骤时：** 断言如果取决于墙钟（`Date.now()` / `performance.now()` 的差、`sleep` 之后某样东西还在或已经没了、单次耗时上限），把这条断言连同准备写进 `timedMain()`，步骤名用「计时｜」开头，并在上表记一行；其余照常写进 `main()`。
只是防卡死的超时（`until` 默认 45 秒、页面重载 90 秒）不算计时断言，留在 test:func。只为等够一个下限的 `sleep`（比如「准星随时找得到」里等过收拢提示的 700 ms 冷却）也留在 test:func：机器越忙等得越久，结果不会变。

## 其它

- test:func 的第一步是 `tools/check-art.mjs`（只用 Node，不起浏览器）：核对 `assets/ca/` 的自产布景件和打进包的是同一份、符合预算和规矩。单独跑：`npm run check:art`。
- `CINDER_FILE=1 npm test`：用 file:// 打开（经典脚本 + base64 素材包也能跑），但上线用的是 HTTP。
- `node test/serve.mjs [端口]`（默认 8080）：自己在浏览器里看。
