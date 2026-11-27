# 自产素材流水线

烬渊的 3D 素材逐步换成我们自己用脚本生成的件：不在 Blender 里手工建模，形状、配色、细节全部写在 `art/` 下的 Python 脚本里，由无头 Blender（CPU）执行。风格和预算见 [art-style.md](art-style.md)。2026-11-26 起，静态布景和四种武器另外试点用 AI 生成的模型做源，见文末「AI 生成的布景件」「AI 生成的武器」。

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
| `art/ca/gen.py` | 生成器：灰烬地带（枯树、岩石 / 崖块、墙段 / 碎墙堆、断柱 / 拱、火坑 / 火盆、兽骨 / 骨头 / 断剑、墓碑）；坠星裂谷（裂谷石碑、板岩晶簇、星骸碑、裂开的巨石、板岩块、塌落的板岩堆、碎地砖） |
| `art/ca/core.py` | 公共部分：搭形工具（盒子、凸包、管子）、收尾（UV、烘焙顶点色）、导出 GLB |
| `art/ca/palette.py` | 共享调色板图集（64×64 PNG，最多 32 行色带，自己编码，字节固定） |
| `art/build.py` | Blender 入口：生成全部件 / 渲染看板 |
| `art/budgets.json` | 各类别的三角形 / 材质 / 贴图预算和高度范围（check-art 用） |
| `art/rig.json` | 角色标准骨架的骨骼名表（占位，角色那一步再填） |
| `assets/ca/<区>/*.glb` | 生成物，每件一个 GLB |
| `assets/ca/manifest.json` | 清单：id、类别、区域、三角形数、包围盒、来源脚本 + 种子、sha256 |
| `assets/ca/palette.png` | 调色板图集（和 GLB 里内嵌的同一份字节） |
| `js/assets/kit-<区>.js` | 打进游戏的件（`ship: True`），打包时已经烘焙成几何体数组（小端 Float32 的 base64，带烘焙所用 GLB 的 sha256），`zone-<区>` 包加载时连带加载 |
| `js/assets/kit-gear.js` | 手持武器件（`zone='gear'`，类别 weapon，现在只有提灯两件）：不跟任何区域加载，第一次装备 / 掉落提灯时才要（`world.js` 的 `W.lanternNeed`），到之前手里是程序化的简化提灯 |
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

烘焙算法和 KayKit 件在游戏端走的 `js/assets.js` 的 `bakeGltf` 一样：按 UV 从图集取色，再乘上 `COLOR_0`，合成一个只带顶点色的几何体，所有布景共用一个按区域着色的材质、实例化绘制。区别是自产件在打包时就烘焙好（`tools/glb.mjs` 的 `bakeGeo`，结果和 `bakeGltf` 逐位相同，`npm run check:art` 会重新烘焙核对），游戏端只把数组拷进几何体，进区前不用再解析 GLB、解码图集。

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

顶替旧模型时，清单里写 `fit=dict(r=…, top=…, bottom=…)`：生成完先把包围盒拉到旧件 scale 1 时的尺寸（游戏端 `G.assets.geoInfo(旧 key)` 的 r、y0 + h、y0），数值照抄浮点原值，不要四舍五入。摆放代码用 r 判断能不能放、用 y0 把标记 l 的件抬到贴地，差一点浮点也会让个别实例的高度差在第四位小数，摆放哈希就对不上（坠星裂谷的碎地砖踩过一次）。收尾参数写在 `finish=dict(…)` 里，比如别的区不盖积灰、改盖本区的覆盖色：`finish=dict(dust=0.2, dust_row='lichen')`。

现在所有区的布景都是自产件，游戏从 2026-11-22（models-drop）起不再打包、也不再加载 CC0 模型包 `models.js`。`propsReady()` 看摆放表里的每个 key（外圈、中圈、路边、首领、火盆）是否都解析出了几何体，摆放表为空也算就绪。KayKit / Kenney 的源文件和许可证还留在 `assets/` 下；要量旧件的 `geoInfo` 或重新打包，在 `tools/asset-sources.json` 的 `packs` 里加回 `"models": { "models": "*" }`，再跑 `node tools/pack-assets.mjs`。

## 首领（boss-golem 起）

