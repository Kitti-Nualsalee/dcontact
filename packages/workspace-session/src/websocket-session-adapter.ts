import {
  WorkspaceAuthorizationError,
  type WorkspaceSession,
  type WorkspaceSessionGateway,
} from './workspace-session.js';

export interface WorkspaceSessionSocket {
  send(message: string): void;
  close(code: number, reason: string): void;
}

export interface WorkspaceSessionSocketMessage {
  type: 'auth:connect' | 'auth:refresh' | 'auth:claim' | 'lease:heartbeat';
  accessToken?: string;
  tabId?: string;
  /** E1.9: work-session lease ที่ได้จาก `POST /api/v1/me/work-session` */
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
  | { type: 'lease.revoked'; leaseId: string; reason: 'takeover' | 'auth_revoked' }
  | { type: 'lease.expired'; leaseId: string };

type Actor = { tenantId: string; userId: string };

/**
 * E1.9 (#483): authority ของ work-session lease ฝั่ง server (ADR-026 ข้อ 2) — adapter ไม่ตัดสินเอง
 * เมื่อ tenant เปิด `workSession.lease.enforced` identity ที่เป็น agent ต้องแนบ lease ที่ยัง active
 */
export interface WorkSessionLeaseAuthority {
  enforced(tenantId: string): Promise<boolean>;
  heartbeat(
    actor: Actor,
    leaseId: string,
    correlationId?: string,
  ): Promise<
    | { status: 'ACTIVE'; expiresAt: Date }
    | { status: 'REVOKED'; reason: 'takeover' | 'auth_revoked' | 'released' }
    | { status: 'EXPIRED' }
  >;
  isCurrent(actor: Actor, leaseId: string): Promise<boolean>;
  revokeForAuth(actor: Actor, leaseId: string, correlationId: string): Promise<boolean>;
}

interface SocketBinding {
  session: WorkspaceSession;
  /** lease ที่ socket นี้ถือ (มีเฉพาะ tenant ที่บังคับ lease) */
  leaseId?: string;
  enforced: boolean;
}

const silentDiagnostics: WorkspaceSessionDiagnosticSink = { write: () => undefined };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared WebSocket handshake adapter; tokens never travel in a query string. */
export class WorkspaceSessionWebSocketAdapter {
  private readonly authenticatedSessions = new Map<WorkspaceSessionSocket, SocketBinding>();

