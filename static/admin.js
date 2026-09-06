/* 后台管理页 /admin 逻辑（jQuery）。
 * 结构按功能分区（顶部 chrome / 用户管理 / 封禁对话框），便于后续扩展新管理模块。 */

var currentUsername = '';
var viewerIsSuperAdmin = false;
var usersCache = [];

/* ---------- 基础工具 ---------- */

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function fullTime(time) {
  var d = new Date(time);
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

function relativeTime(time) {
  var diff = Date.now() - time;
  if (diff < 0) {
    diff = 0;
  }
  var sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return '刚刚';
  }
  var min = Math.floor(sec / 60);
  if (min < 60) {
    return min + ' 分钟前';
  }
  var hour = Math.floor(min / 60);
  if (hour < 24) {
    return hour + ' 小时前';
  }
  var day = Math.floor(hour / 24);
  if (day < 30) {
    return day + ' 天前';
  }
  return fullTime(time);
}

async function apiPost(url, payload) {
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  var data = null;
  try {
    data = await res.json();
  } catch (e) {
    // 忽略非 JSON 响应
  }
  if (!res.ok) {
    var err = new Error((data && data.error) || '请求失败，请稍后再试。');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- 顶部 chrome ---------- */

// 校验登录态与管理员身份；非管理员直接跳回首页（API 侧另有 403 兜底）。
async function loadViewer() {
  try {
    var res = await fetch('/api/auth/me');
    if (!res.ok) {
      location.href = '/login';
      return false;
    }
    var data = await res.json();
    if (data.isAdmin !== true) {
      location.href = '/';
      return false;
    }
    currentUsername = data.username;
    $('#account-name')
      .text(data.username)
      .attr('href', '/u/' + encodeURIComponent(data.username));
    return true;
  } catch (e) {
    return false;
  }
}

$('#back-home-btn').on('click', function () {
  location.href = '/';
});

/* ---------- 用户管理 ---------- */

function roleLabel(user) {
  if (user.isSuperAdmin) {
    return '超级管理员';
  }
  if (user.isAdmin) {
    return '管理员';
  }
  return '用户';
}

function banStatusLabel(user) {
  if (user.bannedUntil === -1) {
    return '已永久封禁';
  }
  if (typeof user.bannedUntil === 'number') {
    return '封禁至 ' + fullTime(user.bannedUntil);
  }
  return '正常';
}

// 判断当前操作者能否封禁该用户（服务端另有同等校验）。
function canBan(user) {
  if (user.username === currentUsername || user.isSuperAdmin) {
    return false;
  }
  if (user.isAdmin && !viewerIsSuperAdmin) {
    return false;
  }
  return true;
}

function renderUsers() {
  var $body = $('#users-body').empty();
  $('#users-empty').toggle(usersCache.length === 0);
  usersCache.forEach(function (user) {
    var $tr = $('<tr></tr>');
    if (typeof user.bannedUntil === 'number') {
      $tr.addClass('row-banned');
    }

    var $name = $('<td></td>');
    $('<a></a>')
      .attr('href', '/u/' + encodeURIComponent(user.username))
      .addClass(user.colorClass || 'rt-unrated')
      .text(user.username)
      .appendTo($name);
    $tr.append($name);

    $('<td></td>').text(Math.round(user.rating)).appendTo($tr);
    $('<td></td>').text(fullTime(user.createdAt)).appendTo($tr);
    $('<td></td>')
      .text(user.lastSeenAt ? relativeTime(user.lastSeenAt) : '-')
      .attr('title', user.lastSeenAt ? fullTime(user.lastSeenAt) : '')
      .appendTo($tr);
    $('<td></td>')
      .append($('<span class="role-badge"></span>').addClass(roleClass(user)).text(roleLabel(user)))
      .appendTo($tr);
    $('<td></td>').text(banStatusLabel(user)).appendTo($tr);

    var $ops = $('<td class="op-cell"></td>');
    if (!user.isSuperAdmin && user.username !== currentUsername) {
      if (typeof user.bannedUntil === 'number') {
        $('<button type="button" class="btn btn-secondary btn-sm">解除封禁</button>')
          .on('click', function () {
            unbanUser(user.username);
          })
          .appendTo($ops);
      } else if (canBan(user)) {
        $('<button type="button" class="btn btn-danger btn-sm">封禁</button>')
          .on('click', function () {
            openBanDialog(user.username);
          })
          .appendTo($ops);
      }
      if (viewerIsSuperAdmin) {
        var granting = !user.isAdmin;
        $('<button type="button" class="btn btn-ghost btn-sm"></button>')
          .text(granting ? '授予管理员' : '撤销管理员')
          .on('click', function () {
            setAdmin(user.username, granting);
          })
          .appendTo($ops);
      }
    }
    $tr.append($ops);

    $body.append($tr);
  });
}

function roleClass(user) {
  if (user.isSuperAdmin) {
    return 'role-superadmin';
  }
  if (user.isAdmin) {
    return 'role-admin';
  }
  return 'role-user';
}

async function loadUsers() {
  try {
    var res = await fetch('/api/admin/users');
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) {
        location.href = '/';
      }
      return;
    }
    var data = await res.json();
    viewerIsSuperAdmin = data.viewerIsSuperAdmin === true;
    usersCache = Array.isArray(data.items) ? data.items : [];
    renderUsers();
  } catch (e) {
    // 加载失败不阻塞页面
  }
}

