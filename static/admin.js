/* 后台管理页 /admin 逻辑（jQuery）。 */

var currentUsername = '';
var viewerIsSuperAdmin = false;
var usersCache = [];
var USER_PAGE_SIZE = 20;
var userSearchQuery = '';
var userPage = 1;
var currentAdminTab = 'dashboard';
var securityEventsCache = [];
var securityLoaded = false;
var chatLoaded = false;
var usersLoaded = false;
var botsLoaded = false;
var ADMIN_TABS = ['dashboard', 'users', 'security', 'chat', 'bots'];
var SECURITY_EVENT_LABELS = {
  username_rejected: '违规用户名拦截',
  username_auto_banned: '用户名自动封禁',
  username_manual_review: '超管人工复核',
  possible_ban_evasion: '可能绕封关联',
  registration_rate_limited: '批量注册拦截',
  username_scan_completed: '全量扫描完成',
};

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
  var diff = Math.max(0, Date.now() - time);
  var sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟前';
  var hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  var day = Math.floor(hour / 24);
  if (day < 30) return day + ' 天前';
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

function securityEventLabel(type) {
  return SECURITY_EVENT_LABELS[type] || type;
}

function scanResultText(result) {
  if (!result) return '最近一次全量扫描：尚未执行';
  return (
    '最近完成 ' +
    fullTime(result.completedAt) +
    '；扫描 ' +
    result.scanned +
    '，命中 ' +
    result.hits +
    '，自动封禁 ' +
    result.autoBanned +
    '，跳过 ' +
    result.skipped
  );
}

/* ---------- 标签页 ---------- */

function tabPanel(name) {
  return $('#' + (name === 'chat' ? 'chat-audit' : name === 'bots' ? 'bots-card' : 'panel-' + name));
}

function showAdminTab(name, loadData) {
  if (ADMIN_TABS.indexOf(name) === -1 || (name === 'bots' && !viewerIsSuperAdmin)) name = 'dashboard';
  currentAdminTab = name;
  ADMIN_TABS.forEach(function (tab) {
    var selected = tab === name;
    $('#tab-' + tab)
      .attr('aria-selected', selected ? 'true' : 'false')
      .attr('tabindex', selected ? 0 : -1);
    var $panel = tabPanel(tab);
    if (tab === 'bots') {
      $panel.toggle(viewerIsSuperAdmin && selected);
    } else {
      $panel.prop('hidden', !selected);
    }
  });
  if (!loadData) return;
  if (name === 'dashboard') loadDashboard();
  if (name === 'users') loadUsers();
  if (name === 'security') loadSecurityEvents(false);
  if (name === 'chat' && !chatLoaded) loadChatAudit(false);
  if (name === 'bots' && viewerIsSuperAdmin) {
    if (!botsLoaded) {
      loadBotTemplates();
      loadBots();
    }
  }
}

function navigateAdminTab(name) {
  if (location.hash === '#' + name) showAdminTab(name, true);
  else location.hash = name;
}

$('.admin-tab').on('click', function (event) {
  event.preventDefault();
  navigateAdminTab($(this).attr('href').slice(1));
});

$('.admin-tabs').on('keydown', '.admin-tab', function (event) {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) === -1) return;
  event.preventDefault();
  var available = ADMIN_TABS.filter(function (name) {
    return name !== 'bots' || viewerIsSuperAdmin;
  });
  var current = available.indexOf(currentAdminTab);
  var next = current;
  if (event.key === 'ArrowLeft') next = (current - 1 + available.length) % available.length;
  if (event.key === 'ArrowRight') next = (current + 1) % available.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = available.length - 1;
  navigateAdminTab(available[next]);
  $('#tab-' + available[next]).focus();
});

window.addEventListener('hashchange', function () {
  showAdminTab(location.hash.slice(1), true);
});

/* ---------- 顶部与仪表盘 ---------- */

