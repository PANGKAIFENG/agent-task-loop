# Execution Profile 产品契约

## 1. 要解决的问题

Agent 能否做好任务，不只取决于模型。每次运行至少需要明确五件事：它以什么角色执行、加载哪些能力指令、允许使用哪些 Tool、必须获得哪些 Context，以及最终按什么标准验收。

如果这些决策只散落在 Prompt、运行代码和本机 Skill 目录中，系统就无法解释“为什么这样执行”，也无法判断返工后的结果是否来自同一套能力配置。因此 ATL 把它们收敛为版本化 `Execution Profile`，并在每次执行的 Runtime Pack 中冻结。

## 2. 方案比较

### 方案 A：固定 Agent 与 Skill 名单

- 适合前提：任务类型很少，能力长期不变。
- 核心做法：给每个 Agent 配一组固定 Skill 和 Tool。
- 优点：实现简单，用户容易理解。
- 代价：同名 Agent 的实际能力变化不可追溯；任务准入仍然模糊。
- 主要风险：把“创建更多 Agent”误当成能力提升。
- 不选它的理由：不能解释某一次运行到底使用了什么合同。

### 方案 B：版本化能力包 + 确定性准入

- 适合前提：当前只有少量已验证场景，安全边界优先于覆盖面。
- 核心做法：代码根据任务类型、授权和上下文确定唯一 Profile；Profile 冻结角色、Skill 指令、Tool、必需 Context、输出合同和验收规则。
- 优点：可解释、可回放、可测试；不匹配时明确失败。
- 代价：新增任务类型必须显式开发、评测和发布新 Profile。
- 主要风险：首版覆盖面窄，需要用真实任务反馈逐步扩展。
- 选择理由：最贴合当前“先跑通一个真实闭环，再扩能力”的阶段目标。

### 方案 C：模型动态选择 Agent、Skill 与 Tool

- 适合前提：已有成熟任务分类、丰富 Eval、可靠权限治理和大量运行反馈。
- 核心做法：模型按任务实时组合执行角色与能力。
- 优点：扩展灵活，能覆盖长尾任务。
- 代价：选择不可预测，评测空间急剧增大。
- 主要风险：模型通过选错 Skill 或 Tool 扩大权限，并把路由错误伪装成执行错误。
- 暂不选择的理由：当前没有足够 Eval 和真实反馈证明动态路由可靠。

## 3. 首版决策

ATL 首版只发布 `research_v1`，采用 `deterministic_v1` 选择策略。它不是通用 Agent，也不代表已经支持代码实现、需求写作、外部发送或多 Agent 编排。

| 合同维度 | `research_v1` |
| --- | --- |
| 执行角色 | `bounded_public_researcher` |
| 适用任务 | 已确认、已显式授权、已被领取的 `research` 任务 |
| 权限 | `read_only_research` |
| Skill 指令 | `decision-research@1`、`evidence-collection@1` |
| Tool | `WebSearch`、`WebFetch`、`Read` |
| 必需 Context | `task`、`project` |
| 输出合同 | `research_result_v1` |
| 验收 | 覆盖每条任务完成条件、HTTPS 证据、必须人工验收 |

这里的 Skill 是随 Profile 版本固化的最小执行指令，不是运行时扫描本机 Skill 目录。这样可以避免同一个 `pack_id` 因 Skill 文件在执行中变化而失去可追溯性。后续如果要引用完整 Skill 资产，应先建立可校验的 Skill registry、版本摘要和 Context 预算，再发布新 Profile 版本。

## 4. 运行规则

1. 任务先经过现有人工确认和 Agent 执行授权，再被 Runner 领取。
2. Runner 根据已领取任务确定唯一 Execution Profile；没有匹配项时以 `execution_profile_not_supported` 失败，不调用模型。
3. Context Bundle 完成后，系统校验 Profile 要求的 Context 类型；缺失时以 `execution_profile_context_missing` 失败。
4. Runtime Pack 同时冻结 Profile 正文与 SHA-256；`context_pack.frozen` Audit 记录 Profile ID、版本和摘要。
5. Driver 再次验证 Profile，并且只把 Profile 中的 Tool 传给 Claude CLI。
6. 决策续跑、失败重试或 Artifact 返工都会重新选择并冻结 Profile，因此能力配置变化会形成新的 Pack。
7. Artifact 始终进入人工验收，不由 Agent 自己标记任务完成。

## 5. 扩展门槛

新增 Profile 不是新增一段 Prompt。它至少需要：

- 明确适用的任务类型、授权条件和拒绝条件；
- 版本化角色、Skill 指令、Tool allowlist 和 Context 要求；
- 独立输出合同与人工验收规则；
- capability eval 证明新任务能完成；
- regression eval 证明既有 Profile 的准入、权限和结果没有退化；
- Runtime Pack、Audit 和 Artifact 之间仍可追溯。

只有当真实任务样本和 Eval 证明确定性路由成为主要瓶颈时，才重新评估模型动态路由。即使引入动态推荐，最终授权和 Tool 边界仍应由确定性策略决定。

## 6. 当前不做

- 不按 Agent 名称自动推断权限。
- 不扫描和加载本机所有 Skill。
- 不让模型自由增加 Tool。
- 不支持代码修改、云效写入、钉钉发送或日历变更。
- 不根据一次成功或失败自动改写 Profile 或 Skill。
- 不把 Profile 当成长期记忆或 Context Control Plane 的替代品。

下一阶段单独建立 Eval 反馈闭环：把运行结果、验收意见和失败类型变成可审查样本，但不自动修改路由或 Skill。
