import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  CG4_EVALUATOR_VERSION,
  CG4_EVENT_TYPES,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
} from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import { nextContactStreamVersion } from './cg4-contact-stream.js';
import type { Cg4PolicyLifecycleRepository } from './cg4-policy-lifecycle.js';

/**
 * CG4.6 (#189): the two durable workers.
 *
 * Neither is a safety authority (#176 §4). A scheduled activation that has not run leaves
 * the scope failing closed through `resolveCg4ActivePolicy`, and an exception's expiry is
 * derived from database time at evaluation whether or not the sweeper ever runs. What
 * these workers buy is availability and propagation — the head moving on time, and
 * consumers/caches learning that it did.
 */

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ── Scheduled activation ─────────────────────────────────────────────────────

export interface Cg4ActivationWorkerOptions {
  now?: () => Date;
  leaseOwner?: string;
  leaseSeconds?: number;
  /** Attempts before a job is parked as FAILED for an operator; default 5. */
  maxAttempts?: number;
  backoffMs?: (attempts: number) => number;
  id?: () => string;
}

export type Cg4ActivationOutcome =
  | { outcome: 'ACTIVATED'; policyId: string; version: number; headVersion: number }
  | { outcome: 'RETRY'; policyId: string; version: number; attempts: number; error: string }
  | { outcome: 'FAILED'; policyId: string; version: number; attempts: number; error: string };

