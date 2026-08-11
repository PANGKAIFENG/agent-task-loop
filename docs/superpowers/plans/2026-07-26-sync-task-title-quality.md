# 同步助手任务标题质量实施计划

## 任务 1：约束新候选标题

**文件**

- 修改：`src/obsidian-plugin/candidate-extractor.ts`
- 测试：`tests/unit/obsidian-plugin/candidate-extractor.test.ts`

**步骤**

1. 先增加测试，断言提示词包含行动导向、明确对象、避免模糊标题和禁止编造的规则，并断言超过 60 个字符的模型标题被拒绝。
2. 运行聚焦测试并确认新测试按预期失败。
3. 收紧 Zod/JSON Schema 的标题上限，补齐提示词规则。
4. 再次运行聚焦测试并确认通过。

## 任务 2：实现旧标题扫描与安全修复

**文件**

- 新增：`src/services/repair-legacy-task-titles.ts`
- 新增：`src/storage/markdown-task-title-repair-repository.ts`
- 新增：`src/obsidian-plugin/legacy-task-title-repair-controller.ts`
- 测试：`tests/integration/services/repair-legacy-task-titles.test.ts`
- 测试：`tests/integration/storage/markdown-task-title-repair-repository.test.ts`

**步骤**

1. 先用临时 Vault fixture 覆盖缺失、`null`、空字符串、已有标题、无 H1、非任务、代码块伪 H1和幂等场景。
2. 运行新增测试并确认因模块不存在或行为缺失而失败。
3. 实现只读预览 service 和授权写入 service。
4. 实现限定目录、安全读取、最小 Frontmatter 修改、重新判定与索引刷新。
5. 运行聚焦测试并确认通过。

## 任务 3：接入 Obsidian 确认交互

**文件**

- 新增：`src/obsidian-plugin/legacy-task-title-repair-modal.ts`
- 修改：`src/obsidian-plugin/main.ts`
- 修改：`src/obsidian-plugin/styles.css`
- 测试：`tests/unit/obsidian-plugin/legacy-task-title-repair-modal.test.ts`
- 测试：`tests/unit/obsidian-plugin/legacy-task-title-repair-controller.test.ts`

**步骤**

1. 先写弹窗和 controller 测试，覆盖预览统计、取消、重复提交、权限复查、完成统计和失败反馈。
2. 运行聚焦测试并确认失败。
3. 实现居中确认弹窗、controller 和命令注册。
4. 运行聚焦测试并确认通过。

## 任务 4：验证、审查与交付

1. 运行 `fnm exec --using 24 pnpm test`。
2. 运行 `fnm exec --using 24 pnpm typecheck`。
3. 运行 `fnm exec --using 24 pnpm lint`。
4. 运行 `fnm exec --using 24 pnpm build`。
5. 独立审查 diff：真实 Vault 写入边界、并发覆盖、已有标题保护、正文不变、路径不变、错误反馈与索引刷新。
6. 按清晰变更提交，推送分支并创建 PR；合并后按现有发布流程上线并验证安装包。
