# 烬渊之主的动作表（游戏的关节通道写法，见 art/ca/rig.py 顶上的约定）。
# 转角符号（游戏坐标，y 上、z 前）：rx > 0 = 往前俯 / 竖着的骨骼朝前倒，垂着的手臂 rx < 0 = 往前抬；ry > 0 = 左肩往后、右肩往前；
# 垂着的左臂 rz > 0 = 往外侧张开，右臂反过来。大腿 rx < 0 = 往前迈，小腿 rx > 0 = 屈膝。
# 刃翼（左）：ry < 0 = 从背后往身侧张开，rz > 0 = 往上扬；右翼由镜像补全。
# 时序照 design-note §4（招式蓄力 − 出手提前量 = 蓄力动作的长度，出手动作的 k0 就是接触帧），招式（模拟里的时序）一点不改：
#   砸地 0.95 s 结算；扇形 0.40 / 0.75 / 1.10 s 三次出手；螺旋 0.25 s 起、持续 1.8 s；十字 0.90 / 1.50 s 两刀；
#   轰炸 0.30 s 起、持续 1.1 s；召唤 0.50 s。
from ..rig import mirror_keys


def _k0(ticks, dur):
    """出手提前量取整到 1/60 s（模拟按 60 帧推进：G.after 在整帧上触发，提前量是整帧时接触帧正好落在预警结算的那一帧）"""
    return ticks / 60 / dur


K_SLAM, K_FAN, K_SPIRAL, K_CROSS, K_BAR, K_SUM = _k0(9, 0.65), _k0(7, 0.40), _k0(7, 1.90), _k0(9, 0.60), _k0(7, 1.20), _k0(10, 0.75)


def _m(keys):
    """左右对称地补全：只写了 _l 的通道补上镜像的 _r（已经写了的不动）"""
    out = dict(keys)
    for k, v in mirror_keys({k: v for k, v in keys.items() if '_l.' in k or '_l_' in k}).items():
        out.setdefault(k, v)
    return out


def _sym(d):
    """一个姿势里只写了左边的通道，补上右边的镜像（用在双翼这种左右一起动的部位）"""
    out = dict(d)
    for k, v in d.items():
        if '_l.' in k or '_l_' in k:
            mk = list(mirror_keys({k: [0, v]}).items())[0]
            out.setdefault(mk[0], mk[1][1])
    return out


# 平时的姿态（idle 的中值；别的动作从这里出发、回到这里）：右手拖剑，剑尖斜指身前的地面；左臂垂着微微张开；双翼收拢
REST = {
    'upperarm_l.rz': 0.1, 'upperarm_l.rx': -0.08, 'lowerarm_l.rx': -0.22,
    'upperarm_r.rz': -0.06, 'upperarm_r.rx': -0.04, 'lowerarm_r.rx': -0.1, 'hand_r.rx': 0.153, 'hand_r.rz': 0.083,
    'thigh_l.rx': -0.04, 'calf_l.rx': 0.08, 'thigh_r.rx': 0.02, 'calf_r.rx': 0.08,
    'thigh_l.rz': 0.03, 'thigh_r.rz': -0.03,
}


def _from_rest(pose):
    """姿势表里没写的通道按平时的值"""
    out = dict(REST)
    out.update(pose)
    return out


def _hang(p):
    """披风往下垂：上身往前俯 / 往后仰时，披风根部（x_cape_01）反着转回去大半，姿势里原来写的摆动只留一点（不然俯身砸地时披风会翻到头顶上）"""
    q = dict(p)
    pitch = sum(p.get(c, 0.0) for c in ('pelvis.rx', 'spine_01.rx', 'spine_02.rx', 'spine_03.rx'))
    q['x_cape_01.rx'] = round(-0.85 * pitch + 0.3 * p.get('x_cape_01.rx', 0.0), 4)
    return q


def _clip(spec, poses, extra_keys=None):
    """poses = [(k, 姿势 dict), ...]：每个通道在所有姿势里插值（姿势里没写的通道 = 0），k 写成负数 = 加速冲到这一帧；披风按 _hang 往下垂"""
    poses = [(k, _hang(p)) for k, p in poses]
    chans = set()
    for _, p in poses:
        chans |= set(p)
    keys = {}
    for c in sorted(chans):
        K = []
        for k, p in poses:
            K += [k, p.get(c, 0.0)]
        keys[c] = K
    if extra_keys:
        keys.update(extra_keys)
    spec['keys'] = keys
    return spec


W_FOLD = {}  # 收拢：就是绑定姿态
W_HALF = _sym({'x_wing_l_01.ry': -0.45, 'x_wing_l_01.rz': 0.22, 'x_wing_l_02.rz': 0.18})
W_OPEN = _sym({'x_wing_l_01.ry': -0.95, 'x_wing_l_01.rz': 0.5, 'x_wing_l_02.rz': 0.4, 'x_wing_l_02.ry': -0.2})
W_HIGH = _sym({'x_wing_l_01.ry': -0.85, 'x_wing_l_01.rz': 0.95, 'x_wing_l_02.rz': 0.55, 'x_wing_l_02.ry': -0.15})
W_DOWN = _sym({'x_wing_l_01.ry': -0.8, 'x_wing_l_01.rz': -0.25, 'x_wing_l_02.rz': -0.2})


