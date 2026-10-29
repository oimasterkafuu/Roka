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
   ├── src/server/presence-service.ts 统一在线状态（活动touch/在线窗口/落盘节流）
   ├── src/server/server-bot-manager.ts  托管策略 Bot 管理器（进程内自连、内存令牌鉴权、重启自动恢复）
   └── src/server/webhook-updater.ts  GitHub push 自动部署（更新排队状态机：禁开局 + 120s 宽限清算）
   ▼
src/game-engine.ts ── 对局核心（Tick 循环、战斗、连通、投降、回放记录）
   ├── src/game-engine/*              常量/主城选择/排行榜/编码/回放工具/增兵
   └── src/map/*                      五种 map_mode 地图生成器、华夏地区配置与年度开放窗口（纯函数）
   ▼
持久化（data/，均被 gitignore）：announcement-store / auth-store / feed-store / replay-store；server-bots.json（托管 bot 重启恢复状态：{username, room, template, allowTeam, allowFog, allowMultiLine} 列表）
```

关键事实：

- 后端 TypeScript（`src/`）经 `pnpm run build` 编译到 `dist/` 运行；`dist/` 不手工编辑。
- 前端主体无构建流程，`static/` 基本原样下发；介绍片由 `scripts/intro/build-intro.mjs` 单独打包至 `static/intro/player.js`；例外是含 `{{V}}` 占位符的文件（全部 HTML、`main.css`、`main.js`、`sw.js`、`sw-register.js`）由服务端替换为 package.json 版本号后发出（静态资源版本号注入，防浏览器缓存旧版 JS/CSS），协议/格式改动需前后端同步（见文末速查表）。
- 静态资源发布：`src/server/static-assets.ts` 启动时批量读取 Git 历史，按文件最后修改 SHA 改写 HTML/preload/Worker，CDN 去除整站 v；注入 `static/asset-runtime.js` 处理逐文件 URL、有序脚本、完整性校验与 CDN 回退，并递归下载 CSS/字体/图片为 blob，避免依赖继承父文件 SHA。未知文件单独回源，ROKA_STATIC_COMMIT 可全文件覆盖。动态接口不经 CDN。详见 `docs/static-cdn.md`。
- 玩家身份 = socket.id（sid）；对局协议与格子编码的权威文档是 `static/develop-bot.html`。

## 实时介绍片

- `static/intro.js` / `static/styles/intro.css`：轻量入口、一次性同意弹窗、关于页重播、固定 16:9 舞台、播放控件与取消清理；加载/播放复用同一 range，分别显示禁用 seek 的素材百分比与可 seek 的播放时间。首页认证/通知提示就绪后发送 `roka:home-ready`，防止弹窗堆叠。
- `static/intro/player-source.js` → `player.js`：按需载入、共享 loader 全素材并行预载与解码、plan.duration 驱动的 Web Audio 时间轴、30 fps 调度、WebGL/Canvas 分层合成、按 CSS 显示尺寸 × DPR 调整实时物理分辨率、暂停/跳转/退出生命周期；`scripts/intro/build-intro.mjs` 用 esbuild 构建并生成预压缩资源。
- `static/intro/asset-loading.js`：提供共享 CDN 请求与哈希素材 Cache Storage 持久缓存，以清单顶层任务为固定总数并行预载并汇报单调进度；glTF 父任务等待嵌套依赖，后续 JSON/Blob/模型解码复用同实例结果。可变清单不持久缓存，重写 glTF 内部依赖为去重的 blob URL，退出时取消请求并释放。
- `static/intro/scene.js` / `motion.js` / `gesture.js` / `landform.js` / `architecture.js`：原片三维镜头、原生分辨率 WebGL 与后处理、接地 IK、领队手势权重（leader→ascend 平滑过渡）、连续山脊与沼泽、材质合批和分阶段施工；charge 动画保留给左右对照左侧调用。
- `static/intro/director.js` / `replay-board.js`：1920×1080 逻辑构图、原生分辨率合成、字幕/背景、原生棋盘与隔离闪烁；84–88 秒直接进入 charge_compare 左右对照，真实回放与 16 方模拟数据仅含显示所需字段。
- `static/intro/assets/manifest.json`：哈希模型/共享贴图、120 秒音轨、回放、背景及字体地址；`licenses/` 保留第三方许可。`src/server/auth-service.ts` 只公开读取这些静态资源，`src/server.ts` 协商 gzip/Brotli 并给哈希素材不可变缓存。
- `scripts/intro/build-intro-data.mjs` / `trim-intro-plan.mjs` / `build-intro-fonts.py` / `import-intro-assets.mjs`：从备份制作工程重新准备素材的开发工具，正常站点构建不访问原工程；剪辑变换移除独立 charge 并重排后续 shot/frame/beat。`prepare-intro-media.py` 直接输出原始 120 秒配乐。`scripts/intro/fixtures/intro-replay-hashes.json` 为原始回放状态校验摘要。
- 验证：`scripts/intro/test-intro-{blink-white,data,gesture,media,models,lifecycle,native-resolution}.mjs`、`scripts/test-intro-{assets,entry,cdn}.mjs`、`scripts/test-{static-cdn,cdn-runtime}.mjs`；其中 data 测试覆盖剪点前后映射与连续性，media 测试实测 PCM 120 秒并对期望剪辑做相关/RMS 校验，CDN 测试验证真实并行、稳定进度及有/无持久缓存的复用，入口浏览器测试覆盖同一 range 的加载与 seek 切换；详见 `docs/realtime-intro.md`。

## 目录结构树

```
├── src/                    # 后端 TypeScript 源码
│   ├── server.ts           # 主入口：Fastify 路由 + socket.io 事件
│   ├── game-engine.ts      # 对局引擎核心（~1500 行）
│   ├── game-engine/        # 引擎子模块（常量/选点/榜单/编码/回放/增兵）
│   ├── map/                # 地图生成器（含 huaxia 与九个 map_region，含辽与中国视口）
│   ├── server/             # 服务层：auth / captcha / lobby / webhook / auto-ban-policy（自动封禁策略）
│   ├── types.ts            # 全项目共享类型与协议定义
│   ├── *-store.ts          # 四个持久化存储（公告/用户/动态/回放）
│   ├── binary-store.ts     # 存储底座：v8+brotli 编码、原子写+.bak 备份、合并写盘
│   ├── replay-patch-binary.ts  # RPB4 观看二进制编码器
│   ├── text-render.ts      # Markdown+LaTeX → 消毒 HTML（公告/动态共用）
│   ├── rating-color.ts     # Codeforces 风格段位配色
│   └── runtime-env.ts      # .env 引导与密钥自动生成
├── static/                 # 前端（主体原生 JS；介绍片独立打包）
│   ├── index.html          # 首页/大厅（脚本基本内联，另加载 /notify.js）
│   ├── game.html           # 对局/回放共用骨架
│   ├── main.js + main/     # 对局/回放主控与模块（加载顺序敏感）
│   ├── notify.js           # 浏览器通知共享模块（首页与对局页共用）
│   ├── username.js         # 统一用户名组件：rating 颜色 + 点击跳主页 + 颜色全局缓存
│   ├── mention-autocomplete.js  # @提及输入补全（data-mention 输入框，候选下拉）
│   ├── sw-register.js      # SW 注册（首页/对局页加载，注册 URL 带 ?v={{V}}）+ sw.js 部署更新兜底 SW + updating.html 更新提示页
│   ├── profile.html|.js    # 个人主页
│   ├── admin.html|.js      # 后台管理页（用户列表/封禁/权限分配）
│   ├── tutorial*           # 文字教程 + 互动教程（本地迷你引擎）
│   ├── develop*.html       # 开发指南 + bot 协议权威文档
│   ├── login.html / about.html
│   ├── styles/             # 样式表（按页面切分，main.css 聚合入口）
│   ├── vendor/katex/       # 本地化 KaTeX（公式渲染）
│   └── *.png / *.mp3 / 字体 # 地块贴图、音效、Quicksand/HYMaQiDuo 字体
├── scripts/                # 维护脚本（数据迁移、bot 冒烟测试、对局观测分析）
├── bot-template/           # random-patch-bot（协议最小参考，CLI）、simple-strategy-bot、anti-human-bot 与 apex-bot（独立策略 bot，可被服务端托管）
├── data/                   # 运行时数据（gitignored）：users.bin / feeds.bin /
│                           #   announcement.json / server-bots.json / replays/*.rpl(+缓存)
├── dist/                   # tsc 构建产物（勿手改）
└── .github/                # dependabot + 唯一的 CI（评论触发升版合并 PR）
```

---

## 后端源码地图（src/）

### 入口与服务层

**src/server.ts** — HTTP+WebSocket 总装入口，全部路由与 socket 事件在此。
`boot()` 依次：`ensureRuntimeEnv()` 补全 `.env` → 四个 Store `ensureReady()` → 全局限流（`resolveRateLimitKey` 处理反代真实 IP）→ 认证钩子（AuthService.isPublicPath 按 HTTP method 白名单放行公开页面与只读 GET API，/games/:game_id 与写接口仍保护；首页 guest socket 仅接收全局失效通知）→ REST 路由（认证/动态/公告/排行榜/在线状态/用户搜索/后台管理/回放/房间/地图示例/版本）→ `SocketIOServer`。版本接口 `GET /api/version`（公开）返回 `{version, commit}`：version 读 package.json，commit 为启动时 `git rev-parse HEAD` 缓存（非 git 环境为空字符串），供首页页脚版本号链接。静态资源版本号注入：`renderAssetTemplate`/`serveAssetTemplate` 把含 `{{V}}` 占位符的静态文本文件（全部 HTML 页面路由与 `/main.css`、`/main.js`、`/sw.js`、`/sw-register.js` 显式路由）在启动时替换为 package.json version 并缓存，带 ETag + `Cache-Control: public, max-age=0`（与原 @fastify/static sendFile 语义一致，If-None-Match 命中回 304）；其余静态文件仍由 @fastify/static 直发并忽略未知 query（`?v=` 兜底安全）。后台管理：`GET /admin` 页面与 `GET /api/admin/users`、`POST /api/admin/ban|unban|set-admin` 接口经 `requireAdmin` 统一校验管理员身份（非管理员 403/重定向），`set-admin` 再校验超管；策略 Bot 接口 `GET /api/admin/bots`、`GET /api/admin/bot-templates`、`POST /api/admin/bots/start|stop` 经 `requireSuperAdmin`（requireAdmin + 超管），`bot-templates` 返回 `serverBotManager.listTemplates()` 自动枚举的可托管模板，`start` 接收 `{username, room, template, allowTeam, allowFog, allowMultiLine}` 并校验用户存在且未封禁、房间号长度 1~15、模板可托管，由 `serverBotManager` 在进程内按模板启动（同用户/同房间唯一，冲突 409）；登录路由在密码校验后检查封禁状态（403 拒绝），封禁成功即 `clearSession` + `disconnectUserSockets` 踢下线。socket 中间件支持 cookie JWT、`ROKA_BOT_TOKENS` bot 令牌（命中时置 `socket.data.isBot` 并加入心跳豁免集）与托管 bot 内存临时令牌（`serverBotManager.resolveToken` 命中时置 `isBot` + `isServerBot` + `serverBotAllowTeam` + `serverBotAllowFog` + `serverBotAllowMultiLine`，`join_game_room` 传给 `lobbyService.joinLobby`）；所有 bot 连接（isBot）不参与单连接互斥（不顶号、不被顶号、不计入 userSocketIds）；`?home=1` 连接只做全局通知、不参与单连接互斥。统一在线状态由 `presenceService`（presence-service.ts）承担：已认证 HTTP 请求的 onRequest 钩子（`/api/online` 自身除外）与 socket 连接 + `socket.use` 入站事件拦截（对局操作/聊天等，机械保活的 `room_heartbeat` 除外——它只在处理器里经 `hasLobbyMember` 判定确为房内成员时才计入，房外 socket 的心跳不刷新在线）统一经 `recordPresence` 刷新用户活动时间，bot 连接不刷新；离线→在线转换与 30 秒周期 sweep 判出的在线→离线转换经 2 秒节流广播 `home_online`；`GET /api/online` 返回在线人数（在线窗口内去重用户）与「在线」列表（前 8，全员含当前在线者与查询者自己，按最后活动倒序）；后台管理 `GET /api/admin/users` 的 `lastSeenAt` 以 presence 内存表叠加返回。对局指令（`attack`/`build`/`clear_queue`/`pop_queue`/`surrender`）经 `lobbyService.gameUid` 路由到对局实例；`spectate_view`（观战视角切换，仅迷雾对局）经 `lobbyOfSid` 定位对局后调 `game.setSpectatorView`；`join_game_room` **先 `tryRejoin` 尝试断线重连换绑**（身份匹配：bot 与人类同名连接互不接管席位），否则正常进房/观战；`room_heartbeat` 记录房间心跳（准备阶段 600 秒无心跳、或在房停留累计超 12 小时被踢并收到 `room_kick`），且仅房内成员的心跳计入 presence；真人客户端验证由连接作用域内共用的 `markHumanVerified` 完成——`client_verify`（进房前的提前验证，消除开局时序竞态）与 `room_heartbeat` 携带的 sig 经同一 `authService.verifyClientSig(sessionSid, md5(socket.id), sig)` 校验，命中即把 socket.id 加入 `lobbyService.humanVerified`（按真人、普通 AI、托管 Bot 三档排序，晚到验证也重排；房间列表的 `ai` 标记依据 `!humanVerified.has(sid)`，对局排行榜按开局玩家编号快照此判定；未验证 JWT 第三方 bot 自动标记，无需管理员配置名单）；`disconnect` 调 `checkLeave(..., username, isBot)` 走宽限期挂起。回放路由：`/api/getreplay/:id` 发 gzip 缓存 + `X-Replay-Size` 进度头（加载失败删库）；`/api/downloadreplay/:id` 发原始 `.rpl`；`/api/replay-upload` 转码上传文件。`GET /api/user-colors?users=a,b,c` 按用户名批量返回 rating 颜色（`{colors: {name: {colorClass, title}}}`，复用 `getDisplayRating` + `ratingTier`，未上榜/未定级降级 rt-unrated，限量 100 个/次），供前端 username.js 组件为回放列表/对局排行榜/聊天等接口原本不带颜色的位置批量补色；`GET /api/users/search?q=前缀&limit=n` 按前缀返回用户名候选（`userStore.searchUsernames`，空 q 返回前若干，附带 colorClass/title），供 @提及补全。动态装饰（`decorateFeedPost`/`decorateFeedComment`）给帖子与评论作者都附 `authorInfo`（colorClass/title），并经 `renderRichTextWithMentions` + `userStore.resolveUsername` 把正文 @提及渲染为用户名链接、返回 `mentions` 列表（不存在的提及降级为普通文本）。

**src/server/lobby-service.ts** — 房间/对局状态机 + 断线宽限期 + 房间心跳踢出 + rating 结算 + 托管 bot 房长保留。
进出广播文案按 `lobbySeatName(lobbyId, sid)` 区分席位（issue #122）：team 0 或对局进行中但非该局存活参赛者（中途进房观战/已出局留观）为「观战席」，其余为「自定义房间」，进房（server.ts）、主动离开/心跳踢出/宽限到期/终局清理各路径的 fold 谓语同步区分；宽限到期路径的席位判定须在 `expireDisconnect` 之前取值。
核心 Map：`gameUid`(sid→gameId)、`gameInstances`、`gamePlayers`、`gameLobbyId`、`lobbyOfSid`、`lobbyPlayers`、`lobbyConfig`；宽限期登记表 `pendingRejoins`（键 `${gameId}:${username}`，含旧 sid、旧连接是否 bot 与 10s 定时器）；心跳登记表 `lobbyHeartbeats`（sid→最后心跳时间）+ 进房时间表 `lobbyJoinedAt`（sid→本次进房时间，重进重置）+ bot 豁免集 `heartbeatExempt`（由 server.ts 维护）；官方 Bot 房停留计时 `botDwell`（sid→{uid,gid,sinceMs}，只记未通过 humanVerified 的非官方 AI 进房时房间已是官方 Bot 房的计时段）+ 每日累计桶 `botDwellDaily`（uid→{date,ms}，服务器本地日历日 YYYY-MM-DD 惰性 rollover；**内存态，服务器重启清零**）。`joinLobby` 第四参数 `serverBot`/`serverBotAllowTeam`/`serverBotAllowFog`/`serverBotAllowMultiLine`/`bot`：`serverBot` 托管策略 bot 永远排在普通成员之后（`LobbyPlayer.serverBot` 标记，其组队许可存 `LobbyPlayer.serverBotAllowTeam` 供改配置校验），房主（`players[0]`）三档优先：人类（进房时 `humanVerified` 已命中）插在最后一个既有普通人类之后——人类进房即接任房主；其他非托管成员（令牌/第三方 bot、未通过真人校验的普通连接）插在首个托管 bot 之前，无人类在座时居首位当房主；托管 bot 永远排尾不当房主——首次 client_verify 或 room_heartbeat 补验后按三档稳定重排并广播一次，重复验证不重排或广播；托管 bot 的组队语义由启动参数决定——`serverBotAllowTeam=false` 的 bot 进房时强制关闭组队并规整队伍，`serverBotAllowTeam=true` 时组队开关保持默认关闭、由房主决定（server.ts 的 `change_game_conf` 只对存在 `serverBotAllowTeam!==true` 托管 bot 的房间拦截房主的开启请求并提示），`room_update.players[]` 对托管 bot 成员附带 `server_bot: true` 与 `server_bot_allow_team` 供前端判断是否锁定组队开关。组队模式不再按 bot/人类分池：`pickLeastPopulatedTeam` 为进房成员挑选人数最少的默认队伍（全空时 1 队），`change_team` 请求按原样生效不做修正，房主开启组队也不重排队伍——队伍归属完全由成员自行决定（anti-human-bot 固定首选 2 队，检测到人类同队会自主避让换队）。第三方 bot 或未允许迷雾的托管 bot（`LobbyPlayer.bot` 标记）进房时强制关闭迷雾（issue #51），`change_game_conf` 同样拦截房主开启迷雾的请求，`room_update.players[]` 附带 `bot: true` 供前端禁用迷雾开关并显示提示。全局队列（`LobbyConfig.multi_line`，默认关）沿用同一套规则：第三方 bot 或未允许全局队列的托管 bot（`serverBotAllowMultiLine!==true`）进房时强制关闭并提示，`change_game_conf` 拦截房主开启请求，`room_update` 携带 `multi_line` 供前端房间页显示全局队列标识（`listLobbyRooms` 仍附带 `multi_line` 字段，首页房间列表不再渲染「全局队列」tag）。非官方 AI 每日官方 Bot 房停留上限（`BOT_DWELL_DAILY_LIMIT_MS`=4 小时）：AI 身份与房间 [AI] 标记一致，未通过 `humanVerified` 且非 serverBot 即受限，不看 JWT/token。`joinLobby` 返回值 `{blocked?: string}`——此类连接进入官方 Bot 房（进房时刻房内已有任一 serverBot 成员的快照判定，进入后官方 Bot 离开不追溯）且该 uid 当日历史桶与所有进行中计时段合计 ≥4 小时时拒绝进房（server.ts 的 `join_game_room` 据此跳过 socket.join/room_update/加入广播，改为房间内提示 + `emitHomeRooms`）；正常进房则开始计时段；`leaveLobby`（checkLeave/kickFromLobby/断线宽限到期/对局结束清理等退出路径的汇聚点）把计时段结算进当日桶；`tryRejoin` 换绑把计时段转移到新 sid 且保留 sinceMs（断线重连不丢计时），旧 sid 无记录则不新建；补验真人时 `reorderLobbyForVerification` 结算并停止该 sid 的 AI 计时。`sweepBotDwellLimits` 每分钟在准备阶段自动移出到限 AI 并禁止当日重进，对局进行中不打断，`endGame` 删除 gameInstances 后针对该房间立即再检查；真人与托管 bot 不受限。`checkLeave`：对局中断线 → `game.markDisconnected`，截断旧路由但保留席位，挂 `expireGracePeriod` 定时器，超时以「挂机」投降并完整清理；`tryRejoin`：按用户名找旧 sid（`findPlayerSidByName`）并校验身份匹配（bot 连接只能接管 bot 的旧席位、人类只能接管人类的，以旧 socket 的 `data.isBot` 或宽限期登记为准，防止托管 bot 与同名真人互相抢席位），清定时器、全部 Map 换绑、`game.rebindPlayer` 补发全量状态。`checkReady` 开局条件：非观战成员按已验证真人与 AI（未通过真人校验的连接）分别统计，每个非空组准备人数须达到 ceil(该组人数 / 2)，空组自动满足；两组均达标且总参赛人数至少 2 人才自动开局。组队模式下若所有参赛者处于同一队伍则拒绝开局并提示调整队伍（否则首 Tick 存活队伍数即为 1，开局即终局）。心跳掉线检测（仅房间准备阶段）：`recordLobbyHeartbeat` 刷新时间戳（进房即为基线），`hasLobbyMember` 判定 sid 是否在房（server.ts 的心跳 presence 门闸与心跳记录共用此口径），`startLobbyHeartbeatSweep` 全局单一定时器每分钟扫描，超过 600 秒无心跳、或在房停留累计超过 12 小时（`LOBBY_MAX_DWELL_MS`，防止挂着的标签页靠心跳长期占房并维持在线）且房间未开局的成员由 `kickFromLobby` 复用离开清理逻辑移出房间并下发 `room_kick`（前端跳首页）；对局中的房间与豁免 bot 跳过（停留超限也等本局结束回到准备阶段后再移出）。只剩 bot 自动重置：`resetLobbyConfigIfOnlyBots` 在准备阶段的成员移出路径（`checkLeave`/`kickFromLobby`/`expireGracePeriod`）与 `endGame` 回到准备阶段时判定——剩余成员全部带 `bot` 标记（观战席人类仍算人类占用）且对局未在运行时，用 `defaultLobbyConfig()`（与建房同一默认值来源，含重新随机种子）整体重置房间设置，bot 留房待命；无 bot 的普通房间人走光后成员列表为空，不触发。`startGame` 组装 `GameConfig`（动态地图尺寸——按人数取基础比例，房间开启大地图 `map_size:'large'` 时再 ×2 即面积约 4 倍；自动分队）并注入 io 回调；开局时仅当全部参赛席位（team>0）均未通过真人校验（`!humanVerified.has(sid)`，观战席不计）才强制 4x 速度并提示；已验证真人参战时保留配置速度。排行榜按开局玩家编号保存 `aiFlags` 快照，工厂首次发帧、补验、断线换绑与成员移除均不影响身份，未知编号不标记 AI。`endGame` 里 `applyGameResult` 结算 ELO（K=128，队伍名次取队内最好名次在队伍间的位次——成员榜名次不能直接代入 score 公式，队伍分按人数立方加权 400·log10(n³·Σ10^(r/400))），清理宽限定时器并重置房间（种子：房主自定义种子 `map_token_custom=true` 沿用不重随机，随机种子每局重随机，issue #86）。`onGameEnded` 回调通知 webhook-updater 解除部署推迟。部署更新排队状态 `updateQueued`：`setUpdateQueued`（webhook-updater hooks 驱动）全局广播 `deploy_queued` 事件并向所有房间重发 `room_update`（`generateRoomConfig` 携带 `update_queued`），进入排队时向有对局的房间发宽限期提示消息；排队期间 `checkReady`/`startGame` 拒绝开局（server.ts 的 `change_ready` 同步拦截并提示「系统即将排队更新，请稍等」）；`settleActiveGamesForUpdate` 在宽限到期时对所有进行中的对局调引擎 `forceFinish` 按当前排行榜名次清算（回放存档/rating/房间清理仍由 endGame 回调完成）。纪律事件与自动封禁：豁免仍依据原有 `LobbyPlayer.bot` 鉴权标志，未验证连接不自动获得处罚豁免；引擎投降/挂机时回调 `handleDisciplineEvent` 记入 `disciplineHistory`（含本局玩家数 `playerCount`），再按 `server/auto-ban-policy.ts` 判定——24h 内快速投降 3 次或 AFK 6 次触发自动封禁（1v1 对局的 AFK 不计数），封禁时长按 `automaticBanCount` 指数增长（1h 起步、7 天上限），连续 14 天无违规经 `shouldResetAutomaticBanCount` 判定后重置计数为 0。

**src/server/server-bot-manager.ts** — 服务端托管策略 Bot 管理器（issue #18，仅超管经 `/api/admin/bots*` 操作）。
不另起进程：每次启动生成随机内存令牌（`tokens` Map：token→{username, allowTeam, allowFog, allowMultiLine}，server.ts socket 中间件查询 `resolveToken`，命中置 `isBot` + `isServerBot` + `serverBotAllowTeam` + `serverBotAllowFog` + `serverBotAllowMultiLine`），在服务器进程内用 socket.io-client 连本机回环地址（端口经 `getPort` 回调读取 listen 端口）完成正常握手。模板发现 `listTemplates()`：枚举 `bot-template/` 一级子目录，存在 `strategy.js` 或 `server-bot.js` 且导出 `attachStrategy` 的目录即为可托管模板（展示名/描述取 package.json），模板 ID 严格为目录名防路径穿越；`random-patch-bot` 是 CLI 参考模板、不在其列。策略按模板 ID 经 `createRequire` 动态加载并缓存（`strategyModules` Map）。`start(username, room, template, allowTeam, allowFog, allowMultiLine)` 拒绝同用户重复启动与同房间占用（清晰中文错误）；`stop(id)` 拆监听、断连、删令牌；`list()` 出运行中 bot（含 template/allowTeam/allowFog/allowMultiLine/连接状态）。日志走 `console.log` `[server-bot]` 前缀（冒烟脚本据此判定对局行为）。重启自动恢复（issue #28）：start/stop 把运行中 bot 的 `{username, room, template, allowTeam, allowFog, allowMultiLine}` 列表原子写入 `data/server-bots.json`；`restore(validateUsername)` 在 listen 后由 server.ts 调用，逐条重做与手动启动相同的校验（用户存在且未封禁、房间号长度 1~15、模板可加载），全部通过才以原配置自动启动，失效记录记警告跳过并随写盘清除；缺少 template/allowTeam/allowFog/allowMultiLine 的旧记录按 `simple-strategy-bot` + 不允许组队/迷雾/全局队列恢复。

**src/server/auth-service.ts** — JWT 签发校验 + 用户 socket 单连接互斥。
JWT 载荷 `{sub, sid}`，`sid` 经 `userStore.isSessionValid` 校验（重登录轮换 session 使旧令牌失效）；cookie 名 `auth_token`，7 天。`userSocketIds` 配合 `disconnectOtherUserSockets`（新连接踢旧连接=顶号）/ `disconnectUserSockets`（登录/登出全踢）；`isPublicPath(pathname, method)` 按 method 定义公开页面与只读 GET API 白名单（含 `/api/users/search` 提及候选），明确排除对局页、认证当前用户接口和写入接口。

**src/server/captcha-service.ts** — canvas 渲染的一次性图形验证码（注册/登录防机器人）。
4–6 位字符（去易混淆字符），`@napi-rs/canvas` 多画布管线（噪声→mask→正弦扭曲→渐变着色）输出 PNG data URI；`verifyAndConsume` 一次性消费，带 `minSolveMs=1100` 防过快提交；纯内存 5 分钟 TTL。

**src/server/presence-service.ts** — 统一在线状态模型：「用户最近一次有效请求/动作时间」为唯一事实来源。
`touch` 刷新内存活动时间（在线 = 最近 5 分钟内有活动；「最后在线」= 该时间戳；在线人数 = 窗口内去重用户数），返回是否离线→在线转换；落盘经 `persist` 回调按每用户 60 秒节流（首次活动立即落盘），`sweep` 把掉出在线窗口的用户移出在线集并兜底落盘（由 server.ts 每 30 秒调用）；`listByActivity` 出全员按最后活动倒序的列表（含在线者，首页「在线」列表）；`seed` 从落盘 `lastSeenAt` 重启恢复。时钟/窗口/节流均可注入，便于假时钟单测（scripts/test-presence.mjs）。
_一句话：统一 presence：touch/在线窗口/落盘节流/重启恢复。_

**src/server/webhook-updater.ts** — GitHub push webhook 自动部署与「更新排队」状态机。
`POST /postreceive` 只接受原始 JSON 与 `x-hub-signature-256` HMAC；`isAuthorized` 对原始请求字节校验签名；**有对局进行中则进入排队状态**：`enterQueuedState` 置 `hasQueuedUpdate`、经 hooks 通知 server 广播（禁开局 + 对局横幅，见 lobby-service `setUpdateQueued`），并启动宽限计时 `UPDATE_GRACE_MS`（默认 120 秒，`ROKA_DEPLOY_GRACE_MS` 可覆盖，主要用于测试）——期间对局继续，最后一局结束（`notifyGameEnded`）立即部署，到期则经 `onGraceExpired` 让 lobby-service 按当前排行榜名次清算残余对局（`settleActiveGamesForUpdate` → 引擎 `forceFinish`），清算完成的 endGame 接力触发部署；部署失败或 `ROKA_DEPLOY_DRY_RUN=1` 演练（跳过 git/pnpm 与重启）时经 `onUpdateAborted` 解除排队状态。流水线：`git fetch/reset --hard origin/main` → `pnpm install --frozen-lockfile` → `pnpm run build` → systemd 下 `exit(0)` 靠守护重启，否则 spawn 延迟重启。

### 对局引擎

**src/game-engine.ts** — 对局核心：全状态 + Tick 主循环；默认无迷雾全图广播，迷雾对局按接收者视野过滤（见 fog-vision.ts）。

`GameEngine.create()` 静态工厂生成地图（按 `map_mode` 调 `src/map/` 生成器）并选主城；`startGame → beginLoop → scheduleNextTick` 按 `500/speed` ms 走 `gameTick()`：增兵 → pstat 计数/超时击杀 → 按奇偶反转顺序执行每队队首操作（`chkMove/attack`，含智能分兵 `computePush`；X 建指挥所、C 升级主城均耗 50 兵）→ `applyConnectivity` 队伍级连通 BFS（断链减半、孤军 5 回合宽限后每回合 5% 衰减、重连 ×2）→ AFK 判定 → 胜负判定 → 记录回放 → `sendMap`（diff 帧，每 50 tick 或 1/51 概率全量；`buildSnapshotFor` 按接收者出快照：迷雾对局中存活参赛者经 fog-vision 过滤并附 `fog` 数组，观战/出局者默认全视野+全 0 fog，`fogLast` 按玩家做 diff 基线；观战者经 `spectatorViewTeams`（sid→队伍）选了玩家视角时改收该队伍迷雾帧——`setSpectatorView` 校验非存活参赛者后记录偏好并立即补发全量帧同步 diff 基线；外部观战者按 `spectatorSnapshotLast` 独立维护差分基线，复用 tick 级 visionCache，不退回每 tick 全量；队伍全员淘汰后已选/新选该视角均安全回退全图，存活但尚未选主城的队伍仍保持自身迷雾视野）。v3 全局队列：每玩家一个全局大队列（`pmove: QueuedOp[]`，操作按到达顺序入队，入队分配单调递增 seq），不再有战线编号与队列路由。Tick 调度按房间开关 `multi_line`（`multiLine`）分派两种模式：单线串行（默认，`multi_line=false`）——每 Tick 每玩家只从大队列头部依次弹出指令，丢弃失效指令（chkMove/attack 失败、chkBuildCity/chkUpgradeCrown 不满足），直到成功执行第一条有效指令为止，本 Tick 不再执行后续；全局队列并行（`multi_line=true`，issue #107）——把队列里的移动指令看作有向边 (x,y)→(dx,dy)，所有入度为 0 的头部指令各执行一步（chkMove+attack，失效即丢弃），头部出队后下一格指令下一 Tick 自动成为新头部；拓扑剥离后仍成环的移动指令每 Tick 按入队序强制尝试 seq 最小的一条以打破死锁（失效则正常丢弃，issue #121）；建造指令（b/c）不参与入度图，当该格不再是任何待发移动指令的出发格时尝试执行，条件不满足即丢弃；空队列不耗 Tick，单链节奏与单线一致。两种模式的汇报协议同为 `lst_moves: number[]`（本 Tick 所有出队项的 seq，含执行与丢弃，客户端按 seq 摘除本地镜像队列）；`init_map` 开局附 `next_seq/queue_ops`，多线对局另附 `multi_line: true`（单线缺省即旧协议行为）；回放 ops-v1 协议不变，旧回放 `lst_move` 标量格式在回放重建路径兼容。Q/E（`retractLast`）撤回大队列尾部最后一条指令。对外接口：`addMove/addBuild/retractLast/clearQueue/popQueue/addSpectator/setSpectatorView/sendMessage/surrender/leaveGame`（server.ts 把 `pop_queue` 分派到 `retractLast` 撤回全局最后一条（E 键），`clear_queue` 不分模式一律分派到 `clearQueue` 清空操作队列（Q 键，issue #120））。友军推兵进入存活队友主城时累兵；当刻原拥有者主城数 ≥2 则 owner 自动转属出兵玩家，最后一座只累兵；`auto_crown_transfer` 回放元数据标记新规则，旧回放缺省时保持旧推兵语义并可读取显式 `t` 转让。掉线宽限期三件套：`markDisconnected`（只记 `disconnectedAt[id]`，期间跳过 AFK）、`rebindPlayer`（换绑 sid 与 md5 client_id、清队列防幽灵操作、迁移观战视角偏好、补发 `init_map`（携带 `next_seq`/`queue_ops` 序号同步字段，客户端据此对齐本地 seq 计数，修复断线重连后 lst_moves 错位）+全量帧——迷雾对局按该玩家视野或其选择的观战视角过滤，并把 diff 基线对齐到补发快照）、`expireDisconnect`（超时按「挂机」投降，幂等）——计时编排由 lobby-service 负责。投降 `applySurrenderByIndex`：有存活队友则转移领土，否则拆锚点打入孤军。部署清算 `forceFinish(endMessage)`：停表后走正常终局路径（`sendMap(true)` 存档回放 + `finishGame` 结算，`buildGameResult` 以当前排行榜名次出结果），与正常终局共用 `finished` 幂等守卫防重复结算；`finishGame` 支持自定义结束消息（清算时不报「获胜」）。回放：终局 `saveHistory` 存 ops-v1 操作流；`buildReplayFromActions` 用 `__replay_build__` 哑引擎重放整场生成 `ReplayData`（回放重建、地图示例均走此路，回放始终全视野不含 fog）。

**src/game-engine/constants.ts** — 数值常量集中地。
`LEFT_GAME=52`、`AFK_MIN_TURNS=60`/`AFK_MIN_MS=60_000`（挂机投降需同时满足）、`DISCONNECT_GRACE_MS=10_000`（掉线宽限，1 倍速=20 tick）、`ISOLATED_DECAY_RATIO=0.05`、`ISOLATED_GRACE_TICKS=10`、`FOG_VISION_RADIUS=1`（迷雾视野切比雪夫半径）。调平衡数值只改这里。
_一句话：AFK/掉线/孤军等数值常量。_

**src/game-engine/general-selection.ts** — 开局主城位置选择。
`selectRandomGenerals`：500 组最大-最小贪心候选按间距评分加权轮盘抽取，含按面积/人数折算的硬性最小间距约束（不可达时放宽到最优可达值）；`selectMazeGenerals`：保留迷宫预设位 + BFS 最短路贪心选点。选不出的玩家直接出局。
_一句话：开局主城位置选择（随机/迷宫两套）。_

**src/game-engine/leaderboard.ts** — 每 tick 排行榜与终局名次。
`buildLeaderboard` 扫图累加 army/land，`class_` 标记 `dead`/`afk`；`buildFinalRank` 存活者优先，出局者按出局先后/领土/兵力决胜（compareFinalRank 比较器）；`buildFinalRankTeams` 为个人全序的队伍分组投影（组序=队伍名次序、组内=个人名次序、color=组内最小玩家 id），归档回放时写入索引供回放列表组队合并展示。
_一句话：每 tick 排行榜与终局名次计算。_

**src/game-engine/map-encoding.ts** — 棋盘状态 → 扁平协议数组。
`buildFullVisionArrays` 产出 `{grid_type, army_cnt, isolated}`；grid_type 编码：山 201、中立 200、沼泽 204/owner+150、指挥所 owner+50、主城 owner+100、普通格 owner；isolated：0 正常/1 宽限期/2 衰减期。前端渲染直接消费，**改动需前后端同步**。
_一句话：棋盘状态 → 扁平协议数组编码。_

**src/game-engine/fog-vision.ts** — 迷雾远征（issue #27，房间可开关，默认关；#52 显示语义）。
`computeTeamVisibility` 算队伍可见格（己方格切比雪夫半径 FOG_VISION_RADIUS），`buildFoggedVisionArrays` 在全视野快照上过滤：视野外格子 grid_type 只留 204 沼泽 / 201 未知占位（前端渲染「山+问号」，不下发真实地形），兵力与孤军归零，附 `fog` 扁平数组（1=迷雾格）；视野内敌队指挥所/主城降级为普通领地（保留归属与兵力），中立城市（50）不受影响。观战者/出局者/回放默认不过滤；观战者可经 `spectate_view` 主动选择某队伍视角，由引擎复用 `buildTeamFoggedSnapshot` 按同一套过滤下发（纯显示层）。
_一句话：队伍视野计算 + 视野外快照过滤。_

**src/game-engine/replay-helpers.ts** — 帧差分与克隆工具。
`getDiff` 生成 `[index, value]` 对（实时 diff 帧同用）；`buildReplayPatch` 生成 forward/backward 双向 patch；`toMoveDirection` 坐标→方向索引。
_一句话：回放/实时帧 diff 与 patch 构建。_

**src/game-engine/replay-turns.ts** — 每 tick 操作 → ops-v1 紧凑操作流（存储格式）。
无操作累加 `w n`、投降 `r`、历史主城转让 `t x y`（兼容读取，自带坐标、不动 selected 链）、选中变化 `s x y`、建造 `b/c`、移动 `m`+方向+`h/a` 修饰。与 `replay-scheduling.ts` 互为逆变换，**改动需成对检查**。
_一句话：每 tick 操作 → ops-v1 紧凑操作流。_

**src/game-engine/replay-scheduling.ts** — ops-v1 操作流 → 按回合调度的动作表。
遍历 op 序列还原 `scheduledMoves/Builds/Surrenders/Transfers` 四张 per-player turn→action 表，供 `buildReplayFromActions` 逐 tick 喂回引擎。
_一句话：ops-v1 操作流 → 按回合调度的动作表。_

**src/game-engine/tick-growth.ts** — 兵力增长规则。
主城每 tick +1；普通格每 50 tick +1（孤军不产）；26–50 tick 爆发期普通格每 tick 额外 +1；指挥所不吃爆发；沼泽/中立永不产兵。
_一句话：主城/地块/爆发期兵力增长规则。_

### 地图生成（src/map/，纯函数层）

**src/map/map-core.ts** — 公共底座：`Tile` 类型（-2 出生点/-1/0 空/1 山/2 沼泽）、`SeededRandom`（SHA-256(token) 驱动 mulberry32，同 token 同图）、`computeBaseMapDimensions`（随机图的 45×45 按 ratio 缩放取奇）与 `computeFixedMapDimensions`（华夏固定尺寸）、`checkConnection`（并查集，主连通分量 >90%）、`markLargestComponent`、地形系数派生。
_一句话：地图生成器公共底座（Tile 类型、种子 RNG、连通性）。_

**src/map/map-size.ts** — `resolveMapSizeRatioByPlayers`：人数 → 地图宽高比例（二次函数，下限 0.34）；`resolveMapSizeRatioByPlayersAndRegion` 为台湾省应用 1.5 倍边长倍率。
_一句话：人数 → 地图宽高比例的纯函数。_

**src/map/random-map-generator.ts** — 默认随机图：按概率撒山/沼泽（上限 0.24/0.16），反复重试直到连通；同时定义所有生成器共用的 `MapGenerationConfig`/`GeneratedMap` 类型。不预置中立城市（城市只由玩家建造）。
_一句话：默认随机图生成 + 生成器公共类型定义。_

**src/map/maze-map-generator.ts** — 「峡谷回廊」：DFS 回溯迷宫 + 按面积 3% 打通额外墙（防 2×2 空地）+ 沼泽点缀；尺寸过小回退随机图。
_一句话：DFS 迷宫 + 限量开墙 + 沼泽点缀。_

**src/map/archipelago-map-generator.ts** — 「群岛要塞」：沼泽海上放 3×3–4×4 矩形岛（互不邻接，≥2×人数+1 个），海岸噪声扩边，多次重启贪心挑分散的玩家出生岛；重试上限 220 次，失败回退随机图。
_一句话：矩形群岛 + 分散出生岛挑选，失败回退随机图。_

**src/map/mediterranean-map-generator.ts** — 「地中海」：椭圆径向公式填中央海（沼泽+零星山），外围环形陆地撒山/沼泽；多源 BFS 算距海距离，在外缘带挑「不靠海」的分散出生点。
_一句话：中央海椭圆 + 环陆出生点分散选址。_

**src/map/huaxia-land.json** — 由 `scripts/generate-huaxia-land.py` 从 Natural Earth 1:50m land v4.0.0 下载并简化的 WGS84 陆地多边形子集；只保留覆盖华夏各视口的真实底图数据。

**scripts/generate-huaxia-land.py** — 可复现底图转换脚本，记录 Natural Earth 下载 URL、版本、公共领域许可和简化参数。

**src/map/huaxia-terrain-data.ts** — 真实 Natural Earth 陆地多边形引用，以及有地理依据但非 DEM 测绘的山脉轴线和游戏化关隘。
_一句话：真实公开陆地底图 + 明确标注的游戏化地形层。_

**src/map/huaxia-regions.ts** — 华夏九地区（秦/汉/唐/辽/宋/元/明/中国/台湾省）的独立经纬度矩形、球面矩形面积和稳定 ID；矩形面积是视口面积，历史疆域面积因没有可靠边界矢量而明确为未知；旧 `qing` / `hong-kong` ID 归一为中国。
_一句话：按代表时期估计的独立地理视口配置。_

**src/map/huaxia-season.ts** — `isHuaxiaSeasonActive(date)` 以 `Asia/Shanghai` 判断每年 10 月 1 日至 10 月 7 日（含全天）的年度开放窗口；纯函数可传固定 Date 测试。
_一句话：华夏地图年度国庆开放窗口。_

**src/map/huaxia-map-generator.ts** — 按地区矩形投影真实陆地多边形，矩形内非历史疆域陆地和离岸岛屿均保留为可见陆地；只有最大陆地连通块的平原进入 `st` 出生池，其他陆块不出生。海陆比例随视口变化；固定山脉层并标记最大连通分量，不读取地图 RNG，种子只在后续出生点选择中生效。
_一句话：地理矩形视口内的真实海陆栅格化生成。_

### 存储与工具

**src/binary-store.ts** — 四个 Store 共用的存储底座（issue #67）：统一 v8 serialize + brotli q6 编码（`encodeBinary`/`decodeBinary`，磁盘格式与历史一致，旧数据免迁移）；`writeFileAtomicWithBackup` 原子写入（临时文件 + rename）并在替换前把旧文件复制为 `.bak`；`readFileWithBackup` 在主文件缺失/损坏时自动回退 `.bak`；`CoalescingFileWriter` 合并写盘——同一文件尚未开始的排队写请求被最新快照合并（先到的等待者随合并后的写一并完成），突发连续写入只压缩落盘一次（brotli 惰性执行，被合并的快照零开销）。
_一句话：存储底座：统一编码、.bak 备份回退、合并写盘。_

**src/auth-store.ts** — 用户/会话/Rating/积分存储（`data/users.bin`，v8 serialize + brotli，经 binary-store 底座）。
密码 scrypt 加盐 + `timingSafeEqual`；角色模型：首个注册用户 = 超级管理员（`isSuperAdmin`，唯一、不可剥夺、不可封禁，同时拥有 admin），普通 admin（`isAdmin`）由超管授予/撤销（`setAdmin`），旧数据启动时由 `migrateRoles` 把首个用户升级为超管（向后兼容）；封禁字段 `bannedUntil`（毫秒时间戳，-1=永久，缺省=未封禁），到期由 `getBanStatus` 惰性判定自动解除，`banUser`/`unbanUser` 操作，`listUsersForAdmin` 出后台用户列表；Rating Codeforces 风格：内部 1200 起算，`toDisplayRating` 按 `1200/2^对局数` 折算新手显示分，`ratingHistory` 存显示分（上限 1000 点），`getRatingRank` 只统计 `ratingGames>0` 的注册用户并按显示 Rating、注册时间、用户名稳定排序，导出 `displayRatingRank` 生成个人页分段名次。积分规则常量、`getGamePoints` 与 `calculateHistoricalPoints` 集中在此：每局 40 基础分 + 40~100 排名分，动态奖励为发帖 30、获得互动 10、点赞他人 10、评论 20；`applyPointsUpdates` 支持正负更新并 clamp 到 0。`initializeHistoricalPoints` 使用 `UserFile.pointsMigrationVersion` 从回放和动态完整重建一次旧用户积分，避免旧版每局 10 分重复叠加；积分排名仅保留存储层能力，不在个人页展示。可选字段 `lastSeenAt` 记录「最后在线」（= 用户最近一次有效请求/动作的时间，由 presence-service 统一计算并节流落盘；旧数据无此字段按 undefined 兼容），`setLastSeenAt` 写入（presence 的落盘回调），`listLastSeen` 出全量落盘记录供 presence 启动 seed。`resolveUsername` 返回用户名规范大小写（不存在为 null，@提及解析用），`searchUsernames` 按大小写不敏感前缀搜索用户名（空串返回前若干，@提及候选用）。
排行榜 `listTopRated` 只出最近 7 天内有比赛且未被封禁的用户：活跃只认比赛时间 `lastGameAt`（`applyRatingUpdates` 对局结算时刷新；登录/上线不再续命），距今 ≥ `LEADERBOARD_INACTIVITY_MS`（7×24×3600×1000）即暂时下榜（rating 数据不动，重新结算一局即回榜；bot 账号同一规则）；旧数据无 `lastGameAt` 时一次性 fallback 取旧的 `max(lastSeenAt, updatedAt)` 作初始值。有效封禁（`getBanStatus(...).banned`）用户不上榜，封禁到期惰性解除后自动回榜。
_一句话：用户/会话/Rating 存储，brotli 压缩 users.bin。_

**src/feed-store.ts** — 动态存储（`data/feeds.bin`，同 v8+brotli）。
分页 `listPage`/`listByAuthor`，只读迁移快照 `listAll`；发帖 1–300 字 + 30 秒/人冷却（`FeedCooldownException` 带 `retryAfter`）；评论 1–200 字、每帖上限 200 条，`removeComment` 删除评论（权限校验在 server.ts：作者本人或管理员）；点赞切换。server.ts 按发帖/互动操作同步发放与回扣积分。写入（发帖/编辑/评论）经 `parseMentionTokens` 解析正文 @提及存入可选字段 `mentions?: string[]`（旧数据无此字段，读取与渲染均按缺省兼容）。
_一句话：动态帖子/点赞/评论存储（含 @提及落库），带发帖冷却与评论删除。_

**src/announcement-store.ts** — 公告单文件 JSON 存储（`data/announcement.json`），原子串行写 + `.bak` 备份回退（binary-store 底座），`ANNOUNCEMENT_TEXT_MAX=500`。文本本身不渲染，渲染由上层经 `text-render.ts` 完成。
_一句话：公告单文件 JSON 存储，原子串行写。_

**src/replay-store.ts** — 回放存取、索引与观看二进制 gzip 缓存（`data/replays/`）。
原始 ops-v1 操作流经 v8+brotli 存 `<id>.rpl`（id = 内容 sha256 前 9 字节 base64）；索引 `index.bin`（未压缩 v8 serialize，历史格式）启动时载入内存缓存，读路径不再重复读盘反序列化，写路径更新缓存后经 `CoalescingFileWriter` 合并落盘，主文件/备份均损坏时按空索引兜底并告警。索引项 `ReplayListItem` 含 `rank`（终局个人名次）与 `teams`（终局队伍分组 `{members, color}[]`，组序=队伍名次序，旧索引项无此字段前端回退平铺）。`readReplayViewGzip`：观看路径——缓存 `<id>.rpb.gz` 命中且流式解压前 4 字节（`gunzipPrefix`，不整体解压大缓存）魔数等于当前 `REPLAY_BINARY_MAGIC` 即返回（`size` 取自 gzip 尾 ISIZE 供进度条），否则（未命中/损坏/编码升级后的旧缓存）重建整场 → RPB4 编码 → gzip 落盘缓存。`resolveReplayPath` 校验 id 防路径穿越；`deleteReplay` 同删 .rpl/.rpb.gz/索引。
_一句话：回放存储与 RPB gzip 缓存，id 为内容哈希。_

**src/replay-patch-binary.ts** — `ReplayData` → RPB4 观看二进制编码器（手写 LE；initial 全量帧 + 逐 patch forward/backward 差分 + 玩家 meta；RPB4 起 meta 末尾追加 fog 标志，供前端回放视角选择器）。`ByteWriter` 分块流式写入（1 MiB 块顺序填满后拼接，issue #83：旧的整体字节数组在超长回放编码时 OOM）。仅编码无解码——解码在前端 `static/main/replay-binary.js`；**改格式需同步前端并升魔数**，导出 `REPLAY_BINARY_MAGIC` 供缓存陈旧性校验。
_一句话：ReplayData → RPB4 观看二进制编码器。_

**src/text-render.ts** — 服务端富文本渲染，公告与动态共用唯一入口 `renderRichText`。
流程：KaTeX 预渲染 `$$..$$`/`$..$` → marked（GFM+breaks）→ 换回公式 HTML → sanitize-html 白名单（仅 http(s)/mailto scheme）过滤 XSS。新增允许的 KaTeX 标签/样式需同步改 `sanitizeOptions`。`renderRichTextWithMentions(text, resolve)` 在其后追加 @提及渲染（动态/评论用）。
_一句话：Markdown+KaTeX 渲染并消毒为安全 HTML（+可选 @提及链接）。_

**src/mentions.ts** — @提及解析与渲染（issue #74）。
`parseMentionTokens` 按 `(?<![A-Za-z0-9_@])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])`（与注册用户名规则一致）提取候选，按出现顺序去重、保留原文大小写；写入时由 feed-store 落库。`renderMentionsInHtml` 在消毒后的 HTML 上按「标签/文本」切分，只在非 code/pre/a 文本里替换：resolve 返回规范用户名则生成 `<a class="mention rt-unrated" data-username>`（链接在消毒后插入，无需放宽白名单），返回 null（用户不存在/改名）则保持普通文本。用户名受正则约束 + HTML 转义，无注入面。
_一句话：@提及解析 + 消毒后 HTML 的安全链接渲染（不存在降级文本）。_

**src/rating-color.ts** — `ratingTier(rating, ratingGames)` → `{className: 'rt-*', title}`，阈值仿 Codeforces（<1200 gray … ≥2400 red），无对局为 unrated；`src/server.ts` 的 `usernameAppearance` 先以有效封禁覆盖为 `rt-banned` / `已封禁`，再对未封禁管理员覆盖为 `rt-admin` / `Headquarters`。CSS 类对应 `static/styles/rating.css`。
_一句话：Codeforces 式 rating 段位颜色映射。_

**src/runtime-env.ts** — 启动期 `.env` 自解析（不依赖 dotenv），`JWT_SECRET`/`WEBHOOK_SECRET` 缺失则自动生成并回写 `.env`。
_一句话：.env 加载与密钥自动生成回写。_

**src/types.ts** — 全项目共享类型与协议常量（纯类型）：`MAX_TEAMS=16`、`MoveMode`（0 智能分兵/1 半兵/2 全冲）、`ChatScope`、`ChatFoldPayload`（chat_message 可选折叠负载 `{name, verb}`：进出类系统消息由客户端连续合并显示，issue #113）、大厅/房间视图（`LobbyConfig`/`RoomUpdatePayload` 含 `fog` 迷雾开关、`multi_line` 全局队列开关、`map_size` 大地图开关、九地区 `map_region` 华夏字段与 `map_token_custom` 自定义种子标记）、`UpdatePayload`（grid_type/army_cnt/isolated/可选 fog/lst_moves（本 Tick 出队 seq 列表）/leaderboard/kills/is_diff）、回放类型（`ReplayPatch` forward/backward、`ReplayActionData` ops-v1 操作流，含主城转让 op `t x y`）、Feed 类型。公开请求拒绝非法地区值，缺省为 `china`；内部历史回放在 normalize 层保留旧地区转换。**改协议字段基本都要动这里。**
_一句话：共享类型/协议定义汇总。_

**dist/** — `pnpm run build`（tsc）产物，目录结构与 `src/` 一一对应，是运行时实际加载的代码；勿手改，行为与源码不符时先确认是否重新 build。

---

## 前端源码地图（static/）

无构建的原生 JS + jQuery。页面分两类：

- **内容/文档页**（about、develop、develop-bot、tutorial-text）：共享 `styles/docs.css` 统一样式与 `docs.js`（登录态展示、`data-goto` 导航、KaTeX 公式渲染，含数学内容的页面引入 `vendor/katex/` 的 katex.min.js + auto-render.min.js）；页面特有样式保留内联。
- **功能页**：index.html / profile.js（REST 交互，socket `home_*` 失效通知驱动刷新）；game.html + main.js + main/\*（对局与回放共用一套骨架，**脚本全局化、加载顺序敏感**）。

### 功能页

**static/index.html**（~1000 行，脚本基本内联）— 首页/大厅：个人信息、房间列表、回放列表与上传、动态、公告、排行榜、在线人数与「在线」列表。回放列表名次列按队伍合并展示：索引项带 `teams`（终局队伍分组，组序=队伍名次序）时同队一组（组内 `, `、组间 `›`，不展示玩家配色色块），旧数据无 `teams` 回退 `rank` 平铺；名次列成员名与房间列表房主名统一走 `username.js` 组件（rating 颜色 + 点击跳主页，接口不带颜色时经 `/api/user-colors` 批量补色）。
数据走 REST，socket 以 `?home=1` 连接监听 `home_rooms/home_replays/home_leaderboard/home_announcement/home_feeds/home_online` 失效通知（事件无 payload）。顶栏在线人数与右栏「在线」列表（排行榜下方，按最后活动倒序的前 8 位用户及其相对活动时间，含自己与当前在线者）由 `/api/online` 驱动。`home_online` 收到后对比在线人数快照，增加时经 `notify.js` 弹「有玩家上线」后台通知；`home_rooms` 收到后对比房间号快照，出现新房间时弹「有新的房间」后台通知。公告缓存 `announcementRawText` 供编辑回填、注入服务端消毒的 `data.html`；动态列表为就地增量渲染（issue #85）：刷新时已存在的动态在原 DOM 上只更新变化字段并按序重排，新帖插入、消失帖移除，评论展开态与正在输入的评论框/内联编辑态不被打断；动态原文与渲染 HTML 分别存 `$item.data('raw-text'/'raw-html')` 供编辑回填与变更检测；动态正文/评论渲染后经 `ensureUsernameColors` 为服务端注入的 @提及链接（`data-username`）批量补 rating 颜色，发帖框与评论框带 `data-mention` 由 mention-autocomplete.js 提供 @提及补全；上传回放 POST `/api/replay-upload` 后以 base64 存 sessionStorage 跳 `/replays/local`。
_一句话：首页大厅，房间/回放/动态/公告/排行榜全内联脚本。_

**static/game.html** — 对局页与回放页共用 DOM 骨架，无业务脚本。
按序加载 crown.js → sw-register → username.js → core-globals → notify.js → replay-binary → replay-cache → room-controls → replay-controls → replay-stats → render-update → blink-clock → main.js（顺序敏感）。另加载 `/styles/rating.css`（rt-* 用户名 rating 颜色，对局排行榜/聊天/房间成员名经 username.js 组件使用）。关键 DOM：`#disconnect-banner`（断线横幅）、`#map`、`#menu`、`#status-alert`（按钮按下标访问，改结构需同步 main.js）、`#surrender-alert`（投降确认）、`#spectate-mode`/`#tabs-spectate-mode`（观战中的「下局模式」选择器，仅观战时显示；其容器内另有 `#spectate-view-section`/`#tabs-spectate-view` 观战视角选择器，仅迷雾对局的观战者显示）、`#replay-loading(-bar/-text)`、`#replay-error-alert`、`#replay-view-section`/`#tabs-replay-view`（回放视角选择器，仅迷雾对局回放显示）、`#replay-title`（回放参赛者标题区）、`#replay-stats`/`#tabs-replay-stats`/`#replay-stats-canvas`（回放局势统计图）。

_一句话：对局/回放页骨架与脚本加载顺序。_

**static/main/replay-stats.js** — 回放页增强：参赛者标题区与局势统计图（仅回放、桌面宽度显示）。
`initReplayTitle()` 按末帧 leaderboard（最后一个 forward patch，无 patch 用 initial）经 `replayFinalRankGroups` 生成 `#replay-title`——组队局同队成员逗号分隔、队伍间「>」分隔且组序为终局名次序（非队号序），迷雾组队局沿用 fog-team-names 规则只显队名；标题区成员名统一走 `username.js` 组件（`usernameLinkHtml`），不展示玩家配色色块；`initReplayStats()` 从 initial + 各 forward patch 自带的 leaderboard 预计算各队（非组队局=各玩家）每帧兵力/领土序列（O(帧数×玩家数)，不扫棋盘），顺手产出全程兵力/领土最大位数 `replay_stats_max_digits`（issue #93）——回放加载时据此一次锁定排行榜兵力/领土两列宽度（经 render-update.js 的 `applyLeaderboardColumnLock`），统计图顶部最大值标注按预留位数（最宽数字「8」估宽）排版防探出挤压曲线；在排行榜下方 `#replay-stats` 画 canvas 曲线图：居中滑动窗口平均平滑（半径随局长缩放，上限 15）+ 原始值浅色底层、兵力/领土 tabs 切换、组配色读 map.css `.cN` 计算样式（样式表未加载完时读到透明色——透明结果不入缓存且底图绘制延迟重试，防折线永久不可见）；底图离屏缓存，`refreshReplayStatsFrame()`（render-update.js 每帧调用）只 blit 底图 + 画当前帧竖线游标并把面板贴到排行榜正下方；点击/拖动图面经 `jumpToFrame` 跳转进度。统计图图例（legend）非组队局是用户名，同走 `usernameLinkHtml`；组队局是队名保持纯文本；图例同样不展示配色色块。
_一句话：回放标题区 + 局势统计曲线图（平滑、游标、点击跳转）。_

**static/main.js** — 对局/回放主控制器：维护单一 `route` 大队列，队列项带 `seq`，按 `init_map.next_seq/queue_ops` 与服务端对齐；Q 清空队列、E 撤回队尾，不分模式（issue #120）。
回放模式：`/replays/local` 读 sessionStorage 且不缓存；服务端回放先查 replay-cache IndexedDB，命中并解码成功即显示完成进度；失效/损坏则 `fetchReplayWithProgress` 流式下载（`X-Replay-Size` 头更新 `#replay-loading-bar/-text` 进度），解码成功后异步写缓存，写失败不影响观看；加载提示在 document.ready 里显示（main.js 在 head 同步执行，顶层访问不到 DOM），最后 `replayStart`。对局模式：`connect` 隐藏断线横幅并重发 `join_game_room`（支撑 10 秒宽限恢复）；房间心跳（每 30s 一次 `room_heartbeat`，防止准备阶段被服务器因 600 秒无心跳踢出）不随 `connect` 启动，改为收到 `room_update`（仅发给房内 socket，即成员身份确认信号）后启动并立即上报一次，`disconnect`/`room_kick` 时停止——未进房的挂着标签页不再发心跳（服务端对房外心跳也不计 presence）；收到 `room_kick` 跳转首页；`disconnect` 区分顶号（跳首页）与断网（显示横幅）；`room_update` 对比成员 uid 快照检测新玩家进房、`starting` 表示开局，两者在页面后台时经 `notify.js` 弹浏览器通知，同时维护 `roomMemberTeams`（uid→队伍）供聊天色块门闸用——房间成员名（`#teams`）统一走 `username.js` 组件（ready 下划线改内联 style，避免 rt-* 的 text-decoration:none 盖掉）；`chat_message` 渲染按三门闸决定用户名色块——跨房转发（带 `room`）不给色、对局中仅排行榜内未淘汰者给分配颜色（`gameLeaderboard`）、准备阶段仅参赛席（team>0）给座位颜色，观战/房外只显用户名；色块是局内配色（.cN），用户名本身经 username.js 组件渲染（rating 颜色 + 点击跳主页）；连续进出类系统消息折叠（issue #113）：带 `fold` 负载且上一条仍是折叠元素时就地合并更新文案（同类谓语续列人名、同名去重仅保留首次出现（issue #124）、超 3 人截「等 N 人」、谓语混杂降级「进出了房间。」），中间插入任何其他消息即断链，纯函数在 core-globals.js；操作入队 `addroute/addbuild/...` 后 emit（`lost`/`game_ended`/不在对局时直接丢弃不入队不发送，防止本地自增 seq 与服务端错位）；`keypress` 分发 WASD/Z/X/C/Q/E/T/Enter/Esc/空格（X 建指挥所、C 升级主城；Q 清空队列、E 撤销队尾，不分模式，issue #120）。主城转让（issue #81）：`click` 点到队友存活玩家的主城（grid_type 100~149 且排行榜同队）弹 `#crown-transfer-alert` 确认后发 `transfer_crown {x,y}`；收到 `crown_transfer_request` 弹 `#crown-transfer-request-alert`，按钮回 `transfer_crown_reply {accept}`；两个弹窗随 `starting`/`init_map`/`left` 关闭。部署更新排队：`deploy_queued` 事件与 `room_update.update_queued` 驱动——对局中显示 `#deploy-banner`（「系统即将更新」），准备阶段禁用 `#force-start` 并显示「系统即将排队更新，请稍等」（点击与服务端 `change_ready` 双重拦截）。
_一句话：对局/回放主控：socket、输入、队列、回放加载。_

**static/main/core-globals.js** — 跨文件共享常量（须最先加载）：`htmlescape`、方向表、回放魔数 RPB1/2/3/4、`replay_class_from_code`、共享 TextDecoder、`normalizeMapTokenInput`、兵力数字缩字档 `armyCountShrinkClass`（位数 → `army-num-d5~d8` 类名，≤4 位返回空串，issue #116）、`replay_view_team`（回放视角：0 全知 / 队伍编号）、`spectate_view_team`/`fog_mode`/`self_team`（实时观战视角状态：所选队伍、是否迷雾局、自己房间队伍）、`roomMemberTeams`（房间准备阶段 uid→队伍表，room_update 维护，聊天色块门闸用）、`gameLeaderboard`/`lb`（当前对局排行榜，render-update.js 每帧更新，聊天色块门闸用）、`lb_lock_digits`/`LB_LOCK_DIGITS_MAX`（排行榜兵力/领土列宽位数锁定状态，封顶 6 位只增不减，issue #93）、`findGameLeaderboardEntry`（按座位号查榜）以及迷雾局观战/回放共享名称显示助手（`fogTeamGame` 组队局判定——任一队伍 ≥2 人；`fogTeamName`/`fogDisplayName` 组队显队名「队伍 N」、非组队显用户名；`fogObserverView` 判定当前是否迷雾局观战/回放视角）——**遮罩只作用于实时观战**：render-update.js 对回放强制关闭（回放为全知复盘，排行榜一律显示真实用户名，组队合并结构保留）；回放标题区/视角 tabs 仍按 fog 规则显队名。、终局名次助手（`replayFinalRankCompare`/`replayFinalRankGroups`——与服务端 `compareFinalRank` 逐字一致的排序口径，末帧 leaderboard 现算队伍名次分组，回放标题区用）。

_一句话：共享常量：方向表、回放魔数、转义工具、进出消息折叠纯函数。_

**static/main/render-update.js** — 帧渲染器：`render()` 全量重算格子 class/内容（归属着色、selected/attackable/isolated、迷雾格 `fog` 遮罩、队列箭头（全局队列局逐条队列绘制，着色与普通对局完全一致，不区分队列）、建造角标；迷雾格渲染「山+问号」未知占位、沼泽例外、隐藏兵力，回放队伍视角额外把视野内敌方指挥所/主城降级为普通领地；兵力数字超过 4 位时经 `armyCountShrinkClass` 套 em 缩字类只缩不放大，issue #116），仅变化时写 DOM（格子元素与内容走 main.js `init_map` 构建的 `cell_elems`/`cell_html` 缓存表，随 n/m 重建，免每帧 id 选择器查找与 innerHTML 序列化读取，issue #87）；`update(data, options)` 消费 `is_diff` 差分或全量帧（含可选 fog 数组合并），`options.silent` 为静默路径——只应用局面补丁即返回，跳过迷雾重算/渲染/榜单/统计图等（回放跳转中间帧用，见 replay-controls.js `jumpToFrame`），按 `lst_moves` 序号数组同步本地队列，渲染排行榜/回合计数/爆发期红边（每帧把排序后的榜单写入全局 `lb`/`gameLeaderboard` 供聊天色块门闸查榜），处理 `kills[client_id]` 与 `game_end` 结算弹窗。排行榜名字列统一走 `username.js` 组件（`usernameLinkHtml`，td 保留 `.cN` 作局内配色色块背景，名字链接为 rating 颜色 + 点击跳主页，每帧 `usernameEnsureColors` 批量补色带缓存去重）；「你被 X 击败了」弹窗的击败者名同走组件。兵力/领土列宽锁定（issue #93）：`lb_lock_digits` 记录本局显示过的最大位数（封顶 6、只增不减），经 CSS 变量 `--lb-army-w`/`--lb-land-w` 给 `td.lb-army`/`td.lb-land` 下发 ch 单位 min-width（含 0.5ch 非等宽字体余量），`resetLeaderboardColumnLock` 在 init_map 时重置；回放由 replay-stats.js 预处理一次锁定到全程最大值。回放模式每帧经 `applyReplayFogView` 按 `replay_view_team` 重算迷雾遮罩（回放不含历史视野，按当前帧局面以对局相同的半径 1 规则重算）；实时模式由 update 帧是否携带 `fog` 字段置 `fog_mode`，并每帧 `refreshSpectateViewTabs(data.leaderboard)` 维护观战视角 tabs。迷雾局观战（回放不适用）的排行榜名称列按 core-globals 共享规则显示（组队局显「队伍 N」、非组队局显用户名，参赛存活玩家视角不受影响）；回放一律显示真实用户名。组队局回放的排行榜按团队合并：每队一个整体条目显示团队总兵力/领土并按总兵力排序，队内成员按兵力排序缩进附后（成员行显示真实用户名）。每帧末尾调用 `refreshReplayStatsFrame()`（replay-stats.js）刷新统计图游标与面板位置。
_一句话：帧渲染器：update 帧合并 + 地图/榜单更新。_

**static/main/replay-binary.js** — RPB1/2/3/4 回放二进制解码器，产出 `{n,m,initial,patches[],meta}`（RPB4 起 meta 含 fog 标志）；帧结构与 socket `update` 同构，直接喂 render-update.js。**格式变更须与 `src/replay-patch-binary.ts` 同步。**
_一句话：RPB1/2/3/4 回放二进制解码为 update 帧。_

**static/main/replay-cache.js** — 浏览器 IndexedDB 回放缓存：原始哈希 ID 为键，存解压后 ArrayBuffer、缓存版本、下载/最近查看时间、字节长度以及响应的 ETag/Last-Modified（缺失时以首次下载时间+长度兜底）；命中校验当前 `replay_binary_magic` 与版本，不向服务器重新验证不可变 ID。写前同事务按最近查看时间淘汰至 1 GiB / 200 条；禁用、损坏或配额不足时回退网络。
_一句话：回放观看二进制的本地 LRU 缓存。_

**static/main/replay-controls.js** — 回放步进/跳转/自动播放（`backTurn/nextTurn/jumpToTurn/jumpToFrame/switchAutoplay`；`jumpToFrame` 按帧下标跳转，供统计图游标点击/拖动使用——前进/后退中间帧均以静默模式应用补丁（`nextTurn(true, silent)`/`backTurn(silent)` → `update(patch, {silent:true})`），仅落点帧走完整 update()，超长回放跳转不再逐帧全量渲染，issue #87）、迷雾对局回放的视角选择器（`initReplayViewTabs` 按 meta.fog 与参赛队伍动态生成「全知 + 各视角」tabs——组队局每队一个「队伍 N」、非组队局各玩家用户名，标签经 `replay_view_teams` 映射队伍编号，与观战视角同一套共享规则；`setReplayViewTeam` 切换即时重绘）与投降弹窗显隐。
_一句话：回放步进/跳转/自动播放、视角选择与投降弹窗。_

**static/main/room-controls.js** — 房间大厅 UI：链接复制、设置 tabs 三件套（`getTabVal/setTabVal/initTab`）、地图类型/组队/迷雾/全局队列等开关编解码（`getMapModeCode/setFogModeByCode`/`getMultiLineModeCode/setMultiLineModeByCode` 等）、队伍切换（`change_team`）、房主配置 emit `change_game_conf`（种子失焦上传）、聊天队伍前缀、观战视角选择（`refreshSpectateViewTabs` 按排行榜动态生成「全图 + 各存活视角」tabs——组队局每队一个「队伍 N」、非组队局各玩家用户名，与回放视角同一套共享规则；dead 成员不提供视角，当前选中队伍无存活成员时自动回全图；`onSpectateViewTab` emit `spectate_view` 切换，仅迷雾对局观战者可见，玩家集合不变不重建以保留选中态）。
_一句话：房间设置 tabs、链接复制、队伍与聊天前缀。_

**static/main/blink-clock.js** — 全局闪烁时钟：在 `#map` 容器上周期切换 `blink-slow`（1s 衰减期）/`blink-fast`（0.4s 宽限期）/`pulse-soft`（1.2s 教程目标），单元格只挂声明 class，相位统一驱动。
_一句话：#map 容器级闪烁相位时钟，三种周期。_

**static/profile.html / profile.js** — 个人主页 `/u/:username`：与首页一致的三栏资料卡/积分等级进度、最高 Rating、分段 Rating 排名、最近 rating 变更、手写 SVG rating 历史折线图（峰值金色高亮）、TA 的动态与回放；不展示积分排名。动态部分与首页代码平行（数据源换 `/api/profile/:u/feeds`），游客保留只读展示，登录用户显示已有互动；动态作者/评论与回放名次列的用户名统一走 `username.js` 组件（rating 颜色 + 点击跳主页），正文 @提及链接同样经 `ensureUsernameColors` 补色，评论框带 `data-mention` 支持 @提及补全。另以 `?home=1` socket 监听 `home_leaderboard`（rating 结算广播）触发 `usernameColorsInvalidate()` 刷新名字颜色（issue #84）。
_一句话：个人主页逻辑：积分等级/进度、Rating 排名与 SVG Rating 图 + 动态/回放。_

**static/admin.html / admin.js** — 后台管理页 `/admin`（仅管理员；页面入口在首页顶栏，仅 admin 可见）：用户列表（用户名/rating/注册与最后在线时间/角色/封禁状态）分页展示（每页 20 条，前端即时过滤），顶部搜索框按用户名子串即时筛选并显示用户总数/匹配数；封禁对话框（1 小时/1 天/7 天/自定义小时/永久）与解封，超管额外可授予/撤销管理员。JS 按功能分区（顶部 chrome / 用户管理 / 封禁对话框 / 策略 Bot），便于扩展新管理模块。「策略 Bot」分区仅超管可见（`viewerIsSuperAdmin` 门控 + 服务端 403 兜底）：初始化时拉取 `GET /api/admin/bot-templates` 自动填充模板下拉框（无可托管模板时禁用启动按钮并提示），输入用户名 + 房间号、选择模板并勾选是否允许组队后启动（成功后仅清空房间输入），表格展示运行中 bot（用户名/房间/模板/组队/启动时间/连接状态）并可手动停止。
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

**static/username.js** — 全站统一用户名渲染组件（首页/个人主页/后台/对局页均加载）：`usernameLink(name, info?, extraClass?, opts?)` 构建带 rating 颜色（rt-*）+ 点击跳 `/u/:username` 的链接；`usernameLinkHtml(name)` 为同源 HTML 字符串版（热路径 innerHTML 重建用，用户名经 htmlescape）；`usernameCacheSeed(map)` 用接口已有 colorClass 数据喂全局缓存（用户名→{colorClass,title,admin,banned}）；`usernameEnsureColors(names)` 批量调 `GET /api/user-colors` 补齐缺失颜色（inflight 去重，未上榜/未定级降级 rt-unrated），回填后经 `data-username` 标记自动刷新已渲染链接；`usernameColorsInvalidate()` 在 rating 结算或封禁/解封/管理员权限变更后（服务端广播 `home_leaderboard`，首页/个人页/对局页均监听）清空颜色缓存并为当前页所有已渲染链接重拉颜色，保证等级色跨面板及时更新（issue #84）。所有公开用户名外观出口附 `banned`（由 `userStore.getBanStatus` 判定有效封禁）及 `admin`；有效封禁优先返回 rt-banned（棕色、正常字重、中性 tooltip），未封禁管理员为 rt-admin（黑色加粗）及 Headquarters，首页和个人页不再展示重复管理员标签（issue #97）；`usernameRefreshRendered` 褪旧档列表含 rt-admin/rt-banned，并同步更新颜色与 tooltip。DOM 用 `.text()`，HTML 版用转义防注入。与局内配色 `.cN` 职责分开：色块/底色=.cN，名字颜色=本组件。
_一句话：统一用户名链接组件 + rating 颜色全局缓存。_

**static/mention-autocomplete.js** — @提及输入补全（首页与个人主页共用，无构建全局脚本）。
自动为带 `data-mention` 的 `input`/`textarea`（首页 `#feed-input` 与动态/评论输入框）挂补全：识别光标前的 `@+局部用户名` 上下文（排除邮箱/`@@`），防抖调 `GET /api/users/search` 拉候选并在输入框下方弹共享下拉（挂 body）；上下键选择、回车/Tab 插入 `@用户名 `、Esc 关闭，插入后派发原生 `input` 事件让页面计数器响应。插入时置 `__mentionSuppressEnter`（`window.mentionAutocompleteShouldIgnoreEnter` 暴露），供评论框 keypress 的 Enter 提交跳过。候选名用 rating 颜色类渲染。
_一句话：@提及候选下拉与键盘插入。_

**static/notify.js** — 浏览器通知共享模块（首页与对局页共用，无构建全局函数）。
`notifyEvent(tag, title, body)`：仅在标签页后台（不可见或无焦点）且权限已授予时弹 Notification；去重两道保险——localStorage 时间戳互斥（5 秒窗口内同 tag 只有一个标签页弹）+ Notification `tag` 参数浏览器自动替换。`maybePromptNotificationPermission()`：`permission === 'default'` 时弹解释窗（复用 `.alert` 样式，说明进房/开局/上线/建房四类触发时机），由「开启通知」按钮手势调 `requestPermission()`；`denied` 永不打扰，解释窗每个浏览器最多弹一次（localStorage 持久化）。
_一句话：Notification 权限引导 + 后台去重弹通知。_

**static/sw-register.js + sw.js + updating.html** — 部署更新兜底 Service Worker 三件套。
`sw-register.js` 由 index.html 与 game.html 加载，`load` 后注册 `/sw.js`（失败静默）；`sw.js` 安装时预缓存 `/updating.html`（公开路径，无需登录），仅拦截页面导航请求（`mode==='navigate'`）：网络失败或响应 ≥500（反代在进程退出时返回 502/503）时以缓存的更新页兜底，其余请求直通网络不缓存；`updating.html` 为自包含「正在更新」提示页，每 3 秒轮询 `/`，服务恢复后 `location.reload()` 回原页面（地址栏保持原 URL，SW 会把导航交回真实页面）。
_一句话：服务器重启期间 SW 接管导航显示「正在更新」页并自动恢复。_

### 样式表（static/styles/，main.css 只做 @import 聚合）

- **base.css** — 全局 CSS 变量、字体（CDN 镜像 + 本地子集兜底）、通用组件基座；全局字体排除 KaTeX；含 @提及补全下拉 `.mention-menu` 与正文 `.mention` 链接样式。_全局设计令牌与组件基座（含提及下拉）。_
- **map.css** — 地图格子全部视觉：尺寸档 `.s1–.s6`、颜色 `.c0–.c17`（`code%50==playerId`，每个配色类同时声明背景色与按 WCAG 亮度选取的文字色）、地形背景图、选中/可攻击态、孤军闪烁、建造角标、移动箭头、迷雾格 `.fog`（深色 inset 遮罩）、兵力数字缩字档 `.army-num-d5~d8`（em 相对各尺寸档字号，只缩不放大，issue #116）。_地图格子视觉规则全集。_
- **game-ui.css** — 对局 HUD：排行榜（`tr.dead`/`tr.afk`、组队局回放层级行 `tr.lb-team`/`tr.lb-member`、兵力/领土列宽锁定 `td.lb-army`/`td.lb-land` 经 CSS 变量 min-width，issue #93）、回合计数、`#disconnect-banner` 断线横幅、`#deploy-banner` 部署更新警告横幅、回放控制条、回放参赛者标题区（`#replay-title`）与局势统计图面板（`#replay-stats`，左上/左下圆角）。_对局 HUD 与回放控制条样式。_

- **chat-and-alert.css** — 左下聊天框（含收起态、媒体查询）与 `.alert` 居中弹窗、通知权限引导弹窗（`.notify-permission-*`）。_聊天框与弹窗样式。_
- **home.css** — 首页（`body.home` 作用域隔离）三栏卡片布局 + 动态/公告/排行榜/回放上传弹窗全套。_首页三栏布局与 feed 全套样式。_
- **profile.css** — 个人主页，与 home.css 平行的卡片语言 + rating 变更/历史图。**改 feed/评论样式需与 home.css 双改。\***个人主页样式（与首页平行）。\*
- **admin.css** — 后台管理页：用户表格、搜索/分页工具栏、角色徽标、封禁行高亮、封禁对话框、策略 Bot 分区表单。_后台管理页样式。_
- **lobby.css** — 房间页：邀请链接卡、队伍分组色块、房主滑条设置。_大厅链接/队伍/滑条设置样式。_
- **rating.css** — `.rt-*` 八档 rating 用户名颜色（后端 `rating-color.ts` 注入类名）+ `.rt-admin` 管理员黑色加粗与 `.rt-banned` 有效封禁棕色正常字重（issue #97）；`game-ui.css` 局内排行榜仍压为白字保证底色可读。_Rating 与身份姓名样式。_
- **tables-and-inputs.css** — 通用表格、`.mobile` 移动端紧凑模式、跨浏览器 range 滑条。_通用表格/移动端/滑条样式。_
- **tutorial.css** — 教程步骤横幅、地图平移缩放、目标高亮。_教程页样式。_
- **docs.css** — 文档页共享样式（about/develop/develop-bot/tutorial-text）：`.doc-panel`/`.doc-table`/`.formula`/`.tips`/`.kbd`/`.cta-row` 等；各页仅保留特有内联样式（教程的地形列表与地图示例棋盘）。公式由 `docs.js` + `vendor/katex/`（katex.min.js + auto-render.min.js，css/fonts 原有）在客户端渲染，定界符 `$$…$$` / `\[…\]` / `\(…\)`，作用域 `#app`。_文档页共享样式与公式渲染。_

### 资源

- `static/vendor/katex/` — 本地化 KaTeX 发行版（css + 字体），公告/动态公式渲染；升级整体替换。
- 字体：Quicksand（3 档 otf）与 HYMaQiDuo（35/45/55W，ttf + subset woff2，子集是实际加载项）。
- `city/crown/mountain/obstacle/swamp.png` 地块贴图（map.css 引用）；`gong.mp3` 音效。

---

## 配置 / CI / 脚本 / bot 模板

- **package.json** — 脚本入口（dev=tsx 直跑 src、build=tsc、lint、format、test:bot、test:server-bot、test:lobby-guards、test:lobby-dwell、test:client-verify、test:bot-dwell-cap、test:guest-access、test:points、test:deploy-update、test:fog、test:multiline、test:rebind-sync、test:presence、test:map-generation、test:huaxia-season、test:strategy、test:leaderboard、test:storage、test:crown-transfer、test:admin-badge、test:asset-versioning、test:army-num-font、observe:bot）与依赖清单；`packageManager` 锁定 pnpm（Corepack）。

- **tsconfig.json** — src→dist，CommonJS+ES2022+sourceMap；**刻意关闭严格模式**，改严格度会影响整个 src/ 编译面。
- **eslint.config.cjs** — flat config，只查 `src/**/*.ts`，推荐规则集 + 关闭 `no-explicit-any`；不查 static/。
- **.prettierrc / .prettierignore** — 单引号/分号/尾逗号/110 列；排除 dist、node_modules、static/vendor。
- **.gitignore** — 忽略依赖/产物/运行时数据（data/users.bin、feeds.bin、announcement.json、server-bots.json、replays/、observe-*/）/`.env.*`。
- **.github/dependabot.yml** — npm 依赖每周更新。
- **.github/workflows/bump-version-and-merge.yml** — 唯一 CI：owner 在 PR 评论 `OK. <major|minor|patch> [merge|squash|rebase]` 触发升版本、冲突检测、自动合并（`dev/` 分支合并后删除）。
- **scripts/migrate-rating-display.mjs** — 一次性迁移：users.bin 历史 rating 换算显示分，原地覆盖写回（运行前先备份）。
- **scripts/recalc-rating-today.mjs** — Rating 重算：按回放索引全量重放，今天 00:00 前用旧公式（队伍分取平均）复现历史、今天起用人数加权公式（队伍分 = 400·log10(n^(k-1)·Σ10^(r/400))）重算；`--from-k`/`--to-k` 指定校验与目标公式（默认 1 → 4），`--check` 先全量复现并与 users.bin 逐用户比对（不一致即拒绝），`--apply` 写回 users.bin（须先停服并备份）。
- **scripts/test-bot.mjs** — `pnpm run test:bot`：临时数据目录起服务 + 两个 bot 自动对局，双方收到 `init_map` 且累计 ≥10 回合即通过。
- **scripts/test-server-bot.mjs** — `pnpm run test:server-bot`：托管策略 bot 冒烟测试——dist 造用户（首个 = 超管）、调 `/api/admin/bots/start` 进程内启动 simple-strategy-bot、random-patch-bot 作对手，另启动 anti-human-bot 校验模板自动枚举（simple-strategy-bot/anti-human-bot 入选、random-patch-bot 排除）、自动准备进入对局、同房间第二个 bot 409、不可托管模板 400、allowTeam=true 房间组队默认关闭且房主可开启、开启后 bot 自主避让到固定的 2 队、人类换到 bot 队伍不被服务端修正且 bot 再次主动避让；保留 403 权限闸、房长保留（host 落在第三方 bot）、allowTeam=false 托管 bot 房间禁止组队（bot 进房强制关闭已开组队 + 房主开启请求被拒绝）、`init_map` + ≥5 条实际 attack、杀服重启后按状态文件（含 template/allowTeam）自动恢复原配置、停止 API 清空列表与状态文件。
- **scripts/test-lobby-guards.mjs** — `pnpm run test:lobby-guards`：开局/换绑守卫回归——组队模式全员同队拒绝开局（换队后可开）、对局中同名人类连接不得接管 bot 席位（以观战进房且 bot 持续收 update）、bot 与人类各自断线重连仍可恢复席位、大地图面积约为标准 4 倍、只剩 bot 时房间设置重置为默认值（观战人类仍算占用不触发；对局进行中不触发、对局结束后才重置）。
- **scripts/test-huaxia-season.mjs** — `pnpm run test:huaxia-season`：用固定 UTC 时间验证 `Asia/Shanghai` 下 9/30 关闭、10/1 开启、10/7 开启、10/8 关闭及次年 10/1 开启。
- **scripts/test-lobby-dwell.mjs** — `pnpm run test:lobby-dwell`：房间停留上限（12 小时）单元测试——tsx 直跑 src 的 LobbyService（假 io 捕获 `room_kick`），覆盖停留超限被踢、未超限保留、对局进行中豁免、heartbeatExempt bot 豁免、原心跳超时踢出不变、离开清理记录且重进重置计时。
- **scripts/test-chat-fold.mjs** — `pnpm run test:chat-fold`：房间进出消息折叠（issue #113/#124）——node vm 加载 `static/main/core-globals.js` 的 `chatFoldAppend/chatFoldText` 纯函数（同类连续合并、同名去重、交错降级「进出了房间。」、超 3 人截断「等 N 人」、断链重起）+ tsx 直跑 src 的 LobbyService 断言 `sendLobbySystemMessage` 的 chat_message 负载仅进出类消息携带可选 `fold: {name, verb}`。
- **scripts/test-spectator-broadcast.mjs** — `pnpm run test:spectator-broadcast`：观战进出广播文案（issue #122）——临时数据目录起 dist 服务 + socket.io-client：准备阶段进出仍广播「自定义房间」；对局进行中进房广播「加入了观战席。」、观战离房广播「离开了观战席。」（text 与 fold 谓语同步断言）；换队到观战席的既有文案不受影响。需先 `pnpm run build`。
- **scripts/test-army-num-font.mjs** — `pnpm run test:army-num-font`（纳入 `pnpm test`）：兵力数字缩字档（issue #116）——node vm 加载 core-globals.js 的 `armyCountShrinkClass` 断言位数 → 档位映射（≤4 位不缩放），解析 map.css 断言各档 em 系数 < 1 且单调不增，再用 @napi-rs/canvas 注册本地 Quicksand-Regular.otf 实测最宽数字「0」在 s1~s6 各档 5~8 位均完整放入格内（无需构建）。
- **scripts/test-client-verify.mjs** — `pnpm run test:client-verify`：临时数据目录起 dist 服务 + socket.io-client，覆盖 JWT 未验证连接自动标记 AI；已验证真人先发 `client_verify` 紧接进房（不等待 ack/心跳/延时），首次 `room_update` 即无 AI 标记并取得房主优先；`room_heartbeat` 补充路径回归。引擎创建边界验证 JWT 全 AI 4x、真人参战保持配置速度、真人观战不影响 4x、首次发帧与验证集合变更/换绑/成员移除后的排行榜快照稳定。准备门槛覆盖真人与 AI 分组向上取半、未准备组阻止开局和观战忽略；真实 socket 验证混合房真人准备后开局、离开等待房超过宽限期 rating/对局数不变。需先 `pnpm run build`（缺失时自动构建）。
- **scripts/test-bot-dwell-cap.mjs** — `pnpm run test:bot-dwell-cap`：非官方 AI 每日官方 Bot 房停留上限（4 小时）单元测试——AI 身份与房间标记共用 humanVerified，不看 JWT/token；tsx 直跑 src 的 LobbyService，覆盖进官方 Bot 房计时与离开累计、超限被拒、准备阶段自动踢出、对局中不打断及终局立即检查、普通房/真人/托管 bot 不受限、日历日重置、tryRejoin 换绑保留计时、补验真人停止计时、历史与当前计时段合并判定。
- **scripts/test-presence.mjs** — `pnpm run test:presence`：统一在线状态测试。单元部分用假时钟驱动 dist 的 presence-service（活动刷新、过期判离线、去重计数、离线↔在线转换、节流/兜底落盘、「在线」列表全员按活动倒序、seed 恢复）；集成部分临时数据目录起 dist 服务（注入 `ROKA_BOT_TOKENS`），验证任意 API 请求刷新「最后在线」、`/api/online` 自身不计活动、多连接按用户去重、房外 socket 的 `room_heartbeat` 不刷新在线而房间成员的心跳刷新在线、bot 连接不计入在线、重启后从落盘恢复。不跑对局，硬上限 60 秒。

- **scripts/test-deploy-update.mjs** — `pnpm run test:deploy-update`：部署更新 UX 回归——`ROKA_DEPLOY_GRACE_MS=4000` + `ROKA_DEPLOY_DRY_RUN=1` 起临时服务：对局中触发 webhook 进入排队（queued:true + `deploy_queued` 广播 + `room_update.update_queued` + 宽限提示）、排队期就绪被拒不开局、宽限到期按当前名次清算（game_end 帧 + 回放 id + rating 生效）、dry-run 结束后解除排队可重新开局。

- **scripts/test-fog.mjs** — `pnpm run test:fog`：迷雾远征冒烟——房主 `change_game_conf {fog:true}` 开局后，校验客户端合并局面满足迷雾不变量（帧带 `fog` 数组、迷雾格只泄地形且兵力归零、己方主城可见、视野内无敌方主城），对照默认房间不带 `fog` 字段；观战视角以 node vm + 最小 DOM/jQuery 桩执行真实 `update()/render()`，覆盖初始全图→队伍 1→队伍 2→全图及每段后续差分，并验证 dead 成员 tabs 排除、当前视角失效回退；可控引擎场景覆盖已选/新选淘汰队伍均回全图且后续仍差分、存活但无领土队伍不泄露全图（issue #125）；另覆盖 issue #51：bot 进房后迷雾被强制关闭、房主再次开启请求被拒绝、纯人类房间不受影响。

- **scripts/test-multiline.mjs** — `pnpm run test:multiline`：单线串行（`multi_line: false`）引擎级套件（直驱 dist/game-engine.js）——同 Tick 两个不同出发点各发一条指令时每 Tick 只执行一条、第二条原地等待下 Tick；单链逐 Tick 推进节奏；失效队首被丢弃且 seq 进 `lst_moves`（丢弃 + 执行同帧汇报）；执行首条有效指令后本 Tick 不再处理后续（后续失效指令也不当场丢弃）；建造 b/c 同样每 Tick 一条；E 撤回摘除大队列队尾、Q 清空整个大队列（issue #120）；单线 `init_map` 保持旧协议（无 `multi_line` 标记，`next_seq/queue_ops` 保留）。需先 `pnpm run build`。
- **scripts/test-multiline-v2.mjs** — `pnpm run test:multiline-v2`：v3 全局队列（`multi_line: true`）并行套件（直驱 dist/game-engine.js）——单链逐 Tick 节奏与单线一致、两条独立链同 Tick 真并行且 seq 同帧汇报、同格 b+c 按序执行、失效移动被丢弃且 seq 进 `lst_moves`、`init_map` 下发 `next_seq/queue_ops`、Q 清空整个大队列且 E 撤回全局最后一条（统一语义，issue #120）；成环死锁回归（issue #121：二环/三环逐 Tick 拆解排空、失效成环节点丢弃后恢复）。需先 `pnpm run build`。
- **scripts/test-rebind-init-sync.mjs** — `pnpm run test:rebind-sync`（纳入 `pnpm test`）：断线重连换绑 seq 同步回归（直驱 dist/game-engine.js）——入队推进 nextSeq 后触发 `rebindPlayer`，断言换绑补发的 `init_map` 携带 `next_seq`（与服务端当前值一致、不复位）与 `queue_ops`（换绑清队后的空拷贝）、换绑后新入队 seq 接续递增；观战席 `addSpectator` 的 `init_map` 不带这两个字段（观战渲染不依赖）。需先 `pnpm run build`。
- **scripts/test-strategy-logic.mjs** — `pnpm run test:strategy`：策略逻辑单元测试——合成 1×m 走廊棋盘直接驱动 `bot/` 纯函数模块（buildContext + planOffense），回归四类行为：优势即打（触发即攻）、集结期入口不出兵切断（防入口易位致纵队折返）、僵死对峙超时解散 + 重集结闸门 + 改善后开打、爆发期路径敌格自然增兵不误判增援弃打。
- **scripts/test-leaderboard-activity.mjs** — `pnpm run test:leaderboard`：排行榜上榜规则单元测试——临时数据目录起 `dist/auth-store.js` 的 UserStore，固定 now mock 时间，回归：7 天内有比赛（lastGameAt）在榜、8 天无比赛下榜、恰好 7 天下榜、只登录/只上线（lastSeenAt/updatedAt 近但 lastGameAt 超 7 天）不在榜、有效封禁即使刚打过比赛也不在榜且过期自动回榜、旧数据无 lastGameAt 按 `max(updatedAt, lastSeenAt)` fallback 判定、无对局（ratingGames=0）不在榜、重新结算一局（applyRatingUpdates）后立即回榜；需先 `pnpm run build`。
- **scripts/test-replay-cache.mjs** — `pnpm run test:replay-cache`：Node vm 加载浏览器纯逻辑，断言 ID 键、版本/魔数/长度失效及条数/容量 LRU 淘汰，不依赖浏览器或服务端。
- **scripts/test-storage.mjs** — `pnpm run test:storage`：存储层回归（issue #67）——临时数据目录驱动 dist 四个 Store：突发连续写入状态完整（合并写不丢状态）、`.bak` 备份生成与主文件损坏自动回退、旧格式（v8+brotli q6 历史写法）文件原样可读、回放索引内存缓存/重启恢复/index.bin 损坏回退/deleteReplay 清理、公告损坏回退；需先 `pnpm run build`。
- **scripts/test-mentions.mjs** — `pnpm run test:mentions`：@提及回归（issue #74）——`parseMentionTokens` 边界（去重/邮箱/短于 3 位/长于 20 位/`@@`/词内）与 `renderMentionsInHtml` 行为（命中渲染链接、未命中降级文本、code/pre/a 内不替换、邮箱样文本不替换）＋ `renderRichTextWithMentions` 消毒集成；再用临时数据目录驱动 dist `FeedStore` 验证动态/评论 mentions 落库、重启保留，并手写不含 mentions 的旧格式 `feeds.bin` 验证向后兼容；需先 `pnpm run build`。

- **scripts/test-crown-transfer.mjs** — `pnpm run test:crown-transfer`：自动主城转属单元冒烟——直接驱动 dist `GameEngine`（运行时访问 private 字段布置棋盘），覆盖同队多主城自动转属、最后一座仅累兵、来源保留、cnt=0、三种推兵模式、普通地/指挥所/敌方主城回归，以及旧显式转让入口兼容；需先 `pnpm run build`。
- **scripts/test-admin-badge.mjs** — `pnpm run test:admin-badge`：管理员与封禁用户名外观（issue #95/#97）回归——第一部分用 node vm + 最小 jQuery/fetch 桩驱动 `static/username.js`（管理员 rt-admin + Headquarters tooltip、无徽标、普通用户不变、撤权恢复 rating）；第二部分临时数据目录起 dist 服务，断言 /api/user-colors、/api/users/search、/api/profile、/api/leaderboard、/api/online、/api/feeds 帖子与评论、/api/admin/users 的管理员与普通用户外观；需先 `pnpm run build`。
- **scripts/test-asset-versioning.mjs** — `pnpm run test:asset-versioning`（纳入 `pnpm test`）：静态资源版本号注入回归——临时数据目录起 dist 服务，断言首页与对局页（/games/:id，造用户登录）响应中全部本地 .js/.css 引用携带 `?v=<package.json version>`、/main.css 响应的 @import 行携带同一版本号、带 ?v= 的静态资源请求返回 200 且内容正确（模板文件占位符已替换、@fastify/static 直发文件忽略未知 query）、模板路由 ETag/If-None-Match 304 缓存语义保持；需先 `pnpm run build`。
- **scripts/analyze-replay-compression.mjs** — 回放存储压缩评估（issue #67）：扫描 `data/replays/*.rpl` 统计操作流特征（op 类型分布、选中切换占比）并对比候选编码体积（现状 v8+brotli q6 / q11 / 文本 DSL / 二进制打包）；`--limit=N` 限定扫描数量。
- **scripts/observe-bot-match.mjs** — `pnpm run observe:bot`：对局观测/病理分析——临时数据目录起 dist 服务 + 进程内观战 recorder 逐 turn 录完整盘面（`frames.jsonl`），按 `OBS_BOTS` 启动 bot 组合（`strategy:`/`random:`/`legacy:` 前缀，`legacy` 从 git main 导出旧版做 A/B 基准），赛后生成 `report.txt`（往返抖动/送兵/前线停滞/切断无救援/主城沦陷时闲散兵力）；环境变量 `OBS_SPEED`/`OBS_MAP_TOKEN`/`OBS_MAP_MODE`/`OBS_OUT`/`OBS_MAX_MS`，输出默认 `data/observe-*/`（gitignored）。
- **scripts/replay-bot-decisions.mjs** — bot 决策离线复盘：假 socket 驱动真实 `strategy.js` 逐 turn 重放观测目录的 `frames.jsonl`（队列执行按服务端 `chkMove`/`chkBuild` 语义模拟），完整复现跨 tick 决策状态；支持 `--validate`（与 bot 日志逐 op 比对）、`--from/--to`、`--board`、`--cell` 盘面解释；配 `BOT_TRACE=1/2` 输出进攻评估/焦点/候选榜。
- **scripts/extract-replay-frames.mjs** — 回放转帧：从 `data/replays/<id>.rpl`（ops-v1）经 dist 引擎重放提取逐 turn 全量帧，输出 `data/observe-<id>/frames.jsonl` + `meta.json`，供 replay-bot-decisions.mjs 与分析脚本使用。
- **scripts/analyze-game.mjs** — 对局病理分析：基于 observe 目录帧 + 回放 ops 流，汇总逐 turn 双方 land/army、bot 大兵堆位置与距敌距离、进攻时间线。
- **scripts/show-board.mjs** — 复盘打印：输出 observe 目录指定 turn 的 ASCII 棋盘与每格兵力。
- **bot-template/random-patch-bot/** — socket 协议最小参考实现（独立 pnpm 包，仅依赖 socket.io-client）：进房、自动准备、周期发送 `room_heartbeat`、维护 diff 地图、每回合随机走子；协议细节另见 `static/develop-bot.html`。
- **bot-template/apex-bot/** — 独立策略模板（独立 pnpm 包）：`bot/` 包含服务端规则预演、队伍连通与 Tarjan 割点分析、紧凑建设、持续突击单元、跨区域扩张、前线锚点和截断恢复；`controller.cjs` 在迷宫地图记录最近移动边、反向边和短期冷却，拦截普通集结的重复送兵并在安全替代路线不可用时转入锚点建设；`strategy.js` 提供 CLI/托管共用的 `attachStrategy`，默认在最新服务器帧上立即决策，避免 4x 时基于过期局面行动；`test/` 覆盖协议、规则、图算法、控制器、大地图评测指标、树形集结、迷宫动作滞回和用户回放地图回归（`test/fixtures/` 保存回放元数据与操作流）；`training/engine.cjs` 直接加载当前 `src/game-engine.ts` 做真实离线对局，并可用完整引擎配置复现线上回放地图，`training/worker.cjs` 与 `training/long-eval.cjs` 用 worker_threads 执行全局队列程长期评测并记录决策延迟、失败回放，以及按尺寸/尺寸组分阶段的皇冠、城市、兵力、领土、建设动作和相对对手发育指标；未结束对局在 `losses`/`effectiveLosses` 中按失败计入。
- **bot-template/simple-strategy-bot/** — 综合策略 bot（独立 pnpm 包）：`strategy.js` 为入口与管线编排（socket/房间循环/队列镜像/逐 tick 决策，recentMoves 窗口丢弃互逆操作防往返抖动，常规输送每 tick 限 1 条 op 防挤占扩张/建设），`bot/` 为纯函数决策模块——`board.js`（棋盘视图/距离场/Dijkstra/推兵预演/孤军聚块/咽喉割点识别与双层危险场定量驻军）、`defense.js`（威胁推演与集结布防，活跃威胁逼近触发回防闩锁）、`offense.js`（目标评估/风险路径/集结打击/切断入侵/前线突破集结/打击体检与冷却）、`rescue.js`（被切断孤军的走廊救援评估与止损）、`economy.js`（皇冠/指挥所建设选址）、`logistics.js`（汇集输送/中立扩张）、`opening.js`（开局发育规划器：逐 tick 模拟选最优启动时机，1–30 tick 接管、爆发期后半交还常规管线）；CLI `index.js` 与服务端托管（`src/server/server-bot-manager.ts` 经 `strategy.js` 加载）共用这一份实现；用法见包内 `USAGE.md`。
- **bot-template/anti-human-bot/** — 独立实现的 AI 策略 bot（独立 pnpm 包，依赖 socket.io-client）：自研协议/状态（`bot/state.cjs`）与纯函数决策管线（`bot/policy.cjs` 调度，`bot/threat.cjs` 共享局面分析层——按到达时间衰减的局部威胁场 + 建造竞赛状态，frontline/logistics/building/architecture/defense/campaign/cutoff/column/ffa/interception/rescue/opening/tactics/planner ，并导出 `ownStrandedMass` 共享连通判定——引擎 applyConnectivity 同款锚点 BFS，脖子纪律/campaign 锚点链/frontline maze 关卡评估共用一个口径等模块；`bot/cutoff.cjs` 专责截断（入侵截断 + 散兵单格/两格/三格组合截断 + 割点脖子纪律），`bot/movement-guard.cjs` 为移动护栏；`bot/campaign.cjs` 含浓缩突击（军力占优且出击兵力达决定性规模时 mode2 全冲压皇冠，带脖子截断风险检查与无状态止损，参数 `assaultMargin`/`megaStackMin`；与画圈推进（窄突出部先侧向扫一格把锋面涂成宽 2–3 连通块再前压，参数 `pushFrontWidth`）+ 锚点链（推进走廊按节奏/截断风险落指挥所保连通，参数 `anchorChainGap`/`anchorBuildEvery`；2026-09-27 第二轮加同 tick 预锚——走廊可被 1 tick 切断且大堆 ≥`preemptAnchorMinArmy` 时本 tick 不移动原地起锚，钱不够等 `preemptAnchorWaitTicks` 上限——与腾出格补锚——大堆推进后立即在原位置补锚，两动作不受节奏限制、policy 中压过截断/脖子纪律但让位背水/斩首；2026-09-28 起跳板推进常态化——rally 距最近己方皇冠 ≥`leapfrogMinDepth` 的深入长线推进把「走一步→腾出格补一座指挥所」作为默认节奏（不再要求切断风险，链距 `leapfrogChainGap`，钱不够原地等 `leapfrogWaitTicks` 凑钱，常态化期间不用 mode2 全冲；锚定距离场不查移动护栏的反向禁行边——这是此前补锚在 policy 管线里被卡死的主根因））；`bot/column.cjs` 敌方跳板纵队拦截（敌连通块深入我控区 ≥`columnMinDepth` 格且头部较上 tick 更近才出手：头自带建筑一律打头拆建筑、长纵队优先掐链（冻住 ≥`columnMinMass`）其次侧击腰部、短促自耗型迎头撞头部，出兵方案复用 cutoff 的 `planChokeAttack`；policy 中背水/告急与多路告急之下、普通推进之上）；`bot/frontline.cjs` 含 maze 拓展纪律（迷宫图拓展只派必要兵力、源点关卡贴敌不为拓展削弱咽喉，参数 `mazeMountainRatio`）与阶段化扩张-要塞方针（`fortressPhaseTurn` 起无要塞撑腰的薄皮中立扩张须够厚才拓、皇冠目标按 `lateTerritoryPerCrown` 提速，配套 `lateSkinMin`/`lateMaxCrowns`/`lateAnchorRadius`）与斩首攻冠兵力三级递升（2026-09-28 方针「三」：半兵推得下只出半兵 → 不够试智能全兵 mode0（就近合力、留守义务照算的智能分兵合力口径，余量 `crownSmartMargin`）→ 还不够才退真全兵 mode2（合力余量 `crownFullMargin`））；；此外仅有三处用户方针要求的跨回合防抖——frontline 斩首锁定（合力推皇冠的多 tick 连续攻击）、logistics 工地/集结点滞回（防目标每 tick 跳变来回倒兵）与 campaign 深入决心（已出击大堆 `campaignResolveTicks` 窗口内锁定同一皇冠方向，另一方向评分甩开 `campaignResolveMargin` 或形势剧变才解锁），均非旧版计划状态；2026-09-29 截断失灵根因修复 + 涂色/建造天平矫正：policy 涂色让位块（本 tick 推进只是中立涂色时非紧急截断/可负担建造/经济筹资依次压过涂色——根因是旧调度里非紧急截断只在 !canAdvance 时执行而被涂色无限期饿死；产能落后时经济紧急加 advanceIsPaint 条件把竞赛追赶做实）+ frontline 薄土涂色降权（中立涂色基础分 26→`paintValue`，到达兵力 <`paintThinArrive` 按差值 ×`paintThinPenalty` 扣分、负分中立候选跳过）；2026-09-29 追加方针「身后下刀」：入侵截断与纵队掐链的脖子候选按「比深入块更靠敌锚点一侧」加权（`cutoffBehindBonus`，敌锚点距离场口径），column 短促自耗型迎头撞带 `headOn` 标记、policy 层在截断模块有后方切断点时让位截断）+ 离线训练脚本（`training/`，不含生成物 results/）；入口 `bot.cjs`（CLI，`BOT_TOKEN` 鉴权、默认自动准备且 `BOT_AUTO_READY=0` 可关闭，`/ready`、`/room` 聊天命令控制），`bot/client.cjs` 的 `attachBot` 支持 `preferredTeam`/`autoReady` 初始选项；`server-bot.js` 为服务端托管适配入口（`attachStrategy` 映射为 `{roomName, preferredTeam, autoReady}`），托管启动自动准备并固定首选 2 队。人格层：`bot/client.cjs` 在组队模式下检测人类同队并自主避让换队（首选 2 队 → 最小编号空队 → 纯 bot 队，全满则按兵不动；人类侧不受任何限制）；`bot/trash-talk.cjs` 优势垃圾话（帝国时代 2 嘲讽风格文案库 ≥30 条分四档、多触发器独立冷却、全局冷却 + 每局上限 + 概率门控、wololo 彩蛋仅在对方领土单 tick 暴跌时触发且每局限 1 次）；`bot/surrender.cjs` 绝境投降（严重劣势 + 绝无胜算 + 对方活跃 + 调戏收尾四条全满足才发 GG 投降，独立可测））+ 推进方向纪律（threat.cjs 的 crownDistance 敌核心距离场 + frontline 方向加权/侧翼涂色降权，参数 pushDirectionWeight/flankPaintPenalty/paintDiscardDist）+ 建造阈值分级（architecture.cjs 的 locationRisk/buildFund/frontStable：大后方 rearBuildFund=100/前线 frontBuildFund=150/中间按敌距+威胁场过渡/绝境回落 100，位置不按出生点）+ 前线迁都（logistics 稳定前线格可作工地并获 frontBaseBonus）+ 集兵树形化（缺口 ≥bulkPullMin 时最远子树先动逐级汇聚、深后方大堆 ≥supplyTreeDepth 跳一次性拉出，一次性集满再造）+ 推进方向纪律（threat.cjs 的 crownDistance 敌核心距离场 + frontline 方向加权/侧翼涂色降权，参数 pushDirectionWeight/flankPaintPenalty/paintDiscardDist）+ 建造阈值分级（architecture.cjs 的 locationRisk/buildFund/frontStable：大后方 rearBuildFund=100/前线 frontBuildFund=150/中间按敌距+威胁场过渡/绝境回落 100，位置不按出生点）+ 前线迁都（logistics 稳定前线格可作工地并获 frontBaseBonus；2026-09-28 回调：后方优先、产能富余 frontBaseMinCrowns 后才启用前线选址，frontBaseBonus 下调至 10 且需自带资金/皇冠群撑腰；开局提速 earlyBuildTurns 内距离档按 earlyDistScale 收缩、前线阈值按 earlyFrontFundScale 下调，保底建造 earlyBuildTurns 内不贴敌 50 兵即开工）+ 集兵树形化（缺口 ≥bulkPullMin 时最远子树先动逐级汇聚、深后方大堆 ≥supplyTreeDepth 跳一次性拉出，一次性集满再造；2026-09-30 issue #70 maze 系统性弱点修复（56 败 42 场 maze，复盘 /root/antihuman-review.md）：defense 迷宫反应窗放宽 mazeDefenseHorizon/mazeRallyWindow + 贴境超大兵堆（≥megaStackMin/2）强制预置防线；cutoff 脖子纪律加 mazeNeckWarnRange 跳预警与主动夺备用连通格；frontline 咽喉留守推广到 enemy/city 推进（mazePushNeckKeep 硬下限，含 allInSafe 与消耗冲击）并放宽迷宫后期扩张 mazeLateAnchorRadius/mazeLateSkinMin；campaign 锚点门槛参数化 anchorMinArmy 且迷宫 1 格脖子即无条件落锚（含大堆脚下）；building 迷宫 clusterValue 改惩罚贴邻；policy 迷宫落后时经济让位更早更密；测试 test/maze-systemic.test.cjs；用法见包内 `USAGE.md`，测试 `node --test test/*.test.cjs`。

- **data/** — 全部运行时状态（gitignored）：`users.bin`/`feeds.bin`（v8+brotli）、`announcement.json`、`server-bots.json`（托管策略 bot 重启自动恢复状态：{username, room, template, allowTeam, allowFog, allowMultiLine} 列表）、`replays/*.rpl`（+ 观看缓存 `*.rpb.gz`、`index.bin`）；各数据文件写入时自动生成同名 `.bak` 上一代备份（损坏回退用，issue #67）。

---

## 常见任务速查

| 要做什么                         | 动哪里                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 调平衡数值（AFK/掉线/孤军/增兵） | `src/game-engine/constants.ts`、`tick-growth.ts`                                                                                                                                                                                                         |
| 改对局规则（战斗/连通/投降）     | `src/game-engine.ts`（+ 教程复刻 `static/tutorial.js`）                                                                                                                                                                                                  |
| 改 socket 协议/格子编码          | `src/types.ts`、`src/game-engine/map-encoding.ts`、`src/server.ts`、`src/server/lobby-service.ts`；同步 `static/develop-bot.html`、`bot-template/`、`static/main/*`                                                                                      |
| 改回放格式                       | `src/replay-patch-binary.ts`（编码，升魔数）+ `static/main/replay-binary.js`（解码）+ ops-v1 互逆对 `src/game-engine/replay-turns.ts` ↔ `replay-scheduling.ts`                                                                                           |
| 加/改 REST API                   | `src/server.ts`（路由集中在此；注意限流与认证钩子）                                                                                                                                                                                                      |
| 改房间/断线/重连逻辑             | `src/server/lobby-service.ts` + `src/game-engine.ts`（宽限三件套）                                                                                                                                                                                       |
| 改公告/动态渲染                  | `src/text-render.ts`（同一管线；加 KaTeX 标签需同步白名单）                                                                                                                                                                                              |
| 改 @提及（解析/补全/渲染）       | `src/mentions.ts`（解析+HTML 渲染）、`src/feed-store.ts`（落库）、`src/server.ts`（装饰 + `/api/users/search`）、`static/mention-autocomplete.js` + `static/styles/base.css` + `static/index.html`/`profile.js`（补全接入）                              |
| 改 Rating/段位                   | `src/auth-store.ts`（分数）、`src/rating-color.ts` + `static/styles/rating.css`（颜色）                                                                                                                                                                  |
| 改地图生成                       | `src/map/`（公共件在 map-core.ts；尺寸比例在 map-size.ts）                                                                                                                                                                                               |
| 改对局页渲染                     | `static/main/render-update.js`（帧合并）、`static/styles/map.css`（视觉）                                                                                                                                                                                |
| 改首页 feed/公告样式             | `static/styles/home.css` + `static/styles/profile.css`（双改）                                                                                                                                                                                           |
| 部署/自动更新                    | `src/server/webhook-updater.ts`（排队状态机/宽限清算/dry-run）+ `src/server/lobby-service.ts`（updateQueued/清算入口）+ `src/game-engine.ts`（forceFinish）+ `static/sw.js`/`updating.html`（SW 更新页）+ `.github/workflows/bump-version-and-merge.yml` |

- **scripts/test-ready-counts.mjs** — `pnpm run test:ready-counts`（纳入 `pnpm test`）：真实 LobbyService 分组门槛、偶数组、观战排除、room_update/房间列表计数、执行等待房渲染分支检查双计数与精确按钮文字、三档房主稳定排序。

## 对外 API 唯一契约（2.0）

房间查询使用 `GET /api/rooms`；首页为 `/`。实时移动必须提供数值 `mode`，队列操作不接受 `line`；出队确认仅下发 `lst_moves` 序号数组，重连通过 `init_map.next_seq/queue_ops` 恢复。返回房间事件为 `return_room`。房间快照和列表的准备门槛仅使用 `ready_counts`。地图区域请求仅接受现行 `MapRegion`，旧地区转换保留在内部回放读取。部署入口只接受 JSON 与 GitHub HMAC 签名。未知路径返回 404。`scripts/test-api-contract.mjs` 覆盖淘汰接口与当前契约的端到端回归。

- `src/game-engine.ts`：`isolatedReinforced` 记录本次孤军周期是否接兵，新局通过 `isolated_reinforcement_fix` meta 启用重连翻倍抑制，旧 ops-v1 缺省沿用历史规则。
- `scripts/test-isolated-reinforcement.mjs`：真实引擎接兵/重连/生命周期回归，纳入 `pnpm test`；`scripts/audit-isolated-replay.cjs`：只读原始 ops 对照审计。

- 逐文件 CDN 回归：`scripts/test-per-file-cdn.mjs` 使用真实临时 Git 历史检查独立版本与安全回源；`scripts/test-css-per-file-cdn.mjs` 用浏览器检查嵌套 CSS、字体、图片与运行时 import/fetch 的逐文件候选。
