# AI 生成的熔渣巨像（ai3d-golem）第一步：把整身网格对到现有巨像骨架上（纯 numpy，不依赖 Blender，可以单独跑来出骨架文件）。
# 输入：源网格的顶点 / 三角形（glTF 坐标：y 朝上、+z 朝前，单位随意）。输出：
#   fit：源坐标 → 游戏坐标（米）的等比缩放 + 平移（不转，源本来就是正面朝 +z、左右对称）；
#   src：28 根骨骼在「源的姿态」下的枢轴（游戏坐标，米）—— 肩 / 肘 / 腕、胯 / 膝 / 踝按网格的形状估，躯干和挂件取骨架的静止位置；
#   lm：中间量（裆高、手臂和躯干之间的空隙、拳头的范围……），出图和调参用。
# 每一项都能在候选的参数（spec['fit']）里写死覆盖：自动估不准的候选，在参数里写上量好的数，结果照样确定。
# 估法只用固定的切片 / 中位数 / 主成分，没有随机数；同样的输入同样的输出。
import ast
import os

import numpy as np


def _bones():
    """巨像骨架（art/ca/boss/golem.py 的 BONES）：按语法树读字面量，不 import（那边要 Blender 的 mathutils / bpy）"""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'ca', 'boss', 'golem.py')
    with open(path, encoding='utf-8') as fh:
        tree = ast.parse(fh.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'BONES' for t in node.targets):
            return ast.literal_eval(node.value)
    raise RuntimeError('golem.py 里没有 BONES')


BONES = _bones()

TGT = {n: np.array(p, dtype=np.float64) for n, _, p in BONES}
PARENT = {n: p for n, p, _ in BONES}
NAMES = [n for n, _, _ in BONES]


def _mirror(p):
    return np.array([-p[0], p[1], p[2]])


def samples(V, F):
    """表面采样点：顶点 + 三角形重心（切片统计用，比只用顶点稠密、和网格密度的分布无关得多）"""
    return np.concatenate([V, V[F].mean(axis=1)])


def _first_gap(vals, lo, hi, step, run):
    """vals 落在 [lo, hi) 的直方图里，从 lo 往上第一段连续 run 个以上的空格：返回 (空隙起点, 空隙终点)，没有就 None"""
    nb = int(round((hi - lo) / step))
    h = np.zeros(nb, dtype=np.int64)
    i = np.floor((vals - lo) / step).astype(np.int64)
    ok = (i >= 0) & (i < nb)
    np.add.at(h, i[ok], 1)
    seen = False
    k = 0
    while k < nb:
        if h[k]:
            seen = True
            k += 1
            continue
        j = k
        while j < nb and not h[j]:
            j += 1
        if seen and j - k >= run and j < nb:
            return lo + k * step, lo + j * step
        k = j
    return None


def weld(V, F, eps=1e-5):
    """按位置焊接（源 GLB 在 UV 缝上拆开了顶点）：返回 (每个顶点焊接后的序号, 焊接后的三角形)"""
    key = np.round(V / eps).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    return inv, inv[F]


def components(n, edges, mask):
    """只看 mask 里的顶点、两端都在里面的边，连通分量的根（不在 mask 里的是 -1）；并查集，结果和边的顺序无关（根 = 分量里最小的序号）"""
    par = np.arange(n)

    def find(a):
        r = a
        while par[r] != r:
            r = par[r]
        while par[a] != r:
            par[a], a = r, par[a]
        return r

    e = edges[mask[edges[:, 0]] & mask[edges[:, 1]]]
    for a, b in e:
        ra, rb = find(a), find(b)
        if ra != rb:
            par[max(ra, rb)] = min(ra, rb)
    root = np.array([find(i) for i in range(n)])
    root[~mask] = -1
    return root


