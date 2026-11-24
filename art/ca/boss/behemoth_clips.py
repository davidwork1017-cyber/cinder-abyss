# 衔星巨兽的动作表（游戏的关节通道写法，见 art/ca/rig.py 顶上的约定）。
# 转角符号（游戏坐标，y 上、z 前）：rx > 0 = 往前俯（朝前伸的颈 / 头往下点，垂着的腿往后摆），rx < 0 = 抬头 / 腿往前迈；
# 朝后伸的尾巴 rx > 0 = 往上翘。rz > 0 = 左边（+x）往上抬（身子往右侧倒）。腿：_01 rx < 0 往前迈，_02 rx > 0 屈膝（蹄往后收）。
# 时序照 design-note §4：蓄力动作按实际播放的长度做（招式蓄力 − 出手提前量），出手动作的 k0 就是接触帧
# （流星犁地 = 前蹄砸到地上、坍缩 = 低头开始拽、吐息 = 嘴张到最开点火、践踏 = 抬起的前蹄踩到地上），k0 取在采样帧上（30 帧 / 秒）。
# 招式（模拟里的时序）一点不改：流星犁地 0.70 s、坍缩 0.60 s、吐息 0.90 s、践踏 0.95 s。
# 贴地由游戏端做（最低的那只蹄正好踩在地面上），所以这里只管腿自己的姿态；死亡（air）自己管高度。
import math

TAU = 2 * math.pi
LEGS = [(fr, sd) for fr in ('f', 'h') for sd in ('l', 'r')]


def L(fr, sd, a=0.0, b=0.0, c=0.0, z=0.0):
    """一条腿的姿态：_01 / _02 / _03 的 rx，z = _01 的 rz（往外张：左腿 +、右腿自动取反）"""
    n = 'x_%sleg_%s_' % (fr, sd)
    out = {n + '01.rx': a, n + '02.rx': b, n + '03.rx': c}
    if z:
        out[n + '01.rz'] = z if sd == 'l' else -z
    return out


def P(*ds, **kw):
    out = {}
    for d in ds:
        out.update(d)
    for k, v in kw.items():
        out[k.replace('__', '.')] = v
    return out


def track(frames, chans=None):
    """frames = [(k, 姿态, 加速冲到这一帧?)]：姿态里没写的通道 = 0（静止姿态）。返回 keys"""
    chans = sorted(chans or set(c for _, p, _ in frames for c in p))
    keys = {}
    for c in chans:
        K = []
        for k, p, acc in frames:
            K += [-k if acc else k, p.get(c, 0.0)]
        keys[c] = K
    return keys


def snap(dur, k):
    """k 落到 30 帧 / 秒的采样帧上（N = round(dur × 30)）"""
    N = max(1, round(dur * 30))
    return round(k * N) / N


# ---------------------------------------------------------------- 静止 / 移动
# 静止时头微微抬着、嘴里的星朝前上方（俯视镜头看得见）
STAND = P(head__rx=-0.1, neck_01__rx=-0.04, x_jaw__rx=0.06)

IDLE = {'dur': 2.8, 'loop': True, 'fade': 0.25, 'keys': {}}


