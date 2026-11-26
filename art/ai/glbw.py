# 小的 GLB 读写（纯 numpy，不依赖 Blender）：AI 主角试验（ai3d-hero）的源文件读取和带蒙皮的产物导出。
# 写出来的 GLB 正好是游戏端 js/world.js cParse 读得懂的那种：一个网格、每个图元 POSITION / JOINTS_0 / WEIGHTS_0（可选 COLOR_0）+ 索引，
# 一套骨架（节点只带平移、不转，逆绑定矩阵 = 平移到枢轴的逆），材质只有名字和 baseColorFactor。
# 字节只由输入决定：JSON 按固定顺序写、数组按 float32 / uint16 / uint8 小端写，同样的输入两次写出来逐字节相同。
import json
import struct

import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read(path):
    """GLB → (json, bin, acc(i, norm=False))；acc 返回 numpy 数组（VECn → (count, n)），norm = 按 glTF 的 normalized 换成 0–1"""
    b = open(path, 'rb').read()
    if struct.unpack_from('<I', b, 0)[0] != 0x46546C67:
        raise RuntimeError('不是 GLB：' + path)
    jl = struct.unpack_from('<I', b, 12)[0]
    js = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack_from('<I', b, off)[0]
    bin_ = b[off + 8:off + 8 + bl]

    def acc(i, norm=False):
        a = js['accessors'][i]
        bv = js['bufferViews'][a['bufferView']]
        k = NC[a['type']]
        dt = np.dtype(CT[a['componentType']])
        o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        st = bv.get('byteStride')
        if st and st != dt.itemsize * k:
            raw = np.frombuffer(bin_, np.uint8, a['count'] * st, o).reshape(a['count'], st)[:, :dt.itemsize * k]
            arr = np.frombuffer(raw.tobytes(), dt).copy()
        else:
            arr = np.frombuffer(bin_, dt, a['count'] * k, o).copy()
        if (a.get('normalized') or norm) and dt.kind == 'u':
            arr = arr.astype(np.float64) / np.iinfo(dt).max
        return arr.reshape(a['count'], k) if k > 1 else arr

    return js, bin_, acc


def _q(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def node_world(js):
    """每个节点的世界矩阵（4×4，列向量约定）"""
    N = js['nodes']
    par = {}
    for i, n in enumerate(N):
        for c in n.get('children', []):
            par[c] = i
    W = {}

    def wm(i):
        if i in W:
            return W[i]
        n = N[i]
        M = np.eye(4)
        if 'matrix' in n:
            M = np.array(n['matrix'], dtype=np.float64).reshape(4, 4).T
        else:
            M[:3, :3] = _q(n.get('rotation', [0, 0, 0, 1])) * np.array(n.get('scale', [1, 1, 1]))
            M[:3, 3] = n.get('translation', [0, 0, 0])
        W[i] = wm(par[i]) @ M if i in par else M
        return W[i]

    return [wm(i) for i in range(len(N))], par


def write(path, prims, bones, name='ai_hero', extras=None):
    """prims：[dict(P (n,3), I (m,3), J (n,4) 骨骼序号, W (n,4), C (n,4) 线性 rgba 或 None, mat 材质名, base [r,g,b,a], name 图元名), ...]
    bones：[(名字, 父骨骼名或 None, 枢轴 (x,y,z)), ...]，父骨骼先出现。所有坐标是模型空间（米，glTF：y 朝上、+z 朝前）"""
    bidx = {b[0]: i for i, b in enumerate(bones)}
    blobs = []
    views = []
    accs = []

    def add(arr, ctype, typ, target=None, minmax=False, normalized=False):
        arr = np.ascontiguousarray(arr)
        raw = arr.tobytes()
        off = sum(len(x) for x in blobs)
        pad = (-off) % 4
        if pad:
            blobs.append(b'\0' * pad)
            off += pad
        blobs.append(raw)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(raw)}
        if target:
            v['target'] = target
        views.append(v)
        k = NC[typ]
        a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
        if normalized:
            a['normalized'] = True
        if minmax:
            r = arr.reshape(arr.shape[0], k).astype(np.float64)
            a['min'] = [float(np.float32(x)) for x in r.min(0)]
            a['max'] = [float(np.float32(x)) for x in r.max(0)]
        accs.append(a)
        return len(accs) - 1

    # 节点：0..nb-1 骨骼，nb 网格节点
    nb = len(bones)
    nodes = []
    for n, p, piv in bones:
        pp = np.array(piv, dtype=np.float64) - (np.array(bones[bidx[p]][2], dtype=np.float64) if p else 0)
        nd = {'name': n, 'translation': [float(np.float32(x)) for x in pp]}
        ch = [bidx[c] for c, cp, _ in bones if cp == n]
        if ch:
            nd['children'] = ch
        nodes.append(nd)
    ibm = np.zeros((nb, 16), dtype=np.float32)
    for i, (n, p, piv) in enumerate(bones):
        M = np.eye(4)
        M[:3, 3] = -np.array(piv, dtype=np.float64)
        ibm[i] = M.T.ravel()  # 列主序
    a_ibm = add(ibm, 5126, 'MAT4')
    mats, mat_of = [], {}
    gprims = []
    for pr in prims:
        if pr['mat'] not in mat_of:
            mat_of[pr['mat']] = len(mats)
            mats.append({'name': pr['mat'], 'pbrMetallicRoughness': {'baseColorFactor': [float(x) for x in pr.get('base', [1, 1, 1, 1])], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}})
        P = np.asarray(pr['P'], dtype=np.float32)
        att = {'POSITION': add(P, 5126, 'VEC3', 34962, minmax=True)}
        J = np.asarray(pr['J'])
        att['JOINTS_0'] = add(J.astype(np.uint8 if nb < 256 else np.uint16), 5121 if nb < 256 else 5123, 'VEC4', 34962)
        W = np.round(np.asarray(pr['W'], dtype=np.float64) * 255).astype(np.uint8)
        att['WEIGHTS_0'] = add(W, 5121, 'VEC4', 34962, normalized=True)
        if pr.get('C') is not None:
            C = np.round(np.clip(np.asarray(pr['C'], dtype=np.float64), 0, 1) * 65535).astype(np.uint16)
            att['COLOR_0'] = add(C, 5123, 'VEC4', 34962, normalized=True)
        I = np.asarray(pr['I']).reshape(-1)
        gp = {'attributes': att, 'indices': add(I.astype(np.uint16 if len(P) < 65536 else np.uint32), 5123 if len(P) < 65536 else 5125, 'SCALAR', 34963), 'material': mat_of[pr['mat']], 'mode': 4}
        if pr.get('name'):
            gp['extras'] = {'name': pr['name']}
        gprims.append(gp)
    nodes.append({'name': name, 'mesh': 0, 'skin': 0})
    roots = [i for i, b in enumerate(bones) if not b[1]] + [nb]
    js = {
        'asset': {'version': '2.0', 'generator': 'cinder art/ai/glbw.py'},
        'scene': 0,
        'scenes': [{'nodes': roots}],
        'nodes': nodes,
        'meshes': [{'name': name, 'primitives': gprims}],
        'materials': mats,
        'skins': [{'name': name + '_skel', 'joints': list(range(nb)), 'inverseBindMatrices': a_ibm, 'skeleton': roots[0]}],
        'accessors': accs,
        'bufferViews': views,
        'buffers': [{'byteLength': 0}],
    }
    if extras:
        js['asset']['extras'] = extras
    binb = b''.join(blobs)
    binb += b'\0' * ((-len(binb)) % 4)
    js['buffers'][0]['byteLength'] = len(binb)
    jb = json.dumps(js, separators=(',', ':'), ensure_ascii=False).encode('utf8')
    jb += b' ' * ((-len(jb)) % 4)
    total = 12 + 8 + len(jb) + 8 + len(binb)
    out = struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(jb), 0x4E4F534A) + jb + struct.pack('<II', len(binb), 0x004E4942) + binb
    with open(path, 'wb') as fh:
        fh.write(out)
    return len(out)


