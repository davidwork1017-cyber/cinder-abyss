# 雷霆监察者（第 2 区雷鸣遗迹首领）：一座悬浮的立柱哨卫。收腰的柱身悬在一圈铸造的底环上方 0.4 m，
# 柱顶一圈宽的黄铜领环托着一只大独眼，眼嵌在厚重的、带上下眼睑的暗铁眼匣里（领头的形：俯视是暗圈里的一个亮点）。
# 身边绕着两道反向转的环、三块护盾板、两只离体的铁手套（三节指 + 拇指，不是连指手套）；领环上两根短的避雷杆（原来的两座线圈塔收成这个）。
# 材质：柱身是风化的淡青铜（灰白石行 + 首领的暖色染色）：比雷鸣遗迹的靛蓝墙亮、偏暖；眼匣里面是暗铁（黑曜石行），领环和箍是黄铜。
# 发光：眼（近白的瞳孔 + 一圈黄的虹膜面），每块护盾板一道细的暗雷光缝。别的地方不发光。
# 尺寸、身高、招式时序见 design-note §2 / §4；坐标一律写游戏坐标（x 左、y 上、z 前），进 Kit 时经 rig.g2b 换成 Blender 坐标。
import math

from mathutils import Euler, Vector

from .. import rig
from ..rig import g2b

TAU = 2 * math.pi

EYE_C = (0.0, 3.86, 0.0)  # 眼匣（近似椭球）的中心
EYE_R = (0.6, 0.55, 0.6)
EYE_UP = math.radians(34)  # 眼的朝向：往前、往上抬 34°（游戏镜头 50° 俯角，从前上方正好看进去）
EYE_D = (0.0, math.sin(EYE_UP), math.cos(EYE_UP))
EYE_P = tuple(EYE_C[i] + EYE_D[i] * 0.5 for i in range(3))  # 眼面中心（眼匣切面上）

HAND_X, HAND_Y, HAND_Z = 1.95, 2.5, 0.42  # 手腕（护腕中心）
KN_Z = HAND_Z + 0.5  # 指根（三根指头的指根在一条横线上：x 方向）
SEG = (0.22, 0.19, 0.16)  # 三节指的长度
FING_X = (-0.15, 0.0, 0.15)  # 三根指头相对手中线的横向位置（按左手写，右手镜像）
ORBIT_Y, PLATE_R = 1.95, 2.0
RING_Y = (2.6, 2.2)

# 骨架（25 根）：枢轴是游戏坐标。左 = +x（它自己的左边），面朝 +z。根骨骼 pelvis = 整台机器（悬浮的起伏、整体的倾斜）
BONES = [
    ('pelvis', None, (0, 2.3, 0)),
    ('x_base', 'pelvis', (0, 0.2, 0)),
    ('x_column', 'pelvis', (0, 1.12, 0)),
    ('head', 'x_column', (0, 3.16, 0)),
    ('x_eye', 'head', EYE_P),
    ('x_lid_t', 'head', EYE_C),
    ('x_lid_b', 'head', EYE_C),
    ('x_rod_l', 'head', (0.74, 3.3, -0.12)),
    ('x_rod_r', 'head', (-0.74, 3.3, -0.12)),
    ('x_ring_a', 'pelvis', (0, RING_Y[0], 0)),
    ('x_ring_b', 'pelvis', (0, RING_Y[1], 0)),
    ('x_orbit', 'pelvis', (0, ORBIT_Y, 0)),
]
PLATE_A = [0.0, TAU / 3, 2 * TAU / 3]
for _i, _a in enumerate(PLATE_A):
    BONES.append(('x_plate_%02d' % (_i + 1), 'x_orbit', (math.sin(_a) * PLATE_R, ORBIT_Y, math.cos(_a) * PLATE_R)))
