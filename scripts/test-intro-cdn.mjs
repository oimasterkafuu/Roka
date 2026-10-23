import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const code = await fs.readFile(path.join(root, 'static/intro/asset-loading.js'), 'utf8');
const { createIntroAssetLoader } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const original = {
  fetch: globalThis.fetch,
  runtime: globalThis.ROKA_ASSETS,
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};
const objects = new Map(),
  revoked = [],
  requests = [];
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
  const count = objects.size;
  loader.dispose();
  loader.dispose();
  assert.equal(revoked.length, count, 'all model and dependency URLs are revoked exactly once');
  assert.throws(() => loader.blobURL('ground.jpg'), { name: 'AbortError' });

  // Relative glTF dependencies resolve against the model path, and data URIs stay local.
  const seen = [];
  globalThis.ROKA_ASSETS.fetch = async (name) => {
    seen.push(name);
    return name.endsWith('.gltf')
      ? new Response(
          JSON.stringify({
            buffers: [{ uri: 'unit.bin' }],
            images: [{ uri: '../shared/cloth.png' }, { uri: 'data:image/png;base64,AA==' }],
          }),
        )
      : new Response('resource');
  };
  const relative = createIntroAssetLoader({ files: { unit: '/intro/assets/model/unit.gltf' } });
  const relativeURL = await relative.modelURL('unit');
  const model = JSON.parse(await objects.get(relativeURL).text());
  assert.equal(model.images[1].uri, 'data:image/png;base64,AA==');
  assert.deepEqual(
    new Set(seen),
    new Set([
      '/intro/assets/model/unit.gltf',
      '/intro/assets/model/unit.bin',
      '/intro/assets/shared/cloth.png',
    ]),
  );
  relative.dispose();

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

  // Native fetch remains supported for standalone previews without the site runtime.
  delete globalThis.ROKA_ASSETS;
  globalThis.fetch = async (name) => {
    assert.equal(name, '/intro/assets/local.json');
    return new Response('{"standalone":true}');
  };
  const standalone = createIntroAssetLoader();
  assert.deepEqual(await standalone.json('/intro/assets/local.json'), { standalone: true });
  standalone.dispose();

  const scene = await fs.readFile(path.join(root, 'static/intro/scene.js'), 'utf8');
  assert.match(scene, /imageOrientation:\s*'flipY'/);
  assert.match(scene, /premultiplyAlpha:\s*'none'/);
  assert.match(scene, /texture\.flipY\s*=\s*false/);
  assert.match(scene, /HDRLoader\(manager\)\)\.loadAsync\(await assetLoader\.blobURL/);
  assert(!scene.includes('fetch('), 'Three scene remote requests must go through the resource owner');
  const entry = await fs.readFile(path.join(root, 'static/intro.js'), 'utf8');
  assert.match(entry, /window\.ROKA_ASSETS\.import\('/);
  console.log(
    'intro CDN: pinned nested glTF resources, deduplicated textures, standalone fallback, abort cleanup, and decode orientation passed',
  );
} finally {
  globalThis.fetch = original.fetch;
  if (original.runtime === undefined) delete globalThis.ROKA_ASSETS;
  else globalThis.ROKA_ASSETS = original.runtime;
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
}
