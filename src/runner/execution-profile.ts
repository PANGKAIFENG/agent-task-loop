import { z } from 'zod';

import type { Task } from '../domain/task.js';
import type { ContextBundle } from './context-bundle.js';

const skillInstructionSchema = z.object({
  id: z.enum(['decision-research', 'evidence-collection']),
  version: z.literal(1),
  instructions: z.string().min(1),
}).strict();

export const executionProfileSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.literal('research_v1'),
  profileVersion: z.literal(1),
  selectionStrategy: z.literal('deterministic_v1'),
  role: z.object({
    id: z.literal('bounded_public_researcher'),
    selectionReason: z.string().min(1),
  }).strict(),
  skills: z.tuple([
    skillInstructionSchema.extend({ id: z.literal('decision-research') }),
    skillInstructionSchema.extend({ id: z.literal('evidence-collection') }),
  ]),
  allowedTools: z.tuple([
    z.literal('WebSearch'),
    z.literal('WebFetch'),
    z.literal('Read'),
  ]),
  requiredContextKinds: z.tuple([
    z.literal('task'),
    z.literal('project'),
  ]),
  permissionProfile: z.literal('read_only_research'),
  outputContract: z.literal('research_result_v1'),
  acceptancePolicy: z.object({
    taskCriteriaRequired: z.literal(true),
    httpsEvidenceRequired: z.literal(true),
    humanReviewRequired: z.literal(true),
  }).strict(),
}).strict();

export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

const RESEARCH_V1: ExecutionProfile = {
  schemaVersion: 1,
  profileId: 'research_v1',
  profileVersion: 1,
  selectionStrategy: 'deterministic_v1',
  role: {
    id: 'bounded_public_researcher',
    selectionReason:
      'The task is a confirmed research task authorized only for read_only_research.',
  },
  skills: [
    {
      id: 'decision-research',
      version: 1,
      instructions:
        'Produce decision-ready research. Separate sourced evidence, inference, uncertainty, and recommended actions.',
    },
    {
      id: 'evidence-collection',
      version: 1,
      instructions:
        'Prefer primary public sources. Preserve HTTPS URLs and access times, and never use authenticated content.',
    },
  ],
  allowedTools: ['WebSearch', 'WebFetch', 'Read'],
  requiredContextKinds: ['task', 'project'],
  permissionProfile: 'read_only_research',
  outputContract: 'research_result_v1',
  acceptancePolicy: {
    taskCriteriaRequired: true,
    httpsEvidenceRequired: true,
    humanReviewRequired: true,
  },
};

export class ExecutionProfileNotSupportedError extends Error {
  readonly code = 'execution_profile_not_supported';

  constructor() {
    super('No supported Execution Profile matches this task');
    this.name = 'ExecutionProfileNotSupportedError';
  }
}

export class ExecutionProfileContextMissingError extends Error {
  readonly code = 'execution_profile_context_missing';

  constructor() {
    super('Execution Profile required context is missing');
    this.name = 'ExecutionProfileContextMissingError';
  }
}

export function parseSupportedExecutionProfile(value: unknown): ExecutionProfile {
  const parsed = executionProfileSchema.safeParse(value);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(RESEARCH_V1)) {
    throw new ExecutionProfileNotSupportedError();
  }
  return parsed.data;
}

export function resolveExecutionProfile(task: Task): ExecutionProfile {
  if (
    task.status !== 'in_progress'
    || task.reviewState !== 'confirmed'
    || task.taskType !== 'research'
    || task.permissionProfile !== 'read_only_research'
    || !task.autoExecutable
    || task.claim === null
    || task.claim.runId.trim() === ''
    || task.objective === null
    || task.objective.trim() === ''
    || !task.acceptanceCriteria.some((criterion) => criterion.trim() !== '')
  ) {
    throw new ExecutionProfileNotSupportedError();
  }
  return parseSupportedExecutionProfile(RESEARCH_V1);
}

export function validateExecutionProfileContext(
  profile: ExecutionProfile,
  context: ContextBundle,
): void {
  const supported = parseSupportedExecutionProfile(profile);
  const available = new Set(context.blocks.map(({ kind }) => kind));
  if (supported.requiredContextKinds.some((kind) => !available.has(kind))) {
    throw new ExecutionProfileContextMissingError();
  }
}
