import type { WorkspaceSession, WorkspaceSessionGateway } from './workspace-session.js';

export interface WorkspaceSessionSocket {
  send(message: string): void;
  close(code: number, reason: string): void;
}

export interface WorkspaceSessionSocketMessage {
  type: 'auth:connect' | 'auth:refresh';
  accessToken?: string;
  tabId?: string;
}

export interface WorkspaceRoutingEvent {
  type: 'routing.offered';
  interactionId: string;
  tenantId: string;
  userId: string;
}

/** Shared WebSocket handshake adapter; tokens never travel in a query string. */
export class WorkspaceSessionWebSocketAdapter {
  private readonly authenticatedSessions = new Map<WorkspaceSessionSocket, WorkspaceSession>();

  constructor(private readonly gateway: WorkspaceSessionGateway) {}

  async handle(
    socket: WorkspaceSessionSocket,
    message: WorkspaceSessionSocketMessage,
  ): Promise<void> {
    if (!message.accessToken || !message.tabId) {
      socket.close(4401, 'workspace authentication required');
      return;
    }
    try {
      const session =
        message.type === 'auth:connect'
          ? await this.gateway.connect({ accessToken: message.accessToken, tabId: message.tabId })
          : await this.gateway.refresh({ accessToken: message.accessToken, tabId: message.tabId });
      this.authenticatedSessions.set(socket, session);
      socket.send(JSON.stringify({ type: 'workspace.session', session }));
    } catch {
      const current = this.authenticatedSessions.get(socket);
      if (message.type === 'auth:refresh' && current) {
        const session = this.gateway.requireReauthentication(current);
        this.authenticatedSessions.set(socket, session);
        socket.send(JSON.stringify({ type: 'workspace.session', session }));
        return;
      }
      socket.close(4401, 'workspace authentication failed');
    }
  }

  deliverRoutingEvent(event: WorkspaceRoutingEvent): number {
    let delivered = 0;
    for (const [socket, session] of this.authenticatedSessions) {
      if (
        session.tenantId !== event.tenantId ||
        session.userId !== event.userId ||
        !this.gateway.canReceiveRoutingWork(session)
      ) {
        continue;
      }
      socket.send(JSON.stringify(event));
      delivered += 1;
    }
    return delivered;
  }

  disconnect(socket: WorkspaceSessionSocket): void {
    this.authenticatedSessions.delete(socket);
  }
}
