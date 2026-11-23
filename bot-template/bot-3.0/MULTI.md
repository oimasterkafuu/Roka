# Multi-line rooms: measured record

Rooms with `multi_line` execute up to sixteen queued orders per tick instead of
one, so the serial action policy that Bot(3.0) uses everywhere else is the
wrong shape for them: the value of an action is not the value of a serial
action, and both sides can spend sixteen stacks per tick. `multi.js` is the
layer that prices those rooms differently. It is **off by default**: set
`BOT3_MULTI=1` to enable it, or pass `enabled: true` in `multiConfig()`. With
the variable unset the planner is byte-identical to the round-2 baseline (the
serial cells of the full matrix confirm this: every non-multi cell is `0.0pp`).

Two properties of the rules drive the layer:

1. **Burst economy (ticks 26..50).** Every normal owned plain pays `+1` army per
   tick, so a cell captured at tick `t` still pays `51 - t` army. Land taken in
   the burst is the army pool both sides fight the rest of the game with. In the
   paired screen the win rate is **15% when our tick-50 army is below 0.9x the
   rival's and 97% when it is above 1.1x**, so every knob is tuned on army at
   tick 50, not on ticks or land.
2. **After the burst there is no plain income.** Only crowns still pay `+1` per
   tick. Winning means converting the fixed pool into rival crowns, and a move
   that spends army on ground that pays nothing is a loss even when it captures.

## Reproduce

```sh
# 8 relay multi cells: 4 maps x fog off/on, 16 seeds, both seats (256 games).
# The batch runner writes OUT before it validates the cell matrix, and a
# two-mode subset cannot satisfy the eight-cell summary: the run exits non-zero
# after the jsonl is complete, which is expected for a screen.
BOT3_MULTI=1 SEED_FROM=1 SEED_TO=16 WORKERS=4 \
OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean MODES=001,011 \
OUT=/tmp/multi-screen.jsonl node scripts/evaluate-bot3-baseline.cjs || true

NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/multi-screen.jsonl \
  data/scratch/round2-baseline.jsonl

# Full 2048-game matrix against the recorded baseline.
BOT3_MULTI=1 OUT=/tmp/multi-full.jsonl node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/multi-full.jsonl \
  data/scratch/round2-baseline.jsonl

node --test bot-template/bot-3.0/bot3.test.cjs
```

The screen is deterministic: three identical runs produced the same
`133/123/0`. Results below are from `bot3-baseline-1..16`, seats `0` and `1`,
maps `random,maze,archipelago,mediterranean`, modes `001,011` (multi, fog off and
on), compared against the paired rows of `data/scratch/round2-baseline.jsonl`.

## Screen (256 relay multi games, layer on)

| map           | fog | W/L/T        | win       |  vs round-2 |
| ------------- | --- | ------------ | --------- | ----------: |
| archipelago   | off | 18/14/0      | 56%       |      +6.3pp |
| archipelago   | on  | 18/13/1      | 56%       |      +9.4pp |
| maze          | off | 18/14/0      | 56%       |      +6.3pp |
| maze          | on  | 19/13/0      | 59%       |      +9.4pp |
| mediterranean | off | 30/2/0       | 94%       |     +43.8pp |
| mediterranean | on  | 18/14/0      | 56%       |      +6.3pp |
| random        | off | 22/10/0      | 69%       |     +18.8pp |
| random        | on  | 21/11/0      | 66%       |     +15.6pp |
| **total**     |     | **164/91/1** | **64.1%** | **+14.5pp** |

The paired baseline for these 256 games is `127/127/2` (49.6%). Five of the
eight cells are still under the 65% relay target: archipelago and maze move only
`+2..+3` wins, and mediterranean fog does not follow mediterranean clear.

## Ablations (same 256 games)

Each row is the default configuration with one switch changed, so the delta is
the value of that mechanism on its own.

