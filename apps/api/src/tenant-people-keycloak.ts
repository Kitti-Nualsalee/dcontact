import type {
  PeopleStepOutcome,
  PeopleWorkerClaim,
  TenantPeopleIdentityPort,
} from './tenant-people-worker.js';

export class TenantPeopleKeycloak implements TenantPeopleIdentityPort {
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
      !/^\/realms\/[A-Za-z0-9._-]+\/?$/.test(issuer.pathname) ||
      (issuer.protocol !== 'https:' &&
        !(issuer.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(issuer.hostname))) ||
      configuration.clientId !== `dcontact-tenant-people-${configuration.tenantId}` ||
      !configuration.clientSecret
    )
      throw new Error('INVALID_PEOPLE_IDENTITY_CONFIGURATION');
    this.issuer = issuer.href.replace(/\/$/, '');
  }

  mutateStep(claim: PeopleWorkerClaim): Promise<PeopleStepOutcome> {
    if (claim.reconcileOnly) throw new Error('PEOPLE_RECONCILIATION_REQUIRES_READ');
    return this.execute(claim, true);
  }

  readOutcome(claim: PeopleWorkerClaim): Promise<PeopleStepOutcome> {
    return this.execute(claim, false);
  }

  async isReady(tenantId = this.configuration.tenantId): Promise<boolean> {
    if (tenantId !== this.configuration.tenantId) return false;
    try {
      const options = { redirect: 'error' as const, cache: 'no-store' as const };
      const tokenResponse = await this.request(`${this.issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        ...options,
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.configuration.clientId,
          client_secret: this.configuration.clientSecret,
        }),
      });
      if (!tokenResponse.ok) return false;
      const token: unknown = await tokenResponse.json();
      if (
        !token ||
        typeof token !== 'object' ||
        !('access_token' in token) ||
        typeof token.access_token !== 'string' ||
        !token.access_token
      )
        return false;
      const endpoint = new URL(`${this.issuer}/dc-tenant-people/readiness`);
      endpoint.searchParams.set('tenantId', this.configuration.tenantId);
      const response = await this.request(endpoint, {
        method: 'GET',
        ...options,
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!response.ok) return false;
      const result: unknown = await response.json();
      return (
        !!result &&
        typeof result === 'object' &&
        'ready' in result &&
        result.ready === true &&
        'version' in result &&
        result.version === 1 &&
        'tenantId' in result &&
        result.tenantId === this.configuration.tenantId
      );
    } catch {
      return false;
    }
  }

  private async execute(claim: PeopleWorkerClaim, mutation: boolean): Promise<PeopleStepOutcome> {
    if (
      claim.tenantId !== this.configuration.tenantId ||
      ![
        'CREATE_IDENTITY',
        'TENANT_ROLE',
        'ORG_MEMBERSHIP',
        'VERIFY_MAPPING',
        'VERIFY_PROVISIONED',
      ].includes(claim.step)
    )
      throw new Error('PEOPLE_IDENTITY_SCOPE_MISMATCH');
    const options = {
      redirect: 'error' as const,
      cache: 'no-store' as const,
      signal: AbortSignal.timeout(10_000),
    };
    const tokenResponse = await this.request(`${this.issuer}/protocol/openid-connect/token`, {
      ...options,
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.configuration.clientId,
        client_secret: this.configuration.clientSecret,
      }),
    });
    if (!tokenResponse.ok) return { outcome: 'UNKNOWN' };
    const token: unknown = await tokenResponse.json();
    if (
      !token ||
      typeof token !== 'object' ||
      !('access_token' in token) ||
      typeof token.access_token !== 'string' ||
      !token.access_token
    )
      return { outcome: 'UNKNOWN' };
    const endpoint = new URL(
      `${this.issuer}/dc-tenant-people/operations/${encodeURIComponent(claim.operationId)}/steps/${claim.step}`,
    );
    const correlation = {
      tenantId: claim.tenantId,
      targetUserId: claim.userId,
      payloadDigest: claim.payloadDigest,
    };
    if (!mutation) endpoint.search = new URLSearchParams(correlation).toString();
    const response = await this.request(endpoint, {
      ...options,
      signal: AbortSignal.timeout(10_000),
      method: mutation ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        ...(mutation ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(mutation
        ? {
            body: JSON.stringify({
              ...correlation,
              fencingToken: claim.fencingToken,
              email: claim.command.email,
              displayName: claim.command.displayName,
              role: claim.command.role,
            }),
          }
        : {}),
    });
    if (!response.ok) return { outcome: 'UNKNOWN' };
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== 'object' ||
      !('outcome' in result) ||
      !('receiptRef' in result) ||
      typeof result.receiptRef !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.receiptRef)
    )
      return { outcome: 'UNKNOWN' };
    if (
      result.outcome === 'SUCCEEDED' &&
      'identityId' in result &&
      result.identityId === claim.userId
    )
      return {
        outcome: 'SUCCEEDED',
        receiptRef: result.receiptRef,
        ...(['VERIFY_MAPPING', 'VERIFY_PROVISIONED'].includes(claim.step)
          ? { identityId: result.identityId }
          : {}),
      };
    if (result.outcome === 'REJECTED_NO_EFFECT')
      return { outcome: 'REJECTED_NO_EFFECT', receiptRef: result.receiptRef };
    return { outcome: 'UNKNOWN' };
  }
}
