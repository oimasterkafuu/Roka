'use strict';
// 截断：切断敌方兵力的连通，让一整段敌军变孤军（断链瞬间减半、5 tick 宽限后
// 每 tick 5% 衰减、孤军不能移动不能出击），是性价比最高的攻防动作。
//
// 引擎规则（reference/src/game-engine.ts applyConnectivity）：一支队伍只有连到自己的
// 城市/皇冠才算连通。连通按【队伍】BFS：从本队存活成员的所有城市/皇冠出发，
// 经过本队成员的非山格子。本模块的所有「会不会孤立」判断都复刻这套 BFS，
// 不自己发明近似规则。
//
// 两种截断：
//   1. 入侵截断（invasion）：敌人插进我方腹地（偷家），掐断它与自家城市/皇冠的唯一连接；
//   2. 散兵截断（dispersed）：敌方兵力散开后，本回合占住某格（或两格组合）即可让
//      敌方一段兵力与所有敌方锚点断开——不限于我家附近。
// 有效性由真实连通 BFS 保证：被切断段是从「所有敌方锚点」同时 BFS 走不到的部分，
// 段内必然不含敌方城市/皇冠，否则不会被计入收益，杜绝盲目截断。
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

function chooseCutoff(state, params = {}) {
  const ctx = createContext(state, params);
  if (!ctx) return null;
  const p = resolveParams(params);
  const turn = ctx.turn;
  if (!Number.isFinite(turn)) return null;

  // 我方锚点：判断「深入」以及多远算危险。
  const myAnchors = [];
  for (let i = 0; i < ctx.size; i++) if (ctx.own(i) && (ctx.grid[i] === ctx.me + 100 || ctx.grid[i] === ctx.me + 50)) myAnchors.push(i);

  // 出兵量估算（引擎智能分兵：扣掉周边非盟友格的守军预留）。
  function pushed(from, to) {
    let reserve = 0;
    for (const k of ctx.neighbors[from]) {
      if (k === to || ctx.grid[k] === 201 || ctx.grid[k] === 203 || ctx.allied(ctx.owners[k], ctx.me)) continue;
      reserve += ctx.count(k) - 1;
    }
    return Math.min(ctx.count(from) - 1, Math.max(0, ctx.count(from) - reserve - 1));
  }

  // 紧邻瓶颈能一次拿下就直接打；否则从我方境内集兵送往瓶颈。
  // 截断决策不建模敌军反扑（用户 2026-09-27 硬性方针）：被截断隔离的兵力记为 0
  // （孤军无法操作、自行衰减），本回合能占下瓶颈就打，不因「可能被反夺」放弃。
  // 在满足占下的打法里选最省兵的。
  function planAttack(choke, defense, trapped, strikeReason, gatherReason, extra = {}) {
    const { m } = ctx;
    let strike = null;
    for (const s of ctx.neighbors[choke]) {
      if (!ctx.own(s) || ctx.isolated(s)) continue;
      const cap = ctx.count(s) - 1;
      const theoretical = pushed(s, choke);
      const half = Math.floor(theoretical / 2);
      for (const [mode, push] of [[1, half], [0, theoretical], [2, cap]]) {
        if (push <= defense || ctx.count(s) - push < 1) continue;
        const arrive = push - defense;
        if (!strike || push < strike.push) strike = { s, mode, push, arrive };
      }
    }
    if (strike) {
      return { strike: true, trapped, defense, arrive: strike.arrive, ...extra,
        move: { x: Math.floor(strike.s / m), y: strike.s % m,
          dx: Math.floor(choke / m), dy: choke % m, mode: strike.mode, half: false,
          reason: `${strikeReason}：出兵${strike.push}掐断走廊，冻住约${Math.round(trapped)}敌兵` } };
    }
    // 凑不出来就地集兵：从我方境内按距离收集兵力，沿严格下降路径往瓶颈送。
    const distance = new Int32Array(ctx.size).fill(-1), toward = new Int32Array(ctx.size).fill(-1);
    const queue = [choke]; distance[choke] = 0;
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      if (distance[i] >= p.cutoffMaxSteps) continue;
      for (const j of ctx.neighbors[i]) {
        if (distance[j] >= 0 || !ctx.own(j) || ctx.isolated(j)) continue;
        distance[j] = distance[i] + 1; toward[j] = i; queue.push(j);
      }
    }
    let job = null;
    for (const s of queue) {
      if (distance[s] < 1) continue;
      const dest = toward[s];
      const amount = pushed(s, dest);
      if (amount <= 0) continue;
      // 贴敌前线格只在大股时才抽，避免为了截断而漏掉正面。
      if (ctx.neighbors[s].some(ctx.hostile) && amount < 10) continue;
      // 主城至少留 4 兵。
      if (ctx.grid[s] === ctx.me + 100 && ctx.count(s) - amount < 4) continue;
      const score = amount / distance[s];
      if (!job || score > job.score) job = { s, dest, amount, score, distance: distance[s] };
    }
    if (!job) return null;
    return { strike: false, trapped, defense, arrive: job.amount - defense, ...extra,
      move: { x: Math.floor(job.s / m), y: job.s % m,
        dx: Math.floor(job.dest / m), dy: job.dest % m, mode: 0, half: false,
        reason: `${gatherReason}：把${job.amount}兵送往瓶颈，目标冻住约${Math.round(trapped)}敌兵` } };
  }

  const invasion = myAnchors.length ? invasionCutoff(ctx, p, myAnchors, planAttack) : null;
  const dispersed = dispersedCutoff(ctx, p, planAttack);
  // 不做跨回合锁定：每个 tick 都按当前局面重新打分，直接取当下最优。
  if (invasion && dispersed) return invasion.score >= dispersed.score ? invasion : dispersed;
  return invasion || dispersed;
}

