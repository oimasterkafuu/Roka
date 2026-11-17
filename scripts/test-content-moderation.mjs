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
const { UsernameSecurityService } = require('../dist/server/username-security.js');
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
  const before = users.listUsersForAdmin();
  const registration = new RegistrationSecurity(users, audit);
  assert.equal((await registration.review('shabi', null)).allowed, false);
  assert.equal((await registration.review('animal', null)).allowed, true);
  const bannedNames = [];
  const usernameScan = new UsernameSecurityService(
    {
      listUsersForAdmin: () =>
        ['shabi', 'animal'].map((username) => ({ username, isSuperAdmin: false, bannedUntil: null })),
      applyBan: async (username) => {
        bannedNames.push(username);
      },
    },
    audit,
    async () => {},
  );
  assert.equal((await usernameScan.scan()).hits, 1);
  assert.deepEqual(bannedNames, ['shabi']);

  const post = await feeds.create('author', '傻逼 <img src=x onerror=alert(1)>');
  assert.equal(post.editedAt, undefined);
  const comment = await feeds.addComment(post.id, 'author', '正常评论');
  const scanner = new ContentSecurityService(feeds, audit);
  const first = scanner.scan();
  assert.equal(scanner.scan(), first);
  assert.equal((await first).scanned, 2);
  assert.equal(audit.list({ type: 'content_manual_review' }).length, 1);
  assert.equal((await scanner.scan()).scanned, 0);
  await feeds.toggleLike(post.id, 'author');
  assert.equal((await scanner.scan()).scanned, 0);
  await feeds.update(post.id, '草泥马');
  assert.ok(post.editedAt > post.time);
  assert.equal((await scanner.scan()).hits, 1);
  const reloadedFeeds = new FeedStore(dir);
  await reloadedFeeds.ensureReady();
  assert.equal(reloadedFeeds.getById(post.id).editedAt, post.editedAt);
  const realNow = Date.now;
  const previousVersion = post.editedAt;
  Date.now = () => previousVersion;
  try {
    await feeds.update(post.id, '正常中文');
    const nextComment = await feeds.addComment(post.id, 'author', '正常中文评论');
    assert.ok(post.editedAt > previousVersion);
    assert.ok(nextComment.time > post.editedAt);
    await feeds.update(post.id, '草泥马');
    assert.ok(post.editedAt > nextComment.time);
  } finally {
    Date.now = realNow;
  }
  assert.equal((await scanner.scan()).scanned, 2);

  // Inject same timestamp arrivals through a snapshot provider, independent of wall clock.
  const time = audit.getContentCursor().time;
  const sameTimePost = {
    id: 'same-ms',
    author: 'author',
    text: '正常动态',
    time,
    likes: [],
    comments: [{ id: 'c', author: 'author', text: 'nmsl', time }],
  };
  const snapshot = { listAll: () => [...feeds.listAll(), structuredClone(sameTimePost)] };
  let restarted = new SecurityAuditStore(dir);
  await restarted.ensureReady();
  let service = new ContentSecurityService(snapshot, restarted);
  assert.equal((await service.scan()).scanned, 2);
  restarted = new SecurityAuditStore(dir);
  await restarted.ensureReady();
  service = new ContentSecurityService(snapshot, restarted);
  assert.equal((await service.scan()).scanned, 0);
  const oldCursor = restarted.getContentCursor();
  sameTimePost.comments.push({ id: 'late', author: 'author', text: '傻b', time });
  // Real persistence failure: missing parent directory; no checkpoint or partial hit survives retry.
  await rename(dir, dir + '-offline');
  await assert.rejects(service.scan());
  assert.deepEqual(restarted.getContentCursor(), oldCursor);
  await rename(dir + '-offline', dir);
  assert.equal((await service.scan()).hits, 1);
  assert.equal((await service.scan()).scanned, 0);
  assert.equal(
    restarted.list({ type: 'content_manual_review' }).filter((e) => e.content.commentId === 'late').length,
    1,
  );
  assert.equal(feeds.getById(post.id).text, '草泥马');
  assert.equal(feeds.getById(post.id).comments[0].id, comment.id);
  assert.deepEqual(users.listUsersForAdmin(), before);
  const checkpoint = restarted.getContentCursor();
  // Exercise trimming without thousands of separate writes.
  await restarted.completeContentScan(
    Array.from({ length: 2100 }, () => ({
      at: Date.now(),
      type: 'content_scan_completed',
      action: 'test',
      reason: 'x'.repeat(1500),
    })),
    checkpoint,
  );
  const file = path.join(dir, 'security-audit.json');
  assert.ok((await stat(file)).size <= SECURITY_AUDIT_MAX_BYTES);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(JSON.parse(await readFile(file, 'utf8')).entries.length <= 2000);
  const recovered = new SecurityAuditStore(dir);
  await recovered.ensureReady();
  assert.deepEqual(recovered.getContentCursor(), checkpoint);
  assert.equal((await new ContentSecurityService(snapshot, recovered).scan()).scanned, 0);
  await service.stop();
  console.log(
    'PASS content policies, shared registration, incremental versions, same-ms arrivals, restart, atomic failure retry, pruning, review-only effects',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
  await rm(dir + '-offline', { recursive: true, force: true });
}
