'use strict';
// 扁平、有限数值；优化器可直接按 PARAM_RANGES 采样。距离/时间单位为格/ tick。
// 新增参数集中在「威胁按到达时间衰减」与「建造竞赛追赶」两组：
// 旧实现把 2 跳内的敌军按全额、把 8 跳内的敌军按全额计入门槛，导致策略过度保守。
const DEFAULT_PARAMS = Object.freeze({
  // 经济与建造
  buildSafety: 8, enemyDistance: 3, threatWeight: 1.2,
  supportWeight: 0.35, territoryPerCrown: 18, maxCrowns: 100,
  earlyInvestment: 1.4, investmentHorizon: 160, paybackWeight: 0.7,
  buildThreshold: 18, upgradeBonus: 25,
  // 扩张与行军
  moveDepthCost: 80, expansionWeight: 1, explorationWeight: 1,
  // 局部威胁模型（新）
  threatRadius: 2, pressureDecay: 0.45,
  counterWeight: 0.75, sourceKeep: 0.85, unknownMargin: 8, exchangeRatio: 1.6,
  // 建造威胁模型（新）
  buildThreatRadius: 5, buildPressureDecay: 0.4, foundationPremium: 14,
  raceAggression: 1.35, raceLead: 2, economyFloor: 0,
  // 防御反应窗口（新）
  defenseHorizon: 5,
  // 调度策略（新）：经济落后时固定拿走的 tick 比例；回防是否压过普通推进
  economyShareTicks: 3, defensePriority: 0, minArrive: 1, wideKeepWeight: 0, consolidateLoss: 3, consolidateTicks: 15,
  grindMin: 40, grindAdvantage: 0.8, grindKeep: 0.2,
  stallTicks: 40, stallRatio: 0.35,
  // 入侵截断（偷家防御）
  cutoffRange: 9, cutoffScan: 120, cutoffMaxSteps: 4, cutoffMinIsolate: 8,
  cutoffMaxDefense: 4000, cutoffUrgentRange: 8,
  // 宏观方针（2026-09-27 第二轮）：运输小勺下限、集结点僵持放弃、工地/集结点滞回
  minTransport: 8, rallyStallTicks: 24, rallyAbandonTicks: 40, siteHysteresis: 1.5,
  // 浓缩突击（2026-09-27，学自 _E_ 单堆全冲）：出击余量倍数与决定性大堆最小规模
  // （E 的大堆为 367–1240 兵，300 以下的堆不构成「决定性」，深入半兵方针不变）
  assaultMargin: 1.3, megaStackMin: 300,
  // 优势垃圾话（bot/trash-talk.cjs）：只在优势时开口；全局冷却 + 每局上限 + 概率门控
  trashTalk: 1, trashTalkMinTurn: 60, trashTalkMaxPerGame: 4,
  trashTalkGlobalCd: 150, trashTalkChance: 0.6,
  trashLandRatio: 1.3, trashArmyRatio: 2,
  trashCrushArmyRatio: 4, trashCrushLandRatio: 3,
  trashStreakBuildings: 3, trashStreakWindow: 60, trashStallTicks: 120,
  trashEatenTotal: 5, trashWololoLandDrop: 15,
  trashCdLand: 250, trashCdArmy: 250, trashCdCrush: 300, trashCdStreak: 200, trashCdStall: 300, trashCdEaten: 250,
  // 绝境投降（bot/surrender.cjs）：四条全满足才投，宁可少投不误投
  surrenderEnabled: 1, surrenderMinTurn: 150,
  surrenderArmyRatio: 8, surrenderLandRatio: 4, surrenderCrownGap: 3,
  surrenderHopelessArmyRatio: 10,
  surrenderTeaseTicks: 250, surrenderTeaseNearCrownTicks: 30, surrenderEnemyActiveTicks: 80,
  // 画圈推进（2026-09-27，学自 _E_ 锋面量化：推进期 5×5 窗口己方格中位 7、截面宽中位 4、
  // 推进窗口内指挥所建造间隔中位 4 tick、建造点距大堆/路径中位 2 格）：
  // pushFrontWidth 锋面目标宽度；anchorChainGap 锚点链间距（走廊上离最近建筑
  // 至少这么远才落新指挥所）；anchorBuildEvery 锚点建造节奏（每 N tick 一次，
  // 有截断风险时不受节奏限制）。
  pushFrontWidth: 2, anchorChainGap: 3, anchorBuildEvery: 4,
  // maze 拓展纪律（用户 2026-09-27 硬方针）：已知格中山体占比达到该阈值判为迷宫图
  // （maze 生成器约 0.45–0.55，random ≤0.24，群岛/地中海以沼泽为主）。
  mazeMountainRatio: 0.3,
  // 阶段化扩张-要塞方针（用户 2026-09-27 定稿，E 原局校准）：E 的净扩张速率在
  // turn 60–75 坍缩（+18/25t → +1/25t）、皇冠建设从 75–100 起跳——前期抢地盘
  // 积累不动；中后期（turn >= fortressPhaseTurn）薄皮大摊子是自杀形态：中立扩张
  // 必须「有要塞撑腰」（源点在己方建筑 lateAnchorRadius 辐射圈内）或「自己够厚」
  // （驻军 >= lateSkinMin），同时皇冠目标提速（每 lateTerritoryPerCrown 地皮一座、
  // 上限 lateMaxCrowns）。
  fortressPhaseTurn: 60, lateTerritoryPerCrown: 9, lateMaxCrowns: 12,
  lateSkinMin: 10, lateAnchorRadius: 2,
  // maze 系统性弱点修复（issue #70，2026-09-30，证据 /root/antihuman-review.md）：
  // 场 1 敌 125–191 兵大堆在 19 跳走廊尽头贴境停 16 tick 零应对（defense HORIZON=12
  // 以主城为圆心量连通距离，走廊长度超窗）；场 2 敌堆在旧领土行军 18 turn 无拦截。
  // mazeDefenseHorizon：mazeLike 时 defense 反应窗（皇冠 BFS 本就走连通距离，问题在
  // 12 跳封顶）；mazeRallyWindow：mazeLike 时提前汇兵窗口，不再等敌堆贴脸才动。
  mazeDefenseHorizon: 24, mazeRallyWindow: 10,
  // 场 1 死因：割点 (1,5) 被 228 兵堆一刀切断、约 150 兵集群断链蒸发——cutoff 脖子
  // 纪律只在「本 tick 可切断」时触发，敌堆进入割点走廊没有任何预警。mazeNeckWarnRange：
  // mazeLike 时敌堆距割点走廊多少跳内触发提前驻防（也供 frontline 关卡留守用）；
  // mazePushNeckKeep：mazeLike 时关卡源点攻击敌格/指挥所的留守倍率（对 N 跳内逼近
  // 敌堆按跳数衰减后乘以该值），防止场 2 (7,7) 前哨皇冠被自己的攻击从 83 抽干到 22。
  mazeNeckWarnRange: 6, mazePushNeckKeep: 1.2,
  // campaign 锚点建站兵力门槛参数化（引擎硬门槛 50+1，不能再低；供优化器采样）。
  anchorMinArmy: 51,
  // 场 2 t110 起土地恒定 26–34：fortressPhaseTurn 后中立扩张要锚点 radius 2 或
  // 驻军 ≥10，迷宫薄皮走廊被全禁 → 产能冻结。mazeLike 时放宽半径/驻军门槛。
  mazeLateAnchorRadius: 4, mazeLateSkinMin: 4,

});
const PARAM_RANGES = Object.freeze({
  buildSafety: [0, 30], enemyDistance: [1, 8], threatWeight: [0.5, 3],
  supportWeight: [0, 0.8], territoryPerCrown: [6, 40], maxCrowns: [0, 100000],
  earlyInvestment: [0.5, 3], investmentHorizon: [60, 300], paybackWeight: [0.2, 2],
  buildThreshold: [-30, 100], upgradeBonus: [0, 80],
  moveDepthCost: [20, 180], expansionWeight: [0.3, 2], explorationWeight: [0.2, 3],
  threatRadius: [1, 3], pressureDecay: [0.1, 0.85],
  counterWeight: [0, 1.6], sourceKeep: [0, 1.5], unknownMargin: [0, 40], exchangeRatio: [1, 4],
  buildThreatRadius: [2, 8], buildPressureDecay: [0.1, 0.85], foundationPremium: [0, 60],
  raceAggression: [0, 3], raceLead: [1, 8], economyFloor: [0, 120],
  defenseHorizon: [2, 10],
  economyShareTicks: [0, 8], defensePriority: [0, 2], minArrive: [1, 12], wideKeepWeight: [0, 1], consolidateLoss: [0, 20], consolidateTicks: [0, 60],
  grindMin: [0, 2000], grindAdvantage: [0.3, 1.5], grindKeep: [0, 0.6],
  stallTicks: [0, 200], stallRatio: [0.1, 1.5],
  cutoffRange: [3, 20], cutoffScan: [20, 600], cutoffMaxSteps: [1, 8], cutoffMinIsolate: [0, 500],
  cutoffMaxDefense: [0, 100000], cutoffUrgentRange: [0, 20],
  minTransport: [0, 200], rallyStallTicks: [0, 300], rallyAbandonTicks: [0, 600], siteHysteresis: [1, 4],
  assaultMargin: [1, 3], megaStackMin: [0, 2000],
  trashTalk: [0, 1], trashTalkMinTurn: [0, 600], trashTalkMaxPerGame: [0, 12],
  trashTalkGlobalCd: [30, 2000], trashTalkChance: [0, 1],
  trashLandRatio: [1.05, 4], trashArmyRatio: [1.2, 8],
  trashCrushArmyRatio: [2, 20], trashCrushLandRatio: [1.5, 12],
  trashStreakBuildings: [2, 10], trashStreakWindow: [20, 300], trashStallTicks: [40, 600],
  trashEatenTotal: [2, 30], trashWololoLandDrop: [5, 200],
  trashCdLand: [30, 2000], trashCdArmy: [30, 2000], trashCdCrush: [30, 2000], trashCdStreak: [30, 2000], trashCdStall: [30, 2000], trashCdEaten: [30, 2000],
  surrenderEnabled: [0, 1], surrenderMinTurn: [30, 2000],
  surrenderArmyRatio: [2, 50], surrenderLandRatio: [1.5, 30], surrenderCrownGap: [1, 12],
  surrenderHopelessArmyRatio: [3, 60],
  surrenderTeaseTicks: [60, 3000], surrenderTeaseNearCrownTicks: [5, 500], surrenderEnemyActiveTicks: [20, 500],
  pushFrontWidth: [1, 4], anchorChainGap: [2, 8], anchorBuildEvery: [2, 12], mazeMountainRatio: [0.15, 0.6],
  fortressPhaseTurn: [40, 600], lateTerritoryPerCrown: [4, 30], lateMaxCrowns: [3, 40],
  lateSkinMin: [2, 60], lateAnchorRadius: [1, 4],
  mazeDefenseHorizon: [12, 40], mazeRallyWindow: [3, 30],
  mazeNeckWarnRange: [2, 15], mazePushNeckKeep: [0, 4],
  anchorMinArmy: [51, 400],
  mazeLateAnchorRadius: [2, 8], mazeLateSkinMin: [1, 20],

});
function resolveParams(params = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PARAMS)) {
    const value = params?.[key];
    const [min, max] = PARAM_RANGES[key];
    result[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  return result;
}
module.exports = { DEFAULT_PARAMS, PARAM_RANGES, resolveParams };
