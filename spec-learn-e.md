# 任务：深度学习玩家 _E_ 的操作并提升 Anti_Human（时间预算充足，做到 19:30 前）

你在 /root/roka（Roka 仓库，main 最新）。**先读 AGENTS.md、MAP.md、bot-template/anti-human-bot/README.md、根目录 notes.md**。遵守开发准则（pnpm、lint/build/format 全绿才提交、版本号、Conventional Commits + GPG 签名）。

从 main 切新分支 `feat/bot-learn-e` 开发，完成后只提交分支，不合并不 push，维护者验收。reference/、replays*、results、spec、notes、data 严禁入库。

## 背景与素材

玩家 **_E_** 是线上最强的人类对手之一，今天多次击败 Anti_Human。他的 28 场回放已全部下载到 `bot-template/anti-human-bot/training/replays-E/`（.rpl，UTC 时间戳）。

特征速览：他对 Anti_Human 的胜局普遍很短（116–267 tick），对弱 bot yuelan 更快（76–186 tick）——**疑似快攻/早期压制滚雪球型打法**。他也有败局（败给 Anti_Human 的 520t/1119t 长局、败给 zjf/zwb1213/lmj 的局），对照组同样有价值：他输的时候输在哪。

可用工具：仓库 `scripts/observe-replay.mjs`、`scripts/extract-replay-frames.mjs`、`scripts/show-board.mjs`（见 MAP.md），也可自写分析脚本（解码方式：.rpl = brotli+v8 deserialize，meta 含 player_names/rank，patch 流见 replay-store）。

## 工作要求（时间预算充足，这次允许深挖）

### 第一阶段：操作画像（先学透再动手）

1. 逐局分析 _E_ 的胜局（尤其 8 场胜 Anti_Human），**提取他的操作模式**：
   - 开局节奏：前 50/100 tick 的扩张速度、方向选择、首个建造时点与位置
   - 进攻模式：什么时候开打、兵力阈值、单兵流还是集兵流、如何多线操作
   - 兵力效率：每 tick 平均动员率（移动/建造占比）、闲置兵堆比例
   - 防御反应：被攻击时的应对模式
   - 滚雪球方式：拿到优势后如何转化胜势（快局在 116–267 tick 终结对手，到底发生了什么）
   - 终局调戏行为（困死后涂色拖时间）忽略，不分析。
2. 对照分析他的败局：Anti_Human 赢他的局（尤其 1119t 长局）赢在哪，什么操作能压制他。
3. 把 Anti_Human 在同局的对应操作拉出来逐项对比，找出**可操作的具体差距**（不是「他更强」这种废话，是「第 N  tick 他做了 X 而 bot 做了 Y」）。

### 第二阶段：改进实现

把学到的模式转化为 bot 策略代码改动。优先做收益最大的差距项。每一项改动要能追溯到第一阶段的具体发现。

### 第三阶段：验证

- 301 个现有测试保持全绿，新逻辑补测试。
- 这次**允许跑自对局验证**（预算充足）：改完后用 training/train.cjs 或 compare 跑 vs champion/premacro 基线，规模适度（如 24–48 局），看 random 图负率与平均败局时长是否改善。
- lint/build/format 全绿，版本号 minor，README/MAP 同步。

## 汇报

- _E_ 操作画像（开局/进攻/效率/滚雪球四张表，带实例 tick）
- 他败局的教训
- 每项改动的溯源（学自他哪招）
- 验证数据

时间截止 19:30（CST），如提前完成直接提交汇报。