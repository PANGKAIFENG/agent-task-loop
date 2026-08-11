# TaskNotes 编辑弹窗智能完善入口设计

## 背景

用户主要在 TaskNotes 的“编辑任务”弹窗中维护标题、排期、状态和任务详情。
现有“智能完善任务”只能从命令面板或文件菜单进入，操作层级过深，且从看板
打开任务时不容易发现。

本期只在 TaskNotes 编辑弹窗左下角增加一个 ATL 入口，复用已经上线的
“智能完善任务”弹窗和 `task_brief` 保存逻辑，不改造 TaskNotes 表单，也不增加
新的 AI 工作流。

## 已确认交互

- 位置：TaskNotes 编辑弹窗左下角，位于“打开笔记”之前。
- 形态：带 `sparkles` 图标的次级按钮，文案为“智能完善”。
- 点击后：先保存 TaskNotes 弹窗中尚未保存的修改，保存成功并关闭原弹窗后，
  打开当前任务的 ATL“智能完善任务”弹窗。
- ATL 弹窗保存或取消后返回用户原来的 Obsidian 页面，不自动重开 TaskNotes
  编辑弹窗。
- 命令面板与文件菜单中的既有入口继续保留，作为兼容和降级入口。

## 方案比较

### A. 使用 TaskNotes 公开扩展 API

这是最稳定的方案，但已安装的 TaskNotes 4.11.1 没有提供向任务编辑弹窗注册
动作的公开接口，因此当前不可用。

### B. ATL 运行时增强 TaskNotes 弹窗（采用）

ATL 只识别 TaskNotes 已公开到 DOM 的稳定样式类，在编辑态按钮栏中插入一个
可移除按钮。该方案不修改 TaskNotes 插件文件，不 fork TaskNotes，也不调用其
未公开的类或方法。TaskNotes 升级导致 DOM 契约不再匹配时，ATL 不注入按钮，
现有命令和文件菜单入口仍可使用。

### C. fork 或修改 TaskNotes

可以直接控制弹窗，但会引入长期上游同步成本，并破坏 ATL 与 TaskNotes 的现有
所有权边界，因此不采用。

## 架构

新增独立的 `TaskNotesTaskBriefActionBridge`，职责仅包括：

1. 观察 Obsidian 文档中新增的 TaskNotes 编辑弹窗；
2. 通过 `.tn-task-modal__button-bar` 与 `.tn-task-modal__open-note-button`
   同时存在来确认这是编辑态而非创建态；
3. 在“打开笔记”之前插入带唯一 `data-atl-*` 标记的“智能完善”按钮；
4. 在点击时解析并验证当前任务路径；
5. 触发 TaskNotes 原生“保存”按钮；
6. 等待原弹窗在保存完成后关闭，再调用 ATL 现有 `open(path)`。

Bridge 通过依赖注入接收 DOM 根节点、任务路径判断、Vault 文件列表、通知函数
和 ATL 打开函数。主插件在 layout ready 时覆盖已有 workspace leaves，并监听
`window-open` / `window-close`，为每个 Obsidian `Document` 独立注册和清理观察器。
Bridge 不读取 TaskNotes runtime 对象，不持有 TaskNotes modal 实例，也不修改
TaskNotes 设置。

ATL 与 TaskNotes 的启用顺序不固定。Bridge 即使在首次扫描时发现 TaskNotes 尚未
启用，也会保留轻量 DOM 观察器；后续 DOM 变化触发扫描时重新检查 TaskNotes
启用状态。这样冷启动时 TaskNotes 晚于 ATL 加载，编辑弹窗仍能自动获得入口，
无需用户手动重载 ATL。

ATL 插件卸载时必须断开 `MutationObserver`、清除等待定时器并移除所有已注入
按钮，避免重载后重复注册。

## 当前任务识别

TaskNotes 编辑弹窗会在“任务信息”区域把完整 Vault 相对路径渲染为可见的
`.metadata-item .metadata-value`，但没有把路径作为公开 DOM 属性暴露。为避免依赖
中文“文件”标签，Bridge 使用以下规则：

1. 只读取当前弹窗中可见的 metadata value；
2. 从 Vault 已存在的 Markdown 文件中筛选 ATL 支持的任务路径；
3. 用完整字符串精确比较 metadata value 与合法任务路径；
4. 仅在恰好匹配一个文件时继续。

