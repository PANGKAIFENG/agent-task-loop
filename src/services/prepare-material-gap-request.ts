import type {
  MaterialSearchSource,
  SuggestedMaterialContact,
} from '../domain/material-gap.js';
import type { ProgressVersion } from '../domain/progress.js';
import type { CreateMaterialGapInput } from './create-material-gap.js';
import { parseMeetingAttachments } from '../obsidian-plugin/meeting-note.js';
import { parseArtifactReference } from '../storage/artifact-reference.js';
import { parseTaskDocument } from '../storage/frontmatter.js';
import { isSafePathSegment } from '../storage/task-paths.js';

export type PrepareMaterialGapRequestInput = Omit<
  CreateMaterialGapInput,
  'searches' | 'suggestedContact'
>;

export interface PrepareMaterialGapRequestContext {
  loadProgress(progressId: string, version: number): Promise<ProgressVersion | null>;
  readSource(path: string): Promise<string | null>;
  listRelatedSources?(progress: ProgressVersion): Promise<MaterialSourceCandidate[]>;
  clock(): Date;
}

export interface MaterialSourceCandidate {
  source: MaterialSearchSource;
  target: string;
}

export interface RelatedMaterialProject {
  resources: readonly {
    kind: string;
    value: string;
  }[];
}

export interface RelatedMaterialTask {
  taskId: string;
  projectId: string | null;
  sourceNote: string | null;
  artifactRefs: readonly string[];
}

export interface ListRelatedMaterialSourcesContext {
  readSource(path: string): Promise<string | null>;
  loadProject(projectId: string): Promise<RelatedMaterialProject | null>;
  listTasks(): Promise<readonly RelatedMaterialTask[]>;
}

const MAX_RELATED_SOURCES = 100;
const MAX_MATERIAL_SEARCHES = 100;
const CALENDAR_LINK = /^\[\[(TaskNotes\/DingTalk\/sha256-[0-9a-f]{64})(?:\.md)?\]\]$/u;

function safeVaultRelativePath(value: string): string | null {
  const path = value.trim();
  if (
    path === ''
    || path.length > 4_096
    || path.startsWith('/')
    || path.startsWith('\\')
    || path.includes('\\')
    || /^[a-z][a-z0-9+.-]*:/iu.test(path)
  ) return null;
  const segments = path.split('/');
  if (segments.some((segment) => (
    segment === ''
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
  ))) return null;
  return path;
}

function searchSource(path: string): MaterialSearchSource | null {
  const safePath = safeVaultRelativePath(path);
  if (safePath === null) return null;
  if (safePath.startsWith('08_Meetings/')) return 'meeting_link';
  if (safePath.startsWith('TaskNotes/DingTalk/')) return 'calendar_attachment';
  if (safePath.startsWith('10_Tasks/Artifacts/')) return 'code_artifact';
  if (
    safePath.startsWith('01_Areas/')
    || safePath.startsWith('02_Projects/')
    || safePath.startsWith('03_Resources/')
    || safePath.startsWith('09_Progress/')
    || safePath.startsWith('10_Tasks/Projects/')
  ) return 'project_context';
  return null;
}

const INLINE_NUMERIC_VALUE = /(?:\d+(?:\.\d+)?%?|百分之[一二三四五六七八九十百千万亿]+|[一二三四五六七八九十百千万亿]+(?:项|个|类|条|份|人|次|天|周|月|年|元))/u;
const UNIT_NUMERIC_VALUE = /(?:\d+(?:\.\d+)?(?:%|项|个|类|条|份|人|次|天|周|月|年|元)|百分之[一二三四五六七八九十百千万亿]+|[一二三四五六七八九十百千万亿]+(?:项|个|类|条|份|人|次|天|周|月|年|元))/u;
const UNRESOLVED_MATERIAL = /(?:待补齐|待确认|待提供|待统计|尚未|未找到|未提供|未统计|暂无|缺失|未知|没有)/u;
const DATE_OR_TIME = /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?|\b\d{1,2}:\d{2}(?::\d{2})?\b/gu;

function searchableContent(content: string): string {
  try {
    return parseTaskDocument(content).body;
  } catch {
    return content;
  }
}

function numericEvidence(content: string, description: string): boolean {
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!line.includes(description) || UNRESOLVED_MATERIAL.test(line)) continue;
    const inline = line.replaceAll(description, '').replace(DATE_OR_TIME, '');
    if (INLINE_NUMERIC_VALUE.test(inline)) return true;
    for (let offset = 1; offset <= 4; offset += 1) {
      const nearby = lines[index + offset];
      if (
        nearby === undefined
        || nearby.trim() === ''
        || /^\s{0,3}#{1,6}\s/u.test(nearby)
        || UNRESOLVED_MATERIAL.test(nearby)
      ) break;
      if (UNIT_NUMERIC_VALUE.test(nearby.replace(DATE_OR_TIME, ''))) return true;
    }
  }
  return false;
}

function materialFound(content: string, input: PrepareMaterialGapRequestInput): boolean {
  const searchable = searchableContent(content);
  if (!searchable.includes(input.missing.description)) return false;
  if (input.missing.kind === 'numeric') {
    return numericEvidence(searchable, input.missing.description);
  }
  return searchable.split(/\r?\n/u).some((line) => (
    line.includes(input.missing.description) && !UNRESOLVED_MATERIAL.test(line)
  ));
}

