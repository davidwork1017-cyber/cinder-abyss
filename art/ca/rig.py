# 首领的骨架、蒙皮、动作和带蒙皮的 GLB 导出（在无头 Blender 里跑）。说明见 docs/art-pipeline.md「首领」一节。
# 约定：
#   - 骨骼名按 art/rig.json 的 boss 一节（人形部位用标准骨架名，其余 x_<部位>[_l|_r][_NN]，根骨骼一律 pelvis）。
#   - 所有骨骼都竖直朝上（尾巴 = 头 + 0.25 m 的 +Z）、滚转 0。这样骨骼自己的坐标轴和游戏的模型空间一致
#     （Blender 的 X / Z / -Y → glTF 的 X / Y / Z），动作表里的转角、位移直接就是游戏关节通道（rx ry rz ox oy oz）的值。
#   - 动作表和游戏 js/world.js 的 defClip 同一个写法：'骨骼.通道': [k0, v0, k1, v1, ...]，k 是 0–1 的归一化时间，
#     段内缓入缓出，k 写成负数 = 加速冲到这一帧（出手、落地）。欧拉角按游戏的 XYZ 顺序（R = Rx · Ry · Rz）。
#     为了游戏端从矩阵换回欧拉角时拿到同一组值：|ry| < π/2，rx / rz 在 (−π, π) 里（keys_check 检查）。
#   - 导出时每段动作逐帧采样（帧 f 对应 k = f / N，N ≈ 时长 × 30，往上取到 k0 / 落地时刻正好落在某一帧上），每段动作的参数（k0 / loop / hold /
#     loopFrom / steady ……）写进 glTF 动画的 extras（导出后在这里改 GLB 的 JSON 块，导出器本身的 extras 选项保持关闭）。
#   - 蒙皮权重在 Python 里按零件标签算（刚性件 = 1，软接缝按到关节的距离渐变），量化到 1/255、每个顶点最多 4 根骨骼，
#     不用 Blender 的自动权重（骨骼热量法每次可能不一样）。
import json
import math
import os
import struct

import bpy
from mathutils import Euler, Vector

FPS = 30
BONE_LEN = 0.25


def g2b(p):
    """游戏坐标（x, y 朝上, z 朝前）→ Blender 坐标（x, y 朝后, z 朝上）"""
    return (p[0], -p[2], p[1])


def kf(K, k):
    """和 js/world.js 的 kf 一样：段内 smoothstep，时间写成负数的那一帧用 t³（加速冲过去）"""
    n = len(K)
    ka = abs(K[0])
    if k <= ka:
        return K[1]
    for i in range(2, n, 2):
        kb = abs(K[i])
        if k <= kb:
            t = (k - ka) / (kb - ka) if kb > ka else 1.0
            t = t * t * t if K[i] < 0 else t * t * (3 - 2 * t)
            return K[i - 1] + (K[i + 1] - K[i - 1]) * t
        ka = kb
    return K[n - 1]


def mirror_keys(keys):
    """左右镜像一组关键帧：_l / _r 互换，绕 y / z 的转角和 x 向位移取反"""
    out = {}
    for key, K in keys.items():
        b, ch = key.rsplit('.', 1)
        nb = b[:-2] + '_r' if b.endswith('_l') else b[:-2] + '_l' if b.endswith('_r') else b
        nb = nb.replace('_l_', '_R_').replace('_r_', '_l_').replace('_R_', '_r_')
        flip = ch in ('ry', 'rz', 'ox')
        out[nb + '.' + ch] = [(-v if (i % 2 and flip) else v) for i, v in enumerate(K)]
    return out


class Skel:
    """骨架描述：[(名字, 父骨骼或 None, 枢轴（游戏坐标）), ...]，父骨骼必须先出现"""

    def __init__(self, bones):
        self.bones = bones
        self.index = {b[0]: i for i, b in enumerate(bones)}
        self.parent = {b[0]: b[1] for b in bones}
        self.pivot = {b[0]: b[2] for b in bones}
        assert bones[0][0] == 'pelvis' and bones[0][1] is None, '根骨骼必须是 pelvis'
        for n, p, _ in bones:
            assert p is None or self.index[p] < self.index[n], '父骨骼要先出现：' + n

    def names(self):
        return [b[0] for b in self.bones]


