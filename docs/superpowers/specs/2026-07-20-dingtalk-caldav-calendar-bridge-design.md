# 钉钉 CalDAV 日历桥接设计规格

## Brainstorming Summary

- **当前问题**：钉钉日程需要进入 TaskNotes 日历并可本地拖动，同时接收钉钉后续改期和改名，但不能向钉钉回写。
- **推荐方案**：ATL 通过只读 CalDAV 读取钉钉主日历，维护远端快照账本，并生成 `TaskNotes/DingTalk/` 下的 TaskNotes Markdown。
- **不做范围**：不调用 TaskNotes 私有 API、不写回钉钉、不进入 `10_Tasks` 或 Agent 执行队列、不重做日历 UI。

## 1. 背景

用户希望在 Obsidian 的 TaskNotes 日历中看到钉钉主日历，并能像普通 TaskNotes 任务一样拖动和编辑本地排程。钉钉仍然是日程来源，但不允许 Obsidian 反向修改钉钉。

当前环境已经具备：

- Obsidian 1.12.7 的 `SecretStorage` 能力；
- TaskNotes 4.11.1 的任务日历、周视图和拖动排程能力；
- 钉钉 CalDAV 账号信息的安全存储入口；
- ATL 插件的后台运行、设置和只读来源适配模式。

TaskNotes 的默认日历只筛选 `type: task`，而 ATL 的任务总看板还要求 `file.inFolder("10_Tasks")`。这使得钉钉日程可以放在独立的 `TaskNotes/DingTalk/` 目录：它们会出现在 TaskNotes 日历中，但不会进入 ATL 的任务收件箱、执行队列或项目看板。

## 2. 问题与目标

### 2.1 要解决的问题

1. 用户需要在一个日历视图内查看钉钉安排和本地任务。
2. 用户需要能在 TaskNotes 中拖动钉钉日程，调整本地执行安排。
3. 钉钉端后续改期或改名时，本地仍应能收到更新。
4. 本地编辑不能意外写回钉钉，也不能破坏 ATL 任务状态。
5. 从安装到日常使用不需要用户打开终端。

### 2.2 成功标准

- 用户在插件设置中完成钉钉 CalDAV 配置后，可以点击“立即同步钉钉日历”。
- 新钉钉事件可以在 `TaskNotes/DingTalk/` 中生成可编辑的 TaskNotes 任务。
- 用户在 TaskNotes 日历拖动后，钉钉未变化时本地时间保持不变。
- 钉钉同一事件发生改期、改名或取消时，下一次同步能更新本地对应任务。
- 同一事件不会重复创建；本地任务的项目、标签、备注、优先级和执行状态不会被同步覆盖。
- 全流程不要求用户执行命令行操作。

## 3. 用户与角色

- **个人用户**：配置连接、手动同步、在 TaskNotes 中拖动和管理本地任务。
- **ATL 插件**：读取钉钉、识别事件、维护事件账本、合并远端变化并写入本地 Markdown。
- **TaskNotes**：读取标准任务属性并提供日历、拖动、筛选和编辑界面。
- **钉钉 CalDAV 主日历**：唯一的远端日程来源，不接受 ATL 写入。

## 4. 约束

- 只读钉钉主日历，不接入钉钉待办或其他日历。
- 不调用 TaskNotes 私有 API，不 fork TaskNotes，不修改 TaskNotes 插件文件或 DOM。
- 不把钉钉日程写入 `10_Tasks`，不进入 ATL Agent 执行队列。
- 不设置 `due`；钉钉开始时间映射到 TaskNotes 的 `scheduled`，避免把日历日期误作截止日期。
- 日历同步只在桌面 Obsidian 中运行；移动端不属于 MVP。
- 真实 Vault 写入必须遵守仓库 `AGENTS.md` 的显式环境开关要求，自动化测试只能使用临时合成 Vault。

## 5. 方案比较

### 方案 A：直接生成 TaskNotes 兼容 Markdown（推荐）

- **适合前提**：TaskNotes 继续提供日历，ATL 只负责桥接和文件状态。
- **核心做法**：使用公共 Obsidian Vault API，把事件写入 `TaskNotes/DingTalk/`，由 TaskNotes 自动识别。
- **优点**：可拖动、可编辑、低耦合；不会污染 ATL 看板；TaskNotes 升级时不依赖私有方法。
- **代价**：需要自己实现 CalDAV、iCalendar 解析、事件账本和远端变化合并。
- **主要风险**：CalDAV 服务器的循环事件和删除通知存在实现差异，需要用合成 fixture 覆盖。
- **不选其他方案的理由**：这是当前范围内最小且可维护的集成边界。

### 方案 B：调用 TaskNotes 的 ICS 私有服务

