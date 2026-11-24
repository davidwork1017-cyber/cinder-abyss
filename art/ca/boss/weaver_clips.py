# 霜织者的动作表（游戏的关节通道写法，见 art/ca/rig.py 顶上的约定）。
# 转角符号（游戏坐标，y 上、z 前）：竖直的上身 rx > 0 = 往前俯；垂着的手臂 rx < 0 = 往前 / 往上抬，rz > 0 = 左臂往外张（右臂取反）；
# 往后伸的蛛腹 rx > 0 = 腹尖往上翘；垂着的霜纱 rx > 0 = 下摆往后飘。
# 腿：每条腿朝外的方向不一样，所以腿的姿态按「抬 / 屈 / 摆」三个量写（leg），在这里换成欧拉角：
#   抬（lift）= 绕「朝外方向 × 上」的水平轴转，> 0 外端往上（股节抬膝）；屈（knee / ank）= 胫节 / 跗节绕同一根轴，> 0 脚往外上方伸直，< 0 往里收；
#   摆（sw）= 绕竖轴转，> 0 脚往后扫（左右腿各自换算）。
# 时序照 design-note §4：蓄力动作按实际播放的长度做（招式蓄力 − 出手提前量），出手动作的 k0 就是接触帧
# （扇形 = 右手甩出去、落冰 = 双手举到最高（之后指挥着落）、召唤 = 前腿第二下点地、冰环 = 身子落到最低、腿撑开），k0 取在采样帧上（30 帧 / 秒）。
# 招式（模拟里的时序）一点不改：扇形 0.40 s（三下：0 / 0.35 / 0.70）、落冰 0.30 s、召唤 0.50 s、冰环 0.45 s。
# 贴地由游戏端做（最低的那个踝正好在静止的高度上），所以这里只管腿自己的姿态；死亡（air）自己管高度。
import math

from mathutils import Matrix, Vector

from .weaver import LEG_NAMES, leg_dir

TAU = 2 * math.pi


def _eul(M):
    e = M.to_euler('ZYX')  # 和 rig.py 一样：Euler((rx, ry, rz), 'ZYX') = Rx · Ry · Rz
    return (e.x, e.y, e.z)


def leg(nm, lift=0.0, knee=0.0, ank=0.0, sw=0.0):
    """一条腿（nm = 'x_fleg_l_' 这种前缀）的姿态 → 三根骨骼的欧拉角通道"""
    fr, sd = nm[2], nm[-2]
    d = leg_dir(fr, sd)
    ax = Vector((-d[2], 0.0, d[0]))  # 朝外 × 上：绕它正转 = 外端往上
    ry = sw if sd == 'l' else -sw
    out = {}
    for b, M in (('01', Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(lift, 3, ax)), ('02', Matrix.Rotation(knee, 3, ax)), ('03', Matrix.Rotation(ank, 3, ax))):
        rx, ryy, rz = _eul(M)
        for c, v in (('rx', rx), ('ry', ryy), ('rz', rz)):
            if abs(v) > 1e-9:
                out[nm + b + '.' + c] = v
    return out


def legs(sel='fmh', **kw):
    """一组腿同样的姿态：sel 里的 f / m / h"""
    out = {}
    for nm in LEG_NAMES:
        if nm[2] in sel:
            out.update(leg(nm, **kw))
    return out


def arm(sd, ua=(0.0, 0.0, 0.0), la=0.0, hd=0.0, la_rz=0.0):
    """一只手臂：ua = 上臂 (rx, ry, rz)（按左臂写，右臂自动取反 ry / rz），la = 小臂 rx，hd = 手 rx"""
    f = 1 if sd == 'l' else -1
    out = {'upperarm_%s.rx' % sd: ua[0], 'upperarm_%s.ry' % sd: ua[1] * f, 'upperarm_%s.rz' % sd: ua[2] * f, 'lowerarm_%s.rx' % sd: la, 'hand_%s.rx' % sd: hd}
    if la_rz:
        out['lowerarm_%s.rz' % sd] = la_rz * f
    return out


def arms(**kw):
    out = arm('l', **kw)
    out.update(arm('r', **kw))
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


def pre(dur, k0):
    """k0 前一帧：接触姿势在这一帧就到位、一直钉到 k0（预警结算可能比动作的接触帧早一帧）"""
    N = max(1, round(dur * 30))
    return round(k0 * N - 1) / N