def _w(*ds):
    out = {}
    for d in ds:
        out.update(d)
    return out


IDLE = {
    'dur': 2.8, 'loop': True, 'fade': 0.25,
    'keys': _m({
        # 呼吸：胸口起伏、肩跟着沉一下；头慢慢左右看；双翼微微一开一合；披风轻轻摆
        'spine_02.rx': [0, 0.02, 0.5, -0.02, 1, 0.02],
        'spine_03.rx': [0, 0.015, 0.5, -0.025, 1, 0.015],
        'neck_01.ry': [0, 0.08, 0.5, -0.1, 1, 0.08],
        'head.rx': [0, 0.03, 0.5, -0.01, 1, 0.03],
        'upperarm_l.rx': [0, -0.08, 0.5, -0.03, 1, -0.08], 'upperarm_l.rz': [0, 0.1, 0.5, 0.13, 1, 0.1],
        'lowerarm_l.rx': [0, -0.22, 0.5, -0.3, 1, -0.22],
        'upperarm_r.rx': [0, -0.04, 1, -0.04], 'upperarm_r.rz': [0, -0.06, 1, -0.06], 'lowerarm_r.rx': [0, -0.1, 1, -0.1],
        # 剑尖贴着地面留 0.1 m（呼吸时胸口一起一伏会带着剑尖上下，手腕反着补；fk 解的，见 ~/dev/boss-lord-tools/fk.mjs solveclip）
        'hand_r.rx': [0, 0.103, 0.125, 0.117, 0.25, 0.147, 0.375, 0.178, 0.5, 0.192, 0.625, 0.178, 0.75, 0.147, 0.875, 0.117, 1, 0.103], 'hand_r.rz': [0, 0.083, 1, 0.083],
        'x_wing_l_01.ry': [0, 0.0, 0.5, -0.06, 1, 0.0], 'x_wing_l_01.rz': [0, 0.0, 0.5, 0.04, 1, 0.0],
        'x_wing_l_02.rz': [0, 0.0, 0.5, 0.05, 1, 0.0],
        'x_cape_02.rx': [0, 0.02, 0.5, -0.02, 1, 0.02], 'x_cape_03.rx': [0, 0.03, 0.5, -0.03, 1, 0.03],
        'x_tab.rx': [0, 0.0, 0.5, -0.02, 1, 0.0],
        'pelvis.oy': [0, 0.0, 0.5, -0.02, 1, 0.0],
        'thigh_l.rx': [0, -0.04, 1, -0.04], 'calf_l.rx': [0, 0.08, 0.5, 0.1, 1, 0.08], 'thigh_l.rz': [0, 0.03, 1, 0.03],
        'thigh_r.rx': [0, 0.02, 1, 0.02], 'calf_r.rx': [0, 0.08, 0.5, 0.1, 1, 0.08], 'thigh_r.rz': [0, -0.03, 1, -0.03],
    }),
}

# 走：一个周期两步，k = 0 左脚在前刚落地；沉重的步子，胯左右晃、上身反着拧，左臂摆；右手拖着剑不摆（剑尖贴地滑），双翼收着、随步子颠一下
WALK = {
    'dur': 1.1, 'loop': True, 'fade': 0.2, 'extra': {'cycle': 2.4},
    'keys': {
        'thigh_l.rx': [0, -0.4, 0.25, -0.04, 0.5, 0.34, 0.75, 0.0, 1, -0.4],
        'calf_l.rx': [0, 0.1, 0.12, 0.26, 0.25, 0.14, 0.5, 0.18, 0.72, 0.8, 1, 0.1],
        'foot_l.rx': [0, 0.1, 0.25, 0.0, 0.5, -0.22, 0.75, -0.08, 1, 0.1],
        'thigh_r.rx': [0, 0.34, 0.25, 0.0, 0.5, -0.4, 0.75, -0.04, 1, 0.34],
        'calf_r.rx': [0, 0.18, 0.22, 0.8, 0.5, 0.1, 0.62, 0.26, 0.75, 0.14, 1, 0.18],
        'foot_r.rx': [0, -0.22, 0.25, -0.08, 0.5, 0.1, 0.75, 0.0, 1, -0.22],
        'pelvis.oy': [0, -0.02, 0.1, -0.07, 0.3, 0.02, 0.5, -0.02, 0.6, -0.07, 0.8, 0.02, 1, -0.02],
        'pelvis.rz': [0, 0.04, 0.5, -0.04, 1, 0.04],
        'pelvis.ry': [0, 0.08, 0.5, -0.08, 1, 0.08],
        'spine_02.ry': [0, -0.1, 0.5, 0.1, 1, -0.1],
        'spine_02.rx': [0, 0.06, 0.1, 0.08, 0.5, 0.06, 0.6, 0.08, 1, 0.06],
        'head.rx': [0, -0.03, 1, -0.03],
        'upperarm_l.rx': [0, 0.3, 0.5, -0.32, 1, 0.3], 'upperarm_l.rz': [0, 0.1, 1, 0.1],
        'lowerarm_l.rx': [0, -0.15, 0.5, -0.42, 1, -0.15],
        'upperarm_r.rx': [0, 0.0, 0.5, -0.06, 1, 0.0], 'upperarm_r.rz': [0, -0.07, 1, -0.07], 'lowerarm_r.rx': [0, -0.08, 1, -0.08],
        'hand_r.rx': [0, -0.075, 0.1, -0.037, 0.2, 0.018, 0.3, 0.067, 0.4, 0.077, 0.5, 0.046, 0.6, 0.057, 0.7, 0.054, 0.8, 0.031, 0.9, -0.02, 1, -0.075],  # 剑尖拖地留 0.1 m（骨盆随步子起落，手腕补）
        'hand_r.rz': [0, 0.083, 1, 0.083],
        'x_wing_l_01.rz': [0, 0.0, 0.1, -0.04, 0.3, 0.02, 0.5, 0.0, 0.6, -0.04, 0.8, 0.02, 1, 0.0],
        'x_wing_r_01.rz': [0, 0.0, 0.1, 0.04, 0.3, -0.02, 0.5, 0.0, 0.6, 0.04, 0.8, -0.02, 1, 0.0],
        'x_cape_01.rx': [0, 0.06, 1, 0.06], 'x_cape_02.rx': [0, 0.1, 0.5, 0.06, 1, 0.1], 'x_cape_03.rx': [0, 0.12, 0.5, 0.05, 1, 0.12],
        'x_tab.rx': [0, -0.08, 0.25, -0.16, 0.5, -0.08, 0.75, -0.16, 1, -0.08],
    },
}

