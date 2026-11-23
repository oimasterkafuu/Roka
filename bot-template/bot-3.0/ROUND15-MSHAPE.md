# Round 15 — expansion shape in multi-line rooms (`BOT3_MSHAPE`)

`mshape.js` prices the land race of a multi-line room. It is **off by default**
(`BOT3_MSHAPE=1` enables it). With the variable unset `planner.js` is
byte-identical to the round-13 baseline; `bot3.test.cjs` asserts the untouched
path (the sixteen-order clamp, the serial one-order rule and every score).

Measured result, honest summary:

- The eight relay multi cells move from 123/256 (48.0 %) to **129/256 (50.4 %)**
  on the round-15 screen seeds (1–16), and 121 → **125** on a second, independent
  256-game half (seeds 17–32): **+10 wins in 512 games (+2.0 pp)**.
- The full 2048-game matrix is **1694/297/57 (82.7 %)** against the recorded
  **1688/299/61 (82.4 %)**, `+6` wins, **zero cells below the paired baseline**
  (the only eight failing cells are the eight relay multi cells themselves,
  which stay below the 65 % target).
- The 65 % bar is **not** met: no cell reaches it (best is 56.3 %). The switch
  therefore ships **off**, like the round-8/11 combinations.

## Why land, and why shape

In a multi-line room (`multi_line`) there is no burst. Growth is
`src/game-engine/tick-growth.ts`: a plain pays `+1` on `t % 50 === 0`, a city pays
`+1` on the same marks, a crown pays `+1` every tick, swamp/neutral pay nothing.
So between pulses the whole empire's income is its crowns (one, at the start),
and at each pulse every plain the empire holds pays one army at once.

A capture costs no army beyond the defender's garrison: the push moves `A - 1`
onto the target and leaves one behind (`attack()` in `src/game-engine.ts`). One
army therefore buys exactly one land cell while the map still has neutral
ground, and land is what the next pulse pays for. Two consequences:

1. **Before a pulse the land race is income-bound.** One army per tick from the
   single crown is one land cell per tick, and no policy can beat that — measured
   land at `t49` is 39–43 on every map and both seats.
2. **After a pulse the land race is frontier-bound.** The pulse hands the empire
   `land` army at once (38–70 units), and the rules allow one order per non-empty
   front per tick (`views/tutorial-text.pug` "多线争锋"; the engine caps nothing
   and the server caps nothing). The number of simultaneous captures is the
   number of owned cells that hold two army *and* touch a neutral cell.

Point 2 is where the inherited policy loses value. Traced with
`data/scratch/mshape-probe.cjs` (random, `probe-1`, multi):

```
tick 49  land 40  army 49  act  5  frontier 7   orders  5   (0 captures, 5 merges)
tick 50  land 40  army 50  act  5  frontier 7   orders 16   (7 captures, 9 merges)
tick 51  land 47  army 88  act 23  frontier 9   orders 14   (0 captures, 12 merges)
tick 52  land 47  army 89  act 17  frontier 7   orders 13   (1 capture, 9 merges)
tick 53  land 48  army 90  act 16  frontier 7   orders 12   (3 captures, 7 merges)
```

The pulse army appears at `t51` (`army` 50 → 88) and the following ticks spend
their orders on **rear merges**: the frontier ring is spent (every frontier cell
holds exactly one army after it captured), so the new army needs three hops to
become land. The distance histogram of the empire at `turn 50` makes the shape
explicit — `frontDist` (hops to the frontier through our own cells) and the army
parked at each distance:

| frontDist | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cells | 9 | 9 | 7 | 7 | 6 | 5 | 5 | 3 | 1 | 1 |
| army | 12 | 9 | 17 | 14 | 9 | 12 | 8 | 7 | 1 | 2 |

The pulse army sits at distance 2–6 while the frontier (distance 0) averages
1.3 army per cell, i.e. only two of nine frontier cells can capture. Land goes
40 → 69 between `t50` and `t100` (29 captures in 50 ticks) while income alone
paid 50 army: the wave is worth about one land cell per tick, not nine.

Two engine facts decide how the wave can be spent:

- **A merge steals a capture.** The engine only runs a queued move whose source
  is not the target of another queued move, and `strategy.js` skips planning
  entirely while `pending` is non-empty. An order that merges *into* a cell
  which is also capturing therefore delays that capture by a tick, and a merge
  *from* a cell which could capture spends the tick on one army instead of one
  cell. `applyMshape` refuses to let a plain merge outrank the capture it would
  invalidate (`steal`); defence, rescue and siege scores (>= 300) are exempt.