# ---------------------------------------------------------------- 静止 / 移动
# 静止：双手在胸前织线（小臂往前、手微垂），头微低，看着前面的地
STAND = P(arms(ua=(-0.32, 0.0, 0.3), la=-0.9, hd=-0.15, la_rz=-0.12), head__rx=0.05, spine_02__rx=0.03)

IDLE = {'dur': 2.6, 'loop': True, 'fade': 0.25, 'keys': {}}


def _idle():
    K = {}
    n = 8
    for i in range(n + 1):
        k = i / n
        a = TAU * k
        p = dict(STAND)
        p.update({
            'spine_02.rx': 0.03 + 0.02 * math.sin(a), 'spine_03.rx': -0.015 * math.sin(a), 'pelvis.oy': -0.02 * math.sin(a) ** 2,
            'spine_03.ry': 0.05 * math.sin(a + 0.5), 'head.ry': -0.08 * math.sin(a + 0.9), 'head.rx': 0.05 + 0.03 * math.sin(a + 1.6),
            'upperarm_l.rx': -0.35 + 0.12 * math.sin(2 * a), 'upperarm_r.rx': -0.35 - 0.12 * math.sin(2 * a),
            'lowerarm_l.rx': -0.95 + 0.18 * math.sin(2 * a + 1.2), 'lowerarm_r.rx': -0.95 - 0.18 * math.sin(2 * a + 1.2),
            'x_abd_01.ry': 0.05 * math.sin(a), 'x_abd_02.ry': 0.06 * math.sin(a - 0.8), 'x_abd_01.rx': 0.03 * math.sin(a + 0.4),
            'x_veil_01.rx': 0.04 + 0.03 * math.sin(a + 1.0), 'x_veil_02.rx': 0.05 * math.sin(a + 0.2), 'x_veil_03.rx': 0.06 * math.sin(a - 0.6),
            'x_crown.oy': 0.008 * math.sin(a),
        })
        for j, nm in enumerate(LEG_NAMES):
            p.update(leg(nm, lift=0.025 * math.sin(a + j * 1.3)))
        for c, v in p.items():
            K.setdefault(c, []).extend([k, v])
    IDLE['keys'] = K


_idle()

# 走：三脚架步态（左前 + 右中 + 左后 一组，另外三条一组，相位差一半）；着地的半个周期脚往后扫，抬起的半个周期抬腿往前；
# 一个周期走 2.2 m（cycle），中腿脚尖的半径 2.4 m，扫 ±0.23 rad ≈ 每半个周期 1.1 m
GROUP = {'x_fleg_l_': 0.0, 'x_mleg_r_': 0.0, 'x_hleg_l_': 0.0, 'x_fleg_r_': 0.5, 'x_mleg_l_': 0.5, 'x_hleg_r_': 0.5}
WALK = {'dur': 1.0, 'loop': True, 'fade': 0.2, 'extra': {'cycle': 2.2}, 'keys': {}}


def _leg_walk(u):
    """u = 这条腿的相位（0–1）：0–0.5 着地往后扫，0.5–1 抬起往前；返回 (lift, knee, sw)"""
    A = 0.23
    if u < 0.5:
        t = u / 0.5
        return 0.0, 0.03 * math.sin(math.pi * t), -A + 2 * A * t
    t = (u - 0.5) / 0.5
    lift = math.sin(math.pi * t)
    return 0.3 * lift, -0.22 * lift, A - 2 * A * (0.5 - 0.5 * math.cos(math.pi * t))


