# Round 19 — keep the crown bank, gate it by measured geometry (`BOT3_BANKGATE`)

`bankgate.js` is round 18's rear-army crown bank (`mcrown2`) with the one thing it
was missing: a **discriminator measured from the board** instead of a guess. The
round-18 layer earns +42 wins on 512 relay multi games and loses the full matrix
because it also runs where the rear army is not stranded: on an open random board
the army behind the ring is a *pipe* to the frontier, so redirecting it starves
the land race (t100 land 60 against 95) and the cell regresses 5-7 wins. The
planner never receives a map name, so this round measured the geometries that
separate a reservoir from a pipe, gated the pick on them, and re-validated on top
of the shipped three-tick search.

**Result: the switch now clears the round's full-matrix bar — +26 wins and zero
regressed cells.** It ships **on** (`BOT3_BANKGATE=1` is the default) because no
cell in the 2048-game matrix is below its paired baseline, and the new
`147 x 2` game evidence (screen + independent half) is positive in every cell
except the ones the bank cannot reach (maze, random).

## Mechanism (inherited from round 18, unchanged)

The round-17 census says the army is not where the frontier is: at t50-250 the
ring holds ~21 army, hop1-3 another ~41, and **hop4+ 61** (188 by t300), while
the land race is over by t100-150. A multi-line crown pays +1 army per tick
forever. So the layer:

1. **vault** — the outlet of the rear basin (own cells at `hop >= 3`) that holds
   the most stranded army, `safe` hops from any visible rival cell,
   `cut[i] === 0` deliberately *not* required (an articulation is exactly what
   holds a rear basin).
2. **gather** — every own rear merge the planner already emits is re-pointed one
   hop down a BFS field toward the vault (the redirect, not the appended order,
   is the channel).
