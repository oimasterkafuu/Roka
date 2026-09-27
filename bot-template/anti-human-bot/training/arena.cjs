'use strict';

// 离线真实引擎 harness。运行: node --test training/arena.test.cjs
// turns 是引擎 Tick（不是 UI 的半速回合）；dx/dy 是目标绝对坐标。
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { BoardState } = require('../bot/state.cjs');
const enginePath = path.resolve(__dirname, '../reference/src/game-engine.ts');
const cache = new Map();
const MAP_MODES = ['random', 'maze', 'archipelago', 'mediterranean'];

/** 内存 CJS 缓存，不写 reference 或临时文件。返回 { GameEngine }。
 * synchronous:false 保留原始 async 引擎，供一致性测试。
 * 只移除两个方法的 async 和 gameTick 唯一的 await，规则代码不变。
 * 如果上游新增异步依赖则明确失败，而不是悄悄改变执行顺序。
 */
function loadEngine({ synchronous = true } = {}) {
  if (cache.has(synchronous)) return cache.get(synchronous);
  let source = fs.readFileSync(enginePath, 'utf8');
  if (synchronous) {
    for (const [name, result] of [['initializeMap', 'void'], ['gameTick', 'boolean']]) {
      const header = `private async ${name}(): Promise<${result}> {`;
      const start = source.indexOf(header);
      const end = source.indexOf('\n  }', start);
      if (start < 0 || end < 0) throw new Error(`引擎接口变化: ${name}`);
      let body = source.slice(start, end);
      const awaits = body.match(/\bawait\b/g) || [];
      if (awaits.length !== (name === 'gameTick' ? 1 : 0) ||
          (name === 'gameTick' && !body.includes('await this.sendMap(gameEnd);'))) {
        throw new Error(`引擎新增异步逻辑，需审核: ${name}`);
      }
      body = body.replace(header, `private ${name}(): ${result} {`)
        .replace('await this.sendMap(gameEnd);', 'this.sendMap(gameEnd);');
      source = source.slice(0, start) + body + source.slice(end);
    }
  }
  const built = require('esbuild').buildSync({
    stdin: { contents: source, sourcefile: enginePath, resolveDir: path.dirname(enginePath), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', write: false,
    external: ['better-sqlite3', 'sqlite3'], logLevel: 'silent',
  });
  const compiled = new Module(enginePath + '.arena.cjs', module);
  compiled.filename = enginePath + '.arena.cjs';
  compiled.paths = Module._nodeModulePaths(path.dirname(enginePath));
  compiled._compile(built.outputFiles[0].text, compiled.filename);
  cache.set(synchronous, compiled.exports);
  return compiled.exports;
}

/** 额外公开手动测试入口；不会启动 startGame/timer。
 * AFK 使用引擎 replay 模式关闭（不能让离线 CPU 耗时决定胜负）。
 */
function createArena({ mapMode = 'random', seed = 'default', mapSize = 0.5, synchronous = true } = {}) {
  if (!MAP_MODES.includes(mapMode)) throw new Error(`不支持地图: ${mapMode}`);
  if (!Number.isFinite(mapSize) || mapSize < 0.2 || mapSize > 1.35) throw new Error('mapSize 必须在 [0.2, 1.35]');
  const { GameEngine } = loadEngine({ synchronous });
  const sids = ['arena-0', 'arena-1'];
  const states = [];
  const builds = [];
  const stats = sids.map((_, player) => ({ player, attacks: 0, builds: 0, upgrades: 0, rejected: 0 }));
  let ended = false;
  let result = null;
  const engine = new GameEngine({
    width_ratio: mapSize, height_ratio: mapSize, map_size_version: 2,
    city_ratio: 0, mountain_ratio: 0, swamp_ratio: 0.05,
    speed: 1, allow_team: false, fog: false, map_token: String(seed), map_mode: mapMode,
    player_names: sids, player_teams: [1, 2],
  }, sids, sids, '__replay_build__', {
    update(sid, payload) {
      if (!states[sids.indexOf(sid)].apply(payload)) throw new Error('无效引擎帧');
    },
    emitInitMap(sid, init) { states[sids.indexOf(sid)] = new BoardState(init, sid); },
    chatMessage() {},
    endGame(gid, entries) { result = entries; },
    md5: (input) => input,
    replayStore: { saveReplay() { throw new Error('arena 禁止写回放'); } },
  });
  // initializeMap 当前完全同步；原版 async 入口也在返回 Promise 前完成赋值。
  const initialization = engine.initializeMap();
  engine.selectGenerals();
  for (let p = 0; p < 2; p++) {
    engine.emitInitMap(sids[p], { n: engine.n, m: engine.m, player_ids: sids, general: engine.generals[p] });
  }
  // 原 sendMap 的 randomInt(51) 仅用于全量/差分发送，与规则无关。
  // 保留 update、操作确认、kills 清空和最终 endGame 回调，不存储回放。
  engine.recordReplayTurnMoves = () => {};
  engine.sendMap = (gameEnd) => {
    const payload = engine.buildFullVisionPayload(gameEnd);
    payload.kills = engine.recentKills;
    engine.recentKills = {};
    for (let p = 0; p < 2; p++) {
      const op = engine.lstMove[p];
      if (op) {
        if (op.kind === 'm') stats[p].attacks++;
        else {
          stats[p][op.kind === 'b' ? 'builds' : 'upgrades']++;
          builds.push({ player: p, turn: engine.turn, x: op.x, y: op.y, op: op.kind });
        }
      }
      stats[p].rejected += engine.lstSkip[p];
      engine.update(sids[p], { ...payload, lst_move: engine.toMovePayload(op, engine.lstSkip[p]) });
      engine.lstMove[p] = null;
      engine.lstSkip[p] = 0;
    }
    ended = gameEnd;
  };
  engine.sendMap(false);
  function submit(player, action) {
    if (action == null) return;
    if (!action || !['attack', 'build'].includes(action.kind) ||
        !Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new Error('无效 policy action');
    if (action.kind === 'attack') {
      const mode = action.mode ?? 0;
      if (!Number.isInteger(action.dx) || !Number.isInteger(action.dy) || ![0, 1, 2].includes(mode)) throw new Error('无效 attack action');
      engine.addMove(sids[player], action.x, action.y, action.dx, action.dy, mode);
    } else {
      const op = action.op ?? 'b';
      if (!['b', 'c'].includes(op)) throw new Error('build.op 必须是 b 或 c');
      engine.addBuild(sids[player], action.x, action.y, op);
    }
  }
  function finish(gameEnd) {
    if (gameEnd && result === null) engine.finishGame();
    return gameEnd;
  }
  return {
    engine, states, builds, stats, initialization, submit,
    get ended() { return ended; },
    get result() { return result; },
    tick(actions = [null, null]) {
      if (ended) return synchronous ? true : Promise.resolve(true);
      actions.forEach((action, p) => submit(p, action));
      const value = engine.gameTick();
      return synchronous ? finish(value) : value.then(finish);
    },
  };
}

/** policies 必须为同步函数；双方决策看到同一 Tick 的独立 BoardState。
 * stats 按玩家 0/1 排列；builds 只记录引擎确认成功的建造。
 * 截止 maxTurns 未分胜负时 winner=null、ended=false，不以兵力判胜。
 */
function runMatch({ mapMode = 'random', seed = 'default', maxTurns = 600, policies, mapSize = 0.5 } = {}) {
  if (!Number.isInteger(maxTurns) || maxTurns < 0) throw new Error('maxTurns 必须是非负整数');
  if (!Array.isArray(policies) || policies.length !== 2 || policies.some((p) => typeof p !== 'function')) throw new Error('需要两名同步 policy');
  const start = performance.now();
  const arena = createArena({ mapMode, seed, mapSize });
  while (!arena.ended && arena.engine.turn < maxTurns) {
    const actions = policies.map((policy, p) => arena.states[p].dead ? null : policy(arena.states[p]));
    arena.tick(actions);
  }
  const leaderboard = arena.engine.buildLeaderboard();
  const alive = leaderboard.filter((p) => p.class_ !== 'dead');
  return {
    winner: arena.ended && alive.length === 1 ? alive[0].id - 1 : null,
    turns: arena.engine.turn, ended: arena.ended,
    stats: arena.stats.map((stat, p) => ({ ...stat, ...leaderboard.find((entry) => entry.id === p + 1) })),
    elapsedMs: performance.now() - start,
    builds: arena.builds,
    materialScore: leaderboard.map((p) => p.army + p.land),
  };
}

module.exports = { runMatch, loadEngine, createArena, MAP_MODES };