# ---------------------------------------------------------------- 砸地：蓄力 0.81 s（双手握剑举过头顶、双翼猛地张开、往前上一步），
# 出手 0.65 s，k0 0.22（剑刃劈进地里 = 预警圈结算），之后单膝前压、双翼收回
SLAM_UP = _from_rest(_w(W_OPEN, {
    'pelvis.oz': -0.1, 'pelvis.rx': -0.04, 'spine_02.rx': -0.18, 'spine_03.rx': -0.12, 'head.rx': 0.18,
    'upperarm_r.rx': -2.85, 'upperarm_r.rz': 0.25, 'lowerarm_r.rx': -0.55, 'hand_r.rx': 0.1,
    'upperarm_l.rx': -2.85, 'upperarm_l.rz': -0.28, 'lowerarm_l.rx': -0.85, 'hand_l.rx': 0.0,
    'thigh_l.rx': -0.45, 'calf_l.rx': 0.4, 'foot_l.rx': 0.08, 'thigh_r.rx': 0.22, 'calf_r.rx': 0.32, 'foot_r.rx': -0.18,
    'x_cape_02.rx': -0.1, 'x_cape_03.rx': -0.06,
}))
SLAM_UP.update({'upperarm_r.rx': -2.477, 'upperarm_r.ry': 0.103, 'upperarm_r.rz': 0.709, 'lowerarm_r.rx': -0.572, 'hand_r.rx': 0.534, 'hand_r.rz': -0.7, 'upperarm_l.rx': -2.204, 'upperarm_l.ry': -0.455, 'upperarm_l.rz': -0.68, 'lowerarm_l.rx': -1.063})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
SLAM_HIT = _from_rest(_w(W_HALF, {
    'pelvis.oz': 0.3, 'pelvis.rx': 0.12, 'pelvis.oy': -0.1, 'spine_02.rx': 0.42, 'spine_03.rx': 0.2, 'head.rx': -0.42,
    'upperarm_r.rx': -1.2, 'upperarm_r.rz': 0.2, 'lowerarm_r.rx': -0.2, 'hand_r.rx': 0.45,
    'upperarm_l.rx': -1.2, 'upperarm_l.rz': -0.32, 'lowerarm_l.rx': -0.45, 'hand_l.rx': 0.2,
    'thigh_l.rx': -1.25, 'calf_l.rx': 1.35, 'foot_l.rx': -0.1, 'thigh_r.rx': 0.25, 'calf_r.rx': 0.95, 'foot_r.rx': -0.35,
    'x_cape_01.rx': 0.3, 'x_cape_02.rx': 0.25, 'x_cape_03.rx': 0.15, 'x_tab.rx': -0.35,
}))
SLAM_HIT.update({'upperarm_r.rx': -1.272, 'upperarm_r.ry': -0.009, 'upperarm_r.rz': 0.466, 'lowerarm_r.rx': -0.153, 'hand_r.rx': 0.651, 'hand_r.rz': -0.5, 'upperarm_l.rx': -1.112, 'upperarm_l.ry': -0.069, 'upperarm_l.rz': -0.72, 'lowerarm_l.rx': -0.294})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
SLAM_MID = _from_rest(_w(W_HALF, {
    'pelvis.oz': -0.04, 'spine_02.rx': -0.06, 'upperarm_r.rx': -1.6, 'upperarm_r.rz': 0.05, 'lowerarm_r.rx': -0.9,
    'upperarm_l.rx': -1.5, 'upperarm_l.rz': -0.1, 'lowerarm_l.rx': -1.1, 'thigh_l.rx': -0.25, 'calf_l.rx': 0.2,
}))
SLAM_W = _clip({'dur': 0.95 - 0.15, 'hold': True, 'fade': 0.12, 'steady': True}, [(0, REST), (0.45, SLAM_MID), (0.86, {k: v * 1.02 for k, v in SLAM_UP.items()}), (1, SLAM_UP)])
SLAM_SQ = dict(SLAM_HIT, **{'calf_r.rx': 1.05, 'head.rx': -0.52, 'x_cape_02.rx': 0.32})  # 接触后震一下：后膝、头、披风（剑钉在地上不动）
SLAM = _clip({'dur': 0.65, 'k0': K_SLAM, 'fade': 0.03, 'out': 0.35, 'steady': True},
             [(0, SLAM_UP), (-K_SLAM, SLAM_HIT), (0.3, SLAM_SQ), (0.58, SLAM_HIT), (0.82, {k: v * 0.4 + REST.get(k, 0) * 0.6 for k, v in SLAM_HIT.items()}), (1, REST)])

