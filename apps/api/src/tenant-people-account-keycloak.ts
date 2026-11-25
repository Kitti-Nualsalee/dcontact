import { createHash } from 'node:crypto';

/**
 * #998 1B/2: the client of `dc-tenant-people/account/{step}` (ADR-035) for UPDATE_PROFILE and ENABLE_ACCOUNT
 * the same way as TenantPeopleDisableKeycloak: every answer that does not match the contract exactly counts as UNKNOWN and no mutation is resent after attempted
 */
export type PeopleAccountStep = 'UPDATE_PROFILE' | 'ENABLE_ACCOUNT';

export interface PeopleAccountAttempt {
  step: PeopleAccountStep;
  tenantId: string;
  operationId: string;
  userId: string;
  identityId: string;
  payloadDigest: string;
  fencingToken: string;
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN';
  /** required only for UPDATE_PROFILE */
  displayName: string | null;
  reconcileOnly: boolean;
}

export type PeopleAccountRejection =
  'PROTECTED_OR_FOREIGN_IDENTITY' | 'IDENTITY_STATE_CONFLICT' | 'CREDENTIALS_NOT_READY';

export type PeopleAccountOutcome =
  | { outcome: 'UNKNOWN' }
  | {
      outcome: 'SUCCEEDED';
      receiptRef: string;
      reasonCode: 'PROFILE_UPDATED' | 'ENABLED';
      identityId: string;
    }
  | {
      outcome: 'REJECTED_NO_EFFECT';
      receiptRef: string;
      reasonCode: PeopleAccountRejection;
      identityId: string;
    };

export type PeopleAccountProbe =
  { outcome: 'READY' | 'UNKNOWN' } | { outcome: 'REJECTED'; reasonCode: PeopleAccountRejection };

export interface TenantPeopleAccountPort {
  probe(attempt: PeopleAccountAttempt): Promise<PeopleAccountProbe>;
  mutate(attempt: PeopleAccountAttempt): Promise<PeopleAccountOutcome>;
  readOutcome(attempt: PeopleAccountAttempt): Promise<PeopleAccountOutcome>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rejections: readonly string[] = [
  'PROTECTED_OR_FOREIGN_IDENTITY',
  'IDENTITY_STATE_CONFLICT',
  'CREDENTIALS_NOT_READY',
];

function validDisplayName(value: string) {
  const length = [...value].length;
  return (
    length >= 1 &&
    length <= 120 &&
    !/[\p{Cc}\p{Cf}]/u.test(value) &&
    value === value.trim().replace(/\s+/gu, ' ')
  );
}

function exactKeys(fields: Record<string, unknown>, expected: readonly string[]) {
  return (
    Object.keys(fields).length === expected.length &&
    Object.keys(fields).every((key) => expected.includes(key))
  );
}

export class TenantPeopleAccountKeycloak implements TenantPeopleAccountPort {
  private readonly issuer: string;

  constructor(
    private readonly configuration: {
      issuer: string;
      tenantId: string;
      clientId: string;
      clientSecret: string;
    },
    private readonly request: typeof fetch = fetch,
  ) {
    const issuer = new URL(configuration.issuer);
    if (
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      !/^\/(?:auth\/)?realms\/[A-Za-z0-9._-]+\/?$/.test(issuer.pathname) ||
      (issuer.protocol !== 'https:' &&
        !(issuer.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(issuer.hostname))) ||
      !uuid.test(configuration.tenantId) ||
      configuration.clientId !== `dcontact-tenant-people-${configuration.tenantId}` ||
      !configuration.clientSecret
    )
      throw new Error('INVALID_PEOPLE_ACCOUNT_CONFIGURATION');
    this.issuer = issuer.href.replace(/\/$/, '');
  }

  mutate(attempt: PeopleAccountAttempt) {
    if (attempt.reconcileOnly) throw new Error('PEOPLE_ACCOUNT_RECONCILIATION_REQUIRES_READ');
    return this.execute(attempt, 'mutate');
  }

  readOutcome(attempt: PeopleAccountAttempt) {
    return this.execute(attempt, 'read');
  }

  probe(attempt: PeopleAccountAttempt) {
    return this.execute(attempt, 'check');
  }

  private execute(attempt: PeopleAccountAttempt, mode: 'check'): Promise<PeopleAccountProbe>;
  private execute(
    attempt: PeopleAccountAttempt,
    mode: 'mutate' | 'read',
  ): Promise<PeopleAccountOutcome>;

