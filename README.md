# Agent Task Loop

把每天不断出现的想法和待办收进 Obsidian，整理成 Agent 能安全执行、最终由你验收的个人任务闭环。

> 当前版本：`v0.1.0` MVP。适合希望同时管理多个项目、经常与多个 AI 会话并行工作的个人用户。

![Agent Task Loop 工作流](docs/diagrams/agent-task-loop-core-flow.drawio.svg)

## 为什么做这个产品

工作中最容易丢失的不是正式任务，而是会议后的一个想法、AI 会话里产生的后续动作，以及每日复盘中尚未整理的待办。它们通常散落在笔记、聊天和脑中；当并行事项增加，用户既没有精力立即补全，也很难再回头找到。

Agent Task Loop（ATL）提供一个个人任务中枢：

- 先收集，不要求当场想清楚，避免打断当前工作。
- 再确认，由用户补齐项目、目标、验收标准和执行权限。
- 后执行，只把边界明确的只读调研交给 Agent。
- 最后验收，Agent 提交证据和结果，是否完成仍由用户决定。

ATL 使用 Obsidian 兼容的 Markdown 文件保存任务。数据留在你的 Vault 中，不依赖云端任务数据库。

## 产品如何组成

ATL 不是 TaskNotes 的二次开发，也不会修改 TaskNotes。两者通过 Obsidian 的标准插件和 Markdown 文件机制协作：

| 组件 | 用户看到的价值 |
| --- | --- |
| TaskNotes | 提供可视化任务卡片、看板、筛选、日历和状态浏览 |
| ATL Obsidian 插件 | 提供任务确认弹窗、项目创建、目标与验收标准填写、Vault 授权 |
| ATL Core | 负责状态校验、文件移动、索引、审计、调度和 Agent 执行 |

TaskNotes 负责“看清任务”，ATL 负责“让任务达到可执行标准，并受控地交给 Agent”。

## 当前产品能力

### 1. 统一收集

主动记录、每日复盘或其他自动化产生的候选任务可以进入同一个 Inbox。任务保留来源日期、来源类型和去重标识；同一来源不会被重复导入。

### 2. 在 Obsidian 中确认任务

从 Inbox 任务的文件菜单选择“确认并移到待执行”，会打开 Obsidian 原生风格的居中弹窗。你可以：

- 选择已有项目，或直接新建项目。
- 写清本次任务真正要达成的目标。
- 添加至少一条可检查的验收标准。
- 设置优先级。
- 决定是否允许 Agent 自动执行。

未经确认的候选任务不会进入自动执行队列。

### 3. 按项目和状态管理

每个任务都处于一个清晰状态：

| 看板状态 | 含义 |
| --- | --- |
| 收件箱 / Inbox | 已收集，尚未确认是否执行 |
| 待执行 / Ready | 信息完整，已获得执行许可 |
| 执行中 / In Progress | Agent 或人工正在处理 |
| 待验收 / Review | 已生成结果，等待用户判断 |
| 已完成 / Done | 用户确认结果满足要求 |
| 已阻塞 / Blocked | 缺少条件或执行失败，需要处理 |
| 已取消 / Cancelled | 已停止，不再进入队列 |

### 4. 自动完成简单调研

ATL Core 可以把符合条件的 Ready 任务交给受限 Agent。每次执行都会生成独立 Markdown Artifact，包含：

- 结论摘要和主要发现。
- 引用证据及访问时间。
- 尚不确定的信息。
- 建议的后续动作。
- 对每条验收标准的完成说明。

### 5. 人工验收与恢复

Agent 的结果只会进入 Review，不会自动变成 Done。用户可以验收通过、带反馈退回、标记阻塞或取消，并可停止执行、解除阻塞或重新打开已完成任务。

## 一天中的使用方式

