import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type WorkspaceSessionStatus = 'active' | 'reauthentication-required';

export interface VerifiedWorkspaceIdentity {
  tenantId: string;
  userId: string;
  sessionId: string;
  roles: readonly string[];
  expiresAt: Date;
}

export interface VerifiedServiceIdentity {
  tenantId: string;
  clientId: string;
  subject: string;
  roles: readonly string[];
  scopes: readonly string[];
  expiresAt: Date;
}

export interface VerifiedOidcClaims {
  tenant_id?: unknown;
  tenant_slug?: unknown;
  organization?: unknown;
  dc_user_id?: unknown;
  sid?: unknown;
  azp?: unknown;
  sub?: unknown;
  preferred_username?: unknown;
  exp?: unknown;
  realm_access?: { roles?: unknown };
  scope?: unknown;
}

interface VerifiedTenantContext {
  tenantId: string;
  tenantSlug: string;
}

interface VerifiedSecurityContext {
  roles: string[];
  expiresAt: Date;
}

function verifiedTenantContext(
  claims: VerifiedOidcClaims,
  requireOrganization: boolean,
): VerifiedTenantContext {
  if (typeof claims.tenant_id !== 'string' || claims.tenant_id.length === 0) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วต้องมี tenant_id');
  }
  if (typeof claims.tenant_slug !== 'string' || claims.tenant_slug.length === 0) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วต้องมี tenant_slug');
  }
  if (claims.organization === undefined && !requireOrganization) {
    return { tenantId: claims.tenant_id, tenantSlug: claims.tenant_slug };
  }
  if (
    !claims.organization ||
    typeof claims.organization !== 'object' ||
    !Object.hasOwn(claims.organization, claims.tenant_slug)
  ) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วต้องมี Keycloak Organization context ที่ตรงกัน');
  }
  const organization = (claims.organization as Record<string, unknown>)[claims.tenant_slug];
  const organizationTenantIds =
    organization && typeof organization === 'object'
      ? (organization as { tenant_id?: unknown }).tenant_id
      : undefined;
  if (!Array.isArray(organizationTenantIds) || organizationTenantIds[0] !== claims.tenant_id) {
    throw new Error('tenant_id ไม่ตรงกับ Keycloak Organization attribute');
  }
  return { tenantId: claims.tenant_id, tenantSlug: claims.tenant_slug };
}

function verifiedSecurityContext(claims: VerifiedOidcClaims, now: Date): VerifiedSecurityContext {
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วต้องมี exp');
  }
  if (!Array.isArray(claims.realm_access?.roles) || !claims.realm_access.roles.every(isString)) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วต้องมี realm_access.roles');
  }
  const expiresAt = new Date(claims.exp * 1_000);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วหมดอายุ');
  }
  return { roles: claims.realm_access.roles, expiresAt };
}

/**
 * Converts claims only after an API/WebSocket adapter has verified the OIDC
 * signature, issuer, audience and token type. Browser-provided tenant or user
 * values are never accepted by this boundary.
 */
export function toVerifiedWorkspaceIdentity(
  claims: VerifiedOidcClaims,
  now: Date = new Date(),
): VerifiedWorkspaceIdentity {
  const tenant = verifiedTenantContext(claims, false);
  const security = verifiedSecurityContext(claims, now);
  if (typeof claims.dc_user_id !== 'string' || claims.dc_user_id.length === 0) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วต้องมี dc_user_id');
  }
  if (typeof claims.sid !== 'string' || claims.sid.length === 0) {
    throw new Error('OIDC token ที่ตรวจสอบแล้วต้องมี sid');
  }

  return {
    tenantId: tenant.tenantId,
    userId: claims.dc_user_id,
    sessionId: claims.sid,
    roles: security.roles,
    expiresAt: security.expiresAt,
  };
}