  private async execute(
    attempt: PeopleAccountAttempt,
    mode: 'check' | 'mutate' | 'read',
  ): Promise<PeopleAccountOutcome | PeopleAccountProbe> {
    if (
      !['UPDATE_PROFILE', 'ENABLE_ACCOUNT'].includes(attempt.step) ||
      attempt.tenantId !== this.configuration.tenantId ||
      ![attempt.operationId, attempt.userId, attempt.identityId].every((value) =>
        uuid.test(value),
      ) ||
      !/^[a-f0-9]{64}$/.test(attempt.payloadDigest) ||
      !/^[1-9][0-9]{0,18}$/.test(attempt.fencingToken) ||
      BigInt(attempt.fencingToken) > 9223372036854775807n ||
      !['AGENT', 'SUPERVISOR', 'ADMIN'].includes(attempt.role) ||
      (attempt.step === 'UPDATE_PROFILE'
        ? typeof attempt.displayName !== 'string' || !validDisplayName(attempt.displayName)
        : attempt.displayName !== null)
    )
      throw new Error('PEOPLE_ACCOUNT_SCOPE_MISMATCH');
    try {
      const options = { redirect: 'error' as const, cache: 'no-store' as const };
      const credentials = await this.request(`${this.issuer}/protocol/openid-connect/token`, {
        ...options,
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.configuration.clientId,
          client_secret: this.configuration.clientSecret,
        }),
      });
      if (!credentials.ok) return { outcome: 'UNKNOWN' };
      const token: unknown = await credentials.json();
      if (
        !token ||
        typeof token !== 'object' ||
        !('access_token' in token) ||
        typeof token.access_token !== 'string' ||
        !token.access_token
      )
        return { outcome: 'UNKNOWN' };
      const endpoint = new URL(
        `${this.issuer}/dc-tenant-people/account/${attempt.step}/${mode === 'check' ? 'check' : attempt.operationId}`,
      );
      const correlation: Record<string, string> = {
        tenantId: attempt.tenantId,
        targetUserId: attempt.userId,
        identityId: attempt.identityId,
        payloadDigest: attempt.payloadDigest,
        role: attempt.role,
        ...(attempt.displayName === null ? {} : { displayName: attempt.displayName }),
      };
      // the real name is not in the URL (access log/tracing): GET sends only the SHA-256 of the name, which the descriptor already binds
      if (mode === 'read') {
        const { displayName, ...query } = correlation;
        endpoint.search = new URLSearchParams({
          ...query,
          ...(displayName === undefined
            ? {}
            : {
                displayNameDigest: createHash('sha256').update(displayName, 'utf8').digest('hex'),
              }),
        }).toString();
      }
      const response = await this.request(endpoint, {
        ...options,
        method: mode === 'read' ? 'GET' : 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          ...(mode === 'read' ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(mode === 'read'
          ? {}
          : { body: JSON.stringify({ ...correlation, fencingToken: attempt.fencingToken }) }),
      });
      if (!response.ok) return { outcome: 'UNKNOWN' };
      const proof: unknown = await response.json();
      if (!proof || typeof proof !== 'object' || Array.isArray(proof))
        return { outcome: 'UNKNOWN' };
      const fields = Object.fromEntries(Object.entries(proof));
      if (mode === 'check') {
        if (
          !exactKeys(fields, [
            'version',
            'outcome',
            'reasonCode',
            'tenantId',
            'userId',
            'identityId',
            'payloadDigest',
          ]) ||
          fields.version !== 1 ||
          fields.tenantId !== attempt.tenantId ||
          fields.userId !== attempt.userId ||
          fields.identityId !== attempt.identityId ||
          fields.payloadDigest !== attempt.payloadDigest
        )
          return { outcome: 'UNKNOWN' };
        if (fields.outcome === 'READY' && fields.reasonCode === 'READY')
          return { outcome: 'READY' };
        if (
          fields.outcome === 'REJECTED' &&
          typeof fields.reasonCode === 'string' &&
          rejections.includes(fields.reasonCode)
        )
          return {
            outcome: 'REJECTED',
            reasonCode: fields.reasonCode as PeopleAccountRejection,
          };
        return { outcome: 'UNKNOWN' };
      }
      if (
        !exactKeys(fields, [
          'version',
          'outcome',
          'receiptRef',
          'reasonCode',
          'tenantId',
          'operationId',
          'userId',
          'payloadDigest',
          'identityId',
        ]) ||
        fields.version !== 1 ||
        fields.tenantId !== attempt.tenantId ||
        fields.operationId !== attempt.operationId ||
        fields.userId !== attempt.userId ||
        fields.payloadDigest !== attempt.payloadDigest ||
        fields.identityId !== attempt.identityId ||
        typeof fields.receiptRef !== 'string' ||
        !/^[a-f0-9]{64}$/.test(fields.receiptRef)
      )
        return { outcome: 'UNKNOWN' };
      const success = attempt.step === 'UPDATE_PROFILE' ? 'PROFILE_UPDATED' : 'ENABLED';
      if (fields.outcome === 'SUCCEEDED' && fields.reasonCode === success)
        return {
          outcome: 'SUCCEEDED',
          reasonCode: success,
          receiptRef: fields.receiptRef,
          identityId: attempt.identityId,
        };
      if (
        fields.outcome === 'REJECTED_NO_EFFECT' &&
        typeof fields.reasonCode === 'string' &&
        rejections.includes(fields.reasonCode) &&
        // credentials are unrelated to renaming
        !(attempt.step === 'UPDATE_PROFILE' && fields.reasonCode === 'CREDENTIALS_NOT_READY')
      )
        return {
          outcome: 'REJECTED_NO_EFFECT',
          reasonCode: fields.reasonCode as PeopleAccountRejection,
          receiptRef: fields.receiptRef,
          identityId: attempt.identityId,
        };
      return { outcome: 'UNKNOWN' };
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }
}
