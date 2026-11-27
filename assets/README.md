# 外部素材（CC0，另有 AI 生成的件：一件布景、一只首领的外观、主角和两种小怪的外观、一批技能件和绊雷）

| 目录 | 来源 | 许可证 |
| --- | --- | --- |
| `polyhaven/` | Poly Haven 贴图，https://polyhaven.com | CC0（`polyhaven/LICENSE.txt`） |
| `ambientcg/` | ambientCG 贴图，https://ambientcg.com | CC0（`ambientcg/LICENSE.txt`） |
| `generated/` | `tools/gen-ground-textures.mjs` 按固定种子程序化生成的地面覆盖层（`g_cover_*`）和贴花图集（`g_decals`）；`tools/gen-paint-textures.mjs` 按固定种子画的平铺贴图（`p_mud` 龟裂焦土、`p_burn` 焦痕碎石、`p_rock` 棱面石头，第 0 区的路面 / 粗糙地面 / 虚空地面和岩石三向投影；`p_ice` 冰面、`p_snow` 带雪的冻泥、`p_frock` 层状岩，第 1 区的同样几处；种子写在 `tools/paint-tex.mjs` 每张图的 `seed` 里：p_mud 211、p_burn 307、p_rock 101、p_ice 401、p_snow 503、p_frock 607），清单 `generated/manifest.json` 记着生成器、种子、原始像素和 JPEG 的 sha256 | 原创（我们自己画的，不是第三方素材） |
| `ca/` | 自产布景件：`art/` 下的 Blender 生成脚本按固定种子生成（`npm run build:art`，见 `docs/art-pipeline.md`），清单 `ca/manifest.json` 记着每件的生成器、参数、种子和 sha256；`ship` 为 true 的件打进 `js/assets/kit-<区>.js` | 原创（我们自己的脚本生成，不是第三方素材） |
| `ai/` | AI 生成的布景件（试点，2026-11-26 起；见下面「AI 生成」）：用户用文生图 → 图生 3D 生成源模型，`art/ai/importer.py` 处理成游戏用的件，每件一个目录（来源记录 `provenance.json` + 反照率贴图） | 组件许可证见下面「AI 生成」；输出不受限制 |
| `story/` | 开场故事的画格（`js/story.js` 放的时候才加载）：`tools/story/bake.mjs` 用游戏自己的引擎摆拍（角色、区域、首领都是游戏里现成的，用到的第三方模型和贴图就是上面这些 CC0 包），再加墨线 / 平涂分阶 / 网点烘成分层 webp，见 `tools/story/README.md` | 原创（游戏画面的渲染图，不是第三方素材） |
| `kaykit-dungeon-remastered/` | KayKit Dungeon Remastered 1.0，Kay Lousberg，https://kaylousberg.itch.io/kaykit-dungeon-remastered | CC0（`LICENSE.txt`）；2026-11-22（models-drop）起不再打进游戏，源文件和许可证留作记录 |
| `kaykit-halloween-bits/` | KayKit Halloween Bits 1.0，Kay Lousberg，https://kaylousberg.itch.io/halloween-bits | CC0（`LICENSE.txt`）；2026-11-22（models-drop）起不再打进游戏，源文件和许可证留作记录 |
| `kenney-nature-kit/` | Kenney Nature Kit 2.1，https://kenney.nl/assets/nature-kit | CC0（`License.txt`）；2026-11-22（models-drop）起不再打进游戏，源文件和许可证留作记录 |
| `quaternius-modular-men/` | Quaternius Ultimate Modular Men（Adventurer），https://quaternius.com/packs/ultimatemodularcharacters.html | CC0（`License_ModularMen.txt`） |
| `quaternius-animated-zombie/` | Quaternius Animated Zombie（Zombie），https://quaternius.com/packs/animatedzombie.html | CC0（包里没有许可证文件，按包页面的 CC0 记在 `License_AnimatedZombie.txt`） |
| `quaternius-animated-monster/` | Quaternius Animated Monster（Skeleton），https://quaternius.com/packs/animatedmonster.html | CC0（`License_AnimatedMonster.txt`） |
| `quaternius-easy-enemy/` | Quaternius Easy Enemy（Spider），https://quaternius.com/packs/easyenemy.html | CC0（`License_EasyEnemy.txt`） |
| `ual/` | Quaternius Universal Animation Library [Standard]（https://opengameart.org/content/universal-animation-library ，`universal_animation_librarystandard.zip`）和 Universal Animation Library 2 [Standard]（https://opengameart.org/content/universal-animation-library-2 ，`universal_animation_library_2standard.zip`），作者本人在 OpenGameArt 的上传；sha256 记在 `tools/asset-sources.json` 的 `sources.ual` | CC0（下载包里的许可证文件原样复制：`License_UAL1.txt`、`License_UAL2.txt`） |

