# Obsidian 个人工作贡献首页设计规格

## 1. 产品目标

在 Agent Task Loop（ATL）Obsidian 插件中增加“个人工作贡献”首页，让用户不打开终端、不离开 Obsidian，就能回答四个问题：

1. 今天和本周实际完成了多少任务？
2. 是否保持了持续完成工作的节奏？
3. 今天主要完成了哪些项目和可核对产出？
4. 完成这些工作的同时使用了多少 AI Token？

首页定位为统计与回看界面，不是排期驾驶舱、任务编辑器或生产力评分器。视觉采用用户已确认的原型 A：GitHub 风格贡献图、紧凑 KPI、任务与 Token 趋势、今日主要工作、可核对产出。

## 2. MVP 范围

### 本期包含

- ATL 自有的桌面端 Obsidian `ItemView`。
- Ribbon 按钮和命令面板入口。
- 只读汇总 ATL 任务、项目和 Audit 事件。
- 只读接入本机已安装的 Tokenrank/OpenToken 客户端。
- KPI、贡献热力图、任务趋势、Token 趋势、项目摘要和完成产出列表。
- `7 天`、`12 周`、`1 年`三个时间范围，默认 `12 周`。
- 手动刷新，以及任务文件变化后的自动刷新。
- 加载、空数据、部分数据、缓存过期、未安装 OpenToken 和异常状态。
- Obsidian 明暗主题及窄面板适配。

### 本期不包含

- 在首页创建任务、修改状态或安排日程。
- 替换、二开 TaskNotes，或调用 TaskNotes 私有 API。
- 综合生产力分、效率分、ROI 分或个人绩效判断。
- 用 Token 数量判断成果质量，或用 Token 点亮贡献图。
- 在缺少可靠关联键时把 Token 归因到项目、任务或主题。
- 为 Token 再开发一套 Agent 日志采集器。
- 读取原始 Prompt、回复、源代码、笔记正文或对话内容进行统计。
- GitHub 提交统计、自动化健康度、金额成本、团队排行和移动端。

## 3. 架构选择

### 推荐并采用：ATL 原生 Obsidian ItemView

ATL 注册自定义 `ItemView`，使用 Obsidian DOM API、SVG、CSS Grid 和主题变量渲染首页。任务与 Audit 数据经过只读查询服务汇总；Token 数据经过有边界的 OpenToken 适配器获取。

该方案保留 Obsidian 内的完整体验，不需要 localhost 服务、端口管理或终端操作，并能正确处理 Token 异步加载与部分失败。

### 未采用方案

1. **Markdown/Base 首页**：适合表格和简单属性，不足以稳定承载响应式热力图、折线图、异步 Token 加载和部分错误状态。
2. **独立 localhost 网页**：实现自由度高，但会重新引入后台服务、端口和技术化使用流程，不符合当前产品目标。

首页与 TaskNotes 解耦。TaskNotes 继续负责看板、日历、拖拽和任务卡片管理。

## 4. 信息架构

页面采用单层、无嵌套卡片的纵向布局，共六个区域。

### 4.1 页头

- 标题：`个人工作贡献`
- 说明：`像看 GitHub 一样，看见每天真正完成的工作。`
- 数据源状态：`ATL 任务`、`Tokenrank / OpenToken`
- 时间范围分段控件：`7 天`、`12 周`、`1 年`
- 仅图标的刷新按钮，Tooltip 为 `刷新数据`
- 最近一次成功更新时间

原型中的“演示数据”标记和 A/B/C 方案切换器不上线。

### 4.2 KPI

首行固定四个指标：

1. 今日完成任务数
2. 本周完成任务数
3. 当前连续完成天数
4. 今日 Normalized Token

每个指标带一行简短对比或覆盖说明。Token 数据缺失只影响 Token 指标，不影响任务统计。

### 4.3 贡献热力图

