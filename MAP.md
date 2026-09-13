# Roka 项目地图（MAP.md）

> 用途：让后续维护不必每次重新探索代码库——看本图即可定位。
> 约定：**提交涉及结构/功能变化（新增/删除/移动文件、改动职责、改协议）时，必须同步更新本文件**（见 AGENTS.md）。
> 本文与代码同步的基准：main 分支最近提交。发现不一致时以代码为准并顺手修正本文。

## 架构一图流

```
浏览器（无构建原生 JS + jQuery，static/）
   │  REST（/api/*）+ socket.io（对局/房间实时协议）
   ▼
src/server.ts ── Fastify 路由 + socket.io 事件（唯一入口）
   ├── src/server/auth-service.ts     JWT / 单连接互斥
   ├── src/server/captcha-service.ts  图形验证码
   ├── src/server/lobby-service.ts    房间/对局状态机、断线宽限期、ELO 结算、托管 bot 房长保留
   ├── src/server/server-bot-manager.ts  托管策略 Bot 管理器（进程内自连、内存令牌鉴权、重启自动恢复）
   └── src/server/webhook-updater.ts  GitHub push 自动部署
   ▼
src/game-engine.ts ── 对局核心（Tick 循环、战斗、连通、投降、回放记录）
   ├── src/game-engine/*              常量/主城选择/排行榜/编码/回放工具/增兵
   └── src/map/*                      四种 map_mode 地图生成器（纯函数）
   ▼
持久化（data/，均被 gitignore）：announcement-store / auth-store / feed-store / replay-store；server-bots.json（托管 bot 重启恢复状态）
```

关键事实：

- 后端 TypeScript（`src/`）经 `pnpm run build` 编译到 `dist/` 运行；`dist/` 不手工编辑。
- 前端无构建流程，`static/` 原样下发；协议/格式改动需前后端同步（见文末速查表）。
- 玩家身份 = socket.id（sid）；对局协议与格子编码的权威文档是 `static/develop-bot.html`。

## 目录结构树

```
├── src/                    # 后端 TypeScript 源码
│   ├── server.ts           # 主入口：Fastify 路由 + socket.io 事件
│   ├── game-engine.ts      # 对局引擎核心（~1500 行）
│   ├── game-engine/        # 引擎子模块（常量/选点/榜单/编码/回放/增兵）
│   ├── map/                # 地图生成器（random/maze/archipelago/mediterranean）
│   ├── server/             # 服务层：auth / captcha / lobby / webhook
│   ├── types.ts            # 全项目共享类型与协议定义
│   ├── *-store.ts          # 四个持久化存储（公告/用户/动态/回放）
│   ├── replay-patch-binary.ts  # RPB3 观看二进制编码器
│   ├── text-render.ts      # Markdown+LaTeX → 消毒 HTML（公告/动态共用）
│   ├── rating-color.ts     # Codeforces 风格段位配色
│   └── runtime-env.ts      # .env 引导与密钥自动生成
├── static/                 # 前端（原生 JS，无构建，原样下发）
│   ├── index.html          # 首页/大厅（脚本基本内联，另加载 /notify.js）
│   ├── game.html           # 对局/回放共用骨架
│   ├── main.js + main/     # 对局/回放主控与模块（加载顺序敏感）
│   ├── notify.js           # 浏览器通知共享模块（首页与对局页共用）
│   ├── profile.html|.js    # 个人主页
│   ├── admin.html|.js      # 后台管理页（用户列表/封禁/权限分配）
│   ├── tutorial*           # 文字教程 + 互动教程（本地迷你引擎）
│   ├── develop*.html       # 开发指南 + bot 协议权威文档
│   ├── login.html / about.html
│   ├── styles/             # 样式表（按页面切分，main.css 聚合入口）
│   ├── vendor/katex/       # 本地化 KaTeX（公式渲染）
│   └── *.png / *.mp3 / 字体 # 地块贴图、音效、Quicksand/HYMaQiDuo 字体
├── scripts/                # 维护脚本（数据迁移、bot 冒烟测试、对局观测分析）
├── bot-template/           # random-patch-bot（协议最小参考）与 simple-strategy-bot（策略 bot）
├── data/                   # 运行时数据（gitignored）：users.bin / feeds.bin /
│                           #   announcement.json / server-bots.json / replays/*.rpl(+缓存)
├── dist/                   # tsc 构建产物（勿手改）
└── .github/                # dependabot + 唯一的 CI（评论触发升版合并 PR）
```

---

## 后端源码地图（src/）

### 入口与服务层