def landmarks(U, o=None, W=None, WF=None):
    """U：单位化的采样点（地面 y = 0、身高 1、x 以包围盒为中心）；W / WF：单位化、焊接后的顶点和三角形（判手臂的连通分量用）。
    返回各关节的单位坐标和中间量"""
    o = o or {}
    x, y, z = U[:, 0], U[:, 1], U[:, 2]
    nW = len(W)
    edges = np.concatenate([WF[:, [0, 1]], WF[:, [1, 2]], WF[:, [2, 0]]])
    lm = {}
    # 裆：从下往上，第一个在 x≈0 有表面的高度
    crotch = o.get('crotch')
    if crotch is None:
        for yy in np.arange(0.05, 0.6, 0.0025):
            if np.any((np.abs(x) < 0.03) & (np.abs(y - yy) < 0.003)):
                crotch = float(yy)
                break
    if crotch is None:
        raise RuntimeError('找不到裆的高度（参数里写 fit.crotch）')
    lm['crotch'] = crotch
    for side, sg in (('l', 1.0), ('r', -1.0)):
        sx = sg * x
        # 手臂和躯干之间的空隙：拳头以上、肩以下那一段，从躯干往外第一段空的
        band = (y > o.get('gap_y0', 0.36)) & (y < o.get('gap_y1', 0.55))
        gap = o.get('gap_' + side) or _first_gap(sx[band], 0.05, 0.6, 0.005, 2)
        if gap is None:
            raise RuntimeError('手臂和躯干之间没有空隙（参数里写 fit.gap_%s = [起, 止]）' % side)
        xg = 0.5 * (gap[0] + gap[1])
        # 手臂 = 空隙外侧那部分网格里、连着肩（外侧最高点）的连通分量（脚尖、小腿伸到空隙外面也不算进来）
        m = sg * W[:, 0] > xg
        root = components(nW, edges, m)
        # 手臂分量：空隙那一段高度里、空隙外侧的顶点最多的那个分量
        bandv = m & (W[:, 1] > o.get('gap_y0', 0.36)) & (W[:, 1] < o.get('gap_y1', 0.55))
        rs, cnt = np.unique(root[bandv], return_counts=True)
        av = root == rs[int(np.argmax(cnt))]
        af = av[WF].all(axis=1)
        AP = np.concatenate([W[av], W[WF[af]].mean(axis=1)])
        x_a, y_a = sg * AP[:, 0], AP[:, 1]
        # 肩顶：手臂这一列（空隙那一段高度里手臂点 x 的中位数以外）最高的点；烟囱、头在这一列里面，不算
        inb = (y_a > o.get('gap_y0', 0.36)) & (y_a < o.get('gap_y1', 0.55))
        col = float(np.median(x_a[inb]))
        sh_top = float(y_a[x_a > 0.5 * (col + gap[1])].max())
        sh_y = o.get('shoulder_y', sh_top - o.get('shoulder_drop', 0.105))
        fist_bot = float(y_a.min())
        wr_y = o.get('wrist_y', fist_bot + o.get('wrist_frac', 0.33) * (sh_y - fist_bot))
        el_y = o.get('elbow_y', sh_y - 0.524 * (sh_y - wr_y))  # 巨像骨架：肩 3.55 → 肘 2.45 → 腕 1.45
        # 肩 / 肘 / 腕：手臂点在这一高度的薄片，取 x / z 的范围中点（2–98 分位，免得一两个凸起的点带偏）
        def mid(yy, w=0.015):
            sl = (np.abs(y_a - yy) < w) & (x_a > gap[1])
            if sl.sum() < 8:
                raise RuntimeError('手臂在 y = %.3f 处没有点（参数里写 fit.joints_%s）' % (yy, side))
            q = np.percentile(AP[sl], [2, 98], axis=0)
            return np.array([0.5 * (q[0][0] + q[1][0]), yy, 0.5 * (q[0][2] + q[1][2])])

        on_axis = mid
        fist = AP[y_a < wr_y]
        lm[side] = dict(gap=[round(float(gap[0]), 4), round(float(gap[1]), 4)], shoulder_top=sh_top, fist_bottom=fist_bot,
                        shoulder=on_axis(sh_y), elbow=on_axis(el_y), wrist=on_axis(wr_y), fist=fist.mean(axis=0), fist_lo=fist.min(axis=0), fist_hi=fist.max(axis=0))
        # 腿：裆以下这一侧的点；胯在裆上面一点，膝 / 踝按巨像骨架的比例（胯 1.62 → 膝 0.95 → 踝 0.3）
        # 不算手臂分量里的点（拳头垂到裆以下）：按到手臂点集的最近距离排除太费，直接用空隙——腿在空隙内侧
        leg = (sx > 0) & (y < crotch - 0.005) & ((sx < gap[0]) | (y < o.get('foot_y', 0.06)))
        top = leg & (y > crotch - 0.08)
        def lmid(sel, yy):
            q = np.percentile(U[sel], [2, 98], axis=0)
            return np.array([0.5 * (q[0][0] + q[1][0]), yy, 0.5 * (q[0][2] + q[1][2])])

        hip = lmid(top, crotch + o.get('hip_up', 0.025))
        res = {'hip': hip}
        for nm, fr in (('knee', 0.95 / 1.62), ('ankle', 0.3 / 1.62)):
            yy = hip[1] * fr
            res[nm] = lmid(leg & (np.abs(y - yy) < 0.02), yy)
        lm[side].update(res)
    for k in ('l', 'r'):
        for j, v in o.get('joints_' + k, {}).items():  # 单个关节的硬覆盖（单位坐标）
            lm[k][j] = np.array(v, dtype=np.float64)
    return lm


