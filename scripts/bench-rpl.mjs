import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cases = [
  ['human', 'visible', 0.5, 600, 73, 1],
  ['ai', 'normal', 1, 420, 3, 1],
  ['fragment', 'visible', 1, 520, 1, 6],
  ['multiline', 'explored', 1, 460, 2, 4],
  ['large', 'normal', 1.85, 220, 4, 3],
  ['long', 'normal', 0.6, 2400, 17, 1],
];
const [root, index] = process.argv.slice(2);
if (!root) throw Error('usage: node scripts/bench-rpl.mjs <built checkout> [case index]');
if (index === undefined) {
  console.log(
    JSON.stringify(
      cases.map((_, id) =>
        JSON.parse(
          execFileSync(process.execPath, [fileURLToPath(import.meta.url), root, String(id)], {
            encoding: 'utf8',
          }).trim(),
        ),
      ),
      null,
      2,
    ),
  );
} else if (index === 'decode') {
  const [, , , , archivePath, kind] = process.argv;
  const load = createRequire(path.resolve(root, 'package.json'));
  const decode =
    kind === 'baseline' ? load('./dist/binary-store').decodeBinary : load('./dist/rpl').decodeRpl;
  const bytes = await readFile(archivePath);
  const before = process.resourceUsage().maxRSS;
  const start = performance.now();
  for (let repeat = 0; repeat < 20; repeat++) await decode(bytes);
  console.log(
    JSON.stringify({
      decodeMs: (performance.now() - start) / 20,
      beforeKiB: before,
      decodePeakKiB: process.resourceUsage().maxRSS,
    }),
  );
} else {
  const load = createRequire(path.resolve(root, 'package.json'));
  const { GameEngine } = load('./dist/game-engine');
  const { ReplayStore } = load('./dist/replay-store');
  const [name, fog_mode, ratio, ticks, interval, fronts] = cases[index];
  const names = ['Alpha', 'Beta', 'Gamma'];
  const directory = await mkdtemp(path.join(tmpdir(), 'rpl-bench-'));
  try {
    const store = new ReplayStore(directory, { buildReplayFromActions: GameEngine.buildReplayFromActions });
    await writeFile(path.join(directory, 'index.bin'), Buffer.alloc(0));
    await store.ensureReady();
    let archive;
    const engine = await GameEngine.create(
      {
        width_ratio: ratio,
        height_ratio: ratio,
        speed: 1,
        swamp_ratio: 0.1,
        map_mode: 'random',
        map_region: 'china',
        map_token: 'bench-seed',
        map_size: ratio > 1 ? 'large' : 'normal',
        allow_team: false,
        fog_mode,
        multi_line: fronts > 1,
        ai_difficulty: 'normal',
        server_bot_seats: [],
        player_names: names,
        player_teams: [1, 2, 3],
      },
      names,
      names,
      'bench',
      {
        update() {},
        chatMessage() {},
        endGame() {},
        emitInitMap() {},
        md5: String,
        replayStore: {
          saveReplay(raw, summary) {
            archive = raw;
            return store.saveReplay(raw, summary);
          },
        },
      },
    );
    const dirs = [
      [1, 0],
      [0, -1],
      [-1, 0],
      [0, 1],
    ];
    for (let turn = 1; turn <= ticks; turn++) {
      if (turn % interval === 0) {
        const used = names.map(() => 0);
        for (let step = 0; step < engine.n * engine.m; step++) {
          const cell = (step + turn * 97) % (engine.n * engine.m);
          const row = Math.floor(cell / engine.m),
            col = cell % engine.m;
          const player = engine.owner[row][col] - 1;
          if (player < 0 || used[player] >= fronts || engine.armyCnt[row][col] < 2) continue;
          for (let off = 0; off < 4; off++) {
            const [dr, dc] = dirs[(turn + col + off) % 4],
              dest = [row + dr, col + dc];
            if (
              !engine.chkxy(...dest) ||
              (engine.owner[dest[0]][dest[1]] > 0 && engine.owner[dest[0]][dest[1]] !== player + 1) ||
              engine.gridType[dest[0]][dest[1]] === 1
            )
              continue;
            engine.addMove(names[player], row, col, ...dest, turn % 3);
            used[player]++;
            break;
          }
        }
      }
      assert.equal(await engine.gameTick(), false);
    }
    const id = await engine.saveHistory();
    const raw = await store.readRawReplay(id);
    const actions = archive.player_ops.flat().reduce((sum, op) => sum + (op.actions?.length ?? 0), 0);
    const old = typeof store.readReplayViewGzip === 'function';
    const codec = old ? load('./dist/binary-store') : load('./dist/rpl');
    const { decodeMs, beforeKiB, decodePeakKiB } = JSON.parse(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          root,
          'decode',
          path.join(directory, id + '.rpl'),
          old ? 'baseline' : 'current',
        ],
        { encoding: 'utf8' },
      ),
    );
    const viewStart = performance.now();
    const response = old ? (await store.readReplayViewGzip(id)).gzip : await store.readRawReplay(id);
    const requestMs = performance.now() - viewStart;
    const warmStart = performance.now();
    if (old) await store.readReplayViewGzip(id);
    else await store.readRawReplay(id);
    const warmMs = performance.now() - warmStart;
    if (process.env.RPL_SAMPLE_DIR)
      await writeFile(path.join(process.env.RPL_SAMPLE_DIR, name + '.view'), response);
    let fields;
    if (!old) fields = codec.inspectRpl(raw);
    else {
      const prefix = async (keys) =>
        (
          await codec.encodeBinary(
            Object.fromEntries(Object.entries(archive).filter(([key]) => keys.includes(key))),
          )
        ).length;
      const headerBytes = await prefix(['version', 'total_turns']);
      const metaEnd = await prefix(['version', 'meta', 'total_turns']);
      const opEnd = await prefix(['version', 'meta', 'total_turns', 'player_ops']);
      fields = {
        headerBytes,
        metaBytes: metaEnd - headerBytes,
        opBytes: opEnd - metaEnd,
        explorationBytes: raw.length - opEnd,
        checkBytes: 0,
      };
    }
    if (process.env.RPL_SAMPLE_DIR)
      await writeFile(path.join(process.env.RPL_SAMPLE_DIR, name + '.rpl'), raw);
    console.log(
      JSON.stringify({
        name,
        fog_mode,
        area: engine.n * engine.m,
        ticks,
        actions,
        density: actions / ticks,
        rawBytes: raw.length,
        wireBytes: response.length,
        fields,
        fieldPct: Object.fromEntries(
          ['headerBytes', 'metaBytes', 'opBytes', 'explorationBytes', 'checkBytes'].map((key) => [
            key,
            (fields[key] * 100) / raw.length,
          ]),
        ),
        beforeKiB,
        decodePeakKiB,
        discoveryArrayBytes: archive.exploration?.reduce((sum, [, v]) => sum + v.byteLength, 0) ?? 0,
        decodeMs,
        decodeMiBps: ((raw.length / decodeMs) * 1000) / 1048576,
        requestMs,
        warmMs,
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
