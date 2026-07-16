# ATL Obsidian 任务确认插件设计

## 目标

在 Obsidian 内完成 Inbox 任务的信息补齐与确认，不要求用户打开终端。用户从 TaskNotes 任务卡片的文件菜单或 Obsidian 命令面板打开居中弹窗，补齐项目、目标、验收标准、优先级和 Agent 自动执行许可后，将任务安全地移入 Ready。

## 产品边界

- TaskNotes 继续负责看板、卡片、筛选、日历和任务浏览。
- ATL 插件只增加任务确认入口、居中弹窗、设置页和反馈提示。
- ATL Core 继续负责校验、项目创建、状态迁移、文件移动、索引和审计。
- 插件不调用 TaskNotes 私有 API，不操作其 DOM，不 fork TaskNotes，也不直接改 Markdown。
- MVP 只支持桌面版 Obsidian，因为 ATL Core 使用 Node.js 文件系统能力。

## 用户流程

1. 用户在 TaskNotes 看板的 Inbox 卡片上打开文件菜单，选择“确认并移到待执行”。
2. 插件校验文件属于 `10_Tasks/Inbox` 且对应任务仍为 Inbox。
3. 居中弹窗展示任务标题，并预填任务中已有的草稿字段。
4. 用户选择已有项目，或在同一弹窗中新建项目。
5. 用户补齐目标、至少一条验收标准、优先级，并决定是否允许 Agent 自动执行。
6. 用户点击“确认并移到待执行”。如果选择新项目，插件先通过 `createProject` 创建项目，再调用 `confirmTask`。
7. ATL Core 将任务移动到 `10_Tasks/Active/<projectId>`，更新索引并记录审计；TaskNotes 根据 Markdown 自动刷新看板。

## A 方案界面

- 使用 Obsidian `Modal`，宽度约 640px，始终居中。
- 顶部显示“确认任务”和任务标题，不在弹窗中重复展示整段来源正文。
- 项目区使用下拉选择；选择“新建项目”后展开项目名称与说明。
- 目标使用多行文本框。
- 验收标准为可增删的多行输入列表，至少保留一行。
- 优先级使用下拉选择。
- Agent 权限使用 Obsidian Setting 风格开关，文案为“允许 Agent 自动执行”。关闭时任务仍可进入 Ready，但自动领取器不会领取。
- 主按钮文案为“确认并移到待执行”，次按钮为“取消”。提交期间禁用按钮，成功后关闭弹窗并显示 Notice；失败时保留输入并显示可理解的错误。

## 写入授权

- 插件设置提供“允许 ATL 管理此 Vault”开关，默认关闭。
- 打开开关后，插件向 ATL 存储层传入与当前 Vault 根目录绑定的显式授权对象。
- 授权对象必须经过规范化路径比对，只能授权当前 Vault；不修改全局 `process.env`。
- CLI 继续支持现有 `ATL_VAULT_ROOT` 与 `ATL_ALLOW_REAL_WRITES=1`，保持向后兼容。

## 非目标

- 不重做 TaskNotes 看板。
- 不实现 Agent、小队、Skill 编排。
- 不在本期自动启动 Claude Code 或定时调度器。
- 不支持移动端 Obsidian。
- 不实现任意任务类型；MVP 仅确认 `research` 任务，权限固定为 `read_only_research`。

## 验收标准

- TaskNotes Inbox 卡片文件菜单可看到 ATL 确认入口，非 Inbox 文件不显示。
- 命令面板可对当前 Inbox 任务打开同一弹窗。
- 未授权 Vault 时不可提交，并能在插件设置中完成授权。
- 选择已有项目或新建项目都能完成确认。
- 目标为空、验收标准为空时不能提交，并在对应控件附近显示错误。
- 关闭自动执行后，任务可进入 Ready，但不会被自动领取。
- 所有写入均通过 ATL services；确认成功后 Markdown 被移动、索引更新、审计存在。
- 插件产物包含 `main.js`、`manifest.json`、`styles.css`，可直接安装到 Obsidian 插件目录。
