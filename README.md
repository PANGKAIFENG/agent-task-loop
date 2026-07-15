# Agent Task Loop

把散落在每日复盘和工作过程中的想法，变成一个可管理、可交给 Agent 做只读调研、最终由你验收的个人任务闭环。

Agent Task Loop 使用 Obsidian 兼容的 Markdown 文件保存任务。你拥有任务和数据，Agent 只处理你明确确认并授权的调研任务。

## 它解决什么问题

当你同时推进多个项目和 AI 会话时，新的想法、待办和调研需求会不断出现。Agent Task Loop 帮你把这些内容先收进统一 Inbox，再集中整理和分流：

- 候选想法先收下，不要求当场补全，减少工作中断和遗忘。
- 按项目和状态查看任务，区分待规划、待办、进行中、待验收和异常任务。
- 把边界清楚的公开资料调研交给 Agent 自动完成。
- Agent 提交结论、证据和不确定项后，任务停在待验收，是否完成由你决定。
- 所有任务、执行结果和审计记录保存在本地 Markdown 文件中。

## 你现在可以做什么

V0.1 已经支持：

- **统一收集任务**：通过 CLI 或上游自动化，把主动记录、每日复盘等来源写入 Inbox，并保留来源信息和去重键。
- **人工确认再执行**：补齐项目、目标、验收标准和权限后，由你明确确认任务是否进入 Ready。
- **项目化管理**：在本地看板查看 Inbox、待验收任务、项目列表和七列项目看板，并按状态、来源、优先级和是否允许自动执行筛选。
- **自动完成简单调研**：Claude Code 在受限环境中完成只读研究，受工具、目录、超时和预算约束。
- **结构化交付**：每次执行生成独立 Markdown Artifact，包含摘要、发现、证据、不确定项、建议动作和验收标准对照。
- **人工验收闭环**：你可以通过、退回、阻塞或取消；Agent 不能自行把任务标记为完成。
- **本地定时扫描**：macOS LaunchAgent 可在 08:00 至 22:00 每小时检查一次 Ready 队列，默认每天最多自动领取 3 个任务。
- **异常恢复**：支持停止执行、解除阻塞、退回重做和重新打开已完成任务。

## 每天怎么用

```text
记录想法或复盘待办
        ↓
Inbox：集中整理候选任务
        ↓  你补齐信息并确认
Ready：等待手动或定时执行
        ↓
In Progress：Agent 做有边界的只读调研
        ↓
Review：你检查结论和证据
        ↓
Done，或带反馈退回 Ready
```

任务主链路是 `Inbox → Ready → In Progress → Review → Done`。`Blocked` 表示需要人工处理后才能继续，`Cancelled` 表示不再执行。

| 看板状态 | 对你意味着什么 |
| --- | --- |
| 待规划 / Inbox | 已经收下，但还没有获得执行许可 |
| 待办 / Ready | 信息完整、已经确认，可以进入执行队列 |
| 进行中 / In Progress | Agent 已领取任务，正在执行 |
| 审核中 / Review | Artifact 已生成，等待你验收 |
| 已完成 / Done | 你已确认结果满足要求 |
| 已阻塞 / Blocked | 执行失败或缺少必要条件，需要人工处理 |
| 已取消 / Cancelled | 任务已停止，不再进入队列 |

## 自动执行的安全边界

只有同时满足以下条件的任务才可能被自动执行：

1. 任务处于 Ready。
2. 任务类型是 `research`。
3. 权限是 `read_only_research`。
4. 已关联项目，并有明确目标和至少一条验收标准。
5. 你主动设置了 `auto_executable=true`。

Agent 不能自动确认候选任务，不能修改代码、配置或正式日程，不能对外发送消息，也不能自动批准自己的结果。所有自动结果都进入 Review。

## 快速开始

### 1. 安装

需要 Node.js 24 或更高版本，以及 pnpm 10 或更高版本。

```bash
pnpm install
pnpm build
```

### 2. 连接你的 Obsidian Vault

将任务写入真实 Vault 前，必须同时提供绝对路径和显式写入许可：

