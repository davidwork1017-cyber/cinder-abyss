# 熄烛者的动作表（游戏的关节通道写法，见 art/ca/rig.py 顶上的约定）。
# 转角符号（游戏坐标，y 上、z 前）：rx > 0 = 往前俯 / 竖着的骨骼朝前倒，垂着的手臂 rx < 0 = 往前抬；ry > 0 = 左肩往后、右肩往前；
# 垂着的左臂 rz > 0 = 往外侧张开，右臂反过来。提灯挂在手下面：x_lamp rx > 0 = 灯往后摆。
# 下摆四根（枢轴在 1.55 m）：x_hem_f rx < 0 = 前摆往外掀，x_hem_b rx > 0 = 后摆往外掀，x_hem_l rz > 0 / x_hem_r rz < 0 = 侧摆往外掀；
# 几根一起 rx > 0 = 整个下摆往后拖。没有腿、不贴地（滑行的浮动、沉下去都写在骨盆上）。
# 时序照 design-note §4（招式蓄力 − 出手提前量 = 蓄力动作的长度，出手动作的 k0 就是接触帧），招式（模拟里的时序）一点不改：
#   拂烛 1.00 s 结算（双拂 1.00 / 1.60 同一个出手动作打两遍）；烛泪 0.40 s 起落；引芯 0.90 s 起冲（冲 0.35 s）；冠焰螺旋 0.25 s 起、持续到 1.86 s；
#   坠冕 1.40 s；暗潮 1.60 s 结算。阶段换场：lift（二阶段掐灯，按 1.2 s 播）、lift3（三阶段冠重燃，按 1.3 s 播；游戏端按 ent.mood 选）。
from ..rig import mirror_keys


def _k0(ticks, dur):
    """出手提前量取整到 1/60 s（模拟按 60 帧推进：G.after 在整帧上触发，提前量是整帧时接触帧正好落在预警结算的那一帧）"""
    return ticks / 60 / dur


L_BRUSH, L_TEARS, L_WICK, L_SPIRAL, L_CROWN, L_TIDE = 10, 8, 8, 7, 9, 10
D_BRUSH, D_TEARS, D_WICK, D_SPIRAL, D_CROWN, D_TIDE = 0.55, 1.30, 0.70, 1.75, 0.60, 0.80
K_BRUSH, K_TEARS, K_WICK, K_SPIRAL, K_CROWN, K_TIDE = (_k0(L_BRUSH, D_BRUSH), _k0(L_TEARS, D_TEARS), _k0(L_WICK, D_WICK), _k0(L_SPIRAL, D_SPIRAL),
                                                       _k0(L_CROWN, D_CROWN), _k0(L_TIDE, D_TIDE))
WIND = {'brush': 1.0, 'tears': 0.4, 'wick': 0.9, 'spiral': 0.25, 'crown': 1.4, 'tide': 1.6}
LEAD = {'brush': L_BRUSH, 'tears': L_TEARS, 'wick': L_WICK, 'spiral': L_SPIRAL, 'crown': L_CROWN, 'tide': L_TIDE}


def _wdur(p):
    return WIND[p] - LEAD[p] / 60


def _sym(d):
    """一个姿势里只写了左边的通道，补上右边的镜像（左右一起动的部位）"""
    out = dict(d)
    for k, v in d.items():
        if '_l.' in k:
            mk = list(mirror_keys({k: [0, v]}).items())[0]
            out.setdefault(mk[0], mk[1][1])
    return out


# 平时的姿态（idle 的中值；别的动作从这里出发、回到这里）：微微佝着背、头往下看；两条长臂垂着、肘往前弯一点，提灯吊在胯前两侧
REST = _sym({
    'spine_03.rx': 0.06, 'neck_01.rx': 0.08, 'head.rx': 0.06,
    'upperarm_l.rx': -0.1, 'upperarm_l.rz': 0.1, 'lowerarm_l.rx': -0.34, 'hand_l.rx': 0.44,
})


def _p(pose, sym=True):
    """姿势表里没写的通道按平时的值；sym：只写了左边的补上右边的镜像"""
    out = dict(REST)
    out.update(_sym(pose) if sym else pose)
    return out


def _clip(spec, poses):
    """poses = [(k, 姿势 dict), ...]：每个通道在所有姿势里插值（姿势里没写的通道 = 0），k 写成负数 = 加速冲到这一帧"""
    chans = set()
    for _, p in poses:
        chans |= set(p)
    keys = {}
    for c in sorted(chans):
        K = []
        for k, p in poses:
            K += [k, round(p.get(c, 0.0), 4)]
        keys[c] = K
    spec['keys'] = keys
    return spec


