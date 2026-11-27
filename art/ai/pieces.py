# AI 生成的技能件（ai3d-skills）：把源 GLB 处理成形状批 / 刻式件 / 投射物零件用的小网格（几十到一百多个三角形，没有贴图），
# 写进 js/assets/skill-pieces.js（经典脚本，同步加载，js/vfx.js 和 js/world.js 建几何体时读 window.CA_SKILL_PIECES）。
# 和布景件（art/ai/importer.py）共用导入 / 去碎块 / 减面；不同的是：
#   - 每个输出件有自己的「坐标约定」（被顶替的旧几何体是怎么摆的：底在 y = 0 尖朝上、中心在原点、长轴沿 +z ……）；
#   - 减面狠得多（按件的预算），一面一色：颜色从源模型的反照率贴图里按面取（低模面上取 4 个点，BVH 找高模上最近的点，插值 UV 取色）；
#   - 按输出的用法烘成三种之一：tone（形状批的色阶：暗边 0 / 主色 0.26–0.74 带明暗 / 亮面 1），shade（刻式件：每面一个明暗倍数，光照仍由着色器算），
#     color（投射物零件：每面的线性 RGB，游戏端再照旧烘一遍朝向明暗）。
# 输入：art/ai/pieces.json 列出要处理的来源记录（assets/ai/skill-<件>/provenance.json，processing.outputs 是输出件的参数）；源 GLB 在 CA_AI_INBOX/<name>/model.glb（不进仓库）。
# 直接跑：blender -b --factory-startup --python-exit-code 1 --python art/ai/pieces.py -- [--out js/assets/skill-pieces.js] [--stats 文件]
# 确定性：不用随机数；减面、BVH、取色都是固定算法，同一个 Blender 版本重复构建逐字节相同。
import hashlib
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.dont_write_bytecode = True

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Euler, Matrix, Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

from ai import importer  # noqa: E402

ROOT = importer.ROOT


def argv():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return {a[i][2:]: a[i + 1] for i in range(0, len(a) - 1, 2) if a[i].startswith('--')}


def _pca_align(bm):
    """主轴（顶点分布最长的方向）转到 +Z，尖的那头朝上（两头各取 12% 的顶点，横向散得小的那头算尖）"""
    P = np.array([tuple(v.co) for v in bm.verts], dtype=np.float64)
    c = P.mean(axis=0)
    ax = np.linalg.svd(P - c, full_matrices=False)[2][0]
    q = Vector(ax.tolist()).rotation_difference(Vector((0, 0, 1)))
    bmesh.ops.transform(bm, matrix=q.to_matrix().to_4x4(), verts=list(bm.verts))
    P = np.array([tuple(v.co) for v in bm.verts], dtype=np.float64)
    z0, z1 = P[:, 2].min(), P[:, 2].max()
    def spread(sel):
        Q = P[sel][:, :2]
        return float(np.sqrt(((Q - Q.mean(axis=0)) ** 2).sum(axis=1).mean())) if len(Q) else 0.0
    top, bot = spread(P[:, 2] > z1 - 0.12 * (z1 - z0)), spread(P[:, 2] < z0 + 0.12 * (z1 - z0))
    if top > bot:
        bmesh.ops.transform(bm, matrix=Matrix.Rotation(math.pi, 4, 'X'), verts=list(bm.verts))


def _to_three(bm):
    """Blender（Z 朝上）→ three（Y 朝上）：(x, y, z) → (x, z, -y)"""
    bmesh.ops.transform(bm, matrix=Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1))), verts=list(bm.verts))


