# AI 生成的首领外观（ai3d-bosses）：源网格的区域规则（纯 numpy，不依赖 Blender，Blender 里的 boss_rig.py 和试验工具共用）。
# 输入是对好骨架以后的源网格（游戏坐标，米）、每个三角形的反照率（线性 RGB，三角形重心那一点），按候选参数（spec['parts']）把三角形分给骨骼：
#   雷霆监察者（warden）：全刚性。先按连通件分（浮着的零件各是一个连通件），护手 4 只里只留左右两只（live 的设计是两只手），
#     主体里按高度 / 半径 / 颜色分出柱身、头（领环 + 眼匣 + 顶杆）、眼、左右杆、两块护盾板（连着柱身的细撑杆删掉）；
#     护盾板挪到环绕半径上、按 0 / 120 / 240° 摆三块（第三块是第一块的拷贝），环 = 源网格那道 + 往下挪、缩一点的拷贝（x_ring_b）。
#   衔星巨兽（behemoth）：混合蒙皮，规则在 boss_rig.py 的 behemoth_weights（按顶点算权重，不按三角形分）。
# 返回的「摆放」：(源标签, 骨骼, 4×4 变换（游戏坐标）)；同一个源标签可以摆好几次（拷贝），变换是单位阵的那些共用顶点（连着的零件之间不撕开）。
import math

import numpy as np

YW = np.array([0.2126, 0.7152, 0.0722])


def components(F, nv):
    """每个三角形所在的连通件序号（按共用顶点连通；三角形要先焊接）：并查集，按件的三角形数从多到少编号（并列按最小三角形序号）"""
    par = np.arange(nv)

    def find(a):
        r = a
        while par[r] != r:
            r = par[r]
        while par[a] != r:
            par[a], a = r, par[a]
        return r

    for a, b, c in F.tolist():
        ra, rb, rc = find(a), find(b), find(c)
        if rb != ra:
            par[rb] = ra
        if rc != ra and find(rc) != ra:
            par[find(rc)] = ra
    roots = np.array([find(i) for i in range(nv)])
    fr = roots[F[:, 0]]
    u, first, cnt = np.unique(fr, return_index=True, return_counts=True)
    order = sorted(range(len(u)), key=lambda i: (-cnt[i], first[i]))
    rank = np.empty(len(u), dtype=np.int64)
    rank[order] = np.arange(len(u))
    return rank[np.searchsorted(u, fr)]


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    M = np.eye(4)
    M[0, 0], M[0, 2], M[2, 0], M[2, 2] = c, s, -s, c
    return M


def tilt_m(tl):
    """眼匣的错切：z' = z − k·(y − y0)"""
    M = np.eye(4)
    M[2, 1] = -tl['k']
    M[2, 3] = tl['k'] * tl['y0']
    return M


def trans(x, y, z):
    M = np.eye(4)
    M[:3, 3] = (x, y, z)
    return M


def scale_xz(s, cy=0.0):
    M = np.eye(4)
    M[0, 0] = M[2, 2] = s
    return M


def xform(M, P):
    return P @ M[:3, :3].T + M[:3, 3]


