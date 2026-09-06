/**
 * simple-strategy-bot 策略核心（与服务端内嵌运行共用的唯一实现）。
 *
 * 本文件是纯逻辑模块，不自己创建连接：调用方（CLI 的 index.js 或服务端
 * src/server/server-bot-manager.ts）传入一个已配置鉴权的 socket.io-client
 * 实例，本模块负责房间循环（进房/自动准备/对局结束后再准备）与每回合决策。
 *
 * 策略概览（中等强度，非随机）：
 *  1. 主城防卫：敌军贴脸主城时，优先用相邻最强兵力全冲（mode 2）歼灭或削弱；
 *  2. 扩张：边界格用智能分兵（mode 0）占领中立空地，优先免费（0 兵）地块；
 *  3. 歼敌：兵力严格占优（己方兵力-1 > 守军）时全冲攻击敌军，优先敌方主城；
 *  4. 运兵：腹地格兵力沿 BFS 距离场向最近前线/敌人方向全冲输送；
 *  5. 建设：腹地高兵力普通格建指挥所（b），指挥所兵力充足再升级主城（c）。
 * 每回合最多下发 2 条操作，并用 lst_move 同步本地队列镜像，避免队列堆积过期指令。
 */

const DIRECTIONS = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
];

// 本地队列镜像上限：每 Tick 服务端只执行一条队首操作，排队过多会产生大量过期指令。
const MAX_LOCAL_QUEUE = 3;
// 每回合最多下发的操作数。
const MAX_OPS_PER_TURN = 2;
// 建设行为的回合间隔，避免连续建造拖垮前线兵力。
const BUILD_INTERVAL_TURNS = 12;
// 触发「建指挥所」的腹地格兵力门槛（执行时服务端还会校验 >= 50）。
const BUILD_CITY_MIN_ARMY = 110;
// 触发「升级主城」的指挥所兵力门槛。
const UPGRADE_CROWN_MIN_ARMY = 60;

function toBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * @param {import('socket.io-client').Socket} socket 已完成鉴权配置的 socket.io-client 实例
 * @param {object} options
 * @param {string} options.room 要加入并循环对局的房间号
 * @param {number} [options.team] 组队模式下的目标队伍号（默认 1）
 * @param {boolean} [options.autoReady] 是否自动参赛并准备（默认 true）
 * @param {number} [options.actionDelayMs] 每回合决策后的发送延迟（默认 120ms）
 * @param {number} [options.heartbeatIntervalMs] 房间心跳间隔（默认 30000ms；0 关闭）
 * @param {(message: string) => void} [options.log] 日志输出（默认 console.log）
 * @returns {{ stop: () => void }} 句柄，stop() 只拆监听与定时器，不断开 socket
 */
