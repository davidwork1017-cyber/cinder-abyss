# 灰烬地带（第 0 区）的布景件生成器。每个函数 = 一类件，参数决定大形、种子决定细节；同一个生成器换种子得到一族风格一致的变体。
# 只搭形和标色，收尾（UV、烘焙、导出）在 core.py。尺寸都是 scale 1 时的米数（游戏里再乘摆放表的缩放）。
import math

from mathutils import Vector

TAU = 2 * math.pi


def _ring_pts(k, n, rx, ry, z, jit=0.15, phase=0.0):
    out = []
    for i in range(n):
        a = phase + TAU * i / n + k.r(-jit, jit)
        rr = 1 + k.r(-jit, jit)
        out.append((math.cos(a) * rx * rr, math.sin(a) * ry * rr, z))
    return out


# ---------------------------------------------------------------- 枯树
def tree(k, h=5.0, r0=0.3, lean=0.12, branches=4, snag=False, sides=6, ember=2, spread=1.0):
    """烧焦的枯树：弯曲渐细的树干 + 外张的根 + 向上斜伸的枝（末端收尖）；snag = 上半截折断（参差的断口）"""
    az = k.r(0, TAU)
    lx, ly = math.cos(az) * lean * h, math.sin(az) * lean * h
    n = 5
    top = h * (0.62 if snag else 1.0)
    pts, rad = [], []
    for i in range(n):
        t = i / (n - 1)
        z = -0.22 + (top + 0.22) * t
        wob = 0.05 * h * math.sin(t * 5 + k.r(0, TAU)) * t
        pts.append((lx * t ** 1.6 + wob * 0.5, ly * t ** 1.6 + wob * 0.3, z))
        rad.append(r0 * (1.0 - 0.62 * t) if not snag else r0 * (1.0 - 0.3 * t))
    rad[0] *= 1.25
    vs, segs = k.tube(pts, rad, sides=sides, row='char', tone=0.45, jitter=0.12, tip=not snag, cap0=False, twist=0.25)
    if snag:
        # 断口：最上一圈的顶点高低错开，中间一点焦木色
        topv = vs[-sides:]
        for v in topv:
            v.co.z += k.r(-0.18, 0.12) * r0 * 3
        k.tag(segs[-1][-1:], 'wood', 0.75, 0.1)
    # 余烬：树干下半截挑几个面透出火光
    low = [f for s in segs[:2] for f in s[:sides]]
    picked = []
    for _ in range(ember):
        f = low[int(k.r(0, len(low))) % len(low)]
        if f not in picked and f.is_valid:
            picked.append(f)
            k.slit(f, width=0.28, depth=0.02 * r0 / 0.3)
    # 根：3–4 条往外往下的楔
    nr = 3 + int(k.r(0, 2))
    for i in range(nr):
        a = az + TAU * i / nr + k.r(-0.4, 0.4)
        L = r0 * k.r(2.4, 3.4)
        p0 = (math.cos(a) * r0 * 0.3, math.sin(a) * r0 * 0.3, r0 * 1.4)
        p1 = (math.cos(a) * L * 0.55, math.sin(a) * L * 0.55, r0 * 0.25)
        p2 = (math.cos(a) * L, math.sin(a) * L, -0.12)
        k.tube([p0, p1, p2], [r0 * 0.55, r0 * 0.38, 0], sides=4, row='char', tone=0.35, tip=True, cap0=True)
    # 枝：从树干中上段伸出，斜向上，末端收尖；一半的枝再分一个小杈
    for i in range(branches):
        t = 0.42 + 0.45 * (i + k.r(0, 0.8)) / branches
        if snag:
            t *= 0.9
        base = Vector(pts[0]).lerp(Vector(pts[-1]), t)
        a = az + math.pi * 0.2 + TAU * (i * 0.382 + k.r(-0.08, 0.08))
        L = h * k.r(0.22, 0.36) * spread * (1.15 - 0.5 * t)
        up = k.r(0.35, 0.75)
        d = Vector((math.cos(a), math.sin(a), up)).normalized()
        bend = Vector((math.cos(a + 0.6), math.sin(a + 0.6), up + 0.4)).normalized()
        p1 = base + d * L * 0.55
        p2 = p1 + bend * L * 0.5
        rb = r0 * (0.55 - 0.18 * t)
        k.tube([base, p1, p2], [rb, rb * 0.6, 0], sides=5, row='char', tone=0.5, tip=True, cap0=False)
        if k.r() < 0.7:
            q = p1 + (bend * 0.2 + Vector((math.cos(a - 0.9), math.sin(a - 0.9), 0.5)).normalized()) * L * 0.4
            k.tube([p1, q], [rb * 0.5, 0], sides=4, row='char', tone=0.55, tip=True, cap0=False)


# ---------------------------------------------------------------- 岩石 / 崖块
def rock(k, sx=1.0, sy=0.8, sz=0.7, n=24, sink=0.06, flat=0.0, row='stone', ember=0):
    """凸包低多边形石块：椭球面上的随机点（上半偏多），底面压平、略埋进地里；flat = 顶面削平的比例"""
    pts = []
    for i in range(n):
        u = k.r(-0.25, 1.0)
        a = k.r(0, TAU)
        z = u
        rr = math.sqrt(max(0.0, 1 - min(1.0, abs(u)) ** 2)) * k.r(0.8, 1.05)
        pz = max(-sink, z * sz * k.r(0.85, 1.05))
        if flat and pz > sz * (1 - flat):
            pz = sz * (1 - flat) + k.r(0, 0.03) * sz
        pts.append((math.cos(a) * rr * sx, math.sin(a) * rr * sy, pz))
    pts += _ring_pts(k, 6, sx * 0.92, sy * 0.92, -sink, 0.12)
    vs = k.hull(pts, row=row, tone=0.5, jitter=0.16)
    if ember:
        fs = sorted(_sorted_faces_of(vs), key=lambda f: (round(f.calc_center_median().z, 4), round(f.calc_center_median().x, 4)))
        side = [f for f in fs if abs(f.normal.z) < 0.5]
        done = []
        for _ in range(min(ember, len(side))):
            f = side[int(k.r(0, len(side))) % len(side)]
            if f not in done and f.is_valid:
                done.append(f)
                k.slit(f, width=0.22, depth=0.03)
    return vs


def cliff(k, w=3.0, d=1.6, h=3.2, tiers=3):
    """崖块：几块逐层收窄、错开的凸包叠成一段带台阶的岩壁"""
    z = -0.08
    for i in range(tiers):
        th = h / tiers * k.r(0.95, 1.25)
        cw, cd = w * (1 - 0.18 * i) * k.r(0.9, 1.05), d * (1 - 0.2 * i)
        ox, oy = k.r(-0.12, 0.12) * w, k.r(-0.1, 0.05) * d
        pts = []
        for j in range(12):
            a = TAU * j / 12 + k.r(-0.2, 0.2)
            pts.append((ox + math.cos(a) * cw * 0.5 * k.r(0.8, 1.0), oy + math.sin(a) * cd * 0.5 * k.r(0.75, 1.0), z + k.r(0, 0.15) * th))
            pts.append((ox + math.cos(a) * cw * 0.42 * k.r(0.7, 1.0), oy + math.sin(a) * cd * 0.42 * k.r(0.7, 1.0), z + th * k.r(0.8, 1.05)))
        k.hull(pts, row='slag' if i == 0 else 'stone', tone=0.45 + 0.08 * i, jitter=0.15)
        z += th * 0.82


# ---------------------------------------------------------------- 废墟：墙段 / 碎墙堆
def wall(k, L=4.0, H=2.4, D=0.6, course=0.42, brick=0.95, broken=0.6, gaps=0.08, bevel=0.0, sink=0.05):
    """砌石墙段：按层错缝排砖，顶部轮廓按 broken 从一头往另一头塌下去，零星缺砖。返回墙脚可用来堆碎块的范围"""
    rows = max(1, int(H / course))
    prof0 = k.r(0, TAU)
    for r in range(rows):
        z0 = -sink + r * course
        x = -L / 2 - (brick * 0.5 if r % 2 else 0)
        while x < L / 2 - 0.05:
            bl = brick * k.r(0.8, 1.2)
            x1 = min(L / 2, x + bl)
            x0 = max(-L / 2, x)
            cx = (x0 + x1) / 2
            t = (cx + L / 2) / L
            limit = H * (1 - broken * t) * (0.85 + 0.15 * math.sin(prof0 + t * 7))
            if z0 + course * 0.5 < limit and k.r() > gaps and x1 - x0 > 0.15:
                m = k.place((cx + k.r(-0.02, 0.02), k.r(-0.03, 0.03), z0 + course / 2), (0, 0, k.r(-0.03, 0.03)))
                k.box((x1 - x0 - 0.03, D * k.r(0.92, 1.0), course - 0.03), m, row='stone', tone=0.5 - 0.04 * r / rows, jitter=0.14, bevel=bevel)
            x = x1
    return rows


def rubble(k, L=8.0, H=3.5, D=1.2):
    """碎墙堆：一段塌了大半的墙 + 墙脚散落的砖块和碎石（替换 kd/rubble_large 的尺度：宽约 8、高约 3.5）"""
    wall(k, L=L * 0.72, H=H, D=D, course=0.62, brick=1.4, broken=0.6, gaps=0.12)
    side = 1 if k.r() < 0.5 else -1
    for i in range(9):
        t = k.r(-0.45, 0.45)
        sx = k.r(0.9, 1.5)
        m = k.place((t * L, side * k.r(0.7, 1.9) * D, k.r(0.2, 0.35)), (k.r(-0.3, 0.3), k.r(-0.3, 0.3), k.r(0, TAU)))
        for v in k.box((sx, 0.9, 0.58), m, row='stone', tone=0.42, jitter=0.15):
            v.co.z = max(-0.12, v.co.z)  # 掉落的砖斜着半埋进地里，但不埋太深
    for i in range(5):
        cx, cy = k.r(-0.4, 0.4) * L, side * k.r(0.3, 1.4) * D
        rk = k.rng.random() * 0.5 + 0.5
        pts = [(cx + p[0], cy + p[1], max(-0.05, p[2])) for p in _blob(k, 0.6 * rk, 0.5 * rk, 0.45 * rk, 9)]
        k.hull(pts, row='slag', tone=0.4, jitter=0.15)


def _blob(k, sx, sy, sz, n):
    out = []
    for i in range(n):
        a = k.r(0, TAU)
        u = k.r(-0.6, 1.0)
        rr = math.sqrt(max(0.05, 1 - u * u))
        out.append((math.cos(a) * rr * sx, math.sin(a) * rr * sy, u * sz))
    return out


# ---------------------------------------------------------------- 柱 / 拱
def pillar(k, h=4.4, r=0.42, sides=8, broken=0.35, plinth=True, chunks=1):
    """断柱：方底座（倒角）+ 八棱柱身，顶端参差折断；柱脚躺一块掉下来的柱段"""
    zb = 0.0
    if plinth:
        pw = r * 2.5
        k.box((pw, pw, 0.36), k.place((0, 0, 0.13)), row='stone', tone=0.62, jitter=0.08, bevel=0.05)
        k.box((pw * 0.82, pw * 0.82, 0.18), k.place((0, 0, 0.38)), row='stone', tone=0.7, jitter=0.08, bevel=0.03)
        zb = 0.45
    top = h * (1 - broken * k.r(0.7, 1.0))
    n = 4
    pts = [(0, 0, zb + (top - zb) * i / (n - 1)) for i in range(n)]
    rad = [r * (1.0 - 0.06 * i / (n - 1)) for i in range(n)]
    vs, segs = k.tube(pts, rad, sides=sides, row='stone', tone=0.76, jitter=0.1, tip=False, cap0=False, twist=0)
    for v in vs[-sides:]:
        v.co.z += k.r(-0.35, 0.05) * r * 1.6
    k.tag(segs[-1][-1:], 'stone', 0.88, 0.06)
    # 柱身中段错开一点：像几节石鼓叠起来
    for v in vs[sides:2 * sides]:
        v.co.x += 0.015 * math.cos(k.seed)
    for i in range(chunks):
        a = k.r(0, TAU)
        d = r * k.r(1.7, 2.1)
        L = r * k.r(1.3, 2.0)
        cx, cy = math.cos(a) * d, math.sin(a) * d
        dx, dy = math.cos(a + 1.4) * L / 2, math.sin(a + 1.4) * L / 2
        cv, cs = k.tube([(cx - dx, cy - dy, r * 0.82), (cx + dx, cy + dy, r * 0.82)], [r * 0.85, r * 0.85], sides=sides, row='stone', tone=0.72, tip=False, cap0=True)
        for v in cv:
            v.co.z = max(-0.04, v.co.z)


