'use strict';

// Run after pnpm run build. Only the public hosted-bot entry points receive
// player events. The engine supplies terrain, visibility, growth and combat.
const { EventEmitter } = require('node:events');
const { mock } = require('node:test');
const { GameEngine } = require('../dist/game-engine');
const { resolveMapSizeRatioByPlayers } = require('../dist/map/map-size');
const { FIXED_SWAMP_RATIO } = require('../dist/server/lobby-service');
const { attachStrategy } = require(process.env.RELAY_ENTRY || '../bot-template/relay-bot/strategy');

const entries = {
  simple: '../bot-template/simple-strategy-bot/strategy',
  anti: '../bot-template/anti-human-bot/server-bot',
  apex: '../bot-template/apex-bot/strategy',
  v2: '../bot-template/bot-2.0/strategy',
};

async function play({ opponent, map, large, fog, multi, seed, seat, limit }) {
  const lineup = ['relay', ...opponent.split('+')];
  const names = lineup.map((_, i) => lineup[(i - seat + lineup.length) % lineup.length]);
  const ratio = resolveMapSizeRatioByPlayers(names.length) * (large ? 2 : 1);
  const flags = { multi_line: multi, fog };
  const ids = names.map((_, i) => 'seat' + (i + 1));
  const sockets = ids.map(() => new EventEmitter());
  const handles = [],
    sent = names.map(() => 0),
    executed = names.map(() => 0),
    checkpoints = {};
  let engine, lastFrame;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const simulatedNow = Date.now.bind(Date);
  let tickStart = performance.now();
  // Keep Date.now-based CPU budgets advancing inside a decision as well.
  Date.now = () => simulatedNow() + Math.floor(performance.now() - tickStart);
  try {
    for (const [index, socket] of sockets.entries()) {
      const id = ids[index];
      const template = index === seat ? attachStrategy : require(entries[names[index]]).attachStrategy;
      socket.id = id;
      socket.connected = true;
      socket.on('attack', ({ x, y, dx, dy, mode }) => {
        sent[index]++;
        engine.addMove(id, x, y, dx, dy, mode);
      });
      socket.on('build', ({ x, y, op }) => {
        sent[index]++;
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
        player_teams: ids.map((_, i) => i + 1),
      },
      ids,
      ids,
      'arena',
      {
        emitInitMap: (id, init) => sockets[ids.indexOf(id)].emit('init_map', init),
        update(id, frame) {
          lastFrame = frame;
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
      // Flush asynchronous decisions before advancing the next simulated tick.
      await new Promise((resolve) => setImmediate(resolve));
      const ended = await engine.gameTick();
      engine.executedTurnMoves.forEach((ops, i) => {
        executed[i] += ops.length;
      });
      if ([25, 50, 100, 250].includes(tick)) {
        checkpoints[tick] = names.map((uid) => {
          const p = lastFrame.leaderboard.find((item) => item.uid === uid);
          return [p.land, p.army];
        });
      }
      if (!ended && tick < limit) continue;
      if (executed.includes(0))
        throw new Error('Inactive seat: ' + JSON.stringify({ opponent, seat, sent, executed }));
      const winner = ended ? lastFrame.leaderboard.find((p) => !p.dead)?.uid : undefined;
      const self = lastFrame.leaderboard.find((p) => p.uid === 'relay');
      return {
        opponent,
        map,
        large,
        fog,
        multi,
        seed,
        seat,
        tick,
        result: self.dead ? 'loss' : winner === 'relay' ? 'win' : 'timeout',
        ...(names.length > 2
          ? {
              names,
              alive: lastFrame.leaderboard.filter((p) => !p.dead).length,
              rank: self.dead ? names.length + 1 - self.dead : ended ? 1 : null,
            }
          : {}),
        executed,
        checkpoints,
      };
    }
  } finally {
    handles.forEach((h) => h.stop());
    mock.timers.reset();
  }
}

async function main() {
  const opponents = (process.env.OPPONENTS || 'anti,apex,v2').split(',');
  for (const opponent of opponents) {
    const others = opponent.split('+');
    if (new Set(others).size !== others.length || others.some((id) => !Object.hasOwn(entries, id)))
      throw new Error('Invalid lineup: ' + opponent);
  }
  const maps = (process.env.MAPS || 'random,maze,archipelago,mediterranean').split(',');
  const seeds = (process.env.SEEDS || 'relay-eval-1').split(',');
  const limit = Number(process.env.TICKS || 1000);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('TICKS must be a positive integer');
  const modes = (process.env.MODES || '000,001,010,011,100,101,110,111').split(',');
  for (const mode of modes) {
    if (!/^[01]{3}$/.test(mode)) throw new Error('MODES expects three bits for large/fog/multi');
    const [large, fog, multi] = [...mode].map((bit) => bit === '1');
    for (const seed of seeds)
      for (const map of maps)
        for (const opponent of opponents)
          for (let seat = 0; seat <= opponent.split('+').length; seat++) {
            const result = await play({ opponent, map, large, fog, multi, seed, seat, limit });
            console.log(JSON.stringify(result));
          }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
