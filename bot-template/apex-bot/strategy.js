'use strict';

const { makeBoard } = require('./bot/board.cjs');
const { createController } = require('./bot/controller.cjs');

function createOpponentStats() {
  const records = new Map();
  const get = (uid) => {
    const key = String(uid || '').trim();
    if (!key) return null;
    let record = records.get(key);
    if (!record) {
      record = { games: 0, wins: 0, losses: 0, draws: 0, consecutiveLosses: 0 };
      records.set(key, record);
    }
    return record;
  };
  return {
    record(leaderboard, playerId) {
      if (!Array.isArray(leaderboard)) return [];
      const me = leaderboard.find((entry) => Number(entry.id) === Number(playerId));
      if (!me) return [];
      const ownDead = Number(me.dead) > 0 || me.class_ === 'dead';
      const ownTeam = Number(me.team) || Number(me.id);
      const changes = [];
      for (const opponent of leaderboard) {
        if (!opponent || Number(opponent.id) === Number(playerId)) continue;
        if ((Number(opponent.team) || Number(opponent.id)) === ownTeam) continue;
        const enemyDead = Number(opponent.dead) > 0 || opponent.class_ === 'dead';
        const record = get(opponent.uid);
        if (!record) continue;
        let result = 'draw';
        if (!ownDead && enemyDead) result = 'win';
        else if (ownDead && !enemyDead) result = 'loss';
        record.games += 1;
        record[result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws'] += 1;
        if (result === 'loss' || result === 'draw') record.consecutiveLosses += 1;
        else record.consecutiveLosses = 0;
        changes.push({ uid: String(opponent.uid || ''), result, ...record });
      }
      return changes;
    },
    snapshot() {
      return Object.fromEntries([...records.entries()].map(([uid, record]) => [uid, { ...record }]));
    },
  };
}

function envDuelStrike() {
  const raw = process.env.BOT_DUEL_STRIKE;
  if (raw === undefined || String(raw).trim() === '') return undefined;
  return String(raw).trim() !== '0';
}

function validFrameArray(value, size) {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite);
}

function applyDiff(target, diff) {
  if (!Array.isArray(diff) || diff.length % 2 !== 0) return false;
  const next = target.slice();
  for (let i = 0; i < diff.length; i += 2) {
    const index = diff[i];
    const value = diff[i + 1];
    if (!Number.isInteger(index) || index < 0 || index >= next.length || !Number.isFinite(value))
      return false;
    next[index] = value;
  }
  target.splice(0, target.length, ...next);
  return true;
}

