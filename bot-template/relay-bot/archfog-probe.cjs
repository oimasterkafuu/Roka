'use strict';

// Round-20 archipelago/fog multi probe.
//
// Plays one 1v1 multi-line game in-process with the evaluation harness and
// prints a per-tick JSON row for both seats plus our own order mix split by the
// *terrain* an order moves into (plain vs swamp) and by island ownership.
//
//   SEED=bot3-baseline-1 MAP=archipelago MODE=011 SEAT=0 \
//     node bot-template/relay-bot/archfog-probe.cjs > data/scratch/probe.jsonl
//
// ENV: FROM/TO (tick window, 0 = every tick), SUMMARY=1 (only end row).
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
const map = process.env.MAP || 'archipelago';
const mode = process.env.MODE || '011';
const seat = Number(process.env.SEAT ?? '0');
const limit = Number(process.env.TICKS || '1000');
const [large, fog, multi] = [...mode].map((bit) => bit === '1');
const from = Number(process.env.FROM || '0');
const to = Number(process.env.TO || '0');
const summaryOnly = process.env.SUMMARY === '1';

const ownerOf = (code) => (code < 200 ? code % 50 : 0);
const isSwamp = (code) => code >= 150 && code !== 200 && code !== 201;
const crown = (code) => code >= 100 && code < 150;

// Terrain + island partition of the *revealed* board. Swamp and mountain are
// visible through fog, so the partition is exact in every mode.
function islands(tile, neighbors, size) {
  const id = new Int32Array(size).fill(-1);
  const sizes = [];
  for (let start = 0; start < size; start++) {
    if (id[start] !== -1 || isSwamp(tile[start]) || tile[start] === 201) continue;
    const mark = sizes.length;
    let cells = 0;
    const stack = [start];
    id[start] = mark;
    while (stack.length) {
      const i = stack.pop();
      cells++;
      for (const j of neighbors[i]) {
        if (id[j] !== -1 || isSwamp(tile[j]) || tile[j] === 201) continue;
        id[j] = mark;
        stack.push(j);
      }
    }
    sizes.push(cells);
  }
  return { id, sizes };
}

