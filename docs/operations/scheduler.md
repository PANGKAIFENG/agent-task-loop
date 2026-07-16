# ATL 后台执行与维护

普通用户通过“Obsidian 设置 → Agent Task Loop → 后台执行”完成检测、启用、试跑、更新和停用，不需要使用本页的终端命令。本页后半部分只面向开发和深度排障。

## 用户可见行为

ATL 使用 macOS LaunchAgent，在 `Asia/Shanghai` 时区每天 `08:00` 至 `22:00` 的每个整点检查一次任务队列，共 15 个触发点。

每次检查最多领取一个符合条件的 Ready 调研任务。没有合格任务时正常结束；调度器不会自动确认 Inbox 任务。

插件设置提供：

- 自动检测 ATL Runner、Node.js 24+、Claude Code 登录和后台任务；
- 用系统文件夹选择器授权本地资料来源；
- 启用或更新 ATL 管理的后台任务；
- “立即试跑”一次队列检查；
- 停用 ATL 管理的后台任务。

LaunchAgent 不通过 shell 启动，也不保存 API token 或任务正文。它只保存 Runner 所需的固定程序路径、Vault 路径、Claude 配置目录、模型名、每日限额和已授权资料目录。

## 安全更新

后台配置固定保存在：

```text
~/Library/LaunchAgents/ai.agent-task-loop.runner.plist
```

ATL 只管理 Label 为 `ai.agent-task-loop.runner` 的配置。若同一路径存在不同 Label，插件会报告冲突并停止，不会覆盖或删除。

更新已运行的服务时，ATL 会：

1. 原子写入并校验新 plist；
2. 卸载旧服务；
3. 加载新服务；
4. 若加载失败，恢复旧 plist 并重新加载旧服务。

## 日志

标准输出和错误日志位于：

```text
~/.local/state/agent-task-loop/runner.stdout.log
~/.local/state/agent-task-loop/runner.stderr.log
```

日志用于排查任务是否被领取、运行失败原因和有界执行结果。ATL 不应把 token、完整登录配置或未授权笔记写入日志。

## 开发者：构建与手动安装

以下命令只用于开发或深度维护。普通用户应使用 Obsidian 设置页面。

```bash
node --version
pnpm build
```

发布构建会在 `build/obsidian-plugin/` 生成：

```text
main.js
manifest.json
styles.css
atl-runner.mjs
```

Runner 的实际启动形式是：

```text
<absolute-node> <plugin-directory>/atl-runner.mjs runner run-once --driver claude
```

需要使用 CLI 手动验证时，先设置绝对且存在的路径：

```bash
export ATL_VAULT_ROOT=/absolute/path/to/vault
export ATL_CLAUDE_BIN=/absolute/path/to/claude
export ATL_CLAUDE_CONFIG_DIR=/absolute/path/to/claude-config
export ATL_CLAUDE_MODEL=claude-sonnet-4-5
export ATL_ALLOWED_LOCAL_ROOTS=/absolute/path/to/allowed-sources
export ATL_DAILY_LIMIT=3
```

`ATL_ALLOWED_LOCAL_ROOTS` 使用系统 path delimiter 分隔多个路径；macOS 上是冒号。不要把 token 放进 ATL 环境变量或 plist。

仓库模式的维护命令：

```bash
node build/server/cli.js scheduler install
node build/server/cli.js scheduler status
node build/server/cli.js runner run-once --driver claude
node build/server/cli.js scheduler uninstall
```

`scheduler status` 始终只读。`scheduler uninstall` 先从当前用户 domain 卸载服务，再只删除固定路径下、Label 匹配且执行期间未变化的 managed plist。

查看最近日志：

```bash
tail -n 100 ~/.local/state/agent-task-loop/runner.stdout.log
tail -n 100 ~/.local/state/agent-task-loop/runner.stderr.log
```

恢复一个经人工检查后可继续的 Blocked 任务：

```bash
node build/server/cli.js task unblock \
  --task-id <task-id> \
  --feedback "说明阻塞已如何解除"
```

恢复后仍需检查任务的验收标准、权限边界和 `auto_executable`，不得绕过人工确认。

## 质量观察边界

`v0.2.0` 的技术门禁包含临时 Vault 中的 Runner 验证，以及真实 Vault 的受控只读检查。安装成功或一次试跑成功，只代表运行环境和存储兼容性通过，不代表真实调研质量已经通过长期观察。

真实结果仍必须进入 Review，由用户核对事实、证据和每条验收标准；不得把调度器安装成功等同于任务完成。
