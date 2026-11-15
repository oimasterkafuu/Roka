# PR163 聚焦修复结果

**结论：BLOCK（仍有未满足门槛）。** 仅代表这组确定性样本与测试，不代表统计显著的普遍策略提升，也不替代生产性能预算。未合并、未部署。

## 范围与源码

- 更新到 origin/main `6996f79fc56a77139843511c3d52d6c7609cf1ea`（含聊天 PR160）；保留 PR163 源码，MAP 冲突保留双方内容。
- 最终评测源码 SHA256：`594d9ceb4ef6dcbbc1c0cec00cfd3e75248b9d0dde104800c08faf8ac2205b3d`。JSON 的 source.files 保留逐文件哈希，程序复核与提交前工作树一致，评测前后哈希一致。JSON 中 gitHead 是合并 main 的检查点，修复当时尚未提交；发布提交承载相同源码哈希。
- 冻结原版基线：`9aaa39426ccddce3a8a8d7893e28a8e63e0ea86565e3d8a54f01dc8968b00246`；修复前 PR：`703937963daec81f08cbaea8a009db0d2a6394cfc075b8322c40aa80e20f2a19`；同机修复前控制树：`df6f9b1b4ec3cb5021580dc43b1aae4851b767c53c7843b4b08bd20be1d8bc80`。
- 依用户版本例外，本次没有自行提升 package.json 版本；main 带入的版本为 2.6.2，不抢 GitHub 2.7.0，由主会话合并时决定。

## 实际原因与修复

1. 读取原失败 trace：maze/1/simple/seat0 到 1200 Tick 仍在长距离 march，兵力 8255 对 36437；修复前 mediterranean/0.5/simple/seat0 有 571 次 march、203 次 muster、341 次 emergency-defense-cut，1200 Tick 仍未结束。动作多不能证明有效进攻。
2. 代码确认夺冠续攻状态丢失：chooseCampaign 刚设置突破口的下一皇冠，后面的 m.campaign=best 用仍为 null 的通用候选覆盖它。多线在选定突破口后直接继续该计划；单线保留原路径。新增回归验证下一皇冠、同一突破口及实际行进方向。
3. 大图早期战略截断抢占主攻顺序；副线 urgent 分支又能绕过送兵链预留。将大图可选截断留在正常主攻顺序之后，并限制副线抽走预留的主攻/回防/经济链，直接推冠仍可立即执行。取消大图远距兵堆硬排除，让原有距离/阻力评分决定是否发动进攻。小图保留已交付的行动排序。
4. 多线同帧重复执行 tactical/strategicCut/anchorDefense/constructionThreat、routeGuard 与全图预演；新增仅多线使用的 board 对象 WeakMap 缓存。候选扩张只算精确 send，入选后仍按前序动作后的局面执行 secureDecision/preview；建设威胁按需计算，达到 6 个动作后停止候选接纳。
5. 保留直接推冠无需防守前置、51 建/101 升、副线预算和顺序安全检查。未削弱旧断言或固定回放门槛。新增送兵链保护、跨帧及并行动作预演隔离、夺冠续攻回归，共 73 测试。

## 先小矩阵、再完整矩阵

小矩阵为 maze/mediterranean × 0.5/1 × simple × seat0，seed=apex-long-0-地图，1200 Tick，workers=4，无雾，Node v24.19.0，同机顺序运行修复前控制树与最终修复树。控制保留 trace=0/failures=0，最终为 trace=120/failures=4；决策计时包围策略调用，trace 位于外部，但仍披露该保留配置差异。策略与结束 Tick 变化也影响聚合延迟，不能把所有降幅都归因于重复计算消除。

| 小矩阵指标 | 修复前 PR（同机） | 最终修复 |
| --- | ---: | ---: |
| 胜 / 未决 / 终局败 | 1 / 3 / 0 | 3 / 1 / 0 |
| p50 | 13.90 ms | 9.35 ms |
| p95 | 52.37 ms | 34.55 ms |
| 平均 | 17.97 ms | 12.20 ms |
| >40 ms | 357/3934 | 76/2875 |

