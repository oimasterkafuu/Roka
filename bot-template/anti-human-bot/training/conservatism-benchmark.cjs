'use strict';
/*
 * 保守度/胜率基准：current（bot/）对指定对手，双方各坐一次先手。
 * 判定：歼灭胜 > 物资碾压（army+land 比 ≥1.5） > 均势 > 被碾压 > 被歼灭。
 * 用法:
 *   node training/conservatism-benchmark.cjs --opponent=prevconservative --modes=random,maze --seeds=4 --turns=2500
 *   node training/conservatism-benchmark.cjs --shard=0/6 ...
 */
const fs = require('node:fs');
const path = require('node:path');
const { runMatch, MAP_MODES } = require('./arena.cjs');

const args = Object.fromEntries(process.argv.slice(2).map((x) => x.replace(/^--/, '').split('=')));
const opponentName = args.opponent || 'prevconservative';
const currentName = args.current || 'bot';
const CURRENT = {
  bot: () => require('../bot/policy.cjs').chooseAction,
  prevconservative: () => require('./prevconservative/policy.cjs').chooseAction,
  precampaign: () => require('./precampaign/policy.cjs').chooseAction,
  preresilience: () => require('./preresilience/policy.cjs').chooseAction,
};
if (!CURRENT[currentName]) throw new Error(`未知 current: ${currentName}`);
const current = CURRENT[currentName]();
const OPPONENTS = {
  prevconservative: () => require('./prevconservative/policy.cjs').chooseAction,
  precampaign: () => require('./precampaign/policy.cjs').chooseAction,
  preresilience: () => require('./preresilience/policy.cjs').chooseAction,
  preburst: () => require('./preburst/policy.cjs').chooseAction,
  prearchitecture: () => require('./prearchitecture/policy.cjs').chooseAction,
  self: () => current,
};
if (!OPPONENTS[opponentName]) throw new Error(`未知对手: ${opponentName}`);
const opponent = OPPONENTS[opponentName]();
const modes = (args.modes || MAP_MODES.join(',')).split(',');
for (const mode of modes) if (!MAP_MODES.includes(mode)) throw new Error(`未知地图: ${mode}`);
const seeds = Number(args.seeds || 4);
const turns = Number(args.turns || 2500);
const size = Number(args.size || 0.5);
const [shardIndex, shardCount] = (args.shard || '0/1').split('/').map(Number);
const overrideParams = args.params ? JSON.parse(args.params) : null;

const owner = (v) => (v > 0 && v < 200 ? v % 50 : 0);

/** 采样一侧的战争经济指标；每 tick 调用，内部按 25 tick 抽样。 */
function tracker(state, me) {
  const metrics = { samples: 0, land: 0, army: 0, crowns: 0, cities: 0, buildings: 0, borderPile: 0, maxPile: 0, innerPile: 0 };
  const fn = (turn) => {
    if (turn % 25 !== 0) return;
    const { n, m, grid, army } = state;
    const size = n * m;
    const ns = (i) => {
      const out = [];
      if (i >= m) out.push(i - m);
      if (i % m) out.push(i - 1);
      if (i % m + 1 < m) out.push(i + 1);
      if (i + m < size) out.push(i + m);
      return out;
    };
    metrics.samples++;
    let sLand = 0, sArmy = 0, sCrowns = 0, sCities = 0, sBorder = 0, sInner = 0, sMax = 0;
    for (let i = 0; i < size; i++) {
      if (owner(grid[i]) !== me) continue;
      sLand++; sArmy += army[i];
      if (grid[i] === me + 100) sCrowns++;
      if (grid[i] === me + 50) sCities++;
      if (army[i] >= 50) sMax = Math.max(sMax, army[i]);
      const front = ns(i).some((j) => owner(grid[j]) > 0 && owner(grid[j]) !== me);
      if (front) sBorder += army[i];
      else if (army[i] > 1) sInner += army[i] - 1;
    }
    metrics.land += sLand; metrics.army += sArmy; metrics.crowns += sCrowns; metrics.cities += sCities;
    metrics.buildings += sCrowns + sCities;
    metrics.borderPile += sBorder; metrics.innerPile += sInner; metrics.maxPile = Math.max(metrics.maxPile, sMax);
    metrics.crownsLast = sCrowns; metrics.landLast = sLand; metrics.armyLast = sArmy;
    metrics.borderPileLast = sBorder; metrics.innerPileLast = sInner;
  };
  return { fn, metrics };
}
function mean(metrics, key) {
  if (!metrics || !metrics.samples) return null;
  return Number((metrics[key] / metrics.samples).toFixed(2));
}

