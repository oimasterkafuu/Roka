'use strict';
// 敌方跳板纵队拦截（2026-09-28 用户硬方针 + 二之补充 + 二之二补充）：敌方也在用
// 「走一步搭一个跳板」深入我方腹地。本模块识别「深入我控区且头部仍在推进的敌连通
// 纵队」，主动攻击，而不是等它走到皇冠才背水。截断有效性的统一判断标准：
// 「打掉尾部能否阻止头部继续推进」——
//   · 头部格本身是敌指挥所/皇冠（大部分时间以建筑为头）：头自带锚，对方是故意
//     放弃尾部，打尾部它照常推进——掐链无效，一律直接打头部（拆建筑推进即停）；
//   · 长纵队（深入块 ≥columnMinDepth 格）且头部非建筑：优先掐链（占住纵队与敌
//     主力之间的脖子，深入段断锚变孤军；连通判定与 cutoff.cjs 同一口径，出兵
//     方案直接复用 planChokeAttack），掐不动侧击纵队腰部削兵；
//   · 短促自耗型跳板（深入块只有一两个格、走一步身后自弃）：没有脖子可截，不
//     硬找切断点，直接用我方兵力迎头撞头部格（以兵换兵顶回去/磨掉）。
//
// 检测三要件（全部满足才出手）：
//   1. 深入：敌格被己方格包住（2 跳内我方格明显多于敌方格，与 cutoff 入侵截断
//      同一 embedded 口径）且离我方锚点 columnRange 跳内；
//   2. 成块：这样的深入格在同一敌连通块里相邻成块——≥columnMinDepth 格判为
//      长纵队（先掐链、掐不动侧击腰部），更短判为短促自耗型（迎头撞头部）；
//   3. 还在推进：头部（深入块中离我锚点最近的格）比上一 tick 更近了——
//      跨回合只记「上 tick 头部距离」这一个数，不做任何目标锁定。
// 与既有防御的优先级协调由 policy.cjs 调度决定：背水一战/皇冠告急仍最高，
// 本模块作为主动防御层插在其后；家里多路告急时 policy 跳过本模块。
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');
const { planChokeAttack } = require('./cutoff.cjs');

const columnMemory = new WeakMap();

