import type { ActionRequestType } from '../domain/action-request.js';
import { multicaEventCommentIdempotencyKey } from '../domain/multica-event.js';
import type { MulticaActionNotificationLedger } from '../storage/file-multica-action-notification-ledger.js';
import type { ServiceContext } from './service-context.js';

const RECEIPT_PATTERN = /^[A-Za-z0-9_:+/=-]{1,256}$/u;

export class MulticaNotificationRecoveryRejectedError extends Error {
  readonly code = 'multica_notification_recovery_rejected';

  constructor(message: string) {
    super(message);
    this.name = 'MulticaNotificationRecoveryRejectedError';
  }
}

export interface RecoverMulticaActionNotificationResult {
  status: 'recovered' | 'already_recovered';
  taskId: string;
  eventId: string;
  state: ActionRequestType;
  notificationId: string;
  taskProjectionUpdated: boolean;
}

export async function recoverMulticaActionNotification(
  ctx: ServiceContext,
  dependencies: { ledger: MulticaActionNotificationLedger },
  input: { taskId: string; eventId: string; receiptId: string },
): Promise<RecoverMulticaActionNotificationResult> {
  const receiptId = input.receiptId.trim();
  if (!RECEIPT_PATTERN.test(receiptId)) {
    throw new MulticaNotificationRecoveryRejectedError('Notification receipt ID is invalid');
  }

  return dependencies.ledger.withLock(async () => ctx.tasks.withTaskLock(
    input.taskId,
    async () => {
      const task = await ctx.tasks.get(input.taskId);
      const request = task.actionRequest ?? null;
      if (request === null || request.eventId !== input.eventId || request.status !== 'pending') {
        throw new MulticaNotificationRecoveryRejectedError(
          'Task does not have the matching pending Multica action request',
        );
      }
      if (request.notificationId !== null && request.notificationId !== receiptId) {
        throw new MulticaNotificationRecoveryRejectedError(
          'Task is already bound to a different notification receipt',
        );
      }

      const idempotencyKey = multicaEventCommentIdempotencyKey({
        taskId: input.taskId,
        eventId: input.eventId,
        state: request.type,
      });
      const record = await dependencies.ledger.get(idempotencyKey);
      if (
        record === null
        || record.taskId !== input.taskId
        || record.eventId !== input.eventId
        || record.state !== request.type
      ) {
        throw new MulticaNotificationRecoveryRejectedError(
          'Matching notification attempt was not found',
        );
      }
      if (record.status === 'sent' && record.messageId !== receiptId) {
        throw new MulticaNotificationRecoveryRejectedError(
          'Notification attempt is already bound to a different receipt',
        );
      }
      if (record.status !== 'unknown' && record.status !== 'sent') {
        throw new MulticaNotificationRecoveryRejectedError(
          `Notification attempt cannot be recovered from status ${record.status}`,
        );
      }

      const alreadyRecovered = record.status === 'sent' && record.messageId === receiptId;
      if (!alreadyRecovered) {
        await dependencies.ledger.save({
          ...record,
          status: 'sent',
          errorCode: null,
          messageId: receiptId,
        });
      }

      const taskProjectionUpdated = request.notificationId !== receiptId;
      if (taskProjectionUpdated) {
        await ctx.tasks.save({
          ...task,
          actionRequest: { ...request, notificationId: receiptId },
          updatedAt: ctx.clock().toISOString(),
        });
      }
      try {
        await ctx.audit.append({
          event: 'multica.notification_receipt_recovered',
          at: ctx.clock().toISOString(),
          taskId: input.taskId,
          details: {
            eventId: input.eventId,
            state: request.type,
            taskProjectionUpdated,
          },
        });
      } catch {
        // The ledger and Task projection are the recovery evidence; audit is supplemental.
      }

      return {
        status: alreadyRecovered && !taskProjectionUpdated ? 'already_recovered' : 'recovered',
        taskId: input.taskId,
        eventId: input.eventId,
        state: request.type,
        notificationId: receiptId,
        taskProjectionUpdated,
      };
    },
  ));
}