async function loadViewer() {
  try {
    var res = await fetch('/api/auth/me', { cache: 'no-store' });
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
    viewerIsSuperAdmin = data.isSuperAdmin === true;
    $('#tab-bots').toggle(viewerIsSuperAdmin);
    $('#account-name').replaceWith(usernameLink(currentUsername));
    usernameEnsureColors([currentUsername]);
    return true;
  } catch (e) {
    return false;
  }
}

$('#back-home-btn').on('click', function () {
  location.href = '/';
});

async function loadDashboard() {
  try {
    var res = await fetch('/api/admin/security/dashboard', { cache: 'no-store' });
    if (!res.ok) throw new Error('仪表盘加载失败或无权限。');
    var data = await res.json();
    var summary = data.summary || {};
    var fields = {
      totalUsers: '#metric-total-users',
      activeBans: '#metric-active-bans',
      registrationsToday: '#metric-registrations-today',
      registrations7Days: '#metric-registrations-7-days',
      registrationBlocks24Hours: '#metric-registration-blocks',
      usernameAutoBans: '#metric-username-auto-bans',
      pendingBanEvasions: '#metric-pending-evasions',
    };
    Object.keys(fields).forEach(function (key) {
      $(fields[key]).text(typeof summary[key] === 'number' ? summary[key] : 0);
    });
    $('#dashboard-last-scan').text(scanResultText(data.lastScan));
    var events = Array.isArray(data.recentEvents) ? data.recentEvents : [];
    var $body = $('#dashboard-events-body').empty();
    events.forEach(function (entry) {
      var $row = $('<tr></tr>').appendTo($body);
      $('<td></td>').text(fullTime(entry.at)).appendTo($row);
      $('<td></td>').text(securityEventLabel(entry.type)).appendTo($row);
      $('<td></td>')
        .text((entry.username || '-') + ' / ' + (entry.ip || '-'))
        .appendTo($row);
      $('<td></td>')
        .text(entry.action + '：' + entry.reason)
        .appendTo($row);
    });
    $('#dashboard-events-empty').toggle(events.length === 0);
  } catch (err) {
    $('#dashboard-last-scan').text(err.message);
  }
}

/* ---------- 用户管理 ---------- */

function roleLabel(user) {
  if (user.isSuperAdmin) return '超级管理员';
  if (user.isAdmin) return '管理员';
  return '用户';
}

function roleClass(user) {
  if (user.isSuperAdmin) return 'role-superadmin';
  if (user.isAdmin) return 'role-admin';
  return 'role-user';
}

function banStatusLabel(user) {
  var ban = user.ban;
  if (typeof user.bannedUntil === 'number') {
    var label = user.bannedUntil === -1 ? '永久封禁' : '封禁至 ' + fullTime(user.bannedUntil);
    if (ban) {
      label += '｜' + ban.type + '｜' + ban.reason;
      label += '｜起 ' + fullTime(ban.startedAt) + '｜触发 ' + fullTime(ban.triggeredAt);
      if (ban.evidence) label += '｜' + ban.evidence;
    }
    return label;
  }
  return '正常';
}

function canBan(user) {
  if (user.username === currentUsername || user.isSuperAdmin) return false;
  if (user.isAdmin && !viewerIsSuperAdmin) return false;
  return true;
}

function userIpValues(user) {
  return [user.registeredIp, user.lastIp]
    .concat(
      (user.ipHistory || []).map(function (item) {
        return item.ip;
      }),
    )
    .filter(Boolean);
}

function filteredUsers() {
  if (!userSearchQuery) return usersCache;
  var query = userSearchQuery.toLowerCase();
  return usersCache.filter(function (user) {
    return (
      user.username.toLowerCase().indexOf(query) !== -1 ||
      userIpValues(user).some(function (ip) {
        return ip.toLowerCase().indexOf(query) !== -1;
      })
    );
  });
}

