import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type C360FactSnapshot as StoredFactSnapshot,
  type C360SegmentDefinition as StoredSegmentDefinition,
  type C360SegmentEvaluation as StoredSegmentEvaluation,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  C360_SEGMENT_EVALUATOR_VERSION,
  normalizeFactSnapshot,
  segmentDefinitionContentDigest,
  stableDigest,
  validateSegmentDefinitionContent,
  type C360FactSnapshotInput,
  type C360NormalizedFactSnapshot,
  type C360SegmentDefinitionContentV1,
} from './segment-definition.js';
import { C360SegmentEvaluator, type C360SegmentEvaluationOutcome } from './segment-evaluator.js';

type Transaction = Prisma.TransactionClient;

export class C360SegmentRepositoryError extends Error {
  constructor(
    readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      | 'NON_SEQUENTIAL_VERSION'
      | 'VERSION_CONFLICT'
      | 'RESOURCE_NOT_FOUND'
      | 'INVALID_LIFECYCLE_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'C360SegmentRepositoryError';
  }
}

export interface CreateC360SegmentVersionInput {
  tenantId: string;
  segmentId: string;
  version: number;
  definition: C360SegmentDefinitionContentV1;
  correlationId: string;
}

export interface PublishC360SegmentVersionInput {
  tenantId: string;
  segmentId: string;
  version: number;
  expectedContentDigest: string;
  expectedHeadVersion: number;
}

export interface RecordC360FactSnapshotInput extends C360FactSnapshotInput {
  tenantId: string;
  contactId: string;
  snapshotVersion: number;
  correlationId: string;
}

export interface EvaluateStoredC360SegmentInput {
  tenantId: string;
  contactId: string;
  segmentId: string;
  segmentDefinitionVersion: number;
  snapshotVersion: number;
}

export interface C360SegmentDefinitionSnapshot {
  id: string;
  tenantId: string;
  segmentId: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  definition: C360SegmentDefinitionContentV1;
  contentDigest: string;
  evaluatorVersion: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  publishedAt?: string;
  createdAt: string;
}

export interface C360PublishedSegmentDefinition {
  definition: C360SegmentDefinitionSnapshot;
  headVersion: number;
}

export interface C360FactSnapshot {
  id: string;
  tenantId: string;
  contactId: string;
  snapshotVersion: number;
  contentDigest: string;
  sourceCutoffAt: string;
  capturedAt: string;
}

export interface C360StoredSegmentEvaluation {
  id: string;
  tenantId: string;
  contactId: string;
  segmentId: string;
  segmentDefinitionVersion: number;
  snapshotVersion: number;
  outcome: C360SegmentEvaluationOutcome;
  matched: boolean;
  errorCode?: string;
  inputDigest: string;
  evaluationDigest: string;
  evaluatorVersion: string;
  evaluatedAt: string;
}

export interface C360SegmentRepositoryOptions {
  id?: () => string;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} ต้องเป็นจำนวนเต็มตั้งแต่ 1`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} ต้องเป็นจำนวนเต็มไม่ติดลบ`);
  }
  return value;
}

