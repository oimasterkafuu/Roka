// 诊断 A/B 败局：重跑指定对局，跟踪 current bot 的皇冠/首都沦陷过程。
// 用法：node data/scratch/ab-loss.cjs <mapMode> <seed> <seat> [turns]
const { runMatch } = require('/root/roka/bot-template/anti-human-bot/training/arena.cjs');
const current = require('/root/roka/bot-template/anti-human-bot/bot/policy.cjs').chooseAction;
const premacro = require('/root/roka/bot-template/anti-human-bot/training/premacro/policy.cjs').chooseAction;

const [mapMode, seed, seatS, turnsS] = process.argv.slice(2);
const seat = Number(seatS), turns = Number(turnsS || 1500);
const owner = (v) => (v > 0 && v < 200 ? v % 50 : 0);

let lastSnap = null;
const events = [];
const policies = [0, 1].map((p) => (state) => {
  const me = state.playerId;
  const isMe = p === seat;
  // 每 50 tick 快照我方领地概况
  if (state.turn % 50 === 0) {
    let land = 0, army = 0, crowns = 0, capital = -1, capitalArmy = 0, maxPile = 0;
    for (let i = 0; i < state.grid.length; i++) {
      if (owner(state.grid[i]) !== me) continue;
      land++; army += state.army[i];
      if (state.grid[i] === me + 100) { crowns++; if (state.army[i] > capitalArmy) { capitalArmy = state.army[i]; capital = i; } }
      if (state.army[i] > maxPile) maxPile = state.army[i];
    }
    const snap = { turn: state.turn, side: isMe ? 'CUR' : 'OLD', land, army, crowns, capitalArmy, maxPile };
    if (isMe) {
      if (lastSnap && snap.crowns < lastSnap.crowns)
        events.push(`t${state.turn} CUR 皇冠数 ${lastSnap.crowns}->${crowns}（首都兵 ${lastSnap.capitalArmy}->${capitalArmy}，地 ${lastSnap.land}->${land}）`);
      lastSnap = snap;
    }
  }
  return isMe ? current(state) : premacro(state);
});
const result = runMatch({ mapMode, seed: `calm-${seed}`, mapSize: 0.5, maxTurns: turns, policies });
console.log(`ended=${result.ended} winner=${result.winner} turns=${result.turns}`);
console.log(events.join('\n') || '(CUR 无皇冠损失事件)');
const s = result.stats[seat], o = result.stats[1 - seat];
console.log(`CUR: army=${s.army} land=${s.land} | OLD: army=${o.army} land=${o.land}`);
