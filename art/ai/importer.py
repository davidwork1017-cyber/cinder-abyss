# AI 生成模型的导入（ai3d-pilot）：把用户那边生成的 GLB（文生图 → 图生 3D，见 docs/art-pipeline.md「AI 生成的布景件」）变成游戏里的布景件。
# 在 art/build.py 里当一个生成器用（catalog 里 gen='ai'），后面的收尾 / 烘焙 / 导出 / 清单 / 打包 / check-art 和脚本件走同一条路。
# 输入：源 GLB（不进仓库，放在 CA_AI_INBOX/<name>/model.glb）+ assets/ai/<slug>/provenance.json 里的 processing（每件的处理参数）。
# 步骤：导入 → 摆正（Pixal3D 的输出按概念图的相机倾斜，TRELLIS.2 的是正的）→ 焊接 UV 缝 → 去掉悬空的小碎块和非流形面 → 贴地、按真实尺寸缩放
#      → 减面到这一档的预算 → 两种外观之一：
#        albedo：保留生成的反照率贴图（降到 512 / 256、轻调明暗），网格用源的 UV，顶点色只烘 AO（和脚本件同一套烘焙），材质 ai_albedo、GLB 里不带图；
#        vc：按面取反照率的平均色，量化到共享调色板的几行（和脚本件一样一面一色，不要贴图）。
# 确定性：不用随机数；减面、焊接、栅格化、缩图都是固定算法，同一台机器、同一个 Blender 版本重复构建逐字节相同（贴图 JPEG 也是）。
import hashlib
import json
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from ca import palette

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # 仓库根目录（art/ai/ 往上两层）


def inbox():
    """源文件目录：环境变量 CA_AI_INBOX（缺省 art/ai/inbox，已在 .gitignore 里）"""
    return os.environ.get('CA_AI_INBOX') or os.path.join(ROOT, 'art', 'ai', 'inbox')


def load_prov(args):
    with open(os.path.join(ROOT, args['prov']), encoding='utf-8') as fh:
        return json.load(fh)


def source_path(args):
    p = load_prov(args)
    return os.path.join(inbox(), p['source']['name'], p['source']['file'])


def source_state(args):
    """'ok' / 'missing' / 'mismatch'（源文件的 sha256 和 provenance 里记的不一样）"""
    p = load_prov(args)
    f = source_path(args)
    if not os.path.exists(f):
        return 'missing'
    with open(f, 'rb') as fh:
        h = hashlib.sha256(fh.read()).hexdigest()
    return 'ok' if h == p['source']['sha256'] else 'mismatch'


# ---------- 导入 ----------
def _import(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    obs = sorted([o for o in bpy.data.objects if o not in before and o.type == 'MESH'], key=lambda o: o.name)
    if not obs:
        raise RuntimeError('源 GLB 里没有网格：' + path)
    return obs


def _albedo_of(mat):
    """材质的底色贴图（numpy，H×W×3，sRGB 0–1，行 0 = glTF 的 v = 0）和底色系数"""
    fac = (1.0, 1.0, 1.0)
    if not mat or not mat.node_tree:
        return None, fac
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return None, fac
    inp = bsdf.inputs['Base Color']
    fac = tuple(inp.default_value[:3])
    node = None
    stack = [l.from_node for l in inp.links]
    while stack and node is None:  # 底色可能经过乘系数的节点，往上找第一张图
        n = stack.pop(0)
        if n.type == 'TEX_IMAGE':
            node = n
        else:
            for i in n.inputs:
                stack.extend(l.from_node for l in i.links)
    if node is None or node.image is None:
        return None, fac
    im = node.image
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)  # 8 位图：图像自己色彩空间里的值（sRGB 编码），没有转线性
    px = px.reshape(h, w, 4)[::-1, :, :3]  # Blender 的行 0 在底部，翻成 glTF 的 v 朝下
    return np.ascontiguousarray(px), fac


