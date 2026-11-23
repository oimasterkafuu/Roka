# Round 20 — archipelago fog: the crown bank's gather band was one hop too deep (`BOT3_MCROWN2_SHALLOW`)

The round-19 fog bank (`./mcrown2` via `BOT3_FOGBANK`) is worth **+4 wins** on the
archipelago fog multi cell (19 against 15), and the cell was still two wins short
of the bar. This round finds the reason and fixes it: on an island board the
crown bank's **gather band** (round 18's `hop >= 3`) is one hop deeper than the
army the bank still needs, so the first of the crown's two 50-army builds drains
the basin and the crown is never bought. Shortening the band to `hop >= 2` on a
board whose swamp share is at least 55 % — the archipelago-only gate — takes the
cell to **24/32** and leaves every other relay cell byte-identical.

| scope                                                       |       shipped default | `BOT3_MCROWN2_SHALLOW=55` |              Δ |
| ----------------------------------------------------------- | --------------------: | ------------------------: | -------------: |
| seeds 1–16, `relay/archipelago/fog/multi` (32 games)        |     19/12/1 (59.4 %)  |      **24/7/1 (75.0 %)**  | **+15.6 pp**   |
| seeds 1–16, `relay/archipelago/clear/multi` (32 games)      |     21/11/0 (65.6 %)  |          21/11/0          |        0.0 pp  |
| seeds 17–32, `relay/archipelago/fog/multi` (independent)    |     18/14/0 (56.3 %)  |      **21/11/0 (65.6 %)** |  **+9.4 pp**   |
| seeds 17–32, `relay/archipelago/clear/multi` (independent)  |     16/13/3 (50.0 %)  |          16/13/3          |        0.0 pp  |
| seeds 1–16, all 8 relay multi cells (256-game screen)       | 173/78/5 (67.6 %)     |     **178/73/5 (69.5 %)** | **+5 wins**    |
| full 2048-game matrix, relay half (512 games)               |          350 wins     |         **355 wins**      | **+5 wins**    |
| full 2048-game matrix, paired on this machine               | 1740/256/52 (85.0 %)  |     **1743/251/54 (85.1 %)** | **+3 wins** |

Both archipelago multi cells are now at or above 21/32 in the 32-game matrix
(arch fog 24, arch clear 21), the relay half gains 5 wins with **zero relay
regressions**, and the switch is **off by default**: with no environment
variables the 256-game screen reproduces the shipped 173/256 byte for byte
(0.0 pp, 0 flips, verified by diffing the jsonl).

## What changed

One mechanism, one switch, all in `./mcrown2`:

* **`BOT3_MCROWN2_SHALLOW`** (percent, default `0` = off). When the board's
  swamp share is at least this percent, the bank's effective `hop` is lowered
  from 3 to 2 for that game. Everything downstream reads the effective config —
  the pick (`vaultOk`/`pickVault`), the basin walk (`deepBasin`), the redirect of
  the planner's own rear merges (`applyMcrown2`) and the per-tick feed
  (`mcrown2Orders`) — so the whole band moves together, not just the pick.
  The value is read every call (like every other knob), the effective config is
  a **new object only when the gate fires** (`cfg === config` otherwise), and
  `shallow = 0` never even calls `swampShare()`, so the shipped path is
  byte-identical by construction.

A second knob was added while measuring the same failure and is left off:

* **`BOT3_MCROWN2_MINBANK`** (army, default `0` = the shipped 50). A city is only
  bought once the bank can pay for **both** builds of the crown (100 army), so a
  bank that would starve at the city spends nothing instead of leaving a 50-army
  hole. Measured **+1 win** on the archipelago fog cell on its own (19 -> 20) and
  **no change** on top of the shallow band (24 either way), because the shallow
  band fixes the starvation itself. Kept as a switch so the negative is
  reproducible.

## Why the shallow band wins — the bank pick was completing or failing, and the failures were all at hop 2

