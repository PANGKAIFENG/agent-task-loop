import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleDotDashed,
  FileSearch,
  RotateCcw,
  Save,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  ApiRequestError,
  openCandidateSource,
  readCandidateInspector,
  saveCandidateUnderstanding,
  type CandidateField,
  type CandidateInspectorDto,
} from '../api.js';

const FIELD_LABELS: Record<CandidateField, string> = {
  title: '任务标题',
  objective: '任务目标',
  next_action: '下一步动作',
  expected_artifact: '预期 Artifact',
  completion_criteria: '完成条件',
};

const ATTRIBUTION_LABELS = {
  source_fact: '来源事实',
  ai_inference: 'AI 推断',
  missing: '信息缺失',
} as const;

const SOURCE_STATUS_LABELS = {
  available: '可用',
  moved: '已移动',
  changed: '内容已变化',
  unavailable: '暂不可用',
  missing: '缺失',
} as const;

function valuesFrom(projection: CandidateInspectorDto): Record<CandidateField, string> {
  return Object.fromEntries(projection.suggestions.map((suggestion) => [
    suggestion.field,
    suggestion.suggestedValue,
  ])) as Record<CandidateField, string>;
}

function saveError(error: Error): string {
  if (error instanceof ApiRequestError && error.status === 409) {
    return '候选已在其他位置更新。请重新载入后核对差异，本次人工修改尚未覆盖远端 revision。';
  }
  if (error instanceof ApiRequestError && error.status === 400) {
    return '仍有阻断缺口或字段格式无效；任务未变化，请继续补充后重试。';
  }
  return '暂时无法保存候选理解；任务未变化，你的人工编辑仍保留在当前页面。';
}

export interface CandidateInspectorProps {
  taskId: string;
  onBack(): void;
}