function islandInfo(frame, cell) {
  const size = frame.grid_type.length;
  const n = frame.cols ?? Math.round(Math.sqrt(size));
  const rows = frame.rows ?? Math.round(size / n);
  const tile = frame.grid_type;
  const seen = new Uint8Array(size);
  const stack = [cell];
  seen[cell] = 1;
  let cells = 0,
    own = 0,
    neutral = 0,
    enemy = 0;
  while (stack.length) {
    const i = stack.pop();
    cells++;
    const owner = ownerOf(tile[i]);
    if (owner === frame.__me) own++;
    else if (owner) enemy++;
    else neutral++;
    // 4-way, exactly the partition ./archipelago uses.
    for (const j of [
      i - n,
      i + n,
      i % n > 0 ? i - 1 : -1,
      i % n < n - 1 ? i + 1 : -1,
    ]) {
      if (j < 0 || j >= size) continue;
      if (seen[j]) continue;
      if (isSwamp(tile[j]) || tile[j] === 201) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return { cells, own, neutral, enemy, full: neutral === 0 && enemy === 0 };
}

async function play() {
  const lineup = ['bot3', 'relay'];
  const names = lineup.map((_, i) => lineup[(i - seat + lineup.length) % lineup.length]);
  const ratio = resolveMapSizeRatioByPlayers(2) * (large ? 2 : 1);
  const flags = { multi_line: multi, fog };
  const ids = ['seat1', 'seat2'];
  const sockets = ids.map(() => new EventEmitter());
  const handles = [];
  const orders = [];
  const builds = [];
  let currentTick = 0;
  let endedFlag = false;
  let engine, cols = 0, rowsCount = 0;
  const boards = [null, null];
  const armies = [null, null];
  const fogs = [null, null];
  const isos = [null, null];
  const lastFrames = [null, null];
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
        if (index === seat) orders.push({ x, y, dx, dy, mode: moveMode });
        engine.addMove(id, x, y, dx, dy, moveMode);
      });
      socket.on('build', ({ x, y, op }) => {
        if (index === seat) {
          orders.push({ x, y, op, build: true });
          const frame = lastFrames[index];
          const cell = x * (cols || 0) + y;
          builds.push({
            tick: currentTick,
            x,
            y,
            op,
            code: frame?.grid_type?.[cell] ?? null,
            army: frame?.army_cnt?.[cell] ?? null,
            island: frame ? islandInfo(frame, cell) : null,
          });
        }
        engine.addBuild(id, x, y, op);
      });
      socket.on('init_map', (init) => {
        cols = init.m;
        rowsCount = init.n;
        boards[index] = new Uint8Array(init.n * init.m);
        armies[index] = new Uint8Array(init.n * init.m);
        fogs[index] = new Uint8Array(init.n * init.m);
        isos[index] = new Uint8Array(init.n * init.m);
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
          const index = ids.indexOf(id);
          const board = boards[index];
          if (board && Array.isArray(frame.grid_type)) {
            if (!frame.is_diff)
              for (let i = 0; i < frame.grid_type.length; i++) board[i] = frame.grid_type[i];
            else
              for (let i = 0; i < frame.grid_type.length; i += 2)
                board[frame.grid_type[i]] = frame.grid_type[i + 1];
          }
          const armyBoard = armies[index];
          if (armyBoard && Array.isArray(frame.army_cnt)) {
            if (!frame.is_diff) for (let i = 0; i < frame.army_cnt.length; i++) armyBoard[i] = frame.army_cnt[i];
            else for (let i = 0; i < frame.army_cnt.length; i += 2) armyBoard[frame.army_cnt[i]] = frame.army_cnt[i + 1];
          }
          const fogBoard = fogs[index];
          if (fogBoard && Array.isArray(frame.fog)) {
            if (!frame.is_diff) for (let i = 0; i < frame.fog.length; i++) fogBoard[i] = frame.fog[i];
            else for (let i = 0; i < frame.fog.length; i += 2) fogBoard[frame.fog[i]] = frame.fog[i + 1];
          }
          const isoBoard = isos[index];
          if (isoBoard && Array.isArray(frame.isolated)) {
            if (!frame.is_diff) for (let i = 0; i < frame.isolated.length; i++) isoBoard[i] = frame.isolated[i];
            else for (let i = 0; i < frame.isolated.length; i += 2) isoBoard[frame.isolated[i]] = frame.isolated[i + 1];
          }
          lastFrames[index] = {
            ...frame,
            __me: 1 + index,
            cols: cols || frame.cols,
            rows: rowsCount || frame.rows,
            grid_type: board ?? frame.grid_type,
            army_cnt: armyBoard ?? frame.army_cnt,
            fog: fogBoard ?? frame.fog,
            isolated: isoBoard ?? frame.isolated,
          };
          sockets[index].emit('update', frame);
        },
        md5: (id) => id,
        chatMessage() {},
        endGame() {},
        replayStore: { saveReplay: async () => 'local' },
      },
    );
    await engine.sendMap(false);
    const me = 1 + seat;
    const rows = [];
    for (let tick = 1; tick <= limit; tick++) {
      currentTick = tick;
      tickStart = performance.now();
      mock.timers.tick(500);
      await new Promise((resolve) => setImmediate(resolve));
      const ended = await engine.gameTick();
      if (ended) endedFlag = true;
      const lastFrame = lastFrames[seat];
      const sample = lastFrame && (tick % (summaryOnly ? 25 : 10) === 0 || ended || (from && tick >= from && tick <= to));
      if (sample) {
        const size = lastFrame.grid_type.length;
        const gridRows = rowsCount || Math.round(Math.sqrt(size));
        const n = cols || gridRows;
        const neighbors = Array.from({ length: size }, () => []);
        for (let x = 0; x < gridRows; x++)
          for (let y = 0; y < n; y++) {
            const i = x * n + y;
            if (x > 0) neighbors[i].push(i - n);
            if (x < gridRows - 1) neighbors[i].push(i + n);
            if (y > 0) neighbors[i].push(i - 1);
            if (y < n - 1) neighbors[i].push(i + 1);
          }
        const { id: islandId, sizes } = islands(lastFrame.grid_type, neighbors, size);
        // Our isolated cells and the army trapped in them (the archipelago
        // death: a swamp chain is cut and every stack behind it halves).
        let isoCells = 0,
          isoArmy = 0,
          isoStacks = 0,
          myCrowns = 0,
          foeCrowns = 0,
          guard = 0,
          thin = 0,
          maxOwn = 0,
          maxFoe = 0,
          visibleFoeArmy = 0;
        const crownCells = [];
        for (let i = 0; i < size; i++) {
          const owner = ownerOf(lastFrame.grid_type[i]);
          const army = lastFrame.army_cnt[i] ?? 0;
          if (owner === me) {
            if (army <= 1) thin++;
            if (army > maxOwn) maxOwn = army;
            if (crown(lastFrame.grid_type[i])) {
              myCrowns++;
              guard += army;
              crownCells.push(`${i}:${army}`);
            }
          } else if (owner) {
            visibleFoeArmy += army;
            if (army > maxFoe) maxFoe = army;
            if (crown(lastFrame.grid_type[i])) foeCrowns++;
          }
        }
        for (let i = 0; i < size; i++) {
          if (!lastFrame.isolated?.[i]) continue;
          if (ownerOf(lastFrame.grid_type[i]) !== me) continue;
          isoCells++;
          isoArmy += lastFrame.army_cnt[i];
          if (lastFrame.army_cnt[i] >= 5) isoStacks++;
        }

        // Own island census for islands >= 4 cells.
        let ownedIslands = 0,
          fullIslands = 0,
          armyOnFull = 0,
          fullCrowned = 0,
          maxStack = 0;
        for (let island = 0; island < sizes.length; island++) {
          if (sizes[island] < 4) continue;
          let own = 0,
            enemy = 0,
            army = 0,
            crowns = 0;
          for (let i = 0; i < size; i++) {
            if (islandId[i] !== island) continue;
            if (ownerOf(lastFrame.grid_type[i]) === me) {
              own++;
              army += lastFrame.army_cnt[i];
              if (crown(lastFrame.grid_type[i])) crowns++;
            } else if (ownerOf(lastFrame.grid_type[i])) enemy++;
          }
          if (own && !enemy) ownedIslands++;
          if (own === sizes[island] && !enemy) for (let i = 0; i < size; i++) if (islandId[i] === island && lastFrame.army_cnt[i] > maxStack) maxStack = lastFrame.army_cnt[i];
          if (own === sizes[island] && !enemy) {
            fullIslands++;
            armyOnFull += army;
            fullCrowned += crowns;
          }
        }
        // Order mix: what our orders moved *into*, split by ownership and by
        // the terrain of the target. `own` moves are the planner's merges (the
        // crown bank's feed lands here), the rest are captures.
        const mix = {
          plain: 0,
          swamp: 0,
          own: 0,
          enemy: 0,
          build: 0,
          ownArmy: 0,
          swampArmy: 0,
          plainArmy: 0,
          swampCap: 0,
          swampCapArmy: 0,
          swampCapBig: 0,
          swampCapBigArmy: 0,
          idleArmy: 0,
          revealArmy: 0,
        };
        for (const op of orders) {
          if (op.build) {
            mix.build++;
            continue;
          }
          const code = lastFrame.grid_type[op.dx * n + op.dy] ?? 200;
          const send = (lastFrame.army_cnt[op.x * n + op.y] ?? 1) - 1;
          const own = ownerOf(code) === me;
          if (own) {
            mix.own++;
            mix.ownArmy += send;
          } else if (ownerOf(code)) mix.enemy++;
          if (isSwamp(code)) {
            mix.swamp++;
            mix.swampArmy += send;
            // Captures of neutral swamp only (own-swamp merges are the bank's
            // feed and are counted above, not here).
            if (!own && !ownerOf(code)) {
              mix.swampCap++;
              mix.swampCapArmy += send;
              // How many unseen cells the capture would reveal (3x3 around it).
              let unseen = 0;
              for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++) {
                  const nx = (op.dx / n | 0) + dx;
                  const ny = (op.dx % n) + dy;
                  if (nx < 0 || ny < 0 || nx >= lastFrame.grid_type.length / n || ny >= n) continue;
                  if (lastFrame.fog?.[nx * n + ny]) unseen++;
                }
              if (send > 3) {
                mix.swampCapBig++;
                mix.swampCapBigArmy += send;
              }
              if (unseen > 0) mix.revealArmy += send;
              else mix.idleArmy += send;
            }
          } else if (code !== 201) {
            mix.plain++;
            mix.plainArmy += send;
          }
        }
        orders.length = 0;
        const stat = (team) => {
          const p = lastFrame.leaderboard.find((row) => row.team === team);
          return { land: p.land, army: p.army, crowns: p.crowns ?? null, dead: p.dead };
        };
        rows.push({
          tick,
          me,
          a: stat(1),
          b: stat(2),
          mix,
          islands: { ownedIslands, fullIslands, armyOnFull, fullCrowned, total: sizes.length, maxStackFull: maxStack },
          iso: { isoCells, isoArmy, isoStacks },
          crowns: { mine: myCrowns, foe: foeCrowns, guard, thin, maxOwn, maxFoe, visibleFoeArmy, cells: crownCells },
          orders: orders.length,
        });
      } else {
        orders.length = 0;
      }
      if (!ended && tick < limit) continue;
      break;
    }
    const finalFrame = lastFrames[seat];
    const self = finalFrame.leaderboard.find((p) => p.uid === names[seat]);
    const winner = endedFlag ? finalFrame.leaderboard.find((p) => !p.dead)?.uid : undefined;
    return {
      result: self.dead ? 'loss' : winner === names[seat] ? 'win' : 'timeout',
      tick: finalFrame.turn,
      rows,
      builds,
      bankTrace: process.env.BOT3_MCROWN2_TRACE === '1' ? globalThis.__mcrown2 ?? [] : undefined,
    };
  } finally {
    handles.forEach((h) => h.stop());
    mock.timers.reset();
  }
}