function chooseColumnStrike(state, params = {}) {
  const ctx = createContext(state, params);
  if (!ctx) return null;
  const p = resolveParams(params);
  const { size, grid, owners, army, me, own, hostile, neighbors, passable, isolated, knownAt } = ctx;
  const turn = ctx.turn;
  if (!Number.isFinite(turn)) return null;

  // 我方锚点：「腹地」与「头部离我家多近」的参照。
  const myAnchors = [];
  for (let i = 0; i < size; i++) if (own(i) && (grid[i] === me + 100 || grid[i] === me + 50)) myAnchors.push(i);
  if (!myAnchors.length) return null;

  // 离我锚点的通行距离场（穿任何可通行格），columnRange 跳内才算「我控区周边」。
  const homeDistance = new Int32Array(size).fill(-1);
  {
    const q = [];
    for (const a of myAnchors) { homeDistance[a] = 0; q.push(a); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      if (homeDistance[i] >= p.columnRange) continue;
      for (const j of neighbors[i]) if (homeDistance[j] < 0 && passable(j)) { homeDistance[j] = homeDistance[i] + 1; q.push(j); }
    }
  }
  // 「深入我控区」：2 跳内我方格明显多于敌方格（与 cutoff 入侵截断同一口径）。
  function embedded(i) {
    const seen = new Set([i]);
    let mine = 0, theirs = 0, layer = [i];
    for (let d = 0; d < 2 && layer.length; d++) {
      const next = [];
      for (const u of layer) for (const v of neighbors[u]) {
        if (seen.has(v) || !passable(v)) continue;
        seen.add(v);
        if (own(v)) mine++;
        else if (hostile(v)) theirs++;
        next.push(v);
      }
      layer = next;
    }
    return mine >= 4 && mine >= theirs + 2;
  }

  // 敌队分组（引擎连通按队伍算，同队不同玩家的格子互相连通）。
  const teamOf = (o) => Number(state.teams instanceof Map ? state.teams.get(o) : state.teams?.[o]) || 0;
  const teams = new Map(); // key -> { tiles: number[], anchors: number[] }
  for (let i = 0; i < size; i++) {
    const o = owners[i];
    if (!(o > 0) || ctx.allied(o, me) || !knownAt(i)) continue;
    const t = teamOf(o);
    const key = t > 0 ? `t${t}` : `o${o}`;
    let entry = teams.get(key);
    if (!entry) { entry = { tiles: [], anchors: [] }; teams.set(key, entry); }
    entry.tiles.push(i);
    if (grid[i] === o + 50 || grid[i] === o + 100) entry.anchors.push(i);
  }
  if (!teams.size) return null;

  // 跨 tick 记忆：每队上一 tick 的「头部离我锚点距离」，仅用于推进判定。
  // turn 倒退视为新对局，清空重来。
  let mem = columnMemory.get(state);
  if (!mem) { mem = { turn: -1, heads: new Map(), prev: new Map() }; columnMemory.set(state, mem); }
  if (turn < mem.turn) { mem.heads = new Map(); mem.prev = new Map(); }
  if (mem.turn !== turn) { mem.prev = mem.heads; mem.heads = new Map(); mem.turn = turn; }

  let best = null;
  for (const [key, entry] of teams) {
    if (!entry.anchors.length) continue; // 没有锚点的敌队已全部孤立，没有可掐的链
    // 深入格 + 成块：最大连通子块 ≥columnMinDepth 为长纵队，更短为短促自耗型跳板。
    const deep = entry.tiles.filter((i) => !isolated(i) && homeDistance[i] >= 0 && embedded(i));
    if (!deep.length) continue;
    const deepSet = new Set(deep);
    const seen = new Set();
    let component = null;
    for (const start of deep) {
      if (seen.has(start)) continue;
      const q = [start], comp = [];
      seen.add(start);
      for (let h = 0; h < q.length; h++) {
        comp.push(q[h]);
        for (const j of neighbors[q[h]]) if (deepSet.has(j) && !seen.has(j)) { seen.add(j); q.push(j); }
      }
      if (!component || comp.length > component.length) component = comp;
    }
    if (!component) continue;
    const longColumn = component.length >= p.columnMinDepth;
    // 头部 = 深入块中离我家最近的格（纵队推进方向的尖端）。
    let head = -1, headDist = Infinity;
    for (const c of component) if (homeDistance[c] < headDist) { headDist = homeDistance[c]; head = c; }
    if (!mem.heads.has(key)) mem.heads.set(key, headDist);
    const prev = mem.prev.get(key);
    const advancing = prev !== undefined && headDist < prev;
    if (!advancing) continue; // 未推进（或首次观察无从判断）不出手

    // 二之二补充（用户 2026-09-28）：头部格本身是敌指挥所/皇冠 = 头自带锚，对方
    // 故意放弃尾部——打掉尾部不能阻止头部继续推进，掐链无效，一律直接打头部
    // （拆建筑推进即停），不再寻找切断点、也不侧击腰部。
    const headIsAnchor = grid[head] === owners[head] + 50 || grid[head] === owners[head] + 100;

    // 掐链（仅长纵队且头部非建筑）：候选脖子 = 贴我方格、非敌锚的敌格；占住后深入
    // 段断锚的才有效。短促自耗型跳板（一两个格、走一步身后自弃）没有脖子可截，
    // 不硬找切断点。
    // 「身后刀」加权（2026-09-29 用户追加方针）：候选脖子比深入块更靠敌锚点一侧
    // （enemyDistance 更小）按差值加分——在纵队与敌主力之间尽量靠后下刀。
    const enemyDistance = new Int32Array(size).fill(-1);
    {
      const q = [];
      for (const a of entry.anchors) { enemyDistance[a] = 0; q.push(a); }
      for (let h = 0; h < q.length; h++) {
        const i = q[h];
        if (enemyDistance[i] >= p.columnRange + p.cutoffRange) continue;
        for (const j of neighbors[i]) if (enemyDistance[j] < 0 && passable(j)) { enemyDistance[j] = enemyDistance[i] + 1; q.push(j); }
      }
    }
    let compDepth = Infinity;
    for (const c of component) if (enemyDistance[c] >= 0 && enemyDistance[c] < compDepth) compDepth = enemyDistance[c];
    const tileSet = new Set(entry.tiles);
    const anchorSet = new Set(entry.anchors);
    const compSet = new Set(component);
    const necks = [];
    if (longColumn && !headIsAnchor) {
      const candidates = entry.tiles.filter((i) => !anchorSet.has(i) && !isolated(i) &&
        neighbors[i].some((v) => own(v)));
      candidates.sort((a, b) => ctx.count(a, 1) - ctx.count(b, 1));
      for (const choke of candidates.slice(0, 12)) {
        const defense = ctx.count(choke, 1);
        if (defense > p.cutoffMaxDefense) continue;
        // 从敌锚同时 BFS（移除 choke），走不到的深入块兵力 = 掐链冻住量。
        const reached = new Set([choke]);
        const q = [];
        for (const a of entry.anchors) if (a !== choke) { reached.add(a); q.push(a); }
        let visited = 0, overflow = false;
        for (let h = 0; h < q.length; h++) {
          if (++visited > p.cutoffScan * 4) { overflow = true; break; }
          for (const v of neighbors[q[h]]) if (!reached.has(v) && tileSet.has(v)) { reached.add(v); q.push(v); }
        }
        if (overflow) continue;
        let trapped = 0, trappedDeep = 0;
        for (const i of tileSet) {
          if (reached.has(i) || isolated(i)) continue;
          if (compSet.has(i)) trappedDeep++;
          trapped += Math.max(0, army[i]);
        }
        // 必须真的冻住纵队主体（深入块至少一半断锚）且冻住量够本。
        if (trappedDeep < Math.ceil(component.length / 2) || trapped < p.columnMinMass) continue;
        const danger = Math.max(0, p.columnRange - homeDistance[choke]);
        const behind = enemyDistance[choke] >= 0 && compDepth < Infinity ?
          Math.max(0, compDepth - enemyDistance[choke]) : 0;
        const score = trapped * 1.2 - defense * 1.5 + danger * 12 + behind * p.cutoffBehindBonus;
        necks.push({ choke, defense, trapped, score });
      }
      necks.sort((a, b) => b.score - a.score);
    }

    let plan = null, neck = null, neckStrike = false;
    if (headIsAnchor) {
      // ① 打头（二之二补充）：拆建筑推进即停；本 tick 拆不动就集兵压向头部。
      plan = planChokeAttack(ctx, p, head, ctx.count(head, 1), 0,
        '打头拆敌跳板建筑', '打头拆敌跳板建筑（集兵）', { column: true });
    }
    if (!plan && necks.length) {
      // 本 tick 能直接占下的脖子优先（掐链窗口稍纵即逝），高分集兵脖子作兜底。
      let gatherPlan = null, gatherNeck = null;
      for (const cand of necks.slice(0, 6)) {
        const candidate = planChokeAttack(ctx, p, cand.choke, cand.defense, cand.trapped,
          '掐断敌跳板纵队', '掐断敌跳板纵队（集兵）', { column: true });
        if (!candidate) continue;
        if (candidate.strike) { plan = candidate; neck = cand; neckStrike = true; break; }
        if (!gatherPlan) { gatherPlan = candidate; gatherNeck = cand; }
      }
      if (!plan) { plan = gatherPlan; neck = gatherNeck; }
    }
    if (!plan && !longColumn) {
      // ② 短促自耗型（用户 2026-09-28 补充方针）：没有脖子可截，直接用我方兵力
      //    迎头撞头部格——以兵换兵顶回去/磨掉，不硬找切断点。
      //    headOn 标记（2026-09-29 追加方针）：policy 层发现截断模块有后方切断点时，
      //    迎头撞让位给截断——能从身后下刀就不硬拼。
      plan = planChokeAttack(ctx, p, head, ctx.count(head, 1), 0,
        '迎头撞敌短跳板', '迎头撞敌短跳板（集兵）', { column: true, headOn: true });
    }
    if (!plan && longColumn && !headIsAnchor) {
      // ③ 侧击腰部：深入块里守军最薄、贴我方格的格子，削掉纵队一段。
      let waist = null;
      for (const c of component) {
        if (!neighbors[c].some((v) => own(v))) continue;
        const defense = ctx.count(c, 1);
        if (!waist || defense < waist.defense) waist = { cell: c, defense };
      }
      if (waist) plan = planChokeAttack(ctx, p, waist.cell, waist.defense, 0,
        '侧击敌纵队腰部', '侧击敌纵队腰部（集兵）', { column: true });
    }
    if (!plan) continue;
    const score = (neck ? neck.score : 0) + (neckStrike ? 100 : 0) +
      Math.max(0, p.columnRange - headDist) * 10;
    if (!best || score > best.score) best = { plan, score, headDist };
  }
  if (!best) return null;
  // 头部逼近我方锚点（≤3 跳）视同紧急：允许越过移动护栏的反向禁行。
  return { ...best.plan, head: best.headDist, urgent: best.headDist <= 3 };
}
module.exports = { chooseColumnStrike };
