// Roka 静态资源版本号注入测试：临时数据目录 + 随机端口启动 dist/server.js，断言
//   1) 首页（/）与对局页（/games/:id，需登录）响应中所有本地 .js/.css 引用均携带
//      ?v=<package.json version>（外部 CDN 引用不受影响）；
//   2) /main.css 响应中的 @import 行均携带同一版本号；
//   3) 带 ?v= 查询参数的静态资源请求返回 200 且内容正确（模板文件已替换占位符，
//      @fastify/static 直发文件忽略未知 query）；
//   4) 模板路由保持原缓存头语义（ETag + If-None-Match 304）。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 60 秒（不跑对局）。

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const jwt = require('jsonwebtoken');

const serverEntry = path.join(rootDir, 'dist', 'server.js');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const HARD_TIMEOUT_MS = 60_000;
const SERVER_READY_TIMEOUT_MS = 20_000;
const TEST_USER = 'assetver_user';

const startedAt = Date.now();
const children = new Set();
let dataDir = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-asset-versioning ${elapsed}s] ${message}`);
}

function assert(condition, label) {
  if (!condition) {
    log(`断言失败：${label}`);
    throw new Error(`断言失败：${label}`);
  }
  log(`通过：${label}`);
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 2000).unref();
}

function cleanup() {
  for (const child of children) {
    killChild(child);
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      log(`已清理临时数据目录 ${dataDir}`);
    } catch (error) {
      log(`清理临时数据目录失败：${error.message}`);
    }
  }
}

function finish(code) {
  if (finished) return;
  finished = true;
  cleanup();
  setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => finish(1));
process.on('SIGTERM', () => finish(1));
setTimeout(() => {
  log('硬超时，判定失败');
  finish(1);
}, HARD_TIMEOUT_MS).unref();

function ensureBuild() {
  if (fs.existsSync(serverEntry)) {
    return;
  }
  log('dist/server.js 不存在，先执行 pnpm run build');
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0 || !fs.existsSync(serverEntry)) {
    throw new Error('构建失败，无法启动服务器');
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitServerReady(baseUrl) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/version`);
      if (res.ok) return;
    } catch {
      // 服务未就绪，继续等待
    }
    await sleep(200);
  }
  throw new Error('服务器就绪等待超时');
}

async function prepareUserToken(dir) {
  // 直接用编译产物造用户，绕过注册验证码；对局页 /games/:id 需登录。
  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const { ensureRuntimeEnv } = await import(pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href);
  const store = new UserStore(dir);
  await store.ensureReady();
  await store.register(TEST_USER, 'assetver-pass-1');
  const sid = await store.rotateSession(TEST_USER);
  const env = ensureRuntimeEnv();
  return jwt.sign({ sub: TEST_USER, sid }, env.jwtSecret, { expiresIn: '1h' });
}

async function getText(baseUrl, urlPath, token) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    headers: token ? { cookie: `auth_token=${encodeURIComponent(token)}` } : {},
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

