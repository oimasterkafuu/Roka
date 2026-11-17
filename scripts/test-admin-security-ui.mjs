import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const now = Date.UTC(2026, 10, 17, 12);
let superAdmin = true;
let scanCalls = 0;
const users = [
  {
    username: 'security_admin',
    rating: 1200,
    ratingGames: 1,
    createdAt: now - 100000,
    lastSeenAt: now,
    registeredIp: '198.51.100.1',
    lastIp: '198.51.100.1',
    lastIpAt: now,
    ipHistory: [{ ip: '198.51.100.1', firstSeenAt: now - 100000, lastSeenAt: now }],
    isAdmin: true,
    isSuperAdmin: true,
    bannedUntil: null,
    ban: null,
    banHistory: [],
  },
  {
    username: 'banned_peer',
    rating: 0,
    ratingGames: 0,
    createdAt: now - 90000,
    lastSeenAt: null,
    registeredIp: '203.0.113.12',
    lastIp: '203.0.113.12',
    lastIpAt: now - 80000,
    ipHistory: [{ ip: '203.0.113.12', firstSeenAt: now - 90000, lastSeenAt: now - 80000 }],
    isAdmin: false,
    isSuperAdmin: false,
    bannedUntil: -1,
    ban: {
      type: 'manual',
      reason: '管理员手动封禁',
      startedAt: now - 80000,
      triggeredAt: now - 80000,
      evidence: '',
    },
    banHistory: [],
  },
  {
    username: 'new_peer',
    rating: 0,
    ratingGames: 0,
    createdAt: now - 70000,
    lastSeenAt: null,
    registeredIp: '203.0.113.12',
    lastIp: '2001:db8::1',
    lastIpAt: now - 60000,
    ipHistory: [
      { ip: '203.0.113.12', firstSeenAt: now - 70000, lastSeenAt: now - 70000 },
      { ip: '2001:db8::1', firstSeenAt: now - 60000, lastSeenAt: now - 60000 },
    ],
    isAdmin: false,
    isSuperAdmin: false,
    bannedUntil: null,
    ban: null,
    banHistory: [],
  },
  {
    username: 'grass',
    rating: 0,
    ratingGames: 0,
    createdAt: now - 50000,
    lastSeenAt: null,
    registeredIp: null,
    lastIp: null,
    lastIpAt: null,
    ipHistory: [],
    isAdmin: false,
    isSuperAdmin: false,
    bannedUntil: null,
    ban: null,
    banHistory: [],
  },
];
const securityEvents = [
  {
    id: 'risk1',
    at: now,
    type: 'possible_ban_evasion',
    action: 'flag_for_review',
    reason: '新注册账号与有效永久封禁账号使用相同 IP',
    username: 'new_peer',
    ip: '203.0.113.12',
    relatedUsernames: ['banned_peer'],
  },
  {
    id: 'block1',
    at: now - 1000,
    type: 'registration_rate_limited',
    action: 'reject_registration',
    reason: '同一真实 IP 在滚动 24 小时内注册账号过多 <img src=x onerror=window.injected=true>',
    username: 'batch_three',
    ip: '198.51.100.8',
  },
  {
    id: 'ban1',
    at: now - 2000,
    type: 'username_auto_banned',
    action: 'permanent_ban',
    reason: '用户名违反社区规范',
    username: 'fucklegacy',
    ip: '198.51.100.2',
  },
  {
    id: 'scan1',
    at: now - 3000,
    type: 'username_scan_completed',
    action: 'complete_scan',
    reason: '用户名全量复查完成',
    result: { scanned: 4, hits: 1, autoBanned: 1, skipped: 0, completedAt: now - 3000 },
  },
];
const chatEntry = {
  id: 'chat1',
  at: now,
  room: 'security-room',
  gameId: 'game1',
  username: 'chat_user',
  text: '公开聊天 <script>window.injected=true</script>',
  joinedAt: now - 20000,
  candidateAt: now,
  mutedUntil: now + 600000,
};
const bot = {
  id: 'bot1',
  username: 'new_peer',
  room: 'room1',
  template: 'simple-strategy-bot',
  allowTeam: false,
  allowFog: true,
  allowMultiLine: false,
  startedAt: now,
  connected: true,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    let data = {};
    if (url.pathname === '/api/auth/me') {
      data = { username: 'security_admin', isAdmin: true, isSuperAdmin: superAdmin };
    } else if (url.pathname === '/api/admin/users') {
      data = { items: users, viewerIsSuperAdmin: superAdmin };
    } else if (url.pathname === '/api/admin/security/dashboard') {
      data = {
        summary: {
          totalUsers: 4,
          activeBans: 1,
          registrationsToday: 3,
          registrations7Days: 4,
          registrationBlocks24Hours: 1,
          usernameAutoBans: 1,
          pendingBanEvasions: 1,
        },
        recentEvents: securityEvents,
        lastScan: securityEvents[3].result,
      };
    } else if (url.pathname === '/api/admin/security/events') {
      const type = url.searchParams.get('type');
      const username = (url.searchParams.get('username') || '').toLowerCase();
      const ip = url.searchParams.get('ip') || '';
      data = {
        items: securityEvents.filter(
          (entry) =>
            (!type || entry.type === type) &&
            (!username ||
              entry.username?.toLowerCase().includes(username) ||
              entry.relatedUsernames?.some((name) => name.toLowerCase().includes(username))) &&
            (!ip || entry.ip?.includes(ip)),
        ),
      };
    } else if (url.pathname === '/api/admin/security/scan') {
      scanCalls += 1;
      data = { scanned: 4, hits: 1, autoBanned: 1, skipped: 0, completedAt: now + 1000 };
    } else if (url.pathname === '/api/admin/chat-audit') {
      data = { items: [chatEntry] };
    } else if (url.pathname === '/api/admin/bot-templates') {
      data = { items: [{ id: 'simple-strategy-bot', name: 'Simple Strategy', description: '测试模板' }] };
    } else if (url.pathname === '/api/admin/bots') {
      data = { items: [bot] };
    } else if (url.pathname === '/api/user-colors') {
      data = {};
    }
    res.end(JSON.stringify(data));
    return;
  }
  const name = url.pathname === '/admin' ? 'admin.html' : url.pathname.slice(1);
  const file = path.resolve('static', name);
  if (!file.startsWith(path.resolve('static') + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    res.setHeader(
      'Content-Type',
      { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[ext] ||
        'application/octet-stream',
    );
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/admin`);
    await page.waitForFunction(() => document.querySelector('#metric-total-users')?.textContent === '4');
    assert.equal(await page.locator('.admin-tab:visible').count(), 5);
    assert.equal(await page.locator('#tab-dashboard').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel-dashboard').isVisible(), true);
    assert.equal(await page.locator('#panel-users').isVisible(), false);
    assert.equal(await page.locator('#dashboard-events-body tr').count(), 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    await page.locator('#tab-users').click();
    await page.waitForFunction(() => document.querySelectorAll('#users-body tr').length === 4);
    assert.equal(await page.evaluate(() => location.hash), '#users');
    await page.locator('#user-search').fill('203.0.113.12');
    assert.equal(await page.locator('#users-body tr').count(), 2, 'exact IP lists every associated account');
    await page.locator('#user-search').fill('new_peer');
    assert.equal(await page.locator('#users-body tr').count(), 1);
    assert.equal(await page.locator('#users-body').textContent().then((text) => text.includes('2001:db8::1')), true);

    await page.locator('#tab-security').click();
    await page.waitForFunction(() => document.querySelectorAll('#security-events-body tr').length === 4);
    const previousScanCalls = scanCalls;
    await page.locator('#security-scan-btn').click();
    await page.waitForFunction(() => document.querySelector('#security-scan-result').textContent.includes('自动封禁 1'));
    assert.equal(scanCalls, previousScanCalls + 1);
    assert.equal(await page.locator('#security-events-body img, #security-events-body script').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('#security-evasions button').first().click();
    await page.waitForFunction(() => location.hash === '#users');
    assert.equal(await page.locator('#user-search').inputValue(), 'new_peer');
    assert.equal(await page.locator('#users-body tr').count(), 1);

    await page.locator('#tab-chat').click();
    await page.waitForFunction(() => document.querySelectorAll('#chat-body tr').length === 1);
    assert.equal(await page.locator('#chat-body script').count(), 0);
    assert.equal(await page.locator('#chat-body').textContent().then((text) => text.includes('<script>')), true);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#chat-body tr').length === 1);
    assert.equal(await page.locator('#tab-chat').getAttribute('aria-selected'), 'true');
    await page.locator('#tab-security').click();
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#chat' && document.querySelector('#tab-chat').getAttribute('aria-selected') === 'true');
    await page.goForward();
    await page.waitForFunction(() => location.hash === '#security');

    await page.locator('#tab-bots').click();
    await page.waitForFunction(() => document.querySelectorAll('#bots-body tr').length === 1);
    assert.equal(await page.locator('#bot-template option').count(), 1);
    assert.equal(await page.locator('#bot-allow-fog').count(), 1);
    assert.equal(await page.locator('#bots-body').textContent().then((text) => text.includes('Simple') || text.includes('simple-strategy-bot')), true);
    await page.locator('#tab-bots').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => location.hash), '#chat');
    await page.waitForFunction(() => document.querySelector('#tab-chat').getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('#tab-chat').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.close();
  }

  superAdmin = false;
  const normal = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const normalErrors = [];
  normal.on('pageerror', (error) => normalErrors.push(error.message));
  await normal.goto(`${base}/admin#bots`);
  await pageWait(normal, () => document.querySelector('#tab-dashboard').getAttribute('aria-selected') === 'true');
  assert.equal(await normal.locator('.admin-tab:visible').count(), 4);
  assert.equal(await normal.locator('#tab-bots').isVisible(), false);
  assert.equal(await normal.locator('#bots-card').isVisible(), false);
  assert.deepEqual(normalErrors, []);
  await normal.close();

  const noJs = await browser.newPage({ javaScriptEnabled: false });
  await noJs.goto(`${base}/admin`);
  assert.equal(await noJs.locator('#panel-dashboard').isVisible(), true);
  assert.equal(await noJs.locator('#panel-users').isVisible(), true);
  assert.equal(await noJs.locator('#panel-security').isVisible(), true);
  assert.equal(await noJs.locator('#chat-audit').isVisible(), true);
  await noJs.close();
  console.log('PASS Chromium admin dashboard, tabs/hash, search, scan, risk links, chat/bot, 1440/390 and no-JS');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

async function pageWait(page, predicate) {
  await page.waitForFunction(predicate);
}
