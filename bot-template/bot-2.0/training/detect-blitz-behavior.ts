import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { decodeBinary } from '../../../src/binary-store';
import { GameEngine } from '../../../src/game-engine';
import { buildScheduledReplayActions } from '../../../src/game-engine/replay-scheduling';
import type { ReplayActionData, ReplayData } from '../../../src/types';

const BURST_END = 50;
const REVERSE_WINDOW = 10;
const THREAT_RADIUS = 2;
const THREAT_ARMY = 20;

type Frame = { grid: number[]; army: number[]; isolated: number[]; turn: number };
type Move = [number, number, number, number, number];
type Build = { kind: 'b' | 'c'; x: number; y: number };

const ownerOf = (v: number): number => (v > 0 && v < 200 && v % 50 ? v % 50 : 0);
const kindOf = (v: number): string => {
  const o = ownerOf(v);
  if (!o) return 'neutral';
  const d = v - o;
  return d === 100 ? 'crown' : d === 50 ? 'city' : 'plain';
};
const passable = (v: number): boolean => v !== 201 && v !== 202 && v !== 203;

function applyDiff(arr: number[], diff: number[]): void {
  for (let i = 0; i < diff.length; i += 2) arr[diff[i]] = diff[i + 1];
}

function applyFrame(prev: Frame, patch: ReplayData['patches'][number]): Frame {
  const grid = prev.grid.slice();
  const army = prev.army.slice();
  const isolated = prev.isolated.slice();
  applyDiff(grid, patch.forward.grid_type);
  applyDiff(army, patch.forward.army_cnt);
  applyDiff(isolated, patch.forward.isolated);
  return { grid, army, isolated, turn: patch.forward.turn };
}

function neighbors(at: number, n: number, m: number): number[] {
  const out: number[] = [];
  if (at >= m) out.push(at - m);
  if (at % m) out.push(at - 1);
  if (at % m + 1 < m) out.push(at + 1);
  if (at + m < n * m) out.push(at + m);
  return out;
}

function threatAround(frame: Frame, from: number, n: number, m: number, enemy: number): number {
  const size = n * m;
  const seen = new Set<number>([from]);
  let layer = [from];
  let threat = 0;
  for (let depth = 0; depth < THREAT_RADIUS; depth += 1) {
    const next: number[] = [];
    for (const cur of layer) {
      for (const at of neighbors(cur, n, m)) {
        if (at < 0 || at >= size || seen.has(at) || !passable(frame.grid[at])) continue;
        seen.add(at);
        next.push(at);
        if (ownerOf(frame.grid[at]) === enemy && !frame.isolated[at]) {
          threat += frame.army[at] || 0;
        }
      }
    }
    layer = next;
  }
  return threat;
}

function dispatchAnomalies(
  frame: Frame, move: Move, turn: number, n: number, m: number, pid: number, enemy: number,
): string[] {
  const [fx, fy, tx, ty, mode] = move;
  const from = fx * m + fy;
  const to = tx * m + ty;
  if (ownerOf(frame.grid[from]) !== pid || ownerOf(frame.grid[to]) === pid) return [];
  const degree = neighbors(from, n, m).filter((at) => passable(frame.grid[at])).length;
  const junction = degree >= 3;
  if (!junction) {
    return mode === 0 ? [`t${turn} SMART-SPLIT away from junction (${fx},${fy})->(${tx},${ty})`] : [];
  }
  const threat = threatAround(frame, from, n, m, enemy);
  const threatened = threat >= THREAT_ARMY;
  if (mode === 0) return [`t${turn} SMART-SPLIT at junction (${fx},${fy})->(${tx},${ty}) threat=${Math.round(threat)}`];
  if (threatened && mode === 2) {
    return [`t${turn} FULL-PUSH at threatened junction (${fx},${fy})->(${tx},${ty}) threat=${Math.round(threat)}`];
  }
  if (!threatened && mode === 1) {
    return [`t${turn} half-push at unthreatened junction (${fx},${fy})->(${tx},${ty}) threat=${Math.round(threat)}`];
  }
  return [];
}