| configuration                        | W/L/T     | win   | Δ vs default |
| ------------------------------------ | --------- | ----- | -----------: |
| default (`BOT3_MULTI=1`)             | 164/91/1  | 64.1% |              |
| `BOT3_MULTI_PAINT=0`                 | 163/92/1  | 63.7% |           -1 |
| `BOT3_MULTI_BURST_GAIN=5`            | 162/93/1  | 63.3% |           -2 |
| `BOT3_MULTI_MARCH_BASE=0`            | 160/95/1  | 62.5% |           -4 |
| `BOT3_MULTI_MERGE=0`                 | 159/97/0  | 62.1% |           -5 |
| `BOT3_MULTI_CUT=10`                  | 158/98/0  | 61.7% |           -6 |
| `BOT3_MULTI_BUILD=0`                 | 156/99/1  | 60.9% |           -8 |
| `BOT3_MULTI_FOCUS=0`                 | 155/100/1 | 60.5% |           -9 |
| `BOT3_MULTI_MARCH=9` (mass march on) | 155/100/1 | 60.5% |           -9 |
| `BOT3_MULTI_RAID=0`                  | 147/109/0 | 57.4% |          -17 |
| `BOT3_MULTI_BURST=0`                 | 134/119/3 | 52.3% |          -30 |
| `BOT3_MULTI=0` (round-2 policy)      | 127/127/2 | 49.6% |          -37 |

Reading: the burst economy is the layer (-30 wins without it), and **taking
rival ground during the burst is the single largest knob** (-17 without the
raid bonus): a captured rival plain is one income denied _and_ one income
gained for every remaining burst tick, so it is worth far more than the capture
score the serial policy gives it. The endgame contribution is small and comes
from _not_ walking into the rival line: a mass-scaled march toward the rival
crown (`marchGain 9`, the original default) costs 9 wins against the plain
distance penalty, and even that penalty is only worth 9 wins in total.

## Army at tick 50 decides the game (default config, 256 games)

| our army / rival army at tick 50 | games | win | our army | rival army | our land | rival land |
| -------------------------------- | ----: | --: | -------: | ---------: | -------: | ---------: |
| < 0.9x                           |    74 | 15% |      515 |        790 |       79 |         96 |
| 0.9x - 1.0x                      |    40 | 53% |      755 |        793 |       98 |         93 |
| 1.0x - 1.1x                      |    30 | 73% |      758 |        718 |       97 |         87 |
| 1.1x - 1.3x                      |    30 | 97% |      838 |        706 |      103 |         84 |
| >= 1.3x                          |    82 | 99% |      899 |        527 |      105 |         69 |

