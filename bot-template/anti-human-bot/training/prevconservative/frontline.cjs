'use strict';

// 一次决策只执行一步；不保存突击路线或等待多个军团到齐。
function createFrontline(state, params = {}) {
  const { n, m, grid, army, playerId: me } = state;
  const size = n * m, turn = state.turn ?? 0;
  const diagnostics = { rejected:{}, examples:[] };
  function reject(code, detail) {
    diagnostics.rejected[code] = (diagnostics.rejected[code] || 0) + 1;
    if (detail && diagnostics.examples.length < 4) diagnostics.examples.push({code,...detail});
    return null;
  }
  const owner = i => grid[i] > 0 && grid[i] < 200 ? grid[i] % 50 : 0;
  const team = p => state.teams instanceof Map ? state.teams.get(p) : state.teams?.[p];
  const ally = p => p > 0 && (p === me || (team(p) > 0 && team(p) === team(me)));
  const known = i => !state.fog?.[i] && ![201, 202, 203].includes(grid[i]);
  const friendly = i => known(i) && ally(owner(i)) && !state.isolated?.[i];
  const hostile = i => known(i) && owner(i) > 0 && !ally(owner(i));
  const ns = i => {
    const out = [];
    if (i >= m) out.push(i - m);
    if (i + m < size) out.push(i + m);
    if (i % m) out.push(i - 1);
    if (i % m < m - 1) out.push(i + 1);
    return out;
  };
  const count = (i, ticks = 1) => {
    let growth = 0;
    if (owner(i) && !state.isolated?.[i]) {
      if (grid[i] === 100 + owner(i)) growth = ticks;
      else if (grid[i] < 150) {
        growth = Math.floor((turn + ticks) / 50) - Math.floor(turn / 50);
        if (grid[i] < 50) growth += Math.max(0, Math.min(50, turn + ticks) - Math.max(25, turn));
      }
    }
    return army[i] + growth;
  };
  const blocked = (a, b) => params.blockedEdges?.has(`${a}:${b}`);
  // 敌军两步机动上界。被隔断的兵仍参与目标防守，但不计为可动侧翼兵。
  const threats = new Map();
  function threat(i, excluded) {
    const key = `${i}:${excluded}`;
    if (threats.has(key)) return threats.get(key);
    const seen = new Set([i]), queue = [[i, 0]];
    let value = 0;
    for (let h = 0; h < queue.length; h++) {
      const [u, d] = queue[h];
      if (u !== excluded && hostile(u) && !state.isolated?.[u]) value += Math.max(0, count(u, 2) - d);
      if (d === 2) continue;
      for (const v of ns(u)) if (known(v) && !seen.has(v)) {
        seen.add(v); queue.push([v, d + 1]);
      }
    }
    threats.set(key, value); return value;
  }
  // 所有已知友方锚点的补给距离，每帧仅算一次。
  const distance = new Int32Array(size).fill(-1), queue = [];
  for (let i = 0; i < size; i++) if (friendly(i) && grid[i] >= 50 && grid[i] < 150) {
    distance[i] = 0; queue.push(i);
  }
  for (let h = 0; h < queue.length; h++) for (const v of ns(queue[h]))
    if (friendly(v) && distance[v] < 0) { distance[v] = distance[queue[h]] + 1; queue.push(v); }

  function evaluate(move) {
    if (!move) return null;
    if (move.kind === 'build') return { move, score: -Infinity };
    const { x, y, dx, dy } = move;
    if (![x, y, dx, dy].every(Number.isInteger) || x < 0 || x >= n || dx < 0 || dx >= n ||
        y < 0 || y >= m || dy < 0 || dy >= m || Math.abs(x - dx) + Math.abs(y - dy) !== 1) return null;
    const a = x * m + y, b = dx * m + dy;
    if (owner(a) !== me || !friendly(a)) return reject('来源非可操作己方格');
    if (blocked(a,b)) return reject('移动历史禁行边');
    if (ally(owner(b))) {
      // 己方安全腹地整批运输；靠敌前线/未知地形不冒充内部。
      const interior = !threat(a, -1) && !threat(b, -1) &&
        [...ns(a), ...ns(b)].every(v => !state.fog?.[v] && (known(v) || grid[v] === 201));
      return { move: interior ? { ...move, mode:2, half:false } : move, score: -Infinity };
    }
    if (!known(b)) return reject('目标不可见或不可通行');
    if (hostile(b) && params.allowedOwners && !params.allowedOwners.has(owner(b))) return reject('FFA目标限制');
    const A = count(a), D = count(b), cap = Math.max(0, A - 1);
    let B = 0;
    for (const v of ns(a)) if (v !== b && grid[v] !== 201 && !ally(owner(v))) B += count(v) - 1;
    const theoretical = Math.max(0, A - B - 1);
    const half = Math.min(cap, Math.floor(theoretical / 2));
    const automatic = Math.min(cap, theoretical);
    // 向源点的两步路径若必经本次攻击目标，属于战线正面反击，
    // 不是能绕过战斗直接切断源点的侧翼。两者不能使用同一个威胁总和。
    const sourceSeen = new Set([a, b]), sourceQueue = [[a, 0]];
    let sourceThreat = 0;
    for (let h=0;h<sourceQueue.length;h++) {
      const [u,d] = sourceQueue[h];
      if (hostile(u) && !state.isolated?.[u]) sourceThreat += Math.max(0,count(u,2)-d);
      if (d===2) continue;
      for (const v of ns(u)) if (known(v) && !sourceSeen.has(v)) {
        sourceSeen.add(v);sourceQueue.push([v,d+1]);
      }
    }
    const targetThreat = threat(b, b);
    // 攻冠是已可执行的战术机会，不再以未来六层供给稳定或未知侧翼否决。
    // 不把任何一座皇冠当作最后皇冠：仍保留来源皇冠的即时留守。
    if (grid[b] === 100 + owner(b) && hostile(b)) {
      if (cap <= D) return reject('攻冠兵力不足', {from:a,to:b,available:cap,defense:D});
      const reserve = grid[a] === 100 + me ? sourceThreat + 1 : 1;
      const splitUnknown = ns(a).some(v=>v!==b && (state.fog?.[v] || (!known(v) && grid[v]!==201)));
      for (const mode of (splitUnknown ? [2] : [1, 0, 2])) {
        const push = mode === 1 ? half : mode === 0 ? automatic : cap;
        if (push <= D || A - push < reserve) continue;
        return {move:{...move,mode,half:false,reason:`直接攻冠：出兵${push}，增长后守军${D}，留守${A-push}`},score:1000000+Math.min(push-D,1000)};
      }
      return reject('攻冠来源皇冠需留守', {from:a,to:b,available:cap,defense:D,reserve});
    }
    const unknown = [...ns(a), ...ns(b)].some(v => state.fog?.[v] || (grid[v] !== 201 && !known(v)));
    const supports = ns(b).filter(v => v !== a && friendly(v));
    const supportArmy = supports.reduce((s, v) => s + Math.max(0, count(v) - 2), 0);
    // 检查源点以及最多六层补给链：后方被绕切不能靠目标格兵多抵消。
    let cursor = a, fragile = false, inspected = 0;
    const visited = new Set();
    while (distance[cursor] > 0 && inspected++ < 6 && !visited.has(cursor)) {
      visited.add(cursor);
      const parents = ns(cursor).filter(v => friendly(v) && distance[v] >= 0 && distance[v] < distance[cursor]);
      if (!parents.length) break;
      parents.sort((u, v) => (count(v) - threat(v, b)) - (count(u) - threat(u, b)));
      const parent = parents[0];
      if (parents.every(v => threat(v, b) >= count(v) && threat(v, b) > 0)) fragile = true;
      cursor = parent;
    }
    const deep = supports.length === 0 && distance[a] > 2;
    const secureAdvance = supportArmy >= targetThreat && sourceThreat === 0 && !fragile && !unknown;
    // 断供风险不是无条件否决：即使按最坏被切减半，仍压倒可见敌军时可推进。
    // 必须在具体出兵模式下验证占领后兵力，不能仅看出发总量。
    let visibleEnemy = 0;
    if (fragile) for (let i = 0; i < size; i++) if (hostile(i)) visibleEnemy += count(i, 2);
    if (deep && targetThreat > 0 && !secureAdvance && A < 3 * (D + targetThreat + sourceThreat + 1)) return reject('深入风险', {from:a,to:b,A,D,sourceThreat,targetThreat});
    // mode1并非总兵力50%。必须按引擎公式计算；不能发送不存在的模式。
    const modes = [1, 2];
    // 自动分兵仅用于已知安全环境；不以它替代侧翼判断。
    if (!sourceThreat && !targetThreat && !unknown) modes.push(0);
    for (const mode of modes) {
      const push = mode === 1 ? half : mode === 2 ? cap : automatic;
      const left = A - push, arrived = push - D;
      if (arrived <= 0 || left <= sourceThreat) continue;
      // 能反击夺回目标不等于这次攻击无效。保住补给源、无脆弱后链时，
      // 对有实际守军的敌格允许兵力交换；不为几兵空地送掉巨大远征军。
      const exchange = hostile(b) && !fragile && !unknown && !deep;
      if (arrived <= targetThreat && !exchange) continue;
      // 可见单步且即使减半仍压倒敌军才放行；留在源点的大军可用于重新接通。
      if (fragile && (unknown || Math.floor(arrived / 2) <= 3 * (visibleEnemy + 1) ||
          left <= 2 * (sourceThreat + 1))) continue;
      if (unknown && (left < Math.max(5, Math.ceil(A * .25)) || arrived < 5)) continue;
      // 全冲不能把新占地唯一连接点留给可见两跳威胁。
      const score = (hostile(b) ? 35 : 0) + supports.length * 12 + Math.min(30, D) +
        (grid[b] === 100 + owner(b) ? 40 : 0) - targetThreat * .15 -
        (deep ? 20 : 0) - Math.max(0, distance[a]) * .4 + Math.min(arrived, 100) * .08;
      return { move: { ...move, mode, reason: `${arrived <= targetThreat ? '边界交换' : '边界推进'}：${mode === 1 ? '受限半兵' : mode === 2 ? '安全全冲' : '安全自动分兵'}，保留${left}，占领后${arrived}` }, score };
    }
    return reject('出兵或留守预算未通过', {from:a,to:b,A,D,sourceThreat,targetThreat,fragile,unknown});
  }
  return {
    diagnostics,
    assess: move => evaluate(move)?.move ?? null,
    choose() {
      const candidates = [];
      for (let a = 0; a < size; a++) if (owner(a) === me && friendly(a) && count(a) > 2)
        for (const b of ns(a)) if (hostile(b) && !blocked(a, b) &&
          (!params.allowedOwners || params.allowedOwners.has(owner(b)))) candidates.push({ a, b, strength: count(a) - count(b) });
      candidates.sort((a, b) => Number(grid[b.b] === 100 + owner(b.b)) - Number(grid[a.b] === 100 + owner(a.b)) || b.strength - a.strength);
      diagnostics.candidates = candidates.length;
      diagnostics.isolatedSources = Array.from({length:size},(_,i)=>i).filter(i=>owner(i)===me && state.isolated?.[i] && army[i]>1).length;
      let best = null;
      for (const { a, b } of candidates.slice(0, 96)) {
        const value = evaluate({ x: Math.floor(a / m), y: a % m, dx: Math.floor(b / m), dy: b % m, mode: 1 });
        if (value && (!best || value.score > best.score)) best = value;
      }
      return best?.move ?? null;
    }
  };
}
module.exports = { createFrontline };
