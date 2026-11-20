# 烬渊布景件生成的公共部分（在无头 Blender 里跑，bpy / bmesh）。
# 生成器只管「搭形」：往 Kit 里加盒子 / 凸包 / 管子，给每个面标上调色板行和明暗；
# 这里负责收尾：补标签、法线朝外、按面写 UV（落到调色板图集上）、烘焙 AO + 边缘磨损 + 高度渐变进顶点色（COLOR_0）、导出 GLB。
# 约定（见 docs/art-style.md）：单位米，Blender 里 Z 朝上（导出 glTF 时转成 Y 朝上），原点在底面中心，地面 z = 0。
# 确定性：所有随机数都来自 Kit.rng（random.Random(种子)），不读时间、不依赖集合 / 字典的迭代顺序以外的东西。
import math
import os
import random
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

from . import palette

ROW = palette.ROW


class Kit:
    def __init__(self, seed, name):
        self.seed = seed
        self.name = name
        self.rng = random.Random(seed)
        self.bm = bmesh.new()
        self.L_pal = self.bm.faces.layers.int.new('pal')  # 调色板行 + 1（0 = 还没标，收尾时从相邻面继承）
        self.L_tone = self.bm.faces.layers.float.new('tone')  # 色带上的位置 0–1
        self.L_glow = self.bm.faces.layers.int.new('glow')  # 1 = 余烬面：不压 AO、不加磨损，保持亮
        self.L_dust = self.bm.faces.layers.int.new('dust')  # 1 = 朝上的面可以盖积灰

    # ---------- 随机 ----------
    def r(self, a=0.0, b=1.0):
        return a + (b - a) * self.rng.random()

    def pick(self, seq):
        return seq[int(self.rng.random() * len(seq)) % len(seq)]

    # ---------- 标签 ----------
    def tag(self, faces, row, tone=0.5, jitter=0.1, glow=0, dust=1):
        rid = ROW[row] if isinstance(row, str) else row
        for f in faces:
            f[self.L_pal] = rid + 1
            f[self.L_tone] = min(0.98, max(0.02, tone + (self.rng.random() * 2 - 1) * jitter))
            f[self.L_glow] = glow
            f[self.L_dust] = dust
        return faces

    # ---------- 变换 ----------
    def xform(self, verts, mat):
        bmesh.ops.transform(self.bm, matrix=mat, verts=list(verts))

    @staticmethod
    def place(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        """平移 × 旋转（XYZ 欧拉，弧度）× 缩放"""
        from mathutils import Euler
        S = Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        return Matrix.Translation(Vector(loc)) @ Euler(rot, 'XYZ').to_matrix().to_4x4() @ S

    # ---------- 基本形 ----------
    def box(self, size, mat=None, row='stone', tone=0.5, jitter=0.1, bevel=0.0, glow=0, dust=1):
        """长方体（size = 三边长，中心在原点，再按 mat 变换）。bevel > 0 时是倒一刀的倒角盒：
        用 24 个点的凸包直接搭（每个角往三个方向各缩 bevel），不用 bmesh 的 bevel 操作——
        后者内部按指针地址排序，同一份输入在一次构建里的不同时刻会给出不同的顶点顺序，导出就不逐字节一致"""
        a, b, c = size[0] / 2, size[1] / 2, size[2] / 2
        if bevel > 0:
            d = min(bevel, a * 0.45, b * 0.45, c * 0.45)
            pts = []
            for sx in (-1, 1):
                for sy in (-1, 1):
                    for sz in (-1, 1):
                        pts += [(sx * a, sy * (b - d), sz * (c - d)), (sx * (a - d), sy * b, sz * (c - d)), (sx * (a - d), sy * (b - d), sz * c)]
            vs = self.hull(pts, row, tone, jitter, glow, dust)
        else:
            res = bmesh.ops.create_cube(self.bm, size=1.0)
            vs = res['verts']
            bmesh.ops.scale(self.bm, vec=Vector(size), verts=vs)
            self.tag(_sorted_faces(vs), row, tone, jitter, glow, dust)
        if mat is not None:
            self.xform(vs, mat)
        return vs

    def hull(self, pts, row='stone', tone=0.5, jitter=0.12, glow=0, dust=1):
        """点集的凸包（低多边形石块的主力）"""
        vs = [self.bm.verts.new(Vector(p)) for p in pts]
        out = bmesh.ops.convex_hull(self.bm, input=vs, use_existing_faces=False)
        dead = _uniq([g for g in out['geom_interior'] + out['geom_unused'] if isinstance(g, bmesh.types.BMVert)])
        if dead:
            bmesh.ops.delete(self.bm, geom=dead, context='VERTS')
        faces = [g for g in out['geom'] if isinstance(g, bmesh.types.BMFace) and g.is_valid]
        self.tag(faces, row, tone, jitter, glow, dust)
        return _uniq([v for f in faces for v in f.verts])

    def tube(self, pts, radii, sides=6, row='char', tone=0.5, jitter=0.1, tip=True, cap0=True, twist=0.0, glow_ring=None, squash=1.0, cap1=True):
        """沿折线的管子（树干、枝、骨头）。tip = 末端收成一个尖；cap0 = 起点封口。返回 (verts, 每段的面列表)"""
        bm = self.bm
        P = [Vector(p) for p in pts]
        n = len(P)
        # 平行移动的标架：起点取一个和切线不平行的参考方向
        t0 = (P[1] - P[0]).normalized()
        ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
        u = t0.cross(ref).normalized()
        rings = []
        prev_t = t0
        for i in range(n):
            if i == 0:
                t = t0
            elif i == n - 1:
                t = (P[i] - P[i - 1]).normalized()
            else:
                t = ((P[i] - P[i - 1]).normalized() + (P[i + 1] - P[i]).normalized()).normalized()
            # 把 u 投影到新切线的法平面上（平行移动）
            u = (u - t * u.dot(t)).normalized()
            prev_t = t
            w = t.cross(u).normalized()
            if tip and i == n - 1:
                rings.append([bm.verts.new(P[i])])
                continue
            ring = []
            a0 = twist * i
            for k in range(sides):
                a = a0 + 2 * math.pi * k / sides
                ring.append(bm.verts.new(P[i] + (u * math.cos(a) + w * math.sin(a) * squash) * radii[i]))
            rings.append(ring)
        segs = []
        for i in range(n - 1):
            A, B = rings[i], rings[i + 1]
            fs = []
            for k in range(sides):
                if len(B) == 1:
                    fs.append(bm.faces.new((A[k], A[(k + 1) % sides], B[0])))
                else:
                    fs.append(bm.faces.new((A[k], A[(k + 1) % sides], B[(k + 1) % sides], B[k])))
            segs.append(fs)
        faces = [f for s in segs for f in s]
        if cap0:
            faces.append(bm.faces.new(list(reversed(rings[0]))))
            segs[0].append(faces[-1])
        if not tip and cap1 and len(rings[-1]) > 1:
            faces.append(bm.faces.new(rings[-1]))
            segs[-1].append(faces[-1])
        self.tag(faces, row, tone, jitter)
        vs = [v for r in rings for v in r]
        return vs, segs

    def slit(self, face, width=0.3, depth=0.03, row='ember'):
        """余烬裂缝：把一个面向内收一圈、再沿短边压扁成一道窄缝，缝底标成余烬（发亮），缝壁是焦黑。
        比整面标成余烬小得多，俯视时是一道亮线而不是一块橙色的板。"""
        f = face
        prow, ptone = f[self.L_pal] - 1, f[self.L_tone]
        edges = sorted(f.edges, key=lambda e: -e.calc_length())
        th = min(e.calc_length() for e in f.edges) * 0.22
        out = bmesh.ops.inset_individual(self.bm, faces=[f], thickness=th, depth=-depth, use_even_offset=True)
        side = out['faces']
        c = f.calc_center_median()
        n = f.normal.copy()
        axis = (edges[0].verts[1].co - edges[0].verts[0].co).normalized()
        perp = n.cross(axis).normalized()
        for v in f.verts:
            d = v.co - c
            v.co = c + axis * d.dot(axis) * 0.85 + perp * d.dot(perp) * width + n * d.dot(n)
        self.tag([f], row, 0.75, 0.12, glow=1, dust=0)
        self.tag(side, prow if prow >= 0 else 'char', ptone * 0.55, 0.04, dust=0)  # 缝边沿用原来的面，只压暗一点
        return f

    def jitter(self, verts, amt, zlock=None):
        """顶点随机抖动（zlock = 低于这个高度的顶点不动，保住平底）"""
        for v in verts:
            if zlock is not None and v.co.z <= zlock + 1e-6:
                v.co.x += self.r(-amt, amt)
                v.co.y += self.r(-amt, amt)
                continue
            v.co += Vector((self.r(-amt, amt), self.r(-amt, amt), self.r(-amt, amt)))

    # ---------- 收尾 ----------
    def finish(self, dust=0.35, dust_dot=0.78):
        bm = self.bm
        bm.faces.ensure_lookup_table()
        # 没标签的面（倒角 / 凸包新生成的）继承相邻面的标签
        for _ in range(4):
            todo = [f for f in bm.faces if f[self.L_pal] == 0]
            if not todo:
                break
            for f in todo:
                for e in f.edges:
                    for g in e.link_faces:
                        if g is not f and g[self.L_pal]:
                            f[self.L_pal], f[self.L_tone], f[self.L_glow], f[self.L_dust] = g[self.L_pal], g[self.L_tone], g[self.L_glow], g[self.L_dust]
                            break
                    if f[self.L_pal]:
                        break
        for f in bm.faces:
            if f[self.L_pal] == 0:
                f[self.L_pal] = ROW['stone'] + 1
                f[self.L_tone] = 0.5
        # 自己三角化（固定方法，单线程）：交给导出器时 Blender 对多边形的三角化顺序偶尔会变，同一份几何导出的索引就不逐字节一致
        bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='FIXED', ngon_method='EAR_CLIP')
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        # 积灰：朝上的面按概率换成积灰色（灰烬地带的辨识度），余烬面不盖
        if dust > 0:
            for f in bm.faces:
                if f[self.L_dust] and not f[self.L_glow] and f.normal.z > dust_dot and self.rng.random() < dust:
                    f[self.L_pal] = ROW['dust'] + 1
                    f[self.L_tone] = min(0.95, 0.45 + 0.4 * self.rng.random())


