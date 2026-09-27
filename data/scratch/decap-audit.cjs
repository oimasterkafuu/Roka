// 斩首成果审计：每次斩首/合力打击后，目标皇冠 1-2 tick 内的归属与守军变化。
// 用法：node data/scratch/decap-audit.cjs <mapMode> <seed> <seat> [turns]
const { runMatch } = require('/root/roka/bot-template/anti-human-bot/training/arena.cjs');
const current = require(process.env.CURPOLICY || '/root/roka/bot-template/anti-human-bot/bot/policy.cjs').chooseAction;
const premacro = require('/root/roka/bot-template/anti-human-bot/training/premacro/policy.cjs').chooseAction;

const [mapMode, seed, seatS, turnsS] = process.argv.slice(2);
const seat = Number(seatS), turns = Number(turnsS || 1500);
const me = seat + 1;
const owner = (v) => (v > 0 && v < 200 ? v % 50 : 0);
const frames = [];
const strikes = [];
const policies = [0, 1].map((p) => (state) => {
  if (p !== seat) return premacro(state);
  frames.push({ turn: state.turn, grid: state.grid.slice(), army: state.army.slice(), m: state.m });
  const a = current(state);
  if (a && a.kind === 'attack' && /斩首|攻冠/.test(String(a.reason))) {
    const f = frames[frames.length - 1];
    const to = a.dx * f.m + a.dy, from = a.x * f.m + a.y;
    strikes.push({ turn: state.turn, to, fromArmy: f.army[from], garrison: f.army[to], reason: String(a.reason).slice(0, 40) });
  }
  return a;
});
const result = runMatch({ mapMode, seed: `calm-${seed}`, mapSize: 0.5, maxTurns: turns, policies });
console.log(`ended=${result.ended} winner=${result.winner} turns=${result.turns} 斩首类打击=${strikes.length}`);
let captured = 0, failed = 0;
for (const s of strikes) {
  const f2 = frames.find((f) => f.turn === s.turn + 2);
  if (!f2) continue;
  const mine = owner(f2.grid[s.to]) === me;
  if (mine) captured++; else failed++;
  if (strikes.length <= 40)
    console.log(`t${s.turn} 目标#${s.to} 守${s.garrison} 源${s.fromArmy} → 2tick后${mine ? '我方持有' : `未持有(守军${f2.army[s.to]})`} ${s.reason}`);
}
console.log(`2tick后持有=${captured} 未持有=${failed}`);
const s = result.stats[seat], o = result.stats[1 - seat];
console.log(`CUR: army=${s.army} land=${s.land} | OLD: army=${o.army} land=${o.land}`);
