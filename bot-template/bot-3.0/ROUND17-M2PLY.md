# Round 17 — two-tick exact search in multi-line rooms (`BOT3_M2PLY`)

Round 14 built an exact one-tick simulator of the engine (`msim.js`, 0
mismatches over ~380k cell-ticks) and a predictor for relay's in-flight batch
(`mqueue.js`, 2917/2917 and 5610/5610 frames exact, whole-board verification
gate) and measured a one-tick search at **-1.2 pp**. The explanation was
structural: the planner already takes every capture it can reach, so a single
tick has nothing left to price, and the sixteen slots are not the bottleneck
(relay averages 9.5 orders of 16).

This round keeps the simulator and the predictor and spends them on what a
single tick cannot see: the **trajectory**. In a multi-line room the engine runs
every queued move whose source is not another order's target, so several cells
can feed the same cell in one tick — and a cell that is fed cannot fire on that
tick. Arming therefore only pays on the tick *after*, which is exactly the
two-tick shape measured here.

New switch **`BOT3_M2PLY`**, default **off**; with the variable unset the 256-game
relay multi screen is byte-identical to the round-16 base (`data/scratch/off2.jsonl`
vs `data/scratch/base-s1.jsonl`, `diff` clean).

## Measured result, honest summary

- On **512 clear multi games** (seeds 1–64) the layer takes relay multi-line from
  **263/512 (51.4 %)** to **288/512 (56.3 %)**, **+25 wins (+4.9 pp)**, and every
  map improves: archipelago +6, maze +4, mediterranean +9, random +6.
- The gain is **entirely out-of-sample**: seeds 1–16 are flat (71 → 71, one cell
  -5 / three cells +5), seeds 17–32 give **+17** (61 → 78, 47.7 % → 60.9 %) and
  seeds 33–64 give **+8** (131 → 139). That is the reverse of rounds 15/16, whose
  in-sample gains decayed to zero — here the in-sample half shows nothing and the
  held-out halves show the gain.
- The official 256-game screen (seeds 1–16, `MODES=001,011`) is **136/256**,
  identical to the round-16 base, because 128 of those games are fog (the layer
  refuses fog rooms by construction) and the 128 clear games break even.
- The full 2048-game matrix is **1702/292/54 (83.1 %)** against the recorded
  **1688/299/61 (82.4 %)**, `+14` wins, **zero regressions in any of the 64
  cells** (no cell below its paired baseline; `anti|archipelago|fog|multi` is the
  only non-relay-multi cell that moves, +3.1 pp).