function attachStrategy(socket, options = {}) {
  const room = String(options.room || '').trim();
  if (!room) throw new Error('attachStrategy: missing room');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const opponentStats = createOpponentStats(now);
  // The server applies growth and connectivity before broadcasting each
  // update. Waiting for a fixed wall-clock interval lets the next tick arrive
  // first on 4x games, so a move is then planned from a stale frontier and is
  // especially likely to lose its supply line. Decide on the newest frame;
  // callers can still opt into a delay when debugging.
  const actionDelayMs = Math.max(0, Number(options.actionDelayMs ?? 0) || 0);
  // Hard per-decision wall-clock budget.  Undefined keeps the controller
  // default (BOT_DECISION_BUDGET_MS or 80 ms, safe under a 125 ms 4x tick).
  const decisionBudgetMs = Number(options.decisionBudgetMs);
  // Finish layer (race-gated kill-path strike).  Default on; BOT_DUEL_STRIKE=0
  // disables it, which reproduces the planner-only behaviour exactly.
  const duelStrike = options.duelStrike === undefined ? envDuelStrike() : options.duelStrike !== false;
  const controllerOptions = {
    decisionBudgetMs: Number.isFinite(decisionBudgetMs) ? decisionBudgetMs : undefined,
    duelStrike,
    now,
  };
  const state = {
    n: 0,
    m: 0,
    size: 0,
    playerId: 0,
    mapMode: 'random',
    clientId: '',
    turn: -1,
    grid: [],
    army: [],
    isolated: [],
    fog: [],
    leaderboard: [],
    teams: new Map(),
    inGame: false,
    dead: false,
    ended: false,
    queued: 0,
    actionPending: false,
    pendingAction: null,
    pendingTurn: -1,
    queueGraceWaits: 0,
    lastActionTurn: -1,
    queueResets: 0,
    queueOps: [],
    nextSeq: 1,
    multiLine: false,
  };
  let controller = null;
  let heartbeat = null;
  let decisionTimer = null;
  let reconnectTimer = null;
  let lastRoomCommand = '';

  function reset(n, m, ids) {
    if (decisionTimer) {
      clearTimeout(decisionTimer);
      decisionTimer = null;
    }
    state.n = n;
    state.m = m;
    state.size = n * m;
    state.grid = Array(state.size).fill(200);
    state.army = Array(state.size).fill(0);
    state.isolated = Array(state.size).fill(0);
    state.fog = Array(state.size).fill(0);
    state.turn = -1;
    state.leaderboard = [];
    state.teams = new Map();
    state.queueOps = [];
    state.queued = 0;
    state.actionPending = false;
    state.pendingAction = null;
    state.pendingTurn = -1;
    state.queueGraceWaits = 0;
    state.lastActionTurn = -1;
    state.queueResets = 0;
    state.playerId = ids.indexOf(state.clientId) + 1;
    state.dead = false;
    state.ended = false;
    state.inGame = true;
    controller = createController(state.playerId, { ...controllerOptions, mapMode: state.mapMode });
    lastRoomCommand = '';
  }

  function updatePlayers(payload) {
    if (!Array.isArray(payload.leaderboard)) return;
    state.leaderboard = payload.leaderboard.map((entry) => ({ ...entry }));
    state.teams = new Map(
      state.leaderboard.map((entry) => [Number(entry.id), Number(entry.team) || Number(entry.id)]),
    );
    const me = state.leaderboard.find((entry) => Number(entry.id) === state.playerId);
    state.dead = state.dead || Boolean(me && (me.dead > 0 || me.class_ === 'dead'));
  }

  function decide() {
    decisionTimer = null;
    if (!state.inGame || state.dead || state.ended || !controller || !state.playerId) return;
    const board = makeBoard(
      {
        n: state.n,
        m: state.m,
        grid: state.grid,
        army: state.army,
        isolated: state.isolated,
        fog: state.fog,
        leaderboard: state.leaderboard,
        teams: state.teams,
        turn: state.turn,
        multiLine: state.multiLine,
        dead: state.dead,
        ended: state.ended,
      },
      state.playerId,
    );
    // Rebound queues are authoritative. Let their existing chains drain
    // before planning new heads; seq is global and never rewound by a clear.
    if (state.multiLine && state.queueOps.length) return;
    const actions = controller.chooseBatch(board);
    if (!actions.length) return;
    if (state.actionPending) {
      // A public-server round trip can miss the next update even when the
      // operation is already executing.  Clearing immediately then cancels
      // the queued move and resends it, which looks like back-and-forth
      // movement or an idle tick.  Give the acknowledgement one tick of
      // grace; only a second missed frame means the queue is genuinely stale.
      const age = state.pendingTurn >= 0 ? state.turn - state.pendingTurn : Infinity;
      if (age <= 1) {
        state.queueGraceWaits += 1;
        return;
      }
      socket.emit('clear_queue');
      state.queueResets += 1;
      state.queueOps = [];
    }
    for (const action of actions) {
      const { half, ...payload } = action;
      const queued = { ...payload, seq: state.nextSeq++ };
      state.queueOps.push(queued);
      state.queued += 1;
    }
    state.lastActionTurn = state.turn;
    state.pendingTurn = state.turn;
    state.actionPending = state.queueOps.length > 0;
    state.pendingAction = state.queueOps[0] || null;
    for (const { seq, ...payload } of state.queueOps) {
      socket.emit(payload.kind === 'build' ? 'build' : 'attack', payload);
    }
  }

  function onSetId(id) {
    state.clientId = String(id || '');
  }

  function onInit(payload = {}) {
    const n = Number(payload.n);
    const m = Number(payload.m);
    const ids = Array.isArray(payload.player_ids) ? payload.player_ids.map(String) : [];
    if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || n * m > 100000) return;
    // rebindPlayer clears the server queue and its init payload currently omits
    // multi_line. Preserve the mode only across an unfinished game; a new game
    // still defaults to the legacy single-line protocol when the flag is absent.
    const resumeMultiLine = state.multiLine && controller && !state.ended;
    reset(n, m, ids);
    state.multiLine = payload.multi_line === true || resumeMultiLine;
    state.queueOps = Array.isArray(payload.queue_ops)
      ? payload.queue_ops.filter((op) => Number.isInteger(op?.seq) && op.seq > 0).map((op) => ({ ...op }))
      : [];
    state.nextSeq = Math.max(
      Number.isInteger(payload.next_seq) && payload.next_seq > 0 ? payload.next_seq : 1,
      ...state.queueOps.map((op) => op.seq + 1),
    );
    state.actionPending = state.queueOps.length > 0;
    state.pendingAction = state.queueOps[0] || null;
    log(`new game ${n}x${m}, player=${state.playerId}`);
  }

  function onUpdate(payload = {}) {
    if (!state.inGame || !Number.isInteger(payload.turn) || payload.turn <= state.turn) return;
    const next = {
      grid: state.grid.slice(),
      army: state.army.slice(),
      isolated: state.isolated.slice(),
      fog: state.fog.slice(),
    };
    const fields = [
      ['grid_type', 'grid'],
      ['army_cnt', 'army'],
      ['isolated', 'isolated'],
      ['fog', 'fog'],
    ];
    for (const [wire, local] of fields) {
      if (payload[wire] === undefined) {
        if (!payload.is_diff && (local === 'fog' || local === 'isolated')) next[local].fill(0);
        continue;
      }
      if (payload.is_diff) {
        if (!applyDiff(next[local], payload[wire])) return;
      } else if (validFrameArray(payload[wire], state.size)) {
        next[local] = payload[wire].slice();
      } else {
        return;
      }
    }
    if (!payload.is_diff && payload.fog === undefined) next.fog.fill(0);
    state.grid.splice(0, state.size, ...next.grid);
    state.army.splice(0, state.size, ...next.army);
    state.isolated.splice(0, state.size, ...next.isolated);
    state.fog.splice(0, state.size, ...next.fog);
    updatePlayers(payload);
    const removed = new Set(Array.isArray(payload.lst_moves) ? payload.lst_moves : []);
    state.queueOps = state.queueOps.filter((op) => !removed.has(op.seq));
    state.actionPending = state.queueOps.length > 0;
    state.pendingAction = state.queueOps[0] || null;
    if (!state.actionPending) state.pendingTurn = -1;
    state.turn = payload.turn;
    state.ended = Boolean(payload.game_end);
    if (payload.kills && payload.kills[state.clientId]) state.dead = true;
    if (state.ended) {
      const changes = opponentStats.record(payload.leaderboard, state.playerId, now());
      for (const change of changes) {
        log(
          `result vs ${change.uid}: ${change.result}, games=${change.games}, wins=${change.wins}, losses=${change.losses}, draws=${change.draws}, streak=${change.consecutiveLosses}`,
        );
      }
      state.queueOps = [];
      state.inGame = false;
      state.actionPending = false;
      state.pendingAction = null;
      state.pendingTurn = -1;
      if (decisionTimer) clearTimeout(decisionTimer);
      // Live-server telemetry: network queue churn and budget fallbacks are
      // invisible in the offline engine, so log them once per game.
      const summary = controller?.stats?.() || {};
      log(`game stats ${JSON.stringify({
        queueResets: state.queueResets,
        queueGraceWaits: state.queueGraceWaits,
        budgetExceeded: summary.budgetExceeded || 0,
        fallbacks: summary.fallbacks || 0,
        noActionTurns: summary.noActionTurns || 0,
        maxNoActionStreak: summary.maxNoActionStreak || 0,
        strikes: summary.strikes || 0,
        byBranch: summary.byBranch || {},
      })}`);
      controller?.reset();
      return;
    }
    if (!state.playerId || state.dead) return;
    if (!decisionTimer) decisionTimer = setTimeout(decide, actionDelayMs);
  }

  function onRoomUpdate(payload = {}) {
    if (typeof payload.map_mode === 'string' && payload.map_mode) state.mapMode = payload.map_mode;
    if (state.inGame) return;
    if (payload.in_game === true) return;
    const players = Array.isArray(payload.players) ? payload.players : [];
    const me = players.find((entry) => String(entry.sid || entry.client_id || '') === state.clientId);
    if (!me) return;
    const desiredTeam = Number(options.team);
    if (Number.isInteger(desiredTeam) && desiredTeam >= 0 && Number(me.team) !== desiredTeam) {
      const key = `team:${desiredTeam}`;
      if (lastRoomCommand !== key) {
        lastRoomCommand = key;
        socket.emit('change_team', { team: desiredTeam });
      }
      return;
    }
    if (options.autoReady === false) return;
    // The server clears readiness while fewer than two players are present
    // and refuses it during deployment. Do not latch a request it cannot keep:
    // a later room update must still be able to ready us when a human joins.
    if (payload.update_queued || payload.players.filter((p) => Number(p.team) !== 0).length < 2) {
      lastRoomCommand = '';
      return;
    }
    if (me.ready) {
      lastRoomCommand = '';
      return;
    }
    if (!me.ready) {
      const key = `ready:${desiredTeam || me.team}`;
      if (lastRoomCommand !== key) {
        lastRoomCommand = key;
        socket.emit('change_ready', { ready: true });
      }
    }
  }

  function onConnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket.emit('join_game_room', { room });
  }

  function onDisconnect() {
    state.queueOps = [];
    state.inGame = false;
    state.actionPending = false;
    state.pendingAction = null;
    state.pendingTurn = -1;
    state.queueGraceWaits = 0;
    state.lastActionTurn = -1;
    lastRoomCommand = '';
    if (decisionTimer) clearTimeout(decisionTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (socket.connected) socket.emit('join_game_room', { room });
    }, 500);
  }

  function onLeft() {
    state.queueOps = [];
    state.inGame = false;
    state.ended = true;
    state.actionPending = false;
    state.pendingAction = null;
    lastRoomCommand = '';
    controller?.reset();
  }

  function onKick() {
    state.queueOps = [];
    state.inGame = false;
    state.ended = true;
    state.actionPending = false;
    state.pendingAction = null;
    lastRoomCommand = '';
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (socket.connected) socket.emit('join_game_room', { room });
    }, 500);
  }

  const listeners = [
    ['set_id', onSetId],
    ['init_map', onInit],
    ['update', onUpdate],
    ['room_update', onRoomUpdate],
    ['connect', onConnect],
    ['disconnect', onDisconnect],
    ['left', onLeft],
    ['room_kick', onKick],
  ];
  for (const [event, listener] of listeners) socket.on(event, listener);
  const heartbeatMs = Math.max(0, Number(options.heartbeatIntervalMs ?? 30000) || 0);
  if (heartbeatMs) {
    heartbeat = setInterval(() => socket.emit('room_heartbeat'), heartbeatMs);
    heartbeat.unref?.();
  }
  if (socket.connected) onConnect();

  return {
    state,
    controller: () => controller,
    opponentStats: () => opponentStats.snapshot(),
    stop() {
      if (heartbeat) clearInterval(heartbeat);
      if (decisionTimer) clearTimeout(decisionTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const [event, listener] of listeners) socket.off(event, listener);
    },
  };
}

module.exports = { attachStrategy, createOpponentStats };
