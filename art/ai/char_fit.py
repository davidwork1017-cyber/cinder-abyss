# AI 生成的小怪外观（ai3d-spitter：喷吐者）第一步：源网格对到游戏现有的蜘蛛骨架上（纯 numpy，不依赖 Blender）。
# 骨架不动：取 assets/quaternius-easy-enemy/Spider.glb 的骨骼（绑定姿态的世界位置，convert-chars.mjs 已归一到高 0.65 的模型空间），
# 名字、层级、静止姿态、动作都原样留着；改的是网格，让它贴到骨骼上：
#   身体：源网格等比缩放 k、平移，让源的髋部（每条腿离身体中线最近的那一圈）的重心落在骨架髋部的重心上；头 / 胸 / 腹按 z 分段刚性绑 Head / Thorax / Abdomen；
#   腿：每条腿量出髋 / 膝（最高点）/ 跗（膝到脚尖中间）/ 脚尖四个点，三段各自「转 + 沿轴拉伸」到骨架的 髋→膝→跗→脚 上（粗细不变），
#       关节两边一小段里两段的变换按 smoothstep 渐变（静止姿态的网格是闭合的），权重也在这一段里两根骨骼渐变，其余 100% 刚性。
# 候选参数（art/ai/char/<名字>.json）里写死的是会因候选而变的数：身体分段的 z、腿的配对、要删掉的粘连部分、渐变带宽、身高。
import json
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LEGS = ['FrontLeg', 'MidFrontLeg', 'MidBackLeg', 'BackLeg']


def _glb(path):
    import struct
    b = open(path, 'rb').read()
    jl = struct.unpack_from('<I', b, 12)[0]
    js = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack_from('<I', b, off)[0]
    return js, b[off + 8:off + 8 + bl]


def skeleton(path):
    """蜘蛛 GLB 的骨架：{骨骼名: 世界位置}（绑定姿态，逆绑定矩阵求逆），和 (js, bin)"""
    js, bin_ = _glb(path)
    sk = js['skins'][0]
    a = js['accessors'][sk['inverseBindMatrices']]
    bv = js['bufferViews'][a['bufferView']]
    ibm = np.frombuffer(bin_, np.float32, a['count'] * 16, bv.get('byteOffset', 0) + a.get('byteOffset', 0)).reshape(-1, 4, 4)
    pos = {}
    for ni, M in zip(sk['joints'], ibm):
        pos[js['nodes'][ni]['name']] = np.linalg.inv(M.astype(np.float64).T)[:3, 3]
    return pos, js, bin_


def foot_name(L, s, pos):
    """脚尖骨骼（IK 用的那根，动作不驱动它，只拿来量腿尖的静止位置）：右前脚在包里叫 FrontFoot2R"""
    for n in (L.replace('Leg', 'Foot') + s, L.replace('Leg', 'Foot') + '2' + s):
        if n in pos:
            return n
    raise RuntimeError('骨架里没有 ' + L + s + ' 的脚')


def components(F, nv):
    par = np.arange(nv)

    def find(a):
        r = a
        while par[r] != r:
            r = par[r]
        while par[a] != r:
            par[a], a = r, par[a]
        return r

    for a, b, c in F.tolist():
        ra = find(a)
        for x in (b, c):
            rx = find(x)
            if rx != ra:
                par[rx] = ra
    roots = np.array([find(i) for i in range(nv)])
    fr = roots[F[:, 0]]
    u, first, cnt = np.unique(fr, return_index=True, return_counts=True)
    order = sorted(range(len(u)), key=lambda i: (-cnt[i], first[i]))
    rank = np.empty(len(u), dtype=np.int64)
    rank[order] = np.arange(len(u))
    return rank[np.searchsorted(u, fr)]


