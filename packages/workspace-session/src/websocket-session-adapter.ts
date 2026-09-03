import type { WorkspaceSessionGateway } from './workspace-session.js';

export interface WorkspaceSessionSocket {
  send(message: string): void;
  close(code: number, reason: string): void;
}

export interface WorkspaceSessionSocketMessage {
  type: 'auth:connect' | 'auth:refresh';
  accessToken?: string;
  tabId?: string;
}

/** Shared WebSocket handshake adapter; tokens never travel in a query string. */
export class WorkspaceSessionWebSocketAdapter {
  constructor(private readonly gateway: WorkspaceSessionGateway) {}

  async handle(socket: WorkspaceSessionSocket, message: WorkspaceSessionSocketMessage): Promise<void> {
    if (!message.accessToken || !message.tabId) {
      socket.close(4401, 'workspace authentication required');
      return;
    }
    try {
      const session =
        message.type === 'auth:connect'
          ? await this.gateway.connect({ accessToken: message.accessToken, tabId: message.tabId })
          : await this.gateway.refresh({ accessToken: message.accessToken, tabId: message.tabId });
      socket.send(JSON.stringify({ type: 'workspace.session', session }));
    } catch {
      socket.close(4401, 'workspace authentication failed');
    }
  }
}
