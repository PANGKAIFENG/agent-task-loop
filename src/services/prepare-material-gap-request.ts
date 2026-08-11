import type {
  MaterialSearchSource,
  SuggestedMaterialContact,
} from '../domain/material-gap.js';
import type { ProgressVersion } from '../domain/progress.js';
import type { CreateMaterialGapInput } from './create-material-gap.js';
import { parseTaskDocument } from '../storage/frontmatter.js';

export type PrepareMaterialGapRequestInput = Omit<
  CreateMaterialGapInput,
  'searches' | 'suggestedContact'
>;

export interface PrepareMaterialGapRequestContext {
  loadProgress(progressId: string, version: number): Promise<ProgressVersion | null>;
  readSource(path: string): Promise<string | null>;
  clock(): Date;
}

function searchSource(path: string): MaterialSearchSource | null {
  if (path.startsWith('08_Meetings/')) return 'meeting_link';
  if (path.startsWith('TaskNotes/DingTalk/')) return 'calendar_attachment';
  if (path.startsWith('10_Tasks/Artifacts/')) return 'code_artifact';
  if (
    path.startsWith('01_Areas/')
    || path.startsWith('02_Projects/')
    || path.startsWith('03_Resources/')
    || path.startsWith('09_Progress/')
  ) return 'project_context';
  return null;
}

function materialFound(content: string, input: PrepareMaterialGapRequestInput): boolean {
  if (!content.includes(input.missing.description)) return false;
  if (input.missing.kind === 'numeric') return /\d/u.test(content);
  return true;
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
  for (const sourceRef of progress.sources) {
    const source = searchSource(sourceRef);
    if (source === null) continue;
    let content: string | null;
    let denied = false;
    try {
      content = await context.readSource(sourceRef);
    } catch {
      content = null;
      denied = true;
    }
    const found = content !== null && materialFound(content, input);
    searches.push({
      source,
      target: sourceRef,
      status: denied ? 'permission_denied' : found ? 'found' : 'not_found',
      searchedAt: context.clock().toISOString(),
      sourceRef: found ? sourceRef : null,
    });
    if (!found && content !== null && suggestedContact === null) {
      suggestedContact = structuredContact(content, sourceRef);
    }
  }
  return { ...input, searches, suggestedContact };
}
