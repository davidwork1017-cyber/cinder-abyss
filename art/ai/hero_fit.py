# AI 主角试验（ai3d-hero，不上线）第一步：把一个 A 字站姿的人形网格对到主角的标准骨架（UE / UAL 骨骼名）上。纯 numpy，不依赖 Blender。
# 输入：源网格的顶点 / 三角形（glTF：y 朝上、+z 朝前、+x 是角色自己的左边，单位随意，通常身高约 1）。
# 输出 fit(V, F, spec) → dict：
#   scale / offset：源坐标 → 游戏坐标（米）：身高缩放到 spec.height（缺省 1.90，和现网主角一样），脚底 y = 0，两胯中点 x = z = 0；
#   src：每根骨骼在「源的姿态」（A 字站姿）下的枢轴（游戏坐标）；
#   lm：中间量（手臂的轴、腕的位置、手的分段、裆高……），出图、分区和调参用；
#   arm：每个焊接后顶点属于哪条手臂（0 没有 / 1 左 / -1 右），和手臂轴上的参数 t（米，从肩枢轴量起）。
# 估法（没有随机数，同样输入同样输出；每一项都能在 spec['fit'] 里写死覆盖）：
#   手：A 字站姿下最外侧的点就是指尖；手臂 = 两侧「手臂和躯干之间的空隙」外面、连着指尖的连通分量；
#   手臂轴 = 手臂点（去掉手）主成分的方向；肩枢轴 = 轴和躯干外沿（胸口高度、不含手臂）的交点往里一点；
#   腕 = 轴上 62%–88% 段里截面最细的地方；肘 = 肩 → 腕的 0.557（成年人上臂 : 前臂 ≈ 0.34 : 0.27）；
#   手：腕以外的部分，四指按「连指手套」分三节（指根 0.45、中节 0.66、末节 0.84，占手长），拇指 = 手掌段里往掌前方伸出去的点；
#   腿：裆（只看前半身：背后的长后摆会挡在两腿之间）以下；胯 = 裆上 0.05、膝 = 胯高 × 0.55、踝 = 胯高 × 0.10，截面取 x 的中点、
#     z 取「前沿 − 半宽」（腿近似圆，背后的后摆不拉偏）；
#   躯干：骨盆 → 胸口按现网主角的比例插在胯和肩之间，颈、头按肩到头顶插；z 取截面（不含手臂）的中点。
import numpy as np

# 现网主角（Adventurer 换算到 1.90 m）的静止姿态，用来插比例：胯 0.988、肩 1.466、头顶 1.90
LIVE = dict(hip=0.988, shoulder=1.466, top=1.90, pelvis=0.916, spine_01=1.023, spine_02=1.189, spine_03=1.410, neck_01=1.547, Head=1.625)

FINGERS = ('thumb', 'index', 'middle', 'ring', 'pinky')


def bones():
    """[(名字, 父骨骼或 None)]：主角标准骨架（53 根），父骨骼先出现"""
    out = [('pelvis', None), ('spine_01', 'pelvis'), ('spine_02', 'spine_01'), ('spine_03', 'spine_02'), ('neck_01', 'spine_03'), ('Head', 'neck_01'), ('head_leaf', 'Head')]
    for s in 'lr':
        out += [('clavicle_' + s, 'spine_03'), ('upperarm_' + s, 'clavicle_' + s), ('lowerarm_' + s, 'upperarm_' + s), ('hand_' + s, 'lowerarm_' + s)]
        for f in FINGERS:
            for k in (1, 2, 3):
                out.append(('%s_0%d_%s' % (f, k, s), 'hand_' + s if k == 1 else '%s_0%d_%s' % (f, k - 1, s)))
        out += [('thigh_' + s, 'pelvis'), ('calf_' + s, 'thigh_' + s), ('foot_' + s, 'calf_' + s), ('ball_' + s, 'foot_' + s)]
    return out


