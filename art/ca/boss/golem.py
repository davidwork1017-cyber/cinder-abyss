# 熔渣巨像（第 0 区首领）：头重脚轻的熔炉构造体。比胯宽的玄武岩肩轭，头缩在两肩之间的凹口里，背后两截矮烟囱；
# 胸口四根铁栅挡着熔炉，里面一小团近白的炉芯；右小臂末端一整块箍铁带的锤石，左手三根粗石指；腿是短粗的石墩。
# 俯视是一个宽「T」字，锤石偏在一侧。材质：冷的玄武岩（熔渣行，暗）做大块，朝上的面和棱是风化的灰白石，铁带 / 炉栅是锈铁，
# 余烬只在窄缝里。和暖褐的地面拉开冷暖。尺寸、身高、招式时序见 design-note §2 / §4；坐标一律写游戏坐标（x 左、y 上、z 前），
# 进 Kit 时经 rig.g2b 换成 Blender 坐标。
import math

from mathutils import Euler, Vector

from .. import rig
from ..rig import g2b

TAU = 2 * math.pi

# 骨架（28 根）：枢轴是游戏坐标。左 = +x（巨像自己的左边），面朝 +z
BONES = [
    ('pelvis', None, (0, 1.75, 0)),
    ('spine_01', 'pelvis', (0, 2.05, -0.02)),
    ('spine_02', 'spine_01', (0, 2.5, -0.05)),
    ('spine_03', 'spine_02', (0, 3.15, -0.08)),
    ('neck_01', 'spine_03', (0, 3.6, 0.22)),
    ('head', 'neck_01', (0, 3.8, 0.34)),
    ('clavicle_l', 'spine_03', (0.6, 3.75, -0.05)),
    ('upperarm_l', 'clavicle_l', (1.72, 3.55, 0.0)),
    ('lowerarm_l', 'upperarm_l', (2.0, 2.45, 0.12)),
    ('hand_l', 'lowerarm_l', (2.1, 1.45, 0.3)),
    ('x_finger_l_01', 'hand_l', (1.86, 1.08, 0.5)),
    ('x_finger_l_02', 'hand_l', (2.12, 1.04, 0.56)),
    ('x_finger_l_03', 'hand_l', (2.38, 1.08, 0.48)),
    ('clavicle_r', 'spine_03', (-0.6, 3.75, -0.05)),
    ('upperarm_r', 'clavicle_r', (-1.72, 3.55, 0.0)),
    ('lowerarm_r', 'upperarm_r', (-2.0, 2.45, 0.12)),
    ('hand_r', 'lowerarm_r', (-2.1, 1.72, 0.25)),
    ('x_hammer', 'hand_r', (-2.14, 1.5, 0.3)),
    ('x_core', 'spine_02', (0, 2.78, 0.32)),
    ('x_grate', 'spine_02', (0, 3.32, 0.78)),
    ('x_chimney_l', 'spine_03', (0.62, 4.12, -0.62)),
    ('x_chimney_r', 'spine_03', (-0.62, 4.12, -0.62)),
    ('thigh_l', 'pelvis', (0.7, 1.62, 0.0)),
    ('calf_l', 'thigh_l', (0.78, 0.95, 0.06)),
    ('foot_l', 'calf_l', (0.8, 0.3, 0.06)),
    ('thigh_r', 'pelvis', (-0.7, 1.62, 0.0)),
    ('calf_r', 'thigh_r', (-0.78, 0.95, 0.06)),
    ('foot_r', 'calf_r', (-0.8, 0.3, 0.06)),
]
SKEL = rig.Skel(BONES)
B = SKEL.index


# ---------------------------------------------------------------- 搭形工具（游戏坐标）
# 玄武岩的色带位置整体往亮的一头挪（灰度检查：受光面 p85 要到 55–75%、比地面亮 15 点以上；顶点色最多到 1，亮度只能靠色带位置给）
BASALT_LIFT = 0.27


def _tone(row, tone):
    return min(0.92, tone + BASALT_LIFT) if row == 'basalt' else tone

def _rot(r):
    return Euler((r[0], r[1], r[2]), 'ZYX').to_matrix()  # 游戏的 XYZ 欧拉：R = Rx · Ry · Rz


def _pts(k, local, c, rot=(0, 0, 0)):
    R = _rot(rot)
    out = []
    for p in local:
        q = R @ Vector(p)
        out.append(g2b((c[0] + q.x, c[1] + q.y, c[2] + q.z)))
    return out


