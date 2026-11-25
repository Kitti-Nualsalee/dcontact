/**
 * J2.5 — Dialer owner implementation of `J2DialerOwnerPort` for Campaign targets. Dialer is the
 * sole canonical writer of `ob_campaign_*` per #121 — Journey never creates/starts/pauses/edits a
 * Campaign, and admission here never originates/sends (that's the originate barrier, J2.9).
 *
 * J2.8 (#136) adds `CANCEL_CAMPAIGN_TARGET`/`SUPERSEDE_CAMPAIGN_TARGET`: a target that has not yet reached the
 * originate barrier (ADMITTED/DEFERRED) can be cancelled/superseded, while a state the barrier has already claimed
 * answers `TOO_LATE` per #123 — callback commands remain the scope of `DialerCallbackService`
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  tenantId as toTenantId,
  J2_ERROR_CONTRACT,
  type CancelOwnerActionIntentV1,
  type J2DialerOwnerCommandV1,
  type J2DialerOwnerPort,
  type J2ErrorCode,
  type J2FailureClass,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerResultPayloadV1,
  type SupersedeOwnerActionIntentV1,
  type TeamContactScopeAuthorizer,
  type TenantId,
} from '@d-contact/cxa-contracts';
import {
  findPositiveReceipt,
  persistDialerCommand,
  queryDialerAction,
  type DialerCommandDecision,
} from './dialer-command-inbox.js';

export class DialerCommandNotImplementedError extends Error {
  constructor(readonly commandType: string) {
    super(`Dialer does not support this command type yet: ${commandType}`);
    this.name = 'DialerCommandNotImplementedError';
  }
}

type AdmitCommand = Extract<J2DialerOwnerCommandV1, { commandType: 'ADMIT_CAMPAIGN_TARGET' }>;
type CancelOrSupersedeTargetCommand =
  | Extract<J2DialerOwnerCommandV1, { intent: CancelOwnerActionIntentV1 }>
  | Extract<J2DialerOwnerCommandV1, { intent: SupersedeOwnerActionIntentV1 }>;

const CAMPAIGN_TARGET_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'ADMIT_CAMPAIGN_TARGET',
  'CANCEL_CAMPAIGN_TARGET',
  'SUPERSEDE_CAMPAIGN_TARGET',
]);

/** A target the originate barrier has not claimed — can be cancelled/superseded without irreversible effects */
const REVERSIBLE_TARGET_STATES = new Set(['ADMITTED', 'DEFERRED']);

export interface AdmitDecision extends DialerCommandDecision {
  status: 'ADMITTED' | 'ALREADY_ADMITTED' | 'CANCELLED' | 'SUPERSEDED' | 'TOO_LATE' | 'REJECTED';
  code: string;
  category: string;
  reasonCode: string;
  failureClass: J2FailureClass;
  retryDisposition: string;
  recordId?: string;
  recordVersion?: number;
}

export function rejection(
  code: J2ErrorCode,
  failureClass: J2FailureClass,
  reasonCode: string,
): AdmitDecision {
  const error = J2_ERROR_CONTRACT[code];
  return {
    status: 'REJECTED',
    code,
    category: error.category,
    reasonCode,
    failureClass,
    retryDisposition: error.retryDisposition,
  };
}

export function admitted(
  status: 'ADMITTED' | 'ALREADY_ADMITTED' | 'CANCELLED' | 'SUPERSEDED',
  reasonCode: string,
  recordId: string,
  recordVersion: number,
): AdmitDecision {
  return {
    status,
    code: status,
    category: 'BUSINESS',
    reasonCode,
    failureClass: 'NONE',
    retryDisposition: 'NONE',
    recordId,
    recordVersion,
  };
}

function targetTooLate(recordId: string, recordVersion: number): AdmitDecision {
  const error = J2_ERROR_CONTRACT.ACTION_TOO_LATE;
  return {
    status: 'TOO_LATE',
    code: 'ACTION_TOO_LATE',
    category: error.category,
    reasonCode: 'CAMPAIGN_TARGET_IRREVERSIBLE',
    failureClass: 'BUSINESS',
    retryDisposition: error.retryDisposition,
    recordId,
    recordVersion,
  };
}