// ── 入侵截断：敌人嵌进我方腹地时，掐断它回家的脖子 ────────────────────────
function invasionCutoff(ctx, p, myAnchors, planAttack) {
  const { me, size, grid, owners, army, count, own, hostile, passable, neighbors, isolated } = ctx;

  // 到最近我方锚点的通行距离（穿任何可通行格），用于「离我家多近」。
  const homeDistance = new Int32Array(size).fill(-1);
  {
    const q = [];
    for (const a of myAnchors) { homeDistance[a] = 0; q.push(a); }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      if (homeDistance[i] >= p.cutoffRange + 2) continue;
      for (const j of neighbors[i]) if (homeDistance[j] < 0 && passable(j)) { homeDistance[j] = homeDistance[i] + 1; q.push(j); }
    }
  }
  const isAnchor = (i) => {
    const o = owners[i];
    if (!(o > 0) || ctx.allied(o, me)) return false;
    return grid[i] === o + 100 || grid[i] === o + 50;
  };
  // 「嵌进我方腹地」：2 跳内我方格明显多于敌方格。
  function embedded(i) {
    const seen = new Set([i]);
    let mine = 0, theirs = 0, layer = [i];
    for (let d = 0; d < 2 && layer.length; d++) {
      const next = [];
      for (const u of layer) for (const v of neighbors[u]) {
        if (seen.has(v) || !passable(v)) continue;
        seen.add(v);
        if (own(v)) mine++;
        else if (hostile(v)) theirs++;
        next.push(v);
      }
      layer = next;
    }
    // 严格一点：必须是“被我们包住”的孤军，而不是普通边境接触或敌方建筑。
    return mine >= 4 && mine >= theirs + 2;
  }

  // 1) 入侵种子：嵌进我方、且离我家不远的敌格。
  const raiders = [];
  for (let i = 0; i < size; i++) {
    if (!hostile(i) || isolated(i) || isAnchor(i)) continue;
    if (homeDistance[i] < 0 || homeDistance[i] > p.cutoffRange) continue;
    if (embedded(i)) raiders.push(i);
  }
  if (!raiders.length) return null;

  // 2) 候选瓶颈：既邻接我方格（我们才打得到），又邻接入侵格集合。
  const raidSet = new Set(raiders);
  const candidates = new Set();
  for (const r of raiders) {
    // 从入侵格向敌方纵深走 cutoffRange 步，路径上所有「贴着我方格」的敌格都是候选。
    const seen = new Set([r]);
    let layer = [r];
    for (let d = 0; d <= p.cutoffRange && layer.length; d++) {
      const next = [];
      for (const u of layer) {
        // 敌方城市/皇冠不做截断目标：拆掉它们归前线「拆建筑优先」管，
        // 而且以锚点为瓶颈会把「占领皇冠」误标成「截断」。
        if (!isAnchor(u) && neighbors[u].some((v) => own(v))) candidates.add(u);
        for (const v of neighbors[u]) {
          if (seen.has(v) || !hostile(v) || isolated(v)) continue;
          seen.add(v); next.push(v);
        }
      }
      layer = next;
    }
  }
  if (!candidates.size) return null;

  // 移除某格后，入侵部队还能不能走回自家锚点 / 走出我方纵深？
  function cutsOff(choke) {
    const seen = new Set(raidSet);
    const q = [...raidSet];
    let mass = 0;
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      if (u !== choke && isAnchor(u)) return null;
      if (u !== choke && homeDistance[u] > p.cutoffRange) return null; // 通到他们自己的纵深
      mass += Math.max(0, army[u]);
      if (q.length > p.cutoffScan) return null;
      for (const v of neighbors[u]) {
        if (v === choke || seen.has(v) || !hostile(v)) continue;
        seen.add(v); q.push(v);
      }
    }
    return mass;
  }

  let best = null;
  for (const choke of candidates) {
    const defense = count(choke, 1);
    if (defense > p.cutoffMaxDefense) continue;
    const trapped = cutsOff(choke);
    if (trapped === null || trapped < p.cutoffMinIsolate) continue;
    // 评分：被冻住的敌军越多越好，攻占成本越低越好，离我家越近越紧急。
    const danger = Math.max(0, p.cutoffRange - homeDistance[choke]);
    const score = trapped * 1.2 - defense * 1.5 + danger * 12;
    if (!best || score > best.score) best = { choke, defense, trapped, danger, score };
  }
  if (!best) return null;
  const urgent = best.danger >= p.cutoffRange - p.cutoffUrgentRange;
  const plan = planAttack(best.choke, best.defense, best.trapped, '截断入侵', '截断集兵');
  if (!plan) return null;
  return { ...plan, urgent, score: best.score };
}

