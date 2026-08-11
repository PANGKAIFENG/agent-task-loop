export const WORK_PROGRESS_README_PATH = '09_Progress/README.md';

export interface WorkProgressEntryFileSystem {
  exists(path: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
}

const README = `# 工作沉淀

这里保存由会议证据形成的工作进展、待补材料和周报验收版本。

## 入口

- [[09_Progress/Items|工作进展]]：按主题保存的版本化进展。
- [[09_Progress/Weekly|周报验收]]：按周生成、独立验收的周报快照。
- [[09_Progress/Requests|待补材料]]：缺失材料、查找记录和待审消息草稿。

日常操作请使用 Agent Task Loop 的“工作沉淀”视图。
`;

export async function ensureWorkProgressEntry(
  fileSystem: WorkProgressEntryFileSystem,
): Promise<{ created: boolean; path: string }> {
  if (await fileSystem.exists(WORK_PROGRESS_README_PATH)) {
    return { created: false, path: WORK_PROGRESS_README_PATH };
  }
  await fileSystem.ensureDirectory('09_Progress');
  await fileSystem.create(WORK_PROGRESS_README_PATH, README);
  return { created: true, path: WORK_PROGRESS_README_PATH };
}
