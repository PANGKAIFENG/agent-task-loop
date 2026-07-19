import type { Task } from '../domain/task.js';

function valueOrFallback(value: string | null, fallback = '暂未填写'): string {
  return value === null || value.trim() === '' ? fallback : value.trim();
}

export function formatCodexHandoff(task: Task, absolutePath: string): string {
  const lines = [
    '请基于以下 Obsidian 任务继续工作。先读取任务文件并核对当前内容；完成后更新任务进展或交付结果。',
    '',
    `任务：${task.title}`,
    `任务文件：${absolutePath}`,
    `状态：${task.status}`,
    `优先级：${task.priority}`,
    `项目：${valueOrFallback(task.projectId, '未选择')}`,
    '',
    '正文：',
    task.body.trim() || '暂未填写',
    '',
    `目标：${valueOrFallback(task.objective)}`,
    '完成条件：',
    ...(task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((criterion) => `- ${criterion}`)
      : ['- 暂未填写']),
    '',
    `来源：${task.origin}`,
  ];
  if (task.sourceDate !== null) lines.push(`来源日期：${task.sourceDate}`);
  if (task.sourceNote !== null) lines.push(`来源笔记：${task.sourceNote}`);
  if (task.sourceQuote !== null) lines.push(`来源摘要：${task.sourceQuote}`);
  return lines.join('\n');
}