# ---------- 网格整理 ----------
def _islands(bm):
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        st, isl = [f], []
        seen.add(f.index)
        while st:
            g = st.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        st.append(h)
        out.append(isl)
    return out


def _clean(bm, spec, log):
    """焊接 UV 缝（位置相同的顶点合成一个，UV 留在面角上）→ 删掉退化面 / 多于两个面共用的边上多出来的面 → 删掉悬空的小碎块"""
    bm.verts.ensure_lookup_table()
    diag = (Vector([max(v.co[i] for v in bm.verts) for i in range(3)]) - Vector([min(v.co[i] for v in bm.verts) for i in range(3)])).length
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=spec.get('weld', 1e-5) * diag)
    bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=1e-7 * diag)
    bm.faces.ensure_lookup_table()
    bad = []
    for e in bm.edges:
        if len(e.link_faces) > 2:
            bad.extend(sorted(e.link_faces, key=lambda f: f.index)[2:])
    bad = list({f.index: f for f in bad}.values())
    if bad:
        bmesh.ops.delete(bm, geom=bad, context='FACES')
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    isl = _islands(bm)
    total = len(bm.faces)
    zmin = min(v.co.z for v in bm.verts)
    h = max(v.co.z for v in bm.verts) - zmin
    drop = []
    for faces in isl:
        vs = {v for f in faces for v in f.verts}
        lo = min(v.co.z for v in vs) - zmin
        ext = max(max(v.co[i] for v in vs) - min(v.co[i] for v in vs) for i in range(3))
        small = len(faces) < spec.get('min_island', 0.002) * total
        floating = lo > spec.get('float_h', 0.08) * h  # 底部离地面还有一截：飘在空中的碎块（落在别的块上的石头不算：它们的底在下面那块的高度以下也会被保留）
        if small and (floating or ext < 0.02 * h):
            drop.extend(faces)
    if drop:
        bmesh.ops.delete(bm, geom=drop, context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
    log['clean'] = dict(weld_rel=spec.get('weld', 1e-5), nonmanifold_faces=len(bad), islands=len(isl), dropped_islands_faces=len(drop), faces=len(bm.faces))


def _transform(bm, spec):
    """摆正（rot_deg：XYZ 欧拉，度，Blender 坐标 Z 朝上）→ 缩放到 height 米 → 原点放到包围盒水平中心、底面 z = -sink"""
    rx, ry, rz = [math.radians(a) for a in spec.get('rot_deg', [0, 0, 0])]
    from mathutils import Euler
    bmesh.ops.transform(bm, matrix=Euler((rx, ry, rz), 'XYZ').to_matrix().to_4x4(), verts=list(bm.verts))
    if spec.get('level'):
        _level(bm)
    vs = list(bm.verts)
    lo = Vector([min(v.co[i] for v in vs) for i in range(3)])
    hi = Vector([max(v.co[i] for v in vs) for i in range(3)])
    s = spec['height'] / (hi.z - lo.z)
    c = (lo + hi) / 2
    M = Matrix.Translation((0, 0, -spec.get('sink', 0.0))) @ Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation((-c.x, -c.y, -lo.z))
    bmesh.ops.transform(bm, matrix=M, verts=vs)


def _level(bm):
    """Pixal3D 的倾斜不知道角度时：底部 8% 高度的顶点拟合一个平面，转到水平（两轮）"""
    for _ in range(2):
        zs = [v.co.z for v in bm.verts]
        z0, z1 = min(zs), max(zs)
        P = np.array([tuple(v.co) for v in bm.verts if v.co.z < z0 + 0.08 * (z1 - z0)], dtype=np.float64)
        P -= P.mean(axis=0)
        n = np.linalg.svd(P, full_matrices=False)[2][2]
        n = Vector(n.tolist())
        if n.z < 0:
            n = -n
        q = n.rotation_difference(Vector((0, 0, 1)))
        bmesh.ops.transform(bm, matrix=q.to_matrix().to_4x4(), verts=list(bm.verts))


def _decimate(me, target, log, key):
    """减面（Blender 的 Decimate · Collapse，三角化）到 target 个三角形以内；比例按实测修正，最多 4 轮"""
    ob = bpy.data.objects.new('ai_dec', me)
    bpy.context.scene.collection.objects.link(ob)
    n0 = sum(len(p.vertices) - 2 for p in me.polygons)
    ratio = min(1.0, target / max(1, n0))
    src = me.copy()
    tris = n0
    for it in range(4):
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
    log[key] = dict(target=target, tris=tris, ratio=round(ratio, 6), source_tris=n0)
    return out


# ---------- 贴图 ----------
def _raster_mask(uvs, w, h):
    """源 UV 三角形覆盖到的像素（1024 上），用来把岛外的空白往外填（缩图时缝边不渗进底色）"""
    m = np.zeros((h, w), dtype=bool)
    for t in uvs:
        xs, ys = t[:, 0] * w - 0.5, t[:, 1] * h - 0.5
        x0, x1 = max(0, int(math.floor(xs.min())) - 1), min(w - 1, int(math.ceil(xs.max())) + 1)
        y0, y1 = max(0, int(math.floor(ys.min())) - 1), min(h - 1, int(math.ceil(ys.max())) + 1)
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        (ax, ay), (bx, by), (cx, cy) = (xs[0], ys[0]), (xs[1], ys[1]), (xs[2], ys[2])
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-12:
            continue
        l1 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / d
        l2 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / d
        l3 = 1 - l1 - l2
        e = 0.75 / max(abs(d), 1e-9) ** 0.5  # 半个像素左右的余量
        m[y0:y1 + 1, x0:x1 + 1] |= (l1 >= -e) & (l2 >= -e) & (l3 >= -e)
    return m


def _dilate(img, mask, n):
    img = img.copy()
    m = mask.copy()
    for _ in range(n):
        acc = np.zeros_like(img)
        cnt = np.zeros(m.shape, dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sm = np.roll(np.roll(m, dy, 0), dx, 1)
                si = np.roll(np.roll(img, dy, 0), dx, 1)
                acc += si * sm[..., None]
                cnt += sm
        grow = (~m) & (cnt > 0)
        img[grow] = acc[grow] / cnt[grow][:, None]
        m = m | grow
    return img


def s2l(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def _grade(img, g):
    """轻调明暗（线性空间）：tint 每个通道的倍数（按游戏里的灰度校准：压到地面 / 岩壁那一档、往区域的冷色里收）、gain 整体倍数、
    sat 饱和度（围绕 Rec.709 亮度）、gamma 中间调、lift 抬暗部"""
    if not g:
        return img
    lin = s2l(img)
    if g.get('tint'):
        lin = lin * np.array(g['tint'], dtype=np.float64)
    y = (lin @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    lin = y + (lin - y) * g.get('sat', 1.0)
    lin = np.clip(lin, 0, None) * g.get('gain', 1.0)
    if g.get('gamma', 1.0) != 1.0:
        lin = np.clip(lin, 0, 1) ** g['gamma']
    if g.get('lift', 0.0):
        lin = g['lift'] + (1 - g['lift']) * lin
    return l2s(lin)


def _box(img, f):
    h, w, c = img.shape
    return img.reshape(h // f, f, w // f, f, c).mean(axis=(1, 3))


def _save_jpg(img, path, quality):
    """numpy（行 0 = 上）→ JPEG（Blender 自带的编码器，同样的像素同样的字节）"""
    h, w, _ = img.shape
    im = bpy.data.images.new('ai_tex_out', w, h, alpha=False)
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = np.round(np.clip(img, 0, 1) * 255) / 255
    im.pixels.foreach_set(rgba[::-1].ravel())
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.quality = quality
    sc.render.image_settings.color_mode = 'RGB'
    im.save_render(path, scene=sc)
    bpy.data.images.remove(im)


def write_textures(px, uvs_src, spec, log):
    """反照率：岛外空白往外填 → 调明暗 → 盒式缩到 px（和 lo_px）→ assets/ai/<slug>/albedo.jpg（和 lo/albedo.jpg）"""
    t = spec['tex']
    h, w, _ = px.shape
    mask = _raster_mask(uvs_src, w, h)
    img = _dilate(px, mask, t.get('dilate', 24))
    img = _grade(img, t.get('grade'))
    out = os.path.join(ROOT, t['dir'])
    sizes = [('albedo.jpg', t['px'])] + ([(os.path.join('lo', 'albedo.jpg'), t['lo_px'])] if t.get('lo_px') else [])  # lo_px：低画质也显示时的小图（tools/asset-sources.json 写 lo: true）
    for rel, n in sizes:
        f = w // n
        if f < 1 or w % n or h != w:
            raise RuntimeError('源贴图 %dx%d 不能整数缩到 %d' % (w, h, n))
        _save_jpg(_box(img, f) if f > 1 else img, os.path.join(out, rel), t.get('quality', 90))
    log['tex'] = dict(src=[w, h], px=t['px'], lo_px=t.get('lo_px'), coverage=round(float(mask.mean()), 4))


def _sample(px, uv):
    """最近像素取色（uv 是 glTF 约定：v 朝下）"""
    h, w, _ = px.shape
    u = (uv[..., 0] % 1.0) * w
    v = (uv[..., 1] % 1.0) * h
    return px[np.clip(v.astype(np.int64), 0, h - 1), np.clip(u.astype(np.int64), 0, w - 1)]


def _lab(rgb_lin):
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = rgb_lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


# ---------- 入口（catalog 的 gen='ai'） ----------
def ai(k, prov, lod='hi', mode='albedo', part=None):
    """k = core.Kit；prov = provenance.json 的仓库内路径；lod = processing.lods 里的哪一档；mode = albedo / vc / fc（武器：逐面取色 + 发光拆分，见 art/ai/weapon.py）"""
    if mode == 'fc':
        from ai import weapon
        return weapon.build(k, prov, lod, part)
    P = load_prov(dict(prov=prov))
    spec = P['processing']
    log = {}
    obs = _import(source_path(dict(prov=prov)))
    # 合成一个 bmesh（世界坐标），面角带源 UV；记下每个面的材质 → 底色贴图
    mats, texs = [], []
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
    for m in mats:
        texs.append(_albedo_of(m))
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='FIXED', ngon_method='EAR_CLIP')
    uvl = bm.loops.layers.uv.active
    if uvl is None:
        raise RuntimeError('源 GLB 没有 UV')
    if len(texs) != 1 or texs[0][0] is None:
        raise RuntimeError('源 GLB 要正好一个带底色贴图的材质（现在 %d 个）' % len(texs))
    px, fac = texs[0]
    px = px * np.array(fac, dtype=np.float32)
    src_tris = len(bm.faces)
    uvs_src = [np.array([tuple(l[uvl].uv) for l in f.loops]) for f in bm.faces]
    for t in uvs_src:
        t[:, 1] = 1.0 - t[:, 1]  # Blender 的 v 朝上 → glTF 的 v 朝下（和 _albedo_of 的行序一致）
    _clean(bm, spec, log)
    _transform(bm, spec)
    for o in obs:
        bpy.data.objects.remove(o)
    # 高精度的整理后网格留一份：vc 模式按面取色用（BVH 找最近的源三角形）
    me_src = bpy.data.meshes.new('ai_src')
    bm.to_mesh(me_src)
    bm.free()
    me_lod = _decimate(me_src, spec['lods'][lod], log, 'decimate')
    if mode == 'albedo' and lod == spec.get('tex_lod', 'hi'):
        write_textures(px, uvs_src, spec, log)
    # 进 Kit：顶点、面按 Blender 网格的顺序（固定）。albedo 模式面角带源 UV；vc 模式不留 UV 层（core.to_object 会写调色板 UV）
    kb = k.bm
    kuv = kb.loops.layers.uv.new('UVMap') if mode == 'albedo' else None
    vs = [kb.verts.new(v.co) for v in me_lod.vertices]
    uvd = me_lod.uv_layers.active.data if me_lod.uv_layers.active else None
    faces, fuv = [], []
    for p in me_lod.polygons:
        try:
            f = kb.faces.new([vs[i] for i in p.vertices])
        except ValueError:
            continue  # 减面后偶尔出现的重复面：丢掉
        uv = [tuple(uvd[li].uv) if uvd else (0.0, 0.0) for li in p.loop_indices]
        if kuv:
            for l, u in zip(f.loops, uv):
                l[kuv].uv = u
        faces.append(f)
        fuv.append(uv)
    if mode == 'albedo':
        k.tag(faces, 'stone', tone=0.5, jitter=0.0, dust=0)  # 调色板标签只给收尾 / 烘焙用（不进外观）
        k.ai_albedo = True
    else:
        _vc_tags(k, faces, fuv, px, spec, log)
    k.ai_log = log
    bpy.data.meshes.remove(me_lod)
    bpy.data.meshes.remove(me_src)
    for m in mats:
        if m.users == 0:
            bpy.data.materials.remove(m)
    for im in list(bpy.data.images):
        if im.users == 0:
            bpy.data.images.remove(im)
    print('CA_AI ' + json.dumps(dict(prov=prov, lod=lod, mode=mode, src_tris=src_tris, **log), ensure_ascii=False), flush=True)


def _vc_tags(k, faces, fuv, px, spec, log):
    """vc 模式：每个面在面内 4 个点取反照率（线性平均），量化到 processing.vc.rows 这几行调色板上最近的颜色（Lab 距离，明暗先按分位数拉到这几行的范围）"""
    V = spec.get('vc', {})
    rows = V.get('rows', ['stone', 'pale'])
    W4 = np.array([[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]])
    cols = []
    for uv in fuv:
        uv = np.array(uv)
        uv[:, 1] = 1.0 - uv[:, 1]
        cols.append(s2l(_sample(px, W4 @ uv)).mean(axis=0))
    lab = _lab(np.array(cols))
    cand = []
    for r in rows:
        for i in range(64):
            u = (i + 0.5) / 64
            cand.append((r, u, [c / 255 for c in palette.ramp(palette.ROW[r], u)]))
    clab = _lab(s2l(np.array([c[2] for c in cand])))
    Ls, Lc = lab[:, 0], clab[:, 0]
    lo, hi = np.percentile(Ls, 3), np.percentile(Ls, 97)
    L = Lc.min() + (Ls - lo) / max(1e-6, hi - lo) * (Lc.max() - Lc.min())
    q = np.stack([L, lab[:, 1] * V.get('chroma', 1.0), lab[:, 2] * V.get('chroma', 1.0)], axis=-1)
    d = ((q[:, None, :] - clab[None, :, :]) ** 2).sum(-1)
    pick = d.argmin(axis=1)
    for f, j in zip(faces, pick):
        r, u, _ = cand[int(j)]
        k.tag([f], r, tone=u, jitter=0.0, dust=0)
    log['vc'] = dict(rows=rows, faces=len(faces))


def to_object(k, name):
    """albedo 模式的网格对象：保留源 UV，材质 ai_albedo（不带贴图：贴图在 assets/ai/<slug>/，游戏端按 tex id 取）"""
    me = bpy.data.meshes.new(name)
    k.bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = False
    mat = bpy.data.materials.new('ai_albedo')
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Metallic'].default_value = 0.0
    me.materials.append(mat)
    return ob
