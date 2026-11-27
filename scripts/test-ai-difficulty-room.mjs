import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { UserStore } from '../dist/auth-store.js';

const room = 'simple-ai-test';
const secret = 'ai-difficulty-test-secret';
const difficultyTabs = '#tabs-ai-difficulty';
const activeTab = `${difficultyTabs} .inverted`;
const metadata = (data) => [data.ai_difficulty, data.server_bot_seats];

function packet(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 15_000);
    function listener(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    }
    socket.on(event, listener);
  });
}

test(
  'hosted templates share the lobby difficulty, live growth and reconnect/observer metadata',
  { timeout: 90_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roka-difficulty-room-'));
    const sockets = [];
    let child;
    let browser;
    let log = '';
    try {
      const store = new UserStore(dir);
      await store.ensureReady();
      const tokens = {};
      for (const name of ['host', 'watcher', 'hosted_bot']) {
        await store.register(name, 'local-test-pass');
        const sid = await store.rotateSession(name);
        tokens[name] = jwt.sign({ sub: name, sid }, secret, { expiresIn: '1h' });
      }
      const probe = createServer();
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const { port } = probe.address();
      await new Promise((resolve) => probe.close(resolve));
      const base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, ['dist/server.js', '--port', String(port)], {
        env: {
          ...process.env,
          ROKA_DATA_DIR: dir,
          ROKA_STATIC_CDN: '0',
          NODE_ENV: 'test',
          ROKA_BOT_TOKENS: 'third-party-token:third_party,same-name-token:hosted_bot',
          JWT_SECRET: secret,
          WEBHOOK_SECRET: 'ai-difficulty-webhook-secret',
        },
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          log += String(chunk);
        });
      for (let retry = 0; ; retry++) {
        if (
          await fetch(base)
            .then((response) => response.ok)
            .catch(() => false)
        )
          break;
        assert.ok(retry < 100 && child.exitCode === null, `server did not start: ${log}`);
        await sleep(100);
      }
      const request = async (path, body) => {
        const response = await fetch(`${base}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { cookie: `auth_token=${tokens.host}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const connect = async (token, observing = false) => {
        const socket = io(base, {
          auth: { token },
          autoConnect: false,
          reconnection: false,
          transports: ['websocket'],
        });
        sockets.push(socket);
        const roomUpdate = packet(socket, 'room_update');
        const init = observing && packet(socket, 'init_map');
        socket.on('connect', () => socket.emit('join_game_room', { room }));
        socket.connect();
        return { socket, roomUpdate: await roomUpdate, init: init && (await init) };
      };

      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'auth_token', value: tokens.host, url: base }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(`${base}/games/${room}`);
      await page.waitForFunction(() => document.querySelector('#host-true').style.display === '');
      const assertTab = (label) =>
        page.waitForFunction(
          ([selector, expected]) => document.querySelector(selector)?.textContent === expected,
          [activeTab, label],
        );
      const tryChange = (difficulty) =>
        page.evaluate((value) => socket.emit('change_game_conf', { ai_difficulty: value }), difficulty);
      assert.equal(await page.locator(difficultyTabs).isVisible(), false);
      const { socket: thirdParty, roomUpdate } = await connect('third-party-token');
      assert.equal(roomUpdate.players.find((player) => player.uid === 'third_party').bot, true);
      const rejected = packet(thirdParty, 'room_update');
      await tryChange('simple');
      assert.equal((await rejected).ai_difficulty, 'normal');
      assert.equal(await page.locator(difficultyTabs).isVisible(), false);
      thirdParty.disconnect();

      const { items } = await request('/api/admin/bot-templates');
      assert.deepEqual(
        items.map((item) => item.id),
        ['anti-human-bot', 'apex-bot', 'relay-bot', 'simple-strategy-bot'],
      );
      for (const [index, template] of items.entries()) {
        const { bot } = await request('/api/admin/bots/start', {
          username: 'hosted_bot',
          room,
          template: template.id,
          allowTeam: false,
          allowFog: false,
          allowMultiLine: false,
        });
        await page.locator(difficultyTabs).waitFor({ state: 'visible' });
        await assertTab('正常');
        const watcher = index === 0 ? await connect(tokens.watcher) : null;
        if (watcher) {
          const denied = packet(watcher.socket, 'room_update');
          watcher.socket.emit('change_game_conf', { ai_difficulty: 'simple' });
          assert.equal((await denied).ai_difficulty, 'normal');
        }
        const changed =
          watcher && packet(watcher.socket, 'room_update', (data) => data.ai_difficulty === 'simple');
        await page.locator(difficultyTabs).getByText('简单', { exact: true }).click();
        if (changed) {
          assert.equal(
            (await changed).players.find((player) => player.uid === 'hosted_bot').server_bot,
            true,
          );
          await page.reload();
          await page.locator(difficultyTabs).waitFor({ state: 'visible' });
          await assertTab('简单');
          await page.waitForFunction(() => document.querySelector('#host-true').style.display === '');
          const normalAgain = packet(
            watcher.socket,
            'room_update',
            (data) => data.ai_difficulty === 'normal',
          );
          await page.locator(difficultyTabs).getByText('正常', { exact: true }).click();
          await normalAgain;
          const simpleAgain = packet(
            watcher.socket,
            'room_update',
            (data) => data.ai_difficulty === 'simple',
          );
          await page.locator(difficultyTabs).getByText('简单', { exact: true }).click();
          await simpleAgain;
          watcher.socket.disconnect();
        }
        await assertTab('简单');
        const speed = page.waitForFunction(() => getTabVal('game-speed') === '4x');
        await page.evaluate(() => socket.emit('change_game_conf', { speed: 4 }));
        await speed;
        await page.evaluate(() => {
          window.difficultyFrames = new Map();
          socket.on('init_map', (data) => {
            window.difficultyInit = data;
          });
          socket.on('update', (data) => {
            window.difficultyFrames.set(data.turn, data);
          });
        });
        await page.evaluate(() => socket.emit('change_ready', { ready: true }));
        await page.waitForFunction(() => window.difficultyFrames.has(1));
        const { init, frameZero, frameOne } = await page.evaluate(() => ({
          init: window.difficultyInit,
          frameZero: window.difficultyFrames.get(0),
          frameOne: window.difficultyFrames.get(1),
        }));
        assert.deepEqual(metadata(init), ['simple', [2]], template.id);
        const hostCrown = init.general[0] * init.m + init.general[1];
        assert.equal(frameZero.grid_type[hostCrown], 101);
        const botCrown = frameZero.grid_type.indexOf(102);
        assert.ok(botCrown >= 0);
        const armies = [...frameZero.army_cnt];
        if (frameOne.is_diff) {
          for (let offset = 0; offset < frameOne.army_cnt.length; offset += 2) {
            armies[frameOne.army_cnt[offset]] = frameOne.army_cnt[offset + 1];
          }
        } else armies.splice(0, armies.length, ...frameOne.army_cnt);
        assert.equal(armies[hostCrown], 2, template.id);
        assert.equal(armies[botCrown], 1, template.id);

        if (index === 0) {
          const spectator = await connect('same-name-token', true);
          assert.deepEqual(metadata(spectator.init), ['simple', [2]]);
          assert.deepEqual(
            spectator.init.general,
            [-1, -1],
            'third-party token must not take over the hosted seat',
          );
          spectator.socket.disconnect();
          const hostSid = await page.evaluate(() => socket.id);
          await page.evaluate(() => socket.disconnect().connect());
          await page.waitForFunction(
            (oldSid) =>
              socket.connected && socket.id !== oldSid && window.difficultyInit.player_ids[0] === client_id,
            hostSid,
          );
          assert.deepEqual(metadata(await page.evaluate(() => window.difficultyInit)), ['simple', [2]]);
        }
        await page.waitForFunction(() => [...window.difficultyFrames.keys()].some((turn) => turn > 20));
        await page.evaluate(() => socket.emit('surrender'));
        await page.waitForFunction(() =>
          [...window.difficultyFrames.values()].some((frame) => frame.game_end),
        );
        await page.locator('#status-alert').getByRole('button', { name: '返回房间', exact: true }).click();
        if (index === items.length - 1) {
          const { socket: observer } = await connect('third-party-token');
          const reset = packet(
            observer,
            'room_update',
            (data) => !data.in_game && data.players.every((player) => player.bot === true),
          );
          await page.evaluate(() => socket.disconnect());
          assert.equal((await reset).ai_difficulty, 'normal');
          observer.disconnect();
        }
        await request('/api/admin/bots/stop', { id: bot.id });
        if (index < items.length - 1) await page.locator(difficultyTabs).waitFor({ state: 'hidden' });
      }
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(log);
      throw error;
    } finally {
      for (const socket of sockets) socket.disconnect();
      await browser?.close();
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
