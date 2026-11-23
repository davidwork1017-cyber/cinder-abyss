# 熔渣巨像的动作表（游戏的关节通道写法，见 art/ca/rig.py 顶上的约定）。
# 转角符号（游戏坐标，y 上、z 前）：rx > 0 = 往前俯 / 竖着的骨骼朝前倒，垂着的手臂 rx < 0 = 往前抬；ry > 0 = 左肩往后、右肩往前；
# 垂着的左臂 rz > 0 = 往外侧张开，右臂反过来。大腿 rx < 0 = 往前迈，小腿 rx > 0 = 屈膝。
# 时序照 design-note §4：蓄力动作按实际播放的长度做（招式蓄力 − 出手提前量），出手动作的 k0 就是接触帧
# （锤子落地 / 冲刺起步 / 弹幕离手），出手动作里 k0 之前那一小段就是 W.clipLead 的提前量。
# 招式（模拟里的时序）一点不改：砸地 0.95 s 结算、冲锋 0.75 s 起冲、弹幕 0.45 s 离手。
from ..rig import mirror_keys


def _m(keys):
    """左右对称地补全：只写了 _l 的通道补上镜像的 _r"""
    out = dict(keys)
    for k, v in mirror_keys({k: v for k, v in keys.items() if '_l.' in k}).items():
        out.setdefault(k, v)
    return out


IDLE = {
    'dur': 2.6, 'loop': True, 'fade': 0.25,
    'keys': {
        # 呼吸：胸口起伏、肩轭跟着沉一下，锤臂随着晃；头慢慢左右看
        'spine_02.rx': [0, 0.03, 0.5, -0.02, 1, 0.03],
        'spine_03.rx': [0, 0.02, 0.5, -0.03, 1, 0.02],
        'spine_02.ry': [0, 0.0, 0.25, 0.03, 0.75, -0.03, 1, 0.0],
        'neck_01.ry': [0, 0.06, 0.5, -0.08, 1, 0.06],
        'head.rx': [0, 0.04, 0.5, 0.0, 1, 0.04],
        'clavicle_l.rz': [0, 0.0, 0.5, -0.03, 1, 0.0],
        'clavicle_r.rz': [0, 0.0, 0.5, 0.03, 1, 0.0],
        'upperarm_l.rx': [0, -0.08, 0.5, -0.03, 1, -0.08],
        'upperarm_l.rz': [0, 0.06, 1, 0.06],
        'lowerarm_l.rx': [0, -0.22, 0.5, -0.17, 1, -0.22],
        'upperarm_r.rx': [0, -0.04, 0.5, -0.08, 1, -0.04],
        'upperarm_r.rz': [0, -0.04, 1, -0.04],
        'lowerarm_r.rx': [0, -0.12, 0.5, -0.1, 1, -0.12],
        'x_finger_l_01.rx': [0, 0.2, 0.5, 0.28, 1, 0.2],
        'x_finger_l_02.rx': [0, 0.25, 0.5, 0.32, 1, 0.25],
        'x_finger_l_03.rx': [0, 0.2, 0.5, 0.26, 1, 0.2],
        'pelvis.oy': [0, 0.0, 0.5, -0.03, 1, 0.0],
        'thigh_l.rx': [0, -0.05, 1, -0.05], 'calf_l.rx': [0, 0.1, 0.5, 0.14, 1, 0.1],
        'thigh_r.rx': [0, -0.05, 1, -0.05], 'calf_r.rx': [0, 0.1, 0.5, 0.14, 1, 0.1],
    },
}

