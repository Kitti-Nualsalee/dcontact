/**
 * Owner: IAM provisioning + Notification delivery — invitation of the first Tenant Admin (A1.4 #409)
 *
 * Authority: #392 Invitation contract
 * - Keycloak execute-actions (verify email, set password, register TOTP) valid for 72 hours
 * - the intent goes into `pf_invitations` before calling Keycloak, always (durable outbox), then the outcome is recorded
 * - an unclear outcome (timeout/lost response) = `AMBIGUOUS` → reconcile only with a delivery probe,
 *   never re-send on its own; if it cannot be proven the saga goes to ACTION_REQUIRED for the operator to decide
 * - resend = an operator action that needs a reason/comment, creates a new generation, audits every outcome and is
 *   capped at 3 per hour (a DB trigger enforces it race-safely)
 * - delivery accepted ≠ user activated: `status()` separates the two states
 *
 * Known limitation: Keycloak 26.0 cannot revoke action tokens of an old generation → #436
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  FIRST_ADMIN_REQUIRED_ACTIONS,
  INVITATION_LIMITS,
  PlatformProvisioningError,
} from '@d-contact/shared';
import { appendPlatformAction } from './action-history.js';
import type { KeycloakAdminClient } from './keycloak-admin.js';
import type { FirstAdminPort } from './keycloak-provisioning-ports.js';
import { platformIdentityHash } from './provisioning-input.js';
import type { PlatformActor } from './provisioning-repository.js';
import {
  ProvisioningStepError,
  provisioningStepContext,
  type ProvisioningAdoption,
  type ProvisioningStepContext,
  type ProvisioningStepPort,
} from './provisioning-saga.js';

/**
 * delivery evidence from the email provider side — used only to reconcile an `AMBIGUOUS` outcome
 * production without a lookup always returns `UNKNOWN` (the operator decides)
 */
export interface InvitationDeliveryProbe {
  delivered(input: { recipient: string; since: Date }): Promise<'DELIVERED' | 'UNKNOWN'>;
}

export const NO_DELIVERY_PROBE: InvitationDeliveryProbe = {
  delivered: async () => 'UNKNOWN',
};

/** dev/test email sink (mailpit) — correlation is the recipient (email unique across the platform) + time after the intent */
export function mailpitDeliveryProbe(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): InvitationDeliveryProbe {
  return {
    async delivered({ recipient, since }) {
      const response = await fetcher(
        `${baseUrl}/api/v1/search?${new URLSearchParams({ query: `to:"${recipient}"`, limit: '50' })}`,
      );
      if (!response.ok) return 'UNKNOWN';
      const body = (await response.json()) as { messages?: { Created: string }[] };
      return (body.messages ?? []).some((message) => new Date(message.Created) >= since)
        ? 'DELIVERED'
        : 'UNKNOWN';
    },
  };
}

type InvitationRow = Prisma.PfInvitationGetPayload<object>;

/** an intent younger than this is considered in flight (longer than the timeout of one external call) */
const INTENT_IN_FLIGHT_MS = 120_000;

export interface InvitationStatus {
  generation: number | null;
  delivery: 'NOT_STARTED' | 'INTENT' | 'SENT' | 'FAILED' | 'AMBIGUOUS';
  /** compared with the current clock — expired but not yet activated needs a resend */
  expired: boolean;
  activation: 'PENDING_ACTIVATION' | 'ACTIVATED' | 'UNKNOWN';
  expiresAt: Date | null;
  resendsInLastHour: number;
}

export class InvitationOutbox {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly probe: InvitationDeliveryProbe;

  constructor(
    /** Prisma with role `dcontact_platform` */
    private readonly platform: PrismaClient,
    private readonly keycloak: KeycloakAdminClient,
    private readonly firstAdmin: FirstAdminPort,
    options: { now?: () => Date; id?: () => string; probe?: InvitationDeliveryProbe } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.probe = options.probe ?? NO_DELIVERY_PROBE;
  }

  /** port of the INVITATION step for the saga worker */
  port(): ProvisioningStepPort {
    return {
      find: (context) => this.find(context),
      execute: (context, signal) => this.deliverInitial(context, signal),
    };
  }

  private latest(requestId: string) {
    return this.platform.pfInvitation.findFirst({
      where: { requestId },
      orderBy: { generation: 'desc' },
    });
  }

