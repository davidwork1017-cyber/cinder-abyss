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
    def __init__(self, seed, name, remap=None):
        self.seed = seed
        self.name = name
        self.remap = dict(remap or {})  # 调色板行换名（清单里的 remap）：同一个生成器换一套材质行，比如烬渊把石 / 板岩换成熔渣、星辉换成余烬
        self.rng = random.Random(seed)
        self.bm = bmesh.new()
        self.L_pal = self.bm.faces.layers.int.new('pal')  # 调色板行 + 1（0 = 还没标，收尾时从相邻面继承）
        self.L_tone = self.bm.faces.layers.float.new('tone')  # 色带上的位置 0–1
        self.L_glow = self.bm.faces.layers.float.new('glow')  # 0–1 = 余烬面：自发光强度（写进 COLOR_0 的 α：α = 1 - glow），也不压 AO、不加磨损
        self.L_dust = self.bm.faces.layers.int.new('dust')  # 1 = 朝上的面可以盖积灰
        self.L_bone = None  # 首领：顶点属于哪根骨骼（骨骼序号 + 1，0 = 没标），第一次 bind 时才建，布景件没有这一层

    # ---------- 首领：零件绑到骨骼 ----------
    def bind(self, verts, bone_index, soft=False):
        """soft = True：这些顶点在软接缝的范围里按距离和相邻骨骼渐变（见 art/ca/rig.py 的 skin），否则刚性跟这根骨骼"""
        if self.L_bone is None:
            self.L_bone = self.bm.verts.layers.int.new('bone')
        for v in verts:
            if v.is_valid:
                v[self.L_bone] = bone_index + 1 + (1000 if soft else 0)
        return verts

    # ---------- 随机 ----------
    def r(self, a=0.0, b=1.0):
        return a + (b - a) * self.rng.random()

    def pick(self, seq):
        return seq[int(self.rng.random() * len(seq)) % len(seq)]

    # ---------- 标签 ----------
    def tag(self, faces, row, tone=0.5, jitter=0.1, glow=0, dust=1):
        rid = ROW[self.remap.get(row, row)] if isinstance(row, str) else row
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

    def slit(self, face, width=0.3, depth=0.03, row='ember', glow=1):
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
        self.tag([f], row, 0.75, 0.12, glow=glow, dust=0)
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

    # ---------- 材质线索（docs/art-style.md「材质线索」一节） ----------
    def material_cues(self, val=0.36, second=True, lichen=0.26):
        """按低频噪声给面加三样东西，让同一材质近看不是一整片：
        1. 明暗斑块：色带位置按噪声上下偏 ±val/2（一面一色之外，大块的深浅起伏）；
        2. 第二色调：另一层噪声高过阈值的斑块换成这一材质的第二色（石 → 灰白石、焦木 → 焦褐木、铁 → 锈、骨 → 污垢）；
        3. 灰苔：石头的侧面（不朝天也不朝地）偶尔一小片灰绿。
        斑块大小跟着件的尺寸走（整件大约三块），余烬面不动。"""
        bm = self.bm
        if not bm.faces:
            return
        xs = [v.co.x for v in bm.verts]
        ys = [v.co.y for v in bm.verts]
        zs = [v.co.z for v in bm.verts]
        D = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), 0.05)
        fq = 3.0 / D
        sd = self.seed
        names = [n for n, _ in palette.ROWS]
        for f in bm.faces:
            if f[self.L_glow] > 0:
                continue
            c = f.calc_center_median()
            row = names[f[self.L_pal] - 1]
            n1 = vnoise(c.x * fq, c.y * fq, c.z * fq, sd)
            f[self.L_tone] = min(0.98, max(0.02, f[self.L_tone] + (n1 - 0.5) * val))
            if second and row in SECOND:
                n2 = vnoise(c.x * fq * 1.7 + 17.3, c.y * fq * 1.7 - 4.1, c.z * fq * 1.7 + 9.7, sd + 1)
                to, th = SECOND[row]
                to = self.remap.get(to, to)
                if n2 > th:
                    f[self.L_pal] = ROW[to] + 1
                    row = to
            if lichen > 0 and row in LICHEN_ON and 0.2 < f.normal.z < 0.8:
                n3 = vnoise(c.x * fq * 2.3 + 41.0, c.y * fq * 2.3 + 3.0, c.z * fq * 2.3 - 11.0, sd + 2)
                if n3 > 1 - lichen * 0.5:
                    f[self.L_pal] = ROW[self.remap.get('lichen', 'lichen')] + 1
                    f[self.L_tone] = min(0.9, max(0.2, f[self.L_tone]))

    # ---------- 收尾 ----------
    def fit(self, r=None, top=None, bottom=None):
        """把包围盒拉到给定尺寸（顶替旧模型时 scale 1 的 r / 顶 / 底和旧件一致，摆放表的判断就和原来一样）：
        r = 水平方向离原点最远的轴向距离（游戏端 geoInfo 的 r：max(|x|, |z|)），按比例缩放水平两轴；top / bottom = 最高 / 最低点的 z，线性拉伸竖直方向"""
        vs = list(self.bm.verts)
        if r is not None:
            rc = max(max(abs(v.co.x), abs(v.co.y)) for v in vs)
            for v in vs:
                v.co.x *= r / rc
                v.co.y *= r / rc
        if top is not None or bottom is not None:
            z0, z1 = min(v.co.z for v in vs), max(v.co.z for v in vs)
            b = z0 if bottom is None else bottom
            t = z1 if top is None else top
            for v in vs:
                v.co.z = b + (v.co.z - z0) * (t - b) / (z1 - z0)

    def finish(self, dust=0.35, dust_dot=0.78, cues=True, cue_args=None, dust_row='dust'):
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
                f[self.L_pal] = ROW[self.remap.get('stone', 'stone')] + 1
                f[self.L_tone] = 0.5
        # 自己三角化（固定方法，单线程）：交给导出器时 Blender 对多边形的三角化顺序偶尔会变，同一份几何导出的索引就不逐字节一致
        bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='FIXED', ngon_method='EAR_CLIP')
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        if cues:
            self.material_cues(**(cue_args or {}))
        # 积灰：朝上的面按概率换成积灰色（灰烬地带的辨识度；别的区用 dust_row 换成本区的覆盖色，比如裂谷的苔尘），余烬面不盖
        if dust > 0:
            for f in bm.faces:
                if f[self.L_dust] and f[self.L_glow] <= 0 and f.normal.z > dust_dot and self.rng.random() < dust:
                    f[self.L_pal] = ROW[dust_row] + 1
                    f[self.L_tone] = min(0.95, 0.45 + 0.4 * self.rng.random())


