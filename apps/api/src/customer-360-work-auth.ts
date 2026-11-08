import { createHash } from 'node:crypto';
import {
  Prisma,
  withTenantDatabaseTransaction,
  lockTeamReferences,
  type PrismaClient,
} from '@d-contact/db';
import {
  toVerifiedWorkspaceIdentity,
  type OidcAccessTokenVerifier,
  type WorkspaceMutationAuthAuthority,
  type WorkspaceMutationAuthBinding,
} from '@d-contact/workspace-session';
import {
  tenantConfigurationCaller,
  type TenantConfigurationCaller,
} from './tenant-config-identity.js';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';

export type C360WorkAuthBinding = WorkspaceMutationAuthBinding;
export interface C360OnlineProof extends C360WorkAuthBinding {
  checkStartedAt: Date;
  deadline: Date;
}
export class C360WorkAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export interface C360TokenIntrospector {
  introspect(accessToken: string): Promise<Record<string, unknown>>;
}
/** ใช้ confidential backend ส่ง exact access token ภายใน deadline โดยไม่ cache ผล active */
export class KeycloakC360TokenIntrospector implements C360TokenIntrospector {
  private readonly endpoint: URL;
  constructor(
    private readonly options: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    this.endpoint = new URL(
      `${options.issuer.replace(/\/$/, '')}/protocol/openid-connect/token/introspect`,
    );
    if (
      !options.clientId ||
      !options.clientSecret ||
      (this.endpoint.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname))
    )
      throw new Error('Cus360 introspection requires confidential client and trusted HTTPS issuer');
  }
  async introspect(accessToken: string): Promise<Record<string, unknown>> {
    try {
      const response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(this.options.timeoutMs ?? 2_000, 2_000)),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          token: accessToken,
          token_type_hint: 'access_token',
        }),
      });
      if (!response.ok) throw new Error('introspection unavailable');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('invalid introspection result');
      return result as Record<string, unknown>;
    } catch {
      throw new C360WorkAuthError(503, 'WORK_IDENTITY_UNAVAILABLE', true);
    }
  }
}

const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const denied = () => new C360WorkAuthError(401, 'WORK_REAUTH_REQUIRED');
const changed = () => new C360WorkAuthError(409, 'WORK_AUTH_CHANGED', true);
const key = (binding: Pick<C360WorkAuthBinding, 'tenantId' | 'userId' | 'leaseId'>) => ({
  tenantId_userId_leaseId: {
    tenantId: binding.tenantId,
    userId: binding.userId,
    leaseId: binding.leaseId,
  },
});
type Tx = Prisma.TransactionClient;
type Row = Awaited<ReturnType<Tx['c360WorkMutationAuth']['findUnique']>>;
function bindingOf(row: NonNullable<Row>): C360WorkAuthBinding {
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    leaseId: row.leaseId,
    authEpoch: String(row.authEpoch),
    issuer: row.issuer,
    subject: row.subject,
    sid: row.sid,
    tokenFingerprint: row.tokenFingerprint,
    tokenExpiresAt: row.tokenExpiresAt,
  };
}
export function sameC360WorkAuthBinding(
  left: C360WorkAuthBinding,
  right: C360WorkAuthBinding,
): boolean {
  return (
    [
      'tenantId',
      'userId',
      'leaseId',
      'authEpoch',
      'issuer',
      'subject',
      'sid',
      'tokenFingerprint',
    ].every(
      (field) =>
        left[field as keyof C360WorkAuthBinding] === right[field as keyof C360WorkAuthBinding],
    ) && left.tokenExpiresAt.getTime() === right.tokenExpiresAt.getTime()
  );
}
async function clock(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row!.now;
}
async function lockLease(
  tx: Tx,
  binding: Pick<C360WorkAuthBinding, 'tenantId' | 'userId' | 'leaseId'>,
  requireCurrent = true,
) {
  const rows = await tx.$queryRaw<{ id: string; released_at: Date | null; current: boolean }[]>`
    SELECT id, released_at, (expires_at > clock_timestamp() OR EXISTS (
      SELECT 1 FROM interactions i WHERE i.tenant_id=l.tenant_id AND i.agent_id=l.user_id AND i.state IN ('ACTIVE','WRAPUP')
    )) AS current FROM agent_work_session_leases l
    WHERE tenant_id=${binding.tenantId}::uuid AND user_id=${binding.userId}::uuid AND id=${binding.leaseId}::uuid
    FOR NO KEY UPDATE NOWAIT`;
  if (!rows[0] || (requireCurrent && (rows[0].released_at || !rows[0].current))) throw changed();
  return rows[0];
}
async function lockAuth(
  tx: Tx,
  binding: Pick<C360WorkAuthBinding, 'tenantId' | 'userId' | 'leaseId'>,
) {
  await tx.$queryRaw`SELECT lease_id FROM c360_work_mutation_auth WHERE tenant_id=${binding.tenantId}::uuid AND user_id=${binding.userId}::uuid AND lease_id=${binding.leaseId}::uuid FOR NO KEY UPDATE NOWAIT`;
  return tx.c360WorkMutationAuth.findUnique({ where: key(binding) });
}
/** Caller ถือ lease fence แล้ว tuple ที่ capture ไว้ห้าม retry ด้วย epoch ใหม่ */
export async function invalidateC360WorkAuthInTransaction(
  tx: Tx,
  binding: Pick<C360WorkAuthBinding, 'tenantId' | 'userId' | 'leaseId'>,
  reason: string,
  expected?: C360WorkAuthBinding,
): Promise<'invalidated' | 'already-invalidated' | 'stale' | 'absent'> {
  const row = await lockAuth(tx, binding);
  if (!row) return 'absent';
  if (expected && !sameC360WorkAuthBinding(bindingOf(row), expected)) {
    const invalidated = { ...expected, authEpoch: String(BigInt(expected.authEpoch) + 1n) };
    return row.authState === 'REAUTH_REQUIRED' &&
      sameC360WorkAuthBinding(bindingOf(row), invalidated)
      ? 'already-invalidated'
      : 'stale';
  }
  if (row.authState === 'REAUTH_REQUIRED') return 'already-invalidated';
  await tx.c360WorkMutationAuth.update({
    where: key(binding),
    data: {
      authState: 'REAUTH_REQUIRED',
      authEpoch: row.authEpoch + 1n,
      invalidationReason: reason,
    },
  });
  return 'invalidated';
}

