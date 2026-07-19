# Agent Task Loop

Agent Task Loop（ATL）是一套运行在 Obsidian 里的个人待办工作流：把工作、微信同步笔记和每日复盘中不断出现的想法统一收进 Inbox，再由你自己安排、推进和完成。需要时，可以让 AI 帮你整理任务，或把调研任务交给后台 Agent。

> 当前是个人使用优先的 MVP。Markdown 是唯一事实源，任务不会被锁在某个云端服务中。

![Agent Task Loop 工作流](docs/diagrams/agent-task-loop-core-flow.drawio.svg)

## 你可以怎么用

最轻量的用法不需要自动 Agent：

1. **收集**：在 Obsidian 随手新建，或从“笔记同步助手”提取待办。
2. **决定**：在 Inbox 中保留、忽略，或点击“移到待办”。普通任务只需要标题。
3. **安排**：在 TaskNotes 看板中拖动状态，在日历中安排日期和时间。
4. **推进**：自己把任务从“待办”移到“进行中”，完成后移到“已完成”。
5. **需要 AI 时再用**：让 AI 整理目标和完成条件，复制给 Codex，或授权 ATL Runner 做只读调研。

默认看板只有四列：

```text
收件箱 → 待办 → 进行中 → 已完成
 Inbox     Ready   In Progress   Done
```

这四列只是推荐起点。状态由 TaskNotes 管理，你可以改显示名称、调整顺序或增加“等待回复”“以后再做”等状态；ATL 会保留这些自定义状态，不会强制改回固定七列。

## 产品能力

### 1. 统一收件箱

- 点击 Obsidian 左侧“ATL：新建任务”，立即记录一个想法。
- 把想法发给“笔记同步助手”后，点击“ATL：从同步助手获取待办”，实时提取候选。
- 每日复盘也可以通过同一 ATL 收集服务提交候选。
- 实时扫描与每日复盘共用 `sourceKey` 去重，同一来源的同一行动只保留一条。
- AI 产生的候选始终进入 Inbox，不会直接开始执行。

### 2. 人工优先的任务管理

在 Inbox 任务的文件菜单中选择“移到待办”，会打开 Obsidian 原生居中弹窗：

- 项目可选；
- 目标可选；
- 完成条件可选；
- 优先级可调整；
- 普通任务不会自动授权给 Agent。

因此，“记下一个待办”和“定义一个可自动执行的任务”不再是同一件事。你可以先只写标题，后面再补充。

### 3. 可视化看板与日历

