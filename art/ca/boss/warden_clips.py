# 雷霆监察者的动作表（游戏的关节通道写法，见 art/ca/rig.py 顶上的约定）。
# 转角符号（游戏坐标，y 上、z 前）：竖直的柱身 rx > 0 = 往前倾；手（掌心朝下、指头朝前）rx < 0 = 指尖往上翘，ry > 0 = 左手指尖往外（左）摆，
# rz < 0 = 左手外沿往下（掌心朝里；R = Rx · Ry · Rz：先绕指头的方向滚、再摆、最后俯仰）；
# 指节 rx > 0 = 往掌心里弯；眼睑：上眼睑 rx > 0 = 往下合，下眼睑 rx < 0 = 往上合。
# 两道环和护盾板的转动、环的收缩 / 张开在游戏端按时钟做（BOSS_SPEC.warden 的 rings / ringK），不进动作表；这里只给环的歪斜和起落。
# 时序照 design-note §4：蓄力动作按实际播放的长度做（招式蓄力 − 出手提前量），出手动作的 k0 就是接触帧
# （十字 = 双手往两边劈开到最开、轰炸 = 双手举到最高、冲锋 = 整台机器冲到最前、雷环 = 双手甩开到最开），k0 取在采样帧上（30 帧 / 秒）。
# 招式（模拟里的时序）一点不改：十字 0.90 s（两下：0.90 / 1.50）、轰炸 0.30 s、冲锋 0.75 s（冲刺 0.75–1.0）、雷环 0.45 s。
# 没有脚（悬浮）：游戏端不贴地，悬浮的起伏、破防时坠到底环上、死亡砸地都在这里的骨盆高度里。
import math

TAU = 2 * math.pi
PLATES = ('x_plate_01', 'x_plate_02', 'x_plate_03')
PLATE_A = (0.0, TAU / 3, 2 * TAU / 3)


def P(*ds, **kw):
    out = {}
    for d in ds:
        out.update(d)
    for k, v in kw.items():
        out[k.replace('__', '.')] = v
    return out


def hand(sd, rx=0.0, ry=0.0, rz=0.0, ox=0.0, oy=0.0, oz=0.0, curl=(0.0, 0.0, 0.0), th=0.0):
    """一只手（按左手写：ox > 0 = 往外，ry / rz 右手自动取反）；curl = 三节指的弯曲；th = 拇指往掌心里收"""
    f = 1 if sd == 'l' else -1
    out = {'hand_%s.rx' % sd: rx, 'hand_%s.ry' % sd: ry * f, 'hand_%s.rz' % sd: rz * f,
           'hand_%s.ox' % sd: ox * f, 'hand_%s.oy' % sd: oy, 'hand_%s.oz' % sd: oz,
           'x_finger_%s_01.rx' % sd: curl[0], 'x_finger_%s_02.rx' % sd: curl[1], 'x_finger_%s_03.rx' % sd: curl[2],
           'x_thumb_%s.ry' % sd: -th * f, 'x_thumb_%s.rx' % sd: th * 0.5}
    return out


def hands(**kw):
    out = hand('l', **kw)
    out.update(hand('r', **kw))
    return out


def plates(out=0.0, oy=0.0, rx=0.0):
    """三块护盾板一起：out = 沿各自的径向往外（< 0 往里收），oy = 起落，rx = 绕板自己的横轴往外倒（近似：按径向分到 rx / rz）"""
    d = {}
    for b, a in zip(PLATES, PLATE_A):
        s, c = math.sin(a), math.cos(a)
        d[b + '.ox'] = s * out
        d[b + '.oz'] = c * out
        d[b + '.oy'] = oy
        if rx:
            d[b + '.rx'] = c * rx
            d[b + '.rz'] = -s * rx
    return d


def lids(t=0.0, b=0.0):
    """t > 0 上眼睑往下合，b > 0 下眼睑往上合（< 0 = 睁大）"""
    return {'x_lid_t.rx': t, 'x_lid_b.rx': -b}


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


