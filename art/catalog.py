# 布景件清单：每一项 = 生成器 + 参数 + 种子。改这里、跑 npm run build:art，就会重新生成 assets/ca/ 下的 GLB 和 manifest.json。
# id 规则见 docs/art-style.md：ca/<区>_<物件>[_变体]；文件名 = id 去掉 ca/ 前缀。
# ship = True：打进游戏的素材包（js/assets/kit-<区>.js）；False：只生成 GLB（备选件，摆放那边要用时改成 True）。
# replaces：在本区摆放表里顶替的旧模型（scale 1 时的尺寸、原点和它一致，摆放表的缩放不用改）。
# bake：烘焙参数（ao = AO 采样距离，米；grad = 底部压暗渐变的高度，米；wear / grime = 边缘提亮 / 缝里压暗的强度；gtint = 污垢色偏的浓淡；gain = 整件明暗的倍数，按游戏里的灰度校准，缺省 1），按件的真实尺寸给。
# cues：材质线索参数（val = 明暗斑块幅度，second = 要不要第二色调，lichen = 灰苔比例），缺省值见 art/ca/core.py 的 material_cues。
# 烬渊深处：板岩换成灰烬岩、星辉换成余烬（暗芯亮边靠余烬缝），灰苔和土堆的积灰色换成污垢；明暗交给区域配色 prop.tint 和每件的 gain
ABYSS = {'slate': 'stone', 'starglass': 'ember', 'lichen': 'grime', 'dust': 'grime'}

