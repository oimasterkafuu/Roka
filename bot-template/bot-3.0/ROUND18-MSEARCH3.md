# Round 18 — three-tick search with a compounding evaluation (`BOT3_M3PLY`)

Round 17 built a two-tick exact search (`m2ply.js` on top of `msim`/`mqueue`) and
measured **+25 wins / 512 clear multi games** (`263 → 288`, 51.4 % → 56.3 %),
all of it out of sample, at 1.4 ms/tick and 16–20 % adoption. It also documented
why it stalls: land was priced **linearly** (`landW = min(5, 1 + pulsesLeft)`),
while land is an *income* process — every plain pays +1 army on each 50-tick mark
for the rest of the game, and that army buys more land — and the candidate supply
only ever fed the current tick's matching. A two-tick horizon can see the tick
that arms a ring cell, never the capture it enables.

This round adds the **third tick** and a **compounding evaluation**, and grows the
supply the planner cannot propose. New switch **`BOT3_M3PLY`**, default **off**;
`BOT3_M2PLY=1` alone is still byte-for-byte the round-17 layer, and with every
switch unset the 256-game screen and the 512-game clear screen are unchanged
(re-verified: `data/scratch/id-m2.jsonl` vs `data/scratch/m2-clear.jsonl`, 32/32
rows identical, and the no-env runs reproduce the round-16 numbers exactly).

## Measured result, honest summary

- On **512 clear multi games** (seeds 1–64) the layer takes relay multi-line from
  **263/512 (51.4 %)** to **295/512 (57.6 %)**, **+32 wins (+6.3 pp)** — and every
  map improves: random +14, mediterranean +8, maze +6, archipelago +4.
- The official 256-game screen goes **136 → 143** (+7). Round 17's two-tick
  search was a wash there (136). All four **clear** cells now improve
  (archipelago 15→17, maze 16→18, mediterranean 19→21, random 21→22) and the four
  fog cells are byte-identical, as they must be (the layer refuses fog rooms).
- The full 2048-game matrix is **1709/284/55 (83.4 %)** against the recorded
  **1702/290/56 (83.1 %)**: +7 wins, **zero cells below their baseline**, and
  every non-relay-multi cell is exactly unchanged (`Δwin 0.0pp` in all 60 of
  them). Round 17 also totalled 1702 with a redistribution; this round adds wins
  without giving any back.
- The acceptance bar (21/32 in every relay multi cell) is **not** met: two of the
  four clear cells do reach it in-sample (random **22/32**, mediterranean
  **21/32**), maze is 18 and archipelago 17, and the other four cells are fog,
  which a board-verified search cannot enter at all. Best clear cell: **22/32
  (68.8 %)**.
- The layer costs **8.2 ms/tick** for the search plus 0.55 ms/tick for relay's
  batch, i.e. **8.8 ms/tick**, with 4.7 simulations per tick — inside the ~20 ms
  budget, but 6× round 17.
- It ships **off**: a measured, regression-free gain that still misses the bar,
  at 6× the CPU of the two-tick layer.

## What was built

| file      | role                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `msim.js` | exact one-tick model of the engine (round 14, unchanged)                |
| `mqueue.js` | relay's batch one tick early + whole-board gate (round 14; now also armed by `BOT3_M3PLY`) |
| `m2ply.js` | the search. `plies = 2` is the round-17 layer; `plies = 3` is this round |
| `msearch.js` | round-14 one-tick driver, kept as the reference                       |

### 1. Three ticks, three batches

Per planning frame (tick `turn`), for **every** candidate set:

1. `msim` replays **tick + 1** on the frame board with that candidate set and
   relay's batch, which `mqueue.predict` knows exactly.
2. `mqueue.predictAhead` replays **relay's own planner** on that candidate's
   tick + 1 board (with its private bookkeeping restored afterwards), giving
   relay's batch for **tick + 2**.
3. Our own tick + 2 orders are the fixed rollout (every cell that can capture
   does, best target first; then spare cells feed an unarmed ring cell).
4. `predictAhead` again on the tick + 2 board gives relay's batch for
   **tick + 3**; our tick + 3 orders are the same rollout.
5. The **tick + 3 board** is scored.