/** แปลง Keycloak client_credentials token ที่ตรวจสอบแล้วเป็น service identity ที่ผูกกับ tenant */
export function toVerifiedServiceIdentity(
  claims: VerifiedOidcClaims,
  now: Date = new Date(),
): VerifiedServiceIdentity {
  const tenant = verifiedTenantContext(claims, true);
  const security = verifiedSecurityContext(claims, now);
  if (claims.dc_user_id !== undefined || claims.sid !== undefined) {
    throw new Error('service token ที่ตรวจสอบแล้วต้องไม่มี workspace user claims');
  }
  if (typeof claims.azp !== 'string' || claims.azp.length === 0) {
    throw new Error('OIDC service token ที่ตรวจสอบแล้วต้องมี azp');
  }
  if (claims.preferred_username !== `service-account-${claims.azp}`) {
    throw new Error('service token ที่ตรวจสอบแล้วต้องเป็น Keycloak service account');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('OIDC service token ที่ตรวจสอบแล้วต้องมี sub');
  }
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : [];
  if (!scopes.every(isString)) throw new Error('OIDC service token scope ไม่ถูกต้อง');
  return {
    tenantId: tenant.tenantId,
    clientId: claims.azp,
    subject: claims.sub,
    roles: security.roles,
    scopes,
    expiresAt: security.expiresAt,
  };
}

export interface WorkspaceSession {
  tenantId: string;
  userId: string;
  tabId: string;
  routingEnabled: boolean;
  status: WorkspaceSessionStatus;
  availability: 'OFFLINE' | 'AVAILABLE';
  activeInteractionId?: string;
}

export interface WorkspaceSessionHandshake {
  accessToken: string;
  tabId: string;
}

export interface OidcAccessTokenVerifier {
  verifyAccessToken(accessToken: string): Promise<VerifiedOidcClaims>;
}

export class WorkspaceAuthenticationError extends Error {
  constructor() {
    super('workspace authentication failed');
    this.name = 'WorkspaceAuthenticationError';
  }
}

export class WorkspaceAuthorizationError extends Error {
  constructor() {
    super('workspace authorization failed');
    this.name = 'WorkspaceAuthorizationError';
  }
}

export interface KeycloakVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
}

/** Verifies Keycloak access tokens for both REST and WebSocket adapters. */
export class KeycloakAccessTokenVerifier implements OidcAccessTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: KeycloakVerifierOptions) {
    this.jwks = createRemoteJWKSet(new URL(options.jwksUri));
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedOidcClaims> {
    const { payload } = await jwtVerify(accessToken, this.jwks, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      typ: 'JWT',
    });
    return payload as JWTPayload & VerifiedOidcClaims;
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

interface StoredSession extends WorkspaceSession {
  sessionId: string;
  expiresAt: Date;
}

type Clock = () => Date;

/**
 * Public session boundary used by the API/WebSocket adapter and Workspace.
 * It owns the one-working-tab rule but deliberately does not verify OIDC
 * signatures; adapters may only pass identities they have already verified.
 */
export class WorkspaceSessionRegistry {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly workingTabs = new Map<string, string>();

  constructor(private readonly now: Clock = () => new Date()) {}

  connect(identity: VerifiedWorkspaceIdentity, tabId: string): WorkspaceSession {
    this.assertIdentity(identity, tabId);
    const key = this.sessionKey(identity.tenantId, identity.userId, tabId);
    const existing = this.sessions.get(key);

    if (existing && existing.tenantId !== identity.tenantId) {
      throw new Error('workspace session tenant context cannot change');
    }

    const userKey = this.userKey(identity.tenantId, identity.userId);
    const isValid = identity.expiresAt.getTime() > this.now().getTime();
    const currentWorkingTab = this.workingTabs.get(userKey);
    const isLeader = isValid && (currentWorkingTab === undefined || currentWorkingTab === tabId);

    if (isLeader) this.workingTabs.set(userKey, tabId);

    const session: StoredSession = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      tabId,
      sessionId: identity.sessionId,
      expiresAt: identity.expiresAt,
      routingEnabled: isLeader,
      status: isValid ? 'active' : 'reauthentication-required',
      availability: isLeader ? 'AVAILABLE' : 'OFFLINE',
    };
    this.sessions.set(key, session);
    return this.publicSession(session);
  }

