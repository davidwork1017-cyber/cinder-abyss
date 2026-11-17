# 外部素材（全部 CC0）

| 目录 | 来源 | 许可证 |
| --- | --- | --- |
| `polyhaven/` | Poly Haven 贴图，https://polyhaven.com | CC0（`polyhaven/LICENSE.txt`） |
| `ambientcg/` | ambientCG 贴图，https://ambientcg.com | CC0（`ambientcg/LICENSE.txt`） |
| `kaykit-dungeon-remastered/` | KayKit Dungeon Remastered 1.0，Kay Lousberg，https://kaylousberg.itch.io/kaykit-dungeon-remastered | CC0（`LICENSE.txt`） |
| `kaykit-halloween-bits/` | KayKit Halloween Bits 1.0，Kay Lousberg，https://kaylousberg.itch.io/halloween-bits | CC0（`LICENSE.txt`） |
| `kenney-nature-kit/` | Kenney Nature Kit 2.1，https://kenney.nl/assets/nature-kit | CC0（`License.txt`） |

- 贴图：`node tools/prep-textures.mjs` 下载 1k 原图（缓存在 `.asset-cache/`，不进仓库），压成每套三张 JPEG：`albedo.jpg`、`normal.jpg`（OpenGL 法线）、`arh.jpg`（R 遮蔽 / G 粗糙度 / B 高度；Lava001 的 R 放自发光）。清单在 `tools/asset-sources.json`。
- 模型：原样从各素材包复制（KayKit 的 `.gltf.glb` 改名为 `.glb`）。
- 打包：`node tools/pack-assets.mjs` 把这里的文件转成 `js/assets/*.js`（base64），游戏从 `file://` 打开也能用。改了这里的文件要重新打包，生成的 JS 一起提交。
