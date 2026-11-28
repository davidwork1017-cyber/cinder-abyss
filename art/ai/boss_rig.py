# AI 生成的首领外观（ai3d-bosses：雷霆监察者 warden、衔星巨兽 behemoth；熔渣巨像仍用 golem_rig.py，那边不动）：
# 整身源网格 → 对骨架（boss_fit.py）→ 减面 → 分零件 / 算权重 → 取色 → 反照率贴图 → 带骨架和动作的首领 GLB。
# 无头 Blender：
#   blender -b --factory-startup --python-exit-code 1 --python art/ai/boss_rig.py -- --spec art/ai/boss/warden_a01.json --out <目录> [--tris 4860] [--path <glb>]
# 读 / 解码 / 减面 / 取色 / 烘贴图的底层步骤和巨像共用（golem_rig 里的函数，原样调用，巨像的产物不受影响）；这里只加每种首领自己的部分：
#   warden    全刚性：boss_parts.warden 按连通件 + 区域给源网格的三角形贴标签（护手只留左右两只、护盾板挪到环绕半径上摆三块、环多拷一道），
#             减面以后的三角形按最近的源三角形取标签；不动的零件之间共用顶点（接缝上的顶点按两边的面积分权重，不撕开），挪过去 / 拷贝的零件各自一份顶点；
#             眼皮是程序化的两片薄壳（源网格没有）。
#   behemoth  混合：UniRig 的权重（自动蒙皮，源网格自己的坐标）为主，按区域纠正（behemoth_weights）：
#             脖子按链分段、前后腿根只管肩 / 胯、背甲按区域刚性、尾尖、星 / 下颌 / 头和角刚性、蹄子归 _03。
# 拷贝的零件取色时按它原来的位置在源网格上取（顶点带一份「取色位置」），所以贴图和源模型对得上。
# 确定性：不用随机数；减面、标签、权重、取色、展 UV 都是固定算法。
import json
import math
import os
import sys

ART = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ART)
sys.dont_write_bytecode = True

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

from ai import boss_fit as bf  # noqa: E402
from ai import boss_parts as bp  # noqa: E402
from ai import golem_rig as gr  # noqa: E402
from ca import core, rig  # noqa: E402

ROOT = os.path.dirname(ART)


def clips_of(kind):
    import importlib
    return importlib.import_module('ca.boss.%s_clips' % kind).CLIPS


def read_spec(spec):
    if isinstance(spec, dict):
        return json.loads(json.dumps(spec))
    with open(spec if os.path.isabs(spec) else os.path.join(ROOT, spec), encoding='utf-8') as fh:
        return json.load(fh)


def face_colours(d, G, smp):
    """每个源三角形重心那一点的反照率（线性）：三个角的 UV 取平均再查图"""
    uvc = d['UV'].mean(axis=1)
    return np.array([smp.colour(u) for u in uvc])


def nearest_faces(G, F, Q):
    """Q 里每个点在源网格（G, F）上最近的三角形序号"""
    bvh = BVHTree.FromPolygons([tuple(p) for p in G.tolist()], [tuple(t) for t in F.tolist()], all_triangles=True)
    return np.array([bvh.find_nearest(Vector(q))[2] for q in Q.tolist()], dtype=np.int64)


