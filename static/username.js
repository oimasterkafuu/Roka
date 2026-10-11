// 全站统一用户名渲染组件：带 rating 颜色（rt-* 色阶，与排行榜同源）的可点击用户名链接。
// 用法：
//   var $a = usernameLink(name, info);   // info 可选 {colorClass, title, admin, banned}；缺省时查全局缓存
//   usernameCacheSeed({name: {colorClass, title, admin, banned}});  // 用接口已有数据喂缓存
//   usernameEnsureColors([name, ...]);   // 批量拉取缺失名字的颜色（/api/user-colors），返回 Promise
// 缓存回填后，已渲染的链接（带 data-username 标记）会自动刷新颜色与 title。
// 有效封禁优先渲染为 rt-banned（棕色正常字重）；未封禁管理员使用 rt-admin
// （黑色加粗）及 Headquarters tooltip；无可见徽标。
// 防注入：DOM 版用 .text()，HTML 版转义用户名。

// 用户名 → {colorClass, title, admin, banned} 全局缓存。
var usernameColorCache = {};
// 进行中的批量请求去重；失效代数防止旧请求覆盖解除封禁后的新数据。
var usernameColorInflight = {};
var usernameColorGeneration = 0;

function usernameColorKey(username) {
  return String(username);
}

// 即使调用方带着旧 rating 信息，有效封禁仍优先于管理员与 rating。
function usernameNormalizeInfo(info) {
  var admin = info.admin === true;
  var banned = info.banned === true;
  return {
    colorClass: banned ? 'rt-banned' : admin ? 'rt-admin' : info.colorClass || 'rt-unrated',
    title: banned ? '已封禁' : admin ? 'Headquarters' : info.title || '',
    admin: admin,
    banned: banned,
  };
}

// 用调用方已有数据（排行榜条目、feed authorInfo、profile 响应等）喂缓存，并刷新已渲染链接。
function usernameCacheSeed(map) {
  if (!map) return;
  var seeded = false;
  for (var name in map) {
    if (!Object.prototype.hasOwnProperty.call(map, name)) continue;
    var info = map[name];
    if (!info || !info.colorClass) continue;
    usernameColorCache[usernameColorKey(name)] = usernameNormalizeInfo(info);
    seeded = true;
  }
  if (seeded && typeof $ != 'undefined' && $.fn) {
    usernameRefreshRendered();
  }
}

// 批量拉取缺失名字的颜色；已有缓存（含确认 unrated）的名字不再请求。
// 返回 Promise，resolve 后缓存已更新且所有带 data-username 的已渲染链接已刷新。
function usernameEnsureColors(names) {
  var missing = [];
  var seen = {};
  for (var i = 0; i < (names || []).length; i++) {
    var key = usernameColorKey(names[i]);
    if (!key || seen[key]) continue;
    seen[key] = true;
    if (!Object.prototype.hasOwnProperty.call(usernameColorCache, key)) {
      missing.push(key);
    }
  }
  if (!missing.length) {
    return Promise.resolve();
  }
  var inflightKey = missing.slice().sort().join(',');
  if (usernameColorInflight[inflightKey]) {
    return usernameColorInflight[inflightKey];
  }
  var generation = usernameColorGeneration;
  var promise = fetch('/api/user-colors?users=' + encodeURIComponent(missing.join(',')))
    .then(function (res) {
      if (!res.ok) throw new Error('user-colors failed');
      return res.json();
    })
    .then(function (data) {
      if (generation !== usernameColorGeneration) return;
      var colors = (data && data.colors) || {};
      // 接口没返回的名字（异常数据）按未定级落缓存，避免反复请求。
      for (var i = 0; i < missing.length; i++) {
        var key = missing[i];
        if (!Object.prototype.hasOwnProperty.call(colors, key)) continue;
        usernameColorCache[key] = usernameNormalizeInfo(colors[key]);
      }
      usernameRefreshRendered();
    })
    .catch(function () {
      /* 拉取失败静默：保持 rt-unrated 降级显示，下次渲染再试。 */
    })
    .then(function () {
      if (generation === usernameColorGeneration) delete usernameColorInflight[inflightKey];
    });
  usernameColorInflight[inflightKey] = promise;
  return promise;
}

// rating 结算、封禁/解封及管理员权限变动时（home_leaderboard 广播）重新拉取。
function usernameColorsInvalidate() {
  usernameColorGeneration++;
  usernameColorCache = {};
  usernameColorInflight = {};
  if (typeof $ == 'undefined' || !$.fn) return;
  var names = [];
  var seen = {};
  $('[data-username]').each(function () {
    var key = usernameColorKey($(this).attr('data-username'));
    if (!key || seen[key]) return;
    seen[key] = true;
    names.push(key);
  });
  usernameEnsureColors(names);
}

// 缓存回填后刷新已渲染链接的颜色与 tooltip（含管理员权限撤销）。
function usernameRefreshRendered() {
  $('[data-username]').each(function () {
    var key = usernameColorKey($(this).attr('data-username'));
    var info = usernameColorCache[key];
    if (!info) return;
    var $el = $(this);
    // 先褪掉旧 rt-* 档（含管理员和封禁），再上新档。
    $el.removeClass(
      'rt-unrated rt-gray rt-green rt-cyan rt-blue rt-violet rt-orange rt-red rt-admin rt-banned',
    );
    $el.addClass(info.colorClass);
    $el.attr('title', info.title);
  });
}

// HTML 字符串版：与 usernameLink 同源（同一缓存与 rt-* 降级），供每帧全量 innerHTML 重建的
// 热路径（对局排行榜）使用；用户名经 htmlescape 防注入，输出与 DOM 版一致的 data-username 标记，
// 缓存批量回填后经 usernameRefreshRendered 统一刷新颜色。
function usernameLinkHtml(username) {
  var key = usernameColorKey(username);
  var cached = usernameColorCache[key] || null;
  var cls = (cached && cached.colorClass) || 'rt-unrated';
  var titleAttr = cached && cached.title ? ' title="' + htmlescape(cached.title) + '"' : '';
  return (
    '<a href="/u/' +
    encodeURIComponent(username) +
    '" class="' +
    cls +
    '"' +
    titleAttr +
    ' data-username="' +
    htmlescape(username) +
    '">' +
    htmlescape(username) +
    '</a>'
  );
}

// 构建统一用户名链接：<a href="/u/名字" class="rt-*" data-username="名字">名字</a>
// 封禁为 rt-banned/已封禁；未封禁管理员为 rt-admin/Headquarters，均无可见徽标。
// info 可选 {colorClass, title, admin, banned}；不传时查全局缓存，未命中按 rt-unrated 降级。
// extraClass 可选，如调用方自己的样式类（feed-author 等）。
// opts 可选 {stopPropagation: true}：给链接绑 click 阻止冒泡（用于整行可点的表格，点名字跳主页、点行其余进房间/回放）。
function usernameLink(username, info, extraClass, opts) {
  var key = usernameColorKey(username);
  if (info && info.colorClass) {
    usernameColorCache[key] = usernameNormalizeInfo(info);
  }
  var cached = usernameColorCache[key] || null;
  var $a = $('<a></a>')
    .attr('href', '/u/' + encodeURIComponent(username))
    .attr('data-username', username)
    .addClass((cached && cached.colorClass) || 'rt-unrated')
    .text(username);
  if (cached && cached.title) {
    $a.attr('title', cached.title);
  }
  if (extraClass) {
    $a.addClass(extraClass);
  }
  if (opts && opts.stopPropagation) {
    $a.on('click', function (e) {
      e.stopPropagation();
    });
  }
  return $a;
}
