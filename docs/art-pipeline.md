# 自产素材流水线

烬渊的 3D 素材逐步换成我们自己用脚本生成的件：不用 AI 生成 3D，也不在 Blender 里手工建模，形状、配色、细节全部写在 `art/` 下的 Python 脚本里，由无头 Blender（CPU）执行。风格和预算见 [art-style.md](art-style.md)。

游戏和 `npm test` 都不需要 Blender：生成物（`assets/ca/` 下的 GLB 和清单、`js/assets/kit-*.js` 素材包）一起提交，GitHub Pages 直接发这些文件，不需要 CI 构建。

## 安装 Blender（只有改素材的人需要）

固定版本 **Blender 5.2.4 LTS**，官方 Linux 构建，装在用户目录，不需要 root，不装系统包。

| 项 | 值 |
| --- | --- |
| 下载 | https://download.blender.org/release/Blender5.2/blender-5.2.4-linux-x64.tar.xz |
| 校验文件 | https://download.blender.org/release/Blender5.2/blender-5.2.4.sha256 |
| sha256 | `2fd14c50987426897ba60237ee996edf2b4151f4b1a72a460ca20be58c1d2d86` |
| 安装位置 | `~/opt/blender-5.2.4/` |

```bash
mkdir -p ~/dl-blender && cd ~/dl-blender
curl -O https://download.blender.org/release/Blender5.2/blender-5.2.4-linux-x64.tar.xz
curl -O https://download.blender.org/release/Blender5.2/blender-5.2.4.sha256
grep linux-x64 blender-5.2.4.sha256 | sha256sum -c -      # 应输出 OK
mkdir -p ~/opt && tar -xJf blender-5.2.4-linux-x64.tar.xz -C ~/opt
mv ~/opt/blender-5.2.4-linux-x64 ~/opt/blender-5.2.4
~/opt/blender-5.2.4/blender -b --factory-startup --version  # Blender 5.2.4 LTS
```

装在别处时用环境变量 `BLENDER=/路径/blender` 指定。换了 Blender 版本，构建脚本会警告：生成物可能和仓库里的不再逐字节一致。

## 目录

| 路径 | 内容 |
| --- | --- |
| `art/catalog.py` | 件清单：每件 = 生成器 + 参数 + 种子，以及类别、区域、是否打进游戏（ship）、顶替哪个旧模型 |
| `art/ca/gen.py` | 生成器（枯树、岩石 / 崖块、墙段 / 碎墙堆、断柱 / 拱、火坑 / 火盆、兽骨 / 骨头 / 断剑、墓碑） |
| `art/ca/core.py` | 公共部分：搭形工具（盒子、凸包、管子）、收尾（UV、烘焙顶点色）、导出 GLB |
| `art/ca/palette.py` | 共享调色板图集（8 行色带，64×16 PNG，自己编码，字节固定） |
| `art/build.py` | Blender 入口：生成全部件 / 渲染看板 |
| `art/budgets.json` | 各类别的三角形 / 材质 / 贴图预算和高度范围（check-art 用） |
| `art/rig.json` | 角色标准骨架的骨骼名表（占位，角色那一步再填） |
| `assets/ca/<区>/*.glb` | 生成物，每件一个 GLB |
| `assets/ca/manifest.json` | 清单：id、类别、区域、三角形数、包围盒、来源脚本 + 种子、sha256 |
| `assets/ca/palette.png` | 调色板图集（和 GLB 里内嵌的同一份字节） |
| `js/assets/kit-<区>.js` | 打进游戏的件（`ship: True`），base64，`zone-<区>` 包加载时连带加载 |
| `tools/build-art.mjs` | `npm run build:art` |
| `tools/check-art.mjs` | `npm run check:art`，也是 `npm test` 的第一步 |
| `tools/glb.mjs` | Node 里读 GLB 的小工具 |

## 用法

```bash
npm run build:art                       # 全部重新生成 → 写清单 → 重新打包 js/assets/*.js
node tools/build-art.mjs --only ca/ash_skull,ca/ash_bones   # 只生成几件（清单里其余的保留）
node tools/build-art.mjs --no-pack      # 只生成 GLB 和清单，不打包
node tools/build-art.mjs --jobs 17      # 同时起 17 个 Blender 进程（每个分几件），生成物和串行逐字节相同
npm run check:art                       # 检查（不需要 Blender）
```

