# Multi-line: exact next-tick simulation, relay queue prediction, outcome search

This record covers the `exp/bot3-r14-multisearch` investigation: the multi-line
cells are an exact mirror of relay (both seats run the same policy, the engine is
deterministic after map init, so every `(seed, map, fog)` pair produces one win
and one loss -- `63/63/2` over 128 games, `123/123/10` over 256). Every
hand-tuned score knob measured neutral or negative, so this branch tests the one
remaining shape: **evaluate the actual next tick** instead of pricing orders.

Three modules, all **off by default**:

| module       | role                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `msim.js`    | pure one-tick simulator of the engine (growth, multi-line queue, attacks) |
| `mqueue.js`  | predicts relay's sixteen-order batch by replaying its planner on a shadow |
| `msearch.js` | searches a bounded set of order sets for the best simulated next tick     |

`BOT3_MSEARCH=1` turns all three on (multi-line, clear rooms only). Every knob
is listed at the end.

## 1. `msim.js` — the simulator

Rules modelled, in engine order (`src/game-engine.ts` `gameTick`,
`src/game-engine/tick-growth.ts`):

1. **Growth.** Crown `+1` every tick; city `+1` and plain `+1` on
   `turn % 50 === 0` while not isolated; swamp never; the single-line burst
   (turns 26..50, `+1` on normal plains) is **off in multi-line rooms**.
2. **Queue execution** in seat order, reversed on odd ticks. Multi-line: every
   move order whose `from` is not the target of another queued move executes one
   step in seq order; invalid orders are discarded; a pure cycle (nothing can be
   peeled) forces its lowest-seq member; a build waits while its cell is the
   `from` of any queued move. Single-line is modelled too (head of the queue
   until one order executes) so the same module can be used for both.
3. **Attack.** `computePush` verbatim (mode 2 pushes `army - 1`, mode 0 keeps
   `defense + 1` where defense sums `army - 1` over the other three neighbours,
   mode 1 half of the surplus); capture iff push > garrison; a failed assault
   trades 1:1 and keeps the owner; captured buildings are destroyed; capturing a
   player's last crown tears that empire down (halve, isolate, empty cells go
   neutral) and ends the game.
4. **Connectivity**, last: per team, BFS from crowns/cities; a newly severed cell
   halves immediately and is flagged, decay starts at tick 11 of the isolation at
   5% every recorded turn, and a reconnected cell doubles unless the pocket was
   reinforced by a move into it.

Validation. A `/tmp` harness drove the **real** `dist/game-engine` with random
but plausible order batches (both sides, up to 16 orders per tick, extra chained
orders so the queue has to hold one back, occasional builds) and compared the
whole board -- encoded grid, army, isolated -- after **every** tick:

| boards                                              |   cells | ticks/run | runs | chained ops | mismatched ticks |
| --------------------------------------------------- | ------: | --------: | ---: | ----------: | ---------------: |
| random / maze / archipelago / mediterranean, multi  | 221-255 |       200 |    4 |  75 per run |            **0** |
| random / maze / archipelago / mediterranean, single | 221-255 |       200 |    4 |           - |            **0** |
| random large, multi                                 |     891 |       300 |    1 |         561 |            **0** |
| random large, single                                |     891 |       300 |    1 |           - |            **0** |

That is ~380k cell-tick comparisons in the scripted harness with no divergence,
including the tick-50/-100 growth steps, isolation halving and decay, crown kills
and teardown, plus the ~9 000 real-game frames the predictor verification replays
end to end (see below). The simulator is not shipped with a `dist` dependency --
`dist/` is only used by the `/tmp` harness.

## 2. `mqueue.js` — relay's batch, one tick early

`./shadow` already replays relay's `chooseOrders` for serial rooms. The
multi-line addition is the queue: relay emits up to sixteen orders only when its
pending queue is empty, and the engine keeps the ones that were not eligible on
the tick. `mqueue` rebuilds that queue with `msim` and predicts the whole batch
in flight on the next tick.

Verification gate (mandatory, like the serial shadow layer): each frame the model
replays the tick that just resolved from the snapshot it took -- growth, our own
recorded orders and the predicted batch in seat order, then connectivity -- and
compares the **entire board** with the frame the engine produced. One unexplained
cell disables the layer for the rest of the game; `BOT3_MSEARCH_ARM` (default 6)
consecutive exact frames arm it. Fog rooms and serial rooms are refused up front
(the rival's private board is unobservable in fog, and the serial case belongs to
`./shadow`).

