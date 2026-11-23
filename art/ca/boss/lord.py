# 烬渊之主（第 3 区首领）：成人比例（头约 0.75 m，1 : 7）的披甲霸主。宽的肩甲线、收窄的腰、一圈裙甲；
# 一对巨角往后掠（俯视看得见），头顶浮着一圈细的五点余烬冠；背后两扇刃翼，每扇四片叠着的刃羽，平时收拢、出招时张开；
# 右手拖着巨剑，剑尖贴着地；披风从两翼中间垂下。材质：黑曜石（新行 obsidian：暗紫黑的玻璃，棱上是浅色高光）、
# 深红布（新行 crimson：披风、前襟、刃羽的内层）、骨（肋栅、巨角、护手）、黄铜做少量的金边。
# 发光：胸口骨肋后面的熔炉（近白的芯在火色的炉壁里），冠上五个尖，剑脊上一道细的血槽，甲片接缝里几道暗的余烬缝。
# 尺寸、身高、招式时序见 design-note §2 / §4；坐标一律写游戏坐标（x 左、y 上、z 前），进 Kit 时经 rig.g2b 换成 Blender 坐标。
import math

import bmesh
from mathutils import Euler, Vector

from .. import rig
from ..rig import g2b

TAU = 2 * math.pi

# 刃翼（左翼，游戏坐标）：翼骨折线五个点（第三个点 = x_wing_l_02 的枢轴），刃羽往下垂的方向（y、z 分量）、每片往外偏多少、多长
WING_ARM = [(0.4, 3.72, -0.42), (0.95, 4.12, -0.72), (1.5, 4.26, -1.02), (2.05, 3.98, -1.32), (2.45, 3.55, -1.5)]
WING_DD = (-0.55, -0.8)
WING_FEATHERS = [(0.55, 1.6, 0.15), (1.25, 1.95, 0.32), (2.1, 2.2, 0.5), (2.75, 2.0, 0.7)]  # (翼骨上的位置 0–4, 长度, 往外偏)

# 骨架（31 根 = 20 根标准 + 剑、两翼各两节、披风三节、前襟、冠、炉芯）：枢轴是游戏坐标。左 = +x（它自己的左边），面朝 +z
BONES = [
    ('pelvis', None, (0, 2.36, 0)),
    ('spine_01', 'pelvis', (0, 2.62, -0.02)),
    ('spine_02', 'spine_01', (0, 3.0, -0.04)),
    ('spine_03', 'spine_02', (0, 3.4, -0.04)),
    ('neck_01', 'spine_03', (0, 3.98, 0.0)),
    ('head', 'neck_01', (0, 4.18, 0.04)),
    ('clavicle_l', 'spine_03', (0.24, 3.84, -0.02)),
    ('upperarm_l', 'clavicle_l', (0.98, 3.78, -0.04)),
    ('lowerarm_l', 'upperarm_l', (1.12, 2.96, -0.02)),
    ('hand_l', 'lowerarm_l', (1.2, 2.2, 0.06)),
    ('clavicle_r', 'spine_03', (-0.24, 3.84, -0.02)),
    ('upperarm_r', 'clavicle_r', (-0.98, 3.78, -0.04)),
    ('lowerarm_r', 'upperarm_r', (-1.12, 2.96, -0.02)),
    ('hand_r', 'lowerarm_r', (-1.2, 2.2, 0.06)),
    ('x_sword', 'hand_r', (-1.2, 2.02, 0.12)),
    ('x_core', 'spine_02', (0, 3.32, 0.3)),
    ('x_wing_l_01', 'spine_03', (0.4, 3.72, -0.42)),
    ('x_wing_l_02', 'x_wing_l_01', 'WING2L'),
    ('x_wing_r_01', 'spine_03', (-0.4, 3.72, -0.42)),
    ('x_wing_r_02', 'x_wing_r_01', 'WING2R'),
    ('x_cape_01', 'spine_03', (0, 3.66, -0.5)),
    ('x_cape_02', 'x_cape_01', (0, 2.56, -0.64)),
    ('x_cape_03', 'x_cape_02', (0, 1.46, -0.76)),
    ('x_tab', 'pelvis', (0, 2.42, 0.44)),
    ('x_crown', 'head', (0, 5.02, 0.0)),
    ('thigh_l', 'pelvis', (0.36, 2.24, 0.0)),
    ('calf_l', 'thigh_l', (0.4, 1.2, 0.04)),
    ('foot_l', 'calf_l', (0.42, 0.2, 0.02)),
    ('thigh_r', 'pelvis', (-0.36, 2.24, 0.0)),
    ('calf_r', 'thigh_r', (-0.4, 1.2, 0.04)),
    ('foot_r', 'calf_r', (-0.42, 0.2, 0.02)),
]
BONES = [(n, p, (WING_ARM[2] if c == 'WING2L' else (-WING_ARM[2][0], WING_ARM[2][1], WING_ARM[2][2]) if c == 'WING2R' else c)) for n, p, c in BONES]
SKEL = rig.Skel(BONES)
B = SKEL.index
PIV = {b[0]: b[2] for b in BONES}

# 剑：握在右手里（x_sword 枢轴），静止姿态剑尖斜指身前的地面，离地留一点（不和地面打架）
SWORD_TIP = (-1.5, 0.08, 2.02)
SWORD_LEN = 2.72  # 枢轴 → 剑尖

# 黑曜石的色带位置整体往亮的一头挪（灰度：受光面 p85 要到 ~50% 以上、比地面亮 15 点；颜色只能靠色带位置给）
OBS_LIFT = 0.18


def _tone(row, tone):
    return min(0.94, tone + OBS_LIFT) if row == 'obsidian' else tone


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


def hull_at(k, bone, local, c, rot=(0, 0, 0), row='obsidian', tone=0.5, jitter=0.06, glow=0, dust=0, soft=False):
    vs = k.hull(_pts(local, c, rot), row, _tone(row, tone), jitter, glow, dust)
    return k.bind(vs, B[bone], soft)


