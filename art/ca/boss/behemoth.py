# 衔星巨兽（第 4 区坠星裂谷首领）：沉重的四足古兽，把坠落的星从裂开的天上拖进烬渊。
# 后躯低、肩峰高，一条长颈向前低探，楔形的头，嘴里衔着一颗星（一小团近白的芯，周围几片元素色的弱光，不是一整团亮球）；
# 一对琉璃角从后脑往上、再往前弯（一整根光滑的多棱角，不分叉，读起来不是鹿角）。短粗的尾巴，象腿一样粗的腿，脚下是蹄甲。
# 背甲是被烧焦、裂开的板岩色石甲（当年驮星的地方），裂缝里透出细细的星辉（青色的受光面）和几道暗的元素色光缝，
# 俯视是一个长水滴：宽的身子 + 细长的颈和头，嘴前一点亮。
# 材质：暖中性的暗玄武岩色做皮（和青绿的裂谷地面拉开冷暖），背甲是中暗的石色、边缘焦黑，骨（獠牙、牙）只用暗的几小块，
# 琉璃角是星辉行的中间调（不到近白）。近白的只有嘴里的星芯。尺寸、身高、招式时序见 design-note §2 / §4；
# 坐标一律写游戏坐标（x 左、y 上、z 前），进 Kit 时经 rig.g2b 换成 Blender 坐标。
import math

from mathutils import Euler, Vector

from .. import rig
from ..rig import g2b

TAU = 2 * math.pi

# 骨架（29 根）：枢轴是游戏坐标。左 = +x（巨兽自己的左边），面朝 +z。
# 颈的后两节不是人形部位（人形只有 neck_01），按命名规则写成 x_neck_02 / x_neck_03
BONES = [
    ('pelvis', None, (0, 2.55, -1.25)),
    ('spine_01', 'pelvis', (0, 2.66, -0.45)),
    ('spine_02', 'spine_01', (0, 2.84, 0.3)),
    ('spine_03', 'spine_02', (0, 3.05, 1.05)),
    ('neck_01', 'spine_03', (0, 3.35, 1.8)),
    ('x_neck_02', 'neck_01', (0, 3.62, 2.5)),
    ('x_neck_03', 'x_neck_02', (0, 3.86, 3.18)),
    ('head', 'x_neck_03', (0, 4.0, 3.76)),
    ('x_jaw', 'head', (0, 3.8, 3.97)),
    ('x_star', 'head', (0, 3.86, 4.95)),
    ('x_plate_01', 'spine_03', (0, 3.95, 0.95)),
    ('x_plate_02', 'spine_02', (0, 3.72, 0.0)),
    ('x_plate_03', 'pelvis', (0, 3.42, -1.2)),
    ('x_tail_01', 'pelvis', (0, 2.62, -2.35)),
    ('x_tail_02', 'x_tail_01', (0, 2.4, -2.9)),
    ('x_tail_03', 'x_tail_02', (0, 2.12, -3.35)),
    ('x_tail_04', 'x_tail_03', (0, 1.84, -3.68)),
    ('x_fleg_l_01', 'spine_03', (1.02, 2.78, 1.12)),
    ('x_fleg_l_02', 'x_fleg_l_01', (1.08, 1.5, 1.2)),
    ('x_fleg_l_03', 'x_fleg_l_02', (1.08, 0.42, 1.26)),
    ('x_fleg_r_01', 'spine_03', (-1.02, 2.78, 1.12)),
    ('x_fleg_r_02', 'x_fleg_r_01', (-1.08, 1.5, 1.2)),
    ('x_fleg_r_03', 'x_fleg_r_02', (-1.08, 0.42, 1.26)),
    ('x_hleg_l_01', 'pelvis', (0.98, 2.5, -1.52)),
    ('x_hleg_l_02', 'x_hleg_l_01', (1.04, 1.32, -1.8)),
    ('x_hleg_l_03', 'x_hleg_l_02', (1.04, 0.42, -1.62)),
    ('x_hleg_r_01', 'pelvis', (-0.98, 2.5, -1.52)),
    ('x_hleg_r_02', 'x_hleg_r_01', (-1.04, 1.32, -1.8)),
    ('x_hleg_r_03', 'x_hleg_r_02', (-1.04, 0.42, -1.62)),
]
SKEL = rig.Skel(BONES)
B = SKEL.index
PIV = {b[0]: b[2] for b in BONES}

# 皮（玄武岩行）的色带位置整体往亮的一头挪一点（灰度检查：受光面 p85 要到 ~50% 以上；颜色只能靠色带位置给）
HIDE_LIFT = 0.22


