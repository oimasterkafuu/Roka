'use strict';

// 每局实例独立；只读取真实棋盘，不改写 owner/team 或制造和平地块。
const memories = new WeakMap();
const owner = v => Number.isInteger(v) && v > 0 && v < 200 && v % 50 ? v % 50 : 0;
const empty = () => ({ targetOwner: null, defensiveOwners: new Set(), allowedOwners: new Set(), emergencyMove: null, threats: [] });
function context(s) {
  if (!s || s.dead || s.ended || !Number.isInteger(s.n) || !Number.isInteger(s.m) || s.n < 1 || s.m < 1 ||
      s.n * s.m > 100000 || !Number.isInteger(s.playerId) || s.playerId < 1 || s.playerId > 49 ||
      s.grid?.length !== s.n * s.m || s.army?.length !== s.n * s.m) return null;
  const size = s.n * s.m, me = s.playerId;
  const team = p => Number(s.teams instanceof Map ? s.teams.get(p) : s.teams?.[p]);
  const allied = (a, b) => a > 0 && b > 0 && (a === b || (team(a) > 0 && team(a) === team(b)));
  const faction = p => team(p) > 0 ? `t${team(p)}` : `p${p}`;
  const ns = i => {
    const a = [];
    if (i >= s.m) a.push(i - s.m);
    if (i % s.m) a.push(i - 1);
    if (i % s.m + 1 < s.m) a.push(i + 1);
    if (i + s.m < size) a.push(i + s.m);
    return a;
  };
  const known = i => !s.fog?.[i] && s.grid[i] !== 202 && s.grid[i] !== 203;
  const passable = i => known(i) && s.grid[i] !== 201;
  const os = Array.from(s.grid, owner), tick = (s.turn ?? 0) + 1;
  const counts = Array.from(s.army, (v, i) => {
    if (!Number.isFinite(v) || v < 0) return NaN;
    const p = os[i];
    const growth = !p ? 0 : s.grid[i] === 100 + p ? 1 : s.isolated?.[i] || s.grid[i] >= 150 ? 0 :
      (tick % 50 === 0 ? 1 : 0) + (s.grid[i] === p && tick >= 26 && tick <= 50 ? 1 : 0);
    return v + growth;
  });
  if (counts.some(v => !Number.isFinite(v))) return null;
  const alive = new Set();
  if (Array.isArray(s.leaderboard) && s.leaderboard.length) {
    for (const p of s.leaderboard) if (!(p.dead > 0 || p.class_ === 'dead') && Number(p.id) >= 1 && Number(p.id) <= 49) alive.add(Number(p.id));
  } else for (const p of os) if (p) alive.add(p);
  alive.add(me);
  return { size, me, allied, faction, ns, known, passable, os, counts, alive };
}

