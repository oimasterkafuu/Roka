import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-rate-limit-html-'));
Object.assign(process.env, {
  ROKA_DATA_DIR: dataDir,
  JWT_SECRET: 'rate-limit-html-test-secret',
  WEBHOOK_SECRET: 'rate-limit-html-test-secret',
  NODE_ENV: 'test',
  ROKA_STATIC_CDN: '0',
});

const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const require = createRequire(import.meta.url);
const { app, boot } = require('../dist/server.js');
app.log.level = 'silent';

const request = (url, ip, options = {}) =>
  app.inject({
    method: 'GET',
    url,
    ...options,
    headers: {
      'x-real-ip': ip,
      accept: browserAccept,
      ...options.headers,
    },
  });

const assertJsonRateLimit = (response) => {
  assert.equal(response.statusCode, 429);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.ok(Number(response.headers['retry-after']) >= 1);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'statusCode']);
  assert.equal(body.statusCode, 429);
  assert.equal(body.error, 'Too Many Requests');
  assert.match(body.message, /^Rate limit exceeded, retry in /);
};

const assertHtmlRateLimit = (response) => {
  assert.equal(response.statusCode, 429);
  assert.match(response.headers['content-type'], /^text\/html;\s*charset=utf-8/);
  assert.match(response.body, /^<!doctype html>/);
  assert.match(response.body, /<html lang="zh-CN">/);
  assert.match(response.body, /<title>访问过于频繁<\/title>/);
  assert.match(response.body, /<h1>访问过于频繁<\/h1>/);
  assert.match(response.body, /当前请求次数已达到上限，请稍后重试。/);
  const match = response.body.match(/<strong>请 (\d+) 秒后再试<\/strong>/);
  assert.ok(match, 'HTML contains the remaining seconds');
  const seconds = Number(match[1]);
  assert.ok(seconds >= 1 && seconds <= 60, `TTL is within the real one-minute window: ${seconds}`);
  assert.equal(response.headers['retry-after'], String(seconds));
  assert.equal(response.headers['x-ratelimit-reset'], String(seconds));
  return seconds;
};

try {
  await boot(false);

  const htmlIp = '198.51.100.41';
  for (let i = 0; i < 60; i += 1) {
    const response = await request('/login', htmlIp);
    assert.equal(response.statusCode, 200, `normal HTML navigation ${i + 1}`);
    assert.match(response.headers['content-type'], /^text\/html/);
  }
  const htmlLimited = await request('/login', htmlIp);
  assertHtmlRateLimit(htmlLimited);

  const defaultAcceptIp = '198.51.100.42';
  for (let i = 0; i < 60; i += 1) {
    assert.equal(
      (await request('/login', defaultAcceptIp, { headers: { accept: '*/*' } })).statusCode,
      200,
      `normal default-Accept request ${i + 1}`,
    );
  }
  assertJsonRateLimit(await request('/login', defaultAcceptIp, { headers: { accept: '*/*' } }));

  const apiIp = '198.51.100.43';
  for (let i = 0; i < 20; i += 1) {
    const response = await request('/api/auth/captcha', apiIp);
    assert.equal(response.statusCode, 200, `normal captcha request ${i + 1}`);
    assert.equal(typeof response.json().captchaId, 'string');
  }
  assertJsonRateLimit(await request('/api/auth/captcha', apiIp));

  const staticIp = '198.51.100.45';
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(
      (await request('/main.css', staticIp, { headers: { accept: '*/*' } })).statusCode,
      200,
      `normal static request ${i + 1}`,
    );
  }
  const headLimited = await request('/about', staticIp, { method: 'HEAD' });
  assert.equal(headLimited.statusCode, 429);
  assert.match(headLimited.headers['content-type'], /^text\/html;\s*charset=utf-8/);
  assert.ok(Number(headLimited.headers['retry-after']) >= 1);
  assertJsonRateLimit(await request('/main.css', staticIp));
  assertJsonRateLimit(await request('/socket.io/?EIO=4&transport=polling', staticIp));
  assertHtmlRateLimit(await request('/about', staticIp));

  const normal = await request('/login', '198.51.100.46');
  assert.equal(normal.statusCode, 200, 'one limited IP does not affect another IP');
  assert.match(normal.body, /<header class="site-header">/);

  console.log('PASS auth page 60/min: HTML 429, Chinese body, real TTL, Retry-After and HEAD');
  console.log('PASS content negotiation: default */*, API, static and socket responses stay JSON');
  console.log('PASS global page limit and normal requests on unrelated IPs');
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