def pre(dur, k0):
    """k0 前一帧：接触姿势在这一帧就到位、一直钉到 k0（预警结算可能比动作的接触帧早一帧）"""
    N = max(1, round(dur * 30))
    return round(k0 * N - 1) / N


# ---------------------------------------------------------------- 静止 / 移动
# 静止：两道环各自歪着（外环往前上方歪、内环往左后歪，俯视是两道交叉的椭圆），两只手掌心朝下、指头微屈，悬在柱身两侧略靠前
RINGS = {'x_ring_a.rx': 0.34, 'x_ring_a.rz': 0.14, 'x_ring_b.rx': -0.24, 'x_ring_b.rz': -0.32}
BASE_LIFT = 0.32  # 底环在游戏里悬在离地 0.32 m（静止姿态里它放在地上：check-art 要求最低点贴地）
STAND = P(RINGS, {'x_base.oy': BASE_LIFT}, hands(rx=0.1, rz=-0.22, curl=(0.3, 0.4, 0.3), th=0.25), lids(0.06, 0.04))

IDLE = {'dur': 2.4, 'loop': True, 'fade': 0.25, 'keys': {}}


def _idle():
    K = {}
    n = 8
    for i in range(n + 1):
        k = i / n
        a = TAU * k
        p = dict(STAND)
        bob = 0.09 * math.sin(a)
        p.update({
            'pelvis.oy': bob, 'x_base.oy': BASE_LIFT - 0.55 * bob, 'pelvis.rx': 0.02 * math.sin(a + 0.8), 'pelvis.rz': 0.015 * math.sin(a + 2.1),
            'head.ry': 0.22 * math.sin(a), 'head.rx': 0.04 * math.sin(2 * a + 0.5),
            'x_ring_a.rx': 0.34 + 0.05 * math.sin(a + 1.0), 'x_ring_b.rz': -0.32 + 0.05 * math.sin(a + 2.5),
            'x_ring_a.oy': 0.04 * math.sin(a + 0.7), 'x_ring_b.oy': -0.04 * math.sin(a + 0.4),
            'hand_l.oy': 0.12 * math.sin(a + 1.0), 'hand_r.oy': 0.12 * math.sin(a + 2.2),
            'hand_l.rz': -0.22 - 0.06 * math.sin(a + 0.3), 'hand_r.rz': 0.22 + 0.06 * math.sin(a + 1.6),
            'x_finger_l_01.rx': 0.3 + 0.1 * math.sin(2 * a), 'x_finger_r_01.rx': 0.3 + 0.1 * math.sin(2 * a + 1.3),
            'x_lid_t.rx': 0.06 + 0.04 * max(0.0, math.sin(2 * a - 1.0)) ** 4 * 5,
        })
        for j, b in enumerate(PLATES):
            p[b + '.oy'] = 0.07 * math.sin(a + j * TAU / 3)
        for c, v in p.items():
            K.setdefault(c, []).extend([k, v])
    IDLE['keys'] = K


_idle()

# 走（滑行）：整台机器往前倾一点，一个周期滑 1.6 m、起伏一次；底环落后一点（往后歪），两只手往后拖、护盾板往后倒
WALK = {'dur': 1.0, 'loop': True, 'fade': 0.2, 'extra': {'cycle': 1.6}, 'keys': {}}


def _walk():
    K = {}
    n = 16
    for i in range(n + 1):
        k = i / n
        a = TAU * k
        p = dict(STAND)
        p.update(hands(rx=-0.05, rz=-0.3, oz=-0.35, oy=0.1, curl=(0.4, 0.5, 0.35), th=0.3))
        p.update(plates(rx=-0.1))
        p.update({
            'pelvis.rx': 0.12, 'pelvis.oy': 0.07 * math.sin(a), 'x_base.rx': -0.1, 'x_base.oy': BASE_LIFT - 0.04 * math.sin(a - 0.6),
            'pelvis.rz': 0.03 * math.sin(a), 'head.rx': -0.06, 'head.ry': 0.05 * math.sin(a),
            'hand_l.oy': 0.1 + 0.08 * math.sin(a + 0.9), 'hand_r.oy': 0.1 + 0.08 * math.sin(a + 0.9 + math.pi),
            'x_ring_a.rx': 0.42, 'x_ring_b.rx': -0.1,
        })
        for c, v in p.items():
            K.setdefault(c, []).extend([k, v])
    WALK['keys'] = K


