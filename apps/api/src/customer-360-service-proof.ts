import {
  toVerifiedServiceIdentity,
  type OidcAccessTokenVerifier,
} from '@d-contact/workspace-session';

/** ข้อมูลจาก persisted binding เท่านั้น ไม่รับ context นี้จาก request body */
export interface C360ServiceProofContext {
  readonly tenantId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly clientId: string;
  readonly bindingId: string;
  readonly authzEpoch: string;
}

export interface C360ServiceOnlineProof {
  readonly checkStartedAt: number;
  readonly deadline: number;
}

export type C360ServiceScope = 'customer360.contacts.read' | 'customer360.contacts.create';

export class C360ServiceProofError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}

const fingerprint = (context: C360ServiceProofContext) =>
  JSON.stringify([
    context.tenantId,
    context.issuer,
    context.subject,
    context.clientId,
    context.bindingId,
    context.authzEpoch,
  ]);

/**
 * ทำ network ก่อนถือ DB locks เท่านั้น จากนั้น assert ซ้ำใต้ principal/epoch guard
 * ก่อน effect และ receipt. Proof ที่ client สร้างเองหรือของ authority อื่นใช้ไม่ได้
 * ไม่เก็บ token และไม่ cache ผล introspection; ยังไม่เปิด production route ของ M3-B
 */
export class C360ServiceProofAuthority {
  private readonly issued = new WeakMap<
    C360ServiceOnlineProof,
    { context: string; expiresAt: number; scope: C360ServiceScope }
  >();

  constructor(
    private readonly verifier: OidcAccessTokenVerifier,
    private readonly introspector: {
      introspect(accessToken: string): Promise<Record<string, unknown>>;
    },
    private readonly options: {
      issuer: string;
      now?: () => number;
      timeoutMs?: number;
    },
  ) {
    const issuer = new URL(options.issuer);
    if (
      (issuer.protocol !== 'https:' &&
        !(
          issuer.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)
        )) ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      !Number.isInteger(options.timeoutMs ?? 2_000) ||
      (options.timeoutMs ?? 2_000) < 1 ||
      (options.timeoutMs ?? 2_000) > 2_000
    )
      throw new Error('Invalid service proof configuration');
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async bounded<T>(work: () => Promise<T>, dependencyStatus: 401 | 503): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(work)
          .catch(() => {
            throw new C360ServiceProofError(
              dependencyStatus,
              dependencyStatus === 401 ? 'SESSION_REQUIRED' : 'IDENTITY_UNAVAILABLE',
            );
          }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new C360ServiceProofError(503, 'IDENTITY_UNAVAILABLE')),
            this.options.timeoutMs ?? 2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async check(
    accessToken: string,
    expected: C360ServiceProofContext,
    scope: C360ServiceScope,
  ): Promise<C360ServiceOnlineProof> {
    const started = this.now();
    const context = fingerprint(expected);
    if (!Number.isFinite(started) || !accessToken || expected.issuer !== this.options.issuer)
      throw new C360ServiceProofError(401, 'SESSION_REQUIRED');
    try {
      // verifier ต้องตรึง issuer/audience ของ backend resource จริงตาม gateway contract
      const claims = await this.bounded(() => this.verifier.verifyAccessToken(accessToken), 401);
      let identity: ReturnType<typeof toVerifiedServiceIdentity>;
      try {
        identity = toVerifiedServiceIdentity(claims, new Date(this.now()));
        if (!Number.isFinite(identity.expiresAt.getTime())) throw new Error('invalid expiry');
      } catch {
        throw new C360ServiceProofError(401, 'SESSION_REQUIRED');
      }
      if (
        !('iss' in claims) ||
        claims.iss !== expected.issuer ||
        identity.tenantId !== expected.tenantId ||
        identity.subject !== expected.subject ||
        identity.clientId !== expected.clientId ||
        !identity.roles.includes('service') ||
        !identity.scopes.includes(scope)
      )
        throw new C360ServiceProofError(403, 'CUSTOMER_ACCESS_DENIED');
      const result = await this.bounded(() => this.introspector.introspect(accessToken), 503);
      if (result.active !== true) throw new C360ServiceProofError(401, 'SESSION_REQUIRED');
      const proof = Object.freeze({
        checkStartedAt: started,
        deadline: Math.min(started + 5_000, identity.expiresAt.getTime()),
      });
      this.issued.set(proof, { context, expiresAt: identity.expiresAt.getTime(), scope });
      this.assert(proof, expected, scope);
      return proof;
    } catch (error) {
      if (error instanceof C360ServiceProofError) throw error;
      // ไม่ส่ง error ของ IdP/verifier ซึ่งอาจมี token หรือ credential กลับออกไป
      throw new C360ServiceProofError(503, 'IDENTITY_UNAVAILABLE');
    }
  }

  assert(
    proof: C360ServiceOnlineProof,
    current: C360ServiceProofContext,
    scope: C360ServiceScope,
  ): void {
    const record = this.issued.get(proof);
    const now = this.now();
    if (
      !record ||
      !Number.isFinite(now) ||
      record.context !== fingerprint(current) ||
      record.scope !== scope ||
      now < proof.checkStartedAt ||
      now >= proof.deadline ||
      now >= record.expiresAt
    )
      throw new C360ServiceProofError(403, 'SERVICE_AUTHORIZATION_CHANGED');
  }
}
