# 上下文感知任务澄清 UI 交接稿

这是 `visual-handoff`，用于确认产品结构、状态和视觉实现目标，不是可直接并入生产的 Obsidian 插件代码。

## Source Inputs

- PRD：`docs/PRD-Context-Aware-Task-Clarification-and-Agent-Execution.md`
- UI spec：未单独提供；以 Obsidian 原生 Modal、ATL 现有弹窗和现有 CSS token 为视觉事实源
- 生产项目：当前 `agent-task-loop` 仓库
- 目标视口：`1440 x 900`、`1280 x 800`
- 结构状态：`structure-confirmed`

## Product Decision

主界面是一个 Obsidian 原生风格的居中任务详情弹窗。入口和弹窗标题统一为“智能完善任务”，系统基于已有上下文生成可编辑的“智能建议”，用户补充后通过“确认并保存”形成任务简报；保存后可以直接返回 TaskNotes 人工管理。“交给 Agent”始终是简报下方默认收起的可选区域。

## Discovered UI Constraints

- 现有 `TaskConfirmationModal` 继承 Obsidian `Modal`，使用居中弹窗而非独立页面。
- 现有弹窗使用 Obsidian `Setting`、`ButtonComponent`、`Notice` 和 `setIcon`，生产实现应继续复用。
- 当前任务确认弹窗宽度为 `640px`，会议弹窗宽度为 `760px`；本稿将复杂任务详情上限扩为 `860px`，仍保持居中、单层、独立滚动。
- 现有样式依赖 `--background-primary`、`--background-secondary`、`--background-modifier-border`、`--interactive-accent`、`--text-normal`、`--text-muted` 等 Obsidian token。
- 现有任务弹窗已具备项目、优先级、可选任务说明、AI 整理失败回退和底部操作区，可渐进改造。
- 现有 AI 只读取标题、正文、用户一句补充和项目名，只生成目标与验收标准；上下文清单、多轮澄清和字段来源均需新增。
- 生产图标继续使用 Obsidian `setIcon` 对应的 Lucide 图标，不复制本 HTML 的符号样式。
- TaskNotes 仍拥有看板和日历，本功能不向 TaskNotes 私有 DOM 注入 UI。

## Included States

- `sufficient`：已有上下文充分，直接形成可编辑简报
- `clarify`：缺少一个阻断性决定，展开对话
- `conflict`：来源冲突，等待用户选择
- `saved`：仅保存简报并返回人工管理
- `agent-ready`：用户主动展开 Agent 执行准备
- `running`：Agent 会话运行中
- `review`：Agent 结果等待人工验收
- `model-error`：模型失败，保留人工编辑
- `runtime-error`：运行时不可用，提供人工交接

## Open

直接打开：

`docs/mockups/context-aware-task-clarification/mockup.html`

使用查询参数切换状态，例如：

`mockup.html?state=saved`

页面右下角的状态切换器只用于评审截图，不属于生产 UI。

## Files

- `ascii-layout.md`：界面结构、状态模型和滚动边界
- `screen-contract.md`：页面与状态合同、PRD 追溯
- `component-map.md`：视觉区域到生产组件的映射
- `implementation-notes.md`：生产改造建议与测试边界
- `mockup.html`：可直接打开的高保真视觉参考
- `screenshots/saved-1440x900.png`：标准桌面视口下的人工管理终点
- `screenshots/saved-1280x800.png`：窄桌面视口下的人工管理终点

## Verification

- HTML 无外部网络依赖，可直接以 `file://` 打开。
- 已按 `1440 x 900` 与 `1280 x 800` 渲染并保存双视口截图。
- `1280 x 800` 下 9 个评审状态的内置布局检查全部为 `pass`；`1440 x 900` 下人工管理终点为 `pass`。
- 已实际点击验证 `信息充分 -> 保存任务简报 -> 主动展开交给 Agent`，Agent 设置不会在保存后自动出现。
- 已检查页面非空、主要容器不溢出、按钮文字不截断、弹窗与状态切换器不互相遮挡，浏览器控制台无错误或警告。
- HTML 中的内置 `data-layout-check` 仅用于静态校验，不属于生产实现。

## Migration Boundary

可直接沿用的是信息架构、状态、文案、视觉密度、Obsidian token 和交互优先级。不能直接复制的是 standalone HTML 的 DOM、CSS 类名、演示数据和状态切换器；生产实现必须落在 ATL 自有 Modal、Controller、Service 和 Markdown Repository 边界内。