_walk()

# ---------------------------------------------------------------- 十字（cross）：两下，每下双手从 X 锁劈开一次
# 蓄力 0.767 s：柱身往后仰、眼往上看，双手升到眼匣前面、在手腕处交叉锁成 X（指头张开），环加速（游戏端）；
# 出手 0.60 s，k0 = 4/18：双手沿十字的两条斜线往前下方劈开到最开，柱身往前一顿；之后回到 X 锁（第二下接着从同一个姿势劈：首尾一样）
CROSS_DUR = 0.6
CROSS_K0 = snap(CROSS_DUR, 0.25)
CROSS_W_DUR = round(0.9 - CROSS_K0 * CROSS_DUR, 3)
XLOCK = P(STAND, hand('l', rx=-0.9, ry=0.55, ox=-2.18, oy=0.6, oz=0.78, curl=(0.05, 0.08, 0.05), th=-0.2),
          hand('r', rx=-0.9, ry=0.55, ox=-2.18, oy=0.68, oz=0.62, curl=(0.05, 0.08, 0.05), th=-0.2),
          lids(-0.1, -0.06), x_column__rx=-0.17, head__rx=-0.22, pelvis__oy=0.18, x_ring_a__rx=0.1, x_ring_b__rx=-0.08)
APART = P(STAND, hands(rx=-0.25, ry=0.45, rz=0.85, ox=0.85, oy=0.15, oz=1.0, curl=(-0.1, -0.05, 0.0), th=-0.3),
          lids(-0.12, -0.08), x_column__rx=0.14, head__rx=0.12, pelvis__oy=-0.06, pelvis__rx=0.04, x_ring_a__rx=0.5, x_ring_b__rx=-0.4)
CROSS_W = {'dur': CROSS_W_DUR, 'hold': True, 'fade': 0.1, 'steady': True,
           'keys': track([(0, STAND, False), (0.55, P(XLOCK, hand_l__oy=0.4, hand_r__oy=0.45, x_column__rx=-0.1), False), (0.85, XLOCK, False), (1, P(XLOCK, x_column__rx=-0.19), False)])}
CROSS = {'dur': CROSS_DUR, 'k0': CROSS_K0, 'fade': 0.04, 'out': 0.3, 'steady': True,
         'keys': track([(0, P(XLOCK, x_column__rx=-0.19), False), (pre(CROSS_DUR, CROSS_K0), APART, True), (CROSS_K0, APART, False),
                        (snap(CROSS_DUR, 0.5), P(APART, hand_l__ox=0.78, hand_r__ox=-0.78, x_column__rx=0.08), False), (1, P(XLOCK, x_column__rx=-0.19), False)])}

# ---------------------------------------------------------------- 轰炸（barrage）
# 蓄力 0.167 s：双手往两边张开、往上抬，护盾板升起来；出手 1.20 s（游戏按轰炸的时长拉伸），k0 = 4/36：双手举到最高、眼睁到最大，
# 之后双手一上一下交替着往下压（都比 k0 那一下低），护盾板一直悬在高处，末尾放下
BAR_DUR = 1.2
BAR_K0 = snap(BAR_DUR, 0.1)
BAR_W_DUR = round(0.3 - BAR_K0 * BAR_DUR, 3)
SPREAD = P(STAND, hands(rx=-0.6, rz=0.9, ox=0.5, oy=0.9, oz=0.2, curl=(0.0, 0.05, 0.0), th=-0.3), plates(oy=0.35, out=0.15, rx=0.2),
           lids(-0.12, -0.08), head__rx=-0.2, x_column__rx=-0.06)
BPEAK = P(SPREAD, hands(rx=-0.9, rz=1.0, ox=0.6, oy=1.45, oz=0.1, curl=(-0.1, -0.05, 0.0), th=-0.35), plates(oy=0.45, out=0.2, rx=0.25),
          lids(-0.18, -0.12), head__rx=-0.3, x_column__rx=-0.1, pelvis__oy=0.15)
