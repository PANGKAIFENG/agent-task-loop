# 开发者快速开始

这份文档面向 ATL Core 的开发、自动调研引擎部署和故障维护。普通用户安装 Obsidian 插件和确认任务不需要执行这些命令。

## 环境

- Node.js 24+
- pnpm 10+

```bash
pnpm install
pnpm build
```

## 使用临时 Vault 验证 CLI

首次验证应使用临时 Vault，不要直接操作个人数据：

```bash
export ATL_VAULT_ROOT="$(mktemp -d -t atl-manual-XXXXXX)"
cp -R tests/fixtures/vault/. "$ATL_VAULT_ROOT/"
unset ATL_ALLOW_REAL_WRITES
```

创建一个项目：

```bash
pnpm atl project create \
  --project-id public-research \
  --name "Public research" \
  --description "Research only public sources."
```

记录任务，并从机器可读的 JSON 输出中取得任务 ID：

```bash
TASK_ID="$(pnpm --silent atl task capture \
  --title "Review public pricing" \
  --body "Compare the public pricing page." \
  --origin manual_cli \
  --source-date 2026-07-15 \
  --source-key manual:developer-cli:pricing \
  --priority high \
  --json | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).taskId")"

pnpm --silent atl task list --status inbox --json
```

确认任务：

```bash
pnpm atl task confirm \
  --task-id "$TASK_ID" \
  --project-id public-research \
  --objective "Compare public pricing using official evidence." \
  --acceptance-criterion "Cite an official HTTPS page." \
  --priority high \
  --auto-executable
```

`pnpm --silent atl task next --json` 只读取队列，不会领取任务。连接 Claude Code、执行任务和安装调度器前，请继续阅读[本地研究任务调度](scheduler.md)。

## 连接真实 Vault

写入真实 Vault 必须同时设置绝对路径和显式许可：

```bash
export ATL_VAULT_ROOT="/absolute/path/to/your-vault"
export ATL_ALLOW_REAL_WRITES=1
```

先运行只读健康检查：

```bash
pnpm --silent atl doctor --json
pnpm --silent atl task list --status inbox --json
```

`doctor` 只报告重复任务 ID、无效 frontmatter、生命周期路径错误和索引异常，不会自动修改文件。
