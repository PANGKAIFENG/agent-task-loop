# Implementation Notes：上下文感知任务澄清

## Production Strategy

先把现有“移到待办”确认弹窗拆成可复用的任务详情骨架，但不要一次性替换原有确认路径。使用 feature flag 或独立命令让 MVP-1 可并行验证，稳定后再合并入口。

## Recommended Ownership

- Modal 只负责渲染和收集用户操作。
- Controller 负责状态转换、并发保护和失败映射。
- Context service 负责发现、授权、截断和来源追溯。
- Task brief service 负责充分性判断、结构化生成和保存。
- Markdown repository 是任务事实写入边界。
- Agent preparation、session adapter 与 result write-back 属于 MVP-2，不进入 MVP-1 service contract。

## Data And State

- 任务简报建议成为独立可版本化对象，而不是继续只复用 `objective` 和 `acceptanceCriteria` 两个字段。
- MVP-1 至少保存：目标、下一步、完成条件、可选交付物、范围、风险、来源关系、确认时间和澄清状态。
- 保存任务简报必须与看板状态、`scheduled`、`due`、业务项目写入解耦。
- 来源使用稳定引用与解析状态，不把整篇同步助手、听记或个人上下文复制进任务正文。
- `07_System/Agent_Context/` 为空是合法状态。
- AI 对话草稿和完整审计记录与任务正文分开，避免任务文件持续膨胀。

## MVP-1 Event Flow

1. 用户从任务文件菜单或 ATL 命令打开任务澄清。
2. Controller 读取任务快照并启动有界上下文发现。
3. UI 流式更新来源可用性，但允许用户继续查看和编辑已有任务信息。
4. 模型返回 `sufficient / needs_clarification / conflict` 与任务简报草稿。
5. 用户回答、选择冲突来源或直接编辑字段。
6. 保存 service 使用版本/更新时间做冲突检测，只写任务简报相关事实。
7. UI 显示 saved，主操作返回 TaskNotes；不调用确认、移动、调度或 Agent service。

## MVP-2 Event Flow

1. 用户主动展开“交给 Agent”。
2. 系统加载工作区、运行时和权限状态。
3. 用户确认 Agent、工作区、执行方式、上下文发送范围和权限。
4. 系统冻结执行包并做准入检查。
5. 只有获得有效会话关系后，才显示 running 并改变对应 Agent 协作状态。
6. 结果通过 domain service 回写，任务等待人工验收。

## Testing

- 先写失败测试：保存简报不会移动状态、不会修改 `scheduled/due/project`、不会调用 Agent。
- Context service 使用临时 Vault fixture；不读取真实同步助手、钉钉镜像或 `Agent_Context`。
- 覆盖信息充分、只缺一个问题、来源冲突、附件解析失败、个人上下文为空、模型超时、并发修改。
- 覆盖 Agent disclosure 默认关闭且不触发运行时检测。
- MVP-2 增加工作区失效、未登录、无法取得会话 ID、执行中断、结果拒绝和继续原会话。
- 真实 Vault 写入验证继续要求 `ATL_VAULT_ROOT` 与 `ATL_ALLOW_REAL_WRITES=1`，默认测试不得触碰真实 Vault。

## Preview-To-Production Boundary

不要复制 `mockup.html` 的 DOM、状态切换器、演示数据或内联 CSS。生产实现只复用信息架构、视觉 token、状态文案和操作优先级，并继续使用 Obsidian `Modal`、`Setting`、`ButtonComponent`、`setIcon` 与现有服务边界。

## Pre-Implementation Checks

- 开发分支开始前同步最新 `origin/main` 并运行 Node 24 基线。
- 补一份任务简报字段映射与向后兼容规格。
- MVP-1 使用独立的“智能完善任务”命令和文件菜单入口，并保留现有“AI 帮我整理”确认流程；内部命令 ID 保持兼容，不随展示文案变化。
- MVP-2 前单独完成 Codex / Claude Code 会话技术探针和工作区字段迁移设计。
