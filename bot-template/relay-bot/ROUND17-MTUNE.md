# Round 17 — self-play-tuned multi-line evaluation (`BOT3_MTUNE`)

Round 17 was chartered on one observation: six rounds of hand-designed multi
doctrines each moved 6–12 wins in sample and decayed to zero on the independent
seed half, because each one perturbed a knife-edge exchange without a systematic
bias. The project's own analysis named the missing piece as "a strictly stronger
multi policy, for example a 2–3 ply search with a self-play-tuned evaluation".
This round does the **tuning half** of that sentence, cheaply and honestly: one
JSON blob owns every multi-line score band, and a search tunes them against the
real engine.

**Result up front.** The harness works, is resumable, and reproduces the engine
bit for bit. The *tuning* does not pay: 107 configurations over the 128-game
train block span `60..70` wins (46.9 %–54.7 %), the best in-sample set gains
`+4/256` on the screen, `+1/256` on the never-tuned 17–32 half, and regresses four
motor cells on the full matrix for a net `+0` win. No cell reaches the 65 % bar;
the best is `mediterranean/clear 20/32` (62.5 %). The switch ships **off**, and
the honest conclusion is that the remaining headroom in relay multi rooms is not
in *prices* — it is in mechanics (multi-feed, fanned fronts) or in a real search,
both of which the round-17 sibling experiments own.

## What was built

- `mtune.js` (new, ~430 lines): the parameterisation. It creates no candidate,
  drops no candidate and executes no order of its own; it moves the score of
  candidates the planner already proposed, from one blob, and forwards five
  layer knobs to `mshape`/`mhalf`. With `BOT3_MTUNE` unset — or with the *base*
  blob — the planner is byte-identical to round 16 (verified: the 256-game
  relay multi screen with `BOT3_MTUNE=1 BOT3_MTUNE_JSON='{}'` is `diff`-clean
  against the run with the switch off, `data/scratch/s256-off.jsonl`).
- `bot-template/relay-bot/training/tune.cjs` (new): the harness. `eval` runs one weight blob
  over a seed block through the real acceptance entry (`bot-template/relay-bot/training/evaluate.cjs`,
  the same engine and the same per-seed shards as `training/evaluate-matrix.cjs`);
  `pass` is coordinate descent over a coarse-to-fine grid; `random` is a
  random-restart block over 2–5 knobs at once; `report` prints the search log.
  Every evaluation is content-hashed and appended to `data/scratch/tune-log.jsonl`,
  so a pass resumes for free and no config is ever paid for twice.
- `bot-template/relay-bot/training/evaluate.cjs`: one change, `CHECKPOINTS` (default
  `24,25,50,100,250`, unchanged output). The tuner adds `t150` because the
  fitness tie-break is the land+army margin at the tick the mirror exchange
  breaks (t≈100–115).

## The weights

Fourteen score weights plus seven layer knobs; each is a number, none is a new
mechanic. `BASE` is the round-16 value, which is why the base blob is a no-op.

