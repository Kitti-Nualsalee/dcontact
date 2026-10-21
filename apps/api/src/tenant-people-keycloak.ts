import type {
  PeopleStepOutcome,
  PeopleWorkerClaim,
  TenantPeopleIdentityPort,
} from './tenant-people-worker.js';
import type {
  PeopleInvitationAttempt,
  PeopleInvitationOutcome,
  TenantPeopleInvitationRuntimePort,
} from './tenant-people-invitation-worker.js';

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

  invitationPort(): TenantPeopleInvitationRuntimePort {
    return {
      isReady: (tenantId) => this.readReadiness(tenantId, true),
      dispatch: (attempt) => this.executeInvitation(attempt, true),
      readOutcome: (attempt) => this.executeInvitation(attempt, false),
    };
  }

  private async executeInvitation(
    attempt: PeopleInvitationAttempt,
    mutation: boolean,
  ): Promise<PeopleInvitationOutcome> {
    if (
      attempt.tenantId !== this.configuration.tenantId ||
      !Number.isInteger(attempt.generation) ||
      attempt.generation < 1 ||
      attempt.generation > 2147483647
    )
      throw new Error('PEOPLE_INVITATION_SCOPE_MISMATCH');
    if (mutation && attempt.generation !== 1)
      throw new Error('PEOPLE_INVITATION_GENERATION_NOT_READY');
    const options = { redirect: 'error' as const, cache: 'no-store' as const };
    const tokenResponse = await this.request(`${this.issuer}/protocol/openid-connect/token`, {
      ...options,
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
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
      `${this.issuer}/dc-tenant-people/operations/${encodeURIComponent(attempt.operationId)}/invitations/${attempt.generation}/dispatch`,
    );
    const correlation = {
      tenantId: attempt.tenantId,
      targetUserId: attempt.userId,
      payloadDigest: attempt.payloadDigest,
      providerAttemptRef: attempt.providerAttemptRef,
      fencingToken: attempt.fencingToken,
      leaseOwner: attempt.leaseOwner,
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
              email: attempt.command.email,
              displayName: attempt.command.displayName,
              role: attempt.command.role,
            }),
          }
        : {}),
    });
    if (!response.ok) return { outcome: 'UNKNOWN' };
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { outcome: 'UNKNOWN' };
    const proof: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
    const fields = [
      'outcome',
      'receiptRef',
      'quiescent',
      'tenantId',
      'operationId',
      'userId',
      'generation',
      'providerAttemptRef',
      'payloadDigest',
      'fencingToken',
      'leaseOwner',
      'notBeforeEpoch',
      'issuedAtEpoch',
    ];
    if (
      Object.keys(proof).length !== fields.length ||
      Object.keys(proof).some((field) => !fields.includes(field)) ||
      proof.outcome !== 'SENT' ||
      proof.quiescent !== true ||
      proof.tenantId !== attempt.tenantId ||
      proof.operationId !== attempt.operationId ||
      proof.userId !== attempt.userId ||
      proof.generation !== attempt.generation ||
      proof.providerAttemptRef !== attempt.providerAttemptRef ||
      proof.payloadDigest !== attempt.payloadDigest ||
      proof.fencingToken !== attempt.fencingToken ||
      proof.leaseOwner !== attempt.leaseOwner ||
      typeof proof.receiptRef !== 'string' ||
      !/^[a-f0-9]{64}$/.test(proof.receiptRef) ||
      typeof proof.notBeforeEpoch !== 'number' ||
      !Number.isSafeInteger(proof.notBeforeEpoch) ||
      proof.notBeforeEpoch <= 0 ||
      typeof proof.issuedAtEpoch !== 'number' ||
      !Number.isSafeInteger(proof.issuedAtEpoch) ||
      proof.issuedAtEpoch < proof.notBeforeEpoch ||
      proof.issuedAtEpoch > 253402041599
    )
      return { outcome: 'UNKNOWN' };
    return {
      outcome: 'SENT',
      tenantId: attempt.tenantId,
      operationId: attempt.operationId,
      userId: attempt.userId,
      generation: attempt.generation,
      providerAttemptRef: attempt.providerAttemptRef,
      payloadDigest: attempt.payloadDigest,
      fencingToken: attempt.fencingToken,
      leaseOwner: attempt.leaseOwner,
      receiptRef: proof.receiptRef,
      quiescent: true,
      notBeforeEpoch: proof.notBeforeEpoch,
      issuedAtEpoch: proof.issuedAtEpoch,
    };
  }

  async isReady(tenantId = this.configuration.tenantId): Promise<boolean> {
    return this.readReadiness(tenantId, false);
  }

  private async readReadiness(tenantId: string, invitation: boolean): Promise<boolean> {
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
        result.tenantId === this.configuration.tenantId &&
        (!invitation || ('invitationReady' in result && result.invitationReady === true))
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
    if (!response.ok) {
      if (response.status === 409) {
        const conflict: unknown = await response.json();
        if (
          conflict &&
          typeof conflict === 'object' &&
          'code' in conflict &&
          (conflict.code === 'CORRELATION_CONFLICT' ||
            conflict.code === 'IDENTITY_MAPPING_CONFLICT')
        )
          return { outcome: 'UNKNOWN', reasonCode: conflict.code };
      }
      return { outcome: 'UNKNOWN' };
    }
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
    if (
      result.outcome === 'SUCCEEDED' &&
      'identityId' in result &&
      result.identityId !== claim.userId
    )
      return { outcome: 'UNKNOWN', reasonCode: 'IDENTITY_MAPPING_CONFLICT' };
    return { outcome: 'UNKNOWN' };
  }
}