function renderUsers() {
  var filtered = filteredUsers();
  var pageCount = Math.max(1, Math.ceil(filtered.length / USER_PAGE_SIZE));
  if (userPage > pageCount) userPage = pageCount;
  var pageItems = filtered.slice((userPage - 1) * USER_PAGE_SIZE, userPage * USER_PAGE_SIZE);
  var totalText = '共 ' + usersCache.length + ' 个用户';
  if (userSearchQuery) totalText += '，匹配 ' + filtered.length + ' 个';
  $('#users-total').text(totalText);
  $('#users-empty')
    .text(userSearchQuery ? '没有匹配的用户或 IP。' : '暂无用户。')
    .toggle(pageItems.length === 0);
  $('#users-pagination').toggle(pageCount > 1);
  $('#users-page-info').text('第 ' + userPage + ' / ' + pageCount + ' 页');
  $('#users-prev').prop('disabled', userPage <= 1);
  $('#users-next').prop('disabled', userPage >= pageCount);

  var $body = $('#users-body').empty();
  pageItems.forEach(function (user) {
    var $tr = $('<tr></tr>');
    if (typeof user.bannedUntil === 'number') $tr.addClass('row-banned');
    var $name = $('<td data-label="用户名"></td>').appendTo($tr);
    usernameLink(user.username, {
      colorClass: user.colorClass,
      title: user.title,
      admin: user.admin === true,
      banned: user.banned === true,
    }).appendTo($name);
    $('<td data-label="Rating"></td>').text(Math.round(user.rating)).appendTo($tr);
    $('<td data-label="注册时间"></td>').text(fullTime(user.createdAt)).appendTo($tr);
    $('<td data-label="注册 IP"></td>')
      .text(user.registeredIp || '尚未记录')
      .appendTo($tr);
    $('<td data-label="最近 IP / 时间"></td>')
      .text(
        user.lastIp
          ? user.lastIp + ' / ' + (user.lastIpAt ? fullTime(user.lastIpAt) : '尚未记录')
          : '尚未记录',
      )
      .appendTo($tr);
    $('<td data-label="最后在线"></td>')
      .text(user.lastSeenAt ? relativeTime(user.lastSeenAt) : '-')
      .attr('title', user.lastSeenAt ? fullTime(user.lastSeenAt) : '')
      .appendTo($tr);
    $('<td data-label="角色"></td>')
      .append($('<span class="role-badge"></span>').addClass(roleClass(user)).text(roleLabel(user)))
      .appendTo($tr);
    $('<td data-label="封禁详情"></td>').text(banStatusLabel(user)).appendTo($tr);
    var $ops = $('<td class="op-cell" data-label="操作"></td>').appendTo($tr);
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
    $body.append($tr);
  });
}

async function loadUsers() {
  try {
    var res = await fetch('/api/admin/users', { cache: 'no-store' });
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) location.href = '/';
      return;
    }
    var data = await res.json();
    viewerIsSuperAdmin = data.viewerIsSuperAdmin === true;
    $('#tab-bots').toggle(viewerIsSuperAdmin);
    usersCache = Array.isArray(data.items) ? data.items : [];
    usersLoaded = true;
    renderUsers();
  } catch (e) {
    // 加载失败不阻塞其他标签
  }
}

$('#user-search').on('input', function () {
  userSearchQuery = $(this).val().trim();
  userPage = 1;
  renderUsers();
});

$('#users-prev').on('click', function () {
  if (userPage > 1) {
    userPage--;
    renderUsers();
  }
});

$('#users-next').on('click', function () {
  userPage++;
  renderUsers();
});

async function unbanUser(username) {
  if (!confirm('确定解除对 ' + username + ' 的封禁吗？')) return;
  try {
    await apiPost('/api/admin/unban', { username: username });
    loadUsers();
    loadDashboard();
  } catch (err) {
    alert(err.message);
  }
}

async function setAdmin(username, granting) {
  var action = granting ? '授予' : '撤销';
  if (!confirm('确定' + action + ' ' + username + ' 的管理员权限吗？')) return;
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
  $('#ban-reason').val('管理员手动封禁');
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
  var payload = { username: username, reason: $('#ban-reason').val() };
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
    loadDashboard();
  } catch (err) {
    $('#ban-error').text(err.message).show();
  }
});

/* ---------- 用户名与注册安全 ---------- */