| weight | base | band | what it prices (engine terms) |
| --- | ---: | --- | --- |
| `capture` | 0 | −40..80 | additive to a neutral capture (`32 + opens*2 + remaining*1.3` inherited). Land is the only recurring income in a multi room (a plain pays +1 at t=50,100,…). |
| `hostile` | 0 | −40..160 | additive to a rival-cell capture: a two-cell land swing (ours +1, theirs −1) that also stops its pulse income. |
| `ring` | 0 | −8..24 | per plain neutral neighbour the captured cell keeps open, capped at 4 — the round-15 `ring`/`hole` idea as a price instead of a rule. |
| `cut` | 0 | −4..20 | `min(600, sqrt(cutValue) * cut)` for a rival cell that is a cut vertex of the rival territory: `applyConnectivity` halves a severed pocket and stops its production. |
| `pulse` | 0 | −60..120 | captures are worth `pulse * max(0, 1 - (turn % 50)/20)`: full weight at the t=50/100/… pulse, zero twenty ticks later. Prices "spend the pulse army into land now". |
| `merge` | 0 | −80..120 | additive to an own merge whose target is behind the frontier ring (`hop > 0`): buys no land this tick. |
| `lateral` | 0 | −40..80 | additive to a frontier→frontier merge (`hop 0 → hop 0`): the one direction the inherited `frontDist` rule cannot propose. |
| `march` | 0 | −40..120 | additive to a merge that steps down the rival-crown distance field (the gather before the endgame). |
| `defence` | 0 | −400..400 | additive to every candidate already scoring ≥ 500 (defence/rescue/siege band), so a defensive tick can be traded against the land race. |
| `reload` | 60 | 0..200 | `mhalf.reload`: arming a spent ring cell (holds 1 army, cannot fire) up to the 3-army fire threshold. |
| `hop` | 6 | 0..20 | `mhalf.hop`: how much a delivery loses per hop behind the ring. |
| `retain` | 0 | 0..2 | `mhalf.retain`: per-capture mode policy (mode 1 half push keeps a rolling garrison). |
| `floor` | 2 | 2..8 | `mhalf.floor`: army a capture must leave behind for `retain` to apply. |
| `minFire` | 3 | 2..8 | `mhalf.minFire`: army a ring cell needs before arming it is worth a slot. |
| `cheap` | 0 | 0..60 | `mhalf.cheap`: prefer captures that cost no army (an empty cell). |
| `water` | 0 | 0..80 | `mshape.water`: charge for a swamp capture (swamp pays no pulse income) — the archipelago cells. |
| `corridor` | 0 | 0/1 | `mshape.corridor` + `mhalf.corridor`: let the layers run in a maze room at all. |
| `start` | 0 | 0..150 | `mhalf.startTurn`: first tick the routing layer prices merges. |
| `end` | 0 | 0..600 | `mhalf.endTurn`: tick it hands the game back (`0` = never). |
| `slots` | 64 | 1..64 | `mshape.slots`: order-cap behaviour (16 inherited, 64 unlimited). |
| `lead` | 110 | 80..200 | `mshape.leadCap` / `mhalf.leadCap`: stand down once our land leads by this percent of the rival's. |
| `steal` | 100 | 0..600 | `mshape.steal`: how far a plain merge is pushed below the capture it would invalidate. |

Config line used for every measurement below (the frozen set):

```sh
export BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110
export BOT3_MHALF=1
export BOT3_MTUNE=1
export BOT3_MTUNE_JSON=data/scratch/mtune-frozen.json   # {"hostile":-15,"start":30}
```

`BOT3_MTUNE_JSON` is a path or an inline object; unspecified keys are the base
values above. Unknown keys throw (a typo must not silently tune nothing) and a
malformed blob falls back to the base numbers with `config.error` set, so a
broken file cannot take the bot down mid-game.

## Why the prices do not bind

This is the mechanism the round measured, and it explains every flat table
below. In a multi room the inherited planner already proposes **every** legal
edge: for each of our cells that holds two army, every non-own neighbour. With
`mshape.slots=64` the cap never binds — the screen executes **9.10 orders per
tick** (bot3) against a cap of 64 over 256 games (`executed[seat] / tick` from
`data/scratch/s256-off.jsonl`; relay executes 8.70). A score therefore only
decides two things:

1. the ~40-candidate growth-pulse ticks, where the cap can bind (this is the
   `mshape` `+7`, already taken in round 15);
2. **conflicts** — `take()` allows one order per source and per target, so two
   candidates that share an endpoint are not both executed.

Everything else executes regardless of its rank. That is why the price bands
saturate immediately: on seed 5, `capture:+80` and `capture:+200` produce a
**byte-identical** `jsonl` (`md5 fcd9036c…`, `data/scratch/cap80.jsonl` vs
`cap200.jsonl`) — at +80 the neutral capture already outranks every merge, and a
larger number cannot buy anything. `capture:-10` and `capture:10` do differ, so
the band is live; it is just narrow.

## The search

Protocol: **train on seeds 1–8** (128 games, the eight relay multi cells × two
seats), **select on 9–16** (independent half), **confirm on 17–32** (never
touched by any decision). Fitness is wins; ties go to the worst cell, then to
the mean land+army margin at t150. A coordinate only moves on `+2` wins, since
one game in 128 is a single flipped seed.

Budget: 142 evaluations (~16 s per 128-game eval at 6–8 parallel seed shards,
~40 min of wall clock end to end). Throughput is CPU-bound at ~24 cores, so
lanes beyond three buy nothing.

| block | evals | wins range | median |
| --- | ---: | --- | ---: |
| seeds 1–8 (train, 128 games) | 107 | 60..70 (46.9 %..54.7 %) | 67 (52.3 %) |
| seeds 1–2 (liveness/saturation probes, 32 games) | 27 | 10..18 | 16 |
| seeds 9–16 (selection, 128 games) | 6 | 66..70 | 69 |
| seeds 17–32 (confirmation, 256 games) | 2 | 119..120 | 119.5 |