```bash
export ATL_VAULT_ROOT="/absolute/path/to/your-vault"
export ATL_ALLOW_REAL_WRITES=1
```

建议先进行只读健康检查：

```bash
pnpm --silent atl doctor --json
pnpm --silent atl task list --status inbox --json
```

`doctor` 只报告重复任务 ID、无效 frontmatter、生命周期路径错误和索引异常，不会自动修改文件。

### 3. 创建项目并记录任务

```bash
pnpm atl project create \
  --project-id product-research \
  --name "产品调研" \
  --description "收集并验证公开产品信息"

TASK_ID="$(pnpm --silent atl task capture \
  --title "调研一个公开产品" \
  --body "梳理产品定位、核心能力和公开定价。" \
  --origin manual_cli \
  --source-date 2026-07-15 \
  --source-key manual:product-research:001 \
  --priority high \
  --json | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).taskId")"
```

`origin` 用来标记任务来源，`source-key` 用于避免同一来源重复导入。每日复盘自动化也可以调用同一个 `task capture` 入口，但 V0.1 不内置特定笔记格式的复盘解析器。

### 4. 确认任务

```bash
pnpm atl task confirm \
  --task-id "$TASK_ID" \
  --project-id product-research \
  --objective "基于公开资料梳理产品定位、能力和定价" \
  --acceptance-criterion "引用至少一个官方 HTTPS 页面" \
  --acceptance-criterion "明确区分事实和待验证信息" \
  --priority high \
  --auto-executable
```

确认后，任务才会从 Inbox 进入 Ready。查看下一个可执行任务不会改变任务状态：

```bash
pnpm --silent atl task next --json
```

### 5. 打开本地看板

配置 Claude Code 运行环境后启动服务：

```bash
export ATL_CLAUDE_BIN="/absolute/path/to/claude"
export ATL_CLAUDE_CONFIG_DIR="/absolute/path/to/claude-config"
export ATL_CLAUDE_MODEL="your-supported-model"
export ATL_ALLOWED_LOCAL_ROOTS="/absolute/path/to/allowed-read-only-sources"

pnpm board:server
```

