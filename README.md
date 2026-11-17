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
- GitHub 绑定与 Star 金色首字母；关于页公开展示贡献者和全部 Star 支持者。
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
- `GITHUB_STARGAZERS_TOKEN`：全量拉取仓库 stargazer 列表所用的 GitHub token；未配置时匿名运行，但限额较低。

## GitHub Star 与支持者墙

服务启动时把仓库完整 stargazer 列表保存到 `data/github-stargazers.json`，每 6 小时全量对账；失败保留旧表并每 5 分钟重试。GitHub `star` webhook 复用 `POST /postreceive` 和原有 HMAC 签名，实时处理加星、退星并更新已绑定用户。OAuth 绑定、个人主页和手动刷新只查询这张本地表，不再逐用户请求 GitHub Star API；表尚未就绪时保持未知状态，不写入新的核验结果。

游客可访问 `GET /api/stargazers`，返回 `{items, fetchedAt}`。关于页的贡献者墙与 Star 支持者墙共用自适应卡片网格，空表会显示支持者招募提示。

## 后台安全审查

后台默认展示仪表盘，并提供用户管理、安全风险、聊天审计和仅超管可见的策略 Bot 标签。注册与每 6 小时全量扫描共用用户名安全策略；命中存量账号会永久封禁并清除会话。用户注册 IP、最近 IP 与最多 20 条 IP 历史仅通过管理员 API 返回。同 IP 永久封禁关联只进入人工复核，不自动连坐；同一真实 IP 滚动 24 小时最多成功注册 2 个账号，后续注册拒绝 24 小时。安全事件保存在 `data/security-audit.json`，最多 2000 条且不超过 2 MiB。

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

## 许可

本项目以 [AGPL-3.0-only](LICENSE) 许可开源。