# ---------------------------------------------------------------- warden
def warden_mesh(d, G, smp, f, spec, target, log):
    """返回 (顶点 P, 取色位置 S, 三角形 F, 每个三角形的骨骼名, 每个顶点的 {骨骼: 权重})"""
    W, WF = gr.weld_mesh(G, d['F'])
    col = face_colours(dict(UV=d['UV']), G, smp)
    # weld_mesh 会删掉退化 / 没用到的：按重心重新对一次源三角形的颜色
    Cw = W[WF].mean(axis=1)
    src_idx = nearest_faces(G, d['F'], Cw)
    lab, place, plog = bp.warden(W, WF, col[src_idx], spec)
    log['parts'] = plog
    keep = lab != ''
    K, KF = gr.weld_mesh(W, WF[keep])
    klab = lab[keep]
    Vd, Fd = gr.decimate(K, KF, target, log)
    # 减面后的三角形 → 最近的保留源三角形的标签
    nf = nearest_faces(K, KF, Vd[Fd].mean(axis=1))
    dl = klab[nf]
    Ps, Ss, Fs, Ls = [], [], [], []
    base = 0
    ident = [(s, b) for s, b, M in place if np.allclose(M, np.eye(4))]
    # 单位阵：一份共用顶点
    imap = {s: b for s, b in ident}
    m = np.array([x in imap for x in dl])
    used = np.unique(Fd[m])
    remap = -np.ones(len(Vd), dtype=np.int64)
    remap[used] = np.arange(len(used)) + base
    Ps.append(Vd[used])
    Ss.append(Vd[used])
    Fs.append(remap[Fd[m]])
    Ls += [imap[x] for x in dl[m]]
    base += len(used)
    # 挪过去 / 拷贝的：每次一份顶点
    for s, b, M in place:
        if np.allclose(M, np.eye(4)):
            continue
        m = dl == s
        used = np.unique(Fd[m])
        remap = -np.ones(len(Vd), dtype=np.int64)
        remap[used] = np.arange(len(used)) + base
        Ps.append(bp.xform(M, Vd[used]))
        Ss.append(Vd[used])
        Fs.append(remap[Fd[m]])
        Ls += [b] * int(m.sum())
        base += len(used)
    for b, V, Fl in bp.lids(spec):
        Ps.append(V)
        Ss.append(V)
        Fs.append(Fl + base)
        Ls += [b] * len(Fl)
        base += len(V)
    P, S, F = np.concatenate(Ps), np.concatenate(Ss), np.concatenate(Fs)
    # 权重：每个顶点按相邻三角形的面积分给它们的骨骼（零件内部 = 100% 一根，接缝上两边分）
    ar = np.linalg.norm(np.cross(P[F[:, 1]] - P[F[:, 0]], P[F[:, 2]] - P[F[:, 0]]), axis=1) / 2 + 1e-12
    wts = [dict() for _ in range(len(P))]
    for fi, (tri, b) in enumerate(zip(F.tolist(), Ls)):
        for vi in tri:
            wts[vi][b] = wts[vi].get(b, 0.0) + ar[fi]
    out = []
    for w in wts:
        top = sorted(w.items(), key=lambda kv: (-kv[1], kv[0]))[:4]
        sm = sum(x for _, x in top)
        out.append({k: x / sm for k, x in top if x / sm > 1e-3})
    return P, S, F, Ls, out


# ---------------------------------------------------------------- behemoth
def load_weights(path, f):
    """UniRig 的权重 GLB（源网格自己的坐标）→ (顶点（游戏坐标）, 三角形, 每个顶点 {骨骼: 权重})；骨骼名要在这只首领的骨架里"""
    js, bin_ = gr._glb(path)
    CTn = {5121: (np.uint8, 255), 5123: (np.uint16, 65535), 5125: (np.uint32, 1), 5126: (np.float32, 1)}

    def acc(i, norm=False):
        a = js['accessors'][i]
        bv = js['bufferViews'][a['bufferView']]
        if bv.get('byteStride'):
            raise RuntimeError('权重 GLB 有交错的 bufferView，不支持')
        dt, mx = CTn[a['componentType']]
        k = gr.NC[a['type']]
        arr = np.frombuffer(bin_, dt, a['count'] * k, bv.get('byteOffset', 0) + a.get('byteOffset', 0)).astype(np.float64)
        if a.get('normalized') or (norm and mx > 1):
            arr = arr / mx
        return arr.reshape(a['count'], k) if k > 1 else arr

    V, F, J, Wt = [], [], [], []
    base = 0
    for nd in js['nodes']:
        if 'mesh' not in nd:
            continue
        for pr in js['meshes'][nd['mesh']]['primitives']:
            v = acc(pr['attributes']['POSITION'])
            V.append(v)
            F.append(acc(pr['indices']).astype(np.int64).reshape(-1, 3) + base)
            J.append(acc(pr['attributes']['JOINTS_0']).astype(np.int64))
            Wt.append(acc(pr['attributes']['WEIGHTS_0'], norm=True))
            base += len(v)
    V, F, J, Wt = np.concatenate(V), np.concatenate(F), np.concatenate(J), np.concatenate(Wt)
    names = [js['nodes'][j]['name'] for j in js['skins'][0]['joints']]
    want = {n for n, _, _ in f['bones']}
    bad = sorted(set(names) - want)
    if bad:
        raise RuntimeError('权重 GLB 的骨骼不在 ' + f['kind'] + ' 的骨架里：' + ','.join(bad))
    G = bf.apply(V, f)
    ws = []
    for j, w in zip(J, Wt):
        dd = {}
        for jj, ww in zip(j, w):
            if ww > 0:
                dd[names[jj]] = dd.get(names[jj], 0.0) + float(ww)
        ws.append(dd)
    return G, F, ws


