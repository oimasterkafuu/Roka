// 浏览器通知（Notification API）共享模块，首页（index.html）与房间/对局页（game.html）共用。
// 提供两件事：后台事件去重弹通知（notifyEvent）、登录后权限申请引导弹窗
// （maybePromptNotificationPermission）。浏览器不支持 Notification 时全部静默跳过。

// 跨标签页去重时间窗：同一 tag 的通知在该窗口内只允许一个标签页弹出。
var ROKA_NOTIFY_DEDUP_MS = 5000;

function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// 仅当页面在后台（标签页不可见或窗口无焦点）时才需要浏览器通知。
function notifyPageInBackground() {
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

// 弹一条浏览器通知。去重两道保险：localStorage 时间戳互斥（同一时间窗内多个后台
// 标签页只有一个能写成功并弹窗），Notification 的 tag 参数让浏览器自动替换同 tag
// 的旧通知，避免刷屏。
function notifyEvent(tag, title, body) {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  if (!notifyPageInBackground()) return;
  try {
    var key = 'roka_notify_last:' + tag;
    var now = Date.now();
    var last = parseInt(localStorage.getItem(key) || '0', 10);
    if (now - last < ROKA_NOTIFY_DEDUP_MS) return;
    localStorage.setItem(key, String(now));
  } catch (e) {
    // localStorage 不可用（隐私模式等）时仍弹通知，仅失去跨标签页去重。
  }
  try {
    new Notification(title, { body: body, tag: tag });
  } catch (e) {
    // 某些环境（如无通知中心的系统）构造 Notification 会抛错，静默忽略。
  }
}

// 登录后引导申请通知权限：permission === 'default' 时先弹解释窗说明通知用途，
// 由「开启通知」按钮的点击手势触发 requestPermission（浏览器要求用户手势）。
// 用户已拒绝（'denied'）时永不打扰；解释窗每个浏览器最多弹一次（localStorage 持久化），
// 不会因新开标签页反复出现（sessionStorage 按标签页隔离，换新标签页就会重复弹）。
function maybePromptNotificationPermission() {
  if (!notifySupported()) return;
  if (Notification.permission !== 'default') return;
  try {
    if (localStorage.getItem('roka_notify_prompt_shown')) return;
    localStorage.setItem('roka_notify_prompt_shown', '1');
  } catch (e) {
    // localStorage 不可用（隐私模式等）时照常弹窗，最多同页重复一次。
  }

  var $backdrop = $('<div class="notify-permission-backdrop"></div>');
  var $card = $('<div class="alert center notify-permission-card"></div>').appendTo($backdrop);
  $('<h1></h1>').text('开启浏览器通知？').appendTo($card);
  $('<p></p>').text('当页面处于后台时，以下情况会通过浏览器通知提醒你：').appendTo($card);
  $('<ul></ul>')
    .append($('<li></li>').text('有新玩家进入你所在的房间'))
    .append($('<li></li>').text('你所在的房间游戏开始'))
    .append($('<li></li>').text('首页有玩家上线或创建了新房间'))
    .appendTo($card);

  function close() {
    $backdrop.remove();
  }
  $('<button class="small inverted"></button>')
    .text('开启通知')
    .on('click', function () {
      close();
      // 兼容回调式与 Promise 式两种 requestPermission 签名。
      try {
        var result = Notification.requestPermission(function () {});
        if (result && typeof result.then === 'function') {
          result.then(null, function () {});
        }
      } catch (e) {
        // 请求失败静默忽略，permission 保持 default 时下次访问会再次引导。
      }
    })
    .appendTo($card);
  $('<button class="small"></button>').text('暂不开启').on('click', close).appendTo($card);
  $('body').append($backdrop);
}