- 默认展示过去 12 周，按七行星期布局。
- 点亮强度只由本地日期内完成的唯一任务数决定。
- 等级为 `0`、`1`、`2`、`3`、`4+` 次完成。
- Hover 或键盘聚焦时显示日期、完成任务数和涉及项目数。
- 点击日期后，下方“主要做了什么”和“可核对产出”切换到该日期。
- Token 数量不参与颜色强度。

### 4.4 趋势

宽面板左右并列、窄面板上下排列：

- 每日完成任务数折线图
- 每日 Normalized Token 折线图，Tooltip 补充 Input、Output 和 Cache 数据

时间范围控件同时影响两张图。图表采用可访问的 SVG 路径与数据点，不能只依赖颜色表达信息。

### 4.5 所选日期主要做了什么

把所选日期完成的任务按 `projectId` 分组，每行展示：

- 项目显示名称；无项目时显示 `未归类`
- 完成任务数
- 关联 ATL Artifact 数量
- 最多两个任务标题作为证据

先按完成任务数、再按项目名称排序。由于 OpenToken 聚合输出没有可靠的任务或项目关联键，本期不展示“项目 Token”。

### 4.6 可核对产出

展示所选日期最近完成的任务，每项包含：

- 任务标题
- 项目名称
- 完成时间
- 有 `artifactRefs` 时显示 `有 Agent 产出`
- 无 Artifact 时显示 `人工完成`

点击任务打开对应 Markdown；点击 Artifact 打开最近一份 Artifact。

## 5. 指标定义

所有日期边界使用用户本地时区，每周从周一开始。

### 5.1 完成事件

仅以下 Audit 证据记为任务完成：

- `task.reviewed` 且 `details.decision = approve`
- `task.lifecycle_reconciled` 且 `details.status = done`，覆盖用户通过 TaskNotes 或 Markdown 人工修改状态

任务被重新打开并在不同日期再次完成时，分别计入对应日期；同一任务在同一天多次完成时只计一个已完成任务，采用当天最后一次完成时间。

历史 `done` 任务如果没有完成 Audit，不根据 `updatedAt` 猜测完成日期。首页在覆盖说明中显示“部分历史任务缺少完成日期”，这些任务不计入日期 KPI 和贡献图。

### 5.2 今日完成与本周完成

- 今日完成：当前本地自然日内完成的唯一任务数。
- 本周完成：本周一 00:00 到当前时间内按“任务 + 完成日期”去重后的完成数；同一任务在不同日期重新完成可分别计入。
- 对比分别采用前一自然日，以及上周一到上周同一时刻的等长窗口。

### 5.3 当前连续完成天数

从今天向前统计连续存在至少一个已完成任务的本地自然日。如果今天尚未完成任务，允许从昨天开始计算，避免用户早晨打开首页时连续记录被立即显示为零。

### 5.4 热力图等级

本地日期内完成的唯一任务数为 `n`：

- 0 级：`n = 0`
- 1 级：`n = 1`
- 2 级：`n = 2`
- 3 级：`n = 3`
- 4 级：`n >= 4`

### 5.5 Token

数据来自本机：

```text
opentoken preview --since YYYY-MM-DD --json
```

首页主 Token 指标采用 OpenToken 的 `normalized` 字段：

```text
normalized = fresh input + output
```

Cache Read 和 Cache Write 不计入主数值，但可在 Tooltip 和数据详情中查看。这与 Tokenrank 的 Daily Leaderboard 指标保持一致。每日数据跨 Tool、Model 求和；界面只展示所选范围内实际有非零数据的工具，例如 Claude Code、Codex、WorkBuddy，不把“已检测到”误写成“产生了用量”。

Token 是 AI 投入量，不代表成果或效率。

## 6. 数据契约

### 6.1 ATL 贡献查询

只读查询接收：

- Inbox、Active、Archive 中解析后的 ATL 任务
- ATL Audit 事件
- 项目定义
- 当前本地时间、时区和所选时间范围

查询返回可序列化的 `ContributionSnapshot`，包含 KPI、每日完成桶、项目汇总、所选日期产出和覆盖警告，不保存任务、不写 Audit。