BONES = bones()
NAMES = [b[0] for b in BONES]
PARENT = dict(BONES)


def rig_bones(rig):
    """各角色的骨骼集合（标准名，父骨骼和现网模型一致，所以程序化关节、动作采样都不变）：
      hero：主角 53 根；husk：游魂 = 现网 Zombie 的 41 根（Mixamo 名按 STD_ALIAS.mixamo 换成标准名：手只有拇指和食指，各 4 节，脚尖 ball_leaf）；
      thrall：烬骸仆从 = 现网 Skeleton 的 12 根（STD_ALIAS.monster：没有手、脚、锁骨，手臂直接挂在骨盆下）"""
    if rig == 'hero':
        return BONES
    if rig == 'husk':
        out = [('pelvis', None), ('spine_01', 'pelvis'), ('spine_02', 'spine_01'), ('spine_03', 'spine_02'), ('neck_01', 'spine_03'), ('Head', 'neck_01'), ('head_leaf', 'Head')]
        for s in 'lr':
            out += [('clavicle_' + s, 'spine_03'), ('upperarm_' + s, 'clavicle_' + s), ('lowerarm_' + s, 'upperarm_' + s), ('hand_' + s, 'lowerarm_' + s)]
            for f in ('thumb', 'index'):
                out += [('%s_0%d_%s' % (f, k, s), 'hand_' + s if k == 1 else '%s_0%d_%s' % (f, k - 1, s)) for k in (1, 2, 3, 4)]
        for s in 'lr':
            out += [('thigh_' + s, 'pelvis'), ('calf_' + s, 'thigh_' + s), ('foot_' + s, 'calf_' + s), ('ball_' + s, 'foot_' + s), ('ball_leaf_' + s, 'ball_' + s)]
        return out
    if rig == 'thrall':
        return [('pelvis', None), ('spine_03', 'pelvis'), ('neck_01', 'spine_03'), ('Head', 'neck_01'),
                ('thigh_r', 'pelvis'), ('calf_r', 'thigh_r'), ('thigh_l', 'pelvis'), ('calf_l', 'thigh_l'),
                ('upperarm_r', 'pelvis'), ('lowerarm_r', 'upperarm_r'), ('upperarm_l', 'pelvis'), ('lowerarm_l', 'upperarm_l')]
    raise RuntimeError('未知骨骼集合 ' + rig)


def weld(V, F, eps=1e-5):
    key = np.round(V / eps).astype(np.int64)
    _, idx, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    return inv, inv[F], V[idx]


def components(n, edges, mask):
    """mask 里的顶点、两端都在 mask 里的边：连通分量的根（根 = 分量里最小的序号；不在 mask 里 = -1）"""
    par = np.arange(n)

    def find(a):
        r = a
        while par[r] != r:
            r = par[r]
        while par[a] != r:
            par[a], a = r, par[a]
        return r

    for a, b in edges[mask[edges[:, 0]] & mask[edges[:, 1]]]:
        ra, rb = find(a), find(b)
        if ra != rb:
            par[max(ra, rb)] = min(ra, rb)
    root = np.array([find(i) for i in range(n)])
    root[~mask] = -1
    return root


def _first_gap(vals, lo, hi, step, run):
    nb = int(round((hi - lo) / step))
    h = np.zeros(nb, dtype=np.int64)
    i = np.floor((vals - lo) / step).astype(np.int64)
    ok = (i >= 0) & (i < nb)
    np.add.at(h, i[ok], 1)
    seen = False
    k = 0
    while k < nb:
        if h[k]:
            seen = True
            k += 1
            continue
        j = k
        while j < nb and not h[j]:
            j += 1
        if seen and j - k >= run and j < nb:
            return lo + k * step, lo + j * step
        k = j
    return None


def _mid(P, q=(2, 98)):
    lo, hi = np.percentile(P, q, axis=0)
    return 0.5 * (lo + hi)


