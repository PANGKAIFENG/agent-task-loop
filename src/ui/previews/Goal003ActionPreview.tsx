// Preview-only fixture for PAW-GOAL-003; keep out of production navigation.
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CirclePause,
  FileCode2,
  GitPullRequest,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';

type PreviewState = 'decision' | 'rc' | 'stale' | 'error' | 'empty';

const states: Array<{ id: PreviewState; label: string }> = [
  { id: 'decision', label: '需要决策' },
  { id: 'rc', label: 'RC 待验收' },
  { id: 'stale', label: '候选已过期' },
  { id: 'error', label: '对账失败' },
  { id: 'empty', label: '无待处理' },
];

function initialState(): PreviewState {
  const value = new URLSearchParams(window.location.search).get('state');
  return states.some((state) => state.id === value) ? value as PreviewState : 'decision';
}

const taskCards = [
  { title: 'Obsidian 到 Multica 的真实开发闭环', issue: 'TEP-41', status: '需要决策', tone: 'warning' },
  { title: '统一任务统计口径', issue: 'TEP-39', status: '执行中', tone: 'success' },
  { title: '周复盘洞察回流', issue: 'TEP-38', status: '已阻塞', tone: 'blocked' },
];

export function Goal003ActionPreview() {
  const [state, setState] = useState<PreviewState>(initialState);
  const selectState = (next: PreviewState) => {
    window.history.replaceState({}, '', `/__preview__/paw-goal-003?state=${next}`);
    setState(next);
  };

  return (
    <section className="page goal003-preview" data-preview-state={state} aria-labelledby="goal003-preview-title">
      <header className="page-header goal003-preview-header">
        <div><p className="eyebrow">个人工作台 / PAW-GOAL-003</p><h1 id="goal003-preview-title">项目看板</h1></div>
        <span className="goal003-preview-label">目标态预览，不连接真实数据</span>
      </header>

      <div className="goal003-state-switcher" role="tablist" aria-label="预览状态">
        {states.map((item) => (
          <button
            aria-selected={state === item.id}
            className={state === item.id ? 'is-active' : undefined}
            key={item.id}
            onClick={() => selectState(item.id)}
            role="tab"
            type="button"
          >{item.label}</button>
        ))}
      </div>

      <div className="goal003-workspace">
        <section className="goal003-board" aria-label="个人工作台任务">
          <div className="goal003-board-tools">
            <div><strong>个人工作台</strong><span>3 个进行中的任务</span></div>
            <label>状态<select defaultValue="needs_action" aria-label="状态筛选"><option value="needs_action">需要我处理</option><option>全部状态</option></select></label>
          </div>
          <div className="goal003-columns">
            <section className="goal003-column">
              <header><span>需要我处理</span><strong>{state === 'empty' ? 0 : 1}</strong></header>
              {state === 'empty' ? (
                <div className="goal003-empty"><CheckCircle2 aria-hidden="true" /><strong>当前没有待处理事项</strong><span>普通开发进展继续保留在 Multica。</span></div>
              ) : taskCards.slice(0, 1).map((task) => (
                <article className="goal003-task is-selected" key={task.issue}>
                  <div className="goal003-task-meta"><span className={`goal003-status is-${state === 'rc' || state === 'stale' ? 'review' : task.tone}`}>{state === 'rc' ? 'RC 待验收' : state === 'stale' ? '候选已过期' : state === 'error' ? '对账失败' : task.status}</span><span>{task.issue}</span></div>
                  <h2>{task.title}</h2>
                  <p>{state === 'rc' || state === 'stale' ? 'PR #12 · 7f3a91c · Fresh CR passed' : '选择 synthetic canary 的恢复策略'}</p>
                  <footer><span>5 分钟前</span><button type="button">查看动作<ArrowUpRight aria-hidden="true" /></button></footer>
                </article>
              ))}
            </section>
            <section className="goal003-column">
              <header><span>开发中</span><strong>2</strong></header>
              {taskCards.slice(1).map((task) => (
                <article className="goal003-task" key={task.issue}>
                  <div className="goal003-task-meta"><span className={`goal003-status is-${task.tone}`}>{task.status}</span><span>{task.issue}</span></div>
                  <h2>{task.title}</h2><p>完整进展在 Multica</p>
                </article>
              ))}
            </section>
          </div>
        </section>

        <aside className="goal003-action-panel" aria-label="原任务动作详情">
          {state === 'empty' ? (
            <div className="goal003-panel-empty"><MessageSquareText aria-hidden="true" /><h2>动作详情</h2><p>选择一个带“需要我处理”信号的任务后，这里展示原 Task 的 action_request。</p></div>
          ) : (
            <ActionPanel state={state} />
          )}
        </aside>
      </div>
    </section>
  );
}

