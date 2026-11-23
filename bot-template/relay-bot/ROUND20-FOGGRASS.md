# Round 20 — the grass fog room is a policy-flat cell (`BOT3_FOGRASS`)

The bar for this cell was **random fog 17/32 → 21/32 (+4)**. It is **not
reached**. The measured best is **19/32 on seeds 1–16** and **17/32 on seeds
17–32** (17 and 15 before the change), i.e. **+2 on both halves** and nothing
else in the full matrix. The switch ships **off**.

The interesting result is why the cell could not be moved. This room is the
only relay multi cell that no bank can buy, so it runs the plain reactive
policy, and a probe of what that policy actually does shows that **both
players are the same conveyor belt** and that the winner is set by the opening
land race, not by any reaction in the midgame. Three abortive doctrines
(measured below) each shift one or two games on one half of the seeds and
replicate to zero on the other half.

| scope                                                    |     shipped |          `BOT3_FOGRASS=1` |                            Δ |
| -------------------------------------------------------- | ----------: | ------------------------: | ---------------------------: |
| seeds 1–16, relay × random × fog × multi (32 games)      |     17/15/0 |               **19/13/0** |                       **+2** |
| seeds 17–32 (independent, paired against my own off run) |     15/17/0 |               **17/15/0** |                       **+2** |
| full 2048-game matrix, paired on this machine            | 1736/258/54 |           **1744/248/56** | **+8** (2 cell + 6 v2 noise) |
| 256-game relay screen, switch off vs unset               |    173/78/5 | 173/78/5 (byte-identical) |                            0 |
| 256-game relay screen, switch on                         |    173/78/5 |              **175/76/5** |                       **+2** |

The full matrix moves exactly **one relay cell** — `relay/random/fog/multi`
17 → 19 — and none of the other 15 relay cells; the extra +6 wins are on `v2`
**single-line** cells, which the layer cannot even reach (`multi` is in its
gate), and the on-machine control run moves on those cells by itself (OFF:
1736/258/54 against the recorded 1739/254/55), so they are `v2` run-to-run
variance, not this change. The four non-relay random fog multi cells are
32/32, 32/32, 32/32 (anti/apex/v2) before and after.

## What relay actually does on a grass fog board

Probe: `bot-template/relay-bot/foggrass-probe.cjs` (real engine, mock clock, both
bots attached, one game per seed/seat), 32 games, seeds 1–16, both seats. The
probe prints one JSON row per game; the tables below are simple sums over those
rows (the reproduce section shows the loop).

| metric (32 games)                                      |                     relay |             us |
| ------------------------------------------------------ | ------------------------: | -------------: |
| moves executed                                         |                   122 018 |        127 451 |
| of which `mode 2` (all-in)                             |    **122 013 (99.996 %)** |              — |
| own merges                                             |                   110 693 |        115 913 |
| merges that shorten the distance to the other home     |            106 108 (96 %) | 108 994 (94 %) |
| captures into a garrison of ≤ 1                        | **8 717 / 10 819 (81 %)** |              — |
| cells of ours lost at garrison 1 / 2                   |         **5 570 / 1 298** |              — |
| ring cells holding 1 army (cell-ticks)                 |                    91 099 |         96 096 |
| ring cells holding 2 army (cell-ticks)                 |                    31 754 |         24 678 |
| cells with a beatable neighbour, did it fire from them | 9 382 / 12 464 (**75 %**) |              — |

So relay is a conveyor belt, not a planner: every merge walks army toward us,
every capture is all-in, and the source of every push is left at exactly one
army. Both rings hold one army in roughly two thirds of the samples and 3+ in
the rest, so the two sides are symmetric in shape as well as in policy. Three
consequences measured directly:

1. **The empty source is a real prior.** A relay cell with a beatable neighbour
   fires 75 % of the time. When it does, its source is a one-army cell, and a
   one-army cell is taken by a 3-stack (an all-in push sends `total - 1`).
   In 6 668 relay-first ticks there are only **1 713** cells where a free 3+
   stack of ours sits next to such a relay cell; relay fires on **665** of
   them and we counter-took **5**. The opportunity exists but is rare, because
   our ring is not where our 3-stacks are.