for _sd, _s in (('l', 1), ('r', -1)):
    _hx = _s * HAND_X
    BONES += [
        ('hand_' + _sd, 'pelvis', (_hx, HAND_Y, HAND_Z)),
        ('x_finger_%s_01' % _sd, 'hand_' + _sd, (_hx, HAND_Y - 0.02, KN_Z)),
        ('x_finger_%s_02' % _sd, 'x_finger_%s_01' % _sd, (_hx, HAND_Y - 0.02, KN_Z + SEG[0])),
        ('x_finger_%s_03' % _sd, 'x_finger_%s_02' % _sd, (_hx, HAND_Y - 0.02, KN_Z + SEG[0] + SEG[1])),
        ('x_thumb_%s' % _sd, 'hand_' + _sd, (_hx - _s * 0.26, HAND_Y - 0.04, HAND_Z + 0.26)),
    ]
SKEL = rig.Skel(BONES)
B = SKEL.index
PIV = {b[0]: b[2] for b in BONES}


def _rot(r):
    return Euler((r[0], r[1], r[2]), 'ZYX').to_matrix()  # 游戏的 XYZ 欧拉：R = Rx · Ry · Rz


def _pts(local, c, rot=(0, 0, 0)):
    R = _rot(rot)
    out = []
    for p in local:
        q = R @ Vector(p)
        out.append(g2b((c[0] + q.x, c[1] + q.y, c[2] + q.z)))
    return out


def _frame(d, hint=(1, 0, 0)):
    """以方向 d（游戏坐标）为 v 轴的正交标架 (u, v, w)：u 尽量贴近 hint"""
    v = Vector(d).normalized()
    h = Vector(hint)
    u = (h - v * h.dot(v))
    if u.length < 1e-6:
        u = Vector((0, 0, 1)) - v * v.z
    u.normalize()
    w = u.cross(v).normalized()
    return u, v, w


def hull_at(k, bone, local, c, rot=(0, 0, 0), row='pale', tone=0.5, jitter=0.04, glow=0):
    vs = k.hull(_pts(local, c, rot), row, tone, jitter, glow, 0)
    return k.bind(vs, B[bone])


def hull_g(k, bone, pts, row='pale', tone=0.5, jitter=0.04, glow=0):
    vs = k.hull([g2b(p) for p in pts], row, tone, jitter, glow, 0)
    return k.bind(vs, B[bone])


def hull_frame(k, bone, pts_uvw, o, d, hint=(1, 0, 0), row='pale', tone=0.5, jitter=0.03, glow=0):
    """局部 (u, v, w) 点集 → 以 o 为原点、v 沿 d 的凸包（斜着的件：指节、护盾板、眼睑）"""
    u, v, w = _frame(d, hint)
    O = Vector(o)
    P = [g2b(tuple(O + u * a + v * b + w * c)) for a, b, c in pts_uvw]
    vs = k.hull(P, row, tone, jitter, glow, 0)
    return k.bind(vs, B[bone])


def hbox(k, bone, c, s, rot=(0, 0, 0), row='pale', tone=0.5, jitter=0.04, bevel=0.03, taper=(1.0, 1.0), glow=0):
    """倒一刀的盒子（凸包），c = 中心，s = 三边长，taper = 顶面（+y）在 x / z 上的收缩比例"""
    a, b, cc = s[0] / 2, s[1] / 2, s[2] / 2
    d = min(bevel, a * 0.45, b * 0.45, cc * 0.45)
    loc = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                tx, tz = (taper[0], taper[1]) if sy > 0 else (1.0, 1.0)
                cand = [(sx * a, sy * (b - d), sz * (cc - d)), (sx * (a - d), sy * b, sz * (cc - d)), (sx * (a - d), sy * (b - d), sz * cc)] if d > 0 else [(sx * a, sy * b, sz * cc)]
                for p in cand:
                    loc.append((p[0] * tx, p[1], p[2] * tz))
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow)


def blob(k, bone, c, r, n=14, rot=(0, 0, 0), row='pale', tone=0.5, jitter=0.04, glow=0):
    """椭球面上的点取凸包（关节、眼球、杆头）"""
    loc = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        u = (i + 0.5) / n
        y = 1 - 2 * u
        rr = math.sqrt(max(0.0, 1 - y * y))
        a = ga * i
        loc.append((math.cos(a) * rr * r[0], y * r[1], math.sin(a) * rr * r[2]))
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow)


def _faces_of(vs):
    fs = []
    seen = set()
    for v in vs:
        if not v.is_valid:
            continue
        for f in v.link_faces:
            if f.is_valid and f.index not in seen and f not in fs:
                fs.append(f)
    return fs