- **适合前提**：只需要快速导入且能接受写入 TaskNotes 配置的 Inbox。
- **核心做法**：调用 TaskNotes 内部 `createTaskFromICS`。
- **优点**：初始 Markdown 生成工作少。
- **代价**：导入位置受 TaskNotes 配置影响，可能进入 `10_Tasks/Inbox`；接口不是公开契约。
- **主要风险**：TaskNotes 升级可能导致接口或参数变化，且无法表达 ATL 的远端快照和冲突合并。
- **不推荐原因**：违反“独立日历来源、不污染 ATL 收件箱”的产品边界。

### 方案 C：ATL 自己实现日历渲染器

- **适合前提**：未来不再使用 TaskNotes，ATL 需要完全控制日历体验。
- **核心做法**：自行实现周视图、拖动、事件编辑和任务筛选。
- **优点**：长期可完全自定义。
- **代价**：重复实现 TaskNotes 已有能力，开发和维护面显著扩大。
- **主要风险**：拖动、时区、循环实例和无障碍交互容易出现回归。
- **不推荐原因**：超出当前 MVP，不能改善本期核心闭环的交付速度。

## 6. 推荐设计

采用 **方案 A + 单向远端合并**：

```text
Obsidian SecretStorage / 旧版 Keychain 凭证
                  ↓ 只读 CalDAV
        钉钉主日历事件与变更
                  ↓
        CalDAV 解析与循环展开
                  ↓
     稳定事件身份 + 上次远端快照账本
                  ↓ 只创建或更新本地托管字段
        TaskNotes/DingTalk/*.md
                  ↓
        TaskNotes 日历拖动与本地管理
```

同步关系是“钉钉 → Obsidian”，不是双向同步：

- 钉钉是远端日程字段的最终来源；
- Obsidian 是本地任务状态和执行上下文的最终来源；
- ATL 从不向 CalDAV 发 `PUT`、`DELETE` 或其他写入请求。

## 7. 核心流程

### 7.1 配置与首次同步

1. 用户打开 ATL 插件设置。
2. 在“钉钉日历”区域输入 CalDAV 地址、账号和密码，或选择已保存凭证。
3. 插件通过 `SecretStorage` 保存凭证；当前安装的旧版 macOS Keychain 凭证可作为只读兼容回退，不写入 `data.json`、Vault、日志或 Git。
4. 用户点击“测试连接”。插件只读取主日历列表和一条事件摘要，成功后显示账号与日历名称，不显示密码。
5. 用户点击“立即同步”，默认读取当天至未来 90 天的事件。
6. 对每个新事件生成本地 Markdown，并在同步摘要中显示新增、更新、取消、跳过和错误数量。

### 7.2 自动与手动同步

- 插件加载后执行一次同步。
- Obsidian 保持打开时每 15 分钟执行一次增量同步。
- 设置页和命令面板提供“立即同步钉钉日历”。
- 同一时间重复点击只复用正在执行的同步 Promise，不启动并发请求。
- 失败不会删除或回滚已有本地任务，也不会推进对应事件的远端快照。

### 7.3 新事件导入

新事件写入 `TaskNotes/DingTalk/`，示例属性契约：

```yaml
---
type: task
title: 客户方案评审
status: inbox
scheduled: 2026-07-20T14:00:00+08:00
timeEstimate: 60
origin: dingtalk_caldav
tags:
  - dingtalk_calendar
dingtalk_event_key_hash: sha256:...
dingtalk_calendar_id: primary
dingtalk_imported_at: 2026-07-20T09:00:00+08:00
dingtalk_last_synced_at: 2026-07-20T09:00:00+08:00
dingtalk_remote_snapshot_hash: sha256:...
dingtalk_state: active
---

<!-- ATL_DINGTALK_MANAGED_START -->
来源：钉钉日历
地点：线上会议
远端状态：active
<!-- ATL_DINGTALK_MANAGED_END -->

<!-- 用户可在此处追加本地备注、准备事项和复盘记录。 -->
```

实现要求：

- 文件名使用稳定事件哈希，不使用标题，避免远端改名导致重命名和链接断裂。
- `scheduled` 使用带偏移量的 ISO 时间；全天事件只写日期。
- `timeEstimate` 由远端开始/结束时间换算为分钟；全天事件不写入时间估算。
- 不写 `due`、`project_id`、`review_state` 或 `auto_executable`，避免把日程误转成 ATL 执行任务。
- 管理区只承载钉钉描述、地点和远端状态；用户正文区永远不被同步器重写。

### 7.4 远端更新与冲突合并

每个事件在插件 `data.json` 的 `dingtalkCalendar` 节点中维护账本。文件 frontmatter 也保存事件哈希，用于文件被移动后的恢复定位。