Per-tick bank traces (`BOT3_MCROWN2_TRACE=1`, now stamped with the owning team,
one game per process through `./archfog-probe.cjs`) on all 32 arch fog games:

| bank outcome at the shipped band (hop 3) | games | record |
| ---------------------------------------- | ----: | -----: |
| no vault picked                          |    13 | 11W / 2L |
| vault picked, crown completed            |    10 | 8W / 1L / 1T |
| vault picked, **never completed**        |     9 | **0W / 9L** |

A crown is the only compounding income on this board (+1 army/tick; a plain pays
+1 per 50 ticks and swamp pays nothing), so the pick's completion is the game.
With the shallow band the same 32 games are:

| bank outcome with `SHALLOW=55` | games | record |
| ------------------------------ | ----: | -----: |
| no vault picked                |    13 | 11W / 2L |
| vault picked, crown completed  |    15 | 13W / 1L / 1T |
| vault picked, never completed  |     4 | 0W / 4L |

15 completions instead of 10, and the five new crowns are exactly the five
flipped games (seeds 3 both seats, 7 s0, 8 s0, 9 s0).

The trace of one failure shows where the army is. `relay/archipelago/fog/multi`,
`bot3-baseline-12`, seat 1 (loss at t256 with **164 land against 51**):

| tick | bank cell 223 | our army at hop >= 4 | event |
| ---: | ------------: | -------------------: | ----- |
| 103 | 1 (pick)      | 35 | vault picked: army 102 vs rival 110, land 81 vs 84 |
| 145 | 39            | 63 | the basin's one pulse is being collected |
| 153 | 48 -> city    | **28** | first build: 50 army spent, `b@223` |
| 154+ | 2, then 7…14 for the next hundred ticks | 24-32 | **no donor left at hop >= 3**, feed fires 0-2 times a tick |
| 256 | city, never a crown | — | home crown (1 army) is taken by a hidden rival stack |

The first 50-army build consumes most of the basin (82 -> 28 army at hop >= 4)
and the army that would pay for the second 50 sits one hop shallower (hop 2),
which the round-18 band never taps. The shallow band lets the same pick finish:
the crown arrives ~30-40 ticks later than an early completed pick, and the game
is decided by income instead of by a single 1-army crown.

Two structural notes that came out of the same census:

* **The pick is a selection effect, not a curse.** The bank's `behind` gate only
  starts a vault when our army trails the rival's, which is why the 9 failed
  picks are all losses: the picks happen in the games already going wrong.
  Banking is still the right response — the completed-crown record is 13W/1L/1T.
* **The failure is an archipelago failure.** Mediterranean fog (36-47 % swamp)
  gets the same 50-army hole but a different follow-up economy, and its cell is
  already 30/32; the 55 % gate keeps the shallow band off it (measured 0.0 pp,
  0 flips on all three other fog cells).

## Direction 1 — island crowns in a multi fog room: structurally dead

`./archipelago` `BOT3_ARCH_CROWN` (a fully owned, rival-free island may raise a
crown without the usual `develop`/`buildingStart`/100-army gates) is serial-only
today: `archipelagoUpdate` returns `IDLE` in a multi room unless
`BOT3_ARCH_MULTI=1`. Making it legal in multi and measuring it:

| variant (arch fog multi, 32 games) | W/L/T | flips |
| ---------------------------------- | ----: | ----: |
| `ARCH_CROWN=1 ARCH_MULTI=1` (crown only) | 19/12/1 | 0 (byte-identical) |
| the same on top of `SHALLOW=55`          | 24/7/1  | 0 (byte-identical) |

The rule cannot fire. Its outer gate is still `units[i] >= 50` on a **plain**
cell, and the only 50-army stack that ever exists on this board is the crown
bank's own vault — where `mcrown2` issues the city/crown build itself, and where
the planner's build candidate loses the matching loop to the layer's appended
order. Every fully-owned island (596 of 669 sampled ticks have at least one)
holds at most **50** army, and that is the vault. So the mechanism is inert in
multi with or without the bank: the measured crown tick and land/army trajectory
are identical to the run without it.

