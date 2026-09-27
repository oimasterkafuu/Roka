// 症状分析：绕圈 / 拒攻皇冠 / 龟缩 / 无效分兵
const fs = require('fs');
const dir = 'data/observe-RMtDIbE7rDS6';
const decisions = fs.readFileSync(`${dir}/decisions-p1.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const frames = fs.readFileSync(`${dir}/frames.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
const { n, m } = meta;
const ME = 2;
const owner = (v) => (v > 0 && v < 200 ? v % 50 : 0);
const at = (x, y) => x * m + y;
const frameAt = (t) => frames[t];

// ── 1) 往返倒兵：同一对格子 A->B 后 8 tick 内又 B->A ──
console.log('=== 往返倒兵（8 tick 窗口内反向）===');
const recent = [];
let pingpong = 0;
const pingpongWindows = [];
for (const r of decisions) {
  const a = r.action;
  if (!a || a.kind !== 'attack') continue;
  const from = at(a.x, a.y), to = at(a.dx, a.dy);
  const hit = recent.find((e) => e.from === to && e.to === from && r.turn - e.turn <= 8);
  if (hit) {
    pingpong++;
    if (pingpongWindows.length < 15)
      pingpongWindows.push(`t${hit.turn} (${a.dx},${a.dy})->(${a.x},${a.y}) [${hit.branch}] ⇄ t${r.turn} (${a.x},${a.y})->(${a.dx},${a.dy}) [${r.branch}] ${r.reason || ''}`);
  }
  recent.push({ from, to, turn: r.turn, branch: r.branch });
  while (recent.length > 40) recent.shift();
}
console.log(`总反向次数 ${pingpong}`);
console.log(pingpongWindows.join('\n'));

// ── 2) supply / economy-fund 目标抖动：相邻 tick 集结点是否频繁变化 ──
console.log('\n=== supply/fund 集结点抖动 ===');
let lastTarget = null, flips = 0, runs = [], runStart = null, runLen = 0;
const flipSamples = [];
for (const r of decisions) {
  let target = null;
  if (r.reason && r.reason[0] === '{') {
    try { const j = JSON.parse(r.reason); target = j.target ?? null; } catch {}
  }
  const key = (r.branch || '') + ':' + target;
  if (target !== null) {
    if (lastTarget !== null && key !== lastTarget) {
      flips++;
      if (flipSamples.length < 20) flipSamples.push(`t${r.turn - 1} ${lastTarget} -> t${r.turn} ${key}`);
    }
    lastTarget = key;
  }
}
console.log(`目标变化次数 ${flips}`);
console.log(flipSamples.join('\n'));

// ── 3) 皇冠在面前不打：bot 格贴敌皇冠、相邻我方兵力合计>=守军，但当 tick 未攻击该皇冠 ──
console.log('\n=== 贴脸皇冠未攻（合计兵力足够）===');
const missed = [];
for (let t = 60; t < frames.length; t++) {
  const f = frames[t];
  const d = decisions[t];
  for (let i = 0; i < f.grid_type.length; i++) {
    if (f.grid_type[i] !== 101) continue; // 敌皇冠 (owner 1)
    const x = Math.floor(i / m), y = i % m;
    const adjMine = [];
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= n || ny < 0 || ny >= m) continue;
      const j = at(nx, ny);
      if (owner(f.grid_type[j]) === ME && !f.isolated[j]) adjMine.push({ j, army: f.army_cnt[j] });
    }
    if (!adjMine.length) continue;
    const total = adjMine.reduce((s, c) => s + Math.max(0, c.army - 1), 0);
    const D = f.army_cnt[i];
    if (total < D) continue;
    // 当 tick 是否有任一 adjMine 打向该皇冠
    const attacked = d && d.action && d.action.kind === 'attack' && at(d.action.dx, d.action.dy) === i;
    if (!attacked) {
      missed.push({ t, crown: [x, y], D, total, adj: adjMine.map((c) => `${Math.floor(c.j / m)},${c.j % m}=${c.army}`).join(' '), branch: d?.branch, reason: d?.reason });
    }
  }
}
console.log(`合计 ${missed.length} 次`);
for (const s of missed.slice(0, 25)) console.log(`t${s.t} 皇冠(${s.crown}) 守${s.D} 我方邻兵合${s.total} [${s.adj}] 分支=${s.branch} ${s.reason || ''}`);

// ── 4) 劣势期行为构成（t>=900）──
console.log('\n=== t>=900 分支构成 ===');
const late = {};
for (const r of decisions) if (r.turn >= 900) late[r.branch || 'null'] = (late[r.branch || 'null'] || 0) + 1;
console.log(JSON.stringify(late));

// ── 5) supply 运输量分布（小勺分兵）──
console.log('\n=== supply 单次运输量分布 ===');
const amounts = [];
for (const r of decisions) {
  if (r.branch !== 'supply' || !r.reason) continue;
  try { const j = JSON.parse(r.reason); if (j.amount != null) amounts.push({ t: r.turn, amount: j.amount, target: j.target, dist: j.distanceBefore }); } catch {}
}
amounts.sort((a, b) => a.amount - b.amount);
if (amounts.length) {
  const q = (p) => amounts[Math.floor(p * (amounts.length - 1))].amount;
  console.log(`n=${amounts.length} min=${q(0)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${q(1)}`);
  const small = amounts.filter((a) => a.amount < 20).length;
  console.log(`<20 兵的运输 ${small} 次 (${((100 * small) / amounts.length).toFixed(0)}%)`);
}
