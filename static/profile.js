/* 个人主页 /u/:username 逻辑（jQuery）。 */

var currentUsername = '';
var profileUsername = '';

/* ---------- 基础工具 ---------- */

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function relativeTime(time) {
  var diff = Date.now() - time;
  if (diff < 0) {
    diff = 0;
  }
  var sec = Math.floor(diff / 1000);
  if (sec < 10) {
    return '刚刚';
  }
  if (sec < 60) {
    return sec + ' 秒前';
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
  var d = new Date(time);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
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

// 回放时间为 Unix 秒，按 UTC+8 展示（沿用旧回放页习惯）。
function replayTime(timeSec) {
  var d = new Date((timeSec + 8 * 3600) * 1000);
  return d.toJSON().substr(0, 19).replace('T', ' ');
}

// 带 rating 颜色的用户名链接；用户名一律走文本插入防 XSS。
function userLink(username, colorClass, title) {
  var $a = $('<a></a>')
    .attr('href', '/u/' + encodeURIComponent(username))
    .addClass(colorClass || 'rt-unrated')
    .text(username);
  if (title) {
    $a.attr('title', title);
  }
  return $a;
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
    err.retryAfter = data && data.retryAfter;
    throw err;
  }
  return data;
}

/* ---------- 顶部 chrome ---------- */

async function loadViewer() {
  try {
    var res = await fetch('/api/auth/me');
    if (!res.ok) {
      location.href = '/login';
      return false;
    }
    var data = await res.json();
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

/* ---------- 用户信息 ---------- */

async function loadProfile() {
  var res = await fetch('/api/profile/' + encodeURIComponent(profileUsername));
  if (res.status === 404) {
    $('#profile-not-found').show();
    return false;
  }
  if (!res.ok) {
    $('#profile-not-found .panel-empty').text('加载失败，请稍后再试。');
    $('#profile-not-found').show();
    return false;
  }
  var p = await res.json();
  profileUsername = p.username;
  document.title = 'Roka - ' + p.username;
  $('#p-name')
    .text(p.username)
    .addClass(p.colorClass || 'rt-unrated');
  $('#p-title').text(p.title || '');
  $('#p-rating').text(Math.round(p.rating));
  $('#p-games').text(p.ratingGames);
  $('#p-days').text(p.registeredDays);
  $('#p-admin').toggle(p.isAdmin === true);
  $('#profile-main').show();
  renderRatingChart(p.ratingHistory || []);
  return true;
}

/* ---------- Rating 历史折线图（纯 SVG） ---------- */

function renderRatingChart(history) {
  var $box = $('#rating-chart');
  $box.empty();
  if (!Array.isArray(history) || history.length === 0) {
    $('#rating-chart-empty').show();
    return;
  }
  $('#rating-chart-empty').hide();

  var W = 720;
  var H = 260;
  var padL = 48;
  var padR = 16;
  var padT = 16;
  var padB = 14;
  var plotW = W - padL - padR;
  var plotH = H - padT - padB;

  var points = history
    .filter(function (p) {
      return Number.isFinite(p.t) && Number.isFinite(p.r);
    })
    .sort(function (a, b) {
      return a.t - b.t;
    });
  if (points.length === 0) {
    $('#rating-chart-empty').show();
    return;
  }

  var tMin = points[0].t;
  var tMax = points[points.length - 1].t;
  var rMin = Math.min.apply(
    null,
    points.map(function (p) {
      return p.r;
    }),
  );
  var rMax = Math.max.apply(
    null,
    points.map(function (p) {
      return p.r;
    }),
  );
  if (tMax === tMin) {
    tMax = tMin + 1;
  }
  if (rMax === rMin) {
    rMin -= 10;
    rMax += 10;
  }
  // 纵轴留一点边距。
  var rPad = (rMax - rMin) * 0.08;
  rMin -= rPad;
  rMax += rPad;

  function x(t) {
    return padL + ((t - tMin) / (tMax - tMin)) * plotW;
  }
  function y(r) {
    return padT + (1 - (r - rMin) / (rMax - rMin)) * plotH;
  }

  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('class', 'rating-chart-svg');

  function el(name, attrs, text) {
    var node = document.createElementNS(ns, name);
    for (var k in attrs) {
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    svg.appendChild(node);
    return node;
  }

  // 横向网格 + 纵轴刻度（4 档）
  var i;
  for (i = 0; i <= 4; i++) {
    var r = rMin + ((rMax - rMin) * i) / 4;
    var yy = y(r);
    el('line', {
      x1: padL,
      y1: yy,
      x2: W - padR,
      y2: yy,
      stroke: '#eef1f6',
      'stroke-width': 1,
    });
    el(
      'text',
      {
        x: padL - 8,
        y: yy + 4,
        'text-anchor': 'end',
        'font-size': 11,
        fill: '#9aa4b2',
      },
      String(Math.round(r)),
    );
  }

  // 横轴为时间轴，但不绘制日期刻度文字（过于密集），只保留折线本身。

  // 坐标轴线
  el('line', { x1: padL, y1: padT, x2: padL, y2: H - padB, stroke: '#d5dce6', 'stroke-width': 1 });
  el('line', {
    x1: padL,
    y1: H - padB,
    x2: W - padR,
    y2: H - padB,
    stroke: '#d5dce6',
    'stroke-width': 1,
  });

  // 折线
  var path = points
    .map(function (p, idx2) {
      return (idx2 === 0 ? 'M' : 'L') + x(p.t).toFixed(2) + ' ' + y(p.r).toFixed(2);
    })
    .join(' ');
  el('path', {
    d: path,
    fill: 'none',
    stroke: 'teal',
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  });

  // 数据点
  points.forEach(function (p) {
    var c = el('circle', {
      cx: x(p.t),
      cy: y(p.r),
      r: 3,
      fill: '#ffffff',
      stroke: 'teal',
      'stroke-width': 1.5,
    });
    var title = document.createElementNS(ns, 'title');
    title.textContent = Math.round(p.r) + ' · ' + fullTime(p.t);
    c.appendChild(title);
  });

  $box.append(svg);
}

/* ---------- 动态（复用首页渲染逻辑） ---------- */

var FEED_LIMIT = 10;
var feedPage = 1;
var feedPages = 1;
var feedLoading = false;

function commentButtonText(count) {
  return count > 0 ? '评论 ' + count : '评论';
}

function createCommentElement(comment) {
  var $item = $('<div class="comment-item"></div>');
  var $author = $('<a class="comment-author"></a>')
    .attr('href', '/u/' + encodeURIComponent(comment.author))
    .text(comment.author);
  if (comment.authorInfo && comment.authorInfo.colorClass) {
    $author.addClass(comment.authorInfo.colorClass);
  }
  $item.append($author);
  // html 字段由服务端渲染并消毒；新评论响应没有 html 字段时退化为纯文本。
  var $text = $('<span class="comment-text"></span>');
  if (comment.html) {
    $text.html(comment.html);
  } else {
    $text.text(comment.text).css('white-space', 'pre-wrap');
  }
  $item.append($text);
  $('<span class="comment-time"></span>')
    .text(relativeTime(comment.time))
    .attr('title', fullTime(comment.time))
    .appendTo($item);
  return $item;
}

function createPostElement(post) {
  var $item = $('<div class="feed-item"></div>').attr('data-id', post.id);
  // 原始 text 缓存在元素上，供内联编辑回填。
  $item.data('raw-text', post.text);

  var $head = $('<div class="feed-item-head"></div>');
  var $author = userLink(
    post.author,
    post.authorInfo && post.authorInfo.colorClass,
    post.authorInfo && post.authorInfo.title,
  );
  $author.addClass('feed-author').appendTo($head);
  $('<span class="feed-time"></span>')
    .text(relativeTime(post.time))
    .attr('title', fullTime(post.time))
    .appendTo($head);
  $head.appendTo($item);

  var $wrap = $('<div class="feed-body-wrap"></div>');
  // html 字段由服务端渲染并消毒，可直接注入。
  $('<div class="feed-text"></div>').html(post.html).appendTo($wrap);
  $wrap.appendTo($item);

  var $actions = $('<div class="feed-actions"></div>');
  var $likeBtn = $('<button type="button" class="like-btn"></button>');
  $likeBtn.toggleClass('liked', post.likes.indexOf(currentUsername) !== -1);
  $('<span class="heart"></span>')
    // 自定义 SVG 爱心，避免 ♥ 字符在不同设备上渲染不一致（有的平台会变成 emoji）。
    .html(
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    )
    .appendTo($likeBtn);
  $('<span class="like-count"></span>').text(post.likes.length).appendTo($likeBtn);
  $likeBtn.appendTo($actions);
  $('<button type="button" class="comment-toggle"></button>')
    .text(commentButtonText(post.comments.length))
    .appendTo($actions);
  if (post.canManage) {
    $('<button type="button" class="feed-edit-btn"></button>').text('编辑').appendTo($actions);
    $('<button type="button" class="feed-delete-btn"></button>').text('删除').appendTo($actions);
  }
  $actions.appendTo($item);

  var $comments = $('<div class="comment-section"></div>').hide();
  var $commentList = $('<div class="comment-list"></div>');
  post.comments.forEach(function (comment) {
    $commentList.append(createCommentElement(comment));
  });
  $commentList.appendTo($comments);
  var $inputRow = $('<div class="comment-input-row"></div>');
  $('<input type="text" class="comment-input" maxlength="200" placeholder="写下你的评论…" />').appendTo(
    $inputRow,
  );
  $('<button type="button" class="btn btn-primary btn-sm comment-send">回复</button>').appendTo($inputRow);
  $inputRow.appendTo($comments);
  $comments.appendTo($item);

  return $item;
}

// 长说说折叠：渲染后高度超过 220px 的加渐变遮罩并显示「展开」按钮。
function applyCollapse($item) {
  var $wrap = $item.find('.feed-body-wrap');
  var textEl = $wrap.find('.feed-text')[0];
  if (!textEl || textEl.scrollHeight <= 220) {
    return;
  }
  $wrap.addClass('collapsed');
  var $btn = $('<button type="button" class="feed-expand-btn">展开</button>');
  $btn.on('click', function () {
    var collapsed = $wrap.toggleClass('collapsed').hasClass('collapsed');
    $btn.text(collapsed ? '展开' : '收起');
  });
  $wrap.after($btn);
}

function renderFeedPage(data) {
  var $list = $('#feed-list');
  $list.empty();
  var items = Array.isArray(data.items) ? data.items : [];
  items.forEach(function (post) {
    var $item = createPostElement(post);
    $list.append($item);
    applyCollapse($item);
  });
  $('#feed-empty').toggle(items.length === 0);
  feedPage = data.page;
  feedPages = data.pages;
  renderFeedPager();
}

function renderFeedPager() {
  var $pager = $('#feed-pager');
  $pager.empty();
  if (feedPages <= 1 && feedPage <= 1) {
    $pager.hide();
    return;
  }
  $pager.show();
  var $prev = $('<button type="button">上一页</button>')
    .prop('disabled', feedPage <= 1)
    .on('click', function () {
      loadFeeds(feedPage - 1);
    });
  $pager.append($prev);

  var pages = [];
  var i;
  for (i = 1; i <= feedPages; i++) {
    if (i === 1 || i === feedPages || Math.abs(i - feedPage) <= 2) {
      pages.push(i);
    }
  }
  var last = 0;
  pages.forEach(function (p) {
    if (last && p - last > 1) {
      $pager.append($('<span class="pager-ellipsis">…</span>'));
    }
    var $btn = $('<button type="button"></button>')
      .text(p)
      .toggleClass('current', p === feedPage);
    if (p !== feedPage) {
      $btn.on('click', function () {
        loadFeeds(p);
      });
    }
    $pager.append($btn);
    last = p;
  });

  var $next = $('<button type="button">下一页</button>')
    .prop('disabled', feedPage >= feedPages)
    .on('click', function () {
      loadFeeds(feedPage + 1);
    });
  $pager.append($next);
}

async function loadFeeds(page) {
  if (feedLoading) {
    return;
  }
  feedLoading = true;
  try {
    var res = await fetch(
      '/api/profile/' + encodeURIComponent(profileUsername) + '/feeds?page=' + page + '&limit=' + FEED_LIMIT,
    );
    if (!res.ok) {
      throw new Error('动态加载失败，请稍后再试。');
    }
    var data = await res.json();
    renderFeedPage(data);
  } catch (err) {
    alert(err.message);
  } finally {
    feedLoading = false;
  }
}

$('#feed-list')
  .on('click', '.like-btn', async function () {
    var $btn = $(this);
    if ($btn.data('busy')) {
      return;
    }
    $btn.data('busy', true);
    try {
      var data = await apiPost('/api/feeds/like', {
        id: $btn.closest('.feed-item').attr('data-id'),
      });
      $btn.toggleClass('liked', data.liked);
      $btn.find('.like-count').text(data.likes);
    } catch (err) {
      alert(err.message);
    } finally {
      $btn.data('busy', false);
    }
  })
  .on('click', '.comment-toggle', function () {
    $(this).closest('.feed-item').find('.comment-section').toggle();
  })
  .on('click', '.comment-send', function () {
    sendComment($(this).closest('.feed-item'));
  })
  .on('keypress', '.comment-input', function (e) {
    if (e.keyCode == 13) {
      sendComment($(this).closest('.feed-item'));
    }
  })
  .on('click', '.feed-edit-btn', function () {
    startEdit($(this).closest('.feed-item'));
  })
  .on('click', '.feed-delete-btn', async function () {
    var $item = $(this).closest('.feed-item');
    if (!confirm('确定删除这条动态吗？')) {
      return;
    }
    try {
      await apiPost('/api/feeds/delete', { id: $item.attr('data-id') });
      if ($('#feed-list .feed-item').length <= 1 && feedPage > 1) {
        loadFeeds(feedPage - 1);
      } else {
        loadFeeds(feedPage);
      }
    } catch (err) {
      alert(err.message);
    }
  });

async function sendComment($item) {
  var $input = $item.find('.comment-input');
  var text = $input.val().trim();
  if (!text) {
    return;
  }
  try {
    var data = await apiPost('/api/feeds/comment', {
      id: $item.attr('data-id'),
      text: text,
    });
    $item.find('.comment-list').append(createCommentElement(data.comment));
    $input.val('');
    var count = $item.find('.comment-item').length;
    $item.find('.comment-toggle').text(commentButtonText(count));
  } catch (err) {
    alert(err.message);
  }
}

function startEdit($item) {
  if ($item.find('.feed-edit').length > 0) {
    return;
  }
  var id = $item.attr('data-id');
  var original = $item.data('raw-text') || '';
  var $edit = $('<div class="feed-edit"></div>');
  var $textarea = $('<textarea maxlength="300"></textarea>').val(original).appendTo($edit);
  var $actions = $('<div class="feed-edit-actions"></div>');
  $('<button type="button" class="btn btn-primary btn-sm">保存</button>')
    .on('click', async function () {
      var text = $textarea.val().trim();
      if (!text) {
        alert('内容不能为空。');
        return;
      }
      try {
        await apiPost('/api/feeds/edit', { id: id, text: text });
        loadFeeds(feedPage);
      } catch (err) {
        alert(err.message);
      }
    })
    .appendTo($actions);
  $('<button type="button" class="btn btn-ghost btn-sm">取消</button>')
    .on('click', function () {
      $edit.remove();
      $item.find('.feed-body-wrap, .feed-expand-btn, .feed-actions').show();
    })
    .appendTo($actions);
  $edit.append($actions);
  $item.find('.feed-body-wrap, .feed-expand-btn, .feed-actions').hide();
  $item.find('.comment-section').before($edit);
  $textarea.trigger('focus');
}

/* ---------- 他的回放 ---------- */

var REPLAYS_LIMIT = 10;
var replaysOffset = 0;

async function loadReplays(offset) {
  try {
    var res = await fetch(
      '/api/profile/' +
        encodeURIComponent(profileUsername) +
        '/replays?offset=' +
        offset +
        '&limit=' +
        REPLAYS_LIMIT,
    );
    if (!res.ok) {
      return;
    }
    var data = await res.json();
    var items = Array.isArray(data.items) ? data.items : [];
    replaysOffset = offset;
    var $body = $('#replays-body');
    $body.empty();
    $('#replays-empty').toggle(items.length === 0);
    items.forEach(function (item) {
      var $tr = $('<tr></tr>').on('click', function () {
        location.href = '/replays/' + encodeURIComponent(item.id);
      });
      $('<td></td>').text(replayTime(item.time)).appendTo($tr);
      $('<td></td>').text(item.turn).appendTo($tr);
      $('<td></td>')
        .text((item.rank || []).join(' › '))
        .appendTo($tr);
      $body.append($tr);
    });
    $('#replays-prev').prop('disabled', offset <= 0);
    $('#replays-next').prop('disabled', !data.has_more);
  } catch (e) {
    // 忽略加载失败
  }
}

$('#replays-prev').on('click', function () {
  loadReplays(Math.max(0, replaysOffset - REPLAYS_LIMIT));
});
$('#replays-next').on('click', function () {
  loadReplays(replaysOffset + REPLAYS_LIMIT);
});

/* ---------- 启动 ---------- */

// 用户名从 /u/:username 路径解析。
var match = location.pathname.match(/^\/u\/([^/]+)\/?$/);
if (match) {
  profileUsername = decodeURIComponent(match[1]);
}

if (!profileUsername) {
  $('#profile-not-found').show();
} else {
  loadViewer().then(function (loggedIn) {
    if (!loggedIn) {
      return;
    }
    loadProfile().then(function (ok) {
      if (!ok) {
        return;
      }
      loadFeeds(1);
      loadReplays(0);
    });
  });
}
