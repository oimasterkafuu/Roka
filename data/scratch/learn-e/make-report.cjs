// 读取 metrics.json，生成 REPORT.md（_E_ 28 场回放定量画像报告）。
// 用法：node data/scratch/learn-e/make-report.cjs

const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = '/root/roka/data/scratch/learn-e';
const games = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'metrics.json'), 'utf8'));

const E = '_E_';
const AH = 'Anti_Human';

const eIdx = (g) => g.meta.playerNames.indexOf(E);
// metrics.json 的 stats 是按 participants 顺序的紧凑数组，用 player 名检索
const statOf = (g, p) => g.stats.find((s) => s.player === g.meta.playerNames[p]);
const eStats = (g) => statOf(g, eIdx(g));
const oppIdxs = (g) => g.participants.filter((p) => p !== eIdx(g));
const is2p = (g) => g.participants.length === 2;
// 任务给定的分组（bDftoXbSi4gy/bIEKPrin823T 含观战者，归多人局，不计入两人局对比）
const AH12 = new Set([
  '1qmeWnEhMIwA', 'JkvzueUC60Z4', 'PBZRX08Q1+sg', 'RMtDIbE7rDS6', 'Y7NN2uWZz8gH', 'g239Ix9E0gry',
  'iPA7eyU1dLsJ', 'ijG6zLBP8w-O', 'jlmsQkVYbNJH', 'nJNUVO1TY8jT', 'rjWdYp6MCoF0', 'tof+ILhM68KG',
]);
const YUELAN12 = new Set([
  '4dV4aUcA2RoA', '66rTa5HhU2vE', 'Gx+HNXQrgYg1', 'MqzBCVOjfdu-', 'R91JGT+JP0U6', 'YfXg3fEUVN5I',
  'mcoNGCBI04Le', 'n2fy2xeLNIOI', 'pFzs3uU-XeVF', 'qcaU1bFhDgid', 'tZpe9c8xmCqc', 'wjCb7pIKf9ZF',
]);
const isAH = (g) => AH12.has(g.replayId);
const isYuelan = (g) => YUELAN12.has(g.replayId);
const eWon = (g) => g.winnerNames.includes(E);
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`);
const f1 = (x) => (x === null || x === undefined ? '—' : x.toFixed(1));
const mean = (arr) => {
  const v = arr.filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const modeStr = (s) => {
  const t = s.modeDist[0] + s.modeDist[1] + s.modeDist[2];
  if (!t) return '—';
  return `${pct(s.modeDist[0] / t)}/${pct(s.modeDist[1] / t)}/${pct(s.modeDist[2] / t)}`;
};
const phaseDist = (ticks, total) => {
  const ph = [0, 0, 0]; // <=50 / 51-200 / >200
  for (const t of ticks) {
    if (t <= 50) ph[0] += 1;
    else if (t <= 200) ph[1] += 1;
    else ph[2] += 1;
  }
  const s = ph[0] + ph[1] + ph[2];
  return s ? `${ph[0]}/${ph[1]}/${ph[2]}` : '0/0/0';
};

const fmtAction = (g, a) => {
  const who = g.meta.playerNames[a.p];
  if (a.kind === 'build') {
    return `${who} 建${a.buildKind === 'b' ? '指挥所' : '主城'}@(${a.x},${a.y}) 格兵${a.srcArmy}`;
  }
  const clsCN = { expand: '扩张', attack: '攻击', transport: '运输' }[a.cls];
  return `${who} 移动 (${a.sx},${a.sy})->(${a.tx},${a.ty}) mode${a.mode} 兵${a.srcArmy} [${clsCN}${
    a.cls === 'attack' ? ':' + a.dstOwner : ''
  }]`;
};
const actionsAt = (g, tick, span = 0) =>
  g.actionLog.filter((a) => a.tick >= tick - span && a.tick <= tick + span);
const armyAt = (g, t, p) => g.armyCurve[Math.min(t, g.armyCurve.length - 1)][p];
const landAt = (g, t, p) => g.landCurve[Math.min(t, g.landCurve.length - 1)][p];

// 为一个 2p 局挑选对比实例 tick
const pickInstances = (g) => {
  const ei = eIdx(g);
  const oi = oppIdxs(g)[0];
  const es = statOf(g, ei);
  const os = statOf(g, oi);
  const picks = [];
  if (es.firstAttackTick) picks.push({ label: 'E 首攻', tick: es.firstAttackTick });
  if (os.firstAttackTick) picks.push({ label: `${g.meta.playerNames[oi]} 首攻`, tick: os.firstAttackTick });
  if (!eWon(g)) {
    if (g.turning.lastLeadTick !== null && g.turning.lastLeadTick !== undefined) {
      picks.push({ label: 'E 兵力转落后', tick: g.turning.lastLeadTick });
    } else {
      picks.push({ label: 'E 兵力峰值比时刻（终局兵力仍领先，输在斩首）', tick: g.turning.peakRatioTick });
    }
  } else {
    const cap = g.events.find(
      (ev) => (ev.type === 'post_fall' || ev.type === 'crown_fall') && ev.to === ei && ev.from === oi,
    );
    if (cap) picks.push({ label: cap.type === 'crown_fall' ? 'E 夺敌主城' : 'E 首夺敌指挥所', tick: cap.tick });
  }
  return picks.slice(0, 3);
};

const L = [];
L.push('# _E_ 28 场回放定量操作画像报告');
L.push('');
L.push('数据：`bot-template/anti-human-bot/training/replays-E/*.rpl`（28 局），逐 tick 用 GameEngine 全量重放。');
L.push('动作分类：移动目的地为己方=运输，中立=扩张，敌方=攻击（按动作发生前一帧的目的地归属判定）。');
L.push('兵力/领土曲线、事件均由重放帧计算；胜负按终帧领土归属判定。');
L.push('');

// ---------- 总览表 ----------
L.push('## 0. 每局总览');
L.push('');
L.push('| 回放 | 对手 | 图 | tick | 结果 | E移动率 | E mode 0/1/2 | E首攻 | 对手首攻 | E t50地/兵 | 对手 t50地/兵 |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const g of games) {
  const ei = eIdx(g);
  const es = statOf(g, ei);
  const opps = oppIdxs(g);
  const os = statOf(g, opps[0]);
  const oppNames = opps.map((p) => g.meta.playerNames[p]).join('+');
  const o50 = os.opening['50'];
  const e50 = es.opening['50'];
  L.push(
    `| ${g.replayId} | ${oppNames} | ${g.meta.mapMode} | ${g.finalTurn} | ${eWon(g) ? '胜' : '负'} | ${pct(
      es.moveTickRate,
    )} | ${modeStr(es)} | ${es.firstAttackTick ?? '—'} | ${os.firstAttackTick ?? '—'} | ${
      e50 ? `${e50.land}/${e50.army}` : '—'
    } | ${o50 ? `${o50.land}/${o50.army}` : '—'} |`,
  );
}
L.push('');

// 汇总
const groups = [
  ['E vs Anti_Human（12 局两人局）', games.filter(isAH)],
  ['E vs yuelan（12 局两人局）', games.filter(isYuelan)],
  ['多人局（4 局）', games.filter((g) => !isAH(g) && !isYuelan(g))],
];
L.push('### 汇总均值');
L.push('');
L.push('| 分组 | 胜场 | E移动率 | E首攻 | 对手首攻 | E t50 地 | E t50 兵 | 对手 t50 地 | 对手 t50 兵 |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const [name, gs] of groups) {
  const wins = gs.filter(eWon).length;
  const es = gs.map(eStats);
  const os = gs.map((g) => statOf(g, oppIdxs(g)[0]));
  L.push(
    `| ${name} | ${wins}/${gs.length} | ${f1(mean(es.map((s) => s.moveTickRate)) * 100)}% | ${f1(
      mean(es.map((s) => s.firstAttackTick)),
    )} | ${f1(mean(os.map((s) => s.firstAttackTick)))} | ${f1(
      mean(es.map((s) => s.opening['50'] && s.opening['50'].land)),
    )} | ${f1(mean(es.map((s) => s.opening['50'] && s.opening['50'].army)))} | ${f1(
      mean(os.map((s) => s.opening['50'] && s.opening['50'].land)),
    )} | ${f1(mean(os.map((s) => s.opening['50'] && s.opening['50'].army)))} |`,
  );
}
L.push('');

// ---------- 画像表 1：开局 ----------
L.push('## 1. 开局画像（E 的领土/兵力曲线）');
L.push('');
L.push('| 回放 | 结果 | t10 地/兵 | t25 地/兵 | t50 地/兵 | t75 地/兵 | t100 地/兵 | t200 地/兵 | t400 地/兵 |');
L.push('|---|---|---|---|---|---|---|---|');
for (const g of games) {
  const es = eStats(g);
  const cell = (t) => {
    const o = es.opening[t];
    return o ? `${o.land}/${o.army}` : '—';
  };
  L.push(
    `| ${g.replayId} | ${eWon(g) ? '胜' : '负'} | ${cell('10')} | ${cell('25')} | ${cell('50')} | ${cell(
      '75',
    )} | ${cell('100')} | ${cell('200')} | ${cell('400')} |`,
  );
}
L.push('');
L.push('### 分组均值（E）');
L.push('');
L.push('| 分组 | t10 | t25 | t50 | t75 | t100 |');
L.push('|---|---|---|---|---|---|');
for (const [name, gs] of groups) {
  const m = (t, k) => f1(mean(gs.map((g) => eStats(g).opening[t] && eStats(g).opening[t][k])));
  L.push(`| ${name} | ${m('10', 'land')}/${m('10', 'army')} | ${m('25', 'land')}/${m('25', 'army')} | ${m('50', 'land')}/${m('50', 'army')} | ${m('75', 'land')}/${m('75', 'army')} | ${m('100', 'land')}/${m('100', 'army')} |`);
}
L.push('');

// ---------- 画像表 2：进攻 ----------
L.push('## 2. 进攻画像（E）');
L.push('');
L.push('动作阶段分布格式：t≤50 / 51–200 / >200 的动作次数。');
L.push('');
L.push('| 回放 | 结果 | 首接壤 | 首攻 | 首建造(tick@位置,距主城) | 攻/扩/运 | 扩张阶段分布 | 攻击阶段分布 | mode 0/1/2 |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const g of games) {
  const es = eStats(g);
  const fb = es.firstBuild
    ? `t${es.firstBuild.tick} (${es.firstBuild.x},${es.firstBuild.y}) ${es.firstBuild.kind} d=${es.firstBuild.distToCrown}`
    : '—';
  L.push(
    `| ${g.replayId} | ${eWon(g) ? '胜' : '负'} | ${es.firstContactTick ?? '—'} | ${
      es.firstAttackTick ?? '—'
    } | ${fb} | ${es.attack}/${es.expand}/${es.transport} | ${phaseDist(es.expandTicks)} | ${phaseDist(
      es.attackTicks,
    )} | ${modeStr(es)} |`,
  );
}
L.push('');

// ---------- 画像表 3：效率 ----------
L.push('## 3. 效率画像（E）');
L.push('');
L.push('闲置兵力占比 = 距最近敌格曼哈顿距离>3 的己方格兵力 / 总兵力。');
L.push('');
L.push('| 回放 | 结果 | 移动tick率 | 建造tick率 | 闲置@50 | 闲置@100 | 闲置@200 | 闲置@400 |');
L.push('|---|---|---|---|---|---|---|');
for (const g of games) {
  const es = eStats(g);
  L.push(
    `| ${g.replayId} | ${eWon(g) ? '胜' : '负'} | ${pct(es.moveTickRate)} | ${pct(es.buildTickRate)} | ${pct(
      es.idle['50'],
    )} | ${pct(es.idle['100'])} | ${pct(es.idle['200'])} | ${pct(es.idle['400'])} |`,
  );
}
L.push('');
L.push('### 对照：对手效率（两人局）');
L.push('');
L.push('| 分组 | 对手移动tick率 | 对手闲置@50 | 对手闲置@100 | 对手闲置@200 | E移动tick率 | E闲置@50 | E闲置@100 | E闲置@200 |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const [name, gs] of groups.slice(0, 2)) {
  const os = gs.map((g) => statOf(g, oppIdxs(g)[0]));
  const es = gs.map(eStats);
  L.push(
    `| ${name} | ${pct(mean(os.map((s) => s.moveTickRate)))} | ${pct(mean(os.map((s) => s.idle['50'])))} | ${pct(
      mean(os.map((s) => s.idle['100'])),
    )} | ${pct(mean(os.map((s) => s.idle['200'])))} | ${pct(mean(es.map((s) => s.moveTickRate)))} | ${pct(
      mean(es.map((s) => s.idle['50'])),
    )} | ${pct(mean(es.map((s) => s.idle['100'])))} | ${pct(mean(es.map((s) => s.idle['200'])))} |`,
  );
}
L.push('');

// ---------- 画像表 4：滚雪球 ----------
L.push('## 4. 滚雪球时间线（E 胜且 <400 tick 的两人局）');
L.push('');
const snow = games.filter((g) => (isAH(g) || isYuelan(g)) && eWon(g) && g.finalTurn < 400);
if (snow.length === 0) {
  L.push('（无符合条件的对局）');
}
for (const g of snow) {
  const ei = eIdx(g);
  const oi = oppIdxs(g)[0];
  const es = statOf(g, ei);
  const oppName = g.meta.playerNames[oi];
  const contact = es.firstContactTick ?? 0;
  const crownFall = g.events.find((ev) => ev.type === 'crown_fall' && ev.from === oi);
  const end = crownFall ? crownFall.tick : g.finalTurn;
  L.push(`### ${g.replayId} vs ${oppName}（${g.finalTurn}t，首次接壤 t${contact}${
    crownFall ? `，敌主城陷落 t${crownFall.tick}@(${crownFall.x},${crownFall.y})` : ''
  }）`);
  L.push('');
  L.push('| tick | E兵 | 敌兵 | 兵力比 | E地 | 敌地 | 领土比 | 事件 |');
  L.push('|---|---|---|---|---|---|---|---|');
  const evByTick = new Map();
  for (const ev of g.events) {
    if (!evByTick.has(ev.tick)) evByTick.set(ev.tick, []);
    evByTick.get(ev.tick).push(ev);
  }
  for (let t = Math.floor(contact / 25) * 25; t <= Math.min(end + 25, g.finalTurn); t += 25) {
    const ea = armyAt(g, t, ei);
    const oa = armyAt(g, t, oi);
    const el = landAt(g, t, ei);
    const ol = landAt(g, t, oi);
    const evs = (evByTick.get(t) || [])
      .map((ev) =>
        ev.type === 'crown_fall'
          ? `主城(${ev.x},${ev.y}) ${g.meta.playerNames[ev.from]}→${ev.to !== null ? g.meta.playerNames[ev.to] : '中立'}`
          : ev.type === 'post_fall'
            ? `指挥所(${ev.x},${ev.y})易主`
            : ev.type,
      )
      .join('; ');
    L.push(
      `| ${t} | ${ea} | ${oa} | ${(ea / Math.max(oa, 1)).toFixed(2)} | ${el} | ${ol} | ${(
        el / Math.max(ol, 1)
      ).toFixed(2)} | ${evs} |`,
    );
  }
  const firstAtk = es.firstAttackTick;
  const firstCap = g.events.find((ev) => ev.type === 'post_fall' && ev.to === ei && ev.from === oi);
  L.push('');
  L.push(
    `关键事件：首攻 t${firstAtk ?? '—'}；首夺敌指挥所 ${firstCap ? `t${firstCap.tick}@(${firstCap.x},${firstCap.y})` : '—'}；敌主城陷落 ${
      crownFall ? `t${crownFall.tick}` : '—（未陷落，对手投降）'
    }。`,
  );
  L.push('');
}

// ---------- 败局教训 ----------
L.push('## 5. 败局分析（转折点前后各 10 tick 双方动作）');
L.push('');
const losses = games.filter((g) => !eWon(g));
for (const g of losses) {
  const ei = eIdx(g);
  const opps = oppIdxs(g);
  const es = statOf(g, ei);
  const oppNames = opps.map((p) => g.meta.playerNames[p]).join('+');
  const tt = g.turning.lastLeadTick ?? g.turning.peakRatioTick;
  L.push(`### ${g.replayId} vs ${oppNames}（${g.finalTurn}t，负）`);
  L.push('');
  L.push(
    `E 兵力峰值比 ${g.turning.peakRatio}（t${g.turning.peakRatioTick}）；${
      g.turning.lastLeadTick !== null
        ? `最后一次兵力不落后为 t${g.turning.lastLeadTick}，此后持续落后至终局。`
        : '终局时 E 兵力仍不落后（输在主城被斩首或领土被切）。'
    }`,
  );
  if (tt !== null && tt !== undefined) {
    const win = actionsAt(g, tt, 10);
    const byPlayer = new Map();
    for (const a of win) {
      if (!byPlayer.has(a.p)) byPlayer.set(a.p, { expand: 0, attack: 0, transport: 0, build: 0, big: [] });
      const r = byPlayer.get(a.p);
      if (a.kind === 'build') r.build += 1;
      else {
        r[a.cls] += 1;
        if (a.cls === 'attack' || a.srcArmy >= 30) r.big.push(a);
      }
    }
    L.push('');
    L.push(`t${tt - 10}–t${tt + 10} 窗口：`);
    for (const [p, r] of byPlayer) {
      L.push(
        `- ${g.meta.playerNames[p]}：攻 ${r.attack} / 扩 ${r.expand} / 运 ${r.transport} / 建 ${r.build}`,
      );
      for (const a of r.big.slice(0, 4)) {
        L.push(`  - t${a.tick} ${fmtAction(g, a)}`);
      }
    }
    const ea = armyAt(g, tt, ei);
    const oa = Math.max(...opps.map((p) => armyAt(g, tt, p)));
    L.push(`- t${tt} 兵力：E ${ea} vs 对手最强 ${oa}；领土 E ${landAt(g, tt, ei)} vs ${landAt(g, tt, opps[0])}`);
  }
  const surrenders = g.events.filter((ev) => ev.type === 'surrender');
  const crownFalls = g.events.filter((ev) => ev.type === 'crown_fall' && ev.from === ei);
  if (crownFalls.length) {
    L.push(`- E 主城/城市陷落：${crownFalls.map((ev) => `t${ev.tick}@(${ev.x},${ev.y})`).join('，')}`);
  }
  if (surrenders.length) {
    L.push(`- 投降：${surrenders.map((ev) => `t${ev.tick} ${g.meta.playerNames[ev.player]}`).join('，')}`);
  }
  L.push('');
}

// ---------- E vs Anti_Human 对比 ----------
L.push('## 6. E vs Anti_Human 同局对比（12 局两人局）');
L.push('');
L.push('| 回放 | 结果 | E移动率 | bot移动率 | E首攻 | bot首攻 | E t50地/兵 | bot t50地/兵 | E mode 0/1/2 | bot mode 0/1/2 |');
L.push('|---|---|---|---|---|---|---|---|---|---|');
for (const g of games.filter(isAH)) {
  const ei = eIdx(g);
  const oi = oppIdxs(g)[0];
  const es = statOf(g, ei);
  const os = statOf(g, oi);
  const e50 = es.opening['50'];
  const o50 = os.opening['50'];
  L.push(
    `| ${g.replayId} | ${eWon(g) ? '胜' : '负'} | ${pct(es.moveTickRate)} | ${pct(os.moveTickRate)} | ${
      es.firstAttackTick ?? '—'
    } | ${os.firstAttackTick ?? '—'} | ${e50 ? `${e50.land}/${e50.army}` : '—'} | ${
      o50 ? `${o50.land}/${o50.army}` : '—'
    } | ${modeStr(es)} | ${modeStr(os)} |`,
  );
}
L.push('');
L.push('### 逐局差距实例（tick 级）');
for (const g of games.filter(isAH)) {
  const ei = eIdx(g);
  const oi = oppIdxs(g)[0];
  L.push('');
  L.push(`#### ${g.replayId}（${g.finalTurn}t，${eWon(g) ? 'E 胜' : 'E 负'}）`);
  for (const inst of pickInstances(g)) {
    const acts = g.actionLog.filter((a) => a.tick === inst.tick);
    const ea = armyAt(g, inst.tick, ei);
    const oa = armyAt(g, inst.tick, oi);
    L.push(`- t${inst.tick}（${inst.label}；兵力 E ${ea} vs bot ${oa}）：`);
    if (acts.length === 0) L.push('  - 双方该 tick 均无动作');
    for (const a of acts) L.push(`  - ${fmtAction(g, a)}`);
  }
}
L.push('');

fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), L.join('\n') + '\n');
console.log(`REPORT.md written (${L.length} lines)`);
