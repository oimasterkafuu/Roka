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
  // 推进方向纪律（用户 2026-09-27 硬方针）：不大范围涂色——目标评分向敌方
  // 皇冠/核心方向强倾斜（每靠近核心 1 格 +pushDirectionWeight）；与进攻主线
  // 无关的侧翼中立涂色格按距敌核心远近降权（paintDiscardDist 格以外满额
  // flankPaintPenalty，以内线性衰减到 0）：离我家远、离敌家也远的中间地带
  // 最不值钱，兵力向敌人家附近逼近而不是横向摊面积。
  pushDirectionWeight: 15, flankPaintPenalty: 40, paintDiscardDist: 8,
  // 建造阈值分级（用户 2026-09-27 硬方针，保留「综合研判」机制，按位置分档）：
  // 位置判断不按出生点，按「距最近敌方压力的跳数 + 局部威胁场」现场评估。
  // 大后方 rearBuildFund=100（一次集满约 100 再造，可连续建造两次：指挥所+升级）；
  // 前线 frontBuildFund=150（前线建造风险高，留足防守/思考余量）；中间档按危险度
  // 线性过渡：敌距 ≤buildFrontDist 记满分前线、≥buildRearDist 记大后方，威胁场
  // 满档 buildFundThreat；威胁极大（≥buildDesperateThreat，敌人已打穿到腹地）时
  // 回落大后方阈值——都打到大后方了没别的选择，必须尽快建造。
  rearBuildFund: 100, frontBuildFund: 150, buildFrontDist: 5, buildRearDist: 12,
  buildFundThreat: 60, buildDesperateThreat: 200,
  // 前线迁都（用户 2026-09-28 回调：后方优先，缓缓前推）：前线区域（敌距
  // <buildRearDist）内威胁场 ≤frontStableThreat 且我方局部兵力
  // ≥frontStableMargin 倍于威胁的格子算「稳定前线」——产能富余（后方皇冠群
  // 成型，crowns ≥ frontBaseMinCrowns）后，稳定前线格才与大后方安全格同等
  // 可作工地并获 frontBaseBonus 选址加成（越靠前加成越多），把主要兵源、
  // 新皇冠缓缓聚集到前线；产能不足时工地权重回到后方安全区。
  frontStableThreat: 12, frontStableMargin: 2, frontBaseBonus: 10, frontBaseMinCrowns: 3,
  // 开局提速（用户 2026-09-28 回调）：前 earlyBuildTurns 个 tick 内阈值分档
  // 整体后移——buildFrontDist/buildRearDist 按 earlyDistScale 收缩（开局
  // 「中间档」不抬高到拖慢建造）、前线阈值按 earlyFrontFundScale 下调，
  // 保证开局就用得上、用得早；升级指挥所仍维持 51。
  earlyBuildTurns: 60, earlyDistScale: 0.6, earlyFrontFundScale: 0.66,
  // 集兵树形化（用户 2026-09-27 硬方针）：缺口 ≥bulkPullMin 时进入树形汇聚调度——
  // 最远的子树先动（逐级向目标汇聚，远端与近端同时在路上，避免一条链式长跑）；
  // 深后方（≥supplyTreeDepth 跳）大堆一次性整批拉出，不被近源小股插队。
  supplyTreeDepth: 4, bulkPullMin: 100,

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
  pushDirectionWeight: [0, 60], flankPaintPenalty: [0, 200], paintDiscardDist: [2, 30],
  rearBuildFund: [51, 300], frontBuildFund: [51, 400], buildFrontDist: [2, 12], buildRearDist: [4, 30],
  buildFundThreat: [10, 400], buildDesperateThreat: [50, 2000],
  frontStableThreat: [0, 200], frontStableMargin: [0, 6], frontBaseBonus: [0, 200],
  frontBaseMinCrowns: [0, 20],
  earlyBuildTurns: [0, 200], earlyDistScale: [0.2, 1], earlyFrontFundScale: [0.2, 1],
  supplyTreeDepth: [2, 12], bulkPullMin: [20, 1000],

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
