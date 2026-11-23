# Round 19 — the fog cells are where the bank is safest (`BOT3_FOGBANK`)

Round 18's crown bank (`./mcrown2`, `BOT3_MCROWN2`) had the largest single
effect measured on these rooms — **mediterranean fog 30/32 and archipelago fog
19/32** against 17 and 15 — and it was still unshippable, because the same layer
took `relay random fog` from 17 to 10 and `relay random clear` from 22 to 16.
Round 19 asks whether the part of the effect that lives in fog can be shipped on
its own, and answers **yes, on swamp-heavy fog rooms**:

| scope                                              |      shipped default |         `BOT3_FOGBANK=1` |            Δ |
| -------------------------------------------------- | -------------------: | -----------------------: | -----------: |
| seeds 1–16, four relay fog multi cells (128 games) |     65/61/2 (50.8 %) |     **82/43/3 (64.1 %)** | **+13.3 pp** |
| seeds 17–32, same cells (independent, 128 games)   |     58/63/7 (45.3 %) |     **75/50/3 (58.6 %)** | **+13.3 pp** |
| full 2048-game matrix, paired on this machine      | 1702/290/56 (83.1 %) | **1719/272/57 (83.9 %)** | **+17 wins** |

Every cell that is not `relay` × fog × multi is **byte-identical** in the full
matrix (0.0 pp, zero flips), and the two cells that move are the two that were
meant to move. The switch is off by default.

The bar (every relay multi cell ≥ 21/32) is **not reached**: three fog cells are
still short (archipelago fog 19, random fog 17, maze fog 16). The reasons are
measured and recorded below; the direction itself reproduces exactly on both
halves, which is what makes it shippable as a default-off switch.

## What changed against round 18

Three changes, all in `./mcrown2`; the mechanism (vault, gather, redirect,
build) is round 18's and is untouched.

1. **Fog-only gate** (`BOT3_FOGBANK` implies `fogOnly`, `BOT3_MCROWN2_FOGONLY`
   alone if you want the fog gate on the round-18 defaults). Round 18's clear
   regressions (`relay random clear` −15.6 pp, and the relay clear multi cells in
   the matrix) are gone by construction: on a clear board the rival sees the
   vault and can punish the pause the gather costs.
2. **Swamp-share gate** (`BOT3_MCROWN2_SWAMP`, percent, default 30 for
   `BOT3_FOGBANK`, 0 for the round-18 path). This is the measured divide inside
   the fog cells and it is an exact read: `fog-vision.ts` keeps swamp visible
   through the fog (unowned swamp is re-encoded to 204), so the terrain mix of
   the whole board is known on tick 1 even where the rival is not. Measured on
   the acceptance boards (whole board, unowned swamps + owned `150+owner`):

   | map           | swamp cells / board |       share |
   | ------------- | ------------------: | ----------: |
   | archipelago   |   141–170 / 221–255 | **64–67 %** |
   | mediterranean |    81–105 / 221–225 | **36–47 %** |
   | random        |     16–25 / 221–255 |      7–11 % |
   | maze          |     17–18 / 221–225 |         8 % |

   A gate at 30 % separates the two cells the bank wins from the two it loses on
   every single pick, with a 6 pp margin to mediterranean and a 19 pp margin to
   random.

3. **Pick window** (`BOT3_MCROWN2_PICKEND`, default 0 = off; **not shipped on**,
   see the negatives). It gates _when a vault may be started_, never a bank that
   is already filling — the round-18 hysteresis rule.

Also added: `BOT3_MCROWN2_TRACE=1` now records a per-tick census (own army by
hop band, own cells, both sides' leaderboard land/army, vault, bank, re-priced
and vetoed order counts, done count). It is diagnosis-only, walks nothing unless
the trace is on, and is what the tables below were read from.

## Why the bank is right in fog and wrong on grass

