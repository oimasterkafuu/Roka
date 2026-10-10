// Roka 管理员用户名徽标（issue #92）测试：
// 第一部分（单元）：node vm + 最小 jQuery/fetch 桩驱动 static/username.js，断言
//   管理员名字渲染为 rt-admin + Headquarters 徽标（usernameLinkHtml / usernameLink /
//   usernameCacheSeed / usernameEnsureColors / usernameRefreshRendered 全路径），
//   普通用户渲染完全不变，管理员撤销后徽标摘除；
// 第二部分（集成）：临时数据目录 + 随机端口启动 dist/server.js，断言
//   /api/user-colors、/api/users/search、/api/profile/:username、/api/feeds（authorInfo）、
//   /api/admin/users 各出口均带 admin 标记。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 60 秒（不跑对局）。

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const jwt = require('jsonwebtoken');

const serverEntry = path.join(rootDir, 'dist', 'server.js');

const HARD_TIMEOUT_MS = 60_000;
const SERVER_READY_TIMEOUT_MS = 20_000;

const ADMIN_USER = 'badge_admin';
const GRANTED_ADMIN = 'badge_granted';
const NORMAL_USER = 'badge_user';

const startedAt = Date.now();
const children = new Set();
let dataDir = null;
let finished = false;
let failures = 0;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-admin-badge ${elapsed}s] ${message}`);
}

function assert(condition, label) {
  if (!condition) {
    failures += 1;
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

/* ---------- 第一部分：username.js 纯逻辑断言 ---------- */

// 最小 jQuery 桩：只实现 username.js 用到的 API（attr/addClass/removeClass/text/append/
// appendTo/children/on/each + $(selector)/$(htmlString)/$(element)）。
function createJQueryStub() {
  const rendered = []; // 已渲染且带 data-username 的元素（模拟文档内节点）

  function makeCollection(list) {
    return {
      length: list.length,
      each(fn) {
        list.forEach((el, i) => fn.call(el, i, el));
        return this;
      },
      remove() {
        for (const el of list) {
          el.removed = true;
          if (el.parent) {
            const idx = el.parent.kids.indexOf(el);
            if (idx >= 0) el.parent.kids.splice(idx, 1);
          }
        }
        return this;
      },
    };
  }

  function createEl(tag) {
    const el = {
      tagName: tag,
      attrs: {},
      classes: new Set(),
      kids: [],
      parent: null,
      textContent: '',
      removed: false,
    };
    el.attr = (name, value) => {
      if (value === undefined) return el.attrs[name];
      el.attrs[name] = String(value);
      return el;
    };
    el.addClass = (names) => {
      for (const c of String(names).split(/\s+/)) {
        if (c) el.classes.add(c);
      }
      return el;
    };
    el.removeClass = (names) => {
      for (const c of String(names).split(/\s+/)) {
        if (c) el.classes.delete(c);
      }
      return el;
    };
    el.text = (value) => {
      if (value === undefined) return el.textContent;
      el.textContent = String(value);
      return el;
    };
    el.append = (child) => {
      child.parent = el;
      el.kids.push(child);
      return el;
    };
    el.appendTo = (parent) => {
      parent.append(el);
      return el;
    };
    el.children = (selector) => {
      const cls = selector.replace(/^\./, '');
      return makeCollection(el.kids.filter((kid) => kid.classes.has(cls)));
    };
    el.on = () => el;
    el.each = (fn) => {
      fn.call(el, 0, el);
      return el;
    };
    return el;
  }

  function $(arg) {
    if (typeof arg === 'string') {
      if (arg.startsWith('<')) {
        const tagMatch = arg.match(/^<([a-zA-Z]+)/);
        const el = createEl(tagMatch ? tagMatch[1].toLowerCase() : 'div');
        const classMatch = arg.match(/class="([^"]*)"/);
        if (classMatch) el.addClass(classMatch[1]);
        return el;
      }
      if (arg === '[data-username]') {
        return makeCollection(rendered.filter((el) => !el.removed && el.attrs['data-username']));
      }
      throw new Error(`jQuery 桩不支持的选择器：${arg}`);
    }
    return arg; // $(element) 直通：元素自带全部方法
  }
  $.fn = {}; // 仅作「jQuery 在场」标记（username.js 据此决定是否自动刷新）

  return { $, rendered };
}

function htmlescape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function testUsernameComponent() {
  const { $, rendered } = createJQueryStub();
  const fetchCalls = [];
  const sandbox = {
    $,
    htmlescape,
    console,
    Promise,
    encodeURIComponent,
    fetch: async (url) => {
      fetchCalls.push(url);
      const names = decodeURIComponent(String(url).split('users=')[1] || '').split(',');
      const colors = {};
      for (const name of names) {
        if (name === 'Boss1') {
          colors[name] = { colorClass: 'rt-blue', title: '蓝名', admin: true };
        } else {
          colors[name] = { colorClass: 'rt-gray', title: '灰名', admin: false };
        }
      }
      return { ok: true, json: async () => ({ colors }) };
    },
  };
  const ctx = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(rootDir, 'static', 'username.js'), 'utf8');
  vm.runInContext(source, ctx, { filename: 'username.js' });

  // 1) usernameCacheSeed + usernameLinkHtml：管理员 rt-admin + 徽标，普通用户不变。
  ctx.usernameCacheSeed({
    Admin1: { colorClass: 'rt-red', title: '红牌', admin: true },
    User1: { colorClass: 'rt-green', title: '绿牌', admin: false },
  });
  const adminHtml = ctx.usernameLinkHtml('Admin1');
  assert(adminHtml.includes('class="rt-admin"'), 'usernameLinkHtml 管理员使用 rt-admin 类');
  assert(!adminHtml.includes('rt-red'), 'usernameLinkHtml 管理员不再带原 rating 色档');
  assert(
    adminHtml.includes('<span class="hq-badge">Headquarters</span>'),
    'usernameLinkHtml 管理员名字后带 Headquarters 徽标',
  );
  assert(adminHtml.includes('title="红牌"'), 'usernameLinkHtml 保留 rating 头衔 tooltip');
  const userHtml = ctx.usernameLinkHtml('User1');
  assert(userHtml.includes('class="rt-green"'), 'usernameLinkHtml 普通用户保留 rating 色档');
  assert(
    !userHtml.includes('hq-badge') && !userHtml.includes('rt-admin') && !userHtml.includes('Headquarters'),
    'usernameLinkHtml 普通用户不含徽标与 rt-admin',
  );
  const unknownHtml = ctx.usernameLinkHtml('Ghost1');
  assert(unknownHtml.includes('class="rt-unrated"') && !unknownHtml.includes('hq-badge'), '未缓存用户降级 rt-unrated');

  // 2) usernameLink（DOM 版）：管理员追加 span.hq-badge 子节点。
  const $admin = ctx.usernameLink('Admin1');
  assert($admin.classes.has('rt-admin') && !$admin.classes.has('rt-red'), 'usernameLink 管理员类为 rt-admin');
  assert($admin.textContent === 'Admin1', 'usernameLink 用户名走 .text() 防注入');
  assert(
    $admin.kids.length === 1 && $admin.kids[0].classes.has('hq-badge') && $admin.kids[0].textContent === 'Headquarters',
    'usernameLink 管理员追加 Headquarters 徽标子节点',
  );
  assert($admin.attrs.title === '红牌', 'usernameLink 保留 rating 头衔 tooltip');
  const $user = ctx.usernameLink('User1');
  assert($user.classes.has('rt-green') && $user.kids.length === 0, 'usernameLink 普通用户无徽标');

  // 3) usernameEnsureColors：接口带回 admin 标记后渲染同步。
  await ctx.usernameEnsureColors(['Boss1', 'Peon1']);
  assert(fetchCalls.length === 1, 'usernameEnsureColors 批量请求已发出');
  const bossHtml = ctx.usernameLinkHtml('Boss1');
  assert(bossHtml.includes('rt-admin') && bossHtml.includes('hq-badge'), 'ensureColors 回填后管理员带徽标');
  const peonHtml = ctx.usernameLinkHtml('Peon1');
  assert(peonHtml.includes('rt-gray') && !peonHtml.includes('hq-badge'), 'ensureColors 回填后普通用户无徽标');

  // 4) usernameRefreshRendered：先按 unrated 渲染，seed 后自动补 rt-admin + 徽标。
  const $ghost = ctx.usernameLink('Ghost1');
  rendered.push($ghost);
  assert($ghost.classes.has('rt-unrated'), '渲染时未缓存按 rt-unrated 降级');
  ctx.usernameCacheSeed({ Ghost1: { colorClass: 'rt-orange', title: '橙牌', admin: true } });
  assert(
    $ghost.classes.has('rt-admin') && !$ghost.classes.has('rt-unrated'),
    'seed 后已渲染元素褪旧档上 rt-admin',
  );
  assert(
    $ghost.kids.some((kid) => kid.classes.has('hq-badge')),
    'seed 后已渲染元素自动补 Headquarters 徽标',
  );

  // 5) 管理员撤销：seed admin:false 后徽标摘除、回到 rating 色档。
  ctx.usernameCacheSeed({ Ghost1: { colorClass: 'rt-orange', title: '橙牌', admin: false } });
  assert(
    !$ghost.classes.has('rt-admin') && $ghost.classes.has('rt-orange'),
    '管理员撤销后回到 rating 色档',
  );
  assert(
    !$ghost.kids.some((kid) => kid.classes.has('hq-badge')),
    '管理员撤销后 Headquarters 徽标摘除',
  );
}

/* ---------- 第二部分：dist 服务集成断言 ---------- */

async function prepareUsers(dir) {
  // 直接用编译产物造用户，绕过注册验证码（首个注册用户 = 超管）。
  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const { ensureRuntimeEnv } = await import(pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href);
  const store = new UserStore(dir);
  await store.ensureReady();
  await store.register(ADMIN_USER, 'badge-pass-1');
  await store.register(GRANTED_ADMIN, 'badge-pass-2');
  await store.register(NORMAL_USER, 'badge-pass-3');
  // 第二个用户由超管授予普通管理员（覆盖 isAdmin 非超管路径）。
  await store.setAdmin(GRANTED_ADMIN, true);
  const adminSid = await store.rotateSession(ADMIN_USER);
  const env = ensureRuntimeEnv();
  return {
    adminToken: jwt.sign({ sub: ADMIN_USER, sid: adminSid }, env.jwtSecret, { expiresIn: '1h' }),
  };
}

async function apiGet(baseUrl, apiPath, token) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    headers: token ? { cookie: `auth_token=${encodeURIComponent(token)}` } : {},
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, data };
}

async function apiPost(baseUrl, apiPath, token, body) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method: 'POST',
    headers: {
      cookie: `auth_token=${encodeURIComponent(token)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, data };
}