def _idle():
    K = {}
    n = 8
    for i in range(n + 1):
        k = i / n
        a = TAU * k
        p = {
            'spine_02.rx': 0.015 * math.sin(a), 'spine_03.rx': -0.012 * math.sin(a), 'pelvis.oy': -0.02 * math.sin(a) ** 2,
            'neck_01.rx': -0.04 + 0.03 * math.sin(a + 0.6), 'x_neck_02.rx': 0.02 * math.sin(a + 1.2),
            'neck_01.ry': 0.06 * math.sin(a), 'head.ry': 0.1 * math.sin(a + 0.8), 'head.rx': -0.1 + 0.025 * math.sin(a + 1.6),
            'x_jaw.rx': 0.06 + 0.025 * math.sin(2 * a), 'x_star.ry': 0.12 * math.sin(a), 'x_star.rz': 0.08 * math.sin(a + 1.0),
            'x_tail_01.ry': 0.12 * math.sin(a), 'x_tail_02.ry': 0.16 * math.sin(a - 0.7), 'x_tail_03.ry': 0.2 * math.sin(a - 1.4), 'x_tail_01.rx': 0.06,
            'x_plate_01.oy': 0.012 * math.sin(a), 'x_plate_02.oy': 0.01 * math.sin(a - 0.4),
        }
        p.update(L('f', 'l', 0.02 * math.sin(a)))
        p.update(L('f', 'r', -0.02 * math.sin(a)))
        for c, v in p.items():
            K.setdefault(c, []).extend([k, v])
    IDLE['keys'] = K


_idle()

# 走：侧对步（左后 → 左前 → 右后 → 右前，相位各差四分之一），每条腿 65% 着地、35% 抬起往前；一个周期走 3.2 m（cycle）
PHASE = {('h', 'l'): 0.0, ('f', 'l'): 0.25, ('h', 'r'): 0.5, ('f', 'r'): 0.75}
WALK = {'dur': 1.0, 'loop': True, 'fade': 0.2, 'extra': {'cycle': 3.2}, 'keys': {}}


def _leg_walk(u, front):
    """u = 这条腿的相位（0–1）：0–0.65 着地往后蹬，0.65–1 抬起往前；返回 (_01, _02, _03)"""
    A = 0.26
    if u < 0.65:
        t = u / 0.65
        a = -A + 2 * A * t
        return a, 0.04 + 0.06 * math.sin(math.pi * t), -a * 0.6
    t = (u - 0.65) / 0.35
    a = A - 2 * A * (0.5 - 0.5 * math.cos(math.pi * t))
    lift = math.sin(math.pi * t)
    return a - 0.12 * lift, (0.75 if front else 0.6) * lift + 0.04, 0.35 * lift - a * 0.6


def _walk():
    K = {}
    n = 16
    for i in range(n + 1):
        k = i / n
        a = TAU * k
        p = {
            'pelvis.oy': -0.035 * math.cos(2 * a), 'pelvis.rz': 0.03 * math.sin(a), 'spine_02.rz': -0.02 * math.sin(a),
            'spine_03.ry': 0.03 * math.sin(a + 0.5), 'neck_01.rx': -0.02 + 0.03 * math.cos(2 * a + 0.6), 'neck_01.ry': -0.05 * math.sin(a + 0.5),
            'head.rx': -0.1 - 0.025 * math.cos(2 * a + 0.6), 'x_jaw.rx': 0.06,
            'x_tail_01.ry': 0.14 * math.sin(a + 0.4), 'x_tail_02.ry': 0.18 * math.sin(a - 0.4), 'x_tail_03.ry': 0.22 * math.sin(a - 1.2), 'x_tail_01.rx': 0.1,
        }
        for (fr, sd), ph in PHASE.items():
            x, y, z = _leg_walk((k + ph) % 1.0, fr == 'f')
            p.update(L(fr, sd, x, y, z))
        for c, v in p.items():
            K.setdefault(c, []).extend([k, v])
    WALK['keys'] = K


_walk()

