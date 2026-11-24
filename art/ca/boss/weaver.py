# 霜织者（第 1 区霜骨沼泽首领）：低平的蛛头胸上立着一截纤细、穿袍子的成人上身（头约 0.5 m，1 : 7），
# 六条长的分节腿朝四周放射着撑开（腿根 0.22 m 收到腿尖 0.08 m，膝上一根骨刺：俯视读得出是腿，不是铁丝），
# 身后一个水滴形的蛛腹（尖朝后），头上一顶收紧的五片冰冠，肩上垂下两层霜纱。
# 材质：腿和蛛腹是暖灰的甲壳（和冷蓝的冰地拉开冷暖和明暗），袍子和霜纱是霜丝（冷灰蓝的中间调），袍子里面是暗色的内衬，
# 冰冠和六个腿尖是冰。发光：胸口一个小的霜结（近白的芯）、冰冠中间那片（近白一点在根部），蛛腹背上两道暗的人字纹，
# 六个冰的腿尖一点暗的霜光（俯视一圈放射的蓝点）。原来身边飘的冰菱形全拿掉。
# 尺寸、身高、招式时序见 design-note §2 / §4；坐标一律写游戏坐标（x 左、y 上、z 前），进 Kit 时经 rig.g2b 换成 Blender 坐标。
import math

from mathutils import Euler, Matrix, Vector

from .. import rig
from ..rig import g2b

TAU = 2 * math.pi

# 六条腿：(前 / 中 / 后, 朝向（和正前方的夹角，度，左边为正）, 腿根所在的 z, 腿根离身子中线多远)
LEGS = [('f', 40.0, 0.3, 0.56), ('m', 92.0, 0.0, 0.7), ('h', 142.0, -0.3, 0.58)]
HIP_Y, KNEE_Y, ANK_Y = 2.4, 3.3, 0.42
KNEE_R, ANK_R, TIP_R = 1.5, 2.45, 2.62


def leg_dir(fr, sd):
    """这条腿朝外的水平方向（游戏坐标，单位向量）"""
    a = math.radians({'f': 40.0, 'm': 92.0, 'h': 142.0}[fr])
    s = 1 if sd == 'l' else -1
    return (s * math.sin(a), 0.0, math.cos(a))


def leg_pts(fr, sd):
    """腿根 / 膝 / 踝 / 腿尖（游戏坐标）"""
    _, _, bz, hr = [l for l in LEGS if l[0] == fr][0]
    d = leg_dir(fr, sd)
    P = lambda r, y: (d[0] * r, y, bz + d[2] * r)
    return P(hr, HIP_Y), P(KNEE_R, KNEE_Y), P(ANK_R, ANK_Y), P(TIP_R, 0.0)