Measured accuracy: **2917/2917 frames exact** (8 games) and **5610/5610** (6
more games) with `drift = 0`; the same 100% held in every single-game probe
(739/739, 740/740, 414/414). Relay's queue always drains in one tick
(`leftovers = 0` over 2900+ batches, average batch 9.5 orders), i.e. relay's own
sixteen orders are disjoint as well. Because the gate compares the whole board, a
wrong prediction that happens to be equally invalid would still pass -- that is
the residual risk, and the drift counter has never fired in a relay duel.

## 3. `msearch.js` — search the tick, not the score

At a frame the planner has already produced `candidates` (score-sorted). The
search builds alternative order sets and simulates `turn + 1` for each, against
the predicted relay batch:

1. the planner's own set (the baseline for the comparison),
2. the planner's set with one of the next `force` candidates forced in (the
   sixteen slots are a matching, so one order can displace two),
3. the planner's set with its weakest order dropped and the slots refilled,
4. orders the planner **cannot** propose in a multi-line room -- its candidate
   loop only offers captures it can already make (`front`/`siegeValue` are
   clear-_serial_ only), so the search synthesises (a) the counter-capture of a
   cell relay is about to empty, only when relay resolves first, and (b) a
   reinforcement of a crown relay is about to take, only when we resolve first.

The winning set is adopted only when it beats the planner's own set by
`BOT3_MSEARCH_MARGIN`. Adoption re-orders the candidate list, so the planner's
untouched greedy `take` loop still builds the result and every side effect
(`lastFrom`/`lastMove`/lane memory) stays exactly as it was. The value of a
simulated board is `armyDiff + crown * crownDiff + land * landDiff + cut *
(isolationDiff) [+ march * positionalTerm]`, with `+/-1e7` for a finished game.

Measured cost (one core, 6 games, `BOT3_MSEARCH_STATS=1`):

| step                     |   per tick |
| ------------------------ | ---------: |
| relay planner replay     |    0.27 ms |
| search (9.4 simulations) |    1.31 ms |
| **total**                | **1.6 ms** |

A 1000-tick game costs ~0.6 s more; the batch runner went from 3.5 s to 7.3 s for
8 games.

## Measured result: no net gain, default off

Screen command (all evaluation in the foreground, `WORKERS=2`):

```sh
BOT3_MSEARCH=1 WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay MODES=001,011 \
OUT=/tmp/ms-s16.jsonl SUMMARY=/tmp/ms-s16.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/ms-s16.jsonl
```

| map           | fog | games | candidate W/L/T | recorded baseline |       Δwin |
| ------------- | --- | ----: | --------------- | ----------------- | ---------: |
| archipelago   | off |    32 | 15/16/1         | 15/15/2           |      0.0pp |
| archipelago   | on  |    32 | 15/15/2         | 15/15/2           |      0.0pp |
| maze          | off |    32 | 16/16/0         | 16/16/0           |      0.0pp |
| maze          | on  |    32 | 16/16/0         | 16/16/0           |      0.0pp |
| mediterranean | off |    32 | 13/16/3         | 14/14/4           |     -3.1pp |
| mediterranean | on  |    32 | 15/15/2         | 15/15/2           |      0.0pp |
| random        | off |    32 | 14/18/0         | 16/16/0           |     -6.3pp |
| random        | on  |    32 | 16/16/0         | 16/16/0           |      0.0pp |
| **total**     |     |   256 | **120/128/8**   | **123/123/10**    | **-1.2pp** |

The fog cells are a free control: the layer refuses fog rooms, and all four fog
cells are byte-identical to the recorded baseline. The eight-seed screen
(`/tmp/ms-s8.jsonl`) was `62/64/2` against `63/63/2` (`-0.8pp`).

Why it cannot beat the mirror, measured:

- **The sixteen slots are not the bottleneck.** Relay's average batch is 9.5
  orders of 16 (29 123 orders over 2 925 batches), so re-matching the candidate
  set displaces orders instead of adding value.
