# Round 20 — the corridor multi-line layer (`BOT3_MAZERUSH`)

The four remaining relay multi-line cells are the ones the shipped stack does not
touch: `./mshape` and `./mhalf` both stand down on a corridor (`isMazeBoard`),
the three-tick search only predicts in a **clear** 1v1 room, and the corridor
front planner (`./maze`) is `clearSerial` only. On a maze multi room the planner
therefore runs the plain sixteen-order expansion policy. This round measured
that board instead of guessing at it, and built one layer for it.

**Result: no full-matrix regression, and the two maze multi cells move, but the
round's bar (both cells at 21/32) is missed by one game each.**

| cell | shipped (32 games) | with `BOT3_MAZERUSH=1` | Δ |
| --- | ---: | ---: | ---: |
| relay / maze / clear / multi | 18/13/1 | **20/12/0** | +2 |
| relay / maze / fog / multi | 16/16/0 | **20/12/0** | +4 |

Replicated on an independent seed block (`bot3-baseline-17..32`, 32 games per
cell, same baseline 18/16): clear **19**/32 (+1), fog **17**/32 (+1). Combined
over 64 games per cell: clear 39/64 (+3), fog 37/64 (+5). Everything else is
byte-identical (below).

## What the board actually is

`data/scratch/jprobe.cjs` plays one maze game in-process and reads the **grid
ground truth** from the engine (`engine.owner` / `engine.armyCnt` /
`engine.gridType`), so a fog room is measured on the real board, not on vision.

* The generator makes a spanning tree and then adds ~3% extra openings: measured
  **101 passable cells with 106 edges** (6 cycles), so the round-19 "tree" is a
  near-tree. Degrees are seed-dependent (`{1:6, 2:79, 3:16}` on
  `bot3-baseline-4`, i.e. 16 junctions on that seed).
* Both generals sit at opposite ends of one trunk (33 hops on that seed). The
  map is **the same board for both seats**; only the team assignment rotates, so
  one seat owns the crown that is closer to the bulk of the tree. The other seat
  is the "bad" one.
* `opening.js` is **byte-identical to `relay-bot/opening.js`**, and the opening
  is the same exact search on both seats. Measured over 128 games, the t24 land
  delta already separates the eventual winner from the loser (+1 for wins, -2
  for losses) and the t50 delta is +4 / -5. In the 64 clear games of the final
  config, **46 games have a t100 land delta of |d| >= 5 and 42 of them end with
  the sign of the delta** (25 positive: 24 wins; 21 negative: 18 losses). The
  four exceptions are two wins from -11 / -13 and one loss from +5, plus a -6
  win. The 18 games inside |d| <= 3 split 12-6. The cell is decided by the
  opening's Voronoi split, which is geometry, not policy.
* On a corridor the army cannot arrive faster. A cell with one army cannot push
  at all (`computePush` caps a move at `total - 1`), and the engine blocks a
  queued move whose source is another queued move's target, so a lane cell can
  send at most once per two ticks (send, then receive, then send). Measured on
  `bot3-baseline-4` seat 1 over 293 ticks: **1984 merges, 47 captures, 87
  attacks, 2118 orders** - the tick is spent shuffling army, not converting it.

The probe also shows exactly where the conversion stalls. The ring is 3-6 cells
wide and the last-link cells (hop 1) are dry:

| quantity (293 ticks) | value |
| --- | ---: |
| ring cell-ticks | 882 |
| ring cell-ticks with >= 2 army | 260 |
| ticks where a hop-1 cell *could* feed a short ring cell | 179 (0.61/tick) |
| of those, actually fed by the planner | 147 (**82%**) |

So the planner is not choosing badly at the last hop (82% conversion); there is
nothing to send. The packets are spread uniformly along a 20-30-cell lane, which
is what caps the front at one army per two ticks per lane.

## What the layer does

`mazerush.js`, gated on `isMazeBoard && multi`, default off
(`BOT3_MAZERUSH=1` turns it on). It is a bundle of four measured mechanisms:

