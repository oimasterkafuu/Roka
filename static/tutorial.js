(function () {
  const BOARD_ROWS = 12;
  const BOARD_COLS = 16;
  const PLAYER_ID = 1;
  const ENEMY_ID = 2;
  const SCALE_CLASS = 3;
  const TICK_MS = 650;
  // 连通/孤军演示期间的放慢节奏：便于看清 断链 → 宽限期快速闪烁 → 每回合衰减 的过程。
  const DEMO_TICK_MS = 1100;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 2.25;
  const CLICK_TOLERANCE = 6;
  const PAN_TRIGGER_PIXELS = 18;
  const TARGET_TUTORIAL_ZOOM = 1.25;
  const CAMERA_START_OFFSET_X = -160;
  const CAMERA_START_OFFSET_Y = 100;

  // 与正式对局一致的规则常量（教程沙包：敌方主城产兵封顶，避免拖延导致数值失控）
  const BUILD_COST = 50;
  const ENEMY_CROWN_CAP = 60;
  const BURST_START_TURN = 26;
  const BURST_END_TURN = 50;
  const PLAIN_GROWTH_INTERVAL = 50;
  const ISOLATED_DECAY_RATIO = 0.05;
  const ISOLATED_GRACE_TICKS = 10;

  // 地图 ASCII 稿：. 空地  ^ 山脉  ~ 沼泽  G 己方主城  # 敌方主城  C 敌方指挥所  e 敌方空地
  // 注意：[1,13] 与 [2,14] 两座敌方哨站只经指挥所连通——指挥所被毁后它们会沦为孤军。
  const MAP_ASCII = [
    '................',
    '.G........^^.e..',
    '..........^.eCe.',
    '..........^.e#..',
    '..........^.ee..',
    '..........^.....',
    '....^^....~..^..',
    '....^.....~..^..',
    '....^.....~..^..',
    '....^...........',
    '................',
    '................',
  ];

  // 带守军的格子（ASCII 之外的兵力表）：敌方空地守军 / 中立哨站守军
  const ENEMY_PLAIN_ARMY = [
    [1, 13, 8],
    [2, 12, 10],
    [2, 14, 8],
    [3, 12, 10],
    [4, 12, 8],
    [4, 13, 12],
  ];
  const NEUTRAL_PLAIN_ARMY = [
    [2, 5, 4],
    [3, 4, 6],
  ];

  const POS = {
    playerCrown: [1, 1],
    firstMove: [1, 2],
    queueTarget: [1, 4],
    halfFrom: [1, 4],
    shiftFrom: [2, 4],
    buildPlain: [2, 2],
    enemyCity: [2, 13],
    enemyCrown: [3, 13],
  };

  // 连通演示区（左下角）：指挥所锚点 — 要道 — 两座哨站
  const DEMO = {
    anchor: [11, 1],
    link: [10, 1],
    outposts: [
      [10, 2],
      [10, 3],
    ],
  };
  const DEMO_CELLS = [DEMO.anchor, DEMO.link, DEMO.outposts[0], DEMO.outposts[1]];
  const DEMO_CELL_SET = new Set(
    DEMO_CELLS.map(function (cell) {
      return cell[0] + ',' + cell[1];
    }),
  );

  const DIRECTIONS = [
    { x: -1, y: 0, key: ['w', 'arrowup'], arrow: '↑' },
    { x: 1, y: 0, key: ['s', 'arrowdown'], arrow: '↓' },
    { x: 0, y: -1, key: ['a', 'arrowleft'], arrow: '←' },
    { x: 0, y: 1, key: ['d', 'arrowright'], arrow: '→' },
  ];
  const DIRE_CHARS = ['↑', '↓', '←', '→'];
  const DIRE_CLASSES = ['arrow_u', 'arrow_d', 'arrow_l', 'arrow_r'];

  const STEP_LIST = [
    {
      title: '拖动地图',
      body: '在地图或背景上按住鼠标左键并拖动，即可平移视角。',
      hint: '把地图拖动到画面中央。',
      targets: [],
    },
    {
      title: '滚轮缩放',
      body: '滚动鼠标滚轮可以缩放地图：拉远纵览全局，拉近看清细节。',
      hint: '将地图放大到合适尺寸。',
      targets: [],
    },
    {
      title: '选中主城',
      body: '移动和攻击前，需要先选中命令对象。带王冠的格子是你的主城：最重要的据点，也是兵力之源。点击你的主城，选中它。',
      hint: '选中后会出现白色边框。',
      targets: [POS.playerCrown],
    },
    {
      title: '推兵（WASD）',
      body: '保持选中，按 W/A/S/D 或方向键向相邻格推兵。默认全兵推出：只留 1 兵看守，其余全部派出。推入空地即占领，推入己方格即增援。',
      hint: '用键盘占领高亮空地。',
      targets: [POS.firstMove],
    },
    {
      title: '操作队列',
      body: '快速连按两次 D（或 →）：推兵指令会进入操作队列，每回合自动执行一条，格子上的小箭头标示排队方向。实战中可按 Q 清空队列、按 E 撤销队尾一条。',
      hint: '连按排队，占领高亮格。',
      targets: [POS.queueTarget],
    },
    {
      title: 'Z 半兵',
      body: '按 Z 进入半兵待发状态（选中格显示 50%）：下一次推兵按智能分兵的理论推出量减半取整，用后自动失效，再按 Z 可取消。适合分头扩张、保留后劲。',
      hint: '选中高亮格，按 Z 后推出一次半兵。',
      targets: [POS.halfFrom],
    },
    {
      title: 'Shift 智能分兵',
      body: '按住 Shift 推兵 = 智能分兵：为其他三个方向的非己方相邻格保留「守军兵力 - 1」之和 + 1 的兵力，其余才推出，目标方向不参与保留计算。高亮格南侧与东侧的两座中立哨站会被计入保留。Shift 不会消耗 Z 的待发状态。',
      hint: '把兵力调到高亮格（或用任意己方格），按住 Shift 推一次兵。',
      targets: [POS.shiftFrom],
    },
    {
      title: '空格跳回主城',
      body: '领土再大也能快速回家：按空格跳回离你最近的主城并自动选中。主城已在视野内时镜头保持不动，不在视野内时才会居中过去。',
      hint: '按一下空格。',
      targets: [],
    },
    {
      title: '生产规则',
      body: '主城每 Tick（0.5 秒）+1 兵；正常状态的普通领土与指挥所每 50 Tick +1 兵；第 26~50 Tick 是全局爆发期，正常普通领土每 Tick 额外 +1（地图外圈会出现红边警示，指挥所不享受爆发加成）。沼泽与中立格永不产兵。多占地、保连通，经济才滚得快。',
      hint: '阅读后点击「继续」。',
      targets: [],
      manual: true,
    },
    {
      title: 'X 建造指挥所',
      body: '在己方普通地块（兵力 ≥ 50）按 X，消耗 50 兵建造指挥所，下一回合建成。建造与推兵共用操作队列：入队只校验地形，执行时才校验归属与兵力，条件不满足会自动跳过；排队时格子右下角会显示小角标。指挥所每 50 Tick +1 兵，更是关键的连通锚点。',
      hint: '把 50 兵调到高亮空地（或任意己方空地），按 X 建造。',
      targets: [POS.buildPlain],
    },
    {
      title: 'C 升级主城',
      body: '选中己方指挥所（兵力 ≥ 50）按 C，再消耗 50 兵升级为主城——每多一座主城，每 Tick 多产 1 兵。进阶技巧：在普通空地直接按 C 会自动连排「建指挥所 + 升级主城」两步，两回合建成，两个角标并排显示（共需 100 兵）。',
      hint: '给高亮指挥所补足 50 兵后，选中它按 C 升级。',
      targets: [],
      dynamic: 'playerCity',
    },
    {
      title: '连通与孤军',
      body: '己方格经己方格四方向连通到任意己方主城或指挥所 = 正常；与所有锚点断开的领土会沦为孤军：兵力立即减半（1 兵保持为 1）、无法操作；前五回合只快速闪烁不衰减，第六回合起每回合衰减 5%，归零变中立；重新连通后兵力翻倍。请看左下角演示区。',
      hint: '观察左下角演示区。',
      targets: DEMO_CELLS,
      manual: true,
      waitDemo: true,
    },
    {
      title: '攻占敌方指挥所',
      body: '进攻规则：攻击兵力必须严格大于防守兵力才能占领；占领后新兵力 = 攻击兵力 − 守军兵力。兵力不足时占领失败，但双方都会扣掉等量兵力（防守方最低减到 0，归属不变）。占领建筑 = 摧毁建筑：敌方指挥所被铲平，变为普通地块。失去锚点的敌方领土还会沦为孤军。先撕开守卫空地，集兵后拿下高亮指挥所（守军 35）。',
      hint: '集兵超过 35，再进攻高亮指挥所。',
      targets: [POS.enemyCity],
      failHint:
        '兵力不足，没能占领（守军也被等量消耗了一些）！攻击必须严格大于守军（35）。先集兵到相邻格，再进攻。',
    },
    {
      title: '攻占敌方主城',
      body: '最终目标：攻陷敌方主城。占领敌方最后一座主城即获胜：残余领土不会转移给你，而是全部沦为孤军、逐渐衰减消亡。敌方主城会持续产兵（教程中封顶 60），拖得越久越强——从后方主城不断调兵，在旧指挥所废墟上集兵，一击必杀！',
      hint: '集兵后攻击高亮主城。',
      targets: [POS.enemyCrown, POS.enemyCity],
      failHint: '兵力不足，没能占领（守军被等量消耗）！继续从后方调兵，超过守军后再攻。',
    },
    {
      title: '教程完成',
      body: '你已掌握 Roka 的全部核心操作：推兵、队列、Z/Shift 分兵、建造升级、连通与攻城。实战中还可按 Enter 聊天、T 队伍聊天、Esc 投降。',
      hint: '回到首页创建或加入房间开始实战，也可以查看回放学习其他玩家的操作。',
      targets: [],
    },
  ];

  const STEP_BUILD_CITY = 9;
  const STEP_UPGRADE_CROWN = 10;
  const STEP_DEMO = 11;
  const STEP_ENEMY_CITY = 12;
  const STEP_ENEMY_CROWN = 13;

  const dom = {};
  let state = null;
  let tickTimer = 0;

  function createTile(terrain, owner, army) {
    return {
      terrain: terrain,
      owner: owner,
      army: army,
    };
  }

  function createMatrix(rows, cols, factory) {
    const matrix = new Array(rows);
    for (let i = 0; i < rows; i += 1) {
      matrix[i] = new Array(cols);
      for (let j = 0; j < cols; j += 1) {
        matrix[i][j] = factory(i, j);
      }
    }
    return matrix;
  }

  function createInitialState() {
    return {
      board: createMatrix(BOARD_ROWS, BOARD_COLS, function () {
        return createTile('plain', 0, 0);
      }),
      visible: createMatrix(BOARD_ROWS, BOARD_COLS, function () {
        return true;
      }),
      discovered: createMatrix(BOARD_ROWS, BOARD_COLS, function () {
        return true;
      }),
      isolated: createMatrix(BOARD_ROWS, BOARD_COLS, function () {
        return false;
      }),
      isolatedAge: createMatrix(BOARD_ROWS, BOARD_COLS, function () {
        return 0;
      }),
      selected: { x: -1, y: -1 },
      queue: [],
      turn: 0,
      currentStep: 0,
      running: false,
      paused: true,
      pauseReason: '教学暂停：先熟悉地图控制。',
      didPan: false,
      didZoom: false,
      halfPending: false,
      didHalfPush: false,
      didSmartSplit: false,
      didJump: false,
      failedTarget: null,
      enemyDefeated: false,
      demo: { active: false, startTurn: 0, cut: false, decayHintShown: false, done: false },
      demoHint: '',
      panX: 0,
      panY: 0,
      zoom: MIN_ZOOM,
      pointer: {
        active: false,
        pointerId: -1,
        startX: 0,
        startY: 0,
        startPanX: 0,
        startPanY: 0,
        moved: false,
        downCell: null,
        downOnBack: false,
      },
    };
  }

  function setupScenarioBoard() {
    for (let i = 0; i < BOARD_ROWS; i += 1) {
      for (let j = 0; j < BOARD_COLS; j += 1) {
        const ch = (MAP_ASCII[i] || '')[j] || '.';
        if (ch === '^') {
          state.board[i][j] = createTile('mountain', 0, 0);
        } else if (ch === '~') {
          state.board[i][j] = createTile('swamp', 0, 0);
        } else if (ch === 'G') {
          state.board[i][j] = createTile('crown', PLAYER_ID, 100);
        } else if (ch === '#') {
          state.board[i][j] = createTile('crown', ENEMY_ID, 25);
        } else if (ch === 'C') {
          state.board[i][j] = createTile('city', ENEMY_ID, 35);
        } else if (ch === 'e') {
          state.board[i][j] = createTile('plain', ENEMY_ID, 0);
        } else {
          state.board[i][j] = createTile('plain', 0, 0);
        }
      }
    }
    for (let i = 0; i < ENEMY_PLAIN_ARMY.length; i += 1) {
      const cell = ENEMY_PLAIN_ARMY[i];
      const tile = state.board[cell[0]][cell[1]];
      if (tile.owner === ENEMY_ID && tile.terrain === 'plain') {
        tile.army = cell[2];
      }
    }
    for (let i = 0; i < NEUTRAL_PLAIN_ARMY.length; i += 1) {
      const cell = NEUTRAL_PLAIN_ARMY[i];
      const tile = state.board[cell[0]][cell[1]];
      if (tile.owner === 0 && tile.terrain === 'plain') {
        tile.army = cell[2];
      }
    }
  }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < BOARD_ROWS && y < BOARD_COLS;
  }

  function tileAt(x, y) {
    if (!inBounds(x, y)) {
      return null;
    }
    return state.board[x][y];
  }

  function isAdjacent(a, b, x, y) {
    return Math.abs(a - x) + Math.abs(b - y) === 1;
  }

  function isPassable(x, y) {
    const tile = tileAt(x, y);
    return Boolean(tile) && tile.terrain !== 'mountain';
  }

  function isOwnTile(x, y) {
    const tile = tileAt(x, y);
    return Boolean(tile) && tile.owner === PLAYER_ID;
  }

  function isDemoCell(x, y) {
    return DEMO_CELL_SET.has(x + ',' + y);
  }

  function setPaused(paused, reason) {
    state.paused = paused;
    state.pauseReason = reason || '';
  }

  function encodeVisibleTile(tile) {
    if (tile.terrain === 'mountain') {
      return { code: 201, army: 0 };
    }
    if (tile.terrain === 'swamp') {
      if (tile.owner > 0) {
        return { code: 150 + tile.owner, army: tile.army };
      }
      return { code: 204, army: 0 };
    }
    if (tile.terrain === 'city') {
      return { code: 50 + tile.owner, army: tile.army };
    }
    if (tile.terrain === 'crown') {
      return { code: 100 + tile.owner, army: tile.army };
    }
    if (tile.owner > 0 || tile.army > 0) {
      return { code: tile.owner, army: tile.army };
    }
    return { code: 200, army: 0 };
  }

  function getDisplayCell(x, y) {
    const tile = tileAt(x, y);
    if (!tile) {
      return { code: 200, army: 0 };
    }
    return encodeVisibleTile(tile);
  }

  function refreshVisibility() {
    // Roka 无战雾：教程同样全图可见。
    state.visible = createMatrix(BOARD_ROWS, BOARD_COLS, function () {
      return true;
    });
    state.discovered = createMatrix(BOARD_ROWS, BOARD_COLS, function () {
      return true;
    });
  }

  function getStepTargets(index) {
    const step = STEP_LIST[index] || STEP_LIST[STEP_LIST.length - 1];
    const targets = Array.isArray(step.targets) ? step.targets : [];
    const set = new Set();
    for (let i = 0; i < targets.length; i += 1) {
      const cell = targets[i];
      if (!Array.isArray(cell) || cell.length !== 2) {
        continue;
      }
      set.add(cell[0] + ',' + cell[1]);
    }
    if (step.dynamic === 'playerCity') {
      for (let x = 0; x < BOARD_ROWS; x += 1) {
        for (let y = 0; y < BOARD_COLS; y += 1) {
          const tile = tileAt(x, y);
          if (tile && tile.owner === PLAYER_ID && tile.terrain === 'city') {
            set.add(x + ',' + y);
            return set;
          }
        }
      }
    }
    return set;
  }

  function buildQueueRouteFlags() {
    const flags = new Array(4);
    for (let d = 0; d < 4; d += 1) {
      flags[d] = createMatrix(BOARD_ROWS, BOARD_COLS, function () {
        return false;
      });
    }
    for (let i = 0; i < state.queue.length; i += 1) {
      const cmd = state.queue[i];
      if (cmd.kind !== 'm') {
        continue;
      }
      const dx = cmd.toX - cmd.fromX;
      const dy = cmd.toY - cmd.fromY;
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        if (DIRECTIONS[d].x === dx && DIRECTIONS[d].y === dy) {
          flags[d][cmd.fromX][cmd.fromY] = true;
          break;
        }
      }
    }
    return flags;
  }

  function buildQueuedBadges() {
    const badges = createMatrix(BOARD_ROWS, BOARD_COLS, function () {
      return '';
    });
    for (let i = 0; i < state.queue.length; i += 1) {
      const cmd = state.queue[i];
      if ((cmd.kind === 'b' || cmd.kind === 'c') && inBounds(cmd.x, cmd.y)) {
        badges[cmd.x][cmd.y] += cmd.kind;
      }
    }
    return badges;
  }

  function buildCellClass(code) {
    let cls = 's' + SCALE_CLASS;
    if (code < 200) {
      if (code < 50) {
        cls += ' c' + code;
      } else if (code < 100) {
        cls += ' c' + (code - 50) + ' city';
      } else if (code < 150) {
        cls += ' c' + (code - 100) + ' general';
      } else {
        cls += ' c' + (code - 150) + ' swamp';
      }
    } else if (code === 200) {
      cls += ' empty';
    } else if (code === 201) {
      cls += ' mountain empty';
    } else if (code === 204) {
      cls += ' swamp';
    }
    return cls;
  }

  function canIssueFromSelectedTo(x, y) {
    if (state.selected.x < 0 || state.selected.y < 0) {
      return false;
    }
    if (!inBounds(x, y) || !isAdjacent(state.selected.x, state.selected.y, x, y)) {
      return false;
    }
    if (!isPassable(x, y)) {
      return false;
    }
    if (state.demo.active && isDemoCell(state.selected.x, state.selected.y)) {
      return false;
    }
    const from = tileAt(state.selected.x, state.selected.y);
    if (!from) {
      return false;
    }
    const ownSelected = from.owner === PLAYER_ID;
    if (!ownSelected && state.queue.length === 0) {
      return false;
    }
    if (state.queue.length === 0 && from.army <= 1) {
      return false;
    }
    return true;
  }

  function applyMapTransform() {
    dom.map.style.setProperty('--pan-x', state.panX + 'px');
    dom.map.style.setProperty('--pan-y', state.panY + 'px');
    dom.map.style.setProperty('--zoom', String(state.zoom));
  }

  function centerOnCell(x, y) {
    const td = dom.map.querySelector('td[data-x="' + x + '"][data-y="' + y + '"]');
    if (!td) {
      return;
    }
    const rect = td.getBoundingClientRect();
    state.panX += window.innerWidth / 2 - (rect.left + rect.width / 2);
    state.panY += window.innerHeight / 2 - (rect.top + rect.height / 2);
    applyMapTransform();
  }

  function applyInitialCamera() {
    centerOnCell(POS.playerCrown[0], POS.playerCrown[1]);
    state.panX += CAMERA_START_OFFSET_X;
    state.panY += CAMERA_START_OFFSET_Y;
    applyMapTransform();
  }

  function renderMap() {
    const targets = getStepTargets(state.currentStep);
    const routeFlags = buildQueueRouteFlags();
    const badges = buildQueuedBadges();
    let html = '<table><tbody>';
    for (let x = 0; x < BOARD_ROWS; x += 1) {
      html += '<tr>';
      for (let y = 0; y < BOARD_COLS; y += 1) {
        const display = getDisplayCell(x, y);
        let cls = buildCellClass(display.code);
        let txt = '';
        let selectedHalfMode = false;

        if (state.selected.x === x && state.selected.y === y) {
          if (state.halfPending) {
            cls += ' selected selected50';
            selectedHalfMode = true;
          } else {
            cls += ' selected';
          }
        } else if (canIssueFromSelectedTo(x, y)) {
          cls += ' attackable';
        }

        if (state.isolated[x][y]) {
          cls += ' isolated';
          if (state.isolatedAge[x][y] <= ISOLATED_GRACE_TICKS) {
            cls += ' isolated-fresh';
          }
        }

        if (targets.has(x + ',' + y)) {
          cls += ' tutorial-target';
        }

        if (display.code < 200 && (display.army > 0 || display.code === 50)) {
          txt = String(display.army);
          if (SCALE_CLASS === 1) {
            txt = '<div class="txt">' + txt + '</div>';
          }
        }
        if (selectedHalfMode) {
          txt = '50%';
        }

        for (let d = 0; d < 4; d += 1) {
          if (routeFlags[d][x][y]) {
            txt += '<div class="' + DIRE_CLASSES[d] + '">' + DIRE_CHARS[d] + '</div>';
          }
        }

        const badge = badges[x][y];
        if (badge.indexOf('b') >= 0) {
          txt += '<div class="build-badge build-b' + (badge.indexOf('c') >= 0 ? ' with-c' : '') + '"></div>';
        }
        if (badge.indexOf('c') >= 0) {
          txt += '<div class="build-badge build-c"></div>';
        }

        html += '<td data-x="' + x + '" data-y="' + y + '" class="' + cls + '">' + txt + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    dom.map.innerHTML = html;
    applyMapTransform();
  }

  function formatTurn(turn) {
    return Math.floor(turn / 2) + (turn % 2 === 1 ? '.' : '');
  }

  function collectStats(owner) {
    let army = 0;
    let land = 0;
    for (let x = 0; x < BOARD_ROWS; x += 1) {
      for (let y = 0; y < BOARD_COLS; y += 1) {
        const tile = tileAt(x, y);
        if (!tile || tile.owner !== owner) {
          continue;
        }
        army += Math.max(0, tile.army);
        land += 1;
      }
    }
    return { army: army, land: land };
  }

  function renderLeaderboard() {
    const p1 = collectStats(PLAYER_ID);
    const p2 = collectStats(ENEMY_ID);
    let html = '<tr><td>队伍</td><td>玩家</td><td>兵力</td><td>领土</td></tr>';
    html +=
      '<tr class="' +
      (p1.land <= 0 ? 'dead' : '') +
      '"><td>1</td><td class="leaderboard-name c1">你（教程）</td><td>' +
      p1.army +
      '</td><td>' +
      p1.land +
      '</td></tr>';
    html +=
      '<tr class="' +
      (p2.land <= 0 ? 'dead' : '') +
      '"><td>2</td><td class="leaderboard-name c2">敌方</td><td>' +
      p2.army +
      '</td><td>' +
      p2.land +
      '</td></tr>';
    dom.leaderboard.innerHTML = html;
  }

  function renderHud() {
    dom.turnCounter.textContent = '回合 ' + formatTurn(state.turn);
    if (state.running && state.turn >= BURST_START_TURN && state.turn <= BURST_END_TURN) {
      dom.map.classList.add('burst');
      dom.map.style.setProperty('--burst-alpha', ((0.7 * (BURST_END_TURN + 1 - state.turn)) / 25).toFixed(3));
    } else {
      dom.map.classList.remove('burst');
    }
  }

  function renderStepPanel() {
    const step = STEP_LIST[state.currentStep] || STEP_LIST[STEP_LIST.length - 1];
    const stage = state.currentStep < 8 ? '第一阶段 · 基础操作' : '第二阶段 · 进阶技巧';
    dom.stepProgress.textContent = stage + '　—　步骤 ' + (state.currentStep + 1) + ' / ' + STEP_LIST.length;
    dom.stepTitle.textContent = step.title;
    dom.stepBody.textContent = step.body;
    let hint = step.hint;
    if (step.waitDemo && state.demoHint) {
      hint = state.demoHint;
    }
    if (state.failedTarget && step.failHint) {
      hint = step.failHint;
    }
    dom.stepHint.textContent = hint;
    const canNext = Boolean(step.manual) && (!step.waitDemo || state.demo.done);
    dom.nextBtn.style.display = canNext ? '' : 'none';
  }

  function renderAll() {
    renderStepPanel();
    renderMap();
    renderLeaderboard();
    renderHud();
  }

  function addQueueCommand(cmd) {
    state.queue.push(cmd);
  }

  function clearQueue() {
    state.queue = [];
    renderAll();
    evaluateStepProgress();
  }

  function popQueue() {
    if (!state.queue.length) {
      return;
    }
    const cmd = state.queue.pop();
    if (cmd.kind === 'm' && state.selected.x === cmd.toX && state.selected.y === cmd.toY) {
      state.selected.x = cmd.fromX;
      state.selected.y = cmd.fromY;
    }
    renderAll();
    evaluateStepProgress();
  }

  // 智能分兵：B 为其他三个方向上非己方相邻格的「兵力 - 1」之和，保留 = B + 1；
  // 理论推出 = max(0, A - B - 1)；半兵（Z）取理论推出减半取整；全兵推出 A - 1。
  function computePush(fromX, fromY, toX, toY, mode) {
    const from = tileAt(fromX, fromY);
    const total = from.army;
    const cap = Math.max(0, total - 1);
    if (mode === 2) {
      return cap;
    }

    let defense = 0;
    for (let d = 0; d < DIRECTIONS.length; d += 1) {
      const nx = fromX + DIRECTIONS[d].x;
      const ny = fromY + DIRECTIONS[d].y;
      if (nx === toX && ny === toY) {
        continue;
      }
      const neighbor = tileAt(nx, ny);
      if (!neighbor || neighbor.terrain === 'mountain') {
        continue;
      }
      if (neighbor.owner === PLAYER_ID) {
        continue;
      }
      defense += neighbor.army - 1;
    }

    const theoretical = Math.max(0, total - defense - 1);
    const push = mode === 1 ? Math.floor(theoretical / 2) : theoretical;
    return Math.min(push, cap);
  }

  function applyCaptureIfEnemyDefeated() {
    // 占领敌方最后一座主城：敌方出局，残余领土【不】转移给己方——全部保持敌方归属
    // 并直接进入孤军状态（不执行断链减半），指挥所降级为普通地块以确保无锚点可重连，
    // 之后按孤军规则自然衰减至中立。
    for (let x = 0; x < BOARD_ROWS; x += 1) {
      for (let y = 0; y < BOARD_COLS; y += 1) {
        const tile = tileAt(x, y);
        if (!tile || tile.owner !== ENEMY_ID) {
          continue;
        }
        if (tile.terrain === 'city' || tile.terrain === 'crown') {
          tile.terrain = 'plain';
        }
        state.isolated[x][y] = true;
        state.isolatedAge[x][y] = 1;
      }
    }

    state.enemyDefeated = true;
    state.queue = [];
  }

  function executeMove(cmd) {
    if (!inBounds(cmd.fromX, cmd.fromY) || !inBounds(cmd.toX, cmd.toY)) {
      return false;
    }
    if (!isAdjacent(cmd.fromX, cmd.fromY, cmd.toX, cmd.toY)) {
      return false;
    }

    const from = tileAt(cmd.fromX, cmd.fromY);
    const to = tileAt(cmd.toX, cmd.toY);
    if (!from || !to || from.owner !== PLAYER_ID || state.isolated[cmd.fromX][cmd.fromY] || from.army <= 1) {
      return false;
    }
    if (to.terrain === 'mountain') {
      return false;
    }

    const movingArmy = computePush(cmd.fromX, cmd.fromY, cmd.toX, cmd.toY, cmd.mode);
    if (movingArmy <= 0) {
      markFailedTarget(cmd.toX, cmd.toY);
      return false;
    }

    if (to.owner === PLAYER_ID) {
      from.army -= movingArmy;
      to.army += movingArmy;
      return true;
    }

    if (movingArmy > to.army) {
      // 攻击兵力严格大于防守兵力才占领：防守兵力全灭，新兵力 = 推出兵力 − 守军兵力；建筑被摧毁变为普通地。
      const capturedEnemyCrown = to.terrain === 'crown' && to.owner === ENEMY_ID;
      const defense = to.army;
      from.army -= movingArmy;
      to.owner = PLAYER_ID;
      to.army = movingArmy - defense;
      if (to.terrain === 'city' || to.terrain === 'crown') {
        to.terrain = 'plain';
      }
      if (capturedEnemyCrown) {
        applyCaptureIfEnemyDefeated();
      }
      return true;
    }

    // 未严格大于守军：进攻失败但双方互损——进攻方损失全部推出兵力，
    // 防守方减去等量兵力（最低到 0，归属与建筑不变）。对课程目标给出失败提示。
    from.army -= movingArmy;
    to.army -= movingArmy;
    markFailedTarget(cmd.toX, cmd.toY);
    return true;
  }

  // 进攻未占领（推出 0 或未严格大于守军）且目标是当前课程高亮格时，给出失败提示。
  function markFailedTarget(x, y) {
    const targets = getStepTargets(state.currentStep);
    if (targets.has(x + ',' + y)) {
      state.failedTarget = x + ',' + y;
    }
  }

  // 建造在执行时才校验归属/兵力/连通，条件不满足自动跳过，不消耗队列之外的任何东西。
  function tryBuildCity(x, y) {
    const tile = tileAt(x, y);
    if (!tile || tile.owner !== PLAYER_ID || state.isolated[x][y] || tile.terrain !== 'plain') {
      return false;
    }
    if (tile.army < BUILD_COST) {
      return false;
    }
    tile.army -= BUILD_COST;
    tile.terrain = 'city';
    return true;
  }

  function tryUpgradeCrown(x, y) {
    const tile = tileAt(x, y);
    if (!tile || tile.owner !== PLAYER_ID || state.isolated[x][y] || tile.terrain !== 'city') {
      return false;
    }
    if (tile.army < BUILD_COST) {
      return false;
    }
    tile.army -= BUILD_COST;
    tile.terrain = 'crown';
    return true;
  }

  // 每 Tick 执行一条有效操作；无效操作自动跳过并继续尝试后续操作。
  function executeQueueHead() {
    while (state.queue.length > 0) {
      const cmd = state.queue.shift();
      if (cmd.kind === 'b') {
        if (tryBuildCity(cmd.x, cmd.y)) {
          return;
        }
        continue;
      }
      if (cmd.kind === 'c') {
        if (tryUpgradeCrown(cmd.x, cmd.y)) {
          return;
        }
        continue;
      }
      if (executeMove(cmd)) {
        return;
      }
    }
  }

  function applyGrowth() {
    const burst = state.turn >= BURST_START_TURN && state.turn <= BURST_END_TURN;
    const plainGrowth = state.turn % PLAIN_GROWTH_INTERVAL === 0;
    for (let x = 0; x < BOARD_ROWS; x += 1) {
      for (let y = 0; y < BOARD_COLS; y += 1) {
        const tile = tileAt(x, y);
        if (!tile || tile.owner <= 0) {
          continue;
        }
        if (tile.terrain === 'crown') {
          if (tile.owner === ENEMY_ID && tile.army >= ENEMY_CROWN_CAP) {
            continue;
          }
          tile.army += 1;
          continue;
        }
        if (tile.terrain === 'city') {
          // 指挥所与普通领土一样每 50 Tick +1（仅正常状态），不吃爆发期加成。
          if (plainGrowth && !state.isolated[x][y]) {
            tile.army += 1;
          }
          continue;
        }
        if (tile.terrain !== 'plain' || state.isolated[x][y]) {
          continue;
        }
        if (plainGrowth) {
          tile.army += 1;
        }
        if (burst) {
          tile.army += 1;
        }
      }
    }
  }

  function computeConnected(ownerId) {
    const connected = createMatrix(BOARD_ROWS, BOARD_COLS, function () {
      return false;
    });
    const visitQueue = [];
    for (let x = 0; x < BOARD_ROWS; x += 1) {
      for (let y = 0; y < BOARD_COLS; y += 1) {
        const tile = tileAt(x, y);
        if (tile && tile.owner === ownerId && (tile.terrain === 'crown' || tile.terrain === 'city')) {
          connected[x][y] = true;
          visitQueue.push([x, y]);
        }
      }
    }
    let head = 0;
    while (head < visitQueue.length) {
      const cell = visitQueue[head];
      head += 1;
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const nx = cell[0] + DIRECTIONS[d].x;
        const ny = cell[1] + DIRECTIONS[d].y;
        if (!inBounds(nx, ny) || connected[nx][ny]) {
          continue;
        }
        const neighbor = tileAt(nx, ny);
        if (!neighbor || neighbor.owner !== ownerId || neighbor.terrain === 'mountain') {
          continue;
        }
        connected[nx][ny] = true;
        visitQueue.push([nx, ny]);
      }
    }
    return connected;
  }

  function neutralizeTile(tile, x, y) {
    tile.owner = 0;
    tile.army = 0;
    if (tile.terrain === 'city' || tile.terrain === 'crown') {
      tile.terrain = 'plain';
    }
    state.isolated[x][y] = false;
    state.isolatedAge[x][y] = 0;
  }

  function applyIsolatedDecay(tile, x, y) {
    const decay = Math.max(1, Math.ceil(tile.army * ISOLATED_DECAY_RATIO));
    if (tile.army - decay <= 0) {
      neutralizeTile(tile, x, y);
      return;
    }
    tile.army -= decay;
  }

  // 重算双方连通（以己方主城/指挥所为锚点）：断链减半（1 兵保持为 1）、
  // 前 5 回合宽限期只快速闪烁不衰减、第 6 回合起每回合衰减 5%、重连 ×2。
  function applyConnectivity() {
    const owners = [PLAYER_ID, ENEMY_ID];
    for (let o = 0; o < owners.length; o += 1) {
      const ownerId = owners[o];
      const connected = computeConnected(ownerId);
      for (let x = 0; x < BOARD_ROWS; x += 1) {
        for (let y = 0; y < BOARD_COLS; y += 1) {
          const tile = tileAt(x, y);
          if (!tile || tile.owner !== ownerId) {
            continue;
          }
          if (connected[x][y]) {
            if (state.isolated[x][y]) {
              state.isolated[x][y] = false;
              state.isolatedAge[x][y] = 0;
              tile.army *= 2;
            }
            continue;
          }
          if (!state.isolated[x][y]) {
            state.isolated[x][y] = true;
            state.isolatedAge[x][y] = 1;
            tile.army = tile.army === 1 ? 1 : Math.floor(tile.army / 2);
            if (tile.army <= 0) {
              neutralizeTile(tile, x, y);
            }
            continue;
          }
          state.isolatedAge[x][y] += 1;
          if (state.isolatedAge[x][y] > ISOLATED_GRACE_TICKS && state.isolatedAge[x][y] % 2 === 1) {
            applyIsolatedDecay(tile, x, y);
          }
        }
      }
    }
  }

  // 连通演示：征用左下角演示区，剧本化展示 断链 → 孤军衰减 → 重连翻倍。
  function clearDemoSurroundings() {
    for (let i = 0; i < DEMO_CELLS.length; i += 1) {
      const cell = DEMO_CELLS[i];
      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const nx = cell[0] + DIRECTIONS[d].x;
        const ny = cell[1] + DIRECTIONS[d].y;
        if (!inBounds(nx, ny) || DEMO_CELL_SET.has(nx + ',' + ny)) {
          continue;
        }
        const neighbor = tileAt(nx, ny);
        if (neighbor && neighbor.terrain === 'plain' && neighbor.owner !== 0) {
          neighbor.owner = 0;
          neighbor.army = 0;
        }
      }
    }
  }

  function startConnectivityDemo() {
    state.demo = { active: true, startTurn: state.turn, cut: false, decayHintShown: false, done: false };
    startTickLoop(); // 演示期间放慢节奏
    clearDemoSurroundings();
    const anchor = tileAt(DEMO.anchor[0], DEMO.anchor[1]);
    anchor.terrain = 'city';
    anchor.owner = PLAYER_ID;
    anchor.army = 30;
    const link = tileAt(DEMO.link[0], DEMO.link[1]);
    link.terrain = 'plain';
    link.owner = PLAYER_ID;
    link.army = 12;
    const out1 = tileAt(DEMO.outposts[0][0], DEMO.outposts[0][1]);
    out1.terrain = 'plain';
    out1.owner = PLAYER_ID;
    out1.army = 25;
    const out2 = tileAt(DEMO.outposts[1][0], DEMO.outposts[1][1]);
    out2.terrain = 'plain';
    out2.owner = PLAYER_ID;
    out2.army = 20;
    state.demoHint = '观察左下角演示区：指挥所经要道连接着两座前线哨站。';
    centerOnCell(DEMO.link[0], DEMO.link[1]);
  }

  function runDemoScript() {
    const demo = state.demo;
    if (!demo || !demo.active) {
      return;
    }
    const phase = state.turn - demo.startTurn;
    if (!demo.cut && phase >= 2) {
      demo.cut = true;
      const link = tileAt(DEMO.link[0], DEMO.link[1]);
      link.owner = ENEMY_ID;
      link.army = 8;
      state.demoHint =
        '敌方小队突袭了要道！哨站与指挥所断开，沦为孤军：兵力立即减半（1 兵保持为 1）。注意它们开始快速闪烁——前五回合只是警告，兵力不会继续减少。';
    }
    if (demo.cut && !demo.decayHintShown && phase >= 12) {
      demo.decayHintShown = true;
      state.demoHint =
        '宽限期结束（闪烁随之变慢）：孤军开始每回合衰减 5%（至少 1 点）——看，哨站兵力正在缓慢流失。';
    }
    if (demo.cut && !demo.done && phase >= 18) {
      demo.done = true;
      demo.active = false;
      startTickLoop(); // 演示结束，恢复正常节奏
      const link = tileAt(DEMO.link[0], DEMO.link[1]);
      link.owner = PLAYER_ID;
      link.army = 10;
      state.demoHint = '增援收复要道：孤军重新连通，兵力按当前值翻倍恢复。演示结束，点击「继续」。';
    }
  }

  function tick() {
    if (!state.running || state.paused) {
      return;
    }

    state.turn += 1;

    applyGrowth();
    executeQueueHead();
    runDemoScript();
    applyConnectivity();
    refreshVisibility();
    renderAll();
    evaluateStepProgress();
  }

  function startTickLoop() {
    if (tickTimer) {
      window.clearInterval(tickTimer);
    }
    tickTimer = window.setInterval(tick, state.demo.active ? DEMO_TICK_MS : TICK_MS);
  }

  function startGame() {
    state.running = true;
    state.turn = 0;
    state.queue = [];
    state.selected = { x: -1, y: -1 };
    state.halfPending = false;
    setPaused(false, '');

    refreshVisibility();
    renderAll();
  }

  function isOwned(pos) {
    const tile = tileAt(pos[0], pos[1]);
    return Boolean(tile) && tile.owner === PLAYER_ID;
  }

  function isSelected(pos) {
    return state.selected.x === pos[0] && state.selected.y === pos[1];
  }

  function countPlayerTerrain(terrain) {
    let count = 0;
    for (let x = 0; x < BOARD_ROWS; x += 1) {
      for (let y = 0; y < BOARD_COLS; y += 1) {
        const tile = tileAt(x, y);
        if (tile && tile.owner === PLAYER_ID && tile.terrain === terrain) {
          count += 1;
        }
      }
    }
    return count;
  }

  function evaluateStepProgress() {
    switch (state.currentStep) {
      case 0:
        if (state.didPan) {
          nextStep();
        }
        break;
      case 1:
        if (state.zoom >= TARGET_TUTORIAL_ZOOM) {
          nextStep();
        }
        break;
      case 2:
        if (isSelected(POS.playerCrown)) {
          nextStep();
        }
        break;
      case 3:
        if (isOwned(POS.firstMove)) {
          nextStep();
        }
        break;
      case 4:
        if (isOwned(POS.queueTarget)) {
          nextStep();
        }
        break;
      case 5:
        if (state.didHalfPush) {
          nextStep();
        }
        break;
      case 6:
        if (state.didSmartSplit) {
          nextStep();
        }
        break;
      case 7:
        if (state.didJump) {
          nextStep();
        }
        break;
      case STEP_BUILD_CITY:
        if (countPlayerTerrain('city') > 0) {
          nextStep();
        }
        break;
      case STEP_UPGRADE_CROWN:
        if (countPlayerTerrain('crown') >= 2) {
          nextStep();
        }
        break;
      case STEP_ENEMY_CITY:
        if (isOwned(POS.enemyCity)) {
          nextStep();
        }
        break;
      case STEP_ENEMY_CROWN:
        if (state.enemyDefeated || isOwned(POS.enemyCrown)) {
          nextStep();
        }
        break;
      default:
        break;
    }
  }

  function enterStep(index) {
    if (index < 0) {
      index = 0;
    }
    if (index >= STEP_LIST.length) {
      index = STEP_LIST.length - 1;
    }
    state.currentStep = index;
    state.failedTarget = null;

    if (index === 0) {
      setPaused(true, '教学暂停：请先拖动地图。');
      state.running = false;
    } else if (index === 1) {
      setPaused(true, '教学暂停：请继续滚轮放大地图。');
      state.running = false;
    } else if (index === 2) {
      if (!state.running) {
        startGame();
      }
    } else if (index === STEP_DEMO) {
      startConnectivityDemo();
    } else if (index === STEP_LIST.length - 1) {
      setPaused(true, '教程结束。');
      state.running = false;
      state.queue = [];
    }

    renderAll();
    if (index === STEP_ENEMY_CITY) {
      centerOnCell(POS.enemyCity[0], POS.enemyCity[1]);
    }
    if (index === STEP_ENEMY_CROWN) {
      centerOnCell(POS.enemyCrown[0], POS.enemyCrown[1]);
    }
    window.setTimeout(evaluateStepProgress, 0);
  }

  function nextStep() {
    const next = Math.min(STEP_LIST.length - 1, state.currentStep + 1);
    if (next === state.currentStep) {
      return;
    }
    enterStep(next);
  }

  // 推兵入队：Shift = 智能分兵；Z 待发时半兵；否则全兵。Shift 优先且不消耗 Z 待发状态。
  function tryQueueAttackTo(x, y, shift) {
    if (!state.running || !canIssueFromSelectedTo(x, y)) {
      return false;
    }
    const mode = shift ? 0 : state.halfPending ? 1 : 2;
    addQueueCommand({
      kind: 'm',
      fromX: state.selected.x,
      fromY: state.selected.y,
      toX: x,
      toY: y,
      mode: mode,
    });
    if (mode === 0) {
      state.didSmartSplit = true;
    }
    if (mode === 1) {
      state.didHalfPush = true;
    }
    if (!shift) {
      state.halfPending = false;
    }
    state.selected = { x: x, y: y };
    renderAll();
    evaluateStepProgress();
    return true;
  }

  // 建造入队只校验地形（山脉/沼泽禁止）；归属、兵力、连通在执行时才校验。
  function enqueueBuild(op) {
    if (!state.running || state.selected.x < 0 || state.selected.y < 0) {
      return;
    }
    const sx = state.selected.x;
    const sy = state.selected.y;
    if (state.demo.active && isDemoCell(sx, sy)) {
      return;
    }
    const tile = tileAt(sx, sy);
    if (!tile || tile.terrain === 'mountain' || tile.terrain === 'swamp') {
      return;
    }
    if (op === 'b') {
      // X 建指挥所：普通地块（已有建筑则无效）
      if (tile.terrain !== 'plain') {
        return;
      }
      addQueueCommand({ kind: 'b', x: sx, y: sy });
    } else {
      // C：己方指挥所直接升级主城；其余可建地块连续入队「建 + 升」两步
      if (tile.terrain === 'crown') {
        return;
      }
      if (tile.terrain === 'city' && tile.owner === PLAYER_ID) {
        addQueueCommand({ kind: 'c', x: sx, y: sy });
      } else {
        addQueueCommand({ kind: 'b', x: sx, y: sy });
        addQueueCommand({ kind: 'c', x: sx, y: sy });
      }
    }
    renderAll();
    evaluateStepProgress();
  }

  // 目标格当前是否完整显示在视野内（用于空格跳转：可见则不拖动镜头）。
  function isCellOnScreen(x, y) {
    const td = dom.map.querySelector('td[data-x="' + x + '"][data-y="' + y + '"]');
    if (!td) {
      return false;
    }
    const rect = td.getBoundingClientRect();
    return (
      rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight
    );
  }

  function jumpToNearestCrown() {
    if (!state.running) {
      return;
    }
    const refX = state.selected.x >= 0 ? state.selected.x : BOARD_ROWS / 2 - 0.5;
    const refY = state.selected.y >= 0 ? state.selected.y : BOARD_COLS / 2 - 0.5;
    let bestX = -1;
    let bestY = -1;
    let bestDist = -1;
    for (let x = 0; x < BOARD_ROWS; x += 1) {
      for (let y = 0; y < BOARD_COLS; y += 1) {
        const tile = tileAt(x, y);
        if (!tile || tile.owner !== PLAYER_ID || tile.terrain !== 'crown') {
          continue;
        }
        const dist = Math.abs(x - refX) + Math.abs(y - refY);
        if (bestDist < 0 || dist < bestDist) {
          bestDist = dist;
          bestX = x;
          bestY = y;
        }
      }
    }
    if (bestX < 0) {
      return;
    }
    state.selected = { x: bestX, y: bestY };
    state.didJump = true;
    renderAll();
    // 目标已在视野内时只移动光标；不在视野内才把镜头居中过去。
    if (!isCellOnScreen(bestX, bestY)) {
      centerOnCell(bestX, bestY);
    }
    evaluateStepProgress();
  }

  function handleTileClick(x, y) {
    if (!inBounds(x, y)) {
      return;
    }

    if (!state.running) {
      return;
    }

    if (state.demo.active && isDemoCell(x, y)) {
      return;
    }

    if (isOwnTile(x, y) && state.visible[x][y]) {
      state.selected = { x: x, y: y };
    } else {
      state.selected = { x: -1, y: -1 };
    }

    renderAll();
    evaluateStepProgress();
  }

  function findCellFromEventTarget(target) {
    if (!target || typeof target.closest !== 'function') {
      return null;
    }
    const td = target.closest('td');
    if (!td) {
      return null;
    }
    const x = Number.parseInt(String(td.dataset.x || ''), 10);
    const y = Number.parseInt(String(td.dataset.y || ''), 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x: x, y: y };
  }

  function isMapTarget(target) {
    if (!target) {
      return false;
    }
    if (target === dom.mapBack) {
      return true;
    }
    if (typeof target.closest === 'function' && target.closest('#map')) {
      return true;
    }
    return false;
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !isMapTarget(event.target)) {
      return;
    }
    state.pointer.active = true;
    state.pointer.pointerId = event.pointerId;
    state.pointer.startX = event.clientX;
    state.pointer.startY = event.clientY;
    state.pointer.startPanX = state.panX;
    state.pointer.startPanY = state.panY;
    state.pointer.moved = false;
    state.pointer.downCell = findCellFromEventTarget(event.target);
    state.pointer.downOnBack = event.target === dom.mapBack;
    dom.map.classList.add('dragging');

    if (typeof event.target.setPointerCapture === 'function') {
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch {
        // noop
      }
    }
  }

  function onPointerMove(event) {
    if (!state.pointer.active || state.pointer.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - state.pointer.startX;
    const dy = event.clientY - state.pointer.startY;

    if (Math.abs(dx) > CLICK_TOLERANCE || Math.abs(dy) > CLICK_TOLERANCE) {
      state.pointer.moved = true;
    }

    state.panX = state.pointer.startPanX + dx;
    state.panY = state.pointer.startPanY + dy;
    applyMapTransform();

    if (!state.didPan && Math.sqrt(dx * dx + dy * dy) > PAN_TRIGGER_PIXELS) {
      state.didPan = true;
    }
    if (state.currentStep === 0 && state.didPan) {
      evaluateStepProgress();
    }
  }

  function onPointerUp(event) {
    if (!state.pointer.active || state.pointer.pointerId !== event.pointerId) {
      return;
    }

    const moved = state.pointer.moved;
    const downCell = state.pointer.downCell;
    const downOnBack = state.pointer.downOnBack;

    state.pointer.active = false;
    state.pointer.pointerId = -1;
    state.pointer.downCell = null;
    state.pointer.downOnBack = false;

    dom.map.classList.remove('dragging');

    if (!moved) {
      if (downCell) {
        handleTileClick(downCell.x, downCell.y);
      } else if (downOnBack && state.running) {
        state.selected = { x: -1, y: -1 };
        renderAll();
      }
    }
  }

  function onWheel(event) {
    if (!isMapTarget(event.target)) {
      return;
    }
    event.preventDefault();

    const oldZoom = state.zoom;
    if (event.deltaY > 0) {
      state.zoom = Math.max(MIN_ZOOM, state.zoom - 0.08);
    } else {
      state.zoom = Math.min(MAX_ZOOM, state.zoom + 0.08);
    }

    if (oldZoom !== state.zoom) {
      applyMapTransform();
      if (!state.didZoom) {
        state.didZoom = true;
      }
      if (state.currentStep === 1) {
        evaluateStepProgress();
      }
    }
  }

  function tryMoveByDirection(dx, dy, shift) {
    if (state.selected.x < 0 || state.selected.y < 0) {
      return;
    }
    const x = state.selected.x + dx;
    const y = state.selected.y + dy;
    if (!inBounds(x, y)) {
      return;
    }
    if (tryQueueAttackTo(x, y, shift)) {
      return;
    }
    // 命令无效（兵力不足、选中非己方格等）时光标也保持可移动，仅山脉不可移入。
    if (state.running && isPassable(x, y)) {
      state.selected = { x: x, y: y };
      renderAll();
      evaluateStepProgress();
    }
  }

  function onKeyDown(event) {
    const target = event.target;
    const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      return;
    }

    const key = String(event.key || '').toLowerCase();
    const shift = Boolean(event.shiftKey);

    for (let i = 0; i < DIRECTIONS.length; i += 1) {
      if (DIRECTIONS[i].key.indexOf(key) >= 0) {
        event.preventDefault();
        tryMoveByDirection(DIRECTIONS[i].x, DIRECTIONS[i].y, shift);
        return;
      }
    }

    if (key === 'q') {
      event.preventDefault();
      clearQueue();
      return;
    }
    if (key === 'e') {
      event.preventDefault();
      popQueue();
      return;
    }
    if (key === ' ') {
      event.preventDefault();
      jumpToNearestCrown();
      return;
    }
    if (key === 'z') {
      event.preventDefault();
      if (!state.running) {
        return;
      }
      state.halfPending = !state.halfPending;
      renderAll();
      return;
    }
    if (key === 'x') {
      event.preventDefault();
      enqueueBuild('b');
      return;
    }
    if (key === 'c') {
      event.preventDefault();
      enqueueBuild('c');
    }
  }

  function bindEvents() {
    dom.homeBtn.addEventListener('click', function () {
      location.href = '/';
    });

    dom.resetBtn.addEventListener('click', function () {
      resetTutorial();
    });

    dom.nextBtn.addEventListener('click', function () {
      const step = STEP_LIST[state.currentStep];
      if (step && step.manual && (!step.waitDemo || state.demo.done)) {
        nextStep();
      }
    });

    dom.map.addEventListener('pointerdown', onPointerDown);
    dom.mapBack.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);

    dom.map.addEventListener('wheel', onWheel, { passive: false });
    dom.mapBack.addEventListener('wheel', onWheel, { passive: false });

    document.addEventListener('keydown', onKeyDown);
  }

  function resetTutorial() {
    state = createInitialState();
    setupScenarioBoard();
    refreshVisibility();
    renderAll();
    applyInitialCamera();
    enterStep(0);
  }

  async function loadUser() {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        throw new Error('unauthorized');
      }
      await res.json();
      return true;
    } catch {
      location.href = '/login';
      return false;
    }
  }

  function cacheDom() {
    dom.map = document.getElementById('map');
    dom.mapBack = document.getElementById('map_back');
    dom.turnCounter = document.getElementById('turn-counter');
    dom.leaderboard = document.getElementById('game-leaderboard');
    dom.stepProgress = document.getElementById('tutorial-step-progress');
    dom.stepTitle = document.getElementById('tutorial-step-title');
    dom.stepBody = document.getElementById('tutorial-step-body');
    dom.stepHint = document.getElementById('tutorial-step-hint');
    dom.nextBtn = document.getElementById('tutorial-next-btn');
    dom.homeBtn = document.getElementById('room-home-btn');
    dom.resetBtn = document.getElementById('tutorial-reset-btn');
  }

  async function main() {
    cacheDom();
    const authed = await loadUser();
    if (!authed) {
      return;
    }
    bindEvents();
    resetTutorial();
    startTickLoop();
  }

  main();
})();
