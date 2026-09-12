/**
 * J2.5 — tenant-scoped Campaign + admission policy fixtures.
 *
 * There is no Campaign CRUD/UI in this slice (out of scope, see #133) — a
 * Campaign is always "existing" from Journey's point of view. This is just
 * enough durable fixture rows for `ADMIT_CAMPAIGN_TARGET` to resolve a
 * `campaignId` into a status and cross-campaign duplicate policy.
 */
import { randomUUID } from 'node:crypto';
import {
  type ObCampaignStatus,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export interface UpsertCampaignInput {
  tenantId: string;
  id?: string;
  key: string;
  status?: ObCampaignStatus;
}

export interface UpsertAdmissionPolicyInput {
  tenantId: string;
  campaignId: string;
  allowCrossCampaignDuplicate?: boolean;
}

export class CampaignFixtures {
  constructor(private readonly database: PrismaClient) {}

  upsertCampaign(input: UpsertCampaignInput) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      transaction.obCampaign.upsert({
        where: { tenantId_key: { tenantId: input.tenantId, key: input.key } },
        create: {
          id: input.id ?? randomUUID(),
          tenantId: input.tenantId,
          key: input.key,
          status: input.status ?? 'ACTIVE',
        },
        update: { status: input.status ?? 'ACTIVE' },
      }),
    );
  }

  upsertAdmissionPolicy(input: UpsertAdmissionPolicyInput) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      transaction.obCampaignAdmissionPolicy.upsert({
        where: {
          tenantId_campaignId: { tenantId: input.tenantId, campaignId: input.campaignId },
        },
        create: {
          id: randomUUID(),
          tenantId: input.tenantId,
          campaignId: input.campaignId,
          allowCrossCampaignDuplicate: input.allowCrossCampaignDuplicate ?? false,
        },
        update: { allowCrossCampaignDuplicate: input.allowCrossCampaignDuplicate ?? false },
      }),
    );
  }
}
