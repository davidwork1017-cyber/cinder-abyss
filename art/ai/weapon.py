# AI 生成的武器（ai3d-weapons）：从源 GLB 导入成游戏里的手持武器 / 掉落模型。importer.ai(mode='fc') 走这里。
# 和布景件（importer.py 的 albedo / vc）的区别：
#   - 外观 fc：每个面一个颜色，从源反照率贴图里取（面内 4 点线性平均），可选按件聚成几种色块；不要贴图、不用调色板。
#     导出时颜色写进面角的 COLOR_0（线性），UV 全是 0，材质 ai_fc（GLB 里不带图）；打包时 bakeGeo 只乘 baseColorFactor（= 1），
#     游戏端拿到的就是纯顶点色的几何体，和脚本件的掉落模型 / 主角骨架上的零件同一套材质。
#   - 发光：贴图里发光的那块（青光槽、晶体、符槽…）是普通的颜色，没有自发光通道。按 HSV 规则在源网格（2 万面）上逐面判定，
#     邻接关系上去掉小碎块、补上小洞（锤头面板里的「XXX」花纹也补成一整块），发光面 α = 0（COLOR_0 的 α = 1 - 发光）。
#     游戏里发光面单独成一份几何体，按稀有度着色（和脚本件一样），所以花纹本身不会出现在游戏里。
#   - 发光壳：本体是整个源网格（闭合的）单独减面，颜色只从非发光面取；发光面往外长一圈、沿法线往外推几毫米，单独减面成一层薄壳盖在上面
#     （游戏里发光本来就是另一份几何体）。逐面判定再减面的话，几百面时发光区的轮廓碎成锯齿；分开减，两边的边界都留得住，也没有裂缝。
#   - 坐标：先转到武器自己的坐标（长轴 = Blender +Z，「上」= +X：刃宽 / 枪背的方向，厚度 = Y），按 length 缩放到真实尺寸，
#     原点放在握把中心（grip：包围盒里的归一化位置）。游戏端再换算到手的武器关节和掉落模型的坐标（world.js 的 AIW_FIT）。
#   - 规则（发光的 glow.rules、要删的 drop）：颜色条件 h / s / v，可以再加几何条件 at（面心在包围盒里的归一化范围）和 facing（法线朝向）；
#     只有几何条件的规则按位置判（生成时发光褪色了的件：沿刃 / 弓臂的一道窄带）。
#   - part：只要一段（机炮的枪管束单独成一件，挂在会转的关节上）：按长轴的归一化位置切开，面心在范围内的留下。
# 确定性：不用随机数；k-means 的初值按亮度分位数取，迭代次数固定。
import json
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from ai import importer

W4 = np.array([[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]])
AX = {'+x': (1, 0, 0), '-x': (-1, 0, 0), '+y': (0, 1, 0), '-y': (0, -1, 0), '+z': (0, 0, 1), '-z': (0, 0, -1)}


def _hsv(rgb):
    """sRGB 0–1（…×3）→ 色相（度）、饱和度、明度"""
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = np.maximum(mx - mn, 1e-6)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60.0
    s = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    return h, s, mx


def _geo_ok(r, nc, nrm):
    """规则里的几何条件：at = 面心在包围盒里的归一化范围 {"up" / "thick" / "long": [a, b]}；facing = [轴, 最小点积]（法线朝向，比如 ["+z", 0.5] 只要刃面）"""
    if 'at' in r:
        for k, i in (('up', 0), ('thick', 1), ('long', 2)):
            if k in r['at'] and not (r['at'][k][0] <= nc[i] <= r['at'][k][1]):
                return False
    if 'facing' in r:
        ax, lo = r['facing']
        d = AX[ax]
        if nrm[0] * d[0] + nrm[1] * d[1] + nrm[2] * d[2] < lo:
            return False
    return True


def _rule_hit(h, s, v, r):
    """规则的颜色条件（h / s / v 的范围，都可省；只有几何条件的规则 = 纯按位置判，生成时发光褪色了的件用）"""
    ok = np.ones(h.shape, dtype=bool)
    if 'h' in r:
        lo, hi = r['h']
        ok &= ((h >= lo) & (h <= hi)) if lo <= hi else ((h >= lo) | (h <= hi))
    if 's' in r:
        ok &= (s >= r['s'][0]) & (s <= r['s'][1])
    if 'v' in r:
        ok &= (v >= r['v'][0]) & (v <= r['v'][1])
    return ok


