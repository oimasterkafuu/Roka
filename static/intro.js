// Lightweight entry only. Rendering code and scene assets load after a watch/replay click.
(function () {
  'use strict';

  var version = document.currentScript.dataset.version || '';
  var offeredKey = 'roka_intro_offered_v1';
  var offeredInMemory = false;
  var active = null;
  var offerObserver = null;

  function wasOffered() {
    try {
      return offeredInMemory || !!localStorage.getItem(offeredKey);
    } catch (_) {
      return offeredInMemory;
    }
  }

  function markOffered() {
    offeredInMemory = true;
    try {
      localStorage.setItem(offeredKey, '1');
    } catch (_) {
      // Browsers with storage disabled still remember the choice for this page.
    }
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(text, onClick, className) {
    var node = element('button', className || 'intro-button', text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement;
  }

  function exitFullscreen(screen) {
    if (!screen || fullscreenElement() !== screen) return;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) {
      try {
        Promise.resolve(exit.call(document)).catch(function () {});
      } catch (_) {}
    }
  }

  function close() {
    var session = active;
    if (!session) return;
    active = null;
    session.controller.abort();
    clearTimeout(session.controlsTimer);
    document.removeEventListener('fullscreenchange', session.onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', session.onFullscreenChange);
    exitFullscreen(session.screen);
    if (session.resizeObserver) session.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', session.onVisibility);
    if (session.player) session.player.destroy();
    if (session.audioContext && session.audioContext.state !== 'closed') {
      session.audioContext.close().catch(function () {});
    }
    session.dialog.close();
    session.dialog.remove();
    document.documentElement.classList.remove('intro-open');
    if (session.previousFocus && session.previousFocus.isConnected) session.previousFocus.focus();
  }

  function createDialog(title, description, mode) {
    if (active) close();
    var dialog = element('dialog', 'intro-dialog intro-' + mode);
    if (mode === 'player') {
      dialog.setAttribute('aria-label', title);
      dialog.setAttribute('aria-description', description);
    } else {
      dialog.setAttribute('aria-labelledby', 'intro-title');
      dialog.setAttribute('aria-describedby', 'intro-description');
    }
    var header = element('div', 'intro-header');
    var heading = element('h2', '', title);
    heading.id = 'intro-title';
    var dismiss = button('关闭', close, 'intro-button intro-close');
    dismiss.setAttribute('aria-label', '关闭介绍片');
    header.append(heading, dismiss);
    var subtitle = element('p', 'intro-description', description);
    subtitle.id = 'intro-description';
    if (mode !== 'player') dialog.append(header, subtitle);
    var session = {
      dialog: dialog,
      controller: new AbortController(),
      previousFocus: document.activeElement,
      player: null,
      audioContext: null,
      state: 'loading',
      muted: false,
      autoPaused: false,
    };
    active = session;
    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      close();
    });
    dialog.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      var focusable = Array.from(dialog.querySelectorAll('button, input, a[href]')).filter(function (node) {
        return !node.disabled && !node.hidden;
      });
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    dialog.addEventListener('click', function (event) {
      if (event.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        close();
      }
    });
    document.body.append(dialog);
    document.documentElement.classList.add('intro-open');
    dialog.showModal();
    return session;
  }

  function showOffer() {
    if (active || wasOffered() || document.visibilityState === 'hidden') return;
    markOffered();
    var session = createDialog(
      '是否观看游戏介绍片',
      '用两分钟认识 Roka。画面由你的设备实时绘制，配有音乐；点击观看后才加载。以后可以在「关于」中重播。',
      'offer',
    );
    var actions = element('div', 'intro-offer-actions');
    var yes = button('观看介绍片', watch, 'intro-button intro-primary');
    var no = button('暂不观看', close);
    actions.append(yes, no);
    session.dialog.append(actions);
    yes.focus();
  }

  function timeLabel(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function watch() {
    // Audio activation must happen in the original click, before the first await/import.
    markOffered();
    var session = createDialog('Roka · 游戏介绍片', '实时演算 · 约 2 分钟 · 可随时暂停或跳过', 'player');
    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        session.audioContext = new AudioContext();
        session.audioContext.resume().catch(function () {});
      }
    } catch (_) {
      // The renderer can still offer a silent presentation when audio is unavailable.
    }

    var screen = element('div', 'intro-screen');
    session.screen = screen;
    screen.tabIndex = -1;
    var viewport = element('div', 'intro-viewport');
    var stage = element('div', 'intro-stage');
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', 'Roka 游戏介绍片实时画面');
    viewport.append(stage);
    var status = element('p', 'intro-status', '正在加载实时画面与音乐…');
    status.setAttribute('role', 'status');
    var statusOverlay = element('div', 'intro-status-overlay');
    statusOverlay.append(status);
    var controls = element('div', 'intro-controls');
    var pause = button('暂停', togglePause);
    var mute = button('静音', function () {
      session.muted = !session.muted;
      mute.textContent = session.muted ? '开启声音' : '静音';
      mute.setAttribute('aria-pressed', String(session.muted));
      session.player.setMuted(session.muted);
    });
    mute.setAttribute('aria-pressed', 'false');
    var progress = element('input', 'intro-progress');
    progress.type = 'range';
    progress.min = '0';
    progress.max = '124';
    progress.step = '0.1';
    progress.value = '0';
    progress.setAttribute('aria-label', '介绍片播放进度');
    var time = element('span', 'intro-time', '0:00 / 2:04');
    var skip = button('跳过并关闭', close);
    var retry = button('重新加载', watch);
    retry.hidden = true;
    pause.disabled = mute.disabled = progress.disabled = true;
    controls.append(pause, mute, progress, time, skip, retry);
    var chrome = element('div', 'intro-chrome');
    var dismiss = button('关闭', close, 'intro-button intro-close');
    dismiss.setAttribute('aria-label', '关闭介绍片');
    var bottom = element('div', 'intro-bottom');
    bottom.append(controls);
    chrome.append(dismiss, bottom);
    screen.append(viewport, statusOverlay, chrome);
    session.dialog.append(screen);
    screen.focus();

    function showControls() {
      if (active !== session) return;
      clearTimeout(session.controlsTimer);
      screen.classList.remove('intro-controls-hidden');
      if (session.state === 'playing' && !session.keyboardActive) {
        session.controlsTimer = setTimeout(function () {
          if (active === session && session.state === 'playing' && !session.keyboardActive) {
            screen.classList.add('intro-controls-hidden');
          }
        }, 2200);
      }
    }
    screen.addEventListener('pointermove', function () {
      session.keyboardActive = false;
      showControls();
    });
    screen.addEventListener('pointerdown', function () {
      session.keyboardActive = false;
      showControls();
    });
    screen.addEventListener('focusin', showControls);
    screen.addEventListener('keydown', function (event) {
      session.keyboardActive = true;
      showControls();
      if (
        (event.key === ' ' || event.key === 'k') &&
        !event.target.closest('button, input') &&
        session.player
      ) {
        event.preventDefault();
        togglePause();
      }
    });
    session.onFullscreenChange = function () {
      if (active !== session) return;
      if (fullscreenElement() === screen) {
        session.ownsFullscreen = true;
      } else if (session.ownsFullscreen) {
        close();
      }
    };
    document.addEventListener('fullscreenchange', session.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', session.onFullscreenChange);
    // Fullscreen is requested in this click, before dynamic import or any asset fetch.
    // The screen already fills the viewport if the browser denies or lacks the API.
    var requestFullscreen = screen.requestFullscreen || screen.webkitRequestFullscreen;
    if (requestFullscreen) {
      try {
        Promise.resolve(requestFullscreen.call(screen, { navigationUI: 'hide' })).then(
          function () {
            if (active !== session) exitFullscreen(screen);
            else session.onFullscreenChange();
          },
          function () {},
        );
      } catch (_) {}
    }

    function fitStage() {
      var width = viewport.clientWidth;
      stage.style.transform = 'scale(' + width / 1920 + ')';
    }
    session.resizeObserver = new ResizeObserver(fitStage);
    session.resizeObserver.observe(viewport);
    fitStage();

    function isActive() {
      return active === session && !session.controller.signal.aborted;
    }

    function setState(state) {
      if (!isActive()) return;
      if (state === 'error') {
        failed();
        return;
      }
      if (session.state === 'ended' && state !== 'ended') status.textContent = '画面由本机实时绘制';
      session.state = state;
      status.hidden = state === 'playing' || state === 'paused';
      showControls();
      pause.textContent = state === 'ended' ? '重新播放' : state === 'paused' ? '继续播放' : '暂停';
      if (state === 'playing') session.onVisibility();
    }

    function failed() {
      if (!isActive()) return;
      session.controller.abort();
      if (session.audioContext && session.audioContext.state !== 'closed') {
        session.audioContext.close().catch(function () {});
      }
      if (session.player) {
        session.player.destroy();
        session.player = null;
      }
      session.state = 'error';
      status.hidden = false;
      showControls();
      status.textContent = '介绍片暂时无法播放。请检查网络，或尝试使用支持 WebGL 的浏览器。';
      pause.disabled = mute.disabled = progress.disabled = true;
      retry.hidden = false;
      retry.focus();
    }

    async function togglePause() {
      if (!session.player || !isActive()) return;
      session.autoPaused = false;
      try {
        if (session.state === 'ended') {
          await session.player.seek(0);
          await session.player.play();
        } else if (session.state === 'paused') {
          await session.player.resume();
        } else {
          session.player.pause();
        }
      } catch (_) {
        failed();
      }
    }

    progress.addEventListener('input', function () {
      if (!session.player) return;
      Promise.resolve(session.player.seek(Number(progress.value))).catch(failed);
    });
    session.onVisibility = function () {
      if (!session.player || !isActive()) return;
      if (document.visibilityState === 'hidden' && session.state === 'playing') {
        session.autoPaused = true;
        session.player.pause();
      } else if (document.visibilityState === 'visible' && session.autoPaused) {
        session.autoPaused = false;
        Promise.resolve(session.player.resume()).catch(failed);
      }
    };
    document.addEventListener('visibilitychange', session.onVisibility);

    (window.ROKA_ASSETS
      ? window.ROKA_ASSETS.import('/intro/player.js?v=' + encodeURIComponent(version))
      : import('/intro/player.js?v=' + encodeURIComponent(version))
    )
      .then(function (module) {
        if (!isActive()) return null;
        return module.createIntroPlayer(stage, {
          audioContext: session.audioContext,
          signal: session.controller.signal,
          onEnded: function () {
            setState('ended');
            status.textContent = '介绍片已结束。准备好加入 Roka 了吗？';
          },
          onProgress: function (seconds, duration) {
            if (!isActive()) return;
            progress.max = String(duration);
            progress.value = String(seconds);
            time.textContent = timeLabel(seconds) + ' / ' + timeLabel(duration);
            progress.setAttribute('aria-valuetext', timeLabel(seconds) + '，共 ' + timeLabel(duration));
          },
          onStateChange: setState,
          onStatus: function (text) {
            if (isActive()) status.textContent = text;
          },
        });
      })
      .then(async function (player) {
        if (!player) return;
        if (!isActive()) {
          player.destroy();
          return;
        }
        session.player = player;
        progress.max = String(player.duration);
        pause.disabled = mute.disabled = progress.disabled = false;
        status.textContent = '画面由本机实时绘制';
        await player.play();
        if (isActive()) session.onVisibility();
      })
      .catch(failed);
  }

  document.querySelectorAll('[data-intro-replay]').forEach(function (node) {
    node.addEventListener('click', watch);
  });

  // Only the landing page offers automatically; never mount in a room or live match.
  if (document.body.classList.contains('home') && location.pathname === '/') {
    function maybeOffer() {
      if (wasOffered()) {
        if (offerObserver) offerObserver.disconnect();
        return;
      }
      if (document.documentElement.dataset.introHomeReady !== 'true') return;
      if (document.querySelector('.notify-permission-backdrop, dialog[open]')) return;
      showOffer();
      if (wasOffered() && offerObserver) offerObserver.disconnect();
    }
    offerObserver = new MutationObserver(maybeOffer);
    offerObserver.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('roka:home-ready', maybeOffer);
    document.addEventListener('visibilitychange', maybeOffer);
    maybeOffer();
  }
  window.addEventListener('pagehide', close);
})();
