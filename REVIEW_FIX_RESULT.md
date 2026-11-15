# PR164 OAuth 安全修复结果

代码修复与本地回归：PASS。真实 GitHub OAuth 联调及生产功能激活：BLOCK（生产缺少 OAuth 配置，由主会话确认；未读取生产密钥或尝试真实授权）。这份报告更新此前 REVIEW_RESULT.md 中两项 P2 的处理状态。

原 PR 分支：`origin/feat/github-link-star-badge`；本地分支：`review/github-164`。修复前 HEAD 为 `2a8c0d10202a8f5fe2179e619d4cbad988631739`。

## 两项 P2 修复

1. **pending / inflight OAuth 取消及写入前复验。** `src/server/github-service.ts` 为每次授权分配递增 generation 与 AbortController，保留当前用户正在执行的 operation。unlink 在删除绑定前同步删除 pending state、使当前 generation 失效并 Abort 进行中的 exchange、identity 或 Star 请求；发起新授权同样取消旧操作。回调在外部请求前和写入 UserStore 前检查 operation generation、Abort 状态以及 `userStore.isSessionValid(username, sid)`；检查到同步写入之间没有 await。旧操作 finally 只清除自身 generation，不能删除后来创建的授权。回调 state 仍一次性消费；错误、拒绝和完成路径释放 operation。

2. **timeout 覆盖 fetch 与响应体读取。** 请求包装器在同一 try/finally 内执行原生 fetch 和响应消费，只有消费完成/失败后才清理 timeout。交换 token 与身份查询在 deadline 内解析 JSON；Star 路径在 deadline 内流式读取并丢弃 body，随后判断 204/404/错误状态。操作取消信号与 deadline 信号合并，取消会中断原生 fetch 的 body 读取；未消费的错误响应体被取消释放。请求仍禁止重定向，错误输出继续使用固定错误码，不回显上游响应或 token。

## 可执行回归证据

新增用例加入既有 `scripts/test-github-link.mjs`，由 `pnpm run test:github-link` 正常执行，未使用只返回自定义值的 mock 证明这两项修复。

本地真实 HTTP server 在 exchange、identity 或 Star 路径立即发送响应头和部分 body，保持 body 不结束。测试调用原生 fetch，拿到实际 Response，检查收到响应头时 signal 尚未 aborted；取消或超时后检查 signal 已 aborted，并等待服务端 response close，验证真实 HTTP 读取已终止。每项等待都有失败超时，断言和异步拒绝会使脚本非零退出。

覆盖项：

- unlink 在 callback 到达前取消 state，旧 callback 不发出任何上游请求。
- unlink 在 exchange / identity / Star body 读取期间取消操作，旧回调返回 state 错误；内存、数字 ID 索引和重启后的持久化均无恢复绑定。
- 新 generation 取消旧 inflight 操作；旧 finally 不影响新授权，新授权可成功完成。
- callback 前轮换会话，旧 SID 被拒绝且无上游请求。
- inflight HTTP 请求开始后登出或轮换会话，再正常结束 HTTP body：网络未 Abort，但写入前会话复验拒绝绑定；重启后仍无绑定。
- exchange、identity 收到响应头后 body 挂起，200ms deadline 真实 Abort，并关闭服务器响应。
- Star 首次核验与手动 refresh 分别覆盖 404 / 401 / 500 的 body 挂起：均真实 Abort；首次仅保留身份且状态 unknown、不授予徽章，refresh 返回 star 错误。

脚本成功输出：`passed native HTTP pending/inflight unlink, generation/session races and exchange/identity/Star body aborts`，并继续通过原有 spawned-server OAuth、映射、DTO、持久化及徽章位置测试。

## 同步主线与版本

先检查本机 127.0.0.1:7890 代理，未监听；正常直连未完成。随后验证环境已配置代理 `192.168.1.188:7890` 的 `git ls-remote` 成功，使用命令级代理 fetch。提交前再次 fetch，远端 main 为 `6996f79fc56a77139843511c3d52d6c7609cf1ea`，版本 `2.6.2`，已包含 chat moderation（PR160）与 replay quota（PR165）。没有等待或操作线上部署。

遵守禁止 merge：未运行 git merge、未创建 merge commit，也未合并 PR。将 merge-base 至 origin/main 的代码增量以 `git diff` + `git apply --3way --index` 同步到原 PR 分支，手动解决 package.json 与 MAP.md 的重叠，保留 GitHub、chat 与 replayquota 测试入口。chat/replayquota 专属源码、管理页面与测试文件对 origin/main 无差异；server.ts 对 origin/main 的增量仅为原 PR 的 GitHub 集成。此方式同步主线内容，不把 main 记录为新祖先，也不改写远端分支历史。

按 origin/main 的 `2.6.2` 提升 minor，执行 `pnpm version minor --no-git-tag-version` 后为 `2.7.0`。未新增/修改依赖，pnpm-lock.yaml 未变。MAP.md 已更新授权取消与完整响应超时职责。依用户指令，本轮未修改 README.md。

## 本轮亲自执行的检查

| 命令                                                                                                                                         | 结果                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `pnpm run build`                                                                                                                             | PASS，exit 0                                          |
| `pnpm run lint`                                                                                                                              | PASS，exit 0                                          |
| `pnpm exec prettier --check --ignore-unknown 'src/**/*.ts' 'static/**' README.md AGENTS.md scripts/test-github-link.mjs package.json MAP.md` | PASS，exit 0；使用只检查模式以遵守不修改 README       |
| `pnpm run test:github-link`                                                                                                                  | PASS，exit 0，包含新增真实本地 HTTP 回归              |
| `pnpm run test:contributors`                                                                                                                 | PASS，exit 0                                          |
| `pnpm run test:referral-ambassador`                                                                                                          | PASS，exit 0                                          |
| `pnpm run test:replay-quota`                                                                                                                 | PASS，exit 0；仅临时目录与 Fastify inject，无生产下载 |
| `pnpm run test:chat-moderation`                                                                                                              | PASS，exit 0；policy 与 HTTP/socket 两个脚本均成功    |
| `pnpm run test:guest-access`                                                                                                                 | PASS，exit 0                                          |

依赖沿用主会话已离线安装的结果，本轮未再次安装。检查未用 `|| true`、忽略退出码或吞掉失败断言。

## 交付与激活边界

只签名提交并普通 push 更新原 PR164 分支，不 push main、不强推、不合并、不部署。提交身份为 `oimasterkafuu <hi@oim.moe>`，GPG key 为 `BEF250058DD26AF6FA0BA5834BFA82BF714AA7FE`；交付时核对提交签名及远端分支 HEAD。

代码可在保持 OAuth 未配置、没有历史 GitHub 绑定的前提下合入；新绑定入口禁用且 start 返回 503，不能称 GitHub 绑定/徽章功能已验收。公共贡献者名单仍可独立工作。缺少 client 配置不是总开关：已有绑定仍可能展示链接、映射和徽章并执行 Star 刷新。本次未检查生产数据，未独立确认历史绑定是否为空。

解除激活 BLOCK 仍需管理员配置 client ID、client secret、redirect URI，并完成受控真实授权、换绑、解绑与 Star/取消 Star 的闭环验证。本报告没有声称已真实联调。

修复前工作区已有 `static/intro/player.js`、`.br`、`.gz` 的生成差异及未跟踪 REVIEW_RESULT.md；不纳入本轮修复提交。构建会重新生成介绍片，相关生成差异也不混入提交。源码、测试、主线同步、版本、MAP 与本报告为本轮提交范围。
