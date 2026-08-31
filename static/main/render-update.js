function render() {
  setRoomTopLeftVisible(false);
  $('#menu').css('display', 'none');
  $('#game-starting').css('display', 'none');
  $('#game').css('display', '');
  for (var d = 0; d < 4; d++) {
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < m; j++) {
        have_route[d][i][j] = false;
      }
    }
  }
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < m; j++) {
      have_build[i][j] = '';
    }
  }
  for (var i = 0; i < route.length; i++) {
    if (route[i].build) {
      // 同一格可能同时排有“建指挥所 + 升级主城”两步，角标需要累积
      var prevBuild = have_build[route[i].x][route[i].y];
      if (prevBuild.indexOf(route[i].build) < 0)
        have_build[route[i].x][route[i].y] = prevBuild + route[i].build;
    } else have_route[route[i].d][route[i].x][route[i].y] = true;
  }
  var displayGrid = grid_type;
  var displayArmy = army_cnt;
  var ownSelected =
    selx >= 0 &&
    sely >= 0 &&
    player > 0 &&
    displayGrid[selx][sely] < 200 &&
    displayGrid[selx][sely] % 50 == player;
  var canAttackFromSelected = selx >= 0 && sely >= 0 && (ownSelected || route.length > 0);
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < m; j++) {
      var cls = 's' + scale,
        txt = '';
      var cellType = displayGrid[i][j];
      var cellArmy = displayArmy[i][j];
      if (cellType < 200) {
        if (cellType < 50) {
          cls += ' c' + cellType;
        } else if (cellType < 100) {
          cls += ' c' + (cellType - 50) + ' city';
        } else if (cellType < 150) {
          cls += ' c' + (cellType - 100) + ' general';
        } else if (cellType < 200) {
          cls += ' c' + (cellType - 150) + ' swamp';
        }
        if (cellType % 50 == player) {
          cls += ' selectable';
        }
        if (isolated[i][j]) {
          cls += ' isolated';
          if (isolated[i][j] === 1) cls += ' isolated-fresh';
        }
        if (cellArmy || cellType == 50) txt = String(cellArmy);
      } else if (cellType == 200) {
        cls += ' empty';
      } else if (cellType == 201) {
        cls += ' mountain empty';
      } else if (cellType == 204) {
        cls += ' swamp';
      }
      if (i == selx && j == sely) {
        if (selt == 1) {
          cls += ' selected';
        } else {
          cls += ' selected selected50';
          txt = '50%';
        }
      } else if (canAttackFromSelected && Math.abs(i - selx) + Math.abs(j - sely) == 1 && cellType != 201) {
        cls += ' attackable';
      }
      if (txt.length > 0 && scale == 1) txt = '<div class="txt">' + txt + '</div>';
      for (var d = 0; d < 4; d++)
        if (have_route[d][i][j]) {
          if (scale > 1) txt += '<div class="' + dire_class[d] + '">' + dire_char[d] + '</div>';
          else txt += '<div class="' + dire_class[d] + '"><div class="txt">' + dire_char[d] + '</div></div>';
        }
      if (have_build[i][j]) {
        var hasB = have_build[i][j].indexOf('b') >= 0;
        var hasC = have_build[i][j].indexOf('c') >= 0;
        if (hasB) txt += '<div class="build-badge build-b' + (hasC ? ' with-c' : '') + '"></div>';
        if (hasC) txt += '<div class="build-badge build-c"></div>';
      }
      if ($('#t' + i + '_' + j).attr('class') != cls) {
        $('#t' + i + '_' + j).attr('class', cls);
      }
      if ($('#t' + i + '_' + j).html() != txt) {
        $('#t' + i + '_' + j).html(txt);
      }
    }
  }
}

