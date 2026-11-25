# 熄烛者（余烛殿的巅峰首领）：很高、很瘦的袍中猎手，连兜帽约 1 : 7.5 的成人比例。高耸带尖的披肩，手臂很长（前臂长，垂下来指尖过膝），
# 两手各提一盏约 0.7 m 的熄灭提灯（短链挂着，铁框 + 熏黑的玻璃，不发光）；袍子往下张开成参差的宽下摆（俯视的领头形状：一个暗的圆盘，
# 中间一圈小的浅色烛冠）；身前一条长前襟，上面一排黄铜烛钉；兜帽里一团暗，两点冷光；头顶一圈铁的烛芯冠，九根矮蜡烛只剩一根还冒着一点火。
# 材质：灰烬袍（新行 ashrobe：冷的暗石板灰，和余烛殿偏品红的地面在色相上分开）、蜡（新行 wax）、熏黑的玻璃（新行 smokeglass）、
# 铁（提灯框、冠带）、黄铜（烛钉、腰扣）、熔渣行的最暗端当兜帽里的黑。
# 发光只有：兜帽里的两点眼光（很小的近白点）、冠上那根还亮着的烛芯（近白的小芯 + 火色的焰面），三阶段重新点燃的另外八根（各自一根骨骼 x_wick_NN，
# 平时缩到看不见，阶段换了以后游戏端在 post 里按 ent.mood 一根一根放大：不换几何）。
# 尺寸、身高、招式时序见 design-note §2 / §4；坐标一律写游戏坐标（x 左、y 上、z 前），进 Kit 时经 rig.g2b 换成 Blender 坐标。
import math

from mathutils import Euler, Vector

from .. import rig
from ..rig import g2b

TAU = 2 * math.pi

# 烛冠：冠带的半径和高度（x_crown 的枢轴在冠带中心），九根蜡烛的角度位置（0 = 正前方，往左转为正）、高度；LIVE = 还亮着的那根
CROWN_Y = 4.72
CROWN_R = 0.3
CANDLES = [(i * TAU / 9, h) for i, h in enumerate((0.26, 0.31, 0.2, 0.28, 0.17, 0.3, 0.22, 0.27, 0.19))]
LIVE = 1
CANDLE_R = 0.05  # 半径 0.05 = 0.10 m 粗（规则：首领尺度上 ≥ 0.06 m）


def wick_top(i):
    """第 i 根蜡烛的火苗根（烛芯顶上 2 cm）：重燃的火苗绕这一点缩放"""
    a, h = CANDLES[i]
    return (math.sin(a) * CROWN_R, CROWN_Y + 0.06 + h, math.cos(a) * CROWN_R - 0.02)


RELIT = [i for i in range(9) if i != LIVE]  # 三阶段一根一根重新点燃的八根（x_wick_01..08 按这个顺序）

# 骨架（35 根 = 14 根标准（脊椎、头、两臂）+ 兜帽、冠、两盏灯和灯盖、下摆四根、披风两节、前襟 + 八根烛芯）：枢轴是游戏坐标。左 = +x（它自己的左边），面朝 +z
BONES = [
    ('pelvis', None, (0, 2.2, 0)),
    ('spine_01', 'pelvis', (0, 2.6, -0.02)),
    ('spine_02', 'spine_01', (0, 3.05, -0.03)),
    ('spine_03', 'spine_02', (0, 3.5, -0.03)),
    ('neck_01', 'spine_03', (0, 3.9, 0.0)),
    ('head', 'neck_01', (0, 4.08, 0.06)),
    ('x_hood', 'neck_01', (0, 4.02, 0.0)),
    ('x_crown', 'x_hood', (0, CROWN_Y, -0.02)),
    ('clavicle_l', 'spine_03', (0.16, 3.78, -0.02)),
    ('upperarm_l', 'clavicle_l', (0.56, 3.8, -0.04)),
    ('lowerarm_l', 'upperarm_l', (0.7, 2.86, -0.02)),
    ('hand_l', 'lowerarm_l', (0.8, 1.8, 0.04)),
    ('x_lamp_l', 'hand_l', (0.8, 1.6, 0.06)),
    ('x_lid_l', 'x_lamp_l', (0.8, 1.24, -0.19)),
    ('clavicle_r', 'spine_03', (-0.16, 3.78, -0.02)),
    ('upperarm_r', 'clavicle_r', (-0.56, 3.8, -0.04)),
    ('lowerarm_r', 'upperarm_r', (-0.7, 2.86, -0.02)),
    ('hand_r', 'lowerarm_r', (-0.8, 1.8, 0.04)),
    ('x_lamp_r', 'hand_r', (-0.8, 1.6, 0.06)),
    ('x_lid_r', 'x_lamp_r', (-0.8, 1.24, -0.19)),
    ('x_hem_f', 'pelvis', (0, 1.55, 0.3)),
    ('x_hem_b', 'pelvis', (0, 1.55, -0.3)),
    ('x_hem_l', 'pelvis', (0.3, 1.55, 0)),
    ('x_hem_r', 'pelvis', (-0.3, 1.55, 0)),
    ('x_cape_01', 'spine_03', (0, 3.72, -0.36)),
    ('x_cape_02', 'x_cape_01', (0, 2.3, -0.5)),
    ('x_tab', 'pelvis', (0, 2.36, 0.4)),
] + [('x_wick_%02d' % (n + 1), 'x_crown', wick_top(i)) for n, i in enumerate(RELIT)]
SKEL = rig.Skel(BONES)
B = SKEL.index
PIV = {b[0]: b[2] for b in BONES}