def retag(k, vs, fn):
    """按面重新标颜色：fn(面中心（游戏坐标）, 面法线（游戏坐标）) → None（不动）或 (行, 明暗, 抖动)"""
    fs = _faces_of(vs)
    for f in fs:
        c, n = f.calc_center_median(), f.normal
        r = fn((c.x, c.z, -c.y), (n.x, n.z, -n.y))
        if r:
            k.tag([f], r[0], r[1], r[2], dust=0)
    return fs


def lathe(k, bone, prof, sides=12, row='pale', tone=0.4, jitter=0.03, c=(0, 0), phase=0.0, cap0=True, cap1=True):
    """绕竖轴的旋转体：prof = [(y, 半径), ...]（自下而上），返回 (顶点, 面)"""
    bm = k.bm
    rings = []
    for (y, r) in prof:
        ring = []
        for i in range(sides):
            th = TAU * i / sides + phase
            ring.append(bm.verts.new(g2b((c[0] + math.sin(th) * r, y, c[1] + math.cos(th) * r))))
        rings.append(ring)
    faces = []
    for i in range(len(rings) - 1):
        A, C = rings[i], rings[i + 1]
        for j in range(sides):
            faces.append(bm.faces.new((A[j], A[(j + 1) % sides], C[(j + 1) % sides], C[j])))
    if cap0:
        faces.append(bm.faces.new(list(reversed(rings[0]))))
    if cap1:
        faces.append(bm.faces.new(rings[-1]))
    k.tag(faces, row, tone, jitter, dust=0)
    vs = [v for r in rings for v in r]
    k.bind(vs, B[bone])
    return vs, faces


def band_ring(k, bone, c, r, w, h, seg=36, row='brass', tone=0.5, jitter=0.03, tilt=None):
    """闭合的扁环（矩形截面：径向宽 w、竖直厚 h），环面水平、圆心 c。返回顶点"""
    bm = k.bm
    R = _rot(tilt) if tilt else None
    loops = []
    for i in range(seg):
        th = TAU * i / seg
        s, cth = math.sin(th), math.cos(th)
        lp = []
        for (dr, dy) in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            p = Vector((s * (r + dr), dy, cth * (r + dr)))
            if R:
                p = R @ p
            lp.append(bm.verts.new(g2b((c[0] + p.x, c[1] + p.y, c[2] + p.z))))
        loops.append(lp)
    faces = []
    for i in range(seg):
        A, C = loops[i], loops[(i + 1) % seg]
        for j in range(4):
            faces.append(bm.faces.new((A[j], A[(j + 1) % 4], C[(j + 1) % 4], C[j])))
    k.tag(faces, row, tone, jitter, dust=0)
    vs = [v for lp in loops for v in lp]
    k.bind(vs, B[bone])
    return vs


def _add(a, b, s=1.0):
    return tuple(a[i] + b[i] * s for i in range(3))


def _lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# ---------------------------------------------------------------- 造型
def _column(k):
    # ---- 柱身：下细上粗的十二棱柱（悬在底环上方 0.4 m），淡青铜的板面一块亮一块暗（棱面读得出是拼起来的铸板），
    # 四道竖的黄铜压条，两道黄铜箍；底下一个暗的收口 ----
    prof = [(1.12, 0.2), (1.16, 0.34), (1.32, 0.42), (1.8, 0.47), (2.4, 0.53), (2.86, 0.6), (3.06, 0.64), (3.14, 0.58)]
    cv, _ = lathe(k, 'x_column', prof, sides=12, row='pale', tone=0.36, phase=TAU / 24)

    def ctone(p, n):
        if n[1] < -0.5:
            return ('obsidian', 0.22, 0.02)
        a = math.atan2(p[0], p[2])
        i = int(round(a / (TAU / 12))) % 12
        if p[1] < 1.3:
            return ('obsidian', 0.34, 0.03)
        return ('pale', 0.62 if i % 2 == 0 else 0.5, 0.03)
    retag(k, cv, ctone)
    for i in range(4):
        a = TAU * i / 4 + TAU / 8
        d = (math.sin(a), 0.0, math.cos(a))
        pts = []
        for (y, r) in ((1.36, 0.43), (3.0, 0.645)):
            for t in (-1, 1):
                for o in (0.0, 0.045):
                    pts.append((d[0] * (r + o) + d[2] * 0.05 * t, y, d[2] * (r + o) - d[0] * 0.05 * t))
        hull_g(k, 'x_column', pts, row='brass', tone=0.46, jitter=0.03)
    for (y, r) in ((1.42, 0.45), (2.12, 0.51)):
        band_ring(k, 'x_column', (0, y, 0), r + 0.025, 0.07, 0.09, seg=24, row='brass', tone=0.48)
    # 底下的收口：暗铁的短锥 + 一圈细的黄铜
    lathe(k, 'x_column', [(0.96, 0.08), (1.04, 0.16), (1.13, 0.22)], sides=10, row='obsidian', tone=0.2, cap1=False)