def arch(k, span=3.2, h=4.0, r=0.36, n=9, whole=False, kw=0.34, kd=1.6, kh=0.62, key_glow=0.0):
    """拱门：两根方柱 + 半圆拱的楔石（缺省一块楔石缺失）。whole = 楔石一块不缺；kw / kd / kh = 楔石沿拱的宽、厚（× r）、径向高；
    key_glow > 0：拱顶那块楔石正面一道余烬缝（暗芯亮边，俯视时拱顶读得出来）。缺省参数和最早的灰烬拱逐字节相同"""
    for sx in (-1, 1):
        k.box((r * 2.3, r * 2.3, 0.4), k.place((sx * span / 2, 0, 0.15)), row='stone', tone=0.4, bevel=0.04)
        k.box((r * 1.7, r * 1.7, h - 0.35), k.place((sx * span / 2, 0, 0.35 + (h - 0.35) / 2 - 0.02)), row='stone', tone=0.52, bevel=0.03)
    rad = span / 2
    miss = -1 if whole else int(k.r(2, n - 2))
    for i in range(n):
        if i == miss:
            continue
        a = math.pi * (i + 0.5) / n
        cx, cz = math.cos(a) * rad, h + math.sin(a) * rad * 0.9
        m = k.place((cx, 0, cz), (0, -(math.pi / 2 - a), 0))
        vs = k.box((kw, r * kd, kh), m, row='stone', tone=0.55, jitter=0.12, bevel=0.025)
        if key_glow > 0 and i == n // 2:
            fs = sorted([f for f in _sorted_faces_of(vs) if abs(f.normal.y) > 0.8], key=lambda f: (round(f.calc_center_median().y, 4), round(f.calc_area(), 5)))
            for f in (fs[0], fs[-1]) if len(fs) > 1 else fs:  # 前后两面都开一道缝（摆放时随机转向）
                k.slit(f, width=0.2, depth=0.02, glow=key_glow)


# ---------------------------------------------------------------- 火：火坑 / 火盆
def _coals(k, cx, cy, z0, r, n=8, size=0.11):
    """余烬床：一片不规则的焦黑灰底 + 几块不规则的炭块；炭块朝上的面发光（强弱不一），侧面偶尔透一点火光。
    比一整块发光的八边形自然：俯视时是一簇亮点，中间夹着暗的炭和灰。"""
    m = 11
    bed = [k.bm.verts.new((cx + math.cos(TAU * i / m) * r * k.r(0.7, 1.05), cy + math.sin(TAU * i / m) * r * k.r(0.7, 1.05), z0)) for i in range(m)]
    k.tag([k.bm.faces.new(bed)], 'dust', 0.75, 0.05, dust=0)  # 灰白的炉灰，衬出暗的炭块
    for i in range(n):
        a = TAU * (i + k.r(0, 0.7)) / n
        d = r * (0.25 + 0.55 * k.r()) if i else r * 0.1
        px, py = cx + math.cos(a) * d, cy + math.sin(a) * d
        sz = r * size * k.r(0.75, 1.35)
        pts = [(px + q[0], py + q[1], max(z0, z0 + sz * 0.35 + q[2])) for q in _blob(k, sz * 1.3, sz, sz * 0.7, 7)]
        vs = k.hull(pts, row='char', tone=0.15, jitter=0.08, dust=0)
        fs = _sorted_faces_of(vs)
        hot = 1.0 if k.r() < 0.6 else 0.55
        for f in fs:
            if f.normal.z > 0.45:
                k.tag([f], 'ember', 0.55 + 0.4 * hot, 0.12, glow=hot, dust=0)
            elif k.r() < 0.18:
                k.tag([f], 'ember', 0.45, 0.1, glow=0.4, dust=0)



def firepit(k, r=0.29, stones=9, h=0.075):
    """火坑：一圈压扁的石块 + 交叉的焦木 + 中间发光的余烬床（替换 kn/campfire_stones 的尺度，游戏里放大 3.2 倍）"""
    for i in range(stones):
        a = TAU * i / stones + k.r(-0.12, 0.12)
        cx, cy = math.cos(a) * r * 0.82, math.sin(a) * r * 0.82
        s = r * k.r(0.17, 0.24)
        pts = [(cx + p[0], cy + p[1], max(-0.01, p[2] + h * 0.35)) for p in _blob(k, s * 1.2, s, h * 0.65, 8)]
        vs = k.hull(pts, row='pale', tone=0.97, jitter=0.03)
        # 朝火的一侧熏黑：内侧的面换成焦黑
        for f in _sorted_faces_of(vs):
            if f.normal.x * cx + f.normal.y * cy < -0.5 * math.hypot(cx, cy) and k.r() < 0.2:
                k.tag([f], 'char', 0.35, 0.1)
    for i in range(3):
        a = k.r(0, TAU)
        L = r * 0.62
        p0 = (math.cos(a) * L, math.sin(a) * L, h * 0.25)
        p1 = (-math.cos(a) * L * 0.4, -math.sin(a) * L * 0.4, h * 0.75)
        k.tube([p0, p1], [r * 0.08, r * 0.07], sides=5, row='char', tone=0.4, tip=False, cap0=True)
    _coals(k, 0, 0, h * 0.06, r * 0.6, n=8, size=0.13)


def brazier(k, h=1.1, r=0.38):
    """火盆：三足铁架托一个浅碗，碗里是余烬"""
    for i in range(3):
        a = TAU * i / 3 + 0.3
        k.tube([(math.cos(a) * r * 0.95, math.sin(a) * r * 0.95, 0), (math.cos(a) * r * 0.35, math.sin(a) * r * 0.35, h * 0.8)], [0.035, 0.03], sides=4, row='iron', tone=0.5, tip=False)
    # 碗：开口的八棱台（外壁 + 内壁），碗底封口
    k.tube([(0, 0, h * 0.78), (0, 0, h)], [r * 0.35, r], sides=8, row='iron', tone=0.45, tip=False, cap0=True, cap1=False)
    k.tube([(0, 0, h - 0.002), (0, 0, h * 0.86)], [r * 0.96, r * 0.4], sides=8, row='iron', tone=0.3, tip=False, cap0=False, cap1=True)
    _coals(k, 0, 0, h * 0.87, r * 0.62, n=7, size=0.16)


# ---------------------------------------------------------------- 骨 / 残兵
def skull(k, s=0.5, glow_eyes=True):
    """兽骨头颅（大型，趴在地上）：宽颅顶 + 突出的眉骨 + 两个深眼窝（窝底一点余烬光）+ 鼻孔 + 前伸的上颌和下颌。
    朝向：吻部朝 +Y（游戏里随机转向）。"""
    import bmesh
    cw, ch, sn = k.r(0.9, 1.1), k.r(0.9, 1.1), k.r(0.85, 1.2)  # 颅宽、颅高、吻长：种子决定
    res = bmesh.ops.create_icosphere(k.bm, subdivisions=2, radius=1.0)
    vs = res['verts']
    for v in vs:
        x, y, z = v.co
        nx, ny, nz = x * 0.82 * cw, y * (0.95 if y > 0 else 0.85), z * 0.72 * ch
        if y > 0.2 and z > 0.15:  # 眉骨往前顶
            ny += 0.12 * z
        if z < -0.5:
            nz = -0.5 * 0.78
        v.co = Vector((nx, ny, nz + 0.39))
    faces = _sorted_faces_of(vs)
    k.tag(faces, 'bone', 0.74, 0.12)
    # 眼窝：前上方左右各一个面，深深压进去（窝壁焦黑，窝底余烬 / 焦黑）
    for sx in (-1, 1):
        # 眼窝要大：取目标点附近的一小片面（3–4 个），整片往里收、压深，窝壁焦黑，窝底一小块余烬
        tgt = Vector((sx * 0.4, 0.78, 0.62))
        grp = [f for f in faces if f.is_valid and (f.calc_center_median() - tgt).length < 0.36]
        if not grp:
            grp = [min(faces, key=lambda f: (f.calc_center_median() - tgt).length)]
        out = bmesh.ops.inset_region(k.bm, faces=grp, thickness=0.05, depth=-0.22, use_even_offset=True)
        k.tag(out['faces'], 'char', 0.12, 0.04, dust=0)
        k.tag(grp, 'char', 0.05, 0.03, dust=0)
        core_f = min(grp, key=lambda f: (f.calc_center_median() - tgt).length)
        k.tag([core_f], 'ember' if glow_eyes else 'char', 0.6, 0.05, glow=1 if glow_eyes else 0, dust=0)
    # 上颌（吻部）：前伸的楔形凸包，鼻孔是顶面一道暗缝
    up = k.hull([(sx * 0.46, 0.5, z) for sx in (-1, 1) for z in (0.05, 0.58)] + [(sx * 0.3, 0.5 + 0.95 * sn, z) for sx in (-1, 1) for z in (0.06, 0.36)] + [(0, 1.0, 0.56)], row='bone', tone=0.7)
    top = max(_sorted_faces_of(up), key=lambda f: f.normal.z)
    k.slit(top, width=0.25, depth=0.05, row='char')
    # 下颌：贴地的一块，略微张开
    k.hull([(sx * 0.42, 0.4, z) for sx in (-1, 1) for z in (0.0, 0.1)] + [(sx * 0.26, 0.4 + 0.95 * sn, z) for sx in (-1, 1) for z in (0.0, 0.07)], row='bone', tone=0.42)
    # 牙：上颌前缘两颗朝下的尖牙
    for sx in (-1, 1):
        ty = 0.4 + 0.95 * sn - 0.05
        k.hull([(sx * 0.22 + dx, ty + dy, 0.1) for dx, dy in ((-0.05, -0.04), (0.05, -0.04), (0, 0.05))] + [(sx * 0.22, ty + 0.02, -0.01)], row='bone', tone=0.7, dust=0)
    allv = list(k.bm.verts)
    k.xform(allv, k.place((0, -0.25 * s, 0), (0, 0, 0), (s, s, s)))
    for v in allv:
        v.co.z = max(-0.02, v.co.z)


def _sorted_faces_of(vs):
    out = []
    for v in vs:
        for f in v.link_faces:
            if f not in out:
                out.append(f)
    return out


def bones(k, n=3, L=0.7, thick=1.0):
    """几根交叠的长骨（平放）：五棱骨干 + 两头的骨节"""
    for i in range(n):
        a = k.r(0, math.pi) + i * 1.1
        l = L * k.r(0.6, 1.0)
        cx, cy = k.r(-0.12, 0.12), k.r(-0.12, 0.12)
        dx, dy = math.cos(a) * l / 2, math.sin(a) * l / 2
        z = 0.045 * thick + i * 0.03 * thick
        k.tube([(cx - dx, cy - dy, z), (cx, cy, z + 0.01), (cx + dx, cy + dy, z)], [0.035 * thick, 0.028 * thick, 0.035 * thick], sides=5, row='bone', tone=0.86, tip=False, cap0=True)
        for e in (-1, 1):
            ex, ey = cx + e * dx, cy + e * dy
            pts = [(ex + p[0], ey + p[1], max(0.0, z + p[2])) for p in _blob(k, 0.065 * thick, 0.065 * thick, 0.05 * thick, 8)]
            k.hull(pts, row='bone', tone=0.92, jitter=0.06)


def blade(k, h=1.25, w=0.16):
    """插在地上的断剑（剑身斜插、上半截崩断）+ 靠在旁边的圆盾，脚边几块碎石"""
    lean = k.r(0.12, 0.25)
    az = k.r(0, TAU)
    bl = h * 0.55
    pts = []
    for z, ww in ((-0.15, w), (bl * 0.5, w * 0.95), (bl, w * 0.85)):
        for sx in (-1, 1):
            pts.append((sx * ww / 2, 0, z))
        pts.append((0, 0.03, z))
        pts.append((0, -0.03, z))
    pts.append((w * 0.3, 0, bl + 0.12))
    pts.append((-w * 0.2, 0, bl + 0.05))
    vb = k.hull(pts, row='iron', tone=0.82, jitter=0.1)
    vg = k.box((w * 2.4, 0.09, 0.09), k.place((0, 0, -0.17)), row='iron', tone=0.62)
    vh, _ = k.tube([(0, 0, -0.2), (0, 0, -0.5)], [0.03, 0.03], sides=5, row='wood', tone=0.4, tip=False)
    vp = k.hull([(p[0], p[1], p[2] - 0.55) for p in _blob(k, 0.05, 0.05, 0.05, 7)], row='iron', tone=0.5)
    sword = vb + vg + vh + vp
    # 剑倒过来插进地里：剑尖朝下，柄朝上
    k.xform(sword, k.place((0, 0, h * 0.62), (math.pi + lean, 0, az)))
    # 盾：八边形扁盘，斜靠
    ring = [(math.cos(TAU * i / 8) * 0.26, 0, math.sin(TAU * i / 8) * 0.26) for i in range(8)]
    sh = k.hull([(x, -0.025, z) for x, _, z in ring] + [(x * 0.8, 0.035, z * 0.8) for x, _, z in ring], row='iron', tone=0.82, jitter=0.1)
    k.xform(sh, k.place((math.cos(az + 1.2) * 0.38, math.sin(az + 1.2) * 0.38, 0.3), (1.1, 0, az + 1.2)))
    for v in sh:
        v.co.z = max(-0.02, v.co.z)
    for i in range(3):
        a = az + k.r(0, TAU)
        pts = [(math.cos(a) * 0.25 + p[0], math.sin(a) * 0.25 + p[1], max(-0.02, p[2])) for p in _blob(k, 0.11, 0.09, 0.08, 7)]
        k.hull(pts, row='stone', tone=0.4)