BARRAGE_W = {'dur': BAR_W_DUR, 'hold': True, 'fade': 0.06, 'steady': True, 'keys': track([(0, STAND, False), (1, SPREAD, False)])}
_bk = [(0, SPREAD, False), (pre(BAR_DUR, BAR_K0), BPEAK, True), (BAR_K0, BPEAK, False)]
for _i, _k in enumerate((0.24, 0.38, 0.52, 0.66, 0.8)):
    s = 1 if _i % 2 == 0 else -1
    _bk.append((snap(BAR_DUR, _k), P(BPEAK, hand('l', rx=-0.3 - 0.3 * s, rz=0.9, ox=0.6, oy=1.0 + 0.25 * s, oz=0.3, curl=(0.2, 0.3, 0.2)),
                                     hand('r', rx=-0.3 + 0.3 * s, rz=0.9, ox=0.6, oy=1.0 - 0.25 * s, oz=0.3, curl=(0.2, 0.3, 0.2)),
                                     x_column__rx=-0.04 + 0.04 * s, pelvis__oy=0.1), False))
_bk += [(snap(BAR_DUR, 0.9), P(SPREAD, plates(oy=0.2)), False), (1, STAND, False)]
BARRAGE = {'dur': BAR_DUR, 'k0': BAR_K0, 'fade': 0.04, 'out': 0.3, 'steady': True, 'keys': track(_bk)}

# ---------------------------------------------------------------- 冲锋（charge）
# 蓄力 0.614 s：眼眯起来（上下眼睑合上一半）、整台机器往前倾 25°，双手往后收、握成拳，护盾板往里收紧贴着柱身；
# 出手 0.75 s，k0 = 4/22：往前冲出去（骨盆冲到最前），冲刺的 0.25 s 一直保持，之后一刹、立直
CH_DUR = 0.75
CH_K0 = snap(CH_DUR, 0.2)
CH_W_DUR = round(0.75 - CH_K0 * CH_DUR, 3)
FIST = (1.2, 1.35, 1.0)
CROUCH = P(STAND, hands(rx=0.45, rz=0.35, ox=-0.35, oy=0.45, oz=-1.15, curl=FIST, th=0.9), plates(out=-0.55, rx=-0.2, oy=0.1), lids(0.42, 0.34),
           pelvis__rx=0.44, pelvis__oz=-0.3, pelvis__oy=-0.1, head__rx=-0.32, x_base__rx=-0.2, x_ring_a__rx=0.6, x_ring_b__rx=-0.5)
LUNGE = P(CROUCH, hands(rx=0.3, rz=0.3, ox=-0.4, oy=0.3, oz=-0.95, curl=FIST, th=0.9), lids(0.45, 0.36), pelvis__rx=0.5, pelvis__oz=0.6, pelvis__oy=-0.18, head__rx=-0.38)
CHARGE_W = {'dur': CH_W_DUR, 'hold': True, 'fade': 0.1, 'steady': True, 'keys': track([(0, STAND, False), (0.7, P(CROUCH, pelvis__rx=0.38), False), (1, CROUCH, False)])}
CHARGE = {'dur': CH_DUR, 'k0': CH_K0, 'fade': 0.04, 'out': 0.3, 'steady': True,
          'keys': track([(0, CROUCH, False), (pre(CH_DUR, CH_K0), LUNGE, True), (CH_K0, LUNGE, False), (snap(CH_DUR, 0.5), LUNGE, False),
                         (snap(CH_DUR, 0.68), P(STAND, lids(0.1, 0.06), pelvis__rx=-0.12, pelvis__oz=0.3), False), (1, STAND, False)])}

