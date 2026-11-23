'use strict';

// Per-tick diagnostic dump for the shadow layer.
//
// Plays one 1v1 game in-process (same harness as shadow-probe.cjs) and prints
// one line per tick: the predicted relay order, our chosen orders, and the
// crowns of both players with their garrisons. It is the tool used to see why a
// predicted order does or does not translate into a win on a specific map.
//
//   BOT3_SHADOW=1 SEED=bot3-baseline-1 MAP=archipelago MODE=000 SEAT=0 \
//     node bot-template/bot-3.0/shadow-dump.cjs
//
// SEED/MAP/MODE/SEAT/TICKS select the game; FROM/TO limit the printed turns.
const { EventEmitter } = require('node:events');
const { mock } = require('node:test');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const { GameEngine } = require(path.join(ROOT, 'dist/game-engine'));
const { resolveMapSizeRatioByPlayers } = require(path.join(ROOT, 'dist/map/map-size'));
const { FIXED_SWAMP_RATIO } = require(path.join(ROOT, 'dist/server/lobby-service'));
const { attachStrategy } = require('./strategy');
const OPPONENTS = {
  relay: '../relay-bot/strategy',
  anti: '../anti-human-bot/server-bot',
  apex: '../apex-bot/strategy',
  v2: '../bot-2.0/strategy',
};
const shadow = require('./shadow');

const seed = process.env.SEED || 'relay-eval-1';
const map = process.env.MAP || 'random';
const mode = process.env.MODE || '000';
const seat = Number(process.env.SEAT ?? '0');
const limit = Number(process.env.TICKS || '300');
const from = Number(process.env.FROM ?? '0');
const to = Number(process.env.TO ?? String(limit));
const opponent = process.env.OPP || 'relay';
const [large, fog, multi] = [...mode].map((bit) => bit === '1');

const ownerOf = (code) => (code < 200 ? code % 50 : 0);

function crowns(engine, player) {
  const cells = [];
  for (let x = 0; x < engine.gridType.length; x++)
    for (let y = 0; y < engine.gridType[x].length; y++)
      if (engine.gridType[x][y] === -2 && engine.owner[x][y] === player)
        cells.push([x, y, engine.armyCnt[x][y]]);
  return cells;
}

function cell(engine, side, index, cols) {
  const x = Math.floor(index / cols),
    y = index % cols;
  const t = engine.gridType[x]?.[y];
  const kind = t === -2 ? 'K' : t === -1 ? 'C' : t === 1 ? 'M' : t === 2 ? 'S' : 'p';
  return `${side}${kind}${engine.owner[x]?.[y] ?? 0}:${engine.armyCnt[x]?.[y] ?? 0}`;
}

function cities(engine, player) {
  const cells = [];
  for (let x = 0; x < engine.gridType.length; x++)
    for (let y = 0; y < engine.gridType[x].length; y++)
      if (engine.gridType[x][y] === -1 && engine.owner[x][y] === player)
        cells.push([x, y, engine.armyCnt[x][y]]);
  return cells;
}

async function play() {
  const names = ['bot3', 'relay'];
  const ratio = resolveMapSizeRatioByPlayers(2) * (large ? 2 : 1);
  const flags = { multi_line: multi, fog };
  const ids = ['seat1', 'seat2'];
  const sockets = ids.map(() => new EventEmitter());
  const handles = [];
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
      const template = index === seat ? attachStrategy : require(OPPONENTS[opponent]).attachStrategy;
      socket.id = id;
      socket.connected = true;
      socket.on('attack', ({ x, y, dx, dy, mode: moveMode }) => engine.addMove(id, x, y, dx, dy, moveMode));
      socket.on('build', ({ x, y, op }) => engine.addBuild(id, x, y, op));
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
    const cols = engine.m;
    let result = null;
    for (let tick = 1; tick <= limit; tick++) {
      tickStart = performance.now();
      mock.timers.tick(500);
      await new Promise((resolve) => setImmediate(resolve));
      const turned = engine.turn;
      const ended = await engine.gameTick();
      const row = lastFrame?.leaderboard?.find((p) => p.uid === 'bot3');
      const relayRow = lastFrame?.leaderboard?.find((p) => p.uid !== 'bot3');
      const trace = shadow.debugStates ? [...shadow.debugStates].at(-1)?.trace : null;
      const pred = trace ? (trace.find((e) => e.turn === turned) ?? trace.at(-1)) : null;
      if (turned >= from && turned <= to) {
        const predText =
          pred && pred.from >= 0
            ? pred.build
              ? `build ${pred.from}(${pred.turn})`
              : `${pred.from}->${pred.to} m${pred.mode}(${pred.turn})`
            : '-';
        const mine = (pred?.orders ?? [])
          .map((op) =>
            op.build
              ? `B${cell(engine, 'from', op.from, cols)}`
              : `${cell(engine, 'from', op.from, cols)}->${cell(engine, '', op.to, cols)}`,
          )
          .join(' ');
        const pc = crowns(engine, 2);
        const oc = crowns(engine, 1);
        const pci = cities(engine, 2);
        const oci = cities(engine, 1);
        console.log(
          [
            `t${turned}`,
            `pred=${predText}`,
            `us=${mine || '-'}`,
            `bot3[${row?.land ?? '?'}|${row?.army ?? '?'}]`,
            `relay[${relayRow?.land ?? '?'}|${relayRow?.army ?? '?'}]`,
            `ourCrown=${JSON.stringify(oc)}`,
            `relayCrown=${JSON.stringify(pc)}`,
            `ourCity=${JSON.stringify(oci)}`,
            `relayCity=${JSON.stringify(pci)}`,
          ].join(' '),
        );
      }
      if (ended || (lastFrame?.game_end && tick > 1)) {
        result = row?.dead ? 'loss' : 'win-or-timeout';
        break;
      }
      if (row?.dead) {
        result = 'loss';
        break;
      }
    }
    const st = [...shadow.debugStates].at(-1);
    console.log(
      `RESULT ${result} turn=${lastFrame?.turn} cols=${cols} ` +
        `armed=${st?.armed} armedTurn=${st?.stats?.armedTurn ?? '-'} ` +
        `bestStreak=${st?.bestStreak} streak=${st?.streak} drift=${st?.stats?.drift}`,
    );
  } finally {
    handles.forEach((h) => h.stop());
    mock.timers.reset();
  }
}

play().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