def marker(k, h=1.2, w=0.62, d=0.2, ember=1):
    """墓碑 / 界石：略斜的石板，顶端崩掉一角，碑面一道余烬裂缝，脚下两块小石"""
    pts = []
    chip = k.r(0.15, 0.35)
    for sx in (-1, 1):
        for sy in (-1, 1):
            pts.append((sx * w / 2 * k.r(0.92, 1.0), sy * d / 2, -0.05))
            top = h * (1 - (chip if sx > 0 else 0) * k.r(0.8, 1.0))
            pts.append((sx * w / 2 * k.r(0.8, 0.9), sy * d / 2 * 0.9, top))
    pts.append((0, 0, h * 1.04))
    pts.append((0, d / 2 * 0.9, h * 1.02))
    pts.append((0, -d / 2 * 0.9, h * 1.02))
    vs = k.hull(pts, row='stone', tone=0.36, jitter=0.1)
    fs = sorted([f for f in _sorted_faces_of(vs) if abs(f.normal.y) > 0.8], key=lambda f: round(f.calc_area(), 5))
    if fs and ember:
        k.slit(fs[-1], width=0.16, depth=0.03)
    k.xform(vs, k.place((0, 0, 0), (k.r(-0.08, 0.08), k.r(-0.1, 0.1), 0)))
    for v in vs:
        v.co.z = max(-0.05, v.co.z)
    for i in range(2):
        a = k.r(0, TAU)
        pts = [(math.cos(a) * w * 0.55 + p[0], math.sin(a) * w * 0.55 + p[1], max(-0.02, p[2])) for p in _blob(k, 0.12, 0.1, 0.08, 7)]
        k.hull(pts, row='stone', tone=0.42)


# ---------------------------------------------------------------- 路边小物第二版（asset-lib-props2）：先保证游戏缩放下读得出来
def skull2(k, R=0.42, tilt=1.3):
    """骷髅（第二版）：大而圆的颅顶、平的脸面、两个又大又深的黑眼窝、倒三角鼻孔、一排浅色的牙、分开的下颌。
    整个往后仰着躺（脸几乎朝天，tilt ≈ 75°），所以不管游戏里转到哪个朝向，从 50° 的俯视镜头都看得到眼窝。"""
    import bmesh
    sq = k.r(0.95, 1.05)
    res = bmesh.ops.create_icosphere(k.bm, subdivisions=2, radius=R)
    vs = list(res['verts'])
    for v in vs:
        x, y, z = v.co
        x *= 0.9 * sq
        y *= 1.02
        z *= 0.95
        if y > 0.45 * R and z < 0.5 * R:  # 脸面压平
            y = 0.45 * R + (y - 0.45 * R) * 0.25
        if y > 0.3 * R and 0.12 * R < z < 0.42 * R:  # 眉骨略往前顶
            y += 0.06 * R
        v.co = Vector((x, y, z))
    k.bm.normal_update()
    faces = _sorted_faces_of(vs)
    k.tag(faces, 'bone', 0.86, 0.06)
    # 眼窝 / 鼻孔：直接在压平的脸面上嵌几个黑色的扁椭圆块（比在粗的二十面体上挖面好控制：位置、大小、形状都是定的）
    fy = 0.45 * R + (1.02 * R - 0.45 * R) * 0.25  # 脸面大致的 y
    for sx in (-1, 1):
        cx, cz = sx * 0.37 * R, 0.17 * R
        pts = []
        for j in range(10):
            a = TAU * j / 10
            pts.append((cx + math.cos(a) * 0.2 * R, fy - 0.08 * R, cz + math.sin(a) * 0.18 * R))
            pts.append((cx + math.cos(a) * 0.19 * R, fy + 0.035 * R, cz + math.sin(a) * 0.17 * R))
        k.hull(pts, row='slag', tone=0.0, jitter=0.0, dust=0)  # 熔渣行最暗的一档：调色板里最黑的颜色
    nose = [(sx * 0.08 * R, y, 0.0) for sx in (-1, 1) for y in (fy - 0.06 * R, fy + 0.03 * R)] + [(0, y, -0.15 * R) for y in (fy - 0.06 * R, fy + 0.03 * R)]
    k.hull(nose, row='slag', tone=0.0, jitter=0.0, dust=0)
    # 上颌 + 一排牙
    k.hull([(sx * 0.3 * R, y, z) for sx in (-1, 1) for y in (0.15 * R, 0.5 * R) for z in (-0.5 * R, -0.3 * R)], row='bone', tone=0.8)
    for i in range(6):
        tx = (-0.25 + 0.1 * i) * R
        k.box((0.08 * R, 0.07 * R, 0.13 * R), k.place((tx, 0.5 * R, -0.56 * R)), row='bone', tone=0.96, jitter=0.02, dust=0)
    # 颧骨
    for sx in (-1, 1):
        k.hull([(sx * 0.48 * R + p[0], 0.28 * R + p[1], -0.18 * R + p[2]) for p in _blob(k, 0.1 * R, 0.12 * R, 0.08 * R, 7)], row='bone', tone=0.84)
    # 下颌：U 形，略微张开（往下转一点）
    jaw = []
    for sx in (-1, 1):
        jaw += k.hull([(sx * 0.36 * R, -0.05 * R, -0.62 * R), (sx * 0.36 * R, -0.05 * R, -0.46 * R), (sx * 0.3 * R, 0.5 * R, -0.75 * R), (sx * 0.3 * R, 0.5 * R, -0.66 * R),
                       (sx * 0.4 * R, -0.02 * R, -0.62 * R)], row='bone', tone=0.78)
    jaw += k.hull([(sx * 0.3 * R, 0.42 * R, z) for sx in (-1, 1) for z in (-0.78 * R, -0.66 * R)] + [(0, 0.6 * R, -0.8 * R), (0, 0.6 * R, -0.68 * R)], row='bone', tone=0.8)
    k.xform(jaw, k.place((0, 0, 0), (-0.12, 0, 0)))
    # 往后仰着躺：脸朝上；再挪到地面上、水平居中
    allv = list(k.bm.verts)
    k.xform(allv, k.place((0, 0, 0), (tilt, 0, 0)))
    zs = [v.co.z for v in allv]
    xs = [v.co.x for v in allv]
    ys = [v.co.y for v in allv]
    k.xform(allv, k.place((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -min(zs) - 0.03)))
    for v in allv:
        v.co.z = max(-0.03, v.co.z)


def bone(k, L=0.72, r=0.06):
    """一根长骨（平放）：略弯的六棱骨干，两头各两个圆鼓鼓的骨节，俯视是一眼认得出的骨头轮廓"""
    bend = k.r(-0.04, 0.04)
    pts = [(-L / 2 + 0.06, 0, r), (0, bend, r * 1.05), (L / 2 - 0.06, 0, r)]
    k.tube(pts, [r, r * 0.85, r], sides=6, row='bone', tone=0.88, tip=False, cap0=True)
    rk = r * 1.55
    for e in (-1, 1):
        for sy in (-1, 1):
            cx, cy = e * (L / 2 - 0.02), sy * r * 1.05
            k.hull([(cx + p[0], cy + p[1], max(0.0, rk * 0.9 + p[2])) for p in _blob(k, rk, rk * 0.9, rk * 0.85, 10)], row='bone', tone=0.92, jitter=0.05)


def shield_sword(k, R=0.52, h=1.1):
    """断剑插盾（第二版）：大圆盾（浅木板三条 + 亮铁箍 + 盾心）一边垫在一块小石头上、微微翘起（约 15°）；
    一把剑斜着（约 30°）插在盾的一侧、偏离盾心，剑身断了一截，剑尖躺在盾边的地上。俯视不再是「圆盘上一个十字」。"""
    t = 0.07
    ring_w = [(math.cos(TAU * i / 14) * R, math.sin(TAU * i / 14) * R) for i in range(14)]
    ring_i = [(math.cos(TAU * i / 14 + 0.11) * (R + 0.06), math.sin(TAU * i / 14 + 0.11) * (R + 0.06)) for i in range(14)]
    sh = []
    sh += k.hull([(x, y, z) for x, y in ring_i for z in (-t * 0.4, t * 0.35)], row='iron', tone=0.97, dust=0)  # 铁箍
    wv = k.hull([(x, y, z) for x, y in ring_w for z in (-t * 0.5, t * 0.55)], row='plank', tone=0.96, dust=0)  # 木面
    sh += wv
    k.bm.normal_update()
    for f in _sorted_faces_of(wv):
        if f.normal.z > 0.7:
            c = f.calc_center_median()
            band = int((c.x + R) / (2 * R / 3))
            k.tag([f], 'plank', (0.84, 0.99, 0.9)[min(2, max(0, band))], 0.02, dust=0)
    sh += k.hull([(p[0], p[1], t * 0.55 + abs(p[2])) for p in _blob(k, 0.14, 0.14, 0.08, 9)], row='iron', tone=0.95, dust=0)  # 盾心
    # 不加横铁带：铁带和盾心、剑的护手会又拼成一个十字
    tilt = k.r(0.22, 0.3)  # 游戏里每个实例随机转向：翘得太高时一半的朝向是侧对镜头（只剩一条边），平一点任何朝向都看得到盾面
    az = k.r(0, TAU)
    lift = R * math.sin(tilt) + 0.02
    k.xform(sh, k.place((0, 0, lift * 0.55), (tilt, 0, 0)))
    # 垫在盾下翘起那一侧的石头
    k.hull([(p[0], -R * 0.75 + p[1], max(-0.02, p[2] + 0.1)) for p in _blob(k, 0.16, 0.13, 0.12, 8)], row='stone', tone=0.6)
    # 剑：从盾的一侧斜插下去（约 30°），偏离盾心；剑身在中段断开
    bw, bl = 0.15, h * 0.55
    blade = k.hull([(sx * bw / 2, 0, z) for sx in (-1, 1) for z in (-0.12, bl)] + [(0, sy * 0.025, z) for sy in (-1, 1) for z in (-0.12, bl)], row='iron', tone=0.95, jitter=0.03, dust=0)
    guard = k.box((0.54, 0.1, 0.09), k.place((0, 0, bl + 0.04)), row='iron', tone=0.75, bevel=0.015, dust=0)
    grip, _ = k.tube([(0, 0, bl + 0.08), (0, 0, bl + 0.32)], [0.045, 0.042], sides=6, row='plank', tone=0.35, tip=False)
    pom = k.hull([(p[0], p[1], bl + 0.36 + p[2]) for p in _blob(k, 0.06, 0.06, 0.055, 8)], row='iron', tone=0.85, dust=0)
    sw = blade + guard + grip + pom
    lean = k.r(0.45, 0.6)  # 25–35° 偏离竖直
    k.xform(sw, k.place((R * 0.45, R * 0.1, 0.0), (0, lean, 0.35)))
    for v in sw:
        v.co.z = max(-0.12, v.co.z)
    # 断掉的剑尖：躺在盾边的地上
    tip = k.hull([(sx * bw / 2, 0, 0.0) for sx in (-1, 1)] + [(0, sy * 0.022, 0.0) for sy in (-1, 1)] + [(sx * bw * 0.45, 0, 0.05) for sx in (-1, 1)] + [(0, 0, 0.36)], row='iron', tone=0.95, dust=0)
    k.xform(tip, k.place((-R * 0.95, R * 0.55, 0.035), (math.pi / 2, 0, 1.1)))
    allv = list(k.bm.verts)
    k.xform(allv, k.place((0, 0, 0), (0, 0, az)))
    for v in allv:
        v.co.z = max(-0.12, v.co.z)


def grave_cross(k, h=1.2, w=0.72, th=0.14, chip=True):
    """石十字墓碑：粗壮的十字（倒角的方石），略斜，一侧横臂崩掉一截，脚下一个低矮的土石堆"""
    mound = [(p[0], p[1], max(-0.03, p[2] * 0.5)) for p in _blob(k, 0.42, 0.34, 0.16, 12)]
    k.hull(mound, row='dust', tone=0.45, jitter=0.1)
    sw = th * 1.05
    parts = []
    parts += k.box((sw, th, h), k.place((0, 0, h / 2 - 0.04)), row='stone', tone=0.6, jitter=0.06, bevel=0.025)
    yb = h * 0.72
    la = w / 2 - sw / 2
    ra = la * (k.r(0.72, 0.85) if chip else 1.0)  # 一侧横臂崩掉一小截（崩多了像仙人掌）
    parts += k.box((la, th, th * 1.05), k.place((-(sw / 2 + la / 2), 0, yb)), row='stone', tone=0.6, jitter=0.06, bevel=0.022)
    parts += k.box((ra, th, th * 1.05), k.place(((sw / 2 + ra / 2), 0, yb)), row='stone', tone=0.6, jitter=0.06, bevel=0.022)
    k.xform(parts, k.place((0, 0, 0), (k.r(-0.07, 0.07), k.r(0.04, 0.1) * (1 if k.r() < 0.5 else -1), k.r(-0.2, 0.2))))
    for v in parts:
        v.co.z = max(-0.04, v.co.z)
