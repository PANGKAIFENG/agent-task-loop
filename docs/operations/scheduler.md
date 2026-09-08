# ATL 后台执行与维护

普通用户通过“Obsidian 设置 → Agent Task Loop → 后台执行”完成检测、启用、试跑、更新和停用，不需要使用本页的终端命令。本页后半部分只面向开发和深度排障。

## 用户可见行为

ATL 使用两个互相独立的 macOS LaunchAgent。Runner 每 15 分钟检查一次任务队列；DingTalk Stream listener 则保持一条官方 Stream 长连接，接收钉钉主动推送的机器人单聊回复。系统时区仍要求为 `Asia/Shanghai`，以便任务时间与本地记录保持一致。

Stream listener 不通过 DWS 或钉钉 API 轮询消息，因此不会用定时拉取来消耗消息 API 配额。它只接受已配置的机器人、企业、单聊会话和发送者；收到受信回复后交给本机 bridge 处理，再通过该次会话的 webhook 回执。Runner 与 Stream listener 的故障彼此隔离：前者不工作不会让 listener 改为轮询，后者不工作也不会影响本地任务真相。

每次检查先补发仍处于待验收状态的失败钉钉通知，再同步千问听记，最后最多领取一个符合条件的 Ready 调研任务。通知补发或听记同步失败都不会阻塞普通任务领取。已经发送、已经验收、稍后处理、已退回、冲突、发送结果不确定或内容安全校验失败的通知不会自动重发。没有合格任务时正常结束；调度器不会自动确认 Inbox 任务。

插件设置目前提供：

- 自动检测 ATL Runner、Node.js 24+、Claude Code 登录和后台任务；
- 用系统文件夹选择器授权本地资料来源；
- 启用或更新 ATL 管理的后台任务；
- “立即试跑”一次队列检查；
- 停用 ATL 管理的后台任务。

上述入口当前只管理 Runner。DingTalk Stream listener 是开发/运维入口，需要按本文的 CLI 步骤单独安装、检查和卸载；Obsidian UI 不会隐式创建、更新或删除第二个 LaunchAgent。

LaunchAgent 不通过 shell 启动，也不保存 API token 或任务正文。它只保存 Runner 所需的固定程序路径、Vault 路径、Claude 配置目录、模型名和已授权资料目录。

## 安全更新

后台配置固定保存在：

```text
~/Library/LaunchAgents/ai.agent-task-loop.runner.plist
~/Library/LaunchAgents/ai.agent-task-loop.dingtalk-stream.plist
```

ATL 只管理 Label 为 `ai.agent-task-loop.runner` 和 `ai.agent-task-loop.dingtalk-stream` 的对应配置。若同一路径存在不同 Label，安装会报告冲突并停止，不会覆盖或删除。

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
~/.local/state/agent-task-loop/dingtalk-stream.stdout.log
~/.local/state/agent-task-loop/dingtalk-stream.stderr.log
```

前两份日志用于排查任务是否被领取、运行失败原因和有界执行结果；后两份用于排查 Stream 连接、可信回复和回执失败。ATL 不应把 token、AppSecret、完整登录配置或未授权笔记写入日志。

每次实质执行前冻结的 Runtime Pack manifest 位于：

```text
<ATL 工作目录>/.atl-runtime/context-packs/<pack_id>.json
```

Manifest 只保存任务合同、来源引用、上下文块类型与哈希等运行证据，不复制来源文件正文。它还冻结本次 Execution Profile，包括角色、Skill 指令、Tool allowlist、必需 Context、输出合同、验收策略及其 SHA-256。`context_pack.frozen` Audit、成功 Artifact 的 `pack_id` 和 manifest 文件名应一致。决策续跑、失败重试和 Artifact 返工都必须使用新的 `run_id` 并重新冻结 Pack。

如果钉钉决策回复已经写入任务，但即时续跑因为 runner 正忙而未启动，下一次 15 分钟周期会优先恢复该决策续跑，不依赖钉钉重复推送同一事件。

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
atl-dingtalk-bridge.mjs
atl-dingtalk-stream.mjs
qianwen-accessibility-helper
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
```

`ATL_ALLOWED_LOCAL_ROOTS` 使用系统 path delimiter 分隔多个路径；macOS 上是冒号。不要把 token 放进 ATL 环境变量或 plist。

要安装 DingTalk Stream listener，还必须在同一终端配置以下非密钥参数：

```bash
export ATL_DINGTALK_PROFILE=<corpId>:<trusted-userId>
export ATL_DINGTALK_ROBOT_CODE=<robotCode>
export ATL_DWS_EXECUTABLE=/absolute/path/to/dws
export ATL_DINGTALK_UNIFIED_APP_ID=<unified-app-id>
export ATL_DINGTALK_TRUSTED_CONVERSATION_ID=<trusted-direct-conversation-id>
```

