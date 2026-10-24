import { createScene } from './scene.js';
import { createDirector } from './director.js';
import { createIntroAssetLoader, fetchIntroAsset } from './asset-loading.js';

// Presentation is driven by the audio clock, never accumulated animation deltas.
// A slow device drops frames without stretching music, replay ticks or camera paths.
export async function createIntroPlayer(stage, options = {}) {
  const {
    audioContext = null,
    signal,
    onEnded = () => {},
    onProgress = () => {},
    onLoadProgress = () => {},
    onStateChange = () => {},
    onStatus = () => {},
  } = options;
  const local = new AbortController();
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const abortCheck = () => {
    if (combined.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  let scene, director, source, gain, audioBuffer;
  let resizeObserver, dprQuery;
  const view = stage.ownerDocument?.defaultView || globalThis;
  let raf = 0;
  let destroyed = false;
  let playing = false;
  let desiredPlaying = false;
  let playRequest = 0;
  let offset = 0;
  let clockStart = 0;
  let lastFrame = -1;
  const metrics = { frames: 0, totalRenderMs: 0, maxRenderMs: 0, renderSamples: [], duration: 124 };
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.style.cssText =
    'display:block;position:absolute;left:0;top:0;width:1920px;height:1080px;z-index:1;pointer-events:none';
  const fonts = [];
  const images = {};

  function stopAudio() {
    if (!source) return;
    try {
      source.stop();
    } catch {}
    source.disconnect();
    source = null;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    playing = desiredPlaying = false;
    playRequest++;
    cancelAnimationFrame(raf);
    local.abort();
    resizeObserver?.disconnect();
    view.removeEventListener?.('resize', handleResize);
    dprQuery?.removeEventListener?.('change', handleDprChange);
    dprQuery?.removeListener?.(handleDprChange);
    stopAudio();
    gain?.disconnect();
    director?.dispose();
    scene?.dispose();
    director = scene = gain = audioBuffer = null;
    canvas.remove();
    canvas.width = canvas.height = 0;
    for (const [name, image] of Object.entries(images)) {
      image.close();
      delete images[name];
    }
    for (const font of fonts) document.fonts.delete(font);
    fonts.length = 0;
    signal?.removeEventListener('abort', destroy);
  }
  signal?.addEventListener('abort', destroy, { once: true });

  function fetchAsset(path, options) {
    return fetchIntroAsset(path, options);
  }

  async function json(url) {
    const response = await fetchAsset(url, { signal: combined });
    if (!response.ok) throw new Error(`Intro request failed: ${response.status}`);
    return response.json();
  }

  try {
    abortCheck();
    const manifest = await json('/intro/assets/manifest.json');
    abortCheck();
    const files = { ...manifest.files, ...manifest.images, ...manifest.fonts };
    const assetLoader = createIntroAssetLoader({ files, signal: combined });
    await assetLoader.preload({
      onProgress(completed, total) {
        onLoadProgress(completed, total);
        onStatus(`正在并行加载素材 ${completed}/${total}`);
      },
    });
    abortCheck();
    onStatus('下载完成，正在初始化实时画面…');
    const family = {
      serif: 'RokaIntroSerif',
      cn: 'RokaIntroCN',
      latin: 'RokaIntroLatin',
      sans: 'RokaIntroSans',
      quicksand: 'Quicksand',
    };
    const loadImage = async (name) => {
      const image = await createImageBitmap(await assetLoader.blob(name));
      // Bitmap decoding cannot be aborted; close a result that arrives after cancellation.
      if (combined.aborted) {
        image.close();
        abortCheck();
      }
      images[name] = image;
    };
    const loadFont = async (name) => {
      const data = await (await assetLoader.blob(name)).arrayBuffer();
      const font = new FontFace(family[name], data, {
        weight: ['serif', 'cn', 'quicksand'].includes(name) ? '700' : '400',
      });
      await font.load();
      abortCheck();
      fonts.push(font);
      document.fonts.add(font);
    };
    const [plan, replays, loadedAudio] = await Promise.all([
      assetLoader.json('plan.json'),
      assetLoader.json('replays.json'),
      audioContext
        ? assetLoader
            .blob('score.mp3')
            .then((blob) => blob.arrayBuffer())
            .then((data) => audioContext.decodeAudioData(data))
        : null,
      Promise.all(Object.keys(manifest.images).map(loadImage)),
      Promise.all(Object.keys(manifest.fonts).map(loadFont)),
      createScene({ assets: manifest, assetLoader, signal: combined, nativeResolution: true }).then(
        (result) => {
          if (destroyed) result.dispose();
          else scene = result;
        },
      ),
    ]);
    abortCheck();
    audioBuffer = loadedAudio;
    director = createDirector(canvas, { assets: images, plan, replays, scene });
    if (scene.canvas) stage.append(scene.canvas);
    stage.append(canvas);
    if (audioContext) {
      gain = audioContext.createGain();
      gain.connect(audioContext.destination);
    }
    // The selected clock is fixed for this play interval, avoiding jumps on audio suspension.
    let audioClock = false;
    const clock = () => (audioClock ? audioContext.currentTime : performance.now() / 1000);
    const current = () => Math.min(124, Math.max(0, offset + (playing ? clock() - clockStart : 0)));

    function syncResolution() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const dpr = view.devicePixelRatio || 1;
      const changed = director.resize(
        Math.max(1, Math.round(rect.width * dpr)),
        Math.max(1, Math.round(rect.height * dpr)),
      );
      return scene.resize?.() || changed;
    }
    function watchDpr() {
      dprQuery?.removeEventListener?.('change', handleDprChange);
      dprQuery?.removeListener?.(handleDprChange);
      dprQuery = view.matchMedia?.(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
      if (dprQuery?.addEventListener) dprQuery.addEventListener('change', handleDprChange);
      else dprQuery?.addListener?.(handleDprChange);
    }
    function handleResize() {
      if (destroyed) return;
      watchDpr();
      if (syncResolution()) draw(current());
    }
    function handleDprChange() {
      handleResize();
    }
    function draw(time) {
      syncResolution();
      const start = performance.now();
      director.renderAt(time);
      const cost = performance.now() - start;
      metrics.frames++;
      metrics.totalRenderMs += cost;
      metrics.maxRenderMs = Math.max(metrics.maxRenderMs, cost);
      if (metrics.renderSamples.length < 240) metrics.renderSamples.push(cost);
      onProgress(time, 124);
    }

    function tick() {
      if (!playing || destroyed) return;
      try {
        const time = current();
        const frame = Math.floor(time * 30);
        if (frame !== lastFrame) {
          lastFrame = frame;
          draw(time);
        }
        if (!playing || destroyed) return;
        if (time >= 124) {
          offset = 124;
          playing = desiredPlaying = false;
          stopAudio();
          onStateChange('ended');
          onEnded();
          return;
        }
        raf = requestAnimationFrame(tick);
      } catch (_) {
        destroy();
        onStateChange('error');
        onStatus('实时画面绘制失败，请重试。');
      }
    }

    async function play() {
      if (destroyed || playing) return;
      desiredPlaying = true;
      const request = ++playRequest;
      if (offset >= 124) offset = 0;
      if (audioContext?.state === 'suspended') {
        try {
          await audioContext.resume();
        } catch {}
      }
      // A pause, seek, newer play, or close can arrive while audio activation is pending.
      if (destroyed || !desiredPlaying || request !== playRequest) return;
      audioClock = audioContext?.state === 'running';
      clockStart = clock();
      playing = true;
      try {
        if (audioBuffer && audioClock) {
          source = audioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(gain);
          source.start(0, Math.min(offset, audioBuffer.duration));
        }
        onStateChange('playing');
        lastFrame = -1;
        tick();
      } catch (error) {
        pause();
        throw error;
      }
    }

    function pause() {
      if (destroyed) return;
      const wasRequested = desiredPlaying;
      desiredPlaying = false;
      playRequest++;
      if (playing) offset = current();
      playing = false;
      cancelAnimationFrame(raf);
      stopAudio();
      if (wasRequested) {
        onProgress(offset, 124);
        onStateChange('paused');
      }
    }

    function seek(seconds) {
      if (destroyed) return;
      const wasRequested = desiredPlaying;
      pause();
      offset = Math.max(0, Math.min(124, Number(seconds) || 0));
      lastFrame = -1;
      draw(offset);
      if (wasRequested && offset < 124) return play();
      onStateChange(offset >= 124 ? 'ended' : 'paused');
    }

    view.addEventListener?.('resize', handleResize);
    watchDpr();
    if (view.ResizeObserver) {
      resizeObserver = new view.ResizeObserver(handleResize);
      resizeObserver.observe(stage.parentElement || stage);
      resizeObserver.observe(canvas);
      if (scene.canvas) resizeObserver.observe(scene.canvas);
    }
    draw(0);
    abortCheck();
    onStatus(audioContext ? '画面与音乐已就绪' : '当前浏览器将静音播放');
    abortCheck();
    return {
      duration: 124,
      play,
      pause,
      resume: play,
      seek,
      setMuted(value) {
        if (gain) gain.gain.value = value ? 0 : 1;
      },
      destroy,
      getMetrics: () => ({
        ...metrics,
        meanRenderMs: metrics.totalRenderMs / Math.max(1, metrics.frames),
        scene: scene?.getMetrics() || {},
      }),
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
