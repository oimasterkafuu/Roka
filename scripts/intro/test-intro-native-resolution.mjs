import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';

const replaySource = await readFile(new URL('../../static/intro/replay-board.js', import.meta.url), 'utf8');
const replayURL = `data:text/javascript;base64,${Buffer.from(replaySource).toString('base64')}`;
const directorSource = await readFile(new URL('../../static/intro/director.js', import.meta.url), 'utf8');
const { createDirector } = await import(
  `data:text/javascript;base64,${Buffer.from(directorSource.replace("'./replay-board.js'", JSON.stringify(replayURL))).toString('base64')}`
);
const playerSource = await readFile(new URL('../../static/intro/player-source.js', import.meta.url), 'utf8');
const instantiate = new Function(
  'createScene',
  'createDirector',
  'fetchIntroAsset',
  'createIntroAssetLoader',
  playerSource.replace(/^import .*;\n/gm, '').replace('export async function', 'return async function'),
);

const plan = {
  duration: 124,
  fps: 30,
  frames: Array.from({ length: 124 * 30 }, () => ({ shot: 0 })),
  shots: [{ name: 'prologue', start: 0, end: 124 }],
};
const replays = { sources: {}, actions: {} };
const display = { width: 960, height: 540 };
const listeners = new Map();
const mediaQueries = [];
const resizeObservers = [];
const view = {
  devicePixelRatio: 2,
  addEventListener(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  },
  removeEventListener(type, callback) {
    listeners.get(type)?.delete(callback);
  },
  emit(type) {
    for (const callback of listeners.get(type) || []) callback();
  },
  matchMedia(media) {
    const callbacks = new Set();
    const query = {
      media,
      addEventListener(type, callback) {
        if (type === 'change') callbacks.add(callback);
      },
      removeEventListener(type, callback) {
        if (type === 'change') callbacks.delete(callback);
      },
      change() {
        for (const callback of callbacks) callback();
      },
    };
    mediaQueries.push(query);
    return query;
  },
  ResizeObserver: class {
    constructor(callback) {
      this.callback = callback;
      this.nodes = [];
      resizeObservers.push(this);
    }
    observe(node) {
      this.nodes.push(node);
    }
    disconnect() {
      this.disconnected = true;
    }
  },
};
const documentFonts = new Set();
const original = new Map(
  ['document', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [key, globalThis[key]]),
);
globalThis.document = {
  fonts: documentFonts,
  createElement() {
    const canvas = createCanvas(1, 1);
    canvas.style = {};
    canvas.getBoundingClientRect = () => ({ ...display });
    canvas.remove = () => {};
    return canvas;
  },
};
globalThis.fetch = async (url) => ({
  ok: true,
  async json() {
    if (url.endsWith('manifest.json'))
      return { files: { 'plan.json': '/plan', 'replays.json': '/replays' }, images: {}, fonts: {} };
    return url === '/plan' ? plan : replays;
  },
});
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const draws = [];
let mainCanvas;
const stage = {
  ownerDocument: { defaultView: view },
  parentElement: null,
  append(canvas) {
    mainCanvas = canvas;
  },
};
const createPlayer = instantiate(
  async () => ({
    resize: () => false,
    dispose() {},
    getMetrics: () => ({}),
  }),
  (canvas, options) => {
    const director = createDirector(canvas, options);
    return {
      resize: director.resize,
      dispose: director.dispose,
      renderAt(time) {
        draws.push(time);
        return director.renderAt(time);
      },
    };
  },
  (path, options) => globalThis.fetch(path, options),
  ({ files }) => {
    const blobs = new Map();
    const blob = (name) => {
      const path = files[name] || name;
      if (!blobs.has(path))
        blobs.set(
          path,
          globalThis
            .fetch(path)
            .then((response) => response.json())
            .then((data) => new Blob([JSON.stringify(data)])),
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

try {
  const offlineCanvas = createCanvas(1, 1);
  const offline = createDirector(offlineCanvas, { plan, replays });
  offline.renderAt(0);
  assert.equal(offlineCanvas.width, 1920, 'offline composition keeps its 1920px backing store');
  assert.equal(offlineCanvas.height, 1080, 'offline composition keeps its 1080px backing store');
  assert.equal(offlineCanvas.getContext('2d').getTransform().a, 1);
  offline.dispose();

  const player = await createPlayer(stage, {});
  assert.equal(mainCanvas.width, 1920, '960 CSS px at DPR 2 produces 1920 physical px');
  assert.equal(mainCanvas.height, 1080, '540 CSS px at DPR 2 produces 1080 physical px');
  assert.equal(mainCanvas.getContext('2d').getTransform().a, 1);

  player.seek(12.5);
  display.width = 2560;
  display.height = 1440;
  view.devicePixelRatio = 1;
  view.emit('resize');
  assert.equal(mainCanvas.width, 2560, 'resize follows the new CSS width at DPR 1');
  assert.equal(mainCanvas.height, 1440, 'resize follows the new CSS height at DPR 1');
  assert(Math.abs(mainCanvas.getContext('2d').getTransform().a - 2560 / 1920) < 1e-6);
  assert(Math.abs(mainCanvas.getContext('2d').getTransform().d - 1440 / 1080) < 1e-6);
  assert.equal(draws.at(-1), 12.5, 'resize redraws the current frame without seeking');

  display.width = 320;
  display.height = 180;
  view.devicePixelRatio = 1.5;
  mediaQueries.at(-1).change();
  assert.equal(mainCanvas.width, 480, 'DPR media-query changes update the backing store');
  assert.equal(mainCanvas.height, 270);
  assert.equal(mainCanvas.getContext('2d').getTransform().a, 0.25);
  assert.equal(draws.at(-1), 12.5, 'DPR changes preserve playback progress');

  display.width = 640;
  display.height = 360;
  view.devicePixelRatio = 2;
  resizeObservers.at(-1).callback();
  assert.equal(mainCanvas.width, 1280, 'ResizeObserver updates the backing store');
  assert.equal(mainCanvas.height, 720);
  assert.equal(draws.at(-1), 12.5);

  player.destroy();
  assert.equal(resizeObservers.at(-1).disconnected, true);
  assert.equal(listeners.get('resize').size, 0);
  console.log('intro native resolution: CSS size, DPR, logical transform and resize redraw passed');
} finally {
  for (const [key, value] of original) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
