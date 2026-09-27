// _E_ 28 场回放定量操作画像分析。
// 用法：node data/scratch/learn-e/analyze.cjs
// 输出：data/scratch/learn-e/metrics.json（供 make-report.cjs 使用）
//
// 解码与重放模式参考 scripts/extract-replay-frames.mjs；
// 格子编码参考 src/game-engine/map-encoding.ts（owner+50 指挥所 / owner+100 主城 /
// owner+150 己方沼泽 / 200 中立 / 201 山 / 204 中立沼泽）。扁平索引 idx = x*m + y。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const v8 = require('node:v8');

const ROOT = '/root/roka';
const REPLAY_DIR = path.join(ROOT, 'bot-template/anti-human-bot/training/replays-E');
const OUT_DIR = path.join(ROOT, 'data/scratch/learn-e');
const { GameEngine } = require(path.join(ROOT, 'dist/game-engine.js'));
const { buildScheduledReplayActions } = require(path.join(
  ROOT,
  'dist/game-engine/replay-scheduling.js',
));

const ownerOf = (code) => {
  if (code < 50) return code; // 普通格（0 = 中立有兵格）
  if (code < 100) return code - 50; // 指挥所
  if (code < 150) return code - 100; // 主城
  if (code < 200) return code - 150; // 己方沼泽
  return 0; // 200 中立 / 201 山 / 204 中立沼泽
};
const isCrown = (code) => code >= 100 && code < 150;
const isPost = (code) => code >= 50 && code < 100;
const isPassable = (code) => code !== 201;

const SAMPLE_TICKS = [10, 25, 50, 75, 100, 200, 400];
const IDLE_TICKS = [50, 100, 200, 400];