- **The search rarely wants to deviate, and when it does it does not matter.**
  With `MARGIN=0` (adopt every strictly better simulated state) it changes the
  plan on 95 of 2717 ticks (3.5%); the default margin changes it on ~4%. In the
  256-game screen that moved the tick-50 checkpoint in 3 of 128 games.
- **The value weights are not the limit.** Four materially different
  configurations (`BOT3_MSEARCH_MARCH=0.3`, `=2`, `BOT3_MSEARCH_CROWN=200`,
  `MARGIN=0 SIMS=16`) all produced the identical `31/33/0` on the four-seed
  screen: the argmax set is insensitive to the value function, so tuning it is
  not the missing piece.
- **What decides these games is not a single tick.** The recorded measurement
  (`NEXT.md`) is that army at tick 50 explains ~87% of multi-line results, and
  the typical loss is an economic one (a lone 1-2 army crown flipped after a
  land win). Both are multi-tick trajectories that a one-tick search cannot
  price: the planner already takes every capture it can reach, so the search's
  only additions are reaction moves that trade army for the same land.

The synthesized reactions do work when they are worth anything -- the unit tests
force the case where relay's last crown empties itself and the counter-capture
ends the game, and the search adopts it -- but in real relay duels that situation
does not arise, because relay never walks a crown garrison out of its crown.

## Switches

| variable                                     | default    | effect                                    |
| -------------------------------------------- | ---------- | ----------------------------------------- |
| `BOT3_MSEARCH`                               | off        | the whole layer (predictor + search)      |
| `BOT3_MSEARCH_ARM`                           | 6          | exact frames required before arming       |
| `BOT3_MSEARCH_CROWN`/`_LAND`/`_CUT`/`_MARCH` | 30/1/0.5/0 | value weights                             |
| `BOT3_MSEARCH_MARGIN`                        | 1          | value a set must gain to replace the plan |
| `BOT3_MSEARCH_SIMS`/`_FORCE`/`_EXTRA`        | 10/6/4     | simulation budget per tick                |
| `BOT3_MSEARCH_STATS`                         | off        | print predictor/search counters on exit   |
| `BOT3_MSEARCH_TRACE`                         | off        | print the first drift cell of a game      |

## Risks

- **Ship state.** The layer is off by default and measured `-1.2pp` when on, so
  it must not become the default. What ships is the validated simulator and the
  predictor: they are the reusable part (`./msim` is the only exact one-tick
  model of the multi-line queue in the tree).
- **Prediction scope.** Clear 1v1 rooms only. Fog hides relay's board, so the
  batch cannot be predicted _or_ verified there; the four fog cells are untouched
  by construction.
- **Residual correctness risk.** The verification gate compares the whole board,
  so an equally-invalid wrong prediction would pass silently. Over 9 000 frames
  of relay duels the drift counter never fired.
- **CPU.** 1.6 ms/tick (`+0.6 s` per 1000-tick game). The evaluation harness has
  no per-decision budget, but a hosted bot with a dwell cap should keep the layer
  off or lower `BOT3_MSEARCH_SIMS`.

## Reproduce

```sh
# simulator vs the real engine (needs a build; /tmp harness, not shipped)
cd C:/Users/reson/Downloads/fork/Roka-bot3-r14-multisearch && pnpm run build
MODE=random MULTI=1 TICKS=200 node /tmp/msim-check.cjs
MODE=maze MULTI=0 TICKS=200 SIZE=large node /tmp/msim-check.cjs

# prediction accuracy and search cost
BOT3_MSEARCH=1 BOT3_MSEARCH_STATS=1 SEEDS=bot3-baseline-1 TICKS=1000 \
OPPONENTS=relay MAPS=random MODES=001 SELF_ID=bot3 \
RELAY_ENTRY=../bot-template/bot-3.0/strategy node scripts/evaluate-bot3.cjs

# screen and full multi-line matrix (see the table above)
BOT3_MSEARCH=1 WORKERS=2 SEED_FROM=1 SEED_TO=16 OPPONENTS=relay MODES=001,011 \
OUT=/tmp/ms-s16.jsonl SUMMARY=/tmp/ms-s16.json node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/ms-s16.jsonl

node --test bot-template/bot-3.0/bot3.test.cjs
```
