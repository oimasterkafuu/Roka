# Roka Issue #37：平衡性核查与微调 — yuelan 在随机地图偏强

先读 AGENTS.md 与 MAP.md，严格遵守（pnpm；lint/build/format 全绿才提交；commit 规范按 AGENTS.md）。

任务：
1. 定位 yuelan（bot/AI 人格）相关实现代码，弄清其在随机地图上的强度来源（出生点分布、扩张/行为逻辑、数值参数等），与其他 bot 对比。
2. 判断是否真的偏强：可查 /root/roka/data/replays/ 下随机地图回放佐证，或从代码逻辑推断。
3. 若确实偏强：做小幅平衡性调整（优先调参数，勿大改行为逻辑）；若不偏强：在 Issue #37 评论说明依据即可，不改代码。
4. 修复后推送 commit，commit message 带 `Closes #37`；若不改代码则用 gh 评论后 `gh issue close 37`。
5. 全程由你（Kimi）完成 commit/push/评论。