# ---------------------------------------------------------------- 扇形：蓄力 0.28 s（左手往后收到肩上、掌心蓄火，剑放低不动），
# 出手 0.40 s，k0 0.30（左手往前甩开 = 三发火弹离手），收回到蓄力的姿势（连出三次首尾相接）
FAN_BACK = _from_rest({
    'spine_02.ry': 0.32, 'spine_03.ry': 0.18, 'neck_01.ry': -0.32, 'head.ry': -0.12,
    'upperarm_l.rx': 0.3, 'upperarm_l.rz': 1.05, 'lowerarm_l.rx': -1.55, 'hand_l.rx': -0.3,
    'upperarm_r.rx': 0.06, 'lowerarm_r.rx': -0.12,
    'thigh_l.rx': -0.18, 'calf_l.rx': 0.2, 'thigh_r.rx': 0.12, 'calf_r.rx': 0.18,
    'x_wing_l_01.ry': -0.2, 'x_wing_l_01.rz': 0.1,
})
FAN_BACK.update({'hand_r.rx': 0.027, 'hand_r.rz': 0.194})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
FAN_OUT = _from_rest({
    'spine_02.ry': -0.26, 'spine_03.ry': -0.16, 'spine_02.rx': 0.08, 'neck_01.ry': 0.2, 'head.ry': 0.06,
    'upperarm_l.rx': -1.5, 'upperarm_l.rz': 0.2, 'lowerarm_l.rx': -0.1, 'hand_l.rx': -0.55,
    'upperarm_r.rx': 0.1, 'lowerarm_r.rx': -0.12,
    'thigh_l.rx': -0.32, 'calf_l.rx': 0.3, 'thigh_r.rx': 0.16, 'calf_r.rx': 0.2,
    'x_wing_l_01.ry': -0.3, 'x_wing_l_01.rz': 0.14,
})
FAN_OUT.update({'hand_r.rx': 0, 'hand_r.rz': -0.142})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
FAN_W = _clip({'dur': 0.40 - 7 / 60, 'hold': True, 'fade': 0.08, 'steady': True}, [(0, REST), (1, FAN_BACK)])
FAN = _clip({'dur': 0.40, 'k0': K_FAN, 'fade': 0.03, 'out': 0.2, 'steady': True}, [(0, FAN_BACK), (-K_FAN, FAN_OUT), (0.55, FAN_OUT), (1, FAN_BACK)])

# ---------------------------------------------------------------- 螺旋：蓄力 0.14 s（剑往身前一插），出手 1.90 s，k0 0.06（左手举起、冠环开始转 = 第一发），
# 之后一直撑着（身子跟着慢慢转一点），最后收回
SPIRAL_PLANT = _from_rest(_w(W_HALF, {
    'spine_02.rx': 0.12, 'head.rx': -0.08,
    'upperarm_r.rx': -0.55, 'upperarm_r.rz': 0.12, 'lowerarm_r.rx': -0.35, 'hand_r.rx': 0.25,
    'upperarm_l.rx': -0.3, 'upperarm_l.rz': 0.3, 'lowerarm_l.rx': -0.6,
    'thigh_l.rx': -0.2, 'calf_l.rx': 0.22, 'thigh_r.rx': 0.1, 'calf_r.rx': 0.2,
}))
SPIRAL_PLANT.update({'upperarm_r.rx': -0.638, 'upperarm_r.ry': 0.223, 'upperarm_r.rz': 0.214, 'lowerarm_r.rx': -0.006, 'hand_r.rx': 0.619, 'hand_r.rz': -0.183})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
SPIRAL_UP = _from_rest(_w(W_OPEN, {
    'spine_02.rx': -0.1, 'spine_03.rx': -0.08, 'head.rx': 0.28,
    'upperarm_r.rx': -0.55, 'upperarm_r.rz': 0.12, 'lowerarm_r.rx': -0.35, 'hand_r.rx': 0.25,
    'upperarm_l.rx': -2.9, 'upperarm_l.rz': 0.25, 'lowerarm_l.rx': -0.2, 'hand_l.rx': -0.3,
    'thigh_l.rx': -0.2, 'calf_l.rx': 0.22, 'thigh_r.rx': 0.1, 'calf_r.rx': 0.2,
    'x_cape_02.rx': -0.12, 'x_cape_03.rx': -0.1,
}))
SPIRAL_UP.update({'upperarm_r.rx': -0.381, 'upperarm_r.ry': 0, 'upperarm_r.rz': 0.208, 'lowerarm_r.rx': 0, 'hand_r.rx': 0.625, 'hand_r.rz': -0.125})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
SPIRAL_W = _clip({'dur': 0.25 - 7 / 60, 'hold': True, 'fade': 0.06, 'steady': True}, [(0, REST), (1, SPIRAL_PLANT)])
SPIRAL = _clip({'dur': 1.90, 'k0': K_SPIRAL, 'fade': 0.04, 'out': 0.4, 'steady': True},
               [(0, SPIRAL_PLANT), (-K_SPIRAL, SPIRAL_UP), (0.5, dict(SPIRAL_UP, **{'spine_02.ry': 0.12, 'spine_03.ry': 0.08})), (0.9, dict(SPIRAL_UP, **{'spine_02.ry': -0.04})), (1, SPIRAL_PLANT)])

