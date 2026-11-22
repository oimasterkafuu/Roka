# Bot(3.0) archipelago layer

Round 11 targets the weakest map in the acceptance matrix. Baseline (16 seeds,
32 games per cell, `bot-template/bot-3.0/baseline-results.jsonl`):

| cell | baseline | target |
| --- | ---: | ---: |
| relay / archipelago / clear / single | 16/32 (50.0%) | 65% |
| relay / archipelago / fog / single | 19/32 (59.4%) | 65% |
| relay / archipelago / clear / multi | 15/16/2 (46.9%) | 65% |
| relay / archipelago / fog / multi | 15/15/2 (46.9%) | 65% |
| anti / archipelago / clear / single | 19/32 (59.4%) | 50% |
| anti / archipelago / fog / single | 22/32 (68.8%) | 50% |

## Diagnosis

The archipelago generator fills the board with swamp and scatters 3x3..4x4 plain
islands on it (`src/map/archipelago-map-generator.ts`): **66.2% of the passable
cells are swamp** on the traced seeds, and each island is separated from the next
by a one-to-three-cell swamp strait. Swamp is walkable, but `tick-growth.ts` pays
+1 army per tick only on plain cells (and +1 per 50 ticks on cities), so this map
is a land race with a hard budget.

**1. Army at tick 50 decides the game; land at tick 50 does not.** Bucketing the
64 traced archipelago games by the checkpoint at t50:

| army at t50 vs rival | W/L | land at t50 vs rival | W/L |
| --- | --- | --- | --- |
| > +40 | 24/5 | +5 or more | 5/1 |
| +/- 40 | 33/31 | -1..1 | 23/19 |
| < -40 | 7/36 | -5..-2 | 17/18 |
| | | <= -6 | 1/4 |

The burst window (ticks 26-50) is why: every plain cell claimed by t26 adds +1
army per tick, i.e. **~22-25 army at t50 per plain cell**, and nothing after it.
Summed over the traced losses, total army at t50 tracks `22.5 x plain cells`
almost exactly (13 plain -> 290, 25 plain -> 573).

**2. The planner treats the room as open ground.** `objectives` are the
remembered rival crowns and `distances`/`campaignRoute` price swamp and plain
identically, so the single serial order beelines at the rival crown through open
water. `bot3-baseline-3` seat 0 (loss, tick 141) is the canonical trace: 10 plain
/ 11 swamp at t25 (even with the rival's 12 plain), then orders

```
t31 (11,0)->(10,0)   t35 (10,2)->(9,2)   t39 (12,1)->(11,1)
t32 (10,0)->(10,1)   t36 (9,2)->(8,2)    t43 (10,2)->(9,2)
t33 (11,1)->(10,1)   t37 (8,2)->(7,2)    t47 (7,3)->(6,3)
t34 (10,1)->(10,2)   t38 (13,1)->(12,1)  t48 (6,3)->(6,4)   ...
```

seven straight swamp cells toward the far crown, while two islands sit **one
strait** away (island graph of that seed: straits of 1, 1, 2, 3 cells). At t40
the rival is 25 plain / 299 army and we are 10 plain / 176 army; at t50 it is
25 plain / 573 army against 13 plain / 290 army. The rival never left its own
islands and took the 11-cell centre island at t30-39.

**3. The crossing is spent on 1-unit bridge cells.** A move leaves one unit
behind (`mode 2`), so a seven-cell crossing plants seven garrisons on cells that
pay nothing. The same trace ends with `isolated` cells jumping to 9 at t61, 14 at
t66 and 15 at t69 (32-38 army decaying), because the rival only has to cut one
bridge cell to strand the far stack.

**4. Crowns are the only post-burst income, and the losses do not build them.**
`buildingStart` is 50 on the clear serial room and `develop`/`site` keep the
serial tick on the march, so the traced losses sit on one crown for the whole
game (rival: second crown at t52, third at t59). Every crown is +1 army/tick,
i.e. ~300 army over a 300-tick game.

**5. After the economy is fixed the stack stalls.** With `BOT3_ARCH_LAND=1` the
same seed reaches 25 plain / 448 army at t50 (rival 25 plain / 471 army) and 30
plain at t60 - and still loses at t130, because after the burst the objective
returns to the far rival crown and the 164-204 army stack on island 1 shuffles
between two cells, `(3,2)<->(3,3)`, from t70 to t85 while the rival eats island 4
and then island 1 (isolated 9-24 cells at t100-120). `goal`/`required` for a
crown two straits away are far enough that every capture rule is dead and the
`frontDist` merge term oscillates.

## Mechanisms

All gated on the board's swamp share (`BOT3_ARCH_SWAMP_SHARE`, default 0.55 -
archipelago measures 66-70%, mediterranean 45.7%, random 7.2%), never on the map
name, and off by default. Multi-line rooms are excluded (`BOT3_ARCH_MULTI=1`
opts in): they allocate sixteen orders through `./multi` and do not have this
serial land race.

