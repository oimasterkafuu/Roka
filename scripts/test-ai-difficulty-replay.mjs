import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { decodeBinary } from '../dist/binary-store.js';
import { UserStore } from '../dist/auth-store.js';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const { chromium } = require(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const { io } = require('socket.io-client');

const SECRET = 'ai-difficulty-replay-test-secret';
const ADMIN = 'replay_admin';
const BOT = 'replay_bot';
const MAP_TOKEN = 'ai-replay-fixed-seed';
const TARGET_TURN = 50;

function waitFor(predicate, label, timeoutMs = 30_000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(50);
    }
    throw new Error(`等待${label}超时`);
  })();
}

function waitEvent(socket, event, predicate = () => true, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`等待 ${event} 超时`));
    }, timeoutMs);
    function listener(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(data);
    }
    socket.on(event, listener);
  });
}

function applyDiff(target, diff) {
  for (let index = 0; index < diff.length; index += 2) target[diff[index]] = diff[index + 1];
}

function snapshotLiveFrame(state, payload) {
  if (!payload.is_diff) {
    state.grid = [...payload.grid_type];
    state.army = [...payload.army_cnt];
    state.isolated = [...payload.isolated];
  } else {
    assert.ok(state.grid, '差分帧前必须先收到全量帧');
    applyDiff(state.grid, payload.grid_type);
    applyDiff(state.army, payload.army_cnt);
    applyDiff(state.isolated, payload.isolated || []);
  }
  return {
    turn: payload.turn,
    grid: [...state.grid],
    army: [...state.army],
    isolated: [...state.isolated],
  };
}

function replayFrames(decoded) {
  const state = {
    grid: [...decoded.initial.grid_type],
    army: [...decoded.initial.army_cnt],
    isolated: [...decoded.initial.isolated],
  };
  const frames = [
    {
      turn: decoded.initial.turn,
      grid: [...state.grid],
      army: [...state.army],
      isolated: [...state.isolated],
    },
  ];
  for (const patch of decoded.patches) {
    applyDiff(state.grid, patch.forward.grid_type);
    applyDiff(state.army, patch.forward.army_cnt);
    applyDiff(state.isolated, patch.forward.isolated || []);
    frames.push({
      turn: patch.forward.turn,
      grid: [...state.grid],
      army: [...state.army],
      isolated: [...state.isolated],
    });
  }
  return frames;
}

async function decodeRpb5(gzipOrBinary) {
  const content = Buffer.from(gzipOrBinary);
  const binary = content[0] === 0x1f && content[1] === 0x8b ? gunzipSync(content) : content;
  const source = await readFile(new URL('../static/main/replay-binary.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    ArrayBuffer,
    DataView,
    TextDecoder,
    Uint8Array,
    replay_binary_magic: [82, 80, 66, 53],
    replay_class_from_code: ['', 'dead', 'afk'],
    replay_text_decoder: new TextDecoder(),
  });
  vm.runInContext(source, context);
  const buffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  return { binary, decoded: context.decodeReplayBinary(buffer) };
}