function renderSecurityEvents() {
  var $body = $('#security-events-body').empty();
  securityEventsCache.forEach(function (entry) {
    var $row = $('<tr></tr>').appendTo($body);
    $('<td></td>').text(fullTime(entry.at)).appendTo($row);
    $('<td></td>').text(securityEventLabel(entry.type)).appendTo($row);
    $('<td></td>')
      .text(
        (entry.username || '-') +
          (entry.relatedUsernames && entry.relatedUsernames.length
            ? ' ↔ ' + entry.relatedUsernames.join(', ')
            : ''),
      )
      .appendTo($row);
    $('<td></td>')
      .text(entry.ip || '-')
      .appendTo($row);
    $('<td></td>')
      .text(entry.action + '：' + entry.reason + (entry.result ? '；' + scanResultText(entry.result) : ''))
      .appendTo($row);
  });
  $('#security-events-empty').toggle(securityEventsCache.length === 0);

  var $evasions = $('#security-evasions').empty();
  var evasions = securityEventsCache.filter(function (entry) {
    return entry.type === 'possible_ban_evasion';
  });
  if (!evasions.length)
    $('<p class="panel-empty"></p>').text('暂无待复核的同 IP 封禁关联。').appendTo($evasions);
  evasions.forEach(function (entry) {
    var $card = $('<div class="security-record"></div>').appendTo($evasions);
    $('<p></p>')
      .text(fullTime(entry.at) + '；IP ' + entry.ip)
      .appendTo($card);
    var $links = $('<div class="security-record-links"></div>').appendTo($card);
    [entry.username]
      .concat(entry.relatedUsernames || [])
      .filter(Boolean)
      .forEach(function (username) {
        $('<button type="button" class="btn btn-ghost btn-sm"></button>')
          .text(username)
          .on('click', function () {
            $('#user-search').val(username);
            userSearchQuery = username;
            userPage = 1;
            navigateAdminTab('users');
            renderUsers();
          })
          .appendTo($links);
      });
  });

  var $blocks = $('#security-blocks').empty();
  var blocks = securityEventsCache.filter(function (entry) {
    return entry.type === 'registration_rate_limited';
  });
  if (!blocks.length) $('<p class="panel-empty"></p>').text('暂无批量注册拦截。').appendTo($blocks);
  blocks.forEach(function (entry) {
    $('<div class="security-record"></div>')
      .text(fullTime(entry.at) + '；' + entry.ip + '；尝试用户名 ' + entry.username)
      .appendTo($blocks);
  });
}

async function loadSecurityEvents(force) {
  if (securityLoaded && !force) return;
  try {
    var query = new URLSearchParams({
      type: $('#security-type').val(),
      username: $('#security-username').val().trim(),
      ip: $('#security-ip').val().trim(),
    });
    var res = await fetch('/api/admin/security/events?' + query, { cache: 'no-store' });
    if (!res.ok) throw new Error('安全事件加载失败或无权限。');
    var data = await res.json();
    securityEventsCache = Array.isArray(data.items) ? data.items : [];
    securityLoaded = true;
    $('#security-error').text('');
    renderSecurityEvents();
  } catch (err) {
    $('#security-error').text(err.message);
  }
}

$('#security-search').on('click', function () {
  loadSecurityEvents(true);
});

$('#security-scan-btn').on('click', async function () {
  var $button = $('#security-scan-btn').prop('disabled', true);
  $('#security-scan-result').text('正在串行复查全部用户名…');
  try {
    var result = await apiPost('/api/admin/security/scan', {});
    $('#security-scan-result').text(scanResultText(result));
    securityLoaded = false;
    await loadSecurityEvents(true);
    loadDashboard();
  } catch (err) {
    $('#security-scan-result').text(err.message);
  } finally {
    $button.prop('disabled', false);
  }
});

/* ---------- 聊天审计 ---------- */

