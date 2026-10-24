// Exercise production player orchestration with controllable clocks/loaders. Three.js
// scene rendering is tested separately; these checks cover cancellation and audio races.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../../static/intro/player-source.js', import.meta.url), 'utf8');
const instantiate = new Function(
  'createScene',
  'createDirector',
  'fetchIntroAsset',
  'createIntroAssetLoader',
  source.replace(/^import .*;\n/gm, '').replace('export async function', 'return async function'),
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const keys = [
  'document',
  'fetch',
  'ROKA_ASSETS',
  'FontFace',
  'createImageBitmap',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];
const original = new Map(keys.map((key) => [key, globalThis[key]]));

function harness(settings = {}) {
  const stats = {
    requests: 0,
    paths: [],
    requestSignals: [],
    sceneDisposed: 0,
    directorDisposed: 0,
    starts: [],
    stops: 0,
    images: [],
    states: [],
    statuses: [],
    progress: [],
    ended: 0,
  };
  const frames = new Map();
  let frameId = 0;
  const fontSet = new Set();
  const scene = {
    dispose() {
      stats.sceneDisposed++;
    },
    getMetrics() {
      return {};
    },
  };
  const director = {
    resize() {
      return false;
    },
    dispose() {
      stats.directorDisposed++;
    },
    renderAt(time) {
      if (time >= (settings.renderErrorAt ?? Infinity)) throw new Error('Lost render context');
      stats.lastDraw = time;
    },
  };
  const audio = {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume() {
      return settings.resume
        ? settings.resume.promise.then(() => {
            audio.state = 'running';
          })
        : Promise.resolve();
    },
    decodeAudioData() {
      return Promise.resolve({ duration: 124 });
    },
    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {
          stats.gainDisconnected = true;
        },
      };
    },
    createBufferSource() {
      return {
        connect() {},
        disconnect() {},
        start(_, offset) {
          stats.starts.push(offset);
        },
        stop() {
          stats.stops++;
        },
      };
    },
  };
  globalThis.document = {
    fonts: fontSet,
    createElement() {
      return {
        style: {},
        getBoundingClientRect() {
          return { width: 1920, height: 1080 };
        },
        remove() {
          stats.canvasRemoved = true;
        },
      };
    },
  };
  globalThis.fetch = async (url, options) => {
    stats.requests++;
    stats.paths.push(url);
    stats.requestSignals.push(options.signal);
    return {
      ok: true,
      async json() {
        return url.endsWith('manifest.json')
          ? {
              files: { 'plan.json': '/plan', 'replays.json': '/replays', 'score.mp3': '/audio' },
              images: { map: '/image' },
              fonts: { serif: '/font' },
            }
          : {};
      },
      async arrayBuffer() {
        return new ArrayBuffer(1);
      },
      async blob() {
        return {};
      },
    };
  };
  if (settings.cdn) {
    globalThis.ROKA_ASSETS = {
      fetch(path, options) {
        return globalThis.fetch(
          'https://cdn.invalid/gh/oimasterkafuu/Roka@0123456789abcdef0123456789abcdef01234567/static' + path,
          options,
        );
      },
    };
  } else delete globalThis.ROKA_ASSETS;
  globalThis.FontFace = class {
    load() {
      return settings.font ? settings.font.promise.then(() => this) : Promise.resolve(this);
    }
  };
  globalThis.createImageBitmap = async () => {
    const image = {
      closed: 0,
      close() {
        this.closed++;
      },
    };
    stats.images.push(image);
    if (settings.bitmap) await settings.bitmap.promise;
    return image;
  };
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const create = instantiate(
    async ({ signal }) => {
      stats.sceneSignal = signal;
      if (settings.scene) await settings.scene.promise;
      return scene;
    },
    () => director,
    (path, options) => {
      const runtime = globalThis.ROKA_ASSETS;
      return runtime?.fetch ? runtime.fetch(path, options) : globalThis.fetch(path, options);
    },
    ({ files, signal }) => {
      const blobs = new Map();
      const fetchAsset = (path) => {
        const runtime = globalThis.ROKA_ASSETS;
        const options = { signal };
        return runtime?.fetch ? runtime.fetch(path, options) : globalThis.fetch(path, options);
      };
      const blob = (name) => {
        const path = files[name] || name;
        if (!blobs.has(path))
          blobs.set(
            path,
            fetchAsset(path).then(() => new Blob([name.endsWith('.json') ? '{}' : 'asset'])),
          );
        return blobs.get(path);
      };
      return {
        blob,
        async json(name) {
          return JSON.parse(await (await blob(name)).text());
        },
        blobURL: blob,
        modelURL: blob,
        async preload({ onProgress }) {
          const names = Object.keys(files);
          let completed = 0;
          onProgress(0, names.length);
          await Promise.all(
            names.map((name) =>
              blob(name).then(() => {
                onProgress(++completed, names.length);
              }),
            ),
          );
        },
        dispose() {
          blobs.clear();
        },
      };
    },
  );
  const controller = new AbortController();
  return {
    stats,
    audio,
    frames,
    fontSet,
    controller,
    create: () =>
      create(
        {
          append() {
            stats.appended = true;
          },
        },
        {
          audioContext: audio,
          signal: controller.signal,
          onStateChange: (state) => stats.states.push(state),
          onStatus: (status) => stats.statuses.push(status),
          onProgress: (time) => stats.progress.push(time),
          onEnded: () => stats.ended++,
        },
      ),
    frame() {
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      callback();
    },
  };
}