def _hang(p, side, lamp=True):
    """提灯竖直吊着：手腕（转得太多时手腕和提灯各分一半）把上臂 + 前臂往前抬的角度补回去；手臂往外张得多时提灯的 rz 也补回去"""
    s = '_' + side
    comp = -(p.get('upperarm' + s + '.rx', 0) + p.get('lowerarm' + s + '.rx', 0))
    if abs(comp) <= 1.5 or not lamp:
        p['hand' + s + '.rx'] = round(comp, 4)
    else:
        p['hand' + s + '.rx'] = round(comp * 0.5, 4)
        p['x_lamp' + s + '.rx'] = round(p.get('x_lamp' + s + '.rx', 0) + comp * 0.5, 4)
    rz = p.get('upperarm' + s + '.rz', 0)
    if abs(rz) > 0.3 and lamp:
        p['x_lamp' + s + '.rz'] = round(rz if comp > 1.5 else -rz, 4)  # 手臂举过头（前臂朝上）时提灯的 rz 方向反过来
    return p


def _hh(p):
    return _hang(_hang(p, 'l'), 'r')


# ---------------------------------------------------------------- 待机 / 滑行
IDLE = {
    'dur': 2.6, 'loop': True, 'fade': 0.25,
    'keys': {
        # 浮着：整个人很慢地上下浮一点，胸口起伏；头在兜帽里慢慢左右看；两盏灯错开相位轻轻晃；下摆跟着起伏
        'pelvis.oy': [0, 0.0, 0.5, 0.05, 1, 0.0],
        'spine_02.rx': [0, 0.0, 0.5, 0.02, 1, 0.0],
        'spine_03.rx': [0, 0.06, 0.5, 0.03, 1, 0.06],
        'neck_01.rx': [0, 0.08, 1, 0.08], 'neck_01.ry': [0, 0.1, 0.5, -0.1, 1, 0.1],
        'head.rx': [0, 0.06, 0.5, 0.02, 1, 0.06], 'head.ry': [0, 0.06, 0.5, -0.08, 1, 0.06],
        'upperarm_l.rx': [0, -0.1, 0.5, -0.08, 1, -0.1], 'upperarm_l.rz': [0, 0.1, 0.5, 0.12, 1, 0.1],
        'upperarm_r.rx': [0, -0.1, 0.5, -0.12, 1, -0.1], 'upperarm_r.rz': [0, -0.1, 0.5, -0.12, 1, -0.1],
        'lowerarm_l.rx': [0, -0.34, 1, -0.34], 'lowerarm_r.rx': [0, -0.34, 1, -0.34],
        'hand_l.rx': [0, 0.44, 1, 0.44], 'hand_r.rx': [0, 0.44, 1, 0.44],
        'x_lamp_l.rx': [0, 0.04, 0.25, -0.03, 0.5, -0.06, 0.75, 0.0, 1, 0.04], 'x_lamp_l.rz': [0, 0.0, 0.25, 0.04, 0.75, -0.03, 1, 0.0],
        'x_lamp_r.rx': [0, -0.05, 0.25, 0.0, 0.5, 0.05, 0.75, 0.02, 1, -0.05], 'x_lamp_r.rz': [0, 0.0, 0.25, -0.03, 0.75, 0.04, 1, 0.0],
        'x_hem_f.rx': [0, 0.0, 0.5, -0.03, 1, 0.0], 'x_hem_b.rx': [0, 0.0, 0.5, 0.03, 1, 0.0],
        'x_hem_l.rz': [0, 0.0, 0.5, 0.025, 1, 0.0], 'x_hem_r.rz': [0, 0.0, 0.5, -0.025, 1, 0.0],
        'x_cape_02.rx': [0, 0.02, 0.5, -0.02, 1, 0.02], 'x_tab.rx': [0, 0.0, 0.5, -0.02, 1, 0.0],
    },
}

