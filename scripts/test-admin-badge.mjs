// Roka 管理员用户名外观（issue #95）测试：
// 第一部分（单元）：node vm + 最小 jQuery/fetch 桩驱动 static/username.js，断言
//   管理员名字仅使用 rt-admin + Headquarters tooltip（HTML / DOM / 缓存刷新），
//   普通用户渲染不变，管理员撤销后恢复 rating 外观；
// 第二部分（集成）：临时数据目录 + 随机端口启动 dist/server.js，断言
//   用户名相关 API 对管理员统一返回 rt-admin / Headquarters，对普通用户保留 rating 外观。
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
const EXPIRED_USER = 'badge_expired';

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

  // 1) 缓存旧 rating 的管理员数据也必须归一化；普通用户保留原色与头衔。
  ctx.usernameCacheSeed({
    Admin1: { colorClass: 'rt-red', title: '红牌', admin: true },
    User1: { colorClass: 'rt-green', title: '绿牌', admin: false },
  });
  const adminHtml = ctx.usernameLinkHtml('Admin1');
  assert(
    adminHtml.includes('class="rt-admin" title="Headquarters"'),
    'usernameLinkHtml 管理员颜色与 tooltip',
  );
  assert(
    !adminHtml.includes('rt-red') && !adminHtml.includes('<span'),
    'usernameLinkHtml 无旧 rating 和徽标',
  );
  const userHtml = ctx.usernameLinkHtml('User1');
  assert(userHtml.includes('class="rt-green" title="绿牌"'), 'usernameLinkHtml 普通用户原样保留');
  assert(!userHtml.includes('Headquarters') && !userHtml.includes('<span'), '普通用户无管理员标识');
  const unknownHtml = ctx.usernameLinkHtml('Ghost1');
  assert(
    unknownHtml.includes('class="rt-unrated"') && !unknownHtml.includes('title='),
    '未缓存用户降级 rt-unrated',
  );

  // 2) DOM 版直接信息、缓存信息都没有徽标。
  const $admin = ctx.usernameLink('Admin1');
  assert($admin.classes.has('rt-admin') && !$admin.classes.has('rt-red'), 'usernameLink 管理员类为 rt-admin');
  assert($admin.textContent === 'Admin1' && $admin.kids.length === 0, 'usernameLink 仅用 .text() 渲染名字');
  assert($admin.attrs.title === 'Headquarters', 'usernameLink 管理员 tooltip');
  const $direct = ctx.usernameLink('Direct1', { colorClass: 'rt-blue', title: '旧头衔', admin: true });
  assert(
    $direct.classes.has('rt-admin') && $direct.attrs.title === 'Headquarters' && !$direct.kids.length,
    '直接传入旧 rating 信息也归一化',
  );
  const $user = ctx.usernameLink('User1');
  assert(
    $user.classes.has('rt-green') && $user.attrs.title === '绿牌' && !$user.kids.length,
    'usernameLink 普通用户保持原样',
  );

  // 3) 异步补色即使返回旧 rating，也遵从 admin 标记。
  await ctx.usernameEnsureColors(['Boss1', 'Peon1']);
  assert(fetchCalls.length === 1, 'usernameEnsureColors 批量请求已发出');
  const bossHtml = ctx.usernameLinkHtml('Boss1');
  assert(
    bossHtml.includes('class="rt-admin" title="Headquarters"') && !bossHtml.includes('<span'),
    'ensureColors 管理员无徽标',
  );
  const peonHtml = ctx.usernameLinkHtml('Peon1');
  assert(
    peonHtml.includes('class="rt-gray" title="灰名"') && !peonHtml.includes('<span'),
    'ensureColors 普通用户原样保留',
  );

  // 4) 已渲染链接刷新与撤权同步更新 tooltip。
  const $ghost = ctx.usernameLink('Ghost1');
  rendered.push($ghost);
  assert($ghost.classes.has('rt-unrated'), '渲染时未缓存按 rt-unrated 降级');
  ctx.usernameCacheSeed({ Ghost1: { colorClass: 'rt-orange', title: '橙牌', admin: true } });
  assert(
    $ghost.classes.has('rt-admin') && !$ghost.classes.has('rt-unrated'),
    'seed 后已渲染链接改为 rt-admin',
  );
  assert($ghost.attrs.title === 'Headquarters' && !$ghost.kids.length, 'seed 后只有管理员 tooltip，无子节点');
  ctx.usernameCacheSeed({ Ghost1: { colorClass: 'rt-orange', title: '橙牌', admin: false } });
  assert(!$ghost.classes.has('rt-admin') && $ghost.classes.has('rt-orange'), '管理员撤销后回到 rating 色档');
  assert($ghost.attrs.title === '橙牌' && !$ghost.kids.length, '管理员撤销后恢复 rating tooltip');
  assert(ctx.usernameLinkHtml('Ghost1').includes('title="橙牌"'), '撤权后 HTML 版也恢复 rating tooltip');

  // 封禁覆盖管理员及旧色档，解除后已渲染 DOM 与 HTML 同时恢复。
  ctx.usernameCacheSeed({ Ghost1: { colorClass: 'rt-red', title: '红牌', admin: true, banned: true } });
  assert(
    $ghost.classes.has('rt-banned') && !$ghost.classes.has('rt-admin') && $ghost.attrs.title === '已封禁',
    '封禁管理员 DOM 覆盖',
  );
  assert(ctx.usernameLinkHtml('Ghost1').includes('class="rt-banned" title="已封禁"'), '封禁管理员 HTML 覆盖');
  const $banned = ctx.usernameLink('Ban1', {
    colorClass: 'rt-red',
    title: '红牌',
    admin: false,
    banned: true,
  });
  assert($banned.classes.has('rt-banned') && $banned.attrs.title === '已封禁', '封禁普通用户 DOM 覆盖');
  assert(ctx.usernameLinkHtml('Ban1').includes('class="rt-banned"'), '封禁普通用户 HTML 覆盖');
  ctx.usernameCacheSeed({ Ghost1: { colorClass: 'rt-red', title: '红牌', admin: true, banned: false } });
  assert(
    $ghost.classes.has('rt-admin') &&
      !$ghost.classes.has('rt-banned') &&
      $ghost.attrs.title === 'Headquarters',
    '解封管理员无旧封禁样式',
  );
  ctx.usernameCacheSeed({ Ban1: { colorClass: 'rt-red', title: '红牌', admin: false, banned: false } });
  assert(ctx.usernameLinkHtml('Ban1').includes('class="rt-red"'), '解封普通用户恢复 rating');

  let resolveOld;
  let requests = 0;
  ctx.fetch = async () => {
    requests++;
    if (requests === 1)
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    return {
      ok: true,
      json: async () => ({
        colors: { Ghost1: { colorClass: 'rt-red', title: '红牌', admin: false, banned: false } },
      }),
    };
  };
  ctx.usernameColorsInvalidate();
  ctx.usernameColorsInvalidate();
  await new Promise(setImmediate);
  assert(
    requests === 2 && $ghost.classes.has('rt-red') && !$ghost.classes.has('rt-banned'),
    '失效缓存重新请求并清除封禁样式',
  );
  resolveOld({
    ok: true,
    json: async () => ({
      colors: { Ghost1: { colorClass: 'rt-banned', title: '已封禁', admin: false, banned: true } },
    }),
  });
  await new Promise(setImmediate);
  assert($ghost.classes.has('rt-red') && !$ghost.classes.has('rt-banned'), '旧请求不能覆盖解除封禁后的外观');
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
  await store.register(EXPIRED_USER, 'badge-pass-4');
  await store.banUser(EXPIRED_USER, Date.now() - 1000);
  // 第二个用户由超管授予普通管理员（覆盖 isAdmin 非超管路径）。
  await store.setAdmin(GRANTED_ADMIN, true);
  await store.applyRatingUpdates([
    { username: ADMIN_USER, delta: 0 },
    { username: GRANTED_ADMIN, delta: 0 },
    { username: NORMAL_USER, delta: 0 },
  ]);
  const adminSid = await store.rotateSession(ADMIN_USER);
  const userSid = await store.rotateSession(NORMAL_USER);
  const env = ensureRuntimeEnv();
  return {
    adminToken: jwt.sign({ sub: ADMIN_USER, sid: adminSid }, env.jwtSecret, { expiresIn: '1h' }),
    userToken: jwt.sign({ sub: NORMAL_USER, sid: userSid }, env.jwtSecret, { expiresIn: '1h' }),
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

function assertAppearance(info, admin, label) {
  assert(
    info &&
      info.admin === admin &&
      info.colorClass === (admin ? 'rt-admin' : 'rt-gray') &&
      info.title === (admin ? 'Headquarters' : 'Newbie'),
    label,
  );
}

async function testServerEndpoints() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-admin-badge-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`临时数据目录：${dataDir}，端口：${port}`);

  const { adminToken, userToken } = await prepareUsers(dataDir);
  log(`已造用户：${ADMIN_USER}（超管）/ ${GRANTED_ADMIN}（普通管理员）/ ${NORMAL_USER}（普通用户）`);

  const server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: { ...process.env, ROKA_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(server);
  await waitServerReady(baseUrl);
  log('服务器已就绪');

  // /api/user-colors：超管、普通管理员及普通用户。
  const names = [ADMIN_USER, GRANTED_ADMIN, NORMAL_USER].join(',');
  const colorsPath = `/api/user-colors?users=${encodeURIComponent(names)}`;
  const colors = await apiGet(baseUrl, colorsPath);
  assert(colors.status === 200 && colors.data && colors.data.colors, '/api/user-colors 返回 200');
  for (const name of [ADMIN_USER, GRANTED_ADMIN]) {
    assertAppearance(colors.data.colors[name], true, `user-colors ${name}`);
  }
  assertAppearance(colors.data.colors[NORMAL_USER], false, 'user-colors 普通用户');

  // /api/users/search：@提及候选出口。
  const search = await apiGet(baseUrl, '/api/users/search?q=badge');
  assert(search.status === 200, 'users/search 返回 200');
  for (const name of [ADMIN_USER, GRANTED_ADMIN, NORMAL_USER]) {
    assertAppearance(
      search.data.items.find((item) => item.username === name),
      name !== NORMAL_USER,
      `users/search ${name}`,
    );
  }

  // /api/profile/:username：个人页出口。
  for (const name of [ADMIN_USER, GRANTED_ADMIN, NORMAL_USER]) {
    const profile = await apiGet(baseUrl, `/api/profile/${name}`);
    assert(profile.status === 200, `profile ${name} 返回 200`);
    assertAppearance(profile.data, name !== NORMAL_USER, `profile ${name}`);
  }

  // /api/leaderboard：三个用户都有 rating 对局。
  const leaderboard = await apiGet(baseUrl, '/api/leaderboard');
  assert(leaderboard.status === 200, 'leaderboard 返回 200');
  for (const name of [ADMIN_USER, GRANTED_ADMIN, NORMAL_USER]) {
    assertAppearance(
      leaderboard.data.items.find((item) => item.username === name),
      name !== NORMAL_USER,
      `leaderboard ${name}`,
    );
  }

  // 请求携带认证即更新在线状态，查询本身不更新。
  await apiGet(baseUrl, `/api/profile/${NORMAL_USER}`, userToken);
  await apiGet(baseUrl, `/api/profile/${ADMIN_USER}`, adminToken);
  const online = await apiGet(baseUrl, '/api/online');
  assert(online.status === 200, 'online 返回 200');
  for (const name of [ADMIN_USER, NORMAL_USER]) {
    assertAppearance(
      online.data.items.find((item) => item.username === name),
      name === ADMIN_USER,
      `online ${name}`,
    );
  }

  // /api/feeds：发帖及评论的写入响应和列表返回。
  const post = await apiPost(baseUrl, '/api/feeds', adminToken, { text: '管理员用户名测试动态' });
  assert(post.status === 200 && post.data.post, '管理员发帖成功');
  assertAppearance(post.data.post.authorInfo, true, 'feeds 发帖响应管理员');
  const comment = await apiPost(baseUrl, '/api/feeds/comment', userToken, {
    id: post.data.post.id,
    text: '普通用户评论',
  });
  assert(comment.status === 200 && comment.data.comment, '普通用户评论成功');
  assertAppearance(comment.data.comment.authorInfo, false, 'feeds 评论响应普通用户');
  const adminComment = await apiPost(baseUrl, '/api/feeds/comment', adminToken, {
    id: post.data.post.id,
    text: '管理员评论',
  });
  assert(adminComment.status === 200 && adminComment.data.comment, '管理员评论成功');
  assertAppearance(adminComment.data.comment.authorInfo, true, 'feeds 评论响应管理员');
  const feeds = await apiGet(baseUrl, '/api/feeds');
  const feedItem = ((feeds.data && feeds.data.items) || []).find((item) => item.author === ADMIN_USER);
  assertAppearance(feedItem && feedItem.authorInfo, true, 'feeds 列表发帖人');
  for (const name of [ADMIN_USER, NORMAL_USER]) {
    assertAppearance(
      feedItem.comments.find((item) => item.author === name)?.authorInfo,
      name === ADMIN_USER,
      `feeds 列表评论 ${name}`,
    );
  }

  // /api/admin/users：后台列表含两类管理员和普通用户。
  const adminUsers = await apiGet(baseUrl, '/api/admin/users', adminToken);
  assert(adminUsers.status === 200, 'admin/users 返回 200');
  for (const name of [ADMIN_USER, GRANTED_ADMIN, NORMAL_USER]) {
    assertAppearance(
      adminUsers.data.items.find((item) => item.username === name),
      name !== NORMAL_USER,
      `admin/users ${name}`,
    );
  }

  // 已过期封禁只按 getBanStatus 有效状态判断，不误判永久封禁。
  const expired = await apiGet(baseUrl, `/api/profile/${EXPIRED_USER}`);
  assert(expired.data.banned === false && expired.data.colorClass === 'rt-unrated', '过期封禁不呈棕名');
  const banAdmin = await apiPost(baseUrl, '/api/admin/ban', adminToken, {
    username: GRANTED_ADMIN,
    permanent: true,
  });
  const banNormal = await apiPost(baseUrl, '/api/admin/ban', adminToken, {
    username: NORMAL_USER,
    durationMs: 3600000,
  });
  assert(banAdmin.status === 200 && banNormal.status === 200, '隔离用户封禁成功');
  const isBanned = (info) =>
    info?.banned === true && info.colorClass === 'rt-banned' && info.title === '已封禁';
  const bannedColors = await apiGet(baseUrl, colorsPath);
  assert(
    isBanned(bannedColors.data.colors[GRANTED_ADMIN]) &&
      bannedColors.data.colors[GRANTED_ADMIN].admin === true,
    'user-colors 管理员封禁优先',
  );
  assert(isBanned(bannedColors.data.colors[NORMAL_USER]), 'user-colors 普通用户封禁优先');
  const bannedProfile = await apiGet(baseUrl, `/api/profile/${GRANTED_ADMIN}`);
  assert(isBanned(bannedProfile.data), 'profile 封禁管理员优先');
  const bannedSearch = await apiGet(baseUrl, '/api/users/search?q=badge');
  assert(
    isBanned(bannedSearch.data.items.find((item) => item.username === NORMAL_USER)),
    'search 封禁普通用户',
  );
  const bannedLeaderboard = await apiGet(baseUrl, '/api/leaderboard');
  assert(
    isBanned(bannedLeaderboard.data.items.find((item) => item.username === GRANTED_ADMIN)),
    'leaderboard 封禁管理员',
  );
  const bannedFeed = await apiGet(baseUrl, '/api/feeds');
  const bannedPost = bannedFeed.data.items.find((item) => item.author === ADMIN_USER);
  assert(
    isBanned(bannedPost.comments.find((item) => item.author === NORMAL_USER).authorInfo),
    'feed 评论作者封禁',
  );
  const bannedOnline = await apiGet(baseUrl, '/api/online');
  assert(isBanned(bannedOnline.data.items.find((item) => item.username === NORMAL_USER)), 'online 封禁用户');
  const bannedAdminList = await apiGet(baseUrl, '/api/admin/users', adminToken);
  assert(
    isBanned(bannedAdminList.data.items.find((item) => item.username === GRANTED_ADMIN)),
    'admin/users 封禁管理员',
  );
  const unban = await apiPost(baseUrl, '/api/admin/unban', adminToken, { username: NORMAL_USER });
  assert(unban.status === 200, '隔离用户解除封禁');
  const unbannedColors = await apiGet(baseUrl, colorsPath);
  assertAppearance(unbannedColors.data.colors[NORMAL_USER], false, '解封后 rating 颜色恢复');
  assert(unbannedColors.data.colors[NORMAL_USER].banned === false, '解封后有效封禁字段清除');

  await apiPost(baseUrl, '/api/admin/unban', adminToken, { username: GRANTED_ADMIN });
  // 撤销普通管理员权限后，服务端所有动态出口恢复 rating 外观。
  const revoke = await apiPost(baseUrl, '/api/admin/set-admin', adminToken, {
    username: GRANTED_ADMIN,
    admin: false,
  });
  assert(revoke.status === 200 && revoke.data.ok === true, '撤销普通管理员权限成功');
  const revokedColors = await apiGet(baseUrl, colorsPath);
  assertAppearance(revokedColors.data.colors[GRANTED_ADMIN], false, '撤权后 user-colors 恢复 rating');
  const revokedProfile = await apiGet(baseUrl, `/api/profile/${GRANTED_ADMIN}`);
  assertAppearance(revokedProfile.data, false, '撤权后 profile 恢复 rating');
  const revokedLeaderboard = await apiGet(baseUrl, '/api/leaderboard');
  assertAppearance(
    revokedLeaderboard.data.items.find((item) => item.username === GRANTED_ADMIN),
    false,
    '撤权后 leaderboard 恢复 rating',
  );
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
