# 无头 Blender 入口：按 art/catalog.py 逐件生成 → 烘焙顶点色 → 导出 GLB。平时由 npm run build:art（tools/build-art.mjs）调用。
# 直接跑：blender -b --factory-startup --python-exit-code 1 --python art/build.py -- --out assets/ca [--only id,id] [--stats 文件]
#        看板：... --python art/build.py -- --lineup 输出.png [--res 1800x900] [--samples 24]
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

from ca import core, gen  # noqa: E402
from catalog import CATALOG, LINEUP_SEEDS  # noqa: E402


def argv():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    # 每个开关都带一个值：--out 目录 --only id,id ...
    return {a[i][2:]: a[i + 1] for i in range(0, len(a) - 1, 2) if a[i].startswith('--')}


def make(item, seed=None, name=None):
    seed = item['seed'] if seed is None else seed
    name = name or item['id'].replace('/', '_')
    k = core.Kit(seed, name)
    getattr(gen, item['gen'])(k, **item.get('args', {}))
    if item.get('fit'):
        k.fit(**item['fit'])  # 清单里的 fit：包围盒对齐被顶替的旧件（r / top / bottom）
    k.finish(cue_args=item.get('cues'), **item.get('finish', {}))  # cues：材质线索参数（val / second / lichen，缺省见 docs/art-style.md）；finish：收尾参数（dust / dust_row）
    tris = sum(len(f.verts) - 2 for f in k.bm.faces)
    ob = core.to_object(k, name)
    k.bm.free()
    if DRY:
        return ob, tris, 0.0
    b = item.get('bake', {})
    dt = core.bake_colors(ob, ao_dist=b.get('ao', 0.6), grad_h=b.get('grad', 0.8), wear=b.get('wear', 0.34), grime=b.get('grime', 0.3), gtint=b.get('gtint', 1.0))
    return ob, tris, dt


def build(o):
    out = o.get('out', 'assets/ca')
    only = set(o['only'].split(',')) if o.get('only') else None
    stats = []
    for item in CATALOG:
        if only and item['id'] not in only:
            continue
        core.reset_scene()
        t0 = time.perf_counter()
        ob, tris, dt = make(item)
        path = os.path.join(out, item['zone'], item['id'].split('/', 1)[1] + '.glb')
        if not DRY:
            core.export_glb(ob, path)
        st = dict(id=item['id'], file=os.path.relpath(path, out), tris=tris, bake_s=round(dt, 3), total_s=round(time.perf_counter() - t0, 3),
                  gen=item['gen'], seed=item['seed'], args=item.get('args', {}), bake=item.get('bake', {}), cat=item['cat'], zone=item['zone'],
                  ship=item['ship'], replaces=item.get('replaces'), blender=bpy.app.version_string)
        stats.append(st)
        print('CA_ASSET ' + json.dumps(st, ensure_ascii=False), flush=True)
    if o.get('stats'):
        with open(o['stats'], 'w') as fh:
            json.dump(stats, fh, ensure_ascii=False, indent=1)


def lineup(o):
    """看板：每行一个生成器，每列一个种子（第一列是清单里的那一件），Cycles CPU 低采样渲染成一张图"""
    core.reset_scene()
    sc = bpy.context.scene
    gens = []
    for item in CATALOG:
        if item['gen'] not in [g['gen'] for g in gens]:
            gens.append(item)
    if o.get('gens'):
        keep = o['gens'].split(',')
        gens = [g for g in gens if g['gen'] in keep]
    seeds = [None] + LINEUP_SEEDS
    obs = []
    zrow = 0.0
    for gi, item in enumerate(gens):
        row = []
        for si, sd in enumerate(seeds):
            ob, tris, _ = make(item, seed=sd, name='%s_%d' % (item['gen'], si))
            row.append((ob, tris))
        # 按这一行最大的件定间距；整行缩放到差不多高，方便同框看
        dims = [max(ob.dimensions.x, ob.dimensions.y, ob.dimensions.z * 0.8) for ob, _ in row]
        s = 2.5 / max(dims)
        zrow += max(0.0, max(ob.dimensions.z for ob, _ in row) * s - 1.2) * 0.75  # 高的件往下多让一点，免得挡住上一行
        x = 0.0
        for (ob, tris), d in zip(row, dims):
            ob.scale = (s, s, s)
            ob.location = (x, -zrow, 0)
            ob.rotation_euler = (0, 0, math.pi + 0.5)  # 件的正面（+Y）大致朝向相机
            x += 3.4
            obs.append(ob)
        zrow += 3.6
    # 地面、灯、相机：45° 俯视（接近游戏视角），顶光 + 暖色补光
    import bmesh
    gm = bpy.data.meshes.new('floor')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
    bm.to_mesh(gm)
    bm.free()
    fl = bpy.data.objects.new('floor', gm)
    sc.collection.objects.link(fl)
    fm = bpy.data.materials.new('floor')
    fb = next(n for n in fm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    fb.inputs['Base Color'].default_value = (0.09, 0.08, 0.075, 1)
    gm.materials.append(fm)
    for ob in obs:
        # 看板里让顶点色参与着色（游戏端是在烘焙时乘进去的）
        m = ob.data.materials[0]
        nt = m.node_tree
        bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        tx = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
        ca = nt.nodes.new('ShaderNodeVertexColor')
        ca.layer_name = 'Col'
        mul = nt.nodes.new('ShaderNodeMix')
        mul.data_type = 'RGBA'
        mul.blend_type = 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1.0
        nt.links.new(tx.outputs['Color'], mul.inputs[6])
        nt.links.new(ca.outputs['Color'], mul.inputs[7])
        nt.links.new(mul.outputs[2], bsdf.inputs['Base Color'])
    cx = 3.4 * (len(seeds) - 1) / 2
    cy = -zrow / 2 + 2.2
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.2
    sun.angle = 0.2
    so = bpy.data.objects.new('sun', sun)
    so.rotation_euler = (math.radians(40), math.radians(-15), math.radians(-30))
    sc.collection.objects.link(so)
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.32, 0.3, 0.33, 1)
    bg.inputs['Strength'].default_value = 0.6
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.sensor_fit = 'VERTICAL'
    cam.ortho_scale = zrow * 0.8 + 2.5
    co = bpy.data.objects.new('cam', cam)
    co.location = (cx, cy - 30 * math.sin(math.radians(40)), 30 * math.cos(math.radians(40)))
    co.rotation_euler = (math.radians(40), 0, 0)
    sc.collection.objects.link(co)
    sc.camera = co
    w = int((o.get('res') or '1500').split('x')[0])
    aspect = (zrow * 0.8 + 2.5) / (3.4 * len(seeds) + 0.6)
    sc.render.resolution_x, sc.render.resolution_y = w, int(w * aspect) // 2 * 2
    sc.render.resolution_percentage = 100
    sc.cycles.samples = int(o.get('samples', 24))
    sc.cycles.use_denoising = False
    sc.view_settings.view_transform = 'Standard'
    sc.render.filepath = o['lineup']
    sc.render.image_settings.file_format = 'PNG'
    t0 = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    print('CA_LINEUP %s %.1fs gens=%s' % (o['lineup'], time.perf_counter() - t0, ','.join(g['gen'] for g in gens)), flush=True)


DRY = False

if __name__ == '__main__':
    o = argv()
    DRY = o.get('dry') == '1'  # 只搭形、数三角形，不烘焙不导出（查生成器报错用，很轻）
    if o.get('list'):
        print('CA_IDS ' + json.dumps([it['id'] for it in CATALOG]), flush=True)
    elif o.get('lineup'):
        lineup(o)
    else:
        build(o)
