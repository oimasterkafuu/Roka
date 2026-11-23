'use strict';

// Prediction-accuracy probe for ./shadow.
//
// Plays one 1v1 game in-process with the same harness as
// bot-template/relay-bot/training/evaluate.cjs (real engine, mock clock, both bots attached to
// their own socket), records every order relay emits, and compares it with the
// order the shadow queued for the same frame. Use it to measure how often the
// prediction is exact and how often the drift guard would fire.
//
//   BOT3_SHADOW=1 BOT3_SHADOW_TRACE=1 SEED=bot3-baseline-1 MAP=random MODE=000 \
//     SEAT=0 node bot-template/relay-bot/shadow-probe.cjs
//
// SEED/MAP/MODE/SEAT/TICKS select the game; SEAT is the seat our bot takes.
const { EventEmitter } = require('node:events');
const { mock } = require('node:test');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const { GameEngine } = require(path.join(ROOT, 'dist/game-engine'));
const { resolveMapSizeRatioByPlayers } = require(path.join(ROOT, 'dist/map/map-size'));
const { FIXED_SWAMP_RATIO } = require(path.join(ROOT, 'dist/server/lobby-service'));
const { attachStrategy } = require('./strategy');
const { attachStrategy: relayStrategy } = require('./baseline/strategy');
const shadow = require('./shadow');

const seed = process.env.SEED || 'relay-eval-1';
const map = process.env.MAP || 'random';
const mode = process.env.MODE || '000';
const seat = Number(process.env.SEAT ?? '0');
const limit = Number(process.env.TICKS || '1000');
const [large, fog, multi] = [...mode].map((bit) => bit === '1');

async function play() {
  const names = ['bot3', 'relay'];
  const ratio = resolveMapSizeRatioByPlayers(2) * (large ? 2 : 1);
  const flags = { multi_line: multi, fog };
  const ids = ['seat1', 'seat2'];
  const sockets = ids.map(() => new EventEmitter());
  const handles = [];
  const emitted = [[], []];
  const sent = [0, 0];
  const executed = [0, 0];
  const checkpoints = {};
  let engine,
    lastFrame,
    frameTurn = 0;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const simulatedNow = Date.now.bind(Date);
  let tickStart = performance.now();
  Date.now = () => simulatedNow() + Math.floor(performance.now() - tickStart);
  try {
    for (const [index, socket] of sockets.entries()) {
      const id = ids[index];
      const template = index === seat ? attachStrategy : relayStrategy;
      socket.id = id;
      socket.connected = true;
      socket.on('attack', ({ x, y, dx, dy, mode: moveMode }) => {
        sent[index]++;
        emitted[index].push({ turn: frameTurn, kind: 'attack', x, y, dx, dy, mode: moveMode });
        engine.addMove(id, x, y, dx, dy, moveMode);
      });
      socket.on('build', ({ x, y, op }) => {
        sent[index]++;
        emitted[index].push({ turn: frameTurn, kind: 'build', x, y, op });
        engine.addBuild(id, x, y, op);
      });
      socket.on('clear_queue', () => engine.clearQueue(id));
      socket.on('pop_queue', () => engine.popQueue(id));
      socket.on('surrender', () => engine.surrender(id));
      handles.push(
        template(socket, { room: 'arena', team: 1, autoReady: true, actionDelayMs: 0, log: () => {} }),
      );
      socket.emit('connect');
      socket.emit('set_id', id);
      socket.emit('room_update', {
        ...flags,
        in_game: true,
        speed: 1,
        map_mode: map,
        players: ids.map((sid, i) => ({ sid, uid: names[i], team: 1, ready: true })),
      });
    }
    for (const s of sockets) s.emit('starting', {});
    engine = await GameEngine.create(
      {
        ...flags,
        width_ratio: ratio,
        height_ratio: ratio,
        swamp_ratio: FIXED_SWAMP_RATIO,
        map_token: seed,
        map_mode: map,
        map_size: large ? 'large' : 'normal',
        speed: 1,
        allow_team: false,
        player_names: names,
        player_teams: [1, 2],
      },
      ids,
      ids,
      'arena',
      {
        emitInitMap: (id, init) => sockets[ids.indexOf(id)].emit('init_map', init),
        update(id, frame) {
          lastFrame = frame;
          frameTurn = frame.turn;
          sockets[ids.indexOf(id)].emit('update', frame);
        },
        md5: (id) => id,
        chatMessage() {},
        endGame() {},
        replayStore: { saveReplay: async () => 'local' },
      },
    );
    await engine.sendMap(false);
    for (let tick = 1; tick <= limit; tick++) {
      tickStart = performance.now();
      mock.timers.tick(500);
      await new Promise((resolve) => setImmediate(resolve));
      const ended = await engine.gameTick();
      engine.executedTurnMoves.forEach((ops, i) => {
        executed[i] += ops.length;
      });
      if ([24, 25, 50, 100, 250].includes(tick)) {
        checkpoints[tick] = names.map((uid) => {
          const p = lastFrame.leaderboard.find((item) => item.uid === uid);
          return [p.land, p.army];
        });
      }
      if (!ended && tick < limit) continue;
      break;
    }
    const self = lastFrame.leaderboard.find((p) => p.uid === 'bot3');
    const winner = lastFrame.leaderboard.find((p) => !p.dead)?.uid;
    return {
      result: self.dead ? 'loss' : winner === 'bot3' ? 'win' : 'timeout',
      tick: lastFrame.turn,
      sent,
      executed,
      emitted,
      checkpoints,
    };
  } finally {
    handles.forEach((h) => h.stop());
    mock.timers.reset();
  }
}

// Compare the shadow trace with what relay actually emitted on each frame.
function compare(game) {
  const relaySeat = 1 - seat;
  const actual = new Map();
  for (const op of game.emitted[relaySeat]) {
    if (!actual.has(op.turn)) actual.set(op.turn, []);
    actual.get(op.turn).push(op);
  }
  const states = [...shadow.debugStates];
  const trace = states[0]?.trace ?? [];
  const cols = states[0]?.board?.cols ?? 0;
  const report = { frames: 0, planned: 0, matched: 0, armed: 0, misses: [] };
  for (const entry of trace) {
    const op = (actual.get(entry.turn) ?? [])[0];
    report.frames++;
    if (entry.armed) report.armed++;
    if (entry.from < 0) continue;
    report.planned++;
    const exact = entry.build
      ? op && op.kind === 'build' && entry.build === op.op
      : op &&
        op.kind === 'attack' &&
        entry.from === op.x * cols + op.y &&
        entry.to === op.dx * cols + op.dy &&
        entry.mode === op.mode;
    if (exact) report.matched++;
    else if (report.misses.length < 10) report.misses.push({ ...entry, actual: op ?? null });
  }
  return { ...report, stats: states.map((s) => s.stats), driftLog: states.flatMap((s) => s.driftLog) };
}

play()
  .then((game) => {
    const report = compare(game);
    console.log(
      JSON.stringify(
        {
          result: game.result,
          tick: game.tick,
          relayOps: game.emitted[1 - seat].length,
          frames: report.frames,
          planned: report.planned,
          matched: report.matched,
          accuracy: report.planned ? (report.matched / report.planned).toFixed(3) : 'n/a',
          armedFrames: report.armed,
          stats: report.stats,
          driftLog: report.driftLog,
          misses: report.misses,
          checkpoints: game.checkpoints,
          sent: game.sent,
          executed: game.executed,
        },
        null,
        1,
      ),
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