Search shape actually used: one-at-a-time screening (2 directions per knob), a
coarse coordinate sweep of all 21 knobs in two groups, then 28 random-restart
candidates that move 2–5 knobs jointly (the hypothesis this round was chartered
for: a config that is only good as a set). The joint block did **not** escape the
one-at-a-time range: `63..69`, none above the `69` start.

### In-sample single-knob sweep (the honest negatives)

Group A starts from the base (`67/128`), group B from the accepted `hostile=-15`
(`69/128`). Every row is the best value of that knob's coarse grid; a value equal
to the start means the whole grid was worse or tied (`0` wins for the knob).

| knob | values tried | best | wins/128 | Δ |
| --- | --- | ---: | ---: | ---: |
| `capture` | −20..20 | −10 | 68 | +1 |
| `hostile` | −15..30 | −15 | 69 | **+2** |
| `ring` | 0..12 | 0 | 67 | 0 |
| `cut` | 0..6 | 0 | 67 | 0 |
| `pulse` | 0..60 | 40 | 68 | +1 |
| `merge` | −30..15 | 0 | 67 | 0 |
| `march` | 0..50 | 0 | 67 | 0 |
| `reload` | 20..120 | 120 | 69 | 0 (tie) |
| `hop` | 0..10 | 6 | 69 | 0 |
| `retain` | 0..2 | 0 | 69 | 0 |
| `floor` | 2..4 | 2 | 69 | 0 |
| `minFire` | 2..4 | 3 | 69 | 0 |
| `cheap` | 0..40 | 0 | 69 | 0 |
| `water` | 0..30 | 15 | 70 | +1 |
| `corridor` | 0/1 | 1 | 69 | 0 (tie) |
| `start` | 0..50 | 30 | 70 | +1 |
| `end` | 0..250 | 250 | 70 | +1 |
| `slots` | 16..64 | 64 | 69 | 0 |
| `lead` | 90..200 | 110 | 69 | 0 |
| `steal` | 0..200 | 100 | 69 | 0 |

Three knobs are **structurally dead**, not merely flat, and that is worth
recording because the round-15/16 notes predicted it:

- `lateral`: the planner only proposes an own merge when it *strictly* reduces
  `frontDist`, and every frontier cell sits at `frontDist 0`, so a
  frontier→frontier merge is never a candidate to re-price.
- `defence`: defence/rescue merges score ≥ 560 and are rare in an empire that is
  expanding every tick; ±100 and ±400 both moved zero wins on 128 games.
- `steal`/`floor`: `steal` is effectively binary (50, 100 and 200 give the same
  decisions: push the merge below the capture it would cancel) and `floor` is
  inert while `retain=0`, which the base ships.

The only knob that survived both the train block and the selection block is
`hostile=-15` — "a rival-cell capture is worth *less* than the inherited score
says, spend the slot on neutral land instead" — and its effect is +3 wins out of
128 in sample, +1 out of 128 on the independent half. That is one seed.

## Measured tables

Relay multi cells only (8 cells × 2 seats × seeds). `base` = round-16
`mshape+mhalf`, `frozen` = base + `{"hostile":-15,"start":30}`.

### Seeds 1–8 (train, 128 games): 67 → **70** (+3)

| cell | base | frozen | Δ |
| --- | --- | --- | ---: |
| archipelago/clear | 7/16 | 7/16 | 0 |
| archipelago/fog | 7/16 | 8/16 | +1 |
| maze/clear | 8/16 | 9/16 | +1 |
| maze/fog | 8/16 | 9/16 | +1 |
| mediterranean/clear | 8/16 | 9/16 | +1 |
| mediterranean/fog | 9/16 | 9/16 | 0 |
| random/clear | 11/16 | 10/16 | −1 |
| random/fog | 9/16 | 9/16 | 0 |
| margin t150 | +1.95 | +1.66 | |

### Seeds 9–16 (selection, 128 games): 69 → **70** (+1)

| cell | base | frozen | Δ |
| --- | --- | --- | ---: |
| archipelago/clear | 8/16 | 8/16 | 0 |
| archipelago/fog | 8/16 | 8/16 | 0 |
| maze/clear | 8/16 | 8/16 | 0 |
| maze/fog | 8/16 | 8/16 | 0 |
| mediterranean/clear | 11/16 | 11/16 | 0 |
| mediterranean/fog | 8/16 | 9/16 | +1 |
| random/clear | 10/16 | 8/16 | −2 |
| random/fog | 8/16 | 10/16 | +2 |
| margin t150 | +0.80 | +1.03 | |

