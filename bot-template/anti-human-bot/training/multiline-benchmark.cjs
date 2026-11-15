'use strict';
// Frozen policies live outside the repository. Results must be written outside it.
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { runMatch, MAP_MODES } = require('./arena.cjs');
const { chooseActions } = require('../bot/multiline.cjs');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
if (!args.reference || !args.output) throw Error('--reference and --output required');
const old = require(path.join(path.resolve(args.reference), 'policy.cjs')).chooseAction;
const current = require('../bot/policy.cjs').chooseAction;
const baseline = args.baseline === 'true';
const turns = Number(args.turns || 1000), seeds = Number(args.seeds || 2);
const digest = dir => Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.cjs')).sort()
  .map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));
const manifest = { current: digest(path.resolve(__dirname, '../bot')), reference: digest(path.resolve(args.reference)),
  engine: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../reference/src/game-engine.ts'))).digest('hex') };
const games = [];
for (const mapMode of MAP_MODES) for (let seed = 0; seed < seeds; seed++) for (let seat = 0; seat < 2; seat++) {
  const result = runMatch({ mapMode, seed: `multiline-v3-${seed}`, maxTurns: turns,
    mapSize: 0.5, multiLine: true,
    policies: [0, 1].map(p => p === seat && !baseline
      ? state => chooseActions(state, current(state)) : old) });
  const outcome = result.winner === null ? 'unresolved' : result.winner === seat ? 'win' : 'loss';
  const row = { mapMode, seed, seat, outcome, turns: result.turns,
    operations: result.stats.map(s => ({ attacks: s.attacks, builds: s.builds, upgrades: s.upgrades, rejected: s.rejected })),
    materialRatio: result.materialScore[seat] / Math.max(1, result.materialScore[1 - seat]) };
  games.push(row);
  process.stdout.write(JSON.stringify(row) + '\n');
}
const count = outcome => games.filter(g => g.outcome === outcome).length;
const report = { baseline, turns, seeds, size: 0.5, manifest, games, wins: count('win'), losses: count('loss'),
  unresolved: count('unresolved'), unresolvedRate: count('unresolved') / games.length,
  meanMaterialRatio: games.reduce((a, g) => a + g.materialRatio, 0) / games.length };
fs.writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ baseline, wins: report.wins, losses: report.losses, unresolved: report.unresolved, unresolvedRate: report.unresolvedRate, meanMaterialRatio: report.meanMaterialRatio }));
