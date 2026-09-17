import { createHash, randomUUID } from 'node:crypto';
import type { SegmentMembershipChangePayloadV1 } from '@d-contact/cxa-contracts';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export type IamScopePermission = 'WORK' | 'CONTACT';

export interface GrantTeamSegmentScopeInput {
  tenantId: string;
  teamId: string;
  segmentId: string;
  permission: IamScopePermission;
  correlationId: string;
}

export interface RevokeTeamSegmentScopeInput {
  tenantId: string;
  grantId: string;
  reasonCode: string;
  correlationId: string;
}

/**
 * IAM-owned persistence boundary. It deliberately accepts a segment, never a caller
 * supplied contact membership; that membership arrives only through the Kafka projection.
 */
export class IamTeamSegmentScopeRepository {
  constructor(
    private readonly database: PrismaClient,
    private readonly id: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async grant(input: GrantTeamSegmentScopeInput) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      // Serialize same-team changes before examining the mutable head. The historical
      // grant/revocation evidence itself is never updated.
      await this.ensureScopeVersionRow(transaction, input.tenantId, input.teamId);
      const active = await transaction.iamTeamSegmentScopeActiveGrant.findUnique({
        where: {
          tenantId_teamId_segmentId_permission: {
            tenantId: input.tenantId,
            teamId: input.teamId,
            segmentId: input.segmentId,
            permission: input.permission,
          },
        },
      });
      if (active) {
        const activeGrant = await transaction.iamTeamSegmentScopeGrant.findUniqueOrThrow({
          where: { id: active.grantId },
        });
        return { outcome: 'DUPLICATE' as const, grant: activeGrant };
      }

      const version = await this.bumpScopeVersion(transaction, input.tenantId, input.teamId);
      const grant = await transaction.iamTeamSegmentScopeGrant.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          teamId: input.teamId,
          segmentId: input.segmentId,
          permission: input.permission,
          grantVersion: version,
        },
      });
      await transaction.iamTeamSegmentScopeActiveGrant.create({
        data: {
          tenantId: input.tenantId,
          teamId: input.teamId,
          segmentId: input.segmentId,
          permission: input.permission,
          grantId: grant.id,
        },
      });
      await this.writeInvalidation(transaction, {
        tenantId: input.tenantId,
        teamId: input.teamId,
        scopeVersion: version,
        kind: 'GRANTED',
        correlationId: input.correlationId,
        grantId: grant.id,
      });
      return { outcome: 'GRANTED' as const, grant };
    });
  }

  async revoke(input: RevokeTeamSegmentScopeInput) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const grant = await transaction.iamTeamSegmentScopeGrant.findFirstOrThrow({
        where: { id: input.grantId, tenantId: input.tenantId },
      });
      const existing = await transaction.iamTeamSegmentScopeRevocation.findFirst({
        where: { tenantId: input.tenantId, grantId: input.grantId },
      });
      if (existing) return { outcome: 'DUPLICATE' as const, grant, revocation: existing };

      const version = await this.bumpScopeVersion(transaction, input.tenantId, grant.teamId);
      await transaction.iamTeamSegmentScopeActiveGrant.deleteMany({
        where: { tenantId: input.tenantId, grantId: grant.id },
      });
      const revocation = await transaction.iamTeamSegmentScopeRevocation.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          grantId: grant.id,
          scopeVersion: version,
          reasonCode: input.reasonCode,
        },
      });
      await this.writeInvalidation(transaction, {
        tenantId: input.tenantId,
        teamId: grant.teamId,
        scopeVersion: version,
        kind: 'REVOKED',
        correlationId: input.correlationId,
        grantId: grant.id,
      });
      return { outcome: 'REVOKED' as const, grant, revocation };
    });
  }

  async applyMembershipChange(input: {
    tenantId: string;
    eventId: string;
    occurredAt: string;
    consumerGroup: string;
    payload: SegmentMembershipChangePayloadV1;
  }) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const completed = await transaction.iamScopeConsumerInbox.findUnique({
        where: {
          consumerGroup_tenantId_eventId: {
            consumerGroup: input.consumerGroup,
            tenantId: input.tenantId,
            eventId: input.eventId,
          },
        },
      });
      if (completed) return { outcome: 'DUPLICATE' as const };

      const previous = await transaction.iamContactSegmentScopeProjection.findUnique({
        where: {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: input.payload.contactId,
            segmentId: input.payload.segmentId,
          },
        },
      });
      const revision = input.payload.membershipRevision;
      const state =
        previous && revision > previous.membershipRevision + 1
          ? 'INVALIDATED'
          : input.payload.changeKind === 'LEFT'
            ? 'OUT'
            : input.payload.changeKind === 'REFILTER_REQUIRED' ||
                input.payload.changeKind === 'IDENTITY_INVALIDATED'
              ? 'INVALIDATED'
              : 'IN';
      const outcome = !previous || revision > previous.membershipRevision ? 'APPLIED' : 'STALE';
      if (outcome === 'APPLIED') {
        await transaction.iamContactSegmentScopeProjection.upsert({
          where: {
            tenantId_contactId_segmentId: {
              tenantId: input.tenantId,
              contactId: input.payload.contactId,
              segmentId: input.payload.segmentId,
            },
          },
          create: {
            tenantId: input.tenantId,
            contactId: input.payload.contactId,
            segmentId: input.payload.segmentId,
            state,
            membershipRevision: revision,
            entryId: input.payload.entryId,
            sourceEventId: input.eventId,
            sourceOccurredAt: new Date(input.occurredAt),
          },
          update: {
            state,
            membershipRevision: revision,
            entryId: input.payload.entryId,
            sourceEventId: input.eventId,
            sourceOccurredAt: new Date(input.occurredAt),
          },
        });
      }
      await transaction.iamScopeConsumerInbox.create({
        data: {
          consumerGroup: input.consumerGroup,
          tenantId: input.tenantId,
          eventId: input.eventId,
        },
      });
      return { outcome };
    });
  }

  private async bumpScopeVersion(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    teamId: string,
  ) {
    const row = await transaction.iamTeamScopeVersion.update({
      where: { tenantId_teamId: { tenantId, teamId } },
      data: { scopeVersion: { increment: 1 }, updatedAt: this.now() },
    });
    return row.scopeVersion;
  }

  private async ensureScopeVersionRow(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    teamId: string,
  ) {
    await transaction.iamTeamScopeVersion.upsert({
      where: { tenantId_teamId: { tenantId, teamId } },
      create: { tenantId, teamId, scopeVersion: 0, updatedAt: this.now() },
      update: { updatedAt: this.now() },
    });
  }

  private async writeInvalidation(
    transaction: Prisma.TransactionClient,
    input: {
      tenantId: string;
      teamId: string;
      scopeVersion: number;
      kind: 'GRANTED' | 'REVOKED';
      correlationId: string;
      grantId: string;
    },
  ) {
    const eventId = this.id();
    const payload = {
      schemaVersion: 2,
      eventId,
      type: 'team.segment-scope.changed',
      tenantId: input.tenantId,
      teamId: input.teamId,
      scopeVersion: input.scopeVersion,
      kind: input.kind,
      occurredAt: this.now().toISOString(),
      correlationId: input.correlationId,
      grantId: input.grantId,
    };
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await transaction.iamScopeInvalidationOutbox.create({
      data: {
        id: this.id(),
        tenantId: input.tenantId,
        teamId: input.teamId,
        eventId,
        scopeVersion: input.scopeVersion,
        kind: input.kind,
        payload,
        payloadHash,
      },
    });
  }
}