  async find(context: ProvisioningStepContext): Promise<ProvisioningAdoption> {
    const latest = await this.latest(context.requestId);
    if (latest?.state === 'SENT') return { status: 'FOUND', externalRef: latest.id };
    // a pending INTENT/AMBIGUOUS must go through reconciliation in execute; FAILED can be sent again
    return { status: 'NOT_FOUND' };
  }

  private async deliverInitial(context: ProvisioningStepContext, signal: AbortSignal) {
    const user = await this.firstAdmin.user(context, signal);
    if (!user) throw new ProvisioningStepError('PERMANENT', 'FIRST_ADMIN_MISSING');
    let latest = await this.latest(context.requestId);

    if (latest?.state === 'SENT') return { externalRef: latest.id };
    if (latest?.state === 'INTENT' || latest?.state === 'AMBIGUOUS') {
      // the previous attempt's outcome is unknown: look for delivery evidence, and if there is none never send again
      const reconciled = await this.reconcile(latest, context.request.firstAdminEmail);
      if (reconciled) return { externalRef: reconciled.id };
      throw new ProvisioningStepError('PERMANENT', 'INVITATION_DELIVERY_AMBIGUOUS');
    }
    if (!latest) {
      latest = await this.platform.pfInvitation.create({
        data: {
          id: this.id(),
          requestId: context.requestId,
          tenantId: context.tenantId,
          generation: 1,
          keycloakUserId: user.id,
          recipientHash: platformIdentityHash('email', context.request.firstAdminEmail),
          lifespanSeconds: INVITATION_LIMITS.lifespanSeconds,
          requestedByKind: 'SYSTEM',
          requestedBy: 'provisioning-worker',
          createdAt: this.now(),
        },
      });
    } else {
      // FAILED = proven not sent: reopen the same intent
      latest = await this.transition(latest, { state: 'INTENT', errorCode: null });
    }
    const sent = await this.send(latest, signal);
    return { externalRef: sent.id };
  }

  /** sends once for a recorded intent, then records the outcome as proven */
  private async send(invitation: InvitationRow, signal?: AbortSignal): Promise<InvitationRow> {
    let status: number;
    try {
      ({ status } = await this.keycloak.admin(
        'PUT',
        `/users/${encodeURIComponent(invitation.keycloakUserId)}/execute-actions-email?${new URLSearchParams(
          { lifespan: String(INVITATION_LIMITS.lifespanSeconds) },
        )}`,
        {
          body: [...FIRST_ADMIN_REQUIRED_ACTIONS],
          accept: [204, 400, 500],
          ...(signal ? { signal } : {}),
        },
      ));
    } catch (error) {
      // TRANSIENT/PERMANENT from the client = failed before Keycloak processed it (no token, 403, 4xx)
      if (error instanceof ProvisioningStepError && error.kind !== 'AMBIGUOUS') {
        await this.transition(invitation, { state: 'FAILED', errorCode: error.code });
        throw error;
      }
      await this.transition(invitation, {
        state: 'AMBIGUOUS',
        errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
      });
      throw new ProvisioningStepError(
        'AMBIGUOUS',
        error instanceof ProvisioningStepError ? error.code : 'DELIVERY_OUTCOME_UNKNOWN',
      );
    }
    if (status === 204) {
      const sentAt = this.now();
      return this.transition(invitation, {
        state: 'SENT',
        sentAt,
        expiresAt: new Date(sentAt.getTime() + invitation.lifespanSeconds * 1000),
        errorCode: null,
      });
    }
    // Keycloak answered clearly that sending failed (SMTP down = 500, unusable input = 400)
    await this.transition(invitation, {
      state: 'FAILED',
      errorCode: status === 500 ? 'EMAIL_SEND_FAILED' : 'EMAIL_REJECTED',
    });
    throw new ProvisioningStepError(
      status === 500 ? 'TRANSIENT' : 'PERMANENT',
      status === 500 ? 'EMAIL_SEND_FAILED' : 'EMAIL_REJECTED',
    );
  }

