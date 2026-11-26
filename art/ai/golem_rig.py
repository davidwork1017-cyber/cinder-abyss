# AI 生成的熔渣巨像（ai3d-golem，试验，不上线）：整身源网格 → 对骨架 → 减面 → 按骨骼切成刚性零件 → 补关节口 → 取色 → 带骨架和动作的首领 GLB。
# 无头 Blender：
#   blender -b --factory-startup --python-exit-code 1 --python art/ai/golem_rig.py -- --spec art/ai/golem/a01.json --out <目录> [--src <model.glb>] [--debug <目录>]
# 产物（<目录>/）：golem_<候选>_vc.glb（一角一色：反照率按角取平均写进 COLOR_0，UV 指向调色板的白端，和脚本首领同一个打包 / 运行时路径）、
#   golem_<候选>_tex.glb（带一张反照率贴图：新展的 UV、从源网格烘过来，COLOR_0 只带发光的 α；运行时要试验分支的贴图路径）、albedo.jpg、
#   build.json（三角形数、骨骼的顶点数、源文件的 sha256、各步的参数）。
# 步骤（每一步一个函数，换掉其中一步不动别的：以后 AI 自动蒙皮的权重 GLB 可以顶替 split，fit / 减面 / 取色照旧）：
#   load    源 GLB → 顶点 / 三角形 / 每角 UV / 反照率（线性）；
#   fit     art/ai/golem_fit.py：等比缩放到米、对齐，量出 28 根骨骼在源姿态下的枢轴（候选参数里可以逐项写死）；导出用的骨架就是这组枢轴（动作不变）；
#   decimate 焊接后整身减面（Blender Decimate · Collapse），给切口和补口留出预算；
#   split   按枢轴把三角形分给骨骼（区域规则 + 关节切面），切面处真的切开（bisect）、沿骨骼边界拆开、每个口子补一个盖：子零件鼓出去（伸进父零件里，弯的时候露出来的是它，不是洞）、父零件往里凹；
#   colour  每个角在源网格上取反照率的平均（源姿态下的位置，跟减面后的 UV 无关），识别火色当发光面，轻调明暗；
#   export  rig.armature / skin / key_clips / export_glb（和脚本首领同一套）。
# 确定性：不用随机数；减面、切、拆、补、取色、展 UV 都是固定算法，同一台机器同一个 Blender 版本两次构建逐字节相同。
import hashlib
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

from ai import golem_fit as gf  # noqa: E402
from ca import core, palette, rig  # noqa: E402
from ca.boss.golem_clips import CLIPS  # noqa: E402

ROOT = os.path.dirname(ART)