# 走：一个周期两步，k = 0 左脚在前刚落地；重的落脚：骨盆在着地后沉、胯左右晃，上身反着拧，左臂摆、锤臂只小幅晃
WALK = {
    'dur': 1.0, 'loop': True, 'fade': 0.2, 'extra': {'cycle': 2.6},
    'keys': {
        'thigh_l.rx': [0, -0.42, 0.25, -0.05, 0.5, 0.36, 0.75, 0.0, 1, -0.42],
        'calf_l.rx': [0, 0.12, 0.12, 0.3, 0.25, 0.16, 0.5, 0.2, 0.72, 0.85, 1, 0.12],
        'foot_l.rx': [0, 0.12, 0.25, 0.0, 0.5, -0.25, 0.75, -0.1, 1, 0.12],
        'thigh_r.rx': [0, 0.36, 0.25, 0.0, 0.5, -0.42, 0.75, -0.05, 1, 0.36],
        'calf_r.rx': [0, 0.2, 0.22, 0.85, 0.5, 0.12, 0.62, 0.3, 0.75, 0.16, 1, 0.2],
        'foot_r.rx': [0, -0.25, 0.25, -0.1, 0.5, 0.12, 0.75, 0.0, 1, -0.25],
        'pelvis.oy': [0, -0.02, 0.1, -0.1, 0.3, 0.02, 0.5, -0.02, 0.6, -0.1, 0.8, 0.02, 1, -0.02],
        'pelvis.rz': [0, 0.06, 0.5, -0.06, 1, 0.06],
        'pelvis.ry': [0, 0.1, 0.5, -0.1, 1, 0.1],
        'spine_02.ry': [0, -0.14, 0.5, 0.14, 1, -0.14],
        'spine_02.rx': [0, 0.08, 0.1, 0.12, 0.5, 0.08, 0.6, 0.12, 1, 0.08],
        'spine_03.rz': [0, -0.04, 0.5, 0.04, 1, -0.04],
        'head.rx': [0, -0.04, 0.5, -0.04, 1, -0.04],
        'upperarm_l.rx': [0, 0.35, 0.5, -0.38, 1, 0.35],
        'upperarm_l.rz': [0, 0.08, 1, 0.08],
        'lowerarm_l.rx': [0, -0.15, 0.5, -0.45, 1, -0.15],
        'upperarm_r.rx': [0, -0.2, 0.5, 0.12, 1, -0.2],
        'upperarm_r.rz': [0, -0.06, 1, -0.06],
        'lowerarm_r.rx': [0, -0.2, 0.5, -0.1, 1, -0.2],
        'x_finger_l_02.rx': [0, 0.3, 1, 0.3],
    },
}

# ---- 砸地：蓄力 0.80 s（锤石从身侧抡到身后、举过头顶，上身拧开、重心压到后脚），出手 0.60 s，k0 0.25（落地 = 预警圈结算）----
SLAM_UP = {  # 蓄力最后定格的姿势 = 出手的第一帧
    'pelvis.ry': 0.18, 'pelvis.oz': -0.12, 'spine_02.rx': -0.22, 'spine_02.ry': -0.32, 'spine_03.rx': -0.12, 'spine_03.ry': -0.08,
    'head.rx': 0.25, 'neck_01.ry': 0.2,
    'upperarm_r.rx': -2.85, 'upperarm_r.rz': -0.18, 'lowerarm_r.rx': -0.85, 'clavicle_r.rz': 0.18,
    'upperarm_l.rx': -0.85, 'upperarm_l.rz': 0.5, 'lowerarm_l.rx': -0.6, 'clavicle_l.rz': -0.06,
    'thigh_l.rx': -0.42, 'calf_l.rx': 0.32, 'foot_l.rx': 0.1, 'thigh_r.rx': 0.22, 'calf_r.rx': 0.5, 'foot_r.rx': -0.2,
}
SLAM_HIT = {  # 接触帧：上身俯 0.45 + 0.2、前膝深弯（胯压到 1.37 m），锤石底面落在身前偏右的地上（中心约 x −0.8、z +2.6：
    # 游戏镜头从南边看过来，锤石在身子前面、不被身子挡住）。数值用 ~/dev/boss-golem-tools/fk.mjs 按包里的骨架算过（含贴地修正）
    # 注意：上身往前俯时，垂着的手臂会跟着往后摆；手臂要往前伸，rx 得比上身俯的角度更负
    'pelvis.ry': -0.12, 'pelvis.oz': 0.25, 'pelvis.rx': 0.1, 'spine_02.rx': 0.45, 'spine_02.ry': 0.3, 'spine_03.rx': 0.2, 'spine_03.ry': 0.08,
    'head.rx': -0.5, 'neck_01.ry': -0.12,
    'upperarm_r.rx': -1.05, 'upperarm_r.rz': 0.25, 'lowerarm_r.rx': -0.2, 'clavicle_r.rz': -0.1,
    'upperarm_l.rx': 0.45, 'upperarm_l.rz': 0.6, 'lowerarm_l.rx': -0.35, 'clavicle_l.rz': 0.08,
    'thigh_l.rx': -1.2, 'calf_l.rx': 1.5, 'foot_l.rx': -0.1, 'thigh_r.rx': 0.12, 'calf_r.rx': 0.9, 'foot_r.rx': -0.35,
}
SLAM_W = {
    'dur': 0.80, 'hold': True, 'fade': 0.12, 'steady': True,
    'keys': {},
}
SLAM = {
    'dur': 0.60, 'k0': 0.25, 'fade': 0.03, 'out': 0.35, 'steady': True,
    'keys': {},
}


