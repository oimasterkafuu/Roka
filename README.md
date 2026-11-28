<p align="center">
  <img src="static/icons/icon-192.png" alt="Roka" width="96" />
</p>

# Roka

Roka 是一个实时方格领土战争游戏，玩法类似 generals.io。玩家扩张领土、建设主城与指挥所，在 FFA 或组队对局中攻占敌方主城并存活到最后。

项目使用 TypeScript、Fastify 和 Socket.IO 构建服务端，前端以原生 JavaScript 为主。对局由服务端按 Tick 结算，支持断线重连、观战和完整回放。

## 主要功能

- 实时 FFA 与组队对局，多种地图、地图尺寸、随机种子和三种迷雾模式（默认正常）。
- 可见的中性沼泽使用比空地略亮的浅灰底；已占领的沼泽保留玩家配色，视野外仍按原迷雾样式显示。
- 实时对局用方向键移动光标、用 WASD 推兵。数字编队 0–19 仅在当前对局有效，多线争锋支持多选与同步推兵。快捷键见 `/tutorial`。
- 实时对局的第 26–50 Tick 爆发期红框只在单线显示；多线争锋无爆发期，不显示红框。
- 孤军格恢复连通时，仅当前兵力大于 1 且本次孤军期间未接兵的格子翻倍；1 兵保持为 1，已接兵格保持当前兵力。
- 用户注册登录、Rating、积分、个人主页、动态、评论和推广大使。
- 房间聊天、实时在线状态、浏览器通知和管理员后台。
- 对局回放观看、下载、本地上传，以及按用户和日期查询历史回放。
- GitHub 绑定与 Star 金色前半名；关于页公开展示贡献者和全部 Star 支持者。
- 可独立运行或由服务端托管的策略 Bot，协议说明见 `/develop/bot`。
- 含官方托管 Bot 的房间可选择「正常」或「简单」AI 难度。
- 首次访问介绍片、静态资源 CDN 与故障回源。

## 峡谷回廊

迷宫模式按实际参赛人数一并生成走廊、主城和沼泽。它在多张带环路的连通迷宫中选址，尽量避开死端，并在保留交战间距的前提下优先改善最弱玩家半径 6、10 步内的产兵平地。领地按到主城的最短路划分，并列格等分；沼泽优先放在远离开局扩张范围、平地份额较多的区域。最终主城位置经独立的种子洗牌才分给座位。

迷宫只保留当前的生成与初始化路径，不为旧算法或旧录像保留兼容副本、版本标记或双路径。实时对局与操作回放使用相同的地图生成和座位分配规则；操作回放直接按当前规则重建。已编码的观看帧、其它地图和房间设置不变。

`pnpm run test:maze-fairness` 运行专项回归（也包含在 `pnpm run test:map-generation` 和 `pnpm test` 中）。使用 `pnpm exec tsx scripts/evaluate-maze-fairness.mjs /tmp/maze-final.json /tmp/maze-baseline.json` 对照基线；不传基线即可生成基线 JSON。两次均通过引擎和房间尺寸规则测量 2–16 人、标准与 large、每档 24 个固定种子。

## 超级随机

房主选择「超级随机」（`mega_random`）后，种子从 16 个地形族中等概率抽取一个。除原有的平原、岛屿和多桥等地形，还可能抽到逐格分布山地与沼泽的「标准散点」，或有连续山墙及宽通道的「峡谷成廊」。房间不会预告抽签结果。山地不可通过；沼泽可通过，没有资源或开局奖励。

生成器只在实际空地内补地形：逐一打散全普通地的 7×7 方块，以及宽 6 格、长 14 格的横向或纵向空带。补入的小片山地或沼泽周围留出两格绕行空间，渡口保持可通行。山区更常长出山块，水系更常形成湿地；狭窄的峡谷回廊不因长度而被填塞。潮岛、护城河和平行地带的轮廓也会随种子偏移。同族重排仍按这些规则生成，不会回退到无障碍平原。

实际地形确定后，出生点从各分区全部合格格随机抽取，再按步行距离筛选，保持扩张空间、沼泽负担、最近敌距和普通地领地公平。个人岛间要涉沼，队伍岛把相邻的队友分区连成陆地；曲流和三陆的每组渡口不能由同一人全部独占先到。固定种子、人数、尺寸和队伍配置可重现同一开局；公开示例、实战及 RKL1 回放共用引擎生成路径。

