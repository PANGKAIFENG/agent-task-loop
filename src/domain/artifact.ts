import { z } from 'zod';

export const ACCEPTANCE_STATUSES = ['met', 'partial', 'not_met'] as const;

export interface ArtifactResult {
  summary: string;
  findings: string[];
  evidence: Array<{
    title: string;
    url: string;
    accessedAt: string;
  }>;
  uncertainties: string[];
  recommendedActions: string[];
  acceptance: Array<{
    criterion: string;
    status: (typeof ACCEPTANCE_STATUSES)[number];
    note: string;
  }>;
}

const boundedString = z.string().max(20_000);

export const artifactResultSchema: z.ZodType<ArtifactResult> = z
  .object({
    summary: boundedString,
    findings: z.array(boundedString).max(200),
    evidence: z.array(z.object({
      title: boundedString,
      url: z.url().refine((value) => new URL(value).protocol === 'https:'),
      accessedAt: z.iso.datetime({ offset: true }),
    }).strict()).max(200),
    uncertainties: z.array(boundedString).max(200),
    recommendedActions: z.array(boundedString).max(200),
    acceptance: z.array(z.object({
      criterion: boundedString,
      status: z.enum(ACCEPTANCE_STATUSES),
      note: boundedString,
    }).strict()).max(200),
  })
  .strict();
