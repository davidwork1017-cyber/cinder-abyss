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

## 技能等级（gem-nolvl）

技能宝石没有等级：游戏里已学技能的等级一律是成长下限 round(角色等级 × 0.75)（`G.skillLvl`），存档 `skills` 里的数只当「学会了」，只升不降。
老步骤按「宝石 N 级」量数值时直接改 `save.skills`，所以 `step()` 开头和 `install()` 都调 `G.debug.pinGems(true)`：技能等级读存档里记的数，和改版前一样。
要看真实规则（等级 = 成长下限、刻式按角色 13 级解锁、重复宝石转换……）的步骤自己先调 `G.debug.pinGems(false)`，见「技能宝石没有等级」「刻式：…角色 12 级不能选」「职业·挑宝石」这几步。平衡工具（rv-abs 等）不装测试工具，跑的就是真实规则。

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

## 触屏（mobile M1）

test:func 最后一组「触屏：」步骤用手机模拟开新浏览器（`launch({ mobile: { scale: 3 } })`：844×390、DPR 3、isMobile + hasTouch，主指针变成 coarse，触屏模式自动打开），用 CDP 的 `Input.dispatchTouchEvent` 发真实触摸事件：摇杆、按住主攻、轻点 Q、从 E 拖动瞄准、翻滚 / 药瓶 / F、点空地和点顶栏都不放技能、竖屏遮罩、首次提示卡、设置项、pagehide 存档和停写、画面丢失；再在五种尺寸下查布局（安全区用 `--t-safe-*` 变量假装），最后在桌面窗口里查「桌面不开触屏」和矮窗口里的「开始」。

- 单独跑这一组：`node test/smoke.mjs --touch`（池里：`cc-slot pool <名字> smoke -- node test/smoke.mjs --touch`）。
- touchmove 按帧合并（一帧里发几次只送到最后一次）：测试里每次移动后等一帧（`touch.move` / `touch.drag` 已经这样做）。
- 触屏步骤按模拟时间推进（`G.debug.hold(true)` + `G.debug.step`），触摸只改输入字段，结果和机器快慢无关。

## WebKit 冒烟（test:webkit）

`npm run test:webkit`（`test/webkit-smoke.mjs`）：Playwright 的 WebKit 按 iPhone 横屏模拟（iPhone 上的 Chrome 底下也是 WebKit）走一遍：载入、WebGL2、标题画面、新游戏选职业、进区、开场卡片 / 首次提示卡、摇杆移动、第一次松手解锁声音、按住主攻出手、翻滚，最后报画质和纹理内存。0 页面报错、0 个 HTTP ≥ 400。

- 要先装 WebKit 浏览器和它的系统库，所以不在 `npm test` 里。开发机上已经装好（见 game-workspace/notes/mobile-design.md「已安装」），在池里跑：`cc-slot pool <名字> smoke -- npm run test:webkit`。
- 这个 WebKit 构建里 `new Touch()` 不能用、`navigator.maxTouchPoints` 是 0：脚本发合成触摸事件，触屏判定靠 `ontouchstart` 兜底。
- 能查出 JS / CSS / WebGL2 的兼容问题；iOS 特有的 GPU、音频策略、工具栏伸缩查不出来，要在真机上看。

## 界面布局那一组（--ui）

`node test/smoke.mjs --ui` 单独跑界面布局那一组（触屏组末尾的那一段：各面板的触屏 / 桌面布局、桌面样式、天赋页）。顺序是先把所有面板的触屏布局跑完、关掉触屏浏览器，再跑桌面（桌面那几步和桌面样式的先后不变），同一时刻只开一个浏览器：SwiftShader 下一个浏览器的 GPU 进程不管页面在不在动都要吃 3 个核左右（冻结页面也不降），以前两个浏览器从头开到尾。
种子：`step()` 在每一步开始时给「当前的 page」播种，以前那个 page 是上一步的、也就是另一个浏览器；换顺序以后，每一步换到自己的浏览器后按以前实际落到它身上的名字再播一次（触屏步骤用上一个面板桌面那一步的名字，桌面步骤用同一面板触屏那一步的名字），每个浏览器拿到的随机序列和以前一样。

## Chrome 中途退出（浏览器体检）

每次运行把浏览器的情况记到 `test-logs/<UTC 时间>-<pid>/`（已在 .gitignore；只留最近 3 天；`CINDER_CHROME_LOG=<目录>` 可改位置）。test:func / test:timed 开头那行 `== test:…` 末尾写着这一次的目录。

