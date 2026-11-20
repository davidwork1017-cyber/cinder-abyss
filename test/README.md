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

## 计时步骤

test:timed 里的每一步都从 test:func 的某一步拆出来：计时断言原样搬过去（条件和上限不改），前面补上它要的最少准备；原来那一步留在 test:func 里，只做功能检查。

| test:timed 的步骤 | 拆自 test:func 的 | 看的时间 |
| --- | --- | --- |
| 计时｜图标预热 | 图标预热 | 启动后空闲时画完全部图标，120 秒内（test:func 只等它画完，安全超时 5 分钟） |
| 计时｜武器界面 | 武器界面：HUD 的 R 格…… | 空手按 R 的气泡样式按 performance.now 留 620 ms，两三帧后还得在（test:func 只查气泡文字） |
| 计时｜新手提示：做到之后…… | 新手提示 | 按下翻滚到提示换掉至少 1.9 秒 |
| 计时｜新手提示：濒死时喝药…… | 新手提示 | 喝药提示 5 秒内顶上来 |
| 计时｜大字提示 | 大字提示不互相顶掉 | 3 秒时下面那几行还在，5.2 秒时全部消失 |
| 计时｜渊印·生成 | 渊印·生成 | 掷一次三枚印（连同校验）平均不到 2 ms |

**加新步骤时：** 断言如果取决于墙钟（`Date.now()` / `performance.now()` 的差、`sleep` 之后某样东西还在或已经没了、单次耗时上限），把这条断言连同准备写进 `timedMain()`，步骤名用「计时｜」开头，并在上表记一行；其余照常写进 `main()`。
只是防卡死的超时（`until` 默认 45 秒、页面重载 90 秒）不算计时断言，留在 test:func。

## 其它

- `CINDER_FILE=1 npm test`：用 file:// 打开（经典脚本 + base64 素材包也能跑），但上线用的是 HTTP。
- `node test/serve.mjs [端口]`（默认 8080）：自己在浏览器里看。