# ---------------------------------------------------------------- 流星犁地（starfall）
# 蓄力 0.533 s：先往下一沉（预备），然后人立起来——后腿屈着撑地，前腿收在胸前，脖子仰起，嘴里的星越烧越亮（post 里的 heat）；
# 出手 1.20 s，k0 = 5/36（0.139 s）：前蹄砸到地上（犁地的第一道落点在这一刻结算），脑袋往下一砸，接触后再压一下，然后慢慢站稳
SF_DUR = 1.2
SF_K0 = snap(SF_DUR, 0.139)
SF_W_DUR = round(0.7 - SF_K0 * SF_DUR, 3)
REAR = P(
    L('h', 'l', 0.32, 0.5, -0.36), L('h', 'r', 0.32, 0.5, -0.36), L('f', 'l', -0.42, 1.5, 0.5), L('f', 'r', -0.34, 1.42, 0.48),
    pelvis__rx=-0.42, pelvis__oy=0.05, spine_01__rx=-0.03, spine_02__rx=-0.04, spine_03__rx=-0.05,
    neck_01__rx=0.12, x_neck_02__rx=0.04, x_neck_03__rx=0.08, head__rx=0.3, x_jaw__rx=0.32,
    x_tail_01__rx=0.5, x_tail_02__rx=0.12, x_plate_01__rx=-0.06,
)
DIP = P(
    L('h', 'l', -0.1, 0.25, -0.12), L('h', 'r', -0.1, 0.25, -0.12), L('f', 'l', -0.18, 0.4, -0.15), L('f', 'r', -0.18, 0.4, -0.15),
    pelvis__oy=-0.08, spine_03__rx=0.05, neck_01__rx=0.12, head__rx=-0.04, x_jaw__rx=0.1, x_tail_01__rx=0.15,
)
CRASH = P(
    L('h', 'l', -0.04, 0.08, -0.04), L('h', 'r', -0.04, 0.08, -0.04), L('f', 'l', -0.3, 0.42, -0.12), L('f', 'r', -0.26, 0.4, -0.12),
    pelvis__rx=0.02, pelvis__oy=-0.06, spine_01__rx=0.01, spine_02__rx=0.01, spine_03__rx=0.02,
    neck_01__rx=0.28, x_neck_02__rx=0.08, x_neck_03__rx=0.02, head__rx=0.12, x_jaw__rx=0.42,
    x_tail_01__rx=-0.1, x_plate_01__rx=0.03,
)
SQUASH = P(CRASH, L('f', 'l', -0.36, 0.62, -0.2), L('f', 'r', -0.32, 0.6, -0.2), L('h', 'l', -0.08, 0.3, -0.12), L('h', 'r', -0.08, 0.3, -0.12), pelvis__oy=-0.2, neck_01__rx=0.38, head__rx=0.18, spine_03__rx=0.08, x_jaw__rx=0.3)
STARFALL_W = {'dur': SF_W_DUR, 'hold': True, 'fade': 0.1, 'steady': True,
              'keys': track([(0, STAND, False), (0.22, DIP, False), (0.75, P(REAR, pelvis__rx=-0.38), False), (1, REAR, False)])}
STARFALL = {'dur': SF_DUR, 'k0': SF_K0, 'fade': 0.03, 'out': 0.35, 'steady': True,
            'keys': track([(0, REAR, False), (SF_K0, CRASH, True), (snap(SF_DUR, 0.2), SQUASH, False), (snap(SF_DUR, 0.45), P(CRASH, x_jaw__rx=0.2), False), (snap(SF_DUR, 0.85), P(STAND, neck_01__rx=0.04), False), (1, STAND, False)])}