Probe (`data/scratch/fogbank-probe.cjs`, one game, `BOT3_MCROWN2_TRACE=1`),
relay multi fog, seat 0.

**Mediterranean fog, `bot3-baseline-1` (win t579, baseline wins too).** Vault
picked at t44–50, bank 3 → 46 army by t80, city at t85, **crown at t110**. Land:
ours 62 vs relay **122** at t100 — we lose the land race by 2× and win anyway,
because relay's land is mostly swamp and swamp pays no income: relay sits at
127–150 land and 210–234 army for the next two hundred ticks while our crown
compounds to 257 army at t500 and the game turns over at t390 (land 105 vs 106)
and ends 193 vs 18 at t579. On a swamp board a crown is 50× the income per army
that land is.

**Random fog, `bot3-baseline-1` (loss t306; the baseline wins at t466).** Byte
for byte the baseline until t145 (land 103, army 118 vs relay 97, 119 — an even
land race and an even exchange). The vault is picked at t149, **106 own merges
are re-pointed in that one tick** (round 18's redirect), and the land collapses
103 → 58 by t190 while relay goes 97 → 142; the crown arrives at t190 and the
game is already lost. On a grass board the diverted army is not idle, it is the
pipe that pays for the land race.

The whole random cell agrees, and it is the cleanest signal in this round:
**all 22 of the 32 random-fog games that pick a vault lose, and all 10 wins are
the 10 games that never pick one.** (Picks at t50 mostly, some at 74–149; the
result does not depend on the timing, only on whether the bank exists at all.)

## Measured — relay fog multi cells

`W/L/T` per cell, 32 games each (16 seeds × 2 seats). Candidate is
`BOT3_FOGBANK=1`; baseline is the same tree with no env vars, run on this
machine.

### Screen, seeds 1–16 (128 games)

| cell                          | candidate            | baseline         |            Δ |
| ----------------------------- | -------------------- | ---------------- | -----------: |
| relay archipelago fog multi   | **19/12/1**          | 15/16/1          | **+12.5 pp** |
| relay maze fog multi          | 16/16/0              | 16/16/0          |       0.0 pp |
| relay mediterranean fog multi | **30/0/2**           | 17/14/1          | **+40.6 pp** |
| relay random fog multi        | 17/15/0              | 17/15/0          |       0.0 pp |
| **total**                     | **82/43/3 (64.1 %)** | 65/61/2 (50.8 %) | **+13.3 pp** |

Flips: 19 loss→win, 2 win→loss, 2 loss→timeout, 1 timeout→loss.

### Independent half, seeds 17–32 (128 games, paired against my own off run)

| cell                          | candidate            | baseline         |            Δ |
| ----------------------------- | -------------------- | ---------------- | -----------: |
| relay archipelago fog multi   | **18/14/0**          | 15/15/2          |  **+9.4 pp** |
| relay maze fog multi          | 16/16/0              | 16/16/0          |       0.0 pp |
| relay mediterranean fog multi | **26/3/3**           | 12/15/5          | **+43.8 pp** |
| relay random fog multi        | 15/17/0              | 15/17/0          |       0.0 pp |
| **total**                     | **75/50/3 (58.6 %)** | 58/63/7 (45.3 %) | **+13.3 pp** |

Flips: 15 loss→win, 3 win→loss, 5 timeout→win, 1 timeout→loss, 2 loss→timeout.
Both halves agree in sign and size per cell: archipelago +4/+3, mediterranean
+13/+14, random 0/0, maze 0/0 — the same per-cell numbers round 18 measured for
`BOT3_MCROWN2` on the fog cells, now without the clear-cell damage.

Caveat on `timeout→win` (5 in the independent half): the bank wins a few games
by _not_ finishing them, so check the result column, not just the tick.

### Full matrix (2048 games), paired

`BOT3_FOGBANK=1` → **1719/272/57 (83.9 %)** against the on-machine control
**1702/290/56 (83.1 %)**: +17 wins, and the only two cells that differ are
`relay/archipelago/fog/multi` 19 vs 15 (+12.5 pp) and
`relay/mediterranean/fog/multi` 30 vs 17 (+40.6 pp). Every other cell — all 62
of them — is 0.0 pp with zero flips, including all 16 non-relay cells and all
four relay clear multi cells.

**Reproducibility note (read this before quoting the recorded baseline).** On
this worktree the shipped default with no env vars measures **136/256** relay
multi, not the 143/256 recorded in `bot-template/bot-3.0/baseline-results.jsonl`
(which was recorded at `0d13ba9`, i.e. before the three-tick search shipped in
`a22446c`). The four **fog** cells reproduce the recorded file exactly; the four
**clear** multi cells come out 2 games lower each (archipelago 15 vs 17, maze 16
vs 18, mediterranean 19 vs 21, random 21 vs 22), and the full matrix is
1702/290/56 against the recorded 1709/284/55. Two independent runs (WORKERS=4
and 6, and again inside the 2048-game run) reproduce 136/256 and 1702 bit for
bit, so this is the tree, not run-to-run noise. All comparisons in this document
are therefore paired against an on-machine control run of the same tree, not
against the recorded file.

## Honest negatives

Every row is a measured relay-fog run; "screen" = seeds 1–16 unless stated.

| variant                            | arch fog | med fog | random fog | maze fog | verdict                                            |
| ---------------------------------- | -------: | ------: | ---------: | -------: | -------------------------------------------------- |
| `BOT3_FOGBANK` (shipped candidate) |       19 |      30 |         17 |       16 | best                                               |
| `CROWNS=2`                         |       11 |      15 |         17 |       16 | two banks starve the frontier                      |
| `FEED=8`                           |       19 |      30 |         17 |       16 | inert — 0–4 donors exist per tick                  |
| `SAFE=4`                           |       19 |      30 |         17 |       16 | inert — the vault is already ≥ 3 hops out          |
| `BASIN=8`                          |       19 |      30 |         17 |       16 | inert                                              |
| `START=44`                         |       19 |      30 |         17 |       16 | shipped start                                      |
| `PICKEND=80`                       |       18 |      29 |         17 |       16 | loses a mediterranean crown                        |
| `PICKEND=90`                       |       18 |      29 |         17 |       16 | same                                               |
| `PICKEND=110`                      |       20 |      30 |         17 |       16 | screen +1, **independent 16/25** (−2/−1)           |
| `OUTLETS=1` (round 18's safe rule) |       15 |      17 |         16 |       16 | inert: the single-outlet pick never fires here     |
| `START=100` (round-18 path)        |       16 |      25 |         13 |       16 | still loses the random cell (−12.5 pp)             |
| `HOP=4` (round-18 path)            |        — |       — |         10 |        — | any bank hurts grass fog, shallower does not help  |
| `HOP=4 START=100`                  |        — |       — |         13 |        — | late and deep still −12.5 pp                       |
| `HOP=4 FEED=2 GAIN=60` / `GAIN=60` |        — |       — |         10 |        — | a weaker redirect does the same damage             |
| `CORRIDOR=1` (round-18 path)       |        — |       — |          — |       11 | a corridor has no rear basin, −15.6 pp             |
| `BEHIND=60/70/80` (round-18 path)  |        — |       — |         17 |        — | inert: our army is never below 80 % of the rival's |

Two of these deserve a sentence. The last five rows are the direct answer to
"could a smaller / later / shallower bank be safe on grass fog": no. Depth
(`HOP=4`), timing (`START=100`) and redirect strength (`GAIN=60`, `FEED=2`) were
each measured separately and each still loses the whole random cell (−12.5 to
−21.9 pp), so the divide is the board, not the tuning.

- **`PICKEND`** looked like the best idea in the probe: on archipelago fog every
  vault picked after t90 filled against a rival that already held twice our land
  (10 late picks: 2 W, 1 T, 7 L) while the early picks (t44–60) were 6 W 2 L.
  Cutting the window at 80/90 loses a mediterranean crown and is a net −1; at
  110 it gains one archipelago game on the screen and **loses two on the
  independent half**. It is a 1–2 game effect either way, i.e. seed noise, so it
  stays off (`0`) and the knob is only kept so the negative is reproducible.
- **`BEHIND=60/70/80` on the random cell** was the test of "bank only when the
  army race is already lost". The random cell comes out byte-identical to the
  baseline at every setting: our army is never below 80 % of relay's on that
  cell, so the hedge can never fire. There is no "lost position" to rescue there
  — the bank's early pick at t50 is what creates the lost position.

## Why the remaining fog cells are still below 21/32

- **random fog 17/32** (15 independent). Grass fog is an even mirror: land
  saturates at ~100 of ~200 cells for both seats and the army exchange is even
  at t50–250, so the bank has no purchase at any timing (`START=100` −12.5 pp,
  `BEHIND≤80` never fires) and the swamp gate keeps it out. The mechanism this
  direction has (bank income) is worth ~+1 army per tick; on a grass board the
  same army is worth more in the land race, and there is no other measured lever
  here — round 18's fog search over public information was net +1 game across
  all four fog cells, and the rival's batch is unrecoverable (0.1–0.4 % match).
- **maze fog 16/32**. Corridors are gated out of every multi layer (the bank
  included: `corridor: false`), and the swamp gate excludes them a second time
  (8 % swamp). A corridor has one hop field and no rear basin to hold, so this
  direction cannot touch the cell; the 16/32 is the mirror.
- **archipelago fog 19/32** (18 independent). The banked games that _finish_ are
  7 W 1 L 1 T on the screen; the ones that never finish are 0 W. The gap is
  those interrupted banks, which is a fill-speed problem the bank's own knobs do
  not move (see the inert `FEED`/`SAFE`/`BASIN` rows) — the archipelago rear
  basin is shallow, so 4 donors per tick is already the whole basin.

## Cost

The layer adds no search. When `BOT3_FOGBANK` is on in a fog room it walks the
board once per tick for the swamp share (measured 0.21 µs for a 255-cell board)
and then, once a vault exists, one BFS field over our own cells plus the
existing round-18 redirect. When it is off, `mcrown2Update` returns before
allocating any state: the shipped path is byte-identical (unit test
"leave the planner byte-identical while the crown layer is off", and the 2048
game matrix above).

## Switch summary

| switch                 | default                     | meaning                                                   |
| ---------------------- | --------------------------- | --------------------------------------------------------- |
| `BOT3_FOGBANK`         | off                         | fog-only bank: enables the layer, `fogOnly=1`, `swamp=30` |
| `BOT3_MCROWN2`         | off                         | round-18 layer, all rooms                                 |
| `BOT3_MCROWN2_FOGONLY` | = `BOT3_FOGBANK`            | fog rooms only                                            |
| `BOT3_MCROWN2_SWAMP`   | 0 (30 under `BOT3_FOGBANK`) | minimum swamp share, percent                              |
| `BOT3_MCROWN2_PICKEND` | 0                           | last tick a new vault may be picked (measured negative)   |
| `BOT3_MCROWN2_TRACE`   | off                         | per-tick census for `data/scratch/fogbank-probe.cjs`      |

## Verification

- `node --test bot-template/bot-3.0/bot3.test.cjs` → **121/121 pass**, including
  the whole round-18 crown-bank block (lifted unchanged) and the new
  "gate the fog bank on the room, the swamp share and the pick window" test.
- Screen 128 games, independent 128 games, full 2048-game matrix: numbers above,
  the full matrix re-run on the committed tree at 1719/272/57 (identical).
- Switch off: 0 flips against the on-machine control, and 0 differences between
  two separate runs of the same code (WORKERS 4 vs 6).