# ---------------------------------------------------------------- warden
def warden(G, F, col, spec):
    """G：顶点（游戏坐标，已焊接），F：三角形，col：每个三角形的反照率（线性）。返回 (每个三角形的源标签（'' = 删掉）, 摆放表, 记录)"""
    o = spec['parts']
    comp = components(F, len(G))
    C = G[F].mean(axis=1)
    lum = col @ YW
    n = comp.max() + 1
    lab = np.array([''] * len(F), dtype=object)
    info = []
    for k in range(n):
        m = comp == k
        q = C[m]
        lo, hi = q.min(axis=0), q.max(axis=0)
        ctr = 0.5 * (lo + hi)
        info.append(dict(k=k, faces=int(m.sum()), lo=lo, hi=hi, c=ctr))
    # 件的分类：最大的是主体；最低（贴地）的是底座环；扁、绕着轴的一圈是环；其余是护手（按中心的方位：左右留下，前后删掉）
    main = 0
    base = min(range(n), key=lambda k: (info[k]['lo'][1], k))
    log = dict(components=[dict(k=i['k'], faces=i['faces'], c=[round(float(x), 3) for x in i['c']]) for i in info])
    for i in info:
        k = i['k']
        m = comp == k
        ext = i['hi'] - i['lo']
        if k == main:
            lab[m] = 'main'
        elif k == base:
            lab[m] = 'x_base'
        elif ext[1] < o.get('ring_h', 0.3) and abs(i['c'][0]) < 0.2 and abs(i['c'][2]) < 0.2:
            lab[m] = 'ring'
        else:
            cx, cz = i['c'][0], i['c'][2]
            if abs(cx) > abs(cz):
                lab[m] = 'hand_l' if cx > 0 else 'hand_r'
            else:
                lab[m] = ''  # 前后的护手：不要
    # 主体：柱身 / 撑杆（删）/ 护盾板 / 头 / 眼 / 杆
    mm = lab == 'main'
    x, y, z = C[:, 0], C[:, 1], C[:, 2]
    ax = np.abs(x)
    r = np.hypot(x, z)
    st = o['strut']  # 细撑杆：|x| 在 [r0, r1]、y 在 [y0, y1]、|z| < w
    strut = mm & (ax >= st['r0']) & (ax < st['r1']) & (y >= st['y0']) & (y <= st['y1']) & (np.abs(z) < st['w'])
    sl = o['slab']  # 护盾板：|x| ≥ r0、y < y1、|z| < w
    slab = mm & ~strut & (ax >= sl['r0']) & (y < sl['y1']) & (np.abs(z) < sl['w'])
    hd = o['head']
    head = mm & ~strut & ~slab & (y >= hd['y0'])
    rod = head & (ax >= hd['rod_r']) & (y >= hd['rod_y0'])
    ey = o['eye']
    eye = head & ~rod & (z >= ey['z0']) & (np.hypot(x - ey['c'][0], y - ey['c'][1]) < ey['r'])  # 眼面：前面、离眼心（x, y）不到 r 的一块圆
    lab[mm] = 'x_column'
    lab[strut] = ''
    lab[slab & (x > 0)] = 'slab_l'
    lab[slab & (x < 0)] = 'slab_r'
    lab[head] = 'head'
    lab[rod & (x > 0)] = 'x_rod_l'
    lab[rod & (x < 0)] = 'x_rod_r'
    lab[eye] = 'x_eye'
    # 眼匣往后仰（游戏镜头 50° 俯角：眼要朝前上方才看得进去）：眼匣（头里高于 y0、半径小于 r 的部分）和眼面按高度错切（z -= k·(y − y0)），
    # 底边不动（和领环接得上），越高越往后，正面的眼面朝上仰 atan(k)；单独一份顶点
    tl = o.get('tilt')
    if tl:
        dome = ((lab == 'head') | (lab == 'x_eye')) & (y >= tl['y0']) & (r < tl['r'])
        lab[dome & (lab == 'head')] = 'dome'
        lab[dome & (lab == 'x_eye')] = 'eye_t'
    # 护手：护腕 + 掌 = hand；下面的指头按高度分三排，内侧（靠柱身）那一截是拇指
    hn = o['hand']
    for sd, s in (('l', 1), ('r', -1)):
        hm = lab == 'hand_' + sd
        thumb = hm & (s * x < hn['thumb_x']) & (y < hn['thumb_y'])
        fing = hm & ~thumb & (y < hn['fing_y'][0])
        lab[fing] = 'x_finger_%s_01' % sd
        lab[fing & (y < hn['fing_y'][1])] = 'x_finger_%s_02' % sd
        lab[fing & (y < hn['fing_y'][2])] = 'x_finger_%s_03' % sd
        lab[thumb] = 'x_thumb_' + sd
    # 摆放：单位阵的共用顶点；护盾板挪到半径 R、按角度摆；环拷贝一道往下挪
    place = []
    for nm in sorted(set(lab.tolist()) - {'', 'slab_l', 'slab_r', 'ring', 'dome', 'eye_t'}):
        place.append((nm, nm, np.eye(4)))
    if tl:
        M = tilt_m(tl)
        place.append(('dome', 'head', M))
        place.append(('eye_t', 'x_eye', M))
    place.append(('ring', 'x_ring_a', scale_xz(o.get('ring_a', {}).get('s', 1.0))))
    rb = o['ring_b']
    place.append(('ring', 'x_ring_b', trans(0, rb['dy'], 0) @ scale_xz(rb['s'])))
    pl = o['plates']
    R = pl['r']
    rsrc = {}
    for nm, s in (('slab_l', 1), ('slab_r', -1)):
        m = lab == nm
        rsrc[nm] = float(np.median(np.abs(C[m, 0]))) if m.any() else 0.0
    for i, (src, a) in enumerate(zip(pl['src'], pl['angle'])):
        a0 = math.pi / 2 if src == 'slab_l' else -math.pi / 2  # 源的方位（atan2(x, z)）：+x 是 90°
        # 先沿自己的朝外方向（源方位）挪到半径 R，再绕竖轴转到目标方位
        # 板子本身在水平方向放大 pl['s'] 倍（绕它自己的中心：更宽更厚，俯视读得出来）
        cx, cz = math.sin(a0) * rsrc[src], math.cos(a0) * rsrc[src]
        Sc = trans(cx, 0, cz) @ scale_xz(pl.get('s', 1.0)) @ trans(-cx, 0, -cz)
        M = rot_y(math.radians(a) - a0) @ trans(math.sin(a0) * (R - rsrc[src]), 0, math.cos(a0) * (R - rsrc[src])) @ Sc
        place.append((src, 'x_plate_%02d' % (i + 1), M))
    log['labels'] = {k: int((lab == k).sum()) for k in sorted(set(lab.tolist()))}
    log['plate_src_r'] = {k: round(v, 4) for k, v in rsrc.items()}
    return lab, place, log