现有 `AuditLog` 增加有日期范围边界的查询能力，UI 不直接读取 JSONL。路径校验和损坏处理继续封装在 `FileAuditLog` 内。

### 6.2 OpenToken 适配器

按固定顺序检测可执行文件：

1. `~/.local/bin/opentoken`
2. `/opt/homebrew/bin/opentoken`
3. `/usr/local/bin/opentoken`
4. `/usr/bin/which opentoken` 返回的绝对路径

适配器不接受用户输入的 Shell 文本，直接使用固定参数调用程序，设置 30 秒超时和 stdout/stderr 上限，并在汇总前校验 JSON。

输入行契约：

```ts
interface OpenTokenUsageRow {
  date: string;
  tool: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  normalized: number;
}
```

Session 行可用于覆盖说明，但不作为本期首屏 KPI。

### 6.3 Token 缓存

OpenToken 扫描可能耗时数秒，因此 ATL 在插件 `data.json` 中只缓存汇总后的每日数据：

- 每日 normalized、input、output、cache read、cache write
- 每日有非零数据的 Tool id
- OpenToken 版本
- 已覆盖的起始日期
- `updatedAt`

不缓存 Prompt、回复、路径、仓库名、原始 Agent 日志、Session id、凭据或 OpenToken 接入链接。

首页先显示最近一次成功缓存，再异步刷新。刷新失败保留旧缓存并明确标记过期。

## 7. 数据流

```text
打开首页
   |
   +--> 读取任务 + Audit + 项目 ------> 生成 ContributionSnapshot
   |
   +--> 立即渲染已缓存的每日 Token
   |
   +--> 异步执行受限 OpenToken preview
             |
             +--> 校验、汇总、保存缓存
             +--> 更新 Token KPI 与趋势
```

任务文件变化只触发防抖后的任务统计刷新，不重复扫描 OpenToken。刷新按钮同时刷新两个数据源。切换时间范围优先使用已加载数据；只有缓存不覆盖目标起始日期时才重新调用 OpenToken。

## 8. 交互与状态

### 加载中

- 页面骨架立即出现，固定各区域尺寸。
- 初次查询任务时只显示轻量占位。
- Token 区先显示缓存；无缓存时显示 `正在读取 Token 数据…`。

### 没有完成任务

- KPI 为 0，热力图显示未点亮格子。
- 主要工作显示 `当天没有已完成任务`。
- 产出区域提供打开 ATL 任务看板的文本入口。

### 未检测到 OpenToken

- 任务统计正常展示。
- Token KPI 和趋势显示 `未检测到 OpenToken`。
- 提供进入 ATL 设置或 Tokenrank 安装说明的入口，不打开终端。

### Token 刷新失败或缓存过期

- 继续显示最近一次成功数据。
- 标记 `更新于 <时间>，本次刷新失败`。
- 技术详情默认折叠，不展示原始 stdout、stderr、凭据或非必要本地路径。

### Audit 损坏

- 不静默猜测任务数据。
- 任务贡献区显示不可用及简短恢复说明。
- Token 区仍可独立展示。

### 日期选择

- 默认选择今天。
- 鼠标点击或键盘激活热力图单元格后，更新下方所选日期内容。
- 选中态必须有不依赖颜色的可见边框。

## 9. 视觉规则

- 使用 Obsidian 字体、颜色和主题变量，不复制原型中的独立侧边栏。
- 保持安静、紧凑、便于扫读；不使用 Hero、装饰渐变、嵌套卡片或超大文案。
- KPI 在宽面板四列、中等面板两列，窄面板根据可用宽度一到两列。
- 图表和热力图具有稳定的最小高度与响应式宽度，加载和 Tooltip 不引发布局跳动。
- 绿色表示完成工作，蓝色表示 Token 投入，琥珀色只表示数据过期或不完整。
- 字间距为 0；长项目名和任务名换行且不遮挡指标与控件。
- Tooltip 和焦点状态同时支持鼠标与键盘。

