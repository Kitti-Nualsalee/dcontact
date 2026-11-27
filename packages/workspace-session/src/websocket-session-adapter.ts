import {
  WorkspaceAuthorizationError,
  type WorkspaceSession,
  type WorkspaceSessionGateway,
} from './workspace-session.js';
import type {
  WorkspaceMutationAuthAuthority,
  WorkspaceMutationAuthBinding,
} from './mutation-auth.js';

export interface WorkspaceSessionSocket {
  send(message: string): void;
  close(code: number, reason: string): void;
}

export interface WorkspaceSessionSocketMessage {
  type: 'auth:connect' | 'auth:refresh' | 'auth:claim' | 'lease:heartbeat';
  accessToken?: string;
  tabId?: string;
  /** E1.9: work-session lease obtained from `POST /api/v1/me/work-session` */
  leaseId?: string;
}

export type WorkspaceTenantScope = <T>(tenantId: string, work: () => Promise<T> | T) => Promise<T>;

export interface WorkspaceRoutingEvent {
  type: 'routing.offered';
  interactionId: string;
  tenantId: string;
  userId: string;
}

export interface WorkspaceLiveEvent {
  type: 'workspace.live';
  tenantId: string;
  sequence: number;
  payload: Record<string, unknown>;
}

/** #1044 the user's web chats changed — the Workspace reads them again over HTTP; the event carries no chat data */
export interface WorkspaceWebchatEvent {
  type: 'webchat.changed';
  tenantId: string;
}

export interface WorkspaceSessionDiagnostic {
  event: 'workspace.session.authenticated' | 'workspace.session.denied';
  correlationId: string;
  reason?: 'unauthenticated' | 'forbidden' | 'lease_required';
  tenantId?: string;
  userId?: string;
}

export interface WorkspaceSessionDiagnosticSink {
  write(diagnostic: WorkspaceSessionDiagnostic): void;
}

export type WorkSessionLeaseSignal =
  | {
      type: 'lease.revoked';
      leaseId: string;
      reason: 'takeover' | 'auth_revoked' | 'origin_revoked';
    }
  | { type: 'lease.expired'; leaseId: string };

type Actor = { tenantId: string; userId: string };

/**
 * E1.9 (#483): authority of the server-side work-session lease (ADR-026 item 2) — the adapter does not decide by itself
 * an identity that is an agent must attach a still-active lease — #583: enforced for every tenant (no flag anymore)
 */
export interface WorkSessionLeaseAuthority {
  enforced(tenantId: string): Promise<boolean>;
  heartbeat(
    actor: Actor,
    leaseId: string,
    correlationId?: string,
  ): Promise<
    | { status: 'ACTIVE'; expiresAt: Date }
    | { status: 'REVOKED'; reason: 'takeover' | 'auth_revoked' | 'released' | 'origin_revoked' }
    | { status: 'EXPIRED' }
  >;
  isCurrent(actor: Actor, leaseId: string): Promise<boolean>;
  revokeForAuth(
    actor: Actor,
    leaseId: string,
    correlationId: string,
    expected?: WorkspaceMutationAuthBinding,
  ): Promise<boolean>;
}

interface SocketBinding {
  session: WorkspaceSession;
  /** lease held by this socket (only for tenants that enforce the lease) */
  leaseId?: string;
  enforced: boolean;
  mutationAuth?: WorkspaceMutationAuthBinding;
  tokenExpiresAt?: Date;
  leaseRevoked?: boolean;
}

interface SocketAuthSequence {
  tail: Promise<void>;
  origin?: SocketBinding;
  committed?: WorkspaceMutationAuthBinding;
}

interface PendingLeaseBinding {
  tenantId: string;
  userId: string;
  leaseId: string;
  revoked: boolean;
}

const silentDiagnostics: WorkspaceSessionDiagnosticSink = { write: () => undefined };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared WebSocket handshake adapter; tokens never travel in a query string. */
export class WorkspaceSessionWebSocketAdapter {
  private readonly authenticatedSessions = new Map<WorkspaceSessionSocket, SocketBinding>();
  private readonly handshakeGenerations = new Map<WorkspaceSessionSocket, number>();
  private readonly authSequences = new Map<WorkspaceSessionSocket, SocketAuthSequence>();
  private readonly pendingLeases = new Map<WorkspaceSessionSocket, PendingLeaseBinding>();
  private nextHandshakeGeneration = 0;