# ---------------------------------------------------------------- 坍缩（gravity）
# 蓄力 0.465 s：四肢一沉伏低、前腿往外撑，脖子往下压，嘴里的星一明一暗（post）；
# 出手 1.75 s（游戏按拽的时长拉伸），k0 = 4/52：脑袋猛地压到最低、嘴张开（引力井开始拽），之后头一直压着（只有背甲和身子在脉动），
# 末尾 0.9 → 0.97 内爆时猛地往后一昂头、嘴张到最大
GR_DUR = 1.75
GR_K0 = snap(GR_DUR, 0.08)
GR_W_DUR = round(0.6 - GR_K0 * GR_DUR, 3)
CROUCH = P(
    L('f', 'l', -0.3, 0.62, -0.3, z=0.12), L('f', 'r', -0.3, 0.62, -0.3, z=0.12), L('h', 'l', 0.22, 0.68, -0.5), L('h', 'r', 0.22, 0.68, -0.5),
    pelvis__oy=-0.22, pelvis__rx=0.0, spine_03__rx=0.05, neck_01__rx=0.2, x_neck_02__rx=0.06, head__rx=0.04, x_jaw__rx=0.2,
    x_tail_01__rx=-0.1, x_plate_01__rx=-0.05, x_plate_01__oy=0.04,
)
PULL = P(CROUCH, neck_01__rx=0.4, x_neck_02__rx=0.14, x_neck_03__rx=0.04, head__rx=0.12, x_jaw__rx=0.5, pelvis__oy=-0.28, pelvis__oz=-0.08)
PULL2 = P(PULL, x_plate_01__oy=0.1, x_plate_02__oy=0.07, x_plate_03__oy=0.05, x_plate_01__rx=-0.1, spine_02__rx=-0.03, x_neck_02__rx=0.12)
RECOIL = P(CROUCH, neck_01__rx=-0.32, x_neck_02__rx=-0.08, head__rx=-0.22, x_jaw__rx=0.62, pelvis__oz=-0.22, pelvis__rx=-0.08, x_plate_01__rx=-0.14, x_plate_01__oy=0.1)
GRAVITY_W = {'dur': GR_W_DUR, 'hold': True, 'fade': 0.1, 'steady': True,
             'keys': track([(0, STAND, False), (0.7, P(CROUCH, neck_01__rx=0.16), False), (1, CROUCH, False)])}
_gk = [(0, CROUCH, False), (GR_K0, PULL, True)]
for _i, _k in enumerate((0.2, 0.32, 0.44, 0.56, 0.68, 0.8)):
    _gk.append((snap(GR_DUR, _k), PULL2 if _i % 2 == 0 else PULL, False))
_gk += [(snap(GR_DUR, 0.88), PULL, False), (snap(GR_DUR, 0.96), RECOIL, True), (1, P(RECOIL, x_jaw__rx=0.4), False)]
GRAVITY = {'dur': GR_DUR, 'k0': GR_K0, 'fade': 0.04, 'out': 0.35, 'steady': True, 'keys': track(_gk)}

# ---------------------------------------------------------------- 衔星吐息（sweep）
# 蓄力 0.765 s：低头前探、前腿撑开、重心往后坐，嘴慢慢张开（嘴里的光越聚越亮）；
# 出手 1.75 s（游戏按扫的时长拉伸，狂暴时最多 1.45 倍），k0 = 4/52：嘴猛地张到最开、头往前一顶（点火），身子往后一挫；
# 之后嘴一直张着（下颚轻轻抖），身子随射线转（模拟转根骨骼），末尾合嘴
SW_DUR = 1.75
SW_K0 = snap(SW_DUR, 0.08)
SW_W_DUR = round(0.9 - SW_K0 * SW_DUR, 3)
AIM = P(
    L('f', 'l', -0.34, 0.36, -0.1, z=0.1), L('f', 'r', -0.12, 0.3, -0.12, z=0.08), L('h', 'l', 0.08, 0.3, -0.24), L('h', 'r', 0.08, 0.3, -0.24),
    pelvis__oz=-0.12, pelvis__oy=-0.08, spine_03__rx=0.06, neck_01__rx=0.3, x_neck_02__rx=0.06, x_neck_03__rx=-0.08, head__rx=-0.16, x_jaw__rx=0.34,
    x_tail_01__rx=0.15,
)
FIRE = P(AIM, x_jaw__rx=0.66, head__rx=-0.24, x_neck_03__rx=-0.14, neck_01__rx=0.34, pelvis__oz=-0.24, spine_03__rx=0.02)
SWEEP_W = {'dur': SW_W_DUR, 'hold': True, 'fade': 0.1, 'steady': True,
           'keys': track([(0, STAND, False), (0.6, P(AIM, x_jaw__rx=0.2), False), (1, AIM, False)])}