function runOne({ mapMode, seed, seat }) {
  const sides = [null, null];
  const trackers = [null, null];
  const policies = [0, 1].map((p) => (state) => {
    if (!trackers[p]) trackers[p] = tracker(state, state.playerId);
    trackers[p].fn(state.turn);
    return p === seat ? current(state, overrideParams ?? undefined) : opponent(state);
  });
  const result = runMatch({ mapMode, seed: `calm-${seed}`, mapSize: size, maxTurns: turns, policies });
  const found = [0, 1].map((p) => ({ player: p, ...result.stats[p] }));
  const mine = found[seat];
  const theirs = found[1 - seat];
  const myMat = (mine.army || 0) + (mine.land || 0);
  const foeMat = (theirs.army || 0) + (theirs.land || 0);
  const ratio = foeMat > 0 ? myMat / foeMat : myMat > 0 ? Infinity : 1;
  const myLand = mine.land || 0, foeLand = theirs.land || 0;
  const crownLead = (trackers[seat]?.metrics.crownsLast || 0) - (trackers[1 - seat]?.metrics.crownsLast || 0);
  let outcome;
  if (result.ended && result.winner === seat) outcome = 'elimination_win';
  else if (result.ended && result.winner === 1 - seat) outcome = 'elimination_loss';
  else if (ratio >= 1.5 || myLand >= 2 * Math.max(1, foeLand) || crownLead >= 3) outcome = 'dominant';
  else if (ratio <= 1 / 1.5 || foeLand >= 2 * Math.max(1, myLand) || crownLead <= -3) outcome = 'dominated';
  else outcome = 'even';
  return { mapMode, seed, seat, turns: result.turns, ended: result.ended, winner: result.winner, outcome,
    myMat, foeMat, ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : null, crownLead,
    my: details(mine), foe: details(theirs),
    metrics: { me: sideMetrics(trackers[seat]), foe: sideMetrics(trackers[1 - seat]) },
    builds: result.builds.filter((b) => b.player === seat).length,
    foeBuilds: result.builds.filter((b) => b.player === 1 - seat).length,
  };
}
const details = (s) => ({ army: s.army, land: s.land, class_: s.class_ });
function sideMetrics(tracker) {
  return tracker?.metrics ?? null;
}

const jobs = [];
for (const mapMode of modes) for (let s = 0; s < seeds; s++) for (const seat of [0, 1]) {
  if (jobs.length % shardCount === shardIndex) jobs.push({ mapMode, seed: `${mapMode}-${s}`, seat });
}
const matches = [];
const start = Date.now();
for (const job of jobs) {
  const entry = runOne(job);
  matches.push(entry);
  process.stderr.write(`[${matches.length}/${jobs.length}] ${entry.mapMode} seed=${entry.seed} seat=${entry.seat} → ${entry.outcome} ratio=${entry.ratio} myCrowns=${entry.metrics.me?.crowns ?? '-'} foeCrowns=${entry.metrics.foe?.crowns ?? '-'} turns=${entry.turns}\n`);
}
const summary = { current: currentName, opponent: opponentName, games: matches.length, outcome: {}, byMap: {}, wallMs: Date.now() - start };
for (const m of matches) {
  summary.outcome[m.outcome] = (summary.outcome[m.outcome] || 0) + 1;
  const map = (summary.byMap[m.mapMode] ||= {});
  map[m.outcome] = (map[m.outcome] || 0) + 1;
}
const wins = (summary.outcome.elimination_win || 0) + (summary.outcome.dominant || 0);
const losses = (summary.outcome.elimination_loss || 0) + (summary.outcome.dominated || 0);
summary.winRate = matches.length ? Number((wins / matches.length).toFixed(3)) : null;
summary.lossRate = matches.length ? Number((losses / matches.length).toFixed(3)) : null;
const avg = (pick) => {
  const values = matches.map(pick).filter((v) => Number.isFinite(v));
  return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null;
};
summary.means = {
  myCrowns: avg((m) => mean(m.metrics.me, 'crowns')), foeCrowns: avg((m) => mean(m.metrics.foe, 'crowns')),
  myFinalLand: avg((m) => m.my.land), foeFinalLand: avg((m) => m.foe.land),
  myLandShare: avg((m) => m.my.land / Math.max(1, m.my.land + m.foe.land)),
  myBorderPile: avg((m) => mean(m.metrics.me, 'borderPile')), myInnerPile: avg((m) => mean(m.metrics.me, 'innerPile')),
  myMaxPile: avg((m) => mean(m.metrics.me, 'maxPile')),
  myBuildings: avg((m) => mean(m.metrics.me, 'buildings')), foeBuildings: avg((m) => mean(m.metrics.foe, 'buildings')),
  builds: avg((m) => m.builds), foeBuilds: avg((m) => m.foeBuilds),
  ratio: avg((m) => m.ratio),
};
const label = args.label || '';
const output = args.output || `training/results/conservatism-${currentName}-vs-${opponentName}${label}${args.shard ? `-${shardIndex}` : ''}.json`;
fs.writeFileSync(output, JSON.stringify({ createdAt: new Date().toISOString(), config: { currentName, opponentName, modes, seeds, turns, size, shard: args.shard || '0/1' }, summary, matches }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`→ ${output}`);
