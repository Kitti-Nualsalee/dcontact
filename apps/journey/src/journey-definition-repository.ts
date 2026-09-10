import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrJourneyDefinitionStatus,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ExpressionEvaluator } from '@d-contact/cxa-contracts';
import {
  JourneyDefinitionValidationError,
  JourneyVersionConflictError,
  JourneyVersionNotFoundError,
  JourneyVersionSequenceError,
  type CreateJourneyVersionInput,
  type JourneyDefinitionContent,
  type JourneyExitRule,
  type JourneyGoal,
  type JourneyGraph,
  type JourneyTrigger,
  type JourneyVersionSnapshot,
  type PublishJourneyVersionInput,
} from './journey-definition.js';
import { validateJourneyDefinitionStructure } from './journey-definition-validator.js';

interface StoredJourneyDefinition {
  id: string;
  tenantId: string;
  journeyId: string;
  version: number;
  name: string;
  ownerTeamId: string;
  purpose: string;
  senderIdentityId: string;
  status: JrJourneyDefinitionStatus;
  trigger: Prisma.JsonValue;
  graph: Prisma.JsonValue;
  goal: Prisma.JsonValue;
  exitRules: Prisma.JsonValue;
  maxDurationDays: number;
  inputHash: string;
  correlationId: string;
  publishedAt: Date | null;
  createdAt: Date;
}

function canonicalContentHash(content: JourneyDefinitionContent): string {
  const canonical = JSON.stringify({
    name: content.name,
    ownerTeamId: content.ownerTeamId,
    purpose: content.purpose,
    senderIdentityId: content.senderIdentityId,
    trigger: content.trigger,
    graph: content.graph,
    goal: content.goal,
    exitRules: content.exitRules,
    maxDurationDays: content.maxDurationDays,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function toSnapshot(row: StoredJourneyDefinition): JourneyVersionSnapshot {
  return {
    tenantId: row.tenantId,
    journeyId: row.journeyId,
    version: row.version,
    name: row.name,
    ownerTeamId: row.ownerTeamId,
    purpose: row.purpose,
    senderIdentityId: row.senderIdentityId,
    status: row.status,
    trigger: row.trigger as unknown as JourneyTrigger,
    graph: row.graph as unknown as JourneyGraph,
    goal: row.goal as unknown as JourneyGoal,
    exitRules: row.exitRules as unknown as readonly JourneyExitRule[],
    maxDurationDays: row.maxDurationDays,
    contentHash: row.inputHash,
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface JourneyDefinitionRepositoryOptions {
  id?: () => string;
}

/**
 * Owner: Journey. เก็บ Journey definition แบบ append-only ต่อ version — เนื้อหาที่ persist
 * แล้วไม่ถูกแก้ไข การ publish เป็นเพียง state transition ที่ idempotent ต่อ
 * (tenantId, journeyId, version) ตาม C1.4 acceptance
 */
export class JourneyDefinitionRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly evaluator: ExpressionEvaluator,
    options: JourneyDefinitionRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  async createVersion(input: CreateJourneyVersionInput): Promise<JourneyVersionSnapshot> {
    const contentHash = canonicalContentHash(input);

    const persist = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-journey-definition:${input.tenantId}:${input.journeyId}`}))`,
      );

      const existing = await transaction.jrJourneyDefinition.findUnique({
        where: {
          tenantId_journeyId_version: {
            tenantId: input.tenantId,
            journeyId: input.journeyId,
            version: input.version,
          },
        },
      });
      if (existing) {
        if (existing.inputHash !== contentHash) {
          throw new JourneyVersionConflictError(input.journeyId, input.version);
        }
        return toSnapshot(existing);
      }

      const latest = await transaction.jrJourneyDefinition.findFirst({
        where: { tenantId: input.tenantId, journeyId: input.journeyId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const expectedVersion = (latest?.version ?? 0) + 1;
      if (input.version !== expectedVersion) {
        throw new JourneyVersionSequenceError(input.journeyId, input.version, expectedVersion);
      }

      const created = await transaction.jrJourneyDefinition.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          journeyId: input.journeyId,
          version: input.version,
          name: input.name,
          ownerTeamId: input.ownerTeamId,
          purpose: input.purpose,
          senderIdentityId: input.senderIdentityId,
          trigger: input.trigger as unknown as Prisma.InputJsonValue,
          graph: input.graph as unknown as Prisma.InputJsonValue,
          goal: input.goal as unknown as Prisma.InputJsonValue,
          exitRules: input.exitRules as unknown as Prisma.InputJsonValue,
          maxDurationDays: input.maxDurationDays,
          inputHash: contentHash,
          correlationId: input.correlationId,
        },
      });
      return toSnapshot(created);
    };

    return withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }

  async getVersion(
    tenantId: string,
    journeyId: string,
    version: number,
  ): Promise<JourneyVersionSnapshot | undefined> {
    const read = async (transaction: Prisma.TransactionClient) => {
      const row = await transaction.jrJourneyDefinition.findUnique({
        where: { tenantId_journeyId_version: { tenantId, journeyId, version } },
      });
      return row ? toSnapshot(row) : undefined;
    };
    return withTenantDatabaseTransaction(this.database, tenantId, read);
  }

  async publishVersion(input: PublishJourneyVersionInput): Promise<JourneyVersionSnapshot> {
    const persist = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-journey-definition:${input.tenantId}:${input.journeyId}:${input.version}`}))`,
      );

      const existing = await transaction.jrJourneyDefinition.findUnique({
        where: {
          tenantId_journeyId_version: {
            tenantId: input.tenantId,
            journeyId: input.journeyId,
            version: input.version,
          },
        },
      });
      if (!existing) throw new JourneyVersionNotFoundError(input.journeyId, input.version);
      if (existing.inputHash !== input.expectedContentHash) {
        throw new JourneyVersionConflictError(input.journeyId, input.version);
      }
      if (existing.status === 'PUBLISHED') return toSnapshot(existing);

      const content = toSnapshot(existing);
      const validationCodes = validateJourneyDefinitionStructure(content, this.evaluator);
      if (validationCodes.length > 0) throw new JourneyDefinitionValidationError(validationCodes);

      const ownerTeam = await transaction.team.findFirst({
        where: { id: existing.ownerTeamId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!ownerTeam) {
        throw new JourneyDefinitionValidationError(['OWNER_TEAM_UNTRUSTED']);
      }

      const published = await transaction.jrJourneyDefinition.update({
        where: {
          tenantId_journeyId_version: {
            tenantId: input.tenantId,
            journeyId: input.journeyId,
            version: input.version,
          },
        },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      return toSnapshot(published);
    };

    return withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }
}
