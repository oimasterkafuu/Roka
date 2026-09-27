// 对局概览：双方 land/army 曲线 + bot 实际操作统计
const fs = require('fs');
const dir = 'data/observe-RMtDIbE7rDS6';
const lines = fs.readFileSync(`${dir}/frames.jsonl`, 'utf8').trim().split('\n');
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
const { n, m } = meta;
const ME = 2; // Anti_Human = player index 1 -> owner code 2
const owner = (v) => (v > 0 && v < 200 ? v % 50 : 0);
let prev = null;
for (const line of lines) {
  const f = JSON.parse(line);
  if (f.turn % 100 !== 0 && f.turn !== meta.totalTurns) continue;
  let myLand = 0, myArmy = 0, foeLand = 0, foeArmy = 0, myCrowns = 0, foeCrowns = 0;
  for (let i = 0; i < f.grid_type.length; i++) {
    const o = owner(f.grid_type[i]);
    if (o === ME) { myLand++; myArmy += f.army_cnt[i]; if (f.grid_type[i] === ME + 100) myCrowns++; }
    else if (o === 1) { foeLand++; foeArmy += f.army_cnt[i]; if (f.grid_type[i] === 101) foeCrowns++; }
  }
  console.log(`t=${f.turn}\t我 地${myLand} 兵${myArmy} 冠${myCrowns}\t敌 地${foeLand} 兵${foeArmy} 冠${foeCrowns}`);
}
