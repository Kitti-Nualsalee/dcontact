/**
 * J2.8 (#136) — the single `J2DialerOwnerPort` of Dialer used by the consumer: routes by commandType to the
 * owner service that owns that aggregate (campaign target or callback)
 *
 * A query needs no routing — every kind of receipt lives in the same `ob_dialer_command_inbox` and is separated by
 * `(actionKey, requestHash)` already
 */
import type { PrismaClient } from '@d-contact/db';
import type {
  J2DialerOwnerCommandV1,
  J2DialerOwnerPort,
  J2OwnerActionQueryV1,
  J2OwnerCommandPersistedV1,
  J2OwnerResultPayloadV1,
  TeamContactScopeAuthorizer,
  TenantId,
} from '@d-contact/cxa-contracts';
import { DialerAdmitCampaignTargetService } from './dialer-admit-campaign-target-service.js';
import { DialerCallbackService } from './dialer-callback-service.js';
import { queryDialerAction } from './dialer-command-inbox.js';

const CALLBACK_COMMAND_TYPES = new Set([
  'SCHEDULE_CALLBACK',
  'CANCEL_CALLBACK',
  'SUPERSEDE_CALLBACK',
]);
const ALL_COMMAND_TYPES: ReadonlySet<string> = new Set([
  ...CALLBACK_COMMAND_TYPES,
  'ADMIT_CAMPAIGN_TARGET',
  'CANCEL_CAMPAIGN_TARGET',
  'SUPERSEDE_CAMPAIGN_TARGET',
]);

export class DialerOwnerCommandService implements J2DialerOwnerPort {
  private readonly campaignTargets: DialerAdmitCampaignTargetService;
  private readonly callbacks: DialerCallbackService;

  constructor(
    private readonly database: PrismaClient,
    scopeAuthorizer: TeamContactScopeAuthorizer,
    options: { id?: () => string; now?: () => Date } = {},
  ) {
    this.campaignTargets = new DialerAdmitCampaignTargetService(database, scopeAuthorizer, options);
    this.callbacks = new DialerCallbackService(database, scopeAuthorizer, options);
  }

  persistCommand(
    tenant: TenantId,
    command: J2DialerOwnerCommandV1,
  ): Promise<J2OwnerCommandPersistedV1> {
    return CALLBACK_COMMAND_TYPES.has(command.commandType)
      ? this.callbacks.persistCommand(tenant, command)
      : this.campaignTargets.persistCommand(tenant, command);
  }

  queryAction(
    tenant: TenantId,
    query: J2OwnerActionQueryV1,
  ): Promise<J2OwnerResultPayloadV1 | undefined> {
    return queryDialerAction(this.database, tenant, query, ALL_COMMAND_TYPES);
  }
}
