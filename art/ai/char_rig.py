# AI 生成的小怪外观（ai3d-spitter：喷吐者）：源网格 → 对到游戏现有的蜘蛛骨架（char_fit.py）→ 减面 → 分段刚性绑定 → 取色（每角一色）→ 写 GLB。
# 无头 Blender：
#   blender -b --factory-startup --python-exit-code 1 --python art/ai/char_rig.py -- --spec art/ai/char/spitter_a03.json --out <glb> [--anims 0]
# 输出的 GLB 和 tools/convert-chars.mjs 的格式一样（游戏端 world.js 的 cParse 读）：骨骼节点、蒙皮、绑定姿态原样取自骨架 GLB（spec.skeleton），
# 动作默认也原样拷过来（--anims 0：不带动作，只有骨架 + 蒙皮 + 网格，给换成自己的动作以后去掉 Quaternius 的数据用）；
# 网格换成两块：Material = 身体（COLOR_0 每角的反照率，线性）、Material.001 = 腹背上的囊和眼（游戏端按元素色发光）。
# 读 / 减面 / 取样 / 调色的底层函数调 art/ai/golem_rig.py（巨像的产物不受影响）。确定性：不用随机数，同一台机器同一个 Blender 版本两次构建逐字节相同。
import hashlib
import json
import math
import os
import struct
import sys

ART = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ART)
sys.dont_write_bytecode = True

import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

from ai import char_fit as cf  # noqa: E402
from ai import golem_rig as gr  # noqa: E402
from ca import core  # noqa: E402

ROOT = os.path.dirname(ART)