Round 17 predicted relay's tick + 2 batch once, from the *planner's* tick + 1
board, and priced every candidate against that one response. The three-tick
layer predicts it from each candidate's own board, which is both more correct
and unavoidable: the candidate changes relay's next board, so its next batch
changes too. `plies = 2` keeps the round-17 shape (shared prediction) so the two
layers stay comparable.

### 2. The compounding value

`armyDiff + landValue·landDiff + crown·crownDiff + ring·ringReady +
width·ringWidth + cheap·cheapCaptures + mass·ringMass + cut·isolatedDiff +
guard·crownSafety` (army units), `±1e7` for a finished game.

- **Land is the remaining income stream**, `exchange · Σ_{k=1..P} decay^k` with
  `P = clamp(floor((horizon − turn)/50), 0, landCap)` — the pulses a cell still
  pays, discounted by how late each one arrives (default `exchange = 1.5`,
  `decay = 0.95`, `horizon = 250`). At t≈50 that is ≈5.3 army, at t=200 ≈1.4;
  below one army a cell is still worth one army. `BOT3_M3PLY_STREAM=0` restores
  the round-17 linear weight.
  The exchange rate has to clear the measured capture arithmetic (a capture costs
  the target's garrison and strands one army on the source, so land growth is
  bounded by surplus army ÷ 2), which is why the sweep below never prefers an
  exchange rate below 1.
- **`cheap`** prices ring cells that are **one feed away** from capturing
  (`mass ≥ 2`, cheapest gap `garrison + 2 − mass` in `[1, reach]`): the arming
  move this layer supplies but the planner never prices.
- **`width`** prices the ring itself (frontier cells, armed or not), so a wider
  front is worth more than the same army in the interior.
- **`ring`**, **`mass`**, **`cut`**, **`guard`** keep their round-17 meaning
  (armament, frontier mass, isolation, crown safety).

### 3. The supply the planner cannot propose

Round 17's census is the key number: ring ≈12.3 cells, only **1.8 can fire**,
and the feed family found just **1.14 donors per target**. Army in these rooms is
thin (≈1.8 per cell on average), so the bottleneck is not a lack of donors but
the *bar* a donor had to clear (three army ⇒ a two-army push). This round:

- **`minFeed` 3 → 2** (`BOT3_M3PLY_MINFEED`): a two-army cell pushes one, which is
  exactly enough to turn a one-army ring cell into a capturer of an empty plain.
  The census goes to **3.7 plans and 1.3 donors per plan per tick**, and the
  adoption rate rises from 19.6 % to **30.1 %** of ticks.
- **`split`** (`BOT3_M3PLY_SPLIT`, default 2): arm **two** ring cells on the same
  tick, each from its own capture-free donor. The round-17 supply could only feed
  one cell per set, so two fronts could never be armed together — precisely the
  shape a three-tick horizon can price, because both fire on tick + 2.
- **`stage`** (default 2): the same, with two donors per target, spending only
  cells that cannot capture this tick (so the family can never repeat the `trim`
  mistake of trading a capture for an arming move).
- `lateral`/`feed` (round 17), `fan`, `retain`, `trim` are unchanged; `trim`
  still ships off.

Every set passes `sanitize()` before simulation and before emission: no order's
source is another order's target, so the engine never keeps one of our orders
queued and `strategy.js`'s `pending` gate never stalls. Adopted sets are emitted
verbatim (the greedy matching loop cannot express a duplicate target).

Adoption requires `best − baseline ≥ margin` (default 2 army).

## Measured tables

All runs: `OPPONENTS=relay`, `MODES=001` (clear multi-line) unless stated,
`WORKERS=8`, no other environment variables.

### 512 clear multi games, seeds 1–64

| seeds   | base        | `BOT3_M2PLY=1` (round 17) | `BOT3_M3PLY=1` | Δ vs base |
| ------- | ----------- | ------------------------- | -------------- | --------: |
| 1–16    | 71/128      | 71/128                    | **78/128**     |        +7 |
| 17–32   | 61/128      | 78/128                    | **78/128**     |       +17 |
| 33–64   | 131/256     | 139/256                   | **139/256**    |        +8 |
| **all** | **263/512** | **288/512**               | **295/512**    |   **+32** |

Per map over the same 512 games:

