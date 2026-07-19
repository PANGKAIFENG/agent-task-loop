import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleDotDashed } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  readProjects,
  readProjectTasks,
  type Priority,
  type TaskDto,
  type TaskStatus,
} from '../api.js';

const knownColumns: Array<{ status: TaskStatus; label: string }> = [
  { status: 'inbox', label: '待规划' },
  { status: 'ready', label: '待办' },
  { status: 'in_progress', label: '进行中' },
  { status: 'review', label: '审核中' },
  { status: 'done', label: '已完成' },
  { status: 'blocked', label: '已阻塞' },
  { status: 'cancelled', label: '已取消' },
];

const priorityLabels: Record<Priority, string> = {
  urgent: '紧急', high: '高', normal: '普通', low: '低',
};

interface ProjectBoardPageProps {
  projectId: string;
  navigate: (pathname: string) => void;
}

export function ProjectBoardPage({ projectId, navigate }: ProjectBoardPageProps) {
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: readProjects });
  const tasksQuery = useQuery({
    queryKey: ['project-tasks', projectId],
    queryFn: () => readProjectTasks(projectId),
  });
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('all');
  const [priority, setPriority] = useState('all');
  const [autoExecutable, setAutoExecutable] = useState('all');

  const project = projectsQuery.data?.find((candidate) => candidate.projectId === projectId);
  const sources = useMemo(
    () => Array.from(new Set((tasksQuery.data ?? []).map((task) => task.origin))).sort(),
    [tasksQuery.data],
  );
  const columns = useMemo(() => {
    const knownStatuses = new Set(knownColumns.map((column) => column.status));
    const customStatuses = Array.from(new Set(
      (tasksQuery.data ?? [])
        .map((task) => task.status)
        .filter((taskStatus) => !knownStatuses.has(taskStatus)),
    )).sort();
    return [
      ...knownColumns,
      ...customStatuses.map((taskStatus) => ({ status: taskStatus, label: taskStatus })),
    ];
  }, [tasksQuery.data]);
  const tasks = (tasksQuery.data ?? []).filter((task) => (
    (status === 'all' || task.status === status)
    && (source === 'all' || task.origin === source)
    && (priority === 'all' || task.priority === priority)
    && (autoExecutable === 'all' || String(task.autoExecutable) === autoExecutable)
  ));
  const pending = projectsQuery.isPending || tasksQuery.isPending;
  const error = projectsQuery.isError || tasksQuery.isError;

  return (
    <section className="page page-board" aria-labelledby="board-title">
      <header className="page-header board-header">
        <div><p className="eyebrow">{project?.name ?? projectId}</p><h1 id="board-title">项目看板</h1></div>
        <button className="text-button" type="button" onClick={() => navigate('/projects')}>返回项目</button>
      </header>
      <div className="filter-bar" aria-label="看板筛选">
        <label>项目筛选<select aria-label="项目筛选" value={projectId} onChange={(event) => navigate(`/projects/${encodeURIComponent(event.target.value)}`)}>
          {(projectsQuery.data ?? [{ projectId, name: project?.name ?? projectId }]).map((item) => <option value={item.projectId} key={item.projectId}>{item.name}</option>)}
        </select></label>
        <label>状态筛选<select aria-label="状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option>{columns.map((column) => <option value={column.status} key={column.status}>{column.label}</option>)}</select></label>
        <label>来源筛选<select aria-label="来源筛选" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部来源</option>{sources.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label>优先级筛选<select aria-label="优先级筛选" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">全部优先级</option>{Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>自动执行筛选<select aria-label="自动执行筛选" value={autoExecutable} onChange={(event) => setAutoExecutable(event.target.value)}><option value="all">全部</option><option value="true">可自动执行</option><option value="false">仅手动</option></select></label>
      </div>
      {pending && <div className="page-state board-state" role="status"><CircleDotDashed aria-hidden="true" />正在载入项目看板</div>}
      {error && (
        <div className="page-state board-state page-state-error" role="alert"><AlertTriangle aria-hidden="true" /><span>无法载入项目看板</span><button type="button" onClick={() => { void projectsQuery.refetch(); void tasksQuery.refetch(); }}>重试</button></div>
      )}
      {!pending && !error && (
        <div className="board-scroll" aria-label="项目任务看板">
          <div className="board-columns">
            {columns.map((column) => {
              const columnTasks = tasks.filter((task) => task.status === column.status);
              return (
                <section className="board-column" aria-labelledby={`column-${column.status}`} key={column.status}>
                  <header><h2 id={`column-${column.status}`}>{column.label}</h2><span>{columnTasks.length}</span></header>
                  <div className="board-stack">
                    {columnTasks.length === 0 && <div className="column-empty">暂无任务</div>}
                    {columnTasks.map((task: TaskDto) => (
                      <article className="task-card" key={task.taskId}>
                        <h3>{task.title}</h3><p>{task.origin}</p>
                        <footer><span className={`priority priority-${task.priority}`}>{priorityLabels[task.priority]}</span>{task.autoExecutable && <span className="signal signal-success">自动</span>}</footer>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
