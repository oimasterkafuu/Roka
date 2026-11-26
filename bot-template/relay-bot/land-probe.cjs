'use strict';

// Per-tick trace probe for ./land (land race on the swamp-heavy clear cells).
//
// Plays one clear single-line 1v1 game in-process with the same harness as
// bot-template/relay-bot/training/evaluate.cjs, then prints every tenth tick: land, army and
// crowns for both seats plus the order mix each side spent the ticks on.
//
//   SEED=bot3-baseline-1 MAP=mediterranean MODE=000 SEAT=0 \
//     node bot-template/relay-bot/land-probe.cjs
const { EventEmitter } = require('node:events');
const { mock } = require('node:test');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const { GameEngine } = require(path.join(ROOT, 'dist/game-engine'));
const { resolveMapSizeRatioByPlayers } = require(path.join(ROOT, 'dist/map/map-size'));
const { FIXED_SWAMP_RATIO } = require(path.join(ROOT, 'dist/server/lobby-service'));
const { attachStrategy } = require('./strategy');
const { attachStrategy: relayStrategy } = require('./baseline/strategy');

const seed = process.env.SEED || 'bot3-baseline-1';
const map = process.env.MAP || 'mediterranean';
const mode = process.env.MODE || '000';
const seat = Number(process.env.SEAT ?? '0');
const limit = Number(process.env.TICKS || '1000');
const [large, fog, multi] = [...mode].map((bit) => bit === '1');
// Per-tick window (defaults: only every tenth tick).
const from = Number(process.env.TRACE_FROM || '0');
const to = Number(process.env.TRACE_TO || '0');

const ownerOf = (code) => (code < 200 ? code % 50 : 0);

// The frames are diffs: keep a full grid so the trace can classify targets.
let board = null;
const crown = (code) => code >= 100 && code < 150;

function classify(frame, x, y, team, me) {
  if (!frame) return 'unknown';
  const cols = frame.cols ?? Math.round(Math.sqrt(frame.grid_type.length));
  const code = frame.grid_type[x * cols + y] ?? 200;
  const owner = ownerOf(code);
  const mine = owner === me;
  const theirs = owner && !mine;
  return theirs ? 'attack' : mine ? 'merge' : 'capture';
}

async function play() {
  const names = ['bot3', 'relay'];
  const ratio = resolveMapSizeRatioByPlayers(2) * (large ? 2 : 1);
  const flags = { multi_line: multi, fog_mode: fog ? 'normal' : 'visible' };
  const ids = ['seat1', 'seat2'];
  const sockets = ids.map(() => new EventEmitter());
  const handles = [];
  const mix = [new Map(), new Map()];
  const trace = [];
  const orders = [];
  const detail = process.env.TRACE_ORDERS === '1';
  let engine,
    lastFrame,
    cols = 0;
  const bump = (side, kind) => mix[side].set(kind, (mix[side].get(kind) ?? 0) + 1);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const simulatedNow = Date.now.bind(Date);
  let tickStart = performance.now();
  Date.now = () => simulatedNow() + Math.floor(performance.now() - tickStart);
  try {
    for (const [index, socket] of sockets.entries()) {
      const id = ids[index];
      const me = 1 + index;
      const template = index === seat ? attachStrategy : relayStrategy;
      socket.id = id;
      socket.connected = true;
      socket.on('attack', ({ x, y, dx, dy, mode: moveMode }) => {
        bump(index, classify(lastFrame, dx, dy, 0, me));
        if (detail && index === seat) {
          const code = lastFrame?.grid_type[dx * cols + dy] ?? -1;
          const fromCode = lastFrame?.grid_type[x * cols + y] ?? -1;
          orders.push({ team: me, from: x * cols + y, to: dx * cols + dy, mode: moveMode, code, fromCode });
        }
        engine.addMove(id, x, y, dx, dy, moveMode);
      });
      socket.on('build', ({ x, y, op }) => {
        bump(index, op === 'c' ? 'city' : 'build');
        if (detail && index === seat) {
          orders.push({ team: me, from: x * cols + y, to: x * cols + y, build: op });
        }
        engine.addBuild(id, x, y, op);
      });
      socket.on('init_map', (init) => {
        cols = init.m;
        board = new Uint8Array(init.n * init.m);
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
          if (board && Array.isArray(frame.grid_type)) {
            if (!frame.is_diff)
              for (let i = 0; i < frame.grid_type.length; i++) board[i] = frame.grid_type[i];
            else
              for (let i = 0; i < frame.grid_type.length; i += 2)
                board[frame.grid_type[i]] = frame.grid_type[i + 1];
          }
          lastFrame = { ...frame, grid_type: board ?? frame.grid_type };
          sockets[ids.indexOf(id)].emit('update', frame);
        },
        md5: (id) => id,
        chatMessage() {},
        endGame() {},
        replayStore: { saveReplay: async () => 'local' },
      },
    );
    await engine.sendMap(false);
    const trace = [];
    for (let tick = 1; tick <= limit; tick++) {
      tickStart = performance.now();
      mock.timers.tick(500);
      await new Promise((resolve) => setImmediate(resolve));
      const ended = await engine.gameTick();
      if (tick % 10 === 0 || ended || (from && tick >= from && tick <= to)) {
        const stats = [1, 2].map((t) => {
          const p = lastFrame.leaderboard.find((row) => row.team === t);
          let crowns = 0;
          for (let i = 0; i < lastFrame.grid_type.length; i++)
            if (crown(lastFrame.grid_type[i]) && ownerOf(lastFrame.grid_type[i]) === t) crowns++;
          return { team: p.team, uid: p.uid, land: p.land, army: p.army, crowns, dead: p.dead };
        });
        const executed = engine.executedTurnMoves[seat].length;
        const pending = orders.splice(0, orders.length);
        trace.push({
          tick,
          stats,
          mix: mix.map((m) => Object.fromEntries(m)),
          orders: pending,
          executed,
          lastExecuted: engine.executedTurnMoves[seat].map((op) => ({ from: op.from, to: op.to })),
        });
        mix.forEach((m) => m.clear());
      }
      if (!ended && tick < limit) continue;
      break;
    }
    const self = lastFrame.leaderboard.find((p) => p.uid === 'bot3');
    const winner = lastFrame.leaderboard.find((p) => !p.dead)?.uid;
    return {
      result: self.dead ? 'loss' : winner === 'bot3' ? 'win' : 'timeout',
      tick: lastFrame.turn,
      trace,
    };
  } finally {
    handles.forEach((h) => h.stop());
    mock.timers.reset();
  }
}

play()
  .then((game) => {
    const { trace, ...summary } = game;
    console.log(JSON.stringify({ seed, map, seat, ...summary }, null, 0));
    for (const row of trace) {
      const [a, b] = row.stats;
      if (process.env.TRACE_ORDERS === '1') {
        const cols = 0;
        console.log(
          `   orders ${JSON.stringify(row.orders)} executed ${row.executed} last ${JSON.stringify(row.lastExecuted)}`,
        );
      }
      console.log(
        `t${String(row.tick).padStart(4)} bot3 L${String(a.land).padStart(3)} A${String(a.army).padStart(4)} ` +
          `C${String(a.crowns).padStart(3)} | relay L${String(b.land).padStart(3)} ` +
          `A${String(b.army).padStart(4)} C${String(b.crowns).padStart(3)} | ` +
          `bot3 ${JSON.stringify(row.mix[seat])} relay ${JSON.stringify(row.mix[1 - seat])}`,
      );
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