[TaskNotes](https://github.com/callumalpass/tasknotes) 负责卡片、看板、筛选和日历，ATL 负责收集、去重、任务文件和可选自动化。ATL 不是 TaskNotes 的 fork，也不会修改 TaskNotes 插件代码或私有配置。

ATL 可以为 `10_Tasks/Views/任务总看板.base` 应用默认四列布局，并在首次修改时保存 `.atl-backup`。之后仍可直接使用 TaskNotes 自定义状态和视图。

### 4. AI 帮我整理

“移到待办”弹窗中可以填写一句补充说明，再点击“AI 帮我整理”。AI 只回填：

- 一个清晰的任务目标；
- 1 至 5 条可检查的完成条件。

生成结果仍可编辑。AI 不会在这个步骤执行任务、读取其他文件或替你选择项目和优先级；AI 不可用也不影响把任务移到待办。

### 5. 复制给 Codex

任意 ATL 任务文件的菜单中都可以选择“复制给 Codex”。剪贴板内容包含任务文件绝对路径、标题、正文、项目、目标、完成条件、状态和来源摘要。粘贴到 Codex 后即可继续工作。

这个动作只复制上下文，不启动进程、不自动修改任务。

### 6. 可选的自动调研

ATL Runner 可以在每天 `08:00` 至 `22:00` 的每个整点检查一次队列，并执行明确授权的只读调研。只有同时满足以下条件的任务才会被领取：

1. 状态为 `ready`；
2. 类型为 `research`；
3. 已关联项目；
4. 已填写目标和至少一条完成条件；
5. 权限为 `read_only_research`；
6. 用户显式设置 `auto_executable=true`。

普通手工待办默认是 `auto_executable=false`，不会被 Runner 领取。

## 安装

ATL 尚未进入 Obsidian 社区插件市场。安装插件本身不需要终端：

1. 打开 [GitHub Releases](https://github.com/PANGKAIFENG/agent-task-loop/releases)，下载最新的插件压缩包。
2. 解压并确认包含 `main.js`、`manifest.json`、`styles.css` 和 `atl-runner.mjs`。
3. 在 Finder 中打开 Vault，按 `Command + Shift + .` 显示隐藏文件。
4. 进入 `.obsidian/plugins/`，创建 `agent-task-loop` 文件夹并放入上述文件。
5. 重启 Obsidian，在“设置 → 第三方插件”中启用 `Agent Task Loop`。

推荐同时安装 TaskNotes，以获得看板和日历体验。

### 能力前提

| 你要使用的能力 | 需要什么 |
| --- | --- |
| 随手新建、Inbox、手工看板管理 | Obsidian 桌面版、ATL；推荐 TaskNotes |
| 从同步助手提取、AI 帮我整理 | 已登录的 Claude Code；可沿用 CC-Switch 配置 |
| 定时自动调研 | Node.js 24+、Claude Code、启用 ATL 后台执行 |

ATL 不保存 API Key。Model 和 Base URL 可在插件设置中配置；登录和密钥仍由 Claude Code 或系统环境管理。

## 第一次使用

1. 打开“设置 → Agent Task Loop”。
2. 开启“允许 ATL 管理此 Vault”。
3. 在“任务看板”中点击“应用人工任务布局”。
4. 点击左侧“ATL：新建任务”，创建第一条 Inbox 任务。
5. 在任务文件菜单中选择“移到待办”。
6. 在 TaskNotes 看板中拖动任务，或在日历中安排时间。

只有要使用 AI 整理、同步提取或自动调研时，才需要继续配置 Claude Code、Model、Base URL 和后台执行。

完整步骤见[Obsidian 用户操作指南](docs/operations/obsidian-plugin.md)。

## 数据保存在哪里

```text
10_Tasks/
├── Inbox/       # 新收集、尚未决定的任务
├── Active/      # 已进入日常管理的任务
├── Archive/     # ATL 归档的完成或取消任务
├── Projects/    # 可选的项目上下文
├── Artifacts/   # Agent 调研结果
└── _System/     # 索引、审计和内部状态
```

TaskNotes 的 `scheduled`、`due` 等字段和其他未知 frontmatter 会原样保留。个人任务正文、原始笔记和 Agent 登录凭据不会写入本 GitHub 仓库。

## 当前边界

MVP 已覆盖人工收集、轻量推进、自定义状态、看板、日历、AI 字段整理、Codex 交接和受控调研。当前仍不包含：

- 多轮对话式任务规划；
- Agent、Skill、小队和多 Agent 编排；
- 团队协作、云同步、SaaS 托管和移动端；
- Obsidian 内完整的 Review 验收按钮与异常恢复工作台；
- 自动判断事实正确并把任务标记为 Done。

底层服务已经支持验收通过、带反馈退回、标记阻塞和取消，但当前 Obsidian 界面只能查看 Review 任务与 Artifact。非关键问题通过 [GitHub Issues](https://github.com/PANGKAIFENG/agent-task-loop/issues) 管理，MVP 不为未验证需求提前增加复杂度。

## 面向开发者

只有开发、测试和深度排障需要终端。开发环境需要 Node.js 24+ 与 pnpm 10+。

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

- 产品需求：[Agent Task Loop V0.1 PRD](docs/PRD-Agent-Task-Loop-V0.1.md)
- 用户操作：[Obsidian 用户操作指南](docs/operations/obsidian-plugin.md)
- CLI 与本地开发：[开发者快速开始](docs/operations/developer-cli.md)
- 调度器维护：[本地研究任务调度](docs/operations/scheduler.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题：[SECURITY.md](SECURITY.md)

## 开源协议

Agent Task Loop 使用 [Apache License 2.0](LICENSE) 开源。
