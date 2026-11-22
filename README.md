<p align="center">
  <img src="static/icons/icon-192.png" alt="Roka" width="96" />
</p>

# Roka

Roka 是一个实时方格领土战争游戏，玩法类似 generals.io。玩家扩张领土、建设主城与指挥所，在 FFA 或组队对局中攻占敌方主城并存活到最后。

项目使用 TypeScript、Fastify 和 Socket.IO 构建服务端，前端以原生 JavaScript 为主。对局由服务端按 Tick 结算，支持断线重连、观战和完整回放。

## 主要功能

- 实时 FFA 与组队对局，多种地图、地图尺寸、随机种子和可选迷雾视野。
- 用户注册登录、Rating、积分、个人主页、动态、评论和推广大使。
- 房间聊天、实时在线状态、浏览器通知和管理员后台。
- 对局回放观看、下载、本地上传，以及按用户和日期查询历史回放。
- GitHub 绑定与 Star 金色前半名；关于页公开展示贡献者和全部 Star 支持者。
- 可独立运行或由服务端托管的策略 Bot，协议说明见 `/develop/bot`。
- 首次访问介绍片、静态资源 CDN 与故障回源。

## 本地开发

需要 Node.js，并使用仓库声明的 pnpm 版本。首次运行：

```shell
corepack enable
pnpm install
pnpm run dev
```

开发服务默认监听 `http://localhost:23333`，开发模式默认使用同源静态资源。

构建并启动生产服务：

```shell
pnpm run build
pnpm run start
```

`pnpm run build` 会先用 Pug 将 `views/` 中的页面模板渲染到 `static/`，再构建介绍片和 TypeScript。`static/` 下全部 13 个 HTML 页面均由 `views/` 中的同名 Pug 模板生成，HTML 不作为手工维护源。

共享 Header 仅用于 about、ambassadors、login、develop、develop-bot 五页。index、game、tutorial、tutorial-text、replays 保留各自专用布局与控件；profile、admin、updating 也使用各自的专用或独立结构，以上页面均不加载共享 Header。

运行数据默认保存在 `data/`。环境配置示例见 `.env.example`；常用变量包括：

- `PORT`：HTTP 监听端口。
- `ROKA_DATA_DIR`：运行数据目录。
- `ROKA_STATIC_CDN=0`：关闭静态资源 CDN，使用同源资源。
- `ROKA_REPLAY_VIEW_CACHE_MAX_AGE_MS`：观看缓存保留时间，默认 1 天。
- `GITHUB_STARGAZERS_TOKEN`：历史配置，当前 Star 服务只读本地表和接收 webhook，不使用此 token 或发起抓取。

## GitHub Star 与支持者墙

服务启动仅加载 `data/github-stargazers.json` 本地持久表，不访问 GitHub、不安排失败重试，也不批量回写用户字段。GitHub `star` webhook 复用 `POST /postreceive` 和原有 HMAC 签名，实时处理加星、退星并更新已绑定用户。OAuth 绑定只查询这张本地表；个人主页不自动刷新，也不提供手动刷新按钮或接口，不再逐用户请求 GitHub Star API；表尚未就绪时保持未知状态，不写入新的核验结果。

游客可访问 `GET /api/stargazers`，返回 `{items, fetchedAt}`。关于页的贡献者墙与 Star 支持者墙共用自适应卡片网格，空表会显示支持者招募提示。

## 后台安全审查

后台默认展示仪表盘，并提供用户管理、安全风险、聊天审计和仅超管可见的策略 Bot 标签。用户名在注册成功后核查，命中仅写待人工复核事件；允许创建账号，不自动封禁或清除会话。无启动或周期审核。用户注册 IP、最近 IP 与最多 20 条 IP 历史仅通过管理员 API 返回。同 IP 永久封禁关联只进入人工复核，不自动连坐；同一真实 IP 滚动 24 小时最多成功注册 30 个账号，后续注册拒绝 24 小时。安全事件保存在 `data/security-audit.json`，最多 2000 条且不超过 2 MiB。

管理员安全接口为 `GET /api/admin/security/dashboard`、`GET /api/admin/security/events` 和 `POST /api/admin/security/scan`，均要求管理员权限并返回 `Cache-Control: no-store`。

## 检查与测试

提交前运行：

```shell
pnpm run lint
pnpm run build
pnpm run format
```

完整服务端与浏览器回归测试：

```shell
pnpm test
```

常用单项测试：

```shell
pnpm run test:bot
pnpm run test:github-link
pnpm run test:replays-page
pnpm run test:replay-cache
pnpm run test:guest-access
pnpm run test:build-pages
```

`test:build-pages` 覆盖全部 13 页的同名 Pug/HTML 集合、连续构建字节一致性、关键 DOM 与脚本顺序，并断言共享 Header 只出现在指定五页，其余八页保留专用控件且不加载共享 Header 资源。