def lids(spec):
    """程序化的眼皮（源网格没有）：绕眼匣中心的两片薄球壳，上片 / 下片（仰角范围、方位半宽、半径、厚度见 spec['parts']['lids']）。返回 [(骨骼, 顶点, 三角形)]"""
    o = spec['parts']['lids']
    c = np.array(o['c'], dtype=np.float64)
    out = []
    for bone, (e0, e1) in (('x_lid_t', o['top']), ('x_lid_b', o['bottom'])):
        nu, nv = o.get('seg', [8, 3])
        V, Fl = [], []
        for layer, rad in enumerate((o['r'], o['r'] + o['t'])):
            for j in range(nv + 1):
                el = math.radians(e0 + (e1 - e0) * j / nv)
                for i in range(nu + 1):
                    az = math.radians(-o['az'] + 2 * o['az'] * i / nu)
                    V.append(c + rad * np.array([math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az)]))
        W = (nu + 1) * (nv + 1)
        idx = lambda L, i, j: L * W + j * (nu + 1) + i
        for j in range(nv):
            for i in range(nu):
                a, b, cc, d = idx(1, i, j), idx(1, i + 1, j), idx(1, i + 1, j + 1), idx(1, i, j + 1)
                Fl += [(a, b, cc), (a, cc, d)]  # 外层（朝外）
                a, b, cc, d = idx(0, i, j), idx(0, i + 1, j), idx(0, i + 1, j + 1), idx(0, i, j + 1)
                Fl += [(a, cc, b), (a, d, cc)]  # 内层（朝里）
        # 四条边封口
        for i in range(nu):
            for j in (0, nv):
                a, b = idx(0, i, j), idx(0, i + 1, j)
                a2, b2 = idx(1, i, j), idx(1, i + 1, j)
                Fl += [(a, b, b2), (a, b2, a2)] if j == nv else [(a, b2, b), (a, a2, b2)]
        for j in range(nv):
            for i in (0, nu):
                a, b = idx(0, i, j), idx(0, i, j + 1)
                a2, b2 = idx(1, i, j), idx(1, i, j + 1)
                Fl += [(a, b2, b), (a, a2, b2)] if i == nu else [(a, b, b2), (a, b2, a2)]
        V = np.array(V)
        tl = spec['parts'].get('tilt')
        if tl:
            V = xform(tilt_m(tl), V)  # 跟着眼匣一起仰
        out.append((bone, V, np.array(Fl, dtype=np.int64)))
    return out