### Seeds 1–16 (the 256-game acceptance screen): 136 → **140** (53.1 % → 54.7 %)

`NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/s256-frozen.jsonl
data/scratch/s256-off.jsonl`

| cell | base | frozen | Δ | 65 % bar |
| --- | --- | --- | ---: | --- |
| archipelago/clear | 15/32 | 15/32 | 0 | FAIL |
| archipelago/fog | 15/32 | 16/32 | +1 | FAIL |
| maze/clear | 16/32 | 17/32 | +1 | FAIL |
| maze/fog | 16/32 | 17/32 | +1 | FAIL |
| mediterranean/clear | 19/32 | **20/32** | +1 | FAIL (62.5 %) |
| mediterranean/fog | 17/32 | 18/32 | +1 | FAIL |
| random/clear | 21/32 | 18/32 | **−3** | FAIL |
| random/fog | 17/32 | 19/32 | +2 | FAIL |

Total `140/114/2` (54.7 %) against `136/114/6` (53.1 %): `+4` wins, `+1.6 pp`,
`lossToWin 6` / `winToLoss 4` / `timeoutToWin 2`. The bar is **not met in any
cell**, and `random/clear` — the only cell the round-15/16 base had pushed over
65 % — is the cell this config costs.

### Seeds 17–32 (never tuned on): 119 → **120** of 256

The block is simply harder: the *layers-off* reference on 17–32 is also
`119/256` (46.5 %), so this half is 46–47 % for every policy in play and the
frozen set is `+1` game on it.

| cell | base | frozen | Δ |
| --- | --- | --- | ---: |
| archipelago/clear | 12/32 | 13/32 | +1 |
| archipelago/fog | 15/32 | 15/32 | 0 |
| maze/clear | 15/32 | 15/32 | 0 |
| maze/fog | 16/32 | 16/32 | 0 |
| mediterranean/clear | 19/32 | 15/32 | −4 |
| mediterranean/fog | 12/32 | 14/32 | +2 |
| random/clear | 15/32 | 17/32 | +2 |
| random/fog | 15/32 | 15/32 | 0 |
| margin t150 | 0.00 | −0.16 | |

Direction of the effect: `+3` (train) → `+1` (selection) → `+1` (confirmation).
Consistently non-negative and consistently inside one seed. Pooled 1–32:
`255/512` (49.8 %) → `260/512` (50.8 %).

### Full 2048-game matrix

`WORKERS=8 node bot-template/relay-bot/training/evaluate-matrix.cjs` with the flag on, then
`NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/full-frozen.jsonl`.

| run | W/L/T | win rate |
| --- | --- | ---: |
| recorded baseline (layers off) | 1688/299/61 | 82.4 % |
| round-16 base (this worktree) | 1702/290/56 | 83.1 % |
| **round-17 frozen set** | **1702/293/53** | **83.1 %** |

Zero *net* regressions, but not clean cell by cell — the frozen set moves the
same 7 wins in each direction:

| cell | base | frozen | Δ |
| --- | --- | --- | ---: |
| anti/archipelago/multi | 32/32 | 30/32 | −2 |
| apex/archipelago/multi | 25/32 | 24/32 | −1 |
| v2/archipelago/fog+multi | 31/32 | 30/32 | −1 |
| relay/random/multi | 21/32 | 18/32 | −3 |
| (four cells gained) | | | +7 |

So the frozen set trades four motor cells for seven wins elsewhere and ends at
the same total. That is a failure of the "zero regressions" rule, not a pass.

### Where the motor regressions come from

The blame is the one adopted weight, not the frozen pair. Targeted run
(`OPPONENTS=anti,apex,v2 MAPS=archipelago MODES=001,011 SEED_FROM=1 SEED_TO=16`,
multi cells only, 192 games per row, `data/scratch/arch-*.jsonl`):