# 袍子：自上而下的截面（高度, 左右半径, 前后半径），最后一圈是参差的下摆
ROBE = [(3.66, 0.4, 0.3), (3.3, 0.42, 0.32), (2.95, 0.38, 0.3), (2.6, 0.36, 0.33), (2.25, 0.42, 0.4), (1.85, 0.56, 0.5), (1.4, 0.8, 0.74), (0.9, 1.08, 1.02), (0.45, 1.32, 1.26)]
HEM_R = 1.62
SIDES = 32


def robe_z(y, back=False):
    """袍子正前方（back：正后方）在高度 y 处离中轴多远（截面之间线性，和放样的面一致）：前襟、披风贴着袍子放"""
    pts = [(yy, rz) for yy, _, rz in ROBE] + [(0.04, HEM_R * 0.97)]
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        if y1 <= y <= y0:
            return z0 + (z1 - z0) * (y - y0) / (y1 - y0)
    return pts[0][1] if y > pts[0][0] else pts[-1][1]


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


def hull_at(k, bone, local, c, rot=(0, 0, 0), row='ashrobe', tone=0.5, jitter=0.05, glow=0, dust=0, soft=False):
    vs = k.hull(_pts(local, c, rot), row, tone, jitter, glow, dust)
    return k.bind(vs, B[bone], soft)


def hull_frame(k, bone, pts_uvw, o, d, hint=(1, 0, 0), row='ashrobe', tone=0.5, jitter=0.04, glow=0, dust=0, soft=False):
    """局部 (u, v, w) 点集 → 以 o 为原点、v 沿 d 的凸包（斜着的长件：手指、链节）"""
    u, v, w = _frame(d, hint)
    O = Vector(o)
    P = [g2b(tuple(O + u * a + v * b + w * c)) for a, b, c in pts_uvw]
    vs = k.hull(P, row, tone, jitter, glow, dust)
    return k.bind(vs, B[bone], soft)


def hbox(k, bone, c, s, rot=(0, 0, 0), row='iron', tone=0.5, jitter=0.04, bevel=0.03, taper=(1.0, 1.0), glow=0, soft=False):
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
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow, 0, soft)


def blob(k, bone, c, r, n=12, rot=(0, 0, 0), row='ashrobe', tone=0.5, jitter=0.04, glow=0):
    """椭球面上的点取凸包"""
    loc = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        u = (i + 0.5) / n
        y = 1 - 2 * u
        rr = math.sqrt(max(0.0, 1 - y * y))
        a = ga * i + k.r(-0.2, 0.2)
        loc.append((math.cos(a) * rr * r[0], y * r[1], math.sin(a) * rr * r[2]))
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow)


def loft(k, bone, pts, radii, sides=8, squash=1.0, row='ashrobe', tone=0.5, jitter=0.04, cap0=True, cap1=True, soft=False, glow=0, tip=False):
    """沿折线的渐变截面管（椭圆截面：squash < 1 压扁）；soft = 软接缝；tip = 末端收成尖"""
    vs, segs = k.tube([g2b(p) for p in pts], radii, sides=sides, row=row, tone=tone, jitter=jitter, tip=tip, cap0=cap0, cap1=cap1, squash=squash)
    k.tag([f for sg in segs for f in sg], row, tone, jitter, glow=glow, dust=0)
    return k.bind(vs, B[bone], soft)


