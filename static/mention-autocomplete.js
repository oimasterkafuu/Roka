// @ 提及输入补全：给带 data-mention 的 input/textarea 挂上「输入 @ 弹出用户名候选」。
// 候选来自 GET /api/users/search?q=前缀（大小写不敏感前缀匹配）；上下键选择、回车/Tab 插入
// @用户名、Esc 关闭。插入后触发原生 input 事件，页面计数器等可正常响应。
// 与页面评论提交的配合：插入时置 __mentionSuppressEnter，供 keypress 的 Enter 提交判断跳过。
(function () {
  'use strict';

  var MENU_CLASS = 'mention-menu';
  var FETCH_LIMIT = 6;
  var DEBOUNCE_MS = 120;

  var menu = null; // 共享下拉 DOM（挂到 body，避免被容器 overflow 裁剪）
  var menuInput = null; // 下拉当前所属输入框
  var candidates = []; // 当前候选人 [{username,colorClass,title}]
  var activeIndex = -1;
  var fetchTimer = null;
  var fetchSeq = 0;

  function buildMenu() {
    if (menu) {
      return menu;
    }
    menu = document.createElement('div');
    menu.className = MENU_CLASS;
    menu.style.display = 'none';
    document.body.appendChild(menu);
    // mousedown 早于 blur，preventDefault 保持输入框焦点。
    menu.addEventListener('mousedown', function (e) {
      e.preventDefault();
    });
    menu.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('[data-mention-index]') : null;
      if (!row || !menuInput) {
        return;
      }
      choose(Number(row.getAttribute('data-mention-index')), false);
    });
    return menu;
  }

  function closeMenu() {
    if (fetchTimer) {
      clearTimeout(fetchTimer);
      fetchTimer = null;
    }
    fetchSeq += 1;
    if (menu) {
      menu.style.display = 'none';
    }
    if (menuInput) {
      menuInput.removeAttribute('data-mention-open');
    }
    menuInput = null;
    candidates = [];
    activeIndex = -1;
  }

  function placeMenu(input) {
    if (!menu) {
      return;
    }
    var rect = input.getBoundingClientRect();
    menu.style.left = rect.left + window.scrollX + 'px';
    menu.style.top = rect.bottom + window.scrollY + 4 + 'px';
    menu.style.minWidth = Math.round(Math.max(Math.min(rect.width, 320), 160)) + 'px';
  }

  // 光标前是否处于「@ + 局部用户名」上下文；返回 {at, query} 或 null。
  function mentionContext(input) {
    var value = input.value || '';
    var caret = input.selectionStart;
    if (caret === null || caret === undefined) {
      return null;
    }
    var i = caret - 1;
    while (i >= 0 && /[A-Za-z0-9_]/.test(value.charAt(i))) {
      i -= 1;
    }
    if (i < 0 || value.charAt(i) !== '@') {
      return null;
    }
    if (i > 0 && /[A-Za-z0-9_@]/.test(value.charAt(i - 1))) {
      return null; // 邮箱 a@b 或 @@ 不触发
    }
    var query = value.slice(i + 1, caret);
    if (query.length > 20) {
      return null;
    }
    return { at: i, query: query };
  }

  function refresh(input) {
    var ctx = mentionContext(input);
    if (!ctx) {
      closeMenu();
      return;
    }
    menuInput = input;
    input.setAttribute('data-mention-open', '1');
    if (fetchTimer) {
      clearTimeout(fetchTimer);
    }
    var seq = (fetchSeq += 1);
    fetchTimer = setTimeout(function () {
      fetchTimer = null;
      fetch('/api/users/search?q=' + encodeURIComponent(ctx.query) + '&limit=' + FETCH_LIMIT)
        .then(function (res) {
          return res.ok ? res.json() : { items: [] };
        })
        .then(function (data) {
          if (seq !== fetchSeq || menuInput !== input) {
            return;
          }
          var now = mentionContext(input);
          if (!now || now.at !== ctx.at) {
            return;
          }
          renderItems(input, data && Array.isArray(data.items) ? data.items : []);
        })
        .catch(function () {
          /* 候选拉取失败静默：不影响正常输入。 */
        });
    }, DEBOUNCE_MS);
  }

  function renderItems(input, items) {
    candidates = items;
    activeIndex = items.length ? 0 : -1;
    var el = buildMenu();
    el.innerHTML = '';
    if (!items.length) {
      closeMenu();
      return;
    }
    items.forEach(function (item, index) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'mention-menu-item' + (index === activeIndex ? ' active' : '');
      row.setAttribute('data-mention-index', String(index));
      var name = document.createElement('span');
      name.className = 'mention-menu-name ' + (item.colorClass || 'rt-unrated');
      name.textContent = '@' + item.username;
      row.appendChild(name);
      if (item.title) {
        var title = document.createElement('span');
        title.className = 'mention-menu-title';
        title.textContent = item.title;
        row.appendChild(title);
      }
      el.appendChild(row);
    });
    el.style.display = 'block';
    placeMenu(input);
  }

  function setActive(index) {
    if (!candidates.length || !menu) {
      return;
    }
    activeIndex = (index + candidates.length) % candidates.length;
    var rows = menu.querySelectorAll('.mention-menu-item');
    for (var i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle('active', i === activeIndex);
    }
  }

  function choose(index, fromKeyboard) {
    var input = menuInput;
    var item = candidates[index];
    if (!input || !item) {
      return;
    }
    var ctx = mentionContext(input);
    if (!ctx) {
      closeMenu();
      return;
    }
    var value = input.value;
    var before = value.slice(0, ctx.at);
    var after = value.slice(ctx.at + 1 + ctx.query.length);
    var insert = '@' + item.username + ' ';
    input.value = before + insert + after;
    var pos = before.length + insert.length;
    try {
      input.setSelectionRange(pos, pos);
    } catch (e) {
      /* 某些输入类型不支持 setSelectionRange，忽略。 */
    }
    if (fromKeyboard) {
      // 让随后可能触发的 keypress Enter 提交逻辑跳过本次（见 mentionAutocompleteShouldIgnoreEnter）。
      input.__mentionSuppressEnter = true;
    }
    closeMenu();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function onKeyDown(e) {
    if (!menu || menu.style.display === 'none' || menuInput !== this) {
      return;
    }
    var key = e.key;
    if (key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setActive(activeIndex + 1);
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setActive(activeIndex - 1);
    } else if ((key === 'Enter' || key === 'Tab') && candidates.length) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) {
        e.stopImmediatePropagation();
      }
      choose(activeIndex, true);
    } else if (key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  }

  function initInput(input) {
    if (input.__mentionInit) {
      return;
    }
    input.__mentionInit = true;
    input.addEventListener('input', function () {
      refresh(input);
    });
    input.addEventListener('click', function () {
      refresh(input);
    });
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('keyup', function (e) {
      if (e.key === 'Enter' || e.key === 'Tab') {
        input.__mentionSuppressEnter = false;
      }
    });
    input.addEventListener('blur', function () {
      setTimeout(closeMenu, 120);
    });
  }

  function initAll() {
    var nodes = document.querySelectorAll('input[data-mention], textarea[data-mention]');
    for (var i = 0; i < nodes.length; i += 1) {
      initInput(nodes[i]);
    }
  }

  // 动态创建的输入框（评论框随动态重渲染）：focusin 时惰性初始化。
  document.addEventListener('focusin', function (e) {
    var target = e.target;
    if (target && target.matches && target.matches('input[data-mention], textarea[data-mention]')) {
      initInput(target);
    }
  });
  window.addEventListener(
    'scroll',
    function () {
      if (menuInput) {
        placeMenu(menuInput);
      }
    },
    true,
  );
  window.addEventListener('resize', function () {
    if (menuInput) {
      placeMenu(menuInput);
    }
  });

  // 供页面评论提交逻辑判断：本次 Enter 是刚插入提及，应当跳过提交。
  window.mentionAutocompleteShouldIgnoreEnter = function (input) {
    return !!(input && input.__mentionSuppressEnter);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