# ================================================================ 坠星裂谷（第 4 区）
# 形状语言：硬朗的板岩碎片、断开后悬在半空的断块、断面上透出一点星辉（冷青的晶光，顶点自发光，不加 draw）。
# 颜色只管相对明暗：游戏里布景材质乘区域配色（rift prop.tint 0x3e5250）、只留 12% 饱和度，青色的晶光走自发光、保留色相。
def _shard_pts(k, n, rx, ry, z0, z1, taper=0.7, tilt=(0.0, 0.0), tilt0=(0.0, 0.0), jit=0.12, phase=None, tip=0.0, mid=0.0):
    """多棱板岩块的点：底圈（按 tilt0 斜切）+ 顶圈（按 taper 收小，按 tilt 斜切）；mid > 0 时中间加一圈往外鼓 mid 的点（略带腰身）；
    tip > 0 时顶上再加一个尖。返回 (点, 顶面平面, 底面平面)：平面 = (z 截距, x 斜率, y 斜率)，用来认出断面"""
    ph = k.r(0, TAU) if phase is None else phase
    pts = []
    for i in range(n):
        a = ph + TAU * i / n + k.r(-jit, jit) * 0.6
        c, s = math.cos(a), math.sin(a)
        rr = 1 + k.r(-jit, jit)
        x0, y0 = c * rx * rr, s * ry * rr
        pts.append((x0, y0, z0 + tilt0[0] * x0 + tilt0[1] * y0))
        x1, y1 = x0 * taper, y0 * taper
        pts.append((x1, y1, z1 + tilt[0] * x1 + tilt[1] * y1))
        if mid > 0:
            t = k.r(0.35, 0.6)
            sc = (1 - t) + taper * t + mid
            pts.append((x0 * sc, y0 * sc, z0 + (z1 - z0) * t))
    if tip > 0:
        pts.append((k.r(-0.2, 0.2) * rx * taper, k.r(-0.2, 0.2) * ry * taper, z1 + tip))
    return pts, (z1, tilt[0], tilt[1]), (z0, tilt0[0], tilt0[1])


def _on_plane(f, pl, eps=1e-4):
    return all(abs(v.co.z - (pl[0] + pl[1] * v.co.x + pl[2] * v.co.y)) < eps for v in f.verts)


def _glow_faces(k, vs, pl, glow=0.4, tone=0.62):
    """断面（落在平面 pl 上的面）标成星辉：发一点冷青的光，不盖积灰"""
    fs = [f for f in _sorted_faces_of(vs) if _on_plane(f, pl)]
    k.tag(fs, 'starglass', tone, 0.08, glow=glow, dust=0)
    return fs


def _slate_block(k, n, rx, ry, z0, z1, m, taper=0.8, tilt=(0, 0), tilt0=(0, 0), tip=0.0, mid=0.0, tone=0.5, glow_top=0.0, glow_bot=0.0, row='slate', jit=0.12):
    pts, top, bot = _shard_pts(k, n, rx, ry, z0, z1, taper=taper, tilt=tilt, tilt0=tilt0, tip=tip, mid=mid, jit=jit)
    vs = k.hull(pts, row=row, tone=tone, jitter=0.12)
    if glow_top and tip <= 0:
        _glow_faces(k, vs, top, glow_top)
    if glow_bot:
        _glow_faces(k, vs, bot, glow_bot)
    k.xform(vs, m)
    return vs


def _crystal(k, L, r, m, glow=0.35, sides=5):
    """一根小晶刺：五棱柱 + 尖，整根是星辉色（弱自发光）"""
    pts = []
    for i in range(sides):
        a = TAU * i / sides + k.r(-0.15, 0.15)
        pts.append((math.cos(a) * r, math.sin(a) * r, 0))
        pts.append((math.cos(a) * r * 0.85, math.sin(a) * r * 0.85, L * 0.72))
    pts.append((0, 0, L))
    vs = k.hull(pts, row='starglass', tone=0.55, jitter=0.1, glow=glow, dust=0)
    k.xform(vs, m)
    return vs


def _ground_clamp(vs, z=-0.05):
    for v in vs:
        v.co.z = max(z, v.co.z)


def monolith(k, h=0.95, w=0.86, d=0.5, gap=0.06, glow=0.4):
    """裂谷石碑：一块高而薄的板岩，上端沿一道陡的斜线断开，断下来的一截悬在断口上方一点、略转；旁边并着一块矮一些的板岩往外斜，
    脚边一块崩落的石片。（替换 kn/stone_tallA 的尺度：scale 1 时宽 ±0.49、厚 ±0.34、高约 1）"""
    sgn = 1 if k.r() < 0.5 else -1
    sl = sgn * k.r(0.75, 1.0)
    z1 = h * 0.6
    lean = k.r(-0.04, 0.04)
    m = k.place((-sgn * w * 0.1, 0, 0), (lean, k.r(-0.03, 0.03), k.r(-0.1, 0.1)))
    vs = _slate_block(k, 5, w * 0.27, d * 0.24, -0.05, z1, m, taper=0.86, tilt=(sl, 0), mid=0.03, tone=0.5, glow_top=glow, jit=0.08)
    _ground_clamp(vs)
    # 悬着的断块：底面和断口平行（同一个斜率），往上抬 gap，略转一点；顶上收一个歪的尖
    zb = z1 + gap
    m2 = k.place((-sgn * w * 0.1 + k.r(-0.015, 0.015), 0, 0), (lean + k.r(-0.04, 0.04), k.r(-0.05, 0.05), k.r(-0.12, 0.12)))
    _slate_block(k, 5, w * 0.27 * 0.86, d * 0.24 * 0.86, zb, zb + h * 0.16, m2, taper=0.75, tilt=(sl * 0.4, k.r(-0.2, 0.2)), tilt0=(sl, 0), tip=h * 0.12, tone=0.58, glow_bot=glow, jit=0.08)
    # 并排的矮板岩：往外斜，平的断顶（不发光）
    m3 = k.place((sgn * w * 0.24, k.r(-0.04, 0.04), 0), (k.r(-0.05, 0.05), sgn * 0.16, k.r(-0.25, 0.25)))
    vs3 = _slate_block(k, 5, w * 0.17, d * 0.2, -0.05, h * 0.5, m3, taper=0.8, tilt=(-sgn * 0.5, k.r(-0.2, 0.2)), tone=0.44, jit=0.08)
    _ground_clamp(vs3)
    # 崩落的石片：平躺在前面的地上
    a = k.r(0, TAU)
    m4 = k.place((math.cos(a) * w * 0.3, math.sin(a) * d * 0.5, 0), (k.r(-0.2, 0.2), k.r(-0.2, 0.2), k.r(0, TAU)))
    vs4 = _slate_block(k, 5, w * 0.12, d * 0.1, -0.04, 0.05, m4, taper=0.8, tone=0.46)
    _ground_clamp(vs4)


def shards(k, h=0.75, r=0.22, gap=0.04, glow=0.4):
    """板岩晶簇：中间一根高的六棱碎片（上端断开，断尖悬在上方），旁边两根矮的往外斜。（替换 kn/stone_tallC：±0.23、高约 0.78）"""
    z1 = h * 0.74
    sl = k.r(0.25, 0.45)
    vs = _slate_block(k, 6, r * 0.42, r * 0.36, -0.05, z1, k.place((0, 0, 0), (k.r(-0.05, 0.05), k.r(-0.05, 0.05), 0)), taper=0.72, tilt=(sl, 0), tone=0.52, glow_top=glow)
    _ground_clamp(vs)
    zb = z1 + gap
    _slate_block(k, 5, r * 0.3, r * 0.26, zb, zb + h * 0.06, k.place((0, 0, 0), (0, k.r(-0.08, 0.08), k.r(-0.3, 0.3))), taper=0.6, tilt0=(sl, 0), tip=h * 0.12, tone=0.6, glow_bot=glow)
    a0 = k.r(0, TAU)
    for i, (hh, rr) in enumerate(((0.55, 0.32), (0.4, 0.28))):
        a = a0 + math.pi * (0.75 + 0.5 * i) + k.r(-0.2, 0.2)
        cx, cy = math.cos(a) * r * 0.42, math.sin(a) * r * 0.42
        m = k.place((cx, cy, 0), (-math.sin(a) * 0.3, math.cos(a) * 0.3, k.r(0, TAU)))
        v2 = _slate_block(k, 5, r * rr, r * rr * 0.85, -0.05, h * hh, m, taper=0.55, tip=h * 0.1, tone=0.46 + 0.05 * i)
        _ground_clamp(v2)


def stele(k, h=0.82, w=0.2, gap=0.022, glow=0.45):
    """星骸碑：倒角方座上三节方锥形的碑身，节与节之间空开一道缝（悬着）、各自转一点；中节碑面一道星辉刻线，顶上收尖。
    （替换 kn/statue_obelisk：±0.15、高约 0.88）"""
    k.box((w * 1.5, w * 1.5, 0.11), k.place((0, 0, 0.005)), row='slate', tone=0.4, jitter=0.06, bevel=0.018)
    z = 0.06
    segs = [0.26, 0.22, 0.17]
    wid = w
    tot = h - 0.06 - gap * 2 - h * 0.08
    s = tot / sum(segs)
    mid_vs = None
    for i, sh in enumerate(segs):
        hh = sh * s
        tw = wid * 0.9
        m = k.place((k.r(-0.008, 0.008), k.r(-0.008, 0.008), 0), (0, 0, k.r(-0.09, 0.09)))
        last = i == len(segs) - 1
        vs = _slate_block(k, 4, wid * 0.7, wid * 0.7, z, z + hh, m, taper=tw / wid, tip=h * 0.08 if last else 0, tone=0.5 + 0.04 * i, glow_top=0 if last else glow * 0.7, glow_bot=glow * 0.7 if i else 0, jit=0.03)
        if i == 1:
            mid_vs = vs
        z += hh + gap
        wid = tw
    # 中节最大的一面刻一道竖的星辉线
    fs = sorted([f for f in _sorted_faces_of(mid_vs) if abs(f.normal.z) < 0.3], key=lambda f: (round(f.calc_area(), 5), round(f.calc_center_median().x, 4)))
    if fs:
        k.slit(fs[-1], width=0.12, depth=0.006, row='starglass', glow=glow)


def boulder(k, sx=0.5, sy=0.48, sz=0.52, gap=0.035, glow=0.3, n=26):
    """裂开的巨石：一块凸包岩石从中间劈成两半、往两边略微张开，劈面透出一点星辉。（替换 kn/rock_largeD：±0.53、高约 0.57）"""
    a = k.r(0, math.pi)
    nx, ny = math.cos(a), math.sin(a)
    pts = []
    for i in range(n):
        u = k.r(-0.2, 1.0)
        b = k.r(0, TAU)
        rr = math.sqrt(max(0.0, 1 - min(1.0, abs(u)) ** 2)) * k.r(0.82, 1.04)
        pts.append((math.cos(b) * rr * sx, math.sin(b) * rr * sy, max(-0.05, u * sz * k.r(0.85, 1.02))))
    pts += _ring_pts(k, 7, sx * 0.9, sy * 0.9, -0.05, 0.1)
    for side in (1, -1):
        half = [p for p in pts if (p[0] * nx + p[1] * ny) * side > gap / 2]
        # 劈面：在两半之间的平面上取几点（和外形同一个轮廓，收进一点）
        cut = []
        for i in range(8):
            t = (i + 0.5) / 8
            zc = -0.05 + (sz * 0.92) * math.sin(math.pi * t) * k.r(0.85, 1.0) if i % 2 else -0.05 + sz * 0.9 * t
            w0 = math.sqrt(max(0.0, 1 - ((zc + 0.05) / (sz * 1.02)) ** 2)) * k.r(0.75, 0.95)
            ex = (-ny * sx, nx * sy)
            sgn = 1 if i % 2 else -1
            cut.append((nx * side * gap / 2 + ex[0] * w0 * sgn, ny * side * gap / 2 + ex[1] * w0 * sgn, zc))
        vs = k.hull(half + cut, row='slate', tone=0.48 + 0.04 * side, jitter=0.14)
        cf = []
        for f in _sorted_faces_of(vs):
            if all(abs(v.co.x * nx + v.co.y * ny - side * gap / 2) < 1e-4 for v in f.verts):
                cf.append(f)
        k.tag(cf, 'starglass', 0.5, 0.08, glow=glow, dust=0)
        # 两半各往外倾一点（绕底边转）
        k.xform(vs, k.place((nx * side * gap * 0.6, ny * side * gap * 0.6, 0), (-ny * side * 0.05, nx * side * 0.05, 0)))
        _ground_clamp(vs)
    for i in range(2):
        b = a + math.pi / 2 + math.pi * i + k.r(-0.4, 0.4)
        pts2 = [(math.cos(b) * sx * 0.95 + p[0], math.sin(b) * sy * 0.95 + p[1], max(-0.04, p[2])) for p in _blob(k, 0.08, 0.07, 0.06, 7)]
        k.hull(pts2, row='slate', tone=0.42)


