# Round 16 — sustained pressure in multi-line rooms (`BOT3_MHALF`)

`mhalf.js` prices what a multi-line empire does with the army a growth pulse
leaves behind. It is **off by default** (`BOT3_MHALF=1` enables it). With the
variable unset the planner is byte-identical to the round-15 path: the same
screen replayed after the change reproduces the pre-change `jsonl` exactly
(`data/scratch/base-relay-1-16.jsonl` vs `data/scratch/screen-off-identity.jsonl`,
`diff` clean).

Measured result, honest summary:

- One rule from this round measurably *does* something: refilling a frontier
  cell that cannot fire this tick (`route`, the "reload"). It moves the 256-game
  relay multi screen from `129/121/6` (50.4 %) — the round-15 `mshape` base — to
  **`136/114/6` (53.1 %)**, `+7` wins, and one cell (`random/clear` 21/11) passes
  the 65 % bar.
- It does **not replicate on the independent seed half** (17–32): `119/120/17`
  (46.5 %) against the paired local `mshape` base `125/115/16` (48.8 %), `-6`.
  Pooled 512 games: **254 → 255 wins (`+1`, `+0.2 pp`)**. That is noise.
- The full 2048-game matrix with the flag on is clean of regressions
  (`1702/290/56`, 83.1 %, against the recorded `1688/299/61`, 82.4 %, and against
  the round-15 `mshape` matrix `1694/297/57`), but the `+8` over `mshape` is
  entirely the seven relay multi games of seed half 1 that the second half gives
  back.
- The move-mode policy the round was chartered for (**`retain`**) is **inert by
  arithmetic**, not by weight: see "Why the mode policy cannot fire". It measures
  `+0.8 pp` on the screen and is shipped off inside the layer.
- The 65 % bar is **not** met (best cell `random/clear` 65.6 %). The switch ships
  **off**, like rounds 8/11/15, as capability + measurement + switch.

## The arithmetic of the multi land race

Everything below is measured with `data/scratch/mhalf-probe.cjs` (per-tick land,
army, frontier ring, ring cells that hold enough army to fire, army histogram,
army mass by hop distance behind the ring, order classes) on
`random/bot3-baseline-1`, multi, with the round-15 base.

```
tick   land army front fire cells2  army in 1-army cells   army mass by hop (0..3)
 48      44   49    12    1      4            39                    2,1,3,1
 51      55   94    12    1     20            34                    1,1,2,5   <- pulse
 60      75   94    12    2      8            67                    1,1,3,1
 90      89  100    16    4      9            78                    2,1,1,1
120     108  120    15    2      8           100                    1,4,1,1
```

Order classes over the same 152 ticks (10.1 executed orders per tick):
`158` captures, `1769` merges that walk one hop toward the ring, `160` merges
that refill a spent ring cell, `33` sideways merges. That is **seven orders per
capture** — the tick is not short of slots (16 of 64 are used) and not short of
army (army ≈ 2 × land after every pulse); it is short of army **on the ring**.

Four engine facts, all verified in `src/game-engine.ts`, explain the shape:

1. **A capture costs three army, not two.** `attack()` only takes a cell when
   `push > defender`, and an all-in push is `total - 1`. Two army push one, so a
   two-army cell cannot take even an empty garrison. The cheapest capture is a
   **three-army cell pushing two** into a one-army neutral, which leaves `1` on
   the source and `1` on the target.
2. **Every capture strands army.** The source keeps one army (a cell with one
   army cannot move at all: `computePush` returns `total - 1 = 0`), the target
   keeps `push - defender`. So the ring has to be *refilled* after each capture,
   two army per capture, and the refill has to come from behind.
3. **A growth pulse does not arm the ring by itself.** `+1` per plain turns a
   one-army sheet into a two-army sheet, and a two-army cell still cannot fire.
   Only cells that already held two army can capture on the pulse tick, which is
   why the pulse tick shows 7 captures and the next one shows 3.