# ---------------------------------------------------------------- 十字：蓄力 0.75 s（双手把剑举到右肩上方、剑尖朝后上），出手 0.60 s，k0 0.25（斜劈到左下 = 第一道光），
# 之后从外侧兜回右肩上方（首尾同一个姿势，第二刀接得上）
CROSS_UP = _from_rest(_w(W_HALF, {
    'pelvis.ry': -0.2, 'spine_02.ry': -0.35, 'spine_03.ry': -0.15, 'spine_02.rx': -0.1, 'neck_01.ry': 0.3,
    'upperarm_r.rx': -2.3, 'upperarm_r.rz': -0.55, 'lowerarm_r.rx': -1.0, 'hand_r.rx': 0.2,
    'upperarm_l.rx': -2.0, 'upperarm_l.rz': -0.65, 'lowerarm_l.rx': -1.2,
    'thigh_l.rx': -0.35, 'calf_l.rx': 0.35, 'thigh_r.rx': 0.2, 'calf_r.rx': 0.3,
}))
CROSS_UP.update({'upperarm_r.rx': -1.894, 'upperarm_r.ry': -0.163, 'upperarm_r.rz': 0.494, 'lowerarm_r.rx': -0.694, 'hand_r.rx': 0.062, 'hand_r.rz': -0.618, 'upperarm_l.rx': -2.288, 'upperarm_l.ry': -0.219, 'upperarm_l.rz': -0.825, 'lowerarm_l.rx': -0.144})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
CROSS_HIT = _from_rest(_w(W_OPEN, {
    'pelvis.ry': 0.22, 'spine_02.ry': 0.4, 'spine_03.ry': 0.15, 'spine_02.rx': 0.32, 'neck_01.ry': -0.28, 'head.rx': -0.25,
    'upperarm_r.rx': -1.0, 'upperarm_r.rz': 0.65, 'lowerarm_r.rx': -0.2, 'hand_r.rx': 0.35,
    'upperarm_l.rx': -0.8, 'upperarm_l.rz': 0.25, 'lowerarm_l.rx': -0.55,
    'thigh_l.rx': -0.6, 'calf_l.rx': 0.65, 'thigh_r.rx': 0.25, 'calf_r.rx': 0.55,
}))
CROSS_HIT.update({'upperarm_r.rx': -0.803, 'upperarm_r.ry': -0.295, 'upperarm_r.rz': 0.178, 'lowerarm_r.rx': 0, 'hand_r.rx': 0.385, 'hand_r.rz': -0.112, 'upperarm_l.rx': -1.273, 'upperarm_l.ry': -0.587, 'upperarm_l.rz': -0.95, 'lowerarm_l.rx': 0})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
CROSS_LOOP = _from_rest(_w(W_HALF, {
    'pelvis.ry': 0.05, 'spine_02.ry': 0.05, 'spine_02.rx': 0.05,
    'upperarm_r.rx': -1.6, 'upperarm_r.rz': -0.9, 'lowerarm_r.rx': -0.7,
    'upperarm_l.rx': -1.3, 'upperarm_l.rz': -0.6, 'lowerarm_l.rx': -1.0,
    'thigh_l.rx': -0.45, 'calf_l.rx': 0.45, 'thigh_r.rx': 0.22, 'calf_r.rx': 0.4,
}))
CROSS_LOOP.update({'upperarm_r.rx': -1.439, 'upperarm_r.ry': -0.345, 'upperarm_r.rz': -0.573, 'lowerarm_r.rx': -0.936, 'hand_r.rx': -0.28, 'hand_r.rz': -0.327, 'upperarm_l.rx': -2.278, 'upperarm_l.ry': -0.228, 'upperarm_l.rz': -1.4, 'lowerarm_l.rx': 0})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
CROSS_W = _clip({'dur': 0.75, 'hold': True, 'fade': 0.12, 'steady': True}, [(0, REST), (0.5, {k: v * 0.6 + REST.get(k, 0) * 0.4 for k, v in CROSS_UP.items()}), (1, CROSS_UP)])
CROSS = _clip({'dur': 0.60, 'k0': K_CROSS, 'fade': 0.03, 'out': 0.3, 'steady': True}, [(0, CROSS_UP), (-K_CROSS, CROSS_HIT), (0.45, CROSS_HIT), (0.75, CROSS_LOOP), (1, CROSS_UP)])