**src/server.ts** — HTTP+WebSocket 总装入口，全部路由与 socket 事件在此。
`boot()` 依次：`ensureRuntimeEnv()` 补全 `.env` → 四个 Store `ensureReady()` → 全局限流（`resolveRateLimitKey` 处理反代真实 IP）→ 认证钩子（非公开路径校验 cookie JWT）→ REST 路由（认证/动态/公告/排行榜/在线状态/后台管理/回放/房间/地图示例）→ `SocketIOServer`。后台管理：`GET /admin` 页面与 `GET /api/admin/users`、`POST /api/admin/ban|unban|set-admin` 接口经 `requireAdmin` 统一校验管理员身份（非管理员 403/重定向），`set-admin` 再校验超管；策略 Bot 接口 `GET /api/admin/bots`、`POST /api/admin/bots/start|stop` 经 `requireSuperAdmin`（requireAdmin + 超管），`start` 校验用户存在且未封禁、房间号长度 1~15，由 `serverBotManager` 在进程内启动 simple-strategy-bot；登录路由在密码校验后检查封禁状态（403 拒绝），封禁成功即 `clearSession` + `disconnectUserSockets` 踢下线。socket 中间件支持 cookie JWT、`ROKA_BOT_TOKENS` bot 令牌（命中时置 `socket.data.isBot` 并加入心跳豁免集）与托管 bot 内存临时令牌（`serverBotManager.resolveToken` 命中时置 `isBot` + `isServerBot`）；所有 bot 连接（isBot）不参与单连接互斥（不顶号、不被顶号、不计入 userSocketIds）；`?home=1` 连接只做全局通知、不参与单连接互斥。在线状态追踪表 `onlineSocketIds`（覆盖含 `?home=1` 的所有非 bot 连接、按用户名去重）：连接时刷新用户 `lastSeenAt`（上线），最后一个连接断开时再刷新一次（下线），变化经 2 秒节流广播 `home_online`；`GET /api/online` 返回在线人数与最近下线列表（前 8，排除当前在线者）。对局指令（`attack`/`build`/`clear_queue`/`pop_queue`/`surrender`）经 `lobbyService.gameUid` 路由到对局实例；`join_game_room` **先 `tryRejoin` 尝试断线重连换绑**（身份匹配：bot 与人类同名连接互不接管席位），否则正常进房/观战；`room_heartbeat` 记录房间心跳（准备阶段 600 秒无心跳被踢并收到 `room_kick`）；`disconnect` 调 `checkLeave(..., username, isBot)` 走宽限期挂起。回放路由：`/api/getreplay/:id` 发 gzip 缓存 + `X-Replay-Size` 进度头（加载失败删库）；`/api/downloadreplay/:id` 发原始 `.rpl`；`/api/replay-upload` 转码上传文件。

**src/server/lobby-service.ts** — 房间/对局状态机 + 断线宽限期 + 房间心跳踢出 + rating 结算 + 托管 bot 房长保留。
核心 Map：`gameUid`(sid→gameId)、`gameInstances`、`gamePlayers`、`gameLobbyId`、`lobbyOfSid`、`lobbyPlayers`、`lobbyConfig`；宽限期登记表 `pendingRejoins`（键 `${gameId}:${username}`，含旧 sid、旧连接是否 bot 与 10s 定时器）；心跳登记表 `lobbyHeartbeats`（sid→最后心跳时间）+ bot 豁免集 `heartbeatExempt`（由 server.ts 维护）。`joinLobby` 第四参数 `serverBot`：托管策略 bot 永远排在普通成员之后（`LobbyPlayer.serverBot` 标记），房主（`players[0]`）保留给人类/第三方 bot——普通成员进房时插入到首个托管 bot 之前，无 bot 时等价末尾追加；托管 bot 所在房间不允许组队——bot 进房时若房间已开组队则强制关闭并规整队伍（server.ts 的 `change_game_conf` 同步拦截房主的开启请求并提示），`room_update.players[]` 对托管 bot 成员附带 `server_bot: true` 供前端锁定组队开关。`checkLeave`：对局中断线 → `game.markDisconnected`，截断旧路由但保留席位，挂 `expireGracePeriod` 定时器，超时以「挂机」投降并完整清理；`tryRejoin`：按用户名找旧 sid（`findPlayerSidByName`）并校验身份匹配（bot 连接只能接管 bot 的旧席位、人类只能接管人类的，以旧 socket 的 `data.isBot` 或宽限期登记为准，防止托管 bot 与同名真人互相抢席位），清定时器、全部 Map 换绑、`game.rebindPlayer` 补发全量状态。`checkReady` 开局条件：非观战成员中 ready 超过半数；组队模式下若所有参赛者处于同一队伍则拒绝开局并提示调整队伍（否则首 Tick 存活队伍数即为 1，开局即终局）。心跳掉线检测（仅房间准备阶段）：`recordLobbyHeartbeat` 刷新时间戳（进房即为基线），`startLobbyHeartbeatSweep` 全局单一定时器每分钟扫描，超过 600 秒无心跳且房间未开局的成员由 `kickFromLobby` 复用离开清理逻辑移出房间并下发 `room_kick`（前端跳首页）；对局中的房间与豁免 bot 跳过。`startGame` 组装 `GameConfig`（动态地图尺寸、自动分队）并注入 io 回调；`endGame` 里 `applyGameResult` 结算 ELO（K=24，队伍名次取队内最好、rating 取队内平均），清理宽限定时器并重置房间。`onGameEnded` 回调通知 webhook-updater 解除部署推迟。

**src/server/server-bot-manager.ts** — 服务端托管策略 Bot 管理器（issue #18，仅超管经 `/api/admin/bots*` 操作）。
不另起进程：每次启动生成随机内存令牌（`tokens` Map：token→username，server.ts socket 中间件查询 `resolveToken`，命中置 `isBot` + `isServerBot`），在服务器进程内用 socket.io-client 连本机回环地址（端口经 `getPort` 回调读取 listen 端口）完成正常握手；策略复用 `bot-template/simple-strategy-bot/strategy.js`（`createRequire` 按 `process.cwd()` 动态加载 plain JS，CLI 与服务端同一份代码）。`start(username, room)` 拒绝同用户重复启动；`stop(id)` 拆监听、断连、删令牌；`list()` 出运行中 bot（含连接状态）。日志走 `console.log` `[server-bot]` 前缀（冒烟脚本据此判定对局行为）。重启自动恢复（issue #28）：start/stop 把运行中 bot 的 `{username, room}` 列表原子写入 `data/server-bots.json`；`restore(validateUsername)` 在 listen 后由 server.ts 调用，逐条重做与手动启动相同的校验（用户存在且未封禁、房间号长度 1~15、策略文件可加载），全部通过才以原配置自动启动，失效记录记警告跳过并随写盘清除。