其中 `ATL_DINGTALK_PROFILE` 的用户部分必须是机器人单聊的可信发送者；启用 Artifact 钉钉通知时，Runner 也必须通过 `ATL_DWS_EXECUTABLE` 使用这个显式、已校验的 DWS 路径。`ATL_DINGTALK_TRUSTED_CONVERSATION_ID` 只能是该单聊会话。Stream listener 启动时通过 `dws dev app credentials get --unified-app-id ...` 临时读取应用凭据以建立连接。AppSecret 不得写入仓库、环境变量、plist、日志或命令历史。

仓库模式的维护命令：

```bash
node build/server/cli.js scheduler install
node build/server/cli.js scheduler status
node build/server/cli.js runner run-once --driver claude
node build/server/cli.js scheduler uninstall
node build/server/cli.js scheduler install-dingtalk-stream
node build/server/cli.js scheduler status-dingtalk-stream
node build/server/cli.js scheduler uninstall-dingtalk-stream
```

`scheduler status` 和 `scheduler status-dingtalk-stream` 始终只读。两种 `uninstall` 都先从当前用户 domain 卸载服务，再只删除固定路径下、Label 匹配且执行期间未变化的 managed plist。

查看最近日志：

```bash
tail -n 100 ~/.local/state/agent-task-loop/runner.stdout.log
tail -n 100 ~/.local/state/agent-task-loop/runner.stderr.log
tail -n 100 ~/.local/state/agent-task-loop/dingtalk-stream.stdout.log
tail -n 100 ~/.local/state/agent-task-loop/dingtalk-stream.stderr.log
```

## 通过钉钉验收和续跑

当 Agent 产出需要验收的 Artifact 时，Runner 会用配置的机器人向本人发送通知。通知不是验收本身；最终真相仍写回 Vault 的任务、Artifact 和 Audit。针对同一 Artifact，直接回复以下格式：

```text
接受 task-... v1
要求修改 task-... v1：反馈
阻塞 task-... v1：原因
取消 task-... v1：原因
```

“要求修改”“阻塞”“取消”必须提供冒号后的文本。要求修改会在记录验收结果后重新把任务交回 Agent 执行；其他结果不会静默启动额外工作。

当机器人提出决策问题时，可回复选项编号、`A/B` 或选项 ID。没有任务 ID 时，只有当前恰好一个等待决策的任务会被匹配；有多个时回复中必须包含 `task-...`。同一事件在处理期间的并发重投会合并执行；较晚到达或进程重启后的重投可能再次进入 bridge，但任务决策和 Artifact 验收记录会按事件 ID 保护真实状态，避免重复写入同一决策。

Runner 在任务进入 `waiting_for_decision` 后主动向本人发送决策题，并将投递结果写入 Vault 的 `.atl-runtime/decision-notifications.json`。通知采用 `任务 ID + decision request ID` 幂等；发送前会先记录 `unknown`，因此进程在钉钉已接收、但本地尚未记录成功之间中断时不会自动重发。若旧任务已经进入等待状态但当时未启用通知，可在确认任务仍等待同一问题后执行：

```bash
node build/server/cli.js task notify-decision \
  --task-id <task-id>
```

通知失败不会回滚已持久化的决策状态，也不会自动替用户选择选项。ledger 只保存投递元数据，不保存任务正文、问题或选项内容。

Stream listener 会在本机 bridge 处理完成并成功发回机器人回复后 ACK。处理时间较长时，钉钉可能重复推送同一事件；同一进程内会按事件 ID 合并，进程重启后的重复事件由任务决策和 Artifact 验收记录继续去重。若机器人回复发送失败，listener 不 ACK，允许钉钉再次推送；若 bridge 本身失败但通用错误提示已成功发给用户，则会 ACK，用户需要修复问题后重新发送原指令。

Artifact 通知在调用钉钉前会先写入“发送结果不确定”记录。若进程在钉钉已接收消息、但本地尚未记录成功之间中断，这条通知不会自动重发，以免产生重复消息。此时应直接在钉钉和 Obsidian 的“待验收”中核对，不要把未知状态当成发送失败。

恢复一个经人工检查后可继续的 Blocked 任务：

```bash
node build/server/cli.js task unblock \
  --task-id <task-id> \
  --feedback "说明阻塞已如何解除"
```

恢复后仍需检查任务的验收标准、权限边界和 `auto_executable`，不得绕过人工确认。

## 质量观察边界

`v0.9.1` 的技术门禁包含临时 Vault 中的 Runner 和 Stream 验证，以及真实 Vault 的受控 canary。安装成功或一次试跑成功，只代表运行环境和存储兼容性通过，不代表真实调研质量已经通过长期观察。

真实结果仍必须进入 Review，由用户核对事实、证据和每条验收标准；不得把调度器安装成功等同于任务完成。
