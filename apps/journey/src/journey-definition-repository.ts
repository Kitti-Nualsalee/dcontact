import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrJourneyDefinitionStatus,
  type PrismaClient,
  withTenantDatabaseTransaction,
  lockTeamReferences,
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

/**
 * J5.2 (#340): a journey whose authoring head is PAUSED/DEPRECATED is not selected as the target of a new trigger;
 * published versions remain intact (existing enrollments pin that version and can continue)
 */
async function pausedJourneyIds(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  rows: ReadonlyArray<{ journeyId: string }>,
): Promise<ReadonlySet<string>> {
  if (rows.length === 0) return new Set();
  const heads = await transaction.jrJourneyHead.findMany({
    where: {
      tenantId,
      journeyId: { in: rows.map((row) => row.journeyId) },
      lifecycle: { in: ['PAUSED', 'DEPRECATED'] },
    },
    select: { journeyId: true },
  });
  return new Set(heads.map((head) => head.journeyId));
}

export interface JourneyDefinitionRepositoryOptions {
  id?: () => string;
}

/**
 * Owner: Journey. Stores Journey definitions append-only per version — persisted content
 * is never modified; publish is only a state transition that is idempotent per
 * (tenantId, journeyId, version) per the C1.4 acceptance
 */
/**
 * J2.7: whether this version's trigger matches the outcome revision — used both when finding the published
 * journey and when re-evaluating an existing enrollment against the pinned version when a correction arrives
 */