def smooth(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def hue_sat_val(lin):
    r, g, b = gr.l2s(lin)
    mx, mn = max(r, g, b), min(r, g, b)
    if mx <= 0 or mx - mn < 1e-6:
        return 0.0, 0.0, mx
    if mx == r:
        h = (60 * ((g - b) / (mx - mn))) % 360
    elif mx == g:
        h = 60 * ((b - r) / (mx - mn)) + 120
    else:
        h = 60 * ((r - g) / (mx - mn)) + 240
    return h, (mx - mn) / mx, mx


def grade(col, g):
    """golem_rig.grade 之后再加一道肩部（grade.knee = [k, 斜率]，sRGB 里高于 k 的部分按斜率压）：暗的甲壳提起来、亮的不顶上去"""
    out = gr.grade(col, g)
    kn = g.get('knee')
    if kn:
        sv = gr.l2s(out)
        sv = np.where(sv > kn[0], kn[0] + (sv - kn[0]) * kn[1], sv)
        out = gr.s2l(sv)
    return out


def _hsv2rgb(h, s, v):
    h = (h % 360) / 60.0
    i = int(h) % 6
    f = h - int(h)
    p_, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    return np.array([(v, t, p_), (q, v, p_), (p_, v, t), (p_, q, v), (t, p_, v), (v, p_, q)][i])


def shift(col, o):
    """甲壳换色相（colour.shift = {hue, sat, keep: [{hue: [h0, h1], sat}]}）：亮度不变，色相改成 hue、饱和度改成 sat；
    keep 里列的颜色（色相在范围里、饱和度够的：暖黄的囊和眼、浅色的关节环）不动"""
    if not o:
        return col
    h, sa, v = hue_sat_val(col)
    for kp in o.get('keep', []):
        if kp['hue'][0] <= h <= kp['hue'][1] and sa >= kp['sat']:
            return col
    return gr.s2l(_hsv2rgb(o['hue'], o['sat'], v))


def nearest(G, F, Q):
    bvh = BVHTree.FromPolygons([tuple(p) for p in G.tolist()], [tuple(t) for t in F.tolist()], all_triangles=True)
    return np.array([bvh.find_nearest(Vector(q))[2] for q in Q.tolist()], dtype=np.int64)


def seg_xform(A, B, a, b, rk):
    """源的一段 A→B 映到骨骼 a→b：沿轴拉伸到 |ab|、横向乘 rk（身体的缩放，腿的粗细跟身体一致），转过去"""
    d = B - A
    L = np.linalg.norm(d)
    u = d / L
    R = cf._rot(d, b - a)
    s = np.linalg.norm(b - a) / L

    def f(P):
        q = P - A
        ax = (q @ u)[:, None] * u
        return a + (ax * s + (q - ax) * rk) @ R.T
    return f


def build(o):
    spec = o['spec']
    if not isinstance(spec, dict):
        with open(spec if os.path.isabs(spec) else os.path.join(ROOT, spec), encoding='utf-8') as fh:
            spec = json.load(fh)
    spec = json.loads(json.dumps(spec))
    src = o.get('src') or gr.source_path(spec)
    core.reset_scene()
    log = dict(spec=spec, source_sha256=gr.sha256(src))
    d = gr.load(src)
    G = d['V']  # 源坐标（不缩放，取色用）
    smp = gr.Sampler(G, d['F'], d['UV'], d['img'])
    skp = os.path.join(ROOT, spec['skeleton'])
    sk, skjs, skbin = cf.skeleton(skp)
    W, WF = gr.weld_mesh(G, d['F'])
    f = cf.fit(W, WF, spec, sk)
    k, t = f['k'], f['t']
    log['fit'] = dict(k=round(k, 6), t=[round(float(x), 6) for x in t], assign=f['assign'])
    o_ = spec['fit']
    comp = f['comp']
    C = W[WF].mean(axis=1)
    # 源三角形的标签：身体分三段（z），腿按连通件；身体那个连通件里粘着的后腿（低于 cut.y、在 cut.z 之后、离中线超过 cut.x）删掉
    bz = o_['body']
    lab = np.array([''] * len(WF), dtype=object)
    body = comp == 0
    lab[body & (C[:, 2] >= bz['head_z'])] = 'Head'
    lab[body & (C[:, 2] < bz['head_z']) & (C[:, 2] >= bz['abd_z'])] = 'Thorax'
    lab[body & (C[:, 2] < bz['abd_z'])] = 'Abdomen'
    cut = o_['cut']
    lab[body & (C[:, 1] < cut['y']) & (C[:, 2] < cut['z']) & (np.abs(C[:, 0]) > cut['x'])] = ''
    for kk in f['legs']:
        lab[comp == kk] = 'leg%d' % kk
    keep = lab != ''
    K, KF = gr.weld_mesh(W, WF[keep])
    klab = lab[keep]
    budget = spec.get('tris', 2700)
    nback = sum(1 for x in klab if x == 'leg%d' % f['assign']['BackLegL'] or x == 'leg%d' % f['assign']['BackLegR'])
    target = int(spec.get('decimate', budget * len(klab) / (len(klab) + nback) * 0.97))
    for attempt in range(5):
        Vd, Fd = gr.decimate(K, KF, target, log)
        nf = nearest(K, KF, Vd[Fd].mean(axis=1))
        dl = klab[nf]
        nb = sum(int((dl == 'leg%d' % f['assign']['BackLeg' + s]).sum()) for s in ('L', 'R'))
        tris = len(Fd) + nb
        print('AI_CHAR_TRY', attempt, 'target', target, 'tris', tris, flush=True)
        if budget - 40 <= tris <= budget or (tris <= budget and attempt == 4):
            break
        target = int(target * (budget - 20) / tris)
    if tris > budget:
        raise RuntimeError('三角形 %d 超过上限 %d' % (tris, budget))
    names = [skjs['nodes'][ni]['name'] for ni in skjs['skins'][0]['joints']]
    JI = {n: i for i, n in enumerate(names)}
    band = o_.get('band', 0.03)
    # 输出：每个三角形三个角各一个顶点（每角一色）；位置 = 变换后的，取色位置 = 源坐标
    outP, outS, outJ, outW, outLab = [], [], [], [], []

    def emit(fi_list, xf):
        for fi in fi_list:
            tri = Fd[fi]
            Ps, Js, Ws = xf(Vd[tri])
            outP.append(Ps)
            outS.append(Vd[tri])
            outJ.append(Js)
            outW.append(Ws)

    def body_xf(bone):
        def xf(P):
            return P * k + t, [[JI[bone]]] * 3, [[1.0]] * 3
        return xf

    def leg_xf(kk, L, s):
        M = f['legs'][kk]['marks']
        foot = sk[cf.foot_name(L, s, sk)]
        Sk = [sk[L + s], sk[L + '2' + s], sk[L + '3' + s], foot]
        bones = [JI[L + s], JI[L + '2' + s], JI[L + '3' + s]]
        fs = [seg_xform(M[i], M[i + 1], Sk[i], Sk[i + 1], k) for i in range(3)]
        lens = [np.linalg.norm(M[i + 1] - M[i]) for i in range(3)]

        def xf(P):
            seg, tt, _ = cf.leg_param(P, M)
            outp, js, ws = [], [], []
            for p, i, u in zip(P, seg, tt):
                # 关节两边 band 米之内两段渐变：段尾（u→1）往下一段过渡，段头（u→0）往上一段过渡
                dist_end = (1 - u) * lens[i]
                dist_start = u * lens[i]
                if i < 2 and dist_end < band:
                    w = 0.5 * smooth(1 - dist_end / band)
                    a, b = i, i + 1
                elif i > 0 and dist_start < band:
                    w = 0.5 * smooth(1 - dist_start / band)
                    a, b = i, i - 1
                else:
                    w = 0.0
                    a, b = i, i
                pa = fs[a](p[None])[0]
                pb = fs[b](p[None])[0]
                outp.append(pa * (1 - w) + pb * w)
                if w > 1e-4 and a != b:
                    js.append([bones[a], bones[b]])
                    ws.append([1 - w, w])
                else:
                    js.append([bones[a]])
                    ws.append([1.0])
            return np.array(outp), js, ws
        return xf

    for bone in ('Head', 'Thorax', 'Abdomen'):
        emit(np.where(dl == bone)[0], body_xf(bone))
    for s in ('L', 'R'):
        for L in cf.LEGS:
            kk = f['assign'][L + s]
            emit(np.where(dl == 'leg%d' % kk)[0], leg_xf(kk, L, s))
    P = np.stack(outP)  # (m, 3, 3)
    S = np.stack(outS)
    m = len(P)
    log['tris'] = m
    # 取色：每个角在三角形上 15 个采样点按重心权重平方加权（取色位置）；发光（囊、眼）：采样的颜色在 glow 规则里的占多数的三角形
    c = spec.get('colour', {})
    g = c.get('grade', {})
    gl = c.get('glow', {})
    Wg = np.array(gr.GRID) ** 2
    cols = np.zeros((m, 3, 3))
    glow = np.zeros(m, dtype=bool)
    for fi in range(m):
        Q = S[fi]
        cs = np.array([smp.at(w[0] * Q[0] + w[1] * Q[1] + w[2] * Q[2]) for w in gr.GRID])
        isg = []
        for cl in cs:
            h, sa, v = hue_sat_val(cl)
            isg.append(gl['hue'][0] <= h <= gl['hue'][1] and sa >= gl['sat'] and v >= gl['val'])
        glow[fi] = np.mean(isg) > 0.5
        for kq in range(3):
            wk = Wg[:, kq] / Wg[:, kq].sum()
            cols[fi, kq] = shift(grade(wk @ cs, g), c.get('shift'))
    log['glow_tris'] = int(glow.sum())
    # 写 GLB
    out = o['out']
    write_glb(out, skjs, skbin, P, cols, outJ, outW, glow, anims=o.get('anims', '1') not in ('0', 'false', 'no'))
    log['sha256'] = gr.sha256(out)
    log['ymax'] = float(P[..., 1].max())
    print('AI_CHAR_OK', out, 'tris', m, 'glow', int(glow.sum()), 'ymax', round(log['ymax'], 4), flush=True)
    if o.get('log'):
        with open(o['log'], 'w', encoding='utf-8') as fh:
            json.dump(log, fh, ensure_ascii=False, indent=1, sort_keys=True)
    return log


def write_glb(path, skjs, skbin, P, cols, Js, Ws, glow, anims=True):
    """骨架 GLB 的节点 / 蒙皮 / 绑定姿态（+ 动作）原样留着，网格换成 身体（Material，带 COLOR_0）+ 发光（Material.001）两个图元"""
    bufs = []
    views = []
    accs = []

    def add(arr, ctype, typ, target=None, minmax=False, normalized=False):
        b = arr.tobytes()
        off = sum(len(x) for x in bufs)
        pad = (-off) % 4
        if pad:
            bufs.append(b'\0' * pad)
            off += pad
        bufs.append(b)
        bv = dict(buffer=0, byteOffset=off, byteLength=len(b))
        if target:
            bv['target'] = target
        views.append(bv)
        nc = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[typ]
        a = dict(bufferView=len(views) - 1, componentType=ctype, count=int(arr.size // nc), type=typ)
        if normalized:
            a['normalized'] = True
        if minmax:
            r = arr.reshape(-1, nc)
            a['min'] = [float(x) for x in r.min(axis=0)]
            a['max'] = [float(x) for x in r.max(axis=0)]
        accs.append(a)
        return len(accs) - 1

    def copy_acc(i):
        a = skjs['accessors'][i]
        bv = skjs['bufferViews'][a['bufferView']]
        nc = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
        dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]
        arr = np.frombuffer(skbin, dt, a['count'] * nc, bv.get('byteOffset', 0) + a.get('byteOffset', 0)).copy()
        j = add(arr, a['componentType'], a['type'], minmax=('min' in a))
        if 'min' in a:
            accs[j]['min'], accs[j]['max'] = a['min'], a['max']
        return j

    js = dict(asset=dict(version='2.0', generator='cinder art/ai/char_rig.py'), scene=0, scenes=[dict(nodes=[])], nodes=[], meshes=[], materials=[], skins=[])
    js['nodes'] = json.loads(json.dumps(skjs['nodes']))
    js['scenes'][0]['nodes'] = list(skjs['scenes'][skjs.get('scene', 0)]['nodes'])
    sk = json.loads(json.dumps(skjs['skins'][0]))
    sk['inverseBindMatrices'] = copy_acc(skjs['skins'][0]['inverseBindMatrices'])
    js['skins'] = [sk]
    js['materials'] = [dict(name='Material', pbrMetallicRoughness=dict(baseColorFactor=[1, 1, 1, 1], metallicFactor=0, roughnessFactor=1)),
                       dict(name='Material.001', pbrMetallicRoughness=dict(baseColorFactor=[1, 1, 1, 1], metallicFactor=0, roughnessFactor=1))]
    prims = []
    for mi, sel in ((0, ~glow), (1, glow)):
        idx = np.where(sel)[0]
        if not len(idx):
            continue
        # 每个角：位置（float32）、骨骼（8 位）、权重（8 位，四个加起来正好 255）一样的并成一个顶点（带索引）；颜色取并到一起的角的平均（8 位），
        # 甲壳上是连续的渐变，囊在另一个图元里边界不糊。包比每角一个顶点小一半多
        keys, verts, ind, csum = {}, [], [], []
        for fi in idx:
            for kq in range(3):
                pos = P[fi, kq].astype(np.float32)
                jj, ww = list(Js[fi][kq]), list(Ws[fi][kq])
                J = (jj + [0, 0, 0, 0])[:4]
                w8 = [int(round(x * 255)) for x in ww]
                w8[int(np.argmax(w8))] += 255 - sum(w8)
                W8 = (w8 + [0, 0, 0, 0])[:4]
                key = (pos.tobytes(), tuple(J), tuple(W8))
                vi = keys.get(key)
                if vi is None:
                    vi = keys[key] = len(verts)
                    verts.append((pos, J, W8))
                    csum.append([0.0, 0.0, 0.0, 0])
                c = cols[fi, kq]
                csum[vi][0] += float(c[0]); csum[vi][1] += float(c[1]); csum[vi][2] += float(c[2]); csum[vi][3] += 1
                ind.append(vi)
        C8 = [[int(round(min(1.0, max(0.0, cs[k] / cs[3])) * 255)) for k in range(3)] + [255] for cs in csum]
        pos = np.array([v[0] for v in verts], dtype=np.float32)
        Ja = np.array([v[1] for v in verts], dtype=np.uint8)
        Wa = np.array([v[2] for v in verts], dtype=np.uint8)
        attrs = dict(POSITION=add(pos, 5126, 'VEC3', 34962, minmax=True), JOINTS_0=add(Ja, 5121, 'VEC4', 34962), WEIGHTS_0=add(Wa, 5121, 'VEC4', 34962, normalized=True))
        if mi == 0:
            attrs['COLOR_0'] = add(np.array(C8, dtype=np.uint8), 5121, 'VEC4', 34962, normalized=True)
        ia = np.array(ind, dtype=np.uint16 if len(verts) < 65536 else np.uint32)
        prims.append(dict(attributes=attrs, indices=add(ia, 5123 if ia.dtype == np.uint16 else 5125, 'SCALAR', 34963), material=mi))
    js['meshes'] = [dict(name='Spitter', primitives=prims)]
    # 网格节点：骨架 GLB 里带 skin 的那个节点，换成新网格
    for nd in js['nodes']:
        if 'mesh' in nd:
            nd['mesh'] = 0
    if anims:
        js['animations'] = []
        for a in skjs.get('animations', []):
            na = dict(name=a['name'], channels=json.loads(json.dumps(a['channels'])), samplers=[])
            for smp in a['samplers']:
                na['samplers'].append(dict(input=copy_acc(smp['input']), output=copy_acc(smp['output']), interpolation=smp.get('interpolation', 'LINEAR')))
            if 'extras' in a:
                na['extras'] = a['extras']
            js['animations'].append(na)
    js['accessors'] = accs
    js['bufferViews'] = views
    bin_ = b''.join(bufs)
    bin_ += b'\0' * ((-len(bin_)) % 4)
    js['buffers'] = [dict(byteLength=len(bin_))]
    jb = json.dumps(js, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    jb += b' ' * ((-len(jb)) % 4)
    total = 12 + 8 + len(jb) + 8 + len(bin_)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, total))
        fh.write(struct.pack('<II', len(jb), 0x4E4F534A))
        fh.write(jb)
        fh.write(struct.pack('<II', len(bin_), 0x004E4942))
        fh.write(bin_)


def main():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    o = {a[i][2:]: a[i + 1] for i in range(0, len(a) - 1, 2) if a[i].startswith('--')}
    build(o)


if __name__ == '__main__':
    main()