首领也是脚本生成的件，多了骨架、蒙皮和动作。第一只是熔渣巨像（`ca/boss_golem`），第二只是烬渊之主（`ca/boss_lord`，31 根骨骼：20 根标准 + 剑、两翼各两节、披风三节、前襟、冠、炉芯），其余四只按 `notes` 里的设计稿逐个换。

衔星巨兽（`ca/boss_behemoth`，四足）：骨架是四足模板（29 根：骨盆、三节脊椎、`neck_01` + `x_neck_02 / 03`、头、`x_jaw`、嘴里的星 `x_star`、三块背甲 `x_plate_01..03`、四节尾、四条腿各三节 `x_fleg_* / x_hleg_*`）。身子、颈、尾是跨好几根骨骼的一根管子，按圈绑骨骼、软接缝渐变（`body` / `loft(rings=…)`）。没有新增调色板行（皮和背甲都是玄武岩行，裂谷暖白的主光下靠 `BOSS_SPEC` 的 `tint` 往冷里收一点，进游戏是中性的石墨灰）。

霜织者（`ca/boss_weaver`，六足 + 人形上身）：骨架 37 根：根骨骼 `pelvis` 是蛛头胸，蛛腹 `x_abd_01 / 02`，人形上身 `spine_01..03`、`neck_01`、`head`、两臂（`upperarm / lowerarm / hand`，没有锁骨，挂在 `spine_03` 上），胸口的霜结 `x_core`、冰冠 `x_crown`、霜纱 `x_veil_01..03`，六条腿各三节 `x_fleg / x_mleg / x_hleg_{l,r}_01..03`（`x_leg_f_l_01` 这种写法不合 rig.json 的 `x_` 规则，所以前 / 中 / 后写进部位名里）。腿朝外的方向各不一样，动作表（`weaver_clips.py`）里腿的姿态按「抬 / 屈 / 摆」写，换算成欧拉角（`leg()`）。贴地按六个踝（`_03` 的枢轴，离地 0.42 m）。没有新增调色板行：甲壳是玄武岩行，霜丝袍子和霜纱是板岩行（首领身上按布），冰是星辉行；冰原的光下靠 `BOSS_SPEC.weaver` 的 `tint` / `emis` 收到中性（缺省的暖色自发光会把甲壳烧成橙褐）。肩上的短披也走 `custom` 权重（T35）：盖在肩头的那一段最多 0.6 跟着上臂，双手举过头顶时布在肩头收拢，不再被手臂穿过；股节背上的霜光缝是窄的暗冰色线（不发光）。

熄烛者（`ca/boss_snuffer`，袍中人形、没有腿）：35 根骨骼 = 14 根标准（脊椎、头、两臂）+ 兜帽 `x_hood`、冠 `x_crown`、两盏灯 `x_lamp_l / r` 和灯盖 `x_lid_l / r`、下摆四根 `x_hem_f / b / l / r`、披风两节、前襟 `x_tab`，再加冠上八根重燃的烛芯 `x_wick_01..08`（三阶段时游戏端按 `ent.mood` 一根一根放大火苗，平时缩到看不见：不换几何）。袍子是一根从披肩一直到地面的放样管，权重用生成器自己的 `custom` 函数算（`rig.skin` 的可选参数）：上半段按高度在脊椎链上分，往下渐渐交给下摆，下摆按绕竖轴的角度在相邻两根之间渐变。不贴地（`BOSS_SPEC` 不写 `feet`），浮动、下沉都写在骨盆上。新增三行调色板（19 灰烬袍、20 蜡、21 熏黑的玻璃）。灰烬袍朝上的面（法线 y > 0.5）在生成器最后换成同样亮度的玄武岩行（`_top_neutral`，T35）：游戏镜头从上面看，余烛殿半球光的冷紫天空色照在冷石板灰上会发蓝紫，换成中性略暖的灰以后俯视是中灰的披肩、暗的下摆。
雷霆监察者（`ca/boss_warden`，悬浮的机械）：骨架 25 根：根骨骼 `pelvis` 是整台机器（悬浮的起伏），底环 `x_base`、柱身 `x_column`（枢轴在柱底，死亡时整根倒下去）、柱顶的领环和眼匣 `head`、眼 `x_eye`（芯）、上下眼睑 `x_lid_t / b`（挂在眼匣中心，绕横轴转就合上）、两根避雷杆 `x_rod_l / r`、两道环 `x_ring_a / b`、三块护盾板 `x_plate_01..03`（挂在 `x_orbit` 上一起绕着转）、两只离体的手 `hand_l / r`，每只手三节指 `x_finger_{l,r}_01..03`（三根指头的同一节共用一根骨骼：指节在一条横线上，绕它转三根一起弯）和拇指 `x_thumb_l / r`。全是刚性件，没有软接缝。没有脚：`BOSS_SPEC.warden` 不写 `feet`，游戏端不贴地；静止姿态里底环放在地上（check-art 要求最低点贴地），动作把它托起来悬在离地 0.32 m。两道环、护盾板的转动在游戏端按时钟做（`rings` / `ringK` / `ringS`：招式里转快或停转、狂暴更快、雷环收紧再张开），不进动作表。没有新增调色板行：柱身、手、护盾板是灰白石行（首领身上按风化的淡石 `wstone`：粗糙度 0.62、金属度 0.25，`BOSS_SPEC.warden.tint` 往冷里收，进游戏是雷鸣遗迹立柱那种淡石色），饱和的黄铜只在领环、眼匣、两根短杆上；两道环、柱身的箍、底环顶面、护盾板顶、护腕的箍是板岩行（冷灰），柱身的竖箍和指节护是黑曜石行；眼匣、眼眶、护腕是黑曜石行（按金属）。（T35 全首领明暗：原来柱身按金属、环和箍是黄铜，整身偏暖。）

