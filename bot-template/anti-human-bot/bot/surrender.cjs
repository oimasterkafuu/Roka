'use strict';
// 绝境投降判定：满足以下**全部**条件才主动投降（发 GG），宁可少投不误投。
//   1. 严重劣势：兵力 / 领土 / 建筑全方位大幅落后于最强敌（量化阈值进 params）；
//   2. 绝无可能获胜（保守判定）：敌方兵力优势巨大、自己产能见底，且当前
//      没有任何可执行的斩首（合力能推掉任一敌皇冠就不算绝境）；
//   3. 对方没有挂机：最强敌近期有实际地盘/兵力变化，且未被服务端标记 AFK；
//   4. 对方已进入「调戏」状态：严重劣势持续很久，且敌方多次兵临皇冠能收尾
//      却不收尾（能赢不推、围着涂色）。
// 判定逻辑与 client 解耦，单测直接驱动本模块。局面数据来自 bot/threat.cjs
// 的共享分析层（createContext），与决策同源。
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

function createSurrenderJudge(params = {}) {
  const p = resolveParams(params);
  let disadvantageSince = -1; // 条件 1 的持续起点（-1 = 当前不算严重劣势）
  let nearCrownTicks = 0; // 劣势期间「敌可收皇冠却不收」的累计 tick
  let prevEnemyLand = -1, lastEnemyChange = -1;
  let decided = false;

  // 我方（含同盟 bot 队友）合计产能与兵力。
  function sideStats(ctx) {
    let army = 0, land = 0, crowns = 0, cities = 0;
    for (const entry of ctx.factions.values()) {
      if (!ctx.allied(entry.owner, ctx.me)) continue;
      army += entry.army; land += entry.land; crowns += entry.crowns; cities += entry.cities;
    }
    return { army, land, crowns, cities };
  }

  // 是否存在可立即执行的斩首：任一已知敌皇冠的相邻我方合力能推掉守军。
  function canDecapitate(ctx) {
    const { size, grid, army, owners, knownAt, neighbors } = ctx;
    for (let i = 0; i < size; i++) {
      const owner = owners[i];
      if (!owner || ctx.allied(owner, ctx.me) || !knownAt(i) || grid[i] !== owner + 100) continue;
      let strike = 0;
      for (const j of neighbors[i]) {
        if (owners[j] === ctx.me && knownAt(j)) strike += Math.max(0, army[j] - 1);
      }
      if (strike > Math.max(0, army[i])) return true;
    }
    return false;
  }

  // 敌方是否兵临我方皇冠且本 tick 就能收尾（能收不收 = 调戏证据）。
  function enemyCanFinish(ctx) {
    const { size, grid, army, owners, knownAt, neighbors, hostile } = ctx;
    for (let i = 0; i < size; i++) {
      if (owners[i] !== ctx.me || !knownAt(i) || grid[i] !== ctx.me + 100) continue;
      let siege = 0;
      for (const j of neighbors[i]) if (hostile(j)) siege += Math.max(0, army[j] - 1);
      if (siege >= Math.max(1, army[i])) return true;
    }
    return false;
  }

  function evaluate(board) {
    if (decided || !p.surrenderEnabled || !board || board.ended || board.dead) return null;
    const turn = Number.isFinite(board.turn) ? board.turn : 0;
    if (turn < p.surrenderMinTurn) return null;
    const ctx = createContext(board, params);
    if (!ctx) return null;
    const race = ctx.race;
    if (!race.bestOwner) return null;

    // 条件 3：对方没有挂机——观察到过真实地盘变化且近期仍在动，未被服务端标记 AFK。
    // 只数地盘不数兵力：兵力会随自然增长每 tick 变化，挂机的敌人兵力也在涨；
    // 地盘变化只能来自真实的扩张/交战（绝境下我方不可能在大片吃对方的地）。
    if (prevEnemyLand >= 0 && race.enemyLand !== prevEnemyLand) {
      lastEnemyChange = turn;
    }
    prevEnemyLand = race.enemyLand;
    const entry = Array.isArray(board.leaderboard)
      ? board.leaderboard.find((e) => Number(e.id) === race.bestOwner)
      : null;
    const markedAfk = entry?.class_ === 'afk';
    const enemyActive = !markedAfk && lastEnemyChange >= 0 && turn - lastEnemyChange <= p.surrenderEnemyActiveTicks;

    // 条件 1：严重劣势（兵力 / 领土 / 建筑全方位大幅落后）。
    const side = sideStats(ctx);
    const myArmy = Math.max(1, side.army), myLand = Math.max(1, side.land);
    const severe =
      race.bestArmy >= p.surrenderArmyRatio * myArmy &&
      race.bestLand >= p.surrenderLandRatio * myLand &&
      race.bestCrowns >= side.crowns + p.surrenderCrownGap;
    if (severe) {
      if (disadvantageSince < 0) { disadvantageSince = turn; nearCrownTicks = 0; }
      if (enemyCanFinish(ctx)) nearCrownTicks += 1;
    } else {
      disadvantageSince = -1;
      nearCrownTicks = 0;
    }

    // 条件 2：绝无可能获胜（保守）——敌方兵力优势巨大、自己产能见底、无斩首机会。
    const hopeless =
      race.bestArmy >= p.surrenderHopelessArmyRatio * myArmy &&
      side.crowns <= 1 &&
      !canDecapitate(ctx);

    // 条件 4：调戏状态——严重劣势长期持续，且敌多次能收尾却不收。
    const teasing =
      disadvantageSince >= 0 &&
      turn - disadvantageSince >= p.surrenderTeaseTicks &&
      nearCrownTicks >= p.surrenderTeaseNearCrownTicks;

    if (severe && hopeless && enemyActive && teasing) {
      decided = true;
      return {
        surrender: true,
        reason: `绝境投降：兵力 ${Math.round(side.army)} 对 ${Math.round(race.bestArmy)}、` +
          `领土 ${side.land} 对 ${race.bestLand}、皇冠 ${side.crowns} 对 ${race.bestCrowns}，` +
          `劣势已持续 ${turn - disadvantageSince} tick，对方 ${nearCrownTicks} 次能收尾未收`,
      };
    }
    return null;
  }

  return { evaluate };
}

module.exports = { createSurrenderJudge };