def _walk():
    K = {}
    n = 16
    for i in range(n + 1):
        k = i / n
        a = TAU * k
        p = dict(STAND)
        p.update({
            'pelvis.oy': -0.03 * math.cos(2 * a), 'pelvis.ry': 0.03 * math.sin(a), 'spine_01.rx': 0.07, 'spine_02.ry': -0.04 * math.sin(a),
            'head.rx': 0.03 + 0.02 * math.cos(2 * a), 'upperarm_l.rx': -0.3 + 0.1 * math.sin(a), 'upperarm_r.rx': -0.3 - 0.1 * math.sin(a),
            'x_abd_01.ry': 0.06 * math.sin(a + 0.6), 'x_abd_02.ry': 0.08 * math.sin(a - 0.2), 'x_abd_01.rx': 0.03 * math.cos(2 * a),
            'x_veil_01.rx': 0.14 + 0.03 * math.sin(2 * a), 'x_veil_02.rx': 0.1 + 0.05 * math.sin(2 * a - 0.8), 'x_veil_03.rx': 0.12 + 0.06 * math.sin(2 * a - 1.6),
        })
        for nm in LEG_NAMES:
            lf, kn, sw = _leg_walk((k + GROUP[nm]) % 1.0)
            p.update(leg(nm, lift=lf, knee=kn, sw=sw))
        for c, v in p.items():
            K.setdefault(c, []).extend([k, v])
    WALK['keys'] = K


_walk()

# ---------------------------------------------------------------- 扇形（fan）：三下，每下右手甩一次
# 蓄力 0.302 s：右手往后拉过肩（手到脑后）、上身往右拧，前腿撑住；出手 0.36 s，k0 = 3/11：手腕一甩、右手冲到最前，
# 之后回到蓄力的姿势（第二、三下接着从同一个姿势甩：首尾姿势一样，0.03 s 的淡入接得上）
FAN_DUR = 0.36
FAN_K0 = snap(FAN_DUR, 0.30)
FAN_W_DUR = round(0.4 - FAN_K0 * FAN_DUR, 3)
FAN_BACK = P(
    STAND, arm('r', ua=(-2.75, 0.0, 0.35), la=-1.9, hd=-0.4), arm('l', ua=(-0.7, 0.0, 0.45), la=-0.5, hd=-0.1), legs('f', lift=-0.06, knee=0.08),
    spine_03__ry=-0.28, spine_02__rx=-0.08, head__ry=0.16, pelvis__rx=-0.03, x_veil_01__rx=0.08,
)
FLICK = P(
    STAND, arm('r', ua=(-1.55, 0.0, 0.18), la=-0.12, hd=-0.55), arm('l', ua=(-0.55, 0.0, 0.5), la=-0.6, hd=-0.1), legs('f', lift=-0.08, knee=0.1),
    spine_03__ry=0.2, spine_02__rx=0.1, head__ry=-0.06, pelvis__rx=0.02, x_veil_01__rx=0.18, x_veil_02__rx=0.1,
)
FAN_W = {'dur': FAN_W_DUR, 'hold': True, 'fade': 0.08, 'steady': True,
         'keys': track([(0, STAND, False), (0.6, P(FAN_BACK, upperarm_r__rx=-2.5), False), (1, FAN_BACK, False)])}
FAN = {'dur': FAN_DUR, 'k0': FAN_K0, 'fade': 0.03, 'out': 0.22, 'steady': True,
       'keys': track([(0, FAN_BACK, False), (pre(FAN_DUR, FAN_K0), FLICK, True), (FAN_K0, FLICK, False), (snap(FAN_DUR, 0.64), P(FLICK, upperarm_r__rx=-2.1, lowerarm_r__rx=-1.0), False), (1, FAN_BACK, False)])}

# ---------------------------------------------------------------- 落冰（barrage）
# 蓄力 0.167 s：双手往上举、霜纱往后扬；出手 1.20 s（游戏按落冰的时长拉伸），k0 = 4/36：双手举到最高、蛛腹翘起来，
# 之后双手交替着往下指挥（都比 k0 那一下低），末尾放下
BAR_DUR = 1.2
BAR_K0 = snap(BAR_DUR, 0.1)
BAR_W_DUR = round(0.3 - BAR_K0 * BAR_DUR, 3)
RAISE = P(STAND, arms(ua=(-2.45, 0.0, 0.42), la=-0.3, hd=0.2), head__rx=-0.25, spine_02__rx=-0.1, x_veil_01__rx=0.45, x_veil_02__rx=0.35, x_veil_03__rx=0.2)
PEAK = P(RAISE, arms(ua=(-2.85, 0.0, 0.25), la=-0.12, hd=0.3), legs(lift=-0.07, knee=0.08), x_abd_01__rx=0.3, x_abd_02__rx=0.15, head__rx=-0.3, spine_02__rx=-0.14, x_veil_01__rx=0.55)
BARRAGE_W = {'dur': BAR_W_DUR, 'hold': True, 'fade': 0.06, 'steady': True, 'keys': track([(0, STAND, False), (1, RAISE, False)])}
_bk = [(0, RAISE, False), (pre(BAR_DUR, BAR_K0), PEAK, True), (BAR_K0, PEAK, False)]
for _i, _k in enumerate((0.24, 0.38, 0.52, 0.66, 0.8)):
    s = 1 if _i % 2 == 0 else -1
    _bk.append((snap(BAR_DUR, _k), P(PEAK, arm('l', ua=(-2.5 + 0.12 * s, 0.0, 0.4), la=-0.5 + 0.2 * s, hd=0.5), arm('r', ua=(-2.5 - 0.12 * s, 0.0, 0.4), la=-0.5 - 0.2 * s, hd=0.5),
                                            spine_03__ry=0.08 * s, x_veil_01__rx=0.48), False))