def _slam():
    rest = {k: 0.0 for k in set(SLAM_UP) | set(SLAM_HIT)}
    mid_w = {  # 蓄力中段：锤石经过身侧往后上方抡（右臂往后、外张），上身开始拧
        'upperarm_r.rx': -1.2, 'upperarm_r.rz': -0.55, 'lowerarm_r.rx': -0.3, 'spine_02.ry': -0.2, 'spine_02.rx': -0.08,
        'pelvis.ry': 0.1, 'pelvis.oz': -0.06, 'thigh_l.rx': -0.25, 'calf_l.rx': 0.2, 'thigh_r.rx': 0.1, 'calf_r.rx': 0.3,
    }
    for k in rest:
        a = rest[k]
        m = mid_w.get(k, (a + SLAM_UP.get(k, 0)) * 0.45)
        SLAM_W['keys'][k] = [0, a, 0.45, m, 0.85, SLAM_UP.get(k, 0) * 1.02, 1, SLAM_UP.get(k, 0)]
    # 出手：0 → k0 加速砸下（-0.25 = 加速冲到这一帧），接触后压一下（0.32），锤子在地上钉 0.2 s（到 0.58），然后抬起、站直
    for k in rest:
        u, h = SLAM_UP.get(k, 0), SLAM_HIT.get(k, 0)
        squash = {'calf_r.rx': 1.0, 'head.rx': -0.6, 'upperarm_l.rx': 0.6, 'lowerarm_l.rx': -0.5}.get(k, h)  # 接触后震一下：后膝、头、左臂（锤石钉在地上不动）
        SLAM['keys'][k] = [0, u, -0.25, h, 0.32, squash, 0.58, h * 0.96, 0.82, h * 0.35, 1, 0.0]


_slam()

