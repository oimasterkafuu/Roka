'use strict';

// 边界进攻评估：只回答「这一步打下去，下几个 tick 会不会亏」。
// 与旧版的关键差别：
//   1. 不再使用「2 跳内敌军全额」「全图敌军总量」这类聚合门槛；
//   2. 敌方 2 跳兵力按到达时间衰减（默认 0.45），相邻兵力才按全额算；
//   3. 目标格本 tick 可能得到的同 tick 增援按可动兵折算；
//   4. 攻城/攻冠/碾压三种情况允许「交换」，不再要求纯赚；
//   5. 不再存在「前沿两格内没有自家建筑就一律不许深入」的 deep 规则。
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');


function createFrontline(state, params = {}) {
  const ctx = createContext(state, params);
  if (!ctx) return null;
  const p = resolveParams(params);
  const { n, m, size, owners, grid, army, me, count, own, hostile, friendly, allied, passable, known } = ctx;
  const diagnostics = { rejected: {}, examples: [], candidates: 0 };
  function reject(code, detail) {
    diagnostics.rejected[code] = (diagnostics.rejected[code] || 0) + 1;
    if (detail && diagnostics.examples.length < 5) diagnostics.examples.push({ code, ...detail });
    return null;
  }
  const allowed = (owner) => !params.allowedOwners || params.allowedOwners.has(owner);
  const blocked = (a, b) => params.blockedEdges?.has(`${a}:${b}`);

  function classify(a, b) {
    if (grid[b] === owners[b] + 100) return 'crown';
    if (grid[b] === owners[b] + 50) return 'city';
    if (owners[b]) return 'enemy';
    return 'neutral';
  }

  function evaluate(move) {
    if (!move) return null;
    if (move.kind === 'build') return { move, score: -Infinity };
    const { x, y, dx, dy } = move;
    if (![x, y, dx, dy].every(Number.isInteger) || x < 0 || x >= n || dx < 0 || dx >= n ||
        y < 0 || y >= m || dy < 0 || dy >= m || Math.abs(x - dx) + Math.abs(y - dy) !== 1) return null;
    const a = x * m + y, b = dx * m + dy;
    if (!own(a)) return reject('来源非可操作己方格', { from: a, to: b });
    if (blocked(a, b)) return reject('移动历史禁行边', { from: a, to: b });
    const targetOwner = owners[b];
    if (allied(targetOwner, me)) {
      // 己方内部运输：两端 2 跳内都没有敌人时整批运输，否则保留引擎的智能留兵。
      const quiet = ctx.pressure(a, { exclude: b }).total === 0 && ctx.pressure(b, { exclude: a }).total === 0 &&
        !ctx.unknownNear(a) && !ctx.unknownNear(b);
      return { move: quiet ? { ...move, mode: 2, half: false } : move, score: -Infinity };
    }
    if (!known[b]) return reject('目标不可见或不可通行', { from: a, to: b });
    if (targetOwner && !allowed(targetOwner)) return reject('FFA目标限制', { from: a, to: b, owner: targetOwner });

    const A = count(a);
    const D = count(b, 1);
    const cap = A - 1;
    if (cap <= 0) return reject('来源无兵', { from: a, A });
    // 引擎 mode 0 的邻格留兵（不含目标格），用于估算 mode 0/1 的实际出兵量。
    let sideReserve = 0;
    for (const v of ctx.neighbors[a]) {
      if (v === b || !passable(v) || allied(owners[v], me)) continue;
      sideReserve += Math.max(0, count(v) - 1);
    }
    const smart = Math.max(0, Math.min(cap, A - sideReserve - 1));
    const src = ctx.pressure(a, { exclude: b });
    const tgt = ctx.pressure(b, { exclude: a });
    const mates = ctx.friendlyAdjacent(b, a);
    const reinforce = ctx.reinforcement(b, a, p);
    const defense = D + reinforce;
    const kind = classify(a, b);
    const isCrown = kind === 'crown';
    const isCity = kind === 'city';
    const unknownNear = ctx.unknownNear(a) || ctx.unknownNear(b);
    // 源点留守：贴着源点的敌人必须留够（下一 tick 就可能反打），两跳外的按折扣计。
    // 周围完全干净时保留 1 兵即可，全冲（mode 2）才有意义。
    const pressureKeep = Math.ceil(src.adj * p.sourceKeep + src.near * 0.3);
    // 3 跳内的敌军同样算数（不能只看贴脸的两跳），但最多只强制留守一半，
    // 保证「有威胁时仍能打出去」，同时不再让边境格被抽成 1 兵空壳。
    const wide = ctx.frontDistance[a] === 0 && p.wideKeepWeight > 0
      ? ctx.pressure(a, { radius: 3, decay: 0.5 }).total : 0;
    const wideKeep = Math.min(Math.ceil(A * 0.5), Math.ceil(wide * p.wideKeepWeight));
    const keepSource = Math.max(pressureKeep > 0 ? 2 : 1, pressureKeep, wideKeep);
    const localRatio = A / Math.max(1, defense + tgt.adj + src.adj);
    // 全局兵力落后时不再做亏本交换：只打真正赚的仗。
    const behindArmy = ctx.race.bestOwner !== null && ctx.race.myArmy < 0.95 * ctx.race.bestArmy;
    const exchangeNeed = p.exchangeRatio * (behindArmy ? 1.6 : 1);
    // ── 拆建筑最高优先 ────────────────────────────────────────────────
    // 拿下敌方的皇冠/指挥所会直接摧毁它：对方至少损失 100 兵的投资与每 tick +1 的产能，
    // 所以只要能攻下就照打，不要求「打赚」、不看全局兵力落后、不被 console 整合期挡住。
    // 唯一例外：不能拿我们自己的建筑去换（那等于互删，净亏产能）。
    const buildingTarget = isCrown || isCity;
    const ownBuilding = grid[a] === me + 100 || grid[a] === me + 50;
    // 拆建筑愿意付出的是「占领后守不住」的代价，不是把自家源点抽空：
    // 源点留守规则照旧（否则一兵建筑下一 tick 就被顺手拆掉，净亏产能）。
    const buildingKeep = keepSource;
    const modes = [1, 2, 0];
    let best = null;
    for (const mode of modes) {
      const push = mode === 1 ? Math.floor(smart / 2) : mode === 2 ? cap : smart;
      if (push <= 0) continue;
      const arrive = push - defense;
      const left = A - push;
      // 占领格必须留下能站住的兵，禁止 1 兵蚕食式进攻（那是给对手送地）。
      if (arrive < p.minArrive) continue;
      if (left < (buildingTarget ? buildingKeep : keepSource)) continue;
      if (unknownNear && !buildingTarget && (left < p.unknownMargin || arrive < 4)) continue;
      // 占领后下一 tick 的相对优势：来援的己方邻格 + 新到兵力 − 目标周围可反击的敌军。
      const exposure = arrive + mates.force * 0.5 - tgt.adj * p.counterWeight;
      let accepted = exposure > 0;
      let exchange = false;
      // 正在被反推：只接高价值目标，先把地守住再谈扩张。
      if (params.consolidate === true && !buildingTarget) continue;
      if (!accepted) {
        if (buildingTarget) accepted = true;                               // 拆建筑：损失可接受
        else if (!behindArmy && localRatio >= exchangeNeed && left > src.adj) { accepted = true; exchange = true; }
      }
      if (!accepted) continue;
      const value = isCrown ? 900 : isCity ? 500 : kind === 'enemy' ? 62 : 26;
      const kill = kind === 'neutral' ? 0 : Math.min(D, 90) * 1.1;
      const exposureScore = Math.max(-160, Math.min(160, exposure * 0.45));
      const rear = ctx.frontDistance[a];
      const supportBonus = Math.min(3, mates.tiles) * 14;
      const lingerPenalty = (rear >= 0 ? Math.max(0, 4 - rear) : 4) * 8;
      const score = value + kill + exposureScore + supportBonus - lingerPenalty +
        Math.min(arrive, 250) * 0.3 + Math.min(left, 400) * 0.05 - (exchange ? 30 : 0);
      const reason = isCrown ? `攻冠：出兵${push}，留守${left}`
        : isCity ? `攻指挥所：出兵${push}，留守${left}`
          : exchange ? `边界交换：出兵${push}，留守${left}`
            : `边界推进：${mode === 1 ? '半兵' : mode === 2 ? '全冲' : '智能分兵'}，留守${left}，占领后${arrive}`;
      if (!best || score > best.score) best = { move: { ...move, mode, half: false, reason }, score, kind };
    }
    if (!best) {
      // ── 消耗冲击：打破「两堆兵隔着一条线无限积累」的对峙死锁 ──────────────
      // 拿不下目标格也要打：用同等兵力换掉对方守军，把大堆打小，为后续突破留出兵力差。
      // 兵力接近、或我方全局产能占优时主动换；同一条边静默超过 stallTicks 时，
      // 即使我方不占优也要动手——长期对峙本身就是最差的结果（节奏死、产能白攒）。
      // 是否值得打消耗战，完全由当前局面推出（不看历史、不看计时器）：
      // 兵力储备或产能占优的一方，1:1 换兵就是赚的；优势越大越愿意用局部劣势换对方主力。
      if (kind !== 'neutral' && A >= p.grindMin && params.consolidate !== true) {
        const reserveEdge = ctx.race.myArmy / Math.max(1, ctx.race.bestArmy);
        const myProduction = ctx.race.myCrowns + ctx.race.myLand / 50;
        const foeProduction = ctx.race.bestCrowns + ctx.race.bestLand / 50;
        const productionEdge = myProduction / Math.max(0.1, foeProduction);
        // 兵力不落后就可以按「接近均势」换；产能碾压（对方几乎没有皇冠）时，
        // 哪怕局部兵力少一半也换——他们补不回来，我们补得回来。
        let need = p.grindAdvantage;
        const dominant = reserveEdge >= 1.4 || productionEdge >= 6;
        if (reserveEdge >= 1.0 || productionEdge >= 3) need *= 0.6;
        if (dominant) need = Math.min(need, p.stallRatio);
        if (A >= need * defense) {
          const floor = Math.max(1, Math.min(keepSource, Math.ceil(A * p.grindKeep)));
          let choice = null;
          for (const mode of [1, 0, 2]) {
            const push = mode === 1 ? Math.floor(smart / 2) : mode === 2 ? cap : smart;
            if (push < p.grindMin || A - push < floor) continue;
            if (!choice || push > choice.push) choice = { mode, push };
          }
          if (choice) {
            const killed = Math.round(Math.min(choice.push, defense));
            const grindScore = 5 + Math.min(killed, 600) * 0.05 + (isCrown ? 300 : isCity ? 80 : 0);
            return { move: { ...move, mode: choice.mode, half: false,
              reason: `消耗冲击${dominant ? '（优势换兵）' : ''}：出兵${choice.push}，换掉约${killed}敌兵` }, score: grindScore };
          }
        }
      }
      return reject('出兵或留守预算未通过', { from: a, to: b, A, D, defense: Math.round(defense),
        sourceAdj: Math.round(src.adj), targetAdj: Math.round(tgt.adj), keepSource, unknownNear });
    }
    return best;
  }

  return {
    diagnostics,
    context: ctx,
    assess: (move) => evaluate(move)?.move ?? null,
    choose() {
      const candidates = [];
      for (let a = 0; a < size; a++) {
        if (owners[a] !== me || !own(a) || count(a) <= 2) continue;
        for (const b of ctx.neighbors[a]) {
          if (!passable(b) || allied(owners[b], me) || !known[b]) continue;
          if (owners[b] && !allowed(owners[b])) continue;
          if (blocked(a, b)) continue;
          const crown = grid[b] === owners[b] + 100 ? 1 : 0;
          const city = grid[b] === owners[b] + 50 ? 1 : 0;
          candidates.push({ a, b, crown, city, edge: count(a) - count(b) });
        }
      }
      candidates.sort((a, b) => b.crown - a.crown || b.city - a.city || b.edge - a.edge || a.a - b.a);
      diagnostics.candidates = candidates.length;
      diagnostics.isolatedSources = 0;
      for (let i = 0; i < size; i++) if (owners[i] === me && ctx.isolated(i) && army[i] > 1) diagnostics.isolatedSources++;
      let best = null;
      for (const { a, b } of candidates.slice(0, 128)) {
        const value = evaluate({ x: Math.floor(a / m), y: a % m, dx: Math.floor(b / m), dy: b % m, mode: 1 });
        if (value && (!best || value.score > best.score)) best = value;
      }
      return best?.move ?? null;
    },
  };
}
module.exports = { createFrontline };
