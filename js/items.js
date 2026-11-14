'use strict';
// 物品：生成、词缀、命名、属性汇总、通货打造、分解。纯逻辑，不碰 DOM / THREE。
(function () {
  const G = window.G;

  // 各稀有度的词缀上限：[前缀, 后缀, 总数]
  const LIMITS = [
    [0, 0, 0], // 普通
    [1, 1, 2], // 魔法
    [3, 3, 6], // 稀有
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
    const k = Math.pow(def.g, tier);
    const lo = Math.round(def.lo * k);
    return [lo, Math.max(lo, Math.round(def.hi * k))];
  }

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
  G.weaponBaseDmg = function (baseIdx, ilvl, q) {
    const base = G.BASES.weapon[baseIdx] || G.BASES.weapon[0];
    const L = G.clamp(Math.round(ilvl) || 1, 1, G.WEAPON_LVL_CAP);
    const k = (1 + G.WEAPON_LVL * (L - 1)) * (q === undefined ? 1 : q);
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

  // ---------- 命名 ----------
  G.updateItemName = function (item) {
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
    if (item.rarity === 1) {
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