| map           | base  | `BOT3_M2PLY=1` | `BOT3_M3PLY=1` | Δ vs base |
| ------------- | ----: | -------------: | -------------: | --------: |
| random        | 70/128 | 76/128        | **84/128**     |       +14 |
| mediterranean | 72/128 | 81/128        | **80/128**     |        +8 |
| maze          | 63/128 | 67/128        | **69/128**     |        +6 |
| archipelago   | 58/128 | 64/128        | **62/128**     |        +4 |

The important difference to round 17 is *where* the gain sits: the two-tick layer
was flat in-sample (71 → 71) and won everything out of sample; this layer is
**+7 in-sample, +17 on 17–32 and +8 on 33–64**, i.e. the same out-of-sample
strength plus a real in-sample gain.

### Official 256-game screen (seeds 1–16, `MODES=001,011`)

| map           | fog | base        | `BOT3_M3PLY=1` | Δ win  |
| ------------- | --- | ----------- | -------------- | -----: |
| archipelago   | off | 15/15/2     | 17/15/0        |   +6.3 |
| archipelago   | on  | 15/16/1     | 15/16/1        |    0.0 |
| maze          | off | 16/16/0     | 18/13/1        |   +6.3 |
| maze          | on  | 16/16/0     | 16/16/0        |    0.0 |
| mediterranean | off | 19/11/2     | 21/9/2         |   +6.3 |
| mediterranean | on  | 17/14/1     | 17/14/1        |    0.0 |
| random        | off | 21/11/0     | 22/10/0        |   +3.1 |
| random        | on  | 17/15/0     | 17/15/0        |    0.0 |
| **total**     |     | **136/114/6** | **143/108/5** | **+2.7 pp** |

The four fog cells are a free control: the layer refuses fog rooms, so they are
byte-identical.

### Full 2048-game matrix

```sh
BOT3_M3PLY=1 WORKERS=8 OUT=data/scratch/m3-full.jsonl \
SUMMARY=data/scratch/m3-full-summary.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs data/scratch/m3-full.jsonl
```

| scope                      | result                       |
| -------------------------- | ---------------------------- |
| all 64 cells               | **1709/284/55 (83.4 %)**     |
| recorded baseline          | 1702/290/56 (83.1 %)         |
| round-17 two-tick          | 1702/292/54 (83.1 %)         |
| cells below their baseline | **0**                        |
| cells not byte-identical   | 4 (all relay multi, clear)   |

Relay multi-line cells: archipelago clear **17**/15/0 (+2), fog 15/16/1 (0),
maze clear **18**/13/1 (+2), fog 16/16/0 (0), mediterranean clear **21**/9/2 (+2,
the first non-random cell to clear the 65 % gate), fog 17/14/1 (0), random clear
**22**/10/0 (+1), fog 17/15/0 (0).

### CPU and adoption

One core, probe on `random/bot3-baseline-3` (1000-tick limit, 598 planning
frames across the two seats, `BOT3_M3PLY=1 BOT3_M2PLY_STATS=1
BOT3_MSEARCH_STATS=1`):

| step                                   | per tick |
| -------------------------------------- | -------: |
| relay batch prediction (`mqueue`)      |  0.55 ms |
| three-tick search (`m2ply`, 2797 sims) |  8.21 ms |
| **total**                              | **8.8 ms** |

| adoption counter | ticks / count |
| ---------------- | ------------: |
| ticks             | 598 |
| simulations       | 2797 (4.7/tick) |
| candidate sets    | 3245 (5.4/tick) |
| adopted           | **180 (30.1 %)** |
| → `lateral` (round-17 shape) | 127 |
| → `feed` (multi-feed)        |  36 |
| → `split` (two fronts)       |   8 |
| → `stage` (deep arming)      |   2 |
| → `react`                    |   7 |
| → `fan`                      |   0 |
| mean value gain on adoption | 4.6 army |

Batch-runner wall time for the same 512 games at 8 workers: base 64 s, round-17
two-tick 119 s, this layer 201 s.

## The margin / exchange sweep (adoption is a win-rate question)

Round 17 showed a value-improving margin can win nothing, so the knobs were swept
on wins, not on value. In-sample block = seeds 1–16 (128 games), replication =
17–32. Unless stated, `BOT3_M3PLY=1`.