export class C360WorkAuthService implements WorkspaceMutationAuthAuthority {
  constructor(
    private readonly database: PrismaClient,
    private readonly verifier: OidcAccessTokenVerifier,
    private readonly introspector: C360TokenIntrospector,
  ) {}

  private async verified(input: {
    accessToken: string;
    leaseId: string;
    identity?: { tenantId: string; userId: string };
  }) {
    if (!input.accessToken || !uuid(input.leaseId)) throw denied();
    let claims;
    let identity;
    try {
      claims = await this.verifier.verifyAccessToken(input.accessToken);
      identity = toVerifiedWorkspaceIdentity(claims);
    } catch {
      throw denied();
    }
    const caller = tenantConfigurationCaller({
      gatewayIdentity: identity,
      gatewayVerifiedClaims: claims,
    } as AuthenticatedGatewayRequest);
    if (
      !caller ||
      !identity.roles.includes('agent') ||
      (input.identity &&
        (input.identity.tenantId !== identity.tenantId ||
          input.identity.userId !== identity.userId))
    )
      throw denied();
    return {
      ...identity,
      issuer: caller.issuer,
      subject: caller.subject,
      sid: identity.sessionId,
      leaseId: input.leaseId,
      tokenFingerprint: createHash('sha256').update(input.accessToken).digest('hex'),
      tokenExpiresAt: identity.expiresAt,
      caller,
      audience: (claims as Record<string, unknown>).aud,
    };
  }
  private async online(
    accessToken: string,
    identity: Awaited<ReturnType<C360WorkAuthService['verified']>>,
    started: Date,
  ) {
    const result = await this.introspector.introspect(accessToken);
    if (result.active !== true) throw denied();
    for (const [name, expected] of [
      ['iss', identity.issuer],
      ['sub', identity.subject],
      ['sid', identity.sid],
      ['exp', identity.tokenExpiresAt.getTime() / 1000],
    ] as const)
      if (result[name] !== undefined && result[name] !== expected) throw denied();
    if (result.client_id !== undefined && result.client_id !== identity.caller.clientId)
      throw denied();
    if (result.azp !== undefined && result.azp !== identity.caller.clientId) throw denied();
    if (result.aud !== undefined) {
      const audience = (value: unknown) =>
        typeof value === 'string'
          ? [value]
          : Array.isArray(value) && value.every((item) => typeof item === 'string')
            ? [...value].sort()
            : [];
      if (JSON.stringify(audience(result.aud)) !== JSON.stringify(audience(identity.audience)))
        throw denied();
    }
    return new Date(Math.min(identity.tokenExpiresAt.getTime(), started.getTime() + 5_000));
  }
  async verifyOnline(input: {
    accessToken: string;
    leaseId: string;
    identity?: { tenantId: string; userId: string };
  }): Promise<C360OnlineProof> {
    const identity = await this.verified(input);
    const snapshot = await withTenantDatabaseTransaction(
      this.database,
      identity.tenantId,
      async (tx) => ({
        row: await tx.c360WorkMutationAuth.findUnique({ where: key(identity) }),
        started: await clock(tx),
      }),
    );
    if (!snapshot.row || snapshot.row.authState !== 'ACTIVE') throw denied();
    const captured = bindingOf(snapshot.row);
    if (!sameC360WorkAuthBinding(captured, { ...identity, authEpoch: captured.authEpoch }))
      throw denied();
    try {
      const deadline = await this.online(input.accessToken, identity, snapshot.started);
      return { ...captured, checkStartedAt: snapshot.started, deadline };
    } catch (error) {
      await this.invalidateCaptured(
        captured,
        error instanceof C360WorkAuthError && error.status === 503
          ? 'IDENTITY_UNAVAILABLE'
          : 'TOKEN_INACTIVE',
      );
      throw error;
    }
  }
  async reauthenticate(input: {
    accessToken: string;
    leaseId: string;
    identity?: { tenantId: string; userId: string };
    expected?: C360WorkAuthBinding;
  }): Promise<C360WorkAuthBinding> {
    const identity = await this.verified(input);
    const snapshot = await withTenantDatabaseTransaction(
      this.database,
      identity.tenantId,
      async (tx) => ({
        row: await tx.c360WorkMutationAuth.findUnique({ where: key(identity) }),
        user: await tx.user.findFirst({
          where: { id: identity.userId, tenantId: identity.tenantId },
          select: { teamId: true },
        }),
        started: await clock(tx),
      }),
    );
    if (
      snapshot.row &&
      (snapshot.row.issuer !== identity.issuer || snapshot.row.subject !== identity.subject)
    )
      throw denied();
    let expected = input.expected ?? (snapshot.row ? bindingOf(snapshot.row) : undefined);
    if (input.expected) {
      if (!snapshot.row) throw changed();
      const current = bindingOf(snapshot.row);
      const afterOwnInvalidation = {
        ...input.expected,
        authEpoch: String(BigInt(input.expected.authEpoch) + 1n),
      };
      if (!sameC360WorkAuthBinding(current, input.expected)) {
        if (
          snapshot.row.authState !== 'REAUTH_REQUIRED' ||
          !sameC360WorkAuthBinding(current, afterOwnInvalidation)
        )
          throw changed();
        expected = current;
      }
    }
    // การลอง token อื่นโดยไม่มี private binding เดิม ไม่ใช่อำนาจ invalidate token ปัจจุบัน
    const failureBinding =
      input.expected || snapshot.row?.tokenFingerprint === identity.tokenFingerprint
        ? expected
        : undefined;
    let deadline: Date;
    try {
      deadline = await this.online(input.accessToken, identity, snapshot.started);
    } catch (error) {
      if (failureBinding)
        await this.invalidateCaptured(
          failureBinding,
          error instanceof C360WorkAuthError && error.status === 503
            ? 'IDENTITY_UNAVAILABLE'
            : 'TOKEN_INACTIVE',
        );
      throw error;
    }
    return withTenantDatabaseTransaction(
      this.database,
      identity.tenantId,
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout='250ms'`;
        await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
        await lockTeamReferences(tx, identity.tenantId, [snapshot.user?.teamId]);
        await tx.$queryRaw`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${identity.userId}::uuid FOR NO KEY UPDATE NOWAIT`;
        await this.assertActor(tx, identity, snapshot.user?.teamId ?? null);
        await lockLease(tx, identity);
        const row = await lockAuth(tx, identity);
        if (expected ? !row || !sameC360WorkAuthBinding(bindingOf(row), expected) : row !== null)
          throw changed();
        if (row && (row.issuer !== identity.issuer || row.subject !== identity.subject))
          throw denied();
        if ((await clock(tx)).getTime() >= deadline.getTime())
          throw new C360WorkAuthError(503, 'WORK_AUTH_PROOF_EXPIRED', true);
        const data = {
          issuer: identity.issuer,
          subject: identity.subject,
          sid: identity.sid,
          tokenFingerprint: identity.tokenFingerprint,
          tokenExpiresAt: identity.tokenExpiresAt,
          authState: 'ACTIVE',
          invalidationReason: null,
          lastOnlineCheckStartedAt: snapshot.started,
        };
        const committed = row
          ? await tx.c360WorkMutationAuth.update({
              where: key(identity),
              data: { ...data, authEpoch: row.authEpoch + 1n },
            })
          : await tx.c360WorkMutationAuth.create({
              data: {
                tenantId: identity.tenantId,
                userId: identity.userId,
                leaseId: identity.leaseId,
                ...data,
              },
            });
        return bindingOf(committed);
      },
      { timeout: 2_000 },
    ).catch(async (error: unknown) => {
      if (failureBinding && error instanceof C360WorkAuthError && error.status === 401)
        await this.invalidateCaptured(failureBinding, 'ACTOR_AUTHORIZATION_FAILED');
      throw error;
    });
  }
  private async assertActor(
    tx: Tx,
    identity: Awaited<ReturnType<C360WorkAuthService['verified']>>,
    teamId: string | null,
  ) {
    const user = await tx.user.findFirst({
      where: {
        tenantId: identity.tenantId,
        id: identity.userId,
        isActive: true,
        role: 'AGENT',
        keycloakId: identity.subject,
      },
      select: { teamId: true },
    });
    if (
      !user ||
      user.teamId !== teamId ||
      !(await tx.tenant.findFirst({
        where: { id: identity.tenantId, lifecycleStatus: 'ACTIVE' },
        select: { id: true },
      }))
    )
      throw denied();
    const caller: TenantConfigurationCaller = identity.caller;
    const bindings = await tx.$queryRaw<
      { revision: number }[]
    >`SELECT revision FROM tenant_voice_identity_bindings WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${identity.userId}::uuid AND issuer=${caller.issuer} AND subject_id=${caller.subject} AND client_id=${caller.clientId} AND tenant_slug=${caller.tenantSlug} AND identity_class='TENANT_USER' AND is_active`;
    if (!bindings[0]) {
      const receipts = await tx.$queryRaw<
        { statusRevision: number }[]
      >`SELECT status_revision AS "statusRevision" FROM dc_people_configuration_authority(${identity.tenantId}::uuid,${identity.userId}::uuid,${caller.issuer},${caller.clientId},${caller.tenantSlug})`;
      if (!receipts[0]) throw denied();
    }
  }
  /** Caller ถือ Team/User fences แล้ว ฟังก์ชันนี้ไม่มี network และไม่ย้อนขอ lock ก่อนหน้า */
  async assertOnlineProof(tx: Tx, proof: C360OnlineProof): Promise<void> {
    await lockLease(tx, proof);
    const row = await lockAuth(tx, proof);
    if (!row || row.authState !== 'ACTIVE' || !sameC360WorkAuthBinding(bindingOf(row), proof))
      throw denied();
    const now = await clock(tx);
    if (
      now.getTime() >= proof.deadline.getTime() ||
      now.getTime() >= proof.tokenExpiresAt.getTime()
    )
      throw new C360WorkAuthError(503, 'WORK_AUTH_PROOF_EXPIRED', true);
    await tx.c360WorkMutationAuth.update({
      where: key(proof),
      data: { lastOnlineCheckStartedAt: proof.checkStartedAt },
    });
  }
  async invalidateCaptured(binding: C360WorkAuthBinding, reason: string): Promise<boolean> {
    return withTenantDatabaseTransaction(
      this.database,
      binding.tenantId,
      async (tx) => {
        const lease = await lockLease(tx, binding, false);
        if (lease.released_at) return false;
        const result = await invalidateC360WorkAuthInTransaction(tx, binding, reason, binding);
        // true = tuple นี้ถูก invalidate แล้วอย่างปลอดภัย รวมผลเดิมจาก callback เดียวกัน
        // false = เป็น tuple เก่าที่มี binding ใหม่กว่า หรือ lease ถูกย้าย/ปล่อยแล้ว
        return result === 'invalidated' || result === 'already-invalidated';
      },
      { timeout: 2_000 },
    );
  }
}
