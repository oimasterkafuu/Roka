'use strict';

// Measure uncontested expansion. All other crowns still grow, but their
// owners issue no orders. Read only the chosen player's frame.
const { GameEngine } = require('../dist/game-engine');
const { resolveMapSizeRatioByPlayers } = require('../dist/map/map-size');
const { FIXED_SWAMP_RATIO } = require('../dist/server/lobby-service');
const { openingBudget } = require('../bot-template/relay-bot/opening');
const { createBoard, chooseOrders } = require(process.env.PLANNER || '../bot-template/relay-bot/planner');

async function play(map, count, large, seed, seat, multi, speed) {
  const ids = Array.from({ length: count }, (_, i) => 'p' + i);
  const ratio = resolveMapSizeRatioByPlayers(count) * (large ? 2 : 1);
  let board,
    result,
    followupMs = 0;
  const engine = await GameEngine.create(
    {
      width_ratio: ratio,
      height_ratio: ratio,
      swamp_ratio: FIXED_SWAMP_RATIO,
      map_token: seed,
      map_mode: map,
      map_size: large ? 'large' : 'normal',
      speed,
      multi_line: multi,
      allow_team: false,
      player_names: ids,
      player_teams: ids.map((_, i) => i + 1),
    },
    ids,
    ids,
    'opening',
    {
      emitInitMap(id, init) {
        if (id === ids[seat]) {
          board = createBoard(init.n, init.m, seat + 1);
          board.openingBudget = openingBudget(speed);
        }
      },
      md5: (id) => id,
      chatMessage() {},
      endGame() {},
      replayStore: { saveReplay: async () => 'local' },
      update(id, frame) {
        if (id !== ids[seat]) return;
        for (const key of ['grid_type', 'army_cnt', 'isolated']) {
          const values = frame[key];
          if (!frame.is_diff) board[key].set(values);
          else for (let k = 0; k < values.length; k += 2) board[key][values[k]] = values[k + 1];
        }
        if (frame.turn === 24) {
          result.land = frame.leaderboard.find((p) => p.id === seat + 1).land;
          result.followupMs = Math.round(followupMs * 1000) / 1000;
          return;
        }
        const at = performance.now();
        const orders = chooseOrders(board, frame.turn, frame.leaderboard, multi);
        const elapsed = performance.now() - at;
        if (frame.turn === 0)
          result = {
            map,
            count,
            large,
            multi,
            speed,
            seed,
            seat,
            ms: Math.round(elapsed * 1000) / 1000,
            target: board.opening?.land,
            bound: board.opening?.upper,
          };
        else followupMs += elapsed;
        for (const op of orders) {
          const xy = (i) => [Math.floor(i / board.cols), i % board.cols];
          engine.addMove(id, ...xy(op.from), ...xy(op.to), op.mode);
        }
      },
    },
  );
  await engine.sendMap(false);
  for (let i = 0; i < 24; i++) await engine.gameTick();
  return result;
}

async function main() {
  for (const map of (process.env.MAPS || 'random,maze,archipelago,mediterranean,huaxia').split(','))
    for (const seed of (process.env.SEEDS || 'opening-release-1,opening-release-2,opening-sealed-3').split(
      ',',
    ))
      for (const count of [2, 4])
        for (const large of [false, true])
          for (let seat = 0; seat < count; seat++)
            console.log(
              JSON.stringify(
                await play(
                  map,
                  count,
                  large,
                  seed,
                  seat,
                  process.env.MULTI === '1',
                  Number(process.env.SPEED || 1),
                ),
              ),
            );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