def _uniq(seq):
    seen, out = set(), []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _sorted_faces(vs):
    out = []
    for v in vs:
        for f in v.link_faces:
            if f not in out:
                out.append(f)
    return out


def _sorted_edges(vs):
    out = []
    for v in vs:
        for e in v.link_edges:
            if e not in out:
                out.append(e)
    return out


# ---------- 场景 ----------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 32
    sc.cycles.seed = 0
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = int(os.environ.get('CA_THREADS', '8'))
    w = bpy.data.worlds.new('w')
    sc.world = w
    return sc


_ATLAS = {}


def palette_material():
    """共享的调色板材质（每次重置场景后重建；图集 PNG 自己编码，字节固定）"""
    if 'png' not in _ATLAS:
        _ATLAS['png'] = palette.atlas_png()
    path = os.path.join(bpy.app.tempdir or '/tmp', 'ca_palette.png')
    with open(path, 'wb') as fh:
        fh.write(_ATLAS['png'])
    img = bpy.data.images.load(path)
    img.name = 'ca_palette'
    img.pack()
    img.filepath = ''
    img.filepath_raw = ''
    mat = bpy.data.materials.new('ca_palette')
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Metallic'].default_value = 0.0
    tx = nt.nodes.new('ShaderNodeTexImage')
    tx.image = img
    tx.interpolation = 'Closest'
    nt.links.new(tx.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def to_object(kit, name):
    me = bpy.data.meshes.new(name)
    kit.bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    # UV：每个面的所有角取同一个 UV（一面一色，卡通的硬面感）
    uv = me.uv_layers.new(name='UVMap')
    pal = me.attributes['pal'].data
    tone = me.attributes['tone'].data
    for p in me.polygons:
        p.use_smooth = False
        c = palette.uv_of(pal[p.index].value - 1, tone[p.index].value)
        for li in p.loop_indices:
            uv.data[li].uv = c
    me.materials.append(palette_material())
    return ob


def bake_colors(ob, ao_dist=0.6, grad_h=0.8, grad_lo=0.72, wear=0.22, grime=0.18):
    """顶点色 = AO（Cycles CPU 烘焙，带一块地面，底部有接触阴影）× 底部压暗的高度渐变 × 边缘磨损（凸边提亮、凹处压暗）。
    余烬面写 1（不压暗）。返回烘焙秒数。"""
    sc = bpy.context.scene
    me = ob.data
    ao = me.color_attributes.new('ao', 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = ao
    gm = bpy.data.meshes.new('ground')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=12)
    bm.to_mesh(gm)
    bm.free()
    g = bpy.data.objects.new('ground', gm)
    sc.collection.objects.link(g)
    sc.world.light_settings.distance = ao_dist
    for o in sc.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    t0 = time.perf_counter()
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    dt = time.perf_counter() - t0
    bpy.data.objects.remove(g)
    bpy.data.meshes.remove(gm)

    # 凸度（每个顶点相邻边的带符号二面角平均）
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    conv = []
    for v in bm.verts:
        s, n = 0.0, 0
        for e in v.link_edges:
            if len(e.link_faces) == 2:
                s += e.calc_face_angle_signed(0.0)
                n += 1
        conv.append(s / n if n else 0.0)
    bm.free()

    col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    glow = me.attributes['glow'].data
    aod = ao.data
    q = lambda x: round(min(1.0, max(0.0, x)) * 255) / 255
    for p in me.polygons:
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            if glow[p.index].value:
                c = 1.0
            else:
                a = aod[vi].color[0]
                z = me.vertices[vi].co.z
                gr = grad_lo + (1 - grad_lo) * min(1.0, max(0.0, z / grad_h))
                cv = conv[vi]
                we = 1 + wear * min(1.0, max(0.0, cv / 0.9)) - grime * min(1.0, max(0.0, -cv / 0.9))
                c = (0.25 + 0.75 * a) * gr * we
            c = q(c)
            col.data[li].color = (c, c, c, 1.0)
    me.color_attributes.active_color = col
    me.color_attributes.remove(me.color_attributes['ao'])
    me.color_attributes.active_color = me.color_attributes['Col']
    # glTF 导出器的 'ACTIVE' 认的是「渲染用」颜色属性（render_color_index），不是编辑时的 active_color
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    for k in ('pal', 'tone', 'glow', 'dust'):
        if k in me.attributes:
            me.attributes.remove(me.attributes[k])
    return dt


def export_glb(ob, path):
    for o in bpy.context.scene.objects:
        o.select_set(o is ob)
    bpy.context.view_layer.objects.active = ob
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials='EXPORT',
        export_image_format='AUTO',
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
    )