def _base(k):
    # ---- 底环：铸铁的厚环（外 1.12、内 0.58，0.34 m 厚），顶面一圈黄铜，八个外凸的耳。静止姿态里放在地上（y = 0），
    # 游戏里动作把它托起来悬在离地 0.32 m（BASE_LIFT，见 warden_clips.py），破防 / 死亡时落回地上 ----
    prof_o = [(0.0, 0.92), (0.1, 1.1), (0.26, 1.12), (0.34, 1.02)]
    vs, _ = lathe(k, 'x_base', prof_o + [(0.34, 0.58), (0.0, 0.6)], sides=20, row='iron', tone=0.32, cap0=False, cap1=False)
    # 上面那条（外→内）的面是顶面：黄铜
    retag(k, vs, lambda p, n: ('brass', 0.44, 0.03) if n[1] > 0.6 else ('obsidian', 0.24, 0.02) if n[1] < -0.6 else None)
    for i in range(8):
        a = TAU * i / 8 + TAU / 16
        c = (math.sin(a) * 1.1, 0.16, math.cos(a) * 1.1)
        hbox(k, 'x_base', c, (0.2, 0.3, 0.18), rot=(0, a, 0), row='iron', tone=0.4, bevel=0.03, taper=(0.8, 0.8))


def _head(k):
    # ---- 领环：柱顶一圈宽的黄铜（俯视是暗眼匣外面的一圈中间调），外沿往下斜；八道铆钉块 ----
    lathe(k, 'head', [(3.06, 0.6), (3.14, 1.02), (3.28, 1.05), (3.38, 0.86), (3.42, 0.6)], sides=16, row='brass', tone=0.46, phase=TAU / 32)
    for i in range(8):
        a = TAU * i / 8
        hbox(k, 'head', (math.sin(a) * 0.98, 3.3, math.cos(a) * 0.98), (0.12, 0.1, 0.16), rot=(0, a, 0), row='iron', tone=0.36, bevel=0.02)
    # ---- 眼匣：暗铁的厚壳（椭球的点、正面朝眼的方向切掉一个圆口），眼嵌在切面上 ----
    pts = []
    n = 90
    ga = math.pi * (3 - math.sqrt(5))
    cut = math.cos(math.radians(40))
    for i in range(n):
        u = (i + 0.5) / n
        y = 1 - 2 * u
        rr = math.sqrt(max(0.0, 1 - y * y))
        a = ga * i
        d = (math.cos(a) * rr, y, math.sin(a) * rr)
        if d[0] * EYE_D[0] + d[1] * EYE_D[1] + d[2] * EYE_D[2] > cut:
            continue
        yy = max(d[1], -0.62)
        pts.append((EYE_C[0] + d[0] * EYE_R[0], EYE_C[1] + yy * EYE_R[1], EYE_C[2] + d[2] * EYE_R[2]))
    hv = hull_g(k, 'head', pts, row='obsidian', tone=0.3, jitter=0.03)
    # 眼匣的顶面亮一档（暗铁的高光棱），切面（眼窝底）最暗
    retag(k, hv, lambda p, n: ('obsidian', 0.08, 0.0) if (n[0] * EYE_D[0] + n[1] * EYE_D[1] + n[2] * EYE_D[2]) > 0.97 else ('obsidian', 0.42, 0.03) if n[1] > 0.75 else None)
    # 眼匣后面一道往后翘的黄铜脊（俯视读得出朝向）
    hull_g(k, 'head', [(-0.07, 4.3, -0.05), (0.07, 4.3, -0.05), (-0.07, 4.36, -0.3), (0.07, 4.36, -0.3), (0, 4.46, -0.2), (-0.06, 4.0, -0.6), (0.06, 4.0, -0.6), (0, 4.12, -0.66)], row='brass', tone=0.46)
    # ---- 眼：暗的眼窝圈（俯视的「暗圈」）、黄铜的窄眼眶、黄的虹膜面、近白的瞳孔（唯一的近白） ----
    u, v, w = _frame(EYE_D, hint=(1, 0, 0))
    E = Vector(EYE_P)

    def disk(bone, r, z0, z1, sides, row, tone, glow=0, jitter=0.0):
        P = []
        for i in range(sides):
            th = TAU * i / sides
            for z in (z0, z1):
                P.append(g2b(tuple(E + u * (math.cos(th) * r) + w * (math.sin(th) * r) + v * z)))
        vs = k.hull(P, row, tone, jitter, glow, 0)
        return k.bind(vs, B[bone])
    disk('head', 0.43, -0.06, 0.012, 16, 'obsidian', 0.06)
    # 眼眶：一圈黄铜（16 段的扁环，沿眼的朝向）
    bm = k.bm
    loops = []
    for i in range(18):
        th = TAU * i / 18
        lp = []
        for (dr, dz) in ((0.38, 0.0), (0.46, 0.0), (0.46, 0.07), (0.4, 0.09)):
            lp.append(bm.verts.new(g2b(tuple(E + u * (math.cos(th) * dr) + w * (math.sin(th) * dr) + v * dz))))
        loops.append(lp)
    faces = []
    for i in range(18):
        A, C = loops[i], loops[(i + 1) % 18]
        for j in range(4):
            faces.append(bm.faces.new((A[j], A[(j + 1) % 4], C[(j + 1) % 4], C[j])))
    k.tag(faces, 'obsidian', 0.3, 0.03, dust=0)  # 眼眶是暗铁：俯视「暗圈里一个亮点」
    k.bind([vv for lp in loops for vv in lp], B['head'])
    # 眼球（暗的黑曜石底 + 黄的虹膜面 + 近白的瞳孔），都挂在 x_eye（游戏端按芯缩放）
    disk('x_eye', 0.3, 0.0, 0.05, 14, 'obsidian', 0.12)
    disk('x_eye', 0.21, 0.05, 0.085, 14, 'brass', 0.85, glow=0.52)
    blob(k, 'x_eye', tuple(E + v * 0.1), (0.085, 0.085, 0.085), n=16, row='brass', tone=0.98, jitter=0.0, glow=1.0)
    # 虹膜里六道暗的放射纹（眼会转：读得出转动）
    for i in range(6):
        th = TAU * i / 6
        dd = u * math.cos(th) + w * math.sin(th)
        a0, a1 = E + dd * 0.11 + v * 0.088, E + dd * 0.2 + v * 0.088
        side = dd.cross(v).normalized() * 0.018
        P = [g2b(tuple(p)) for p in (a0 - side, a0 + side, a1 - side, a1 + side, a0 - side + v * 0.012, a0 + side + v * 0.012, a1 - side + v * 0.012, a1 + side + v * 0.012)]
        k.bind(k.hull(P, 'obsidian', 0.1, 0.0, 0, 0), B['x_eye'])
    # ---- 上下眼睑：两片厚的暗铁弧板（挂在眼匣中心，绕横轴转就合上），边上一道黄铜 ----
    def lid(bone, a0, a1, tone):
        P = []
        for ai in range(5):
            el = a0 + (a1 - a0) * ai / 4
            for li in range(7):
                lat = math.radians(-58 + 116 * li / 6)
                # 球面上：从眼轴出发，往 v（上）偏 el、往 u（横）偏 lat
                d = (Vector(EYE_D) * math.cos(el) + v_up * math.sin(el))
                d = (d * math.cos(lat) + Vector(u) * math.sin(lat)).normalized()
                for rr in (0.6, 0.7):
                    P.append(g2b(tuple(Vector(EYE_C) + Vector((d.x * rr * 1.0, d.y * rr * 0.95, d.z * rr * 1.0)))))
        vs = k.hull(P, 'obsidian', tone, 0.03, 0, 0)
        k.bind(vs, B[bone])
        return vs
    v_up = Vector(v)
    lt = lid('x_lid_t', math.radians(34), math.radians(70), 0.34)
    lb = lid('x_lid_b', math.radians(-70), math.radians(-36), 0.26)
    for vs, bone, sgn in ((lt, 'x_lid_t', 1), (lb, 'x_lid_b', -1)):
        # 眼睑的唇口（朝眼的那条边）亮一档的黄铜
        retag(k, vs, lambda p, n: ('brass', 0.42, 0.02) if (n[0] * EYE_D[0] + n[1] * EYE_D[1] + n[2] * EYE_D[2]) * 1.0 > 0.55 and sgn * (n[1] - EYE_D[1]) < 0.2 else None)
    # ---- 两根短的避雷杆：领环上往外、往后斜着立起来（暗铁杆，中段一道黄铜箍，顶上一个黄铜的球头） ----
    for s, sd in ((1, 'l'), (-1, 'r')):
        b = 'x_rod_' + sd
        p0 = PIV[b]
        p1 = (p0[0] + s * 0.16, 4.6, p0[2] - 0.12)
        ax = Vector(p1) - Vector(p0)
        sides = 8
        P = []
        for t, r in ((0.0, 0.1), (1.0, 0.07)):
            c = Vector(p0) + ax * t
            uu, vv, ww = _frame(tuple(ax), hint=(1, 0, 0))
            for i in range(sides):
                th = TAU * i / sides
                P.append(g2b(tuple(c + uu * (math.cos(th) * r) + ww * (math.sin(th) * r))))
        k.bind(k.hull(P, 'iron', 0.28, 0.03, 0, 0), B[b])
        blob(k, b, _lerp(p0, p1, 0.55), (0.12, 0.07, 0.12), n=12, row='brass', tone=0.48)
        blob(k, b, _add(p1, (0, 0.06, 0)), (0.13, 0.13, 0.13), n=14, row='brass', tone=0.52)
        hbox(k, b, _add(p0, (0, 0.04, 0)), (0.26, 0.12, 0.26), row='iron', tone=0.34, bevel=0.03)


