import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const code = await fs.readFile(path.join(root, 'static/intro/asset-loading.js'), 'utf8');
const { createIntroAssetLoader, fetchIntroAsset } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const original = {
  fetch: globalThis.fetch,
  runtime: globalThis.ROKA_ASSETS,
  caches: globalThis.caches,
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};
const objects = new Map(),
  revoked = [],
  requests = [],
  stored = new Map();
const cacheState = { failPut: false };
const cache = {
  async match(key) {
    return stored.get(key)?.clone();
  },
  async put(key, response) {
    if (cacheState.failPut) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    stored.set(key, response.clone());
  },
};
globalThis.caches = {
  async open(name) {
    assert.equal(name, 'roka-intro-assets-v1');
    return cache;
  },
};
let serial = 0;
URL.createObjectURL = (blob) => {
  const url = `blob:intro-test/${++serial}`;
  objects.set(url, blob);
  return url;
};
URL.revokeObjectURL = (url) => {
  assert(objects.has(url));
  revoked.push(url);
};
const commit = '0123456789abcdef0123456789abcdef01234567';
const manifest = JSON.parse(await fs.readFile(path.join(root, 'static/intro/assets/manifest.json')));
try {
  globalThis.fetch = () => {
    throw new Error('Network request bypassed commit runtime');
  };
  globalThis.ROKA_ASSETS = {
    async fetch(staticPath, options) {
      assert(options.signal instanceof AbortSignal);
      assert(!options.signal.aborted);
      assert(staticPath.startsWith('/intro/assets/'), staticPath);
      // A provider failure must not change the pinned revision or fall back to origin.
      for (const host of ['first.invalid', 'second.invalid'])
        requests.push(`https://${host}/gh/oimasterkafuu/Roka@${commit}/static${staticPath}`);
      return new Response(await fs.readFile(path.join(root, 'static', staticPath)));
    },
  };
  const loader = createIntroAssetLoader({ files: manifest.files });
  assert.equal(requests.length, 0, 'constructing the loader must never start requests before consent');
  const names = ['knight-hero.glb', 'knight-lod.glb', 'knight-crowd.glb'];
  const urls = await Promise.all(names.map((name) => loader.modelURL(name)));
  for (const url of urls) {
    const data = JSON.parse(await objects.get(url).text());
    for (const entry of [...data.buffers, ...data.images])
      if (entry.uri) assert(entry.uri.startsWith('blob:'), 'deep model dependency must be a fetched blob');
  }
  assert.equal(await loader.modelURL(names[0]), urls[0], 'model preparation is deduplicated');
  const actualFiles = requests.filter((_, i) => i % 2 === 0);
  assert.equal(
    new Set(actualFiles).size,
    actualFiles.length,
    'shared model textures/buffers are fetched once',
  );
  assert(requests.every((url) => url.includes(`@${commit}/static/intro/assets/`)));
  assert(
    !requests.some((url) => /world|ground|sky/.test(url)),
    'model load does not preload unrelated scene files',
  );
  const [one, two] = await Promise.all([loader.blobURL('ground.jpg'), loader.blobURL('ground.jpg')]);
  assert.equal(one, two, 'concurrent texture fetches share one resource blob');
  const ground = await objects.get(one).text();
  const count = objects.size;
  loader.dispose();
  loader.dispose();
  assert.equal(revoked.length, count, 'all model and dependency URLs are revoked exactly once');
  assert.throws(() => loader.blobURL('ground.jpg'), { name: 'AbortError' });

  const networkAfterColdLoad = requests.length;
  const reopened = createIntroAssetLoader({ files: manifest.files });
  const cachedURL = await reopened.blobURL('ground.jpg');
  assert.equal(requests.length, networkAfterColdLoad, 'a new loader reuses persistent hashed assets');
  assert.equal(await objects.get(cachedURL).text(), ground, 'persistent hits preserve response bytes');
  reopened.dispose();
  assert([...stored.keys()].every((key) => key.startsWith('https://roka.invalid/intro/assets/')));

  const beforeManifest = requests.length;
  for (let i = 0; i < 2; i++) {
    const response = await fetchIntroAsset('/intro/assets/manifest.json', {
      signal: new AbortController().signal,
    });
    assert.equal((await response.json()).files['plan.json'], manifest.files['plan.json']);
  }
  assert.equal(requests.length, beforeManifest + 4, 'the mutable manifest always uses the network');
  assert(![...stored.keys()].some((key) => key.endsWith('/manifest.json')));

  // Relative glTF dependencies resolve against the model path, and data URIs stay local.
  const seen = [];
  globalThis.ROKA_ASSETS.fetch = async (name) => {
    seen.push(name);
    return name.endsWith('.gltf')
      ? new Response(
          JSON.stringify({
            buffers: [{ uri: 'unit.0123456789abcdef.bin' }],
            images: [{ uri: '../shared/cloth.0123456789abcdef.png' }, { uri: 'data:image/png;base64,AA==' }],
          }),
        )
      : new Response('resource');
  };
  const files = { unit: '/intro/assets/model/unit.0123456789abcdef.gltf' };
  const relative = createIntroAssetLoader({ files });
  const relativeURL = await relative.modelURL('unit');
  const model = JSON.parse(await objects.get(relativeURL).text());
  assert.equal(model.images[1].uri, 'data:image/png;base64,AA==');
  assert.deepEqual(
    new Set(seen),
    new Set([
      '/intro/assets/model/unit.0123456789abcdef.gltf',
      '/intro/assets/model/unit.0123456789abcdef.bin',
      '/intro/assets/shared/cloth.0123456789abcdef.png',
    ]),
  );
  const nestedRequests = seen.length;
  relative.dispose();
  const cachedRelative = createIntroAssetLoader({ files });
  const cachedRelativeURL = await cachedRelative.modelURL('unit');
  const cachedModel = JSON.parse(await objects.get(cachedRelativeURL).text());
  assert.equal(seen.length, nestedRequests, 'nested glTF dependencies persist across loader disposal');
  assert.equal(await objects.get(cachedModel.buffers[0].uri).text(), 'resource');
  cachedRelative.dispose();

  const cachedAbort = new AbortController();
  const cancelledHit = createIntroAssetLoader({ signal: cachedAbort.signal });
  const hit = cancelledHit.blobURL('/intro/assets/model/unit.0123456789abcdef.bin');
  cachedAbort.abort();
  await assert.rejects(hit, { name: 'AbortError' });
  assert.equal(seen.length, nestedRequests, 'cancelled cache hits never fall through to the network');
  cancelledHit.dispose();

  // Decoding/response consumption can finish after cancellation: never allocate a late URL.
  let finish;
  globalThis.ROKA_ASSETS.fetch = async () => ({
    ok: true,
    blob: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const controller = new AbortController(),
    pendingLoader = createIntroAssetLoader({ signal: controller.signal });
  const pending = pendingLoader.blobURL('/intro/assets/late.png');
  await new Promise((resolve) => setImmediate(resolve));
  const before = serial;
  controller.abort();
  finish(new Blob(['late']));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(serial, before, 'late response allocates no leaked object URL');
  pendingLoader.dispose();

  // Native fetch remains supported for standalone previews without Cache Storage or the site runtime.
  delete globalThis.ROKA_ASSETS;
  delete globalThis.caches;
  globalThis.fetch = async (name) => {
    assert.equal(name, '/intro/assets/local.0123456789abcdef.json');
    return new Response('{"standalone":true}');
  };
  const standalone = createIntroAssetLoader();
  assert.deepEqual(await standalone.json('/intro/assets/local.0123456789abcdef.json'), {
    standalone: true,
  });
  standalone.dispose();

  globalThis.caches = { open: async () => cache };
  let fallbackRequests = 0;
  globalThis.ROKA_ASSETS = {};
  globalThis.ROKA_ASSETS.fetch = async () => {
    fallbackRequests++;
    return new Response('fallback');
  };
  cacheState.failPut = true;
  for (let i = 0; i < 2; i++) {
    const fallback = createIntroAssetLoader();
    const url = await fallback.blobURL('/intro/assets/quota.0123456789abcdef.txt');
    assert.equal(await objects.get(url).text(), 'fallback', 'cache quota failures preserve playback');
    fallback.dispose();
  }
  assert.equal(fallbackRequests, 2, 'failed cache writes do not create false hits');
  cacheState.failPut = false;

  let errorRequests = 0;
  globalThis.ROKA_ASSETS.fetch = async () => {
    errorRequests++;
    return errorRequests === 1 ? new Response('unavailable', { status: 503 }) : new Response('{"ok":true}');
  };
  const errors = createIntroAssetLoader();
  await assert.rejects(errors.json('/intro/assets/error.0123456789abcdef.json'), /503/);
  errors.dispose();
  const retry = createIntroAssetLoader();
  assert.deepEqual(await retry.json('/intro/assets/error.0123456789abcdef.json'), { ok: true });
  assert.equal(errorRequests, 2, 'error responses are never cached');
  retry.dispose();

  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const pendingRequests = new Map();
  globalThis.ROKA_ASSETS.fetch = (name) => {
    const task = deferred();
    pendingRequests.set(name, task);
    return task.promise;
  };
  const parallelFiles = {
    model: '/intro/assets/parallel.0123456789abcdef.gltf',
    data: '/intro/assets/parallel.0123456789abcdef.json',
    image: '/intro/assets/parallel.0123456789abcdef.png',
    font: '/intro/assets/parallel.0123456789abcdef.woff2',
  };
  const parallel = createIntroAssetLoader({ files: parallelFiles });
  const progress = [];
  const preloading = parallel.preload({ onProgress: (...args) => progress.push(args) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(progress, [[0, 4]], 'progress starts with a stable top-level total');
  assert.deepEqual(
    new Set(pendingRequests.keys()),
    new Set(Object.values(parallelFiles)),
    'every top-level request starts before any response completes',
  );
  for (const name of ['data', 'image', 'font'])
    pendingRequests.get(parallelFiles[name]).resolve(new Response('asset'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(progress.at(-1)[0], 3);
  pendingRequests.get(parallelFiles.model).resolve(
    new Response(
      JSON.stringify({
        buffers: [{ uri: 'first.0123456789abcdef.bin' }],
        images: [{ uri: 'second.0123456789abcdef.png' }],
      }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const firstDependency = '/intro/assets/first.0123456789abcdef.bin';
  const secondDependency = '/intro/assets/second.0123456789abcdef.png';
  assert(
    pendingRequests.has(firstDependency) && pendingRequests.has(secondDependency),
    'nested glTF dependencies start together',
  );
  assert.equal(progress.at(-1)[0], 3, 'a glTF parent is incomplete while its dependencies are pending');
  pendingRequests.get(firstDependency).resolve(new Response('first'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(progress.at(-1)[0], 3, 'one nested response does not complete its parent task');
  pendingRequests.get(secondDependency).resolve(new Response('second'));
  await preloading;
  assert.deepEqual(progress.at(-1), [4, 4]);
  assert(
    progress.every(([, total]) => total === 4),
    'nested dependencies never grow the total',
  );
  assert(progress.every(([completed], index) => index === 0 || completed === progress[index - 1][0] + 1));
  assert.equal(
    new Set(progress.map(([completed]) => completed)).size,
    5,
    'each top-level task counts exactly once',
  );
  parallel.dispose();

  const reuseFiles = {
    model: '/intro/assets/reuse.0123456789abcdef.gltf',
    data: '/intro/assets/reuse.0123456789abcdef.json',
    image: '/intro/assets/reuse.0123456789abcdef.png',
    font: '/intro/assets/reuse.0123456789abcdef.woff2',
  };
  const reuseRequests = new Map();
  globalThis.ROKA_ASSETS.fetch = async (name) => {
    reuseRequests.set(name, (reuseRequests.get(name) || 0) + 1);
    if (name.endsWith('.gltf'))
      return new Response(JSON.stringify({ buffers: [{ uri: 'nested.0123456789abcdef.bin' }] }));
    return new Response(name.endsWith('.json') ? '{"ok":true}' : 'asset');
  };
  delete globalThis.caches;
  const uncached = createIntroAssetLoader({ files: reuseFiles });
  await uncached.preload();
  await uncached.json('data');
  await uncached.blob('image');
  await uncached.blobURL('font');
  await uncached.modelURL('model');
  assert([...reuseRequests.values()].every((count) => count === 1));
  assert.equal(reuseRequests.size, 5, 'preload and decode share blobs without Cache Storage');
  uncached.dispose();

  globalThis.caches = { open: async () => cache };
  const cold = createIntroAssetLoader({ files: reuseFiles });
  await cold.preload();
  cold.dispose();
  const beforeWarm = [...reuseRequests.values()].reduce((sum, count) => sum + count, 0);
  const warm = createIntroAssetLoader({ files: reuseFiles });
  await warm.preload();
  await warm.json('data');
  await warm.blob('image');
  await warm.blobURL('font');
  await warm.modelURL('model');
  const afterWarm = [...reuseRequests.values()].reduce((sum, count) => sum + count, 0);
  assert.equal(afterWarm, beforeWarm, 'a warm preloaded loader never returns to the network');
  warm.dispose();

  const scene = await fs.readFile(path.join(root, 'static/intro/scene.js'), 'utf8');
  assert.match(scene, /imageOrientation:\s*'flipY'/);
  assert.match(scene, /premultiplyAlpha:\s*'none'/);
  assert.match(scene, /texture\.flipY\s*=\s*false/);
  assert.match(scene, /HDRLoader\(manager\)/);
  assert.match(scene, /blobURL\(BASE \+ 'sky\.hdr'\)/);
  assert(!scene.includes('fetch('), 'Three scene remote requests must go through the resource owner');
  const entry = await fs.readFile(path.join(root, 'static/intro.js'), 'utf8');
  assert.match(entry, /window\.ROKA_ASSETS\.import\('/);
  console.log(
    'intro CDN: parallel preload, stable progress, persistent/no-cache reuse, fresh manifests, nested glTF, fallbacks, cancellation, and decode orientation passed',
  );
} finally {
  globalThis.fetch = original.fetch;
  if (original.runtime === undefined) delete globalThis.ROKA_ASSETS;
  else globalThis.ROKA_ASSETS = original.runtime;
  if (original.caches === undefined) delete globalThis.caches;
  else globalThis.caches = original.caches;
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
}