`pnpm run test:mega-random` 在真实引擎初始棋盘上验证标准和大图的 2–16 人开局：每族 108 张，共 1,728 张。逐图测量最大全平原正方形和矩形，另把皇冠也当平地，检查每个 7×7 区域确有山或沼泽。同族、同人数、同尺寸的种子两两比较内部障碍位置，忽略地形换色、旋转和镜像。峡谷另测连续山墙和两侧夹墙的可通行回廊，沿用全图可达与皇冠检查。专项还复测宽高比例均为 0.34 的 8、12、16 人小图，含旧开局仅距 6 步的 `cramped-crowns-16-0`。逐族指标、峡谷种子证据和 16 张 ASCII 预览写入 `/tmp/roka-mega-random/`。

常规候选用尽时，超级随机按原地形族和各队人数，在对应人数的大图尺寸上确定性重排，使用相同的公平性与间距校验。修改地形、选位或限次重试逻辑后，运行 `pnpm exec tsx scripts/check-crown-repacking.mjs` 穷举超级随机重排的 16 个地形族 × 913 种队伍组合；也可在命令末尾指定要检查的地形族。

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

文字教程的地图示例仅在中国时区 10 月 1 日至 7 日将「华夏系列」加入地图类型下拉框。页面每分钟检查一次；活动结束时若仍选中华夏，会切回标准地图并隐藏地区控件。活动期外直接请求华夏示例仍返回 403。

运行数据默认保存在 `data/`。环境配置示例见 `.env.example`；常用变量包括：

