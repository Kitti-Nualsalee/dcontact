/**
 * Owner: Platform control plane — เขียน Action history แบบ append-only (A1.1 #406, #393 §5)
 *
 * ทางเดียวที่ repository/saga/recovery เพิ่มเหตุการณ์ลง `pf_action_history` — ไม่มี raw email,
 * payload หรือ secret; external reference เก็บเป็น hash เท่านั้น
 */
import type { Prisma, PrismaClient } from '@d-contact/db';
import type { PlatformActionKind, ProvisioningStepKey } from '@d-contact/shared';
import type { PlatformActor } from './provisioning-repository.js';

export type PlatformActionEntry = {
  tenantId: string;
  requestId: string;
  action: PlatformActionKind;
  actor: PlatformActor;
  correlationId: string;
  outcome: 'SUCCEEDED' | 'REJECTED' | 'REPLAYED';
  at: Date;
  idempotencyKeyHash?: string;
  beforeState?: string;
  afterState?: string;
  reasonCode?: string;
  comment?: string;
  errorCode?: string;
  stepKey?: ProvisioningStepKey;
  attempt?: number;
  inputDigest?: string;
  outputDigest?: string;
  externalRefHash?: string;
};

export function appendPlatformAction(
  client: Prisma.TransactionClient | PrismaClient,
  id: string,
  entry: PlatformActionEntry,
) {
  return client.pfActionHistory.create({
    data: {
      id,
      tenantId: entry.tenantId,
      requestId: entry.requestId,
      action: entry.action,
      actorKind: entry.actor.kind,
      actorSubject: entry.actor.subject,
      ...(entry.actor.role ? { actorRole: entry.actor.role } : {}),
      ...(entry.actor.sessionRef ? { sessionRef: entry.actor.sessionRef } : {}),
      correlationId: entry.correlationId,
      ...(entry.idempotencyKeyHash ? { idempotencyKeyHash: entry.idempotencyKeyHash } : {}),
      ...(entry.beforeState ? { beforeState: entry.beforeState } : {}),
      ...(entry.afterState ? { afterState: entry.afterState } : {}),
      ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
      ...(entry.comment ? { comment: entry.comment } : {}),
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      ...(entry.stepKey ? { stepKey: entry.stepKey } : {}),
      ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
      ...(entry.inputDigest ? { inputDigest: entry.inputDigest } : {}),
      ...(entry.outputDigest ? { outputDigest: entry.outputDigest } : {}),
      ...(entry.externalRefHash ? { externalRefHash: entry.externalRefHash } : {}),
      outcome: entry.outcome,
      occurredAt: entry.at,
    },
  });
}