| 字段 | 归属 | 规则 |
| --- | --- | --- |
| `title` | 钉钉 | 钉钉改变时更新；本地改名且钉钉未改变时保留本地值 |
| `scheduled` | 钉钉 | 用户可拖动；钉钉未改变时不回写；钉钉改期时以钉钉为准 |
| `timeEstimate` | 钉钉 | 根据钉钉开始/结束时间更新 |
| `dingtalk_state`、地点、描述 | 钉钉 | 只更新管理区 |
| `status` | 本地 | 本地状态始终保留；远端取消时例外标记为 `cancelled` |
| 项目、标签、备注、优先级 | 本地 | 永远不被远端同步覆盖 |
| 文件路径 | 本地 | 用户移动后通过事件哈希重新定位，不强制移回原目录 |

同步器不直接拿“当前文件值”和“远端值”比较，而是比较当前远端快照与账本中的上次远端快照：

1. 远端快照未变化：不修改文件，因此本地拖动可以保留。
2. 远端快照变化：只更新发生变化的钉钉托管字段。
3. 同一字段本地和远端都改过：钉钉胜出，并在同步摘要中标记“远端覆盖本地字段”。
4. 更新成功后原子写入 Markdown 与账本；任一步失败都保留旧快照，下次可重试。

### 7.5 取消、删除和本地删除

- 钉钉明确取消事件：保留本地文件和用户备注，更新管理区并将 TaskNotes `status` 设为 `cancelled`。
- 钉钉恢复已取消事件：仅在状态仍由同步器设置为 `cancelled` 时恢复到 `inbox`；若用户期间改过本地状态，则保留用户状态并提示。
- CalDAV 明确返回远端删除：按“已取消”处理，不直接删除本地文件。
- 仅因为事件暂时不在 90 天查询窗口内，不能判定为删除。
- 用户主动删除本地文件：账本保留本地删除墓碑，不自动重新创建；设置页提供“清除导入记录后重新导入”作为显式恢复动作。

### 7.6 循环日程

- 使用标准 iCalendar 解析器展开 `RRULE`、`EXDATE`、`RDATE` 和例外实例。
- 只展开当天至未来 90 天的发生项。
- 每个发生项作为独立 TaskNotes 文件，事件身份为 `UID + RECURRENCE-ID`；没有 `RECURRENCE-ID` 的生成实例使用 `UID + occurrenceStart`。
- 单个发生项的本地拖动不改变整条循环规则。
- 钉钉修改循环规则后，只更新窗口内确实变化的发生项。

## 8. 数据模型

### 8.1 账本

```ts
interface DingTalkCalendarState {
  enabled: boolean;
  calendarId: string;
  syncWindowDays: number;
  intervalMinutes: number;
  syncToken: string | null;
  lastSuccessfulSyncAt: string | null;
  events: Record<string, DingTalkEventLedgerEntry>;
}

interface DingTalkEventLedgerEntry {
  eventKeyHash: string;
  remoteUid: string;
  recurrenceId: string | null;
  href: string;
  etag: string | null;
  taskPath: string | null;
  remoteSnapshotHash: string;
  remoteSnapshot: {
    title: string;
    start: string;
    end: string | null;
    allDay: boolean;
    description: string | null;
    location: string | null;
    state: 'active' | 'cancelled';
  };
  lastSeenAt: string;
  locallyDeletedAt: string | null;
  cancelledBySync: boolean;
}
```

账本不保存密码。事件历史在超出查询窗口且结束超过保留期后才允许压缩；压缩不得影响仍在窗口内的事件或本地删除墓碑。

### 8.2 事件身份

事件身份必须与标题、时间和文件名解耦：

```text
sha256(calendarId + "|" + UID + "|" + recurrenceIdOrOccurrenceStart)
```

CalDAV 的 `href` 和 `ETag` 用于高效判断变化，但不作为唯一业务身份，因为服务器可能在移动或重新生成资源时改变它们。

## 9. UI 与交互

### 9.1 设置页

新增“钉钉日历”分组：

- 启用同步：开关；
- CalDAV 地址：文本输入；
- 用户名：文本输入；
- 密码：密码输入，不回显；
- 日历：默认“主日历”，只读展示；
- 同步窗口：默认“今天至未来 90 天”；
- 同步频率：默认 15 分钟；
- 测试连接：按钮；
- 立即同步：按钮；
- 上次同步：时间、结果、数量和最近错误；
- 清除本地导入记录：危险操作，二次确认后才可执行。

设置页必须明确显示：**只从钉钉读取，不会修改钉钉日历。**

### 9.2 日历使用

导入完成后，用户在 TaskNotes 的日历视图中使用这些事件：

- 拖动事件改变本地 `scheduled`；
- 调整时间块改变本地 `timeEstimate` 或结束时间映射；
- 打开任务文件追加准备事项和会议记录；
- 钉钉下一次发生变化后，远端托管字段按冲突规则更新。