# 滑行：一个周期 1.6 m、一次起伏；上身往前倾一点，下摆整个往后拖、左右轮流摆，两盏灯往后荡、一前一后
WALK = {
    'dur': 0.8, 'loop': True, 'fade': 0.2, 'extra': {'cycle': 1.6},
    'keys': {
        'pelvis.oy': [0, 0.0, 0.5, 0.08, 1, 0.0],
        'pelvis.ry': [0, 0.04, 0.5, -0.04, 1, 0.04],
        'spine_01.rx': [0, 0.08, 1, 0.08], 'spine_02.rx': [0, 0.05, 0.5, 0.07, 1, 0.05], 'spine_03.rx': [0, 0.06, 1, 0.06],
        'neck_01.rx': [0, 0.02, 1, 0.02], 'head.rx': [0, 0.0, 1, 0.0],
        'upperarm_l.rx': [0, 0.04, 0.5, -0.06, 1, 0.04], 'upperarm_l.rz': [0, 0.12, 1, 0.12],
        'upperarm_r.rx': [0, -0.06, 0.5, 0.04, 1, -0.06], 'upperarm_r.rz': [0, -0.12, 1, -0.12],
        'lowerarm_l.rx': [0, -0.36, 1, -0.36], 'lowerarm_r.rx': [0, -0.36, 1, -0.36],
        'hand_l.rx': [0, 0.32, 0.5, 0.42, 1, 0.32], 'hand_r.rx': [0, 0.42, 0.5, 0.32, 1, 0.42],
        'x_lamp_l.rx': [0, 0.28, 0.5, 0.16, 1, 0.28], 'x_lamp_r.rx': [0, 0.16, 0.5, 0.28, 1, 0.16],
        'x_hem_f.rx': [0, 0.1, 0.5, 0.14, 1, 0.1], 'x_hem_b.rx': [0, 0.22, 0.5, 0.18, 1, 0.22],
        'x_hem_l.rx': [0, 0.16, 0.5, 0.2, 1, 0.16], 'x_hem_r.rx': [0, 0.2, 0.5, 0.16, 1, 0.2],
        'x_hem_l.rz': [0, 0.04, 0.5, -0.02, 1, 0.04], 'x_hem_r.rz': [0, 0.02, 0.5, -0.04, 1, 0.02],
        'x_cape_01.rx': [0, 0.08, 1, 0.08], 'x_cape_02.rx': [0, 0.14, 0.5, 0.1, 1, 0.14],
        'x_tab.rx': [0, 0.06, 0.5, 0.1, 1, 0.06],
    },
}

# ---------------------------------------------------------------- 拂烛 / 双拂：右手的灯往右后方拉低、身子往右拧、俯身；出手是一个贴地的大半圈横扫，
# 接触帧灯甩到正前方最远；扫过去以后顺势再拉回右后方（出手动作首尾一样：双拂第二下接得上，模拟在两下之间把身子转 180°）
BR_W = _p({
    'pelvis.oy': -0.12, 'pelvis.ry': -0.12, 'spine_01.ry': -0.18, 'spine_02.ry': -0.22, 'spine_03.ry': -0.16, 'spine_02.rx': 0.16, 'spine_03.rx': 0.12,
    'neck_01.ry': 0.3, 'head.ry': 0.2, 'neck_01.rx': -0.08,
    'upperarm_r.rx': 0.32, 'upperarm_r.rz': -0.62, 'lowerarm_r.rx': -0.2, 'hand_r.rx': 0.05, 'x_lamp_r.rx': 0.4, 'x_lamp_r.rz': -0.15,
    'upperarm_l.rx': -0.5, 'upperarm_l.rz': 0.35, 'lowerarm_l.rx': -0.55, 'hand_l.rx': 0.9,
    'x_hem_b.rx': 0.18, 'x_hem_r.rz': -0.12, 'x_hem_l.rz': 0.04, 'x_cape_02.rx': 0.12,
}, sym=False)
BR_HIT = _p({
    'pelvis.oy': -0.18, 'pelvis.ry': 0.1, 'spine_01.ry': 0.14, 'spine_02.ry': 0.16, 'spine_03.ry': 0.1, 'spine_02.rx': 0.22, 'spine_03.rx': 0.1,
    'neck_01.ry': -0.1, 'head.ry': -0.12, 'neck_01.rx': -0.05,
    'upperarm_r.rx': -1.05, 'upperarm_r.rz': -0.3, 'lowerarm_r.rx': -0.05, 'hand_r.rx': 0.2, 'x_lamp_r.rx': -0.75, 'x_lamp_r.rz': 0.2,
    'upperarm_l.rx': 0.2, 'upperarm_l.rz': 0.5, 'lowerarm_l.rx': -0.3, 'hand_l.rx': 0.1,
    'x_hem_f.rx': -0.16, 'x_hem_l.rz': 0.16, 'x_hem_b.rx': 0.12, 'x_cape_02.rx': -0.1,
}, sym=False)
BR_FOL = _p({
    'pelvis.oy': -0.14, 'pelvis.ry': 0.2, 'spine_01.ry': 0.24, 'spine_02.ry': 0.26, 'spine_03.ry': 0.2, 'spine_02.rx': 0.18, 'spine_03.rx': 0.1,
    'neck_01.ry': -0.25, 'head.ry': -0.15,
    'upperarm_r.rx': -0.85, 'upperarm_r.rz': 0.35, 'upperarm_r.ry': 0.3, 'lowerarm_r.rx': -0.35, 'hand_r.rx': 0.4, 'x_lamp_r.rx': -0.2, 'x_lamp_r.rz': 0.55,
    'upperarm_l.rx': 0.3, 'upperarm_l.rz': 0.45, 'lowerarm_l.rx': -0.25,
    'x_hem_l.rz': 0.2, 'x_hem_f.rx': -0.08, 'x_cape_02.rx': -0.05,
}, sym=False)
BRUSH_W = _clip({'dur': _wdur('brush'), 'hold': True, 'fade': 0.12, 'steady': True}, [(0, REST), (0.25, _p({'pelvis.oy': 0.04, 'spine_02.rx': -0.04})), (1, BR_W)])
BRUSH = _clip({'dur': D_BRUSH, 'k0': K_BRUSH, 'fade': 0.03, 'out': 0.3, 'steady': True}, [(0, BR_W), (-K_BRUSH, BR_HIT), (0.5, BR_FOL), (0.78, BR_FOL), (1, BR_W)])

