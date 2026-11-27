# AI 生成的首领外观（ai3d-bosses：雷霆监察者 / 衔星巨兽；熔渣巨像用 golem_fit.py）第一步：源网格对到这只首领的骨架上（纯 numpy，不依赖 Blender）。
# 骨架（名字、父骨骼、骨骼顺序）取上线的首领包 js/assets/boss-<kind>.js（和 art/rig.json 的 boss.kinds 一致，父骨骼在前）；
# 枢轴按候选参数写死（spec['fit']['pivots']，游戏坐标、米，看源网格的切片量的），没写的取上线骨架的静止位置。
# fit：源坐标 → 游戏坐标的缩放（x / z 可以另乘 xz_scale）+ 平移：脚底贴地、x 以包围盒为中心、z 按参数（缺省包围盒中心）；可选 yaw（绕竖轴转，度）。
import json
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def template(kind):
    """上线首领包里的骨架：[(名字, 父骨骼或 None, 枢轴 (x, y, z))]，父骨骼在前"""
    with open(os.path.join(ROOT, 'js', 'assets', 'boss-' + kind + '.js'), encoding='utf-8') as fh:
        src = fh.read()
    d = json.loads(src[src.index('= {') + 2:src.rindex(';')])['boss'][kind]
    bones = d['bones']
    return [(b[0], bones[b[1]][0] if b[1] >= 0 else None, (float(b[2]), float(b[3]), float(b[4]))) for b in bones]


def fit(V, F, spec):
    """返回 dict(scale（三维）, offset, height, src（枢轴）, k, yaw, bones（模板）)：游戏坐标 = rot(源坐标) × scale + offset"""
    o = spec.get('fit', {})
    kind = spec['kind']
    bones = template(kind)
    yaw = math.radians(o.get('yaw', 0.0))
    c, s = math.cos(yaw), math.sin(yaw)
    R = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    W = V @ R.T
    y0, y1 = W[:, 1].min(), W[:, 1].max()
    H = o.get('height', y1 - y0)
    k = o.get('xz_scale', 1.0)
    sc = H / (y1 - y0)
    scale = np.array([sc * k, sc, sc * k])
    cx = 0.5 * (W[:, 0].min() + W[:, 0].max())
    cz = 0.5 * (W[:, 2].min() + W[:, 2].max())
    offset = np.array([-cx * scale[0], -y0 * scale[1], o.get('z', 0.0) * k - cz * scale[2]])
    src = {n: np.array(p, dtype=np.float64) for n, _, p in bones}
    for n, p in o.get('pivots', {}).items():
        if n not in src:
            raise RuntimeError('fit.pivots：' + kind + ' 没有骨骼 ' + n)
        src[n] = np.array(p, dtype=np.float64) * [k, 1.0, k]  # 枢轴按 xz_scale = 1 时的坐标量的
    return dict(scale=scale, offset=offset, height=H, src=src, k=k, R=R, bones=bones, kind=kind)


def apply(V, f):
    """源顶点 → 游戏坐标"""
    return (V @ f['R'].T) * f['scale'] + f['offset']


def to_source(p, f):
    """游戏坐标 → 源 GLB 的坐标"""
    q = (np.asarray(p, dtype=np.float64) - f['offset']) / f['scale']
    return q @ f['R']


def skeleton_txt(f, native=True):
    """骨架文本：每行「名字 父骨骼 x y z」（glTF：y 朝上、+z 朝前、+x = 它自己的左边），骨骼顺序同首领包；native = 源 GLB 自己的坐标，否则游戏坐标（米）"""
    out = []
    for n, p, _ in f['bones']:
        q = to_source(f['src'][n], f) if native else f['src'][n]
        out.append('%s %s %.6f %.6f %.6f' % (n, p or '-', q[0], q[1], q[2]))
    return '\n'.join(out) + '\n'


def chains(f):
    """链：从根往下，每根骨骼的子骨骼（UniRig 用：骨骼的尾 = 唯一子骨骼的枢轴；叶子骨骼沿父骨骼的方向延长）"""
    kids = {}
    for n, p, _ in f['bones']:
        kids.setdefault(p, []).append(n)
    lines = []
    for n, p, _ in f['bones']:
        ch = kids.get(n, [])
        lines.append('%s -> %s' % (n, ', '.join(ch) if ch else '(leaf)'))
    return '\n'.join(lines) + '\n'
