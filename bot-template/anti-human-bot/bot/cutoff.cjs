'use strict';
// 入侵截断：敌人插进我方腹地（偷家）时，优先掐断它与自家城市/皇冠的唯一连接。
//
// 引擎规则（reference/src/game-engine.ts applyConnectivity）：一支队伍只有连到自己的
// 城市/皇冠才算连通，断开后 5 tick 宽限、随后每 tick 5% 衰减，而且孤军不能移动、不能出击。
// 所以「打掉入侵走廊的脖子」= 用一格换掉一整支偷家部队，是最划算的防御。
//
// 本模块只做三件事：
//   1. 找「嵌进我方腹地」的敌格（周围多是我方格，且离我方锚点不远）；
//   2. 在它所在的敌方连通块里找割点：移除该格后，入侵格再也走不到敌方锚点、
//      也走不出我方纵深 → 这一格就是薄弱瓶颈；
//   3. 出兵：紧邻瓶颈且一次能拿下就直接打；不够就沿我方境内从 2–4 格外的格子集兵。
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

function chooseCutoff(state, params = {}) {
  const ctx = createContext(state, params);
  if (!ctx) return null;
  const p = resolveParams(params);
  const { me, size, grid, owners, army, count, own, hostile, passable, neighbors, allied, isolated } = ctx;
  const turn = ctx.turn;
  if (!Number.isFinite(turn)) return null;

  // 我方锚点：判断「深入」以及多远算危险。
  const myAnchors = [];
  for (let i = 0; i < size; i++) if (own(i) && (grid[i] === me + 100 || grid[i] === me + 50)) myAnchors.push(i);
  if (!myAnchors.length) return null;
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
    if (!(o > 0) || allied(o, me)) return false;
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
        if (neighbors[u].some((v) => own(v))) candidates.add(u);
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
  // 不做跨回合锁定：每个 tick 都按当前局面重新给所有瓶颈打分，直接取当下最优。
  if (!best) return null;
  const { choke, defense, trapped } = best;
  const urgent = best.danger >= p.cutoffRange - p.cutoffUrgentRange;

  function pushed(from, to) {
    let reserve = 0;
    for (const k of neighbors[from]) {
      if (k === to || grid[k] === 201 || grid[k] === 203 || allied(owners[k], me)) continue;
      reserve += count(k) - 1;
    }
    return Math.min(count(from) - 1, Math.max(0, count(from) - reserve - 1));
  }
  const reason = (phase, extra) => ({ code: 'cutoff', phase, choke, trapped: Math.round(trapped),
    defense: Math.round(defense), homeDistance: homeDistance[choke], ...extra });

  // 3a) 紧邻瓶颈的我方格能一次拿下 → 直接打，选“够用就好”的模式。
  let strike = null;
  for (const s of neighbors[choke]) {
    if (!own(s) || isolated(s)) continue;
    const cap = count(s) - 1;
    const theoretical = pushed(s, choke);
    const half = Math.floor(theoretical / 2);
    for (const [mode, push] of [[1, half], [0, theoretical], [2, cap]]) {
      if (push <= defense || count(s) - push < 1) continue;
      const margin = push - defense;
      if (!strike || margin < strike.margin) strike = { s, mode, push, margin };
      break;
    }
  }
  if (strike) {
    return { strike: true, urgent, trapped, reason: reason('strike', { amount: strike.push }),
      move: { x: Math.floor(strike.s / ctx.m), y: strike.s % ctx.m,
        dx: Math.floor(choke / ctx.m), dy: choke % ctx.m, mode: strike.mode, half: false,
        reason: `截断入侵：出兵${strike.push}掐断走廊，冻住约${Math.round(trapped)}敌兵` } };
  }

  // 3b) 凑不出来就地集兵：从我方境内按距离收集兵力，沿严格下降路径往瓶颈送。
  const distance = new Int32Array(size).fill(-1), toward = new Int32Array(size).fill(-1);
  const queue = [choke]; distance[choke] = 0;
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
    const amount = pushed(s, dest);
    if (amount <= 0) continue;
    // 贴敌前线格只在大股时才抽，避免为了截断而漏掉正面。
    if (neighbors[s].some(hostile) && amount < 10) continue;
    // 主城至少留 4 兵。
    if (grid[s] === me + 100 && count(s) - amount < 4) continue;
    const score = amount / distance[s];
    if (!job || score > job.score) job = { s, dest, amount, score, distance: distance[s] };
  }
  if (!job) return null;
  return { strike: false, urgent, trapped, reason: reason('gather', { amount: job.amount }),
    move: { x: Math.floor(job.s / ctx.m), y: job.s % ctx.m,
      dx: Math.floor(job.dest / ctx.m), dy: job.dest % ctx.m, mode: 0, half: false,
      reason: `截断集兵：把${job.amount}兵送往瓶颈，目标冻住约${Math.round(trapped)}敌兵` } };
}

module.exports = { chooseCutoff };