# ---------------------------------------------------------------- 烛泪：右手把灯举到身前上方、灯翻过手腕倒过来，灯盖张开（接触帧举到最高），之后举着轻轻抖（滴蜡），末尾放下
TE_W = _p({
    'spine_02.rx': -0.06, 'spine_03.rx': -0.04, 'neck_01.rx': -0.12,
    'upperarm_r.rx': -1.2, 'upperarm_r.rz': -0.2, 'lowerarm_r.rx': -0.7, 'hand_r.rx': 0.4, 'x_lamp_r.rx': 0.2,
    'upperarm_l.rx': -0.3, 'upperarm_l.rz': 0.2, 'lowerarm_l.rx': -0.6, 'hand_l.rx': 0.9,
}, sym=False)
TE_UP = _p({
    'spine_02.rx': -0.1, 'spine_03.rx': -0.06, 'neck_01.rx': -0.18, 'head.rx': -0.06,
    'upperarm_r.rx': -1.85, 'upperarm_r.rz': -0.18, 'lowerarm_r.rx': -0.55, 'hand_r.rx': -0.35, 'x_lamp_r.rx': -1.1, 'x_lid_r.rx': -1.0,
    'upperarm_l.rx': -0.3, 'upperarm_l.rz': 0.25, 'lowerarm_l.rx': -0.6, 'hand_l.rx': 0.9,
    'x_hem_b.rx': 0.06, 'x_cape_02.rx': 0.06,
}, sym=False)
TE_SH = dict(TE_UP, **{'x_lamp_r.rx': -0.98, 'upperarm_r.rx': -1.8, 'x_lamp_r.rz': 0.08})
TE_SH2 = dict(TE_UP, **{'x_lamp_r.rx': -1.2, 'upperarm_r.rx': -1.82, 'x_lamp_r.rz': -0.08})
TEARS_W = _clip({'dur': _wdur('tears'), 'hold': True, 'fade': 0.08, 'steady': True}, [(0, REST), (1, TE_W)])
TEARS = _clip({'dur': D_TEARS, 'k0': K_TEARS, 'fade': 0.03, 'out': 0.35, 'steady': True},
              [(0, TE_W), (-K_TEARS, TE_UP), (0.24, TE_SH), (0.38, TE_SH2), (0.52, TE_SH), (0.66, TE_SH2), (0.8, TE_UP), (1, REST)])

# ---------------------------------------------------------------- 引芯：压低身子、下摆往后拖、两臂往后甩；出手是一个笔直的滑行前扑，冲刺的 0.35 s 一直保持，然后收回
WI_W = _p({
    'pelvis.oy': -0.38, 'spine_01.rx': 0.2, 'spine_02.rx': 0.2, 'spine_03.rx': 0.12, 'neck_01.rx': -0.25, 'head.rx': -0.15,
    'upperarm_l.rx': 0.65, 'upperarm_l.rz': 0.28, 'lowerarm_l.rx': -0.2, 'x_lamp_l.rx': 0.35,
    'x_hem_f.rx': -0.06, 'x_hem_b.rx': 0.38, 'x_hem_l.rx': 0.2, 'x_hem_r.rx': 0.2, 'x_cape_01.rx': 0.2, 'x_cape_02.rx': 0.2, 'x_tab.rx': 0.12,
    'x_hem_f.oy': 0.36, 'x_hem_b.oy': 0.36, 'x_hem_l.oy': 0.36, 'x_hem_r.oy': 0.36,
})
WI_W = _hh(WI_W)
WI_HIT = _p({
    'pelvis.oy': -0.3, 'pelvis.oz': 0.55, 'spine_01.rx': 0.3, 'spine_02.rx': 0.26, 'spine_03.rx': 0.14, 'neck_01.rx': -0.35, 'head.rx': -0.2,
    'upperarm_l.rx': 1.0, 'upperarm_l.rz': 0.32, 'lowerarm_l.rx': -0.1, 'x_lamp_l.rx': 0.7,
    'x_hem_f.rx': 0.05, 'x_hem_b.rx': 0.55, 'x_hem_l.rx': 0.36, 'x_hem_r.rx': 0.36, 'x_cape_01.rx': 0.45, 'x_cape_02.rx': 0.4, 'x_tab.rx': 0.3,
    'x_hem_f.oy': 0.3, 'x_hem_b.oy': 0.3, 'x_hem_l.oy': 0.3, 'x_hem_r.oy': 0.3,
})
WI_HIT = _hh(WI_HIT)
WICK_W = _clip({'dur': _wdur('wick'), 'hold': True, 'fade': 0.1, 'steady': True}, [(0, REST), (1, WI_W)])
WICK = _clip({'dur': D_WICK, 'k0': K_WICK, 'fade': 0.03, 'out': 0.35, 'steady': True}, [(0, WI_W), (-K_WICK, WI_HIT), (0.68, WI_HIT), (1, REST)])