def landmarks(W, WF, o):
    """W：单位化、焊接后的顶点（脚底 y = 0、身高 1、x / z 以包围盒为中心）；WF：三角形。返回 lm 和每个顶点的手臂标记 / 轴参数"""
    x, y, z = W[:, 0], W[:, 1], W[:, 2]
    n = len(W)
    edges = np.concatenate([WF[:, [0, 1]], WF[:, [1, 2]], WF[:, [2, 0]]])
    lm = {}
    arm_of = np.zeros(n, dtype=np.int64)
    t_of = np.zeros(n)
    # 裆：只看前半身（z 在中位数以前）；从下往上第一个在 x≈0 有表面的高度
    zc = float(np.median(z))
    crotch = o.get('crotch')
    if crotch is None:
        for yy in np.arange(0.2, 0.7, 0.0025):
            if np.any((np.abs(x) < 0.012) & (np.abs(y - yy) < 0.003) & (z > zc)):
                crotch = float(yy)
                break
    if crotch is None:
        raise RuntimeError('找不到裆的高度（fit.crotch）')
    lm['crotch'] = crotch
    for side, sg in (('l', 1.0), ('r', -1.0)):
        sx = sg * x
        # 指尖：最外侧的点（A 字站姿）
        tip_i = int(np.argmax(sx))
        tip = W[tip_i]
        # 手臂和躯干之间的空隙：指尖以上一段高度里，从躯干往外第一段空的
        y0, y1 = o.get('gap_band', [tip[1] + 0.04, tip[1] + 0.13])
        band = (y > y0) & (y < y1)
        gap = o.get('gap_' + side) or _first_gap(sx[band], 0.02, float(sx.max()), 0.004, 2)
        if gap is None:
            raise RuntimeError('手臂和躯干之间没有空隙（fit.gap_%s）' % side)
        xg = 0.5 * (gap[0] + gap[1])
        if 'arm_ymin' in o:
            # 骨头一节一节分开的模型（骷髅）：网格不连通，手臂按位置切（空隙外侧、arm_ymin 以上）
            av = (sx > xg) & (y > o['arm_ymin'])
        else:
            root = components(n, edges, sx > xg)
            av = root == root[tip_i]
        AP = W[av]
        # 躯干外沿：胸口高度、不在手臂分量里的点
        sh_band = o.get('torso_band', [0.66, 0.72])
        tor = (~av) & (y > sh_band[0]) & (y < sh_band[1]) & (sx > 0)
        w_t = float(np.percentile(sx[tor], 98))
        # 手臂轴：手臂分量里离指尖 0.12 以上的点（去掉手）做主成分
        dt = np.linalg.norm(AP - tip, axis=1)
        body = AP[dt > o.get('hand_guess', 0.12)]
        c = body.mean(axis=0)
        u, s_, vt = np.linalg.svd(body - c, full_matrices=False)
        d = vt[0] if vt[0] @ (tip - c) > 0 else -vt[0]  # 朝指尖
        # 肩枢轴：轴上 x = 躯干外沿 − inset 的点
        inset = o.get('shoulder_inset', 0.02)
        ts = ((w_t - inset) * sg - c[0]) / d[0]
        sh = c + ts * d
        # 肩的高度：不高于这一列（x ≈ 枢轴）肩膀表面最高点往下 shoulder_drop（A 字角度小的时候，轴往里延长会冒出肩膀）
        colm = (np.abs(sx - sg * sh[0]) < 0.01) & (y < tip[1] + 0.45) & (y > tip[1])
        if colm.any():
            sh[1] = min(sh[1], float(y[colm].max()) - o.get('shoulder_drop', 0.035))
            colz = colm & (y > sh[1] - 0.02) & (y < sh[1] + 0.02)
            if colz.sum() > 4:
                sh[2] = float(_mid(W[colz][:, 2:3])[0])
        if 'shoulder_y' in o:
            sh[1] = o['shoulder_y']
        # 轴参数（从肩枢轴量起）
        t_all = (W - sh) @ d
        t_tip = float((tip - sh) @ d)
        # 腕：62%–88% 段里截面最细（截面点到轴的距离的 90 分位）
        ts_ = np.arange(0.62, 0.885, 0.01) * t_tip
        rad = []
        for tt in ts_:
            sl = av & (np.abs(t_all - tt) < 0.006)
            if sl.sum() < 6:
                rad.append(9.0)
                continue
            q = W[sl] - (sh + np.outer(t_all[sl], d))
            rad.append(float(np.percentile(np.linalg.norm(q, axis=1), 90)))
        t_wr = o.get('wrist_t', float(ts_[int(np.argmin(rad))]) / t_tip) * t_tip
        t_el = o.get('elbow_frac', 0.557) * t_wr

        def centre(tt, w=0.008):
            sl = av & (np.abs(t_all - tt) < w)
            if sl.sum() < 6:
                return sh + tt * d
            p = _mid(W[sl])
            # 中点投回轴的垂面
            return p - ((p - sh) @ d - tt) * d

        wr, el = centre(t_wr), centre(t_el)
        # 手：腕以外；手长、掌前方向（+z 去掉沿轴的分量）、拇指
        hand = av & (t_all > t_wr)
        Lh = t_tip - t_wr
        fwd = np.array([0.0, 0.0, 1.0]) - d * d[2]
        fwd /= np.linalg.norm(fwd)
        lat = np.cross(d, fwd)
        rel = W - sh - np.outer(t_all, d)
        th = (t_all - t_wr) / max(Lh, 1e-6)
        fing = hand & (th > 0.6) & (th < 0.92)
        # 指节线（四指并排的方向）= 手指段截面里最宽的方向（垂直于手的轴）
        FP = rel[fing] - np.outer(rel[fing] @ d, d) if fing.sum() >= 6 else None
        if FP is not None:
            _, _, vt2 = np.linalg.svd(FP - FP.mean(0), full_matrices=False)
            kl = vt2[0] - d * (vt2[0] @ d)
            kl /= np.linalg.norm(kl)
        else:
            kl = fwd.copy()
        npalm = np.cross(d, kl)
        npalm /= np.linalg.norm(npalm)
        # 掌心朝哪一面：手指微微弯着时，指尖那一段往掌心那边偏（比掌根那一段）；偏得不明显就按 palm_hint（缺省朝身体内下方，简报要的掌心朝大腿）
        tipz = hand & (th > 0.8)
        palmz = hand & (th > 0.05) & (th < 0.35)
        dev = float((rel[tipz] @ npalm).mean() - (rel[palmz] @ npalm).mean()) if tipz.sum() > 4 and palmz.sum() > 4 else 0.0
        hint = o.get('palm_hint_' + side)
        if hint is not None:
            if npalm @ np.array(hint) < 0:
                npalm = -npalm
            palm_src = 'hint'
        elif abs(dev) > o.get('curl_dev_min', 0.004):
            if dev < 0:
                npalm = -npalm
            palm_src = 'curl'
        else:
            if npalm @ np.array([-sg, -1.0, 0.0]) < 0:
                npalm = -npalm
            palm_src = 'default'
        curl_ax = np.cross(d, npalm)  # 绕它转正角：手指从 d 转向掌心
        curl_ax /= np.linalg.norm(curl_ax)
        # 拇指：掌段里沿指节线伸出四指那一条带之外的点（取点多的那一侧）；不够就退回「往掌前伸出去」的旧判法
        ok_ = rel @ kl
        f_lo, f_hi = (np.percentile(ok_[fing], [3, 97]) if fing.any() else (0.0, 0.0))
        pz = hand & (th > o.get('thumb_t0', 0.05)) & (th < o.get('thumb_t1', 0.62))
        m_ = o.get('thumb_margin', 0.006)
        cp, cn = pz & (ok_ > f_hi + m_), pz & (ok_ < f_lo - m_)
        thumb = cp if cp.sum() >= cn.sum() else cn
        if thumb.sum() < 6:
            fz = rel @ fwd
            fh = float(np.percentile(fz[fing], 95)) if fing.any() else 0.0
            thumb = pz & (fz > fh + m_)
        fr = o.get('finger_frac', [0.45, 0.66, 0.84])
        seg = {}
        for k, f_ in enumerate(fr):
            seg['k%d' % (k + 1)] = centre(t_wr + f_ * Lh, 0.006)
        if thumb.sum() >= 6:
            TP = W[thumb]
            tb = TP[np.argsort((TP - wr) @ d)][: max(3, len(TP) // 6)].mean(0)
            tt = TP[np.argmax(np.linalg.norm(TP - wr, axis=1))]
            thumb_pts = [tb, tb + 0.45 * (tt - tb), tb + 0.8 * (tt - tb)]
        else:
            thumb_pts = None
        arm_of[av] = int(sg)
        t_of[av] = t_all[av]
        lm[side] = dict(gap=[round(float(gap[0]), 4), round(float(gap[1]), 4)], torso_w=w_t, axis=d, shoulder=sh, elbow=el, wrist=wr, tip=tip,
                        t_el=t_el, t_wr=t_wr, t_tip=t_tip, hand_len=Lh, fwd=fwd, lat=lat, seg=seg, thumb=thumb_pts, f_hi=float(f_hi), palm_src=palm_src, curl_dev=dev, knuckle=kl, palm=npalm, curl_axis=curl_ax,
                        thumb_n=int(thumb.sum()), thumb_mask=thumb, arm_mask=av)
    # 腿
    hip_up = o.get('hip_up', 0.05)
    for side, sg in (('l', 1.0), ('r', -1.0)):
        sx = sg * x
        leg = (sx > 0.004) & (y < crotch) & (arm_of == 0)

        def lcen(yy, w=0.012):
            sl = leg & (np.abs(y - yy) < w)
            if sl.sum() < 8:
                raise RuntimeError('腿在 y = %.3f 处没有点' % yy)
            P = W[sl]
            xl, xh = np.percentile(P[:, 0], [2, 98])
            zf = np.percentile(P[:, 2], 98)
            r = 0.5 * (xh - xl)
            return np.array([0.5 * (xl + xh), yy, zf - r * o.get('leg_round', 1.0)])

        hy = o.get('hip_y', crotch + hip_up)
        top = lcen(crotch - 0.03)
        hip = np.array([top[0], hy, top[2]])
        # 膝：截面取在护膝下面一点（护膝 / 后摆不拉偏 x、z），高度仍是膝
        ky = o.get('knee_frac', 0.55) * hy
        knee = lcen(ky - o.get('knee_probe', 0.035))
        knee[1] = ky
        ank = lcen(o.get('ankle_frac', 0.10) * hy, 0.01)
        foot = leg & (y < 0.03)
        zf = float(np.percentile(W[foot][:, 2], 98)) if foot.any() else ank[2] + 0.06
        ball = np.array([ank[0], min(0.013, ank[1] * 0.5), ank[2] + 0.62 * (zf - ank[2])])
        lm[side].update(hip=hip, knee=knee, ankle=ank, ball=ball, toe_z=zf)
    return lm, arm_of, t_of


def fit(V, F, spec=None):
    """返回 dict(scale, offset, height, src, lm, arm, t, unit, W, WF, inv)。游戏坐标 = 源坐标 × scale + offset"""
    o = (spec or {}).get('fit', {})
    inv, WF, W0 = weld(np.asarray(V, dtype=np.float64), np.asarray(F))
    keep = (WF[:, 0] != WF[:, 1]) & (WF[:, 1] != WF[:, 2]) & (WF[:, 0] != WF[:, 2])
    WF = WF[keep]
    y0, y1 = W0[:, 1].min(), W0[:, 1].max()
    h = y1 - y0
    cx = 0.5 * (W0[:, 0].min() + W0[:, 0].max())
    cz = 0.5 * (W0[:, 2].min() + W0[:, 2].max())
    W = (W0 - [cx, y0, cz]) / h
    lm, arm_of, t_of = landmarks(W, WF, o)
    H = o.get('height', 1.90)
    zoff = -0.5 * (lm['l']['hip'][2] + lm['r']['hip'][2])
    xoff = -0.5 * (lm['l']['hip'][0] + lm['r']['hip'][0])
    g = lambda u: np.array([(u[0] + xoff) * H, u[1] * H, (u[2] + zoff) * H])
    L, R = lm['l'], lm['r']
    hip_y = 0.5 * (L['hip'][1] + R['hip'][1]) * H
    sh_y = 0.5 * (L['shoulder'][1] + R['shoulder'][1]) * H

    def trunk(live):
        return hip_y + (live - LIVE['hip']) / (LIVE['shoulder'] - LIVE['hip']) * (sh_y - hip_y)

    def upper(live):
        return sh_y + (live - LIVE['shoulder']) / (LIVE['top'] - LIVE['shoulder']) * (H - sh_y)

    # 躯干的 z：这一高度、不在手臂里的点的截面中点
    Wg = np.stack([(W[:, 0] + xoff) * H, W[:, 1] * H, (W[:, 2] + zoff) * H], 1)

    def zmid(yy, w=0.02):
        sl = (arm_of == 0) & (np.abs(Wg[:, 1] - yy) < w) & (np.abs(Wg[:, 0]) < 0.12)
        return float(_mid(Wg[sl][:, 2:3])[0]) if sl.sum() > 8 else 0.0

    src = {}
    for n in ('pelvis', 'spine_01', 'spine_02', 'spine_03'):
        yy = trunk(LIVE[n])
        if n == 'pelvis':
            yy = hip_y + o.get('pelvis_up', 0.03)  # 骨盆在两胯稍上（现网 Adventurer 的骨盆在胯下面，是那个模型自己的怪处，不照搬）
        src[n] = np.array([0.0, yy, zmid(yy)])
    # spine_01 放在骨盆和 spine_02 中间偏下（按比例插会贴着骨盆）
    yy = src['pelvis'][1] + o.get('spine01_frac', 0.45) * (src['spine_02'][1] - src['pelvis'][1])
    src['spine_01'] = np.array([0.0, yy, zmid(yy)])
    for n in ('neck_01', 'Head'):
        yy = upper(LIVE[n])
        src[n] = np.array([0.0, yy, zmid(yy, 0.012)])
    src['head_leaf'] = np.array([0.0, H, src['Head'][2]])
    for s, sg in (('l', 1), ('r', -1)):
        A = lm[s]
        src['upperarm_' + s] = g(A['shoulder'])
        src['clavicle_' + s] = np.array([sg * o.get('clavicle_x', 0.03), src['upperarm_' + s][1] - 0.035, src['spine_03'][2] + 0.02])
        src['lowerarm_' + s] = g(A['elbow'])
        src['hand_' + s] = g(A['wrist'])
        d, lat, fwd = A['axis'], A['lat'], A['fwd']
        Lh = A['hand_len'] * H
        wdt = o.get('finger_spread', 0.018)
        offs = {'index': 1.0, 'middle': 0.0, 'ring': -1.0, 'pinky': -2.0}
        # 食指在拇指那一侧（沿指节线）
        kl = A['knuckle']
        if A['thumb'] is not None and (np.asarray(A['thumb'][0]) - A['wrist']) @ kl < 0:
            kl = -kl
        for f, k_ in offs.items():
            for k in (1, 2, 3):
                p = g(A['seg']['k%d' % k]) + kl * (wdt * k_)
                src['%s_0%d_%s' % (f, k, s)] = p
        if A['thumb'] is not None:
            for k in (1, 2, 3):
                src['thumb_0%d_%s' % (k, s)] = g(A['thumb'][k - 1])
        else:
            for k in (1, 2, 3):
                src['thumb_0%d_%s' % (k, s)] = src['hand_' + s] + d * (0.15 * k * Lh) + fwd * 0.03
        src['thigh_' + s] = g(A['hip'])
        src['calf_' + s] = g(A['knee'])
        src['foot_' + s] = g(A['ankle'])
        src['ball_' + s] = g(A['ball'])
        # 末端骨骼（游魂的骨骼集合要）：指尖 = 第三节再顺着往外一节；脚尖 = 脚掌最前端（贴地那一圈里 z 最大的点）
        for f in ('thumb', 'index'):
            a, b = src['%s_02_%s' % (f, s)], src['%s_03_%s' % (f, s)]
            src['%s_04_%s' % (f, s)] = b + (b - a)
        bl = src['ball_' + s]
        ft = (np.abs(Wg[:, 0] - bl[0]) < 0.07) & (Wg[:, 1] < bl[1] + 0.05) & (Wg[:, 2] > bl[2])
        tip = float(Wg[ft, 2].max()) if ft.sum() else bl[2] + 0.06
        src['ball_leaf_' + s] = np.array([bl[0], bl[1], max(tip, bl[2] + 0.02)])
    for n, p in o.get('pivots', {}).items():
        if n not in src:
            raise RuntimeError('fit.pivots：没有骨骼 ' + n)
        src[n] = np.array(p, dtype=np.float64)
    scale = H / h
    offset = np.array([(-cx / h + xoff) * H, -y0 / h * H, (-cz / h + zoff) * H])
    return dict(scale=scale, offset=offset, height=H, src=src, lm=lm, arm=arm_of, t=t_of * H, unit=dict(cx=cx, cz=cz, y0=y0, h=h),
                W=Wg, WF=WF, inv=inv, keep=keep)


def to_source(p, f):
    return (np.asarray(p) - f['offset']) / f['scale']


def skeleton_txt(f, name, native=True, rig='hero'):
    """骨架文本（golem 的格式）：名字 父骨骼 x y z；native = 源 GLB 自己的坐标，否则游戏坐标（米）；rig = 骨骼集合（rig_bones）"""
    k = 1.0 / f['scale']
    bs = rig_bones(rig)
    head = ['# %s fitted %s skeleton (%d bones, UE / UAL standard names; art/ai/hero_fit.py). Columns: name parent x y z ("-" = root).' % (name, rig, len(bs)),
            '# glTF axes: +Y up, +Z forward (the model faces +Z), +X = the model\'s own left. Pose: the source mesh\'s own A-pose.']
    if native:
        head.append('# Units: the SOURCE model.glb\'s own coordinates (overlays it as-is). Game metres = source * %.6f + (%.6f, %.6f, %.6f).' % (f['scale'], *f['offset']))
    else:
        head.append('# Units: game metres (feet on y = 0, hips at x = z = 0, height %.2f). Source = (game - offset) * %.6f.' % (f['height'], k))
    out = []
    for n, p in bs:
        q = to_source(f['src'][n], f) if native else f['src'][n]
        out.append('%s %s %.6f %.6f %.6f' % (n, p or '-', q[0], q[1], q[2]))
    return '\n'.join(head + out) + '\n'


def predeform(V, F, spec):
    """源网格的脚本修形（spec['shape']），在对骨架之前做，返回 (新顶点（源坐标）, 变形函数 g(源坐标顶点) → 源坐标顶点, 记录)。
    变形只按位置算，同一个函数套到 UniRig 的权重网格上，权重照样贴得住。先做一遍 fit 找枢轴（游戏坐标，米）：
      head_scale：头（下颌枢轴 neck_01 以上）绕 neck_01 等比缩放，围巾那一段（neck_01 往下 head_band）渐变；
      leg_stretch：踝到胯之间的一段竖向拉长（靴子、脚不变），上面整体抬高；
      knee_flatten：护膝（膝的高度 ± knee_band、腿的前半圈）离腿轴的距离超出腿半径的部分压到 1 − knee_flatten；
    做完以后网格高度变了，后面的 fit 会重新缩放到 spec.fit.height。"""
    sh = (spec or {}).get('shape', {})
    if not sh:
        return np.asarray(V, dtype=np.float64), (lambda X: np.asarray(X, dtype=np.float64)), {}
    f0 = fit(V, F, spec)
    S = f0['src']
    sc, off = f0['scale'], f0['offset']
    rec = {}
    # 腿半径：膝上下两段截面到腿轴的距离中位数
    knees = {}
    for s in 'lr':
        k = S['calf_' + s]
        W = f0['W']
        sgn = 1 if s == 'l' else -1
        rs = []
        for dy in (-0.09, 0.09):
            sl = (sgn * W[:, 0] > 0.02) & (np.abs(W[:, 1] - (k[1] + dy)) < 0.012) & (f0['arm'] == 0) & (W[:, 2] > k[2] - 0.02)
            if sl.sum() > 6:
                rs.append(float(np.median(np.hypot(W[sl, 0] - k[0], W[sl, 2] - k[2]))))
        knees[s] = (k, float(np.mean(rs)) if rs else 0.07)
    rec['knee_r'] = {s: round(knees[s][1], 4) for s in 'lr'}

    def g(X):
        X = np.asarray(X, dtype=np.float64)
        P = X * sc + off
        y = P[:, 1].copy()
        kf = sh.get('knee_flatten')
        if kf:
            band = sh.get('knee_band', 0.07)
            for s, sgn in (('l', 1), ('r', -1)):
                k, R = knees[s]
                m = (sgn * P[:, 0] > 0.02) & (np.abs(y - k[1]) < band) & (P[:, 2] > k[2] - 0.02)
                dx, dz = P[m, 0] - k[0], P[m, 2] - k[2]
                r = np.hypot(dx, dz)
                fall = 1 - np.abs(y[m] - k[1]) / band
                fall = fall * fall * (3 - 2 * fall)
                rn = np.where(r > R, R + (r - R) * (1 - kf * fall), r)
                q = np.where(r > 1e-9, rn / np.maximum(r, 1e-9), 1.0)
                P[m, 0] = k[0] + dx * q
                P[m, 2] = k[2] + dz * q
        hs = sh.get('head_scale')
        if hs:
            pv = S['neck_01']
            hb = sh.get('head_band', 0.06)
            t = np.clip((y - (pv[1] - hb)) / hb, 0, 1)
            t = t * t * (3 - 2 * t)
            m = (t > 0) & (np.abs(P[:, 0]) < sh.get('head_x', 0.2))
            k = 1 + (hs - 1) * t[m]
            P[m] = pv + (P[m] - pv) * k[:, None]
        ls = sh.get('leg_stretch')
        if ls:
            a = 0.5 * (S['foot_l'][1] + S['foot_r'][1]) + sh.get('stretch_above_ankle', 0.05)
            h = 0.5 * (S['thigh_l'][1] + S['thigh_r'][1])
            yy = P[:, 1]
            P[:, 1] = np.where(yy <= a, yy, np.where(yy <= h, a + (yy - a) * ls, yy + (h - a) * (ls - 1)))
        return (P - off) / sc

    V2 = g(V)
    rec.update(shape=sh, height_before=round(float((V[:, 1].max() - V[:, 1].min()) * sc), 4), height_after_unscaled=round(float((V2[:, 1].max() - V2[:, 1].min()) * sc), 4))
    return V2, g, rec
