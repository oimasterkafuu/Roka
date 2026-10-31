import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { StaticAssetDelivery } from '../dist/server/static-assets.js';
const cwd = mkdtempSync(path.join(os.tmpdir(), 'roka-file-history-'));
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
try {
  mkdirSync(path.join(cwd, 'static/styles'), { recursive: true });
  copyFileSync('static/asset-runtime.js', path.join(cwd, 'static/asset-runtime.js'));
  git('init');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = (name, data) => writeFileSync(path.join(cwd, 'static', name), data);
  const commit = () => {
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  write('a.js', 'a');
  write('b.js', 'b');
  write('sw.js', 'worker');
  write('main.css', '@import "styles/base.css";');
  write('styles/base.css', '@font-face{src:url(../font.woff2)}');
  write('font.woff2', 'font');
  const first = commit();
  write('a.js', 'a2');
  const second = commit();
  const delivery = new StaticAssetDelivery('2.0.1', cwd, {});
  assert(delivery.url('/a.js').includes('@' + second + '/'));
  assert(delivery.url('/b.js').includes('@' + first + '/'));
  const stable = delivery.url('/b.js?v=2.0.1');
  const workers = [];
  vm.runInNewContext(delivery.worker(''), {
    importScripts(url) {
      workers.push(url);
      if (url.startsWith('https:')) throw new Error('offline');
    },
  });
  assert.equal(workers.at(-1), '/sw.js?source=1');
  assert(workers.slice(0, -1).every((url) => url.includes('@' + first + '/static/sw.js')));

  write('a.js', 'a3');
  commit();
  const next = new StaticAssetDelivery('2.1.0', cwd, {});
  assert.equal(next.url('/b.js?v=2.1.0'), stable);
  assert(!stable.includes('?v='));
  assert.equal(next.url('/b.js?x=1&v=2#hash'), next.url('/b.js') + '?x=1#hash');
  for (const file of ['/main.css', '/styles/base.css', '/font.woff2', '/sw.js'])
    assert(next.url(file).includes('@' + first + '/'));
  write('unknown.js', 'local');
  assert.equal(next.url('/unknown.js'), '/unknown.js');
  for (const unsafe of [
    '/../package.json',
    '/styles/../b.js',
    '/%2e%2e/b.js',
    '/api/test.json',
    '/socket.io/socket.io.js',
  ])
    assert.equal(next.url(unsafe), unsafe);
  const override = new StaticAssetDelivery('2.1.0', cwd, { ROKA_STATIC_COMMIT: first });
  assert(override.url('/a.js').includes('@' + first + '/'));
  assert(override.worker('').includes('@' + first + '/static/sw.js'));
  const html = next.html(
    '<head></head><script src="/b.js?v=2.1.0"></script><link rel="stylesheet" href="/main.css?v=2.1.0">',
  );
  assert(html.includes(stable));
  assert(html.includes('ROKA_ASSETS.stylesheet'));
  // Browser-valid script endings must preserve bodies during URL rewriting.
  for (const end of ['</script >', '</ScRiPt foo="bar">', '</script/>', '</script\n>']) {
    const body = 'window.fixture="/b.js";';
    const transformed = next.html('<head></head><script>' + body + end + '<img src="/b.js">');
    const calls = [];
    const scripts = [...transformed.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    vm.runInNewContext(scripts.at(-1)[1], {
      window: { ROKA_ASSETS: { enqueue: (...args) => calls.push(args) } },
    });
    assert.equal(calls[0][1], body, end);
    assert(transformed.includes('<img src="' + stable + '">'), end);
    const external = '<script src="https://example.invalid/a.js">' + body + end;
    assert(next.html('<head></head>' + external).includes(external), end);
  }
  const shallowCwd = cwd + '-shallow';
  try {
    execFileSync('git', ['clone', '--depth=1', 'file://' + cwd, shallowCwd], { stdio: 'ignore' });
    assert.equal(new StaticAssetDelivery('2.1.0', shallowCwd, {}).url('/b.js'), '/b.js');
  } finally {
    rmSync(shallowCwd, { recursive: true, force: true });
  }
  rmSync(path.join(cwd, '.git'), { recursive: true });
  assert.equal(new StaticAssetDelivery('2.1.0', cwd, {}).url('/b.js'), '/b.js');
  console.log('Per-file Git history, stable URLs, CSS graph, override and safe fallback passed.');
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