var chatBefore = null;
async function loadChatAudit(older) {
  if (!older) chatBefore = null;
  var query = new URLSearchParams({
    username: $('#chat-user').val().trim(),
    room: $('#chat-room').val().trim(),
    candidates: $('#chat-candidates').prop('checked') ? '1' : '0',
  });
  if (chatBefore) query.set('before', String(chatBefore));
  try {
    var res = await fetch('/api/admin/chat-audit?' + query, { cache: 'no-store' });
    if (!res.ok) throw new Error('审计查询失败或无权限。');
    var data = await res.json();
    var $body = $('#chat-body').empty();
    data.items.forEach(function (entry) {
      var $tr = $('<tr></tr>').appendTo($body);
      $('<td class="chat-audit-meta" data-label="时间 / 房间 / 对局"></td>')
        .text(fullTime(entry.at) + ' / ' + entry.room + ' / ' + (entry.gameId || '-'))
        .appendTo($tr);
      $('<td class="chat-audit-user" data-label="用户"></td>').text(entry.username).appendTo($tr);
      $('<td class="chat-audit-text" data-label="公开聊天"></td>').text(entry.text).appendTo($tr);
      var $review = $('<td class="chat-audit-review" data-label="复核"></td>').appendTo($tr);
      if (entry.candidateAt) {
        $('<p class="chat-audit-evidence"></p>')
          .text(
            '进房 ' +
              fullTime(entry.joinedAt) +
              '；离开 ' +
              fullTime(entry.candidateAt) +
              '；限聊至 ' +
              fullTime(entry.mutedUntil),
          )
          .appendTo($review);
        if (entry.reviewedAt) {
          $('<p class="chat-audit-reviewed"></p>')
            .text(entry.reviewedBy + ' 已解除 / 复核 ' + fullTime(entry.reviewedAt))
            .appendTo($review);
        } else {
          $('<button type="button" class="btn btn-secondary btn-sm">解除限聊 / 误判</button>')
            .on('click', async function () {
              try {
                await apiPost('/api/admin/chat-release', { username: entry.username });
                loadChatAudit(false);
              } catch (err) {
                $('#chat-error').text(err.message);
              }
            })
            .appendTo($review);
        }
      }
    });
    if (data.items.length) chatBefore = data.items[data.items.length - 1].id;
    $('#chat-older').prop('disabled', data.items.length < 100);
    $('#chat-error').text(
      data.items.length ? '本页 ' + data.items.length + ' 条；请勿外传聊天审计内容。' : '无匹配记录。',
    );
    chatLoaded = true;
  } catch (err) {
    $('#chat-error').text(err.message);
  }
}

$('#chat-release-user').on('click', async function () {
  var username = $('#chat-user').val().trim();
  if (!username) {
    $('#chat-error').text('请先填写精确用户名。');
    return;
  }
  try {
    await apiPost('/api/admin/chat-release', { username: username });
    await loadChatAudit(false);
  } catch (err) {
    $('#chat-error').text(err.message);
  }
});
$('#chat-search').on('click', function () {
  loadChatAudit(false);
});
$('#chat-older').on('click', function () {
  loadChatAudit(true);
});

/* ---------- 策略 Bot（仅超级管理员） ---------- */

var botsCache = [];
var botTemplatesCache = [];

function showBotError(message) {
  $('#bot-error').text(message).toggle(Boolean(message));
}

function renderBotTemplates() {
  var $select = $('#bot-template').empty();
  botTemplatesCache.forEach(function (tpl) {
    $('<option></option>')
      .attr('value', tpl.id)
      .text(tpl.name + (tpl.description ? '（' + tpl.description + '）' : ''))
      .appendTo($select);
  });
  var hasTemplate = botTemplatesCache.length > 0;
  $('#bot-start-btn').prop('disabled', !hasTemplate);
  if (!hasTemplate)
    showBotError('未发现可托管的 Bot 模板（bot-template/ 下缺少 strategy.js 或 server-bot.js）。');
}

async function loadBotTemplates() {
  try {
    var res = await fetch('/api/admin/bot-templates', { cache: 'no-store' });
    if (!res.ok) return;
    var data = await res.json();
    botTemplatesCache = Array.isArray(data.items) ? data.items : [];
    renderBotTemplates();
  } catch (e) {
    // 加载失败不阻塞页面
  }
}

