// 存储层回归测试（issue #67）：直接驱动 dist 的四个 Store，
// 验证写合并、.bak 备份回退与旧格式兼容：
//   场景 1：UserStore 突发连续写入后落盘数据完整（合并写不丢状态）。
//   场景 2：每次落盘生成 .bak 备份；主文件损坏时启动自动回退 .bak。
//   场景 3：旧格式兼容——用历史写法（v8 serialize + brotli q6 直接写文件）
//           造出的 users.bin / feeds.bin，新代码原样可读（无需迁移）。
//   场景 4：FeedStore 发帖/点赞/评论突发写入 + 主文件损坏回退。
//   场景 5：ReplayStore 索引内存缓存（写入后 listReplays 立即可见）、
//           重启后从磁盘恢复、index.bin 损坏回退 .bak、deleteReplay 清理。
//   场景 6：AnnouncementStore 主文件损坏回退 .bak。
// 成功 exit 0，失败 exit 1。
// 运行前需先 `pnpm run build`（本脚本读取 dist 产物）。

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import v8 from 'node:v8';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const { UserStore } = require('./dist/auth-store.js');
const { FeedStore } = require('./dist/feed-store.js');
const { ReplayStore } = require('./dist/replay-store.js');
const { AnnouncementStore } = require('./dist/announcement-store.js');

const compressAsync = promisify(brotliCompress);
const decompressAsync = promisify(brotliDecompress);