def _chain_w(p, chain, piv):
    """沿一条骨骼链（枢轴连成的折线）按投影位置在相邻两根骨骼之间线性渐变；链头之前 = 第一根，链尾之后 = 最后一根"""
    pts = [np.asarray(piv[n]) for n in chain]
    best = None
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        ab = b - a
        t = float(np.clip((p - a) @ ab / (ab @ ab), 0, 1))
        dd = float(np.linalg.norm(a + t * ab - p))
        if best is None or dd < best[0] - 1e-9:
            best = (dd, i, t)
    _, i, t = best
    if i == 0 and float((p - pts[0]) @ (pts[1] - pts[0])) < 0:
        return {chain[0]: 1.0}
    if t >= 1 and i == len(pts) - 2:
        return {chain[-1]: 1.0}
    # 每段里：前 40% 归段头骨骼，后 60% 向下一根渐变（关节附近才弯）
    u = max(0.0, (t - 0.4) / 0.6)
    u = u * u * (3 - 2 * u)
    out = {chain[i]: 1.0 - u}
    if u > 1e-3:
        out[chain[i + 1]] = out.get(chain[i + 1], 0.0) + u
    return out


def _mix(a, b, t):
    out = {}
    for k, v in a.items():
        out[k] = out.get(k, 0.0) + v * (1 - t)
    for k, v in b.items():
        out[k] = out.get(k, 0.0) + v * t
    return out