def _fit(bm, fit):
    """按输出件的坐标约定摆放（three 坐标）：
    base：底在 y = 0、高 1（h 可改），水平包围盒中心在 y 轴上，离 y 轴最远的点在半径 r 处（xz 一起缩放）；
    center：包围盒中心在原点，长轴（axis：y / z）半长 half_long，横向离长轴最远的点在 r 处；
    span：长轴（axis）从 lo 到 hi，横向最远 r。"""
    vs = list(bm.verts)
    P = np.array([tuple(v.co) for v in vs], dtype=np.float64)
    lo, hi = P.min(axis=0), P.max(axis=0)
    mode = fit['mode']
    ai = {'x': 0, 'y': 1, 'z': 2}[fit.get('axis', 'y')]
    oth = [i for i in range(3) if i != ai]
    ctr = (lo + hi) / 2
    Q = P - ctr
    rad = float(np.sqrt((Q[:, oth] ** 2).sum(axis=1)).max())
    L = hi[ai] - lo[ai]
    if mode == 'base':
        a0, a1 = -fit.get('sink', 0.0), fit.get('h', 1.0)  # sink：底下埋进地里的那一截（尖底的冰晶），按总高的比例
    elif mode == 'center':
        a0, a1 = -fit['half_long'], fit['half_long']
    else:
        a0, a1 = fit['lo'], fit['hi']
    sa = (a1 - a0) / L
    sr = fit['r'] / rad
    S = np.ones(3)
    S[ai] = sa
    S[oth] = sr
    out = np.empty_like(P)
    for i in range(3):
        if i == ai:
            out[:, i] = a0 + (P[:, i] - lo[i]) * sa
        else:
            out[:, i] = (P[:, i] - ctr[i]) * sr
    for v, p in zip(vs, out):
        v.co = Vector(p.tolist())
    return dict(scale_long=round(float(sa), 5), scale_r=round(float(sr), 5))