  constructor(
    private readonly gateway: WorkspaceSessionGateway,
    private readonly withTenant: WorkspaceTenantScope = async (_tenantId, work) => work(),
    private readonly diagnostics: WorkspaceSessionDiagnosticSink = silentDiagnostics,
    private readonly leases?: WorkSessionLeaseAuthority,
    private readonly mutationAuth?: WorkspaceMutationAuthAuthority,
  ) {}

  async handle(
    socket: WorkspaceSessionSocket,
    message: WorkspaceSessionSocketMessage,
    correlationId = 'unavailable',
  ): Promise<void> {
    if (message.type === 'lease:heartbeat') {
      await this.heartbeat(socket, message, correlationId);
      return;
    }
    if (!['auth:connect', 'auth:refresh', 'auth:claim'].includes(message.type)) {
      socket.close(4400, 'invalid workspace message');
      return;
    }
    const generation = ++this.nextHandshakeGeneration;
    this.handshakeGenerations.set(socket, generation);
    if (!message.accessToken || !message.tabId) {
      this.diagnostics.write({
        event: 'workspace.session.denied',
        correlationId,
        reason: 'unauthenticated',
      });
      socket.close(4401, 'workspace authentication required');
      return;
    }
    // Capture before the verifier/JWKS/online call so an old callback cannot change the new binding
    const captured = this.authenticatedSessions.get(socket);
    let sequence = this.authSequences.get(socket);
    if (!sequence) {
      sequence = { tail: Promise.resolve() };
      this.authSequences.set(socket, sequence);
    }
    const authSequence = sequence;
    const isCurrent = () =>
      this.handshakeGenerations.get(socket) === generation &&
      this.authenticatedSessions.get(socket) === captured;
    const expectedFor = (tenantId: string, userId: string, leaseId: string) => {
      const pending = authSequence.origin === captured ? authSequence.committed : undefined;
      if (
        pending?.tenantId === tenantId &&
        pending.userId === userId &&
        pending.leaseId === leaseId
      )
        return pending;
      return captured?.leaseId === leaseId ? captured.mutationAuth : undefined;
    };
    let pendingLease: PendingLeaseBinding | undefined;
    try {
      const identity = await this.gateway.verifyHandshake(message.accessToken);
      if (!isCurrent()) return;
      let session: WorkspaceSession = {
        tenantId: identity.tenantId,
        userId: identity.userId,
        tabId: message.tabId,
        agent: identity.roles.includes('agent'),
        status: 'active',
        routingEnabled: false,
        availability: 'OFFLINE',
      };
      const binding = await this.bindLease(session, message.leaseId, correlationId);
      if (!isCurrent()) return;
      if (!binding) {
        this.authenticatedSessions.delete(socket);
        this.diagnostics.write({
          event: 'workspace.session.denied',
          correlationId,
          reason: 'lease_required',
          tenantId: session.tenantId,
          userId: session.userId,
        });
        socket.close(4409, 'work session lease required');
        return;
      }
      if (binding.enforced && binding.leaseId) {
        pendingLease = {
          tenantId: session.tenantId,
          userId: session.userId,
          leaseId: binding.leaseId,
          revoked: false,
        };
        this.pendingLeases.set(socket, pendingLease);
      }
      let customerAuthState: 'REAUTH_REQUIRED' | 'UNAVAILABLE' | undefined;
      if (this.mutationAuth && binding.leaseId && session.agent) {
        const authority = this.mutationAuth;
        const leaseId = binding.leaseId;
        const handled = await this.withAuthSequence(authSequence, async () => {
          if (!isCurrent() || this.authSequences.get(socket) !== authSequence) return false;
          const previous = expectedFor(session.tenantId, session.userId, leaseId);
          try {
            const next = await authority.reauthenticate({
              accessToken: message.accessToken!,
              leaseId,
              identity: session,
              expected: previous,
            });
            // the old callback may have committed already: keep the server-side tuple for the new callback to use CAS
            // but must not skip a disconnect or a binding changed by a lease signal
            if (
              this.authSequences.get(socket) === authSequence &&
              this.authenticatedSessions.get(socket) === captured
            ) {
              authSequence.origin = captured;
              authSequence.committed = next;
            } else if (this.authSequences.get(socket) !== authSequence) {
              // a disconnect may happen after the transaction starts; use the CAS of the result just committed
              // so this callback does not invalidate a newer session
              try {
                await authority.invalidateCaptured(next, 'SOCKET_DISCONNECTED');
              } catch {
                // do not report durable invalidation when the database is unavailable
              }
            }
            binding.mutationAuth = next;
            return isCurrent();
          } catch {
            // the JWT/Voice lease passed, so a Cus360/IdP fault must not go down the Voice auth failure path
            // or release an idle/busy lease; close only customer mutation
            if (!isCurrent()) return false;
            if (previous) {
              try {
                if (!(await authority.invalidateCaptured(previous, 'CUSTOMER_REAUTH_FAILED')))
                  return false;
              } catch {
                // the DB failed so durable invalidation cannot be confirmed; keep the existing Voice binding
                // and report only that Cus360 is not ready, without reporting that state was changed
                if (isCurrent())
                  socket.send(JSON.stringify({ type: 'customer.auth', state: 'UNAVAILABLE' }));
                return false;
              }
            }
            binding.mutationAuth = previous;
            customerAuthState = previous ? 'REAUTH_REQUIRED' : 'UNAVAILABLE';
            return isCurrent();
          }
        });
        if (!handled) return;
      }
      if (!isCurrent()) return;
      // heartbeat may pass before online auth, but the lease may be taken while waiting on the IdP/DB
      if (binding.enforced && binding.leaseId && this.leases) {
        const active = await this.leases.isCurrent(session, binding.leaseId);
        if (!isCurrent()) return;
        if (!active || pendingLease?.revoked) {
          this.authenticatedSessions.delete(socket);
          socket.close(4409, 'work session lease required');
          return;
        }
      }
      const committed = await this.withTenant(session.tenantId, () => {
        if (!isCurrent()) return false;
        if (pendingLease?.revoked) {
          this.authenticatedSessions.delete(socket);
          socket.close(4409, 'work session lease required');
          return false;
        }
        const established = this.gateway.commitHandshake(
          message.type === 'auth:connect'
            ? 'connect'
            : message.type === 'auth:claim'
              ? 'claim'
              : 'refresh',
          identity,
          message.tabId!,
        );
        session = binding.enforced
          ? {
              ...established,
              routingEnabled: established.status === 'active' && Boolean(binding.leaseId),
              availability:
                established.status === 'active' && binding.leaseId ? 'AVAILABLE' : 'OFFLINE',
            }
          : established;
        binding.session = session;
        binding.tokenExpiresAt = identity.expiresAt;
        this.authenticatedSessions.set(socket, binding);
        if (this.authSequences.get(socket) === authSequence && authSequence.origin === captured)
          authSequence.origin = binding;
        socket.send(
          JSON.stringify({
            type: 'workspace.session',
            session,
            ...(binding.leaseId ? { leaseId: binding.leaseId } : {}),
          }),
        );
        if (customerAuthState)
          socket.send(JSON.stringify({ type: 'customer.auth', state: customerAuthState }));
        return true;
      });
      if (!committed) return;
      this.diagnostics.write({
        event: 'workspace.session.authenticated',
        correlationId,
        tenantId: session.tenantId,
        userId: session.userId,
      });
    } catch (error) {
      if (!isCurrent()) return;
      // do not report invalidation/revoke before the durable CAS commit if persist fails
      // close the transport without claiming invalidation succeeded or the Voice lease was released
      let failureBinding: WorkspaceMutationAuthBinding | undefined;
      const invalidated = await this.withAuthSequence(authSequence, async () => {
        if (!isCurrent() || this.authSequences.get(socket) !== authSequence) return false;
        if (captured?.leaseId)
          failureBinding = expectedFor(
            captured.session.tenantId,
            captured.session.userId,
            captured.leaseId,
          );
        else if (!captured && authSequence.origin === undefined)
          failureBinding = authSequence.committed;
        if (!failureBinding || !this.mutationAuth) return true;
        try {
          return await this.mutationAuth.invalidateCaptured(
            failureBinding,
            'SESSION_VERIFICATION_FAILED',
          );
        } catch {
          if (isCurrent()) socket.close(4401, 'workspace authentication failed');
          return false;
        }
      });
      if (!invalidated) return;
      if (!isCurrent()) return;
      if (error instanceof WorkspaceAuthorizationError) {
        if (captured?.leaseId && this.leases)
          await this.leases.revokeForAuth(
            captured.session,
            captured.leaseId,
            correlationId,
            failureBinding,
          );
        if (!isCurrent()) return;
        this.authenticatedSessions.delete(socket);
        this.diagnostics.write({
          event: 'workspace.session.denied',
          correlationId,
          reason: 'forbidden',
        });
        socket.close(4403, 'workspace authorization failed');
        return;
      }
      const current = this.authenticatedSessions.get(socket);
      if (message.type === 'auth:refresh' && current) {
        await this.withTenant(current.session.tenantId, async () => {
          if (!isCurrent()) return;
          const session = this.gateway.requireReauthentication(current.session);
          const leaseId = current.leaseId;
          if (leaseId && this.leases) {
            await this.leases.revokeForAuth(
              current.session,
              leaseId,
              correlationId,
              failureBinding,
            );
          }
          if (!isCurrent()) return;
          // Persist before reporting, keeping the Voice connection/policy for a call still in progress
          this.authenticatedSessions.set(socket, { ...current, session, leaseId: undefined });
          socket.send(JSON.stringify({ type: 'workspace.session', session }));
          if (leaseId && this.leases) {
            socket.send(JSON.stringify({ type: 'lease.revoked', leaseId, reason: 'auth_revoked' }));
          }
        });
        return;
      }
      this.diagnostics.write({
        event: 'workspace.session.denied',
        correlationId,
        reason: 'unauthenticated',
      });
      socket.close(4401, 'workspace authentication failed');
    } finally {
      if (pendingLease && this.pendingLeases.get(socket) === pendingLease)
        this.pendingLeases.delete(socket);
    }
  }

