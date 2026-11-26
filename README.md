<p align="center">
  <img src="static/icons/icon-192.png" alt="Roka" width="96" />
</p>

# Roka

Roka 是一个实时方格领土战争游戏，玩法类似 generals.io。玩家扩张领土、建设主城与指挥所，在 FFA 或组队对局中攻占敌方主城并存活到最后。

项目使用 TypeScript、Fastify 和 Socket.IO 构建服务端，前端以原生 JavaScript 为主。对局由服务端按 Tick 结算，支持断线重连、观战和完整回放。

## 主要功能

- 实时 FFA 与组队对局，多种地图、地图尺寸、随机种子和三种迷雾模式（默认正常）。
- 实时对局用方向键移动光标、用 WASD 推兵。数字编队 0–19 仅在当前对局有效，多线争锋支持多选与同步推兵。快捷键见 `/tutorial`。
- 实时对局的第 26–50 Tick 爆发期红框只在单线显示；多线争锋无爆发期，不显示红框。
- 孤军格恢复连通时，仅当前兵力大于 1 且本次孤军期间未接兵的格子翻倍；1 兵保持为 1，已接兵格保持当前兵力。
- 用户注册登录、Rating、积分、个人主页、动态、评论和推广大使。
- 房间聊天、实时在线状态、浏览器通知和管理员后台。
- 对局回放观看、下载、本地上传，以及按用户和日期查询历史回放。
- GitHub 绑定与 Star 金色前半名；关于页公开展示贡献者和全部 Star 支持者。
- 可独立运行或由服务端托管的策略 Bot，协议说明见 `/develop/bot`。
- 首次访问介绍片、静态资源 CDN 与故障回源。

## 峡谷回廊

迷宫模式按实际参赛人数一并生成走廊、主城和沼泽。它在多张带环路的连通迷宫中选址，尽量避开死端，并在保留交战间距的前提下优先改善最弱玩家半径 6、10 步内的产兵平地。领地按到主城的最短路划分，并列格等分；沼泽优先放在远离开局扩张范围、平地份额较多的区域。最终主城位置经独立的种子洗牌才分给座位。

迷宫只保留当前的生成与初始化路径，不为旧算法或旧录像保留兼容副本、版本标记或双路径。实时对局与操作回放使用相同的地图生成和座位分配规则；操作回放直接按当前规则重建。已编码的观看帧、其它地图和房间设置不变。

`pnpm run test:maze-fairness` 运行专项回归（也包含在 `pnpm run test:map-generation` 和 `pnpm test` 中）。使用 `pnpm exec tsx scripts/evaluate-maze-fairness.mjs /tmp/maze-final.json /tmp/maze-baseline.json` 对照基线；不传基线即可生成基线 JSON。两次均通过引擎和房间尺寸规则测量 2–16 人、标准与 large、每档 24 个固定种子。

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

构建后可用 `pnpm run test:cursor-control-groups` 单独验证对局光标、编队和文字教程。

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

手机回放保留参赛者标题、可滚动的排行榜和兵力/领土走势图；可用触摸或鼠标拖动图表跳转进度，地图不会跟随移动。只有从地图或地图背景开始的手势才能平移或缩放地图。

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

### Apex 与 Relay 策略 Bot

管理员可在「策略 Bot」选择 `apex-bot` 或 `relay-bot`，按房间需要允许迷雾和多线。升级后，旧的托管配置会自动恢复到对应的现行模板，已保存的房间和权限保持不变。

- [Apex](bot-template/apex-bot/README.md)：基于原 Bot 2.0 的战役策略，结合战术斩杀、经济竞赛和大图突击，保留 Apex 的多线队列支持。运行 `BOT_ROOM=房间号 BOT_TOKEN=令牌 pnpm run bot:apex`；回归 `pnpm run test:apex`；真实引擎评测 `pnpm run eval:apex --help`。
- [Relay](bot-template/relay-bot/README.md)：基于原 Bot 3.0 的小图策略，加入迷宫走廊、迷雾侦察和多线搜索，保留裁剪棋盘的开局搜索与增援定价。运行 `BOT_ROOM=房间号 BOT_TOKEN=令牌 pnpm run bot:relay`；回归 `pnpm run test:relay`；构建后通过 `pnpm run eval:relay` 跑真实引擎换边矩阵。`BOT_ONCE=1` 让 Relay 等整局结算后退出，即使中途被淘汰也会等到结算。

两者均默认连接 `http://127.0.0.1:23333`，可用 `BOT_SERVER` 覆盖。Relay 的[原始 2048 局数据和复现条件](bot-template/relay-bot/BASELINE.md)是历史基线，并非整合后重新测得的成绩。

### 迷雾与回放

房间设置 `fog_mode` 依次为 `normal`（正常，默认）、`explored`（已探索）和 `visible`（全部可视）。队友共享视野；连接正常的己方格子看周围一圈，断联格只看自身。正常模式的深灰格未探索，不下发地形；浅灰格已探索但在视野外，只显示自然山脉、沼泽，不保留建筑、归属与兵力。已探索模式从开局就显示视野外的自然地形。含不支持迷雾的 Bot 时，只能选择全部可视。

4.0.0 直接替换回放协议：原始 `ops-v3` 存成功操作与队伍首次探索增量，服务端按同一套实时规则重建并校验；观看格式 `RPB5` 存全知棋盘和服务端记录的可见性时间线，支持任意 Tick 切换队伍视角，不需从头累计探索。旧原始格式和旧观看格式不再接受，访问失败不会删除原始存档。

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

`pnpm run test:replay-mobile`（纳入 `pnpm test`，需先构建）在 Chromium 中加载真实回放页面与测试回放，验证窄屏与旋转布局、连续触摸操作、图表拖动与取消、地图平移与双指缩放，以及桌面布局和部署横幅避让。浏览器配置与回放加载测试相同。