def _rings(k):
    # ---- 两道环：外环、内环都是暗的旧黄铜（半径 1.55 / 1.28，各三个暗铁的节点）；静止姿态是水平的，歪斜和转动在动作 / 游戏端加 ----
    # 两道环是旧黄铜（暗、窄）：读得出是绕着柱身的环，不和领环连成一片橙色
    for bone, r, row, tone, nrow, ntone, y in (('x_ring_a', 1.55, 'brass', 0.27, 'obsidian', 0.3, RING_Y[0]), ('x_ring_b', 1.28, 'brass', 0.22, 'obsidian', 0.34, RING_Y[1])):
        band_ring(k, bone, (0, y, 0), r, 0.11, 0.06, seg=40, row=row, tone=tone)
        for i in range(3):
            a = TAU * i / 3 + (0.0 if bone == 'x_ring_a' else TAU / 6)
            c = (math.sin(a) * r, y, math.cos(a) * r)
            hull_at(k, bone, [(x * 0.13, yy * 0.11, z * 0.18) for x, yy, z in
                              ((-1, -1, -1), (1, -1, -1), (-1, 1, -1), (1, 1, -1), (-1, -1, 1), (1, -1, 1), (-1, 1, 1), (1, 1, 1), (0, 1.5, 0), (0, -1.5, 0), (1.4, 0, 0), (-1.4, 0, 0))], c, (0, a, 0), row=nrow, tone=ntone)