function compress(turns: number[]): string {
  if (!turns.length) return '';
  const ranges: string[] = [];
  let start = turns[0], prev = start;
  for (const t of turns.slice(1)) {
    if (t !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = t;
    }
    prev = t;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(', ');
}

async function inspect(dir: string): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.rpl')).sort();
  for (const file of files) {
    const id = file.replace(/\.rpl$/, '');
    let replay: ReplayActionData;
    try {
      replay = await decodeBinary<ReplayActionData>(readFileSync(path.join(dir, file)));
    } catch { continue; }
    if (replay.meta?.map_mode !== 'maze') continue;
    const seat = (replay.meta.player_names || []).findIndex((n) => /Bot 2\.0/i.test(n));
    if (seat < 0) continue;
    const pid = seat + 1;
    const enemy = pid === 1 ? 2 : 1;
    let data: ReplayData;
    try {
      data = await GameEngine.buildReplayFromActions(replay);
    } catch (error) {
      console.log(`${id}: rebuild failed ${(error as Error).message}`);
      continue;
    }
    const scheduled = buildScheduledReplayActions(replay);
    const moves: Map<number, Move> = scheduled.scheduledMoves[seat];
    const builds: Map<number, Build> = scheduled.scheduledBuilds[seat];
    const total = Math.min(replay.total_turns, data.patches.length);
    let frame: Frame = {
      grid: data.initial.grid_type.slice(), army: data.initial.army_cnt.slice(),
      isolated: data.initial.isolated.slice(), turn: 0,
    };
    const anomalies: string[] = [];
    const idleTurns: number[] = [];
    const neutralTurns: number[] = [];
    let gatherBuilds = 0;
    let crownMoves = 0;
    let firstEnemyAttack = -1;
    let launchCrowns: number[] = [];
    const recentEdges = new Map<string, number>();
    const crownUsed = new Set<number>();

    for (let turn = 1; turn <= total; turn += 1) {
      const before = frame;
      const move = moves.get(turn);
      const build = builds.get(turn);
      if (move) {
        const [fx, fy, tx, ty, mode] = move;
        const from = fx * data.m + fy;
        const to = tx * data.m + ty;
        if (ownerOf(before.grid[to]) === enemy && firstEnemyAttack < 0) {
          firstEnemyAttack = turn;
          launchCrowns = [];
          for (let at = 0; at < before.grid.length; at += 1) {
            if (ownerOf(before.grid[at]) === pid && kindOf(before.grid[at]) === 'crown') {
              launchCrowns.push(before.army[at] || 0);
            }
          }
        }
        if (turn > BURST_END && firstEnemyAttack < 0) {
          const edge = `${from}>${to}`;
          const rev = recentEdges.get(`${to}>${from}`);
          if (rev && turn - rev <= REVERSE_WINDOW) {
            anomalies.push(`t${turn} backtrack (${fx},${fy})->(${tx},${ty}) reverse of t${rev}`);
          }
          recentEdges.set(edge, turn);
          if (ownerOf(before.grid[to]) === 0) neutralTurns.push(turn);
          if (kindOf(before.grid[from]) === 'crown' && ownerOf(before.grid[from]) === pid) {
            crownUsed.add(from);
            if (ownerOf(before.grid[to]) !== enemy) {
              crownMoves += 1;
              anomalies.push(`t${turn} crown-origin move (${fx},${fy})->(${tx},${ty}) mode=${mode} during gather`);
            }
          }
        }
        anomalies.push(...dispatchAnomalies(before, move, turn, data.n, data.m, pid, enemy));
      } else if (turn > BURST_END && firstEnemyAttack < 0) {
        idleTurns.push(turn);
      }
      if (build && turn > BURST_END && firstEnemyAttack < 0) {
        gatherBuilds += 1;
        anomalies.push(`t${turn} build ${build.kind} at (${build.x},${build.y}) during gather`);
      }
      if (turn <= data.patches.length) frame = applyFrame(before, data.patches[turn - 1]);
    }
    for (const army of launchCrowns) {
      if (army >= 20) anomalies.push(`t${firstEnemyAttack} crown garrison ${army} still held at launch; not fully gathered`);
    }
    if (idleTurns.length) anomalies.push(`idle gather ticks: ${compress(idleTurns)}`);
    if (neutralTurns.length) anomalies.push(`neutral expansion moves during gather at t${compress(neutralTurns)}`);
    const launch = firstEnemyAttack < 0 ? 'none' : `t${firstEnemyAttack}`;
    console.log(`\n${id} seat=${seat} turns=${total} launch=${launch} launchCrowns=[${launchCrowns.join(',')}] gatherIdle=${idleTurns.length} gatherBuilds=${gatherBuilds} crownMoves=${crownMoves} neutralMoves=${neutralTurns.length} anomalies=${anomalies.length}`);
    for (const line of anomalies.slice(0, 80)) console.log('  ' + line);
    if (anomalies.length > 80) console.log(`  ... +${anomalies.length - 80} more`);
  }
}

const dir = process.argv[2] || path.join(process.cwd(), 'data', 'replays');
void inspect(dir).catch((error) => { console.error(error); process.exit(1); });