2. **The free-capture asymmetry.** 81 % of relay's captures pay one army or
   less; our losses are 5 570 cells at garrison 1 against 1 298 at garrison 2.
   A 2-garrison ring cell would charge relay two army per capture (it needs a
   4-stack) instead of one.
3. **The pulse.** Multi rooms have no burst: the only army source is
   `turn % 50 === 0` (+1 per owned plain) plus the starting crown (+1/tick).
   Captures per tick-mod-50 over the 32 games:

   | tick mod 50    |       0 |       1 |   2 |   3 |   4 |   5 |   … |  20 |  40 |
   | -------------- | ------: | ------: | --: | --: | --: | --: | --: | --: | --: |
   | relay captures | **533** |     190 | 256 | 320 | 328 | 341 |     | 238 | 108 |
   | our captures   |     324 | **391** | 395 | 459 | 381 | 429 |     | 191 | 123 |

   The tick that pays for land is planned on the frame after `turn % 50 === 49`
   (growth runs before moves), so every ring cell is _about to hold two army_
   and can capture. We take 10.1 cells on that tick per game; relay takes 16.7.
   The reason is `./mhalf`: its ring refill bonus (60) reaches `minFire` on the
   same frame, wins the sort, and cancels the capture it was arming (the engine
   refuses a move out of a cell that is another move's target).

## Midgame shape (what a win and a loss look like)

Leaderboard land at the pulses, mean over the 17 won and 15 lost games
(seeds 1–16, ours / relay):

| pulse | 50 | 100 | 150 | 200 | 250 | 300 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| won games | 47.2 / 49.2 | 91.8 / 88.4 | 99.5 / 88.7 | 106.4 / 82.7 | 116.0 / 73.5 | 131.6 / 57.8 |
| lost games | 44.4 / 51.4 | 86.4 / 92.7 | 89.3 / 100.3 | 86.1 / 105.2 | 78.2 / 112.8 | 67.6 / 125.1 |

The gap opens between t50 and t150 and is a snowball from there: the side that
leads the first pulse keeps the better ring and converts the next one. In won
games captures/losses per 50-tick cycle are 59/14, 40/33, 39/32, 42/32, 46/31,
40/24; in lost games 56/14, 37/34, 34/37, 33/41, 30/45, 27/49 — the crossover is
the t150 window. The average garrison at the moment a cell is lost is **1.48**
in won games and **1.43** in lost games, i.e. essentially every lost cell is a
one- or two-army cell, which is what doctrine A prices.

## The one measured mechanism: pulse capture discipline

Lower the refill bonus that `./mhalf` gets in this room (`BOT3_FOGRASS_RELOAD`,
default 30). That recovers most of the pulse captures and is the only part of
the layer with a replicated effect:

| refill bonus (`./mhalf` reload) | seeds 1–16 | seeds 17–32 |
| ------------------------------- | ---------: | ----------: |
| 60 (shipped)                    |      17/32 |       15/32 |
| 50                              |         17 |           — |
| 40                              |         17 |           — |
| **30**                          |     **19** |      **17** |
| 20                              |         18 |           — |
| 0                               |         17 |           — |

With the switch on the pulse-tick capture count rises from 324 to 521 over the
same 32 games (`BOT3_MHALF=0` measures the same 521, which is how the mechanism
was identified). Applying the override only on the pulse frame (`PULSE_ONLY=1`)
is _worse_ (17/32): the refill is worth its score mid-cycle, so the collision is
not the only thing the bonus buys.

The four screen flips (seeds 1–16, `${seed}:${seat} old→new`):
`8:0 l491→w522`, `9:0 l686→w572`, `14:0 l433→w415`, `5:1 w515→l340` (+2 net).
Independent half (17–32): `17:0 l521→w561`, `20:0 l479→w645` (+2, no loss).

## The two assigned doctrines (both measured, both off)

Both are public-information-only: visible garrisons and the known seat order
(player 1 resolves first on even ticks, player 2 on odd ticks), no batch
prediction. Both are gated to `fog && multi && swamp share < 25 % && !corridor`.

### A. Thicker ring (`BOT3_FOGRASS_RING`)

An own ring cell that faces a visible rival stack of 3+ is held at
`min(holdCap, max(2, threat - 1))` army (a push has to _strictly_ beat the
garrison, so 3 needs 4): a rear merge is boosted to reach it, and the cell is
not allowed to fire its garrison away for a neutral capture while the stack is
still there. Threat 2 needs no reaction — a 2-stack cannot take a one-army cell.

Measured (`RING=1 FEED=190`, seeds 1–16): **17/32**, 4 flips, and the probe
confirms the mechanism fires: relay's _failed_ attacks rise **506 → 699** per
32 games (a one-army cell capture becomes mutual destruction), our losses at
garrison 1 fall 5 570 → 5 522, our captures 10 974 → 10 952. The wins do not
follow: per-cell hits are `-8:0`, `-9:0` and losses `-9:1`, `11:1`, and
`holds` almost never fire (the stack usually moves or fires the same tick the
feed lands, so the cell is only endangered for one frame).

### B. Second-mover counter-capture (`BOT3_FOGRASS_COUNTER`)

When the rival resolves first on the next tick, a visible rival cell that
holds 2+ and has a beatable neighbour is about to empty itself. A free own cell
next to it with 3+ army attacks it: the rival push lands first (leaving one),
our attack lands second and takes the cell. The order is appended after the
planner's matching loop, so it cannot lose the slot.

Measured (seeds 1–16): **15/32 (−2)**, 6 flips. Gains `-8:0`, `-9:0`; losses
`-2:1`, `-5:1`, `-9:1`, `11:1`. The gains and the losses are _the same two
seeds_ the ring already wins, and the losses are all in the player-2 seat — the
counter changes the exchange but not the game.

### The seat gate (measured negative)

Seat order is public information and the shipped stack is unbalanced across the
mirror: player 1 (weak side) wins 12/32, player 2 20/32. A relay-vs-relay run
(`bot-template/relay-bot/training/evaluate.cjs`, both entries `relay`, 64 games) is exactly
symmetric (player 1 13/32, player 2 13/32… 32/32 by construction), so the
imbalance belongs to our layers, not the map. Gating the doctrines to player 1
therefore looked promising:

| config, seeds 1–16           | total | player 1 / player 2 |
| ---------------------------- | ----: | ------------------: |
| shipped                      |    17 |              6 / 11 |
| `RING=1 SEAT=1`              |    19 |              8 / 11 |
| `COUNTER=1 RING=0 SEAT=1`    |    19 |              8 / 11 |
| both, `SEAT=1`               |    19 |              8 / 11 |
| both + `RELOAD=30`, `SEAT=1` |    18 |              7 / 11 |

On seeds 17–32 every one of those configs is **15/32 with zero flips**: the
+2 does not replicate, so the seat gate is not shipped (`SEAT=0`).

## Honest negatives

All rows are 32-game relay random fog multi screens, seeds 1–16 unless stated;
configs are on top of the shipped tree.

| variant                                   |              W/32 | flips | verdict                                |
| ----------------------------------------- | ----------------: | ----: | -------------------------------------- |
| shipped default                           |                17 |     — | control                                |
| `BOT3_FOGRASS=1` (reload 30)              |            **19** |     4 | ships (default off)                    |
| `RING=1`                                  |                17 |     4 | mechanism fires, wins do not           |
| `COUNTER=1`                               |                15 |     6 | −2, same two seeds                     |
| `RING=1 COUNTER=1`                        |                15 |     6 | counter dominates                      |
| `RING=1 RELOAD=30`                        |                15 |     4 | ring cancels the pulse gain            |
| `COUNTER=1 RING=0 RELOAD=30`              |                13 |     6 | −4                                     |
| `RING=1 HOLD=3`                           |                18 |     2 | thicker is not better                  |
| `COUNTER=1 CMASS=3`                       |                19 |     2 | same two seeds as `CMASS=2`            |
| `PULSE=1` (cap merges on the pulse frame) |                16 |     3 | too broad, also caps the pipe          |
| `RELOAD=30 PULSE_ONLY=1`                  |                17 |     2 | mid-cycle refill is worth its score    |
| `RELOAD=0`                                |                17 |     4 | too low                                |
| `RELOAD=20` / `40` / `50`                 |      18 / 17 / 17 |       | 30 is the only positive point          |
| `BOT3_MHALF=0` (ablation)                 |                18 |     1 | the layer without the refill collision |
| `BOT3_MSHAPE=0` (ablation)                |                14 |       | mshape is worth +3 here                |
| `BOT3_MHALF=0 BOT3_MSHAPE=0`              |                16 |       |                                        |
| `SEAT=1` versions (see above)             | 19 / 19 / 19 / 18 |       | zero flips on seeds 17–32              |

## Why the +4 bar is out of reach with this policy family

- **The room is a mirror and the winner is set by the opening land race.** At
  t50 the two sides own 48 and 54 cells in a representative game and the land
  at t100/t250 follows those numbers to the winner; 14 of 16 seeds split 1–1,
  and the 17/32 is one seed that is won twice. Relay-vs-relay reproduces the
  same _seat_ split (13/32 and 13/32) as bot3-vs-relay (12/32 and 20/32), so
  there is no map corner to exploit in the other direction.
- **Our stack is +6 games over relay on this cell (32/64 vs 26/64) but uneven.**
  Everything we measured that helps (the pulse refill, the ring, the counter)
  moves the _player-1_ half by +2 and the player-2 half not at all; the
  remaining gap is the 10-cell opening land race deficit that both bots play
  identically. That is an opening/economy problem, not a reaction problem, and
  it is outside this direction.
- **The reaction windows are small.** The counter opportunity (rival cell with
  a beatable neighbour next to a free 3+ stack) exists on 1 713 tick-cells per
  32 games, i.e. ~53 per game, and relay fires on 39 % of them; the ring's
  endangered cells exist on ~290 garrison-1 ring cell-ticks per game (plus ~63
  garrison-2 cells facing a 4-stack) but almost never on a _free_ frame — the
  visible stack moves or fires the same tick the feed lands. Both are correct
  reactions to a rare state, worth 1–2 games.
- **The crown economy is excluded by measurement, not by construction.**
  Swamp share is 7.9–8.0 % on this cell (the probe prints it), far below both
  banks' 25–30 % gates, and round 19 measured every smaller/later bank variant
  at −12 to −22 pp here. Banking stays off.

## Cost

No search. When `BOT3_FOGRASS` is on in an eligible room the layer walks the
board once per tick for the swamp share (**0.2 µs** for a 255-cell board, the
same read `./mcrown2` already does), allocates one small state object per game
and, with the shipped defaults, only writes one number (`./mhalf`'s `reload`)
into the existing per-tick config. The ring and counter doctrines are inert
unless switched on. With the switch off, `foggrassUpdate` returns before the
walk, before the state lookup, and `applyFoggrass` / `foggrassOrders` are never
called (`foggrassLayer === null`) — the 256-game screen is byte-identical
(verified).

## Switch summary

| switch                                     | default   | meaning                                                                              |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------------------ |
| `BOT3_FOGRASS`                             | **off**   | enable the grass-fog layer                                                           |
| `BOT3_FOGRASS_RELOAD`                      | 30        | refill bonus handed to `./mhalf` in this room (`-1` keeps 60); the shipped mechanism |
| `BOT3_FOGRASS_RING`                        | 0         | doctrine A (thicker ring)                                                            |
| `BOT3_FOGRASS_FEED`                        | 0         | score for a merge that reaches the ring hold (`RING` needs it)                       |
| `BOT3_FOGRASS_MIN` / `_HOLD` / `_HOLDCAP`  | 3 / 2 / 4 | visible threat that arms the ring, minimum and maximum hold                          |
| `BOT3_FOGRASS_KEEPATTACK`                  | 1         | keep rival-cell captures from an endangered ring cell                                |
| `BOT3_FOGRASS_COUNTER`                     | 0         | doctrine B (second-mover counter-capture)                                            |
| `BOT3_FOGRASS_CMIN` / `_CMASS` / `_CLIMIT` | 3 / 2 / 4 | our source army, rival source army, orders per tick                                  |
| `BOT3_FOGRASS_SEAT`                        | 0         | gate on our player id (0 both, 1 player 1, 2 player 2)                               |
| `BOT3_FOGRASS_SWAMP`                       | 25        | maximum swamp share (percent) of a grass room                                        |
| `BOT3_FOGRASS_CORRIDOR`                    | 0         | opt corridor boards in                                                               |
| `BOT3_FOGRASS_PULSE` / `_PULSECAP`         | 0 / 20    | cap own merges on the pulse frame (negative)                                         |
| `BOT3_FOGRASS_START` / `_END`              | 0 / 0     | tick window                                                                          |
| `BOT3_FOGRASS_TRACE`                       | off       | per-process counters on exit                                                         |

## Verification

- `node --test bot-template/relay-bot/strategy.test.cjs` → **129/129 pass** (8 new
  tests: defaults/clamps, the room gate, the ring field, feed+hold, the
  counter and its seat order, and the byte-identical switch-off path).
- Screen, independent half, two full 2048-game matrices and the 256-game
  byte-identical check: numbers above.
- Off vs unset: `cmp` says identical (`data/scratch/screen-off.jsonl` vs
  `screen-unset.jsonl`).

## Reproduce

```sh
cd /c/Users/reson/Downloads/fork/Roka-bot3-r20-foggrass

# the cell, shipped default vs the switch (seeds 1-16 and 17-32)
OPPONENTS=relay MAPS=random MODES=011 SEED_FROM=1 SEED_TO=16 WORKERS=8 \
  OUT=data/scratch/def-a.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs
BOT3_FOGRASS=1 OPPONENTS=relay MAPS=random MODES=011 SEED_FROM=1 SEED_TO=16 WORKERS=8 \
  OUT=data/scratch/fg-a.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs

# the probe (relay's move mix, ring census, losses, opportunities)
for seed in $(seq 1 16); do
  for seat in 0 1; do
    SEED=bot3-baseline-$seed MAP=random MODE=011 SEAT=$seat       node bot-template/relay-bot/foggrass-probe.cjs
  done
done > data/scratch/probe.jsonl

# the relay-vs-relay mirror goes through the relay evaluator, not the bot3
# wrapper (the wrapper forces RELAY_ENTRY to bot3)
SEEDS=$(node -e "console.log(Array.from({length:64},(_,i)=>'relay-'+i).join(','))") \
  RELAY_ENTRY=bot-template/relay-bot/baseline/strategy.js SELF_ID=relay-control OPPONENTS=relay \
  MAPS=random MODES=011 node bot-template/relay-bot/training/evaluate.cjs

# 256-game screen, switch off vs unset (byte-identical) and switch on
OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean MODES=001,011 \
  SEED_FROM=1 SEED_TO=16 WORKERS=10 OUT=data/scratch/screen-off.jsonl \
  node bot-template/relay-bot/training/evaluate-matrix.cjs
BOT3_FOGRASS=0 OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean \
  MODES=001,011 SEED_FROM=1 SEED_TO=16 WORKERS=10 \
  OUT=data/scratch/screen-off2.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs
cmp data/scratch/screen-off.jsonl data/scratch/screen-off2.jsonl
BOT3_FOGRASS=1 WORKERS=10 OUT=data/scratch/full-on.jsonl \
  SUMMARY=data/scratch/full-on-summary.json node bot-template/relay-bot/training/evaluate-matrix.cjs
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/full-on.jsonl
```
