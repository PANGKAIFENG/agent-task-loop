import { z } from 'zod';

export interface WeeklyReviewDecision {
  schemaVersion: 1;
  eventId: string;
  weeklyId: string;
  version: number;
  action: 'accepted' | 'rejected' | 'later';
  feedback: string | null;
  publicationState: 'not_published';
  decidedAt: string;
}

const nonEmptyString = z.string().trim().min(1).max(20_000);

export const weeklyReviewDecisionSchema: z.ZodType<WeeklyReviewDecision> = z.object({
  schemaVersion: z.literal(1),
  eventId: nonEmptyString,
  weeklyId: nonEmptyString,
  version: z.number().int().positive(),
  action: z.enum(['accepted', 'rejected', 'later']),
  feedback: nonEmptyString.nullable(),
  publicationState: z.literal('not_published'),
  decidedAt: z.iso.datetime({ offset: true }),
}).strict();
