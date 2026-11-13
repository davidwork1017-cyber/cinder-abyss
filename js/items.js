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

  function addFrom(item, list) {
    if (!list.length) return false;
    insertAffix(item, G.weighted(list, (d) => d.w));
    G.updateItemName(item);
    return true;
  }

  function isRareName(name) {
    if (typeof name !== 'string') return false;
    for (const a of G.RARE_A) {
      if (name.indexOf(a) === 0 && G.RARE_B.indexOf(name.slice(a.length)) >= 0) return true;
    }
    return false;
  }

  // ---------- 生成 ----------
  G.rollItem = function (ilvl, rarity, slot) {
    ilvl = Math.max(1, Math.round(ilvl) || 1);
    rarity = G.clamp(Math.round(rarity) || 0, 0, 2);
    if (!slot) slot = G.pick(G.SLOTS);
    const bases = G.BASES[slot];
    const baseIdx = Math.floor(Math.random() * bases.length);
    const base = bases[baseIdx];
    const nameIdx = Math.min(ilvl < 6 ? 0 : ilvl < 12 ? 1 : 2, base.names.length - 1);

    const item = {
      uid: newUid(),
      slot,
      baseIdx,
      baseName: base.names[nameIdx],
      name: base.names[nameIdx],
      rarity,
      ilvl,
      armour: base.armour ? Math.round(base.armour[0] + base.armour[1] * ilvl) : 0,
      imp: base.imp ? { stat: base.imp.stat, v: Math.round(G.rand(base.imp.lo, base.imp.hi) * (1 + ilvl * 0.06)) } : null,
      affixes: [],
    };

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
  G.itemStats = function (item) {
    const s = {};
    if (item.armour) s.armour = item.armour;
    if (item.imp) s[item.imp.stat] = (s[item.imp.stat] || 0) + item.imp.v;
    for (const af of item.affixes) {
      const stat = G.AFFIX_BY_ID[af.id].stat;
      s[stat] = (s[stat] || 0) + af.v;
    }
    return s;
  };

  G.itemLines = function (item) {
    return {
      armour: item.armour || 0,
      imp: item.imp ? G.fmtStat(item.imp.stat, item.imp.v) : null,
      affixes: item.affixes.map(function (af) {
        const def = G.AFFIX_BY_ID[af.id];
        return { text: G.fmtStat(def.stat, af.v), type: def.type, tier: af.tier + 1 };
      }),
    };
  };

  // ---------- 打造 ----------
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

  G.craft = function (item, curId) {
    const why = craftBlock(item, curId);
    if (why !== null) return { ok: false, msg: why };
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