# ---- 冲锋：蓄力 0.60 s（压低、左肩顶在前面、左手石指扣地），出手 0.75 s，k0 0.20（起冲），冲刺 0.25 s 里一直保持前冲的姿势，收脚时打滑、站直 ----
CHARGE_DOWN = {
    'pelvis.rx': 0.12, 'pelvis.oz': -0.2, 'spine_02.rx': 0.3, 'spine_02.ry': -0.48, 'spine_03.rx': 0.08, 'head.rx': -0.4,
    'upperarm_l.rx': -0.55, 'upperarm_l.rz': -0.15, 'lowerarm_l.rx': -0.75, 'clavicle_l.ry': -0.2,
    'x_finger_l_01.rx': 0.65, 'x_finger_l_02.rx': 0.7, 'x_finger_l_03.rx': 0.65,
    'upperarm_r.rx': 0.55, 'upperarm_r.rz': -0.25, 'lowerarm_r.rx': -0.3,
    'thigh_l.rx': -0.85, 'calf_l.rx': 1.1, 'foot_l.rx': -0.2, 'thigh_r.rx': -0.05, 'calf_r.rx': 0.95, 'foot_r.rx': -0.45,
}
CHARGE_LUNGE = {
    'pelvis.rx': 0.16, 'pelvis.oz': 0.35, 'spine_02.rx': 0.34, 'spine_02.ry': -0.55, 'spine_03.rx': 0.08, 'head.rx': -0.45,
    'upperarm_l.rx': -1.0, 'upperarm_l.rz': -0.3, 'lowerarm_l.rx': -0.6, 'clavicle_l.ry': -0.3,
    'x_finger_l_01.rx': 0.3, 'x_finger_l_02.rx': 0.32, 'x_finger_l_03.rx': 0.3,
    'upperarm_r.rx': 0.8, 'upperarm_r.rz': -0.3, 'lowerarm_r.rx': -0.25,
    'thigh_l.rx': -0.6, 'calf_l.rx': 0.6, 'foot_l.rx': 0.0, 'thigh_r.rx': 0.55, 'calf_r.rx': 0.35, 'foot_r.rx': -0.3,
}
CHARGE_SKID = {  # 收脚：往后坐、前脚蹬住打滑
    'pelvis.rx': -0.08, 'pelvis.oz': -0.1, 'spine_02.rx': 0.05, 'spine_02.ry': -0.2, 'head.rx': -0.1,
    'upperarm_l.rx': -0.4, 'upperarm_l.rz': 0.35, 'lowerarm_l.rx': -0.5, 'upperarm_r.rx': 0.2, 'upperarm_r.rz': -0.35,
    'thigh_l.rx': -0.7, 'calf_l.rx': 0.45, 'foot_l.rx': 0.25, 'thigh_r.rx': 0.25, 'calf_r.rx': 0.6,
}
CHARGE_W = {'dur': 0.60, 'hold': True, 'fade': 0.12, 'steady': True, 'keys': {}}
CHARGE = {'dur': 0.75, 'k0': 0.20, 'fade': 0.04, 'out': 0.3, 'steady': True, 'keys': {}}


def _charge():
    ks = set(CHARGE_DOWN) | set(CHARGE_LUNGE) | set(CHARGE_SKID)
    for k in ks:
        d, l, s = CHARGE_DOWN.get(k, 0), CHARGE_LUNGE.get(k, 0), CHARGE_SKID.get(k, 0)
        CHARGE_W['keys'][k] = [0, 0.0, 0.6, d * 0.85, 1, d]
        CHARGE['keys'][k] = [0, d, -0.2, l, 0.55, l, 0.75, s, 1, 0.0]


_charge()

# ---- 弹幕：蓄力 0.33 s（双臂合拢护住炉栅、炉芯蓄热），出手 0.60 s，k0 0.20（胸口猛地敞开、双臂张到最开 = 弹幕离手，炉芯最亮）----
RING_IN = {
    'spine_02.rx': 0.32, 'spine_03.rx': 0.1, 'head.rx': 0.3,
    'upperarm_l.rx': -0.95, 'upperarm_l.rz': -0.42, 'lowerarm_l.rx': -1.25, 'clavicle_l.ry': -0.25,
    'upperarm_r.rx': -0.8, 'upperarm_r.rz': 0.42, 'lowerarm_r.rx': -0.9, 'clavicle_r.ry': 0.25,
    'thigh_l.rx': -0.35, 'calf_l.rx': 0.6, 'thigh_r.rx': -0.3, 'calf_r.rx': 0.6, 'x_grate.rx': 0.0,
}
RING_OUT = {
    'spine_02.rx': -0.38, 'spine_03.rx': -0.12, 'head.rx': -0.4,
    'upperarm_l.rx': 0.25, 'upperarm_l.rz': 1.2, 'lowerarm_l.rx': -0.2, 'clavicle_l.ry': 0.2, 'clavicle_l.rz': 0.15,
    'upperarm_r.rx': 0.25, 'upperarm_r.rz': -1.05, 'lowerarm_r.rx': -0.15, 'clavicle_r.ry': -0.2, 'clavicle_r.rz': -0.15,
    'thigh_l.rx': -0.15, 'calf_l.rx': 0.25, 'thigh_r.rx': -0.1, 'calf_r.rx': 0.25, 'x_grate.rx': -0.22,
    'thigh_l.rz': 0.12, 'thigh_r.rz': -0.12,
}
RING_W = {'dur': 0.33, 'hold': True, 'fade': 0.1, 'steady': True, 'keys': {}}
RING = {'dur': 0.60, 'k0': 0.20, 'fade': 0.03, 'out': 0.35, 'steady': True, 'keys': {}}


