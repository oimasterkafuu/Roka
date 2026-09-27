// 定点诊断：绕圈窗口 / 拒攻皇冠 evaluate 拒绝码 / supply 死喂
const fs = require('fs');
const path = require('path');
const dir = 'data/observe-RMtDIbE7rDS6';
const BOT = '/root/roka/bot-template/anti-human-bot/bot';
const { createFrontline } = require(path.join(BOT, 'frontline.cjs'));
const { chooseLogistics } = require(path.join(BOT, 'logistics.cjs'));
const { chooseDefense } = require(path.join(BOT, 'defense.cjs'));

const frames = fs.readFileSync(`${dir}/frames.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const decisions = fs.readFileSync(`${dir}/decisions-p1.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
const { n, m } = meta;
const ME = 2;
const at = (x, y) => x * m + y;

function mkState(t) {
  const f = frames[t];
  return { n, m, playerId: ME, teams: { 1: 1, 2: 2 }, grid: f.grid_type, army: f.army_cnt,
    isolated: f.isolated, fog: null, turn: t, ended: false, dead: false, lastMove: null };
}

// ── A. 绕圈窗口 t474–t542 逐 tick 动作 ──
console.log('=== A. t474–t542 逐 tick ===');
for (let t = 474; t <= 542; t++) {
  const r = decisions[t];
  const a = r.action;
  const act = a ? (a.kind === 'build' ? `build ${a.op} (${a.x},${a.y})` : `(${a.x},${a.y})->(${a.dx},${a.dy}) mode${a.mode}`) : 'null';
  console.log(`t${t} [${r.branch}] ${act} ${r.reason || ''}`.slice(0, 180));
}

// ── B. t416 拒攻皇冠(7,9)：evaluate 现场 ──
console.log('\n=== B. t416–t420 (8,9)->皇冠(7,9) evaluate ===');
for (const t of [416, 417, 418, 419, 420]) {
  const state = mkState(t);
  const front = createFrontline(state, {});
  const f = frames[t];
  console.log(`t${t}: (8,9)兵=${f.army_cnt[at(8, 9)]} 皇冠(7,9)守=${f.army_cnt[at(7, 9)]} grid=${f.grid_type[at(7, 9)]}`);
  const result = front.assess({ x: 8, y: 9, dx: 7, dy: 9, mode: 1 });
  console.log('  assess:', result ? JSON.stringify(result) : 'null');
  console.log('  rejected:', JSON.stringify(front.diagnostics.rejected), 'examples:', JSON.stringify(front.diagnostics.examples.slice(0, 3)));
}

// ── C. supply 死喂：t416–t420 的 rally=84/100 required=508 是否合理 ──
console.log('\n=== C. t416 supply 明细 ===');
{
  const state = mkState(416);
  const r = chooseLogistics(state, null, null, { militaryOnly: true, allowStartBatch: true });
  console.log(JSON.stringify(r?.reason, null, 1));
  const f = frames[416];
  const tgt = r?.reason?.target;
  if (tgt != null) {
    console.log(`rally 格 (${Math.floor(tgt / m)},${tgt % m}) 现有兵=${f.army_cnt[tgt]}`);
    const enemy = r.reason.forecast?.enemyTarget;
    if (enemy != null) console.log(`目标敌格 (${Math.floor(enemy / m)},${enemy % m}) 守=${f.army_cnt[enemy]} grid=${f.grid_type[enemy]}`);
  }
}

// ── D. 劣势期 t1000：bot 最大兵堆在做什么 ──
console.log('\n=== D. t1000/t1200/t1400 局面 + 动作 ===');
for (const t of [1000, 1200, 1400]) {
  const f = frames[t];
  const r = decisions[t];
  let piles = [];
  for (let i = 0; i < f.grid_type.length; i++) {
    if (f.grid_type[i] > 0 && f.grid_type[i] < 200 && f.grid_type[i] % 50 === ME && f.army_cnt[i] > 30)
      piles.push({ i, army: f.army_cnt[i] });
  }
  piles.sort((a, b) => b.army - a.army);
  const top = piles.slice(0, 5).map((p) => `(${Math.floor(p.i / m)},${p.i % m})=${p.army}`).join(' ');
  const a = r.action;
  console.log(`t${t} 我堆: ${top}`);
  console.log(`  动作 [${r.branch}] ${a ? JSON.stringify(a) : 'null'} ${r.reason || ''}`.slice(0, 200));
}
