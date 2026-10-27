export interface PeopleDisableAttempt {
  tenantId: string;
  operationId: string;
  userId: string;
  identityId: string;
  payloadDigest: string;
  fencingToken: string;
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN';
  adminCandidates: readonly { userId: string; identityId: string }[];
  reconcileOnly: boolean;
}

export type PeopleDisableOutcome =
  | { outcome: 'UNKNOWN' }
  | {
      outcome: 'SUCCEEDED' | 'REJECTED_NO_EFFECT';
      receiptRef: string;
      reasonCode:
        | 'DISABLED'
        | 'LAST_USABLE_ADMIN'
        | 'PROTECTED_OR_FOREIGN_IDENTITY'
        | 'IDENTITY_STATE_CONFLICT';
      identityId: string;
    };

export interface TenantPeopleDisablePort {
  probe(attempt: PeopleDisableAttempt): Promise<PeopleDisableProbe>;
  disable(attempt: PeopleDisableAttempt): Promise<PeopleDisableOutcome>;
  readOutcome(attempt: PeopleDisableAttempt): Promise<PeopleDisableOutcome>;
}

export type PeopleDisableProbe =
  | { outcome: 'READY' | 'UNKNOWN' }
  | {
      outcome: 'REJECTED';
      reasonCode: 'LAST_USABLE_ADMIN' | 'PROTECTED_OR_FOREIGN_IDENTITY' | 'IDENTITY_STATE_CONFLICT';
    };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class TenantPeopleDisableKeycloak implements TenantPeopleDisablePort {
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
      throw new Error('INVALID_PEOPLE_DISABLE_CONFIGURATION');
    this.issuer = issuer.href.replace(/\/$/, '');
  }

  disable(attempt: PeopleDisableAttempt) {
    if (attempt.reconcileOnly) throw new Error('PEOPLE_DISABLE_RECONCILIATION_REQUIRES_READ');
    return this.execute(attempt, true);
  }

  readOutcome(attempt: PeopleDisableAttempt) {
    return this.execute(attempt, false);
  }

  probe(attempt: PeopleDisableAttempt) {
    return this.execute(attempt, true, true);
  }

  private execute(
    attempt: PeopleDisableAttempt,
    mutation: boolean,
    precheck: true,
  ): Promise<PeopleDisableProbe>;
  private execute(
    attempt: PeopleDisableAttempt,
    mutation: boolean,
    precheck?: false,
  ): Promise<PeopleDisableOutcome>;

  private async execute(
    attempt: PeopleDisableAttempt,
    mutation: boolean,
    precheck = false,
  ): Promise<PeopleDisableOutcome | PeopleDisableProbe> {
    if (
      attempt.tenantId !== this.configuration.tenantId ||
      ![attempt.operationId, attempt.userId, attempt.identityId].every((value) =>
        uuid.test(value),
      ) ||
      !/^[a-f0-9]{64}$/.test(attempt.payloadDigest) ||
      !/^[1-9][0-9]{0,18}$/.test(attempt.fencingToken) ||
      BigInt(attempt.fencingToken) > 9223372036854775807n ||
      !['AGENT', 'SUPERVISOR', 'ADMIN'].includes(attempt.role) ||
      attempt.adminCandidates.length > 1000 ||
      !attempt.adminCandidates.every(
        (candidate) => uuid.test(candidate.userId) && uuid.test(candidate.identityId),
      ) ||
      new Set(attempt.adminCandidates.map((candidate) => candidate.userId)).size !==
        attempt.adminCandidates.length ||
      new Set(attempt.adminCandidates.map((candidate) => candidate.identityId)).size !==
        attempt.adminCandidates.length
    )
      throw new Error('PEOPLE_DISABLE_SCOPE_MISMATCH');
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
        `${this.issuer}/dc-tenant-people/disable/${precheck ? 'check' : attempt.operationId}`,
      );
      const correlation = {
        tenantId: attempt.tenantId,
        targetUserId: attempt.userId,
        payloadDigest: attempt.payloadDigest,
      };
      if (!mutation) endpoint.search = new URLSearchParams(correlation).toString();
      const response = await this.request(endpoint, {
        ...options,
        method: mutation ? 'POST' : 'GET',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          ...(mutation ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(mutation
          ? {
              body: JSON.stringify({
                ...correlation,
                identityId: attempt.identityId,
                fencingToken: attempt.fencingToken,
                role: attempt.role,
                adminCandidates: attempt.adminCandidates
                  .map((candidate) => `${candidate.userId}:${candidate.identityId}`)
                  .sort()
                  .join(','),
              }),
            }
          : {}),
      });
      if (!response.ok) return { outcome: 'UNKNOWN' };
      const proof: unknown = await response.json();
      if (!proof || typeof proof !== 'object' || Array.isArray(proof))
        return { outcome: 'UNKNOWN' };
      const fields = Object.fromEntries(Object.entries(proof));
      if (precheck) {
        const expected = [
          'version',
          'outcome',
          'reasonCode',
          'tenantId',
          'userId',
          'identityId',
          'payloadDigest',
        ];
        if (
          Object.keys(fields).length !== expected.length ||
          Object.keys(fields).some((key) => !expected.includes(key)) ||
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
          (fields.reasonCode === 'LAST_USABLE_ADMIN' ||
            fields.reasonCode === 'PROTECTED_OR_FOREIGN_IDENTITY' ||
            fields.reasonCode === 'IDENTITY_STATE_CONFLICT')
        )
          return { outcome: 'REJECTED', reasonCode: fields.reasonCode };
        return { outcome: 'UNKNOWN' };
      }
      const allowed = [
        'version',
        'outcome',
        'receiptRef',
        'reasonCode',
        'tenantId',
        'operationId',
        'userId',
        'payloadDigest',
        'identityId',
      ];
      if (
        Object.keys(fields).length !== allowed.length ||
        Object.keys(fields).some((key) => !allowed.includes(key)) ||
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
      if (fields.outcome === 'SUCCEEDED' && fields.reasonCode === 'DISABLED')
        return {
          outcome: 'SUCCEEDED',
          reasonCode: 'DISABLED',
          receiptRef: fields.receiptRef,
          identityId: attempt.identityId,
        };
      if (
        fields.outcome === 'REJECTED_NO_EFFECT' &&
        (fields.reasonCode === 'LAST_USABLE_ADMIN' ||
          fields.reasonCode === 'PROTECTED_OR_FOREIGN_IDENTITY' ||
          fields.reasonCode === 'IDENTITY_STATE_CONFLICT')
      )
        return {
          outcome: 'REJECTED_NO_EFFECT',
          reasonCode: fields.reasonCode,
          receiptRef: fields.receiptRef,
          identityId: attempt.identityId,
        };
      return { outcome: 'UNKNOWN' };
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }
}
