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


def arch(k, span=3.2, h=4.0, r=0.36):
    """拱门：两根方柱 + 半圆拱的楔石（一块楔石缺失、一侧拱脚开裂）"""
    for sx in (-1, 1):
        k.box((r * 2.3, r * 2.3, 0.4), k.place((sx * span / 2, 0, 0.15)), row='stone', tone=0.4, bevel=0.04)
        k.box((r * 1.7, r * 1.7, h - 0.35), k.place((sx * span / 2, 0, 0.35 + (h - 0.35) / 2 - 0.02)), row='stone', tone=0.52, bevel=0.03)
    n = 9
    rad = span / 2
    miss = int(k.r(2, n - 2))
    for i in range(n):
        if i == miss:
            continue
        a = math.pi * (i + 0.5) / n
        cx, cz = math.cos(a) * rad, h + math.sin(a) * rad * 0.9
        m = k.place((cx, 0, cz), (0, -(math.pi / 2 - a), 0))
        k.box((0.34, r * 1.6, 0.62), m, row='stone', tone=0.55, jitter=0.12, bevel=0.025)


# ---------------------------------------------------------------- 火：火坑 / 火盆
def firepit(k, r=0.29, stones=9, h=0.075):
    """火坑：一圈压扁的石块 + 交叉的焦木 + 中间发光的余烬床（替换 kn/campfire_stones 的尺度，游戏里放大 3.2 倍）"""
    for i in range(stones):
        a = TAU * i / stones + k.r(-0.12, 0.12)
        cx, cy = math.cos(a) * r * 0.82, math.sin(a) * r * 0.82
        s = r * k.r(0.17, 0.24)
        pts = [(cx + p[0], cy + p[1], max(-0.01, p[2] + h * 0.35)) for p in _blob(k, s * 1.2, s, h * 0.65, 8)]
        k.hull(pts, row='stone', tone=0.95, jitter=0.05)
    for i in range(3):
        a = k.r(0, TAU)
        L = r * 0.62
        p0 = (math.cos(a) * L, math.sin(a) * L, h * 0.25)
        p1 = (-math.cos(a) * L * 0.4, -math.sin(a) * L * 0.4, h * 0.75)
        k.tube([p0, p1], [r * 0.08, r * 0.07], sides=5, row='char', tone=0.4, tip=False, cap0=True)
    bed = [k.bm.verts.new((math.cos(TAU * i / 8) * r * 0.55, math.sin(TAU * i / 8) * r * 0.55, h * 0.12)) for i in range(8)]
    f = k.bm.faces.new(bed)
    k.tag([f], 'ember', 0.85, 0.05, glow=1, dust=0)


def brazier(k, h=1.1, r=0.38):
    """火盆：三足铁架托一个浅碗，碗里是余烬"""
    for i in range(3):
        a = TAU * i / 3 + 0.3
        k.tube([(math.cos(a) * r * 0.95, math.sin(a) * r * 0.95, 0), (math.cos(a) * r * 0.35, math.sin(a) * r * 0.35, h * 0.8)], [0.035, 0.03], sides=4, row='iron', tone=0.5, tip=False)
    # 碗：开口的八棱台（外壁 + 内壁），碗底封口
    k.tube([(0, 0, h * 0.78), (0, 0, h)], [r * 0.35, r], sides=8, row='iron', tone=0.45, tip=False, cap0=True, cap1=False)
    k.tube([(0, 0, h - 0.002), (0, 0, h * 0.86)], [r * 0.96, r * 0.4], sides=8, row='iron', tone=0.3, tip=False, cap0=False, cap1=True)
    bed = [k.bm.verts.new((math.cos(TAU * i / 8) * r * 0.6, math.sin(TAU * i / 8) * r * 0.6, h - 0.03)) for i in range(8)]
    k.tag([k.bm.faces.new(bed)], 'ember', 0.85, 0.05, glow=1, dust=0)


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
    k.tag(faces, 'bone', 0.86, 0.08)
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
    up = k.hull([(sx * 0.46, 0.5, z) for sx in (-1, 1) for z in (0.05, 0.58)] + [(sx * 0.3, 0.5 + 0.95 * sn, z) for sx in (-1, 1) for z in (0.06, 0.36)] + [(0, 1.0, 0.56)], row='bone', tone=0.84)
    top = max(_sorted_faces_of(up), key=lambda f: f.normal.z)
    k.slit(top, width=0.25, depth=0.05, row='char')
    # 下颌：贴地的一块，略微张开
    k.hull([(sx * 0.42, 0.4, z) for sx in (-1, 1) for z in (0.0, 0.1)] + [(sx * 0.26, 0.4 + 0.95 * sn, z) for sx in (-1, 1) for z in (0.0, 0.07)], row='bone', tone=0.72)
    # 牙：上颌前缘两颗朝下的尖牙
    for sx in (-1, 1):
        ty = 0.4 + 0.95 * sn - 0.05
        k.hull([(sx * 0.22 + dx, ty + dy, 0.1) for dx, dy in ((-0.05, -0.04), (0.05, -0.04), (0, 0.05))] + [(sx * 0.22, ty + 0.02, -0.01)], row='bone', tone=0.85, dust=0)
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


def bones(k, n=3, L=0.7):
    """几根交叠的长骨（平放）：五棱骨干 + 两头的骨节"""
    for i in range(n):
        a = k.r(0, math.pi) + i * 1.1
        l = L * k.r(0.6, 1.0)
        cx, cy = k.r(-0.12, 0.12), k.r(-0.12, 0.12)
        dx, dy = math.cos(a) * l / 2, math.sin(a) * l / 2
        z = 0.045 + i * 0.03
        k.tube([(cx - dx, cy - dy, z), (cx, cy, z + 0.01), (cx + dx, cy + dy, z)], [0.035, 0.028, 0.035], sides=5, row='bone', tone=0.86, tip=False, cap0=True)
        for e in (-1, 1):
            ex, ey = cx + e * dx, cy + e * dy
            pts = [(ex + p[0], ey + p[1], max(0.0, z + p[2])) for p in _blob(k, 0.065, 0.065, 0.05, 8)]
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
    vg = k.box((w * 2.4, 0.07, 0.07), k.place((0, 0, -0.17)), row='iron', tone=0.62)
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
    vs = k.hull(pts, row='stone', tone=0.55, jitter=0.1)
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