function digest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} ต้องเป็น lowercase SHA-256`);
  return value;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toDefinition(row: StoredSegmentDefinition): C360SegmentDefinitionSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    segmentId: row.segmentId,
    version: row.version,
    status: row.status,
    definition: validateSegmentDefinitionContent(row.definition),
    contentDigest: row.contentDigest,
    evaluatorVersion: row.evaluatorVersion,
    ...(row.effectiveFrom ? { effectiveFrom: row.effectiveFrom.toISOString() } : {}),
    ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString() } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

function toFactSnapshot(row: StoredFactSnapshot): C360FactSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    contactId: row.contactId,
    snapshotVersion: row.snapshotVersion,
    contentDigest: row.contentDigest,
    sourceCutoffAt: row.sourceCutoffAt.toISOString(),
    capturedAt: row.capturedAt.toISOString(),
  };
}

function toEvaluation(row: StoredSegmentEvaluation): C360StoredSegmentEvaluation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    contactId: row.contactId,
    segmentId: row.segmentId,
    segmentDefinitionVersion: row.segmentDefinitionVersion,
    snapshotVersion: row.snapshotVersion,
    outcome: row.outcome,
    matched: row.matched ?? false,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    inputDigest: row.inputDigest,
    evaluationDigest: row.evaluationDigest,
    evaluatorVersion: row.evaluatorVersion,
    evaluatedAt: row.evaluatedAt.toISOString(),
  };
}

/**
 * Durable owner repository ของ Customer 360. ทุก operation ใช้ tenant-scoped transaction,
 * advisory lock/CAS และอ่าน fact จาก owner-local tables เท่านั้น
 */
export class C360SegmentRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly evaluator: C360SegmentEvaluator,
    options: C360SegmentRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  private async lock(transaction: Transaction, tenantId: string, scope: string): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`c360-segment:${tenantId}:${scope}`}))`,
    );
  }

  async createVersion(
    input: CreateC360SegmentVersionInput,
  ): Promise<C360SegmentDefinitionSnapshot> {
    const tenantId = nonEmpty(input.tenantId, 'tenantId');
    const segmentId = nonEmpty(input.segmentId, 'segmentId');
    const version = positiveInteger(input.version, 'version');
    const correlationId = nonEmpty(input.correlationId, 'correlationId');
    const definition = validateSegmentDefinitionContent(input.definition);
    const contentDigest = segmentDefinitionContentDigest(definition);

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(transaction, tenantId, `definition:${segmentId}`);
      const existing = await transaction.c360SegmentDefinition.findUnique({
        where: { tenantId_segmentId_version: { tenantId, segmentId, version } },
      });
      if (existing) {
        if (existing.contentDigest !== contentDigest) {
          throw new C360SegmentRepositoryError(
            'IDEMPOTENCY_CONFLICT',
            'segment version เดิมมี content digest ต่างกัน',
          );
        }
        return toDefinition(existing);
      }

      const latest = await transaction.c360SegmentDefinition.findFirst({
        where: { tenantId, segmentId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const expected = (latest?.version ?? 0) + 1;
      if (version !== expected) {
        throw new C360SegmentRepositoryError(
          'NON_SEQUENTIAL_VERSION',
          `segment version ต้องเป็น ${expected}`,
        );
      }

      return toDefinition(
        await transaction.c360SegmentDefinition.create({
          data: {
            id: this.id(),
            tenantId,
            segmentId,
            version,
            definition: json(definition),
            contentDigest,
            evaluatorVersion: C360_SEGMENT_EVALUATOR_VERSION,
            correlationId,
          },
        }),
      );
    });
  }

  async getVersion(
    tenantIdValue: string,
    segmentIdValue: string,
    versionValue: number,
  ): Promise<C360SegmentDefinitionSnapshot | undefined> {
    const tenantId = nonEmpty(tenantIdValue, 'tenantId');
    const segmentId = nonEmpty(segmentIdValue, 'segmentId');
    const version = positiveInteger(versionValue, 'version');
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const row = await transaction.c360SegmentDefinition.findUnique({
        where: { tenantId_segmentId_version: { tenantId, segmentId, version } },
      });
      return row ? toDefinition(row) : undefined;
    });
  }

  async resolvePublished(
    tenantIdValue: string,
    segmentIdValue: string,
  ): Promise<C360PublishedSegmentDefinition | undefined> {
    const tenantId = nonEmpty(tenantIdValue, 'tenantId');
    const segmentId = nonEmpty(segmentIdValue, 'segmentId');
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const head = await transaction.c360SegmentDefinitionHead.findUnique({
        where: { tenantId_segmentId: { tenantId, segmentId } },
      });
      if (!head?.currentVersion) return undefined;
      const definition = await transaction.c360SegmentDefinition.findUnique({
        where: {
          tenantId_segmentId_version: {
            tenantId,
            segmentId,
            version: head.currentVersion,
          },
        },
      });
      if (!definition || definition.status !== 'PUBLISHED') return undefined;
      return { definition: toDefinition(definition), headVersion: head.headVersion };
    });
  }

  async publishVersion(
    input: PublishC360SegmentVersionInput,
  ): Promise<C360PublishedSegmentDefinition> {
    const tenantId = nonEmpty(input.tenantId, 'tenantId');
    const segmentId = nonEmpty(input.segmentId, 'segmentId');
    const version = positiveInteger(input.version, 'version');
    const expectedContentDigest = digest(input.expectedContentDigest, 'expectedContentDigest');
    const expectedHeadVersion = nonNegativeInteger(
      input.expectedHeadVersion,
      'expectedHeadVersion',
    );

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(transaction, tenantId, `definition:${segmentId}`);
      const candidate = await transaction.c360SegmentDefinition.findUnique({
        where: { tenantId_segmentId_version: { tenantId, segmentId, version } },
      });
      if (!candidate) {
        throw new C360SegmentRepositoryError('RESOURCE_NOT_FOUND', 'ไม่พบ segment version');
      }
      if (candidate.contentDigest !== expectedContentDigest) {
        throw new C360SegmentRepositoryError(
          'IDEMPOTENCY_CONFLICT',
          'expected content digest ไม่ตรงกับ immutable definition',
        );
      }
      const head = await transaction.c360SegmentDefinitionHead.findUnique({
        where: { tenantId_segmentId: { tenantId, segmentId } },
      });
      if (
        candidate.status === 'PUBLISHED' &&
        head?.currentVersion === version &&
        head.currentDigest === candidate.contentDigest
      ) {
        return { definition: toDefinition(candidate), headVersion: head.headVersion };
      }
      if (candidate.status !== 'DRAFT') {
        throw new C360SegmentRepositoryError(
          'INVALID_LIFECYCLE_TRANSITION',
          'publish ได้เฉพาะ DRAFT หรือ retry ของ PUBLISHED head เดิม',
        );
      }
      const currentHeadVersion = head?.headVersion ?? 0;
      if (currentHeadVersion !== expectedHeadVersion) {
        throw new C360SegmentRepositoryError(
          'VERSION_CONFLICT',
          `expected head ${expectedHeadVersion} แต่ current head เป็น ${currentHeadVersion}`,
        );
      }

      const [{ at }] = await transaction.$queryRaw<Array<{ at: Date }>>(
        Prisma.sql`SELECT transaction_timestamp() AS at`,
      );
      if (!at) throw new Error('database transaction timestamp is unavailable');

      if (head?.currentVersion) {
        await transaction.c360SegmentDefinition.update({
          where: {
            tenantId_segmentId_version: {
              tenantId,
              segmentId,
              version: head.currentVersion,
            },
          },
          data: { status: 'SUPERSEDED', effectiveTo: at },
        });
      }
      const published = await transaction.c360SegmentDefinition.update({
        where: { tenantId_segmentId_version: { tenantId, segmentId, version } },
        data: { status: 'PUBLISHED', effectiveFrom: at, publishedAt: at },
      });
      const nextHeadVersion = currentHeadVersion + 1;
      if (head) {
        const updated = await transaction.c360SegmentDefinitionHead.updateMany({
          where: { tenantId, segmentId, headVersion: expectedHeadVersion },
          data: {
            headVersion: nextHeadVersion,
            currentVersion: version,
            currentDigest: published.contentDigest,
          },
        });
        if (updated.count !== 1) {
          throw new C360SegmentRepositoryError('VERSION_CONFLICT', 'segment head CAS ไม่สำเร็จ');
        }
      } else {
        await transaction.c360SegmentDefinitionHead.create({
          data: {
            tenantId,
            segmentId,
            headVersion: nextHeadVersion,
            currentVersion: version,
            currentDigest: published.contentDigest,
          },
        });
      }
      return { definition: toDefinition(published), headVersion: nextHeadVersion };
    });
  }

  async recordFactSnapshot(input: RecordC360FactSnapshotInput): Promise<C360FactSnapshot> {
    const tenantId = nonEmpty(input.tenantId, 'tenantId');
    const contactId = nonEmpty(input.contactId, 'contactId');
    const snapshotVersion = positiveInteger(input.snapshotVersion, 'snapshotVersion');
    const correlationId = nonEmpty(input.correlationId, 'correlationId');
    const snapshot = normalizeFactSnapshot({
      attributes: input.attributes,
      computed: input.computed,
      sourceCutoffAt: input.sourceCutoffAt,
    });
    const contentDigest = stableDigest({ tenantId, contactId, snapshotVersion, snapshot });

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(transaction, tenantId, `snapshot:${contactId}`);
      const existing = await transaction.c360FactSnapshot.findUnique({
        where: { tenantId_contactId_snapshotVersion: { tenantId, contactId, snapshotVersion } },
      });
      if (existing) {
        if (existing.contentDigest !== contentDigest) {
          throw new C360SegmentRepositoryError(
            'IDEMPOTENCY_CONFLICT',
            'snapshot version เดิมมี content digest ต่างกัน',
          );
        }
        return toFactSnapshot(existing);
      }
      const contact = await transaction.contact.findFirst({
        where: { tenantId, id: contactId },
        select: { id: true },
      });
      if (!contact) {
        throw new C360SegmentRepositoryError('RESOURCE_NOT_FOUND', 'ไม่พบ contact ใน tenant');
      }
      const latest = await transaction.c360FactSnapshot.findFirst({
        where: { tenantId, contactId },
        orderBy: { snapshotVersion: 'desc' },
        select: { snapshotVersion: true },
      });
      const expected = (latest?.snapshotVersion ?? 0) + 1;
      if (snapshotVersion !== expected) {
        throw new C360SegmentRepositoryError(
          'NON_SEQUENTIAL_VERSION',
          `snapshot version ต้องเป็น ${expected}`,
        );
      }
      return toFactSnapshot(
        await transaction.c360FactSnapshot.create({
          data: {
            id: this.id(),
            tenantId,
            contactId,
            snapshotVersion,
            attributes: json(snapshot.attributes),
            computed: json(snapshot.computed),
            sourceCutoffAt: new Date(snapshot.sourceCutoffAt),
            contentDigest,
            correlationId,
          },
        }),
      );
    });
  }

  async evaluateStored(
    input: EvaluateStoredC360SegmentInput,
  ): Promise<C360StoredSegmentEvaluation> {
    const tenantId = nonEmpty(input.tenantId, 'tenantId');
    const contactId = nonEmpty(input.contactId, 'contactId');
    const segmentId = nonEmpty(input.segmentId, 'segmentId');
    const segmentDefinitionVersion = positiveInteger(
      input.segmentDefinitionVersion,
      'segmentDefinitionVersion',
    );
    const snapshotVersion = positiveInteger(input.snapshotVersion, 'snapshotVersion');

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(
        transaction,
        tenantId,
        `evaluation:${contactId}:${segmentId}:${segmentDefinitionVersion}:${snapshotVersion}`,
      );
      const binding = {
        tenantId,
        contactId,
        segmentId,
        segmentDefinitionVersion,
        snapshotVersion,
      };
      const existing = await transaction.c360SegmentEvaluation.findUnique({
        where: {
          tenantId_contactId_segmentId_segmentDefinitionVersion_snapshotVersion: binding,
        },
      });
      if (existing) return toEvaluation(existing);

      const definition = await transaction.c360SegmentDefinition.findUnique({
        where: {
          tenantId_segmentId_version: {
            tenantId,
            segmentId,
            version: segmentDefinitionVersion,
          },
        },
      });
      const snapshot = await transaction.c360FactSnapshot.findUnique({
        where: { tenantId_contactId_snapshotVersion: { tenantId, contactId, snapshotVersion } },
      });
      if (!definition || !snapshot || definition.status === 'DRAFT') {
        throw new C360SegmentRepositoryError(
          'RESOURCE_NOT_FOUND',
          'ไม่พบ published definition หรือ owner snapshot ของ binding นี้',
        );
      }

      const normalizedSnapshot: C360NormalizedFactSnapshot = {
        attributes: snapshot.attributes as Record<string, string | number | boolean | null>,
        computed: snapshot.computed as Record<string, string | number | boolean | null>,
        sourceCutoffAt: snapshot.sourceCutoffAt.toISOString(),
      };
      const result = this.evaluator.evaluate({
        ...binding,
        definition: validateSegmentDefinitionContent(definition.definition),
        snapshot: normalizedSnapshot,
      });
      return toEvaluation(
        await transaction.c360SegmentEvaluation.create({
          data: {
            id: this.id(),
            ...binding,
            outcome: result.outcome,
            matched: result.outcome === 'ERROR' ? null : result.matched,
            errorCode: result.errorCode,
            inputDigest: result.inputDigest,
            evaluationDigest: result.evaluationDigest,
            evaluatorVersion: result.evaluatorVersion,
          },
        }),
      );
    });
  }
}
