'use strict';
const { preview } = require('./rules.cjs');
const { threatMap } = require('./threat.cjs');
const { connectivityReport } = require('./connectivity.cjs');
const { project } = require('./board.cjs');

function actionEffect(board, action) {
  const result = preview(board, action);
  if (!result.ok) return result;
  return { ...result, after: project({ ...board, grid: result.grid, army: result.army, isolated: result.isolated }, board.playerId) };
}
function classify(board, action, context = {}) {
  const threats = context.threats || threatMap(board);
  const connectivity = context.connectivity || connectivityReport(board);
  const result = actionEffect(board, action);
  if (!result.ok) return { allowed: false, reason: result.reason, priority: -Infinity };
  const target = action.kind === 'attack' ? result.to : result.index;
  const danger = threats.threatenedCrowns.length > 0;
  const route = new Set(threats.threatenedCrowns.flatMap((t) => t.path || []));
  const routeAction = action.kind === 'attack' && (route.has(result.from) || route.has(result.to));
  const urgent = threats.threats.some((t) => t.dangerous && (t.crown === target || t.source === target || (action.kind === 'attack' && result.to === t.crown)));
  if (action.kind === 'build' && danger) return { allowed: false, reason: 'crown-threat', urgent: true, priority: -100000 };
  if (danger && action.kind === 'attack' && !routeAction && !result.captured && !result.decap) return { allowed: false, reason: 'off-threat-route', priority: -100000 };
  if (action.kind === 'attack') {
    const beforeArmy = board.army[result.to], afterArmy = result.army[result.to];
    const friendlyMerge = board.friendly(board.playerId, board.owner(result.to)) && afterArmy > beforeArmy;
    const effective = result.captured || result.decap || friendlyMerge || afterArmy < beforeArmy;
    if (!effective) return { allowed: false, reason: 'non-effective', priority: -100000 };
  }
  const afterThreat = result.after ? threatMap(result.after) : threats;
  const saves = (threats.fatal && !afterThreat.fatal) || (threats.imminent && !afterThreat.imminent);
  const protects = action.kind === 'attack' && connectivity.points.has(result.from) && result.send < board.army[result.from];
  return { allowed: true, urgent, saves, protects, priority: (saves ? 100000 : 0) + (protects ? 50000 : 0) + (urgent ? 10000 : 0) + (routeAction ? 25000 : 0) };
}
function filterSafe(board, actions, context = {}) { return actions.filter((action) => classify(board, action, context).allowed); }
module.exports = { actionEffect, classify, filterSafe };