1. **lane** (default on inside the layer): allow the `./mhalf` corridor routing,
   i.e. the hop field that re-ranks own merges toward the ring and the reload
   bonus that arms a ring cell. Alone this is the round-16 layer applied to the
   corridor, and it measures +1 clear / +3 fog over 64 games.
2. **hold** (`BOT3_MAZERUSH_HOLD`, ships 20): a near-front merge into a ring
   cell that faces a **rival stack** is worth `hold * (1 + junction) *
   min(4, threat)` - the cell is a door, and a degree >= 3 cell is a door with
   two feeding lanes. Scores at or above 300 (defence, rescue, sieges) are never
   re-priced. Clear-room optimum; larger values (40, 50) measure identical.
3. **sideways** (ships 1 in clear rooms, 0 in fog): the `./mhalf` same-hop merge
   cap, passed through the layer so one switch owns the whole corridor stack.
4. **branch** (`BOT3_MAZERUSH_BRANCH`, ships 5, **fog only**): hand the number of
   distinct corridor branches to the existing `./fog-maze` multi-line branch
   objective (`BOT3_FOG_MAZE_BRANCHES`, shipped 0). A fogged corridor has no
   objective field at all (`targets` is empty until a crown is touched, so
   `goal` is infinite), and the branch objective is what makes the sixteen
   orders spread onto different lanes and grow vision. It is **catastrophic in
   clear rooms** (clear 12/32) where the crown field already exists, which is why
   the override is fog-gated.

Everything else in the module is a measured negative kept behind a switch:
`feed` (appended multi-feed into the ring), `pump` (arm the cell behind the
ring), `seal` (price a rival junction by the branch it cuts) and `rush`
(concentrate the lane on the main line while behind on land). See the negative
table.

## Measured matrix

Baseline and candidate are the same 32 games per cell, paired on
`(opponent, map, fog, multi, seed, seat)`. All runs: `OPPONENTS=relay MAPS=maze
MODES=001,011 WORKERS=4`.

| block | config | clear | fog | total |
| --- | --- | ---: | ---: | ---: |
| 1..16 | shipped | 18/13/1 | 16/16/0 | 34/29/1 |
| 1..16 | `BOT3_MAZERUSH=1` | **20/12/0** | **20/12/0** | **40/24/0** |
| 17..32 | shipped | 18/13/1 | 16/16/0 | 34/29/1 |
| 17..32 | `BOT3_MAZERUSH=1` | **19/13/0** | **17/14/1** | 36/27/1 |
| 1..32 | shipped | 36/26/2 | 32/32/0 | 68/58/2 |
| 1..32 | `BOT3_MAZERUSH=1` | **39/25/0** | **37/26/1** | **76/51/1** |

Full matrix (2048 games, `WORKERS=8`): **1744/250/54 (85.2%)** against the
recorded **1739/254/55 (84.9%)**, +5 wins. Per cell, the only relay cells that
move are the two maze multi cells above; all anti and apex cells and every
relay non-maze cell are identical. Two `v2` single-line cells flick by one game
in the 8-worker run - `v2` (Bot 2.0) is wall-clock-budget sensitive, and two
identical reruns of the same 512-game `v2` sweep differ in 4 rows, so that is
harness noise, not this layer (the layer cannot run outside `isMazeBoard &&
multi`).

Relay multi-line screen (256 games, four maps, fog on/off): **179/256 (69.9%)**
against the shipped **173/256 (67.6%)**.

Byte-identity when off: `OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean
MODES=001,011 SEED_FROM=1 SEED_TO=16 WORKERS=8` was rerun with the switch unset
and diffed row-for-row against `baseline-results.jsonl` - **256/256 rows
identical**, including ticks and checkpoint arrays.

## Why the last win is not there

The matrix bar is 21/32. This layer reaches 20/32 in both cells on the matrix
block and 19/32 (clear) / 17/32 (fog) on the confirmation block. The evidence
says the missing win is not a scoring bug:

* the opening is the same code as relay's, so the t24-t100 land split (which
  predicts the result in 60 of 64 games) cannot be changed from the endgame;
* the corridor front is throughput-bound at one army per two ticks per lane
  (82% of the available feeds are already taken), so no merge re-ranking can
  deliver a burst;
* every mechanism that tries to create a burst instead - multi-feed, a junction
  rush, a seal, a rear vault - either has no source to spend (feed: 0-1
  opportunities per tick because the base batch already uses every armed cell)
  or costs the land race (rush, seal, and round 19's bank).
* the mechanism that does work in fog (the branch objective) gains +5 over 64
  games, but the same knob makes clear rooms collapse, so it cannot be used on
  both cells at once.

The two cells are therefore documented as **+2 / +4 on the matrix and +1 / +1 on
the confirmation block**, one game short of the bar in each. The switch is
default-off and the two cells are the only ones it can move.

## Negative table

All rows are `OPPONENTS=relay MAPS=maze`; "64" means seeds 1..32 (64 games per
cell), "32" means seeds 1..16 (the matrix block). Baselines are 18/16 (32) and
36/32 (64).

| variant | clear | fog | verdict |
| --- | ---: | ---: | --- |
| `BOT3_MHALF_CORRIDOR=1` (lane alone) | 37/64 | 35/64 | +1/+3, not enough |
| lane + `MHALF_RETAIN=1` | 20/32 | 17/32 | rolling garrison loses the front |
| lane + `MHALF_RETAIN=2` | 18/32 | 15/32 | worse |
| lane + `MHALF_MIN_FIRE=4` | 21/32 | 14/32 | clear passes, fog collapses |
| lane + `MHALF_MIN_FIRE=2` | 17/32 | 17/32 | a 2-army ring cannot take a 1-army rival |
| lane + `MHALF_SIDEWAYS=1` | 19/32 | 20/32 | fog gain, clear loss |
| lane + `MHALF_SIDEWAYS=1 + HOP=3` | 21/32 | 18/32 | block-1 only, block-2 15/15 |
| lane + `MHALF_SIDEWAYS=1 + HOP=10` | 16/32 | 18/32 | deep convoy, clear collapse |
| lane + `MHALF_CONVOY=30` | 20/32 | 18/32 | neutral |
| lane + `MHALF_STALE=0` | 20/32 | 19/32 | identical to the default stale |
| lane + `MHALF_LEAD=100` (stand down when ahead) | 18/32 | 16/32 | the gain is not only in bad seats |
| lane + `MHALF_LEAD=95` | 19/32 | 16/32 | no |
| `mshape` on the corridor (slots 64) | 15/32 | 18/32 | -3 clear / +2 fog |
| `mshape` slots only (`STEAL=0 LEAD=0`) | 16/32 | 18/32 | the 16-order cap is protective on a corridor |
| `mshape CAPTURE=20/50/100` (slots 16) | 15/32 | 17-18/32 | painting more loses the front |
| `BOT3_MULTI=1` (focus/cut layer) | 30/64 | - | -6 over 64, the focus field is the wrong shape |
| `BOT3_M3PLY=0` | 16/32 | 16/32 | the search is worth +2 clear even at 5 adoptions/273 ticks |
| `M2PLY LAND=2/3`, `MARGIN=0`, `FEEDS=6`, `NEED=2`, `RING=3` | 34-37/64 | 32/64 | the search adopts 5 times in 273 ticks, knobs cannot matter |
| `feed=1/2` (appended multi-feed) | 31/64 | 34/64 | the base batch already uses every armed cell |
| `feed` allowing base sources (queue the base order instead) | 31/64 | 34/64 | same, and it delays real captures |
| `pump=40` (arm the cell behind the ring) | 19/32 | 16/32 | 82% of the opportunities are already taken |
| `hold=40/50`, `holdCap=12` | 39/64 | 37/64 | identical to hold=20: the bonus saturates |
| `holdPlus=1` (target = threat + 1) | 38/64 | 31/64 | over-armouring costs the counterattack |
| `seal=20` (price a rival junction by its cut) | 36/64 | 32/64 | the near-tree's 6 cycles reconnect every branch |
| `rush=50` (concentrate on the main line while behind) | 36/64 | 32/64 | neutral; the anchor is re-fed by one cell only |
| `fog_mape BRANCHES=2/4/6` without the layer | 12-14/32 | 15-16/32 | catastrophic in clear (the override must be fog-gated) |
| `fog_mape BRANCHES=3..8` + lane | - | 37/64 | the shipped fog mechanism (+5) |
| `fog_mape BRANCH=60/130` | - | 35-36/64 | the default 90 is the best point |

## Switches

| variable | default | meaning |
| --- | --- | --- |
| `BOT3_MAZERUSH` | off | the whole corridor multi-line layer |
| `_LANE` | 1 | allow the `./mhalf` corridor routing |
| `_HOLD` / `_HOLD_CAP` / `_HOLD_PLUS` | 20 / 8 / 0 | threatened-ring merge price, its target cap and offset |
| `_SIDEWAYS` | 1 | `./mhalf` same-hop merge cap (forced 0 in fog) |
| `_BRANCH` | 5 | fog corridor branch count handed to `./fog-maze` (0 = off) |
| `_FEED` / `_FEED_TARGET` / `_FEED_ORDERS` | 0 / 1 / 6 | appended multi-feed into a starved ring cell |
| `_PUMP` | 0 | price arming the cell behind the ring |
| `_SEAL` / `_SEAL_CAP` | 0 / 400 | price a rival junction by the branch it cuts |
| `_RUSH` / `_RUSH_MIN` / `_RUSH_BEHIND` | 0 / 2 / 100 | concentrate on the main line while behind on land |
| `_MIN_FIRE` | 2 | army that makes a ring cell a useful spend |
| `_LEAD` / `_START` / `_END` / `_BOARD` | 0 / 0 / 0 / 800 | gates |
| `BOT3_MAZERUSH_TRACE` | off | per-tick `[mazerush]` line on stderr |

The layer is also inert outside a multi-line room, outside `isMazeBoard`, and
over `BOT3_MAZERUSH_BOARD` cells; when the switch is off no state is allocated
(`board.mazerush` stays undefined) and the planner path is byte-for-byte the
shipped one.

## CPU

`data/scratch/mazerush-bench.cjs` on a 13x17 snake corridor (221 cells, 95
passable): the field (ring, hop, degree, threat; one BFS) is **8.3 us/tick** and
the whole layer (config + field + scoring + appended orders) is **14.5
us/tick**. The three-tick search it coexists with measures ~6.8 ms/tick on the
same board, so the layer is free.

## Reproduction

```sh
cd bot-template/relay-bot
# matrix block, both cells, 64 games per cell
BOT3_MAZERUSH=1 OPPONENTS=relay MAPS=maze MODES=001,011 SEED_FROM=1 SEED_TO=32 \
  WORKERS=4 OUT=/tmp/mazerush.jsonl SUMMARY=/tmp/mazerush.json \
  node ../../bot-template/relay-bot/training/evaluate-matrix.cjs
NO_GATE=1 node ../../bot-template/relay-bot/training/compare.cjs /tmp/mazerush.jsonl
# confirmation block: SEED_FROM=17 SEED_TO=32 against a default-config baseline
# full matrix (2048 games, ~10 min at WORKERS=8)
BOT3_MAZERUSH=1 WORKERS=8 OUT=/tmp/full.jsonl SUMMARY=/tmp/full.json \
  node ../../bot-template/relay-bot/training/evaluate-matrix.cjs
# unit tests
node --test strategy.test.cjs
```

The probes used for this round live in `data/scratch/` (ignored):
`jprobe.cjs` (per-tick junction/ring/hop/pump trace on ground truth) and
`mazerush-bench.cjs` (CPU). `jprobe.cjs` also prints the engine's executed
orders classified against the pre-tick owner snapshot, which is how the
"0.61 opportunities per tick, 82% converted" numbers were taken.