# ---------------------------------------------------------------- 雷环（ring）
# 蓄力 0.317 s：两道环停转、收紧（游戏端），身子往下一沉，双手在柱身前合拢（掌心相对）；
# 出手 0.60 s，k0 = 4/18：双手往两边甩开到最开、整台机器往上一弹、环猛地张开转起来（游戏端），之后慢慢回到静止
RING_DUR = 0.6
RING_K0 = snap(RING_DUR, 0.2)
RING_W_DUR = round(0.45 - RING_K0 * RING_DUR, 3)
CLOSE = P(STAND, hands(rx=-0.2, rz=-1.25, ox=-1.3, oy=0.2, oz=0.7, curl=(0.2, 0.3, 0.2), th=0.1), plates(out=-0.2, oy=-0.1), lids(0.2, 0.15),
          pelvis__oy=-0.18, head__rx=0.08, x_ring_a__rx=0.05, x_ring_a__rz=0.02, x_ring_b__rx=-0.04, x_ring_b__rz=-0.03)
FLING = P(STAND, hands(rx=-0.35, rz=0.7, ox=1.0, oy=0.5, oz=0.3, curl=(-0.1, -0.05, 0.0), th=-0.35), plates(out=0.45, oy=0.15, rx=0.35), lids(-0.15, -0.1),
          pelvis__oy=0.22, head__rx=-0.12, x_ring_a__rx=0.6, x_ring_a__rz=0.3, x_ring_b__rx=-0.55, x_ring_b__rz=-0.5)
RING_W = {'dur': RING_W_DUR, 'hold': True, 'fade': 0.08, 'steady': True, 'keys': track([(0, STAND, False), (0.7, P(CLOSE, pelvis__oy=-0.14), False), (1, CLOSE, False)])}
RING = {'dur': RING_DUR, 'k0': RING_K0, 'fade': 0.03, 'out': 0.3, 'steady': True,
        'keys': track([(0, CLOSE, False), (pre(RING_DUR, RING_K0), FLING, True), (RING_K0, FLING, False),
                       (snap(RING_DUR, 0.45), P(FLING, hand_l__ox=0.85, hand_r__ox=-0.85, pelvis__oy=0.12), False), (1, STAND, False)])}

# ---------------------------------------------------------------- 破防：0.5 s 失去动力、坠到底环上（底环落地，柱身往下坐进底环），歪向一边，
# 双手掉到地上、指头摊开，两道环滑落、斜靠着，护盾板往下坠；之后 2 s 一个循环（loopFrom = 0.2）。姿势收在原地，不往前倒（不盖住下一道预警）
SLUMP = P(
    hand('l', rx=0.35, rz=0.4, ox=0.15, oy=-1.79, oz=-0.1, curl=(0.15, 0.25, 0.2), th=0.1),
    hand('r', rx=0.25, rz=0.2, ox=0.05, oy=-1.81, oz=0.15, curl=(0.25, 0.35, 0.3), th=0.2),
    plates(oy=-0.86, out=0.1, rx=0.35), lids(0.42, 0.18),
    pelvis__oy=-0.4, x_base__oy=0.4, x_column__oy=-0.2, x_column__rz=0.12, x_column__rx=0.05, head__rx=0.32, head__rz=0.1,
    x_ring_a__oy=-1.06, x_ring_a__rx=0.3, x_ring_a__rz=0.36, x_ring_b__oy=-0.86, x_ring_b__rx=-0.32, x_ring_b__rz=-0.28,
    x_rod_l__rz=0.12, x_rod_r__rz=0.06,
)
BROKEN = {'dur': 2.5, 'loop': True, 'loopFrom': 0.2, 'fade': 0.15, 'out': 0.45, 'keys': {}}


def _broken():
    wob = {'head.rx': 0.05, 'head.rz': 0.06, 'x_column.rz': 0.02, 'x_lid_t.rx': -0.08, 'x_finger_l_01.rx': 0.12, 'x_finger_r_02.rx': -0.1}
    chans = set(SLUMP) | set(wob) | set(STAND)
    K = {}
    for c in sorted(chans):
        v, w = SLUMP.get(c, STAND.get(c, 0.0) if c.startswith('x_ring') else 0.0), wob.get(c, 0.0)
        # 0 → 0.2：坠下去（0.12 那一下坠到底再弹一点）；0.2 → 1：轻轻抽一下（0.2 和 1 的值一样，循环接得上）
        K[c] = [0, STAND.get(c, 0.0), -0.12, v * 1.05, 0.2, v, 0.4, v + w, 0.6, v, 0.8, v - w, 1, v]
    BROKEN['keys'] = K


