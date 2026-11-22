# Bot(3.0) 后续重启方向

本文件记录当前主线暂停时最有价值的改进线索、已证伪方向与恢复方式，方便后续直接接着做。

## 当前状态

- 分支：`feat/bot-3.0-1v1`
- 最终基线：2048 局 **1621/367/60（79.2%）**，见 [BASELINE.md](BASELINE.md)
- 引擎：上游 `6821598`（多线 burst 已移除）；relay-bot 已同步上游 opening/reinforcement pricing
- 验收：非 Relay 全部 >=50% 且无退化；Relay 2/16 达标
- 默认开：迷宫走廊相位、单线收尾纵队、迷雾单线层
- 默认关：斩杀层、多线 focus、迷雾多线 burst 门控

## 最高优先级（建议下一轮先做）

### 1. 无 burst 多线的“第二主城”经济

诊断证据（`exp/bot3-multiecon` / `exp/bot3-multicampaign`）：

- 无 burst 后，多线房间双方常年只有 1 座主城、主城驻军 1–2 兵、全盘最大堆 3–5；
- `army@50` 决定约 87% 的多线对局；实际每 Tick 只发 2–9 条指令，16 槽位不是瓶颈；
- 典型败局：我方 152 land / 179 army 对 81 / 102，却因只有 1 座 2 兵主城被翻；
- 多线房间从不建/升第二座主城（`units[i] >= 50` 几乎永不到达）。

建议：把“集结 + 建/升主城”作为多线目标，而不是直接打穿敌方主城。主城 +1/Tick、50/100 兵成本、第二条命；需要配套“提前攒 50 兵 + 保护建设点 + 建完继续扩张”的计划。这是当前最未被验证、成本最低的杠杆。

### 2. 多线席位不对称

`exp/bot3-multicampaign` 观测：archipelago / maze 多线 seat0 胜率约 69%，seat1 约 25%；整体接近硬币。建议用单线房间做对照，分离“出手顺序/先手”与“评分层”因素；若确有先手优势，可在多线里调整指令顺序、优先抢占关键格或同步波次。

### 3. 迷宫迷雾层的局部降权

`exp/bot3-mazefog2` 已把 Relay 迷宫迷雾单线从 50.0% 推到 65.6%，全矩阵 +8 胜；唯一退化是 `anti/maze/fog/单线` 确定性 −1。该局不是“无中立前沿”，而是主力停在柱状推进，T100–T580 占地停在 49 格而场上仍有 60+ 中立格。
建议：不要整层退场，改为按“走廊分支剩余中立格数 / 主力规模比”降低 `columnAdvance`，或按分支涂完程度局部切换零散涂色。这样有机会同时保住 Relay 收益并消掉 Anti 的 −1。

### 4. 迷雾多线的“记忆皇冠”

`fog-multi.js` 的 burst 门控已随 burst 移除而默认关；迷雾多线格在所有配置下不动，因为多线分支没有“记忆中的敌方皇冠”作为目标。建议先做多线迷雾侦察/记忆（可见前线 + 最后目击 Tick + 置信度），再谈波次或经济。

## 已验证的负结果（不要重复）

- **多线收尾/柱状推进**（`multi-close`、`multi-econ`）：抽走 land/收入，−5 到 −43 胜；多线是收入约束，不是吞吐约束。
- **同步波次集结**（`wave.js`）：能堆出 20 兵单堆，但 `required` 每步 2 兵，冻结前线的 land 损失大于皇冠回报；MED 多线 −12.5pp、random −6.3pp。
- **反应式主城驻军/驻军下限**（`garrison`、`islands` 旧引擎）：串行每 Tick 一条命令，救援必然挤掉推进；`garrison` −6 胜。
- **第二主城经济（旧 burst 引擎）**：100 Tick 回本，而群岛中位局长 86 Tick；旧引擎下不成立。新引擎多线需重测（见 P0）。
- **群岛 burst 目标评分**（`arch.js`）：+0.6pp 是种子噪声，held-out 为负。
- **lookahead 地图门控**：旧 relay 下 random-only +0.6pp；新 relay 下 1643/353/52，4 个负向格，已回退。
- **迷宫多线评分/定价**（`maze-multi.js`）：多线走廊 16 槽位不绑定，全部机制中性或负向。
- **斩杀层**（`kill.js`）：默认关；对镜像格无净收益。
- **反雪球防御层**（`defense.js`）：默认关；所有组合中性或负向。

## 恢复方式

```sh
cd C:/Users/reson/Downloads/fork/Roka
pnpm run build
SEED_FROM=1 SEED_TO=16 WORKERS=2 \
  OUT=/tmp/bot3.jsonl SUMMARY=/tmp/bot3-summary.json \
  node scripts/evaluate-bot3-baseline.cjs
NO_GATE=1 node scripts/compare-bot3-baseline.cjs /tmp/bot3.jsonl \
  bot-template/bot-3.0/baseline-results.jsonl
```

- 验收门禁：Relay 每格 >=65%，其余每格 >=50% 且不低于基线。
- 实验 worktree 建议从 `feat/bot-3.0-1v1` 最新提交切出，复制 `dist/`，并使用最新 `baseline-results.jsonl`。
- 单局 = 3.1pp；先用 2 种子/4 种子筛查，满 16 种子再判定默认开。
- 大图零退化尚未形成正式基线；若改动触及共享路径，至少做 `BOT3_MAZE=0` 与默认的 large-map 对照烟测。

## 已保留的实验分支

`exp/bot3-mazefog2`（+8 胜，1 个 Anti 退化）、`exp/bot3-islands2`（旧引擎）、`exp/bot3-multicampaign`（波次负结果）、`exp/bot3-multiecon`（多线经济负结果）、`exp/bot3-mazemulti`、`exp/bot3-lookgate`、`exp/bot3-closing2`（已合入）、`exp/bot3-garrison`、`exp/bot3-archdef`、`exp/bot3-defense`、`exp/bot3-crown2`、`exp/bot3-arch`、`exp/bot3-kill`。
