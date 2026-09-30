'use strict';
const { createArena, MAP_MODES } = require('../../anti-human-bot/training/arena.cjs');
const { createPolicy } = require('../bot/policy.cjs');
const { chooseAction: chooseAntiAction } = require('../../anti-human-bot/bot/policy.cjs');
function anti() { return (state) => chooseAntiAction(state); }
function apex(seat) { const policy = createPolicy(seat + 1); const wrapped = (state) => policy(state); wrapped.stats = () => policy.stats(); return wrapped; }
function play(mode, swap, maxTurns, seed) {
  const arena = createArena({ mapMode: mode, seed });
  const policies = swap ? [anti(), apex(1)] : [apex(0), anti()];
  const started = Date.now();
  while (!arena.ended && arena.engine.turn < maxTurns) {
    const actions = policies.map((policy, p) => arena.states[p].dead ? null : policy(arena.states[p]));
    arena.tick(actions);
    if (arena.engine.turn % 120 === 0) console.error(JSON.stringify({ progress: true, mode, swap, turn: arena.engine.turn, elapsedMs: Date.now() - started }));
  }
  const leaderboard = arena.engine.buildLeaderboard();
  const crownCounts = [1, 2].map((owner) => arena.engine.gridType.flat().filter((tile, i) => tile === -2 && arena.engine.owner.flat()[i] === owner).length);
  const search = policies.map((policy) => policy.stats ? policy.stats() : { searchMs: 0, searches: 0 });
  const alive = leaderboard.filter((p) => p.class_ !== 'dead');
  const winner = arena.ended && alive.length === 1 ? alive[0].id - 1 : null;
  return { ended: arena.ended, winner, draw: !arena.ended, turns: arena.engine.turn, stats: arena.stats.map((stat, p) => ({ ...stat, ...leaderboard.find((entry) => entry.id === p + 1) })), crowns: crownCounts, search, leaderboard, elapsedMs: Date.now() - started };
}
function main() {
  const turns = Math.max(1200, Number(process.env.APEX_BENCH_TURNS || 1200));
  const rows = [];
  for (const mode of MAP_MODES) for (const swap of [false, true]) {
    // Same seed for both seats; swap changes only policy assignment.
    const result = play(mode, swap, turns, `apex-${mode}`);
    const row = { mode, swap, ended: result.ended, winner: result.winner, draw: result.draw, turns: result.turns, actions: result.stats.map((s) => s.attacks + s.builds + s.upgrades), rejected: result.stats.map((s) => s.rejected), armies: result.stats.map((s) => s.army), land: result.stats.map((s) => s.land), crowns: result.crowns, searchMs: result.search.map((s) => s.searchMs), searches: result.search.map((s) => s.searches), elapsedMs: result.elapsedMs };
    rows.push(row); console.error(JSON.stringify({ progress: false, ...row }));
  }
  const summary = { matches: rows.length, ended: rows.filter((r) => r.ended).length, draws: rows.filter((r) => r.draw).length, rows };
  console.log(JSON.stringify(summary, null, 2)); return summary;
}
if (require.main === module) main();
module.exports = { main, play };
