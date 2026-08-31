/**
 * 孤军闪烁全局时钟。
 *
 * 闪烁相位只由本时钟驱动：时钟在 #map 容器上周期性地切换
 * blink-slow / blink-fast / pulse-soft 三个 class，单元格上的
 * .isolated / .isolated-fresh / .tutorial-target 只负责“参与哪种闪烁”。
 * 因此对单元格的任何操作（改 class、改 style、innerHTML 重建）
 * 都不会重置闪烁相位。
 *
 * 页面没有 #map 时静默空转，不报错。
 */
(function () {
  'use strict';

  var SLOW_HALF_PERIOD_MS = 500; // blink-slow：周期 1s（断链衰减期孤军）
  var FAST_HALF_PERIOD_MS = 200; // blink-fast：周期 0.4s（宽限期孤军）
  var PULSE_HALF_PERIOD_MS = 600; // pulse-soft：周期 1.2s（教程目标提示）

  function startBlinkClock() {
    var map = document.getElementById('map');
    if (!map) {
      return;
    }
    var slowOn = false;
    var fastOn = false;
    var pulseOn = false;
    setInterval(function () {
      slowOn = !slowOn;
      map.classList.toggle('blink-slow', slowOn);
    }, SLOW_HALF_PERIOD_MS);
    setInterval(function () {
      fastOn = !fastOn;
      map.classList.toggle('blink-fast', fastOn);
    }, FAST_HALF_PERIOD_MS);
    setInterval(function () {
      pulseOn = !pulseOn;
      map.classList.toggle('pulse-soft', pulseOn);
    }, PULSE_HALF_PERIOD_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startBlinkClock);
  } else {
    startBlinkClock();
  }
})();