def fit(V, F, spec=None):
    """返回 dict(scale, offset, src, lm, unit)：游戏坐标 = 源坐标 × scale + offset"""
    o = (spec or {}).get('fit', {})
    S = samples(V, F)
    y0, y1 = S[:, 1].min(), S[:, 1].max()
    h = y1 - y0
    cx = 0.5 * (S[:, 0].min() + S[:, 0].max())
    U = (S - [cx, y0, 0.0]) / h
    inv, WF = weld(V, F)
    W0 = np.zeros((inv.max() + 1, 3))
    W0[inv] = V
    W = (W0 - [cx, y0, 0.0]) / h
    lm = landmarks(U, o, W, WF)
    # 等比缩放：关节（肩 / 肘 / 腕、胯 / 膝 / 踝，两侧）的 (x, y) 对到骨架上的最小二乘；右臂用左臂的镜像（右手是锤，骨架不对称）
    pairs = []
    for side, mir in (('l', False), ('r', True)):
        L = lm[side]
        for j, b in (('shoulder', 'upperarm_l'), ('elbow', 'lowerarm_l'), ('wrist', 'hand_l'), ('hip', 'thigh_l'), ('knee', 'calf_l'), ('ankle', 'foot_l')):
            t = TGT[b]
            pairs.append((L[j], _mirror(t) if mir else t))
    num = sum(float(u[0] * t[0] + u[1] * t[1]) for u, t in pairs)
    den = sum(float(u[0] * u[0] + u[1] * u[1]) for u, _ in pairs)
    H = o.get('height', num / den)  # 身高（米）；参数里可以写死
    if o.get('elbow_y_m') or o.get('wrist_y_m'):
        # 肘 / 腕的高度按米给（看源网格的侧影量的）：身高定下来以后换成单位高度，再估一遍（身高不再改）
        o2 = dict(o)
        if o.get('elbow_y_m'):
            o2['elbow_y'] = o['elbow_y_m'] / H
        if o.get('wrist_y_m'):
            o2['wrist_y'] = o['wrist_y_m'] / H
        lm = landmarks(U, o2, W, WF)
    # 前后：两胯的 z 对到骨盆（z = 0）
    zoff = o.get('z', -0.5 * (lm['l']['hip'][2] + lm['r']['hip'][2]) * H)
    # xz_scale：水平方向（x / z）另乘的倍数，高度不变（游戏里俯视的占地要贴着碰撞半径：golem-a-01 手臂和躯干之间有空隙，等比的话占地比碰撞半径小两成）
    k = o.get('xz_scale', 1.0)
    scale = np.array([H / h * k, H / h, H / h * k])
    offset = np.array([-cx * scale[0], -y0 * scale[1], zoff * k])
    # 源姿态下的枢轴（游戏坐标）
    g = lambda u: np.array([u[0] * H * k, u[1] * H, (u[2] * H + zoff) * k])
    src = {n: TGT[n].copy() for n in NAMES}  # 躯干、头、挂件：静止位置
    for side in ('l', 'r'):
        L = lm[side]
        src['upperarm_' + side] = g(L['shoulder'])
        src['lowerarm_' + side] = g(L['elbow'])
        src['hand_' + side] = g(L['wrist'])
        src['thigh_' + side] = g(L['hip'])
        src['calf_' + side] = g(L['knee'])
        src['foot_' + side] = g(L['ankle'])
    # 手上的挂件（左手三指、右手锤）：跟着腕平移
    for n in ('x_finger_l_01', 'x_finger_l_02', 'x_finger_l_03'):
        src[n] = src['hand_l'] + (TGT[n] - TGT['hand_l'])
    src['x_hammer'] = src['hand_r'] + (TGT['x_hammer'] - TGT['hand_r'])
    # 躯干、头、挂件的枢轴：每个候选在参数里按米写（看侧影 / 正面量的：腰带、胸口中段、头底、烟囱根、炉栅中心），没写的取骨架的静止位置
    for n, p in o.get('pivots', {}).items():
        if n not in src:
            raise RuntimeError('fit.pivots：没有骨骼 ' + n)
        src[n] = np.array(p, dtype=np.float64) * [k, 1.0, k]  # 参数里的枢轴按等比的坐标量的，水平方向一起放大
    return dict(scale=scale, offset=offset, height=H, src=src, lm=lm, unit=dict(cx=cx, y0=y0, h=h), k=k)


def to_source(p, f):
    """游戏坐标（米）→ 源 GLB 的坐标"""
    return (np.asarray(p) - f['offset']) / f['scale']


def skeleton_txt(f, native=True):
    """骨架文本：每行「名字 父骨骼 x y z」（glTF：y 朝上、+z 朝前），按骨架顺序；native = 源 GLB 自己的坐标，否则游戏坐标（米）"""
    out = []
    for n in NAMES:
        p = to_source(f['src'][n], f) if native else f['src'][n]
        out.append('%s %s %.6f %.6f %.6f' % (n, PARENT[n] or '-', p[0], p[1], p[2]))
    return '\n'.join(out) + '\n'