4. **The neutral race is over by t≈120.** At t120 the board has 25 neutral plain
   cells left for both seats together and every one of them holds zero army.
   Land after that is taken from the rival, at 1:1 army. So the round-15 premise
   "capture rate is the income lever" only holds for `t 50..120`, a window in
   which the mirror keeps both seats within ±0.2 land of each other (measured
   `L50`/`L100` in the checkpoint table below).

## Why the mode policy cannot fire

The role of `mode 1` (the engine's halved push) is to keep a rolling garrison:
`floor((total - B - 1) / 2)` is pushed and `total - that` stays on the source.
Against a one-army garrison the halved push has to be ≥ 2, which needs
`total ≥ 5` (`B = 0`). Measured on the ring: **11 mode-1 orders in 58 ticks**
(0.19 per tick), because ring cells in a multi-line room hold one to three army,
not five. `mode 0` (keep the threat sum + 1) equals `mode 2` unless the cell is
adjacent to a stack (`B > 0`), so it cannot retain army on an open front either.
And when a five-plus stack *does* fire, the retained mass is worth exactly what
the all-in push would have deposited one cell forward: the captured cell is a
frontier cell too, so the all-in chain captures the same cells in the same ticks
(`5 -> push 2, keep 3, target 1` versus `5 -> push 4, target 3, then push 2`).
Only a source with two or more open directions gains, which is the `retain=1`
rule — measured `+0.8 pp`, inside the screen's noise, and shipped off.

## Mechanism

`planner.js` gains one hook triple, inert unless `BOT3_MHALF=1` and the room is
`multi`:

- `mhalfUpdate(b, {turn, multi, size, corridor, fog, land, enemyLand, ...})`
  returns `null` (baseline path) or a plan carrying the config and gates;
- `applyMhalf(plan, ctx, candidates)` computes a hop field over our own
  territory (0 = frontier ring, `n` = n hops behind it, `-1` = pocket) and
  re-prices **our own merges only**:
  - **arming** (the reload): a merge into a ring cell that holds fewer than
    `minFire` army and reaches `minFire` after the merge, from a source behind
    the ring (`hop[from] >= 1`). Score `reload + 2×result - hop×depth`. This is
    the rule that measured positive.
  - **convoy**: a merge that steps one hop toward the ring earns
    `convoy + hop×(5-to) + send×2`. Default `convoy = 0`: pooling it forward
    **loses 43 wins** (see the rejects table) because it overrides the planner's
    own choice of *where* the mass is going.
  - **pit**: a merge into a ring cell that still cannot fire after it is capped
    at `stale` (28), i.e. below every capture score. A delivery that leaves the
    ring one army short spends a slot, spends the army and still cannot take a
    cell.
  - Defence/rescue/siege scores (`>= exempt`, 300) are never touched, and a
    ring cell that can fire this tick is never boosted: that merge would outrank
    and therefore cancel its capture (the measured round-15 `feed` failure; the
    unguarded version of this same rule loses 26 wins, see the rejects table).
- `applyMhalfModes(plan, ctx, orders)` rewrites the mode of a capture to `1`
  when the halved push still takes the cell, the source keeps `>= floor` army
  and (for `retain=1`) the source has another open direction. Default
  `retain = 0`.

| knob | env | default | meaning |
| --- | --- | --- | --- |
| layer | `BOT3_MHALF` | 0 | enable in a multi-line room |
| route | `BOT3_MHALF_ROUTE` | 1 | re-price our own merges by the hop field |
| retain | `BOT3_MHALF_RETAIN` | 0 | `1` fork retention, `2` any cell, `0` off |
| floor | `BOT3_MHALF_FLOOR` | 2 | army a firing cell must keep in retain mode |
| fork | `BOT3_MHALF_FORK` | 1 | further open directions a fork needs |
| reload | `BOT3_MHALF_RELOAD` | 60 | arming bonus (a rank threshold: 60 ≡ 120 ≡ 240) |
| minFire | `BOT3_MHALF_MIN_FIRE` | 3 | army a ring cell needs to take a one-army garrison |
| hop | `BOT3_MHALF_HOP` | 6 | score lost per hop between source and ring |
| convoy | `BOT3_MHALF_CONVOY` | 0 | bonus for a merge that steps toward the ring |
| stale | `BOT3_MHALF_STALE` | 28 | cap on a pit delivery (`0` = off) |
| leak | `BOT3_MHALF_LEAK` | 0 | also refill ring cells that can fire anyway |
| cheap | `BOT3_MHALF_CHEAP` | 0 | bonus per missing defender army on a capture |
| armRing | `BOT3_MHALF_ARM_RING` | 0 | bonus per plain neutral neighbour of the armed cell |
| armWater | `BOT3_MHALF_ARM_WATER` | 0 | charge for arming a cell whose frontier is all swamp |
| sideways | `BOT3_MHALF_SIDEWAYS` | 0 | cap merges that stay at the same hop distance |
| exempt | `BOT3_MHALF_EXEMPT` | 300 | scores at or above this are defence and stay untouched |
| leadCap | `BOT3_MHALF_LEAD` | 110 | stand down above this land ratio (percent of the rival) |
| corridor | `BOT3_MHALF_CORRIDOR` | 0 | allow the layer on a corridor board |
| fog | `BOT3_MHALF_FOG` | 1 | allow the layer in a fog room |
| start/end | `BOT3_MHALF_START` / `_END` | 0 / 0 | tick window |
| board | `BOT3_MHALF_BOARD` | 800 | largest board the layer enters |

`leadCap = 110` is not cosmetic: without it the layer regresses
`anti/archipelago/clear/multi` (32/0/0 → 30/1/1) and
`v2/archipelago/clear/multi` (31/1/0 → 29/3/0), exactly the two cells round 15
had to gate. With it both are back at the paired baseline (`arch` screen:
`124/2/2` against `123/2/3`) and the 2048 matrix has **no cell below its paired
baseline**.

## Measured cells

Recommended configuration (the one measured below):

```sh
BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110 \
BOT3_MHALF=1
```

Relay multi-line cells, 16 seeds × both seats = 32 games per cell, screen half 1
(seeds 1–16; `L`/`A` are mean land/army differences from `mhalf-check.cjs`).

| map | fog | W/L/T | win | `mshape` base | Δ | L50 | L100 | L250 | A250 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| random | off | 21/11/0 | **65.6 %** | 16/16/0 | +15.6 | -4.6 | -0.7 | +14.3 | +28.5 |
| random | on | 17/15/0 | 53.1 % | 16/16/0 | +3.1 | -4.7 | -1.2 | +6.9 | +13.8 |
| mediterranean | off | 19/11/2 | 59.4 % | 14/14/4 | +15.6 | -3.0 | -3.0 | +0.8 | +1.8 |
| mediterranean | on | 17/14/1 | 53.1 % | 15/15/2 | +6.3 | -3.0 | -2.7 | +0.3 | +0.3 |
| archipelago | off | 15/15/2 | 46.9 % | 15/15/2 | 0.0 | -2.3 | -1.0 | +3.6 | +4.4 |
| archipelago | on | 15/16/1 | 46.9 % | 15/15/2 | 0.0 | -1.9 | -0.4 | +0.7 | +0.8 |
| maze | off | 16/16/0 | 50.0 % | 16/16/0 | 0.0 | — | — | — | — |
| maze | on | 16/16/0 | 50.0 % | 16/16/0 | 0.0 | — | — | — | — |
| **total** | | **136/114/6** | **53.1 %** | **129/121/6** | **+7** | -2.4 | -1.1 | +3.3 | +6.2 |

Half 1 reads as a mechanism win: the layer gives up a little early land (L50
-2.4, L100 -1.1) and ends with more land and army at t250 (+3.3 / +6.2), which is
the shape a "spend the pulse on the ring instead of on rear merges" doctrine
predicts. The independent half says it is not reproducible:

Screen half 2 (seeds 17–32, paired against a locally recorded `mshape` base for
the same seeds, `125/115/16` = 48.8 %):

| map | fog | W/L/T | win | local base | Δ |
| --- | --- | --- | --- | --- | ---: |
| random | off | 15/17/0 | 46.9 % | 18/14/0 | -9.4 |
| random | on | 15/17/0 | 46.9 % | 15/17/0 | 0.0 |
| mediterranean | off | 19/11/2 | 59.4 % | 16/11/5 | +9.4 |
| mediterranean | on | 12/15/5 | 37.5 % | 15/14/3 | -9.4 |
| archipelago | off | 12/14/6 | 37.5 % | 15/14/3 | -9.4 |
| archipelago | on | 15/15/2 | 46.9 % | 15/14/3 | 0.0 |
| maze | off | 15/15/2 | 46.9 % | 15/15/2 | 0.0 |
| maze | on | 16/16/0 | 50.0 % | 16/16/0 | 0.0 |
| **total** | | **119/120/17** | **46.5 %** | **125/115/16** | **-6** |

Pooled 512 games: `255/234/23` (49.8 %) against `254/236/22` (49.6 %) — `+1`
win. The half-1 gain is not a mechanism, it is seed luck.

The layer without the round-15 base (flag on, `BOT3_MSHAPE` unset) is also a
wash: `125/130/1` (48.8 %) against the recorded plain baseline `123/123/10`
(48.0 %), `+2`.

Full 2048-game matrix (recommended configuration):

| opponent / map / fog / multi | candidate | baseline | Δ |
| --- | --- | --- | ---: |
| relay / random / clear / multi | 21/11/0 | 16/16/0 | +15.6 |
| relay / random / fog / multi | 17/15/0 | 16/16/0 | +3.1 |
| relay / mediterranean / clear / multi | 19/11/2 | 14/14/4 | +15.6 |
| relay / mediterranean / fog / multi | 17/14/1 | 15/15/2 | +6.3 |
| relay / archipelago / clear / multi | 15/15/2 | 15/15/2 | 0.0 |
| relay / archipelago / fog / multi | 15/16/1 | 15/15/2 | 0.0 |
| relay / maze / clear / multi | 16/16/0 | 16/16/0 | 0.0 |
| relay / maze / fog / multi | 16/16/0 | 16/16/0 | 0.0 |
| **total** | **1702/290/56 (83.1 %)** | **1688/299/61 (82.4 %)** | **+14** |

`NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/full-mhalf-lead.jsonl`
reports `gate: FAIL (7/64 cells)`, and the seven are exactly the relay multi
cells still below 65 % (`random/clear` moved above the bar). No cell in the
matrix is below its paired baseline (the grep for a negative `Δwin` is empty).
Against the round-15 `mshape` matrix (`1694/297/57`) this is `+8` wins, all of it
in the eight relay multi cells — the half-2 result above says that would not
repeat.

## Rejected variants (256 relay multi games, seeds 1–16 unless noted)

| configuration | W/L/T | win | Δ vs base | why |
| --- | --- | --- | ---: | --- |
| `mshape` base only (`BOT3_MHALF` unset) | 129/121/6 | 50.4 % | 0 | round-15 reference |
| **`ROUTE=1`, `RELOAD=60`, `HOP=6`, `LEAD=110`** | **136/114/6** | **53.1 %** | **+7** | shipped defaults, does not replicate |
| same, `LEAD=0` | 139/112/5 | 54.3 % | +10 | best screen, regresses two archipelago cells in the matrix |
| `RELOAD=120` / `RELOAD=240` | 139/112/5 | 54.3 % | +10 | identical: the bonus is a rank threshold |
| `+STALE=0` (no pit cap) | 135/112/9 | 52.7 % | +6 | the pit cap is worth 1 win |
| `+HOP=0` (no depth decay) | 132/118/6 | 51.6 % | +3 | penalising deep arming sources helps |
| `+HOP=12` | 129/121/6 | 50.4 % | 0 | — |
| `+END=140` (land race only) | 135/116/5 | 52.7 % | +6 | the war phase is not the harm |
| `+RETURN retain=1` (fork) | 132/117/7 | 51.6 % | +3 | mode-1 orders: 11 per 58 ticks |
| `+RETURN retain=2` (any cell) | 128/120/8 | 50.0 % | -1 | — |
| `RETAIN=0`, `CONVOY=90`, `RELOAD=0` (convoy only) | 106/143/7 | 41.4 % | -23 | routing to the *nearest* ring overrides the planner's aim |
| `ROUTE=1`, `RETAIN=1`, `CONVOY=90`, unguarded arming | 97/147/12 | 37.9 % | -32 | boosted merge outranks the capture it invalidates |
| `CONVOY=90`, unguarded arming, `RETAIN=0` | 94/154/8 | 36.7 % | -35 | same, plus convoy |
| `RELOAD` unguarded (no "can it fire" guard) | 103/143/10 | 40.2 % | -26 | the guard is the whole mechanism |
| `+ARM_RING=12` | 132/115/9 | 51.6 % | +3 | breadth pricing is round-15's `RING` again |
| `+ARM_RING=12 +ARM_WATER=80` | 127/124/5 | 49.6 % | -2 | — |
| `+MIN_FIRE=4` | 129/123/4 | 50.4 % | 0 | 3 army is enough against a one-army garrison |
| `BOT3_MHALF=1` without the `mshape` base | 125/130/1 | 48.8 % | — | composition is what ships (+2 vs baseline, noise) |
| `mshape RAID=30` / `RAID=80` (no mhalf) | 129 / 130 | 50.4 / 50.8 % | 0 / +1 | pricing rival cells is not the war lever either |

## Rules findings (kept as negatives)

1. **The mode policy is inert, not mistuned.** A capture needs three army
   (fact 1 above) and `mode 1` only captures from five-plus army, so the ring has
   no order on which the choice can bite. The one case that is left — a source
   with two open directions — is worth `+0.8 pp`. Any future round that wants
   "sustained pressure" must create *mass on the ring*, not re-price the push.
2. **Refilling a ring cell only helps when it cannot fire.** `mshape`'s `feed`
   (round 15: -18 wins) priced every merge into a frontier cell; the same bonus
   with the "the target cannot fire this tick, and the delivery reaches three
   army" guard is the only positive rule found in this round (and, per half 2, a
   fragile one). Boosting a merge into an *armed* ring cell cancels its capture
   (`used` in `planner.js` admits one order per cell), which is exactly -26 wins.