_bk += [(snap(BAR_DUR, 0.9), P(RAISE, x_abd_01__rx=0.15), False), (1, P(STAND, x_veil_01__rx=0.15), False)]
BARRAGE = {'dur': BAR_DUR, 'k0': BAR_K0, 'fade': 0.04, 'out': 0.3, 'steady': True, 'keys': track(_bk)}

# ---------------------------------------------------------------- 召唤（summon）
# 蓄力 0.333 s：双手往下按、上身前倾，两条前腿抬起来点第一下地（0.7），再抬起；
# 出手 0.70 s，k0 = 5/21：两条前腿加速点下第二下（小怪在这一刻现身），之后慢慢站直
SUM_DUR = 0.7
SUM_K0 = snap(SUM_DUR, 0.25)
SUM_W_DUR = round(0.5 - SUM_K0 * SUM_DUR, 3)
LOW = P(STAND, arms(ua=(-0.25, 0.0, 0.55), la=-0.3, hd=0.5), spine_02__rx=0.12, spine_01__rx=0.04, head__rx=0.2)
FLIFT = P(LOW, legs('f', lift=0.45, knee=-0.55, ank=-0.2), pelvis__rx=-0.04)
TAP = P(LOW, legs('f', lift=-0.04, knee=0.06, ank=0.03), arms(ua=(-0.2, 0.0, 0.6), la=-0.15, hd=0.7), spine_02__rx=0.16, pelvis__rx=0.03, x_veil_01__rx=0.1)
SUMMON_W = {'dur': SUM_W_DUR, 'hold': True, 'fade': 0.08, 'steady': True,
            'keys': track([(0, STAND, False), (0.4, FLIFT, False), (0.7, TAP, True), (1, FLIFT, False)])}
SUMMON = {'dur': SUM_DUR, 'k0': SUM_K0, 'fade': 0.04, 'out': 0.3, 'steady': True,
          'keys': track([(0, FLIFT, False), (pre(SUM_DUR, SUM_K0), TAP, True), (SUM_K0, TAP, False), (snap(SUM_DUR, 0.45), P(TAP, spine_02__rx=0.12), False), (snap(SUM_DUR, 0.8), P(STAND, spine_02__rx=0.06), False), (1, STAND, False)])}

# ---------------------------------------------------------------- 冰环（ring）
# 蓄力 0.317 s：六条腿撑直、整个身子升高，上身往后仰、双臂抱在胸前；
# 出手 0.60 s，k0 = 4/18：身子猛地落下、六条腿往外撑开，双臂甩开，头落到最低（冰环在这一刻放出去），之后慢慢站回来
RING_DUR = 0.6
RING_K0 = snap(RING_DUR, 0.2)
RING_W_DUR = round(0.45 - RING_K0 * RING_DUR, 3)
TALL = P(STAND, legs(lift=-0.3, knee=0.0), arms(ua=(-0.95, 0.0, -0.3), la=-1.45, hd=0.0), spine_02__rx=-0.12, spine_03__rx=-0.05, head__rx=-0.15, x_abd_01__rx=0.15, x_veil_01__rx=0.05)
DROP = P(STAND, legs(lift=0.3, knee=-0.14), arms(ua=(-0.5, 0.0, 1.3), la=-0.1, hd=0.1), spine_02__rx=0.2, spine_01__rx=0.06, head__rx=0.25, x_abd_01__rx=-0.08, x_veil_01__rx=0.4, x_veil_02__rx=0.3)
RING_W = {'dur': RING_W_DUR, 'hold': True, 'fade': 0.08, 'steady': True,
          'keys': track([(0, STAND, False), (0.7, P(TALL, upperarm_l__rx=-0.8, upperarm_r__rx=-0.8), False), (1, TALL, False)])}
