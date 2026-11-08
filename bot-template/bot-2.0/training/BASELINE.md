# Bot(2.0) 基线

本文件记录模板复制自 `bot-template/apex-bot` 后、尚未做任何策略改动时的基线，供后续 1v1 优化对比。
评测固定使用 Apex 的种子命名空间（`apex-benchmark` / `apex-long`），因此相同参数下的地图与 Apex 一致，可直接横向比较。

## 环境

- 仓库提交：`bd79054`（main，v2.1.16）
- Node：`v26.8.1`
- 平台：Windows（Git Bash）
- 评测引擎：直接加载仓库当前 `src/game-engine.ts`

## 单元测试

```sh
cd bot-template/bot-2.0
node --test test/*.test.cjs
```

结果：`58` 个测试全部通过，`0` 失败，耗时约 `1.7s`。

## 标准基准（四地图 / 1 种子 / 600 Tick）

```sh
cd bot-template/bot-2.0
node training/benchmark.cjs --output /tmp/bot2-baseline-benchmark.json
```

- 对局：8（4 地图 × 先后手），对手 `anti`
- 结果：`0` 胜 / `8` 平；未结束对局按 `effectiveLosses` 计，故 `0%` 胜率
- 决策延迟（本方）：p50 `1.70ms`，p95 `8.81ms`，max `61.8ms`；超时 `1`
- 墙钟：`8.5s`（8 worker 并行）

按地图：random / maze / archipelago / mediterranean 各 2 平。

## 大地图回归（0.5 与 0.68、1 三档 / 1200 Tick）

```sh
cd bot-template/bot-2.0
node training/long-eval.cjs --profile large --seeds 1 --workers 8 \
  --turns 1200 --opponents anti --seat both -q \
  --output /tmp/bot2-baseline-large.json
```

- 对局：24（4 地图 × 3 尺寸 × 先后手）
- 结果：`7` 胜 / `17` 负（其中 `12` 平按负计），胜率 `29.2%`
- 胜局平均 `360.7` Tick
- 决策延迟（本方）：p50 `3.47ms`，p95 `44.7ms`，max `179.9ms`；超时 `1281`
- 墙钟：`77.0s`

按地图：random 2/6、maze 2/6、archipelago 2/6、mediterranean 1/6。
按尺寸组：standard（0.5）5/8，large（0.68、1）2/16。

## 后续对比约定

1. 保持 `--seeds`、`--turns`、`--profile`、`--seat`、`--opponents` 与本文一致；
2. 优先看 `effectiveLosses`（平局即失败）与尺寸组胜率，避免“拖平”掩盖退化；
3. 策略改动后同时重跑单元测试与回放回归（`test/replay-regression.test.cjs`）；
4. 结果 JSON 不提交仓库，只把汇总与异常写入本文件或 PR 说明。
