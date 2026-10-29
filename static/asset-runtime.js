// Injected before page assets. Providers are immutable commit/static prefixes;
// application origin is deliberately the final fallback, never an API proxy.
(function () {
  'use strict';
  if (window.ROKA_ASSETS) return;
  var config = window.ROKA_ASSET_CONFIG || {};
  var origin = window.location.origin + '/';
  var bases = (config.bases && config.bases.length ? config.bases : [origin]).map(function (base) {
    return new URL(String(base).replace(/\/?$/, '/'), origin).href;
  });
  var override = config.commits && !Object.keys(config.commits).length ? config.commit : '';
  var nativeFetch = window.fetch.bind(window);
  var scripts = new Map();
  var modules = new Map();
  var retries = new WeakMap();
  var normalQueue = [];
  var deferredQueue = [];
  var readyWaiters = [];
  var started = document.readyState !== 'loading';
  var draining = false;
  var firstError = null;
  var styles = [];

  function isApplicationPath(path) {
    return /^\/(?:api(?:\/|$)|socket\.io(?:\/|$))/.test(path);
  }

  function locate(value) {
    if (typeof value !== 'string' && !(value instanceof URL)) return null;
    var text = String(value);
    if (!text || /^(?:data:|blob:|javascript:|#)/i.test(text)) return null;
    if (/\\|%2e|%2f|%5c/i.test(text) || /(?:^|\/)\.\.?(?:\/|[?#]|$)/.test(text)) return null;
    var parsed;
    try {
      parsed = new URL(text, origin);
    } catch (_) {
      return null;
    }
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (parsed.origin === window.location.origin && isApplicationPath(parsed.pathname)) return null;
    for (var index = 0; index < bases.length; index++) {
      var prefix = bases[index].replace(/@[a-f0-9]{40}\/static\/$/, '@');
      if (bases[index] !== origin && parsed.href.indexOf(prefix) === 0) {
        var match = /^([a-f0-9]{40})\/static\/(.*)$/.exec(parsed.href.slice(prefix.length));
        if (match) return { path: match[2], index: index };
      }
      if (parsed.href.indexOf(bases[index]) === 0)
        return { path: parsed.href.slice(bases[index].length), index: index };
    }
    if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(text)) {
      return { path: parsed.pathname.slice(1) + parsed.search + parsed.hash, index: 0 };
    }
    return null;
  }

  function candidates(path) {
    var resource = locate(path);
    if (!resource) return [path];
    var parsed = new URL('/' + resource.path, origin);
    var sha = config.commits ? config.commits[parsed.pathname] : config.commit;
    // An empty map with an override intentionally pins every file.
    if (override) sha = override;
    if (!sha) return [origin + resource.path];
    parsed.searchParams.delete('v');
    return bases.map(function (base) {
      return base === origin
        ? origin + resource.path
        : base.replace(/@[a-f0-9]{40}\/static\/$/, '@' + sha + '/static/') +
            parsed.pathname.slice(1) +
            parsed.search +
            parsed.hash;
    });
  }

  function url(path, index) {
    var choices = candidates(path);
    return choices[Math.min(index || 0, choices.length - 1)];
  }

  // Browsers resolve CSS relatives against the parent commit. Fetch and rewrite
  // the dependency graph instead, so every child keeps its own immutable URL.
  var cssResources = new Map();
  var cssBytes = new Map();
  function dependencyBlob(path) {
    var key = url(path);
    if (!cssBytes.has(key))
      cssBytes.set(
        key,
        fetchAsset(path)
          .then(function (response) {
            return response.blob();
          })
          .then(function (blob) {
            return URL.createObjectURL(blob);
          }),
      );
    return cssBytes.get(key);
  }
  function cssBlob(path, integrity) {
    var key = url(path);
    if (cssResources.has(key)) return cssResources.get(key);
    var promise = (async function () {
      var response = await fetchAsset(path, integrity ? { integrity: integrity } : {});
      var text = await response.text();
      var matches = Array.from(
        text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?|url\(\s*["']?([^"')\s]+)["']?\s*\)/gi),
      );
      var replacements = await Promise.all(
        matches.map(async function (match) {
          var relative = match[1] || match[2];
          if (/^(?:data:|blob:|#)/i.test(relative)) return match[0];
          var parent = locate(path);
          var resolved = new URL(relative, new URL(parent ? '/' + parent.path : path, origin));
          var local =
            resolved.origin === window.location.origin
              ? resolved.pathname + resolved.search + resolved.hash
              : resolved.href;
          if (match[1]) return '@import url("' + (await cssBlob(local)) + '")';
          return 'url("' + (await dependencyBlob(local)) + '")';
        }),
      );
      for (var index = matches.length - 1; index >= 0; index--) {
        var match = matches[index];
        text = text.slice(0, match.index) + replacements[index] + text.slice(match.index + match[0].length);
      }
      return URL.createObjectURL(new Blob([text], { type: 'text/css' }));
    })();
    cssResources.set(key, promise);
    return promise;
  }
  function stylesheet(path, integrity, attrs) {
    var link = document.createElement('link');
    applyAttributes(link, attrs);
    link.removeAttribute('href');
    link.rel = 'stylesheet';
    document.head.append(link);
    var pending = cssBlob(path, integrity).then(function (href) {
      return new Promise(function (resolve, reject) {
        link.onload = resolve;
        link.onerror = reject;
        link.href = href;
      });
    });
    styles.push(pending);
    pending.catch(function (error) {
      firstError = firstError || error;
    });
    return pending;
  }

  function abortReason(signal) {
    return signal.reason || new DOMException('Aborted', 'AbortError');
  }

  async function fetchAsset(path, options) {
    options = options || {};
    var signal = options.signal;
    if (signal && signal.aborted) throw abortReason(signal);
    if (!locate(path) || (options.method && !/^(?:GET|HEAD)$/i.test(options.method))) {
      return nativeFetch(path, options);
    }
    var providers = candidates(path);
    var lastError;
    for (var index = 0; index < providers.length; index++) {
      if (signal && signal.aborted) throw abortReason(signal);
      var controller = new AbortController();
      var timedOut = false;
      var detach = null;
      var attemptSignal = controller.signal;
      if (signal) {
        if (typeof AbortSignal.any === 'function') {
          attemptSignal = AbortSignal.any([signal, controller.signal]);
        } else {
          var forwardAbort = controller.abort.bind(controller);
          signal.addEventListener('abort', forwardAbort, { once: true });
          detach = function () {
            signal.removeEventListener('abort', forwardAbort);
          };
        }
      }
      var timeout = setTimeout(function () {
        timedOut = true;
        controller.abort(new DOMException('Asset provider timed out', 'TimeoutError'));
      }, 8000);
      var succeeded = false;
      try {
        var response = await nativeFetch(
          providers[index],
          Object.assign({}, options, { signal: attemptSignal }),
        );
        if (signal && signal.aborted) throw abortReason(signal);
        if (!response.ok) {
          if (response.body) response.body.cancel().catch(function () {});
          throw new Error('Static asset request failed: ' + response.status);
        }
        succeeded = true;
        return response;
      } catch (error) {
        if (signal && signal.aborted) throw abortReason(signal);
        if (!timedOut && error && error.name === 'AbortError') throw error;
        lastError = error;
      } finally {
        clearTimeout(timeout);
        // Keep older browsers' successful response bodies linked to caller cancellation.
        if (detach && !succeeded) detach();
      }
    }
    throw lastError;
  }

  function importAsset(path) {
    var key = url(path);
    if (modules.has(key)) return modules.get(key);
    var promise = (async function () {
      var providers = candidates(path);
      var lastError;
      for (var index = 0; index < providers.length; index++) {
        try {
          return await import(providers[index]);
        } catch (error) {
          // Evaluated module exceptions must not execute the same code at another URL.
          // Browsers report transport/CORS failures using these native TypeError messages.
          if (
            !error ||
            error.name !== 'TypeError' ||
            !/failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script/i.test(
              error.message,
            )
          )
            throw error;
          lastError = error;
        }
      }
      throw lastError;
    })();
    modules.set(key, promise);
    promise.catch(function () {
      modules.delete(key);
    });
    return promise;
  }

  function applyAttributes(node, attrs) {
    Object.keys(attrs || {}).forEach(function (name) {
      if (/^(?:src|integrity)$/i.test(name)) return;
      var value = attrs[name];
      if (value === false || value === null || value === undefined) return;
      node.setAttribute(name, value === true ? '' : String(value));
    });
  }

  function insertScript(descriptor, body, source) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.async = false;
      applyAttributes(script, descriptor.attrs);
      if (descriptor.integrity) script.integrity = descriptor.integrity;
      else if (descriptor.attrs && descriptor.attrs.integrity) {
        script.integrity = descriptor.attrs.integrity;
      }
      // SRI on a cross-origin script requires a CORS-enabled response. Site scripts
      // originally loaded from app origin may not have carried crossorigin in HTML.
      if (source && script.integrity && !script.hasAttribute('crossorigin')) {
        script.crossOrigin = 'anonymous';
      }
      var type = (script.getAttribute('type') || '').toLowerCase();
      var executable =
        !script.noModule && (!type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(type));
      if (source && executable) {
        script.onload = function () {
          script.onload = script.onerror = null;
          resolve(script);
        };
        script.onerror = function () {
          script.onload = script.onerror = null;
          script.remove();
          reject(new Error('Static script unavailable: ' + source));
        };
      } else if (type === 'module') {
        script.onload = function () {
          resolve(script);
        };
        script.onerror = function () {
          reject(new Error('Inline module unavailable'));
        };
      }
      if (source) script.src = source;
      else script.text = body || '';
      (document.head || document.documentElement).append(script);
      if ((!source && type !== 'module') || !executable) resolve(script);
      // Removing a timed-out script cannot prevent late execution. Retry only actual
      // load/SRI errors, so providers can never race and execute this script twice.
    });
  }

  async function execute(job) {
    var descriptor = job.descriptor;
    if (!descriptor.src) return insertScript(descriptor, job.body);
    var providers = candidates(descriptor.src);
    var lastError;
    for (var index = 0; index < providers.length; index++) {
      try {
        return await insertScript(descriptor, null, providers[index]);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function settleReady() {
    if (!started || draining || normalQueue.length || deferredQueue.length) return;
    readyWaiters.splice(0).forEach(function (waiter) {
      if (firstError) waiter.reject(firstError);
      else waiter.resolve();
    });
  }

  async function drain() {
    if (!started || draining) return;
    draining = true;
    await Promise.allSettled(styles);
    while (normalQueue.length || deferredQueue.length) {
      var job = normalQueue.length ? normalQueue.shift() : deferredQueue.shift();
      try {
        job.resolve(await execute(job));
      } catch (error) {
        firstError = firstError || error;
        job.reject(error);
      }
    }
    draining = false;
    settleReady();
  }

  function enqueue(descriptor, body) {
    descriptor = descriptor || {};
    var attrs = descriptor.attrs || {};
    var key = descriptor.src
      ? url(descriptor.src) +
        '\n' +
        (attrs.type || '') +
        '\n' +
        (descriptor.integrity || attrs.integrity || '')
      : null;
    if (key && scripts.has(key)) return scripts.get(key);
    var job = { descriptor: descriptor, body: body };
    var promise = new Promise(function (resolve, reject) {
      job.resolve = resolve;
      job.reject = reject;
    });
    // Server-produced enqueue calls intentionally do not attach rejection handlers.
    // Keep failures observable to callers/ready without creating unhandled rejections.
    promise.catch(function () {});
    if (key) scripts.set(key, promise);
    var deferred =
      Object.prototype.hasOwnProperty.call(attrs, 'defer') &&
      attrs.defer !== false &&
      attrs.defer !== null &&
      attrs.defer !== undefined;
    (deferred || String(attrs.type).toLowerCase() === 'module' ? deferredQueue : normalQueue).push(job);
    Promise.resolve().then(drain);
    return promise;
  }

  var api = { url: url, fetch: fetchAsset, import: importAsset, enqueue: enqueue, stylesheet: stylesheet };
  Object.defineProperty(api, 'ready', {
    get: function () {
      var promise = new Promise(function (resolve, reject) {
        readyWaiters.push({ resolve: resolve, reject: reject });
        settleReady();
      });
      promise.catch(function () {});
      return promise;
    },
  });
  window.ROKA_ASSETS = api;
  if (!started) {
    document.addEventListener(
      'DOMContentLoaded',
      function () {
        started = true;
        drain();
      },
      { once: true },
    );
  }

  function rewriteSrcset(value, index) {
    // Data URLs can contain commas; they are unrelated to configured asset providers.
    if (!value || /\bdata:/i.test(value)) return value;
    return value
      .split(',')
      .map(function (candidate) {
        var match = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate);
        return match && locate(match[2]) ? match[1] + url(match[2], index) + match[3] : candidate;
      })
      .join(',');
  }

  document.addEventListener(
    'error',
    function (event) {
      var node = event.target;
      if (!node || !node.tagName) return;
      var image = node.tagName === 'IMG';
      var stylesheet = node.tagName === 'LINK' && node.relList.contains('stylesheet');
      if (!image && !stylesheet) return;
      var failed = image ? node.currentSrc || node.getAttribute('src') : node.href;
      var resource = locate(failed);
      if (!resource || resource.index >= bases.length - 1) return;
      var previous = retries.get(node);
      if (previous && previous.path === resource.path && previous.index > resource.index) return;
      var next = resource.index + 1;
      retries.set(node, { path: resource.path, index: next });
      if (image) {
        if (node.hasAttribute('srcset')) {
          node.setAttribute('srcset', rewriteSrcset(node.getAttribute('srcset'), next));
        }
        var picture = node.closest('picture');
        if (picture) {
          picture.querySelectorAll('source[srcset]').forEach(function (source) {
            source.setAttribute('srcset', rewriteSrcset(source.getAttribute('srcset'), next));
          });
        }
        node.src = url(node.getAttribute('src') || failed, next);
      } else {
        node.href = url(failed, next);
      }
    },
    true,
  );
})();