function analyzeFFA(state) {
  const result = empty(), c = context(state);
  if (!c) return result;
  const { size, me, allied, faction, ns, known, passable, os, counts, alive } = c;
  const turn = Number.isFinite(state.turn) ? state.turn : 0;
  let mem = memories.get(state);
  if (!mem || turn < mem.turn || mem.previous.length !== size || mem.me !== me) {
    mem = { turn, me, previous: [], aggression: new Map(), target: null, lockedAt: turn };
    memories.set(state, mem);
  }
  const enemies = [...alive].filter(p => !allied(me, p));
  const active = new Set([...alive].map(faction)).size >= 3;
  for (let i = 0; i < size; i++) {
    if (mem.previous[i] === me && known(i) && enemies.includes(os[i])) mem.aggression.set(os[i], turn + 40);
  }
  for (const [p, until] of mem.aggression) if (until < turn || !enemies.includes(p)) mem.aggression.delete(p);
  const anchors = [], crowns = [], own = [];
  for (let i = 0; i < size; i++) if (os[i] === me && known(i)) {
    own.push(i);
    if (state.grid[i] >= 51 && state.grid[i] <= 149) anchors.push(i);
    if (state.grid[i] === 100 + me) crowns.push(i);
  }
  // 无建筑时以最大己军作为锚点；四连通可见路径，不使用穿墙曼哈顿距离。
  if (!anchors.length && own.length) anchors.push(own.reduce((a, b) => counts[a] >= counts[b] ? a : b));
  function distances(seeds) {
    const d = new Int32Array(size).fill(-1), root = new Int32Array(size).fill(-1), q = seeds.slice();
    for (const i of q) { d[i] = 0; root[i] = i; }
    for (let h = 0; h < q.length; h++) for (const j of ns(q[h])) if (passable(j) && d[j] < 0) {
      d[j] = d[q[h]] + 1; root[j] = root[q[h]]; q.push(j);
    }
    return { d, root };
  }
  const { d, root } = distances(anchors), fromOwn = distances(own).d;
  const scores = new Map(enemies.map(p => [p, -Infinity]));
  const ownPower = own.reduce((sum, i) => sum + counts[i], 0);
  const powers = new Map();
  for (let i = 0; i < size; i++) if (known(i)) powers.set(os[i], (powers.get(os[i]) || 0) + counts[i]);
  for (let i = 0; i < size; i++) {
    const p = os[i];
    if (!enemies.includes(p) || !known(i)) continue;
    const border = ns(i).filter(j => os[j] === me).length;
    const score = fromOwn[i] < 0 ? -10000 : -fromOwn[i] * 5 + border * 3 + Math.min(10, ownPower / Math.max(1, powers.get(p)));
    scores.set(p, Math.max(scores.get(p), score));
    if (state.isolated?.[i] || d[i] < 1 || d[i] > 6) continue;
    const a = root[i], attack = Math.max(0, counts[i] - d[i]);
    // 弱军路过不登记；必须具有压过锚点防守的实际兵力。
    if (attack > counts[a]) result.threats.push({ owner: p, index: i, anchor: a, distance: d[i], attack,
      strong: d[i] <= 2 && state.grid[a] === 100 + me, reason: '锚点可达兵力威胁' });
  }
  for (const p of mem.aggression.keys()) result.threats.push({ owner: p, reason: '近期实际夺地', strong: false });
  for (const p of enemies) if (result.threats.some(t => allied(t.owner, p))) result.defensiveOwners.add(p);
  const ranked = enemies.slice().sort((a, b) => scores.get(b) - scores.get(a) || a - b);
  const urgent = result.threats.filter(t => t.strong).sort((a, b) => a.distance - b.distance || b.attack - a.attack)[0];
  let target = mem.target;
  if (!enemies.includes(target)) target = ranked[0] ?? null;
  else if (urgent && !allied(urgent.owner, target)) target = urgent.owner;
  else if (turn - mem.lockedAt >= 60) target = ranked[0] ?? null;
  if (target !== mem.target || turn - mem.lockedAt >= 60) mem.lockedAt = turn;
  mem.target = target;
  result.targetOwner = active ? target : null;
  for (const p of enemies) if (!active || allied(p, target) || result.defensiveOwners.has(p)) result.allowedOwners.add(p);

  // 双阵营不覆盖原有策略。紧急动作只处理当前可见威胁，不保证雾中或多队列安全。
  if (active) {
    const push = (s, t) => {
      if (state.isolated?.[s] || ns(s).some(j => !known(j))) return 0;
      let reserve = 0;
      for (const j of ns(s)) if (j !== t && state.grid[j] !== 201 && !allied(os[s], os[j])) reserve += counts[j] - 1;
      return Math.max(0, Math.min(counts[s] - 1, counts[s] - reserve - 1));
    };
    const safe = (s, t, amount) => crowns.every(a => {
      const defense = counts[a] - (a === s ? amount : 0) + (a === t ? amount : 0);
      return ns(a).every(j => known(j) && (j === t || !os[j] || allied(me, os[j]) || state.isolated?.[j] || counts[j] - 1 <= defense));
    });
    let best = null;
    for (const threat of result.threats) {
      if (threat.index === undefined || threat.distance > 2) continue;
      for (const t of [threat.index, threat.anchor]) for (const s of ns(t)) {
        if (os[s] !== me || !known(s)) continue;
        const amount = push(s, t), defend = os[t] === me;
        if (amount <= 0 || (defend ? counts[t] + amount < threat.attack : amount <= counts[t]) || !safe(s, t, amount)) continue;
        const score = (defend ? 0 : 100) + amount;
        if (!best || score > best.score) best = { s, t, score, defend };
      }
    }
    if (best) result.emergencyMove = { kind: 'attack', x: Math.floor(best.s / state.m), y: best.s % state.m,
      dx: Math.floor(best.t / state.m), dy: best.t % state.m, mode: 0, half: false,
      reason: best.defend ? 'FFA紧急自有地汇兵防守' : 'FFA清除近锚点威胁' };
  }
  mem.previous = os.map((p, i) => known(i) ? p : 0); mem.turn = turn;
  return result;
}

// 这是附加过滤器，不替代原有建造、队友支援、兵力等合法性检查。
function acceptFFAAction(state, action, analysis) {
  const c = context(state);
  if (!c || !action) return false;
  if (action.kind === 'build') return true;
  if (action.kind != null && action.kind !== 'attack') return false;
  const { x, y, dx, dy } = action;
  if (![x, y, dx, dy].every(Number.isInteger) || x < 0 || x >= state.n || dx < 0 || dx >= state.n ||
      y < 0 || y >= state.m || dy < 0 || dy >= state.m || Math.abs(x - dx) + Math.abs(y - dy) !== 1) return false;
  const s = x * state.m + y, t = dx * state.m + dy;
  if (c.os[s] !== c.me || !c.passable(t)) return false;
  const p = c.os[t];
  if (!p || c.allied(c.me, p)) return true;
  if (new Set([...c.alive].map(c.faction)).size < 3) return true;
  return (analysis || analyzeFFA(state)).allowedOwners.has(p);
}
module.exports = { analyzeFFA, acceptFFAAction };