def leg_marks(V):
    """一条腿（源网格的一个连通件）的四个点：髋（|x| 最小的一圈）、膝（最高的一圈）、跗（膝到脚尖之间投影在 0.47–0.57 的一圈）、脚尖（最低的一圈）"""
    ax = np.abs(V[:, 0])
    hip = V[ax <= ax.min() + 0.015].mean(axis=0)
    knee = V[V[:, 1] >= V[:, 1].max() - 0.012].mean(axis=0)
    tip = V[V[:, 1] <= V[:, 1].min() + 0.012].mean(axis=0)
    d = tip - knee
    t = (V - knee) @ d / (d @ d)
    sel = (t > 0.47) & (t < 0.57)
    tar = V[sel].mean(axis=0) if sel.any() else knee + 0.52 * d
    return np.array([hip, knee, tar, tip])


def _rot(a, b):
    """把方向 a 转到方向 b 的最短旋转（3×3）"""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if c < -0.999999:
        p = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
        v = np.cross(a, p)
        v /= np.linalg.norm(v)
        return 2 * np.outer(v, v) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


def seg_xform(A, B, a, b):
    """源的一段 A→B 映到骨骼 a→b：沿轴的分量拉伸到 |ab|，横向不变，再转过去。返回 f(p)"""
    d = B - A
    L = np.linalg.norm(d)
    u = d / L
    R = _rot(d, b - a)
    s = np.linalg.norm(b - a) / L

    def f(P):
        q = P - A
        ax = (q @ u)[:, None] * u
        return a + (ax * s + (q - ax)) @ R.T
    return f


def leg_param(P, M):
    """顶点在腿的折线（髋→膝→跗→尖）上的位置：(段号 0..2, 段内 0..1, 到折线的距离)"""
    best = None
    for i in range(3):
        A, B = M[i], M[i + 1]
        d = B - A
        t = np.clip((P - A) @ d / (d @ d), 0, 1)
        dist = np.linalg.norm(A + t[:, None] * d - P, axis=1)
        if best is None:
            best = [np.zeros(len(P), dtype=int), t.copy(), dist.copy()]
        else:
            m = dist < best[2]
            best[0][m] = i
            best[1][m] = t[m]
            best[2][m] = dist[m]
    return best


def fit(V, F, spec, sk):
    """V / F：源网格（焊接后）。返回 dict：k、t（身体的等比缩放 + 平移）、legs（每条骨架腿：源连通件 / 镜像、源的四点、骨架的四点）、body（三角形标签）"""
    o = spec['fit']
    comp = components(F, len(V))
    C = V[F].mean(axis=1)
    legs = {}
    for k in range(1, comp.max() + 1):
        Vi = V[np.unique(F[comp == k])]
        if len(Vi) < 50:
            continue
        mk = leg_marks(Vi)
        legs[k] = dict(side='L' if mk[3][0] > 0 else 'R', tipz=float(mk[3][2]), marks=mk)
    # 每一边按脚尖的 z 从前到后配给 FrontLeg / MidFrontLeg / MidBackLeg（候选参数 legs.order 可以改），BackLeg 拷 legs.back 指定的那条
    assign = {}
    for s in ('L', 'R'):
        ks = sorted([k for k in legs if legs[k]['side'] == s], key=lambda k: -legs[k]['tipz'])
        for L, k in zip(o['legs']['order'], ks):
            assign[L + s] = k
        assign['BackLeg' + s] = assign[o['legs']['back'] + s]
    # 身体：源的髋部重心 → 骨架的髋部重心（只用分开的那几条腿）
    hs = np.array([legs[assign[L + s]]['marks'][0] for L in o['legs']['order'] for s in ('L', 'R')])
    hk = np.array([sk[L + s] for L in o['legs']['order'] for s in ('L', 'R')])
    k = o.get('k')
    if not k:
        # 身高定缩放：模型最高点（腹背上的囊）落到 top_y
        k = (o['top_y'] - hk[:, 1].mean()) / (V[:, 1].max() - hs[:, 1].mean())
    t = hk.mean(axis=0) - k * hs.mean(axis=0)
    out = dict(k=float(k), t=t, assign=assign, legs=legs, comp=comp)
    return out