| 路径 | 内容 |
| --- | --- |
| `art/ca/boss/<kind>.py` | 造型（游戏坐标写，进 Kit 前经 `rig.g2b` 换成 Blender 坐标）、骨架 `BONES`（名字 / 父骨骼 / 枢轴）、软接缝 |
| `art/ca/boss/<kind>_clips.py` | 动作表：写法和游戏 `defClip` 的 keys 一样（`'骨骼.通道': [k, v, ...]`，负的 k = 加速冲到这一帧） |
| `art/ca/rig.py` | 共用：建骨架（骨骼一律竖直朝上、滚转 0，骨骼自己的坐标轴 = 游戏的模型空间）、蒙皮、逐帧写动作、带蒙皮导出、往动画的 extras 里写参数 |
| `art/rig.json` 的 `boss` | 命名规则（人形部位用标准骨架名，其余 `x_<部位>[_l\|_r][_NN]`，根骨骼一律 `pelvis`）和每只首领的骨骼表 |
| `assets/ca/boss/<kind>.glb` | 生成物：一个蒙皮网格（调色板图集 + 烘焙的 COLOR_0）、骨架、每段动作一个 glTF 动画 |
| `js/assets/boss-<kind>.js` | 打包时换成游戏直接用的数组（`tools/glb.mjs` 的 `packBoss`）：颜色烘焙好、焊接后的顶点 + 每个三角形角上的颜色、动作换成游戏的关节通道（Int16）。游戏端不解析 GLB、不解码调色板 |

几条规矩：

- **蒙皮权重在 Python 里算**：零件用 `k.bind(顶点, 骨骼, soft)` 标到骨骼上；没标 soft 的零件刚性跟一根骨骼，标了的在相邻关节附近按距离渐变（`rig.skin` 的 soft 表：子骨骼、父骨骼、枢轴、轴、带宽）。量化到 1/255、每个顶点最多 4 根。不用 Blender 的自动权重。
- **动作**：每段动作在 30 帧 / 秒上逐帧采样，导出器开 `export_force_sampling`；转角写成游戏的 XYZ 欧拉（R = Rx · Ry · Rz），|ry| < π/2、rx / rz 在 ±π 里（游戏端从矩阵换回欧拉角时拿到同一组值，`keys_check` 检查）。动作参数（`dur / k0 / loop / hold / loopFrom / steady / fade / out / base / air` 和别的元数据，比如死亡的 `impact`、走路的 `cycle`）写进动画的 extras。
- **时序**：动作名就是 AI 播的名字（`<招式>_w` 蓄力、`<招式>` 出手、`broken`、`death`），蓄力按实际播放的长度（招式蓄力 − 出手提前量）做，出手动作的 `k0` 是接触帧。另外 `idle` / `walk`（移动姿态）、`hit`（叠在受击上）、`mood`（狂暴时叠的姿态偏移）。
- **发光**：COLOR_0 的 α 照旧是 1 − 发光；游戏端三个角都发光的三角形进发光网格，亮度和「近白的芯」（发光 ≥ 0.9 的面）编码在 aSurf 里，其余在火色范围里。
- **交付**：首领包不进启动和进区的关键路径。进了有这只首领的区、图标预热画完以后再加载（`world.js` 的 `bossPackLater`），包到之前首领用原来的程序化外观，包到了在它闲着的时候原地换（不调 `newEnt`、不取随机数）。
- check-art 对首领多查：骨骼和 `art/rig.json` 的表一致、不超过 40 根、权重和为 1、每段动作有参数、`js/assets/boss-<kind>.js` 是从当前 GLB 打出来的（重新打包逐字节相同）。