def _tone(row, tone):
    return min(0.92, tone + HIDE_LIFT) if row == 'basalt' else tone


def _rot(r):
    return Euler((r[0], r[1], r[2]), 'ZYX').to_matrix()  # 游戏的 XYZ 欧拉：R = Rx · Ry · Rz


# 头部那一段零件按「原来的头」的坐标写，统一经 XF 挪到现在的头上（往前、往上、放大一点）：改头的位置只改 HEAD_XF
HEAD_XF = ((0, 3.68, 3.42), (0, 4.0, 3.76), 1.14)  # (原枢轴, 新枢轴, 放大)
XF = [None]


def X(p):
    f = XF[0]
    if not f:
        return p
    o, n, sc = f
    return (n[0] + (p[0] - o[0]) * sc, n[1] + (p[1] - o[1]) * sc, n[2] + (p[2] - o[2]) * sc)


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


def hbox(k, bone, c, s, rot=(0, 0, 0), row='basalt', tone=0.5, jitter=0.05, bevel=0.05, taper=(1.0, 1.0), glow=0, dust=0, soft=False, jit=0.0):
    """倒一刀的盒子（凸包），c = 中心，s = 三边长，taper = 顶面（+y）在 x / z 上的收缩比例，jit = 角点随机抖动"""
    a, b, cc = s[0] / 2, s[1] / 2, s[2] / 2
    d = min(bevel, a * 0.45, b * 0.45, cc * 0.45)
    loc = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                tx, tz = (taper[0], taper[1]) if sy > 0 else (1.0, 1.0)
                cand = [(sx * a, sy * (b - d), sz * (cc - d)), (sx * (a - d), sy * b, sz * (cc - d)), (sx * (a - d), sy * (b - d), sz * cc)] if d > 0 else [(sx * a, sy * b, sz * cc)]
                for p in cand:
                    loc.append((p[0] * tx + k.r(-jit, jit), p[1] + k.r(-jit, jit) * 0.5, p[2] * tz + k.r(-jit, jit)))
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow, dust, soft)


def blob(k, bone, c, r, n=14, rot=(0, 0, 0), row='basalt', tone=0.5, jitter=0.06, glow=0, dust=0, flat=0.0, soft=False):
    """椭球面上的点取凸包（腿根的肌肉、膝甲、星芯这类圆鼓鼓的件）"""
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
    """沿折线的渐变截面管（椭圆截面：squash < 1 压扁）；soft = 软接缝；tip = 末端收成尖；
    rings = 每一圈绑哪根骨骼（长度 = 点数；颈、尾这种一根管子跨好几根骨骼的，按圈绑、软接缝渐变）"""
    sc = XF[0][2] if XF[0] else 1.0
    vs, segs = k.tube([g2b(X(p)) for p in pts], [r * sc for r in radii], sides=sides, row=row, tone=_tone(row, tone), jitter=jitter, tip=tip, cap0=cap0, cap1=cap1, squash=squash, twist=twist)
    k.tag([f for sg in segs for f in sg], row, tone if glow else _tone(row, tone), 0.04 if glow else jitter, glow=glow, dust=0)
    if rings is None:
        return k.bind(vs, B[bone], soft)
    i = 0
    for j, bn in enumerate(rings):
        n = 1 if (tip and j == len(rings) - 1) else sides
        k.bind(vs[i:i + n], B[bn], True)
        i += n
    return vs


def body(k, secs, sides=16, row='basalt', tone=0.36, jitter=0.05, wob=0.035):
    """身子：沿 z 的一串横截面（每个截面在 z = 常数的平面里：中心 (x, y)、半宽 a、背高 ht、腹深 hb、截面的方形度 sq、骨骼），
    截面是上下不对称的超椭圆（背平、腹深），每一圈按截面绑骨骼（软接缝渐变），首尾封口。返回 (全部顶点, 面列表)"""
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
            ring.append(bm.verts.new(g2b((cx + x * j, cy + y * j, cz + k.r(-wob, wob) * 0.5))))
        k.bind(ring, B[bn], bn != 'pelvis')  # 骨盆那几圈刚性（不然臀尾那一圈会按距离跟着尾巴摆）
        rings.append(ring)
    faces = []
    for i in range(len(rings) - 1):
        A, C = rings[i], rings[i + 1]
        for j in range(sides):
            faces.append(bm.faces.new((A[j], C[j], C[(j + 1) % sides], A[(j + 1) % sides])))
    faces.append(bm.faces.new(list(reversed(rings[0]))))
    faces.append(bm.faces.new(rings[-1]))
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