RING = {'dur': RING_DUR, 'k0': RING_K0, 'fade': 0.03, 'out': 0.3, 'steady': True,
        'keys': track([(0, TALL, False), (pre(RING_DUR, RING_K0), DROP, True), (RING_K0, DROP, False), (snap(RING_DUR, 0.4), P(DROP, head__rx=0.18, spine_02__rx=0.15), False), (snap(RING_DUR, 0.75), P(STAND, legs(lift=0.08, knee=-0.04)), False), (1, STAND, False)])}

# ---------------------------------------------------------------- 破防：0.5 s 六条腿一软（膝往上翻、胫节往外滑开，身子沉下去约 1 m），身子沉下去、上身往前伏，之后 2 s 一个循环（loopFrom = 0.2）
# 姿势收得紧：趴在原地，上身不往前探出去（不盖住地上的下一道预警）
SLUMP = P(
    legs(lift=0.25, knee=0.25), arms(ua=(0.1, 0.0, 0.25), la=-0.25, hd=0.1),
    spine_01__rx=0.32, spine_02__rx=0.22, spine_03__rx=0.08, head__rx=0.35, x_abd_01__rx=-0.22, x_abd_02__rx=-0.1, x_veil_01__rx=-0.05, x_veil_02__rx=0.15, x_veil_03__rx=-0.1,
)
BROKEN = {'dur': 2.5, 'loop': True, 'loopFrom': 0.2, 'fade': 0.15, 'out': 0.45, 'keys': {}}


def _broken():
    wob = {'spine_02.rx': 0.04, 'head.rx': 0.06, 'head.rz': 0.1, 'spine_02.rz': 0.04, 'x_abd_01.ry': 0.08, 'upperarm_l.rx': 0.08, 'upperarm_r.rx': -0.08}
    chans = set(SLUMP) | set(wob)
    K = {}
    for c in sorted(chans):
        v, w = SLUMP.get(c, 0.0), wob.get(c, 0.0)
        # 0 → 0.2：塌下去（0.12 那一下塌到底再弹一点）；0.2 → 1：慢慢晃（0.2 和 1 的值一样，循环接得上）
        K[c] = [0, 0.0, -0.12, v * 1.06, 0.2, v, 0.4, v + w, 0.6, v, 0.8, v - w, 1, v]
    BROKEN['keys'] = K


_broken()

# ---------------------------------------------------------------- 受击（叠加，只动上身和霜纱）：第一帧是 0，游戏端按相对第一帧的变化量叠上去
HIT = {
    'dur': 0.35, 'fade': 0.02,
    'keys': {
        'spine_03.rx': [0, 0.0, 0.14, -0.1, 1, 0.0], 'spine_02.rx': [0, 0.0, 0.14, -0.05, 1, 0.0], 'head.rx': [0, 0.0, 0.18, -0.14, 1, 0.0], 'head.rz': [0, 0.0, 0.18, 0.08, 1, 0.0],
        'upperarm_l.rx': [0, 0.0, 0.16, 0.18, 1, 0.0], 'upperarm_r.rx': [0, 0.0, 0.16, 0.18, 1, 0.0], 'x_veil_01.rx': [0, 0.0, 0.2, 0.14, 1, 0.0], 'x_abd_01.rx': [0, 0.0, 0.2, -0.06, 1, 0.0],
    },
}

# ---------------------------------------------------------------- 狂暴（持续的姿态偏移，按 ent.mood 叠上去）：霜纱往后扬开、散开（三节都翘），蛛腹翘起一点，头抬一点
MOOD = {
    'dur': 0.5, 'hold': True,
    'keys': {
        'x_veil_01.rx': [0, 0.3, 1, 0.3], 'x_veil_02.rx': [0, 0.26, 1, 0.26], 'x_veil_03.rx': [0, 0.32, 1, 0.32], 'x_veil_03.rz': [0, 0.12, 1, 0.12],
        'x_abd_01.rx': [0, 0.12, 1, 0.12], 'head.rx': [0, -0.06, 1, -0.06], 'spine_02.rx': [0, -0.04, 1, -0.04], 'x_crown.oy': [0, 0.04, 1, 0.04],
    },
}

