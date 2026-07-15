import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClipboardCheck, FolderKanban, Inbox, Plus } from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';

import { InboxPage } from './pages/InboxPage.js';
import { ProjectBoardPage } from './pages/ProjectBoardPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { ReviewPage } from './pages/ReviewPage.js';

type Route =
  | { name: 'inbox' }
  | { name: 'review' }
  | { name: 'projects' }
  | { name: 'project'; projectId: string };

function routeFromPathname(pathname: string): Route {
  if (pathname === '/review') return { name: 'review' };
  if (pathname === '/projects') return { name: 'projects' };
  const projectMatch = /^\/projects\/([^/]+)$/.exec(pathname);
  if (projectMatch?.[1] !== undefined) {
    return { name: 'project', projectId: decodeURIComponent(projectMatch[1]) };
  }
  return { name: 'inbox' };
}

function AppShell() {
  const [route, setRoute] = useState(() => routeFromPathname(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => setRoute(routeFromPathname(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (pathname: string) => {
    if (pathname !== window.location.pathname) window.history.pushState({}, '', pathname);
    setRoute(routeFromPathname(pathname));
  };
  const navigateLink = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(event.currentTarget.pathname);
  };
  const activeNav = route.name === 'project' ? 'projects' : route.name;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="product-mark"><span>ATL</span><strong>任务循环</strong></div>
        <nav className="primary-nav" aria-label="主导航">
          <a href="/inbox" aria-current={activeNav === 'inbox' ? 'page' : undefined} onClick={navigateLink}><Inbox aria-hidden="true" />收件箱</a>
          <a href="/review" aria-current={activeNav === 'review' ? 'page' : undefined} onClick={navigateLink}><ClipboardCheck aria-hidden="true" />待验收</a>
          <a href="/projects" aria-current={activeNav === 'projects' ? 'page' : undefined} onClick={navigateLink}><FolderKanban aria-hidden="true" />项目</a>
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="topbar-context">本地工作台</span>
          <button className="capture-command" type="button" aria-disabled="true" title="快速记录"><Plus aria-hidden="true" />快速记录</button>
        </header>
        <main>
          {route.name === 'inbox' && <InboxPage />}
          {route.name === 'review' && <ReviewPage />}
          {route.name === 'projects' && <ProjectsPage navigate={navigate} />}
          {route.name === 'project' && <ProjectBoardPage projectId={route.projectId} navigate={navigate} />}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15_000 } },
  }));
  return <QueryClientProvider client={queryClient}><AppShell /></QueryClientProvider>;
}
