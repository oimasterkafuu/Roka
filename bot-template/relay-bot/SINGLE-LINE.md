# Relay 2.15.0 明牌单线评测

对照组是 `b8558fa` 中的 Relay 2.14.0。两个版本分别挑战 Anti-Human、Apex、Bot 2.0，使用同一个真实引擎和对手的公开托管入口。每一对对局共享对手、种子、地图与出生位。1v1 覆盖随机、迷宫、群岛和地中海四种地图，每个种子交换出生位。每局上限 1000 Tick，胜率分母包含超时局。

| 1v1 | 每版局数 | 2.14.0 胜 / 负 / 未决 | 2.15.0 胜 / 负 / 未决 | 胜率变化 |
| --- | ---: | ---: | ---: | ---: |
| 标准图 | 144 | 87 / 52 / 5 | 103 / 29 / 12 | 60.4% → 71.5% |
| 大图 | 144 | 47 / 54 / 43 | 58 / 15 / 71 | 32.6% → 40.3% |
| 合计 | 288 | 134 / 106 / 48 | 161 / 44 / 83 | 46.5% → 55.9% |

前五个种子的对照曾用于比较策略版本。最后一个 `relay-published-check-6` 在算法冻结后首次使用，48 局中旧版 21 胜，新版 28 胜。大图单线防守改善比收尾更明显，未决局从 43 增至 71。本评测没有人类对手。

| 对手（每版各 96 局） | 2.14.0 胜 / 负 / 未决 | 2.15.0 胜 / 负 / 未决 |
| --- | ---: | ---: |
| Anti-Human | 26 / 34 / 36 | 35 / 4 / 57 |
| Apex | 59 / 32 / 5 | 70 / 19 / 7 |
| Bot 2.0 | 49 / 40 / 7 | 56 / 21 / 19 |

四人 FFA 作为独立样本，每版 16 局。标准图的夺冠 / 出局 / 未决从 1 / 5 / 2 变为 1 / 6 / 1，大图从 0 / 4 / 4 变为 0 / 1 / 7。大图中更多对局存活至上限，两种尺寸合计的夺冠数持平。

## 行动评估

- 全视野单线的安全开局向前搜索最多八步，计入主城增长和汇兵。爆发期优先拿下普通地块。紧凑地图上，最后一座主城附近出现敌军时，可以提前在安全位置筹建第二主城。
- 明牌下可直接比较各家的主城产量。单线建设同时计算本格和相邻供兵格的可用兵力。多人局选敌时考虑距离、兵力、剩余主城和第三方的边界兵力。外线受压时，多步进攻的优先级降低。
- 战役搜索估算沿途汇兵、守军、侧翼威胁和截断代价。大图兵力占优且补给有保障时可以持续推进，延长运输线会提高建前方锚点的收益。单个兵堆推不下的要点，还会检查两支相邻部队能否分两 Tick 攻克。
- 接回孤军的收益根据连通分量内的现存兵力和格数估算，同一连接格不会重复计算同一个兵团。面临反击时还会比较损失与救援收益。

## 复现

在仓库根目录运行以下命令。评测器以 JSONL 输出逐局记录。`RELAY_ENTRY` 可以选择基线的公开入口，默认加载当前策略。对手的运行时随机性和决策耗时可能令单场结果波动。

```sh
pnpm install --frozen-lockfile
pnpm run build
baseline_dir=$(mktemp -d)
git archive b8558fa bot-template/relay-bot/strategy.js bot-template/relay-bot/planner.js | tar -x -C "$baseline_dir"
export SEEDS=relay-front-holdout,relay-front-blind-2,relay-front-blind-3,relay-front-sealed-4,relay-front-audit-5,relay-published-check-6
export MODES=000,100 TICKS=1000 OPPONENTS=anti,apex,v2
RELAY_ENTRY="$baseline_dir/bot-template/relay-bot/strategy.js" node scripts/evaluate-relay.cjs > /tmp/relay-old.jsonl
node scripts/evaluate-relay.cjs > /tmp/relay-current.jsonl
```

四人 FFA 使用 `SEEDS=relay-front-holdout MAPS=random,maze MODES=000,100 OPPONENTS=anti+apex+v2`，轮换全部四个出生位。出局计负，超时时仍存活计未决。尚有多名选手存活时 `rank` 留空。输出中的 `seat` 从 0 开始，`executed` 和 `checkpoints` 均按座位顺序排列。各版本的配对结果见 [single-line-results.jsonl](single-line-results.jsonl)。
