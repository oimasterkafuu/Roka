# AGENTS.md

## 包管理器

- 统一使用 `pnpm`，禁止使用 `npm` 或 `yarn`。
- 首次安装依赖：`pnpm install`
- 新增依赖：`pnpm add <pkg>` / `pnpm add -D <pkg>`
- 删除依赖：`pnpm remove <pkg>`
- 提交前应确保 `pnpm-lock.yaml` 与 `package.json` 一致。

## 项目开发准则

- Node 与依赖管理：
  - 使用 `package.json` 中声明的 `packageManager` 版本（通过 Corepack 管理）。
  - 不手动编辑 `dist/` 产物，源码修改应在 `src/` 与 `static/` 下进行。
- 日常开发流程：
  - 启动开发：`pnpm run dev`
  - 类型构建检查：`pnpm run build`
  - 代码检查：`pnpm run lint`
  - 自动格式化：`pnpm run format`
  - Bot 集成测试：`pnpm run test:bot`（临时数据目录启动服务，两个 random-patch-bot 自动开局）
- 提交前最小检查：
  - `pnpm run lint`
  - `pnpm run build`
  - `pnpm run format`
- 变更原则：
  - 单次提交聚焦一个主题，避免混入无关改动。
  - 修改行为时，需同步更新 `README.md`（如运行方式、接口、配置变化）。
  - 涉及结构/功能变化时（新增/删除/移动文件、改动文件职责、改协议或数据格式），需同步更新根目录 `MAP.md` 项目地图。

## 分支与推送流程

- **任何更新完成并验证后，第一时间推送到 GitHub**。生产部署以 GitHub `main` 为准（webhook 触发自动 `git reset --hard origin/main` + 构建 + 重启）：只在本地改等于没有生效，且未推送的本地改动会被下一次自动部署直接覆盖丢失。
- **每个功能独立分支**：
  - 从 `main` 切出功能分支（`feat/xxx`、`fix/xxx` 等命名）；
  - 功能分支上可以随时 commit（仍需符合 Conventional Commits 与 GPG 签名）；
  - 功能完成并通过提交前最小检查后合并回 `main`（`--no-ff` 保留功能边界），随后立即 push。
- **并行开发**：较复杂的功能可由主 Agent 派发子 Agent 在各自的功能分支上开发；子 Agent 完成后汇报结果，由主 Agent 统一合并回 `main` 并推送。
- 不要在服务器工作区保留未提交、未推送的改动（包括文档与配置）。
- **每次修改必须立即推送到远端**（GitHub `main`），不得只停留在本地，防止与他人/自动化流程产生冲突。

## 版本号更新

- **任何合并进 `main` 的更新都必须更新 `package.json` 中的版本号，无一例外**：无论改动大小（小功能、缺陷修复、文档、配置、样式调整等），也无论是否来自 Dependabot。
- **版本号规则（SemVer）**：
  - `major`：破坏性变更；
  - `minor`：新功能（`feat`）；
  - `patch`：缺陷修复、依赖更新、文档、杂项等其余改动（依赖更新一律 `patch`）。
- **手动改动（非 PR 流程）**：在功能分支上随改动一起提升版本号，使用 `pnpm version <major|minor|patch> --no-git-tag-version`（只修改 `package.json`，不产生 git tag），随后与本次改动一起提交。
- **PR 流程**：统一使用 `.github/workflows/bump-version-and-merge.yml` 自动提升版本号并合并：
  - 在 PR 下评论 `OK. <major|minor|patch> [merge|squash|rebase]`（仅限 oimasterkafuu），或通过 `workflow_dispatch` 手动触发；
  - 工作流会在 PR 分支上自动 `pnpm version` 提升版本号并提交，然后按指定策略合并。

## 依赖更新（Dependabot）

- **Dependabot 配置**：npm 生态，检查频率为每天（`daily`），`open-pull-requests-limit: 0`（不限数量），配置见 `.github/dependabot.yml`。
- **Dependabot PR 必须第一时间处理**，不积压。
- Dependabot 更新同样必须更新版本号（一律 `patch`），走上一节的 PR 流程（`bump-version-and-merge.yml`）。
- 多个 Dependabot PR 按顺序逐个处理：合并一个后再处理下一个，避免锁文件/版本号并发冲突；出现冲突时合并 `main` 后用 `pnpm install --lockfile-only` 重新生成锁文件。
- 已合并的 Dependabot 分支及时删除。

## 代码安全扫描（CodeQL）

- 仓库已启用 CodeQL 扫描（`.github/workflows/codeql.yml`）：`push`/`pull_request` 到 `main`、每周一定时触发，语言为 javascript-typescript（build-mode: none）。
- **CodeQL 扫描出的告警必须第一时间修复**（含日常维护巡检时发现的），修复后推送并确认告警闭环，不留 open 状态积压。

## 提交身份与签名

- 提交作者必须配置为：
  - `user.name`: `oimasterkafuu`
  - `user.email`: `hi@oim.moe`（与 GPG 密钥 uid 一致）
- 所有提交必须使用 GPG 签名（`commit.gpgsign=true`）：
  - `user.signingkey`: `BEF250058DD26AF6FA0BA5834BFA82BF714AA7FE`（uid 为 `oimasterkafuu <hi@oim.moe>`）
  - 密钥备份由维护者保管，导入后可用 `git log --show-signature` 验证。
- 提交前若不确定身份配置，先运行 `git config user.name && git config user.email` 确认；禁止以自动生成的身份（如 `root@localhost`）提交。

## 提交格式规范（Conventional Commits）

- 提交信息格式：
  - `<type>(<scope>): <subject>`
- `type` 建议值：
  - `feat` 新功能
  - `fix` 缺陷修复
  - `refactor` 重构（不改变外部行为）
  - `perf` 性能优化
  - `docs` 文档变更
  - `style` 纯样式/格式调整（不改逻辑）
  - `test` 测试相关
  - `chore` 杂项维护（构建、工具、依赖等）
  - `ci` CI/CD 配置变更
  - `revert` 回滚提交
- 书写要求：
  - `subject` 使用祈使句，简洁明确，英语，首字母小写，不超过 72 个字符。
  - 需要补充背景时，在正文说明 `why` 与影响范围。
  - 破坏性变更需在正文或页脚标注 `BREAKING CHANGE:`。

示例：

```text
feat(replay): support ops-v1 binary patch stream
fix(auth): invalidate previous session on re-login
docs(readme): replace npm commands with pnpm
chore(deps): migrate lockfile to pnpm-lock.yaml
```
