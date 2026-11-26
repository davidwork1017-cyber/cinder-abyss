// AI 主角试验（ai3d-hero，试验分支，不上线）：网址带 ?aihero=<候选> 时 index.html 才引入这个文件，平时整段不加载。
// 同步取 art/ai/hero/out/<候选>/hero_<候选>_<mode>_{hi,lo}.glb（mode：&aimode=，缺省 hybrid），打成 base64 放进 CA_ASSETS.chars.models.aihero_hi / aihero_lo，
// world.js 建主角骨架时按画质挑一档（低 → lo），套用 CSPEC.player 的双胞胎 playerAI（同一副程序化骨架、同样的动作 / 挂点 / 模拟，只换外观）。
// 取不到文件就什么都不做，主角照旧用现网的模型。
(function () {
  const q = new URLSearchParams(location.search);
  const cand = q.get('aihero');
  if (!cand || !/^[a-z0-9-]+$/.test(cand)) return;
  const mode = /^(band|hybrid)$/.test(q.get('aimode') || '') ? q.get('aimode') : 'hybrid';
  const get = (url) => {
    try {
      const x = new XMLHttpRequest();
      x.open('GET', url, false);
      x.overrideMimeType('text/plain; charset=x-user-defined');
      x.send(null);
      if (x.status !== 200 && x.status !== 0) return null;
      const s = x.responseText;
      let b = '';
      for (let i = 0; i < s.length; i += 0x8000) b += String.fromCharCode.apply(null, Array.from(s.slice(i, i + 0x8000), (c) => c.charCodeAt(0) & 0xff));
      return btoa(b);
    } catch (e) {
      return null;
    }
  };
  const st = (window.CA_ASSETS = window.CA_ASSETS || {}).chars;
  if (!st || !st.models) return;
  const base = 'art/ai/hero/out/' + cand + '/hero_' + cand + '_' + mode + '_';
  const hi = get(base + 'hi.glb'), lo = get(base + 'lo.glb');
  if (!hi) {
    if (window.console) console.warn('[角色] AI 主角试验：取不到 ' + base + 'hi.glb，用现网主角');
    return;
  }
  st.models.aihero_hi = hi;
  st.models.aihero_lo = lo || hi;
  window.CA_AI_HERO = { cand, mode };
  // Kimodo 试验动作（&aimotion=1）：文件不在仓库里，只有试验脚本把 lab-motion/<动作>.glb 路由到私有源目录时才取得到
  if (q.get('aimotion')) {
    let n = 0;
    for (const m of ['idle', 'run', 'slash', 'backhand']) {
      const b = get('lab-motion/' + m + '.glb');
      if (b) { st.models['aim_' + m] = b; n++; }
    }
    if (n) window.CA_AI_MOTION = true;
  }
})();