def _ring():
    for k in set(RING_IN) | set(RING_OUT):
        a, b = RING_IN.get(k, 0), RING_OUT.get(k, 0)
        RING_W['keys'][k] = [0, 0.0, 1, a]
        RING['keys'][k] = [0, a, -0.2, b, 0.55, b * 0.85, 1, 0.0]


_ring()

# ---- 破防：0.5 s 垮下来单膝跪地、锤石杵在地上，之后 2 s 一个循环（loopFrom = 0.2：循环从跪稳以后开始，不重放垮下去那一段）----
KNEEL = {
    'pelvis.rx': 0.16, 'spine_02.rx': 0.4, 'spine_03.rx': 0.1, 'head.rx': 0.38,
    'thigh_l.rx': -1.3, 'calf_l.rx': 1.4, 'foot_l.rx': -0.1, 'thigh_r.rx': 0.2, 'calf_r.rx': 1.5, 'foot_r.rx': 0.45,
    'upperarm_r.rx': -0.75, 'upperarm_r.rz': 0.1, 'lowerarm_r.rx': -0.05,
    'upperarm_l.rx': 0.1, 'upperarm_l.rz': 0.3, 'lowerarm_l.rx': -0.4,
    'x_finger_l_01.rx': 0.5, 'x_finger_l_02.rx': 0.55, 'x_finger_l_03.rx': 0.5,
}
BROKEN = {'dur': 2.5, 'loop': True, 'loopFrom': 0.2, 'fade': 0.15, 'out': 0.45, 'keys': {}}


def _broken():
    wob = {'spine_02.rx': 0.05, 'head.rx': 0.06, 'spine_02.rz': 0.04, 'head.rz': 0.12, 'upperarm_l.rx': 0.08, 'spine_03.rz': 0.03}
    for k in set(KNEEL) | set(wob):
        v = KNEEL.get(k, 0)
        w = wob.get(k, 0)
        # 0 → 0.2：垮下去（0.12 那一下砸到底再弹一点）；0.2 → 1：慢慢晃（0.2 和 1 的值一样，循环接得上）
        BROKEN['keys'][k] = [0, 0.0, -0.12, v * 1.06, 0.2, v, 0.4, v + w, 0.6, v, 0.8, v - w, 1, v]


_broken()

# ---- 受击（叠加，只动上身）：第一帧是 0，游戏端按相对第一帧的变化量叠上去 ----
HIT = {
    'dur': 0.35, 'fade': 0.02,
    'keys': {
        'spine_02.rx': [0, 0.0, 0.12, -0.16, 1, 0.0], 'spine_03.rx': [0, 0.0, 0.18, -0.1, 1, 0.0],
        'head.rx': [0, 0.0, 0.2, -0.22, 1, 0.0], 'neck_01.rz': [0, 0.0, 0.2, 0.08, 1, 0.0],
        'upperarm_l.rz': [0, 0.0, 0.15, 0.15, 1, 0.0], 'upperarm_r.rz': [0, 0.0, 0.15, -0.1, 1, 0.0],
    },
}

# ---- 狂暴（持续的姿态偏移，按 ent.mood 叠上去）：炉栅往外掀开一个口，肩轭再压低一点、烟囱后仰 ----
MOOD = {
    'dur': 0.5, 'hold': True,
    'keys': {
        'x_grate.rx': [0, -0.3, 1, -0.3], 'spine_02.rx': [0, 0.06, 1, 0.06], 'spine_03.rx': [0, 0.04, 1, 0.04],
        'x_chimney_l.rx': [0, -0.14, 1, -0.14], 'x_chimney_r.rx': [0, -0.14, 1, -0.14], 'head.rx': [0, -0.06, 1, -0.06],
    },
}