_sk = [(0, AIM, False), (SW_K0, FIRE, True)]
for _i, _k in enumerate((0.16, 0.26, 0.36, 0.46, 0.56, 0.66, 0.76, 0.86)):
    _sk.append((snap(SW_DUR, _k), P(FIRE, x_jaw__rx=0.66 - (0.05 if _i % 2 else 0.0), spine_02__rx=0.015 * (1 if _i % 2 else -1)), False))
_sk += [(snap(SW_DUR, 0.92), FIRE, False), (1, P(AIM, x_jaw__rx=0.12, pelvis__oz=-0.05), False)]
SWEEP = {'dur': SW_DUR, 'k0': SW_K0, 'fade': 0.04, 'out': 0.3, 'steady': True, 'keys': track(_sk)}

# ---------------------------------------------------------------- 践踏（slam）
# 蓄力 0.783 s：重心挪到右边和后面，左前腿高高抬起（膝弯到胸前）、左肩抬，脖子仰起；
# 出手 0.60 s，k0 = 5/18：抬起的前蹄加速踩下去，左肩一沉、脑袋跟着点下去，接触后压一下再站稳
SL_DUR = 0.6
SL_K0 = snap(SL_DUR, 0.25)
SL_W_DUR = round(0.95 - SL_K0 * SL_DUR, 3)
LIFT = P(
    L('f', 'l', -1.05, 1.5, 0.45, z=0.05), L('f', 'r', 0.12, 0.0, -0.1, z=0.04), L('h', 'l', 0.04, 0.2, -0.14), L('h', 'r', 0.02, 0.24, -0.14),
    pelvis__rx=-0.03, pelvis__oz=-0.1, pelvis__rz=-0.04, spine_03__rz=0.1, spine_03__rx=-0.02,
    neck_01__rx=-0.2, x_neck_02__rx=-0.05, head__rx=0.08, x_jaw__rx=0.24, x_tail_01__rx=0.3,
)
STOMP = P(
    L('f', 'l', -0.34, 0.3, -0.06, z=0.04), L('f', 'r', -0.04, 0.22, -0.1, z=0.04), L('h', 'l', -0.04, 0.06, -0.02), L('h', 'r', -0.04, 0.06, -0.02),
    pelvis__rx=0.0, pelvis__oz=0.12, spine_03__rz=-0.06, spine_03__rx=0.03,
    neck_01__rx=0.3, x_neck_02__rx=0.06, head__rx=0.12, x_jaw__rx=0.36, x_tail_01__rx=-0.08,
)
STOMP2 = P(STOMP, pelvis__oy=-0.14, spine_03__rz=-0.14, neck_01__rx=0.4, head__rx=0.18)
SLAM_W = {'dur': SL_W_DUR, 'hold': True, 'fade': 0.12, 'steady': True,
          'keys': track([(0, STAND, False), (0.45, P(LIFT, x_fleg_l_01__rx=-0.6, x_fleg_l_02__rx=0.9, x_fleg_l_03__rx=0.3, pelvis__rx=-0.06), False), (0.85, P(LIFT, x_fleg_l_01__rx=-1.08), False), (1, LIFT, False)])}
SLAM = {'dur': SL_DUR, 'k0': SL_K0, 'fade': 0.03, 'out': 0.35, 'steady': True,
        'keys': track([(0, LIFT, False), (SL_K0, STOMP, True), (snap(SL_DUR, 0.38), STOMP2, False), (snap(SL_DUR, 0.62), P(STOMP, pelvis__oy=-0.04), False), (1, STAND, False)])}