def hbox(k, bone, c, s, rot=(0, 0, 0), row='basalt', tone=0.5, jitter=0.08, bevel=0.06, taper=(1.0, 1.0), glow=0, dust=1, jit=0.0):
    """倒一刀的盒子（凸包），c = 中心，s = 三边长，taper = 顶面（+y）在 x / z 上的收缩比例，jit = 角点随机抖动（石头不那么方正）"""
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
    vs = k.hull(_pts(k, loc, c, rot), row, _tone(row, tone), jitter, glow, dust)
    return k.bind(vs, B[bone])


def blob(k, bone, c, r, n=14, rot=(0, 0, 0), row='basalt', tone=0.5, jitter=0.1, flat=0.0, glow=0, dust=1):
    """不规则的石块（椭球面上的随机点取凸包），flat > 0 时底面压平"""
    loc = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        u = (i + 0.5) / n
        y = 1 - 2 * u
        rr = math.sqrt(max(0.0, 1 - y * y))
        a = ga * i + k.r(-0.3, 0.3)
        sc = 1 + k.r(-0.12, 0.12)
        yy = max(y, -1 + flat * 2) if flat else y
        loc.append((math.cos(a) * rr * r[0] * sc, yy * r[1] * sc, math.sin(a) * rr * r[2] * sc))
    vs = k.hull(_pts(k, loc, c, rot), row, _tone(row, tone), jitter, glow, dust)
    return k.bind(vs, B[bone])


def loft(k, bone, pts, radii, sides=7, squash=1.0, row='basalt', tone=0.5, jitter=0.08, cap0=True, cap1=True, twist=0.0, soft=False):
    """沿折线的渐变截面管（椭圆截面：squash < 1 压扁），pts 是游戏坐标；soft = 软接缝（和相邻骨骼按距离渐变）"""
    vs, _ = k.tube([g2b(p) for p in pts], radii, sides=sides, row=row, tone=_tone(row, tone), jitter=jitter, tip=False, cap0=cap0, cap1=cap1, squash=squash, twist=twist)
    return k.bind(vs, B[bone], soft)


def seam(k, vs, axis, n=1, width=0.28, depth=0.03, glow=0.6, pick=None):
    """在这块零件朝 axis（游戏坐标）的面里挑 n 个面切出余烬窄缝"""
    a = Vector(g2b(axis)).normalized()
    fs = []
    for v in vs:
        if not v.is_valid:
            continue
        for f in v.link_faces:
            if f not in fs and f.is_valid:
                fs.append(f)
    fs = [f for f in fs if f.normal.dot(a) > 0.6 and f.calc_area() > 0.01]
    fs.sort(key=lambda f: -f.calc_area())
    out = []
    for f in fs[:n] if pick is None else [fs[i] for i in pick if i < len(fs)]:
        out.append(k.slit(f, width=width, depth=depth, row='ember', glow=glow))
    return out


def hexcol(k, bone, base, h, r, rot=(0, 0, 0), sides=6, chamfer=0.07, row='basalt', tone=0.4, top_row=None, top_tone=0.3, jitter=0.06, tilt=0.06, phase=None, glow=0, dust=1, soft=False, taper=0.94):
    """玄武岩柱段：sides 棱柱，顶上倒一圈棱（倒角那一圈和顶面可以换成风化的灰白），底面平；base = 底面中心，柱轴沿 rot 转过的 +y"""
    ph = k.r(0, TAU) if phase is None else phase
    rr = [r * (1 + k.r(-0.06, 0.06)) for _ in range(sides)]
    ring = lambda y, sc: [(math.cos(ph + TAU * i / sides) * rr[i] * sc, y, math.sin(ph + TAU * i / sides) * rr[i] * sc) for i in range(sides)]
    tx, tz = k.r(-tilt, tilt), k.r(-tilt, tilt)
    top = [(x + tx * h * 0.3, y, z + tz * h * 0.3) for x, y, z in ring(h, taper)]
    cham = [(x + tx * h * 0.3, y, z + tz * h * 0.3) for x, y, z in ring(h - chamfer, taper * 1.0 + 0.0)]
    topi = [(x * (1 - chamfer / max(r, 0.05)), y, z * (1 - chamfer / max(r, 0.05))) for x, y, z in top]
    loc = ring(0, 1.0) + cham + topi
    vs = k.hull(_pts(k, loc, base, rot), row, _tone(row, tone), jitter, glow, dust)
    if top_row:
        up = Vector(g2b(tuple(_rot(rot) @ Vector((0, 1, 0)))))
        fs = []
        for v in vs:
            for f in v.link_faces:
                if f not in fs and f.normal.dot(up) > 0.55:
                    fs.append(f)
        k.tag(fs, top_row, top_tone, 0.06, dust=dust)
    return k.bind(vs, B[bone], soft)


