# 本地研究任务调度

Agent Task Loop 使用 macOS LaunchAgent 在 `Asia/Shanghai` 每小时运行一次，时段为
08:00 至 22:00，共 15 个触发点。每次触发只执行一个有界命令：

```text
<absolute-node> <absolute-repo>/build/server/cli.js runner run-once --driver claude
```

LaunchAgent 不通过 shell 启动，也不保存 API token、任务正文或其他 secret。它只保存
runner 所需的 ATL 路径、写入开关、driver、模型名、每日限额、`HOME` 和固定的最小
`PATH`。

## 安装前检查

1. 确认 macOS 系统时区是 `Asia/Shanghai`。其他时区会被安装命令拒绝。
2. 使用 Node.js 24，并在仓库根目录完成构建：

   ```bash
   node --version
   pnpm build
   ```

3. 设置绝对且已存在的路径。`ATL_ALLOWED_LOCAL_ROOTS` 使用系统 path delimiter
   分隔多个路径；macOS 上是冒号。

   ```bash
   export ATL_VAULT_ROOT=/absolute/path/to/vault
   export ATL_CLAUDE_BIN=/absolute/path/to/claude
   export ATL_CLAUDE_CONFIG_DIR=/absolute/path/to/claude-config
   export ATL_CLAUDE_MODEL=glm-4-flash
   export ATL_ALLOWED_LOCAL_ROOTS=/absolute/path/to/allowed-sources
   export ATL_DAILY_LIMIT=3
   ```

4. `ATL_CLAUDE_CONFIG_DIR` 指向 Claude CLI 已有的配置目录。它让受限子进程读取登录状态
   和 provider 配置，同时继续使用隔离的临时 `HOME`。plist 只保存该目录路径，不复制
   配置内容或 token。
5. `ATL_CLAUDE_MODEL` 必须显式设置为已经在当前 provider 验证可用的模型。更换模型后，
   应先在一次性 vault 中重新执行完整 smoke test，再更新调度器。
6. 在安装前确认该 Claude CLI 已完成交互式登录，并用其官方 auth status 命令核对当前
   身份。不要把 token 放进 ATL 环境变量或 plist。

安装命令必须从仓库根目录运行：

```bash
node build/server/cli.js scheduler install
node build/server/cli.js scheduler status
```

安装文件固定为：

```text
~/Library/LaunchAgents/ai.agent-task-loop.runner.plist
```

安装流程会先安全写入 plist，再用 `/usr/bin/plutil -lint` 校验，最后 bootstrap 到当前
用户的 `gui/$UID` domain。不同 Label 的同名文件不会被覆盖。

## 日志与手动运行

标准输出和错误日志分别位于：

```text
~/.local/state/agent-task-loop/runner.stdout.log
~/.local/state/agent-task-loop/runner.stderr.log
```

查看最近输出：

```bash
tail -n 100 ~/.local/state/agent-task-loop/runner.stdout.log
tail -n 100 ~/.local/state/agent-task-loop/runner.stderr.log
```

使用与调度器相同的环境变量手动执行一次：

```bash
node build/server/cli.js runner run-once --driver claude
```

`run-once` 在没有符合条件的 Ready task 时会结束，不应通过创建或自动确认任务来强行
验证调度器。

## 停用与恢复任务

停用 schedule：

```bash
node build/server/cli.js scheduler uninstall
```

该命令先从当前用户 domain bootout，再只删除固定路径下、Label 匹配且执行期间未变化的
managed plist。`scheduler status` 始终只读。

恢复一个经人工检查后可继续的 blocked task：

```bash
node build/server/cli.js task unblock \
  --task-id <task-id> \
  --feedback "说明阻塞已如何解除"
```

恢复后仍应检查任务的 acceptance criteria、权限边界和 `autoExecutable`，不要绕过人工确认。

## 当前 checkpoint 边界

V0.1 的技术门禁包含一次性 vault 中的真实 Claude research run，以及真实 vault 的只读
storage doctor 和队列检查。通过这些门禁只代表运行时和存储兼容性已经验证，不代表真实
个人任务已经经过长期运行观察。

两周观察期从用户确认第一个真实 Ready task 后开始。观察期内每个结果仍必须进入 Review，
由用户核对事实、证据和每条 acceptance criterion；不得把 scheduler 安装成功或一次性
smoke test 等同于真实任务质量验收。