# ---------------------------------------------------------------- 破防：0.5 s 前腿一折跪下（前膝着地）、头垂下来，之后 2 s 一个循环（loopFrom = 0.2）
# 姿势收得紧：跪在原地、头不往前伸出去（不盖住地上的下一道预警）
KNEEL = P(
    L('f', 'l', 0.2, 2.0, 0.8), L('f', 'r', 0.16, 1.95, 0.8), L('h', 'l', -0.38, 0.5, -0.12), L('h', 'r', -0.38, 0.5, -0.12),
    pelvis__rx=0.42, pelvis__oy=-0.12, spine_01__rx=0.03, spine_02__rx=0.03, spine_03__rx=0.0,
    neck_01__rx=-0.1, x_neck_02__rx=0.06, x_neck_03__rx=0.08, head__rx=0.14, x_jaw__rx=0.3,
    x_tail_01__rx=-0.25, x_tail_02__rx=-0.15, x_plate_01__rx=0.04,
)
BROKEN = {'dur': 2.5, 'loop': True, 'loopFrom': 0.2, 'fade': 0.15, 'out': 0.45, 'keys': {}}


def _broken():
    wob = {'neck_01.rx': 0.05, 'head.rx': 0.06, 'head.rz': 0.1, 'x_jaw.rx': 0.08, 'spine_02.rz': 0.03, 'x_tail_01.ry': 0.15}
    chans = set(KNEEL) | set(wob)
    K = {}
    for c in chans:
        v, w = KNEEL.get(c, 0.0), wob.get(c, 0.0)
        # 0 → 0.2：垮下去（0.12 那一下砸到底再弹一点）；0.2 → 1：慢慢晃（0.2 和 1 的值一样，循环接得上）
        K[c] = [0, 0.0, -0.12, v * 1.06, 0.2, v, 0.4, v + w, 0.6, v, 0.8, v - w, 1, v]
    BROKEN['keys'] = K


_broken()

# ---------------------------------------------------------------- 受击（叠加，只动前半身）：第一帧是 0，游戏端按相对第一帧的变化量叠上去
HIT = {
    'dur': 0.35, 'fade': 0.02,
    'keys': {
        'spine_03.rx': [0, 0.0, 0.12, -0.06, 1, 0.0], 'neck_01.rx': [0, 0.0, 0.15, -0.12, 1, 0.0], 'head.rx': [0, 0.0, 0.18, -0.16, 1, 0.0],
        'head.rz': [0, 0.0, 0.18, 0.08, 1, 0.0], 'x_jaw.rx': [0, 0.0, 0.14, 0.16, 1, 0.0], 'x_tail_01.rx': [0, 0.0, 0.2, 0.12, 1, 0.0],
    },
}

# ---------------------------------------------------------------- 狂暴（持续的姿态偏移，按 ent.mood 叠上去）：背甲掀起来、头再抬一点、嘴张大一点（星更亮、更露在外面）
MOOD = {
    'dur': 0.5, 'hold': True,
    'keys': {
        'x_plate_01.rx': [0, -0.12, 1, -0.12], 'x_plate_01.oy': [0, 0.09, 1, 0.09], 'x_plate_02.oy': [0, 0.07, 1, 0.07], 'x_plate_02.rx': [0, -0.06, 1, -0.06],
        'x_plate_03.oy': [0, 0.06, 1, 0.06], 'x_plate_03.rx': [0, 0.06, 1, 0.06],
        'neck_01.rx': [0, -0.06, 1, -0.06], 'head.rx': [0, -0.06, 1, -0.06], 'x_jaw.rx': [0, 0.08, 1, 0.08], 'x_tail_01.rx': [0, 0.12, 1, 0.12],
    },
}

# ---------------------------------------------------------------- 死亡 1.6 s（定格），对着 vfx3 的三段崩开：0 s 第一道裂口（人立着往后一仰、张嘴）、
# 0.45 s 第二道（四条腿一软、往下坠）、0.90 s 侧身砸到地上（地上的冲击环同时炸开），之后压实不动，再交给 0.9 s 自下而上的消散。base = rest、air（自己管高度）
DEATH = {'dur': 1.6, 'hold': True, 'base': 'rest', 'air': True, 'fade': 0.1, 'extra': {'impact': 0.9}, 'keys': {}}