def armature(skel, name):
    """按骨架描述建一个 Armature 对象（骨骼竖直朝上、滚转 0）"""
    ad = bpy.data.armatures.new(name + '_skel')
    ob = bpy.data.objects.new(name + '_skel', ad)
    bpy.context.scene.collection.objects.link(ob)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    eb = ad.edit_bones
    for n, p, piv in skel.bones:
        b = eb.new(n)
        h = Vector(g2b(piv))
        b.head = h
        b.tail = h + Vector((0, 0, BONE_LEN))
        b.roll = 0.0
        b.use_deform = True
        if p:
            b.parent = eb[p]
            b.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def skin(ob, arm, skel, bind, soft):
    """蒙皮：bind = 顶点索引 → (骨骼名, 是否软接缝)（零件标签，刚性权重 1）；soft = [(子骨骼, 父骨骼, 枢轴（游戏坐标）, 轴（游戏坐标，从父指向子）, 带宽 m), ...]：
    标了软接缝、属于子骨骼或父骨骼的顶点，在关节枢轴沿轴 ±带宽/2 的范围里按 smoothstep 在两根骨骼之间渐变（接缝弯折时不开口）；没标的零件一律刚性。
    返回每根骨骼的顶点数（查漏标用）"""
    me = ob.data
    groups = {n: ob.vertex_groups.new(name=n) for n in skel.names()}
    soft_by = {}
    for c, p, piv, ax, band in soft:
        a = Vector(g2b(ax)).normalized()
        soft_by.setdefault(c, []).append((c, p, Vector(g2b(piv)), a, band))
        soft_by.setdefault(p, []).append((c, p, Vector(g2b(piv)), a, band))
    q = lambda w: round(w * 255) / 255
    count = {}
    for v in me.vertices:
        b, sf = bind[v.index]
        ws = {b: 1.0}
        # 软接缝：取离这个顶点最近的那道关节（一根骨骼两头都可能有软接缝）
        best = None
        for c, p, piv, a, band in (soft_by.get(b, ()) if sf else ()):
            d = (v.co - piv).dot(a)
            if best is None or abs(d) < abs(best[0]):
                best = (d, c, p, band)
        if best is not None:
            d, c, p, band = best
            t = min(1.0, max(0.0, d / band + 0.5))
            t = t * t * (3 - 2 * t)
            ws = {c: t, p: 1 - t}
        ws = {k: q(w) for k, w in ws.items() if q(w) > 0}
        s = sum(ws.values())
        # 量化以后再归一：把差额补到最重的那根上，权重和正好是 255 / 255
        top = max(sorted(ws), key=lambda k: ws[k])
        ws[top] = q(ws[top] + (1 - s))
        for k in sorted(ws):
            groups[k].add([v.index], ws[k], 'REPLACE')
            count[k] = count.get(k, 0) + 1
    mod = ob.modifiers.new('skel', 'ARMATURE')
    mod.object = arm
    ob.parent = arm
    return count


def keys_check(name, keys, skel):
    for key, K in keys.items():
        b, ch = key.rsplit('.', 1)
        assert b in skel.index, name + '：没有骨骼 ' + b
        assert ch in ('rx', 'ry', 'rz', 'ox', 'oy', 'oz'), name + '：未知通道 ' + key
        assert len(K) % 2 == 0 and len(K) >= 2, name + '：关键帧要成对 ' + key
        ts = [abs(K[i]) for i in range(0, len(K), 2)]
        assert ts == sorted(ts) and ts[0] >= 0 and ts[-1] <= 1, name + '：时间要从小到大、在 0–1 里 ' + key
        for i in range(1, len(K), 2):
            v = K[i]
            if ch == 'ry':
                assert abs(v) < math.pi / 2 - 0.02, name + '：ry 要在 ±π/2 以内 ' + key
            elif ch[0] == 'r':
                assert abs(v) < math.pi - 0.02, name + '：转角要在 ±π 以内 ' + key