  /**
   * tenant that enforces the lease: an agent must attach a still-active lease (heartbeat succeeded) otherwise close 4409
   * the lease decides whether work can be taken, replacing the tab's leader election
   */
  private async bindLease(
    session: WorkspaceSession,
    leaseId: string | undefined,
    correlationId: string,
  ): Promise<SocketBinding | null> {
    // #583: when the API configures a lease, every tenant enforces the lease (no flag anymore)
    const enforced = Boolean(this.leases) && (await this.leases!.enforced(session.tenantId));
    if (!enforced) return { session, enforced: false };
    if (!session.agent) {
      // supervisor/admin who is not an agent: can view live data but has no way to take routing work
      return {
        session: { ...session, routingEnabled: false, availability: 'OFFLINE' },
        enforced: true,
      };
    }
    const result =
      leaseId && UUID.test(leaseId)
        ? await this.leases!.heartbeat(session, leaseId, correlationId)
        : null;
    if (result?.status !== 'ACTIVE') return null;
    return {
      session: { ...session, routingEnabled: true, availability: 'AVAILABLE' },
      leaseId,
      enforced: true,
    };
  }

  private async heartbeat(
    socket: WorkspaceSessionSocket,
    message: WorkspaceSessionSocketMessage,
    correlationId: string,
  ) {
    const binding = this.authenticatedSessions.get(socket);
    if (!binding || !this.leases || !binding.leaseId || binding.leaseId !== message.leaseId) {
      socket.close(4400, 'invalid workspace message');
      return;
    }
    const leaseId = binding.leaseId;
    const result = await this.leases.heartbeat(binding.session, leaseId, correlationId);
    await this.withTenant(binding.session.tenantId, () => {
      if (this.authenticatedSessions.get(socket) !== binding) return;
      if (binding.leaseRevoked) return;
      if (result.status === 'ACTIVE') {
        socket.send(
          JSON.stringify({
            type: 'lease.active',
            leaseId,
            expiresAt: result.expiresAt.toISOString(),
          }),
        );
        return;
      }
      this.unbind(socket, binding);
      socket.send(
        JSON.stringify(
          result.status === 'EXPIRED'
            ? { type: 'lease.expired', leaseId }
            : {
                type: 'lease.revoked',
                leaseId,
                reason: result.reason === 'released' ? 'released' : result.reason,
              },
        ),
      );
    });
  }