async function findPort() {
  const { createServer } = await import('node:net');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test(
  'real hosted simple bot replays preserve live ticks and normal growth contrast',
  { timeout: 180_000 },
  async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-ai-replay-e2e-'));
    const store = new UserStore(dataDir);
    await store.ensureReady();
    await store.register(ADMIN, 'local-replay-pass');
    await store.register(BOT, 'local-replay-pass');
    const adminSid = await store.rotateSession(ADMIN);
    const adminToken = jwt.sign({ sub: ADMIN, sid: adminSid }, SECRET, { expiresIn: '1h' });
    const port = await findPort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['dist/server.js', '--port', String(port)], {
      env: {
        ...process.env,
        JWT_SECRET: SECRET,
        WEBHOOK_SECRET: SECRET,
        ROKA_DATA_DIR: dataDir,
        ROKA_STATIC_CDN: '0',
        NODE_ENV: 'test',
        ROKA_BOT_TOKENS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (serverLog += String(chunk)));
    const sockets = [];
    const results = [];
    let browser;
    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`server failed to start:\n${serverLog}`);
        try {
          if ((await fetch(`${base}/api/version`)).ok) break;
        } catch {}
        if (attempt === 119) throw new Error(`server startup timeout:\n${serverLog}`);
        await sleep(100);
      }

      const request = async (route, body) => {
        const response = await fetch(`${base}${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { cookie: `auth_token=${adminToken}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        return { response, data, text };
      };

      async function runGame(difficulty, room) {
        const started = await request('/api/admin/bots/start', {
          username: BOT,
          room,
          template: 'simple-strategy-bot',
          allowTeam: false,
          allowFog: false,
          allowMultiLine: false,
        });
        assert.equal(started.response.status, 200, started.text);
        assert.equal(started.data.bot.template, 'simple-strategy-bot');

        const gamePage = await fetch(`${base}/games/${room}`, {
          headers: { cookie: `auth_token=${adminToken}` },
        });
        const html = await gamePage.text();
        const stamp = html.match(/<meta name="roka-session-stamp" content="([^"]*)" \/>/)?.[1];
        assert.ok(stamp, 'authenticated game page must provide the client verification stamp');

        const socket = io(base, {
          auth: { token: adminToken },
          autoConnect: false,
          reconnection: false,
          transports: ['websocket'],
        });
        sockets.push(socket);
        const state = { grid: null, army: null, isolated: null };
        const liveByTurn = new Map();
        let lastRoom = null;
        let replayId = null;
        socket.on('room_update', (data) => {
          lastRoom = data;
        });
        socket.on('update', (payload) => {
          liveByTurn.set(payload.turn, snapshotLiveFrame(state, payload));
          if (payload.replay) replayId = payload.replay;
        });
        const setId = waitEvent(socket, 'set_id');
        socket.connect();
        const clientId = await setId;
        const signature = createHash('sha256').update(`${stamp}:${clientId}`).digest('hex');
        socket.emit('client_verify', { sig: signature });
        socket.emit('join_game_room', { room });
        await waitFor(
          () =>
            lastRoom?.players?.some((player) => player.uid === BOT && player.server_bot === true) &&
            lastRoom.players.some((player) => player.uid === ADMIN),
          '房间与官方 Bot',
        );
        socket.emit('change_game_conf', {
          speed: 4,
          map_size: 'large',
          map_token: MAP_TOKEN,
          map_mode: 'random',
          fog_mode: 'visible',
          ai_difficulty: difficulty,
        });
        await waitFor(
          () =>
            lastRoom?.speed === 4 &&
            lastRoom.map_size === 'large' &&
            lastRoom.map_token === MAP_TOKEN &&
            lastRoom.ai_difficulty === difficulty &&
            lastRoom.fog_mode === 'visible',
          '房间设置同步',
        );
        socket.emit('change_ready', { ready: true });
        await waitFor(() => liveByTurn.has(0), '实时初始帧');
        await waitFor(() => liveByTurn.has(TARGET_TURN), `实时 Tick ${TARGET_TURN}`, 40_000);
        socket.emit('surrender');
        await waitFor(() => replayId !== null, '终局回放 ID', 20_000);
        const ended = await request(`/api/replays?username=${encodeURIComponent(ADMIN)}`);
        assert.equal(ended.response.status, 200, ended.text);
        assert.ok(ended.data.items.some((item) => item.id === replayId), '回放已写入索引');

        const rawResponse = await fetch(`${base}/api/downloadreplay/${encodeURIComponent(replayId)}`);
        assert.equal(rawResponse.status, 200);
        const raw = Buffer.from(await rawResponse.arrayBuffer());
        const actions = await decodeBinary(raw);
        assert.equal(actions.version, 'ops-v3');
        assert.equal(actions.meta.ai_difficulty, difficulty);
        assert.deepEqual(actions.meta.server_bot_seats, [2]);
        assert.equal(actions.meta.map_token, MAP_TOKEN);

        const viewResponse = await fetch(`${base}/api/getreplay/${encodeURIComponent(replayId)}`);
        assert.equal(viewResponse.status, 200);
        const view = await decodeRpb5(Buffer.from(await viewResponse.arrayBuffer()));
        assert.equal(view.binary.subarray(0, 4).toString('latin1'), 'RPB5');
        assert.equal(view.decoded.meta.ai_difficulty, difficulty);
        assert.deepEqual(Array.from(view.decoded.meta.server_bot_seats), [2]);

        const decodedFrames = replayFrames(view.decoded);
        const liveFrames = [...liveByTurn.values()];
        const replayByTurn = new Map(decodedFrames.map((frame) => [frame.turn, frame]));
        for (const live of liveFrames) {
          const replay = replayByTurn.get(live.turn);
          assert.ok(replay, `${difficulty} replay contains live Tick ${live.turn}`);
          assert.deepEqual(replay.grid, live.grid, `${difficulty} map state at Tick ${live.turn}`);
          assert.deepEqual(replay.army, live.army, `${difficulty} army state at Tick ${live.turn}`);
          assert.deepEqual(replay.isolated, live.isolated, `${difficulty} key state at Tick ${live.turn}`);
        }
        await request('/api/admin/bots/stop', { id: started.data.bot.id });
        socket.disconnect();
        return {
          difficulty,
          replayId,
          liveByTurn,
          decodedFrames,
          initialGrid: decodedFrames[0].grid,
          botCrown: decodedFrames[0].grid.indexOf(102),
        };
      }

      results.push(await runGame('normal', 'rpl-normal'));
      results.push(await runGame('simple', 'rpl-simple'));
      assert.notEqual(results[0].botCrown, -1);
      assert.equal(results[0].botCrown, results[1].botCrown, 'normal/simple use the same fixed map');
      assert.deepEqual(results[0].initialGrid, results[1].initialGrid, 'normal/simple map bytes match');
      for (const turn of [1, 26, TARGET_TURN]) {
        const normal = results[0].liveByTurn.get(turn);
        const simple = results[1].liveByTurn.get(turn);
        assert.ok(normal && simple, `normal/simple both reach Tick ${turn}`);
        assert.ok(
          normal.army[results[0].botCrown] > simple.army[results[1].botCrown],
          `normal crown growth exceeds simple at Tick ${turn}`,
        );
      }

      browser = await chromium.launch({
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
        headless: true,
        args: ['--no-sandbox'],
      });
      for (const result of results) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(`${base}/replays/${encodeURIComponent(result.replayId)}`, {
          waitUntil: 'domcontentloaded',
        });
        try {
          await page.waitForFunction(
            (minimumFrames) =>
              window.replay_data && replay_data.patches && replay_data.patches.length >= minimumFrames,
            TARGET_TURN + 1,
          );
        } catch (error) {
          const state = await page.evaluate(() => ({
            replayDataType: typeof replay_data,
            replayDataKeys: replay_data && Object.keys(replay_data),
            replayErrorVisible: document.querySelector('#replay-error-alert')?.style.display,
          }));
          throw new Error(`${error.message}; state=${JSON.stringify(state)}; pageErrors=${errors.join(' | ')}`);
        }
        const lastFrame = await page.evaluate(() => replay_data.patches.length);
        for (const frame of [0, 1, 25, 26, TARGET_TURN, lastFrame]) {
          const state = await page.evaluate((target) => {
            jumpToFrame(target);
            return {
              turn: cur_turn,
              grid: grid_type.flat(),
              army: army_cnt.flat(),
              isolated: isolated.flat(),
            };
          }, frame);
          const expected = result.decodedFrames[frame];
          assert.equal(state.turn, frame, `${result.difficulty} browser frame ${frame}`);
          assert.deepEqual(state.grid, expected.grid, `${result.difficulty} browser map frame ${frame}`);
          assert.deepEqual(state.army, expected.army, `${result.difficulty} browser army frame ${frame}`);
          assert.deepEqual(state.isolated, expected.isolated, `${result.difficulty} browser key frame ${frame}`);
        }
        await page.evaluate(() => jumpToFrame(50));
        await page.click('#replay-autoplay-btn');
        await page.waitForFunction((target) => cur_turn >= target, lastFrame);
        await page.evaluate(() => {
          if (is_autoplaying) switchAutoplay();
        });
        assert.deepEqual(errors, [], `${result.difficulty} Chromium replay has no JS errors`);
        await page.close();
      }
      console.log('PASS real official simple/normal bot replay, RPB5 playback, Chromium seek/autoplay, and growth contrast');
    } catch (error) {
      console.error(serverLog);
      throw error;
    } finally {
      for (const socket of sockets) socket.disconnect();
      await browser?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit').catch(() => undefined);
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