| config                          | 1–16      | 17–32     | verdict |
| ------------------------------- | --------: | --------: | ------- |
| `minFeed 3` (round-17 donor bar), everything else new | 72/128 | 76/128 | the donor bar is the lever |
| `minFeed 2` (default)           | **78**/128 | **78**/128 | default |
| + `margin 3`                    | 77/128    | 73/128    | negative |
| + `margin 1` (`minFeed 3`)      | 75/128    | —         | noise |
| + `margin 0.5` (`minFeed 3`)    | 75/128    | —         | noise |
| `exchange 1.0`                  | 75/128    | 73/128    | negative |
| `exchange 2.5` (`minFeed 3`)    | 74/128    | —         | noise |
| `feeds 6`                       | 76/128    | 79/128    | neutral (+1 on 256) |
| `plies 2` (compounding value + supply, no third tick) | 72/128 | 73/128 | the third tick is worth +11 on 256 |

On 256-game blocks the defaults score **156** (`minFeed 2`), `margin 3` 154,
`feeds 6` 155 and `exchange 1.0` 150 — all inside noise of each other, so the
defaults were kept rather than fitted to a block. The one knob that is clearly
not noise is the donor bar (`minFeed` 3 → 2: +8 wins on 256) and the third tick
itself (+11 on 256 over the same value and supply at two plies).

## Honest negatives

| shape / knob                        | measurement                                        | verdict |
| ----------------------------------- | -------------------------------------------------- | ------- |
| `trim` (drop weakest, refill slots) | −6 wins on the 256 screen (round 17)               | still off |
| `retain` (halved push, fire again)  | neutral at two plies (round 17)                    | still off |
| `fan` (second halved front)         | 0 adoptions in 598 ticks of probing                | dead |
| `split` / `stage`                   | 8 / 2 adoptions in 598 ticks: legal but rarely expressible (needs two armed-but-idle donors on distinct targets) | rarely fires |
| `margin` 3 / 1 / 0.5                | 154 / 75 / 75 against 156 / 78 / 78                | negative / noise |
| `exchange` 1.0 / 2.5                | 150/256 / 74/128 against 156 / 78                  | negative / noise |
| `feeds` 6                           | 155/256                                            | neutral |
| `minFeed` 3 (round-17 bar)          | 148/256 against 156                                | the round-17 supply is the bottleneck |
| two plies + this value and supply   | 145/256 against 156                                | the third tick is the in-sample gain |
| fog rooms                           | refused by construction (see round 17)             | out of reach |

## Why the bar is still missed

Two of the four clear cells reach 21/32 and the other two do not (maze 18,
archipelago 17), and the remaining four relay multi cells are fog. The layer's
own numbers bound what is left:

- **Adoption is still dominated by the round-17 shape** (127 of 180 adoptions are
  a single lateral feed). The new families fire 10 times in 598 ticks because
  two simultaneous capture-free donors on distinct targets are rare in a room
  whose ring averages 1.8 army per cell.
- **The gain is a mid-game exchange, not a material lead.** The three-tick
  horizon still prices the board only three ticks out; the compounding term makes
  land more valuable, but the search cannot *create* extra land, because the base
  already grows land at the surplus ÷ 2 bound measured in round 17. What it can
  do — and does — is spend idle ring army on arming moves that the planner never
  proposes.
- **The mirror is symmetric.** Multi rooms are the same policy on both seats, so a
  seed only becomes 2-0 or 0-2 when the policies actually differ; 30 % adoption on
  a 16-seed block is worth a handful of decisive pairs, not seven.

A longer horizon (4–5 ticks) or a value that models the *army* an extra cell will
have produced by a checkpoint (not just its pulse count) is the next step; the
CPU headroom is 8.8 of ~20 ms, so a 4-tick horizon with a smaller supply is
affordable.

## Switches