  /** signal from the lease service (takeover/expiry/revocation) → the socket holding that lease in this instance */
  async signalLease(
    tenantId: string,
    userId: string,
    signal: WorkSessionLeaseSignal,
  ): Promise<number> {
    for (const pending of this.pendingLeases.values()) {
      if (
        pending.tenantId === tenantId &&
        pending.userId === userId &&
        pending.leaseId === signal.leaseId
      )
        pending.revoked = true;
    }
    const recipients: Array<[WorkspaceSessionSocket, SocketBinding]> = [];
    for (const [socket, binding] of this.authenticatedSessions) {
      if (
        binding.session.tenantId !== tenantId ||
        binding.session.userId !== userId ||
        binding.leaseId !== signal.leaseId
      ) {
        continue;
      }
      // stop routing on every socket holding this lease before awaiting any tenant scope
      binding.leaseRevoked = true;
      recipients.push([socket, binding]);
    }
    let delivered = 0;
    for (const [socket, binding] of recipients) {
      const sent = await this.withTenant(tenantId, () => {
        if (this.authenticatedSessions.get(socket) !== binding) return false;
        this.unbind(socket, binding);
        socket.send(JSON.stringify(signal));
        return true;
      });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  /**
   * E1.11: a host origin was disabled/deleted → every socket of the tenant (the iframe locked to that origin stops accepting postMessage itself)
   * no data other than the origin that the tenant set itself
   */
  async notifyEmbedOriginRevoked(tenantId: string, origin: string): Promise<number> {
    let delivered = 0;
    for (const [socket, binding] of this.authenticatedSessions) {
      const { session } = binding;
      if (session.tenantId !== tenantId) continue;
      const sent = await this.withTenant(tenantId, () => {
        if (this.authenticatedSessions.get(socket) !== binding) return false;
        socket.send(JSON.stringify({ type: 'embed.origin.revoked', origin }));
        return true;
      });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  async deliverRoutingEvent(event: WorkspaceRoutingEvent): Promise<number> {
    let delivered = 0;
    for (const [socket, binding] of this.authenticatedSessions) {
      const { session } = binding;
      if (session.tenantId !== event.tenantId || session.userId !== event.userId) continue;
      if (binding.enforced) {
        // the server-side lease is the enforcer: the socket must hold a lease that is still current at send time
        if (
          !binding.leaseId ||
          binding.leaseRevoked ||
          !this.leases ||
          session.status !== 'active' ||
          !session.routingEnabled ||
          !binding.tokenExpiresAt ||
          !this.gateway.isTokenCurrent(binding.tokenExpiresAt)
        )
          continue;
        if (!(await this.leases.isCurrent(session, binding.leaseId))) continue;
        if (
          this.authenticatedSessions.get(socket) !== binding ||
          binding.leaseRevoked ||
          !this.gateway.isTokenCurrent(binding.tokenExpiresAt)
        )
          continue;
      } else if (!this.gateway.canReceiveRoutingWork(session)) {
        continue;
      }
      const sent = await this.withTenant(session.tenantId, () => {
        if (this.authenticatedSessions.get(socket) !== binding) return false;
        if (binding.leaseRevoked) return false;
        if (
          binding.enforced &&
          (!binding.tokenExpiresAt || !this.gateway.isTokenCurrent(binding.tokenExpiresAt))
        )
          return false;
        if (!binding.enforced && !this.gateway.canReceiveRoutingWork(session)) return false;
        socket.send(JSON.stringify(event));
        return true;
      });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  async deliverLiveEvent(
    event: WorkspaceLiveEvent | WorkspaceWebchatEvent,
    recipientUserIds: readonly string[],
  ): Promise<number> {
    const recipients = new Set(recipientUserIds);
    let delivered = 0;
    for (const [socket, binding] of this.authenticatedSessions) {
      const { session } = binding;
      if (session.tenantId !== event.tenantId || !recipients.has(session.userId)) continue;
      const sent = await this.withTenant(session.tenantId, () => {
        if (this.authenticatedSessions.get(socket) !== binding) return false;
        socket.send(JSON.stringify(event));
        return true;
      });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  disconnect(socket: WorkspaceSessionSocket): void {
    this.authenticatedSessions.delete(socket);
    this.handshakeGenerations.delete(socket);
    this.authSequences.delete(socket);
    this.pendingLeases.delete(socket);
  }

  private async withAuthSequence<T>(
    sequence: SocketAuthSequence,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = sequence.tail;
    let release!: () => void;
    sequence.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private unbind(socket: WorkspaceSessionSocket, binding: SocketBinding) {
    this.authenticatedSessions.set(socket, {
      ...binding,
      leaseId: undefined,
      session: { ...binding.session, routingEnabled: false, availability: 'OFFLINE' },
    });
  }
}
