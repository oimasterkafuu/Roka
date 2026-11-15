import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const baseline = process.env.CHAT_UI_BASELINE;
const output = process.env.CHAT_UI_OUTPUT;
if (output) await fs.mkdir(output, { recursive: true });
const now = Date.UTC(2026, 10, 15, 12);
// Synthetic public messages only; no production audit data is fetched.
const candidate = {
  id: 300,
  at: now,
  room: 'room12345678901',
  gameId: 'game'.repeat(12),
  username: 'LongUsername12345678',
  text: '公开消息 example.com ' + 'LongUnbrokenText'.repeat(24) + '\n第二行 <script>不可执行</script>',
  joinedAt: now - 20000,
  candidateAt: now + 10000,
  mutedUntil: now + 610000,
};
let items = [
  candidate,
  { ...candidate, id: 299, reviewedAt: now + 30000, reviewedBy: '审核员', text: '已复核的候选' },
  { ...candidate, id: 298, candidateAt: null, text: '普通公开聊天' },
];
let fail = false;
const requests = [];
const releases = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    let data = {};
    if (url.pathname === '/api/auth/me') data = { username: 'reviewer', isAdmin: true };
    else if (url.pathname === '/api/admin/users') data = { items: [], viewerIsSuperAdmin: false };
    else if (url.pathname === '/api/user-colors') data = {};
    else if (url.pathname === '/api/admin/chat-audit') {
      requests.push(Object.fromEntries(url.searchParams));
      if (fail) res.statusCode = 403;
      data = { items };
    } else if (url.pathname === '/api/admin/chat-release') {
      let body = '';
      for await (const part of req) body += part;
      releases.push(JSON.parse(body));
    } else {
      res.statusCode = 404;
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
    const data =
      baseline && ['admin.html', 'admin.js', 'styles/admin.css'].includes(name)
        ? execFileSync('git', ['show', `${baseline}:static/${name}`])
        : await fs.readFile(file);
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
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/admin`);
    await page.waitForFunction(() => document.querySelectorAll('#chat-body tr').length === 3);
    await page.evaluate(() => document.fonts.ready);
    const card = page.locator('section').filter({ has: page.locator('#chat-body') });
    await card.scrollIntoViewIfNeeded();
    const metrics = await card.evaluate((el) => {
      const input = el.querySelector('#chat-user');
      const cell = el.querySelector('#chat-body tr td:nth-child(3)');
      const button = el.querySelector('#chat-body button');
      return {
        viewport: innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        cardWidth: el.clientWidth,
        cardScroll: el.scrollWidth,
        input: {
          background: getComputedStyle(input).backgroundColor,
          borderRadius: getComputedStyle(input).borderRadius,
          height: input.getBoundingClientRect().height,
        },
        text: {
          whiteSpace: getComputedStyle(cell).whiteSpace,
          overflowWrap: getComputedStyle(cell).overflowWrap,
        },
        button: {
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
        },
        textWidth: cell.getBoundingClientRect().width,
        textHeight: cell.getBoundingClientRect().height,
        cellsOverflow: [...el.querySelectorAll('td')].filter((td) => td.scrollWidth > td.clientWidth + 1)
          .length,
      };
    });
    results.push({ width, metrics, errors });
    if (output)
      await page.screenshot({
        path: path.join(output, `${baseline ? 'before' : 'after'}-${width}.png`),
        fullPage: true,
      });
    if (!baseline) {
      assert.equal(metrics.pageWidth, width);
      assert.ok(metrics.cardScroll <= metrics.cardWidth);
      assert.equal(metrics.cellsOverflow, 0);
      assert.ok(metrics.textWidth >= 250, 'message column remains readable');
      assert.equal(
        await page
          .locator('#chat-body tr')
          .first()
          .evaluate((el) => getComputedStyle(el).display),
        width === 390 ? 'block' : 'table-row',
      );
      assert.equal(
        await page.locator('.chat-audit-reviewed').evaluate((el) => getComputedStyle(el).color),
        'rgb(0, 110, 110)',
      );
      assert.equal(
        await page
          .locator('.chat-audit-evidence')
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(255, 247, 230)',
      );
      assert.equal(metrics.input.background, 'rgb(255, 255, 255)');
      assert.equal(metrics.input.borderRadius, '8px');
      assert.ok(metrics.input.height >= 44);
      assert.equal(metrics.text.whiteSpace, 'pre-wrap');
      assert.equal(metrics.text.overflowWrap, 'anywhere');
      assert.ok(metrics.button.height >= 44 && metrics.button.width >= 44);
      assert.equal(await page.locator('#chat-body script, #chat-body a').count(), 0);
      await page.locator('#chat-body button').click();
      assert.deepEqual(releases.at(-1), { username: candidate.username });
      await page.locator('#chat-user').fill('exact-user');
      await page.locator('#chat-room').fill('room42');
      await page.locator('#chat-candidates').uncheck();
      const response = page.waitForResponse((r) => r.url().includes('username=exact-user'));
      await page.locator('#chat-search').click();
      await response;
      await page.locator('#chat-release-user').click();
      await page.waitForFunction(() => document.querySelector('#chat-error').textContent.startsWith('本页'));
      assert.deepEqual(releases.at(-1), { username: 'exact-user' });
      await page.locator('#chat-user').focus();
      assert.equal(
        await page.locator('#chat-user').evaluate((el) => getComputedStyle(el).outlineStyle),
        'solid',
      );
      assert.equal(requests.at(-1).room, 'room42');
      assert.equal(requests.at(-1).candidates, '0');
      await page.waitForFunction(() => document.querySelector('#chat-older').disabled);
      assert.equal(await page.locator('#chat-older').isDisabled(), true);
      items = Array.from({ length: 100 }, (_, i) => ({ ...candidate, id: 300 - i }));
      await page.locator('#chat-search').click();
      await page.waitForFunction(() => !document.querySelector('#chat-older').disabled);
      const older = page.waitForResponse((r) => r.url().includes('before=201'));
      await page.locator('#chat-older').click();
      await older;
      items = [];
      await page.locator('#chat-search').click();
      await page.waitForFunction(() => document.querySelector('#chat-error').textContent === '无匹配记录。');
      assert.equal(await page.locator('#chat-body tr').count(), 0);
      assert.equal(
        await page.locator('#chat-error').evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(243, 245, 249)',
      );
      if (output) await card.screenshot({ path: path.join(output, `empty-${width}.png`) });
      fail = true;
      await page.locator('#chat-search').click();
      await page.waitForFunction(() =>
        document.querySelector('#chat-error').textContent.includes('查询失败'),
      );
      if (output) await card.screenshot({ path: path.join(output, `error-${width}.png`) });
      fail = false;
      items = [
        candidate,
        { ...candidate, id: 299, reviewedAt: now + 30000, reviewedBy: '审核员', text: '已复核的候选' },
        { ...candidate, id: 298, candidateAt: null, text: '普通公开聊天' },
      ];
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  if (output)
    await fs.writeFile(
      path.join(output, `${baseline ? 'before' : 'after'}-metrics.json`),
      JSON.stringify(results, null, 2),
    );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