def _frame(bm, spec):
    """转到武器坐标（长轴 +Z、上 +X），按 length 缩放，原点放到握把（grip = [上, 长] 在包围盒里的归一化位置，厚度方向居中）"""
    fr = spec['frame']
    zl, xu = Vector(AX[fr['long']]), Vector(AX[fr['up']])
    yt = zl.cross(xu)
    R = Matrix((xu, yt, zl))  # 行 = 新的 X / Y / Z 轴在旧坐标里的方向
    bmesh.ops.transform(bm, matrix=R.to_4x4(), verts=list(bm.verts))
    vs = list(bm.verts)
    lo = Vector([min(v.co[i] for v in vs) for i in range(3)])
    hi = Vector([max(v.co[i] for v in vs) for i in range(3)])
    s = spec['length'] / (hi.z - lo.z)
    gu, gl = spec['grip']
    o = Vector((lo.x + gu * (hi.x - lo.x), (lo.y + hi.y) / 2, lo.z + gl * (hi.z - lo.z)))
    bmesh.ops.transform(bm, matrix=Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation(-o), verts=vs)
    return (lo - o) * s, (hi - o) * s


def _adj(faces):
    idx = {f.index: i for i, f in enumerate(faces)}
    nb = [[] for _ in faces]
    for i, f in enumerate(faces):
        for e in f.edges:
            for g in e.link_faces:
                if g is not f and g.index in idx:
                    nb[i].append(idx[g.index])
    return nb


def _components(nb, mask, want):
    """mask == want 的面按邻接分块（按面序，结果固定）"""
    seen = np.zeros(len(nb), dtype=bool)
    out = []
    for i in range(len(nb)):
        if seen[i] or mask[i] != want:
            continue
        st, comp = [i], []
        seen[i] = True
        while st:
            j = st.pop()
            comp.append(j)
            for k in nb[j]:
                if not seen[k] and mask[k] == want:
                    seen[k] = True
                    st.append(k)
        out.append(comp)
    return out


def _morph(nb, glow, area, g):
    """去掉面积小于 min_area 的发光碎块；把被发光区包住、面积小于 fill_area 的非发光小块补成发光（花纹、小洞）；再按 grow 圈往外长"""
    glow = glow.copy()
    tot = float(area.sum())
    for comp in _components(nb, glow, True):
        if area[comp].sum() < g.get('min_area', 0.0005) * tot:
            glow[comp] = False
    fill = g.get('fill_area', 0.0)
    if fill > 0:
        for comp in _components(nb, glow, False):
            # 连通块是极大的：块外的邻面一定是发光面。还要真的挨着发光面（孤立的小碎块不算被包住）
            if area[comp].sum() < fill * tot and any(glow[k] for j in comp for k in nb[j]):
                glow[comp] = True
    for _ in range(g.get('grow', 0)):
        add = [i for i in range(len(nb)) if not glow[i] and any(glow[k] for k in nb[i])]
        glow[add] = True
    return glow


def _kmeans(lab, w, k, iters=24):
    """加权 k-means（Lab）：初值按 L 的加权分位数取（不用随机数）"""
    o = np.argsort(lab[:, 0], kind='stable')
    cw = np.cumsum(w[o]) / w.sum()
    cen = np.array([lab[o[min(len(o) - 1, int(np.searchsorted(cw, (i + 0.5) / k)))]] for i in range(k)])
    for _ in range(iters):
        d = ((lab[:, None, :] - cen[None, :, :]) ** 2).sum(-1)
        a = d.argmin(1)
        for j in range(k):
            m = a == j
            if m.any():
                cen[j] = (lab[m] * w[m, None]).sum(0) / w[m].sum()
    d = ((lab[:, None, :] - cen[None, :, :]) ** 2).sum(-1)
    return d.argmin(1)