async function unbanUser(username) {
  if (!confirm('确定解除对 ' + username + ' 的封禁吗？')) {
    return;
  }
  try {
    await apiPost('/api/admin/unban', { username: username });
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

async function setAdmin(username, granting) {
  var action = granting ? '授予' : '撤销';
  if (!confirm('确定' + action + ' ' + username + ' 的管理员权限吗？')) {
    return;
  }
  try {
    await apiPost('/api/admin/set-admin', { username: username, admin: granting });
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- 封禁对话框 ---------- */

function openBanDialog(username) {
  $('#ban-target').text(username);
  $('#ban-duration').val('3600000');
  $('#ban-custom-field').hide();
  $('#ban-error').hide();
  $('#ban-dialog-mask').css('display', 'flex');
}

function closeBanDialog() {
  $('#ban-dialog-mask').hide();
}

$('#ban-duration').on('change', function () {
  $('#ban-custom-field').toggle($(this).val() === 'custom');
});

$('#ban-cancel').on('click', closeBanDialog);

$('#ban-confirm').on('click', async function () {
  var username = $('#ban-target').text();
  var choice = $('#ban-duration').val();
  var payload = { username: username };
  if (choice === 'permanent') {
    payload.permanent = true;
  } else if (choice === 'custom') {
    var hours = Number($('#ban-custom-hours').val());
    if (!Number.isFinite(hours) || hours <= 0) {
      $('#ban-error').text('请输入有效的自定义时长。').show();
      return;
    }
    payload.durationMs = Math.floor(hours * 3600000);
  } else {
    payload.durationMs = Number(choice);
  }
  try {
    await apiPost('/api/admin/ban', payload);
    closeBanDialog();
    loadUsers();
  } catch (err) {
    $('#ban-error').text(err.message).show();
  }
});

/* ---------- 策略 Bot（仅超级管理员） ---------- */

var botsCache = [];

function showBotError(message) {
  $('#bot-error').text(message).toggle(Boolean(message));
}

function renderBots() {
  var $body = $('#bots-body').empty();
  $('#bots-empty').toggle(botsCache.length === 0);
  botsCache.forEach(function (bot) {
    var $tr = $('<tr></tr>');
    $('<td></td>').text(bot.username).appendTo($tr);
    $('<td></td>').text(bot.room).appendTo($tr);
    $('<td></td>').text(fullTime(bot.startedAt)).appendTo($tr);
    $('<td></td>')
      .append(
        $('<span class="bot-conn"></span>')
          .addClass(bot.connected ? 'on' : 'off')
          .text(bot.connected ? '已连接' : '未连接'),
      )
      .appendTo($tr);
    var $ops = $('<td class="op-cell"></td>');
    $('<button type="button" class="btn btn-danger btn-sm">停止</button>')
      .on('click', function () {
        stopBot(bot);
      })
      .appendTo($ops);
    $tr.append($ops);
    $body.append($tr);
  });
}

async function loadBots() {
  try {
    var res = await fetch('/api/admin/bots');
    if (!res.ok) {
      return;
    }
    var data = await res.json();
    botsCache = Array.isArray(data.items) ? data.items : [];
    renderBots();
  } catch (e) {
    // 加载失败不阻塞页面
  }
}

async function startBot() {
  var username = $('#bot-username').val().trim();
  var room = $('#bot-room').val().trim();
  if (!username || !room) {
    showBotError('请填写用户名与房间号。');
    return;
  }
  try {
    await apiPost('/api/admin/bots/start', { username: username, room: room });
    showBotError('');
    $('#bot-room').val('');
    loadBots();
  } catch (err) {
    showBotError(err.message);
  }
}

async function stopBot(bot) {
  if (!confirm('确定停止 ' + bot.username + '（房间 ' + bot.room + '）的策略 Bot 吗？')) {
    return;
  }
  try {
    await apiPost('/api/admin/bots/stop', { id: bot.id });
    loadBots();
  } catch (err) {
    alert(err.message);
  }
}

$('#bot-start-btn').on('click', startBot);
$('#bots-refresh-btn').on('click', loadBots);

/* ---------- 初始化 ---------- */

loadViewer().then(function (ok) {
  if (ok) {
    loadUsers().then(function () {
      // viewerIsSuperAdmin 由 loadUsers 填充；超管才展示策略 Bot 分区。
      if (viewerIsSuperAdmin) {
        $('#bots-card').show();
        loadBots();
      }
    });
  }
});
