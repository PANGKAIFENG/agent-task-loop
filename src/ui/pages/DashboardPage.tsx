import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  BotOff,
  CheckCheck,
  ChevronDown,
  CircleDotDashed,
  CircleUserRound,
  Inbox,
  ListTodo,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState, type MouseEvent } from 'react';

import {
  readDashboard,
  type DashboardCardDto,
  type DashboardFactDto,
  type WorkbenchDashboardDto,
} from '../api.js';

interface DashboardPageProps {
  navigate: (pathname: string) => void;
}

const factKindLabels: Record<DashboardFactDto['kind'], string> = {
  fact: '事实',
  inference: '推断',
  missing: '缺失',
  human_confirmation: '待人工确认',
};

const viewIcons: Record<WorkbenchDashboardDto['views'][number]['id'], LucideIcon> = {
  requires_user: CircleUserRound,
  agent_attention: BotOff,
  intake: Inbox,
  important_not_urgent: ListTodo,
  weekly_insights: Sparkles,
};

const dataStateLabels: Record<Exclude<WorkbenchDashboardDto['dataState'], 'empty' | 'complete'>, string> = {
  partial: '数据部分缺失',
  stale: '数据可能过期',
  integrity: '数据完整性异常',
};

function Fact({ label, value }: { label: string; value: DashboardFactDto }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={`dashboard-fact-kind is-${value.kind}`}>{factKindLabels[value.kind]}</span>
        <span>{value.label}</span>
      </dd>
    </div>
  );
}

const toneSeverity: Record<DashboardFactDto['kind'], number> = {
  missing: 3,
  human_confirmation: 2,
  inference: 1,
  fact: 0,
};

const toneLabels: Record<DashboardFactDto['kind'], string> = {
  missing: '含缺失信息',
  human_confirmation: '含待人工确认项',
  inference: '含推断信息',
  fact: '全部为事实',
};

function cardTone(facts: DashboardFactDto[]): DashboardFactDto['kind'] {
  return facts.reduce<DashboardFactDto['kind']>(
    (weakest, fact) => (toneSeverity[fact.kind] > toneSeverity[weakest] ? fact.kind : weakest),
    'fact',
  );
}

function DashboardCard({
  card,
  navigate,
}: {
  card: DashboardCardDto;
  navigate: DashboardPageProps['navigate'];
}) {
  const [expanded, setExpanded] = useState(false);
  const navigateLink = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(event.currentTarget.pathname);
  };
  const tone = cardTone([card.reason, card.source, card.goalImpact]);

  return (
    <article className={`dashboard-card${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="dashboard-card-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`dashboard-tone-dot is-${tone}`} aria-hidden="true" />
        <span className="dashboard-card-summary-text">
          <span className={`sr-only dashboard-tone-label is-${tone}`}>{toneLabels[tone]}，</span>
          <strong className="dashboard-card-title">{card.title}</strong>
          <small>{card.status.label} · {card.source.label} · {card.timeliness.label}</small>
        </span>
        <ChevronDown className="dashboard-card-chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="dashboard-card-detail">
          <dl className="dashboard-card-facts">
            <Fact label="出现理由" value={card.reason} />
            <Fact label="事实来源" value={card.source} />
            <Fact label="目标影响" value={card.goalImpact} />
          </dl>
          <footer>
            <div className="dashboard-refs">
              <span><b>规则</b><code>{card.ruleRef}</code></span>
              <span className={card.traceRef === null ? 'is-missing' : undefined}>
                <b>Trace</b><code>{card.traceRef ?? 'Trace 缺失'}</code>
              </span>
            </div>
            <a href={card.action.href} onClick={navigateLink}>
              {card.action.label}<ArrowUpRight aria-hidden="true" />
            </a>
          </footer>
        </div>
      )}
    </article>
  );
}

export function DashboardPage({ navigate }: DashboardPageProps) {
  const query = useQuery({ queryKey: ['dashboard'], queryFn: readDashboard });

  return (
    <section className="page" aria-labelledby="dashboard-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">动态决策流</p>
          <h1 id="dashboard-title">决策驾驶舱</h1>
        </div>
      </header>
      {query.isPending && (
        <div className="page-state" role="status">
          <CircleDotDashed aria-hidden="true" />正在汇总决策事实
        </div>
      )}
      {query.isError && (
        <div className="page-state page-state-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>无法载入决策事实</span>
          <button type="button" onClick={() => void query.refetch()}>重试</button>
        </div>
      )}
      {query.data !== undefined && (
        <>
          {query.data.dataState !== 'empty' && query.data.dataState !== 'complete' && (
            <aside className={`dashboard-data-state is-${query.data.dataState}`} aria-label="驾驶舱数据状态">
              <AlertTriangle aria-hidden="true" />
              <strong>{dataStateLabels[query.data.dataState]}</strong>
              <span>{query.data.stateReasons.join('；')}</span>
            </aside>
          )}
          <section className="dashboard-summary" aria-label="工作摘要">
            <div><CircleUserRound aria-hidden="true" /><span>需要我处理</span><strong>{query.data.summary.needsUser}</strong><small>项人工动作</small></div>
            <div><CheckCheck aria-hidden="true" /><span>本周结果</span><strong>{query.data.summary.weeklyResults}</strong><small>项已完成</small></div>
            <div><Activity aria-hidden="true" /><span>推进中</span><strong>{query.data.summary.activeTasks}</strong><small>项执行中</small></div>
            <div className="dashboard-summary-candidate"><Inbox aria-hidden="true" /><span>候选任务</span><strong>{query.data.summary.candidateTasks}</strong><small>{query.data.summary.candidateTasks} 项待人工确认</small></div>
            <div className="dashboard-summary-agent"><Bot aria-hidden="true" /><span>Agent 队列</span><strong>{query.data.summary.agentQueue.admitted}</strong><small>原始 {query.data.summary.agentQueue.raw} · 准入 {query.data.summary.agentQueue.admitted} · 隔离 {query.data.summary.agentQueue.quarantined}</small></div>
          </section>
        </>
      )}
      {query.data?.dataState === 'empty' && (
        <div className="page-state dashboard-empty">当前没有需要显示的决策事项</div>
      )}
      {query.data !== undefined && (
        <div className="dashboard-views">
          {query.data.views.map((view) => {
            const ViewIcon = viewIcons[view.id];
            return (
              <section className={`dashboard-view dashboard-view-${view.id}`} aria-labelledby={`dashboard-view-${view.id}`} key={view.id}>
                <header>
                  <span className="dashboard-view-icon"><ViewIcon aria-hidden="true" /></span>
                  <div>
                    <h2 id={`dashboard-view-${view.id}`}>{view.label}</h2>
                    <p>{view.description}</p>
                  </div>
                  <strong>{view.cards.length}</strong>
                </header>
                {view.cards.length === 0
                  ? <p className="dashboard-view-empty">当前无事项</p>
                  : <div className="dashboard-card-list">{view.cards.map((card) => <DashboardCard card={card} navigate={navigate} key={card.cardId} />)}</div>}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