转台图（Cycles CPU，每张一个 PNG）：

```bash
~/opt/blender-5.2.4/blender -b --factory-startup --python-exit-code 1 --python art/build.py -- \
  --turn ca/boss_golem --out /tmp/turn --res 480 --samples 16 --poses rest:0,slam_w:1,slam:0.25 --views front34,front,side,back,top
```

身子长的首领（衔星巨兽）加 `--scale 10.5`（正交相机的取景宽度，米；缺省 7.2）。

## AI 生成的布景件（ai3d-pilot）

这一节是静态布景和摆件；首领的 AI 外观（熔渣巨像）走另一条路，见下一节「AI 生成的首领外观」，角色和别的带动作的东西照旧走上面的生成脚本。现在只有试点的一件（`ca/frost_waystone`）。许可证和来源的规矩见 `assets/README.md` 的「AI 生成」。

源模型由用户生成：文生图（Z-Image Turbo），再图生 3D（TRELLIS.2 或 Pixal3D），得到一个带 PBR 贴图的 GLB。用户把它上传到编排者的收件箱，不进仓库。导入走同一条流水线，没有另起一套：

1. `art/catalog.py` 加一项 `gen='ai'`，`args` 给三样：
   - `prov`：来源记录 `assets/ai/<件>/provenance.json` 的路径；
   - `lod`：用哪一档，`processing.lods` 里的 `hi` 或 `lo`；
   - `mode`：外观，`albedo`（缺省）或 `vc`。
2. 来源记录里有：源文件的 sha256、提示词、种子、每个组件的版本和许可证、审查结论，以及给 `art/ai/importer.py` 的处理参数 `processing`。处理参数包括：
   - `rot_deg`：摆正。Pixal3D 的输出按概念图的相机倾斜，TRELLIS.2 的是正的；不知道角度时可以开 `level`，用底部拟合一个平面转平；
   - `height` / `sink`：真实高度和埋进地面的深度；
   - `weld` / `min_island` / `float_h`：焊接 UV 缝（源模型沿 UV 缝是断开的，不焊的话减面以后会裂）和删碎块；
   - `lods`：每一档的三角形数，预算看 `art/budgets.json` 的 `aiprop`：`tris` 是高 / 中画质，`lodTris` 是低画质；
   - `tex`：反照率贴图的 id、边长，低档要显示时加 `lo_px`，再加 `grade`；
   - `vc`：调色板版本用哪几行。
3. `npm run build:art` 时用环境变量 `CA_AI_INBOX` 指向收件箱（目录下是 `<名字>/model.glb`）。导入器依次做这几步：
   1. 导入，合成一个网格；
   2. 摆正，焊接，删掉非流形的面和飘在空中的小碎块；
   3. 原点放在包围盒的水平中心，贴地，缩放到真实高度；
   4. 减面（Decimate · Collapse），比例按实测修正到预算以内；
   5. 出外观，二选一：
      - `albedo`：保留源 UV 和生成的反照率贴图。贴图先把 UV 岛外的空白往外填，免得缩图时缝边渗进底色；再在线性空间里调明暗，用 `tint` 按游戏里的灰度校准；然后盒式缩到 512（低档 256），存成 `assets/ai/<件>/albedo.jpg`。GLB 里不带图，材质叫 `ai_albedo`。顶点色只烘 AO，和脚本件同一套烘焙；
      - `vc`：每个面取反照率的平均色，量化到共享调色板的几行，和脚本件一样一面一色，不要贴图。