最终小矩阵逐局：

| 地图 / 尺寸 | 结果 | Tick |
| --- | --- | ---: |
| maze / 0.5 | 胜 | 413 |
| maze / 1 | 胜 | 620 |
| mediterranean / 0.5 | 胜 | 642 |
| mediterranean / 1 | 未决 | 1200 |

完整矩阵：四地图 × 两尺寸 × anti/simple × 双座位=32 局；原 seed、1200 server ticks（两 Tick=一个显示回合）、无雾，最终 workers=4。冻结基线与历史 PR 是 workers=6、Node v26.7.0；可复用确定性胜负，历史延迟仅供参考，不能冒充同负载性能 A/B。

| 套件 | 胜 / 未决 / 终局败 | 未决率 |
| --- | --- | ---: |
| 原版冻结基线 | 12 / 14 / 6 | 43.75% |
| 修复前 PR | 12 / 17 / 3 | 53.13% |
| 最终修复 | 13 / 15 / 4 | 46.88% |
| 基线大图 | 1 / 13 / 2 | 81.25% |
| 修复前 PR 大图 | 0 / 16 / 0 | 100.00% |
| 最终大图 | 1 / 14 / 1 | 87.50% |

两个原胜转未决 seed 的最终结果：maze/1/simple/seat0 胜 620 Tick；mediterranean/0.5/simple/seat0 胜 642 Tick。

最终完整矩阵 p50=14.46 ms，p95=52.37 ms，均值=18.14 ms，最大=177.23 ms，>40 ms 为 2535/25138。p50/p95 为 2% 对数桶上界估计，最大值精确；>40 ms 是计数，不是硬超时。32 局 errors=0、hardTimeouts=0。

相对冻结基线的全部胜负类别变化（未列出的类别相同，不代表过程相同）：

| 地图/尺寸/对手/座位 | 基线 → 最终 | Tick |
| --- | --- | --- |
| archipelago/1/simple/false | L → D | 1188 → 1200 |
| maze/0.5/simple/false | L → W | 1142 → 413 |
| mediterranean/0.5/anti/false | W → D | 467 → 1200 |
| mediterranean/0.5/anti/true | D → L | 1200 → 1060 |
| random/0.5/anti/false | L → W | 459 → 125 |

相对修复前 PR 的类别变化（包括基线也失败、但本次由未决变败的样本）：

| 地图/尺寸/对手/座位 | 修复前 PR → 最终 | Tick |
| --- | --- | --- |
| archipelago/1/simple/true | D → L | 1200 → 1077 |
| maze/1/simple/false | D → W | 1200 → 620 |
| mediterranean/0.5/anti/false | W → D | 827 → 1200 |
| mediterranean/0.5/simple/false | D → W | 1200 → 642 |

剩余基线胜局退化数量：1。 具体为：mediterranean/0.5/anti/false W→D（467→1200 Tick）。这些新增退化保留为上线 BLOCK；此次仅完成一次聚焦优化，不继续调参掩盖问题。大图仍有 14/16 截止未决，不能把多线动作数、减少终局败或单个 seed 的改善当成普遍效果提升。最终大图截止未决局中自身兵力领先/持平为 0/14；1200 Tick 检查点平均兵力比为 0.45、领土比为 0.49。1200 Tick 的大图统计仅包含存活至该检查点的样本，不能与已提前结束的胜/败局直接混算经济优势。

新增退化证据：archipelago/1/simple/seat1 在 1077 Tick 被淘汰（修复前 PR 在 1200 Tick 未决；冻结原版基线也曾失败），最终 JSON 因保留失败数量上限没有该局 failureTrace，不能声称查看了未保留的 trace。mediterranean/0.5/anti/seat0 在 1200 Tick 仍存活，兵力 7056 对 1037，累计 648 次 march、291 次 muster、47 次 crown，仍未完成淘汰，是优势收尾失败。两者均保留为 BLOCK。本轮没有进一步隔离到每项源码变更的因果贡献，按预算停止调参。

