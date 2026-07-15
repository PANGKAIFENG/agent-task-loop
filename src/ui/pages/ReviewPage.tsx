import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleDotDashed, FileCheck2 } from 'lucide-react';

import { readReview } from '../api.js';

export function ReviewPage() {
  const query = useQuery({ queryKey: ['review'], queryFn: readReview });

  return (
    <section className="page" aria-labelledby="review-title">
      <header className="page-header">
        <div><p className="eyebrow">交付核验</p><h1 id="review-title">待验收</h1></div>
        <span className="count-label">{query.data?.length ?? 0} 项</span>
      </header>
      {query.isPending && <div className="page-state" role="status"><CircleDotDashed aria-hidden="true" />正在载入待验收</div>}
      {query.isError && (
        <div className="page-state page-state-error" role="alert">
          <AlertTriangle aria-hidden="true" /><span>无法载入待验收</span>
          <button type="button" onClick={() => void query.refetch()}>重试</button>
        </div>
      )}
      {query.data?.length === 0 && <div className="page-state">暂无待验收任务</div>}
      {query.data !== undefined && query.data.length > 0 && (
        <div className="review-list" role="list" aria-label="待验收任务">
          {query.data.map((task) => {
            const evidenceCount = task.artifactSummaries.reduce((sum, artifact) => sum + artifact.evidenceCount, 0);
            return (
              <article className="review-row" role="listitem" key={task.taskId}>
                <div className="review-title"><FileCheck2 aria-hidden="true" /><div><h2>{task.title}</h2><p>{task.projectId ?? '未关联项目'}</p></div></div>
                <div className="review-summary">
                  {task.artifactSummaries.length === 0
                    ? <span className="muted">暂无结果摘要</span>
                    : task.artifactSummaries.map((artifact, index) => <p key={`${task.taskId}-${index}`}>{artifact.summary}</p>)}
                </div>
                <div className="criteria-list" aria-label="验收标准">
                  {task.acceptanceCriteria.map((criterion) => <span key={criterion}>{criterion}</span>)}
                </div>
                <div className="review-meta"><span>{evidenceCount} 条证据</span><span>第 {task.attempts} 次</span></div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
