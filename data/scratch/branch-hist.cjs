// 分支分布对比：CUR 每个 tick 选了什么类型的动作。
// 用法：node data/scratch/branch-hist.cjs <mapMode> <seed> <seat> [turns]
const { runMatch } = require('/root/roka/bot-template/anti-human-bot/training/arena.cjs');
const current = require(process.env.CURPOLICY || '/root/roka/bot-template/anti-human-bot/bot/policy.cjs').chooseAction;
const premacro = require('/root/roka/bot-template/anti-human-bot/training/premacro/policy.cjs').chooseAction;

const [mapMode, seed, seatS, turnsS] = process.argv.slice(2);
const seat = Number(seatS), turns = Number(turnsS || 1500);
const hist = {};
const classify = (a) => {
  if (!a) return 'null';
  if (a.kind === 'build') return 'build';
  const r = typeof a.reason === 'string' ? a.reason : JSON.stringify(a.reason || {});
  if (/斩首/.test(r)) return '斩首';
  if (/截断/.test(r)) return '截断';
  if (/脖子/.test(r)) return 'neck';
  if (/frontline-supply|logistics-transport/.test(r)) return 'supply';
  if (/economy-fund/.test(r)) return 'fund';
  if (/防守|截击|汇兵|救/.test(r)) return 'defense';
  if (/推进|交换|冲击|攻冠|攻指挥所/.test(r)) return 'advance';
  if (/campaign/.test(r)) return 'campaign';
  return 'other:' + r.slice(0, 24);
};
const policies = [0, 1].map((p) => (state) => {
  if (p !== seat) return premacro(state);
  const a = current(state);
  const c = classify(a);
  hist[c] = (hist[c] || 0) + 1;
  return a;
});
const result = runMatch({ mapMode, seed: `calm-${seed}`, mapSize: 0.5, maxTurns: turns, policies });
console.log(`ended=${result.ended} winner=${result.winner} turns=${result.turns}`);
console.log(Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
const s = result.stats[seat], o = result.stats[1 - seat];
console.log(`CUR: army=${s.army} land=${s.land} | OLD: army=${o.army} land=${o.land}`);
