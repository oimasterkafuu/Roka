'use strict';

// Per-tick probe for the grass fog multi-line cell (`random` + fog + multi),
// the one cell with no purchase for the crown economy.
//
// Plays one game in-process with the same harness as
// bot-template/relay-bot/training/evaluate.cjs (real engine, mock clock, both bots attached to
// their own socket), snapshots the engine grid before and after every tick and
// prints a JSON summary of what each side actually spent the tick on.
//
//   SEED=bot3-baseline-1 MAP=random MODE=011 SEAT=0 \
//     node bot-template/relay-bot/foggrass-probe.cjs
//
// TRACE=1 prints one line per tick. The probe is diagnosis-only: it never
// changes the policy.
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
const map = process.env.MAP || 'random';
const mode = process.env.MODE || '011';
const seat = Number(process.env.SEAT ?? '0');
const limit = Number(process.env.TICKS || '1000');
const trace = process.env.TRACE === '1';
const [large, fog, multi] = [...mode].map((bit) => bit === '1');

// Engine-internal tiles: 2 swamp, 1 mountain, -1 city, -2 crown, 0 plain.
const swamp = (code) => code === 2;
const mountain = (code) => code === 1;
const city = (code) => code === -1;
const crown = (code) => code === -2;

async function play() {
  const names = ['bot3', 'relay'];
  const ratio = resolveMapSizeRatioByPlayers(2) * (large ? 2 : 1);
  const flags = { multi_line: multi, fog_mode: fog ? 'normal' : 'visible' };
  const ids = ['seat1', 'seat2'];
  const sockets = ids.map(() => new EventEmitter());
  const handles = [];
  let engine, lastFrame;
  const emitted = [0, 0];
  const row = {
    seed,
    map,
    mode,
    seat,
    ticks: 0,
    result: null,
    land: {},
    army: {},
    swampShare: 0,
    relayPush: { moves: 0, mode: {}, emptySource: 0 },
    relayCapture: { total: 0, neutral: 0, ours: 0, garrison: {}, swamp: 0, plain: 0, city: 0, mod: {} },
    relayAttack: { total: 0, won: 0, lost: 0, intoOne: 0, intoTwo: 0, intoThree: 0 },
    relayMerge: { total: 0, forward: 0, back: 0, flat: 0 },
    relayChoice: { cells: 0, fired: 0, firedOther: 0, merged: 0, idle: 0 },
    ourLoss: { total: 0, byGarrison: {}, ring: 0, turn: {} },
    ourCapture: { total: 0, neutral: 0, hostile: 0, perCycle: {}, mod: {}, garrison: {} },
    ourMerge: { total: 0, forward: 0, back: 0, flat: 0 },
    ourAttack: { lost: 0 },
    opportunities: { ticks: 0, cells: 0, canTake: 0, relayFired: 0, relayFiredTake: 0, weTook: 0 },
    ring: { relay: {}, oursVuln: {}, samples: 0 },
    relayNearRing: { near3: 0, near2: 0, dps: 0 },
    pulse: {},
    emit: { ours: 0, theirs: 0, idle: 0, idleTheirs: 0 },
    vest: {},
  };
  const cycle = (turn) => Math.floor(Math.max(0, turn - 1) / 50) * 50;
  const bump = (obj, key, by = 1) => {
    obj[key] = (obj[key] ?? 0) + by;
  };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const simulatedNow = Date.now.bind(Date);
  let tickStart = performance.now();
  Date.now = () => simulatedNow() + Math.floor(performance.now() - tickStart);
  const snapshot = () => ({
    owner: engine.owner.map((column) => column.slice()),
    army: engine.armyCnt.map((column) => column.slice()),
    type: engine.gridType.map((column) => column.slice()),
    isolated: engine.isolated.map((column) => column.slice()),
    n: engine.n,
    m: engine.m,
  });
  try {
    for (const [index, socket] of sockets.entries()) {
      const id = ids[index];
      const template = index === seat ? attachStrategy : relayStrategy;
      socket.id = id;
      socket.connected = true;
      socket.on('attack', ({ x, y, dx, dy, mode: moveMode }) => {
        emitted[index] += 1;
        engine.addMove(id, x, y, dx, dy, moveMode);
      });
      socket.on('build', ({ x, y, op }) => engine.addBuild(id, x, y, op));
      socket.on('init_map', () => {});
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
          sockets[ids.indexOf(id)].emit('update', frame);
        },
        md5: (id) => id,
        chatMessage() {},
        endGame() {},
        replayStore: { saveReplay: async () => 'local' },
      },
    );
    await engine.sendMap(false);
    const me = 1 + seat;
    const relay = me === 1 ? 2 : 1;
    let home = null;
    const ownerAt = (snap, x, y) => snap.owner[x][y];
    const armyOf = (snap, x, y) => Math.max(0, snap.army[x][y]);
    const neighborsOf = (snap, x, y) => {
      const out = [];
      if (x > 0) out.push([x - 1, y]);
      if (y > 0) out.push([x, y - 1]);
      if (y < snap.m - 1) out.push([x, y + 1]);
      if (x < snap.n - 1) out.push([x + 1, y]);
      return out;
    };
    const passable = (snap, x, y) => snap.type[x][y] !== 1;
    const ring = (snap, x, y, team) =>
      neighborsOf(snap, x, y).some(([a, b]) => passable(snap, a, b) && ownerAt(snap, a, b) !== team);
    // Swamp share (whole board, terrain only; swamp is visible through fog).
    {
      let swamps = 0,
        total = 0;
      for (let x = 0; x < engine.n; x++)
        for (let y = 0; y < engine.m; y++) {
          if (engine.gridType[x][y] === 1) continue;
          total += 1;
          if (swamp(engine.gridType[x][y])) swamps += 1;
        }
      row.swampShare = total ? swamps / total : 1;
    }
    for (let tick = 1; tick <= limit; tick++) {
      tickStart = performance.now();
      emitted[0] = 0;
      emitted[1] = 0;
      mock.timers.tick(500);
      await new Promise((resolve) => setImmediate(resolve));
      const pre = snapshot();
      if (!home)
        for (let x = 0; x < pre.n && !home; x++)
          for (let y = 0; y < pre.m; y++)
            if (ownerAt(pre, x, y) === me && crown(pre.type[x][y])) {
              home = [x, y];
              break;
            }
      const ended = await engine.gameTick();
      const post = snapshot();
      const ops = engine.executedTurnMoves.map((list) => list.slice());
      const relayOps = ops[relay - 1];
      const myOps = ops[me - 1];
      const relayEmptied = new Set();
      const relayFrom = new Set();
      for (const op of relayOps) {
        if (op.kind !== 'm') continue;
        relayFrom.add(op.x * pre.m + op.y);
        if (op.mode === 2 && armyOf(pre, op.x, op.y) > 1) relayEmptied.add(op.x * pre.m + op.y);
      }
      const myFrom = new Set();
      for (const op of myOps) if (op.kind === 'm') myFrom.add(op.x * pre.m + op.y);
      row.emit.ours += emitted[seat];
      row.emit.theirs += emitted[1 - seat];
      if (!emitted[seat]) row.emit.idle += 1;
      if (!emitted[1 - seat]) row.emit.idleTheirs += 1; // --- relay's tick ---
      for (const op of relayOps) {
        if (op.kind !== 'm') continue;
        row.relayPush.moves += 1;
        bump(row.relayPush.mode, String(op.mode));
        const targetOwner = ownerAt(pre, op.dx, op.dy);
        const targetArmy = armyOf(pre, op.dx, op.dy);
        const targetType = pre.type[op.dx][op.dy];
        const afterOwner = ownerAt(post, op.dx, op.dy);
        if (targetOwner === relay) {
          row.relayMerge.total += 1;
          if (home) {
            const before = Math.abs(op.x - home[0]) + Math.abs(op.y - home[1]);
            const after = Math.abs(op.dx - home[0]) + Math.abs(op.dy - home[1]);
            if (after < before) row.relayMerge.forward += 1;
            else if (after > before) row.relayMerge.back += 1;
            else row.relayMerge.flat += 1;
          }
        } else {
          row.relayAttack.total += 1;
          if (afterOwner === relay) {
            row.relayAttack.won += 1;
            bump(row.relayCapture.mod, String(tick % 50));
            if (targetArmy <= 1) row.relayAttack.intoOne += 1;
            else if (targetArmy === 2) row.relayAttack.intoTwo += 1;
            else row.relayAttack.intoThree += 1;
            bump(row.relayCapture.garrison, String(targetArmy));
            if (!targetOwner) row.relayCapture.neutral += 1;
            else row.relayCapture.ours += 1;
            if (swamp(targetType)) row.relayCapture.swamp += 1;
            else if (city(targetType) || crown(targetType)) row.relayCapture.city += 1;
            else row.relayCapture.plain += 1;
            row.relayCapture.total += 1;
          } else row.relayAttack.lost += 1;
        }
      }
      // Relay cells that hold >= 3 and have a target they can beat all-in:
      // did relay fire from that cell at all?
      for (let x = 0; x < pre.n; x++)
        for (let y = 0; y < pre.m; y++) {
          if (ownerAt(pre, x, y) !== relay) continue;
          const mass = armyOf(pre, x, y);
          if (mass < 3) continue;
          const beatable = neighborsOf(pre, x, y).filter(
            ([a, b]) => passable(pre, a, b) && ownerAt(pre, a, b) !== relay && armyOf(pre, a, b) < mass - 1,
          );
          if (!beatable.length) continue;
          row.relayChoice.cells += 1;
          if (!relayFrom.has(x * pre.m + y)) row.relayChoice.idle += 1;
          else if (relayEmptied.has(x * pre.m + y)) row.relayChoice.fired += 1;
          else row.relayChoice.firedOther += 1;
        }
      // Our orders.
      for (const op of myOps) {
        if (op.kind !== 'm') continue;
        const targetOwner = ownerAt(pre, op.dx, op.dy);
        const afterOwner = ownerAt(post, op.dx, op.dy);
        if (targetOwner === me) {
          row.ourMerge.total += 1;
          if (home) {
            const before = Math.abs(op.x - home[0]) + Math.abs(op.y - home[1]);
            const after = Math.abs(op.dx - home[0]) + Math.abs(op.dy - home[1]);
            if (after < before) row.ourMerge.forward += 1;
            else if (after > before) row.ourMerge.back += 1;
            else row.ourMerge.flat += 1;
          }
          continue;
        }
        if (afterOwner === me) {
          if (!targetOwner) row.ourCapture.neutral += 1;
          else row.ourCapture.hostile += 1;
          bump(row.ourCapture.garrison, String(armyOf(pre, op.dx, op.dy)));
          row.ourCapture.total += 1;
          bump(row.ourCapture.perCycle, String(cycle(tick)));
          bump(row.ourCapture.mod, String(tick % 50));
        } else row.ourAttack.lost += 1;
      }
      // Cells we lost to relay this tick.
      for (let x = 0; x < pre.n; x++)
        for (let y = 0; y < pre.m; y++) {
          if (ownerAt(pre, x, y) !== me || ownerAt(post, x, y) === me) continue;
          row.ourLoss.total += 1;
          const garrison = armyOf(pre, x, y);
          bump(row.ourLoss.byGarrison, String(garrison));
          bump(row.ourLoss.turn, String(cycle(tick)));
          if (ring(pre, x, y, me)) row.ourLoss.ring += 1;
        }
      // Relay mode-2 pushes from cells next to one of our >= 2 stacks.
      for (const op of relayOps) {
        if (op.kind !== 'm' || op.mode !== 2) continue;
        let best = 0;
        for (const [a, b] of neighborsOf(pre, op.x, op.y))
          if (ownerAt(pre, a, b) === me) best = Math.max(best, armyOf(pre, a, b));
        if (best >= 3) row.relayNearRing.near3 += 1;
        else if (best >= 2) row.relayNearRing.near2 += 1;
      }
      // Counter-capture opportunities: both bots planned this tick from `pre`;
      // relay resolves first when its seat is the first seat of this tick.
      const relayFirst = relay === (tick % 2 === 1 ? 2 : 1);
      if (relayFirst) {
        row.opportunities.ticks += 1;
        for (let x = 0; x < pre.n; x++)
          for (let y = 0; y < pre.m; y++) {
            if (ownerAt(pre, x, y) !== relay) continue;
            const mass = armyOf(pre, x, y);
            if (mass < 2) continue;
            const beatable = neighborsOf(pre, x, y).filter(
              ([a, b]) => passable(pre, a, b) && ownerAt(pre, a, b) !== relay && armyOf(pre, a, b) < mass - 1,
            );
            if (!beatable.length) continue;
            // Our adjacent stack that can take a one-army cell (send >= 2).
            const ours = neighborsOf(pre, x, y).filter(
              ([a, b]) => ownerAt(pre, a, b) === me && armyOf(pre, a, b) >= 3 && !myFrom.has(a * pre.m + b),
            );
            if (!ours.length) continue;
            row.opportunities.cells += 1;
            row.opportunities.canTake += 1;
            if (!relayEmptied.has(x * pre.m + y)) continue;
            row.opportunities.relayFired += 1;
            row.opportunities.relayFiredTake += 1;
            for (const op of myOps)
              if (op.kind === 'm' && op.dx === x && op.dy === y && ownerAt(post, x, y) === me)
                row.opportunities.weTook += 1;
          }
      }
      // Ring census: relay ring mass, and our ring cells by (garrison, threat).
      for (let x = 0; x < pre.n; x++)
        for (let y = 0; y < pre.m; y++) {
          const owner = ownerAt(pre, x, y);
          if (owner !== relay && owner !== me) continue;
          if (!ring(pre, x, y, owner)) continue;
          const mass = armyOf(pre, x, y);
          if (owner === relay) {
            bump(row.ring.relay, String(Math.min(9, mass)));
          } else {
            let threat = 0;
            for (const [a, b] of neighborsOf(pre, x, y))
              if (ownerAt(pre, a, b) === relay) threat = Math.max(threat, armyOf(pre, a, b));
            bump(row.ring.oursVuln, `${Math.min(4, mass)}|${Math.min(6, threat)}`);
          }
        }
      row.ring.samples += 1;
      if (tick % 50 === 0) {
        const stats = [1, 2].map((team) => lastFrame.leaderboard.find((row) => row.team === team));
        row.land[tick] = [stats[me - 1].land, stats[relay - 1].land];
        row.army[tick] = [stats[me - 1].army, stats[relay - 1].army];
        // Army split: [ring 1, ring 2+, interior 1, interior 2+] plus crowns.
        const split = { ours: [0, 0, 0, 0], theirs: [0, 0, 0, 0], crowns: [0, 0] };
        for (let x = 0; x < pre.n; x++)
          for (let y = 0; y < pre.m; y++) {
            const owner = ownerAt(pre, x, y);
            if (owner !== me && owner !== relay) continue;
            const onRing = ring(pre, x, y, owner);
            const mass = armyOf(pre, x, y);
            const bucket = (onRing ? 0 : 2) + Math.min(1, Math.max(0, mass - 1));
            split[owner === me ? 'ours' : 'theirs'][bucket] += mass;
            if (crown(pre.type[x][y])) split.crowns[owner === me ? 0 : 1] += 1;
          }
        row.pulse[tick] = split;
      }
      if (trace) {
        const stats = [1, 2].map((team) => lastFrame.leaderboard.find((row) => row.team === team));
        console.error(
          `t${String(tick).padStart(4)} us L${stats[me - 1].land} A${stats[me - 1].army} | ` +
            `relay L${stats[relay - 1].land} A${stats[relay - 1].army}`,
        );
      }
      if (!ended && tick < limit) continue;
      row.ticks = lastFrame.turn;
      break;
    }
    const self = lastFrame.leaderboard.find((p) => p.id === me);
    const winner = lastFrame.leaderboard.find((p) => !p.dead);
    row.result = self.dead ? 'loss' : winner && winner.id === me ? 'win' : 'timeout';
    return row;
  } finally {
    handles.forEach((h) => h.stop());
    mock.timers.reset();
  }
}

play()
  .then((row) => console.log(JSON.stringify(row)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