ATL 不额外做一套日历 UI，也不向 TaskNotes 注入按钮。

## 10. 错误、边界与人工介入

- **凭证缺失**：提示在设置页填写，不执行网络请求。
- **认证失败**：提示账号或密码无效，保留已有本地任务。
- **CalDAV 不可达**：显示离线状态和重试按钮，不清空日历。
- **主日历不存在**：显示可用日历列表或明确提示账号权限问题，不自动选择其他日历。
- **iCalendar 非法**：跳过单个事件，记录事件哈希和可读错误，不影响其他事件。
- **时区无法解析**：按事件提供的 UTC 偏移处理，并在同步摘要中提示。
- **远端快照更新但本地文件写入失败**：不推进账本快照，下一次继续重试。
- **本地文件被移动**：通过 frontmatter 事件哈希和账本恢复路径，不强制移动文件。
- **本地文件被删除**：记录墓碑，不自动复活，除非用户显式清除导入记录。
- **重复点击同步**：复用进行中的任务并禁用重复提交。
- **真实 Vault 安全**：测试默认只写临时 fixture；真实写入必须同时设置 `ATL_VAULT_ROOT` 和 `ATL_ALLOW_REAL_WRITES=1`。

## 11. 非目标

- 不向钉钉创建、修改、移动或删除日历事件。
- 不同步钉钉待办、群聊、提醒或参与人响应状态。
- 不把钉钉日程自动转成 ATL Inbox 候选或 Agent 可执行任务。
- 不实现 Google/Microsoft/其他 CalDAV 账号的通用产品化配置。
- 不重做 TaskNotes 的日历、看板、拖动和筛选。
- 不在本期实现 AI 自动拆解会议目标、验收标准或执行计划。
- 不支持移动端后台同步。

## 12. 验证与验收

### 12.1 单元测试

- CalDAV 请求构造和只读方法约束；
- iCalendar 解析、时区、全天事件和循环展开；
- 事件身份和快照哈希稳定性；
- 账本序列化、迁移、墓碑和压缩；
- 远端字段与本地字段的合并规则；
- 取消、恢复、远端删除和本地删除；
- 设置校验、凭证不落盘和错误分类。

### 12.2 集成测试

使用临时 Vault、合成 CalDAV 响应和假凭证存储验证：

1. 新事件只创建一次；
2. 重复同步不创建重复文件；
3. 本地拖动后远端不变时保持本地时间；
4. 远端改期或改名时只更新对应托管字段；
5. 本地项目、标签、备注和状态不被覆盖；
6. 远端取消保留本地文件并标记取消；
7. 本地删除后不自动重新创建；
8. 循环事件按发生项稳定导入；
9. 网络、认证、解析和写入失败都可安全重试；
10. TaskNotes 日历可发现 `TaskNotes/DingTalk/`，ATL `10_Tasks` 看板不会发现这些文件。

### 12.3 回归验证

- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm test`；
- `pnpm build`；
- 现有 ATL 收集、任务确认、后台运行、TaskNotes 卡片样式和任务生命周期测试全部通过。

## 13. 风险

1. **CalDAV 实现差异**：不同服务对 `REPORT`、同步令牌和循环例外的支持不同。实现应优先使用标准协议，必要时对窗口内事件做安全全量刷新。
2. **TaskNotes 属性映射变化**：依赖公开的 `type`、`scheduled` 和 `timeEstimate` 字段；不依赖私有服务或 DOM。
3. **本地拖动与远端改期冲突**：通过上次远端快照判断“远端是否真的变化”，并在同步摘要中报告远端覆盖。
4. **事件身份不稳定**：使用 UID 与 recurrence ID，不使用标题或 href 作为唯一键。
5. **长期账本增长**：只压缩已离开查询窗口且已结束的历史发生项，保留必要墓碑。

## 14. 待实现验证项

以下不是产品决策待确认项，而是开发阶段必须用合成 fixture 和只读连接验证的技术事实：

- 钉钉 CalDAV 是否提供可用的 `sync-token`；
- 主日历资源的时区与全天事件编码；
- 循环例外的实际 `RECURRENCE-ID` 格式；
- Obsidian `SecretStorage` 与现有旧版 Keychain 凭证的迁移路径；
- TaskNotes 当前版本对 `TaskNotes/DingTalk/` 目录和导入状态字段的显示行为。

## 15. 交接建议

设计已确认，下一步使用 Superpowers `writing-plans` 将本规格拆成小步实现计划，优先顺序为：

1. CalDAV 与 iCalendar 纯函数解析层；
2. 事件账本、稳定身份和字段合并服务；
3. TaskNotes Markdown writer 与临时 Vault 集成测试；
4. Obsidian 设置页、手动同步和后台定时同步；
5. 真实只读连接预检、构建、CR 与发布。