function update(data) {
  if (typeof data.replay != 'undefined') replay_id = data.replay;
  if (!is_replay) {
    game_ended = Boolean(data.game_end);
  }
  if (data.is_diff) {
    for (var i = 0; i * 2 < data.grid_type.length; i++) {
      var t = data.grid_type[i * 2];
      grid_type[parseInt(t / m)][t % m] = data.grid_type[i * 2 + 1];
    }
    for (var i = 0; i * 2 < data.army_cnt.length; i++) {
      var t = data.army_cnt[i * 2];
      army_cnt[parseInt(t / m)][t % m] = data.army_cnt[i * 2 + 1];
    }
    if (data.isolated) {
      for (var i = 0; i * 2 < data.isolated.length; i++) {
        var t = data.isolated[i * 2];
        isolated[parseInt(t / m)][t % m] = data.isolated[i * 2 + 1];
      }
    }
  } else {
    for (var i = 0, t = 0; i < n; i++) {
      for (var j = 0; j < m; j++) {
        grid_type[i][j] = data.grid_type[t++];
      }
    }
    for (var i = 0, t = 0; i < n; i++) {
      for (var j = 0; j < m; j++) {
        army_cnt[i][j] = data.army_cnt[t++];
      }
    }
    if (data.isolated) {
      for (var i = 0, t = 0; i < n; i++) {
        for (var j = 0; j < m; j++) {
          isolated[i][j] = data.isolated[t++];
        }
      }
    }
  }
  if (player > 0) {
    var general_seen = {},
      general_new = Array();
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < m; j++) {
        if (grid_type[i][j] >= 100 && grid_type[i][j] < 150 && grid_type[i][j] % 50 == player) {
          var gkey = i + '_' + j;
          general_seen[gkey] = true;
          if (general_order.indexOf(gkey) == -1) general_new.push(gkey);
        }
      }
    }
    var general_kept = Array();
    for (var i = 0; i < general_order.length; i++) {
      if (general_seen[general_order[i]]) general_kept.push(general_order[i]);
    }
    general_order = general_kept.concat(general_new);
  }
  if (route.length) {
    // 服务器每 Tick 会丢弃队首的失效操作（skip 个），本地队列严格按 skip 同步，
    // 然后再匹配本 Tick 实际执行的那一条操作。
    var skipOps = data.lst_move.skip | 0;
    if (skipOps > route.length) skipOps = route.length;
    if (skipOps > 0) route = route.slice(skipOps);
    if (data.lst_move.x != -1 && route.length) {
      if (data.lst_move.op == 'b' || data.lst_move.op == 'c') {
        for (var i = 0; i < route.length; i++) {
          if (
            route[i].build == data.lst_move.op &&
            route[i].x == data.lst_move.x &&
            route[i].y == data.lst_move.y
          ) {
            route.splice(i, 1);
            break;
          }
        }
      } else {
        while (route.length) {
          if (route[0].build) {
            route = route.splice(1);
            continue;
          }
          var t1 = data.lst_move,
            t2 = {
              x: route[0].x,
              y: route[0].y,
              dx: route[0].x + dire[route[0].d].x,
              dy: route[0].y + dire[route[0].d].y,
              half: route[0].mode == 1,
            };
          route = route.splice(1);
          if (t1.x == t2.x && t1.y == t2.y && t1.dx == t2.dx && t1.dy == t2.dy && t1.half == t2.half) break;
        }
      }
    }
  }
  render();
  lb = data.leaderboard.sort(function (a, b) {
    if (a.army != b.army) return a.army > b.army ? -1 : 1;
    if (a.land != b.land) return a.land > b.land ? -1 : 1;
    if (a.class_ == 'dead') return a.dead > b.dead ? -1 : 1;
    return 0;
  });
  var th = '<tr><td>队伍</td><td>玩家</td><td>兵力</td><td>领土</td></tr>';
  for (var i = 0; i < lb.length; i++) {
    th +=
      '<tr class="' +
      lb[i].class_ +
      '"><td>' +
      lb[i].team +
      '</td><td class="leaderboard-name c' +
      lb[i].id +
      '">' +
      htmlescape(lb[i].uid) +
      '</td><td>' +
      lb[i].army +
      '</td><td>' +
      lb[i].land +
      '</td></tr>';
  }
  $('#game-leaderboard').html(th);
  $('#game-leaderboard').css('display', '');
  $('#turn-counter').html('回合 ' + Math.floor(data.turn / 2) + (data.turn % 2 == 1 ? '.' : ''));
  $('#turn-counter').css('display', '');
  if (data.turn >= 26 && data.turn <= 50) {
    $('#map').addClass('burst');
    $('#map').css('--burst-alpha', ((0.7 * (51 - data.turn)) / 25).toFixed(3));
  } else {
    $('#map').removeClass('burst');
  }
  if (is_replay) return;
  var replayBtn = $($('#status-alert').children()[0].children[6]);
  if (!data.game_end) {
    replayBtn.css('display', 'none');
  }
  var wasParticipant = player > 0;
  if (typeof data.kills[client_id] != 'undefined') {
    player = 0;
    route = Array();
    var killerName = String(data.kills[client_id] || '');
    var killerCode = killerName.trim();
    var lostText = '';
    if (killerCode == '挂机') {
      lostText = '<span>你已挂机。</span>';
    } else if (killerCode == '系统' || killerCode == '投降') {
      lostText = '<span>你已投降。</span>';
    } else {
      lostText =
        '<span>你被 <span style="font-family: Quicksand-Bold, HYMaQiDuo-Bold;">' +
        htmlescape(killerName) +
        '</span> 击败了。</span>';
    }
    $($('#status-alert').children()[0].children[0]).html('游戏结束');
    $($('#status-alert').children()[0].children[1]).html(lostText);
    $($('#status-alert').children()[0].children[1]).css('display', '');
    $($('#status-alert').children()[0].children[2]).css('display', 'none');
    $('#status-alert').css('display', '');
    hideSurrenderAlert();
    lost = true;
  }
  if (data.game_end) {
    player = 0;
    route = Array();
    if ($('#status-alert').css('display') == 'none') {
      if (!wasParticipant) {
        $($('#status-alert').children()[0].children[0]).html('本局已结束');
        $($('#status-alert').children()[0].children[1]).css('display', 'none');
      } else if (lost) {
        $($('#status-alert').children()[0].children[0]).html('本局已结束');
      } else {
        $($('#status-alert').children()[0].children[0]).html('你赢了');
        $($('#status-alert').children()[0].children[1]).html('<span>本局已结束。</span>');
        $($('#status-alert').children()[0].children[1]).css('display', '');
      }
    }
    $('#status-alert').css('display', '');
    hideSurrenderAlert();
    $($('#status-alert').children()[0].children[2]).css('display', 'none');
    replayBtn.css('display', replay_id ? '' : 'none');
  }
}