play()
  .then((game) => {
    const { rows, builds, ...summary } = game;
    if (summaryOnly) {
      console.log(
        JSON.stringify({
          seed,
          map,
          mode,
          seat,
          ...summary,
          builds,
          trail: rows.map((row) => ({
            t: row.tick,
            l: row.a.land,
            el: row.b.land,
            a: row.a.army,
            ea: row.b.army,
            fi: row.islands.fullIslands,
            ms: row.islands.maxStackFull,
            si: row.mix.swampIdle,
            sr: row.mix.swampReveal,
            ia: row.mix.idleArmy,
            ra: row.mix.revealArmy,
            cr: row.crowns.mine,
            cc: row.crowns.cells,
            ecr: row.crowns.foe,
            gd: row.crowns.guard,
            th: row.crowns.thin,
            mo: row.crowns.maxOwn,
            mf: row.crowns.maxFoe,
            vf: row.crowns.visibleFoeArmy,
            ic: row.iso.isoCells,
            iaa: row.iso.isoArmy,
            isk: row.iso.isoStacks,
            fa: row.islands.armyOnFull,
            sw: row.mix.swamp,
            pl: row.mix.plain,
            oa: row.mix.ownArmy,
            swc: row.mix.swampCap,
            swca: row.mix.swampCapArmy,
            swcb: row.mix.swampCapBig,
            swcba: row.mix.swampCapBigArmy,
            ia: row.mix.idleArmy,
            ra: row.mix.revealArmy,
            cr: row.crowns.mine,
            cc: row.crowns.cells,
            ecr: row.crowns.foe,
            gd: row.crowns.guard,
            th: row.crowns.thin,
            mo: row.crowns.maxOwn,
            mf: row.crowns.maxFoe,
            vf: row.crowns.visibleFoeArmy,
            ic: row.iso.isoCells,
            iaa: row.iso.isoArmy,
            isk: row.iso.isoStacks,
          })),
        }),
      );
      return;
    }
    console.log(JSON.stringify({ seed, map, mode, seat, ...summary }));
    for (const row of rows) {
      const [a, b] = [row.a, row.b];
      console.log(
        `t${String(row.tick).padStart(4)} bot3 L${String(a.land).padStart(3)} A${String(a.army).padStart(4)} C${String(a.crowns ?? '?').padStart(3)}` +
          ` | relay L${String(b.land).padStart(3)} A${String(b.army).padStart(4)} C${String(b.crowns ?? '?').padStart(3)}` +
          ` | isl full ${row.islands.fullIslands}/${row.islands.total} army ${row.islands.armyOnFull} cr ${row.islands.fullCrowned}` +
          ` | ord ${JSON.stringify(row.mix)}`,
      );
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
