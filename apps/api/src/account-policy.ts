/**
 * Owner: IAM — the tenant account policy (AC1 #594, Phase Contract #589, ADR-033)
 *
 * - editing a user's email: `VERIFY` (default) | `IMMEDIATE` | `ADMIN_ONLY`; 2FA enforcement: off by default
 * - no row = the defaults and `revision` = 0 — the first row is created when an admin first edits
 * - every change needs a reason of 3–500 characters and writes a before/after audit in the same transaction
 * - changing `mfaRequired` must sync to the Keycloak Organization (`dc_mfa_required`) through the AC2 port
 *   inside the transaction — sync fails = not saved; no port yet = rejected (`MFA_ENFORCEMENT_UNAVAILABLE`)
 *   rather than saving a value the identity system does not actually enforce yet
 * - 2FA enforcement takes effect at the next login and does not cut a session in use (#589 D10, ADR-026)
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export const EMAIL_CHANGE_POLICIES = ['VERIFY', 'IMMEDIATE', 'ADMIN_ONLY'] as const;
export type EmailChangePolicy = (typeof EMAIL_CHANGE_POLICIES)[number];

export interface AccountPolicy {
  emailChange: EmailChangePolicy;
  mfaRequired: boolean;
}

export const DEFAULT_ACCOUNT_POLICY: Readonly<AccountPolicy> = Object.freeze({
  emailChange: 'VERIFY',
  mfaRequired: false,
});

export interface AccountPolicyView extends AccountPolicy {
  /** 0 = never set (uses the defaults) */
  revision: number;
  updatedAt: string | null;
}

export type AccountPolicyErrorCode =
  | 'VALIDATION_FAILED'
  | 'REVISION_CONFLICT'
  | 'MFA_ENFORCEMENT_UNAVAILABLE'
  /** the identity system does not answer or rejects the sync — the system name is not revealed to the user (#589) */
  | 'IDENTITY_UNAVAILABLE';

export class AccountPolicyError extends Error {
  constructor(
    readonly code: AccountPolicyErrorCode,
    readonly field?: { field: string; reason: 'REQUIRED' | 'INVALID' },
  ) {
    super(code);
    this.name = 'AccountPolicyError';
  }
}

/**
 * syncs 2FA enforcement to the tenant's Organization in Keycloak — implemented in AC2 (#595):
 * `KeycloakOrganizationMfa` (keycloak-account-service.ts) through the `dc-account` extension
 * must be idempotent: calling again with the same value gives the same result; failure = throw `AccountPolicyError('IDENTITY_UNAVAILABLE')`
 */
export interface OrganizationMfaPort {
  setMfaRequired(tenantId: string, required: boolean): Promise<void>;
}

export interface AccountPolicyActor {
  tenantId: string;
  userId: string;
}

export interface AccountPolicyOptions {
  now?: () => Date;
  mfa?: OrganizationMfaPort;
}

type Tx = Prisma.TransactionClient;