def hull_frame(k, bone, pts_uvw, o, d, hint=(1, 0, 0), row='obsidian', tone=0.5, jitter=0.05, glow=0, dust=0):
    """局部 (u, v, w) 点集 → 以 o 为原点、v 沿 d 的凸包（剑、刃羽这类斜着的长件）"""
    u, v, w = _frame(d, hint)
    O = Vector(o)
    P = [g2b(tuple(O + u * a + v * b + w * c)) for a, b, c in pts_uvw]
    vs = k.hull(P, row, _tone(row, tone), jitter, glow, dust)
    return k.bind(vs, B[bone])


def hbox(k, bone, c, s, rot=(0, 0, 0), row='obsidian', tone=0.5, jitter=0.05, bevel=0.04, taper=(1.0, 1.0), glow=0, dust=0, soft=False):
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


def blob(k, bone, c, r, n=14, rot=(0, 0, 0), row='obsidian', tone=0.5, jitter=0.06, glow=0, dust=0, flat=0.0):
    """椭球面上的点取凸包（护膝、肩头、炉芯这类圆鼓鼓的件）"""
    loc = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        u = (i + 0.5) / n
        y = 1 - 2 * u
        rr = math.sqrt(max(0.0, 1 - y * y))
        a = ga * i + k.r(-0.2, 0.2)
        yy = max(y, -1 + flat * 2) if flat else y
        loc.append((math.cos(a) * rr * r[0], yy * r[1], math.sin(a) * rr * r[2]))
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow, dust)


def loft(k, bone, pts, radii, sides=8, squash=1.0, row='obsidian', tone=0.5, jitter=0.05, cap0=True, cap1=True, twist=0.0, soft=False, glow=0, tip=False):
    """沿折线的渐变截面管（椭圆截面：squash < 1 压扁）；soft = 软接缝；tip = 末端收成尖"""
    vs, segs = k.tube([g2b(p) for p in pts], radii, sides=sides, row=row, tone=_tone(row, tone), jitter=jitter, tip=tip, cap0=cap0, cap1=cap1, squash=squash, twist=twist)
    if glow:
        k.tag([f for sg in segs for f in sg], row, tone, 0.04, glow=glow, dust=0)
    else:
        k.tag([f for sg in segs for f in sg], row, _tone(row, tone), jitter, dust=0)
    return k.bind(vs, B[bone], soft)


def sheet(k, rows, row='crimson', tone=0.5, jitter=0.05, thick=0.04, bind=None, dust=0):
    """布片：rows = 自上而下的若干排点（游戏坐标，每排同样多的点），带厚度的一整张（正反两面 + 一圈边），
    bind(点, 排号, 列号) → (骨骼名, 软接缝)。返回全部顶点"""
    bm = k.bm
    R, C = len(rows), len(rows[0])
    # 每个点的法向：排方向 × 列方向，往两边各挪半个厚度
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
            bn, sf = bind(rows[i][j], i, j)
            k.bind([F[i][j], Bk[i][j]], B[bn], sf)
            vs += [F[i][j], Bk[i][j]]
    return vs


def torus(k, bone, c, R, r, segs=16, sides=4, row='brass', tone=0.6, rot=(0, 0, 0), glow=0, jitter=0.03, squash=1.0):
    """圆环（金边、冠环）：中心 c，环所在的平面是转过 rot 的 xz 平面"""
    bm = k.bm
    M = _rot(rot)
    rings = []
    for i in range(segs):
        a = TAU * i / segs
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for j in range(sides):
            b = TAU * j / sides + math.pi / sides
            rr = R + r * math.cos(b)
            p = M @ Vector((ca * rr, r * math.sin(b) * squash, sa * rr))
            ring.append(bm.verts.new(g2b((c[0] + p.x, c[1] + p.y, c[2] + p.z))))
        rings.append(ring)
    faces = []
    for i in range(segs):
        A, Bq = rings[i], rings[(i + 1) % segs]
        for j in range(sides):
            faces.append(bm.faces.new((A[j], Bq[j], Bq[(j + 1) % sides], A[(j + 1) % sides])))
    k.tag(faces, row, tone, jitter, glow=glow, dust=0)
    vs = [v for rg in rings for v in rg]
    return k.bind(vs, B[bone])


def seam(k, vs, axis, n=1, width=0.26, depth=0.025, glow=0.5, minarea=0.008):
    """在这块零件朝 axis（游戏坐标）的面里挑 n 个最大的面切出余烬窄缝（暗、火色，不到近白）"""
    a = Vector(g2b(axis)).normalized()
    fs = []
    for v in vs:
        if not v.is_valid:
            continue
        for f in v.link_faces:
            if f not in fs and f.is_valid:
                fs.append(f)
    fs = [f for f in fs if f.normal.dot(a) > 0.55 and f.calc_area() > minarea]
    fs.sort(key=lambda f: -f.calc_area())
    return [k.slit(f, width=width, depth=depth, row='ember', glow=glow) for f in fs[:n]]


def _m(p):
    return (-p[0], p[1], p[2])