def behemoth_weights(P, auto, f, spec, log):
    """衔星巨兽的混合权重（每个顶点 {骨骼: 权重}，最多 4 根）：
    1. 刚性区域：星（x_star 周围的球）、下颌盒、头和角（脖子末端之前），蹄子（低于 hoof_y）、尾尖（尾链最后一段之后）、背甲（背线以上、按 z 分三段）；
    2. 躯干（腿根以上、尾巴之前、脖子之后）：沿 pelvis → spine_01 → spine_02 → spine_03 的链按 z 渐变；脖子：沿 spine_03 → neck_01 → x_neck_02 → x_neck_03 → head 渐变；
    3. 腿：UniRig 的权重只留腿链自己的骨骼；腿根以上 blend 米之内和躯干的链权重渐变过去（腿根不再拖胸口）；
    4. 尾巴：UniRig 的尾链权重。"""
    o = spec['weights']
    piv = f['src']
    st = dict()
    out = []
    TORSO = ['pelvis', 'spine_01', 'spine_02', 'spine_03']
    NECK = ['spine_03', 'neck_01', 'x_neck_02', 'x_neck_03', 'head']
    TAIL = ['pelvis', 'x_tail_01', 'x_tail_02', 'x_tail_03', 'x_tail_04']
    LEGS = {'fl': ['x_fleg_l_01', 'x_fleg_l_02', 'x_fleg_l_03'], 'fr': ['x_fleg_r_01', 'x_fleg_r_02', 'x_fleg_r_03'],
            'hl': ['x_hleg_l_01', 'x_hleg_l_02', 'x_hleg_l_03'], 'hr': ['x_hleg_r_01', 'x_hleg_r_02', 'x_hleg_r_03']}
    legbone = {b: k for k, v in LEGS.items() for b in v}
    sr = o['star']
    jw = o['jaw']
    hd = o['head']
    pl = o['plates']
    tl = o['tail']
    lg = o['legs']

    def cnt(k):
        st[k] = st.get(k, 0) + 1

    for p, w in zip(P, auto):
        x, y, z = p
        if np.linalg.norm(p - np.asarray(sr['c'])) < sr['r'] and z >= sr['z0']:
            out.append({'x_star': 1.0}); cnt('star'); continue
        if jw['box'][0] <= abs(x) <= jw['box'][1] and jw['box'][2] <= y <= jw['box'][3] and jw['box'][4] <= z <= jw['box'][5]:
            out.append({'x_jaw': 1.0}); cnt('jaw'); continue
        if (z >= hd['z0'] and y >= hd['y0']) or (y >= hd['gear_y'] and z >= hd['gear_z']):
            out.append({'head': 1.0}); cnt('head'); continue  # 头、下巴以上，加上额甲和两只角（高、靠前）
        dom = max(sorted(w), key=lambda k: w[k]) if w else 'pelvis'
        # 腿：主导骨在腿链上、而且低于腿根以上 blend
        leg = legbone.get(dom)
        if leg is not None and y >= lg['below_y']:
            # 腿上半截：离这条腿的膝（_02 枢轴）水平距离超过 radius 的（胸口、肚子）不算腿
            q = piv[LEGS[leg][1]]
            if math.hypot(x - q[0], z - q[2]) > lg['radius']:
                leg = None
                dom = None
        if leg is None:
            # 腿下半截（低于 below_y）却没归到腿上：按 x / z 的象限归最近的腿
            if y < lg['below_y']:
                k = ('f' if z > lg['split_z'] else 'h') + ('l' if x > 0 else 'r')
                leg = k
        if leg is not None:
            ch = LEGS[leg]
            root_y = piv[ch[0]][1]
            if y < lg['hoof_y']:
                out.append({ch[2]: 1.0}); cnt('hoof'); continue
            lw = {k: v for k, v in w.items() if k in ch}
            if not lw:
                lw = _chain_w(p, ch, piv)
            sm = sum(lw.values())
            lw = {k: v / sm for k, v in lw.items()}
            top = root_y - lg['blend']
            if y > top:
                # 腿根以上：渐变到躯干链（腿根只管肩 / 胯一圈）
                t = min(1.0, (y - top) / (lg['blend'] + lg['above']))
                t = t * t * (3 - 2 * t)
                tw = _chain_w(p, TORSO, piv)
                lw = _mix(lw, tw, t)
                cnt('leg_root_blend')
            else:
                cnt('leg')
            out.append(lw); continue
        # 背甲：背线以上（y ≥ y0 + slope·z 的直线以上）按 z 分段
        if y >= pl['y0'] + pl['slope'] * z and pl['z'][0] <= z <= pl['z'][-1]:
            k = 1 if z >= pl['z'][1] else (2 if z >= pl['z'][2] else 3)
            out.append({'x_plate_%02d' % k: 1.0}); cnt('plate'); continue
        # 尾巴：在 tail.z0 之后
        if z <= tl['z0']:
            if z <= tl['tip_z'] and y <= tl['tip_y']:
                out.append({'x_tail_04': 1.0}); cnt('tail_tip'); continue
            out.append(_chain_w(p, TAIL, piv)); cnt('tail'); continue
        # 脖子：在 neck.z0 之前（脖子 / 头之间）
        if z >= o['neck']['z0']:
            out.append(_chain_w(p, NECK, piv)); cnt('neck'); continue
        out.append(_chain_w(p, TORSO, piv)); cnt('torso')
    res = []
    for w in out:
        top = sorted(w.items(), key=lambda kv: (-kv[1], kv[0]))[:4]
        sm = sum(x for _, x in top)
        res.append({k: x / sm for k, x in top if x / sm > 1e-3})
    log['weights'] = st
    return res


def behemoth_mesh(d, G, smp, f, spec, target, log, wsrc):
    W, WF = gr.weld_mesh(G, d['F'])
    Vd, Fd = gr.decimate(W, WF, target, log)
    auto = gr.transfer_weights(Vd, load_weights(wsrc, f))
    wts = behemoth_weights(Vd, auto, f, spec, log)
    labs = []
    for tri in Fd.tolist():
        acc = {}
        for vi in tri:
            for k, v in wts[vi].items():
                acc[k] = acc.get(k, 0.0) + v
        labs.append(max(sorted(acc), key=lambda k: acc[k]))
    return Vd, Vd, Fd, labs, wts