def slits(k, vs, axis, n=1, width=0.2, depth=0.025, row='starglass', glow=0, minarea=0.01, skip=0):
    """在这块零件朝 axis（游戏坐标）的面里挑 n 个最大的面切出窄缝：glow = 0 是星辉的受光面（青，不进发光网格），
    glow > 0 是元素色的暗光缝（进发光网格，远不到近白）"""
    a = Vector(g2b(axis)).normalized()
    fs = []
    for v in vs:
        if not v.is_valid:
            continue
        for f in v.link_faces:
            if f not in fs and f.is_valid:
                fs.append(f)
    fs = [f for f in fs if f.normal.dot(a) > 0.55 and f.calc_area() > minarea and f[k.L_glow] <= 0]
    fs.sort(key=lambda f: -f.calc_area())
    return [k.slit(f, width=width, depth=depth, row=row, glow=glow) for f in fs[skip:skip + n]]


def plate(k, bone, c, s, rot=(0, 0, 0), tone=0.34, side_tone=0.2, taper=(0.8, 0.82), bevel=0.08, jit=0.04, vein=1, glowseam=0, vein_w=0.16):
    """背甲：一块斜着的石甲（凸包盒），朝上的面是中暗的石色，四周的侧面焦黑（slag），朝上的面里切几道星辉细缝 / 元素色暗缝"""
    vs = hbox(k, bone, c, s, rot, row='basalt', tone=tone, bevel=bevel, taper=taper, jit=jit)
    up = _rot(rot) @ Vector((0, 1, 0))
    retag(k, vs, lambda p, n: None if (n[0] * up.x + n[1] * up.y + n[2] * up.z) > 0.6 else ('slag', side_tone, 0.06))
    upg = (up.x, up.y, up.z)
    if glowseam:
        slits(k, vs, upg, n=glowseam, width=vein_w * 0.9, depth=0.03, row='starglass', glow=0.5)
    if vein:
        slits(k, vs, upg, n=vein, width=vein_w, depth=0.02, row='starglass', glow=0, skip=glowseam)
    return vs


def _top(secs, z):
    """身子在 z 处的背高（截面表里线性插值）"""
    for a, b in zip(secs, secs[1:]):
        if a[2] <= z <= b[2]:
            t = (z - a[2]) / (b[2] - a[2])
            return (a[1] + a[4]) * (1 - t) + (b[1] + b[4]) * t
    return secs[0][1] + secs[0][4] if z < secs[0][2] else secs[-1][1] + secs[-1][4]


def scute(k, bone, c, size, th, rot=(0, 0, 0), tone=0.24, edge_tone=0.14, n=9, dome=0.4, vein=0, glowseam=0, vein_w=0.16):
    """一片圆的鳞甲：底面一圈不规则的椭圆、顶面收一圈、中心再鼓一点（凸包），size = (半宽, 半长)，th = 厚；
    朝上的面是中暗的石色，四周的侧面焦黑（slag），朝上的面里切星辉细缝 / 元素色暗缝"""
    w, l = size
    loc = []
    ph = k.r(0, TAU)
    for i in range(n):
        a = ph + TAU * i / n
        r = 1 + k.r(-0.08, 0.08)
        loc.append((math.cos(a) * w * r, 0.0, math.sin(a) * l * r))
        loc.append((math.cos(a) * w * r * 0.8, th, math.sin(a) * l * r * 0.8))
    loc.append((k.r(-0.05, 0.05) * w, th * (1 + dome), k.r(-0.05, 0.05) * l))
    vs = hull_at(k, bone, loc, c, rot, row='basalt', tone=tone, jitter=0.05)
    up = _rot(rot) @ Vector((0, 1, 0))
    retag(k, vs, lambda p, nn: None if (nn[0] * up.x + nn[1] * up.y + nn[2] * up.z) > 0.55 else ('slag', edge_tone, 0.05))
    upg = (up.x, up.y, up.z)
    if glowseam:
        slits(k, vs, upg, n=glowseam, width=vein_w * 0.9, depth=0.03, row='starglass', glow=0.5, minarea=0.004)
    if vein:
        slits(k, vs, upg, n=vein, width=vein_w, depth=0.02, row='starglass', glow=0, skip=glowseam, minarea=0.004)
    return vs


def _m(p):
    return (-p[0], p[1], p[2])