- `run.log`：每开 / 关一个浏览器一行（第几个、Chrome 主进程 pid、在哪一步开的），意外退出、页面渲染进程崩溃、收到的信号也各记一行，都带 UTC 时间。
- `chrome-NNN.log`：第 N 个浏览器在哪一步开的、`<chrome pid=…>`、Chrome 自己的 stderr（`--enable-logging=stderr --v=0`，GPU 进程、SwiftShader 的报错都在这里）、最后的 `<chrome exit rc=…>`（128 + n = 被信号 n 杀掉）。Chrome 经 `test/chrome-log.sh` 起（Linux 上找 `/opt/google/chrome/chrome`，`CINDER_CHROME_BIN` 可改；找不到就照旧 `channel: 'chrome'`，没有 stderr 日志）。
- `crash/`：Chrome 的崩溃转储目录（`--crash-dumps-dir`；无头 Chrome 默认不写转储，多半是空的）。

两种情况会在控制台上直接看到：

- **`CHROME-DIED`**：浏览器不是测试自己关的却断开了。打出第几个浏览器、开在哪一步、死在哪一步、时间、退出码 / 信号、stderr 最后 12 行和日志文件名；之后因为它报「Target page, context or browser has been closed」的 FAIL 行末尾会补一句「浏览器 #N … 已意外退出」。最后合计上面再列一遍。怎么读退出原因：「被信号 9 杀掉」而 stderr 最后几行没有报错 = 被外面杀的（OOM、别人的清理脚本），去查系统日志 / atop（`atop -r /var/log/atop/atop_<日期> -b HH:MM -P PRG` 里状态 E 的进程带退出码）；「被信号 5 / 6 / 11 杀掉」或 stderr 里有 `FATAL` / `Check failed` = Chrome 自己崩的；「没有退出码（整个进程组被杀）」= 连启动壳一起被杀，也是外面的事。
- **`KILLED 收到 SIGTERM …`**：测试进程自己被叫停（外层 `timeout` 到点、cc-slot 被杀、tmux 关掉 = SIGHUP）。打一行后立即退出（143 / 129 / 130），Playwright 把它开的 Chrome 一起杀掉。这一次的结果作废，不是 Chrome 的问题。

以前 Playwright 自己接 SIGTERM：只关掉浏览器，Node 进程照跑。后面自己开浏览器的步骤照样通过，共用浏览器的步骤（界面布局、主线那一串）全报「browser has been closed」，最后照样打合计，看起来像 Chrome 中途崩了；而且槽位已经放掉了，这个进程还在池外继续开 Chrome。2026-11-24 的三次「Chrome 中途死掉」都是这个：外层 `timeout 1500 / 3000 / 3600 cc-slot pool … --wait 360 -- npm run test:func` 把排队时间也算进去，池里一次 test:func 要 45–56 分钟，到点就是 SIGTERM。

**开浏览器失败之后**：某一步开浏览器时导航失败（机器太忙 load 超时、连不上），harness 先把那个浏览器关掉（run.log 记一行 `goto 失败`），这一步照常 FAIL、不重跑；全局的 page 已经用不了的话，`step()` 收尾时按这一步原来的方式重开一次（触屏步骤连同 touchPage 的准备一起），后面的步骤在活着的页面上跑，run.log 记一行 `重开浏览器`，控制台打一行 `note`。这一次照样是红的，只是能看到后面真正失败了几项，不会因为 page 是 null 一路连着挂。
故障注入：`CINDER_FAULT_GOTO=<步骤名开头>` 让那一步第一次开浏览器时导航到一个连不上的地址（只注入一次），用来验证这条路。

**外层超时的写法**：限时放在 cc-slot 里面，只算跑的时间，并且至少给正常耗时的两倍：

```bash
cc-slot pool <名字> func --wait 360 -- timeout 7200 npm run test:func   # 对：排队不算，跑 2 小时才叫停
timeout 3600 cc-slot pool <名字> func --wait 360 -- npm run test:func   # 错：排队 20 分钟就只剩 40 分钟
```

## 其它

- test:func 的第一步是 `tools/check-art.mjs`（只用 Node，不起浏览器）：核对 `assets/ca/` 的自产布景件和打进包的是同一份、符合预算和规矩。单独跑：`npm run check:art`。
- 第二步是 `tools/check-three.mjs`（也只用 Node）：`vendor/three.bundle.js` 里有游戏用到的每个 `THREE.X`、打包入口的设置和 uuid 的本地改动都在（`docs/vendor-patches.md`）、`js/` 里没有 r128 的写法。单独跑：`npm run check:three`。
- 多存档步骤（`slotSteps`）要验证「退回旧代码」：`test/serve.mjs` 的 `/__old/<提交>/<路径>` 从 git 里按需取那个提交的文件（`git cat-file`），和当前代码同源、共用 localStorage。旧版本固定为多存档之前最后一版（`OLD_SAVE_BUILD`），需要本地 git 历史里有这个提交；`CINDER_FILE=1` 下没有同源的旧版本，这两步只打一行说明。
- `CINDER_FILE=1 npm test`：用 file:// 打开（经典脚本 + base64 素材包也能跑），但上线用的是 HTTP。
- `node test/serve.mjs [端口]`（默认 8080）：自己在浏览器里看。