- 贴图：`node tools/prep-textures.mjs` 下载 1k 原图（缓存在 `.asset-cache/`，不进仓库），压成每套三张 JPEG：`albedo.jpg`、`normal.jpg`（OpenGL 法线）、`arh.jpg`（R 遮蔽 / G 粗糙度 / B 高度；Lava001 的 R 放自发光）。清单在 `tools/asset-sources.json`。
- 程序化贴图：`node tools/gen-ground-textures.mjs` 重新生成 `generated/` 下的贴图（像素在 `tools/ground-tex.mjs` 里只用 Node 按固定种子算，同样的代码出同样的像素；JPEG 编码借 playwright-core 的 Chrome），格式同上，但只出 `tools/asset-sources.json` 里 `kinds` 列的通道（贴花图集和覆盖层的法线游戏里不采样，不出）；贴花图集的 `arh.jpg` 的 G 通道是不透明度。每张图的生成函数、原始像素和 JPEG 的 sha256 记在 `generated/manifest.json`，`npm run check:art` 重新算像素核对（tex-t2）。
- 贴图的画质档（tex-t2）：`tools/asset-sources.json` 的贴图条目可以写 `lo: true`（低档用 `<id>/lo/` 下的小图）或 `skipLow: true`（低档整套不解码，游戏给透明占位图，比如低档不画的贴花图集 `g_decals`）。贴图预算在 `art/budgets.json` 的 `textures`，check-art 按每区、每档算显存。
- `ambientcg/Lava001` 从 zones-polish 起游戏里不用了，tex-t2 起不再打包（文件和许可证留着）。
- 画的平铺贴图：像素在 `tools/paint-tex.mjs`（只用 Node），`node tools/gen-paint-textures.mjs` 重新生成 `generated/p_*/`（512² 的 albedo / normal / arh，另有低档用的 256² `lo/albedo.jpg`、`lo/arh.jpg`，低档不传法线贴图）。JPEG 由清单里钉住的 Chrome 版本编码，版本不同会拒绝（换版本加 `--rebase`）；`node tools/gen-paint-textures.mjs --check` 只用 Node 重算像素、核对清单里的 sha256。2026-11-24（tex-t1）起第 0 区不再用照片贴图，只有第 0 区用过的 `mud_cracked_dry_03`、`burned_ground_01` 从 `polyhaven/` 删掉了（`dark_rock` 深渊还在用）。2026-11-26（tex-t3）起第 1 区也不再用照片贴图：`ambientcg/Ice002`、`Snow013` 只有第 1 区用过，删掉了；`Rock035` 雷鸣遗迹和坠星裂谷还在用（rock-grey 包），留着。
- 模型：原样从各素材包复制（KayKit 的 `.gltf.glb` 改名为 `.glb`）。KayKit / Kenney 这三个包从 2026-11-22 起不再打包（`tools/asset-sources.json` 里没有 `models` 包了，布景全是 `ca/` 自产件）。`ca/` 下的自产件是生成物，不要手改：改 `art/` 下的脚本或 `art/catalog.py` 再重新生成，`npm run check:art`（也是 test:func 的第一步）核对预算、命名、原点和清单。
- 人形标准骨架的动作（`ual/ual-clips.glb`）：`node tools/ual-pack.mjs <UAL1 的 AnimationLibrary_Godot_Standard.glb> <UAL2 的 UAL2_Standard.glb>` 从两个下载包里只挑用到的动作
  （Zombie_Idle_Loop / Zombie_Walk_Fwd_Loop / Hit_Chest / Death01 的前 1.6 秒），骨架是 UAL2 的 65 骨骼去掉手指和末端骨骼（23 根），没有网格；
  游戏端按 `js/world.js` 里「人形标准骨架」一节的对照表把它重定向到游魂、烬骸仆从的骨架上。下载包本身不进仓库。