# ---------------------------------------------------------------- colour
def glow_w(lin, rules):
    """发光权重 0–1：按候选参数里的规则（sRGB 色相范围、最低饱和度、最低亮度），满足任一条就按超过阈值的程度给权重"""
    r, g, b = gr.l2s(lin)
    mx, mn = max(r, g, b), min(r, g, b)
    if mx <= 0 or mx - mn < 1e-6:
        return 0.0
    if mx == r:
        hue = (60 * ((g - b) / (mx - mn))) % 360
    elif mx == g:
        hue = 60 * ((b - r) / (mx - mn)) + 120
    else:
        hue = 60 * ((r - g) / (mx - mn)) + 240
    sat = (mx - mn) / mx
    best = 0.0
    for ru in rules:
        h0, h1 = ru['hue']
        if not (h0 <= hue <= h1) or sat < ru['sat'] or mx < ru['val']:
            continue
        w = min(1.0, (sat - ru['sat']) / ru.get('sat_ramp', 0.2) + 0.5) * min(1.0, (mx - ru['val']) / ru.get('val_ramp', 0.2) + 0.5)
        best = max(best, w)
    return float(best)


def _hue_sat(lin):
    r, g, b = gr.l2s(lin)
    mx, mn = max(r, g, b), min(r, g, b)
    if mx <= 0 or mx - mn < 1e-6:
        return 0.0, 0.0
    if mx == r:
        hue = (60 * ((g - b) / (mx - mn))) % 360
    elif mx == g:
        hue = 60 * ((b - r) / (mx - mn)) + 120
    else:
        hue = 60 * ((r - g) / (mx - mn)) + 240
    return hue, (mx - mn) / mx


def _hsv2rgb(h, s, v):
    h = (h % 360) / 60.0
    i = int(h) % 6
    f = h - int(h)
    p_, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    return [(v, t, p_), (q, v, p_), (p_, v, t), (p_, q, v), (t, p_, v), (v, p_, q)][i]


def bgrade(col, g):
    """golem_rig.grade 之后再加一道肩部（colour.grade.knee = [k, 斜率]，sRGB 里高于 k 的部分按斜率压）：暗部靠 lift 提起来、亮部不顶上去"""
    out = gr.grade(col, g)
    kn = g.get('knee')
    if kn:
        sv = gr.l2s(out)
        sv = np.where(sv > kn[0], kn[0] + (sv - kn[0]) * kn[1], sv)
        out = gr.s2l(sv)
    return out


def region_adjust(p, col, spec):
    """按位置（和颜色）调色：colour.regions = [{box: [|x|0, |x|1, y0, y1, z0, z1], gain（可选）, hue: [h0, h1]（可选，只动色相在范围里的）, sat（最低饱和度）,
    hue_to（可选：色相改成这个，亮度不变）, sat_mul（可选：饱和度乘）}]，|x| 按左右对称算，先于 grade。比如压暗巨兽青色的角、把监察者偏粉的青铜拉回金色"""
    out = np.asarray(col, dtype=np.float64)
    for rg in spec.get('colour', {}).get('regions', []):
        b = rg['box']
        if not (b[0] <= abs(p[0]) <= b[1] and b[2] <= p[1] <= b[3] and b[4] <= p[2] <= b[5]):
            continue
        h, sa = _hue_sat(out)
        if 'hue' in rg and not (rg['hue'][0] <= h <= rg['hue'][1] and sa >= rg.get('sat', 0.0)):
            continue
        if 'hue_to' in rg or 'sat_mul' in rg:
            v = float(np.max(gr.l2s(out)))
            out = gr.s2l(np.array(_hsv2rgb(rg.get('hue_to', h), min(1.0, sa * rg.get('sat_mul', 1.0)), v)))
        out = out * rg.get('gain', 1.0)
    return out