def s2l(x):
    x = np.asarray(x, dtype=np.float64)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(np.asarray(x, dtype=np.float64), 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


# ---------------------------------------------------------------- load
def _glb(path):
    import struct
    b = open(path, 'rb').read()
    jl = struct.unpack_from('<I', b, 12)[0]
    js = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack_from('<I', b, off)[0]
    return js, b[off + 8:off + 8 + bl]


CT = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def load(path):
    """源 GLB → dict(V 顶点（源坐标，glTF：y 上、+z 前）, F 三角形, UV 每角 (m,3,2)（glTF：v 朝下）, img 反照率（线性，行 0 = v 0）)"""
    js, bin_ = _glb(path)

    def acc(i):
        a = js['accessors'][i]
        bv = js['bufferViews'][a['bufferView']]
        if bv.get('byteStride'):
            raise RuntimeError('源 GLB 有交错的 bufferView，不支持')
        o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        k = NC[a['type']]
        arr = np.frombuffer(bin_, CT[a['componentType']], a['count'] * k, o)
        return arr.reshape(a['count'], k) if k > 1 else arr

    V, F, UV = [], [], []
    base = 0
    for nd in js['nodes']:
        if 'mesh' not in nd:
            continue
        if any(k in nd for k in ('matrix', 'rotation', 'scale', 'translation')):
            raise RuntimeError('源 GLB 的网格节点带变换，先确认坐标再处理')
        for pr in js['meshes'][nd['mesh']]['primitives']:
            p = acc(pr['attributes']['POSITION']).astype(np.float64)
            f = acc(pr['indices']).astype(np.int64).reshape(-1, 3)
            uv = acc(pr['attributes']['TEXCOORD_0']).astype(np.float64)
            V.append(p)
            F.append(f + base)
            UV.append(uv)
            base += len(p)
    V, F, uvv = np.concatenate(V), np.concatenate(F), np.concatenate(UV)
    # 反照率：材质 0 的 baseColorTexture，交给 Blender 解码（JPEG / PNG）
    mat = js['materials'][0]['pbrMetallicRoughness']
    im = js['images'][js['textures'][mat['baseColorTexture']['index']]['source']]
    bv = js['bufferViews'][im['bufferView']]
    data = bin_[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
    tmp = os.path.join(bpy.app.tempdir or '/tmp', 'ai_golem_src' + ('.jpg' if 'jpeg' in im.get('mimeType', '') else '.png'))
    with open(tmp, 'wb') as fh:
        fh.write(data)
    bim = bpy.data.images.load(tmp)
    w, h = bim.size
    px = np.empty(w * h * 4, dtype=np.float32)
    bim.pixels.foreach_get(px)
    srgb = px.reshape(h, w, 4)[::-1, :, :3].astype(np.float64)  # Blender 行 0 在底部，翻成 v 朝下
    bpy.data.images.remove(bim)
    fac = np.array(mat.get('baseColorFactor', [1, 1, 1, 1])[:3])
    return dict(V=V, F=F, UV=uvv[F], img=s2l(srgb) * fac, srgb=srgb)


# ---------------------------------------------------------------- decimate
def weld_mesh(V, F):
    inv, WF = gf.weld(V, F)
    W = np.zeros((inv.max() + 1, 3))
    W[inv] = V
    keep = (WF[:, 0] != WF[:, 1]) & (WF[:, 1] != WF[:, 2]) & (WF[:, 0] != WF[:, 2])
    WF = WF[keep]
    used = np.unique(WF)  # 没有面用到的顶点去掉（strip 删了面以后会剩下）
    remap = np.full(len(W), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return W[used], remap[WF]


def to_bm(V, F):
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in V.tolist()]
    for a, b, c in F.tolist():
        try:
            bm.faces.new((vs[a], vs[b], vs[c]))
        except ValueError:
            pass  # 重复面
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    return bm


def decimate(V, F, target, log):
    """整身减面到 target 个三角形左右（Decimate · Collapse，三角化），返回 numpy 顶点 / 三角形"""
    bm = to_bm(V, F)
    me = bpy.data.meshes.new('dec_src')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('dec', me)
    bpy.context.scene.collection.objects.link(ob)
    n0 = len(me.polygons)
    ratio = min(1.0, target / n0)
    tris = n0
    for it in range(5):
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
        if abs(tris - target) <= 0.02 * target:
            break
        ratio = min(1.0, ratio * target / tris)
    out = ob.data
    Vd = np.array([v.co[:] for v in out.vertices])
    Fd = np.array([p.vertices[:] for p in out.polygons], dtype=np.int64)
    bpy.data.objects.remove(ob)
    log['decimate'] = dict(target=target, tris=int(len(Fd)), ratio=round(ratio, 6), source_tris=int(n0))
    return Vd, Fd


# ---------------------------------------------------------------- split
def _seg_dir(src, a, b):
    d = np.asarray(src[b]) - np.asarray(src[a])
    return d / np.linalg.norm(d)


def rules(f, spec):
    """标签规则和切面（游戏坐标，米）。返回 (label(c) 函数, cuts 列表, soft 列表)
    cuts：(父, 子, 面上一点, 法线（父 → 子）, 区域过滤 c → bool)；soft：rig.skin 的软接缝（不切开，按距离渐变）"""
    S = f['src']
    s = spec.get('split', {})
    H = f['height']
    kx = f.get('k', 1.0)  # 水平放大（fit.xz_scale）：下面按等比坐标量的 x / z 都乘上它
    gap_m = {k: 0.5 * sum(f['lm'][k]['gap']) * H * kx for k in ('l', 'r')}
    arm_x = s['arm_x'] * kx if s.get('arm_x') is not None else None
    head_w = s.get('head_halfwidth', 0.66) * kx
    chim = list(s.get('chimney_box', [0.55, 1.4, 4.2, -0.75, 0.15]))  # |x| 下限 / 上限、y 下限、z 下限 / 上限
    chim = [chim[0] * kx, chim[1] * kx, chim[2], chim[3] * kx, chim[4] * kx]
    right_fist = s.get('right_fist', 'x_hammer')
    left_fist = s.get('left_fist', 'hand_l')
    n_up = np.array([0.0, 1.0, 0.0])
    foot_cut = s.get('foot_cut', float(S['foot_l'][1]))  # 脚和小腿的切面高度（缺省 = 踝的枢轴）；靴子一整块的候选切低一点，只切出脚掌

    # 手臂区域的下限：拳头最低点往下一点（脚尖伸到空隙外面，不能算进手臂）
    arm_y0 = {k: f['lm'][k]['fist_bottom'] * H - s.get('arm_y_margin', 0.12) for k in ('l', 'r')}

    def arm_side(c):
        for k, sg in (('l', 1.0), ('r', -1.0)):
            xa = arm_x if arm_x is not None else gap_m[k]
            if sg * c[0] > xa and c[1] > arm_y0[k] and not is_chimney(c):
                return k
        return None

    def is_chimney(c):
        return chim[0] < abs(c[0]) < chim[1] and c[1] > chim[2] and chim[3] < c[2] < chim[4]

    def plane_side(c, p, n):
        return float(np.dot(np.asarray(c) - p, n))

    def label(c):
        k = arm_side(c)
        if k:
            up, lo, ha = S['upperarm_' + k], S['lowerarm_' + k], S['hand_' + k]
            if plane_side(c, lo, -_seg_dir(S, 'upperarm_' + k, 'lowerarm_' + k)) > 0:
                return 'upperarm_' + k
            if plane_side(c, ha, -_seg_dir(S, 'lowerarm_' + k, 'hand_' + k)) > 0:
                return 'lowerarm_' + k
            return left_fist if k == 'l' else right_fist
        if is_chimney(c):
            return 'x_chimney_l' if c[0] > 0 else 'x_chimney_r'
        if c[1] > S['neck_01'][1] and abs(c[0]) < head_w:
            return 'head'
        if c[1] < S['thigh_l'][1] and abs(c[0]) > s.get('leg_x', 0.12) * kx:
            k = 'l' if c[0] > 0 else 'r'
            if c[1] > S['calf_' + k][1]:
                return 'thigh_' + k
            if c[1] > foot_cut:
                return 'calf_' + k
            return 'foot_' + k
        if c[1] < S['spine_01'][1]:
            return 'pelvis'
        if c[1] < S['spine_02'][1]:
            return 'spine_01'
        if c[1] < S['spine_03'][1]:
            return 'spine_02'
        return 'spine_03'

    cuts = []
    for k, sg in (('l', 1.0), ('r', -1.0)):
        xa = arm_x if arm_x is not None else gap_m[k]
        fist = left_fist if k == 'l' else right_fist
        # 肩：竖直切面 x = ±arm_x（手臂一侧是子）
        cuts.append(('spine_03', 'upperarm_' + k, np.array([sg * xa, 0, 0]), np.array([sg, 0, 0]), lambda c: c[1] > S['lowerarm_l'][1] - 0.3))
        cuts.append(('upperarm_' + k, 'lowerarm_' + k, S['lowerarm_' + k], -_seg_dir(S, 'upperarm_' + k, 'lowerarm_' + k) * -1, lambda c, sg=sg, xa=xa: sg * c[0] > xa - 0.05))
        cuts.append(('lowerarm_' + k, fist, S['hand_' + k], -_seg_dir(S, 'lowerarm_' + k, 'hand_' + k) * -1, lambda c, sg=sg, xa=xa: sg * c[0] > xa - 0.05))
        cuts.append(('pelvis', 'thigh_' + k, S['thigh_' + k], -n_up, lambda c, sg=sg: sg * c[0] > s.get('leg_x', 0.12) * kx - 0.05 and c[1] < S['spine_01'][1]))
        cuts.append(('thigh_' + k, 'calf_' + k, S['calf_' + k], -n_up, lambda c, sg=sg: sg * c[0] > 0.05))
        cuts.append(('calf_' + k, 'foot_' + k, np.array([0, foot_cut, 0]), -n_up, lambda c, sg=sg: sg * c[0] > 0.05))
        cuts.append(('spine_03', 'x_chimney_' + k, np.array([0, chim[2], 0]), n_up, lambda c, sg=sg: chim[0] - 0.05 < sg * c[0] < chim[1] + 0.05 and chim[3] - 0.05 < c[2] < chim[4] + 0.05))
    cuts.append(('spine_03', 'head', S['neck_01'], n_up, lambda c: abs(c[0]) < head_w + 0.05))
    cuts.append(('pelvis', 'spine_01', S['spine_01'], n_up, lambda c: abs(c[0]) < (arm_x or min(gap_m.values())) - 0.02))
    cuts.append(('spine_01', 'spine_02', S['spine_02'], n_up, lambda c: abs(c[0]) < (arm_x or min(gap_m.values())) - 0.02))
    band = s.get('chest_band', 0.7)
    soft = [('spine_03', 'spine_02', tuple(S['spine_03'].tolist()), (0, 1, 0), band)]  # 胸口是一整块：中段按距离渐变，不切
    return label, cuts, soft


def split(Vd, Fd, f, spec, log, mode='rigid'):
    """按骨骼分三角形、在关节切面处切开、拆开、补口。返回 bmesh（面层 'lab' = 骨骼序号，'cap' = 1 补口 / 0 原面）、soft 列表"""
    label, cuts, soft = rules(f, spec)
    names = gf.NAMES
    idx = {n: i for i, n in enumerate(names)}
    bm = to_bm(Vd, Fd)
    L = bm.faces.layers.int.new('lab')
    Lc = bm.faces.layers.int.new('cap')
    for fc in bm.faces:
        fc[L] = idx[label(np.array(fc.calc_center_median()[:]))]
    # 关节切面：只切这两根骨骼的、跨过切面的、区域里的面；切完按面的重心在哪一侧重新标（混合模式不切：关节靠自动蒙皮的平滑权重）
    for par, chi, p, n, region in (cuts if mode == 'rigid' else []):
        a, b = idx[par], idx[chi]
        p = Vector(np.asarray(p, dtype=np.float64).tolist())
        n = Vector(np.asarray(n, dtype=np.float64).tolist()).normalized()
        sel = []
        bm.faces.index_update()
        bm.edges.index_update()
        bm.verts.index_update()
        for fc in bm.faces:
            if fc[L] not in (a, b):
                continue
            c = fc.calc_center_median()
            if not region(np.array(c[:])):
                continue
            ds = [(v.co - p).dot(n) for v in fc.verts]
            if min(ds) < -1e-6 and max(ds) > 1e-6:
                sel.append(fc)
        if sel:
            es = {e.index: e for fc in sel for e in fc.edges}
            vs = {v.index: v for fc in sel for v in fc.verts}
            geom = [es[k] for k in sorted(es)] + sel + [vs[k] for k in sorted(vs)]  # 按序号排好（集合的顺序跟内存地址走，不固定）
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=p, plane_no=n)
        for fc in bm.faces:
            if fc[L] not in (a, b):
                continue
            c = fc.calc_center_median()
            if region(np.array(c[:])):
                fc[L] = b if (c - p).dot(n) > 0 else a
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    # 孤岛：同一根骨骼的面按边连通分组，除了最大的一组，小于 orphan 个面的组并到它四周最多的那根骨骼（按面序号的顺序，结果固定）
    orphan = spec.get('split', {}).get('orphan', 40)
    for _ in range(3):
        bm.faces.index_update()
        bm.faces.ensure_lookup_table()
        comp = [-1] * len(bm.faces)
        groups = []
        for fc in bm.faces:
            if comp[fc.index] >= 0:
                continue
            gid = len(groups)
            st, mem = [fc], []
            comp[fc.index] = gid
            while st:
                g = st.pop()
                mem.append(g)
                for e in g.edges:
                    for h in e.link_faces:
                        if comp[h.index] < 0 and h[L] == fc[L]:
                            comp[h.index] = gid
                            st.append(h)
            groups.append(mem)
        biggest = {}
        for gid, mem in enumerate(groups):
            lab = mem[0][L]
            if lab not in biggest or len(mem) > len(groups[biggest[lab]]):
                biggest[lab] = gid
        changed = 0
        for gid, mem in enumerate(groups):
            lab = mem[0][L]
            if biggest[lab] == gid or len(mem) >= orphan:
                continue
            nb = {}
            for g in mem:
                for e in g.edges:
                    for h in e.link_faces:
                        if comp[h.index] != gid:
                            nb[h[L]] = nb.get(h[L], 0) + 1
            if nb:
                new_lab = max(sorted(nb), key=lambda k: nb[k])
                for g in mem:
                    g[L] = new_lab
                changed += 1
        if not changed:
            break
    # 沿骨骼边界拆开（软接缝那一对不拆）
    softpairs = {frozenset((idx[c], idx[p])) for c, p, _, _, _ in soft}
    if mode == 'rigid':
        edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.link_faces[0][L] != e.link_faces[1][L]
                 and frozenset((e.link_faces[0][L], e.link_faces[1][L])) not in softpairs]
    else:
        # 混合：只在不相邻的两块之间拆开（源网格里拳头和大腿、肩甲和烟囱这类贴在一起的地方），相邻骨骼之间连着、靠权重过渡
        def adj(a, b):
            na, nb = names[a], names[b]
            return nb in _family(na) or (na in TORSO and nb in TORSO)
        edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.link_faces[0][L] != e.link_faces[1][L]
                 and not adj(e.link_faces[0][L], e.link_faces[1][L])]
    bmesh.ops.split_edges(bm, edges=edges)
    ncap = cap_holes(bm, L, Lc, f, spec)
    bm.verts.index_update()
    bm.faces.index_update()
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    cnt = {}
    for fc in bm.faces:
        cnt[names[fc[L]]] = cnt.get(names[fc[L]], 0) + 1
    log['split'] = dict(faces=len(bm.faces), caps=ncap, per_bone={k: cnt[k] for k in sorted(cnt)})
    return bm, soft