- 打包：`node tools/pack-assets.mjs` 把这里的文件转成 `js/assets/*.js`（base64），游戏从 `file://` 打开也能用。改了这里的文件要重新打包，生成的 JS 一起提交。
- 角色模型（Quaternius 2018–2020 的免费包，CC0；2025 年以后的 Quaternius 包是 QAL 许可，不用）：源文件原样放在 `quaternius-*/`（`.gltf` / `.fbx`），
  `node tools/convert-chars.mjs`（无头 Chrome + three r128 的 FBXLoader / GLTFLoader，`tools/vendor/` 里是转换用的 r128 原版文件）转成同目录下精简的 `.glb`
  （只留骨骼、蒙皮网格、要用的动作；Adventurer 的背包不转），再由 `pack-assets.mjs` 打进 `js/assets/chars.js`。游戏端在 `js/world.js` 的「C 模型」一节同步解析，
  把网格重新摆到程序化骨架的静止姿态、蒙皮到程序化关节上，原有动作照常驱动；`chars.js` 缺失或解析失败时用程序化角色。

## AI 生成

2026-11-26 起用 AI 生成模型（用户批准）：先是一件静态布景（试点），之后熔渣巨像的外观也换成 AI 生成的模型，骨架、动作和招式都没动，只换了网格和贴图。2026-11-27 起技能放出来的实心小件（冰系、雷桩）和绊雷也换成 AI 生成的模型，判定和数值都没动；主角的外观也换成 AI 生成的模型，程序化骨架、动作、挂点和模拟都没动，Adventurer 留作退路。游魂和烬骸仆从的外观随后也换了，骨骼集合和现网的 Zombie / Skeleton 一样，原来的模型留作退路。

| 件 | 用在哪 | 来源记录 |
| --- | --- | --- |
| `ca/frost_waystone`（路标石：风化的石柱立在碎石和积雪的基座上） | 霜骨沼泽岸边，每区 3–6 块，低画质不显示 | `ai/frost_waystone/provenance.json` |
| `ca/boss_golem`（熔渣巨像：玄武岩块拼成的巨像，胸口是拱形铁栅炉膛，肩上两根短烟囱）、`ca/boss_golem_lo`（低画质的减面版） | 第 0 区首领，`js/assets/boss-golem.js`；低画质用减面版 | `ca/boss/golem.provenance.json` |
| 技能件：冰晶、冰凌、冰碴、冰簇、雷桩（晶柱 + 底座）、冰棱（刻式件、投射物零件各一份，投射物另有低画质减面版） | 冰系技能（冰脊、坠凌、冰棱、冰爆、冰系命中和碎块、冰片 / 冰棱投射物）、雷桩；`js/assets/skill-pieces.js`，几十到一百多个三角形、一面一色、没有贴图 | `ai/skill-ice-spike`、`skill-ice-icicle`、`skill-ice-chunk`、`skill-ice-cluster`、`skill-ice-shard`、`skill-pylon` 下的 `provenance.json` |
| `ca/gear_mine`（绊雷：暗铁圆盘、往上张开的爪，中间一个灯窝） | 夜猎 / 炉匠的绊雷，`js/assets/kit-gear.js` | `ai/gear_mine/provenance.json` |
| 主角（银紫短发、青绿围巾、敞开的靛紫短袖夹克带两片到膝的后摆、米色衬衣、藏青长裤、棕靴）：`ai/hero/hero.glb`（高 / 中画质，10032 个三角形）、`ai/hero/hero_lo.glb`（低画质，7632） | 主角默认外观，打进 `js/assets/chars.js`（`aihero_hi` / `aihero_lo`）；包缺了、解析失败或套用出错时退回 Adventurer | `ai/hero/provenance.json` |
| 游魂（灰白的瘦削尸鬼：光头、深眼窝、肩上一块破布、腰间破布裙、赤脚）：`ai/enemy/husk.glb`（高 / 中画质，2400 个三角形）、`ai/enemy/husk_lo.glb`（低画质，2100） | 游魂默认外观，打进 `js/assets/chars.js`（`aihusk_hi` / `aihusk_lo`）；包缺了、解析失败或套用出错时退回 Zombie | `ai/enemy/provenance-husk.json` |
| 烬骸仆从（米白骨架、眼窝发橙光、锁骨一道横梁、深色破腰布、空手）：`ai/enemy/thrall.glb`（高 / 中画质，2400）、`ai/enemy/thrall_lo.glb`（低画质，1800） | 烬骸仆从默认外观，剑和盾仍是程序化的，打进 `js/assets/chars.js`（`aithrall_hi` / `aithrall_lo`）；退路是 Skeleton | `ai/enemy/provenance-thrall.json` |