The losing half is not an endgame problem: when the burst race is lost, the
rival simply has 20-50% more army to convert. On the weak maps the loss is in
land, not in spending (maze/archipelago losses show 79 land against the
rival's 96 at tick 50), i.e. the expansion itself is slower there, not the raid.

## Full 2048-game matrix with the layer on

`1579W/359L/110T (77.1%)` against the recorded `1541/395/112 (75.2%)`, `+1.9pp`,
46 `lossToWin` against 8 `winToLoss`. All 32 serial cells are identical to the
baseline (`0.0pp`), and the multi cells gain `+118.8pp` in total, but **one cell
regresses**: `anti / archipelago / on(fog) / multi` is `31/1/0` against the
recorded `32/0/0` (`-3.1pp`, a single game). `BOT3_MULTI_BURST=0` restores that
cell to `32/0/0`, so the regression is a burst decision, not the endgame.

## Fog burst gate (round-3 combined screen)

The one regressing cell of the table above (`anti / archipelago / on(fog) /
multi`, `31/1/0` against `32/0/0`) is a burst decision, and no single burst knob
fixes it: `MERGE=0`, `MERGE=50/200`, `BURST_GAIN=0`, `OUTWARD=0`,
`OUTWARD_BASE=0`, `PAINT=0`, `FOCUS=0` and `BUILD=0` each stay at `31/32` and
only shuffle the lost game between seeds 2 and 15 (`RAID=0` is `30/32`). Only
`BURST=0` restores `32/32`.

That is why the layer now carries a fog gate: `burstFog` (default on) drops the
burst in a fog room while the leaderboard army is behind `burstFogLead`
(default 100, i.e. `army >= rivalArmy`). The condition is read per tick, so a
room that falls behind mid-burst reverts to the baseline planner for the rest
of the burst.

| configuration (1024 multi games) | Δ wins | cells below the round-2 baseline |
| --- | ---: | --- |
| no gate (`BOT3_MULTI_BURST_FOG=0`) | - | `anti/archipelago/fog+multi` `31` vs `32` |
| fog gate, lead 100 (**default**) | -5 | none |
| burst off in every fog room | -11 | `relay/random/fog+multi` `15` vs `16` |
| army-lead gate on the merge penalty | -10 | `anti/archipelago/fog+multi` still `31` |

So the gate trades the 4 relay fog wins the burst buys (`relay/random` 21 -> 17,
`maze` 19 -> 18, `archipelago` 18 -> 17) for turning the one losing cell into a
baseline-level cell. A map-specific gate (burst off on archipelago only) would
keep those wins but the protocol carries no map name and the board encodings do
not separate archipelago from random, so the state gate above is the narrowest
one that is actually available.

## Decision

The layer ships **on** (`BOT3_MULTI=0` restores the old path). With the fog gate the combined
matrix (`BOT3_MULTI=1 BOT3_FOG=1`) is `1617/349/82 (79.0%)` against
`1541/395/112 (75.2%)`, and the layer alone is `1579/359/110 (77.1%)`. It is a
clear gain on the relay
16-order rooms (`+14.5pp` over 256 games, `64.1%`) and a `+1.9pp` gain over the
full matrix, but it does not reach the 65% relay target in five of eight cells
and it costs one game in one cell of the full matrix. The default path must not
regress, so the switch stays off until either of those is fixed.

## Rejected mechanisms (kept behind switches, all off by default)

| mechanism                               | switch                                 | measured                                                               |
| --------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| mass-scaled march to the rival crown    | `BOT3_MULTI_MARCH`                     | `155/256` at 9, worse than the distance-only penalty                   |
| articulation cut bonus (isolation)      | `BOT3_MULTI_CUT`, `BOT3_MULTI_CUT_CAP` | `158/256` at 10, `152/256` at 40; `-6` wins                            |
| attack bonus after the burst            | `BOT3_MULTI_FOCUS_RAID`                | `159/256` at 300                                                       |
| mass merge bonus after the burst        | `BOT3_MULTI_MASS`                      | `152/256` at 3, `143/256` at 6                                         |
| skirmish penalty on rival plains        | `BOT3_MULTI_SKIRMISH`                  | `140/256` at 50, `141/256` at 100: attacking rival ground is not waste |
| paint ban after the burst               | `BOT3_MULTI_PAINT`                     | `163/256` at 0: the ban is worth one game                              |
| maze lane discipline (`BOT3_MAZE_LANE`) | -                                      | off by default and identical when enabled in multi rooms               |

`cut` is the one rejected mechanism that still looks promising on paper: the
isolation rule halves and then starves a severed branch, and a sixteen-order
tick can take an articulation cell that a serial room cannot afford. Measured,
the attacks it promotes are simply too expensive on clear boards (the rival
frontier is where their stacks are) and its best use needs the fog memory, which
the layer does not model yet.

## Risks and next steps

- **Sample size.** Each cell is 32 games, so one game is 3.1pp; a 56-59% cell is
  two or three wins short of 65%. Treat the per-cell numbers as a screen, not as
  a calibration.
- **Weak cells.** Archipelago and maze stop at 56-59% for every combination
  tried (raid, merge, build, paint, cut, outward, burst gain), and the tick-50
  land deficit on those maps points at the expansion shape, not at the score
  weights. A maze/archipelago-specific burst plan is the obvious next move.
- **Fog.** Clear relay cells reach 69% and 94%, fog cells 56-66%. The layer reads
  live `teams` only, so fog rooms lose the rival half of the burst race more
  often.
- **Endgame.** The layer prices the march but never plans one; `closing.js` is
  serial-only (`input.multi` returns early). A multi-aware column (chains in the
  engine queue advance one cell per tick while merging the garrisons they pass)
  is untested and is where the remaining margin probably is.

## 第 12–14 轮：镜像上限证据（rounds 12-14)

The upstream engine later removed the multi-line burst, and the rounds 12-14
experiments established that the remaining multi cells are a structural mirror
rather than a policy gap. Measured facts:

- **Perfect reflector.** Of 128 `(map, fog, seed)` pairs, every pair splits
  exactly one win per seat with an identical deciding tick; a deterministic,
  colour-symmetric policy therefore caps every multi cell at 50%.
- **Action supply is fixed.** A multi tick executes about six orders (`sent ==
  done`), roughly 1.4 army per land cell at t100 while an action needs two; the
  sixteen slots are never binding, and widening candidate lists or filling
  idle slots changed 0 games.
- **No economy lever.** Multi rooms have no burst, crowns are the only
  compounding income, and no cell ever reaches 50 army, so neither side builds
  a crown; `army@50` is fully determined by the land bound, which is already at
  18-23 of the maximum 24.
- **The crown is unreachable.** A 3+ stack adjacent to the rival crown appeared
  in 0 of 597 sampled ticks. A same-tick double push is legal and exactly
  priced (verified on the real engine), but only 1 tick in 128 games could form
  a pair.
- **Exact search does not help.** `msim.js` reproduces the real engine with 0
  mismatched ticks over ~380k cell-ticks, and `mqueue.js` predicts relay's
  order batch on 2917/2917 frames, yet a one-ply search deviates on only 3.5%
  of ticks and measures -1.2pp; weight sweeps (`MARCH`, `CROWN`, `MARGIN`,
  `SIMS`) are identical.
- **Measured negatives.** focus/paint, second-crown banking, synchronised
  waves, isolation/cut, parity contest (+2.7pp, inside noise), slot filling,
  double push/staging, timed crown rush (-6 to -10 wins), turtle/counter
  (49.6%, best cell 53.1%).

Breaking the mirror would require a strictly stronger multi policy (for example
a 2-3 ply search with a self-play-tuned evaluation), not a differently weighted
version of the current scoring. `msim.js`/`mqueue.js` are kept as the exact
model and predictor for such an attempt.

## 第 15–16 轮：默认层与新的引擎事实（rounds 15-16)

Rounds 15-16 ran nine experiments against the mirror. Two rules measured positive
with a clean 2048-game matrix and now ship **on**:

- `mshape.js` (`BOT3_MSHAPE`, `SLOTS=64 STEAL=100 LEAD=110`): the inherited
  sixteen-order cap only binds on growth-pulse ticks (t=49/99/..., where the
  planner projects the +1 and 40+ candidates appear) — lifting it there is worth
  +7 wins / 256; and a plain merge that ranks above a capture costs **two** ticks
  (the engine does not run a move whose source is another order's target, and
  `strategy.js` skips planning while its queue is non-empty), so it is demoted.
- `mhalf.js` (`BOT3_MHALF`): a capture needs **three** army (an all-in push is
  `army-1` and must strictly beat the garrison), so a merge that fills a ring
  cell which cannot fire this tick and reaches three army from behind the ring
  ranks first; a delivery that leaves the ring one army short is capped below the
  cheapest capture.

Result: relay multi cells `123 -> 136` of 256 (one cell, random clear, now passes
65 %), full matrix `1688 -> 1702` with zero cell regressions. The remaining seven
cells are still 46.9-59.4 %, because the mirror needs a *biased* policy (winning
from both seats) and these layers only add ~+5 pp.

New engine facts measured in those rounds: multi-feed (several orders into one
target cell per tick) is legal but the planner forbids it; own merges are only
proposed when they strictly reduce `frontDist`, so **lateral frontier→frontier
merges are never candidates**; the frontier ring cannot be pre-armed (a fed ring
cell captures next tick and drops back to one army), so pulse output is limited by
**ring width**, not by the army pool; and `strategy.js`'s pending gate never skips
a tick in practice. Measured negatives (vault crowns, mass columns, attrition
pricing, pulse staging, fog doctrine, latched-head stacks, 1-ply search) are
recorded in [ROUND16-ROUNDUP.md](ROUND16-ROUNDUP.md).