4. 没有源文件的机器上，构建保留已经提交的生成物，全量构建照样逐字节一致；源文件的 sha256 和来源记录对不上就报错。同一台机器、同一个 Blender 版本重复构建，GLB 和贴图 JPEG 都逐字节相同。
5. 打包：`albedo` 外观的件焊接成带索引的紧凑网格（`tools/glb.mjs` 的 `packAi`：位置、UV、AO 色、索引），不存法线，游戏端用平直着色。贴图登记在 `tools/asset-sources.json` 的 `textures`（`ai` 类、只有 albedo），打进 `zone-<区>` 包，按贴图预算算显存。
6. check-art 对 AI 件多查这几项：来源记录齐全，并和清单记的源文件 sha256 一致；没有机器路径或个人信息；目录里没有概念图；贴图登记和尺寸对；重新打包逐字节一致。

游戏端：几何体带 `userData.tex`（贴图 id），材质用 `makeToonMat({ map: zoneTexture(id, 'albedo', { wrap: false }), flat: true })`。贴图是 sRGB 编码的，但和贴花层一样不标 `SRGBColorSpace`，材质设 `DECODE_VIDEO_TEXTURE`，按原始数据过滤、采样后在着色器里解码。调色按解码后的样子在游戏里校准。摆放和别的布景一样，用一个实例化网格，随机数用自己的一路。路标石见 `world.js` 的 `frostStones`。

开发和测试导入器不用真模型：拿 `assets/` 里的 CC0 GLB 细分到二三十万面、倾斜一下就能当输入，这份测试输入不提交。

## AI 生成的首领外观（ai3d-golem 起）

熔渣巨像（`ca/boss_golem`）从 2026-11-26 起用 AI 生成的模型（用户批准），清单里的 `gen` 是 `golem_ai`；原来的脚本巨像 `art/ca/boss/golem.py` 不再打包，骨架 `BONES` 和动作表 `golem_clips.py` 还是从那里来。来源、许可证见 `assets/README.md` 的「AI 生成」和 `assets/ca/boss/golem.provenance.json`。

| 路径 | 内容 |
| --- | --- |
| `art/ai/golem_fit.py` | 对骨架（纯 numpy）：源网格等比缩放到米，按切片量出肩 / 肘 / 腕、胯 / 膝 / 踝，躯干、头、烟囱、炉栅的枢轴按候选参数写死；导出用的骨架就是这组枢轴（28 根名字和动作表不变） |
| `art/ai/golem_rig.py` | 无头 Blender：减面 → 混合蒙皮（UniRig 的权重转到减面后的网格上，头 / 烟囱 / 肩甲这些整块的地方按几何区域改成刚性，每个顶点最多 4 根）→ 不相邻的两块之间拆开补口 → 在源网格上取色（概念图正面投影补裂缝和炉栅）→ 展 UV、烘反照率贴图 → 和脚本首领同一套 `rig.py` 导出 |
| `art/ai/golem/a01.json` | 候选 golem-a-01 的参数：枢轴、切面、提亮、炉芯，源 GLB / 概念图 / 权重 GLB 的 sha256 |
| `assets/ca/boss/golem.glb`、`golem_lo.glb` | 生成物：高 / 中用的 7845 个三角形，低画质的减面版 3837 个（不超过原来的 4096），都带一张 512 的反照率贴图 |