# 人形上身整体放大一点（围着腰底 UB_PIV 缩放 UB_SCALE）：上身的零件和骨骼枢轴都按这个写，换算统一走 ub()
UB_PIV, UB_SCALE = (0.0, 2.72, 0.44), 1.06
UPPER = ('spine_01', 'spine_02', 'spine_03', 'x_core', 'neck_01', 'head', 'x_crown', 'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'x_veil_01', 'x_veil_02', 'x_veil_03')


def ub(p, sc=UB_SCALE):
    return tuple(UB_PIV[i] + (p[i] - UB_PIV[i]) * sc for i in range(3))


XF = [1.0]  # 搭上身那一段时 = UB_SCALE（零件的点经 X() 换算），其余 = 1


def X(p):
    return p if XF[0] == 1.0 else ub(p, XF[0])


# 骨架（37 根）：枢轴是游戏坐标。左 = +x（它自己的左边），面朝 +z。
# 根骨骼 pelvis = 蛛头胸（腿都挂在它上面）；人形上身从头胸前上方长出来（spine_01..03、neck_01、head，手臂直接挂在 spine_03 上，没有锁骨）
BONES = [
    ('pelvis', None, (0, 2.42, 0.0)),
    ('x_abd_01', 'pelvis', (0, 2.48, -0.62)),
    ('x_abd_02', 'x_abd_01', (0, 2.6, -1.45)),
    ('spine_01', 'pelvis', (0, 2.72, 0.44)),
    ('spine_02', 'spine_01', (0, 3.08, 0.46)),
    ('spine_03', 'spine_02', (0, 3.42, 0.47)),
    ('x_core', 'spine_03', (0, 3.56, 0.74)),
    ('neck_01', 'spine_03', (0, 3.92, 0.47)),
    ('head', 'neck_01', (0, 4.06, 0.49)),
    ('x_crown', 'head', (0, 4.46, 0.47)),
    ('upperarm_l', 'spine_03', (0.44, 3.8, 0.47)),
    ('lowerarm_l', 'upperarm_l', (0.56, 3.12, 0.52)),
    ('hand_l', 'lowerarm_l', (0.63, 2.4, 0.62)),
    ('upperarm_r', 'spine_03', (-0.44, 3.8, 0.47)),
    ('lowerarm_r', 'upperarm_r', (-0.56, 3.12, 0.52)),
    ('hand_r', 'lowerarm_r', (-0.63, 2.4, 0.62)),
    ('x_veil_01', 'spine_03', (0, 3.86, 0.3)),
    ('x_veil_02', 'x_veil_01', (0, 3.2, 0.1)),
    ('x_veil_03', 'x_veil_02', (0, 2.95, -0.4)),
]
for _fr, _a, _bz, _hr in LEGS:
    for _sd in ('l', 'r'):
        _h, _k, _an, _t = leg_pts(_fr, _sd)
        _n = 'x_%sleg_%s_' % (_fr, _sd)
        BONES += [(_n + '01', 'pelvis', _h), (_n + '02', _n + '01', _k), (_n + '03', _n + '02', _an)]
BONES = [(n, par, ub(c) if n in UPPER else c) for n, par, c in BONES]
SKEL = rig.Skel(BONES)
B = SKEL.index
PIV = {b[0]: b[2] for b in BONES}
LEG_NAMES = ['x_%sleg_%s_' % (fr, sd) for fr in ('f', 'm', 'h') for sd in ('l', 'r')]

# 甲壳（玄武岩行）的色带位置整体往亮的一头挪（灰度检查：受光面 p85 要到 ~50% 以上、比冰地亮；颜色只能靠色带位置给）
CHIT_LIFT = 0.26


def _tone(row, tone):
    return min(0.94, tone + CHIT_LIFT) if row == 'basalt' else tone


def _rot(r):
    return Euler((r[0], r[1], r[2]), 'ZYX').to_matrix()  # 游戏的 XYZ 欧拉：R = Rx · Ry · Rz


def _pts(local, c, rot=(0, 0, 0)):
    R = _rot(rot)
    out = []
    for p in local:
        q = R @ Vector(p)
        out.append(g2b(X((c[0] + q.x, c[1] + q.y, c[2] + q.z))))
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


def hull_at(k, bone, local, c, rot=(0, 0, 0), row='basalt', tone=0.5, jitter=0.05, glow=0, dust=0, soft=False):
    vs = k.hull(_pts(local, c, rot), row, _tone(row, tone), jitter, glow, dust)
    return k.bind(vs, B[bone], soft)


def hull_g(k, bone, pts, row='basalt', tone=0.5, jitter=0.05, glow=0, dust=0, soft=False):
    """游戏坐标的点集直接取凸包"""
    vs = k.hull([g2b(X(p)) for p in pts], row, _tone(row, tone), jitter, glow, dust)
    return k.bind(vs, B[bone], soft)


def hull_frame(k, bone, pts_uvw, o, d, hint=(1, 0, 0), row='basalt', tone=0.5, jitter=0.04, glow=0, dust=0):
    """局部 (u, v, w) 点集 → 以 o 为原点、v 沿 d 的凸包（冰冠的刃、骨刺、指头这类斜着的件）"""
    u, v, w = _frame(d, hint)
    O = Vector(o)
    P = [g2b(X(tuple(O + u * a + v * b + w * c))) for a, b, c in pts_uvw]
    vs = k.hull(P, row, _tone(row, tone), jitter, glow, dust)
    return k.bind(vs, B[bone])


def hbox(k, bone, c, s, rot=(0, 0, 0), row='basalt', tone=0.5, jitter=0.05, bevel=0.04, taper=(1.0, 1.0), glow=0, dust=0, soft=False):
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
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow, dust, soft)


def blob(k, bone, c, r, n=14, rot=(0, 0, 0), row='basalt', tone=0.5, jitter=0.05, glow=0, dust=0, flat=0.0, soft=False):
    """椭球面上的点取凸包（关节的球、霜结、腿根）"""
    loc = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        u = (i + 0.5) / n
        y = 1 - 2 * u
        rr = math.sqrt(max(0.0, 1 - y * y))
        a = ga * i + k.r(-0.2, 0.2)
        yy = max(y, -1 + flat * 2) if flat else y
        loc.append((math.cos(a) * rr * r[0], yy * r[1], math.sin(a) * rr * r[2]))
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow, dust, soft)


def loft(k, bone, pts, radii, sides=8, squash=1.0, row='basalt', tone=0.5, jitter=0.05, cap0=True, cap1=True, twist=0.0, soft=False, glow=0, tip=False, rings=None):
    """沿折线的渐变截面管（椭圆截面：squash < 1 压扁）；soft = 软接缝；tip = 末端收成尖；rings = 每一圈绑哪根骨骼"""
    vs, segs = k.tube([g2b(X(p)) for p in pts], [r * XF[0] for r in radii], sides=sides, row=row, tone=_tone(row, tone), jitter=jitter, tip=tip, cap0=cap0, cap1=cap1, squash=squash, twist=twist)
    k.tag([f for sg in segs for f in sg], row, tone if glow else _tone(row, tone), 0.04 if glow else jitter, glow=glow, dust=0)
    if rings is None:
        return k.bind(vs, B[bone], soft)
    i = 0
    for j, bn in enumerate(rings):
        n = 1 if (tip and j == len(rings) - 1) else sides
        k.bind(vs[i:i + n], B[bn], True)
        i += n
    return vs


def _ring_faces(k, rings, closed0=True, closed1=True):
    bm = k.bm
    faces = []
    n = len(rings[0])
    for i in range(len(rings) - 1):
        A, C = rings[i], rings[i + 1]
        for j in range(n):
            faces.append(bm.faces.new((A[j], C[j], C[(j + 1) % n], A[(j + 1) % n])))
    if closed0:
        faces.append(bm.faces.new(list(reversed(rings[0]))))
    if closed1:
        faces.append(bm.faces.new(rings[-1]))
    return faces