async function waitServerReady(baseUrl) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/user-colors?users=__probe__`);
      if (res.ok) return;
    } catch {
      // 服务未就绪，继续等待
    }
    await sleep(200);
  }
  throw new Error('服务器就绪等待超时');
}

async function testServerEndpoints() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-admin-badge-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`临时数据目录：${dataDir}，端口：${port}`);

  const { adminToken } = await prepareUsers(dataDir);
  log(`已造用户：${ADMIN_USER}（超管）/ ${GRANTED_ADMIN}（普通管理员）/ ${NORMAL_USER}（普通用户）`);

  const server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: { ...process.env, ROKA_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(server);
  await waitServerReady(baseUrl);
  log('服务器已就绪');

  // /api/user-colors：批量补色主出口。
  const names = [ADMIN_USER, GRANTED_ADMIN, NORMAL_USER].join(',');
  const colors = await apiGet(baseUrl, `/api/user-colors?users=${encodeURIComponent(names)}`);
  assert(colors.status === 200 && colors.data && colors.data.colors, '/api/user-colors 返回 200');
  assert(colors.data.colors[ADMIN_USER].admin === true, 'user-colors 超管 admin=true');
  assert(colors.data.colors[GRANTED_ADMIN].admin === true, 'user-colors 普通管理员 admin=true');
  assert(colors.data.colors[NORMAL_USER].admin === false, 'user-colors 普通用户 admin=false');
  assert(colors.data.colors[NORMAL_USER].colorClass === 'rt-unrated', 'user-colors 普通用户 rating 色档不受影响');

  // /api/users/search：@提及候选出口。
  const search = await apiGet(baseUrl, '/api/users/search?q=badge');
  const searchItems = (search.data && search.data.items) || [];
  const searchAdmin = searchItems.find((item) => item.username === ADMIN_USER);
  const searchUser = searchItems.find((item) => item.username === NORMAL_USER);
  assert(searchAdmin && searchAdmin.admin === true, 'users/search 管理员 admin=true');
  assert(searchUser && searchUser.admin === false, 'users/search 普通用户 admin=false');

  // /api/profile/:username：个人页出口。
  const profileAdmin = await apiGet(baseUrl, `/api/profile/${ADMIN_USER}`);
  const profileUser = await apiGet(baseUrl, `/api/profile/${NORMAL_USER}`);
  assert(profileAdmin.status === 200 && profileAdmin.data.admin === true, 'profile 管理员 admin=true');
  assert(profileUser.status === 200 && profileUser.data.admin === false, 'profile 普通用户 admin=false');

  // /api/feeds：动态 authorInfo 出口（管理员发帖）。
  const post = await apiPost(baseUrl, '/api/feeds', adminToken, { text: '管理员徽标测试动态' });
  assert(post.status === 200 && post.data.post, '管理员发帖成功');
  assert(post.data.post.authorInfo.admin === true, 'feeds 发帖响应 authorInfo.admin=true');
  const feeds = await apiGet(baseUrl, '/api/feeds');
  const feedItem = ((feeds.data && feeds.data.items) || []).find((item) => item.author === ADMIN_USER);
  assert(feedItem && feedItem.authorInfo.admin === true, 'feeds 列表 authorInfo.admin=true');
  assert(typeof feedItem.authorInfo.colorClass === 'string', 'feeds authorInfo 仍带 rating 色档');

  // /api/admin/users：后台用户列表出口。
  const adminUsers = await apiGet(baseUrl, '/api/admin/users', adminToken);
  const adminItems = (adminUsers.data && adminUsers.data.items) || [];
  const adminRow = adminItems.find((item) => item.username === ADMIN_USER);
  const userRow = adminItems.find((item) => item.username === NORMAL_USER);
  assert(adminRow && adminRow.admin === true, 'admin/users 管理员 admin=true');
  assert(userRow && userRow.admin === false, 'admin/users 普通用户 admin=false');
}

async function main() {
  await testUsernameComponent();
  log('第一部分（username.js 纯逻辑）全部通过');
  ensureBuild();
  await testServerEndpoints();
  log('第二部分（服务端出口集成）全部通过');
  finish(0);
}

main().catch((error) => {
  log(`测试失败：${error && error.stack ? error.stack : error}`);
  finish(1);
});