def corner_colours(P, S, F, labs, smp, spec, log):
    """每个角：三角形上 15 个采样点（在取色位置上取）按重心权重平方加权；发光：只在 colour.glow.bones 列出的骨骼上按规则判，colour.glow.force 列出的骨骼整块发光"""
    c = spec.get('colour', {})
    g = c.get('grade', {})
    gl = c.get('glow', {})
    rules = gl.get('rules', [])
    allow = set(gl.get('bones', []))
    force = set(gl.get('force', []))
    out = {}
    nfire = 0
    Wg = np.array(gr.GRID) ** 2
    for fi, (tri, lb) in enumerate(zip(F.tolist(), labs)):
        Q = S[tri]
        pts = [w[0] * Q[0] + w[1] * Q[1] + w[2] * Q[2] for w in gr.GRID]
        cols = []
        for q in pts:
            cl = smp.at(q)
            cols.append(region_adjust(q, cl, spec))
        cols = np.array(cols)
        if lb in force:
            fw = np.ones(len(cols))
        elif lb in allow:
            fw = np.array([glow_w(cl, rules) for cl in cols])
        else:
            fw = np.zeros(len(cols))
        calm = fw < 0.3
        for k in range(3):
            wk = Wg[:, k] / Wg[:, k].sum()
            gk = float(wk @ fw)
            if gk > 0.5:
                nfire += 1
                col = wk @ cols
            elif calm.sum() >= 3:
                wr = wk * calm
                col = (wr / wr.sum()) @ cols
            else:
                col = wk @ cols
            out[(fi, k)] = (bgrade(col, g), gk)
    log['colour'] = dict(fire_corners=nfire, grade=g)
    return out


