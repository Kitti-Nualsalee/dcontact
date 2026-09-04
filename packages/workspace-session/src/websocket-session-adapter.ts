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
  type: 'auth:connect' | 'auth:refresh' | 'auth:claim';
  accessToken?: string;
  tabId?: string;
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
  reason?: 'unauthenticated' | 'forbidden';
  tenantId?: string;
  userId?: string;
}

export interface WorkspaceSessionDiagnosticSink {
  write(diagnostic: WorkspaceSessionDiagnostic): void;
}

const silentDiagnostics: WorkspaceSessionDiagnosticSink = { write: () => undefined };

/** Shared WebSocket handshake adapter; tokens never travel in a query string. */
export class WorkspaceSessionWebSocketAdapter {
  private readonly authenticatedSessions = new Map<WorkspaceSessionSocket, WorkspaceSession>();

  constructor(
    private readonly gateway: WorkspaceSessionGateway,
    private readonly withTenant: WorkspaceTenantScope = async (_tenantId, work) => work(),
    private readonly diagnostics: WorkspaceSessionDiagnosticSink = silentDiagnostics,
  ) {}

  async handle(
    socket: WorkspaceSessionSocket,
    message: WorkspaceSessionSocketMessage,
    correlationId = 'unavailable',
  ): Promise<void> {
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
      const session =
        message.type === 'auth:connect'
          ? await this.gateway.connect(handshake)
          : message.type === 'auth:claim'
            ? await this.gateway.claimWorkingTab(handshake)
            : await this.gateway.refresh(handshake);
      await this.withTenant(session.tenantId, () => {
        this.authenticatedSessions.set(socket, session);
        socket.send(JSON.stringify({ type: 'workspace.session', session }));
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
        await this.withTenant(current.tenantId, () => {
          const session = this.gateway.requireReauthentication(current);
          this.authenticatedSessions.set(socket, session);
          socket.send(JSON.stringify({ type: 'workspace.session', session }));
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

  async deliverRoutingEvent(event: WorkspaceRoutingEvent): Promise<number> {
    let delivered = 0;
    for (const [socket, session] of this.authenticatedSessions) {
      if (
        session.tenantId !== event.tenantId ||
        session.userId !== event.userId ||
        !this.gateway.canReceiveRoutingWork(session)
      ) {
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
    for (const [socket, session] of this.authenticatedSessions) {
      if (session.tenantId !== event.tenantId || !recipients.has(session.userId)) continue;
      await this.withTenant(session.tenantId, () => socket.send(JSON.stringify(event)));
      delivered += 1;
    }
    return delivered;
  }

  disconnect(socket: WorkspaceSessionSocket): void {
    this.authenticatedSessions.delete(socket);
  }
}
