# Eval 反馈闭环产品契约

## 1. 要解决的问题

一次 Agent 执行完成后，用户通常只做“通过”或“退回”。如果系统没有把这次执行使用的 Context、能力配置、结果和人工结论关联起来，下一次就无法回答两个关键问题：什么配置真正有效，以及哪些失败值得变成长期回归用例。

ATL 的首版目标不是让 Agent 自动改造自己，而是先把真实执行反馈变成可核对、可积累的候选资产。

## 2. 用户闭环

```text
Agent 执行
  -> 冻结 Runtime Pack 与 Execution Profile
  -> 提交 Artifact
  -> 用户验收
  -> 生成待审查 capability Eval 样本
  -> 负反馈额外生成 regression candidate
  -> 后续人工决定是否晋升为正式 Eval
```

每条样本回答四个产品问题：

1. 当时要完成什么任务，以及对应哪次运行；
2. 当时实际用了哪一版 Context Pack 和 Execution Profile；
3. Agent 交付了哪一版 Artifact；
4. 用户最终通过、要求修改、阻塞还是取消。

## 3. 首版决策

### 所有受控运行都先成为 capability 样本

只有同时具备完整 Runtime Pack、Execution Profile 和 Artifact 锚点的人工验收，才会生成 Eval 样本。历史任务、旧版验收以及手工提交但没有 Runtime Pack 的 Artifact 继续兼容原工作流，但不进入 Eval 列表。

样本初始状态固定为 `pending_review`。这表示“证据已收集，尚未成为正式评测集”，不表示 Agent 能力已经通过评测。

### 负反馈只成为回归候选

`request_changes`、`block` 和 `cancel` 且带有反馈时，会额外进入 `regressionCandidates`。首版只记录候选，不提供自动晋升；`approve` 不生成回归候选。

### 人工结论不直接改 Harness

验收结果不会自动修改：

- Execution Profile；
- Agent 定义；
- Skill 指令；
- Tool allowlist；
- Context 路由；
- Prompt 或模型选择。

每条样本都明确记录 `harnessMutationAllowed: false`。后续只有经过人工归类、去敏、补齐预期结果和评分规则的候选，才能作为独立版本化变更进入正式 Eval 集。

## 4. 记录与隐私边界

样本使用 Audit 中已有的稳定锚点，不复制原始上下文或反馈正文：

| 记录 | 用途 |
| --- | --- |
| `taskId`、`runId` | 定位任务和执行轮次 |
| Runtime Pack ID 与 SHA-256 | 证明当时使用的 Context 版本 |
| Execution Profile ID、版本与 SHA-256 | 证明当时使用的能力配置 |
| Artifact 路径与 SHA-256 | 定位并校验交付结果 |
| 人工结论 | 区分通过、返工、阻塞和取消 |
| feedback SHA-256 | 识别同一反馈，不保存反馈正文 |

反馈正文仍由任务现有 Review 流程保存；Eval Audit 只保存摘要，避免在索引和查询结果中扩散私人内容。样本 ID 由上述稳定锚点确定性生成，重复处理同一次验收不会产生随机 ID。

## 5. 查看入口

首版提供只读 CLI：

```bash
pnpm --silent atl eval list --json
```

返回两个列表：

- `capabilitySamples`：完整、待人工审查的真实运行样本；
- `regressionCandidates`：由负反馈派生、尚未晋升的回归候选。

查询不会创建文件、修改 Vault、晋升样本或触发 Agent。格式不完整的旧 Audit 或伪完整记录不会作为有效样本返回。

## 6. 后续晋升门槛

将回归候选晋升为正式 Eval 前，至少需要人工完成：

1. 确认失败来自 Agent 能力或 Harness，而不是任务定义错误、来源失效或用户改变目标；
2. 去除私人数据，并补充可复用的输入夹具；
3. 明确预期输出、评分器和通过阈值；
4. 绑定要保护的 Profile 与版本范围；
5. 在独立变更中运行 capability 与 regression eval，并保留结果。

## 7. 当前不做

- 不自动从一次反馈概括长期偏好；
- 不自动编辑 Skill、Prompt、Profile 或 Context 选择规则；
- 不把取消任务一律解释为 Agent 失败；
- 不把反馈正文复制进 Audit 或 CLI 输出；
- 不提供自动晋升、删除或批量清洗 Eval 的写入命令；
- 不用 Eval 反馈闭环替代 Context Control Plane。

Context Control Plane 负责“执行前应加载什么”；本契约负责“执行后怎样保留可评估证据”。两者在 Runtime Pack 上连接，但职责独立。