3. **Depth matters, direction does not (yet).** Keeping the arming bonus from
   deep sources decays with hop distance (`HOP=6` worth +3, `HOP=0` +3, `HOP=12`
   0), but *forcing* merges toward the ring (`CONVOY`) loses 23-35 wins, because
   the planner's own merge scores already point the mass at the rival rather than
   at the nearest ring cell.
4. **The land race is symmetric and ends by t≈120, so capture rate is not the
   discriminator.** The mirror keeps `L50`/`L100` within ±0.2 land in every cell
   (both seats run the same policy), the board has ~25 neutral plains left at
   t120 and all of them are empty, and the wins track `L250`/`A250`. A round that
   wants the 65 % bar has to win *after t120*, or win the pulse window by a
   margin this layer does not produce.
5. **The `strategy.js` pending gate never skips in this harness.** The probe
   records `chooseOrders` on every engine tick (120/120, 200/200, 216/216 in the
   traces above), so the planned "per-source queue mirror" relaxation has nothing
   to recover here and was not implemented. It remains relevant only for a bot
   that deliberately queues chains (the round-15 `fan` path, off by default).
6. **Executed orders per tick are not a goal.** The layer raises them
   (`random/clear` 3425 → 3876) and does not convert that into wins on half 2,
   which repeats round 15's finding from the other side.