打开 [http://127.0.0.1:4173/inbox](http://127.0.0.1:4173/inbox)。本地看板只绑定 `127.0.0.1`，当前提供：

- `/inbox`：候选任务及缺失信息。
- `/review`：待验收结果及证据数量。
- `/projects`：项目列表。
- `/projects/:id`：按项目查看完整状态看板。

V0.1 的看板主要用于查看和管理任务全局状态。快速记录按钮和完整的可视化编辑流程尚未开放；可信的状态变更仍通过 CLI 完成。

## 执行与验收

手动执行一个已确认任务：

```bash
pnpm atl runner run-task --task-id "$TASK_ID" --driver claude
```

检查 Runner 状态：

```bash
pnpm --silent atl runner status --json
```

Agent 提交结果后，任务会进入 Review。验收通过：

```bash
pnpm atl task review --task-id "$TASK_ID" --approve
```

退回修改、标记阻塞或取消任务时需要写明反馈：

```bash
pnpm atl task review --task-id "$TASK_ID" --request-changes --feedback "补充官方定价证据。"
pnpm atl task review --task-id "$TASK_ID" --block --feedback "需要先确认研究范围。"
pnpm atl task review --task-id "$TASK_ID" --cancel --feedback "不再需要这项调研。"
```

常用恢复操作：

```bash
pnpm atl task stop --task-id "$TASK_ID"
pnpm atl task unblock --task-id "$TASK_ID" --feedback "范围已经补充。"
pnpm atl task reopen --task-id "$TASK_ID" --feedback "需要补充新的公开证据。"
```

## 自动调度

在 macOS 上安装调度器前，先完成构建并设置 Claude Code 相关环境变量。然后运行：

```bash
node build/server/cli.js scheduler install
node build/server/cli.js scheduler status
```

默认调度策略：

- 时区：`Asia/Shanghai`。
- 时段：每天 08:00 至 22:00，每小时触发一次。
- 单次：最多领取 1 个符合条件的任务。
- 并发：1。
- 每日自动领取上限：3，可通过 `ATL_DAILY_LIMIT` 调整。

详细安装、日志、停用和恢复说明见 [本地研究任务调度](docs/operations/scheduler.md)。

## 数据保存在哪里

任务源数据位于 Vault 的 `10_Tasks`：

```text
10_Tasks/
├── Inbox/       # 未确认的候选任务
├── Active/      # Ready、In Progress、Review、Blocked
├── Archive/     # Done、Cancelled
├── Artifacts/   # 每次执行产生的独立结果
└── _System/     # 索引、审计记录和内部状态
```

个人任务正文、原始笔记和 Claude 登录凭据不会写入本仓库。Agent 执行只允许写入受控的任务元数据、审计记录和 Artifact。

## 当前 MVP 边界

以下能力不属于 V0.1，README 不将它们视为已交付功能：

- 自动理解、扩写或补全信息不完整的 Inbox 任务。
- 在看板中完成全部新增、编辑、确认和验收操作。
- Agent、Skill、小队管理和多 Agent 编排。
- 团队协作、云同步和 SaaS 托管。
- 自动判断事实正确并将任务直接置为 Done。

V0.1 的核心目标是先把“收集、管理、读取、简单调研、人工验收”跑成可靠的个人闭环。

## 完整的安全演练

首次验证请使用一次性 Vault，不要直接操作真实个人数据：

```bash
export ATL_VAULT_ROOT="$(mktemp -d -t atl-manual-XXXXXX)"
cp -R tests/fixtures/vault/. "$ATL_VAULT_ROOT/"
unset ATL_ALLOW_REAL_WRITES

pnpm atl project create \
  --project-id public-research \
  --name "Public research" \
  --description "Research only public sources."

TASK_ID="$(pnpm --silent atl task capture \
  --title "Review public pricing" \
  --body "Compare the public pricing page." \
  --origin manual_cli \
  --source-date 2026-07-15 \
  --source-key manual:readme:pricing \
  --priority high \
  --json | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).taskId")"

pnpm --silent atl task list --status inbox --json

pnpm atl task confirm \
  --task-id "$TASK_ID" \
  --project-id public-research \
  --objective "Compare public pricing using official evidence." \
  --acceptance-criterion "Cite an official HTTPS page." \
  --priority high \
  --auto-executable

pnpm --silent atl task next --json

pnpm atl task next \
  --claim \
  --task-id "$TASK_ID" \
  --agent human-supervised \
  --run-id run-readme-001

cat > "$ATL_VAULT_ROOT/result.json" <<'JSON'
{
  "summary": "Pricing was reviewed.",
  "findings": ["A public plan exists."],
  "evidence": [
    {
      "title": "Official pricing",
      "url": "https://example.com/pricing",
      "accessedAt": "2026-07-15T09:00:00.000Z"
    }
  ],
  "uncertainties": [],
  "recommendedActions": ["Review again next quarter."],
  "acceptance": [
    {
      "criterion": "Cite an official HTTPS page.",
      "status": "met",
      "note": "The official pricing page was cited."
    }
  ]
}
JSON

pnpm atl task submit \
  --task-id "$TASK_ID" \
  --run-id run-readme-001 \
  --result "$ATL_VAULT_ROOT/result.json"

pnpm atl task review --task-id "$TASK_ID" --approve
pnpm --silent atl doctor --json
find "$ATL_VAULT_ROOT/10_Tasks/Archive" -name "$TASK_ID.md"
find "$ATL_VAULT_ROOT/10_Tasks/Artifacts/$TASK_ID" -name 'attempt-*.md'
```

`task next --json` 是只读操作。受监督领取必须显式提供 `--claim`、`--task-id` 和 `--run-id`，不会消耗自动执行的每日额度。

## 开发与验证

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

产品需求和完整边界见 [Agent Task Loop V0.1 PRD](docs/PRD-Agent-Task-Loop-V0.1.md)。
