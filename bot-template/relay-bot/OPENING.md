# Relay 2.16.0 开局与峡谷评测

页面第 12 回合对应 Tick 24。每 Tick 先给初始主城加 1 兵，普通地到 Tick 26 才开始爆发。标准单线开局只有一个行动机会，王城旁的最后一个空格可以留到后期，用刚产出的兵直接拿下。单出口直廊则需要先等兵，再把部队送过已经占领的土地。直廊专项用例在 Tick 24 恰好占 13 格（含主城）。

## 无干扰开局

每个版本使用相同的引擎、种子、尺寸和出生位。其余玩家驻守原地，主城正常产兵。表中是全视野、普通速度、单线在 Tick 24 的实际平均领地，计入沼泽和主城。每种地图各 36 个出生位，覆盖三组种子、标准图和大图、双人及四人布局的全部座位。

| 地图     | 2.15.0 | 2.16.0 |
| -------- | -----: | -----: |
| 随机     |  16.86 |  18.69 |
| 峡谷回廊 |  13.50 |  16.03 |
| 群岛     |  18.39 |  20.69 |
| 地中海   |  19.44 |  20.89 |
| 华夏     |  17.83 |  19.97 |
| 全部     |  17.21 |  19.26 |

180 个出生位中，178 个增加、2 个持平。首帧搜索对可见无守军领地建模，计算等待、汇兵、分兵和占地的行动序列。先放宽兵力运输约束，估算给定剩余 Tick 最多还能占几格，再用合法走法搜索。180 个计划均达到该模型的上界，且实际执行结果与计划一致。专项测试还用独立穷举核对了 64 个短局。实战中可以为了守家或抓住击杀机会中断原计划，迷雾下只能根据己方所见估算。

普通速度首帧最慢 80.1 ms。四倍速每 Tick 为 125 ms，同样的 180 个开局首帧最慢 35.6 ms，平均占地 19.20 格，171 个达到各自上界。其余 9 个在计算预算内找到了可执行路线。延迟为本机测量值。

多线比较可同时执行的扩张批次，按通行距离把后方兵力送往空地。用第三个种子的全部 60 个出生位测量，平均占地从 20.17 增至 20.75 格。多线采用候选路线搜索，整体最优性仍未证明。

## 峡谷建造

建造与升级前，从候选格按可通行地形反推七步，逐队计算沿最短进攻路线可能抵达的最大兵力。敌军沿途会汇兵、留下驻军并消耗守军。检查本格能否在付出 50 兵后守住，也检查筹款时抽空路口的风险。另一座主城有危险时，可以从侧面消耗入侵大队，或优先完成安全位置的主城升级。远处援军、更长绕路和迷雾内未发现的部队仍可能改变结果。

弯道回归用例中，敌方 80 兵前锋能接上后方 15 兵。守路格有 108 兵时推迟开工，有 170 兵时允许建指挥所或升主城。另一个用例中，侧翼 57 兵会主动攻击 60 兵的入侵部队，保住后方主城。

## 全视野单线实战

以 2.15.0 为基线，每版运行 80 局。随机图和峡谷各用两个种子、两种尺寸，对 Anti-Human、APEX、Bot 2.0 分别换边。四人局让这三家同时入场，Relay 轮换四个座位。对手只通过托管入口运行。每局上限 1000 Tick，超时时仍存活计未决。

| 场景        | 每版局数 | 2.15.0 胜 / 负 / 未决 | 2.16.0 胜 / 负 / 未决 |
| ----------- | -------: | --------------------: | --------------------: |
| 全部单挑    |       48 |          19 / 13 / 16 |          21 / 10 / 17 |
| 单挑 · 峡谷 |       24 |            13 / 5 / 6 |            10 / 5 / 9 |
| 单挑 · 随机 |       24 |            6 / 8 / 10 |            11 / 5 / 8 |
| 四人 FFA    |       32 |            3 / 9 / 20 |           3 / 12 / 17 |

单挑胜率含未决，由 39.6% 升至 43.8%。分对手看，对 Anti-Human 从 2 胜增至 4 胜，对 APEX 仍为 9 胜，对 Bot 2.0 仍为 8 胜。峡谷开局平均多占 2.53 格，但这批对局的限时胜场减少。四人局夺冠数持平，出局数增加。另用一个种子换边对阵 APEX 的 8 场峡谷模式检查（覆盖多线、迷雾及组合），500 Tick 内 6 胜、2 未决。样本内没有人类对手。各座位的开局上下界、实战结果及结束 Tick 见[逐局数据](opening-results.jsonl)。

## 复现

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:relay
baseline_dir=$(mktemp -d)
git archive 7793ef1 bot-template/relay-bot | tar -x -C "$baseline_dir"
PLANNER="$baseline_dir/bot-template/relay-bot/planner.js" node bot-template/relay-bot/training/evaluate-opening.cjs
node bot-template/relay-bot/training/evaluate-opening.cjs
SPEED=4 node bot-template/relay-bot/training/evaluate-opening.cjs
MULTI=1 SEEDS=opening-sealed-3 node bot-template/relay-bot/training/evaluate-opening.cjs
export MAPS=maze,random MODES=000,100 SEEDS=gate-holdout,gate-sealed-2 OPPONENTS=anti,apex,v2,anti+apex+v2 TICKS=1000
RELAY_ENTRY="$baseline_dir/bot-template/relay-bot/strategy.js" node bot-template/relay-bot/training/evaluate.cjs
node bot-template/relay-bot/training/evaluate.cjs
MAPS=maze MODES=001,010,011,111 SEEDS=opening-sealed-3 OPPONENTS=apex TICKS=500 node bot-template/relay-bot/training/evaluate.cjs
```