## Direction 2 — two banks on one board: the gates are not additive

The clear-room geometry bank (`./bankgate`) is fog-gated off (`DEFAULT_FOG = 0`)
and the fog bank (`./mcrown2` + `BOT3_FOGBANK`) is clear-gated off, so the split
of the rear army by room is what shipped in round 19 (+4 wins). Combining them on
the fog archipelago board, and giving the fog bank a second crown, both lose:

| variant (arch fog multi, 32 games) | W/L/T | Δ |
| ---------------------------------- | ----: | -: |
| shipped (one fog bank)             | 19/12/1 | — |
| `BOT3_BANKGATE_FOG=1` (both banks) | 17/14/1 | **-6.3 pp** |
| `BOT3_MCROWN2_CROWNS=2` (second crown) | 11/21/0 | **-25.0 pp** |

The two banks tap the same rear army, and the census says there is only one
bank's worth of it: the layer's own gather is drained by the first crown (the
hop >= 4 pool falls 82 -> 28 in the tick of the first build). A second crown
costs another 100 army the board does not have, and both together starve the
front. The useful version of "two banks on one board" is not a second crown, it
is **one bank that finishes** — which is the shallow band.

## Direction 3 — the swamp economy: there is nothing to price

The archipelago fog board is 64-67 % swamp and swamp pays no income, so the
direction asked whether the planner spends captures on swamp cells that only buy
vision. Probe (`./archfog-probe.cjs`, all 32 arch fog games, every order in a
25-tick window classified by the terrain of its target):

| order kind (32 games)             |  orders |      army |
| --------------------------------- | ------: | --------: |
| own-cell merges (bank feed + planner merges) | —  | **8611** |
| neutral swamp captures            |     116 |       186 |
| …of which reveal no unseen cell (pure interior paint) | — | 63 |
| neutral plain captures            |    2240 |       —   |

Neutral **swamp captures** are 3.6 orders and 5.8 army per game — two and a half
orders of magnitude less army than the merges — so the archipelago problem is
not paint spent on swamp, it is where the merged army is *kept* (the hop band
above). Pricing a swamp capture by the land it opens was still measured with the
existing mechanism, `BOT3_ARCH_WATER=1 ARCH_MULTI=1` (a swamp capture that does
not shorten the distance to unclaimed plain is capped at 18):

| variant (seeds 1–16) | arch fog multi | arch clear multi |
| -------------------- | -------------: | ---------------: |
| shipped              | 19/12/1        | 21/11/0          |
| `ARCH_WATER=1 ARCH_MULTI=1` | 20/11/1 (+3.1 pp) | **18/13/1 (-9.4 pp)** |

The cap is at most a 1-game effect and it costs 3 games in the clear room (where
the fog-specific valuation does not apply), which matches the 6 army/game bound:
there is no army in this lever.

## Honest negatives

Every measured variant of this round on `relay/archipelago/fog/multi` (32 games,
seeds 1–16; the clear cell in brackets when it moves):

| variant | W/L/T | verdict |
| ------- | ----: | ------- |
| shipped (round-19 fog bank) | 19/12/1 | — |
| `BOT3_MCROWN2_CROWNS=2` | 11/21/0 | a second crown costs 100 army the board does not have |
| `BOT3_BANKGATE_FOG=1` | 17/14/1 | two banks tap the same rear army |
| `BOT3_ARCH_WATER=1 ARCH_MULTI=1` | 20/11/1 (clear 18/13/1) | swamp captures are 6 army/game; loses 3 clear games |
| `BOT3_ARCH_CROWN=1 ARCH_MULTI=1` | 19/12/1 | inert: no 50-army stack off the bank's own vault |
| `BOT3_MCROWN2_MINBANK=100` | 20/11/1 | +1, no change on top of the shallow band |
| `BOT3_MCROWN2_HOP=2` (ungated) | 24/7/1 | same as the gated switch **on this cell**; the swamp gate is what keeps it off mediterranean/random/maze fog |
| `BOT3_MCROWN2_SHALLOW=55` | **24/7/1** | shipped as a default-off switch |
| `SHALLOW=55` + `ARCH_CROWN/MULTI` | 24/7/1 | island crowns still inert on top |