def bake_texture(bm, S, F, smp, spec, out_path, log):
    """和 golem_rig.bake_texture 一样（Smart UV Project + 每个像素在源网格上取色），只是取色位置用 S（拷贝的零件按原来的位置取）"""
    t = spec.get('tex', {})
    N = t.get('px', 512)
    g = spec.get('colour', {}).get('grade', {})
    me = bpy.data.meshes.new('uvtmp')
    bm.to_mesh(me)
    ob = bpy.data.objects.new('uvtmp', me)
    bpy.context.scene.collection.objects.link(ob)
    for o in bpy.context.scene.objects:
        o.select_set(o is ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(t.get('angle', 60)), island_margin=t.get('margin', 0.006), area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    uvl = me.uv_layers[0].data
    UVn = np.array([[uvl[li].uv[:] for li in p.loop_indices] for p in me.polygons])
    img = np.zeros((N, N, 3))
    mask = np.zeros((N, N), dtype=bool)
    for fi, tri in enumerate(F.tolist()):
        Q = S[tri]
        T = UVn[fi] * N
        x0, y0 = np.floor(T.min(0)).astype(int)
        x1, y1 = np.ceil(T.max(0)).astype(int)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(N - 1, x1), min(N - 1, y1)
        (ax, ay), (bx, by), (cx, cy) = T
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        e = -0.6 / max(1.0, math.sqrt(abs(den)))
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                X, Y = xx + 0.5, yy + 0.5
                w0 = ((by - cy) * (X - cx) + (cx - bx) * (Y - cy)) / den
                w1 = ((cy - ay) * (X - cx) + (ax - cx) * (Y - cy)) / den
                w2 = 1 - w0 - w1
                if w0 < e or w1 < e or w2 < e:
                    continue
                w = np.clip([w0, w1, w2], 0, 1)
                w = w / w.sum()
                q = w @ Q
                cl = smp.at(q)
                img[yy, xx] = bgrade(region_adjust(q, cl, spec), g)
                mask[yy, xx] = True
    for _ in range(t.get('dilate', 8)):
        acc = np.zeros_like(img)
        cnt = np.zeros((N, N))
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            sm = np.roll(mask, (dy, dx), (0, 1))
            acc += np.roll(img, (dy, dx), (0, 1)) * sm[..., None]
            cnt += sm
        nw = (~mask) & (cnt > 0)
        img[nw] = acc[nw] / cnt[nw][:, None]
        mask |= nw
    srgb = gr.l2s(img)
    im = bpy.data.images.new('ai_tex_out', N, N, alpha=False)
    rgba = np.ones((N, N, 4), dtype=np.float32)
    rgba[..., :3] = np.round(srgb * 255) / 255
    im.pixels.foreach_set(rgba.ravel())
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = t.get('quality', 90)
    sc.render.image_settings.color_mode = 'RGB'
    im.save_render(out_path, scene=sc)
    bpy.data.images.remove(im)
    bpy.data.objects.remove(ob)
    log['tex'] = dict(px=N, coverage=round(float(mask.mean()), 4))
    return UVn


# ---------------------------------------------------------------- export
def export(ob, f, wts, P, path, log):
    names = [n for n, _, _ in f['bones']]
    skel = rig.Skel([(n, p, tuple(float(x) for x in f['src'][n])) for n, p, _ in f['bones']])
    # 顶点权重：网格的顶点顺序和 P 一样（bmesh 按顺序建点），按序号取；rig.skin 的 custom 按位置问，
    # 位置用和它一样的换算（(co.x, co.z, -co.y)）当键，重合的顶点权重不同就取平均
    if len(ob.data.vertices) != len(wts):
        raise RuntimeError('网格顶点 %d 和权重 %d 对不上' % (len(ob.data.vertices), len(wts)))
    wmap = {}
    for v in ob.data.vertices:
        k = (v.co.x, v.co.z, -v.co.y)
        w = wts[v.index]
        if k in wmap and wmap[k] != w:
            m = {}
            for dd in (wmap[k], w):
                for kk, vv in dd.items():
                    m[kk] = m.get(kk, 0.0) + vv / 2
            w = m
        wmap[k] = w
    for k in ('lab', 'cap'):
        if k in ob.data.attributes:
            ob.data.attributes.remove(ob.data.attributes[k])
    bind = []
    for v in ob.data.vertices:
        w = wmap[(v.co.x, v.co.z, -v.co.y)]
        bind.append((max(sorted(w), key=lambda kk: w[kk]), True))
    arm = rig.armature(skel, ob.name)
    count = rig.skin(ob, arm, skel, bind, [], lambda p, b: wmap[p])
    meta = rig.key_clips(arm, skel, clips_of(f['kind']))
    rig.export_glb(ob, arm, path, meta)
    log.setdefault('export', {})[os.path.basename(path)] = dict(bones=len(names), verts_per_bone={k: count[k] for k in sorted(count)}, unused=[n for n in names if n not in count])
    return arm


def run(o):
    """o：spec、src（缺省 CA_AI_ROOT 下 models/<候选>/model.glb）、out、tris（三角形上限，缺省 spec 的 tris / 8000）、texpx、name、path、weights（UniRig 权重 GLB）"""
    spec = read_spec(o['spec'])
    if o.get('texpx'):
        spec.setdefault('tex', {})['px'] = int(o['texpx'])
    if o.get('tris'):
        spec['tris'] = int(o['tris'])
    kind = spec['kind']
    src = o.get('src') or gr.source_path(spec)
    out = o['out']
    os.makedirs(out, exist_ok=True)
    core.reset_scene()
    log = dict(spec=spec, source_sha256=gr.sha256(src), blender=bpy.app.version_string)
    d = gr.load(src)
    f = bf.fit(d['V'], d['F'], spec)
    G = bf.apply(d['V'], f)
    log['fit'] = dict(height=round(float(f['height']), 5), scale=[round(float(x), 6) for x in f['scale']], offset=[round(float(x), 6) for x in f['offset']],
                      yaw=spec.get('fit', {}).get('yaw', 0.0), src={n: [round(float(x), 5) for x in f['src'][n]] for n, _, _ in f['bones']})
    smp = gr.Sampler(G, d['F'], d['UV'], d['img'])
    # 最后整体缩放（spec 的 post = [x, y, z]：零件 / 权重都按源网格对好的坐标算完以后再放大，监察者水平放大让占地和原来的差不多，
    # 巨兽沿身长拉长让出手那一帧的头 / 嘴接近预警）：顶点、骨骼枢轴、芯的位置跟着缩放；取色位置不动（贴图跟着拉伸）
    post = np.array(spec.get('post', [1.0, 1.0, 1.0]), dtype=np.float64)
    if not np.allclose(post, 1.0):
        for n in f['src']:
            f['src'][n] = f['src'][n] * post
        cs = spec.get('colour', {}).get('core')
        if cs:
            cs['c'] = [float(v) for v in np.asarray(cs['c']) * post]
        log['fit']['post'] = post.tolist()
        log['fit']['src'] = {n: [round(float(x), 5) for x in f['src'][n]] for n, _, _ in f['bones']}
    budget = spec.get('tris', 8000)
    target = int(spec.get('decimate', {}).get(str(budget), budget * 0.92))
    wsrc = o.get('weights') or spec.get('weights', {}).get('glb')
    if wsrc and not os.path.isabs(wsrc):
        wsrc = os.path.join(gr.src_root(), wsrc)
    if wsrc:
        log['weights_sha256'] = gr.sha256(wsrc)
    for attempt in range(5):
        if kind == 'warden':
            P, S, F, labs, wts = warden_mesh(d, G, smp, f, spec, target, log)
        elif kind == 'behemoth':
            P, S, F, labs, wts = behemoth_mesh(d, G, smp, f, spec, target, log, wsrc)
        else:
            raise RuntimeError('boss_rig 不认识 ' + kind)
        P = P * post
        print('AI_BOSS_TRY', attempt, 'target', target, 'tris', len(F), flush=True)
        if budget - 60 <= len(F) <= budget or (len(F) <= budget and attempt == 4):
            break
        target = int(target * (budget - 30) / len(F))
    if len(F) > budget:
        raise RuntimeError('三角形 %d 超过上限 %d' % (len(F), budget))
    log['tris'] = int(len(F))
    names = [n for n, _, _ in f['bones']]
    bm = gr.to_bm(P, F)
    if len(bm.faces) != len(F):
        raise RuntimeError('有重复 / 退化的三角形：%d → %d' % (len(F), len(bm.faces)))
    L = bm.faces.layers.int.new('lab')
    Lc = bm.faces.layers.int.new('cap')
    for fc, lb in zip(bm.faces, labs):
        fc[L] = names.index(lb)
        fc[Lc] = 0
    name = o.get('name') or 'ca_boss_' + kind + '_' + spec['name']
    cc = corner_colours(P, S, F, labs, smp, spec, log)
    tex_path = os.path.join(out, 'albedo.jpg')
    UVn = bake_texture(bm, S, F, smp, spec, tex_path, log)
    # 近白的芯自己挑（golem_rig.build_object 那一套按距离从近到远累计面积，减面很粗时第一块就超出很多）：
    # 发光三角形按离 core.c 的距离从近到远，单块面积超过预算 1.5 倍的跳过，累计到发光总面积的 frac 为止
    sp2 = json.loads(json.dumps(spec))
    cs = sp2.get('colour', {}).pop('core', None)
    ob = gr.build_object(bm, L, Lc, cc, name, 'tex', f, sp2, log, tex_path)
    if cs:
        c0 = np.asarray(cs['c'], dtype=np.float64)
        gl = []
        for fi, tri in enumerate(F.tolist()):
            if all(cc[(fi, k)][1] > 0.5 for k in range(3)):
                a, b, c = P[tri]
                gl.append((round(float(np.linalg.norm((a + b + c) / 3 - c0)), 6), fi, float(np.linalg.norm(np.cross(b - a, c - a)) / 2)))
        tot = sum(x[2] for x in gl)
        budget_a = cs.get('frac', 0.02) * tot
        core_f, acc = [], 0.0
        for dd, fi, ar in sorted(gl):
            if acc >= budget_a:
                break
            if ar > 1.5 * budget_a:
                continue
            core_f.append(fi)
            acc += ar
        colat = ob.data.color_attributes['Col'].data
        for fi in core_f:
            for li in ob.data.polygons[fi].loop_indices:
                r_, g_, b_, _ = colat[li].color
                colat[li].color = (r_, g_, b_, 0.0)
        log['core'] = dict(faces=len(core_f), area=round(acc, 5), glow_area=round(tot, 5))
    uvl = ob.data.uv_layers['UVMap'].data
    for p in ob.data.polygons:
        for k, li in enumerate(p.loop_indices):
            uvl[li].uv = tuple(UVn[p.index][k])
    path = o.get('path') or os.path.join(out, '%s_%s.glb' % (kind, spec['name']))
    export(ob, f, wts, P, path, log)
    log.setdefault('sha256', {})[os.path.basename(path)] = gr.sha256(path)
    log['sha256']['albedo.jpg'] = gr.sha256(tex_path)
    with open(os.path.join(out, 'build.json'), 'w', encoding='utf-8') as fh:
        json.dump(log, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print('AI_BOSS_OK', out, 'tris', log['tris'], flush=True)
    return log


def main():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    o = {a[i][2:]: a[i + 1] for i in range(0, len(a) - 1, 2) if a[i].startswith('--')}
    run(o)


if __name__ == '__main__':
    main()