- **源文件不进仓库**：源 GLB、概念图、权重 GLB 在私有的 `cinder-ai-src`（环境变量 `CA_AI_ROOT`，缺省 `~/dev/cinder-ai-src`）。没有这些文件的机器上 `npm run build:art` 保留已提交的两个 GLB（打印 `CA_AI_KEEP`），全量构建照样逐字节一致；文件的 sha256 和参数里记的对不上就报错。
- **贴图**：首领类别在 `art/budgets.json` 里允许一张自己的反照率贴图（`albedo`：JPEG，边长不超过 512，材质名 `ai_golem_albedo`）；`packBoss` 打包时每个角记 UV、贴图原样放进包里（data URL），游戏端（`rigFromGlb` / `bossMap`）按贴图上色。显存按共用贴图算（512 是 1.33 MB）。
- **减面版**：`tools/asset-sources.json` 里 `boss-golem` 包的 `lo`：两份网格打进同一个包，游戏端低画质用 `golem_lo`（`BOSS_SPEC.golem.lo`），骨架、动作、挂点一样。
- **单独构建 / 看图**：`npm run build:art -- --only ca/boss_golem,ca/boss_golem_lo`；直接跑 `blender -b --factory-startup --python-exit-code 1 --python art/ai/golem_rig.py -- --spec art/ai/golem/a01.json --out <目录> --modes vc,tex` 出两种外观和 `build.json`（各步的数）。上面的 `--turn` 转台图只认脚本首领。

## AI 生成的武器（ai3d-weapons）

试点四种：剑、长杖、战锤、机炮。源模型和布景件一样来自用户的文生图 → 图生 3D（TRELLIS.2，约 2 万面、1024 的 PBR 贴图），来源记录在 `assets/ai/wpn_<种>/provenance.json`，许可证的规矩同上。现在只在试验开关 `&aiwpn=1` 下出现。

和布景件走同一条流水线（`gen='ai'`），外观换成 `mode='fc'`，由 `art/ai/weapon.py` 处理：

1. 摆正到武器自己的坐标：长轴 +y（glTF）、刃宽 / 枪背 +x、厚度 +z，按 `length` 缩放到主角手里的尺寸，原点放在握把中心（`grip` 是握把在包围盒里的归一化位置）。所以 `aiweapon` 类的原点不在底面，check-art 改查「原点在包围盒里」（`origin: "grip"`）。
2. 逐面取色：每个面在源贴图上取 4 个点，换成线性再平均；减面后在源网格上找最近的面取色，再按件聚成几种色块（`colors.k`），游戏镜头下读成干净的大色块。不带贴图、不用调色板：颜色写进 COLOR_0，UV 全是 0，材质叫 `ai_fc`。
3. 发光：生成的贴图里，发光的那块（光槽、晶体、符带、散热槽）只是普通颜色。按 `glow.rules` 的 HSV 规则在源网格上逐面判定，可以用 `box` 限定在包围盒里的某一段；邻接关系上去掉小碎块（`min_area`），补上被发光面包住的小洞（`fill_area`，锤头面板上的「XXX」花纹就是这样补成一整条的）。发光面往外长一圈、沿法线往外推 `shell` 米，单独减面成一层薄壳；本体是整个源网格单独减面，颜色只取非发光面。`cut_body` 把发光区从本体里去掉，只留发光壳盖住洞口：不去掉的话，几百面时减面后的本体会顶穿薄壳。游戏里发光面单独成一份几何体，按稀有度着色，所以花纹本身不会出现在游戏里。
4. 两档：`lods` / `glow_lods` 是本体和发光壳的三角形数。`hi` 给高 / 中画质的掉落模型，`lo` 给手里（所有画质，烘进主角骨架）和低画质的掉落，不比原来的脚本件重。
5. 机炮的枪管束单独成一件（`part='barrel'`），挂在开火时会转的关节上。按长轴切开（`split`）：`from` 之后的面归枪管；`dark_from` 到 `from` 之间，只有暗灰的面（伸进黄铜箍里的那截枪管）归枪管。切开后剩下的小碎片删掉。
6. 打包：fc 外观的件按（位置，颜色，发光）焊接成带索引的紧凑网格（`tools/glb.mjs` 的 `packFc`），不存法线。游戏端展开成不带索引的三角形，按面算法线。打进 `kit-aiwpn` 包（168 KB）。

游戏端见 `world.js` 的 `AIW_FIT` 一节：
- 手里的武器坐标 (x, y, z) 换算成武器关节的 (z, x, y)，和脚本件的握法一样（握把沿 +z、刃宽 / 枪背沿 +y），挂在原来的关节上，脚本件就不建了；
- 掉落模型按脚本件掉落模型的握把高度和大小摆；
- 包要在建主角骨架之前就到，所以 `index.html` 看到开关时同步引入；没到就照旧用脚本件。