# ---------------------------------------------------------------- 死亡 1.6 s（定格），对着 vfx3 的三段崩开：0 s 第一道裂口（上身往后一仰、双臂甩开）、
# 0.45 s 第二道（六条腿一软、往下坠）、0.90 s 蛛身砸到地上（地上的冲击环同时炸开），之后六条腿往里蜷起来，再交给 0.9 s 自下而上的消散。base = rest、air（自己管高度）
DEATH = {'dur': 1.6, 'hold': True, 'base': 'rest', 'air': True, 'fade': 0.1, 'extra': {'impact': 0.9}, 'keys': {}}


def _death():
    T = lambda s: s / 1.6
    a, b, c, d = T(0.16), T(0.45), T(0.9), T(1.05)
    K = {
        'pelvis.oy': [0, 0.0, a, 0.14, b, -0.7, -c, -1.86, d, -1.78, 1, -1.8],
        'pelvis.rx': [0, 0.0, a, -0.1, b, 0.04, c, 0.08, 1, 0.07],
        'pelvis.rz': [0, 0.0, b, 0.05, c, -0.06, 1, -0.05],
        'spine_01.rx': [0, 0.0, a, -0.35, b, -0.1, c, 0.3, d, 0.4, 1, 0.38],
        'spine_02.rx': [0, 0.0, a, -0.25, b, 0.1, c, 0.3, 1, 0.32],
        'spine_03.rz': [0, 0.0, c, 0.12, 1, 0.15],
        'head.rx': [0, 0.0, a, -0.4, b, 0.2, c, 0.45, 1, 0.5], 'head.rz': [0, 0.0, c, 0.25, 1, 0.3],
        'x_abd_01.rx': [0, 0.0, a, 0.2, b, -0.1, c, -0.25, 1, -0.22],
        'x_abd_02.rx': [0, 0.0, a, 0.1, c, -0.12, 1, -0.1],
        'x_veil_01.rx': [0, 0.0, a, 0.5, b, 0.2, c, -0.1, 1, -0.05], 'x_veil_02.rx': [0, 0.0, a, 0.4, c, 0.3, 1, 0.25], 'x_veil_03.rx': [0, 0.0, a, 0.3, c, 0.1, 1, 0.12],
        'x_crown.rx': [0, 0.0, c, 0.15, 1, 0.2],
    }
    for sd in ('l', 'r'):
        f = 1 if sd == 'l' else -1
        K['upperarm_%s.rx' % sd] = [0, 0.0, a, -2.2, b, -1.2, c, -0.2, 1, -0.1]
        K['upperarm_%s.rz' % sd] = [0, 0.0, a, 0.8 * f, b, 0.6 * f, c, 0.4 * f, 1, 0.35 * f]
        K['lowerarm_%s.rx' % sd] = [0, 0.0, a, -0.3, c, -0.6, 1, -0.7]
    poses = [
        (a, dict(lift=0.08, knee=0.05)),     # 往后一仰：腿撑一下
        (b, dict(lift=-0.35, knee=0.4)),    # 腿一软
        (c, dict(lift=0.15, knee=-0.8, ank=-0.3)),  # 砸地：腿开始往里收
        (1, dict(lift=0.32, knee=-1.25, ank=-0.55)),  # 蜷起来
    ]
    for nm in LEG_NAMES:
        ps = [(0, {})] + [(t, leg(nm, **kw)) for t, kw in poses]
        for ch in sorted(set(x for _, p in ps for x in p)):
            K[ch] = []
            for t, p in ps:
                K[ch] += [t, p.get(ch, 0.0)]
    DEATH['keys'] = K


_death()

CLIPS = {
    'idle': IDLE, 'walk': WALK,
    'fan_w': FAN_W, 'fan': FAN, 'barrage_w': BARRAGE_W, 'barrage': BARRAGE,
    'summon_w': SUMMON_W, 'summon': SUMMON, 'ring_w': RING_W, 'ring': RING,
    'broken': BROKEN, 'hit': HIT, 'mood': MOOD, 'death': DEATH,
}