  constructor(
    private readonly gateway: WorkspaceSessionGateway,
    private readonly withTenant: WorkspaceTenantScope = async (_tenantId, work) => work(),
    private readonly diagnostics: WorkspaceSessionDiagnosticSink = silentDiagnostics,
    private readonly leases?: WorkSessionLeaseAuthority,
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
    if (!message.accessToken || !message.tabId) {
      this.diagnostics.write({
        event: 'workspace.session.denied',
        correlationId,
        reason: 'unauthenticated',
      });
      socket.close(4401, 'workspace authentication required');
      return;
    }
    try {
      const handshake = { accessToken: message.accessToken, tabId: message.tabId };
      let session =
        message.type === 'auth:connect'
          ? await this.gateway.connect(handshake)
          : message.type === 'auth:claim'
            ? await this.gateway.claimWorkingTab(handshake)
            : await this.gateway.refresh(handshake);
      const binding = await this.bindLease(socket, session, message.leaseId, correlationId);
      if (!binding) return;
      session = binding.session;
      await this.withTenant(session.tenantId, () => {
        this.authenticatedSessions.set(socket, binding);
        socket.send(
          JSON.stringify({
            type: 'workspace.session',
            session,
            ...(binding.leaseId ? { leaseId: binding.leaseId } : {}),
          }),
        );
      });
      this.diagnostics.write({
        event: 'workspace.session.authenticated',
        correlationId,
        tenantId: session.tenantId,
        userId: session.userId,
      });
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError) {
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
          const session = this.gateway.requireReauthentication(current.session);
          const leaseId = current.leaseId;
          // token ถูกเพิกถอน: หยุดรับงานใหม่ทันที แต่ไม่ปิด socket (สายที่คุยอยู่ต้องไม่หลุด)
          this.authenticatedSessions.set(socket, { ...current, session, leaseId: undefined });
          socket.send(JSON.stringify({ type: 'workspace.session', session }));
          if (leaseId && this.leases) {
            socket.send(JSON.stringify({ type: 'lease.revoked', leaseId, reason: 'auth_revoked' }));
            await this.leases.revokeForAuth(current.session, leaseId, correlationId);
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
    }
  }

  /**
   * tenant ที่บังคับ lease: agent ต้องแนบ lease ที่ยัง active (heartbeat สำเร็จ) ไม่อย่างนั้นปิด 4409
   * lease เป็นตัวตัดสินว่ารับงานได้ แทน leader election ของแท็บ
   */
  private async bindLease(
    socket: WorkspaceSessionSocket,
    session: WorkspaceSession,
    leaseId: string | undefined,
    correlationId: string,
  ): Promise<SocketBinding | null> {
    const enforced = Boolean(this.leases) && (await this.leases!.enforced(session.tenantId));
    if (!enforced) return { session, enforced: false };
    if (!session.agent) {
      // supervisor/admin ที่ไม่ใช่ agent: ดูข้อมูลสดได้ แต่ไม่มีทางรับงาน routing
      return {
        session: { ...session, routingEnabled: false, availability: 'OFFLINE' },
        enforced: true,
      };
    }
    const result =
      leaseId && UUID.test(leaseId)
        ? await this.leases!.heartbeat(session, leaseId, correlationId)
        : null;
    if (result?.status !== 'ACTIVE') {
      this.authenticatedSessions.delete(socket);
      this.diagnostics.write({
        event: 'workspace.session.denied',
        correlationId,
        reason: 'lease_required',
        tenantId: session.tenantId,
        userId: session.userId,
      });
      socket.close(4409, 'work session lease required');
      return null;
    }
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

  /** สัญญาณจาก lease service (takeover/หมดอายุ/เพิกถอน) → socket ที่ถือ lease นั้นใน instance นี้ */
  async signalLease(
    tenantId: string,
    userId: string,
    signal: WorkSessionLeaseSignal,
  ): Promise<number> {
    let delivered = 0;
    for (const [socket, binding] of this.authenticatedSessions) {
      if (
        binding.session.tenantId !== tenantId ||
        binding.session.userId !== userId ||
        binding.leaseId !== signal.leaseId
      ) {
        continue;
      }
      await this.withTenant(tenantId, () => {
        this.unbind(socket, binding);
        socket.send(JSON.stringify(signal));
      });
      delivered += 1;
    }
    return delivered;
  }

  async deliverRoutingEvent(event: WorkspaceRoutingEvent): Promise<number> {
    let delivered = 0;
    for (const [socket, binding] of this.authenticatedSessions) {
      const { session } = binding;
      if (session.tenantId !== event.tenantId || session.userId !== event.userId) continue;
      if (binding.enforced) {
        // lease ฝั่ง server เป็นตัวบังคับ: socket ต้องถือ lease ที่ยังเป็นปัจจุบัน ณ ตอนส่ง
        if (!binding.leaseId || !this.leases) continue;
        if (!(await this.leases.isCurrent(session, binding.leaseId))) continue;
      } else if (!this.gateway.canReceiveRoutingWork(session)) {
        continue;
      }
      await this.withTenant(session.tenantId, () => socket.send(JSON.stringify(event)));
      delivered += 1;
    }
    return delivered;
  }

  async deliverLiveEvent(
    event: WorkspaceLiveEvent,
    recipientUserIds: readonly string[],
  ): Promise<number> {
    const recipients = new Set(recipientUserIds);
    let delivered = 0;
    for (const [socket, { session }] of this.authenticatedSessions) {
      if (session.tenantId !== event.tenantId || !recipients.has(session.userId)) continue;
      await this.withTenant(session.tenantId, () => socket.send(JSON.stringify(event)));
      delivered += 1;
    }
    return delivered;
  }

  disconnect(socket: WorkspaceSessionSocket): void {
    this.authenticatedSessions.delete(socket);
  }

  private unbind(socket: WorkspaceSessionSocket, binding: SocketBinding) {
    this.authenticatedSessions.set(socket, {
      ...binding,
      leaseId: undefined,
      session: { ...binding.session, routingEnabled: false, availability: 'OFFLINE' },
    });
  }
}