# ---------------------------------------------------------------- 造型
def build(k):
    """搭形，返回 dict(skel, soft, clips, height)"""
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        X = lambda x: x * s
        th, ca, ft = 'thigh_' + sd, 'calf_' + sd, 'foot_' + sd
        # ---- 腿：护腿甲（小腿外鼓、脚踝收），尖头的铁靴、脚背一片甲，护膝是一块朝前的尖甲；大腿一截暗的甲，外侧挂裙甲 ----
        hull_at(k, ft, [(-0.17, 0.0, -0.3), (0.17, 0.0, -0.3), (-0.2, 0.0, 0.3), (0.2, 0.0, 0.3), (0.0, 0.0, 0.72), (-0.15, 0.3, -0.24), (0.15, 0.3, -0.24),
                        (-0.16, 0.26, 0.16), (0.16, 0.26, 0.16), (0.0, 0.12, 0.66), (0.0, 0.34, 0.0)], (X(0.42), 0.0, 0.02), row='obsidian', tone=0.42)
        hull_at(k, ft, [(-0.14, 0.18, 0.12), (0.14, 0.18, 0.12), (0.0, 0.3, 0.0), (-0.12, 0.28, -0.08), (0.12, 0.28, -0.08), (0.0, 0.14, 0.5), (0.0, 0.22, 0.32)], (X(0.42), 0.02, 0.02), row='obsidian', tone=0.66)
        loft(k, ca, [(X(0.42), 0.28, 0.02), (X(0.41), 0.55, 0.04), (X(0.4), 0.88, 0.05), (X(0.4), 1.16, 0.04)], [0.19, 0.23, 0.27, 0.24], sides=10, squash=0.9, row='obsidian', tone=0.48)
        loft(k, ca, [(X(0.42), 0.34, 0.02), (X(0.42), 0.4, 0.02)], [0.215, 0.215], sides=8, squash=0.9, row='brass', tone=0.55, jitter=0.02)
        hull_at(k, ca, [(-0.12, -0.32, 0.2), (0.12, -0.32, 0.2), (0.0, -0.38, 0.29), (-0.17, 0.22, 0.24), (0.17, 0.22, 0.24), (0.0, 0.24, 0.34), (-0.12, -0.32, 0.12), (0.12, -0.32, 0.12), (-0.15, 0.22, 0.12), (0.15, 0.22, 0.12)],
                (X(0.4), 0.72, 0.05), row='obsidian', tone=0.7)  # 小腿正面一道棱（受光面的高光）
        hull_at(k, ca, [(-0.17, -0.14, 0.0), (0.17, -0.14, 0.0), (0.0, -0.22, 0.24), (-0.2, 0.12, 0.08), (0.2, 0.12, 0.08), (0.0, 0.2, 0.3), (0.0, 0.0, 0.4), (-0.13, 0.18, -0.06), (0.13, 0.18, -0.06)],
                (X(0.4), 1.2, 0.08), row='obsidian', tone=0.74)  # 护膝
        loft(k, th, [(X(0.37), 2.2, 0.0), (X(0.39), 1.75, 0.02), (X(0.4), 1.3, 0.04)], [0.3, 0.28, 0.23], sides=10, squash=0.95, row='obsidian', tone=0.42)
        # 裙甲：每边一前一侧两片（挂在大腿上，迈腿时跟着走），一片背后的挂在骨盆上；下缘一道金边
        for (ang, w, z0) in ((0.35, 0.52, 0.32), (1.25, 0.5, 0.06)):
            cx, cz = X(math.sin(ang) * 0.5), math.cos(ang) * 0.5 - 0.06 + z0 * 0.2
            r = (0.12, s * ang, 0.0)
            # 三片往下叠的甲片（上面一片压着下面一片，下缘往外翻一点），最下面一片收成尖
            for li, (y0, y1, ww, zo) in enumerate(((0.0, -0.34, 1.0, 0.0), (-0.24, -0.58, 0.96, 0.035), (-0.48, -0.9, 0.92, 0.07))):
                plate = [(-w / 2 * ww, y0, zo), (w / 2 * ww, y0, zo), (-w / 2 * ww, y0, zo - 0.07), (w / 2 * ww, y0, zo - 0.07),
                         (-w * 0.48 * ww, y1 + (0.1 if li == 2 else 0), zo + 0.06), (w * 0.48 * ww, y1 + (0.1 if li == 2 else 0), zo + 0.06), (-w * 0.48 * ww, y1, zo - 0.01), (w * 0.48 * ww, y1, zo - 0.01)]
                if li == 2:
                    plate += [(0.0, y1, zo + 0.04), (0.0, y1, zo - 0.02)]
                hull_at(k, th, plate, (cx, 2.4, cz), r, row='obsidian', tone=(0.62 if ang < 1 else 0.54) - 0.05 * li)
            hull_at(k, th, [(-w * 0.47, -0.7, 0.115), (w * 0.47, -0.7, 0.115), (-w * 0.47, -0.78, 0.115), (w * 0.47, -0.78, 0.115), (0.0, -0.9, 0.095), (-w * 0.46, -0.74, 0.08), (w * 0.46, -0.74, 0.08), (0, -0.86, 0.06)],
                    (cx, 2.4, cz), r, row='brass', tone=0.62, jitter=0.02)
    for s in (1, -1):  # 铁靴脚背上两道叠甲
        for li in range(2):
            hull_at(k, 'foot_' + ('l' if s > 0 else 'r'), [(-0.15, 0.0, -0.06), (0.15, 0.0, -0.06), (-0.16, 0.0, 0.08), (0.16, 0.0, 0.08), (-0.13, 0.09, -0.05), (0.13, 0.09, -0.05), (0.0, 0.11, 0.06)],
                    (s * 0.42, 0.24 - 0.07 * li, 0.18 + 0.15 * li), (0.5, 0, 0), row='obsidian', tone=0.6 - 0.06 * li)
    # ---- 胯：一整块暗的胯甲，金腰带，背后两片裙甲 ----
    hbox(k, 'pelvis', (0, 2.3, -0.02), (0.92, 0.44, 0.66), row='obsidian', tone=0.36, bevel=0.1, taper=(1.08, 1.05))
    torus(k, 'pelvis', (0, 2.52, -0.02), 0.5, 0.05, segs=14, sides=4, row='brass', tone=0.6, squash=1.4, rot=(0, 0, 0))
    hull_at(k, 'pelvis', [(-0.12, -0.1, 0), (0.12, -0.1, 0), (-0.12, 0.1, 0), (0.12, 0.1, 0), (0, 0, 0.1), (-0.1, 0, -0.04), (0.1, 0, -0.04)], (0, 2.52, 0.5), row='bone', tone=0.6)  # 腰带扣：一块骨
    for s in (1, -1):
        hull_at(k, 'pelvis', [(-0.28, 0, 0), (0.28, 0, 0), (-0.28, 0, 0.07), (0.28, 0, 0.07), (-0.24, -0.8, -0.08), (0.24, -0.8, -0.08), (-0.24, -0.8, -0.01), (0.24, -0.8, -0.01), (0, -0.92, -0.06)],
                (s * 0.27, 2.42, -0.5), (-0.14, 0, -s * 0.06), row='obsidian', tone=0.5)
    # 前襟（深红长布，挂在 x_tab 上，下端收成尖，边上一道金边）
    rows = []
    for i, (y, hw, z) in enumerate(((2.46, 0.28, 0.5), (2.1, 0.27, 0.54), (1.7, 0.26, 0.56), (1.3, 0.24, 0.55), (0.98, 0.22, 0.52))):
        rows.append([(x * hw, y - (0.12 * (1 - abs(x)) if i == 4 else 0), z + 0.04 * (1 - x * x)) for x in (-1, -0.5, 0, 0.5, 1)])
    rows.append([(x * 0.1, 0.8 - 0.08 * (1 - abs(x)), 0.5) for x in (-1, -0.5, 0, 0.5, 1)])
    sheet(k, rows, row='crimson', tone=0.68, thick=0.04, bind=lambda p, i, j: ('x_tab', False))
    for s in (1, -1):
        loft(k, 'x_tab', [(s * 0.29, 2.44, 0.52), (s * 0.27, 1.7, 0.58), (s * 0.23, 1.0, 0.54), (s * 0.1, 0.8, 0.52)], [0.026] * 4, sides=4, row='brass', tone=0.6, jitter=0.02)
    hull_at(k, 'x_tab', [(-0.11, 0.12, 0), (0.11, 0.12, 0), (0, -0.16, 0), (0, 0, 0.05), (-0.08, 0.06, -0.01), (0.08, 0.06, -0.01)], (0, 1.62, 0.6), row='brass', tone=0.66)  # 前襟上一块金饰（菱形）

    # ---- 腰：暗的黑曜石腰身（软接缝：和胯、胸之间弯折时不开口），前后两道腹甲 ----
    loft(k, 'spine_01', [(0, 2.5, -0.03), (0, 2.75, -0.03), (0, 3.02, -0.04)], [0.46, 0.42, 0.48], sides=10, squash=0.72, row='obsidian', tone=0.34, soft=True)
    for i, y in enumerate((2.72, 2.92)):
        hbox(k, 'spine_01' if i == 0 else 'spine_02', (0, y, 0.25), (0.78 - 0.04 * i, 0.2, 0.22), rot=(-0.12, 0, 0), row='obsidian', tone=0.6 + 0.06 * i, bevel=0.05, taper=(1.06, 1.0))
    # ---- 胸甲：左右两块宽胸板夹着炉口；炉膛往里收（暗红炉壁，火色的弱光），炉芯一小团近白，前面横着三对骨肋 ----
    for s in (1, -1):
        X = lambda x: x * s
        pec = [(X(0.12), 3.0, 0.3), (X(0.12), 3.86, 0.36), (X(0.5), 3.04, 0.34), (X(0.66), 3.9, 0.36), (X(0.78), 3.62, 0.22), (X(0.56), 2.98, 0.0),
               (X(0.12), 2.96, -0.1), (X(0.8), 3.8, -0.2), (X(0.66), 3.0, -0.4), (X(0.12), 3.0, -0.42), (X(0.12), 3.92, -0.42), (X(0.6), 3.98, -0.34), (X(0.5), 3.98, 0.24), (X(0.12), 3.96, 0.2)]
        pv = hull_at(k, 'spine_03', pec, (0, 0, 0), row='obsidian', tone=0.56)
        seam(k, pv, (s * 0.5, 0.3, 0.8), n=1, width=0.16, glow=0.5)  # 胸板上一道暗的余烬缝（熔炉的热往外透）
        hbox(k, 'spine_03', (X(0.5), 3.88, 0.3), (0.62, 0.1, 0.12), rot=(0, -s * 0.18, 0), row='brass', tone=0.6, bevel=0.025)  # 胸板上沿的金边
    hbox(k, 'spine_02', (0, 3.32, 0.02), (0.36, 0.82, 0.3), row='obsidian', tone=0.12, bevel=0.03)  # 炉膛的暗底
    hbox(k, 'spine_02', (0, 3.32, 0.16), (0.3, 0.72, 0.12), row='ember', tone=0.3, bevel=0.0, glow=0.4, dust=0)  # 炉壁（火色的弱光）
    for s in (1, -1):
        hbox(k, 'spine_02', (s * 0.16, 3.32, 0.26), (0.05, 0.72, 0.18), row='ember', tone=0.25, bevel=0.0, glow=0.34, dust=0)
    blob(k, 'x_core', (0, 3.32, 0.34), (0.13, 0.17, 0.09), n=14, row='ember', tone=0.98, jitter=0.01, glow=1.0)
    for i, y in enumerate((3.66, 3.44, 3.22)):
        bn = 'spine_03' if i < 2 else 'spine_02'
        for s in (1, -1):
            loft(k, bn, [(s * 0.5, y + 0.04, 0.34), (s * 0.3, y, 0.46), (s * 0.08, y - 0.05, 0.44)], [0.055, 0.05, 0.04], sides=5, row='bone', tone=0.46 + 0.04 * i, jitter=0.03)
    loft(k, 'spine_03', [(0, 3.86, 0.42), (0, 3.48, 0.46), (0, 3.1, 0.42)], [0.045, 0.05, 0.04], sides=5, row='bone', tone=0.44)  # 胸骨
    # 背甲 + 两片肩胛甲（刃翼从这里长出来）
    hull_at(k, 'spine_03', [(-0.66, 3.9, -0.3), (0.66, 3.9, -0.3), (-0.56, 3.0, -0.34), (0.56, 3.0, -0.34), (0, 3.96, -0.5), (0, 3.06, -0.5), (-0.4, 3.5, -0.52), (0.4, 3.5, -0.52)], (0, 0, 0), row='obsidian', tone=0.4)
    # ---- 肩甲：每边三层（大的圆甲 + 两片往下叠的甲片），下缘金边；挂在上臂上 ----
    for s in (1, -1):
        X = lambda x: x * s
        ua = 'upperarm_' + ('l' if s > 0 else 'r')
        cv = blob(k, ua, (X(1.04), 3.86, -0.02), (0.46, 0.3, 0.44), n=18, rot=(0, 0, -s * 0.38), row='obsidian', tone=0.64, flat=0.35)
        seam(k, cv, (s * 0.3, 1, 0.1), n=1, width=0.14, glow=0.48)
        for j in range(2):
            hull_at(k, ua, [(-0.34, 0.1, -0.36), (0.34, 0.1, -0.36), (-0.34, 0.1, 0.36), (0.34, 0.1, 0.36), (-0.3, -0.12, -0.32), (0.3, -0.12, -0.32), (-0.3, -0.12, 0.32), (0.3, -0.12, 0.32), (0.4, -0.02, 0.0)],
                    (X(1.18 + 0.1 * j), 3.6 - 0.2 * j, -0.02), (0, 0, -s * (0.75 + 0.15 * j)), row='obsidian', tone=0.5 - 0.06 * j)
        hull_at(k, ua, [(-0.3, -0.13, -0.33), (0.3, -0.13, -0.33), (-0.3, -0.13, 0.33), (0.3, -0.13, 0.33), (-0.3, -0.18, -0.31), (0.3, -0.18, -0.31), (-0.3, -0.18, 0.31), (0.3, -0.18, 0.31)],
                (X(1.28), 3.4, -0.02), (0, 0, -s * 0.9), row='brass', tone=0.6, jitter=0.02)
    # ---- 护颈 + 头盔：窄脸甲，两道发光的眼缝，盔顶一道骨脊，两只往后掠的巨角 ----
    loft(k, 'neck_01', [(0, 3.86, -0.02), (0, 4.04, 0.0), (0, 4.2, 0.02)], [0.3, 0.24, 0.22], sides=8, squash=0.9, row='obsidian', tone=0.42, soft=True)
    hull_at(k, 'neck_01', [(-0.34, 3.86, 0.2), (0.34, 3.86, 0.2), (-0.36, 3.88, -0.24), (0.36, 3.88, -0.24), (-0.26, 4.16, 0.22), (0.26, 4.16, 0.22), (-0.28, 4.18, -0.2), (0.28, 4.18, -0.2), (0, 4.12, 0.32)], (0, 0, 0), row='obsidian', tone=0.54)  # 高领
    helm = [(-0.27, 4.24, 0.24), (0.27, 4.24, 0.24), (-0.29, 4.3, -0.26), (0.29, 4.3, -0.26), (-0.27, 4.66, 0.2), (0.27, 4.66, 0.2), (-0.26, 4.7, -0.24), (0.26, 4.7, -0.24),
            (0, 4.88, -0.04), (-0.16, 4.84, 0.12), (0.16, 4.84, 0.12), (0, 4.4, 0.36), (-0.14, 4.18, 0.3), (0.14, 4.18, 0.3), (0, 4.1, 0.34)]
    hull_at(k, 'head', helm, (0, 0, 0), row='obsidian', tone=0.5)
    hull_at(k, 'head', [(-0.2, 4.18, 0.3), (0.2, 4.18, 0.3), (0, 4.04, 0.38), (-0.22, 4.5, 0.32), (0.22, 4.5, 0.32), (0, 4.62, 0.38), (0, 4.36, 0.44), (-0.18, 4.36, 0.24), (0.18, 4.36, 0.24)], (0, 0, 0), row='obsidian', tone=0.72)  # 脸甲
    for s in (1, -1):
        hbox(k, 'head', (s * 0.1, 4.44, 0.405), (0.13, 0.035, 0.04), rot=(0, 0, s * 0.2), row='ember', tone=0.75, bevel=0.0, glow=0.7)
    loft(k, 'head', [(0, 4.5, 0.36), (0, 4.84, 0.14), (0, 4.9, -0.12), (0, 4.74, -0.36)], [0.035, 0.05, 0.05, 0.03], sides=4, row='bone', tone=0.58)
    for s in (1, -1):
        X = lambda x: x * s
        loft(k, 'head', [(X(0.22), 4.6, 0.02), (X(0.5), 4.74, -0.16), (X(0.74), 4.92, -0.5), (X(0.8), 5.12, -0.9), (X(0.72), 5.26, -1.18)], [0.12, 0.11, 0.085, 0.05, 0.0], sides=8, row='bone', tone=0.66, tip=True)
        hull_at(k, 'head', [(-0.06, -0.06, -0.06), (0.06, -0.06, -0.06), (-0.06, 0.06, 0.06), (0.06, 0.06, 0.06), (0, 0.1, -0.02), (0, -0.1, 0.02)], (X(0.25), 4.6, 0.02), row='obsidian', tone=0.4)  # 角根
    for s in (1, -1):  # 护颊（往前收的两片）和眉甲
        hull_at(k, 'head', [(0.0, 0.12, 0.0), (0.0, -0.18, 0.04), (0.05, 0.1, 0.0), (0.05, -0.16, 0.04), (0.0, 0.1, 0.24), (0.0, -0.14, 0.2), (0.05, 0.08, 0.22), (0.05, -0.12, 0.18)],
                (s * 0.26, 4.34, 0.08), (0, -s * 0.35, 0), row='obsidian', tone=0.62)
    hull_at(k, 'head', [(-0.27, 0.0, 0.0), (0.27, 0.0, 0.0), (-0.24, 0.06, 0.06), (0.24, 0.06, 0.06), (0.0, 0.05, 0.14), (-0.25, -0.04, 0.05), (0.25, -0.04, 0.05)], (0, 4.52, 0.3), row='obsidian', tone=0.74)
    for i in range(6):  # 腰带上一圈小甲扣
        a = -1.0 + i * 0.4
        hull_at(k, 'pelvis', [(-0.06, -0.06, 0.0), (0.06, -0.06, 0.0), (-0.06, 0.06, 0.0), (0.06, 0.06, 0.0), (0.0, 0.0, 0.05)], (math.sin(a) * 0.56, 2.52, math.cos(a) * 0.4 - 0.02), (0, a, 0), row='brass', tone=0.66, jitter=0.02)
    # 余烬冠：头顶浮着的一圈细的暗金环 + 五个火色的尖（尖上近白一点，但只是一点）
    torus(k, 'x_crown', (0, 5.02, -0.02), 0.4, 0.028, segs=15, sides=3, row='brass', tone=0.42)
    for i in range(5):
        a = TAU * i / 5
        cx, cz = math.sin(a) * 0.4, math.cos(a) * 0.4 - 0.02
        hull_at(k, 'x_crown', [(-0.055, 0, 0), (0.055, 0, 0), (0, 0, -0.055), (0, 0, 0.055), (0, 0.3 if i == 0 else 0.24, 0), (0, -0.07, 0)], (cx, 5.02, cz), (0, a, 0), row='ember', tone=0.8, jitter=0.01, glow=0.72)
    # ---- 手臂：上臂一截甲、尖的护肘、护臂（腕口外翻，一道金箍）、铁手套；左手张开成爪，右手握剑 ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        X = lambda x: x * s
        ua, la, hd = 'upperarm_' + sd, 'lowerarm_' + sd, 'hand_' + sd
        loft(k, ua, [(X(0.98), 3.72, -0.04), (X(1.06), 3.3, -0.03), (X(1.11), 3.0, -0.02)], [0.22, 0.2, 0.18], sides=10, row='obsidian', tone=0.42)
        hull_at(k, la, [(-0.13, 0.1, 0.06), (0.13, 0.1, 0.06), (-0.12, -0.12, 0.04), (0.12, -0.12, 0.04), (0, 0.0, -0.3), (0, 0.14, -0.1), (-0.1, 0.0, -0.06), (0.1, 0.0, -0.06)], (X(1.12), 2.96, -0.06), row='obsidian', tone=0.66)
        loft(k, la, [(X(1.12), 2.9, -0.02), (X(1.15), 2.6, 0.0), (X(1.19), 2.3, 0.05), (X(1.2), 2.22, 0.06)], [0.17, 0.18, 0.2, 0.22], sides=10, row='obsidian', tone=0.5)
        loft(k, la, [(X(1.18), 2.4, 0.04), (X(1.18), 2.46, 0.035)], [0.205, 0.2], sides=8, row='brass', tone=0.58, jitter=0.02)
        hull_at(k, la, [(-0.06, 0.24, 0.0), (0.06, 0.24, 0.0), (0, 0.28, -0.04), (-0.08, -0.16, 0.14), (0.08, -0.16, 0.14), (0, -0.22, 0.2), (0, 0.06, 0.24)], (X(1.25), 2.58, 0.0), (0, 0, -s * 0.12), row='obsidian', tone=0.7)  # 护臂外侧一道棱
        hbox(k, hd, (X(1.21), 2.06, 0.08), (0.2, 0.28, 0.24), rot=(0, 0, -s * 0.05), row='obsidian', tone=0.44, bevel=0.05)
    # 右手：握拳（四指并成一块，拇指压在上面）
    hbox(k, 'hand_r', (-1.2, 1.94, 0.16), (0.22, 0.16, 0.12), rot=(0.2, 0, 0), row='obsidian', tone=0.5, bevel=0.03)
    for i in range(4):
        x = -1.28 + i * 0.055
        hbox(k, 'hand_r', (x, 1.88, 0.25), (0.05, 0.1, 0.07), rot=(0.5, 0, 0), row='obsidian', tone=0.46 + 0.03 * (i % 2), bevel=0.012)
        hbox(k, 'hand_r', (x, 1.83, 0.18), (0.048, 0.07, 0.07), rot=(1.2, 0, 0), row='obsidian', tone=0.52, bevel=0.012)
    hbox(k, 'hand_r', (-1.08, 2.0, 0.18), (0.08, 0.16, 0.1), rot=(0, 0, 0.3), row='obsidian', tone=0.58, bevel=0.02)
    # 左手：张开的爪（四根两节的指 + 拇指），指尖是骨
    for i in range(4):
        x = 1.13 + i * 0.055
        loft(k, 'hand_l', [(x, 1.96, 0.1 + i * 0.01), (x + 0.02, 1.78, 0.17), (x + 0.03, 1.62, 0.2)], [0.035, 0.03, 0.0], sides=4, row='obsidian', tone=0.5, tip=True)
    loft(k, 'hand_l', [(1.12, 2.02, 0.16), (1.06, 1.9, 0.27), (1.05, 1.8, 0.3)], [0.038, 0.032, 0.0], sides=4, row='obsidian', tone=0.5, tip=True)
    # ---- 巨剑：骨质护手（往前弯的两翼），裹深红布的长柄，骨的剑首；黑曜石宽刃（菱形截面），两面一道细的火色血槽 ----
    o = Vector(PIV['x_sword'])
    d = (Vector(SWORD_TIP) - o).normalized()
    hint = (0.96, 0.0, 0.28)
    # 刃（v 沿剑身，u 是刃宽的方向，w 是刃的厚度）
    hull_frame(k, 'x_sword', [(0.17, 0.3, 0), (-0.17, 0.3, 0), (0, 0.3, 0.045), (0, 0.3, -0.045), (0.19, 1.2, 0), (-0.19, 1.2, 0), (0, 1.2, 0.05), (0, 1.2, -0.05),
                              (0.15, 2.25, 0), (-0.15, 2.25, 0), (0, 2.25, 0.04), (0, 2.25, -0.04), (0, SWORD_LEN, 0)], o, d, hint, row='obsidian', tone=0.4, jitter=0.03)
    for wsg in (1, -1):  # 血槽：刃的两面各一道细条（自发光，火色，不到近白）
        hull_frame(k, 'x_sword', [(0.025, 0.42, wsg * 0.046), (-0.025, 0.42, wsg * 0.046), (0.025, 1.9, wsg * 0.042), (-0.025, 1.9, wsg * 0.042), (0, 2.02, wsg * 0.04),
                                  (0.02, 0.42, wsg * 0.03), (-0.02, 0.42, wsg * 0.03), (0.02, 1.9, wsg * 0.03), (-0.02, 1.9, wsg * 0.03)], o, d, hint, row='ember', tone=0.75, jitter=0.0, glow=0.66)
    hull_frame(k, 'x_sword', [(-0.42, 0.24, 0), (0.42, 0.24, 0), (-0.46, 0.34, 0.0), (0.46, 0.34, 0.0), (-0.2, 0.12, 0.07), (0.2, 0.12, 0.07), (-0.2, 0.12, -0.07), (0.2, 0.12, -0.07),
                               (-0.18, 0.26, 0.08), (0.18, 0.26, 0.08), (-0.18, 0.26, -0.08), (0.18, 0.26, -0.08)], o, d, hint, row='bone', tone=0.64, jitter=0.03)  # 护手
    u, v, w = _frame(d, hint)
    g0, g1 = o + v * 0.12, o - v * 0.42
    loft(k, 'x_sword', [tuple(g1), tuple(g0)], [0.055, 0.06], sides=6, row='crimson', tone=0.3, jitter=0.03)
    blob(k, 'x_sword', tuple(o - v * 0.5), (0.1, 0.1, 0.1), n=10, row='bone', tone=0.6)
    # ---- 刃翼：翼骨（两节，骨色）+ 每扇四片叠着的刃羽（黑曜石，内层一片深红），收拢时贴在背后往下垂 ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        X = lambda x: x * s
        w1, w2 = 'x_wing_%s_01' % sd, 'x_wing_%s_02' % sd
        A = [(X(a[0]), a[1], a[2]) for a in WING_ARM]
        # 翼骨是黑曜石（只有翼肘一块骨）：正面看不再是一圈白骨刺，巨角才是领头的形状
        loft(k, w1, A[0:3], [0.11, 0.1, 0.085], sides=8, row='obsidian', tone=0.5)
        loft(k, w2, A[2:5], [0.085, 0.065, 0.0], sides=8, row='obsidian', tone=0.54, tip=True)
        blob(k, w2, (A[2][0], A[2][1] + 0.02, A[2][2]), (0.13, 0.12, 0.13), n=10, row='bone', tone=0.5)
        # 刃羽：根部沿翼骨排开，往下、往外、往后垂；宽面在翼面里（刃宽顺着翼骨），一片压着一片；从里到外越来越长。外层黑曜石，内层（朝前）一片深红
        arm = [Vector(a) for a in A]
        feathers = [(w1 if t < 2 else w2, t, ln, out) for t, ln, out in WING_FEATHERS]
        for j, (bn, t, ln, out) in enumerate(feathers):
            i0 = min(3, int(t))
            r0 = arm[i0].lerp(arm[i0 + 1], t - i0)
            tang = (arm[i0 + 1] - arm[i0]).normalized()
            dd = Vector((s * out, WING_DD[0], WING_DD[1])).normalized()
            fw = 0.27 + 0.03 * j
            th = 0.04
            hull_frame(k, bn, [(-fw * 0.7, 0, th), (fw * 0.7, 0, th), (-fw * 0.7, 0, -th), (fw * 0.7, 0, -th), (-fw, ln * 0.4, th * 0.8), (fw * 0.9, ln * 0.48, th * 0.8),
                               (-fw, ln * 0.4, -th * 0.8), (fw * 0.9, ln * 0.48, -th * 0.8), (s * fw * 0.15, ln, 0), (-fw * 0.55, ln * 0.82, 0), (fw * 0.45, ln * 0.85, 0)],
                       tuple(r0), tuple(dd), tuple(tang), row='obsidian', tone=0.3 + 0.06 * (j % 2), jitter=0.04)
            u_, v_, w_ = _frame(dd, tuple(tang))
            fside = 1 if w_.z > 0 else -1  # 朝前的那一面贴深红内层
            hull_frame(k, bn, [(-fw * 0.62, 0.08, fside * (th + 0.012)), (fw * 0.62, 0.08, fside * (th + 0.012)), (-fw * 0.85, ln * 0.42, fside * (th + 0.01)), (fw * 0.78, ln * 0.48, fside * (th + 0.01)),
                               (s * fw * 0.1, ln * 0.9, fside * 0.012), (-fw * 0.6, 0.08, fside * 0.02), (fw * 0.6, 0.08, fside * 0.02), (0, ln * 0.8, fside * 0.01)],
                       tuple(r0), tuple(dd), tuple(tang), row='crimson', tone=0.46, jitter=0.04)
            if j >= 2:  # 外侧两片的刃口一道暗的余烬（俯视、张翼时看得见的火线）
                hull_frame(k, bn, [(fw * 0.88, ln * 0.2, 0.0), (fw * 0.93, ln * 0.48, 0.0), (s * fw * 0.17, ln * 0.97, 0.0), (fw * 0.84, ln * 0.2, 0.028), (fw * 0.89, ln * 0.48, 0.022), (fw * 0.84, ln * 0.2, -0.028), (fw * 0.89, ln * 0.48, -0.022)],
                           tuple(r0), tuple(dd), tuple(tang), row='ember', tone=0.6, jitter=0.0, glow=0.42)
    # ---- 细节（俯视镜头也看得见的转折）：背上一道脊甲、肩甲顶上一道金脊和一片往后掠的鳍甲、角根一圈金箍、上臂两片叠甲、大腿正面的护甲、腹部三道甲片 ----
    for j in range(4):
        hull_at(k, 'spine_03' if j < 2 else 'spine_02', [(-0.1, -0.12, 0.0), (0.1, -0.12, 0.0), (-0.07, 0.12, 0.0), (0.07, 0.12, 0.0), (0, 0.0, -0.16), (0, 0.14, -0.1), (0, -0.14, -0.08)],
                (0, 3.82 - j * 0.24, -0.5 + j * 0.01), (0.25, 0, 0), row='obsidian', tone=0.7 - 0.04 * j)
    for s in (1, -1):
        X = lambda x: x * s
        sd = 'l' if s > 0 else 'r'
        ua, th = 'upperarm_' + sd, 'thigh_' + sd
        hull_at(k, ua, [(-0.04, 0, -0.42), (0.04, 0, -0.42), (-0.04, 0, 0.36), (0.04, 0, 0.36), (0, 0.07, -0.3), (0, 0.07, 0.26), (-0.05, -0.06, 0.0), (0.05, -0.06, 0.0)],
                (X(1.08), 4.15, -0.04), (0, 0, -s * 0.42), row='brass', tone=0.62, jitter=0.02)  # 肩甲顶上的金脊
        hull_at(k, ua, [(-0.05, 0.0, 0.0), (0.05, 0.0, 0.0), (-0.04, 0.0, -0.62), (0.04, 0.04, -0.62), (0.0, 0.3, -0.5), (0.0, 0.16, -0.14), (-0.04, -0.06, -0.3), (0.04, -0.06, -0.3)],
                (X(1.12), 4.08, -0.2), (0.25, 0, -s * 0.5), row='obsidian', tone=0.76)  # 往后上方掠的鳍甲
        for j in range(2):
            hull_at(k, ua, [(-0.25, 0.08, -0.25), (0.25, 0.08, -0.25), (-0.25, 0.08, 0.25), (0.25, 0.08, 0.25), (-0.23, -0.08, -0.23), (0.23, -0.08, -0.23), (-0.23, -0.08, 0.23), (0.23, -0.08, 0.23)],
                    (X(1.05 + 0.03 * j), 3.42 - 0.2 * j, -0.03), (0, 0, -s * 0.1), row='obsidian', tone=0.58 - 0.05 * j, jitter=0.03)
        hull_at(k, th, [(-0.2, 0.3, 0.2), (0.2, 0.3, 0.2), (-0.18, -0.36, 0.2), (0.18, -0.36, 0.2), (0, 0.32, 0.34), (0, -0.3, 0.32), (-0.22, 0.0, 0.1), (0.22, 0.0, 0.1)],
                (X(0.39), 1.72, 0.06), row='obsidian', tone=0.62)  # 大腿正面的护甲
        torus(k, 'head', (X(0.27), 4.62, 0.01), 0.12, 0.03, segs=8, sides=3, row='brass', tone=0.58, rot=(0, 0, s * 1.2))  # 角根的金箍
    for i in range(3):
        hbox(k, 'spine_01', (0, 2.62 + 0.1 * i, -0.36 + 0.01 * i), (0.82, 0.12, 0.2), rot=(0.12, 0, 0), row='obsidian', tone=0.5, bevel=0.03)
    # ---- 披风：从两翼中间的背上垂到小腿，下摆参差；三节软接缝 ----
    ys = [3.7, 3.4, 3.05, 2.7, 2.3, 1.9, 1.5, 1.1, 0.8, 0.62]
    cols = 9
    rows = []
    for i, y in enumerate(ys):
        f = (3.7 - y) / 3.1
        hw = 0.5 + 0.55 * f
        z0 = -0.5 - 0.3 * f - 0.45 * f * f  # 下摆往后飘开一点（俯视也看得见披风）
        row = []
        for j in range(cols):
            x = (j / (cols - 1)) * 2 - 1
            yy = y + (k.r(-0.12, 0.12) if i == len(ys) - 1 else 0) + (0.1 * abs(x) if i == len(ys) - 1 else 0)
            row.append((x * hw, yy, z0 + 0.22 * (1 - x * x) * (0.4 + f) - 0.0 * x))
        rows.append(row)

    def cape_bone(p, i, j):
        y = p[1]
        return ('x_cape_01' if y > 2.56 else 'x_cape_02' if y > 1.46 else 'x_cape_03', True)
    cv = sheet(k, rows, row='crimson', tone=0.64, thick=0.05, bind=cape_bone)
    # 披风的领口压在背甲上：一道金边
    loft(k, 'spine_03', [(-0.5, 3.74, -0.5), (0, 3.78, -0.6), (0.5, 3.74, -0.5)], [0.05, 0.055, 0.05], sides=4, row='brass', tone=0.55, jitter=0.02)

    soft = [
        # (子骨骼, 父骨骼, 枢轴, 轴（父 → 子）, 带宽)
        ('spine_01', 'pelvis', (0, 2.58, -0.02), (0, 1, 0), 0.24),
        ('spine_02', 'spine_01', (0, 2.98, -0.04), (0, 1, 0), 0.22),
        ('neck_01', 'spine_03', (0, 3.96, 0.0), (0, 1, 0), 0.2),
        ('x_cape_01', 'spine_03', (0, 3.62, -0.5), (0, -1, 0), 0.3),
        ('x_cape_02', 'x_cape_01', (0, 2.56, -0.64), (0, -1, 0), 0.5),
        ('x_cape_03', 'x_cape_02', (0, 1.46, -0.76), (0, -1, 0), 0.5),
    ]
    from .lord_clips import CLIPS
    return dict(skel=SKEL, soft=soft, clips=CLIPS, height=5.26)
