// @提及回归测试：解析候选、渲染链接/降级、动态与评论落库、旧数据向后兼容。
// 需先 `pnpm run build`。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serialize } from 'node:v8';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMentionTokens, renderMentionsInHtml } = require('../dist/mentions.js');
const { renderRichTextWithMentions } = require('../dist/text-render.js');
const { FeedStore } = require('../dist/feed-store.js');
const { encodeRawBinary } = require('../dist/binary-store.js');

/* ---------- 解析 ---------- */

assert.deepEqual(parseMentionTokens('你好 @Foo 和 @foo 还有 @bar_1'), ['Foo', 'bar_1'], '去重保留首次大小写');
assert.deepEqual(parseMentionTokens('@Foo'), ['Foo'], '行首提及');
assert.deepEqual(parseMentionTokens('(@Foo)'), ['Foo'], '标点边界');
assert.deepEqual(parseMentionTokens('a@b.com'), [], '邮箱不识别');
assert.deepEqual(parseMentionTokens('x@Foo'), [], '词内 @ 不识别');
assert.deepEqual(parseMentionTokens('@ab'), [], '短于 3 位不识别');
assert.deepEqual(parseMentionTokens('@abcdefghijklmnopqrstuv'), [], '长于 20 位不识别');
assert.deepEqual(parseMentionTokens('@abcdefghijklmnopqrst'), ['abcdefghijklmnopqrst'], '恰好 20 位识别');
assert.deepEqual(parseMentionTokens('@@Foo'), [], '连续 @@ 不识别');
assert.deepEqual(parseMentionTokens('纯文本没有提及'), [], '无提及');

/* ---------- 渲染 ---------- */

const resolve = (token) => (token.toLowerCase() === 'foo' ? 'Foo' : null);

const hit = renderMentionsInHtml('<p>hi @foo bye</p>', resolve);
assert.equal(
  hit.html,
  '<p>hi <a href="/u/Foo" class="mention rt-unrated" data-username="Foo">@Foo</a> bye</p>',
  '存在用户渲染为链接',
);
assert.deepEqual(hit.mentions, ['Foo'], '返回被链接的规范用户名');

const miss = renderMentionsInHtml('<p>hi @ghost bye</p>', resolve);
assert.equal(miss.html, '<p>hi @ghost bye</p>', '不存在用户降级为普通文本');
assert.deepEqual(miss.mentions, [], '无有效提及');

const inCode = renderMentionsInHtml('<p><code>@foo</code> @foo</p>', resolve);
assert.equal(
  inCode.html,
  '<p><code>@foo</code> <a href="/u/Foo" class="mention rt-unrated" data-username="Foo">@Foo</a></p>',
  'code 内不替换，外部替换',
);

const inLink = renderMentionsInHtml('<p><a href="/u/foo">@foo</a></p>', resolve);
assert.equal(inLink.html, '<p><a href="/u/foo">@foo</a></p>', '已有链接内不替换');

assert.equal(
  renderMentionsInHtml('<p>mail a@foo.com</p>', resolve).html,
  '<p>mail a@foo.com</p>',
  '邮箱样文本不替换',
);

/* ---------- 与富文本管线集成 ---------- */

const rendered = renderRichTextWithMentions('**@foo** <script>alert(1)</script>', resolve);
assert.ok(rendered.html.includes('href="/u/Foo"'), '集成：提及渲染为链接');
assert.ok(!rendered.html.includes('<script'), '集成：脚本被消毒');
assert.deepEqual(rendered.mentions, ['Foo'], '集成：返回提及列表');

/* ---------- 落库与向后兼容 ---------- */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roka-mentions-'));
try {
  const store = new FeedStore(dataDir);
  await store.ensureReady();

  const post = await store.create('Alice', 'hello @Bob and @Bob');
  assert.deepEqual(post.mentions, ['Bob'], '动态落库提及（去重）');

  const comment = await store.addComment(post.id, 'Carol', '同意 @Bob、@dave_1');
  assert.deepEqual(comment.mentions, ['Bob', 'dave_1'], '评论落库提及');

  const reloaded = new FeedStore(dataDir);
  await reloaded.ensureReady();
  assert.deepEqual(reloaded.listAll()[0].mentions, ['Bob'], '重启后提及仍在');
  assert.deepEqual(reloaded.listAll()[0].comments[0].mentions, ['Bob', 'dave_1'], '评论提及仍在');

  // 旧格式 feeds.bin：帖子/评论没有 mentions 字段，读取不得报错且新写入正常。
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roka-mentions-legacy-'));
  try {
    const legacyData = {
      posts: [
        {
          id: 'legacy1',
          author: 'Old',
          text: '旧动态 @Nobody',
          time: Date.now() - 1000,
          likes: [],
          comments: [{ id: 'c1', author: 'Old2', text: '旧评论', time: Date.now() - 500 }],
        },
      ],
    };
    await fs.writeFile(
      path.join(legacyDir, 'feeds.bin'),
      await encodeRawBinary(serialize(legacyData)),
    );
    const legacyStore = new FeedStore(legacyDir);
    await legacyStore.ensureReady();
    const legacyPost = legacyStore.listAll()[0];
    assert.equal(legacyPost.mentions, undefined, '旧动态无 mentions 字段不报错');
    assert.equal(legacyPost.comments[0].mentions, undefined, '旧评论无 mentions 字段不报错');
    const newPost = await legacyStore.create('Old', '新动态 @Alice');
    assert.deepEqual(newPost.mentions, ['Alice'], '旧数据目录仍可正常写入');
  } finally {
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log('test-mentions: all assertions passed');