- **生成流程**：ComfyUI 0.43.0，只用内置节点。Z-Image Turbo 文生图，TRELLIS.2 图生 3D，另外用到 BiRefNet、DINOv3、MoGe-2。巨像、主角、游魂和烬骸仆从的蒙皮用 UniRig（只算权重，骨架是我们自己拟合的骨架）。提示词、种子、每个组件的版本都在各自的来源记录里。
- **处理**：
  - 布景件：`art/ai/importer.py`（`gen='ai'`）摆正、去碎块、减面到 `art/budgets.json` 的 `aiprop`，反照率贴图在 `ai/<件>/albedo.jpg`。
  - 技能件：`art/ai/pieces.py` 按每件的坐标约定摆好，凸的件取凸包再合并棱面，别的减面，预算在 `art/budgets.json` 的 `pieces`（冰晶 / 冰凌 120、冰碴 / 冰簇 / 雷桩 150、冰棱 60、低画质冰棱 36）；颜色按面从反照率里取，烘成形状批的色阶、刻式件的明暗倍数或投射物的顶点色，不要贴图。绊雷走布景件的 `vc` 外观（三角形不超过原来的 508）。
  - 巨像：`art/ai/golem_rig.py`（`gen='golem_ai'`）把源模型对到巨像骨架上，减面到首领预算以内（高 7845、低 3837 个三角形），四肢和关节用 UniRig 的权重，头、烟囱、肩甲这些整块的地方按几何区域改成刚性，反照率贴图 512 带在 GLB 里，按游戏镜头的灰度调亮。
  - 主角：`art/ai/hero_rig.py`（拟合在 `art/ai/hero_fit.py`）把 A 字站姿的源模型对到 53 根的标准人形骨架（UE / UAL 骨骼名），先做几处脚本修形（头放大 1.15、护膝压平），权重用 UniRig 算的再按区域改（头和头发、手掌、四指三节、拇指、护腕、后摆各有固定的规则），拳头烘进绑定姿态，减面到 `art/budgets.json` 的 `hero` 以内（高 10032、低 7632，低画质不比 Adventurer 的 8450 重）。颜色按角从反照率里取，再按定点改色把头发、围巾、衬衣、长裤调回游戏里主角的配色；脸上的暗条改回肤色，另贴两只小眼睛和细眉。导出时同色的角并成一个顶点，颜色存 8 位，没有贴图。`--ship` 把选定的一份复制到 `ai/hero/`。
  - 游魂、烬骸仆从：同一套 `hero_rig.py`，配置在 `art/ai/enemy/`（`g01.json`、`t06.json`）。骨骼集合换成现网模型的那一组（游魂 41 根、仆从 12 根，标准名，父子关系也一样），所以程序化关节和动作照旧；权重用 UniRig 的，手和锁骨按区域改；仆从的头缩到 0.88；游魂整体去饱和、往冷紫调，和米白的仆从分开。高画质 2400 个三角形，低画质不比原来的模型重（游魂 2100 对 Zombie 2116，仆从 1800 对 Skeleton 1810）。
  - 布景件和巨像由 `npm run build:art` 调用，主角和两种小怪用 `hero_rig.py` 单独生成；源文件不在的机器上保留已提交的生成物。
- **许可证**：生成时用到的每个组件都读过许可证原文：
  - ComfyUI：GPL-3.0，只是工具，输出不受约束；
  - Z-Image Turbo、Qwen3-4B 文本编码器、VAE（和 FLUX.1-schnell 的 ae 逐字节相同）：Apache-2.0；
  - TRELLIS.2、BiRefNet、MoGe-2：MIT；
  - DINOv3：DINOv3 License；它带的 NAF 上采样器：Apache-2.0；
  - UniRig：代码和权重都是 MIT（里面带的 michelangelo 是 GPL-3.0，只在本地当工具跑）；训练数据 Articulation-XL2.0 是 CC-BY-4.0，对我们的输出没有义务。

  这些组件都不限制输出、不禁止商用，也不要求在输出上署名。nvdiffrast（只许研究或评估用途）不在这条流程里；Puppeteer 的蒙皮用到 NVIDIA PartField（只许非商业研究用途），不用。换生成流程、换权重或者商业发行之前，要重新审一遍。
- **凭据**：许可证审查表和每份许可证原文（第一行是来源和版本）在编排者的笔记 `notes/ai3d/` 里，不进仓库；每件的来源记录里记着结论。
- **不进仓库的东西**：源 GLB、概念图、UniRig 的权重 GLB（都只记 sha256）。仓库里只有处理后的游戏用件、反照率贴图和来源记录。
- **审核**：和脚本件 / 脚本首领一样看灰度、风格和预算（首领另看出手帧：挂点落在预警里），另外做一次相似度检查：不能像任何已有游戏的素材或 IP，提示词里也不提别的游戏或 IP。