## Reproduction

```sh
cd /c/Users/reson/Downloads/fork/Roka-bot3-r16-mhalf

# 8 relay multi cells, seeds 1-16, both seats (256 games)
BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110 \
BOT3_MHALF=1 OPPONENTS=relay MAPS=random,maze,archipelago,mediterranean MODES=001,011 \
SEED_FROM=1 SEED_TO=16 WORKERS=4 OUT=data/scratch/relay-multi-mhalf.jsonl \
node bot-template/relay-bot/training/evaluate-matrix.cjs || true
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/relay-multi-mhalf.jsonl

# independent seed half (needs its own locally recorded mshape base)
SEED_FROM=17 SEED_TO=32 OUT=data/scratch/base17.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs || true
SEED_FROM=17 SEED_TO=32 BOT3_MHALF=1 OUT=data/scratch/mhalf17.jsonl \
  node bot-template/relay-bot/training/evaluate-matrix.cjs || true
NO_GATE=1 node bot-template/relay-bot/training/compare.cjs data/scratch/mhalf17.jsonl data/scratch/base17.jsonl

# full 2048-game matrix
BOT3_MSHAPE=1 BOT3_MSHAPE_SLOTS=64 BOT3_MSHAPE_STEAL=100 BOT3_MSHAPE_LEAD=110 \
BOT3_MHALF=1 OUT=data/scratch/full.jsonl node bot-template/relay-bot/training/evaluate-matrix.cjs

node --test bot-template/relay-bot/strategy.test.cjs
```