| flag | mechanism |
| --- | --- |
| `BOT3_ARCH_LAND` | land-first objective: while the burst is live and no rival is within `BOT3_ARCH_CONTACT` (3) of a home, the objective field is the plain cells of the nearest unclaimed, rival-free island (latched, so the field cannot flicker between two equally close islands). |
| `BOT3_ARCH_FRONT` | frontier objective: outside the land phase, aim at the visible rival frontier instead of the remembered crown, so a reachable step always exists. Clear-serial only unless `BOT3_ARCH_FRONT_FOG=1`. |
| `BOT3_ARCH_WATER` | water discipline: a swamp capture that does not shorten the distance to the nearest unclaimed plain cell is capped at `BOT3_ARCH_WATER_CAP` (18) - under the land capture next door, above a plain merge. A strait crossing still passes, because every hop of a shortest crossing lowers the field. |
| `BOT3_ARCH_CROWN` | island crown: on a fully owned, rival-free island, the build gates (`develop`, `buildingStart`, `units >= 100`) are relaxed so a rear crown can pay +1/tick. |
| `BOT3_ARCH` | the measured bundle: `LAND` + `FRONT` with `BOT3_ARCH_UNTIL=51`. |

`BOT3_ARCH_UNTIL` ends the land phase with the burst. Measured 8-seed screens
(relay+anti, all four modes, 128 games, `MODES=000,001,010,011`):

| config | total | delta |
| --- | ---: | ---: |
| off (identical to baseline, 0 flips) | 85/42/1 | 0.0pp |
| `LAND`, until 40 | 88/36/4 | +2.3pp |
| `LAND`, until 51 | 89/36/3 | +3.1pp |
| `LAND`, until 62 | 81/47/0 | -3.1pp |
| `LAND`, no expiry | 73/53/2 | -9.4pp |
| `WATER` alone | 75/52/1 | -7.8pp |
| `CROWN` alone | 74/52/2 | -8.6pp |
| `FRONT` (all rooms) | 82/36/10 | -2.3pp |
| `FRONT` (clear serial only) | 87/37/4 | +1.6pp |
| `LAND`51 + `FRONT` | **93/31/4** | **+6.3pp** |
| `LAND`51 + `FRONT` + `CROWN` | 78/44/6 | -5.5pp |
| `LAND`51 + `FRONT` + `WATER` | 77/41/10 | -6.3pp |

`WATER` and `CROWN` are kept as measured negatives: each is plausible on paper
(swamp pays no income; a crown is +1/tick) and each costs wins, and both wipe out
the land/front gain when stacked with it.

## Measured result

16 seeds, all four opponents, all four modes, 512 archipelago games
(`OPPONENTS=relay,anti,apex,v2 MAPS=archipelago MODES=000,001,010,011`):

| opponent | fog | multi | candidate | baseline | delta |
| --- | --- | --- | --- | --- | ---: |
| relay | off | off | 21/11/0 | 16/16/0 | **+15.6pp** |
| relay | off | on | 15/15/2 | 15/15/2 | 0.0pp |
| relay | on | off | 18/13/1 | 19/13/0 | -3.1pp |
| relay | on | on | 15/15/2 | 15/15/2 | 0.0pp |
| anti | off | off | 25/4/3 | 19/13/0 | **+18.8pp** |
| anti | off | on | 32/0/0 | 32/0/0 | 0.0pp |
| anti | on | off | 23/7/2 | 22/10/0 | +3.1pp |
| anti | on | on | 29/0/3 | 29/0/3 | 0.0pp |
| apex | off | off | 30/2/0 | 24/8/0 | **+18.8pp** |
| apex | off | on | 25/7/0 | 25/7/0 | 0.0pp |
| apex | on | off | 30/2/0 | 25/5/2 | **+15.6pp** |
| apex | on | on | 31/1/0 | 31/1/0 | 0.0pp |
| v2 | off | off | 28/4/0 | 25/7/0 | **+9.4pp** |
| v2 | off | on | 30/2/0 | 30/2/0 | 0.0pp |
| v2 | on | off | 30/2/0 | 24/6/2 | **+18.8pp** |
| v2 | on | on | 31/1/0 | 31/1/0 | 0.0pp |