try {
  {
    const h = harness({ cdn: true });
    assert.equal(h.stats.requests, 0, 'preparing playback starts no requests before consent');
    const player = await h.create();
    assert.equal(h.stats.requests, 6, 'manifest, replay JSON, audio, image and font use the runtime');
    assert(
      h.stats.paths.every((url) =>
        url.startsWith(
          'https://cdn.invalid/gh/oimasterkafuu/Roka@0123456789abcdef0123456789abcdef01234567/static/',
        ),
      ),
    );
    assert(h.stats.requestSignals.every((signal) => signal === h.stats.sceneSignal));
    player.destroy();
  }
  {
    const h = harness();
    const player = await h.create();
    await player.play();
    h.audio.currentTime = 10;
    player.pause();
    assert.equal(h.stats.progress.at(-1), 10);
    await player.resume();
    assert.deepEqual(h.stats.starts, [0, 10], 'resume preserves audio position');
    await player.seek(70);
    assert.equal(h.stats.starts.at(-1), 70, 'seek restarts a single audio source at selected time');
    assert.equal(h.frames.size, 1, 'seek never leaves duplicate animation loops');
    h.audio.currentTime = 100;
    h.frame();
    assert.equal(h.stats.ended, 1);
    assert.equal(h.frames.size, 0, 'completed presentation does not loop');
    player.seek(20);
    assert.equal(h.stats.states.at(-1), 'paused', 'seeking back after ending enables resume');
    await player.resume();
    assert.equal(h.stats.starts.at(-1), 20);
    h.controller.abort();
    player.destroy();
    assert.equal(h.frames.size, 0);
    assert.equal(h.stats.sceneDisposed, 1);
    assert.equal(h.stats.directorDisposed, 1);
    assert.equal(h.stats.images[0].closed, 1);
    assert.equal(h.fontSet.size, 0);
    assert.equal(h.stats.gainDisconnected, true);
  }
  {
    const h = harness({ renderErrorAt: 1 });
    const player = await h.create();
    await player.play();
    h.audio.currentTime = 2;
    h.frame();
    assert.equal(h.stats.states.at(-1), 'error', 'runtime render failure reaches the entry UI');
    assert.equal(h.frames.size, 0);
    assert.equal(h.stats.stops, 1, 'a failed frame stops music');
    assert.equal(h.stats.sceneDisposed, 1, 'a failed frame releases WebGL resources');
    assert.equal(h.stats.images[0].closed, 1);
    player.destroy();
  }
  {
    const resume = deferred();
    const h = harness({ resume });
    const player = await h.create();
    h.audio.state = 'suspended';
    const first = player.play();
    const second = player.play();
    player.pause();
    resume.resolve();
    await Promise.all([first, second]);
    assert.equal(h.stats.starts.length, 0, 'pause cancels every pending audio activation');
    assert.equal(h.frames.size, 0);
    player.destroy();
  }
  {
    const resume = deferred();
    const h = harness({ resume });
    const player = await h.create();
    h.audio.state = 'suspended';
    const first = player.play();
    const seek = player.seek(45);
    resume.resolve();
    await Promise.all([first, seek]);
    assert.deepEqual(h.stats.starts, [45], 'seek supersedes a pending play without overlapping audio');
    assert.equal(h.frames.size, 1);
    player.destroy();
  }
  {
    const resume = deferred();
    const h = harness({ resume });
    const player = await h.create();
    h.audio.state = 'suspended';
    const pending = player.play();
    player.destroy();
    resume.resolve();
    await pending;
    assert.equal(h.stats.starts.length, 0, 'destroy cancels pending play');
    assert.equal(h.frames.size, 0);
  }
  {
    const bitmap = deferred(),
      font = deferred(),
      scene = deferred();
    const h = harness({ bitmap, font, scene });
    const pending = h.create();
    await flush();
    font.reject(new Error('Font unavailable'));
    await assert.rejects(pending, /Font unavailable/);
    assert.equal(h.stats.sceneSignal.aborted, true, 'a failed load aborts sibling loaders');
    bitmap.resolve();
    scene.resolve();
    await flush();
    assert.equal(h.stats.images[0].closed, 1, 'late bitmap decode is explicitly closed');
    assert.equal(h.stats.sceneDisposed, 1, 'late scene completion is explicitly disposed');
    assert.equal(h.fontSet.size, 0);
  }
  {
    const font = deferred();
    const h = harness({ font });
    const pending = h.create();
    await flush();
    assert(!h.stats.statuses.includes('画面与音乐已就绪'), 'a pending required asset blocks readiness');
    font.resolve();
    const player = await pending;
    assert.equal(h.stats.statuses.at(-1), '画面与音乐已就绪');
    player.destroy();
  }
  {
    const sceneSource = await fs.readFile(new URL('../../static/intro/scene.js', import.meta.url), 'utf8');
    assert(!source.includes('素材已就绪') && !sceneSource.includes('素材已就绪'));
    assert(!sceneSource.includes('光影'), 'scene loading never claims lighting initialization');
    assert(!sceneSource.includes('正在加载场景素材'), 'Three manager cannot overwrite unified loading progress');
  }
  {
    const h = harness();
    h.controller.abort();
    await assert.rejects(h.create(), { name: 'AbortError' });
    assert.equal(h.stats.requests, 0, 'an already-cancelled player never starts asset loading');
  }
  console.log(
    'intro lifecycle: truthful readiness, playback position, cancellation, pending audio races and late resource disposal passed',
  );
} finally {
  for (const [key, value] of original) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