def _depth(n):
    d = 0
    while gf.PARENT[n]:
        n = gf.PARENT[n]
        d += 1
    return d


def cap_holes(bm, L, Lc, f, spec):
    """每个口子补一个盖：bmesh 的 holes_fill 补成一个多边形 → 三角化；这道关节的子零件那一侧再从中心戳出一个矮锥（poke，往外 dome × 口子半径），
    弯的时候露出来的是锥面、不是洞；父零件那一侧是平的盖。返回补的三角形数"""
    s = spec.get('split', {})
    dome = s.get('dome', 0.35)
    names = gf.NAMES
    bnd = [e for e in bm.edges if len(e.link_faces) == 1]
    lab_of_v = {}
    pos_parts = {}
    for e in bnd:
        lab = e.link_faces[0][L]
        for v in e.verts:
            lab_of_v[v] = lab
            pos_parts.setdefault(tuple(round(x, 5) for x in v.co), set()).add(lab)
    before = set(bm.faces)
    res = bmesh.ops.holes_fill(bm, edges=bnd, sides=0)
    fills = [fc for fc in res['faces'] if fc not in before]
    added = 0
    domes = []
    for fc in fills:
        labs = [lab_of_v.get(v) for v in fc.verts]
        labs = [x for x in labs if x is not None]
        lab = max(sorted(set(labs)), key=labs.count) if labs else 0
        fc[L] = lab
        fc[Lc] = 1
        others = set()
        for v in fc.verts:
            others |= pos_parts.get(tuple(round(x, 5) for x in v.co), set())
        others.discard(lab)
        me_d = _depth(names[lab])
        if others and all(_depth(names[o]) < me_d for o in others):
            domes.append(fc)
    # 子零件的盖：戳成锥，高度 = dome × 口子的平均半径（按每个面自己算）
    for fc in domes:
        c = fc.calc_center_median()
        r = sum((v.co - c).length for v in fc.verts) / len(fc.verts)
        fc.normal_update()
        out = bmesh.ops.poke(bm, faces=[fc], offset=dome * r, center_mode='MEAN', use_relative_offset=False)
        for g in out['faces']:
            g[L] = lab_of_v.get(g.verts[0], g[L])
            g[Lc] = 1
    caps = [fc for fc in bm.faces if fc[Lc]]
    big = [fc for fc in caps if len(fc.verts) > 3]
    if big:
        bmesh.ops.triangulate(bm, faces=big, quad_method='BEAUTY', ngon_method='BEAUTY')
    for fc in bm.faces:
        if fc[Lc]:
            added += 1
    return added