- **The sixteen-order clamp only binds on the pulse tick.** Off the pulse a
  measured multi tick has 5–25 candidates (`act` = cells holding two army), on
  the pulse tick 40+. `SLOTS=64` is therefore identical to "unlimited"
  (`SLOTS=4096` produced the same 256-game result) and `SLOTS=24` is not enough.

## Mechanism

`planner.js` gains one hook pair, both inert unless `BOT3_MSHAPE=1` and the room
is `multi`:

- `mshapeUpdate(b, {turn, multi, size, me, corridor, land, enemyLand, ...})`
  returns `null` (baseline path) or a plan carrying the order cap and the gates.
- `applyMshape(plan, ctx, candidates)` moves candidate scores only: it never
  creates or removes a candidate (the planner already proposes every edge of
  every cell holding two army, so the supply is army-bound and cannot be
  widened).
- `applyFan(plan, ctx, orders)` (off by default) adds the "unlimited fronts"
  orders described below.

| knob | env | default | meaning |
| --- | --- | --- | --- |
| slots | `BOT3_MSHAPE_SLOTS` | 16 | multi-line order cap (`64` ≡ unlimited) |
| capture | `BOT3_MSHAPE_CAPTURE` | 0 | flat bonus on a neutral capture |
| ring | `BOT3_MSHAPE_RING` | 0 | bonus per plain (non-swamp) neutral neighbour of the target |
| ringCap | `BOT3_MSHAPE_RING_CAP` | 6 | cap on the counted neighbours |
| hole | `BOT3_MSHAPE_HOLE` | 0 | charge for a capture that leaves no neutral neighbour |
| feed | `BOT3_MSHAPE_FEED` | 0 | bonus for a merge into a frontier cell that cannot capture |
| steal | `BOT3_MSHAPE_STEAL` | 100 | demote a plain merge that would invalidate a capture |
| stealCap | `BOT3_MSHAPE_STEAL_CAP` | 300 | merges at or above this score are defence and are exempt |
| merge | `BOT3_MSHAPE_MERGE` | 0 | charge for a merge whose target is not a frontier cell |
| raid | `BOT3_MSHAPE_RAID` | 0 | bonus on a rival cell (a two-cell land swing) |
| water | `BOT3_MSHAPE_WATER` | 0 | charge for a swamp capture (swamp pays no pulse) |
| fan | `BOT3_MSHAPE_FAN` | 0 | extra neutral fronts per stack (0–3) |
| fanArmy | `BOT3_MSHAPE_FAN_ARMY` | 5 | minimum army before a stack is split |
| leadCap | `BOT3_MSHAPE_LEAD` | 0 | stand down above this land ratio (percent of the rival) |
| frontier | `BOT3_MSHAPE_FRONTIER` | 0 | stand down when no neutral cell touches us |
| corridor | `BOT3_MSHAPE_CORRIDOR` | 0 | allow the layer on a corridor (`isMazeBoard`) board |
| start/end | `BOT3_MSHAPE_START` / `_END` | 0 / 0 | tick window |
| board | `BOT3_MSHAPE_BOARD` | 800 | largest board the layer enters |

Recommended configuration (the one measured below):

```sh
BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110
```

## Measured cells

Relay multi-line cells, 16 seeds × both seats = 32 games per cell. `L` and `A`
are the mean land / army difference against the rival at the recorded
checkpoint, and `orders` the executed orders of *both* seats over the whole game.

Screen half 1 (seeds 1–16), recommended configuration:

| map | fog | W/L/T | win | baseline | Δ | L50 | L100 | L250 | A250 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| random | off | 17/15/0 | 53.1 % | 16/16/0 | +3.1 | +0.4 | +1.0 | +2.6 | +3.5 |
| random | on | 18/14/0 | 56.3 % | 16/16/0 | +6.3 | — | — | — | — |
| maze | off | 16/16/0 | 50.0 % | 16/16/0 | 0.0 | +2.4 | +4.2 | +21.9 | +43.2 |
| maze | on | 16/16/0 | 50.0 % | 16/16/0 | 0.0 | — | — | — | — |
| archipelago | off | 15/14/3 | 46.9 % | 15/15/2 | 0.0 | -0.3 | +0.6 | +7.1 | +10.6 |
| archipelago | on | 15/14/3 | 46.9 % | 15/15/2 | 0.0 | — | — | — | — |
| mediterranean | off | 16/16/0 | 50.0 % | 14/14/4 | +6.3 | 0.0 | +0.8 | +2.4 | +2.7 |
| mediterranean | on | 16/15/1 | 50.0 % | 15/15/2 | +3.1 | — | — | — | — |
| **total** | | **129/120/7** | **50.4 %** | **123/123/10** | **+6** | | | | |