CATALOG = [
    # ---- 灰烬地带：顶替现有 KayKit / Kenney 布景（路边小物 skull / bones / blade / marker 是第二版，asset-lib-props2） ----
    dict(id='ca/ash_tree_dead_a', gen='tree', seed=11, cat='prop', zone='ash', ship=True, replaces='kh/tree_dead_large',
         args=dict(h=5.0, r0=0.36, lean=0.1, branches=6, ember=2)),
    dict(id='ca/ash_tree_dead_b', gen='tree', seed=23, cat='prop', zone='ash', ship=True, replaces='kh/tree_dead_medium',
         args=dict(h=4.2, r0=0.31, lean=0.2, branches=4, ember=2, spread=1.2)),
    dict(id='ca/ash_tree_dead_c', gen='tree', seed=37, cat='prop', zone='ash', ship=True, replaces='kh/tree_dead_small',
         args=dict(h=4.6, r0=0.34, lean=0.16, branches=3, snag=True, ember=1)),
    dict(id='ca/ash_skull', gen='skull2', seed=5, cat='scatter', zone='ash', ship=True, replaces='kh/skull',
         args=dict(R=0.63), bake=dict(ao=0.4, grad=0.5, grime=0.25, gtint=0.6, wear=0.4), cues=dict(second=False, val=0.2)),
    dict(id='ca/ash_bones', gen='bone', seed=3, cat='scatter', zone='ash', ship=True, replaces='kh/bone_A',
         args=dict(L=0.74, r=0.085), bake=dict(ao=0.1, grad=0.1, gtint=0.5), cues=dict(second=False, val=0.2)),
    dict(id='ca/ash_blade', gen='shield_sword', seed=7, cat='scatter', zone='ash', ship=True, replaces='kd/sword_shield_broken',
         args=dict(R=0.52, h=1.1), bake=dict(ao=0.2, grad=0.25, gtint=0.6)),
    dict(id='ca/ash_marker', gen='grave_cross', seed=13, cat='scatter', zone='ash', ship=True, replaces='kh/gravemarker_A',
         args=dict(h=1.2, w=0.72), bake=dict(ao=0.3, grad=0.4)),
    dict(id='ca/ash_firepit', gen='firepit', seed=17, cat='prop', zone='ash', ship=True, replaces='kn/campfire_stones',
         args=dict(r=0.29), bake=dict(ao=0.03, grad=0.03, gtint=0.3, grime=0.12, wear=0.4)),
    dict(id='ca/ash_pillar', gen='pillar', seed=19, cat='kit', zone='ash', ship=True, replaces='kh/pillar',
         args=dict(h=4.4, r=0.42, broken=0.18)),
    dict(id='ca/ash_rubble', gen='rubble', seed=29, cat='kit', zone='ash', ship=True, replaces='kd/rubble_large',
         args=dict(L=8.0, H=3.5), bake=dict(ao=1.0, grad=1.2)),
    # ---- 灰烬地带：备选件（摆放那边要用再打包） ----
    dict(id='ca/ash_rock_a', gen='rock', seed=41, cat='prop', zone='ash', ship=False, args=dict(sx=1.0, sy=0.8, sz=0.7)),
    dict(id='ca/ash_rock_b', gen='rock', seed=43, cat='prop', zone='ash', ship=False, args=dict(sx=0.55, sy=0.5, sz=1.5, n=14, row='slag', ember=2)),
    dict(id='ca/ash_rock_c', gen='rock', seed=47, cat='prop', zone='ash', ship=False, args=dict(sx=1.3, sy=1.0, sz=0.55, flat=0.35)),
    dict(id='ca/ash_cliff_a', gen='cliff', seed=53, cat='kit', zone='ash', ship=False, args=dict(w=3.0, d=1.6, h=3.2), bake=dict(ao=0.9, grad=1.2)),
    dict(id='ca/ash_wall_a', gen='wall', seed=59, cat='kit', zone='ash', ship=False, args=dict(L=4.0, H=2.4, broken=0.45, bevel=0.025), bake=dict(ao=0.5, grad=0.9)),
    dict(id='ca/ash_arch_a', gen='arch', seed=61, cat='kit', zone='ash', ship=False, args=dict(span=3.2, h=4.0), bake=dict(ao=0.8, grad=1.0)),
    dict(id='ca/ash_brazier_a', gen='brazier', seed=67, cat='prop', zone='ash', ship=False, args=dict(h=1.1), bake=dict(ao=0.25, grad=0.4)),
    # ---- 坠星裂谷（第 4 区）：顶替 Kenney / KayKit 布景（fit = scale 1 时的包围盒对齐被顶替件：r / 顶 / 底，浮点照抄 geoInfo；摆放表只换 id、去掉 r 标记）。
    # 碎地砖例外：KayKit 地砖的底在 y = -0.1（摆放时按标记 l 抬回地面），自产件按规矩原点在底面（底 0、顶 = 原来的厚度 0.15），标记 l 抬 0，落地后的位置和原来一样 ----
    dict(id='ca/rift_monolith', gen='monolith', seed=71, cat='prop', zone='rift', ship=True, replaces='kn/stone_tallA',
         fit=dict(r=0.49153444170951843, top=0.9459258913993835, bottom=-0.05000000074505806), bake=dict(ao=0.12, grad=0.25), finish=dict(dust=0.2, dust_row='lichen')),
    dict(id='ca/rift_shards', gen='shards', seed=73, cat='prop', zone='rift', ship=True, replaces='kn/stone_tallC',
         fit=dict(r=0.22809721529483795, top=0.7329360246658325, bottom=-0.05000000074505806), bake=dict(ao=0.08, grad=0.2, gain=0.68), finish=dict(dust=0.2, dust_row='lichen')),
    dict(id='ca/rift_stele', gen='stele', seed=79, cat='prop', zone='rift', ship=True, replaces='kn/statue_obelisk',
         fit=dict(r=0.15350933372974396, top=0.8253971338272095, bottom=-0.05000000074505806), bake=dict(ao=0.06, grad=0.15, gain=0.52), finish=dict(dust=0.15, dust_row='lichen')),
    dict(id='ca/rift_boulder', gen='boulder', seed=83, cat='prop', zone='rift', ship=True, replaces='kn/rock_largeD',
         fit=dict(r=0.5343884229660034, top=0.5182599425315857, bottom=-0.05000000074505806), bake=dict(ao=0.12, grad=0.2, gain=0.74), finish=dict(dust=0.25, dust_row='lichen')),
    dict(id='ca/rift_rock', gen='rift_rock', seed=89, cat='scatter', zone='rift', ship=True, replaces='kn/rock_largeB',
         fit=dict(r=0.5077307224273682, top=0.38025400042533875, bottom=-0.05000000074505806), bake=dict(ao=0.1, grad=0.18, gain=0.3), finish=dict(dust=0.25, dust_row='lichen')),
    dict(id='ca/rift_rubble', gen='rift_rubble', seed=97, cat='kit', zone='rift', ship=True, replaces='kd/rubble_large',
         fit=dict(r=4.068856716156006, top=3.4960880279541016, bottom=0), bake=dict(ao=0.9, grad=1.0, gain=0.6), finish=dict(dust=0.2, dust_row='lichen')),
    dict(id='ca/rift_slabs', gen='slabs', seed=101, cat='scatter', zone='rift', ship=True, replaces='kd/floor_tile_small_broken_A',
         fit=dict(r=1, top=0.15000001341104507, bottom=0), bake=dict(ao=0.12, grad=0.05, gain=0.3), finish=dict(dust=0.15, dust_row='lichen')),
    # ---- 烬渊深处（第 3 区）：顶替 KayKit / Kenney 布景。石碑 / 晶簇 / 巨石 / 拱 / 柱 / 枯树 / 火坑 / 骷髅 / 石十字复用已有生成器（remap 换成熔渣 + 余烬），
    # 碎墓 / 兽骨架 / 骷髅蜡烛 / 墓室是新生成器。fit 照抄被顶替件 geoInfo 的浮点值；底下悬空（骷髅类）或埋得深（兽骨架，标记 l）的旧件按规矩改成原点在底面，
    # 这几个摆放时不用 y0（兽骨架的 l 抬高变成 0，落地位置一样）。不复用灰烬件的 GLB：它们没按旧件对齐包围盒，直接用会挪动摆放 ----
    dict(id='ca/abyss_arch', gen='arch', seed=61, cat='kit', zone='abyss', ship=True, replaces='kh/arch', args=dict(span=3.0, h=2.8, r=0.5, n=11, whole=True, kw=0.44, kd=1.8, kh=0.8, key_glow=0.6), remap=ABYSS,
         fit=dict(r=2.1092209815979004, top=4.413949012756348, bottom=0), bake=dict(ao=0.8, grad=1.0), finish=dict(dust=0.15)),
    dict(id='ca/abyss_tomb', gen='tomb', seed=103, cat='prop', zone='abyss', ship=True, replaces='kh/grave_A_destroyed', remap=ABYSS,
         fit=dict(r=1.0774000883102417, top=2.1061151027679443, bottom=0), bake=dict(ao=0.4, grad=0.6), finish=dict(dust=0.15)),
    dict(id='ca/abyss_pillar', gen='pillar', seed=19, cat='kit', zone='abyss', ship=True, replaces='kh/pillar', args=dict(h=4.4, r=0.42, broken=0.18, chunks=0), remap=ABYSS,
         fit=dict(r=0.5, top=4.399999618530273, bottom=0), bake=dict(ao=0.6, grad=1.0, gain=0.63), finish=dict(dust=0.15)),
    dict(id='ca/abyss_monolith', gen='monolith', seed=71, cat='prop', zone='abyss', ship=True, replaces='kn/rock_tallA', remap=ABYSS,
         fit=dict(r=0.49153444170951843, top=0.9459258913993835, bottom=-0.05000000074505806), bake=dict(ao=0.12, grad=0.25), finish=dict(dust=0.15)),
    dict(id='ca/abyss_tree', gen='tree', seed=23, cat='prop', zone='abyss', ship=True, replaces='kh/tree_dead_medium', args=dict(h=4.2, r0=0.31, lean=0.2, branches=4, ember=2, spread=1.2), remap=ABYSS,
         fit=dict(r=1.3231620788574219, top=3.888742208480835, bottom=-0.3002431392669678), bake=dict(ao=0.6, grad=0.8), finish=dict(dust=0.15)),
    dict(id='ca/abyss_shards', gen='shards', seed=73, cat='prop', zone='abyss', ship=True, replaces='kn/rock_tallG', remap=ABYSS,
         fit=dict(r=0.24534401297569275, top=0.7329360246658325, bottom=-0.05000000074505806), bake=dict(ao=0.08, grad=0.2), finish=dict(dust=0.15)),
    dict(id='ca/abyss_boulder', gen='boulder', seed=83, cat='prop', zone='abyss', ship=True, replaces='kn/rock_largeF', remap=ABYSS,
         fit=dict(r=0.5477293729782104, top=0.42896199226379395, bottom=-0.05000000074505806), bake=dict(ao=0.12, grad=0.2), finish=dict(dust=0.15)),
    dict(id='ca/abyss_skull_candle', gen='skull_candle', seed=107, cat='prop', zone='abyss', ship=True, replaces='kh/skull_candle', remap=ABYSS,
         fit=dict(r=0.5188949704170227, top=1.2447770833969116, bottom=0), bake=dict(ao=0.25, grad=0.4, grime=0.4, gtint=1.15, wear=0.45), finish=dict(dust=0.15)),
    dict(id='ca/abyss_skull', gen='skull2', seed=5, cat='scatter', zone='abyss', ship=True, replaces='kh/skull', args=dict(R=0.42, tilt=1.3), remap=ABYSS,
         fit=dict(r=0.4587917625904083, top=0.9157134890556335, bottom=0), bake=dict(ao=0.3, grad=0.5, grime=0.4, gtint=1.15, wear=0.45, gain=0.46), finish=dict(dust=0.15)),
    dict(id='ca/abyss_ribs', gen='ribs', seed=109, cat='scatter', zone='abyss', ship=True, replaces='kh/ribcage', remap=ABYSS,
         fit=dict(r=0.42282453179359436, top=0.8582255244255066, bottom=0), bake=dict(ao=0.15, grad=0.2, gtint=0.6, gain=0.63), finish=dict(dust=0.15)),
    dict(id='ca/abyss_marker', gen='grave_cross', seed=13, cat='scatter', zone='abyss', ship=True, replaces='kh/gravemarker_A', remap=ABYSS,
         fit=dict(r=0.43381795287132263, top=1.196102499961853, bottom=0), bake=dict(ao=0.3, grad=0.5), finish=dict(dust=0.15)),
    dict(id='ca/abyss_firepit', gen='firepit', seed=17, cat='prop', zone='abyss', ship=True, replaces='kn/campfire_stones', args=dict(r=0.29), remap=ABYSS,
         fit=dict(r=0.2908634841442108, top=0.027751002460718155, bottom=-0.05000000074505806), bake=dict(ao=0.03, grad=0.03, gtint=0.3, grime=0.12, wear=0.4, gain=0.72), finish=dict(dust=0.15)),
    dict(id='ca/abyss_crypt', gen='crypt', seed=113, cat='kit', zone='abyss', ship=True, replaces='kh/crypt', remap=ABYSS,
         fit=dict(r=4, top=8, bottom=0), bake=dict(ao=1.2, grad=1.5), finish=dict(dust=0.15)),
    # ---- 雷鸣遗迹（第 2 区）：墙段 / 柱子是单位尺寸的件，顶替程序化的 gfx/wall、gfx/pillar（游戏里按每段非等比缩放，摆放不变）；
    # 雷枢顶替程序化的 storm/pylon（玩法件，尺寸逐项照原来的，轮廓和碰撞都不变）；立灯顶替 kh/lantern_standing（fit 照抄 geoInfo） ----
    dict(id='ca/storm_wall', gen='storm_wall', seed=131, cat='kit', zone='storm', ship=True, replaces=None,
         bake=dict(ao=0.12, grad=0.3, wear=0.4), finish=dict(dust=0.12)),
    dict(id='ca/storm_column', gen='storm_column', seed=137, cat='kit', zone='storm', ship=True, replaces=None,
         bake=dict(ao=0.15, grad=0.25), finish=dict(dust=0.12)),
    dict(id='ca/storm_pylon', gen='pylon', seed=139, cat='kit', zone='storm', ship=True, replaces=None,
         bake=dict(ao=0.4, grad=0.8, wear=0.45), finish=dict(dust=0.1), cues=dict(second=False, val=0.2)),
    dict(id='ca/storm_lantern', gen='storm_lantern', seed=149, cat='prop', zone='storm', ship=True, replaces='kh/lantern_standing',
         fit=dict(r=0.32001006603240967, top=0.9251917004585266, bottom=-2.9802322387695312e-08), bake=dict(ao=0.1, grad=0.2), finish=dict(dust=0.05), cues=dict(second=False, val=0.2)),
    # ---- 霜骨沼泽（第 1 区）：这一区摆放表里的 CC0 件都摆不上（四周是水），换的是程序化拼的几何体：巨兽头骨（合并进骨架网格，整组替换，碰撞不变）、
    # 冰芦苇、远处的冰棱簇（布景材质，原 prop/frost）、栈道单位块（高 / 中画质；低画质照旧用程序化方块） ----
    dict(id='ca/frost_skull', gen='frost_skull', seed=151, cat='kit', zone='frost', ship=True, replaces=None, remap={'bone': 'pale', 'grime': 'stone'},  # 骨换成偏冷的灰白（顶点色直接进骨架网格、不再压饱和度）
         bake=dict(ao=0.6, grad=0.8, grime=0.35, gtint=0.9), finish=dict(dust=0.0), cues=dict(second=False, val=0.24, lichen=0)),
    dict(id='ca/frost_reeds', gen='frost_reeds', seed=157, cat='scatter', zone='frost', ship=True, replaces=None,
         bake=dict(ao=0.12, grad=0.5), finish=dict(dust=0.0), cues=dict(second=False, val=0.2)),
    dict(id='ca/frost_spire', gen='frost_spire', seed=163, cat='prop', zone='frost', ship=True, replaces=None,
         bake=dict(ao=0.3, grad=0.6, gain=0.7), finish=dict(dust=0.0), cues=dict(second=False, val=0.2)),
    dict(id='ca/frost_plank', gen='frost_plank', seed=167, cat='kit', zone='frost', ship=True, replaces=None,
         bake=dict(ao=0.08, grad=0.01, wear=0.25, grime=0.1), finish=dict(dust=0.0), cues=dict(second=False, val=0.08, lichen=0)),
    # ---- AI 生成的布景件（ai3d-pilot，试点一件）：gen='ai' 从源 GLB 导入（art/ai/importer.py），参数和来源都在 assets/ai/<slug>/provenance.json。
    # 类别 aiprop（art/budgets.json）：lod=hi 给高 / 中画质（预算 tris），lod=lo 是低画质要显示时的减面档（预算 lodTris，同一张贴图的 UV）；
    # 路标石低画质不显示（摆放一样、visible = false，和冰芦苇一样），所以只打 hi。反照率贴图 512，在 assets/ai/<slug>/，打进 zone-<区> 包（低档不解码）。
    # 顶点色只烘 AO（明暗渐变压到最小、不加磨损 / 污垢：生成的贴图里已经画了）。_vc 是按面量化到调色板的对照版本（不打进游戏） ----
    dict(id='ca/frost_waystone', gen='ai', seed=1126, cat='aiprop', zone='frost', ship=True, replaces=None, args=dict(prov='assets/ai/frost_waystone/provenance.json', lod='hi', mode='albedo'),
         bake=dict(ao=0.25, grad=0.01, wear=0.0, grime=0.0, gtint=0.0), finish=dict(dust=0.0, cues=False)),
    dict(id='ca/frost_waystone_vc', gen='ai', seed=1126, cat='aiprop', zone='frost', ship=False, replaces=None, args=dict(prov='assets/ai/frost_waystone/provenance.json', lod='hi', mode='vc'),
         bake=dict(ao=0.25, grad=0.3, wear=0.3, grime=0.2, gtint=0.5), finish=dict(dust=0.0, cues=False)),
    # ---- 余烛殿：4 个火盆台（玩法件），尺寸逐项照原来的程序化 crown/brazier，火苗另一个网格、碰撞不变 ----
    dict(id='ca/crown_brazier', gen='crown_brazier', seed=173, cat='prop', zone='crown', ship=True, replaces=None,
         bake=dict(ao=0.25, grad=0.4, wear=0.4), finish=dict(dust=0.0), cues=dict(second=False, val=0.2, lichen=0)),
    # ---- 手持武器（class-d2b1）：掌灯人的提灯。坐标约定见 gen.py 的 hand_lantern（+z 沿握杆、-y 往下，原点在握把底端），游戏端换算到右手的武器关节。
    # 打进 kit-gear 包：不在开机或进区时加载，第一次装备 / 掉落提灯时才要（world.js 的 lanternNeed），之前用程序化的简化提灯顶着 ----
    dict(id='ca/gear_lantern', gen='hand_lantern', seed=211, cat='weapon', zone='gear', ship=True, replaces=None, args=dict(tier=0),
         bake=dict(ao=0.04, grad=0.01, wear=0.4, grime=0.2), finish=dict(dust=0.0), cues=dict(second=False, val=0.12, lichen=0)),
    dict(id='ca/gear_lantern_t3', gen='hand_lantern', seed=223, cat='weapon', zone='gear', ship=True, replaces=None, args=dict(tier=2),
         bake=dict(ao=0.04, grad=0.01, wear=0.4, grime=0.25), finish=dict(dust=0.0), cues=dict(second=False, val=0.12, lichen=0)),
    # ---- 首领（boss-design）：带骨架、蒙皮和动作，assets/ca/boss/<kind>.glb；id = ca/boss_<kind>，zone 写 boss，home = 打进哪一区的首领包（js/assets/boss-<kind>.js）。
    # 生成器在 art/ca/boss/<kind>.py（造型 + 骨架 + 软接缝），动作表在 art/ca/boss/<kind>_clips.py ----
    dict(id='ca/boss_golem', gen='golem', seed=181, cat='boss', zone='boss', home='ash', ship=True, replaces=None,
         bake=dict(ao=0.7, grad=0.9, wear=0.4, grime=0.3, gain=1.15), finish=dict(dust=0.12), cues=dict(second=True, val=0.3, lichen=0.1)),
    dict(id='ca/boss_lord', gen='lord', seed=191, cat='boss', zone='boss', home='abyss', ship=True, replaces=None,
         bake=dict(ao=0.6, grad=0.7, wear=0.5, grime=0.2, gain=1.1), finish=dict(dust=0.0), cues=dict(second=False, val=0.22, lichen=0)),
    dict(id='ca/boss_behemoth', gen='behemoth', seed=207, cat='boss', zone='boss', home='rift', ship=True, replaces=None,
         bake=dict(ao=0.6, grad=0.8, wear=0.4, grime=0.25, gain=1.32), finish=dict(dust=0.0), cues=dict(second=False, val=0.24, lichen=0)),
    dict(id='ca/boss_weaver', gen='weaver', seed=229, cat='boss', zone='boss', home='frost', ship=True, replaces=None,
         bake=dict(ao=0.6, grad=0.8, wear=0.4, grime=0.2, gain=1.25), finish=dict(dust=0.0), cues=dict(second=False, val=0.22, lichen=0)),
    dict(id='ca/boss_snuffer', gen='snuffer', seed=229, cat='boss', zone='boss', home='pin', ship=True, replaces=None,
         bake=dict(ao=0.6, grad=0.7, wear=0.35, grime=0.2, gain=1.15), finish=dict(dust=0.0), cues=dict(second=False, val=0.2, lichen=0)),
    dict(id='ca/boss_warden', gen='warden', seed=241, cat='boss', zone='boss', home='storm', ship=True, replaces=None,
         bake=dict(ao=0.6, grad=0.7, wear=0.5, grime=0.2, gain=1.3), finish=dict(dust=0.0), cues=dict(second=False, val=0.22, lichen=0)),
]

# 看板（lineup）：每个生成器 × 几个种子，参数沿用清单里第一个用到它的件
LINEUP_SEEDS = [101, 202, 303]