function attachStrategy(socket, options) {
  const room = String(options.room || '').trim();
  if (!room) {
    throw new Error('attachStrategy: missing room');
  }
  const targetTeam = Math.max(1, Number.parseInt(String(options.team ?? '1'), 10) || 1);
  const autoReady = options.autoReady !== false;
  const actionDelayMs = Math.max(0, Number.parseInt(String(options.actionDelayMs ?? '120'), 10) || 0);
  const heartbeatIntervalMs = Math.max(
    0,
    Number.parseInt(String(options.heartbeatIntervalMs ?? '30000'), 10) || 0,
  );
  const log = typeof options.log === 'function' ? options.log : (message) => console.log(message);

  const state = {
    n: 0,
    m: 0,
    gridType: [],
    armyCnt: [],
    isolated: [],
    clientId: '',
    playerId: 0,
    generals: [],
    lastTurn: -1,
    inGame: false,
    dead: false,
    queue: [],
    lastLobbyActionAt: 0,
    lastBuildTurn: -BUILD_INTERVAL_TURNS,
  };

  function indexOfCell(x, y) {
    return x * state.m + y;
  }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < state.n && y < state.m;
  }

  // owner id：200/201/204 中立；其余 code % 50 归属玩家（普通/指挥所/主城/己方沼泽同余）。
  function ownerOf(code) {
    if (typeof code !== 'number' || code >= 200) {
      return 0;
    }
    return code % 50;
  }

  function isMine(code) {
    return state.playerId > 0 && ownerOf(code) === state.playerId;
  }

  function isMountain(code) {
    return code === 201;
  }

  function isMyCapital(code) {
    return code === state.playerId + 100;
  }

  function isEnemyCapital(code) {
    const owner = ownerOf(code);
    return owner > 0 && owner !== state.playerId && code >= 100 && code < 150;
  }

  function passable(code) {
    return code !== 201;
  }

  // 可操作格：己方、非孤军、兵力 > 1。
  function canOperateFrom(x, y) {
    const idx = indexOfCell(x, y);
    return (
      isMine(state.gridType[idx]) && state.armyCnt[idx] > 1 && (state.isolated[idx] || 0) === 0
    );
  }

  function resetMap(n, m) {
    state.n = n;
    state.m = m;
    state.gridType = new Array(n * m).fill(200);
    state.armyCnt = new Array(n * m).fill(0);
    state.isolated = new Array(n * m).fill(0);
    state.lastTurn = -1;
    state.queue = [];
    state.dead = false;
    state.lastBuildTurn = -BUILD_INTERVAL_TURNS;
  }

  function applyDiff(diffArray, targetArray) {
    if (!Array.isArray(diffArray)) {
      return;
    }
    for (let i = 0; i + 1 < diffArray.length; i += 2) {
      const idx = Number.parseInt(String(diffArray[i]), 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= targetArray.length) {
        continue;
      }
      targetArray[idx] = diffArray[i + 1];
    }
  }

  function applyUpdatePayload(payload) {
    if (state.n === 0 || state.m === 0) {
      return false;
    }
    if (payload && payload.is_diff) {
      applyDiff(payload.grid_type, state.gridType);
      applyDiff(payload.army_cnt, state.armyCnt);
      if (Array.isArray(payload.isolated)) {
        applyDiff(payload.isolated, state.isolated);
      }
      return true;
    }
    if (!Array.isArray(payload?.grid_type) || !Array.isArray(payload?.army_cnt)) {
      return false;
    }
    if (
      payload.grid_type.length !== state.gridType.length ||
      payload.army_cnt.length !== state.armyCnt.length
    ) {
      return false;
    }
    state.gridType = payload.grid_type.slice();
    state.armyCnt = payload.army_cnt.slice();
    state.isolated = Array.isArray(payload.isolated)
      ? payload.isolated.slice()
      : new Array(state.n * state.m).fill(0);
    return true;
  }

  // 用 lst_move 同步本地队列镜像：skip 条队首被丢弃，若本 Tick 有执行（x >= 0）再少一条。
  function syncQueue(lstMove) {
    if (!lstMove || typeof lstMove !== 'object') {
      return;
    }
    let drop = Number.parseInt(String(lstMove.skip ?? '0'), 10) || 0;
    if (Number.parseInt(String(lstMove.x ?? '-1'), 10) >= 0) {
      drop += 1;
    }
    if (drop > 0) {
      state.queue.splice(0, drop);
    }
  }

  function enqueueOp(op) {
    state.queue.push(op);
    socket.emit(op.kind === 'build' ? 'build' : 'attack', op.payload);
  }

  /* ---------- 决策：各候选生成器 ---------- */

  // 1. 主城防卫：敌军与我方主城相邻时，找能歼灭（严格大于）或削弱的反击。
  function findCapitalDefense() {
    let bestUrgent = null;
    for (const general of state.generals) {
      for (const dir of DIRECTIONS) {
        const ex = general.x + dir.x;
        const ey = general.y + dir.y;
        if (!inBounds(ex, ey)) {
          continue;
        }
        const eIdx = indexOfCell(ex, ey);
        const eCode = state.gridType[eIdx];
        const eOwner = ownerOf(eCode);
        // 只回应真实敌军（中立格不会主动进攻主城）。
        if (eOwner <= 0 || eOwner === state.playerId) {
          continue;
        }
        const eArmy = state.armyCnt[eIdx];
        // 反击来源：主城自身或其他相邻己方格，取兵力最强者。
        let source = null;
        const sources = [{ x: general.x, y: general.y }];
        for (const dir2 of DIRECTIONS) {
          const sx = ex + dir2.x;
          const sy = ey + dir2.y;
          if (inBounds(sx, sy) && !(sx === general.x && sy === general.y)) {
            sources.push({ x: sx, y: sy });
          }
        }
        for (const s of sources) {
          if (!canOperateFrom(s.x, s.y)) {
            continue;
          }
          const sIdx = indexOfCell(s.x, s.y);
          if (!source || state.armyCnt[sIdx] > state.armyCnt[indexOfCell(source.x, source.y)]) {
            source = s;
          }
        }
        if (!source) {
          continue;
        }
        const sArmy = state.armyCnt[indexOfCell(source.x, source.y)];
        const canCapture = sArmy - 1 > eArmy;
        const capitalArmy = state.armyCnt[indexOfCell(general.x, general.y)];
        const imminentThreat = eArmy >= capitalArmy;
        if (!canCapture && !imminentThreat) {
          continue;
        }
        const candidate = {
          priority: canCapture ? 100 : 60,
          op: {
            kind: 'attack',
            payload: { x: source.x, y: source.y, dx: ex, dy: ey, mode: 2 },
          },
        };
        if (!bestUrgent || candidate.priority > bestUrgent.priority) {
          bestUrgent = candidate;
        }
      }
    }
    return bestUrgent ? bestUrgent.op : null;
  }

  // 2/3. 扩张与歼敌：边界格向外打。返回 { op, priority }。
  function findBestAttack(excludedSources) {
    let best = null;
    for (let x = 0; x < state.n; x += 1) {
      for (let y = 0; y < state.m; y += 1) {
        if (!canOperateFrom(x, y)) {
          continue;
        }
        const srcKey = `${x},${y}`;
        if (excludedSources.has(srcKey)) {
          continue;
        }
        const idx = indexOfCell(x, y);
        const army = state.armyCnt[idx];
        for (const dir of DIRECTIONS) {
          const dx = x + dir.x;
          const dy = y + dir.y;
          if (!inBounds(dx, dy)) {
            continue;
          }
          const tIdx = indexOfCell(dx, dy);
          const tCode = state.gridType[tIdx];
          if (isMountain(tCode) || isMine(tCode)) {
            continue;
          }
          const tOwner = ownerOf(tCode);
          const tArmy = state.armyCnt[tIdx];
          let score = 0;
          let mode = 0;
          if (tOwner === 0) {
            // 中立格：空地优先，中立沼泽不产兵、优先级最低。
            score = tCode === 204 ? 5 : tArmy === 0 ? 30 : 25 - Math.min(tArmy, 20);
          } else {
            // 敌军：只有严格占优才出手；敌方主城优先。
            if (army - 1 <= tArmy) {
              continue;
            }
            score = isEnemyCapital(tCode) ? 90 : 45 - Math.min(tArmy, 30);
            mode = 2;
          }
          // 兵力越充足的出发点越优先（同分时）。
          const priority = score * 1000 + Math.min(army, 999);
          if (!best || priority > best.priority) {
            best = {
              priority,
              op: { kind: 'attack', payload: { x, y, dx, dy, mode } },
            };
          }
        }
      }
    }
    return best;
  }

  // 4. 运兵：腹地兵力沿「到最近非己方格」的 BFS 距离场向前线输送。
  function findTroopMove(excludedSources) {
    const dist = computeFrontierDistance();
    if (!dist) {
      return null;
    }
    let best = null;
    for (let x = 0; x < state.n; x += 1) {
      for (let y = 0; y < state.m; y += 1) {
        if (!canOperateFrom(x, y)) {
          continue;
        }
        const idx = indexOfCell(x, y);
        const d = dist[idx];
        // 只移动腹地格（距前线 >= 2；边界格留给扩张/歼敌决策）。
        if (d < 2) {
          continue;
        }
        const srcKey = `${x},${y}`;
        if (excludedSources.has(srcKey)) {
          continue;
        }
        for (const dir of DIRECTIONS) {
          const dx = x + dir.x;
          const dy = y + dir.y;
          if (!inBounds(dx, dy)) {
            continue;
          }
          const tIdx = indexOfCell(dx, dy);
          if (!isMine(state.gridType[tIdx]) || dist[tIdx] !== d - 1) {
            continue;
          }
          const army = state.armyCnt[idx];
          if (!best || army > best.army) {
            best = {
              army,
              op: { kind: 'attack', payload: { x, y, dx, dy, mode: 2 } },
            };
          }
          break;
        }
      }
    }
    return best ? best.op : null;
  }

  // 多源 BFS：所有非己方可通行格为源，输出每格到前线的距离（不可达为 -1）。
  function computeFrontierDistance() {
    if (state.n === 0 || state.m === 0) {
      return null;
    }
    const total = state.n * state.m;
    const dist = new Array(total).fill(-1);
    const queue = [];
    for (let idx = 0; idx < total; idx += 1) {
      const code = state.gridType[idx];
      if (passable(code) && !isMine(code)) {
        dist[idx] = 0;
        queue.push(idx);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head];
      head += 1;
      const x = Math.floor(idx / state.m);
      const y = idx % state.m;
      for (const dir of DIRECTIONS) {
        const nx = x + dir.x;
        const ny = y + dir.y;
        if (!inBounds(nx, ny)) {
          continue;
        }
        const nIdx = indexOfCell(nx, ny);
        if (dist[nIdx] !== -1 || !passable(state.gridType[nIdx])) {
          continue;
        }
        dist[nIdx] = dist[idx] + 1;
        queue.push(nIdx);
      }
    }
    return dist;
  }

  // 5. 建设：指挥所兵力充足升主城；腹地高兵力普通格建指挥所。
  function findBuildOp(turn) {
    if (turn - state.lastBuildTurn < BUILD_INTERVAL_TURNS) {
      return null;
    }
    let upgrade = null;
    let buildCity = null;
    const dist = computeFrontierDistance();
    for (let x = 0; x < state.n; x += 1) {
      for (let y = 0; y < state.m; y += 1) {
        const idx = indexOfCell(x, y);
        const code = state.gridType[idx];
        const army = state.armyCnt[idx];
        if (!isMine(code) || (state.isolated[idx] || 0) !== 0) {
          continue;
        }
        if (code === state.playerId + 50 && army >= UPGRADE_CROWN_MIN_ARMY) {
          if (!upgrade || army > upgrade.army) {
            upgrade = { army, op: { kind: 'build', payload: { x, y, op: 'c' } } };
          }
          continue;
        }
        // 建指挥所：只选腹地（距前线 >= 3）且兵力充裕的普通格，避免拖垮前线。
        if (
          code === state.playerId &&
          army >= BUILD_CITY_MIN_ARMY &&
          dist &&
          dist[idx] >= 3
        ) {
          if (!buildCity || army > buildCity.army) {
            buildCity = { army, op: { kind: 'build', payload: { x, y, op: 'b' } } };
          }
        }
      }
    }
    const chosen = upgrade || buildCity;
    if (chosen) {
      state.lastBuildTurn = turn;
      return chosen.op;
    }
    return null;
  }

  function describeOp(op) {
    if (op.kind === 'build') {
      return `build ${op.payload.op} @(${op.payload.x},${op.payload.y})`;
    }
    return `attack (${op.payload.x},${op.payload.y})->(${op.payload.dx},${op.payload.dy}) mode=${op.payload.mode}`;
  }

  function decideTurn(turn) {
    if (state.playerId <= 0 || state.dead) {
      return;
    }

    const ops = [];
    const usedSources = new Set();

    const defense = findCapitalDefense();
    if (defense) {
      // 防卫优先：清掉过期队列，立即反击。
      if (state.queue.length > 0) {
        socket.emit('clear_queue');
        state.queue = [];
      }
      ops.push(defense);
      usedSources.add(`${defense.payload.x},${defense.payload.y}`);
    }

    const attack = findBestAttack(usedSources);
    if (attack) {
      ops.push(attack.op);
      usedSources.add(`${attack.op.payload.x},${attack.op.payload.y}`);
    }

    if (ops.length < MAX_OPS_PER_TURN) {
      const build = findBuildOp(turn);
      if (build && ops.length < MAX_OPS_PER_TURN) {
        ops.push(build);
      }
    }

    if (ops.length === 0) {
      const move = findTroopMove(usedSources);
      if (move) {
        ops.push(move);
      }
    }

    // 队列水位控制：本地镜像已满时本回合只保留防卫操作。
    const accepted = [];
    for (const op of ops) {
      if (state.queue.length + accepted.length >= MAX_LOCAL_QUEUE) {
        break;
      }
      accepted.push(op);
    }
    if (accepted.length === 0) {
      return;
    }

    setTimeout(() => {
      for (const op of accepted) {
        enqueueOp(op);
        log(`turn ${turn}: ${describeOp(op)}`);
      }
    }, actionDelayMs);
  }

  /* ---------- 房间循环 ---------- */

  function autoReadyFromRoomUpdate(data) {
    if (!autoReady || !state.clientId) {
      return;
    }
    if (!Array.isArray(data?.players) || toBoolean(data?.in_game)) {
      return;
    }

    const self = data.players.find((player) => String(player?.sid || '') === state.clientId);
    if (!self) {
      return;
    }

    const allowTeam = toBoolean(data.allow_team);
    const team = Number.parseInt(String(self.team ?? '0'), 10) || 0;
    const ready = toBoolean(self.ready);
    const need = Number.parseInt(String(data?.need ?? '0'), 10) || 0;
    const now = Date.now();

    if (now - state.lastLobbyActionAt < 1000) {
      return;
    }

    if (team === 0) {
      socket.emit('change_team', { team: allowTeam ? targetTeam : 1 });
      state.lastLobbyActionAt = now;
      log(`request change_team=${allowTeam ? targetTeam : 1}`);
      return;
    }

    if (need <= 1) {
      return;
    }

    if (!ready) {
      socket.emit('change_ready', { ready: true });
      state.lastLobbyActionAt = now;
      log('request change_ready=true');
    }
  }

  /* ---------- socket 事件 ---------- */

  const onConnect = () => {
    log(`connected: ${socket.id}`);
    socket.emit('join_game_room', { room });
  };

  const onConnectError = (error) => {
    log(`connect_error: ${error.message}`);
  };

  const onDisconnect = (reason) => {
    log(`disconnected: ${reason}`);
    state.inGame = false;
  };

  const onSetId = (id) => {
    state.clientId = String(id || '');
    log(`client_id: ${state.clientId}`);
  };

  const onInitMap = (data) => {
    const n = Number.parseInt(String(data?.n ?? '0'), 10);
    const m = Number.parseInt(String(data?.m ?? '0'), 10);
    if (!Number.isFinite(n) || !Number.isFinite(m) || n <= 0 || m <= 0) {
      return;
    }

    resetMap(n, m);
    state.inGame = true;

    const playerIds = Array.isArray(data?.player_ids) ? data.player_ids.map((item) => String(item)) : [];
    const foundIndex = playerIds.indexOf(state.clientId);
    state.playerId = foundIndex >= 0 ? foundIndex + 1 : 0;

    state.generals = [];
    if (Array.isArray(data?.general) && data.general.length === 2) {
      const gx = Number.parseInt(String(data.general[0]), 10);
      const gy = Number.parseInt(String(data.general[1]), 10);
      if (inBounds(gx, gy)) {
        state.generals = [{ x: gx, y: gy }];
      }
    }
    log(`init_map ${n}x${m}, playerId=${state.playerId || 'spectator'}`);
  };

  const onUpdate = (payload) => {
    if (!state.inGame) {
      return;
    }

    if (payload?.kills && state.clientId && payload.kills[state.clientId]) {
      state.dead = true;
    }

    const ok = applyUpdatePayload(payload);
    if (!ok) {
      return;
    }

    const turn = Number.parseInt(String(payload?.turn ?? '-1'), 10);
    if (!Number.isFinite(turn) || turn < 0 || turn === state.lastTurn) {
      return;
    }
    state.lastTurn = turn;
    syncQueue(payload?.lst_move);

    if (payload?.game_end) {
      state.inGame = false;
      log(`game ended at turn ${turn}`);
      return;
    }

    decideTurn(turn);
  };

  const onLeft = () => {
    state.inGame = false;
    log('left current game');
  };

  const onRoomKick = () => {
    state.inGame = false;
    log('kicked from room: heartbeat timeout, rejoining');
    // 被心跳踢出后延迟重新进房，保持对局循环。
    setTimeout(() => {
      socket.emit('join_game_room', { room });
    }, 1000);
  };

  const onRoomUpdate = (data) => {
    autoReadyFromRoomUpdate(data);
  };

  socket.on('connect', onConnect);
  socket.on('connect_error', onConnectError);
  socket.on('disconnect', onDisconnect);
  socket.on('set_id', onSetId);
  socket.on('init_map', onInitMap);
  socket.on('update', onUpdate);
  socket.on('left', onLeft);
  socket.on('room_kick', onRoomKick);
  socket.on('room_update', onRoomUpdate);

  // 房间心跳：普通用户 JWT 鉴权需要心跳才能长留在准备阶段；bot 令牌/服务端托管
  // 连接本就被服务端豁免，多发无害。
  let heartbeatTimer = null;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      socket.emit('room_heartbeat');
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }

  return {
    stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('disconnect', onDisconnect);
      socket.off('set_id', onSetId);
      socket.off('init_map', onInitMap);
      socket.off('update', onUpdate);
      socket.off('left', onLeft);
      socket.off('room_kick', onRoomKick);
      socket.off('room_update', onRoomUpdate);
    },
  };
}

module.exports = { attachStrategy };