# 每种材质的第二色调（低频斑块里换成它）和出现的阈值：阈值越高斑块越少
SECOND = {'basalt': ('stone', 0.74), 'stone': ('pale', 0.68), 'char': ('wood', 0.7), 'iron': ('rust', 0.56), 'bone': ('grime', 0.6), 'slag': ('stone', 0.72), 'slate': ('pale', 0.82)}
LICHEN_ON = ('stone', 'pale', 'slag', 'slate')


def vnoise(x, y, z, seed):
    """三维值噪声（0–1），整数哈希 + 平滑插值：同样的输入永远同样的输出"""
    import math as _m
    xi, yi, zi = _m.floor(x), _m.floor(y), _m.floor(z)
    fx, fy, fz = x - xi, y - yi, z - zi
    sx, sy, sz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)

    def h(i, j, k):
        n = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791) ^ (seed * 2654435761)
        n = (n ^ (n >> 13)) * 1274126177
        return ((n ^ (n >> 16)) & 0xFFFFFFFF) / 4294967295.0

    def lerp(a, b, t):
        return a + (b - a) * t
    c = [[[h(xi + a, yi + b, zi + cc) for cc in (0, 1)] for b in (0, 1)] for a in (0, 1)]
    return lerp(lerp(lerp(c[0][0][0], c[0][0][1], sz), lerp(c[0][1][0], c[0][1][1], sz), sy),
                lerp(lerp(c[1][0][0], c[1][0][1], sz), lerp(c[1][1][0], c[1][1][1], sz), sy), sx)


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


def bake_colors(ob, ao_dist=0.6, grad_h=0.8, grad_lo=0.72, wear=0.34, grime=0.3, gtint=1.0, gain=1.0):
    """顶点色（COLOR_0，线性）= AO（Cycles CPU 烘焙，带一块地面，底部有接触阴影）× 底部压暗、偏暖的烟熏渐变 × 边缘磨损（凸边提亮）
    × 缝里的污垢（凹处、AO 暗处压暗并偏暖褐，gtint 调污垢色的浓淡）× gain（整件的明暗，按游戏里的灰度校准用，缺省 1）。余烬面按 glow 往 1 拉（不压暗），α = 1 - glow（游戏里当自发光）。
    返回烘焙秒数。"""
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
    cl = lambda x: min(1.0, max(0.0, x))
    GRIME = (0.8, 0.68, 0.54)  # 污垢的色偏（乘在缝里）
    SOOT = (1.0, 0.95, 0.9)  # 烟熏渐变的色偏（底部偏暖）
    for p in me.polygons:
        gl = glow[p.index].value
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            a = aod[vi].color[0]
            z = me.vertices[vi].co.z
            t = cl(z / grad_h)
            gr = grad_lo + (1 - grad_lo) * t
            cv = conv[vi]
            we = 1 + wear * cl(cv / 0.9) - grime * cl(-cv / 0.9)
            k = (0.25 + 0.75 * a) * gr * we
            gm = cl((cl(-cv / 0.9) * 0.7 + cl((0.62 - a) / 0.62) * 0.6) * gtint)
            rgb = []
            for ch in range(3):
                v = k * (1 + (GRIME[ch] - 1) * gm) * (1 + (SOOT[ch] - 1) * (1 - t)) * gain
                rgb.append(q(v + (1 - v) * gl))
            col.data[li].color = (rgb[0], rgb[1], rgb[2], q(1 - gl))
    me.color_attributes.active_color = col
    me.color_attributes.remove(me.color_attributes['ao'])
    me.color_attributes.active_color = me.color_attributes['Col']
    # glTF 导出器的 'ACTIVE' 认的是「渲染用」颜色属性（render_color_index），不是编辑时的 active_color
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    for k in ('pal', 'tone', 'glow', 'dust', 'bone'):
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