function renderBots() {
  var $body = $('#bots-body').empty();
  $('#bots-empty').toggle(botsCache.length === 0);
  botsCache.forEach(function (bot) {
    var $tr = $('<tr></tr>');
    usernameLink(bot.username).appendTo($('<td data-label="用户名"></td>').appendTo($tr));
    usernameEnsureColors([bot.username]);
    $('<td data-label="房间"></td>').text(bot.room).appendTo($tr);
    $('<td data-label="模板"></td>').text(bot.template).appendTo($tr);
    var inputs = {};
    [
      ['allowTeam', '组队'],
      ['allowFog', '迷雾远征'],
      ['allowMultiLine', '多线争锋'],
    ].forEach(function (item) {
      var key = item[0];
      inputs[key] = $('<input type="checkbox" />')
        .prop('checked', bot[key] === true)
        .attr('aria-label', bot.username + ' 允许' + item[1]);
      $('<td></td>').attr('data-label', item[1]).append(inputs[key]).appendTo($tr);
    });
    $('<td data-label="启动时间"></td>').text(fullTime(bot.startedAt)).appendTo($tr);
    $('<td data-label="连接状态"></td>')
      .append(
        $('<span class="bot-conn"></span>')
          .addClass(bot.connected ? 'on' : 'off')
          .text(bot.connected ? '已连接' : '未连接'),
      )
      .appendTo($tr);
    var $ops = $('<td class="op-cell" data-label="操作"></td>');
    $('<button type="button" class="btn btn-secondary btn-sm">保存配置</button>')
      .on('click', function () {
        updateBot(bot, inputs, $tr);
      })
      .appendTo($ops);
    $('<button type="button" class="btn btn-danger btn-sm">停止</button>')
      .on('click', function () {
        stopBot(bot);
      })
      .appendTo($ops);
    $tr.append($ops);
    $body.append($tr);
  });
}

async function updateBot(bot, inputs, $row) {
  $row.find('input, button').prop('disabled', true);
  try {
    await apiPost('/api/admin/bots/config', {
      id: bot.id,
      allowTeam: inputs.allowTeam.prop('checked'),
      allowFog: inputs.allowFog.prop('checked'),
      allowMultiLine: inputs.allowMultiLine.prop('checked'),
    });
    showBotError('');
    loadBots();
  } catch (err) {
    $row.find('input, button').prop('disabled', false);
    showBotError(err.message);
  }
}

async function loadBots() {
  try {
    var res = await fetch('/api/admin/bots', { cache: 'no-store' });
    if (!res.ok) return;
    var data = await res.json();
    botsCache = Array.isArray(data.items) ? data.items : [];
    botsLoaded = true;
    renderBots();
  } catch (e) {
    // 加载失败不阻塞页面
  }
}

async function startBot() {
  var username = $('#bot-username').val().trim();
  var room = $('#bot-room').val().trim();
  var template = $('#bot-template').val();
  if (!username || !room) {
    showBotError('请填写用户名与房间号。');
    return;
  }
  if (!template) {
    showBotError('请选择 Bot 模板。');
    return;
  }
  try {
    await apiPost('/api/admin/bots/start', {
      username: username,
      room: room,
      template: template,
      allowTeam: $('#bot-allow-team').prop('checked'),
      allowFog: $('#bot-allow-fog').prop('checked'),
      allowMultiLine: $('#bot-allow-multi-line').prop('checked'),
    });
    showBotError('');
    $('#bot-room').val('');
    loadBots();
  } catch (err) {
    showBotError(err.message);
  }
}

async function stopBot(bot) {
  if (!confirm('确定停止 ' + bot.username + '（房间 ' + bot.room + '）的策略 Bot 吗？')) return;
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

showAdminTab(location.hash.slice(1) || 'dashboard', false);
loadViewer().then(function (ok) {
  if (!ok) return;
  showAdminTab(location.hash.slice(1) || 'dashboard', true);
});