export class Cg4ActivationWorker {
  private readonly now: () => Date;
  private readonly leaseOwner: string;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempts: number) => number;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly lifecycle: Cg4PolicyLifecycleRepository,
    options: Cg4ActivationWorkerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseOwner = options.leaseOwner ?? `activation-${process.pid}`;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? ((attempts) => Math.min(2 ** attempts * 1_000, 300_000));
    this.id = options.id ?? randomUUID;
  }

  /**
   * Claims one due job and activates it. Claim and activation are separate transactions
   * on purpose: the activation must run the same publish transaction an immediate publish
   * uses, and holding a claim across it would nest a lock the publish path takes itself.
   */
  async runNext(tenantId: string): Promise<Cg4ActivationOutcome | undefined> {
    const now = this.now();
    const claimed = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id
          FROM cg_policy_activation_job
          WHERE tenant_id = ${tenantId}::uuid
            AND state IN ('PENDING', 'CLAIMED')
            AND scheduled_for <= ${now}
            AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
          ORDER BY scheduled_for, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `);
        const candidate = rows[0];
        if (!candidate) return undefined;
        const job = await transaction.cg4PolicyActivationJob.findFirstOrThrow({
          where: { id: candidate.id, tenantId },
        });
        await transaction.cg4PolicyActivationJob.update({
          where: { id: job.id },
          data: {
            state: 'CLAIMED',
            leaseOwner: this.leaseOwner,
            leaseExpiresAt: new Date(now.getTime() + this.leaseSeconds * 1_000),
          },
        });
        return job;
      },
    );
    if (!claimed) return undefined;

    try {
      const result = await this.lifecycle.activateDue({
        tenantId,
        policyId: claimed.policyId,
        version: claimed.policyVersion,
        leaseOwner: this.leaseOwner,
        occurredAt: now.toISOString(),
        // Deterministic per job attempt, so a retry after a crashed activation replays the
        // receipt instead of activating twice.
        idempotencyKey: `cg4-activation:${claimed.id}`,
      });
      return {
        outcome: 'ACTIVATED',
        policyId: claimed.policyId,
        version: claimed.policyVersion,
        headVersion: result.headVersion,
      };
    } catch (error) {
      const attempts = claimed.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = attempts >= this.maxAttempts;
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.cg4PolicyActivationJob.updateMany({
          where: { tenantId, id: claimed.id, state: 'CLAIMED' },
          data: {
            // A parked job leaves the scope failing closed rather than serving the old
            // version — that is the intended outcome, not a silent skip.
            state: exhausted ? 'FAILED' : 'PENDING',
            attempts,
            lastError: message.slice(0, 500),
            leaseOwner: null,
            leaseExpiresAt: null,
            ...(exhausted
              ? {}
              : { scheduledFor: new Date(now.getTime() + this.backoffMs(attempts)) }),
          },
        }),
      );
      return {
        outcome: exhausted ? 'FAILED' : 'RETRY',
        policyId: claimed.policyId,
        version: claimed.policyVersion,
        attempts,
        error: message,
      };
    }
  }

  /** Due jobs that never completed — the signal an operator alerts on (#179 §7). */
  async dueBacklog(tenantId: string): Promise<number> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.cg4PolicyActivationJob.count({
        where: { tenantId, state: { in: ['PENDING', 'CLAIMED'] }, scheduledFor: { lte: now } },
      }),
    );
  }
}

// ── Exception expiry propagation ─────────────────────────────────────────────

export interface Cg4ExpirySweeperOptions {
  now?: () => Date;
  id?: () => string;
  batchSize?: number;
}

export interface Cg4ExpiryEmission {
  exceptionId: string;
  revision: number;
  contactId: string;
  eventId: string;
  aggregateVersion: number;
}

export class Cg4ExpirySweeper {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly batchSize: number;

  constructor(
    private readonly database: PrismaClient,
    options: Cg4ExpirySweeperOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Emits one `exception.changed`/EXCEPTION_EXPIRED event per series whose window has
   * closed. The head stays APPROVED — EXPIRED is never persisted (#177 §2), so this only
   * tells consumers and caches what the evaluator already computes. A command receipt
   * keyed by series+revision makes the sweep idempotent across restarts.
   */
  async sweep(tenantId: string): Promise<Cg4ExpiryEmission[]> {
    const now = this.now();
    const heads = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.cg4ExceptionHead.findMany({
        where: { tenantId, status: 'APPROVED' },
        take: this.batchSize,
      }),
    );
    const emitted: Cg4ExpiryEmission[] = [];
    for (const head of heads) {
      const emission = await this.emitExpiry(
        tenantId,
        head.exceptionId,
        head.currentRevisionId,
        now,
      );
      if (emission) emitted.push(emission);
    }
    return emitted;
  }

  private async emitExpiry(
    tenantId: string,
    exceptionId: string,
    revisionId: string,
    now: Date,
  ): Promise<Cg4ExpiryEmission | undefined> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const revision = await transaction.cg4Exception.findFirst({
        where: { tenantId, id: revisionId },
      });
      if (!revision) return undefined;
      if (revision.expiresAt.getTime() > now.getTime()) return undefined;

      const idempotencyKey = `${exceptionId}:${revision.revision}`;
      const requestHash = stableDigest({ exceptionId, revision: revision.revision });
      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId,
            operation: 'CG4_EXCEPTION_EXPIRY',
            idempotencyKey,
          },
        },
      });
      if (receipt) return undefined;

      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg4-contact:${tenantId}:${revision.contactId}`}))`,
      );

      const contactHead = await transaction.cg4ContactExceptionHead.findUnique({
        where: { tenantId_contactId: { tenantId, contactId: revision.contactId } },
      });
      const aggregateVersion = (contactHead?.aggregateVersion ?? 0) + 1;
      const mutationId = this.id();
      const eventId = this.id();
      const afterDigest = stableDigest({
        previous: contactHead?.currentDigest ?? null,
        exceptionId,
        revision: revision.revision,
        effectiveState: 'EXPIRED',
      });

      if (contactHead) {
        const updated = await transaction.cg4ContactExceptionHead.updateMany({
          where: {
            tenantId,
            contactId: revision.contactId,
            aggregateVersion: contactHead.aggregateVersion,
          },
          data: { aggregateVersion, currentDigest: afterDigest, latestMutationId: mutationId },
        });
        // Another writer moved the contact aggregate first; its event already carries the
        // newer state, so this sweep leaves the series for the next pass.
        if (updated.count !== 1) return undefined;
      } else {
        await transaction.cg4ContactExceptionHead.create({
          data: {
            tenantId,
            contactId: revision.contactId,
            aggregateVersion,
            currentDigest: afterDigest,
            latestMutationId: mutationId,
          },
        });
      }

      const payload = {
        contractVersion: 1,
        mutationId,
        transitionKind: 'EXCEPTION_EXPIRED',
        subjectId: exceptionId,
        subjectVersion: revision.revision,
        state: 'EXPIRED',
        effectiveAt: revision.expiresAt.toISOString(),
        affectedScope: {
          scopeKey: `contact:${revision.contactId}`,
          channel: revision.channel,
          purpose: revision.purpose,
          sourceType: revision.sourceType,
        },
        scopeDigest: stableDigest({
          contactId: revision.contactId,
          identityId: revision.identityId,
          channel: revision.channel,
          purpose: revision.purpose,
          sourceType: revision.sourceType,
          sourceId: revision.sourceId,
        }),
        policyVersion: revision.policyVersion,
        policyContentDigest: revision.policyContentDigest,
        exceptionVersion: revision.revision,
        ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
        policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
        evaluatorVersion: CG4_EVALUATOR_VERSION,
        stateDigest: afterDigest,
        // Expiry removes an override, so downstream must re-authorize queued work.
        restrictiveness: 'TIGHTENING',
      };
      // CG4.8 (#191): event ใช้ version ของ contact stream ร่วมกับ CG3 (#179 §4)
      const streamVersion = await nextContactStreamVersion(transaction, {
        tenantId,
        contactId: revision.contactId,
        mutationId,
      });
      await transaction.cgEventOutbox.create({
        data: {
          id: eventId,
          mutationId,
          tenantId,
          aggregateType: 'CONTACT',
          aggregateId: revision.contactId,
          aggregateVersion: streamVersion,
          eventType: CG4_EVENT_TYPES.EXCEPTION_CHANGED,
          orderingKey: `${tenantId}:${revision.contactId}`,
          payload: json(payload),
          payloadHash: stableDigest(payload),
        },
      });
      await transaction.cgAuditLog.create({
        data: {
          id: this.id(),
          tenantId,
          mutationId,
          aggregateType: 'CONTACT',
          aggregateId: revision.contactId,
          aggregateVersion: streamVersion,
          action: 'CG4_EXCEPTION_EXPIRY',
          actorClass: 'SYSTEM',
          actorRef: 'cg4-expiry-sweeper',
          sourceKind: 'SYSTEM',
          evidenceRef: `expiry:${exceptionId}:${revision.revision}`,
          ...(contactHead ? { beforeDigest: contactHead.currentDigest } : {}),
          afterDigest,
          occurredAt: now,
        },
      });
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId,
          operation: 'CG4_EXCEPTION_EXPIRY',
          idempotencyKey,
          requestHash,
          expectedVersion: revision.revision,
          aggregateVersion,
          responseStatus: 200,
          responseBody: json({ eventId, mutationId, aggregateVersion }),
        },
      });

      return {
        exceptionId,
        revision: revision.revision,
        contactId: revision.contactId,
        eventId,
        aggregateVersion,
      };
    });
  }
}
