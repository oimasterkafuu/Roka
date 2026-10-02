import assert from 'node:assert/strict';
import { AuthService } from '../dist/server/auth-service.js';

const auth = new AuthService({});
for (const path of [
  '/',
  '/rooms',
  '/replays',
  '/games',
  '/u/Alice',
  '/develop',
  '/develop/bot',
  '/about',
  '/tutorial',
  '/tutorial/interactive',
  '/replays/abc',
]) {
  assert.equal(auth.isPublicPath(path, 'GET'), true, `public page: ${path}`);
}
for (const path of [
  '/api/rooms',
  '/api/replays',
  '/api/announcement',
  '/api/leaderboard',
  '/api/points-leaderboard',
  '/api/online',
  '/api/user-colors',
  '/api/feeds',
  '/api/profile/Alice',
  '/api/profile/Alice/feeds',
  '/api/profile/Alice/replays',
  '/api/getreplay/abc',
  '/api/downloadreplay/abc',
  '/api/map-examples',
]) {
  assert.equal(auth.isPublicPath(path, 'GET'), true, `public API: ${path}`);
}
for (const path of ['/games/room', '/api/auth/me', '/api/replay-upload', '/api/feeds', '/api/feeds/like']) {
  assert.equal(auth.isPublicPath(path, 'GET'), path === '/api/feeds');
}
for (const path of [
  '/games/room',
  '/api/feeds',
  '/api/feeds/like',
  '/api/announcement',
  '/api/replay-upload',
]) {
  assert.equal(auth.isPublicPath(path, 'POST'), false, `protected write: ${path}`);
}
assert.equal(auth.isPublicPath('/api/auth/me', 'GET'), false);
assert.equal(auth.isPublicPath('/socket.io/', 'POST'), true);
console.log('guest access tests passed');
