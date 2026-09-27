# 任务：Anti-Human Bot 截断逻辑 + 回廊（maze）地图专项优化

你在 /root/roka（Roka 仓库，已切到分支 feat/bot-cutoff-maze）。**先读 AGENTS.md、MAP.md、bot-template/anti-human-bot/README.md，严格遵守其中的开发准则**（pnpm、提交前 lint/build/format 全绿、版本号、文档同步等）。

Bot 代码在 bot-template/anti-human-bot/（bot/*.cjs 策略模块、test/*.test.cjs 单元测试、training/ 自对局进化框架）。离线训练用的引擎副本已放在 bot-template/anti-human-bot/reference/src/（本地专用，已加入 .git/info/exclude，**禁止 commit**；training/replays-0926/、training/results/ 同样禁止 commit；任何令牌禁止入库）。

## 背景

线上托管的 anti-human-bot 账号是 **Anti_Human**（不是 yuelan，yuelan 是另一个更弱的 bot，别搞混）。它整体操作可以（近 44h 87 场胜率约 72%），但有两类问题。2026-09-26 下午（UTC 04:00，新版上线）以来的 **18 场败局**回放已下载到 bot-template/anti-human-bot/training/replays-0926/（.rpl，UTC 时间戳）。分析回放可用仓库 scripts/ 下的 observe/replay 工具（见 MAP.md）或自写脚本。

## 目标一：截断（切断对方兵力连通）逻辑

引擎规则见 reference/src/game-engine.ts 的 applyConnectivity：一支队伍的格子只有连通到自己的皇冠才正常产出，被切断的孤立段兵力会折半衰减。现状：bot 有时不及时做截断——对方兵力散开后，明明我方当前回合占住某个点就能把对方一段兵力切成孤立状态（让对方损失折半），判断逻辑却把那段兵力当作「非孤立」放过了。

要求：
1. 每回合评估潜在截断点：若本回合占住某格（或少数几格的组合，可考虑两格截断）即可让敌方一段兵力变为孤立，识别出来并赋予高优先级。
2. 优先级定位：截断是「攻击对方皇冠」之后的次要但重要行为；**防守场景下**（对方对我方皇冠/生命有威胁时）截断优先于其他调兵或普通攻击。
3. **有效性判断**：截断前先确认截断有效——若被切断的那段含有敌方皇冠（或与敌方皇冠仍有连通路径，孤立不成立），则不要盲目截断。按引擎真实的连通判定来写，不要自己发明近似规则。
4. 为截断逻辑补单元测试（test/cutoff.test.cjs 已有基础，往里加用例：单格截断、多格截断、含皇冠无效截断、防守触发截断）。

## 目标二：回廊/迷宫（maze）地图专项

maze 图山脉多、路径窄，bot 表现差，症状三类：
1. 反复卡住：把兵力反复往一个地方集兵但不往前推进（死循环集兵）；
2. 建造决策在窄走廊里出问题（建错位置/该建不建）；
3. 兵力推进过深，反而被对方截断。

回放重点看这些 maze 败局：对 M_K_W_ 的 WwOSmkdho+Q9 与 uzsTrD97P1Qo、对 zwb1213 的 EBS5+Y2FcAcY（899 tick 长局）。先复盘定性（是上述哪类症状、发生在什么阶段），再针对性改代码，允许加 maze 专属分支逻辑或参数。其余 random/archipelago/mediterranean 败局（对 edu、helloworld、_E_、M_K_W_、zjf 等）用于排查截断时机的实例。**注意：winner 为 Bot2 的回放一律忽略**（Bot2 是用户自己的另一个 bot，不代表人类对手，没有参考价值），包括 eGh1S9Tisot0、XZnm82J+In1r、ZL19bXNzydRf、7Vxpn9QHzyBl、WvzSSkHw64rh、e3vo7NtLcqpp、JAnKXF5LDc6Y、YjHhp-N+6jR1、PcCMBC4EH76e。

## 目标三：建造精确性

建造门槛的实际机制：兵力到 51 就可以建造，到 101 可以继续往上升级（两级门槛就是 51 和 101，以引擎 reference/src/game-engine.ts 的真实规则为准）。现状问题：bot 的建造判断好像总是在门槛之上额外再加一些东西——例如某格已有 52 兵力、准备升级/建造，它还要额外调 30 兵力过来然后才建。这完全没必要，纯属耽误自己一个回合。

要求：
1. 建造/升级决策以「当前格兵力已满足门槛」为触发条件，满足即建，不要等增援到位再建。
2. 排查 bot/building.cjs 及相关模块里所有给建造加额外余量的判断，区分「引擎硬约束」（费用、孤立不可建等）和「策略自加的冗余门槛」——后者砍掉或收紧。
3. 注意别把防守所需的兵力预留误伤：如果是为了防截断/防皇冠被端而刻意留兵，那是另一回事，要在代码里注释清楚区分。
4. 补单元测试：兵力恰好 51 应立即建、52 不应再等增援、101 升级同理。

## 验证（全部本地，控制规模，不要长跑）

- `pnpm test`（bot-template/anti-human-bot 下）271 个现有测试必须保持全绿，新增用例也要过。
- 用 training/arena 自对局验证：轮次/种子/回合数都开小（turns ≤1500，workers ≤10），重点看 maze 图胜率相对 baseline（training/baseline/ 或 champion）有提升、其他三类图不明显退化。可以用 training/compare.cjs、defense-benchmark.cjs 等现成工具。
- 每次训练跑完把结论记到 spec 同目录的 notes.md（胜率数字、改动点、仍存在的问题）。
- 总测试时长控制在 30 分钟内，不要追求多轮进化，这是策略逻辑修复不是参数搜索。

## 收尾

- `pnpm run lint && pnpm run build && pnpm run format` 全绿（仓库根目录）。
- 行为变化同步更新 README.md；结构变化同步 MAP.md。另外 MAP.md 里 lobby-service 描述中「ELO（K=24）」已过时，实际已改为 64，顺手修正为 K=64。
- `pnpm version minor --no-git-tag-version` 升版本号。
- 提交遵守 AGENTS.md（GPG 签名已配好），**只提交到 feat/bot-cutoff-maze 分支，不要合并 main、不要 push**——由 Auto 验收后统一合并推送。
- 完成后输出：改动文件清单、每个问题的根因与修法、验证数据（maze 胜率前后对比、测试数）。
