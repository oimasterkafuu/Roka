const fs = require('fs');
const path = require('path');
const dir = 'data/observe-RMtDIbE7rDS6';
const BOT = '/root/roka/bot-template/anti-human-bot/bot';
const { chooseLogistics } = require(path.join(BOT, 'logistics.cjs'));
const frames = fs.readFileSync(`${dir}/frames.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
const { n, m } = meta;
const state = { n, m, playerId: 2, teams: { 1: 1, 2: 2 }, grid: null, army: null,
  isolated: null, fog: null, turn: -1, ended: false, dead: false, lastMove: null };
for (let t = 105; t <= 200; t++) {
  const f = frames[t];
  state.grid = f.grid_type; state.army = f.army_cnt; state.isolated = f.isolated; state.turn = t;
  const a = chooseLogistics(state, null, null, { economyOnly: true });
  const r = a?.reason;
  if (r?.code === 'economy-fund') console.log(`t${t} fund target=${r.target} (${Math.floor(r.target / m)},${r.target % m}) amount=${r.amount}`);
  else if (a?.kind === 'build') console.log(`t${t} BUILD ${a.op} (${a.x},${a.y})`);
  else console.log(`t${t} null`);
}
