import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleDotDashed, Clock3, Copy } from 'lucide-react';
import { useState } from 'react';

import { CandidateInspector } from '../components/CandidateInspector.js';
import { readInbox, type Priority } from '../api.js';

const priorityLabels: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  return (
    <section className={`page inbox-page${selectedTaskId === null ? '' : ' has-selection'}`} aria-labelledby="inbox-title">
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
        <div className={`candidate-workspace${selectedTaskId === null ? '' : ' has-selection'}`}>
          <div className="candidate-list-pane">
            <div className="task-table" role="list" aria-label="收件箱任务">
              {query.data.map((task) => (
                <button
                  className={`task-row${selectedTaskId === task.taskId ? ' is-selected' : ''}`}
                  type="button"
                  aria-pressed={selectedTaskId === task.taskId}
                  key={task.taskId}
                  onClick={() => setSelectedTaskId(task.taskId)}
                >
                  <div className="task-main">
                    <strong className="task-title">{task.title}</strong>
                    <p className="task-source">{task.origin}{task.sourceDate === null ? '' : ` · ${task.sourceDate}`}</p>
                    {task.sourceExcerpt !== null && <p className="task-excerpt">{task.sourceExcerpt}</p>}
                  </div>
                  <div className="task-readiness">
                    <span className={task.reviewState === 'confirmed' ? 'signal signal-success' : 'signal signal-warning'}>
                      {task.reviewState === 'confirmed' ? '已确认' : '待理解'}
                    </span>
                    <span className="missing-fields">auto_executable={String(task.autoExecutable)}</span>
                  </div>
                  <div className="task-meta">
                    {task.possibleDuplicateIds.length > 0 && (
                      <span className="signal signal-warning"><Copy aria-hidden="true" />疑似重复 {task.possibleDuplicateIds.length}</span>
                    )}
                    <span className={`priority priority-${task.priority}`}>{priorityLabels[task.priority]}</span>
                    <span className="timestamp"><Clock3 aria-hidden="true" />{formatTime(task.createdAt)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
          {selectedTaskId !== null && (
            <div className="candidate-detail-pane">
              <CandidateInspector taskId={selectedTaskId} onBack={() => setSelectedTaskId(null)} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