Total 413/86/13 (80.7%) against 382/119/11 (74.6%): **+6.1pp, +31 wins** on the
map, with every multi-line cell exactly on baseline and one single-line cell
still behind (relay fog single, one win converted into a timeout).

`relay / archipelago / clear / single` is the only relay archipelago cell that
reaches the 65% target: **21/32 = 65.6%** (16/32 baseline). Fog single is
18/32 = 56.3%, so the relay cells as a group still fail the gate.

## Full matrix

2048 games, `WORKERS=2`, final code (`BOT3_ARCH=1`):

| row | W/L/T | win |
| --- | --- | ---: |
| baseline (`baseline-results.jsonl`) | 1621/367/60 | 79.2% |
| bundle | **1660/323/65** | **81.1%** |

+39 wins, +1.9pp, and **no cell outside archipelago moves at all** (the paired
deltas on random/maze/mediterranean are 0.0pp except the fog cells that the
pre-existing `BOT3_FOG_PAINT3` bundle already moved: relay/random fog single
16 -> 21, anti/random fog single 21 -> 23, v2/random fog single 28 -> 29).

Inside archipelago, 15 of the 16 cells are at or above baseline; the single
regression is `relay/archipelago/fog/single` (19 -> 18, one win converted into a
timeout). All eight multi-line cells are exactly on baseline because the layer
stands down there.

**Recommendation: keep `BOT3_ARCH` off by default.** It is a large, clean gain
on the archipelago map (+31 wins on the map, no regressed cell outside one
relay fog cell, every non-relay cell above 50%) but it does not move the relay
archipelago cells as a group to the 65% target, and the repository policy is to
only turn a measured bundle on after it clears its cells. `BOT3_ARCH=1` is safe
to adopt for the map alone: the full matrix is +1.9pp with no non-archipelago
cell below its paired baseline.

## Risks

- Timeouts: the bundle converts a few wins into 1000-tick games (archipelago
  timeouts 11 -> 13). `FRONT` alone is much worse (1 -> 10 on the 8-seed screen),
  which is why it is serial-only and only used together with the land phase.
- `relay/archipelago/fog/single` loses one win to a timeout; the land phase ends
  at t51 and the frontier objective is already fog-disabled, so the remaining
  difference is the extra land it holds.
- The focus island is latched on the board (`b.archFocus`). If a rival beaches
  the focused island the latch drops and the next island is chosen, but a rival
  can still force a re-target by touching every rim island.
- The island partition is cached per board on `b.archIsland`; it is derived from
  terrain only (swamp/mountain), which never changes in this engine, so the
  cache cannot go stale.

## Reproduce

```sh
# diagnosis screens (8 seeds, relay+anti, all four modes)
WORKERS=2 SEED_FROM=1 SEED_TO=8 OPPONENTS=relay,anti MAPS=archipelago \
  MODES=000,001,010,011 OUT=/tmp/ar-s8.jsonl SUMMARY=/tmp/ar-s8.json \
  node scripts/evaluate-bot3-baseline.cjs
BOT3_ARCH=1 WORKERS=2 SEED_FROM=1 SEED_TO=8 OPPONENTS=relay,anti MAPS=archipelago \
  MODES=000,001,010,011 OUT=/tmp/ar-b-s8.jsonl SUMMARY=/tmp/ar-b-s8.json \
  node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/ar-b-s8.jsonl

# all four opponents, 16 seeds
BOT3_ARCH=1 WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay,anti,apex,v2 \
  MAPS=archipelago MODES=000,001,010,011 OUT=/tmp/ar-16.jsonl SUMMARY=/tmp/ar-16.json \
  node scripts/evaluate-bot3-baseline.cjs

# full matrix
BOT3_ARCH=1 WORKERS=2 OUT=/tmp/ar-full.jsonl SUMMARY=/tmp/ar-full.json \
  node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/ar-full.jsonl
```