_broken()

# ---------------------------------------------------------------- 受击（叠加）：第一帧是 0，游戏端按相对第一帧的变化量叠上去
HIT = {
    'dur': 0.32, 'fade': 0.02,
    'keys': {
        'pelvis.rx': [0, 0.0, 0.16, -0.07, 1, 0.0], 'x_column.rx': [0, 0.0, 0.16, -0.05, 1, 0.0], 'head.rx': [0, 0.0, 0.2, -0.14, 1, 0.0], 'head.rz': [0, 0.0, 0.2, 0.06, 1, 0.0],
        'x_lid_t.rx': [0, 0.0, 0.12, 0.3, 1, 0.0], 'x_lid_b.rx': [0, 0.0, 0.12, -0.25, 1, 0.0],
        'hand_l.oy': [0, 0.0, 0.2, 0.14, 1, 0.0], 'hand_r.oy': [0, 0.0, 0.2, 0.12, 1, 0.0], 'hand_l.rx': [0, 0.0, 0.2, -0.2, 1, 0.0], 'hand_r.rx': [0, 0.0, 0.2, -0.2, 1, 0.0],
    },
}

# ---------------------------------------------------------------- 狂暴（持续的姿态偏移，按 ent.mood 叠上去）：环转得更快（游戏端），两根避雷杆往外张、眼睁大，护盾板往外撑开、往外倒
MOOD = {
    'dur': 0.5, 'hold': True,
    'keys': {
        'x_rod_l.rz': [0, 0.16, 1, 0.16], 'x_rod_r.rz': [0, -0.16, 1, -0.16], 'x_lid_t.rx': [0, -0.1, 1, -0.1], 'x_lid_b.rx': [0, 0.08, 1, 0.08],
        'head.rx': [0, -0.05, 1, -0.05], 'hand_l.oy': [0, 0.15, 1, 0.15], 'hand_r.oy': [0, 0.15, 1, 0.15],
    },
}
for _b, _a in zip(PLATES, PLATE_A):
    MOOD['keys'][_b + '.ox'] = [0, math.sin(_a) * 0.25, 1, math.sin(_a) * 0.25]
    MOOD['keys'][_b + '.oz'] = [0, math.cos(_a) * 0.25, 1, math.cos(_a) * 0.25]

# ---------------------------------------------------------------- 死亡 1.6 s（定格），对着 vfx3 的三段崩开：0 s 第一道裂口（柱身往后一抽、眼睁到最大、双手甩开）、
# 0.45 s 第二道（失去动力：整台机器往下坠，两道环、护盾板、手开始往下掉）、0.90 s 底环落地、柱身坐进底环、往右边整个倒下去，
# 眼匣砸到地上（地上的冲击环同时炸开）；之后环、护盾板、手都摊在地上，再交给 0.9 s 自下而上的消散。
# 骨盆只往下落、不转（手、环、护盾板都挂在骨盆上：直着往下掉到地上），倒下去的是柱身（x_column 的枢轴在柱底）。base = rest、air（自己管高度）
DEATH = {'dur': 1.6, 'hold': True, 'base': 'rest', 'air': True, 'fade': 0.1, 'extra': {'impact': 0.9}, 'keys': {}}