# ---------------------------------------------------------------- 造型
def build(k):
    """搭形，返回 dict(skel, soft, clips, height)"""
    XF[0] = None
    # ---- 身子：一整条带软接缝的皮囊，后躯低（臀顶 ~3.5 m）、肩峰高（~4.15 m）、胸深、腰收一点；按截面绑骨盆 → 三节脊椎 ----
    secs = [
        # (x, y, z, 半宽, 背高, 腹深, 方形度, 骨骼)
        (0, 2.62, -2.55, 0.39, 0.34, 0.4, 2.2, 'pelvis'),
        (0, 2.66, -2.3, 0.83, 0.7, 0.78, 2.4, 'pelvis'),
        (0, 2.66, -1.85, 1.03, 0.84, 0.92, 2.5, 'pelvis'),
        (0, 2.66, -1.3, 1.09, 0.88, 0.96, 2.5, 'pelvis'),
        (0, 2.68, -0.75, 1.03, 0.88, 0.96, 2.4, 'spine_01'),
        (0, 2.72, -0.2, 1.02, 0.92, 1.0, 2.4, 'spine_01'),
        (0, 2.8, 0.3, 1.09, 1.0, 1.06, 2.5, 'spine_02'),
        (0, 2.9, 0.75, 1.17, 1.22, 1.12, 2.5, 'spine_02'),
        (0, 2.98, 1.15, 1.18, 1.28, 1.14, 2.5, 'spine_03'),
        (0, 3.04, 1.55, 1.05, 1.1, 1.08, 2.4, 'spine_03'),
        (0, 3.12, 1.88, 0.81, 0.8, 0.9, 2.3, 'spine_03'),
        (0, 3.22, 2.08, 0.49, 0.5, 0.6, 2.2, 'spine_03'),
    ]
    bvs, bfs = body(k, secs, sides=22, row='basalt', tone=0.42)
    # 腹部（朝下的面）亮一点、背脊两侧暗一点：俯视的主色是背甲和暗皮，侧面看得出上下两色
    retag(k, bvs, lambda p, n: ('basalt', 0.42, 0.06) if n[1] < -0.45 else ('basalt', 0.22, 0.05) if n[1] > 0.75 else None)
    # 皮的褶：肩后、腰前两道横着的皮褶（压扁的圆环，深一点的皮色），弯的时候看得出是软的
    for (z, bn, a, ht, hb, y) in ((0.05, 'spine_02', 1.12, 0.96, 1.02, 2.78), (-0.95, 'spine_01', 1.13, 0.9, 0.96, 2.68)):
        ring = []
        for i in range(14):
            th = TAU * i / 14
            c, s = math.cos(th), math.sin(th)
            ring.append((a * 1.04 * math.copysign(abs(c) ** 0.8, c), y + (ht if s > 0 else hb) * 1.04 * math.copysign(abs(s) ** 0.8, s)))
        pts = [(x, yy, z) for x, yy in ring]
        for i in range(14):
            p0, p1 = pts[i], pts[(i + 1) % 14]
            if p0[1] > y + 0.2 and p1[1] > y + 0.2:  # 只要上半圈（背上那一段叫背甲盖住，侧面露出来）
                hull_g(k, bn, [p0, p1, (p0[0] * 0.93, y + (p0[1] - y) * 0.93, z + 0.12), (p1[0] * 0.93, y + (p1[1] - y) * 0.93, z + 0.12),
                               (p0[0] * 0.93, y + (p0[1] - y) * 0.93, z - 0.12), (p1[0] * 0.93, y + (p1[1] - y) * 0.93, z - 0.12)], row='basalt', tone=0.18, jitter=0.03, soft=True)

    # ---- 背甲：一片片圆的鳞甲顺着背叠下来（像瓦片，前一片压着后一片），中间一排暗的骨刺，肩峰上的最大、最高；
    # 中暗的石色、四边焦黑，几片的裂缝里细细的星辉（青）和几道暗的元素色光缝（俯视看得出是「星的兽」，但不发白） ----
    top = lambda z: _top(secs, z)
    rows = [  # (z, 半宽, 长, 侧排?)
        (1.55, 0.5, 0.62, True), (1.06, 0.56, 0.7, True), (0.52, 0.54, 0.66, True), (-0.02, 0.5, 0.62, False),
        (-0.56, 0.5, 0.62, True), (-1.1, 0.52, 0.66, True), (-1.66, 0.48, 0.6, False), (-2.12, 0.38, 0.46, False),
    ]
    veins = {(1.55, -1), (1.06, -1), (0.52, 1), (-0.02, 1), (-0.02, -1), (-1.1, 1), (-1.66, -1), (1.55, 1)}
    for (z, w, l, flank) in rows:
        bn = 'x_plate_01' if z > 0.7 else 'x_plate_02' if z > -0.9 else 'x_plate_03'
        y = top(z)
        for s in (1, -1):
            scute(k, bn, (s * w * 0.92, y - 0.1 - w * 0.12, z), (w * 1.05, l), 0.2, rot=(-0.16, 0, -s * 0.34), tone=0.18,
                  vein=1 if (z, s) in veins else 0)
            if flank:
                scute(k, bn, (s * (w * 1.62 + 0.02), y - 0.52, z - 0.08), (w * 0.62, l * 0.86), 0.16, rot=(-0.1, 0, -s * 0.86), tone=0.16, vein=0)
    # 星的光缝：背脊两边、鳞甲之间各一道细长的元素色暗光（按骨骼分段），肩峰上再横着裂开两道——俯视是两条细亮线，不是一块块光斑
    for s in (1, -1):
        for (z0, z1) in ((1.7, 0.75), (0.65, -0.85), (-0.95, -1.95)):
            bn = 'x_plate_01' if z0 > 0.7 else 'x_plate_02' if z0 > -0.9 else 'x_plate_03'
            n = 3
            for i in range(n):
                za, zb = z0 + (z1 - z0) * i / n, z0 + (z1 - z0) * (i + 1) / n
                zm = (za + zb) / 2
                hbox(k, bn, (s * 0.2, top(zm) - 0.02, zm), (0.11, 0.05, abs(zb - za) * 0.92), rot=(math.atan2(top(za) - top(zb), za - zb) * -1, s * 0.06, 0),
                     row='starglass', tone=0.6, bevel=0.0, glow=0.42, dust=0)
        for (z, a) in ((1.25, 0.55), (0.35, -0.45)):
            hbox(k, 'x_plate_01' if z > 0.7 else 'x_plate_02', (s * 0.62, top(z) + 0.04, z), (0.7, 0.05, 0.1), rot=(0, s * a, -s * 0.34), row='starglass', tone=0.6, bevel=0.0, glow=0.4, dust=0)
    # 背脊：一排暗的骨刺（grime 行：暗褐的骨，不让俯视发白），肩峰上最高
    for (z, h) in ((1.32, 0.38), (0.8, 0.48), (0.26, 0.42), (-0.3, 0.34), (-0.84, 0.3), (-1.4, 0.28), (-1.92, 0.22)):
        bn = 'x_plate_01' if z > 0.7 else 'x_plate_02' if z > -0.9 else 'x_plate_03'
        hull_at(k, bn, [(-0.1, 0, -0.18), (0.1, 0, -0.18), (-0.1, 0, 0.16), (0.1, 0, 0.16), (0, h, -0.16), (0, h * 0.7, 0.02)], (0, top(z) - 0.02, z), rot=(-0.25, 0, 0), row='grime', tone=0.26, jitter=0.05)
    # 背上驮过星的地方：肩峰和背中之间一圈焦黑的裂口，裂口里一块星辉的断面（青，受光面，不发光）
    hbox(k, 'spine_02', (0, 3.74, 0.62), (0.7, 0.2, 0.42), rot=(-0.05, 0.3, 0), row='char', tone=0.2, bevel=0.04, jit=0.04)
    for (x, z, a) in ((0.16, 0.58, 0.4), (-0.18, 0.66, -0.5), (0.02, 0.5, 0.1)):
        hull_at(k, 'spine_02', [(-0.06, 0, -0.05), (0.06, 0, -0.05), (0, 0, 0.07), (0, 0.24, 0)], (x, 3.8, z), rot=(0.3, a, 0.2 * a), row='starglass', tone=0.45, jitter=0.06)

    # ---- 肩和胯：腿根上方各一块圆鼓的肌肉（暗皮）和一片侧甲 ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        blob(k, 'x_fleg_' + sd + '_01', (s * 1.0, 2.55, 1.12), (0.46, 0.75, 0.6), n=16, row='basalt', tone=0.28)
        blob(k, 'x_hleg_' + sd + '_01', (s * 0.96, 2.35, -1.55), (0.5, 0.8, 0.68), n=16, row='basalt', tone=0.28)
        scute(k, 'spine_03', (s * 1.24, 3.06, 1.34), (0.46, 0.5), 0.14, rot=(0, 0, -s * 1.3), tone=0.22, vein=0)

    # ---- 腿：象腿一样粗的柱子（上段带软接缝弯到下段），膝前一块甲，脚下宽的蹄，蹄前三片暗骨的蹄甲 ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        for fr in ('f', 'h'):
            b1, b2, b3 = 'x_%sleg_%s_01' % (fr, sd), 'x_%sleg_%s_02' % (fr, sd), 'x_%sleg_%s_03' % (fr, sd)
            p1, p2, p3 = PIV[b1], PIV[b2], PIV[b3]
            front = fr == 'f'
            mid = ((p1[0] + p2[0]) / 2 + s * 0.04, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2 + (0.06 if front else -0.1))
            loft(k, b1, [(p1[0], p1[1] + 0.25, p1[2]), mid, (p2[0], p2[1] - 0.05, p2[2])], [0.48 if front else 0.52, 0.44, 0.36], sides=12, row='basalt', tone=0.26, soft=True)
            loft(k, b2, [(p2[0], p2[1] + 0.12, p2[2]), ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2, (p2[2] + p3[2]) / 2), (p3[0], p3[1] - 0.02, p3[2])], [0.36, 0.33, 0.37], sides=12, row='basalt', tone=0.22, soft=True)
            # 膝甲：前腿在膝前、后腿在跗关节后面
            kz = p2[2] + (0.3 if front else -0.28)
            plate(k, b2, (p2[0], p2[1] + 0.02, kz), (0.5, 0.5, 0.24), rot=(0.25 if front else -0.25, 0, 0), tone=0.3, side_tone=0.2, taper=(0.86, 1.0), bevel=0.06, vein=0)
            # 蹄：宽扁的暗色蹄身，前面三片蹄甲（暗骨），一道黄铜色的旧箍（很窄、暗）
            hx, hz = p3[0], p3[2] + 0.06
            loft(k, b3, [(hx, 0.0, hz), (hx, 0.2, hz), (hx, 0.44, hz)], [0.45, 0.43, 0.37], sides=10, row='slag', tone=0.3, jitter=0.04)
            for t in (-1, 0, 1):
                hull_at(k, b3, [(-0.13, 0, -0.08), (0.13, 0, -0.08), (-0.11, 0, 0.12), (0.11, 0, 0.12), (-0.1, 0.24, -0.06), (0.1, 0.24, -0.06), (0, 0.2, 0.08)],
                        (hx + t * 0.24, 0.0, hz + 0.34 - abs(t) * 0.07), rot=(0, t * 0.35, 0), row='grime', tone=0.36, jitter=0.04)

    # ---- 长颈：一根从胸前斜着往上、往前伸的管子（按圈绑 spine_03 → neck_01 → x_neck_02 → x_neck_03 → head），颈背一排暗的骨鳞 ----
    npts = [(0, 3.22, 1.6), (0, 3.42, 2.05), (0, 3.64, 2.56), (0, 3.85, 3.1), (0, 3.98, 3.55), (0, 4.05, 3.88)]
    nvs = loft(k, 'neck_01', npts, [0.7, 0.56, 0.48, 0.43, 0.41, 0.4], sides=14, squash=1.18, row='basalt', tone=0.28, rings=['spine_03', 'neck_01', 'x_neck_02', 'x_neck_03', 'head', 'head'])
    retag(k, nvs, lambda p, n: ('basalt', 0.4, 0.05) if n[1] < -0.5 else ('basalt', 0.2, 0.05) if n[1] > 0.7 else None)
    for i, (y, z, w) in enumerate(((4.02, 1.98, 0.6), (4.16, 2.5, 0.52), (4.34, 3.0, 0.46), (4.48, 3.44, 0.42))):
        bn = ('neck_01', 'x_neck_02', 'x_neck_03', 'x_neck_03')[i]
        plate(k, bn, (0, y - 0.1, z), (w, 0.16, 0.44), rot=(-0.42, 0, 0), tone=0.32, side_tone=0.2, taper=(0.7, 0.8), bevel=0.05, vein=1 if i in (1, 3) else 0, vein_w=0.2)

    XF[0] = HEAD_XF
    # ---- 头：楔形的长头（后脑宽、吻部收窄），额上一块暗骨的额板，两侧一对很小的暗光眼缝；张着一点嘴 ----
    hv = hull_g(k, 'head', [
        (0.44, 3.98, 3.3), (-0.44, 3.98, 3.3), (0.48, 3.56, 3.28), (-0.48, 3.56, 3.28),  # 后脑
        (0.4, 4.08, 3.62), (-0.4, 4.08, 3.62), (0.44, 3.58, 3.7),  (-0.44, 3.58, 3.7),  # 额 / 颊
        (0.28, 3.98, 4.0), (-0.28, 3.98, 4.0), (0.3, 3.6, 4.1), (-0.3, 3.6, 4.1),
        (0.17, 3.86, 4.36), (-0.17, 3.86, 4.36), (0.18, 3.62, 4.42), (-0.18, 3.62, 4.42),  # 吻
    ], row='basalt', tone=0.3, jitter=0.05)
    retag(k, hv, lambda p, n: ('basalt', 0.4, 0.05) if n[1] < -0.5 else None)
    hbox(k, 'head', (0, 4.1, 3.62), (0.66, 0.12, 0.72), rot=(0.12, 0, 0), row='grime', tone=0.32, bevel=0.04, taper=(0.8, 0.8))
    hbox(k, 'head', (0, 3.98, 4.06), (0.36, 0.1, 0.4), rot=(0.22, 0, 0), row='grime', tone=0.28, bevel=0.03, taper=(0.8, 0.8))
    for s in (1, -1):
        hbox(k, 'head', (s * 0.42, 3.84, 3.86), (0.05, 0.06, 0.18), rot=(0, s * 0.3, 0), row='starglass', tone=0.5, bevel=0.0, glow=0.42, dust=0)
        # 颊上一道骨棱（暗骨），从眼下顺到吻
        hbox(k, 'head', (s * 0.36, 3.72, 3.92), (0.12, 0.12, 0.62), rot=(0, s * 0.22, 0), row='grime', tone=0.3, bevel=0.03)
    # 上颚的牙：吻前两颗咬着星的獠牙（暗骨），往下弯
    for s in (1, -1):
        loft(k, 'head', [(s * 0.16, 3.64, 4.34), (s * 0.19, 3.48, 4.44), (s * 0.15, 3.36, 4.52)], [0.07, 0.055, 0.0], sides=5, row='bone', tone=0.2, tip=True)
    # 下颚：从颊下的铰链到下巴，前端两颗往上翘的牙；一点点张开（星卡在牙缝里）
    jv = hull_g(k, 'x_jaw', [
        (0.4, 3.56, 3.44), (-0.4, 3.56, 3.44), (0.36, 3.3, 3.5), (-0.36, 3.3, 3.5),
        (0.24, 3.46, 4.06), (-0.24, 3.46, 4.06), (0.22, 3.26, 4.02), (-0.22, 3.26, 4.02),
        (0.14, 3.42, 4.34), (-0.14, 3.42, 4.34), (0.12, 3.3, 4.32), (-0.12, 3.3, 4.32),
    ], row='basalt', tone=0.26, jitter=0.05)
    retag(k, jv, lambda p, n: ('basalt', 0.4, 0.05) if n[1] < -0.5 else None)
    for s in (1, -1):
        loft(k, 'x_jaw', [(s * 0.13, 3.42, 4.28), (s * 0.15, 3.56, 4.36), (s * 0.12, 3.68, 4.4)], [0.06, 0.05, 0.0], sides=5, row='bone', tone=0.2, tip=True)
    # 口腔：上下颚之间一片暗的星光（元素色、很暗），张嘴吐息时看得见
    hbox(k, 'x_jaw', (0, 3.5, 3.95), (0.32, 0.06, 0.62), row='starglass', tone=0.5, bevel=0.0, glow=0.4, dust=0)

    # ---- 嘴里的星：一小团近白的芯（唯一近白的地方），外面五片短的元素色光棱（不是一整团亮球），一圈熔合的焦石咬在牙间 ----
    sc = (0, 3.56, 4.46)  # 原来的头上的位置（经 XF 挪到 x_star 的枢轴上）
    blob(k, 'x_star', sc, (0.14, 0.14, 0.14), n=14, row='starglass', tone=0.98, jitter=0.01, glow=1.0, dust=0)
    for i in range(5):
        a = TAU * i / 5 + 0.3
        d = (math.cos(a) * 0.9, math.sin(a) * 0.9 + 0.25, 0.35)
        u, v, w = _frame(d)
        base = Vector(sc)
        pts = [tuple(base + v * 0.08 + u * 0.05), tuple(base + v * 0.08 - u * 0.05), tuple(base + v * 0.08 + w * 0.05), tuple(base + v * 0.08 - w * 0.05), tuple(base + v * 0.3)]
        hull_g(k, 'x_star', pts, row='starglass', tone=0.6, jitter=0.02, glow=0.55)
    for i in range(4):
        a = TAU * i / 4 + 0.78
        blob(k, 'x_star', (sc[0] + math.cos(a) * 0.17, sc[1] + math.sin(a) * 0.15, sc[2] - 0.06), (0.08, 0.07, 0.08), n=9, row='char', tone=0.18, jitter=0.04)

    # ---- 琉璃角：从后脑往上、再往前弯的一整根多棱角（不分叉），角根一圈暗的黄铜箍；星辉的中间调，俯视是头两侧往前的两道青 ----
    for s in (1, -1):
        hp = [(s * 0.3, 3.98, 3.36), (s * 0.48, 4.42, 3.22), (s * 0.66, 4.86, 3.3), (s * 0.74, 5.2, 3.6), (s * 0.68, 5.36, 3.98), (s * 0.56, 5.38, 4.3)]
        loft(k, 'head', hp, [0.17, 0.155, 0.135, 0.11, 0.075, 0.0], sides=6, row='starglass', tone=0.42, jitter=0.07, tip=True, twist=0.08)
        loft(k, 'head', [(s * 0.32, 4.02, 3.35), (s * 0.36, 4.12, 3.32)], [0.22, 0.22], sides=8, row='brass', tone=0.2, jitter=0.03)

    XF[0] = None
    # ---- 尾：短粗的四节（按圈绑），尾梢一根暗的星辉晶刺 ----
    tp = [(0, 2.66, -2.28), (0, 2.46, -2.82), (0, 2.18, -3.28), (0, 1.9, -3.62), (0, 1.66, -3.86), (0, 1.5, -4.0)]
    tvs = loft(k, 'x_tail_01', tp, [0.44, 0.36, 0.28, 0.2, 0.13, 0.0], sides=10, squash=1.05, row='basalt', tone=0.28, tip=True, rings=['pelvis', 'x_tail_01', 'x_tail_02', 'x_tail_03', 'x_tail_04', 'x_tail_04'])
    retag(k, tvs, lambda p, n: ('basalt', 0.2, 0.05) if n[1] > 0.6 else None)
    for i, (y, z) in enumerate(((2.98, -2.55), (2.68, -3.05), (2.34, -3.45))):
        bn = ('x_tail_01', 'x_tail_02', 'x_tail_03')[i]
        hull_at(k, bn, [(-0.08, 0, -0.14), (0.08, 0, -0.14), (-0.08, 0, 0.12), (0.08, 0, 0.12), (0, 0.2 - i * 0.04, -0.12)], (0, y - 0.04, z), rot=(-0.6, 0, 0), row='grime', tone=0.3, jitter=0.04)
    hull_at(k, 'x_tail_04', [(-0.07, 0, -0.06), (0.07, 0, -0.06), (0, 0, 0.08), (0, 0.06, 0), (0, -0.36, -0.1)], (0, 1.62, -3.9), rot=(0.9, 0, 0), row='starglass', tone=0.36, jitter=0.04)

    soft = [
        # (子骨骼, 父骨骼, 枢轴, 轴（父 → 子）, 带宽)
        ('spine_01', 'pelvis', PIV['spine_01'], (0, 0, 1), 0.7),
        ('spine_02', 'spine_01', PIV['spine_02'], (0, 0, 1), 0.6),
        ('spine_03', 'spine_02', PIV['spine_03'], (0, 0, 1), 0.6),
        ('neck_01', 'spine_03', PIV['neck_01'], (0, 0.3, 1), 0.5),
        ('x_neck_02', 'neck_01', PIV['x_neck_02'], (0, 0.25, 1), 0.45),
        ('x_neck_03', 'x_neck_02', PIV['x_neck_03'], (0, 0.2, 1), 0.4),
        ('head', 'x_neck_03', PIV['head'], (0, 0.15, 1), 0.35),
        ('x_tail_01', 'pelvis', PIV['x_tail_01'], (0, -0.35, -1), 0.4),
        ('x_tail_02', 'x_tail_01', PIV['x_tail_02'], (0, -0.5, -1), 0.35),
        ('x_tail_03', 'x_tail_02', PIV['x_tail_03'], (0, -0.7, -1), 0.3),
        ('x_tail_04', 'x_tail_03', PIV['x_tail_04'], (0, -0.8, -1), 0.25),
    ]
    for sd in ('l', 'r'):
        for fr in ('f', 'h'):
            soft.append(('x_%sleg_%s_02' % (fr, sd), 'x_%sleg_%s_01' % (fr, sd), PIV['x_%sleg_%s_02' % (fr, sd)], (0, -1, 0), 0.32))
    from .behemoth_clips import CLIPS
    return dict(skel=SKEL, soft=soft, clips=CLIPS, height=5.38)
