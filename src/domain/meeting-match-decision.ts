import { z } from 'zod';

export const meetingMatchDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  decisionId: z.string().trim().min(1).max(200),
  action: z.enum(['confirmed', 'no_calendar', 'revoked']),
  recordingId: z.string().trim().min(1).max(500),
  eventKeyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
  supersedesDecisionId: z.string().trim().min(1).max(200).nullable(),
  decidedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.action === 'confirmed' && value.eventKeyHash === null) {
    context.addIssue({ code: 'custom', message: 'confirmed decision requires a calendar event' });
  }
  if (value.action === 'no_calendar' && value.eventKeyHash !== null) {
    context.addIssue({ code: 'custom', message: 'no-calendar decision cannot contain an event' });
  }
  if (value.action === 'revoked' && value.supersedesDecisionId === null) {
    context.addIssue({ code: 'custom', message: 'revocation requires a prior decision' });
  }
  if (value.action !== 'revoked' && value.supersedesDecisionId !== null) {
    context.addIssue({ code: 'custom', message: 'only revocation can supersede a decision' });
  }
});

export type MeetingMatchDecision = z.infer<typeof meetingMatchDecisionSchema>;