3. **multi-feed** — up to `FEED` merges per tick are appended after the matching
   loop (and after the three-tick search's adopted set), with the engine's
   chain rules enforced.
4. **build** — city at 50 army, crown at the next 50.
5. **stand down** — a crown stops taking army; the planner routes its +1 forward.

Nothing touches hop 0-2, so the exchange keeps its army.

## What is new: the discriminator

`geometry()` runs every tick and measures, from the visible board only:

| quantity | meaning |
| --- | --- |
| `demand` | neutral **plains** adjacent to our territory (`200`, visible only) — income land the frontier can take next tick |
| `demandSwamp` | neutral swamps adjacent to us (land that pays no income) |
| `hop0..hop4` | army at each hop from the ring (`live`, i.e. not isolated) |
| `rear` | army at `hop >= HOP` — the reservoir the layer banks |
| `swampShare`, `mountainShare` | the two observable board shapes whose frontier cannot convert army into income |
| `ring` | width of the frontier ring (`frontDist === 0`) |
| `articulations` | own cells with `cut > 0` (corridor-ness) |
| `plains` | visible neutral plains left on the whole board |
| `nearEnemy` | own cells within 4 hops of a visible rival |
| `land`, `enemyLand`, `army`, `enemyArmy` | leaderboard reads (exact even in fog) |

Probe: `data/scratch/bankgate-probe.cjs` plays relay/anti multi games in-process
and dumps every tick's geometry plus the bank's own pick row, joined to the game
result by `(seed, map, fog, seat)`. `data/scratch/bankgate-analyze.cjs` prints the
medians and the 10-90 percentile band per map and turn bucket.

### The measured table (relay multi, clear, seeds 1-8 × 2 seats, bank off)

Median, with the 90th percentile of `demand` in brackets. `t40-50` is the tick
the layer looks at (the opening branch returns before t50, so the first possible
pick is t50).

| map | tick | demand | p90 | demandSwamp | rear | hop4 | ring | swamp | mountain | plains | articul. | land | rival land |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| random | t40-50 | **11** | 14 | 1 | 20 | 15 | 10 | **0.08** | 0.13 | 109 | 6 | 38 | 39 |
| random | t51-60 | **12** | 15 | 2 | 46 | 36 | 13 | 0.08 | 0.13 | 61 | 7 | 64 | 62 |
| mediterranean | t40-50 | **4** | 5 | 8 | 17 | 11 | 10 | **0.47** | 0.03 | 57 | 3 | 40 | 40 |
| mediterranean | t51-60 | 4 | 6 | 11 | 35 | 25 | 14 | 0.47 | 0.03 | 39 | 4 | 62 | 60 |
| archipelago | t40-50 | **3** | 5 | 12 | 13 | 6 | 13 | **0.65** | 0.10 | 32 | 5 | 41 | 41 |
| archipelago | t51-60 | 3 | 5 | 14 | 27 | 18 | 15 | 0.65 | 0.10 | 22 | 6 | 60 | 60 |
| maze | t40-50 | 3 | 5 | 1 | 33 | 30 | 3 | 0.08 | **0.54** | 32 | **22** | 31 | 31 |
| maze | t51-60 | 2 | 4 | 1 | 61 | 55 | 4 | 0.08 | 0.54 | 15 | 26 | 42 | 42 |

The separation is wide and causal: `demand` (income land next door) is 11-12 on
open boards and 3-4 on wet ones, `swampShare` is 0.08 against 0.36-0.67, and a
corridor board is recognisable by `mountainShare` 0.54 and `articulations` 22.
The fog probe (seeds 1-4, fog) gives the same picture - random 0.10 swamp /
demand 13, mediterranean 0.47 / 4, archipelago 0.66 / 3 - because swamp and
mountain are visible through the fog and unseen cells are excluded from `demand`.

The second discriminator is the land race itself. At the first pick:

| scope | our land / rival land | p10 | p90 |
| --- | ---: | ---: | ---: |
| relay random | 0.94 | 0.82 | 1.02 |
| relay archipelago | 0.98 | 0.90 | 1.02 |
| relay mediterranean | 1.00 | 0.86 | 1.03 |
| **anti / archipelago** | **1.25** | 1.05 | 1.60 |

`anti/archipelago/clear/multi` is the one full-matrix cell round 18 regressed
(32/32 -> 22/32), and it is also the room where the bot is already *winning the
land race* when the bank opens. A crown is a comeback investment, so the pick is
also gated on `land <= rival land * LAND / 100`.

## The gate

Every clause is a board measurement; the defaults are the shipped values.

| clause | default | rule |
| --- | --- | --- |
| `DEMAND` | 5 | `demand <= 5` — the frontier has no income land left to take |
| `SWAMP` / `MOUNTAIN` | 25 / 0 | at least one terrain clause: `swampShare >= 25%` **or** `mountainShare >= MOUNTAIN%` (a corridor board must opt in *by measuring* wet/corridor) |
| `LAND` | 95 | `land * 100 <= rival land * 95` — do not bank a land race already won |
| `BEHIND` | 100 | `army * 100 < rival army * 100` (inherited, pick-time only) |
| `REAR` / `RISE` | 0 / 0 | optional reservoir clause: absolute hop >= HOP army and its growth over `WINDOW` ticks |
| `CORRIDOR` | off | corridor rooms stay gated out by default; `MOUNTAIN=40 CORRIDOR=1` lets a measured corridor board through (measured negative, see below) |
| `RELEASE` | off | self-limiting release, see below |

The gate is checked **when the vault is picked**, never per tick: re-picking on
every drift throws a half-filled bank away (round 18: `START=150` lost 30pp).

## Measured

Relay multi cells, 32 games each (seeds 1-16 for the screen, 17-32 independent).
`BOT3_M3PLY=1 BOT3_BANKGATE=1` reproduces them exactly; every number below is a
paired comparison (the independent half is compared against its own off run at
the same commit).

Important fact found this round: `mqueue.predict` arms only when `BOT3_M3PLY` is
present in the environment (`mqueue.js` `enabled()` reads the raw variable), so
"the shipped three-tick search" in practice means `BOT3_M3PLY=1`. Without the
variable the screen is 136 (the round-18 base) and the recorded
`baseline-results.jsonl` is the armed matrix. Every measurement here therefore
runs with `BOT3_M3PLY=1` unless it says "bank alone".

### Screen, seeds 1-16 (256 games)

| cell | candidate | baseline | Δ |
| --- | --- | --- | ---: |
| archipelago clear | 21/11/0 | 17/15/0 | +12.5pp |
| archipelago fog | 18/14/0 | 15/16/1 | +9.4pp |
| maze clear | 18/13/1 | 18/13/1 | 0.0pp |
| maze fog | 16/16/0 | 16/16/0 | 0.0pp |
| mediterranean clear | **30/1/1** | 21/9/2 | +28.1pp |
| mediterranean fog | **27/3/2** | 17/14/1 | +31.3pp |
| random clear | 22/10/0 | 22/10/0 | 0.0pp |
| random fog | 17/15/0 | 17/15/0 | 0.0pp |
| **total** | **169/83/4 (66.0%)** | 143/108/5 (55.9%) | **+10.2pp** |

### Independent half, seeds 17-32 (256 games, paired against my own off run)

| cell | candidate | baseline | Δ |
| --- | --- | --- | ---: |
| archipelago clear | 16/13/3 | 15/13/4 | +3.1pp |
| archipelago fog | 17/13/2 | 15/15/2 | +6.3pp |
| maze clear | 18/13/1 | 18/13/1 | 0.0pp |
| maze fog | 16/16/0 | 16/16/0 | 0.0pp |
| mediterranean clear | 27/3/2 | 23/7/2 | +12.5pp |
| mediterranean fog | 23/5/4 | 12/15/5 | +34.4pp |
| random clear | 22/10/0 | 22/10/0 | 0.0pp |
| random fog | 15/17/0 | 15/17/0 | 0.0pp |
| **total** | **154/90/12 (60.2%)** | 136/106/14 (53.1%) | **+7.0pp** |

Both halves agree in sign and shape: mediterranean/archipelago gain,
maze and random are **byte-identical** to the baseline (the gate never opens
there). 512 games: candidate 323, baseline 279, **+44 wins (+8.6pp)**, zero
regressed cells.

### Full matrix (2048 games), `BOT3_M3PLY=1 BOT3_BANKGATE=1`

`1735/259/54 (84.7%)` against the recorded `1709/284/55 (83.4%)` — **+26 wins,
zero cells below their paired baseline, four cells changed in total**:

| cell | candidate | baseline | Δ |
| --- | --- | --- | ---: |
| relay / archipelago / clear / multi | 21/11/0 | 17/15/0 | +12.5pp |
| relay / archipelago / fog / multi | 18/14/0 | 15/16/1 | +9.4pp |
| relay / mediterranean / clear / multi | 30/1/1 | 21/9/2 | +28.1pp |
| relay / mediterranean / fog / multi | 27/3/2 | 17/14/1 | +31.3pp |

Every other cell is byte-identical. The anti/archipelago regression of round 18
(32/32 -> 22/32) is **gone** (32/32): the land gate gives that room back.

### Bank alone against bank + search

| scope (seeds 1-16, 256 games) | wins | Δ vs its own base |
| --- | ---: | ---: |
| base without the search (`BOT3_M3PLY` unset) | 136 | — |
| bank alone (`BOT3_BANKGATE=1`, search off) | **158** | +22 (+8.6pp) |
| base with the three-tick search (`BOT3_M3PLY=1`) | 143 | — |
| bank + search (shipped) | **169** | +26 (+10.2pp) |

The two layers are additive: bank alone +22, search alone +7 (round 18), both +26.
The search does not veto the bank turns - the bank's redirect happens in the
candidate set before the search prices it, and its gather/build orders are
appended after the adopted set (so the crown work rides along with a searched
tick). That is the measurement the brief asked for: the search prices land as
income, and it still leaves the mediterranean/archipelago bank intact.

## The self-limiting release (measured inert or negative, off by default)

Two rules are implemented and switched by `BOT3_BANKGATE_RELEASE`:

- **(a) the bank cannot be held** — after `RELEASE_GRACE` (40) ticks the vault's
  peak army is still below `RELEASE_FILL` (20). This is round 18's "a bank you
  cannot hold does not fill" failure. Measured with the gate deliberately
  loosened (`SWAMP=0`, so random banks): 160/256 against 159/256 without it, and
  random stays 17/15 and 12/20 either way - **inert**, because with the basin
  pick the vault does fill, the loss is the starved frontier, not a dead bank.
- **(b) the starved land race** — the frontier starved (`demand > 3`) for six
  consecutive ticks and our land behind the rival's: 148/256, with mediterranean
  giving back 6 wins (23/22 against 28/29). **Negative**: it releases healthy
  mediterranean banks because a banking empire is *supposed* to trail on land
  while the crown compounds. At `demand > 8`, `gap 8` it never fires (byte
  identical).

The switch therefore ships **off**: the pick-time discriminator is what removes
the loss mode, and the release rules are kept (with unit tests) so both measured
negatives are reproducible. The direction's "abort when land growth falls behind
the base trajectory" is exactly rule (b) and it is tabulated as a negative.

## Negatives and variants (256-game screen, seeds 1-16, `BOT3_M3PLY=1`)

| variant | wins | Δ vs 143 | note |
| --- | ---: | ---: | --- |
| ungated bank (`GATE=0`, round 18 on top of the search) | 146 | +1.2 | random 17/10 (-15.6/-21.9pp): the round-18 failure reproduces |
| demand-only gate (no terrain clause) | 159 | +6.3 | random 17/12: the gate only *delays* the random bank to t80-100, the loss stays |
| demand + terrain, `REAR=30` | 169 | +10.2 | indistinguishable from the shipped `REAR=0` (one game) |
| demand + terrain + `LAND=105` | 170 | +10.5 | screen is one win better, but anti/archipelago falls 32 -> 29 |
| demand + terrain + `LAND=100` | 170 | +10.5 | anti/archipelago 31/32 |
| **shipped: demand 5 + swamp 25 + land 95** | **169** | **+10.2** | anti/archipelago 32/32, the only variant with a clean full matrix |
| `CORRIDOR=1 MOUNTAIN=40` (bank the maze) | maze 24/64 | -15.6pp | corridor boards hold a huge reservoir (rear 33, hop4 30) but banking them loses 11 wins: the corridor is the only route to the front, a bank there is a plain starvation |
| `OUTLETS=3` | 144 | +0.4 | almost inert, exactly like round 18's `OUTLETS=1`: the basin filter removes the pick |
| `CROWNS=2` | 131 | -4.7 | second bank is filled from the exchange, reproduces round 18 (-12pp) |
| `BEHIND=0` (start even while ahead on army) | 170 | +10.5 | same total, wrong shape: mediterranean 29/31, archipelago 19/18 |
| `GAIN=200` | 170 | +10.5 | identical (the redirect already wins every price comparison it needs) |
| `FEED=8`, `KEEP=3`, `SAFE=2`, `HOP=2` (archipelago) | 64 | 0.0 | byte-identical on the archipelago cell: these knobs do not bind |
| `RELEASE=1` (fill rule, loose gate) | 160 | +6.6 | inert (see above) |
| `RELEASE=1 RELEASE_DEMAND=3 GAP=0` | 148 | +2.0 | negative, mediterranean 23/22 |
| no state when off | — | — | 256-game screen off-path is byte-identical to the recorded matrix |

## The honest ceiling

The 21/32 bar is met on mediterranean clear (30), mediterranean fog (27) and
archipelago clear (21), and the two random cells keep their shipped values
(22/17) but are **not** at 21 fog / 21 clear; the two maze cells are 18/16 and
16/16.

1. **maze is structurally out of reach for this direction and the negative is
   measured, not assumed.** A corridor board has the strongest reservoir in the
   game (hop4 30 at t50, ring 3, 22 articulations), and allowing the bank there
   (`CORRIDOR=1 MOUNTAIN=40`, which the geometry gate does pass) loses 11 wins in
   64 games. There is exactly one route to the front, so the redirect starves it
   directly.
2. **random fog/clear cannot be raised by this layer, only left alone.** The
   random cells are 22/17: banking a dry open board always costs land (round 18
   -15.6/-21.9pp) and no measured sub-gate fixed it (demand-only: still -15.6).
   The honest policy is the shipped one: never open there, stay byte-identical.
3. **archipelago fog 18/32** is the remaining gap in a cell the layer does
   improve (+9.4pp on the screen, +6.3pp independent). Every knob that could
   change it (`FEED`, `KEEP`, `SAFE`, `HOP`, `GAIN`) is byte-identical on that
   cell, so the limit is the layer's shape, not its tuning: the vault fills to 50
   and 100 army from merges that would have gone forward anyway, and the
   archipelago game is decided before the crown repays its 100 army.

## CPU

One core, 20x20 board, `bankgate.js` measurement micro-benchmark:

| step | cost |
| --- | ---: |
| `geometry()` (every planning tick) | 0.012 ms |
| `scanVaults()` (only while no vault is active) | 0.11-0.41 ms |
| `ownField()` per active vault (every tick) | 0.016 ms |

For scale, round 18 measured the three-tick search at 8.21 ms per tick, so the
gate costs under 5% of a searched tick and is itself O(size) on the ticks that
matter.

## Configuration

Every knob is read on each call, clamped, and inert unless `BOT3_BANKGATE` is
on. With the switch off `planner.js` is byte-identical to the shipped code (the
256-game screen jsonl diffs clean against the recorded matrix).

| variable | default | meaning |
| --- | ---: | --- |
| `BOT3_BANKGATE` | **on** | enable the layer (multi-line rooms only) |
| `BOT3_BANKGATE_GATE` | on | enable the round-19 discriminator (`0` = round-18 behaviour) |
| `BOT3_BANKGATE_DEMAND` | 5 | income land the frontier may still have before the bank may open |
| `BOT3_BANKGATE_SWAMP` | 25 | percent swamp required (with `MOUNTAIN`) |
| `BOT3_BANKGATE_MOUNTAIN` | 0 | percent mountain required (corridor opt-in) |
| `BOT3_BANKGATE_LAND` | 95 | our land as a percent of the rival's at the pick |
| `BOT3_BANKGATE_REAR` | 0 | army at hop >= HOP required at the pick (`0` = off) |
| `BOT3_BANKGATE_RISE` / `_WINDOW` | 0 / 40 | rear-army growth required over the window (`0` = off) |
| `BOT3_BANKGATE_BEHIND` | 100 | only start while our army is below this percent of the rival's |
| `BOT3_BANKGATE_RELEASE` | off | enable the self-limiting release |
| `BOT3_BANKGATE_RELEASE_FILL` / `_GRACE` | 20 / 40 | a vault below this peak army after this many ticks is given back |
| `BOT3_BANKGATE_RELEASE_DEMAND` / `_TICKS` / `_GAP` | 0 / 6 / 8 | opt-in starved-land-race release (`0` = off) |
| `BOT3_BANKGATE_HOP` | 3 | minimum hop from the ring for vault and donors |
| `BOT3_BANKGATE_START` / `_END` | 44 / 0 | planning tick window |
| `BOT3_BANKGATE_SAFE` | 3 | hops between the vault basin and the nearest visible rival cell |
| `BOT3_BANKGATE_GAIN` | 110 | score added to a merge that steps down the vault field |
| `BOT3_BANKGATE_FEED` / `_MIN` / `_CAP` | 4 / 2 / 110 | appended merges per tick, army a donor keeps, stop feeding at |
| `BOT3_BANKGATE_CROWNS` | 1 | vaults to crown (`2` is a measured negative) |
| `BOT3_BANKGATE_KEEP` | 0 | garrison pinned on a finished crown |
| `BOT3_BANKGATE_BASIN` / `_OUTLETS` | 12 / 8 | army a basin must hold, shallow ways out it may have |
| `BOT3_BANKGATE_BUILD` / `_FOG` / `_CORRIDOR` | on / on / off | room gates |
| `BOT3_BANKGATE_PROBE` | off | collect geometry rows for the probe |
| `BOT3_BANKGATE_TRACE` | off | collect rows in `globalThis.__bankgate` |

## Tests

`strategy.test.cjs` adds ten cases: config defaults/clamps/flags for the round-19
knobs, the room gates, **the geometry measurement** (ring, hop buckets, rear,
demand, swamp/mountain share, articulations, and the fog masking of unseen
plains), **the discriminator** (dry-open refused, wet accepted, corridor by
mountain share, reservoir and rise clauses, and the land-ratio clause),
**the release** (fill rule with its grace window, opt-in starve rule, off by
default), the site rules, the redirect with defence exempt, the multi-feed
batch with city then crown, the engine chain rules, and the byte-identical
planner path with the switch off. `node --test bot-template/relay-bot/strategy.test.cjs`
is 123/123.

## Reproducing

```sh
BOT3_M3PLY=1 BOT3_BANKGATE=1 \
OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean MODES=001,011 \
SEED_FROM=1 SEED_TO=16 WORKERS=4 OUT=data/scratch/bankgate.jsonl \
SUMMARY=data/scratch/bankgate-summary.json node bot-template/relay-bot/training/evaluate-matrix.cjs
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/bankgate.jsonl

# full matrix (1735/259/54 against 1709/284/55, zero regressions)
WORKERS=8 BOT3_M3PLY=1 BOT3_BANKGATE=1 OUT=data/scratch/bankgate-full.jsonl \
SUMMARY=data/scratch/bankgate-full-summary.json node bot-template/relay-bot/training/evaluate-matrix.cjs

# the discriminator probe (bank off gives the base geometry, bank on the picks)
SEEDS=bot3-baseline-1,bot3-baseline-2 MAPS=random,mediterranean FOG=0 \
BOT3_M3PLY=1 BOT3_BANKGATE_PROBE=1 OUT=data/scratch/bg-base.jsonl \
node data/scratch/bankgate-probe.cjs
node data/scratch/bankgate-analyze.cjs data/scratch/bg-base.jsonl
```