export function matchesOutcomeTrigger(
  snapshot: JourneyVersionSnapshot,
  outcomeType: string,
  outcomeCode: string | undefined,
): boolean {
  if (snapshot.trigger.kind !== 'INTERACTION_OUTCOME') return false;
  if (snapshot.trigger.outcomeType !== outcomeType) return false;
  if (snapshot.trigger.outcomeCode === undefined) return true;
  return snapshot.trigger.outcomeCode === outcomeCode;
}

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
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      this.createVersionInTransaction(transaction, input),
    );
  }

  /**
   * J5.2 (#340): writes a version in the caller's transaction so the authoring publish commits
   * definition, head, review, receipt, audit and outbox all together — same logic as `createVersion`
   */
  async createVersionInTransaction(
    transaction: Prisma.TransactionClient,
    input: CreateJourneyVersionInput,
  ): Promise<JourneyVersionSnapshot> {
    const contentHash = canonicalContentHash(input);

    const persist = async (transaction: Prisma.TransactionClient) => {
      await lockTeamReferences(transaction, input.tenantId, [input.ownerTeamId]);
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

    return persist(transaction);
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

  /**
   * V1: at most one published journey per (outcomeType, outcomeCode) per tenant —
   * following `JrEnrollment`'s `@@unique([tenantId, outcomeReceiptId])` which is designed so a trigger
   * source can have only one enrollment (same as the original EVENT/SCHEDULE triggers);
   * multi-journey fan-out per single outcome is the scope of a later ticket (#135)
   */
  async findPublishedByOutcomeTrigger(
    tenantId: string,
    outcomeType: string,
    outcomeCode: string | undefined,
  ): Promise<readonly JourneyVersionSnapshot[]> {
    const read = async (transaction: Prisma.TransactionClient) => {
      const latestPerJourney = await transaction.jrJourneyDefinition.groupBy({
        by: ['journeyId'],
        where: { tenantId, status: 'PUBLISHED' },
        _max: { version: true },
      });
      if (latestPerJourney.length === 0) return [];
      const rows = await transaction.jrJourneyDefinition.findMany({
        where: {
          tenantId,
          status: 'PUBLISHED',
          OR: latestPerJourney.map((group) => ({
            journeyId: group.journeyId,
            version: group._max.version ?? -1,
          })),
        },
      });
      const paused = await pausedJourneyIds(transaction, tenantId, rows);
      return (
        rows
          .filter((row) => !paused.has(row.journeyId))
          .map((row) => toSnapshot(row as StoredJourneyDefinition))
          .filter((snapshot) => matchesOutcomeTrigger(snapshot, outcomeType, outcomeCode))
          // several journeys can match the same outcome (fan-out) — sort so the processing order is stable
          // regardless of the row order Postgres returns
          .sort((left, right) => left.journeyId.localeCompare(right.journeyId))
      );
    };
    return withTenantDatabaseTransaction(this.database, tenantId, read);
  }

  /**
   * J3.6 (#217): all published SEGMENT_ENTRY definitions that reference this segment
   *
   * Unlike `findPublishedByOutcomeTrigger`, which returns at most one — a single segment can have several
   * interested journeys at once, and the enrollment intent unique is at the (journey, version) level,
   * so it already supports fan-out; forcing it down to one here would make the remaining journeys silently disappear
   * without anyone knowing
   */
  async findPublishedBySegmentTrigger(
    tenantId: string,
    segmentId: string,
  ): Promise<readonly JourneyVersionSnapshot[]> {
    const read = async (transaction: Prisma.TransactionClient) => {
      const latestPerJourney = await transaction.jrJourneyDefinition.groupBy({
        by: ['journeyId'],
        where: { tenantId, status: 'PUBLISHED' },
        _max: { version: true },
      });
      if (latestPerJourney.length === 0) return [];
      const rows = await transaction.jrJourneyDefinition.findMany({
        where: {
          tenantId,
          status: 'PUBLISHED',
          OR: latestPerJourney.map((group) => ({
            journeyId: group.journeyId,
            version: group._max.version ?? -1,
          })),
        },
        orderBy: { journeyId: 'asc' },
      });
      const paused = await pausedJourneyIds(transaction, tenantId, rows);
      return rows
        .filter((row) => !paused.has(row.journeyId))
        .map((row) => toSnapshot(row as StoredJourneyDefinition))
        .filter(
          (snapshot) =>
            snapshot.trigger.kind === 'SEGMENT_ENTRY' && snapshot.trigger.segmentId === segmentId,
        );
    };
    return withTenantDatabaseTransaction(this.database, tenantId, read);
  }

  async publishVersion(input: PublishJourneyVersionInput): Promise<JourneyVersionSnapshot> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      this.publishVersionInTransaction(transaction, input),
    );
  }

  /** J5.2 (#340): publish in the caller's transaction — checks the same references as `publishVersion` */
  async publishVersionInTransaction(
    transaction: Prisma.TransactionClient,
    input: PublishJourneyVersionInput,
  ): Promise<JourneyVersionSnapshot> {
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

      /**
       * J3.4 (#215): SEGMENT_ENTRY must reference a segment that is really published in this tenant.
       *
       * Checked at publish, not at runtime, because a published definition is immutable —
       * letting a publish succeed with a mistyped segmentId or one from another tenant would produce a version
       * that can never be triggered, with nothing to tell anyone
       *
       * currentVersion must not be null, i.e. the segment must have a published version, not
       * just a DRAFT — binding a Journey to a segment that is not yet announced gives the same result: it never fires.
       *
       * This is a config-time reference check, not runtime authorization: deciding which contact
       * is really in a segment remains Customer 360's job at runtime only (stop condition #215)
       */
      if (content.trigger.kind === 'SEGMENT_ENTRY') {
        const segment = await transaction.c360SegmentDefinitionHead.findFirst({
          where: {
            tenantId: input.tenantId,
            segmentId: content.trigger.segmentId,
            currentVersion: { not: null },
          },
          select: { segmentId: true },
        });
        if (!segment) {
          throw new JourneyDefinitionValidationError(['SEGMENT_REFERENCE_UNTRUSTED']);
        }
      }

      if (content.trigger.kind === 'INTERACTION_OUTCOME') {
        const entryStep = content.graph.steps.find((step) => step.id === content.graph.entryStepId);
        const targetOwnerTeamId =
          entryStep &&
          (entryStep.type === 'ENSURE_CASE' ||
            entryStep.type === 'ADMIT_CAMPAIGN_TARGET' ||
            entryStep.type === 'SCHEDULE_CALLBACK')
            ? entryStep.targetOwnerTeamId
            : undefined;
        const targetTeam = targetOwnerTeamId
          ? await transaction.team.findFirst({
              where: { id: targetOwnerTeamId, tenantId: input.tenantId },
              select: { id: true },
            })
          : undefined;
        if (!targetTeam) {
          throw new JourneyDefinitionValidationError(['TARGET_TEAM_UNTRUSTED']);
        }
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

    return persist(transaction);
  }
}
