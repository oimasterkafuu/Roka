async function loadAmbassadorWall() {
  var status = document.getElementById('ambassadors-status');
  var grid = document.getElementById('ambassador-grid');
  try {
    var response = await fetch('/api/ambassadors', { cache: 'no-store' });
    if (!response.ok) throw new Error('ambassador-load-failed');
    var data = await response.json();
    var conversion = data.conversion || {};
    for (var key of ['clicks', 'registrations', 'activations', 'excluded']) {
      var element = document.getElementById('referral-' + key);
      var value = conversion[key];
      element.textContent = Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : '0';
    }
    var items = Array.isArray(data.items) ? data.items : [];
    grid.replaceChildren();
    for (var item of items) {
      if (
        !item ||
        !/^[A-Za-z0-9_]{3,20}$/.test(item.username) ||
        !Number.isFinite(item.activatedCount) ||
        item.activatedCount < 1
      ) {
        continue;
      }
      var link = document.createElement('a');
      link.className = 'ambassador-card';
      link.href = '/u/' + encodeURIComponent(item.username);
      var name = document.createElement('span');
      name.className = 'ambassador-name';
      name.textContent = item.username;
      var level = document.createElement('span');
      level.className = 'ambassador-level';
      level.textContent = '推广大使 · Lv ' + Math.max(1, Math.floor(item.badgeLevel || 1));
      var count = document.createElement('span');
      count.className = 'ambassador-count';
      count.textContent = Math.floor(item.activatedCount) + ' 位新玩家完成有效对局';
      link.append(name, level, count);
      grid.append(link);
    }
    status.hidden = grid.children.length > 0;
    if (grid.children.length === 0) status.textContent = '还没有有效激活，第一位推广大使可能就是你。';
  } catch (error) {
    grid.replaceChildren();
    status.hidden = false;
    status.textContent = '暂时无法加载感谢墙，请稍后再试。';
  }
}

var ambassadorWallReady = loadAmbassadorWall();

async function loadAmbassadorInvite() {
  try {
    var response = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!response.ok) return;
    var user = await response.json();
    if (!user.username) return;
    var input = document.getElementById('ambassador-invite-link');
    var button = document.getElementById('ambassador-invite-copy');
    input.value = location.origin + '/invite/' + encodeURIComponent(user.username);
    button.addEventListener('click', async function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(input.value);
        } else {
          input.select();
          if (!document.execCommand('copy')) throw new Error('copy-failed');
        }
        button.textContent = '已复制';
        setTimeout(function () {
          button.textContent = '复制';
        }, 1500);
      } catch (error) {
        input.focus();
        input.select();
        button.textContent = '请手动复制';
      }
    });
    document.getElementById('ambassador-share').hidden = false;
    document.getElementById('ambassador-login').hidden = true;
    document.getElementById('ambassador-share-hint').textContent =
      '分享你的专属邀请链接，新玩家注册并完成首次有效对局后即可激活。';
  } catch (error) {
    // Keep the login prompt when authentication is unavailable.
  }
}

var ambassadorInviteReady = loadAmbassadorInvite();