| variable                                              | default | effect |
| ----------------------------------------------------- | ------- | ------ |
| `BOT3_M3PLY`                                          | off     | the whole round-18 layer (3 ticks, compounding value, split/stage supply) |
| `BOT3_M2PLY`                                          | off     | the round-17 two-tick layer, byte-identical to round 17 |
| `BOT3_M3PLY_PLIES`                                    | 3       | horizon 2 or 3 (2 = the round-17 shape with the new value) |
| `BOT3_M3PLY_STREAM` / `_EXCHANGE` / `_DECAY`          | on / 1.5 / 0.95 | land as a discounted remaining income stream |
| `BOT3_M3PLY_CHEAP` / `_REACH` / `_WIDTH`              | 0.5 / 2 / 0.3 | ring cells one feed from a capture, and ring width |
| `BOT3_M3PLY_MINFEED` / `_SPLIT` / `_STAGE`            | 2 / 2 / 2 | donor bar, two-front arming, deep arming |
| `BOT3_M2PLY_MARGIN`                                   | 2       | value (army units) a set must gain |
| `BOT3_M2PLY_SIMS`                                     | 12      | simulation budget per tick (4.7 used on average) |
| `BOT3_M2PLY_FEEDS` / `_NEED`                          | 3 / 4   | how many ring cells are armed, and how far out of reach their target may be |
| `BOT3_M2PLY_LAND` / `_LAND_CAP` / `_HORIZON`          | 1 / 5 / 250 | linear land weight, used when `STREAM=0` |
| `BOT3_M2PLY_CROWN` / `_RING` / `_MASS` / `_CUT` / `_GUARD` | 120 / 1.5 / 0.5 / 0.5 / 0.5 | value weights |
| `BOT3_M2PLY_KEEP` / `_RETAIN` / `_FAN`                | 0 / 0 / 1 | the measured-negative/dead families |
| `BOT3_M2PLY_STATS` / `_TRACE`                         | off     | counters / per-adoption line on stderr |
| `BOT3_MSEARCH_ARM`                                    | 6       | exact frames required before the predictor arms |

`BOT3_M2PLY=1` alone changes nothing about this round: it keeps `plies = 2`,
`minFeed = 3`, `stream = 0`, `width = 0`, `cheap = 0`, `split = 0`, `stage = 0`.
An explicit `plies >= 3` (or `BOT3_M3PLY=1`) turns the round-18 value and supply
on, which is why the tests can drive either shape directly.

## Risks

- **Ship state.** Off by default: +32 wins on 512 clear multi games, +7 on the
  official screen, +7 on the full matrix with zero regressions, but the 65 % bar
  is met in only two of the four clear cells and at 6× the CPU of round 17.
  Recommendation: keep the switch, ship it on only if the CPU is acceptable;
  the two-tick layer is the cheaper option.
- **Prediction scope.** Clear 1v1 multi-line rooms only; fog and serial rooms are
  refused up front. Fog would need a belief model over relay's board.
- **Residual correctness risk.** The whole-board gate is unchanged, and over this
  round's probes the drift counter never fired (712 frames, 0 drift, 0 gaps,
  0 leftovers). A wrong-but-consistent prediction would still pass, so the layer
  is armed only after six exact frames.
- **Emitted batches.** `sanitize()` guarantees no order's source is another
  order's target; the unit tests assert this for every new family.
- **CPU.** 8.8 ms/tick on top of the base, 4.7 simulations/tick. The batch runner
  is ~3× slower than the base on multi-line games.

## Reproduce

```sh
# 512 clear multi games, three layers side by side
node data/scratch/m3-screen.cjs base 1 64
node data/scratch/m3-screen.cjs m2 1 64 BOT3_M2PLY=1
node data/scratch/m3-screen.cjs m3 1 64 BOT3_M3PLY=1
node data/scratch/m3-count.cjs data/scratch/m3.jsonl --blocks=1:16,17:32,33:64

# official 256-game screen and full matrix
BOT3_M3PLY=1 OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean \
MODES=001,011 SEED_FROM=1 SEED_TO=16 WORKERS=8 OUT=data/scratch/m3-256.jsonl \
SUMMARY=data/scratch/m3-256-summary.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs data/scratch/m3-256.jsonl

# CPU / adoption counters
BOT3_M3PLY=1 BOT3_M2PLY_STATS=1 BOT3_MSEARCH_STATS=1 SEEDS=bot3-baseline-3 \
TICKS=1000 OPPONENTS=relay MAPS=random MODES=001 SELF_ID=bot3 \
RELAY_ENTRY=../bot-template/bot-3.0/strategy node scripts/evaluate-bot3.cjs

node --test bot-template/bot-3.0/bot3.test.cjs
```

`data/scratch/m3-screen.cjs` and `data/scratch/m3-count.cjs` are the little
screen/counter helpers used above (they are scratch, not part of the package).