Screen half 2 (seeds 17–32, paired against a locally recorded baseline for the
same seeds, 121/121/14 = 47.3 %): **125/115/16 (48.8 %)**, `+4` wins. Worst cell
`random/fog` 15 vs 16, best `random/off` 18 vs 16.

Full 2048-game matrix (recommended configuration):

| opponent / map / fog / multi | candidate | baseline | Δ |
| --- | --- | --- | ---: |
| relay / random / clear / multi | 17/15/0 | 16/16/0 | +3.1 |
| relay / random / fog / multi | 18/14/0 | 16/16/0 | +6.3 |
| relay / maze / clear / multi | 16/16/0 | 16/16/0 | 0.0 |
| relay / maze / fog / multi | 16/16/0 | 16/16/0 | 0.0 |
| relay / archipelago / clear / multi | 15/14/3 | 15/15/2 | 0.0 |
| relay / archipelago / fog / multi | 15/14/3 | 15/15/2 | 0.0 |
| relay / mediterranean / clear / multi | 16/16/0 | 14/14/4 | +6.3 |
| relay / mediterranean / fog / multi | 16/15/1 | 15/15/2 | +3.1 |
| **total** | **1694/297/57 (82.7 %)** | **1688/299/61 (82.4 %)** | **+6** |

`NO_GATE=1 node scripts/compare-bot3-baseline.cjs data/scratch/full-final.jsonl`
reports `gate: FAIL (8/64 cells)`, and those eight are exactly the eight relay
multi cells above: every other one of the 56 cells is at or above the paired
baseline and above 50 %. No cell is below the baseline (the grep for a negative
`Δwin` returns nothing).

### Gate that had to be added

Two gates were needed before the matrix was clean:

- `leadCap` (used: **110**). The ungated layer regressed
  `v2 / archipelago / clear / multi` from 31/1/0 to 29/3/0 (−2 games): a room we
  already dominate has nothing to win from aggressive expansion. Standing the
  layer down when our leaderboard land exceeds 110 % of the rival's restores
  31/1/0 exactly, and costs 2 relay wins (`110` → 254/512, `130` → 254/512, no
  gate → 257/512 with the v2 regression).
- `corridor` (used: **0**, i.e. a corridor room stands the layer down). On
  `isMazeBoard` boards the layer is a wash at best: `maze/clear` 14 (−2) and
  `maze/fog` 18 (+2) on half 1, `maze/clear` 15 (0) and `maze/fog` 16 (0) on
  half 2 — the corridor is a single lane, so widening the order list adds
  nothing and the steal rule fights the corridor's forced merges. Disabling it
  gives the identical 512-game total (254) with `maze` back at its baseline, so
  a corridor keeps the inherited shape until a corridor-specific plan is
  measured.

## Rejected variants (all 256 relay multi games, seeds 1–16 unless noted)

| configuration | W/L/T | win | Δ vs `SLOTS=64+STEAL` | why |
| --- | --- | --- | ---: | --- |
| `BOT3_MSHAPE=0` (baseline) | 123/123/10 | 48.0 % | −9 | the inherited policy |
| flag on, every knob at its default | 123/123/10 | 48.0 % | −9 | measured: 0 flips against the baseline, so the layer is inert until a knob is turned |
| `SLOTS=24` | 128/120/8 | 50.0 % | −4 | the pulse tick needs all 40 |
| `SLOTS=32` | 124/125/7 | 48.4 % | −8 | — |
| `SLOTS=64` | 130/117/9 | 50.8 % | −2 | cap alone, worth +7 |
| `SLOTS=4096` (seeds 17–32) | 125/119/12 | 48.8 % | 0 | identical to 64 |
| `+STEAL=100` | **132/120/4** | **51.6 %** | 0 | recommended core |
| `+STEAL=100 +FEED=80` | 114/135/7 | 44.5 % | −18 | staging merges above captures costs two ticks and blocks the capture |
| `+STEAL=100 +FEED=60` | 126/123/7 | 49.2 % | −6 | — |
| `+STEAL=100 +CAPTURE=30 +RING=12` | 119/125/12 | 46.5 % | −13 | painting breadth without army is punished |
| `+STEAL=100 +RING=8` | 125/120/11 | 48.8 % | −7 | — |
| `+STEAL=100 +HOLE=25` | 117/132/7 | 45.7 % | −15 | dead-end cells still pay pulses; refusing them loses land |
| `+STEAL=100 +FAN=1 +FAN_ARMY=5` | (probe only) | — | — | the frontier rarely holds five army |
| `+STEAL=100 +FAN=1 +FAN_ARMY=3` | 127/123/6 | 49.6 % | −5 | see below |
| `+STEAL=100 +LEAD=110` | 129/120/7 | 50.4 % | −3 | the cheap price of a clean full matrix |
| `+STEAL=100 +LEAD=130` | 129/121/6 | 50.4 % | −3 | does not fix the v2 cell alone |
| `+STEAL=100 +FRONTIER=1` | 131/121/4 | 51.2 % | −1 | half 2 drops to 121 (net +8/512) |

