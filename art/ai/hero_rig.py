# AI 主角试验（ai3d-hero，不上线）：A 字站姿的整身源网格 → 对主角标准骨架 → 权重（UniRig 自动蒙皮 + 按区域纠正，或纯按区域的渐变权重）
# → 减面（高 / 低两档）→ 一角一色 → 游戏端 cParse 读得懂的带蒙皮 GLB（art/ai/glbw.py 写，逐字节确定）。
# 无头 Blender（只用它的减面和最近点查询）：
#   blender -b --factory-startup --python-exit-code 1 --python art/ai/hero_rig.py -- --spec art/ai/hero/<候选>.json --out <目录> [--src <model.glb>] [--weights <model_rigged.glb>] [--mode hybrid|band]
# 产物（<目录>/）：hero_<候选>_<mode>_hi.glb（高档，≤ spec.tris.hi 三角形）、hero_<候选>_<mode>_lo.glb（低档）、<候选>-skeleton.txt（源坐标的拟合骨架，给 UniRig）、
#   build.json（三角形数、每根骨骼的顶点数、各步参数、源 / 权重 / 产物的 sha256）。
# 步骤：
#   load     源 GLB → 顶点 / 三角形 / 颜色来源（反照率贴图 + 每角 UV，或者 COLOR_0）；
#   fit      art/ai/hero_fit.py：缩放到 1.90 m、对齐，量出 53 根骨骼在 A 字站姿下的枢轴；导出的骨架就是这组枢轴（运行时 cPose 再摆到游戏的静止姿态）；
#   regions  每个（焊接后的）源顶点的区域：头 / 躯干各段 / 手臂各段 / 手掌 / 四指三节 / 拇指 / 腿各段 / 后摆；
#   weights  band：纯按区域，关节两侧按到关节的距离 smoothstep 渐变；hybrid：UniRig 的权重为主，主导骨和区域对不上的改成区域骨，只留区域相邻的骨骼；
#            两种都再套固定的覆盖：头（含头发）全给 Head、颈根一圈和 neck_01 渐变；手掌全给 hand；四指 = 一只连指手套，三节给 middle_01..03
#            （节与节之间窄带渐变，运行时卷成拳头）；拇指给 thumb_01..03；后摆左右两片各给 thigh，上沿和 pelvis 渐变；
#   decimate 焊接后整身减面（Blender Decimate · Collapse）到高 / 低两档；减面后的顶点按源网格上的最近点取区域和权重（重心插值）；
#   colour   每个角在源网格上取 15 个点的平均色（源姿态，和减面后的拓扑无关），轻调明暗（lift / gain / sat）；
#   export   art/ai/glbw.py：骨架只带平移；每顶点最多 4 根骨骼、量化到 1/255 后补差额，和正好 1。
import hashlib
import json
import math
import os
import sys

AI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI)
sys.dont_write_bytecode = True

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

import glbw  # noqa: E402
import hero_fit as hf  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(AI))
YW = np.array([0.2126, 0.7152, 0.0722])