## 引擎兼容、单线与检查

- 对比 0af3f3c6 与最新 main：src/game-engine.ts 仅增加 getCompletionStats、修改 sendMessage 返回 boolean；移除这两个方法并归一化空白后，其余引擎源码程序比较完全相同。src/game-engine/**、src/map/** 无差异，对手代码哈希一致。离线评测不调用聊天或结算统计，故冻结基线有真实模拟逻辑不变的依据。最终所有评测直接编译最新 main 的真实引擎，未使用替代引擎。
- 单线额外 32 局矩阵在累计 20 分钟硬截止停止，完成 31/32。已完成 31 局的 ownWon/ended/turns 逐键对照冻结基线差异 0；缺失 ["mediterranean",1,"simple",false,false,"apex-long-0-mediterranean"]。进度日志不包含完整 stats/controller，未生成最终 JSON，故不宣称完整 32 局 parity 或本次单线评测前后源码哈希校验。单线代码路径保持原分支，原有单线终局哈希 parity 和固定回放回归仍通过，但完整矩阵证据缺口也保留为 BLOCK。
- pnpm 10.29.2 冻结离线安装根目录及 Apex 成功；未改锁文件。pnpm --dir bot-template/apex-bot test：73/73 PASS；pnpm run lint、pnpm run build、pnpm run format PASS。构建生成的 static/intro/player.js{,.br,.gz} 已还原，未提交产物。

## 时间、未采用结果和证据

从 2026-11-15T04:42:55Z 开始计入累计预算，硬截止 2026-11-15T05:02:55.000Z；结束时间：2026-11-15T05:02:55.132Z，累计 20.00 分钟（包含中止与中间小矩阵，未并行叠加 worker）。所有评测 workers≤4、Tick≤1200，无大训练、无批量下载回放。

首轮局部调整曾让 mediterranean 小图从未决变败，完整中间结果保存在 /tmp/apex-fix-small-initial.json；该方案未作为最终结果。保留小图排序后的小矩阵又因发现夺冠状态覆盖而中止，日志 /tmp/apex-fix-small-pre-breach-interrupted.log；更早缓存补全时也中止过未完成小矩阵，均未算进最终样本。最终小矩阵及 32 局采用同一冻结源码并校验前后哈希；未无止境调参或继续训练。

- 冻结基线：/tmp/apex-main-baseline-v3.json、/tmp/apex-main-baseline-single.json。
- 修复前完整 PR：/tmp/apex-main-final-v3.json。
- 同机小矩阵：/tmp/apex-fix-small-control.json、/tmp/apex-fix-small-final.json。
- 引擎等价证明：/tmp/apex-fix-engine-equivalence.json；同机控制树 4/4 的胜负、Tick、双方 stats、完整 controller 与历史 PR 逐局一致。
- 最终多线：/tmp/apex-fix-final-32.json。
- 最终单线完整 JSON 未生成（超时中止）：/tmp/apex-fix-single-32.log，仅 31/32 进度证据。
- 复核程序与结果：/tmp/apex-fix-verify.cjs、/tmp/apex-fix-comparison.json。
- 预算执行记录：/tmp/apex-fix-bounded-runs.json。
- 检查日志：/tmp/apex-fix-tests.log、/tmp/apex-fix-lint.log、/tmp/apex-fix-build.log、/tmp/apex-fix-format.log、/tmp/apex-fix-install-{root,package}.log。

签名提交并推送到原 PR163 feat/apex-multiline 分支；禁止合并/部署，完成推送即停止。

预算备注：20 分钟到点发送终止，进程退出记录为 05:02:55.132 UTC（调度/退出开销约 132 ms）；之后没有继续评测。单线最后缺失的 1 局未推测结果，也未计入完整通过。