/** reads the policy inside the tenant transaction — shared with the self-service API (AC4) */
export async function readAccountPolicy(tx: Tx, tenantId: string): Promise<AccountPolicyView> {
  const row = await tx.tenantAccountPolicy.findUnique({ where: { tenantId } });
  if (!row) return { ...DEFAULT_ACCOUNT_POLICY, revision: 0, updatedAt: null };
  return {
    emailChange: emailChangeOf(row.emailChangePolicy),
    mfaRequired: row.mfaRequired,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AccountPolicyService {
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly options: AccountPolicyOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  get(actor: AccountPolicyActor): Promise<AccountPolicyView> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, (tx) =>
      readAccountPolicy(tx, actor.tenantId),
    );
  }

  async update(
    actor: AccountPolicyActor,
    input: {
      emailChange?: unknown;
      mfaRequired?: unknown;
      reason?: unknown;
      expectedRevision?: unknown;
    },
    correlationId: string,
  ): Promise<AccountPolicyView> {
    const expectedRevision = revisionOf(input.expectedRevision);
    const reason = reasonOf(input.reason);
    if (input.emailChange === undefined && input.mfaRequired === undefined) {
      throw new AccountPolicyError('VALIDATION_FAILED', { field: 'body', reason: 'REQUIRED' });
    }
    const emailChange =
      input.emailChange === undefined ? undefined : requiredEmailChange(input.emailChange);
    if (input.mfaRequired !== undefined && typeof input.mfaRequired !== 'boolean') {
      throw new AccountPolicyError('VALIDATION_FAILED', {
        field: 'mfaRequired',
        reason: 'INVALID',
      });
    }
    const mfaRequired = input.mfaRequired as boolean | undefined;

    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      // the first row does not exist to lock yet — lock per tenant instead (two admins editing at once = the later gets REVISION_CONFLICT)
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`tenant_account_policies:${actor.tenantId}`}))`,
      );
      const before = await readAccountPolicy(tx, actor.tenantId);
      if (before.revision !== expectedRevision) throw new AccountPolicyError('REVISION_CONFLICT');

      const next: AccountPolicy = {
        emailChange: emailChange ?? before.emailChange,
        mfaRequired: mfaRequired ?? before.mfaRequired,
      };
      // nothing changed = no row or audit written and no revision increase (resending gets the same result)
      if (next.emailChange === before.emailChange && next.mfaRequired === before.mfaRequired) {
        return before;
      }

      const now = this.now();
      const row = await tx.tenantAccountPolicy.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          emailChangePolicy: next.emailChange,
          mfaRequired: next.mfaRequired,
          revision: 1,
          updatedBy: actor.userId,
          updatedAt: now,
        },
        update: {
          emailChangePolicy: next.emailChange,
          mfaRequired: next.mfaRequired,
          revision: { increment: 1 },
          updatedBy: actor.userId,
          updatedAt: now,
        },
      });
      await tx.tenantAccountPolicyAuditEvent.create({
        data: {
          id: randomUUID(),
          tenantId: actor.tenantId,
          before: { emailChange: before.emailChange, mfaRequired: before.mfaRequired },
          after: { ...next },
          actorUserId: actor.userId,
          reason,
          correlationId,
          occurredAt: now,
        },
      });
      // sync is the final step before commit — if it fails the transaction is cancelled and no policy that cannot really be enforced is left behind
      if (next.mfaRequired !== before.mfaRequired) {
        if (!this.options.mfa) throw new AccountPolicyError('MFA_ENFORCEMENT_UNAVAILABLE');
        await this.options.mfa.setMfaRequired(actor.tenantId, next.mfaRequired);
      }
      return {
        ...next,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }
}

function emailChangeOf(value: string): EmailChangePolicy {
  return (EMAIL_CHANGE_POLICIES as readonly string[]).includes(value)
    ? (value as EmailChangePolicy)
    : DEFAULT_ACCOUNT_POLICY.emailChange;
}

function requiredEmailChange(value: unknown): EmailChangePolicy {
  if (typeof value === 'string' && (EMAIL_CHANGE_POLICIES as readonly string[]).includes(value)) {
    return value as EmailChangePolicy;
  }
  throw new AccountPolicyError('VALIDATION_FAILED', { field: 'emailChange', reason: 'INVALID' });
}

function reasonOf(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    throw new AccountPolicyError('VALIDATION_FAILED', { field: 'reason', reason: 'REQUIRED' });
  }
  if (typeof value !== 'string') {
    throw new AccountPolicyError('VALIDATION_FAILED', { field: 'reason', reason: 'INVALID' });
  }
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new AccountPolicyError('VALIDATION_FAILED', { field: 'reason', reason: 'INVALID' });
  }
  return reason;
}

function revisionOf(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new AccountPolicyError('VALIDATION_FAILED', {
    field: 'expectedRevision',
    reason: value === undefined ? 'REQUIRED' : 'INVALID',
  });
}