def s2l(x):
    x = np.asarray(x, dtype=np.float64)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(np.asarray(x, dtype=np.float64), 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def sha256(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


# ---------------------------------------------------------------- load
def load(path):
    """源 GLB → dict(V, F, kind='tex'|'vc', UV 每角 (m,3,2), img 线性 / C 每顶点线性)。网格节点不许带变换（先确认坐标）"""
    js, bin_, acc = glbw.read(path)
    V, F, UV, C = [], [], [], []
    base = 0
    for nd in js['nodes']:
        if 'mesh' not in nd:
            continue
        if any(k in nd for k in ('matrix', 'rotation', 'scale', 'translation')):
            raise RuntimeError('源 GLB 的网格节点带变换，先确认坐标再处理')
        for pr in js['meshes'][nd['mesh']]['primitives']:
            at = pr['attributes']
            p = acc(at['POSITION']).astype(np.float64)
            V.append(p)
            F.append(acc(pr['indices']).astype(np.int64).reshape(-1, 3) + base)
            if 'TEXCOORD_0' in at:
                UV.append(acc(at['TEXCOORD_0']).astype(np.float64))
            if 'COLOR_0' in at:
                C.append(acc(at['COLOR_0'], norm=True)[:, :3].astype(np.float64))
            base += len(p)
    V, F = np.concatenate(V), np.concatenate(F)
    mats = js.get('materials') or []
    tex = mats and 'baseColorTexture' in mats[0].get('pbrMetallicRoughness', {})
    if tex and len(UV) and len(np.concatenate(UV)) == len(V):
        mat = mats[0]['pbrMetallicRoughness']
        im = js['images'][js['textures'][mat['baseColorTexture']['index']]['source']]
        bv = js['bufferViews'][im['bufferView']]
        data = bin_[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        tmp = os.path.join(bpy.app.tempdir or '/tmp', 'ai_hero_src' + ('.jpg' if 'jpeg' in im.get('mimeType', '') else '.png'))
        with open(tmp, 'wb') as fh:
            fh.write(data)
        bim = bpy.data.images.load(tmp)
        w, h = bim.size
        px = np.empty(w * h * 4, dtype=np.float32)
        bim.pixels.foreach_get(px)
        srgb = px.reshape(h, w, 4)[::-1, :, :3].astype(np.float64)
        bpy.data.images.remove(bim)
        fac = np.array(mat.get('baseColorFactor', [1, 1, 1, 1])[:3])
        return dict(V=V, F=F, kind='tex', UV=np.concatenate(UV)[F], img=s2l(srgb) * fac)
    if len(C) and len(np.concatenate(C)) == len(V):
        return dict(V=V, F=F, kind='vc', C=np.concatenate(C))
    raise RuntimeError('源 GLB 既没有反照率贴图也没有 COLOR_0')


def load_weights(path, f, shape_fn=None):
    """自动蒙皮的权重 GLB（源网格自己的坐标，骨骼名是主角骨架的子集）→ (顶点（游戏坐标）, 三角形, 每个顶点 {骨骼: 权重})"""
    js, bin_, acc = glbw.read(path)
    pr = js['meshes'][0]['primitives'][0]
    V = acc(pr['attributes']['POSITION']).astype(np.float64)
    F = acc(pr['indices']).astype(np.int64).reshape(-1, 3)
    J = acc(pr['attributes']['JOINTS_0']).astype(np.int64)
    Wt = acc(pr['attributes']['WEIGHTS_0'], norm=True).astype(np.float64)
    names = [js['nodes'][j]['name'] for j in js['skins'][0]['joints']]
    bad = sorted(set(names) - set(hf.NAMES))
    if bad:
        raise RuntimeError('权重 GLB 的骨骼不在主角骨架里：' + ','.join(bad))
    if shape_fn is not None:
        V = shape_fn(V)
    G = V * f['scale'] + f['offset']
    ws = []
    for j, w in zip(J, Wt):
        d = {}
        for jj, ww in zip(j, w):
            if ww > 0:
                d[names[jj]] = d.get(names[jj], 0.0) + float(ww)
        ws.append(d)
    return G, F, ws


# ---------------------------------------------------------------- regions + band weights (on the dense welded source, game metres)
def smooth(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _blend(d, band):
    """d：到关节的有符号距离（父 → 子为正）；返回子骨骼的权重 0–1"""
    return smooth(d / band + 0.5)


def source_weights(f, spec):
    """每个焊接后的源顶点：(区域名, 渐变权重 {骨骼: 权重}, 覆盖级别)。覆盖级别：'force' = 不管自动蒙皮一律用这里的权重（头、手、后摆），'region' = 自动蒙皮按区域纠正"""
    o = spec.get('regions', {})
    W = f['W']
    S = f['src']
    n = len(W)
    x, y, z = W[:, 0], W[:, 1], W[:, 2]
    arm = f['arm']
    t = f['t']
    H = f['height']
    out_r = [None] * n
    out_w = [None] * n
    out_k = ['region'] * n
    neck = S['neck_01']
    head_cut = neck[1] + o.get('head_above_neck', 0.03)
    head_band = o.get('head_band', 0.03)
    trunk = [('pelvis', S['pelvis'][1]), ('spine_01', S['spine_01'][1]), ('spine_02', S['spine_02'][1]), ('spine_03', S['spine_03'][1]), ('neck_01', S['neck_01'][1])]
    tb = o.get('trunk_band', 0.08)
    for i in range(n):
        p = W[i]
        a = arm[i]
        if a != 0:
            s = 'l' if a > 0 else 'r'
            L = f['lm'][s]
            ti = t[i]
            t_el, t_wr = L['t_el'] * H, L['t_wr'] * H
            Lh = L['hand_len'] * H
            if ti >= t_wr - 0.005:
                # 手：掌 / 连指手套三节 / 拇指
                th = (ti - t_wr) / Lh
                fr = spec.get('fit', {}).get('finger_frac', [0.45, 0.66, 0.84])
                if L['thumb_mask'][i]:
                    # 拇指：按到拇指根的距离分三段（拇指根贴着手掌，和 hand 渐变）
                    tp = [S['thumb_0%d_%s' % (k, s)] for k in (1, 2, 3)]
                    dd = (p - tp[0]) @ ((tp[2] - tp[0]) / (np.linalg.norm(tp[2] - tp[0]) + 1e-9))
                    l1 = np.linalg.norm(tp[1] - tp[0])
                    l2 = l1 + np.linalg.norm(tp[2] - tp[1])
                    if dd < l1:
                        c = _blend(dd, 0.02)
                        w = {'hand_' + s: 1 - c, 'thumb_01_' + s: c} if dd < 0.01 else {'thumb_01_' + s: 1.0}
                        reg = 'thumb_01_' + s
                    elif dd < l2:
                        c = _blend(dd - l2, 0.012)
                        w = {'thumb_02_' + s: 1 - c, 'thumb_03_' + s: c}
                        reg = 'thumb_02_' + s
                    else:
                        w = {'thumb_03_' + s: 1.0}
                        reg = 'thumb_03_' + s
                    if dd >= l1 - 0.006 and dd < l1:
                        w = {'thumb_01_' + s: 0.5, 'thumb_02_' + s: 0.5}
                else:
                    chain = ['hand_' + s, 'middle_01_' + s, 'middle_02_' + s, 'middle_03_' + s]
                    k = int(np.searchsorted(fr, th))
                    reg = chain[k]
                    fb = o.get('finger_band', 0.025)  # 占手长
                    w = {chain[k]: 1.0}
                    for j, ff in enumerate(fr):
                        if abs(th - ff) < fb:
                            c = smooth((th - ff) / (2 * fb) + 0.5)
                            w = {chain[j]: 1 - c, chain[j + 1]: c}
                    if ti < t_wr + 0.01:
                        c = _blend(ti - t_wr, 0.03)
                        w = {'lowerarm_' + s: 1 - c, 'hand_' + s: c}
                out_k[i] = 'force'
            elif ti >= t_el - o.get('elbow_band', 0.07):
                c = _blend(ti - t_wr, o.get('wrist_band', 0.04))
                e = _blend(ti - t_el, o.get('elbow_band', 0.07))
                w = {'upperarm_' + s: 1 - e, 'lowerarm_' + s: e * (1 - c), 'hand_' + s: e * c}
                reg = 'lowerarm_' + s if ti > t_el else 'upperarm_' + s
                # 小臂（含护腕）一律用渐变权重：UniRig 把护腕大多给了 hand，手一转护腕就跟着拧
                if ti > t_el + 0.02:
                    out_k[i] = 'force'
            else:
                # 上臂；肩口（t < 肩带）和 clavicle / spine_03 渐变
                sb = o.get('shoulder_band', 0.06)
                c = _blend(ti - 0.0, sb)
                w = {'upperarm_' + s: c, 'clavicle_' + s: (1 - c) * 0.6, 'spine_03': (1 - c) * 0.4}
                reg = 'upperarm_' + s
        elif y[i] > head_cut - head_band:
            c = _blend(y[i] - head_cut, head_band)
            w = {'Head': c, 'neck_01': 1 - c}
            reg = 'Head' if c > 0.5 else 'neck_01'
            out_k[i] = 'force' if y[i] > head_cut else 'region'
        else:
            reg, w = None, None
            # 腿 / 后摆（裆以下，或胯的高度以下、离躯干中线够远）
            s = 'l' if x[i] > 0 else 'r'
            hip = S['thigh_' + s]
            crotch = f['lm']['crotch'] * H
            kn, an = S['calf_' + s], S['foot_' + s]
            # 后摆：胯以上一点到膝下一点、在腿（中线附近按同侧的腿）的背后，离腿中心线往后超过腿的半径
            leg_r = o.get('leg_r', 0.085)
            zc = hip[2] + (kn[2] - hip[2]) * np.clip((hip[1] - y[i]) / max(1e-6, hip[1] - kn[1]), 0, 1)
            if o.get('coat', True) and kn[1] - o.get('coat_below_knee', 0.06) < y[i] < hip[1] + o.get('coat_above_hip', 0.06) and z[i] < zc - leg_r:
                c = _blend(hip[1] - y[i], o.get('coat_band', 0.12))
                w = {'thigh_' + s: c, 'pelvis': 1 - c}
                reg = 'coat_' + s
                out_k[i] = 'force'
            elif y[i] < crotch or (y[i] < hip[1] and abs(x[i]) > o.get('leg_x', 0.07)):
                if False:
                    pass
                else:
                    if y[i] > kn[1] - 0.08:
                        e = _blend(kn[1] - y[i], o.get('knee_band', 0.08))
                        hb = _blend(hip[1] - y[i] - 0.02, o.get('hip_band', 0.1))
                        w = {'thigh_' + s: hb * (1 - e), 'calf_' + s: e, 'pelvis': (1 - hb) * (1 - e)}
                        reg = 'thigh_' + s if e < 0.5 else 'calf_' + s
                    else:
                        c = _blend(an[1] + 0.02 - y[i], o.get('ankle_band', 0.05))
                        w = {'calf_' + s: 1 - c, 'foot_' + s: c}
                        reg = 'calf_' + s if c < 0.5 else 'foot_' + s
                        if y[i] < 0.06 and z[i] > S['ball_' + s][2] - 0.02:
                            c2 = _blend(z[i] - S['ball_' + s][2], 0.04)
                            w = {'foot_' + s: 1 - c2, 'ball_' + s: c2}
                            reg = 'foot_' + s
            if reg is None:
                # 躯干：按高度在相邻两节之间渐变
                yy = y[i]
                w = {trunk[0][0]: 1.0}
                reg = trunk[0][0]
                for j in range(len(trunk) - 1):
                    a0, y0 = trunk[j]
                    a1, y1 = trunk[j + 1]
                    if yy >= y0 - tb and yy < y1 + tb * 0.5:
                        c = smooth((yy - y0) / (y1 - y0))
                        w = {a0: 1 - c, a1: c}
                        reg = a0 if c < 0.5 else a1
                if yy >= trunk[-1][1]:
                    w = {'neck_01': 1.0}
                    reg = 'neck_01'
                # 胸口两侧（腋下以上、靠近肩）带一点 clavicle
                if yy > S['spine_03'][1] and abs(x[i]) > o.get('clav_x', 0.09):
                    s = 'l' if x[i] > 0 else 'r'
                    c = smooth((abs(x[i]) - o.get('clav_x', 0.09)) / 0.06) * 0.5
                    w = {k: v * (1 - c) for k, v in w.items()}
                    w['clavicle_' + s] = w.get('clavicle_' + s, 0) + c
        out_r[i] = reg
        out_w[i] = {k: float(v) for k, v in w.items() if v > 1e-4}
    return out_r, out_w, out_k


def region_bone(reg):
    return reg.replace('coat_', 'thigh_')


def family(n):
    fam = {n}
    if hf.PARENT.get(n):
        fam.add(hf.PARENT[n])
    fam |= {c for c, p in hf.BONES if p == n}
    return fam


TORSO = {'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'clavicle_l', 'clavicle_r'}


def combine(reg, band, kind, auto, mode, st):
    """一个顶点的最终权重。mode = 'band'：直接用区域渐变；'hybrid'：force 区域用渐变，其余用自动蒙皮（主导骨对不上 → 渐变；只留区域相邻的骨骼）"""
    if mode == 'band' or kind == 'force' or not auto:
        st['band' if mode == 'band' else 'force'] += 1
        return band
    rb = region_bone(reg)
    dom = max(sorted(auto), key=lambda k: auto[k])
    ok = dom in family(rb) or (dom in TORSO and rb in TORSO) or dom in band
    if not ok:
        st['mismatch'] += 1
        return band
    allow = family(rb) | set(band) | (TORSO if rb in TORSO else set())
    top = {k: v for k, v in auto.items() if k in allow}
    st['kept'] += 1
    return top or band


def quant4(w):
    """最多 4 根、量化到 1/255、补差额到最重的那根：返回 [(骨骼, 0–255 整数)]"""
    top = sorted(((k, v) for k, v in w.items() if v > 0), key=lambda kv: (-kv[1], kv[0]))[:4]
    s = sum(v for _, v in top) or 1.0
    q = [(k, int(round(v / s * 255))) for k, v in top]
    q = [(k, v) for k, v in q if v > 0] or [(top[0][0], 255)]
    d = 255 - sum(v for _, v in q)
    q[0] = (q[0][0], q[0][1] + d)
    return q


# ---------------------------------------------------------------- decimate
def decimate(V, F, target, log, key):
    me = bpy.data.meshes.new('dec_src')
    me.from_pydata(V.tolist(), [], F.tolist())
    ob = bpy.data.objects.new('dec', me)
    bpy.context.scene.collection.objects.link(ob)
    n0 = len(me.polygons)
    ratio = min(1.0, target / n0)
    tris = n0
    for it in range(6):
        ob.data = me.copy()
        md = ob.modifiers.new('dec', 'DECIMATE')
        md.decimate_type = 'COLLAPSE'
        md.ratio = ratio
        md.use_collapse_triangulate = True
        for o in bpy.context.scene.objects:
            o.select_set(o is ob)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier='dec')
        tris = len(ob.data.polygons)
        if tris <= target and tris >= 0.97 * target:
            break
        ratio = min(1.0, ratio * (target - 0.01 * target) / tris)
    Vd = np.array([v.co[:] for v in ob.data.vertices])
    Fd = np.array([p.vertices[:] for p in ob.data.polygons], dtype=np.int64)
    bpy.data.objects.remove(ob)
    if len(Fd) > target:
        raise RuntimeError('减面后 %d 个三角形，超过 %d' % (len(Fd), target))
    log.setdefault('decimate', {})[key] = dict(target=target, tris=int(len(Fd)), ratio=round(ratio, 6), source_tris=int(n0))
    return Vd, Fd


# ---------------------------------------------------------------- colour
class Sampler:
    """源网格（游戏坐标）上取颜色：最近点 → 源三角形的重心 → 贴图双线性 / 顶点色插值（线性）"""

    def __init__(self, G, F, d):
        self.G, self.F, self.d = G, F, d
        self.bvh = BVHTree.FromPolygons([tuple(p) for p in G.tolist()], [tuple(t) for t in F.tolist()], all_triangles=True)
        if d['kind'] == 'tex':
            self.h, self.w, _ = d['img'].shape

    def bary(self, p):
        loc, nrm, fi, dist = self.bvh.find_nearest(Vector(p))
        a, b, c = self.G[self.F[fi]]
        q = np.array(loc[:])
        v0, v1, v2 = b - a, c - a, q - a
        d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01 or 1e-18
        wb = (d11 * d20 - d01 * d21) / den
        wc = (d00 * d21 - d01 * d20) / den
        w = np.clip(np.array([1 - wb - wc, wb, wc]), 0, 1)
        return fi, w / w.sum()

    def at(self, p):
        fi, w = self.bary(p)
        if self.d['kind'] == 'vc':
            return w @ self.d['C'][self.F[fi]]
        uv = w @ self.d['UV'][fi]
        x = uv[0] * self.w - 0.5
        y = uv[1] * self.h - 0.5
        x0, y0 = int(math.floor(x)), int(math.floor(y))
        tx, ty = x - x0, y - y0
        im = self.d['img']

        def px(i, j):
            return im[min(self.h - 1, max(0, j)), min(self.w - 1, max(0, i))]

        return px(x0, y0) * (1 - tx) * (1 - ty) + px(x0 + 1, y0) * tx * (1 - ty) + px(x0, y0 + 1) * (1 - tx) * ty + px(x0 + 1, y0 + 1) * tx * ty


GRID = [(i / 4, j / 4, (4 - i - j) / 4) for i in range(5) for j in range(5 - i)]


def grade(lin, g):
    lin = np.asarray(lin, dtype=np.float64)
    if g.get('tint'):
        lin = lin * np.array(g['tint'])
    yv = lin @ YW
    lin = yv + (lin - yv) * g.get('sat', 1.0)
    lin = np.clip(lin, 0, None) * g.get('gain', 1.0)
    if g.get('lift', 1.0) != 1.0:
        a = g['lift']
        sv = l2s(lin)
        lin = s2l(a * sv / (1 + (a - 1) * sv))
    # 按颜色定点改色（remap）：离 src（sRGB 0–255）近的颜色往 dst 拉，权重 = smoothstep(1 − 距离 / r)，线性空间里按通道乘 (dst / src)^权重
    for rm in g.get('remap', []):
        sv = l2s(np.clip(lin, 0, 1)) * 255
        dd = float(np.linalg.norm(sv - np.array(rm['src'])))
        w = max(0.0, 1 - dd / rm.get('r', 40))
        if w > 0:
            w = w * w * (3 - 2 * w)
            k = s2l(np.array(rm['dst']) / 255) / np.maximum(s2l(np.array(rm['src']) / 255), 1e-6)
            lin = lin * k ** w
    return np.clip(lin, 0, 1)


def corner_colours(Vd, Fd, smp, g):
    out = np.zeros((len(Fd), 3, 3))
    Wg = np.array(GRID) ** 2
    for fi, tri in enumerate(Fd):
        P = Vd[tri]
        cols = np.array([smp.at(w[0] * P[0] + w[1] * P[1] + w[2] * P[2]) for w in GRID])
        for k in range(3):
            wk = Wg[:, k] / Wg[:, k].sum()
            out[fi, k] = grade(wk @ cols, g)
    return out


# ---------------------------------------------------------------- coat split / fist
def coat_split(Vd, Fd, Wsrc, WF, bvh, regs, spec, log, key):
    """后摆在 x = 0 切开（只切后摆的面）：跨过 x = 0 的后摆三角形按平面切开，缝上的边拆开，两半各跟各的腿。
    返回 (顶点, 三角形, 每个顶点属于哪一侧（+1 左 / -1 右 / 0 不在缝上或不是后摆）)"""
    def reg_of(p):
        loc, nrm, fi, d = bvh.find_nearest(Vector(p))
        tri = WF[fi]
        dd = [np.linalg.norm(Wsrc[t] - p) for t in tri]
        return regs[tri[int(np.argmin(dd))]]

    vreg = [reg_of(p) for p in Vd]
    coat = np.array([sum(vreg[v].startswith('coat_') for v in tri) >= 2 for tri in Fd])
    side0 = np.zeros(len(Vd), dtype=np.int64)
    if not spec.get('regions', {}).get('coat_split', True) or not coat.any():
        log.setdefault('coat', {})[key] = dict(faces=int(coat.sum()), split=0)
        return Vd, Fd, side0
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in Vd.tolist()]
    L = bm.faces.layers.int.new('coat')
    for k, (a, b, c) in enumerate(Fd.tolist()):
        try:
            fc = bm.faces.new((vs[a], vs[b], vs[c]))
            fc[L] = int(coat[k])
        except ValueError:
            pass
    bm.verts.index_update()
    bm.edges.index_update()
    bm.faces.index_update()
    sel = [fc for fc in bm.faces if fc[L] and min(v.co.x for v in fc.verts) < -1e-6 and max(v.co.x for v in fc.verts) > 1e-6]
    if sel:
        es = {e.index: e for fc in sel for e in fc.edges}
        vv = {v.index: v for fc in sel for v in fc.verts}
        geom = [es[k] for k in sorted(es)] + sel + [vv[k] for k in sorted(vv)]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=(0, 0, 0), plane_no=(1, 0, 0))
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    seam = [e for e in bm.edges if all(abs(v.co.x) < 1e-5 for v in e.verts) and len(e.link_faces) == 2 and all(fc[L] for fc in e.link_faces)
            and (e.link_faces[0].calc_center_median().x > 0) != (e.link_faces[1].calc_center_median().x > 0)]
    bmesh.ops.split_edges(bm, edges=seam)
    bm.verts.index_update()
    bm.faces.index_update()
    V2 = np.array([v.co[:] for v in bm.verts])
    F2 = np.array([[v.index for v in fc.verts] for fc in bm.faces], dtype=np.int64)
    side = np.zeros(len(V2), dtype=np.int64)
    for v in bm.verts:
        cf = [fc for fc in v.link_faces if fc[L]]
        if cf and abs(v.co.x) < 0.03:
            mx = sum(fc.calc_center_median().x for fc in cf)
            side[v.index] = 1 if mx > 0 else -1
    bm.free()
    log.setdefault('coat', {})[key] = dict(faces=int(coat.sum()), cut_faces=len(sel), seam_edges=len(seam), tris=int(len(F2)))
    return V2, F2, side


def _rot(axis, ang):
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    c, s_ = math.cos(ang), math.sin(ang)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + s_ * K + (1 - c) * (K @ K)


def bake_fist(Vd, VW, f, spec, log, key):
    """四指（连指手套三节）绕各自的指节转进掌心：转轴 = hero_fit 量的 curl_axis（手的轴 × 掌心朝向），角度 spec.fist（缺省 [1.25, 1.25, 0.35] 弧度，
    前两节和现网主角的卷曲一样）。顶点按权重混合（线性蒙皮），四指 / 拇指骨骼的枢轴跟着挪。返回 (新顶点, 新的骨骼枢轴表)"""
    ang = spec.get('fist', [1.25, 1.25, 0.35])
    src = {k: np.array(v, dtype=np.float64) for k, v in f['src'].items()}
    M = {}
    for s in 'lr':
        ax = f['lm'][s]['curl_axis']
        R, t = np.eye(3), np.zeros(3)
        for k in (1, 2, 3):
            piv = R @ f['src']['middle_0%d_%s' % (k, s)] + t
            Rk = _rot(ax, ang[k - 1])
            R, t = Rk @ R, Rk @ (t - piv) + piv
            for fn in ('index', 'middle', 'ring', 'pinky'):
                n = '%s_0%d_%s' % (fn, k, s)
                M[n] = (R.copy(), t.copy())
                if k > 1:
                    pr = '%s_0%d_%s' % (fn, k - 1, s)
                    src[n] = M[pr][0] @ f['src'][n] + M[pr][1]
    out = Vd.copy()
    moved = 0
    for i, q in enumerate(VW):
        if not any(n in M for n, _ in q):
            continue
        p = Vd[i]
        acc = np.zeros(3)
        for n, w in q:
            if n in M:
                R, t = M[n]
                acc += (w / 255) * (R @ p + t)
            else:
                acc += (w / 255) * p
        out[i] = acc
        moved += 1
    log.setdefault('fist', {})[key] = dict(angles=ang, verts=moved)
    return out, src


# ---------------------------------------------------------------- build one LOD
def build_lod(key, target, Wsrc, WF, f, regs, bands, kinds, auto_src, mode, smp, spec, out, name, log):
    Vd, Fd = decimate(Wsrc, WF, target, log, key)
    bvh0 = BVHTree.FromPolygons([tuple(p) for p in Wsrc.tolist()], [tuple(t) for t in WF.tolist()], all_triangles=True)
    Vd, Fd, vside = coat_split(Vd, Fd, Wsrc, WF, bvh0, regs, spec, log, key)
    # 减面后的每个顶点：源网格上最近点所在三角形，区域取重心最大的那个角，权重按重心插值（区域渐变 / 自动蒙皮各插各的）
    bvh = BVHTree.FromPolygons([tuple(p) for p in Wsrc.tolist()], [tuple(t) for t in WF.tolist()], all_triangles=True)
    if auto_src is not None:
        AG, AF, AW = auto_src
        abvh = BVHTree.FromPolygons([tuple(p) for p in AG.tolist()], [tuple(t) for t in AF.tolist()], all_triangles=True)
    st = dict(band=0, force=0, mismatch=0, kept=0)
    VW = []
    VR = []

    def bary(G, Fx, tree, p):
        loc, nrm, fi, d = tree.find_nearest(Vector(p))
        a, b, c = G[Fx[fi]]
        q = np.array(loc[:])
        v0, v1, v2 = b - a, c - a, q - a
        d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01 or 1e-18
        wb = (d11 * d20 - d01 * d21) / den
        wc = (d00 * d21 - d01 * d20) / den
        w = np.clip(np.array([1 - wb - wc, wb, wc]), 0, 1)
        return fi, w / w.sum()

    for p in Vd:
        fi, bw = bary(Wsrc, WF, bvh, p)
        tri = WF[fi]
        dom = tri[int(np.argmax(bw))]
        reg, kind = regs[dom], kinds[dom]
        # 渐变权重：只插值同一区域族的角（跨区域的三角形取主导角的）
        band = {}
        for k in range(3):
            if region_bone(regs[tri[k]]) in family(region_bone(reg)) or regs[tri[k]] == reg:
                for nn, ww in bands[tri[k]].items():
                    band[nn] = band.get(nn, 0.0) + ww * bw[k]
        if not band:
            band = dict(bands[dom])
        auto = None
        if auto_src is not None:
            afi, abw = bary(AG, AF, abvh, p)
            auto = {}
            for k in range(3):
                for nn, ww in AW[AF[afi][k]].items():
                    auto[nn] = auto.get(nn, 0.0) + ww * abw[k]
        vi = len(VW)
        if reg.startswith('coat_') and vside[vi] != 0:
            # 后摆切开以后，缝上的顶点按它所在那一侧的面定左右（位置相同的两份顶点分给两条腿）
            sd = 'l' if vside[vi] > 0 else 'r'
            reg = 'coat_' + sd
            c = float(_blend(f['src']['thigh_' + sd][1] - p[1], spec.get('regions', {}).get('coat_band', 0.12)))
            VW.append(quant4({'thigh_' + sd: c, 'pelvis': 1 - c}))
            st['force'] += 1
        else:
            VW.append(quant4(combine(reg, band, kind, auto, mode, st)))
        VR.append(reg)
    log.setdefault('weights', {})[key] = st
    cc = corner_colours(Vd, Fd, smp, spec.get('colour', {}).get('grade', {}))
    # 拳头烘进绑定姿态（颜色已经按没卷的位置取好了）
    Vd, src = bake_fist(Vd, VW, f, spec, log, key)
    # 顶点按（位置序号, 颜色）拆开：一角一色
    bi = {n: i for i, n in enumerate(hf.NAMES)}
    keymap = {}
    P, J, Wt, C, I = [], [], [], [], []
    for fi, tri in enumerate(Fd):
        ids = []
        for k in range(3):
            v = int(tri[k])
            c = tuple(int(round(x * 65535)) for x in cc[fi, k])
            kk = (v, c)
            if kk not in keymap:
                keymap[kk] = len(P)
                P.append(Vd[v])
                q = VW[v]
                J.append([bi[n] for n, _ in q] + [0] * (4 - len(q)))
                Wt.append([x / 255 for _, x in q] + [0.0] * (4 - len(q)))
                C.append([c[0] / 65535, c[1] / 65535, c[2] / 65535, 1.0])
            ids.append(keymap[kk])
        I.append(ids)
    bones = [(n, p, tuple(float(x) for x in src[n])) for n, p in hf.BONES]
    path = os.path.join(out, '%s_%s_%s.glb' % (name, mode, key))
    nbytes = glbw.write(path, [dict(P=np.array(P), I=np.array(I), J=np.array(J), W=np.array(Wt), C=np.array(C), mat='AIHero', base=[1, 1, 1, 1], name='ai_hero_body')], bones,
                        name='ai_hero', extras=dict(source='cinder ai3d-hero lab', mode=mode, lod=key))
    cnt = {}
    for q in VW:
        for n, _ in q:
            cnt[n] = cnt.get(n, 0) + 1
    log.setdefault('export', {})[os.path.basename(path)] = dict(tris=int(len(Fd)), verts=len(P), bytes=nbytes, bones=len(bones),
                                                               verts_per_bone={k: cnt[k] for k in sorted(cnt)}, regions={r: VR.count(r) for r in sorted(set(VR))})
    log.setdefault('sha256', {})[os.path.basename(path)] = sha256(path)
    return path


def run(o):
    spec = o['spec']
    if not isinstance(spec, dict):
        with open(spec if os.path.isabs(spec) else os.path.join(ROOT, spec), encoding='utf-8') as fh:
            spec = json.load(fh)
    spec = json.loads(json.dumps(spec))
    src = o.get('src') or source_path(spec)
    out = o['out']
    os.makedirs(out, exist_ok=True)
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    log = dict(spec=spec, source_sha256=sha256(src), blender=bpy.app.version_string, numpy=np.__version__)
    d = load(src)
    # 脚本修形（头缩放 / 腿拉长 / 护膝压平）：按位置的变形，同一个函数也套到 UniRig 的权重网格上
    V2, shape_fn, shape_log = hf.predeform(d['V'], d['F'], spec)
    d['V'] = V2
    if shape_log:
        log['shape'] = shape_log
    f = hf.fit(d['V'], d['F'], spec)
    name = 'hero_' + spec['name']
    with open(os.path.join(out, spec['name'] + '-skeleton.txt'), 'w') as fh:
        fh.write(hf.skeleton_txt(f, spec['name']))
    with open(os.path.join(out, spec['name'] + '-skeleton-m.txt'), 'w') as fh:
        fh.write(hf.skeleton_txt(f, spec['name'], native=False))
    log['fit'] = dict(height=f['height'], scale=round(f['scale'], 6), offset=[round(float(x), 6) for x in f['offset']], crotch=round(f['lm']['crotch'], 5),
                      src={n: [round(float(x), 5) for x in f['src'][n]] for n in hf.NAMES},
                      thumb={s: f['lm'][s]['thumb_n'] for s in 'lr'}, wrist_t={s: round(f['lm'][s]['t_wr'] / f['lm'][s]['t_tip'], 4) for s in 'lr'})
    G = d['V'] * f['scale'] + f['offset']
    Wsrc, WF = f['W'], f['WF']
    regs, bands, kinds = source_weights(f, spec)
    log['regions'] = {r: regs.count(r) for r in sorted(set(regs))}
    smp = Sampler(G, d['F'], d)
    mode = o.get('mode') or spec.get('weights', {}).get('mode', 'band')
    auto_src = None
    if mode == 'hybrid':
        wsrc = o.get('weights') or spec.get('weights', {}).get('glb')
        if wsrc and not os.path.isabs(wsrc):
            wsrc = os.path.join(src_root(), wsrc)
        if not wsrc:
            raise RuntimeError('hybrid 要权重 GLB（--weights 或 spec.weights.glb）')
        log['weights_sha256'] = sha256(wsrc)
        auto_src = load_weights(wsrc, f, shape_fn)
    tr = spec.get('tris', {})
    paths = []
    for key, tgt in (('hi', tr.get('hi', 10000)), ('lo', tr.get('lo', 7600))):
        paths.append(build_lod(key, tgt, Wsrc, WF, f, regs, bands, kinds, auto_src, mode, smp, spec, out, name, log))
        print('AI_HERO_LOD', key, log['decimate'][key], flush=True)
    write_provenance(out, spec, src, mode, log, auto_src is not None and (o.get('weights') or spec.get('weights', {}).get('glb')))
    with open(os.path.join(out, 'build-%s.json' % mode), 'w', encoding='utf-8') as fh:
        json.dump(log, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print('AI_HERO_OK', out, mode, flush=True)
    return log


def write_provenance(out, spec, src, mode, log, wsrc):
    """来源记录（golem.provenance.json 的格式）：源 GLB / 概念图 / UniRig 权重只记 sha256（不进仓库）；生成参数照抄源目录的 info.json；
    每种权重模式一份 provenance-<mode>.json"""
    sd = os.path.dirname(src)

    def js(path):
        try:
            with open(path, encoding='utf-8') as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    info = js(os.path.join(sd, 'info.json')) or {}
    gen = {k: info[k] for k in ('prompt', 'negative_prompt', 'seed', 'text_to_image', 'image_to_3d', 'target_faces', 'texture_size', 'comfyui_version', 'generated_at', 'comfyui', 'nodes', 'nvdiffrast', 'weight_sources') if k in info}
    cpath = os.path.join(sd, 'concept.png')
    rec = {
        '_comment': 'AI 主角试验（ai3d-hero，试验分支，不上线）的来源记录。源 GLB、概念图、UniRig 的权重 GLB 都不进仓库，只记 sha256（存放在私有的 cinder-ai-src）；'
                    'art/ai/hero_rig.py 按 art/ai/hero/%s.json 生成这里的 GLB。' % spec['name'],
        'source': dict(name=spec.get('source', {}).get('name'), file='models/%s/%s' % (spec.get('source', {}).get('name'), spec.get('source', {}).get('file', 'model.glb')),
                       sha256=log['source_sha256'], committed=False,
                       concept_image=dict(file='models/%s/concept.png' % spec.get('source', {}).get('name'), sha256=sha256(cpath) if os.path.exists(cpath) else None, committed=False, use='没有用（只用源 GLB 的反照率）')),
        'generation': gen,
        'licences': {
            'outputs': '组件的许可证都不限制生成物（见 cinder-ai-src/README.md 和 game-workspace notes/ai3d/licence-audit.md）；DINOv3 License 要求注明 Built with DINOv3',
            'tools_only': 'ComfyUI GPL-3.0、UniRig 内嵌的 michelangelo GPL-3.0 只在本地当工具跑，不随游戏分发',
        },
        'skinning': None,
        'processing': dict(tool='art/ai/hero_rig.py + art/ai/hero_fit.py + art/ai/glbw.py', blender=log.get('blender'), numpy=log.get('numpy'), mode=mode, spec=spec,
                           shape=log.get('shape'), fit=dict(height=log['fit']['height'], scale=log['fit']['scale'], offset=log['fit']['offset']),
                           decimate=log.get('decimate'), weights=log.get('weights'), coat=log.get('coat'), fist=log.get('fist')),
        'outputs': {k: v for k, v in sorted(log.get('sha256', {}).items()) if ('_%s_' % mode) in k},
        'resemblance': spec.get('resemblance', ''),
    }
    if wsrc:
        ri = js(os.path.join(os.path.dirname(os.path.join(src_root(), wsrc) if not os.path.isabs(wsrc) else wsrc), 'info.json')) or {}
        rec['skinning'] = dict(file=wsrc if not os.path.isabs(wsrc) else os.path.relpath(wsrc, src_root()), sha256=log.get('weights_sha256'), committed=False,
                               **{k: ri[k] for k in ('tool', 'unirig', 'weights', 'params') if k in ri})
    with open(os.path.join(out, 'provenance-%s.json' % mode), 'w', encoding='utf-8') as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=1)


def src_root():
    return os.environ.get('CA_AI_ROOT', os.path.join(os.path.expanduser('~'), 'dev', 'cinder-ai-src'))


def source_path(spec):
    return os.path.join(src_root(), 'models', spec['source']['name'], spec['source']['file'])


def main():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    o = {a[i][2:]: a[i + 1] for i in range(0, len(a) - 1, 2) if a[i].startswith('--')}
    run(o)


if __name__ == '__main__':
    main()