  private async reconcile(invitation: InvitationRow, recipient: string) {
    const evidence = await this.probe.delivered({ recipient, since: invitation.createdAt });
    if (evidence !== 'DELIVERED') {
      if (invitation.state === 'INTENT') {
        await this.transition(invitation, {
          state: 'AMBIGUOUS',
          errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
        });
      }
      return null;
    }
    const sentAt = this.now();
    return this.transition(invitation, {
      state: 'SENT',
      sentAt,
      expiresAt: new Date(sentAt.getTime() + invitation.lifespanSeconds * 1000),
      errorCode: null,
    });
  }

  /** CAS on revision — whoever moves first wins = REVISION_CONFLICT */
  private async transition(
    invitation: InvitationRow,
    data: Prisma.PfInvitationUpdateManyMutationInput,
    client: Prisma.TransactionClient | PrismaClient = this.platform,
  ): Promise<InvitationRow> {
    const updated = await client.pfInvitation.updateMany({
      where: { id: invitation.id, revision: invitation.revision },
      data: { ...data, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
    return client.pfInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
  }

  // ── Operator actions ──────────────────────────────────────────────────────

  /**
   * Resend invitation (#392): supersede the latest generation and create a new one in one transaction
   * cap of 3 per hour enforced at the trigger (advisory lock per request) — a rejection is audited too
   */
  async resend(command: {
    requestId: string;
    reasonCode: string;
    comment: string;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<InvitationStatus> {
    if (command.actor.kind !== 'PLATFORM_OPERATOR') {
      throw new PlatformProvisioningError('RECOVERY_PRECONDITION_FAILED');
    }
    if (
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(command.reasonCode) ||
      !command.comment.trim() ||
      command.comment.length > 500
    ) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', {
        ...(/^[A-Z][A-Z0-9_]{2,63}$/.test(command.reasonCode) ? {} : { reasonCode: 'INVALID' }),
        ...(command.comment.trim() && command.comment.length <= 500 ? {} : { comment: 'INVALID' }),
      });
    }
    const request = /^[0-9a-f-]{36}$/i.test(command.requestId)
      ? await this.platform.pfProvisioningRequest.findUnique({
          where: { id: command.requestId },
          include: { steps: true },
        })
      : null;
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    const audit = (
      client: Prisma.TransactionClient | PrismaClient,
      entry: { outcome: 'SUCCEEDED' | 'REJECTED'; errorCode?: string; attempt?: number },
    ) =>
      appendPlatformAction(client, this.id(), {
        tenantId: request.tenantId,
        requestId: request.id,
        action: 'RESEND_INVITATION',
        actor: command.actor,
        correlationId: command.correlationId,
        reasonCode: command.reasonCode,
        comment: command.comment,
        stepKey: 'INVITATION',
        at: this.now(),
        ...entry,
      });

    const latest = await this.latest(request.id);
    const context = provisioningStepContext(request, 'INVITATION', 0);
    const user = latest ? await this.firstAdmin.user(context) : undefined;
    const precondition = !latest
      ? 'INVITATION_NOT_STARTED'
      : !user || user.id !== latest.keycloakUserId
        ? 'FIRST_ADMIN_MISSING'
        : activated(user)
          ? 'ALREADY_ACTIVATED'
          : null;
    if (precondition) {
      await audit(this.platform, { outcome: 'REJECTED', errorCode: precondition });
      throw new PlatformProvisioningError('RECOVERY_PRECONDITION_FAILED');
    }

    // the latest generation in flight (INTENT younger than 2 minutes) must not be replaced — otherwise an email already sent
    // could not record its outcome and would eat the resend quota; an INTENT stuck longer than that is treated as the previous attempt crashing
    if (
      latest!.state === 'INTENT' &&
      this.now().getTime() - latest!.updatedAt.getTime() < INTENT_IN_FLIGHT_MS
    ) {
      await audit(this.platform, { outcome: 'REJECTED', errorCode: 'REVISION_CONFLICT' });
      throw new PlatformProvisioningError('REVISION_CONFLICT');
    }

    let created: InvitationRow;
    try {
      created = await this.platform.$transaction(async (transaction) => {
        await this.transition(latest!, { supersededAt: this.now() }, transaction);
        return transaction.pfInvitation.create({
          data: {
            id: this.id(),
            requestId: request.id,
            tenantId: request.tenantId,
            generation: latest!.generation + 1,
            keycloakUserId: latest!.keycloakUserId,
            recipientHash: latest!.recipientHash,
            lifespanSeconds: INVITATION_LIMITS.lifespanSeconds,
            requestedByKind: 'PLATFORM_OPERATOR',
            requestedBy: command.actor.subject,
            reasonCode: command.reasonCode,
            createdAt: this.now(),
          },
        });
      });
    } catch (error) {
      if (String(error).includes('PF_INVITATION_RESEND_LIMIT')) {
        await audit(this.platform, { outcome: 'REJECTED', errorCode: 'INVITATION_RESEND_LIMITED' });
        throw new PlatformProvisioningError('INVITATION_RESEND_LIMITED');
      }
      if (
        error instanceof PlatformProvisioningError ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      ) {
        // another operator resent before us (generation clash or revision changed)
        await audit(this.platform, { outcome: 'REJECTED', errorCode: 'REVISION_CONFLICT' });
        throw new PlatformProvisioningError('REVISION_CONFLICT');
      }
      throw error;
    }

    try {
      // #436: the previous generation's link must stop working before the new one is sent (the invitation guard in Keycloak checks iat)
      await this.supersedeLinks(created).catch(async (error: unknown) => {
        await this.transition(created, {
          state: 'FAILED',
          errorCode: 'INVITATION_GUARD_UPDATE_FAILED',
        });
        throw error instanceof ProvisioningStepError
          ? error
          : new ProvisioningStepError('TRANSIENT', 'INVITATION_GUARD_UPDATE_FAILED');
      });
      await this.send(created);
      await audit(this.platform, { outcome: 'SUCCEEDED', attempt: created.generation });
    } catch (error) {
      await audit(this.platform, {
        outcome: 'REJECTED',
        attempt: created.generation,
        errorCode: error instanceof ProvisioningStepError ? error.code : 'DELIVERY_OUTCOME_UNKNOWN',
      });
      throw error;
    }
    return this.status(request.id);
  }

  /**
   * sets `dc_invitation_not_before` on the Keycloak user — the guard rejects links whose `iat` is older than this
   * Keycloak PUT replaces the whole attributes set, so read the existing ones and merge first
   */
  private async supersedeLinks(invitation: InvitationRow) {
    const path = `/users/${encodeURIComponent(invitation.keycloakUserId)}`;
    const { body: user } = await this.keycloak.admin<{ attributes?: Record<string, string[]> }>(
      'GET',
      path,
    );
    // the token iat is in seconds: use "the next second" and wait for it before sending the new generation — every old link has an
    // iat that is always less, and the new link has iat ≥ not-before always (waits at most 1 second)
    const notBefore = Math.floor(Date.now() / 1000) + 1;
    await this.keycloak.admin('PUT', path, {
      body: {
        ...user,
        attributes: { ...(user.attributes ?? {}), dc_invitation_not_before: [String(notBefore)] },
      },
    });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, notBefore * 1000 - Date.now() + 20)),
    );
  }

  /** delivery and activation are separate (#392) — returns no email or token */
  async status(requestId: string): Promise<InvitationStatus> {
    const now = this.now();
    const request = await this.platform.pfProvisioningRequest.findUnique({
      where: { id: requestId },
      include: { steps: true },
    });
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    const latest = await this.latest(requestId);
    const resendsInLastHour = await this.platform.pfInvitation.count({
      where: {
        requestId,
        generation: { gt: 1 },
        createdAt: { gt: new Date(now.getTime() - 3600_000) },
      },
    });
    let activation: InvitationStatus['activation'] = 'UNKNOWN';
    if (latest) {
      const user = await this.firstAdmin
        .user(provisioningStepContext(request, 'INVITATION', 0))
        .catch(() => undefined);
      if (user?.id === latest.keycloakUserId) {
        activation = activated(user) ? 'ACTIVATED' : 'PENDING_ACTIVATION';
      }
    }
    return {
      generation: latest?.generation ?? null,
      delivery: latest?.state ?? 'NOT_STARTED',
      expired: Boolean(latest?.expiresAt && latest.expiresAt <= now && activation !== 'ACTIVATED'),
      activation,
      expiresAt: latest?.expiresAt ?? null,
      resendsInLastHour,
    };
  }
}

function activated(user: { emailVerified?: boolean; requiredActions?: string[] }) {
  return user.emailVerified === true && (user.requiredActions ?? []).length === 0;
}