零匹配或多匹配时不触发保存，显示“无法识别当前任务，请使用文件菜单中的
智能完善任务”，并保留当前弹窗和用户输入。任务详情、隐藏元素或其他文件名
前缀不会参与匹配。

## 保存与切换流程

```text
点击“智能完善”
  -> 识别并验证任务路径
  -> 禁用 ATL 按钮和当前按钮栏的其他退出操作，显示“正在保存...”
  -> 点击 TaskNotes 原生“保存”
  -> 等待当前 TaskNotes 弹窗关闭
  -> 打开该路径的 ATL 智能完善弹窗
```

弹窗关闭是保存流程完成的信号。若在限定时间内没有关闭，Bridge 恢复按钮并
提示“任务尚未保存，请检查当前字段后重试”；不会打开 ATL 弹窗。Bridge 不直接
写任务 Markdown，因此标题、排期、状态和 TaskNotes 自定义字段仍由 TaskNotes
负责保存。等待期间同时拦截取消、关闭按钮和 Escape，避免用户先放弃修改而被
误判为保存成功；超时、插件卸载或窗口关闭都会解除临时锁定。

## 兼容与降级

- TaskNotes 未安装或持续未启用：Bridge 只保留轻量 DOM 观察器，不注入按钮，
  ATL 其他功能保持可用；TaskNotes 后续启用时可自动恢复增强。
- TaskNotes 创建任务弹窗：没有“打开笔记”按钮，不注入“智能完善”。
- TaskNotes DOM 结构变化：特征检测失败后静默跳过，不影响 TaskNotes 使用。
- 同一弹窗被多次扫描：唯一属性保证只插入一个按钮。
- 多个 Obsidian 窗口或弹窗：每个编辑弹窗独立识别、等待和清理。
- ATL 智能完善不可用：沿用现有 `open(path)` 的错误提示和数据保护行为。

## 样式

- 使用 Obsidian 原生按钮样式，不设置主操作 `mod-cta`，避免与“保存”竞争。
- 图标使用 Obsidian/Lucide `sparkles`，按钮文本为“智能完善”。
- 按钮保持与“打开笔记”相同高度和间距；窄窗口允许按钮栏自然换行，不覆盖
  “保存”和“取消”。
- 不在右侧“详情”标题栏增加第二个入口。

## 测试

单元测试使用 jsdom 构造 TaskNotes 编辑弹窗，覆盖：

1. 编辑态在“打开笔记”前只注入一个按钮；
2. 创建态和普通 Obsidian 弹窗不注入；
3. 重复 DOM 变更不会重复插入；
4. 唯一任务路径匹配后触发原生保存，弹窗关闭后调用 ATL `open(path)`；
5. 保存前按钮进入禁用状态；
6. 保存期间取消、关闭和 Escape 不会抢先关闭弹窗；
7. 路径前缀、隐藏路径和详情中的其他路径不会干扰精确匹配；
8. 路径零匹配、多匹配和非任务路径均不保存、不打开 ATL；
9. 保存超时会恢复按钮并提示；
10. stop/unload 会断开观察器、清除等待状态并移除注入按钮；
11. 主窗口和 popout window 各自注入并独立清理；
12. ATL 先启动、TaskNotes 后启用时仍能在后续弹窗中注入；
13. 现有命令面板和文件菜单入口测试继续通过。

完成实现后运行 Node 24 下的目标单测、完整测试、typecheck、lint 和生产构建，
再安装到 ClawVault 进行真实 TaskNotes 编辑弹窗冒烟验证。

## 验收标准

1. 用户在 TaskNotes 编辑任务弹窗左下角能直接看到“智能完善”。
2. 按钮位于“打开笔记”之前，且不会出现在创建任务弹窗。
3. 当前 TaskNotes 字段修改先保存成功，随后才打开正确任务的 ATL 弹窗。
4. 识别或保存失败时不丢失当前输入、不打开错误任务。
5. TaskNotes 插件文件、设置和内部 runtime 不被修改。
6. TaskNotes 升级导致增强失效时，原生编辑功能与 ATL 既有入口仍然可用。

## 非目标

- 不把 ATL 字段直接嵌入 TaskNotes 表单。
- 不修改 TaskNotes 创建任务弹窗。
- 不重开或恢复 TaskNotes 编辑弹窗。
- 不新增任务自动执行、Agent 会话或项目关联能力。
- 不删除现有命令面板和文件菜单入口。
