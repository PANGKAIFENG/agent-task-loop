# PRD Review Report：上下文感知任务澄清与可选 Agent 执行闭环

评审日期：2026-07-26
评审对象：`docs/PRD-Context-Aware-Task-Clarification-and-Agent-Execution.md`
评审视角：PM、研发、测试、安全边界
结论：`Ready with assumptions`

## Review Scope

- Handoff：本轮用户确认的产品边界与既有 Agent Task Loop / TaskNotes 决策；没有单独 handoff 文件。
- PRD：`docs/PRD-Context-Aware-Task-Clarification-and-Agent-Execution.md`。
- Supporting artifacts：两张可编辑 Draw.io 图、UI visual handoff、当前 Obsidian 插件实现与开发计划。
- Facts vs assumptions：用户明确表达与当前仓库行为作为事实；Codex / Claude Code 连续会话和项目字段迁移作为后续开放假设，不作为 MVP-1 既成能力。

## Findings

### 阻断 1（已关闭）：任务澄清曾被错误地写成 Agent 执行前置流程

- 视角：PM、研发、测试
- 位置：标题、模块定位、核心流程、页面结构、分期范围
- 证据来源：用户本轮反馈与 PRD 修订前文本
- 问题：原稿虽然提到人工任务可以继续管理，但标题、主流程和 UI 仍把“选择 Agent / 工作区 / 权限”放在任务简报之后的必经链路上。
- 影响：普通任务会被迫做不相关的技术选择，用户无法只借助 AI 想清楚任务；研发也会把 Agent Runtime 误判为首版上线依赖。
- 修订：任务简报改为独立完整产物；保存后默认返回 TaskNotes 人工排期与推进；“交给 Agent”成为默认收起、由用户主动开启的可选分支。
- 关闭证据：PRD 第 1、5、7、9、10、11、12、13、17、19 节和两张 Draw.io 图已统一表达该边界。

### 重要 2（已关闭）：MVP 范围过大，无法先验证“智能完善任务”的价值

- 视角：PM、研发、测试
- 位置：第 19 节“分期范围”
- 证据来源：PRD 文本与 reviewer inference
- 问题：上下文发现、多轮澄清、工作区、双 Agent、会话回链、验收和复盘原本被放在同一个 MVP 包中。
- 影响：首个可用版本会被不稳定的 Agent 集成拖慢，测试面也会过大。
- 修订：拆成 `MVP-1：智能完善任务` 与 `MVP-2：可选 Agent 执行闭环`。MVP-1 可以单独开发、演示和上线。

### 重要 3（开放假设）：Codex / Claude Code 连续会话能力尚未形成稳定产品合同

- 视角：研发、测试
- 位置：第 10.3、10.6、16、20 节
- 证据来源：现有代码能力与 PRD 非阻断假设
- 问题：当前 Codex 只支持复制人工交接；Codex Desktop 线程可见性和 Claude Code 会话恢复仍需技术验证。
- 影响：若开发计划把原生桌面会话当作既成能力，会出现“显示已启动但用户找不到会话”或返工无法延续的问题。
- 处理：保持人工交接为稳定兜底；会话创建、恢复、可见性作为 MVP-2 的独立 tracer bullet，验证失败不得影响 MVP-1。

### 重要 4（开放假设）：业务项目、TaskNotes 项目字段与 Agent 工作区仍需迁移规格

- 视角：研发、测试
- 位置：第 8.4、10.1、17.2、20 节
- 证据来源：现有 `project_id` / TaskNotes `projects` 差异与 PRD 文本
- 问题：产品对象已经区分“业务项目”和“Agent 工作区”，但既有 Markdown 字段如何兼容、迁移和回滚尚未形成字段映射规格。
- 影响：直接实现工作区选择可能改坏既有看板筛选或导致同一任务出现两套项目归属。
- 处理：MVP-1 只读取现有业务项目，不迁移；MVP-2 开始前补字段映射、双读单写和回滚测试。

### 优化 5（已关闭）：缺少正式多状态 UI 承接

- 视角：PM、研发、测试
- 位置：第 11 节
- 证据来源：旧 HTML 原型与当前 PRD 的信息结构不一致
- 问题：旧原型无法表达上下文清单、阻断性追问、冲突、简报独立保存和 Agent 可选展开。
- 修订：新增 `docs/mockups/context-aware-task-clarification/` 视觉交接包，覆盖信息充分、需要澄清、上下文冲突、仅保存简报、Agent 准备、运行中、待验收、模型失败和运行时失败。

## Lens Summary

- PM：用户价值已经从“替 Agent 填执行字段”收敛为“利用已有上下文把任务想清楚”。普通人工任务拥有完整终点，产品不会因为 Agent 能力未完成而失去首版价值。
- 研发：模块边界、主链路、可选执行分支、失败降级和 TaskNotes 所有权已清楚。MVP-1 可以在不引入工作区迁移和会话集成的情况下落地。
- 测试：正常流、信息不足、冲突、模型失败、保存不改状态、以后再交给 Agent 等关键行为已有可判断标准。MVP-2 仍需以会话技术探针和字段迁移规格作为前置。
- 安全：上下文发送范围可见且可排除；钉钉、同步助手和 TaskNotes 插件保持只读/不修改；高风险动作继续单独确认。

## Revision Draft / Applied Revisions

本轮已直接回填 PRD，而不是留下待办式修改建议：

1. 主链路改为 `上下文 -> 任务简报 -> 人工管理`，Agent 成为可选分支。
2. 通用充分性标准收敛为目标、下一步动作和完成条件；非交付型任务不强制虚构交付物。
3. 增加“只保存任务简报”的独立验收标准，并明确保存不改变看板、日期和 Agent 状态。
4. MVP 拆为可独立上线的任务澄清和后续 Agent 闭环。
5. 两张可编辑 Draw.io 图同步增加人工管理终点与 Agent 可选分支。
6. 正式 UI 交接稿和开发计划纳入 PRD 附录。

## Open Questions

以下问题不阻断 MVP-1，但必须在对应后续阶段开始前关闭：

1. Codex 稳定本地执行路径能否可靠返回可恢复的会话标识，并能否在当前 Codex Desktop 中定位。
2. Claude Code 连续会话如何与现有受控调研 Runner 共存，且不扩大工具与文件权限。
3. `project_id`、TaskNotes `projects` 和工作区注册表采用哪种双读单写迁移策略。
4. 完整澄清对话在 Vault 审计区的保留周期、敏感字段遮蔽和删除入口。

## Deterministic Checks

- PRD shape：`ai-native --allow-handoff`，通过。
- 核心流程 Draw.io：1 个 diagram、39 个 `mxCell`，通过。
- 架构 Draw.io：1 个 diagram、40 个 `mxCell`，通过。
- 两张 SVG 已从可编辑 `.drawio` 源文件重新导出并嵌入源数据。
- UI 交接包：必需文件完整，通过 package check。
- UI 布局：`1280 x 800` 下 9 个状态均为 `pass`；`1440 x 900` 下人工管理终点为 `pass`。
- UI 交互：已验证 `信息充分 -> 保存任务简报 -> 主动展开交给 Agent`，保存不会自动进入 Agent 准备态。
- 浏览器控制台：0 error、0 warning。

## Implementation-Plan Readiness

- Verdict：`Ready with assumptions`
- Reason：MVP-1 的用户、问题、主链路、边界、异常和验收均足以进入开发计划；没有阻断性产品问题。
- Required assumptions before planning：MVP-1 不创建 Agent 会话、不迁移项目字段、不修改 TaskNotes 插件内部实现；MVP-2 启动前先关闭会话合同和字段迁移两个开放假设。
