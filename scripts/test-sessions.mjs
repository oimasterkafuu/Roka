import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserStore, SESSION_TTL_MS } from '../dist/auth-store.js';
import { decodeBinary, encodeBinary } from '../dist/binary-store.js';
import { AuthService } from '../dist/server/auth-service.js';
import jwt from 'jsonwebtoken';
const dir = await mkdtemp(path.join(os.tmpdir(), 'roka-sessions-unit-'));
try {
  const store = new UserStore(dir);
  await store.ensureReady();
  await store.register('admin_user', 'password1');
  await store.register('normal_user', 'password1');
  const a = await store.createSession('normal_user'),
    b = await store.createSession('normal_user');
  assert.notEqual(a, b);
  assert.equal(store.isSessionValid('normal_user', a), true);
  assert.equal(store.isSessionValid('normal_user', b), true);
  let restarted = new UserStore(dir);
  await restarted.ensureReady();
  assert.equal(restarted.isSessionValid('normal_user', a), true);
  assert.equal(restarted.isSessionValid('normal_user', b), true);
  await restarted.clearSession('normal_user', a);
  assert.equal(restarted.isSessionValid('normal_user', a), false);
  assert.equal(restarted.isSessionValid('normal_user', b), true);
  const file = path.join(dir, 'users.bin');
  let data = await decodeBinary(await readFile(file));
  const user = data.users.find((u) => u.username === 'normal_user');
  assert.equal(user.sessions[0].expiresAt - user.sessions[0].createdAt, SESSION_TTL_MS);
  user.sessions.push({
    sid: 'expired',
    createdAt: Date.now() - SESSION_TTL_MS - 1000,
    expiresAt: Date.now() - 1000,
  });
  const legacy = data.users.find((u) => u.username === 'admin_user');
  delete legacy.sessions;
  legacy.sessionId = 'legacy-sid';
  legacy.updatedAt = Date.now();
  await writeFile(file, await encodeBinary(data));
  restarted = new UserStore(dir);
  await restarted.ensureReady();
  assert.equal(restarted.isSessionValid('normal_user', 'expired'), false);
  assert.equal(restarted.isSessionValid('normal_user', b), true);
  assert.equal(restarted.isSessionValid('admin_user', 'legacy-sid'), true);
  data = await decodeBinary(await readFile(file));
  assert.equal(
    data.users.some((u) => u.sessionId),
    false,
  );
  assert.equal(
    data.users.find((u) => u.username === 'normal_user').sessions.some((s) => s.sid === 'expired'),
    false,
  );
  const auth = new AuthService(restarted);
  const token = auth.signAuthToken('normal_user', b);
  const claims = jwt.decode(token);
  assert.equal(claims.exp - claims.iat, 7 * 24 * 3600);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + SESSION_TTL_MS + 1000;
    assert.equal(auth.verifyAuthToken(token), null);
    assert.equal(restarted.isSessionValid('normal_user', b), false);
    await restarted.cleanupExpiredSessions();
  } finally {
    Date.now = realNow;
  }
  const c = await restarted.createSession('normal_user'),
    d = await restarted.createSession('normal_user');
  const idle = await restarted.createSession('normal_user');
  const notices = [];
  const oldSocket = {
    connected: true,
    data: { sessionSid: c },
    emit: (event, payload) => notices.push([event, payload.reason]),
    disconnect() {
      this.connected = false;
    },
  };
  const newSocket = { connected: true, data: { sessionSid: d } };
  auth.attachSocketServer({
    sockets: {
      sockets: new Map([
        ['old', oldSocket],
        ['new', newSocket],
      ]),
    },
  });
  auth.trackSocket('normal_user', 'old');
  await auth.activateSession('normal_user', d, 'new');
  assert.equal(restarted.isSessionValid('normal_user', c), false);
  assert.equal(restarted.isSessionValid('normal_user', d), true);
  assert.equal(
    restarted.isSessionValid('normal_user', idle),
    true,
    'inactive third sid survives activity conflict',
  );
  assert.deepEqual(notices, [['force_logout', 'new-login']]);
  await assert.rejects(auth.activateSession('normal_user', c), /登录已失效/);
  assert.equal(restarted.isSessionValid('normal_user', d), true, 'revoked handshake cannot evict the winner');
  await restarted.banUser('normal_user', -1);
  assert.equal(restarted.isSessionValid('normal_user', c), false);
  assert.equal(restarted.isSessionValid('normal_user', d), false);
  console.log(
    'PASS independent sessions, restart, targeted logout, legacy migration, exact seven-day expiry, JWT exp, ban clears all',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