# ---------------------------------------------------------------- 冠焰螺旋：两手把灯举过头顶（接触帧举到最高），之后举着、身子慢慢左右转（弹幕一圈圈转出去），末尾放下
SP_W = _p({'upperarm_l.rx': -1.1, 'upperarm_l.rz': 0.3, 'lowerarm_l.rx': -0.4, 'spine_03.rx': -0.04, 'neck_01.rx': -0.1})
SP_W = _hh(SP_W)
SP_UP = _hh(_p({'upperarm_l.rx': -2.55, 'upperarm_l.rz': 0.32, 'lowerarm_l.rx': -0.25, 'spine_02.rx': -0.08, 'spine_03.rx': -0.06, 'neck_01.rx': -0.22, 'head.rx': -0.12,
            'x_hem_f.rx': -0.06, 'x_hem_b.rx': 0.06}))
SP_UP_L = dict(SP_UP, **{'pelvis.ry': 0.35, 'spine_02.ry': 0.12, 'upperarm_l.rx': -2.5, 'upperarm_r.rx': -2.5, 'x_hem_l.rz': 0.1, 'x_hem_r.rz': 0.04})
SP_UP_R = dict(SP_UP, **{'pelvis.ry': -0.35, 'spine_02.ry': -0.12, 'upperarm_l.rx': -2.5, 'upperarm_r.rx': -2.5, 'x_hem_l.rz': -0.04, 'x_hem_r.rz': -0.1})
SPIRAL_W = _clip({'dur': _wdur('spiral'), 'hold': True, 'fade': 0.06, 'steady': True}, [(0, REST), (1, SP_W)])
SPIRAL = _clip({'dur': D_SPIRAL, 'k0': K_SPIRAL, 'fade': 0.03, 'out': 0.35, 'steady': True},
               [(0, SP_W), (-K_SPIRAL, SP_UP), (0.3, SP_UP_L), (0.62, SP_UP_R), (0.86, SP_UP), (1, REST)])

# ---------------------------------------------------------------- 坠冕：两手举到头顶把冠摘起来、举高（冠离开兜帽 0.55 m），出手往前下方砸下去（接触帧两手最低），冠落回兜帽上
CR_MID = _hh(_p({'upperarm_l.rx': -1.6, 'upperarm_l.rz': 0.1, 'lowerarm_l.rx': -1.2, 'neck_01.rx': -0.05, 'spine_03.rx': 0.0}))
CR_UP = _hh(_p({'upperarm_l.rx': -2.25, 'upperarm_l.rz': -0.24, 'lowerarm_l.rx': -1.42, 'upperarm_l.ry': 0.0,
            'spine_01.rx': -0.02, 'spine_02.rx': -0.04, 'spine_03.rx': -0.02, 'neck_01.rx': -0.06, 'pelvis.oy': 0.12,
            'x_crown.oy': 0.5, 'x_crown.oz': 0.3, 'x_hem_f.rx': -0.06, 'x_hem_b.rx': 0.06}))
CR_HIT = _p({'upperarm_l.rx': -0.75, 'upperarm_l.rz': 0.12, 'lowerarm_l.rx': -0.15, 'hand_l.rx': 0.4, 'x_lamp_l.rx': -0.3,
             'spine_01.rx': 0.16, 'spine_02.rx': 0.3, 'spine_03.rx': 0.2, 'neck_01.rx': -0.2, 'pelvis.oy': -0.28,
             'x_crown.oy': 0.0, 'x_hem_f.rx': -0.18, 'x_hem_b.rx': 0.2, 'x_hem_l.rz': 0.14, 'x_cape_02.rx': -0.1})
CROWN_W = _clip({'dur': _wdur('crown'), 'hold': True, 'fade': 0.1, 'steady': True}, [(0, REST), (0.45, CR_MID), (0.85, CR_UP), (1, dict(CR_UP, **{'pelvis.oy': 0.15, 'spine_02.rx': -0.13}))])
CROWN = _clip({'dur': D_CROWN, 'k0': K_CROWN, 'fade': 0.03, 'out': 0.35, 'steady': True},
              [(0, dict(CR_UP, **{'pelvis.oy': 0.15, 'spine_02.rx': -0.13})), (-K_CROWN, CR_HIT), (0.5, dict(CR_HIT, **{'pelvis.oy': -0.24})), (1, REST)])