Scratch instruments (not part of the bot):
`data/scratch/mhalf-probe.cjs` (per-tick trajectory, ring, army histogram, army
mass by hop distance, order classes), `data/scratch/mhalf-check.cjs` (checkpoint
aggregation, `2-0`/`0-2` seed counts, executed orders) and
`data/scratch/screen.sh` (one-command 256-game screen with the round-15 base).

## 结论（第 16 轮）

多线房间的占领门槛是**三兵**而不是两兵：`attack()` 要求推出量严格大于守军，全冲推出
`总兵力 - 1`，所以两兵连空守的格子都拿不下。每拿一格还要「搁浅」一兵在出发格（一兵格
无法出兵），所以前线环每格每次占领都要从后方补两个兵。脉冲给每格 +1 并不能让一兵格
变成能出兵：两兵依然推一兵，只能吃下零守军。实测 t45–t120 之间每格平均要花 7 张指令
才能换来一次占领（`158` 次占领 vs `1769` 次向前合并），而 16 张指令上限只用了 10 张，
兵力在脉冲后是土地的 2 倍——瓶颈是**环上的兵力**，不是指令数，也不是总兵力。t≈120
之后双方桌前只剩约 25 个空格，土地增长只能从对手手里抢，而镜像让双方 L50/L100 相差
不到 ±0.2 格：本轮之前假设的「占领率是收入杠杆」只在 t50–120 这一窗口成立，胜负却
在 t250 之后才分出来。

`mhalf.js` 因此只做一件事：把「补满一个**本 Tick 无法出兵**的前线格、且补到能出兵
（≥3 兵）、且补给来自环后方」的合并排到所有合并之前，并把补不满的合并（只会让环继续
瘫着）压到占领分数之下；另有一条默认关闭的 `retain` 模式策略（半兵保留滚动驻军）。
结果：种子 1–16 的 256 局 `129 → 136`（+7，`random/clear` 21/11 越过 65%），但独立
半区 17–32 回吐 `-6`，合计 512 局 `254 → 255`（+1 胜），属于噪声；全量 2048 局
`1702/290/56`（83.1%）对基线 `1688/299/61`（82.4%）零格退化，但增益全部落在上面那
7 局里。**模式策略（`retain`）实测是惰性的**：能出兵至少要三兵，半兵推出要五兵，前线
环上几乎没有这样的格子（58 Tick 内 11 次）。因此 `BOT3_MHALF` 默认**关闭**，仅作为
「能力 + 开关 + 实测记录」交付；同轮负结果记录在 rejects 表与「Rules findings」中。
