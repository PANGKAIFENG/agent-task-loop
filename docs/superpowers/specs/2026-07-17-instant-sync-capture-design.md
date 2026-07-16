# ATL Obsidian 实时收集设计

## 目标

让用户在 Obsidian 内完成两种低打扰收集，不需要打开终端：

1. 随手新建一个 Inbox 候选任务。
2. 立即扫描“笔记同步助手”中新同步的内容，用 AI 提取待办候选，人工勾选后写入 Inbox。

该能力解决每日复盘存在时间延迟的问题，但不替代每日复盘。所有新任务仍需用户补齐项目、目标和验收标准后，才可能进入 Agent 执行队列。

## 产品边界

- ATL 负责来源扫描、AI 提取、增量去重、候选确认和任务创建。
- `captureTask` service 负责所有任务写入，保证任务初始状态为 `inbox + candidate + autoExecutable=false`。
- TaskNotes 只是可选的看板、日历和筛选界面，不是安装或运行依赖。
- 插件不调用 TaskNotes 私有 API，不向 TaskNotes 工具栏注入按钮，也不修改其 DOM。
- “笔记同步助手”目录始终只读：不移动、不删除、不改写来源文件。
- MVP 只支持桌面版 Obsidian；移动端、自动扩写任务和独立 ATL Inbox 页面不在本期。

## 用户入口

Obsidian 左侧 Ribbon 增加两个 ATL 图标，并注册同名命令面板命令：

- `ATL：新建任务`
- `ATL：从同步助手获取待办`

入口属于 ATL 自己，因此即使用户没有安装 TaskNotes，也可以完成收集。

## 新建任务流程

1. 用户点击“新建任务”。
2. Obsidian 居中弹窗展示标题、补充说明和优先级。
3. 标题必填；补充说明为空时使用标题生成最小正文。
4. 用户点击“加入 Inbox”。
5. 插件调用 `captureTask`，写入一条 `origin=manual_obsidian` 的候选任务。
6. 成功后关闭弹窗并提示任务已进入 Inbox；不自动打开任务确认弹窗，也不自动进入 Ready。

手动任务使用随机任务 ID 组成 `sourceKey`，避免用户主动创建两个同名任务时被错误合并。现有标题相似度逻辑仍会记录 `possibleDuplicateIds` 供后续判断。

## 同步助手扫描范围

默认来源目录为 Vault 内的 `笔记同步助手`，MVP 不提供任意目录选择。

- 首次扫描：扫描今天和昨天的日期目录。
- 后续扫描：从上次成功扫描的本地日期开始，连续扫描到今天。
- 只读取 `YYYY-MM-DD/*.md`，排除子目录、图片和非 Markdown 文件。
- 普通 Markdown 文件作为一个来源记录。
- `同步助手_YYYY-MM-DD.md` 这类聚合文件按 `---` 与 `## 📅 YYYY-MM-DD HH:mm:ss` 边界拆为独立记录。

每条来源记录生成稳定的 SHA-256 指纹，输入包括规范化的 Vault 相对路径、记录时间和规范化正文。文件修改时间只用于减少无效读取，不能作为去重依据。

## 增量状态与去重

插件在自己的 `data.json` 中保存收集状态，不向 Vault 笔记写入扫描标记：

```ts
interface CaptureState {
  lastSuccessfulScanAt: string | null;
  reviewedFingerprints: string[];
}
```

- `reviewedFingerprints` 同时覆盖已写入与用户明确未选择的候选。
- 弹窗取消、模型失败或写入失败时，不更新扫描时间，也不新增 reviewed 指纹。
- 点击“加入 Inbox”且所有选中项写入成功后，才原子更新本次候选的 reviewed 指纹和扫描时间。
- `sourceKey` 使用 `obsidian_sync:<recordFingerprint>:<candidateFingerprint>`，因此即使插件状态丢失，`captureTask` 仍能做第二层精确去重。
- `captureTask` 现有的标题相似度继续作为第三层软去重，只提示可能重复，不自动丢弃不同来源的任务。
- 为避免插件数据无限增长，保存时只保留最近 10,000 个 reviewed 指纹；任务仓库中的 `sourceKey` 仍是永久精确去重依据。

## AI 提取

扫描功能复用插件现有的 Claude Code、Model 和 Base URL 配置，不新增 API Key 输入框，也不把密钥写入 Vault、插件设置、日志或 Git。

提取器以只读方式接收来源记录，输出严格 JSON：

```ts
interface ExtractedCandidate {
  title: string;
  summary: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  sourceRecordFingerprint: string;
  sourceQuote: string;
}
```

提取规则：