部分浏览器测试需要 Playwright 和 Chromium，可通过 `ROKA_PLAYWRIGHT_MODULE` 与 `CHROMIUM_PATH` 指定已有安装。

## 回放查询与缓存

`/replays` 是公开回放查询页。游客可查看最新 10 条回放，或按用户名、日期范围查询；查询结果每页 50 条，条件和页码保留在地址栏。对局结算后页面会通过 socket 在两秒节流后刷新当前视图，连接失败不影响手动查询。登录后可上传 `.rpl` 文件观看。

`GET /api/replays` 支持 `offset`、`limit`（最多 50）以及可选的 `username`、`from`、`to`。时间参数使用 Unix 秒并包含端点；响应中的 `total` 是过滤后、分页前的记录数。

原始 `.rpl` 操作流永久保留。观看用的 `.rpb.gz` 是派生缓存，命中时刷新最近使用时间，服务启动及每 24 小时清理超过保留期的缓存，不删除原始回放或索引。

## 项目结构

- `src/`：TypeScript 服务端、游戏引擎和持久化存储。
- `views/`：Pug 页面模板，构建期生成 `static/` 下对应 HTML。
- `static/`：网页、客户端脚本与样式。
- `scripts/`：构建工具、 fixtures 和回归测试。
- `bot-template/`：可独立运行或服务端托管的 Bot 模板。
- `MAP.md`：项目结构与关键实现索引。

各 Bot 的安装和运行方式见对应目录下的 `README.md` 或 `USAGE.md`。

### Relay 策略 Bot

管理员可在「策略 Bot」选择 `relay-bot`，按房间需要允许迷雾和多线。单线模式下，第 26–50 Tick 正常普通领土每 Tick 额外 +1 兵，第 50 Tick 连同基础增兵合计 +2；Relay 会优先扩张以利用爆发期。多线模式没有爆发期，第 50 Tick 仅有基础增兵 +1；Relay 按此推算兵力，逐 Tick 组合独立指令。接敌后两种模式都兼顾攻城路线、主城来兵和补给线上的关键格，迷雾下记录曾经发现的主城。

原始操作回放（`ops-v1`、`ops-v2`）一律按当前地图和对局规则重建，不模拟历史版本。旧多线回放同样没有爆发期；若已记录的操作按当前规则无法执行（例如兵力不足，或使用已移除的显式主城转让），该回放判为不兼容。已编码的观看帧无需重新模拟。

默认的全视野单线房间在收到首帧时，规划到第 12 回合（Tick 24）的等待、出兵和汇兵顺序。目标是扩大领地，面积相同时优先普通地和敌军较难抵达的方向。逐 Tick 校验路线，敌军威胁主城或补给线时可中断计划。单线搜索同时计算占地上界，四倍速房间使用较小的计算预算。多线开局会比较同一 Tick 能并行执行的扩张路线。

建指挥所、升主城和调兵筹款会估算可见敌军穿过弯道、沿途汇兵后抵达的兵力。守路的驻军付完 50 兵仍能挡住这波进攻，才在该格动工。接敌后按各方产量、侧翼、补给和断线兵团规模决定进攻或救援，FFA 也会计入其他边界的压力。

在仓库根目录安装依赖后，可通过 `BOT_ROOM=房间号 BOT_TOKEN=令牌 pnpm run bot:relay` 独立运行。设置 `BOT_ONCE=1` 后，Bot 完成一整局便断开连接并退出，不会重新准备；被淘汰后仍等待整局结束。`BOT_SERVER` 默认为 `http://127.0.0.1:23333`，组队时可用 `BOT_TEAM` 选择 1 至 16 队。托管权限与第三方令牌的房间限制见游戏内机器人开发协议。

开局搜索按剩余 Tick 裁剪棋盘。执行已缓存的路线时，只有出现接敌风险才检查补给截断。标准图明牌单线会按实际调兵量评估增援：一小队兵只对大兵堆贡献很少时，优先考虑其他行动；来兵能保住主城或凑齐建造费用时，保留增援的优先级。

运行 `pnpm run test:relay` 检查协议与策略。当前结果见 [2.16.1 耗时与换边评测](bot-template/relay-bot/TEMPO.md)。历史结果见 [2.16.0 开局与峡谷评测](bot-template/relay-bot/OPENING.md)、[2.15.0 明牌单线与 FFA 评测](bot-template/relay-bot/SINGLE-LINE.md)及 [2.14.0 初版评测](bot-template/relay-bot/EVALUATION.md)。

### Bot(3.0) 策略 Bot

Bot(3.0) 以 Relay 为基础框架，参考 Bot(2.0) 的 1v1 结构，目标是在官方小图上继续提升实战胜率。首个提交是 Relay 2.16.0 策略的完整副本，目录名 `bot-3.0` 会被后台托管模板自动发现。