Two negatives are worth keeping because they are rules findings, not just
weights:

- **Unlimited fronts are real but not worth it.** The engine runs every queued
  move whose source is not a target, so one cell may attack two neighbours in
  the same tick as long as both pushes are halved (`mode 1`). `applyFan`
  implements exactly that and is safe (a failed half push is a mutual loss only
  when it hits defenders, so it only fans onto neutral cells). Measured: 127
  against 132 — the frontier simply does not hold the five-plus army a split
  needs, and a halved push into a two-army cell fizzles. Kept behind
  `BOT3_MSHAPE_FAN` (default 0).
- **More executed orders is not more wins.** The ungated layer raises the
  executed order count (archipelago 4651 → 4782, mediterranean 6662 → 6360,
  random 3721 → 3570 is a *drop*) and the win rate does not follow it. The
  binding resource is army at the frontier ring, not slots.

## Reproduction

```sh
cd /c/Users/reson/Downloads/fork/Roka-bot3-r15-mshape

# 8 relay multi cells, seeds 1-16, both seats (256 games)
OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean MODES=001,011 \
SEED_FROM=1 SEED_TO=16 WORKERS=4 BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 \
BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110 \
OUT=data/scratch/relay-multi-mshape.jsonl node scripts/evaluate-bot3-baseline.cjs || true
NO_GATE=1 node scripts/compare-bot3-baseline.cjs data/scratch/relay-multi-mshape.jsonl

# full 2048-game matrix
BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110 \
OUT=data/scratch/full-final.jsonl node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs data/scratch/full-final.jsonl

# the second seed half needs its own baseline (the recorded one is seeds 1-16)
SEED_FROM=17 SEED_TO=32 OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean \
MODES=001,011 OUT=data/scratch/base17.jsonl node scripts/evaluate-bot3-baseline.cjs || true

# unit tests
node --test bot-template/bot-3.0/bot3.test.cjs
```

The trajectory probes are `data/scratch/mshape-probe.cjs` (per-tick land, army,
frontier ring, `frontDist` histogram and order classes for the Bot(3.0) seat;
`MAP=random SEED=probe-1 TICKS=110 DUMP=50` dumps the order list of turn 50) and
`data/scratch/ms-decomp.cjs` (checkpoint aggregation). Both are scratch files and
are not part of the bot.

## 结论（第 15 轮）

多线房间没有 burst，唯一的持续收入是土地：普通格在 `t % 50 == 0` 各付 +1 兵，
一次占领只消耗防守方驻军，所以「一格土地 = 一兵」。脉冲前土地增长完全被收入
（单王冠 +1/Tick）锁死，任何策略都追不平；脉冲后则被**前线宽度**锁死——每格
每 Tick 只能出一张指令，而脉冲把 38–70 兵一次性撒到离前线 2–6 跳的内陆，实测
脉冲后的几个 Tick 全花在后方向合并上，只有 2/9 个前线格能出兵。

`mshape.js` 因此只做两件事：把继承的 16 单上限放开到全部候选（`SLOTS=64`，脉冲
Tick 有 40+ 候选），以及让「会废掉一次占领的合并」不再排在占领前面（`STEAL`，
引擎里合并目标不能在当 Tick 出手，且 `strategy.js` 在队列非空时直接跳过规划，
所以这种合并会同时浪费两 Tick）。`LEAD=110` 在已经大幅领先时退场，保证全量矩阵
零退化；迷宫走廊按实测直接退场（`CORRIDOR=0`）。

结果：Relay 多线 8 格 123 → 129（种子 1–16）与 121 → 125（种子 17–32），合计
512 局 +10 胜（+2.0pp）；全量 2048 局 1694/297/57（82.7%）对基线 1688/299/61
（82.4%），64 格无一格低于基线，但也没能达到 65% 门槛（最好 56.3%）。因此
`BOT3_MSHAPE` 默认**关闭**，仅作为「能力 + 开关 + 实测记录」交付。同轮实测的负
结果：无限战线分兵（引擎允许同格多方向）127/256、涂地广度（`CAPTURE`/`RING`）
119–125/256、前沿投喂（`FEED`）114/256、拒绝死胡同（`HOLE`）117/256。
