function decodeReplayBinary(buffer) {
  var view = new DataView(buffer);
  var offset = 0;
  var replay_meta_extension_marker = 0xa5;

  function ensure(size) {
    if (offset + size > view.byteLength) {
      throw new Error('回放数据损坏');
    }
  }

  function readU8() {
    ensure(1);
    var value = view.getUint8(offset);
    offset += 1;
    return value;
  }

  function readU16() {
    ensure(2);
    var value = view.getUint16(offset, true);
    offset += 2;
    return value;
  }

  function readU32() {
    ensure(4);
    var value = view.getUint32(offset, true);
    offset += 4;
    return value;
  }

  function readBytes(size) {
    ensure(size);
    var bytes = new Uint8Array(buffer, offset, size);
    offset += size;
    return bytes;
  }

  function readString() {
    var len = readU16();
    if (len === 0) return '';
    var bytes = readBytes(len);
    if (replay_text_decoder) return replay_text_decoder.decode(bytes);
    var text = '';
    for (var i = 0; i < bytes.length; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    try {
      return decodeURIComponent(escape(text));
    } catch {
      return text;
    }
  }

  function readLeaderboard() {
    var count = readU16();
    var leaderboard = new Array(count);
    for (var i = 0; i < count; i++) {
      var team = readU8();
      var uid = readString();
      var army = readU32();
      var land = readU32();
      var classCode = readU8();
      var dead = readU16();
      var id = readU8();
      leaderboard[i] = {
        team: team,
        uid: uid,
        army: army,
        land: land,
        class_: replay_class_from_code[classCode] || '',
        dead: dead,
        id: id,
      };
    }
    return leaderboard;
  }

  function readVarUint() {
    var value = 0;
    for (var shift = 0; shift <= 28; shift += 7) {
      var byte = readU8();
      if (shift === 28 && byte > 15) break;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error('回放视野数据损坏');
  }

  function readFullGrid() {
    var len = readU32();
    var values = new Array(len);
    for (var i = 0; i < len; i++) {
      values[i] = readU8();
    }
    return values;
  }

  function readFullArmy() {
    var len = readU32();
    var values = new Array(len);
    for (var i = 0; i < len; i++) {
      values[i] = readU32();
    }
    return values;
  }

  function readGridDiff() {
    var pairCount = readU32();
    var diff = new Array(pairCount * 2);
    for (var i = 0; i < pairCount; i++) {
      diff[i * 2] = readU16();
      diff[i * 2 + 1] = readU8();
    }
    return diff;
  }

  function readArmyDiff() {
    var pairCount = readU32();
    var diff = new Array(pairCount * 2);
    for (var i = 0; i < pairCount; i++) {
      diff[i * 2] = readU16();
      diff[i * 2 + 1] = readU32();
    }
    return diff;
  }

  function readInitialPayload() {
    var turn = readU32();
    var gameEnd = readU8() == 1;
    var leaderboard = readLeaderboard();
    var grid = readFullGrid();
    var army = readFullArmy();
    var isolated = readFullGrid();
    return {
      grid_type: grid,
      army_cnt: army,
      isolated: isolated,
      lst_moves: [],
      leaderboard: leaderboard,
      turn: turn,
      kills: {},
      game_end: gameEnd,
      is_diff: false,
    };
  }

  function readPatchPayload() {
    var turn = readU32();
    var gameEnd = readU8() == 1;
    var leaderboard = readLeaderboard();
    var gridDiff = readGridDiff();
    var armyDiff = readArmyDiff();
    var isolatedDiff = readGridDiff();
    return {
      grid_type: gridDiff,
      army_cnt: armyDiff,
      isolated: isolatedDiff,
      lst_moves: [],
      leaderboard: leaderboard,
      turn: turn,
      kills: {},
      game_end: gameEnd,
      is_diff: true,
    };
  }

  function readReplayMeta() {
    var count = readU16();
    var playerNames = new Array(count);
    var playerTeams = new Array(count);
    for (var i = 0; i < count; i++) {
      playerNames[i] = readString();
      playerTeams[i] = readU8();
    }
    var mode = ['normal', 'explored', 'visible'][readU8()];
    if (!mode) throw new Error('回放迷雾模式损坏');
    var aiDifficulty = 'normal';
    var serverBotSeats = [];
    var visionTeamCount = null;
    if (offset < view.byteLength) {
      var extensionOrTeamCount = readU8();
      if (extensionOrTeamCount === replay_meta_extension_marker) {
        var difficultyCode = readU8();
        if (difficultyCode !== 0 && difficultyCode !== 1) throw new Error('回放 AI 难度损坏');
        aiDifficulty = difficultyCode === 1 ? 'simple' : 'normal';
        var seatCount = readU8();
        if (seatCount > count) throw new Error('回放托管席位损坏');
        for (var seatIndex = 0; seatIndex < seatCount; seatIndex++) {
          var seat = readU8();
          if (seat < 1 || seat > count || serverBotSeats.indexOf(seat) !== -1)
            throw new Error('回放托管席位损坏');
          serverBotSeats.push(seat);
        }
        if (mode !== 'visible') visionTeamCount = readU8();
      } else if (mode !== 'visible') {
        visionTeamCount = extensionOrTeamCount;
      } else {
        throw new Error('回放数据损坏');
      }
    } else if (mode !== 'visible') {
      throw new Error('回放视野数据损坏');
    }
    return {
      meta: {
        player_names: playerNames,
        player_teams: playerTeams,
        fog_mode: mode,
        ai_difficulty: aiDifficulty,
        server_bot_seats: serverBotSeats,
      },
      vision_team_count: visionTeamCount,
    };
  }

  function readVision(area, lastTurn, mode, teams, teamCount) {
    var vision = new Map();
    if (mode === 'visible') return vision;
    var expected = new Set(teams.filter((team) => team > 0));
    if (teamCount !== expected.size) throw new Error('回放视野队伍损坏');
    for (var teamIndex = 0; teamIndex < teamCount; teamIndex++) {
      var team = readU8();
      var omniscientFrom = readU32();
      var cellCount = readU32();
      if (
        !expected.delete(team) ||
        cellCount > area ||
        (omniscientFrom !== 0xffffffff && omniscientFrom > lastTurn)
      ) {
        throw new Error('回放视野数据损坏');
      }
      var cells = new Map();
      for (var cellIndex = 0; cellIndex < cellCount; cellIndex++) {
        var cell = readU16();
        var count = readVarUint();
        if (cell >= area || cells.has(cell) || !count || count > lastTurn + 1)
          throw new Error('回放视野数据损坏');
        ensure(count);
        var changes = new Uint32Array(count);
        var turn = 0;
        for (var change = 0; change < count; change++) {
          var delta = readVarUint();
          turn += delta;
          if ((!delta && change) || turn > lastTurn || turn >= omniscientFrom)
            throw new Error('回放视野数据损坏');
          changes[change] = turn;
        }
        cells.set(cell, changes);
      }
      vision.set(team, { omniscientFrom: omniscientFrom, cells: cells });
    }
    return vision;
  }

  for (var byte of replay_binary_magic) if (readU8() !== byte) throw new Error('回放格式不支持');
  var n = readU16();
  var m = readU16();
  var patchCount = readU32();
  var initial = readInitialPayload();
  var patches = new Array(patchCount);
  for (var i = 0; i < patchCount; i++) {
    patches[i] = {
      forward: readPatchPayload(),
      backward: readPatchPayload(),
    };
  }
  var replayMeta = readReplayMeta();
  var meta = replayMeta.meta;
  var lastTurn = patchCount ? patches[patchCount - 1].forward.turn : initial.turn;
  var vision = readVision(n * m, lastTurn, meta.fog_mode, meta.player_teams, replayMeta.vision_team_count);
  if (offset !== view.byteLength) throw new Error('回放数据损坏');
  return {
    n: n,
    m: m,
    initial: initial,
    patches: patches,
    meta: meta,
    vision: vision,
  };
}

function replayFogAt(history, mode, cell, turn) {
  if (!history || turn >= history.omniscientFrom) return 0;
  var changes = history.cells.get(cell);
  if (!changes || changes[0] > turn) return mode === 'normal' ? 2 : 1;
  var low = 1;
  var high = changes.length;
  while (low < high) {
    var middle = (low + high) >>> 1;
    if (changes[middle] <= turn) low = middle + 1;
    else high = middle;
  }
  return low & 1 ? 0 : 1;
}
