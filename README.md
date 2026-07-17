# Agent Task Loop

把工作和复盘中不断出现的想法统一收进 Obsidian，整理成 Agent 可以安全执行、最终由你验收的个人任务闭环。

> 当前版本：`v0.3.1` MVP。适合同时推进多个项目、经常开启多个 AI 会话，又不希望遗漏后续动作的个人用户。

![Agent Task Loop 工作流](docs/diagrams/agent-task-loop-core-flow.drawio.svg)

## 它解决什么问题

会议后的一个想法、AI 会话里产生的后续动作、每日复盘中的待办，往往散落在笔记、聊天和脑中。ATL 把这些输入变成一条清晰的流程：

1. **先收集**：想法先进入 Inbox，不要求当场想完整。
2. **再确认**：你选择项目，补齐目标、验收标准和执行权限。
3. **后执行**：只有边界明确的只读调研才会交给 Agent。
4. **再验收**：Agent 提交结论与证据，是否完成仍由你决定。

任务、项目和执行结果都保存为当前 Obsidian Vault 中的 Markdown 文件，不依赖云端任务数据库。

## 你会用到的三个组件

| 组件 | 负责什么 |
| --- | --- |
| TaskNotes | 显示任务卡片、看板、筛选、日历和状态 |
| ATL Obsidian 插件 | 随手新建、从同步助手提取待办、确认任务、创建项目和管理后台执行 |
| ATL Runner | 定时领取符合条件的调研任务，并生成带证据的结果 |

ATL 不是 TaskNotes 的二次开发，也不会修改 TaskNotes 插件文件。两者通过 Obsidian 的标准插件机制和 Markdown 任务属性协作。

## 当前产品能力

### 统一收件箱

主动录入、每日复盘和其他自动化产生的候选任务可以进入同一个 Inbox。任务保留来源日期、来源类型和去重标识；未经确认的候选任务不会被 Agent 自动领取。

### 随手记录与立即获取

日常使用不需要打开终端：

- 点击 Obsidian 左侧的“ATL：新建任务”，把当前想法直接放入 Inbox。
- 先把待办发给“笔记同步助手”，再点击“ATL：从同步助手获取待办”。ATL 会只读扫描新内容，用已配置的模型提取候选，由你勾选后再加入 Inbox。
- 每日复盘与立即扫描共用 ATL 收集服务。同一来源中的同一行动，无论哪个入口先运行，都只保留一条任务。
- 只有标题相似、但来源证据不足的任务不会被自动删除；ATL 会把它标为“疑似重复”供你判断。
- 新任务始终只进入 Inbox，不会因为是 AI 提取的就自动交给 Agent。

### 在 Obsidian 中补齐任务

在 Inbox 卡片的文件菜单选择“确认并移到待执行”，会打开居中弹窗。你可以：

- 选择已有项目，或直接创建新项目；
- 写清任务目标；
- 添加至少一条可检查的验收标准；
- 设置优先级；
- 决定是否允许 Agent 自动执行。

确认后，任务才会从 Inbox 进入 Ready。

### 用看板管理状态

| 看板状态 | 含义 |
| --- | --- |
| 收件箱 / Inbox | 已收集，尚未确认是否执行 |
| 待执行 / Ready | 信息完整，等待人工或 Agent 处理 |
| 执行中 / In Progress | 正在处理 |
| 待验收 / Review | 已生成结果，等待你检查 |
| 已完成 / Done | 你确认结果满足要求 |
| 已阻塞 / Blocked | 缺少条件或执行失败，需要处理 |
| 已取消 / Cancelled | 已停止，不再进入队列 |

ATL 可一键应用推荐的 TaskNotes 紧凑卡片布局，突出标题、确认状态、来源日期和优先级，并隐藏冗余文件名。首次应用会保留原始看板备份，可随时恢复。

### 自动完成简单调研

每天 `08:00` 至 `22:00` 的每个整点，ATL 会检查一次可执行队列。每次只领取一个符合条件的任务，并生成独立 Markdown Artifact，包含：

- 结论摘要和主要发现；
- 引用证据及访问时间；
- 尚不确定的信息；
- 建议的后续动作；
- 对每条验收标准的完成说明。

你也可以在插件设置中点击“立即试跑”。没有合格任务时，检查会安全结束，不会自动把 Inbox 任务改成 Ready。

模型服务也在 Obsidian 中管理。默认选择“沿用 Claude Code 当前配置”，因此用 CC-Switch 或 Claude Code 设置切换模型后，ATL 会跟随当前配置。需要让 ATL 单独使用另一个服务时，选择“自定义服务”，填写 Model 和 Base URL，再点击“更新后台配置”。ATL 不保存 API Key；登录和密钥仍由 Claude Code 或系统环境管理。

### 人工验收与恢复

Agent 的结果只会进入 Review，不会自行变成 Done。你可以验收通过、带反馈退回、标记阻塞或取消；也可以停止执行、解除阻塞或重新打开任务。

## 安装

ATL 尚未进入 Obsidian 社区插件市场，目前通过 GitHub Release 安装。安装 ATL 本身不需要终端，也不需要克隆代码仓库。