def write_mesh(path, P, I, C=None, J=None, W=None, bones=None, name='src'):
    """源格式的 GLB（试验用的合成输入）：一个图元；有 bones 时带蒙皮（像 UniRig 的输出），否则不带骨架"""
    if bones is None:
        # 不带骨架：用一根假骨骼占位会改变格式，这里单独写一份最小的
        blobs, views, accs = [], [], []

        def add(arr, ctype, typ, target, minmax=False, normalized=False):
            arr = np.ascontiguousarray(arr)
            off = sum(len(x) for x in blobs)
            pad = (-off) % 4
            if pad:
                blobs.append(b'\0' * pad)
                off += pad
            blobs.append(arr.tobytes())
            views.append({'buffer': 0, 'byteOffset': off, 'byteLength': arr.nbytes, 'target': target})
            a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
            if normalized:
                a['normalized'] = True
            if minmax:
                a['min'] = [float(x) for x in arr.min(0)]
                a['max'] = [float(x) for x in arr.max(0)]
            accs.append(a)
            return len(accs) - 1

        att = {'POSITION': add(np.asarray(P, np.float32), 5126, 'VEC3', 34962, True)}
        if C is not None:
            att['COLOR_0'] = add(np.round(np.clip(C, 0, 1) * 65535).astype(np.uint16), 5123, 'VEC4', 34962, normalized=True)
        ind = add(np.asarray(I, np.uint32).reshape(-1), 5125, 'SCALAR', 34963)
        js = {'asset': {'version': '2.0', 'generator': 'cinder art/ai/glbw.py'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
              'nodes': [{'name': name, 'mesh': 0}], 'meshes': [{'name': name, 'primitives': [{'attributes': att, 'indices': ind, 'material': 0}]}],
              'materials': [{'name': name, 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1]}}],
              'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': 0}]}
        binb = b''.join(blobs)
        binb += b'\0' * ((-len(binb)) % 4)
        js['buffers'][0]['byteLength'] = len(binb)
        jb = json.dumps(js, separators=(',', ':')).encode('utf8')
        jb += b' ' * ((-len(jb)) % 4)
        total = 12 + 8 + len(jb) + 8 + len(binb)
        with open(path, 'wb') as fh:
            fh.write(struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(jb), 0x4E4F534A) + jb + struct.pack('<II', len(binb), 0x004E4942) + binb)
        return
    write(path, [dict(P=P, I=I, J=J, W=W, C=C, mat=name, name=name)], bones, name=name)