# ---- 死亡 1.6 s（定格），对着 vfx3 的三段崩开：0 s 第一道裂口（往后一仰）、0.45 s 第二道（双膝一软）、0.90 s 砸到地上（地上的冲击环同时炸开），
# 之后压实不动，再交给 0.9 s 自下而上的消散。base = rest、air（不贴地）----
DEATH = {'dur': 1.6, 'hold': True, 'base': 'rest', 'air': True, 'fade': 0.1, 'extra': {'impact': 0.9}, 'keys': {}}


def _death():
    T = lambda s: s / 1.6
    a, b, c = T(0.14), T(0.45), T(0.9)
    K = {
        # 骨盆：先往后一仰，0.45 s 膝盖一软往下坠，0.90 s 正面砸到地上（加速），再弹一点压实
        'pelvis.rx': [0, 0.0, a, -0.2, b, 0.05, -c, 1.25, T(1.05), 1.18, 1, 1.22],
        'pelvis.oy': [0, 0.0, a, 0.04, b, -0.35, -c, -1.08, T(1.05), -1.0, 1, -1.05],
        'pelvis.oz': [0, 0.0, a, -0.12, b, 0.0, -c, 0.95, 1, 0.98],
        'pelvis.rz': [0, 0.0, a, 0.06, b, -0.05, c, 0.08, 1, 0.08],
        'spine_02.rx': [0, 0.0, a, -0.35, b, 0.2, c, 0.15, 1, 0.12],
        'spine_02.rz': [0, 0.0, a, -0.08, b, 0.06, 1, 0.04],
        'spine_03.rx': [0, 0.0, a, -0.15, b, 0.12, c, 0.05, 1, 0.05],
        'head.rx': [0, 0.0, a, -0.45, b, 0.4, c, -0.25, 1, -0.15],
        'head.rz': [0, 0.0, c, 0.25, 1, 0.3],
        'upperarm_l.rx': [0, 0.0, a, -0.9, b, -0.3, c, -1.9, 1, -2.0], 'upperarm_l.rz': [0, 0.0, a, 0.9, b, 0.4, c, 0.55, 1, 0.55],
        'lowerarm_l.rx': [0, 0.0, b, -0.4, 1, -0.25],
        'upperarm_r.rx': [0, 0.0, a, -0.7, b, -0.1, c, -1.5, 1, -1.6], 'upperarm_r.rz': [0, 0.0, a, -0.8, b, -0.2, c, -0.6, 1, -0.65],
        'lowerarm_r.rx': [0, 0.0, b, -0.25, 1, -0.3],
        'thigh_l.rx': [0, 0.0, a, 0.1, b, -0.4, c, -0.05, 1, 0.0], 'calf_l.rx': [0, 0.0, a, 0.15, b, 1.6, c, 0.5, 1, 0.4],
        'thigh_r.rx': [0, 0.0, a, -0.15, b, -0.3, c, -0.2, 1, -0.2], 'calf_r.rx': [0, 0.0, a, 0.3, b, 1.55, c, 0.75, 1, 0.7],
        'x_grate.rx': [0, 0.0, a, -0.35, c, -0.5, 1, -0.5],
        'x_chimney_l.rx': [0, 0.0, c, 0.3, 1, 0.25], 'x_chimney_r.rz': [0, 0.0, c, -0.3, 1, -0.25],
    }
    DEATH['keys'] = K


_death()

CLIPS = {
    'idle': IDLE, 'walk': WALK,
    'slam_w': SLAM_W, 'slam': SLAM, 'charge_w': CHARGE_W, 'charge': CHARGE, 'ring_w': RING_W, 'ring': RING,
    'broken': BROKEN, 'hit': HIT, 'mood': MOOD, 'death': DEATH,
}
for _c in CLIPS.values():
    _c['keys'] = _m(_c['keys']) if _c is IDLE else _c['keys']