1. 打开 [Releases](https://github.com/PANGKAIFENG/agent-task-loop/releases)，下载 `agent-task-loop-v0.3.1.zip`。
2. 解压并确认包含 `main.js`、`manifest.json`、`styles.css`、`atl-runner.mjs` 四个文件。
3. 在 Finder 中打开 Vault，按 `Command + Shift + .` 显示隐藏文件。
4. 进入 `.obsidian/plugins/`，新建 `agent-task-loop` 文件夹，把四个文件放入其中。
5. 重启 Obsidian，在“设置 → 第三方插件”中启用 `Agent Task Loop`。

### 使用前提

- macOS 与 Obsidian 桌面版 `1.8.0` 或更高版本；
- 推荐安装 TaskNotes，用于显示任务看板；ATL 的收集和去重不依赖 TaskNotes；
- 本机已有 Node.js `24+`；
- 本机已有 Claude Code，并已完成登录；
- Vault 中已有 ATL 的 `10_Tasks` 目录和任务总看板。

Node.js 和 Claude Code 是外部运行环境，不包含在 ATL 插件中。`v0.3.1` 会自动检测并连接它们，也会直接安装、更新或停用 ATL 自己的 macOS 后台任务；不再需要开发者克隆仓库、执行 `pnpm` 或手工配置调度器。

## 首次设置

1. 打开“设置 → Agent Task Loop”。
2. 在“Vault 权限”中开启“允许 ATL 管理此 Vault”。
3. 在“后台执行”中查看 ATL Runner、Node.js、Claude Code 和后台任务的检测结果。
4. 在“模型服务”中保留推荐的“沿用 Claude Code 当前配置”，或选择“自定义服务”并填写 Model 与 Base URL。
5. 用“选择文件夹”添加 Agent 允许读取的本地资料目录。
6. 状态显示“待安装”后，点击“启用后台执行”。
7. 状态变成“已就绪”后，可点击“立即试跑”检查一次队列。
8. 在“任务看板”中开启“ATL 紧凑卡片”，并按需点击“应用推荐布局”。

自定义 Base URL 是 Agent 实际发送调研任务和已授权资料的服务地址。只填写你信任的服务；ATL 会拒绝包含账号、密码、查询参数或非 `http/https` 协议的地址。

后台状态含义：

| 状态 | 你需要做什么 |
| --- | --- |
| 未配置 | 等待检测；如缺少 Node.js 或 Claude Code，先补齐外部环境 |
| 待安装 | 点击“启用后台执行” |
| 已就绪 | 无需处理；可立即试跑或等待整点检查 |
| 正在执行 | 等待本次任务完成 |
| 配置异常 | 按页面提示处理登录、路径或配置冲突后重新检测 |

完整操作与字段示例见[Obsidian 用户操作指南](docs/operations/obsidian-plugin.md)。

## 日常使用

```text
工作或复盘产生想法
        ↓
Inbox：先统一收下
        ↓  选择项目、目标、验收标准与权限
Ready：等待执行
        ↓  Agent 只读调研
In Progress：执行中
        ↓  生成带证据的 Artifact
Review：你来验收
        ↓
Done，或带反馈退回
```

最简单的节奏是：有想法时随手新建或点击同步扫描，每天集中清理一次 Inbox，随时查看 Ready 和 In Progress，再在 Review 中验收结果。安装完成后，这条日常流程不需要打开终端。

## 什么任务可以交给 Agent

任务必须同时满足以下条件，才可能被自动领取：

1. 状态为 Ready；
2. 类型为 `research`；
3. 权限为 `read_only_research`；
4. 已关联项目，并有明确目标和至少一条验收标准；
5. 你主动开启 `auto_executable=true`。

Agent 不能自动确认 Inbox 任务，不能修改代码、配置或正式日程，不能对外发送消息，也不能批准自己的结果。涉及登录、发布、付款、写代码或外部沟通的任务应由人工处理。

## 数据保存在哪里

```text
10_Tasks/
├── Inbox/       # 未确认的候选任务
├── Active/      # Ready、In Progress、Review、Blocked
├── Archive/     # Done、Cancelled
├── Projects/    # 项目定义和项目上下文
├── Artifacts/   # 每次执行产生的独立结果
└── _System/     # 索引、审计和内部状态
```

个人任务正文、原始笔记和 Agent 登录凭据不会写入本 GitHub 仓库。自动化测试只使用临时 Vault，不读取真实个人任务。

## MVP 边界

`v0.3.1` 聚焦“收集、确认、可视化管理、简单调研、人工验收”的个人闭环。暂不包含：

- 自动理解和扩写信息不完整的 Inbox 任务；
- 自动安装或登录 Node.js、Claude Code 等第三方运行环境；
- 保存 API Key、管理多个 Provider 配置或替代 CC-Switch；
- 在一个 Obsidian 界面中完成所有验收和异常处置；
- Agent、Skill、小队及多 Agent 编排；
- 团队协作、云同步、SaaS 托管和移动端；
- 自动判断事实正确并直接把任务标记为 Done。

非关键问题和后续能力通过 [GitHub Issues](https://github.com/PANGKAIFENG/agent-task-loop/issues) 管理，MVP 不为未验证需求提前增加复杂度。

## 面向开发者

只有开发、测试或深度排障需要使用终端。开发环境需要 Node.js 24+ 与 pnpm 10+。

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

- 产品需求与能力边界：[Agent Task Loop V0.1 PRD](docs/PRD-Agent-Task-Loop-V0.1.md)
- 用户操作：[Obsidian 用户操作指南](docs/operations/obsidian-plugin.md)
- CLI 与本地开发：[开发者快速开始](docs/operations/developer-cli.md)
- 调度器维护：[本地研究任务调度](docs/operations/scheduler.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)

## 开源协议

Agent Task Loop 使用 [Apache License 2.0](LICENSE) 开源。你可以使用、修改和分发本项目；请保留许可证和版权声明。