def rift_rock(k, sx=0.36, sy=0.48, sz=0.42):
    """路边的板岩块：两三层压扁的凸包叠起来、层与层错开一点（板岩的层理），顶层削平。（替换 kn/rock_largeB：±0.38 × ±0.51、高约 0.43）"""
    z = -0.05
    layers = 3
    for i in range(layers):
        th = sz * (0.42 if i == 0 else 0.3) * k.r(0.9, 1.1)
        f = 1.0 - 0.2 * i
        ox, oy = k.r(-0.08, 0.08) * sx, k.r(-0.08, 0.08) * sy
        rot = k.r(-0.25, 0.25)
        pts = []
        for j in range(9):
            a = TAU * j / 9 + k.r(-0.2, 0.2)
            c, s_ = math.cos(a + rot), math.sin(a + rot)
            rr = f * k.r(0.78, 1.0)
            pts.append((ox + c * sx * rr, oy + s_ * sy * rr, z + k.r(0, 0.04) * sz))
            pts.append((ox + c * sx * rr * 0.86, oy + s_ * sy * rr * 0.86, z + th * k.r(0.85, 1.0)))
        k.hull(pts, row='slate', tone=0.46 + 0.05 * i, jitter=0.12)
        z += th * 0.88


def rift_rubble(k, L=8.0, D=3.0, H=3.4, glow=0.35):
    """塌落的板岩堆：一块立着的断碑（断口斜、透星辉，断尖悬在上方），一块大板岩斜靠在它身上，脚下几块倒下的厚板和碎块。
    （替换 kd/rubble_large：宽 ±4.07、深 ±1.6、高约 3.5）"""
    side = 1 if k.r() < 0.5 else -1
    sl = side * k.r(0.5, 0.7)
    x0 = -side * L * 0.16
    z1 = H * 0.72
    vs = _slate_block(k, 4, L * 0.12, D * 0.22, -0.05, z1, k.place((x0, 0, 0), (k.r(-0.04, 0.04), k.r(-0.05, 0.05), k.r(-0.2, 0.2))), taper=0.85, tilt=(sl, 0), tone=0.52, glow_top=glow, jit=0.05)
    _ground_clamp(vs)
    zb = z1 + 0.22
    _slate_block(k, 4, L * 0.1, D * 0.19, zb, zb + 0.5, k.place((x0, 0, 0), (k.r(-0.05, 0.05), k.r(-0.05, 0.05), k.r(-0.15, 0.15))), taper=0.6, tilt0=(sl, 0), tip=0.35, tone=0.58, glow_bot=glow, jit=0.05)
    # 斜靠的大板：底脚在外侧地上，顶端搭在断碑上
    k.box((L * 0.38, D * 0.55, 0.4), k.place((side * L * 0.06, k.r(-0.2, 0.2), H * 0.3), (0, -side * 0.72, k.r(-0.15, 0.15))), row='slate', tone=0.46, jitter=0.1, bevel=0.06)
    # 倒下的厚板
    for i in range(3):
        t = side * k.r(0.2, 0.45) if i else -side * k.r(0.3, 0.45)
        k.box((k.r(1.6, 2.4), k.r(1.1, 1.6), k.r(0.55, 0.85)), k.place((t * L, k.r(-0.6, 0.6) * D * 0.4, 0.25), (k.r(-0.15, 0.15), k.r(-0.25, 0.25), k.r(0, TAU))), row='slate', tone=0.42 + 0.04 * i, jitter=0.12, bevel=0.06)
    # 碎块
    for i in range(6):
        t = k.r(-0.46, 0.46)
        rk = k.r(0.3, 0.6)
        cy = k.r(-0.8, 0.8) * D * 0.4
        pts = [(t * L + p[0], cy + p[1], max(-0.05, p[2] + 0.08)) for p in _blob(k, 0.6 * rk, 0.5 * rk, 0.45 * rk, 8)]
        k.hull(pts, row='slate', tone=0.4, jitter=0.15)


def slabs(k, r=1.0, th=0.15, n=4, glow=0.3):
    """碎裂的地砖：一块方形板岩砖裂成三四块、稍微错开翘起，缝里一点晶尘。平放在地上（摆放标记 l），哪个朝向看都是几块板。
    （替换 kd/floor_tile_small_broken_A：±1 × ±1、厚 0.15；原点在底面，旧件的底在 y = -0.1）"""
    z0, z1 = -0.1, th - 0.1
    cx, cy = k.r(-0.25, 0.25) * r, k.r(-0.25, 0.25) * r
    a0 = k.r(0, TAU)
    cuts = sorted([a0 + TAU * (i + k.r(-0.2, 0.2)) / n for i in range(n)])
    corners = [(-r, -r), (r, -r), (r, r), (-r, r)]
    miss = int(k.r(0, n)) if k.r() < 0.6 else -1
    for i in range(n):
        a1, a2 = cuts[i], cuts[(i + 1) % n] + (TAU if i == n - 1 else 0)
        poly = [(cx, cy)]
        # 沿两条裂缝射线到方砖边界，中间带上落在这块里的角
        def edge_hit(a):
            dx, dy = math.cos(a), math.sin(a)
            ts = []
            for (px, py, ex, ey) in ((-r, None, 1, 0), (r, None, 1, 0), (None, -r, 0, 1), (None, r, 0, 1)):
                if px is not None and abs(dx) > 1e-6:
                    t = (px - cx) / dx
                    if t > 0 and abs(cy + dy * t) <= r + 1e-6:
                        ts.append(t)
                if py is not None and abs(dy) > 1e-6:
                    t = (py - cy) / dy
                    if t > 0 and abs(cx + dx * t) <= r + 1e-6:
                        ts.append(t)
            t = min(ts)
            return (cx + dx * t, cy + dy * t)
        poly.append(edge_hit(a1))
        for (qx, qy) in corners:
            aq = math.atan2(qy - cy, qx - cx)
            while aq < a1:
                aq += TAU
            if aq < a2:
                poly.append((qx, qy, aq))
        poly = poly[:2] + [p[:2] for p in sorted(poly[2:], key=lambda p: p[2])]
        poly.append(edge_hit(a2))
        if i == miss:
            continue  # 这一块碎掉了（缺一角），露出地面
        # 每块往外错开一点（裂缝）、缩进一点（边缘崩口），整体略翘
        mx = sum(p[0] for p in poly) / len(poly)
        my = sum(p[1] for p in poly) / len(poly)
        sh = 0.035 * r
        dl = math.hypot(mx - cx, my - cy) or 1
        ox, oy = (mx - cx) / dl * sh, (my - cy) / dl * sh
        pts = []
        for (px, py) in poly:
            qx, qy = mx + (px - mx) * k.r(0.9, 0.97) + ox, my + (py - my) * k.r(0.9, 0.97) + oy
            pts.append((qx, qy, z0))
            pts.append((qx, qy, z1 - k.r(0, 0.03)))
        vs = k.hull(pts, row='slate', tone=k.r(0.12, 0.26), jitter=0.08)
        tx, ty = k.r(-0.03, 0.03), k.r(-0.03, 0.03)
        k.xform(vs, Matrix_about(mx, my, z0, tx, ty))  # 包围盒最后由清单里的 fit 拉回 ±r、y 0–0.15
    # 缝里的晶尘：两三粒很小的星辉碎晶
    for i in range(3):
        b = cuts[i % n] + 0.02
        d = k.r(0.2, 0.6) * r
        pts = [(cx + math.cos(b) * d + p[0], cy + math.sin(b) * d + p[1], z0 + 0.02 + abs(p[2])) for p in _blob(k, 0.035 * r, 0.03 * r, 0.035, 6)]
        k.hull(pts, row='starglass', tone=0.5, jitter=0.08, glow=glow, dust=0)


def Matrix_about(px, py, pz, rx, ry):
    """绕点 (px, py, pz) 的小角度倾斜（rx / ry 弧度）"""
    from mathutils import Euler, Matrix
    T = Matrix.Translation(Vector((px, py, pz)))
    return T @ Euler((rx, ry, 0), 'XYZ').to_matrix().to_4x4() @ T.inverted()


# ================================================================ 烬渊深处（第 3 区）
# 形状语言：暗的玄武岩芯、亮的余烬边（自发光的细缝和螺旋刻纹），墓地和祭坛的残迹。
# 已有的石碑 / 晶簇 / 巨石 / 拱 / 柱 / 枯树 / 火坑 / 骷髅 / 石十字直接复用（清单里 remap 换成熔渣 + 余烬），这里只写新件。
def _spiral(k, c, u, v, n, r0, r1, turns=1.6, steps=14, rad=0.025, glow=0.5, lift=0.012):
    """刻在面上的螺旋：面中心 c、面内两个方向 u / v、面外法线 n；从 r0 绕到 r1，用一根细管子贴在面外 lift 处，标成余烬（弱自发光）"""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        a = turns * TAU * t
        r = r0 + (r1 - r0) * t
        pts.append(c + u * (math.cos(a) * r) + v * (math.sin(a) * r) + n * lift)
    vs, segs = k.tube(pts, [rad] * len(pts), sides=4, row='ember', tone=0.6, jitter=0.05, tip=False, cap0=True)
    k.tag([f for sg in segs for f in sg], 'ember', 0.6, 0.06, glow=glow, dust=0)
    return vs


def tomb(k, L=1.7, W=1.0, H=2.0, glow=0.5):
    """碎墓：一头立着高大的圆顶墓碑（两级碑座、圆弧碑顶，一侧肩上崩掉一角，碑面一道余烬螺旋），碑前一块矮的石棺盖裂成两半、错开（裂缝透余烬）。
    墓碑是主体：俯视和侧看都先读出「一块圆顶的碑」。（替换 kh/grave_A_destroyed：约 2.1 × 1.1、高 2.1）"""
    from mathutils import Vector
    hx = -L * 0.42
    # 碑座（两级）
    k.box((0.5, W * 1.08, 0.18), k.place((hx, 0, 0.09)), row='stone', tone=0.36, jitter=0.06, bevel=0.03)
    k.box((0.4, W * 0.98, 0.14), k.place((hx, 0, 0.25)), row='stone', tone=0.42, jitter=0.06, bevel=0.025)
    # 碑身：矩形下半 + 半圆碑顶（凸包），厚 0.28；一侧肩上崩角
    th, w2 = 0.14, W * 0.44
    pts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            pts.append((hx + sx * th, sy * w2, 0.3))
        rr = w2
        for j in range(9):
            a = math.pi * j / 8
            y, z = math.cos(a) * rr, H - rr + math.sin(a) * rr
            if j <= 1 and k.r() < 2:  # 一侧肩上崩掉一角
                y *= 0.82
                z -= 0.12
            pts.append((hx + sx * th, y, z))
    hv = k.hull(pts, row='stone', tone=0.48, jitter=0.06)
    # 碑面（朝 +x）的螺旋
    _spiral(k, Vector((hx + th, 0, H * 0.6)), Vector((0, 1, 0)), Vector((0, 0, 1)), Vector((1, 0, 0)), 0.04, w2 * 0.58, turns=1.75, steps=16, rad=0.024, glow=glow)
    k.xform(hv, k.place((0, 0, 0), (0, k.r(-0.05, -0.01), 0)))
    # 石棺盖：矮、短，裂成两半错开
    x0, x1 = hx + 0.22, L * 0.5
    ln = (x1 - x0)
    k.box((ln, W * 0.72, 0.18), k.place(((x0 + x1) / 2, 0, 0.07)), row='stone', tone=0.38, jitter=0.08, bevel=0.025)
    cut = k.r(-0.08, 0.08) * ln
    for side in (-1, 1):
        l2 = ln * 0.5 - 0.02 + side * cut * 0.5
        cx = (x0 + x1) / 2 + side * (ln * 0.25 + 0.01) + cut * 0.25
        k.box((l2, W * 0.78, 0.12), k.place((cx, side * k.r(0.0, 0.04), 0.22), (k.r(-0.03, 0.03), side * k.r(0.02, 0.05), side * k.r(0.02, 0.07))), row='stone', tone=0.5, jitter=0.1, bevel=0.02)
    k.box((0.06, W * 0.62, 0.03), k.place(((x0 + x1) / 2 + cut * 0.25, 0, 0.16)), row='ember', tone=0.7, jitter=0.05, glow=glow, dust=0)
    # 脚边两块碎石
    for i in range(2):
        a = k.r(0, TAU)
        k.hull([(math.cos(a) * L * 0.45 + p[0], math.sin(a) * W * 0.5 + p[1], max(-0.02, p[2])) for p in _blob(k, 0.12, 0.1, 0.09, 7)], row='stone', tone=0.38)