# ---------------------------------------------------------------- weights (AI 自动蒙皮 → 混合)
def load_weights(path, f):
    """自动蒙皮的权重 GLB（UniRig 等，源网格自己的坐标，骨骼名和巨像骨架一样）→ (顶点（游戏坐标）, 三角形, 每个顶点 {骨骼: 权重})"""
    js, bin_ = _glb(path)
    CTn = {5121: (np.uint8, 255), 5123: (np.uint16, 65535), 5125: (np.uint32, 1), 5126: (np.float32, 1)}

    def acc(i, norm=False):
        a = js['accessors'][i]
        bv = js['bufferViews'][a['bufferView']]
        if bv.get('byteStride'):
            raise RuntimeError('权重 GLB 有交错的 bufferView，不支持')
        dt, mx = CTn[a['componentType']]
        k = NC[a['type']]
        arr = np.frombuffer(bin_, dt, a['count'] * k, bv.get('byteOffset', 0) + a.get('byteOffset', 0)).astype(np.float64)
        if a.get('normalized') or (norm and mx > 1):
            arr = arr / mx
        return arr.reshape(a['count'], k) if k > 1 else arr

    pr = js['meshes'][0]['primitives'][0]
    V = acc(pr['attributes']['POSITION'])
    F = acc(pr['indices']).astype(np.int64).reshape(-1, 3)
    J = acc(pr['attributes']['JOINTS_0']).astype(np.int64)
    Wt = acc(pr['attributes']['WEIGHTS_0'], norm=True)
    names = [js['nodes'][j]['name'] for j in js['skins'][0]['joints']]
    bad = sorted(set(names) - set(gf.NAMES))
    if bad:
        raise RuntimeError('权重 GLB 的骨骼不在巨像骨架里：' + ','.join(bad))
    G = V * f['scale'] + f['offset']
    ws = []
    for j, w in zip(J, Wt):
        d = {}
        for jj, ww in zip(j, w):
            if ww > 0:
                d[names[jj]] = d.get(names[jj], 0.0) + float(ww)
        ws.append(d)
    return G, F, ws


def transfer_weights(P, src):
    """每个顶点：源网格上最近的三角形，按重心坐标把三个角的权重加起来（游戏坐标）"""
    G, F, ws = src
    bvh = BVHTree.FromPolygons([tuple(p) for p in G.tolist()], [tuple(t) for t in F.tolist()], all_triangles=True)
    out = []
    for p in P:
        loc, nrm, fi, d = bvh.find_nearest(Vector(p))
        a, b, c = G[F[fi]]
        q = np.array(loc[:])
        v0, v1, v2 = b - a, c - a, q - a
        d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01 or 1e-18
        wb = (d11 * d20 - d01 * d21) / den
        wc = (d00 * d21 - d01 * d20) / den
        bw = np.clip(np.array([1 - wb - wc, wb, wc]), 0, 1)
        bw /= bw.sum()
        acc_ = {}
        for k in range(3):
            for n, w in ws[F[fi][k]].items():
                acc_[n] = acc_.get(n, 0.0) + w * bw[k]
        out.append(acc_)
    return out


def _family(n):
    """和 n 相邻的骨骼（自己、父、子）：自动蒙皮的主导骨在这里面就算对得上这块区域"""
    fam = {n}
    if gf.PARENT[n]:
        fam.add(gf.PARENT[n])
    fam |= {c for c, p in gf.PARENT.items() if p == n}
    return fam


