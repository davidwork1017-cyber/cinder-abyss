# 外部素材（全部 CC0）

| 目录 | 来源 | 许可证 |
| --- | --- | --- |
| `polyhaven/` | Poly Haven 贴图，https://polyhaven.com | CC0（`polyhaven/LICENSE.txt`） |
| `ambientcg/` | ambientCG 贴图，https://ambientcg.com | CC0（`ambientcg/LICENSE.txt`） |
| `generated/` | `tools/gen-ground-textures.mjs` 按固定种子程序化生成的地面覆盖层（`g_cover_*`）和贴花图集（`g_decals`） | 原创（我们自己画的，不是第三方素材） |
| `ca/` | 自产布景件：`art/` 下的 Blender 生成脚本按固定种子生成（`npm run build:art`，见 `docs/art-pipeline.md`），清单 `ca/manifest.json` 记着每件的生成器、参数、种子和 sha256；`ship` 为 true 的件打进 `js/assets/kit-<区>.js` | 原创（我们自己的脚本生成，不是第三方素材） |
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
- 程序化贴图：`node tools/gen-ground-textures.mjs` 重新生成 `generated/` 下的贴图（同样的代码出同样的像素，JPEG 编码借 playwright-core 的 Chrome），格式同上；贴花图集的 `arh.jpg` 的 G 通道是不透明度。
- 模型：原样从各素材包复制（KayKit 的 `.gltf.glb` 改名为 `.glb`）。KayKit / Kenney 这三个包从 2026-11-22 起不再打包（`tools/asset-sources.json` 里没有 `models` 包了，布景全是 `ca/` 自产件）。`ca/` 下的自产件是生成物，不要手改：改 `art/` 下的脚本或 `art/catalog.py` 再重新生成，`npm run check:art`（也是 test:func 的第一步）核对预算、命名、原点和清单。
- 人形标准骨架的动作（`ual/ual-clips.glb`）：`node tools/ual-pack.mjs <UAL1 的 AnimationLibrary_Godot_Standard.glb> <UAL2 的 UAL2_Standard.glb>` 从两个下载包里只挑用到的动作
  （Zombie_Idle_Loop / Zombie_Walk_Fwd_Loop / Hit_Chest / Death01 的前 1.6 秒），骨架是 UAL2 的 65 骨骼去掉手指和末端骨骼（23 根），没有网格；
  游戏端按 `js/world.js` 里「人形标准骨架」一节的对照表把它重定向到游魂、烬骸仆从的骨架上。下载包本身不进仓库。
- 打包：`node tools/pack-assets.mjs` 把这里的文件转成 `js/assets/*.js`（base64），游戏从 `file://` 打开也能用。改了这里的文件要重新打包，生成的 JS 一起提交。
- 角色模型（Quaternius 2018–2020 的免费包，CC0；2025 年以后的 Quaternius 包是 QAL 许可，不用）：源文件原样放在 `quaternius-*/`（`.gltf` / `.fbx`），
  `node tools/convert-chars.mjs`（无头 Chrome + three r128 的 FBXLoader / GLTFLoader，`tools/vendor/` 里是转换用的 r128 原版文件）转成同目录下精简的 `.glb`
  （只留骨骼、蒙皮网格、要用的动作；Adventurer 的背包不转），再由 `pack-assets.mjs` 打进 `js/assets/chars.js`。游戏端在 `js/world.js` 的「C 模型」一节同步解析，
  把网格重新摆到程序化骨架的静止姿态、蒙皮到程序化关节上，原有动作照常驱动；`chars.js` 缺失或解析失败时用程序化角色。
