/**
 * Owner: Delivery/Channels — append-only receipt of a LINE provider attempt (S2.1 #365, #357 §4)
 *
 * Recorded only after the HTTP attempt ends: keeps digest/status/request IDs/outcome code, with no body,
 * token or recipient. The outcome class is not accepted from the caller — it is computed from the code per #357 §5 and the DB
 * re-checks it with the same CHECK. Replaying the same attempt with the same values returns the original row; different values are a conflict
 */
import {
  type DlProviderSubmissionAttempt,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  assertLineOutcomeScope,
  type LineProviderOutcomeCode,
  type LineRejectionScope,
} from '@d-contact/cxa-contracts';
import {
  LineIdempotencyConflictError,
  isUniqueViolation,
  rejectingForeignBinding,
} from './line-repository-support.js';

export interface RecordLineProviderAttemptInput {
  id: string;
  tenantId: string;
  deliveryId: string;
  providerRequestKey: string;
  attemptNo: number;
  providerPayloadDigest: string;
  startedAt: Date;
  finishedAt: Date;
  httpStatus?: number;
  outcomeCode: LineProviderOutcomeCode;
  rejectionScope?: LineRejectionScope;
  lineRequestId?: string;
  lineAcceptedRequestId?: string;
  sentMessageIds?: string[];
}

function sameReceipt(row: DlProviderSubmissionAttempt, input: RecordLineProviderAttemptInput) {
  return (
    row.providerRequestKey === input.providerRequestKey &&
    row.providerPayloadDigest === input.providerPayloadDigest &&
    row.startedAt.getTime() === input.startedAt.getTime() &&
    row.finishedAt.getTime() === input.finishedAt.getTime() &&
    row.httpStatus === (input.httpStatus ?? null) &&
    row.outcomeCode === input.outcomeCode &&
    row.rejectionScope === (input.rejectionScope ?? null) &&
    row.lineRequestId === (input.lineRequestId ?? null) &&
    row.lineAcceptedRequestId === (input.lineAcceptedRequestId ?? null) &&
    row.sentMessageIds.join('\n') === (input.sentMessageIds ?? []).join('\n')
  );
}

export class LineProviderAttemptRepository {
  constructor(private readonly database: PrismaClient) {}

  async record(input: RecordLineProviderAttemptInput): Promise<DlProviderSubmissionAttempt> {
    const outcomeClass = assertLineOutcomeScope(input.outcomeCode, input.rejectionScope);
    try {
      return await rejectingForeignBinding(() =>
        withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
          transaction.dlProviderSubmissionAttempt.create({
            data: {
              id: input.id,
              tenantId: input.tenantId,
              deliveryId: input.deliveryId,
              providerRequestKey: input.providerRequestKey,
              attemptNo: input.attemptNo,
              providerPayloadDigest: input.providerPayloadDigest,
              startedAt: input.startedAt,
              finishedAt: input.finishedAt,
              httpStatus: input.httpStatus ?? null,
              outcomeCode: input.outcomeCode,
              outcomeClass,
              rejectionScope: input.rejectionScope ?? null,
              lineRequestId: input.lineRequestId ?? null,
              lineAcceptedRequestId: input.lineAcceptedRequestId ?? null,
              sentMessageIds: input.sentMessageIds ?? [],
            },
          }),
        ),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.find(input.tenantId, input.deliveryId, input.attemptNo);
      if (existing && sameReceipt(existing, input)) return existing;
      throw new LineIdempotencyConflictError('dl_provider_submission_attempts');
    }
  }

  find(
    tenantId: string,
    deliveryId: string,
    attemptNo: number,
  ): Promise<DlProviderSubmissionAttempt | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlProviderSubmissionAttempt.findFirst({
        where: { tenantId, deliveryId, attemptNo },
      }),
    );
  }

  listForDelivery(tenantId: string, deliveryId: string): Promise<DlProviderSubmissionAttempt[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlProviderSubmissionAttempt.findMany({
        where: { tenantId, deliveryId },
        orderBy: { attemptNo: 'asc' },
      }),
    );
  }
}
