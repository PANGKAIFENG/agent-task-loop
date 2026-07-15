import { z } from 'zod';

import {
  ACCEPTANCE_STATUSES,
  type ArtifactResult,
} from '../domain/artifact.js';

const boundedString = z.string().max(20_000);
const nonBlankString = boundedString.regex(/\S/, 'Expected a non-blank string');
const httpsUrl = z.url().regex(/^https:\/\//);

export const researchResultSchema = z
  .object({
    summary: boundedString,
    findings: z.array(nonBlankString).min(1).max(200),
    evidence: z.array(z.object({
      title: boundedString,
      url: httpsUrl,
      accessedAt: z.iso.datetime({ offset: true }),
    }).strict()).max(200),
    uncertainties: z.array(boundedString).max(200),
    recommendedActions: z.array(boundedString).max(200),
    acceptance: z.array(z.object({
      criterion: nonBlankString,
      status: z.enum(ACCEPTANCE_STATUSES),
      note: boundedString,
    }).strict()).min(1).max(200),
  })
  .strict() satisfies z.ZodType<ArtifactResult>;

export type ResearchResult = z.infer<typeof researchResultSchema>;

export const researchResultJsonSchema = z.toJSONSchema(researchResultSchema);
