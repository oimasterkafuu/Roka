# Relay 2.16.1 开局耗时与四图实战

以 `4fb119a` 的 Relay 2.16.0 为基线。两个版本在真实引擎里使用相同的地图种子、尺寸、对手与出生位，双人局换边，四人局轮换全部座位。对手只通过公开托管入口运行。每局上限 1000 Tick，胜率分母包含超时局。本报告统计随机、峡谷回廊、群岛、地中海。

## 明牌单线

标准图每张对每位主要对手各 10 局。表中数字为胜场，分母均为 10。

| 地图     | Anti-Human 旧 → 新 | APEX 旧 → 新 |
| -------- | -----------------: | -----------: |
| 随机     |              1 → 6 |        8 → 9 |
| 峡谷回廊 |            10 → 10 |        7 → 9 |
| 群岛     |              6 → 7 |        8 → 8 |
| 地中海   |              4 → 8 |        8 → 9 |

对 Anti-Human 合计从 21 胜 8 负 11 未决变为 **31 胜 2 负 7 未决（77.5%）**。对 APEX 从 31 胜 9 负变为 **35 胜 5 负（87.5%）**。标准图对 Bot 2.0 另测 16 局，从 13 胜增至 14 胜。最后两个新种子的主要对手各 16 局，对 Anti-Human 从 9 胜变为 8 胜，对 APEX 从 10 胜增至 14 胜。对 Anti-Human 的总体提升随种子变化明显。

大图单独统计。两版对 Anti-Human 均为 3 胜 1 负 20 未决，对 APEX 均为 17 胜 2 负 5 未决，各 24 局。长距离连续进攻、前线建造、集结大军和扩大占地等试验未能稳定改善这批大图对局，发布版保留明牌单线大图的中盘策略。

## 迷雾与多线

每张地图各 24 局，两个尺寸上分别开启仅迷雾、仅多线、迷雾加多线，轮换 Anti-Human、APEX 和双方座位。

| 地图     | 2.16.0 胜 / 负 / 未决 | 2.16.1 胜 / 负 / 未决 |
| -------- | --------------------: | --------------------: |
| 随机     |            20 / 1 / 3 |            21 / 0 / 3 |
| 峡谷回廊 |            17 / 0 / 7 |            18 / 0 / 6 |
| 群岛     |            19 / 1 / 4 |            20 / 0 / 4 |
| 地中海   |            17 / 2 / 5 |            19 / 1 / 4 |
| 合计     |           73 / 4 / 19 |           78 / 1 / 17 |

## 四人 FFA

Anti-Human、APEX、Bot 2.0 同时入场。每版每图各 8 局，覆盖两个尺寸和四个出生位。两版逐图汇总相同。

| 地图     | 夺冠 | 出局 | 达到上限仍存活 |
| -------- | ---: | ---: | -------------: |
| 随机     |    1 |    0 |              7 |
| 峡谷回廊 |    2 |    1 |              5 |
| 群岛     |    1 |    4 |              3 |
| 地中海   |    2 |    2 |              4 |
| 合计     |    6 |    7 |             19 |

## 开局与调兵

每版对 144 个出生位各测三轮，两个版本交替运行。只计 `chooseOrders` 的本机执行时间。首帧计整次规划，后续一项是执行同一开局的 23 个 Tick 耗时之和。

| 指标             |    2.16.0 |    2.16.1 |
| ---------------- | --------: | --------: |
| 首帧中位数       |  1.973 ms |  1.616 ms |
| 首帧 P95         | 38.909 ms | 28.529 ms |
| 首帧最大单次观测 | 95.961 ms | 99.716 ms |
| 后续 23 步中位数 |  0.979 ms |  0.401 ms |
| 后续 23 步 P95   |  3.433 ms |  1.229 ms |

144 个出生位的普通速度单线计划都兑现了 Tick 24 的占地上界。四倍速下 135/144 达到上界，144/144 兑现计划。多线复查的 48 个出生位也都兑现了首帧计划。搜索按剩余时间裁剪棋盘，使用整数编码记录运输状态，只序列化已触及的棋盘前缀。执行缓存计划时延迟计算全图敌距和补给割点。实现沿用 Node.js。

中盘逐个比较调兵对目的地兵力的实际贡献，计入智能分兵、原路折返、能否凑齐建造费用、是否正守卫受威胁主城。明牌标准图另按可接回的整个孤军兵团估算抢回连接格的价值。逐局结果与开局计时见 [tempo-results.jsonl](tempo-results.jsonl)。

## 复现

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test:relay
baseline_dir=$(mktemp -d)
git archive 4fb119a bot-template/relay-bot | tar -x -C "$baseline_dir"
export MAPS=random,maze,archipelago,mediterranean
PLANNER="$baseline_dir/bot-template/relay-bot/planner.js" node bot-template/relay-bot/training/evaluate-opening.cjs
node bot-template/relay-bot/training/evaluate-opening.cjs
export TICKS=1000
MODES=000,100 SEEDS=campaign-probe,campaign-blind-1,campaign-blind-2 OPPONENTS=anti,apex node bot-template/relay-bot/training/evaluate.cjs
MODES=000 SEEDS=campaign-sealed-3,campaign-sealed-4 OPPONENTS=anti,apex,v2 node bot-template/relay-bot/training/evaluate.cjs
MODES=001,010,011,101,110,111 SEEDS=campaign-variants OPPONENTS=anti,apex node bot-template/relay-bot/training/evaluate.cjs
MODES=000,100 SEEDS=campaign-table OPPONENTS=anti+apex+v2 node bot-template/relay-bot/training/evaluate.cjs
```

实战命令可添加 `RELAY_ENTRY="$baseline_dir/bot-template/relay-bot/strategy.js"` 重跑旧版。对手的运行时随机性及耗时可能带来单局波动。