def _plates(k):
    # ---- 三块护盾板：外倾的风筝形厚板（淡青铜，外缘一道暗铁的边、顶上一道黄铜），板面正中一道细的暗雷光缝 ----
    out = [(-0.5, 0.72), (0.5, 0.72), (0.58, -0.18), (0.0, -0.86), (-0.58, -0.18)]
    for i, a in enumerate(PLATE_A):
        b = 'x_plate_%02d' % (i + 1)
        c = PIV[b]
        d = Vector((math.sin(a), 0.0, math.cos(a)))  # 朝外
        lean = 0.26  # 上沿往外倒
        up = Vector((0, math.cos(lean), 0)) + d * math.sin(lean)
        nrm = (d * math.cos(lean) - Vector((0, 1, 0)) * math.sin(lean)).normalized()
        lat = up.cross(nrm).normalized()
        C = Vector(c)
        P = []
        for (x, y) in out:
            bow = 0.08 * (1 - (x / 0.58) ** 2)  # 板面往外微鼓
            for t in (-0.06, 0.06):
                P.append(g2b(tuple(C + lat * x + up * y + nrm * (t + bow))))
            P.append(g2b(tuple(C + lat * x * 0.5 + up * y * 0.5 + nrm * (0.07 + 0.1))))
        vs = k.bind(k.hull(P, 'pale', 0.44, 0.03, 0, 0), B[b])
        retag(k, vs, lambda p, n, nrm=nrm: ('pale', 0.66, 0.02) if Vector(n).dot(nrm) < 0.4 else None)  # 板边亮一档：护盾板在地面上读得出轮廓
        # 顶上一道黄铜
        P = []
        for x in (-0.52, 0.52):
            for y in (0.66, 0.8):
                for t in (-0.08, 0.1):
                    P.append(g2b(tuple(C + lat * x + up * y + nrm * t)))
        k.bind(k.hull(P, 'brass', 0.46, 0.03, 0, 0), B[b])
        # 雷光缝：细的一道（0.04 m 宽），从顶往下到尖，比板面凸出一点点
        P = []
        for (y, wd) in ((0.56, 0.022), (-0.66, 0.016)):
            for x in (-wd, wd):
                for t in (0.15, 0.185):
                    P.append(g2b(tuple(C + lat * x + up * y + nrm * t)))
        k.bind(k.hull(P, 'brass', 0.8, 0.0, 0.42, 0), B[b])
        # 背面一个暗铁的抱箍（挂在环上的样子）
        P = []
        for x in (-0.16, 0.16):
            for y in (0.1, 0.42):
                for t in (-0.14, -0.05):
                    P.append(g2b(tuple(C + lat * x + up * y + nrm * t)))
        k.bind(k.hull(P, 'iron', 0.3, 0.03, 0, 0), B[b])


