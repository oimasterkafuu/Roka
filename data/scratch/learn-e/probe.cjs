'use strict';
// 复盘探针：重放指定回放，逐 tick 用当前 bot/policy.cjs 替 Anti_Human 做决策，
// 与回放里 bot 的实际动作对照。用法:
//   node data/scratch/learn-e/probe.cjs <replayId> <from> <to> [--defense]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const v8 = require('node:v8');
const { createRequire } = require('node:module');

const rootDir = path.resolve(__dirname, '../../..');
const require2 = createRequire(path.join(rootDir, 'package.json'));
const { GameEngine } = require2(path.join(rootDir, 'dist', 'game-engine.js'));
const { buildScheduledReplayActions } = require2(
  path.join(rootDir, 'dist', 'game-engine', 'replay-scheduling.js'),
);
const botDir = path.join(rootDir, 'bot-template', 'anti-human-bot');
const { BoardState } = require(path.join(botDir, 'bot', 'state.cjs'));
const { chooseAction } = require(path.join(botDir, 'bot', 'policy.cjs'));
const { chooseDefense } = require(path.join(botDir, 'bot', 'defense.cjs'));

const [replayId, fromS, toS] = process.argv.slice(2);
const from = Number(fromS), to = Number(toS);
const showDefense = process.argv.includes('--defense');

const rplDirs = [path.join(rootDir, 'data', 'replays'),
  path.join(botDir, 'training', 'replays-E')];
let buf = null;
for (const d of rplDirs) {
  const p = path.join(d, `${replayId}.rpl`);
  if (fs.existsSync(p)) { buf = fs.readFileSync(p); break; }
}
if (!buf) throw new Error('找不到回放 ' + replayId);
const replay = v8.deserialize(zlib.brotliDecompressSync(buf));
const meta = replay.meta;
const botSeat = meta.player_names.indexOf('Anti_Human');
if (botSeat < 0) throw new Error('该局没有 Anti_Human');
console.log(`replay=${replayId} players=${JSON.stringify(meta.player_names)} teams=${JSON.stringify(meta.player_teams)} botSeat=${botSeat} turns=${replay.total_turns}`);

const engine = new GameEngine(
  { ...meta, allow_team: meta.allow_team ?? false, fog: false, map_size_version: meta.map_size_version ?? 1 },
  meta.player_names.map((_, i) => `replay_sid_${i}`),
  meta.player_names.map((_, i) => `replay_id_${i}`),
  '__replay_build__',
  { update: () => undefined, emitInitMap: () => undefined, chatMessage: () => undefined,
    endGame: () => undefined, md5: (x) => x, replayStore: { saveReplay: async () => '' } },
);
(async () => {
  await engine.initializeMap();
  engine.selectGenerals();
  const { scheduledMoves, scheduledBuilds, scheduledSurrenders } = buildScheduledReplayActions(replay);
  const state = new BoardState(
    { n: engine.n, m: engine.m, player_ids: meta.player_names.map((_, i) => `replay_id_${i}`) },
    `replay_id_${botSeat}`,
  );
  const leaderboard = meta.player_names.map((name, i) => ({
    id: i + 1, team: meta.player_teams[i] ?? 0, dead: 0, class_: '', army: 0, land: 0,
  }));
  const feed = (frame, gameEnd) => {
    state.apply({
      turn: frame.turn, grid_type: frame.grid_type, army_cnt: frame.army_cnt,
      isolated: frame.isolated, is_diff: false, game_end: gameEnd, leaderboard,
    });
  };
  feed(engine.buildReplayFrame(false), false);
  const fmt = (a) => !a ? 'null' :
    a.kind === 'build' ? `build ${a.op}@(${a.x},${a.y}) ${JSON.stringify(a.reason)}` :
    `move (${a.x},${a.y})->(${a.dx},${a.dy}) mode${a.mode ?? 0} ${JSON.stringify(a.reason)}`;
  while (engine.turn < replay.total_turns) {
    const nextTurn = engine.turn + 1;
    // 决策点：当前帧状态（turn=engine.turn）下当前 policy 会做什么
    if (engine.turn >= from && engine.turn <= to && !state.dead) {
      const t0 = Date.now();
      const action = chooseAction(state);
      const ms = Date.now() - t0;
      const actual = scheduledMoves[botSeat].get(nextTurn) || scheduledBuilds[botSeat].get(nextTurn) || null;
      const actualFmt = !actual ? 'null' : actual.kind || Array.isArray(actual) ?
        (Array.isArray(actual) ? `move (${actual[0]},${actual[1]})->(${actual[2]},${actual[3]}) mode${actual[4]}` : `build ${actual.kind}@(${actual.x},${actual.y})`) : '?';
      let line = `t${engine.turn} now=${fmt(action)} [${ms}ms] | actual(t${nextTurn})=${actualFmt}`;
      if (showDefense) {
        const def = chooseDefense(state);
        line += ` | defense=${def ? `${def.urgent ? 'URGENT' : ''}${def.imminent ? 'IMMINENT' : ''} ${fmt(def.move)}` : 'null'}`;
      }
      console.log(line);
    }
    for (let p = 0; p < scheduledSurrenders.length; p += 1)
      if (scheduledSurrenders[p].has(nextTurn)) engine.surrender(engine.playerSids[p]);
    for (let p = 0; p < scheduledBuilds.length; p += 1) {
      const b = scheduledBuilds[p].get(nextTurn);
      if (b) engine.addBuild(engine.playerSids[p], b.x, b.y, b.kind);
    }
    for (let p = 0; p < scheduledMoves.length; p += 1) {
      const mv = scheduledMoves[p].get(nextTurn);
      if (mv) engine.addMove(engine.playerSids[p], mv[0], mv[1], mv[2], mv[3], mv[4]);
    }
    const gameEnd = await engine.gameTick();
    feed(engine.buildReplayFrame(gameEnd || engine.turn >= replay.total_turns), Boolean(gameEnd));
    if (gameEnd) break;
  }
})();