// ── 散兵截断：敌方兵力散开后，占住一格（或两格组合）即可孤立其一段 ────────
// 与入侵截断的差别：不限于「嵌进我方腹地」，任何贴着我方格的敌格都可能是割点。
// 有效性判断完全复刻引擎 applyConnectivity：从该敌队所有城市/皇冠同时 BFS
// （经过该队非山格子），移除瓶颈后走不到的部分才是会被孤立的段——段内必然
// 不含敌方建筑（锚点是 BFS 源，永远可达），含皇冠的段不会被误判为可冻住。
function dispersedCutoff(ctx, p, planAttack) {
  const { size, grid, owners, army, me, own, neighbors, allied, knownAt } = ctx;
  const state = ctx.state;
  const teamOf = (o) => Number(state.teams instanceof Map ? state.teams.get(o) : state.teams?.[o]) || 0;

  // 按队伍分组敌方格子（引擎连通按队伍算，同队不同玩家的格子互相连通）。
  const teams = new Map(); // key -> { tiles: number[], anchors: number[] }
  for (let i = 0; i < size; i++) {
    const o = owners[i];
    if (!(o > 0) || allied(o, me) || !knownAt(i)) continue;
    const t = teamOf(o);
    const key = t > 0 ? `t${t}` : `o${o}`;
    let entry = teams.get(key);
    if (!entry) { entry = { tiles: [], anchors: [] }; teams.set(key, entry); }
    entry.tiles.push(i);
    if (grid[i] === o + 50 || grid[i] === o + 100) entry.anchors.push(i);
  }
  if (!teams.size) return null;

  // 从 anchors 同时 BFS（移除 cutSet 中的格子），返回「会被孤立的非孤立格」兵力。
  // visited 上限防止超大分量拖慢单 tick；超预算视为无法确认，放弃该候选。
  function strandedMass(anchors, tileSet, cutSet) {
    const seen = new Set(cutSet);
    const q = [];
    for (const a of anchors) if (!cutSet.has(a)) { seen.add(a); q.push(a); }
    let visited = 0;
    for (let h = 0; h < q.length; h++) {
      if (++visited > p.cutoffScan * 4) return null;
      for (const v of neighbors[q[h]]) {
        if (seen.has(v) || !tileSet.has(v)) continue;
        seen.add(v); q.push(v);
      }
    }
    let mass = 0;
    for (const i of tileSet) {
      if (seen.has(i) || cutSet.has(i) || ctx.isolated(i)) continue;
      mass += Math.max(0, army[i]);
    }
    return mass;
  }

  const viable = [];
  const consider = (chokes, defense, trapped) => {
    const score = trapped * 1.2 - defense * 1.5;
    if (score <= 0) return;
    viable.push({ chokes, defense, trapped, score });
  };
  for (const { tiles, anchors } of teams.values()) {
    if (!anchors.length) continue; // 没有锚点的队伍已经全部孤立，没有可新冻住的
    const tileSet = new Set(tiles);
    const anchorSet = new Set(anchors);
    // 候选割点：贴着我方格（本回合打得到）的敌格，建筑除外（拆建筑由前线推进负责）。
    const candidates = [];
    for (const i of tiles) {
      if (anchorSet.has(i)) continue;
      if (neighbors[i].some((v) => own(v))) candidates.push(i);
    }
    if (!candidates.length) continue;
    // 预算控制：守军最弱的候选优先，每队最多评 12 个。
    candidates.sort((a, b) => ctx.count(a, 1) - ctx.count(b, 1));
    const single = candidates.slice(0, 12);
    for (const choke of single) {
      const defense = ctx.count(choke, 1);
      if (defense > p.cutoffMaxDefense) continue;
      const mass = strandedMass(anchors, tileSet, new Set([choke]));
      if (mass === null || mass < p.cutoffMinIsolate) continue;
      consider([choke], defense, mass);
    }
    // 两格组合：单格切不断时，相邻两个候选一起占住才能切断（窄走廊并排脖子）。
    // 本回合先打较弱的一格，另一格在后续 tick 自然成为单格割点。
    let pairs = 0;
    for (let a = 0; a < single.length && pairs < 16; a++) {
      for (let b = a + 1; b < single.length && pairs < 16; b++) {
        const c1 = single[a], c2 = single[b];
        if (!neighbors[c1].includes(c2)) continue; // 组合必须相邻，否则不构成同一处脖子
        pairs++;
        const d1 = ctx.count(c1, 1), d2 = ctx.count(c2, 1);
        if (d1 + d2 > p.cutoffMaxDefense) continue;
        const mass = strandedMass(anchors, tileSet, new Set([c1, c2]));
        if (mass === null || mass < p.cutoffMinIsolate) continue;
        const first = d1 <= d2 ? c1 : c2;
        consider([first, first === c1 ? c2 : c1], d1 + d2, mass);
      }
    }
  }
  if (!viable.length) return null;
  viable.sort((a, b) => b.score - a.score);
  // 按收益从高到低逐个制定出兵方案。不做「守得住」反夺校验（用户 2026-09-27 硬性方针）：
  // 被截断隔离的兵力记为 0，截断决策不建模敌军反扑，本回合能占下瓶颈就打。
  for (const cut of viable.slice(0, 10)) {
    const pair = cut.chokes.length > 1;
    // 注意：出手只针对本回合要占的第一格，防御值用第一格自身的守军，
    // 两格守军之和只用于上面的收益评分。
    const plan = planAttack(cut.chokes[0], ctx.count(cut.chokes[0], 1), cut.trapped,
      pair ? '截断散兵（两格脖子，先打其一）' : '截断散兵',
      pair ? '截断集兵（两格脖子，先送其一）' : '截断集兵');
    if (!plan) continue;
    // 冻住规模明显时视同紧急：值得为它放弃普通调兵。
    const urgent = cut.trapped >= Math.max(p.cutoffMinIsolate * 4, 30);
    return { ...plan, urgent, score: cut.score };
  }
  return null;
}

