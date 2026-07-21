# 统一任务日历设计规格

## 目标

让用户从 Obsidian 一个入口查看两类时间安排：

- TaskNotes 任务的 `scheduled` / `due`；
- ATL 只读导入的钉钉日程。

同时解决“任务拖到待执行后没有日期，因此日历没有卡片”的认知和操作断点。

## 现状与根因

TaskNotes 日历只会把有 `scheduled` 或 `due` 的任务放到日期格子里。看板拖动到“待执行”只改变 `status`，不会自动推断日期；没有日期的任务不应被伪造到今天。

当前 TaskNotes 的 `open-tasks-view` 被映射到只显示 ATL Inbox 的 Base，原生“Unscheduled”任务列表因此不可见。现有任务看板的全局过滤又只允许 `10_Tasks`，不能同时纳入 `TaskNotes/DingTalk`。

## 方案

新增 ATL 管理的 `10_Tasks/Views/统一日历.base`，不改 TaskNotes 插件文件和私有设置：

```text
ATL：统一日历
  ├─ 统一日历：所有 type: task 的已排期任务和钉钉日程
  └─ 待排期任务：未设置 scheduled 的未完成任务
```

统一日历的全局过滤只使用 `note["type"] == "task"`，因此同时覆盖 `10_Tasks/**` 与 `TaskNotes/DingTalk/**`。待排期视图再单独过滤未完成且没有 `scheduled` 的任务。

## 用户流程

1. 点击 Obsidian 左侧“ATL：统一日历”，或在设置/命令面板打开。
2. 在“统一日历”视图中看本地任务和钉钉日程。
3. 看板拖到“待执行”后，如果还没有安排日期，在“待排期任务”视图中找到它。
4. 通过任务卡菜单设置 `Scheduled Date`，或回到日历空白时间段选择/拖动任务。
5. 设置 `scheduled` 后，任务自动出现在统一日历对应日期；钉钉副本仍只在本地排程，不回写钉钉。

## 边界

- 不把没有日期的任务伪造到今天或当前时间。
- 不将钉钉日程放进 `10_Tasks`、ATL 执行队列或 Agent 任务列表。
- 不覆盖用户已存在的 `统一日历.base`，也不修改 TaskNotes 的 `data.json`。
- 不实现 ATL 自己的日历渲染器；继续使用 TaskNotes 的原生拖动、筛选和日期编辑。
- 本期不做日历与钉钉的双向写回。

## 验收标准

- 点击入口后，缺少文件时自动创建 `10_Tasks/Views/统一日历.base` 并打开。
- 已存在的文件保持原内容，不被 ATL 覆盖。
- Base 的统一日历过滤包含 `type: task`，不限制文件夹。
- Base 包含“待排期任务”视图，能显示 `scheduled` 为空且状态不是 `done` / `cancelled` 的任务。
- 任务设置 `scheduled` 后，在统一日历中可见；钉钉日程仍可见。
- 不影响现有任务总看板、钉钉同步和任务文件移动逻辑。