| cell | base | `hostile=-15` | `hostile=-15,start=30` | + `lead=100` |
| --- | --- | --- | --- | --- |
| anti/archipelago/clear+multi | 32/32 | 30/32 | 30/32 | 31/32 |
| anti/archipelago/fog+multi | 30/32 | 30/32 | 30/32 | 28/32 |
| apex/archipelago/clear+multi | 25/32 | 24/32 | 24/32 | 24/32 |
| apex/archipelago/fog+multi | 31/32 | 31/32 | 31/32 | 31/32 |
| v2/archipelago/clear+multi | 31/32 | 31/32 | 31/32 | 31/32 |
| v2/archipelago/fog+multi | 31/32 | 30/32 | 30/32 | 30/32 |

So the price that buys relay multi wins is exactly the price that costs the
already-won archipelago multi cells of the motor opponents: four wins out, four
wins in. The `leadCap`-style state gate cannot separate them — `lead=100` gives
back one cell and takes another (`−3` net on these six cells), and the gate is
already 110 on both layers, which the archipelago cells pass because the layers
are *earning* that land lead, not idling on it. There is no gate that keeps the
relay gain and drops the motor cost, which is the second reason the switch stays
off.

## Honest negatives (this round)

- **Weight tuning has no leverage in a multi room once the order cap is lifted.**
  107 in-sample configs span 60–70 wins; the ±3 band is one to three flipped
  seeds. The mechanism is measured: 9.1 executed orders per tick against a cap
  of 64, so a score only decides pulse-tick caps and source/target conflicts.
- **Joint re-pricing does not escape the single-knob range.** 28 random-restart
  candidates moving 2–5 knobs at once: 63–69, none above the 69 start.
- **The one adopted step does not generalise.** `hostile=-15` is +3 in sample,
  +1 on the independent half, +1 on the confirmation half, and its screen gain
  is entirely `random/fog +2 / med +2` against `random/clear −3`.
- **`capture` saturates at +80** (byte-identical to +200 on seed 5): the capture
  band is already above every merge at that point.
- **`lateral` and `defence` are structurally dead** (no candidates / no
  candidates in the band), as predicted by round 16's `frontDist` note.
- **The corridor gate is not the free two cells it looks like.** Enabling
  `corridor=1` moves maze 8→9 and 9→10 of 16 in sample (`+2`, 69/128 total) but
  the selection half gives `−1` on maze/fog, and the round-15 measurement
  (`0.0` to `−6.3 pp`) stands.
- **The 17–32 block is not a replication of 1–16 at any policy.** Layers off
  there is `119/256` (46.5 %); the base config is also `119/256`. Any round that
  reports a 1–16 gain without this reference is measuring the seed block.
- **Slots below unlimited lose games** regardless of price: `slots=32` −3,
  `slots=16` −7, `slots=4` −6 of 32 — the round-15 result reproduces and there is
  no compensating price that brings them back.

## Recommendation

**Branch-only. `BOT3_MTUNE` stays default off** (`BOT3_MTUNE=1` enables it and is
strictly opt-in; with it unset the 256-game screen is byte-identical). The
frozen set `{"hostile":-15,"start":30}` is recorded here rather than shipped
because it (a) misses the 65 % bar in every relay multi cell, (b) costs three
wins in `random/clear` on the screen, and (c) regresses four motor cells on the
full matrix for a net zero.

What the round leaves the project is the harness, not a doctrine: a resumable,
engine-exact way to ask "is this evaluation better?" for any multi weight — which
is what the next mechanism (multi-feed, fanned fronts, or a real 2–3 ply search)
will need to be scored, and which is cheap enough (~16 s per 128 games) to run
inside every future round.

## Reproducing

```sh
. data/scratch/base-env.sh                     # round-16 base (mshape + mhalf)
node --test bot-template/relay-bot/strategy.test.cjs # 99 tests, incl. the 5 new mtune tests

# byte-identity of the default path (switch off vs base blob)
OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean MODES=001,011 \
  SEED_FROM=1 SEED_TO=16 WORKERS=6 OUT=data/scratch/s256-off.jsonl \
  node bot-template/relay-bot/training/evaluate-matrix.cjs
BOT3_MTUNE=1 BOT3_MTUNE_JSON='{}' ...          # identical jsonl

# one evaluation / one search pass / the log
node bot-template/relay-bot/training/tune.cjs eval --weights data/scratch/mtune-frozen.json --from 1 --to 8
node bot-template/relay-bot/training/tune.cjs pass --stage coarse --lanes 3 --par 6
node bot-template/relay-bot/training/tune.cjs random --count 28 --picks 4 --seed 17
node bot-template/relay-bot/training/tune.cjs report --top 25
```