## Switches

| variable | default | effect |
| -------- | ------- | ------ |
| `BOT3_MCROWN2_SHALLOW` | `0` (off) | swamp share (percent) above which the bank gathers from hop >= 2 instead of hop >= 3 |
| `BOT3_MCROWN2_MINBANK` | `0` (off) | army the bank must hold before the *city* build (0 = the shipped 50; `100` = wait for both builds) |
| `BOT3_MCROWN2_TRACE` | off | per-tick bank census; round 20 also records the owning team in each trace row |

## Verification

* `node --test bot-template/relay-bot/strategy.test.cjs` → **125/125 pass**, including
  two new tests: the switch defaults/clamping, and "shorten the bank band to hop
  2 only on a swamp board" (the effective hop is 2 with `SHALLOW=55` on a 60 %
  swamp strip and the hop-2 cell becomes the pick; a 0 % swamp strip keeps the
  round-18 band and the very config object it was given).
* **Byte-identical when off.** With no environment variables the 256-game relay
  multi screen reproduces the recorded baseline exactly (173/256, 0.0 pp on all
  8 cells, 0 flips) and `diff` on the jsonl against the earlier run is empty.
* **Screen, seeds 1–16, 256 games:** 173 → **178** wins; the only cell that moves
  is archipelago fog multi (19 → 24, 5 loss→win flips, no win→loss), the other
  seven are 0.0 pp with zero flips.
* **Independent half, seeds 17–32, 128 games (paired against my own off run on
  the same machine):** archipelago fog 18 → **21** (+9.4 pp, 3 loss→win, 0
  win→loss), archipelago clear 16 → 16. Both halves agree in sign and size.
* **Full matrix, 2048 games:** relay half 350 → **355** wins; 15 of the 16 relay
  cells are byte-identical and the sixteenth is the target cell (19 → 24). Total
  1743/251/54 (85.1 %) against the shipped 1739/254/55.
* **Reproducibility note (v2 is nondeterministic).** The non-relay flips in the
  full-matrix comparison are all `v2` single-line fog cells, and they are not
  caused by this change: two identical runs of `OPPONENTS=v2 MODES=010` differ in
  **13 of 96 games**. The on-machine control (switch off) itself differs from the
  recorded file in 3 v2 single fog games. All 5 relay flips of the candidate are
  `relay/archipelago/fog/multi` loss→win.
* **CPU per tick:** nothing is added to a search or to any per-tick loop. The
  switch only changes the integer the existing hop comparisons test against, and
  the `swampShare()` walk is skipped entirely when it is 0. End-to-end the
  2048-game matrix took 6007 s (off) and 6171 s (on) on this machine (+2.7 %),
  which is run-to-run variation plus longer games: the five converted games are
  won at t470-818 instead of lost at t219-615, and timeouts go 52 → 54.

## How to reproduce

```sh
# the target cell, switch on and off
OPPONENTS=relay MAPS=archipelago MODES=001,011 SEED_FROM=1 SEED_TO=16 WORKERS=6 \
  OUT=data/scratch/arch.jsonl SUMMARY=data/scratch/arch-summary.json \
  BOT3_MCROWN2_SHALLOW=55 node bot-template/relay-bot/training/evaluate-matrix.cjs
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/arch.jsonl

# the probe: one game, per-tick land/army/crowns/isolated, order mix, bank trace
BOT3_MCROWN2_TRACE=1 SEED=bot3-baseline-12 MAP=archipelago MODE=011 SEAT=1 \
  node bot-template/relay-bot/archfog-probe.cjs
```