def torus(k, bone, c, R, r, segs=16, sides=4, row='iron', tone=0.45, rot=(0, 0, 0), glow=0, jitter=0.03, squash=1.0):
    """圆环：中心 c，环所在的平面是转过 rot 的 xz 平面"""
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


def prism(k, bone, c, r, h, n=6, rot=(0, 0, 0), row='iron', tone=0.45, r1=None, jitter=0.02, a0=0.0, glow=0):
    """n 棱柱 / 棱台（灯身、冠上的蜡烛），c = 底面中心，r1 = 顶面半径"""
    r1 = r if r1 is None else r1
    loc = []
    for i in range(n):
        a = a0 + TAU * i / n
        loc.append((math.sin(a) * r, 0.0, math.cos(a) * r))
        loc.append((math.sin(a) * r1, h, math.cos(a) * r1))
    return hull_at(k, bone, loc, c, rot, row, tone, jitter, glow)


def sheet(k, rows, row='ashrobe', tone=0.5, jitter=0.04, thick=0.04, bind=None):
    """布片：rows = 自上而下的若干排点（游戏坐标，每排同样多的点），带厚度的一整张（正反两面 + 一圈边），
    bind(点, 排号, 列号) → (骨骼名, 软接缝)。返回全部顶点"""
    bm = k.bm
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
    k.tag(faces, row, tone, jitter, dust=0)
    vs = []
    for i in range(R):
        for j in range(C):
            bn, sf = bind(rows[i][j], i, j)
            k.bind([F[i][j], Bk[i][j]], B[bn], sf)
            vs += [F[i][j], Bk[i][j]]
    return vs


def flame(k, bone, base, h=0.17, r=0.05, core=0.026):
    """一朵火：火色的焰面（发光 0.72，泪滴形的凸包）+ 根上一粒近白的小芯（发光 1.0）"""
    x, y, z = base
    loc = []
    for i in range(6):
        a = TAU * i / 6
        loc.append((math.sin(a) * r, h * 0.3, math.cos(a) * r))
        loc.append((math.sin(a + 0.5) * r * 0.55, h * 0.62, math.cos(a + 0.5) * r * 0.55))
    loc += [(0, 0.0, 0), (0, h, 0)]
    hull_at(k, bone, loc, (x, y, z), row='ember', tone=0.8, jitter=0.0, glow=0.72)
    hull_at(k, bone, [(-core, 0, 0), (core, 0, 0), (0, 0, -core), (0, 0, core), (0, core * 2.4, 0), (0, -core * 0.6, 0)], (x, y + h * 0.22, z), row='ember', tone=0.98, jitter=0.0, glow=1.0)


# ---------------------------------------------------------------- 蒙皮：袍子一圈按角度在下摆四根骨骼之间渐变，一段按高度从脊椎渐变到下摆
HEM = [('x_hem_f', 0.0), ('x_hem_l', math.pi / 2), ('x_hem_b', math.pi), ('x_hem_r', -math.pi / 2)]
SPINE = [('pelvis', 2.2), ('spine_01', 2.6), ('spine_02', 3.05), ('spine_03', 3.5)]