def _cut(bm, spec):
    """去掉一段（例如电桩源模型顶上悬空的球：刻式件另画发光的球）：z_above（Blender 坐标、摆正后、占总高的比例）以上整块岛删掉"""
    za = spec.get('drop_islands_above')
    if za is None:
        return 0
    zs = [v.co.z for v in bm.verts]
    z0, z1 = min(zs), max(zs)
    cut = z0 + za * (z1 - z0)
    drop = []
    for isl in importer._islands(bm):
        vs = {v for f in isl for v in f.verts}
        if min(v.co.z for v in vs) > cut:
            drop.extend(isl)
    if drop:
        bmesh.ops.delete(bm, geom=drop, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
    return len(drop)


def _face_colors(low, hi_bm, hi_uv, px):
    """低模每个面：面内 4 个点（重心 + 三个偏向角的点）→ 高模上最近的点 → 插值 UV → 反照率（线性，平均）"""
    bvh = BVHTree.FromBMesh(hi_bm)
    hi_bm.faces.ensure_lookup_table()
    W4 = [(1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)]
    out = []
    for tri in low:
        acc = np.zeros(3)
        for w in W4:
            p = tri[0] * w[0] + tri[1] * w[1] + tri[2] * w[2]
            loc, _n, fi, _d = bvh.find_nearest(Vector(p.tolist()))
            f = hi_bm.faces[fi]
            a, b, c = [l.vert.co for l in f.loops]
            uva, uvb, uvc = hi_uv[fi]
            # 重心坐标
            v0, v1, v2 = b - a, c - a, loc - a
            d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
            den = d00 * d11 - d01 * d01 or 1e-12
            bv = (d11 * d20 - d01 * d21) / den
            bw = (d00 * d21 - d01 * d20) / den
            bu = 1 - bv - bw
            uv = uva * bu + uvb * bv + uvc * bw
            acc += importer.s2l(importer._sample(px, uv[None, :])[0].astype(np.float64))
        out.append(acc / len(W4))
    return np.array(out)


def _normals(low):
    n = np.cross(low[:, 1] - low[:, 0], low[:, 2] - low[:, 0])
    return n / np.maximum(1e-12, np.linalg.norm(n, axis=1))[:, None]


def _areas(low):
    return 0.5 * np.linalg.norm(np.cross(low[:, 1] - low[:, 0], low[:, 2] - low[:, 0]), axis=1)


def _bake_tone(low, cols, o):
    """形状批的色阶：v = 反照率亮度（按分位数拉开）和朝光程度的混合；面积占比最高的 hot 一档 → 1（亮面，着色器里按实例的亮芯量往白混），
    最低的 dark 一档 → 0（暗边），其余 0.26–0.74（着色器里 × (1 + (t − 0.5) × 1.6) 的明暗）"""
    Y = cols @ np.array([0.2126, 0.7152, 0.0722])
    a, b = np.percentile(Y, 5), np.percentile(Y, 95)
    yn = np.clip((Y - a) / max(1e-6, b - a), 0, 1)
    ld = np.array(o.get('light', [0.6, 0.55, 0.35]), dtype=np.float64)
    ld /= np.linalg.norm(ld)
    lam = np.clip(_normals(low) @ ld, -1, 1) * 0.5 + 0.5
    wl = o.get('light_w', 0.6)
    v = wl * lam + (1 - wl) * yn
    ar = _areas(low)
    order = np.argsort(-v, kind='stable')
    cum = np.cumsum(ar[order]) / ar.sum()
    t = np.empty(len(v))
    hot, dark = o.get('hot', 0.18), o.get('dark', 0.2)
    rng = (v.min(), v.max())
    for rank, i in enumerate(order):
        if cum[rank] <= hot:
            t[i] = 1.0
        elif cum[rank] > 1 - dark:
            t[i] = 0.0
        else:
            t[i] = 0.26 + 0.48 * (v[i] - rng[0]) / max(1e-6, rng[1] - rng[0])
    return np.round(t, 3)


def _bake_shade(cols, o):
    Y = cols @ np.array([0.2126, 0.7152, 0.0722])
    a, b = np.percentile(Y, 5), np.percentile(Y, 95)
    yn = np.clip((Y - a) / max(1e-6, b - a), 0, 1)
    s0, s1 = o.get('shade', [0.8, 1.2])
    return np.round(s0 + (s1 - s0) * yn, 3)


def _bake_color(cols, o):
    """线性 RGB；grade：tint（每通道倍数）、gain、sat（围绕亮度）"""
    g = o.get('grade', {})
    c = cols * np.array(g.get('tint', [1, 1, 1]))
    Y = (c @ np.array([0.2126, 0.7152, 0.0722]))[:, None]
    c = Y + (c - Y) * g.get('sat', 1.0)
    return np.round(np.clip(c * g.get('gain', 1.0), 0, 1), 4)


def process(prov_rel, out, stats):
    P = importer.load_prov(dict(prov=prov_rel))
    spec = P['processing']
    src = importer.source_path(dict(prov=prov_rel))
    with open(src, 'rb') as fh:
        sha = hashlib.sha256(fh.read()).hexdigest()
    if sha != P['source']['sha256']:
        raise RuntimeError(prov_rel + '：源 GLB 的 sha256 和来源记录不一样')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    obs = importer._import(src)
    bm = bmesh.new()
    mats = []
    for o in obs:
        me = o.data
        tmp = bmesh.new()
        tmp.from_mesh(me)
        tmp.transform(o.matrix_world)
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
        mats.extend(m for m in me.materials if m not in mats)
    px, fac = importer._albedo_of(mats[0])
    px = px * np.array(fac, dtype=np.float32)
    bmesh.ops.triangulate(bm, faces=list(bm.faces), quad_method='FIXED', ngon_method='EAR_CLIP')
    log = {}
    importer._clean(bm, spec, log)
    log['cut_faces'] = _cut(bm, spec)
    rx, ry, rz = [math.radians(a) for a in spec.get('rot_deg', [0, 0, 0])]
    bmesh.ops.transform(bm, matrix=Euler((rx, ry, rz), 'XYZ').to_matrix().to_4x4(), verts=list(bm.verts))
    if spec.get('pca'):
        _pca_align(bm)
    _to_three(bm)
    for o in obs:
        bpy.data.objects.remove(o)
    base = bm  # 整理后的高模（three 坐标、还没按输出件缩放）
    for o in spec['outputs']:
        hb = base.copy()
        if o.get('rot_deg'):  # 输出件自己的转向（three 坐标，XYZ 欧拉，度）：例如长轴从 +y 转到 +z
            rx, ry, rz = [math.radians(x) for x in o['rot_deg']]
            bmesh.ops.transform(hb, matrix=Euler((rx, ry, rz), 'XYZ').to_matrix().to_4x4(), verts=list(hb.verts))
        fitlog = _fit(hb, o['fit'])
        hb.faces.ensure_lookup_table()
        uvl = hb.loops.layers.uv.active
        hi_uv = []
        for f in hb.faces:
            t = [np.array(tuple(l[uvl].uv), dtype=np.float64) for l in f.loops]
            for u in t:
                u[1] = 1.0 - u[1]  # Blender 的 v 朝上 → glTF 的 v 朝下（和 _albedo_of 的行序一致）
            hi_uv.append(t)
        me = bpy.data.meshes.new('pc_src')
        dec_target, hull_deg = o['tris'], None
        if o.get('hull'):
            # 凸包再按角度合并棱面：冰晶 / 冰棱这类本来就是凸的件，凸包的面是平的大棱面（硬棱、利落），直接从 2 万面的软网格减面会成一团疙瘩。
            # 合并角度二分到三角形数刚好不超预算（固定 24 轮，确定性）；取色仍按低模的面去整理后的高模上找最近点
            # clip（埋进地里的件）：只取 y ≥ 0 的顶点和穿过 y = 0 的边的交点再取凸包，地下那截不留（斜插时不会从另一边冒出来），面全用在露出来的部分
            pts = [tuple(v.co) for v in hb.verts if not o['fit'].get('clip') or v.co.y >= 0]
            if o['fit'].get('clip'):
                for e in hb.edges:
                    a, b = e.verts[0].co, e.verts[1].co
                    if (a.y < 0) != (b.y < 0):
                        t = a.y / (a.y - b.y)
                        pts.append((a.x + (b.x - a.x) * t, 0.0, a.z + (b.z - a.z) * t))

            def hull_at(ang):
                cb = bmesh.new()
                for q in pts:
                    cb.verts.new(q)
                res = bmesh.ops.convex_hull(cb, input=list(cb.verts), use_existing_faces=False)
                keep = set(g for g in res['geom'] if isinstance(g, bmesh.types.BMFace))
                bmesh.ops.delete(cb, geom=[f for f in cb.faces if f not in keep], context='FACES')
                wire = [e for e in cb.edges if not e.link_faces]  # 原网格留下的线边：不删的话合并 / 减面都动不了
                if wire:
                    bmesh.ops.delete(cb, geom=wire, context='EDGES')
                loose = [v for v in cb.verts if not v.link_faces]
                if loose:
                    bmesh.ops.delete(cb, geom=loose, context='VERTS')
                bmesh.ops.dissolve_limit(cb, angle_limit=ang, verts=list(cb.verts), edges=list(cb.edges))
                bmesh.ops.triangulate(cb, faces=list(cb.faces), quad_method='BEAUTY', ngon_method='BEAUTY')
                return cb
            a0, a1 = math.radians(0.5), math.radians(60)
            for _ in range(24):
                am = (a0 + a1) / 2
                cb = hull_at(am)
                n = len(cb.faces)
                cb.free()
                if n > o['tris']:
                    a0 = am
                else:
                    a1 = am
            cb = hull_at(a1)
            print('CA_PIECE_HULL', o['key'], len(cb.faces), sum(len(f.verts) - 2 for f in cb.faces), round(math.degrees(a1), 3), flush=True)
            cb.to_mesh(me)
            cb.free()
            dec_target = 10 ** 6  # 已经在预算内：下面的减面不再动它
            hull_deg = round(math.degrees(a1), 3)
        else:
            hb.to_mesh(me)
        dlog = {}
        low_me = importer._decimate(me, dec_target, dlog, 'decimate')
        low = np.array([[tuple(low_me.vertices[i].co) for i in p.vertices] for p in low_me.polygons if len(p.vertices) == 3], dtype=np.float64)
        ar = _areas(low)
        low = low[ar > 1e-9]
        cols = _face_colors(low, hb, hi_uv, px)
        rec = dict(p=[round(float(x), 4) for x in low.reshape(-1)])
        if o['bake'] == 'tone':
            rec['t'] = [float(x) for x in _bake_tone(low, cols, o)]
        elif o['bake'] == 'shade':
            rec['s'] = [float(x) for x in _bake_shade(cols, o)]
        else:
            rec['c'] = [float(x) for x in _bake_color(cols, o).reshape(-1)]
        rec['src'] = P['id']
        if o.get('split'):
            # 一件拆成两个（形状批里一个实例只有一种颜色）：面的重心 y 低于 at 的给 below 那个 key（雷桩的底座），其余留给 key（晶柱）
            sp = o['split']
            cy = low[:, :, 1].mean(axis=1)
            sel = cy < sp['at']
            for key, m in ((sp['below'], sel), (o['key'], ~sel)):
                r2 = dict(src=P['id'], p=[round(float(x), 4) for x in low[m].reshape(-1)])
                for f in ('t', 's'):
                    if f in rec:
                        r2[f] = [x for x, k in zip(rec[f], m) if k]
                if 'c' in rec:
                    r2['c'] = [round(float(x), 4) for x in np.array(rec['c']).reshape(-1, 3)[m].reshape(-1)]
                out[key] = r2
                print('CA_PIECE_SPLIT', key, int(m.sum()), flush=True)
        else:
            out[o['key']] = rec
        Pf = low.reshape(-1, 3)
        stats[o['key']] = dict(src=P['source']['name'], tris=len(low), target=o['tris'], bake=o['bake'], fit=o['fit'], scale=fitlog, hull_deg=hull_deg,
                               lo=[round(float(x), 3) for x in Pf.min(axis=0)], hi=[round(float(x), 3) for x in Pf.max(axis=0)], clean=log)
        print('CA_PIECE ' + json.dumps(dict(key=o['key'], **stats[o['key']]), ensure_ascii=False), flush=True)
        bpy.data.meshes.remove(low_me)
        bpy.data.meshes.remove(me)
        hb.free()
    bm.free()


def main():
    a = argv()
    with open(os.path.join(ROOT, 'art', 'ai', 'pieces.json'), encoding='utf-8') as fh:
        lst = json.load(fh)
    outp = os.path.join(ROOT, a.get('out', 'js/assets/skill-pieces.js'))
    out, stats = {}, {}
    missing = [p for p in lst['provenance'] if importer.source_state(dict(prov=p)) != 'ok']
    if missing:
        # 源文件不在这台机器上：保留已提交的 skill-pieces.js（和布景件一样）
        print('CA_PIECE 源文件不在（' + ', '.join(missing) + '），保留已提交的 ' + os.path.relpath(outp, ROOT), flush=True)
        return
    for p in lst['provenance']:
        process(p, out, stats)
    keys = sorted(out)
    body = ',\n'.join('  ' + json.dumps(k) + ': ' + json.dumps(out[k], separators=(',', ':')) for k in keys)
    txt = ('// 由 art/ai/pieces.py 生成（ai3d-skills），不要手改。AI 生成的技能件：p = 三角形顶点（three 坐标，每面 3 个点），\n'
           '// t = 形状批色阶（每面）/ s = 刻式件明暗倍数（每面）/ c = 投射物零件的线性 RGB（每面）。来源记录见 src 对应的 assets/ai/skill-*/provenance.json\n'
           'window.CA_SKILL_PIECES = {\n' + body + '\n};\n')
    with open(outp, 'w', encoding='utf-8') as fh:
        fh.write(txt)
    if a.get('stats'):
        with open(a['stats'], 'w', encoding='utf-8') as fh:
            json.dump(stats, fh, ensure_ascii=False, indent=1)
    print('CA_PIECE 写出 %s（%d 件，%d 字节）' % (os.path.relpath(outp, ROOT), len(keys), len(txt.encode('utf-8'))), flush=True)


if __name__ == '__main__':
    main()
