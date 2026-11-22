# tools/score：音乐和环境音的渲染与检查

引擎在 `js/score.js`（`CinderScore`，带种子的 WebAudio 生成，不用采样文件），游戏这边的接线在同一个文件末尾（`G.music`）。这里的工具都在 headless Chrome 里用 OfflineAudioContext 渲染，载入的是游戏里的同一份 `js/audio.js` 和 `js/score.js`。

| 文件 | 作用 |
|---|---|
| `lab.html` | 渲染台。`renderA` 只渲染引擎输出（总线增益 1）；`renderGame` 走游戏的整条混音链路（总线、master、压缩、限幅、软削波，默认滑条），可以叠上真实战斗的音效；`liveTest` 用实时 AudioContext 测主线程耗时；`planA` 只排音符、不出声 |
| `render.mjs` | 跑任务表，每个任务写一个浮点 WAV 和一个 meta JSON。`liveTest` 另外记录整个 Chrome 进程树的 CPU |
| `analyze.mjs` | 客观检查：ebur128 的 LUFS、LRA、真峰值，频谱重心，2–5 kHz 打击频段电平，和弦粗糙度（Sethares），每小节音符数 |
| `listen.mjs` + `listen-jobs.json` | 试听包：Vorbis 编码，写 manifest.json 和 checks.md，包括游戏内电平门槛、提亮前后对比、lite 和完整版对比 |
| `fight-sfx.json` | sfx-synth 录下的真实群战音效时间线（10 秒），用来判断音乐有没有压住打击声 |

## 怎么跑

```bash
# 会起 Chrome，走测试槽位的池
cc-slot pool <名字> lab -- node tools/score/render.mjs tools/score/listen-jobs.json <wav 目录>
# 编码和检查（ffmpeg 要带 ebur128 和 libvorbis，用 FFMPEG / FFMPEG_VORBIS 指定路径）
cc-slot batch <名字> build -- node tools/score/listen.mjs <wav 目录> <试听目录> [旧试听包的 manifest.json]
```

## 电平怎么定

- 引擎输出：探索音乐 −23 LUFS、环境音 −29 LUFS。各区的修正值是 `js/score.js` 里的 `TRIM`，用 `renderA` 渲染 60 秒探索音乐、40 秒环境音，按实测值调整。
- 游戏内：`G.music.OUT` 是引擎输出接到总线前的增益。默认滑条下用 `renderGame` 分别渲染音效（`fight-sfx.json` 的 montage）、音乐、环境音，要求：
  - 探索、战斗、首领战音乐都比密集战斗音效低至少 11 LU；
  - 环境音低至少 17 LU；
  - 2–5 kHz 频段里，音效比音乐加环境音高 15 dB 以上（audio-score 原型的水平）。
- 分开渲染比较保守：混在一起时，音效触发的压缩也会压低音乐，实际的差距只会更大。master 链路上的压缩和限幅对小信号有大约 +10 dB 的补偿增益，所以不能只按滑条的增益来算，要实际渲染出来量。

## 成本（2026-11-22，这台服务器上满载的一个核）

- 音频线程（Chrome 的 AudioOutputDevice 等线程，游戏里实测，探索 / 战斗）：高画质完整版开音乐 14.9 / 15.8%，关掉 1.3%；中画质 lite 8.5 / 9.2%，关掉 2.0 / 2.5%；低画质 lite 9.7 / 10.3%，关掉 2.8 / 3.3%。中画质用完整版是 16.0 / 17.0%，lite 省下大约 57%，所以中、低都用 lite。
- 只跑引擎（`liveTest`，整个 Chrome 进程树）：完整版 11.6–17.3%，lite 加共用混响 4.8–6.6%。各区自己的卷积混响是大头，lite 改送共用的那台混响（音效本来就开着），省下的主要是这一块。
- 主线程：每 200 ms 走一次。`liveTest` 里排程中位数 0.1–0.2 ms，建区时的缓冲区准备切成 ≤ 4 ms 的小片，单片最长约 11 ms，没有长任务；游戏里（含 G.music 的状态判断）平均每次 0.36 ms，最长一次 19 ms。