export class DialerAdmitCampaignTargetService implements J2DialerOwnerPort {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly scopeAuthorizer: TeamContactScopeAuthorizer,
    options: { id?: () => string; now?: () => Date } = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  async persistCommand(
    tenant: TenantId,
    command: J2DialerOwnerCommandV1,
  ): Promise<J2OwnerCommandPersistedV1> {
    if (!CAMPAIGN_TARGET_COMMAND_TYPES.has(command.commandType)) {
      throw new DialerCommandNotImplementedError(command.commandType);
    }
    return persistDialerCommand({
      database: this.database,
      tenant,
      command,
      id: this.id,
      now: this.now,
      decide: (transaction) =>
        command.commandType === 'ADMIT_CAMPAIGN_TARGET'
          ? this.decide(transaction, tenant, command as AdmitCommand)
          : this.decideCancelOrSupersede(
              transaction,
              tenant,
              command as CancelOrSupersedeTargetCommand,
            ),
    });
  }

  queryAction(
    tenant: TenantId,
    query: J2OwnerActionQueryV1,
  ): Promise<J2OwnerResultPayloadV1 | undefined> {
    return queryDialerAction(this.database, tenant, query, CAMPAIGN_TARGET_COMMAND_TYPES);
  }

  /**
   * Does not re-check CONTACT scope — cancelling "reduces" contact, and is the path Journey uses when a scope
   * is revoked (J3 refilter); enforcing scope here would block cancelling exactly when it is needed most.
   * It must still bind to the real original target: both the contact and the team must match what was admitted.
   */
  private async decideCancelOrSupersede(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: CancelOrSupersedeTargetCommand,
  ): Promise<AdmitDecision> {
    const original = await findPositiveReceipt(
      transaction,
      tenantId,
      command.intent.originalActionKey,
      'ADMIT_CAMPAIGN_TARGET',
    );
    if (
      !original?.recordId ||
      (original.status !== 'ADMITTED' && original.status !== 'ALREADY_ADMITTED')
    ) {
      return rejection('OWNER_REJECTED', 'BUSINESS', 'ORIGINAL_ACTION_NOT_FOUND');
    }
    const target = await transaction.obCampaignTarget.findFirst({
      where: { id: original.recordId, tenantId },
    });
    if (
      !target ||
      target.contactId !== command.contactId ||
      target.sourceOwnerTeamId !== command.sourceOwnerTeamId ||
      target.targetOwnerTeamId !== command.targetOwnerTeamId
    ) {
      return rejection('BINDING_MISMATCH', 'CONTRACT', 'ORIGINAL_ACTION_BINDING_MISMATCH');
    }

    const supersede = 'supersedingOutcome' in command.intent;
    const targetState = supersede ? 'SUPERSEDED' : 'CANCELLED';
    if (target.state === targetState) {
      return admitted(
        targetState,
        supersede ? 'CAMPAIGN_TARGET_ALREADY_SUPERSEDED' : 'CAMPAIGN_TARGET_ALREADY_CANCELLED',
        target.id,
        target.version,
      );
    }
    if (!REVERSIBLE_TARGET_STATES.has(target.state)) {
      return targetTooLate(target.id, target.version);
    }

    // CAS on version + state — the originate barrier claims with state ADMITTED + the same version,
    // so only one side can win. If the barrier wins first, the cancel must become TOO_LATE rather than overwrite ORIGINATING
    const now = this.now();
    const intent = command.intent as SupersedeOwnerActionIntentV1;
    const moved = await transaction.obCampaignTarget.updateMany({
      where: { id: target.id, tenantId, version: target.version, state: target.state },
      data: supersede
        ? {
            state: 'SUPERSEDED',
            supersededAt: now,
            supersedingOutcomeType: intent.supersedingOutcome.outcomeType,
            supersedingOutcomeId: intent.supersedingOutcome.outcomeId,
            supersedingOutcomeVersion: intent.supersedingOutcome.outcomeVersion,
            version: { increment: 1 },
          }
        : {
            state: 'CANCELLED',
            cancelledAt: now,
            cancelReasonCode: command.intent.reasonCode,
            version: { increment: 1 },
          },
    });
    if (moved.count === 0) {
      const current = await transaction.obCampaignTarget.findFirstOrThrow({
        where: { id: target.id, tenantId },
      });
      return targetTooLate(current.id, current.version);
    }
    return admitted(
      targetState,
      supersede ? 'CAMPAIGN_TARGET_SUPERSEDED' : 'CAMPAIGN_TARGET_CANCELLED',
      target.id,
      target.version + 1,
    );
  }

