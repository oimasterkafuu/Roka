// 验证「截断捐赠循环」假说：重跑对局，统计 CUR 每次截断打击后瓶颈格归属变化。
// 用法：node data/scratch/cutoff-cycle.cjs <mapMode> <seed> <seat> [turns]
const { runMatch } = require('/root/roka/bot-template/anti-human-bot/training/arena.cjs');
const current = require(process.env.CURPOLICY || '/root/roka/bot-template/anti-human-bot/bot/policy.cjs').chooseAction;
const premacro = require('/root/roka/bot-template/anti-human-bot/training/premacro/policy.cjs').chooseAction;

const [mapMode, seed, seatS, turnsS] = process.argv.slice(2);
const seat = Number(seatS), turns = Number(turnsS || 1500);
const owner = (v) => (v > 0 && v < 200 ? v % 50 : 0);

let state0 = null;
const strikes = []; // {turn, x,y, dx,dy, reason}
const policies = [0, 1].map((p) => (state) => {
  if (p === seat) {
    state0 = state;
    const a = current(state);
    if (a && a.kind === 'attack' && /截断/.test(String(a.reason)))
      strikes.push({ turn: state.turn, from: a.x * state.m + a.y, to: a.dx * state.m + a.dy, reason: String(a.reason) });
    return a;
  }
  return premacro(state);
});
// 包装 runMatch 逐步观察瓶颈归属：用 tracker 侧记录每 tick grid
const frames = [];
const wrapped = [0, 1].map((p) => (state) => {
  if (p === seat && state.turn % 1 === 0) frames.push({ turn: state.turn, grid: state.grid.slice(), army: state.army.slice(), m: state.m });
  return policies[p](state);
});
const result = runMatch({ mapMode, seed: `calm-${seed}`, mapSize: 0.5, maxTurns: turns, policies: wrapped });
console.log(`ended=${result.ended} winner=${result.winner} turns=${result.turns} 截断动作=${strikes.length}`);
const me = seat + 1;
let cycles = 0, held = 0;
const byChoke = new Map();
for (const s of strikes) {
  const f2 = frames.find((f) => f.turn === s.turn + 2);
  if (!f2) continue;
  const heldNow = owner(f2.grid[s.to]) === me;
  if (heldNow) held++; else cycles++;
  const key = s.to;
  byChoke.set(key, (byChoke.get(key) || 0) + 1);
}
console.log(`打击后 2tick 仍持有=${held} 已丢失=${cycles}`);
const repeated = [...byChoke.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
console.log(`被反复打击(>=3次)的瓶颈: ${repeated.length ? repeated.map(([c, n]) => `#${c}×${n}`).join(' ') : '无'}`);
// 同一瓶颈 10 tick 内重复打击 = 捐赠循环
let loopHits = 0;
for (let i = 1; i < strikes.length; i++)
  if (strikes[i].to === strikes[i - 1].to && strikes[i].turn - strikes[i - 1].turn <= 10) loopHits++;
console.log(`10tick 内同瓶颈重复打击=${loopHits}`);
const s = result.stats[seat], o = result.stats[1 - seat];
console.log(`CUR: army=${s.army} land=${s.land} | OLD: army=${o.army} land=${o.land}`);
