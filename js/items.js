'use strict';
// 物品：生成、词缀、命名、属性汇总、通货打造、分解。纯逻辑，不碰 DOM / THREE。
(function () {
  const G = window.G;

  // 各稀有度的词缀上限：[前缀, 后缀, 总数]
  const LIMITS = [
    [0, 0, 0], // 普通
    [1, 1, 2], // 魔法
    [3, 3, 6], // 稀有
    [0, 0, 0], // 烬铸：词缀行固定，什么也加不上
    [0, 0, 0], // 渊契：同上
  ];

  let uidCounter = 0;
  function newUid() {
    uidCounter += 1;
    // 时间戳 + 计数 + 随机段：跨存档、跨会话也不会撞
    return 'i' + Date.now().toString(36) + uidCounter.toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  function countType(item, type) {
    let n = 0;
    for (const af of item.affixes) if (G.AFFIX_BY_ID[af.id].type === type) n += 1;
    return n;
  }

  // 该物品等级下可用的最高词缀阶（0 起）
  function maxTier(ilvl) {
    let t = 0;
    for (let i = 0; i < G.TIER_ILVL.length; i++) if (G.TIER_ILVL[i] <= ilvl) t = i;
    return t;
  }

  // 在可用的最高 3 阶里等概率取一阶
  function rollTier(ilvl) {
    const hi = maxTier(ilvl);
    return G.randInt(Math.max(0, hi - 2), hi);
  }

  // 某词缀在某阶的数值区间 [lo, hi]
  function tierRange(def, tier) {
    const hi = Math.max(0, tier - G.SOFT_TIER);
    const k = Math.pow(def.g, tier - hi) * Math.pow(def.soft ? Math.sqrt(def.g) : def.g, hi);
    const lo = Math.round(def.lo * k);
    return [lo, Math.max(lo, Math.round(def.hi * k))];
  }
  G.affixRange = tierRange;

  function rollValue(def, tier) {
    const r = tierRange(def, tier);
    return G.randInt(r[0], r[1]);
  }

  // 按给定稀有度计算还能上的词缀（rarity 单独传入，方便在真正改物品之前预判）
  function eligibleAffixes(item, rarity, excludeId) {
    const lim = LIMITS[rarity];
    if (item.affixes.length >= lim[2]) return [];
    const prefixRoom = countType(item, 'prefix') < lim[0];
    const suffixRoom = countType(item, 'suffix') < lim[1];
    const out = [];
    for (const def of G.AFFIXES) {
      if (def.id === excludeId) continue;
      if (def.slots.indexOf(item.slot) < 0) continue;
      if (def.type === 'prefix' ? !prefixRoom : !suffixRoom) continue;
      if ((def.minIlvl && item.ilvl < def.minIlvl) || (def.rareOnly && rarity < 2)) continue; // 高阶稀有词缀
      if (affixW(def, item) <= 0) continue;
      let dup = false;
      for (const af of item.affixes) if (af.id === def.id) dup = true;
      if (!dup) out.push(def);
    }
    return out;
  }

  // 前缀排在后缀之前，同类保持加入顺序
  function insertAffix(item, def) {
    const af = { id: def.id, tier: rollTier(item.ilvl), v: 0 };
    af.v = rollValue(def, af.tier);
    let at = item.affixes.length;
    if (def.type === 'prefix') {
      at = 0;
      while (at < item.affixes.length && G.AFFIX_BY_ID[item.affixes[at].id].type === 'prefix') at += 1;
    }
    item.affixes.splice(at, 0, af);
  }

  // 词缀在这件物品上的出现权重：baseW 按基底（BASES 下标）再乘一个系数
  function affixW(def, item) {
    const bw = def.baseW && def.baseW[item.slot];
    return def.w * (bw && bw[item.baseIdx] !== undefined ? bw[item.baseIdx] : 1);
  }

  function addFrom(item, list) {
    if (!list.length) return false;
    insertAffix(item, G.weighted(list, (d) => affixW(d, item)));
    G.refreshWeapon(item);
    G.updateItemName(item);
    return true;
  }

  // ---------- 武器伤害 ----------
  // 名称阶：物品等级 1–5 / 6–11 / 12+ → 0 / 1 / 2（基底的三个名字）
  G.nameTier = (ilvl) => (ilvl < 6 ? 0 : ilvl < 12 ? 1 : 2);

  // 某个武器基底在某个物品等级下的基础伤害区间（本地词缀之前）；q 是成色（缺省 1 = 平均）
  // 物品等级带来的武器伤害倍率：1 + WEAPON_LVL × (等级 − 1)，等级封顶 WEAPON_LVL_CAP
  G.weaponLvlK = (ilvl) => 1 + G.WEAPON_LVL * (G.clamp(Math.round(ilvl) || 1, 1, G.WEAPON_LVL_CAP) - 1);
  G.weaponBaseDmg = function (baseIdx, ilvl, q) {
    const base = G.BASES.weapon[baseIdx] || G.BASES.weapon[0];
    const k = G.weaponLvlK(ilvl) * (q === undefined ? 1 : q);
    const lo = Math.max(1, Math.round(base.dmg[0] * k));
    return [lo, Math.max(lo + 1, Math.round(base.dmg[1] * k))];
  };

  // 本地附加的区间：和词缀文本「附加 a–b」显示的数字一致
  const addRange = (v) => [Math.max(1, Math.round(v * 0.7)), Math.max(2, Math.round(v * 1.3))];

  // 按基础伤害 wbase 和本地词缀重算武器的 dmg（[最小, 最大]，已含本地词缀）与 aps。
  // 词缀有增减（打造、重铸）后都要调用；不是武器时什么也不做
  G.refreshWeapon = function (item) {
    if (!item || item.slot !== 'weapon') return item;
    const base = G.BASES.weapon[item.baseIdx] || G.BASES.weapon[0];
    if (!Array.isArray(item.wbase)) item.wbase = G.weaponBaseDmg(item.baseIdx, item.ilvl);
    let inc = 0;
    let addLo = 0;
    let addHi = 0;
    for (const af of item.affixes) {
      const stat = G.AFFIX_BY_ID[af.id].stat;
      if (stat === 'wInc') inc += af.v;
      else if (stat === 'wAdd') {
        const r = addRange(af.v);
        addLo += r[0];
        addHi += r[1];
      }
    }
    const k = 1 + inc / 100;
    const lo = Math.max(1, Math.round((item.wbase[0] + addLo) * k));
    item.dmg = [lo, Math.max(lo, Math.round((item.wbase[1] + addHi) * k))];
    item.aps = base.aps;
    return item;
  };

  // 武器面板：{ min, max, aps, dps（平均伤害 × 攻速）, type }。不传武器（空手）时是拳头，type 为 null、fists 为 true
  G.weaponStats = function (item) {
    if (!item || item.slot !== 'weapon') {
      const F = G.FISTS;
      return { min: F.min, max: F.max, aps: F.aps, dps: ((F.min + F.max) / 2) * F.aps, type: null, fists: true };
    }
    if (!Array.isArray(item.dmg) || !(item.aps > 0)) G.refreshWeapon(item);
    const base = G.BASES.weapon[item.baseIdx] || G.BASES.weapon[0];
    const min = item.dmg[0];
    const max = item.dmg[1];
    return { min, max, aps: item.aps, dps: ((min + max) / 2) * item.aps, type: base.type, fists: false };
  };

  function isRareName(name) {
    if (typeof name !== 'string') return false;
    for (const a of G.RARE_A) {
      if (name.indexOf(a) === 0 && G.RARE_B.indexOf(name.slice(a.length)) >= 0) return true;
    }
    return false;
  }

  // ---------- 生成 ----------
  // 隐含属性的数值：一般随物品等级放大；fixed 的不放大，带 step 的每 step 物品等级 +1（封顶再 +1）
  function rollImp(imp, ilvl) {
    if (imp.fixed) return G.randInt(imp.lo, imp.hi) + (imp.step ? Math.min(1, Math.floor(ilvl / imp.step)) : 0);
    return Math.round(G.rand(imp.lo, imp.hi) * (1 + ilvl * 0.06));
  }

  // baseIdx（可选）：指定基底，缺省随机
  G.rollItem = function (ilvl, rarity, slot, baseIdx) {
    ilvl = Math.max(1, Math.round(ilvl) || 1);
    rarity = G.clamp(Math.round(rarity) || 0, 0, 2);
    if (!slot) slot = G.pick(G.SLOTS);
    const bases = G.BASES[slot];
    // 随机基底按 drop 权重（缺省 1）：武器里魂幡稍少（0.8），其余一样多，起步区域也是各类武器混着出
    if (!(baseIdx >= 0 && baseIdx < bases.length) || baseIdx !== Math.floor(baseIdx)) baseIdx = bases.indexOf(G.weighted(bases, (b) => (b.drop === undefined ? 1 : b.drop)));
    const base = bases[baseIdx];
    const nameIdx = Math.min(G.nameTier(ilvl), base.names.length - 1);

    const item = {
      uid: newUid(),
      slot,
      baseIdx,
      baseName: base.names[nameIdx],
      name: base.names[nameIdx],
      rarity,
      ilvl,
      armour: base.armour ? Math.round(base.armour[0] + base.armour[1] * ilvl) : 0,
      imp: base.imp ? { stat: base.imp.stat, v: rollImp(base.imp, ilvl) } : null,
      affixes: [],
    };
    // 武器：基础伤害按物品等级成长，再乘 0.9–1.1 的成色；dmg / aps 由 refreshWeapon 推出来
    if (slot === 'weapon') {
      item.wbase = G.weaponBaseDmg(baseIdx, ilvl, G.rand(0.9, 1.1));
      G.refreshWeapon(item);
    }

    const want = rarity === 2 ? G.randInt(3, 5) : rarity === 1 ? G.randInt(1, 2) : 0;
    while (item.affixes.length < want && G.addAffix(item)) { /* 加到够数或没有可用词缀为止 */ }
    G.updateItemName(item);
    return item;
  };

  G.addAffix = function (item) {
    return addFrom(item, eligibleAffixes(item, item.rarity, null));
  };

  // ---------- 烬铸武器 ----------
  // 第 i 条词缀行在这件物品上的区间 [lo, hi]：取这条词缀在物品等级最高阶的区间，乘上该行的 k（fixed 行是 [v, v]）。
  // 不存档：由烬铸 id 和物品等级推出来（读档时据此把数值修回区间里）
  G.uniqueLineRange = function (uq, ilvl, i) {
    return lineRange(G.UNIQUES[uq], ilvl, i);
  };
  // 烬铸和渊契共用：def 是 G.UNIQUES / G.RELICS 里的一项
  function lineRange(U, ilvl, i) {
    const ln = U && U.lines[i];
    if (!ln) return [0, 0];
    if (ln.fixed !== undefined) return [ln.fixed, ln.fixed];
    const r = tierRange(G.AFFIX_BY_ID[ln.id], maxTier(ilvl));
    const lo = Math.max(1, Math.round(r[0] * ln.k[0]));
    return [lo, Math.max(lo, Math.round(r[1] * ln.k[1]))];
  }
  G.relicLineRange = (rq, ilvl, i) => lineRange(G.RELICS[rq], ilvl, i);
  // 渊契（rarity 4）按 rq 查 G.RELICS，其余按 uq 查 G.UNIQUES
  const fixedDef = (item) => (!item ? null : item.rarity === 4 ? G.RELICS[item.rq] : G.UNIQUES[item.uq]);
  G.uniqueRange = (item, i) => lineRange(fixedDef(item), item.ilvl, i);
  // 完美度（0..1）：每条非固定词缀行的数值在自己区间里的位置，取平均（烬铸、渊契通用）
  G.uniquePerfect = function (item) {
    const U = fixedDef(item);
    if (!U) return 0;
    let sum = 0;
    let n = 0;
    U.lines.forEach((ln, i) => {
      if (ln.fixed !== undefined) return;
      const af = item.affixes[i];
      const r = G.uniqueRange(item, i);
      if (!af) return;
      sum += r[1] > r[0] ? G.clamp((af.v - r[0]) / (r[1] - r[0]), 0, 1) : 1;
      n++;
    });
    return n ? sum / n : 1;
  };
  // 掷一件烬铸武器。q（可选，0..1）：每条词缀行都取区间里这个位置（测试 / 调试用），缺省各自随机
  G.rollUnique = function (uq, ilvl, q) {
    const U = G.UNIQUES[uq];
    if (!U) return null;
    ilvl = Math.max(1, Math.round(ilvl) || 1);
    const base = G.BASES.weapon[U.base];
    const nameIdx = Math.min(G.nameTier(ilvl), base.names.length - 1);
    const item = {
      uid: newUid(), slot: 'weapon', baseIdx: U.base, baseName: base.names[nameIdx], name: U.name,
      rarity: 3, uq, ilvl, armour: 0,
      imp: base.imp ? { stat: base.imp.stat, v: rollImp(base.imp, ilvl) } : null,
      affixes: [],
    };
    const tier = maxTier(ilvl);
    U.lines.forEach((ln, i) => {
      const r = G.uniqueLineRange(uq, ilvl, i);
      const v = q === undefined ? G.randInt(r[0], r[1]) : Math.round(r[0] + (r[1] - r[0]) * G.clamp(q, 0, 1));
      item.affixes.push({ id: ln.id, tier, v });
    });
    item.wbase = G.weaponBaseDmg(U.base, ilvl, G.UNIQUE_BASE_Q);
    G.refreshWeapon(item);
    return item;
  };

  // ---------- 渊契 ----------
  // 掷一件渊契（稀有度 4）：部位、基底、名字、词缀行都按 G.RELICS 定；护甲 / 隐含属性按这个基底和物品等级照常算。q 同 rollUnique
  G.rollRelic = function (rq, ilvl, q) {
    const R = G.RELICS[rq];
    if (!R) return null;
    ilvl = Math.max(1, Math.round(ilvl) || 1);
    const base = G.BASES[R.slot][R.base];
    const nameIdx = Math.min(G.nameTier(ilvl), base.names.length - 1);
    const item = {
      uid: newUid(), slot: R.slot, baseIdx: R.base, baseName: base.names[nameIdx], name: R.name,
      rarity: 4, rq, ilvl,
      armour: base.armour ? Math.round(base.armour[0] + base.armour[1] * ilvl) : 0,
      imp: base.imp ? { stat: base.imp.stat, v: rollImp(base.imp, ilvl) } : null,
      affixes: [],
    };
    if (R.rqv) item.rqv = R.rqv; // 渊契改版：新掉的物品直接记成新版，读档时不再迁移
    const tier = maxTier(ilvl);
    R.lines.forEach((ln, i) => {
      const r = lineRange(R, ilvl, i);
      const v = q === undefined ? G.randInt(r[0], r[1]) : Math.round(r[0] + (r[1] - r[0]) * G.clamp(q, 0, 1));
      item.affixes.push({ id: ln.id, tier, v });
    });
    return item;
  };

  // ---------- 命名 ----------
  G.updateItemName = function (item) {
    if (item.rarity === 4) {
      if (G.RELICS[item.rq]) item.name = G.RELICS[item.rq].name;
      return;
    }
    if (item.rarity === 3) {
      if (G.UNIQUES[item.uq]) item.name = G.UNIQUES[item.uq].name;
      return;
    }
    if (item.rarity === 2) {
      if (!isRareName(item.name)) item.name = G.pick(G.RARE_A) + G.pick(G.RARE_B);
      return;
    }
    let name = item.baseName;
    if (item.rarity === 1) {
      let pre = '';
      let suf = '';
      for (const af of item.affixes) {
        const def = G.AFFIX_BY_ID[af.id];
        if (def.type === 'prefix') { if (!pre) pre = def.label; } else if (!suf) suf = def.label;
      }
      if (pre) name = pre + '的' + name;
      if (suf) name = name + '·' + suf;
    }
    item.name = name;
  };

  // ---------- 属性与文本 ----------
  // 隐含属性附带的第二条（魂幡：召唤物伤害之外再给一点召唤物生命）：由基底推出来，不存档。没有时 null
  G.impAlso = function (item) {
    const bases = item && item.imp && G.BASES[item.slot];
    const bi = bases && bases[item.baseIdx] && bases[item.baseIdx].imp;
    if (!bi || !bi.also || bi.stat !== item.imp.stat) return null;
    return { stat: bi.also.stat, v: Math.max(1, Math.round(item.imp.v * bi.also.k)) };
  };

  G.itemStats = function (item) {
    const s = {};
    if (item.armour) s.armour = item.armour;
    if (item.imp) s[item.imp.stat] = (s[item.imp.stat] || 0) + item.imp.v;
    const also = G.impAlso(item);
    if (also) s[also.stat] = (s[also.stat] || 0) + also.v;
    for (const af of item.affixes) {
      const stat = G.AFFIX_BY_ID[af.id].stat;
      if (G.LOCAL_STATS[stat]) continue; // 武器本地词缀已经算在武器伤害里
      s[stat] = (s[stat] || 0) + af.v;
    }
    return s;
  };

  // weapon：武器面板（G.weaponStats），不是武器时为 null；词缀行的 local 表示本地词缀。
  // imp 是隐含属性的整行文本（魂幡这种带第二条的用「，」连起来），imps 是逐条的文本
  G.itemLines = function (item) {
    const imps = [];
    if (item.imp) imps.push(G.fmtStat(item.imp.stat, item.imp.v));
    const also = G.impAlso(item);
    if (also) imps.push(G.fmtStat(also.stat, also.v));
    return {
      weapon: item.slot === 'weapon' ? G.weaponStats(item) : null,
      armour: item.armour || 0,
      imp: imps.length ? imps.join('，') : null,
      imps,
      affixes: item.affixes.map(function (af) {
        const def = G.AFFIX_BY_ID[af.id];
        return { text: G.fmtStat(def.stat, af.v), type: def.type, tier: af.tier + 1, local: !!def.local };
      }),
    };
  };

  // ---------- 打造 ----------
  // 琢刻石：第 idx 条词缀能换成的同类词缀（同为前缀或同为后缀，适用部位 / 物品等级 / 稀有度限制照旧，
  // 不和其他词缀重复，也不会洗回它自己）。拿掉这一条正好空出一个同类位置
  function chiselPool(item, idx) {
    const af = item.affixes[idx];
    if (!af || item.rarity < 1) return [];
    const type = G.AFFIX_BY_ID[af.id].type;
    const rest = { slot: item.slot, baseIdx: item.baseIdx, ilvl: item.ilvl, affixes: item.affixes.filter((a, i) => i !== idx) };
    return eligibleAffixes(rest, item.rarity, af.id).filter((d) => d.type === type);
  }
  // 每条词缀能不能用琢刻石重洗：[true, false, ...]
  G.chiselable = function (item) {
    return item && item.affixes ? item.affixes.map((a, i) => chiselPool(item, i).length > 0) : [];
  };

  // 返回不能使用的原因（中文），可以使用时返回 null
  function craftBlock(item, curId) {
    if (item.rarity === 3) return '烬铸武器无法改造'; // 所有通货（含琢刻石、重铸石）都不认它
    if (item.rarity === 4) return G.RELIC_NAME + '无法改造';
    const n = item.affixes.length;
    switch (curId) {
      case 'dust':
        if (item.rarity !== 0) return '只能用于普通物品';
        return eligibleAffixes(item, 1, null).length ? null : '这件物品没有可用的词缀';
      case 'augment':
        if (item.rarity !== 1 || n !== 1) return '只能用于只有 1 条词缀的魔法物品';
        return eligibleAffixes(item, 1, null).length ? null : '这件物品没有可追加的词缀';
      case 'alch':
        if (item.rarity !== 0) return '只能用于普通物品';
        return eligibleAffixes(item, 2, null).length ? null : '这件物品没有可用的词缀';
      case 'regal':
        if (item.rarity !== 1) return '只能用于魔法物品';
        return eligibleAffixes(item, 2, null).length ? null : '这件物品没有可追加的词缀';
      case 'exalt':
        if (item.rarity !== 2) return '只能用于稀有物品';
        if (n >= LIMITS[2][2]) return '词缀已满（最多 6 条）';
        return eligibleAffixes(item, 2, null).length ? null : '这件物品没有可追加的词缀';
      case 'chaos':
        if (item.rarity !== 2) return '只能用于稀有物品';
        return n >= 1 ? null : '这件物品没有可移除的词缀';
      case 'chisel':
        if (item.rarity < 1 || n < 1) return '只能用于带有词缀的魔法或稀有物品';
        return G.chiselable(item).some(Boolean) ? null : '这件物品的词缀都没有可换的同类词缀';
      case 'divine':
        if (item.rarity < 1 || n < 1) return '只能用于带有词缀的魔法或稀有物品';
        return null;
      default:
        return '无法使用这种通货';
    }
  }

  G.canCraft = function (item, curId) {
    return craftBlock(item, curId) === null;
  };

  // idx：琢刻石要重洗的那条词缀（item.affixes 的下标），其他通货不用
  G.craft = function (item, curId, idx) {
    const why = craftBlock(item, curId);
    if (why !== null) return { ok: false, msg: why };
    if (curId === 'chisel') {
      if (!(idx >= 0 && idx < item.affixes.length) || idx !== Math.floor(idx)) return { ok: false, msg: '先选一条要重洗的词缀' };
      if (!chiselPool(item, idx).length) return { ok: false, msg: '这条词缀没有可换的同类词缀' };
    }
    let msg = '';
    switch (curId) {
      case 'dust':
        item.rarity = 1;
        G.addAffix(item);
        msg = '已升为魔法物品';
        break;
      case 'augment':
        G.addAffix(item);
        msg = '已追加 1 条词缀';
        break;
      case 'alch':
        item.rarity = 2;
        while (item.affixes.length < 4 && G.addAffix(item)) { /* 补到 4 条 */ }
        msg = '已升为稀有物品';
        break;
      case 'regal':
        item.rarity = 2;
        G.addAffix(item);
        msg = '已升为稀有物品，并追加 1 条词缀';
        break;
      case 'exalt':
        G.addAffix(item);
        msg = '已追加 1 条词缀';
        break;
      case 'chaos': {
        const gone = item.affixes.splice(Math.floor(Math.random() * item.affixes.length), 1)[0];
        // 优先换成别的词缀；实在没有别的可选（如胸甲前缀池很小）才允许重新洗出同一条
        let list = eligibleAffixes(item, 2, gone.id);
        if (!list.length) list = eligibleAffixes(item, 2, null);
        addFrom(item, list);
        msg = '已替换 1 条词缀';
        break;
      }
      case 'chisel': {
        // 原地换掉这一条：新词缀放在同一个位置，其他词缀的顺序、阶和数值都不动
        const def = G.weighted(chiselPool(item, idx), (d) => affixW(d, item));
        const af = { id: def.id, tier: rollTier(item.ilvl), v: 0 };
        af.v = rollValue(def, af.tier);
        item.affixes[idx] = af;
        msg = '已重洗 1 条' + (def.type === 'prefix' ? '前缀' : '后缀');
        break;
      }
      case 'divine': {
        // 在各自的阶内重掷；整体结果与原来完全相同时再掷几次，避免白白消耗
        const before = item.affixes.map((af) => af.v).join(',');
        for (let i = 0; i < 12; i++) {
          for (const af of item.affixes) af.v = rollValue(G.AFFIX_BY_ID[af.id], af.tier);
          if (item.affixes.map((af) => af.v).join(',') !== before) break;
        }
        msg = '词缀数值已重铸';
        break;
      }
    }
    G.refreshWeapon(item); // 本地词缀变了：武器伤害跟着重算
    G.updateItemName(item);
    return { ok: true, msg };
  };

  // ---------- 分解与随机表 ----------
  G.salvageResult = function (item) {
    const out = {};
    if (item.rarity === 3) {
      Object.assign(out, G.UNIQUE_SALVAGE); // 固定的一把高阶通货（要确认两次才分得掉，见界面）
    } else if (item.rarity === 4) {
      Object.assign(out, G.RELIC_SALVAGE);
    } else if (item.rarity === 1) {
      if (Math.random() < 0.5) out.dust = 1;
    } else if (item.rarity === 2) {
      out.augment = 1;
      if (Math.random() < 0.3) out.regal = 1;
      if (Math.random() < G.SALVAGE_RARE_HI) out[Math.random() < 0.5 ? 'exalt' : 'chaos'] = 1;
    }
    return out;
  };

  G.rollRarity = function (mult) {
    const r = Math.random() / (mult > 0 ? mult : 1);
    return r < 0.08 ? 2 : r < 0.4 ? 1 : 0;
  };

  G.rollCurrency = function () {
    return G.weighted(G.CUR_IDS, (id) => G.CURRENCY[id].w);
  };
})();
