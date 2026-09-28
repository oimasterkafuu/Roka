# 任务：全站统一用户名渲染组件（可点击 + rating 颜色）

你在 /root/roka-wt-username（Roka 仓库 worktree，分支 feat/username-component 从 main 切好，HEAD=c63e2a2 v1.42.5）。**先读 AGENTS.md、MAP.md**，遵守全部开发准则（pnpm、lint/build/format、版本号 minor、Conventional Commits、GPG 签名、英文 commit、README/MAP 同步、只提交不合并不 push）。

## 用户需求

全站渲染用户名的地方现在各行其是，很多位置没有渲染出该用户的 rating 名字颜色，看起来不统一。做一个**统一的用户名渲染组件**：

1. **点击用户名 → 跳转该用户主页**（个人主页路由：profile.html 带用户参数，先查现有个人主页链接格式照搬）
2. **按 rating 段位渲染名字颜色**（rt-* 色阶，与排行榜同源）

## 要求

- 做成单一可复用组件（如 static/main/username.js 或合适位置）：输入用户名（+可选已知 rating/段位缓存），输出带正确颜色 class、可点击跳主页的元素；防注入（统一走 htmlescape/DOM 构建）。
- rating 颜色数据：排行榜接口已有 colorClass/title；需要全局缓存层（用户名→colorClass），注意未上榜/未定级用户的降级显示。若需要轻量 API（按用户名批量查 colorClass）可以加，但优先复用已有数据源，别为每个名字单独发请求。
- **盘点并替换**全站渲染用户名的位置：首页排行榜、回放列表、回放标题区、对局/观战排行榜、聊天消息、动态 feeds 的作者与评论、个人主页等。逐个列出清单，全部接到统一组件（实在不适合接的说明理由）。
- 与既有「玩家局内配色 .cN」（对局内部分配色）区分开：局内分配色不动，本组件管的是**用户名文字本身的 rating 颜色**；同处出现时各自职责清晰（如排行榜里色块=.cN、名字=组件）。
- 刚合并的聊天色块门闸（fix/ui-colors）规则不要破坏：参战色块是局内配色，与用户名 rating 颜色是两回事。

## 验证

lint/build/format 全绿；替换点清单逐条核对；无头环境用代码审查论证，别声称截图实测。版本号 minor。

## 汇报

组件位置与 API、全局颜色缓存策略、替换点清单（含未替换的例外及理由）。