def ribs(k, L=0.84, R=0.36, n=5, rad=0.035):
    """仰躺的兽骨架：一根略弯的脊椎（几节椎骨），两侧几对往上弯拱的肋骨，末端收细。平放在地上（摆放标记 l）。（替换 kh/ribcage：±0.42、高约 0.86）"""
    # 脊椎：沿 x 的弯管 + 几节椎骨
    sp = []
    for i in range(6):
        t = i / 5
        sp.append(((t - 0.5) * L, 0.03 * math.sin(t * 3 + k.r(0, 1)), rad * 1.4))
    k.tube(sp, [rad * 1.25] * len(sp), sides=5, row='bone', tone=0.82, tip=False, cap0=True)
    for i in range(5):
        t = (i + 0.5) / 5
        x = (t - 0.5) * L
        k.hull([(x + p[0], p[1], rad * 1.4 + abs(p[2])) for p in _blob(k, rad * 1.4, rad * 1.8, rad * 1.3, 7)], row='bone', tone=0.88, jitter=0.05)
    # 肋骨：每对从脊椎两侧往外、往上弯，再往里收（像倒扣的篮子）
    for i in range(n):
        t = (i + 0.7) / (n + 0.6)
        x = (t - 0.5) * L * 0.9
        h = R * (1.05 - 0.55 * abs(t - 0.45)) * k.r(0.9, 1.05)
        w = R * (0.95 - 0.35 * abs(t - 0.4)) * k.r(0.92, 1.05)
        for side in (-1, 1):
            # 一对肋骨在脊椎上方合拢成拱（俯视是一圈圈的肋，侧看是倒扣的笼子）
            pts = [(x, side * rad * 1.5, rad * 1.4), (x + 0.01, side * w, h * 0.42), (x + 0.03, side * w * 0.78, h * 0.86), (x + 0.04, side * w * 0.14, h)]
            if k.r() < 0.18:
                pts = pts[:3]  # 断了一根
            k.tube(pts, [rad, rad * 0.9, rad * 0.75, rad * 0.4][:len(pts)], sides=4, row='bone', tone=0.84, tip=len(pts) == 3, cap0=True)


def skull_candle(k, R=0.3, candles=3, glow=1.0):
    """骷髅蜡烛：仰躺的骷髅（同 skull2），头顶和身边插着几根高矮不一的蜡烛，烛身有流下的蜡，顶上一小撮火苗（自发光）。（替换 kh/skull_candle：±0.46 × ±0.52、高约 1.19）"""
    skull2(k, R=R, tilt=1.25)
    spots = [(0.0, 0.05, R * 1.55, 0.62), (R * 1.25, -R * 0.6, 0.0, 0.42), (-R * 1.2, -R * 0.4, 0.0, 0.32), (R * 0.7, R * 1.0, 0.0, 0.26)]
    for i in range(candles):
        cx, cy, z0, hh = spots[i]
        hh *= k.r(0.9, 1.1)
        r = 0.05 + 0.012 * (i == 0)
        k.tube([(cx, cy, z0 - 0.02), (cx, cy, z0 + hh)], [r, r * 0.92], sides=6, row='bone', tone=0.9, tip=False, cap0=True)
        # 流蜡：烛身侧面两三道往下的细条 + 脚下一小摊
        for j in range(2):
            a = k.r(0, TAU)
            L = hh * k.r(0.25, 0.5)
            k.box((0.022, 0.022, L), k.place((cx + math.cos(a) * r, cy + math.sin(a) * r, z0 + hh - L / 2 - 0.01)), row='bone', tone=0.98, jitter=0.02, dust=0)
        k.hull([(cx + math.cos(TAU * j / 7) * r * k.r(1.4, 1.9), cy + math.sin(TAU * j / 7) * r * k.r(1.4, 1.9), z0 + k.r(0.0, 0.012)) for j in range(7)] + [(cx, cy, z0 + 0.03)], row='bone', tone=0.95, jitter=0.03, dust=0)
        # 烛芯 + 火苗（小尖锥，自发光）
        top = z0 + hh
        k.hull([(cx + math.cos(TAU * j / 5) * 0.028, cy + math.sin(TAU * j / 5) * 0.028, top + 0.02) for j in range(5)] + [(cx, cy, top + 0.13)], row='ember', tone=0.95, jitter=0.03, glow=glow, dust=0)


def crypt(k, W=6.0, D=8.0, H=8.0, glow=0.55):
    """玄武岩墓室：两级倒角的台基，墙体正面开一道暗的门洞（门框内沿透余烬），阶梯状的顶收成一个尖，正面门楣上一道余烬螺旋。（替换 kh/crypt：±3 × ±4、高 8）"""
    from mathutils import Vector
    k.box((W, D, 0.5), k.place((0, 0, 0.2)), row='stone', tone=0.36, jitter=0.06, bevel=0.06)
    k.box((W * 0.9, D * 0.9, 0.4), k.place((0, 0, 0.62)), row='stone', tone=0.42, jitter=0.06, bevel=0.05)
    wh = H * 0.48
    k.box((W * 0.78, D * 0.78, wh), k.place((0, 0, 0.8 + wh / 2)), row='stone', tone=0.4, jitter=0.08, bevel=0.06)
    # 正面（-y）的门洞：暗的凹板 + 两侧和上沿的余烬窄条
    fy = -D * 0.39
    dw, dh = W * 0.3, wh * 0.68
    k.box((dw, 0.14, dh), k.place((0, fy - 0.03, 0.8 + dh / 2)), row='slag', tone=0.0, jitter=0.0, dust=0)
    for sx in (-1, 1):
        k.box((0.09, 0.12, dh), k.place((sx * (dw / 2 + 0.05), fy - 0.07, 0.8 + dh / 2)), row='ember', tone=0.7, jitter=0.04, glow=glow, dust=0)
    k.box((dw + 0.2, 0.12, 0.09), k.place((0, fy - 0.07, 0.8 + dh + 0.05)), row='ember', tone=0.7, jitter=0.04, glow=glow, dust=0)
    # 门两边的方柱
    for sx in (-1, 1):
        k.box((0.6, 0.6, wh + 0.3), k.place((sx * W * 0.39, fy - 0.1, 0.8 + (wh + 0.3) / 2)), row='stone', tone=0.5, jitter=0.06, bevel=0.04)
    # 阶梯顶 + 尖
    z = 0.8 + wh
    for i, f in enumerate((0.84, 0.66, 0.48)):
        th = H * 0.08
        k.box((W * f, D * f, th), k.place((0, 0, z + th / 2)), row='stone', tone=0.46 + 0.04 * i, jitter=0.08, bevel=0.04)
        z += th
    k.hull([(sx * W * 0.2, sy * D * 0.2, z) for sx in (-1, 1) for sy in (-1, 1)] + [(0, 0, H)], row='stone', tone=0.55, jitter=0.08)
    # 门楣上的螺旋
    _spiral(k, Vector((0, fy - 0.02, 0.8 + dh + 0.75)), Vector((1, 0, 0)), Vector((0, 0, 1)), Vector((0, -1, 0)), 0.06, 0.52, turns=1.75, steps=16, rad=0.05, glow=glow)
    # 台基边几块碎石
    for i in range(4):
        a = TAU * (i + k.r(0, 0.6)) / 4
        k.hull([(math.cos(a) * W * 0.52 + p[0], math.sin(a) * D * 0.52 + p[1], max(-0.05, p[2])) for p in _blob(k, 0.35, 0.3, 0.25, 7)], row='stone', tone=0.34)


# ================================================================ 雷鸣遗迹（第 2 区）
# 形状语言：风蚀的砌石、参差的断口、叉状的雷纹（黄铜）。墙段和柱子是「单位尺寸」的件（游戏里按每段的长 / 高 / 厚非等比缩放，
# 和原来程序化的 gfx/wall、gfx/pillar 同样的用法）；雷枢照原来的尺寸逐项对齐（玩法件，轮廓不能变）。
def storm_wall(k, courses=3, per=2, gap=0.012):
    """墙段（单位尺寸：长 x ±0.5、厚 y ±0.5、高 z 0–1；导出后游戏里是 x 长、z 厚、y 高）：勒脚 + 三层错缝的方石（石缝露出里面暗的墙芯）+ 风蚀参差的压檐。
    游戏里按 (段长 ≈ 2.2 m, 段高 ≈ 2.2 m, 墙厚 0.8 m) 缩放，所以石块在单位空间里是扁的。（替换程序化的 gfx/wall：勒脚 1.03×0.1×1.08、压檐 1.04×0.12×1.14）"""
    # 墙芯（暗，只在石缝里看得见）
    k.box((0.98, 0.9, 0.76), k.place((0, 0, 0.48)), row='slag', tone=0.15, jitter=0.02, dust=0)
    # 勒脚
    k.box((1.03, 1.08, 0.1), k.place((0, 0, 0.05)), row='pale', tone=0.32, jitter=0.06)
    # 方石：每层 per 块，错缝；块与块之间留 gap 的缝
    z0, ch = 0.1, 0.78 / courses
    for r in range(courses):
        off = (0.5 / per) if r % 2 else 0.0
        xs = [-0.5 + off + i / per for i in range(per + 1)]
        edges = sorted(set([max(-0.5, min(0.5, x)) for x in xs] + [-0.5, 0.5]))
        for i in range(len(edges) - 1):
            a, b = edges[i], edges[i + 1]
            if b - a < 0.08:
                continue
            w = b - a - gap
            depth = 1.0 - k.r(0.0, 0.04)
            m = k.place(((a + b) / 2, k.r(-0.01, 0.01), z0 + ch / 2), (0, k.r(-0.01, 0.01), 0))
            vs = k.box((w, depth, ch - gap * 2.2), m, row='pale', tone=0.5 + k.r(-0.1, 0.1), jitter=0.08)
            k.jitter(vs, 0.006)
        z0 += ch
    # 压檐：顶面风蚀参差（顶上的四个角往下压一点，不倒角：一段墙一个区要摆几百段，三角形省着用）
    cv = k.box((1.04, 1.14, 0.12), k.place((0, 0, 0.94)), row='pale', tone=0.7, jitter=0.06)
    for v in cv:
        if v.co.z > 0.95:
            v.co.z -= k.r(0.0, 0.05)


def storm_column(k, flutes=12):
    """柱子（单位尺寸：半径方向 r = 1、高 y 0–1）：两级的八边形柱础 + 带凹槽的柱身（微收分）+ 柱头，柱身中段崩掉一块。
    游戏里按 (r, h, r) 缩放。（替换程序化的 gfx/pillar：柱础 r 1.22–1.3、柱身 r 0.92–1.0、柱头 r 1.18–1.0）"""
    k.tube([(0, 0, 0.0), (0, 0, 0.045)], [1.3, 1.28], sides=8, row='pale', tone=0.34, tip=False, cap0=True)
    k.tube([(0, 0, 0.045), (0, 0, 0.075)], [1.18, 1.12], sides=8, row='pale', tone=0.4, tip=False, cap0=False)
    # 柱身：凹槽 = 顶点半径一大一小交替
    n = flutes * 2
    rings = []
    bm = k.bm
    from mathutils import Vector
    for zi, (z, rr) in enumerate(((0.075, 1.0), (0.5, 0.97), (0.92, 0.93))):
        ring = []
        for i in range(n):
            a = TAU * i / n
            r = rr * (1.0 if i % 2 == 0 else 0.9)
            ring.append(bm.verts.new(Vector((math.cos(a) * r, math.sin(a) * r, z))))
        rings.append(ring)
    fs = []
    for zi in range(2):
        A, B = rings[zi], rings[zi + 1]
        for i in range(n):
            fs.append(bm.faces.new((A[i], A[(i + 1) % n], B[(i + 1) % n], B[i])))
    k.tag(fs, 'pale', 0.55, 0.08)
    # 崩口：柱身中段一块凹进去的暗面（往里推几个顶点）
    a0 = k.r(0, TAU)
    for v in rings[1]:
        a = math.atan2(v.co.y, v.co.x)
        d = abs(((a - a0 + math.pi) % TAU) - math.pi)
        if d < 0.5:
            v.co.x *= 0.82
            v.co.y *= 0.82
    # 柱头
    k.tube([(0, 0, 0.92), (0, 0, 1.0)], [1.0, 1.18], sides=8, row='pale', tone=0.72, tip=False, cap0=True)


def _ring(k, R, r, z, n=10, s=4, row='brass', tone=0.6, glow=0):
    """水平的圆环（线圈）：沿半径 R 的圆走一圈的管子，截面 s 边、半径 r"""
    pts = [(math.cos(TAU * i / n) * R, math.sin(TAU * i / n) * R, z) for i in range(n + 1)]
    vs, segs = k.tube(pts, [r] * len(pts), sides=s, row=row, tone=tone, jitter=0.04, tip=False, cap0=False, cap1=False)
    if glow:
        k.tag([f for sg in segs for f in sg], row, tone, 0.04, glow=glow, dust=0)
    return vs


def pylon(k, glow=0.0):
    """雷枢：倒角石座 + 微收分的八棱立柱 + 三道黄铜线圈 + 黄铜尖帽，柱身上一道往下分叉的黄铜雷纹。
    尺寸逐项照原来程序化的 storm/pylon（玩法件，轮廓不能变）：座 1.15 × 0.5 × 1.15，柱 0.4–2.8 m、半径 0.44 → 0.36，
    线圈在 1.25 / 1.75 / 2.25 m、半径 0.46 / 0.42 / 0.38、粗 0.07，帽 2.8–3.3 m、底半径 0.42。顶上的发光晶体仍是游戏里另一个网格"""
    k.box((1.15, 1.15, 0.5), k.place((0, 0, 0.25)), row='stone', tone=0.3, jitter=0.06, bevel=0.05)
    k.box((0.98, 0.98, 0.06), k.place((0, 0, 0.53)), row='stone', tone=0.45, jitter=0.04)
    k.tube([(0, 0, 0.4), (0, 0, 1.6), (0, 0, 2.8)], [0.44, 0.40, 0.36], sides=8, row='iron', tone=0.42, tip=False, cap0=False, cap1=True)
    for z, R in ((1.25, 0.46), (1.75, 0.42), (2.25, 0.38)):
        _ring(k, R, 0.07, z, n=10, s=4, row='brass', tone=0.66)
    k.tube([(0, 0, 2.8), (0, 0, 3.3)], [0.42, 0.0], sides=8, row='brass', tone=0.52, tip=True, cap0=True)
    # 雷纹：柱身朝外一侧一道折线（贴在柱面外 0.01），在中段分一个叉
    a = k.r(0, TAU)
    def on(z, da, rr):
        rad = (0.44 - 0.08 * (z - 0.4) / 2.4) + 0.012
        return (math.cos(a + da) * rad, math.sin(a + da) * rad, z)
    main = [on(2.62, 0.0, 1), on(2.38, 0.18, 1), on(2.06, -0.08, 1), on(1.92, 0.16, 1), on(1.5, -0.1, 1), on(1.0, 0.12, 1), on(0.6, 0.0, 1)]
    k.tube(main, [0.028] * len(main), sides=3, row='brass', tone=0.92, tip=False, cap0=True)
    fork = [on(2.06, -0.08, 1), on(1.8, -0.34, 1), on(1.55, -0.3, 1)]
    k.tube(fork, [0.022, 0.02, 0.0], sides=3, row='brass', tone=0.92, tip=True, cap0=True)


