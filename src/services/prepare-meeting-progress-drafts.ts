import type { ProgressDraft } from '../domain/progress.js';

export interface PrepareMeetingProgressDraftsInput {
  meetingTitle: string;
  occurredAt: string;
  sourceRef: string;
  summary: string;
}

interface TopicSection {
  topic: string;
  detail: string;
}

const MAX_DRAFTS = 8;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const TOP_LEVEL_ITEM = /^\s*(?:[-*+] |\d+[.)]\s+)(.+?)\s*$/u;
const TOPIC_SEPARATOR = /[：:]/u;

function headingSections(summary: string): TopicSection[] {
  const sections: TopicSection[] = [];
  let current: TopicSection | null = null;
  for (const line of summary.split(/\r?\n/u)) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      if (current !== null) sections.push(current);
      current = { topic: heading[1]!.trim(), detail: '' };
      continue;
    }
    if (current !== null && line.trim() !== '') {
      current.detail = [current.detail, line.trim()].filter(Boolean).join('\n');
    }
  }
  if (current !== null) sections.push(current);
  return sections.filter(({ topic }) => topic !== '');
}

function itemTopic(value: string): string {
  const separator = value.search(TOPIC_SEPARATOR);
  return (separator > 0 ? value.slice(0, separator) : value).trim();
}

function bulletSections(summary: string): TopicSection[] {
  return summary.split(/\r?\n/u).flatMap((line) => {
    const item = TOP_LEVEL_ITEM.exec(line);
    if (item === null) return [];
    const detail = item[1]!.trim();
    const topic = itemTopic(detail);
    return topic === '' ? [] : [{ topic, detail }];
  });
}

function topicSections(input: PrepareMeetingProgressDraftsInput): TopicSection[] {
  const headings = headingSections(input.summary);
  if (headings.length > 0) return headings;
  const bullets = bulletSections(input.summary);
  if (bullets.length > 0) return bullets;
  const detail = input.summary.trim();
  return detail === '' ? [] : [{ topic: input.meetingTitle.trim(), detail }];
}

export function prepareMeetingProgressDrafts(
  input: PrepareMeetingProgressDraftsInput,
): ProgressDraft[] {
  return topicSections(input).slice(0, MAX_DRAFTS).map(({ topic, detail }) => ({
    topic,
    reportCategory: 'routine_check',
    primaryProjectId: null,
    occurredAt: input.occurredAt,
    sources: [input.sourceRef],
    statements: [{
      kind: 'pending',
      text: detail === '' ? topic : detail,
      sourceRefs: [input.sourceRef],
    }],
    evidence: [{
      kind: 'discussion',
      summary: detail === '' ? topic : detail,
      sourceRef: input.sourceRef,
    }],
    selfEvidence: [],
    agentEvidence: [],
  }));
}