## 10. 安全与隐私

- 首页对任务领域状态完全只读。
- 真实 Vault 写入仍受现有 ATL 授权保护；自动测试只使用临时 Vault。
- OpenToken 不经过 Shell，且只允许固定参数。
- 不调用 `upload`、`connect`、`daemon` 或任何网络操作。
- 不读取 `~/.opentoken/config.json`、凭据、原始 Agent 日志、Prompt、回复或 Session id。
- 持久化缓存只包含聚合数值与 Tool id。
- 错误进入 UI 前转换为稳定的产品提示。

## 11. 模块边界

### `contribution-query`

把任务、项目和完成 Audit 纯函数式汇总为每日与所选日期统计。

### `opentoken-adapter`

负责可执行文件检测、受限调用、JSON 校验和每日汇总，不依赖 Obsidian UI。

### `dashboard-controller`

协调任务快照、Token 缓存、异步刷新、日期范围、所选日期和可恢复错误。

### `work-contribution-view`

负责 Obsidian `ItemView`、DOM、交互、图表和文件跳转；不直接解析 Markdown、读取 Audit JSONL 或启动进程。

### `dashboard-settings-cache`

负责插件设置中的每日 Token 汇总归一化和裁剪，同时兼容已有设置。

## 12. 测试策略

- 单元测试：完成事件识别、本地日期分桶、周对比、连续天数、热力等级、项目分组和历史覆盖警告。
- 单元测试：OpenToken 严格 JSON 校验、Normalized Token、多工具汇总、程序检测、超时、输出上限和脱敏错误。
- Controller 测试：缓存优先、单源失败、范围切换、并发刷新去重、失败保留旧缓存。
- View 测试：命令与 Ribbon 注册、加载与空状态、键盘选择热力单元格、响应式类和打开任务/Artifact。
- 集成测试只使用临时 Vault、合成任务和合成 Audit，不读取 ClawVault 或真实 OpenToken 文件。
- 真实 Obsidian 验证遵守仓库的显式真实 Vault 授权规则，即使本功能不应修改任务状态。
- 发布验证执行 typecheck、lint、全量测试、插件构建，以及 Obsidian 明暗主题烟测。

## 13. 验收标准

1. 用户可从 Obsidian Ribbon 或命令面板打开“个人工作贡献”，不启动服务、不打开终端。
2. 首页从当前 Vault 展示任务指标，并从已安装的 OpenToken 展示 Token 指标。
3. 今日和本周完成数来自可核对的完成 Audit，不使用 `updatedAt` 猜测。
4. 贡献图只由完成任务点亮，并可通过鼠标和键盘查看日期。
5. `7 天`、`12 周`、`1 年`范围一致更新任务与 Token 趋势。
6. “主要做了什么”按项目汇总，不伪造项目级 Token 归因。
7. “可核对产出”可在 Obsidian 中打开对应任务和最近 Artifact。
8. OpenToken 缺失或失败不影响任务贡献统计。
9. 再次打开首页时先显示缓存 Token，缓存过期时有明确标记。
10. 首页不读取 Prompt、回复、笔记正文、原始 Agent 日志、凭据或 OpenToken 接入信息。
11. 明暗主题和窄/宽面板均无文字或控件重叠。
12. 现有收集、TaskNotes 看板、人工状态管理、Agent 执行和验收行为不变。
13. Typecheck、lint、自动测试、生产构建和 Obsidian 烟测全部通过。

## 14. 交付顺序

1. 增加只读完成事件范围查询与贡献汇总。
2. 增加 OpenToken 适配器和聚合缓存。
3. 增加 Dashboard Controller 与部分数据状态模型。
4. 增加 Obsidian ItemView、命令、Ribbon、图表和响应式样式。
5. 使用临时数据验证，再用本机 OpenToken 和真实 Obsidian 做只读烟测。
6. 更新用户视角 README 与 Obsidian 操作文档。
7. 完成 CR、构建插件包，并按仓库既有 PR 和 Release 流程上线。
