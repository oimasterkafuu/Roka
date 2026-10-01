'use strict';
const { createArena, MAP_MODES } = require('../../anti-human-bot/training/arena.cjs');
const { createPolicy } = require('../bot/policy.cjs');
const { chooseAction: chooseAntiAction } = require('../../anti-human-bot/bot/policy.cjs');
const { createRaider } = require('./opponents/raider.cjs');
const { createInvestmentRaider } = require('./opponents/investment-raider.cjs');
const { project } = require('../bot/board.cjs');
const { threatMap } = require('../bot/threat.cjs');
const { classify } = require('../bot/safety.cjs');
function anti() { return (state) => chooseAntiAction(state); }
function apex(seat) { const policy = createPolicy(seat + 1); const wrapped = (state) => policy(state); wrapped.stats = () => policy.stats(); return wrapped; }
function opponent(kind, seat) { return kind === 'investment-raider' ? createInvestmentRaider(seat) : createRaider(seat); }
function play(mode, swap, maxTurns, seed, suite) {
  const arena = createArena({ mapMode: mode, seed });
  const policies = suite === 'mixed'
    ? (swap ? [anti(), apex(1)] : [apex(0), anti()])
    : (swap ? [opponent(suite, 1), apex(1)] : [apex(0), opponent(suite, 2)]);
  const started = Date.now(), firstThreat = [null, null], firstResponse = [null, null];
  while (!arena.ended && arena.engine.turn < maxTurns) {
    const actions = policies.map((policy, p) => {
      if (arena.states[p].dead) return null;
      const visible = project(arena.states[p], p + 1);
      const threat = threatMap(visible, p + 1);
      if (threat.imminent && firstThreat[p] === null) firstThreat[p] = arena.engine.turn;
      const action = policy(arena.states[p]);
      if (p === (swap ? 1 : 0) && action && firstResponse[p] === null) {
        const safety = classify(visible, action);
        if (safety.urgent || safety.saves || safety.protects) firstResponse[p] = arena.engine.turn;
      }
      return action;
    });
    arena.tick(actions);
  }
  const leaderboard = arena.engine.buildLeaderboard();
  const alive = leaderboard.filter((p) => p.class_ !== 'dead');
  const winner = arena.ended && alive.length === 1 ? alive[0].id - 1 : null;
  const crownCounts = [1, 2].map((owner) => arena.engine.gridType.flat().filter((tile, i) => tile === -2 && arena.engine.owner.flat()[i] === owner).length);
  const search = policies.map((policy) => policy.stats ? policy.stats() : {});
  return { ended: arena.ended, winner, draw: !arena.ended, turns: arena.engine.turn, firstThreat, firstResponse, stats: arena.stats.map((stat, p) => ({ ...stat, ...leaderboard.find((entry) => entry.id === p + 1) })), crowns: crownCounts, search, elapsedMs: Date.now() - started };
}
function main() {
  const suite = process.env.APEX_BENCH_SUITE === 'investment-raider' ? 'investment-raider' : process.env.APEX_BENCH_SUITE === 'raider' ? 'raider' : 'mixed';
  const full = process.env.APEX_BENCH_SUITE === 'full';
  const turns = Math.min(full ? 1200 : 600, Math.max(120, Number(process.env.APEX_BENCH_TURNS || (full ? 1200 : 300))));
  const modes = full || suite !== 'mixed' ? MAP_MODES : MAP_MODES.slice(0, 2);
  const rows = [];
  for (const mode of modes) for (const swap of [false, true]) {
    const result = play(mode, swap, turns, `apex-${suite}-${mode}`, suite);
    const row = { suite, mode, swap, ended: result.ended, winner: result.winner, draw: result.draw, turns: result.turns, firstThreat: result.firstThreat, firstResponse: result.firstResponse, actions: result.stats.map((s) => s.attacks + s.builds + s.upgrades), rejected: result.stats.map((s) => s.rejected), armies: result.stats.map((s) => s.army), land: result.stats.map((s) => s.land), crowns: result.crowns, search: result.search, elapsedMs: result.elapsedMs };
    rows.push(row); console.error(JSON.stringify({ progress: false, ...row }));
  }
  const summary = { suite, turns, matches: rows.length, ended: rows.filter((r) => r.ended).length, draws: rows.filter((r) => r.draw).length, rows };
  console.log(JSON.stringify(summary, null, 2)); return summary;
}
if (require.main === module) main();
module.exports = { main, play };