  private async decide(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: AdmitCommand,
  ): Promise<AdmitDecision> {
    const [contact, sourceTeam, targetTeam] = await Promise.all([
      transaction.contact.findFirst({
        where: { id: command.contactId, tenantId },
        select: { id: true },
      }),
      transaction.team.findFirst({
        where: { id: command.sourceOwnerTeamId, tenantId },
        select: { id: true },
      }),
      transaction.team.findFirst({
        where: { id: command.targetOwnerTeamId, tenantId },
        select: { id: true },
      }),
    ]);

    // Do not reveal whether the contact/team exists in another tenant — always reject as if not found
    if (!contact) return rejection('CONTACT_NOT_FOUND', 'AUTHORIZATION', 'CONTACT_NOT_FOUND');
    if (!sourceTeam) {
      return rejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'SOURCE_TEAM_NOT_FOUND');
    }
    if (!targetTeam) {
      return rejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'TARGET_TEAM_NOT_FOUND');
    }

    // Check the current WORK scope of both team roles before admit — audit both per #121
    const at = this.now().toISOString();
    const tenant = toTenantId(tenantId);
    const [sourceScope, targetScope] = await Promise.all([
      this.scopeAuthorizer.authorize({
        tenantId: tenant,
        teamId: command.sourceOwnerTeamId,
        contactId: command.contactId,
        permission: 'CONTACT',
        at,
      }),
      this.scopeAuthorizer.authorize({
        tenantId: tenant,
        teamId: command.targetOwnerTeamId,
        contactId: command.contactId,
        permission: 'CONTACT',
        at,
      }),
    ]);
    if (sourceScope.decision === 'DENY' || targetScope.decision === 'DENY') {
      return rejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'WORK_SCOPE_DENIED');
    }

    const campaign = await transaction.obCampaign.findFirst({
      where: { id: command.intent.campaignId, tenantId },
    });
    if (!campaign) {
      return rejection('OWNER_REJECTED', 'BUSINESS', 'CAMPAIGN_BINDING_INVALID');
    }
    if (campaign.status === 'STOPPED' || campaign.status === 'COMPLETED') {
      return rejection(
        'OWNER_REJECTED',
        'BUSINESS',
        campaign.status === 'STOPPED' ? 'CAMPAIGN_STOPPED' : 'CAMPAIGN_COMPLETED',
      );
    }

    const policy = await transaction.obCampaignAdmissionPolicy.findUnique({
      where: { tenantId_campaignId: { tenantId, campaignId: campaign.id } },
    });
    const admissionPolicyVersion = policy?.version ?? 1;
    const allowCrossCampaignDuplicate = policy?.allowCrossCampaignDuplicate ?? false;

    // Serialize the decision per (campaign, contact) so two commands cannot race to admit twice
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`ob-admission:${tenantId}:${campaign.id}:${command.contactId}`}))`,
    );

    const existingTarget = await transaction.obCampaignTarget.findUnique({
      where: {
        tenantId_campaignId_contactId: {
          tenantId,
          campaignId: campaign.id,
          contactId: command.contactId,
        },
      },
    });
    if (existingTarget) {
      return admitted(
        'ALREADY_ADMITTED',
        'CAMPAIGN_TARGET_ALREADY_ADMITTED',
        existingTarget.id,
        existingTarget.version,
      );
    }

    if (!allowCrossCampaignDuplicate) {
      const crossCampaignDuplicate = await transaction.obCampaignTarget.findFirst({
        where: { tenantId, contactId: command.contactId, campaignId: { not: campaign.id } },
        select: { id: true },
      });
      if (crossCampaignDuplicate) {
        return rejection('OWNER_REJECTED', 'BUSINESS', 'DUPLICATE_CONTACT_CROSS_CAMPAIGN');
      }
    }

    const state = campaign.status === 'ACTIVE' ? 'ADMITTED' : 'DEFERRED';
    const created = await transaction.obCampaignTarget.create({
      data: {
        id: this.id(),
        tenantId,
        campaignId: campaign.id,
        contactId: command.contactId,
        state,
        sourceOwnerTeamId: command.sourceOwnerTeamId,
        targetOwnerTeamId: command.targetOwnerTeamId,
        admissionPolicyVersion,
      },
    });
    return admitted(
      'ADMITTED',
      state === 'ADMITTED' ? 'CAMPAIGN_ACTIVE_ADMITTED' : 'CAMPAIGN_DEFERRED_ADMITTED',
      created.id,
      created.version,
    );
  }
}