def key_clips(arm, skel, clips):
    """每段动作建一个 Action，逐帧（30 帧 / 秒）写进姿态骨骼的四元数和位移，推进 NLA 轨道（导出器按动作逐段导出）。
    clips = {名字: spec}，spec 和 defClip 一样：dur / k0 / loop / hold / fade / out / base / air / lower / steady / loopFrom / keys / extra（别的元数据）"""
    ad = arm.animation_data_create()
    pbs = arm.pose.bones
    for pb in pbs:
        pb.rotation_mode = 'QUATERNION'
    meta = []
    for cname in sorted(clips):
        sp = clips[cname]
        keys = sp['keys']
        keys_check(cname, keys, skel)
        N = max(1, round(sp['dur'] * FPS))
        # 接触帧（k0）和别的标记时刻（extra 里的 impact，秒）要正好落在采样帧上：游戏端在帧之间线性插值，
        # 落在两帧之间的话加速冲过去的那一下会被抹平、晚一帧到位。帧数从 round(时长 × 30) 往上加到都对齐为止
        marks = [sp['k0']] if 'k0' in sp else []
        if 'impact' in sp.get('extra', {}):
            marks.append(sp['extra']['impact'] / sp['dur'])
        while any(abs(m * N - round(m * N)) > 1e-6 for m in marks):
            N += 1
        act = bpy.data.actions.new(cname)
        act.use_fake_user = True
        ad.action = act
        # 这段动作碰到的骨骼：没写关键帧的骨骼也逐帧写静止姿态（每段动作的通道集合一样，导出的骨骼也一样）
        by = {}
        for key, K in keys.items():
            b, ch = key.rsplit('.', 1)
            by.setdefault(b, {})[ch] = K
        trans = sorted(b for b, chs in by.items() if any(c[0] == 'o' for c in chs))
        for f in range(N + 1):
            k = f / N
            for n in skel.names():
                pb = pbs[n]
                chs = by.get(n, {})
                rx, ry, rz = (kf(chs[c], k) if c in chs else 0.0 for c in ('rx', 'ry', 'rz'))
                ox, oy, oz = (kf(chs[c], k) if c in chs else 0.0 for c in ('ox', 'oy', 'oz'))
                pb.rotation_quaternion = Euler((rx, ry, rz), 'ZYX').to_quaternion()  # Blender 的 'ZYX' = 先 z 后 y 再 x = Rx · Ry · Rz
                pb.location = (ox, oy, oz)
                if n in by:  # 这段动作没写到的骨骼不写关键帧（导出器把它当静止姿态，不出通道）
                    pb.keyframe_insert('rotation_quaternion', frame=f, group=n)
                    if n in trans:
                        pb.keyframe_insert('location', frame=f, group=n)
        for fc in _fcurves(act):
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
        act.use_frame_range = True
        act.frame_start = 0
        act.frame_end = N
        tr = ad.nla_tracks.new()
        tr.name = cname
        tr.strips.new(cname, 0, act)
        ad.action = None
        ex = {k: sp[k] for k in ('k0', 'loop', 'hold', 'fade', 'out', 'base', 'air', 'lower', 'steady', 'loopFrom') if k in sp}
        ex['dur'] = sp['dur']
        ex['frames'] = N
        ex['trans'] = trans
        ex.update(sp.get('extra', {}))
        meta.append((cname, ex))
    for pb in pbs:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    return dict(meta)


def _fcurves(act):
    """Blender 5 的分层动作：fcurve 在 layers → strips → channelbags 里；老版本在 act.fcurves"""
    if hasattr(act, 'fcurves') and act.fcurves is not None and not hasattr(act, 'layers'):
        return list(act.fcurves)
    out = []
    for ly in act.layers:
        for st in ly.strips:
            for cb in st.channelbags:
                out.extend(cb.fcurves)
    return out


def export_glb(ob, arm, path, meta):
    """导出带蒙皮和动作的 GLB（Y 朝上），再把每段动作的参数写进 animations[i].extras。返回导出的动作名"""
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.render.fps_base = 1.0
    for o in sc.objects:
        o.select_set(o is ob or o is arm)
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
        export_skins=True,
        export_influence_nb=4,
        export_all_influences=False,
        export_def_bones=True,
        export_rest_position_armature=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_frame_step=1,
        export_optimize_animation_size=True,
        export_anim_single_armature=True,
        export_reset_pose_bones=True,
        export_morph=False,
        export_extras=False,
    )
    return patch_extras(path, meta)


def patch_extras(path, meta):
    """GLB 的 JSON 块里给每段动画补上 extras（按名字对），重新写回；字节由输入决定"""
    with open(path, 'rb') as fh:
        buf = fh.read()
    jl = struct.unpack_from('<I', buf, 12)[0]
    js = json.loads(buf[20:20 + jl].decode('utf8'))
    rest = buf[20 + jl:]
    names = []
    for a in js.get('animations', []):
        names.append(a['name'])
        if a['name'] not in meta:
            raise RuntimeError('导出了表里没有的动作：' + a['name'])
        a['extras'] = meta[a['name']]
    missing = sorted(set(meta) - set(names))
    if missing:
        raise RuntimeError('这些动作没导出来：' + ','.join(missing))
    out = json.dumps(js, separators=(',', ':'), ensure_ascii=False, sort_keys=False).encode('utf8')
    out += b' ' * ((4 - len(out) % 4) % 4)
    total = 12 + 8 + len(out) + len(rest)
    head = struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(out), 0x4E4F534A)
    with open(path, 'wb') as fh:
        fh.write(head + out + rest)
    return names