async function analyzeReplay(file) {
  const replayId = path.basename(file, '.rpl');
  const replay = v8.deserialize(zlib.brotliDecompressSync(fs.readFileSync(file)));
  const meta = replay.meta;
  const P = meta.player_names.length;
  const engine = new GameEngine(
    {
      ...meta,
      allow_team: meta.allow_team ?? false,
      fog: false,
      map_size_version: meta.map_size_version ?? 1,
    },
    meta.player_names.map((_, i) => `replay_sid_${i}`),
    meta.player_names.map((_, i) => `replay_id_${i}`),
    '__replay_build__',
    {
      update: () => undefined,
      emitInitMap: () => undefined,
      chatMessage: () => undefined,
      endGame: () => undefined,
      md5: (x) => x,
      replayStore: { saveReplay: async () => '' },
    },
  );
  await engine.initializeMap();
  engine.selectGenerals();
  const { scheduledMoves, scheduledBuilds, scheduledSurrenders } =
    buildScheduledReplayActions(replay);
  const n = engine.n;
  const m = engine.m;

  const participants = [];
  for (let p = 0; p < P; p += 1) {
    if ((meta.player_teams[p] ?? 0) !== 0) participants.push(p);
  }
  const teamOf = (p) => meta.player_teams[p];
  const isEnemy = (a, b) => teamOf(a) !== teamOf(b);

  // 每玩家统计数据（按玩家索引，观战者留空占位）
  const stats = [...Array(P)].map(() => ({
    moveTicks: 0,
    buildTicks: 0,
    moveCount: 0,
    modeDist: [0, 0, 0],
    expand: 0, // 目的地中立
    attack: 0, // 目的地敌方
    transport: 0, // 目的地己方
    expandTicks: [],
    attackTicks: [],
    transportTicks: [],
    firstAttackTick: null,
    firstBuild: null, // {tick,x,y,kind,distToCrown}
    firstContactTick: null,
    aliveUntil: 0,
  }));
  const crownPos = [...Array(P)].map(() => null); // {x,y}
  const events = []; // 关键事件 {tick, type, ...}
  const actionLog = []; // 全部动作 {tick,p,kind,...}（供实例挖掘）
  const landCurve = []; // per tick: array per participant
  const armyCurve = [];
  const frames = {}; // 采样帧 {tick: {grid_type, army_cnt}}

  const classify = (frame, p) => {
    // 返回每玩家 {land, army} 以及接触信息
    const land = new Array(P).fill(0);
    const army = new Array(P).fill(0);
    for (let idx = 0; idx < n * m; idx += 1) {
      const o = ownerOf(frame.grid_type[idx]);
      if (o >= 1 && o <= P) {
        const pi = o - 1;
        land[pi] += 1;
        army[pi] += frame.army_cnt[idx] || 0;
      }
    }
    return { land, army };
  };

  const checkContact = (frame, tick) => {
    // 对每个未接触过的参赛者，检查其格子是否 4 邻接敌格
    const need = participants.filter((p) => stats[p].firstContactTick === null);
    if (need.length === 0) return;
    const gt = frame.grid_type;
    for (let idx = 0; idx < n * m; idx += 1) {
      const o = ownerOf(gt[idx]);
      if (o < 1 || o > P) continue;
      const pi = o - 1;
      if (stats[pi].firstContactTick !== null) continue;
      if (!isPassable(gt[idx])) continue;
      const x = Math.floor(idx / m);
      const y = idx % m;
      const nb = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of nb) {
        if (nx < 0 || nx >= n || ny < 0 || ny >= m) continue;
        const no = ownerOf(gt[nx * m + ny]);
        if (no >= 1 && no <= P && isEnemy(pi, no - 1)) {
          stats[pi].firstContactTick = tick;
          break;
        }
      }
    }
  };

  const idleMetric = (frame, p) => {
    // 距最近敌格曼哈顿距离 > 3 的己方格兵力 / 总兵力
    const gt = frame.grid_type;
    const ac = frame.army_cnt;
    const enemies = [];
    for (let idx = 0; idx < n * m; idx += 1) {
      const o = ownerOf(gt[idx]);
      if (o >= 1 && o <= P && isEnemy(p, o - 1) && isPassable(gt[idx])) {
        enemies.push([Math.floor(idx / m), idx % m]);
      }
    }
    let idle = 0;
    let total = 0;
    for (let idx = 0; idx < n * m; idx += 1) {
      const o = ownerOf(gt[idx]);
      if (o - 1 !== p) continue;
      const a = ac[idx] || 0;
      if (a <= 0) continue;
      total += a;
      const x = Math.floor(idx / m);
      const y = idx % m;
      let dmin = Infinity;
      for (const [ex, ey] of enemies) {
        const d = Math.abs(ex - x) + Math.abs(ey - y);
        if (d < dmin) dmin = d;
        if (dmin <= 3) break;
      }
      if (dmin > 3) idle += a;
    }
    return total > 0 ? +(idle / total).toFixed(3) : null;
  };

  let prevFrame = engine.buildReplayFrame(false);
  // 初始主城位置
  {
    const c = classify(prevFrame);
    landCurve.push(c.land);
    armyCurve.push(c.army);
  }
  for (let p = 0; p < P; p += 1) {
    for (let idx = 0; idx < n * m; idx += 1) {
      if (prevFrame.grid_type[idx] === p + 1 + 100) {
        crownPos[p] = { x: Math.floor(idx / m), y: idx % m };
      }
    }
  }
  frames[0] = prevFrame;
  for (const t of SAMPLE_TICKS) {
    // 占位，后面填
  }

  const recordSurrender = new Set();
  while (engine.turn < replay.total_turns) {
    const nextTurn = engine.turn + 1;
    for (let p = 0; p < P; p += 1) {
      if (scheduledSurrenders[p] && scheduledSurrenders[p].has(nextTurn)) {
        engine.surrender(engine.playerSids[p]);
        recordSurrender.add(`${p}:${nextTurn}`);
        events.push({ tick: nextTurn, type: 'surrender', player: p });
      }
    }
    for (let p = 0; p < P; p += 1) {
      const build = scheduledBuilds[p] && scheduledBuilds[p].get(nextTurn);
      if (build) {
        engine.addBuild(engine.playerSids[p], build.x, build.y, build.kind);
        const s = stats[p];
        s.buildTicks += 1;
        const crown = crownPos[p];
        const dist = crown ? Math.abs(build.x - crown.x) + Math.abs(build.y - crown.y) : null;
        if (!s.firstBuild) {
          s.firstBuild = { tick: nextTurn, x: build.x, y: build.y, kind: build.kind, distToCrown: dist };
        }
        actionLog.push({
          tick: nextTurn,
          p,
          kind: 'build',
          buildKind: build.kind,
          x: build.x,
          y: build.y,
          srcArmy: prevFrame.army_cnt[build.x * m + build.y] || 0,
        });
      }
    }
    for (let p = 0; p < P; p += 1) {
      const move = scheduledMoves[p] && scheduledMoves[p].get(nextTurn);
      if (move) {
        engine.addMove(engine.playerSids[p], move[0], move[1], move[2], move[3], move[4]);
        const s = stats[p];
        s.moveTicks += 1;
        s.moveCount += 1;
        const mode = move[4] || 0;
        if (mode >= 0 && mode <= 2) s.modeDist[mode] += 1;
        // scheduled move 的 dx/dy 是绝对目的地坐标（见 replay-scheduling.ts）
        const tx = move[2];
        const ty = move[3];
        const dstCode = prevFrame.grid_type[tx * m + ty];
        const dstOwner = ownerOf(dstCode);
        const srcIdx = move[0] * m + move[1];
        const srcArmy = prevFrame.army_cnt[srcIdx] || 0;
        let cls;
        if (dstOwner === p + 1) {
          cls = 'transport';
          s.transport += 1;
          s.transportTicks.push(nextTurn);
        } else if (dstOwner >= 1 && dstOwner <= P && isEnemy(p, dstOwner - 1)) {
          cls = 'attack';
          s.attack += 1;
          s.attackTicks.push(nextTurn);
          if (s.firstAttackTick === null) s.firstAttackTick = nextTurn;
        } else {
          cls = 'expand';
          s.expand += 1;
          s.expandTicks.push(nextTurn);
        }
        actionLog.push({
          tick: nextTurn,
          p,
          kind: 'move',
          sx: move[0],
          sy: move[1],
          tx,
          ty,
          mode,
          srcArmy,
          dstOwner: dstOwner >= 1 && dstOwner <= P ? meta.player_names[dstOwner - 1] : 'neutral',
          dstCode,
          cls,
        });
      }
    }
    const gameEnd = await engine.gameTick();
    const frame = engine.buildReplayFrame(gameEnd || engine.turn >= replay.total_turns);
    const c = classify(frame);
    landCurve.push(c.land);
    armyCurve.push(c.army);
    for (const p of participants) {
      if (c.land[p] > 0) stats[p].aliveUntil = frame.turn;
    }
    checkContact(frame, frame.turn);
    // 夺城事件：prev 帧里是敌方指挥所/主城，现在归非原主
    for (let idx = 0; idx < n * m; idx += 1) {
      const pc = prevFrame.grid_type[idx];
      const nc = frame.grid_type[idx];
      if ((isPost(pc) || isCrown(pc)) && pc !== nc) {
        const prevOwner = ownerOf(pc);
        const newOwner = ownerOf(nc);
        if (prevOwner >= 1 && prevOwner <= P && newOwner !== prevOwner) {
          events.push({
            tick: frame.turn,
            type: isCrown(pc) ? 'crown_fall' : 'post_fall',
            x: Math.floor(idx / m),
            y: idx % m,
            from: prevOwner - 1,
            to: newOwner >= 1 && newOwner <= P ? newOwner - 1 : null,
          });
        }
      }
    }
    if (SAMPLE_TICKS.includes(frame.turn) || IDLE_TICKS.includes(frame.turn)) {
      frames[frame.turn] = frame;
    }
    prevFrame = frame;
    if (gameEnd) break;
  }
  const finalTurn = engine.turn;

  // 采样帧指标
  const opening = [...Array(P)].map((_, p) => {
    const o = {};
    for (const t of SAMPLE_TICKS) {
      const f = frames[t];
      if (!f) {
        o[t] = null;
        continue;
      }
      let land = 0;
      let army = 0;
      for (let idx = 0; idx < n * m; idx += 1) {
        if (ownerOf(f.grid_type[idx]) === p + 1) {
          land += 1;
          army += f.army_cnt[idx] || 0;
        }
      }
      o[t] = { land, army };
    }
    return o;
  });
  const idle = [...Array(P)].map((_, p) => {
    const o = {};
    for (const t of IDLE_TICKS) {
      const f = frames[t];
      o[t] = f ? idleMetric(f, p) : null;
    }
    return o;
  });

  // 胜者：终帧领土最多的参赛队伍
  const finalLand = landCurve[landCurve.length - 1];
  const finalArmy = armyCurve[armyCurve.length - 1];
  const teamLand = new Map();
  for (const p of participants) {
    const t = teamOf(p);
    teamLand.set(t, (teamLand.get(t) || 0) + finalLand[p]);
  }
  let winnerTeam = null;
  let best = -1;
  for (const [t, l] of teamLand) {
    if (l > best) {
      best = l;
      winnerTeam = t;
    }
  }
  const winners = participants.filter((p) => teamOf(p) === winnerTeam && finalLand[p] > 0);

  // 转折点（对每位参赛者）：最后一次兵力 >= 对手最大兵力 的 tick（终局落后时）
  const turning = {};
  const eIdx = participants.find((p) => meta.player_names[p] === '_E_');
  if (eIdx !== undefined) {
    const opp = participants.filter((p) => isEnemy(eIdx, p));
    const oppMaxArmy = armyCurve.map((a) => Math.max(...opp.map((p) => a[p]), 0));
    const eArmy = armyCurve.map((a) => a[eIdx]);
    let lastLead = -1;
    for (let t = 0; t <= finalTurn; t += 1) {
      if (eArmy[t] >= oppMaxArmy[t]) lastLead = t;
    }
    let peakRatio = -Infinity;
    let peakTick = 0;
    for (let t = 0; t <= finalTurn; t += 1) {
      const r = eArmy[t] / Math.max(oppMaxArmy[t], 1);
      if (r > peakRatio) {
        peakRatio = r;
        peakTick = t;
      }
    }
    turning.lastLeadTick = lastLead >= finalTurn ? null : lastLead;
    turning.peakRatioTick = peakTick;
    turning.peakRatio = +peakRatio.toFixed(2);
  }

  return {
    replayId,
    meta: {
      playerNames: meta.player_names,
      playerTeams: meta.player_teams,
      mapMode: meta.map_mode,
      speed: meta.speed,
      n,
      m,
    },
    totalTurns: replay.total_turns,
    finalTurn,
    participants,
    winners,
    winnerNames: winners.map((p) => meta.player_names[p]),
    stats: participants.map((p) => {
      const s = stats[p];
      const denom = Math.max(s.aliveUntil, 1);
      return {
        player: meta.player_names[p],
        team: teamOf(p),
        aliveUntil: s.aliveUntil,
        moveTickRate: +(s.moveTicks / denom).toFixed(3),
        buildTickRate: +(s.buildTicks / denom).toFixed(3),
        moveCount: s.moveCount,
        modeDist: s.modeDist,
        expand: s.expand,
        attack: s.attack,
        transport: s.transport,
        firstAttackTick: s.firstAttackTick,
        firstBuild: s.firstBuild,
        firstContactTick: s.firstContactTick,
        opening: opening[p],
        idle: idle[p],
        attackTicks: s.attackTicks,
        expandTicks: s.expandTicks,
        transportTicks: s.transportTicks,
      };
    }),
    crownPos: crownPos.map((c, p) => ({ player: meta.player_names[p], ...c })),
    events,
    turning,
    landCurve,
    armyCurve,
    actionLog,
  };
}

(async () => {
  const files = fs
    .readdirSync(REPLAY_DIR)
    .filter((f) => f.endsWith('.rpl'))
    .sort();
  const results = [];
  for (const f of files) {
    const r = await analyzeReplay(path.join(REPLAY_DIR, f));
    results.push(r);
    console.log(
      `${r.replayId}: turns=${r.finalTurn} players=${r.meta.playerNames.join(',')} winner=${r.winnerNames.join(',')}`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'metrics.json'), JSON.stringify(results));
  console.log(`metrics -> ${path.join(OUT_DIR, 'metrics.json')} (${results.length} games)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