**src/server/auth-service.ts** — JWT 签发校验 + 用户 socket 单连接互斥。
JWT 载荷 `{sub, sid}`，`sid` 经 `userStore.isSessionValid` 校验（重登录轮换 session 使旧令牌失效）；cookie 名 `auth_token`，7 天。`userSocketIds` 配合 `disconnectOtherUserSockets`（新连接踢旧连接=顶号）/ `disconnectUserSockets`（登录/登出全踢）；`isPublicPath` 定义免登录白名单。

**src/server/captcha-service.ts** — canvas 渲染的一次性图形验证码（注册/登录防机器人）。
4–6 位字符（去易混淆字符），`@napi-rs/canvas` 多画布管线（噪声→mask→正弦扭曲→渐变着色）输出 PNG data URI；`verifyAndConsume` 一次性消费，带 `minSolveMs=1100` 防过快提交；纯内存 5 分钟 TTL。

**src/server/webhook-updater.ts** — GitHub push webhook 自动部署。
`isAuthorized` 校验 `x-hub-signature-256` HMAC；**有对局进行中则置 `hasQueuedUpdate` 推迟**，`notifyGameEnded()` 后补跑。流水线：`git fetch/reset --hard origin/main` → `pnpm install --frozen-lockfile` → `pnpm run build` → systemd 下 `exit(0)` 靠守护重启，否则 spawn 延迟重启。

### 对局引擎

**src/game-engine.ts** — 对局核心：全状态 + Tick 主循环，无战雾全图广播。
`GameEngine.create()` 静态工厂生成地图（按 `map_mode` 调 `src/map/` 生成器）并选主城；`startGame → beginLoop → scheduleNextTick` 按 `500/speed` ms 走 `gameTick()`：增兵 → pstat 计数/超时击杀 → 按奇偶反转顺序执行每队队首操作（`chkMove/attack`，含智能分兵 `computePush`；X 建指挥所/C 升级主城均耗 50 兵）→ `applyConnectivity` 队伍级连通 BFS（断链减半、孤军 5 回合宽限后每回合 5% 衰减、重连 ×2）→ AFK 判定 → 胜负判定 → 记录回放 → `sendMap`（diff 帧，每 50 tick 或 1/51 概率全量）。对外接口：`addMove/addBuild/clearQueue/popQueue/addSpectator/sendMessage/surrender/leaveGame`。掉线宽限期三件套：`markDisconnected`（只记 `disconnectedAt[id]`，期间跳过 AFK）、`rebindPlayer`（换绑 sid 与 md5 client_id、清队列防幽灵操作、补发 `init_map`+全量帧）、`expireDisconnect`（超时按「挂机」投降，幂等）——计时编排由 lobby-service 负责。投降 `applySurrenderByIndex`：有存活队友则转移领土，否则拆锚点打入孤军。回放：终局 `saveHistory` 存 ops-v1 操作流；`buildReplayFromActions` 用 `__replay_build__` 哑引擎重放整场生成 `ReplayData`（回放重建、地图示例均走此路）。

**src/game-engine/constants.ts** — 数值常量集中地。
`LEFT_GAME=52`、`AFK_MIN_TURNS=60`/`AFK_MIN_MS=60_000`（挂机投降需同时满足）、`DISCONNECT_GRACE_MS=10_000`（掉线宽限，1 倍速=20 tick）、`ISOLATED_DECAY_RATIO=0.05`、`ISOLATED_GRACE_TICKS=10`。调平衡数值只改这里。
_一句话：AFK/掉线/孤军等数值常量。_

**src/game-engine/general-selection.ts** — 开局主城位置选择。
`selectRandomGenerals`：500 组最大-最小贪心候选按间距评分加权轮盘抽取，含按面积/人数折算的硬性最小间距约束（不可达时放宽到最优可达值）；`selectMazeGenerals`：保留迷宫预设位 + BFS 最短路贪心选点。选不出的玩家直接出局。
_一句话：开局主城位置选择（随机/迷宫两套）。_

**src/game-engine/leaderboard.ts** — 每 tick 排行榜与终局名次。
`buildLeaderboard` 扫图累加 army/land，`class_` 标记 `dead`/`afk`；`buildFinalRank` 存活者优先，出局者按出局先后/领土/兵力决胜。
_一句话：每 tick 排行榜与终局名次计算。_

**src/game-engine/map-encoding.ts** — 棋盘状态 → 扁平协议数组。
`buildFullVisionArrays` 产出 `{grid_type, army_cnt, isolated}`；grid_type 编码：山 201、中立 200、沼泽 204/owner+150、指挥所 owner+50、主城 owner+100、普通格 owner；isolated：0 正常/1 宽限期/2 衰减期。前端渲染直接消费，**改动需前后端同步**。
_一句话：棋盘状态 → 扁平协议数组编码。_

**src/game-engine/replay-helpers.ts** — 帧差分与克隆工具。
`getDiff` 生成 `[index, value]` 对（实时 diff 帧同用）；`buildReplayPatch` 生成 forward/backward 双向 patch；`toMoveDirection` 坐标→方向索引。
_一句话：回放/实时帧 diff 与 patch 构建。_

