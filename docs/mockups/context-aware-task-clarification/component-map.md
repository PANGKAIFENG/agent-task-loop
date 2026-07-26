# Component Map：从 UI 稿到生产实现

| UI element | Production component / style source | Reuse / new / modify | Related files | States | Notes |
| --- | --- | --- | --- | --- | --- |
| 居中弹窗 shell | Obsidian `Modal` | Modify | `src/obsidian-plugin/confirmation-modal.ts`、`styles.css` | all | 从确认弹窗演进为 ATL 自有任务详情，不注入 TaskNotes DOM |
| 标题、元数据与关闭 | `Modal.titleEl` / DOM helper / `setIcon` | Modify | `confirmation-modal.ts` | all | 保持 Obsidian 原生密度 |
| 项目、优先级等基础字段 | Obsidian `Setting`、Dropdown、Text | Reuse | `confirmation-modal.ts` | all | 不在澄清时强制填写 |
| 上下文摘要与 disclosure | New component needed：`TaskContextDisclosure` | New | 新的 ATL Modal 组件目录 | loading、all result states | 展示来源、可用性、截断、排除与重试 |
| 来源状态行 | 复用会议附件行的网格与 token | Modify | `meeting-transcript-modal.ts`、`styles.css` | all | 不是把附件卡片直接嵌套进卡片 |
| 充分 / 缺失 / 冲突 / 错误反馈 | 现有 `atl-form-error` + Obsidian semantic tokens | Modify | `styles.css` | sufficient、clarify、conflict、errors | 错误在受影响区域内，不只用 Notice |
| 阻断性对话 | New component needed：`ClarificationThread` | New | 新的 ATL Modal 组件目录 | clarify | 当前轮次 + 输入，不展示冗长历史 |
| 任务简报编辑器 | Obsidian `Setting`、TextArea、现有 criteria rows | Modify | `confirmation-modal.ts`、`confirmation-form.ts` | sufficient、clarify、saved | 支持字段来源、单区重生成与手工编辑 |
| 字段来源标签 | New inline provenance badge | New | 新的 task brief view/model | sufficient、conflict | 仅使用小型文字状态，不做大卡片 |
| 保存任务简报 | Obsidian `ButtonComponent.setCta()` | Modify | Modal controller / service | sufficient、clarify | 保存不触发状态移动或 Agent |
| Agent disclosure | 原生 `<details>` + Obsidian Setting | Modify | 现有 `atl-task-details` pattern | saved、agent-ready | 默认关闭，用户主动展开 |
| Agent 选择 | Obsidian segmented button pattern / dropdown | New | Agent preparation view | agent-ready | Codex / Claude Code |
| 工作区选择 | Obsidian Dropdown + folder picker | New | 设置页与工作区注册表 | agent-ready、runtime-error | 区分业务项目与本地目录 |
| 权限选择 | Obsidian radio / dropdown / Setting | New | Agent preparation view | agent-ready | 高风险档位必须二次确认 |
| 运行状态与步骤 | New component needed：`AgentRunSummary` | New | Agent session view/controller | running | 显示真实事件，不模拟百分比 |
| 会话入口 | Obsidian Button + `setIcon('arrow-up-right')` | Reuse | 现有 `work-contribution-view.ts` icon pattern | running、review | 无有效会话关系时不显示成功入口 |
| 结果与 Artifact | 复用 Artifact domain 与链接展示 | Modify | `src/domain/artifact.ts`、相关 repository | review | 文件、Commit、PR、报告用可读名称 |
| 验收操作 | 现有 review service / ButtonComponent | Reuse / modify | `src/services/review-task.ts` | review | 通过或要求修改 |
| 状态切换器 | standalone HTML only | Do not port | `mockup.html` | all | 仅供评审和截图 |

## Token Mapping

- 背景：`--background-primary`、`--background-secondary`
- 边界：`--background-modifier-border`
- 主操作：`--interactive-accent`、`--text-on-accent`
- 正文：`--text-normal`、`--text-muted`、`--text-faint`
- 语义状态：`--color-green`、`--color-orange`、`--text-error`
- 圆角：`--radius-s`、`--radius-m`；卡片不超过 `8px`
- 图标：Obsidian `setIcon`，不复制 mockup 的字符图标
