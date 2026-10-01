'use strict';

const { makeBoard } = require('./bot/board.cjs');
const { createController } = require('./bot/controller.cjs');

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
  const actionDelayMs = Math.max(0, Number(options.actionDelayMs ?? 60) || 0);
  const state = {
    n: 0,
    m: 0,
    size: 0,
    playerId: 0,
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
    state.queued = 0;
    state.playerId = ids.indexOf(state.clientId) + 1;
    state.dead = false;
    state.ended = false;
    state.inGame = true;
    controller = createController(state.playerId);
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
        dead: state.dead,
        ended: state.ended,
      },
      state.playerId,
    );
    const action = controller.choose(board);
    if (!action) return;
    state.queued += 1;
    socket.emit(action.kind === 'build' ? 'build' : 'attack', action);
  }

  function onSetId(id) {
    state.clientId = String(id || '');
  }

  function onInit(payload = {}) {
    const n = Number(payload.n);
    const m = Number(payload.m);
    const ids = Array.isArray(payload.player_ids) ? payload.player_ids.map(String) : [];
    if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || n * m > 100000) return;
    reset(n, m, ids);
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
    state.turn = payload.turn;
    state.ended = Boolean(payload.game_end);
    if (payload.kills && payload.kills[state.clientId]) state.dead = true;
    if (state.ended) {
      state.inGame = false;
      if (decisionTimer) clearTimeout(decisionTimer);
      controller?.reset();
      return;
    }
    if (!state.playerId || state.dead) return;
    if (decisionTimer) clearTimeout(decisionTimer);
    decisionTimer = setTimeout(decide, actionDelayMs);
  }

  function onRoomUpdate(payload = {}) {
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
    state.inGame = false;
    lastRoomCommand = '';
    if (decisionTimer) clearTimeout(decisionTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (socket.connected) socket.emit('join_game_room', { room });
    }, 500);
  }

  function onLeft() {
    state.inGame = false;
    state.ended = true;
    lastRoomCommand = '';
    controller?.reset();
  }

  function onKick() {
    state.inGame = false;
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
    stop() {
      if (heartbeat) clearInterval(heartbeat);
      if (decisionTimer) clearTimeout(decisionTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const [event, listener] of listeners) socket.off(event, listener);
    },
  };
}

module.exports = { attachStrategy };
