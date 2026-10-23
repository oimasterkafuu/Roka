import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { AuthService } from '../dist/server/auth-service.js';
const auth = new AuthService({});
const manifest = JSON.parse(await readFile('static/intro/assets/manifest.json', 'utf8'));
const urls = [
  ...Object.values(manifest.files),
  ...Object.values(manifest.images),
  ...Object.values(manifest.fonts),
];
for (const url of ['/intro/player.js', '/intro/assets/manifest.json', ...urls]) {
  assert(auth.isPublicPath(url, 'GET'), url);
  assert(auth.isPublicPath(url, 'HEAD'), url);
  assert.equal(auth.isPublicPath(url, 'POST'), false, url);
}
for (const url of [
  '/intro/assets/private.json',
  '/intro/assets/../secret.bin',
  '/api/model.bin',
  '/intro/assets/test.0123456789abcdef.exe',
])
  assert.equal(auth.isPublicPath(url, 'GET'), false, url);
const base = process.env.ROKA_INTRO_BASE;
if (base) {
  const plan = manifest.files['plan.json'];
  const response = await fetch(base + plan, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Encoding'), 'br');
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  const body = await response.json();
  assert.equal(body.duration, 124);
  const head = await fetch(base + manifest.files['knight-hero.glb'], { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  const mutable = await fetch(base + '/intro/assets/manifest.json');
  assert(!mutable.headers.get('Cache-Control')?.includes('immutable'));
  const etag = response.headers.get('etag');
  const cached = await new Promise((resolve, reject) => {
    http
      .get(base + plan, { headers: { 'Accept-Encoding': 'br', 'If-None-Match': etag } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(cached, 304);
}
console.log('Intro guest GET/HEAD, protected writes, compressed delivery and cache headers passed.');