def _grade(lin, g):
    if not g:
        return lin
    if g.get('tint'):
        lin = lin * np.array(g['tint'])
    y = (lin @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    lin = y + (lin - y) * g.get('sat', 1.0)
    lin = np.clip(lin, 0, None) * g.get('gain', 1.0)
    if g.get('gamma', 1.0) != 1.0:
        lin = np.clip(lin, 0, 1) ** g['gamma']
    return np.clip(lin, 0, 1)


def build(k, prov, lod='hi', part=None):
    P = importer.load_prov(dict(prov=prov))
    spec = P['processing']
    log = {}
    obs = importer._import(importer.source_path(dict(prov=prov)))
    mats = []
    bm = bmesh.new()
    for o in obs:
        me = o.data
        tmp = bmesh.new()
        tmp.from_mesh(me)
        tmp.transform(o.matrix_world)
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
        for m in me.materials:
            if m not in mats:
                mats.append(m)
    texs = [importer._albedo_of(m) for m in mats]
    if len(texs) != 1 or texs[0][0] is None:
        raise RuntimeError('源 GLB 要正好一个带底色贴图的材质（现在 %d 个）' % len(texs))
    px, fac = texs[0]
    px = px * np.array(fac, dtype=np.float32)
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='FIXED', ngon_method='EAR_CLIP')
    src_tris = len(bm.faces)
    importer._clean(bm, spec, log)
    lo, hi = _frame(bm, spec)
    for o in obs:
        bpy.data.objects.remove(o)
    if part:
        # 分段：spec['split'] = {"front": 前段的名字, "from": 长轴归一化位置, "dark_from", "dark_v", "dark_s"}：面心在 from 之后的归前段；
        # dark_from 到 from 之间只有暗灰的面（明度 < dark_v、饱和度 < dark_s：枪管伸进黄铜箍里的那一截）归前段，黄铜箍留在本体
        sp = spec['split']
        uvl0 = bm.loops.layers.uv.active
        bm.faces.ensure_lookup_table()

        def front(f):
            t = (f.calc_center_median().z - lo.z) / (hi.z - lo.z)
            if t >= sp['from']:
                return True
            if t < sp['dark_from']:
                return False
            uv = np.array([tuple(l[uvl0].uv) for l in f.loops])
            uv[:, 1] = 1.0 - uv[:, 1]
            h, sa, v = _hsv(importer._sample(px, W4 @ uv))
            return float(v.mean()) < sp['dark_v'] and float(sa.mean()) < sp['dark_s']
        drop = [f for f in bm.faces if front(f) != (part == spec['split']['front'])]
        bmesh.ops.delete(bm, geom=drop, context='FACES')
        bm.faces.ensure_lookup_table()
        bm.faces.index_update()
        tot = len(bm.faces)
        bits = [f for isl in importer._islands(bm) if len(isl) < sp.get('min_island', 0.01) * tot for f in isl]  # 切开后剩下的小碎片
        if bits:
            bmesh.ops.delete(bm, geom=bits, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.normal_update()  # 摆正以后面法线要重算（规则的 facing 用）
    if spec.get('drop'):
        # drop：删掉的部分（断成碎段的链子之类），规则和发光的一样（颜色 + 几何条件），面内 4 点过半命中就删
        uvd = bm.loops.layers.uv.active
        bm.faces.ensure_lookup_table()
        sp0 = np.array(hi - lo)
        dead = []
        for f in bm.faces:
            uv = np.array([tuple(l[uvd].uv) for l in f.loops])
            uv[:, 1] = 1.0 - uv[:, 1]
            h, s_, v = _hsv(importer._sample(px, W4 @ uv))
            nc = (np.array(f.calc_center_median()) - np.array(lo)) / sp0
            m = np.zeros(4, dtype=bool)
            for r in spec['drop']:
                if ('at' in r or 'facing' in r) and not _geo_ok(r, nc, f.normal):
                    continue
                m |= _rule_hit(h, s_, v, r)
            if m.mean() >= 0.5:
                dead.append(f)
        if dead:
            bmesh.ops.delete(bm, geom=dead, context='FACES')
            loose = [v for v in bm.verts if not v.link_faces]
            if loose:
                bmesh.ops.delete(bm, geom=loose, context='VERTS')
        log['dropped'] = len(dead)
    if spec.get('drop_rod'):
        # drop_rod：弓握把上横穿的一根杆（生成时和弓熔在一起的箭）。长轴 long 这一段里，横向（up）超出握把宽度的面都删掉；
        # 握把宽度按上下相邻两段（各 band 宽）里弓身的横向范围取，再放宽 pad
        r = spec['drop_rod']
        bm.faces.ensure_lookup_table()
        sp0 = np.array(hi - lo)
        cs = [((np.array(f.calc_center_median()) - np.array(lo)) / sp0, f) for f in bm.faces]
        l0, l1 = r['long']
        bw = r.get('band', 0.05)
        near = [c[0] for c, f in cs if (l0 - bw <= c[2] < l0) or (l1 < c[2] <= l1 + bw)]
        if near:
            g0, g1 = min(near) - r.get('pad', 0.02), max(near) + r.get('pad', 0.02)
            dead = [f for c, f in cs if l0 <= c[2] <= l1 and not (g0 <= c[0] <= g1)]
            if dead:
                bmesh.ops.delete(bm, geom=dead, context='FACES')
                loose = [v for v in bm.verts if not v.link_faces]
                if loose:
                    bmesh.ops.delete(bm, geom=loose, context='VERTS')
            log['drop_rod'] = dict(grip=[round(float(g0), 3), round(float(g1), 3)], faces=len(dead))
    if spec.get('drop_small'):
        # drop_small：删完以后剩下的小碎块（断开的弦、箭头）：面数少于总数的这个比例
        bm.faces.ensure_lookup_table()
        bm.faces.index_update()
        tot = len(bm.faces)
        bits = [f for isl in importer._islands(bm) if len(isl) < spec['drop_small'] * tot for f in isl]
        if bits:
            bmesh.ops.delete(bm, geom=bits, context='FACES')
            loose = [v for v in bm.verts if not v.link_faces]
            if loose:
                bmesh.ops.delete(bm, geom=loose, context='VERTS')
        log['drop_small'] = len(bits)
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    bm.verts.index_update()
    faces = list(bm.faces)
    # ---- 源网格逐面取色（4 点，最近像素，sRGB → 线性平均）、按 HSV 规则判发光 ----
    uvl = bm.loops.layers.uv.active
    G = spec['glow']
    n = len(faces)
    col = np.zeros((n, 3))
    hit = np.zeros(n)
    area = np.array([f.calc_area() for f in faces])
    cen = np.array([tuple(f.calc_center_median()) for f in faces])
    span = np.array(hi - lo)
    for i, f in enumerate(faces):
        uv = np.array([tuple(l[uvl].uv) for l in f.loops])
        uv[:, 1] = 1.0 - uv[:, 1]
        smp = importer._sample(px, W4 @ uv)
        col[i] = importer.s2l(smp).mean(axis=0)
        h, s, v = _hsv(smp)
        m = np.zeros(4, dtype=bool)
        nc = (cen[i] - np.array(lo)) / span
        for r in G['rules']:
            if ('at' in r or 'facing' in r) and not _geo_ok(r, nc, f.normal):
                continue
            m |= _rule_hit(h, s, v, r)
        hit[i] = m.mean()
    glow = hit >= G.get('frac', 0.5)
    if G.get('box'):
        b = G['box']  # 归一化的包围盒范围：{"up" / "long" / "thick": [a, b]}
        nu = (cen[:, 0] - lo.x) / span[0]
        nl = (cen[:, 2] - lo.z) / span[2]
        nt = (cen[:, 1] - lo.y) / span[1]
        glow &= (nu >= b.get('up', [0, 1])[0]) & (nu <= b.get('up', [0, 1])[1]) & (nl >= b.get('long', [0, 1])[0]) & (nl <= b.get('long', [0, 1])[1])
        glow &= (nt >= b.get('thick', [0, 1])[0]) & (nt <= b.get('thick', [0, 1])[1])  # thick：厚度方向（0 = -y 正面）
    nb = _adj(faces)
    raw = glow.copy()
    glow = _morph(nb, glow, area, G)
    if os.environ.get('CA_AIW_DEBUG'):  # 调参用：每个面的归一化位置、HSV、判定结果
        smp = np.clip(importer.l2s(col), 0, 1)
        h, s, v = _hsv(smp)
        np.savez(os.path.join(os.environ['CA_AIW_DEBUG'], os.path.basename(os.path.dirname(prov)) + ('_' + part if part else '') + '.npz'),
                 nu=(cen[:, 0] - lo.x) / span[0], nl=(cen[:, 2] - lo.z) / span[2], ny=(cen[:, 1] - lo.y) / span[1], h=h, s=s, v=v, hit=hit, raw=raw, glow=glow, area=area, col=smp)
    log['glow_src'] = dict(faces=int(glow.sum()), area=round(float(area[glow].sum() / area.sum()), 4))
    # ---- 本体：整个源网格（闭合的）减面；颜色只从非发光面取（发光区底下的本体面被发光壳盖住，取旁边的钢色，不取青色）----
    bm.normal_update()
    me_src = bpy.data.meshes.new('aiw_src')
    bm.to_mesh(me_src)
    srcP = [tuple(v.co) for v in bm.verts]
    keep = [i for i in range(n) if not glow[i]] or list(range(n))
    bvh = BVHTree.FromPolygons(srcP, [[v.index for v in faces[i].verts] for i in keep])
    target = spec['lods'][lod] if not part else spec['parts_lods'][part][lod]
    if G.get('cut_body') and glow.any():
        # 本体里不留发光区，只剩发光壳（壳往外长一圈，盖住本体上的洞口）。不切的话，几百面时减面后的本体会顶穿薄壳（光槽 / 符带被盖掉一截）
        bc = bm.copy()
        bc.faces.ensure_lookup_table()
        bmesh.ops.delete(bc, geom=[bc.faces[i] for i in range(n) if glow[i]], context='FACES')
        loose = [v for v in bc.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bc, geom=loose, context='VERTS')
        me_cut = bpy.data.meshes.new('aiw_cut')
        bc.to_mesh(me_cut)
        bc.free()
        me_body = _decimate(me_cut, target, log, 'decimate', spec.get('remesh', 0.0))
        bpy.data.meshes.remove(me_cut)
    else:
        me_body = _decimate(me_src, target, log, 'decimate', spec.get('remesh', 0.0))
    # ---- 发光壳：发光面往外长 shell_grow 圈（盖住和本体的接缝），沿顶点法线往外推 shell 米，单独减面 ----
    me_glow = None
    if glow.any():
        grown = glow.copy()
        for _ in range(G.get('shell_grow', 1)):
            add = [i for i in range(n) if not grown[i] and any(grown[k2] for k2 in nb[i])]
            grown[add] = True
        bg = bm.copy()
        bg.verts.ensure_lookup_table()
        bg.faces.ensure_lookup_table()
        d = G.get('shell', 0.003)
        for v, v0 in zip(bg.verts, bm.verts):
            v.co = v0.co + v0.normal * d
        bmesh.ops.delete(bg, geom=[bg.faces[i] for i in range(n) if not grown[i]], context='FACES')
        loose = [v for v in bg.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bg, geom=loose, context='VERTS')
        me_g = bpy.data.meshes.new('aiw_glow')
        bg.to_mesh(me_g)
        bg.free()
        me_glow = _decimate(me_g, spec['glow_lods'][lod], log, 'decimate_glow')
        bpy.data.meshes.remove(me_g)
    bm.free()
    # ---- 本体每个面：4 点在源网格（非发光面）上找最近的面，颜色取平均 ----
    out_c = []
    for p in me_body.polygons:
        vs = np.array([tuple(me_body.vertices[i].co) for i in p.vertices])
        cs = []
        for w in W4:
            hitp = bvh.find_nearest(Vector(tuple(w @ vs)))
            cs.append(col[keep[hitp[2]]] if hitp[2] is not None else col[keep[0]])
        out_c.append(np.mean(cs, axis=0))
    out_c = np.array(out_c)
    # 色块：按件聚成几种颜色（游戏镜头下读成干净的大色块，不是贴图上的噪点）
    larea = np.array([p.area for p in me_body.polygons])
    C = spec.get('colors', {})
    if C.get('k') and len(out_c) > C['k']:
        a = _kmeans(importer._lab(out_c), larea, C['k'])
        for j in range(C['k']):
            m = a == j
            if m.any():
                out_c[m] = (out_c[m] * larea[m, None]).sum(0) / larea[m].sum()
    out_c = _grade(out_c, (C.get('grade_parts') or {}).get(part) or C.get('grade'))  # grade_parts：分段各自调（机炮的枪管束比黄铜机匣提得多）
    log['tris'] = dict(body=len(me_body.polygons), glow=len(me_glow.polygons) if me_glow else 0)
    # ---- 进 Kit：先本体、再发光壳（面序 = 减面后网格的面序，固定）----
    kb = k.bm
    L_r = kb.faces.layers.float.new('fr')
    L_g = kb.faces.layers.float.new('fg')
    L_b = kb.faces.layers.float.new('fb')
    for me_x, is_g in ((me_body, False), (me_glow, True)):
        if me_x is None:
            continue
        vv = [kb.verts.new(v.co) for v in me_x.vertices]
        for i, p in enumerate(me_x.polygons):
            try:
                f = kb.faces.new([vv[j] for j in p.vertices])
            except ValueError:
                continue
            k.tag([f], 'iron', tone=0.5, jitter=0.0, glow=1.0 if is_g else 0.0, dust=0)
            c = (1.0, 1.0, 1.0) if is_g else out_c[i]
            f[L_r], f[L_g], f[L_b] = (float(x) for x in c)
        bpy.data.meshes.remove(me_x)
    k.ai_fc = True
    k.ai_log = log
    bpy.data.meshes.remove(me_src)
    for m in mats:
        if m.users == 0:
            bpy.data.materials.remove(m)
    for im in list(bpy.data.images):
        if im.users == 0:
            bpy.data.images.remove(im)
    print('CA_AI ' + json.dumps(dict(prov=prov, lod=lod, mode='fc', part=part, src_tris=src_tris, **log), ensure_ascii=False), flush=True)


def _remesh(me, voxel):
    """体素重建（OpenVDB，固定算法）：补上小洞（腰带的扣眼）、并掉小碎块（铆钉），减面才降得下去；颜色照旧从源网格取"""
    ob = bpy.data.objects.new('aiw_rm', me)
    bpy.context.scene.collection.objects.link(ob)
    md = ob.modifiers.new('rm', 'REMESH')
    md.mode = 'VOXEL'
    md.voxel_size = voxel
    md.adaptivity = 0.0
    for o in bpy.context.scene.objects:
        o.select_set(o is ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier='rm')
    out = ob.data
    bpy.data.objects.remove(ob)
    return out


def _decimate(me, target, log, key, voxel=0.0):
    """Decimate · Collapse（三角化）到 target 个三角形以内；比例按实测修正，最多 6 轮。voxel > 0 时先体素重建"""
    if voxel > 0:
        me = _remesh(me.copy(), voxel)
        log[key + '_remesh'] = dict(voxel=voxel, faces=len(me.polygons))
    ob = bpy.data.objects.new('aiw_dec', me)
    bpy.context.scene.collection.objects.link(ob)
    n0 = sum(len(p.vertices) - 2 for p in me.polygons)
    ratio = min(1.0, target / max(1, n0))
    src = me.copy()
    tris = n0
    for it in range(6):
        ob.data = src.copy()
        md = ob.modifiers.new('dec', 'DECIMATE')
        md.decimate_type = 'COLLAPSE'
        md.ratio = ratio
        md.use_collapse_triangulate = True
        for o in bpy.context.scene.objects:
            o.select_set(o is ob)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier='dec')
        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        if tris <= target and (tris >= 0.96 * target or ratio >= 1.0):
            break
        ratio = min(1.0, ratio * target / max(1, tris) * (0.995 if tris > target else 1.0))
    out = ob.data
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(src)
    log[key] = dict(target=target, tris=tris, ratio=round(ratio, 6), source_tris=n0, iters=it + 1)
    return out


def to_object(k, name):
    """fc 外观：面角 COLOR_0 = 面色（线性），α = 1 - 发光；UV 全 0；材质 ai_fc（不带图）"""
    me = bpy.data.meshes.new(name)
    k.bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    uv = me.uv_layers.new(name='UVMap')
    col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    fr, fg, fb = (me.attributes[n].data for n in ('fr', 'fg', 'fb'))
    gl = me.attributes['glow'].data
    for p in me.polygons:
        p.use_smooth = False
        c = (fr[p.index].value, fg[p.index].value, fb[p.index].value, 1.0 - gl[p.index].value)
        for li in p.loop_indices:
            uv.data[li].uv = (0.0, 0.0)
            col.data[li].color = c
    me.color_attributes.active_color = col
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    for n in ('fr', 'fg', 'fb', 'pal', 'tone', 'glow', 'dust', 'bone'):
        if n in me.attributes:
            me.attributes.remove(me.attributes[n])
    mat = bpy.data.materials.new('ai_fc')
    bsdf = next(nd for nd in mat.node_tree.nodes if nd.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Metallic'].default_value = 0.0
    me.materials.append(mat)
    return ob