- `PORT`：HTTP 监听端口。
- `ROKA_DATA_DIR`：运行数据目录。
- `ROKA_STATIC_CDN=0`：关闭静态资源 CDN，使用同源资源。
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
pnpm run test:fog
pnpm run test:replay-controls
pnpm run test:replay-mobile
pnpm run test:guest-access
pnpm run test:build-pages
pnpm run test:mega-random
```

`test:build-pages` 覆盖全部 13 页的同名 Pug/HTML 集合、连续构建字节一致性、关键 DOM 与脚本顺序，并断言共享 Header 只出现在指定五页，其余八页保留专用控件且不加载共享 Header 资源。

构建后运行 `pnpm run test:tutorial-huaxia-option`，在真实 Chromium 中验证文字教程华夏下拉选项、活动边界回退和地图渲染。

部分浏览器测试需要 Playwright 和 Chromium，可通过 `ROKA_PLAYWRIGHT_MODULE` 与 `CHROMIUM_PATH` 指定已有安装。

## 回放查询与缓存

`/replays` 是公开回放查询页。游客可查看最新 10 条回放，或按用户名、日期范围查询；查询结果每页 50 条，条件和页码保留在地址栏。对局结算后页面会通过 socket 在两秒节流后刷新当前视图，连接失败不影响手动查询。登录后可上传 `.rpl` 文件观看。

手机回放保留参赛者标题、可滚动的排行榜和兵力/领土走势图；可用触摸或鼠标拖动图表跳转进度，地图不会跟随移动。只有从地图或地图背景开始的手势才能平移或缩放地图。

`GET /api/replays` 支持 `offset`、`limit`（最多 50）以及可选的 `username`、`from`、`to`。时间参数使用 Unix 秒并包含端点；响应中的 `total` 是过滤后、分页前的记录数。

观看与下载下发同一份不可变 `.rpl`；上传校验成功后原样返回，不转码。IndexedDB v6 条目只缓存原档，worker 负责解码、从种子重建地图、逐 Tick 重放和终局校验。首见、队伍视野、最后所见建筑、排行榜和棋盘均不存盘。客户端生成可逆差分、建筑/视野变化索引和稀疏检查点；跳转从较近的当前帧或检查点开始。服务端不保存观看副本。旧文件不兼容，不转换。

### RKL1 文件布局

数字默认无符号；定长多字节字段小端，`U` 为最短 ULEB128（最多 5 字节）。所有计数、坐标、长度、枚举和 EOF 都要校验。

1. **头**：`52 4b 4c 01`、布局标志 1 字节、`U(meta 字节数)`、meta、操作流，最后固定 26 字节 CHECK。布局 bit0=全局按 Tick（否则按席位）；bit1=坐标预测；bit2=整段操作流 raw DEFLATE；bit3=标签分栏。编码器实编各组合，取字节数最小者；并列保留先尝试者（按 bit3、bit1、bit0、bit2 从外到内各从 0 到 1）。
2. **Meta**：地图、地区、规则各 1 字节。地图枚举 `random/maze/archipelago/mediterranean/huaxia/mega_random`，地区 `china/qin/han/tang/liao/song/yuan/ming/taiwan`；规则低两位 `normal/explored/visible`，bit2–5 分别为组队、多线、大图、简单 AI。宽比、高比、沼泽比、速度依次为一字节百分数（0–253）或 `ff` + float64。字符串表为 `U(条数)` + 若干 `U(UTF-8 字节数)` 和字节；首项地图 token，各席位存 `U(名字索引), U(队号×2+托管位)`。城市/山地比例由种子派生。
3. **操作**：控制流先写 `U(投降数)`，每项 `U(已完成 Tick), U(零基席位×2+阶段)`，同 Tick 保留实盘顺序；阶段 0 是该 Tick 连通后 AFK，1 是 Tick 间的手动/离开。按席位布局先写各席位的非空批次数，再逐席位写 `U(距该席上批的空 Tick 数)`；全局布局逐批写 `U(Tick 增量×席数+席位)`。前一 Tick 初值 0。多线批次另写 `U(动作数−1)`，单线隐含 1。尾部等待由总 Tick 推导。
4. **动作**：`cell=row×cols+col`，原点可写绝对格号，或相对该席上个动作终点（建造为原点，初值 0）的 ZigZag 增量。标签 0–11=`mode×4+方向`，方向依次上、下、左、右；12/13=建造/升级。交错布局写 `U(坐标码×16+标签)`；分栏布局为 `U(控制流长度) + 控制流 + ceil(动作数/2) 字节标签 + 坐标 U 序列`，先低半字节，奇数个标签最后高半字节为 0。
5. **尾帧**：ASCII `CHECK`，依次 `u32 总 Tick, u8 席数, u16 行, u16 列, u32 动作数, u32 终局 CRC, u32 文件 CRC`。CRC-32/IEEE；文件 CRC 覆盖除自身外全部字节。终局 CRC 输入为 Tick、行优先全量 `grid_type/army_cnt/isolated`、依榜单次序的 `id/team/army/land/dead`，每值 `u32le`。ID 另取整档 SHA-256 前 9 字节 Base64（`/` 换 `-`），读取时验证。CRC 检测损坏，不是签名。

文件及解压操作流上限各 8 MiB、50 万动作、20 万 Tick、65,535 格。观看端按变化量计费，超过 96 MiB 估算预算会明确拒绝；检查点间距至少 64 Tick，随地图和局长扩大。预算不等于进程 RSS。运行 `pnpm run build` 后，用 `pnpm run test:rpl`、`pnpm run test:fog`、`node scripts/test-multiline-replay.mjs --browser` 验证；`node scripts/bench-rpl.mjs .` 输出分布基准 JSON。

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

### AI 难度

含官方托管 Bot 的房间中，房主可在开局前更改 `ai_difficulty`：`normal`（正常，默认）或 `simple`（简单）。所有托管模板均适用；房间重置后回到正常。简单模式只让官方托管席位的皇冠由每 Tick +1 改为偶数 Tick +1。普通地块的第 26–50 Tick 爆发、指挥所、人类和第三方 Bot 均不受影响。

每局按照开局时确定的难度和托管席位结算。简单局的 Elo 期望值使用官方托管 Bot 的有效 Rating「原始分减 400、最低 0」；档案只结算比赛本身的分差，排行榜不展示这个临时扣减。开局、重连和观战的 `init_map` 与原始 `RKL1` 回放都记录难度和托管席位（从 1 开始，对应 `player_ids`／`player_names` 的顺序）。构建后运行 `pnpm run test:ai-difficulty` 可验证引擎、房间、回放和 Rating；也可用 `pnpm run test:ai-difficulty-room` 单独验证房间流程。

### 迷雾与回放

房间设置 `fog_mode` 依次为 `normal`（正常，默认）、`explored`（已探索）和 `visible`（全部可视）。队友共享视野；普通己方格提供 3×3 视野，己方指挥所和主城提供 5×5 视野，断联格只看自身。正常模式的深灰格未探索；浅灰格保留自然地形和最后看见的建筑符号、归属色，但不显示兵力或实时状态，重新可见时才按当前状态刷新或清除。已探索模式从开局就显示视野外的自然地形。含不支持迷雾的 Bot 时，只能选择全部可视。

迷雾回放支持队伍视角切换、前进、后退、自动播放和跳转，并按当时视野显示实时或最后所见建筑。

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

`pnpm run test:swamp-background`（纳入 `pnpm test`，无需构建）在桌面和手机视口加载真实棋盘样式，检查中性沼泽、空地及玩家沼泽的底色，并确保沼泽本身没有阴影或滤镜。浏览器配置与回放加载测试相同；可用 `ROKA_SWAMP_OUTPUT=<仓库外目录>` 导出棋盘截图。