# ---------------------------------------------------------------- 轰炸：蓄力 0.18 s（双翼往下压、剑往上提），出手 1.20 s，k0 0.10（双翼猛地往上一扇、剑举向天 = 第一颗陨火落下），
# 之后撑着（双翼慢慢扇），最后收回
BAR_LOW = _from_rest(_w(W_DOWN, {
    'spine_02.rx': 0.15, 'head.rx': -0.1, 'pelvis.oy': -0.08,
    'upperarm_r.rx': -1.0, 'upperarm_r.rz': -0.2, 'lowerarm_r.rx': -1.0, 'hand_r.rx': -0.3,
    'upperarm_l.rx': -0.2, 'upperarm_l.rz': 0.5, 'lowerarm_l.rx': -0.5,
    'thigh_l.rx': -0.3, 'calf_l.rx': 0.5, 'thigh_r.rx': -0.1, 'calf_r.rx': 0.45,
}))
BAR_LOW.update({'upperarm_r.rx': -0.319, 'upperarm_r.ry': -0.049, 'upperarm_r.rz': 0.136, 'lowerarm_r.rx': -1.603, 'hand_r.rx': -0.397, 'hand_r.rz': 0.308})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
BAR_UP = _from_rest(_w(W_HIGH, {
    'spine_02.rx': -0.15, 'spine_03.rx': -0.08, 'head.rx': 0.3, 'pelvis.oy': 0.04,
    'upperarm_r.rx': -2.9, 'upperarm_r.rz': -0.1, 'lowerarm_r.rx': -0.15, 'hand_r.rx': -0.9,
    'upperarm_l.rx': -0.4, 'upperarm_l.rz': 1.0, 'lowerarm_l.rx': -0.3,
    'thigh_l.rx': -0.15, 'calf_l.rx': 0.12, 'thigh_r.rx': 0.05, 'calf_r.rx': 0.12,
    'x_cape_02.rx': -0.18, 'x_cape_03.rx': -0.15,
}))
BAR_UP.update({'upperarm_r.rx': -2.532, 'upperarm_r.ry': 0.005, 'upperarm_r.rz': 0.095, 'lowerarm_r.rx': 0, 'hand_r.rx': 0.25, 'hand_r.rz': 0.042})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
BAR_W = _clip({'dur': 0.30 - 7 / 60, 'hold': True, 'fade': 0.06, 'steady': True}, [(0, REST), (1, BAR_LOW)])
BAR = _clip({'dur': 1.20, 'k0': K_BAR, 'fade': 0.04, 'out': 0.4, 'steady': True},
            [(0, BAR_LOW), (-K_BAR, BAR_UP), (0.35, dict(BAR_UP, **_sym({'x_wing_l_01.rz': 0.7}))), (0.6, BAR_UP), (0.85, dict(BAR_UP, **_sym({'x_wing_l_01.rz': 0.75}))), (1, REST)])

# ---------------------------------------------------------------- 召唤：蓄力 0.33 s（双手反握剑柄举起），出手 0.75 s，k0 0.22（剑插进地里 = 烬奴现身），
# 左手从地上往上一提，剑留在地里到最后才拔出来
SUM_UP = _from_rest(_w(W_HALF, {
    'spine_02.rx': -0.1, 'head.rx': 0.15,
    'upperarm_r.rx': -1.9, 'upperarm_r.rz': 0.2, 'lowerarm_r.rx': -1.1, 'hand_r.rx': -1.1,
    'upperarm_l.rx': -1.2, 'upperarm_l.rz': 0.1, 'lowerarm_l.rx': -0.9,
    'thigh_l.rx': -0.3, 'calf_l.rx': 0.3,
}))
SUM_UP.update({'upperarm_r.rx': -0.719, 'upperarm_r.ry': -1, 'upperarm_r.rz': 1.4, 'lowerarm_r.rx': -0.106, 'hand_r.rx': 0.325, 'hand_r.rz': -0.7})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
SUM_HIT = _from_rest(_w(W_OPEN, {
    'pelvis.oy': -0.25, 'pelvis.rx': 0.1, 'spine_02.rx': 0.35, 'spine_03.rx': 0.12, 'head.rx': -0.3,
    'upperarm_r.rx': -0.75, 'upperarm_r.rz': 0.3, 'lowerarm_r.rx': -0.55, 'hand_r.rx': 0.3,
    'upperarm_l.rx': 0.2, 'upperarm_l.rz': 0.45, 'lowerarm_l.rx': -0.2,
    'thigh_l.rx': -1.0, 'calf_l.rx': 1.3, 'thigh_r.rx': 0.2, 'calf_r.rx': 1.0, 'foot_r.rx': -0.3,
}))
SUM_HIT.update({'upperarm_r.rx': -1.076, 'upperarm_r.ry': -0.525, 'upperarm_r.rz': 0.383, 'lowerarm_r.rx': 0, 'hand_r.rx': 0.744, 'hand_r.rz': -0.364})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
SUM_PULL = _from_rest(_w(W_OPEN, {
    'pelvis.oy': -0.16, 'pelvis.rx': 0.05, 'spine_02.rx': 0.1, 'head.rx': 0.2,
    'upperarm_r.rx': -0.75, 'upperarm_r.rz': 0.3, 'lowerarm_r.rx': -0.55, 'hand_r.rx': 0.3,
    'upperarm_l.rx': -1.8, 'upperarm_l.rz': 0.8, 'lowerarm_l.rx': -0.9, 'hand_l.rx': -0.4,
    'thigh_l.rx': -0.8, 'calf_l.rx': 1.0, 'thigh_r.rx': 0.2, 'calf_r.rx': 0.8,
}))
SUM_PULL.update({'upperarm_r.rx': -0.649, 'upperarm_r.ry': -0.54, 'upperarm_r.rz': 0.328, 'lowerarm_r.rx': -0.036, 'hand_r.rx': 0.712, 'hand_r.rz': -0.198})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
SUM_W = _clip({'dur': 0.50 - 10 / 60, 'hold': True, 'fade': 0.08, 'steady': True}, [(0, REST), (1, SUM_UP)])
SUMMON = _clip({'dur': 0.75, 'k0': K_SUM, 'fade': 0.03, 'out': 0.35, 'steady': True}, [(0, SUM_UP), (-K_SUM, SUM_HIT), (0.32, SUM_HIT), (0.6, SUM_PULL), (0.82, SUM_PULL), (1, REST)])