function ActionPanel({ state }: { state: Exclude<PreviewState, 'empty'> }) {
  const isRc = state === 'rc' || state === 'stale';
  return (
    <>
      <header className="goal003-action-header">
        <div className={`goal003-action-icon is-${state}`}>
          {state === 'decision' && <MessageSquareText aria-hidden="true" />}
          {state === 'rc' && <ShieldCheck aria-hidden="true" />}
          {state === 'stale' && <RefreshCw aria-hidden="true" />}
          {state === 'error' && <AlertTriangle aria-hidden="true" />}
        </div>
        <div><p>{isRc ? 'Release candidate' : state === 'error' ? 'Reconciliation' : 'Decision request'}</p><h2>{state === 'decision' ? '选择恢复策略' : state === 'rc' ? '接受并发布当前候选' : state === 'stale' ? '候选已更新，旧操作失效' : '无法确认远端回复状态'}</h2></div>
      </header>

      <dl className="goal003-action-facts">
        <div><dt>原 Task</dt><dd>Obsidian 到 Multica 的真实开发闭环</dd></div>
        <div><dt>Multica</dt><dd><a href="#tep-41">TEP-41 <ArrowUpRight aria-hidden="true" /></a></dd></div>
        <div><dt>Event</dt><dd>evt-rc-20260820-01</dd></div>
        {isRc && <div><dt>GitHub</dt><dd><a href="#pr-12">PR #12 <GitPullRequest aria-hidden="true" /></a> <code>{state === 'stale' ? '7f3a91c (old)' : '7f3a91c'}</code></dd></div>}
      </dl>

      <section className={`goal003-inline-state is-${state}`} role={state === 'error' || state === 'stale' ? 'alert' : 'status'}>
        {state === 'decision' && <><MessageSquareText aria-hidden="true" /><div><strong>执行器需要一个明确选择</strong><p>真实 Vault 写入前，选择仅使用 synthetic canary，或暂停本轮执行。</p></div></>}
        {state === 'rc' && <><ShieldCheck aria-hidden="true" /><div><strong>Fresh CR 已通过</strong><p>候选绑定 `7f3a91c`。接受后将合并 PR、安装插件、运行 synthetic live verification 并逐系统回读。</p></div></>}
        {state === 'stale' && <><RefreshCw aria-hidden="true" /><div><strong>SHA 已从 7f3a91c 更新为 92d0c4a</strong><p>旧接受动作已 superseded。请等待新 Fresh CR 和新的 RC 通知。</p></div></>}
        {state === 'error' && <><AlertTriangle aria-hidden="true" /><div><strong>回复可能已写入 Multica</strong><p>系统会先查询 comment marker 与 run ID；当前不会重复评论或 rerun。</p></div></>}
      </section>

      <section className="goal003-action-summary">
        <h3>本次动作</h3>
        <p>{isRc ? '完整开发过程留在 Multica；原 Task 只保存候选引用、验收结论和最终 Receipt。' : '选择结果将同时写入 ATL ledger 与 Multica；钉钉只负责通知和接收一次可信回复。'}</p>
      </section>

      <div className="goal003-action-buttons">
        {state === 'decision' && <><button className="is-primary" type="button"><CheckCircle2 aria-hidden="true" />使用 synthetic canary</button><button type="button"><CirclePause aria-hidden="true" />暂停</button><button type="button"><XCircle aria-hidden="true" />取消</button></>}
        {state === 'rc' && <><button className="is-primary" type="button"><ShieldCheck aria-hidden="true" />接受并发布</button><button type="button"><RefreshCw aria-hidden="true" />返工</button><button type="button"><CirclePause aria-hidden="true" />暂停</button><button type="button"><XCircle aria-hidden="true" />取消</button></>}
        {state === 'stale' && <><button disabled type="button"><ShieldCheck aria-hidden="true" />旧候选不可发布</button><button className="is-primary" type="button"><RefreshCw aria-hidden="true" />查看最新事件</button></>}
        {state === 'error' && <><button className="is-primary" type="button"><RefreshCw aria-hidden="true" />立即对账</button><button type="button"><CirclePause aria-hidden="true" />保持暂停</button></>}
      </div>
      <a className="goal003-open-task" href="#original-task"><FileCode2 aria-hidden="true" />打开 Obsidian 原 Task<ArrowUpRight aria-hidden="true" /></a>
    </>
  );
}