def _sm(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def robe_weights(p, bone):
    """袍子（绑在 x_hem_f 上、标了软接缝的顶点）的权重：y ≥ 2.2 在脊椎链上按高度线性分；2.15 往下渐渐交给下摆（到 1.15 全给下摆），
    下摆部分按绕竖轴的角度在相邻两根下摆骨骼之间 smoothstep。最多 3 根骨骼"""
    if bone != 'x_hem_f':
        return None
    x, y, z = p
    if y >= SPINE[0][1]:
        for (b0, y0), (b1, y1) in zip(SPINE, SPINE[1:]):
            if y <= y1:
                t = (y - y0) / (y1 - y0)
                return {b0: 1 - t, b1: t}
        return {SPINE[-1][0]: 1.0}
    t = _sm((2.15 - y) / 1.0)
    a = math.atan2(x, z)
    ws = {'pelvis': 1 - t}
    if t > 0:
        # 相邻两根：a 落在哪一个 90° 扇区里
        q = (a % TAU) / (math.pi / 2)
        i = int(q) % 4
        f = _sm(q - int(q))
        for (bn, _), w in ((HEM[i], 1 - f), (HEM[(i + 1) % 4], f)):
            ws[bn] = ws.get(bn, 0) + t * w
    return {b: w for b, w in ws.items() if w > 1e-4}


# ---------------------------------------------------------------- 造型
def robe(k):
    """袍子：一根从披肩下面一直到地面的放样管（截面是略扁的椭圆），下摆一圈参差的布条（长短交替、每条往外翘一点），
    下摆里面一圈往上收的暗衬（低角度看不见空心）。下摆最外一圈是焦黑的烧边"""
    bm = k.bm
    rings = []
    for (y, rx, rz) in ROBE:
        ring = []
        for s in range(SIDES):
            a = TAU * s / SIDES
            ring.append(bm.verts.new(g2b((math.sin(a) * rx, y, math.cos(a) * rz))))
        rings.append(ring)
    # 参差的下摆：偶数点是布条尖（贴地、往外），奇数点是两条之间的豁口（高一点、往里）；长短和高低按种子抖
    hem, lip = [], []
    for s in range(SIDES):
        a = TAU * s / SIDES
        if s % 2 == 0:
            # 布条尖：长短不一（偶尔一条特别长、拖在地上）
            r, y = HEM_R + k.r(-0.06, 0.12) + (0.16 if k.r() < 0.2 else 0.0), k.r(0.0, 0.05)
        else:
            # 豁口：深浅不一（有的撕到小腿高）
            r, y = HEM_R - k.r(0.06, 0.24), k.r(0.12, 0.42)
        hem.append(bm.verts.new(g2b((math.sin(a) * r, y, math.cos(a) * r * 0.97))))
        lip.append(bm.verts.new(g2b((math.sin(a) * (r - 0.12), y + 0.3, math.cos(a) * (r - 0.12) * 0.97))))
    rings.append(hem)
    faces = []
    for i in range(len(rings) - 1):
        A, C = rings[i], rings[i + 1]
        fs = [bm.faces.new((A[s], C[s], C[(s + 1) % SIDES], A[(s + 1) % SIDES])) for s in range(SIDES)]
        faces.append(fs)
    lipf = [bm.faces.new((hem[s], lip[s], lip[(s + 1) % SIDES], hem[(s + 1) % SIDES])) for s in range(SIDES)]
    # 色带：上身是中间调（披肩、兜帽、袍子上段在游戏灯光下读得出形，俯视不发白），往下越来越暗；最后一段（下摆）是暗的，布条一圈焦黑的烧边，衬里最暗
    tones = [0.72, 0.68, 0.62, 0.56, 0.5, 0.43, 0.36, 0.3, 0.26]
    for i, fs in enumerate(faces):
        if i == len(faces) - 1:
            for s, f in enumerate(fs):
                k.tag([f], 'char' if s % 3 == 0 else 'slag', 0.22 if s % 3 == 0 else 0.3, 0.04, dust=0)
        else:
            for s, f in enumerate(fs):  # 竖着的褶：每隔一条面稍暗一点（受光面读得出布褶，不加面数）
                k.tag([f], 'ashrobe', tones[i] - (0.05 if s % 4 in (1, 2) else 0.0), 0.03, dust=0)
    k.tag(lipf, 'slag', 0.06, 0.02, dust=0)
    vs = [v for r in rings for v in r] + lip
    k.bind(vs, B['x_hem_f'], True)
    # 顶上收口（披肩盖着，看不见）
    top = bm.faces.new(list(reversed(rings[0])))
    k.tag([top], 'ashrobe', 0.3, 0.0, dust=0)
    return vs


def build(k):
    """搭形，返回 dict(skel, soft, custom, clips, height)"""
    robe(k)
    # ---- 腰：一圈细绳腰带（黄铜扣），右胯挂一个熄烛的铜罩（掐灭蜡烛用的长柄罩子，挂着晃）----
    torus(k, 'pelvis', (0, 2.42, 0.0), 0.385, 0.035, segs=14, sides=4, row='iron', tone=0.32, rot=(0.0, 0, 0), squash=1.0)
    hbox(k, 'pelvis', (0, 2.42, 0.36), (0.14, 0.12, 0.06), row='brass', tone=0.42, bevel=0.02)
    loft(k, 'pelvis', [(-0.32, 2.38, 0.2), (-0.36, 2.0, 0.26), (-0.38, 1.7, 0.3)], [0.018, 0.018, 0.018], sides=4, row='iron', tone=0.36)
    prism(k, 'pelvis', (-0.38, 1.52, 0.3), 0.09, 0.18, n=6, row='brass', tone=0.38, r1=0.03)

    # ---- 前襟：从胸口垂到小腿的长条（暗袍色），下端参差；上面一排五个黄铜烛钉（小的烛杯形）----
    rows = []
    TY = (3.42, 3.0, 2.55, 2.1, 1.6, 1.1, 0.62)
    for i, y in enumerate(TY):
        hw, z = 0.2 - 0.04 * i / 6, robe_z(y) + 0.05
        rows.append([(x * hw, y - (0.12 if (i == 6 and abs(x) < 0.6) else 0) + (0.06 if (i == 6 and x > 0.6) else 0), z + 0.03 * (1 - x * x)) for x in (-1, -0.5, 0, 0.5, 1)])
    sheet(k, rows, row='ashrobe', tone=0.24, thick=0.04, bind=lambda p, i, j: ('spine_02' if p[1] > 2.75 else 'spine_01' if p[1] > 2.45 else 'x_tab', p[1] <= 2.75))
    for s in (1, -1):
        loft(k, 'x_tab', [(s * 0.19, y, robe_z(y) + 0.075) for y in (2.3, 1.6, 1.1, 0.7)], [0.022] * 4, sides=4, row='iron', tone=0.42, jitter=0.02)
    for i, y in enumerate((3.18, 2.76, 2.3, 1.84, 1.38)):
        z = robe_z(y) + 0.06
        bn = 'spine_02' if y > 2.75 else 'spine_01' if y > 2.45 else 'x_tab'
        prism(k, bn, (0, y - 0.04, z + 0.02), 0.055, 0.09, n=6, row='brass', tone=0.46, r1=0.07, rot=(0.25, 0, 0))
        prism(k, bn, (0, y + 0.03, z + 0.04), 0.022, 0.07, n=5, row='wax', tone=0.32, rot=(0.25, 0, 0))  # 烛钉上的小蜡头（灭的）

    # ---- 胸 + 披肩：高耸带尖的肩（尖比肩关节高 0.35 m），前后两片往下垂到胸口；中间一圈高领托着兜帽 ----
    hull_at(k, 'spine_03', [(-0.34, 3.5, 0.3), (0.34, 3.5, 0.3), (-0.36, 3.5, -0.3), (0.36, 3.5, -0.3), (-0.26, 3.9, 0.22), (0.26, 3.9, 0.22), (-0.28, 3.92, -0.24), (0.28, 3.92, -0.24)], (0, 0, 0), row='ashrobe', tone=0.42, soft=True)
    for s in (1, -1):
        X = lambda x: x * s
        cl = 'clavicle_' + ('l' if s > 0 else 'r')
        # 披肩：外缘尖角往上翘，前后两片垂到胸口以下
        mant = [(X(0.12), 3.98, 0.28), (X(0.12), 3.98, -0.3), (X(0.6), 4.18, -0.04), (X(0.62), 4.14, 0.06), (X(0.86), 3.86, 0.0),
                (X(0.82), 3.4, 0.34), (X(0.84), 3.4, -0.36), (X(0.2), 3.32, 0.4), (X(0.2), 3.32, -0.42), (X(0.5), 3.2, 0.42), (X(0.52), 3.18, -0.44), (X(0.94), 3.5, 0.0)]
        hull_at(k, cl, mant, (0, 0, 0), row='ashrobe', tone=0.86)
        # 披肩下缘一圈参差的暗边（三片往下的布尖）
        for j, (zz, dy) in enumerate(((0.36, 0.22), (0.0, 0.3), (-0.38, 0.2))):
            hull_at(k, cl, [(X(0.7), 3.42, zz - 0.13), (X(0.7), 3.42, zz + 0.13), (X(0.9), 3.48, zz - 0.11), (X(0.9), 3.48, zz + 0.11), (X(0.84), 3.42 - dy, zz), (X(0.76), 3.44, zz)], (0, 0, 0), row='ashrobe', tone=0.66)
        # 尖上一道铁扣（读得出是披肩的尖，不是肩甲）
        hull_at(k, cl, [(-0.05, -0.04, -0.05), (0.05, -0.04, -0.05), (-0.05, -0.04, 0.05), (0.05, -0.04, 0.05), (0, 0.06, 0)], (X(0.6), 4.16, 0.0), row='iron', tone=0.34)
    # 高领：往上收、包住脖子，前面开口
    hull_at(k, 'neck_01', [(-0.3, 3.84, 0.18), (0.3, 3.84, 0.18), (-0.32, 3.84, -0.28), (0.32, 3.84, -0.28), (-0.24, 4.12, 0.12), (0.24, 4.12, 0.12), (-0.26, 4.16, -0.24), (0.26, 4.16, -0.24), (0, 4.04, 0.26)], (0, 0, 0), row='ashrobe', tone=0.72, soft=True)

    # ---- 兜帽：深罩，帽尖往后上方收；正面开口是一整块近黑的暗面，帽沿一圈稍亮的布边；里面一个小的头（成人比例，比兜帽小一圈），两点冷光 ----
    hood = [(-0.3, 4.0, 0.22), (0.3, 4.0, 0.22), (-0.32, 4.02, -0.24), (0.32, 4.02, -0.24), (-0.31, 4.4, 0.24), (0.31, 4.4, 0.24), (-0.3, 4.44, -0.26), (0.3, 4.44, -0.26),
            (-0.22, 4.7, 0.12), (0.22, 4.7, 0.12), (-0.22, 4.72, -0.2), (0.22, 4.72, -0.2), (0, 4.84, -0.3), (0, 4.62, 0.3), (0, 4.0, -0.34)]
    hull_at(k, 'x_hood', hood, (0, 0, 0), row='ashrobe', tone=0.8)
    # 开口的暗面（比帽沿往里一点、略往前凸，正面和俯视的游戏镜头都看得到一块黑）
    hull_at(k, 'x_hood', [(-0.21, 4.04, 0.27), (0.21, 4.04, 0.27), (-0.23, 4.42, 0.3), (0.23, 4.42, 0.3), (0, 4.6, 0.28), (-0.12, 4.56, 0.29), (0.12, 4.56, 0.29), (0, 3.98, 0.24), (-0.18, 4.2, 0.2), (0.18, 4.2, 0.2)], (0, 0, 0), row='slag', tone=0.0, jitter=0.0)
    # 帽沿：开口一圈稍亮的折边
    for s in (1, -1):
        loft(k, 'x_hood', [(s * 0.02, 4.64, 0.31), (s * 0.15, 4.58, 0.32), (s * 0.25, 4.42, 0.32), (s * 0.24, 4.18, 0.3), (s * 0.18, 4.0, 0.27)], [0.04, 0.045, 0.045, 0.04, 0.035], sides=4, row='ashrobe', tone=0.9, jitter=0.02)
    # 头：小的（约 0.36 m 宽），藏在暗面后面；两点眼光（近白的小点，自发光 1.0）
    blob(k, 'head', (0, 4.28, 0.1), (0.15, 0.2, 0.16), n=12, row='slag', tone=0.04, jitter=0.01)
    for s in (1, -1):
        hull_at(k, 'head', [(-0.03, 0, 0), (0.03, 0, 0), (0, 0.016, 0), (0, -0.016, 0), (0, 0, 0.02), (0, 0, -0.012)], (s * 0.075, 4.31, 0.3), rot=(0, 0, s * 0.25), row='ember', tone=0.98, jitter=0.0, glow=1.0)

    # ---- 烛芯冠：一圈黑铁冠带（坐在兜帽顶上），九根粗的蜡烛（0.10 m）；蜡泪挂在冠带上；八根熄灭的芯是焦黑的小头，一根还亮着 ----
    torus(k, 'x_crown', (0, CROWN_Y, -0.02), CROWN_R, 0.04, segs=18, sides=4, row='iron', tone=0.26, squash=1.3)
    for i, (a, h) in enumerate(CANDLES):
        cx, cz = math.sin(a) * CROWN_R, math.cos(a) * CROWN_R - 0.02
        prism(k, 'x_crown', (cx, CROWN_Y + 0.02, cz), 0.03, 0.03, n=6, row='iron', tone=0.3, r1=0.065)  # 烛托
        prism(k, 'x_crown', (cx, CROWN_Y + 0.04, cz), CANDLE_R, h, n=6, row='wax', tone=0.46 + 0.05 * ((i * 5) % 3), r1=CANDLE_R * 0.92, a0=a)
        # 顶上一圈化开的凹口 + 蜡泪（往外侧淌下来的一条）
        hull_at(k, 'x_crown', [(0.0, 0.0, 0.0), (0.016, -0.03, 0.0), (-0.016, -0.03, 0.0), (0.0, -0.12 - 0.04 * (i % 3), 0.0), (0.0, -0.05, 0.022)], (cx + math.sin(a) * CANDLE_R, CROWN_Y + 0.04 + h, cz + math.cos(a) * CANDLE_R), rot=(0, a, 0), row='wax', tone=0.6, jitter=0.0)
        wt = (cx, CROWN_Y + 0.04 + h, cz)
        if i == LIVE:
            loft(k, 'x_crown', [wt, (wt[0], wt[1] + 0.05, wt[2])], [0.01, 0.008], sides=4, row='slag', tone=0.05, jitter=0.0)
            flame(k, 'x_crown', (wt[0], wt[1] + 0.02, wt[2]), h=0.28, r=0.068, core=0.032)
        else:
            loft(k, 'x_crown', [wt, (wt[0], wt[1] + 0.045, wt[2])], [0.012, 0.009], sides=4, row='slag', tone=0.04, jitter=0.0)
            n = RELIT.index(i)
            flame(k, 'x_wick_%02d' % (n + 1), (wt[0], wt[1] + 0.02, wt[2]), h=0.22, r=0.055, core=0.024)
    # 冠带上挂的蜡泪（几条长的，俯视看得到冠是蜡做的）
    for j in range(6):
        a = TAU * (j + 0.5) / 6 + 0.2
        cx, cz = math.sin(a) * (CROWN_R + 0.03), math.cos(a) * (CROWN_R + 0.03) - 0.02
        hull_at(k, 'x_crown', [(-0.02, 0.03, 0), (0.02, 0.03, 0), (0, 0.03, 0.02), (0, -0.1 - 0.03 * (j % 2), 0.0), (0, -0.04, 0.025)], (cx, CROWN_Y, cz), rot=(0, a, 0), row='wax', tone=0.4, jitter=0.0)

    # ---- 手臂：细长的袖子（上臂贴身，前臂往下张成宽的喇叭袖口，袖口参差），手是苍灰的长骨指，攥着提灯的铁环 ----
    for s in (1, -1):
        sd = 'l' if s > 0 else 'r'
        X = lambda x: x * s
        ua, la, hd, lp, ld = 'upperarm_' + sd, 'lowerarm_' + sd, 'hand_' + sd, 'x_lamp_' + sd, 'x_lid_' + sd
        loft(k, ua, [(X(0.56), 3.86, -0.04), (X(0.63), 3.35, -0.03), (X(0.7), 2.86, -0.02)], [0.17, 0.15, 0.14], sides=8, row='ashrobe', tone=0.68, soft=True)
        loft(k, la, [(X(0.7), 2.9, -0.02), (X(0.74), 2.5, 0.0), (X(0.78), 2.12, 0.02)], [0.13, 0.17, 0.25], sides=8, row='ashrobe', tone=0.58)
        # 喇叭袖口：一圈参差的布尖往下
        for j in range(6):
            a = TAU * j / 6 + 0.3
            cx, cz = X(0.78) + math.sin(a) * 0.22, 0.02 + math.cos(a) * 0.22
            hull_at(k, la, [(-0.08, 0.06, 0), (0.08, 0.06, 0), (-0.07, 0.06, 0.04), (0.07, 0.06, 0.04), (0, -0.14 - 0.06 * (j % 2), 0.02)], (cx, 2.1, cz), rot=(0, a, 0), row='ashrobe', tone=0.4)
        # 手：腕、手掌、四根两节的长指（苍灰的骨色，低一档的色带：不发白）、拇指；指头攥着铁环
        loft(k, hd, [(X(0.78), 2.06, 0.02), (X(0.8), 1.86, 0.04)], [0.05, 0.055], sides=6, row='stone', tone=0.2)
        hbox(k, hd, (X(0.8), 1.78, 0.05), (0.1, 0.16, 0.13), row='stone', tone=0.22, bevel=0.03)
        for f in range(4):
            fz = -0.03 + f * 0.035
            loft(k, hd, [(X(0.84), 1.72, fz + 0.03), (X(0.87), 1.62, fz + 0.05), (X(0.85), 1.54, fz + 0.02)], [0.018, 0.016, 0.0], sides=4, row='stone', tone=0.24, tip=True)
        loft(k, hd, [(X(0.76), 1.76, 0.11), (X(0.78), 1.66, 0.13), (X(0.8), 1.6, 0.1)], [0.02, 0.017, 0.0], sides=4, row='stone', tone=0.24, tip=True)
        # 提灯：铁环 + 短链 + 六棱灯身（铁框、熏黑的玻璃，底座、顶盖是 x_lid），总高约 0.7 m
        L = (X(0.8), 0.0, 0.06)
        torus(k, lp, (L[0], 1.6, L[2]), 0.07, 0.016, segs=8, sides=3, row='iron', tone=0.32, rot=(math.pi / 2, 0, 0))
        for c in range(2):  # 两节链
            y0 = 1.52 - c * 0.08
            torus(k, lp, (L[0], y0, L[2]), 0.035, 0.012, segs=6, sides=3, row='iron', tone=0.3, rot=(math.pi / 2, (c % 2) * math.pi / 2, 0))
        # 顶盖（x_lid）：六棱锥 + 顶上的提钮，底沿一圈
        prism(k, ld, (L[0], 1.24, L[2]), 0.25, 0.16, n=6, row='iron', tone=0.36, r1=0.06, a0=0.0)
        prism(k, ld, (L[0], 1.22, L[2]), 0.27, 0.035, n=6, row='iron', tone=0.28)
        prism(k, ld, (L[0], 1.4, L[2]), 0.04, 0.05, n=6, row='iron', tone=0.3, r1=0.03)
        # 灯身：熏黑的玻璃（六棱柱），六根铁立柱，中间一道铁箍
        prism(k, lp, (L[0], 0.86, L[2]), 0.2, 0.36, n=6, row='smokeglass', tone=0.34, r1=0.21, jitter=0.03, a0=TAU / 12)
        for c in range(6):
            a = TAU * c / 6
            px, pz = L[0] + math.sin(a) * 0.225, L[2] + math.cos(a) * 0.225
            hbox(k, lp, (px, 1.04, pz), (0.04, 0.38, 0.04), rot=(0, a, 0), row='iron', tone=0.4 if c % 2 else 0.5, bevel=0.012)
        torus(k, lp, (L[0], 1.04, L[2]), 0.215, 0.02, segs=6, sides=3, row='iron', tone=0.42)
        # 底座 + 底下的尖钮
        prism(k, lp, (L[0], 0.8, L[2]), 0.25, 0.07, n=6, row='iron', tone=0.3, r1=0.24)
        prism(k, lp, (L[0], 0.7, L[2]), 0.02, 0.1, n=6, row='iron', tone=0.28, r1=0.09)
        # 灯里熄掉的灯芯座（暗）
        prism(k, lp, (L[0], 0.87, L[2]), 0.05, 0.08, n=6, row='iron', tone=0.12, r1=0.03)

    # ---- 背后的披风：从披肩下面垂到小腿，下摆参差；两节软接缝 ----
    ys = [3.7, 3.3, 2.9, 2.5, 2.1, 1.7]
    cols = 7
    rows = []
    for i, y in enumerate(ys):
        f = (3.7 - y) / 2.0
        hw = 0.5 + 0.36 * f
        zb = -(robe_z(y, True) + 0.07 + 0.08 * f)
        row = []
        for j in range(cols):
            x = (j / (cols - 1)) * 2 - 1
            yy = y + ((k.r(0.0, 0.22) if j % 2 else -k.r(0.0, 0.1)) if i == len(ys) - 1 else 0)
            row.append((x * hw, yy, zb - 0.06 * (1 - x * x) + 0.3 * x * x * (0.4 + f)))
        rows.append(row)

    def cape_bone(p, i, j):
        return ('x_cape_01' if p[1] > 2.3 else 'x_cape_02', True)
    sheet(k, rows, row='ashrobe', tone=0.6, thick=0.04, bind=cape_bone)

    soft = [
        # (子骨骼, 父骨骼, 枢轴, 轴（父 → 子）, 带宽)
        ('neck_01', 'spine_03', (0, 3.9, 0.0), (0, 1, 0), 0.2),
        ('upperarm_l', 'clavicle_l', (0.56, 3.8, -0.04), (1, -0.4, 0), 0.24),
        ('upperarm_r', 'clavicle_r', (-0.56, 3.8, -0.04), (-1, -0.4, 0), 0.24),
        ('spine_03', 'spine_02', (0, 3.5, -0.03), (0, 1, 0), 0.3),
        ('spine_01', 'pelvis', (0, 2.45, 0.4), (0, 1, 0), 0.3),
        ('spine_02', 'spine_01', (0, 2.75, 0.4), (0, 1, 0), 0.3),
        ('x_tab', 'spine_01', (0, 2.4, 0.44), (0, -1, 0), 0.3),
        ('x_cape_01', 'spine_03', (0, 3.6, -0.4), (0, -1, 0), 0.3),
        ('x_cape_02', 'x_cape_01', (0, 2.3, -0.5), (0, -1, 0), 0.6),
    ]
    from .snuffer_clips import CLIPS
    return dict(skel=SKEL, soft=soft, custom=robe_weights, clips=CLIPS, height=5.0)
