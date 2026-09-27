# 任务：写 Roka 全量 rating 重算脚本（一次性脚本，不提交仓库）

你在 /root/roka（Roka 仓库，main 最新）。写一个**一次性脚本** `scripts/recalc-full-k128.mjs`（不 commit、不 push、不入库）。

## 背景

服务端 ELO 结算逻辑在 `src/server/lobby-service.ts`（`applyGameResult` 附近）与 `src/auth-store.ts`（`applyRatingUpdates`、`DEFAULT_RATING=1200`、展示分位移逻辑只是显示层）。rating 的 K 值刚改为 128（`RATING_K` 常量）。现在要把**历史上全部对局**按当前结算逻辑（K=128、队伍立方加权、队伍位次 score）重算一遍。

## 数据（脚本在服务器上跑，路径写死）

- `/root/roka/data/replays/index.bin`：v8 deserialize 的对局索引（id/time/turn/rank 等字段）
- `/root/roka/data/replays/<id>.rpl`：v8 deserialize(brotliDecompress(内容))，meta 里有 player_names、map_mode、rank/名次等
- `/root/roka/data/users.bin`：v8 deserialize 的用户存储（结构读 src/auth-store.ts 的序列化代码确认），字段含 rating、ratingGames、ratingHistory
- 参考写法：`/root/roka/data/scan-yuelan-daily.mjs`（服务器上）展示了解码方式；仓库 `src/game-engine/replay-store.ts` 是权威。

## 脚本要求

1. 按时间顺序遍历全部 1129 场对局，从 DEFAULT_RATING=1200、ratingGames=0 起算，每场按与 `applyGameResult` **完全一致的公式**结算（含 K=128、队伍强度 400·log10(n³·Σ10^(r/400))、score=(teams-rank)/(teams-1)、队内成员同 delta、delta 四舍五入规则、ratingHistory 记录规则——全部以源码为准逐行对齐）。
2. 跳过线上实际不结算的对局类型（看源码里 applyGameResult 的触发条件，如人数不足/观战等，注释说明）。
3. **dry-run 默认**：只输出报告——影响用户数、每用户 旧值→新值（含 ratingGames 变化）、最大 |delta| 前 20 名明细，不写任何文件。
4. `--apply` 模式才写 users.bin（写前再强制做一次 `fs.copyFile` 备份，文件名带时间戳；序列化方式必须与 auth-store 写盘格式逐字节一致——v8 serialize，注意是否有 brotli，读源码确认）。
5. 自检：重放后所有用户 ratingGames 之和应等于 2×有效对局的人均参赛数（自行给出一致性校验指标），报告里打印。
6. 脚本顶部注释写清用法与风险。

## 收尾

- 只需保证 `node scripts/recalc-full-k128.mjs`（dry-run）在**有数据的环境**能跑；本地无数据，可用 `node --check` 和构造最小假数据自测语法与主流程。
- 汇报：结算公式与源码的对照点、跳过的对局类型、写盘格式确认依据。