基线使用真实引擎跑满 2048 局：Apex / Anti-Human / Bot(2.0) / Relay 四个对手，随机、迷宫、群岛、地中海四种地图，迷雾与多线各开关，每格 32 局、上限 1000 Tick，合计 1490 胜 / 424 负 / 134 超时，胜率 72.8%。逐项数据与复现命令见 [Bot(3.0) 基线](bot-template/bot-3.0/BASELINE.md)。

独立运行：`BOT_ROOM=房间号 BOT_TOKEN=令牌 pnpm run bot:bot3`；回归：`pnpm run test:bot3`；验收矩阵：`pnpm run eval:bot3`。

## 许可

本项目以 [AGPL-3.0-only](LICENSE) 许可开源。

### 注册、动态与评论事件核查

注册成功后核查用户名；动态创建、编辑及评论创建成功落盘后核查该次正文。命中只写后台待人工复核事件，无命中不产生告警。读取、点赞、删除、重启不触发核查；没有启动/六小时扫描、游标或手动全量扫描接口。用户名格式、长度与 IP 注册限流仍有效；人工封禁和删除能力保留，审核不会自动封禁、清会话、删帖、隐藏或扣分。

词表保留中文、英文边界与拼音/leetspeak 匹配，正常名字、grape、Scunthorpe 和代码标识符有反例测试。审计为 0600、最多 2000 条/2 MiB，正文证据只在管理员 no-store API 可见。旧扫描/封禁历史仍可查询。`pnpm run test:content-moderation`、`test:admin-security`、`test:admin-security-ui` 验证事件触发、注册成功、会话保持、权限与桌面/手机渲染。

### Star 用户外观与冷启动

`UserStore.getPublicAppearance()` 同步读取 users.bin 中的 `github.starred === true`，公开外观总是返回布尔值。`starVerifiedAt/starState` 只表示个人页核验新鲜度，过期不清除金色。启动只读取本地 Star 持久表，不抓取、不重试、不对账或回写用户字段。已绑定用户的 starred 仅由 GitHub webhook created/deleted 更新；初次 OAuth 绑定读取已有本地表，无按需网络抓取。排行榜、在线、动态/评论、搜索、个人页、`/api/user-colors` 共用该字段；房间、对局及回放旧协议通过统一批量补色接口读取。

用户名 DOM/HTML 渲染共享拆分函数，前 `floor(username.length / 2)` 个 ASCII 字符染金，其余继承 rating、管理员或封禁颜色；显式 false 清除缓存金色。保留 `.username-star-initial` 类名兼容既有样式。`pnpm run test:github-link` 覆盖持久化过期状态、重启、启动 fetch=0、无 retry timer、无用户字段回写、webhook、首页无个人页前置请求、前半名长度与 1440/390 浏览器检查。

### 多设备 session 与活动标签页互斥

每次登录新增独立 sid，创建时间起七天到期；JWT exp 与服务端持久化过期时间双重校验。设备关闭标签页不会删除 session，重新打开可继续登录。logout 只删除当前 sid；封禁清空该账号所有 session。旧单 sid 数据在读取时迁移，原 JWT 有效期仍限制实际可用时间；服务端在加载、校验、登录及每分钟自然清理时删除过期记录。

登录或建立真人首页/游戏 Socket 时，只撤销同账号其他 sid 的活动连接所对应的 session。没有活动连接的设备 session 保留；同 sid 首页/游戏标签及普通重连不会被当作另一设备。旧活动端先收到 `force_logout`（`reason: new-login`）再断开，停止重连并整页刷新；已撤销 sid 的 API 401、握手拒绝与下次页面加载兜底，避免旧页反踢循环。Bot 不参与真人 session 活动互斥。

`pnpm run test:session-takeover` 包含存储迁移/七天过期/定向退出/封禁单测，以及真实 HTTP 与双 Chromium context：关页保留、重新打开、跨 sid 首页/游戏冲突、两旧页实际导航、旧 cookie 401、新端 200、同 sid 重连与 logout 隔离。验证码服务在专项测试中固定通过，登录/会话/socket/页面均为真实实现；纳入 `pnpm test`。

## 回放与首屏加载动画

未知回放大小时，加载条从轨道左侧进入，向右横贯后离开并循环；已知大小时左缘固定，按百分比向右增长，下载结束显示 100%。CDN 首屏样式准备期间显示 CSS 旋转圆环和「Roka 加载中…」，样式就绪后一起移除。减少动态效果模式使用静态指示。

`pnpm run test:replay-loading-ui`（纳入 `pnpm test`，需先构建）使用真实 Chromium，在 1440/390 视口测量 0/25/75/100% 几何位置、单周期动画相位、状态切换、首屏旋转和移除、布局溢出与脚本错误。先运行 `pnpm exec playwright install chromium` 准备浏览器；可用 `ROKA_PLAYWRIGHT_MODULE` / `CHROMIUM_PATH` 指定浏览器依赖，`ROKA_LOADING_OUTPUT=<仓库外目录>` 导出测量 JSON。
