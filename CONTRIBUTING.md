# 参与贡献

Agent Task Loop 仍处于 MVP 阶段。欢迎通过 GitHub Issue 报告可复现的问题、提出具体使用场景，或提交范围清晰的 Pull Request。

## 提交 Issue

Bug 请包含：

- 使用的 ATL、Obsidian 和 TaskNotes 版本。
- 任务所在状态和触发操作。
- 实际结果、预期结果和可复现步骤。
- 已脱敏的错误信息或截图。

不要上传真实任务正文、个人笔记、Vault 路径、访问令牌或登录凭据。

功能建议请先说明用户问题和使用场景。MVP 优先修复任务丢失、越权执行、状态错误和无法验收等闭环问题；视觉细节和二期能力可能先记录而不立即开发。

## 本地开发

需要 Node.js 24+ 与 pnpm 10+：

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

测试必须使用临时 Fixture，不得连接真实 Vault。所有状态变更应通过 Service 层完成，Agent 执行不得直接修改领域状态。

## Pull Request

- 一个 PR 只处理一个明确问题。
- 行为变更需要相应测试。
- 不提交构建产物、个人数据、密钥或本机配置。
- PR 说明中写清用户影响、验证方式和已知边界。

提交贡献即表示你同意按本项目的 [Apache License 2.0](LICENSE) 授权该贡献。