# ---------------------------------------------------------------- 暗潮：两臂往两边张开、下摆往四周掀起来（先往上提一点气），出手整个人往下沉 0.3 m（接触帧骨盆最低），下摆落回
TI_W = _p({'upperarm_l.rx': -0.25, 'upperarm_l.rz': 1.25, 'lowerarm_l.rx': -0.3, 'pelvis.oy': 0.12, 'spine_02.rx': -0.06, 'neck_01.rx': -0.16, 'head.rx': -0.06,
           'x_hem_f.rx': -0.3, 'x_hem_b.rx': 0.3, 'x_hem_l.rz': 0.3, 'x_cape_02.rx': 0.12})
TI_W = _hh(TI_W)
TI_HIT = _p({'upperarm_l.rx': -0.1, 'upperarm_l.rz': 0.9, 'lowerarm_l.rx': -0.2, 'pelvis.oy': -0.3, 'spine_02.rx': 0.12, 'spine_03.rx': 0.12, 'neck_01.rx': 0.12,
             'x_hem_f.rx': -0.42, 'x_hem_b.rx': 0.42, 'x_hem_l.rz': 0.42, 'x_cape_02.rx': -0.05})
TI_HIT = _hh(TI_HIT)
TIDE_W = _clip({'dur': _wdur('tide'), 'hold': True, 'fade': 0.12, 'steady': True}, [(0, REST), (0.7, TI_W), (1, dict(TI_W, **{'pelvis.oy': 0.16}))])
TIDE = _clip({'dur': D_TIDE, 'k0': K_TIDE, 'fade': 0.03, 'out': 0.4, 'steady': True},
             [(0, dict(TI_W, **{'pelvis.oy': 0.16})), (-K_TIDE, TI_HIT), (0.55, dict(TI_HIT, **{'pelvis.oy': -0.26, 'x_hem_f.rx': -0.12, 'x_hem_b.rx': 0.12, 'x_hem_l.rz': 0.12, 'x_hem_r.rz': -0.12})), (1, REST)])

# ---------------------------------------------------------------- 阶段换场
# 掐灯（二阶段，按 1.2 s 播）：两手把灯高举过头、灯盖张着，0.55 处两盏灯在头顶一碰、灯盖拍上（火盆随之熄灭），之后放下
LI_UP = _hh(_p({'upperarm_l.rx': -2.6, 'upperarm_l.rz': -0.04, 'lowerarm_l.rx': -0.35, 'x_lid_l.rx': -0.9,
            'spine_02.rx': -0.1, 'spine_03.rx': -0.08, 'neck_01.rx': -0.25, 'pelvis.oy': 0.18, 'x_hem_f.rx': -0.08, 'x_hem_b.rx': 0.08}))
LI_CLAP = dict(LI_UP, **{'upperarm_l.rz': -0.14, 'upperarm_r.rz': 0.14, 'x_lamp_l.rz': -0.35, 'x_lamp_r.rz': 0.35, 'x_lid_l.rx': 0.0, 'x_lid_r.rx': 0.0, 'pelvis.oy': 0.1})
LIFT = _clip({'dur': 1.2, 'k0': 0.46, 'fade': 0.1, 'out': 0.4}, [(0, REST), (0.36, LI_UP), (-0.46, LI_CLAP), (0.7, LI_CLAP), (1, REST)])
# 冠重燃（三阶段，按 1.3 s 播）：左手举到冠边、沿着冠慢慢绕半圈（一根根蜡烛重新点着，亮起来的时机在游戏端 post 里），头随后仰起来
L3_UP = _hang(_p({'upperarm_l.rx': -2.3, 'upperarm_l.rz': -0.25, 'lowerarm_l.rx': -1.35, 'neck_01.rx': 0.12, 'head.rx': 0.1}, sym=False), 'l')
L3_AROUND = dict(L3_UP, **{'upperarm_l.rz': -0.45, 'upperarm_l.ry': 0.3, 'lowerarm_l.rx': -1.1, 'neck_01.ry': -0.15})
L3_PROUD = _p({'neck_01.rx': -0.22, 'head.rx': -0.1, 'spine_03.rx': -0.06, 'spine_02.rx': -0.06, 'upperarm_l.rx': -0.5, 'upperarm_l.rz': 0.6, 'upperarm_r.rz': -0.6, 'upperarm_r.rx': -0.5,
               'x_hem_f.rx': -0.1, 'x_hem_b.rx': 0.1, 'x_hem_l.rz': 0.1})
L3_PROUD = _hh(L3_PROUD)
LIFT3 = _clip({'dur': 1.3, 'k0': 0.3, 'fade': 0.1, 'out': 0.4}, [(0, REST), (0.25, L3_UP), (0.6, L3_AROUND), (0.8, L3_PROUD), (1, REST)])