  claimWorkingTab(identity: VerifiedWorkspaceIdentity, tabId: string): WorkspaceSession {
    this.assertIdentity(identity, tabId);
    const userKey = this.userKey(identity.tenantId, identity.userId);
    const key = this.sessionKey(identity.tenantId, identity.userId, tabId);

    if (!this.sessions.has(key)) this.connect(identity, tabId);

    const isValid = identity.expiresAt.getTime() > this.now().getTime();
    this.workingTabs.set(userKey, tabId);
    for (const session of this.sessions.values()) {
      if (this.userKey(session.tenantId, session.userId) !== userKey) continue;
      session.routingEnabled = isValid && session.tabId === tabId;
      session.status = isValid ? 'active' : 'reauthentication-required';
      session.availability = session.routingEnabled ? 'AVAILABLE' : 'OFFLINE';
    }

    return this.publicSession(this.requireSession(key));
  }

  refresh(identity: VerifiedWorkspaceIdentity, tabId: string): WorkspaceSession {
    this.assertIdentity(identity, tabId);
    const existingForTab = [...this.sessions.values()].find(
      (session) => session.userId === identity.userId && session.tabId === tabId,
    );
    if (existingForTab && existingForTab.tenantId !== identity.tenantId) {
      throw new Error('workspace session tenant context cannot change');
    }

    const key = this.sessionKey(identity.tenantId, identity.userId, tabId);
    const session = this.sessions.get(key) ?? this.connect(identity, tabId);
    const stored = this.requireSession(this.sessionKey(session.tenantId, session.userId, tabId));
    const isValid = identity.expiresAt.getTime() > this.now().getTime();
    stored.sessionId = identity.sessionId;
    stored.expiresAt = identity.expiresAt;
    stored.status = isValid ? 'active' : 'reauthentication-required';
    stored.routingEnabled =
      isValid && this.workingTabs.get(this.userKey(identity.tenantId, identity.userId)) === tabId;
    stored.availability = stored.routingEnabled ? 'AVAILABLE' : 'OFFLINE';
    return this.publicSession(stored);
  }

  canReceiveRoutingWork(tenantId: string, userId: string, tabId: string): boolean {
    const session = this.sessions.get(this.sessionKey(tenantId, userId, tabId));
    return Boolean(
      session &&
      session.status === 'active' &&
      session.routingEnabled &&
      session.expiresAt.getTime() > this.now().getTime(),
    );
  }

  holdInteraction(
    tenantId: string,
    userId: string,
    tabId: string,
    interactionId: string,
  ): WorkspaceSession {
    if (!interactionId) throw new Error('interaction id is required');
    const session = this.requireSession(this.sessionKey(tenantId, userId, tabId));
    session.activeInteractionId = interactionId;
    return this.publicSession(session);
  }

  requireReauthentication(tenantId: string, userId: string, tabId: string): WorkspaceSession {
    const session = this.requireSession(this.sessionKey(tenantId, userId, tabId));
    session.routingEnabled = false;
    session.status = 'reauthentication-required';
    session.availability = 'OFFLINE';
    return this.publicSession(session);
  }

  private assertIdentity(identity: VerifiedWorkspaceIdentity, tabId: string): void {
    if (!identity.tenantId || !identity.userId || !identity.sessionId || !tabId) {
      throw new Error('verified workspace identity and tab id are required');
    }
  }

  private requireSession(key: string): StoredSession {
    const session = this.sessions.get(key);
    if (!session) throw new Error('workspace session was not found');
    return session;
  }

  private publicSession(session: StoredSession): WorkspaceSession {
    const { sessionId: _sessionId, expiresAt: _expiresAt, ...publicSession } = session;
    return publicSession;
  }

  private userKey(tenantId: string, userId: string): string {
    return `${tenantId}:${userId}`;
  }

  private sessionKey(tenantId: string, userId: string, tabId: string): string {
    return `${this.userKey(tenantId, userId)}:${tabId}`;
  }
}

