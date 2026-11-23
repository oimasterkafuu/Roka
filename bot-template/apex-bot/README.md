# Apex

现行 Apex 采用原 Bot 2.0 的战役策略，保留棋盘图搜索、连通性、建设、战役与规则预演管线，以及原版 Apex 的多线队列。官服普通房（0.34）和大图房（0.68）增加了斩杀、开局、最后一段和经济相位。

## 历史基线（原 Bot 2.0）

官方尺寸、2400 Tick、seeds 8、双座位、10 worker、平局按负计：

| 对手 | 对局 | W / D / L | 胜率 |
| --- | ---: | ---: | ---: |
| anti | 128 | 65 / 32 / 31 | **50.8%** |
| apex | 128 | 90 / 5 / 33 | **70.3%** |
| 合计 | 256 | 155 / 37 / 64 | **60.5%** |

原始汇总数据见 [`training/final-baseline.json`](training/final-baseline.json)。

## 主要特性

- **斩杀层**：`bot/duel/killpath.cjs` + `race.cjs` + `strike.cjs`，只在证明本 Tick 可斩杀且不会先被斩杀时执行，默认 `maxEta=1`。
- **紧凑图开局到达门控**：`APEX_OPENING_SMALL`，用真实可落地兵力判断是否值得进入 rush hold，只作用于 `<800` 格。
- **最后一段重落座**：`bot/lastmile.cjs`，只在大图 `>=800` 格把死亡/被切的纵队从前方补给格重新落座。
- **经济与皇冠**：经济档按 `map_mode` 门控；`APEX_CROWN_LAND_ANCHOR` 在 random/archipelago 把皇冠预算锚定实控土地。
- **大地图相位**：`bot/snowball.cjs`（mediterranean 城市/经济雪球）与 `bot/medplan.cjs`（mediterranean 皇冠竞赛）。
- **紧凑图皇冠竞赛**：`bot/crownrace.cjs`，在 `<800` 格、经济和皇冠落后时进行有界竞赛。
- **决策预算**：`bot/deadline.cjs` 默认 80ms，超时回退到经 `preview` 校验的合法动作；动作确认允许一帧网络宽限。
- **可选迷宫爆发**：`bot/mazeblitz.cjs`，`APEX_MAZE_BLITZ=1` 开启，默认关闭。

## 运行

```sh
pnpm install
BOT_SERVER=http://127.0.0.1:23333 BOT_ROOM=room BOT_TOKEN=token pnpm start
node --test test/*.test.cjs
```

服务端托管入口为 `require('./strategy').attachStrategy(socket, options)`；`options.decisionBudgetMs` 或 `BOT_DECISION_BUDGET_MS` 可覆盖决策预算。

## 评测

```sh
node training/long-eval.cjs --profile large --seeds 8 --workers 10 \
  --turns 2400 --opponents anti,apex --seat both -q \
  --output /tmp/bot2-final.json
```

`--profile large` 覆盖 `0.34` 与 `0.68`，`--multi-line true` 启用真实引擎的并行队列。`--opponents apex` 从 Git 提交 `33fdac9` 加载冻结的原版 Apex，需要本地历史和 `tar`。`training/compare.cjs` 按 `(mode, mapSize, seed, swap, opponent, fog, multiLine)` 配对并执行 bootstrap，旧报告缺失的多线字段按单线处理。

## 默认开关

默认开启：`APEX_OPENING_SMALL`、`APEX_LAST_MILE`、`APEX_CROWN_LAND_ANCHOR`、`APEX_CITY_SNOWBALL`、`APEX_MED_PLAN`、`APEX_SMALL_CROWN_RACE`。需要消融时设为 `0`。

默认关闭：`APEX_MAZE_BLITZ`。当开关关闭时，对应模块不会接管行动预算。