# ---------------------------------------------------------------- 破防：0.5 s 塌下去（骨盆落 1 m，袍子在地上堆开，两盏灯落在身边），之后 2 s 一个循环（loopFrom = 0.2）
HEM_OY = 0.16
POOL = _p({
    'pelvis.oy': -1.0, 'pelvis.rx': 0.12, 'spine_01.rx': 0.28, 'spine_02.rx': 0.3, 'spine_03.rx': 0.2, 'neck_01.rx': 0.3, 'head.rx': 0.25,
    'upperarm_l.rx': -0.78, 'upperarm_l.rz': 0.32, 'lowerarm_l.rx': -0.5, 'hand_l.rx': 0.6, 'x_lamp_l.rx': 0.1, 'x_lamp_l.rz': -0.15,
    'x_hem_f.oy': HEM_OY, 'x_hem_b.oy': HEM_OY, 'x_hem_l.oy': HEM_OY, 'x_hem_r.oy': HEM_OY,
    'x_hem_f.rx': -0.65, 'x_hem_b.rx': 0.65, 'x_hem_l.rz': 0.65, 'x_crown.oy': -0.04, 'x_crown.rx': 0.2,
    'x_cape_01.rx': -0.2, 'x_cape_02.rx': -0.3, 'x_tab.rx': -0.3,
})
BROKEN = {'dur': 2.5, 'loop': True, 'loopFrom': 0.2, 'fade': 0.15, 'out': 0.45, 'keys': {}}


def _broken():
    wob = {'spine_02.rx': 0.05, 'neck_01.rx': 0.06, 'pelvis.oy': 0.04, 'x_lamp_l.rz': 0.04, 'x_lamp_r.rz': -0.04}
    for k in sorted(set(POOL) | set(wob)):
        v = POOL.get(k, 0)
        w = wob.get(k, 0)
        r = REST.get(k, 0)
        BROKEN['keys'][k] = [0, r, -0.12, r + (v - r) * 1.06, 0.2, v, 0.4, v + w, 0.6, v, 0.8, v - w, 1, v]


_broken()

# ---- 受击（叠加，只动上身）：第一帧是 0，游戏端按相对第一帧的变化量叠上去 ----
HIT = {
    'dur': 0.35, 'fade': 0.02,
    'keys': {
        'spine_02.rx': [0, 0.0, 0.12, -0.12, 1, 0.0], 'spine_03.rx': [0, 0.0, 0.18, -0.08, 1, 0.0],
        'neck_01.rx': [0, 0.0, 0.2, -0.16, 1, 0.0], 'neck_01.rz': [0, 0.0, 0.2, 0.06, 1, 0.0],
        'x_lamp_l.rx': [0, 0.0, 0.2, 0.25, 0.6, -0.08, 1, 0.0], 'x_lamp_r.rx': [0, 0.0, 0.2, 0.25, 0.6, -0.08, 1, 0.0],
        'x_hem_b.rx': [0, 0.0, 0.2, 0.08, 1, 0.0],
    },
}

# ---- 阶段（持续的姿态偏移，按 ent.mood 叠上去）：二阶段起两盏灯举得更高（肘再往上弯，手腕补回去灯还是竖直吊着），头抬起来一点 ----
MOOD = {
    'dur': 0.5, 'hold': True,
    'keys': {k: [0, v, 1, v] for k, v in {'upperarm_l.rx': -0.22, 'upperarm_r.rx': -0.22, 'lowerarm_l.rx': -0.4, 'lowerarm_r.rx': -0.4,
                                          'hand_l.rx': 0.62, 'hand_r.rx': 0.62, 'neck_01.rx': -0.06}.items()},
}

# ---- 死亡 1.7 s（定格），对着 vfx3 的三段崩开：0 s 第一道裂口（头往后一仰、两臂一甩，灯脱手）、0.45 s 第二道（往下一软）、
# 0.90 s 整个人塌进袍子里砸到地上（骨盆最低，地上的冲击环同时炸开），袍子在地上摊开，冠掉到地上；之后不动，交给 0.9 s 自下而上的消散 ----
DA, DZ = -0.9, 0.6  # 死后两臂垂到地上
LX, LY, LZ = -0.2, 0.1, 1.45  # 灯落地侧躺（相对手）
CY, CZ, CRX = -0.1, 1.7, -1.2  # 冠掉到身前的地上（相对兜帽）
DEATH = {'dur': 1.7, 'hold': True, 'base': 'rest', 'air': True, 'fade': 0.1, 'extra': {'impact': 0.9}, 'keys': {}}