- The 65 % bar is **not** met: best cells are mediterranean clear 22/32 (68.8 %)
  and, pooled over 64 seeds, mediterranean 63.3 %. Four of the eight relay
  multi cells are **fog**, where this layer cannot run at all, so `21/32` in
  every cell is out of reach for a verified clear-room layer (see "Why fog is
  out of reach").
- The switch ships **off**: it is a measured gain but not the acceptance bar, and
  it costs CPU on every multi-line tick.

## What was built

| file             | role                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `msim.js`        | exact one-tick model of the engine (round 14, unchanged)                |
| `mqueue.js`      | relay's batch one tick early + whole-board gate (round 14, + `predictAhead`) |
| `m2ply.js`       | two-tick search: candidate supply, tick+1/tick+2 simulation, value      |
| `msearch.js`     | round-14 one-tick driver, kept as the reference for `MSIM.md`           |

### 1. Both ticks, both batches

Per planning frame (tick `turn`):

1. `mqueue.predict` predicts relay's batch for **tick + 1** (exact, gated).
2. `msim` replays **tick + 1** on the frame board with the planner's own order set
   and that batch. The resulting board is where relay's next batch comes from.
3. `mqueue.predictAhead` replays **relay's own planner** on that simulated board
   (with its private bookkeeping: `opening`, `lastFrom`/`lastMove`, `column`,
   `memory`/`lastSeen`), i.e. relay's response at **tick + 2** is known too. Every
   field the replay touches is restored afterwards, so the frame-to-frame
   prediction and the verification gate are untouched (unit-tested).
4. Each candidate set is simulated through tick + 1 (our set vs relay's batch,
   correct seat order and parity) and tick + 2 (a fixed rollout vs the predicted
   batch), and the final board is scored.

### 2. Candidate supply (the part round 14 got wrong)

The baseline is the planner's own set: `collect()` mirrors the take loop exactly
(one order per source and per target, up to the room's slot count — 64 under the
base config, not 16). The search then adds the order **shapes the planner cannot
propose in a multi-line room**:

- **`lateral` / `feed`** — one to three own cells push into the same frontier
  cell. The engine runs them in sequence order (none of their sources is a
  target), the cumulative mass arms that cell for the next tick, and the
  planner cannot produce it twice over: it only proposes an own merge that
  strictly reduces `frontDist` (a frontier cell is at 0, so lateral
  frontier→frontier merges are never candidates), and `take()` allows one order
  per target. This is the shape that pays: in the probe 108 of 120 adoptions were a
  single-source lateral merge and 6 more were a multi-source feed.
- **`fan`** — a second halved front out of a cell that is already attacking
  (both orders execute because their common source is not a target).
- **`react`** — the counter-capture of a cell relay is about to empty (only when
  relay resolves first) and the reinforcement of a cell relay is about to take
  (only when we resolve first).
- **`trim`** (off, measured negative) — the planner's weakest orders dropped and
  the slots refilled from the candidates they were blocking.
- **`retain`** (off, measured neutral) — a capture re-issued as a halved push so
  the source can fire again on the next tick.

Every set passes `sanitize()` first: duplicate edges are removed and any order
whose source is another order's target is dropped, because the engine keeps such
an order in the queue instead of executing it and `strategy.js` stops planning
while anything is pending. The adopted set is emitted **verbatim** (the greedy
matching loop cannot express a duplicate target), with the same `lastFrom` /
`lastMove` bookkeeping the take loop would have written.

### 3. The two-tick value

`armyDiff + landW(turn)·landDiff + crown·crownDiff + ring·ringReady + mass·ringMass
+ cut·isolatedDiff + guard·crownSafety` (army units), `±1e7` for a finished game.

- **Land is weighted by the pulse clock**: `landW = min(landCap, 1 + pulsesLeft)`
  with `pulsesLeft = (horizon - turn)/50`, so a cell taken at t=50 is worth about
  five army (it pays on t=50/100/150/200 and is also a cell) and one army after
  the horizon.
- **Ring armament** prices army that is on the frontier and able to fire
  (`army ≥ 2`) over the same army in the interior — the round-16 diagnostic was
  that the empire is never short of army, only short of army *on the ring*.
- **Crown safety** charges the garrison a crown is missing against the strongest
  adjacent enemy stack, which is how these games actually end (routs, and the
  occasional 1–2 army crown flip).
- **Isolation** prices army the rival cannot spend for ten ticks.

The **tick + 2 policy** is a fixed greedy (every cell that can capture does,
best target first; then every spare cell feeds an adjacent frontier cell that is
not armed), identical for the baseline and for every candidate, so the comparison
prices the candidate and not the rollout.

Adoption requires `best - baseline ≥ margin` (default 2 army).

## Measured tables

All runs: `. data/scratch/base-env.sh`
(`BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110 BOT3_MHALF=1`),
`OPPONENTS=relay`, `MODES=001` (clear multi) unless stated.

### 512 clear multi games, seeds 1–64

| seeds  | base        | `BOT3_M2PLY=1` | Δ wins | Δ pp  |
| ------ | ----------- | -------------- | -----: | ----: |
| 1–16   | 71/128      | 71/128         |      0 |   0.0 |
| 17–32  | 61/128      | 78/128         |    +17 | +13.3 |
| 33–64  | 131/256     | 139/256        |     +8 |  +3.1 |
| **all**| **263/512** | **288/512**    | **+25**| **+4.9** |

Per map over the same 512 games:

| map           | base  | `BOT3_M2PLY=1` | Δ     |
| ------------- | ----: | -------------: | ----: |
| archipelago   | 58/128 | 64/128        | +6    |
| maze          | 63/128 | 67/128        | +4    |
| mediterranean | 72/128 | 81/128        | +9    |
| random        | 70/128 | 76/128        | +6    |

### Official 256-game screen (seeds 1–16, `MODES=001,011`)

| map           | fog | base        | `BOT3_M2PLY=1` | Δ win  |
| ------------- | --- | ----------- | -------------- | -----: |
| archipelago   | off | 15/15/2     | 16/15/1        |   +3.1 |
| archipelago   | on  | 15/16/1     | 15/16/1        |    0.0 |
| maze          | off | 16/16/0     | 17/15/0        |   +3.1 |
| maze          | on  | 16/16/0     | 16/16/0        |    0.0 |
| mediterranean | off | 19/11/2     | 22/9/1         |   +9.4 |
| mediterranean | on  | 17/14/1     | 17/14/1        |    0.0 |
| random        | off | 21/11/0     | 16/16/0        |   -15.6 |
| random        | on  | 17/15/0     | 17/15/0        |    0.0 |
| **total**     |     | **136/114/6** | **136/116/4** | **0.0** |

The four fog cells are a free control: the layer refuses fog rooms, so they must
be (and are) byte-identical. The clear-room screen is a wash on seeds 1–16:
`mediterranean` +3, `archipelago`/`maze` +1, `random` -5. `random/clear` is the
one cell this round loses in-sample; over 64 seeds it gains (+6).

### Full 2048-game matrix

```sh
BOT3_M2PLY=1 WORKERS=8 OUT=data/scratch/m2-full.jsonl \
SUMMARY=data/scratch/m2-full-summary.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs data/scratch/m2-full.jsonl
```

| scope                     | result                       |
| ------------------------- | ---------------------------- |
| all 64 cells              | **1702/292/54 (83.1 %)**     |
| recorded baseline         | 1688/299/61 (82.4 %)         |
| round-16 (`mhalf`) matrix | 1702/290/56 (83.1 %)         |
| cells below their baseline| **0**                        |

Relay multi-line cells in the full matrix (parentheses are against the *recorded*
baseline, which predates `mhalf`; the fog cells are therefore also higher than in my
own base run): archipelago clear 16/15/1 (+1),
fog 15/16/1 (0), maze clear 17/15/0 (+1), fog 16/16/0 (0), mediterranean clear
22/9/1 (+8), fog 17/14/1 (+2), random clear 16/16/0 (0), fog 17/15/0 (+1).

### CPU

One core, probe on `random/bot3-baseline-3` (1000-tick limit, 659 frames, two
seats, `BOT3_M2PLY=1 BOT3_M2PLY_STATS=1 BOT3_MSEARCH_STATS=1`):

| step                                  | per tick |
| ------------------------------------- | -------: |
| relay batch prediction (`mqueue`)     |  0.26 ms |
| two-tick search (`m2ply`, 1972 sims)  |  1.12 ms |
| **total**                             | **1.4 ms** |

The search budget is supply-bound, not CPU-bound: the supply averages **2.7
candidate sets per tick**, so `BOT3_M2PLY_SIMS` (default 12) never binds. The
batch runner goes from ~9 s to ~13 s per 8 games. Well inside the ~20 ms/tick
budget; a hosted bot with a dwell cap can raise the budget rather than lower it.

### How often it changes the plan

Probe above: **120 of 612 ticks (19.6 %)** — 108 `lateral`/`feed`, 6 `react`,
6 `feed` with two or more sources; `fan` never won. With the `trim` family left
on (its measured-negative default in the first run) adoption was 48 % of ticks,
which is what a value function chasing noise looks like.

## Honest negatives

| shape / knob                        | measurement                                        | verdict |
| ----------------------------------- | -------------------------------------------------- | ------- |
| trim (drop weakest, refill slots)   | 128/256 on the official screen (`random/clear` -8, `archipelago/clear` -2) against 136/256 without it | negative, off |
| retain (halved push, fire again)    | 77/128 vs 78/128 on seeds 17–32                    | neutral, off |
| fan (second halved front)           | 0 adoptions in 612 ticks of probing                | no effect |
| `landCap=3` / `landCap=8`           | 73 / 71 of 128 on seeds 1–16 (default 71)          | neutral |
| `land=2 landCap=8`                  | 77/128 on seeds 17–32 (default 78)                 | neutral |
| `ring=3 mass=1.5`                   | 77/128 on seeds 17–32 (default 78)                 | neutral |
| `feeds=6 need=6`                    | 69/128 on seeds 1–16 (default 71)                  | negative |
| multi-feed with 3 sources            | generated every tick it is reachable, rarely adopted | no effect |

The value weights are not the limit (round 14 measured the same for the one-tick
value): four materially different weightings all land within noise of each
other, so the argmax set is insensitive to them.

### Why fog is out of reach

Four of the eight relay multi cells are fog. In a fog frame the engine blanks
every unseen cell to **200 (empty plain)** and zeroes its army
(`src/game-engine/fog-vision.ts`), so the board the bot holds is not the board
the engine will resolve: an unseen relay stack is indistinguishable from empty
neutral ground. Simulating that board would price captures that do not exist,
and relay's batch cannot be predicted or verified at all. Prediction in fog needs
a belief model over the rival's board, which this round does not have — so the
layer refuses fog and those four cells stay at the base numbers.

## Why it cannot beat the mirror everywhere (the missing term)

The mirror breaks into 2-0/0-2 pairs only when the two policies differ, and the
layer does differ (19.6 % of ticks). What it still cannot price is the
**compounding** of the land race: land pays army on the pulse marks, army buys
land, and the lead only becomes visible around t≈100–115. A two-tick horizon
values one cell at `min(5, 1 + pulsesLeft)` army, which is a linear
approximation of a geometric process — the search therefore adopts a lateral
arming move whenever it wins the next two ticks, not when it wins the game. The
checkpoint aggregate makes that explicit: at t50 the layer is +0.05 land and
+0.02 army against the base, at t100 **-0.10 land** and +0.03 army, yet it wins
+4.9 pp — the wins come from the mid-game exchange, not from a material lead the
search itself created. A three-tick (or value-network) horizon is the obvious
next step, and the CPU headroom (1.4 of ~20 ms) is there for it.

## Switches

| variable                                        | default | effect                                   |
| ----------------------------------------------- | ------- | ---------------------------------------- |
| `BOT3_M2PLY`                                    | off     | the whole layer (predictor + two ticks)  |
| `BOT3_M2PLY_MARGIN`                             | 2       | value (army units) a set must gain       |
| `BOT3_M2PLY_SIMS`                               | 12      | simulation budget per tick               |
| `BOT3_M2PLY_FEEDS` / `_NEED`                    | 3 / 4   | how many frontier cells are armed, and how far out of reach their target may be |
| `BOT3_M2PLY_FAN`                                | 1       | fan shapes in the supply and in the rollout |
| `BOT3_M2PLY_KEEP`                               | 0       | trim family (measured negative)          |
| `BOT3_M2PLY_RETAIN`                             | 0       | halved-capture family (measured neutral) |
| `BOT3_M2PLY_LAND` / `_LAND_CAP` / `_HORIZON`    | 1 / 5 / 250 | pulse-clock land weight              |
| `BOT3_M2PLY_CROWN` / `_RING` / `_MASS` / `_CUT` / `_GUARD` | 120 / 1.5 / 0.5 / 0.5 / 0.5 | value weights |
| `BOT3_M2PLY_STATS` / `_TRACE`                   | off     | counters / per-adoption line on stderr   |
| `BOT3_MSEARCH_ARM`                              | 6       | exact frames required before the predictor arms |

## Risks

- **Ship state.** Off by default, +4.9 pp on 512 clear multi games, no matrix
  regression, but the 65 % bar is not met and the official 256-game screen is a
  wash. Recommendation: branch-only until a longer horizon or a fog belief model
  exists.
- **Prediction scope.** Clear 1v1 multi-line rooms only; fog and serial rooms are
  refused up front.
- **Residual correctness risk.** The gate compares the whole board, so an
  equally-invalid wrong prediction would pass silently. Over the full 2048-game
  run the drift counter never fired (`mqueue` totals: 0 drift, 0 gaps, 0
  leftovers across every probe).
- **Emitted batches.** `sanitize()` guarantees no order's source is another
  order's target, so the engine never leaves one of our orders queued (which
  would stall `strategy.js`'s `pending` gate). Adopted sets are still emitted
  through the same socket path as the planner's own orders.
- **CPU.** 1.4 ms/tick on top of the base; the batch runner is ~45 % slower on
  multi-line games.

## Reproduce

```sh
. data/scratch/base-env.sh

# clear multi screen on any seed range
node data/scratch/m2-screen.cjs label 16 1        # seeds 1..16, MODES=001
node data/scratch/m2-count.cjs data/scratch/m2-label.jsonl

# official 256-game screen and full matrix
BOT3_M2PLY=1 OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean \
MODES=001,011 SEED_FROM=1 SEED_TO=16 WORKERS=4 OUT=data/scratch/m2-256.jsonl \
SUMMARY=data/scratch/m2-256-summary.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs data/scratch/m2-256.jsonl

# counters (per process, two games)
BOT3_M2PLY=1 BOT3_M2PLY_STATS=1 BOT3_MSEARCH_STATS=1 SEEDS=bot3-baseline-3 \
TICKS=1000 OPPONENTS=relay MAPS=random MODES=001 SELF_ID=bot3 \
RELAY_ENTRY=../bot-template/bot-3.0/strategy node scripts/evaluate-bot3.cjs

node --test bot-template/bot-3.0/bot3.test.cjs
```
