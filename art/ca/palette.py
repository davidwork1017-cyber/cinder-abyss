# 共享调色板图集：所有布景件和首领共用一张 64×64 的小图（32 行 × 每行 2 像素高，boss-golem 起从 64×32 长到 64×64，已有行号不变），每行是一条从暗到亮的色带。
# 面的 UV 落在某一行的某个位置（u = 明暗），游戏端烘焙时按 UV 取色进顶点色（见 js/assets.js 的 bakeGltf），
# 所以换色只改这里、重新 npm run build:art，所有件一起变；也方便以后在引擎里直接采样同一张图做批量绘制。
# 颜色是 sRGB 十六进制；色带内按 u 在相邻色标之间线性插值（在 sRGB 里插，色带短，差别看不出来）。
# 明暗按游戏里的样子定：布景材质会再乘区域配色（第 0 区 prop.tint 0x6e5c54）并压饱和度，所以这里的色比「直接看」要亮；
# 校准口径是被顶替的 KayKit / Kenney 件烘焙后的平均亮度（线性亮度：枯树约 0.1、骨约 0.65、铁约 0.24，见 docs/art-style.md）。
import struct
import zlib

W, H = 64, 64
ROW_H = 2
SLOTS = H // ROW_H  # 图集能放的行数；还没用到的行画成黑色（不会被取到）

# 行号固定（GLB 里的 UV 依赖它），新增只往后加，不要改已有行的顺序
ROWS = [
    ('stone', ['#4a433e', '#6e655e', '#90857b', '#ada195']),  # 0 灰烬岩 / 砌石
    ('char', ['#4c3f37', '#6c5a4d', '#887261', '#a28c78']),  # 1 焦黑树皮 / 炭
    ('bone', ['#a89a80', '#c8baa0', '#e0d4ba', '#f2e9d6']),  # 2 骨
    ('iron', ['#5c5656', '#7c726e', '#9a8a7a', '#b4a292']),  # 3 锈铁
    ('ember', ['#4a1205', '#9a2f0a', '#d4561a', '#ff9a3a']),  # 4 余烬（裂缝里透出的火光色）
    ('slag', ['#2a2425', '#403738', '#584c4c', '#706262']),  # 5 熔渣 / 暗岩
    ('dust', ['#6a625a', '#8c8278', '#ab9f92', '#c6baac']),  # 6 积灰（朝上的面）
    ('wood', ['#3e2e22', '#58412f', '#72563e', '#8a6a4e']),  # 7 焦褐木
    ('rust', ['#4a2a1c', '#74402a', '#9a5a36', '#b8784e']),  # 8 铁锈（铁件的第二色调）
    ('lichen', ['#4e5246', '#6a6e5c', '#878a74', '#a2a48c']),  # 9 灰苔（石头侧面的点缀，灰绿、很淡）
    ('pale', ['#8a847c', '#aea8a0', '#d0cac2', '#efebe5']),  # 10 灰白石（烧白 / 积灰很厚的石头：火坑石、石头的第二色调）
    ('grime', ['#4a3e30', '#665440', '#826c54', '#9c8468']),  # 11 污垢（骨头的第二色调、缝里的脏色）
    ('plank', ['#5e4630', '#866548', '#ab8660', '#cba67e']),  # 12 浅木板（盾面这类要读得出木纹的件；比 wood 亮，不改 wood 是为了不动已经通过的枯树）
    ('slate', ['#5a6668', '#7c8a8c', '#a0acac', '#c2cccb']),  # 13 板岩（坠星裂谷：冷青灰的板岩块、石碑、碎地砖；游戏里再乘 rift 的 prop.tint）
    ('starglass', ['#1e5a66', '#3aa6b8', '#7aeeff', '#d8fcff']),  # 14 星辉（坠星裂谷：断面、小晶刺，弱自发光，保留色相）
    ('brass', ['#4a3418', '#7a5a28', '#b8883a', '#f2d08a']),  # 15 黄铜（雷鸣遗迹：雷枢的线圈 / 尖帽 / 雷纹、立灯的格栅和灯芯）
    ('basalt', ['#3c4250', '#5a6272', '#7e8798', '#a6aebd']),  # 16 玄武岩（首领：熔渣巨像的大块，冷的蓝灰，在暖褐的地面上分得开；比熔渣亮，受光面在灰度检查的 55–75%）
]
ROW = {name: i for i, (name, _) in enumerate(ROWS)}
assert len(ROWS) <= SLOTS, '调色板行数超过图集容量'


def _hex(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def ramp(row, u):
    """色带上 u（0–1）处的 sRGB 颜色（0–255 整数三元组）"""
    stops = [_hex(c) for c in ROWS[row][1]]
    u = min(1.0, max(0.0, u)) * (len(stops) - 1)
    i = min(len(stops) - 2, int(u))
    t = u - i
    return [round(stops[i][k] * (1 - t) + stops[i + 1][k] * t) for k in range(3)]


def uv_of(row, u):
    """调色板行 + 明暗 → Blender UV（v 朝上；导出 glTF 时会翻成朝下，正好对上 PNG 的行序）"""
    x = (min(W - 1, max(0, int(u * W))) + 0.5) / W
    y = (row * ROW_H + ROW_H * 0.5) / H
    return (x, 1.0 - y)


def atlas_png():
    """调色板图集的 PNG 字节（自己写编码器：同样的输入永远得到同样的字节）"""
    raw = bytearray()
    for y in range(H):
        row = y // ROW_H
        raw.append(0)  # 每行的过滤类型：无
        for x in range(W):
            raw.extend(ramp(row, (x + 0.5) / W) if row < len(ROWS) else (0, 0, 0))

    def chunk(t, data):
        c = struct.pack('>I', len(data)) + t + data
        return c + struct.pack('>I', zlib.crc32(t + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