TORSO = {'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'x_core', 'x_grate'}


def hybrid_weights(P, regions, auto, spec, log):
    """混合：自动蒙皮的权重为主；按几何区域（刚性切分的区域规则）纠正：
    force 里的区域一律 100% 绑这块区域的骨骼（头、烟囱……）；别的顶点主导骨和区域对不上（不是区域骨骼自己 / 父 / 子，躯干之间互相算对得上）也改成 100% 区域骨骼；
    然后每个顶点留最重的 4 根、归一化。返回每个顶点的 {骨骼: 权重} 和统计"""
    h = spec.get('weights', {})
    force = set(h.get('force', ['head', 'x_chimney_l', 'x_chimney_r']))
    out = []
    st = dict(force=0, mismatch=0, kept=0)
    for p, reg, w in zip(P, regions, auto):
        dom = max(sorted(w), key=lambda k: w[k]) if w else None
        if reg in force:
            out.append({reg: 1.0})
            st['force'] += 1
            continue
        ok = dom is not None and (dom in _family(reg) or (dom in TORSO and reg in TORSO))
        if not ok:
            out.append({reg: 1.0})
            st['mismatch'] += 1
            continue
        # 只留和这块区域相邻的骨骼（肩甲上带一点烟囱权重的话，烟囱一歪肩甲就跟着扯）
        allow = _family(reg) | (TORSO if reg in TORSO else set())
        top = sorted(((k, x) for k, x in w.items() if k in allow), key=lambda kv: (-kv[1], kv[0]))[:4]
        sm = sum(x for _, x in top)
        out.append({k: x / sm for k, x in top if x / sm > 1e-3})
        st['kept'] += 1
    log['hybrid'] = st
    return out


# ---------------------------------------------------------------- colour
class Sampler:
    """在源网格（游戏坐标）上取反照率：最近点 → 源三角形的重心坐标 → 源 UV → 双线性取色（线性）"""

    def __init__(self, G, F, UV, img):
        self.G, self.F, self.UV, self.img = G, F, UV, img
        self.bvh = BVHTree.FromPolygons([tuple(p) for p in G.tolist()], [tuple(t) for t in F.tolist()], all_triangles=True)
        self.h, self.w, _ = img.shape

    def uv_at(self, p):
        loc, nrm, fi, d = self.bvh.find_nearest(Vector(p))
        a, b, c = self.G[self.F[fi]]
        q = np.array(loc[:])
        v0, v1, v2 = b - a, c - a, q - a
        d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01 or 1e-18
        wb = (d11 * d20 - d01 * d21) / den
        wc = (d00 * d21 - d01 * d20) / den
        w = np.clip(np.array([1 - wb - wc, wb, wc]), 0, 1)
        w /= w.sum()
        return w @ self.UV[fi]

    def colour(self, uv):
        x = uv[0] * self.w - 0.5
        y = uv[1] * self.h - 0.5
        x0, y0 = int(math.floor(x)), int(math.floor(y))
        tx, ty = x - x0, y - y0
        im = self.img

        def px(i, j):
            return im[min(self.h - 1, max(0, j)), min(self.w - 1, max(0, i))]

        return (px(x0, y0) * (1 - tx) * (1 - ty) + px(x0 + 1, y0) * tx * (1 - ty) + px(x0, y0 + 1) * (1 - tx) * ty + px(x0 + 1, y0 + 1) * tx * ty)

    def at(self, p):
        c = self.colour(self.uv_at(p))
        if self.concept is not None:
            w, cc = self.project(p)
            if w > 0:
                c = c * (1 - w) + cc * w
        return c

    concept = None

    def set_concept(self, img_srgb, G, o, log):
        """概念图（正面、近似正交、白底）投到朝前、从正前方看得见的表面上：图里人形的包围盒对网格正面投影的包围盒（x / y 各自线性），
        权重 = 朝前的程度（法线 z）× 可见（从正前方打一条射线，先打到的就是这一点）× strength；白底不算"""
        h, w, _ = img_srgb.shape
        fig = img_srgb.min(axis=2) < o.get('white', 0.9)
        ys, xs = np.nonzero(fig)
        self.cu0, self.cu1 = xs.min() / w, (xs.max() + 1) / w
        self.cv0, self.cv1 = ys.min() / h, (ys.max() + 1) / h
        self.gx0, self.gx1 = G[:, 0].min(), G[:, 0].max()
        self.gy0, self.gy1 = G[:, 1].min(), G[:, 1].max()
        self.gz1 = G[:, 2].max() + 1.0
        self.concept = s2l(img_srgb)
        self.cfig = fig
        self.cw, self.ch = w, h
        self.copt = o
        # 反照率和概念图的石头明暗对齐：两边亮度（线性）的中位数之比乘到反照率上（投影 / 没投影的地方接得上）
        Yw = np.array([0.2126, 0.7152, 0.0722])
        yc = float(np.median(self.concept[fig] @ Yw))
        ya = self.img @ Yw
        yam = float(np.median(ya[ya > 1e-4]))
        self.k_alb = yc / yam if o.get('match', True) else 1.0
        self.img = self.img * self.k_alb
        log['concept'] = dict(fig_px=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())], aspect_fig=round(((xs.max() - xs.min()) / w) / ((ys.max() - ys.min()) / h), 4),
                              aspect_mesh=round((self.gx1 - self.gx0) / (self.gy1 - self.gy0), 4), strength=o.get('strength', 1.0), k_albedo=round(self.k_alb, 4))

    def project(self, p):
        o = self.copt
        loc, nrm, fi, d = self.bvh.find_nearest(Vector(p))
        nz = nrm[2]
        wn = min(1.0, max(0.0, (nz - o.get('nz0', 0.2)) / o.get('nz_ramp', 0.35)))
        if wn <= 0:
            return 0.0, None
        hit, hn, hf, hd = self.bvh.ray_cast(Vector((loc[0], loc[1], self.gz1)), Vector((0, 0, -1)))
        if hit is None or abs(hit[2] - loc[2]) > o.get('vis_eps', 0.04):
            return 0.0, None
        u = self.cu0 + (loc[0] - self.gx0) / (self.gx1 - self.gx0) * (self.cu1 - self.cu0)
        v = self.cv0 + (self.gy1 - loc[1]) / (self.gy1 - self.gy0) * (self.cv1 - self.cv0)
        X = min(self.cw - 1, max(0, int(u * self.cw)))
        Y = min(self.ch - 1, max(0, int(v * self.ch)))
        if not self.cfig[Y, X]:
            return 0.0, None
        return wn * o.get('strength', 1.0), self.concept[Y, X]


GRID = [(i / 4, j / 4, (4 - i - j) / 4) for i in range(5) for j in range(5 - i)]


def fire(lin):
    """火色权重 0–1：暖色（色相 5–55°）、饱和、够亮（sRGB 里判）"""
    r, g, b = l2s(lin)
    mx, mn = max(r, g, b), min(r, g, b)
    if mx < 0.35 or mx - mn < 0.25:
        return 0.0
    if r < g or r < b:
        return 0.0
    hue = 60 * ((g - b) / (mx - mn)) if mx == r else 0
    if hue < 5 or hue > 55:
        return 0.0
    sat = (mx - mn) / mx
    return float(min(1.0, (sat - 0.5) / 0.3) * min(1.0, (mx - 0.35) / 0.3)) if sat > 0.5 else 0.0


def grade(lin, g):
    """轻调明暗（线性）：gain 整体倍数、sat 饱和度（绕 Rec.709 亮度）、gamma、tint 每通道"""
    lin = np.asarray(lin, dtype=np.float64)
    if g.get('tint'):
        lin = lin * np.array(g['tint'])
    y = lin @ np.array([0.2126, 0.7152, 0.0722])
    lin = y + (lin - y) * g.get('sat', 1.0)
    lin = np.clip(lin, 0, None) * g.get('gain', 1.0)
    if g.get('gamma', 1.0) != 1.0:
        lin = np.clip(lin, 0, 1) ** g['gamma']
    if g.get('lift', 1.0) != 1.0:
        # 提亮曲线（sRGB 里）：s' = a·s / (1 + (a − 1)·s)，0 和 1 不动，暗部按 a 倍提、亮的火色不顶到白
        a = g['lift']
        sv = l2s(lin)
        lin = s2l(a * sv / (1 + (a - 1) * sv))
    return np.clip(lin, 0, 1)