- 识别明确待办以及具有清晰行动意图的自然语言想法。
- 不把纯资讯、情绪记录、已经完成的事项或缺少行动意图的内容创建为候选。
- 不补齐项目、执行目标和验收标准；这些内容仍由现有任务确认弹窗处理。
- 每次最多提交 40 条来源记录、总正文最多 60,000 字符；超过限制时分批处理并合并结果。
- `sourceQuote` 仅保留支持该候选的短引用，最长 300 字符。

提取过程调用已检测通过的 Claude CLI，并应用现有的继承模式或自定义 Model/Base URL。模型不可用、返回非法 JSON 或超时时，显示可理解错误，不写任务也不推进扫描进度。

## 候选确认弹窗

AI 提取完成后打开居中弹窗：

- 顶部显示扫描文件数、新增来源记录数和候选数。
- 每个候选显示复选框、标题、简短说明、来源日期和来源短引用。
- 候选默认勾选，用户可取消不需要的项目。
- 主按钮为“将所选任务加入 Inbox”，次按钮为“取消”。
- 点击主按钮后，勾选项通过 `captureTask` 顺序写入；未勾选项被记为本次已忽略，后续扫描不再重复提示。
- 如果没有新内容或没有提取到候选，只显示 Notice，不打开空弹窗。

该弹窗只决定“是否进入 Inbox”，不承担项目选择、目标补齐或 Agent 执行授权。

## 模块设计

### `sync-source-reader`

负责日期目录选择、Markdown 读取、聚合笔记拆分、文本边界和来源记录指纹。它只依赖只读文件接口，不依赖 Obsidian UI 或任务仓库。

### `candidate-extractor`

负责构造受限提示词、调用 Claude CLI、校验严格 JSON 和映射来源指纹。它不写文件，不创建任务。

### `capture-controller`

协调扫描、过滤 reviewed 指纹、调用提取器、向 UI 返回候选，并在用户提交后调用 `captureTask`。只有它可以更新插件扫描状态。

### `quick-capture-modal`

负责手动新建任务表单和字段校验，不直接写 Markdown。

### `capture-candidates-modal`

负责候选勾选、提交状态和用户反馈，不直接读来源文件或调用模型。

模块之间使用明确的 TypeScript 数据对象，便于在临时目录和假执行器中独立测试。

## 错误处理

- 未允许 ATL 管理当前 Vault：提示用户前往插件设置授权，不执行扫描或写入。
- 非桌面 Vault：提示当前仅支持桌面版。
- 同步助手目录不存在：提示尚未检测到同步内容，不创建目录。
- Claude Code 未配置或未登录：提示先完成插件“后台执行”配置。
- 部分任务写入失败：不更新任何本次 reviewed 指纹或扫描时间；已成功写入的任务依靠 `sourceKey` 在重试时保持幂等。
- 来源文件在扫描中变化：本次使用已读取快照；下次通过新指纹重新判断新增内容。
- 同一时间重复点击扫描：复用进行中的 Promise 并禁用重复操作，避免并发模型调用。

## 测试策略

- 单元测试：日期范围、聚合笔记拆分、正文规范化、指纹稳定性、扫描状态裁剪、严格 JSON 校验、命令可用状态。
- 集成测试：临时 Vault 中读取同步笔记、提取候选、人工选择、调用 `captureTask`、精确去重和失败重试。
- 插件测试：两个 Ribbon 入口及两个命令存在；未授权、模型未配置、无新增内容和成功写入均显示正确反馈。
- 回归测试：现有任务确认、TaskNotes 卡片样式、后台运行配置和 runner 行为不变。
- 真实 Vault 验证只在显式设置 `ATL_VAULT_ROOT` 与 `ATL_ALLOW_REAL_WRITES=1` 后执行；自动化测试不得读取真实笔记内容。

## 验收标准

1. 用户可从 Obsidian 左侧栏或命令面板新建 Inbox 候选任务，全程不使用终端。
2. 用户可手动扫描同步助手今天以来的新内容，并在候选弹窗中选择要创建的任务。
3. 重复扫描不会重复创建或重复提示已经处理过的同一候选。
4. 所有新任务均保持 Inbox 候选状态，且不允许 Agent 自动执行。
5. 同步助手原文在扫描和任务创建前后字节不变。
6. 未安装 TaskNotes 时，两项收集能力仍可完整使用。
7. 扫描使用现有 Claude Code/CC-Switch 或自定义 Model/Base URL 配置，不保存任何新密钥。
8. 模型、读取或写入失败时不错误推进扫描状态，并可安全重试。
9. 构建、类型检查、lint、单元与集成测试全部通过。

## 后续但不属于 MVP

- 每日复盘自动化与本扫描器共用同一收集服务。
- 独立 ATL Inbox 页面和来源处理历史。
- 重新查看或恢复已忽略候选。
- 用户自定义多个收集来源。
- AI 自动扩写目标、验收标准与项目建议。
- 移动端收集和远程 Agent 调度。