def _death():
    T = lambda s: s / 1.6
    a, b, c, d = T(0.14), T(0.45), T(0.9), T(1.05)
    K = {
        'pelvis.oy': [0, 0.0, a, 0.12, b, -0.1, -c, -0.34, d, -0.3, 1, -0.31],
        'pelvis.rx': [0, 0.0, a, -0.06, b, 0.0, 1, 0.0],
        'x_column.oy': [0, 0.0, b, -0.05, -c, -0.5, 1, -0.5],
        'x_base.oy': [0, BASE_LIFT, a, BASE_LIFT - 0.1, b, 0.25, -c, 0.34, d, 0.3, 1, 0.31],
        'x_column.rz': [0, 0.0, a, -0.1, b, 0.25, -c, 1.36, d, 1.3, 1, 1.32],
        'x_column.rx': [0, 0.0, a, -0.16, b, 0.04, 1, 0.1],
        'head.rx': [0, 0.0, a, -0.3, b, 0.15, c, 0.3, 1, 0.32],
        'x_lid_t.rx': [0, 0.0, a, -0.18, b, 0.1, c, 0.4, 1, 0.55], 'x_lid_b.rx': [0, 0.0, a, 0.14, c, -0.25, 1, -0.4],
        'x_ring_a.oy': [0, 0.0, a, 0.2, b, 0.1, -c, -1.78, d, -1.72, 1, -1.76], 'x_ring_a.rx': [0, 0.34, b, 0.5, c, 0.3, 1, 0.28], 'x_ring_a.rz': [0, 0.14, c, -0.05, 1, -0.06],
        'x_ring_b.oy': [0, 0.0, a, 0.1, b, 0.0, -min(0.99, c + 0.04), -1.44, 1, -1.42], 'x_ring_b.rz': [0, -0.32, b, -0.45, c, -0.2, 1, -0.22], 'x_ring_b.rx': [0, -0.24, c, 0.06, 1, 0.05],
        'x_rod_l.rz': [0, 0.0, a, 0.3, c, -0.2, 1, -0.25], 'x_rod_r.rz': [0, 0.0, a, -0.3, c, 0.35, 1, 0.4],
    }
    for sd, f in (('l', 1), ('r', -1)):
        h0 = hand(sd, rx=0.1, rz=-0.22, curl=(0.3, 0.4, 0.3), th=0.25)
        h1 = hand(sd, rx=-0.8, rz=0.6, ox=0.7, oy=1.1, oz=0.2, curl=(-0.1, -0.05, 0.0), th=-0.3)
        h2 = hand(sd, rx=0.6, rz=0.3, ox=0.5, oy=0.2, oz=0.1, curl=(0.4, 0.5, 0.4), th=0.2)
        h3 = hand(sd, rx=0.12, rz=-0.25 - 0.15 * f, ox=0.45 + 0.2 * f, oy=-1.96, oz=0.15 + 0.2 * f, curl=(0.45, 0.55, 0.4), th=0.4)
        for ch in sorted(set(h0) | set(h1) | set(h2) | set(h3)):
            K[ch] = [0, h0.get(ch, 0.0), a, h1.get(ch, 0.0), b, h2.get(ch, 0.0), -min(0.99, c + 0.03 * (f + 1)), h3.get(ch, 0.0), 1, h3.get(ch, 0.0)]
    for i, (pb, pa) in enumerate(zip(PLATES, PLATE_A)):
        s, co = math.sin(pa), math.cos(pa)
        K[pb + '.oy'] = [0, 0.0, a, 0.25, b + 0.04 * i, 0.15, -min(0.99, c + 0.04 * i), -1.1, 1, -1.1]
        K[pb + '.ox'] = [0, 0.0, a, s * 0.35, 1, s * 0.7]
        K[pb + '.oz'] = [0, 0.0, a, co * 0.35, 1, co * 0.7]
        K[pb + '.rx'] = [0, 0.0, b, co * 0.3, c + 0.04 * i, co * 1.3, 1, co * 1.4]
        K[pb + '.rz'] = [0, 0.0, b, -s * 0.3, c + 0.04 * i, -s * 1.3, 1, -s * 1.4]
    DEATH['keys'] = K


_death()

CLIPS = {
    'idle': IDLE, 'walk': WALK,
    'cross_w': CROSS_W, 'cross': CROSS, 'barrage_w': BARRAGE_W, 'barrage': BARRAGE,
    'charge_w': CHARGE_W, 'charge': CHARGE, 'ring_w': RING_W, 'ring': RING,
    'broken': BROKEN, 'hit': HIT, 'mood': MOOD, 'death': DEATH,
}