**src/game-engine/replay-turns.ts** — 每 tick 操作 → ops-v1 紧凑操作流（存储格式）。
无操作累加 `w n`、投降 `r`、选中变化 `s x y`、建造 `b/c`、移动 `m`+方向+`h/a` 修饰。与 `replay-scheduling.ts` 互为逆变换，**改动需成对检查**。
_一句话：每 tick 操作 → ops-v1 紧凑操作流。_

**src/game-engine/replay-scheduling.ts** — ops-v1 操作流 → 按回合调度的动作表。
遍历 op 序列还原 `scheduledMoves/Builds/Surrenders` 三张 per-player turn→action 表，供 `buildReplayFromActions` 逐 tick 喂回引擎。
_一句话：ops-v1 操作流 → 按回合调度的动作表。_

**src/game-engine/tick-growth.ts** — 兵力增长规则。
主城每 tick +1；普通格每 50 tick +1（孤军不产）；26–50 tick 爆发期普通格每 tick 额外 +1；指挥所不吃爆发；沼泽/中立永不产兵。
_一句话：主城/地块/爆发期兵力增长规则。_

### 地图生成（src/map/，纯函数层）

**src/map/map-core.ts** — 公共底座：`Tile` 类型（-2 出生点/-1/0 空/1 山/2 沼泽）、`SeededRandom`（SHA-256(token) 驱动 mulberry32，同 token 同图）、`computeBaseMapDimensions`（45×45 按 ratio 缩放取奇）、`checkConnection`（并查集，主连通分量 >90%）、`markLargestComponent`、地形系数派生。
_一句话：地图生成器公共底座（Tile 类型、种子 RNG、连通性）。_

**src/map/map-size.ts** — `resolveMapSizeRatioByPlayers`：人数 → 地图宽高比例（二次函数，下限 0.34）。
_一句话：人数 → 地图宽高比例的纯函数。_

**src/map/random-map-generator.ts** — 默认随机图：按概率撒山/沼泽（上限 0.24/0.16），反复重试直到连通；同时定义所有生成器共用的 `MapGenerationConfig`/`GeneratedMap` 类型。不预置中立城市（城市只由玩家建造）。
_一句话：默认随机图生成 + 生成器公共类型定义。_

**src/map/maze-map-generator.ts** — 「峡谷回廊」：DFS 回溯迷宫 + 按面积 3% 打通额外墙（防 2×2 空地）+ 沼泽点缀；尺寸过小回退随机图。
_一句话：DFS 迷宫 + 限量开墙 + 沼泽点缀。_

**src/map/archipelago-map-generator.ts** — 「群岛要塞」：沼泽海上放 3×3–4×4 矩形岛（互不邻接，≥2×人数+1 个），海岸噪声扩边，多次重启贪心挑分散的玩家出生岛；重试上限 220 次，失败回退随机图。
_一句话：矩形群岛 + 分散出生岛挑选，失败回退随机图。_

**src/map/mediterranean-map-generator.ts** — 「地中海」：椭圆径向公式填中央海（沼泽+零星山），外围环形陆地撒山/沼泽；多源 BFS 算距海距离，在外缘带挑「不靠海」的分散出生点。
_一句话：中央海椭圆 + 环陆出生点分散选址。_

### 存储与工具

**src/auth-store.ts** — 用户/会话/Rating 存储（`data/users.bin`，v8 serialize + brotli）。
密码 scrypt 加盐 + `timingSafeEqual`；角色模型：首个注册用户 = 超级管理员（`isSuperAdmin`，唯一、不可剥夺、不可封禁，同时拥有 admin），普通 admin（`isAdmin`）由超管授予/撤销（`setAdmin`），旧数据启动时由 `migrateRoles` 把首个用户升级为超管（向后兼容）；封禁字段 `bannedUntil`（毫秒时间戳，-1=永久，缺省=未封禁），到期由 `getBanStatus` 惰性判定自动解除，`banUser`/`unbanUser` 操作，`listUsersForAdmin` 出后台用户列表；Rating Codeforces 风格：内部 1200 起算，`toDisplayRating` 按 `1200/2^对局数` 折算新手显示分，`ratingHistory` 存显示分（上限 1000 点）。可选字段 `lastSeenAt` 记录最后在线时间（连接建立=上线、最后连接断开=下线，由 server.ts 在线追踪维护；旧数据无此字段按 undefined 兼容），`markLastSeen` 刷新、`listRecentlySeen` 出最近下线倒序列表。
_一句话：用户/会话/Rating 存储，brotli 压缩 users.bin。_

**src/feed-store.ts** — 动态存储（`data/feeds.bin`，同 v8+brotli）。
分页 `listPage`/`listByAuthor`；发帖 1–300 字 + 30 秒/人冷却（`FeedCooldownException` 带 `retryAfter`）；评论 1–200 字、每帖上限 200 条；点赞切换。
_一句话：动态帖子/点赞/评论存储，带发帖冷却。_

**src/announcement-store.ts** — 公告单文件 JSON 存储（`data/announcement.json`），原子串行写，`ANNOUNCEMENT_TEXT_MAX=500`。文本本身不渲染，渲染由上层经 `text-render.ts` 完成。
_一句话：公告单文件 JSON 存储，原子串行写。_