// 页面内所有本地 .js/.css 引用必须携带 ?v=<version>；外部 CDN 引用不动。
function assertVersionedReferences(html, pageLabel) {
  const refPattern = /(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g;
  let match;
  let localCount = 0;
  while ((match = refPattern.exec(html)) !== null) {
    const url = match[1];
    if (/^(https?:)?\/\//.test(url)) {
      continue; // 外部 CDN
    }
    localCount += 1;
    assert(url.includes(`?v=${VERSION}`), `${pageLabel} 本地引用携带版本号：${url}`);
  }
  assert(localCount > 0, `${pageLabel} 存在本地 .js/.css 引用`);
  assert(!html.includes('{{V}}'), `${pageLabel} 无残留 {{V}} 占位符`);
}

async function main() {
  ensureBuild();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-assetver-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`临时数据目录：${dataDir}，端口：${port}，期望版本号：${VERSION}`);

  const token = await prepareUserToken(dataDir);
  const server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: { ...process.env, ROKA_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(server);
  await waitServerReady(baseUrl);
  log('服务器已就绪');

  // 1) 首页与对局页的本地 .js/.css 引用均携带 ?v=<version>。
  const home = await getText(baseUrl, '/');
  assert(home.status === 200, '首页 / 返回 200');
  assert(home.body.includes(`/main.css?v=${VERSION}`), '首页 /main.css 引用携带版本号');
  assertVersionedReferences(home.body, '首页');

  const game = await getText(baseUrl, '/games/assetver', token);
  assert(game.status === 200, '对局页 /games/assetver 返回 200');
  assert(game.body.includes(`/main.js?v=${VERSION}`), '对局页 /main.js 引用携带版本号');
  assert(game.body.includes(`/main.css?v=${VERSION}`), '对局页 /main.css 引用携带版本号');
  assertVersionedReferences(game.body, '对局页');

  // 2) /main.css 的 @import 行均携带同一版本号。
  const mainCss = await getText(baseUrl, '/main.css');
  assert(mainCss.status === 200, '/main.css 返回 200');
  const importLines = mainCss.body.split('\n').filter((line) => line.includes('@import'));
  assert(importLines.length > 0, '/main.css 存在 @import 行');
  for (const line of importLines) {
    assert(line.includes(`?v=${VERSION}`), `/main.css @import 携带版本号：${line.trim()}`);
  }
  assert(!mainCss.body.includes('{{V}}'), '/main.css 无残留 {{V}} 占位符');

  // 3) 带 ?v= 的静态资源请求返回 200 且内容正确。
  const templatedMainJs = fs
    .readFileSync(path.join(rootDir, 'static', 'main.js'), 'utf8')
    .replaceAll('{{V}}', VERSION);
  const mainJs = await getText(baseUrl, `/main.js?v=${VERSION}`);
  assert(mainJs.status === 200, '/main.js?v= 返回 200');
  assert(mainJs.body === templatedMainJs, '/main.js?v= 内容正确（占位符已替换）');
  assert(mainJs.body.includes(`/gong.mp3?v=${VERSION}`), '/main.js 内音效 URL 携带版本号');

  const swJs = await getText(baseUrl, `/sw.js?v=${VERSION}`);
  assert(swJs.status === 200, '/sw.js?v= 返回 200');
  assert(swJs.body.includes(`/updating.html?v=${VERSION}`), '/sw.js 预缓存 URL 携带版本号');

  const swRegister = await getText(baseUrl, `/sw-register.js?v=${VERSION}`);
  assert(swRegister.status === 200, '/sw-register.js?v= 返回 200');
  assert(swRegister.body.includes(`/sw.js?v=${VERSION}`), '/sw-register.js 注册 URL 携带版本号');

  // @fastify/static 直发资源忽略未知 query，内容原样。
  const baseCssRaw = fs.readFileSync(path.join(rootDir, 'static', 'styles', 'base.css'), 'utf8');
  const baseCss = await getText(baseUrl, `/styles/base.css?v=${VERSION}`);
  assert(baseCss.status === 200 && baseCss.body === baseCssRaw, '/styles/base.css?v= 返回 200 且内容正确');

  const gong = await fetch(`${baseUrl}/gong.mp3?v=${VERSION}`);
  const gongBuf = Buffer.from(await gong.arrayBuffer());
  assert(
    gong.status === 200 && gongBuf.equals(fs.readFileSync(path.join(rootDir, 'static', 'gong.mp3'))),
    '/gong.mp3?v= 返回 200 且内容正确',
  );

  // 4) 模板路由缓存头语义：ETag + If-None-Match 304。
  const etag = mainCss.headers.get('etag');
  assert(etag, '/main.css 响应带 ETag');
  assert(
    (mainCss.headers.get('cache-control') || '').includes('max-age=0'),
    '/main.css 保持 max-age=0 缓存语义',
  );
  const conditional = await fetch(`${baseUrl}/main.css`, { headers: { 'if-none-match': etag } });
  assert(conditional.status === 304, '/main.css If-None-Match 命中返回 304');

  log('全部断言通过');
  finish(0);
}

main().catch((error) => {
  log(`测试异常：${error.stack || error.message}`);
  finish(1);
});