def corner_colours(bm, L, Lc, smp, spec, log):
    """每个角：三角形上 15 个采样点按到这个角的重心权重平方加权的平均色；补口：最近处的颜色压暗。返回 {(面序号, 角号): (rgb 线性, 发光 g)}"""
    c = spec.get('colour', {})
    g = c.get('grade', {})
    cap_dark = c.get('cap_dark', 0.45)
    glow_on = c.get('glow', True)
    out = {}
    nfire = 0
    for fc in bm.faces:
        P = np.array([v.co[:] for v in fc.verts])
        if fc[Lc]:
            col = smp.at(P.mean(axis=0)) * cap_dark
            for k in range(len(P)):
                out[(fc.index, k)] = (grade(col, g), 0.0)
            continue
        cols, fw = [], []
        for w in GRID:
            q = w[0] * P[0] + w[1] * P[1] + w[2] * P[2]
            cl = smp.at(q)
            cols.append(cl)
            fw.append(fire(cl) if glow_on else 0.0)
        cols = np.array(cols)
        fw = np.array(fw)
        W = np.array(GRID) ** 2
        rock = fw < c.get('rock_fire', 0.3)
        for k in range(3):
            wk = W[:, k] / W[:, k].sum()
            gk = float(wk @ fw)
            if gk > 0.5:
                nfire += 1
                col = wk @ cols
            elif c.get('clean', True) and rock.sum() >= 3:
                # 一角一色时细的裂缝只会被平均成一片橙褐：不发光的角只取石头的采样点（裂缝留给贴图外观和发光面）
                wr = wk * rock
                col = (wr / wr.sum()) @ cols
            else:
                col = wk @ cols
            out[(fc.index, k)] = (grade(col, g), gk)
    log['colour'] = dict(fire_corners=nfire, grade=g)
    return out


# ---------------------------------------------------------------- object + export
PALE = palette.ROW['pale']
EMBER = palette.ROW['ember']


def build_object(bm, L, Lc, cc, name, mode, f, spec, log, tex_path=None):
    """bmesh（游戏坐标）→ Blender 网格对象（Blender 坐标）。mode = 'vc'：UV 指向调色板白端、COLOR_0 = 颜色 ÷ 白端；'tex'：新展 UV + 反照率贴图、COLOR_0 = 白 + 发光 α"""
    c = spec.get('colour', {})
    glow_lo = c.get('glow_level', [0.45, 0.8])
    # 炉芯：发光面里离 colour.core.c 不到 r 米的三角形按近白的芯（发光 1.0，运行时 RIG_FRAG 收成暖白；vfx 规则：近白只占一小块）
    # 取法：发光三角形按离 c 的距离从近到远，面积累计到全部发光面积的 frac（缺省 15%）为止
    cs = c.get('core')
    core_f = set()
    if cs:
        cc0 = Vector((cs['c'][0] * f.get('k', 1.0), cs['c'][1], cs['c'][2] * f.get('k', 1.0)))
        gl = [(round((fc.calc_center_median() - cc0).length, 6), fc.index, fc.calc_area()) for fc in bm.faces if all(cc[(fc.index, k)][1] > 0.5 for k in range(3))]
        tot = sum(a for _, _, a in gl)
        acc = 0.0
        for dd, fi, ar in sorted(gl):
            if acc >= cs.get('frac', 0.15) * tot:
                break
            core_f.add(fi)
            acc += ar
    me = bpy.data.meshes.new(name)
    bm2 = bm.copy()
    for v in bm2.verts:
        v.co = Vector(rig.g2b(v.co[:]))
    bm2.to_mesh(me)
    bm2.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = False
    col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    uv = me.uv_layers.new(name='UVMap')
    pale = s2l(np.array(palette.ramp(PALE, (palette.W - 0.5) / palette.W)) / 255)
    uv_pale = palette.uv_of(PALE, 1.0)
    uv_ember = palette.uv_of(EMBER, 0.8)
    q = lambda x: round(float(min(1.0, max(0.0, x))) * 65535) / 65535
    nglow = 0
    for p in me.polygons:
        gs = [cc[(p.index, k)][1] for k in range(3)]
        isg = all(gg > 0.5 for gg in gs)
        if isg:
            nglow += 1
        for k, li in enumerate(p.loop_indices):
            rgb, gk = cc[(p.index, k)]
            # 发光：三个角都是火色的三角形才进发光网格（运行时的规则）；亮度按火色权重落在 glow_level 的范围里
            a = 1.0 - (glow_lo[0] + (glow_lo[1] - glow_lo[0]) * min(1.0, (gk - 0.5) / 0.5)) if isg else 1.0
            if isg and p.index in core_f:
                a = 0.0
            if mode == 'vc':
                v = rgb / pale
                col.data[li].color = (q(v[0]), q(v[1]), q(v[2]), q(a))
                uv.data[li].uv = uv_ember if isg else uv_pale
            else:
                col.data[li].color = (1.0, 1.0, 1.0, q(a))
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    if mode == 'vc':
        me.materials.append(core.palette_material())
    else:
        me.materials.append(tex_material(tex_path))
    log.setdefault('glow_tris', {})[mode] = nglow
    return ob