def _mirror(p):
    return (-p[0], p[1], p[2])


# ---------------------------------------------------------------- 造型
def build(k):
    """搭形，返回 dict(skel, soft, clips, height)"""
    # ---- 腿：两截玄武岩柱段（大腿、小腿，小腿粗一点、箍一道铁），膝前一块圆石，脚是宽扁的石板加三块趾石 ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        X = lambda x: x * s
        th, ca, ft = 'thigh_' + sd, 'calf_' + sd, 'foot_' + sd
        hexcol(k, th, (X(0.74), 0.98, 0.04), 0.78, 0.4, row='basalt', tone=0.36, chamfer=0.05)
        hexcol(k, th, (X(0.72), 1.55, 0.0), 0.3, 0.46, rot=(math.pi, 0, 0), row='basalt', tone=0.3, chamfer=0.04)
        hexcol(k, ca, (X(0.8), 0.28, 0.06), 0.7, 0.48, row='basalt', tone=0.3, top_row='stone', top_tone=0.28, chamfer=0.06)
        loft(k, ca, [(X(0.8), 0.62, 0.06), (X(0.8), 0.74, 0.06)], [0.55, 0.55], sides=7, row='iron', tone=0.36, jitter=0.03)
        blob(k, ca, (X(0.8), 0.98, 0.34), (0.32, 0.3, 0.24), n=12, row='stone', tone=0.32, jitter=0.06)
        hbox(k, ft, (X(0.8), 0.13, 0.16), (1.0, 0.26, 1.3), row='basalt', tone=0.26, bevel=0.06, taper=(0.88, 0.84), jit=0.04)
        for t in (-1, 0, 1):
            blob(k, ft, (X(0.8 + t * 0.3), 0.12, 0.84), (0.16, 0.12, 0.17), n=10, row='basalt', tone=0.36, flat=0.3)
        blob(k, ft, (X(0.8), 0.3, -0.3), (0.32, 0.16, 0.24), n=10, row='basalt', tone=0.4, flat=0.3)
    # ---- 胯：一整块暗色基座 + 两侧的胯石，前后两片垂板，腰间一道余烬缝 ----
    hip = hbox(k, 'pelvis', (0, 1.74, 0), (1.9, 0.7, 1.24), row='basalt', tone=0.26, bevel=0.1, taper=(1.05, 1.0), jit=0.04)
    seam(k, hip, (0, 0, 1), n=1, width=0.18, glow=0.55)
    hbox(k, 'pelvis', (0, 1.5, 0.64), (0.8, 0.72, 0.28), rot=(-0.14, 0, 0), row='stone', tone=0.24, bevel=0.06, jit=0.03)
    hbox(k, 'pelvis', (0, 1.52, -0.62), (0.92, 0.7, 0.28), rot=(0.12, 0, 0), row='basalt', tone=0.4, bevel=0.06, jit=0.03)
    for s in (1, -1):
        blob(k, 'pelvis', (s * 0.98, 1.66, 0.02), (0.3, 0.42, 0.5), n=14, row='basalt', tone=0.42)
    # 腰：暗的熔渣芯（软接缝：胯和下腹之间弯折时不开口）
    loft(k, 'spine_01', [(0, 1.95, -0.02), (0, 2.2, -0.03), (0, 2.42, -0.05)], [0.78, 0.72, 0.8], sides=8, squash=0.72, row='slag', tone=0.16, soft=True)
    hbox(k, 'spine_01', (0, 2.18, 0.5), (1.1, 0.4, 0.32), rot=(-0.08, 0, 0), row='basalt', tone=0.4, bevel=0.06, jit=0.03)
    hbox(k, 'spine_01', (0, 2.2, -0.5), (1.2, 0.44, 0.32), rot=(0.08, 0, 0), row='basalt', tone=0.34, bevel=0.06, jit=0.03)
    # ---- 胸：左右两大块胸板夹着炉口；炉膛往里收（暗红的炉壁，火色范围的弱光），炉芯是一小团近白的光，四根铁栅挡在最外面 ----
    for s in (1, -1):
        hbox(k, 'spine_02', (s * 0.8, 2.82, 0.06), (0.9, 1.34, 1.4), rot=(0, 0, -s * 0.08), row='basalt', tone=0.36, bevel=0.1, taper=(1.08, 1.0), jit=0.05)
        blob(k, 'spine_02', (s * 0.92, 3.22, 0.74), (0.3, 0.24, 0.14), n=10, row='stone', tone=0.3)
        blob(k, 'spine_02', (s * 0.9, 2.46, 0.76), (0.26, 0.24, 0.12), n=10, row='basalt', tone=0.46)
    hbox(k, 'spine_02', (0, 2.8, -0.55), (1.5, 1.4, 0.5), row='slag', tone=0.28, bevel=0.08, jit=0.03)
    hbox(k, 'spine_02', (0, 2.78, 0.16), (0.82, 1.04, 0.24), row='ember', tone=0.25, jitter=0.05, bevel=0.0, glow=0.38, dust=0)
    for s in (1, -1):
        hbox(k, 'spine_02', (s * 0.4, 2.78, 0.42), (0.08, 1.04, 0.5), row='ember', tone=0.2, jitter=0.04, bevel=0.0, glow=0.32, dust=0)
    hbox(k, 'spine_02', (0, 3.36, 0.56), (0.98, 0.16, 0.5), row='iron', tone=0.34, bevel=0.03)
    hbox(k, 'spine_02', (0, 2.2, 0.56), (0.98, 0.16, 0.5), row='iron', tone=0.34, bevel=0.03)
    blob(k, 'x_core', (0, 2.78, 0.48), (0.22, 0.24, 0.2), n=16, row='ember', tone=0.98, jitter=0.01, glow=1.0, dust=0)
    for i in range(4):
        x = (i - 1.5) * 0.22
        hbox(k, 'x_grate', (x, 2.78, 0.8), (0.12, 1.12, 0.14), row='iron', tone=0.44, bevel=0.03, jitter=0.04)
    hbox(k, 'x_grate', (0, 3.3, 0.82), (0.96, 0.12, 0.16), row='iron', tone=0.5, bevel=0.03)
    # ---- 肩轭：两簇竖着的玄武岩柱，外侧高、靠脖子的低（头缩在中间的凹口里），柱顶是风化的灰白六边形；比胯宽（4.2 m） ----
    cols = [  # (x, z, 底, 高, 半径, 骨骼)：靠脖子的一根矮，肩头三根高、粗，俯视是两大块六边形拼起来的肩
        (0.62, -0.2, 3.3, 0.66, 0.36, 'spine_03'), (0.88, 0.38, 3.3, 0.62, 0.3, 'spine_03'),
        (1.12, -0.42, 3.34, 0.94, 0.42, 'clavicle'), (1.5, 0.22, 3.38, 0.98, 0.44, 'clavicle'), (1.92, -0.28, 3.46, 0.78, 0.4, 'clavicle'),
    ]
    for s in (1, -1):
        for (x, z, y0, h, r, bn) in cols:
            bone = bn if bn == 'spine_03' else 'clavicle_' + ('l' if s > 0 else 'r')
            hexcol(k, bone, (s * x, y0, z), h, r, rot=(k.r(-0.05, 0.05), 0, -s * 0.05), row='basalt', tone=0.3 + k.r(0, 0.12), top_row='stone', top_tone=0.3 + k.r(0, 0.14), chamfer=0.07)
        # 柱簇底下垫一整块，把柱子连成一副肩轭（俯视是一整条，不散成一堆）
        hbox(k, 'spine_03', (s * 0.9, 3.42, -0.1), (1.0, 0.36, 1.4), rot=(0, 0, -s * 0.06), row='basalt', tone=0.22, bevel=0.08, jit=0.03)
        hbox(k, 'clavicle_' + ('l' if s > 0 else 'r'), (s * 1.66, 3.5, -0.05), (0.9, 0.4, 1.3), rot=(0, 0, -s * 0.14), row='basalt', tone=0.22, bevel=0.08, jit=0.03)
    hbox(k, 'spine_03', (0, 3.5, -0.42), (1.2, 0.66, 0.66), row='basalt', tone=0.3, bevel=0.08, jit=0.03)
    hbox(k, 'spine_03', (0, 3.34, 0.48), (0.86, 0.32, 0.38), rot=(-0.2, 0, 0), row='basalt', tone=0.42, bevel=0.06, jit=0.03)
    for i, (y, w) in enumerate(((3.5, 1.15), (3.02, 1.0), (2.55, 0.85))):
        hbox(k, 'spine_03' if i == 0 else 'spine_02', (0, y, -0.9 + i * 0.05), (w, 0.48, 0.28), rot=(0.18 - i * 0.1, 0, 0), row='basalt', tone=0.4, bevel=0.06, jit=0.04)
    # 烟囱：肩轭后面两截矮的空心柱（铁箍），口上一圈余烬
    for s in (1, -1):
        cb = 'x_chimney_' + ('l' if s > 0 else 'r')
        hexcol(k, cb, (s * 0.62, 3.86, -0.64), 0.98, 0.28, row='basalt', tone=0.26, chamfer=0.04, top_row='ember', top_tone=0.55, tilt=0.02, glow=0)
        loft(k, cb, [(s * 0.63, 4.36, -0.65), (s * 0.63, 4.48, -0.65)], [0.33, 0.33], sides=6, row='iron', tone=0.4, jitter=0.03)
        hbox(k, cb, (s * 0.64, 4.85, -0.66), (0.3, 0.05, 0.3), row='ember', tone=0.6, bevel=0.0, glow=0.55, dust=0)
    # ---- 头：一块带面甲的石板，缩在肩轭中间的凹口里；一道发光的眼缝 ----
    hbox(k, 'head', (0, 3.98, 0.36), (0.74, 0.64, 0.7), row='basalt', tone=0.42, bevel=0.07, taper=(0.9, 0.9), jit=0.03)
    hbox(k, 'head', (0, 4.28, 0.3), (0.86, 0.18, 0.6), rot=(-0.1, 0, 0), row='stone', tone=0.26, bevel=0.05, jit=0.03)
    hbox(k, 'head', (0, 3.72, 0.64), (0.5, 0.26, 0.2), rot=(0.2, 0, 0), row='basalt', tone=0.34, bevel=0.04)
    hbox(k, 'head', (0, 4.02, 0.72), (0.46, 0.09, 0.06), row='ember', tone=0.7, bevel=0.0, glow=0.6, dust=0)
    # ---- 左臂：两截柱段的上臂、圆石肘、粗的前臂（一道铁箍）、三指巨手（每根指头两截） ----
    # ---- 右臂：同样的上臂和前臂，末端是一整块箍两道铁带的八棱锤石，锤面（朝下）上两道余烬缝 ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        X = lambda x: x * s
        ua, la = 'upperarm_' + sd, 'lowerarm_' + sd
        hexcol(k, ua, (X(1.86), 2.96, 0.06), 0.62, 0.38, rot=(0, 0, -s * 0.24), row='basalt', tone=0.34, chamfer=0.05)
        hexcol(k, ua, (X(1.78), 3.62, 0.0), 0.6, 0.42, rot=(math.pi, 0, s * 0.2), row='basalt', tone=0.28, chamfer=0.05)
        blob(k, la, (X(2.02), 2.44, 0.13), (0.38, 0.34, 0.38), n=14, row='stone', tone=0.3)
        hexcol(k, la, (X(2.08), 1.62 if s > 0 else 1.8, 0.24), 0.78 if s > 0 else 0.6, 0.46, rot=(-0.12, 0, s * 0.06), row='basalt', tone=0.3, top_row='stone', top_tone=0.2, chamfer=0.05)
        loft(k, la, [(X(2.07), 2.0, 0.2), (X(2.07), 2.12, 0.19)], [0.52, 0.52], sides=7, row='iron', tone=0.38, jitter=0.03)
    hbox(k, 'hand_l', (2.12, 1.3, 0.34), (0.74, 0.46, 0.6), rot=(0.25, 0, 0.05), row='basalt', tone=0.34, bevel=0.07, jit=0.04)
    for i, fb in enumerate(('x_finger_l_01', 'x_finger_l_02', 'x_finger_l_03')):
        px, py, pz = BONES[B[fb]][2]
        hexcol(k, fb, (px, py - 0.34, pz + 0.08), 0.42, 0.15, rot=(0.15, 0, 0), sides=5, row='basalt', tone=0.28 + 0.05 * i, chamfer=0.03)
        hexcol(k, fb, (px + (i - 1) * 0.03, py - 0.66, pz + 0.16), 0.34, 0.13, rot=(0.35, 0, 0), sides=5, row='basalt', tone=0.32, top_row='stone', top_tone=0.24, chamfer=0.03)
    hbox(k, 'hand_r', (-2.12, 1.74, 0.26), (0.6, 0.22, 0.6), row='iron', tone=0.42, bevel=0.03)
    # 锤石：一整块粗凿的方石（凸包，角上崩掉一点），两道铁带横着箍住，朝下的锤面开两道余烬缝；顶上一块风化的石头接着手腕
    hm = hbox(k, 'x_hammer', (-2.18, 0.98, 0.32), (1.36, 1.2, 1.24), rot=(0.05, 0.18, 0.04), row='basalt', tone=0.2, bevel=0.16, jit=0.07, taper=(0.86, 0.9))
    for y in (1.32, 0.66):
        hbox(k, 'x_hammer', (-2.18, y, 0.32), (1.44, 0.15, 1.32), rot=(0.05, 0.18, 0.04), row='iron', tone=0.4, bevel=0.03, jit=0.01)
    for sx in (-1, 1):
        blob(k, 'x_hammer', (-2.18 + sx * 0.6, 0.98, 0.32 + sx * 0.12), (0.16, 0.42, 0.42), n=10, row='basalt', tone=0.42)
    seam(k, hm, (0, -1, 0), n=2, width=0.22, glow=0.62)
    blob(k, 'x_hammer', (-2.16, 1.6, 0.32), (0.36, 0.18, 0.34), n=12, row='stone', tone=0.28, flat=0.2)

    # ---- 细节：腰带石、胸板上的小石板、背脊、四肢上崩出来的小块（大面不平、俯视有转折） ----
    for i in range(7):
        a = -1.2 + i * 0.4
        blob(k, 'pelvis', (math.sin(a) * 1.0, 2.08, math.cos(a) * 0.66), (0.2, 0.12, 0.16), n=9, row='basalt', tone=0.45 + k.r(0, 0.1), flat=0.3)
    for s in (1, -1):
        for j, (y, z) in enumerate(((3.05, 0.7), (2.7, 0.74), (2.36, 0.7))):
            hbox(k, 'spine_02', (s * (0.66 + 0.06 * j), y, z), (0.36, 0.28, 0.14), rot=(0.08, s * 0.1, -s * 0.06), row='basalt', tone=0.48 + 0.04 * j, bevel=0.03, jit=0.03)
        hbox(k, 'spine_02', (s * 1.22, 2.84, 0.0), (0.16, 1.0, 0.9), rot=(0, 0, -s * 0.08), row='basalt', tone=0.44, bevel=0.04, jit=0.04)
        blob(k, 'thigh_' + ('l' if s > 0 else 'r'), (s * 1.06, 1.36, 0.02), (0.14, 0.34, 0.36), n=10, row='basalt', tone=0.46)
        blob(k, 'calf_' + ('l' if s > 0 else 'r'), (s * 1.12, 0.6, 0.04), (0.12, 0.26, 0.3), n=10, row='basalt', tone=0.4)
        blob(k, 'upperarm_' + ('l' if s > 0 else 'r'), (s * 2.22, 3.05, 0.06), (0.14, 0.3, 0.3), n=10, row='basalt', tone=0.44)
        blob(k, 'lowerarm_' + ('l' if s > 0 else 'r'), (s * 2.42, 2.0, 0.22), (0.12, 0.28, 0.3), n=10, row='basalt', tone=0.38)
    for j in range(4):
        hbox(k, 'spine_03' if j < 2 else 'spine_02', (0, 3.75 - j * 0.42, -1.04 + j * 0.03), (0.3, 0.3, 0.26), rot=(0.2, 0, 0), row='basalt', tone=0.46, bevel=0.04, jit=0.03)
    for s in (1, -1):
        hbox(k, 'x_chimney_' + ('l' if s > 0 else 'r'), (s * 0.62, 3.9, -0.66), (0.78, 0.22, 0.78), row='basalt', tone=0.34, bevel=0.05, jit=0.03)

    soft = [
        # (子骨骼, 父骨骼, 枢轴, 轴（父 → 子）, 带宽)
        ('spine_01', 'pelvis', (0, 2.02, -0.02), (0, 1, 0), 0.3),
        ('spine_02', 'spine_01', (0, 2.42, -0.05), (0, 1, 0), 0.24),
    ]
    from .golem_clips import CLIPS
    return dict(skel=SKEL, soft=soft, clips=CLIPS, height=4.86)