def _death():
    T = lambda s: s / 1.7
    a, b, c = T(0.14), T(0.45), T(0.9)
    r = lambda k: REST.get(k, 0.0)
    K = {
        'pelvis.oy': [0, 0.0, a, 0.1, b, -0.6, -c, -1.65, T(1.1), -1.6, 1, -1.62],
        'pelvis.rx': [0, 0.0, a, -0.12, b, 0.1, c, 0.3, 1, 0.32],
        'spine_01.rx': [0, 0.0, a, -0.1, b, 0.2, c, 0.3, 1, 0.32],
        'spine_02.rx': [0, 0.0, a, -0.2, b, 0.2, c, 0.25, 1, 0.26],
        'spine_03.rx': [0, r('spine_03.rx'), a, -0.15, b, 0.15, c, 0.2, 1, 0.2],
        'neck_01.rx': [0, r('neck_01.rx'), a, -0.45, b, 0.3, c, 0.35, 1, 0.4], 'neck_01.rz': [0, 0.0, c, 0.25, 1, 0.3],
        'upperarm_l.rx': [0, r('upperarm_l.rx'), a, -1.2, b, -0.4, c, DA, 1, DA], 'upperarm_l.rz': [0, r('upperarm_l.rz'), a, 0.9, b, 0.5, c, DZ, 1, DZ],
        'upperarm_r.rx': [0, r('upperarm_r.rx'), a, -1.0, b, -0.3, c, DA + 0.1, 1, DA + 0.1], 'upperarm_r.rz': [0, r('upperarm_r.rz'), a, -0.8, b, -0.5, c, -DZ, 1, -DZ],
        'lowerarm_l.rx': [0, r('lowerarm_l.rx'), a, -0.2, c, -0.2, 1, -0.2], 'lowerarm_r.rx': [0, r('lowerarm_r.rx'), a, -0.2, c, -0.2, 1, -0.2],
        'hand_l.rx': [0, r('hand_l.rx'), a, 0.0, 1, 0.0], 'hand_r.rx': [0, r('hand_r.rx'), a, 0.0, 1, 0.0],
        # 灯脱手：0.14 s 甩出去一点，0.5 s 落地侧躺（相对手的位移，手自己也在往下落）
        'x_lamp_l.ox': [0, 0.0, a, 0.15, b, LX, 1, LX], 'x_lamp_l.oy': [0, 0.0, a, 0.15, -T(0.55), LY, 1, LY], 'x_lamp_l.rz': [0, 0.0, a, 0.5, T(0.55), LZ, 1, LZ],
        'x_lamp_r.ox': [0, 0.0, a, -0.15, b, -LX, 1, -LX], 'x_lamp_r.oy': [0, 0.0, a, 0.15, -T(0.55), LY, 1, LY], 'x_lamp_r.rz': [0, 0.0, a, -0.5, T(0.55), -LZ, 1, -LZ],
        'x_hem_f.oy': [0, 0.0, b, 0.55, c, 1.55, 1, 1.52], 'x_hem_b.oy': [0, 0.0, b, 0.55, c, 1.55, 1, 1.52],
        'x_hem_l.oy': [0, 0.0, b, 0.55, c, 1.55, 1, 1.52], 'x_hem_r.oy': [0, 0.0, b, 0.55, c, 1.55, 1, 1.52],
        'x_hem_f.rx': [0, 0.0, a, -0.1, c, -0.7, 1, -0.72], 'x_hem_b.rx': [0, 0.0, a, 0.1, c, 0.7, 1, 0.72],
        'x_hem_l.rz': [0, 0.0, a, 0.1, c, 0.7, 1, 0.72], 'x_hem_r.rz': [0, 0.0, a, -0.1, c, -0.7, 1, -0.72],
        'x_cape_02.rx': [0, 0.0, b, 0.3, c, -0.3, 1, -0.3], 'x_tab.rx': [0, 0.0, b, 0.2, c, -0.4, 1, -0.4],
        # 冠：先往上一弹，之后翻着掉到地上
        'x_crown.oy': [0, 0.0, T(0.3), 0.3, -T(1.15), CY, 1, CY], 'x_crown.rx': [0, 0.0, T(1.15), CRX, 1, CRX + 0.05], 'x_crown.oz': [0, 0.0, T(1.15), CZ, 1, CZ],
    }
    DEATH['keys'] = K


_death()

CLIPS = {
    'idle': IDLE, 'walk': WALK,
    'brush_w': BRUSH_W, 'brush': BRUSH, 'tears_w': TEARS_W, 'tears': TEARS, 'wick_w': WICK_W, 'wick': WICK,
    'spiral_w': SPIRAL_W, 'spiral': SPIRAL, 'crown_w': CROWN_W, 'crown': CROWN, 'tide_w': TIDE_W, 'tide': TIDE,
    'lift': LIFT, 'lift3': LIFT3,
    'broken': BROKEN, 'hit': HIT, 'mood': MOOD, 'death': DEATH,
}
