# Screen Contract：上下文感知任务澄清

## Screens

| Screen | Purpose | Key regions | States covered | PRD source | UI source | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ATL 任务澄清 Modal | 基于已有上下文生成可编辑建议，并由用户补充确认 | 任务头、上下文、反馈/对话、简报、可选 Agent、底部操作 | sufficient、clarify、conflict、saved、model-error | 7-9、11-12、16-17 | Obsidian Modal、现有确认弹窗 | 用户可见名称为“智能完善任务” |
| Agent 执行准备 | 在用户主动委托时确定执行边界 | Agent、工作区、方式、权限、发送范围 | agent-ready、runtime-error | 10、15-17 | 同一 Modal disclosure | 默认收起，MVP-2 |
| Agent 状态与验收 | 回看会话、结果与产物 | 状态、会话入口、步骤、产物、验收 | running、review | 10.6、12、13、16-17 | 同一 Modal 状态替换 | MVP-2 |
| TaskNotes 看板 / 日历 | 人工排期、推进和完成 | 原有看板与日历 | saved 后返回 | 3.4、5、7、12 | TaskNotes 既有界面 | 不改私有 DOM |

## State Contract

| State | Trigger | Visible regions | Primary actions | Recovery / next | Testable evidence |
| --- | --- | --- | --- | --- | --- |
| sufficient | 已读取信息足以明确下一步与完成条件 | 上下文摘要、绿色反馈、完整简报 | 保存任务简报 | saved | 无对话也能生成并编辑 |
| clarify | 缺少一个阻断性信息 | 已知内容、单问题对话、部分简报 | 发送回答 | sufficient | 不重复询问已有事实 |
| conflict | 目标/范围来源冲突 | 并列来源、原文入口、用户选择 | 采用依据 | sufficient | 未选择前不能静默合并 |
| saved | 保存服务成功 | 简报摘要、Agent 收起、成功反馈 | 返回任务 | TaskNotes | 看板状态、日期、项目未改变 |
| agent-ready | 用户主动展开 disclosure | Agent、工作区、方式、权限、发送范围 | 开始执行 | running / runtime-error | 不展开时完全不要求这些字段 |
| running | 运行时返回有效会话关系 | 运行状态、当前步骤、会话入口 | 打开会话 | review / interrupted | 任务为进行中且可回看会话 |
| review | Agent 已返回候选结果 | 结果摘要、产物、验收操作 | 验收通过 / 要求修改 | done / running | Agent 不自动完成任务 |
| model-error | 模型超时、无效结果或未配置 | 就地错误、已有草稿、重试与人工编辑 | 重试 / 直接编辑 | sufficient / saved | 不丢原文、回答和已有字段 |
| runtime-error | Agent 未安装、未登录或会话关系失败 | 原因、重新检测、人工交接 | 重新检测 / 复制交接 | agent-ready / external | 不宣称启动成功，不改看板状态 |

## Interaction Contract

1. 打开 Modal 后读取上下文；读取期间不锁死任务原文编辑。
2. 上下文摘要默认只显示来源类型与数量，展开后才显示文件名、锚点、解析状态和排除开关。
3. 对话不是固定表单，只有阻断性问题才自动展开。
4. 生成内容可直接编辑；字段旁显示“来源事实”或“AI 推断”。
5. 保存任务简报是 MVP-1 的主要提交动作，并具有完整成功反馈。
6. “交给 Agent” disclosure 默认关闭，保存简报不会自动打开。
7. 展开 Agent 后才执行工作区、运行时与权限校验。
8. Agent 结果需要人工验收；要求修改优先继续原会话。

## PRD Traceability

| Requirement | UI evidence |
| --- | --- |
| 已有信息充分时不强制对话 | sufficient 直接显示草稿 |
| 只追问阻断性缺口 | clarify 只有一个关键问题 |
| 来源可见、可排除 | 上下文 disclosure 与来源状态 |
| 冲突不静默合并 | conflict 来源选择区 |
| 简报可独立保存 | saved 的“返回任务”主操作 |
| Agent 不成为门槛 | Agent disclosure 默认收起 |
| 失败不阻断人工流程 | model-error 的“直接编辑任务简报” |
| 启动失败不误报成功 | runtime-error 的重新检测与人工交接 |
| Agent 不自动完成任务 | review 的“验收通过 / 要求修改” |

## Assumptions

- MVP-1 用同一居中 Modal 完成扫描、对话和简报，不新增独立侧边栏。
- 工作区管理的独立设置页不在本轮 UI 稿中；Agent 区只展示选择与当前有效性。
- 简报字段允许按任务类型隐藏“预期交付物”，但始终保留目标、下一步和完成条件。
- 完整对话保存在 ATL 审计区，Modal 默认只呈现当前澄清轮次。
