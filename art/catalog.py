# 布景件清单：每一项 = 生成器 + 参数 + 种子。改这里、跑 npm run build:art，就会重新生成 assets/ca/ 下的 GLB 和 manifest.json。
# id 规则见 docs/art-style.md：ca/<区>_<物件>[_变体]；文件名 = id 去掉 ca/ 前缀。
# ship = True：打进游戏的素材包（js/assets/kit-<区>.js）；False：只生成 GLB（备选件，摆放那边要用时改成 True）。
# replaces：在本区摆放表里顶替的旧模型（scale 1 时的尺寸、原点和它一致，摆放表的缩放不用改）。
# bake：烘焙参数（ao = AO 采样距离，米；grad = 底部压暗渐变的高度，米；wear / grime = 边缘提亮 / 缝里压暗的强度；gtint = 污垢色偏的浓淡），按件的真实尺寸给。
# cues：材质线索参数（val = 明暗斑块幅度，second = 要不要第二色调，lichen = 灰苔比例），缺省值见 art/ca/core.py 的 material_cues。
CATALOG = [
    # ---- 灰烬地带：顶替现有 KayKit / Kenney 布景（路边小物 skull / bones / blade / marker 是第二版，asset-lib-props2） ----
    dict(id='ca/ash_tree_dead_a', gen='tree', seed=11, cat='prop', zone='ash', ship=True, replaces='kh/tree_dead_large',
         args=dict(h=5.0, r0=0.36, lean=0.1, branches=6, ember=2)),
    dict(id='ca/ash_tree_dead_b', gen='tree', seed=23, cat='prop', zone='ash', ship=True, replaces='kh/tree_dead_medium',
         args=dict(h=4.2, r0=0.31, lean=0.2, branches=4, ember=2, spread=1.2)),
    dict(id='ca/ash_tree_dead_c', gen='tree', seed=37, cat='prop', zone='ash', ship=True, replaces='kh/tree_dead_small',
         args=dict(h=4.6, r0=0.34, lean=0.16, branches=3, snag=True, ember=1)),
    dict(id='ca/ash_skull', gen='skull2', seed=5, cat='scatter', zone='ash', ship=True, replaces='kh/skull',
         args=dict(R=0.55), bake=dict(ao=0.35, grad=0.45, grime=0.25, gtint=0.6, wear=0.4), cues=dict(second=False, val=0.2)),
    dict(id='ca/ash_bones', gen='bone', seed=3, cat='scatter', zone='ash', ship=True, replaces='kh/bone_A',
         args=dict(L=0.74, r=0.085), bake=dict(ao=0.1, grad=0.1, gtint=0.5), cues=dict(second=False, val=0.2)),
    dict(id='ca/ash_blade', gen='shield_sword', seed=7, cat='scatter', zone='ash', ship=True, replaces='kd/sword_shield_broken',
         args=dict(R=0.4, h=1.15), bake=dict(ao=0.3, grad=0.4)),
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
]

# 看板（lineup）：每个生成器 × 几个种子，参数沿用清单里第一个用到它的件
LINEUP_SEEDS = [101, 202, 303]