def zbody(k, secs, sides=16, row='basalt', tone=0.4, jitter=0.05, wob=0.03, rigid=('pelvis',)):
    """沿 z 的一串横截面（中心 (x, y)、半宽 a、背高 ht、腹深 hb、方形度 sq、骨骼）：上下不对称的超椭圆，按截面绑骨骼。
    rigid 里的骨骼那几圈刚性，其余软接缝渐变。返回 (全部顶点, 面列表)"""
    bm = k.bm
    rings = []
    for (cx, cy, cz, a, ht, hb, sq, bn) in secs:
        ring = []
        for i in range(sides):
            th = TAU * i / sides
            c, s = math.cos(th), math.sin(th)
            e = 2.0 / sq
            x = a * math.copysign(abs(c) ** e, c)
            y = (ht if s > 0 else hb) * math.copysign(abs(s) ** e, s)
            j = 1 + k.r(-wob, wob)
            ring.append(bm.verts.new(g2b((cx + x * j, cy + y * j, cz + k.r(-wob, wob) * 0.4))))
        k.bind(ring, B[bn], bn not in rigid)
        rings.append(ring)
    faces = _ring_faces(k, rings)
    k.tag(faces, row, _tone(row, tone), jitter, dust=0)
    return [v for r in rings for v in r], faces


def ybody(k, secs, sides=14, row='slate', tone=0.5, jitter=0.04, wob=0.015, rigid=('pelvis',), close0=True, close1=True):
    """沿 y 的一串横截面（高 y、中心 (x, z)、半宽 a、前深 f、后深 b、方形度 sq、骨骼）：袍子、躯干。返回 (全部顶点, 面列表)"""
    bm = k.bm
    rings = []
    for (y, cx, cz, a, f, b, sq, bn) in secs:
        ring = []
        for i in range(sides):
            th = TAU * i / sides
            c, s = math.cos(th), math.sin(th)
            e = 2.0 / sq
            x = a * math.copysign(abs(c) ** e, c)
            z = (f if s > 0 else b) * math.copysign(abs(s) ** e, s)
            j = 1 + k.r(-wob, wob)
            ring.append(bm.verts.new(g2b(X((cx + x * j, y + k.r(-wob, wob) * 0.3, cz + z * j)))))
        k.bind(ring, B[bn], bn not in rigid)
        rings.append(ring)
    faces = _ring_faces(k, rings, close0, close1)
    k.tag(faces, row, _tone(row, tone), jitter, dust=0)
    return [v for r in rings for v in r], faces


def retag(k, vs, fn):
    """按面重新标颜色：fn(面中心（游戏坐标）, 面法线（游戏坐标）) → None（不动）或 (行, 明暗, 抖动)"""
    fs = []
    for v in vs:
        if not v.is_valid:
            continue
        for f in v.link_faces:
            if f.is_valid and f not in fs:
                fs.append(f)
    for f in fs:
        c, n = f.calc_center_median(), f.normal
        r = fn((c.x, c.z, -c.y), (n.x, n.z, -n.y))
        if r:
            k.tag([f], r[0], _tone(r[0], r[1]), r[2], dust=0)
    return fs


def sheet(k, rows, row='slate', tone=0.5, jitter=0.05, thick=0.04, bind=None, dust=0):
    """布片：rows = 自上而下的若干排点（游戏坐标，每排同样多的点），带厚度的一整张（正反两面 + 一圈边），
    bind(点, 排号, 列号) → (骨骼名, 软接缝)。返回全部顶点"""
    bm = k.bm
    src = rows
    rows = [[X(p) for p in r] for r in rows]
    R, C = len(rows), len(rows[0])

    def nrm(i, j):
        a = Vector(rows[min(R - 1, i + 1)][j]) - Vector(rows[max(0, i - 1)][j])
        b = Vector(rows[i][min(C - 1, j + 1)]) - Vector(rows[i][max(0, j - 1)])
        n = b.cross(a)
        return n.normalized() if n.length > 1e-9 else Vector((0, 0, 1))
    F, Bk = [], []
    for i in range(R):
        fr, br = [], []
        for j in range(C):
            p, n = Vector(rows[i][j]), nrm(i, j)
            fr.append(bm.verts.new(g2b(tuple(p + n * thick / 2))))
            br.append(bm.verts.new(g2b(tuple(p - n * thick / 2))))
        F.append(fr)
        Bk.append(br)
    faces = []
    for i in range(R - 1):
        for j in range(C - 1):
            faces.append(bm.faces.new((F[i][j], F[i + 1][j], F[i + 1][j + 1], F[i][j + 1])))
            faces.append(bm.faces.new((Bk[i][j], Bk[i][j + 1], Bk[i + 1][j + 1], Bk[i + 1][j])))
    ring = [(0, j) for j in range(C)] + [(i, C - 1) for i in range(1, R)] + [(R - 1, j) for j in range(C - 2, -1, -1)] + [(i, 0) for i in range(R - 2, 0, -1)]
    for a, b in zip(ring, ring[1:] + ring[:1]):
        faces.append(bm.faces.new((F[a[0]][a[1]], Bk[a[0]][a[1]], Bk[b[0]][b[1]], F[b[0]][b[1]])))
    k.tag(faces, row, tone, jitter, dust=dust)
    vs = []
    for i in range(R):
        for j in range(C):
            bn, sf = bind(src[i][j], i, j)
            k.bind([F[i][j], Bk[i][j]], B[bn], sf)
            vs += [F[i][j], Bk[i][j]]
    return vs, faces


def _lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def _add(a, b, s=1.0):
    return tuple(a[i] + b[i] * s for i in range(3))


def _norm(v):
    l = math.sqrt(sum(x * x for x in v)) or 1.0
    return tuple(x / l for x in v)


