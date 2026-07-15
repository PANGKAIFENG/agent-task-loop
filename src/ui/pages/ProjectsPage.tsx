import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CircleDotDashed, FolderKanban } from 'lucide-react';

import { readProjects } from '../api.js';

interface ProjectsPageProps {
  navigate: (pathname: string) => void;
}

export function ProjectsPage({ navigate }: ProjectsPageProps) {
  const query = useQuery({ queryKey: ['projects'], queryFn: readProjects });

  return (
    <section className="page" aria-labelledby="projects-title">
      <header className="page-header">
        <div><p className="eyebrow">工作范围</p><h1 id="projects-title">项目</h1></div>
        <span className="count-label">{query.data?.length ?? 0} 个</span>
      </header>
      {query.isPending && <div className="page-state" role="status"><CircleDotDashed aria-hidden="true" />正在载入项目</div>}
      {query.isError && (
        <div className="page-state page-state-error" role="alert">
          <AlertTriangle aria-hidden="true" /><span>无法载入项目</span>
          <button type="button" onClick={() => void query.refetch()}>重试</button>
        </div>
      )}
      {query.data?.length === 0 && <div className="page-state">暂无项目</div>}
      {query.data !== undefined && query.data.length > 0 && (
        <div className="project-list" role="list" aria-label="项目列表">
          {query.data.map((project) => (
            <article className="project-row" role="listitem" key={project.projectId}>
              <FolderKanban aria-hidden="true" />
              <div className="project-copy"><h2>{project.name}</h2><p>{project.description}</p></div>
              <span className="project-resource-count">{project.resources.length} 个资源</span>
              <a
                className="icon-link"
                href={`/projects/${encodeURIComponent(project.projectId)}`}
                aria-label={`打开 ${project.name} 看板`}
                title={`打开 ${project.name} 看板`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(event.currentTarget.pathname);
                }}
              ><ArrowRight aria-hidden="true" /></a>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