// ── 脖子纪律：我方割点驻守/回缩 ──────────────────────────────────────────
// 回放里三次决定性败因是同一个形状：我方一段兵力只靠一个 1 格宽、守兵个位数的
// 脖子连回皇冠，旁边贴着敌方大堆——敌人一刀切断，整段变孤军（WwOS (11,2)=24 vs 308、
// EBS5 (3,7)=3 vs 424、uzsTrD (9,9)=2 vs 300）。
// 本函数找出「被敌方本 tick 就能打下、且打掉后会让我方 ≥cutoffMinIsolate 兵力断锚」
// 的我方格子，然后从两侧（后方增援 / 前沿回缩）挑最有力的一路往脖子上补兵。
// 与 defense.cjs 的分工：defense 守的是「皇冠被端」，这里守的是「连通被切断」。
function chooseNeckGuard(state, params = {}) {
  const ctx = createContext(state, params);
  if (!ctx) return null;
  const p = resolveParams(params);
  const { size, grid, owners, me, own, hostile, neighbors, isolated, count } = ctx;

  // 我方锚点与我方连通块（引擎规则：从本队所有城市/皇冠 BFS，经本队非山格）。
  const anchors = [], myTiles = [];
  for (let i = 0; i < size; i++) {
    if (!own(i)) continue;
    myTiles.push(i);
    if (grid[i] === me + 100 || grid[i] === me + 50) anchors.push(i);
  }
  if (anchors.length < 1 || myTiles.length < 3) return null;
  const tileSet = new Set(myTiles);

  // 移除 neck 后，从我方锚点走不到的我方兵力（= 会被冻住的量）。
  function strandedMass(neck) {
    const seen = new Set([neck]);
    const q = [];
    for (const a of anchors) if (a !== neck) { seen.add(a); q.push(a); }
    let visited = 0;
    for (let h = 0; h < q.length; h++) {
      if (++visited > p.cutoffScan * 4) return null;
      for (const v of neighbors[q[h]]) {
        if (seen.has(v) || !tileSet.has(v)) continue;
        seen.add(v); q.push(v);
      }
    }
    let mass = 0;
    for (const i of myTiles) if (!seen.has(i)) mass += Math.max(0, ctx.army[i]);
    return mass;
  }

  let best = null;
  for (const c of myTiles) {
    if (grid[c] === me + 100 || grid[c] === me + 50) continue; // 建筑的存亡由 defense/前线管
    // 贴着的最强敌军本 tick 能否打下这一格？
    let threat = 0;
    for (const j of neighbors[c]) if (hostile(j)) threat = Math.max(threat, count(j) - 1);
    if (threat <= 0 || threat <= count(c)) continue; // 暂时打不下来就不算燃眉之急
    const stranded = strandedMass(c);
    if (stranded === null || stranded < p.cutoffMinIsolate) continue;
    // 评分：会被冻住的越多越好，脖子当前守军越薄越紧急。
    const score = stranded * 1.2 - count(c);
    if (!best || score > best.score) best = { neck: c, threat, stranded, score };
  }
  if (!best) return null;
  const { neck, threat, stranded } = best;

  // 从脖子两侧集兵：沿我方格 BFS（cutoffMaxSteps 内），挑 送达兵力/距离 最高的一路。
  // 前沿大堆回缩一格既补了脖子又把自己撤回来，往往就是最优解。
  const distance = new Int32Array(size).fill(-1), toward = new Int32Array(size).fill(-1);
  const queue = [neck]; distance[neck] = 0;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    if (distance[i] >= p.cutoffMaxSteps) continue;
    for (const j of neighbors[i]) {
      if (distance[j] >= 0 || !own(j) || isolated(j)) continue;
      distance[j] = distance[i] + 1; toward[j] = i; queue.push(j);
    }
  }
  let job = null;
  for (const s of queue) {
    if (distance[s] < 1) continue;
    const dest = toward[s];
    let reserve = 0;
    for (const k of neighbors[s]) {
      if (k === dest || grid[k] === 201 || grid[k] === 203 || ctx.allied(owners[k], me)) continue;
      reserve += count(k) - 1;
    }
    const amount = Math.min(count(s) - 1, Math.max(0, count(s) - reserve - 1));
    if (amount <= 0) continue;
    // 建筑格只在大股时才抽（1 兵建筑下一 tick 就被顺手拆掉）。
    if ((grid[s] === me + 100 || grid[s] === me + 50) && count(s) - amount < 4) continue;
    const score = amount / distance[s];
    if (!job || score > job.score) job = { s, dest, amount, score, distance: distance[s] };
  }
  if (!job) return null;
  const { m } = ctx;
  const holdable = count(neck) + job.amount > threat;
  // 守不住也追不上时的止损纪律：脖子现有兵力加上每 tick 能送到的增援，
  // 连短期内（约 3 tick）追上敌堆的希望都没有时，死守只会每 tick 白送兵
  // （实测对 580+ 敌堆连续 300+ tick 喂 1 兵，整局被拖垮）。此时放弃本分支，
  // 让 policy 拿这段将断的兵力去换东西（推进/攻击），而不是往割点里填。
  if (!holdable && count(neck) + job.amount * 3 <= threat) return null;
  return { neck, threat, stranded, holdable, urgent: true, score: best.score,
    move: { x: Math.floor(job.s / m), y: job.s % m, dx: Math.floor(job.dest / m), dy: job.dest % m,
      mode: 0, half: false,
      reason: `脖子${holdable ? '驻守' : '回缩'}：${job.amount}兵补向割点，防${Math.round(threat)}敌兵切断约${Math.round(stranded)}兵` } };
}

module.exports = { chooseCutoff, chooseNeckGuard };