let failures = 0;
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok - ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${label}`);
  }
};

/** 历史写法的独立解码：brotli 解压 + v8 deserialize（证明磁盘格式未变）。 */
const decodeLegacy = async (filePath) => v8.deserialize(await decompressAsync(await readFile(filePath)));

/** 历史写法的独立编码：v8 serialize + brotli q6（与旧版 store 逐字节同格式）。 */
const encodeLegacy = (value) =>
  compressAsync(v8.serialize(value), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } });

async function scenarioUserStore() {
  console.log('场景 1/2：UserStore 突发写入 + 损坏回退');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-storage-users-'));
  try {
    const store = new UserStore(dataDir);
    await store.ensureReady();
    // 突发连续写入：每次 register 都触发一次全量落盘，合并写后最终状态必须完整。
    for (let i = 0; i < 20; i += 1) {
      await store.register(`user_${String(i).padStart(2, '0')}`, 'password1');
    }
    const file = await decodeLegacy(path.join(dataDir, 'users.bin'));
    check('突发写入后 users.bin 含全部 20 个用户', Array.isArray(file.users) && file.users.length === 20);

    const bak = await decodeLegacy(path.join(dataDir, 'users.bin.bak'));
    check('.bak 备份存在且可解码', Array.isArray(bak.users) && bak.users.length >= 1);

    // 主文件损坏 → 新实例启动应回退 .bak（数据为上一代快照，不丢全部）。
    await writeFile(path.join(dataDir, 'users.bin'), Buffer.from('corrupted-data'));
    const recovered = new UserStore(dataDir);
    await recovered.ensureReady();
    check(
      '主文件损坏后从 .bak 恢复用户数据',
      recovered.listUsersForAdmin().length === bak.users.length && bak.users.length >= 1,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function scenarioLegacyCompat() {
  console.log('场景 3：旧格式文件原样可读（向后兼容）');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-storage-legacy-'));
  try {
    // 用旧版写法直接落盘（绕过新代码），模拟升级前的存量数据。
    const legacyUser = {
      username: 'legacy_user',
      passwordSalt: '00',
      passwordHash: '00',
      sessionId: null,
      createdAt: 1,
      updatedAt: 1,
      rating: 1200,
      ratingGames: 0,
    };
    await writeFile(path.join(dataDir, 'users.bin'), await encodeLegacy({ users: [legacyUser] }));
    await writeFile(
      path.join(dataDir, 'feeds.bin'),
      await encodeLegacy({
        posts: [{ id: 'p1', author: 'legacy_user', text: 'hi', time: 1, likes: [], comments: [] }],
      }),
    );

    const users = new UserStore(dataDir);
    await users.ensureReady();
    check('旧格式 users.bin 可读', users.getPublicProfile('legacy_user') !== null);

    const feeds = new FeedStore(dataDir);
    await feeds.ensureReady();
    check('旧格式 feeds.bin 可读', feeds.getById('p1')?.text === 'hi');

    // 读取后再写入，仍应是同一格式（维护脚本/旧版本可继续解码）。
    await users.rotateSession('legacy_user');
    const roundTrip = await decodeLegacy(path.join(dataDir, 'users.bin'));
    check('新代码写回后仍为旧格式可解码', roundTrip.users[0].username === 'legacy_user');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function scenarioDisciplineStorage() {
  console.log('场景 3b：封禁理由、详情持久化与到期');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-storage-discipline-'));
  try {
    const store = new UserStore(dataDir);
    await store.ensureReady();
    await store.register('discipline_admin', 'password1');
    await store.register('discipline_user', 'password1');
    const until = Date.now() + 3_600_000;
    await store.applyBan('discipline_user', until, {
      type: 'manual',
      reason: '发布不当言论',
      evidence: 'test evidence',
    });
    const listed = store.listUsersForAdmin().find((item) => item.username === 'discipline_user');
    check('管理员查询包含封禁理由与证据', listed?.ban?.reason === '发布不当言论' && listed.ban.evidence === 'test evidence');
    const restarted = new UserStore(dataDir);
    await restarted.ensureReady();
    check('封禁详情重启后仍持久化', restarted.getBanStatus('discipline_user').ban?.reason === '发布不当言论');
    await restarted.applyBan('discipline_user', Date.now() - 1, {
      type: 'manual',
      reason: '过期测试',
    });
    check('到期惰性恢复但保留历史', !restarted.getBanStatus('discipline_user').banned && restarted.listUsersForAdmin().find((item) => item.username === 'discipline_user').banHistory.length >= 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function scenarioFeedStore() {
  console.log('场景 4：FeedStore 突发写入 + 损坏回退');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-storage-feeds-'));
  try {
    const store = new FeedStore(dataDir);
    await store.ensureReady();
    const post = await store.create('alice', '第一条动态');
    await store.toggleLike(post.id, 'bob');
    await store.toggleLike(post.id, 'carol');
    await store.addComment(post.id, 'bob', '顶一下');
    const loaded = store.getById(post.id);
    check('点赞与评论全部落内存', loaded.likes.length === 2 && loaded.comments.length === 1);

    const file = await decodeLegacy(path.join(dataDir, 'feeds.bin'));
    check(
      '突发写入后 feeds.bin 状态完整',
      file.posts.length === 1 && file.posts[0].likes.length === 2 && file.posts[0].comments.length === 1,
    );

    await writeFile(path.join(dataDir, 'feeds.bin'), Buffer.from([1, 2, 3, 4]));
    const recovered = new FeedStore(dataDir);
    await recovered.ensureReady();
    check('feeds.bin 损坏后从 .bak 恢复', recovered.getById(post.id) !== null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function scenarioReplayStore() {
  console.log('场景 5：ReplayStore 索引缓存 + 损坏回退 + 删除');
  const replayDir = await mkdtemp(path.join(tmpdir(), 'roka-storage-replays-'));
  const dummyBuilder = async (replay) => ({ replay });
  try {
    const store = new ReplayStore(replayDir, { buildReplayFromActions: dummyBuilder });
    await store.ensureReady();

    const mkReplay = (n) => ({
      version: 'ops-v1',
      meta: { width_ratio: 1, height_ratio: 1, city_ratio: 0, mountain_ratio: 0, swamp_ratio: 0, speed: 1 },
      total_turns: n,
      player_ops: [[{ op: 'w', n }]],
    });
    const summary = { rank: ['alice', 'bob'], teams: [], turn: 10 };
    const id1 = await store.saveReplay(mkReplay(11), summary);
    const id2 = await store.saveReplay(mkReplay(22), summary);
    const id3 = await store.saveReplay(mkReplay(33), summary);

    const listed = await store.listReplays();
    check('写入后 listReplays 立即可见（内存缓存）', listed.length === 3);
    check(
      '回放原始文件已落盘',
      [id1, id2, id3].every((id) => listed.some((item) => item.id === id)),
    );

    // 重启（新实例）：索引从磁盘恢复。
    const restarted = new ReplayStore(replayDir, { buildReplayFromActions: dummyBuilder });
    await restarted.ensureReady();
    check('重启后索引从磁盘恢复', (await restarted.listReplays()).length === 3);

    // index.bin 损坏 → 回退 .bak（ restarted.ensureReady() 重写索引后 .bak 即为全量）。
    await writeFile(path.join(replayDir, 'index.bin'), Buffer.from('garbage-index'));
    const fallback = new ReplayStore(replayDir, { buildReplayFromActions: dummyBuilder });
    await fallback.ensureReady();
    const fallbackItems = await fallback.listReplays();
    check('index.bin 损坏后从 .bak 恢复索引', fallbackItems.length === 3);

    await restarted.deleteReplay(id1);
    const afterDelete = await restarted.listReplays();
    check(
      'deleteReplay 后索引移除',
      afterDelete.length === 2 && !afterDelete.some((item) => item.id === id1),
    );
  } finally {
    await rm(replayDir, { recursive: true, force: true });
  }
}

async function scenarioAnnouncement() {
  console.log('场景 6：AnnouncementStore 损坏回退');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-storage-announcement-'));
  try {
    const store = new AnnouncementStore(dataDir);
    await store.ensureReady();
    await store.set('第一条公告', 'admin');
    await store.set('第二条公告', 'admin');

    await writeFile(path.join(dataDir, 'announcement.json'), 'not-json{{{');
    const recovered = new AnnouncementStore(dataDir);
    await recovered.ensureReady();
    check('announcement.json 损坏后从 .bak 恢复', recovered.get().text === '第一条公告');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await scenarioUserStore();
  await scenarioLegacyCompat();
  await scenarioDisciplineStorage();
  await scenarioFeedStore();
  await scenarioReplayStore();
  await scenarioAnnouncement();

  if (failures > 0) {
    console.error(`\n${failures} 项检查失败。`);
    process.exit(1);
  }
  console.log('\n全部通过。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
