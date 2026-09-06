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
