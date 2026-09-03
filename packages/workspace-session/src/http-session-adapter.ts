import {
  type WorkspaceSession,
  type WorkspaceSessionGateway,
  type WorkspaceSessionHandshake,
} from './workspace-session.js';

export interface WorkspaceSessionHttpRequest {
  authorization?: string;
  tabId?: string;
}

export type WorkspaceSessionHttpResponse =
  | { status: 200; body: WorkspaceSession }
  | { status: 401; body: { code: 'UNAUTHENTICATED' } }
  | { status: 400; body: { code: 'INVALID_WORKSPACE_SESSION' } };

/**
 * Shared REST/WS handshake adapter. It deliberately accepts no tenantId or
 * userId from the client: both come only from the verified access token.
 */
export class WorkspaceSessionHttpAdapter {
  constructor(private readonly gateway: WorkspaceSessionGateway) {}

  async connect(request: WorkspaceSessionHttpRequest): Promise<WorkspaceSessionHttpResponse> {
    const handshake = this.toHandshake(request);
    if (!handshake) return { status: 401, body: { code: 'UNAUTHENTICATED' } };

    try {
      return { status: 200, body: await this.gateway.connect(handshake) };
    } catch {
      return { status: 400, body: { code: 'INVALID_WORKSPACE_SESSION' } };
    }
  }

  private toHandshake(request: WorkspaceSessionHttpRequest): WorkspaceSessionHandshake | undefined {
    if (!request.authorization?.startsWith('Bearer ') || !request.tabId) return undefined;
    const accessToken = request.authorization.slice('Bearer '.length).trim();
    return accessToken ? { accessToken, tabId: request.tabId } : undefined;
  }
}
