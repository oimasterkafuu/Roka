import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Fastify from 'fastify';
import {
  CONTRIBUTORS_CACHE_TTL_MS,
  GITHUB_CONTRIBUTORS_URL,
  ContributorsService,
  handleContributorsRequest,
} from '../dist/server/contributors-service.js';
import { AuthService } from '../dist/server/auth-service.js';

function contributor(login, contributions, overrides = {}) {
  return {
    login,
    html_url: `https://github.com/${login}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${contributions}?v=4`,
    contributions,
    type: 'User',
    ...overrides,
  };
}

function githubResponse(items, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => items };
}

let now = 1_000_000;
let requestCount = 0;
let failRequests = false;
let request;
const successPayload = [
  contributor('zoe', 4),
  contributor('alice', 12, { site_admin: true, node_id: 'private-metadata' }),
  contributor('dependabot', 100, { type: 'Bot' }),
  contributor('wrong-profile', 9, { html_url: 'https://github.com/someone-else' }),
  contributor('query-profile', 9, { html_url: 'https://github.com/query-profile?tab=repos' }),
  contributor('evil-profile', 9, { html_url: 'javascript:alert(1)' }),
  contributor('evil-avatar', 9, { avatar_url: 'https://example.com/avatar.png' }),
  contributor('http-avatar', 9, { avatar_url: 'http://avatars.githubusercontent.com/u/9' }),
  contributor('bad-login', 9, { login: '<img src=x onerror=alert(1)>' }),
  contributor('zero', 0),
  { type: 'User', login: null, contributions: 20 },
];
const service = new ContributorsService({
  now: () => now,
  fetchImpl: async (url, options) => {
    requestCount += 1;
    request = { url, options };
    if (failRequests) throw new Error('temporary GitHub failure');
    return githubResponse(successPayload);
  },
});
const app = Fastify();
app.get('/api/contributors', async (_request, reply) => handleContributorsRequest(service, reply));
const firstResponse = await app.inject({ method: 'GET', url: '/api/contributors' });
assert.equal(firstResponse.statusCode, 200);
const first = firstResponse.json();
assert.deepEqual(first, [
  {
    login: 'alice',
    html_url: 'https://github.com/alice',
    avatar_url: 'https://avatars.githubusercontent.com/u/12?v=4',
    contributions: 12,
  },
  {
    login: 'zoe',
    html_url: 'https://github.com/zoe',
    avatar_url: 'https://avatars.githubusercontent.com/u/4?v=4',
    contributions: 4,
  },
]);
assert.deepEqual(Object.keys(first[0]), ['login', 'html_url', 'avatar_url', 'contributions']);
assert.equal(request.url, GITHUB_CONTRIBUTORS_URL);
assert.equal(request.options.method, 'GET');
assert.equal(request.options.headers.Accept, 'application/vnd.github+json');
assert.equal(Object.hasOwn(request.options.headers, 'Authorization'), false);
assert.equal(request.options.signal instanceof AbortSignal, true);
assert.equal((await app.inject({ method: 'GET', url: '/api/contributors' })).statusCode, 200);
assert.equal(requestCount, 1, 'fresh cache avoids another GitHub request');

now += CONTRIBUTORS_CACHE_TTL_MS + 1;
failRequests = true;
assert.deepEqual(await service.getContributors(), first, 'expired cache remains available on failure');
assert.equal(requestCount, 2);
await app.close();

const unavailableApp = Fastify();
const unavailable = new ContributorsService({
  fetchImpl: async () => githubResponse({ message: 'rate limited' }, 403),
});
unavailableApp.get('/api/contributors', async (_request, reply) =>
  handleContributorsRequest(unavailable, reply),
);
const failure = await unavailableApp.inject({ method: 'GET', url: '/api/contributors' });
assert.equal(failure.statusCode, 503);
assert.match(failure.json().error, /暂时无法/);
assert.equal(Array.isArray(failure.json()), false, 'failure must not masquerade as an empty list');
await unavailableApp.close();

const timeoutService = new ContributorsService({
  timeoutMs: 5,
  fetchImpl: async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('request timed out')));
    }),
});
await assert.rejects(timeoutService.getContributors(), /request timed out/);

const auth = new AuthService({});
assert.equal(auth.isPublicPath('/api/contributors', 'GET'), true);
assert.equal(auth.isPublicPath('/api/contributors/', 'GET'), true);
assert.equal(auth.isPublicPath('/api/contributors', 'POST'), false);

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.hidden = false;
    this.textContent = '';
  }

  set innerHTML(_value) {
    throw new Error('innerHTML is forbidden in contributor rendering');
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

function fakeDocument() {
  const nodes = {
    'contributors-grid': new FakeElement('div'),
    'contributors-status': new FakeElement('p'),
  };
  return {
    nodes,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => nodes[id] ?? null,
  };
}

const frontendSource = readFileSync(new URL('../static/about-contributors.js', import.meta.url), 'utf8');
async function renderFrontend(response) {
  const document = fakeDocument();
  const context = vm.createContext({
    console,
    document,
    URL,
    fetch: async () => response,
  });
  vm.runInContext(frontendSource, context, { filename: 'static/about-contributors.js' });
  await context.aboutContributorsReady;
  return document;
}

const rendered = await renderFrontend(
  githubResponse([
    contributor('alice', 12),
    contributor('<img src=x onerror=alert(1)>', 99, {
      html_url: 'https://github.com/%3Cimg%20src=x%20onerror=alert(1)%3E',
    }),
    contributor('evil-link', 88, { html_url: 'javascript:alert(1)' }),
  ]),
);
assert.equal(rendered.nodes['contributors-grid'].children.length, 1);
const card = rendered.nodes['contributors-grid'].children[0];
const link = card.children[0];
const [avatar, name, count] = link.children;
assert.equal(link.href, 'https://github.com/alice');
assert.equal(link.target, '_blank');
assert.equal(link.rel, 'noopener noreferrer');
assert.equal(avatar.src, 'https://avatars.githubusercontent.com/u/12?v=4');
assert.equal(avatar.alt, 'alice 的 GitHub 头像');
assert.equal(avatar.loading, 'lazy');
assert.equal(name.textContent, 'alice');
assert.equal(count.textContent, '12 次贡献');
assert.equal(rendered.nodes['contributors-status'].hidden, true);

const failedRender = await renderFrontend(githubResponse({}, 503));
assert.equal(failedRender.nodes['contributors-grid'].children.length, 0);
assert.equal(failedRender.nodes['contributors-status'].hidden, false);
assert.match(failedRender.nodes['contributors-status'].textContent, /暂时无法加载/);
assert.equal(frontendSource.includes('innerHTML'), false);

const aboutSource = readFileSync(new URL('../static/about.html', import.meta.url), 'utf8');
assert.ok(aboutSource.indexOf('项目贡献者') < aboutSource.indexOf('来源与参考'));
assert.ok(aboutSource.includes('https://github.com/oimasterkafuu/Roka/graphs/contributors'));
assert.ok(aboutSource.includes('/about-contributors.js?v={{V}}'));

console.log('contributor API, cache, validation, anonymous access and DOM rendering tests passed');