function addCandidate(
  candidates: MaterialSourceCandidate[],
  seen: Set<string>,
  source: MaterialSearchSource,
  rawTarget: string,
): void {
  if (candidates.length >= MAX_RELATED_SOURCES) return;
  const target = safeVaultRelativePath(rawTarget);
  if (target === null) return;
  const identity = `${source}:${target}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  candidates.push({ source, target });
}

function calendarPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = CALENDAR_LINK.exec(value.trim());
  return match?.[1] === undefined ? null : `${match[1]}.md`;
}

export async function listRelatedMaterialSources(
  context: ListRelatedMaterialSourcesContext,
  progress: ProgressVersion,
): Promise<MaterialSourceCandidate[]> {
  const candidates: MaterialSourceCandidate[] = [];
  const seen = new Set<string>();
  for (const sourceRef of progress.sources) {
    const meetingPath = safeVaultRelativePath(sourceRef);
    if (meetingPath === null || !meetingPath.startsWith('08_Meetings/')) continue;
    let raw: string | null = null;
    try {
      raw = await context.readSource(meetingPath);
    } catch {
      // The original meeting source remains in the search ledger.
    }
    if (raw === null) continue;
    try {
      const document = parseTaskDocument(raw);
      const eventPath = calendarPath(document.data.calendar_event);
      if (eventPath !== null) {
        addCandidate(candidates, seen, 'calendar_attachment', eventPath);
      }
      for (const attachment of parseMeetingAttachments(document.data)) {
        addCandidate(candidates, seen, 'calendar_attachment', attachment.path);
      }
    } catch {
      // A malformed meeting note cannot authorize broader discovery.
    }
  }

  const projectId = progress.primaryProjectId?.trim() ?? '';
  if (!isSafePathSegment(projectId)) return candidates;
  addCandidate(
    candidates,
    seen,
    'project_context',
    `10_Tasks/Projects/${projectId}.md`,
  );
  try {
    const project = await context.loadProject(projectId);
    for (const resource of project?.resources ?? []) {
      if (resource.kind === 'local_path') {
        addCandidate(candidates, seen, 'project_context', resource.value);
      }
    }
  } catch {
    // The canonical project note is still recorded as an attempted source.
  }

  let tasks: readonly RelatedMaterialTask[] = [];
  try {
    tasks = await context.listTasks();
  } catch {
    return candidates;
  }
  for (const task of [...tasks]
    .filter((candidate) => candidate.projectId === projectId)
    .sort((left, right) => left.taskId.localeCompare(right.taskId))) {
    if (task.sourceNote !== null) {
      addCandidate(candidates, seen, 'project_context', task.sourceNote);
    }
    for (const artifactRef of task.artifactRefs) {
      if (parseArtifactReference(artifactRef, task.taskId) !== null) {
        addCandidate(candidates, seen, 'code_artifact', `10_Tasks/${artifactRef}`);
      }
    }
  }
  return candidates;
}

function structuredContact(
  content: string,
  sourceRef: string,
): SuggestedMaterialContact | null {
  let contacts: unknown;
  try {
    contacts = parseTaskDocument(content).data.material_contacts;
  } catch {
    return null;
  }
  if (!Array.isArray(contacts)) return null;
  for (const contact of contacts) {
    if (typeof contact !== 'object' || contact === null || Array.isArray(contact)) continue;
    const value = contact as Record<string, unknown>;
    if (
      typeof value.userId === 'string' && value.userId.trim() !== ''
      && typeof value.displayName === 'string' && value.displayName.trim() !== ''
      && typeof value.reason === 'string' && value.reason.trim() !== ''
    ) {
      return {
        userId: value.userId.trim(),
        displayName: value.displayName.trim(),
        reason: value.reason.trim(),
        sourceRef,
      };
    }
  }
  return null;
}

export async function prepareMaterialGapRequest(
  context: PrepareMaterialGapRequestContext,
  input: PrepareMaterialGapRequestInput,
): Promise<CreateMaterialGapInput> {
  const progress = await context.loadProgress(input.progressId, input.progressVersion);
  if (progress === null) throw new Error('工作进展版本不存在');
  const searches: CreateMaterialGapInput['searches'] = [];
  let suggestedContact: SuggestedMaterialContact | null = null;
  const related = await context.listRelatedSources?.(progress) ?? [];
  const candidates: MaterialSourceCandidate[] = progress.sources.flatMap((target) => {
    const source = searchSource(target);
    return source === null ? [] : [{ source, target }];
  });
  candidates.push(...related);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (searches.length >= MAX_MATERIAL_SEARCHES) break;
    const target = safeVaultRelativePath(candidate.target);
    if (target === null) continue;
    const identity = `${candidate.source}:${target}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    let content: string | null;
    let denied = false;
    try {
      content = await context.readSource(target);
    } catch {
      content = null;
      denied = true;
    }
    const found = content !== null && materialFound(content, input);
    searches.push({
      source: candidate.source,
      target,
      status: denied ? 'permission_denied' : found ? 'found' : 'not_found',
      searchedAt: context.clock().toISOString(),
      sourceRef: found ? target : null,
    });
    if (!found && content !== null && suggestedContact === null) {
      suggestedContact = structuredContact(content, target);
    }
  }
  return { ...input, searches, suggestedContact };
}