看板（每个生成器 × 几个种子，Cycles CPU 低采样渲染）：

```bash
~/opt/blender-5.2.4/blender -b --factory-startup --python-exit-code 1 --python art/build.py -- \
  --lineup /tmp/lineup.png --res 1600x1800 --samples 24 [--gens tree,rock]
```

每个 Blender 进程的烘焙线程数由 `CA_THREADS` 定（缺省：串行 8，并行 1）。构建脚本本身不管机器调度。共享机器上用机器自己的调度包一层：烬渊的 devbox 上是 `cc-slot batch <名字> build -- npm run build:art -- --jobs 17`，它以最低优先级跑、计时测试占着槽位时自动暂停。

## 一件是怎么生成的

1. **搭形**（`gen.py`）：生成器用盒子、凸包、沿折线的管子拼出大形，每个面标上调色板的行（灰烬岩、焦黑树皮、骨、锈铁、余烬……）和色带上的明暗；随机数全部来自 `random.Random(种子)`。
2. **收尾**（`core.py`）：没标的面继承邻面，法线朝外；朝上的面按概率盖上积灰色；每个面的所有角取同一个 UV，落在调色板图集上（一面一色）。
3. **烘焙**：glTF 带不了程序化节点，细节在构建时烘焙进顶点色 `COLOR_0`：
   - AO：Cycles CPU、32 采样，烘焙到顶点色，带一块临时地面，所以底部有接触阴影；AO 距离按件的尺寸给（清单里的 `bake.ao`）；
   - 高度渐变：离地 `bake.grad` 米以内逐渐压暗（底部 0.72）；
   - 边缘磨损：按顶点相邻边的带符号二面角，凸边提亮、凹处压暗；
   - 余烬面不压暗（保持亮）。
   烘焙耗时每件几毫秒到几十毫秒（构建时逐件打印，清单之外的数字见构建输出）。
4. **导出**：GLB，Y 朝上，应用全部变换，一个网格、一个材质 `ca_palette`（底色贴图 = 调色板图集，最近邻采样），属性 POSITION / NORMAL / TEXCOORD_0 / COLOR_0。

游戏端（`js/assets.js` 的 `bakeGltf`）和 KayKit 件走同一条路：按 UV 从图集取色，再乘上 `COLOR_0`，合成一个只带顶点色的几何体，所有布景共用一个按区域着色的材质、实例化绘制。

## 可复现

同一台机器、同一个 Blender 版本，重复构建得到**逐字节相同**的 GLB（清单里的 sha256 不变，`git status` 干净）。验证方法：

```bash
npm run build:art && git status --short assets/ca js/assets   # 没有输出 = 逐字节一致
```

做到这一点靠这几处：生成器只用带种子的随机数，不按集合的迭代顺序取东西；调色板 PNG 自己编码；Cycles 固定种子和线程数；顶点色量化到 1/255；导出关掉 extras 等会带环境信息的选项。另外有两处是踩过坑才定下来的：

- 不用 bmesh 的 `bevel` 操作。它内部按指针地址排序，同一份输入在一次构建的不同时刻会给出不同的顶点顺序。倒角盒改成 24 个点的凸包直接搭（`Kit.box` 的 `bevel` 参数）。
- 三角化自己做（`bmesh.ops.triangulate`，固定方法）。交给导出器时 Blender 对多边形的三角化顺序偶尔会变，几何一样，索引却不一样。

2026-11-20 实测：连续 6 次全量构建（烘焙线程 4 和 8 交替），17 个 GLB 逐字节一致。换 Blender 版本以后可能只在几何上一致、字节不同（导出器的写法会变），这时以 check-art 通过、目测看板为准，并在提交说明里写明。

## 加一件 / 加一个区

1. 在 `art/catalog.py` 加一项（新生成器写进 `gen.py`）；
2. `npm run build:art`，看构建输出的三角形数和 `npm run check:art`；
3. 渲染看板看一眼；
4. 要进游戏：`ship=True`，在 `tools/asset-sources.json` 加 `kit-<区>` 包、并在 `zone-<区>` 包上写 `"with": ["kit-<区>"]`；摆放表（`js/world.js` 的 `ZONE_GFX.<区>.props`）里换成新 id。