**src/replay-store.ts** — 回放存取、索引与观看二进制 gzip 缓存（`data/replays/`）。
原始 ops-v1 操作流经 v8+brotli 存 `<id>.rpl`（id = 内容 sha256 前 9 字节 base64）；索引 `index.bin`。`readReplayViewGzip`：观看路径——缓存 `<id>.rpb.gz` 命中即返回（`size` 取自 gzip 尾 ISIZE 供进度条），未命中则重建整场 → RPB3 编码 → gzip 落盘缓存。`resolveReplayPath` 校验 id 防路径穿越；`deleteReplay` 同删 .rpl/.rpb.gz/索引。
_一句话：回放存储与 RPB gzip 缓存，id 为内容哈希。_

**src/replay-patch-binary.ts** — `ReplayData` → RPB3 观看二进制编码器（手写 LE；initial 全量帧 + 逐 patch forward/backward 差分 + 玩家 meta）。仅编码无解码——解码在前端 `static/main/replay-binary.js`；**改格式需同步前端并升魔数**。
_一句话：ReplayData → RPB3 观看二进制编码器。_

**src/text-render.ts** — 服务端富文本渲染，公告与动态共用唯一入口 `renderRichText`。
流程：KaTeX 预渲染 `$$..$$`/`$..$` → marked（GFM+breaks）→ 换回公式 HTML → sanitize-html 白名单（仅 http(s)/mailto scheme）过滤 XSS。新增允许的 KaTeX 标签/样式需同步改 `sanitizeOptions`。
_一句话：Markdown+KaTeX 渲染并消毒为安全 HTML。_

**src/rating-color.ts** — `ratingTier(rating, ratingGames)` → `{className: 'rt-*', title}`，阈值仿 Codeforces（<1200 gray … ≥2400 red），无对局为 unrated。CSS 类对应 `static/styles/rating.css`。
_一句话：Codeforces 式 rating 段位颜色映射。_

**src/runtime-env.ts** — 启动期 `.env` 自解析（不依赖 dotenv），`JWT_SECRET`/`WEBHOOK_SECRET` 缺失则自动生成并回写 `.env`。
_一句话：.env 加载与密钥自动生成回写。_

**src/types.ts** — 全项目共享类型与协议常量（纯类型）：`MAX_TEAMS=16`、`MoveMode`（0 智能分兵/1 半兵/2 全冲）、大厅/房间视图、`UpdatePayload`（grid_type/army_cnt/isolated/lst_move/leaderboard/kills/is_diff）、回放类型（`ReplayPatch` forward/backward、`ReplayActionData` ops-v1 操作流）、Feed 类型。**改协议字段基本都要动这里。**
_一句话：共享类型/协议定义汇总。_

