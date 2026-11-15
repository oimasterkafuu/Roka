import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = {
  'replays.html': ['app', 'replay-query', 'replays-heading', 'replays-body', 'replays-pagination'],
  'ambassadors.html': ['app', 'ambassador-grid', 'ambassadors-status', 'ambassador-invite-link'],
  'about.html': ['app', 'account-name', 'contributors-grid', 'contributors-title'],
  'login.html': ['auth-username', 'auth-password', 'auth-captcha', 'captcha-image', 'login-btn'],
};

function build() {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: rootDir, stdio: 'pipe' });
}

function snapshots() {
  return Object.fromEntries(
    Object.keys(pages).map((name) => {
      const html = readFileSync(path.join(rootDir, 'static', name), 'utf8');
      return [name, createHash('sha256').update(html).digest('hex')];
    }),
  );
}

build();
const first = snapshots();
build();
assert.deepEqual(snapshots(), first, 'two consecutive page builds must be byte-identical');

for (const [name, ids] of Object.entries(pages)) {
  const html = readFileSync(path.join(rootDir, 'static', name), 'utf8');
  assert.match(html, /^<!doctype html>/);
  for (const id of ids) assert.match(html, new RegExp(`\\bid="${id}"`), `${name}: #${id}`);
  for (const asset of [
    '/icons/favicon.ico?v={{V}}',
    '/icons/icon-32.png?v={{V}}',
    '/icons/icon-192.png?v={{V}}',
    '/icons/icon-180.png?v={{V}}',
    '/main.css?v={{V}}',
  ]) {
    assert.ok(html.includes(asset), `${name}: ${asset}`);
  }
}

const replays = readFileSync(path.join(rootDir, 'static/replays.html'), 'utf8');
assert.ok(replays.includes('/vendor/socket.io/socket.io-4.0.1.js?v={{V}}'));
assert.ok(replays.includes('/username.js?v={{V}}'));
assert.ok(replays.includes('/replays.js?v={{V}}'));
const ambassadors = readFileSync(path.join(rootDir, 'static/ambassadors.html'), 'utf8');
assert.ok(ambassadors.includes('/styles/rating.css?v={{V}}'));
assert.ok(ambassadors.includes('/username.js?v={{V}}'));

console.log('PASS build-pages: four templates, required ids/assets, socket and username component, idempotent output');