```text
工作或复盘中产生想法
          ↓
Inbox：先统一收下
          ↓  用户选择项目、目标和验收标准
Ready：等待执行
          ↓  Agent 只读调研
In Progress：执行中
          ↓  生成带证据的 Artifact
Review：用户验收
          ↓
Done，或带反馈退回
```

典型的日常操作是：打开 TaskNotes 看板，集中处理 Inbox；把适合调研的任务确认到 Ready；再到 Review 检查 Agent 结果。任务确认过程不需要使用终端。

## 安装 Obsidian 插件

ATL 尚未进入 Obsidian 社区插件市场，目前通过 GitHub Release 安装，全程可以在 Finder 和 Obsidian 中完成：

1. 打开本仓库的 [Releases](https://github.com/PANGKAIFENG/agent-task-loop/releases)，下载最新的 `agent-task-loop-v0.1.0.zip`。
2. 解压后得到 `main.js`、`manifest.json` 和 `styles.css`。
3. 在 Finder 中打开你的 Vault，按 `Command + Shift + .` 显示隐藏文件。
4. 进入 `.obsidian/plugins/`，新建 `agent-task-loop` 文件夹，把三个文件放入其中。
5. 重启 Obsidian，在“设置 → 第三方插件”中启用 `Agent Task Loop`。
6. 打开“设置 → Agent Task Loop”，开启“允许 ATL 管理此 Vault”。

授权默认关闭。开启后，ATL 只管理当前 Vault 的 `10_Tasks` 目录。完整图文操作和字段示例见[在 Obsidian 中确认 ATL 任务](docs/operations/obsidian-plugin.md)。

### 使用前提

- Obsidian 桌面版 `1.8.0` 或更高版本。
- 已安装 TaskNotes，用于可视化任务看板。
- Vault 中已经存在 ATL 的 `10_Tasks` 目录结构和候选任务。

> `v0.1.0` 已实现无终端的插件安装和日常任务确认。自动调研引擎与定时调度仍需要一次开发者部署，尚未由插件自动安装或启动；这是公开 MVP 的明确边界。

## 什么任务可以交给 Agent

只有同时满足以下条件的任务才可能被自动领取：

1. 状态为 Ready。
2. 类型为 `research`。
3. 权限为 `read_only_research`。
4. 已关联项目，且有明确目标和至少一条验收标准。
5. 用户主动开启 `auto_executable=true`。

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

个人任务正文、原始笔记和 Agent 登录凭据不会写入本 GitHub 仓库。测试使用独立的临时 Vault，不读取真实个人任务。

## MVP 边界与下一步

`v0.1.0` 先验证“收集、管理、读取、简单调研、人工验收”能否成为可靠闭环。以下能力尚未包含：

- 自动理解和扩写信息不完整的 Inbox 任务。
- 由 Obsidian 插件自动安装、连接和维护 Agent 运行环境。
- 在可视化看板中完成全部新增、编辑、执行和验收操作。
- Agent、Skill、小队及多 Agent 编排。
- 团队协作、云同步、SaaS 托管和移动端。
- 自动判断事实正确并把任务直接标记为 Done。

非关键问题和后续能力通过 [GitHub Issues](https://github.com/PANGKAIFENG/agent-task-loop/issues) 管理，MVP 不为未验证需求提前增加复杂度。

## 面向开发者

本仓库同时包含 ATL Core、本地看板和 Obsidian 插件。开发环境需要 Node.js 24+ 与 pnpm 10+。

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

- 产品需求与能力边界：[Agent Task Loop V0.1 PRD](docs/PRD-Agent-Task-Loop-V0.1.md)
- Obsidian 插件说明：[在 Obsidian 中确认 ATL 任务](docs/operations/obsidian-plugin.md)
- CLI 与本地开发：[开发者快速开始](docs/operations/developer-cli.md)
- 调度器维护说明：[本地研究任务调度](docs/operations/scheduler.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)

## 开源协议

Agent Task Loop 使用 [Apache License 2.0](LICENSE) 开源。你可以使用、修改和分发本项目；请保留许可证和版权声明。