**dist/** — `pnpm run build`（tsc）产物，目录结构与 `src/` 一一对应，是运行时实际加载的代码；勿手改，行为与源码不符时先确认是否重新 build。

---

## 前端源码地图（static/）

无构建的原生 JS + jQuery。页面分两类：

- **内容/文档页**（about、develop、develop-bot、tutorial-text）：各自内联样式与极简脚本，仅需 `loadUser()` 鉴权。
- **功能页**：index.html / profile.js（REST 交互，socket `home_*` 失效通知驱动刷新）；game.html + main.js + main/\*（对局与回放共用一套骨架，**脚本全局化、加载顺序敏感**）。

### 功能页

**static/index.html**（~1000 行，脚本基本内联）— 首页/大厅：个人信息、房间列表、回放列表与上传、动态、公告、排行榜、在线人数与「刚刚在线」。
数据走 REST，socket 以 `?home=1` 连接监听 `home_rooms/home_replays/home_leaderboard/home_announcement/home_feeds/home_online` 失效通知（事件无 payload）。顶栏在线人数与右栏「刚刚在线」（排行榜下方，前 8 位最近下线用户的相对下线时间）由 `/api/online` 驱动。`home_online` 收到后对比在线人数快照，增加时经 `notify.js` 弹「有玩家上线」后台通知；`home_rooms` 收到后对比房间号快照，出现新房间时弹「有新的房间」后台通知。公告缓存 `announcementRawText` 供编辑回填、注入服务端消毒的 `data.html`；动态原文存 `$item.data('raw-text')`；上传回放 POST `/api/replay-upload` 后以 base64 存 sessionStorage 跳 `/replays/local`。
_一句话：首页大厅，房间/回放/动态/公告/排行榜全内联脚本。_

**static/game.html** — 对局页与回放页共用 DOM 骨架，无业务脚本。
按序加载 crown.js → core-globals → notify.js → replay-binary → room-controls → replay-controls → render-update → blink-clock → main.js（顺序敏感）。关键 DOM：`#disconnect-banner`（断线横幅）、`#map`、`#menu`、`#status-alert`（按钮按下标访问，改结构需同步 main.js）、`#replay-loading(-text)`、`#replay-error-alert`。
_一句话：对局/回放页骨架与脚本加载顺序。_

**static/main.js** — 对局/回放主控制器：socket 生命周期、键鼠触屏输入、本地操作队列、房间渲染、回放加载。
回放模式：`/replays/local` 读 sessionStorage，否则 `fetchReplayWithProgress` 流式下载（`X-Replay-Size` 头更新 `#replay-loading-text` 进度），完成后 `decodeReplayBinary` + `replayStart`。对局模式：`connect` 隐藏断线横幅并重发 `join_game_room`（支撑 10 秒宽限恢复）并启动房间心跳（每 30s 一次 `room_heartbeat`，防止准备阶段被服务器因 600 秒无心跳踢出）；收到 `room_kick` 跳转首页；`disconnect` 区分顶号（跳首页）与断网（显示横幅）；`room_update` 对比成员 uid 快照检测新玩家进房、`starting` 表示开局，两者在页面后台时经 `notify.js` 弹浏览器通知；操作入队 `addroute/addbuild/...` 后 emit；`keypress` 分发 WASD/Z/X/C/Q/E/T/Enter/Esc/空格。
_一句话：对局/回放主控：socket、输入、队列、回放加载。_

**static/main/core-globals.js** — 跨文件共享常量（须最先加载）：`htmlescape`、方向表、回放魔数 RPB1/2/3、`replay_class_from_code`、共享 TextDecoder、`normalizeMapTokenInput`。
_一句话：共享常量：方向表、回放魔数、转义工具。_

**static/main/render-update.js** — 帧渲染器：`render()` 全量重算格子 class/内容（归属着色、selected/attackable/isolated、队列箭头、建造角标），仅变化时写 DOM；`update(data)` 消费 `is_diff` 差分或全量帧，按 `lst_move.skip` 同步本地队列，渲染排行榜/回合计数/爆发期红边，处理 `kills[client_id]` 与 `game_end` 结算弹窗。
_一句话：帧渲染器：update 帧合并 + 地图/榜单更新。_

**static/main/replay-binary.js** — RPB1/2/3 回放二进制解码器，产出 `{n,m,initial,patches[],meta}`；帧结构与 socket `update` 同构，直接喂 render-update.js。**格式变更须与 `src/replay-patch-binary.ts` 同步。**
_一句话：RPB1/2/3 回放二进制解码为 update 帧。_

**static/main/replay-controls.js** — 回放步进/跳转/自动播放（`backTurn/nextTurn/jumpToTurn/switchAutoplay`）与投降弹窗显隐。
_一句话：回放步进/跳转/自动播放与投降弹窗。_

**static/main/room-controls.js** — 房间大厅 UI：链接复制、设置 tabs 三件套（`getTabVal/setTabVal/initTab`）、队伍切换（`change_team`）、房主配置 emit `change_game_conf`（种子失焦上传）、聊天队伍前缀。
_一句话：房间设置 tabs、链接复制、队伍与聊天前缀。_

**static/main/blink-clock.js** — 全局闪烁时钟：在 `#map` 容器上周期切换 `blink-slow`（1s 衰减期）/`blink-fast`（0.4s 宽限期）/`pulse-soft`（1.2s 教程目标），单元格只挂声明 class，相位统一驱动。
_一句话：#map 容器级闪烁相位时钟，三种周期。_

**static/profile.html / profile.js** — 个人主页 `/u/:username`：资料卡、最近 rating 变更、手写 SVG rating 历史折线图（峰值金色高亮）、TA 的动态与回放。动态部分与首页代码平行（数据源换 `/api/profile/:u/feeds`）。
_一句话：个人主页逻辑：SVG rating 图 + 动态/回放。_

**static/admin.html / admin.js** — 后台管理页 `/admin`（仅管理员；页面入口在首页顶栏，仅 admin 可见）：用户列表（用户名/rating/注册与最后在线时间/角色/封禁状态）分页展示（每页 20 条，前端即时过滤），顶部搜索框按用户名子串即时筛选并显示用户总数/匹配数；封禁对话框（1 小时/1 天/7 天/自定义小时/永久）与解封，超管额外可授予/撤销管理员。JS 按功能分区（顶部 chrome / 用户管理 / 封禁对话框 / 策略 Bot），便于扩展新管理模块。「策略 Bot」分区仅超管可见（`viewerIsSuperAdmin` 门控 + 服务端 403 兜底）：输入用户名 + 房间号启动托管 simple-strategy-bot，表格展示运行中 bot（用户名/房间/启动时间/连接状态）并可手动停止。
_一句话：后台管理页：用户封禁、管理员权限分配与策略 Bot 托管。_

**static/login.html** — 登录/注册表单 + 图形验证码 + 离屏蜜罐字段。
_一句话：登录/注册表单 + 验证码 + 蜜罐。_

**static/tutorial-text.html** — 文字版规则教程 + 「地图示例」生成器（走 `/api/map-examples`，用与对局相同的 grid_type 编码渲染）。
_一句话：文字规则教程 + 示例地图生成器。_

**static/tutorial.html / tutorial.js** — 互动教程 `/tutorial/interactive`：纯本地迷你引擎（复刻正式规则：推兵、队列、连通/孤军、灭主城）+ 15 步引导流程。
_一句话：互动教程本地迷你引擎 + 15 步引导。_

**static/develop-bot.html** — **bot 协议权威文档**：握手鉴权、`set_id`、顶号与 10 秒断线宽限、房间/对局事件、grid_type 编码表、操作集。**协议改动必须同步更新此页。**
_一句话：bot 协议权威文档，改协议需同步。_

**static/develop.html** — 网站贡献指南（与 AGENTS.md/README 呼应，改流程需同步）。
_一句话：网站贡献指南静态页。_

**static/about.html** — 项目说明 + 来源/许可证致谢。
_一句话：关于与来源致谢静态页。_

**static/crown.js** — 全局 `crown_html`：主城皇冠内联 SVG（颜色跟随玩家配色）。
_一句话：皇冠 SVG 字符串常量（crown_html）。_

**static/notify.js** — 浏览器通知共享模块（首页与对局页共用，无构建全局函数）。
`notifyEvent(tag, title, body)`：仅在标签页后台（不可见或无焦点）且权限已授予时弹 Notification；去重两道保险——localStorage 时间戳互斥（5 秒窗口内同 tag 只有一个标签页弹）+ Notification `tag` 参数浏览器自动替换。`maybePromptNotificationPermission()`：`permission === 'default'` 时弹解释窗（复用 `.alert` 样式，说明进房/开局/上线/建房四类触发时机），由「开启通知」按钮手势调 `requestPermission()`；`denied` 永不打扰，解释窗每个浏览器最多弹一次（localStorage 持久化）。
_一句话：Notification 权限引导 + 后台去重弹通知。_

### 样式表（static/styles/，main.css 只做 @import 聚合）

- **base.css** — 全局 CSS 变量、字体（CDN 镜像 + 本地子集兜底）、通用组件基座；全局字体排除 KaTeX。_全局设计令牌与组件基座。_
- **map.css** — 地图格子全部视觉：尺寸档 `.s1–.s6`、颜色 `.c0–.c17`（`code%50==playerId`）、地形背景图、选中/可攻击态、孤军闪烁、建造角标、移动箭头。_地图格子视觉规则全集。_
- **game-ui.css** — 对局 HUD：排行榜（`tr.dead`/`tr.afk`）、回合计数、`#disconnect-banner` 断线横幅、回放控制条。_对局 HUD 与回放控制条样式。_
- **chat-and-alert.css** — 左下聊天框（含收起态、媒体查询）与 `.alert` 居中弹窗、通知权限引导弹窗（`.notify-permission-*`）。_聊天框与弹窗样式。_
- **home.css** — 首页（`body.home` 作用域隔离）三栏卡片布局 + 动态/公告/排行榜/回放上传弹窗全套。_首页三栏布局与 feed 全套样式。_
- **profile.css** — 个人主页，与 home.css 平行的卡片语言 + rating 变更/历史图。**改 feed/评论样式需与 home.css 双改。\***个人主页样式（与首页平行）。\*
- **admin.css** — 后台管理页：用户表格、搜索/分页工具栏、角色徽标、封禁行高亮、封禁对话框、策略 Bot 分区表单。_后台管理页样式。_
- **lobby.css** — 房间页：邀请链接卡、队伍分组色块、房主滑条设置。_大厅链接/队伍/滑条设置样式。_
- **rating.css** — `.rt-*` 八档 rating 用户名颜色（后端 `rating-color.ts` 注入类名）。_Codeforces 八档 rating 颜色类。_
- **tables-and-inputs.css** — 通用表格、`.mobile` 移动端紧凑模式、跨浏览器 range 滑条。_通用表格/移动端/滑条样式。_
- **tutorial.css** — 教程步骤横幅、地图平移缩放、目标高亮。_教程页样式。_

### 资源

- `static/vendor/katex/` — 本地化 KaTeX 发行版（css + 字体），公告/动态公式渲染；升级整体替换。
- 字体：Quicksand（3 档 otf）与 HYMaQiDuo（35/45/55W，ttf + subset woff2，子集是实际加载项）。
- `city/crown/mountain/obstacle/swamp.png` 地块贴图（map.css 引用）；`gong.mp3` 音效。

---

## 配置 / CI / 脚本 / bot 模板

- **package.json** — 脚本入口（dev=tsx 直跑 src、build=tsc、lint、format、test:bot、test:server-bot、test:lobby-guards、observe:bot）与依赖清单；`packageManager` 锁定 pnpm（Corepack）。
- **tsconfig.json** — src→dist，CommonJS+ES2022+sourceMap；**刻意关闭严格模式**，改严格度会影响整个 src/ 编译面。
- **eslint.config.cjs** — flat config，只查 `src/**/*.ts`，推荐规则集 + 关闭 `no-explicit-any`；不查 static/。
- **.prettierrc / .prettierignore** — 单引号/分号/尾逗号/110 列；排除 dist、node_modules、static/vendor。
- **.gitignore** — 忽略依赖/产物/运行时数据（data/users.bin、feeds.bin、announcement.json、server-bots.json、replays/、observe-*/）/`.env.*`。
- **.github/dependabot.yml** — npm 依赖每周更新。
- **.github/workflows/bump-version-and-merge.yml** — 唯一 CI：owner 在 PR 评论 `OK. <major|minor|patch> [merge|squash|rebase]` 触发升版本、冲突检测、自动合并（`dev/` 分支合并后删除）。
- **scripts/migrate-rating-display.mjs** — 一次性迁移：users.bin 历史 rating 换算显示分，原地覆盖写回（运行前先备份）。
- **scripts/recalc-rating-today.mjs** — Rating 重算：按回放索引全量重放，今天 00:00 前用旧公式（队伍分取平均）复现历史、今天起用人数加权公式（队伍分 = 400·log10(n^(k-1)·Σ10^(r/400))）重算；`--from-k`/`--to-k` 指定校验与目标公式（默认 1 → 4），`--check` 先全量复现并与 users.bin 逐用户比对（不一致即拒绝），`--apply` 写回 users.bin（须先停服并备份）。
- **scripts/test-bot.mjs** — `pnpm run test:bot`：临时数据目录起服务 + 两个 bot 自动对局，双方收到 `init_map` 且累计 ≥10 回合即通过。
- **scripts/test-server-bot.mjs** — `pnpm run test:server-bot`：托管策略 bot 冒烟测试——dist 造用户（首个 = 超管）、调 `/api/admin/bots/start` 进程内启动 simple-strategy-bot、random-patch-bot 作对手，校验 403 权限闸、房长保留（host 落在第三方 bot）、托管 bot 房间禁止组队（bot 进房强制关闭已开组队 + 房主开启请求被拒绝）、`init_map` + ≥5 条实际 attack、杀服重启后按状态文件自动恢复原配置、停止 API 清空列表与状态文件。
- **scripts/test-lobby-guards.mjs** — `pnpm run test:lobby-guards`：开局/换绑守卫回归——组队模式全员同队拒绝开局（换队后可开）、对局中同名人类连接不得接管 bot 席位（以观战进房且 bot 持续收 update）、bot 与人类各自断线重连仍可恢复席位。
- **scripts/observe-bot-match.mjs** — `pnpm run observe:bot`：对局观测/病理分析——临时数据目录起 dist 服务 + 进程内观战 recorder 逐 turn 录完整盘面（`frames.jsonl`），按 `OBS_BOTS` 启动 bot 组合（`strategy:`/`random:`/`legacy:` 前缀，`legacy` 从 git main 导出旧版做 A/B 基准），赛后生成 `report.txt`（往返抖动/送兵/前线停滞/切断无救援/主城沦陷时闲散兵力）；环境变量 `OBS_SPEED`/`OBS_MAP_TOKEN`/`OBS_MAP_MODE`/`OBS_OUT`/`OBS_MAX_MS`，输出默认 `data/observe-*/`（gitignored）。
- **scripts/replay-bot-decisions.mjs** — bot 决策离线复盘：假 socket 驱动真实 `strategy.js` 逐 turn 重放观测目录的 `frames.jsonl`（队列执行按服务端 `chkMove`/`chkBuild` 语义模拟），完整复现跨 tick 决策状态；支持 `--validate`（与 bot 日志逐 op 比对）、`--from/--to`、`--board`、`--cell` 盘面解释；配 `BOT_TRACE=1/2` 输出进攻评估/焦点/候选榜。
- **bot-template/random-patch-bot/** — socket 协议最小参考实现（独立 pnpm 包，仅依赖 socket.io-client）：进房、自动准备、周期发送 `room_heartbeat`、维护 diff 地图、每回合随机走子；协议细节另见 `static/develop-bot.html`。
- **bot-template/simple-strategy-bot/** — 综合策略 bot（独立 pnpm 包）：`strategy.js` 为入口与管线编排（socket/房间循环/队列镜像/逐 tick 决策，recentMoves 窗口丢弃互逆操作防往返抖动，常规输送每 tick 限 1 条 op 防挤占扩张/建设），`bot/` 为纯函数决策模块——`board.js`（棋盘视图/距离场/Dijkstra/推兵预演/孤军聚块/咽喉割点识别与双层危险场定量驻军）、`defense.js`（威胁推演与集结布防，活跃威胁逼近触发回防闩锁）、`offense.js`（目标评估/风险路径/集结打击/切断入侵/前线突破集结/打击体检与冷却）、`rescue.js`（被切断孤军的走廊救援评估与止损）、`economy.js`（皇冠/指挥所建设选址）、`logistics.js`（汇集输送/中立扩张）、`opening.js`（开局发育规划器：逐 tick 模拟选最优启动时机，前 25 tick 抢地、爆发期扩张优先）；CLI `index.js` 与服务端托管（`src/server/server-bot-manager.ts`）共用这一份实现；用法见包内 `USAGE.md`。
- **data/** — 全部运行时状态（gitignored）：`users.bin`/`feeds.bin`（v8+brotli）、`announcement.json`、`server-bots.json`（托管策略 bot 重启自动恢复状态）、`replays/*.rpl`（+ 观看缓存 `*.rpb.gz`、`index.bin`）。

---

## 常见任务速查

| 要做什么                         | 动哪里                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 调平衡数值（AFK/掉线/孤军/增兵） | `src/game-engine/constants.ts`、`tick-growth.ts`                                                                                                                    |
| 改对局规则（战斗/连通/投降）     | `src/game-engine.ts`（+ 教程复刻 `static/tutorial.js`）                                                                                                             |
| 改 socket 协议/格子编码          | `src/types.ts`、`src/game-engine/map-encoding.ts`、`src/server.ts`、`src/server/lobby-service.ts`；同步 `static/develop-bot.html`、`bot-template/`、`static/main/*` |
| 改回放格式                       | `src/replay-patch-binary.ts`（编码，升魔数）+ `static/main/replay-binary.js`（解码）+ ops-v1 互逆对 `src/game-engine/replay-turns.ts` ↔ `replay-scheduling.ts`      |
| 加/改 REST API                   | `src/server.ts`（路由集中在此；注意限流与认证钩子）                                                                                                                 |
| 改房间/断线/重连逻辑             | `src/server/lobby-service.ts` + `src/game-engine.ts`（宽限三件套）                                                                                                  |
| 改公告/动态渲染                  | `src/text-render.ts`（同一管线；加 KaTeX 标签需同步白名单）                                                                                                         |
| 改 Rating/段位                   | `src/auth-store.ts`（分数）、`src/rating-color.ts` + `static/styles/rating.css`（颜色）                                                                             |
| 改地图生成                       | `src/map/`（公共件在 map-core.ts；尺寸比例在 map-size.ts）                                                                                                          |
| 改对局页渲染                     | `static/main/render-update.js`（帧合并）、`static/styles/map.css`（视觉）                                                                                           |
| 改首页 feed/公告样式             | `static/styles/home.css` + `static/styles/profile.css`（双改）                                                                                                      |
| 部署/自动更新                    | `src/server/webhook-updater.ts` + `.github/workflows/bump-version-and-merge.yml`                                                                                    |
