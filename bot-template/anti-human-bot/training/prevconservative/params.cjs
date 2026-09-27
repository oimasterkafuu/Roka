'use strict';
// 扁平、有限数值；优化器可直接按 PARAM_RANGES 采样。距离/时间单位为格/ tick。
const DEFAULT_PARAMS = Object.freeze({
  buildSafety: 8, enemyDistance: 3, threatWeight: 1.2,
  supportWeight: 0.35, territoryPerCrown: 18, maxCrowns: 100,
  earlyInvestment: 1.4, investmentHorizon: 160, paybackWeight: 0.7,
  buildThreshold: 18, upgradeBonus: 25,
  moveDepthCost: 80, expansionWeight: 1, explorationWeight: 1,
});
const PARAM_RANGES = Object.freeze({
  buildSafety: [0, 30], enemyDistance: [1, 8], threatWeight: [0.5, 3],
  supportWeight: [0, 0.8], territoryPerCrown: [6, 40], maxCrowns: [0, 100000],
  earlyInvestment: [0.5, 3], investmentHorizon: [60, 300], paybackWeight: [0.2, 2],
  buildThreshold: [-30, 100], upgradeBonus: [0, 80],
  moveDepthCost: [20, 180], expansionWeight: [0.3, 2], explorationWeight: [0.2, 3],
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