# ---------------------------------------------------------------- 破防：0.5 s 垮下来单膝跪地、拄着剑，双翼垂下；之后 2 s 一个循环（loopFrom = 0.2）
KNEEL = _from_rest(_w(W_DOWN, {
    'pelvis.rx': 0.12, 'pelvis.oy': -0.3, 'spine_02.rx': 0.32, 'spine_03.rx': 0.12, 'head.rx': 0.4,
    'thigh_l.rx': -1.35, 'calf_l.rx': 1.45, 'foot_l.rx': -0.1, 'thigh_r.rx': 0.2, 'calf_r.rx': 1.55, 'foot_r.rx': 0.45,
    'upperarm_r.rx': -0.85, 'upperarm_r.rz': 0.15, 'lowerarm_r.rx': -0.6, 'hand_r.rx': -0.5,
    'upperarm_l.rx': 0.15, 'upperarm_l.rz': 0.3, 'lowerarm_l.rx': -0.5,
    'x_cape_01.rx': 0.2, 'x_cape_02.rx': 0.2, 'x_crown.oy': -0.35,
}))
KNEEL.update({'upperarm_r.rx': -0.825, 'upperarm_r.ry': -0.888, 'upperarm_r.rz': 0.462, 'lowerarm_r.rx': -0.013, 'hand_r.rx': 0.325, 'hand_r.rz': -0.188})  # 手臂按剑尖 / 握把 / 左手的目标位置用 fk 解出来（~/dev/boss-lord-tools/solve*.sh）
BROKEN = {'dur': 2.5, 'loop': True, 'loopFrom': 0.2, 'fade': 0.15, 'out': 0.45, 'keys': {}}


def _broken():
    wob = {'spine_02.rx': 0.05, 'head.rx': 0.06, 'spine_02.rz': 0.04, 'head.rz': 0.12, 'upperarm_l.rx': 0.08, 'x_wing_l_01.rz': 0.06, 'x_wing_r_01.rz': -0.06}
    for k in sorted(set(KNEEL) | set(wob)):
        v = KNEEL.get(k, 0)
        w = wob.get(k, 0)
        r = REST.get(k, 0)
        BROKEN['keys'][k] = [0, r, -0.12, r + (v - r) * 1.06, 0.2, v, 0.4, v + w, 0.6, v, 0.8, v - w, 1, v]


_broken()

# ---- 受击（叠加，只动上身）：第一帧是 0，游戏端按相对第一帧的变化量叠上去 ----
HIT = {
    'dur': 0.35, 'fade': 0.02,
    'keys': {
        'spine_02.rx': [0, 0.0, 0.12, -0.14, 1, 0.0], 'spine_03.rx': [0, 0.0, 0.18, -0.09, 1, 0.0],
        'head.rx': [0, 0.0, 0.2, -0.2, 1, 0.0], 'neck_01.rz': [0, 0.0, 0.2, 0.08, 1, 0.0],
        'upperarm_l.rz': [0, 0.0, 0.15, 0.15, 1, 0.0],
        'x_wing_l_01.rz': [0, 0.0, 0.15, 0.12, 1, 0.0], 'x_wing_r_01.rz': [0, 0.0, 0.15, -0.12, 1, 0.0],
    },
}

# ---- 狂暴（持续的姿态偏移，按 ent.mood 叠上去）：双翼一直半张着、上身微俯、冠往上浮一点 ----
MOOD = {
    'dur': 0.5, 'hold': True,
    'keys': {k: [0, v, 1, v] for k, v in dict(W_HALF, **{'spine_02.rx': 0.05, 'head.rx': -0.06, 'x_crown.oy': 0.08}).items()},
}

