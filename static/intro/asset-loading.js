const INTRO_CACHE = 'roka-intro-assets-v1';

function introCacheKey(path) {
  const url = new URL(path, globalThis.location?.origin || 'https://roka.invalid');
  if (!url.pathname.startsWith('/intro/assets/') || !/\.[a-f0-9]{16}\./.test(url.pathname)) return null;
  return new URL(url.pathname + url.search, globalThis.location?.origin || 'https://roka.invalid').href;
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function fetchIntroAsset(path, options = {}) {
  const { signal } = options;
  abortIfNeeded(signal);
  const key = introCacheKey(path);
  let cache;
  if (key) {
    try {
      cache = await globalThis.caches.open(INTRO_CACHE);
      abortIfNeeded(signal);
      const cached = await cache.match(key);
      abortIfNeeded(signal);
      if (cached) return cached;
    } catch (error) {
      abortIfNeeded(signal);
    }
  }
  const runtime = globalThis.ROKA_ASSETS;
  const response = await (runtime?.fetch ? runtime.fetch(path, options) : fetch(path, options));
  abortIfNeeded(signal);
  if (cache && response.ok) {
    try {
      await cache.put(key, response.clone());
      abortIfNeeded(signal);
    } catch (error) {
      abortIfNeeded(signal);
    }
  }
  return response;
}

/** All remote bytes go through the commit-pinned runtime before Three sees them.
 * Blob URLs keep nested glTF requests on that same asset revision and avoid
 * cross-origin canvas taint when recoloring decoded model textures.
 */
export function createIntroAssetLoader({ files = {}, signal } = {}) {
  const local = new AbortController();
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const blobs = new Map(),
    urls = new Map(),
    models = new Map(),
    owned = new Set();
  let disposed = false;
  const check = () => {
    if (disposed || combined.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const resolve = (name) => files[name] || name;
  function fetchAsset(path) {
    return fetchIntroAsset(path, { signal: combined });
  }
  function blob(name) {
    check();
    const path = resolve(name);
    if (!blobs.has(path))
      blobs.set(
        path,
        (async () => {
          const response = await fetchAsset(path);
          if (!response.ok) throw new Error(`Intro asset ${path}: ${response.status}`);
          const result = await response.blob();
          check();
          return result;
        })(),
      );
    return blobs.get(path);
  }
  async function json(name) {
    const result = JSON.parse(await (await blob(name)).text());
    check();
    return result;
  }
  function ownURL(value) {
    check();
    const url = URL.createObjectURL(value);
    owned.add(url);
    return url;
  }
  function blobURL(name) {
    check();
    const path = resolve(name);
    if (!urls.has(path)) urls.set(path, blob(path).then(ownURL));
    return urls.get(path);
  }
  function resourcePath(uri, modelPath) {
    const value = resolve(uri);
    if (/^(?:data:|blob:)/i.test(value)) return value;
    // Manifest entries and generated glTF dependencies use repository-root paths.
    // Relative dependencies are resolved against the model, never the page URL.
    const base = new URL(modelPath, 'https://intro.invalid');
    const url = new URL(value, base);
    return url.origin === base.origin ? url.pathname + url.search : value;
  }
  function modelURL(name) {
    check();
    const path = resolve(name);
    if (!/\.gltf(?:\?|$)/i.test(path)) return blobURL(path);
    if (!models.has(path))
      models.set(
        path,
        (async () => {
          const data = await json(path);
          await Promise.all(
            [...(data.buffers || []), ...(data.images || [])].map(async (entry) => {
              if (!entry.uri || /^(?:data:|blob:)/i.test(entry.uri)) return;
              entry.uri = await blobURL(resourcePath(entry.uri, path));
            }),
          );
          check();
          return ownURL(new Blob([JSON.stringify(data)], { type: 'model/gltf+json' }));
        })(),
      );
    return models.get(path);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    local.abort();
    signal?.removeEventListener('abort', dispose);
    for (const url of owned) URL.revokeObjectURL(url);
    owned.clear();
    blobs.clear();
    urls.clear();
    models.clear();
  }
  signal?.addEventListener('abort', dispose, { once: true });
  return { json, blobURL, modelURL, dispose };
}