export function CandidateInspector({ taskId, onBack }: CandidateInspectorProps) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['candidate-inspector', taskId], [taskId]);
  const query = useQuery({
    queryKey,
    queryFn: () => readCandidateInspector(taskId),
  });
  const [values, setValues] = useState<Record<CandidateField, string> | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sourceMessage, setSourceMessage] = useState('');
  const [openingSourceId, setOpeningSourceId] = useState<string | null>(null);

  useEffect(() => {
    if (query.data !== undefined) setValues(valuesFrom(query.data));
  }, [query.data]);

  useEffect(() => {
    setSourceMessage('');
    setOpeningSourceId(null);
  }, [taskId]);

  const mutation = useMutation({
    mutationFn: (confirm: boolean) => {
      if (query.data === undefined || values === null) {
        throw new Error('Candidate inspector is not ready');
      }
      return saveCandidateUnderstanding(taskId, {
        understanding: {
          ...query.data.understandingIdentity,
          suggestions: query.data.suggestions,
          sourceRefs: query.data.sourceRefs,
          gaps: query.data.gaps,
        },
        expectedRevision: query.data.taskIdentity.candidateRevision,
        expectedTaskUpdatedAt: query.data.taskIdentity.updatedAt,
        confirm,
        values,
      });
    },
    onMutate: () => {
      setMessage('');
      setError('');
    },
    onSuccess: (updated, confirm) => {
      queryClient.setQueryData(queryKey, updated);
      setValues(valuesFrom(updated));
      setMessage(confirm ? '任务理解已确认并保存新 revision' : '候选草稿已保存');
    },
    onError: (cause) => setError(saveError(cause)),
  });

  async function handleSourceAction(sourceRefId: string): Promise<void> {
    setSourceMessage('');
    setOpeningSourceId(sourceRefId);
    try {
      const result = await openCandidateSource(taskId, sourceRefId);
      if (result.outcome === 'located') {
        const anchor = result.locator.anchor === null ? '' : ` · ${result.locator.anchor}`;
        setSourceMessage(`已安全定位 ${result.locator.sourceNote}${anchor}`);
        document.getElementById(`candidate-source-${sourceRefId}`)?.focus();
      } else {
        setSourceMessage(`来源仍不可定位：${result.failureReason}。已保留有限引用，请修复路径或补充来源。`);
      }
    } catch {
      setSourceMessage('来源定位失败。已保留有限引用，请稍后重试或补充来源。');
    } finally {
      setOpeningSourceId(null);
    }
  }

  if (query.isPending) {
    return <div className="candidate-inspector-state" role="status"><CircleDotDashed aria-hidden="true" />正在载入候选理解</div>;
  }
  if (query.isError || query.data === undefined || values === null) {
    return (
      <div className="candidate-inspector-state is-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <span>无法载入候选理解</span>
        <button type="button" onClick={() => void query.refetch()}>重试</button>
      </div>
    );
  }

  const projection = query.data;
  const originals = valuesFrom(projection);
  return (
    <article className="candidate-inspector" aria-labelledby="candidate-inspector-title">
      <header className="candidate-inspector-header">
        <button className="icon-button candidate-back" type="button" onClick={onBack} aria-label="返回候选列表" title="返回候选列表">
          <ArrowLeft aria-hidden="true" />
        </button>
        <div>
          <p className="eyebrow">候选理解 · revision {projection.taskIdentity.candidateRevision}</p>
          <h2 id="candidate-inspector-title">{projection.taskIdentity.title}</h2>
          <p className="candidate-state-line">
            {projection.taskIdentity.status} · {projection.taskIdentity.reviewState} · auto_executable={String(projection.taskIdentity.autoExecutable)}
          </p>
        </div>
      </header>

      {projection.taskIdentity.candidateRevision === 0 && (
        <div className="candidate-banner" role="status">
          AI 建议当前不可用。原始字段、来源证据和确定性准入检查仍可使用；任务没有变化。
        </div>
      )}
      {error !== '' && <div className="candidate-banner is-error" role="alert">{error}</div>}
      {message !== '' && <div className="candidate-banner is-success" role="status">{message}</div>}

      <section className="candidate-section" aria-labelledby="understanding-title">
        <div className="candidate-section-heading">
          <h3 id="understanding-title">任务理解</h3>
          <span>所有字段均可人工编辑</span>
        </div>
        <div className="candidate-fields">
          {projection.suggestions.map((suggestion) => {
            const label = FIELD_LABELS[suggestion.field];
            const changed = values[suggestion.field] !== originals[suggestion.field];
            return (
              <div className="candidate-field" key={suggestion.field}>
                <div className="candidate-field-label">
                  <label htmlFor={`candidate-${suggestion.field}`}>{label}</label>
                  <span className={`attribution attribution-${suggestion.attribution}`}>
                    {ATTRIBUTION_LABELS[suggestion.attribution]}
                  </span>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`撤销 ${label} 修改`}
                    title={`撤销 ${label} 修改`}
                    disabled={!changed || mutation.isPending}
                    onClick={() => setValues((current) => current === null ? null : ({
                      ...current,
                      [suggestion.field]: originals[suggestion.field],
                    }))}
                  >
                    <RotateCcw aria-hidden="true" />
                  </button>
                </div>
                <textarea
                  id={`candidate-${suggestion.field}`}
                  aria-label={label}
                  rows={suggestion.field === 'title' ? 2 : 3}
                  value={values[suggestion.field]}
                  disabled={mutation.isPending}
                  onChange={(event) => setValues((current) => current === null ? null : ({
                    ...current,
                    [suggestion.field]: event.target.value,
                  }))}
                />
                <p className="candidate-field-reason">{suggestion.reason}</p>
                {suggestion.sourceRefIds.length > 0 && (
                  <p className="candidate-field-refs">来源：{suggestion.sourceRefIds.join('、')}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="candidate-section" aria-labelledby="source-evidence-title">
        <div className="candidate-section-heading"><h3 id="source-evidence-title">来源与依据</h3></div>
        {sourceMessage !== '' && <p className="source-action-message" role="status">{sourceMessage}</p>}
        {projection.sourceRefs.length === 0 && <p className="candidate-empty">当前没有有限来源引用。</p>}
        <div className="source-evidence-list">
          {projection.sourceRefs.map((source) => (
            <article
              className="source-evidence"
              id={`candidate-source-${source.sourceRefId}`}
              key={source.sourceRefId}
              tabIndex={-1}
            >
              <div className="source-evidence-heading">
                <strong>{source.sourceNote ?? source.sourceType}</strong>
                <span className={`source-status source-status-${source.status}`}>{SOURCE_STATUS_LABELS[source.status]}</span>
              </div>
              {source.anchor !== null && <p className="source-anchor">定位：{source.anchor}</p>}
              <blockquote>{source.quote === '' ? '未保留可显示引用' : source.quote}</blockquote>
              {source.parentContext !== null && <p className="source-parent">上层上下文：{source.parentContext}</p>}
              {source.failureReason !== null && <p className="source-failure">失效原因：{source.failureReason}</p>}
              <p className="source-verified">
                最近验证：{source.lastVerifiedAt ?? '尚未验证'}
                {source.lastVerifiedEvidence?.resolvedNote === null || source.lastVerifiedEvidence?.resolvedNote === undefined
                  ? ''
                  : ` · ${source.lastVerifiedEvidence.resolvedNote}`}
              </p>
              {projection.sourceActions
                .filter(({ sourceRefId }) => sourceRefId === source.sourceRefId)
                .map((action) => (
                  <button
                    className="source-action"
                    type="button"
                    key={`${action.actionId}-${action.sourceRefId}`}
                    disabled={openingSourceId !== null}
                    onClick={() => void handleSourceAction(action.sourceRefId)}
                  >
                    <FileSearch aria-hidden="true" />
                    {openingSourceId === action.sourceRefId ? '正在安全定位' : action.label}
                  </button>
                ))}
            </article>
          ))}
        </div>
      </section>

      <section className="candidate-section" aria-labelledby="candidate-gaps-title">
        <div className="candidate-section-heading"><h3 id="candidate-gaps-title">缺口</h3></div>
        {projection.gaps.length === 0 && <p className="candidate-empty">当前没有候选理解缺口。</p>}
        <ul className="candidate-gap-list">
          {projection.gaps.map((gap) => (
            <li key={gap.gapId} className={`candidate-gap is-${gap.severity}`}>
              <span>{gap.severity === 'blocking' ? '阻断' : '可选'}</span>
              <div><strong>{gap.question}</strong><code>{gap.reasonCode}</code></div>
            </li>
          ))}
        </ul>
      </section>

      <section className="candidate-section admission-section" aria-labelledby="candidate-admission-title">
        <div className="candidate-section-heading">
          <h3 id="candidate-admission-title">准入与权限</h3>
          <span>{projection.admission.verdict}</span>
        </div>
        <p className="authorization-boundary">确认任务理解不等于 Agent 授权，也不授予任何外部写权限。</p>
        <ul className="admission-reason-list">
          {projection.admission.reasons.map((reason) => (
            <li key={`${reason.code}-${reason.field_or_gate}`}>
              <code>{reason.code}</code>
              <span>{reason.message}</span>
              <small>{reason.next_action}</small>
            </li>
          ))}
        </ul>
        <p className="permission-summary">
          权限模式：{projection.permissionGate.mode ?? 'unknown'} · 外部写：{projection.permissionGate.external_writes.length} · 已授权：{String(projection.permissionGate.authorized)}
        </p>
      </section>

      <footer className="candidate-actions">
        <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(false)}>
          <Save aria-hidden="true" />保存草稿
        </button>
        <button className="primary-button" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(true)}>
          <Check aria-hidden="true" />确认任务理解
        </button>
      </footer>
    </article>
  );
}