/**
 * A1.8a (#447): tenant ต้อง `ACTIVE` ก่อนเข้า tenant applications ได้ (#393 isolation matrix)
 * — tenant ที่ยัง PROVISIONING (หรือไม่มีอยู่) ถูกปฏิเสธแบบเดียวกับ token ใช้ไม่ได้
 */
export interface TenantLifecycleGate {
  isActive(tenantId: string): Promise<boolean>;
}

/**
 * cache เฉพาะผล ACTIVE (lifecycle ย้อนกลับจาก ACTIVE ไม่ได้ใน A1) — ผลอื่นถามใหม่ทุกครั้ง
 * จึงเปิดให้ทันทีที่ provisioning ทำ tenant เป็น ACTIVE; loader ล้ม = ปฏิเสธ (fail closed)
 */
export class CachedTenantLifecycleGate implements TenantLifecycleGate {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly loader: (tenantId: string) => Promise<string | null | undefined>,
    private readonly options: { ttlMs?: number; now?: () => number; maxEntries?: number } = {},
  ) {}

  async isActive(tenantId: string): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    const cachedUntil = this.active.get(tenantId);
    if (cachedUntil !== undefined && cachedUntil > now) return true;
    let status: string | null | undefined;
    try {
      status = await this.loader(tenantId);
    } catch {
      return false;
    }
    if (status !== 'ACTIVE') {
      this.active.delete(tenantId);
      return false;
    }
    if (this.active.size >= (this.options.maxEntries ?? 10_000)) this.active.clear();
    this.active.set(tenantId, now + (this.options.ttlMs ?? 60_000));
    return true;
  }
}

/**
 * Transport-facing boundary for REST and WebSocket adapters. The adapter must
 * provide a verifier backed by Keycloak JWKS; this class never accepts tenant
 * context from a browser request.
 */
export class WorkspaceSessionGateway {
  constructor(
    private readonly verifier: OidcAccessTokenVerifier,
    private readonly registry: WorkspaceSessionRegistry,
    private readonly lifecycle: TenantLifecycleGate,
    private readonly now: Clock = () => new Date(),
  ) {}

  async connect(handshake: WorkspaceSessionHandshake): Promise<WorkspaceSession> {
    const identity = await this.identityFrom(handshake.accessToken);
    return this.registry.connect(identity, handshake.tabId);
  }

  async refresh(handshake: WorkspaceSessionHandshake): Promise<WorkspaceSession> {
    const identity = await this.identityFrom(handshake.accessToken);
    return this.registry.refresh(identity, handshake.tabId);
  }

  async claimWorkingTab(handshake: WorkspaceSessionHandshake): Promise<WorkspaceSession> {
    const identity = await this.identityFrom(handshake.accessToken);
    return this.registry.claimWorkingTab(identity, handshake.tabId);
  }

  requireReauthentication(
    session: Pick<WorkspaceSession, 'tenantId' | 'userId' | 'tabId'>,
  ): WorkspaceSession {
    return this.registry.requireReauthentication(session.tenantId, session.userId, session.tabId);
  }

  canReceiveRoutingWork(session: Pick<WorkspaceSession, 'tenantId' | 'userId' | 'tabId'>): boolean {
    return this.registry.canReceiveRoutingWork(session.tenantId, session.userId, session.tabId);
  }

  private async identityFrom(accessToken: string): Promise<VerifiedWorkspaceIdentity> {
    if (!accessToken) throw new WorkspaceAuthenticationError();
    let identity: VerifiedWorkspaceIdentity;
    try {
      const claims = await this.verifier.verifyAccessToken(accessToken);
      identity = toVerifiedWorkspaceIdentity(claims, this.now());
    } catch {
      throw new WorkspaceAuthenticationError();
    }
    if (!identity.roles.some((role) => ['agent', 'supervisor', 'admin'].includes(role))) {
      throw new WorkspaceAuthorizationError();
    }
    // tenant ที่ยังไม่ ACTIVE = เหมือน token ใช้ไม่ได้ (ไม่เผยสถานะ provisioning)
    if (!(await this.lifecycle.isActive(identity.tenantId)))
      throw new WorkspaceAuthenticationError();
    return identity;
  }
}