# ---- 死亡 1.7 s（定格），对着 vfx3 的三段崩开：0 s 第一道裂口（往后一仰、剑脱手）、0.45 s 第二道（双膝一软跪下）、0.90 s 往前扑倒砸地（地上的冲击环同时炸开），
# 之后压实不动，冠熄灭掉下来，再交给 0.9 s 自下而上的消散。base = rest、air（不贴地）----
DEATH = {'dur': 1.7, 'hold': True, 'base': 'rest', 'air': True, 'fade': 0.1, 'extra': {'impact': 0.9}, 'keys': {}}


def _death():
    T = lambda s: s / 1.7
    a, b, c = T(0.14), T(0.45), T(0.9)
    K = {
        'pelvis.rx': [0, 0.0, a, -0.22, b, 0.05, -c, 1.3, T(1.05), 1.22, 1, 1.26],
        'pelvis.oy': [0, 0.0, a, 0.04, b, -0.75, -c, -1.82, T(1.05), -1.74, 1, -1.78],
        'pelvis.oz': [0, 0.0, a, -0.12, b, 0.0, -c, 1.0, 1, 1.02],
        'pelvis.rz': [0, 0.0, a, 0.06, b, -0.05, c, 0.08, 1, 0.08],
        'spine_02.rx': [0, 0.0, a, -0.35, b, 0.2, c, 0.15, 1, 0.12],
        'spine_03.rx': [0, 0.0, a, -0.15, b, 0.12, c, 0.05, 1, 0.05],
        'head.rx': [0, 0.0, a, -0.45, b, 0.4, c, -0.25, 1, -0.15], 'head.rz': [0, 0.0, c, 0.25, 1, 0.3],
        'upperarm_l.rx': [0, 0.0, a, -0.9, b, -0.3, c, -1.9, 1, -2.0], 'upperarm_l.rz': [0, 0.1, a, 0.9, b, 0.4, c, 0.55, 1, 0.55],
        'lowerarm_l.rx': [0, 0.0, b, -0.4, 1, -0.25],
        'upperarm_r.rx': [0, 0.0, a, -0.7, b, -0.1, c, -1.5, 1, -1.6], 'upperarm_r.rz': [0, 0.0, a, -0.8, b, -0.2, c, -0.6, 1, -0.65],
        'lowerarm_r.rx': [0, 0.0, b, -0.25, 1, -0.3],
        # 剑脱手：往右后方甩出去，0.45 s 落地平躺
        'x_sword.ox': [0, 0.0, a, -0.2, b, -0.7, 1, -0.75], 'x_sword.oy': [0, 0.0, a, 0.3, -b, -1.0, 1, -1.0], 'x_sword.oz': [0, 0.0, b, -0.4, 1, -0.4],
        'x_sword.rz': [0, 0.0, a, -0.4, b, -1.1, 1, -1.15], 'x_sword.rx': [0, 0.0, b, 0.55, 1, 0.6],
        'thigh_l.rx': [0, 0.0, a, 0.1, b, -0.6, c, -0.05, 1, 0.0], 'calf_l.rx': [0, 0.0, a, 0.15, b, 1.7, c, 0.5, 1, 0.4],
        'thigh_r.rx': [0, 0.0, a, -0.15, b, -0.5, c, -0.2, 1, -0.2], 'calf_r.rx': [0, 0.0, a, 0.3, b, 1.65, c, 0.75, 1, 0.7],
        'x_wing_l_01.ry': [0, 0.0, a, -0.9, T(0.7), -0.6, 1, -0.7], 'x_wing_l_01.rz': [0, 0.0, a, 0.6, c, -0.4, 1, -0.5],
        'x_wing_r_01.ry': [0, 0.0, a, 0.9, T(0.7), 0.6, 1, 0.7], 'x_wing_r_01.rz': [0, 0.0, a, -0.6, c, 0.4, 1, 0.5],
        'x_wing_l_02.rz': [0, 0.0, a, 0.4, c, -0.5, 1, -0.6], 'x_wing_r_02.rz': [0, 0.0, a, -0.4, c, 0.5, 1, 0.6],
        'x_cape_02.rx': [0, 0.0, b, 0.4, c, -0.2, 1, -0.2], 'x_cape_03.rx': [0, 0.0, b, 0.4, c, -0.3, 1, -0.3],
        'x_crown.oy': [0, 0.0, T(0.3), 0.3, -T(1.2), -3.2, 1, -3.2], 'x_crown.rx': [0, 0.0, 1, 1.2],
    }
    DEATH['keys'] = K


_death()

CLIPS = {
    'idle': IDLE, 'walk': WALK,
    'slam_w': SLAM_W, 'slam': SLAM, 'fan_w': FAN_W, 'fan': FAN, 'spiral_w': SPIRAL_W, 'spiral': SPIRAL,
    'cross_w': CROSS_W, 'cross': CROSS, 'barrage_w': BAR_W, 'barrage': BAR, 'summon_w': SUM_W, 'summon': SUMMON,
    'broken': BROKEN, 'hit': HIT, 'mood': MOOD, 'death': DEATH,
}
