import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleDotDashed, Clock3, Copy } from 'lucide-react';

import { readInbox, type Priority, type TaskDto } from '../api.js';

const priorityLabels: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

function missingFields(task: TaskDto): string[] {
  const missing: string[] = [];
  if (task.projectId === null) missing.push('项目');
  if (task.taskType !== 'research') missing.push('任务类型');
  if (task.objective === null || task.objective.trim() === '') missing.push('目标');
  if (task.acceptanceCriteria.length === 0) missing.push('验收标准');
  if (task.permissionProfile !== 'read_only_research') missing.push('权限');
  if (!task.autoExecutable) missing.push('自动执行');
  return missing;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function InboxPage() {
  const query = useQuery({ queryKey: ['inbox'], queryFn: readInbox });

  return (
    <section className="page" aria-labelledby="inbox-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">候选任务</p>
          <h1 id="inbox-title">收件箱</h1>
        </div>
        <span className="count-label">{query.data?.length ?? 0} 项</span>
      </header>

      {query.isPending && <div className="page-state" role="status"><CircleDotDashed aria-hidden="true" />正在载入收件箱</div>}
      {query.isError && (
        <div className="page-state page-state-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>无法载入收件箱</span>
          <button type="button" onClick={() => void query.refetch()}>重试</button>
        </div>
      )}
      {query.data?.length === 0 && <div className="page-state">收件箱为空</div>}
      {query.data !== undefined && query.data.length > 0 && (
        <div className="task-table" role="list" aria-label="收件箱任务">
          {query.data.map((task) => {
            const missing = missingFields(task);
            return (
              <article className="task-row" role="listitem" key={task.taskId}>
                <div className="task-main">
                  <h2>{task.title}</h2>
                  <p className="task-source">{task.origin}{task.sourceDate === null ? '' : ` · ${task.sourceDate}`}</p>
                  {task.sourceExcerpt !== null && <p className="task-excerpt">{task.sourceExcerpt}</p>}
                </div>
                <div className="task-readiness">
                  <span className={missing.length === 0 ? 'signal signal-success' : 'signal signal-warning'}>
                    {missing.length === 0 ? '可确认' : `缺少 ${missing.length} 项`}
                  </span>
                  {missing.length > 0 && <span className="missing-fields">{missing.join('、')}</span>}
                </div>
                <div className="task-meta">
                  {task.possibleDuplicateIds.length > 0 && (
                    <span className="signal signal-warning"><Copy aria-hidden="true" />疑似重复 {task.possibleDuplicateIds.length}</span>
                  )}
                  <span className={`priority priority-${task.priority}`}>{priorityLabels[task.priority]}</span>
                  <span className="timestamp"><Clock3 aria-hidden="true" />{formatTime(task.createdAt)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
