import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { inspectContent } = require('../dist/server/content-policy.js');
const { inspectUsername } = require('../dist/server/username-policy.js');
const { ContentSecurityService } = require('../dist/server/content-security.js');
const { SecurityAuditStore, SECURITY_AUDIT_MAX_BYTES } = require('../dist/server/security-audit.js');
const { FeedStore } = require('../dist/feed-store.js');
const { UserStore } = require('../dist/auth-store.js');
const { RegistrationSecurity } = require('../dist/server/registration-security.js');
for (const name of [
  'shabi',
  'ＣＡＯＮＩＭＡ',
  'ni_mabi',
  'mabi',
  'wo-cao',
  'NMSL',
  'cnm',
  'nmd',
  'tmd',
  'sh4bi',
])
  assert.equal(inspectUsername(name).violated, true, name);
for (const name of [
  'animal',
  'animation',
  'nima',
  'cao',
  'ri',
  'sb',
  'grass',
  'assistant',
  'classy',
  'scunthorpe',
  'grape',
  'grapes',
  'analysis',
])
  assert.equal(inspectUsername(name).violated, false, name);
for (const text of [
  '傻逼',
  '傻Ｂ',
  '煞 笔',
  '草·泥·马',
  '操你妈',
  '黑鬼',
  '强奸',
  '轮奸',
  '黄片',
  'N.M.S.L',
  'F_U_C_K',
  'SHIT',
  'rape',
])
  assert.equal(inspectContent(text).violated, true, text);
for (const text of [
  '今天一起玩游戏！',
  '垃圾分类，最近压力很大，讨厌下雨',
  'grape grapes Scunthorpe class assistant',
  'const shape = Math.sqrt(4); x = a * b; \\frac{1}{2}',
  'hello world',
])
  assert.equal(inspectContent(text).violated, false, text);
const dir = await mkdtemp(path.join(tmpdir(), 'roka-content-'));
try {
  const feeds = new FeedStore(dir),
    audit = new SecurityAuditStore(dir),
    users = new UserStore(dir);
  await feeds.ensureReady();
  await audit.ensureReady();
  await users.ensureReady();
  await users.register('author', 'password1');
  const registration = new RegistrationSecurity(users, audit);
  assert.equal((await registration.review('shabi', null)).allowed, true);
  assert.equal(audit.list().length, 0, 'preflight is not a registration event');
  await users.register('shabi', 'password1');
  const sid = await users.rotateSession('shabi');
  await registration.afterRegistration('shabi', null, []);
  assert.equal(audit.list({ type: 'username_manual_review' }).length, 1);
  assert.equal(users.getBanStatus('shabi').banned, false);
  assert.equal(users.isSessionValid('shabi', sid), true);
  const service = new ContentSecurityService(audit);
  assert.equal(service.start, undefined);
  assert.equal(service.scan, undefined);
  const post = await feeds.create('author', '傻逼 <img src=x onerror=alert(1)>');
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 0, 'no scan on store access');
  await service.reviewPost(post);
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 1);
  await feeds.toggleLike(post.id, 'author');
  await feeds.listAll();
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 1);
  const comment = await feeds.addComment(post.id, 'author', '正常评论');
  await service.reviewComment(post.id, comment);
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 1);
  const badComment = await feeds.addComment(post.id, 'shabi', '草泥马');
  await service.reviewComment(post.id, badComment);
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 2);
  await feeds.update(post.id, '草泥马');
  await service.reviewPost(post);
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 3);
  await feeds.update(post.id, '正常内容');
  await service.reviewPost(post);
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 3);
  const restarted = new SecurityAuditStore(dir);
  await restarted.ensureReady();
  assert.equal(restarted.list({ type: 'content_manual_review' }).length, 3);
  assert.equal(restarted.list({ type: 'content_scan_completed' }).length, 0);
  assert.equal(users.getBanStatus('author').banned, false);
  assert.equal(users.isSessionValid('shabi', sid), true);
  assert.equal(feeds.getById(post.id).text, '正常内容');
  const file = path.join(dir, 'security-audit.json');
  assert.ok((await stat(file)).size <= SECURITY_AUDIT_MAX_BYTES);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(/(?:usernameSecurity|contentSecurity)\.(?:start|scan)\(/.test(serverSource), false);
  const contentSource = await readFile(new URL('../src/server/content-security.ts', import.meta.url), 'utf8');
  assert.equal(/setInterval|setTimeout/.test(contentSource), false);
  console.log(
    'PASS event-only registration/content review, no auto ban/session clearing, no timers, persistence',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