def _hands(k):
    # ---- 两只离体的铁手套：护腕（暗铁的短筒、一道黄铜）、手背一块拱起的淡青铜甲、指根一排暗铁的指节护、
    # 三根三节的指头（一节比一节细、每节一个圆的关节）、一根两节的拇指（在里侧，朝着柱身）；掌心朝下 ----
    for s, sd in ((1, 'l'), (-1, 'r')):
        hd = 'hand_' + sd
        hx = s * HAND_X
        W0 = Vector((hx, HAND_Y, HAND_Z))
        # 护腕
        cuff = []
        for z, r in ((-0.2, 0.26), (0.08, 0.3)):
            for i in range(10):
                th = TAU * i / 10
                cuff.append(g2b((hx + math.cos(th) * r, HAND_Y + math.sin(th) * r * 0.82, HAND_Z + z)))
        k.bind(k.hull(cuff, 'obsidian', 0.32, 0.03, 0, 0), B[hd])
        band_ring_pts = []
        for z in (0.06, 0.13):
            for i in range(10):
                th = TAU * i / 10
                band_ring_pts.append(g2b((hx + math.cos(th) * 0.32, HAND_Y + math.sin(th) * 0.32 * 0.82, HAND_Z + z)))
        k.bind(k.hull(band_ring_pts, 'brass', 0.46, 0.03, 0, 0), B[hd])
        # 手掌：扁的一块（宽 0.52、厚 0.2），手背拱起一块甲
        palm = [(-0.26, -0.08, 0.12), (0.26, -0.08, 0.12), (-0.27, -0.08, 0.5), (0.27, -0.08, 0.5), (-0.24, 0.1, 0.12), (0.24, 0.1, 0.12), (-0.25, 0.1, 0.5), (0.25, 0.1, 0.5), (0, -0.11, 0.3)]
        hull_g(k, hd, [(hx + x, HAND_Y + y, HAND_Z + z) for x, y, z in palm], row='obsidian', tone=0.32)
        back = [(-0.22, 0.08, 0.14), (0.22, 0.08, 0.14), (-0.24, 0.08, 0.5), (0.24, 0.08, 0.5), (-0.16, 0.2, 0.2), (0.16, 0.2, 0.2), (-0.17, 0.19, 0.44), (0.17, 0.19, 0.44), (0, 0.23, 0.32)]
        hv = hull_g(k, hd, [(hx + x, HAND_Y + y, HAND_Z + z) for x, y, z in back], row='pale', tone=0.38)
        retag(k, hv, lambda p, n: ('pale', 0.42, 0.02) if n[1] > 0.8 else None)
        # 指根的指节护（一排三块）
        for fx in FING_X:
            x = hx + s * fx
            hbox(k, hd, (x, HAND_Y + 0.08, KN_Z - 0.03), (0.15, 0.1, 0.12), row='brass', tone=0.44, bevel=0.025)
        # 三根三节的指头：每节一个暗铁的关节球 + 一截淡青铜的指甲片，越往外越细
        z0 = KN_Z
        for j, (bone, ln) in enumerate(zip(('x_finger_%s_01' % sd, 'x_finger_%s_02' % sd, 'x_finger_%s_03' % sd), SEG)):
            r0 = 0.072 - j * 0.008
            for fi, fx in enumerate(FING_X):
                x = hx + s * fx
                L = ln * (0.9 if fi != 1 else 1.0)  # 中指长一点
                y = HAND_Y - 0.02
                blob(k, bone, (x, y, z0 + 0.01), (r0, r0 * 0.92, r0), n=10, row='obsidian', tone=0.34)
                seg = []
                for zz, rr in ((0.03, r0 * 0.95), (L - 0.02, r0 * 0.8)):
                    for i in range(6):
                        th = TAU * i / 6 + TAU / 12
                        seg.append(g2b((x + math.cos(th) * rr, y + math.sin(th) * rr * 0.86, z0 + zz)))
                if j == 2:
                    seg.append(g2b((x, y - 0.01, z0 + L + 0.04)))  # 指尖收成钝的尖
                sv = k.bind(k.hull(seg, 'pale', 0.36, 0.03, 0, 0), B[bone])
                retag(k, sv, lambda p, n: ('pale', 0.42, 0.02) if n[1] > 0.6 else ('obsidian', 0.3, 0.02) if n[1] < -0.5 else None)
            z0 += ln
        # 拇指：在里侧（朝柱身），两节，往前、往里斜
        tb = 'x_thumb_' + sd
        tp = Vector(PIV[tb])
        tdir = Vector((-s * 0.45, -0.15, 1.0)).normalized()
        blob(k, tb, tuple(tp), (0.085, 0.08, 0.085), n=10, row='obsidian', tone=0.34)
        for j, (ln, r0) in enumerate(((0.22, 0.072), (0.18, 0.062))):
            a = tp + tdir * (0.03 + j * 0.24)
            bpt = a + tdir * ln
            uu, vv, ww = _frame(tuple(tdir), hint=(0, 1, 0))
            seg = []
            for c, rr in ((a, r0), (bpt, r0 * 0.8)):
                for i in range(6):
                    th = TAU * i / 6
                    seg.append(g2b(tuple(c + uu * (math.cos(th) * rr) + ww * (math.sin(th) * rr))))
            if j == 1:
                seg.append(g2b(tuple(bpt + tdir * 0.04)))
            k.bind(k.hull(seg, 'pale', 0.36, 0.03, 0, 0), B[tb])
            if j == 0:
                blob(k, tb, tuple(bpt + tdir * 0.01), (0.068, 0.064, 0.068), n=10, row='obsidian', tone=0.34)


def build(k):
    """搭形，返回 dict(skel, soft, clips, height)"""
    _base(k)
    _column(k)
    _head(k)
    _rings(k)
    _plates(k)
    _hands(k)
    from .warden_clips import CLIPS
    return dict(skel=SKEL, soft=[], clips=CLIPS, height=4.84)