def _death():
    T = lambda s: s / 1.6
    a, b, c, d = T(0.16), T(0.45), T(0.9), T(1.05)
    K = {
        'pelvis.rx': [0, 0.0, a, -0.26, b, 0.06, c, 0.08, 1, 0.08],
        'pelvis.rz': [0, 0.0, a, 0.03, b, 0.18, -c, 1.32, d, 1.26, 1, 1.29],
        'pelvis.oy': [0, 0.0, a, 0.08, b, -0.55, -c, -1.48, d, -1.4, 1, -1.44],
        'pelvis.ox': [0, 0.0, b, 0.1, -c, 0.55, 1, 0.58],
        'spine_02.rz': [0, 0.0, b, 0.05, c, 0.08, 1, 0.06],
        'spine_03.rx': [0, 0.0, a, -0.08, b, 0.06, c, 0.0, 1, 0.0],
        'neck_01.rx': [0, 0.0, a, -0.4, b, 0.1, c, 0.2, d, 0.28, 1, 0.26],
        'neck_01.rz': [0, 0.0, b, -0.1, c, -0.5, d, -0.62, 1, -0.6],
        'x_neck_02.rz': [0, 0.0, c, -0.25, 1, -0.3],
        'head.rx': [0, 0.0, a, -0.3, b, 0.3, c, 0.1, 1, 0.12], 'head.rz': [0, 0.0, c, -0.3, 1, -0.34],
        'x_jaw.rx': [0, 0.06, a, 0.62, b, 0.4, c, 0.5, 1, 0.38],
        'x_tail_01.rx': [0, 0.0, a, 0.4, b, 0.0, c, -0.2, 1, -0.15], 'x_tail_01.ry': [0, 0.0, c, 0.4, 1, 0.45],
        'x_plate_01.rx': [0, 0.0, b, -0.08, c, 0.1, 1, 0.08],
    }
    legs = {
        # 0.45 s 腿一软（屈），0.9 s 侧躺：上面那一侧的腿松垂、下面那一侧的压在身下往前伸
        ('f', 'l'): (L('f', 'l', -0.6, 1.0, 0.3), L('f', 'l', -0.1, 0.7, 0.3, z=-0.55)),
        ('f', 'r'): (L('f', 'r', -0.5, 1.1, 0.3), L('f', 'r', -0.7, 0.3, 0.2, z=-0.7)),
        ('h', 'l'): (L('h', 'l', 0.2, 0.9, -0.3), L('h', 'l', 0.1, 0.5, 0.2, z=-0.5)),
        ('h', 'r'): (L('h', 'r', 0.3, 0.8, -0.3), L('h', 'r', 0.4, 0.3, 0.1, z=-0.6)),
    }
    for (fr, sd), (mid, end) in legs.items():
        rear = L(fr, sd, 0.3, 0.3, -0.2) if fr == 'h' else L(fr, sd, -0.5, 1.0, 0.3)
        for ch in sorted(set(mid) | set(end) | set(rear)):
            K[ch] = [0, 0.0, a, rear.get(ch, 0.0), b, mid.get(ch, 0.0), c, end.get(ch, 0.0), 1, end.get(ch, 0.0)]
    DEATH['keys'] = K


_death()

CLIPS = {
    'idle': IDLE, 'walk': WALK,
    'starfall_w': STARFALL_W, 'starfall': STARFALL, 'gravity_w': GRAVITY_W, 'gravity': GRAVITY,
    'sweep_w': SWEEP_W, 'sweep': SWEEP, 'slam_w': SLAM_W, 'slam': SLAM,
    'broken': BROKEN, 'hit': HIT, 'mood': MOOD, 'death': DEATH,
}