def storm_lantern(k, h=0.925, r=0.32, glow=0.9):
    """路边立灯：十字底脚上一根细铁杆，顶上方灯笼（四根角柱 + 叉状的铁条格栅），中间一颗发光的灯芯，四坡小顶。
    灯芯在 0.62 的高度（游戏的火焰精灵按摆放表 h = 0.62 放在那里）。（替换 kh/lantern_standing：±0.32、高约 0.93）"""
    for i in range(2):
        a = i * math.pi / 2 + k.r(-0.05, 0.05)
        k.box((r * 1.9, 0.07, 0.05), k.place((0, 0, 0.025), (0, 0, a)), row='iron', tone=0.4, jitter=0.05)
    k.box((0.11, 0.11, 0.06), k.place((0, 0, 0.06)), row='iron', tone=0.45, jitter=0.04, bevel=0.012)
    k.tube([(0, 0, 0.06), (0, 0, 0.5)], [0.035, 0.03], sides=6, row='iron', tone=0.5, tip=False, cap0=False)
    # 灯笼：底板、四根角柱、顶板
    w, zb, zt = 0.15, 0.5, 0.76
    k.box((w * 2.3, w * 2.3, 0.035), k.place((0, 0, zb)), row='iron', tone=0.45, jitter=0.04)
    for sx in (-1, 1):
        for sy in (-1, 1):
            k.box((0.03, 0.03, zt - zb), k.place((sx * w, sy * w, (zb + zt) / 2)), row='iron', tone=0.52, jitter=0.04)
    # 叉状格栅：每面一道竖条，中间分叉（雷纹）
    for f in range(4):
        a = f * math.pi / 2
        cx, cy = math.cos(a) * w, math.sin(a) * w
        tx, ty = -math.sin(a), math.cos(a)
        pts = [(cx, cy, zt - 0.02), (cx + tx * 0.03, cy + ty * 0.03, 0.66), (cx - tx * 0.02, cy - ty * 0.02, 0.6), (cx, cy, zb + 0.02)]
        k.tube(pts, [0.009] * 4, sides=3, row='brass', tone=0.75, tip=False, cap0=True)
    # 灯芯（发光）
    k.hull([(p[0], p[1], 0.62 + p[2]) for p in _blob(k, 0.06, 0.06, 0.07, 8)], row='brass', tone=0.97, jitter=0.03, glow=glow, dust=0)
    # 四坡顶 + 顶上的小环
    k.hull([(sx * w * 1.25, sy * w * 1.25, zt) for sx in (-1, 1) for sy in (-1, 1)] + [(0, 0, h - 0.05)], row='iron', tone=0.38, jitter=0.05)
    _ring(k, 0.03, 0.01, h - 0.03, n=6, s=3, row='iron', tone=0.5)


# ================================================================ 霜骨沼泽（第 1 区）
# 形状语言：硬朗的冰晶切面、冷的蓝灰；巨兽的骨头半埋在冰里。游戏里这一区的布景多半是程序化拼的（栈道、骨架、岸边），
# 这里的件换掉其中的几何体：巨兽头骨（合并进骨架网格）、冰芦苇、远处的冰棱簇（布景材质）、栈道木板（单位尺寸）。
def _ell_pts(k, cx, cy, cz, sx, sy, sz, n=36, taper=0.0, jit=0.04):
    """椭球面上的点（Blender 坐标，z 朝上）；taper > 0 时越往 -y（朝前）越窄、越往下压（做吻部）"""
    pts = []
    for i in range(n):
        u = (i + 0.5) / n
        z = 1 - 2 * u
        r = math.sqrt(max(0.0, 1 - z * z))
        a = math.pi * (3 - math.sqrt(5)) * i
        x, y = math.cos(a) * r, math.sin(a) * r
        f = max(0.0, -y) * taper
        x *= 1 - 0.45 * f
        z = z * (1 - 0.35 * f) - 0.25 * f * f
        pts.append((cx + x * sx * (1 + k.r(-jit, jit)), cy + y * sy, cz + z * sz * (1 + k.r(-jit, jit))))
    return pts


def frost_skull(k, ice=6):
    """巨兽头骨（半埋在冰湖里的地标）：圆的颅顶、往前收窄下压的长吻、额前一道眉骨、两侧颧骨、暗的眼窝和鼻孔、微张的下颌和一排朝下的尖牙、
    吻侧两根往前下方伸的獠牙、颅顶两侧往后上方的角，颅顶和角根结着几簇硬朗的冰晶。
    局部坐标照原来程序化的头骨组（游戏里 +z 朝前 = 这里的 -y；长约 4.7 m、宽约 3 m、高约 3.5 m，含角），整组替换，碰撞（WALL 圆）不变"""
    Y = lambda gz: -gz  # 游戏的 +z（朝前）= Blender 的 -y
    k.hull(_ell_pts(k, 0, Y(-0.7), 1.55, 1.45, 1.4, 1.2, n=40), row='bone', tone=0.72, jitter=0.06)  # 颅顶
    k.hull(_ell_pts(k, 0, Y(0.75), 1.05, 1.05, 1.55, 0.72, n=36, taper=1.0), row='bone', tone=0.66, jitter=0.06)  # 长吻
    k.hull(_ell_pts(k, 0, Y(0.34), 1.86, 1.22, 0.42, 0.2, n=20), row='bone', tone=0.8, jitter=0.05)  # 眉骨
    for sg in (-1, 1):
        k.hull(_ell_pts(k, sg * 1.02, Y(0.05), 1.12, 0.42, 0.75, 0.34, n=16), row='bone', tone=0.7, jitter=0.05)  # 颧骨
    k.hull(_ell_pts(k, 0, Y(0.55), 0.38, 0.88, 1.35, 0.26, n=24, taper=0.8), row='bone', tone=0.6, jitter=0.05)  # 下颌（微张）
    for i in range(8):
        t = (i / 7) * 2 - 1
        x, gz = t * 0.6 * (1 - 0.2 * t * t), 1.4 + 0.55 * (1 - t * t)
        k.hull([(x + 0.07 * math.cos(TAU * j / 4), Y(gz) + 0.07 * math.sin(TAU * j / 4), 0.72) for j in range(4)] + [(x, Y(gz), 0.32)], row='bone', tone=0.9, jitter=0.03, dust=0)  # 尖牙
    for sg in (-1, 1):
        k.hull(_ell_pts(k, sg * 0.6, Y(0.72), 1.6, 0.34, 0.22, 0.28, n=10), row='slag', tone=0.0, jitter=0.0, dust=0)  # 眼窝（暗）
        k.hull(_ell_pts(k, sg * 0.2, Y(2.22), 1.08, 0.11, 0.08, 0.1, n=8), row='slag', tone=0.0, jitter=0.0, dust=0)  # 鼻孔
        k.tube([(sg * 0.62, Y(1.75), 0.75), (sg * 0.7, Y(2.25), 0.38), (sg * 0.66, Y(2.55), -0.02)], [0.16, 0.12, 0.0], sides=5, row='bone', tone=0.86, tip=True, cap0=True)  # 獠牙
        k.tube([(sg * 1.1, Y(-1.0), 2.1), (sg * 1.55, Y(-1.5), 2.75), (sg * 1.75, Y(-2.1), 3.45)], [0.3, 0.2, 0.0], sides=6, row='bone', tone=0.62, tip=True, cap0=True)  # 角
    # 冰晶簇：颅顶和角根上几根硬朗的冰棱（不发光）
    for i in range(ice):
        a = k.r(0, TAU)
        cx, cy = math.cos(a) * k.r(0.3, 1.0), Y(-0.7) + math.sin(a) * k.r(0.3, 1.0)
        L, r = k.r(0.35, 0.7), k.r(0.07, 0.12)
        pts = []
        for j in range(5):
            b = TAU * j / 5 + k.r(-0.2, 0.2)
            pts += [(math.cos(b) * r, math.sin(b) * r, 0), (math.cos(b) * r * 0.8, math.sin(b) * r * 0.8, L * 0.75)]
        pts.append((0, 0, L))
        vs = k.hull(pts, row='starglass', tone=k.r(0.12, 0.28), jitter=0.06, dust=0)  # 暗一点的冷青（不抢眼）
        k.xform(vs, k.place((cx, cy, 2.45 + k.r(-0.1, 0.1)), (k.r(-0.5, 0.5), k.r(-0.5, 0.5), k.r(0, TAU))))


def frost_reeds(k, blades=7):
    """冰芦苇：一丛往外散的细叶（三棱、渐细、略弯），两根穗头，叶尖结一层霜（灰白）。（替换程序化的 frost/reeds：高约 1.3 m）"""
    for i in range(blades):
        a = TAU * i / blades + k.r(-0.3, 0.3)
        h = k.r(0.75, 1.25)
        lean = k.r(0.12, 0.3)
        p0 = (math.cos(a) * 0.04, math.sin(a) * 0.04, -0.02)
        p1 = (math.cos(a) * lean * 0.4, math.sin(a) * lean * 0.4, h * 0.55)
        p2 = (math.cos(a) * lean, math.sin(a) * lean, h)
        vs, segs = k.tube([p0, p1, p2], [0.035, 0.024, 0.0], sides=3, row='lichen', tone=0.35, tip=True, cap0=False)
        k.tag(segs[-1], 'pale', 0.75, 0.08)  # 叶尖的霜
    for i in range(2):
        a = k.r(0, TAU)
        h = k.r(1.05, 1.3)
        x, y = math.cos(a) * 0.08, math.sin(a) * 0.08
        k.tube([(x * 0.3, y * 0.3, 0), (x, y, h)], [0.016, 0.014], sides=3, row='lichen', tone=0.3, tip=False, cap0=False)
        hv, hs = k.tube([(x, y, h), (x * 1.05, y * 1.05, h + 0.24)], [0.05, 0.04], sides=5, row='wood', tone=0.55, tip=False, cap0=True)
        k.tag(hs[-1][-1:], 'pale', 0.8, 0.05)  # 穗头顶上的霜


def frost_spire(k):
    """远处的冰棱簇：四五根硬朗切面的冰晶柱（五棱、尖顶，往外斜），脚下几块压着的碎石。（替换程序化的 prop/frost：高约 3.2 m）"""
    spec = [(0.5, 3.2, 0.0, 0.0, 0.0), (0.34, 2.1, 0.55, 0.2, -0.38), (0.3, 1.7, -0.5, -0.1, 0.42), (0.22, 1.2, 0.1, 0.55, 0.5), (0.18, 0.9, -0.25, -0.5, -0.35)]
    for i, (r, h, x, y, tilt) in enumerate(spec):
        pts = []
        for j in range(5):
            b = TAU * j / 5 + k.r(-0.15, 0.15)
            rr = r * k.r(0.85, 1.05)
            pts += [(math.cos(b) * rr, math.sin(b) * rr, -0.1), (math.cos(b) * rr * 0.86, math.sin(b) * rr * 0.86, h * 0.78)]
        pts.append((k.r(-0.05, 0.05) * r, k.r(-0.05, 0.05) * r, h))
        # 大的两根是霜白的冰（灰白石色带上端），小的是暗一点的冷青：整簇偏冷的灰白，不是一片饱和的青
        vs = k.hull(pts, row='pale' if i < 2 else 'starglass', tone=(0.5 + 0.08 * i) if i < 2 else 0.16 + 0.05 * (i % 2), jitter=0.06, dust=0)
        k.xform(vs, k.place((x, y, 0), (k.r(-0.1, 0.1), tilt * 0.6, k.r(0, TAU))))
    for i in range(3):
        a = k.r(0, TAU)
        k.hull([(math.cos(a) * 0.55 + p[0], math.sin(a) * 0.55 + p[1], max(-0.05, p[2])) for p in _blob(k, 0.22, 0.18, 0.14, 7)], row='stone', tone=0.35)