def tex_material(path):
    img = bpy.data.images.load(path)
    img.name = 'ai_golem_albedo'
    img.pack()
    img.filepath = ''
    img.filepath_raw = ''
    mat = bpy.data.materials.new('ai_golem_albedo')
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Metallic'].default_value = 0.0
    tx = nt.nodes.new('ShaderNodeTexImage')
    tx.image = img
    nt.links.new(tx.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def bake_texture(bm, L, Lc, smp, spec, out_path, log):
    """'tex' 外观：在减面后的网格上展 UV（Smart UV Project），每个像素在源网格上取色（补口压暗），轻调明暗，存 JPEG。返回每角的新 UV"""
    t = spec.get('tex', {})
    N = t.get('px', 1024)
    g = spec.get('colour', {}).get('grade', {})
    cap_dark = spec.get('colour', {}).get('cap_dark', 0.45)
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
    UVn = np.array([[uvl[li].uv[:] for li in p.loop_indices] for p in me.polygons])  # Blender 约定：v 朝上
    img = np.zeros((N, N, 3))
    mask = np.zeros((N, N), dtype=bool)
    caps = np.array([fc[Lc] for fc in bm.faces])
    for fi, fc in enumerate(bm.faces):
        P = np.array([v.co[:] for v in fc.verts])
        T = UVn[fi] * N
        x0, y0 = np.floor(T.min(0)).astype(int)
        x1, y1 = np.ceil(T.max(0)).astype(int)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(N - 1, x1), min(N - 1, y1)
        (ax, ay), (bx, by), (cx, cy) = T
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                X, Y = xx + 0.5, yy + 0.5
                w0 = ((by - cy) * (X - cx) + (cx - bx) * (Y - cy)) / den
                w1 = ((cy - ay) * (X - cx) + (ax - cx) * (Y - cy)) / den
                w2 = 1 - w0 - w1
                e = -0.6 / max(1.0, math.sqrt(abs(den)))
                if w0 < e or w1 < e or w2 < e:
                    continue
                w = np.clip([w0, w1, w2], 0, 1)
                w = w / w.sum()
                col = smp.at(w @ P)
                if caps[fi]:
                    col = col * cap_dark
                img[yy, xx] = grade(col, g)
                mask[yy, xx] = True
    # 岛外往外填几圈（mipmap / 双线性不渗黑边）
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
    srgb = l2s(img)
    im = bpy.data.images.new('ai_tex_out', N, N, alpha=False)
    rgba = np.ones((N, N, 4), dtype=np.float32)
    rgba[..., :3] = np.round(srgb * 255) / 255
    im.pixels.foreach_set(rgba.ravel())  # 行 0 = v 0（Blender 约定，v 朝上）
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = t.get('quality', 90)
    sc.render.image_settings.color_mode = 'RGB'
    im.save_render(out_path, scene=sc)
    bpy.data.images.remove(im)
    bpy.data.objects.remove(ob)
    log['tex'] = dict(px=N, coverage=round(float(mask.mean()), 4))
    return UVn


def key3(p):
    return (round(p[0], 4), round(p[1], 4), round(p[2], 4))


def rig_b2g(co):
    return (co.x, co.z, -co.y)


def skel_of(f):
    return rig.Skel([(n, p, tuple(float(x) for x in f['src'][n])) for n, p, _ in gf.BONES])


def export(ob, f, soft, path, log, wmap=None):
    skel = skel_of(f)
    names = skel.names()
    if wmap is not None:
        # 混合蒙皮：每个顶点的权重按位置查（rig.skin 的 custom），都标软；wmap 进来时是按顶点序号的列表（网格的顶点顺序和 bmesh 一样）
        wmap = {key3(rig_b2g(v.co)): wmap[v.index] for v in ob.data.vertices}
        for k in ('lab', 'cap'):
            if k in ob.data.attributes:
                ob.data.attributes.remove(ob.data.attributes[k])
        bind = [(max(sorted(wmap[key3(rig_b2g(v.co))]), key=lambda k: wmap[key3(rig_b2g(v.co))][k]), True) for v in ob.data.vertices]
        arm = rig.armature(skel, ob.name)
        count = rig.skin(ob, arm, skel, bind, [], lambda p, b: wmap[key3(p)])
        meta = rig.key_clips(arm, skel, CLIPS)
        rig.export_glb(ob, arm, path, meta)
        log.setdefault('export', {})[os.path.basename(path)] = dict(bones=len(names), verts_per_bone={k: count[k] for k in sorted(count)}, unused=[n for n in names if n not in count])
        return arm
    lab = ob.data.attributes['lab'].data
    # 顶点 → 骨骼：取它所在面的标签（拆开以后一个顶点只属于一个零件；软接缝那一对两边的顶点标软）
    vb = [None] * len(ob.data.vertices)
    for p in ob.data.polygons:
        for vi in p.vertices:
            if vb[vi] is None:
                vb[vi] = names[lab[p.index].value]
    sb = {c for c, _, _, _, _ in soft} | {pp for _, pp, _, _, _ in soft}
    bind = [(b, b in sb) for b in vb]
    for k in ('lab', 'cap'):
        if k in ob.data.attributes:
            ob.data.attributes.remove(ob.data.attributes[k])
    arm = rig.armature(skel, ob.name)
    count = rig.skin(ob, arm, skel, bind, list(soft))
    meta = rig.key_clips(arm, skel, CLIPS)
    rig.export_glb(ob, arm, path, meta)
    log.setdefault('export', {})[os.path.basename(path)] = dict(bones=len(names), verts_per_bone={k: count[k] for k in sorted(count)}, unused=[n for n in names if n not in count])
    return arm


def sha256(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def run(o):
    """o：spec（参数文件路径或 dict）、src（源 GLB，缺省 CA_AI_ROOT 下 models/<候选名>/model.glb）、out（产物目录）、modes（'vc,tex'）、weights（权重 GLB，混合蒙皮）、
    texpx（贴图边长）、tris（整件三角形上限，缺省 spec 的 tris / 8000）、name（网格节点名）、path（只出一种外观时 GLB 的完整路径）。返回构建记录"""
    spec = o['spec']
    if not isinstance(spec, dict):
        with open(spec if os.path.isabs(spec) else os.path.join(ROOT, spec), encoding='utf-8') as fh:
            spec = json.load(fh)
    spec = json.loads(json.dumps(spec))
    if o.get('texpx'):
        spec.setdefault('tex', {})['px'] = int(o['texpx'])  # 低画质用的小图（同一份参数，只换贴图边长）
    if o.get('tris'):
        spec['tris'] = int(o['tris'])
    src = o.get('src') or source_path(spec)
    out = o['out']
    os.makedirs(out, exist_ok=True)
    core.reset_scene()
    log = dict(spec=spec, source_sha256=sha256(src), blender=bpy.app.version_string)
    d = load(src)
    f = gf.fit(d['V'], d['F'], spec)
    G = d['V'] * f['scale'] + f['offset']  # 源网格（游戏坐标，米）
    log['fit'] = dict(height=round(f['height'], 5), scale=[round(float(x), 6) for x in np.atleast_1d(f['scale'])], xz_scale=f.get('k', 1.0), offset=[round(x, 6) for x in f['offset']],
                      src={n: [round(float(x), 5) for x in f['src'][n]] for n in gf.NAMES})
    smp = Sampler(G, d['F'], d['UV'], d['img'])
    co = spec.get('concept')
    if co and co.get('use', True):
        cpath = os.path.join(os.path.dirname(src), co.get('file', 'concept.png'))
        bim = bpy.data.images.load(cpath)
        cw, ch = bim.size
        px = np.empty(cw * ch * 4, dtype=np.float32)
        bim.pixels.foreach_get(px)
        smp.set_concept(px.reshape(ch, cw, 4)[::-1, :, :3].astype(np.float64), G, co, log)  # 行 0 = 图的最上面
        log['concept']['sha256'] = sha256(cpath)
        bpy.data.images.remove(bim)
    Fk = d['F']
    for bx in spec.get('strip', []):
        # 去掉不要的件（候选参数 strip：游戏坐标的盒子 [x0, x1, y0, y1, z0, z1]，|x| 按左右对称算）：重心在盒子里的三角形删掉，留下的口子后面照样补盖
        C = G[Fk].mean(axis=1)
        ax = np.abs(C[:, 0])
        inb = (ax >= bx[0]) & (ax <= bx[1]) & (C[:, 1] >= bx[2]) & (C[:, 1] <= bx[3]) & (C[:, 2] >= bx[4]) & (C[:, 2] <= bx[5])
        Fk = Fk[~inb]
        log.setdefault('strip', []).append(dict(box=bx, faces=int(inb.sum())))
    W, WF = weld_mesh(G, Fk)
    budget = spec.get('tris', 8000)
    target = spec.get('decimate', 6400)
    wsrc = o.get('weights') or spec.get('weights', {}).get('glb')
    if wsrc and not os.path.isabs(wsrc):
        wsrc = os.path.join(src_root(), wsrc)
    wlist = None
    if wsrc:
        # 混合：AI 自动蒙皮的权重 GLB 顶替刚性切分（不切、不补口，整身连着），按几何区域纠正（hybrid_weights）
        wpath = wsrc
        log['weights_sha256'] = sha256(wpath)
        ht = spec.get('weights', {}).get('tris', budget - 400)
        for attempt in range(4):
            Vd, Fd = decimate(W, WF, ht, log)
            bm, _ = split(Vd, Fd, f, spec, log, mode='hybrid')
            print('AI_GOLEM_TRY', attempt, 'decimated', len(Fd), 'faces', len(bm.faces), flush=True)
            if len(bm.faces) <= budget - 8 or attempt == 3:
                break
            bm.free()
            ht = int(ht * (budget - 16) / log['split']['faces'])
        if len(bm.faces) > budget:
            raise RuntimeError('三角形 %d 超过上限 %d' % (len(bm.faces), budget))
        Lh = bm.faces.layers.int['lab']
        bm.verts.index_update()
        bm.faces.index_update()
        P = np.array([v.co[:] for v in bm.verts])
        regions = []
        for v in bm.verts:
            cnt = {}
            for fc in v.link_faces:
                cnt[fc[Lh]] = cnt.get(fc[Lh], 0) + 1
            regions.append(gf.NAMES[max(sorted(cnt), key=lambda k: cnt[k])])
        auto = transfer_weights(P, load_weights(wpath, f))
        wlist = hybrid_weights(P, regions, auto, spec, log)
        soft = []
        log['split']['mode'] = 'hybrid'
    for attempt in range(0 if wsrc else 4):
        Vd, Fd = decimate(W, WF, target, log)
        bm, soft = split(Vd, Fd, f, spec, log)
        print('AI_GOLEM_TRY', attempt, 'decimated', len(Fd), 'split', log['split'], flush=True)
        if len(bm.faces) <= budget - 40 or attempt == 3:
            break
        bm.free()
        target = int(target * (budget - 80) / log['split']['faces'])
    log['tris'] = len(bm.faces)
    L = bm.faces.layers.int['lab']
    Lc = bm.faces.layers.int['cap']
    bm.faces.ensure_lookup_table()
    name = o.get('name') or 'ca_boss_golem_' + spec['name']
    cc = corner_colours(bm, L, Lc, smp, spec, log)
    modes = (o.get('modes') or 'vc,tex').split(',')
    for mode in modes:
        tex_path = None
        if mode == 'tex':
            tex_path = os.path.join(out, 'albedo.jpg')
            UVn = bake_texture(bm, L, Lc, smp, spec, tex_path, log)
        ob = build_object(bm, L, Lc, cc, name, mode, f, spec, log, tex_path)
        if mode == 'tex':
            uvl = ob.data.uv_layers['UVMap'].data
            for p in ob.data.polygons:
                for k, li in enumerate(p.loop_indices):
                    uvl[li].uv = tuple(UVn[p.index][k])
        # 面标签写成属性，导出时按顶点取骨骼
        at = ob.data.attributes.new('lab', 'INT', 'FACE')
        at2 = ob.data.attributes.new('cap', 'INT', 'FACE')
        for fc in bm.faces:
            at.data[fc.index].value = fc[L]
            at2.data[fc.index].value = fc[Lc]
        path = o.get('path') or os.path.join(out, 'golem_%s_%s.glb' % (spec['name'] + ('h' if wsrc else ''), mode))
        arm = export(ob, f, soft, path, log, wlist)
        bpy.data.objects.remove(ob)
        bpy.data.objects.remove(arm)
        for act in list(bpy.data.actions):  # 下一种外观重新写动作（同名的动作还在的话会变成 .001）
            bpy.data.actions.remove(act)
        for ad in list(bpy.data.armatures):
            bpy.data.armatures.remove(ad)
        log.setdefault('sha256', {})[os.path.basename(path)] = sha256(path)
    if 'tex' in modes:
        log['sha256']['albedo.jpg'] = sha256(os.path.join(out, 'albedo.jpg'))
    with open(os.path.join(out, 'build.json'), 'w', encoding='utf-8') as fh:
        json.dump(log, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print('AI_GOLEM_OK', out, 'tris', log['tris'], flush=True)
    return log


def source_state(spec_path):
    """'ok' / 'missing' / 'mismatch'：源 GLB（和混合蒙皮的权重 GLB）在不在、sha256 和参数里记的（source.sha256 / weights.sha256）对不对得上"""
    with open(os.path.join(ROOT, spec_path), encoding='utf-8') as fh:
        spec = json.load(fh)
    files = [(source_path(spec), spec['source'].get('sha256'))]
    co = spec.get('concept')
    if co and co.get('use', True):
        files.append((os.path.join(os.path.dirname(source_path(spec)), co.get('file', 'concept.png')), co.get('sha256')))
    if spec.get('weights', {}).get('glb'):
        files.append((os.path.join(src_root(), spec['weights']['glb']), spec['weights'].get('sha256')))
    for f, want in files:
        if not os.path.exists(f):
            return 'missing'
        if want and sha256(f) != want:
            return 'mismatch'
    return 'ok'


def glb_info(path):
    """已提交的首领 GLB：三角形数、骨骼数、动作名（没有源文件、保留生成物时给清单用）"""
    js, bin_ = _glb(path)
    pr = js['meshes'][0]['primitives'][0]
    return dict(tris=js['accessors'][pr['indices']]['count'] // 3, bones=len(js['skins'][0]['joints']), clips=sorted(a['name'] for a in js.get('animations', [])))


def src_root():
    """AI 源文件仓库（cinder-ai-src，私有、不进游戏仓库）：环境变量 CA_AI_ROOT，缺省 ~/dev/cinder-ai-src"""
    return os.environ.get('CA_AI_ROOT', os.path.join(os.path.expanduser('~'), 'dev', 'cinder-ai-src'))


def source_path(spec):
    return os.path.join(src_root(), 'models', spec['source']['name'], spec['source']['file'])


def main():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    o = {a[i][2:]: a[i + 1] for i in range(0, len(a) - 1, 2) if a[i].startswith('--')}
    run(o)


if __name__ == '__main__':
    main()