# ---------------------------------------------------------------- 造型
def build(k):
    """搭形，返回 dict(skel, soft, clips, height)"""
    XF[0] = 1.0
    # ---- 蛛头胸：低平的一块甲壳（前窄后宽一点、背上平），六条腿都从它两侧长出来 ----
    csecs = [
        # (x, y, z, 半宽, 背高, 腹深, 方形度, 骨骼)
        (0, 2.44, 0.78, 0.26, 0.16, 0.14, 2.2, 'pelvis'),
        (0, 2.44, 0.62, 0.5, 0.28, 0.24, 2.3, 'pelvis'),
        (0, 2.43, 0.36, 0.68, 0.34, 0.28, 2.4, 'pelvis'),
        (0, 2.42, 0.05, 0.74, 0.36, 0.3, 2.4, 'pelvis'),
        (0, 2.42, -0.28, 0.68, 0.34, 0.28, 2.4, 'pelvis'),
        (0, 2.44, -0.52, 0.48, 0.26, 0.22, 2.3, 'pelvis'),
        (0, 2.46, -0.66, 0.26, 0.16, 0.15, 2.2, 'pelvis'),
    ]
    cvs, _ = zbody(k, csecs, sides=18, tone=0.4)
    retag(k, cvs, lambda p, n: ('basalt', 0.5, 0.05) if n[1] > 0.7 else ('char', 0.24, 0.05) if n[1] < -0.4 else None)
    # 头胸背上两块往后叠的背甲（中暗、四边焦黑），中间一道暗的脊
    for (z, w, l) in ((0.3, 0.46, 0.34), (-0.12, 0.52, 0.36)):
        hbox(k, 'pelvis', (0, 2.79 - (0.02 if z < 0 else 0), z), (w * 2, 0.07, l), rot=(-0.06, 0, 0), row='basalt', tone=0.56, bevel=0.03, taper=(0.86, 0.8))
    for s in (1, -1):
        hbox(k, 'pelvis', (s * 0.5, 2.68, 0.06), (0.32, 0.06, 0.7), rot=(0, 0, -s * 0.5), row='basalt', tone=0.46, bevel=0.025, taper=(0.8, 0.9))
    # ---- 蛛腹：水滴形，最粗的地方在前三分之一，尖朝后上；背上一道道暗的横纹，两道暗的霜光人字纹 ----
    asecs = [
        (0, 2.47, -0.6, 0.24, 0.2, 0.18, 2.1, 'pelvis'),
        (0, 2.5, -0.74, 0.46, 0.42, 0.36, 2.2, 'x_abd_01'),
        (0, 2.55, -0.98, 0.66, 0.6, 0.5, 2.3, 'x_abd_01'),
        (0, 2.6, -1.3, 0.77, 0.69, 0.56, 2.3, 'x_abd_01'),
        (0, 2.64, -1.66, 0.75, 0.67, 0.54, 2.3, 'x_abd_02'),
        (0, 2.68, -2.0, 0.62, 0.56, 0.45, 2.25, 'x_abd_02'),
        (0, 2.7, -2.3, 0.44, 0.4, 0.32, 2.2, 'x_abd_02'),
        (0, 2.72, -2.52, 0.2, 0.18, 0.15, 2.1, 'x_abd_02'),
    ]
    avs, _ = zbody(k, asecs, sides=20, tone=0.4)

    def abd_tone(p, n):
        if n[1] < -0.35:
            return ('char', 0.26, 0.05)
        if n[1] > 0.45:
            band = math.sin((p[2] + 0.6) * 7.0)
            return ('basalt', 0.52 if band > 0 else 0.34, 0.04)
        return None
    retag(k, avs, abd_tone)
    # 人字纹：两道暗的霜光，尖朝前（只两道，远不到近白）
    for z, w in ((-1.18, 0.5), (-1.72, 0.42)):
        for s in (1, -1):
            yy = 2.6 + 0.69 if z > -1.4 else 2.64 + 0.67
            hbox(k, 'x_abd_01' if z > -1.45 else 'x_abd_02', (s * w * 0.42, yy - 0.02 - abs(s * w * 0.42) * 0.18, z - w * 0.22), (0.1, 0.05, w * 1.1),
                 rot=(0.0, s * 0.85, -s * 0.28), row='starglass', tone=0.55, bevel=0.0, glow=0.46, dust=0)
    # 吐丝器：腹尖下面两个暗的小锥
    for s in (1, -1):
        loft(k, 'x_abd_02', [(s * 0.07, 2.66, -2.42), (s * 0.1, 2.56, -2.64)], [0.08, 0.0], sides=5, row='char', tone=0.3, tip=True)
    # 腹柄：头胸和蛛腹之间一圈暗的细腰（软接缝）
    loft(k, 'x_abd_01', [(0, 2.46, -0.52), (0, 2.48, -0.78)], [0.22, 0.26], sides=10, row='char', tone=0.26, soft=True)

    # ---- 腿：腿根一个关节球，股节斜着往上扬到膝（3.3 m），胫节长长地刺向地面，跗节收细、末端一截冰的爪尖；
    # 膝上一根往外上方翘的骨刺。截面略扁（侧面看粗、正面看也不细成线）。每节上面亮、下面暗 ----
    for nm in LEG_NAMES:
        fr, sd = nm[2], nm[-2]
        b1, b2, b3 = nm + '01', nm + '02', nm + '03'
        hp, kp, ap, tp = leg_pts(fr, sd)
        d = leg_dir(fr, sd)
        fem = _norm(tuple(kp[i] - hp[i] for i in range(3)))
        tib = _norm(tuple(ap[i] - kp[i] for i in range(3)))
        # 腿根（基节）：一块圆鼓的甲
        blob(k, b1, _add(hp, d, -0.04), (0.26, 0.22, 0.26), n=14, row='basalt', tone=0.34)
        # 股节：微微往上拱
        mid = _add(_add(_lerp(hp, kp, 0.5), (0, 1, 0), 0.12), d, -0.04)
        fv = loft(k, b1, [hp, _lerp(hp, mid, 0.5), mid, _lerp(mid, kp, 0.6), kp], [0.22, 0.215, 0.2, 0.185, 0.17], sides=8, squash=0.82, row='basalt', tone=0.42, soft=True)
        retag(k, fv, lambda p, n: ('basalt', 0.58, 0.04) if n[1] > 0.55 else ('basalt', 0.26, 0.04) if n[1] < -0.3 else None)
        # 股节背上一道细的暗霜光（俯视是六道往外放射的蓝线，元素一眼读得出，远不到近白）
        for a0, a1 in ((0.12, 0.48), (0.52, 0.86)):
            p0, p1 = _lerp(hp, mid, a0 * 2) if a0 < 0.5 else _lerp(mid, kp, a0 * 2 - 1), _lerp(hp, mid, a1 * 2) if a1 <= 0.5 else _lerp(mid, kp, a1 * 2 - 1)
            r0 = 0.22 - 0.05 * a0
            up = _norm(_add((0, 1, 0), fem, -fem[1]))
            q0, q1 = _add(p0, up, r0 * 0.8), _add(p1, up, (0.22 - 0.05 * a1) * 0.8)
            hull_frame(k, b1, [(-0.035, 0.0, -0.02), (0.035, 0.0, -0.02), (-0.035, 0.0, 0.02), (0.035, 0.0, 0.02), (-0.03, 1.0, -0.02), (0.03, 1.0, -0.02), (-0.03, 1.0, 0.02), (0.03, 1.0, 0.02)],
                       q0, tuple(q1[i] - q0[i] for i in range(3)), hint=up, row='starglass', tone=0.55, jitter=0.0, glow=0.42)
        # 膝：暗的关节球 + 骨刺（往外、往上翘，0.45 m）
        blob(k, b2, kp, (0.2, 0.19, 0.2), n=12, row='char', tone=0.3)
        sp = _norm(_add(_add(d, (0, 0.38, 0)), (0, 0, -1.0), 0.4))
        hull_frame(k, b2, [(-0.06, 0.0, -0.05), (0.06, 0.0, -0.05), (-0.06, 0.0, 0.05), (0.06, 0.0, 0.05), (0.0, 0.3, 0.0), (0.0, 0.13, 0.04)],
                   _add(kp, sp, 0.1), sp, hint=fem, row='starglass', tone=0.1, jitter=0.03)
        # 胫节：长，从膝到踝收细（中间往外鼓一点），三分之一处一道暗环
        t1, t2 = _add(_lerp(kp, ap, 0.33), d, 0.17), _add(_lerp(kp, ap, 0.66), d, 0.12)
        tv = loft(k, b2, [kp, t1, t2, ap], [0.165, 0.15, 0.125, 0.105], sides=8, squash=0.86, row='basalt', tone=0.38, soft=True)
        retag(k, tv, lambda p, n: ('basalt', 0.52, 0.04) if (n[0] * d[0] + n[2] * d[2]) > 0.4 and n[1] > -0.2 else ('basalt', 0.26, 0.04) if (n[0] * d[0] + n[2] * d[2]) < -0.5 else None)
        loft(k, b2, [_lerp(kp, ap, 0.3), _lerp(kp, ap, 0.36)], [0.165, 0.16], sides=8, squash=0.86, row='char', tone=0.24, jitter=0.03)
        blob(k, b3, ap, (0.12, 0.12, 0.12), n=10, row='char', tone=0.3)
        # 跗节 + 冰爪：踝 → 离地 0.16 m 是暗甲，最后一截是冰（一点暗的霜光）
        cl = _lerp(ap, tp, 0.5)
        loft(k, b3, [ap, cl], [0.1, 0.085], sides=7, squash=0.9, row='basalt', tone=0.3, soft=True)
        loft(k, b3, [_lerp(ap, tp, 0.44), _lerp(ap, tp, 0.74), tp], [0.092, 0.075, 0.0], sides=6, row='starglass', tone=0.55, tip=True, glow=0.4)

    XF[0] = UB_SCALE
    # ---- 袍子和上身：从头胸前上方立起来；袍摆在头胸上往外撒开一圈，细腰（暗的系带），胸、肩收窄（成人比例），霜丝外袍、胸前一道暗的内衬 ----
    tsecs = [
        # (y, x, z, 半宽, 前深, 后深, 方形度, 骨骼)
        (2.6, 0, 0.42, 0.62, 0.56, 0.48, 2.0, 'pelvis'),
        (2.78, 0, 0.44, 0.45, 0.37, 0.33, 2.0, 'spine_01'),
        (2.98, 0, 0.46, 0.25, 0.2, 0.18, 2.0, 'spine_01'),
        (3.2, 0, 0.47, 0.29, 0.21, 0.19, 2.0, 'spine_02'),
        (3.44, 0, 0.48, 0.35, 0.23, 0.21, 2.05, 'spine_03'),
        (3.64, 0, 0.48, 0.39, 0.22, 0.2, 2.1, 'spine_03'),
        (3.8, 0, 0.47, 0.37, 0.18, 0.18, 2.1, 'spine_03'),
        (3.92, 0, 0.47, 0.16, 0.12, 0.12, 2.0, 'neck_01'),
    ]
    tv, _ = ybody(k, tsecs, sides=18, row='slate', tone=0.46)
    # 袍摆往下那一圈深一档（裙摆的阴影面），腰上一道暗的系带，胸前一道窄的暗内衬
    retag(k, tv, lambda p, n: ('slate', 0.34, 0.03) if p[1] < 2.72 else None)
    hull_g(k, 'spine_03', [(-0.08, 3.8, 0.66), (0.08, 3.8, 0.66), (-0.035, 3.48, 0.72), (0.035, 3.48, 0.72), (0, 3.1, 0.7), (-0.06, 3.8, 0.6), (0.06, 3.8, 0.6), (0, 3.14, 0.64)], row='obsidian', tone=0.2, jitter=0.03)
    loft(k, 'spine_01', [(0, 2.95, 0.46), (0, 3.03, 0.46)], [0.27, 0.27], sides=12, squash=0.78, row='char', tone=0.22, jitter=0.03)
    hull_g(k, 'spine_01', [(-0.05, 2.99, 0.66), (0.05, 2.99, 0.66), (-0.04, 2.7, 0.7), (0.04, 2.7, 0.7), (0, 2.6, 0.68), (0, 2.99, 0.6)], row='char', tone=0.22, jitter=0.03)  # 系带垂下的一截
    # 袍摆前面垂下的一片（软的布，挂在 spine_01 上），盖住头胸前沿
    rows = []
    for i, f in enumerate((0.0, 0.33, 0.66, 1.0)):
        y = 2.74 - 0.5 * f
        rr = []
        for x in (-1, -0.5, 0, 0.5, 1):
            rr.append((x * 0.36 * (1 + 0.2 * f), y - (k.r(0, 0.05) if i == 3 else 0), 0.86 + 0.2 * f - 0.06 * x * x))
        rows.append(rr)
    sheet(k, rows, row='slate', tone=0.36, thick=0.035, bind=lambda p, i, j: ('spine_01', i > 0))
    # ---- 胸口的霜结：近白的芯（两处近白之一）+ 六根短的霜光刺和六根更细更长的淡光丝（元素色，远看是胸口一点亮、一圈淡蓝） ----
    kc = PIV['x_core']
    XF[0] = 1.0
    blob(k, 'x_core', kc, (0.1, 0.1, 0.065), n=14, row='starglass', tone=0.98, jitter=0.01, glow=1.0)
    for i in range(12):
        a = TAU * i / 12 + 0.26
        dd = (math.cos(a), math.sin(a), 0.14)
        ln, w, g = (0.27, 0.03, 0.5) if i % 2 == 0 else (0.36, 0.016, 0.32)
        hull_frame(k, 'x_core', [(-w, 0.07, -w * 0.7), (w, 0.07, -w * 0.7), (-w, 0.07, w * 0.7), (w, 0.07, w * 0.7), (0, ln, 0)], kc, dd, hint=(0, 0, 1), row='starglass', tone=0.6, jitter=0.0, glow=g)
    XF[0] = UB_SCALE
    # ---- 手臂：霜丝的袖子（上臂收、前臂外张成喇叭袖，袖口亮一档），袖口里是暗甲的小臂，细长的手（四根长指 + 拇指） ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        ua, la, hd = 'upperarm_' + sd, 'lowerarm_' + sd, 'hand_' + sd
        pu, pl, ph = [ub(PIV[n], 1 / UB_SCALE) for n in (ua, la, hd)]  # 枢轴已经放大过：零件按放大前的坐标写，再经 X() 一起放大
        loft(k, ua, [_add(pu, (0, 0.06, 0)), _lerp(pu, pl, 0.5), pl], [0.135, 0.125, 0.115], sides=8, row='slate', tone=0.5, soft=False)
        blob(k, ua, _add(pu, (s * 0.03, -0.01, 0)), (0.15, 0.12, 0.15), n=12, row='slate', tone=0.48)  # 肩头
        cv = loft(k, la, [pl, _lerp(pl, ph, 0.45), _lerp(pl, ph, 0.8)], [0.115, 0.16, 0.22], sides=9, row='slate', tone=0.46, cap1=False, soft=True)
        retag(k, cv, lambda p, n: ('slate', 0.62, 0.03) if p[1] < _lerp(pl, ph, 0.6)[1] * UB_SCALE + UB_PIV[1] * (1 - UB_SCALE) else None)
        loft(k, la, [_lerp(pl, ph, 0.5), ph], [0.065, 0.055], sides=6, row='basalt', tone=0.36)
        hbox(k, hd, _add(ph, (0, -0.08, 0.02)), (0.07, 0.16, 0.11), row='basalt', tone=0.4, bevel=0.02)
        for i in range(4):
            off = (i - 1.5) * 0.026
            base = _add(ph, (0.0, -0.15, 0.02 + off))
            loft(k, hd, [base, _add(base, (s * 0.01, -0.1, 0.02)), _add(base, (s * 0.01, -0.2, 0.05))], [0.016, 0.014, 0.0], sides=4, row='basalt', tone=0.42, tip=True, jitter=0.02)
        loft(k, hd, [_add(ph, (-s * 0.03, -0.1, 0.06)), _add(ph, (-s * 0.05, -0.16, 0.11))], [0.016, 0.0], sides=4, row='basalt', tone=0.42, tip=True, jitter=0.02)
    # ---- 颈、头：细长的颈（高领），脸（灰白，眉骨 / 鼻梁 / 颧骨，两道很窄的霜光眼缝）藏在一顶霜丝的兜帽里（帽尖往后），帽口一圈暗的内衬 ----
    loft(k, 'neck_01', [(0, 3.86, 0.47), (0, 4.0, 0.48), (0, 4.12, 0.49)], [0.1, 0.085, 0.08], sides=8, row='pale', tone=0.3, soft=True)
    hull_g(k, 'neck_01', [(-0.17, 3.84, 0.62), (0.17, 3.84, 0.62), (-0.18, 3.84, 0.34), (0.18, 3.84, 0.34), (-0.13, 4.02, 0.6), (0.13, 4.02, 0.6), (-0.14, 4.04, 0.36), (0.14, 4.04, 0.36)], row='slate', tone=0.4)  # 高领
    H0 = (0.0, 4.08, 0.5)
    H = lambda p: tuple(H0[i] + (p[i] - H0[i]) * 0.9 for i in range(3))  # 头小一号（成人比例：头小、脖子和躯干长）
    face = [(-0.15, 4.2, 0.62), (0.15, 4.2, 0.62), (-0.1, 4.08, 0.64), (0.1, 4.08, 0.64), (0, 4.04, 0.65),
            (-0.16, 4.38, 0.6), (0.16, 4.38, 0.6), (-0.13, 4.5, 0.57), (0.13, 4.5, 0.57), (0, 4.54, 0.56),
            (-0.15, 4.3, 0.42), (0.15, 4.3, 0.42), (0, 4.46, 0.4), (0, 4.16, 0.44), (0, 4.32, 0.7)]
    hull_g(k, 'head', [H(p) for p in face], row='pale', tone=0.34, jitter=0.03)
    hull_g(k, 'head', [H(p) for p in [(-0.12, 4.4, 0.62), (0.12, 4.4, 0.62), (-0.11, 4.44, 0.6), (0.11, 4.44, 0.6), (0, 4.43, 0.66), (0, 4.38, 0.65)]], row='pale', tone=0.22, jitter=0.02)  # 眉骨
    hull_g(k, 'head', [H(p) for p in [(0, 4.38, 0.66), (-0.03, 4.25, 0.69), (0.03, 4.25, 0.69), (0, 4.23, 0.72), (0, 4.24, 0.66)]], row='pale', tone=0.44, jitter=0.02)  # 鼻梁
    for s in (1, -1):
        hull_g(k, 'head', [H(p) for p in [(s * 0.14, 4.32, 0.58), (s * 0.11, 4.26, 0.63), (s * 0.14, 4.2, 0.58), (s * 0.16, 4.27, 0.54), (s * 0.12, 4.3, 0.6)]], row='pale', tone=0.42, jitter=0.02)  # 颧骨
        hbox(k, 'head', H((s * 0.065, 4.34, 0.64)), (0.068, 0.018, 0.027), rot=(0, -s * 0.2, s * 0.15), row='starglass', tone=0.6, bevel=0.0, glow=0.5, dust=0)
    hood = [(0, 4.64, 0.34), (0, 4.58, 0.5), (-0.13, 4.6, 0.44), (0.13, 4.6, 0.44),
            (-0.2, 4.42, 0.56), (0.2, 4.42, 0.56), (-0.2, 4.18, 0.54), (0.2, 4.18, 0.54), (-0.18, 4.0, 0.5), (0.18, 4.0, 0.5),
            (-0.18, 4.4, 0.3), (0.18, 4.4, 0.3), (0, 4.42, 0.2), (0, 4.12, 0.22), (-0.18, 3.96, 0.3), (0.18, 3.96, 0.3), (0, 3.92, 0.26)]
    hull_g(k, 'head', [H(p) for p in hood], row='slate', tone=0.6, jitter=0.03)
    for s in (1, -1):  # 帽口两侧一道暗的内衬（脸和兜帽分得开）
        hull_g(k, 'head', [H(p) for p in [(s * 0.17, 4.48, 0.6), (s * 0.2, 4.4, 0.59), (s * 0.2, 4.1, 0.56), (s * 0.15, 4.02, 0.56), (s * 0.15, 4.4, 0.52), (s * 0.15, 4.1, 0.5)]], row='obsidian', tone=0.18, jitter=0.02)
    # ---- 冰冠：帽檐上方一圈暗的冰箍，五片收紧的冰刃（中间最高，往外依次矮、略往外斜）；中间那片是霜光（元素色），根部一点近白 ----
    ck = ub(PIV['x_crown'], 1 / UB_SCALE)
    for i, (a, h) in enumerate(((-0.52, 0.24), (-0.26, 0.33), (0.0, 0.42), (0.26, 0.33), (0.52, 0.24))):
        dd = (-math.sin(a), math.cos(a), -0.12)
        base = (ck[0] + math.sin(-a) * 0.15, ck[1] - 0.02, ck[2] + 0.1 - abs(a) * 0.08)
        g = 0.5 if i == 2 else 0
        hull_frame(k, 'x_crown', [(-0.065, 0.0, -0.035), (0.065, 0.0, -0.035), (-0.065, 0.0, 0.035), (0.065, 0.0, 0.035), (-0.042, h * 0.6, 0.0), (0.042, h * 0.55, 0.0), (0.0, h, 0.0)],
                   base, dd, hint=(1, 0, 0), row='starglass', tone=0.6 if g else 0.42, jitter=0.03, glow=g)
    blob(k, 'x_crown', (ck[0], ck[1] + 0.06, ck[2] + 0.12), (0.04, 0.05, 0.03), n=10, row='starglass', tone=0.98, jitter=0.0, glow=1.0)
    loft(k, 'x_crown', [(-0.16, 4.43, 0.55), (0, 4.46, 0.62), (0.16, 4.43, 0.55)], [0.026, 0.03, 0.026], sides=4, row='starglass', tone=0.3, jitter=0.02)
    # ---- 霜纱（两层，淡的霜丝）：外层是一圈搭在肩上的短披（前面开口、下摆参差，正面看是一对淡色的肩）；
    # 内层从肩胛垂下、往后往两边撒开，铺在头胸背上（宽过上身，游戏镜头从前上方两边都看得见） ----
    rows = []
    for i, (y, r) in enumerate(((3.97, 0.19), (3.88, 0.42), (3.7, 0.54), (3.5, 0.6))):
        rr = []
        for j in range(11):
            th = math.radians(54 + 252 * j / 10)  # 从左前绕过背后到右前（前面开口，露出胸口的霜结）
            yy = y - (k.r(0.0, 0.07) if i == 3 else 0) - (0.06 * abs(math.cos(th)) if i == 3 else 0)
            rr.append((math.sin(th) * r, yy, 0.45 + math.cos(th) * r * 0.78))
        rows.append(rr)
    sheet(k, rows, row='slate', tone=0.44, thick=0.03, bind=lambda p, i, j: ('spine_03', False))
    loft(k, 'spine_03', [_add(p, (0, -0.012, 0)) for p in rows[-1]], [0.022] * len(rows[-1]), sides=4, row='slate', tone=0.82, jitter=0.02, cap0=False, cap1=False)  # 下摆一道淡的亮边

    def veil_bone(p, i, j):
        return ('x_veil_01' if p[1] > 3.3 else 'x_veil_02' if p[2] > -0.2 else 'x_veil_03', i > 0)
    path = [(3.76, 0.26, 0.34), (3.42, 0.12, 0.5), (3.12, -0.02, 0.62), (2.96, -0.26, 0.74), (2.9, -0.56, 0.82), (2.86, -0.82, 0.86)]
    rows = []
    for i, (y, z, hw) in enumerate(path):
        f = i / (len(path) - 1)
        rr = []
        for j in range(9):
            x = (j / 8) * 2 - 1
            yy = y + 0.06 * (1 - x * x) * f - (k.r(0.0, 0.08) if i == len(path) - 1 else 0) - 0.1 * x * x * f
            rr.append((x * hw, yy, z - 0.14 * x * x * f))
        rows.append(rr)
    sheet(k, rows, row='slate', tone=0.4, thick=0.03, bind=veil_bone)
    # 亮边：下摆和两侧各一道细的淡霜丝边（不透明的细条，不加 draw）；中间是暗一档的淡填充
    for edge in (rows[-1], [r[0] for r in rows], [r[-1] for r in rows]):
        pts = [_add(p, (0, 0.012, 0)) for p in edge]
        loft(k, 'x_veil_01', pts, [0.022] * len(pts), sides=4, row='slate', tone=0.8, jitter=0.02, cap0=False, cap1=False, rings=[veil_bone(p, 1, 0)[0] for p in edge])
    XF[0] = 1.0

    soft = [
        # (子骨骼, 父骨骼, 枢轴, 轴（父 → 子）, 带宽)
        ('spine_01', 'pelvis', PIV['spine_01'], (0, 1, 0), 0.24),
        ('spine_02', 'spine_01', PIV['spine_02'], (0, 1, 0), 0.24),
        ('spine_03', 'spine_02', PIV['spine_03'], (0, 1, 0), 0.24),
        ('neck_01', 'spine_03', PIV['neck_01'], (0, 1, 0), 0.12),
        ('x_abd_01', 'pelvis', PIV['x_abd_01'], (0, 0, -1), 0.3),
        ('x_abd_02', 'x_abd_01', PIV['x_abd_02'], (0, 0.1, -1), 0.45),
        ('x_veil_02', 'x_veil_01', PIV['x_veil_02'], (0, -1, -0.3), 0.4),
        ('x_veil_03', 'x_veil_02', PIV['x_veil_03'], (0, -0.2, -1), 0.4),
    ]
    for sd in ('l', 'r'):
        soft.append(('lowerarm_' + sd, 'upperarm_' + sd, PIV['lowerarm_' + sd], (0.15, -1, 0.06), 0.16))
    for nm in LEG_NAMES:
        hp, kp, ap, tp = leg_pts(nm[2], nm[-2])
        fem = _norm(tuple(kp[i] - hp[i] for i in range(3)))
        tib = _norm(tuple(ap[i] - kp[i] for i in range(3)))
        tar = _norm(tuple(tp[i] - ap[i] for i in range(3)))
        soft.append((nm + '02', nm + '01', kp, _norm(_add(fem, tib)), 0.2))
        soft.append((nm + '03', nm + '02', ap, _norm(_add(tib, tar)), 0.14))
    from .weaver_clips import CLIPS
    return dict(skel=SKEL, soft=soft, clips=CLIPS, height=4.96)