def frost_plank(k, bevel=0.06):
    """栈道的板 / 桩 / 绳 / 冰板共用的单位块（x ±0.5、y ±0.5、z 0–1）：倒一刀的方块，两端磨圆一点。游戏里按每块非等比缩放，颜色是实例色（顶点色接近白，只带一点烘焙的明暗）"""
    vs = k.box((1.0, 1.0, 1.0), k.place((0, 0, 0.5)), row='pale', tone=0.95, jitter=0.02, bevel=bevel, dust=0)
    k.jitter(vs, 0.008)
# ================================================================ 余烛殿（顶层的熄烛者场地）
# 形状语言：烛、蜡、仪式。场地里只有 4 个火盆台（玩法件：亮 / 灭决定安全圈），轮廓、尺寸照原来的程序化 crown/brazier，火苗仍是游戏里另一个网格。
def crown_brazier(k, candles=5):
    """火盆台：三级八边形石座（底 r 1.0–1.08、高 0.22；中 r 0.86–0.92、高 0.2）、带一道刻环的石柱（r 0.66 → 0.56，0.42–1.32 m）、
    外撇的铁盆（1.30–1.66 m，口 r 0.82）口沿一圈铜箍、盆里一床炭；石座的两级台面上立着一圈高矮不一的蜡烛，烛身流蜡、台面上积着蜡。
    火苗放在 1.62 m（游戏里的火焰网格），尺寸逐项照原来的 crown/brazier，碰撞（WALL r 0.9）不变"""
    k.tube([(0, 0, 0.0), (0, 0, 0.22)], [1.08, 1.0], sides=8, row='slag', tone=0.3, tip=False, cap0=True)
    k.tube([(0, 0, 0.22), (0, 0, 0.42)], [0.92, 0.86], sides=8, row='stone', tone=0.42, tip=False, cap0=False)
    k.tube([(0, 0, 0.42), (0, 0, 0.86), (0, 0, 1.32)], [0.66, 0.61, 0.56], sides=8, row='stone', tone=0.5, tip=False, cap0=False)
    k.tube([(0, 0, 0.84), (0, 0, 0.9)], [0.66, 0.66], sides=8, row='brass', tone=0.55, tip=False, cap0=False, cap1=False)  # 柱身的刻环（铜）
    # 铁盆：外壁（外撇）+ 内壁，盆底封口
    k.tube([(0, 0, 1.3), (0, 0, 1.66)], [0.5, 0.82], sides=10, row='iron', tone=0.35, tip=False, cap0=True, cap1=False)
    k.tube([(0, 0, 1.655), (0, 0, 1.5)], [0.76, 0.48], sides=10, row='iron', tone=0.22, tip=False, cap0=False, cap1=True)
    _ring(k, 0.8, 0.06, 1.66, n=12, s=4, row='brass', tone=0.7)  # 铜箍
    _coals(k, 0, 0, 1.52, 0.6, n=7, size=0.15)  # 盆里的炭（朝上的面发光；火盆灭的时候也只是暗红的余烬）
    # 蜡烛：两级台面上一圈，高矮不一，烛身流蜡，脚下一小摊蜡
    for i in range(candles):
        a = TAU * (i + k.r(-0.2, 0.2)) / candles
        on_top = i % 2 == 0
        rr = (0.75 if on_top else 0.97) + k.r(-0.04, 0.04)
        z0 = 0.42 if on_top else 0.22
        h = k.r(0.3, 0.5) if on_top else k.r(0.2, 0.32)
        x, y = math.cos(a) * rr, math.sin(a) * rr
        r = k.r(0.06, 0.08)
        k.tube([(x, y, z0 - 0.01), (x, y, z0 + h)], [r, r * 0.92], sides=6, row='bone', tone=0.9, tip=False, cap0=False)
        k.box((0.025, 0.025, h * 0.5), k.place((x + math.cos(a + 1.2) * r, y + math.sin(a + 1.2) * r, z0 + h * 0.55)), row='bone', tone=0.98, jitter=0.02, dust=0)
        k.hull([(x + math.cos(TAU * j / 6) * r * 1.8, y + math.sin(TAU * j / 6) * r * 1.8, z0 + 0.004) for j in range(6)] + [(x, y, z0 + 0.02)], row='bone', tone=0.95, jitter=0.03, dust=0)
        k.hull([(x + math.cos(TAU * j / 4) * 0.022, y + math.sin(TAU * j / 4) * 0.022, z0 + h) for j in range(4)] + [(x, y, z0 + h + 0.09)], row='ember', tone=0.95, jitter=0.02, glow=1.0, dust=0)  # 烛火（小尖，发光）


# ================================================================ 手持武器（class-d2b1）
# 坐标约定（游戏端 world.js 的 lanternGeo 按这个换算到右手的武器关节上）：Blender 的 +z 是握杆的方向（握把在原点、杆朝 +z），
# -y 是钩伸出去的方向（游戏里朝前）。原点在握把底端。
def hand_lantern(k, tier=0):
    """提灯（掌灯人的武器）：一根短铁杆（握把缠皮、几道铁箍），杆头弯成一个朝前（-y）的钩；钩下垂直挂一盏六角铜框提灯——
    提环、六棱尖帽、上下两圈框、六根黄铜角柱、琥珀色的琉璃灯罩（凸包），罩里一小团火苗（发光），底下一块托板。
    tier = 2（第三阶 / 长明）：灯框上斜缠几节骨饰，灯罩发暗红，帽尖多一枚骨钉。
    坐标：Blender 的 +z 沿握杆（游戏里主角竖着提杆，灯在杆头前面往下挂），-y 是钩伸出去的方向，原点在握把底端。"""
    # 握把 + 杆 + 杆头
    k.tube([(0, 0, 0.0), (0, 0, 0.15)], [0.024, 0.022], sides=6, row='char', tone=0.32, jitter=0.04, tip=False, cap0=True)
    for i in range(3):
        _ring_y(k, 0.026, 0.006, 0.03 + i * 0.045, row='iron', tone=0.38)
    k.tube([(0, 0, 0.15), (0, 0, 0.56)], [0.016, 0.014], sides=6, row='iron', tone=0.46, jitter=0.04, tip=False, cap0=False)
    # 钩：从杆头朝前（-y）弯出去再往下
    hook = [(0, 0, 0.555), (0, -0.015, 0.61), (0, -0.05, 0.635), (0, -0.09, 0.62), (0, -0.11, 0.585)]
    k.tube(hook, [0.014, 0.012, 0.011, 0.01, 0.009], sides=5, row='iron', tone=0.5, jitter=0.03, tip=False, cap0=False)
    # 灯：轴线竖直，挂在钩下（中心 y = -0.11，z 从 0.55 往下到 0.37）
    cy, R = -0.11, 0.056
    z_top, z_bot = 0.545, 0.37
    def hx(i, r, z):
        a = TAU * i / 6 + math.pi / 6
        return (math.cos(a) * r, cy + math.sin(a) * r, z)
    # 提环 + 尖帽（六棱锥）
    _ring_xz(k, 0.016, 0.005, cy, z_top + 0.03, row='brass', tone=0.6)
    k.hull([hx(i, R * 1.18, z_top) for i in range(6)] + [(0, cy, z_top + 0.035)], row='brass', tone=0.5, jitter=0.03)
    # 上下两圈框
    for z in (z_top, z_bot):
        k.hull([hx(i, R * 1.12, z + dz) for i in range(6) for dz in (-0.009, 0.009)], row='brass', tone=0.44 if z == z_bot else 0.6, jitter=0.03)
    # 六根角柱
    for i in range(6):
        a, b = hx(i, R * 1.05, z_top), hx(i, R * 1.05, z_bot)
        k.tube([a, b], [0.0065, 0.0065], sides=4, row='brass', tone=0.66, jitter=0.03, tip=False, cap0=False, cap1=False)
    # 琉璃灯罩（第三阶暗红），罩里的火苗（发光）
    gl_tone = 0.34 if tier >= 2 else 0.86
    k.hull([hx(i, R * 0.92, z) for i in range(6) for z in (z_top - 0.006, z_bot + 0.006)], row='ember', tone=gl_tone, jitter=0.02, glow=0.35 if tier >= 2 else 0.5, dust=0)
    fz = (z_top + z_bot) / 2 - 0.01
    k.hull([(p[0], cy + p[1], fz + p[2] * 1.4) for p in _blob(k, 0.018, 0.018, 0.026, 7)], row='ember', tone=0.98, jitter=0.0, glow=1.0, dust=0)
    # 托板
    k.hull([hx(i, R * 0.9, z_bot - 0.012) for i in range(6)] + [(0, cy, z_bot - 0.03)], row='brass', tone=0.38, jitter=0.03)
    if tier >= 2:
        # 骨饰：斜缠在三根角柱上的骨节，帽尖一枚骨钉
        for i in (0, 2, 4):
            a, b = hx(i, R * 1.2, z_top - 0.03), hx(i + 1, R * 1.2, z_bot + 0.02)
            m = ((a[0] + b[0]) / 2 * 1.08, cy + ((a[1] + b[1]) / 2 - cy) * 1.08, (a[2] + b[2]) / 2)
            k.tube([a, m, b], [0.007, 0.009, 0.006], sides=4, row='bone', tone=0.7, jitter=0.05, tip=True, cap0=True)
        k.tube([(0, cy, z_top + 0.03), (0, cy, z_top + 0.075)], [0.008, 0.0], sides=4, row='bone', tone=0.78, jitter=0.03, tip=True, cap0=True)


def _ring_y(k, R, r, z, n=8, s=3, row='iron', tone=0.5):
    """绕 z 轴的小圆环（握把上的箍）"""
    pts = [(math.cos(TAU * i / n) * R, math.sin(TAU * i / n) * R, z) for i in range(n + 1)]
    k.tube(pts, [r] * len(pts), sides=s, row=row, tone=tone, jitter=0.03, tip=False, cap0=False, cap1=False)


def _ring_xz(k, R, r, y, cz, n=8, s=3, row='brass', tone=0.6):
    """竖着的小圆环（提灯顶上的提环，环面在 x-z 平面上，中心 (0, y, cz)）"""
    pts = [(math.cos(TAU * i / n) * R, y, cz + math.sin(TAU * i / n) * R) for i in range(n + 1)]
    k.tube(pts, [r] * len(pts), sides=s, row=row, tone=tone, jitter=0.03, tip=False, cap0=False, cap1=False)


def field_mine(k, claws=4):
    """绊雷（imbue 批，用户：「雷的建模有点粗糙」）：低矮的暗铁圆盘，腰上一道夹箍，claws 只折叠的尖爪从盘沿往外伸、爪尖往下扎进地里，
    盘顶中间凹进去一个小灯窝（琥珀小灯是游戏里每帧画的亮点，上膛前暗、上膛时闪一下，模型里只留暗色的窝）。
    坐标：+z 朝上，原点在盘底中心；盘半径约 0.17 米、高约 0.07 米，爪尖伸到约 0.3 米。"""
    n = 12
    def ring(r, z):
        return [(math.cos(TAU * i / n) * r, math.sin(TAU * i / n) * r, z) for i in range(n)]
    # 盘身：下宽上窄的扁圆台，顶上一圈斜面
    k.hull(ring(0.17, 0.0) + ring(0.165, 0.035) + ring(0.13, 0.055), row='iron', tone=0.2, jitter=0.02)
    k.hull(ring(0.12, 0.05) + ring(0.085, 0.068), row='iron', tone=0.3, jitter=0.02)
    # 灯窝：顶上中间一个暗色的小凹窝（比顶面低一点，四周一圈稍亮的边）
    k.hull(ring(0.036, 0.066) + ring(0.028, 0.072), row='iron', tone=0.42, jitter=0.0)
    k.hull(ring(0.024, 0.058) + ring(0.022, 0.071), row='char', tone=0.05, jitter=0.0, dust=0)
    # 夹箍：盘腰一道细箍，箍上 claws 个铰座
    _ring_y(k, 0.172, 0.009, 0.024, n=14, s=3, row='iron', tone=0.75)
    for i in range(claws):
        a = TAU * (i + 0.5) / claws
        c, s = math.cos(a), math.sin(a)
        p = lambda r, z, w=0.0: (c * r - s * w, s * r + c * w, z)
        # 铰座：盘沿外一个小方块
        k.hull([p(0.16, 0.012, -0.018), p(0.16, 0.012, 0.018), p(0.16, 0.042, -0.018), p(0.16, 0.042, 0.018),
                p(0.185, 0.016, -0.014), p(0.185, 0.016, 0.014), p(0.185, 0.04, -0.014), p(0.185, 0.04, 0.014)], row='iron', tone=0.36, jitter=0.02)
        # 爪：从铰座往外上方折出去（膝弯拱起），再往下弯成尖扎到地面。粗一点、比盘身亮两档，游戏镜头下才认得出爪子（imbue 批复审）
        k.tube([p(0.17, 0.03), p(0.235, 0.085), p(0.3, 0.075), p(0.345, 0.03), p(0.36, 0.004)], [0.022, 0.02, 0.017, 0.011, 0.0], sides=5, row='iron', tone=0.72, jitter=0.03, tip=True, cap0=True)
        # 爪背一道亮棱（受光的那一面）
        k.tube([p(0.2, 0.07, 0.0), p(0.29, 0.096, 0.0)], [0.008, 0.007], sides=3, row='iron', tone=0.9, jitter=0.0, tip=False, cap0=False, cap1=False)
